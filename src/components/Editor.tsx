import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Clapperboard, Scissors, Sparkles } from 'lucide-react'
import { formatTime, pickMimeType, type Take } from '../lib/recorder'

interface Edit { include: boolean; start: number; end: number }

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
    return sum + Math.max(0, (e?.end ?? t.duration) - (e?.start ?? 0))
  }, 0) + (titleOn && title.trim() ? TITLE_SECONDS : 0)

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
        video.currentTime = start
        await new Promise<void>((res) => { video.onseeked = () => res() })
        await video.play()
        await new Promise<void>((res) => {
          const frame = () => {
            if (video.currentTime >= end || video.ended || video.paused) { res(); return }
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
            requestAnimationFrame(frame)
          }
          frame()
        })
        video.pause()
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

  if (!takes.length) return null

  return (
    <div className="mt-6 rounded-2xl border border-line bg-panel p-4">
      <h2 className="flex items-center gap-2 font-semibold"><Scissors size={17} className="text-teal-bright" /> Edit — trim, stitch, export</h2>
      <p className="mt-1 text-sm text-slate-400">Record as many takes as you want. Trim the flubs off each one, reorder them, add a title card, then export a single edited video. Originals are never touched.</p>

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
            </div>
          )
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={titleOn} onChange={(e) => setTitleOn(e.target.checked)} className="h-4 w-4 accent-teal-500" /> Title card</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="min-w-44 flex-1 rounded-lg border border-line bg-panel2 px-3 py-2 text-sm outline-none focus:border-teal" placeholder="Video title" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button onClick={exportEdit} disabled={exporting || !included.length} className="flex items-center gap-2 rounded-xl bg-teal px-5 py-3 font-semibold text-ink hover:bg-teal-bright disabled:opacity-50">
          {exporting ? <Sparkles size={17} className="animate-pulse" /> : <Clapperboard size={17} />} {exporting ? 'Rendering…' : 'Export edited video'}
        </button>
        <span className="text-xs text-slate-400">{included.length} clip{included.length === 1 ? '' : 's'} · edited length ≈ {formatTime(editedDuration)} · renders in real time, so a 3-min demo takes ~3 min</span>
      </div>
      {progress && <p className="mt-2 text-xs text-teal-bright">{progress}</p>}
      {note && <p className="mt-2 text-xs text-amber-200">{note}</p>}
    </div>
  )
}
