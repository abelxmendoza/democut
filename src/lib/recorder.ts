// DemoCut compositing engine
// Draws the screen capture full-frame and the webcam as a rounded
// picture-in-picture in the TOP-RIGHT corner, on a single canvas.
// That canvas stream (+ mic / screen audio) is what MediaRecorder records,
// so the exported .webm already has your face burned in — no editing step.

export type PipSize = 's' | 'm' | 'l'
export type Quality = '720p' | '1080p'

/** What the take is recorded from:
    'screen-camera' — screen full-frame + facecam PiP (the original mode)
    'screen-only'   — screen only, no camera is ever requested
    'camera-only'   — camera full-frame, no screen share (talking-head takes) */
export type SourceMode = 'screen-camera' | 'screen-only' | 'camera-only'

export interface RecordOptions {
  quality: Quality
  fps: 30 | 60
  pipSize: PipSize
  cameraOn: boolean
  micOn: boolean
  mirrorCamera: boolean
  /** Recording source. Defaults to 'screen-camera' when omitted. */
  mode?: SourceMode
  /** Name shown in a teal tag above the facecam (blank = no tag).
      In camera-only mode the tag sits at the bottom-left of the frame. */
  nameTag?: string
}

export const PIP_SCALE: Record<PipSize, number> = { s: 0.16, m: 0.22, l: 0.3 }

export interface FrameRect { x: number; y: number; w: number; h: number }

/** Where the compositor puts the facecam PiP (and its name tag) in a frame
    of the given size — exported so Take Rescue can locate the facecam that
    older takes burned into the corner. Mirrors Compositor.drawFrame()
    exactly: same PIP_SCALE fractions, same margin (1.8% of frame width),
    same 4:3 camera box, and the name-tag allowance (tag directly above
    the PiP, same width; tag height from the nominal font size — a very
    long name shrinks the font, and therefore the tag, in drawFrame; this
    is the un-shrunk case and Rescue's manual sliders absorb the rest). */
export function pipGeometry(
  frameW: number,
  frameH: number,
  size: PipSize,
  hasNameTag: boolean,
): { pip: FrameRect; tag: FrameRect | null; margin: number } {
  void frameH // all compositor geometry is width-derived; height kept for call-site clarity
  const margin = Math.round(frameW * 0.018)
  const pipW = Math.round(frameW * PIP_SCALE[size])
  const pipH = Math.round((pipW * 3) / 4) // 4:3 camera box
  const x = frameW - pipW - margin
  let y = margin
  let tag: FrameRect | null = null
  if (hasNameTag) {
    const fontPx = Math.round(pipW * 0.088)
    const tagH = Math.round(fontPx * 1.75)
    const gap = Math.round(frameW * 0.006)
    tag = { x, y: margin, w: pipW, h: tagH }
    y = margin + tagH + gap
  }
  return { pip: { x, y, w: pipW, h: pipH }, tag, margin }
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** Draw a video cover-fit into a box (crop to fill, never stretch),
    optionally mirrored around the box's vertical centre line. */
function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number, y: number, w: number, h: number,
  mirror: boolean,
) {
  const vw = video.videoWidth || 640
  const vh = video.videoHeight || 480
  const scale = Math.max(w / vw, h / vh)
  const dw = vw * scale
  const dh = vh * scale
  const dx = x + (w - dw) / 2
  const dy = y + (h - dh) / 2
  ctx.save()
  if (mirror) {
    ctx.translate(x + w / 2, 0)
    ctx.scale(-1, 1)
    ctx.translate(-(x + w / 2), 0)
  }
  ctx.drawImage(video, dx, dy, dw, dh)
  ctx.restore()
}

/** A draw clock that keeps ticking while the window is hidden.
    requestAnimationFrame stops entirely when the DemoCut window is
    minimised, on another workspace, or fully covered — which is exactly
    where it sits while you demo another app fullscreen — and the canvas
    (and therefore the recording) froze for those whole stretches.
    A dedicated worker's timers are not tied to page visibility, so the
    compositor draws on worker ticks and falls back to rAF only if a
    worker cannot be created. Returns a stop function, or null. */
function createWorkerClock(intervalMs: number, onTick: () => void): (() => void) | null {
  try {
    const code = `setInterval(() => postMessage(0), ${Math.max(8, Math.round(intervalMs))})`
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
    const worker = new Worker(url)
    worker.onmessage = () => onTick()
    worker.onerror = () => {}
    return () => {
      worker.terminate()
      URL.revokeObjectURL(url)
    }
  } catch {
    return null
  }
}

