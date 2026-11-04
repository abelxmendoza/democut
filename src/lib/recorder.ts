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

const PIP_SCALE: Record<PipSize, number> = { s: 0.16, m: 0.22, l: 0.3 }

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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

export class Compositor {
  canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private raf = 0
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

  start() {
    const draw = () => {
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
        this.raf = requestAnimationFrame(draw)
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

      this.raf = requestAnimationFrame(draw)
    }
    draw()
  }

  stream(): MediaStream {
    return this.canvas.captureStream(this.opts.fps)
  }

  stop() {
    cancelAnimationFrame(this.raf)
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
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ]
  return candidates.find((c) => window.MediaRecorder?.isTypeSupported(c)) ?? ''
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
