export interface AutomationRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule_type: 'interval' | 'cron' | 'manual';
  interval_minutes: number;
  cron_expr: string;
  prompt: string;
  work_dir: string | null;
  agent_mode: 'work' | 'code';
  permission_mode: 'plan' | 'auto' | 'auto-sandbox';
  model: string;
  webhook_target_id: string | null;
  notify_on: 'always' | 'on_error' | 'never';
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  created_at: number;
  updated_at: number;
}

export interface AutomationRunOutput {
  id?: string;
  name?: string;
  filePath: string;
  fileType?: string;
  action?: string;
}

export interface AutomationRun {
  id: string;
  automation_id: string;
  automation_name: string;
  trigger_source: 'schedule' | 'manual' | 'webhook';
  status: 'running' | 'success' | 'failed' | 'cancelled';
  triage_state: 'unread' | 'read' | 'archived';
  session_id: string | null;
  summary: string;
  error: string | null;
  outputs: AutomationRunOutput[];
  duration_ms: number;
  started_at: number;
  finished_at: number | null;
}

export interface WebhookTargetView {
  id: string;
  name: string;
  provider: 'feishu' | 'dingtalk' | 'wecom' | 'generic';
  enabled: boolean;
  has_url: boolean;
  url_masked: string;
  has_secret: boolean;
  secret_masked: string;
  created_at: number;
  updated_at: number;
}

export interface InboundWebhookView {
  enabled: boolean;
  port: number;
  has_token: boolean;
  token_masked: string;
  plain_token?: string;
}

export interface AutomationPreset {
  id: string;
  name: string;
  description: string;
  schedule_type: 'interval' | 'cron' | 'manual';
  interval_minutes: number;
  cron_expr: string;
  agent_mode: 'work' | 'code';
  permission_mode: 'plan' | 'auto';
  prompt: string;
}

export const AUTOMATION_PRESETS: AutomationPreset[] = [
  {
    id: 'daily_briefing',
    name: '每日工作简报',
    description: '每个工作日早 9 点梳理工作区近期变更、待办文档并生成 Markdown 简报',
    schedule_type: 'cron',
    interval_minutes: 1440,
    cron_expr: '0 9 * * 1-5',
    agent_mode: 'work',
    permission_mode: 'auto',
    prompt:
      '请检查当前工作目录下的近期改动记录、文档与待办事项，整理一份简洁的《每日工作简报》（包含昨日进展、今日建议优先事项、潜在阻塞点），并将结果保存为工作区内的日报 Markdown 文件。',
  },
  {
    id: 'folder_organizer',
    name: '目录资料归档整理',
    description: '定期清点散落文档与导出文件，按类别生成整理清单与归档报告',
    schedule_type: 'cron',
    interval_minutes: 1440,
    cron_expr: '0 18 * * 5',
    agent_mode: 'work',
    permission_mode: 'plan',
    prompt:
      '请巡检当前工作目录中的文档、表格与临时文件分布，按主题给出可执行的整理归档建议清单（列出建议归类的文件、重复或过期文件），不要直接删除任何原始文件，先输出整理方案供审阅。',
  },
  {
    id: 'git_audit',
    name: 'Git 变更与风险巡检',
    description: '每 2 小时检查工作区 Git 状态、未提交改动与近期提交，识别潜在风险',
    schedule_type: 'interval',
    interval_minutes: 120,
    cron_expr: '0 */2 * * *',
    agent_mode: 'code',
    permission_mode: 'plan',
    prompt:
      '请只读巡检当前仓库的 git status 与最近提交 diff，重点检查是否存在遗留调试代码、硬编码凭据风险、未完成的 TODO 或构建隐患，输出简洁的 P0/P1/P2 巡检结论。',
  },
  {
    id: 'log_summary',
    name: '异常日志定时汇总',
    description: '按 Webhook 或每日定时扫描日志目录，聚合高频错误并给出排查建议',
    schedule_type: 'cron',
    interval_minutes: 1440,
    cron_expr: '30 9 * * *',
    agent_mode: 'work',
    permission_mode: 'plan',
    prompt:
      '请扫描工作区内最近修改的日志或输出报告文件，统计高频异常与报错堆栈，按严重程度归类总结原因与排查建议。',
  },
];

export const CRON_SHORTCUTS = [
  { label: '每 15 分钟', expr: '*/15 * * * *' },
  { label: '每小时整点', expr: '0 * * * *' },
  { label: '每天 09:00', expr: '0 9 * * *' },
  { label: '工作日 09:00', expr: '0 9 * * 1-5' },
  { label: '每天 18:00', expr: '0 18 * * *' },
  { label: '每周一 09:00', expr: '0 9 * * 1' },
];

export const WEBHOOK_PROVIDER_META: Record<
  'feishu' | 'dingtalk' | 'wecom' | 'generic',
  {
    label: string;
    badge: string;
    urlPlaceholder: string;
    secretLabel: string;
    secretPlaceholder: string;
    hint: string;
  }
> = {
  feishu: {
    label: '飞书群机器人',
    badge: 'Feishu',
    urlPlaceholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx',
    secretLabel: '签名校验密钥 (可选)',
    secretPlaceholder: '飞书机器人安全设置中勾选「签名校验」后获得的密钥',
    hint: '在飞书群 → 设置 → 群机器人 → 添加自定义机器人即可复制 Webhook 地址。',
  },
  dingtalk: {
    label: '钉钉群机器人',
    badge: 'DingTalk',
    urlPlaceholder: 'https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx',
    secretLabel: '加签密钥 SEC... (可选)',
    secretPlaceholder: '钉钉机器人安全设置勾选「加签」后的 SEC 开头密钥',
    hint: '若钉钉机器人启用了「加签」，请务必填写 SEC 密钥，发送时会自动计算 timestamp & sign。',
  },
  wecom: {
    label: '企业微信机器人',
    badge: 'WeCom',
    urlPlaceholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx',
    secretLabel: '备注密钥 (企微无需签名，可留空)',
    secretPlaceholder: '企业微信机器人不需要签名密钥，留空即可',
    hint: '在企业微信群右上角 → 添加群机器人，复制包含 key= 的 Webhook 地址。',
  },
  generic: {
    label: '通用 JSON Webhook',
    badge: 'Webhook',
    urlPlaceholder: 'https://example.com/hooks/omcx',
    secretLabel: 'HMAC-SHA256 签名密钥 (可选)',
    secretPlaceholder: '填写后将在请求头附加 X-OMCX-Signature: sha256=...',
    hint: '向目标地址 POST 标准 JSON 事件体，适用于自建服务、Slack 中转或自动化平台。',
  },
};

export function formatScheduleLabel(rule: Pick<AutomationRule, 'schedule_type' | 'interval_minutes' | 'cron_expr'>) {
  if (rule.schedule_type === 'manual') return '仅手动 / Webhook';
  if (rule.schedule_type === 'cron') {
    const shortcut = CRON_SHORTCUTS.find((s) => s.expr === rule.cron_expr);
    return shortcut ? `${shortcut.label} · ${rule.cron_expr}` : `Cron · ${rule.cron_expr}`;
  }
  const mins = Math.max(1, Number(rule.interval_minutes) || 60);
  if (mins >= 1440 && mins % 1440 === 0) return `每 ${mins / 1440} 天`;
  if (mins >= 60 && mins % 60 === 0) return `每 ${mins / 60} 小时`;
  return `每 ${mins} 分钟`;
}

export function formatDurationMs(ms: number) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n}ms`;
  const sec = Math.round(n / 1000);
  if (sec < 60) return `${sec}秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}分${s > 0 ? `${s}秒` : ''}`;
}
