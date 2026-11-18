// 小柯機器人MP4影片壓縮工具：桌面版橋接、語音動態教學、版本更新。
import type { Settings } from './engine';

export const APP_NAME = '小柯機器人MP4影片壓縮工具';

export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  notes: string;
  page: string;
  canInstall: boolean;
  flavor: string;
}

export interface HwInfo {
  nvenc: boolean;
  qsv: boolean;
  amf: boolean;
  videotoolbox: boolean;
  hevc: { nvenc: boolean; qsv: boolean; amf: boolean; videotoolbox: boolean };
}

/** Electron preload 提供的介面；線上版沒有。 */
export interface DesktopBridge {
  info(): Promise<{ version: string; platform: string; arch: string; ffmpeg: string }>;
  pickFiles(): Promise<string[]>;
  pickFolder(current?: string): Promise<string | null>;
  pathOf(file: File): string;
  media: {
    probe(path: string): Promise<{ path: string; name: string; dir: string; size: number; probe: string }>;
    thumb(path: string, duration: number): Promise<string | null>;
    outPath(dir: string, name: string): Promise<string>;
    expand(paths: string[]): Promise<string[]>;
    sample(): Promise<string>;
    exists(path: string): Promise<boolean>;
    size(path: string): Promise<number>;
  };
  job: {
    run(id: string, payload: { input: string; output: string; passes: string[][]; duration: number }): Promise<{ output: string; size: number; ms: number }>;
    cancel(id: string): Promise<boolean>;
    onProgress(fn: (d: { id: string; p: number; ms: number }) => void): () => void;
  };
  hw(): Promise<HwInfo>;
  shell: { reveal(p: string): Promise<void>; open(p: string): Promise<string>; trash(p: string): Promise<boolean> };
  update: {
    check(): Promise<UpdateInfo>;
    download(): Promise<string>;
    install(file: string): Promise<{ quitting?: boolean; manual?: boolean; path?: string }>;
    openPage(): Promise<void>;
    onProgress(fn: (d: { got: number; total: number }) => void): () => void;
  };
  platform: string;
}

export interface ItemView {
  id: string;
  name: string;
  kind: string;
  status: string;
  size: number;
  outSize: number;
  out: string;
  progress: number;
  error: string;
  summary: string;
  warnings: string[];
  demo: boolean;
}

export interface AppHook {
  addSample(): Promise<string | null>;
  addPaths(paths: string[]): Promise<string[]>;
  addFiles(files: File[]): Promise<string[]>;
  web(): boolean;
  ready?: () => boolean;
  setTab(t: 'video' | 'image' | 'audio'): void;
  setMode(m: Settings['mode']): void;
  setSetting(k: string, v: unknown): void;
  setHw(h: string): void;
  openAdvanced(open?: boolean): HTMLDetailsElement;
  start(): Promise<void>;
  wait(): Promise<void>;
  items(): ItemView[];
  remove(id: string): void;
  removeDemo(): void;
  openCompare(id: string): boolean;
  closeDialogs(): void;
  settings(): { s: Settings; ui: Record<string, unknown> };
  load(snap: { s: unknown; ui: unknown }): void;
  busy(): boolean;
}

declare global {
  interface Window {
    xk?: DesktopBridge;
    xkApp: AppHook;
  }
}

export const desktop = (): DesktopBridge | undefined => window.xk;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const ROBOT_SVG = `<svg viewBox="0 0 120 120" aria-hidden="true">
  <line x1="60" y1="8" x2="60" y2="22" stroke="#5a6478" stroke-width="4"/>
  <circle cx="60" cy="8" r="7" fill="#ffc428"/>
  <rect x="6" y="50" width="12" height="32" rx="5" fill="#2878dc"/>
  <rect x="102" y="50" width="12" height="32" rx="5" fill="#2878dc"/>
  <circle cx="60" cy="66" r="48" fill="#4696f0"/>
  <circle cx="60" cy="66" r="44" fill="#f0f6ff"/>
  <rect x="25" y="44" width="70" height="42" rx="20" fill="#182440"/>
  <path class="eye" d="M36 62 q9 -10 18 0" stroke="#5ae6ff" stroke-width="5" fill="none" stroke-linecap="round"/>
  <path class="eye" d="M66 62 q9 -10 18 0" stroke="#5ae6ff" stroke-width="5" fill="none" stroke-linecap="round"/>
  <ellipse class="mouth" cx="60" cy="75" rx="9" ry="3" fill="#5ae6ff"/>
  <circle cx="32" cy="80" r="5" fill="#ff8ca0" opacity=".8"/>
  <circle cx="88" cy="80" r="5" fill="#ff8ca0" opacity=".8"/>
</svg>`;

