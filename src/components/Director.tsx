import { useMemo, useRef, useState } from 'react'
import { Check, Clapperboard, Copy, Download, FileText, ImagePlus, ListOrdered, Sparkles, Wand2, X } from 'lucide-react'
import { formatTime, type Take } from '../lib/recorder'
import type { Project } from '../lib/projects'
import type { FinishQuality } from '../lib/finish'
import { canvasFor } from '../lib/finish'
import { renderCardVideo } from '../lib/cards'
import {
  assembleByOrder, assembleFromTranscripts, buildNarration, narrationToText,
  type AssemblyPlan,
} from '../lib/director'
import { renderTimeline, RenderCancelled, type TimelinePiece } from '../lib/renderTimeline'

/**
 * Director panel (inside Finish): generated intro/credits cards with the
 * project's real brand logos, a one-click auto-assembly from Review's
 * transcript coverage, and a narration draft in Abel's own words.
 * Everything is deterministic and on-device — the copy says exactly
 * that, because that is all it is.
 */
interface Props {
  project: Project
  script: string
  takes: Take[]
  quality: FinishQuality
  /** Adds a generated/rendered blob to the library as a named take; returns its id. */
  onAddTake: (blob: Blob, name: string, durationSec: number) => string
  /** Pins a take as the Finish intro/outro bookend. */
  onSlotCard: (slot: 'intro' | 'outro', takeId: string) => void
  /** Sets the Finish body take. */
  onSetBody: (takeId: string) => void
}

const SUBMISSION_LIMIT_SEC = 180

function extFor(blob: Blob): string {
  return blob.type.includes('mp4') ? 'mp4' : 'webm'
}

