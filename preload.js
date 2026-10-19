const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  pick: call('pick'),
  run: call('run'),
  openFolder: call('open-folder'),
  reveal: call('reveal'),
  openKeysPage: call('open-keys-page'),
  getSettings: call('settings-get'),
  saveKey: call('save-key'),
  setMode: call('set-mode'),
  installGpu: call('gpu-install'),
  removeGpu: call('gpu-remove'),
  onLog: (cb) => ipcRenderer.on('log', (_e, m) => cb(m)),
  onGpuProgress: (cb) => ipcRenderer.on('gpu-progress', (_e, p) => cb(p)),
});

// File.path is gone in modern Electron; resolve dropped files here and hand the path to the page.
window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) window.postMessage({ type: 'dropped', path: webUtils.getPathForFile(f) }, '*');
  });
});
