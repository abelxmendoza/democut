// Director — deterministic assembly over Review's real data. NOT
// generative AI: it reads the script coverage that Review already
// computed from the takes' on-device Whisper captions
// (lib/review.ts buildReview) and, for each script beat in order, picks
// the take segment Review scored as covering that beat most completely.
// Beats Review could not find anywhere stay flagged as missing — the
// Director never invents footage or words.

import { buildReview } from './review'
import type { Take } from './recorder'

export interface DirectorSegment {
  beatIndex: number
  /** the script line as written */
  label: string
  status: 'said' | 'different'
  takeId: string
  takeName: string
  /** segment range inside the take, seconds */
  start: number
  end: number
  /** Review's 0..1 containment score for this pick */
  score: number
  /** what was actually said in the picked window (verbatim) */
  saidText: string
}

export interface OrderTake {
  takeId: string
  takeName: string
  duration: number
}

export interface AssemblyPlan {
  mode: 'transcripts' | 'order'
  segments: DirectorSegment[]
  /** beats no take covered — "not said yet" */
  missing: { index: number; label: string }[]
  beatCount: number
  takesWithCaptions: number
  takesTotal: number
  /** order-mode fallback: whole takes in recording order */
  orderTakes: OrderTake[]
  totalSeconds: number
}

/**
 * Where a picked segment ends. Review's best window for a beat starts at
 * a known cue and its text (BeatCoverage.saidText) is the concatenation
 * of 1–4 consecutive cues from there — so walk the cues forward from the
 * window start until their joined text accounts for saidText, and end at
 * that cue (plus a small pad, clamped to the take).
 */
function segmentEnd(take: Take, start: number, saidText: string): number {
  const cues = take.captions ?? []
  const i = cues.findIndex((c) => c.start >= start - 0.01)
  if (i < 0) return Math.min(take.duration || start + 4, start + 4)
  let joined = ''
  let end = cues[i].end
  for (let j = i; j < Math.min(i + 4, cues.length); j++) {
    joined = joined ? `${joined} ${cues[j].text}` : cues[j].text
    end = cues[j].end
    if (joined.length >= saidText.length) break
  }
  const padded = end + 0.15
  return take.duration > 0 ? Math.min(padded, take.duration) : padded
}

/**
 * Assemble from transcripts. Returns null when the project has NO
 * captioned takes at all — the caller must say so plainly and offer the
 * recording-order fallback instead of pretending to direct.
 * Tie-break note: buildReview keeps the highest-scoring window; on equal
 * scores it keeps the first take in the list it is given, and DemoCut's
 * take list is newest-first — so ties resolve to the most recent take.
 */
export function assembleFromTranscripts(script: string, takes: Take[]): AssemblyPlan | null {
  const review = buildReview(
    script,
    takes.map((t) => ({ id: t.id, name: t.name, captions: t.captions, markers: t.markers })),
  )
  if (review.takesWithCaptions === 0) return null

  const segments: DirectorSegment[] = []
  const missing: AssemblyPlan['missing'] = []
  for (const beat of review.beats) {
    const take = beat.takeId ? takes.find((t) => t.id === beat.takeId) : undefined
    if (beat.status === 'missing' || !take || beat.start === null) {
      missing.push({ index: beat.index, label: beat.label })
      continue
    }
    const end = segmentEnd(take, beat.start, beat.saidText)
    segments.push({
      beatIndex: beat.index,
      label: beat.label,
      status: beat.status,
      takeId: take.id,
      takeName: take.name,
      start: beat.start,
      end: Math.max(beat.start + 0.2, end),
      score: beat.score,
      saidText: beat.saidText,
    })
  }
  return {
    mode: 'transcripts',
    segments,
    missing,
    beatCount: review.beats.length,
    takesWithCaptions: review.takesWithCaptions,
    takesTotal: review.takesTotal,
    orderTakes: [],
    totalSeconds: segments.reduce((s, seg) => s + (seg.end - seg.start), 0),
  }
}

/** Fallback when there are no transcripts: whole takes, recording order. */
export function assembleByOrder(takes: Take[]): AssemblyPlan {
  const sorted = [...takes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  return {
    mode: 'order',
    segments: [],
    missing: [],
    beatCount: 0,
    takesWithCaptions: takes.filter((t) => t.captions?.length).length,
    takesTotal: takes.length,
    orderTakes: sorted.map((t) => ({ takeId: t.id, takeName: t.name, duration: t.duration })),
    totalSeconds: sorted.reduce((s, t) => s + (t.duration || 0), 0),
  }
}

/* ------------------------------------------------------------------ */
/* Narration script draft                                              */
/*                                                                     */
/* One line per segment, in the shape Abel's ElevenLabs trailer        */
/* pipeline consumes: plain text, one segment per line. The words are  */
/* the take's own spoken words from its captions — verbatim, except    */
/* standalone filler tokens (um / uh / erm) are dropped and whitespace */
/* is tidied. If even one line changed, the panel labels the draft     */
/* "lightly tightened"; otherwise it says "verbatim". Timings are      */
/* estimates at 150 wpm, never measurements.                           */
/* ------------------------------------------------------------------ */

export const NARRATION_WPM = 150

const FILLER = /^(um+|uh+|erm+|hmm+)[,.]?$/i

export function cleanNarration(text: string): string {
  return text
    .split(/\s+/)
    .filter((tok) => tok && !FILLER.test(tok))
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim()
}

export function estimateSeconds(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length
  return (words / NARRATION_WPM) * 60
}

export interface NarrationLine {
  /** beat label, or the take name in take-order mode */
  label: string
  text: string
  seconds: number
  source: string
}

export interface NarrationDraft {
  lines: NarrationLine[]
  totalSeconds: number
  /** true when filler-trimming changed at least one line */
  tightened: boolean
  /** captioned takes that contributed lines */
  takesUsed: number
}

export function buildNarration(plan: AssemblyPlan | null, takes: Take[]): NarrationDraft {
  const lines: NarrationLine[] = []
  let tightened = false
  const push = (label: string, raw: string, source: string) => {
    const text = cleanNarration(raw)
    if (!text) return
    if (text !== raw.replace(/\s+/g, ' ').trim()) tightened = true
    lines.push({ label, text, seconds: estimateSeconds(text), source })
  }

  if (plan?.mode === 'transcripts') {
    for (const seg of plan.segments) push(seg.label, seg.saidText, seg.takeName)
    return { lines, totalSeconds: lines.reduce((s, l) => s + l.seconds, 0), tightened, takesUsed: new Set(plan.segments.map((s) => s.takeId)).size }
  }

  // No transcript plan: one line per captioned take, recording order,
  // from the take's full caption text.
  const sorted = [...takes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  let used = 0
  for (const take of sorted) {
    if (!take.captions?.length) continue
    used++
    push(take.name, take.captions.map((c) => c.text).join(' '), take.name)
  }
  return { lines, totalSeconds: lines.reduce((s, l) => s + l.seconds, 0), tightened, takesUsed: used }
}

/** The .txt / clipboard payload: one line per segment, nothing else. */
export function narrationToText(draft: NarrationDraft): string {
  return draft.lines.map((l) => l.text).join('\n')
}
