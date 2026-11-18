// 桌面版冒煙測試：啟動 Electron（或 XK_EXE 指定的打包版），透過 CDP 操作畫面並真的壓縮檔案。
// 用法：node e2e/desktop.mjs [--guide]   --guide 會再快速跑一次語音教學（靜音）
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const PORT = 9367;
const exe = process.env.XK_EXE;
const MAC = process.platform === 'darwin';
const WANT_GUIDE = process.argv.includes('--guide');
const electron = MAC
  ? join(process.cwd(), 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  : join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
// 產生測試素材用的 FFmpeg：測打包版時直接用 App 內附的（Mac 測試機不必 npm install）
const FF = process.env.XK_FF
  || (exe ? (MAC ? join(dirname(exe), '..', 'Resources', 'bin', 'ffmpeg') : join(dirname(exe), 'resources', 'bin', 'ffmpeg.exe'))
    : join(process.cwd(), 'node_modules', 'ffmpeg-static', MAC ? 'ffmpeg' : 'ffmpeg.exe'));
const work = mkdtempSync(join(tmpdir(), 'xkc-e2e-'));
const shots = process.env.XK_SHOTS || work;
mkdirSync(shots, { recursive: true });
const env = { ...process.env, XK_USER_DATA: join(work, 'userdata'), XK_QUERY: WANT_GUIDE ? 'noguide&fastguide&mute' : 'noguide' };

// 測試素材：圖片與音訊
spawnSync(FF, ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1600x1200', '-frames:v', '1', join(work, '測試圖片.png')]);
spawnSync(FF, ['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=15', '-c:a', 'pcm_s16le', join(work, '測試聲音.wav')]);

const child = exe
  ? spawn(exe, [`--remote-debugging-port=${PORT}`], { stdio: 'ignore', env })
  : spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { stdio: 'ignore', env });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0;
let fail = 0;
const check = (name, cond, info = '') => {
  if (cond) ok++;
  else fail++;
  console.log(`${cond ? '✔' : '✘'} ${name}${info ? ` — ${info}` : ''}`);
};

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('xkcompress://'));
      if (page) return page;
    } catch {
      // 還沒啟動
    }
    await sleep(500);
  }
  throw new Error('找不到視窗');
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) => new Promise((r) => {
  const id = ++seq;
  pending.set(id, r);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
const waitFor = async (expr, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await evaluate(`return !!(${expr})`)) return true;
    await sleep(300);
  }
  return false;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync(join(shots, name), Buffer.from(r.result.data, 'base64'));
};