export class Compositor {
  canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private raf = 0
  private clockStop: (() => void) | null = null
  private backupIv: ReturnType<typeof setInterval> | null = null
  private lastDrawAt = 0
  private screenVideo: HTMLVideoElement | null = null
  private camVideo: HTMLVideoElement | null = null
  opts: RecordOptions

  constructor(opts: RecordOptions) {
    this.opts = opts
    this.canvas = document.createElement('canvas')
    this.canvas.width = opts.quality === '1080p' ? 1920 : 1280
    this.canvas.height = opts.quality === '1080p' ? 1080 : 720
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D not available')
    this.ctx = ctx
  }

  /** Point the compositor at a (new) screen stream. Safe to call mid-recording:
      the canvas stream the recorder is consuming never changes, only its source. */
  setScreenStream(screenStream: MediaStream) {
    const video = document.createElement('video')
    video.srcObject = screenStream
    video.muted = true
    void video.play()
    this.screenVideo = video
    const track = screenStream.getVideoTracks()[0]
    const s = track?.getSettings()
    if (s?.width && s?.height) {
      // Keep the canvas at the screen's real aspect/size (capped at target quality)
      const cap = this.opts.quality === '1080p' ? 1920 : 1280
      const scale = Math.min(1, cap / s.width)
      this.canvas.width = Math.round(s.width * scale)
      this.canvas.height = Math.round(s.height * scale)
    }
  }

  /** Point the compositor at a (new) camera stream — used at setup and when
      the user picks a different camera while previewing. The canvas stream
      the recorder consumes never changes, only its source. */
  setCameraStream(camStream: MediaStream) {
    const video = document.createElement('video')
    video.srcObject = camStream
    video.muted = true
    void video.play()
    this.camVideo?.pause()
    this.camVideo = video
  }

  attach(screenStream: MediaStream | null, camStream: MediaStream | null) {
    if (screenStream) this.setScreenStream(screenStream)
    if (camStream) this.setCameraStream(camStream)
  }

