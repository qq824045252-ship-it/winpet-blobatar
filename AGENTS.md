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

## 构建与运行（先看这里）

- **构建统一走 `npm run tauri:build`，不要用裸 `cargo build --release`**。`tauri-macros` 用
  `dev: cfg!(not(feature = "custom-protocol"))` 决定加载 dev URL 还是内嵌前端资源，而这个 feature
  只有 Tauri CLI 构建时才会被启用（CLI 会启用依赖级的 `tauri/custom-protocol`）。裸 cargo 构建
  产出的 exe **不内嵌前端资源、而是去连 `http://localhost:5179`**，没有 Vite 时窗口只会显示
  「无法访问此页面 / 拒绝连接」。
  判断方法：内嵌了资源的 exe 约 22 MB，没内嵌的约 10 MB。
- 裸 cargo 构建还有个坑：它检测不到 `dist/` 变化，不会重新嵌入前端资源（编译 1~2 秒就“成功”，
  exe 里还是旧前端）。
- 为了连裸 `cargo build --release` 也能得到可独立运行的 exe，`Cargo.toml` 里补了 Tauri 模板标准的
  `[features] custom-protocol = ["tauri/custom-protocol"]`（模板里标着 DO NOT REMOVE）。
- 单实例保护用 `tauri-plugin-single-instance`，必须**第一个**注册插件（其它插件在它之前初始化就拦不住了）。

## 需要注意的坑

- **`cargo test` 二进制不是 DPI 感知的**：tao 只在创建事件循环时才调
  `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`。所以测试里
  `GetSystemMetrics(SM_CXVIRTUALSCREEN)` 返回的是逻辑像素——本机 3200x2000 的屏幕会报
  1829x1143。测试里要自己先调一次该 API，否则测出来的分辨率和耗时都是错的。
- 截图编辑器、钉图窗口都渲染在同一个 `pet` 窗口里（`App.jsx` 按 `screenshot` 状态切换），
  该窗口是 `transparent: true` + `alwaysOnTop`，铺满全屏时合成开销明显。
- 截图期间前端的两处轮询（500ms 剪贴板、32ms 光标命中）都有 `if (screenshot) return`
  提前退出，不会叠加到截图上。
- **两个实例同时运行**时，后启动的实例抢不到 Alt+P 全局热键，只在日志里写一条 warning，
  界面上却仍标着「Alt+P」——表现就是「热键没反应，点宠物菜单却正常」。已由单实例保护覆盖。

## 设置面板与配置持久化

- 设置入口有两个：宠物右键菜单「设置」、托盘菜单「设置」（托盘项会 `emit("open-settings")`，
  前端监听后显示宠物并打开面板）。面板是宠物窗口内的 `.tool-panel.settings-panel`，四个标签页：
  快捷键 / 指标 / 外观 / 程序（`App.jsx` 的 `settingsTab`）。
- **界面类设置**（宠物大小、气泡指标、程序列表、宠物名）存 localStorage；
  **全局快捷键**存 Rust 侧的 `settings.json`，路径 `app.path().app_config_dir()/settings.json`
  （本机 `%APPDATA%\com.winpet.blobatar\settings.json`）。原因是热键必须在 `setup` 阶段注册，
  那时 webview 还没加载，前端传不进去。
- 快捷键命令：`get_settings` / `set_screenshot_shortcut` / `suspend_screenshot_shortcut`。
  改快捷键时先 `unregister_all()` 再注册（否则新旧相同会 "already registered"），
  注册失败会尽力把旧快捷键装回去。录制期间前端会先调 `suspend_...`，否则按到当前快捷键
  会顺带触发一次截图。
- 前端录制直接送 `KeyboardEvent.code`（`KeyP`/`Digit1`/`F5`/`ArrowUp` 都是 `parse_key` 认的写法），
  修饰键固定 Ctrl/Alt/Shift/Super，且要求至少一个修饰键。
- **同步 `#[tauri::command]` 跑在主线程**，`global_shortcut` 内部走 `run_on_main_thread`；
  wry 的 `send_user_message` 在主线程时是**直接内联执行**的，所以同步命令里调它不会死锁。
- 宠物大小改动会同步 `setPosition`/`setSize`：宠物在窗口内底部对齐，窗口高度 ±delta 时必须
  把窗口 y 也 ∓delta，否则宠物会跟着窗口下移。delta 用 `(size - prev) * scaleFactor` 换算成物理像素。
- `get_stats` 除 cpu/mem/disk/net 外还返回 swap / mem_used / mem_total / disk_free / procs / uptime，
  前端「指标」页从 `METRIC_DEFS` 目录里增删。进程枚举较重，`Monitor` 里每 5 次采样才刷新一次进程列表。

## 截图管线（改动前先看这里）

`prepare_screenshot` 走 GDI 原生抓屏：`capture_virtual_screen`（BitBlt + BGRA→RGBA）
+ `encode_png`（png crate，Fast 档）。实测 3200x2000 全屏约 135 ms。

**不要退回 PowerShell 实现**，实测各阶段：`powershell.exe` 进程启动 312 ms、
`Add-Type` 运行时编译 C# 360 ms、程序集加载 21 ms、`CopyFromScreen` 181 ms、
GDI+ PNG 编码 264 ms，合计约 1.17 s。另外已实测 DPI 感知**不能**从父进程继承
（父进程设 PerMonitorV2 后子进程仍报逻辑像素），所以 PowerShell 方案里那段
`Add-Type` P/Invoke 是必需的、删不掉——只能整个换成原生实现。
