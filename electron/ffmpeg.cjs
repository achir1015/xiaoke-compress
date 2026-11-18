'use strict';
// 執行內建的 FFmpeg：讀取媒體資訊、縮圖、壓縮（含進度與取消）、偵測硬體編碼器、產生範例影片
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

function ffmpegPath() {
  const cands = [];
  if (app.isPackaged) cands.push(path.join(process.resourcesPath, 'bin', EXE));
  cands.push(path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', EXE));
  for (const c of cands) if (fs.existsSync(c)) return c;
  return EXE; // 最後才用系統 PATH 裡的
}

// Windows 不要跳出黑色主控台視窗
const OPTS = { windowsHide: true };

/** 執行一次 FFmpeg，收集 stdout（Buffer）與 stderr（文字）。 */
function run(args, { cwd, timeout = 0, maxOut = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { ...OPTS, cwd });
    const out = [];
    let outLen = 0;
    let err = '';
    let timer = null;
    if (timeout) timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => {
      if (outLen < maxOut) {
        out.push(d);
        outLen += d.length;
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 200000) err = err.slice(-100000);
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

async function probe(file) {
  const r = await run(['-hide_banner', '-i', file], { timeout: 30000 });
  if (!/Stream #/.test(r.stderr)) {
    const msg = (/: (.*)$/m.exec(r.stderr.trim().split(/\r?\n/).pop() || '') || [])[1] || r.stderr.trim().split(/\r?\n/).pop();
    throw new Error(`無法讀取這個檔案：${msg || '格式不支援'}`);
  }
  return r.stderr;
}

/** 縮圖（JPEG data URL）。影片取 1/3 處（最多第 2 秒），圖片直接縮。 */
async function thumbnail(file, duration) {
  const at = duration > 0 ? Math.min(2, duration / 3) : 0;
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (at > 0) args.push('-ss', at.toFixed(2));
  args.push('-i', file, '-frames:v', '1', '-vf', 'scale=320:320:force_original_aspect_ratio=decrease,format=yuvj420p', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', '-');
  const r = await run(args, { timeout: 30000 });
  if (!r.stdout.length) return null;
  return `data:image/jpeg;base64,${r.stdout.toString('base64')}`;
}

const jobs = new Map();

/**
 * 依序執行每一趟壓縮，回報進度（0～1）。
 * passes 由網頁依設定產生；這裡只檢查輸出位置合理、不會蓋掉原檔。
 */
async function compress(id, { input, output, passes, duration }, onProgress) {
  if (!Array.isArray(passes) || !passes.length) throw new Error('沒有壓縮參數');
  if (path.resolve(input).toLowerCase() === path.resolve(output).toLowerCase()) throw new Error('輸出檔不能和原檔相同');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xkc-'));
  const tmpOut = output + '.part' + path.extname(output);
  const job = { child: null, cancelled: false };
  jobs.set(id, job);
  const started = Date.now();
  try {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    for (let i = 0; i < passes.length; i++) {
      if (job.cancelled) throw new Error('已取消');
      const args = passes[i].map((a) => (a === output ? tmpOut : a));
      // -update 1 的圖片輸出需要正確副檔名判斷格式；part 檔名保留原副檔名
      const code = await new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath(), args, { ...OPTS, cwd: work });
        job.child = child;
        let err = '';
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d.toString();
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
            if (m && duration > 0) {
              const p = Math.min(1, +m[1] / 1e6 / duration);
              onProgress((i + p) / passes.length, Date.now() - started);
            }
          }
        });
        child.stderr.on('data', (d) => {
          err += d.toString();
          if (err.length > 50000) err = err.slice(-20000);
        });
        child.on('error', reject);
        child.on('close', (c) => {
          job.child = null;
          if (c === 0) resolve(0);
          else if (job.cancelled) reject(new Error('已取消'));
          else reject(new Error(friendlyError(err) || `FFmpeg 結束代碼 ${c}`));
        });
      });
      void code;
    }
    if (!fs.existsSync(tmpOut)) throw new Error('沒有產生輸出檔');
    fs.renameSync(tmpOut, output);
    const size = fs.statSync(output).size;
    onProgress(1, Date.now() - started);
    return { output, size, ms: Date.now() - started };
  } catch (e) {
    try { fs.unlinkSync(tmpOut); } catch { /* 沒有就算了 */ }
    throw e;
  } finally {
    jobs.delete(id);
    fs.rm(work, { recursive: true, force: true }, () => {});
  }
}

