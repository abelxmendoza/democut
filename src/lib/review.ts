// Review — read a project's captions and pick the takes apart.
//
// Two jobs, both pure functions over caption cues that already exist:
//  1. Fix list: find the moments where the narrator says something is
//     broken, missing, or still to build ("doesn't work", "I still need
//     to add…"). Each item quotes the caption verbatim — Review never
//     rewords what was said into a claim.
//  2. Script coverage: align what was said against the project's script
//     beats, take by take, in whatever order the takes arrived. The
//     script is the spine; a take that starts mid-script snaps to the
//     beats its words actually cover.
//
// Everything here is a heuristic over Whisper text and is labelled that
// way in the UI — items can be dismissed, and nothing is auto-applied.

export interface ReviewCue { start: number; end: number; text: string }
export interface ReviewTake {
  id: string
  name: string
  captions?: ReviewCue[]
  markers?: { t: number; label: string }[]
}

export interface FixItem {
  /** stable across recomputes: take + timestamp + quote head */
  id: string
  takeId: string
  takeName: string
  start: number
  quote: string
  /** which pattern family caught it, shown as a small chip */
  kind: string
}

export interface BeatCoverage {
  index: number
  /** the script line as written */
  label: string
  status: 'said' | 'different' | 'missing'
  /** best-matching take + moment, when any take covered the beat */
  takeId: string | null
  takeName: string | null
  start: number | null
  /** 0..1 containment of the beat's words in the best spoken window */
  score: number
  /** how many separate attempts at this beat were found across takes */
  attempts: number
  /** what was actually said in the best window (verbatim, may be '') */
  saidText: string
}

export interface ReviewResult {
  fixes: FixItem[]
  beats: BeatCoverage[]
  takesWithCaptions: number
  takesTotal: number
}

/* ------------------------------------------------------------------ */
/* text helpers                                                        */
/* ------------------------------------------------------------------ */

const STOP = new Set((
  'the a an and or to of in on for with is it its this that i you we they he she ' +
  'what who how when where why one two show shows showing shown read off over ' +
  'just like really actually going go get got say says said'
).split(/\s+/))

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** content words: tokens minus stopwords, deduped */
function contentWords(text: string): string[] {
  return [...new Set(tokens(text).filter((t) => t.length > 1 && !STOP.has(t)))]
}

/** fraction of `needle` words present in `hay` (0..1) */
function containment(needle: string[], hay: Set<string>): number {
  if (!needle.length) return 0
  let hit = 0
  for (const w of needle) if (hay.has(w)) hit++
  return hit / needle.length
}

/* ------------------------------------------------------------------ */
/* script beats                                                        */
/* ------------------------------------------------------------------ */

/** Script lines as beats: strip a leading "1." / "2)" number if present. */
export function parseBeats(script: string): { label: string; matchText: string }[] {
  return script
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((label) => ({
      label,
      matchText: label.replace(/^\d+\s*[.)]\s*/, ''),
    }))
}

/* ------------------------------------------------------------------ */
/* fix-list extraction                                                 */
/* ------------------------------------------------------------------ */

