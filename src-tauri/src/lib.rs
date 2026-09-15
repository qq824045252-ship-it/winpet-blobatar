use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Disks, Networks, System};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetClipboardSequenceNumber() -> u32;
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct WinRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct WinPoint {
    x: i32,
    y: i32,
}

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetWindow(hWnd: isize, uCmd: u32) -> isize;
    fn IsWindowVisible(hWnd: isize) -> i32;
    fn GetWindowRect(hWnd: isize, lpRect: *mut WinRect) -> i32;
    fn GetClassNameW(hWnd: isize, lpClassName: *mut u16, nMaxCount: i32) -> i32;
    fn GetWindowThreadProcessId(hWnd: isize, lpdwProcessId: *mut u32) -> u32;
    fn GetCursorPos(lpPoint: *mut WinPoint) -> i32;
    fn GetAsyncKeyState(vKey: i32) -> i16;
    fn GetWindowLongPtrW(hWnd: isize, nIndex: i32) -> isize;
}

#[cfg(target_os = "windows")]
#[link(name = "dwmapi")]
extern "system" {
    fn DwmGetWindowAttribute(
        hWnd: isize,
        dwAttribute: u32,
        pvAttribute: *mut std::ffi::c_void,
        cbAttribute: u32,
    ) -> i32;
}

const GW_HWNDNEXT: u32 = 2;
const GWL_EXSTYLE: i32 = -20;
const WS_EX_TRANSPARENT: isize = 0x20;
const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
const DWMWA_CLOAKED: u32 = 14;
const VK_LBUTTON: i32 = 0x01;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const CREATE_NEW_CONSOLE: u32 = 0x00000010;

#[derive(serde::Serialize, Clone)]
struct Stats {
    cpu: f32,
    mem: f32,
    disk: f32,
    net: f32,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct ScreenshotCapture {
    path: String,
    left: i32,
    top: i32,
    width: u32,
    height: u32,
}

struct Monitor {
    sys: System,
    disks: Disks,
    networks: Networks,
    last: Instant,
}

impl Monitor {
    fn new() -> Self {
        let mut sys = System::new_all();
        sys.refresh_cpu_usage();
        Self {
            sys,
            disks: Disks::new_with_refreshed_list(),
            networks: Networks::new_with_refreshed_list(),
            last: Instant::now(),
        }
    }

