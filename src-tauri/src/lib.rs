use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use sysinfo::{Disks, Networks, System};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const CREATE_NEW_CONSOLE: u32 = 0x00000010;

#[derive(serde::Serialize, Clone)]
struct Stats {
    cpu: f32,
    mem: f32,
    disk: f32,
    net: f32,
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
fn get_clipboard() -> Result<String, String> {
    let output = powershell("Get-Clipboard -Raw")
        .output()
        .map_err(|err| format!("读取剪贴板失败: {err}"))?;
    if !output.status.success() {
        return Err("当前剪贴板不是可读取的文本内容".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end_matches(['\r', '\n'])
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
fn take_screenshot() -> Result<String, String> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $root = [Environment]::GetFolderPath('MyPictures')
  $dir = Join-Path $root 'WinPet'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $path = Join-Path $dir ('winpet-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.png')
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output $path
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
"#;
    let output = powershell(script)
        .output()
        .map_err(|err| format!("截图失败: {err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        Err("截图失败：未返回保存路径".into())
    } else {
        Ok(path)
    }
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
            // 关闭窗口时隐藏到托盘，托盘菜单“退出”才真正退出
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
            get_clipboard,
            set_clipboard,
            take_screenshot,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