const FIX_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'broken', re: /\b(doesn'?t work|does not work|not working|isn'?t working|won'?t (work|load|open|start)|doesn'?t (load|open|start|respond)|nothing happens|it broke|broken)\b/i },
  { kind: 'error', re: /\b(error|errors|bug|bugs|crash(?:es|ed)?|failed|failure|exception)\b/i },
  { kind: 'wrong', re: /\b(that'?s wrong|this is wrong|wrong (button|screen|page|one)|not right|shouldn'?t (do|be|look) (that|like))\b/i },
  { kind: 'to build', re: /\b(still (need|have) to|need to (fix|build|add|finish|make|do|wire|hook)|have to (fix|build|add|finish)|i should (fix|add|build|finish)|forgot to|haven'?t (built|added|finished|done)|not (built|done|finished|implemented) yet|doesn'?t exist yet|isn'?t built|not wired|todo)\b/i },
  { kind: 'fix', re: /\b(fix (this|that|it)|fixing|needs? fixing|gotta fix|going to fix|i'?ll fix)\b/i },
  { kind: 'missing', re: /\b(missing|isn'?t (there|showing|here)|not showing|doesn'?t show|no (button|way|option) to)\b/i },
]

export function extractFixes(takes: ReviewTake[]): FixItem[] {
  const out: FixItem[] = []
  for (const take of takes) {
    const cues = take.captions ?? []
    for (const cue of cues) {
      const text = cue.text.trim()
      if (!text) continue
      for (const { kind, re } of FIX_PATTERNS) {
        if (re.test(text)) {
          out.push({
            id: `${take.id}@${Math.round(cue.start)}:${text.slice(0, 24)}`,
            takeId: take.id,
            takeName: take.name,
            start: cue.start,
            quote: text,
            kind,
          })
          break // one item per cue, first matching family wins
        }
      }
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/* ------------------------------------------------------------------ */
/* script coverage                                                     */
/* ------------------------------------------------------------------ */

interface Window { takeId: string; takeName: string; start: number; score: number; text: string }

/**
 * Best spoken window for a beat inside one take: slide over cues in
 * growing windows (1..4 cues ≈ a spoken sentence or two) and score each
 * by how many of the beat's content words it contains.
 */
function bestWindowInTake(beatWords: string[], take: ReviewTake): Window | null {
  const cues = take.captions ?? []
  if (!cues.length || !beatWords.length) return null
  let best: Window | null = null
  for (let i = 0; i < cues.length; i++) {
    const hay = new Set<string>()
    let text = ''
    for (let j = i; j < Math.min(i + 4, cues.length); j++) {
      for (const t of tokens(cues[j].text)) hay.add(t)
      text = text ? text + ' ' + cues[j].text : cues[j].text
      const score = containment(beatWords, hay)
      if (!best || score > best.score) {
        best = { takeId: take.id, takeName: take.name, start: cues[i].start, score, text }
      }
      if (score >= 0.95) break
    }
  }
  return best
}

/** count separate attempts at a beat inside one take (windows ≥ 0.35, non-overlapping starts) */
function attemptsInTake(beatWords: string[], take: ReviewTake): number {
  const cues = take.captions ?? []
  let count = 0
  let lastStart = -Infinity
  for (let i = 0; i < cues.length; i++) {
    const hay = new Set<string>()
    for (let j = i; j < Math.min(i + 3, cues.length); j++) {
      for (const t of tokens(cues[j].text)) hay.add(t)
    }
    if (containment(beatWords, hay) >= 0.35 && cues[i].start - lastStart > 8) {
      count++
      lastStart = cues[i].start
    }
  }
  return count
}

export function buildReview(script: string, takes: ReviewTake[]): ReviewResult {
  const withCaps = takes.filter((t) => t.captions?.length)
  const beats = parseBeats(script)
  const coverage: BeatCoverage[] = beats.map((beat, index) => {
    const words = contentWords(beat.matchText)
    let best: Window | null = null
    let attempts = 0
    for (const take of withCaps) {
      const w = bestWindowInTake(words, take)
      if (w && (!best || w.score > best.score)) best = w
      attempts += attemptsInTake(words, take)
    }
    const score = best?.score ?? 0
    const status: BeatCoverage['status'] = score >= 0.5 ? 'said' : score >= 0.25 ? 'different' : 'missing'
    return {
      index,
      label: beat.label,
      status,
      takeId: best && status !== 'missing' ? best.takeId : null,
      takeName: best && status !== 'missing' ? best.takeName : null,
      start: best && status !== 'missing' ? best.start : null,
      score,
      attempts,
      saidText: best && status !== 'missing' ? best.text : '',
    }
  })
  return {
    fixes: extractFixes(withCaps),
    beats: coverage,
    takesWithCaptions: withCaps.length,
    takesTotal: takes.length,
  }
}

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */

function stamp(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function reviewToMarkdown(projectName: string, r: ReviewResult, doneIds: Set<string>): string {
  const lines: string[] = [`# ${projectName} — Review`, '']
  lines.push(`## Fix list (${r.fixes.length})`)
  if (!r.fixes.length) lines.push('Nothing flagged in the narration.')
  for (const f of r.fixes) {
    lines.push(`- [${doneIds.has(f.id) ? 'x' : ' '}] (${f.kind}) "${f.quote}" — ${f.takeName} @ ${stamp(f.start)}`)
  }
  lines.push('', '## Script coverage')
  for (const b of r.beats) {
    const where = b.takeName !== null && b.start !== null ? ` — best in ${b.takeName} @ ${stamp(b.start)}` : ''
    const tries = b.attempts > 1 ? ` · ${b.attempts} attempts` : ''
    lines.push(`- [${b.status}] ${b.label}${where}${tries}`)
    if (b.status === 'different' && b.saidText) lines.push(`  - said: "${b.saidText}"`)
  }
  lines.push('', '_From DemoCut Review: heuristics over on-device Whisper captions; quotes are verbatim._')
  return lines.join('\n')
}

export { stamp as reviewStamp }
