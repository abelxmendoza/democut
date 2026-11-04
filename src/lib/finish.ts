// Finish stage: [intro bookend] → [one finished body cut] → [outro bookend],
// with polish passes (fades, voice levelling, dead-air edge trim) applied at
// export. Settings persist per project in localStorage, like the rest of
// DemoCut's per-project state.

import { detectSilences } from './silence'
import type { Take } from './recorder'
import { brandKit, type BrandKit } from './brandKits'

export type BookendSource = 'kit' | 'take' | 'none'
export type FinishQuality = '720p' | '1080p'

export interface FinishSettings {
  kitId: string | null
  introSource: BookendSource
  introTakeId: string | null
  outroSource: BookendSource
  outroTakeId: string | null
  bodyTakeId: string | null
  fades: boolean
  levelVoice: boolean
  trimDeadAir: boolean
  quality: FinishQuality
}

const KEY = 'democut-finish-settings'

export function defaultFinishSettings(projectId: string): FinishSettings {
  // The RobotForge project opens with its own trailer cards already in the
  // slots — that is the whole point of the bundled kit. Other projects
  // start empty and pick library takes (or nothing) themselves.
  const isRobotForge = projectId === 'robotforge'
  return {
    kitId: isRobotForge ? 'robotforge' : null,
    introSource: isRobotForge ? 'kit' : 'none',
    introTakeId: null,
    outroSource: isRobotForge ? 'kit' : 'none',
    outroTakeId: null,
    bodyTakeId: null,
    fades: true,
    levelVoice: true,
    trimDeadAir: false,
    quality: '720p',
  }
}

export function loadFinishSettings(projectId: string): FinishSettings {
  const base = defaultFinishSettings(projectId)
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Partial<FinishSettings>>
    return { ...base, ...(all[projectId] ?? {}) }
  } catch {
    return base
  }
}

export function saveFinishSettings(projectId: string, s: FinishSettings): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, FinishSettings>
    all[projectId] = s
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch { /* private window etc. — Finish just won't persist */ }
}

export function canvasFor(quality: FinishQuality): { width: number; height: number } {
  return quality === '1080p' ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }
}

/** A resolved clip the render/concat engines can consume. */
export interface FinishClip {
  label: string
  url: string
  duration: number
  /** Blob when we have one (library takes always; brand cards fetched lazily). */
  blob?: Blob
  /** Natural pixel size when known (brand cards: known; takes: probed in UI). */
  width?: number
  height?: number
}

export function resolveBookend(
  source: BookendSource,
  takeId: string | null,
  kit: BrandKit | null,
  slot: 'intro' | 'outro',
  takes: Take[],
): FinishClip | null {
  if (source === 'none') return null
  if (source === 'kit') {
    if (!kit) return null
    return slot === 'intro'
      ? { label: `${kit.name} — title card`, url: kit.introUrl, duration: kit.introDuration, width: kit.width, height: kit.height }
      : { label: `${kit.name} — end card`, url: kit.outroUrl, duration: kit.outroDuration, width: kit.width, height: kit.height }
  }
  const take = takes.find((t) => t.id === takeId)
  if (!take) return null
  return { label: take.name, url: take.url, duration: take.duration, blob: take.blob }
}

export function resolveBody(settings: FinishSettings, takes: Take[]): FinishClip | null {
  const take = takes.find((t) => t.id === settings.bodyTakeId)
  if (!take) return null
  return { label: take.name, url: take.url, duration: take.duration, blob: take.blob }
}

export function kitFor(settings: FinishSettings): BrandKit | null {
  return brandKit(settings.kitId)
}

/* ------------------------------------------------------------------ */
/* Voice levelling analysis                                            */
/*                                                                     */
/* Plain RMS/peak math on the decoded audio — NOT LUFS (no K-weighting */
/* is implemented, and the UI must not claim it). We measure the RMS of */
/* the "voice" windows (the ones above the silence floor, reusing the  */
/* same threshold approach as silence.ts), then pick a gain that      */
/* brings that RMS to the target without letting peaks clip.           */
/* ------------------------------------------------------------------ */

export interface VoiceLevel {
  voiceRmsDb: number
  peakDb: number
  gainDb: number
  afterRmsDb: number
  afterPeakDb: number
}

export const VOICE_TARGET_RMS_DB = -18
const SILENCE_RMS = 0.012 // ≈ −38 dBFS, same floor as silence.ts

function toDb(v: number): number {
  return v > 0 ? 20 * Math.log10(v) : -Infinity
}

export async function analyseVoiceLevel(blob: Blob): Promise<VoiceLevel | null> {
  let buffer: AudioBuffer
  const raw = await blob.arrayBuffer()
  const ctx = new AudioContext()
  try {
    buffer = await ctx.decodeAudioData(raw)
  } catch {
    return null // no readable audio track
  } finally {
    void ctx.close().catch(() => {})
  }
  if (!buffer.length || !buffer.numberOfChannels) return null

  const rate = buffer.sampleRate
  const win = Math.max(1, Math.round(0.05 * rate))
  const nWin = Math.floor(buffer.length / win)
  const channels: Float32Array[] = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch))

  let peak = 0
  let voiceSumSq = 0
  let voiceCount = 0
  for (let w = 0; w < nWin; w++) {
    let sum = 0
    let n = 0
    const off = w * win
    for (let i = 0; i < win; i += 4) {
      let v = 0
      for (const data of channels) v += Math.abs(data[off + i])
      v /= channels.length
      if (v > peak) peak = v
      sum += v * v
      n++
    }
    const rms = Math.sqrt(sum / Math.max(1, n))
    if (rms >= SILENCE_RMS) { voiceSumSq += rms * rms; voiceCount++ }
  }
  if (!voiceCount || peak === 0) return null

  const voiceRms = Math.sqrt(voiceSumSq / voiceCount)
  const voiceRmsDb = toDb(voiceRms)
  const peakDb = toDb(peak)
  // Gain toward the target RMS, capped so the loudest peak stays ≤ −1 dBFS,
  // and never more than +18 dB up / −12 dB down (beyond that it's a
  // recording problem, not a levelling problem).
  const peakCeilingDb = -1
  const maxGainByPeak = peakCeilingDb - peakDb
  const gainDb = Math.max(-12, Math.min(18, VOICE_TARGET_RMS_DB - voiceRmsDb, maxGainByPeak))
  return {
    voiceRmsDb,
    peakDb,
    gainDb,
    afterRmsDb: voiceRmsDb + gainDb,
    afterPeakDb: peakDb + gainDb,
  }
}

/* ------------------------------------------------------------------ */
/* Head/tail dead-air on the body                                      */
/* ------------------------------------------------------------------ */

export interface EdgeTrim {
  head: number // seconds to skip at the start
  tail: number // seconds to skip at the end
}

/** Dead air at the very edges of a clip, via silence.ts detection. */
export async function detectEdgeTrim(blob: Blob, duration: number): Promise<EdgeTrim> {
  if (!duration || !Number.isFinite(duration)) return { head: 0, tail: 0 }
  const spans = await detectSilences(blob, { minSilenceSec: 0.3, padSec: 0.05 })
  let head = 0
  let tail = 0
  for (const s of spans) {
    if (s.start <= 0.15) head = Math.max(head, s.end)
    if (s.end >= duration - 0.15) tail = Math.max(tail, duration - s.start)
  }
  // Never trim the whole clip away.
  if (head + tail > duration - 0.5) return { head: 0, tail: 0 }
  return { head, tail }
}
