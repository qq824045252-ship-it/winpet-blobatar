# WinPet (winpet-blobatar)

Tauri v2 + React 19 桌面宠物，Windows 专用：截图、剪贴板、窗口命中检测大量使用 Win32 FFI 与 PowerShell。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 前端 dev server | `npm run dev`（端口 5179） |
| Tauri 开发运行 | `npm run tauri:dev` |
| 打包可执行文件 | `npm run tauri:build`（`bundle.active=false`，产物在 `src-tauri/target/release/`） |
| 前端 lint | `npm run lint`（oxlint） |
| Rust 类型检查 | `cd src-tauri && cargo check` |

Git Bash 里 `npm` 不在 PATH 上，用 `cmd //c "npm run lint"` 调用。

## 需要注意的坑

- **`cargo test` 二进制不是 DPI 感知的**：tao 只在创建事件循环时才调
  `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`。所以测试里
  `GetSystemMetrics(SM_CXVIRTUALSCREEN)` 返回的是逻辑像素——本机 3200x2000 的屏幕会报
  1829x1143。测试里要自己先调一次该 API，否则测出来的分辨率和耗时都是错的。
- 截图编辑器、钉图窗口都渲染在同一个 `pet` 窗口里（`App.jsx` 按 `screenshot` 状态切换），
  该窗口是 `transparent: true` + `alwaysOnTop`，铺满全屏时合成开销明显。
- 截图期间前端的两处轮询（500ms 剪贴板、32ms 光标命中）都有 `if (screenshot) return`
  提前退出，不会叠加到截图上。

## 截图管线（改动前先看这里）

`prepare_screenshot` 走 GDI 原生抓屏：`capture_virtual_screen`（BitBlt + BGRA→RGBA）
+ `encode_png`（png crate，Fast 档）。实测 3200x2000 全屏约 135 ms。

**不要退回 PowerShell 实现**，实测各阶段：`powershell.exe` 进程启动 312 ms、
`Add-Type` 运行时编译 C# 360 ms、程序集加载 21 ms、`CopyFromScreen` 181 ms、
GDI+ PNG 编码 264 ms，合计约 1.17 s。另外已实测 DPI 感知**不能**从父进程继承
（父进程设 PerMonitorV2 后子进程仍报逻辑像素），所以 PowerShell 方案里那段
`Add-Type` P/Invoke 是必需的、删不掉——只能整个换成原生实现。
