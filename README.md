# OMCX Desktop

基于 Electron + React 的专业 AI Coding Agent 桌面客户端，专注于大型复杂项目的持续迭代、代码审查与高成功率自主功能实现。

> 包名: `omcx-desktop` · 版本: v2.0.0 · App ID: `com.omcx.desktop`

---

## ✨ 功能特性

### 🤖 AI 聊天
- 多会话管理（创建、删除、重命名、会话级工作目录）
- Ask / Agent 双模式 — Ask 纯对话，Agent 可自动调用工具
- 支持多种聊天模型切换（已配置的 `chat` 类型模型）
- 流式输出、实时渲染 Markdown（代码高亮、表格等）
- 工具调用状态面板（实时显示搜索、文件操作等进度）
- 网页搜索结果引用来源折叠展示
- Token 用量统计与消息占比分析

### 🖼️ AI 图像生成
- 文本生图 (txt2img) / 图生图 (img2img) 双模式
- 拖拽上传参考图片
- 5 种预设画面比例 + 自定义分辨率
- 推理步数（10-50）、随机种子控制
- 生成历史侧边栏（缩略图列表）

### 🎬 AI 视频生成
- 文本生视频 / 图片生视频 / 多图视频 / 关键帧动画 四种模式
- 异步任务 + 轮询进度 + 状态标签
- 帧率（24fps）和帧数（121帧）
- 生成完成后自动播放
- 网络/服务器错误自动重试

### 🔧 AI Agent 工具
内置 7 个 Agent 工具，可在对话中由 LLM 自动调用：

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件内容，支持行范围分页 |
| `write_file` | 创建/修改文件，自动创建父目录 |
| `list_directory` | 浏览目录结构，跳过无关目录 |
| `search_code` | 基于 ripgrep 的代码搜索 |
| `run_command` | 执行 Shell 命令（路径安全校验） |
| `web_search` | 多引擎互联网搜索（四级 fallback） |
| `web_fetch` | 抓取网页内容并提取文本摘要 |

### 🎨 主题系统
- 亮色 / 暗色 / 跟随系统 三种模式
- 主题偏好持久化到本地

### ⚙️ 设置管理
- 模型可视化 CRUD（支持 Agnes / Ollama / OpenAI / Custom 服务商）
- 搜索引擎配置（DuckDuckGo / Tavily）
- 文件保存目录选择

---

## 🛠️ 技术栈

| 类别 | 技术 |
|------|------|
| 桌面框架 | Electron 29 |
| UI 框架 | React 18 + TypeScript |
| 构建工具 | Vite 5 |
| 样式方案 | Tailwind CSS 3 |
| 状态管理 | Zustand 4 |
| 本地存储 | better-sqlite3 |
| LLM 工具链 | LangChain Core |
| Markdown 渲染 | marked |
| 图标库 | lucide-react |
| 网页抓取 | cheerio |
| 桌面打包 | electron-builder |

---

## 🚀 快速开始

### 环境要求

- macOS (Apple Silicon)
- Node.js >= 18

### 安装依赖

```bash
npm install
```

### 开发模式

同时启动 Vite HMR 开发服务器和 Electron：

```bash
# 终端 1：启动 Vite 开发服务器（端口 5173）
npm run dev

# 终端 2：启动 Electron（自动连接 Vite 开发服务器）
npm start
```

> 设置环境变量 `VITE_DEV_SERVER=http://localhost:5173` 可显式指定开发服务器地址。

### 生产构建

```bash
# 构建前端资源
npm run build

# 启动 Electron（加载 dist/ 中的构建产物）
npm start
```

### macOS 打包

```bash
npm run pack
# 输出到 release/ 目录（DMG + ZIP）
```

---

## 📁 项目结构

