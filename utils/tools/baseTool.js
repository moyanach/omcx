/**
 * 轻量内置工具基类（替代 @langchain/core/tools 的 StructuredTool）
 *
 * 与 Zod schema + toolRegistry 的 _call / call 契约完全兼容，
 * 免除 @langchain/core 及其传递依赖的冷启动开销与打包体积。
 */
class StructuredTool {
  constructor() {
    this.name = "";
    this.description = "";
    this.schema = null;
  }

  /**
   * 兼容 StructuredTool.call() 调用契约
   * @param {Record<string, any>} input
   * @returns {Promise<string>}
   */
  async call(input) {
    if (this.schema && typeof this.schema.safeParse === "function") {
      // 保留内部注入的双下划线上下文字段（__workDir / __toolContext 等）不被 Zod strip 丢弃
      const internalEntries = {};
      const cleanInput = {};
      if (input && typeof input === "object") {
        for (const [key, val] of Object.entries(input)) {
          if (key.startsWith("__")) internalEntries[key] = val;
          else cleanInput[key] = val;
        }
      }
      const parsed = this.schema.safeParse(cleanInput);
      if (!parsed.success) {
        return JSON.stringify({
          success: false,
          error: `参数校验失败 (${this.name}): ${parsed.error?.message || "Invalid input"}`,
        });
      }
      return await this._call({ ...parsed.data, ...internalEntries });
    }
    return await this._call(input || {});
  }

  /**
   * 子类实现的工具执行体
   * @param {Record<string, any>} _args
   * @returns {Promise<string>}
   */
  async _call(_args) {
    throw new Error(`${this.name || "StructuredTool"} 未实现 _call()`);
  }
}

module.exports = { StructuredTool };
