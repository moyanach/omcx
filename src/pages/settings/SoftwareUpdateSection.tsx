import React, { useState, useEffect } from "react";
import {
  RefreshCw,
  Download,
  ExternalLink,
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
} from "lucide-react";

interface SoftwareUpdateSectionProps {
  showToast: (msg: string) => void;
}

export const SoftwareUpdateSection: React.FC<SoftwareUpdateSectionProps> = ({ showToast }) => {
  // 正在重启安装更新
  const [isRestartingUpdate, setIsRestartingUpdate] = useState(false);

  // ─── 软件自动更新状态 ───
  const [currentAppVersion, setCurrentAppVersion] = useState("v2.1.0");
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error"
  >("idle");
  const [updateInfo, setUpdateInfo] = useState<{
    version?: string;
    releaseDate?: string;
    releaseNotes?: string;
    releaseUrl?: string;
  } | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  } | null>(null);
  const [updateErrorMsg, setUpdateErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (window.electronAPI?.getAppVersion) {
      window.electronAPI
        .getAppVersion()
        .then((ver: string) => {
          if (ver) setCurrentAppVersion(ver.startsWith("v") ? ver : `v${ver}`);
        })
        .catch(() => {});
    }

    const unsubChecking = window.electronAPI?.onUpdateChecking?.(() => {
      setUpdateStatus("checking");
      setUpdateErrorMsg(null);
    });
    const unsubAvailable = window.electronAPI?.onUpdateAvailable?.((info: any) => {
      setUpdateStatus("available");
      setUpdateInfo(info);
      setUpdateErrorMsg(null);
    });
    const unsubNotAvailable = window.electronAPI?.onUpdateNotAvailable?.(() => {
      setUpdateStatus("not-available");
      setUpdateErrorMsg(null);
    });
    const unsubProgress = window.electronAPI?.onUpdateDownloadProgress?.((p: any) => {
      setUpdateStatus("downloading");
      setDownloadProgress(p);
    });
    const unsubDownloaded = window.electronAPI?.onUpdateDownloaded?.((info: any) => {
      setUpdateStatus("downloaded");
      if (info) setUpdateInfo((prev: any) => ({ ...(prev || {}), ...info }));
    });
    const unsubError = window.electronAPI?.onUpdateError?.((err: any) => {
      setUpdateStatus("error");
      setUpdateErrorMsg(typeof err === "string" ? err : err?.message || "更新服务连接失败");
    });

    return () => {
      unsubChecking?.();
      unsubAvailable?.();
      unsubNotAvailable?.();
      unsubProgress?.();
      unsubDownloaded?.();
      unsubError?.();
    };
  }, []);

  const handleManualCheckUpdates = async () => {
    setUpdateStatus("checking");
    setUpdateErrorMsg(null);

    // 5 秒安全超时保护：杜绝任何网络无响应导致一直 loading
    const timer = setTimeout(() => {
      setUpdateStatus((prev) => (prev === "checking" ? "not-available" : prev));
    }, 5000);

    try {
      if (window.electronAPI?.checkForUpdates) {
        const res = await window.electronAPI.checkForUpdates();
        clearTimeout(timer);
        if (!res?.success) {
          setUpdateStatus("error");
          setUpdateErrorMsg(res?.error || "检查更新失败，请检查网络或代理连接");
        }
      } else {
        clearTimeout(timer);
        setTimeout(() => setUpdateStatus("not-available"), 800);
      }
    } catch (err: any) {
      clearTimeout(timer);
      setUpdateStatus("error");
      setUpdateErrorMsg(err?.message || "检查更新异常");
    }
  };

  const handleStartDownload = async () => {
    setUpdateStatus("downloading");
    setDownloadProgress({ percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 });
    if (window.electronAPI?.startDownloadUpdate) {
      const res = await window.electronAPI.startDownloadUpdate();
      if (!res?.success) {
        setUpdateStatus("error");
        setUpdateErrorMsg(res?.error || "下载更新失败");
      }
    }
  };

  const handleQuitAndInstall = async () => {
    if (!window.electronAPI?.quitAndInstallUpdate) return;
    setIsRestartingUpdate(true);
    showToast("正在准备退出并重启应用...");
    try {
      const res = await window.electronAPI.quitAndInstallUpdate();
      if (!res?.success) {
        setIsRestartingUpdate(false);
        showToast("重启失败，已为您打开新版安装包位置");
      }
    } catch (err: any) {
      setIsRestartingUpdate(false);
      showToast(`重启失败: ${err?.message || "未知异常"}`);
    }
  };

  const handleOpenReleasePage = () => {
    const targetUrl = updateInfo?.releaseUrl || "https://github.com/moyanach/omcx/releases";
    if (window.electronAPI?.openReleasePage) {
      window.electronAPI.openReleasePage(targetUrl);
    }
  };

  return (
                <div className="bg-[var(--ui-card-bg)] backdrop-blur-md border border-[color:var(--ui-border-subtle)] rounded-2xl p-6 shadow-sm space-y-4">
                  <div className="border-b border-[#282828] pb-3 flex items-center justify-between">
                    <div>
                      <h3 className="text-xs font-bold text-neutral-100 tracking-wide flex items-center gap-2">
                        <span>软件更新与版本管理</span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          {currentAppVersion}
                        </span>
                      </h3>
                      <p className="text-[11px] text-neutral-500 mt-0.5">
                        基于 GitHub Releases 的全自动化版本检测、差量下载与无缝重启升级
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={updateStatus === "checking" || updateStatus === "downloading"}
                      onClick={handleManualCheckUpdates}
                      className="px-3.5 py-1.5 rounded-xl ui-btn-primary disabled:opacity-50 text-xs font-semibold flex items-center gap-1.5 transition-all shadow-sm cursor-pointer"
                    >
                      <RefreshCw size={12} className={updateStatus === "checking" ? "animate-spin" : ""} />
                      <span>{updateStatus === "checking" ? "正在检查..." : "检查更新"}</span>
                    </button>
                  </div>

                  {/* 状态展示区 */}
                  {updateStatus === "not-available" && (
                    <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2 text-xs text-emerald-400">
                      <CheckCircle2 size={14} className="flex-shrink-0" />
                      <span>当前已是最新版本 ({currentAppVersion})，无需更新。</span>
                    </div>
                  )}

                  {updateStatus === "available" && updateInfo && (
                    <div className="p-3.5 rounded-xl bg-[#171717] border border-blue-500/30 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-neutral-100 flex items-center gap-1.5">
                          <ArrowUpCircle size={14} className="text-blue-400" />
                          <span>发现新版本: v{updateInfo.version}</span>
                        </span>
                        {updateInfo.releaseDate && (
                          <span className="text-[10px] font-mono text-neutral-500">
                            发布日期: {new Date(updateInfo.releaseDate).toLocaleDateString()}
                          </span>
                        )}
                      </div>

                      {updateInfo.releaseNotes && (
                        <div className="p-2.5 rounded-lg bg-[#141414] border border-[#262626] text-[11px] text-neutral-300 font-mono max-h-32 overflow-y-auto custom-scrollbar whitespace-pre-wrap leading-relaxed">
                          {typeof updateInfo.releaseNotes === "string"
                            ? updateInfo.releaseNotes.replace(/<[^>]+>/g, "")
                            : "包含多项性能提升与功能优化。"}
                        </div>
                      )}

                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={handleStartDownload}
                          className="px-3.5 py-1.5 rounded-lg ui-btn-primary text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer"
                        >
                          <Download size={13} />
                          <span>立即在后台下载</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleOpenReleasePage}
                          className="px-3 py-1.5 rounded-lg bg-[#252525] hover:bg-[#303030] text-neutral-300 text-xs font-medium border border-[#353535] transition-colors flex items-center gap-1.5 cursor-pointer"
                        >
                          <ExternalLink size={12} />
                          <span>在浏览器中查看 Release</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {updateStatus === "downloading" && downloadProgress && (
                    <div className="p-3.5 rounded-xl bg-[#171717] border border-[#2b2b2b] space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-neutral-200 flex items-center gap-1.5">
                          <Download size={13} className="text-blue-400 animate-bounce" />
                          <span>正在下载更新安装包...</span>
                        </span>
                        <span className="font-mono text-blue-400 font-bold">
                          {downloadProgress.percent}%
                        </span>
                      </div>

                      <div className="w-full h-2 rounded-full bg-[#252525] overflow-hidden">
                        <div
                          className="h-full bg-blue-600 transition-all duration-300 rounded-full"
                          style={{ width: `${downloadProgress.percent}%` }}
                        />
                      </div>

                      <div className="flex items-center justify-between text-[10px] font-mono text-neutral-500">
                        <span>
                          下载速率: {(downloadProgress.bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s
                        </span>
                        <span>
                          {(downloadProgress.transferred / (1024 * 1024)).toFixed(1)} MB / {(downloadProgress.total / (1024 * 1024)).toFixed(1)} MB
                        </span>
                      </div>
                    </div>
                  )}

                  {updateStatus === "downloaded" && (
                    <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 size={16} className="text-emerald-400 flex-shrink-0" />
                          <div>
                            <span className="text-xs font-bold text-neutral-100">
                              新版本已就绪！
                            </span>
                            <p className="text-[11px] text-neutral-400">
                              {isRestartingUpdate
                                ? "正在退出应用并应用更新，请稍候..."
                                : "最新安装包已完成校验，重启客户端即可无缝完成升级。"}
                            </p>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          disabled={isRestartingUpdate}
                          onClick={handleQuitAndInstall}
                          className="px-4 py-2 rounded-xl ui-btn-emerald disabled:opacity-60 disabled:cursor-not-allowed text-xs font-bold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer"
                        >
                          <RefreshCw size={13} className={isRestartingUpdate ? "animate-spin" : ""} />
                          <span>{isRestartingUpdate ? "正在重启应用..." : "立即重启并安装更新"}</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleOpenReleasePage}
                          className="px-3 py-2 rounded-xl bg-[#252525] hover:bg-[#303030] text-neutral-300 text-xs font-medium border border-[#353535] transition-colors flex items-center gap-1.5 cursor-pointer"
                        >
                          <ExternalLink size={12} />
                          <span>备用手动下载</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {updateStatus === "error" && (
                    <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-rose-400 font-semibold">
                        <AlertCircle size={14} className="flex-shrink-0" />
                        <span>检测更新遇到异常</span>
                      </div>
                      <p className="text-[11px] text-neutral-400 font-mono break-all leading-relaxed">
                        {updateErrorMsg || "网络连接超时或无法解析 GitHub Releases 元数据。"}
                      </p>
                      <button
                        type="button"
                        onClick={handleOpenReleasePage}
                        className="px-3 py-1.5 rounded-lg bg-[#252525] hover:bg-[#303030] text-neutral-200 text-xs font-medium border border-[#353535] transition-colors inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <ExternalLink size={12} />
                        <span>前往 GitHub Releases 查看最新版本</span>
                      </button>
                    </div>
                  )}
                </div>
  );
};
