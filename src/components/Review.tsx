import { useEffect, useMemo, useState } from 'react'
import { ListChecks, FileText, Play, Copy, Check, Download, X, Captions } from 'lucide-react'
import type { Take } from '../lib/recorder'
import { formatTime } from '../lib/recorder'
import { buildReview, reviewToMarkdown, type FixItem } from '../lib/review'

/**
 * Review card — reads the project's captions and picks the takes apart:
 * a fix list from what the narrator said is broken / still to build, and
 * script coverage that snaps each take to the beats its words cover, in
 * whatever order the takes arrived. Results recompute live as captions
 * land; check-offs and dismissals persist per project in localStorage.
 */
export default function Review({ projectId, projectName, script, takes, captionBusy, onTranscribeAll }: {
  projectId: string
  projectName: string
  script: string
  takes: Take[]
  captionBusy: boolean
  onTranscribeAll: () => void
}) {
  const [tab, setTab] = useState<'fixes' | 'script'>('fixes')
  const [copied, setCopied] = useState(false)
  const storeKey = `democut-review-state-${projectId}`
  const [done, setDone] = useState<Set<string>>(new Set())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(storeKey) || '{}') as { done?: string[]; dismissed?: string[] }
      setDone(new Set(raw.done ?? []))
      setDismissed(new Set(raw.dismissed ?? []))
    } catch { setDone(new Set()); setDismissed(new Set()) }
  }, [storeKey])

  const persist = (d: Set<string>, x: Set<string>) => {
    try { localStorage.setItem(storeKey, JSON.stringify({ done: [...d], dismissed: [...x] })) } catch { /* session-only */ }
  }
  const toggleDone = (id: string) => {
    const next = new Set(done)
    if (next.has(id)) next.delete(id); else next.add(id)
    setDone(next); persist(next, dismissed)
  }
  const dismiss = (id: string) => {
    const next = new Set(dismissed); next.add(id)
    setDismissed(next); persist(done, next)
  }

  const result = useMemo(
    () => buildReview(script, takes.map((t) => ({ id: t.id, name: t.name, captions: t.captions, markers: t.markers }))),
    [script, takes],
  )
  const fixes = result.fixes.filter((f) => !dismissed.has(f.id))
  const openFixes = fixes.filter((f) => !done.has(f.id))
  const covered = result.beats.filter((b) => b.status !== 'missing').length
  const uncaptioned = takes.length - result.takesWithCaptions

  const seek = (takeId: string, start: number) => {
    const el = document.getElementById(`democut-video-${takeId}`) as HTMLVideoElement | null
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.currentTime = Math.max(0, start)
    void el.play().catch(() => { /* user gesture policies: the click counts, but stay quiet */ })
  }

  const md = () => reviewToMarkdown(projectName, { ...result, fixes }, done)
  const copyChecklist = () => {
    void navigator.clipboard.writeText(md()).then(() => {
      setCopied(true); window.setTimeout(() => setCopied(false), 1600)
    })
  }
  const downloadChecklist = () => {
    const url = URL.createObjectURL(new Blob([md()], { type: 'text/markdown' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-review.md`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  const fixRow = (f: FixItem) => (
    <li key={f.id} className="flex items-start gap-2.5 rounded-xl bg-panel2 px-3 py-2.5">
      <input
        type="checkbox" checked={done.has(f.id)} onChange={() => toggleDone(f.id)}
        className="mt-1 h-4 w-4 shrink-0 accent-teal" aria-label="Mark done"
      />
      <div className="min-w-0 flex-1">
        <p className={`text-[13px] leading-relaxed ${done.has(f.id) ? 'text-slate-500 line-through' : 'text-slate-200'}`}>“{f.quote}”</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-semibold text-amber-200">{f.kind}</span>
          <button onClick={() => seek(f.takeId, f.start)} className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-slate-300 hover:border-teal hover:text-teal-bright">
            <Play size={11} /> {f.takeName} · {formatTime(f.start)}
          </button>
        </div>
      </div>
      <button onClick={() => dismiss(f.id)} title="Not a real item — dismiss" className="shrink-0 rounded-lg p-1 text-slate-500 hover:text-slate-200"><X size={14} /></button>
    </li>
  )

  return (
    <div className="mt-6 rounded-2xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <ListChecks size={17} className="text-teal-bright" /> Review — {projectName}
        </h2>
        {result.takesWithCaptions > 0 && (
          <div className="flex gap-1.5">
            <button onClick={copyChecklist} className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-slate-300 hover:border-teal hover:text-teal-bright">
              {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy checklist</>}
            </button>
            <button onClick={downloadChecklist} className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-slate-300 hover:border-teal hover:text-teal-bright">
              <Download size={12} /> .md
            </button>
          </div>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">
        Your script, and everything you said still needs fixing. Review reads your takes' captions:
        narrate a problem out loud while you record (“this button is broken, I still need to build X”)
        and it lands on the fix list, with the moment it happened.
      </p>

      {takes.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No takes in this project yet — record or upload a few, in any order, and Review will pick them apart here.</p>
      ) : result.takesWithCaptions === 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button onClick={onTranscribeAll} disabled={captionBusy} className="flex items-center gap-2 rounded-xl bg-teal px-4 py-2.5 text-sm font-semibold text-ink hover:bg-teal-bright disabled:opacity-50">
            <Captions size={15} /> {captionBusy ? 'Captioning…' : 'Transcribe all takes & review'}
          </button>
          <span className="text-xs text-slate-500">Whisper runs on this device — first run downloads the model once (~78 MB). Order doesn't matter; the script is the spine.</span>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full bg-red-500/15 px-2.5 py-1 font-semibold text-red-200">{openFixes.length} to fix{done.size ? ` · ${fixes.length - openFixes.length} done` : ''}</span>
            <span className="rounded-full bg-teal/15 px-2.5 py-1 font-semibold text-teal-bright">{covered} of {result.beats.length} script beats covered</span>
            <span className="rounded-full bg-panel2 px-2.5 py-1 text-slate-400">from {result.takesWithCaptions} captioned take{result.takesWithCaptions === 1 ? '' : 's'}</span>
            {uncaptioned > 0 && (
              <button onClick={onTranscribeAll} disabled={captionBusy} className="rounded-full border border-teal px-2.5 py-1 font-semibold text-teal-bright hover:bg-teal/10 disabled:opacity-50">
                {captionBusy ? 'Captioning…' : `Transcribe ${uncaptioned} more take${uncaptioned === 1 ? '' : 's'}`}
              </button>
            )}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:max-w-xs">
            <button onClick={() => setTab('fixes')} className={`rounded-lg px-3 py-2 text-xs ${tab === 'fixes' ? 'bg-teal font-semibold text-ink' : 'border border-line text-slate-300 hover:bg-panel2'}`}>
              Fix list ({openFixes.length})
            </button>
            <button onClick={() => setTab('script')} className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs ${tab === 'script' ? 'bg-teal font-semibold text-ink' : 'border border-line text-slate-300 hover:bg-panel2'}`}>
              <FileText size={13} /> Script coverage
            </button>
          </div>

          {tab === 'fixes' ? (
            fixes.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">Nothing flagged in the narration — either it went clean, or the problems weren't said out loud. Narrate them as you hit them and they'll collect here.</p>
            ) : (
              <ul className="mt-3 space-y-2">{fixes.map(fixRow)}</ul>
            )
          ) : (
            <ul className="mt-3 space-y-2">
              {result.beats.map((b) => (
                <li key={b.index} className="rounded-xl bg-panel2 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${b.status === 'said' ? 'bg-teal/15 text-teal-bright' : b.status === 'different' ? 'bg-amber-500/15 text-amber-200' : 'bg-slate-500/15 text-slate-400'}`}>
                      {b.status === 'said' ? 'Said' : b.status === 'different' ? 'Said differently' : 'Not said yet'}
                    </span>
                    {b.attempts > 1 && <span className="rounded-full bg-panel px-2 py-0.5 text-[11px] text-slate-400">{b.attempts} attempts</span>}
                    {b.takeId && b.start !== null && (
                      <button onClick={() => seek(b.takeId!, b.start!)} className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-slate-300 hover:border-teal hover:text-teal-bright">
                        <Play size={11} /> best: {b.takeName} · {formatTime(b.start)}
                      </button>
                    )}
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-slate-200">{b.label}</p>
                  {b.status === 'different' && b.saidText && (
                    <p className="mt-1 text-[12px] leading-relaxed text-slate-400">You said: “{b.saidText}”</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            Review is heuristics over Whisper captions — quotes are verbatim, matches can be wrong. Dismiss anything it misread; nothing is changed or applied automatically.
          </p>
        </>
      )}
    </div>
  )
}
