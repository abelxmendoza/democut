// Per-project demo presets: pick a project, get its title card text,
// a talking-points script, and a before-you-record checklist.
// Honesty notes are baked in per project (simulation vs real, etc.) —
// read numbers off the screen you're showing, never from memory.

export interface ProjectPreset {
  id: string
  name: string
  title: string
  openFirst: string
  script: string
}

// A project in the app: either a built-in preset above (a starting
// template) or one the user created. User projects and per-preset
// script/title edits persist in localStorage (see App).
export interface Project extends ProjectPreset {
  builtin: boolean
  /** Target demo length in seconds for the pace guide (default 180). */
  targetSec?: number
}

export const NEW_PROJECT_SCRIPT = `1. What it is — one sentence, who it's for
2. The problem it solves — show the pain, don't just say it
3. The main flow, end to end, no cuts
4. The proof — output, tests, numbers ON SCREEN
5. Close — what works today, what's next, where to find it`

export const PRESETS: ProjectPreset[] = [
  {
    id: 'generic',
    name: 'Generic project',
    title: 'Project Demo',
    openFirst: 'Open the project itself, full-screen, at the screen you will start from.',
    script: `1. What it is — one sentence, who it's for
2. The problem it solves — show the pain, don't just say it
3. The main flow, end to end, no cuts
4. The proof — output, tests, numbers ON SCREEN
5. Close — what works today, what's next, where to find it`,
  },
  {
    id: 'robotforge',
    name: 'RobotForge',
    title: 'RobotForge — Demo',
    openFirst: 'Open https://robot-forge-hackathon.vercel.app/ signed in or in demo mode, Workshop loaded.',
    script: `1. Hook: "Tell it a robot, it builds the plan" — open on the Workshop
2. Type a plain-language build request in chat; let the reply land on screen
3. Show the Robodex card for the robot it picked
4. Show a verification/gate result — read the PASS/FAIL and numbers OFF THE SCREEN
5. Show the parts kit / build plan (on-hand vs future split)
6. Close: what it is, the Nov 4 hackathon deadline context if relevant, URL on screen`,
  },
  {
    id: 'px4',
    name: 'PX4 Autonomous Missions',
    title: 'PX4 Missions — Simulation Demo',
    openFirst: 'Open the PX4 SITL/SIH session or the mission repo + a recorded log. Say "simulation" out loud in the first 10 seconds.',
    script: `1. Frame it honestly: "This is PX4 simulation (SITL/SIH) — not a real flight"
2. Show the mission: waypoints / code that defines it
3. Run or replay the simulated flight; narrate what the vehicle is doing
4. Show the log/telemetry proof on screen
5. Failure-injection beat if you have it: what breaks, what the system does
6. Close: what this proves, what real-hardware step comes next`,
  },
  {
    id: 'omega1',
    name: 'Omega-1',
    title: 'Omega-1 — Demo',
    openFirst: 'Omega-1 powered/connected or its control view open. Be ready to say how it is actually driven today.',
    script: `1. What Omega-1 is: a Raspberry Pi robot I built and control
2. Honest control beat: "Today it's manual remote control — autonomy is in progress, including in simulation"
3. Drive it / show it responding live
4. Show the hardware: Pi, motors, camera if fitted
5. What's next: the autonomy step you're building toward
6. Close: what works today vs what's planned — keep them separate`,
  },
  {
    id: 'darkstar',
    name: 'Darkstar Robotics',
    title: 'Darkstar Robotics — Demo',
    openFirst: 'Launch the Darkstar Robotics app (BUILD • EXPLORE • DEPLOY) on the Dashboard.',
    script: `1. What Darkstar is: a control center for running robotics/Linux apps on your own computer
2. Tour the Dashboard — what it detects about this machine
3. Show a pre-flight / compatibility check running
4. Show an environment or runtime starting (or its honest status if it can't)
5. Close: Mac-first today, what the next milestone is (a truthful compatibility report from a real machine)`,
  },
  {
    id: 'reconboard',
    name: 'ReconBoard',
    title: 'ReconBoard — Demo',
    openFirst: 'Open https://recon-board-rho.vercel.app and sign in / load a past run.',
    script: `1. What ReconBoard is: OSINT/recon tools in one hosted board
2. Pick one tool and run it live on a safe, public target (example.com class)
3. Show run history + the diff between two runs
4. Show cooperative cancel or a second tool briefly
5. Close: it's fully hosted, the tools run server-side, URL on screen`,
  },
  {
    id: 'democut',
    name: 'DemoCut (demo the demo tool)',
    title: 'DemoCut — Record, Cut, Ship',
    openFirst: 'Open DemoCut itself in a separate window — record the other window, not this one.',
    script: `1. The problem: demo videos take too many tools (recorder + editor + uploads)
2. Set up screen + camera; point at the facecam in the top-right of the preview
3. Record a few seconds, pause, resume — show it working
4. Stop; show the take in the library
5. Editor beat: trim a flub, reorder, add this title card, export
6. Close: one app, record → cut → ship`,
  },
  {
    id: 'mobile',
    name: 'Mobile App Demo (phone)',
    title: 'Mobile App Demo',
    openFirst: 'On your iPhone: Settings → Control Center → add Screen Recording. Then open the app you are demoing.',
    script: `1. On the phone: swipe into Control Center, LONG-PRESS the Record button, turn Microphone ON (so your narration is captured), then start recording
2. Demo the app slowly — narrate every tap, pause a beat after each screen change
3. Stop recording; the clip lands in Photos
4. Open DemoCut (live site or desktop), hit "Upload a video", pick that clip
5. In the editor: trim the Control Center head/tail, add the title card, export
6. Honest note: facecam overlay on phone clips is the separate-tracks upgrade on the roadmap — today the phone clip carries your voice, not your face`,
  },
]
