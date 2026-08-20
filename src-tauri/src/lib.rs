use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use sysinfo::{Disks, Networks, System};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

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
        let mem = if total > 0 { used as f32 / total as f32 * 100.0 } else { 0.0 };
        let mut avail = f32::MAX;
        for d in self.disks.list() {
            let t = d.total_space();
            let a = d.available_space();
            if t > 0 { avail = avail.min(a as f32 / t as f32 * 100.0); }
        }
        if avail == f32::MAX { avail = 100.0; }
        let mut rx = 0u64; let mut tx = 0u64;
        for n in self.networks.list().values() { rx += n.received(); tx += n.transmitted(); }
        let dt = Instant::now().duration_since(self.last).as_secs_f32().max(0.05);
        let net = (rx + tx) as f32 / 1024.0 / dt;
        self.last = Instant::now();
        Stats { cpu, mem, disk: avail, net }
    }
}

#[derive(Default)]
struct QuitFlag(AtomicBool);

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
    .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
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
                && !window.app_handle().state::<QuitFlag>().0.load(Ordering::SeqCst)
            {
                api.prevent_close();
                let _ = window.hide();
            }
        }
    })
    .invoke_handler(tauri::generate_handler![get_stats, drag_window, quit_app])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
