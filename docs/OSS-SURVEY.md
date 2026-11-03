# DemoCut — Open-Source Survey: what to borrow, what to adopt

*Researched 2026-11-02. Licenses verified against each project's own repo/site
(notes in each entry). DemoCut is a public MIT repo, so the dividing line used
throughout is: **permissive (MIT / Apache-2.0 / BSD / MPL-2.0) = safe to adopt
as a library; copyleft (GPL / AGPL) = borrow the UX patterns only, never copy
code** — copying GPL/AGPL code into DemoCut would force DemoCut itself under
that license.*

DemoCut today: React 18 + TS + Vite + Tailwind + Electron, canvas compositing
(screen + facecam PiP top-right), MediaRecorder capture, and a built-in editor
whose export re-renders clips in **real time** through canvas + MediaRecorder.
That export is the slowest, weakest part of the app — most of this survey is
aimed at it.

---

## 1. Screen recorders with facecam PiP — borrow the UX

### Cap (cap.so) — github.com/CapSoftware/Cap
- **What:** The leading open-source Loom alternative (Tauri/Rust desktop).
  Two modes: *Instant* (share link) and *Studio* (local project + timeline
  editor).
- **License: ⚠️ AGPLv3** for the platform/app; its `cap-camera*` and `scap-*`
  Rust capture crates are MIT (per Cap's own LICENSE and cap.so pages).
  Separately, Cap's *official builds* require a paid license for commercial
  use — the source license and the binary license are different things.
- **Best ideas to borrow (patterns only):**
  - **Separate tracks**: screen, camera and mic recorded as *separate
    streams*, composited in the editor — so the facecam can be moved,
    resized, restyled or dropped *after* recording. DemoCut bakes the PiP in
    live; recording the camera as its own take alongside the screen take is
    the single biggest editor upgrade this suggests, and DemoCut's Electron
    shell can do it with the APIs it already uses.
  - **Auto-zoom from recorded clicks**: Cap records cursor/click metadata
    during capture, then generates zoom segments (1×–4.5×) around clicks,
    editable afterwards.
  - **Canvas styling**: background (solid/gradient/wallpaper/image), padding,
    rounded corners, shadow, window/browser frames around the capture.
  - **On-device captions**, generated locally and burned in (19 languages).
- **Verdict:** Borrow patterns. Do NOT copy code (AGPL). The MIT Rust crates
  are irrelevant to DemoCut's TS/Electron stack. **Effort to borrow the
  separate-tracks idea: M. Auto-zoom: M–L (see §3 note on cursor data).**

### OpenScreen — github.com/getopenscreen/openscreen (formerly siddharthvaddem/openscreen)
- **What:** Screen-Studio-style recorder/editor for Mac/Windows/Linux:
  record, then an editor adds automatic zooms, cursor styling, backgrounds,
  on-device Whisper captions, MP4/GIF export.
- **License: ✅ MIT** (stated on the project's own site/repo; free for
  commercial use, no account).
- **Best ideas:** This is the closest *permissively-licensed* proof that the
  Cap/Screen Studio feature set can be built cleanly:
  - **"Auto-enhance"**: automatic zooms planned from recorded clicks — *no
    network call, no ML model*, just click metadata + easing.
  - Cursor recorded **as data** and restyled after the take (size, click
    ripple) instead of burned in.
  - Backgrounds/framing: padding, rounded corners, shadow, 16:9 / 9:16 / 1:1
    outputs — directly applicable to DemoCut's title/framing step.
  - Local Whisper captions burned into export.
- **Verdict:** Borrow patterns freely; code reuse is *legally* OK (MIT) but
  it's a native app (ScreenCaptureKit / Windows Graphics Capture /
  PipeWire), so its capture code doesn't transplant into a browser/Electron
  renderer. Study its editor/zoom design, write DemoCut's own. **Effort: S
  to study, M to implement the zoom/background features.**

### Screenity — github.com/alyssaxuu/screenity
- **What:** Chrome-extension recorder (MV3) with in-recording annotation:
  draw/text/arrows, click & cursor highlight, spotlight, blur-sensitive-area,
  countdown, push-to-talk, MP4/WebM/GIF export.
- **License: ⚠️ GPLv3** for the current MV3 version (the repo README says so
  explicitly; the old MV2 version was MIT).
