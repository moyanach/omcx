export interface GitRefBadge {
  name: string;
  remote?: string;
  kind: "head" | "local" | "remote" | "tag";
  isHead?: boolean;
  hasOrigin?: boolean;
}

export interface GitGraphCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  refs: GitRefBadge[];
  author: string;
  relativeTime: string;
  subject: string;
}

export interface CommitDetail {
  ok: boolean;
  hash?: string;
  shortHash?: string;
  author?: string;
  email?: string;
  date?: string;
  subject?: string;
  body?: string;
  stat?: string;
  error?: string;
}

export interface GraphSegment {
  fromLane: number;
  toLane: number;
  color: string;
  kind: "in" | "out";
}

export interface LaidOutRow {
  commit: GitGraphCommit;
  lane: number;
  color: string;
  activeLanesAfter: number;
  maxLaneCount: number;
  segments: GraphSegment[];
}

export const LANE_COLORS = [
  "#3b82f6", // 蓝
  "#10b981", // 绿
  "#a855f7", // 紫
  "#f59e0b", // 琥珀
  "#ec4899", // 粉
  "#06b6d4", // 青
  "#f97316", // 橙
  "#84cc16", // 黄绿
];

export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 14;
export const GRAPH_PAD_X = 12;

/**
 * 计算每个 commit 的泳道列号与连接线段（用于渲染多分支 Git Graph SVG）
 */
export function buildGraphLayout(commits: GitGraphCommit[]): LaidOutRow[] {
  let lanes: (string | null)[] = [];
  const laneColors = new Map<number, string>();
  let nextColorIdx = 0;

  const pickColor = (laneIdx: number) => {
    if (!laneColors.has(laneIdx)) {
      laneColors.set(laneIdx, LANE_COLORS[nextColorIdx % LANE_COLORS.length]);
      nextColorIdx += 1;
    }
    return laneColors.get(laneIdx)!;
  };

  const rows: LaidOutRow[] = [];

  for (const commit of commits) {
    const segments: GraphSegment[] = [];
    const beforeCount = lanes.length;

    // 1. 找到当前 commit 所属泳道（所有期望 hash === commit.hash 的泳道）
    const matchingLanes: number[] = [];
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] === commit.hash) matchingLanes.push(i);
    }

    let lane: number;
    if (matchingLanes.length > 0) {
      lane = matchingLanes[0];
    } else {
      const freeIdx = lanes.indexOf(null);
      lane = freeIdx >= 0 ? freeIdx : lanes.length;
      lanes[lane] = commit.hash;
      laneColors.set(lane, LANE_COLORS[nextColorIdx % LANE_COLORS.length]);
      nextColorIdx += 1;
    }

    const color = pickColor(lane);

    // 上半段连线：所有在上一行活跃且属于其它分支的泳道直连下来；匹配当前 commit 的多条泳道汇聚到当前节点
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] === null) continue;
      if (lanes[i] === commit.hash) {
        segments.push({ fromLane: i, toLane: lane, color: pickColor(i), kind: "in" });
      } else {
        segments.push({ fromLane: i, toLane: i, color: pickColor(i), kind: "in" });
      }
    }

    // 2. 清理合并进来的重复泳道
    for (let k = 1; k < matchingLanes.length; k += 1) {
      lanes[matchingLanes[k]] = null;
    }

    // 3. 把 parents 放到泳道中（第一个 parent 继承当前泳道，其余 parent 分配新泳道或复用已存在泳道）
    const parents = commit.parents || [];
    if (parents.length === 0) {
      lanes[lane] = null;
    } else {
      lanes[lane] = parents[0];
      segments.push({ fromLane: lane, toLane: lane, color, kind: "out" });

      for (let p = 1; p < parents.length; p += 1) {
        const parentHash = parents[p];
        const existingLane = lanes.indexOf(parentHash);
        let targetLane = existingLane;
        if (targetLane < 0) {
          const free = lanes.indexOf(null);
          targetLane = free >= 0 ? free : lanes.length;
          lanes[targetLane] = parentHash;
          laneColors.set(targetLane, LANE_COLORS[nextColorIdx % LANE_COLORS.length]);
          nextColorIdx += 1;
        }
        segments.push({
          fromLane: lane,
          toLane: targetLane,
          color: pickColor(targetLane),
          kind: "out",
        });
      }
    }

    // 其它未涉及的活跃泳道在下半段继续直连向下
    for (let i = 0; i < lanes.length; i += 1) {
      if (lanes[i] === null || i === lane) continue;
      const alreadyDrawn = segments.some(
        (s) => s.kind === "out" && s.toLane === i && s.fromLane === i
      );
      if (!alreadyDrawn) {
        segments.push({ fromLane: i, toLane: i, color: pickColor(i), kind: "out" });
      }
    }

    // 裁剪尾部空泳道
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    const maxLaneCount = Math.max(1, beforeCount, lanes.length, lane + 1);
    rows.push({
      commit,
      lane,
      color,
      activeLanesAfter: lanes.length,
      maxLaneCount,
      segments,
    });
  }

  return rows;
}

export interface WorkingTreeChanges {
  staged: Array<{ path: string; status: string }>;
  unstaged: Array<{ path: string; status: string }>;
  stashCount: number;
}
