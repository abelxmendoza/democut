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
- **Demo script pane** — talking points next to the preview, auto-saved to localStorage.
- **Takes library** — every finished recording lands in the page with a player, duration, size, download and delete.
- **Built-in editor** — trim the start/end of each take with sliders, include/exclude and reorder takes, add a title card, and export one edited video (rendered locally via canvas + MediaRecorder; originals are never modified).
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

## Honest limits

- Browser system-audio capture is limited to what `getDisplayMedia` exposes (best in Chrome, tab audio). Your microphone is always captured.
- Takes live in memory for the session — download the keepers before closing the tab (desktop build saves to disk).
- The exported format is WebM in most browsers (MP4 where the browser's `MediaRecorder` supports it — the app picks the best available automatically).

## Project layout

```
src/App.tsx            UI: preview, controls, takes, script pane
src/lib/recorder.ts    compositing engine + capture helpers
electron/main.cjs      desktop shell: window, global hotkeys, save-to-disk, source list
electron/preload.cjs   safe bridge (contextIsolation, no node in renderer)
```

## Roadmap

- Native system-audio capture in the desktop build
- In-app source picker using `desktopCapturer` thumbnails (main-process API already wired)
- Auto-save takes to a chosen folder + recordings history on disk
- One-click trim of head/tail silence

---

Made by Abel Mendoza. MIT licensed.
