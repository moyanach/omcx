/**
 * TerminalQueryResponder — 终端能力探测应答器
 *
 * 背景一：yazi / lazygit / btop 这类 TUI 启动前会向终端发送能力查询，
 * 收不到应答时会阻塞到超时（yazi 会打印 `Terminal response timeout`）。
 * xterm.js 目前只应答 OSC 11 / DA1 / DECRQSS，缺少单元格像素、窗口标题协议、
 * kitty 键盘/图形协议等查询，这里补上。
 *
 * 背景二（关键）：xterm 6.0.0 的 `requestMode`（处理 `CSI ? Ps $ p` / DECRQM）
 * 在其自带压缩产物里留下了 esbuild 二次压缩缺陷：
 *     (g=>...)(void 0||(i={}))   // i 从未声明 → ReferenceError
 * 只要程序查询任意一个终端模式，xterm 的解析器就会抛异常，整帧写不进去，
 * 表现为终端只剩一个光标、内容全黑。因此这里必须**拦截并代替终端应答**，
 * 不让该序列进入 xterm。
 */

export interface TerminalCellSize {
  width: number;
  height: number;
}

export interface TerminalScreenSize {
  cols: number;
  rows: number;
  widthPx: number;
  heightPx: number;
}

export interface TerminalQueryContext {
  getCellSize: () => TerminalCellSize;
  getScreenSize: () => TerminalScreenSize;
  version?: string;
}

export interface TerminalFeedResult {
  /** 应当写入 xterm 的字节（已剔除会触发 xterm 崩溃的序列） */
  data: string;
  /** 应当写回 PTY stdin 的应答 */
  replies: string;
}

interface QueryRule {
  pattern: RegExp;
  reply: (match: RegExpExecArray, context: TerminalQueryContext) => string;
}

const DEFAULT_VERSION = "2.1";

/** DECRQM 应答：0 未识别 / 1 已设置 / 2 已复位 / 3 永久设置 / 4 永久复位 */
const MODE_STATE = {
  NOT_RECOGNIZED: 0,
  SET: 1,
  RESET: 2,
  PERMANENTLY_SET: 3,
  PERMANENTLY_RESET: 4,
} as const;

/** 未被程序显式改过时的初始状态（与 xterm 的默认值对齐） */
const DEFAULT_PRIVATE_MODES: Record<number, number> = {
  1: MODE_STATE.RESET,
  6: MODE_STATE.RESET,
  7: MODE_STATE.SET,
  9: MODE_STATE.RESET,
  12: MODE_STATE.SET,
  25: MODE_STATE.SET,
  45: MODE_STATE.RESET,
  66: MODE_STATE.RESET,
  47: MODE_STATE.RESET,
  1047: MODE_STATE.RESET,
  1048: MODE_STATE.RESET,
  1049: MODE_STATE.RESET,
  1000: MODE_STATE.RESET,
  1002: MODE_STATE.RESET,
  1003: MODE_STATE.RESET,
  1004: MODE_STATE.RESET,
  1006: MODE_STATE.RESET,
  2004: MODE_STATE.RESET,
  2026: MODE_STATE.RESET,
};

/** 只读/永久模式，xterm 固定返回这些值 */
const FIXED_PRIVATE_MODES: Record<number, number> = {
  3: MODE_STATE.NOT_RECOGNIZED,
  8: MODE_STATE.PERMANENTLY_SET,
  20: MODE_STATE.RESET,
  67: MODE_STATE.PERMANENTLY_RESET,
  1005: MODE_STATE.PERMANENTLY_RESET,
  1015: MODE_STATE.PERMANENTLY_RESET,
  1016: MODE_STATE.RESET,
};

