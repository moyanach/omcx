const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * 原子写文件：同目录临时文件 + fsync + rename，避免进程崩溃/断电留下半截 JSON。
 */
function writeFileAtomicSync(targetPath, content, ensureDir) {
  const dir = path.dirname(targetPath);
  ensureDir(dir);
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`
  );
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, content, "utf-8");
    try {
      fs.fsyncSync(fd);
    } catch {}
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, targetPath);
}

function createMcpStorage({ getConfig, setConfig, getPaths, ensureDir }) {
  function getProjectMcpConfigPath(workDir) {
    if (!workDir || typeof workDir !== "string" || !workDir.trim()) return null;
    return path.join(path.resolve(workDir.trim()), ".omcx", "mcp.json");
  }

  function readProjectMcpConfig(workDir) {
    const projectMcpFile = getProjectMcpConfigPath(workDir);
    if (!projectMcpFile || !fs.existsSync(projectMcpFile)) {
      return { servers: null, fingerprint: null, configPath: projectMcpFile };
    }
    try {
      const raw = fs.readFileSync(projectMcpFile, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        servers: parsed?.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {},
        fingerprint: crypto.createHash("sha256").update(raw).digest("hex"),
        configPath: projectMcpFile,
      };
    } catch {
      return { servers: null, fingerprint: null, configPath: projectMcpFile };
    }
  }

  function getProjectMcpTrustMap() {
    const map = getConfig("mcp_project_trust");
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  }

  function isProjectMcpTrusted(workDir, fingerprint) {
    if (!workDir || !fingerprint) return false;
    const trustedFingerprint = getProjectMcpTrustMap()[path.resolve(workDir.trim())];
    return Boolean(trustedFingerprint && trustedFingerprint === fingerprint);
  }

  function setProjectMcpTrust(workDir, trusted) {
    if (!workDir || typeof workDir !== "string" || !workDir.trim()) {
      return { success: false, error: "缺少工作目录" };
    }
    const resolvedDir = path.resolve(workDir.trim());
    const map = { ...getProjectMcpTrustMap() };

    if (trusted) {
      const { fingerprint, configPath, servers } = readProjectMcpConfig(resolvedDir);
      if (!servers || !fingerprint) {
        return { success: false, error: `未找到有效的项目级 MCP 配置: ${configPath || resolvedDir}` };
      }
      map[resolvedDir] = fingerprint;
    } else {
      delete map[resolvedDir];
    }

    setConfig("mcp_project_trust", map);
    return { success: true, trusted: Boolean(trusted) };
  }

  function isProjectHooksTrusted(workDir) {
    if (!workDir || typeof workDir !== "string" || !workDir.trim()) return false;
    const map = getConfig("hooks_project_trust");
    return Boolean(map && map[path.resolve(workDir.trim())] === true);
  }

  function setProjectHooksTrust(workDir, trusted) {
    if (!workDir || typeof workDir !== "string" || !workDir.trim()) {
      return { success: false, error: "缺少工作目录" };
    }
    const map = { ...(getConfig("hooks_project_trust") || {}) };
    const key = path.resolve(workDir.trim());
    if (trusted) {
      map[key] = true;
    } else {
      delete map[key];
    }
    setConfig("hooks_project_trust", map);
    return { success: true, trusted: Boolean(trusted) };
  }

  function getMcpServers(workDir = null) {
    const { MCP_FILE } = getPaths();
    let globalServers = {};
    if (fs.existsSync(MCP_FILE)) {
      try {
        const globalMcp = JSON.parse(fs.readFileSync(MCP_FILE, "utf-8"));
        globalServers = { ...(globalMcp.mcpServers || {}) };
      } catch {}
    }

    const project = workDir ? readProjectMcpConfig(workDir) : { servers: null, fingerprint: null };
    const projectServers = project.servers || {};
    const projectTrusted = isProjectMcpTrusted(workDir, project.fingerprint);
    const merged = { ...globalServers, ...projectServers };

    return Object.entries(merged).map(([key, item]) => {
      const isProject = Object.prototype.hasOwnProperty.call(projectServers, key);
      return {
        id: key,
        name: key,
        command: item.command,
        args: item.args || [],
        env: item.env || {},
        url: item.url,
        transport: item.transport || (item.url ? "http" : "stdio"),
        headers: item.headers || {},
        authToken: item.authToken || "",
        oauth: item.oauth || null,
        auth: item.auth && typeof item.auth === "object" ? item.auth : null,
        disabledTools: Array.isArray(item.disabledTools) ? item.disabledTools : [],
        description: item.description || "",
        enabled: item.enabled !== false,
        source: isProject ? "project" : "global",
        trusted: isProject ? projectTrusted : true,
        requiresTrust: isProject && !projectTrusted,
        fingerprint: isProject ? project.fingerprint : null,
      };
    });
  }

  function saveGlobalMcpServers(serversMap) {
    const { MCP_FILE } = getPaths();
    ensureDir(path.dirname(MCP_FILE));
    let existingServers = {};
    try {
      if (fs.existsSync(MCP_FILE)) {
        existingServers = JSON.parse(fs.readFileSync(MCP_FILE, "utf-8"))?.mcpServers || {};
      }
    } catch {}

    const cleanServers = {};
    for (const [id, item] of Object.entries(serversMap || {})) {
      if (!item || typeof item !== "object") continue;
      const clean = {};
      if (typeof item.command === "string") clean.command = item.command;
      if (Array.isArray(item.args)) clean.args = item.args;
      if (typeof item.url === "string" && item.url.trim()) clean.url = item.url.trim();
      if (typeof item.transport === "string") clean.transport = item.transport;
      if (item.headers && typeof item.headers === "object") {
        clean.headers = Object.fromEntries(
          Object.entries(item.headers).filter(
            ([key, value]) => key && (typeof value === "string" || typeof value === "number")
          )
        );
      }
      if (typeof item.authToken === "string" && item.authToken.trim()) {
        clean.authToken = item.authToken.trim();
      }
      if (typeof item.oauth === "boolean") {
        clean.oauth = item.oauth;
      } else if (item.oauth && typeof item.oauth === "object" && !Array.isArray(item.oauth)) {
        const oauthKeys = [
          "scopes",
          "clientId",
          "clientSecret",
          "clientAuthMethod",
          "authorizationEndpoint",
          "tokenEndpoint",
          "registrationEndpoint",
          "issuer",
          "redirectPort",
        ];
        clean.oauth = Object.fromEntries(
          Object.entries(item.oauth).filter(([key, value]) => {
            if (!oauthKeys.includes(key)) return false;
            return (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean" ||
              Array.isArray(value)
            );
          })
        );
      }
      if (item.auth && typeof item.auth === "object" && !Array.isArray(item.auth)) {
        if (typeof item.auth.type === "string") {
          clean.auth = { type: item.auth.type };
        }
      }
      if (Array.isArray(item.disabledTools)) {
        clean.disabledTools = item.disabledTools
          .map((name) => String(name || "").trim())
          .filter(Boolean);
      }
      const incomingEnv = item.env && typeof item.env === "object" ? item.env : null;
      if (incomingEnv && Object.keys(incomingEnv).length > 0) {
        clean.env = incomingEnv;
      } else if (existingServers[id]?.env && typeof existingServers[id].env === "object") {
        clean.env = existingServers[id].env;
      } else if (incomingEnv) {
        clean.env = incomingEnv;
      }
      if (typeof item.description === "string") clean.description = item.description;
      if (typeof item.enabled === "boolean") clean.enabled = item.enabled;
      cleanServers[id] = clean;
    }
    writeFileAtomicSync(MCP_FILE, JSON.stringify({ mcpServers: cleanServers }, null, 2), ensureDir);
    return true;
  }

  function deleteGlobalMcpServer(id) {
    const { MCP_FILE } = getPaths();
    const serverId = String(id || "").trim();
    if (!serverId) return { success: false, error: "缺少服务器 ID" };

    let globalServers = {};
    try {
      if (fs.existsSync(MCP_FILE)) {
        globalServers = JSON.parse(fs.readFileSync(MCP_FILE, "utf-8"))?.mcpServers || {};
      }
    } catch {
      return { success: false, error: "读取全局 MCP 配置失败" };
    }
    if (!Object.prototype.hasOwnProperty.call(globalServers, serverId)) {
      return { success: false, error: "未找到该全局 MCP 服务器" };
    }
    delete globalServers[serverId];
    saveGlobalMcpServers(globalServers);
    return { success: true };
  }

  return {
    getProjectMcpConfigPath,
    readProjectMcpConfig,
    isProjectMcpTrusted,
    setProjectMcpTrust,
    isProjectHooksTrusted,
    setProjectHooksTrust,
    getMcpServers,
    saveGlobalMcpServers,
    deleteGlobalMcpServer,
  };
}

module.exports = { createMcpStorage, writeFileAtomicSync };
