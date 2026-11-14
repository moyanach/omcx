import React, { useState, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  GitBranch,
  RefreshCw,
  FileDiff,
  Columns,
  Rows,
  Check,
  AlertCircle,
  ExternalLink,
  GitCommit,
  Loader2,
} from "lucide-react";
import { useChatStore } from "@/stores/chatStore";

interface GitChangesViewProps {
  initialFilePath?: string;
  refreshKey?: number;
}

interface DiffLine {
  type: "same" | "add" | "del";
  oldLineNo?: number;
  newLineNo?: number;
  text: string;
}

/**
 * 轻量级 LCS 行级 Diff 算法，支持提取变更上下文
 */
function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText ? oldText.split(/\r?\n/) : [];
  const newLines = newText ? newText.split(/\r?\n/) : [];

  if (oldLines.length === 0 && newLines.length > 0) {
    return newLines.map((text, idx) => ({
      type: "add",
      newLineNo: idx + 1,
      text,
    }));
  }
  if (newLines.length === 0 && oldLines.length > 0) {
    return oldLines.map((text, idx) => ({
      type: "del",
      oldLineNo: idx + 1,
      text,
    }));
  }

  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }

  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (
    endOld >= start &&
    endNew >= start &&
    oldLines[endOld] === newLines[endNew]
  ) {
    endOld--;
    endNew--;
  }

  const prefix: DiffLine[] = [];
  for (let i = 0; i < start; i++) {
    prefix.push({
      type: "same",
      oldLineNo: i + 1,
      newLineNo: i + 1,
      text: oldLines[i],
    });
  }

  const suffix: DiffLine[] = [];
  const suffixLen = oldLines.length - 1 - endOld;
  for (let i = 0; i < suffixLen; i++) {
    const oIdx = endOld + 1 + i;
    const nIdx = endNew + 1 + i;
    suffix.push({
      type: "same",
      oldLineNo: oIdx + 1,
      newLineNo: nIdx + 1,
      text: oldLines[oIdx],
    });
  }

  const midOld = oldLines.slice(start, endOld + 1);
  const midNew = newLines.slice(start, endNew + 1);
  const M = midOld.length;
  const N = midNew.length;

  const middle: DiffLine[] = [];

  if (M * N <= 160000) {
    const dp = Array.from({ length: M + 1 }, () => new Int32Array(N + 1));
    for (let i = M - 1; i >= 0; i--) {
      for (let j = N - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < M && j < N) {
      if (midOld[i] === midNew[j]) {
        middle.push({
          type: "same",
          oldLineNo: start + i + 1,
          newLineNo: start + j + 1,
          text: midOld[i],
        });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        middle.push({
          type: "del",
          oldLineNo: start + i + 1,
          text: midOld[i],
        });
        i++;
      } else {
        middle.push({
          type: "add",
          newLineNo: start + j + 1,
          text: midNew[j],
        });
        j++;
      }
    }
    while (i < M) {
      middle.push({
        type: "del",
        oldLineNo: start + i + 1,
        text: midOld[i],
      });
      i++;
    }
    while (j < N) {
      middle.push({
        type: "add",
        newLineNo: start + j + 1,
        text: midNew[j],
      });
      j++;
    }
  } else {
    midOld.forEach((line, idx) =>
      middle.push({ type: "del", oldLineNo: start + idx + 1, text: line })
    );
    midNew.forEach((line, idx) =>
      middle.push({ type: "add", newLineNo: start + idx + 1, text: line })
    );
  }

  return [...prefix, ...middle, ...suffix];
}

