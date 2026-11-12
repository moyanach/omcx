const { z } = require("zod");
const { StructuredTool } = require("@langchain/core/tools");
const browserAutomation = require("../../services/browserAutomationService");

const INTERACT_ACTIONS = [
  "click",
  "fill",
  "press",
  "hover",
  "scroll",
  "wait_for",
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

class BrowserInteractTool extends StructuredTool {
  constructor() {
    super();
    this.name = "browser_interact";
    this.description =
      "操作已打开的内置浏览器页面。action=click/fill/press/hover/scroll/wait_for；selector 使用 CSS 选择器。fill 会触发 input/change 事件以兼容 React 受控组件；press 默认 Enter，可触发表单提交。返回最新页面 URL、标题与正文摘要。";
    this.schema = z.object({
      action: z.enum(INTERACT_ACTIONS).describe("交互动作"),
      selector: z
        .string()
        .optional()
        .describe("CSS 选择器，例如 #search、button[type=submit]；wait_for 必填"),
      text: z.string().optional().describe("fill 动作要填入的文本"),
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
    });
  }

  async _call({ action, selector, text, key, amount, timeout_ms, __toolContext }) {
    if (String(__toolContext?.permissionMode || "").toLowerCase() === "plan") {
      return JSON.stringify({
        ok: false,
        error: "当前处于只读计划模式，禁止执行页面交互操作",
      });
    }
    try {
      const result = await browserAutomation.interact({
        action,
        selector,
        text,
        key,
        amount,
        timeout_ms,
      });
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
      "对已打开的内置浏览器页面截图（PNG），返回本地文件路径、dataUrl、页面正文摘要；传入 baseline 时会与同名基线做像素级视觉回归对比，返回差异比例与 diff 图路径。";
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
      // dataUrl 体积较大，工具结果中只保留路径，避免挤占上下文
      const { dataUrl, ...rest } = result;
      return JSON.stringify({ ...rest, hasPreview: Boolean(dataUrl) });
    } catch (err) {
      return JSON.stringify({ ok: false, error: err.message });
    }
  }
}

module.exports = {
  BrowserOpenTool,
  BrowserInteractTool,
  BrowserSnapshotTool,
};
