const fs = require("fs");
const path = require("path");
const os = require("os");

const USER_HOME = os.homedir();
const LEGACY_AGNES_HOME = path.join(USER_HOME, ".agnes");
let OMCX_HOME = process.env.OMCX_HOME || process.env.AGNES_HOME || path.join(USER_HOME, ".omcx");
let CONFIG_FILE = path.join(OMCX_HOME, "config.json");
let MCP_FILE = path.join(OMCX_HOME, "mcp.json");
let SKILLS_DIR = path.join(OMCX_HOME, "skills");
let MEMORY_DIR = path.join(OMCX_HOME, "memory");
let SESSIONS_DIR = path.join(OMCX_HOME, "sessions");
let SESSIONS_INDEX_FILE = path.join(SESSIONS_DIR, "index.json");

function updatePaths(newRoot) {
  OMCX_HOME = newRoot;
  CONFIG_FILE = path.join(OMCX_HOME, "config.json");
  MCP_FILE = path.join(OMCX_HOME, "mcp.json");
  SKILLS_DIR = path.join(OMCX_HOME, "skills");
  MEMORY_DIR = path.join(OMCX_HOME, "memory");
  SESSIONS_DIR = path.join(OMCX_HOME, "sessions");
  SESSIONS_INDEX_FILE = path.join(SESSIONS_DIR, "index.json");
}

/**
 * 平滑迁移旧版本 ~/.agnes 数据至全新的 ~/.omcx
 */
function migrateFromLegacyAgnes() {
  try {
    if (!fs.existsSync(OMCX_HOME) && fs.existsSync(LEGACY_AGNES_HOME)) {
      console.log(`[storageService] 检测到旧版本数据目录 ${LEGACY_AGNES_HOME}，正在平滑迁移至 ${OMCX_HOME}...`);
      ensureDir(OMCX_HOME);
      fs.cpSync(LEGACY_AGNES_HOME, OMCX_HOME, { recursive: true });
      console.log(`[storageService] 数据平滑迁移完成！已保留全部历史会话、模型配置与密钥。`);
    }
  } catch (err) {
    console.error(`[storageService] 迁移旧版本数据失败:`, err.message);
  }
}

/**
 * 确保目录存在（带安全 fallback）
 */
function ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EACCES") {
      const defaultUserOmcx = path.join(USER_HOME, ".omcx");
      const fallbackRoot = path.join(process.cwd(), ".omcx_local");
      console.warn(`[storageService] 访问 ${dirPath} 权限不足，回退到本地目录: ${fallbackRoot}`);
      updatePaths(fallbackRoot);
      const targetPath = dirPath.startsWith(defaultUserOmcx)
        ? dirPath.replace(defaultUserOmcx, fallbackRoot)
        : fallbackRoot;
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true });
      }
    } else {
      throw err;
    }
  }
}

/**
 * 安全读取 JSON 文件
 */
function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    console.error(`[storageService] 读取 JSON 失败 (${filePath}):`, err.message);
    return fallback;
  }
}

/**
 * 安全写入 JSON 文件（格式化排版）
 */
function writeJsonSafe(filePath, data) {
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (err) {
    console.error(`[storageService] 写入 JSON 失败 (${filePath}):`, err.message);
    return false;
  }
}

/**
 * 初始化全局 ~/.omcx 目录结构与默认配置文件（带旧版本平滑迁移）
 */
