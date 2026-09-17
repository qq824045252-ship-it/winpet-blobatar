import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import "./ScreenshotEditor.css";

const TOOLS = [
  ["select", "选择/移动"],
  ["pen", "画笔"],
  ["rect", "矩形"],
  ["ellipse", "椭圆"],
  ["arrow", "箭头"],
  ["text", "文字"],
];

const MIN_SELECT = 4;

const PALETTE = ["#ff4655", "#ff7a3d", "#ffc53d", "#2ee06a", "#3db9ff", "#9b59ff", "#ffffff", "#262a33"];

const DEFAULT_STYLE = { color: "#ff4655", strokeWidth: 4, fontSize: 28 };
const WIDTH_OPTIONS = [2, 4, 6, 10];
const SIZE_OPTIONS = [16, 24, 32, 48];

const ICONS = {
  reselect: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="1.5" strokeDasharray="4 3" />
    </svg>
  ),
  select: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
      <path d="M13 13l6 6" />
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

let _measureCtx = null;
function measureTextWidth(text, size) {
  if (!_measureCtx) _measureCtx = document.createElement("canvas").getContext("2d");
  _measureCtx.font = `600 ${size ?? 28}px 'Segoe UI', sans-serif`;
  return _measureCtx.measureText(text).width;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// 命中检测：判断点是否落在标注图形上（选择/移动工具用）
function hitTest(item, x, y) {
  const pad = 8;
  if (item.type === "text") {
    const size = item.fontSize ?? 28;
    const w = measureTextWidth(item.text, size);
    return x >= item.x - pad && x <= item.x + w + pad && y >= item.y - pad && y <= item.y + size * 1.2 + pad;
  }
  if (item.type === "pen") {
    return item.points.some((p) => Math.hypot(p.x - x, p.y - y) <= 12);
  }
  const r = normalizeRect({ x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 });
  if (item.type === "rect" || item.type === "ellipse") {
    return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
  }
  if (item.type === "arrow") {
    return distToSegment(x, y, item.x1, item.y1, item.x2, item.y2) <= 14;
  }
  return false;
}

// 平移标注图形（选择/移动工具用）
function translateAnnotation(item, dx, dy) {
  if (item.type === "pen") {
    return { ...item, points: item.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
  }
  if (item.type === "text") {
    return { ...item, x: item.x + dx, y: item.y + dy };
  }
  return { ...item, x1: item.x1 + dx, y1: item.y1 + dy, x2: item.x2 + dx, y2: item.y2 + dy };
}

// 标注图形的包围盒（选中高亮/缩放手柄用）
function annotationBounds(item) {
  if (item.type === "pen") {
    const xs = item.points.map((p) => p.x);
    const ys = item.points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (item.type === "text") {
    const size = item.fontSize ?? 28;
    return { x: item.x, y: item.y, w: measureTextWidth(item.text, size), h: size * 1.2 };
  }
  return normalizeRect({ x: item.x1, y: item.y1 }, { x: item.x2, y: item.y2 });
}

// 8 个缩放手柄的位置（包围盒的角与边中点）
function handlePositions(b) {
  return {
    nw: { x: b.x, y: b.y },
    n: { x: b.x + b.w / 2, y: b.y },
    ne: { x: b.x + b.w, y: b.y },
    e: { x: b.x + b.w, y: b.y + b.h / 2 },
    se: { x: b.x + b.w, y: b.y + b.h },
    s: { x: b.x + b.w / 2, y: b.y + b.h },
    sw: { x: b.x, y: b.y + b.h },
    w: { x: b.x, y: b.y + b.h / 2 },
  };
}

// 由手柄拖动计算新的缩放变换（围绕对侧锚点，支持自由拉伸）
function computeResize(bbox, handle, px, py, minSize) {
  const { x, y, w, h } = bbox;
  const min = minSize ?? 10;
  let nx = x;
  let ny = y;
  let nw = w;
  let nh = h;
  if (handle.includes("e")) nw = Math.max(min, px - x);
  if (handle.includes("w")) { nw = Math.max(min, x + w - px); nx = x + w - nw; }
  if (handle.includes("s")) nh = Math.max(min, py - y);
  if (handle.includes("n")) { nh = Math.max(min, y + h - py); ny = y + h - nh; }
  // 锚点：被拖手柄的对侧（边手柄锚在对面边中点）
  const ax = handle.includes("w") ? x + w : handle.includes("e") ? x : x + w / 2;
  const ay = handle.includes("n") ? y + h : handle.includes("s") ? y : y + h / 2;
  return {
    nx, ny, nw, nh, ax, ay,
    sx: nw / Math.max(1, w),
    sy: nh / Math.max(1, h),
  };
}

// 应用缩放变换到标注（文字按字号缩放）
function resizeAnnotation(item, r) {
  const tx = (v) => r.ax + (v - r.ax) * r.sx;
  const ty = (v) => r.ay + (v - r.ay) * r.sy;
  if (item.type === "pen") {
    return { ...item, points: item.points.map((p) => ({ x: tx(p.x), y: ty(p.y) })) };
  }
  if (item.type === "text") {
    const scale = (r.sx + r.sy) / 2;
    return {
      ...item,
      x: tx(item.x),
      y: ty(item.y),
      fontSize: Math.max(8, Math.round((item.fontSize ?? 28) * scale)),
    };
  }
  return {
    ...item,
    x1: tx(item.x1), y1: ty(item.y1),
    x2: tx(item.x2), y2: ty(item.y2),
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
  const color = item.color ?? "#ff4655";
  const width = item.strokeWidth ?? 4;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (item.type === "pen") {
    if (item.points.length === 1) {
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
    ctx.font = `600 ${item.fontSize ?? 28}px 'Segoe UI', sans-serif`;
    ctx.textBaseline = "top";
    ctx.lineWidth = Math.max(3, (item.fontSize ?? 28) / 7);
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,.6)";
    ctx.strokeText(item.text, item.x, item.y);
    ctx.fillStyle = color;
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
  const movingRef = useRef(null);
  const textDraftRef = useRef(null);
  const textInputRef = useRef(null);
  const finishRef = useRef(null);
  const hoverWindowRef = useRef(null);
  const hoverCheckRef = useRef({ x: -1e9, y: -1e9, t: 0 });

  const [loaded, setLoaded] = useState(false);
  const [stage, setStage] = useState("select");
  const [selection, setSelection] = useState(null);
  const [dragSelection, setDragSelection] = useState(null);
  const [tool, setTool] = useState("select");
  const [annotations, setAnnotations] = useState([]);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [textDraft, setTextDraft] = useState(null); // {x, y, value} 物理像素
  const [hoverWindow, setHoverWindow] = useState(null); // 选区阶段悬停高亮的窗口（capture 坐标）
  const [selectedIndex, setSelectedIndex] = useState(null); // 编辑阶段选中的标注下标
  const [style, setStyle] = useState({ ...DEFAULT_STYLE }); // 新标注使用的样式
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

  // 选区阶段：全屏遮罩 + 亮区 + 微信风格边框 + 悬停窗口高亮
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
    // 悬停窗口高亮（拖动选择时隐藏）
    if (hoverWindow && !(dragSelection && dragSelection.w >= MIN_SELECT)) {
      const r = hoverWindow;
      ctx.strokeStyle = "rgba(255,255,255,.72)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
      ctx.strokeStyle = "rgba(90,170,255,.35)";
      ctx.lineWidth = 6;
      ctx.strokeRect(r.x + 3, r.y + 3, Math.max(0, r.w - 6), Math.max(0, r.h - 6));
    }
  }, [loaded, stage, selection, dragSelection, hoverWindow]);

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
    // 选中标注：虚线高亮框 + 8 个缩放手柄
    if (selectedIndex != null) {
      const sel = annotations[selectedIndex];
      if (sel) {
        const b = annotationBounds(sel);
        ctx.save();
        ctx.strokeStyle = "rgba(90,160,255,.9)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(b.x - 6, b.y - 6, Math.max(0, b.w + 12), Math.max(0, b.h + 12));
        ctx.setLineDash([]);
        // 手柄
        for (const hp of Object.values(handlePositions(b))) {
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = "#2f6fed";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.rect(hp.x - 4, hp.y - 4, 8, 8);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }, [loaded, stage, selection, annotations, draft, selectedIndex]);

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
    if (v) {
      setAnnotations((items) => [...items, {
        type: "text", x: t.x, y: t.y, text: v,
        color: style.color, fontSize: style.fontSize,
      }]);
    }
  };

  // 文字输入框聚焦：WebView2 里挂载后立即 focus 不可靠，多重尝试 + activeElement 校验
  useEffect(() => {
    if (!textDraft) return;
    const tryFocus = () => {
      const el = textInputRef.current;
      if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    };
    const raf = requestAnimationFrame(tryFocus);
    const t1 = setTimeout(tryFocus, 0);
    const t2 = setTimeout(tryFocus, 120);
    const t3 = setTimeout(tryFocus, 400);
    return () => { cancelAnimationFrame(raf); clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, [textDraft]);

  const clearHover = () => {
    hoverWindowRef.current = null;
    hoverCheckRef.current = { x: -1e9, y: -1e9, t: 0 };
    setHoverWindow(null);
  };

  // 选区阶段：检测指针下方窗口（节流），用于悬停高亮 + 单击捕获
  const checkWindowUnderPoint = async (event) => {
    if (startRef.current) return;
    const canvas = selectCanvasRef.current;
    if (!canvas) return;
    const point = canvasPoint(canvas, event);
    const sx = Math.round(capture.left + point.x);
    const sy = Math.round(capture.top + point.y);
    const now = Date.now();
    const last = hoverCheckRef.current;
    if (Math.hypot(sx - last.x, sy - last.y) < 8 && now - last.t < 120) return;
    hoverCheckRef.current = { x: sx, y: sy, t: now };
    try {
      const rect = await invoke("window_under_point", { x: sx, y: sy });
      let next = null;
      if (rect && rect.width >= MIN_SELECT && rect.height >= MIN_SELECT) {
        next = {
          x: rect.x - capture.left,
          y: rect.y - capture.top,
          w: rect.width,
          h: rect.height,
        };
        const x2 = Math.min(capture.width, next.x + next.w);
        const y2 = Math.min(capture.height, next.y + next.h);
        next.x = Math.max(0, next.x);
        next.y = Math.max(0, next.y);
        next.w = Math.max(0, x2 - next.x);
        next.h = Math.max(0, y2 - next.y);
        if (next.w < MIN_SELECT || next.h < MIN_SELECT) next = null;
      }
      const prev = hoverWindowRef.current;
      const changed = !prev || !next || prev.x !== next.x || prev.y !== next.y || prev.w !== next.w || prev.h !== next.h;
      if (changed) {
        hoverWindowRef.current = next;
        setHoverWindow(next);
      }
    } catch {}
  };

  const beginSelection = (event) => {
    if (!loaded || stage !== "select") return;
    const point = canvasPoint(selectCanvasRef.current, event);
    startRef.current = point;
    setSelection(null);
    setDragSelection({ x: point.x, y: point.y, w: 0, h: 0 });
    clearHover();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveSelection = (event) => {
    if (!startRef.current) return;
    const point = canvasPoint(selectCanvasRef.current, event);
    setDragSelection(normalizeRect(startRef.current, point));
  };

  const endSelection = async (event) => {
    if (!startRef.current) return;
    const point = canvasPoint(selectCanvasRef.current, event);
    const box = normalizeRect(startRef.current, point);
    startRef.current = null;
    setDragSelection(null);
    const enterEdit = (r) => {
      setSelection(r);
      setAnnotations([]);
      setDraft(null);
      setText(null);
      clearHover();
      setStage("edit");
    };
    if (box.w < MIN_SELECT || box.h < MIN_SELECT) {
      // 单击：尝试捕获点击处的窗口
      try {
        const sx = Math.round(capture.left + point.x);
        const sy = Math.round(capture.top + point.y);
        const rect = await invoke("window_under_point", { x: sx, y: sy });
        if (rect && rect.width >= MIN_SELECT && rect.height >= MIN_SELECT) {
          const r = {
            x: Math.max(0, rect.x - capture.left),
            y: Math.max(0, rect.y - capture.top),
            w: rect.width,
            h: rect.height,
          };
          r.w = Math.min(capture.width - r.x, r.w);
          r.h = Math.min(capture.height - r.y, r.h);
          if (r.w >= MIN_SELECT && r.h >= MIN_SELECT) {
            enterEdit(r);
            return;
          }
        }
      } catch {}
      return;
    }
    enterEdit(box);
  };

  const cancelSelection = () => {
    startRef.current = null;
    setDragSelection(null);
  };

  const beginDraw = (event) => {
    if (saving || !selection) return;
    if (textDraftRef.current) commitText();
    setSelectedIndex(null);
    const point = canvasPoint(editCanvasRef.current, event);
    if (tool === "text") {
      setText({ x: point.x, y: point.y, value: "" });
      return;
    }
    const item = tool === "pen"
      ? { type: "pen", points: [point], color: style.color, strokeWidth: style.strokeWidth }
      : { type: tool, x1: point.x, y1: point.y, x2: point.x, y2: point.y, color: style.color, strokeWidth: style.strokeWidth };
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

  // 选择/移动工具
  const resizeRef = useRef(null);

  const beginResize = (event, handle) => {
    const sel = annotations[selectedIndex];
    if (!sel) return;
    resizeRef.current = {
      handle,
      bbox: annotationBounds(sel),
      orig: sel,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveResize = (event) => {
    const rz = resizeRef.current;
    if (!rz) return;
    const point = canvasPoint(editCanvasRef.current, event);
    const r = computeResize(rz.bbox, rz.handle, point.x, point.y);
    const moved = resizeAnnotation(rz.orig, r);
    setAnnotations((items) => items.map((it, i) => (i === selectedIndex ? moved : it)));
  };

  const beginSelect = (event) => {
    if (saving || !selection) return;
    const point = canvasPoint(editCanvasRef.current, event);
    // 优先命中已选中标注的缩放手柄
    if (selectedIndex != null) {
      const sel = annotations[selectedIndex];
      if (sel) {
        const hps = handlePositions(annotationBounds(sel));
        for (const [name, hp] of Object.entries(hps)) {
          if (Math.hypot(point.x - hp.x, point.y - hp.y) <= 9) {
            beginResize(event, name);
            return;
          }
        }
      }
    }
    // 再检查命中标注（从最上层开始）
    for (let i = annotations.length - 1; i >= 0; i--) {
      if (hitTest(annotations[i], point.x, point.y)) {
        movingRef.current = { index: i, startX: point.x, startY: point.y, orig: annotations[i] };
        setSelectedIndex(i);
        event.currentTarget.setPointerCapture?.(event.pointerId);
        return;
      }
    }
    setSelectedIndex(null);
  };

  const moveSelect = (event) => {
    if (resizeRef.current) {
      moveResize(event);
      return;
    }
    const m = movingRef.current;
    if (!m) return;
    const point = canvasPoint(editCanvasRef.current, event);
    const dx = point.x - m.startX;
    const dy = point.y - m.startY;
    const moved = translateAnnotation(m.orig, dx, dy);
    setAnnotations((items) => items.map((it, i) => (i === m.index ? moved : it)));
  };

  const endSelect = () => {
    resizeRef.current = null;
    movingRef.current = null;
  };

  const undo = () => setAnnotations((items) => items.slice(0, -1));

  // 修改样式：选中标注则修改它，否则设置新标注的默认样式
  const applyStyle = (patch) => {
    if (selectedIndex != null) {
      setAnnotations((items) => items.map((it, i) => (i === selectedIndex ? { ...it, ...patch } : it)));
    } else {
      setStyle((prev) => ({ ...prev, ...patch }));
    }
  };

  const reselect = () => {
    setStage("select");
    setSelection(null);
    setAnnotations([]);
    setDraft(null);
    setText(null);
    setSelectedIndex(null);
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
      // 文字输入激活时，把键盘焦点还给输入框（解决 WebView2 聚焦丢失）
      if (textDraftRef.current && textInputRef.current && document.activeElement !== textInputRef.current) {
        textInputRef.current.focus({ preventScroll: true });
      }
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
          onPointerMove={(e) => { if (startRef.current) moveSelection(e); else checkWindowUnderPoint(e); }}
          onPointerUp={endSelection}
          onPointerCancel={cancelSelection}
        />
        {showChip && (
          <div className="shot-size-chip" style={chipStyle}>
            {Math.round(box.w)} × {Math.round(box.h)}
          </div>
        )}
        <div className="shot-hint">拖动选择区域 · 单击自动捕获窗口 · Esc 取消</div>
      </div>
    );
  }

  if (!selection) return <div className="shot-root shot-loading">正在准备截图…</div>;

  const toolbarW = 540;
  const toolbarH = 84;
  let tbX = selection.x + selection.w / 2;
  let tbY = selection.y + selection.h + 10;
  if (tbY + toolbarH > capture.height) tbY = selection.y - toolbarH - 10;
  tbY = Math.max(6, Math.min(tbY, capture.height - toolbarH - 6));
  tbX = Math.max(toolbarW / 2 + 8, Math.min(tbX, capture.width - toolbarW / 2 - 8));
  const toolbarStyle = { left: tbX / dpr, top: tbY / dpr, transform: "translateX(-50%)" };

  // 样式栏当前值：选中标注则取标注的样式，否则取新标注默认样式
  const selectedAnn = selectedIndex != null ? annotations[selectedIndex] : null;
  const activeColor = selectedAnn ? (selectedAnn.color ?? DEFAULT_STYLE.color) : style.color;
  const activeWidth = selectedAnn ? (selectedAnn.strokeWidth ?? DEFAULT_STYLE.strokeWidth) : style.strokeWidth;
  const activeSize = selectedAnn ? (selectedAnn.fontSize ?? DEFAULT_STYLE.fontSize) : style.fontSize;
  const editStyle = {
    left: selection.x / dpr,
    top: selection.y / dpr,
    width: selection.w / dpr,
    height: selection.h / dpr,
  };
  // 文字输入框样式：常驻挂载，无输入时放到屏幕外并隐藏，避免 WebView2 挂载聚焦时序问题
  const textInputStyle = {
    left: textDraft ? (selection.x + textDraft.x) / dpr : -9999,
    top: textDraft ? (selection.y + textDraft.y) / dpr : -9999,
  };

  return (
    <div className="shot-root shot-edit-root">
      <canvas ref={bgCanvasRef} className="shot-canvas-fill shot-bg-canvas" />
      <canvas
        ref={editCanvasRef}
        className={`shot-edit-canvas ${tool === "select" ? "shot-cursor-select" : ""}`}
        style={editStyle}
        onPointerDown={tool === "select" ? beginSelect : beginDraw}
        onPointerMove={tool === "select" ? moveSelect : moveDraw}
        onPointerUp={tool === "select" ? endSelect : endDraw}
        onPointerCancel={tool === "select" ? endSelect : endDraw}
      />
      <input
        ref={textInputRef}
        className={`shot-text-input ${textDraft ? "" : "shot-text-input-hidden"}`}
        style={textInputStyle}
        value={textDraft?.value ?? ""}
        onChange={(e) => { if (textDraftRef.current) setText({ ...textDraftRef.current, value: e.target.value }); }}
        onKeyDown={(e) => {
          // isComposing / keyCode 229：中文输入法确认候选词的 Enter 不算提交
          if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            commitText();
          }
          if (e.key === "Escape") setText(null);
        }}
        onBlur={() => { if (textDraftRef.current) commitText(); }}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {textDraft && (
        <div
          className="shot-text-actions"
          style={{ left: textInputStyle.left, top: textInputStyle.top + 46 }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button className="shot-text-ok" onClick={commitText}>确定</button>
          <button onClick={() => setText(null)}>取消</button>
        </div>
      )}
      <div className="shot-toolbar" style={toolbarStyle} onPointerDown={commitText}>
        <div className="shot-toolbar-row">
          <button className="shot-tool-icon" title="重选" onClick={reselect}>{ICONS.reselect}</button>
          <div className="shot-tool-sep" />
          {TOOLS.map(([id, label]) => (
            <button
              key={id}
              className={`shot-tool-icon ${tool === id ? "active" : ""}`}
              title={label}
              onClick={() => { setTool(id); if (id !== "select") setSelectedIndex(null); }}
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
          <button className="shot-tool-action shot-tool-save" title="保存到图片库并复制到剪贴板 (Ctrl+S)" onClick={() => finish("save")} disabled={saving}>
            {saving ? "处理中…" : "保存"}
          </button>
        </div>
        <div className="shot-toolbar-row shot-style-row">
          {PALETTE.map((c) => (
            <button
              key={c}
              className={`shot-swatch ${activeColor.toLowerCase() === c ? "active" : ""}`}
              style={{ background: c }}
              title={c}
              onClick={() => applyStyle({ color: c })}
            />
          ))}
          <label className="shot-swatch shot-swatch-custom" style={{ background: activeColor }} title="自定义颜色">
            <input type="color" value={activeColor} onChange={(e) => applyStyle({ color: e.target.value })} />
          </label>
          <div className="shot-tool-sep" />
          <span className="shot-style-label">粗细</span>
          {WIDTH_OPTIONS.map((w) => (
            <button key={w} className={`shot-style-btn ${activeWidth === w ? "active" : ""}`} onClick={() => applyStyle({ strokeWidth: w })}>{w}</button>
          ))}
          <div className="shot-tool-sep" />
          <span className="shot-style-label">字号</span>
          {SIZE_OPTIONS.map((s) => (
            <button key={s} className={`shot-style-btn ${activeSize === s ? "active" : ""}`} onClick={() => applyStyle({ fontSize: s })}>{s}</button>
          ))}
        </div>
      </div>
      {error && <div className="shot-error">{error}</div>}
    </div>
  );
}

export function PinView() {
  const [src, setSrc] = useState("");
  const [menu, setMenu] = useState(null); // {x, y}
  const [saved, setSaved] = useState("");
  const savedTimerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = getCurrentWindow();
      const path = await invoke("get_pin_path", { label: current.label });
      if (!cancelled) setSrc(convertFileSrc(path));
    })().catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const drag = (event) => {
    // 仅左键拖动；点击按钮/菜单不触发
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest && event.target.closest(".pin-actions, .pin-menu")) return;
    getCurrentWindow().startDragging().catch(() => {});
  };

  const close = async (event) => {
    event?.preventDefault?.();
    try { await getCurrentWindow().close(); } catch {}
  };

  const save = async () => {
    setMenu(null);
    try {
      const label = getCurrentWindow().label;
      const path = await invoke("save_pin_png", { label });
      setSaved(`已保存：${path}`);
    } catch (err) {
      setSaved(`保存失败：${String(err)}`);
    }
    clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSaved(""), 5000);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        setMenu(null);
        setSaved("");
        close(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(savedTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="pin-root"
      onPointerDown={drag}
      onDoubleClick={close}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      title="拖动移动 · 右键保存/关闭 · 双击/ESC 关闭"
    >
      {src ? <img src={src} alt="Pinned screenshot" draggable="false" /> : <div className="pin-loading">加载中…</div>}
      <div className="pin-actions">
        <button onClick={save} title="保存到图片库">保存</button>
        <button onClick={close} title="关闭">×</button>
      </div>
      {menu && (
        <div className="pin-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <button onClick={save}>保存到图片库</button>
          <button onClick={close}>关闭</button>
        </div>
      )}
      {saved && <div className="pin-saved">{saved}</div>}
    </div>
  );
}
