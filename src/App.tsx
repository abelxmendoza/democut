import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Circle, Pause, Play, Square, Download, Trash2, Monitor, Video, VideoOff,
  Mic, MicOff, FileText, Zap, Clock3, Camera, Settings2, CheckCircle2, Clapperboard,
  Plus, Pencil, Check, ListOrdered, Captions, Copy, MonitorUp,
} from 'lucide-react'
import {
  Compositor, getScreenStream, getCameraStream, getMicStream, listCameras, pickMimeType, fixWebmDuration,
  formatTime, formatBytes, captureSurface, type PipSize, type Quality, type SourceMode, type Take, type TakeMarker,
} from './lib/recorder'
import { useHotkeys } from 'react-hotkeys-hook'
import { Upload } from 'lucide-react'
import Editor from './components/Editor'
import Review from './components/Review'
import { PRESETS, NEW_PROJECT_SCRIPT, type Project } from './lib/projects'
import { loadTakes, saveTake, deleteTake as idbDeleteTake, deleteTakesForProject } from './lib/takeStore'
import { transcribeTake, toSrt, toVtt, transcriptText } from './lib/captions'

type Phase = 'idle' | 'ready' | 'countdown' | 'recording' | 'paused'

const DEFAULT_SCRIPT = `1. Open on the problem — what breaks / what's slow today
2. Show the fix working, end to end, no cuts
3. Show the proof — test output, numbers, the actual record
4. Close: what it is, who it's for, what's next`

