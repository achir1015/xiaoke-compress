import './style.css';
import {
  DEFAULTS,
  QUALITY_PRESETS,
  buildPlan,
  fmtBytes,
  fmtDuration,
  kindOf,
  outputName,
  parseProbe,
  type Hw,
  type Kind,
  type MediaInfo,
  type Settings,
} from './engine';
import { ROBOT_SVG, checkUpdate, desktop, guideOnFirstRun, initUpdateButton, startGuide, type HwInfo } from './xiaoke';

declare const __APP_VERSION__: string;

// --- 狀態 ----------------------------------------------------------------------------

type Status = 'ready' | 'running' | 'done' | 'error' | 'cancelled';
type Tab = Kind;

interface Item {
  id: string;
  path: string;
  name: string;
  dir: string;
  size: number;
  kind: Kind;
  info: MediaInfo;
  thumb: string | null;
  status: Status;
  progress: number;
  ms: number;
  out?: string;
  outSize?: number;
  error?: string;
  warnings: string[];
  summary: string;
  trimStart: number;
  trimEnd: number;
  /** 教學時加入的範例，教學結束會移除 */
  demo?: boolean;
}

interface Ui {
  tab: Tab;
  hw: 'off' | 'auto' | Exclude<Hw, 'off'>;
  outMode: 'same' | 'custom';
  outDir: string;
}

const STORE = 'xiaoke-compress:settings';
let S: Settings = { ...DEFAULTS };
let ui: Ui = { tab: 'video', hw: 'off', outMode: 'same', outDir: '' };
try {
  const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as { s?: Partial<Settings>; ui?: Partial<Ui> };
  S = { ...DEFAULTS, ...saved.s, trimStart: 0, trimEnd: 0 };
  ui = { ...ui, ...saved.ui };
} catch {
  // 沒有存過或格式不對：用預設值
}
const save = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify({ s: S, ui }));
  } catch {
    // 無痕模式：不記住
  }
};

const items: Item[] = [];
let running = false;
let stopRequested = false;
let currentId: string | null = null;
let hwInfo: HwInfo | null = null;
let seq = 0;
let runDone: Promise<void> = Promise.resolve();

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const xk = desktop();
const mediaUrl = (p: string) => `xkmedia://f/m?p=${encodeURIComponent(p)}`;

function toast(msg: string, ms = 3200) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

// --- 設定表單 ------------------------------------------------------------------------

/** 依目前硬體偵測結果決定實際使用的硬體編碼器。 */
function resolveHw(s: Settings): Hw {
  if (ui.hw === 'off' || !hwInfo) return 'off';
  const codec = s.container === 'webm' ? 'vp9' : s.codec;
  if (codec !== 'h264' && codec !== 'h265') return 'off';
  const order: Exclude<Hw, 'off'>[] = ui.hw === 'auto' ? ['nvenc', 'qsv', 'amf', 'videotoolbox'] : [ui.hw];
  for (const h of order) {
    if (!hwInfo[h]) continue;
    if (codec === 'h265' && !hwInfo.hevc[h]) continue;
    return h;
  }
  return 'off';
}

function settingsFor(it: Item): Settings {
  const s: Settings = { ...S, trimStart: it.trimStart, trimEnd: it.trimEnd };
  s.hw = resolveHw(s);
  return s;
}

const NUM_KEYS = new Set<keyof Settings>(['quality', 'targetMB', 'percent', 'fps', 'audioKbps', 'speed', 'imageQuality', 'imageMax', 'audioFileKbps']);
const BOOL_KEYS = new Set<keyof Settings>(['stripMeta', 'audioMono']);
const FIELD_KEYS: (keyof Settings)[] = ['quality', 'targetMB', 'percent', 'res', 'fps', 'codec', 'container', 'speed', 'audio', 'audioKbps', 'stripMeta', 'imageFormat', 'imageQuality', 'imageMax', 'audioFormat', 'audioFileKbps', 'audioMono', 'suffix'];

function setSetting<K extends keyof Settings>(k: K, v: Settings[K]) {
  S[k] = v;
  if (k === 'container' && v === 'webm' && (S.codec === 'h264' || S.codec === 'h265')) S.codec = 'vp9';
  if (k === 'codec' && (v === 'h264' || v === 'h265') && S.container === 'webm') S.container = 'mp4';
  save();
  syncForm();
  refreshPlans();
}

