// 線上版後端：檔案只在瀏覽器裡處理，不上傳。
// 影片／音訊優先用 WebCodecs（mediabunny，瀏覽器的硬體編碼，很快）；
// 瀏覽器讀不了的格式（AVI、WMV、FLV…）或不支援 WebCodecs 時，改用 ffmpeg.wasm（共用桌面版的參數）。
// 圖片用 Canvas 重新編碼，PNG 用 UPNG 減色。
import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Conversion,
  Input,
  MkvOutputFormat,
  MovOutputFormat,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type OutputFormat,
} from 'mediabunny';
import UPNG from 'upng-js';
import { buildPlan, extOf, kindOf, outputName, parseProbe, pngColors, webAudioPlan, webVideoPlan, type Kind, type MediaInfo, type Settings } from './engine';
import type { Backend, JobInput, JobResult, SourceRef } from './backend';

const MIME: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', opus: 'audio/ogg', jpg: 'image/jpeg', webp: 'image/webp', png: 'image/png',
};
const hasWebCodecs = () => typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

/** 這個檔案由哪一種引擎處理 */
const engineOf = new WeakMap<SourceRef, 'mb' | 'ff' | 'canvas'>();
const urls = new WeakMap<SourceRef, string>();

class Fallback extends Error {}
class Canceled extends Error {
  constructor() {
    super('已取消');
  }
}

// --- mediabunny（WebCodecs） --------------------------------------------------------------

const MB_EXT = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']);
const VCODEC_NAME: Record<string, string> = { avc: 'h264', hevc: 'hevc', vp9: 'vp9', av1: 'av1', vp8: 'vp8', prores: 'prores' };

function openInput(file: File) {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}
function dispose(input: Input) {
  try {
    (input as unknown as { dispose?: () => void }).dispose?.();
  } catch {
    // 已經關了
  }
}

async function mbProbe(file: File): Promise<MediaInfo | null> {
  if (!hasWebCodecs() || !MB_EXT.has(extOf(file.name))) return null;
  const input = openInput(file);
  try {
    await input.getFormat();
    const duration = await input.computeDuration();
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    const info: MediaInfo = { duration, bitrate: duration ? (file.size * 8) / duration / 1000 : 0, width: 0, height: 0, fps: 0, vcodec: '', acodec: '', abitrate: 0, hasVideo: !!v, hasAudio: !!a, rotation: 0 };
    if (v) {
      if (!(await v.canDecode())) return null;
      info.vcodec = VCODEC_NAME[v.codec ?? ''] ?? String(v.codec ?? '');
      info.width = await v.getSquarePixelWidth();
      info.height = await v.getSquarePixelHeight();
      info.rotation = ((await v.getRotation()) + 360) % 360;
      if (info.rotation === 90 || info.rotation === 270) [info.width, info.height] = [info.height, info.width];
      const st = await v.computePacketStats(120);
      info.fps = Math.round(st.averagePacketRate * 100) / 100;
    }
    if (a) {
      if (!(await a.canDecode())) return null;
      info.acodec = String(a.codec ?? '');
      const st = await a.computePacketStats(100);
      info.abitrate = Math.round(st.averageBitrate / 1000);
    }
    return info;
  } catch {
    return null;
  } finally {
    dispose(input);
  }
}

let mp3Ready = false;
async function ensureMp3() {
  if (mp3Ready) return;
  if (!(await canEncodeAudio('mp3'))) {
    const { registerMp3Encoder } = await import('@mediabunny/mp3-encoder');
    registerMp3Encoder();
  }
  mp3Ready = true;
}

const running = new Map<string, { cancel(): Promise<void> | void }>();

async function convert(job: JobInput, format: OutputFormat, video: Record<string, unknown> | null, audio: Record<string, unknown> | null, onProgress: (p: number) => void): Promise<ArrayBuffer> {
  const input = openInput(job.src.file!);
  const target = new BufferTarget();
  const output = new Output({ format, target });
  const s = job.settings;
  const trim = s.trimStart > 0 || s.trimEnd > 0 ? { start: s.trimStart || 0, ...(s.trimEnd > 0 ? { end: s.trimEnd } : {}) } : undefined;
  try {
    const conv = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: video ?? { discard: true },
      audio: audio ?? { discard: true },
      trim,
      tags: s.stripMeta ? {} : undefined,
      showWarnings: false,
    });
    if (!conv.isValid) throw new Fallback(conv.discardedTracks.map((d) => d.reason).join('、') || '無法轉換');
    let cancelled = false;
    running.set(job.id, {
      cancel: () => {
        cancelled = true;
        return conv.cancel();
      },
    });
    conv.onProgress = (p) => onProgress(p);
    try {
      await conv.execute();
    } catch (e) {
      if (cancelled) throw new Canceled();
      throw e;
    }
    if (!target.buffer) throw new Error('沒有產生輸出檔');
    return target.buffer;
  } finally {
    running.delete(job.id);
    dispose(input);
  }
}

