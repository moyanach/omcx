import React from "react";
import { Tag } from "lucide-react";
import { LaidOutRow, ROW_HEIGHT } from "./graphLayout";

interface GraphCommitRowProps {
  row: LaidOutRow;
  isSelected: boolean;
  graphWidth: number;
  midY: number;
  laneX: (lane: number) => number;
  opBusy: string;
  workDir: string;
  onSelectCommit: (hash: string) => void;
  onSwitchBranch: (branch: string) => void;
}

export const GraphCommitRow: React.FC<GraphCommitRowProps> = React.memo(({
  row,
  isSelected,
  graphWidth,
  midY,
  laneX,
  opBusy,
  onSelectCommit,
  onSwitchBranch,
}) => {
  const { commit, lane, color, segments } = row;
  const hasHead = commit.refs.some((r) => r.isHead);
  const cx = laneX(lane);

  return (
              <div
                key={commit.hash}
                onClick={() => onSelectCommit(commit.hash)}
                style={{ height: ROW_HEIGHT }}
                className={`flex items-center px-2 cursor-pointer transition-colors group ${
                  isSelected
                    ? "bg-[var(--ui-accent-blue-soft)]"
                    : "hover:bg-[var(--ui-block-hover-bg)]"
                }`}
              >
                {/* SVG 泳道与连线 */}
                <svg width={graphWidth} height={ROW_HEIGHT} className="flex-shrink-0">
                  {segments.map((seg, idx) => {
                    const x1 = laneX(seg.fromLane);
                    const x2 = laneX(seg.toLane);
                    if (seg.kind === "in") {
                      if (x1 === x2) {
                        return (
                          <line
                            key={idx}
                            x1={x1}
                            y1={0}
                            x2={x2}
                            y2={midY}
                            stroke={seg.color}
                            strokeWidth={1.75}
                          />
                        );
                      }
                      return (
                        <path
                          key={idx}
                          d={`M ${x1} 0 C ${x1} ${midY * 0.65}, ${x2} ${midY * 0.35}, ${x2} ${midY}`}
                          fill="none"
                          stroke={seg.color}
                          strokeWidth={1.75}
                        />
                      );
                    }
                    // out
                    if (x1 === x2) {
                      return (
                        <line
                          key={idx}
                          x1={x1}
                          y1={midY}
                          x2={x2}
                          y2={ROW_HEIGHT}
                          stroke={seg.color}
                          strokeWidth={1.75}
                        />
                      );
                    }
                    return (
                      <path
                        key={idx}
                        d={`M ${x1} ${midY} C ${x1} ${midY + (ROW_HEIGHT - midY) * 0.65}, ${x2} ${midY + (ROW_HEIGHT - midY) * 0.35}, ${x2} ${ROW_HEIGHT}`}
                        fill="none"
                        stroke={seg.color}
                        strokeWidth={1.75}
                      />
                    );
                  })}

                  {/* 提交圆点 */}
                  {hasHead && (
                    <circle
                      cx={cx}
                      cy={midY}
                      r={6.2}
                      fill="none"
                      stroke={color}
                      strokeWidth={1.4}
                      opacity={0.75}
                    />
                  )}
                  <circle cx={cx} cy={midY} r={3.6} fill={color} />
                </svg>

                {/* 分支/远程/Tag 胶囊 + 提交信息 */}
                <div className="flex-1 min-w-0 flex items-center gap-1.5 pr-2">
                  {commit.refs.map((refItem, idx) => {
                    const isTag = refItem.kind === "tag";
                    const isCurrentHead = Boolean(refItem.isHead);
                    const checkoutTarget =
                      !isTag && !isCurrentHead && refItem.name && refItem.name !== "HEAD"
                        ? refItem.kind === "remote" && refItem.remote && refItem.name.startsWith(`${refItem.remote}/`)
                          ? refItem.name.slice(refItem.remote.length + 1)
                          : refItem.name
                        : "";
                    const canSwitchBranch = Boolean(checkoutTarget);

                    return (
                      <span
                        key={`${refItem.name}-${idx}`}
                        onDoubleClick={(e) => {
                          if (!canSwitchBranch || opBusy) return;
                          e.stopPropagation();
                          onSwitchBranch(checkoutTarget);
                        }}
                        title={canSwitchBranch ? `双击切换到分支 ${checkoutTarget}` : refItem.name}
                        className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full text-[10px] font-mono flex-shrink-0 border transition-colors ${
                          isCurrentHead
                            ? "bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] border-[color:var(--ui-accent-blue-border)] font-semibold"
                            : isTag
                            ? "bg-amber-500/10 text-[var(--ui-accent-amber)] border-amber-500/25"
                            : canSwitchBranch
                            ? "bg-[var(--ui-chip-bg)] text-[var(--ui-text-secondary)] border-[color:var(--ui-border-subtle)] cursor-pointer hover:border-[color:var(--ui-accent-blue-border)] hover:text-[var(--ui-text-primary)]"
                            : "bg-[var(--ui-chip-bg)] text-[var(--ui-text-secondary)] border-[color:var(--ui-border-subtle)]"
                        }`}
                      >
                        {isTag && <Tag size={9} />}
                        <span>{refItem.name}</span>
                        {refItem.hasOrigin && (
                          <span className="text-[9.5px] text-[var(--ui-text-muted)] border-l border-[color:var(--ui-border-subtle)] pl-1">
                            {refItem.remote || "origin"}
                          </span>
                        )}
                      </span>
                    );
                  })}

                  <span className="text-[11.5px] text-[var(--ui-text-primary)] truncate">
                    {commit.subject}
                  </span>
                </div>

                {/* 右侧元信息（悬停/常驻精简） */}
                <div className="flex items-center gap-2 text-[10px] font-mono text-[var(--ui-text-faint)] flex-shrink-0">
                  <span className="hidden sm:inline max-w-[76px] truncate">{commit.author}</span>
                  <span className="hidden md:inline">{commit.relativeTime}</span>
                  <span className="text-[var(--ui-text-muted)]">{commit.shortHash}</span>
                </div>
              </div>
  );
});