function syncForm() {
  for (const k of FIELD_KEYS) {
    const el = document.getElementById(k) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) continue;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!S[k];
    else if (document.activeElement !== el || el.tagName === 'SELECT') el.value = String(S[k]);
  }
  $('#quality-out').textContent = String(S.quality);
  $('#percent-out').textContent = `${S.percent}%`;
  $('#imageQuality-out').textContent = String(S.imageQuality);
  for (const b of $$('#mode button')) b.classList.toggle('on', b.dataset.v === S.mode);
  for (const b of $$('#outMode button')) b.classList.toggle('on', b.dataset.v === ui.outMode);
  for (const b of $$('#presets button')) b.classList.toggle('on', +b.dataset.q! === S.quality);
  for (const b of $$('#size-chips button')) b.classList.toggle('on', +b.dataset.mb! === S.targetMB);
  for (const el of $$('[data-show]')) {
    const [k, v] = el.dataset.show!.split('=');
    el.hidden = (k === 'mode' ? S.mode : k === 'outMode' ? ui.outMode : '') !== v;
  }
  for (const b of $$('#kind-tabs button')) b.classList.toggle('on', b.dataset.tab === ui.tab);
  for (const p of $$('[data-panel]')) p.hidden = p.dataset.panel !== ui.tab;
  // 指定大小／比例對影片和音訊都有效：壓縮方式放在影片頁，音訊頁也顯示提示
  ($('#hw') as HTMLSelectElement).value = ui.hw;
  ($('#outDir') as HTMLInputElement).value = ui.outDir;
  const hwSel = resolveHw(S);
  const names: Record<string, string> = { nvenc: 'NVIDIA', qsv: 'Intel', amf: 'AMD', videotoolbox: 'Apple' };
  $('#hw-note').textContent = !hwInfo ? '偵測中…' : ui.hw === 'off' ? '' : hwSel === 'off' ? '這個編碼無法用硬體加速，會用一般壓縮' : `使用 ${names[hwSel]} 顯示晶片`;
}

function buildForm() {
  $('#presets').innerHTML = QUALITY_PRESETS.map((p) => `<button type="button" data-q="${p.quality}" data-id="${p.id}"><b>${p.label}</b><small>${p.hint}</small></button>`).join('');
  for (const k of FIELD_KEYS) {
    const el = document.getElementById(k) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) continue;
    const ev = el instanceof HTMLInputElement && (el.type === 'range' || el.type === 'text' || el.type === 'number') ? 'input' : 'change';
    el.addEventListener(ev, () => {
      let v: unknown = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
      if (NUM_KEYS.has(k)) {
        v = parseFloat(String(v));
        if (!Number.isFinite(v as number)) return;
      }
      if (BOOL_KEYS.has(k)) v = !!v;
      setSetting(k, v as never);
    });
  }
  $('#mode').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (b) setSetting('mode', b.dataset.v as Settings['mode']);
  });
  $('#presets').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (b) setSetting('quality', +b.dataset.q!);
  });
  $('#size-chips').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (b) setSetting('targetMB', +b.dataset.mb!);
  });
  $('#kind-tabs').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (b) setTab(b.dataset.tab as Tab);
  });
  $('#outMode').addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    ui.outMode = b.dataset.v as Ui['outMode'];
    if (ui.outMode === 'custom' && !ui.outDir) await pickOutDir();
    save();
    syncForm();
  });
  $('#pick-out').addEventListener('click', () => void pickOutDir());
  $('#hw').addEventListener('change', (e) => {
    ui.hw = (e.target as HTMLSelectElement).value as Ui['hw'];
    save();
    syncForm();
    refreshPlans();
  });
}

function setTab(t: Tab) {
  ui.tab = t;
  save();
  syncForm();
}

async function pickOutDir() {
  if (!xk) return;
  const d = await xk.pickFolder(ui.outDir);
  if (d) {
    ui.outDir = d;
    ui.outMode = 'custom';
  } else if (!ui.outDir) ui.outMode = 'same';
  save();
  syncForm();
}

function fillHwOptions() {
  const sel = $('#hw') as HTMLSelectElement;
  const opts: [string, string][] = [['off', '關閉（畫質最穩定）'], ['auto', '自動（有就用）']];
  if (hwInfo?.nvenc) opts.push(['nvenc', 'NVIDIA NVENC']);
  if (hwInfo?.qsv) opts.push(['qsv', 'Intel Quick Sync']);
  if (hwInfo?.amf) opts.push(['amf', 'AMD AMF']);
  if (hwInfo?.videotoolbox) opts.push(['videotoolbox', 'Apple VideoToolbox']);
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  if (!opts.some(([v]) => v === ui.hw)) ui.hw = 'off';
  syncForm();
}