async function firstEncodable<T extends string>(list: readonly T[], test: (c: T) => Promise<boolean>): Promise<T | null> {
  for (const c of list) {
    try {
      if (await test(c)) return c;
    } catch {
      // 不支援
    }
  }
  return null;
}

async function mbVideo(job: JobInput, onProgress: (p: number, ms: number) => void): Promise<JobResult> {
  const t0 = now();
  const plan = webVideoPlan(job.info, job.settings, job.src.size);
  const vcodec = await firstEncodable(plan.videoCodecs, (c) => canEncodeVideo(c, { width: plan.width, height: plan.height, bitrate: plan.videoKbps * 1000 }));
  if (!vcodec) throw new Fallback('瀏覽器不支援這種影像編碼');
  let acodec: 'aac' | 'opus' | null = null;
  if (plan.audioKbps) {
    acodec = await firstEncodable(plan.audioCodecs, (c) => canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000, bitrate: plan.audioKbps * 1000 }));
    if (!acodec) throw new Fallback('瀏覽器不支援聲音編碼');
  }
  const warnings = [...plan.warnings];
  let container = plan.container;
  if (container === 'mov' && (vcodec === 'vp9' || vcodec === 'av1')) container = 'mp4';
  const wanted = { avc: 'h264', hevc: 'h265', vp9: 'vp9', av1: 'av1' }[vcodec];
  if (wanted !== (job.settings.container === 'webm' && /^h26/.test(job.settings.codec) ? 'vp9' : job.settings.codec))
    warnings.push(`這個瀏覽器不支援 ${job.settings.codec.toUpperCase()} 編碼，改用 ${wanted.toUpperCase()}。`);
  const fmt = (): OutputFormat =>
    container === 'webm' ? new WebMOutputFormat() : container === 'mkv' ? new MkvOutputFormat() : container === 'mov' ? new MovOutputFormat({ fastStart: 'in-memory' }) : new Mp4OutputFormat({ fastStart: 'in-memory' });
  const once = (vk: number, p0: number, p1: number) =>
    convert(
      job,
      fmt(),
      {
        codec: vcodec,
        width: plan.width,
        height: plan.height,
        fit: 'fill',
        allowTransformationMetadata: false,
        ...(plan.fps ? { frameRate: plan.fps } : {}),
        quality: new Quality({ bitrate: Math.round(vk * 1000), bitrateMode: 'variable' }),
        forceTranscode: true,
      },
      plan.audioKbps ? { codec: acodec!, quality: new Quality({ bitrate: plan.audioKbps * 1000 }), numberOfChannels: 2, forceTranscode: true } : null,
      (p) => onProgress(p0 + p * (p1 - p0), now() - t0),
    );
  let buf = await once(plan.videoKbps, 0, 1);
  // 硬體編碼的位元率不太準：指定大小超過 8% 就照比例再壓一次
  if (plan.targetBytes && buf.byteLength > plan.targetBytes * 1.08) {
    const k = (plan.targetBytes / buf.byteLength) * 0.95;
    onProgress(0, now() - t0);
    buf = await once(Math.max(60, plan.videoKbps * k), 0, 1);
  }
  const ext = container;
  const outName = outputName(job.src.name, 'video', { ...job.settings, container });
  return finish(buf, ext, outName, t0, warnings, 'WebCodecs');
}

async function mbAudio(job: JobInput, onProgress: (p: number, ms: number) => void): Promise<JobResult> {
  const t0 = now();
  const plan = webAudioPlan(job.info, job.settings, job.src.size);
  let format: OutputFormat;
  let codec: 'mp3' | 'aac' | 'opus';
  if (plan.format === 'mp3') {
    await ensureMp3();
    format = new Mp3OutputFormat();
    codec = 'mp3';
  } else if (plan.format === 'm4a') {
    format = new Mp4OutputFormat({ fastStart: 'in-memory' });
    codec = 'aac';
  } else {
    format = new OggOutputFormat();
    codec = 'opus';
  }
  if (!(await canEncodeAudio(codec, { numberOfChannels: plan.channels, sampleRate: codec === 'opus' ? 48000 : 44100, bitrate: plan.kbps * 1000 }).catch(() => false)))
    throw new Fallback('瀏覽器不支援這種聲音編碼');
  const buf = await convert(job, format, null, { codec, quality: new Quality({ bitrate: plan.kbps * 1000 }), numberOfChannels: plan.channels, forceTranscode: true }, (p) => onProgress(p, now() - t0));
  return finish(buf, plan.format, outputName(job.src.name, 'audio', job.settings), t0, plan.warnings, 'WebCodecs');
}

