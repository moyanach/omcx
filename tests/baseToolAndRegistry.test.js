const test = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");
const { StructuredTool } = require("../utils/tools/baseTool");
const { toolRegistry } = require("../utils/toolRegistry");

test("StructuredTool.call 校验参数并保留双下划线内部上下文", async () => {
  class EchoTool extends StructuredTool {
    constructor() {
      super();
      this.name = "echo_test";
      this.description = "回显测试工具";
      this.schema = z.object({
        message: z.string().min(1),
        count: z.number().int().optional(),
      });
    }
    async _call(args) {
      return JSON.stringify({
        success: true,
        message: args.message,
        workDir: args.__workDir,
      });
    }
  }

  const tool = new EchoTool();
  const okRes = JSON.parse(
    await tool.call({ message: "hello", __workDir: "/tmp/ws" })
  );
  assert.equal(okRes.success, true);
  assert.equal(okRes.message, "hello");
  assert.equal(okRes.workDir, "/tmp/ws");

  const badRes = JSON.parse(await tool.call({ message: "" }));
  assert.equal(badRes.success, false);
  assert.match(badRes.error, /参数校验失败 \(echo_test\)/);
});

test("toolRegistry 导出完整内置工具并按 plan 模式屏蔽写工具", () => {
  const allDefs = toolRegistry.getToolDefinitions();
  const allNames = new Set(allDefs.map((d) => d.function.name));

  assert.ok(allDefs.length >= 20, "至少应注册 20 个内置工具");
  for (const requiredName of ["read_file", "write_file", "edit_file", "run_command", "web_search", "web_fetch"]) {
    assert.ok(allNames.has(requiredName), `缺少内置工具: ${requiredName}`);
  }

  const planDefs = toolRegistry.getToolDefinitions([], null, {
    permissionMode: "plan",
  });
  const planNames = new Set(planDefs.map((d) => d.function.name));
  assert.ok(planNames.has("read_file"));
  assert.equal(planNames.has("write_file"), false);
  assert.equal(planNames.has("edit_file"), false);

  // Subagent 白名单不应允许未授权的 extraTools 旁路进入
  const whitelistDefs = toolRegistry.getToolDefinitions(
    [{ name: "mcp__srv__evil", description: "extra", parameters: { type: "object", properties: {} } }],
    new Set(["read_file"])
  );
  assert.deepEqual(
    whitelistDefs.map((d) => d.function.name),
    ["read_file"]
  );
});
