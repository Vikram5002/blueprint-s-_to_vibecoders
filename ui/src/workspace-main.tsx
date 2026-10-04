import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceShell } from './workspace/WorkspaceShell';
import { registerServiceWorker } from './pwa';
import { installApiHeaders } from './hosted-client';
import { HostedGate } from './HostedGate';
// Required, not cosmetic: sets pointer-events/position on React Flow's
// internal panes (.react-flow__background, __pane, __viewport). Without it
// the background layer can intercept clicks meant for a node or edge
// beneath it — found while browser-testing WorkflowGraph's click targets,
// the exact failure class this project has hit before with ReactFlow.
import '@xyflow/react/dist/base.css';
import './workspace/workspace.css';
// After Tailwind, so its preflight reset does not undo the shared base styles.
import './design/theme.css';

registerServiceWorker();
installApiHeaders();

const container = document.getElementById('root');
if (container === null) {
  throw new Error('missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <HostedGate>
      <WorkspaceShell />
    </HostedGate>
  </StrictMode>,
);
