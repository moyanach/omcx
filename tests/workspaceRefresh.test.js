const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fileIndexer = require("../utils/tools/fileIndexer");
const repoIndexService = require("../services/repoIndexService");
const workspaceRefreshService = require("../services/workspaceRefreshService");

test("fileIndexer.clearFileIndexCache 主动失效后能立即检索到新建文件", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-idx-refresh-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "first.js"), "export const a = 1;\n", "utf-8");
    const initial = await fileIndexer.listWorkspaceFilesAsync(tmpDir, [tmpDir]);
    assert.equal(
      initial.files.some((f) => f.path === "first.js"),
      true
    );

    // 30s TTL 期间直接新建文件，未失效缓存时命中旧缓存；主动失效后必须立刻出现
    fs.writeFileSync(path.join(tmpDir, "second.js"), "export const b = 2;\n", "utf-8");
    const stale = await fileIndexer.listWorkspaceFilesAsync(tmpDir, [tmpDir]);
    assert.equal(
      stale.files.some((f) => f.path === "second.js"),
      false
    );

    fileIndexer.clearFileIndexCache(tmpDir);
    const refreshed = await fileIndexer.listWorkspaceFilesAsync(tmpDir, [tmpDir]);
    assert.equal(
      refreshed.files.some((f) => f.path === "second.js"),
      true,
      "失效缓存后应立即扫描到新建文件"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("repoIndexService.invalidateRepoIndex 失效内存与磁盘缓存后可索引新符号", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-repo-refresh-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "alpha.js"),
      "function alphaSymbol() { return 1; }\nmodule.exports = { alphaSymbol };\n",
      "utf-8"
    );

    const first = await repoIndexService.searchSymbolsAsync(tmpDir, "alphaSymbol");
    assert.equal(first.some((s) => s.name === "alphaSymbol"), true);

    fs.writeFileSync(
      path.join(tmpDir, "beta.js"),
      "function betaFreshSymbol() { return 2; }\nmodule.exports = { betaFreshSymbol };\n",
      "utf-8"
    );

    // 触发统一刷新服务失效全部缓存
    workspaceRefreshService.invalidateWorkspaceCaches(tmpDir);

    const second = await repoIndexService.searchSymbolsAsync(tmpDir, "betaFreshSymbol");
    assert.equal(
      second.some((s) => s.name === "betaFreshSymbol"),
      true,
      "invalidateWorkspaceCaches 后应能检索到新文件内符号"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("workspaceRefreshService 过滤噪声路径、推断领域并支持事件广播与监听防抖", async () => {
  assert.equal(workspaceRefreshService.shouldIgnoreWatchFilename(".git/index"), true);
  assert.equal(workspaceRefreshService.shouldIgnoreWatchFilename("node_modules/pkg/index.js"), true);
  assert.equal(workspaceRefreshService.shouldIgnoreWatchFilename(".omcx/index/abc.json"), true);
  assert.equal(workspaceRefreshService.shouldIgnoreWatchFilename(".DS_Store"), true);
  assert.equal(workspaceRefreshService.shouldIgnoreWatchFilename(".omcx/specs/test.md"), false);
  assert.equal(workspaceRefreshService.shouldIgnoreWatchFilename("src/pages/NewFile.tsx"), false);

  const areas = workspaceRefreshService.inferAreasFromPaths([
    ".omcx/specs/demo.md",
    ".omcx/commands/deploy.md",
    ".agents/skills/my-skill/SKILL.md",
    ".omcx/agents/custom.md",
  ]);
  assert.equal(areas.includes("files"), true);
  assert.equal(areas.includes("git"), true);
  assert.equal(areas.includes("specs"), true);
  assert.equal(areas.includes("commands"), true);
  assert.equal(areas.includes("skills"), true);
  assert.equal(areas.includes("subagents"), true);

  const received = [];
  const unsub = workspaceRefreshService.subscribeWorkspaceChanged((evt) => received.push(evt));
  try {
    workspaceRefreshService.emitWorkspaceChanged({
      workDir: "/tmp/test-project",
      reason: "tool_write",
      areas: ["files", "git"],
      paths: [".omcx/specs/new.md"],
    });
    assert.equal(received.length, 1);
    assert.equal(received[0].reason, "tool_write");
    assert.equal(received[0].areas.includes("specs"), true);
  } finally {
    unsub();
  }
});
