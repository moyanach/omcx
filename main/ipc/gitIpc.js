const { ipcMain } = require("electron");
const {
  safeHandler,
  getWorkspaceGitService,
  getGitHunkService,
  getGitWorktreeService,
  getWorkspaceRefreshService,
} = require("../shared");

function notifyGitMutation(workDir, res, { invalidateFiles = false, areas = ["git"] } = {}) {
  if (res && res.success === false) return res;
  getWorkspaceRefreshService().emitWorkspaceChanged({
    workDir: workDir || null,
    reason: "git_action",
    areas,
    invalidate: invalidateFiles,
  });
  return res;
}

function registerGitIpc() {
  ipcMain.handle(
    "get-workspace-git-status",
    safeHandler((event, workDir) => getWorkspaceGitService().getWorkspaceGitStatus(workDir))
  );

  ipcMain.handle(
    "get-workspace-git-graph",
    safeHandler((event, { workDir, limit, scope } = {}) =>
      getWorkspaceGitService().getGitCommitGraph(workDir, { limit, scope })
    )
  );

  ipcMain.handle(
    "get-workspace-git-commit-detail",
    safeHandler((event, { workDir, hash } = {}) =>
      getWorkspaceGitService().getGitCommitDetail(workDir, hash)
    )
  );

  ipcMain.handle(
    "workspace-git-diff",
    safeHandler((event, { workDir, filePath }) =>
      getWorkspaceGitService().getWorkspaceFileDiff(workDir, filePath)
    )
  );

  ipcMain.handle(
    "workspace-git-commit",
    safeHandler(async (event, { workDir, message }) =>
      notifyGitMutation(workDir, await getWorkspaceGitService().commitWorkspaceChanges(workDir, message))
    )
  );

  ipcMain.handle(
    "workspace-get-branches",
    safeHandler((event, workDir) => getWorkspaceGitService().getWorkspaceBranches(workDir))
  );

  ipcMain.handle(
    "workspace-checkout-branch",
    safeHandler(async (event, { workDir, branchName, createNew }) =>
      notifyGitMutation(
        workDir,
        await getWorkspaceGitService().checkoutWorkspaceBranch(workDir, branchName, createNew),
        { invalidateFiles: true, areas: ["files", "git", "worktrees"] }
      )
    )
  );

  ipcMain.handle(
    "workspace-delete-branch",
    safeHandler(async (event, { workDir, branchName, deleteRemote, force }) =>
      notifyGitMutation(
        workDir,
        await getWorkspaceGitService().deleteWorkspaceBranch(workDir, branchName, {
          deleteRemote: Boolean(deleteRemote),
          force: Boolean(force),
        }),
        { areas: ["git", "worktrees"] }
      )
    )
  );

  ipcMain.handle(
    "git-working-tree-changes",
    safeHandler((event, { workDir } = {}) => getWorkspaceGitService().getWorkingTreeChanges(workDir))
  );

  ipcMain.handle(
    "git-commit-staged",
    safeHandler(async (event, { workDir, message } = {}) =>
      notifyGitMutation(workDir, await getWorkspaceGitService().commitStagedChanges(workDir, message))
    )
  );

  ipcMain.handle(
    "git-fetch",
    safeHandler(async (event, { workDir } = {}) =>
      notifyGitMutation(workDir, await getWorkspaceGitService().gitFetch(workDir))
    )
  );

  ipcMain.handle(
    "git-pull",
    safeHandler(async (event, { workDir } = {}) =>
      notifyGitMutation(workDir, await getWorkspaceGitService().gitPull(workDir), {
        invalidateFiles: true,
        areas: ["files", "git"],
      })
    )
  );

  ipcMain.handle(
    "git-push",
    safeHandler(async (event, { workDir } = {}) =>
      notifyGitMutation(workDir, await getWorkspaceGitService().gitPush(workDir))
    )
  );

  ipcMain.handle(
    "git-merge-branch",
    safeHandler(async (event, { workDir, sourceBranch, noFf = false } = {}) =>
      notifyGitMutation(workDir, await getWorkspaceGitService().gitMergeBranch(workDir, sourceBranch, { noFf: Boolean(noFf) }), {
        invalidateFiles: true,
        areas: ["files", "git", "worktrees"],
      })
    )
  );

  ipcMain.handle(
    "git-stash-action",
    safeHandler(async (event, { workDir, action } = {}) =>
      notifyGitMutation(workDir, await getWorkspaceGitService().gitStashAction(workDir, action), {
        invalidateFiles: true,
        areas: ["files", "git"],
      })
    )
  );

  ipcMain.handle(
    "git-cherry-pick",
    safeHandler(async (event, { workDir, hash } = {}) =>
      notifyGitMutation(workDir, await getWorkspaceGitService().gitCherryPick(workDir, hash), {
        invalidateFiles: true,
        areas: ["files", "git"],
      })
    )
  );

  ipcMain.handle(
    "git-create-branch-at",
    safeHandler(async (event, { workDir, branchName, startPoint } = {}) =>
      notifyGitMutation(
        workDir,
        await getWorkspaceGitService().gitCreateBranchAt(workDir, branchName, startPoint),
        { invalidateFiles: true, areas: ["files", "git", "worktrees"] }
      )
    )
  );

  ipcMain.handle(
    "git-get-file-hunks",
    safeHandler((event, { workDir, filePath, staged } = {}) =>
      getGitHunkService().getFileHunks(workDir, filePath, Boolean(staged))
    )
  );

  ipcMain.handle(
    "git-apply-hunks",
    safeHandler(async (event, { workDir, filePath, hunkIds, staged, reverse, target } = {}) =>
      notifyGitMutation(
        workDir,
        await getGitHunkService().applyHunks(workDir, filePath, hunkIds, {
          staged: Boolean(staged),
          reverse: Boolean(reverse),
          target: target === "worktree" ? "worktree" : "index",
        }),
        { invalidateFiles: target === "worktree", areas: target === "worktree" ? ["files", "git"] : ["git"] }
      )
    )
  );

  ipcMain.handle(
    "git-discard-hunks",
    safeHandler(async (event, { workDir, filePath, hunkIds } = {}) =>
      notifyGitMutation(
        workDir,
        await getGitHunkService().applyHunks(workDir, filePath, hunkIds, {
          target: "worktree",
          reverse: true,
        }),
        { invalidateFiles: true, areas: ["files", "git"] }
      )
    )
  );

  ipcMain.handle(
    "git-discard-file",
    safeHandler(async (event, { workDir, filePath, staged } = {}) =>
      notifyGitMutation(
        workDir,
        await getGitHunkService().discardFile(workDir, filePath, { staged: Boolean(staged) }),
        { invalidateFiles: true, areas: ["files", "git"] }
      )
    )
  );

  ipcMain.handle(
    "git-stage-file",
    safeHandler(async (event, { workDir, filePath } = {}) =>
      notifyGitMutation(workDir, await getGitHunkService().stageFile(workDir, filePath))
    )
  );

  ipcMain.handle(
    "git-unstage-file",
    safeHandler(async (event, { workDir, filePath } = {}) =>
      notifyGitMutation(workDir, await getGitHunkService().unstageFile(workDir, filePath))
    )
  );

  ipcMain.handle(
    "git-stage-all",
    safeHandler(async (event, { workDir } = {}) =>
      notifyGitMutation(workDir, await getGitHunkService().stageAll(workDir))
    )
  );

  ipcMain.handle(
    "git-create-pr",
    safeHandler((event, payload = {}) =>
      getGitHunkService().createPullRequest(payload.workDir, payload)
    )
  );

  ipcMain.handle(
    "git-worktree-list",
    safeHandler((event, { workDir } = {}) => getGitWorktreeService().listWorktrees(workDir))
  );

  ipcMain.handle(
    "git-worktree-branches",
    safeHandler((event, { workDir } = {}) => getGitWorktreeService().listBranches(workDir))
  );

  ipcMain.handle(
    "git-worktree-inspect",
    safeHandler((event, { targetPath, sessionId } = {}) =>
      getGitWorktreeService().inspectManagedWorktree(targetPath, sessionId)
    )
  );

  ipcMain.handle(
    "git-worktree-inspect-dirs",
    safeHandler((event, { folders } = {}) =>
      getGitWorktreeService().inspectGitDirectories(folders)
    )
  );

  ipcMain.handle(
    "git-worktree-create",
    safeHandler(async (event, payload = {}) =>
      notifyGitMutation(
        payload.workDir,
        await getGitWorktreeService().createWorktree(payload.workDir, payload),
        { areas: ["git", "worktrees"] }
      )
    )
  );

  ipcMain.handle(
    "git-worktree-create-multi",
    safeHandler(async (event, payload = {}) =>
      notifyGitMutation(
        payload?.folders?.[0]?.path || payload?.workDir,
        await getGitWorktreeService().createMultiWorktrees(payload),
        { areas: ["git", "worktrees"] }
      )
    )
  );

  ipcMain.handle(
    "git-worktree-save-group",
    safeHandler((event, { sessionId, entries } = {}) =>
      getGitWorktreeService().saveSessionWorktreeGroup(sessionId, entries)
    )
  );

  ipcMain.handle(
    "git-worktree-remove-group",
    safeHandler((event, { sessionId } = {}) =>
      getGitWorktreeService().removeSessionWorktreeGroup(sessionId)
    )
  );

  ipcMain.handle(
    "git-worktree-merge",
    safeHandler(async (event, payload = {}) =>
      notifyGitMutation(
        payload.workDir,
        await getGitWorktreeService().mergeWorktree(payload.workDir, payload),
        { invalidateFiles: true, areas: ["files", "git", "worktrees"] }
      )
    )
  );

  ipcMain.handle(
    "git-worktree-remove",
    safeHandler(async (event, { workDir, targetPath, force } = {}) =>
      notifyGitMutation(
        workDir,
        await getGitWorktreeService().removeWorktree(workDir, targetPath, { force: Boolean(force) }),
        { areas: ["git", "worktrees"] }
      )
    )
  );
}

module.exports = { registerGitIpc };
