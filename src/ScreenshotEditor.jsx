import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import "./ScreenshotEditor.css";

const TOOLS = [
  ["pen", "画笔"],
  ["rect", "矩形"],
  ["ellipse", "椭圆"],
  ["arrow", "箭头"],
  ["text", "文字"],
];

const MIN_SELECT = 4;

const ICONS = {
  reselect: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="1.5" strokeDasharray="4 3" />
    </svg>
  ),
  pen: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="m13.5 6.5 4 4" />
    </svg>
  ),
  rect: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
    </svg>
  ),
  ellipse: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <ellipse cx="12" cy="12" rx="8" ry="5.5" />
    </svg>
  ),
  arrow: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 19 19 5" />
      <path d="M12 5h7v7" />
    </svg>
  ),
  text: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M7 6h10M12 6v12" />
    </svg>
  ),
  undo: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4 3 9l6 5" />
      <path d="M3 9h8a6 6 0 0 1 0 12h-2" />
    </svg>
  ),
  pin: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  ),
};

function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

// 把指针事件（CSS 像素）映射到画布位图像素（物理像素）
function canvasPoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)),
  };
}

function drawArrow(ctx, item) {
  const { x1, y1, x2, y2 } = item;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = 16;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
}

function drawAnnotation(ctx, item) {
  ctx.save();
  ctx.strokeStyle = "#ff4655";
  ctx.fillStyle = "#ff4655";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (item.type === "pen") {
    if (item.points.length === 1) {
      // 单击画一个点（round 线帽画零长线也生效，但这里显式画圆更稳）
      ctx.beginPath();
      ctx.arc(item.points[0].x, item.points[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else if (item.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(item.points[0].x, item.points[0].y);
      for (const point of item.points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
  } else if (item.type === "rect") {
    const r = normalizeRect({ x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 });
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  } else if (item.type === "ellipse") {
    const r = normalizeRect({ x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 });
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (item.type === "arrow") {
    drawArrow(ctx, item);
  } else if (item.type === "text") {
    // 带描边的彩色文字，保证任何背景下都清晰（微信风格）
    ctx.font = "600 28px 'Segoe UI', sans-serif";
    ctx.textBaseline = "top";
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,.6)";
    ctx.strokeText(item.text, item.x, item.y);
    ctx.fillStyle = "#ff4655";
    ctx.fillText(item.text, item.x, item.y);
  }
  ctx.restore();
}

export default function ScreenshotEditor({ capture, onFinish, onCancel }) {
  const selectCanvasRef = useRef(null); // 选区阶段：全屏遮罩 + 亮区
  const bgCanvasRef = useRef(null); // 编辑阶段：选区外的暗色背景
  const editCanvasRef = useRef(null); // 编辑阶段：选区内编辑画布
  const imageRef = useRef(null);
  const startRef = useRef(null);
  const activeRef = useRef(null);
  const textDraftRef = useRef(null);
  const finishRef = useRef(null);

  const [loaded, setLoaded] = useState(false);
  const [stage, setStage] = useState("select");
  const [selection, setSelection] = useState(null);
  const [dragSelection, setDragSelection] = useState(null);
  const [tool, setTool] = useState("pen");
  const [annotations, setAnnotations] = useState([]);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [textDraft, setTextDraft] = useState(null); // {x, y, value} 物理像素
  // DPR：canvas 位图像素 / CSS 像素，用于把 DOM 定位换算成 CSS 像素
  const [dpr, setDpr] = useState(() => (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1));

  const src = useMemo(() => convertFileSrc(capture.path), [capture.path]);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageRef.current = img;
      setLoaded(true);
    };
    img.onerror = () => {
      // 回退：用 fetch + blob 避免 tainted canvas
      fetch(src).then(r => r.blob()).then(blob => {
        const url = URL.createObjectURL(blob);
        const fallback = new Image();
        fallback.onload = () => { imageRef.current = fallback; setLoaded(true); };
        fallback.src = url;
      }).catch(() => setLoaded(true));
    };
    img.src = src;
  }, [src]);

  // 窗口铺满整个虚拟屏幕（物理像素），与截图一一对应；全程不缩放窗口
  useEffect(() => {
    (async () => {
      try {
        const win = getCurrentWindow();
        await win.setPosition({ type: "Physical", x: capture.left, y: capture.top });
        await win.setSize({ type: "Physical", width: capture.width, height: capture.height });
      } catch {}
    })();
  }, [capture]);

  // 选区阶段：全屏遮罩 + 亮区 + 微信风格边框
  useEffect(() => {
    if (!loaded || stage !== "select") return;
    const canvas = selectCanvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = "rgba(0,0,0,.5)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const box = dragSelection || selection;
    if (box && box.w >= MIN_SELECT && box.h >= MIN_SELECT) {
      ctx.drawImage(img, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
      const rx = box.x + 1;
      const ry = box.y + 1;
      const rw = Math.max(0, box.w - 2);
      const rh = Math.max(0, box.h - 2);
      ctx.strokeStyle = "rgba(120,180,255,.35)";
      ctx.lineWidth = 7;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.strokeStyle = "rgba(255,255,255,.95)";
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, rw, rh);
    }
  }, [loaded, stage, selection, dragSelection]);

  // 编辑阶段：选区外的暗色背景
  useEffect(() => {
    if (!loaded || stage !== "edit") return;
    const canvas = bgCanvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    ctx.fillStyle = "rgba(0,0,0,.5)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, [loaded, stage]);

  // 编辑阶段：选区内画布（物理像素位图，按 dpr 缩放到屏幕位置）
  useEffect(() => {
    if (!loaded || stage !== "edit" || !selection) return;
    const canvas = editCanvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;
    canvas.width = Math.max(1, Math.round(selection.w));
    canvas.height = Math.max(1, Math.round(selection.h));
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      img,
      selection.x,
      selection.y,
      selection.w,
      selection.h,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    annotations.forEach((item) => drawAnnotation(ctx, item));
    if (draft) drawAnnotation(ctx, draft);
  }, [loaded, stage, selection, annotations, draft]);

  // 实测 DPR（canvas 位图像素 / 实际渲染 CSS 像素），用于 DOM 定位换算
  useEffect(() => {
    if (!loaded || stage !== "select") return;
    const canvas = selectCanvasRef.current;
    if (!canvas || canvas.width <= 0) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const measured = canvas.width / rect.width;
      if (measured > 0.2) setDpr(measured);
    }
  }, [loaded, stage]);

  const setText = (value) => { textDraftRef.current = value; setTextDraft(value); };

  const commitText = () => {
    const t = textDraftRef.current;
    if (!t) return;
    textDraftRef.current = null;
    setTextDraft(null);
    const v = t.value.trim();
    if (v) setAnnotations((items) => [...items, { type: "text", x: t.x, y: t.y, text: v }]);
  };

  const beginSelection = (event) => {
    if (!loaded || stage !== "select") return;
    const point = canvasPoint(selectCanvasRef.current, event);
    startRef.current = point;
    setSelection(null);
    setDragSelection({ x: point.x, y: point.y, w: 0, h: 0 });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveSelection = (event) => {
    if (!startRef.current) return;
    const point = canvasPoint(selectCanvasRef.current, event);
    setDragSelection(normalizeRect(startRef.current, point));
  };

  const endSelection = (event) => {
    if (!startRef.current) return;
    const point = canvasPoint(selectCanvasRef.current, event);
    const box = normalizeRect(startRef.current, point);
    startRef.current = null;
    setDragSelection(null);
    if (box.w < MIN_SELECT || box.h < MIN_SELECT) return;
    setSelection(box);
    setAnnotations([]);
    setDraft(null);
    setText(null);
    setStage("edit");
  };

  const cancelSelection = () => {
    startRef.current = null;
    setDragSelection(null);
  };

  const beginDraw = (event) => {
    if (saving || !selection) return;
    if (textDraftRef.current) commitText();
    const point = canvasPoint(editCanvasRef.current, event);
    if (tool === "text") {
      setText({ x: point.x, y: point.y, value: "" });
      return;
    }
    const item = tool === "pen"
      ? { type: "pen", points: [point] }
      : { type: tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y };
    activeRef.current = item;
    setDraft(item);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveDraw = (event) => {
    if (!activeRef.current) return;
    const point = canvasPoint(editCanvasRef.current, event);
    const current = activeRef.current;
    const next = current.type === "pen"
      ? { ...current, points: [...current.points, point] }
      : { ...current, x2: point.x, y2: point.y };
    activeRef.current = next;
    setDraft(next);
  };

  const endDraw = () => {
    if (!activeRef.current) return;
    const item = activeRef.current;
    activeRef.current = null;
    setDraft(null);
    setAnnotations((items) => [...items, item]);
  };

  const undo = () => setAnnotations((items) => items.slice(0, -1));

  const reselect = () => {
    setStage("select");
    setSelection(null);
    setAnnotations([]);
    setDraft(null);
    setText(null);
    setError("");
  };

  const finish = async (action) => {
    if (saving) return;
    const canvas = editCanvasRef.current;
    if (!canvas) return;
    setSaving(true);
    setError("");
    try {
      const dataBase64 = canvas.toDataURL("image/png").split(",")[1];
      if (action === "save") {
        const path = await invoke("save_screenshot_png", { dataBase64, sourcePath: capture.path });
        await onFinish(path);
        return;
      }
      // 钉图窗口按逻辑像素创建，除以所在显示器缩放因子，保证 1:1 物理尺寸
      const monitor = await currentMonitor();
      const sf = monitor?.scaleFactor || 1;
      await invoke("pin_screenshot_png", {
        dataBase64,
        sourcePath: capture.path,
        width: canvas.width / sf,
        height: canvas.height / sf,
      });
      await onFinish(null);
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  // 让键盘快捷键总能拿到最新的 finish（在 effect 里更新 ref，避免渲染期写入）
  useEffect(() => {
    finishRef.current = finish;
  });

  useEffect(() => {
    const onKey = (event) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (event.key === "Escape") {
        event.preventDefault();
        if (textDraftRef.current) { setText(null); return; }
        onCancel();
        return;
      }
      if (ctrl && key === "z") {
        event.preventDefault();
        setAnnotations((items) => items.slice(0, -1));
        return;
      }
      if (ctrl && key === "s") {
        event.preventDefault();
        finishRef.current?.("save");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  if (!loaded) return <div className="shot-root shot-loading">正在准备截图…</div>;

  if (stage === "select") {
    const box = dragSelection || selection;
    const showChip = box && box.w >= MIN_SELECT && box.h >= MIN_SELECT;
    let chipStyle = null;
    if (showChip) {
      const chipW = 120;
      const chipH = 26;
      let chipX = box.x + box.w + 8;
      let chipY = box.y + box.h + 8;
      if (chipX + chipW > capture.width) chipX = Math.max(8, box.x - chipW - 8);
      if (chipY + chipH > capture.height) chipY = Math.max(8, box.y - chipH - 8);
      chipStyle = { left: chipX / dpr, top: chipY / dpr };
    }
    return (
      <div className="shot-root shot-select-root">
        <canvas
          ref={selectCanvasRef}
          className="shot-canvas-fill"
          onPointerDown={beginSelection}
          onPointerMove={moveSelection}
          onPointerUp={endSelection}
          onPointerCancel={cancelSelection}
        />
        {showChip && (
          <div className="shot-size-chip" style={chipStyle}>
            {Math.round(box.w)} × {Math.round(box.h)}
          </div>
        )}
        <div className="shot-hint">拖动选择截图区域 · Esc 取消</div>
      </div>
    );
  }

  if (!selection) return <div className="shot-root shot-loading">正在准备截图…</div>;

  const toolbarW = 400;
  const toolbarH = 48;
  let tbX = selection.x + selection.w / 2;
  let tbY = selection.y + selection.h + 10;
  if (tbY + toolbarH > capture.height) tbY = selection.y - toolbarH - 10;
  tbY = Math.max(6, Math.min(tbY, capture.height - toolbarH - 6));
  tbX = Math.max(toolbarW / 2 + 8, Math.min(tbX, capture.width - toolbarW / 2 - 8));
  const toolbarStyle = { left: tbX / dpr, top: tbY / dpr, transform: "translateX(-50%)" };
  const editStyle = {
    left: selection.x / dpr,
    top: selection.y / dpr,
    width: selection.w / dpr,
    height: selection.h / dpr,
  };
  const textInputStyle = textDraft ? {
    left: (selection.x + textDraft.x) / dpr,
    top: (selection.y + textDraft.y) / dpr,
  } : null;

  return (
    <div className="shot-root shot-edit-root">
      <canvas ref={bgCanvasRef} className="shot-canvas-fill shot-bg-canvas" />
      <canvas
        ref={editCanvasRef}
        className="shot-edit-canvas"
        style={editStyle}
        onPointerDown={beginDraw}
        onPointerMove={moveDraw}
        onPointerUp={endDraw}
        onPointerCancel={endDraw}
      />
      {textDraft && (
        <input
          className="shot-text-input"
          style={textInputStyle}
          autoFocus
          value={textDraft.value}
          onChange={(e) => setText({ ...textDraftRef.current, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitText();
            if (e.key === "Escape") setText(null);
          }}
          onBlur={commitText}
          onPointerDown={(e) => e.stopPropagation()}
        />
      )}
      <div className="shot-toolbar" style={toolbarStyle} onPointerDown={commitText}>
        <button className="shot-tool-icon" title="重选" onClick={reselect}>{ICONS.reselect}</button>
        <div className="shot-tool-sep" />
        {TOOLS.map(([id, label]) => (
          <button
            key={id}
            className={`shot-tool-icon ${tool === id ? "active" : ""}`}
            title={label}
            onClick={() => setTool(id)}
          >
            {ICONS[id]}
          </button>
        ))}
        <div className="shot-tool-sep" />
        <button className="shot-tool-icon" title="撤销 (Ctrl+Z)" disabled={!annotations.length} onClick={undo}>
          {ICONS.undo}
        </button>
        <div className="shot-toolbar-spacer" />
        <button className="shot-tool-action" onClick={onCancel} disabled={saving}>取消</button>
        <button className="shot-tool-action shot-tool-pin" title="钉住" onClick={() => finish("pin")} disabled={saving}>
          {ICONS.pin}
        </button>
        <button className="shot-tool-action shot-tool-save" onClick={() => finish("save")} disabled={saving}>
          {saving ? "处理中…" : "保存"}
        </button>
      </div>
      {error && <div className="shot-error">{error}</div>}
    </div>
  );
}

export function PinView() {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = getCurrentWindow();
      const path = await invoke("get_pin_path", { label: current.label });
      if (!cancelled) setSrc(convertFileSrc(path));
    })().catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const drag = async (event) => {
    // 仅响应左键拖动，忽略右键/中键；用 pointer 事件即可（避免 mouse+pointer 双触发 startDragging）
    if (event.button !== undefined && event.button !== 0) return;
    try { await getCurrentWindow().startDragging(); } catch {}
  };

  const close = async (event) => {
    event?.preventDefault?.();
    try { await getCurrentWindow().close(); } catch {}
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") close(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="pin-root" onPointerDown={drag} onContextMenu={close} onDoubleClick={close} title="拖动移动 · 右键/双击/ESC 关闭">
      {src ? <img src={src} alt="Pinned screenshot" draggable="false" /> : <div className="pin-loading">加载中…</div>}
    </div>
  );
}
