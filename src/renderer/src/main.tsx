import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import 'dockview-react/dist/styles/dockview.css'
import './styles.css'
import { App } from './App'
import { IN_VSCODE } from './host'
import { installOverflowTabs } from './shell/overflowTabs'
import { installRenameSync } from './store/sync'
import { installVscodeApi } from './vscodeApi'
import { installWebApi } from './webApi'

if (IN_VSCODE) installVscodeApi()
else installWebApi()
installRenameSync()
installOverflowTabs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