- **Best ideas (patterns only):** annotation *while recording* (draw an arrow
  at the thing you're talking about instead of describing it), click
  highlights, a blur tool for secrets on screen, countdown.
- **Verdict:** Borrow patterns only (GPLv3). The annotation toolbar is the
  standout: on DemoCut's canvas compositor it's a drawing layer over the
  preview — no library needed. **Effort: M.**

### OBS Studio — github.com/obsproject/obs-studio
- **What:** The standard for capture/compositing/streaming; scenes, sources,
  filters, hotkeys, a
nd a proper "start recording" safe state.
- **License: ⚠️ GPL-2.0-or-later** (repo's own COPYING/README).
- **Best ideas (patterns only):** scene/source mental model (DemoCut already
  has the two-source version), per-source filters, and the discipline of a
  pre-flight "is anything actually capturing?" check — mic level + a live
  preview frame before Record enables.
- **Verdict:** Patterns only (GPL). Nothing to adopt — its engine is native
  C/Qt, and DemoCut's web APIs already cover its niche. **Effort: S.**

### Kooha — github.com/SeaDve/Kooha
- **What:** Minimal GNOME/Linux recorder (Rust/GTK): pick monitor/window/
  area, mic/desktop/both audio, WebM/MP4/GIF/MKV, start delay.
- **License: ⚠️ GPL-3.0** (project metadata / package records).
- **Best idea:** radical minimalism — one window, almost no settings, a
  start-delay instead of a modal flow. A good check on DemoCut feature creep.
- **Verdict:** Patterns only (GPL); Linux-native, nothing portable.
  **Effort: S (design reference only).**

### QuickRecorder — github.com/lihaoyun6/QuickRecorder
- **What:** Lightweight macOS recorder on ScreenCaptureKit: driver-free
  system-audio loopback, mouse highlighting, screen magnifier, Presenter
  Overlay support.
- **License: ⚠️ AGPLv3** (project's own site/repo).
- **Best ideas (patterns only):** mouse highlighting + a magnifier that
  follows the cursor (great for small UI text in demos), and proof that
  system audio on macOS comes from ScreenCaptureKit — i.e. for DemoCut's
  Electron build it's a native-module question, not a web-API question.
- **Verdict:** Patterns only (AGPL, Swift/macOS-only code). **Effort: S.**

### Also noted
- **LosslessCut** (github.com/mifi/lossless-cut) — **GPL-2.0**. The reference
  UX for trim tools: waveform/filmstrip timeline, keyboard-first cutting,
  lossless export as the headline promise. Patterns only — but its timeline
  is what DemoCut's slider editor should grow toward. **Effort: S to study.**

---

## 2. In-browser video editing — replacing the real-time re-render

DemoCut's editor export today replays every clip in real time (a 3-minute
demo takes ~3 minutes to export). Two real ways out:

### Mediabunny — github.com/Vanilagy/mediabunny (successor to mp4-muxer / webm-muxer)
- **What:** Pure-TypeScript media toolkit built on **WebCodecs**: demux,
  mux, transcode and *trim* MP4/WebM/MKV in the browser using the machine's
  hardware codecs. Zero dependencies, ~5 KB gz for the pieces you use.
  Vanilagy's earlier `mp4-muxer`/`webm-muxer` (✅ **MIT**) are now deprecated
  in Mediabunny's favor; Remotion deprecated its own media tools for it and
  sponsors it ($1,000/mo) — the strongest maintenance signal in this space.
- **License: ✅ MPL-2.0** — weak, file-level copyleft: use it commercially /
  in an MIT project freely; only *modifications to Mediabunny's own files*
  must be shared under MPL-2.0. Unmodified npm use = effectively no burden.
- **Why it fits DemoCut exactly:** the editor's job is mostly *not*
  re-encoding: concatenate same-format WebM takes, trim heads/tails, and —
  where frames must be re-encoded (title card, PiP already baked in at
  record time so it isn't) — WebCodecs encodes faster than real time with
  hardware acceleration. No WASM core to download, no server headers, works
  on the plain Vercel static deploy today, and works offline in Electron.
- **Limits, honestly:** WebCodecs is Chromium-complete; Firefox/Safari
  support is partial and codec-dependent, so keep the current canvas
  re-render as the fallback path. It manipulates media files, not canvas
  scenes — compositing still happens at record time (which is DemoCut's
  design anyway).
- **Verdict: ADOPT — this is the export engine.** **Effort: M** (rewrite
  `Editor.tsx` export path: demux takes → trim/concat → mux; keep old path
  as fallback).

### @ffmpeg/ffmpeg (ffmpeg.wasm) — github.com/ffmpegwasm/ffmpeg.wasm
- **What:** FFmpeg (n5.1.4) compiled to WebAssembly; full FFmpeg CLI in a
  worker. Trim/stitch/convert anything, including formats WebCodecs can't.
- **License: ⚠️ SPLIT, and it matters.**
  - `@ffmpeg/ffmpeg` + `@ffmpeg/util` (the JS wrapper): **MIT**.
  - `@ffmpeg/core` / `@ffmpeg/core-mt` (the actual WASM binary): follows
    **FFmpeg's own licensing** — and this build bundles **x264 and x265
    (GPL)**, so the core as distributed is **GPL-2.0-or-later** (the
    ffmpeg.wasm FAQ defers to FFmpeg/external-lib licenses; IMG.LY's
    engineering write-up states both cores are GPL-2.0-or-later outright).
  - Practical meaning: *loading* the core at runtime doesn't relicense
    DemoCut's own code, but the core remains GPL software — ship its license
    notices, don't statically bundle/redistribute it carelessly, and get a
    second look before shipping it *inside* the Electron installer. Loading
    from a CDN at runtime keeps the cleanest separation.
- **Size / loading:** core ≈ **31 MB** WASM (single-thread ~31 MB, MT ~32 MB),
  downloaded on first export and cacheable. Official examples load it from a
  CDN (unpkg/jsDelivr) via `toBlobURL()`; self-hosting is ~31 MB of static
  assets in the deploy (fine on Vercel, bloats the repo if committed —
  serve from `public/` as build output, not source).
- **The SharedArrayBuffer / COOP-COEP issue on Vercel — the good news:**
  only the **multi-thread** core (`@ffmpeg/core-mt`, ~2× faster) needs
  SharedArrayBuffer, which needs cross-origin isolation. Vercel *can* send
  the required headers (`Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`) via `vercel.json` — but
  COEP `require-corp` isolates the whole app (breaks cross-origin embeds/
  resources without CORP headers) — a heavy price for the whole site. The
  **single-thread core needs no special headers at all** and works on
  DemoCut's current Vercel config as-is.
- **Speed:** the project's own benchmark (WebM→MP4, 2023-era): single-thread
  WASM ≈ **25× slower than native FFmpeg**, MT ≈ 12× slower. Directionally:
  for *re-encoding* it's slower than WebCodecs hardware paths; for
  *stream-copy* trims/concats (`-c copy`) it's fast on any engine — which is
  another argument that trim/stitch should be a muxing job, not an encode.
- **Verdict: ADOPT LATER, as the fallback/convert engine only** — single-
  thread core, loaded from CDN on demand, behind a "convert / fix this file"
  action; not the primary export path, and not bundled into the app until
  the GPL-core distribution question gets a deliberate answer. **Effort: M.**

### Remotion — github.com/remotion-dev/remotion
- **What:** Make videos *programmatically* in React; renders via headless
  Chrome + FFmpeg (Node/Lambda), not in the browser tab.
- **License: ⚠️ NOT open source in the MIT sense** — source-available
  "Remotion License": free for individuals, non-profits and for-profit
  companies with **≤3 employees**; 4+ requires a paid Company License, and
  you may not repackage/resell Remotion itself.
- **Verdict: DO NOT ADOPT** for DemoCut. Wrong architecture (server-side
  render farm vs. local-first tool) *and* a license that would sit
  awkwardly in a public MIT repo. Its one borrowable idea — title cards as
  React components — DemoCut already does with canvas. (Its *sponsored*
  library, Mediabunny above, is the part worth taking.) **Effort: —.**

---

## 3. Small wins — libraries and patterns

### Hotkeys (web side): react-hotkeys-hook — ✅ MIT
- github.com/JohannesKlauss/react-hotkeys-hook — the standard React hook
  (`useHotkeys('mod+shift+r', …)`), actively maintained (v5.x). DemoCut's
  web build currently has no in-page shortcuts to match the Electron global
  ones; this closes that gap in an afternoon.
- Alternative: **tinykeys** (github.com/jamiebuilds/tinykeys) — ✅ MIT,
  ~650 B, zero deps — if avoiding a "framework" dep is preferred.
- **Verdict: ADOPT (either). Effort: S.**

### Auto-zoom & click highlights — pattern, plus a free data source
- No library needed: Cap/OpenScreen prove it's *record clicks during
  capture → generate zoom segments in the editor*. Honest constraint for
  DemoCut: a `getDisplayMedia` web page **cannot see clicks outside the
  shared surface**. But the Electron build can poll
  `electron.screen.getCursorScreenPoint()` (built into Electron, no new
  dependency) at ~10 Hz and timestamp click-ish pauses against the capture —
  good enough for zoom suggestions on the shared display.
- **Verdict: BORROW PATTERN (from Cap/OpenScreen, both understood above);
  desktop-first. Effort: M–L.** Web build: manual zoom segments only.

### Teleprompter — no library worth adopting (honest result)
- No maintained, permissively-licensed React teleprompter library turned up
  in this survey; the OSS teleprompter projects that exist are standalone
  apps, not embeddable components. DemoCut already has the hard part (the
  script pane, persisted). Auto-scroll + large-type "prompter mode" +
  scroll-speed keys is ~a day of plain React/CSS.
- **Verdict: BUILD TINY, borrow the UX shape from any prompter app.
  Effort: S–M.**

### Captions: Whisper in the browser via Transformers.js — ✅ Apache-2.0
- **@huggingface/transformers** (github.com/huggingface/transformers.js) —
  **Apache-2.0**. Its `automatic-speech-recognition` pipeline runs OpenAI
  Whisper ONNX builds (`Xenova/whisper-tiny.en` ≈ 78 MB quantized;
  `whisper-base` ≈ 80–140 MB by dtype) **entirely on-device** (WASM, WebGPU
  where available), returning timestamped chunks — exactly what a
  captions/SRT export needs. Models download once from HF Hub and cache in
  the browser; Whisper's own weights are Apache-2.0. This matches how Cap
  and OpenScreen do local captions, at web scale.
- Cost to state plainly: a ~80 MB first-use model download and
  slower-than-real-time transcription on CPU for long takes. Offer it as
  an explicit "Generate captions" action with the size disclosed — which
  also fits DemoCut's "nothing leaves your machine" promise.
- **Verdict: ADOPT (after the export engine). Effort: M.**
- Alternative noted: **Vosk** (github.com/alphacep/vosk-api, ✅ Apache-2.0,
  ~50 MB streaming models, via `vosk-browser`) — lighter and streaming
  (live captions), noticeably weaker accuracy than Whisper. Only if live
  captions ever outrank export captions. **Effort: M.**

---

## License flags summary (for a public MIT repo)

| Item | License | Safe in DemoCut? |
|---|---|---|
| Mediabunny | MPL-2.0 | ✅ Yes — file-level copyleft on its own files only |
| mp4-muxer / webm-muxer (deprecated) | MIT | ✅ Yes (superseded by Mediabunny) |
| react-hotkeys-hook / tinykeys | MIT | ✅ Yes |
| @huggingface/transformers + Whisper weights | Apache-2.0 | ✅ Yes |
| Vosk | Apache-2.0 | ✅ Yes |
| @ffmpeg/ffmpeg wrapper | MIT | ✅ Yes |
| **@ffmpeg/core / core-mt binaries** | **GPL-2.0-or-later** (FFmpeg + x264/x265 build) | ⚠️ Runtime-load from CDN; notices required; don't bundle into the MIT app/installer without a deliberate decision |
| Cap | AGPLv3 (+ paid license on official builds) | ❌ Patterns only (MIT Rust crates N/A to this stack) |
| Screenity (current) | GPLv3 | ❌ Patterns only |
| OBS Studio | GPL-2.0-or-later | ❌ Patterns only |
| Kooha | GPL-3.0 | ❌ Patterns only |
| LosslessCut | GPL-2.0 | ❌ Patterns only |
| QuickRecorder | AGPLv3 | ❌ Patterns only |
| OpenScreen | MIT | ✅ Patterns (native code doesn't transplant; license wouldn't block it) |
| Remotion | Source-available, paid >3 employees | ❌ Do not adopt |

---

## TOP 5 adoptions for DemoCut (ranked)

1. **Mediabunny (MPL-2.0) as the editor's export engine** — kills the
   real-time re-render: trim/stitch becomes muxing + hardware WebCodecs
   encode, exports drop from minutes to seconds, works on today's Vercel
   deploy with zero header changes, offline in Electron. Keep canvas
   re-render as fallback for non-WebCodecs browsers.
2. **Separate-tracks recording (pattern from Cap/OpenScreen)** — save the
   camera as its own take next to the screen take; editor composites them.
   Unlocks moving/resizing/dropping the facecam after recording — the
   feature every modern recorder is built on.
3. **Captions via Transformers.js Whisper (Apache-2.0)** — on-device
   "Generate captions" → timestamped SRT + optional burned-in captions on
   export, model size disclosed up front. Big demo-quality win, no server,
   no license friction.
4. **react-hotkeys-hook (MIT) for the web build** — brings the web app to
   parity with the Electron global shortcuts (record / pause / stop /
   export) in an afternoon.
5. **ffmpeg.wasm single-thread core (wrapper MIT; core GPL — CDN-loaded,
   on demand) as the universal fallback** — "convert/fix" action for MP4
   export and odd files WebCodecs can't handle, deliberately *not* the
   main path and *not* bundled.

### The single best first move

**Adopt Mediabunny for the editor export (Top 1).** It's the only item that
is simultaneously: permissively licensed for an MIT repo (MPL-2.0),
actively maintained (Remotion-backed), drop-in for DemoCut's exact pain
point (real-time export), and deployable on the current Vercel setup with
no COOP/COEP changes and no 31 MB download. One focused change in
`src/components/Editor.tsx` turns DemoCut's slowest step into its fastest.