try {
  check('畫面載入', await waitFor(`document.querySelector('#queue') && window.xkApp`, 30000));
  check('標題', (await evaluate(`return document.querySelector('h1').textContent`)) === '小柯機器人MP4影片壓縮工具');
  check('版本號', /^v\d+\.\d+\.\d+$/.test(await evaluate(`return document.querySelector('#ver').textContent`)));
  check('桌面橋接', await evaluate(`return !!window.xk && typeof window.xk.job.run === 'function'`));
  check('硬體加速偵測完成', await waitFor(`!/偵測中/.test(document.querySelector('#hw-note').textContent) && document.querySelector('#hw').options.length >= 2`, 30000),
    await evaluate(`return [...document.querySelector('#hw').options].map(o => o.textContent).join('、')`));

  // 範例影片
  const id = await evaluate(`return await xkApp.addSample()`);
  check('加入範例影片', !!id);
  await waitFor(`document.querySelector('#queue li .thumb[style*="background-image"]')`, 20000);
  const it = await evaluate(`return xkApp.items()[0]`);
  check('讀到影片資訊', it && it.kind === 'video' && it.size > 1e6, `${(it.size / 1048576).toFixed(1)} MB・${it.summary}`);
  check('縮圖', await evaluate(`return !!document.querySelector('#queue li .thumb[style*="background-image"]')`));

  // 圖片與音訊（含中文檔名）
  await evaluate(`return await xkApp.addPaths(${JSON.stringify([join(work, '測試圖片.png'), join(work, '測試聲音.wav')])})`);
  const kinds = await evaluate(`return xkApp.items().map(x => x.kind).join(',')`);
  check('加入圖片和音訊', kinds === 'video,image,audio', kinds);

  // 指定大小 2 MB，全部壓縮
  await evaluate(`xkApp.setTab('video'); xkApp.setMode('size'); xkApp.setSetting('targetMB', 2); xkApp.setSetting('speed', 0)`);
  check('預估大小顯示', /預估/.test(await evaluate(`return xkApp.items()[0].summary`)), await evaluate(`return xkApp.items()[0].summary`));
  await shot('01-ready.png');
  const t0 = Date.now();
  await evaluate(`document.querySelector('#start').click()`);
  check('壓縮中顯示進度', await waitFor(`document.querySelector('#queue li.running .bar i')`, 10000));
  await sleep(1500);
  await shot('02-running.png');
  check('全部完成', await waitFor(`xkApp.items().every(x => x.status === 'done' || x.status === 'error') && !xkApp.busy()`, 180000), `${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  const res = await evaluate(`return xkApp.items()`);
  for (const r of res) check(`${r.name} 壓縮成功`, r.status === 'done' && r.outSize > 0 && r.outSize < r.size, r.error || `${(r.size / 1024).toFixed(0)} KB → ${(r.outSize / 1024).toFixed(0)} KB`);
  check('影片接近 2 MB', res[0].outSize < 2 * 1048576 * 1.15 && res[0].outSize > 2 * 1048576 * 0.5, `${(res[0].outSize / 1048576).toFixed(2)} MB`);
  check('輸出檔存在', res.every((r) => existsSync(r.out)));
  check('總結顯示省下', /省下/.test(await evaluate(`return document.querySelector('#queue-sum').textContent`)));
  await shot('03-done.png');

  // 比較視窗
  check('開啟比較', await evaluate(`return xkApp.openCompare(xkApp.items()[0].id)`));
  check('比較影片可播放', await waitFor(`[...document.querySelectorAll('.cmp video')].every(v => v.readyState >= 2)`, 15000));
  await evaluate(`document.querySelector('.cmp-stage').style.setProperty('--x', '35%')`);
  await sleep(500);
  await shot('04-compare.png');
  await evaluate(`xkApp.closeDialogs()`);
  check('關閉比較', await waitFor(`!document.querySelector('.cmp')`, 3000));

  // 硬體加速（有偵測到才測）
  const hwCount = await evaluate(`return document.querySelector('#hw').options.length`);
  if (hwCount > 2) {
    await evaluate(`document.querySelector('#clear-done').click(); xkApp.setMode('quality'); xkApp.setHw('auto')`);
    await evaluate(`return await xkApp.addSample()`);
    const sum = await evaluate(`return xkApp.items().at(-1).summary`);
    await evaluate(`return await xkApp.start()`);
    const h = await evaluate(`return xkApp.items().at(-1)`);
    check('硬體加速壓縮', /硬體加速/.test(sum) && h.status === 'done' && h.outSize < h.size, `${sum} → ${h.error || (h.outSize / 1048576).toFixed(2) + ' MB'}`);
    await evaluate(`xkApp.setHw('off')`);
  }

  // 取消
  await evaluate(`xkApp.setMode('quality'); xkApp.setSetting('speed', 2); xkApp.setSetting('codec', 'av1')`);
  await evaluate(`return await xkApp.addSample()`);
  await evaluate(`document.querySelector('#start').click()`);
  await waitFor(`document.querySelector('#queue li.running')`, 10000);
  await sleep(1200);
  await evaluate(`document.querySelector('#stop').click()`);
  check('停止後狀態為已取消', await waitFor(`xkApp.items().at(-1).status === 'cancelled' && !xkApp.busy()`, 15000), await evaluate(`return xkApp.items().at(-1).status`));
  await evaluate(`xkApp.setSetting('codec', 'h264'); xkApp.setSetting('speed', 1)`);

  if (WANT_GUIDE) {
    await evaluate(`xkApp.removeDemo(); document.querySelector('#clear-all').click(); localStorage.removeItem('xiaoke-compress:guided'); document.querySelector('#guide-btn').click()`);
    check('教學開始', await waitFor(`document.querySelector('.xk-guide')`, 5000));
    let sawCompare = false;
    const end = Date.now() + 240000;
    while (Date.now() < end && (await evaluate(`return !!document.querySelector('.xk-guide')`))) {
      if (!sawCompare && (await evaluate(`return !!document.querySelector('.cmp .xk-guide')`))) {
        sawCompare = true;
        await shot('05-guide-compare.png');
      }
      await sleep(400);
    }
    check('教學示範了比較畫面', sawCompare);
    check('教學結束', !(await evaluate(`return !!document.querySelector('.xk-guide')`)));
    check('教學的範例已移除、設定已還原', await evaluate(`const s = xkApp.settings().s; return xkApp.items().length === 0 && s.mode === 'quality' && s.codec === 'h264'`));
  }
} catch (e) {
  fail++;
  console.log('✘ 例外', e.message);
} finally {
  console.log(`\n${ok} 項通過，${fail} 項失敗${shots === work ? '' : `（截圖：${shots}）`}`);
  ws.close();
  child.kill();
  await sleep(800);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // 檔案還被鎖住就算了
  }
  process.exit(fail ? 1 : 0);
}