function initStorage() {
  migrateFromLegacyAgnes();

  ensureDir(OMCX_HOME);
  ensureDir(SKILLS_DIR);
  ensureDir(MEMORY_DIR);
  ensureDir(SESSIONS_DIR);

  // 1. 初始化 config.json
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultConfig = {
      api_key: "",
      base_url: "https://api.openai.com/v1",
      default_model: "gpt-4o",
      save_path: "",
      search_provider: "duckduckgo",
      search_api_key: "",
      search_max_results: 5,
      llm_models: [
        {
          id: "model_chat_default",
          model_id: "gpt-4o",
          name: "GPT-4o",
          type: "chat",
          provider: "openai",
          base_url: "https://api.openai.com/v1",
          api_key: "",
        },
        {
          id: "model_claude_default",
          model_id: "claude-3-5-sonnet-20241022",
          name: "Claude 3.5 Sonnet",
          type: "chat",
          provider: "custom",
          base_url: "https://api.anthropic.com/v1",
          api_key: "",
        },
        {
          id: "model_ollama_default",
          model_id: "qwen2.5-coder:7b",
          name: "Ollama Qwen 2.5 Coder",
          type: "chat",
          provider: "ollama",
          base_url: "http://localhost:11434/v1",
          api_key: "",
        },
      ],
    };
    writeJsonSafe(CONFIG_FILE, defaultConfig);
  }

  // 2. 初始化标准 mcp.json (完全兼容 Claude Desktop / Cursor 格式)
  if (!fs.existsSync(MCP_FILE)) {
    const defaultMcp = {
      mcpServers: {
        context7: {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          env: {},
          description: "实时检索前沿开发文档与代码库示例",
          enabled: true,
        },
      },
    };
    writeJsonSafe(MCP_FILE, defaultMcp);
  }

  // 3. 初始化示例 Skill
  const defaultSkillPath = path.join(SKILLS_DIR, "code-review.md");
  if (!fs.existsSync(defaultSkillPath)) {
    const skillContent = `---
name: code-review
description: 对当前项目代码进行规范性、架构可维护性与潜在 Bug 审查
tools: [read_file, search_code, list_directory]
---

当用户要求进行代码审查或排查 Bug 时：
1. 先使用 list_directory 或 search_code 了解项目架构。
2. 使用 read_file 检查核心逻辑、异常边界处理与类型定义。
3. 提供条理清晰的问题定位与具体的修改对比建议。
`;
    fs.writeFileSync(defaultSkillPath, skillContent, "utf-8");
  }

  // 4. 初始化 Memory
  const memoryIndexPath = path.join(MEMORY_DIR, "MEMORY.md");
  if (!fs.existsSync(memoryIndexPath)) {
    const memoryIndexContent = `# Agnes AI Agent 记忆库索引

- [用户编码偏好与技术栈约定](user_profile.md)
`;
    fs.writeFileSync(memoryIndexPath, memoryIndexContent, "utf-8");
  }

  const userProfilePath = path.join(MEMORY_DIR, "user_profile.md");
  if (!fs.existsSync(userProfilePath)) {
    const profileContent = `---
name: user-profile
description: 用户偏好的开发环境、代码风格与语言习惯
category: user_preference
---

# 用户开发偏好
- 语言偏好: 中文回复
- 代码风格: 现代化 TypeScript / React 18 / Tailwind CSS / Node.js
- 架构原则: 模块高内聚低耦合，重视类型安全与边界异常捕获
`;
    fs.writeFileSync(userProfilePath, profileContent, "utf-8");
  }

  // 5. 初始化 sessions/index.json
  if (!fs.existsSync(SESSIONS_INDEX_FILE)) {
    writeJsonSafe(SESSIONS_INDEX_FILE, []);
  }

  console.log(`[storageService] 已就绪，根目录: ${OMCX_HOME}`);
}

// ─────────────────────────────────────────────────────────────
// 配置管理 (Config)
// ─────────────────────────────────────────────────────────────

function getAllConfig() {
  return readJsonSafe(CONFIG_FILE, {});
}

function getConfig(key) {
  const cfg = getAllConfig();
  return cfg[key] !== undefined ? cfg[key] : null;
}

function setConfig(key, value) {
  const cfg = getAllConfig();
  cfg[key] = value;
  return writeJsonSafe(CONFIG_FILE, cfg);
}

const VISION_MODEL_HINTS = [
  "gpt-4o",
  "gpt-4.1",
  "gpt-4-turbo",
  "gpt-4-vision",
  "gpt-5",
  "claude-3",
  "claude-4",
  "claude-sonnet",
  "claude-opus",
  "claude-haiku",
  "gemini",
  "glm-4v",
  "glm-4.5v",
  "glm-4.6v",
  "qwen-vl",
  "qwen2-vl",
  "qwen2.5-vl",
  "qwen3-vl",
  "llava",
  "pixtral",
  "vision",
  "internvl",
  "minicpm-v",
  "moondream",
  "yi-vl",
];

function inferVisionSupport(modelId) {
  const id = String(modelId || "").toLowerCase();
  if (!id) return false;
  return VISION_MODEL_HINTS.some((hint) => id.includes(hint));
}

function normalizeVisionFlag(model) {
  if (typeof model?.supports_vision === "boolean") return model.supports_vision;
  return inferVisionSupport(model?.model_id || model?.modelId || model?.name);
}

