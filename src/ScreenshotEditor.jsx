import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./ScreenshotEditor.css";

const TOOLS = [
  ["pen", "画笔"],
  ["rect", "矩形"],
  ["ellipse", "椭圆"],
  ["arrow", "箭头"],
  ["text", "文字"],
];

function normalizeRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

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
    if (item.points.length > 1) {
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
    ctx.font = "600 28px 'Segoe UI', sans-serif";
    ctx.textBaseline = "top";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,.72)";
    ctx.strokeText(item.text, item.x, item.y);
    ctx.fillText(item.text, item.x, item.y);
  }
  ctx.restore();
}

export default function ScreenshotEditor({ capture, onFinish, onCancel }) {
  const selectCanvasRef = useRef(null);
  const editCanvasRef = useRef(null);
  const imageRef = useRef(null);
  const startRef = useRef(null);
  const activeRef = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [stage, setStage] = useState("select");
  const [selection, setSelection] = useState(null);
  const [dragSelection, setDragSelection] = useState(null);
  const [tool, setTool] = useState("pen");
  const [annotations, setAnnotations] = useState([]);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const src = useMemo(() => convertFileSrc(capture.path), [capture.path]);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imageRef.current = img;
      setLoaded(true);
    };
    img.src = src;
  }, [src]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onCancel();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setAnnotations((items) => items.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

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
    ctx.fillStyle = "rgba(0,0,0,.48)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const box = dragSelection || selection;
    if (box?.w > 0 && box?.h > 0) {
      ctx.drawImage(img, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
      ctx.strokeStyle = "#63a5ff";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(box.x + 1, box.y + 1, Math.max(0, box.w - 2), Math.max(0, box.h - 2));
    }
  }, [loaded, stage, selection, dragSelection]);

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

  const beginSelection = (event) => {
    if (!loaded) return;
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
    if (box.w < 8 || box.h < 8) return;
    setSelection(box);
    setAnnotations([]);
    setDraft(null);
    setStage("edit");
  };

  const beginDraw = (event) => {
    if (saving || !selection) return;
    const point = canvasPoint(editCanvasRef.current, event);
    if (tool === "text") {
      const text = window.prompt("输入标注文字");
      if (text?.trim()) setAnnotations((items) => [...items, { type: "text", x: point.x, y: point.y, text: text.trim() }]);
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

  const finish = async (pin) => {
    if (saving) return;
    const canvas = editCanvasRef.current;
    if (!canvas) return;
    setSaving(true);
    let savedPath = null;
    try {
      const dataBase64 = canvas.toDataURL("image/png").split(",")[1];
      savedPath = await invoke("save_screenshot_png", { dataBase64, sourcePath: capture.path });
      if (pin) {
        const rect = canvas.getBoundingClientRect();
        try {
          await invoke("pin_screenshot", {
            path: savedPath,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        } catch (pinError) {
          await onFinish(savedPath);
          window.alert(`截图已保存，但钉住失败：${String(pinError)}`);
          return;
        }
      }
      await onFinish(savedPath);
    } catch (error) {
      if (savedPath) {
        await onFinish(savedPath);
        window.alert(`截图已保存：${savedPath}\n后续操作失败：${String(error)}`);
        return;
      }
      window.alert(String(error));
      setSaving(false);
    }
  };

  if (!loaded) return <div className="shot-root shot-loading">正在准备截图…</div>;

  if (stage === "select") {
    return (
      <div className="shot-root shot-select-root">
        <canvas
          ref={selectCanvasRef}
          className="shot-select-canvas"
          onPointerDown={beginSelection}
          onPointerMove={moveSelection}
          onPointerUp={endSelection}
        />
        <div className="shot-hint">拖动选择截图区域 · Esc 取消</div>
      </div>
    );
  }

  return (
    <div className="shot-root shot-edit-root">
      <div className="shot-toolbar">
        <button onClick={() => { setStage("select"); setSelection(null); setAnnotations([]); }}>重选</button>
        <span className="shot-divider" />
        {TOOLS.map(([id, label]) => (
          <button key={id} className={tool === id ? "active" : ""} onClick={() => setTool(id)}>{label}</button>
        ))}
        <span className="shot-divider" />
        <button disabled={!annotations.length} onClick={() => setAnnotations((items) => items.slice(0, -1))}>撤销</button>
        <div className="shot-toolbar-spacer" />
        <button className="shot-secondary" onClick={onCancel}>取消</button>
        <button className="shot-primary" disabled={saving} onClick={() => finish(false)}>{saving ? "保存中…" : "保存"}</button>
        <button className="shot-primary" disabled={saving} onClick={() => finish(true)}>保存并钉住</button>
      </div>
      <div className="shot-canvas-wrap">
        <canvas
          ref={editCanvasRef}
          className="shot-edit-canvas"
          onPointerDown={beginDraw}
          onPointerMove={moveDraw}
          onPointerUp={endDraw}
          onPointerCancel={endDraw}
        />
      </div>
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
    if (event.button !== 0) return;
    try { await getCurrentWindow().startDragging(); } catch {}
  };

  const close = async (event) => {
    event.preventDefault();
    try { await getCurrentWindow().close(); } catch {}
  };

  return (
    <div className="pin-root" onPointerDown={drag} onContextMenu={close} title="拖动移动 · 右键关闭">
      {src ? <img src={src} alt="Pinned screenshot" draggable="false" /> : <div className="pin-loading">加载中…</div>}
    </div>
  );
}