// --- 語音動態教學 ----------------------------------------------------------------

interface Step {
  /** 要框起來的元素（找不到就置中顯示）。 */
  target?: () => HTMLElement | null;
  text: string;
  /** 線上版改用的說明。 */
  web?: string;
  /** 說話前先做的示範動作。 */
  before?: () => void | Promise<void>;
  /** 說話途中的動畫示範。 */
  demo?: () => Promise<void>;
}

const app = () => window.xkApp;
/** 教學加入的範例影片 */
let demoId: string | null = null;
const demoItem = () => (demoId ? document.querySelector<HTMLElement>(`#queue li[data-id="${demoId}"]`) : null);
/** 點一下按鈕的動畫（讓使用者看得出來小柯按了哪裡） */
async function press(el: HTMLElement | null) {
  if (!el) return;
  el.animate([{ transform: 'scale(1)' }, { transform: 'scale(.92)', boxShadow: '0 0 0 4px #ffc428' }, { transform: 'scale(1)' }], { duration: 420 });
  await sleep(300);
}
const btn = (sel: string) => $<HTMLElement>(sel);

const STEPS: Step[] = [
  {
    before: () => {
      app().setTab('video');
      app().setMode('quality');
      app().setSetting('quality', 60);
      app().openAdvanced(false);
    },
    text: '你好，我是小柯機器人！歡迎使用小柯機器人 MP4 影片壓縮工具。我會一步一步示範，怎麼把又大又重的影片、照片和音樂，壓成方便傳送的小檔案。',
  },
  {
    target: () => $('#drop'),
    text: '第一步，加入檔案。把影片、圖片或音訊直接拖曳到這個框框裡，也可以按「選擇檔案」，一次選很多個，連整個資料夾拖進來都可以。沒有影片的話，按「試用範例影片」，我現在就幫你加一支。',
    web: '第一步，加入檔案。把影片、圖片或音訊拖曳到這個框框裡，或按「選擇檔案」，一次可以選很多個。檔案都在你的瀏覽器裡處理，不會上傳到網路。按「試用範例影片」，我現在就用瀏覽器做一支範例影片給你。',
    demo: async () => {
      await sleep(5200);
      await press(btn('#sample'));
      demoId = await app().addSample();
    },
  },
  {
    target: () => demoItem() ?? $('#queue'),
    text: '加入後，清單會顯示縮圖、解析度、長度、檔案大小和編碼，下面藍色的字是小柯準備怎麼壓縮。影片想剪短一點，可以按「修剪」，只保留需要的片段，檔案會更小。',
  },
  {
    target: () => $('#kind-tabs'),
    text: '右邊是壓縮設定，分成影片、圖片、音訊三頁。加入照片時會自動切到圖片頁，可以轉成 JPG 或更小的 WebP，也能縮小尺寸；音樂和錄音則可以轉成 MP3 並選擇位元率。',
    demo: async () => {
      await sleep(3800);
      app().setTab('image');
      await sleep(2600);
      app().setTab('audio');
      await sleep(2600);
      app().setTab('video');
    },
  },
  {
    target: () => $('#f-quality'),
    text: '影片最常用的是「品質優先」。四個快選裡，「均衡」最推薦，畫質好、檔案又小；要傳 LINE 或 Email 可以選「小檔案」；「極小」最省空間，但畫質會明顯變差。也可以拉下面的滑桿微調。',
    demo: async () => {
      await sleep(5500);
      await press(btn('#presets [data-id="small"]'));
      app().setSetting('quality', 40);
      await sleep(2200);
      await press(btn('#presets [data-id="balanced"]'));
      app().setSetting('quality', 60);
    },
  },
  {
    before: async () => {
      await press(btn('#mode [data-v="size"]'));
      app().setMode('size');
    },
    target: () => $('#f-size'),
    text: '如果有大小限制，就改用「指定大小」，例如 Email 附件只能 25 MB。輸入想要的大小，小柯會算出剛好的位元率，用兩趟壓縮精準控制；目標太小時，還會自動降低解析度，避免畫面變成馬賽克。',
    demo: async () => {
      await sleep(6000);
      await press(btn('#size-chips [data-mb="10"]'));
      app().setSetting('targetMB', 10);
    },
  },
  {
    before: async () => {
      await press(btn('#mode [data-v="percent"]'));
      app().setMode('percent');
    },
    target: () => $('#f-percent'),
    text: '「原檔比例」則是直接指定要壓成原來的幾分之幾，例如百分之三十。好，示範完了，我切回「品質優先」。',
    demo: async () => {
      await sleep(5200);
      app().setMode('quality');
    },
  },
  {
    before: () => {
      app().openAdvanced(true);
    },
    target: () => $('#adv'),
    text: '「進階設定」可以選解析度、影格率和編碼。H.264 到處都能播；H.265 同樣畫質可以再小四成左右。電腦有 NVIDIA、Intel 或 AMD 顯示卡的話，打開「硬體加速」會快很多。勾選「移除拍攝資訊」，還能順便刪掉照片和影片裡的 GPS 位置。',
    web: '「進階設定」可以選解析度、影格率和編碼。H.264 到處都能播；H.265 同樣畫質可以再小四成左右，瀏覽器不支援時會自動改用 H.264。線上版會自動使用瀏覽器的硬體編碼，速度很快。勾選「移除拍攝資訊」，還能順便刪掉影片裡的 GPS 位置。',
  },
  {
    before: () => {
      app().openAdvanced(false);
    },
    target: () => $('#f-out'),
    text: '壓縮好的檔案預設放在原檔旁邊，檔名後面加上「壓縮」兩個字，原檔不會被覆蓋。也可以改成存到自訂的資料夾。',
    web: '壓縮好的檔案會用下載的方式存到你的電腦或手機，檔名後面加上「壓縮」兩個字，原檔不會被改動。',
  },
  {
    target: () => $('#start'),
    text: '設定好就按綠色的「開始壓縮」。我現在就來壓這支範例影片，看看能小多少！',
    demo: async () => {
      await sleep(3600);
      if (!demoId) return;
      await press(btn('#start'));
      await app().start();
    },
  },
  {
    target: () => demoItem() ?? $('#queue'),
    text: '完成了！清單會顯示壓縮前後的大小和省下的百分比。按「開啟」可以播放，按「資料夾」會打開存檔的位置。',
    web: '完成了！清單會顯示壓縮前後的大小和省下的百分比。按綠色的「下載」就能存檔，檔案很多時可以按上面的「全部下載」。',
  },
  {
    before: () => {
      if (demoId && app().items().some((x) => x.id === demoId && x.status === 'done')) app().openCompare(demoId);
    },
    target: () => $('.cmp-stage'),
    text: '最實用的是「比較」：左邊是原檔，右邊是壓縮後，左右拖曳中間的白線，就能比較畫質差多少，滾輪還可以放大看細節。',
    demo: async () => {
      const stage = $('.cmp-stage');
      if (!stage) return;
      await sleep(2500);
      for (const x of [50, 30, 70, 50]) {
        stage.style.setProperty('--x', `${x}%`);
        await sleep(900);
      }
      await sleep(1500);
    },
  },
  {
    before: () => {
      app().closeDialogs();
    },
    target: () => $('.xk-update'),
    text: '最後，這顆按鈕會檢查新版本，有更新就能直接下載安裝。教學到這裡結束，想再聽一次，按旁邊的「語音教學」就可以了。祝你壓縮愉快！',
  },
];