  private drawFrame() {
      this.lastDrawAt = performance.now()
      // A source <video> that isn't in the DOM can get paused by the browser
      // while the window is covered/hidden; drawImage of a paused video just
      // repeats its last frame, which also reads as a freeze. Revive any
      // paused source — play() on a live capture stream resumes immediately.
      if (this.screenVideo?.paused) void this.screenVideo.play().catch(() => {})
      if (this.camVideo?.paused) void this.camVideo.play().catch(() => {})
      const { ctx, canvas } = this
      const W = canvas.width
      const H = canvas.height
      ctx.fillStyle = '#0b0f14'
      ctx.fillRect(0, 0, W, H)

      // Camera-only: the camera IS the frame. The canvas keeps the selected
      // quality's dimensions (no screen stream ever resizes it), so a
      // camera take stitches cleanly with screen takes in the editor.
      if (this.opts.mode === 'camera-only') {
        if (this.camVideo && this.camVideo.readyState >= 2) {
          drawCover(ctx, this.camVideo, 0, 0, W, H, this.opts.mirrorCamera)
        } else {
          ctx.fillStyle = '#94a3b8'
          ctx.font = `${Math.round(H * 0.035)}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.fillText('Waiting for camera…', W / 2, H / 2)
        }
        // Name tag: same teal tag as the facecam's, bottom-left of the frame
        const name = (this.opts.nameTag ?? '').trim()
        if (name && this.camVideo && this.camVideo.readyState >= 2) {
          let fontPx = Math.round(H * 0.034)
          ctx.font = `800 ${fontPx}px system-ui, -apple-system, 'Segoe UI', sans-serif`
          const textW = ctx.measureText(name).width
          const maxTextW = W * 0.6
          if (textW > maxTextW) {
            fontPx = Math.max(10, Math.floor(fontPx * (maxTextW / textW)))
            ctx.font = `800 ${fontPx}px system-ui, -apple-system, 'Segoe UI', sans-serif`
          }
          const padX = Math.round(fontPx * 0.7)
          const tagW = Math.ceil(ctx.measureText(name).width) + padX * 2
          const tagH = Math.round(fontPx * 1.75)
          const margin = Math.round(W * 0.018)
          roundRect(ctx, margin, H - margin - tagH, tagW, tagH, Math.round(tagH * 0.28))
          ctx.fillStyle = '#14b8a6'
          ctx.fill()
          ctx.fillStyle = '#000000'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(name, margin + tagW / 2, H - margin - tagH / 2 + 1)
          ctx.textBaseline = 'alphabetic'
        }
        return
      }

      if (this.screenVideo && this.screenVideo.readyState >= 2) {
        ctx.drawImage(this.screenVideo, 0, 0, W, H)
      } else {
        ctx.fillStyle = '#94a3b8'
        ctx.font = `${Math.round(H * 0.035)}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText('Waiting for screen share…', W / 2, H / 2)
      }

      // Facecam PiP — top right
      if (this.opts.cameraOn && this.camVideo && this.camVideo.readyState >= 2) {
        const pipW = Math.round(W * PIP_SCALE[this.opts.pipSize])
        const pipH = Math.round((pipW * 3) / 4) // 4:3 camera box
        const margin = Math.round(W * 0.018)
        const x = W - pipW - margin
        const radius = Math.round(pipW * 0.06)

        // Name tag: a teal box with the name in black, directly above the
        // facecam, same width as the facecam box. The PiP shifts down to
        // make room; with no name set, nothing changes.
        const name = (this.opts.nameTag ?? '').trim()
        let y = margin
        if (name) {
          let fontPx = Math.round(pipW * 0.088)
          ctx.font = `800 ${fontPx}px system-ui, -apple-system, 'Segoe UI', sans-serif`
          const textW = ctx.measureText(name).width
          const maxTextW = pipW - Math.round(pipW * 0.1)
          if (textW > maxTextW) {
            fontPx = Math.max(10, Math.floor(fontPx * (maxTextW / textW)))
            ctx.font = `800 ${fontPx}px system-ui, -apple-system, 'Segoe UI', sans-serif`
          }
          const tagH = Math.round(fontPx * 1.75)
          const gap = Math.round(W * 0.006)
          roundRect(ctx, x, margin, pipW, tagH, Math.round(tagH * 0.28))
          ctx.fillStyle = '#14b8a6'
          ctx.fill()
          ctx.fillStyle = '#000000'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(name, x + pipW / 2, margin + tagH / 2 + 1)
          ctx.textBaseline = 'alphabetic'
          y = margin + tagH + gap
        }

        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.45)'
        ctx.shadowBlur = 24
        ctx.shadowOffsetY = 8
        roundRect(ctx, x, y, pipW, pipH, radius)
        ctx.fillStyle = '#000'
        ctx.fill()
        ctx.restore()

        ctx.save()
        roundRect(ctx, x, y, pipW, pipH, radius)
        ctx.clip()
        // cover-fit the camera into the box
        drawCover(ctx, this.camVideo, x, y, pipW, pipH, this.opts.mirrorCamera)
        ctx.restore()

        // border
        roundRect(ctx, x, y, pipW, pipH, radius)
        ctx.lineWidth = Math.max(2, W * 0.002)
        ctx.strokeStyle = '#14b8a6'
        ctx.stroke()
      }

  }

  start() {
    // Draw one frame immediately, then keep drawing on the worker clock
    // (rAF fallback) so frames keep flowing while the window is hidden —
    // see createWorkerClock above.
    this.drawFrame()
    this.clockStop = createWorkerClock(1000 / this.opts.fps, () => this.drawFrame())
    if (!this.clockStop) {
      const loop = () => {
        this.drawFrame()
        this.raf = requestAnimationFrame(loop)
      }
      this.raf = requestAnimationFrame(loop)
    }
    // Watchdog backup clock: if the primary clock ever stalls (worker
    // killed, browser throttles worker messages to a hidden page harder
    // than expected), a plain interval still gets ~1 tick/sec in a hidden
    // tab — enough to keep the recording moving at low fps instead of
    // freezing solid until the window comes back.
    this.backupIv = setInterval(() => {
      if (performance.now() - this.lastDrawAt > 900) this.drawFrame()
    }, 400)
  }

  stream(): MediaStream {
    return this.canvas.captureStream(this.opts.fps)
  }

  stop() {
    cancelAnimationFrame(this.raf)
    this.clockStop?.()
    this.clockStop = null
    if (this.backupIv) { clearInterval(this.backupIv); this.backupIv = null }
    this.screenVideo?.pause()
    this.camVideo?.pause()
  }
}

export async function getScreenStream(quality: Quality, fps: number, micOn: boolean): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: quality === '1080p' ? 1920 : 1280 },
      height: { ideal: quality === '1080p' ? 1080 : 720 },
      frameRate: { ideal: fps },
      // Prefer the ENTIRE MONITOR: that's the surface that follows you when
      // you switch apps/windows. A single window/tab can only ever show itself.
      displaySurface: 'monitor',
    },
    audio: true, // system / tab audio where the browser supports it
    // Chrome: keep the "share another surface instead" affordance available
    surfaceSwitching: 'include',
    selfBrowserSurface: 'include',
  } as DisplayMediaStreamOptions)
  return stream
}

