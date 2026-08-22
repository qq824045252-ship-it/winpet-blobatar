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
const CLIPBOARD_HISTORY_KEY = "winpet-clipboard-history-v1";
const MAX_CLIPBOARD_ITEMS = 50;

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
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
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
  const [screenshot, setScreenshot] = useState(null);
  const [clipboardHistory, setClipboardHistory] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CLIPBOARD_HISTORY_KEY) || "[]");
      return Array.isArray(saved) ? saved.slice(0, MAX_CLIPBOARD_ITEMS) : [];
    } catch {
      return [];
    }
  });
  const [notice, setNotice] = useState("");
  const [dragging, setDragging] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const inputRef = useRef(null);
  const noticeTimer = useRef(null);
  const windowSnapshotRef = useRef(null);
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

  useEffect(() => {
    try {
      localStorage.setItem(CLIPBOARD_HISTORY_KEY, JSON.stringify(clipboardHistory));
    } catch {}
  }, [clipboardHistory]);

  useEffect(() => {
    if (!tauriOk || screenshot) return undefined;

    let cancelled = false;
    let busy = false;
    let lastSequence = null;

    const captureTextClipboard = async () => {
      if (cancelled || busy) return;
      busy = true;
      try {
        const sequence = await invokeNative("clipboard_sequence");
        if (sequence === lastSequence) return;
        lastSequence = sequence;

        let text;
        try {
          text = await invokeNative("get_clipboard");
        } catch {
          return;
        }
        if (typeof text !== "string" || !text.trim()) return;

        setClipboardHistory((prev) => {
          if (prev[0]?.text === text) return prev;
          const item = {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            text,
            capturedAt: Date.now(),
          };
          return [item, ...prev.filter((entry) => entry.text !== text)].slice(0, MAX_CLIPBOARD_ITEMS);
        });
      } finally {
        busy = false;
      }
    };

    captureTextClipboard();
    const timer = setInterval(captureTextClipboard, 500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tauriOk, screenshot]);

  const toast = (text) => {
    setNotice(text);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 3600);
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

  const openTool = (nextTool) => {
    setMenu(false);
    setEditing(false);
    setTool(nextTool);
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

  const copyClipboardItem = async (text) => {
    try {
      await invokeNative("set_clipboard", { text });
      toast("已复制");
    } catch (err) { toast(String(err)); }
  };

  const restorePetWindow = async (path) => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const current = getCurrentWindow();
      const snapshot = windowSnapshotRef.current;
      await current.hide();
      setScreenshot(null);
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (snapshot) {
        await current.setPosition(snapshot.position);
        await current.setSize(snapshot.size);
        await current.setResizable(snapshot.resizable);
      }
      await current.show();
      await current.setFocus();
    } catch {}
    windowSnapshotRef.current = null;
    if (path) toast(`截图已保存：${path}`);
  };

  const startScreenshot = async () => {
    setMenu(false);
    setTool(null);
    if (!tauriOk) {
      toast("截图功能仅在 WinPet 桌面版可用");
      return;
    }
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const current = getCurrentWindow();
      windowSnapshotRef.current = {
        position: await current.outerPosition(),
        size: await current.outerSize(),
        resizable: await current.isResizable(),
      };
      const capture = await invokeNative("prepare_screenshot");
      await current.setResizable(false);
      await current.setPosition({ type: "Physical", x: capture.left, y: capture.top });
      await current.setSize({ type: "Physical", width: capture.width, height: capture.height });
      setScreenshot(capture);
      await new Promise((resolve) => setTimeout(resolve, 35));
      await current.show();
      await current.setFocus();
    } catch (err) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().show();
      } catch {}
      await restorePetWindow();
      toast(`截图启动失败：${String(err)}`);
    }
  };

  const cancelScreenshot = async () => {
    if (screenshot?.path) {
      try { await invokeNative("discard_screenshot_capture", { path: screenshot.path }); } catch {}
    }
    await restorePetWindow();
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

  if (screenshot) {
    return (
      <ScreenshotEditor
        capture={screenshot}
        onCancel={cancelScreenshot}
        onFinish={restorePetWindow}
      />
    );
  }

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
          <button onClick={() => openTool("clipboard")}>文本剪贴板</button>
          <button onClick={startScreenshot}>截图与标注</button>
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
          <div className="tool-header">
            <strong>文本剪贴板 · {clipboardHistory.length}</strong>
            <button onClick={() => setTool(null)}>×</button>
          </div>
          <div className="clipboard-list">
            {clipboardHistory.length === 0 ? (
              <div className="clipboard-empty">复制文字后会自动出现在这里</div>
            ) : clipboardHistory.map((item) => (
              <button className="clipboard-item" key={item.id} onClick={() => copyClipboardItem(item.text)}>
                <span className="clipboard-preview">{item.text.replace(/\s+/g, " ").trim()}</span>
                <span className="clipboard-time">{formatClipboardTime(item.capturedAt)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {notice && <div className="notice">{notice}</div>}
    </div>
  );
}
