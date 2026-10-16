/* global document, window */
const api = window.localAI;
const byId = (id) => document.getElementById(id);
let busy = false;
function render(state) {
  busy = state.busy;
  byId('models').textContent = state.models.join('  /  ');
  byId('size').textContent = `${state.downloadGB.toFixed(2)} GB download for both base models. The runtime and trained adapters are included.`;
  byId('folder').textContent = state.folder;
  byId('status').textContent = state.message;
  byId('status').classList.toggle('error', Boolean(state.error));
  byId('cancel').hidden = !busy;
  byId('stop').hidden = !state.enabled;
  byId('continue').disabled = busy;
  byId('continue').textContent = state.enabled ? 'Open workspace' : 'Continue without local AI';
  for (const id of ['check', 'choose', 'mode', 'download', 'import']) byId(id).disabled = busy || state.enabled;
  const hardware = state.hardware;
  if (hardware) {
    const graphics = hardware.devices.map((d) => `${d.name} · ${(d.memoryMB / 1024).toFixed(1)} GB ${d.shared === false ? 'VRAM' : 'shared / reported memory'}`).join('\n') || 'No compatible GPU detected';
    byId('hardware').textContent = `${hardware.cpu} · ${hardware.threads} threads\n${hardware.ramGB.toFixed(1)} GB RAM · ${hardware.availableGB.toFixed(1)} GB currently available\n${graphics}\n${hardware.freeGB === null ? 'Choose a folder to check free disk space' : hardware.freeGB.toFixed(1) + ' GB free disk space'}`;
    byId('recommendation').textContent = hardware.recommendation.reason;
    if (!hardware.recommendation.supported) { byId('download').disabled = true; byId('import').disabled = true; }
    for (const option of byId('mode').options) if (['gpu', 'hybrid'].includes(option.value)) option.disabled = !hardware.recommendation.device;
  }
  const p = state.progress;
  const progress = byId('progress');
  const label = byId('progress-label');
  progress.hidden = label.hidden = !busy && !state.enabled;
  if (state.enabled && !busy) {
    progress.value = 100;
    label.textContent = 'Setup complete — 100%';
  } else if (p && p.total > 0 && ['Downloading', 'Verifying'].includes(p.phase)) {
    const percent = Math.min(100, Math.max(0, Math.floor(p.received / p.total * 100)));
    progress.value = percent;
    label.textContent = p.phase === 'Verifying'
      ? `File downloaded — ${percent}%. Verifying before continuing…`
      : `Downloading this file: ${percent}% · ${(p.received / 1e9).toFixed(2)} / ${(p.total / 1e9).toFixed(2)} GB`;
  } else {
    // Hardware checks and model loading have no measurable byte percentage.
    progress.removeAttribute('value');
    label.textContent = p?.phase === 'Checking' ? 'Checking existing file…' : 'Setup in progress…';
  }
}
async function call(action) {
  try { const result = await action(); if (result?.error) throw new Error(result.error); }
  catch (error) { byId('status').textContent = error.message; byId('status').classList.add('error'); }
}
byId('check').onclick = () => call(() => api.check());
byId('choose').onclick = () => call(() => api.folder());
byId('download').onclick = () => call(() => api.setup(byId('mode').value, false));
byId('import').onclick = () => call(() => api.setup(byId('mode').value, true));
byId('cancel').onclick = () => call(() => api.cancel());
byId('stop').onclick = () => call(() => api.stop());
byId('continue').onclick = () => { if (!busy) void call(() => api.continue()); };
api.subscribe(render);
void call(async () => { render(await api.state()); await api.check(); });
