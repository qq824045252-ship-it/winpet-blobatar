import { useState, useEffect, useMemo, useRef } from "react";
import { Blobatar } from "@blobatar/react";
import "blobatar/motion.css";
import {
  idle, happy, sad, mad, surprised, scared, sick, sleepy, thinking, wink, smug, love, shy, unsure,
} from "blobatar/expression";
import "./App.css";

const EXPRESSIONS = { idle, happy, sad, mad, surprised, scared, sick, sleepy, thinking, wink, smug, love, shy, unsure };
const STORAGE_KEY = "winpet-tools-v1";

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

function useStats() {
  const [s, setS] = useState({ cpu: 32, mem: 58, disk: 72, net: 45 });
  const [tauriOk, setTauriOk] = useState(false);
  useEffect(() => {
    let timer;
    let cancelled = false;
    async function tickTauri() {
      try {
        const { invoke: inv } = await import("@tauri-apps/api/core");
        const r = await inv("get_stats");
        if (!cancelled) { setS(r); setTauriOk(true); }
      } catch {
        if (!cancelled) setTauriOk(false);
      }
    }
    async function probe() {
      try {
        const { invoke: inv } = await import("@tauri-apps/api/core");
        await inv("get_stats");
        if (cancelled) return;
        setTauriOk(true);
        timer = setInterval(tickTauri, 1000);
        tickTauri();
      } catch {
        if (cancelled) return;
        setTauriOk(false);
        timer = setInterval(() => {
          setS((prev) => {
            const jitter = (v, lo, hi) => {
              let nv = v + (Math.random() - 0.5) * 12;
              if (Math.random() < 0.08) nv = lo + Math.random() * (hi - lo);
              return Math.max(lo, Math.min(hi, nv));
            };
            return {
              cpu: jitter(prev.cpu, 8, 95),
              mem: jitter(prev.mem, 35, 96),
              disk: jitter(prev.disk, 5, 92),
              net: jitter(prev.net, 5, 800),
            };
          });
        }, 1000);
      }
    }
    probe();
    return () => { cancelled = true; clearInterval(timer); };
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
  const [draft, setDraft] = useState("");
  const [exePath, setExePath] = useState("");
  const [cmdText, setCmdText] = useState("");
  const [clipboardText, setClipboardText] = useState("");
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const inputRef = useRef(null);
  const noticeTimer = useRef(null);
  const activeExpr = EXPRESSIONS[autoExpr] ?? idle;

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      setExePath(saved.exePath || "");
      setCmdText(saved.cmdText || "");
    } catch {}
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ exePath, cmdText }));
  }, [exePath, cmdText]);

  const toast = (text) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 2800);
  };

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const closeWindow = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch {}
  };

  const startRename = () => { setDraft(name); setEditing(true); setMenu(false); setTool(null); };
  const updateName = (v) => {
    setDraft(v);
    setName(v.trim() || "winpet");
  };
  const commitName = () => {
    const v = draft.trim();
    setDraft(v);
    setName(v || "winpet");
    setEditing(false);
  };

  const openTool = async (nextTool) => {
    setMenu(false);
    setEditing(false);
    setTool(nextTool);
    if (nextTool === "clipboard") {
      try {
        const text = await invokeNative("get_clipboard");
        setClipboardText(text || "");
      } catch (err) {
        setClipboardText("");
        toast(String(err));
      }
    }
  };

  const launchExe = async () => {
    try {
      await invokeNative("launch_exe", { path: exePath });
      toast("EXE 已启动");
    } catch (err) { toast(String(err)); }
  };

  const runCmd = async () => {
    try {
      await invokeNative("run_cmd", { command: cmdText });
      toast("CMD 已启动");
    } catch (err) { toast(String(err)); }
  };

  const saveClipboard = async () => {
    try {
      await invokeNative("set_clipboard", { text: clipboardText });
      toast("已写入剪贴板");
    } catch (err) { toast(String(err)); }
  };

  const refreshClipboard = async () => {
    try {
      const text = await invokeNative("get_clipboard");
      setClipboardText(text || "");
      toast("剪贴板已刷新");
    } catch (err) { toast(String(err)); }
  };

  const takeScreenshot = async () => {
    setMenu(false);
    try {
      const path = await invokeNative("take_screenshot");
      toast(`截图已保存：${path}`);
    } catch (err) { toast(String(err)); }
  };

  const onPointerDown = (e) => {
    if (e.target.closest(".menu, .rename, .tool-panel, button, input, textarea")) return;
    if (tauriOk) {
      import("@tauri-apps/api/core").then(({ invoke: inv }) => inv("drag_window")).catch(() => {});
      return;
    }
    setDragging(true);
    const startX = e.clientX - pos.x;
    const startY = e.clientY - pos.y;
    const move = (ev) => setPos({ x: ev.clientX - startX, y: ev.clientY - startY });
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useEffect(() => {
    if (!menu && !editing) return;
    const close = (e) => {
      if (!e.target.closest(".menu, .rename")) { setMenu(false); setEditing(false); }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu, editing]);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  return (
    <div
      className="pet-root"
      style={tauriOk ? undefined : { transform: `translate(${pos.x}px, ${pos.y}px)` }}
      onDoubleClick={startRename}
      onContextMenu={(e) => { e.preventDefault(); setMenu(true); setEditing(false); setTool(null); }}
    >
      {showBubble && (
        <div className="bubble">
          <pre>{formatStats(stats)}</pre>
        </div>
      )}

      <div className={`pet ${dragging ? "dragging" : ""}`} onPointerDown={onPointerDown}>
        <Blobatar name={name} size={72} expression={activeExpr} animate="always" />
      </div>
      <div className="pet-shadow" />

      {menu && (
        <div className="menu" onPointerDown={(e) => e.stopPropagation()}>
          <button onClick={startRename}>改名</button>
          <button onClick={() => { setShowBubble((v) => !v); setMenu(false); }}>
            {showBubble ? "隐藏状态" : "显示状态"}
          </button>
          <div className="menu-separator" />
          <button onClick={() => openTool("launcher")}>启动程序 / CMD</button>
          <button onClick={() => openTool("clipboard")}>剪贴板</button>
          <button onClick={takeScreenshot}>截图</button>
          <div className="menu-separator" />
          <button onClick={closeWindow}>隐藏到后台</button>
          <button className="danger" onClick={async () => {
            setMenu(false);
            try { await invokeNative("quit_app"); } catch {}
          }}>退出</button>
        </div>
      )}

      {editing && (
        <div className="rename" onPointerDown={(e) => e.stopPropagation()}>
          <input
            ref={inputRef}
            value={draft}
            maxLength={24}
            placeholder="宠物名字"
            onChange={(e) => updateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <button onClick={commitName}>确定</button>
        </div>
      )}

      {tool === "launcher" && (
        <div className="tool-panel launcher-panel" onPointerDown={(e) => e.stopPropagation()}>
          <div className="tool-header"><strong>启动工具</strong><button onClick={() => setTool(null)}>×</button></div>
          <label>EXE 路径</label>
          <div className="tool-row">
            <input value={exePath} onChange={(e) => setExePath(e.target.value)} placeholder="C:\\Program Files\\app.exe" />
            <button onClick={launchExe}>启动</button>
          </div>
          <label>CMD 命令或 .cmd/.bat 路径</label>
          <textarea value={cmdText} onChange={(e) => setCmdText(e.target.value)} placeholder="例如：ipconfig /all" />
          <div className="tool-actions"><button onClick={runCmd}>运行 CMD</button></div>
        </div>
      )}

      {tool === "clipboard" && (
        <div className="tool-panel clipboard-panel" onPointerDown={(e) => e.stopPropagation()}>
          <div className="tool-header"><strong>剪贴板</strong><button onClick={() => setTool(null)}>×</button></div>
          <textarea value={clipboardText} onChange={(e) => setClipboardText(e.target.value)} placeholder="当前文本剪贴板内容" />
          <div className="tool-actions">
            <button onClick={refreshClipboard}>刷新</button>
            <button onClick={saveClipboard}>写入</button>
          </div>
        </div>
      )}

      {notice && <div className="notice">{notice}</div>}
    </div>
  );
}