    fn sample(&mut self) -> Stats {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.disks.refresh();
        self.networks.refresh();
        let cpu = self.sys.global_cpu_usage();
        let total = self.sys.total_memory();
        let used = self.sys.used_memory();
        let mem = if total > 0 {
            used as f32 / total as f32 * 100.0
        } else {
            0.0
        };
        let mut avail = f32::MAX;
        for d in self.disks.list() {
            let t = d.total_space();
            let a = d.available_space();
            if t > 0 {
                avail = avail.min(a as f32 / t as f32 * 100.0);
            }
        }
        if avail == f32::MAX {
            avail = 100.0;
        }
        let mut rx = 0u64;
        let mut tx = 0u64;
        for n in self.networks.list().values() {
            rx += n.received();
            tx += n.transmitted();
        }
        let dt = Instant::now()
            .duration_since(self.last)
            .as_secs_f32()
            .max(0.05);
        let net = (rx + tx) as f32 / 1024.0 / dt;
        self.last = Instant::now();
        Stats {
            cpu,
            mem,
            disk: avail,
            net,
        }
    }
}

#[derive(Default)]
struct QuitFlag(AtomicBool);

#[derive(Default)]
struct PinStore {
    next: AtomicU64,
    paths: Mutex<HashMap<String, String>>,
}

fn clean_path(value: &str) -> String {
    value.trim().trim_matches('"').trim().to_string()
}

fn powershell(script: &str) -> Command {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn temp_capture_root() -> PathBuf {
    std::env::temp_dir().join("WinPet")
}

fn remove_temp_capture(path: &str) {
    let root = temp_capture_root();
    let _ = fs::create_dir_all(&root);
    let Ok(root) = root.canonicalize() else { return };
    let Ok(candidate) = PathBuf::from(path).canonicalize() else { return };
    if candidate.starts_with(root) {
        let _ = fs::remove_file(candidate);
    }
}

fn decode_png(data_base64: &str) -> Result<Vec<u8>, String> {
    let bytes = BASE64
        .decode(data_base64.as_bytes())
        .map_err(|err| format!("截图数据无效: {err}"))?;
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("截图数据不是有效 PNG".into());
    }
    Ok(bytes)
}

fn create_pin_window(
    app: &AppHandle,
    store: &PinStore,
    path: &Path,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let root = temp_capture_root();
    fs::create_dir_all(&root).map_err(|err| format!("无法创建临时截图目录: {err}"))?;
    let root = root
        .canonicalize()
        .map_err(|err| format!("无法校验临时截图目录: {err}"))?;
    let candidate = path
        .canonicalize()
        .map_err(|err| format!("临时截图文件不存在: {err}"))?;
    if !candidate.starts_with(root) {
        return Err("钉图只能读取 WinPet 自己的临时截图".into());
    }

    let id = store.next.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("pin-{id}");
    store
        .paths
        .lock()
        .map_err(|_| "钉图状态已损坏".to_string())?
        .insert(label.clone(), candidate.to_string_lossy().to_string());

    let mut w = width.max(80.0);
    let mut h = height.max(60.0);
    let scale = (1200.0 / w).min(800.0 / h).min(1.0);
    w *= scale;
    h *= scale;

    if let Err(err) = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("WinPet Pin")
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(true)
        .skip_taskbar(true)
        .shadow(false)
        .build()
    {
        if let Ok(mut paths) = store.paths.lock() {
            paths.remove(&label);
        }
        return Err(format!("创建钉图窗口失败: {err}"));
    }
    Ok(())
}

#[tauri::command]
fn get_stats(state: tauri::State<'_, Mutex<Monitor>>) -> Stats {
    state.lock().unwrap().sample()
}

#[tauri::command]
fn drag_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("pet") {
        let _ = w.start_dragging();
    }
}

// 返回 [x, y, left_button_down]，供前端手动拖拽窗口用
// （原生 caption 拖拽会被 Windows 限制在屏幕内，手动 setPosition 可移到屏幕上方）
#[tauri::command]
fn cursor_state() -> Option<[i32; 3]> {
    #[cfg(target_os = "windows")]
    {
        let mut pt = WinPoint::default();
        if unsafe { GetCursorPos(&mut pt) } != 0 {
            let down = unsafe { GetAsyncKeyState(VK_LBUTTON) } < 0; // 高位为 1 表示按下
            return Some([pt.x, pt.y, if down { 1 } else { 0 }]);
        }
    }
    None
}

#[tauri::command]
fn launch_exe(path: String) -> Result<(), String> {
    let path = clean_path(&path);
    if path.is_empty() {
        return Err("请输入 EXE 路径".into());
    }
    let mut actual = PathBuf::from(&path);
    if !actual.is_file() {
        let with_lnk = PathBuf::from(format!("{}.lnk", path));
        if with_lnk.is_file() {
            actual = with_lnk;
        } else {
            return Err("文件不存在".into());
        }
    }
    let ext = actual
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "exe" && ext != "lnk" {
        return Err("请选择 .exe 或 .lnk 快捷方式".into());
    }
    if ext == "lnk" {
        // .lnk 需通过 shell 启动，不能直接 CreateProcess
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", &actual.to_string_lossy().to_string()]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        return cmd
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("启动失败: {err}"));
    }
    Command::new(actual)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("启动失败: {err}"))
}

