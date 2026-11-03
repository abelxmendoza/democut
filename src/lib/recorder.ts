// DemoCut compositing engine
// Draws the screen capture full-frame and the webcam as a rounded
// picture-in-picture in the TOP-RIGHT corner, on a single canvas.
// That canvas stream (+ mic / screen audio) is what MediaRecorder records,
// so the exported .webm already has your face burned in — no editing step.

export type PipSize = 's' | 'm' | 'l'
export type Quality = '720p' | '1080p'

export interface RecordOptions {
  quality: Quality
  fps: 30 | 60
  pipSize: PipSize
  cameraOn: boolean
  micOn: boolean
  mirrorCamera: boolean
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

  attach(screenStream: MediaStream | null, camStream: MediaStream | null) {
    if (screenStream) {
      this.screenVideo = document.createElement('video')
      this.screenVideo.srcObject = screenStream
      this.screenVideo.muted = true
      void this.screenVideo.play()
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
    if (camStream) {
      this.camVideo = document.createElement('video')
      this.camVideo.srcObject = camStream
      this.camVideo.muted = true
      void this.camVideo.play()
    }
  }

  start() {
    const draw = () => {
      const { ctx, canvas } = this
      const W = canvas.width
      const H = canvas.height
      ctx.fillStyle = '#0b0f14'
      ctx.fillRect(0, 0, W, H)

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
        const y = margin
        const radius = Math.round(pipW * 0.06)

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
        const vw = this.camVideo.videoWidth || 640
        const vh = this.camVideo.videoHeight || 480
        // cover-fit the camera into the box
        const scale = Math.max(pipW / vw, pipH / vh)
        const dw = vw * scale
        const dh = vh * scale
        const dx = x + (pipW - dw) / 2
        const dy = y + (pipH - dh) / 2
        if (this.opts.mirrorCamera) {
          ctx.translate(x + pipW / 2, 0)
          ctx.scale(-1, 1)
          ctx.translate(-(x + pipW / 2), 0)
        }
        ctx.drawImage(this.camVideo, dx, dy, dw, dh)
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
    },
    audio: true, // system / tab audio where the browser supports it
  } as DisplayMediaStreamOptions)
  return stream
}

export async function getCameraStream(micOn: boolean): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: micOn
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : false,
  })
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
