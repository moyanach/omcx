import React from "react";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
  errorStack: string;
}

/**
 * ErrorBoundary — 全局渲染异常兜底边界
 *
 * 任一子组件在渲染期抛出异常时，捕获并展示可恢复的错误卡片，
 * 彻底杜绝整棵 React 树被卸载导致的全应用白屏。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = {
    hasError: false,
    errorMessage: "",
    errorStack: "",
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      errorMessage: error?.message || "未知渲染异常",
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] 渲染异常已被兜底捕获:", error, info?.componentStack);
    this.setState({ errorStack: String(info?.componentStack || "") });
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleReset = () => {
    this.setState({ hasError: false, errorMessage: "", errorStack: "" });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="w-full h-full flex items-center justify-center p-6 bg-[var(--ui-app-bg,#111111)] select-none">
        <div className="w-full max-w-[560px] rounded-2xl border border-rose-500/30 bg-[var(--ui-popover-bg,#1c1c1c)] p-6 shadow-2xl flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-rose-500/15 text-rose-400 flex items-center justify-center flex-shrink-0">
              <AlertTriangle size={16} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-neutral-100">界面渲染出现异常</h2>
              <p className="text-[11px] text-neutral-500">
                已捕获异常并保护了您的本地会话数据，可安全恢复。
              </p>
            </div>
          </div>

          <pre className="p-3 rounded-xl bg-[#141414] border border-[#262626] text-[11px] text-rose-300 font-mono max-h-32 overflow-auto custom-scrollbar whitespace-pre-wrap break-all">
            {this.state.errorMessage}
          </pre>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={this.handleReset}
              className="px-3.5 py-1.5 rounded-xl bg-[#252525] hover:bg-[#303030] text-neutral-200 text-xs font-medium border border-[#353535] transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw size={12} />
              <span>尝试恢复界面</span>
            </button>
            <button
              onClick={this.handleReload}
              className="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw size={12} />
              <span>重新加载应用</span>
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