// --- 檔案清單 ------------------------------------------------------------------------

async function addPaths(paths: string[], opts: { demo?: boolean } = {}): Promise<Item[]> {
  if (!xk) {
    showWebNote();
    return [];
  }
  const files = await xk.media.expand(paths);
  const added: Item[] = [];
  let skipped = 0;
  for (const p of files) {
    const kind = kindOf(p);
    if (!kind) {
      skipped++;
      continue;
    }
    if (items.some((x) => x.path.toLowerCase() === p.toLowerCase() && x.status !== 'done')) continue;
    try {
      const r = await xk.media.probe(p);
      const info = parseProbe(r.probe);
      const realKind: Kind = kind === 'video' && !info.hasVideo && info.hasAudio ? 'audio' : kind;
      const it: Item = {
        id: `f${++seq}`,
        path: r.path,
        name: r.name,
        dir: r.dir,
        size: r.size,
        kind: realKind,
        info,
        thumb: null,
        status: 'ready',
        progress: 0,
        ms: 0,
        warnings: [],
        summary: '',
        trimStart: 0,
        trimEnd: 0,
        demo: opts.demo,
      };
      items.push(it);
      added.push(it);
      renderQueue();
      if (realKind !== 'audio') {
        void xk.media.thumb(r.path, info.duration).then((t) => {
          it.thumb = t;
          renderItem(it);
        });
      }
    } catch (e) {
      toast(`${p.replace(/^.*[\\/]/, '')}：${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, 5000);
    }
  }
  if (skipped) toast(`有 ${skipped} 個檔案不是影片、圖片或音訊，已略過`);
  if (added.length) {
    const kinds = new Set(added.map((x) => x.kind));
    if (kinds.size === 1) setTab([...kinds][0]);
  }
  refreshPlans();
  return added;
}

function refreshPlans() {
  for (const it of items) {
    if (it.status === 'ready' || it.status === 'cancelled' || it.status === 'error') {
      try {
        const s = settingsFor(it);
        const plan = buildPlan(it.kind, it.info, s, it.path, outputName(it.name, it.kind, s), it.size);
        it.summary = plan.summary;
        it.warnings = plan.warnings;
        if (plan.estimate && (S.mode !== 'quality' || it.kind === 'audio')) it.summary += `・預估 ≈ ${fmtBytes(plan.estimate)}`;
      } catch (e) {
        it.summary = '';
        it.warnings = [(e as Error).message];
      }
    }
  }
  renderQueue();
}

const KIND_ICON: Record<Kind, string> = { video: '🎬', image: '🖼️', audio: '🎵' };

function itemHtml(it: Item): string {
  const i = it.info;
  const sub: string[] = [];
  if (i.width) sub.push(`${i.width}×${i.height}`);
  if (it.kind !== 'image' && i.duration) sub.push(fmtDuration(i.duration));
  sub.push(fmtBytes(it.size));
  if (it.kind === 'video' && i.vcodec) sub.push(i.vcodec.toUpperCase());
  if (it.kind === 'video' && i.fps) sub.push(`${Math.round(i.fps)} fps`);
  if (it.kind === 'audio' && i.acodec) sub.push(i.acodec.toUpperCase());
  const trim = it.trimStart || it.trimEnd ? `<span class="trim-tag">✂ ${fmtDuration(it.trimStart)}～${it.trimEnd ? fmtDuration(it.trimEnd) : '結尾'}</span>` : '';
  let body = '';
  if (it.status === 'running') {
    const eta = it.progress > 0.02 ? Math.max(0, (it.ms / it.progress) * (1 - it.progress)) / 1000 : 0;
    body = `<div class="plan">壓縮中 ${Math.round(it.progress * 100)}%${eta ? `・剩下約 ${fmtDuration(eta)}` : ''}</div><div class="bar"><i style="width:${(it.progress * 100).toFixed(1)}%"></i></div>`;
  } else if (it.status === 'done') {
    const pct = it.outSize! / it.size;
    const bad = pct >= 1;
    body = `<div class="result"><span class="from">${fmtBytes(it.size)}</span>→<span class="to">${fmtBytes(it.outSize!)}</span><span class="pct${bad ? ' bad' : ''}">${bad ? `+${Math.round((pct - 1) * 100)}%` : `-${Math.round((1 - pct) * 100)}%`}</span><span class="muted">${(it.ms / 1000).toFixed(1)} 秒</span></div>`;
    if (bad) body += `<div class="warn">壓縮後沒有變小（原檔已經很精簡），建議保留原檔。</div>`;
    body += `<div class="sub" title="${esc(it.out!)}">${esc(it.out!.replace(/^.*[\\/]/, ''))}</div>`;
  } else if (it.status === 'error') {
    body = `<div class="err">失敗：${esc(it.error ?? '')}</div>`;
  } else {
    body = `<div class="plan">${it.status === 'cancelled' ? '已取消・' : ''}${esc(it.summary)}</div>${it.warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}`;
  }
  const acts: string[] = [];
  if (it.status === 'running') acts.push('<button type="button" data-act="cancel">取消</button>');
  if (it.status === 'done') {
    acts.push('<button type="button" data-act="compare">⇆ 比較</button>', '<button type="button" data-act="open">▶ 開啟</button>', '<button type="button" data-act="reveal">📂 資料夾</button>');
    if (it.outSize! >= it.size) acts.push('<button type="button" data-act="trash">刪除結果</button>');
    acts.push('<button type="button" data-act="again">再壓一次</button>');
  }
  if (it.status === 'error' || it.status === 'cancelled') acts.push('<button type="button" data-act="again">重試</button>');
  if (it.status === 'ready' && it.kind !== 'image' && it.info.duration > 1) acts.push('<button type="button" data-act="trim">✂ 修剪</button>');
  if (it.status !== 'running') acts.push('<button type="button" data-act="remove" class="rm" title="從清單移除（不會刪除檔案）">✕</button>');
  const thumbStyle = it.thumb ? ` style="background-image:url('${it.thumb}')"` : '';
  return `<div class="thumb"${thumbStyle}>${it.thumb ? '' : KIND_ICON[it.kind]}<span class="badge">${KIND_ICON[it.kind]}</span>${it.kind !== 'image' && it.info.duration ? `<span class="dur">${fmtDuration(it.info.duration)}</span>` : ''}</div>
    <div class="meta"><div class="name" title="${esc(it.path)}">${esc(it.name)}${trim}</div><div class="sub">${esc(sub.join('・'))}</div>${body}</div>
    <div class="acts">${acts.join('')}</div>`;
}

function renderItem(it: Item) {
  const li = document.querySelector<HTMLLIElement>(`#queue li[data-id="${it.id}"]`);
  if (!li) return renderQueue();
  li.className = `item ${it.status}`;
  li.innerHTML = itemHtml(it);
  renderSummary();
}

function renderQueue() {
  const ul = $('#queue');
  ul.innerHTML = items.map((it) => `<li class="item ${it.status}" data-id="${it.id}">${itemHtml(it)}</li>`).join('');
  $('#empty').hidden = items.length > 0;
  renderSummary();
}

function renderSummary() {
  const done = items.filter((x) => x.status === 'done');
  const before = done.reduce((a, x) => a + x.size, 0);
  const after = done.reduce((a, x) => a + (x.outSize ?? 0), 0);
  let t = items.length ? `共 <b>${items.length}</b> 個檔案・${fmtBytes(items.reduce((a, x) => a + x.size, 0))}` : '還沒有檔案';
  if (done.length) t += `・已完成 ${done.length} 個：${fmtBytes(before)} → <b>${fmtBytes(after)}</b> <span class="save">省下 ${Math.max(0, Math.round((1 - after / before) * 100))}%</span>`;
  $('#queue-sum').innerHTML = t;
  const ready = items.some((x) => x.status === 'ready');
  ($('#start') as HTMLButtonElement).disabled = running || !ready;
  ($('#stop') as HTMLButtonElement).disabled = !running;
  ($('#clear-done') as HTMLButtonElement).disabled = !done.length;
  ($('#clear-all') as HTMLButtonElement).disabled = !items.length || running;
}

function setStatus(text: string, p = -1) {
  $('#status').textContent = text;
  if (p >= 0) $('#overall-bar').style.width = `${(p * 100).toFixed(1)}%`;
}

$('#queue').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
  const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-id]');
  if (!b || !li || !xk) return;
  const it = items.find((x) => x.id === li.dataset.id);
  if (!it) return;
  switch (b.dataset.act) {
    case 'cancel':
      await xk.job.cancel(it.id);
      break;
    case 'remove':
      items.splice(items.indexOf(it), 1);
      renderQueue();
      break;
    case 'again':
      it.status = 'ready';
      it.progress = 0;
      it.error = undefined;
      refreshPlans();
      break;
    case 'open':
      if (it.out) await xk.shell.open(it.out);
      break;
    case 'reveal':
      if (it.out) await xk.shell.reveal(it.out);
      break;
    case 'trash':
      if (it.out && confirm(`把「${it.out.replace(/^.*[\\/]/, '')}」移到${xk.platform === 'darwin' ? '垃圾桶' : '資源回收筒'}？`)) {
        await xk.shell.trash(it.out);
        it.status = 'ready';
        it.out = undefined;
        refreshPlans();
      }
      break;
    case 'compare':
      openCompare(it);
      break;
    case 'trim':
      openTrim(it);
      break;
  }
});

