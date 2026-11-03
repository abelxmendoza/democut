import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Clapperboard, Scissors, Sparkles, Zap } from 'lucide-react'
import { formatTime, pickMimeType, type Take } from '../lib/recorder'
import { detectSilences, cutSeconds, keptSegments, type SilenceSpan } from '../lib/silence'

interface Edit { include: boolean; start: number; end: number; silences?: SilenceSpan[]; cutSilence?: boolean }

function drawCaption(ctx: CanvasRenderingContext2D, text: string, W: number, H: number) {
  const maxChars = 44
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) { lines.push(line.trim()); line = w } else line += ' ' + w
    if (lines.length === 2) break
  }
  if (line.trim() && lines.length < 2) lines.push(line.trim())
  if (!lines.length) return
  const fontPx = Math.round(H * 0.042)
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  const lineH = fontPx * 1.25
  const blockH = lines.length * lineH + fontPx * 0.7
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width))
  const boxW = Math.min(W * 0.94, widest + fontPx * 1.2)
  const boxX = (W - boxW) / 2
  const boxY = H - blockH - H * 0.045
  ctx.fillStyle = 'rgba(0,0,0,0.72)'
  ctx.beginPath()
  ctx.roundRect(boxX, boxY, boxW, blockH, 10)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  lines.forEach((l, i) => ctx.fillText(l, W / 2, boxY + fontPx * 0.9 + i * lineH))
}

interface Props {
  takes: Take[]
  onExported: (blob: Blob, durationSec: number) => void
  title: string
  onTitleChange: (v: string) => void
}

const TITLE_SECONDS = 2.5

