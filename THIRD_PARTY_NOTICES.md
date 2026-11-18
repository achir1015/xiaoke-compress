# 第三方軟體聲明

小柯機器人MP4影片壓縮工具本身以 MIT 授權釋出（見 LICENSE），程式碼全部自行撰寫。
介面與功能構想參考了 CompressO（AGPL-3.0，https://github.com/codeforreal1/compressO）與 RedPanda 線上影片壓縮，但沒有使用它們的任何程式碼。

## FFmpeg

桌面版內附獨立執行的 FFmpeg 程式（resources/bin/ffmpeg），由 npm 套件 ffmpeg-static 提供：

- Windows：gyan.dev 的 FFmpeg 6.1.1 essentials build
- macOS：evermeet.cx／osxexperts 提供的靜態建置

這些 FFmpeg 建置啟用了 GPL 元件（x264、x265 等），以 **GNU GPL v3** 授權。
FFmpeg 以獨立程式的方式被呼叫（不連結進本程式），授權全文與原始碼取得方式見同資料夾的 `LICENSE`、`ffmpeg*.LICENSE`、`ffmpeg*.README`，
FFmpeg 原始碼：https://ffmpeg.org/download.html

## Electron

MIT License，Copyright (c) Electron contributors / GitHub Inc.
