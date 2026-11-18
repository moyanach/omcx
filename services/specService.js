/**
 * SpecService — Quest / 规格模式文档存储
 *
 * 规格文档落盘于 <workDir>/.omcx/specs/*.md，与消息历史解耦：
 * - Agent 在只读规划模式下通过 spec_write 工具生成；
 * - 用户确认后通过 /execute-spec 读取并自主执行；
 * - Inspector 的 SpecCard 负责列出、查看、复制执行指令与删除。
 *
 * 文件名格式：<YYYYMMDD-HHmmss>-<slug>.md
 * Frontmatter：title / status(draft|confirmed|in-progress|done) / createdAt / updatedAt
 */

const fs = require("fs");
const path = require("path");

const MAX_SPEC_BYTES = 512 * 1024;
const MAX_SPECS = 200;
const VALID_STATUS = new Set(["draft", "confirmed", "in-progress", "done", "archived"]);

function specDir(workDir) {
  return workDir ? path.join(path.resolve(workDir), ".omcx", "specs") : null;
}

function slugify(input) {
  const text = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9一-龥-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return text || "spec";
}

function safeSpecId(id) {
  const name = path.basename(String(id || "").trim());
  if (!name || name !== String(id || "").trim()) return "";
  if (!/^[A-Za-z0-9._一-龥-]+\.md$/.test(name)) return "";
  return name;
}

function parseFrontmatter(content) {
  const text = String(content || "");
  if (!text.startsWith("---\n")) {
    return { meta: {}, body: text };
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { meta: {}, body: text };
  const raw = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, "");
  const meta = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[match[1]] = value;
  }
  return { meta, body };
}

function buildContent({ title, content, status = "draft", createdAt, updatedAt }) {
  const raw = String(content || "").trim();
  const parsed = parseFrontmatter(raw);
  // 若调用方已自带 frontmatter，则尊重其正文与状态，只补齐缺失字段
  const meta = {
    title: title || parsed.meta.title || "未命名规格",
    status: VALID_STATUS.has(status) ? status : parsed.meta.status || "draft",
    createdAt: parsed.meta.createdAt || createdAt || new Date().toISOString(),
    updatedAt: updatedAt || new Date().toISOString(),
  };
  const body = parsed.body.trim() || "# 规格文档\n\n（正文为空）";
  return [
    "---",
    `title: ${JSON.stringify(meta.title)}`,
    `status: ${meta.status}`,
    `createdAt: ${meta.createdAt}`,
    `updatedAt: ${meta.updatedAt}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function ensureSpecDir(workDir) {
  const dir = specDir(workDir);
  if (!dir) throw new Error("当前会话未绑定工作目录");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveSpec(workDir, { title, content, slug, status = "draft" } = {}) {
  try {
    if (!String(content || "").trim()) {
      return { success: false, error: "规格内容不能为空" };
    }
    if (Buffer.byteLength(String(content), "utf-8") > MAX_SPEC_BYTES) {
      return { success: false, error: "规格内容超过 512KB 上限" };
    }
    const dir = ensureSpecDir(workDir);
    const now = new Date();
    const stamp = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      "-",
      String(now.getHours()).padStart(2, "0"),
      String(now.getMinutes()).padStart(2, "0"),
      String(now.getSeconds()).padStart(2, "0"),
    ].join("");
    const base = `${stamp}-${slugify(slug || title)}`;
    let id = `${base}.md`;
    let counter = 2;
    while (fs.existsSync(path.join(dir, id))) {
      id = `${base}-${counter}.md`;
      counter += 1;
    }
    const filePath = path.join(dir, id);
    const fileContent = buildContent({ title, content, status });
    fs.writeFileSync(filePath, fileContent, "utf-8");
    return {
      success: true,
      id,
      path: filePath,
      title: title || "未命名规格",
      status,
    };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

function listSpecs(workDir) {
  try {
    const dir = specDir(workDir);
    if (!dir || !fs.existsSync(dir)) return [];
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .slice(0, MAX_SPECS);
    const items = [];
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(filePath);
        const head = fs.readFileSync(filePath, "utf-8").slice(0, 8192);
        const { meta } = parseFrontmatter(head);
        items.push({
          id: entry.name,
          title: meta.title || entry.name.replace(/\.md$/i, ""),
          status: VALID_STATUS.has(meta.status) ? meta.status : "draft",
          createdAt: meta.createdAt || new Date(stat.birthtimeMs).toISOString(),
          updatedAt: meta.updatedAt || new Date(stat.mtimeMs).toISOString(),
          size: stat.size,
          path: filePath,
        });
      } catch {
        // 跳过无法读取的文件
      }
    }
    return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  } catch {
    return [];
  }
}

function readSpec(workDir, id) {
  try {
    const name = safeSpecId(id);
    if (!name) return { success: false, error: "无效的规格文件名" };
    const dir = specDir(workDir);
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath)) return { success: false, error: "规格文档不存在" };
    const raw = fs.readFileSync(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    return {
      success: true,
      id: name,
      path: filePath,
      title: meta.title || name.replace(/\.md$/i, ""),
      status: VALID_STATUS.has(meta.status) ? meta.status : "draft",
      body,
      content: raw,
    };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

function updateSpecStatus(workDir, id, status) {
  const next = String(status || "").trim();
  if (!VALID_STATUS.has(next)) return { success: false, error: `无效的状态: ${next}` };
  const current = readSpec(workDir, id);
  if (!current.success) return current;
  try {
    const fileContent = buildContent({
      title: current.title,
      content: current.content,
      status: next,
      updatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(current.path, fileContent, "utf-8");
    return { success: true, id: current.id, status: next };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

function deleteSpec(workDir, id) {
  try {
    const name = safeSpecId(id);
    if (!name) return { success: false, error: "无效的规格文件名" };
    const dir = specDir(workDir);
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath)) return { success: false, error: "规格文档不存在" };
    fs.rmSync(filePath, { force: true });
    return { success: true, id: name };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

module.exports = {
  saveSpec,
  listSpecs,
  readSpec,
  updateSpecStatus,
  deleteSpec,
  specDir,
};