// --- 壓縮 ----------------------------------------------------------------------------

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function runOne(it: Item): Promise<void> {
  const s = settingsFor(it);
  const name = outputName(it.name, it.kind, s);
  const dir = ui.outMode === 'custom' && ui.outDir ? ui.outDir : it.dir;
  const out = await xk!.media.outPath(dir, name);
  const plan = buildPlan(it.kind, it.info, s, it.path, out, it.size);
  it.status = 'running';
  it.progress = 0;
  it.ms = 0;
  it.warnings = plan.warnings;
  currentId = it.id;
  renderItem(it);
  try {
    const r = await xk!.job.run(it.id, { input: it.path, output: out, passes: plan.passes, duration: plan.duration });
    it.status = 'done';
    it.out = r.output;
    it.outSize = r.size;
    it.ms = r.ms;
  } catch (e) {
    const msg = errText(e);
    if (/已取消/.test(msg)) it.status = 'cancelled';
    else {
      it.status = 'error';
      it.error = msg;
    }
  } finally {
    currentId = null;
    renderItem(it);
  }
}

async function runAll(): Promise<void> {
  if (running || !xk) return;
  const todo = items.filter((x) => x.status === 'ready');
  if (!todo.length) return;
  running = true;
  stopRequested = false;
  renderSummary();
  const t0 = Date.now();
  let n = 0;
  const off = xk.job.onProgress(({ id, p, ms }) => {
    const it = items.find((x) => x.id === id);
    if (!it || it.status !== 'running') return;
    it.progress = p;
    it.ms = ms;
    renderItem(it);
    setStatus(`正在壓縮 ${n + 1} / ${todo.length}：${it.name}`, (n + p) / todo.length);
  });
  try {
    for (const it of todo) {
      if (stopRequested) break;
      if (it.status !== 'ready' || !items.includes(it)) continue;
      setStatus(`正在壓縮 ${n + 1} / ${todo.length}：${it.name}`, n / todo.length);
      await runOne(it);
      n++;
    }
  } finally {
    off();
    running = false;
    const done = todo.filter((x) => x.status === 'done');
    const fail = todo.filter((x) => x.status === 'error').length;
    const before = done.reduce((a, x) => a + x.size, 0);
    const after = done.reduce((a, x) => a + (x.outSize ?? 0), 0);
    setStatus(
      stopRequested
        ? '已停止'
        : done.length
          ? `完成 ${done.length} 個${fail ? `、失敗 ${fail} 個` : ''}：${fmtBytes(before)} → ${fmtBytes(after)}，省下 ${Math.max(0, Math.round((1 - after / before) * 100))}%（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`
          : fail
            ? `失敗 ${fail} 個`
            : '準備好了',
      done.length || fail ? 1 : 0,
    );
    renderSummary();
  }
}

