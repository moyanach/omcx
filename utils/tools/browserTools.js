const { z } = require("zod");
const { StructuredTool } = require("./baseTool");
const browserAutomation = require("../../services/browserAutomationService");

const INTERACT_ACTIONS = [
  "click",
  "fill",
  "select_option",
  "press",
  "hover",
  "scroll",
  "wait_for",
  "eval",
];

class BrowserOpenTool extends StructuredTool {
  constructor() {
    super();
    this.name = "browser_open";
    this.description =
      "在内置浏览器中打开一个 http/https 页面并返回标题、最终 URL 与正文摘要。用于访问文档、控制台、本地开发服务器等真实网页；打开后再用 browser_interact 操作页面、用 browser_snapshot 截图。";
    this.schema = z.object({
      url: z.string().describe("要打开的 http/https 地址，例如 https://example.com"),
    });
  }

  async _call({ url, __toolContext }) {
    try {
      const result = await browserAutomation.open({
        url,
        workDir: __toolContext?.workDir || null,
      });
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }
}

class BrowserInspectTool extends StructuredTool {
  constructor() {
    super();
    this.name = "browser_inspect";
    this.description =
      "探测当前内置浏览器页面的可交互元素（输入框、按钮、链接、下拉框等），返回带 ref 编号（如 e1、e2）、标签、类型、placeholder 与唯一 CSS 选择器的结构化清单，并附带控制台/网络错误数量。操作页面前建议先调用此工具避免盲猜选择器。";
    this.schema = z.object({
      max_elements: z
        .number()
        .int()
        .min(10)
        .max(150)
        .optional()
        .describe("最多返回的可交互元素数量，默认 80"),
    });
  }

  async _call({ max_elements }) {
    try {
      const result = await browserAutomation.inspect({
        maxElements: max_elements,
      });
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }
}

class BrowserInteractTool extends StructuredTool {
  constructor() {
    super();
    this.name = "browser_interact";
    this.description =
      "操作已打开的内置浏览器页面。支持 action=click/fill/select_option/press/hover/scroll/wait_for/eval；可通过 ref（browser_inspect 返回的 e1/e2）或 selector（CSS 选择器）定位元素。fill 兼容 React/Vue 受控组件与 contenteditable；select_option 用于 <select> 下拉框；eval 可执行页面检查 JS。";
    this.schema = z.object({
      action: z.enum(INTERACT_ACTIONS).describe("交互动作"),
      ref: z
        .string()
        .optional()
        .describe("browser_inspect 返回的元素编号，例如 e1、e2（优先于 selector）"),
      selector: z
        .string()
        .optional()
        .describe("CSS 选择器，例如 #search、button[type=submit]"),
      text: z.string().optional().describe("fill 动作要填入的文本"),
      value: z.string().optional().describe("select_option 动作要选中的选项值或文本"),
      key: z.string().optional().describe("press 动作的按键名，默认 Enter"),
      amount: z
        .number()
        .int()
        .min(-5000)
        .max(5000)
        .optional()
        .describe("scroll 动作的滚动像素，正数向下"),
      timeout_ms: z
        .number()
        .int()
        .min(500)
        .max(60000)
        .optional()
        .describe("wait_for 的最长等待时间，默认 8000ms"),
      script: z.string().optional().describe("eval 动作要在页面执行的 JS 代码片段"),
    });
  }

  async _call({ action, ref, selector, text, value, key, amount, timeout_ms, script, __toolContext }) {
    if (String(__toolContext?.permissionMode || "").toLowerCase() === "plan") {
      return JSON.stringify({
        ok: false,
        error: "当前处于只读计划模式，禁止执行页面交互操作",
      });
    }
    try {
      const result = await browserAutomation.interact({
        action,
        ref,
        selector,
        text,
        value,
        key,
        amount,
        timeout_ms,
        script,
      });
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }
}

class BrowserLogsTool extends StructuredTool {
  constructor() {
    super();
    this.name = "browser_logs";
    this.description =
      "获取当前内置浏览器捕获的页面 Console 警告/报错与失败的网络请求（HTTP >= 400 或请求异常），用于排查前端报错与接口异常。";
    this.schema = z.object({
      clear: z.boolean().optional().describe("读取后是否清空缓存日志，默认 false"),
    });
  }

  async _call({ clear }) {
    try {
      const result = browserAutomation.getLogs({ clear: Boolean(clear) });
      return JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }
}

class BrowserSnapshotTool extends StructuredTool {
  constructor() {
    super();
    this.name = "browser_snapshot";
    this.description =
      "对已打开的内置浏览器页面截图（PNG），返回本地文件路径、页面正文摘要；若主模型支持 Vision，将自动把画面注入多模态上下文供视觉检查；传入 baseline 时可做像素级视觉回归对比。";
    this.schema = z.object({
      full_page: z.boolean().optional().describe("是否截取完整页面高度，默认仅视口"),
      baseline: z
        .string()
        .optional()
        .describe("基线名称；提供后与该基线截图对比（无基线时先保存一次基线）"),
      threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("允许的差异像素比例阈值，默认 0.001"),
    });
  }

  async _call({ full_page, baseline, threshold, __toolContext }) {
    try {
      const result = await browserAutomation.snapshot({
        fullPage: Boolean(full_page),
        baseline: baseline || "",
        threshold,
        workDir: __toolContext?.workDir || null,
      });
      // dataUrl 体积较大，通过内部字段 __visionImageDataUrl 交由主进程按需注入 Vision 消息
      const { dataUrl, ...rest } = result;
      return JSON.stringify({
        ...rest,
        hasPreview: Boolean(dataUrl),
        __visionImageDataUrl: dataUrl || undefined,
      });
    } catch (err) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }
}

module.exports = {
  BrowserOpenTool,
  BrowserInspectTool,
  BrowserInteractTool,
  BrowserLogsTool,
  BrowserSnapshotTool,
};
