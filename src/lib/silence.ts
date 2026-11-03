// Silence detection for auto-edit jump cuts.
// Pure Web Audio math — no AI, no downloads, nothing leaves the machine.
// Decodes the take's audio, measures RMS energy in short windows, and
// returns the spans that count as pauses/dead air worth cutting.

export interface SilenceSpan {
  start: number // seconds
  end: number // seconds
}

export interface SilenceOptions {
  /** shortest pause worth cutting, seconds (default 0.6) */
  minSilenceSec?: number
  /** kept breathing room at each end of a cut, seconds (default 0.12) */
  padSec?: number
  /** RMS below this counts as silent (default 0.012 ≈ −38 dBFS) */
  threshold?: number
}

const WINDOW_SEC = 0.05

export async function detectSilences(blob: Blob, opts: SilenceOptions = {}): Promise<SilenceSpan[]> {
  const minSilence = opts.minSilenceSec ?? 0.6
  const pad = opts.padSec ?? 0.12
  const threshold = opts.threshold ?? 0.012

  const raw = await blob.arrayBuffer()
  const ctx = new AudioContext()
  let buffer: AudioBuffer
  try {
    buffer = await ctx.decodeAudioData(raw)
  } finally {
    void ctx.close().catch(() => {})
  }

  // Per-window RMS across all channels
  const rate = buffer.sampleRate
  const winSamples = Math.max(1, Math.round(WINDOW_SEC * rate))
  const nWin = Math.floor(buffer.length / winSamples)
  const channels: Float32Array[] = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch))

  const silent: boolean[] = new Array(nWin).fill(false)
  for (let w = 0; w < nWin; w++) {
    let sum = 0
    const off = w * winSamples
    for (let i = 0; i < winSamples; i += 4) { // sample every 4th frame — plenty for energy
      let v = 0
      for (const data of channels) v += Math.abs(data[off + i])
      v /= channels.length
      sum += v * v
    }
    const rms = Math.sqrt(sum / Math.ceil(winSamples / 4))
    silent[w] = rms < threshold
  }

  // Windows → spans, keep the long ones, trim the pad back off each cut edge
  const spans: SilenceSpan[] = []
  let runStart = -1
  for (let w = 0; w <= nWin; w++) {
    const isSilent = w < nWin && silent[w]
    if (isSilent && runStart < 0) runStart = w
    if (!isSilent && runStart >= 0) {
      const start = runStart * WINDOW_SEC
      const end = w * WINDOW_SEC
      if (end - start >= minSilence) {
        const cs = start + pad
        const ce = end - pad
        if (ce - cs >= 0.1) spans.push({ start: cs, end: ce })
      }
      runStart = -1
    }
  }
  return spans
}

/** Total seconds the given spans remove from [start, end]. */
export function cutSeconds(spans: SilenceSpan[], start: number, end: number): number {
  let total = 0
  for (const s of spans) {
    const cs = Math.max(s.start, start)
    const ce = Math.min(s.end, end)
    if (ce > cs) total += ce - cs
  }
  return total
}

/** [start, end] minus the cut spans — the segments the export actually plays. */
export function keptSegments(start: number, end: number, cuts: SilenceSpan[]): { start: number; end: number }[] {
  if (!cuts.length) return [{ start, end }]
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const segs: { start: number; end: number }[] = []
  let cur = start
  for (const c of sorted) {
    const cs = Math.max(c.start, start)
    const ce = Math.min(c.end, end)
    if (cs > cur) segs.push({ start: cur, end: cs })
    cur = Math.max(cur, ce)
  }
  if (cur < end) segs.push({ start: cur, end })
  return segs.filter((s) => s.end - s.start > 0.05)
}
