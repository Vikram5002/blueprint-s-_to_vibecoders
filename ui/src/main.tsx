import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerServiceWorker } from './pwa';
import { installApiHeaders } from './hosted-client';
import { HostedGate } from './HostedGate';
import './styles.css';
import './design/theme.css';

registerServiceWorker();
installApiHeaders();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('missing #root');
}

createRoot(container).render(
  <StrictMode>
    <HostedGate>
      <App />
    </HostedGate>
  </StrictMode>,
);