function getModels() {
  const cfg = getAllConfig();
  return (cfg.llm_models || []).map((model) => ({
    ...model,
    supports_vision: normalizeVisionFlag(model),
  }));
}

function addModel(model) {
  const cfg = getAllConfig();
  if (!cfg.llm_models) cfg.llm_models = [];
  const normalized = {
    id: model.id,
    model_id: model.model_id || model.modelId,
    name: model.name || model.model_id || model.modelId,
    type: model.type || "chat",
    provider: model.provider || "openai",
    base_url: model.base_url || model.baseUrl || "https://api.openai.com/v1",
    api_key: model.api_key !== undefined ? model.api_key : (model.apiKey || ""),
    context_limit: Number(model.context_limit || model.contextLimit) || 128000,
    supports_vision: normalizeVisionFlag(model),
  };
  const idx = cfg.llm_models.findIndex((m) => m.id === model.id);
  if (idx >= 0) {
    cfg.llm_models[idx] = { ...cfg.llm_models[idx], ...normalized };
  } else {
    cfg.llm_models.push(normalized);
  }
  writeJsonSafe(CONFIG_FILE, cfg);
  return { success: true, model: normalized };
}

function deleteModel(modelId) {
  const cfg = getAllConfig();
  if (cfg.llm_models) {
    cfg.llm_models = cfg.llm_models.filter((m) => m.id !== modelId);
    writeJsonSafe(CONFIG_FILE, cfg);
  }
  return { success: true };
}

// ─────────────────────────────────────────────────────────────
// 会话与消息管理 (Sessions & Messages)
// ─────────────────────────────────────────────────────────────

function getSessions() {
  return readJsonSafe(SESSIONS_INDEX_FILE, []);
}

function getSessionFilePath(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function getSessionAttachmentsDir(sessionId) {
  return path.join(SESSIONS_DIR, sessionId, "attachments");
}

function saveAttachmentBuffer(sessionId, id, ext, buffer) {
  const dir = getSessionAttachmentsDir(sessionId);
  ensureDir(dir);
  const filePath = path.join(dir, `${id}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return { id, path: filePath, size: buffer.length };
}

function isSessionAttachmentPath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  const resolved = path.resolve(filePath);
  const root = path.resolve(SESSIONS_DIR);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  return segments.length >= 3 && segments[1] === "attachments";
}

function deleteAttachmentFile(filePath) {
  if (!isSessionAttachmentPath(filePath)) {
    return { success: false, error: "非法附件路径" };
  }
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function deleteSessionAttachments(sessionId) {
  const sessionDir = path.join(SESSIONS_DIR, sessionId);
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[storageService] 删除会话附件目录失败: ${err.message}`);
  }
}

function saveSession(session) {
  const sessions = getSessions();
  const idx = sessions.findIndex((s) => s.id === session.id);
  const existing = idx >= 0 ? sessions[idx] : {};
  const now = Date.now();

  // 智能继承与兼容提取 work_dir (双向支持 work_dir 与 workDir，未传则 100% 继承已有值，绝不冲刷为 null)
  let resolvedWorkDir = existing.work_dir || null;
  if (session.work_dir !== undefined) {
    resolvedWorkDir = session.work_dir || null;
  } else if (session.workDir !== undefined) {
    resolvedWorkDir = session.workDir || null;
  }

  // 智能继承 title
  const resolvedTitle = session.title !== undefined ? (session.title || "新会话") : (existing.title || "新会话");

  // 智能继承 model
  const resolvedModel = session.model !== undefined ? (session.model || "") : (existing.model || "");

  // 智能继承 archived
  const resolvedArchived = session.archived !== undefined ? !!session.archived : !!existing.archived;

  // 智能继承 title_source (default / generated / custom)
  const resolvedTitleSource =
    session.title_source !== undefined
      ? session.title_source
      : existing.title_source || "default";

  const sessionSummary = {
    id: session.id,
    title: resolvedTitle,
    title_source: resolvedTitleSource,
    model: resolvedModel,
    work_dir: resolvedWorkDir,
    archived: resolvedArchived,
    updated_at: session.updated_at || now,
    created_at: existing.created_at || session.created_at || now,
  };

  if (idx >= 0) {
    sessions[idx] = { ...existing, ...sessionSummary };
  } else {
    sessions.unshift(sessionSummary);
  }
  writeJsonSafe(SESSIONS_INDEX_FILE, sessions);

  // 保证单会话文件存在且字段同步更新
  const filePath = getSessionFilePath(session.id);
  const detail = readJsonSafe(filePath, {
    ...sessionSummary,
    messages: [],
    outputs: [],
  });
  detail.title = sessionSummary.title;
  detail.title_source = sessionSummary.title_source;
  detail.model = sessionSummary.model;
  detail.work_dir = sessionSummary.work_dir;
  detail.archived = sessionSummary.archived;
  detail.updated_at = sessionSummary.updated_at;
  writeJsonSafe(filePath, detail);

  return { success: true, session: sessionSummary };
}