export const GitChangesView: React.FC<GitChangesViewProps> = ({
  initialFilePath,
  refreshKey,
}) => {
  const {
    sessions,
    activeSessionId,
    gitStatus,
    refreshGitStatus,
    openFileInWorkbench,
  } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      gitStatus: s.gitStatus,
      refreshGitStatus: s.refreshGitStatus,
      openFileInWorkbench: s.openFileInWorkbench,
    }))
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const workDir = activeSession?.workDir || "";

  const [selectedPath, setSelectedPath] = useState<string>("");
  const [diffData, setDiffData] = useState<{
    filePath: string;
    oldText: string;
    newText: string;
    isBinary: boolean;
  } | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [diffMode, setDiffMode] = useState<"split" | "unified">("split");
  const [onlyChanges, setOnlyChanges] = useState(true);

  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const modifiedFiles = gitStatus?.modifiedFiles || [];

  useEffect(() => {
    if (workDir) {
      refreshGitStatus(workDir);
    }
  }, [workDir, refreshKey]);

  useEffect(() => {
    if (initialFilePath) {
      setSelectedPath(initialFilePath);
    } else if (
      modifiedFiles.length > 0 &&
      (!selectedPath || !modifiedFiles.some((f) => f.path === selectedPath))
    ) {
      setSelectedPath(modifiedFiles[0].path);
    } else if (modifiedFiles.length === 0) {
      setSelectedPath("");
      setDiffData(null);
    }
  }, [initialFilePath, modifiedFiles]);

  useEffect(() => {
    if (!workDir || !selectedPath || !window.electronAPI?.getWorkspaceFileDiff) {
      return;
    }
    let cancelled = false;
    setLoadingDiff(true);
    window.electronAPI
      .getWorkspaceFileDiff(workDir, selectedPath)
      .then((res) => {
        if (cancelled) return;
        if (res?.success) {
          setDiffData({
            filePath: res.filePath || selectedPath,
            oldText: res.oldText || "",
            newText: res.newText || "",
            isBinary: Boolean(res.isBinary),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDiff(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workDir, selectedPath, refreshKey]);

  const allDiffLines = useMemo(() => {
    if (!diffData || diffData.isBinary) return [];
    return computeLineDiff(diffData.oldText, diffData.newText);
  }, [diffData]);

  const visibleDiffLines = useMemo(() => {
    if (!onlyChanges) return allDiffLines;
    const changedIndices = new Set<number>();
    allDiffLines.forEach((line, idx) => {
      if (line.type !== "same") {
        for (
          let k = Math.max(0, idx - 4);
          k <= Math.min(allDiffLines.length - 1, idx + 4);
          k++
        ) {
          changedIndices.add(k);
        }
      }
    });
    if (changedIndices.size === 0) return allDiffLines.slice(0, 60);
    return allDiffLines.filter((_, idx) => changedIndices.has(idx));
  }, [allDiffLines, onlyChanges]);

  // 左右对比：把相邻的删除块与新增块逐行配对，缺失的一侧补空行。
  // 之前两列各自 filter 后会因行数不等而整体错位，无法直观看出“哪行改成了哪行”。
  const splitRows = useMemo(() => {
    const rows: Array<{ left?: DiffLine; right?: DiffLine }> = [];
    let idx = 0;
    while (idx < visibleDiffLines.length) {
      const line = visibleDiffLines[idx];
      if (line.type === "same") {
        rows.push({ left: line, right: line });
        idx += 1;
        continue;
      }
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (idx < visibleDiffLines.length && visibleDiffLines[idx].type === "del") {
        dels.push(visibleDiffLines[idx]);
        idx += 1;
      }
      while (idx < visibleDiffLines.length && visibleDiffLines[idx].type === "add") {
        adds.push(visibleDiffLines[idx]);
        idx += 1;
      }
      const count = Math.max(dels.length, adds.length);
      for (let k = 0; k < count; k++) {
        rows.push({ left: dels[k], right: adds[k] });
      }
    }
    return rows;
  }, [visibleDiffLines]);

  const handleCommit = async () => {
    if (!workDir || !commitMsg.trim() || committing) return;
    if (!window.electronAPI?.commitWorkspaceChanges) return;

    setCommitting(true);
    setCommitResult(null);
    try {
      const res = await window.electronAPI.commitWorkspaceChanges(
        workDir,
        commitMsg.trim()
      );
      if (res?.success) {
        setCommitMsg("");
        setCommitResult({
          ok: true,
          text: `已成功提交 (${res.commitHash || "HEAD"})`,
        });
        await refreshGitStatus(workDir);
      } else {
        setCommitResult({
          ok: false,
          text: res?.error || "Git 提交失败",
        });
      }
    } catch (err: any) {
      setCommitResult({
        ok: false,
        text: err?.message || "Git 提交异常",
      });
    } finally {
      setCommitting(false);
      setTimeout(() => setCommitResult(null), 4000);
    }
  };

  if (!workDir || !gitStatus?.isGit) {
    return (
      <div className="flex-1 h-full bg-[var(--ui-stage-bg)] flex flex-col items-center justify-center p-8 text-center">
        <FileDiff size={32} className="text-[var(--ui-text-faint)] mb-3 opacity-50" />
        <div className="text-sm font-medium text-[var(--ui-text-primary)] mb-1">
          当前目录未启用 Git 仓库
        </div>
        <div className="text-xs text-[var(--ui-text-muted)] max-w-[280px]">
          绑定包含 <code className="text-[var(--ui-accent-amber)]">.git</code>{" "}
          的工程目录后，即可在此处审查文件级代码增删并一键提交。
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 h-full bg-[var(--ui-stage-bg)] flex flex-col overflow-hidden text-[var(--ui-text-primary)] select-none">
      {/* 顶部栏：分支信息 + 视图模式切换 */}
      <div className="h-10 px-3 flex items-center justify-between border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="px-2 py-0.5 rounded-md bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] border border-[color:var(--ui-accent-amber-border)] text-[11px] font-mono flex items-center gap-1">
            <GitBranch size={11} />
            {gitStatus.branch || "main"}
          </span>
          <span className="text-xs text-[var(--ui-text-secondary)]">
            {modifiedFiles.length} 个变更文件
          </span>
          {(gitStatus.insertions > 0 || gitStatus.deletions > 0) && (
            <div className="flex items-center gap-1.5 text-xs font-mono font-semibold">
              <span className="text-[var(--ui-accent-emerald)]">
                +{gitStatus.insertions}
              </span>
              <span className="text-[var(--ui-accent-rose)]">
                -{gitStatus.deletions}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setOnlyChanges(!onlyChanges)}
            className={`px-2 py-1 rounded-lg text-[11px] border transition-colors ${
              onlyChanges
                ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] border-[color:var(--ui-accent-blue-border)] font-medium"
                : "bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border-[color:var(--ui-border-hairline)] hover:text-[var(--ui-text-primary)]"
            }`}
            title="切换仅显示变更上下文或显示全文"
          >
            {onlyChanges ? "仅看变更行" : "显示全文"}
          </button>

          <div className="flex items-center rounded-lg bg-[var(--ui-chip-bg)] p-0.5 border border-[color:var(--ui-border-hairline)]">
            <button
              onClick={() => setDiffMode("split")}
              className={`px-2 py-0.5 rounded-md text-[11px] flex items-center gap-1 transition-colors ${
                diffMode === "split"
                  ? "bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] font-medium"
                  : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
              }`}
              title="左右分栏对比"
            >
              <Columns size={11} />
              <span>分栏</span>
            </button>
            <button
              onClick={() => setDiffMode("unified")}
              className={`px-2 py-0.5 rounded-md text-[11px] flex items-center gap-1 transition-colors ${
                diffMode === "unified"
                  ? "bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] font-medium"
                  : "text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
              }`}
              title="单栏行内对比"
            >
              <Rows size={11} />
              <span>行内</span>
            </button>
          </div>

          <button
            onClick={() => refreshGitStatus(workDir)}
            className="p-1.5 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] transition-colors"
            title="刷新 Git 状态"
          >
            <RefreshCw size={12.5} />
          </button>
        </div>
      </div>

      {/* 主体：左侧变更文件列表 + 右侧 Diff 视图 */}
      <div className="flex-1 flex overflow-hidden">
        {modifiedFiles.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <Check size={28} className="text-[var(--ui-accent-emerald)] mb-2 opacity-70" />
            <div className="text-xs font-medium text-[var(--ui-text-primary)] mb-1">
              工作区干净，暂无未提交变更
            </div>
            <div className="text-[11px] text-[var(--ui-text-muted)]">
              当 Agent 或您修改代码后，此处会实时列出所有改动文件并提供可视对比。
            </div>
          </div>
        ) : (
          <>
            {/* 左侧改动文件栏 */}
            <div className="w-[195px] h-full border-r border-[color:var(--ui-divider-hairline)] bg-[var(--ui-panel-bg)] overflow-y-auto p-2 flex flex-col gap-1 custom-scrollbar flex-shrink-0">
              {modifiedFiles.map((file) => {
                const isSelected = selectedPath === file.path;
                const shortName = file.path.split("/").pop() || file.path;
                const badgeClass =
                  file.status === "A" || file.status === "U"
                    ? "text-[var(--ui-accent-emerald)] bg-[var(--ui-accent-emerald-soft)]"
                    : file.status === "D"
                    ? "text-[var(--ui-accent-rose)] bg-[var(--ui-accent-rose-soft)]"
                    : "text-[var(--ui-accent-amber)] bg-[var(--ui-accent-amber-soft)]";

                return (
                  <div
                    key={file.path}
                    onClick={() => setSelectedPath(file.path)}
                    className={`group flex items-center justify-between py-1.5 px-2.5 rounded-xl cursor-pointer transition-colors border ${
                      isSelected
                        ? "bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] border-[color:var(--ui-accent-amber-border)] font-medium"
                        : "bg-transparent border-transparent hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-primary)]"
                    }`}
                  >
                    <div className="flex flex-col min-w-0 flex-1 pr-1.5">
                      <span className="text-xs truncate">{shortName}</span>
                      <span className="text-[10px] text-[var(--ui-text-faint)] truncate">
                        {file.path}
                      </span>
                    </div>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-bold flex-shrink-0 ${badgeClass}`}
                    >
                      {file.status}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* 右侧代码 Diff 区域 */}
            <div className="flex-1 h-full flex flex-col overflow-hidden bg-[var(--ui-code-bg)] select-text">
              <div className="h-9 px-3 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex items-center justify-between flex-shrink-0 select-none">
                <span className="text-xs font-mono text-[var(--ui-text-primary)] truncate">
                  {selectedPath}
                </span>
                {selectedPath && (
                  <button
                    onClick={() => openFileInWorkbench(selectedPath)}
                    className="px-2 py-1 rounded-lg hover:bg-[var(--ui-block-hover-bg)] text-[11px] text-[var(--ui-text-muted)] hover:text-[var(--ui-accent-blue)] flex items-center gap-1 transition-colors"
                    title="在文件树中查看完整文件"
                  >
                    <ExternalLink size={11} />
                    <span>打开源文件</span>
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-auto font-mono text-[11.5px] leading-[1.6] custom-scrollbar">
                {loadingDiff ? (
                  <div className="p-8 text-center text-xs text-[var(--ui-text-faint)]">
                    正在计算 Git Diff...
                  </div>
                ) : diffData?.isBinary ? (
                  <div className="p-8 text-center text-xs text-[var(--ui-text-faint)]">
                    二进制文件变更，不支持文本行级对比。
                  </div>
                ) : diffMode === "unified" ? (
                  <div className="py-1">
                    {visibleDiffLines.map((line, idx) => {
                      const rowStyle =
                        line.type === "add"
                          ? "bg-[var(--ui-diff-add-bg)] text-[var(--ui-diff-add-text)]"
                          : line.type === "del"
                          ? "bg-[var(--ui-diff-del-bg)] text-[var(--ui-diff-del-text)]"
                          : "text-[var(--ui-text-primary)]";
                      const sign =
                        line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
                      return (
                        <div key={idx} className={`flex px-2 ${rowStyle}`}>
                          <span className="w-8 pr-1 text-right text-[10px] text-[var(--ui-text-faint)] select-none flex-shrink-0">
                            {line.oldLineNo ?? ""}
                          </span>
                          <span className="w-8 pr-2 text-right text-[10px] text-[var(--ui-text-faint)] select-none flex-shrink-0">
                            {line.newLineNo ?? ""}
                          </span>
                          <span className="w-4 select-none font-bold flex-shrink-0">
                            {sign}
                          </span>
                          <span className="whitespace-pre-wrap break-all flex-1">
                            {line.text || " "}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 ui-divide-hairline divide-x min-h-full">
                    {/* 左栏：旧版本 (HEAD) */}
                    <div className="py-1 overflow-x-auto">
                      <div className="px-2.5 py-1.5 text-[10px] font-sans font-semibold text-[var(--ui-accent-rose)] border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-accent-rose-soft)] select-none">
                        变更前 (HEAD)
                      </div>
                      {splitRows.map((row, idx) => {
                        const line = row.left;
                        return (
                          <div
                            key={`split-left-${idx}`}
                            className={`flex px-2 ${
                              line?.type === "del"
                                ? "bg-[var(--ui-diff-del-bg)] text-[var(--ui-diff-del-text)]"
                                : "text-[var(--ui-text-primary)]"
                            }`}
                          >
                            <span className="w-8 pr-2 text-right text-[10px] text-[var(--ui-text-faint)] select-none flex-shrink-0">
                              {line?.oldLineNo ?? ""}
                            </span>
                            <span className="w-3.5 select-none font-bold flex-shrink-0">
                              {line?.type === "del" ? "-" : " "}
                            </span>
                            <span className="whitespace-pre-wrap break-all flex-1">
                              {line?.text || " "}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {/* 右栏：新版本 (Working Tree) */}
                    <div className="py-1 overflow-x-auto">
                      <div className="px-2.5 py-1.5 text-[10px] font-sans font-semibold text-[var(--ui-accent-emerald)] border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-accent-emerald-soft)] select-none">
                        变更后 (当前工作区)
                      </div>
                      {splitRows.map((row, idx) => {
                        const line = row.right;
                        return (
                          <div
                            key={`split-right-${idx}`}
                            className={`flex px-2 ${
                              line?.type === "add"
                                ? "bg-[var(--ui-diff-add-bg)] text-[var(--ui-diff-add-text)]"
                                : "text-[var(--ui-text-primary)]"
                            }`}
                          >
                            <span className="w-8 pr-2 text-right text-[10px] text-[var(--ui-text-faint)] select-none flex-shrink-0">
                              {line?.newLineNo ?? ""}
                            </span>
                            <span className="w-3.5 select-none font-bold flex-shrink-0">
                              {line?.type === "add" ? "+" : " "}
                            </span>
                            <span className="whitespace-pre-wrap break-all flex-1">
                              {line?.text || " "}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* 底部真实 Git Commit 提交栏 */}
      <div className="p-2.5 border-t border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-header-bg)] flex flex-col gap-1.5 flex-shrink-0 select-none">
        {commitResult && (
          <div
            className={`px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-1.5 ${
              commitResult.ok
                ? "bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)]"
                : "bg-[var(--ui-accent-rose-soft)] text-[var(--ui-accent-rose)]"
            }`}
          >
            {commitResult.ok ? <Check size={12} /> : <AlertCircle size={12} />}
            <span className="truncate">{commitResult.text}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleCommit();
              }
            }}
            disabled={modifiedFiles.length === 0 || committing}
            placeholder={
              modifiedFiles.length === 0
                ? "暂无待提交的变更"
                : "输入 Git Commit 提交说明 (默认暂存全部改动 git add -A)..."
            }
            className="ui-focus-ring flex-1 h-8 px-3 rounded-xl bg-[var(--ui-input-bg)] border border-[color:var(--ui-border-hairline)] text-xs text-[var(--ui-text-primary)] placeholder-[var(--ui-text-faint)] outline-none transition-colors focus:bg-[var(--ui-input-hover-bg)] disabled:opacity-50"
          />
          <button
            onClick={handleCommit}
            disabled={modifiedFiles.length === 0 || !commitMsg.trim() || committing}
            className="h-8 px-3.5 rounded-xl bg-[var(--ui-accent-amber-soft)] hover:opacity-90 border border-[color:var(--ui-accent-amber-border)] disabled:opacity-40 text-[var(--ui-accent-amber)] text-xs font-medium flex items-center gap-1.5 transition-all flex-shrink-0 cursor-pointer"
          >
            {committing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <GitCommit size={12} />
            )}
            <span>提交全部变更</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default GitChangesView;
