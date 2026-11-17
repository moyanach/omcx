const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const documentService = require("../services/documentService");
const { toolRegistry } = require("../utils/toolRegistry");
const { createMcpStorage } = require("../services/storage/mcpStorage");

test("documentService 支持生成并解析 DOCX（含大纲/检索/预览及 ReadFileTool 自动委托）", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-doc-docx-"));
  try {
    const outPath = path.join(tmpDir, "report.docx");
    const genRes = await documentService.generateDocument(outPath, {
      title: "季度业务复盘报告",
      subtitle: "2026 Q3",
      blocks: [
        { type: "heading", level: 1, text: "一、核心指标达成" },
        { type: "paragraph", text: "本季度重点推进 **Work 办公协同** 能力落地，整体效率提升明显。" },
        { type: "bullet_list", items: ["文档解析准确率 99%", "支持一键导出 PDF"] },
        {
          type: "table",
          headers: ["项目", "目标", "实际"],
          rows: [["文档工具", "100%", "100%"], ["连接器模板", "8个", "11个"]],
        },
      ],
    });
    assert.equal(genRes.format, "docx");
    assert.ok(fs.existsSync(outPath));

    const outline = await documentService.readDocument(outPath, { mode: "outline" });
    assert.equal(outline.format, "docx");
    assert.ok(outline.headings.some((h) => h.includes("核心指标达成")));

    const searched = await documentService.readDocument(outPath, {
      mode: "search",
      query: "连接器模板",
    });
    assert.ok(searched.matchCount >= 1);

    const preview = await documentService.previewDocumentForWorkbench(outPath);
    assert.equal(preview.kind, "docx");
    assert.ok(preview.html.includes("季度业务复盘报告"));
    assert.ok(!preview.html.includes("<script"));

    // 通过 ReadFileTool 读取 .docx 时自动委托给 read_document，不会输出二进制乱码
    const readToolRes = await toolRegistry.execute(
      "read_file",
      { path: "report.docx" },
      { workDir: tmpDir, allowedFolders: [tmpDir], permissionMode: "auto-sandbox" }
    );
    assert.equal(readToolRes.success, true);
    assert.equal(readToolRes.data.delegatedTo, "read_document");
    assert.ok(readToolRes.data.content.includes("Work 办公协同"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("documentService 支持生成并解析多 Sheet XLSX 与 工作台结构化预览", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-doc-xlsx-"));
  try {
    const outPath = path.join(tmpDir, "metrics.xlsx");
    const genRes = await documentService.generateDocument(outPath, {
      sheets: [
        {
          name: "销售明细",
          headers: ["区域", "销售额", "完成率"],
          rows: [
            ["华东", 128000, "112%"],
            ["华南", 96000, "98%"],
          ],
        },
        {
          name: "渠道汇总",
          headers: ["渠道", "线索数"],
          rows: [["飞书生态", 420], ["官网自然流量", 680]],
        },
      ],
    });
    assert.equal(genRes.format, "xlsx");
    assert.equal(genRes.sheets.length, 2);

    const outline = await documentService.readDocument(outPath, { mode: "outline" });
    assert.equal(outline.sheetCount, 2);
    assert.equal(outline.sheets[0].name, "销售明细");

    const sheet2 = await documentService.readDocument(outPath, {
      mode: "read",
      sheet: "渠道汇总",
    });
    assert.equal(sheet2.sheet, "渠道汇总");
    assert.ok(sheet2.content.includes("飞书生态"));

    const searchRes = await documentService.readDocument(outPath, {
      mode: "search",
      query: "华东",
    });
    assert.equal(searchRes.matchCount, 1);

    const preview = await documentService.previewDocumentForWorkbench(outPath);
    assert.equal(preview.kind, "spreadsheet");
    assert.equal(preview.sheets.length, 2);
    assert.deepEqual(preview.sheets[0].headers, ["区域", "销售额", "完成率"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("documentService 支持生成并解析 PPTX（含演讲者备注）", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-doc-pptx-"));
  try {
    const outPath = path.join(tmpDir, "deck.pptx");
    const genRes = await documentService.generateDocument(outPath, {
      title: "Work 能力演进汇报",
      subtitle: "第二阶段成果演示",
      theme: "blue",
      slides: [
        {
          title: "核心能力突破",
          bullets: ["纯 JS 解析 PDF/DOCX/XLSX/PPTX", "一键对接飞书/钉钉/企业微信"],
          notes: "重点强调无需 Python 环境依赖",
        },
        {
          title: "数据对比",
          table: {
            headers: ["能力", "状态"],
            rows: [["文档读写", "已上线"], ["PDF导出", "已上线"]],
          },
        },
      ],
    });
    assert.equal(genRes.format, "pptx");
    assert.equal(genRes.slideCount, 3);

    const outline = await documentService.readDocument(outPath, { mode: "outline" });
    assert.equal(outline.format, "pptx");
    assert.equal(outline.slideCount, 3);

    const contentRes = await documentService.readDocument(outPath, {
      mode: "read",
      startPage: 2,
      endPage: 3,
    });
    assert.ok(contentRes.content.includes("纯 JS 解析"));
    assert.ok(contentRes.content.includes("无需 Python 环境依赖"));

    const preview = await documentService.previewDocumentForWorkbench(outPath);
    assert.equal(preview.kind, "presentation");
    assert.equal(preview.slides.length, 3);
    assert.equal(preview.slides[1].notes, "重点强调无需 Python 环境依赖");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("toolRegistry 正确暴露 read_document 与 generate_document 的权限和模式过滤", () => {
  assert.ok(toolRegistry.has("read_document"));
  assert.ok(toolRegistry.has("generate_document"));

  const planTools = toolRegistry
    .getToolDefinitions([], null, { permissionMode: "plan" })
    .map((t) => t.function.name);
  assert.ok(planTools.includes("read_document"));
  assert.ok(!planTools.includes("generate_document"));

  const workTools = toolRegistry
    .getToolDefinitions([], null, { permissionMode: "auto-sandbox", agentMode: "work" })
    .map((t) => t.function.name);
  assert.ok(workTools.includes("read_document"));
  assert.ok(workTools.includes("generate_document"));
  assert.ok(!workTools.includes("repo_map"));
});

test("mcpStorage.upsertGlobalMcpServer 增量新增连接器并保留既有服务器与敏感 env", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-mcp-upsert-"));
  const mcpFile = path.join(tmpDir, "mcp.json");
  try {
    const cfg = {};
    const storage = createMcpStorage({
      getConfig: (k) => cfg[k],
      setConfig: (k, v) => {
        cfg[k] = v;
      },
      getPaths: () => ({ MCP_FILE: mcpFile }),
      ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    });

    const r1 = storage.upsertGlobalMcpServer("feishu", {
      command: "npx",
      args: ["-y", "@larksuiteoapi/lark-mcp", "mcp"],
      env: { SECRET_TOKEN: "sec_12345" },
      description: "飞书连接器",
    });
    assert.equal(r1.success, true);

    const r2 = storage.upsertGlobalMcpServer("dingtalk", {
      url: "https://mcp-gw.dingtalk.com/sse",
      transport: "sse",
      description: "钉钉连接器",
    });
    assert.equal(r2.success, true);

    // 再次编辑 feishu 但不重填 SECRET_TOKEN 时，原有 env 应完整保留
    const r3 = storage.upsertGlobalMcpServer("feishu", {
      command: "npx",
      args: ["-y", "@larksuiteoapi/lark-mcp", "mcp"],
      env: { SECRET_TOKEN: "" },
      description: "飞书连接器 v2",
    });
    assert.equal(r3.success, true);

    const servers = storage.getMcpServers(null);
    assert.equal(servers.length, 2);
    const feishu = servers.find((s) => s.id === "feishu");
    const dingtalk = servers.find((s) => s.id === "dingtalk");
    assert.equal(feishu.env.SECRET_TOKEN, "sec_12345");
    assert.equal(feishu.description, "飞书连接器 v2");
    assert.equal(dingtalk.transport, "sse");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("toolRegistry.execute('generate_document') 走真实文件锁生成 PPTX 且失败正确透传 success=false", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-gen-tool-"));
  try {
    const pptxRes = await toolRegistry.execute(
      "generate_document",
      {
        path: "summary.pptx",
        title: "告警治理总结",
        slides: [
          { title: "核心结论", bullets: ["已修复 fileLockService.withLock 报错", "支持直接聚合统计"] },
        ],
      },
      { workDir: tmpDir, allowedFolders: [tmpDir], permissionMode: "auto-sandbox" }
    );
    assert.equal(pptxRes.success, true);
    assert.equal(pptxRes.data.success, true);
    assert.equal(pptxRes.data.format, "pptx");
    assert.ok(fs.existsSync(path.join(tmpDir, "summary.pptx")));

    const failRes = await toolRegistry.execute(
      "generate_document",
      { path: "bad.txt", title: "无效格式" },
      { workDir: tmpDir, allowedFolders: [tmpDir], permissionMode: "auto-sandbox" }
    );
    assert.equal(failRes.success, false);
    assert.ok(failRes.error && failRes.error.includes("不受支持"));
    assert.equal(failRes.data.success, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("read_document aggregate 模式支持大表精确过滤、多维分组汇总、中位数与全列画像", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-doc-agg-"));
  try {
    const xlsxPath = path.join(tmpDir, "alarms.xlsx");
    const rows = [];
    for (let i = 0; i < 600; i += 1) {
      const biz = i % 3 === 0 ? "支付中心" : i % 3 === 1 ? "订单平台" : "基础架构";
      const level = i % 5 === 0 ? "P0" : i % 2 === 0 ? "P1" : "P2";
      const sends = (i % 10) + 1;
      const rule = `rule_${i % 4}`;
      rows.push([`ev_${i}`, biz, level, rule, sends, i % 4 === 0 ? "是" : "否"]);
    }
    await documentService.generateDocument(xlsxPath, {
      sheets: [
        {
          name: "未去重原始事件",
          headers: ["事件ID", "业务线", "级别", "规则", "发送轮次", "是否静默"],
          rows,
        },
      ],
    });

    const profileRes = await toolRegistry.execute(
      "read_document",
      { path: "alarms.xlsx", mode: "aggregate", sheet: "未去重原始事件" },
      { workDir: tmpDir, allowedFolders: [tmpDir], permissionMode: "auto-sandbox" }
    );
    assert.equal(profileRes.success, true);
    assert.equal(profileRes.data.kind, "column_profile");
    assert.equal(profileRes.data.totalDataRows, 600);
    assert.equal(profileRes.data.matchedRows, 600);
    const sendProfile = profileRes.data.columnProfiles.find((c) => c.column === "发送轮次");
    assert.equal(sendProfile.numericStats.sum, 3300);
    assert.equal(sendProfile.numericStats.median, 5.5);

    const groupedRes = await toolRegistry.execute(
      "read_document",
      {
        path: "alarms.xlsx",
        mode: "aggregate",
        sheet: "未去重原始事件",
        where: [{ column: "是否静默", op: "eq", value: "否" }],
        groupBy: ["业务线", "级别"],
        metrics: [
          { op: "count", as: "事件数" },
          { op: "count_distinct", column: "规则", as: "命中规则数" },
          { op: "sum", column: "发送轮次", as: "总发送轮次" },
          { op: "median", column: "发送轮次", as: "中位轮次" },
        ],
        sortBy: "总发送轮次",
        sortOrder: "desc",
      },
      { workDir: tmpDir, allowedFolders: [tmpDir], permissionMode: "auto-sandbox" }
    );
    assert.equal(groupedRes.success, true);
    assert.equal(groupedRes.data.kind, "grouped_summary");
    assert.equal(groupedRes.data.matchedRows, 450);
    assert.ok(groupedRes.data.groups.length > 0);
    const totalEvents = groupedRes.data.groups.reduce((s, g) => s + g["事件数"], 0);
    assert.equal(totalEvents, 450);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
