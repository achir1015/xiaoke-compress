'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => {
  const h = (e, d) => fn(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.off(ch, h);
};

contextBridge.exposeInMainWorld('xk', {
  info: inv('app:info'),
  pickFiles: inv('dlg:files'),
  pickFolder: inv('dlg:folder'),
  /** 拖曳進來的檔案取得完整路徑 */
  pathOf: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  media: {
    probe: inv('media:probe'),
    thumb: inv('media:thumb'),
    outPath: inv('media:outPath'),
    expand: inv('media:expand'),
    sample: inv('media:sample'),
    exists: inv('media:exists'),
    size: inv('media:size'),
  },
  job: { run: inv('job:run'), cancel: inv('job:cancel'), onProgress: on('job:progress') },
  hw: inv('hw:detect'),
  shell: { reveal: inv('shell:reveal'), open: inv('shell:open'), trash: inv('shell:trash') },
  update: {
    check: inv('update:check'),
    download: inv('update:download'),
    install: inv('update:install'),
    openPage: inv('update:openPage'),
    onProgress: on('update:progress'),
  },
  platform: process.platform,
});
