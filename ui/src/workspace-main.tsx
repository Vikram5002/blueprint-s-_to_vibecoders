import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceShell } from './workspace/WorkspaceShell';
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
