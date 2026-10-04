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

/** VS Code side bar view: the side tools in tabs, following the active project document; the diagram
 *  is elsewhere. */
export const IN_PANEL = IN_VSCODE && window.scaffoldInit?.mode === 'panel'

/** Tab the side bar view shows first, else the one shown last. */
export const FIRST_SIDE_TAB = (IN_PANEL && window.scaffoldInit?.panel) || null

/** VS Code diagram: full diagram editor or preview, not a side panel. Switches between the layouts. */
export const IN_DIAGRAM = IN_VSCODE && !IN_PANEL

/** VS Code diagram in the full layout: every tool docked in the page, like the web app. */
export const FULL_LAYOUT = IN_DIAGRAM && window.scaffoldInit?.layout === 'full'

/** VS Code page whose Explorer and Code generation are in the VS Code side bar (not the full layout). */
export const INTEGRATED = IN_VSCODE && !FULL_LAYOUT

/** Preview in the integrated layout: no menu bar, tools opened on demand. */
export const COMPACT = IN_PREVIEW && !FULL_LAYOUT

/** Light or dark, after the VS Code color theme (class of the body). */
export function vscodeTheme(): 'light' | 'dark' {
  const c = document.body.classList
  return c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? 'light' : 'dark'
}
