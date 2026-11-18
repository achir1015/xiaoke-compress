'use strict';
// 小柯機器人MP4影片壓縮工具：桌面版主程式
// 網頁本體（dist/）由 xkcompress:// 載入；使用者加入的影音檔由 xkmedia:// 提供（支援 Range，可拖曳播放），
// 壓縮由內建 FFmpeg 執行；關閉視窗即停止所有壓縮並結束程式。
const { app, BrowserWindow, ipcMain, protocol, shell, dialog, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { Updater } = require('./updater.cjs');
const ff = require('./ffmpeg.cjs');

const SCHEME = 'xkcompress';
const MEDIA = 'xkmedia';
const DIST = path.join(__dirname, '..', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: MEDIA, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);

// 自動測試用：獨立的設定資料夾，不影響使用者自己的設定
if (process.env.XK_USER_DATA) app.setPath('userData', process.env.XK_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const MEDIA_EXT = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', 'gif', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'amr']);
const updater = new Updater();
let win = null;
/** 只開放使用者加入過的檔案與壓縮結果給網頁播放 */
const allowed = new Set();
const key = (p) => path.resolve(p).toLowerCase();
const allow = (p) => allowed.add(key(p));

function settingsFile() {
  return path.join(app.getPath('userData'), 'xiaoke-settings.json');
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

// 介面設計寬 1280×760；螢幕縮放很大（例如 200%）時視窗太小，整頁等比例縮小才不會擠成手機版面
const DESIGN_W = 1280;
const DESIGN_H = 760;
function fitZoom() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const z = Math.max(0.55, Math.min(1, w / DESIGN_W, h / DESIGN_H));
  win.webContents.setZoomFactor(z);
}

function createWindow() {
  const s = readSettings();
  const wa = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(s.bounds?.width || 1400, wa.width),
    height: Math.min(s.bounds?.height || 900, wa.height),
    x: s.bounds?.x,
    y: s.bounds?.y,
    minWidth: 720,
    minHeight: 480,
    title: '小柯機器人MP4影片壓縮工具',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#eef3f9',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (s.maximized) win.maximize();
  win.loadURL(`${SCHEME}://app/index.html${process.env.XK_QUERY ? `?${process.env.XK_QUERY}` : ''}`);
  win.webContents.on('did-finish-load', fitZoom);
  win.on('resize', fitZoom);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${SCHEME}://`)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  const remember = () => {
    if (!win || win.isDestroyed()) return;
    const cur = readSettings();
    cur.maximized = win.isMaximized();
    if (!cur.maximized && !win.isMinimized()) cur.bounds = win.getBounds();
    writeSettings(cur);
  };
  win.on('close', remember);
  win.on('closed', () => (win = null));
}

async function serveApp(req) {
  const url = new URL(req.url);
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 });
  try {
    const data = await fs.promises.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return new Response(data, { headers: { 'content-type': type, 'cache-control': 'no-cache' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

// 本機影音檔：支援 Range（影片才能拖曳時間軸）
async function serveMedia(req) {
  const url = new URL(req.url);
  const file = url.searchParams.get('p') || '';
  if (!file || !allowed.has(key(file))) return new Response('forbidden', { status: 403 });
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return new Response('not found', { status: 404 });
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (range && st.size > 0) {
    let start = range[1] ? +range[1] : st.size - +range[2];
    let end = range[1] && range[2] ? +range[2] : st.size - 1;
    start = Math.max(0, Math.min(start, st.size - 1));
    end = Math.max(start, Math.min(end, st.size - 1));
    const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, {
      status: 206,
      headers: { 'content-type': type, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes' },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { 'content-type': type, 'content-length': String(st.size), 'accept-ranges': 'bytes' } });
}

/** 輸出檔名重複時加上 (2)、(3)… */
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  protocol.handle(SCHEME, serveApp);
  protocol.handle(MEDIA, serveMedia);

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, ffmpeg: await ff.version().catch(() => '') }));

  ipcMain.handle('dlg:files', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '選擇要壓縮的影片、圖片或音訊',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '影片 圖片 音訊', extensions: [...MEDIA_EXT] },
        { name: '所有檔案', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dlg:folder', async (e, current) => {
    const r = await dialog.showOpenDialog(win, { title: '選擇輸出資料夾', defaultPath: current || app.getPath('videos'), properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('media:probe', async (e, file) => {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) throw new Error('不是檔案');
    allow(file);
    const text = await ff.probe(file);
    return { path: file, name: path.basename(file), dir: path.dirname(file), size: st.size, probe: text };
  });
  ipcMain.handle('media:thumb', (e, file, duration) => {
    if (!allowed.has(key(file))) return null;
    return ff.thumbnail(file, duration).catch(() => null);
  });
  ipcMain.handle('media:outPath', (e, dir, name) => uniquePath(dir, name));
  // 拖進資料夾：展開裡面的影音檔（最多三層、2000 個）
  ipcMain.handle('media:expand', async (e, paths) => {
    const out = [];
    const walk = async (p, depth) => {
      if (out.length >= 2000) return;
      let st;
      try {
        st = await fs.promises.stat(p);
      } catch {
        return;
      }
      if (st.isFile()) out.push(p);
      else if (st.isDirectory() && depth < 3) {
        const names = (await fs.promises.readdir(p)).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
        for (const n of names) {
          const full = path.join(p, n);
          const isDir = (await fs.promises.stat(full).catch(() => null))?.isDirectory();
          if (isDir || MEDIA_EXT.has(path.extname(n).slice(1).toLowerCase())) await walk(full, depth + 1);
        }
      }
    };
    for (const p of paths || []) await walk(p, 0);
    return out;
  });
  ipcMain.handle('media:sample', async () => {
    const f = await ff.sample();
    allow(f);
    return f;
  });
  ipcMain.handle('media:exists', (e, file) => fs.existsSync(file));
  ipcMain.handle('media:size', (e, file) => {
    try {
      return fs.statSync(file).size;
    } catch {
      return -1;
    }
  });

  ipcMain.handle('job:run', async (e, id, payload) => {
    const { input, output } = payload;
    if (!allowed.has(key(input))) throw new Error('沒有這個檔案的存取權');
    const r = await ff.compress(id, payload, (p, ms) => {
      if (!e.sender.isDestroyed()) e.sender.send('job:progress', { id, p, ms });
    });
    allow(output);
    return r;
  });
  ipcMain.handle('job:cancel', (e, id) => ff.cancel(id));
  ipcMain.handle('hw:detect', () => ff.detectHw());

  ipcMain.handle('shell:reveal', (e, file) => {
    if (fs.existsSync(file)) shell.showItemInFolder(file);
    else shell.openPath(path.dirname(file));
  });
  ipcMain.handle('shell:open', (e, file) => shell.openPath(file));
  ipcMain.handle('shell:trash', async (e, file) => {
    if (!allowed.has(key(file))) return false;
    await shell.trashItem(file);
    return true;
  });

  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:download', (e) => updater.download((got, total) => {
    if (!e.sender.isDestroyed()) e.sender.send('update:progress', { got, total });
  }));
  ipcMain.handle('update:install', (e, file) => {
    ff.cancelAll();
    return updater.install(file);
  });
  ipcMain.handle('update:openPage', () => shell.openExternal(updater.info?.page || 'https://github.com/achir1015/xiaoke-compress/releases/latest'));

  createWindow();
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// 關閉視窗：停止所有 FFmpeg 並結束程式
app.on('before-quit', () => ff.cancelAll());
app.on('window-all-closed', () => {
  ff.cancelAll();
  app.quit();
});
