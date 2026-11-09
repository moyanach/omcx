# OMCX Desktop

<p align="center">
  <img src="build/icon.icns" width="128" height="128" alt="OMCX Desktop Logo" />
</p>

<p align="center">
  <strong>专为大型复杂工程研发打造的专业 AI Coding Agent 桌面客户端</strong><br/>
  自主规划 · 精准编码 · 上下文自愈 · 深度契合开发者直觉
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-v2.1.0-blue.svg" alt="Version 2.1.0" />
  <img src="https://img.shields.io/badge/platform-macOS%20(Apple%20Silicon%20%2F%20Intel)-black.svg" alt="Platform" />
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License" />
  <img src="https://img.shields.io/badge/electron-29-cyan.svg" alt="Electron 29" />
  <img src="https://img.shields.io/badge/react-18-61dafb.svg" alt="React 18" />
</p>

---

## 💡 什么是 OMCX？

**OMCX Desktop** 是一款专为工程师打造的自主 AI Coding Agent 桌面应用。不同于普通的代码补全插件或简单的问答式聊天机器人，OMCX 是一个具有工程自主权的**全功能桌面工作台**。

它能够自主浏览和检索大型项目目录、规划复杂工单任务、精准局部修改代码、审查 Git 变更、在沙箱终端中运行验证命令，并通过标准 MCP 协议与声明式 Skills 灵活扩充工具边界。无论面对数万行老代码的重构、跨模块功能开发还是疑难 Bug 修复，OMCX 都能以极高的完成率自主交付可运行的工程产物。

---

## ✨ 核心功能一览

### 🤖 1. 自主工程 Coding Agent

* **多轮自主工具循环（Agent Loop）**：大模型根据任务目标自主推理、按需调用文件系统、终端和网络工具，自动解决中间报错并持续推进，直到交付完整成果。
* **任务工单状态机（Todo Engine）**：内置智能任务规划器，实时将复杂需求拆解为结构化待办清单，动态推进 `pending` ➔ `in_progress` ➔ `completed` 状态，执行进度一目了然。
* **子代理任务分发（Subagent Dispatch）**：面对需要大量搜集信息或耗时的子任务时，主 Agent 可动态唤起轻量级独立子代理并发执行，并将结果结构化汇总，不阻塞主任务推进。
* **安全沙箱与人机审批拦截**：所有跨工作区根目录的敏感文件访问与高风险操作均被自动拦截，弹出人机交互审批弹窗，杜绝潜在风险。
* **随心生成控制（Stop Control）**：支持在流式输出、漫长思考或复杂工具调用执行中一键即时中断，随时调整方向，避免无效 Token 消耗。

---

### 🧰 2. 完备的工程工具链与开放扩展生态

#### 🛠️ 内置 9 大工程级工具

| 工具名称 | 功能描述 |
| :--- | :--- |
| `read_file` | 读取指定文件内容，支持大文件行范围分页，杜绝爆 Token 溢出 |
| `write_file` | 原子性创建或重写文件，自动创建深层依赖目录 |
| `edit_file` | **精准局部替换**：基于独有上下文锚点进行单处/多处精准替换，保护未变动代码结构 |
| `list_directory` | 递归/平铺列出工程目录结构，自动过滤构建产物与无关深层依赖 |
| `search_code` | 基于高效搜索内核的代码模式与正则搜索，秒级定位符号、定义与调用链路 |
| `run_command` | 受控执行终端 Shell 命令，内建超时终止机制与 ANSI 彩色输出清洗 |
| `web_search` | 多引擎互联网检索（支持 Tavily / Mojeek / DuckDuckGo / Google 自动回退） |
| `web_fetch` | 深度网页内容抓取与清洗，自动将网页转录为清晰的 Markdown 结构文本 |
| `todo_write` | Agent 专属任务规划工具，实时向界面同步待办工单的推进状态 |

#### 🔌 标准 MCP 协议动态桥接

