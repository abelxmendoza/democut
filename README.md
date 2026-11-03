# DemoCut

**Record software demos fast: your screen, your face in the top-right corner, your voice — composited live into a single video file. Then trim, stitch and title your takes in the built-in editor.**

Built for Abel Mendoza's demo workflow (RobotForge, PX4, Darkstar and everything after): open the thing, hit Record, wait out the 3-2-1, talk, stop, download, post.

![stack](https://img.shields.io/badge/React-18-61dafb) ![stack](https://img.shields.io/badge/TypeScript-5-3178c6) ![stack](https://img.shields.io/badge/Vite-6-646cff) ![stack](https://img.shields.io/badge/Electron-33-47848f) ![stack](https://img.shields.io/badge/Tailwind-3-38bdf8)

## Web app or native desktop? Both — one codebase

**Answer to the question I asked myself building this:** a demo recorder *wants* to be native (system-wide capture, global hotkeys, save straight to a folder, works while the demo app is focused). But a web core is what makes it instant to use anywhere and trivial to share.

So DemoCut is a **web app first (React + browser capture APIs), wrapped in Electron for desktop**:

| | Web (browser) | Desktop (Electron) |
|---|---|---|
| Install | none — open the page | `npm run dist` builds Mac/Win/Linux installers |
| Screen capture | `getDisplayMedia` (OS picker) | same, plus `desktopCapturer` source listing |
| Facecam PiP | canvas compositing, top-right | identical |
| Global hotkeys | in-page only | **Cmd/Ctrl+Shift+R** record, **Cmd/Ctrl+Shift+P** pause — work while your demo is focused |
| Saving a take | browser download | save dialog → straight to your Videos folder |
| System audio | tab/Chrome share only (browser limit) | same web limit today; native capture is the roadmap item, stated honestly, not faked |

## Features

- **Live compositing engine** (`src/lib/recorder.ts`) — screen drawn full-frame on a `<canvas>`, webcam drawn as a rounded, teal-bordered picture-in-picture in the **top-right**, mic + screen audio mixed into one `MediaRecorder` stream. The file you download already has your face in it.
- **3-2-1 countdown** before recording starts, so you're never on camera fumbling for the button.
- **Pause / resume** mid-demo instead of restarting a take.
- **Live mic level meter** (Web Audio analyser) so you catch a dead mic *before* the take.
- **Facecam controls** — size (S/M/L), on/off, mirror on/off. Quality 720p/1080p, 30/60 fps.
- **Projects** — one project per app you're demoing. Eight built-in presets (RobotForge, PX4, Omega-1, …) are starting templates; hit **+** to create your own, rename it, and delete it when it's done. Each project keeps its own script, title card and takes — everything auto-saves in your browser (projects + edits in localStorage, take files in IndexedDB), so it's all still there after a reload or a restart.
- **Demo script pane** — talking points next to the preview, auto-saved per project.
- **Takes library** — every finished recording lands in its project's library with a player, duration, size, download and delete — and persists across reloads.
- **Built-in editor** — trim the start/end of each take with sliders, include/exclude and reorder takes, add a title card, and export one edited video (rendered locally via canvas + MediaRecorder; originals are never modified). **Splice all takes** puts every take in the project into the edit in recording order, in one click.
- **Private by default** — everything runs locally. No upload, no account, no analytics.

## Deploy the web app (Vercel)

DemoCut's web build deploys on Vercel — the repo carries a `vercel.json`
(framework: Vite, build: `npm run build`, output: `dist`), so it's a one-time import:

1. In Vercel: **Add New → Project → import `abelxmendoza/democut`**
2. Keep the detected defaults and deploy — no env vars needed
3. Every later push to `main` auto-deploys

Note: screen/camera recording needs a secure context — the `*.vercel.app`
HTTPS URL qualifies (so does `localhost` for local dev).

## Run it

```bash
npm install

npm run dev        # web app → http://localhost:5173
npm run desktop    # Electron desktop app (dev)
npm run build      # production web build → dist/
npm run dist       # installers via electron-builder (mac/win/linux)
```

Then: **Set up screen + camera → pick the window → Record → talk → Stop & save take → Download.**

## Phone videos + mobile app demos

- **Upload anything:** the takes library takes video files from your computer
  or phone — including iPhone Screen Recordings from Photos (.mov/.mp4).
  Uploaded clips get the full editor: trim, reorder/stitch, title card, export.
- **Demoing a mobile app:** record the app on the phone itself (iOS Control
  Center → Screen Recording, long-press → Microphone On for narration), then
  upload the clip to DemoCut and edit it there. The **Mobile App Demo** preset
  loads that whole workflow as a checklist + script.
- **Or mirror the phone to your Mac** (QuickTime / AirPlay) and screen-record
  the mirrored window with DemoCut to get the live facecam PiP.
- Facecam *overlay* onto an uploaded phone clip (record face separately,
  composite in the editor) is the separate-tracks upgrade from the OSS survey —
  on the roadmap, not in v1.

## Before your first recording (2 minutes)

1. Use Chrome (or the Electron build) and grant screen + camera + mic
   permissions; on macOS, Chrome/your browser also needs **Screen Recording**
   permission in System Settings → Privacy & Security.
2. Do a 10-second test take and play it back — check facecam position, mic
   level, and that you can hear yourself.
3. Pick your project (or make a new one with **+**), open what it says to open, then record.
4. Takes now persist in the browser between sessions — still download anything important; browser storage can be evicted under disk pressure, and private windows don't keep it.

## Honest limits

- Browser system-audio capture is limited to what `getDisplayMedia` exposes (best in Chrome, tab audio). Your microphone is always captured.
- Takes persist locally in IndexedDB on this machine/browser — that is not a backup. Download the keepers (the desktop build saves to disk).
- The exported format is WebM in most browsers (MP4 where the browser's `MediaRecorder` supports it — the app picks the best available automatically).

## Project layout

```
src/App.tsx            UI: preview, controls, takes, script pane
src/lib/recorder.ts    compositing engine + capture helpers
electron/main.cjs      desktop shell: window, global hotkeys, save-to-disk, source list
electron/preload.cjs   safe bridge (contextIsolation, no node in renderer)
```

## Built on open source

DemoCut borrows ideas and code only where licenses allow (survey with per-project
license verdicts: [docs/OSS-SURVEY.md](docs/OSS-SURVEY.md)):

- **Mediabunny** (MPL-2.0, WebCodecs) — fast single-take trim export, loaded on demand
- **react-hotkeys-hook** (MIT) — web-build shortcuts (Cmd/Ctrl+Shift+R / +P)
- Patterns borrowed, code NOT copied (GPL/AGPL): Cap & OpenScreen's separate-tracks
  recording and auto-zoom-from-clicks, OBS/Screenity UX, LosslessCut's trim UI
- Deliberately NOT adopted: ffmpeg.wasm as the main engine — its distributed core
  bundles GPL x264/x265; kept as a possible on-demand fallback only (see survey)

## Roadmap

- Native system-audio capture in the desktop build
- In-app source picker using `desktopCapturer` thumbnails (main-process API already wired)
- Auto-save takes to a chosen folder + recordings history on disk
- One-click trim of head/tail silence

---

Made by Abel Mendoza. MIT licensed.