$('#start').addEventListener('click', () => {
  runDone = runAll();
});
$('#stop').addEventListener('click', async () => {
  stopRequested = true;
  if (currentId && xk) await xk.job.cancel(currentId);
});
$('#clear-done').addEventListener('click', () => {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].status === 'done') items.splice(i, 1);
  renderQueue();
});
$('#clear-all').addEventListener('click', () => {
  if (running) return;
  items.length = 0;
  renderQueue();
  setStatus('準備好了', 0);
});

// --- 加入檔案 ------------------------------------------------------------------------

function showWebNote() {
  const n = $('#web-note');
  n.innerHTML = '線上版正在製作中，目前請先使用 <a href="https://github.com/achir1015/xiaoke-compress/releases/latest" target="_blank" rel="noopener" style="color:#7fd6ff">Windows 桌面版</a>。';
  n.hidden = false;
  setTimeout(() => (n.hidden = true), 6000);
}

$('#pick').addEventListener('click', async () => {
  if (!xk) return showWebNote();
  const files = await xk.pickFiles();
  if (files.length) await addPaths(files);
});
$('#sample').addEventListener('click', () => void addSample());

async function addSample(demo = false): Promise<Item | null> {
  if (!xk) {
    showWebNote();
    return null;
  }
  setStatus('正在準備範例影片…');
  try {
    const f = await xk.media.sample();
    const [it] = await addPaths([f], { demo });
    setStatus('準備好了');
    return it ?? items.find((x) => x.path === f && x.status === 'ready') ?? null;
  } catch (e) {
    setStatus('範例影片產生失敗');
    toast(errText(e));
    return null;
  }
}

