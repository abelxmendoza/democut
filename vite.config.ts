import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' so the same build works on GitHub Pages, file:// and inside Electron
export default defineConfig({
  plugins: [react()],
  base: './',
})
