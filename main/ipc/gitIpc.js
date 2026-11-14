const { ipcMain } = require("electron");
const {
  safeHandler,
  getWorkspaceGitService,
  getGitHunkService,
  getGitWorktreeService,
} = require("../shared");

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
    safeHandler((event, { workDir, message }) =>
      getWorkspaceGitService().commitWorkspaceChanges(workDir, message)
    )
  );

  ipcMain.handle(
    "workspace-get-branches",
    safeHandler((event, workDir) => getWorkspaceGitService().getWorkspaceBranches(workDir))
  );

  ipcMain.handle(
    "workspace-checkout-branch",
    safeHandler((event, { workDir, branchName, createNew }) =>
      getWorkspaceGitService().checkoutWorkspaceBranch(workDir, branchName, createNew)
    )
  );

  ipcMain.handle(
    "workspace-delete-branch",
    safeHandler((event, { workDir, branchName, deleteRemote, force }) =>
      getWorkspaceGitService().deleteWorkspaceBranch(workDir, branchName, {
        deleteRemote: Boolean(deleteRemote),
        force: Boolean(force),
      })
    )
  );

  ipcMain.handle(
    "git-working-tree-changes",
    safeHandler((event, { workDir } = {}) => getWorkspaceGitService().getWorkingTreeChanges(workDir))
  );

  ipcMain.handle(
    "git-commit-staged",
    safeHandler((event, { workDir, message } = {}) =>
      getWorkspaceGitService().commitStagedChanges(workDir, message)
    )
  );

  ipcMain.handle(
    "git-fetch",
    safeHandler((event, { workDir } = {}) => getWorkspaceGitService().gitFetch(workDir))
  );

  ipcMain.handle(
    "git-pull",
    safeHandler((event, { workDir } = {}) => getWorkspaceGitService().gitPull(workDir))
  );

  ipcMain.handle(
    "git-push",
    safeHandler((event, { workDir } = {}) => getWorkspaceGitService().gitPush(workDir))
  );

  ipcMain.handle(
    "git-merge-branch",
    safeHandler((event, { workDir, sourceBranch } = {}) =>
      getWorkspaceGitService().gitMergeBranch(workDir, sourceBranch)
    )
  );

  ipcMain.handle(
    "git-stash-action",
    safeHandler((event, { workDir, action } = {}) =>
      getWorkspaceGitService().gitStashAction(workDir, action)
    )
  );

  ipcMain.handle(
    "git-cherry-pick",
    safeHandler((event, { workDir, hash } = {}) =>
      getWorkspaceGitService().gitCherryPick(workDir, hash)
    )
  );

  ipcMain.handle(
    "git-create-branch-at",
    safeHandler((event, { workDir, branchName, startPoint } = {}) =>
      getWorkspaceGitService().gitCreateBranchAt(workDir, branchName, startPoint)
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
    safeHandler((event, { workDir, filePath, hunkIds, staged, reverse, target } = {}) =>
      getGitHunkService().applyHunks(workDir, filePath, hunkIds, {
        staged: Boolean(staged),
        reverse: Boolean(reverse),
        target: target === "worktree" ? "worktree" : "index",
      })
    )
  );

  ipcMain.handle(
    "git-discard-hunks",
    safeHandler((event, { workDir, filePath, hunkIds } = {}) =>
      getGitHunkService().applyHunks(workDir, filePath, hunkIds, {
        target: "worktree",
        reverse: true,
      })
    )
  );

  ipcMain.handle(
    "git-discard-file",
    safeHandler((event, { workDir, filePath, staged } = {}) =>
      getGitHunkService().discardFile(workDir, filePath, { staged: Boolean(staged) })
    )
  );

  ipcMain.handle(
    "git-stage-file",
    safeHandler((event, { workDir, filePath } = {}) =>
      getGitHunkService().stageFile(workDir, filePath)
    )
  );

  ipcMain.handle(
    "git-unstage-file",
    safeHandler((event, { workDir, filePath } = {}) =>
      getGitHunkService().unstageFile(workDir, filePath)
    )
  );

  ipcMain.handle(
    "git-stage-all",
    safeHandler((event, { workDir } = {}) => getGitHunkService().stageAll(workDir))
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
    safeHandler((event, payload = {}) =>
      getGitWorktreeService().createWorktree(payload.workDir, payload)
    )
  );

  ipcMain.handle(
    "git-worktree-create-multi",
    safeHandler((event, payload = {}) =>
      getGitWorktreeService().createMultiWorktrees(payload)
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
    safeHandler((event, payload = {}) =>
      getGitWorktreeService().mergeWorktree(payload.workDir, payload)
    )
  );

  ipcMain.handle(
    "git-worktree-remove",
    safeHandler((event, { workDir, targetPath, force } = {}) =>
      getGitWorktreeService().removeWorktree(workDir, targetPath, { force: Boolean(force) })
    )
  );
}

module.exports = { registerGitIpc };
