import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Expose zustand store in development for testing
if (import.meta.env.DEV) {
  import('./store/chat').then(({ useChatStore }) => {
    (window as any).__DA_STORE__ = useChatStore;
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
