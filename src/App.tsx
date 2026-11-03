import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Circle, Pause, Play, Square, Download, Trash2, Monitor, Video, VideoOff,
  Mic, MicOff, FileText, Zap, Clock3, Camera, Settings2, CheckCircle2, Clapperboard,
} from 'lucide-react'
import {
  Compositor, getScreenStream, getCameraStream, pickMimeType,
  formatTime, formatBytes, type PipSize, type Quality, type Take,
} from './lib/recorder'
import { useHotkeys } from 'react-hotkeys-hook'
import { Upload } from 'lucide-react'
import Editor from './components/Editor'
import { PRESETS } from './lib/projects'

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
  const [micLevel, setMicLevel] = useState(0)

  const [script, setScript] = useState(() => localStorage.getItem('democut-script') || DEFAULT_SCRIPT)
  const [presetId, setPresetId] = useState('generic')
  const [videoTitle, setVideoTitle] = useState('My Demo')
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]
  const loadPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id) ?? PRESETS[0]
    setPresetId(id)
    setScript(p.script)
    setVideoTitle(p.title)
  }
  const [takes, setTakes] = useState<Take[]>([])

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

  useEffect(() => { localStorage.setItem('democut-script', script) }, [script])

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
    try {
      const screen = await getScreenStream(quality, fps, micOn)
      screenRef.current = screen
      // If the user stops sharing from the browser UI, stop cleanly
      screen.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (recorderRef.current && recorderRef.current.state !== 'inactive') stopRecording()
        else teardown()
      })

      let cam: MediaStream | null = null
      if (cameraOn || micOn) {
        try {
          cam = await getCameraStream(micOn)
          camRef.current = cam
          if (!cameraOn) cam.getVideoTracks().forEach((t) => (t.enabled = false))
          if (micOn) startMicMeter(cam)
        } catch {
          if (cameraOn) setError('Camera/mic permission was denied — recording screen only. Check browser permissions and try again.')
        }
      }

      const comp = new Compositor({ quality, fps, pipSize, cameraOn, micOn, mirrorCamera: mirror })
      comp.attach(screen, cam)
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
      setError('Screen share was cancelled or blocked. Click "Set up screen + camera" and pick the window/screen you want to demo.')
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
    setElapsed(0)
    setPhase('idle')
    if (timerRef.current) window.clearInterval(timerRef.current)
  }

  const beginRecording = () => {
    const comp = compositorRef.current
    if (!comp) return
    // keep compositor options in sync with toggles changed after setup
    comp.opts.pipSize = pipSize
    comp.opts.cameraOn = cameraOn
    comp.opts.mirrorCamera = mirror

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
    rec.onstop = () => {
      const type = mimeType || 'video/webm'
      const blob = new Blob(chunksRef.current, { type })
      const ext = type.includes('mp4') ? 'mp4' : 'webm'
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const duration = (Date.now() - startRef.current - pausedTotalRef.current) / 1000
      setTakes((prev) => [{
        id: crypto.randomUUID(),
        url: URL.createObjectURL(blob),
        blob,
        name: `democut-${stamp}.${ext}`,
        duration,
        size: blob.size,
        createdAt: new Date(),
      }, ...prev])
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
    recorderRef.current?.stop() // onstop saves the take + tears down
  }

  const download = (take: Take) => {
    const a = document.createElement('a')
    a.href = take.url
    a.download = take.name
    a.click()
  }

  const recording = phase === 'recording' || phase === 'paused'

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

  const addEditedTake = (blob: Blob, durationSec: number) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    setTakes((prev) => [{
      id: crypto.randomUUID(),
      url: URL.createObjectURL(blob),
      blob,
      name: `democut-EDITED-${stamp}.webm`,
      duration: durationSec,
      size: blob.size,
      createdAt: new Date(),
    }, ...prev])
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
      setTakes((prev) => [{
        id: crypto.randomUUID(),
        url,
        blob: file,
        name: file.name,
        duration,
        size: file.size,
        createdAt: new Date(),
      }, ...prev])
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
              <div className="mt-1 text-xs text-slate-400">Screen + facecam demos. One click, countdown, done.</div>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="hidden items-center gap-1.5 rounded-full border border-line px-3 py-1.5 sm:flex"><Zap size={13} className="text-teal-bright" /> Web app — also runs as a desktop app (Electron)</span>
            {recording && <span className="flex items-center gap-2 rounded-full bg-red-500/15 px-3 py-1.5 font-mono font-semibold text-red-300"><span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> {formatTime(elapsed)}</span>}
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-5 px-5 py-5 lg:grid-cols-[1fr_340px]">
        <section>
          <div className="relative aspect-video overflow-hidden rounded-2xl border border-line bg-black">
            <div ref={previewRef} className="absolute inset-0" />
            {phase === 'idle' && (
              <div className="absolute inset-0 grid place-items-center p-8 text-center">
                <div>
                  <Monitor className="mx-auto text-slate-600" size={52} />
                  <p className="mt-4 font-semibold">No screen connected yet</p>
                  <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">Set up once, then every demo is: hit Record, wait for the countdown, talk. Your face is composited into the top-right of the actual recording file — nothing to edit afterwards.</p>
                </div>
              </div>
            )}
            {phase === 'countdown' && (
              <div className="absolute inset-0 grid place-items-center bg-black/60">
                <div className="text-center"><div className="font-mono text-8xl font-black text-teal-bright">{count}</div><div className="mt-2 text-sm text-slate-300">Get ready…</div></div>
              </div>
            )}
            {phase === 'ready' && <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs text-teal-bright"><CheckCircle2 size={13} /> Preview live — check your facecam (top right), then Record</div>}
          </div>

          {error && <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">{error}</div>}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {phase === 'idle' && (
              <button onClick={setup} className="flex items-center gap-2 rounded-xl bg-teal px-5 py-3 font-semibold text-ink hover:bg-teal-bright"><Monitor size={18} /> Set up screen + camera</button>
            )}
            {phase === 'ready' && (<>
              <button onClick={beginRecording} className="flex items-center gap-2 rounded-xl bg-red-500 px-5 py-3 font-semibold text-white hover:bg-red-400"><Circle size={17} fill="currentColor" /> Record (3-2-1)</button>
              <button onClick={teardown} className="rounded-xl border border-line px-4 py-3 text-sm text-slate-300 hover:bg-panel2">Disconnect</button>
            </>)}
            {recording && (<>
              <button onClick={pauseResume} className="flex items-center gap-2 rounded-xl bg-panel2 px-5 py-3 font-semibold ring-1 ring-line hover:bg-panel">{phase === 'paused' ? <><Play size={17} /> Resume</> : <><Pause size={17} /> Pause</>}</button>
              <button onClick={stopRecording} className="flex items-center gap-2 rounded-xl bg-red-500 px-5 py-3 font-semibold text-white hover:bg-red-400"><Square size={16} fill="currentColor" /> Stop &amp; save take</button>
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
              <h2 className="flex items-center gap-2 font-semibold"><Clock3 size={17} className="text-teal-bright" /> Your takes {takes.length > 0 && <span className="text-sm font-normal text-slate-400">— saved in this session, download the keepers</span>}</h2>
              <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 rounded-xl border border-teal px-4 py-2 text-sm font-semibold text-teal-bright hover:bg-teal/10"><Upload size={15} /> Upload a video — phone recordings too</button>
              <input ref={fileInputRef} type="file" accept="video/*,.mov,.mp4,.m4v,.webm" multiple hidden onChange={(e) => { void handleUpload(e.target.files); e.target.value = '' }} />
            </div>
            <p className="mt-1 text-xs text-slate-500">Recorded a mobile app on your phone? iPhone Screen Recording clips (Photos → .mov/.mp4) upload straight into the editor here — trim, title, export. Same for any video file from your computer.</p>
            {takes.length === 0
              ? <p className="mt-2 text-sm text-slate-500">No takes yet. Your finished recordings will land here with a player and a download button.</p>
              : <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {takes.map((t) => (
                    <div key={t.id} className="overflow-hidden rounded-2xl border border-line bg-panel">
                      <video src={t.url} controls className="aspect-video w-full bg-black" />
                      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                        <div className="min-w-0"><div className="truncate text-xs font-medium">{t.name}</div><div className="text-[11px] text-slate-500">{formatTime(t.duration)} · {formatBytes(t.size)} · {t.createdAt.toLocaleTimeString()}</div></div>
                        <div className="flex shrink-0 gap-1">
                          <button onClick={() => download(t)} title="Download" className="rounded-lg bg-teal p-2 text-ink hover:bg-teal-bright"><Download size={15} /></button>
                          <button onClick={() => setTakes((p) => p.filter((x) => x.id !== t.id))} title="Delete take" className="rounded-lg border border-line p-2 text-slate-400 hover:text-red-300"><Trash2 size={15} /></button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>}
          </div>

          <Editor takes={takes} onExported={addEditedTake} title={videoTitle} onTitleChange={setVideoTitle} />
        </section>

        <aside className="space-y-4">
          <div className="rounded-2xl border border-line bg-panel p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Settings2 size={16} className="text-teal-bright" /> Setup</h3>
            <p className="mt-1 text-[11px] text-slate-500">Change these before “Set up”, or change facecam size live before you hit Record.</p>
            <div className="mt-3 space-y-3 text-sm">
              <label className="flex items-center justify-between gap-3">Quality
                <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)} className="rounded-lg border border-line bg-panel2 px-2 py-1.5 text-xs"><option value="1080p">1080p</option><option value="720p">720p</option></select></label>
              <label className="flex items-center justify-between gap-3">Frame rate
                <select value={fps} onChange={(e) => setFps(Number(e.target.value) as 30 | 60)} className="rounded-lg border border-line bg-panel2 px-2 py-1.5 text-xs"><option value={30}>30 fps</option><option value={60}>60 fps</option></select></label>
              <label className="flex items-center justify-between gap-3">Facecam size (top-right)
                <select value={pipSize} onChange={(e) => setPipSize(e.target.value as PipSize)} className="rounded-lg border border-line bg-panel2 px-2 py-1.5 text-xs"><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select></label>
              <Toggle label="Camera" icon={cameraOn ? <Video size={15} /> : <VideoOff size={15} />} on={cameraOn} set={setCameraOn} />
              <Toggle label="Microphone" icon={micOn ? <Mic size={15} /> : <MicOff size={15} />} on={micOn} set={setMicOn} />
              <Toggle label="Mirror my camera" icon={<Camera size={15} />} on={mirror} set={setMirror} />
            </div>
            <div className="mt-4 rounded-xl bg-panel2 p-3 text-[11px] leading-relaxed text-slate-400">
              <strong className="text-slate-200">Honest limits:</strong> in the browser, system audio only comes with tab/Chrome screen share where supported; your mic is always recorded. The Electron desktop build is the path to true system-wide capture, global hotkeys and auto-save to a folder.
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-panel p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><Clapperboard size={16} className="text-teal-bright" /> Project preset</h3>
            <p className="mt-1 text-[11px] text-slate-500">Pick the project you're demoing — loads its title card, script outline and open-first checklist.</p>
            <select value={presetId} onChange={(e) => loadPreset(e.target.value)} className="mt-3 w-full rounded-lg border border-line bg-panel2 px-2 py-2 text-sm">
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div className="mt-3 rounded-xl bg-panel2 p-3 text-[12px] leading-relaxed text-slate-300"><strong className="text-slate-100">Open first:</strong> {preset.openFirst}</div>
          </div>

          <div className="rounded-2xl border border-line bg-panel p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><FileText size={16} className="text-teal-bright" /> Demo script / notes</h3>
            <textarea value={script} onChange={(e) => setScript(e.target.value)} rows={9} className="mt-3 w-full resize-y rounded-xl border border-line bg-panel2 p-3 text-sm leading-relaxed outline-none focus:border-teal" placeholder="Write your talking points here — saved automatically in this browser." />
            <p className="mt-2 text-[11px] text-slate-500">Auto-saved locally. Read from this while the countdown runs.</p>
          </div>

          <div className="rounded-2xl border border-line bg-panel p-4 text-[12px] leading-relaxed text-slate-400">
            <h3 className="text-sm font-semibold text-slate-100">Fast demo workflow</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              <li>Open the thing you're demoing full-screen.</li>
              <li>Set up screen + camera, pick that window.</li>
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

function Toggle({ label, icon, on, set }: { label: string; icon: React.ReactNode; on: boolean; set: (v: boolean) => void }) {
  return (
    <button onClick={() => set(!on)} className="flex w-full items-center justify-between gap-3 text-left">
      <span className="flex items-center gap-2">{icon}{label}</span>
      <span className={`relative h-6 w-11 rounded-full transition ${on ? 'bg-teal' : 'bg-slate-700'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} /></span>
    </button>
  )
}