/**
 * 异步旁路更新 AI 生成的会话标题 (CAS 状态机：若已被用户手动自定义过则坚决不覆盖)
 */
function updateSessionGeneratedTitle(sessionId, title) {
  const sessions = getSessions();
  const target = sessions.find((s) => s.id === sessionId);
  if (!target) return false;

  // 铁律：用户手动起的标题绝对不覆盖
  if (target.title_source === "custom") {
    return false;
  }

  target.title = title;
  target.title_source = "generated";
  saveSession(target);
  return true;
}

function deleteSession(sessionId) {
  let sessions = getSessions();
  sessions = sessions.filter((s) => s.id !== sessionId);
  writeJsonSafe(SESSIONS_INDEX_FILE, sessions);

  const filePath = getSessionFilePath(sessionId);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`[storageService] 删除会话文件失败: ${err.message}`);
    }
  }
  deleteSessionAttachments(sessionId);
  return { success: true };
}

function getMessages(sessionId) {
  const filePath = getSessionFilePath(sessionId);
  const detail = readJsonSafe(filePath, { messages: [] });
  return detail.messages || [];
}

function addMessage(sessionId, message) {
  const filePath = getSessionFilePath(sessionId);
  const detail = readJsonSafe(filePath, {
    id: sessionId,
    messages: [],
    outputs: [],
  });

  const msgId = message.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const existingIdx = detail.messages.findIndex((m) => m.id === msgId);

  const fullMsg = {
    id: msgId,
    session_id: sessionId,
    role: message.role,
    content: message.content !== undefined ? message.content : "",
    tool_calls: message.tool_calls || null,
    tool_call_id: message.tool_call_id || null,
    created_at: message.created_at || (existingIdx >= 0 ? detail.messages[existingIdx].created_at : Date.now()),
    metadata: message.metadata !== undefined ? message.metadata : (existingIdx >= 0 ? detail.messages[existingIdx].metadata : null),
  };

  if (existingIdx >= 0) {
    // 严格原子覆盖更新 (Upsert)，防止并发产生重复空消息
    detail.messages[existingIdx] = fullMsg;
  } else {
    // 仅当不存在该 ID 时才追加新消息
    detail.messages.push(fullMsg);
  }

  detail.updated_at = Date.now();
  writeJsonSafe(filePath, detail);

  // 同步更新 index.json 的 updated_at
  const sessions = getSessions();
  const sessionItem = sessions.find((s) => s.id === sessionId);
  if (sessionItem) {
    sessionItem.updated_at = detail.updated_at;
    writeJsonSafe(SESSIONS_INDEX_FILE, sessions);
  }

  return { success: true, message: fullMsg };
}

function deleteMessagesAfter(sessionId, timestamp) {
  const filePath = getSessionFilePath(sessionId);
  const detail = readJsonSafe(filePath, { messages: [] });
  detail.messages = detail.messages.filter((m) => m.created_at <= timestamp);
  writeJsonSafe(filePath, detail);
  return { success: true };
}

// ─────────────────────────────────────────────────────────────
// MCP 服务配置读取 (合并全局与项目级)
// ─────────────────────────────────────────────────────────────

function getMcpServers(workDir = null) {
  const globalMcp = readJsonSafe(MCP_FILE, { mcpServers: {} });
  let servers = { ...(globalMcp.mcpServers || {}) };

  // 若存在项目级 .omcx/mcp.json 或旧版 .agnes/mcp.json，就地合并
  if (workDir) {
    const projectMcpCandidates = [
      path.join(workDir, ".omcx", "mcp.json"),
      path.join(workDir, ".agnes", "mcp.json"),
    ];
    for (const projectMcpFile of projectMcpCandidates) {
      if (fs.existsSync(projectMcpFile)) {
        const projectMcp = readJsonSafe(projectMcpFile, { mcpServers: {} });
        servers = { ...servers, ...(projectMcp.mcpServers || {}) };
        break;
      }
    }
  }

  // 格式化输出为数组供 UI 展示
  return Object.entries(servers).map(([key, item]) => ({
    id: key,
    name: key,
    command: item.command,
    args: item.args || [],
    env: item.env || {},
    description: item.description || "",
    enabled: item.enabled !== false,
  }));
}