* **完全兼容行业标准**：无缝兼容 Claude Desktop 和 Cursor 的 MCP (Model Context Protocol) 规范。
* **连接池与热重载**：支持基于 `JSON-RPC 2.0 over Stdio` 的动态连接池管理，自动合并全局（`~/.omcx/mcp.json`）与项目级（`<workDir>/.omcx/mcp.json`）配置，随配随用。
* **工具即时发现**：握手后自动拉取远端工具 Schema 并以 `mcp__<server>__<tool>` 形式无缝注入大模型调用链。

#### 🧩 声明式 Markdown Skills 技能库

* **Prompt 级能力拓展**：编写纯 Markdown（支持 YAML Frontmatter 元数据）即可赋予 Agent 专属领域经验，如特定框架编码规范、API 测试模板或安全审查规约。
* **多层级生效**：支持全局技能（`~/.omcx/skills/`）与项目私有技能（`<workDir>/.omcx/skills/`）隔离生效与自动识别。

---

### 🖥️ 3. 全能工作台抽屉（Web Workspace Drawer）

无需在 VS Code、终端、Finder 与聊天窗口之间来回切换，右滑即可展开覆盖式多功能工程抽屉（支持 90vw 沉浸式宽屏展开）：

* **多目录工作空间管理**：支持单个工作空间挂载多套关联项目目录，轻松跨微服务、跨端工程无缝编码。
* **项目文件树与代码查看器**：极速加载目录层级，内建语法高亮代码阅览器，支持点击快速跳转与内容复制。
* **Git 变更实时审查（Git Changes View）**：
  * 自动追踪当前工作区 Git 分支、未暂存与已修改文件清单。
  * 实时统计代码增删行数（`+` / `-` 指标）。
  * 内置专业级 **Side-by-Side / Inline Code Diff** 差异高亮视图，每一行代码变更均了然于胸。
* **集成交互式终端（Integrated Terminal）**：嵌入免切窗口的交互式终端环境，可在当前会话的工作目录中即时输入任意命令调试程序。

---

### 🧠 4. 智能上下文管理与多模态交互

* **三级上下文自动压缩机制（Context Compactor）**：
  1. *MicroCompact（微压缩）*：对话轮次增加时，自动折叠修剪早期历史工具调用的巨幅日志输出，保留关键上下文。
  2. *LLM 结构化摘要压缩*：当 Token 逼近模型上下文窗口极限时，自动滑动保留核心活跃窗口，将早期历史对话提炼为结构化摘要（目标、已做决策、最新进展、关键文件）回注 System Context。
  3. *Hard Truncate（硬截断兜底）*：多重异常下的兜底截断保护，杜绝死锁与超限崩溃，确保长周期对话永不中断。
* **实时 Token 计量仪表盘**：直观展示系统 Prompt、历史消息、工具执行与技能指令的 Token 分布图与上下文健康度。
* **`@` 快速上下文提及**：在输入框内键入 `@` 即可模糊检索并内联引用 `@file`、`@dir`、`@skill`、`@mcp`，省去冗长的路径说明。
* **三通路多模态附件理解**：
  * *图像通道*：支持拖拽与粘贴图片，自动等比缩放并转换为高清 Base64 多模态视觉输入。
  * *文本通道*：代码、Markdown、日志等小文本文件无缝内联解析。
  * *大文件/二进制通道*：大型数据、PDF、表格或二进制资源自动落盘并注入路径元数据，引导 Agent 自主使用专用工具读取，杜绝撑爆会话。

---

### 💎 5. 极致工业级视觉体系

* **通透磨砂体系**：基于现代化纯暗色底色，支持自定义壁纸、预设渐变背景、表面不透明度调节（35% ~ 100%）、背景虚化度（0 ~ 40px）以及「内容面通透」毛玻璃开关。
* **右侧 Agent Inspector 监控栏**：
  * *工作空间与 Git 卡*：展示当前工作区、关联目录与分支状态。
  * *上下文监控卡*：动态展示实时 Token 消耗分布与压缩情况。
  * *TodoList 进度卡*：直观呈现 Agent 正在攻克的技术任务，伴随顺时针环绕边框光效反馈。
  * *Git 变更卡*：展示当前会话引发的代码变动总览。
  * *产出物清单卡（Outputs）*：实时收录本次对话中 Agent 新建或修改的所有代码文件，支持一键在 Finder 中定位。
  * *连接器卡（Connectors）*：显示当前已激活的 Skills 和 MCP 外部服务。
