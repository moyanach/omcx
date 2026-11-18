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
  gitCreateBranchAt,
  gitPush,
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

test("gitCreateBranchAt 与 gitPush 处理异名上游错绑场景", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-git-push-test-"));
  const bareDir = path.join(rootDir, "remote.git");
  const repoDir = path.join(rootDir, "local");
  try {
    git(rootDir, "init", "--bare", "-b", "main", bareDir);
    git(rootDir, "clone", bareDir, repoDir);
    git(repoDir, "config", "user.email", "test@omcx.local");
    git(repoDir, "config", "user.name", "OMCX Tester");

    // 初始化 main 并推至远端
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Init\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "chore: init main");
    git(repoDir, "branch", "-M", "main");
    git(repoDir, "push", "-u", "origin", "main");
    const mainHead = git(repoDir, "rev-parse", "HEAD");

    // 1. 从 origin/main 创建新分支不应追踪 origin/main
    const createRes = await gitCreateBranchAt(repoDir, "feature/clean", "origin/main");
    assert.equal(createRes.success, true);
    assert.throws(() => git(repoDir, "rev-parse", "--abbrev-ref", "@{u}"));

    // 2. 人为制造历史遗留的异名追踪错绑：zhoushijie 错绑为 origin/main
    git(repoDir, "checkout", "-b", "zhoushijie", "origin/main");
    git(repoDir, "branch", "--set-upstream-to=origin/main", "zhoushijie");
    fs.writeFileSync(path.join(repoDir, "work.txt"), "feature change\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "feat: local work");

    // 触发推送：应自动推送到 origin/zhoushijie 并修正上游追踪，而不报错也不污染 origin/main
    const pushRes = await gitPush(repoDir);
    assert.equal(pushRes.success, true, pushRes.error);
    assert.match(pushRes.message || "", /origin\/zhoushijie/);
    assert.equal(git(repoDir, "rev-parse", "--abbrev-ref", "@{u}"), "origin/zhoushijie");
    assert.equal(git(bareDir, "rev-parse", "refs/heads/main"), mainHead);
    assert.equal(git(bareDir, "rev-parse", "refs/heads/zhoushijie"), git(repoDir, "rev-parse", "HEAD"));

    // 3. 修正上游后的后续再次提交推送正常走普通 push
    fs.writeFileSync(path.join(repoDir, "work.txt"), "feature change 2\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "feat: follow up");
    const pushRes2 = await gitPush(repoDir);
    assert.equal(pushRes2.success, true, pushRes2.error);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
