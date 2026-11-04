import { useEffect, useMemo, useRef, useState } from 'react'
import { Clapperboard, Flag, ImageDown, Sparkles, Upload, X, Zap } from 'lucide-react'
import { formatTime, type Take } from '../lib/recorder'
import { BRAND_KITS } from '../lib/brandKits'
import {
  analyseVoiceLevel, canvasFor, detectEdgeTrim, kitFor, loadFinishSettings,
  resolveBody, resolveBookend, saveFinishSettings,
  type BookendSource, type EdgeTrim, type FinishClip, type FinishSettings, type VoiceLevel,
} from '../lib/finish'
import { renderTimeline, RenderCancelled, type TimelinePiece } from '../lib/renderTimeline'
import { checkConcat, fastConcat, type ConcatCheck, type ConcatPiece } from '../lib/fastConcat'

interface Props {
  projectId: string
  projectName: string
  takes: Take[]
  /** Imports one file as a take in this project; resolves to the new take id. */
  onImportBody: (file: File) => Promise<string | null>
  onExported: (blob: Blob, durationSec: number) => void
}

const SUBMISSION_LIMIT_SEC = 180

function fmtDb(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
}

export default function Finish({ projectId, projectName, takes, onImportBody, onExported }: Props) {
  const [settings, setSettings] = useState<FinishSettings>(() => loadFinishSettings(projectId))
  const [voice, setVoice] = useState<VoiceLevel | null>(null)
  const [voiceState, setVoiceState] = useState<'idle' | 'working' | 'none'>('idle')
  const [edge, setEdge] = useState<EdgeTrim | null>(null)
  const [busy, setBusy] = useState<'' | 'render' | 'concat' | 'poster'>('')
  const [progress, setProgress] = useState('')
  const [note, setNote] = useState('')
  const [concat, setConcat] = useState<ConcatCheck | null>(null)
  const cancelRef = useRef(false)
  const brandBlobs = useRef(new Map<string, Blob>())
  const fileRef = useRef<HTMLInputElement>(null)

  // Re-load when the project changes (settings are per project).
  useEffect(() => { setSettings(loadFinishSettings(projectId)) }, [projectId])

  const update = (patch: Partial<FinishSettings>) =>
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveFinishSettings(projectId, next)
      return next
    })

  const kit = kitFor(settings)
  const introClip = useMemo(
    () => resolveBookend(settings.introSource, settings.introTakeId, kit, 'intro', takes),
    [settings.introSource, settings.introTakeId, kit, takes],
  )
  const outroClip = useMemo(
    () => resolveBookend(settings.outroSource, settings.outroTakeId, kit, 'outro', takes),
    [settings.outroSource, settings.outroTakeId, kit, takes],
  )
  const bodyTake = useMemo(() => takes.find((t) => t.id === settings.bodyTakeId) ?? null, [takes, settings.bodyTakeId])
  const bodyClip = useMemo(() => resolveBody(settings, takes), [settings, takes])

  /* Voice analysis + edge detection run once per body clip. */
  useEffect(() => {
    setVoice(null); setVoiceState('idle'); setEdge(null)
    if (!bodyTake) return
    let live = true
    setVoiceState('working')
    void analyseVoiceLevel(bodyTake.blob)
      .then((v) => { if (live) { setVoice(v); setVoiceState(v ? 'idle' : 'none') } })
      .catch(() => { if (live) setVoiceState('none') })
    void detectEdgeTrim(bodyTake.blob, bodyTake.duration)
      .then((e) => { if (live) setEdge(e) })
      .catch(() => { if (live) setEdge({ head: 0, tail: 0 }) })
    return () => { live = false }
  }, [bodyTake])

  const trimOn = settings.trimDeadAir && !!edge && edge.head + edge.tail >= 0.3
  const bodyStart = trimOn ? edge!.head : 0
  const bodyEnd = bodyTake ? bodyTake.duration - (trimOn ? edge!.tail : 0) : 0
  const introDur = introClip?.duration ?? 0
  const bodyDur = bodyTake ? Math.max(0, bodyEnd - bodyStart) : 0
  const outroDur = outroClip?.duration ?? 0
  const total = introDur + bodyDur + outroDur
  const overBy = total - SUBMISSION_LIMIT_SEC

  const polishOn = settings.fades || settings.levelVoice || settings.trimDeadAir

  /* Fast-concat eligibility: only when NO polish pass is on. Blobs for
     brand cards are fetched lazily (they live as bundled asset URLs). */
  const [concatPieces, setConcatPieces] = useState<ConcatPiece[] | null>(null)
  useEffect(() => {
    setConcat(null); setConcatPieces(null)
    if (polishOn || !bodyClip?.blob) return
    const clips: FinishClip[] = [introClip, bodyClip, outroClip].filter(Boolean) as FinishClip[]
    if (clips.length < 2) return
    let live = true
    void (async () => {
      const pieces: ConcatPiece[] = []
      for (const c of clips) {
        let blob = c.blob
        if (!blob) {
          if (!brandBlobs.current.has(c.url)) {
            const res = await fetch(c.url)
            if (!res.ok) throw new Error(`Could not load ${c.label}`)
            brandBlobs.current.set(c.url, await res.blob())
          }
          blob = brandBlobs.current.get(c.url)!
        }
        pieces.push({ label: c.label, blob, duration: c.duration })
      }
      if (!live) return
      setConcatPieces(pieces)
      setConcat(await checkConcat(pieces))
    })().catch((e) => { if (live) setConcat({ ok: false, reason: e instanceof Error ? e.message : 'Could not load the clips.' }) })
    return () => { live = false }
  }, [polishOn, introClip, bodyClip, outroClip])

  const buildPieces = (): TimelinePiece[] | null => {
    if (!bodyClip || !bodyTake) return null
    const pieces: TimelinePiece[] = []
    if (introClip) pieces.push({ label: introClip.label, url: introClip.url, start: 0, end: introClip.duration })
    pieces.push({
      label: bodyClip.label, url: bodyClip.url, start: bodyStart, end: bodyEnd,
      gainDb: settings.levelVoice && voice ? voice.gainDb : 0,
    })
    if (outroClip) pieces.push({ label: outroClip.label, url: outroClip.url, start: 0, end: outroClip.duration })
    return pieces
  }

  async function doRender() {
    const pieces = buildPieces()
    if (!pieces || busy) return
    cancelRef.current = false
    setBusy('render'); setNote(''); setProgress('')
    try {
      const { width, height } = canvasFor(settings.quality)
      const out = await renderTimeline(pieces, {
        width, height, fades: settings.fades,
        onProgress: setProgress,
        isCancelled: () => cancelRef.current,
      })
      onExported(out.blob, out.durationSec)
      setNote('Finished video rendered — it\'s in your takes above, ready to download.')
    } catch (e) {
      if (e instanceof RenderCancelled) setNote('Render cancelled — nothing was saved.')
      else setNote(`Finish export hit a problem: ${e instanceof Error ? e.message : 'unknown error'}. Your original clips are untouched.`)
    } finally {
      setBusy(''); setProgress('')
    }
  }

  async function doConcat() {
    if (!concatPieces || busy) return
    cancelRef.current = false
    setBusy('concat'); setNote(''); setProgress('Joining clips…')
    try {
      const out = await fastConcat(concatPieces, (p) => setProgress(`Fast join: ${Math.round(p * 100)}%`), () => cancelRef.current)
      onExported(out.blob, out.durationSec)
      setNote('Fast join done (Mediabunny packet copy, no re-encode) — it\'s in your takes above.')
    } catch (e) {
      setNote(cancelRef.current
        ? 'Fast join cancelled — nothing was saved.'
        : `Fast join hit a problem: ${e instanceof Error ? e.message : 'unknown error'}. The render export below still works.`)
    } finally {
      setBusy(''); setProgress('')
    }
  }

  async function savePoster() {
    if (!introClip || busy) return
    setBusy('poster'); setNote('')
    try {
      const video = document.createElement('video')
      video.src = introClip.url
      video.crossOrigin = 'anonymous'
      await new Promise<void>((res, rej) => {
        video.onloadedmetadata = () => res()
        video.onerror = () => rej(new Error(`Could not load ${introClip.label}`))
      })
      video.currentTime = Math.min(1, Math.max(0.05, (video.duration || 1) / 2))
      await new Promise<void>((res) => { video.onseeked = () => res() })
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth || 1280
      canvas.height = video.videoHeight || 720
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas unavailable')
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
      if (!blob) throw new Error('Could not capture the frame')
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${projectName.replace(/[^\w-]+/g, '-').toLowerCase()}-poster.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
      setNote('Poster frame saved — the title-card frame, ready to use as the submission thumbnail.')
    } catch (e) {
      setNote(`Poster grab hit a problem: ${e instanceof Error ? e.message : 'unknown error'}.`)
    } finally {
      setBusy('')
    }
  }

  const slotPicker = (
    label: string,
    source: BookendSource,
    takeId: string | null,
    clip: FinishClip | null,
    patch: (p: Partial<FinishSettings>) => void,
    sourceKey: 'introSource' | 'outroSource',
    takeKey: 'introTakeId' | 'outroTakeId',
  ) => (
    <div className="rounded-xl border border-line bg-panel2 p-3">
      <div className="text-xs font-semibold text-slate-300">{label}</div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {([['kit', 'Brand kit'], ['take', 'Library take'], ['none', 'None']] as [BookendSource, string][]).map(([s, l]) => (
          <button key={s} onClick={() => patch({ [sourceKey]: s } as Partial<FinishSettings>)}
            disabled={s === 'kit' && !kit}
            title={s === 'kit' && !kit ? 'Pick a brand kit below first' : undefined}
            className={`rounded-lg px-2 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${source === s ? 'bg-teal font-semibold text-ink' : 'border border-line text-slate-300 hover:bg-panel'}`}>{l}</button>
        ))}
      </div>
      {source === 'take' && (
        <select value={takeId ?? ''} onChange={(e) => patch({ [takeKey]: e.target.value || null } as Partial<FinishSettings>)}
          className="mt-2 w-full rounded-lg border border-line bg-panel px-2 py-2 text-xs outline-none focus:border-teal">
          <option value="">Pick a take…</option>
          {takes.map((t) => <option key={t.id} value={t.id}>{t.name} ({formatTime(t.duration)})</option>)}
        </select>
      )}
      <div className="mt-2 text-[11px] text-slate-500">
        {clip ? <>{clip.label} · {formatTime(clip.duration)}</> : source === 'none' ? 'No clip in this slot.' : 'Nothing selected yet.'}
      </div>
    </div>
  )

  return (
    <div className="mt-6 rounded-2xl border border-line bg-panel p-4">
      <h2 className="flex items-center gap-2 font-semibold"><Flag size={17} className="text-teal-bright" /> Finish — bookends + polish</h2>
      <p className="mt-1 text-sm text-slate-400">The last step before you ship: wrap your finished cut (from CapCut or anywhere else) in an intro and outro, level the voice, and export one submission video. Nothing here touches your originals.</p>

      {/* Brand kit */}
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <label className="text-slate-300">Brand kit</label>
        <select value={settings.kitId ?? ''} onChange={(e) => update({ kitId: e.target.value || null })}
          className="rounded-lg border border-line bg-panel2 px-2 py-2 text-xs outline-none focus:border-teal">
          <option value="">None</option>
          {BRAND_KITS.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
        {kit && <span className="text-[11px] text-slate-500">The RobotForge kit is the trailer's own title + end cards, bundled with DemoCut.</span>}
      </div>

      {/* Slots */}
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {slotPicker('Intro', settings.introSource, settings.introTakeId, introClip, update, 'introSource', 'introTakeId')}
        <div className="rounded-xl border border-teal/50 bg-panel2 p-3">
          <div className="text-xs font-semibold text-slate-300">Body — your finished cut</div>
          <select value={settings.bodyTakeId ?? ''} onChange={(e) => update({ bodyTakeId: e.target.value || null })}
            className="mt-2 w-full rounded-lg border border-line bg-panel px-2 py-2 text-xs outline-none focus:border-teal">
            <option value="">Pick a take…</option>
            {takes.map((t) => <option key={t.id} value={t.id}>{t.name} ({formatTime(t.duration)})</option>)}
          </select>
          <button onClick={() => fileRef.current?.click()} className="mt-2 flex items-center gap-2 rounded-lg border border-teal px-3 py-2 text-xs font-semibold text-teal-bright hover:bg-teal/10"><Upload size={13} /> Import final cut…</button>
          <input ref={fileRef} type="file" accept="video/*,.mov,.mp4,.m4v,.webm" hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void onImportBody(f).then((id) => { if (id) update({ bodyTakeId: id }) })
            }} />
          <div className="mt-2 text-[11px] text-slate-500">{bodyTake ? `${bodyTake.name} · ${formatTime(bodyTake.duration)}` : 'The CapCut export (or any finished video) goes here.'}</div>
        </div>
        {slotPicker('Outro', settings.outroSource, settings.outroTakeId, outroClip, update, 'outroSource', 'outroTakeId')}
      </div>

      {/* Polish */}
      <div className="mt-4 space-y-2 text-sm">
        <label className="flex flex-wrap items-center gap-2">
          <input type="checkbox" checked={settings.fades} onChange={(e) => update({ fades: e.target.checked })} className="h-4 w-4 accent-teal-500" />
          Fades — dip to black at the joins, fade in at the head, out at the tail (~0.4s)
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <input type="checkbox" checked={settings.levelVoice} onChange={(e) => update({ levelVoice: e.target.checked })} className="h-4 w-4 accent-teal-500" />
          Voice levelling (body only) — measured RMS/peak gain, not LUFS
          {bodyTake && (voiceState === 'working'
            ? <span className="text-xs text-slate-500">measuring…</span>
            : voice
              ? <span className="text-xs text-teal-bright">voice {fmtDb(voice.voiceRmsDb)} · peak {fmtDb(voice.peakDb)} → gain {fmtDb(voice.gainDb)} → voice ≈ {fmtDb(voice.afterRmsDb)}, peak {fmtDb(voice.afterPeakDb)}</span>
              : <span className="text-xs text-amber-200">no readable audio track in the body — levelling will be skipped</span>)}
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <input type="checkbox" checked={settings.trimDeadAir} onChange={(e) => update({ trimDeadAir: e.target.checked })} className="h-4 w-4 accent-teal-500" />
          Trim dead air at the body's head/tail
          {bodyTake && (edge
            ? <span className="text-xs text-teal-bright">{edge.head + edge.tail >= 0.3 ? `found ${formatTime(edge.head)} at the head, ${formatTime(edge.tail)} at the tail — trims ${formatTime(edge.head + edge.tail)}` : 'nothing over 0.3s at the edges'}</span>
            : <span className="text-xs text-slate-500">listening…</span>)}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-slate-300">Output size</span>
          {(['720p', '1080p'] as const).map((q) => (
            <button key={q} onClick={() => update({ quality: q })} className={`rounded-lg px-3 py-1.5 text-xs ${settings.quality === q ? 'bg-teal font-semibold text-ink' : 'border border-line text-slate-300 hover:bg-panel2'}`}>{q}</button>
          ))}
          <span className="text-[11px] text-slate-500">Clips are scaled to fit — never cropped.</span>
        </div>
      </div>

      {/* Runtime */}
      <div className={`mt-4 rounded-xl border p-3 text-sm ${overBy > 0 && bodyTake ? 'border-red-400/60 bg-red-500/10 text-red-200' : 'border-line bg-panel2 text-slate-300'}`}>
        Runtime — intro {formatTime(introDur)} · body {formatTime(bodyDur)} · outro {formatTime(outroDur)} · <strong>total {formatTime(total)}</strong>
        {bodyTake && overBy > 0 && <div className="mt-1 font-semibold">Over the 3:00 submission limit by {formatTime(overBy)} — trim the body (in CapCut or the Editor above) before you export.</div>}
        {bodyTake && overBy <= 0 && <span className="text-slate-500"> — inside the 3:00 submission limit.</span>}
      </div>

      {/* Exports */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button onClick={() => void doRender()} disabled={!!busy || !bodyTake} className="flex items-center gap-2 rounded-xl bg-teal px-5 py-3 font-semibold text-ink hover:bg-teal-bright disabled:opacity-50">
          {busy === 'render' ? <Sparkles size={17} className="animate-pulse" /> : <Clapperboard size={17} />} {busy === 'render' ? 'Rendering…' : 'Export finished video'}
        </button>
        <button onClick={() => void savePoster()} disabled={!!busy || !introClip} className="flex items-center gap-2 rounded-xl border border-line px-4 py-3 text-sm font-semibold text-slate-200 hover:bg-panel2 disabled:opacity-50"><ImageDown size={15} /> Save poster frame</button>
        {busy && (
          <button onClick={() => { cancelRef.current = true }} className="flex items-center gap-2 rounded-xl border border-red-400/60 px-4 py-3 text-sm font-semibold text-red-200 hover:bg-red-500/10"><X size={15} /> Cancel</button>
        )}
        <span className="text-xs text-slate-400">Render export runs in real time and applies every polish pass above.</span>
      </div>

      {/* Fast concat */}
      <div className="mt-3">
        {polishOn ? (
          <p className="text-xs text-slate-500">Fast join is off while any polish pass is ticked — it copies the original packets untouched, so fades, levelling and trims can't be applied. Untick all three to use it.</p>
        ) : !bodyTake ? (
          <p className="text-xs text-slate-500">Fast join (no re-encode) appears here once a body is picked and all polish passes are off.</p>
        ) : concat?.ok && concatPieces ? (
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={() => void doConcat()} disabled={!!busy} className="flex items-center gap-2 rounded-xl border border-teal px-5 py-3 font-semibold text-teal-bright hover:bg-teal/10 disabled:opacity-50"><Zap size={17} /> Fast join — seconds, not minutes</button>
            <span className="text-xs text-slate-400">All clips are MP4/H.264 at the same size, so they can be joined by copying packets (Mediabunny/WebCodecs).</span>
          </div>
        ) : (
          <p className="text-xs text-slate-500">{concat && !concat.ok ? `Fast join unavailable: ${concat.reason}` : 'Checking whether these clips can be fast-joined…'}</p>
        )}
      </div>

      {progress && <p className="mt-2 text-xs text-teal-bright">{progress}</p>}
      {note && <p className="mt-2 text-xs text-amber-200">{note}</p>}
    </div>
  )
}