let running = false;
/** 立刻結束目前這句話（有些語音引擎 cancel 後不會觸發 onend）。 */
let cutSpeech: (() => void) | null = null;
let stopRequested = false;

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  for (const re of [/zh[-_]TW/i, /Hanhan|Yating|Zhiwei|HsiaoChen|HsiaoYu|Mei-Jia/i, /zh[-_]HK/i, /zh/i]) {
    const v = voices.find((x) => re.test(x.lang) || re.test(x.name));
    if (v) return v;
  }
  return undefined;
}

function speak(text: string, mouth: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || /[?&]mute/.test(location.search)) {
      mouth.classList.add('talk');
      setTimeout(() => {
        mouth.classList.remove('talk');
        resolve();
      }, /[?&]fastguide/.test(location.search) ? 300 : Math.max(2500, text.length * 180));
      return;
    }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v?.lang ?? 'zh-TW';
    u.rate = 1.05;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cutSpeech = null;
      mouth.classList.remove('talk');
      resolve();
    };
    cutSpeech = finish;
    u.onstart = () => mouth.classList.add('talk');
    u.onend = finish;
    u.onerror = finish;
    // 有些環境沒有語音，或不會觸發 onend：依字數估一個保底時間
    setTimeout(finish, Math.max(4000, text.length * 260) + 1500);
    speechSynthesis.speak(u);
  });
}

