# CLAUDE.md — 小柯機器人MP4影片壓縮工具（xiaoke-compress）

需求文件：`../線上影片壓縮.docx`。開發過程見 `docs/開發紀錄.md`。

## 與使用者合作

- 一律用繁體中文回覆（App 按鈕原名可保留英文）。
- 開發者署名：吳玉柱 先生 與 Claude AI Opus 5.5。
- 推送、建 repo、發佈 Release 等對外動作先問過使用者；commit 作者用 GitHub noreply 信箱，任何檔案都不放使用者 email。

## 專案是什麼

影片／圖片／音訊壓縮工具。構想參考 CompressO（AGPL）與 RedPanda 線上壓縮，**沒有用它們的程式碼**，本專案 MIT。
平台順序：Windows（v1.0.0）→ Mac（v1.1.0）→ 線上版（v1.2.0）→ iPhone／iPad（線上安裝）→ Android。
外殼、語音教學、更新的寫法沿用同系列 `xiaoke-screw`。

- `src/engine.ts`：純函式。解析 `ffmpeg -i` 的 stderr（含旋轉、封面圖）、依設定產生 FFmpeg 參數（品質 CRF／指定大小兩趟／原檔比例、自動降解析度、硬體編碼 nvenc/qsv/amf/videotoolbox、圖片 JPG/WebP/PNG 減色、音訊 MP3/M4A/Opus），以及預估大小。線上版要共用。
- `electron/ffmpeg.cjs`：執行內建 FFmpeg（ffmpeg-static，打包時放 resources/bin）：probe、縮圖、壓縮（-progress 進度、取消、先寫 .part 再改名、兩趟紀錄檔放暫存工作目錄）、硬體偵測（試編碼 0.5 秒）、產生範例影片（userData/sample）。
- `electron/main.cjs`：xkcompress://（網頁）、xkmedia://f/m?p=路徑（本機影音，支援 Range，只開放使用者加入過的檔案與輸出檔）；fitZoom 讓高縮放螢幕整頁縮小；XK_USER_DATA、XK_QUERY 給測試用。
- `src/backend.ts`：Backend 介面（pick／probe／thumb／sample／preview／run／cancel／網址／下載），`desktopBackend` 包 window.xk；main.ts 只透過 be.* 做事。
- `src/web-engine.ts`：線上版後端（main.ts 動態 import，桌面版不載入）。影片／音訊用 mediabunny（WebCodecs，品質模式用 vtQualityKbps 換算位元率、指定大小超過 8% 照比例重壓一次、不支援的編碼依序退回）；mp3 用 @mediabunny/mp3-encoder；圖片 Canvas＋UPNG 減色（Safari 不出 WebP 改 JPG）；讀不了的格式（AVI 等）或沒 WebCodecs 改 ffmpeg.wasm 單執行緒（WORKERFS 掛檔、共用 buildPlan、-loglevel 改 info 才有 time= 進度、取消＝terminate）。範例影片用 CanvasSource 現場畫（含底片顆粒，約 24 MB）。
- `src/main.ts`：佇列、設定表單（id＝Settings 欄位名）、比較視窗（左右拖曳、滾輪放大、修剪偏移同步）、修剪視窗、`window.xkApp`（教學與 e2e 用）。
- `src/xiaoke.ts`：語音動態教學 13 步（會真的加範例影片並壓縮、打開比較視窗；結束還原設定並移除範例）、檢查更新（GitHub Releases：achir1015/xiaoke-compress）。

## 指令（Node 22：`%LOCALAPPDATA%\nvm\v22.22.3\node.exe`，PATH 裡的是 20）

```bash
node node_modules/vitest/vitest.mjs run        # 15 項，含真的用 FFmpeg 壓縮
node node_modules/typescript/bin/tsc          # 型別檢查
node node_modules/vite/bin/vite.js build      # 產生 dist/
node e2e/desktop.mjs [--guide]                # 桌面 e2e（XK_EXE= 測已安裝版；XK_SHOTS= 存截圖）
CSC_IDENTITY_AUTO_DISCOVERY=false node node_modules/electron-builder/cli.js --win nsis portable --x64 --publish never "-c.directories.output=E:\xkc-build"
python scripts/make_icon.py                   # 圖示（小柯＋被箭頭壓扁的 MP4）
```