export default function App() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [count, setCount] = useState(3)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')

  const [quality, setQuality] = useState<Quality>('1080p')
  const [fps, setFps] = useState<30 | 60>(30)
  const [pipSize, setPipSize] = useState<PipSize>('m')
  const [cameraOn, setCameraOn] = useState(true)
  const [micOn, setMicOn] = useState(true)
  const [mirror, setMirror] = useState(true)
  // Recording source: screen + facecam, screen only, or camera only
  // (talking-head takes — no screen share is ever requested in that mode).
  const [sourceMode, setSourceModeState] = useState<SourceMode>(() => {
    const v = localStorage.getItem('democut-source-mode')
    return v === 'screen-only' || v === 'camera-only' ? v : 'screen-camera'
  })
  const setSourceMode = (m: SourceMode) => {
    setSourceModeState(m)
    localStorage.setItem('democut-source-mode', m)
  }
  // Whether the camera feeds the picture in the current mode: forced on for
  // camera-only, forced off for screen-only, the Camera toggle otherwise.
  const effCameraOn = sourceMode === 'camera-only' ? true : sourceMode === 'screen-only' ? false : cameraOn
  const setupLabel = sourceMode === 'camera-only' ? 'Set up camera' : sourceMode === 'screen-only' ? 'Set up screen' : 'Set up screen + camera'
  // Camera choice (multi-camera machines): '' = system default. Device list
  // is (re)read after a successful camera open, when labels become available.
  const [cameraId, setCameraIdState] = useState(() => localStorage.getItem('democut-camera-id') ?? '')
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const refreshCameras = useCallback(async () => {
    try { setCameras(await listCameras()) } catch { /* picker just stays hidden */ }
  }, [])
  const [nameTag, setNameTag] = useState(() => localStorage.getItem('democut-name-tag') ?? 'Abel Mendoza')
  const [micLevel, setMicLevel] = useState(0)
  const [surface, setSurface] = useState('unknown')

  // ---- Projects ----------------------------------------------------------
  // Built-in presets are starting templates; user projects are created in
  // the app. Everything persists in localStorage: user projects in full,
  // plus per-project script/title/name/openFirst edits for any project.
  const [projects, setProjects] = useState<Project[]>(() => {
    let user: Project[] = []
    let overrides: Record<string, Partial<Project>> = {}
    let legacyScript: string | null = null
    try {
      user = JSON.parse(localStorage.getItem('democut-user-projects') || '[]') as Project[]
      overrides = JSON.parse(localStorage.getItem('democut-project-overrides') || '{}') as Record<string, Partial<Project>>
      legacyScript = localStorage.getItem('democut-script')
    } catch { /* fresh start */ }
    const builtins = PRESETS.map((p) => {
      const base: Project = { ...p, builtin: true }
      const o = overrides[p.id]
      const merged = o ? { ...base, ...o, id: p.id, builtin: true } : base
      // migrate the pre-projects single saved script onto the generic project
      if (p.id === 'generic' && legacyScript && !o?.script) merged.script = legacyScript
      return merged
    })
    return [...builtins, ...user.map((u) => ({ ...u, builtin: false }))]
  })
  const [projectId, setProjectId] = useState(() => localStorage.getItem('democut-current-project') || 'generic')
  const project = projects.find((p) => p.id === projectId) ?? projects[0]
  const [renaming, setRenaming] = useState(false)

  // persist projects + the current selection
  useEffect(() => {
    try {
      localStorage.setItem('democut-user-projects', JSON.stringify(projects.filter((p) => !p.builtin)))
      const overrides: Record<string, Partial<Project>> = {}
      for (const p of projects) {
        if (!p.builtin) continue
        const base = PRESETS.find((x) => x.id === p.id)
        if (!base) continue
        const o: Partial<Project> = {}
        if (p.script !== base.script) o.script = p.script
        if (p.title !== base.title) o.title = p.title
        if (p.name !== base.name) o.name = p.name
        if (p.openFirst !== base.openFirst) o.openFirst = p.openFirst
        if (p.targetSec && p.targetSec !== 180) o.targetSec = p.targetSec
        if (Object.keys(o).length) overrides[p.id] = o
      }
      localStorage.setItem('democut-project-overrides', JSON.stringify(overrides))
      localStorage.setItem('democut-current-project', project.id)
    } catch { /* storage blocked/full: app still works in-session */ }
  }, [projects, project.id])

  const patchProject = (patch: Partial<Project>) =>
    setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, ...patch } : p)))

  const newProject = () => {
    const p: Project = {
      id: crypto.randomUUID(),
      name: 'Untitled project',
      title: 'Untitled project — Demo',
      openFirst: 'Open the app you are demoing, full-screen, at the screen you will start from.',
      script: NEW_PROJECT_SCRIPT,
      builtin: false,
    }
    setProjects((prev) => [...prev, p])
    setProjectId(p.id)
    setRenaming(true)
  }

  const removeProject = () => {
    if (project.builtin) return
    const n = takes.filter((t) => t.projectId === project.id).length
    const msg = n > 0
      ? `Delete "${project.name}" and its ${n} saved take${n === 1 ? '' : 's'}? This can't be undone.`
      : `Delete "${project.name}"? This can't be undone.`
    if (!window.confirm(msg)) return
    void deleteTakesForProject(project.id)
    setTakes((prev) => prev.filter((t) => t.projectId !== project.id))
    setProjects((prev) => prev.filter((p) => p.id !== project.id))
    setProjectId('generic')
  }

  // script + video title are views onto the current project
  const script = project?.script ?? DEFAULT_SCRIPT
  const setScript = (v: string) => patchProject({ script: v })
  const videoTitle = project?.title ?? 'My Demo'
  const setVideoTitle = (v: string) => patchProject({ title: v })

  const [takes, setTakes] = useState<Take[]>([])
  const projectTakes = takes.filter((t) => t.projectId === project?.id)

  const persistTake = (t: Take) => {
    void saveTake({
      id: t.id, projectId: t.projectId, name: t.name, duration: t.duration,
      size: t.size, createdAt: t.createdAt.toISOString(), blob: t.blob,
      ...(t.markers?.length ? { markers: t.markers } : {}),
      ...(t.captions?.length ? { captions: t.captions } : {}),
    })
  }

  // ---- Captions (on-device Whisper; one job at a time) --------------------
  // ---- Update banner -------------------------------------------------------
  // The bundle carries its build stamp (__BUILD_ID__); version.json on the
  // server carries the newest deploy's stamp. When they differ, a newer
  // build exists — show a banner and let the user reload when ready.
  // Nothing auto-reloads, nothing appears mid-take, and on desktop /
  // file:// the fetch just fails, so the banner simply never exists there.
  const [updateReady, setUpdateReady] = useState(false)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  useEffect(() => {
    let live = true
    const check = async () => {
      try {
        const r = await fetch(`version.json?ts=${Date.now()}`, { cache: 'no-store' })
        if (!r.ok) return
        const v = (await r.json()) as { build?: string }
        if (live && v.build && v.build !== __BUILD_ID__) setUpdateReady(true)
      } catch { /* offline or desktop build: no banner */ }
    }
    void check()
    const onFocus = () => { void check() }
    window.addEventListener('focus', onFocus)
    const iv = window.setInterval(() => { void check() }, 5 * 60 * 1000)
    return () => { live = false; window.removeEventListener('focus', onFocus); window.clearInterval(iv) }
  }, [])

  const [captionJob, setCaptionJob] = useState<{ id: string; stage: string; pct: number | null } | null>(null)
  const [captionErr, setCaptionErr] = useState<Record<string, string>>({})
  const captionBusyRef = useRef(false)
  /** Run Whisper for one take; true on success. Shared by the per-take
   *  button and Review's transcribe-all queue (one job at a time). */
  const runCaptions = async (take: Take): Promise<boolean> => {
    setCaptionErr((p) => ({ ...p, [take.id]: '' }))
    setCaptionJob({ id: take.id, stage: 'Starting…', pct: null })
    try {
      const cues = await transcribeTake(take.blob, (stage, pct) => setCaptionJob({ id: take.id, stage, pct }))
      setTakes((prev) => prev.map((t) => {
        if (t.id !== take.id) return t
        const updated = { ...t, captions: cues }
        persistTake(updated)
        return updated
      }))
      return true
    } catch (e) {
      setCaptionErr((p) => ({
        ...p,
        [take.id]: `Captions failed: ${e instanceof Error ? e.message : 'unknown error'} The take itself is untouched — check your connection for the one-time model download and try again.`,
      }))
      return false
    } finally {
      setCaptionJob(null)
    }
  }
  const generateCaptions = async (take: Take) => {
    if (captionBusyRef.current) return
    captionBusyRef.current = true
    try { await runCaptions(take) } finally { captionBusyRef.current = false }
  }
  /** Caption every take in this project that lacks captions, in order.
   *  A failed take keeps its error on its card; the queue moves on. */
  const transcribeAllMissing = async () => {
    if (captionBusyRef.current) return
    captionBusyRef.current = true
    try {
      const missing = takes.filter((t) => t.projectId === project.id && !t.captions?.length)
      for (const t of missing) await runCaptions(t)
    } finally {
      captionBusyRef.current = false
    }
  }

  // ---- Recording guide -----------------------------------------------------
  // The script's lines are beats you CAN follow — or ignore. Guide mode
  // shows the current beat while recording; Free talk hides the beats and
  // just keeps time. Either way, advancing a beat or tapping Mark drops a
  // chapter marker into the take. Nothing ever advances or nags on its own:
  // going off script is a normal way to use this, not an error state.
  const beats = useMemo(
    () => script.split('\n').map((l) => l.trim()).filter(Boolean),
    [script],
  )
  const [guideMode, setGuideMode] = useState<'guide' | 'free'>('guide')
  const [beatIdx, setBeatIdxState] = useState(0)
  const beatIdxRef = useRef(0)
  const setBeatIdx = (n: number) => { beatIdxRef.current = n; setBeatIdxState(n) }
  const markersRef = useRef<TakeMarker[]>([])
  const beatsRef = useRef<string[]>([])
  const targetSec = project?.targetSec ?? 180

  // position inside the take itself (paused time excluded, incl. a pause in progress)
  const takeTimeNow = () => {
    const curPause = recorderRef.current?.state === 'paused' ? Date.now() - pauseStartRef.current : 0
    return Math.max(0, (Date.now() - startRef.current - pausedTotalRef.current - curPause) / 1000)
  }
  const dropMarker = (label: string) => {
    markersRef.current = [...markersRef.current, { t: takeTimeNow(), label }]
  }
  const nextBeat = () => {
    const bs = beatsRef.current
    const n = Math.min(beatIdxRef.current + 1, Math.max(0, bs.length - 1))
    if (n !== beatIdxRef.current) {
      setBeatIdx(n)
      // chapters only exist once the take is rolling; before that, Next just positions the guide
      if (bs[n] && (phase === 'recording' || phase === 'paused')) dropMarker(bs[n])
    }
  }
  const prevBeat = () => setBeatIdx(Math.max(0, beatIdxRef.current - 1))
  const markNow = () => dropMarker('Mark')

  const previewRef = useRef<HTMLDivElement>(null)
  const compositorRef = useRef<Compositor | null>(null)
  const screenRef = useRef<MediaStream | null>(null)
  const camRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<number | null>(null)
  const startRef = useRef(0)
  const pausedTotalRef = useRef(0)
  const pauseStartRef = useRef(0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const recordingProjectRef = useRef('generic')

  // hydrate saved takes from IndexedDB — they survive reloads, per project
  useEffect(() => {
    let live = true
    void loadTakes().then((stored) => {
      if (!live || !stored.length) return
      const hydrated: Take[] = stored
        .map((s) => ({
          id: s.id, url: URL.createObjectURL(s.blob), blob: s.blob, name: s.name,
          duration: s.duration, size: s.size, createdAt: new Date(s.createdAt), projectId: s.projectId,
          ...(s.markers?.length ? { markers: s.markers } : {}),
          ...(s.captions?.length ? { captions: s.captions } : {}),
        }))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      setTakes((prev) => [...hydrated.filter((h) => !prev.some((p) => p.id === h.id)), ...prev])
    })
    return () => { live = false }
  }, [])

  // cleanup on unmount
  useEffect(() => () => {
    compositorRef.current?.stop()
    screenRef.current?.getTracks().forEach((t) => t.stop())
    camRef.current?.getTracks().forEach((t) => t.stop())
    if (timerRef.current) window.clearInterval(timerRef.current)
  }, [])

  const startMicMeter = useCallback((stream: MediaStream) => {
    if (!stream.getAudioTracks().length) return
    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    ctx.createMediaStreamSource(stream).connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteFrequencyData(data)
      const avg = data.reduce((a, b) => a + b, 0) / data.length
      setMicLevel(Math.min(1, avg / 90))
      if (audioCtxRef.current) requestAnimationFrame(tick)
    }
    tick()
  }, [])

  const setup = async () => {
    setError('')
    const mode = sourceMode
    // Open the chosen camera; if the saved device is gone (unplugged USB
    // cam), fall back to the default camera instead of failing setup.
    const openCamera = async (fullFrame: boolean): Promise<MediaStream> => {
      const geo = fullFrame ? { quality } : {}
      try {
        return await getCameraStream(micOn, { ...geo, deviceId: cameraId || undefined })
      } catch (e) {
        if (cameraId) return getCameraStream(micOn, geo)
        throw e
      }
    }
    try {
      let screen: MediaStream | null = null
      if (mode !== 'camera-only') {
        screen = await getScreenStream(quality, fps, micOn)
        screenRef.current = screen
        setSurface(captureSurface(screen))
        wireScreenEnded(screen)
      }

      let cam: MediaStream | null = null // stream held for its audio tracks + mic meter
      let camVideo: MediaStream | null = null // stream handed to the compositor
      if (mode === 'camera-only') {
        // The camera is the whole take — if it can't open, nothing can record.
        cam = await openCamera(true)
        camRef.current = cam
        camVideo = cam
        if (micOn) startMicMeter(cam)
        void refreshCameras()
      } else if (mode === 'screen-only') {
        // No camera is ever requested in this mode; the mic (if on) is its
        // own audio-only stream.
        if (micOn) {
          try {
            cam = await getMicStream()
            camRef.current = cam
            startMicMeter(cam)
          } catch { /* mic denied — screen/tab audio may still be recorded */ }
        }
      } else if (cameraOn || micOn) {
        try {
          cam = await openCamera(false)
          camRef.current = cam
          camVideo = cam
          if (!cameraOn) cam.getVideoTracks().forEach((t) => (t.enabled = false))
          if (micOn) startMicMeter(cam)
          void refreshCameras()
        } catch {
          setError('Camera/mic permission was denied — recording screen only. Check browser permissions and try again.')
        }
      }

      const comp = new Compositor({ quality, fps, pipSize, cameraOn: effCameraOn, micOn, mirrorCamera: mirror, nameTag, mode })
      comp.attach(screen, camVideo)
      comp.start()
      compositorRef.current = comp

      if (previewRef.current) {
        previewRef.current.innerHTML = ''
        comp.canvas.style.width = '100%'
        comp.canvas.style.height = '100%'
        comp.canvas.style.objectFit = 'contain'
        comp.canvas.style.borderRadius = '12px'
        previewRef.current.appendChild(comp.canvas)
      }
      setPhase('ready')
    } catch (e) {
      // Stop anything partially acquired — no camera light left on, ever.
      screenRef.current?.getTracks().forEach((t) => t.stop())
      camRef.current?.getTracks().forEach((t) => t.stop())
      screenRef.current = null
      camRef.current = null
      if (mode === 'camera-only') {
        setError('Camera was blocked or unavailable — in Camera only mode there is nothing to record without it. Check that no other app is using the camera, and that DemoCut (or your browser) is allowed to use the camera — and microphone, if it is on — in your system settings, then try again.')
      } else {
        setError(`Screen share was cancelled or blocked. Click "${setupLabel}" and pick the window/screen you want to demo.`)
      }
    }
  }

  // Pick a different camera. In 'ready' the preview swaps live (the canvas
  // stream the recorder consumes never changes); while recording, the
  // recorder already holds the current mic track, so the choice is saved
  // and applies from the next setup.
  const changeCamera = async (id: string) => {
    setCameraIdState(id)
    localStorage.setItem('democut-camera-id', id)
    if (phase !== 'ready' || !compositorRef.current) return
    try {
      const cam = await getCameraStream(micOn, {
        deviceId: id || undefined,
        ...(sourceMode === 'camera-only' ? { quality } : {}),
      })
      const old = camRef.current
      camRef.current = cam
      if (!effCameraOn) cam.getVideoTracks().forEach((t) => (t.enabled = false))
      compositorRef.current.setCameraStream(cam)
      audioCtxRef.current?.close().catch(() => {})
      audioCtxRef.current = null
      if (micOn) startMicMeter(cam)
      old?.getTracks().forEach((t) => t.stop())
      setError('')
    } catch {
      setError('That camera could not be opened — still using the previous one. It may be busy in another app.')
    }
  }

  // If the user stops sharing from the browser's own UI, stop cleanly
  const wireScreenEnded = (stream: MediaStream) => {
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') stopRecording()
      else teardown()
    })
  }

  // Follow-me: swap the captured surface WITHOUT stopping the take. The
  // recorder consumes the canvas stream, so changing what the canvas draws
  // is invisible to the recording — no cut, no new file. This is the fix for
  // "I switched to another app and the recording didn't show it": a capture
  // locked to one window/tab can never see another app (e.g. a Facebook
  // login in a different window) — Entire Screen can, and this button lets
  // you jump surfaces mid-demo.
  const switchScreen = async () => {
    const comp = compositorRef.current
    if (!comp) return
    try {
      const next = await getScreenStream(quality, fps, micOn)
      const old = screenRef.current
      comp.setScreenStream(next)
      screenRef.current = next
      setSurface(captureSurface(next))
      wireScreenEnded(next)
      old?.getVideoTracks().forEach((tr) => tr.stop())
      setError('')
    } catch {
      setError('Screen switch was cancelled — still showing the previous screen.')
    }
  }

  const teardown = () => {
    compositorRef.current?.stop()
    compositorRef.current = null
    screenRef.current?.getTracks().forEach((t) => t.stop())
    camRef.current?.getTracks().forEach((t) => t.stop())
    screenRef.current = null
    camRef.current = null
    audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    setMicLevel(0)
    setSurface('unknown')
    setElapsed(0)
    setPhase('idle')
    if (timerRef.current) window.clearInterval(timerRef.current)
  }

  const beginRecording = () => {
    const comp = compositorRef.current
    if (!comp) return
    recordingProjectRef.current = project.id
    beatsRef.current = beats
    setBeatIdx(0)
    markersRef.current = guideMode === 'guide' && beats.length ? [{ t: 0, label: beats[0] }] : []
    // keep compositor options in sync with toggles changed after setup
    comp.opts.pipSize = pipSize
    comp.opts.cameraOn = effCameraOn
    comp.opts.mirrorCamera = mirror
    comp.opts.nameTag = nameTag

    const canvasStream = comp.stream()
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()]
    // Audio priority: mic (from camera stream) + screen/tab audio if present
    camRef.current?.getAudioTracks().forEach((t) => tracks.push(t))
    screenRef.current?.getAudioTracks().forEach((t) => tracks.push(t))
    const combined = new MediaStream(tracks)

    const mimeType = pickMimeType()
    const rec = new MediaRecorder(combined, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: quality === '1080p' ? 8_000_000 : 5_000_000,
      audioBitsPerSecond: 128_000,
    })
    chunksRef.current = []
    rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
    rec.onerror = () => {
      // Never fail silently: onstop still saves whatever was captured.
      setError('The recorder reported an error mid-take — whatever was captured up to that point will still be saved when the take finishes. If it happens again, try 720p / 30 fps.')
    }
    rec.onstop = async () => {
      const type = mimeType || 'video/webm'
      const ext = type.includes('mp4') ? 'mp4' : 'webm'
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const duration = (Date.now() - startRef.current - pausedTotalRef.current) / 1000
      // WebM from MediaRecorder carries a 0 header duration, which makes
      // players/editors treat the take as empty or cut short — patch it
      // with the real length before the take is saved anywhere.
      const raw = new Blob(chunksRef.current, { type })
      const blob = type.includes('webm') ? await fixWebmDuration(raw, duration * 1000) : raw
      const take: Take = {
        id: crypto.randomUUID(),
        url: URL.createObjectURL(blob),
        blob,
        name: `democut-${stamp}.${ext}`,
        duration,
        size: blob.size,
        createdAt: new Date(),
        projectId: recordingProjectRef.current,
        ...(markersRef.current.length ? { markers: [...markersRef.current] } : {}),
      }
      persistTake(take)
      setTakes((prev) => [take, ...prev])
      teardown()
    }
    recorderRef.current = rec

    // 3-2-1 countdown, then go — no fumbling with the button on camera
    setPhase('countdown')
    setCount(3)
    let n = 3
    const iv = window.setInterval(() => {
      n -= 1
      if (n <= 0) {
        window.clearInterval(iv)
        rec.start(500)
        startRef.current = Date.now()
        pausedTotalRef.current = 0
        setElapsed(0)
        setPhase('recording')
        timerRef.current = window.setInterval(() => {
          setElapsed((Date.now() - startRef.current - pausedTotalRef.current) / 1000)
        }, 250)
      } else setCount(n)
    }, 700)
  }

  const pauseResume = () => {
    const rec = recorderRef.current
    if (!rec) return
    if (rec.state === 'recording') {
      rec.pause()
      pauseStartRef.current = Date.now()
      setPhase('paused')
    } else if (rec.state === 'paused') {
      rec.resume()
      pausedTotalRef.current += Date.now() - pauseStartRef.current
      setPhase('recording')
    }
  }

  const stopRecording = () => {
    if (timerRef.current) window.clearInterval(timerRef.current)
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') {
      try { rec.requestData() } catch { /* flush is best-effort */ }
    }
    recorderRef.current?.stop() // onstop saves the take + tears down
  }

  const download = (take: Take) => {
    const a = document.createElement('a')
    a.href = take.url
    a.download = take.name
    a.click()
  }

  const recording = phase === 'recording' || phase === 'paused'
  const pacePct = targetSec > 0 ? Math.min(100, (elapsed / targetSec) * 100) : 0
  const overTarget = targetSec > 0 && elapsed > targetSec

  // Web-build shortcuts (react-hotkeys-hook, MIT) — parity with the desktop
  // app's global hotkeys: Cmd/Ctrl+Shift+R record/stop, Cmd/Ctrl+Shift+P pause.
  useHotkeys('mod+shift+r', (e) => {
    e.preventDefault()
    if (phase === 'ready') beginRecording()
    else if (phase === 'recording' || phase === 'paused') stopRecording()
  }, { enableOnFormTags: false }, [phase])
  useHotkeys('mod+shift+p', (e) => {
    e.preventDefault()
    if (phase === 'recording' || phase === 'paused') pauseResume()
  }, { enableOnFormTags: false }, [phase])
  // Guide keys while recording: → next beat, ← previous beat, M drops a mark.
  // They only steer the guide — the recording itself never depends on them.
  useHotkeys('right', (e) => { e.preventDefault(); if (recording) nextBeat() }, { enableOnFormTags: false }, [phase])
  useHotkeys('left', (e) => { e.preventDefault(); if (recording) prevBeat() }, { enableOnFormTags: false }, [phase])
  useHotkeys('m', () => { if (recording) markNow() }, { enableOnFormTags: false }, [phase])

  const addEditedTake = (blob: Blob, durationSec: number) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const take: Take = {
      id: crypto.randomUUID(),
      url: URL.createObjectURL(blob),
      blob,
      name: `democut-EDITED-${stamp}.webm`,
      duration: durationSec,
      size: blob.size,
      createdAt: new Date(),
      projectId: project.id,
    }
    persistTake(take)
    setTakes((prev) => [take, ...prev])
  }

  const fileInputRef = useRef<HTMLInputElement>(null)
  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return
    for (const file of Array.from(files)) {
      const url = URL.createObjectURL(file)
      // Probe duration (files don't carry it in a way the library can show)
      const duration = await new Promise<number>((resolve) => {
        const v = document.createElement('video')
        v.preload = 'metadata'
        v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) ? v.duration : 0)
        v.onerror = () => resolve(0)
        v.src = url
      })
      const take: Take = {
        id: crypto.randomUUID(),
        url,
        blob: file,
        name: file.name,
        duration,
        size: file.size,
        createdAt: new Date(),
        projectId: project.id,
      }
      persistTake(take)
      setTakes((prev) => [take, ...prev])
    }
  }

  return (
    <div className="min-h-screen bg-ink text-slate-100">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-teal text-ink"><Video size={22} strokeWidth={2.4} /></div>
            <div>
              <div className="text-lg font-bold leading-none">DemoCut</div>
              <div className="mt-1 text-xs text-slate-400">Screen, facecam, or camera-only demos. One click, countdown, done.</div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="hidden items-center gap-1.5 rounded-full border border-line px-3 py-1.5 sm:flex"><Zap size={13} className="text-teal-bright" /> Web app — also runs as a desktop app (Electron)</span>
            {recording && <span className="flex items-center gap-2 rounded-full bg-red-500/15 px-3 py-1.5 font-mono font-semibold text-red-300"><span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> {formatTime(elapsed)}</span>}
          </div>
        </div>
      </header>

      {updateReady && !updateDismissed && (phase === 'idle' || phase === 'ready') && (
        <div className="border-b border-teal/40 bg-teal/10 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 text-sm">
            <span className="text-teal-100"><strong>A new version of DemoCut is available.</strong> You're still on the previous build — nothing changes until you reload.</span>
            <button onClick={() => window.location.reload()} className="rounded-lg bg-teal px-3 py-1.5 text-xs font-semibold text-ink hover:bg-teal-bright">Reload to update</button>
            <button onClick={() => setUpdateDismissed(true)} className="rounded-lg border border-line px-3 py-1.5 text-xs text-slate-300 hover:bg-panel2">Later</button>
          </div>
        </div>
      )}

      <main className="mx-auto grid max-w-7xl gap-5 px-5 py-5 lg:grid-cols-[1fr_340px]">
        <section>
          <div className="relative aspect-video overflow-hidden rounded-2xl border border-line bg-black">
            <div ref={previewRef} className="absolute inset-0" />
            {phase === 'idle' && (
              <div className="absolute inset-0 grid place-items-center p-8 text-center">
                {sourceMode === 'camera-only' ? (
                  <div>
                    <Camera className="mx-auto text-slate-600" size={52} />
                    <p className="mt-4 font-semibold">No camera connected yet</p>
                    <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">Camera-only takes are for talking straight to your audience — intros, outros, explainers. No screen share is asked for: you fill the whole frame, recorded at the quality you picked, so camera takes and screen takes stitch together in the editor.</p>
                  </div>
                ) : (
                  <div>
                    <Monitor className="mx-auto text-slate-600" size={52} />
                    <p className="mt-4 font-semibold">No screen connected yet</p>
                    <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">Set up once, then every demo is: hit Record, wait for the countdown, talk. Your face is composited into the top-right of the actual recording file — nothing to edit afterwards.</p>
                    <p className="mx-auto mt-3 max-w-md rounded-xl border border-teal/30 bg-teal/10 px-3 py-2 text-xs leading-relaxed text-teal-100"><strong>To follow you across apps:</strong> in the share picker choose <strong>Entire Screen</strong>. A single window or tab can only ever show itself — switch away (say, to a Facebook login in another window) and the recording can't see it until you come back. <strong>Switch screen</strong> also lets you jump surfaces mid-recording without stopping the take.</p>
                  </div>
                )}
              </div>
            )}
            {phase === 'countdown' && (
              <div className="absolute inset-0 grid place-items-center bg-black/60">
                <div className="text-center"><div className="font-mono text-8xl font-black text-teal-bright">{count}</div><div className="mt-2 text-sm text-slate-300">Get ready…</div></div>
              </div>
            )}
            {phase === 'ready' && <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs text-teal-bright"><CheckCircle2 size={13} /> {sourceMode === 'camera-only' ? 'Preview live — you fill the frame. Check your framing, then Record' : sourceMode === 'screen-only' ? 'Preview live — screen only. Check the window, then Record' : 'Preview live — check your facecam (top right), then Record'}</div>}
            {(phase === 'ready' || recording) && sourceMode !== 'camera-only' && (
              <div className={`absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${surface === 'monitor' ? 'bg-teal/80 text-ink' : 'bg-amber-500/90 text-ink'}`}>
                {surface === 'monitor'
                  ? <>Following your whole screen — app &amp; window switches will be recorded</>
                  : <>Locked to one {surface === 'browser' ? 'tab' : 'window'} — switches won't show. Switch screen → Entire Screen follows you</>}
              </div>
            )}
          </div>

          {error && <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">{error}</div>}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {phase === 'idle' && (
              <button onClick={setup} className="flex items-center gap-2 rounded-xl bg-teal px-5 py-3 font-semibold text-ink hover:bg-teal-bright">{sourceMode === 'camera-only' ? <Camera size={18} /> : <Monitor size={18} />} {setupLabel}</button>
            )}
            {phase === 'ready' && (<>
              <button onClick={beginRecording} className="flex items-center gap-2 rounded-xl bg-red-500 px-5 py-3 font-semibold text-white hover:bg-red-400"><Circle size={17} fill="currentColor" /> Record (3-2-1)</button>
              {sourceMode !== 'camera-only' && <button onClick={switchScreen} className="flex items-center gap-2 rounded-xl border border-line px-4 py-3 text-sm text-slate-200 hover:bg-panel2"><MonitorUp size={15} /> Switch screen</button>}
              <button onClick={teardown} className="rounded-xl border border-line px-4 py-3 text-sm text-slate-300 hover:bg-panel2">Disconnect</button>
            </>)}
            {recording && (<>
              <button onClick={pauseResume} className="flex items-center gap-2 rounded-xl bg-panel2 px-5 py-3 font-semibold ring-1 ring-line hover:bg-panel">{phase === 'paused' ? <><Play size={17} /> Resume</> : <><Pause size={17} /> Pause</>}</button>
              <button onClick={stopRecording} className="flex items-center gap-2 rounded-xl bg-red-500 px-5 py-3 font-semibold text-white hover:bg-red-400"><Square size={16} fill="currentColor" /> Stop &amp; save take</button>
              {sourceMode !== 'camera-only' && <button onClick={switchScreen} className="flex items-center gap-2 rounded-xl border border-line px-4 py-3 text-sm text-slate-200 hover:bg-panel2"><MonitorUp size={15} /> Switch screen</button>}
            </>)}
            {phase === 'countdown' && <span className="px-2 py-3 text-sm text-slate-400">Recording starts automatically…</span>}

            <div className="ml-auto flex items-center gap-2 text-xs text-slate-400">
              <Mic size={14} className={micOn ? 'text-teal-bright' : 'text-slate-600'} />
              <div className="h-2 w-28 overflow-hidden rounded-full bg-panel2"><div className="h-full bg-teal transition-all" style={{ width: `${Math.round(micLevel * 100)}%` }} /></div>
              <span>{micOn ? 'Mic level' : 'Mic off'}</span>
            </div>
          </div>

          {/* Takes */}
          <div className="mt-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-semibold"><Clock3 size={17} className="text-teal-bright" /> Takes — {project.name} {projectTakes.length > 0 && <span className="text-sm font-normal text-slate-400">— saved in this browser, they survive reloads; still download the keepers</span>}</h2>
              <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 rounded-xl border border-teal px-4 py-2 text-sm font-semibold text-teal-bright hover:bg-teal/10"><Upload size={15} /> Upload a video — phone recordings too</button>
              <input ref={fileInputRef} type="file" accept="video/*,.mov,.mp4,.m4v,.webm" multiple hidden onChange={(e) => { void handleUpload(e.target.files); e.target.value = '' }} />
            </div>
            <p className="mt-1 text-xs text-slate-500">Recorded a mobile app on your phone? iPhone Screen Recording clips (Photos → .mov/.mp4) upload straight into the editor here — trim, title, export. Same for any video file from your computer.</p>
            {projectTakes.length === 0
              ? <p className="mt-2 text-sm text-slate-500">No takes in this project yet. Recordings and uploads for {project.name} will land here with a player and a download button.</p>
              : <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {projectTakes.map((t) => (
                    <TakeCard key={t.id} take={t}
                      onDownload={() => download(t)}
                      onDelete={() => { void idbDeleteTake(t.id); setTakes((p) => p.filter((x) => x.id !== t.id)) }}
                      captionJob={captionJob}
                      captionError={captionErr[t.id] ?? ''}
                      onGenerateCaptions={() => void generateCaptions(t)} />
                  ))}
                </div>}
          </div>

          <Review
            projectId={project.id}
            projectName={project.name}
            script={script}
            takes={projectTakes}
            captionBusy={!!captionJob}
            onTranscribeAll={() => void transcribeAllMissing()}
          />

          <Editor takes={projectTakes} onExported={addEditedTake} title={videoTitle} onTitleChange={setVideoTitle} />
        </section>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-line bg-panel p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Settings2 size={16} className="text-teal-bright" /> Setup</h3>
            <p className="mt-1 text-[11px] text-slate-500">Change these before “Set up”, or change facecam size live before you hit Record.</p>
            <div className="mt-3 space-y-3 text-sm">
              <div>
                <div className="mb-1.5">Recording source</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {([['screen-camera', 'Screen + camera'], ['screen-only', 'Screen only'], ['camera-only', 'Camera only']] as [SourceMode, string][]).map(([m, label]) => (
                    <button key={m} onClick={() => setSourceMode(m)} disabled={phase !== 'idle'} className={`rounded-lg px-2 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${sourceMode === m ? 'bg-teal font-semibold text-ink' : 'border border-line text-slate-300 hover:bg-panel2'}`}>{label}</button>
                  ))}
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  {sourceMode === 'camera-only'
                    ? 'Talking-head takes: you fill the frame and no screen share is ever asked for.'
                    : sourceMode === 'screen-only'
                      ? 'Just the screen — no camera is requested at all.'
                      : 'The screen, with your face in the top-right corner.'}
                  {phase !== 'idle' && ' Disconnect to change source.'}
                </p>
              </div>
              <label className="flex items-center justify-between gap-3">Quality
                <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)} className="rounded-lg border border-line bg-panel2 px-2 py-1.5 text-xs"><option value="1080p">1080p</option><option value="720p">720p</option></select></label>
              <label className="flex items-center justify-between gap-3">Frame rate
                <select value={fps} onChange={(e) => setFps(Number(e.target.value) as 30 | 60)} className="rounded-lg border border-line bg-panel2 px-2 py-1.5 text-xs"><option value={30}>30 fps</option><option value={60}>60 fps</option></select></label>
              {sourceMode !== 'camera-only' && (
                <label className="flex items-center justify-between gap-3">Facecam size (top-right)
                  <select value={pipSize} onChange={(e) => setPipSize(e.target.value as PipSize)} className="rounded-lg border border-line bg-panel2 px-2 py-1.5 text-xs"><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select></label>
              )}
              <Toggle label="Camera" icon={effCameraOn ? <Video size={15} /> : <VideoOff size={15} />} on={effCameraOn} set={setCameraOn} disabled={sourceMode !== 'screen-camera'} />
              <Toggle label="Microphone" icon={micOn ? <Mic size={15} /> : <MicOff size={15} />} on={micOn} set={setMicOn} />
              <Toggle label="Mirror my camera" icon={<Camera size={15} />} on={mirror} set={setMirror} />
              {sourceMode !== 'screen-only' && cameras.length > 1 && (
                <label className="flex items-center justify-between gap-3">Camera device
                  <select value={cameraId} disabled={phase !== 'idle' && phase !== 'ready'} onChange={(e) => void changeCamera(e.target.value)} className="max-w-[170px] rounded-lg border border-line bg-panel2 px-2 py-1.5 text-xs disabled:opacity-50">
                    <option value="">Default camera</option>
                    {cameras.map((c, i) => <option key={c.deviceId || `cam-${i}`} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)}
                  </select></label>
              )}
              <label className="block">{sourceMode === 'camera-only' ? 'Name tag (bottom-left of frame)' : 'Name tag above facecam'}
                <input value={nameTag} onChange={(e) => { setNameTag(e.target.value); localStorage.setItem('democut-name-tag', e.target.value) }} placeholder="Your name — blank for none" className="mt-1.5 w-full rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-xs outline-none focus:border-teal" />
              </label>
            </div>
            <div className="mt-4 rounded-xl bg-panel2 p-3 text-[11px] leading-relaxed text-slate-400">
              <strong className="text-slate-200">Honest limits:</strong> in the browser, system audio only comes with tab/Chrome screen share where supported; your mic is always recorded. The Electron desktop build is the path to true system-wide capture, global hotkeys and auto-save to a folder.
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-panel p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Clapperboard size={16} className="text-teal-bright" /> Project</h3>
            <p className="mt-1 text-[11px] text-slate-500">Pick the project you're demoing — its takes, title card and script live here, saved automatically.</p>
            <div className="mt-3 flex items-center gap-2">
              <select value={project.id} onChange={(e) => { setProjectId(e.target.value); setRenaming(false) }} className="min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-2 py-2 text-sm">
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.builtin ? '' : ' — yours'}</option>)}
              </select>
              <button onClick={newProject} title="New project" className="shrink-0 rounded-lg bg-teal p-2 text-ink hover:bg-teal-bright"><Plus size={15} /></button>
              <button onClick={() => setRenaming((r) => !r)} title="Rename project" className="shrink-0 rounded-lg border border-line p-2 text-slate-300 hover:bg-panel2"><Pencil size={15} /></button>
              {!project.builtin && <button onClick={removeProject} title="Delete project" className="shrink-0 rounded-lg border border-line p-2 text-slate-400 hover:text-red-300"><Trash2 size={15} /></button>}
            </div>
            {renaming && (
              <div className="mt-2 flex items-center gap-2">
                <input autoFocus value={project.name} onChange={(e) => patchProject({ name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') setRenaming(false) }} className="min-w-0 flex-1 rounded-lg border border-teal bg-panel2 px-3 py-2 text-sm outline-none" placeholder="Project name" />
                <button onClick={() => setRenaming(false)} title="Done" className="shrink-0 rounded-lg bg-teal p-2 text-ink hover:bg-teal-bright"><Check size={15} /></button>
              </div>
            )}
            {project.builtin
              ? <div className="mt-3 rounded-xl bg-panel2 p-3 text-[12px] leading-relaxed text-slate-300"><strong className="text-slate-100">Open first:</strong> {project.openFirst}</div>
              : <textarea value={project.openFirst} onChange={(e) => patchProject({ openFirst: e.target.value })} rows={2} className="mt-3 w-full resize-y rounded-xl border border-line bg-panel2 p-3 text-[12px] leading-relaxed text-slate-300 outline-none focus:border-teal" placeholder="Open first: what should be on screen before you record?" />}
          </div>

          <div className="rounded-2xl border border-line bg-panel p-4">
            {phase === 'idle' ? (<>
              <h3 className="flex items-center gap-2 text-sm font-semibold"><FileText size={16} className="text-teal-bright" /> Demo script / notes</h3>
              <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={9} className="mt-3 w-full resize-y rounded-xl border border-line bg-panel2 p-3 text-sm leading-relaxed outline-none focus:border-teal" placeholder="One talking point per line — each line becomes a beat in the recording guide." />
              <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-slate-500">
                <span>Auto-saved with this project.</span>
                <label className="flex items-center gap-2">Target length
                  <select value={targetSec} onChange={(e) => patchProject({ targetSec: Number(e.target.value) })} className="rounded-lg border border-line bg-panel2 px-2 py-1 text-xs text-slate-200">
                    <option value={0}>No target</option><option value={120}>2:00</option><option value={150}>2:30</option><option value={180}>3:00</option><option value={240}>4:00</option><option value={300}>5:00</option>
                  </select>
                </label>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">While you record, this card becomes your guide: follow the beats, or switch to Free talk and just talk — tap Mark to drop a chapter wherever one starts. Going off script is fine; the guide follows you, not the other way around.</p>
            </>) : (<>
              <h3 className="flex items-center gap-2 text-sm font-semibold"><ListOrdered size={16} className="text-teal-bright" /> Recording guide</h3>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button onClick={() => setGuideMode('guide')} className={`rounded-lg px-3 py-2 text-xs ${guideMode === 'guide' ? 'bg-teal font-semibold text-ink' : 'border border-line text-slate-300 hover:bg-panel2'}`}>Script beats</button>
                <button onClick={() => setGuideMode('free')} className={`rounded-lg px-3 py-2 text-xs ${guideMode === 'free' ? 'bg-teal font-semibold text-ink' : 'border border-line text-slate-300 hover:bg-panel2'}`}>Free talk</button>
              </div>
              {guideMode === 'guide' ? (
                <div className="mt-3 rounded-xl bg-panel2 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500">Beat {beats.length ? Math.min(beatIdx + 1, beats.length) : 0} of {beats.length}</div>
                  <div className="mt-1 text-[15px] font-medium leading-snug text-slate-100">{beats[beatIdx] ?? 'No script lines for this project — Free talk it, or stop and add a script.'}</div>
                  {beats[beatIdx + 1] && <div className="mt-2 text-xs leading-relaxed text-slate-400">Next: {beats[beatIdx + 1]}</div>}
                </div>
              ) : (
                <div className="mt-3 rounded-xl bg-panel2 p-3 text-sm leading-relaxed text-slate-300">Free talk — no script. Talk naturally. Tap <strong className="text-slate-100">Mark</strong> wherever a new chapter starts; the editor will show them on the take.</div>
              )}
              {targetSec > 0 && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[11px] text-slate-400"><span className="font-mono">{formatTime(elapsed)}</span><span>target {formatTime(targetSec)}</span></div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-panel2"><div className={`h-full transition-all ${overTarget ? 'bg-amber-400' : 'bg-teal'}`} style={{ width: `${pacePct}%` }} /></div>
                  <div className="mt-1 text-[11px] text-slate-500">{overTarget ? `${formatTime(elapsed - targetSec)} past target — wrap up when it feels natural.` : `${formatTime(Math.max(0, targetSec - elapsed))} of target left — a guide, not a deadline.`}</div>
                </div>
              )}
              <div className="mt-3 flex items-center gap-2">
                <button onClick={prevBeat} disabled={guideMode !== 'guide'} className="rounded-lg border border-line px-3 py-2 text-xs text-slate-300 hover:bg-panel2 disabled:opacity-40">← Prev</button>
                <button onClick={markNow} disabled={!recording} className="flex-1 rounded-lg bg-teal px-3 py-2 text-xs font-semibold text-ink hover:bg-teal-bright disabled:opacity-40">● Mark chapter</button>
                <button onClick={nextBeat} disabled={guideMode !== 'guide'} className="rounded-lg border border-line px-3 py-2 text-xs text-slate-300 hover:bg-panel2 disabled:opacity-40">Next →</button>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Beats never advance on their own — only when you tap Next or press →. A chapter lands in the take at each new beat and each Mark. Keys: → next · ← back · M mark.</p>
            </>)}
          </div>

          <div className="rounded-2xl border border-line bg-panel p-4 text-[12px] leading-relaxed text-slate-400">
            <h3 className="text-sm font-semibold text-slate-100">Fast demo workflow</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              <li>Open the thing you're demoing full-screen.</li>
              <li>Pick a source — screen + camera, screen only, or camera only for a talking-head take — then set up.</li>
              <li>Record → 3-2-1 → talk. Pause if you flub a section.</li>
              <li>Stop — the take is already composited. Download &amp; post.</li>
            </ol>
          </div>
        </aside>
      </main>
      <footer className="border-t border-line py-4 text-center text-xs text-slate-600">DemoCut by Abel Mendoza — recordings never leave your machine; everything happens locally in your browser / desktop app.</footer>
    </div>
  )
}

