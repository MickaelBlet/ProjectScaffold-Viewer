import { app, BrowserWindow, dialog, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { MenuAction, OpenResult, SaveRequest } from '../preload/api'

const FILTERS = {
  yaml: { name: 'YAML', extensions: ['yaml', 'yml'] },
  json: { name: 'JSON', extensions: ['json'] }
}

// Chromium cannot start sandboxed child processes from a network path (e.g. \\wsl.localhost\...):
// the app would exit immediately. Only there, run without the process sandbox; the renderer
// still loads local content only, with context isolation and a strict CSP.
if (process.platform === 'win32' && /^\\\\/.test(process.execPath)) {
  app.commandLine.appendSwitch('no-sandbox')
}

let win: BrowserWindow | null = null
let dirty = false

function send(action: MenuAction): void {
  win?.webContents.send('menu', action)
}

// Recent project files, most recent first, persisted in the user data directory.
const MAX_RECENT = 10
const recentStore = (): string => join(app.getPath('userData'), 'recent.json')
let recent: string[] = []

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

async function loadRecent(): Promise<void> {
  try {
    const data: unknown = JSON.parse(await readFile(recentStore(), 'utf8'))
    recent = Array.isArray(data) ? data.filter((p) => typeof p === 'string').slice(0, MAX_RECENT) : []
  } catch {
    recent = []
  }
}

function setRecent(list: string[]): void {
  recent = list.slice(0, MAX_RECENT)
  const file = recentStore()
  void mkdir(dirname(file), { recursive: true })
    .then(() => writeFile(file, JSON.stringify(recent, null, 2), 'utf8'))
    .catch(() => undefined)
  buildMenu()
  win?.webContents.send('recent', recent)
}

function remember(path: string): void {
  setRecent([path, ...recent.filter((p) => !samePath(p, path))])
  app.addRecentDocument(path)
}

function forget(path: string): void {
  setRecent(recent.filter((p) => !samePath(p, path)))
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const item = (label: string, action: MenuAction, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send(action)
  })
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        item('New', 'new', 'CmdOrCtrl+N'),
        item('Open…', 'open', 'CmdOrCtrl+O'),
        {
          label: 'Open Recent',
          submenu: [
            ...recent.map(
              (path): MenuItemConstructorOptions => ({
                // '&' marks a mnemonic in menu labels.
                label: path.replace(/&/g, '&&'),
                click: () => win?.webContents.send('menu:open-recent', path)
              })
            ),
            ...(recent.length ? [{ type: 'separator' } as MenuItemConstructorOptions] : []),
            {
              label: 'Clear Recently Opened',
              enabled: recent.length > 0,
              click: () => {
                setRecent([])
                app.clearRecentDocuments()
              }
            }
          ]
        },
        { type: 'separator' },
        item('Save', 'save', 'CmdOrCtrl+S'),
        item('Save As…', 'save-as', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        item('Export YAML…', 'export-yaml', 'CmdOrCtrl+E'),
        item('Export JSON…', 'export-json', 'CmdOrCtrl+Shift+E'),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        item('Undo', 'undo', 'CmdOrCtrl+Z'),
        item('Redo', 'redo', isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Add Module', 'add-module', 'CmdOrCtrl+M')
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'ProjectScaffold',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('close', (e) => {
    if (!dirty || !win) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'You have unsaved changes.',
      detail: 'Close anyway and lose them?'
    })
    if (choice === 1) e.preventDefault()
  })
  win.on('closed', () => {
    win = null
  })

  // Links open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

ipcMain.handle('file:open', async (): Promise<OpenResult | null> => {
  if (!win) return null
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Architecture', extensions: ['yaml', 'yml', 'json'] }, FILTERS.yaml, FILTERS.json]
  })
  const path = res.filePaths[0]
  if (res.canceled || !path) return null
  const content = await readFile(path, 'utf8')
  remember(path)
  return { path, content }
})

/** Reads a project file and moves it to the top of the recent list; drops it when unreadable. */
async function openKnown(path: string): Promise<OpenResult | null> {
  try {
    const content = await readFile(path, 'utf8')
    remember(path)
    return { path, content }
  } catch {
    forget(path)
    return null
  }
}

// At startup: the project file given on the command line, else the last opened one.
ipcMain.handle('file:initial', async (): Promise<OpenResult | null> => {
  const arg = process.argv.slice(1).find((a) => !a.startsWith('-') && /\.(ya?ml|json)$/i.test(a))
  if (arg) return openKnown(resolve(arg))
  for (const path of [...recent]) {
    const file = await openKnown(path)
    if (file) return file
  }
  return null
})

ipcMain.handle('recent:list', (): string[] => recent)

// Only paths already in the list can be read, never an arbitrary one.
ipcMain.handle('recent:open', (_e, path: string): Promise<OpenResult | null> =>
  recent.some((p) => samePath(p, path)) ? openKnown(path) : Promise.resolve(null)
)

ipcMain.handle('recent:clear', (): void => {
  setRecent([])
  app.clearRecentDocuments()
})

ipcMain.handle('file:save', async (_e, req: SaveRequest): Promise<string | null> => {
  if (!win) return null
  let path = req.path
  if (!path) {
    const res = await dialog.showSaveDialog(win, {
      title: req.title,
      defaultPath: req.defaultName,
      filters: [FILTERS[req.format]]
    })
    if (res.canceled || !res.filePath) return null
    path = res.filePath
  }
  await writeFile(path, req.content, 'utf8')
  if (!req.export) {
    remember(path)
    win.setRepresentedFilename?.(path)
  }
  return path
})

ipcMain.on('app:dirty', (_e, value: boolean) => {
  dirty = value
  win?.setDocumentEdited?.(value)
})

void app.whenReady().then(async () => {
  await loadRecent()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
