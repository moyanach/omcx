export type ConnectorCategory = "office" | "dev" | "utility" | "custom";

export interface ConnectorFieldSpec {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "directory" | "select";
  placeholder?: string;
  required?: boolean;
  helper?: string;
  defaultValue?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface ConnectorPreset {
  id: string;
  defaultServerId: string;
  name: string;
  subtitle: string;
  category: ConnectorCategory;
  badge?: string;
  description: string;
  fields: ConnectorFieldSpec[];
  buildConfig: (values: Record<string, string>) => Record<string, any>;
}

export const CONNECTOR_CATEGORIES: Array<{ id: "all" | ConnectorCategory; label: string }> = [
  { id: "all", label: "全部" },
  { id: "office", label: "办公协作" },
  { id: "dev", label: "研发效率" },
  { id: "utility", label: "基础工具" },
  { id: "custom", label: "自定义" },
];

export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    id: "feishu",
    defaultServerId: "feishu",
    name: "飞书 (Feishu / Lark)",
    subtitle: "云文档、多维表格、日历与消息协同",
    category: "office",
    badge: "优先推荐",
    description:
      "支持飞书官方开放平台本地 CLI (@larksuiteoapi/lark-mcp) 或远程 MCP 端点接入，实现文档检索、读取与消息发送。",
    fields: [
      {
        key: "mode",
        label: "接入方式",
        type: "select",
        defaultValue: "stdio",
        options: [
          { label: "本地官方 MCP CLI (App ID / Secret)", value: "stdio" },
          { label: "远程 MCP 服务 URL (HTTP / SSE)", value: "remote" },
        ],
      },
      {
        key: "appId",
        label: "飞书 App ID（本地模式必填）",
        type: "text",
        placeholder: "cli_xxxxxxxxxxxxxxxx",
        helper: "在飞书开放平台应用凭证中获取；若选远程 URL 模式可留空",
      },
      {
        key: "appSecret",
        label: "飞书 App Secret（本地模式必填）",
        type: "password",
        placeholder: "输入 App Secret",
      },
      {
        key: "url",
        label: "远程 MCP URL（远程模式必填）",
        type: "url",
        placeholder: "https://open.feishu.cn/mcp/...",
      },
      {
        key: "authToken",
        label: "Bearer Token（远程模式可选）",
        type: "password",
        placeholder: "若远程端点需要鉴权可填写",
      },
    ],
    buildConfig: (v) => {
      if (v.mode === "remote") {
        return {
          url: (v.url || "").trim(),
          transport: "http",
          ...(v.authToken?.trim() ? { authToken: v.authToken.trim() } : {}),
          description: "飞书 (Feishu / Lark) 远程 MCP 连接器",
          enabled: true,
        };
      }
      const args = ["-y", "@larksuiteoapi/lark-mcp", "mcp"];
      if (v.appId?.trim()) args.push("-a", v.appId.trim());
      if (v.appSecret?.trim()) args.push("-s", v.appSecret.trim());
      return {
        command: "npx",
        args,
        description: "飞书 (Feishu / Lark) 官方 MCP 连接器",
        enabled: true,
      };
    },
  },
  {
    id: "dingtalk",
    defaultServerId: "dingtalk",
    name: "钉钉 (DingTalk)",
    subtitle: "钉钉文档、日程、待办与群协同",
    category: "office",
    badge: "优先推荐",
    description:
      "接入钉钉 MCP 广场生成的专属 Streamable HTTP / SSE 地址，快速让 Agent 读写钉钉文档、查询待办或发群消息。",
    fields: [
      {
        key: "transport",
        label: "传输协议",
        type: "select",
        defaultValue: "http",
        options: [
          { label: "Streamable HTTP (推荐)", value: "http" },
          { label: "SSE", value: "sse" },
        ],
      },
      {
        key: "url",
        label: "钉钉 MCP 端点 URL",
        type: "url",
        required: true,
        placeholder: "https://mcp-gw.dingtalk.com/...",
        helper: "可在钉钉开放平台 / MCP 广场复制专属 MCP 服务 URL",
      },
      {
        key: "authToken",
        label: "鉴权 Token（可选）",
        type: "password",
        placeholder: "若 URL 未自带签名可填写 Bearer Token",
      },
    ],
    buildConfig: (v) => ({
      url: (v.url || "").trim(),
      transport: v.transport === "sse" ? "sse" : "http",
      ...(v.authToken?.trim() ? { authToken: v.authToken.trim() } : {}),
      description: "钉钉 (DingTalk) MCP 连接器",
      enabled: true,
    }),
  },
  {
    id: "wecom",
    defaultServerId: "wecom",
    name: "企业微信 (WeCom)",
    subtitle: "企业微信文档、日程与内部机器人推送",
    category: "office",
    badge: "优先推荐",
    description:
      "支持填入企业微信开放平台/网关提供的远程 MCP 服务地址，快速打通企业微信消息推送与文档协同。",
    fields: [
      {
        key: "transport",
        label: "传输协议",
        type: "select",
        defaultValue: "http",
        options: [
          { label: "Streamable HTTP (推荐)", value: "http" },
          { label: "SSE", value: "sse" },
        ],
      },
      {
        key: "url",
        label: "企业微信 MCP URL",
        type: "url",
        required: true,
        placeholder: "https://...",
        helper: "填写企业微信 MCP 网关地址或自建企业微信 MCP 代理端点",
      },
      {
        key: "authToken",
        label: "访问密钥 / Bearer Token（可选）",
        type: "password",
        placeholder: "输入 Bearer Token",
      },
    ],
    buildConfig: (v) => ({
      url: (v.url || "").trim(),
      transport: v.transport === "sse" ? "sse" : "http",
      ...(v.authToken?.trim() ? { authToken: v.authToken.trim() } : {}),
      description: "企业微信 (WeCom) MCP 连接器",
      enabled: true,
    }),
  },
  {
    id: "jira",
    defaultServerId: "jira",
    name: "Jira (Atlassian)",
    subtitle: "Issue 检索、工单创建与 Sprint 看板",
    category: "office",
    badge: "优先推荐",
    description:
      "支持 Atlassian 官方云端 OAuth MCP（免配本地环境），或通过 uvx mcp-atlassian 连接自建 Jira Server/Data Center。",
    fields: [
      {
        key: "mode",
        label: "接入模式",
        type: "select",
        defaultValue: "remote_oauth",
        options: [
          { label: "Atlassian 官方云端 (SSE + OAuth 登录)", value: "remote_oauth" },
          { label: "本地 mcp-atlassian (Jira URL + Token)", value: "stdio" },
        ],
      },
      {
        key: "jiraUrl",
        label: "Jira 站点 URL（本地模式必填）",
        type: "url",
        placeholder: "https://your-company.atlassian.net",
      },
      {
        key: "jiraUsername",
        label: "Jira 账号邮箱（本地模式必填）",
        type: "text",
        placeholder: "name@company.com",
      },
      {
        key: "jiraToken",
        label: "Jira API Token（本地模式必填）",
        type: "password",
        placeholder: "输入 Atlassian API Token",
      },
    ],
    buildConfig: (v) => {
      if (v.mode !== "stdio") {
        return {
          url: "https://mcp.atlassian.com/v1/sse",
          transport: "sse",
          oauth: true,
          description: "Atlassian Jira / Confluence 官方远程 MCP（添加后点击 OAuth 授权）",
          enabled: true,
        };
      }
      const env: Record<string, string> = {};
      if (v.jiraUrl?.trim()) env.JIRA_URL = v.jiraUrl.trim();
      if (v.jiraUsername?.trim()) env.JIRA_USERNAME = v.jiraUsername.trim();
      if (v.jiraToken?.trim()) env.JIRA_API_TOKEN = v.jiraToken.trim();
      return {
        command: "uvx",
        args: ["mcp-atlassian"],
        env,
        description: "Jira (mcp-atlassian) 本地连接器",
        enabled: true,
      };
    },
  },
  {
    id: "notion",
    defaultServerId: "notion",
    name: "Notion",
    subtitle: "知识库页面读写、数据库检索",
    category: "office",
    description:
      "支持 Notion 官方 OAuth 远程 MCP，或使用 Integration Token 通过本地 @notionhq/notion-mcp-server 接入。",
    fields: [
      {
        key: "mode",
        label: "接入模式",
        type: "select",
        defaultValue: "remote_oauth",
        options: [
          { label: "Notion 官方云端 (Streamable HTTP + OAuth)", value: "remote_oauth" },
          { label: "本地 Token 模式 (@notionhq/notion-mcp-server)", value: "stdio" },
        ],
      },
      {
        key: "notionToken",
        label: "Notion Integration Token（本地模式必填）",
        type: "password",
        placeholder: "ntn_xxxxxxxxxxxxxxxxxxxx",
      },
    ],
    buildConfig: (v) => {
      if (v.mode !== "stdio") {
        return {
          url: "https://mcp.notion.com/mcp",
          transport: "http",
          oauth: true,
          description: "Notion 官方远程 MCP（添加后点击 OAuth 授权）",
          enabled: true,
        };
      }
      return {
        command: "npx",
        args: ["-y", "@notionhq/notion-mcp-server"],
        env: v.notionToken?.trim() ? { NOTION_TOKEN: v.notionToken.trim() } : {},
        description: "Notion 本地 MCP 连接器",
        enabled: true,
      };
    },
  },
  {
    id: "slack",
    defaultServerId: "slack",
    name: "Slack",
    subtitle: "频道消息检索与团队通知发送",
    category: "office",
    description: "通过 Bot Token 连接 Slack 工作区频道、历史线程与消息发送。",
    fields: [
      {
        key: "botToken",
        label: "Slack Bot Token",
        type: "password",
        required: true,
        placeholder: "xoxb-xxxxxxxxxxxx",
      },
      {
        key: "teamId",
        label: "Slack Team ID",
        type: "text",
        required: true,
        placeholder: "T01234567",
      },
    ],
    buildConfig: (v) => ({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: {
        ...(v.botToken?.trim() ? { SLACK_BOT_TOKEN: v.botToken.trim() } : {}),
        ...(v.teamId?.trim() ? { SLACK_TEAM_ID: v.teamId.trim() } : {}),
      },
      description: "Slack 团队协作连接器",
      enabled: true,
    }),
  },
  {
    id: "github",
    defaultServerId: "github",
    name: "GitHub",
    subtitle: "Issue、PR 评审与仓库检索",
    category: "dev",
    description: "管理 GitHub 仓库 Issue、Pull Request、分支和代码搜索。",
    fields: [
      {
        key: "token",
        label: "Personal Access Token (PAT)",
        type: "password",
        required: true,
        placeholder: "ghp_xxxxxxxxxxxxxxxxxxxx",
      },
    ],
    buildConfig: (v) => ({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: v.token?.trim() ? { GITHUB_PERSONAL_ACCESS_TOKEN: v.token.trim() } : {},
      description: "GitHub 研发协同连接器",
      enabled: true,
    }),
  },
  {
    id: "postgres",
    defaultServerId: "postgres",
    name: "PostgreSQL",
    subtitle: "结构化数据库表结构查看与只读查询",
    category: "dev",
    description: "让 Agent 安全查询数据库 Schema 与统计分析业务数据。",
    fields: [
      {
        key: "connUrl",
        label: "PostgreSQL 连接串",
        type: "password",
        required: true,
        placeholder: "postgresql://user:password@127.0.0.1:5432/dbname",
      },
    ],
    buildConfig: (v) => ({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", (v.connUrl || "").trim()],
      description: "PostgreSQL 数据库查询连接器",
      enabled: true,
    }),
  },
  {
    id: "fetch",
    defaultServerId: "fetch",
    name: "Fetch (网页深度抓取)",
    subtitle: "标准网页抓取与 Markdown 转换",
    category: "utility",
    description: "使用官方 mcp-server-fetch 将在线文档、公告页面转换为结构化文本（需本地安装 uv/uvx）。",
    fields: [],
    buildConfig: () => ({
      command: "uvx",
      args: ["mcp-server-fetch"],
      description: "官方 Fetch 网页抓取连接器",
      enabled: true,
    }),
  },
  {
    id: "filesystem",
    defaultServerId: "filesystem",
    name: "Filesystem (扩展授权目录)",
    subtitle: "安全开放桌面/下载等额外本地文件夹",
    category: "utility",
    description: "授权 Agent 访问当前工作空间之外的指定常用资料目录（如 ~/Documents）。",
    fields: [
      {
        key: "dirPath",
        label: "授权访问目录路径",
        type: "directory",
        required: true,
        placeholder: "/Users/yourname/Documents",
      },
    ],
    buildConfig: (v) => ({
      command: "npx",
      args: [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        (v.dirPath || "").trim(),
      ].filter(Boolean),
      description: `授权本地目录访问 (${(v.dirPath || "").trim() || "未指定"})`,
      enabled: true,
    }),
  },
  {
    id: "custom",
    defaultServerId: "custom-mcp",
    name: "自定义连接器",
    subtitle: "手动配置 Stdio 命令或 HTTP/SSE 端点",
    category: "custom",
    description: "兼容任何标准 MCP 协议服务（支持 Stdio 本地进程、Streamable HTTP 与 SSE）。",
    fields: [
      {
        key: "transport",
        label: "连接协议",
        type: "select",
        defaultValue: "http",
        options: [
          { label: "Streamable HTTP", value: "http" },
          { label: "SSE", value: "sse" },
          { label: "Stdio 本地进程", value: "stdio" },
        ],
      },
      {
        key: "url",
        label: "服务 URL（HTTP / SSE 模式）",
        type: "url",
        placeholder: "https://example.com/mcp",
      },
      {
        key: "authToken",
        label: "Bearer Token（HTTP / SSE 可选）",
        type: "password",
        placeholder: "输入访问令牌",
      },
      {
        key: "command",
        label: "启动命令（Stdio 模式）",
        type: "text",
        placeholder: "npx 或 uvx 或 node",
      },
      {
        key: "argsText",
        label: "命令参数（Stdio 模式，空格分隔）",
        type: "text",
        placeholder: "-y @example/mcp-server",
      },
    ],
    buildConfig: (v) => {
      if (v.transport === "stdio") {
        const args = (v.argsText || "")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        return {
          command: (v.command || "npx").trim(),
          args,
          description: v.description?.trim() || "自定义 Stdio MCP 连接器",
          enabled: true,
        };
      }
      return {
        url: (v.url || "").trim(),
        transport: v.transport === "sse" ? "sse" : "http",
        ...(v.authToken?.trim() ? { authToken: v.authToken.trim() } : {}),
        description: v.description?.trim() || "自定义远程 MCP 连接器",
        enabled: true,
      };
    },
  },
];