const drop = $('#drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  drop.classList.add('over');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    drop.classList.remove('over');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('over');
  if (!xk) return showWebNote();
  const paths = [...(e.dataTransfer?.files ?? [])].map((f) => xk.pathOf(f)).filter(Boolean);
  if (paths.length) void addPaths(paths);
});
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') $('#pick').click();
});

// --- 比較視窗 ------------------------------------------------------------------------

let closeCompare: (() => void) | null = null;

function openCompare(it: Item) {
  if (!it.out) return;
  closeCompare?.();
  const d = document.createElement('dialog');
  d.className = 'cmp';
  const pct = it.outSize! / it.size;
  const head = `<div class="cmp-head"><span class="name">${esc(it.name)}</span><span>原檔 ${fmtBytes(it.size)} → 壓縮後 ${fmtBytes(it.outSize!)}（${pct < 1 ? '-' : '+'}${Math.abs(Math.round((1 - pct) * 100))}%）</span><button type="button" class="x">✕ 關閉</button></div>`;
  if (it.kind === 'audio') {
    d.innerHTML = `${head}<div class="cmp-audio"><div>原檔</div><audio controls src="${mediaUrl(it.path)}"></audio><div>壓縮後</div><audio controls src="${mediaUrl(it.out)}"></audio></div>`;
  } else {
    const tag = it.kind === 'image' ? 'img' : 'video';
    const attrs = tag === 'video' ? ' muted playsinline preload="auto"' : ' draggable="false"';
    d.innerHTML = `${head}
      <div class="cmp-stage" style="--x:50%;aspect-ratio:${it.info.width || 16} / ${it.info.height || 9}">
        <${tag} class="before" src="${mediaUrl(it.path)}"${attrs}></${tag}>
        <${tag} class="after" src="${mediaUrl(it.out)}"${tag === 'video' ? ' playsinline preload="auto"' : attrs}></${tag}>
        <div class="cmp-line"></div><span class="cmp-tag l">原檔 ${fmtBytes(it.size)}</span><span class="cmp-tag r">壓縮後 ${fmtBytes(it.outSize!)}</span>
      </div>
      ${tag === 'video' ? '<div class="cmp-ctrl"><button type="button" class="play">▶</button><input type="range" class="seek" min="0" max="1000" value="0"><span class="time">0:00</span></div>' : '<div class="cmp-ctrl"><span class="time">左右拖曳白線，比較原檔（左）和壓縮後（右）的畫質。滾輪可放大。</span></div>'}`;
  }
  document.body.append(d);
  d.showModal();
  const stage = d.querySelector<HTMLElement>('.cmp-stage');
  let timer = 0;
  if (stage) {
    const setX = (clientX: number) => {
      const r = stage.getBoundingClientRect();
      stage.style.setProperty('--x', `${Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)).toFixed(2)}%`);
    };
    let dragging = false;
    stage.addEventListener('pointerdown', (e) => {
      dragging = true;
      stage.setPointerCapture(e.pointerId);
      setX(e.clientX);
    });
    stage.addEventListener('pointermove', (e) => dragging && setX(e.clientX));
    stage.addEventListener('pointerup', () => (dragging = false));
    // 滾輪放大，看細節
    let zoom = 1;
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoom = Math.min(6, Math.max(1, zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      const r = stage.getBoundingClientRect();
      const ox = ((e.clientX - r.left) / r.width) * 100;
      const oy = ((e.clientY - r.top) / r.height) * 100;
      for (const m of stage.querySelectorAll<HTMLElement>('video, img')) {
        m.style.transformOrigin = `${ox}% ${oy}%`;
        m.style.transform = `scale(${zoom})`;
      }
    });
    const before = stage.querySelector<HTMLVideoElement>('video.before');
    const after = stage.querySelector<HTMLVideoElement>('video.after');
    if (before && after) {
      const offset = it.trimStart || 0;
      const play = d.querySelector<HTMLButtonElement>('.play')!;
      const seek = d.querySelector<HTMLInputElement>('.seek')!;
      const time = d.querySelector<HTMLElement>('.time')!;
      const sync = () => {
        if (Math.abs(before.currentTime - (after.currentTime + offset)) > 0.12) before.currentTime = after.currentTime + offset;
      };
      after.addEventListener('loadedmetadata', () => {
        before.currentTime = offset;
      });
      play.addEventListener('click', () => {
        if (after.paused) {
          sync();
          void after.play();
          void before.play();
        } else {
          after.pause();
          before.pause();
        }
      });
      after.addEventListener('play', () => (play.textContent = '❚❚'));
      after.addEventListener('pause', () => {
        play.textContent = '▶';
        before.pause();
        sync();
      });
      after.addEventListener('ended', () => before.pause());
      seek.addEventListener('input', () => {
        if (after.duration) after.currentTime = (+seek.value / 1000) * after.duration;
        sync();
      });
      timer = window.setInterval(() => {
        if (!after.duration) return;
        if (document.activeElement !== seek) seek.value = String(Math.round((after.currentTime / after.duration) * 1000));
        time.textContent = `${fmtDuration(after.currentTime)} / ${fmtDuration(after.duration)}`;
        if (!after.paused) sync();
      }, 250);
    }
  }
  const close = () => {
    clearInterval(timer);
    for (const m of d.querySelectorAll<HTMLMediaElement>('video, audio')) {
      m.pause();
      m.removeAttribute('src');
      m.load();
    }
    d.remove();
    closeCompare = null;
  };
  closeCompare = close;
  d.querySelector('.x')!.addEventListener('click', close);
  d.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
}

