// 後端介面：桌面版（Electron＋原生 FFmpeg）與線上版（瀏覽器 WebCodecs／ffmpeg.wasm）各自實作。
import { buildPlan, kindOf, outputName, parseProbe, type Kind, type MediaInfo, type Settings } from './engine';
import type { DesktopBridge, HwInfo } from './xiaoke';

/** 一個來源檔：桌面版有完整路徑，線上版是 File。 */
export interface SourceRef {
  key: string;
  name: string;
  /** 桌面版：所在資料夾 */
  dir: string;
  size: number;
  path?: string;
  file?: File;
}

export interface Probed {
  info: MediaInfo;
  kind: Kind;
}

export interface JobInput {
  id: string;
  src: SourceRef;
  kind: Kind;
  info: MediaInfo;
  settings: Settings;
  /** 桌面版：輸出資料夾 */
  outDir: string;
}

export interface JobResult {
  /** 桌面版：輸出檔路徑；線上版：blob: 網址 */
  out: string;
  outName: string;
  size: number;
  ms: number;
  warnings?: string[];
  engine?: string;
}

/** 依目前設定預覽的說明（列在清單上）。 */
export interface Preview {
  summary: string;
  warnings: string[];
  estimate: number;
}

export interface Backend {
  web: boolean;
  pick(): Promise<SourceRef[]>;
  fromDrop(dt: DataTransfer): Promise<SourceRef[]>;
  fromPaths(paths: string[]): Promise<SourceRef[]>;
  probe(src: SourceRef): Promise<Probed>;
  thumb(src: SourceRef, info: MediaInfo, kind: Kind): Promise<string | null>;
  sample(): Promise<SourceRef>;
  preview(job: Omit<JobInput, 'id' | 'outDir'>): Preview;
  run(job: JobInput, onProgress: (p: number, ms: number) => void): Promise<JobResult>;
  cancel(id: string): Promise<void>;
  /** 給 <video>／<img> 用的網址 */
  srcUrl(src: SourceRef): string;
  outUrl(out: string): string;
  open(out: string, name: string): Promise<void>;
  reveal(out: string): Promise<void>;
  discard(out: string): Promise<void>;
  hw(): Promise<HwInfo | null>;
  pickFolder(current: string): Promise<string | null>;
}

const stripIpc = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function desktopBackend(xk: DesktopBridge): Backend {
  const mediaUrl = (p: string) => `xkmedia://f/m?p=${encodeURIComponent(p)}`;
  const toRefs = async (paths: string[]) => {
    const files = await xk.media.expand(paths);
    return files.map((p) => ({ key: p, path: p, name: p.replace(/^.*[\\/]/, ''), dir: p.replace(/[\\/][^\\/]*$/, ''), size: 0 }));
  };
  return {
    web: false,
    pick: async () => toRefs(await xk.pickFiles()),
    fromDrop: async (dt) => toRefs([...dt.files].map((f) => xk.pathOf(f)).filter(Boolean)),
    fromPaths: toRefs,
    async probe(src) {
      try {
        const r = await xk.media.probe(src.path!);
        src.size = r.size;
        src.name = r.name;
        src.dir = r.dir;
        const info = parseProbe(r.probe);
        const k = kindOf(r.name) ?? 'video';
        return { info, kind: k === 'video' && !info.hasVideo && info.hasAudio ? 'audio' : k };
      } catch (e) {
        throw new Error(stripIpc(e));
      }
    },
    thumb: (src, info) => xk.media.thumb(src.path!, info.duration),
    async sample() {
      const p = await xk.media.sample();
      return (await toRefs([p]))[0];
    },
    preview(job) {
      const p = buildPlan(job.kind, job.info, job.settings, job.src.path!, outputName(job.src.name, job.kind, job.settings), job.src.size);
      return { summary: p.summary, warnings: p.warnings, estimate: p.estimate };
    },
    async run(job, onProgress) {
      const name = outputName(job.src.name, job.kind, job.settings);
      const out = await xk.media.outPath(job.outDir || job.src.dir, name);
      const plan = buildPlan(job.kind, job.info, job.settings, job.src.path!, out, job.src.size);
      const off = xk.job.onProgress(({ id, p, ms }) => {
        if (id === job.id) onProgress(p, ms);
      });
      try {
        const r = await xk.job.run(job.id, { input: job.src.path!, output: out, passes: plan.passes, duration: plan.duration });
        return { out: r.output, outName: r.output.replace(/^.*[\\/]/, ''), size: r.size, ms: r.ms, warnings: plan.warnings };
      } catch (e) {
        throw new Error(stripIpc(e));
      } finally {
        off();
      }
    },
    cancel: async (id) => void (await xk.job.cancel(id)),
    srcUrl: (src) => mediaUrl(src.path!),
    outUrl: (out) => mediaUrl(out),
    open: async (out) => void (await xk.shell.open(out)),
    reveal: (out) => xk.shell.reveal(out),
    discard: async (out) => void (await xk.shell.trash(out)),
    hw: () => xk.hw(),
    pickFolder: (cur) => xk.pickFolder(cur),
  };
}