const QUERY_RULES: QueryRule[] = [
  // 单元格像素尺寸：CSI 6 ; height ; width t
  {
    pattern: /\x1b\[16t/g,
    reply: (_match, context) => {
      const cell = context.getCellSize();
      return `\x1b[6;${cell.height};${cell.width}t`;
    },
  },
  // 文本区像素尺寸：CSI 4 ; height ; width t
  {
    pattern: /\x1b\[14t/g,
    reply: (_match, context) => {
      const screen = context.getScreenSize();
      return `\x1b[4;${screen.heightPx};${screen.widthPx}t`;
    },
  },
  // 文本区字符尺寸：CSI 8 ; rows ; cols t
  {
    pattern: /\x1b\[18t/g,
    reply: (_match, context) => {
      const screen = context.getScreenSize();
      return `\x1b[8;${screen.rows};${screen.cols}t`;
    },
  },
  // 终端版本：DCS > | text ST
  {
    pattern: /\x1b\[>q/g,
    reply: (_match, context) => `\x1bP>|OMCX(${context.version || DEFAULT_VERSION})\x1b\\`,
  },
  // kitty 键盘协议：回 0 表示未启用任何增强标志
  {
    pattern: /\x1b\[\?u/g,
    reply: () => "\x1b[?0u",
  },
  // kitty 图形协议查询：带 a=q 的 APC，回 ENOTSUP 明确不支持
  {
    pattern: /\x1b_Gi=(\d+)[^\x1b]*a=q[^\x1b]*\x1b\\/g,
    reply: (match) => `\x1b_Gi=${match[1]};ENOTSUP\x1b\\`,
  },
];

/** DECRQM：CSI [ ? ] Ps $ p —— 会被拦截并代为应答 */
const DECRQM_RE = /\x1b\[(\?)?(\d{0,4})\$p/g;

/** 尾部未完成的 CSI（可能被 PTY 从中间切开），留到下一片再处理 */
const PARTIAL_CSI_TAIL_RE = /\x1b\[[?>]?[0-9;]*\$?$/;

/** DECSET / DECRST：CSI ? Ps h / l —— 只做状态跟踪，不改写数据 */
const DEC_MODE_RE = /\x1b\[\?([0-9;]+)([hl])/g;

export class TerminalQueryResponder {
  private pending = "";

  /** 程序显式设置过的私有模式（1 设置 / 2 复位） */
  private readonly privateModes = new Map<number, number>();

  private readonly context: TerminalQueryContext;

  constructor(context: TerminalQueryContext) {
    this.context = context;
  }

  /**
   * 消费一段 PTY 输出：
   * - 返回需要写入 xterm 的 data（已剔除会触发 xterm 解析器崩溃的 DECRQM）
   * - 返回需要写回 PTY 的 replies（终端能力应答）
   */
  feed(chunk: string): TerminalFeedResult {
    if (!chunk) return { data: "", replies: "" };

    let buffer = this.pending + chunk;
    let hold = "";

    // 把尾部可能被切断的 CSI 留到下一片，避免半条序列写进 xterm
    const tail = buffer.match(PARTIAL_CSI_TAIL_RE);
    if (tail && tail[0].length < 24) {
      hold = tail[0];
      buffer = buffer.slice(0, buffer.length - hold.length);
    }
    this.pending = hold;

    let replies = "";

    // 1. 跟踪 DECSET / DECRST，让 DECRQM 应答反映真实状态（原样放行）
    buffer.replace(DEC_MODE_RE, (_match, params: string, action: string) => {
      const state = action === "h" ? MODE_STATE.SET : MODE_STATE.RESET;
      for (const part of params.split(";")) {
        const mode = Number(part);
        if (Number.isFinite(mode)) this.privateModes.set(mode, state);
      }
      return _match;
    });

    // 2. 拦截 DECRQM 并代为应答（xterm 6.0.0 的 requestMode 会抛 ReferenceError）
    const data = buffer.replace(DECRQM_RE, (_match, privatePrefix: string, modeText: string) => {
      const mode = Number(modeText || 0);
      const state = this.resolveModeState(mode, Boolean(privatePrefix));
      replies += `\x1b[${privatePrefix ? "?" : ""}${mode};${state}$y`;
      return "";
    });

    // 3. 其余能力查询：只应答，不改写终端输出
    for (const rule of QUERY_RULES) {
      data.replace(rule.pattern, (...args: any[]) => {
        try {
          replies += rule.reply(args as unknown as RegExpExecArray, this.context);
        } catch {
          // 应答失败不影响终端正常输出
        }
        return "";
      });
    }

    return { data, replies };
  }

  reset() {
    this.pending = "";
    this.privateModes.clear();
  }

  private resolveModeState(mode: number, isPrivate: boolean): number {
    if (!isPrivate) {
      // ANSI 模式：只处理 xterm 支持的 insertMode(4) 与 convertEol(20)
      if (mode === 4) return MODE_STATE.RESET;
      if (mode === 20) return MODE_STATE.RESET;
      return MODE_STATE.NOT_RECOGNIZED;
    }
    const tracked = this.privateModes.get(mode);
    if (tracked !== undefined) return tracked;
    const fixed = FIXED_PRIVATE_MODES[mode];
    if (fixed !== undefined) return fixed;
    return DEFAULT_PRIVATE_MODES[mode] ?? MODE_STATE.NOT_RECOGNIZED;
  }
}

/** 从 xterm 实例换算单元格像素尺寸（用于响应 CSI 16 t） */
export function measureCellSize(term: {
  cols: number;
  rows: number;
  element?: HTMLElement;
}): TerminalCellSize {
  const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
  const rect = screen?.getBoundingClientRect();
  const cols = term.cols || 0;
  const rows = term.rows || 0;
  if (!rect || !cols || !rows || !rect.width || !rect.height) {
    return { width: 8, height: 16 };
  }
  return {
    width: Math.max(1, Math.round(rect.width / cols)),
    height: Math.max(1, Math.round(rect.height / rows)),
  };
}

/** 文本区尺寸（字符 + 像素），用于响应 CSI 14 t / CSI 18 t */
export function measureScreenSize(term: {
  cols: number;
  rows: number;
  element?: HTMLElement;
}): TerminalScreenSize {
  const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
  const rect = screen?.getBoundingClientRect();
  const cell = measureCellSize(term);
  return {
    cols: term.cols || 0,
    rows: term.rows || 0,
    widthPx: Math.round(rect?.width || (term.cols || 0) * cell.width),
    heightPx: Math.round(rect?.height || (term.rows || 0) * cell.height),
  };
}
