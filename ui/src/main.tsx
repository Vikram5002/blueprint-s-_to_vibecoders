import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerServiceWorker } from './pwa';
import './styles.css';
import './design/theme.css';

registerServiceWorker();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('missing #root');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
