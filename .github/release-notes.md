## 小柯機器人MP4影片壓縮工具 v1.1.0（Windows＋macOS）

**新增 Mac 版**（Apple 晶片與 Intel 各一個 dmg），功能與 Windows 版相同。

- Mac 硬體加速：Apple VideoToolbox（H.264／H.265）
- 內附 FFmpeg 依晶片分別打包，不需要另外安裝

影片、圖片、音訊一鍵壓成小檔案，全部在自己的電腦上處理：
品質優先／指定檔案大小（兩趟精準壓縮）／原檔比例、H.264／H.265／VP9／AV1、修剪、移除 GPS 資訊、
NVIDIA／Intel／AMD 硬體加速、圖片 JPG／WebP／PNG、音訊 MP3／M4A／Opus、批次與資料夾、前後比較、語音動態教學、自動更新。

**下載**

- Windows：`XiaokeCompress-1.1.0-win-x64.exe`（安裝版，建議）、`XiaokeCompress-1.1.0-win-x64-portable.exe`（免安裝）
- Mac（Apple 晶片 M1～M4）：`XiaokeCompress-1.1.0-mac-arm64.dmg`
- Mac（Intel）：`XiaokeCompress-1.1.0-mac-x64.dmg`

Mac 第一次開啟若出現「無法驗證開發者」：到「系統設定 → 隱私權與安全性」按「強制打開」，或在終端機執行
`xattr -dr com.apple.quarantine "/Applications/小柯機器人MP4影片壓縮工具.app"`。
Windows 若出現 SmartScreen 警告，按「其他資訊 → 仍要執行」。

開發：吳玉柱 先生 與 Claude AI Opus 5.5