// --- 修剪視窗 ------------------------------------------------------------------------

function parseTime(t: string): number | null {
  const p = t.trim().split(':').map(Number);
  if (!p.length || p.some((x) => !Number.isFinite(x))) return null;
  return p.reduce((a, x) => a * 60 + x, 0);
}
const fmtT = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

function openTrim(it: Item) {
  const dur = it.info.duration;
  let a = it.trimStart;
  let b = it.trimEnd || dur;
  const d = document.createElement('dialog');
  d.className = 'trim';
  const media = it.kind === 'video' ? `<video src="${mediaUrl(it.path)}" controls playsinline preload="auto"></video>` : `<audio src="${mediaUrl(it.path)}" controls style="width:100%;margin:16px 0 0"></audio>`;
  d.innerHTML = `${media}<div class="trim-body">
    <div class="trim-range"><div class="track"></div><div class="sel"></div><input type="range" class="ra" min="0" max="${dur}" step="0.1"><input type="range" class="rb" min="0" max="${dur}" step="0.1"></div>
    <div class="trim-row">開始 <input type="text" class="ta"> <button type="button" class="ghost small seta">設為目前畫面</button>
      <span class="spacer"></span>結束 <input type="text" class="tb"> <button type="button" class="ghost small setb">設為目前畫面</button></div>
    <div class="trim-row"><span class="muted len"></span><span class="spacer"></span><button type="button" class="ghost reset">不修剪</button><button type="button" class="ghost cancel">取消</button><button type="button" class="primary ok">確定</button></div>
  </div>`;
  document.body.append(d);
  d.showModal();
  const m = d.querySelector<HTMLMediaElement>('video, audio')!;
  const ra = d.querySelector<HTMLInputElement>('.ra')!;
  const rb = d.querySelector<HTMLInputElement>('.rb')!;
  const ta = d.querySelector<HTMLInputElement>('.ta')!;
  const tb = d.querySelector<HTMLInputElement>('.tb')!;
  const sel = d.querySelector<HTMLElement>('.sel')!;
  const upd = (seekTo?: number) => {
    a = Math.max(0, Math.min(a, dur));
    b = Math.max(a + 0.1, Math.min(b, dur));
    ra.value = String(a);
    rb.value = String(b);
    if (document.activeElement !== ta) ta.value = fmtT(a);
    if (document.activeElement !== tb) tb.value = fmtT(b);
    sel.style.left = `${(a / dur) * 100}%`;
    sel.style.width = `${((b - a) / dur) * 100}%`;
    d.querySelector('.len')!.textContent = `保留 ${fmtT(b - a)}（原長 ${fmtT(dur)}）`;
    if (seekTo !== undefined) m.currentTime = seekTo;
  };
  ra.addEventListener('input', () => {
    a = Math.min(+ra.value, b - 0.1);
    upd(a);
  });
  rb.addEventListener('input', () => {
    b = Math.max(+rb.value, a + 0.1);
    upd(b);
  });
  ta.addEventListener('change', () => {
    const v = parseTime(ta.value);
    if (v !== null) a = v;
    upd(a);
  });
  tb.addEventListener('change', () => {
    const v = parseTime(tb.value);
    if (v !== null) b = v;
    upd(b);
  });
  d.querySelector('.seta')!.addEventListener('click', () => {
    a = m.currentTime;
    upd();
  });
  d.querySelector('.setb')!.addEventListener('click', () => {
    b = m.currentTime;
    upd();
  });
  m.addEventListener('timeupdate', () => {
    if (m.currentTime >= b && !m.paused) {
      m.pause();
      m.currentTime = b;
    }
  });
  const close = () => {
    m.pause();
    m.removeAttribute('src');
    m.load();
    d.remove();
  };
  d.querySelector('.cancel')!.addEventListener('click', close);
  d.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  d.querySelector('.reset')!.addEventListener('click', () => {
    it.trimStart = 0;
    it.trimEnd = 0;
    close();
    refreshPlans();
  });
  d.querySelector('.ok')!.addEventListener('click', () => {
    it.trimStart = a < 0.05 ? 0 : +a.toFixed(2);
    it.trimEnd = b > dur - 0.05 ? 0 : +b.toFixed(2);
    close();
    refreshPlans();
  });
  m.addEventListener('loadedmetadata', () => upd(a), { once: true });
  upd();
}

