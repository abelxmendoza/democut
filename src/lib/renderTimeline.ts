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

import { pickMimeType } from './recorder'

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
