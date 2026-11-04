// Timeline renderer for the Finish stage: plays a list of clips back to
// back onto one fixed-size canvas and records it (canvas stream + Web
// Audio mix → MediaRecorder), the same proven pattern as the Editor's
// render export — factored into one piece of segment machinery here so
// Finish builds on it instead of growing a second ad-hoc player.
//
// Finish-specific behaviour on top of the Editor's renderer:
//   * fixed output canvas; every clip is scaled to FIT (letterboxed on
//     black) — screen content is never cropped;
//   * per-clip gain (voice levelling applies to the body only);
//   * fade envelope per clip: fade-in at its head and fade-out at its
//     tail when fades are on, which reads as dip-to-black at the joins
//     and a fade in/out at the very start/end of the video;
//   * cancel: the caller's flag is polled every frame; cancelling stops
//     the recorder and discards the partial render.

import { pickMimeType, roundRect } from './recorder'

export interface TimelinePiece {
  label: string
  url: string
  /** Play this source range (seconds). end <= start means "to the end". */
  start: number
  end: number
  /** Audio gain for this piece, dB (0 = untouched). */
  gainDb?: number
}

export interface RenderTimelineOptions {
  width: number
  height: number
  fades: boolean
  fadeSec?: number
  onProgress?: (msg: string) => void
  isCancelled?: () => boolean
}

export interface RenderedTimeline {
  blob: Blob
  durationSec: number
}

export class RenderCancelled extends Error {
  constructor() { super('Render cancelled') }
}

const DEFAULT_FADE_SEC = 0.4

function loadVideo(url: string, label: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.src = url
    video.playsInline = true
    video.crossOrigin = 'anonymous'
    video.onloadedmetadata = () => resolve(video)
    video.onerror = () => reject(new Error(
      `Could not load "${label}". If it is a codec this browser cannot play (for example HEVC from an iPhone export), convert it to H.264 MP4 and import it again.`,
    ))
  })
}

export async function renderTimeline(
  pieces: TimelinePiece[],
  opts: RenderTimelineOptions,
): Promise<RenderedTimeline> {
  if (!pieces.length) throw new Error('Nothing to render — pick a body clip first.')
  const fadeSec = opts.fadeSec ?? DEFAULT_FADE_SEC
  const cancelled = () => opts.isCancelled?.() ?? false

  const canvas = document.createElement('canvas')
  canvas.width = opts.width
  canvas.height = opts.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const audioCtx = new AudioContext()
  await audioCtx.resume().catch(() => {})
  const audioDest = audioCtx.createMediaStreamDestination()

  const canvasStream = canvas.captureStream(30)
  const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks(), ...audioDest.stream.getAudioTracks()]
  const mimeType = pickMimeType()
  const rec = new MediaRecorder(new MediaStream(tracks), {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 128_000,
  })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  const stopped = new Promise<void>((res) => { rec.onstop = () => res() })
  rec.start(500)

  let totalSec = 0
  try {
    for (let idx = 0; idx < pieces.length; idx++) {
      const piece = pieces[idx]
      if (cancelled()) throw new RenderCancelled()
      opts.onProgress?.(`Rendering clip ${idx + 1} of ${pieces.length}: ${piece.label}`)
      const video = await loadVideo(piece.url, piece.label)

      try {
        const src = audioCtx.createMediaElementSource(video)
        if (piece.gainDb) {
          const gain = audioCtx.createGain()
          gain.gain.value = Math.pow(10, piece.gainDb / 20)
          src.connect(gain)
          gain.connect(audioDest)
        } else {
          src.connect(audioDest)
        }
      } catch { /* silent clip (the brand cards are): keep going */ }

      const start = Math.max(0, piece.start || 0)
      const end = piece.end > start ? piece.end : (video.duration || 0)
      const dur = Math.max(0, end - start)
      totalSec += dur

      // Fit inside the canvas, centred, black around it — never crop.
      const vw = video.videoWidth || canvas.width
      const vh = video.videoHeight || canvas.height
      const scale = Math.min(canvas.width / vw, canvas.height / vh)
      const dw = Math.round(vw * scale)
      const dh = Math.round(vh * scale)
      const dx = Math.round((canvas.width - dw) / 2)
      const dy = Math.round((canvas.height - dh) / 2)

      video.currentTime = start
      await new Promise<void>((res) => { video.onseeked = () => res() })
      await video.play()
      await new Promise<void>((res, rej) => {
        const frame = () => {
          if (cancelled()) { rej(new RenderCancelled()); return }
          if (video.currentTime >= end || video.ended) { res(); return }
          if (!video.paused) {
            ctx.fillStyle = '#000'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.drawImage(video, dx, dy, dw, dh)
            if (opts.fades && dur > 0.05) {
              const t = video.currentTime - start
              const aIn = Math.min(1, t / fadeSec)
              const aOut = Math.min(1, (dur - t) / fadeSec)
              const alpha = 1 - Math.min(aIn, aOut)
              if (alpha > 0) {
                ctx.fillStyle = `rgba(0,0,0,${alpha.toFixed(3)})`
                ctx.fillRect(0, 0, canvas.width, canvas.height)
              }
            }
          }
          requestAnimationFrame(frame)
        }
        frame()
      })
      video.pause()
    }
  } catch (e) {
    rec.stop()
    await stopped
    await audioCtx.close().catch(() => {})
    throw e
  }

  rec.stop()
  await stopped
  await audioCtx.close().catch(() => {})
  const blob = new Blob(chunks, { type: mimeType || 'video/webm' })
  return { blob, durationSec: totalSec }
}

