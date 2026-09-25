import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import 'dockview-react/dist/styles/dockview.css'
import './styles.css'
import { App } from './App'
import { installWebApi } from './webApi'

installWebApi()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
