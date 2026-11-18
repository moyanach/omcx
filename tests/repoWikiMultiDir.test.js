const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoWikiService = require("../services/repoWikiService");
const { buildSystemContext } = require("../utils/contextBuilder");

function writeFakeWiki(dir, content) {
  const wikiDir = path.join(dir, ".omcx", "wiki");
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(path.join(wikiDir, "wiki.md"), content, "utf-8");
  fs.writeFileSync(
    path.join(wikiDir, "meta.json"),
    JSON.stringify({
      workDir: dir,
      generatedAt: Date.now(),
      fileCount: 12,
      symbolCount: 88,
    }),
    "utf-8"
  );
}

test("repoWikiService：多目录工作空间汇总受 12000 字符限制且主目录优先分配篇幅", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-multi-wiki-"));
  const dirPrimary = path.join(root, "app-core");
  const dirSecondaryA = path.join(root, "svc-auth");
  const dirSecondaryB = path.join(root, "svc-notify");
  fs.mkdirSync(dirPrimary, { recursive: true });
  fs.mkdirSync(dirSecondaryA, { recursive: true });
  fs.mkdirSync(dirSecondaryB, { recursive: true });

  try {
    writeFakeWiki(dirPrimary, "P".repeat(9500));
    writeFakeWiki(dirSecondaryA, "A".repeat(9500));
    writeFakeWiki(dirSecondaryB, "B".repeat(9500));

    const summary = repoWikiService.buildWorkspaceRepoWikiContext({
      workDirs: [dirSecondaryA, dirPrimary, dirSecondaryB],
      primaryWorkDir: dirPrimary,
    });

    assert.equal(summary.isMulti, true);
    assert.equal(summary.generatedCount, 3);
    assert.equal(summary.totalCount, 3);
    assert.ok(
      summary.text.length <= 12000,
      `汇总长度 ${summary.text.length} 不应超过 12000 字符`
    );

    const pCount = (summary.text.match(/P/g) || []).length;
    const aCount = (summary.text.match(/A/g) || []).length;
    const bCount = (summary.text.match(/B/g) || []).length;
    assert.ok(pCount >= 5500, `主目录应分得多数篇幅，实际 pCount=${pCount}`);
    assert.ok(pCount > aCount && pCount > bCount, `主目录(${pCount})应大于次级目录(${aCount}, ${bCount})`);
    assert.ok(summary.text.includes("### app-core（主目录）"));
    assert.ok(summary.text.includes("### svc-auth（次级目录）"));
    assert.ok(summary.text.includes("### svc-notify（次级目录）"));

    const built = buildSystemContext({
      workDir: dirPrimary,
      repoWiki: summary.text,
      repoWikiPath: summary.primaryPath,
      repoWikiIsMulti: summary.isMulti,
      agentMode: "code",
      enableTools: false,
      gitInfo: null,
    });
    assert.match(built.text, /【Repo Wiki（多目录工作空间架构文档摘要）】/);
    assert.ok(built.text.includes("app-core（主目录）"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repoWikiService：短次级目录未用完的预算自动回拨给主目录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-multi-wiki-reclaim-"));
  const dirPrimary = path.join(root, "main-repo");
  const dirSecondary = path.join(root, "tiny-lib");
  fs.mkdirSync(dirPrimary, { recursive: true });
  fs.mkdirSync(dirSecondary, { recursive: true });

  try {
    writeFakeWiki(dirPrimary, "M".repeat(10000));
    writeFakeWiki(dirSecondary, "T".repeat(300));

    const summary = repoWikiService.buildWorkspaceRepoWikiContext({
      workDirs: [dirPrimary, dirSecondary],
      primaryWorkDir: dirPrimary,
      maxTotalChars: 12000,
    });

    assert.ok(summary.text.length <= 12000);
    assert.ok(summary.text.includes("T".repeat(300)), "短次级目录应完整保留");
    assert.ok(summary.text.includes("M".repeat(9500)), "未用完预算应回拨给主目录");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