#[tauri::command]
fn run_cmd(command: String) -> Result<(), String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("请输入 CMD 命令或 .cmd/.bat 路径".into());
    }

    let candidate = clean_path(&command);
    // 兼容不带 .lnk 后缀的快捷方式输入
    let candidate_path = if Path::new(&candidate).is_file() {
        PathBuf::from(&candidate)
    } else {
        let with_lnk = PathBuf::from(format!("{}.lnk", candidate));
        if with_lnk.is_file() { with_lnk } else { PathBuf::from(&candidate) }
    };
    let command_line = if candidate_path.is_file() {
        let ext = candidate_path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default();
        if ext.eq_ignore_ascii_case("lnk") {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "start", "", &candidate_path.to_string_lossy().to_string()]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.spawn().map(|_| ()).map_err(|err| format!("启动失败: {err}"))?;
            return Ok(());
        }
        if ext.eq_ignore_ascii_case("py") {
            // .py 文件统一走 uv run
            let mut cmd = Command::new("cmd");
            let arg = format!("uv run \"{}\"", candidate_path.to_string_lossy().replace('"', "\"\""));
            cmd.args(["/K", &arg]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NEW_CONSOLE);
            cmd.spawn().map(|_| ()).map_err(|err| format!("启动失败: {err}"))?;
            return Ok(());
        }
        if ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat") {
            // 直接用 cmd /C 启动，避免 call 引号转义问题（之前 call "path" 在含空格路径下会产生 \" 错误）
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", &candidate_path.to_string_lossy().to_string()]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(CREATE_NEW_CONSOLE);
            cmd.spawn().map(|_| ()).map_err(|err| format!("启动失败: {err}"))?;
            return Ok(());
        }
        return Err("脚本文件仅支持 .cmd / .bat / .lnk / .py(uv)".into());
    } else {
        command
    };

    let mut child = Command::new("cmd.exe");
    child.args(["/K", &command_line]);
    #[cfg(target_os = "windows")]
    child.creation_flags(CREATE_NEW_CONSOLE);
    child
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("CMD 启动失败: {err}"))
}

#[tauri::command]
fn restart_explorer() -> Result<(), String> {
    // 结束资源管理器并重启（先等它完全退出再启动新实例）
    let script = "Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 600; Start-Process explorer";
    let mut child = powershell(script)
        .spawn()
        .map_err(|err| format!("重启资源管理器失败: {err}"))?;
    let _ = child.wait();
    Ok(())
}

#[tauri::command]
fn clipboard_sequence() -> u32 {
    #[cfg(target_os = "windows")]
    unsafe {
        return GetClipboardSequenceNumber();
    }

    #[cfg(not(target_os = "windows"))]
    {
        0
    }
}