function finish(buf: ArrayBuffer | Uint8Array | Blob, ext: string, outName: string, t0: number, warnings: string[], engine: string): JobResult {
  const blob = buf instanceof Blob ? buf : new Blob([buf as BlobPart], { type: MIME[ext] ?? 'application/octet-stream' });
  return { out: URL.createObjectURL(blob), outName, size: blob.size, ms: now() - t0, warnings, engine };
}

// --- 圖片（Canvas） ----------------------------------------------------------------------

async function decodeImage(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return null;
  }
}

function canvasOf(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function canvasImage(job: JobInput, onProgress: (p: number, ms: number) => void): Promise<JobResult> {
  const t0 = now();
  const bmp = await decodeImage(job.src.file!);
  if (!bmp) throw new Fallback('瀏覽器讀不了這張圖片');
  const s = job.settings;
  let w = bmp.width;
  let h = bmp.height;
  if (s.imageMax > 0 && Math.max(w, h) > s.imageMax) {
    const k = s.imageMax / Math.max(w, h);
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
  }
  let name = outputName(job.src.name, 'image', s);
  let ext = extOf(name);
  const warnings: string[] = [];
  const c = canvasOf(w, h);
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  if (ext === 'jpg') {
    g.fillStyle = '#fff'; // JPG 沒有透明：透明處補白
    g.fillRect(0, 0, w, h);
  }
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  onProgress(0.5, now() - t0);
  let blob: Blob;
  if (ext === 'png') {
    const data = g.getImageData(0, 0, w, h).data;
    const bin = UPNG.encode([data.buffer], w, h, pngColors(s.imageQuality));
    blob = new Blob([bin], { type: 'image/png' });
  } else {
    const type = MIME[ext];
    blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('圖片編碼失敗'))), type, s.imageQuality / 100));
    if (blob.type !== type) {
      // Safari 不會產生 WebP：改存 JPG
      warnings.push('這個瀏覽器不能產生 WebP，改存成 JPG。');
      g.globalCompositeOperation = 'destination-over';
      g.fillStyle = '#fff';
      g.fillRect(0, 0, w, h);
      blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('圖片編碼失敗'))), 'image/jpeg', s.imageQuality / 100));
      ext = 'jpg';
      name = name.replace(/\.[^.]+$/, '.jpg');
    }
  }
  return finish(blob, ext, name, t0, warnings, 'Canvas');
}

// --- ffmpeg.wasm（備援） -------------------------------------------------------------------

type FF = import('@ffmpeg/ffmpeg').FFmpeg;
let ffPromise: Promise<FF> | null = null;
let ffLog: (msg: string) => void = () => {};

function loadFF(): Promise<FF> {
  ffPromise ??= (async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const ff = new FFmpeg();
    ff.on('log', ({ message }) => ffLog(message));
    const base = new URL('ffmpeg/', location.href).href;
    await ff.load({ coreURL: `${base}ffmpeg-core.js`, wasmURL: `${base}ffmpeg-core.wasm` });
    return ff;
  })().catch((e) => {
    ffPromise = null;
    throw new Error(`FFmpeg 載入失敗：${(e as Error).message}`);
  });
  return ffPromise;
}

let ffSeq = 0;
/** 把檔案掛進 ffmpeg.wasm（WORKERFS 不會複製整個檔案），執行 fn 後卸載 */
async function withMounted<T>(file: File, fn: (ff: FF, path: string) => Promise<T>): Promise<T> {
  const ff = await loadFF();
  const { FFFSType } = await import('@ffmpeg/ffmpeg');
  const dir = `/in${++ffSeq}`;
  await ff.createDir(dir);
  await ff.mount(FFFSType.WORKERFS, { files: [file] }, dir);
  try {
    return await fn(ff, `${dir}/${file.name}`);
  } finally {
    await ff.unmount(dir).catch(() => {});
    await ff.deleteDir(dir).catch(() => {});
  }
}