/* ------------------------------------------------------------------ */
/* Take Rescue composite                                               */
/*                                                                     */
/* A layered sibling of the sequential renderer above, in the same     */
/* module so it shares the loader, the recorder scaffolding and the    */
/* cancel convention: the broken take plays as the MASTER — its audio  */
/* is the soundtrack and its clock drives the render — while a         */
/* replacement visual track (a clean capture, or a stills slideshow)   */
/* fills the frame, fit-on-black like every Finish clip, and the       */
/* facecam region is lifted out of the master and drawn back into the  */
/* corner it was burned into.                                          */
/* ------------------------------------------------------------------ */

export interface RescueCropFractions {
  x: number
  y: number
  w: number
  h: number
}

export type RescueBase =
  | { kind: 'video'; url: string; label: string; offsetSec: number }
  | { kind: 'slideshow'; images: { url: string; durationSec: number }[]; kenBurns: boolean }

export type RescueOverlay =
  | { kind: 'crop'; rect: RescueCropFractions }
  | { kind: 'inset'; rect: RescueCropFractions }
  | { kind: 'none' }

export interface RescueCompositeOptions {
  masterUrl: string
  masterLabel: string
  /** Render length in seconds; <= 0 means "the master video's own duration". */
  durationSec: number
  base: RescueBase
  overlay: RescueOverlay
  width: number
  height: number
  fades: boolean
  onProgress?: (msg: string) => void
  isCancelled?: () => boolean
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load one of the slideshow images — re-add it and render again.'))
    img.src = url
  })
}

/** Draw a source fit (contain) inside the whole canvas, centred, with an
    optional pixel shift — the Finish conform rule: never crop. */
function drawFit(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sw: number,
  sh: number,
  W: number,
  H: number,
  shiftX: number,
  shiftY: number,
) {
  if (!(sw > 0) || !(sh > 0)) return
  const scale = Math.min(W / sw, H / sh)
  const dw = Math.round(sw * scale)
  const dh = Math.round(sh * scale)
  ctx.drawImage(source, Math.round((W - dw) / 2 + shiftX), Math.round((H - dh) / 2 + shiftY), dw, dh)
}

