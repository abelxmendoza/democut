// Take Rescue: settings + geometry helpers for rebuilding the picture
// track of a take whose screen was never recorded (older DemoCut takes
// can hold narration + a burned-in facecam but no screen picture at all).
// The screen content is NOT recoverable from such a file — Rescue
// composites a replacement visual track (a clean capture or a stills
// walkthrough) under the original take's audio, and lifts the burned-in
// facecam back into the corner. Settings persist per broken take in
// localStorage, like the rest of DemoCut's per-project state.

import { pipGeometry, type PipSize } from './recorder'

/** A rectangle as fractions (0–1) of the frame it refers to. */
export interface CropFractions {
  x: number
  y: number
  w: number
  h: number
}

export type FacecamMode = 'crop' | 'inset' | 'none'
export type VisualKind = 'video' | 'slideshow'
export type RescueQuality = '720p' | '1080p'

export interface RescueSettings {
  visualKind: VisualKind
  /** Replacement video: a take in the same project (recorded clean or uploaded). */
  replTakeId: string | null
  /** Replacement-track start offset, seconds. Positive = the replacement
      starts that far into its own timeline; negative = it starts late. */
  offsetSec: number
  faceMode: FacecamMode
  /** Which DemoCut facecam size the broken take was recorded with. */
  pipSize: PipSize
  /** Whether the broken take was recorded with a name tag above the facecam. */
  hasNameTag: boolean
  /** Facecam box as fractions of the frame; null = the compositor default
      for the broken take's real frame size (pipSize + hasNameTag). */
  crop: CropFractions | null
  kenBurns: boolean
  fades: boolean
  quality: RescueQuality
}

export function defaultRescueSettings(): RescueSettings {
  return {
    visualKind: 'video',
    replTakeId: null,
    offsetSec: 0,
    faceMode: 'crop',
    pipSize: 'm', // App's own default facecam size
    hasNameTag: true, // App ships with a name tag set, so old takes usually have one
    crop: null,
    kenBurns: true,
    fades: true,
    quality: '720p',
  }
}

const KEY = 'democut-rescue-settings'

export function loadRescueSettings(takeId: string): RescueSettings {
  const base = defaultRescueSettings()
  if (!takeId) return base
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Partial<RescueSettings>>
    return { ...base, ...(all[takeId] ?? {}) }
  } catch {
    return base
  }
}

export function saveRescueSettings(takeId: string, s: RescueSettings): void {
  if (!takeId) return
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, RescueSettings>
    all[takeId] = s
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch { /* private window etc. — Rescue just won't persist */ }
}

/** The default facecam crop for a broken take: the exact box DemoCut's
    compositor drew the facecam into for a frame of this size, as
    fractions of the frame. Derived from pipGeometry() in recorder.ts —
    the same constants the recording itself used. */
export function defaultCropFractions(
  frameW: number,
  frameH: number,
  pipSize: PipSize,
  hasNameTag: boolean,
): CropFractions {
  const { pip } = pipGeometry(frameW, frameH, pipSize, hasNameTag)
  return {
    x: pip.x / frameW,
    y: pip.y / frameH,
    w: pip.w / frameW,
    h: pip.h / frameH,
  }
}

/** Even split of a total runtime across n slideshow stills. */
export function evenSplit(totalSec: number, n: number): number {
  if (n <= 0 || !(totalSec > 0)) return 0
  return Math.round((totalSec / n) * 10) / 10
}