async function ffProbe(file: File): Promise<MediaInfo> {
  return withMounted(file, async (ff, path) => {
    let text = '';
    ffLog = (m) => (text += m + '\n');
    try {
      await ff.exec(['-hide_banner', '-i', path]);
    } finally {
      ffLog = () => {};
    }
    if (!/Stream #/.test(text)) throw new Error('無法讀取這個檔案（格式不支援）');
    return parseProbe(text);
  });
}

async function ffRun(job: JobInput, onProgress: (p: number, ms: number) => void, reason = ''): Promise<JobResult> {
  const t0 = now();
  const s: Settings = { ...job.settings, hw: 'off' };
  const name = outputName(job.src.name, job.kind, s);
  const ext = extOf(name);
  const out = `/out${++ffSeq}.${ext}`;
  running.set(job.id, {
    cancel: () => {
      // ffmpeg.wasm 不能中斷單一指令：直接結束整個 worker，下次再重新載入
      const p = ffPromise;
      ffPromise = null;
      void p?.then((ff) => ff.terminate());
      ffCancelled.add(job.id);
    },
  });
  try {
    return await withMounted(job.src.file!, async (ff, path) => {
      const plan = buildPlan(job.kind, job.info, s, path, out, job.src.size, 'xkpass');
      let tail = '';
      for (let i = 0; i < plan.passes.length; i++) {
        // 進度靠 log 裡的 time=，所以不能用 -loglevel error
        const args = plan.passes[i]
          .filter((a, k, arr) => a !== '-nostats' && a !== '-progress' && arr[k - 1] !== '-progress')
          .map((a, k, arr) => (arr[k - 1] === '-loglevel' ? 'info' : a));
        ffLog = (m) => {
          tail = (tail + m + '\n').slice(-2000);
          const t = /time=\s*(\d+):(\d+):([\d.]+)/.exec(m);
          if (t && plan.duration > 0) onProgress((i + Math.min(1, (+t[1] * 3600 + +t[2] * 60 + +t[3]) / plan.duration)) / plan.passes.length, now() - t0);
        };
        const code = await ff.exec(args);
        if (ffCancelled.has(job.id)) throw new Canceled();
        if (code !== 0) throw new Error(tail.trim().split('\n').slice(-3).join('\n') || `FFmpeg 結束代碼 ${code}`);
      }
      const data = (await ff.readFile(out)) as Uint8Array;
      await ff.deleteFile(out).catch(() => {});
      const warnings = [...plan.warnings];
      if (reason) warnings.push(`${reason}，改用 FFmpeg（較慢）。`);
      return finish(new Uint8Array(data), ext, name, t0, warnings, 'FFmpeg');
    });
  } catch (e) {
    if (ffCancelled.has(job.id)) throw new Canceled();
    throw e;
  } finally {
    ffLog = () => {};
    running.delete(job.id);
    ffCancelled.delete(job.id);
  }
}
const ffCancelled = new Set<string>();

// --- 縮圖 ----------------------------------------------------------------------------

async function videoThumb(url: string, duration: number): Promise<string | null> {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = url;
  try {
    await Promise.race([new Promise((r, j) => ((v.onloadeddata = r), (v.onerror = j))), sleep(8000).then(() => Promise.reject(new Error('timeout')))]);
    v.currentTime = duration > 0 ? Math.min(2, duration / 3) : 0;
    await Promise.race([new Promise((r) => (v.onseeked = r)), sleep(5000)]);
    const k = Math.min(1, 320 / Math.max(v.videoWidth, v.videoHeight));
    const c = canvasOf(Math.round(v.videoWidth * k), Math.round(v.videoHeight * k));
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

async function imageThumb(file: File): Promise<string | null> {
  const bmp = await decodeImage(file);
  if (!bmp) return null;
  const k = Math.min(1, 320 / Math.max(bmp.width, bmp.height));
  const c = canvasOf(Math.round(bmp.width * k), Math.round(bmp.height * k));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL('image/jpeg', 0.7);
}

// --- 範例影片：用 WebCodecs 現場畫出 12 秒的測試畫面＋和弦 --------------------------------------

async function makeSample(): Promise<File> {
  if (!hasWebCodecs()) throw new Error('這個瀏覽器不支援 WebCodecs，無法產生範例影片');
  const W = 1920;
  const H = 1080;
  const FPS = 30;
  const SEC = 12;
  const codec = await firstEncodable(['avc', 'vp9'] as const, (c) => canEncodeVideo(c, { width: W, height: H, bitrate: 16e6 }));
  if (!codec) throw new Error('這個瀏覽器無法產生範例影片');
  const target = new BufferTarget();
  const output = new Output({ format: codec === 'avc' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target });
  const canvas = canvasOf(W, H);
  const g = canvas.getContext('2d')!;
  const vs = new CanvasSource(canvas, { codec, bitrate: 16e6, keyFrameInterval: 2 });
  output.addVideoTrack(vs, { frameRate: FPS });
  const acodec = await firstEncodable(codec === 'avc' ? (['aac', 'opus'] as const) : (['opus'] as const), (c) => canEncodeAudio(c, { numberOfChannels: 2, sampleRate: 48000, bitrate: 192000 }));
  const as = acodec ? new AudioBufferSource({ codec: acodec, bitrate: 192000 }) : null;
  if (as) output.addAudioTrack(as);
  await output.start();
  if (as) {
    const ctx = new OfflineAudioContext(2, 48000 * SEC, 48000);
    for (const f of [262, 330, 392]) {
      const o = ctx.createOscillator();
      const gn = ctx.createGain();
      o.frequency.value = f;
      gn.gain.value = 0.15;
      o.connect(gn).connect(ctx.destination);
      o.start();
    }
    await as.add(await ctx.startRendering());
  }
  const colors = ['#e53935', '#43a047', '#fdd835', '#1e88e5', '#d81b60', '#00acc1', '#fb8c00'];
  // 會動的底片顆粒：讓範例像真的拍攝影片一樣「難壓」，原檔才會有十幾 MB
  const grain = canvasOf(640, 360);
  const gd = grain.getContext('2d')!.createImageData(640, 360);
  for (let p = 0; p < gd.data.length; p += 4) {
    const v = Math.random() * 255;
    gd.data[p] = gd.data[p + 1] = gd.data[p + 2] = v;
    gd.data[p + 3] = 255;
  }
  grain.getContext('2d')!.putImageData(gd, 0, 0);
  for (let i = 0; i < FPS * SEC; i++) {
    const t = i / FPS;
    colors.forEach((c, k) => {
      g.fillStyle = c;
      g.fillRect((k * W) / colors.length, 0, W / colors.length + 1, H);
    });
    g.globalAlpha = 0.22;
    g.globalCompositeOperation = 'overlay';
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) g.drawImage(grain, x * 640 - ((i * 37) % 640), y * 360 - ((i * 23) % 360), 640, 360), g.drawImage(grain, x * 640 + 640 - ((i * 37) % 640), y * 360 + 360 - ((i * 23) % 360), 640, 360);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    // 細節多一點，壓縮才看得出差別
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 16; x++) {
        g.fillStyle = (x + y + Math.floor(t * 4)) % 2 ? '#ffffff22' : '#00000022';
        g.fillRect(x * 120, 700 + y * 40, 120, 40);
      }
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(W / 2 + Math.cos(t * 1.5) * 600, H / 2 + Math.sin(t * 2) * 250, 90, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#182440';
    g.font = 'bold 96px sans-serif';
    g.fillText(`小柯範例影片 ${t.toFixed(1)} 秒`, 80, 160);
    await vs.add(t, 1 / FPS);
  }
  vs.close();
  as?.close();
  await output.finalize();
  return new File([target.buffer!], codec === 'avc' ? '小柯範例影片.mp4' : '小柯範例影片.webm', { type: codec === 'avc' ? 'video/mp4' : 'video/webm' });
}

// --- 拖曳資料夾 --------------------------------------------------------------------------

async function filesFromEntry(entry: FileSystemEntry, out: File[], depth = 0): Promise<void> {
  if (out.length >= 2000) return;
  if (entry.isFile) {
    const f = await new Promise<File>((r, j) => (entry as FileSystemFileEntry).file(r, j)).catch(() => null);
    if (f && kindOf(f.name)) out.push(f);
  } else if (entry.isDirectory && depth < 3) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((r, j) => reader.readEntries(r, j)).catch(() => []);
      if (!batch.length) break;
      for (const e of batch.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'))) await filesFromEntry(e, out, depth + 1);
    }
  }
}

// --- 後端 ----------------------------------------------------------------------------

let refSeq = 0;
const toRef = (f: File): SourceRef => ({ key: `w${++refSeq}`, name: f.name, dir: '', size: f.size, file: f });

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

const ACCEPT = 'video/*,audio/*,image/*,.mkv,.avi,.wmv,.flv,.3gp,.ts,.mts,.m2ts,.mpg,.mpeg,.tif,.tiff,.flac,.opus,.amr,.wma';

export function webBackend(): Backend {
  return {
    web: true,
    pick: () =>
      new Promise((resolve) => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.multiple = true;
        inp.accept = ACCEPT;
        inp.onchange = () => resolve([...(inp.files ?? [])].map(toRef));
        inp.addEventListener('cancel', () => resolve([]));
        inp.click();
      }),
    async fromDrop(dt) {
      const files: File[] = [];
      const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
      if (entries.length && entries.some((e) => e.isDirectory)) for (const e of entries) await filesFromEntry(e, files);
      else files.push(...dt.files);
      return files.map(toRef);
    },
    fromPaths: async () => [],
    async probe(src) {
      const f = src.file!;
      const k = kindOf(f.name) ?? 'video';
      if (k === 'image') {
        const bmp = await decodeImage(f);
        if (bmp) {
          engineOf.set(src, 'canvas');
          const info: MediaInfo = { duration: 0, bitrate: 0, width: bmp.width, height: bmp.height, fps: 0, vcodec: extOf(f.name), acodec: '', abitrate: 0, hasVideo: true, hasAudio: false, rotation: 0 };
          bmp.close();
          return { info, kind: 'image' };
        }
      } else {
        const info = await mbProbe(f);
        if (info && (info.hasVideo || info.hasAudio)) {
          engineOf.set(src, 'mb');
          return { info, kind: k === 'video' && !info.hasVideo ? 'audio' : k };
        }
      }
      engineOf.set(src, 'ff');
      const info = await ffProbe(f);
      return { info, kind: k === 'video' && !info.hasVideo && info.hasAudio ? 'audio' : k };
    },
    async thumb(src, info, kind) {
      if (kind === 'image') return engineOf.get(src) === 'canvas' ? imageThumb(src.file!) : null;
      if (kind === 'video') return videoThumb(this.srcUrl(src), info.duration);
      return null;
    },
    sample: async () => toRef(await makeSample()),
    preview(job) {
      const eng = engineOf.get(job.src);
      if (job.kind === 'video' && eng === 'mb') {
        const p = webVideoPlan(job.info, job.settings, job.src.size);
        return { summary: p.summary, warnings: p.warnings, estimate: p.estimate };
      }
      if (job.kind === 'audio' && eng === 'mb') {
        const p = webAudioPlan(job.info, job.settings, job.src.size);
        return { summary: p.summary, warnings: p.warnings, estimate: p.estimate };
      }
      const p = buildPlan(job.kind, job.info, { ...job.settings, hw: 'off' }, job.src.name, outputName(job.src.name, job.kind, job.settings), job.src.size);
      const slow = eng === 'ff' && job.kind !== 'image' ? '・FFmpeg（較慢）' : '';
      return { summary: p.summary.replace(/・兩趟精準壓縮/, '') + slow, warnings: p.warnings, estimate: p.estimate };
    },
    async run(job, onProgress) {
      const eng = engineOf.get(job.src);
      try {
        if (job.kind === 'image' && eng === 'canvas') return await canvasImage(job, onProgress);
        if (eng === 'mb' && job.kind === 'video') return await mbVideo(job, onProgress);
        if (eng === 'mb' && job.kind === 'audio') return await mbAudio(job, onProgress);
      } catch (e) {
        if (!(e instanceof Fallback)) throw e;
        // 瀏覽器做不到：需要先用 FFmpeg 重新讀一次媒體資訊
        if (!job.info.width && job.kind !== 'audio') job.info = await ffProbe(job.src.file!);
        return ffRun(job, onProgress, e.message);
      }
      return ffRun(job, onProgress);
    },
    async cancel(id) {
      await running.get(id)?.cancel();
    },
    srcUrl(src) {
      let u = urls.get(src);
      if (!u) {
        u = URL.createObjectURL(src.file!);
        urls.set(src, u);
      }
      return u;
    },
    outUrl: (out) => out,
    open: async (out, name) => download(out, name),
    reveal: async () => {},
    discard: async (out) => URL.revokeObjectURL(out),
    hw: async () => null,
    pickFolder: async () => null,
  };
}

/** 讓網頁一開始就知道這個瀏覽器能不能用快速模式 */
export const webCodecsAvailable = hasWebCodecs;
