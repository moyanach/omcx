#!/usr/bin/env node
/**
 * build-headless-bundle.js
 *
 * 将 OMCX 无头运行所需的后端源码与纯 JS 依赖（zod / cheerio）打包为自包含 tar.gz，
 * 以便直接上传至 Harbor / Docker 评测容器运行，无需容器内执行 npm install 或编译原生模块。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_PATH = "/tmp/omcx-harbor-cache/omcx-headless-bundle.tar.gz";
const HEADLESS_ENTRY_DEPS = ["zod", "cheerio"];
const COPY_DIRS = ["bin", "main", "services", "utils"];

function collectPureJsDeps(nodeModulesDir, entryDeps) {
  const collected = new Map();

  function visit(pkgName, parentPkgDir = null) {
    if (collected.has(pkgName)) return;

    const candidates = [];
    if (parentPkgDir) {
      candidates.push(path.join(parentPkgDir, "node_modules", pkgName));
    }
    candidates.push(path.join(nodeModulesDir, pkgName));

    const pkgDir = candidates.find((p) => fs.existsSync(path.join(p, "package.json")));
    if (!pkgDir) return;

    collected.set(pkgName, pkgDir);
    try {
      const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf-8"));
      for (const depName of Object.keys(pkgJson.dependencies || {})) {
        visit(depName, pkgDir);
      }
    } catch {}
  }

  for (const dep of entryDeps) {
    visit(dep);
  }
  return collected;
}

function copyFilteredDir(srcDir, dstDir) {
  fs.cpSync(srcDir, dstDir, {
    recursive: true,
    dereference: true,
    filter: (src) => path.basename(src) !== ".DS_Store",
  });
}

function buildHeadlessBundle(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const outputPath = path.resolve(
    options.outputPath || process.env.OMCX_BUNDLE_PATH || DEFAULT_OUTPUT_PATH
  );
  const nodeModulesDir = path.join(projectRoot, "node_modules");

  if (!fs.existsSync(nodeModulesDir)) {
    throw new Error(`未找到 node_modules 目录: ${nodeModulesDir}`);
  }

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-headless-bundle-"));
  try {
    for (const dirName of COPY_DIRS) {
      const srcDir = path.join(projectRoot, dirName);
      if (!fs.existsSync(srcDir)) {
        throw new Error(`缺少必需源码目录: ${srcDir}`);
      }
      copyFilteredDir(srcDir, path.join(stagingDir, dirName));
    }

    const pkgSrc = path.join(projectRoot, "package.json");
    if (fs.existsSync(pkgSrc)) {
      fs.copyFileSync(pkgSrc, path.join(stagingDir, "package.json"));
    }

    const depsMap = collectPureJsDeps(nodeModulesDir, HEADLESS_ENTRY_DEPS);
    const dstNodeModules = path.join(stagingDir, "node_modules");
    fs.mkdirSync(dstNodeModules, { recursive: true });

    for (const [pkgName, pkgSrcDir] of depsMap.entries()) {
      const dstPkgDir = path.join(dstNodeModules, pkgName);
      fs.mkdirSync(path.dirname(dstPkgDir), { recursive: true });
      copyFilteredDir(pkgSrcDir, dstPkgDir);
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    execFileSync("tar", ["-czf", outputPath, "-C", stagingDir, "."]);

    const stat = fs.statSync(outputPath);
    return {
      outputPath,
      sizeBytes: stat.size,
      packageCount: depsMap.size,
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const res = buildHeadlessBundle();
  const sizeKb = (res.sizeBytes / 1024).toFixed(1);
  console.log(
    `[build-headless-bundle] 打包完成: ${res.outputPath} (${sizeKb} KB, ${res.packageCount} 个纯 JS 依赖包)`
  );
}

module.exports = { buildHeadlessBundle, collectPureJsDeps };