export default function Editor({ takes, onExported, title, onTitleChange }: Props) {
  const [order, setOrder] = useState<string[]>([])
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [titleOn, setTitleOn] = useState(true)
  const setTitle = onTitleChange
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState('')
  const [note, setNote] = useState('')
  const [detecting, setDetecting] = useState('')
  const [captionsOn, setCaptionsOn] = useState(true)

  // keep playlist in sync as new takes are recorded
  useEffect(() => {
    setOrder((prev) => {
      const kept = prev.filter((id) => takes.some((t) => t.id === id))
      const added = takes.map((t) => t.id).filter((id) => !kept.includes(id))
      return [...kept, ...added]
    })
    setEdits((prev) => {
      const next = { ...prev }
      for (const t of takes) {
        if (!next[t.id]) next[t.id] = { include: true, start: 0, end: t.duration || 0 }
        else if (!next[t.id].end) next[t.id].end = t.duration || 0
      }
      return next
    })
  }, [takes])

  const playlist = useMemo(
    () => order.map((id) => takes.find((t) => t.id === id)).filter(Boolean) as Take[],
    [order, takes],
  )
  const included = playlist.filter((t) => edits[t.id]?.include)
  const editedDuration = included.reduce((sum, t) => {
    const e = edits[t.id]
    const start = e?.start ?? 0
    const end = e?.end ?? t.duration
    let d = Math.max(0, end - start)
    if (e?.cutSilence && e.silences?.length) d -= cutSeconds(e.silences, start, end)
    return sum + Math.max(0, d)
  }, 0) + (titleOn && title.trim() ? TITLE_SECONDS : 0)
  const anyCaptions = included.some((t) => t.captions?.length)
  const fastBlockedByCuts = included.length === 1
    && !!edits[included[0].id]?.cutSilence
    && (edits[included[0].id]?.silences?.length ?? 0) > 0

  const move = (id: string, dir: -1 | 1) =>
    setOrder((prev) => {
      const i = prev.indexOf(id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const setEdit = (id: string, patch: Partial<Edit>) =>
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const detectFor = async (take: Take) => {
    setDetecting(take.id)
    try {
      const spans = await detectSilences(take.blob)
      setEdit(take.id, { silences: spans, cutSilence: spans.length > 0 })
    } catch {
      setNote(`Could not read the audio in ${take.name} — pause detection needs a take with a readable audio track. Nothing was changed.`)
    } finally {
      setDetecting('')
    }
  }

  const detectAll = async () => {
    setDetecting('all')
    let found = 0
    for (const t of playlist) {
      try {
        const spans = await detectSilences(t.blob)
        found += spans.length
        setEdit(t.id, { silences: spans, cutSilence: spans.length > 0 })
      } catch { /* per-take button reports the error if he runs it there */ }
    }
    setDetecting('')
    setNote(found ? `Auto-edit found ${found} pause${found === 1 ? '' : 's'} across your takes — each take below shows what it saves. Untick any you want to keep whole.` : 'Auto-edit found no pauses over 0.6s in these takes.')
  }

  // One click: every take in the project goes into the edit, included,
  // in the order it was recorded — then Export splices them into one video.
  const spliceAll = () => {
    const sorted = [...takes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    setOrder(sorted.map((t) => t.id))
    setEdits((prev) => {
      const next = { ...prev }
      for (const t of sorted) {
        next[t.id] = { include: true, start: next[t.id]?.start ?? 0, end: next[t.id]?.end || t.duration || 0 }
      }
      return next
    })
    setNote('All takes are in the edit, in recording order. Trim anything you want, then Export.')
  }

  async function exportEdit() {
    if (!included.length || exporting) return
    setExporting(true)
    setNote('')
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 1280
      canvas.height = 720
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas unavailable')

      const audioCtx = new AudioContext()
      await audioCtx.resume().catch(() => {})
      const audioDest = audioCtx.createMediaStreamDestination()

      const canvasStream = canvas.captureStream(30)
      const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks(), ...audioDest.stream.getAudioTracks()]
      const mimeType = pickMimeType()
      const rec = new MediaRecorder(new MediaStream(tracks), {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 8_000_000,
        audioBitsPerSecond: 128_000,
      })
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      const stopped = new Promise<void>((res) => { rec.onstop = () => res() })
      rec.start(500)

      const drawTitle = async () => {
        const endAt = performance.now() + TITLE_SECONDS * 1000
        await new Promise<void>((res) => {
          const frame = () => {
            ctx.fillStyle = '#0b0f14'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.fillStyle = '#f1f5f9'
            ctx.font = `700 ${Math.round(canvas.height * 0.07)}px system-ui, sans-serif`
            ctx.textAlign = 'center'
            ctx.fillText(title.trim(), canvas.width / 2, canvas.height / 2)
            ctx.fillStyle = '#14b8a6'
            ctx.font = `500 ${Math.round(canvas.height * 0.028)}px system-ui, sans-serif`
            ctx.fillText('recorded with DemoCut', canvas.width / 2, canvas.height / 2 + canvas.height * 0.09)
            if (performance.now() < endAt) requestAnimationFrame(frame)
            else res()
          }
          frame()
        })
      }

      if (titleOn && title.trim()) {
        setProgress('Rendering title card…')
        await drawTitle()
      }

      let sized = false
      for (let idx = 0; idx < included.length; idx++) {
        const take = included[idx]
        const edit = edits[take.id]
        setProgress(`Rendering clip ${idx + 1} of ${included.length}: ${take.name}`)
        const video = document.createElement('video')
        video.src = take.url
        video.playsInline = true
        video.crossOrigin = 'anonymous'
        await new Promise<void>((res, rej) => {
          video.onloadedmetadata = () => res()
          video.onerror = () => rej(new Error(`Could not load ${take.name}`))
        })
        if (!sized && video.videoWidth) {
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          sized = true
        }
        try {
          const src = audioCtx.createMediaElementSource(video)
          src.connect(audioDest)
        } catch { /* video-only clip: keep going */ }

        const start = Math.max(0, edit.start || 0)
        const end = Math.min(video.duration || take.duration, edit.end || video.duration || take.duration)
        const segs = edit.cutSilence && edit.silences?.length
          ? keptSegments(start, end, edit.silences)
          : [{ start, end }]
        for (const seg of segs) {
          video.currentTime = seg.start
          await new Promise<void>((res) => { video.onseeked = () => res() })
          await video.play()
          await new Promise<void>((res) => {
            const frame = () => {
              if (video.currentTime >= seg.end || video.ended) { res(); return }
              if (!video.paused) {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
                if (captionsOn && take.captions?.length) {
                  const cue = take.captions.find((c) => video.currentTime >= c.start && video.currentTime <= c.end)
                  if (cue) drawCaption(ctx, cue.text, canvas.width, canvas.height)
                }
              }
              requestAnimationFrame(frame)
            }
            frame()
          })
          video.pause()
        }
      }

      rec.stop()
      await stopped
      await audioCtx.close().catch(() => {})
      const blob = new Blob(chunks, { type: mimeType || 'video/webm' })
      onExported(blob, editedDuration)
      setNote('Edited video rendered — it\'s in your takes above, ready to download.')
    } catch (e) {
      setNote(`Export hit a problem: ${e instanceof Error ? e.message : 'unknown error'}. Your original takes are untouched.`)
    } finally {
      setExporting(false)
      setProgress('')
    }
  }


  // Fast path (Mediabunny, MPL-2.0, WebCodecs): trim ONE take by copying /
  // hardware-encoding its packets instead of re-rendering in real time.
  // Multi-take stitching and title cards still use the render export below.
  async function fastExport() {
    if (included.length !== 1 || exporting) return
    const take = included[0]
    const edit = edits[take.id]
    setExporting(true)
    setNote('')
    try {
      // Loaded on demand so the recorder's first paint stays light
      const { Input, Output, Conversion, BlobSource, BufferTarget, WebMOutputFormat, Mp4OutputFormat, ALL_FORMATS } = await import('mediabunny')
      const isMp4 = take.blob.type.includes('mp4') || /\.(mp4|mov|m4v)$/i.test(take.name)
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(take.blob) })
      const output = new Output({
        format: isMp4 ? new Mp4OutputFormat() : new WebMOutputFormat(),
        target: new BufferTarget(),
      })
      const conversion = await Conversion.init({
        input,
        output,
        trim: { start: Math.max(0, edit.start || 0), end: edit.end || undefined },
      })
      if (!conversion.isValid) throw new Error('this file format cannot be fast-exported — use the render export instead')
      conversion.onProgress = (p) => setProgress(`Fast export: ${Math.round(p * 100)}%`)
      await conversion.execute()
      const buffer = (output.target as unknown as { buffer: ArrayBuffer | null }).buffer
      if (!buffer) throw new Error('fast export produced no data')
      const blob = new Blob([buffer as BlobPart], { type: isMp4 ? 'video/mp4' : 'video/webm' })
      onExported(blob, Math.max(0, (edit.end || take.duration) - (edit.start || 0)))
      setNote('Fast export done (Mediabunny/WebCodecs) — trimmed take is in your library above.')
    } catch (err) {
      setNote(`Fast export hit a problem: ${err instanceof Error ? err.message : 'unknown error'}. The render export below still works.`)
    } finally {
      setExporting(false)
      setProgress('')
    }
  }

  if (!takes.length) return null

  return (
    <div className="mt-6 rounded-2xl border border-line bg-panel p-4">
      <h2 className="flex items-center gap-2 font-semibold"><Scissors size={17} className="text-teal-bright" /> Edit — trim, splice, export</h2>
      <p className="mt-1 text-sm text-slate-400">Every take in this project is in the edit below. Trim the flubs off each one, reorder them, add a title card, then export a single spliced video. Originals are never touched.</p>
      {takes.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={spliceAll} className="rounded-xl border border-teal px-4 py-2 text-sm font-semibold text-teal-bright hover:bg-teal/10">Splice all {takes.length} takes together</button>
          <button onClick={() => void detectAll()} disabled={detecting !== ''} className="rounded-xl border border-line px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-panel2 disabled:opacity-50">{detecting === 'all' ? 'Listening for pauses…' : 'Auto-edit: find pauses in all takes'}</button>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {playlist.map((t, i) => {
          const e = edits[t.id] ?? { include: true, start: 0, end: t.duration }
          const max = Math.max(0.1, t.duration || 0)
          return (
            <div key={t.id} className={`rounded-xl border p-3 ${e.include ? 'border-line bg-panel2' : 'border-line bg-panel2 opacity-50'}`}>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={e.include} onChange={(ev) => setEdit(t.id, { include: ev.target.checked })} className="h-4 w-4 accent-teal-500" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{i + 1}. {t.name} <span className="text-slate-500">({formatTime(t.duration)})</span></span>
                <button onClick={() => move(t.id, -1)} className="rounded-md border border-line p-1.5 text-slate-300 hover:bg-panel" title="Move up"><ArrowUp size={13} /></button>
                <button onClick={() => move(t.id, 1)} className="rounded-md border border-line p-1.5 text-slate-300 hover:bg-panel" title="Move down"><ArrowDown size={13} /></button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-3 text-[11px] text-slate-400">
                <label>Trim start: <span className="font-mono text-slate-200">{formatTime(e.start)}</span>
                  <input type="range" min={0} max={max} step={0.1} value={Math.min(e.start, max)} onChange={(ev) => setEdit(t.id, { start: Math.min(Number(ev.target.value), e.end) })} className="w-full accent-teal-500" /></label>
                <label>Trim end: <span className="font-mono text-slate-200">{formatTime(e.end)}</span>
                  <input type="range" min={0} max={max} step={0.1} value={Math.min(e.end || max, max)} onChange={(ev) => setEdit(t.id, { end: Math.max(Number(ev.target.value), e.start) })} className="w-full accent-teal-500" /></label>
              </div>
              <div className="text-[11px] text-slate-500">Kept: {formatTime(Math.max(0, e.end - e.start))} of {formatTime(t.duration)}</div>
              {t.markers && t.markers.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-slate-500">Chapters — click to start the trim there:</span>
                  {t.markers.map((m, mi) => (
                    <button key={mi} onClick={() => setEdit(t.id, { start: Math.min(m.t, Math.max(0, (e.end || t.duration) - 0.1)) })} className="rounded-full border border-line px-2 py-0.5 text-[10px] text-slate-300 hover:border-teal hover:text-teal-bright">{formatTime(m.t)} {m.label.length > 26 ? `${m.label.slice(0, 26)}…` : m.label}</button>
                  ))}
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                {e.silences === undefined ? (
                  <button onClick={() => void detectFor(t)} disabled={detecting !== ''} className="rounded-full border border-line px-2.5 py-1 text-slate-300 hover:border-teal hover:text-teal-bright disabled:opacity-50">{detecting === t.id ? 'Listening for pauses…' : 'Auto-edit: find pauses'}</button>
                ) : e.silences.length === 0 ? (
                  <span className="text-slate-500">Auto-edit: no pauses over 0.6s found in this take.</span>
                ) : (<>
                  <label className="flex items-center gap-1.5 text-slate-300"><input type="checkbox" checked={!!e.cutSilence} onChange={(ev) => setEdit(t.id, { cutSilence: ev.target.checked })} className="h-3.5 w-3.5 accent-teal-500" /> Cut {e.silences.length} pause{e.silences.length === 1 ? '' : 's'} — saves {formatTime(cutSeconds(e.silences, e.start, e.end || t.duration))}</label>
                  <button onClick={() => void detectFor(t)} disabled={detecting !== ''} className="text-slate-500 hover:text-slate-300 disabled:opacity-50">re-run</button>
                </>)}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={titleOn} onChange={(e) => setTitleOn(e.target.checked)} className="h-4 w-4 accent-teal-500" /> Title card</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="min-w-44 flex-1 rounded-lg border border-line bg-panel2 px-3 py-2 text-sm outline-none focus:border-teal" placeholder="Video title" />
        {anyCaptions && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={captionsOn} onChange={(e) => setCaptionsOn(e.target.checked)} className="h-4 w-4 accent-teal-500" /> Burn captions in</label>}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button onClick={exportEdit} disabled={exporting || !included.length} className="flex items-center gap-2 rounded-xl bg-teal px-5 py-3 font-semibold text-ink hover:bg-teal-bright disabled:opacity-50">
          {exporting ? <Sparkles size={17} className="animate-pulse" /> : <Clapperboard size={17} />} {exporting ? 'Rendering…' : 'Export edited video'}
        </button>
        <span className="text-xs text-slate-400">{included.length} clip{included.length === 1 ? '' : 's'} · edited length ≈ {formatTime(editedDuration)} · render export runs in real time (needed for title cards + stitching)</span>
      </div>
      {included.length === 1 && !fastBlockedByCuts && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button onClick={fastExport} disabled={exporting} className="flex items-center gap-2 rounded-xl border border-teal px-5 py-3 font-semibold text-teal-bright hover:bg-teal/10 disabled:opacity-50"><Zap size={17} /> Fast trim export — seconds, not minutes</button>
          <span className="text-xs text-slate-400">Single take, no title card. Powered by Mediabunny (WebCodecs, MPL-2.0) — the OSS survey's #1 pick, see docs/OSS-SURVEY.md</span>
        </div>
      )}
      {fastBlockedByCuts && (
        <p className="mt-3 text-xs text-slate-400">Fast export can't do jump cuts or burned-in captions — the render export above applies both.</p>
      )}
      {progress && <p className="mt-2 text-xs text-teal-bright">{progress}</p>}
      {note && <p className="mt-2 text-xs text-amber-200">{note}</p>}
    </div>
  )
}
