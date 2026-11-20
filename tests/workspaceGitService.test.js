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
  gitMergeBranch,
  gitPush,
} = require("../services/workspaceGitService");
const {
  inspectGitDirectories,
  createMultiWorktrees,
} = require("../services/gitWorktreeService");

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

test("gitMergeBranch 默认允许 Fast-Forward 保持多分支在同一水平线，并支持显式 noFf", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-git-merge-test-"));
  try {
    git(repoDir, "init", "-b", "release");
    git(repoDir, "config", "user.email", "test@omcx.local");
    git(repoDir, "config", "user.name", "OMCX Tester");

    fs.writeFileSync(path.join(repoDir, "app.txt"), "v1\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "chore: base");

    git(repoDir, "checkout", "-b", "develop");
    git(repoDir, "checkout", "-b", "feature");
    fs.writeFileSync(path.join(repoDir, "app.txt"), "v2\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "feat: update in feature");
    const featureHead = git(repoDir, "rev-parse", "HEAD");

    // 1. develop 默认合并 feature -> Fast-Forward 到同一提交
    await checkoutWorkspaceBranch(repoDir, "develop");
    const mergeDev = await gitMergeBranch(repoDir, "feature");
    assert.equal(mergeDev.success, true, mergeDev.error);
    assert.equal(mergeDev.fastForward, true);
    assert.equal(git(repoDir, "rev-parse", "develop"), featureHead);

    // 2. release 默认合并 develop -> 三分支位于同一 Commit（同一水平线）
    await checkoutWorkspaceBranch(repoDir, "release");
    const mergeRel = await gitMergeBranch(repoDir, "develop");
    assert.equal(mergeRel.success, true, mergeRel.error);
    assert.equal(mergeRel.fastForward, true);
    assert.equal(git(repoDir, "rev-parse", "release"), featureHead);

    // 3. 显式传入 { noFf: true } 时创建双父节点的合并提交
    git(repoDir, "checkout", "feature");
    fs.writeFileSync(path.join(repoDir, "app.txt"), "v3\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "feat: next change");
    await checkoutWorkspaceBranch(repoDir, "develop");
    const mergeNoFf = await gitMergeBranch(repoDir, "feature", { noFf: true });
    assert.equal(mergeNoFf.success, true, mergeNoFf.error);
    assert.equal(mergeNoFf.fastForward, false);
    const parents = git(repoDir, "rev-list", "--parents", "-n", "1", "HEAD").split(/\s+/);
    assert.equal(parents.length, 3);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("gitWorktreeService 多目录检测分支与按目录独立 base 创建 Worktree", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-multi-wt-test-"));
  const prevHome = process.env.OMCX_HOME;
  process.env.OMCX_HOME = path.join(rootDir, "omcx-home");
  try {
    const repoA = path.join(rootDir, "service-a");
    const repoB = path.join(rootDir, "service-b");
    const nonGit = path.join(rootDir, "docs");
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    fs.mkdirSync(nonGit, { recursive: true });

    // 初始化 repoA：main + dev-a（带独特提交）
    git(repoA, "init", "-b", "main");
    git(repoA, "config", "user.email", "test@omcx.local");
    git(repoA, "config", "user.name", "OMCX Tester");
    fs.writeFileSync(path.join(repoA, "a.txt"), "main-a\n");
    git(repoA, "add", ".");
    git(repoA, "commit", "-m", "init a");
    git(repoA, "checkout", "-b", "dev-a");
    fs.writeFileSync(path.join(repoA, "a.txt"), "dev-a-content\n");
    git(repoA, "add", ".");
    git(repoA, "commit", "-m", "feat a on dev-a");
    const devAHead = git(repoA, "rev-parse", "HEAD");
    git(repoA, "checkout", "main");

    // 初始化 repoB：main + release-b（带独特提交）
    git(repoB, "init", "-b", "main");
    git(repoB, "config", "user.email", "test@omcx.local");
    git(repoB, "config", "user.name", "OMCX Tester");
    fs.writeFileSync(path.join(repoB, "b.txt"), "main-b\n");
    git(repoB, "add", ".");
    git(repoB, "commit", "-m", "init b");
    git(repoB, "checkout", "-b", "release-b");
    fs.writeFileSync(path.join(repoB, "b.txt"), "release-b-content\n");
    git(repoB, "add", ".");
    git(repoB, "commit", "-m", "feat b on release-b");
    const releaseBHead = git(repoB, "rev-parse", "HEAD");
    git(repoB, "checkout", "main");

    // 1. inspectGitDirectories 应同时返回各目录的 currentBranch 与全量 branches
    const inspectRes = await inspectGitDirectories([
      { path: repoA, name: "service-a", isPrimary: true },
      { path: repoB, name: "service-b", isPrimary: false },
      { path: nonGit, name: "docs", isPrimary: false },
    ]);
    assert.equal(inspectRes.success, true);
    assert.equal(inspectRes.folders.length, 3);
    assert.equal(inspectRes.folders[0].isGit, true);
    assert.equal(inspectRes.folders[0].currentBranch, "main");
    assert.deepEqual(inspectRes.folders[0].branches.sort(), ["dev-a", "main"]);
    assert.equal(inspectRes.folders[1].isGit, true);
    assert.deepEqual(inspectRes.folders[1].branches.sort(), ["main", "release-b"]);
    assert.equal(inspectRes.folders[2].isGit, false);

    // 2. createMultiWorktrees 支持每个目录使用各自独立的 base 分支
    const createRes = await createMultiWorktrees({
      folders: [
        { path: repoA, name: "service-a", isPrimary: true, base: "dev-a" },
        { path: repoB, name: "service-b", isPrimary: false, base: "release-b" },
      ],
      branch: "feat/multi-base-test",
    });
    assert.equal(createRes.success, true, createRes.error);
    assert.equal(createRes.items.length, 2);

    const wtA = createRes.items.find((i) => i.name === "service-a");
    const wtB = createRes.items.find((i) => i.name === "service-b");
    assert.equal(wtA.sourceBranch, "dev-a");
    assert.equal(wtB.sourceBranch, "release-b");
    assert.equal(git(wtA.worktreePath, "rev-parse", "HEAD"), devAHead);
    assert.equal(git(wtB.worktreePath, "rev-parse", "HEAD"), releaseBHead);
  } finally {
    if (prevHome === undefined) delete process.env.OMCX_HOME;
    else process.env.OMCX_HOME = prevHome;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