// --- 給教學與測試使用的操作介面 ----------------------------------------------------------

window.xkApp = {
  addSample: async () => (await addSample(true))?.id ?? null,
  addPaths: async (paths: string[]) => (await addPaths(paths)).map((x) => x.id),
  setTab,
  setMode: (m) => setSetting('mode', m),
  setSetting: (k, v) => setSetting(k as keyof Settings, v as never),
  setHw: (h) => {
    ui.hw = h as Ui['hw'];
    save();
    syncForm();
    refreshPlans();
  },
  openAdvanced: (open = true) => {
    const a = $<HTMLDetailsElement>('#adv');
    a.open = open;
    return a;
  },
  start: async () => {
    runDone = runAll();
    await runDone;
  },
  wait: () => runDone,
  items: () => items.map((x) => ({ id: x.id, name: x.name, kind: x.kind, status: x.status, size: x.size, outSize: x.outSize ?? 0, out: x.out ?? '', progress: x.progress, error: x.error ?? '', summary: x.summary, warnings: x.warnings, demo: !!x.demo })),
  remove: (id: string) => {
    const i = items.findIndex((x) => x.id === id);
    if (i >= 0 && items[i].status !== 'running') items.splice(i, 1);
    renderQueue();
  },
  removeDemo: () => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i].demo && items[i].status !== 'running') items.splice(i, 1);
    renderQueue();
  },
  openCompare: (id: string) => {
    const it = items.find((x) => x.id === id);
    if (it) openCompare(it);
    return !!document.querySelector('.cmp');
  },
  closeDialogs: () => closeCompare?.(),
  settings: () => ({ s: { ...S }, ui: { ...ui } }),
  load: (snap) => {
    S = { ...DEFAULTS, ...(snap.s as Partial<Settings>) };
    ui = { ...ui, ...(snap.ui as Partial<Ui>) };
    save();
    syncForm();
    refreshPlans();
  },
  busy: () => running,
};

// --- 啟動 ----------------------------------------------------------------------------

function init() {
  $('#ver').textContent = `v${__APP_VERSION__}`;
  $('#guide-btn .mini-robot').innerHTML = ROBOT_SVG;
  $('.empty-robot').innerHTML = ROBOT_SVG;
  $('#guide-btn').addEventListener('click', () => void startGuide());
  buildForm();
  syncForm();
  renderQueue();
  initUpdateButton(__APP_VERSION__);
  if (xk) {
    void xk.hw().then((h) => {
      hwInfo = h;
      fillHwOptions();
      refreshPlans();
    });
    // 啟動後安靜地檢查一次更新
    setTimeout(() => void checkUpdate(__APP_VERSION__, true), 4000);
  } else {
    hwInfo = { nvenc: false, qsv: false, amf: false, videotoolbox: false, hevc: { nvenc: false, qsv: false, amf: false, videotoolbox: false } };
    fillHwOptions();
  }
  guideOnFirstRun();
}

init();
