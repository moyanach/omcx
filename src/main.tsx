import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initTheme } from "./theme";

// 应用启动时初始化主题
initTheme();

window.addEventListener("error", (e) => {
  console.error("[OMCX Render Error]", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[OMCX Unhandled Rejection]", e.reason);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
