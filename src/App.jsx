import { useState, useEffect, useMemo, useRef } from "react";
import { Blobatar } from "@blobatar/react";
import "blobatar/motion.css";
import {
  idle, happy, sad, mad, surprised, scared, sick, sleepy, thinking, wink, smug, love, shy, unsure,
} from "blobatar/expression";
import "./App.css";

const EXPRESSIONS = { idle, happy, sad, mad, surprised, scared, sick, sleepy, thinking, wink, smug, love, shy, unsure };

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
        // browser preview: mock random walk
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

export default function App() {
  const { stats, tauriOk } = useStats();
  const autoExpr = useMemo(() => stateFromStats(stats), [stats]);
  const [name, setName] = useState("winpet");
  const [showBubble, setShowBubble] = useState(true);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const inputRef = useRef(null);
  const activeExpr = EXPRESSIONS[autoExpr] ?? idle;

  const closeWindow = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch {}
  };

  const startRename = () => { setDraft(name); setEditing(true); setMenu(false); };
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

  // drag: native window drag in Tauri, CSS translate fallback in browser
  const onPointerDown = (e) => {
    if (e.target.closest(".menu, .rename, button, input")) return;
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

  // click elsewhere closes menu / rename box
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
      className={`pet-root ${dragging ? "dragging" : ""}`}
      style={tauriOk ? undefined : { transform: `translate(${pos.x}px, ${pos.y}px)` }}
      onPointerDown={onPointerDown}
      onDoubleClick={startRename}
      onContextMenu={(e) => { e.preventDefault(); setMenu(true); setEditing(false); }}
    >
      {showBubble && (
        <div className="bubble">
          <pre>{formatStats(stats)}</pre>
        </div>
      )}

      <div className="pet">
        <Blobatar name={name} size={72} expression={activeExpr} animate="always" />
      </div>
      <div className="pet-shadow" />

      {menu && (
        <div className="menu" onPointerDown={(e) => e.stopPropagation()}>
          <button onClick={startRename}>改名</button>
          <button onClick={() => { setShowBubble((v) => !v); setMenu(false); }}>
            {showBubble ? "隐藏状态" : "显示状态"}
          </button>
          <button onClick={closeWindow}>隐藏到后台</button>
          <button className="danger" onClick={async () => {
            setMenu(false);
            try {
              const { invoke: inv } = await import("@tauri-apps/api/core");
              await inv("quit_app");
            } catch {}
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
    </div>
  );
}
