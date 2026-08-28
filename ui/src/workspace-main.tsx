import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceShell } from './workspace/WorkspaceShell';
// Required, not cosmetic: sets pointer-events/position on React Flow's
// internal panes (.react-flow__background, __pane, __viewport). Without it
// the background layer can intercept clicks meant for a node or edge
// beneath it — found while browser-testing WorkflowGraph's click targets,
// the exact failure class this project has hit before with ReactFlow.
import '@xyflow/react/dist/base.css';
import './workspace/workspace.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <WorkspaceShell />
  </StrictMode>,
);