/** Draw a source fit (contain) inside an arbitrary rect. */
function drawFitIn(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  if (!(sw > 0) || !(sh > 0)) return
  const scale = Math.min(dw / sw, dh / sh)
  const w = Math.round(sw * scale)
  const h = Math.round(sh * scale)
  ctx.drawImage(source, Math.round(dx + (dw - w) / 2), Math.round(dy + (dh - h) / 2), w, h)
}

export async function renderRescueComposite(opts: RescueCompositeOptions): Promise<RenderedTimeline> {
  const cancelled = () => opts.isCancelled?.() ?? false
  const base = opts.base
  const overlay = opts.overlay

  const canvas = document.createElement('canvas')
  canvas.width = opts.width
  canvas.height = opts.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const audioCtx = new AudioContext()
  await audioCtx.resume().catch(() => {})
  const audioDest = audioCtx.createMediaStreamDestination()

  // The broken take is the master: its audio is routed to the mix and its
  // playback clock drives the whole render.
  const master = await loadVideo(opts.masterUrl, opts.masterLabel)
  const mediaDur = Number.isFinite(master.duration) && master.duration > 0 ? master.duration : 0
  const total = opts.durationSec > 0 ? opts.durationSec : mediaDur
  if (!(total > 0)) {
    await audioCtx.close().catch(() => {})
    throw new Error('Could not read the broken take\'s length — Rescue needs its duration to sync the replacement visuals against.')
  }
  try {
    const src = audioCtx.createMediaElementSource(master)
    src.connect(audioDest)
  } catch { /* no readable audio track: the render is picture-only */ }

  // Replacement visual track.
  let baseVideo: HTMLVideoElement | null = null
  const baseOffset = base.kind === 'video' ? base.offsetSec : 0
  const baseDelay = Math.max(0, -baseOffset)
  let baseStarted = false
  if (base.kind === 'video') {
    baseVideo = await loadVideo(base.url, base.label)
    baseVideo.muted = true // the master's narration is the soundtrack, in every mode
  }
  let images: HTMLImageElement[] = []
  let slideEnds: number[] = [] // cumulative end time of each still
  if (base.kind === 'slideshow') {
    images = await Promise.all(base.images.map((i) => loadImage(i.url)))
    let acc = 0
    slideEnds = base.images.map((i) => (acc += Math.max(0.1, i.durationSec)))
  }

  const canvasStream = canvas.captureStream(30)
  const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks(), ...audioDest.stream.getAudioTracks()]
  const mimeType = pickMimeType()
  const rec = new MediaRecorder(new MediaStream(tracks), {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 128_000,
  })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  const stopped = new Promise<void>((res) => { rec.onstop = () => res() })
  rec.start(500)

  let renderedSec = 0
  try {
    master.currentTime = 0
    await new Promise<void>((res) => { master.onseeked = () => res() })
    if (baseVideo && baseDelay === 0) {
      baseVideo.currentTime = Math.max(0, baseOffset)
      await new Promise<void>((res) => { baseVideo!.onseeked = () => res() })
      await baseVideo.play().catch(() => {})
      baseStarted = true
    }
    await master.play()

    let lastProgressAt = -1
    await new Promise<void>((res, rej) => {
      const frame = () => {
        if (cancelled()) { rej(new RenderCancelled()); return }
        const t = master.currentTime || 0
        renderedSec = Math.max(renderedSec, Math.min(t, total))
        if (t >= total || master.ended) { res(); return }

        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        // Base: replacement visuals, fit-on-black, never cropped.
        if (base.kind === 'video' && baseVideo) {
          if (!baseStarted && t >= baseDelay) {
            baseStarted = true
            baseVideo.currentTime = 0
            void baseVideo.play().catch(() => {})
          }
          // A replacement that ends early simply holds its last frame —
          // the UI warns about that before the render starts.
          if (baseVideo.readyState >= 2) {
            drawFit(ctx, baseVideo, baseVideo.videoWidth, baseVideo.videoHeight, canvas.width, canvas.height, 0, 0)
          }
        } else if (base.kind === 'slideshow' && images.length) {
          let idx = slideEnds.findIndex((end) => t < end)
          if (idx < 0) idx = images.length - 1 // stills ran out: hold the last one
          const start = idx === 0 ? 0 : slideEnds[idx - 1]
          const dur = Math.max(0.1, slideEnds[idx] - start)
          const p = Math.min(1, Math.max(0, (t - start) / dur))
          let shiftX = 0
          let shiftY = 0
          if (base.kenBurns) {
            // Gentle drift only — the still stays fully visible inside the
            // frame (fit-on-black), it just doesn't sit perfectly still.
            const dir = idx % 2 === 0 ? 1 : -1
            shiftX = (p - 0.5) * canvas.width * 0.03 * dir
            shiftY = (p - 0.5) * canvas.height * 0.015 * dir
          }
          const img = images[idx]
          drawFit(ctx, img, img.naturalWidth, img.naturalHeight, canvas.width, canvas.height, shiftX, shiftY)
        }

        // Overlay: the facecam lifted out of the master, drawn back into
        // the corner it was burned into (same rounded box + teal border
        // the compositor draws). 'inset' shows the whole master frame
        // shrunk into that box instead of just the cropped region.
        if (overlay.kind !== 'none' && master.readyState >= 2 && master.videoWidth > 0) {
          const r = overlay.rect
          const dx = Math.round(r.x * canvas.width)
          const dy = Math.round(r.y * canvas.height)
          const dw = Math.max(8, Math.round(r.w * canvas.width))
          const dh = Math.max(8, Math.round(r.h * canvas.height))
          const radius = Math.round(dw * 0.06)
          ctx.save()
          ctx.shadowColor = 'rgba(0,0,0,0.45)'
          ctx.shadowBlur = 24
          ctx.shadowOffsetY = 8
          roundRect(ctx, dx, dy, dw, dh, radius)
          ctx.fillStyle = '#000'
          ctx.fill()
          ctx.restore()
          ctx.save()
          roundRect(ctx, dx, dy, dw, dh, radius)
          ctx.clip()
          if (overlay.kind === 'crop') {
            ctx.drawImage(
              master,
              r.x * master.videoWidth, r.y * master.videoHeight,
              r.w * master.videoWidth, r.h * master.videoHeight,
              dx, dy, dw, dh,
            )
          } else {
            drawFitIn(ctx, master, master.videoWidth, master.videoHeight, dx, dy, dw, dh)
          }
          ctx.restore()
          roundRect(ctx, dx, dy, dw, dh, radius)
          ctx.lineWidth = Math.max(2, canvas.width * 0.002)
          ctx.strokeStyle = '#14b8a6'
          ctx.stroke()
        }

        // Same fade envelope as the sequential renderer: in at the head,
        // out at the tail.
        if (opts.fades) {
          const aIn = Math.min(1, t / DEFAULT_FADE_SEC)
          const aOut = Math.min(1, Math.max(0, total - t) / DEFAULT_FADE_SEC)
          const alpha = 1 - Math.min(aIn, aOut)
          if (alpha > 0) {
            ctx.fillStyle = `rgba(0,0,0,${alpha.toFixed(3)})`
            ctx.fillRect(0, 0, canvas.width, canvas.height)
          }
        }

        if (t - lastProgressAt >= 1) {
          lastProgressAt = t
          opts.onProgress?.(`Rendering rescued take… ${Math.min(99, Math.round((t / total) * 100))}%`)
        }
        requestAnimationFrame(frame)
      }
      frame()
    })
  } catch (e) {
    rec.stop()
    await stopped
    await audioCtx.close().catch(() => {})
    master.pause()
    baseVideo?.pause()
    throw e
  }

  master.pause()
  baseVideo?.pause()
  rec.stop()
  await stopped
  await audioCtx.close().catch(() => {})
  const blob = new Blob(chunks, { type: mimeType || 'video/webm' })
  return { blob, durationSec: renderedSec > 0 ? renderedSec : total }
}
