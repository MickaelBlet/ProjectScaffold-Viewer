// Host of the page: a browser or desktop window, or a VS Code webview editing one project file
// (see vscodeApi.ts).
import type { ToHost, WebviewInit } from '../../../vscode/src/protocol'

interface VsCodeApi {
  postMessage(msg: ToHost): void
  getState(): unknown
  setState(state: unknown): void
}

/** Defined by VS Code in its webviews only. */
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined

declare global {
  interface Window {
    /** Set by the extension before the page scripts run. */
    scaffoldInit?: WebviewInit
  }
}

/** The webview API, null outside VS Code. acquireVsCodeApi may only be called once. */
export const vscode: VsCodeApi | null = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null

export const IN_VSCODE = vscode !== null

/** VS Code preview beside the text: compact UI, and the page's own undo history. */
export const IN_PREVIEW = IN_VSCODE && window.scaffoldInit?.mode === 'preview'

/** VS Code side bar: a single tool panel following the active project document; the diagram is elsewhere. */
export const SIDE_PANEL = (IN_VSCODE && window.scaffoldInit?.panel) || null
export const IN_PANEL = SIDE_PANEL !== null

/** Light or dark, after the VS Code color theme (class of the body). */
export function vscodeTheme(): 'light' | 'dark' {
  const c = document.body.classList
  return c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? 'light' : 'dark'
}