/** What kind of surface is being captured: 'monitor' follows the user across
    apps/windows; 'window' / 'browser' are locked to that one surface. */
export function captureSurface(stream: MediaStream | null): string {
  const track = stream?.getVideoTracks()[0]
  const surface = track?.getSettings()?.displaySurface
  return typeof surface === 'string' ? surface : 'unknown'
}

export async function getCameraStream(
  micOn: boolean,
  opts: { deviceId?: string; quality?: Quality } = {},
): Promise<MediaStream> {
  // A full-frame (camera-only) take asks the camera for the take's own
  // resolution; the facecam PiP only needs 720p.
  const full = opts.quality !== undefined
  const width = full && opts.quality === '1080p' ? 1920 : 1280
  const height = full && opts.quality === '1080p' ? 1080 : 720
  return navigator.mediaDevices.getUserMedia({
    video: opts.deviceId
      ? { deviceId: { exact: opts.deviceId }, width: { ideal: width }, height: { ideal: height } }
      : { width: { ideal: width }, height: { ideal: height }, facingMode: 'user' },
    audio: micOn
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : false,
  })
}

/** Mic only — for screen-only mode, where no camera may be requested but
    the narration mic still comes from getUserMedia. */
export async function getMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: false,
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
}

/** Video input devices. Labels are only populated after camera permission
    has been granted once; before that they come back blank. */
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'videoinput')
}

export function pickMimeType(): string {
  // Order matters for smoothness: MediaRecorder's VP9 encoding is
  // software-only in practice and saturates the CPU at 720p/1080p next to
  // the canvas compositing, which showed up as frozen/dropped frames.
  // H.264-in-MP4 is hardware-encoded on most platforms that offer it,
  // VP8 is far cheaper than VP9, so VP9 is now the last resort.
  const candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ]
  return candidates.find((c) => window.MediaRecorder?.isTypeSupported(c)) ?? ''
}

/** MediaRecorder writes WebM as a live stream and never goes back to fill
    in the total length: Chromium's muxer OMITS the Segment Info Duration
    element entirely (verified against a real recording's header bytes,
    2026-11-04 — Info holds only TimecodeScale + MuxingApp + WritingApp),
    and other muxers write it as 0. Either way players and editors report
    the take as empty, endless, or cut short even though every frame is in
    the file — the "it didn't capture the whole video" symptom.
    Fix: if a float Duration element exists inside Info and reads 0,
    overwrite it (8-byte or 4-byte encoding); if Info has NO Duration,
    insert one — Chromium writes the Segment with an unknown size, so
    growing Info by the 11-byte element is safe as long as Info's own
    size field (and a known Segment size, if any) is bumped to match.
    The search is confined to Info's declared extent — a 0x44 0x89 byte
    pair elsewhere is compressed frame data, not an element. Duration is
    expressed in the file's own TimecodeScale units (spec default
    1,000,000 = 1 unit per ms). Any parse surprise returns the original
    blob untouched. */
