import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Clapperboard, ExternalLink, Film, Images, LifeBuoy, Monitor, RotateCcw, Upload, X,
} from 'lucide-react'
import { formatTime, pipGeometry, type PipSize, type Take } from '../lib/recorder'
import { canvasFor } from '../lib/finish'
import type { Project } from '../lib/projects'
import {
  defaultCropFractions, evenSplit, loadRescueSettings, saveRescueSettings,
  type CropFractions, type FacecamMode, type RescueSettings,
} from '../lib/rescue'
import {
  renderRescueComposite, RenderCancelled,
  type RescueBase, type RescueOverlay,
} from '../lib/renderTimeline'

interface Props {
  project: Project
  takes: Take[]
  /** Set when Abel taps "Rescue" on a take card in the library. */
  focusTakeId: string | null
  /** Imports one video file as a take in this project; resolves to the new take id. */
  onImportVideo: (file: File) => Promise<string | null>
  /** Saves the rendered rescue as a new take (originals are never modified). */
  onExported: (blob: Blob, durationSec: number) => void
  /** Jumps to the top with Screen-only preselected, to record a clean capture. */
  onRecordScreenOnly: () => void
}

interface Slide {
  id: string
  url: string
  name: string
  durationSec: number
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export default function Rescue({ project, takes, focusTakeId, onImportVideo, onExported, onRecordScreenOnly }: Props) {
  const [brokenId, setBrokenId] = useState('')
  const [settings, setSettingsState] = useState<RescueSettings>(() => loadRescueSettings(''))
  const [probe, setProbe] = useState<{ w: number; h: number } | null>(null)
  const [slides, setSlides] = useState<Slide[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [note, setNote] = useState('')
  const cancelRef = useRef(false)
  const videoFileRef = useRef<HTMLInputElement>(null)
  const imageFileRef = useRef<HTMLInputElement>(null)
  const slideUrlsRef = useRef<string[]>([])

  // A "Rescue" tap on a library card points the panel at that take.
  useEffect(() => { if (focusTakeId) setBrokenId(focusTakeId) }, [focusTakeId])

  // Settings are per broken take (sliders tuned for one take shouldn't
  // leak onto the next).
  useEffect(() => {
    setSettingsState(loadRescueSettings(brokenId))
    setProbe(null)
  }, [brokenId])

  // Revoke slideshow object URLs when the panel unmounts.
  useEffect(() => () => { slideUrlsRef.current.forEach((u) => URL.revokeObjectURL(u)) }, [])

  const update = (patch: Partial<RescueSettings>) =>
    setSettingsState((prev) => {
      const next = { ...prev, ...patch }
      saveRescueSettings(brokenId, next)
      return next
    })

  const broken = useMemo(() => takes.find((t) => t.id === brokenId) ?? null, [takes, brokenId])
  const repl = useMemo(() => takes.find((t) => t.id === settings.replTakeId) ?? null, [takes, settings.replTakeId])
  const D = broken?.duration ?? 0

  /* Facecam box: the user's tuned crop, else the compositor default for
     the broken take's real frame size, else a 720p medium-with-tag guess
     for the moment before the preview has probed the file. */
  const autoCrop = useMemo(
    () => (probe ? defaultCropFractions(probe.w, probe.h, settings.pipSize, settings.hasNameTag) : null),
    [probe, settings.pipSize, settings.hasNameTag],
  )
  const crop: CropFractions = settings.crop ?? autoCrop ?? { x: 0.762, y: 0.104, w: 0.22, h: 0.294 }
  const tagRect = useMemo(() => {
    if (!probe || !settings.hasNameTag) return null
    const { tag } = pipGeometry(probe.w, probe.h, settings.pipSize, true)
    return tag ? { x: tag.x / probe.w, y: tag.y / probe.h, w: tag.w / probe.w, h: tag.h / probe.h } : null
  }, [probe, settings.pipSize, settings.hasNameTag])

  const setCropPart = (key: keyof CropFractions, pct: number) =>
    update({ crop: { ...crop, [key]: clamp01(pct / 100) } })

  /* Coverage readouts: does the replacement picture last as long as the
     narration it has to sit under? */
  const videoCoverEnd = useMemo(() => {
    if (!repl) return null
    const delay = Math.max(0, -settings.offsetSec)
    return delay + Math.max(0, repl.duration - Math.max(0, settings.offsetSec))
  }, [repl, settings.offsetSec])
  const slidesTotal = useMemo(() => slides.reduce((a, s) => a + s.durationSec, 0), [slides])

  const projectUrl = useMemo(
    () => project.openFirst.match(/https?:\/\/[^\s,]+/)?.[0] ?? null,
    [project.openFirst],
  )

  const addSlideFiles = (files: FileList | null) => {
    if (!files?.length) return
    const added: Slide[] = Array.from(files).map((f) => {
      const url = URL.createObjectURL(f)
      slideUrlsRef.current.push(url)
      return { id: crypto.randomUUID(), url, name: f.name, durationSec: 0 }
    })
    setSlides((prev) => {
      const next = [...prev, ...added]
      // Fresh stills start as an even split of the narration; Abel can
      // re-time individual stills afterwards.
      const each = evenSplit(D, next.length) || 5
      return next.map((s) => ({ ...s, durationSec: s.durationSec > 0 ? s.durationSec : each }))
    })
  }

  const removeSlide = (id: string) =>
    setSlides((prev) => {
      const gone = prev.find((s) => s.id === id)
      if (gone) {
        URL.revokeObjectURL(gone.url)
        slideUrlsRef.current = slideUrlsRef.current.filter((u) => u !== gone.url)
      }
      return prev.filter((s) => s.id !== id)
    })

  const splitEvenly = () => {
    if (!slides.length) return
    const each = evenSplit(D, slides.length) || 5
    setSlides((prev) => prev.map((s) => ({ ...s, durationSec: each })))
  }

  async function doRender() {
    if (!broken || busy) return
    let base: RescueBase
    if (settings.visualKind === 'video') {
      if (!repl) {
        setNote('Pick a replacement video first — a clean screen-only take from this project, or import one below.')
        return
      }
      base = { kind: 'video', url: repl.url, label: repl.name, offsetSec: settings.offsetSec }
    } else {
      if (!slides.length) {
        setNote('Add at least one still image for the simulated walkthrough.')
        return
      }
      base = {
        kind: 'slideshow',
        images: slides.map((s) => ({ url: s.url, durationSec: s.durationSec })),
        kenBurns: settings.kenBurns,
      }
    }
    const overlay: RescueOverlay = settings.faceMode === 'none'
      ? { kind: 'none' }
      : { kind: settings.faceMode, rect: crop }
    cancelRef.current = false
    setBusy(true)
    setNote('')
    setProgress('')
    try {
      const { width, height } = canvasFor(settings.quality)
      const out = await renderRescueComposite({
        masterUrl: broken.url,
        masterLabel: broken.name,
        durationSec: broken.duration,
        base,
        overlay,
        width,
        height,
        fades: settings.fades,
        onProgress: setProgress,
        isCancelled: () => cancelRef.current,
      })
      onExported(out.blob, out.durationSec)
      setNote('Rescued take rendered — it\'s in your takes above, ready to download. The original take is untouched.')
    } catch (e) {
      if (e instanceof RenderCancelled) setNote('Render cancelled — nothing was saved.')
      else setNote(`Rescue hit a problem: ${e instanceof Error ? e.message : 'unknown error'}. Your original take is untouched.`)
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const sliderRow = (label: string, keyName: keyof CropFractions) => (
    <label className="flex items-center gap-3 text-xs text-slate-300">
      <span className="w-16 shrink-0">{label}</span>
      <input
        type="range" min={0} max={100} step={0.5}
        value={Math.round(crop[keyName] * 1000) / 10}
        onChange={(e) => setCropPart(keyName, Number(e.target.value))}
        className="flex-1 accent-teal-500"
      />
      <span className="w-12 shrink-0 text-right font-mono text-slate-400">{(crop[keyName] * 100).toFixed(1)}%</span>
    </label>
  )

  return (
    <div className="mt-6 rounded-2xl border border-line bg-panel p-4">
      <h2 className="flex items-center gap-2 font-semibold"><LifeBuoy size={17} className="text-teal-bright" /> Take Rescue — rebuild a take whose screen didn't record</h2>
      <p className="mt-1 text-sm leading-relaxed text-slate-400">
        Some older takes kept your voice and your facecam but no screen at all. That picture was never captured, so it
        can't be pulled back out of the file — Rescue rebuilds the picture track instead: a clean capture or a stills
        walkthrough underneath, your original narration as the soundtrack, and your face lifted from the corner of the
        old take back into the corner of the new one. The original take is never modified.
      </p>

      {/* 1 · The broken take */}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-line bg-panel2 p-3">
          <div className="text-xs font-semibold text-slate-300">1 · The broken take</div>
          <select value={brokenId} onChange={(e) => setBrokenId(e.target.value)}
            className="mt-2 w-full rounded-lg border border-line bg-panel px-2 py-2 text-xs outline-none focus:border-teal">
            <option value="">Pick a take…</option>
            {takes.map((t) => <option key={t.id} value={t.id}>{t.name} ({formatTime(t.duration)})</option>)}
          </select>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            Pick the take that has your narration and face but no screen. Its audio becomes the master track of the
            rescued video in every mode.
          </p>

          {/* 2 · Get the missing picture */}
          <div className="mt-3 rounded-xl border border-teal/30 bg-teal/5 p-3">
            <div className="text-xs font-semibold text-slate-200">2 · Get the missing picture</div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
              DemoCut can't replay or fake the live app itself — but you can put a real capture, or a stills
              walkthrough, under the narration you already recorded. For {project.name}: {project.openFirst}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {projectUrl && (
                <a href={projectUrl} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-lg border border-teal px-3 py-1.5 text-[11px] font-semibold text-teal-bright hover:bg-teal/10">
                  <ExternalLink size={12} /> Open the app
                </a>
              )}
              <button onClick={onRecordScreenOnly}
                className="flex items-center gap-1.5 rounded-lg border border-teal px-3 py-1.5 text-[11px] font-semibold text-teal-bright hover:bg-teal/10">
                <Monitor size={12} /> Record a clean screen-only take
              </button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              "Record a clean screen-only take" jumps you to the top with <em>Screen only</em> preselected — record the
              app walkthrough (if a setup is already active up there, Disconnect first), then come back and pick that
              take as the replacement video. No live capture possible? Use the stills walkthrough in step 3 instead.
            </p>
          </div>
        </div>

        {/* Preview with the facecam box overlaid */}
        <div className="rounded-xl border border-line bg-panel2 p-3">
          <div className="text-xs font-semibold text-slate-300">Preview — where the facecam sits</div>
          {broken ? (
            <div className="relative mt-2 aspect-video overflow-hidden rounded-lg bg-black">
              <video
                key={broken.id}
                src={broken.url}
                controls
                className="h-full w-full"
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget
                  if (v.videoWidth > 0) setProbe({ w: v.videoWidth, h: v.videoHeight })
                }}
              />
              {settings.faceMode !== 'none' && (
                <div
                  className="pointer-events-none absolute rounded-md border-2 border-teal shadow-[0_0_0_999px_rgba(0,0,0,0.25)]"
                  style={{
                    left: `${crop.x * 100}%`, top: `${crop.y * 100}%`,
                    width: `${crop.w * 100}%`, height: `${crop.h * 100}%`,
                  }}
                >
                  <span className="absolute left-1 top-1 rounded bg-teal px-1 text-[9px] font-bold text-ink">FACECAM</span>
                </div>
              )}
              {settings.faceMode === 'crop' && tagRect && (
                <div
                  className="pointer-events-none absolute rounded-md border border-dashed border-amber-400/80"
                  style={{
                    left: `${tagRect.x * 100}%`, top: `${tagRect.y * 100}%`,
                    width: `${tagRect.w * 100}%`, height: `${tagRect.h * 100}%`,
                  }}
                >
                  <span className="absolute bottom-0 right-1 text-[9px] font-semibold text-amber-300">name tag — not cropped</span>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-slate-500">Pick a broken take and its preview appears here, with the facecam box drawn where DemoCut recorded it.</p>
          )}
          {probe && broken && (
            <p className="mt-2 text-[11px] text-slate-500">
              This take's frame is {probe.w}×{probe.h}. The box starts at DemoCut's own recorded geometry for the
              settings on the right — nudge it with the sliders if an older take sits differently.
            </p>
          )}
        </div>
      </div>

      {/* 3 · Replacement visuals */}
      <div className="mt-3 rounded-xl border border-line bg-panel2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-slate-300">3 · Replacement visuals — what fills the frame</div>
          <div className="grid grid-cols-2 gap-1.5">
            <button onClick={() => update({ visualKind: 'video' })}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs ${settings.visualKind === 'video' ? 'bg-teal font-semibold text-ink' : 'border border-line text-slate-300 hover:bg-panel'}`}>
              <Film size={13} /> Replacement video
            </button>
            <button onClick={() => update({ visualKind: 'slideshow' })}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs ${settings.visualKind === 'slideshow' ? 'bg-teal font-semibold text-ink' : 'border border-line text-slate-300 hover:bg-panel'}`}>
              <Images size={13} /> Stills walkthrough
            </button>
          </div>
        </div>

        {settings.visualKind === 'video' ? (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-2">
              <select value={settings.replTakeId ?? ''} onChange={(e) => update({ replTakeId: e.target.value || null })}
                className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-2 py-2 text-xs outline-none focus:border-teal">
                <option value="">Pick a take…</option>
                {takes.filter((t) => t.id !== brokenId).map((t) => <option key={t.id} value={t.id}>{t.name} ({formatTime(t.duration)})</option>)}
              </select>
              <button onClick={() => videoFileRef.current?.click()}
                className="flex items-center gap-2 rounded-lg border border-teal px-3 py-2 text-xs font-semibold text-teal-bright hover:bg-teal/10">
                <Upload size={13} /> Import a video…
              </button>
              <input ref={videoFileRef} type="file" accept="video/*,.mov,.mp4,.m4v,.webm" hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) void onImportVideo(f).then((id) => { if (id) update({ replTakeId: id, visualKind: 'video' }) })
                }} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2 text-xs text-slate-300">
                Start offset (seconds)
                <input type="number" step={0.1} value={settings.offsetSec}
                  onChange={(e) => update({ offsetSec: Number(e.target.value) || 0 })}
                  className="w-24 rounded-lg border border-line bg-panel px-2 py-1.5 text-xs outline-none focus:border-teal" />
              </label>
              <span className="text-[11px] text-slate-500">
                Positive: the replacement starts that far into its own timeline. Negative: it starts that late (black until then).
              </span>
            </div>
            {broken && repl && videoCoverEnd !== null && (
              <p className={`mt-2 text-[11px] leading-relaxed ${videoCoverEnd < D - 0.05 ? 'text-amber-200' : 'text-slate-500'}`}>
                {videoCoverEnd < D - 0.05
                  ? `Heads up: the replacement video runs out ${formatTime(D - videoCoverEnd)} before your narration ends — its last frame will hold for the rest.`
                  : `The replacement covers the full narration (${formatTime(D)}). Its own audio is not used — your original narration is the soundtrack.`}
              </p>
            )}
          </div>
        ) : (
          <div className="mt-3">
            <p className="text-[11px] leading-relaxed text-slate-400">
              <strong className="text-slate-200">Simulated walkthrough from stills.</strong> Add screenshots or photos of
              the app and they're shown one by one, in order, under your original narration — a walkthrough rebuilt
              from stills, not the live app. Each still is fit on black, never cropped. Stills live in this panel
              until you render; if you reload the page you'll add them again (the rendered rescue is saved as a take).
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button onClick={() => imageFileRef.current?.click()}
                className="flex items-center gap-2 rounded-lg border border-teal px-3 py-2 text-xs font-semibold text-teal-bright hover:bg-teal/10">
                <Upload size={13} /> Add stills…
              </button>
              <input ref={imageFileRef} type="file" accept="image/*" multiple hidden
                onChange={(e) => { addSlideFiles(e.target.files); e.target.value = '' }} />
              {slides.length > 0 && (
                <button onClick={splitEvenly} className="rounded-lg border border-line px-3 py-2 text-xs text-slate-300 hover:bg-panel">
                  Split the narration evenly
                </button>
              )}
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={settings.kenBurns} onChange={(e) => update({ kenBurns: e.target.checked })} className="h-4 w-4 accent-teal-500" />
                Gentle drift on each still (Ken Burns-style, nothing cropped)
              </label>
            </div>
            {slides.length > 0 && (
              <div className="mt-3 space-y-2">
                {slides.map((s, i) => (
                  <div key={s.id} className="flex items-center gap-3 rounded-lg border border-line bg-panel px-2 py-1.5">
                    <img src={s.url} alt="" className="h-9 w-16 shrink-0 rounded object-cover" />
                    <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">{i + 1}. {s.name}</span>
                    <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-slate-400">
                      <input type="number" step={0.5} min={0.5} value={s.durationSec}
                        onChange={(e) => setSlides((prev) => prev.map((x) => (x.id === s.id ? { ...x, durationSec: Math.max(0.1, Number(e.target.value) || 0.1) } : x)))}
                        className="w-20 rounded-lg border border-line bg-panel2 px-2 py-1 text-xs outline-none focus:border-teal" />
                      sec
                    </label>
                    <button onClick={() => removeSlide(s.id)} title="Remove still" className="shrink-0 rounded-lg border border-line p-1.5 text-slate-400 hover:text-red-300"><X size={13} /></button>
                  </div>
                ))}
                <p className={`text-[11px] leading-relaxed ${broken && slidesTotal < D - 0.05 ? 'text-amber-200' : 'text-slate-500'}`}>
                  Stills total {formatTime(slidesTotal)}{broken ? <> against {formatTime(D)} of narration</> : null}.
                  {broken && slidesTotal < D - 0.05 && <> They run out {formatTime(D - slidesTotal)} early — the last still will hold until the narration ends.</>}
                  {broken && slidesTotal > D + 0.05 && <> The narration ends first — the last still{slidesTotal - D > (slides[slides.length - 1]?.durationSec ?? 0) ? 's may not' : ' gets cut short and may not fully'} appear.</>}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 4 · Facecam */}
      <div className="mt-3 rounded-xl border border-line bg-panel2 p-3">
        <div className="text-xs font-semibold text-slate-300">4 · Your face — lifted from the old take</div>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {([['crop', 'Crop my facecam back in'], ['inset', 'Whole take as small inset'], ['none', 'No facecam']] as [FacecamMode, string][]).map(([m, label]) => (
            <button key={m} onClick={() => update({ faceMode: m })}
              className={`rounded-lg px-2 py-2 text-xs ${settings.faceMode === m ? 'bg-teal font-semibold text-ink' : 'border border-line text-slate-300 hover:bg-panel'}`}>{label}</button>
          ))}
        </div>
        {settings.faceMode === 'none' ? (
          <p className="mt-2 text-[11px] text-slate-500">Audio + visuals only — the rescued video carries your narration over the replacement picture, with no facecam.</p>
        ) : (
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                <span>Recorded with facecam size</span>
                {(['s', 'm', 'l'] as PipSize[]).map((s) => (
                  <button key={s} onClick={() => update({ pipSize: s, crop: null })}
                    className={`rounded-lg px-2.5 py-1.5 ${settings.pipSize === s ? 'bg-teal font-semibold text-ink' : 'border border-line hover:bg-panel'}`}>
                    {s === 's' ? 'Small' : s === 'm' ? 'Medium' : 'Large'}
                  </button>
                ))}
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={settings.hasNameTag}
                    onChange={(e) => update({ hasNameTag: e.target.checked, crop: null })} className="h-4 w-4 accent-teal-500" />
                  Name tag above it
                </label>
                {settings.crop && (
                  <button onClick={() => update({ crop: null })} className="flex items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-slate-300 hover:bg-panel">
                    <RotateCcw size={12} /> Reset to recorded default
                  </button>
                )}
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                {settings.faceMode === 'crop'
                  ? 'The box is where DemoCut drew your facecam when this take was recorded (size + name-tag allowance included). The crop lifts exactly that region — it\'s the small burned-in picture, so it can\'t come back sharper than it was recorded.'
                  : 'The whole old frame, shrunk into the corner box — use it when the facecam isn\'t where the default says, or the take predates the corner layout.'}
              </p>
            </div>
            <div className="space-y-2">
              {sliderRow('Left (x)', 'x')}
              {sliderRow('Top (y)', 'y')}
              {sliderRow('Width', 'w')}
              {sliderRow('Height', 'h')}
              <p className="text-[11px] text-slate-500">Percent of the frame. The preview above shows the box live.</p>
            </div>
          </div>
        )}
      </div>

      {/* Render */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-300">Output size</span>
          {(['720p', '1080p'] as const).map((q) => (
            <button key={q} onClick={() => update({ quality: q })} className={`rounded-lg px-3 py-1.5 text-xs ${settings.quality === q ? 'bg-teal font-semibold text-ink' : 'border border-line text-slate-300 hover:bg-panel2'}`}>{q}</button>
          ))}
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={settings.fades} onChange={(e) => update({ fades: e.target.checked })} className="h-4 w-4 accent-teal-500" />
            Fade in / out
          </label>
        </div>
        <button onClick={() => void doRender()} disabled={busy || !broken}
          className="flex items-center gap-2 rounded-xl bg-teal px-5 py-3 font-semibold text-ink hover:bg-teal-bright disabled:opacity-50">
          <Clapperboard size={17} /> {busy ? 'Rendering…' : 'Render rescued take'}
        </button>
        {busy && (
          <button onClick={() => { cancelRef.current = true }} className="flex items-center gap-2 rounded-xl border border-red-400/60 px-4 py-3 text-sm font-semibold text-red-200 hover:bg-red-500/10"><X size={15} /> Cancel</button>
        )}
        <span className="text-xs text-slate-400">
          {broken ? <>Renders in real time ({formatTime(D)}) with the broken take's narration as the soundtrack.</> : 'Pick a broken take to start.'}
        </span>
      </div>
      {progress && <p className="mt-2 text-xs text-teal-bright">{progress}</p>}
      {note && <p className="mt-2 text-xs text-amber-200">{note}</p>}
    </div>
  )
}
