// Generated intro / credits cards: drawn on canvas with the project's
// real brand logos (Simple Icons, CC0 — see logos.ts) and typeset
// wordmarks, then recorded to a short silent video take with the same
// captureStream + MediaRecorder pattern the Editor's title card uses.
// A generated card is an ordinary library take afterwards: it can sit in
// the Finish intro/outro slots like any other clip. No network, no AI —
// the card is typeset from the project's own preset text.

import { pickMimeType } from './recorder'
import { parseBeats } from './review'
import { cardLogosFor, logoImage, type CardLogoSet } from './logos'
import type { Project } from './projects'

export const INTRO_CARD_SECONDS = 3
export const CREDITS_CARD_SECONDS = 4.5

const BG = '#0b0f14'
const INK = '#f1f5f9'
const MUTED = '#94a3b8'
const FAINT = '#64748b'
const TEAL = '#14b8a6'
const LOGO_COLOR = '#e2e8f0'

/**
 * A one-line tagline from the project's own script: the first beat,
 * unwrapped. The RobotForge preset's hook is a quoted line ("Tell it a
 * robot, it builds the plan") — the quotes come off, the words are the
 * preset's own. Nothing is written for the project here.
 */
export function cardTagline(project: Project): string {
  const first = parseBeats(project.script)[0]?.matchText ?? ''
  let t = first.replace(/^(hook|framing|honest beat|open first)\s*:\s*/i, '').trim()
  if (t.startsWith('"')) {
    const close = t.indexOf('"', 1)
    if (close > 1) t = t.slice(1, close)
  } else {
    t = t.split(' — ')[0]
  }
  t = t.trim()
  return t.length > 92 ? `${t.slice(0, 89)}…` : t
}

export interface CardSpec {
  kind: 'intro' | 'credits'
  project: Project
  width: number
  height: number
}

interface StripItem { width: number; draw: (ctx: CanvasRenderingContext2D, x: number, cy: number, h: number) => void }

/** Build the "Built with" strip items (logos + Muse wordmark block). */
async function stripItems(set: CardLogoSet, ctx: CanvasRenderingContext2D, u: number): Promise<StripItem[]> {
  const items: StripItem[] = []
  for (const logo of set.logos) {
    const img = await logoImage(logo, LOGO_COLOR)
    items.push({
      width: 54 * u, // logos are square (24×24 viewBox)
      draw: (c, x, cy, h) => c.drawImage(img, x, cy - h / 2, h, h),
    })
  }
  if (set.claudeWordmark) {
    // Typeset wordmark — Muse has no logo in Simple Icons and none is
    // faked here. Two lines: "Muse Spark" over a small "by Meta".
    const mainFont = `700 ${30 * u}px system-ui, sans-serif`
    const subFont = `500 ${17 * u}px system-ui, sans-serif`
    ctx.font = mainFont
    const w = Math.max(ctx.measureText('Muse Spark').width, 62 * u)
    items.push({
      width: w,
      draw: (c, x, cy) => {
        c.textAlign = 'left'
        c.fillStyle = INK
        c.font = mainFont
        c.fillText('Muse Spark', x, cy - 2 * u)
        c.fillStyle = FAINT
        c.font = subFont
        c.fillText('by Meta', x, cy + 24 * u)
      },
    })
  }
  return items
}

function drawStrip(ctx: CanvasRenderingContext2D, items: StripItem[], cx: number, cy: number, h: number, u: number) {
  const gap = 34 * u
  const total = items.reduce((s, i) => s + i.width, 0) + gap * Math.max(0, items.length - 1)
  let x = cx - total / 2
  for (const item of items) {
    item.draw(ctx, x, cy, h)
    x += item.width + gap
  }
}