* **高质感 Markdown 与代码块渲染**：内置语法高亮、代码一键复制、KaTeX 复杂数学公式解析、Mermaid 架构流程图渲染与 ANSI 彩色终端输出。

---

### ⚙️ 6. 开放的模型生态与私有化支持

* **全格式 API 协议兼容**：
  * **OpenAI 兼容协议**：原生支持 GPT-4o、DeepSeek-V3/R1、Moonshot、GLM 等各类标准端点。
  * **Anthropic 协议**：原生支持 Claude 3.5 Sonnet 等业界顶尖 Coding 模型。
  * **本地私有化大模型**：一键直连本地 Ollama（如 `qwen2.5-coder`、`llama3` 等），敏感代码不出局域网。
* **可视化模型管理**：支持随时增删模型、调整 Temperature、Max Tokens、Context Window 上限及自定义 Headers。
* **智能会话命名**：每次首轮对话结束后，异步旁路小模型自动提炼生成精炼的中文会话标题。

---

## 🚀 快速开始

### 环境准备

* **操作系统**：macOS (Apple Silicon / Intel)
* **运行环境**：Node.js >= 18.0.0，npm >= 9.0.0

### 1. 克隆代码与安装依赖

```bash
# 克隆仓库
git clone https://github.com/your-org/omcx-desktop.git
cd omcx-desktop

# 安装项目依赖
npm install
```

### 2. 本地开发调试

在开发模式下，Vite HMR 前端开发服务器与 Electron 主进程将联动启动：

```bash
# 终端 1：启动 Vite 开发服务器（默认端口 5173）
npm run dev

# 终端 2：启动 Electron 客户端（自动接入 Vite 开发服务器）
npm start
```

### 3. 生产打包构建

```bash
# 构建前端静态资源
npm run build

# 打包输出 macOS 安装包（DMG + ZIP）
npm run pack
```
> 打包产物将输出至 `release/` 目录。

---

## 📁 项目目录概览

```text
omcx-desktop/
├── main.js                  # Electron 主进程（窗口生命周期、安全协议、Agent 调度循环）
├── preload.js               # 安全沙箱桥接（contextBridge 暴露 window.electronAPI）
├── services/                # 主进程核心服务层
│   ├── storageService.js    # 本地数据持久化（~/.omcx/ JSON + Write-through 内存缓存）
│   ├── mcpClientService.js  # 标准 MCP 连接池与工具动态路由
│   ├── contextCompactor.js  # 三级上下文自动压缩引擎
│   ├── contextCalculator.js # Token 计量与分布统计
│   ├── workspaceGitService.js # 工作区 Git 状态与行数变更统计
│   └── subagentService.js   # 子代理生命周期管理
├── utils/                   # Agent 工具链与上下文组装
│   ├── toolRegistry.js      # 工具注册中心（会话级隔离与权限收敛）
│   ├── contextBuilder.js    # 动态上下文组装（规则/技能/记忆/Git/Todo）
│   └── tools/               # 9 大内置工程工具实现
├── src/                     # React 渲染进程源码
│   ├── pages/               # 核心视图页面（ChatView, Workspaces, Tools, Settings）
│   ├── components/
│   │   ├── agent/           # 右侧 Inspector 监控卡片群
│   │   ├── browser/         # 全能工作台抽屉（文件树、Git Diff 审查、交互终端）
│   │   ├── navigation/      # 一体式左侧导航栏与工具面板
│   │   └── common/          # Markdown、Diff、高亮代码块渲染组件
│   ├── stores/              # Zustand 状态管理（appStore, chatStore）
│   └── hooks/               # useStreamChat 等状态同步 Hook
├── index.html               # 渲染进程 HTML 宿主
├── vite.config.js           # Vite 构建配置
└── tailwind.config.js       # 工业级主题样式配置
```

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。欢迎提交 Issue 与 Pull Request 共同完善 OMCX！
