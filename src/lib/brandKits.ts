// Brand kits: bundled intro/outro clips ("bookends") a project can wrap
// around a finished cut in the Finish stage. A kit is just two clips plus
// honest metadata — the Finish stage can equally use any library takes as
// bookends; the kit is the ready-made, no-hunting option.
//
// RobotForge kit provenance: card-title.mp4 / card-end.mp4 are the actual
// title and end cards rendered by the RobotForge trailer build
// (~/workspace/hackathon/trailer, segments/card-title.mp4 and
// segments/card-end.mp4 — 1280×720 H.264, silent, 3.0s / 4.5s), copied
// byte-for-byte into this repo. If the trailer cards are ever re-rendered,
// re-copy them; do not redraw lookalikes here.

import robotforgeTitleUrl from '../assets/brand/robotforge/card-title.mp4'
import robotforgeEndUrl from '../assets/brand/robotforge/card-end.mp4'

export interface BrandKit {
  id: string
  name: string
  introUrl: string
  outroUrl: string
  introDuration: number // seconds, from ffprobe of the rendered cards
  outroDuration: number
  width: number
  height: number
}

export const BRAND_KITS: BrandKit[] = [
  {
    id: 'robotforge',
    name: 'RobotForge (trailer cards)',
    introUrl: robotforgeTitleUrl,
    outroUrl: robotforgeEndUrl,
    introDuration: 3.0,
    outroDuration: 4.5,
    width: 1280,
    height: 720,
  },
]

export function brandKit(id: string | null | undefined): BrandKit | null {
  return BRAND_KITS.find((k) => k.id === id) ?? null
}