export async function startGuide() {
  if (running || app().busy()) return;
  running = true;
  stopRequested = false;
  demoId = null;
  // 教學會示範改設定：結束後還原使用者原本的設定
  const saved = app().settings();
  let index = 0;
  let jump: number | null = null;
  let paused = false;

  const layer = document.createElement('div');
  layer.className = 'xk-guide';
  layer.innerHTML = `
    <div class="xk-spot"></div>
    <div class="xk-bubble" role="dialog" aria-live="polite">
      <div class="xk-robot">${ROBOT_SVG}</div>
      <div class="xk-body">
        <p class="xk-text"></p>
        <div class="xk-bar"><span class="xk-count"></span>
          <button type="button" class="ghost xk-prev" title="上一步">◀</button>
          <button type="button" class="ghost xk-pause" title="暫停">⏸</button>
          <button type="button" class="ghost xk-next" title="下一步">▶</button>
          <button type="button" class="ghost xk-close" title="結束教學">✕</button>
        </div>
      </div>
    </div>`;
  document.body.append(layer);
  const spot = layer.querySelector<HTMLElement>('.xk-spot')!;
  const bubble = layer.querySelector<HTMLElement>('.xk-bubble')!;
  const text = layer.querySelector<HTMLElement>('.xk-text')!;
  const count = layer.querySelector<HTMLElement>('.xk-count')!;
  const robot = layer.querySelector<HTMLElement>('.xk-robot')!;
  const pauseBtn = layer.querySelector<HTMLButtonElement>('.xk-pause')!;
  let wake: (() => void) | null = null;
  const interrupt = () => {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    cutSpeech?.();
    wake?.();
  };
  layer.querySelector('.xk-prev')!.addEventListener('click', () => {
    jump = Math.max(0, index - 1);
    interrupt();
  });
  layer.querySelector('.xk-next')!.addEventListener('click', () => {
    jump = index + 1;
    interrupt();
  });
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? '▶︎ 繼續' : '⏸';
    if (paused && 'speechSynthesis' in window) speechSynthesis.pause();
    else {
      if ('speechSynthesis' in window) speechSynthesis.resume();
      wake?.();
    }
  });
  layer.querySelector('.xk-close')!.addEventListener('click', () => {
    stopRequested = true;
    interrupt();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      stopRequested = true;
      interrupt();
    }
  };
  document.addEventListener('keydown', onKey);

  const place = (target: HTMLElement | null) => {
    if (!target || target.offsetParent === null) {
      spot.classList.add('none');
      bubble.style.left = '50%';
      bubble.style.top = '50%';
      bubble.style.transform = 'translate(-50%, -50%)';
      return;
    }
    if (!target.closest('.cmp')) target.scrollIntoView({ block: 'nearest' });
    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.classList.remove('none');
    Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
    const bw = Math.min(460, window.innerWidth - 24);
    const bh = bubble.offsetHeight || 160;
    let left = r.left - bw - 18;
    let top = r.top;
    if (left < 12) left = r.right + 18;
    if (left + bw > window.innerWidth - 12) {
      left = Math.max(12, Math.min(window.innerWidth - bw - 12, r.left + r.width / 2 - bw / 2));
      top = r.bottom + 18;
      if (top + bh > window.innerHeight - 12) top = r.top - bh - 18;
      // 目標很大（例如比較畫面）：氣泡蓋在目標下方內側
      if (top < 12) top = Math.min(window.innerHeight - bh - 12, r.bottom - bh - 12);
    }
    top = Math.max(12, Math.min(window.innerHeight - bh - 12, top));
    Object.assign(bubble.style, { left: `${left}px`, top: `${top}px`, transform: 'none' });
  };

  // 比較視窗是 <dialog> 的 top layer，教學圖層要放進去才看得到
  const lift = () => {
    const host = document.querySelector('dialog.cmp[open]') ?? document.body;
    if (layer.parentElement !== host) host.append(layer);
  };

  try {
    while (index < STEPS.length && !stopRequested) {
      const step = STEPS[index];
      jump = null;
      count.textContent = `${index + 1} / ${STEPS.length}`;
      await step.before?.();
      lift();
      await sleep(250);
      if (stopRequested) break;
      if (jump !== null) {
        index = jump;
        continue;
      }
      const line = !desktop() && step.web ? step.web : step.text;
      text.textContent = line;
      robot.classList.remove('pop');
      void robot.offsetWidth;
      robot.classList.add('pop');
      place(step.target?.() ?? null);
      const follow = setInterval(() => {
        lift();
        place(step.target?.() ?? null);
      }, 400);
      await Promise.all([speak(line, robot), step.demo?.().then(() => sleep(400))]);
      clearInterval(follow);
      while (paused && !stopRequested && jump === null) await new Promise<void>((r) => (wake = r));
      wake = null;
      if (jump === null && !stopRequested) await sleep(500);
      index = jump ?? index + 1;
    }
  } finally {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    document.removeEventListener('keydown', onKey);
    layer.remove();
    running = false;
    app().closeDialogs();
    app().openAdvanced(false);
    app().load(saved);
    // 教學的範例影片從清單移除（壓縮結果檔案保留在範例資料夾）
    if (!app().busy()) app().removeDemo();
    try {
      localStorage.setItem('xiaoke-compress:guided', '1');
    } catch {
      // 無痕模式等情況：下次再自動播放也無妨
    }
  }
}