function saveGlobalMcpServers(serversMap) {
  return writeJsonSafe(MCP_FILE, { mcpServers: serversMap });
}

// ─────────────────────────────────────────────────────────────
// 技能 (Skills) 扫描与读取
// ─────────────────────────────────────────────────────────────

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
    }

    return {
      id: `${scope}:${name}`,
      name,
      description,
      tools,
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
          } catch {
            // 忽略子目录读取错误
          }
        }
      }
    }
  } catch (err) {
    console.error(`[storageService] 扫描 Skills 目录失败 (${targetDir}):`, err.message);
  }

  return result;
}

function getSkills(workDir = null) {
  const skillsMap = new Map();

  // 1. 全局路径扫描 (scope: "global")
  const globalDirs = [
    path.join(USER_HOME, ".agents", "skills"),
    path.join(USER_HOME, ".omcx", "skills"),
    path.join(USER_HOME, ".agnes", "skills"),
  ];

  for (const dir of globalDirs) {
    const items = scanSkillsDir(dir, "global");
    for (const item of items) {
      if (!skillsMap.has(item.name)) {
        skillsMap.set(item.name, item);
      }
    }
  }

  // 2. 项目专属路径扫描 (scope: "project"，优先覆盖全局同名技能)
  if (workDir) {
    const projectDirs = [
      path.join(workDir, ".agents", "skills"),
      path.join(workDir, ".omcx", "skills"),
      path.join(workDir, ".agnes", "skills"),
    ];

    for (const dir of projectDirs) {
      const items = scanSkillsDir(dir, "project");
      for (const item of items) {
        skillsMap.set(item.name, item);
      }
    }
  }

  const list = Array.from(skillsMap.values());
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

// ─────────────────────────────────────────────────────────────
// 记忆库 (Memory) 读取
// ─────────────────────────────────────────────────────────────

function getMemories(workDir = null) {
  const memories = [];

  // 全局记忆
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

  // 项目级记忆
  if (workDir) {
    const memDirCandidates = [
      path.join(workDir, ".omcx", "memory"),
      path.join(workDir, ".agnes", "memory"),
    ];
    for (const projMemDir of memDirCandidates) {
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
        break;
      }
    }
  }

  return memories;
}

const PROJECT_RULES_BUDGET = 8000;

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
    const projectIndexCandidates = [
      path.join(workDir, ".omcx", "memory", "MEMORY.md"),
      path.join(workDir, ".agnes", "memory", "MEMORY.md"),
    ];
    for (const projectIndex of projectIndexCandidates) {
      if (fs.existsSync(projectIndex)) {
        indexes.push({
          scope: "project",
          path: projectIndex,
          content: fs.readFileSync(projectIndex, "utf-8"),
        });
        break;
      }
    }
  }

  return indexes;
}

// ─────────────────────────────────────────────────────────────
// 导出产物管理 (Outputs)
// ─────────────────────────────────────────────────────────────

function getSessionOutputs(sessionId) {
  const filePath = getSessionFilePath(sessionId);
  const detail = readJsonSafe(filePath, { outputs: [] });
  return detail.outputs || [];
}