```
agnesAI/
├── main.js                  # Electron 主进程（窗口管理、IPC、SQLite、API 代理）
├── preload.js               # contextBridge 暴露 API 给渲染进程
├── index.html               # Vite 入口 HTML
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
│
├── src/                     # React 前端源码
│   ├── main.tsx             # React 入口
│   ├── App.tsx              # 根组件
│   ├── index.css            # 全局样式 + Tailwind + 主题变量
│   ├── theme.ts             # 主题管理（亮色/暗色/随系统）
│   │
│   ├── components/
│   │   ├── Layout.tsx       # 三栏布局容器
│   │   ├── Sidebar.tsx      # 左侧导航栏
│   │   ├── RightSidebar.tsx # 通用可折叠右侧面板
│   │   ├── MarkdownContent.tsx
│   │   ├── ImageUploader.tsx
│   │   ├── SizePicker.tsx
│   │   ├── chat/
│   │   │   ├── SessionList.tsx
│   │   │   ├── ChatHeader.tsx
│   │   │   ├── MessageList.tsx
│   │   │   ├── MessageInput.tsx
│   │   │   └── ChatSidebar.tsx
│   │   ├── image/
│   │   │   └── ImageSidebar.tsx
│   │   └── video/
│   │       ├── MultiImageUploader.tsx
│   │       └── VideoSidebar.tsx
│   │
│   ├── hooks/
│   │   └── useStreamChat.ts  # 流式聊天 Hook
│   │
│   ├── stores/
│   │   ├── appStore.ts       # 视图路由状态
│   │   ├── chatStore.ts      # 聊天会话与消息管理
│   │   ├── imageStore.ts     # 图像生成参数
│   │   └── videoStore.ts     # 视频生成参数
│   │
│   └── views/
│       ├── DashboardView.tsx # 工作台总览
│       ├── ChatView.tsx      # 聊天对话
│       ├── ImageView.tsx     # 图像生成
│       ├── VideoView.tsx     # 视频生成
│       └── SettingsView.tsx  # 设置
│
├── utils/
│   ├── toolRegistry.js       # AI 工具注册中心
│   ├── langchainAgent.js     # LangChain 工具适配
│   ├── tools/
│   │   ├── fileTools.js      # 文件操作工具
│   │   ├── shellTools.js     # Shell 执行工具
│   │   └── webTools.js       # 网络搜索工具
│
├── build/
│   └── icon.icns             # macOS 应用图标
│
├── dist/                     # Vite 构建产物
└── release/                  # electron-builder 打包输出
```

---

## 🏗️ 架构概述

```
┌─────────────────────────────────────────────────────┐
│                 Electron 主进程 (main.js)             │
│  ┌──────────┐  ┌────────────┐  ┌─────────────────┐  │
│  │ 窗口管理  │  │ IPC Handler│  │  API Proxy      │  │
│  │          │  │ (19 个)    │  │  (fetch → Agnes) │  │
│  └──────────┘  └────────────┘  └─────────────────┘  │
│                     │          ┌──────────────────┐  │
│                     │          │  SQLite (5 张表)  │  │
│                     │          │  agnes_data.db    │  │
│                     │          └──────────────────┘  │
│                     │          ┌──────────────────┐  │
│                     │          │  搜索引擎         │  │
│                     │          │  四级 fallback    │  │
│                     │          └──────────────────┘  │
└─────────────────────┼───────────────────────────────┘
                      │ IPC (contextBridge)
┌─────────────────────┼───────────────────────────────┐
│              渲染进程 (Vite + React)                  │
│  ┌──────────┐  ┌────────────────────────────────┐   │
│  │ React UI │  │  window.electronAPI (preload)  │   │
│  │ Zustand  │  │  DB & API 通过此桥转发主进程    │   │
│  └──────────┘  └────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

渲染进程**不直接**访问 Node.js API 或发送 HTTP 请求。所有操作通过 `window.electronAPI`（contextBridge 注入）代理到主进程处理。

---

## ⚙️ 配置

### 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `VITE_DEV_SERVER` | 指定 Vite 开发服务器 URL | 无（加载 `dist/`） |
| `DEBUG_AGNES` | 调试模式，自动打开 DevTools | 无 |

### SQLite 数据库 (`agnes_data.db`)

| 表 | 说明 |
|----|------|
| `config` | 键值配置（主题、保存路径、API Key 等） |
| `chat_sessions` | 聊天会话 |
| `chat_messages` | 聊天消息 |
| `media_tasks` | 媒体生成任务历史 |
| `llm_models` | 多模型配置 |

预置默认模型：

| 模型 ID | 类型 |
|---------|------|
| `agnes-2.0-flash` | chat |
| `agnes-image-2.1-flash` | image |
| `agnes-video-v2.0` | video |

---

## 📦 IPC 通道一览

**invoke/handle（请求-响应，18 个）**

`get-config`, `set-config`, `db-get-models`, `db-add-model`, `db-delete-model`, `db-get-sessions`, `db-add-session`, `db-delete-session`, `db-delete-messages-after`, `db-get-messages`, `db-add-message`, `db-get-media-tasks`, `db-delete-media-task`, `api-get-models`, `api-generate-image`, `api-generate-video`, `api-poll-video`, `select-save-directory`

**on/send（事件推送，2 个）**

`chat-request`（流式聊天 SSE 转发）、`show-in-folder`（在 Finder 中显示文件）

---

## 📄 许可

本项目基于 MIT 许可证开源。