/** 第一次開啟時自動播放教學。 */
export function guideOnFirstRun() {
  let seen = '1';
  try {
    seen = localStorage.getItem('xiaoke-compress:guided') ?? '';
  } catch {
    seen = '1';
  }
  if (!seen && !/[?&]noguide/.test(location.search)) setTimeout(() => void startGuide(), 1200);
}

// --- 版本更新 ---------------------------------------------------------------------

const UPDATE_REPO = 'achir1015/xiaoke-compress';

function cmpVer(a: string, b: string) {
  const pa = a.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function dialog(html: string): HTMLDialogElement {
  const d = document.createElement('dialog');
  d.className = 'xk-dialog';
  d.innerHTML = `<form method="dialog">${html}</form>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function initUpdateButton(current: string) {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.xk-update')) b.addEventListener('click', () => void checkUpdate(current));
}

export async function checkUpdate(current: string, quiet = false) {
  const xk = desktop();
  try {
    let info: UpdateInfo;
    if (xk) info = await xk.update.check();
    else {
      // 線上版：比對 version.json，有新版就重新整理頁面（略過快取）
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      const j = (await res.json()) as { version: string; notes?: string };
      info = { current, latest: j.version, newer: cmpVer(j.version, current) > 0, notes: j.notes ?? '', page: `https://github.com/${UPDATE_REPO}/releases/latest`, canInstall: true, flavor: 'web' };
    }
    if (!info.newer) {
      if (!quiet) dialog(`<h2>已是最新版</h2><p>目前版本 v${esc(info.current)} 就是最新版。</p><div class="xk-row"><button class="ghost">關閉</button></div>`);
      return;
    }
    const d = dialog(`<h2>有新版本 v${esc(info.latest)}</h2><p>目前版本 v${esc(info.current)}</p>
      ${info.notes ? `<pre class="xk-notes">${esc(info.notes)}</pre>` : ''}
      <progress hidden max="1" value="0"></progress><p class="xk-msg"></p>
      <div class="xk-row"><button type="button" class="xk-go">${info.canInstall ? (xk ? '下載並安裝' : '立即更新') : '開啟下載頁'}</button><button class="ghost">稍後</button></div>`);
    const go = d.querySelector<HTMLButtonElement>('.xk-go')!;
    const bar = d.querySelector<HTMLProgressElement>('progress')!;
    const msg = d.querySelector<HTMLElement>('.xk-msg')!;
    go.addEventListener('click', async () => {
      if (!xk) {
        location.reload();
        return;
      }
      if (!info.canInstall) {
        await xk.update.openPage();
        return;
      }
      if (window.xkApp?.busy() && !confirm('還有檔案正在壓縮，更新會停止壓縮。要繼續更新嗎？')) return;
      go.disabled = true;
      bar.hidden = false;
      const off = xk.update.onProgress(({ got, total }) => {
        if (total) bar.value = got / total;
        msg.textContent = `下載中 ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
      });
      try {
        const file = await xk.update.download();
        msg.textContent = '下載完成，正在安裝，程式會自動重新開啟…';
        const r = await xk.update.install(file);
        if (r.manual) msg.textContent = `已下載到 ${r.path}，請手動開啟安裝。`;
      } catch (e) {
        msg.textContent = `更新失敗：${(e as Error).message}`;
        go.disabled = false;
      } finally {
        off();
      }
    });
  } catch (e) {
    if (!quiet) dialog(`<h2>無法檢查更新</h2><p>${esc((e as Error).message)}</p><div class="xk-row"><button class="ghost">關閉</button></div>`);
  }
}