function friendlyError(err) {
  const lines = err.trim().split(/\r?\n/).filter((l) => l && !/^\s*(frame=|size=)/.test(l));
  const last = lines.slice(-3).join('\n');
  if (/No space left/i.test(err)) return '磁碟空間不足';
  if (/Permission denied/i.test(err)) return '沒有權限寫入輸出資料夾';
  if (/Cannot load nvcuda|No NVENC capable devices|OpenEncodeSessionEx failed/i.test(err)) return '這台電腦不支援 NVIDIA 硬體加速，請改用「關閉」或其他選項';
  if (/Error creating a MFX session|unsupported|not supported/i.test(err) && /qsv/i.test(err)) return '這台電腦不支援 Intel 硬體加速';
  if (/amf/i.test(err) && /fail|error/i.test(err)) return '這台電腦不支援 AMD 硬體加速';
  return last;
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  if (job.child) job.child.kill('SIGKILL');
  return true;
}

function cancelAll() {
  for (const id of jobs.keys()) cancel(id);
}

/** 用 0.5 秒的測試畫面試編碼，找出這台電腦真的能用的硬體加速。 */
let hwCache = null;
async function detectHw() {
  if (hwCache) return hwCache;
  const tests = process.platform === 'darwin'
    ? [['videotoolbox', 'h264_videotoolbox'], ['videotoolbox-hevc', 'hevc_videotoolbox']]
    : [['nvenc', 'h264_nvenc'], ['nvenc-hevc', 'hevc_nvenc'], ['qsv', 'h264_qsv'], ['qsv-hevc', 'hevc_qsv'], ['amf', 'h264_amf'], ['amf-hevc', 'hevc_amf']];
  const result = {};
  await Promise.all(tests.map(async ([key, enc]) => {
    try {
      const r = await run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=0.5', '-c:v', enc, '-f', 'null', '-'], { timeout: 15000 });
      result[key] = r.code === 0;
    } catch {
      result[key] = false;
    }
  }));
  hwCache = {
    nvenc: !!result.nvenc,
    qsv: !!result.qsv,
    amf: !!result.amf,
    videotoolbox: !!result.videotoolbox,
    hevc: { nvenc: !!result['nvenc-hevc'], qsv: !!result['qsv-hevc'], amf: !!result['amf-hevc'], videotoolbox: !!result['videotoolbox-hevc'] },
  };
  return hwCache;
}

/** 產生「試用範例影片」：12 秒 1080p 彩色測試畫面＋音樂般的和弦。 */
async function sample() {
  const dir = path.join(app.getPath('userData'), 'sample');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '小柯範例影片.mp4');
  if (fs.existsSync(file) && fs.statSync(file).size > 1000000) return file;
  const r = await run([
    '-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=12',
    '-f', 'lavfi', '-i', 'sine=f=262:d=12',
    '-f', 'lavfi', '-i', 'sine=f=330:d=12',
    '-f', 'lavfi', '-i', 'sine=f=392:d=12',
    '-filter_complex', '[1][2][3]amix=inputs=3,volume=0.6[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', file,
  ], { timeout: 120000 });
  if (r.code !== 0) throw new Error('產生範例影片失敗：' + r.stderr.slice(-300));
  return file;
}

async function version() {
  const r = await run(['-hide_banner', '-version'], { timeout: 10000 });
  return (/ffmpeg version (\S+)/.exec(r.stdout.toString()) || [])[1] || '';
}

module.exports = { ffmpegPath, probe, thumbnail, compress, cancel, cancelAll, detectHw, sample, version };