#[tauri::command]
fn get_clipboard() -> Result<String, String> {
    let output = powershell("Get-Clipboard -Format Text -Raw")
        .output()
        .map_err(|err| format!("读取剪贴板失败: {err}"))?;
    if !output.status.success() {
        return Err("当前剪贴板不是文本内容".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end_matches(|c| c == '\r' || c == '\n')
        .to_string())
}

#[tauri::command]
fn set_clipboard(text: String) -> Result<(), String> {
    let mut child = powershell(
        "$text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text",
    )
    .stdin(Stdio::piped())
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|err| format!("写入剪贴板失败: {err}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|err| format!("写入剪贴板失败: {err}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|err| format!("写入剪贴板失败: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[tauri::command]
fn prepare_screenshot(app: tauri::AppHandle) -> Result<ScreenshotCapture, String> {
    if let Some(window) = app.get_webview_window("pet") {
        window.hide().map_err(|err| format!("隐藏宠物窗口失败: {err}"))?;
    }
    thread::sleep(Duration::from_millis(120));

    // powershell.exe 默认 DPI-unaware，VirtualScreen/CopyFromScreen 拿到的是缩放后的
    // 逻辑像素（如 175% 缩放下 3200x2000 只报 1829x1143），遮罩窗口按物理像素铺不满屏幕。
    // 先把 PS 进程切到 Per-Monitor V2（-4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2），
    // 让截图尺寸和窗口检测的 GetWindowRect/DWM 坐标同为物理像素。
    let script = r#"
Add-Type -Namespace Win32Util -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);'
[Win32Util.Dpi]::SetProcessDpiAwarenessContext([System.IntPtr](-4)) | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$dir = Join-Path ([IO.Path]::GetTempPath()) 'WinPet'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$path = Join-Path $dir ('capture-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '.png')
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  [pscustomobject]@{
    path = $path
    left = $bounds.Left
    top = $bounds.Top
    width = $bounds.Width
    height = $bounds.Height
  } | ConvertTo-Json -Compress
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
"#;

    let result = (|| {
        let output = powershell(script)
            .output()
            .map_err(|err| format!("截图失败: {err}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let json = String::from_utf8_lossy(&output.stdout);
        serde_json::from_str::<ScreenshotCapture>(json.trim())
            .map_err(|err| format!("截图信息解析失败: {err}"))
    })();

    if result.is_err() {
        if let Some(window) = app.get_webview_window("pet") {
            let _ = window.show();
        }
    }
    result
}

#[tauri::command]
fn discard_screenshot_capture(path: String) {
    remove_temp_capture(&path);
}

#[tauri::command]
fn save_screenshot_png(
    app: tauri::AppHandle,
    data_base64: String,
    source_path: String,
) -> Result<String, String> {
    let bytes = decode_png(&data_base64)?;
    let dir = app
        .path()
        .picture_dir()
        .map_err(|err| format!("无法定位图片目录: {err}"))?
        .join("WinPet");
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建截图目录: {err}"))?;
    let path = dir.join(format!("winpet-{}.png", timestamp_millis()));
    fs::write(&path, bytes).map_err(|err| format!("保存截图失败: {err}"))?;
    remove_temp_capture(&source_path);
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
// async 必须：同步命令在主线程上创建窗口会在 WebView2 初始化时阻塞主线程，
// 导致本命令的 invoke 响应以及后续所有 IPC（Esc 取消、钉图拖动/关闭）全部卡死。
async fn pin_screenshot_png(
    app: tauri::AppHandle,
    state: tauri::State<'_, PinStore>,
    data_base64: String,
    source_path: String,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let bytes = decode_png(&data_base64)?;
    let dir = temp_capture_root();
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建临时截图目录: {err}"))?;
    let path = dir.join(format!("pin-{}.png", timestamp_millis()));
    fs::write(&path, bytes).map_err(|err| format!("创建临时钉图失败: {err}"))?;

    if let Err(err) = create_pin_window(&app, state.inner(), &path, width, height) {
        remove_temp_capture(&path.to_string_lossy());
        return Err(err);
    }

    remove_temp_capture(&source_path);
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_pin_path(state: tauri::State<'_, PinStore>, label: String) -> Result<String, String> {
    state
        .paths
        .lock()
        .map_err(|_| "钉图状态已损坏".to_string())?
        .get(&label)
        .cloned()
        .ok_or_else(|| "找不到钉图内容".to_string())
}

#[tauri::command]
fn save_pin_png(
    app: tauri::AppHandle,
    state: tauri::State<'_, PinStore>,
    label: String,
) -> Result<String, String> {
    let path = state
        .paths
        .lock()
        .map_err(|_| "钉图状态已损坏".to_string())?
        .get(&label)
        .cloned()
        .ok_or_else(|| "找不到钉图内容".to_string())?;
    let bytes = fs::read(&path).map_err(|err| format!("读取钉图失败: {err}"))?;
    let dir = app
        .path()
        .picture_dir()
        .map_err(|err| format!("无法定位图片目录: {err}"))?
        .join("WinPet");
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建截图目录: {err}"))?;
    let out = dir.join(format!("winpet-pin-{}.png", timestamp_millis()));
    fs::write(&out, bytes).map_err(|err| format!("保存钉图失败: {err}"))?;
    Ok(out.to_string_lossy().to_string())
}

#[derive(serde::Serialize)]
struct WindowRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

// 返回指针 (x, y) 下方最顶层（非本应用、可见）窗口的屏幕矩形，用于截图选区阶段自动捕获窗口。
// 从本应用编辑器窗口开始沿 Z 序向下找，命中即返回。
#[cfg(target_os = "windows")]
#[tauri::command]
fn window_under_point(app: tauri::AppHandle, x: i32, y: i32) -> Option<WindowRect> {
    let pet = app.get_webview_window("pet")?;
    let hwnd = pet.hwnd().ok()?.0 as isize;
    let mut cur = hwnd;
    loop {
        cur = unsafe { GetWindow(cur, GW_HWNDNEXT) };
        if cur == 0 {
            break;
        }
        if unsafe { IsWindowVisible(cur) } == 0 {
            continue;
        }
        // 点击穿透窗口对命中测试透明，用户实际看到的是它下层的窗口
        if unsafe { GetWindowLongPtrW(cur, GWL_EXSTYLE) } & WS_EX_TRANSPARENT != 0 {
            continue;
        }
        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(cur, &mut pid) };
        if pid == std::process::id() {
            continue;
        }
        // cloaked 窗口（如最小化的 UWP 应用）IsWindowVisible 仍返回 true，需要额外排除
        let mut cloaked: u32 = 0;
        if unsafe {
            DwmGetWindowAttribute(cur, DWMWA_CLOAKED, &mut cloaked as *mut u32 as _, 4)
        } == 0
            && cloaked != 0
        {
            continue;
        }
        // DWM 可视边框不含 Win10/11 窗口四周 ~7px 的隐形 resize 边框，比 GetWindowRect 贴合用户所见
        let mut r = WinRect::default();
        let has_rect = unsafe {
            DwmGetWindowAttribute(
                cur,
                DWMWA_EXTENDED_FRAME_BOUNDS,
                &mut r as *mut WinRect as _,
                16,
            )
        } == 0 || unsafe { GetWindowRect(cur, &mut r) } != 0;
        if !has_rect {
            continue;
        }
        if x >= r.left && x < r.right && y >= r.top && y < r.bottom {
            // 跳过桌面与任务栏
            let mut cls = [0u16; 64];
            let n = unsafe { GetClassNameW(cur, cls.as_mut_ptr(), cls.len() as i32) };
            let name = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
            if matches!(
                name.as_str(),
                "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
            ) {
                continue;
            }
            return Some(WindowRect {
                x: r.left,
                y: r.top,
                width: r.right - r.left,
                height: r.bottom - r.top,
            });
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn window_under_point(_app: tauri::AppHandle, _x: i32, _y: i32) -> Option<WindowRect> {
    None
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.state::<QuitFlag>().0.store(true, Ordering::SeqCst);
    app.exit(0);
}

fn show_pet(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("pet") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(Monitor::new()))
        .manage(QuitFlag::default())
        .manage(PinStore::default())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let show_i = MenuItem::with_id(app, "show", "显示宠物", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("WinPet")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_pet(app),
                    "quit" => {
                        app.state::<QuitFlag>().0.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_pet(tray.app_handle());
                    }
                })
                .build(app)?;

            // 全局截图热键：任意窗口下 Alt+P 触发截图；宠物隐藏时 webview 仍存活可收到事件。
            // 注册失败（被其他程序占用等）只告警，不影响启动。
            if let Err(err) = app.global_shortcut().on_shortcut(
                Shortcut::new(Some(Modifiers::ALT), Code::KeyP),
                |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit("shortcut-screenshot", ());
                    }
                },
            ) {
                log::warn!("注册截图快捷键 Alt+P 失败: {err}");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "pet"
                    && !window
                        .app_handle()
                        .state::<QuitFlag>()
                        .0
                        .load(Ordering::SeqCst)
                {
                    api.prevent_close();
                    let _ = window.hide();
                } else if window.label().starts_with("pin-") {
                    let state = window.app_handle().state::<PinStore>();
                    if let Ok(mut paths) = state.paths.lock() {
                        if let Some(path) = paths.remove(window.label()) {
                            remove_temp_capture(&path);
                        }
                    };
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_stats,
            drag_window,
            cursor_state,
            restart_explorer,
            launch_exe,
            run_cmd,
            clipboard_sequence,
            get_clipboard,
            set_clipboard,
            prepare_screenshot,
            discard_screenshot_capture,
            save_screenshot_png,
            pin_screenshot_png,
            get_pin_path,
            save_pin_png,
            window_under_point,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
