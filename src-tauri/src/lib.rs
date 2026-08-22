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
use tauri::{AppHandle, Manager, WebviewUrl, WindowEvent};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    fn GetClipboardSequenceNumber() -> u32;
}

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

fn validate_saved_screenshot(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .picture_dir()
        .map_err(|err| format!("无法定位图片目录: {err}"))?
        .join("WinPet");
    fs::create_dir_all(&root).map_err(|err| format!("无法创建截图目录: {err}"))?;
    let root = root
        .canonicalize()
        .map_err(|err| format!("无法校验截图目录: {err}"))?;
    let candidate = PathBuf::from(path)
        .canonicalize()
        .map_err(|err| format!("截图文件不存在: {err}"))?;
    if !candidate.starts_with(root) {
        return Err("只能钉住 WinPet 自己保存的截图".into());
    }
    Ok(candidate)
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

#[tauri::command]
fn launch_exe(path: String) -> Result<(), String> {
    let path = clean_path(&path);
    if path.is_empty() {
        return Err("请输入 EXE 路径".into());
    }
    let target = Path::new(&path);
    if !target.is_file() {
        return Err("文件不存在".into());
    }
    let is_exe = target
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("exe"))
        .unwrap_or(false);
    if !is_exe {
        return Err("请选择 .exe 文件".into());
    }
    Command::new(target)
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
    let command_line = if Path::new(&candidate).is_file() {
        let ext = Path::new(&candidate)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default();
        if !ext.eq_ignore_ascii_case("cmd") && !ext.eq_ignore_ascii_case("bat") {
            return Err("脚本文件仅支持 .cmd 或 .bat".into());
        }
        format!("call \"{}\"", candidate.replace('"', "\"\""))
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

    let script = r#"
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
    let bytes = BASE64
        .decode(data_base64.as_bytes())
        .map_err(|err| format!("截图数据无效: {err}"))?;
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("截图数据不是有效 PNG".into());
    }

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
async fn pin_screenshot(
    app: tauri::AppHandle,
    state: tauri::State<'_, PinStore>,
    path: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let path = validate_saved_screenshot(&app, &path)?;
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    let label = format!("pin-{id}");
    state
        .paths
        .lock()
        .map_err(|_| "钉图状态已损坏".to_string())?
        .insert(label.clone(), path.to_string_lossy().to_string());

    let mut w = width.max(80.0);
    let mut h = height.max(60.0);
    let scale = (1200.0 / w).min(800.0 / h).min(1.0);
    w *= scale;
    h *= scale;

    if let Err(err) = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("WinPet Pin")
        .inner_size(w, h)
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .skip_taskbar(true)
        .shadow(false)
        .build()
    {
        if let Ok(mut paths) = state.paths.lock() {
            paths.remove(&label);
        }
        return Err(format!("创建钉图窗口失败: {err}"));
    }
    Ok(())
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
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_stats,
            drag_window,
            launch_exe,
            run_cmd,
            clipboard_sequence,
            get_clipboard,
            set_clipboard,
            prepare_screenshot,
            discard_screenshot_capture,
            save_screenshot_png,
            pin_screenshot,
            get_pin_path,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
