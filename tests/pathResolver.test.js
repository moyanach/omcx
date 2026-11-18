const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveWorkspacePath, isUnderFolder } = require("../utils/tools/pathResolver");

test("resolveWorkspacePath 正确区分工作区内路径、外部路径与敏感路径", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-path-test-"));
  const wsDir = path.join(tmpRoot, "workspace");
  const subFile = path.join(wsDir, "src", "app.js");
  const outsideDir = path.join(tmpRoot, "outside");
  fs.mkdirSync(path.dirname(subFile), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(subFile, "console.log(1);\n");
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "external");

  try {
    const inside = resolveWorkspacePath("src/app.js", wsDir, [wsDir], { mode: "write" });
    assert.equal(inside.isExternal, false);
    assert.equal(inside.isSensitiveBlocked, false);
    assert.equal(inside.isProtectedWrite, false);
    assert.equal(inside.realPath, fs.realpathSync(subFile));

    const external = resolveWorkspacePath(path.join(outsideDir, "secret.txt"), wsDir, [wsDir], {
      mode: "read",
    });
    assert.equal(external.isExternal, true);

    // 软链接逃逸检测：工作区内的 symlink 指向外部文件应判定为 isExternal
    const symlinkPath = path.join(wsDir, "escape-link.txt");
    fs.symlinkSync(path.join(outsideDir, "secret.txt"), symlinkPath);
    const escaped = resolveWorkspacePath("escape-link.txt", wsDir, [wsDir], { mode: "read" });
    assert.equal(escaped.isExternal, true);

    // 工作区内 .git 内部文件写入应触发受保护文件拦截
    fs.mkdirSync(path.join(wsDir, ".git"), { recursive: true });
    const gitConfigWrite = resolveWorkspacePath(".git/config", wsDir, [wsDir], { mode: "write" });
    assert.equal(gitConfigWrite.isProtectedWrite, true);

    // 全局敏感凭证目录应触发 sensitiveBlocked
    const sshKey = resolveWorkspacePath(path.join(os.homedir(), ".ssh", "id_rsa"), wsDir, [wsDir], {
      mode: "read",
    });
    assert.equal(sshKey.isSensitiveBlocked, true);

    assert.equal(isUnderFolder(subFile, wsDir), true);
    assert.equal(isUnderFolder(outsideDir, wsDir), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
