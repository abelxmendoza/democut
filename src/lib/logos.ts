// Brand logos for generated cards — the REAL brand marks, not redraws.
//
// Sources: Simple Icons (CC0-1.0), via the simple-icons npm package
// v16.36.0, fetched 2026-11-04. The .svg files in src/assets/logos/ carry
// the unmodified path data plus a provenance comment; slugs used:
//   meta, github, vercel, raspberrypi, intel
//
// Muse has NO Simple Icons logo and no logo is drawn or approximated for
// it anywhere in DemoCut: cards show Muse as a typeset wordmark
// ("Muse Spark", with "by Meta" beneath) — see cards.ts.

import metaSvg from '../assets/logos/meta.svg?raw'
import githubSvg from '../assets/logos/github.svg?raw'
import vercelSvg from '../assets/logos/vercel.svg?raw'
import raspberrypiSvg from '../assets/logos/raspberrypi.svg?raw'
import intelSvg from '../assets/logos/intel.svg?raw'

export interface BrandLogo {
  id: string
  name: string
  /** full SVG document text (24×24 viewBox, path data unmodified) */
  svg: string
}

export const BRAND_LOGOS: Record<string, BrandLogo> = {
  meta: { id: 'meta', name: 'Meta', svg: metaSvg },
  github: { id: 'github', name: 'GitHub', svg: githubSvg },
  vercel: { id: 'vercel', name: 'Vercel', svg: vercelSvg },
  raspberrypi: { id: 'raspberrypi', name: 'Raspberry Pi', svg: raspberrypiSvg },
  intel: { id: 'intel', name: 'Intel', svg: intelSvg },
}

export interface CardLogoSet {
  logos: BrandLogo[]
  /** show the typeset "Muse Spark / by Meta" wordmark in the strip */
  claudeWordmark: boolean
  /** RobotForge project: the card's headline is the RobotForge wordmark */
  robotforgeWordmark: boolean
}

/**
 * Which marks honestly belong on a project's card: the tools/platforms
 * that project actually used. Anything not listed gets GitHub only (the
 * code lives there) — no logo is decorative.
 */
export function cardLogosFor(projectId: string): CardLogoSet {
  switch (projectId) {
    case 'robotforge':
      // Meta AI hackathon entry, Intel RealSense scanning, code on
      // GitHub, hosted on Vercel, built with Muse Spark.
      return {
        logos: [BRAND_LOGOS.meta, BRAND_LOGOS.intel, BRAND_LOGOS.github, BRAND_LOGOS.vercel],
        claudeWordmark: true,
        robotforgeWordmark: true,
      }
    case 'democut':
      return { logos: [BRAND_LOGOS.github, BRAND_LOGOS.vercel], claudeWordmark: true, robotforgeWordmark: false }
    case 'omega1':
      // A Raspberry Pi robot; code on GitHub.
      return { logos: [BRAND_LOGOS.raspberrypi, BRAND_LOGOS.github], claudeWordmark: false, robotforgeWordmark: false }
    default:
      return { logos: [BRAND_LOGOS.github], claudeWordmark: false, robotforgeWordmark: false }
  }
}

/**
 * Load a logo as an image tinted to `color`. The Simple Icons paths carry
 * no fill of their own, so the fill is set on the <svg> element; explicit
 * width/height are injected because a viewBox-only SVG rasterises at the
 * browser's default size (blurry) when drawn to canvas.
 */
export function logoImage(logo: BrandLogo, color: string, rasterPx = 240): Promise<HTMLImageElement> {
  const tinted = logo.svg.replace('<svg ', `<svg width="${rasterPx}" height="${rasterPx}" fill="${color}" `)
  const url = URL.createObjectURL(new Blob([tinted], { type: 'image/svg+xml' }))
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not load the ${logo.name} logo`)) }
    img.src = url
  })
}