function addSessionOutput(sessionId, outputItem) {
  const filePath = getSessionFilePath(sessionId);
  const detail = readJsonSafe(filePath, { outputs: [] });
  if (!detail.outputs) detail.outputs = [];

  const exists = detail.outputs.some((o) => o.filePath === outputItem.filePath);
  if (!exists) {
    detail.outputs.push({
      id: `out_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: outputItem.name,
      filePath: outputItem.filePath,
      fileType: outputItem.fileType || "document",
      createdAt: Date.now(),
    });
    writeJsonSafe(filePath, detail);
  }
  return detail.outputs;
}

// ─────────────────────────────────────────────────────────────
// 多源文件夹工作空间管理 (Multi-Folder Workspaces)
// ─────────────────────────────────────────────────────────────

function getWorkspaces() {
  const cfg = getAllConfig();
  if (Array.isArray(cfg.workspaces) && cfg.workspaces.length > 0) {
    return cfg.workspaces;
  }
  // 预置完全符合参考图 8 的初始多目录工作空间
  const initialWorkspaces = [
    {
      id: "ws_default",
      name: "notifycenter",
      folders: [
        { path: "/opt/projects/notifycenter", name: "notifycenter", isPrimary: true },
        { path: "/opt/projects/silence-fastapi", name: "silence-fastapi", isPrimary: false },
        { path: "/opt/projects/alarmcenter-fastapi", name: "alarmcenter-fastapi", isPrimary: false },
      ],
      updatedAt: Date.now(),
    },
    {
      id: "ws_current",
      name: "OMCX (当前工程)",
      folders: [
        { path: process.cwd(), name: "OMCX", isPrimary: true },
      ],
      updatedAt: Date.now() - 3600000,
    },
  ];
  return initialWorkspaces;
}

function saveWorkspace(ws) {
  const cfg = getAllConfig();
  if (!Array.isArray(cfg.workspaces)) {
    cfg.workspaces = getWorkspaces();
  }
  const idx = cfg.workspaces.findIndex((w) => w.id === ws.id);
  const now = Date.now();
  const item = {
    id: ws.id || `ws_${now}_${Math.random().toString(36).slice(2, 6)}`,
    name: ws.name || "新工作空间",
    folders: Array.isArray(ws.folders) ? ws.folders : [],
    updatedAt: now,
  };

  if (idx >= 0) {
    cfg.workspaces[idx] = item;
  } else {
    cfg.workspaces.unshift(item);
  }
  writeJsonSafe(CONFIG_FILE, cfg);
  return { success: true, workspace: item };
}

function deleteWorkspace(id) {
  const cfg = getAllConfig();
  if (Array.isArray(cfg.workspaces)) {
    cfg.workspaces = cfg.workspaces.filter((w) => w.id !== id);
    writeJsonSafe(CONFIG_FILE, cfg);
  }
  return { success: true };
}

// ─────────────────────────────────────────────────────────────
// 最近项目管理 (Recent Projects)
// ─────────────────────────────────────────────────────────────

function getRecentProjects() {
  const cfg = getAllConfig();
  if (Array.isArray(cfg.recent_projects) && cfg.recent_projects.length > 0) {
    return cfg.recent_projects;
  }
  return [
    { id: 'p1', name: 'notifycenter', path: '/opt/projects/notifycenter', hasChanges: true, isLoading: true },
    { id: 'p2', name: 'silence-fastapi', path: '/opt/projects/silence-fastapi', hasChanges: false, isLoading: false },
    { id: 'p3', name: 'alarmcenter-fastapi', path: '/opt/projects/alarmcenter-fastapi', hasChanges: false, isLoading: false },
  ];
}

function addRecentProject(proj) {
  const cfg = getAllConfig();
  if (!Array.isArray(cfg.recent_projects)) {
    cfg.recent_projects = getRecentProjects();
  }
  cfg.recent_projects = cfg.recent_projects.filter((p) => p.path !== proj.path);
  cfg.recent_projects.unshift(proj);
  if (cfg.recent_projects.length > 15) {
    cfg.recent_projects = cfg.recent_projects.slice(0, 15);
  }
  writeJsonSafe(CONFIG_FILE, cfg);
  return cfg.recent_projects;
}

module.exports = {
  OMCX_HOME,
  AGNES_HOME: OMCX_HOME,
  initStorage,
  getAllConfig,
  getConfig,
  setConfig,
  getModels,
  addModel,
  deleteModel,
  getRecentProjects,
  addRecentProject,
  getWorkspaces,
  saveWorkspace,
  deleteWorkspace,
  getSessions,
  saveSession,
  updateSessionGeneratedTitle,
  deleteSession,
  getMessages,
  addMessage,
  deleteMessagesAfter,
  saveAttachmentBuffer,
  deleteAttachmentFile,
  deleteSessionAttachments,
  isSessionAttachmentPath,
  inferVisionSupport,
  getMcpServers,
  saveGlobalMcpServers,
  getSkills,
  getMemories,
  getMemoryIndex,
  getProjectInstructions,
  getSessionOutputs,
  addSessionOutput,
};
