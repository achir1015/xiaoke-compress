// 壓縮核心測試：解析、計算，以及用內建 FFmpeg 真的壓縮（檢查大小與格式）
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS, buildPlan, crfFor, kindOf, outputName, outputSize, parseProbe, progressSeconds, targetTotalKbps, type Settings } from '../src/engine';

const FF = join(process.cwd(), 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const S = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULTS, ...o });

const PROBE_PHONE = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_0001.MOV':
  Duration: 00:01:02.50, start: 0.000000, bitrate: 15873 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 15600 kb/s, 29.97 fps, 29.97 tbr, 600 tbn (default)
      Side data:
        displaymatrix: rotation of -90.00 degrees
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 174 kb/s (default)`;

describe('解析與計算', () => {
  it('讀懂手機直拍影片（旋轉 90 度）', () => {
    const i = parseProbe(PROBE_PHONE);
    expect(i.duration).toBeCloseTo(62.5, 2);
    expect(i.bitrate).toBe(15873);
    expect([i.width, i.height]).toEqual([1080, 1920]);
    expect(i.fps).toBeCloseTo(29.97, 2);
    expect(i.vcodec).toBe('hevc');
    expect(i.hasAudio && i.hasVideo).toBe(true);
    expect(i.abitrate).toBe(174);
  });

  it('MP3 的封面圖不算影片', () => {
    const i = parseProbe(`Input #0, mp3, from 'a.mp3':
  Duration: 00:03:00.00, start: 0.025057, bitrate: 320 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)`);
    expect(i.hasVideo).toBe(false);
    expect(i.hasAudio).toBe(true);
  });

  it('副檔名分類與輸出檔名', () => {
    expect(kindOf('a.MP4')).toBe('video');
    expect(kindOf('b.jpeg')).toBe('image');
    expect(kindOf('c.flac')).toBe('audio');
    expect(kindOf('d.txt')).toBeNull();
    expect(outputName('C:\\影片\\旅行.MOV', 'video', S())).toBe('旅行_壓縮.mp4');
    expect(outputName('x.bmp', 'image', S())).toBe('x_壓縮.jpg');
    expect(outputName('x.png', 'image', S({ imageFormat: 'webp' }))).toBe('x_壓縮.webp');
  });

  it('品質越高 CRF 越小', () => {
    expect(crfFor('h264', 100)).toBe(18);
    expect(crfFor('h264', 0)).toBe(36);
    expect(crfFor('h264', 80)).toBeLessThan(crfFor('h264', 40));
  });

  it('指定大小算出位元率、修剪後依比例', () => {
    const info = parseProbe(PROBE_PHONE);
    const k = targetTotalKbps(info, S({ mode: 'size', targetMB: 25 }), 0);
    expect(k).toBeCloseTo((25 * 1024 * 1024 * 8 * 0.96) / 62.5 / 1000, 3);
    const half = targetTotalKbps(info, S({ mode: 'percent', percent: 50, trimEnd: 31.25 }), 100e6);
    // 原檔一半時間、50% → 約 25MB 給 31.25 秒
    expect(half).toBeCloseTo((100e6 * 0.5 * 0.5 * 8 * 0.96) / 31.25 / 1000, 1);
  });

  it('解析度：不放大、偶數、位元率太低自動降', () => {
    const info = parseProbe(PROBE_PHONE);
    expect(outputSize(info, S({ res: '720' }))).toEqual({ width: 720, height: 1280 });
    expect(outputSize(info, S({ res: '2160' }))).toEqual({ width: 1080, height: 1920 });
    const low = outputSize(info, S({ res: 'auto' }), 400);
    expect(Math.min(low.width, low.height)).toBeLessThan(1080);
    expect(low.width % 2 + (low.height % 2)).toBe(0);
  });

  it('兩趟壓縮與 H.265 標籤', () => {
    const info = parseProbe(PROBE_PHONE);
    const p = buildPlan('video', info, S({ mode: 'size', targetMB: 20, codec: 'h265' }), 'in.mov', 'out.mp4', 0);
    expect(p.passes).toHaveLength(2);
    expect(p.passes[0].join(' ')).toContain('pass=1');
    expect(p.passes[1]).toContain('hvc1');
    expect(p.passes[1].at(-1)).toBe('out.mp4');
    const q = buildPlan('video', info, S({ hw: 'nvenc' }), 'in.mov', 'out.mp4', 0);
    expect(q.passes).toHaveLength(1);
    expect(q.passes[0]).toContain('h264_nvenc');
  });

  it('Mac VideoToolbox 品質模式換算成位元率', () => {
    const info = parseProbe(PROBE_PHONE);
    const p = buildPlan('video', info, S({ hw: 'videotoolbox', quality: 60 }), 'in.mov', 'out.mp4', 0);
    const args = p.passes[0];
    expect(args).toContain('h264_videotoolbox');
    expect(args).not.toContain('-q:v');
    const kbps = parseInt(args[args.indexOf('-b:v') + 1], 10);
    expect(kbps).toBeGreaterThan(2000);
    expect(kbps).toBeLessThan((15873 - 174) * 0.9 + 1);
  });

  it('WebM 自動改 VP9＋Opus', () => {
    const info = parseProbe(PROBE_PHONE);
    const p = buildPlan('video', info, S({ container: 'webm' }), 'in.mov', 'out.webm', 0);
    expect(p.passes[0]).toContain('libvpx-vp9');
    expect(p.passes[0]).toContain('libopus');
  });

  it('解析進度', () => {
    expect(progressSeconds('out_time_us=1500000')).toBe(1.5);
    expect(progressSeconds('out_time=00:01:02.500000')).toBeCloseTo(62.5);
    expect(progressSeconds('progress=continue')).toBeNull();
  });
});

// --- 真的跑 FFmpeg ------------------------------------------------------------------

const ff = (args: string[], cwd?: string) => spawnSync(FF, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const hasFF = existsSync(FF);
let dir = '';
const src = () => join(dir, 'src.mp4');

async function compress(kind: 'video' | 'image' | 'audio', input: string, s: Settings, outName: string) {
  const probe = ff(['-hide_banner', '-i', input]).stderr;
  const info = parseProbe(probe);
  const out = join(dir, outName);
  const plan = buildPlan(kind, info, s, input, out, statSync(input).size);
  for (const args of plan.passes) {
    const r = ff(args, dir);
    if (r.status !== 0) throw new Error(r.stderr.slice(-800));
  }
  return { out, size: statSync(out).size, info: parseProbe(ff(['-hide_banner', '-i', out]).stderr), plan };
}

describe.skipIf(!hasFF)('實際壓縮', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'xkc-test-'));
    // 8 秒 1280×720 的高位元率測試影片
    const r = ff(['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=440:d=8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-shortest', src()]);
    expect(r.status).toBe(0);
    ff(['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1600x1200', '-frames:v', '1', join(dir, 'pic.png')]);
    ff(['-hide_banner', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=20', '-c:a', 'pcm_s16le', join(dir, 'snd.wav')]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('品質優先：變小、解析度不變、有聲音', async () => {
    const r = await compress('video', src(), S({ quality: 60, speed: 0 }), 'q.mp4');
    expect(r.size).toBeLessThan(statSync(src()).size * 0.6);
    expect([r.info.width, r.info.height]).toEqual([1280, 720]);
    expect(r.info.hasAudio).toBe(true);
    expect(r.info.duration).toBeCloseTo(8, 0);
  });

  it('指定大小 1 MB：誤差 15% 以內', async () => {
    const r = await compress('video', src(), S({ mode: 'size', targetMB: 1, speed: 0 }), 's.mp4');
    expect(r.size).toBeLessThan(1024 * 1024 * 1.15);
    expect(r.size).toBeGreaterThan(1024 * 1024 * 0.6);
  });

  it('H.265 兩趟＋修剪＋靜音＋720→480', async () => {
    const r = await compress('video', src(), S({ mode: 'size', targetMB: 0.5, codec: 'h265', speed: 0, audio: 'mute', trimStart: 2, trimEnd: 6, res: '480' }), 'h.mp4');
    expect(r.info.vcodec).toBe('hevc');
    expect(r.info.hasAudio).toBe(false);
    expect(r.info.duration).toBeCloseTo(4, 0);
    expect(r.info.height).toBe(480);
    expect(r.size).toBeLessThan(0.5 * 1024 * 1024 * 1.2);
  });

  it('WebM（VP9）', async () => {
    const r = await compress('video', src(), S({ container: 'webm', speed: 0, quality: 30 }), 'w.webm');
    expect(r.info.vcodec).toBe('vp9');
    expect(r.info.acodec).toBe('opus');
  });

  it('圖片：PNG 減色、JPG、WebP 都變小，最長邊縮到 800', async () => {
    const png = join(dir, 'pic.png');
    const orig = statSync(png).size;
    const a = await compress('image', png, S({ imageQuality: 70 }), 'p.png');
    const b = await compress('image', png, S({ imageFormat: 'jpg', imageQuality: 70 }), 'p.jpg');
    const c = await compress('image', png, S({ imageFormat: 'webp', imageQuality: 70, imageMax: 800 }), 'p.webp');
    expect(a.size).toBeLessThan(orig);
    expect(b.size).toBeLessThan(orig);
    expect(c.size).toBeLessThan(b.size);
    expect(Math.max(c.info.width, c.info.height)).toBe(800);
  });

  it('音訊：WAV → MP3 128k 單聲道', async () => {
    const r = await compress('audio', join(dir, 'snd.wav'), S({ audioFormat: 'mp3', audioFileKbps: 128, audioMono: true }), 'a.mp3');
    expect(r.info.acodec).toBe('mp3');
    // 單聲道 44.1kHz 16bit WAV 約 705 kb/s，128k MP3 約小 5.5 倍
    expect(r.size).toBeLessThan(statSync(join(dir, 'snd.wav')).size / 4);
    expect(r.info.duration).toBeCloseTo(20, 0);
  });
});
