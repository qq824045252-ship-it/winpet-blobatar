import { useState, useEffect, useMemo, useRef } from "react";
import { Blobatar } from "@blobatar/react";
import "blobatar/motion.css";
import {
  idle, happy, sad, mad, surprised, scared, sick, sleepy, thinking, wink, smug, love, shy, unsure,
} from "blobatar/expression";
import ScreenshotEditor from "./ScreenshotEditor.jsx";
import "./App.css";

const EXPRESSIONS = { idle, happy, sad, mad, surprised, scared, sick, sleepy, thinking, wink, smug, love, shy, unsure };
const STORAGE_KEY = "winpet-tools-v1";
const PROGRAMS_KEY = "winpet-programs-v2";
const CLIPBOARD_HISTORY_KEY = "winpet-clipboard-history-v1";
const MAX_CLIPBOARD_ITEMS = 50;
// 只有这些区域接收鼠标；窗口其余透明处点击穿透到下层程序
const CLICK_HIT_SELECTORS = ".pet, .bubble, .menu, .rename, .tool-panel, .notice";
const CLICK_HIT_PAD = 6;

function formatStats(s) {
  const net = s.net >= 1024 ? `${(s.net / 1024).toFixed(1)}M/s` : `${(s.net | 0)}K/s`;
  return `CPU ${s.cpu | 0}%   MEM ${s.mem | 0}%\nNET ${net}   DISK ${s.disk | 0}%`;
}
function stateFromStats(s) {
  if (s.disk < 10) return "scared";
  if (s.cpu > 75) return "mad";
  if (s.mem > 85) return "sad";
  if (s.net > 200) return "surprised";
  return "idle";
}
function formatClipboardTime(value) {
  try { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}
function useStats() {
  const [s, setS] = useState({ cpu: 32, mem: 58, disk: 72, net: 45 });
  const [tauriOk, setTauriOk] = useState(false);
  useEffect(() => {
    let timer; let cancelled = false;
    async function tickTauri() {
      try { const { invoke: inv } = await import("@tauri-apps/api/core"); const r = await inv("get_stats"); if (!cancelled) { setS(r); setTauriOk(true); } } catch { if (!cancelled) setTauriOk(false); }
    }
    async function probe() {
      try { const { invoke: inv } = await import("@tauri-apps/api/core"); await inv("get_stats"); if (cancelled) return; setTauriOk(true); timer = setInterval(tickTauri, 1000); tickTauri(); } catch {
        if (cancelled) return; setTauriOk(false);
        timer = setInterval(() => { setS((prev) => { const jitter = (v, lo, hi) => { let nv = v + (Math.random() - 0.5) * 12; if (Math.random() < 0.08) nv = lo + Math.random() * (hi - lo); return Math.max(lo, Math.min(hi, nv)); }; return { cpu: jitter(prev.cpu, 8, 95), mem: jitter(prev.mem, 35, 96), disk: jitter(prev.disk, 5, 92), net: jitter(prev.net, 5, 800), }; }); }, 1000);
      }
    }
    probe(); return () => { cancelled = true; clearInterval(timer); };
  }, []);
  return { stats: s, tauriOk };
}
async function invokeNative(command, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, args);
}
export default function App() {
  const { stats, tauriOk } = useStats();
  const autoExpr = useMemo(() => stateFromStats(stats), [stats]);
  const [name, setName] = useState("winpet");
  const [showBubble, setShowBubble] = useState(true);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [tool, setTool] = useState(null);
  const [programOpen, setProgramOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [screenshot, setScreenshot] = useState(null);
  const [programs, setPrograms] = useState(() => {
    try {
      const raw = localStorage.getItem(PROGRAMS_KEY);
      if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr; }
      // migrate old single exe/cmd
      const old = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const migrated = [];
      if (old.exePath) migrated.push({ id: "m1", name: "启动程序", command: old.exePath });
      if (old.cmdText) migrated.push({ id: "m2", name: "CMD", command: old.cmdText });
      if (migrated.length) return migrated;
      return [];
    } catch { return []; }
  });
  const [newProgName, setNewProgName] = useState("");
  const [newProgCmd, setNewProgCmd] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [clipboardHistory, setClipboardHistory] = useState(() => {
    try { const saved = JSON.parse(localStorage.getItem(CLIPBOARD_HISTORY_KEY) || "[]"); return Array.isArray(saved) ? saved.slice(0, MAX_CLIPBOARD_ITEMS) : []; } catch { return []; }
  });
  const [clipboardQuery, setClipboardQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const inputRef = useRef(null);
  const noticeTimer = useRef(null);
  const windowSnapshotRef = useRef(null);
  const ignoringCursorRef = useRef(false);
  const activeExpr = EXPRESSIONS[autoExpr] ?? idle;
  const filteredClipboard = useMemo(() => {
    const q = clipboardQuery.trim().toLowerCase();
    if (!q) return clipboardHistory;
    return clipboardHistory.filter((item) => item.text.toLowerCase().includes(q));
  }, [clipboardHistory, clipboardQuery]);

  useEffect(() => { try { localStorage.setItem(PROGRAMS_KEY, JSON.stringify(programs)); } catch {} }, [programs]);
  useEffect(() => { try { localStorage.setItem(CLIPBOARD_HISTORY_KEY, JSON.stringify(clipboardHistory)); } catch {} }, [clipboardHistory]);

  // 透明区域点击穿透：默认忽略光标；仅当光标落在宠物/气泡/菜单等命中区时才接收点击。
  // 因为 ignore 后窗口收不到 mouseenter，所以用系统光标坐标轮询做命中检测。
  useEffect(() => {
    if (!tauriOk) return undefined;
    let cancelled = false;
    let win = null;
    const setIgnore = async (ignore) => {
      if (cancelled || ignoringCursorRef.current === ignore) return;
      try {
        if (!win) {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          win = getCurrentWindow();
        }
        await win.setIgnoreCursorEvents(ignore);
        ignoringCursorRef.current = ignore;
        if (ignore) {
          setMenu(false);
          setProgramOpen(false);
          setEditing(false);
        }
      } catch {}
    };
    if (screenshot) {
      setIgnore(false);
      return () => { cancelled = true; };
    }
    const pointHits = (clientX, clientY) => {
      // elementFromPoint 比手写 rect 更稳（含圆角/子元素）
      const stacked = document.elementsFromPoint(clientX, clientY);
      if (stacked.some((el) => el.closest?.(CLICK_HIT_SELECTORS))) return true;
      const nodes = document.querySelectorAll(CLICK_HIT_SELECTORS);
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (
          clientX >= r.left - CLICK_HIT_PAD
          && clientX <= r.right + CLICK_HIT_PAD
          && clientY >= r.top - CLICK_HIT_PAD
          && clientY <= r.bottom + CLICK_HIT_PAD
        ) {
          return true;
        }
      }
      return false;
    };
    let busy = false;
    const tick = async () => {
      if (cancelled || busy) return;
      busy = true;
      try {
        if (!win) {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          win = getCurrentWindow();
        }
        const cursor = await invokeNative("cursor_state");
        if (!cursor || cancelled) return;
        const [cx, cy, leftDown] = cursor;
        // 拖拽中保持接住鼠标，避免拖到透明区后丢事件
        if (leftDown && !ignoringCursorRef.current) {
          await setIgnore(false);
          return;
        }
        const pos = await win.outerPosition();
        const scale = await win.scaleFactor();
        // 物理像素 → CSS 像素；部分环境 outerPosition 已是逻辑坐标，再 /scale 会偏，两侧都试
        let clientX = (cx - pos.x) / scale;
        let clientY = (cy - pos.y) / scale;
        let hit = pointHits(clientX, clientY);
        if (!hit && scale !== 1) {
          clientX = cx - pos.x;
          clientY = cy - pos.y;
          hit = pointHits(clientX, clientY);
        }
        if (!hit && scale === 1) {
          // 再试：用 innerPosition（排除可能的不可见边框偏移）
          try {
            const inner = await win.innerPosition();
            clientX = cx - inner.x;
            clientY = cy - inner.y;
            hit = pointHits(clientX, clientY);
          } catch {}
        }
        // 调试：标题栏显示命中状态，便于外部探查
        const petEl = document.querySelector(".pet");
        const pr = petEl?.getBoundingClientRect();
        document.title = hit
          ? `WinPet HIT ${clientX | 0},${clientY | 0}`
          : `WinPet MISS ${cx},${cy} c=${clientX | 0},${clientY | 0} pet=${pr ? `${pr.left|0},${pr.top|0}-${pr.right|0},${pr.bottom|0}` : "none"} s=${scale}`;
        await setIgnore(!hit);
      } catch (err) {
        document.title = `WinPet ERR ${String(err)}`;
      } finally {
        busy = false;
      }
    };
    tick();
    const timer = setInterval(tick, 32);
    return () => {
      cancelled = true;
      clearInterval(timer);
      ignoringCursorRef.current = false;
      if (win) win.setIgnoreCursorEvents(false).catch(() => {});
    };
  }, [tauriOk, screenshot]);

  useEffect(() => {
    if (!tauriOk || screenshot) return undefined;
    let cancelled = false; let busy = false; let lastSequence = null;
    const captureTextClipboard = async () => {
      if (cancelled || busy) return; busy = true;
      try {
        const sequence = await invokeNative("clipboard_sequence");
        if (sequence === lastSequence) return; lastSequence = sequence;
        let text; try { text = await invokeNative("get_clipboard"); } catch { return; }
        if (typeof text !== "string" || !text.trim()) return;
        setClipboardHistory((prev) => {
          if (prev[0]?.text === text) return prev;
          const item = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, text, capturedAt: Date.now() };
          return [item, ...prev.filter((entry) => entry.text !== text)].slice(0, MAX_CLIPBOARD_ITEMS);
        });
      } finally { busy = false; }
    };
    captureTextClipboard(); const timer = setInterval(captureTextClipboard, 500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [tauriOk, screenshot]);

  const toast = (text) => { setNotice(text); clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(""), 3600); };
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const closeWindow = async () => { try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await getCurrentWindow().close(); } catch {} };
  const startRename = () => { setDraft(name); setEditing(true); setMenu(false); setTool(null); setProgramOpen(false); };
  const updateName = (v) => { setDraft(v); setName(v.trim() || "winpet"); };
  const commitName = () => { const v = draft.trim(); setDraft(v); setName(v || "winpet"); setEditing(false); };
  const openTool = (nextTool) => { setMenu(false); setProgramOpen(false); setEditing(false); setTool(nextTool); };
  const launchProgram = async (command) => {
    const cmd = (command || "").trim();
    if (!cmd) { toast("命令为空"); return; }
    const clean = cmd.replace(/^"+|"+$/g, "").trim();
    const last = (clean.split(" ").pop() || clean).toLowerCase();
    const isExe = /\.exe$/i.test(last) || /\.lnk$/i.test(last) || /\.exe$/i.test(clean) || /\.lnk$/i.test(clean);
    if (isExe) {
      try { await invokeNative("launch_exe", { path: clean }); toast("已启动"); return; } catch (e) {
        try { await invokeNative("run_cmd", { command: cmd }); toast("已通过 CMD 启动"); return; } catch (err) { toast(String(err)); return; }
      }
    }
    try { await invokeNative("run_cmd", { command: cmd }); toast("已运行"); } catch (err) { toast(String(err)); }
  };
  const addProgram = () => {
    const n = newProgName.trim();
    const c = newProgCmd.trim();
    if (!n) { toast("请填写显示名称"); return; }
    if (!c) { toast("请填写路径或命令"); return; }
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,6), name: n, command: c };
    setPrograms(prev => [...prev, item]);
    setNewProgName(""); setNewProgCmd("");
    toast(`已添加：${n}`);
  };
  const removeProgram = (id) => { setPrograms(prev => prev.filter(p => p.id !== id)); toast("已删除"); };
  const copyClipboardItem = async (text) => { try { await invokeNative("set_clipboard", { text }); toast("已复制"); } catch (err) { toast(String(err)); } };
  const restorePetWindow = async (path) => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const current = getCurrentWindow(); const snapshot = windowSnapshotRef.current;
      await current.hide(); setScreenshot(null); await new Promise((resolve) => setTimeout(resolve, 20));
      if (snapshot) { await current.setPosition(snapshot.position); await current.setSize(snapshot.size); await current.setResizable(snapshot.resizable); }
      await current.show(); await current.setFocus();
    } catch {} windowSnapshotRef.current = null; if (path) toast(`截图已保存：${path}`);
  };
  const startScreenshot = async () => {
    setMenu(false); setTool(null); setProgramOpen(false);
    if (!tauriOk) { toast("截图功能仅在 WinPet 桌面版可用"); return; }
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const current = getCurrentWindow();
      windowSnapshotRef.current = { position: await current.outerPosition(), size: await current.outerSize(), resizable: await current.isResizable() };
      const capture = await invokeNative("prepare_screenshot");
      await current.setResizable(false);
      await current.setPosition({ type: "Physical", x: capture.left, y: capture.top });
      await current.setSize({ type: "Physical", width: capture.width, height: capture.height });
      setScreenshot(capture); await new Promise((resolve) => setTimeout(resolve, 35)); await current.show(); await current.setFocus();
    } catch (err) { try { const { getCurrentWindow } = await import("@tauri-apps/api/window"); await getCurrentWindow().show(); } catch {} await restorePetWindow(); toast(`截图启动失败：${String(err)}`); }
  };
  const cancelScreenshot = async () => { if (screenshot?.path) { try { await invokeNative("discard_screenshot_capture", { path: screenshot.path }); } catch {} } await restorePetWindow(); };
  // 手动拖拽窗口：轮询系统光标位置 + setPosition 跟随。
  // 原生 caption 拖拽会被 Windows 限制在屏幕内（窗口顶部不能越过屏幕上沿），
  // 手动方式可让宠物图标拖到屏幕最上方。用 GetAsyncKeyState 检测左键松开，
  // 不依赖指针事件传递（鼠标移出窗口也能跟手、也能停止）。
  const startManualDrag = async (event) => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const { invoke: inv } = await import("@tauri-apps/api/core");
      const win = getCurrentWindow();
      const pos = await win.outerPosition();
      const start = await inv("cursor_state");
      if (!start) return;
      const offsetX = start[0] - pos.x;
      const offsetY = start[1] - pos.y;
      let active = true;
      const el = event.currentTarget;
      try { el.setPointerCapture?.(event.pointerId); } catch {}
      const stop = () => {
        if (!active) return;
        active = false;
        try { el.releasePointerCapture?.(event.pointerId); } catch {}
      };
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const loop = async () => {
        while (active) {
          try {
            const c = await inv("cursor_state");
            if (!c || c[2] === 0) { active = false; break; } // 左键已松开
            const nx = c[0] - offsetX;
            const ny = c[1] - offsetY;
            if (nx !== pos.x || ny !== pos.y) {
              win.setPosition({ type: "Physical", x: nx, y: ny }).catch(() => {});
            }
          } catch { active = false; }
          await sleep(12);
        }
      };
      loop();
    } catch {}
  };
  const onPointerDown = (e) => {
    if (e.target.closest("button, input, textarea, .clipboard-item, .submenu-item")) return;
    if (tauriOk) { startManualDrag(e); return; }
    setDragging(true); const startX = e.clientX - pos.x; const startY = e.clientY - pos.y;
    const move = (ev) => setPos({ x: ev.clientX - startX, y: ev.clientY - startY });
    const up = () => { setDragging(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  useEffect(() => {
    if (!menu && !editing) return;
    const close = (e) => { if (!e.target.closest(".menu, .rename")) { setMenu(false); setEditing(false); setProgramOpen(false); } };
    window.addEventListener("pointerdown", close); return () => window.removeEventListener("pointerdown", close);
  }, [menu, editing]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  useEffect(() => { if (!menu) setProgramOpen(false); }, [menu]);
  // 窗口边缘自适应：保持窗口始终在可视区域内，避免菜单/面板被屏幕边缘裁切
  useEffect(() => {
    const handler = (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        setMenu(false);
        setProgramOpen(false);
        setEditing(false);
        setTool((prev) => (prev === "clipboard" ? null : "clipboard"));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  // Tauri 原生文件拖拽（WebView 的 HTML5 DataTransfer 在 Tauri 下拿不到 path，需用 onDragDropEvent）
  useEffect(() => {
    if (tool !== "program-manager") return;
    let unlisten;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        unlisten = await getCurrentWindow().onDragDropEvent((event) => {
          if (cancelled) return;
          if (event.payload.type === "over") {
            setDragActive(true);
          } else if (event.payload.type === "drop") {
            setDragActive(false);
            const paths = event.payload.paths || [];
            if (paths.length) {
              const path = paths[0];
              const isPy = /\.py$/i.test(path);
              const finalCmd = isPy ? `uv run "${path}"` : path;
              setNewProgCmd(finalCmd);
              setNewProgName((prev) => {
                if (prev.trim()) return prev;
                const base = path.split(/[\\/]/).pop() || path;
                return base.replace(/\.(exe|lnk|cmd|bat|py)$/i, "") || base;
              });
              toast(isPy ? `已生成 uv 命令：${finalCmd}` : `已拖入：${path}`);
            }
          } else {
            setDragActive(false);
          }
        });
      } catch {}
    })();
    return () => { cancelled = true; if (unlisten) unlisten(); setDragActive(false); };
  }, [tool]);
  if (screenshot) { return <ScreenshotEditor capture={screenshot} onCancel={cancelScreenshot} onFinish={restorePetWindow} />; }
  return (
    <div className="pet-root" style={tauriOk ? undefined : { transform: `translate(${pos.x}px, ${pos.y}px)` }} onDoubleClick={startRename} onContextMenu={(e) => { e.preventDefault(); setMenu(true); setEditing(false); setTool(null); }}>
      {showBubble && <div className="bubble"><pre>{formatStats(stats)}</pre></div>}
      <div className={`pet ${dragging ? "dragging" : ""}`} onPointerDown={onPointerDown}><Blobatar name={name} size={72} expression={activeExpr} animate="always" /></div>
      <div className="pet-shadow" />
      {menu && (
        <div className={`menu ${programOpen ? "menu--with-submenu" : ""}`} onPointerDown={(e) => { e.stopPropagation(); if (e.target.closest("button, input, textarea, .submenu-item")) return; startManualDrag(e); }}>
          <div className="menu-main">
            <button onClick={startRename}>改名</button>
            <button onClick={() => { setShowBubble((v) => !v); setMenu(false); }}>{showBubble ? "隐藏状态" : "显示状态"}</button>
            <div className="menu-separator" />
            <div className="menu-group" onMouseEnter={() => setProgramOpen(true)} onMouseLeave={() => setProgramOpen(false)}>
              <button className="menu-parent" onClick={(e) => { e.stopPropagation(); setProgramOpen((v) => !v); }}>
                <span>程序</span><span className="menu-arrow">{programOpen ? "▸" : "▸"}</span>
              </button>
            </div>
            <button onClick={() => openTool("clipboard")}>剪切板 <span style={{opacity:0.6, fontSize:"10px"}}>Alt+C</span></button>
            <button onClick={startScreenshot}>截图</button>
            <button onClick={async () => { setMenu(false); try { await invokeNative("restart_explorer"); toast("已重启资源管理器"); } catch (err) { toast(String(err)); } }}>重启资源管理器</button>
            <div className="menu-separator" />
            <button onClick={closeWindow}>隐藏到后台</button>
            <button className="danger" onClick={async () => { setMenu(false); try { await invokeNative("quit_app"); } catch {} }}>退出</button>
          </div>
          {programOpen && (
            <div className="submenu-flyout" onMouseEnter={() => setProgramOpen(true)} onMouseLeave={() => setProgramOpen(false)}>
              <div className="submenu-title">程序</div>
              {programs.length === 0 ? (
                <div className="submenu-empty">暂无程序，点击添加</div>
              ) : programs.map((p) => (
                <div key={p.id} className="submenu-row">
                  <button className="submenu-item" onClick={() => { launchProgram(p.command); setMenu(false); }}>{p.name}</button>
                  <button className="submenu-del" onClick={() => removeProgram(p.id)} title="删除">×</button>
                </div>
              ))}
              <button className="submenu-add" onClick={() => openTool("program-manager")}>＋ 添加程序</button>
            </div>
          )}
        </div>
      )}
      {editing && (
        <div className="rename" onPointerDown={(e) => e.stopPropagation()}>
          <input ref={inputRef} value={draft} maxLength={24} placeholder="宠物名字" onChange={(e) => updateName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commitName(); if (e.key === "Escape") setEditing(false); }} />
          <button onClick={commitName}>确定</button>
        </div>
      )}
      {tool === "program-manager" && (
        <div className="tool-panel program-panel" onPointerDown={(e) => e.stopPropagation()}>
          <div className="tool-header"><strong>添加程序</strong><button onClick={() => setTool(null)}>×</button></div>
          <div
            className={`drop-zone ${dragActive ? "drag-active" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault(); setDragActive(false);
              const files = e.dataTransfer?.files;
              let path = "";
              if (files && files.length > 0) {
                const f = files[0];
                // Tauri 暴露 path，浏览器回退 name
                path = f.path || f.name || "";
                // 某些环境只有 name，尝试用 webkitRelativePath
                if (!path && e.dataTransfer.getData) path = e.dataTransfer.getData("text/plain");
              } else if (e.dataTransfer?.getData) {
                path = e.dataTransfer.getData("text/plain");
              }
              path = (path || "").trim().replace(/^"|"$/g, "");
              if (path) {
                const isPy = /\.py$/i.test(path);
                const finalCmd = isPy ? `uv run "${path}"` : path;
                setNewProgCmd(finalCmd);
                if (!newProgName.trim()) {
                  const base = path.split(/[\\/]/).pop() || path;
                  const name = base.replace(/\.(exe|lnk|cmd|bat|py)$/i, "");
                  setNewProgName(name || base);
                }
                toast(isPy ? `已生成 uv 命令：${finalCmd}` : `已拖入：${path}`);
              }
            }}
          >
            <span className="drop-zone-icon">⤓</span>
            <span>拖入 .exe / .lnk / .cmd / .bat / .py 文件自动生成地址</span>
            <span className="drop-zone-hint">支持 uv：如 uv run app.py / uv sync</span>
          </div>
          <label>显示名称</label>
          <input value={newProgName} onChange={(e) => setNewProgName(e.target.value)} placeholder="例如：VS Code" />
          <label>路径或命令（支持 .exe / .lnk / uv）</label>
          <input value={newProgCmd} onChange={(e) => setNewProgCmd(e.target.value)} placeholder="C:\app.exe / 快捷方式.lnk / uv run app.py" />
          <div className="tool-actions"><button onClick={addProgram}>添加</button><button onClick={() => setTool(null)}>取消</button></div>
        </div>
      )}
      {tool === "clipboard" && (
        <div className="tool-panel clipboard-panel" onPointerDown={(e) => { e.stopPropagation(); if (e.target.closest("button, input, textarea, .clipboard-item")) return; startManualDrag(e); }}>
          <div className="tool-header" onPointerDown={(e) => { if (e.target.closest("button")) return; e.stopPropagation(); startManualDrag(e); }}><strong>剪切板 · {clipboardHistory.length}</strong><button onClick={() => setTool(null)}>×</button></div>
          <input className="clipboard-search" value={clipboardQuery} placeholder="筛选剪切板…" onChange={(e) => setClipboardQuery(e.target.value)} onPointerDown={(e) => e.stopPropagation()} />
          <div className="clipboard-list">
            {filteredClipboard.length === 0 ? <div className="clipboard-empty">{clipboardQuery ? "没有匹配的内容" : "复制文字后会自动出现在这里"}</div> : filteredClipboard.map((item) => (
              <button className="clipboard-item" key={item.id} onClick={() => copyClipboardItem(item.text)}><span className="clipboard-preview">{item.text.replace(/\s+/g, " ").trim()}</span><span className="clipboard-time">{formatClipboardTime(item.capturedAt)}</span></button>
            ))}
          </div>
        </div>
      )}
      {notice && <div className="notice">{notice}</div>}
    </div>
  );
}
