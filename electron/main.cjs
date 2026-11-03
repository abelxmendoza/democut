// DemoCut desktop shell (Electron)
// Same React app as the web build, plus the things a browser can't do:
//  - a real app window / Dock icon
//  - global hotkeys that work while your demo app is focused
//    (Cmd/Ctrl+Shift+R = record/stop, Cmd/Ctrl+Shift+P = pause/resume)
//    forwarded to the renderer as keyboard events / custom events
//  - desktopCapturer source listing for a future native source picker
// Web-only features stay in the renderer; nothing here re-implements recording.
const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, dialog } = require('electron')
const path = require('path')
const fs = require('fs')

const isDev = !app.isPackaged

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b0f14',
    title: 'DemoCut',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
  return win
}

app.whenReady().then(() => {
  const win = createWindow()

  const send = (channel) => {
    if (!win.isDestroyed()) win.webContents.send(channel)
  }
  globalShortcut.register('CommandOrControl+Shift+R', () => send('democut:toggle-record'))
  globalShortcut.register('CommandOrControl+Shift+P', () => send('democut:toggle-pause'))

  // Native screen/window source list (for a future in-app picker;
  // today getDisplayMedia in the renderer already shows the OS picker)
  ipcMain.handle('democut:list-sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 } })
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }))
  })

  // Save a finished take straight to disk (no browser download step)
  ipcMain.handle('democut:save-take', async (_e, { name, bytes }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('videos'), name),
      filters: [{ name: 'Video', extensions: ['webm', 'mp4'] }],
    })
    if (canceled || !filePath) return { saved: false }
    fs.writeFileSync(filePath, Buffer.from(bytes))
    return { saved: true, filePath }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
