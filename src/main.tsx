import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PopoutShell from "./components/Popout/PopoutShell";
import "./styles.css";
import "./i18n"; // 初始化 i18next + react-i18next (副作用导入)

// 柔性工作区 Phase 1：弹出窗加载同一 index.html 但带 ?popout=<kind>&id=<target>。
// 有 popout 参数 → 渲染 PopoutShell 外壳；无 → 渲染主应用 App。
const params = new URLSearchParams(window.location.search);
const popoutKind = params.get("popout");
const popoutTargetId = params.get("id");

const rootElement = document.getElementById("root") as HTMLElement;

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {popoutKind != null ? (
      <PopoutShell kind={popoutKind} targetId={popoutTargetId} />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
