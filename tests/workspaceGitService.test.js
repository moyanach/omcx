const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  getWorkspaceGitStatus,
  getWorkingTreeChanges,
  getWorkspaceBranches,
  getGitCommitGraph,
  getGitCommitDetail,
  commitWorkspaceChanges,
  checkoutWorkspaceBranch,
} = require("../services/workspaceGitService");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

test("workspaceGitService 在真实临时仓库上的状态/提交/分支/图谱流程", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-git-test-"));
  try {
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.email", "test@omcx.local");
    git(repoDir, "config", "user.name", "OMCX Tester");

    fs.writeFileSync(path.join(repoDir, "README.md"), "# Init\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "chore: initial commit");

    // 制造未提交修改
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Init\nUpdated line\n");
    fs.writeFileSync(path.join(repoDir, "new.txt"), "hello\n");

    const status = await getWorkspaceGitStatus(repoDir, { bypassCache: true });
    assert.equal(status.isGit, true);
    assert.equal(status.branch, "main");
    assert.ok(status.modifiedFiles.length >= 2);

    const wt = await getWorkingTreeChanges(repoDir);
    assert.ok(wt.unstaged.length >= 2);

    // 提交变更并创建 feature 分支
    const commitRes = await commitWorkspaceChanges(repoDir, "feat: add new.txt");
    assert.equal(commitRes.success, true);

    git(repoDir, "checkout", "-b", "feature/ui");
    const branches = await getWorkspaceBranches(repoDir);
    assert.equal(branches.currentBranch, "feature/ui");
    assert.ok(branches.branches.some((b) => b.name === "main"));

    const checkoutRes = await checkoutWorkspaceBranch(repoDir, "main", false);
    assert.equal(checkoutRes.success, true);

    const graph = await getGitCommitGraph(repoDir, { limit: 20 });
    assert.equal(graph.isGit, true);
    assert.ok(graph.commits.length >= 2);
    assert.equal(graph.commits[0].subject, "feat: add new.txt");

    const detail = await getGitCommitDetail(repoDir, graph.commits[0].hash);
    assert.equal(detail.ok, true);
    assert.match(detail.stat || "", /new\.txt/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
