const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { buildHeadlessBundle } = require("../scripts/build-headless-bundle");

test("buildHeadlessBundle 生成自包含运行包并在完全隔离目录独立运行", () => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-bundle-test-"));
  const bundlePath = path.join(workRoot, "bundle.tar.gz");
  const extractDir = path.join(workRoot, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    const res = buildHeadlessBundle({ outputPath: bundlePath });
    assert.equal(fs.existsSync(bundlePath), true);
    assert.ok(res.sizeBytes > 100 * 1024, `运行包过小: ${res.sizeBytes}`);
    assert.ok(res.packageCount >= 2, "应包含 zod/cheerio 等纯 JS 依赖");

    execFileSync("tar", ["-xzf", bundlePath, "-C", extractDir]);

    const helpOut = execFileSync(
      process.execPath,
      [path.join(extractDir, "bin/omcx-cli.js"), "--help"],
      { cwd: extractDir, encoding: "utf-8" }
    );
    assert.match(helpOut, /OMCX Headless CLI/);

    const probeOut = execFileSync(
      process.execPath,
      [
        "-e",
        [
          'process.env.OMCX_STORAGE_MEMORY_ONLY = "1";',
          'const { toolRegistry } = require("./utils/toolRegistry");',
          'const { runAgentTurn } = require("./main/agentRunner");',
          'console.log(JSON.stringify({ size: toolRegistry.size, hasRunner: typeof runAgentTurn === "function" }));',
        ].join(" "),
      ],
      { cwd: extractDir, encoding: "utf-8" }
    );
    const lines = probeOut.trim().split(/\r?\n/);
    const parsed = JSON.parse(lines[lines.length - 1]);
    assert.ok(parsed.size >= 20, `工具数不足: ${parsed.size}`);
    assert.equal(parsed.hasRunner, true);
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
});

test("eval/harbor/omcx_agent.py 结构完整且包含 BaseAgent 所需生命周期方法", () => {
  const agentPath = path.resolve(__dirname, "../eval/harbor/omcx_agent.py");
  assert.equal(fs.existsSync(agentPath), true);
  const src = fs.readFileSync(agentPath, "utf-8");
  assert.match(src, /class OmcxAgent\(BaseAgent\):/);
  assert.match(src, /def name\(\) -> str:/);
  assert.match(src, /def version\(self\)/);
  assert.match(src, /async def setup\(self, environment: BaseEnvironment\) -> None:/);
  assert.match(src, /async def run\(/);
  assert.match(src, /context\.n_input_tokens/);
  assert.match(src, /context\.n_output_tokens/);
  assert.match(src, /context\.cost_usd/);
});