export default function Director({ project, script, takes, quality, onAddTake, onSlotCard, onSetBody }: Props) {
  const [plan, setPlan] = useState<AssemblyPlan | null>(null)
  const [noTranscripts, setNoTranscripts] = useState(false)
  const [busy, setBusy] = useState<'' | 'intro' | 'credits' | 'render'>('')
  const [progress, setProgress] = useState('')
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)
  const cancelRef = useRef(false)

  const narration = useMemo(() => buildNarration(plan, takes), [plan, takes])
  const narrationText = useMemo(() => narrationToText(narration), [narration])
  const overBy = narration.totalSeconds - SUBMISSION_LIMIT_SEC

  async function genCard(kind: 'intro' | 'credits') {
    if (busy) return
    setBusy(kind); setNote('')
    try {
      const { width, height } = canvasFor(quality)
      const { blob, durationSec } = await renderCardVideo({ kind, project, width, height })
      const name = `${project.id}-${kind}-card.${extFor(blob)}`
      const id = onAddTake(blob, name, durationSec)
      onSlotCard(kind === 'intro' ? 'intro' : 'outro', id)
      setNote(kind === 'intro'
        ? 'Intro card generated and pinned as your intro bookend — it\'s also in the takes library.'
        : 'Credits card generated and pinned as your outro bookend — it\'s also in the takes library.')
    } catch (e) {
      setNote(`Card generation hit a problem: ${e instanceof Error ? e.message : 'unknown error'}. Nothing was added.`)
    } finally {
      setBusy('')
    }
  }

  function assemble() {
    const p = assembleFromTranscripts(script, takes)
    if (!p) {
      setPlan(null)
      setNoTranscripts(true)
      return
    }
    setNoTranscripts(false)
    setPlan(p)
  }

  async function renderDraft() {
    if (!plan || busy) return
    const pieces: TimelinePiece[] = plan.mode === 'transcripts'
      ? plan.segments.flatMap((seg) => {
          const take = takes.find((t) => t.id === seg.takeId)
          return take ? [{ label: `${seg.takeName} — beat ${seg.beatIndex + 1}`, url: take.url, start: seg.start, end: seg.end }] : []
        })
      : plan.orderTakes.flatMap((o) => {
          const take = takes.find((t) => t.id === o.takeId)
          return take ? [{ label: o.takeName, url: take.url, start: 0, end: o.duration }] : []
        })
    if (!pieces.length) { setNote('Nothing left to render — the takes in this plan are gone. Assemble again.'); return }
    cancelRef.current = false
    setBusy('render'); setNote(''); setProgress('')
    try {
      const { width, height } = canvasFor(quality)
      const out = await renderTimeline(pieces, {
        width, height, fades: true,
        onProgress: setProgress,
        isCancelled: () => cancelRef.current,
      })
      const id = onAddTake(out.blob, `${project.id}-director-draft.${extFor(out.blob)}`, out.durationSec)
      onSetBody(id)
      setNote('Draft rendered and set as the Finish body — bookends and polish above now apply to it. Render export runs in real time.')
    } catch (e) {
      if (e instanceof RenderCancelled) setNote('Draft render cancelled — nothing was saved.')
      else setNote(`Draft render hit a problem: ${e instanceof Error ? e.message : 'unknown error'}. Your original takes are untouched.`)
    } finally {
      setBusy(''); setProgress('')
    }
  }

  const copyNarration = () => {
    void navigator.clipboard.writeText(narrationText).then(() => {
      setCopied(true); window.setTimeout(() => setCopied(false), 1600)
    })
  }
  const downloadNarration = () => {
    const url = URL.createObjectURL(new Blob([narrationText], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${project.id}-narration.txt`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 4000)
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-panel2 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-200"><Wand2 size={15} className="text-teal-bright" /> Director — cards, auto-assembly, narration</div>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">
        On-device and deterministic: cards are typeset with this project's real brand logos, assembly matches
        your script beats to your own captioned takes, and the narration draft is your own spoken words.
        No AI generation, no uploads, no cost.
      </p>

      {/* Generated cards */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => void genCard('intro')} disabled={!!busy} className="flex items-center gap-2 rounded-lg border border-teal px-3 py-2 text-xs font-semibold text-teal-bright hover:bg-teal/10 disabled:opacity-50">
          <ImagePlus size={13} /> {busy === 'intro' ? 'Generating…' : 'Generate intro card'}
        </button>
        <button onClick={() => void genCard('credits')} disabled={!!busy} className="flex items-center gap-2 rounded-lg border border-teal px-3 py-2 text-xs font-semibold text-teal-bright hover:bg-teal/10 disabled:opacity-50">
          <ImagePlus size={13} /> {busy === 'credits' ? 'Generating…' : 'Generate credits card'}
        </button>
        <span className="text-[11px] text-slate-500">Project title + tagline (intro) or name + “Built with” logo strip (credits), recorded as a take and pinned to the slot.</span>
      </div>

      {/* Auto-assemble */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button onClick={assemble} disabled={!!busy || !takes.length} className="flex items-center gap-2 rounded-lg bg-teal px-3 py-2 text-xs font-semibold text-ink hover:bg-teal-bright disabled:opacity-50">
          <ListOrdered size={13} /> Auto-assemble draft from my transcripts
        </button>
        {plan?.mode === 'transcripts' && (
          <button onClick={() => void renderDraft()} disabled={!!busy || !plan.segments.length} className="flex items-center gap-2 rounded-lg border border-teal px-3 py-2 text-xs font-semibold text-teal-bright hover:bg-teal/10 disabled:opacity-50">
            {busy === 'render' ? <Sparkles size={13} className="animate-pulse" /> : <Clapperboard size={13} />} {busy === 'render' ? 'Rendering…' : 'Render draft & set as Finish body'}
          </button>
        )}
        {plan?.mode === 'order' && (
          <button onClick={() => void renderDraft()} disabled={!!busy || !plan.orderTakes.length} className="flex items-center gap-2 rounded-lg border border-teal px-3 py-2 text-xs font-semibold text-teal-bright hover:bg-teal/10 disabled:opacity-50">
            {busy === 'render' ? <Sparkles size={13} className="animate-pulse" /> : <Clapperboard size={13} />} {busy === 'render' ? 'Rendering…' : 'Render in recording order & set as body'}
          </button>
        )}
        {busy === 'render' && (
          <button onClick={() => { cancelRef.current = true }} className="flex items-center gap-2 rounded-lg border border-red-400/60 px-3 py-2 text-xs font-semibold text-red-200 hover:bg-red-500/10"><X size={13} /> Cancel</button>
        )}
      </div>

      {noTranscripts && !plan && (
        <div className="mt-3 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-100">
          This project has no transcripts yet, so there is nothing to assemble from — auto-assembly reads the
          captions Review makes. Transcribe your takes in Review above first, or:
          <button onClick={() => { setPlan(assembleByOrder(takes)); setNoTranscripts(false) }} className="ml-2 rounded-lg border border-amber-300/60 px-2.5 py-1 font-semibold text-amber-100 hover:bg-amber-500/10">
            Order takes by recording order instead
          </button>
        </div>
      )}

      {plan?.mode === 'transcripts' && (
        <div className="mt-3">
          <p className="text-xs text-slate-300">
            <strong>{plan.segments.length} of {plan.beatCount} beats covered</strong> · assembled length ≈ {formatTime(plan.totalSeconds)} · from {plan.takesWithCaptions} captioned take{plan.takesWithCaptions === 1 ? '' : 's'}
          </p>
          <ul className="mt-2 space-y-1.5">
            {plan.segments.map((seg) => (
              <li key={seg.beatIndex} className="flex flex-wrap items-center gap-2 rounded-lg bg-panel px-2.5 py-2 text-[11px] text-slate-300">
                <span className={`rounded-full px-2 py-0.5 font-semibold ${seg.status === 'said' ? 'bg-teal/15 text-teal-bright' : 'bg-amber-500/15 text-amber-200'}`}>
                  {seg.status === 'said' ? 'Said' : 'Said differently'}
                </span>
                <span className="min-w-0 flex-1 truncate" title={seg.label}>{seg.beatIndex + 1}. {seg.label.replace(/^\d+\s*[.)]\s*/, '')}</span>
                <span className="text-slate-400">{seg.takeName} · {formatTime(seg.start)}–{formatTime(seg.end)} · {Math.round(seg.score * 100)}% match</span>
              </li>
            ))}
          </ul>
          {plan.missing.length > 0 && (
            <div className="mt-2 rounded-lg border border-red-400/40 bg-red-500/10 p-2.5 text-[11px] leading-relaxed text-red-200">
              <strong>Not said yet — record or import these beats:</strong>
              <ul className="mt-1 list-inside list-disc">
                {plan.missing.map((m) => <li key={m.index}>{m.label}</li>)}
              </ul>
            </div>
          )}
          <p className="mt-2 text-[11px] text-slate-500">Auto-assembled from your transcripts (Review's coverage scores) — best-matching segment per beat, in script order. Check “said differently” picks before you ship.</p>
        </div>
      )}

      {plan?.mode === 'order' && (
        <p className="mt-3 text-xs leading-relaxed text-slate-400">
          Recording-order draft: {plan.orderTakes.length} take{plan.orderTakes.length === 1 ? '' : 's'}, ≈ {formatTime(plan.totalSeconds)} total.
          No transcript matching was used — transcribe in Review and assemble again for beat-by-beat picks.
        </p>
      )}

      {/* Narration draft */}
      {narration.lines.length > 0 ? (
        <div className="mt-4 rounded-lg border border-line bg-panel p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200"><FileText size={13} className="text-teal-bright" /> Narration draft</div>
            <div className="flex gap-1.5">
              <button onClick={copyNarration} className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-slate-300 hover:border-teal hover:text-teal-bright">
                {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
              </button>
              <button onClick={downloadNarration} className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-slate-300 hover:border-teal hover:text-teal-bright">
                <Download size={12} /> .txt
              </button>
            </div>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            {narration.tightened
              ? 'Draft narration — your words, lightly tightened (standalone “um/uh” fillers trimmed).'
              : 'Draft narration — your words, verbatim from the captions.'}
            {' '}One line per segment, ready for the ElevenLabs pipeline. Timings are estimates at 150 wpm.
          </p>
          <ol className="mt-2 space-y-1.5">
            {narration.lines.map((l, i) => (
              <li key={i} className="rounded-lg bg-panel2 px-2.5 py-2 text-[12px] leading-relaxed text-slate-200">
                <span className="mr-2 font-mono text-[11px] text-teal-bright">≈{Math.round(l.seconds)}s</span>
                {l.text}
                <span className="mt-0.5 block text-[10px] text-slate-500">{l.source}</span>
              </li>
            ))}
          </ol>
          <p className={`mt-2 text-[11px] ${overBy > 0 ? 'font-semibold text-red-300' : 'text-slate-500'}`}>
            Estimated total ≈ {formatTime(narration.totalSeconds)} at 150 wpm
            {overBy > 0 ? ` — over the 3:00 cap by ≈ ${formatTime(overBy)} at speaking pace; trim lines or beats.` : ' — inside the 3:00 cap at speaking pace.'}
          </p>
        </div>
      ) : (
        <p className="mt-4 text-[11px] text-slate-500">Narration draft appears here once takes have captions — it is built from your spoken words, so there is nothing to draft from yet.</p>
      )}

      {progress && <p className="mt-2 text-xs text-teal-bright">{progress}</p>}
      {note && <p className="mt-2 text-xs text-amber-200">{note}</p>}
    </div>
  )
}