## 狀態

- 2026-11-18 Windows v1.0.0：已 /S 安裝到 %LOCALAPPDATA%\Programs\XiaokeCompress（桌面＋開始選單捷徑），安裝檔副本在 `../安裝檔`；開發版與已安裝版 e2e 27 項全過（含 Intel QSV 硬體加速、教學）。
- 2026-11-18 使用者同意後建立公開 repo https://github.com/achir1015/xiaoke-compress（main），v1.0.0 Release 手動上傳安裝版＋免安裝版（無 CI，發佈說明 .github/release-notes.md）；e2e/update-check.mjs 實測已安裝版讀得到 v1.0.0 與安裝檔。沒有 gh CLI：用 git credential fill 取 token 打 API。

- 2026-11-18 v1.1.0 Mac 版：`.github/workflows/build.yml` 推 package.json 版本即建 win＋mac-arm64＋mac-x64 並發 Release（notes 在 .github/release-notes.md）；mac-x64 在 arm64 runner 上用 npm_config_arch=x64 讓 ffmpeg-static 下載 x86_64 FFmpeg；build/adhoc-sign.cjs 先單獨簽 Contents/Resources/bin/ffmpeg 再 --deep 簽整個 App。Mac 硬體加速 VideoToolbox（Intel 不支援 -q:v，品質模式換算位元率＋allow_sw）。Intel Mac（yu-juhwu@192.168.6.32，macOS 26.3）實機 `scripts/mac-install-test.sh <dmg> --guide` 27 項通過（測試資料夾 ~/Developer/xiaoke-compress-test，只放 e2e 與 scripts，素材用 App 內附 FFmpeg 產生）；Apple 晶片 dmg 確認 App 與 FFmpeg 都是 arm64、簽章通過（沒實機）。Windows 程式內更新 1.0.0→1.1.0 實測成功（e2e/update-install.mjs）。等 CI：`GITHUB_TOKEN=… node e2e/wait-ci.mjs`。
- 2026-11-18 v1.2.0 線上版 https://achir1015.github.io/xiaoke-compress/：pages.yml 推 main 自動部署（Pages build_type=workflow）；ffmpeg-core.js/.wasm 由 vite 外掛複製到 dist/ffmpeg/（electron-builder 用 !dist/ffmpeg/** 排除）。網頁 body.web 隱藏 .desktop-only（硬體加速、速度、輸出資料夾），顯示「桌面版」連結與「全部下載」。開發預覽：E:\AI Agent\Claude Code\.claude\launch.json 的 xiaoke-compress-web（vite 5199）、xiaoke-compress-dist（python 靜態 5200）；測試素材 e2e/media（ffmpeg 產生，不進 git）。

## 坑

- 使用者會直接在 GitHub 網頁改 README（加示範圖／影片）：push 前先 fetch，被拒就 rebase，不要覆蓋。
- Claude 預覽窗格隱藏時，媒體載入／img.decode 可能不結束，JS 檢查要加逾時；改原始碼會觸發 HMR 重新整理、狀態全清。

- NSIS 在中文路徑輸出會「Can't open output file」：輸出資料夾要用英文路徑（E:\xkc-build）。
- NSIS 靜默安裝後會自動開啟 App，單一實例會讓 e2e 連不上：先關掉。
- 新的 userData 第一次開會自動播教學，e2e 要帶 noguide（XK_QUERY）。
- 指定大小比原檔還大時改用品質優先（否則會壓得比原檔大）；音訊以位元率設定為上限。
- x265 的 stats 路徑不能有「C:」（x265-params 用冒號分隔）→ 工作目錄設在暫存資料夾、用相對檔名。