export async function fixWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (!blob.type.includes('webm') || !(durationMs > 0)) return blob
  try {
    const buf = new Uint8Array(await blob.arrayBuffer())
    const limit = Math.min(buf.length, 256 * 1024)
    const find = (bytes: number[], from: number, to: number): number => {
      outer: for (let i = from; i + bytes.length <= to; i++) {
        for (let j = 0; j < bytes.length; j++) if (buf[i + j] !== bytes[j]) continue outer
        return i
      }
      return -1
    }
    // EBML variable-length size: the position of the first set bit in the
    // leading byte gives the width (1–8); the remaining bits are the value,
    // with all-data-bits-set meaning "unknown size".
    const readVint = (idx: number): { width: number; value: bigint; unknown: boolean } | null => {
      const b = buf[idx]
      if (!b) return null
      let width = 1
      let mask = 0x80
      while (width <= 8 && !(b & mask)) { mask >>= 1; width++ }
      if (width > 8 || idx + width > buf.length) return null
      let value = BigInt(b & (mask - 1))
      for (let k = 1; k < width; k++) value = (value << 8n) | BigInt(buf[idx + k])
      return { width, value, unknown: value === (1n << BigInt(7 * width)) - 1n }
    }
    const writeVint = (target: Uint8Array, idx: number, width: number, value: bigint) => {
      for (let k = width - 1; k >= 0; k--) { target[idx + k] = Number(value & 0xffn); value >>= 8n }
      target[idx] |= 1 << (8 - width) // restore the width marker bit
    }

    const infoIdx = find([0x15, 0x49, 0xa9, 0x66], 0, limit) // Segment > Info
    if (infoIdx < 0) return blob
    const infoSize = readVint(infoIdx + 4)
    if (!infoSize || infoSize.unknown) return blob
    const infoStart = infoIdx + 4 + infoSize.width
    const infoEnd = infoStart + Number(infoSize.value)
    if (infoEnd > buf.length) return blob

    // Duration is expressed in TimecodeScale units (Info > TimecodeScale,
    // an unsigned int; spec default 1,000,000 = 1 unit per ms). Read the
    // muxer's actual scale when present instead of assuming Chrome's.
    let scale = 1_000_000
    const scaleIdx = find([0x2a, 0xd7, 0xb1], infoStart, infoEnd) // Info > TimecodeScale
    if (scaleIdx >= 0) {
      const sizeByte = buf[scaleIdx + 3]
      const len = sizeByte & 0x7f
      if (sizeByte >= 0x81 && sizeByte <= 0x88 && scaleIdx + 4 + len <= infoEnd) {
        let v = 0
        for (let k = 0; k < len; k++) v = v * 256 + buf[scaleIdx + 4 + k]
        if (v > 0) scale = v
      }
    }
    const value = durationMs * (1_000_000 / scale)

    const durIdx = find([0x44, 0x89], infoStart, infoEnd) // Info > Duration
    if (durIdx >= 0) {
      const sizeByte = buf[durIdx + 2]
      if (sizeByte === 0x88 && durIdx + 11 <= infoEnd) {
        // 8-byte float
        const view = new DataView(buf.buffer, buf.byteOffset + durIdx + 3, 8)
        if (view.getFloat64(0, false) > 0) return blob // already has a duration
        view.setFloat64(0, value, false)
      } else if (sizeByte === 0x84 && durIdx + 7 <= infoEnd) {
        // 4-byte float (some muxers, incl. Firefox-style EBML writers)
        const view = new DataView(buf.buffer, buf.byteOffset + durIdx + 3, 4)
        if (view.getFloat32(0, false) > 0) return blob
        view.setFloat32(0, value, false)
      } else {
        return blob
      }
      return new Blob([buf], { type: blob.type })
    }

    // No Duration element: insert one at the end of Info. Both Info's size
    // and (if it is a known size) the Segment's must grow by the element's
    // 11 bytes, re-encoded at their original vint widths.
    const ELEN = 11
    const newInfoSize = infoSize.value + BigInt(ELEN)
    if (newInfoSize >= (1n << BigInt(7 * infoSize.width)) - 1n) return blob
    const segIdx = find([0x18, 0x53, 0x80, 0x67], 0, infoIdx) // Segment
    let segSize: ReturnType<typeof readVint> = null
    let newSegSize = 0n
    if (segIdx >= 0) {
      segSize = readVint(segIdx + 4)
      if (segSize && !segSize.unknown) {
        newSegSize = segSize.value + BigInt(ELEN)
        if (newSegSize >= (1n << BigInt(7 * segSize.width)) - 1n) return blob
      }
    }
    const out = new Uint8Array(buf.length + ELEN)
    out.set(buf.subarray(0, infoEnd), 0)
    out[infoEnd] = 0x44; out[infoEnd + 1] = 0x89; out[infoEnd + 2] = 0x88
    new DataView(out.buffer, infoEnd + 3, 8).setFloat64(0, value, false)
    out.set(buf.subarray(infoEnd), infoEnd + ELEN)
    writeVint(out, infoIdx + 4, infoSize.width, newInfoSize)
    if (segSize && !segSize.unknown && segIdx >= 0) writeVint(out, segIdx + 4, segSize.width, newSegSize)
    return new Blob([out], { type: blob.type })
  } catch {
    return blob
  }
}

export interface TakeMarker {
  /** seconds into the take */
  t: number
  label: string
}

export interface CaptionCue {
  /** seconds into the take */
  start: number
  end: number
  text: string
}

export interface Take {
  id: string
  url: string
  blob: Blob
  name: string
  duration: number
  size: number
  createdAt: Date
  projectId: string
  markers?: TakeMarker[]
  captions?: CaptionCue[]
}

export function formatTime(totalSeconds: number): string {
  const s = Math.floor(totalSeconds % 60)
  const m = Math.floor((totalSeconds / 60) % 60)
  const h = Math.floor(totalSeconds / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
