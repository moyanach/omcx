const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const DISABLED_SKILLS_KEY = "disabled_skills";
const IMPORT_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".idea",
  ".vscode",
  "__MACOSX",
]);
const IMPORT_MAX_FILES = 300;
const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const PROJECT_RULES_BUDGET = 8000;

function parseSkillMarkdown(filePath, scope = "global", defaultName = null) {
  try {
    const realStat = fs.statSync(filePath);
    if (!realStat.isFile()) return null;

    const content = fs.readFileSync(filePath, "utf-8");
    const filename = path.basename(filePath);
    const parentDirName = path.basename(path.dirname(filePath));
    const isSkillIndex = /^skill\.md$/i.test(filename);
    let name = defaultName || (isSkillIndex ? parentDirName : filename.replace(/\.md$/i, ""));
    let description = "";
    let tools = [];
    let allowedTools = [];
    let declaredScripts = [];
    let version = "";
    let promptBody = content;

    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (frontmatterMatch) {
      const yaml = frontmatterMatch[1];
      promptBody = frontmatterMatch[2].trim();

      const nameMatch = yaml.match(/^name:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, "");

      const descMatch = yaml.match(/^description:\s*(.+)$/m);
      if (descMatch) description = descMatch[1].trim().replace(/^['"]|['"]$/g, "");

      const versionMatch = yaml.match(/^version:\s*(.+)$/m);
      if (versionMatch) version = versionMatch[1].trim().replace(/^['"]|['"]$/g, "");

      const toolsMatch = yaml.match(/^tools:\s*(?:\[(.*?)\]|(.+))$/m);
      if (toolsMatch) {
        const rawTools = toolsMatch[1] !== undefined ? toolsMatch[1] : toolsMatch[2];
        tools = (rawTools || "")
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }

      const allowedToolsMatch = yaml.match(/^allowed-tools:\s*(?:\[(.*?)\]|(.+))$/m);
      if (allowedToolsMatch) {
        const rawAllowed =
          allowedToolsMatch[1] !== undefined ? allowedToolsMatch[1] : allowedToolsMatch[2];
        allowedTools = (rawAllowed || "")
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }

      const scriptsMatch = yaml.match(/^scripts:\s*(?:\[(.*?)\]|(.+))$/m);
      if (scriptsMatch) {
        const rawScripts = scriptsMatch[1] !== undefined ? scriptsMatch[1] : scriptsMatch[2];
        declaredScripts = (rawScripts || "")
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }
    }

    const skillDir = path.dirname(filePath);
    let scripts = [];
    const scriptsDir = path.join(skillDir, "scripts");
    if (fs.existsSync(scriptsDir)) {
      try {
        const entries = fs.readdirSync(scriptsDir, { withFileTypes: true });
        for (const entry of entries.slice(0, 60)) {
          if (!entry.isFile() || entry.name.startsWith(".")) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (![".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb"].includes(ext)) {
            continue;
          }
          scripts.push({
            name: entry.name,
            path: path.join(scriptsDir, entry.name),
            ext,
          });
        }
      } catch {}
    }
    if (declaredScripts.length > 0) {
      scripts = scripts.filter((s) =>
        declaredScripts.some((declared) => declared === s.name || declared === path.basename(declared))
      );
      if (scripts.length === 0) {
        for (const declared of declaredScripts) {
          const candidate = path.resolve(skillDir, declared);
          if (
            candidate.startsWith(skillDir + path.sep) &&
            fs.existsSync(candidate) &&
            fs.statSync(candidate).isFile()
          ) {
            scripts.push({
              name: path.basename(candidate),
              path: candidate,
              ext: path.extname(candidate).toLowerCase(),
            });
          }
        }
      }
    }

    return {
      id: `${scope}:${name}`,
      name,
      description,
      tools,
      allowedTools,
      scripts,
      dir: skillDir,
      prompt: promptBody,
      scope,
      filePath,
      version: version || undefined,
    };
  } catch (err) {
    console.error(`[storageService] 解析 Skill 失败 (${filePath}):`, err.message);
    return null;
  }
}

function scanSkillsDir(targetDir, scope = "global") {
  const result = [];
  if (!targetDir || !fs.existsSync(targetDir)) return result;

  try {
    const entries = fs.readdirSync(targetDir);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const fullPath = path.join(targetDir, entry);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isFile() && entry.endsWith(".md")) {
        const item = parseSkillMarkdown(fullPath, scope);
        if (item) result.push(item);
      } else if (stat.isDirectory()) {
        const candidates = ["SKILL.md", "skill.md", `${entry}.md`];
        let found = false;
        for (const candidate of candidates) {
          const subPath = path.join(fullPath, candidate);
          if (fs.existsSync(subPath)) {
            const item = parseSkillMarkdown(subPath, scope, entry);
            if (item) {
              result.push(item);
              found = true;
              break;
            }
          }
        }
        if (!found) {
          try {
            const subEntries = fs.readdirSync(fullPath);
            const mdFile = subEntries.find((f) => f.endsWith(".md") && !f.startsWith("."));
            if (mdFile) {
              const item = parseSkillMarkdown(path.join(fullPath, mdFile), scope, entry);
              if (item) result.push(item);
            }
          } catch {}
        }
      }
    }
  } catch (err) {
    console.error(`[storageService] 扫描 Skills 目录失败 (${targetDir}):`, err.message);
  }

  return result;
}

function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function slugifySkillName(raw) {
  const text = String(raw || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return text || `skill-${Date.now()}`;
}

function findSkillDoc(dir) {
  for (const candidate of ["SKILL.md", "skill.md", "README.md"]) {
    const target = path.join(dir, candidate);
    try {
      if (fs.statSync(target).isFile()) return target;
    } catch {}
  }
  try {
    const match = fs
      .readdirSync(dir)
      .find((file) => file.toLowerCase().endsWith(".md") && !file.startsWith("."));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

function pickExtractedRoot(dir) {
  if (findSkillDoc(dir)) return dir;
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "__MACOSX")
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return dir;
  }
  for (const candidate of dirs) {
    if (findSkillDoc(candidate)) return candidate;
  }
  return dirs.length === 1 ? dirs[0] : dir;
}

function extractZip(zipPath, targetDir) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/unzip",
      ["-o", "-q", zipPath, "-d", targetDir],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (err) => (err ? reject(new Error(`解压失败：${err.message}`)) : resolve())
    );
  });
}

