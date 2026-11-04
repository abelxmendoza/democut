import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// One stamp per build: embedded in the bundle (as __BUILD_ID__) and
// emitted as version.json, so a running tab can notice a newer deploy
// and offer the update instead of silently serving a stale build.
const buildId =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ||
  process.env.GITHUB_SHA?.slice(0, 12) ||
  new Date().toISOString()

function versionStamp(): Plugin {
  return {
    name: 'democut-version-stamp',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ build: buildId }),
      })
    },
  }
}

// base './' so the same build works on GitHub Pages, file:// and inside Electron
export default defineConfig({
  plugins: [react(), versionStamp()],
  base: './',
  define: { __BUILD_ID__: JSON.stringify(buildId) },
})
