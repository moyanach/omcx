const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMcpStorage, writeFileAtomicSync } = require("../services/storage/mcpStorage");
const { createSkillsMemoryStorage } = require("../services/storage/skillsMemoryStorage");

test("mcpStorage 原子写入、项目级 MCP 信任隔离与保存", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-mcp-test-"));
  const workDir = path.join(tmpDir, "proj");
  const globalMcpFile = path.join(tmpDir, "global", "mcp.json");
  const configMap = new Map();

  try {
    writeFileAtomicSync(
      path.join(workDir, ".omcx", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          localSrv: { command: "node", args: ["server.js"], enabled: true },
        },
      }),
      (d) => fs.mkdirSync(d, { recursive: true })
    );

    const mcp = createMcpStorage({
      getConfig: (k) => (configMap.has(k) ? configMap.get(k) : null),
      setConfig: (k, v) => configMap.set(k, v),
      getPaths: () => ({ MCP_FILE: globalMcpFile }),
      ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    });

    // 未授信时项目级 MCP 应标记 requiresTrust=true 且 trusted=false
    const untrustedList = mcp.getMcpServers(workDir);
    assert.equal(untrustedList.length, 1);
    assert.equal(untrustedList[0].trusted, false);
    assert.equal(untrustedList[0].requiresTrust, true);

    // 显式授信后 requiresTrust 归零、trusted 变为 true
    mcp.setProjectMcpTrust(workDir, true);
    const trustedList = mcp.getMcpServers(workDir);
    assert.equal(trustedList[0].trusted, true);
    assert.equal(trustedList[0].requiresTrust, false);

    // 保存与删除全局 MCP Server
    mcp.saveGlobalMcpServers({
      globalOne: { command: "npx", args: ["-y", "demo"], enabled: true },
    });
    const merged = mcp.getMcpServers(workDir);
    assert.ok(merged.some((s) => s.id === "globalOne" && s.source === "global"));

    const delRes = mcp.deleteGlobalMcpServer("globalOne");
    assert.equal(delRes.success, true);
    assert.equal(mcp.getMcpServers(workDir).some((s) => s.id === "globalOne"), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("skillsMemoryStorage 扫描 Frontmatter 技能与启停/记忆读取", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-skill-test-"));
  const skillsDir = path.join(tmpDir, ".omcx", "skills");
  const memoryDir = path.join(tmpDir, "memory");
  const configMap = new Map();

  try {
    fs.mkdirSync(path.join(skillsDir, "my-skill"), { recursive: true });
    fs.mkdirSync(memoryDir, { recursive: true });

    fs.writeFileSync(
      path.join(skillsDir, "my-skill", "SKILL.md"),
      `---\nname: my-skill\ndescription: 自动化测试技能\nversion: 1.2.0\ntools: [read_file, search_code]\n---\n请先阅读 README 再修改代码。\n`
    );
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# Index\n");
    fs.writeFileSync(path.join(memoryDir, "prefs.md"), "# User Pref\nPrefer Chinese\n");

    const sm = createSkillsMemoryStorage({
      USER_HOME: tmpDir,
      getConfig: (k) => (configMap.has(k) ? configMap.get(k) : null),
      setConfig: (k, v) => configMap.set(k, v),
      getPaths: () => ({ MEMORY_DIR: memoryDir }),
      ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    });

    const skills = sm.getSkills();
    const hit = skills.find((s) => s.name === "my-skill");
    assert.ok(hit, "应扫描到 my-skill");
    assert.equal(hit.description, "自动化测试技能");
    assert.equal(hit.version, "1.2.0");
    assert.deepEqual(hit.tools, ["read_file", "search_code"]);
    assert.equal(hit.enabled, true);

    sm.setSkillEnabled("my-skill", false);
    assert.equal(sm.getSkills().some((s) => s.name === "my-skill"), false);
    const disabledItem = sm.getSkills(null, { includeDisabled: true }).find((s) => s.name === "my-skill");
    assert.equal(disabledItem?.enabled, false);

    const memories = sm.getMemories();
    assert.ok(memories.some((m) => m.name === "prefs" && m.content.includes("Prefer Chinese")));
    const indexes = sm.getMemoryIndex();
    assert.ok(indexes.some((idx) => idx.scope === "global" && idx.content.includes("# Index")));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