function TakeCard({ take, onDownload, onDelete, captionJob, captionError, onGenerateCaptions }: {
  take: Take
  onDownload: () => void
  onDelete: () => void
  captionJob: { id: string; stage: string; pct: number | null } | null
  captionError: string
  onGenerateCaptions: () => void
}) {
  const [showTranscript, setShowTranscript] = useState(false)
  const [copied, setCopied] = useState(false)
  const hasCaptions = !!take.captions?.length
  const vttUrl = useMemo(
    () => (hasCaptions ? URL.createObjectURL(new Blob([toVtt(take.captions!)], { type: 'text/vtt' })) : null),
    [take.captions, hasCaptions],
  )
  useEffect(() => () => { if (vttUrl) URL.revokeObjectURL(vttUrl) }, [vttUrl])

  const jobHere = captionJob?.id === take.id
  const downloadSrt = () => {
    if (!take.captions?.length) return
    const url = URL.createObjectURL(new Blob([toSrt(take.captions)], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = take.name.replace(/\.[^.]+$/, '') + '.srt'
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 4000)
  }
  const copyTranscript = () => {
    if (!take.captions?.length) return
    void navigator.clipboard.writeText(transcriptText(take.captions)).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel">
      <video id={`democut-video-${take.id}`} src={take.url} controls className="aspect-video w-full bg-black">
        {vttUrl && <track kind="captions" src={vttUrl} label="English (Whisper, on-device)" srcLang="en" default />}
      </video>
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">{take.name}</div>
          <div className="text-[11px] text-slate-500">{formatTime(take.duration)} · {formatBytes(take.size)} · {take.createdAt.toLocaleTimeString()}</div>
          {take.markers && take.markers.length > 0 && <div className="truncate text-[11px] text-teal-bright/80" title={take.markers.map((m) => `${formatTime(m.t)} ${m.label}`).join(' · ')}>Chapters: {take.markers.map((m) => `${formatTime(m.t)} ${m.label}`).join(' · ')}</div>}
        </div>
        <div className="flex shrink-0 gap-1">
          <button onClick={onDownload} title="Download" className="rounded-lg bg-teal p-2 text-ink hover:bg-teal-bright"><Download size={15} /></button>
          <button onClick={onDelete} title="Delete take" className="rounded-lg border border-line p-2 text-slate-400 hover:text-red-300"><Trash2 size={15} /></button>
        </div>
      </div>
      <div className="border-t border-line px-3 py-2.5">
        {hasCaptions ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="flex items-center gap-1 rounded-full bg-teal/15 px-2 py-1 font-semibold text-teal-bright"><Captions size={12} /> CC — Whisper, on-device</span>
            <button onClick={downloadSrt} className="rounded-full border border-line px-2.5 py-1 text-slate-300 hover:border-teal hover:text-teal-bright">Download .srt</button>
            <button onClick={() => setShowTranscript((s) => !s)} className="rounded-full border border-line px-2.5 py-1 text-slate-300 hover:border-teal hover:text-teal-bright">{showTranscript ? 'Hide transcript' : 'Transcript'}</button>
            <button onClick={onGenerateCaptions} disabled={!!captionJob} className="text-slate-500 hover:text-slate-300 disabled:opacity-50">regenerate</button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <button onClick={onGenerateCaptions} disabled={!!captionJob} className="flex items-center gap-1.5 rounded-full border border-teal px-3 py-1.5 font-semibold text-teal-bright hover:bg-teal/10 disabled:opacity-50"><Captions size={13} /> {jobHere ? 'Working…' : 'Generate captions'}</button>
            {jobHere
              ? <span className="text-teal-bright">{captionJob.stage}{captionJob.pct !== null ? ` ${captionJob.pct}%` : ''}</span>
              : <span className="text-slate-500">Whisper, on this device. First run downloads the model once (~78 MB).</span>}
          </div>
        )}
        {captionError && <p className="mt-2 text-[11px] leading-relaxed text-amber-200">{captionError}</p>}
        {hasCaptions && showTranscript && (
          <div className="mt-2 rounded-xl bg-panel2 p-3">
            <p className="text-[12px] leading-relaxed text-slate-300">{transcriptText(take.captions!)}</p>
            <button onClick={copyTranscript} className="mt-2 flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-slate-300 hover:border-teal hover:text-teal-bright">{copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy transcript</>}</button>
          </div>
        )}
      </div>
    </div>
  )
}

function Toggle({ label, icon, on, set, disabled }: { label: string; icon: React.ReactNode; on: boolean; set: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button onClick={() => set(!on)} disabled={disabled} className="flex w-full items-center justify-between gap-3 text-left disabled:cursor-not-allowed disabled:opacity-50">
      <span className="flex items-center gap-2">{icon}{label}</span>
      <span className={`relative h-6 w-11 rounded-full transition ${on ? 'bg-teal' : 'bg-slate-700'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} /></span>
    </button>
  )
}
