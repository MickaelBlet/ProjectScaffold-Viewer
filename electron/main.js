// Electron shell around the single-file web build (dist-web/index.html).
// Frameless window: the app toolbar moves it, the page draws the resize edges and window buttons.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIN_WIDTH = 640
const MIN_HEIGHT = 400

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    // Shown once the page has painted: no white window at startup.
    show: false,
    title: 'ProjectScaffold',
    icon: join(root, 'electron/icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, preload: join(root, 'electron/preload.cjs') }
  })
  // External links open in the system browser, never in a new app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // The page never navigates away from the app: links go through the handler above.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  // The page blocks unloading while documents are unsaved: ask instead of ignoring the close.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Close', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Close ProjectScaffold?',
      detail: 'Some documents have unsaved changes.'
    })
    if (choice === 0) e.preventDefault()
  })
  win.once('ready-to-show', () => win.show())
  const sendMaximized = () => win.webContents.send('window:maximized', win.isMaximized())
  win.on('maximize', sendMaximized)
  win.on('unmaximize', sendMaximized)
  win.loadFile(join(root, 'dist-web/index.html'))
}

const sender = (e) => BrowserWindow.fromWebContents(e.sender)

ipcMain.on('window:minimize', (e) => sender(e)?.minimize())
ipcMain.on('window:toggleMaximize', (e) => {
  const win = sender(e)
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.on('window:close', (e) => sender(e)?.close())
ipcMain.handle('window:isMaximized', (e) => sender(e)?.isMaximized() ?? false)

// Resize from an edge: bounds at the start of the drag, moved by the pointer offset since then.
let resizeStart = null
ipcMain.on('window:resizeStart', (e) => {
  resizeStart = sender(e)?.getBounds() ?? null
})
ipcMain.on('window:resize', (e, edge, dx, dy) => {
  const win = sender(e)
  if (!win || !resizeStart) return
  let { x, y, width, height } = resizeStart
  if (edge.includes('e')) width = Math.max(MIN_WIDTH, width + dx)
  if (edge.includes('s')) height = Math.max(MIN_HEIGHT, height + dy)
  if (edge.includes('w')) {
    const w = Math.max(MIN_WIDTH, width - dx)
    x += width - w
    width = w
  }
  if (edge.includes('n')) {
    const h = Math.max(MIN_HEIGHT, height - dy)
    y += height - h
    height = h
  }
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
})

// The app has its own menu bar.
Menu.setApplicationMenu(null)
app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