function createSkillsMemoryStorage({ USER_HOME, getConfig, setConfig, getPaths, ensureDir }) {
  function copySkillTree(sourceDir, targetDir, budget, depth = 0) {
    if (depth > 4) return;
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IMPORT_SKIP_DIRS.has(entry.name)) continue;
      if (budget.files >= IMPORT_MAX_FILES) return;
      const source = path.join(sourceDir, entry.name);
      const dest = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        ensureDir(dest);
        copySkillTree(source, dest, budget, depth + 1);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(source).size;
        } catch {
          continue;
        }
        if (budget.bytes + size > IMPORT_MAX_BYTES) continue;
        fs.copyFileSync(source, dest);
        budget.files += 1;
        budget.bytes += size;
      }
    }
  }

  function getDisabledSkillNames() {
    const raw = getConfig(DISABLED_SKILLS_KEY);
    if (Array.isArray(raw)) return raw.map((item) => String(item));
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
      } catch {
        return [];
      }
    }
    return [];
  }

  function setSkillEnabled(name, enabled) {
    const key = String(name || "").trim();
    if (!key) return { success: false, error: "缺少技能名称" };
    const disabled = new Set(getDisabledSkillNames());
    if (enabled) disabled.delete(key);
    else disabled.add(key);
    setConfig(DISABLED_SKILLS_KEY, Array.from(disabled));
    return { success: true, name: key, enabled: Boolean(enabled) };
  }

  function getSkills(workDir = null, options = {}) {
    const includeDisabled = Boolean(options && options.includeDisabled);
    const skillsMap = new Map();

    const globalDirs = [
      path.join(USER_HOME, ".agents", "skills"),
      path.join(USER_HOME, ".omcx", "skills"),
    ];

    for (const dir of globalDirs) {
      const items = scanSkillsDir(dir, "global");
      for (const item of items) {
        if (!skillsMap.has(item.name)) {
          skillsMap.set(item.name, item);
        }
      }
    }

    if (workDir) {
      const projectDirs = [
        path.join(workDir, ".agents", "skills"),
        path.join(workDir, ".omcx", "skills"),
      ];

      for (const dir of projectDirs) {
        const items = scanSkillsDir(dir, "project");
        for (const item of items) {
          skillsMap.set(item.name, item);
        }
      }
    }

    const disabled = new Set(getDisabledSkillNames());
    const list = Array.from(skillsMap.values()).map((item) => ({
      ...item,
      enabled: !disabled.has(item.name),
    }));
    list.sort((a, b) => a.name.localeCompare(b.name));
    return includeDisabled ? list : list.filter((item) => item.enabled);
  }

  function getSkillRoots(workDir = null) {
    const roots = [
      path.join(USER_HOME, ".agents", "skills"),
      path.join(USER_HOME, ".omcx", "skills"),
    ];
    if (workDir) {
      roots.push(path.join(workDir, ".agents", "skills"));
      roots.push(path.join(workDir, ".omcx", "skills"));
    }
    return roots;
  }

  async function importSkill(sourcePath, options = {}) {
    const { SKILLS_DIR } = getPaths();
    const { overwrite = false, workDir = null, scope = "global" } = options;
    if (!sourcePath) return { success: false, error: "缺少技能来源路径" };

    let stat;
    try {
      stat = fs.statSync(sourcePath);
    } catch {
      return { success: false, error: "文件或目录不存在" };
    }

    const targetRoot =
      scope === "project" && workDir
        ? path.join(workDir, ".omcx", "skills")
        : SKILLS_DIR;
    ensureDir(targetRoot);

    let tempDir = null;
    try {
      if (stat.isFile() && /\.zip$/i.test(sourcePath)) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omcx-skill-"));
        await extractZip(sourcePath, tempDir);
        return await importSkill(pickExtractedRoot(tempDir), options);
      }

      if (stat.isFile()) {
        if (!/\.md$/i.test(sourcePath)) {
          return { success: false, error: "仅支持 .md 技能文件或 .zip 技能包" };
        }
        const parsed = parseSkillMarkdown(sourcePath, scope);
        if (!parsed) return { success: false, error: "无法解析该技能文件" };
        const targetFile = path.join(targetRoot, `${slugifySkillName(parsed.name)}.md`);
        if (fs.existsSync(targetFile) && !overwrite) {
          return {
            success: false,
            code: "exists",
            sourcePath,
            name: parsed.name,
            error: `技能「${parsed.name}」已存在`,
          };
        }
        fs.copyFileSync(sourcePath, targetFile);
        return { success: true, name: parsed.name, filePath: targetFile, scope };
      }

      if (stat.isDirectory()) {
        const docPath = findSkillDoc(sourcePath);
        if (!docPath) {
          return { success: false, error: "该目录下未找到 SKILL.md 或任意 .md 技能说明" };
        }
        const parsed = parseSkillMarkdown(docPath, scope, path.basename(sourcePath));
        const dirName = slugifySkillName(parsed?.name || path.basename(sourcePath));
        const targetDir = path.join(targetRoot, dirName);
        if (fs.existsSync(targetDir)) {
          if (!overwrite) {
            return {
              success: false,
              code: "exists",
              sourcePath,
              name: parsed?.name || dirName,
              error: `技能「${parsed?.name || dirName}」已存在`,
            };
          }
          fs.rmSync(targetDir, { recursive: true, force: true });
        }
        fs.mkdirSync(targetDir, { recursive: true });
        copySkillTree(sourcePath, targetDir, { files: 0, bytes: 0 });
        return {
          success: true,
          name: parsed?.name || dirName,
          dir: targetDir,
          filePath: path.join(targetDir, path.basename(docPath)),
          scope,
        };
      }

      return { success: false, error: "不支持的技能来源类型" };
    } catch (err) {
      return { success: false, error: err.message || "导入技能失败" };
    } finally {
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  function deleteSkill({ filePath, workDir } = {}) {
    if (!filePath) return { success: false, error: "缺少技能路径" };

    let realPath;
    try {
      realPath = fs.realpathSync(filePath);
    } catch {
      return { success: false, error: "技能文件不存在" };
    }

    const roots = getSkillRoots(workDir).map((root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        return path.resolve(root);
      }
    });
    const root = roots.find((item) => isPathInside(item, realPath));
    if (!root) {
      return { success: false, error: "仅允许删除技能目录内的内容" };
    }

    const parsed = parseSkillMarkdown(realPath, "global");

    let target = realPath;
    let removeDir = false;
    if (/^(skill|readme)\.md$/i.test(path.basename(realPath))) {
      const parent = path.dirname(realPath);
      if (isPathInside(root, parent)) {
        target = parent;
        removeDir = true;
      }
    }

    try {
      if (removeDir) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target);
        const parent = path.dirname(target);
        try {
          if (isPathInside(root, parent) && fs.readdirSync(parent).length === 0) {
            fs.rmdirSync(parent);
          }
        } catch {}
      }
    } catch (err) {
      return { success: false, error: err.message || "删除失败" };
    }

    if (parsed?.name) {
      const disabled = new Set(getDisabledSkillNames());
      if (disabled.delete(parsed.name)) {
        setConfig(DISABLED_SKILLS_KEY, Array.from(disabled));
      }
    }

    return { success: true, name: parsed?.name || path.basename(target) };
  }

  function getMemories(workDir = null) {
    const { MEMORY_DIR } = getPaths();
    const memories = [];

    if (fs.existsSync(MEMORY_DIR)) {
      const files = fs.readdirSync(MEMORY_DIR);
      for (const file of files) {
        if (file.endsWith(".md") && file !== "MEMORY.md") {
          const fp = path.join(MEMORY_DIR, file);
          const content = fs.readFileSync(fp, "utf-8");
          memories.push({
            id: `global:${file}`,
            name: file.replace(/\.md$/, ""),
            path: fp,
            content,
            scope: "global",
          });
        }
      }
    }

    if (workDir) {
      const projMemDir = path.join(workDir, ".omcx", "memory");
      if (fs.existsSync(projMemDir)) {
        const files = fs.readdirSync(projMemDir);
        for (const file of files) {
          if (file.endsWith(".md") && file !== "MEMORY.md") {
            const fp = path.join(projMemDir, file);
            const content = fs.readFileSync(fp, "utf-8");
            memories.push({
              id: `project:${file}`,
              name: file.replace(/\.md$/, ""),
              path: fp,
              content,
              scope: "project",
            });
          }
        }
      }
    }

    return memories;
  }

  function getProjectInstructions(workDir) {
    const instructions = [];
    if (!workDir) return instructions;

    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const filePath = path.join(workDir, name);
      if (!fs.existsSync(filePath)) continue;
      let content = fs.readFileSync(filePath, "utf-8");
      if (content.length > PROJECT_RULES_BUDGET) {
        content = `${content.slice(0, PROJECT_RULES_BUDGET)}\n…(已截断，原始长度 ${content.length} 字符)`;
      }
      instructions.push({ name, path: filePath, content });
    }

    return instructions;
  }

  function getMemoryIndex(workDir) {
    const { MEMORY_DIR } = getPaths();
    const indexes = [];

    const globalIndex = path.join(MEMORY_DIR, "MEMORY.md");
    if (fs.existsSync(globalIndex)) {
      indexes.push({
        scope: "global",
        path: globalIndex,
        content: fs.readFileSync(globalIndex, "utf-8"),
      });
    }

    if (workDir) {
      const projectIndex = path.join(workDir, ".omcx", "memory", "MEMORY.md");
      if (fs.existsSync(projectIndex)) {
        indexes.push({
          scope: "project",
          path: projectIndex,
          content: fs.readFileSync(projectIndex, "utf-8"),
        });
      }
    }

    return indexes;
  }

  return {
    getDisabledSkillNames,
    setSkillEnabled,
    getSkills,
    importSkill,
    deleteSkill,
    getMemories,
    getProjectInstructions,
    getMemoryIndex,
  };
}

module.exports = { createSkillsMemoryStorage };