/** Fit `text` on one line: shrink the font until it fits maxW. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: number, startPx: number, maxW: number): number {
  let px = startPx
  while (px > 10) {
    ctx.font = `${weight} ${px}px system-ui, sans-serif`
    if (ctx.measureText(text).width <= maxW) break
    px -= 2
  }
  return px
}

export async function drawCard(ctx: CanvasRenderingContext2D, spec: CardSpec): Promise<void> {
  const { width: W, height: H, project, kind } = spec
  const u = H / 720
  const set = cardLogosFor(project.id)
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, W, H)
  ctx.textAlign = 'center'

  if (kind === 'intro') {
    const title = project.title || project.name
    const px = fitFont(ctx, title, 700, 58 * u, W * 0.88)
    ctx.font = `700 ${px}px system-ui, sans-serif`
    ctx.fillStyle = INK
    ctx.fillText(title, W / 2, H * 0.42)
    ctx.fillStyle = TEAL
    ctx.fillRect(W / 2 - 46 * u, H * 0.47, 92 * u, 4 * u)
    const tagline = cardTagline(project)
    if (tagline) {
      const tpx = fitFont(ctx, tagline, 500, 27 * u, W * 0.86)
      ctx.font = `500 ${tpx}px system-ui, sans-serif`
      ctx.fillStyle = MUTED
      ctx.fillText(tagline, W / 2, H * 0.56)
    }
    const items = await stripItems(set, ctx, u)
    if (items.length) drawStrip(ctx, items, W / 2, H * 0.84, 36 * u, u)
  } else {
    // Credits: the project name is the headline wordmark (for RobotForge
    // that IS the RobotForge wordmark), then the "Built with" strip of
    // real logos + the Muse wordmark.
    const name = project.name
    const px = fitFont(ctx, name, 700, 66 * u, W * 0.88)
    ctx.font = `700 ${px}px system-ui, sans-serif`
    ctx.fillStyle = INK
    ctx.fillText(name, W / 2, H * 0.32)
    if (project.title && project.title !== name) {
      const tpx = fitFont(ctx, project.title, 500, 25 * u, W * 0.86)
      ctx.font = `500 ${tpx}px system-ui, sans-serif`
      ctx.fillStyle = MUTED
      ctx.fillText(project.title, W / 2, H * 0.42)
    }
    ctx.font = `600 ${19 * u}px system-ui, sans-serif`
    ctx.fillStyle = FAINT
    ctx.fillText('B U I L T   W I T H', W / 2, H * 0.58)
    const items = await stripItems(set, ctx, u)
    if (items.length) drawStrip(ctx, items, W / 2, H * 0.68, 54 * u, u)
    ctx.font = `500 ${18 * u}px system-ui, sans-serif`
    ctx.fillStyle = FAINT
    ctx.fillText('Finished with DemoCut', W / 2, H * 0.9)
  }
}

/**
 * Render a card to a silent video blob. The still frame is drawn once to
 * an offscreen canvas, then held on a recorded canvas for the card's
 * duration — the Editor title-card pattern, minus the per-frame redraw.
 */
export async function renderCardVideo(spec: CardSpec): Promise<{ blob: Blob; durationSec: number }> {
  const off = document.createElement('canvas')
  off.width = spec.width
  off.height = spec.height
  const octx = off.getContext('2d')
  if (!octx) throw new Error('Canvas unavailable')
  await drawCard(octx, spec)

  const canvas = document.createElement('canvas')
  canvas.width = spec.width
  canvas.height = spec.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')

  const mimeType = pickMimeType()
  const rec = new MediaRecorder(canvas.captureStream(30), {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: 8_000_000,
  })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  const stopped = new Promise<void>((res) => { rec.onstop = () => res() })
  const durationSec = spec.kind === 'intro' ? INTRO_CARD_SECONDS : CREDITS_CARD_SECONDS
  rec.start(250)
  await new Promise<void>((res) => {
    const endAt = performance.now() + durationSec * 1000
    const frame = () => {
      ctx.drawImage(off, 0, 0)
      if (performance.now() < endAt) requestAnimationFrame(frame)
      else res()
    }
    frame()
  })
  rec.stop()
  await stopped
  return { blob: new Blob(chunks, { type: mimeType || 'video/webm' }), durationSec }
}
