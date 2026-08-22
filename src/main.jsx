import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./index.css";
import App from "./App.jsx";
import { PinView } from "./ScreenshotEditor.jsx";

let isPinWindow = false;
try {
  isPinWindow = getCurrentWindow().label.startsWith("pin-");
} catch {}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {isPinWindow ? <PinView /> : <App />}
  </StrictMode>,
);
