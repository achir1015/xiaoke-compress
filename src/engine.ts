// 壓縮核心：解析 FFmpeg 讀到的媒體資訊、依設定產生 FFmpeg 參數。
// 不碰檔案系統，桌面版（原生 FFmpeg）與日後的線上版（ffmpeg.wasm）共用，也方便測試。

export type Kind = 'video' | 'image' | 'audio';

export const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', '3gp', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', 'gif'];
export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff'];
export const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'amr'];

export function extOf(name: string): string {
  const m = /\.([^.\\/]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export function kindOf(name: string): Kind | null {
  const e = extOf(name);
  if (VIDEO_EXT.includes(e)) return 'video';
  if (IMAGE_EXT.includes(e)) return 'image';
  if (AUDIO_EXT.includes(e)) return 'audio';
  return null;
}

export interface MediaInfo {
  /** 秒；圖片為 0 */
  duration: number;
  /** 整體位元率 kb/s（讀不到為 0） */
  bitrate: number;
  /** 已依旋轉資訊換成「看起來」的寬高 */
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  acodec: string;
  /** 音訊位元率 kb/s（讀不到為 0） */
  abitrate: number;
  hasVideo: boolean;
  hasAudio: boolean;
  rotation: number;
}

/** 解析 `ffmpeg -hide_banner -i 檔案` 印在 stderr 的資訊。 */
export function parseProbe(text: string): MediaInfo {
  const info: MediaInfo = { duration: 0, bitrate: 0, width: 0, height: 0, fps: 0, vcodec: '', acodec: '', abitrate: 0, hasVideo: false, hasAudio: false, rotation: 0 };
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) info.duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
  const b = /Duration:.*?bitrate:\s*(\d+)\s*kb\/s/.exec(text);
  if (b) info.bitrate = +b[1];
  // 只看第一個影像串流（排除封面圖 attached pic 優先找一般串流）
  const vLines = text.split(/\r?\n/).filter((l) => /Stream #\d+:\d+.*?: Video:/.test(l));
  const vLine = vLines.find((l) => !/attached pic/.test(l)) ?? vLines[0];
  if (vLine) {
    const cover = /attached pic/.test(vLine);
    info.hasVideo = !cover;
    const c = /Video:\s*([\w-]+)/.exec(vLine);
    if (c) info.vcodec = c[1];
    const s = /,\s*(\d{2,5})x(\d{2,5})[\s,[]/.exec(vLine);
    if (s) {
      info.width = +s[1];
      info.height = +s[2];
    }
    const f = /([\d.]+)\s*fps/.exec(vLine) ?? /([\d.]+)\s*tbr/.exec(vLine);
    if (f) info.fps = +f[1];
  }
  const rot = /rotation of (-?[\d.]+) degrees/.exec(text) ?? /rotate\s*:\s*(-?\d+)/.exec(text);
  if (rot) {
    info.rotation = ((Math.round(+rot[1]) % 360) + 360) % 360;
    if (info.rotation === 90 || info.rotation === 270) [info.width, info.height] = [info.height, info.width];
  }
  const aLine = text.split(/\r?\n/).find((l) => /Stream #\d+:\d+.*?: Audio:/.test(l));
  if (aLine) {
    info.hasAudio = true;
    const c = /Audio:\s*([\w-]+)/.exec(aLine);
    if (c) info.acodec = c[1];
    const ab = /(\d+)\s*kb\/s/.exec(aLine);
    if (ab) info.abitrate = +ab[1];
  }
  return info;
}

// --- 設定 --------------------------------------------------------------------------

export type VideoCodec = 'h264' | 'h265' | 'vp9' | 'av1';
export type Container = 'mp4' | 'mkv' | 'mov' | 'webm';
export type Hw = 'off' | 'nvenc' | 'qsv' | 'amf' | 'videotoolbox';
export type Mode = 'quality' | 'size' | 'percent';
export type Res = 'auto' | 'orig' | '2160' | '1440' | '1080' | '720' | '480' | '360' | '240';

export interface Settings {
  mode: Mode;
  /** 0～100，越高畫質越好、檔案越大 */
  quality: number;
  /** 指定大小（MB） */
  targetMB: number;
  /** 原檔的百分比 */
  percent: number;
  codec: VideoCodec;
  container: Container;
  res: Res;
  /** 0＝維持原影格率 */
  fps: number;
  audio: 'keep' | 'mute';
  audioKbps: number;
  /** 0 快 / 1 標準 / 2 慢但更小 */
  speed: 0 | 1 | 2;
  hw: Hw;
  stripMeta: boolean;
  /** 修剪（秒）；end 為 0 代表到結尾 */
  trimStart: number;
  trimEnd: number;
  // 圖片
  imageFormat: 'same' | 'jpg' | 'webp' | 'png';
  imageQuality: number;
  /** 長邊上限（像素），0＝不縮 */
  imageMax: number;
  // 音訊檔
  audioFormat: 'mp3' | 'm4a' | 'opus';
  audioFileKbps: number;
  audioMono: boolean;
  // 輸出
  suffix: string;
}

export const DEFAULTS: Settings = {
  mode: 'quality',
  quality: 60,
  targetMB: 25,
  percent: 30,
  codec: 'h264',
  container: 'mp4',
  res: 'auto',
  fps: 0,
  audio: 'keep',
  audioKbps: 128,
  speed: 1,
  hw: 'off',
  stripMeta: true,
  trimStart: 0,
  trimEnd: 0,
  imageFormat: 'same',
  imageQuality: 75,
  imageMax: 0,
  audioFormat: 'mp3',
  audioFileKbps: 128,
  audioMono: false,
  suffix: '_壓縮',
};

/** 品質快選（壓縮強度）。 */
export const QUALITY_PRESETS = [
  { id: 'high', label: '高畫質', quality: 80, hint: '幾乎看不出差別，約省 30～60%' },
  { id: 'balanced', label: '均衡', quality: 60, hint: '推薦！畫質好、檔案小' },
  { id: 'small', label: '小檔案', quality: 40, hint: '適合傳 LINE、Email' },
  { id: 'tiny', label: '極小', quality: 20, hint: '檔案最小，畫質明顯降低' },
] as const;

// --- 計算 --------------------------------------------------------------------------

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** 品質 0～100 對應各編碼器的 CRF（數字越小畫質越好）。 */
export function crfFor(codec: VideoCodec, quality: number): number {
  const q = clamp(quality, 0, 100) / 100;
  const [best, worst] = { h264: [18, 36], h265: [20, 38], vp9: [24, 50], av1: [24, 52] }[codec];
  return Math.round(worst - (worst - best) * q);
}

/** 實際要處理的秒數（考慮修剪）。 */
export function clipDuration(info: MediaInfo, s: Settings): number {
  const start = clamp(s.trimStart || 0, 0, info.duration);
  const end = s.trimEnd > 0 ? clamp(s.trimEnd, start, info.duration) : info.duration;
  return Math.max(0, end - start);
}

/** 依「指定大小」或「原檔百分比」算出整體目標位元率（kb/s），其他模式回傳 0。 */
export function targetTotalKbps(info: MediaInfo, s: Settings, inputBytes: number): number {
  const dur = clipDuration(info, s);
  if (dur <= 0) return 0;
  let bytes = 0;
  if (s.mode === 'size') bytes = s.targetMB * 1024 * 1024;
  else if (s.mode === 'percent') bytes = inputBytes * (s.percent / 100) * (dur / Math.max(dur, info.duration || dur));
  else return 0;
  // 留 4% 給容器負擔，避免超過目標
  return (bytes * 8 * 0.96) / dur / 1000;
}

/** 音訊位元率：目標太小時自動降低，留空間給畫面。 */
export function audioKbpsFor(s: Settings, totalKbps: number): number {
  if (s.audio === 'mute') return 0;
  if (!totalKbps) return s.audioKbps;
  return clamp(Math.min(s.audioKbps, Math.round(totalKbps * 0.12)), 32, s.audioKbps);
}

const RES_LIST = [2160, 1440, 1080, 720, 480, 360, 240];

/** 輸出尺寸（偶數、不放大）。以短邊為準，直式影片也適用。 */
export function outputSize(info: MediaInfo, s: Settings, videoKbps = 0): { width: number; height: number } {
  const { width: w, height: h } = info;
  if (!w || !h) return { width: w, height: h };
  const short = Math.min(w, h);
  let target = short;
  if (s.res === 'auto') {
    // 位元率不夠時自動降解析度（每像素至少要有這麼多 bit，畫面才不會糊成馬賽克）
    if (videoKbps > 0) {
      const fps = s.fps || info.fps || 30;
      const minBpp = s.codec === 'h264' ? 0.045 : 0.03;
      for (const r of [short, ...RES_LIST.filter((x) => x < short)]) {
        target = r;
        const k = r / short;
        if ((videoKbps * 1000) / (w * k * h * k * fps) >= minBpp) break;
      }
    }
  } else if (s.res !== 'orig') target = Math.min(short, +s.res);
  const k = target / short;
  return { width: even(w * k), height: even(h * k) };
}

export interface Plan {
  /** 每一趟 FFmpeg 的參數（不含 ffmpeg 本身）；兩趟壓縮會有兩組 */
  passes: string[][];
  /** 實際要處理的秒數（算進度用） */
  duration: number;
  /** 輸出副檔名 */
  ext: string;
  /** 給使用者看的說明 */
  summary: string;
  /** 注意事項 */
  warnings: string[];
  /** 預估輸出大小（bytes）；品質優先無法預估時為 0 */
  estimate: number;
}

/** 輸出副檔名。 */
export function outputExt(kind: Kind, inputName: string, s: Settings): string {
  if (kind === 'video') return s.container;
  if (kind === 'audio') return s.audioFormat;
  if (s.imageFormat !== 'same') return s.imageFormat;
  const e = extOf(inputName);
  if (e === 'jpeg' || e === 'jpg') return 'jpg';
  if (e === 'png' || e === 'webp') return e;
  return 'jpg'; // bmp、tif 改成 jpg 才有壓縮效果
}

/** 輸出檔名：原檔名＋後綴＋新副檔名。 */
export function outputName(inputName: string, kind: Kind, s: Settings): string {
  const base = inputName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  return `${base}${s.suffix || ''}.${outputExt(kind, inputName, s)}`;
}

const HW_ENC: Record<Exclude<Hw, 'off'>, Partial<Record<VideoCodec, string>>> = {
  nvenc: { h264: 'h264_nvenc', h265: 'hevc_nvenc', av1: 'av1_nvenc' },
  qsv: { h264: 'h264_qsv', h265: 'hevc_qsv', av1: 'av1_qsv', vp9: 'vp9_qsv' },
  amf: { h264: 'h264_amf', h265: 'hevc_amf', av1: 'av1_amf' },
  videotoolbox: { h264: 'h264_videotoolbox', h265: 'hevc_videotoolbox' },
};

/** 選定的編碼器名稱。 */
export function encoderFor(s: Settings): { name: string; hw: boolean } {
  const codec = s.container === 'webm' && (s.codec === 'h264' || s.codec === 'h265') ? 'vp9' : s.codec;
  if (s.hw !== 'off') {
    const n = HW_ENC[s.hw][codec];
    if (n) return { name: n, hw: true };
  }
  return { name: { h264: 'libx264', h265: 'libx265', vp9: 'libvpx-vp9', av1: 'libaom-av1' }[codec], hw: false };
}

const fmtTime = (t: number) => t.toFixed(3);

/** VideoToolbox 品質模式：每像素位元數隨品質 0.02～0.14（H.265 打七折），不超過原檔畫面位元率的九成。 */
export function vtQualityKbps(info: MediaInfo, s: Settings, codec: VideoCodec, size: { width: number; height: number }): number {
  const fps = s.fps || info.fps || 30;
  const bpp = (0.02 + (clamp(s.quality, 0, 100) / 100) * 0.12) * (codec === 'h265' ? 0.7 : 1);
  let kbps = (size.width * size.height * fps * bpp) / 1000;
  const srcVideo = info.bitrate ? info.bitrate - (info.abitrate || 0) : 0;
  if (srcVideo > 0) kbps = Math.min(kbps, srcVideo * 0.9);
  return Math.max(150, Math.round(kbps));
}

/**
 * 產生 FFmpeg 參數。
 * @param input  輸入檔路徑（桌面版）或虛擬檔名（線上版）
 * @param output 輸出檔路徑
 * @param inputBytes 原檔大小（算百分比模式）
 * @param passlog 兩趟壓縮的紀錄檔名（相對路徑，FFmpeg 會在工作目錄建立）
 */
export function buildPlan(kind: Kind, info: MediaInfo, s: Settings, input: string, output: string, inputBytes: number, passlog = 'xk-pass'): Plan {
  if (kind === 'image') return imagePlan(info, s, input, output);
  if (kind === 'audio' || !info.hasVideo) return audioPlan(info, s, input, output, inputBytes, kind === 'video');
  return videoPlan(info, s, input, output, inputBytes, passlog);
}

function trimArgs(info: MediaInfo, s: Settings): { pre: string[]; post: string[] } {
  const pre: string[] = [];
  const post: string[] = [];
  const dur = clipDuration(info, s);
  if (s.trimStart > 0) pre.push('-ss', fmtTime(s.trimStart));
  if (s.trimEnd > 0 || s.trimStart > 0) {
    if (dur > 0 && dur < info.duration - 0.01) post.push('-t', fmtTime(dur));
  }
  return { pre, post };
}

function videoPlan(info: MediaInfo, s: Settings, input: string, output: string, inputBytes: number, passlog: string): Plan {
  const warnings: string[] = [];
  const dur = clipDuration(info, s);
  const container = s.container;
  const enc = encoderFor(s);
  const codec: VideoCodec = enc.name.includes('vp9') ? 'vp9' : enc.name.includes('av1') ? 'av1' : enc.name.includes('265') || enc.name.includes('hevc') ? 'h265' : 'h264';
  if (container === 'webm' && (s.codec === 'h264' || s.codec === 'h265')) warnings.push('WebM 不支援 H.264／H.265，已改用 VP9。');

  let total = targetTotalKbps(info, s, inputBytes);
  // 目標比原檔還大：照位元率壓反而會變大，改用品質優先
  if (total && info.bitrate && total >= info.bitrate * 0.9) {
    warnings.push('原檔已經比目標小，改用「品質優先（均衡）」壓縮。');
    total = 0;
    s = { ...s, quality: Math.min(s.quality, 60) };
  }
  const aKbps = info.hasAudio ? audioKbpsFor(s, total) : 0;
  let vKbps = total ? Math.floor(total - aKbps) : 0;
  if (total && vKbps < 60) {
    warnings.push(`目標太小：影片長 ${Math.round(dur)} 秒，最少要給畫面 60 kb/s，結果會比目標大一些。`);
    vKbps = 60;
  }
  const size = outputSize(info, s, vKbps);
  if (s.res === 'auto' && total && Math.min(size.width, size.height) < Math.min(info.width, info.height))
    warnings.push(`為了達到目標大小，自動把解析度降到 ${size.width}×${size.height}。`);

  const filters: string[] = [];
  if (size.width && (size.width !== info.width || size.height !== info.height)) filters.push(`scale=${size.width}:${size.height}:flags=lanczos`);
  if (s.fps > 0 && (!info.fps || s.fps < info.fps - 0.5)) filters.push(`fps=${s.fps}`);
  if (!enc.hw || s.hw === 'videotoolbox') filters.push('format=yuv420p');

  const { pre, post } = trimArgs(info, s);
  const head = ['-hide_banner', '-y', ...pre, '-i', input, ...post];
  const map = ['-map', '0:v:0'];
  if (info.hasAudio && s.audio !== 'mute') map.push('-map', '0:a:0?');
  const vf = filters.length ? ['-vf', filters.join(',')] : [];

  const presetX = ['veryfast', 'medium', 'slow'][s.speed];
  const v: string[] = ['-c:v', enc.name];
  const twoPass = !!vKbps && !enc.hw;
  if (enc.hw) {
    const q = crfFor(codec, s.quality);
    if (vKbps) v.push('-b:v', `${vKbps}k`, '-maxrate', `${Math.round(vKbps * 1.3)}k`, '-bufsize', `${vKbps * 2}k`);
    if (s.hw === 'nvenc') {
      v.push('-preset', ['p2', 'p5', 'p7'][s.speed]);
      if (!vKbps) v.push('-rc', 'vbr', '-cq', String(q + 1), '-b:v', '0');
    } else if (s.hw === 'qsv') {
      v.push('-preset', ['veryfast', 'medium', 'veryslow'][s.speed]);
      if (!vKbps) v.push('-global_quality', String(q + 2));
    } else if (s.hw === 'amf') {
      v.push('-quality', ['speed', 'balanced', 'quality'][s.speed]);
      if (!vKbps) v.push('-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q + 2));
    } else if (s.hw === 'videotoolbox') {
      // Intel Mac 的 VideoToolbox 不支援固定品質（-q:v），一律依畫質換算成位元率
      if (!vKbps) {
        const kbps = vtQualityKbps(info, s, codec, size);
        v.push('-b:v', `${kbps}k`, '-maxrate', `${Math.round(kbps * 1.5)}k`, '-bufsize', `${kbps * 2}k`);
      }
      v.push('-allow_sw', '1');
    }
  } else if (codec === 'h264') {
    v.push('-preset', presetX);
    if (vKbps) v.push('-b:v', `${vKbps}k`);
    else v.push('-crf', String(crfFor(codec, s.quality)));
  } else if (codec === 'h265') {
    v.push('-preset', presetX);
    if (vKbps) v.push('-b:v', `${vKbps}k`);
    else v.push('-crf', String(crfFor(codec, s.quality)));
  } else if (codec === 'vp9') {
    v.push('-row-mt', '1', '-deadline', 'good', '-cpu-used', String([4, 2, 1][s.speed]));
    if (vKbps) v.push('-b:v', `${vKbps}k`);
    else v.push('-crf', String(crfFor(codec, s.quality)), '-b:v', '0');
  } else {
    v.push('-cpu-used', String([8, 6, 4][s.speed]), '-row-mt', '1', '-tiles', '2x2');
    if (vKbps) v.push('-b:v', `${vKbps}k`);
    else v.push('-crf', String(crfFor(codec, s.quality)), '-b:v', '0');
  }
  if (codec === 'h265' && (container === 'mp4' || container === 'mov')) v.push('-tag:v', 'hvc1');

  const a: string[] = [];
  if (info.hasAudio && s.audio !== 'mute') {
    const ac = container === 'webm' ? 'libopus' : 'aac';
    a.push('-c:a', ac, '-b:a', `${aKbps}k`);
    if (ac === 'aac') a.push('-ac', '2');
  } else a.push('-an');

  const tail: string[] = [];
  if (s.stripMeta) tail.push('-map_metadata', '-1', '-map_chapters', '-1');
  if (container === 'mp4' || container === 'mov') tail.push('-movflags', '+faststart');
  tail.push('-sn', '-dn');

  const prog = ['-progress', 'pipe:1', '-nostats', '-loglevel', 'error'];
  let passes: string[][];
  if (twoPass) {
    const p = (n: 1 | 2) => (codec === 'h265' ? ['-x265-params', `pass=${n}:stats=${passlog}.log:log-level=error`] : ['-pass', String(n), '-passlogfile', passlog]);
    passes = [
      [...head, '-map', '0:v:0', ...vf, ...v, ...p(1), '-an', '-f', 'null', ...prog, '-'],
      [...head, ...map, ...vf, ...v, ...p(2), ...a, ...tail, ...prog, output],
    ];
  } else passes = [[...head, ...map, ...vf, ...v, ...a, ...tail, ...prog, output]];

  const codecLabel = { h264: 'H.264', h265: 'H.265', vp9: 'VP9', av1: 'AV1' }[codec] + (enc.hw ? '（硬體加速）' : '');
  const how = vKbps ? `目標 ${(total / 1000).toFixed(2)} Mb/s${twoPass ? '，兩趟精準壓縮' : ''}` : `品質 ${s.quality}`;
  return {
    passes,
    duration: dur,
    ext: container,
    summary: `${codecLabel}・${size.width}×${size.height}・${how}`,
    warnings,
    estimate: vKbps ? ((vKbps + aKbps) * 1000 * dur) / 8 : 0,
  };
}

function audioPlan(info: MediaInfo, s: Settings, input: string, output: string, inputBytes: number, fromVideo: boolean): Plan {
  const warnings: string[] = [];
  // 影片檔卻沒有畫面（純音軌）：照影片的容器輸出
  const fmt = fromVideo ? (s.container === 'webm' ? 'opus' : 'm4a') : s.audioFormat;
  const total = targetTotalKbps(info, s, inputBytes);
  // 指定大小時以「位元率」設定為上限，目標很寬鬆也不會反而變大
  let kbps = total ? Math.min(Math.floor(total), s.audioFileKbps) : s.audioFileKbps;
  if (total && kbps < 24) {
    warnings.push('目標太小，聲音最少需要 24 kb/s。');
    kbps = 24;
  }
  kbps = Math.min(kbps, 320);
  const { pre, post } = trimArgs(info, s);
  const c = fmt === 'mp3' ? ['-c:a', 'libmp3lame'] : fmt === 'opus' ? ['-c:a', 'libopus'] : ['-c:a', 'aac'];
  const args = ['-hide_banner', '-y', ...pre, '-i', input, ...post, '-vn', '-map', '0:a:0', ...c, '-b:a', `${kbps}k`];
  if (s.audioMono) args.push('-ac', '1');
  else if (fmt !== 'opus') args.push('-ac', '2');
  if (s.stripMeta) args.push('-map_metadata', '-1');
  if (fmt === 'm4a') args.push('-movflags', '+faststart');
  if (fmt === 'opus') args.push('-f', 'opus');
  args.push('-progress', 'pipe:1', '-nostats', '-loglevel', 'error', output);
  return {
    passes: [args],
    duration: clipDuration(info, s),
    ext: fmt,
    summary: `${fmt.toUpperCase()}・${kbps} kb/s${s.audioMono ? '・單聲道' : ''}`,
    warnings,
    estimate: (kbps * 1000 * clipDuration(info, s)) / 8,
  };
}

function imagePlan(info: MediaInfo, s: Settings, input: string, output: string): Plan {
  const fmt = (/\.(\w+)$/.exec(output)?.[1] ?? 'jpg').toLowerCase();
  const filters: string[] = [];
  let w = info.width;
  let h = info.height;
  if (s.imageMax > 0 && w && h && Math.max(w, h) > s.imageMax) {
    const k = s.imageMax / Math.max(w, h);
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    filters.push(`scale=${w}:${h}:flags=lanczos`);
  }
  const q = clamp(s.imageQuality, 1, 100);
  const args = ['-hide_banner', '-y', '-i', input];
  let summary = '';
  if (fmt === 'jpg') {
    // mjpeg 的 q:v 2（最好）～31（最差）
    const qv = Math.round(2 + ((100 - q) / 100) * 22);
    filters.push('format=yuvj420p');
    args.push('-vf', filters.join(','), '-c:v', 'mjpeg', '-q:v', String(qv), '-frames:v', '1');
    summary = `JPG・品質 ${q}`;
  } else if (fmt === 'webp') {
    if (filters.length) args.push('-vf', filters.join(','));
    args.push('-c:v', 'libwebp', '-quality', String(q), '-compression_level', '6', '-frames:v', '1');
    summary = `WebP・品質 ${q}`;
  } else {
    // PNG：品質 < 100 時減成 256 色調色盤（類似 pngquant），通常能小 60% 以上
    if (q < 100) {
      const colors = clamp(Math.round(16 + (q / 100) * 240), 16, 256);
      const f = filters.length ? `${filters.join(',')},` : '';
      args.push('-filter_complex', `[0:v]${f}split[a][b];[a]palettegen=max_colors=${colors}:reserve_transparent=1[p];[b][p]paletteuse=dither=sierra2_4a:alpha_threshold=128`);
      summary = `PNG・${colors} 色`;
    } else {
      if (filters.length) args.push('-vf', filters.join(','));
      summary = 'PNG・無損';
    }
    args.push('-c:v', 'png', '-compression_level', '9', '-pred', 'mixed', '-frames:v', '1');
  }
  if (s.stripMeta) args.push('-map_metadata', '-1');
  args.push('-update', '1', '-loglevel', 'error', output);
  return { passes: [args], duration: 0, ext: fmt, summary: `${summary}・${w}×${h}`, warnings: [], estimate: 0 };
}

// --- 瀏覽器（WebCodecs）用的壓縮計畫 ----------------------------------------------------

export interface WebVideoPlan {
  width: number;
  height: number;
  /** 0＝維持原影格率 */
  fps: number;
  /** 畫面位元率 kb/s */
  videoKbps: number;
  /** 聲音位元率 kb/s；0＝不要聲音 */
  audioKbps: number;
  /** 依序嘗試的影像編碼（mediabunny 的名稱） */
  videoCodecs: ('avc' | 'hevc' | 'vp9' | 'av1')[];
  audioCodecs: ('aac' | 'opus')[];
  container: Container;
  /** 指定大小／比例模式的目標總位元數（bytes），0＝品質優先 */
  targetBytes: number;
  duration: number;
  summary: string;
  warnings: string[];
  estimate: number;
}

const WEB_CODEC: Record<VideoCodec, 'avc' | 'hevc' | 'vp9' | 'av1'> = { h264: 'avc', h265: 'hevc', vp9: 'vp9', av1: 'av1' };

/** 瀏覽器的硬體編碼沒有 CRF，品質模式也換算成位元率（與 Mac VideoToolbox 相同的規則）。 */
export function webVideoPlan(info: MediaInfo, s: Settings, inputBytes: number): WebVideoPlan {
  const warnings: string[] = [];
  const dur = clipDuration(info, s);
  const container = s.container;
  let codec: VideoCodec = s.codec;
  if (container === 'webm' && (codec === 'h264' || codec === 'h265')) {
    codec = 'vp9';
    warnings.push('WebM 不支援 H.264／H.265，已改用 VP9。');
  }
  let total = targetTotalKbps(info, s, inputBytes);
  if (total && info.bitrate && total >= info.bitrate * 0.9) {
    warnings.push('原檔已經比目標小，改用「品質優先（均衡）」壓縮。');
    total = 0;
    s = { ...s, quality: Math.min(s.quality, 60) };
  }
  const aKbps = info.hasAudio && s.audio !== 'mute' ? audioKbpsFor(s, total) : 0;
  let vKbps = total ? Math.floor(total - aKbps) : 0;
  if (total && vKbps < 60) {
    warnings.push(`目標太小：影片長 ${Math.round(dur)} 秒，最少要給畫面 60 kb/s，結果會比目標大一些。`);
    vKbps = 60;
  }
  const size = outputSize(info, s, vKbps);
  if (s.res === 'auto' && total && Math.min(size.width, size.height) < Math.min(info.width, info.height))
    warnings.push(`為了達到目標大小，自動把解析度降到 ${size.width}×${size.height}。`);
  if (!vKbps) vKbps = vtQualityKbps(info, s, codec, size);
  // 指定的編碼不支援時依序退回：H.265 → H.264；AV1 → VP9 → H.264（WebM 只能 VP9／AV1）
  const order: VideoCodec[] = container === 'webm' ? [codec, codec === 'av1' ? 'vp9' : 'av1'] : [codec, ...(['h265', 'h264'] as VideoCodec[]).filter((c) => c !== codec)];
  if (container !== 'webm' && (codec === 'av1' || codec === 'vp9')) order.splice(1, 0, codec === 'av1' ? 'vp9' : 'av1');
  const fps = s.fps > 0 && (!info.fps || s.fps < info.fps - 0.5) ? s.fps : 0;
  const label = { h264: 'H.264', h265: 'H.265', vp9: 'VP9', av1: 'AV1' }[codec];
  return {
    width: size.width,
    height: size.height,
    fps,
    videoKbps: vKbps,
    audioKbps: aKbps,
    videoCodecs: [...new Set(order)].map((c) => WEB_CODEC[c]),
    audioCodecs: container === 'webm' ? ['opus'] : ['aac', 'opus'],
    container,
    targetBytes: total ? (total * 1000 * dur) / 8 / 0.96 : 0,
    duration: dur,
    summary: `${label}（瀏覽器硬體編碼）・${size.width}×${size.height}・${total ? `目標 ${(total / 1000).toFixed(2)} Mb/s` : `品質 ${s.quality}`}`,
    warnings,
    estimate: ((vKbps + aKbps) * 1000 * dur) / 8,
  };
}

export interface WebAudioPlan {
  format: 'mp3' | 'm4a' | 'opus';
  kbps: number;
  channels: number;
  duration: number;
  summary: string;
  warnings: string[];
  estimate: number;
}

export function webAudioPlan(info: MediaInfo, s: Settings, inputBytes: number): WebAudioPlan {
  const warnings: string[] = [];
  const total = targetTotalKbps(info, s, inputBytes);
  let kbps = total ? Math.min(Math.floor(total), s.audioFileKbps) : s.audioFileKbps;
  if (total && kbps < 24) {
    warnings.push('目標太小，聲音最少需要 24 kb/s。');
    kbps = 24;
  }
  kbps = Math.min(kbps, 320);
  const dur = clipDuration(info, s);
  return {
    format: s.audioFormat,
    kbps,
    channels: s.audioMono ? 1 : 2,
    duration: dur,
    summary: `${s.audioFormat.toUpperCase()}・${kbps} kb/s${s.audioMono ? '・單聲道' : ''}`,
    warnings,
    estimate: (kbps * 1000 * dur) / 8,
  };
}

/** PNG 減色的顏色數；品質 100 回傳 0（無損）。與桌面版 FFmpeg 的規則相同。 */
export function pngColors(quality: number): number {
  const q = clamp(quality, 1, 100);
  return q >= 100 ? 0 : clamp(Math.round(16 + (q / 100) * 240), 16, 256);
}

// --- 顯示 --------------------------------------------------------------------------

export function fmtBytes(n: number): string {
  if (!(n > 0)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${u[i]}`;
}

export function fmtDuration(sec: number): string {
  if (!(sec > 0)) return '0:00';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** 解析 -progress 輸出的一行，回傳已處理的秒數（沒有就回傳 null）。 */
export function progressSeconds(line: string): number | null {
  const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
  if (m) return +m[1] / 1e6;
  const t = /^out_time=(\d+):(\d+):([\d.]+)/.exec(line.trim());
  if (t) return +t[1] * 3600 + +t[2] * 60 + +t[3];
  return null;
}
