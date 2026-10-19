const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { processVideo: clip } = require('./pipeline');

const CUDA_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip'; // ~653 MB
const KEYS_URL = 'https://aistudio.google.com/apikey';

// settings.json in the user's app-data folder: {key: base64 DPAPI-encrypted Gemini key, gpu: bool}
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
};
const save = (patch) => {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify({ ...load(), ...patch }));
};
const getKey = () => {
  const { key } = load();
  try {
    return key ? safeStorage.decryptString(Buffer.from(key, 'base64')) : '';
  } catch {
    return '';
  }
};

// ProgramData (not userData): the path must be ASCII-only for whisper-cli, and a user profile name may have accents.
const cudaRoot = () => path.join(process.env.ProgramData || app.getPath('userData'), 'AutoClipper', 'whisper-cuda');
const cudaDir = () => path.join(cudaRoot(), 'Release');
const gpuInstalled = () => fs.existsSync(path.join(cudaDir(), 'whisper-cli.exe'));
const hasNvidia = () =>
  process.platform === 'win32' ? new Promise((res) => execFile('nvidia-smi', ['-L'], { windowsHide: true }, (e) => res(!e))) : Promise.resolve(false);
// Names of the video adapters Windows reports (shown in Settings so the user knows what will be used).
let gpuNames;
const listGpus = () =>
  process.platform !== 'win32' ? Promise.resolve([]) : (gpuNames ||= new Promise((res) =>
    execFile('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'], { windowsHide: true }, (e, out) =>
      res(e ? [] : out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
    )
  ));

// Packaged: whisper (Vulkan + CPU build) and the model ship in resources/whisper. Dev: ../whisper-vk (build) + ../whisper (model).
function config() {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'whisper') : path.join(__dirname, '..', 'whisper');
  return {
    geminiKey: getKey(),
    mode: load().mode || 'auto', // 'auto' | 'cpu' | 'cuda' (see transcribe in pipeline.js)
    lang: 'pt',
    whisperDir: app.isPackaged ? base : path.join(__dirname, '..', 'whisper-vk'),
    model: path.join(base, 'ggml-small.bin'),
    cudaDir: cudaDir(),
  };
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    title: 'AutoClipper',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  if (process.platform !== 'darwin') win.removeMenu(); // macOS needs its menu for Cmd+C/V shortcuts
  win.loadFile('index.html');

  ipcMain.handle('pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'flv'] }] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('open-folder', (_e, dir) => shell.openPath(dir));
  ipcMain.handle('reveal', (_e, file) => shell.showItemInFolder(file));
  ipcMain.handle('open-keys-page', () => shell.openExternal(KEYS_URL));

  // The key itself never goes back to the page; only a hint of its last 4 characters.
  ipcMain.handle('settings-get', async () => {
    const key = getKey();
    return { platform: process.platform, hasKey: !!key, keyHint: key.slice(-4), mode: config().mode, gpuInstalled: gpuInstalled(), nvidia: await hasNvidia(), gpus: await listGpus() };
  });
  ipcMain.handle('save-key', (_e, key) => save({ key: safeStorage.encryptString(String(key).trim()).toString('base64') }));
  ipcMain.handle('set-mode', (_e, mode) => save({ mode: ['auto', 'cpu', 'cuda'].includes(mode) ? mode : 'auto' }));

  ipcMain.handle('gpu-install', async () => {
    const zip = cudaRoot() + '.zip';
    try {
      fs.mkdirSync(cudaRoot(), { recursive: true });
      const r = await fetch(CUDA_URL);
      if (!r.ok) throw new Error(`Download falhou (${r.status})`);
      const total = Number(r.headers.get('content-length')) || 653e6;
      const out = fs.createWriteStream(zip);
      let got = 0;
      for await (const chunk of r.body) {
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
        win.webContents.send('gpu-progress', Math.min(99, Math.round((got / total) * 100)));
      }
      await new Promise((res) => out.end(res));
      // Windows ships bsdtar, which unzips .zip; call it by full path so a stray tar on PATH can't interfere.
      await new Promise((res, rej) =>
        execFile(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', zip, '-C', cudaRoot()], { windowsHide: true }, (e) => (e ? rej(e) : res()))
      );
      fs.rmSync(zip, { force: true });
      if (!gpuInstalled()) throw new Error('Arquivos da GPU nao encontrados apos extrair');
      save({ mode: 'auto' }); // auto picks CUDA first when installed
      return {};
    } catch (e) {
      fs.rmSync(zip, { force: true });
      fs.rmSync(cudaRoot(), { recursive: true, force: true });
      return { error: e.message };
    }
  });

  ipcMain.handle('gpu-remove', () => {
    fs.rmSync(cudaRoot(), { recursive: true, force: true });
    save({ mode: 'auto' });
  });

  ipcMain.handle('run', async (_e, file) => {
    const outDir = path.join(path.dirname(file), path.basename(file, path.extname(file)) + '_clips');
    try {
      return { clips: await clip(file, outDir, (m) => win.webContents.send('log', m), config()), outDir };
    } catch (e) {
      return { error: e.message };
    }
  });
});

app.on('window-all-closed', () => app.quit());
