import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  CalendarClock,
  Inbox,
  Plus,
  Play,
  Square,
  Trash2,
  Pencil,
  CheckCheck,
  Archive,
  MessageSquareShare,
  Webhook,
  RefreshCw,
  FolderOpen,
  Download,
  FileText,
  Copy,
  Check,
  Send,
  RotateCw,
  Sparkles,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  MailOpen,
  Mail,
} from 'lucide-react';
import { useChatStore } from '@/stores/chatStore';
import { useAppStore } from '@/stores/appStore';
import { formatRelativeTime } from '@/lib/relativeTime';
import MarkdownContent from '@/components/common/MarkdownContent';
import {
  AUTOMATION_PRESETS,
  WEBHOOK_PROVIDER_META,
  formatDurationMs,
  formatScheduleLabel,
  type AutomationPreset,
  type AutomationRule,
  type AutomationRun,
  type InboundWebhookView,
  type WebhookTargetView,
} from './automations/automationPresets';
import { AutomationRuleModal } from './automations/AutomationRuleModal';
import { WebhookTargetModal } from './automations/WebhookTargetModal';

type ActiveTab = 'inbox' | 'rules' | 'webhooks';
type InboxFilter = 'unread' | 'all' | 'failed' | 'archived';

const TRIGGER_LABELS: Record<string, string> = {
  schedule: '定时触发',
  manual: '手动试跑',
  webhook: 'Webhook 触发',
};

export const AutomationsView: React.FC = () => {
  const {
    workspaces,
    models,
    sessions,
    activeSessionId,
    promoteAutomationSession,
  } = useChatStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      models: s.models,
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      promoteAutomationSession: s.promoteAutomationSession,
    }))
  );
  const { setActiveNavTab, unreadAutomationRuns, setUnreadAutomationRuns } = useAppStore(
    useShallow((s) => ({
      setActiveNavTab: s.setActiveNavTab,
      unreadAutomationRuns: s.unreadAutomationRuns,
      setUnreadAutomationRuns: s.setUnreadAutomationRuns,
    }))
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const defaultWorkDir =
    activeSession?.workDir ||
    workspaces[0]?.folders.find((f) => f.isPrimary)?.path ||
    workspaces[0]?.folders[0]?.path ||
    null;

  const [activeTab, setActiveTab] = useState<ActiveTab>('inbox');
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>('all');
  const [loading, setLoading] = useState(true);

  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [webhookTargets, setWebhookTargets] = useState<WebhookTargetView[]>([]);
  const [inboundConfig, setInboundConfig] = useState<InboundWebhookView>({
    enabled: false,
    port: 17890,
    has_token: false,
    token_masked: '',
  });
  const [inboundStatus, setInboundStatus] = useState<{
    listening: boolean;
    host: string;
    port: number | null;
    error: string | null;
  }>({ listening: false, host: '127.0.0.1', port: null, error: null });
  const [inboundPortInput, setInboundPortInput] = useState('17890');
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null);
  const [presetSeed, setPresetSeed] = useState<AutomationPreset | null>(null);

  const [webhookModalOpen, setWebhookModalOpen] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<WebhookTargetView | null>(null);

  const [bannerMsg, setBannerMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [testingTargetId, setTestingTargetId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const showNotice = useCallback((type: 'ok' | 'err', text: string) => {
    setBannerMsg({ type, text });
    window.setTimeout(() => {
      setBannerMsg((cur) => (cur?.text === text ? null : cur));
    }, 4500);
  }, []);

  const loadAll = useCallback(async () => {
    if (!window.electronAPI?.listAutomations) return;
    try {
      const [autoRes, runsRes, targetsRes, inboundRes] = await Promise.all([
        window.electronAPI.listAutomations(),
        window.electronAPI.listAutomationRuns({ limit: 200 }),
        window.electronAPI.listWebhookTargets(),
        window.electronAPI.getInboundWebhookConfig(),
      ]);
      if (Array.isArray(autoRes?.rules)) setRules(autoRes.rules);
      if (typeof autoRes?.unreadCount === 'number') setUnreadAutomationRuns(autoRes.unreadCount);
      if (Array.isArray(runsRes?.runs)) {
        setRuns(runsRes.runs);
        setSelectedRunId((prev) => {
          if (prev && runsRes.runs.some((r: AutomationRun) => r.id === prev)) return prev;
          return runsRes.runs[0]?.id || null;
        });
      }
      if (Array.isArray(targetsRes)) setWebhookTargets(targetsRes);
      if (inboundRes?.config) {
        setInboundConfig(inboundRes.config);
        setInboundPortInput(String(inboundRes.config.port || 17890));
      }
      if (inboundRes?.status) setInboundStatus(inboundRes.status);
    } catch (err: any) {
      showNotice('err', err?.message || '加载定时任务数据失败');
    } finally {
      setLoading(false);
    }
  }, [setUnreadAutomationRuns, showNotice]);

  useEffect(() => {
    void loadAll();
    const unsub = window.electronAPI?.onAutomationUpdated?.(() => {
      void loadAll();
    });
    return () => {
      unsub?.();
    };
  }, [loadAll]);

  const filteredRuns = useMemo(() => {
    return runs.filter((r) => {
      if (inboxFilter === 'unread') return r.triage_state === 'unread';
      if (inboxFilter === 'failed') return r.status === 'failed';
      if (inboxFilter === 'archived') return r.triage_state === 'archived';
      return r.triage_state !== 'archived';
    });
  }, [runs, inboxFilter]);

  const selectedRun = useMemo(
    () =>
      filteredRuns.find((r) => r.id === selectedRunId) ||
      runs.find((r) => r.id === selectedRunId) ||
      filteredRuns[0] ||
      null,
    [filteredRuns, runs, selectedRunId]
  );

  const runningCount = useMemo(
    () => runs.filter((r) => r.status === 'running').length,
    [runs]
  );

  const handleToggleRule = async (rule: AutomationRule) => {
    try {
      const res = await window.electronAPI.toggleAutomation(rule.id, !rule.enabled);
      if (res?.rule) {
        setRules((prev) => prev.map((r) => (r.id === rule.id ? res.rule : r)));
      }
    } catch (err: any) {
      showNotice('err', err?.message || '切换任务状态失败');
    }
  };

  const handleDeleteRule = async (rule: AutomationRule) => {
    try {
      await window.electronAPI.deleteAutomation(rule.id);
      await loadAll();
      showNotice('ok', `已删除定时任务「${rule.name}」`);
    } catch (err: any) {
      showNotice('err', err?.message || '删除定时任务失败');
    }
  };

  const handleRunNow = async (automationId: string, name?: string) => {
    try {
      const res = await window.electronAPI.runAutomationNow(automationId);
      if (!res?.ok) {
        showNotice('err', res?.error || '触发执行失败');
        return;
      }
      showNotice('ok', `已启动「${name || '定时任务'}」后台执行`);
      setActiveTab('inbox');
      setInboxFilter('all');
      if (res.runId) setSelectedRunId(res.runId);
      await loadAll();
    } catch (err: any) {
      showNotice('err', err?.message || '触发执行失败');
    }
  };

  const handleCancelRun = async (runId: string) => {
    try {
      await window.electronAPI.cancelAutomationRun(runId);
      showNotice('ok', '已发送停止信号');
      await loadAll();
    } catch (err: any) {
      showNotice('err', err?.message || '停止任务失败');
    }
  };

  const handleUpdateTriage = async (
    runId: string,
    triageState: 'unread' | 'read' | 'archived'
  ) => {
    try {
      const res = await window.electronAPI.updateAutomationRunTriage(runId, triageState);
      if (typeof res?.unreadCount === 'number') setUnreadAutomationRuns(res.unreadCount);
      setRuns((prev) =>
        prev.map((r) => (r.id === runId ? { ...r, triage_state: triageState } : r))
      );
    } catch (err: any) {
      showNotice('err', err?.message || '更新状态失败');
    }
  };

  const handleMarkAllRead = async () => {
    try {
      const res = await window.electronAPI.markAllAutomationRunsRead();
      setUnreadAutomationRuns(res?.unreadCount ?? 0);
      setRuns((prev) =>
        prev.map((r) => (r.triage_state === 'unread' ? { ...r, triage_state: 'read' } : r))
      );
    } catch (err: any) {
      showNotice('err', err?.message || '操作失败');
    }
  };

  const handleDeleteRun = async (runId: string) => {
    try {
      const res = await window.electronAPI.deleteAutomationRun(runId);
      if (typeof res?.unreadCount === 'number') setUnreadAutomationRuns(res.unreadCount);
      setRuns((prev) => prev.filter((r) => r.id !== runId));
    } catch (err: any) {
      showNotice('err', err?.message || '删除记录失败');
    }
  };

  const handleOpenInChat = async (run: AutomationRun) => {
    try {
      const res = await window.electronAPI.openAutomationRunSession({
        runId: run.id,
        sessionId: run.session_id || undefined,
      });
      if (typeof res?.unreadCount === 'number') setUnreadAutomationRuns(res.unreadCount);
      if (res?.session) {
        await promoteAutomationSession(res.session);
        setActiveNavTab('sessions');
      }
    } catch (err: any) {
      showNotice('err', err?.message || '打开会话失败');
    }
  };

  const handleTestWebhook = async (target: WebhookTargetView) => {
    setTestingTargetId(target.id);
    try {
      await window.electronAPI.testWebhookTarget(target.id);
      showNotice('ok', `通道「${target.name}」测试消息发送成功`);
    } catch (err: any) {
      showNotice('err', `测试发送失败: ${err?.message || '请求异常'}`);
    } finally {
      setTestingTargetId(null);
    }
  };

  const handleDeleteWebhook = async (target: WebhookTargetView) => {
    try {
      await window.electronAPI.deleteWebhookTarget(target.id);
      setWebhookTargets((prev) => prev.filter((t) => t.id !== target.id));
      showNotice('ok', `已删除通道「${target.name}」`);
    } catch (err: any) {
      showNotice('err', err?.message || '删除通道失败');
    }
  };

  const handleSaveInbound = async (nextEnabled: boolean, nextPort?: number) => {
    try {
      const res = await window.electronAPI.saveInboundWebhookConfig({
        enabled: nextEnabled,
        port: nextPort ?? (Number(inboundPortInput) || 17890),
      });
      if (res?.config) setInboundConfig(res.config);
      if (res?.status) setInboundStatus(res.status);
      showNotice(
        'ok',
        nextEnabled ? `本地 Webhook 已启用 (127.0.0.1:${res?.status?.port || inboundConfig.port})` : '本地 Webhook 已关闭'
      );
    } catch (err: any) {
      showNotice('err', err?.message || '更新 Inbound 配置失败');
    }
  };

  const handleRotateToken = async () => {
    try {
      const res = await window.electronAPI.rotateInboundWebhookToken();
      if (res?.config) {
        setInboundConfig(res.config);
        if (res.config.plain_token) {
          setRevealedToken(res.config.plain_token);
        }
      }
      if (res?.status) setInboundStatus(res.status);
      showNotice('ok', '已重新生成触发 Token，请及时复制保存（仅本次完整显示）');
    } catch (err: any) {
      showNotice('err', err?.message || '重新生成 Token 失败');
    }
  };

  const handleCopyText = (id: string, text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1800);
  };

  const handleExportOutput = async (filePath: string, format: 'original' | 'pdf' = 'original') => {
    const workDir = rules.find((r) => r.id === selectedRun?.automation_id)?.work_dir || defaultWorkDir;
    const res = await window.electronAPI?.exportFileOutput?.({
      workDir,
      filePath,
      format,
    });
    if (res && !res.success && !res.canceled) {
      showNotice('err', res.error || '导出文件失败');
    } else if (res?.success && res.savedPath) {
      showNotice('ok', `已导出到 ${res.savedPath}`);
    }
  };

  return (
    <div className='flex-1 h-full flex flex-col bg-[var(--ui-panel-bg)] backdrop-blur-xl backdrop-saturate-150 overflow-hidden text-[var(--ui-text-primary)] select-none'>
      {/* 顶部 Header */}
      <div className='h-[56px] border-b border-[color:var(--ui-divider-hairline)] bg-transparent px-6 flex items-center justify-between flex-shrink-0 titlebar-drag'>
        <div className='flex items-center gap-3'>
          <div className='w-8 h-8 rounded-xl bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] flex items-center justify-center text-[var(--ui-accent-blue)]'>
            <CalendarClock size={16} />
          </div>
          <div>
            <div className='flex items-center gap-2'>
              <h1 className='text-sm font-semibold text-[var(--ui-text-primary)]'>定时任务</h1>
              {runningCount > 0 && (
                <span className='inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]'>
                  <Loader2 size={10} className='animate-spin' />
                  {runningCount} 运行中
                </span>
              )}
            </div>
            <p className='text-[11px] text-[var(--ui-text-muted)]'>
              后台无人值守调度、运行结果收件箱与飞书/钉钉/企业微信 Webhook 联动
            </p>
          </div>
        </div>

        <div className='flex items-center gap-2 titlebar-no-drag'>
          <button
            onClick={() => void loadAll()}
            className='h-8 px-2.5 rounded-lg text-xs text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] flex items-center gap-1.5 cursor-pointer'
            title='刷新状态'
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={() => {
              setEditingRule(null);
              setPresetSeed(null);
              setRuleModalOpen(true);
            }}
            className='h-8 px-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium flex items-center gap-1.5 shadow-sm cursor-pointer transition-colors'
          >
            <Plus size={14} />
            <span>新建定时任务</span>
          </button>
        </div>
      </div>

      {/* 提示条 + 三标签切换栏 */}
      <div className='px-6 pt-3 pb-2 flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--ui-divider-hairline)] flex-shrink-0'>
        <div className='flex items-center gap-1 bg-[var(--ui-card-bg)] p-1 rounded-xl border border-[color:var(--ui-border-hairline)]'>
          <button
            onClick={() => setActiveTab('inbox')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all cursor-pointer ${
              activeTab === 'inbox'
                ? 'bg-blue-600 text-white font-semibold shadow-sm'
                : 'text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]'
            }`}
          >
            <Inbox size={13} />
            <span>任务收件箱</span>
            {unreadAutomationRuns > 0 && (
              <span
                className={`px-1.5 py-0.2 rounded-full text-[10px] font-semibold ${
                  activeTab === 'inbox'
                    ? 'bg-white/20 text-white'
                    : 'bg-blue-500/20 text-[var(--ui-accent-blue)]'
                }`}
              >
                {unreadAutomationRuns}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('rules')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all cursor-pointer ${
              activeTab === 'rules'
                ? 'bg-blue-600 text-white font-semibold shadow-sm'
                : 'text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]'
            }`}
          >
            <Clock size={13} />
            <span>定时规则</span>
            <span className='text-[10px] opacity-75'>({rules.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('webhooks')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all cursor-pointer ${
              activeTab === 'webhooks'
                ? 'bg-blue-600 text-white font-semibold shadow-sm'
                : 'text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]'
            }`}
          >
            <Webhook size={13} />
            <span>推送与触发</span>
            <span className='text-[10px] opacity-75'>({webhookTargets.length})</span>
          </button>
        </div>

        {bannerMsg && (
          <div
            className={`px-3 py-1.5 rounded-xl text-xs flex items-center gap-1.5 border ${
              bannerMsg.type === 'err'
                ? 'bg-red-500/10 border-red-500/30 text-red-400'
                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            }`}
          >
            {bannerMsg.type === 'err' ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}
            <span>{bannerMsg.text}</span>
          </div>
        )}
      </div>

      {/* ─── 主内容区 ─────────────────────────────────── */}
      {loading ? (
        <div className='flex-1 flex items-center justify-center text-xs text-[var(--ui-text-muted)] gap-2'>
          <Loader2 size={15} className='animate-spin text-[var(--ui-accent-blue)]' />
          <span>加载定时任务...</span>
        </div>
      ) : activeTab === 'inbox' ? (
        <div className='flex-1 flex min-h-0 overflow-hidden'>
          {/* 左侧运行列表 */}
          <div className='w-80 border-r border-[color:var(--ui-divider-hairline)] flex flex-col min-h-0 flex-shrink-0'>
            <div className='p-3 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between gap-1'>
              <div className='flex items-center gap-1'>
                {(
                  [
                    { id: 'all', label: '全部' },
                    { id: 'unread', label: '未读' },
                    { id: 'failed', label: '失败' },
                    { id: 'archived', label: '已归档' },
                  ] as const
                ).map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setInboxFilter(f.id)}
                    className={`px-2 py-1 rounded-lg text-[11px] cursor-pointer transition-colors ${
                      inboxFilter === f.id
                        ? 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-medium'
                        : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)]'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {unreadAutomationRuns > 0 && (
                <button
                  onClick={() => void handleMarkAllRead()}
                  className='p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] cursor-pointer'
                  title='全部标为已读'
                >
                  <CheckCheck size={13} />
                </button>
              )}
            </div>

            <div className='flex-1 overflow-y-auto p-2 space-y-1.5 custom-scrollbar'>
              {filteredRuns.length === 0 ? (
                <div className='h-full flex flex-col items-center justify-center text-center px-4 py-12 text-[var(--ui-text-muted)]'>
                  <Inbox size={24} className='mb-2 opacity-40' />
                  <p className='text-xs font-medium'>收件箱暂无记录</p>
                  <p className='text-[11px] opacity-75 mt-1'>
                    创建定时任务或点击「立即试跑」后，运行成果会集中汇总在这里。
                  </p>
                </div>
              ) : (
                filteredRuns.map((run) => {
                  const active = selectedRun?.id === run.id;
                  return (
                    <button
                      key={run.id}
                      onClick={() => {
                        setSelectedRunId(run.id);
                        if (run.triage_state === 'unread' && run.status !== 'running') {
                          void handleUpdateTriage(run.id, 'read');
                        }
                      }}
                      className={`w-full text-left p-3 rounded-xl border transition-colors cursor-pointer ${
                        active
                          ? 'bg-[var(--ui-accent-blue-soft)] border-[color:var(--ui-accent-blue-border)]'
                          : 'bg-[var(--ui-card-bg)] border-[color:var(--ui-border-hairline)] hover:bg-[var(--ui-block-hover-bg)]'
                      }`}
                    >
                      <div className='flex items-center justify-between gap-2'>
                        <div className='flex items-center gap-1.5 min-w-0'>
                          {run.triage_state === 'unread' && (
                            <span className='w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0' />
                          )}
                          <span className='text-xs font-semibold truncate text-[var(--ui-text-primary)]'>
                            {run.automation_name}
                          </span>
                        </div>
                        <span className='text-[10px] text-[var(--ui-text-faint)] flex-shrink-0'>
                          {formatRelativeTime(run.started_at)}
                        </span>
                      </div>

                      <div className='flex items-center gap-1.5 mt-1.5'>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            run.status === 'success'
                              ? 'bg-emerald-500/15 text-emerald-400'
                              : run.status === 'failed'
                              ? 'bg-red-500/15 text-red-400'
                              : run.status === 'cancelled'
                              ? 'bg-neutral-500/20 text-[var(--ui-text-muted)]'
                              : 'bg-blue-500/15 text-blue-400'
                          }`}
                        >
                          {run.status === 'success'
                            ? '成功'
                            : run.status === 'failed'
                            ? '失败'
                            : run.status === 'cancelled'
                            ? '已取消'
                            : '运行中'}
                        </span>
                        <span className='text-[10px] text-[var(--ui-text-muted)]'>
                          {TRIGGER_LABELS[run.trigger_source] || '定时触发'}
                        </span>
                        {run.outputs?.length > 0 && (
                          <span className='text-[10px] text-[var(--ui-text-muted)] ml-auto'>
                            {run.outputs.length} 份产物
                          </span>
                        )}
                      </div>

                      {(run.error || run.summary) && (
                        <p className='text-[11px] text-[var(--ui-text-secondary)] line-clamp-2 mt-1.5 leading-relaxed'>
                          {run.error || run.summary}
                        </p>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* 右侧运行详情 */}
          <div className='flex-1 min-w-0 flex flex-col overflow-hidden'>
            {!selectedRun ? (
              <div className='flex-1 flex flex-col items-center justify-center text-center px-6 text-[var(--ui-text-muted)]'>
                <Sparkles size={28} className='mb-2.5 text-[var(--ui-accent-blue)] opacity-60' />
                <p className='text-sm font-medium text-[var(--ui-text-primary)]'>
                  选择一个运行记录查看交付报告
                </p>
                <p className='text-xs mt-1 max-w-md'>
                  点击左侧「定时规则」创建你的第一条自动化任务，支持工作简报、目录归档、Git 巡检与飞书/钉钉/企业微信推送。
                </p>
              </div>
            ) : (
              <>
                <div className='px-6 py-4 border-b border-[color:var(--ui-divider-hairline)] flex flex-wrap items-center justify-between gap-3 flex-shrink-0'>
                  <div className='min-w-0'>
                    <div className='flex items-center gap-2'>
                      <h2 className='text-sm font-semibold text-[var(--ui-text-primary)] truncate'>
                        {selectedRun.automation_name}
                      </h2>
                      <span className='text-[11px] text-[var(--ui-text-muted)]'>
                        · {new Date(selectedRun.started_at).toLocaleString('zh-CN')}
                      </span>
                    </div>
                    <div className='flex flex-wrap items-center gap-3 mt-1 text-[11px] text-[var(--ui-text-muted)]'>
                      <span>{TRIGGER_LABELS[selectedRun.trigger_source] || '定时触发'}</span>
                      {selectedRun.duration_ms > 0 && (
                        <span>耗时 {formatDurationMs(selectedRun.duration_ms)}</span>
                      )}
                    </div>
                  </div>

                  <div className='flex items-center gap-1.5 flex-wrap'>
                    {selectedRun.status === 'running' ? (
                      <button
                        onClick={() => void handleCancelRun(selectedRun.id)}
                        className='h-8 px-3 rounded-xl bg-red-500/15 hover:bg-red-500/25 text-red-400 text-xs font-medium flex items-center gap-1.5 cursor-pointer'
                      >
                        <Square size={12} />
                        <span>停止执行</span>
                      </button>
                    ) : (
                      <>
                        {selectedRun.session_id && (
                          <button
                            onClick={() => void handleOpenInChat(selectedRun)}
                            className='h-8 px-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium flex items-center gap-1.5 cursor-pointer'
                          >
                            <MessageSquareShare size={13} />
                            <span>在对话中继续追问</span>
                          </button>
                        )}
                        <button
                          onClick={() =>
                            void handleRunNow(selectedRun.automation_id, selectedRun.automation_name)
                          }
                          className='h-8 px-2.5 rounded-xl bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-subtle)] text-xs text-[var(--ui-text-secondary)] flex items-center gap-1 cursor-pointer'
                          title='立即重跑一次'
                        >
                          <Play size={12} />
                          <span>重跑</span>
                        </button>
                        <button
                          onClick={() =>
                            void handleUpdateTriage(
                              selectedRun.id,
                              selectedRun.triage_state === 'unread' ? 'read' : 'unread'
                            )
                          }
                          className='h-8 px-2.5 rounded-xl bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-subtle)] text-xs text-[var(--ui-text-secondary)] flex items-center gap-1 cursor-pointer'
                          title={selectedRun.triage_state === 'unread' ? '标为已读' : '标为未读'}
                        >
                          {selectedRun.triage_state === 'unread' ? (
                            <MailOpen size={12} />
                          ) : (
                            <Mail size={12} />
                          )}
                        </button>
                        {selectedRun.triage_state !== 'archived' && (
                          <button
                            onClick={() => void handleUpdateTriage(selectedRun.id, 'archived')}
                            className='h-8 px-2.5 rounded-xl bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-subtle)] text-xs text-[var(--ui-text-secondary)] flex items-center gap-1 cursor-pointer'
                            title='归档'
                          >
                            <Archive size={12} />
                          </button>
                        )}
                        <button
                          onClick={() => void handleDeleteRun(selectedRun.id)}
                          className='h-8 px-2.5 rounded-xl bg-[var(--ui-card-bg)] hover:bg-red-500/15 border border-[color:var(--ui-border-subtle)] text-xs text-[var(--ui-text-muted)] hover:text-red-400 flex items-center gap-1 cursor-pointer'
                          title='删除此运行记录'
                        >
                          <Trash2 size={12} />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className='flex-1 overflow-y-auto p-6 space-y-5 custom-scrollbar select-text'>
                  {selectedRun.error && (
                    <div className='p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-start gap-2'>
                      <AlertCircle size={15} className='flex-shrink-0 mt-0.5' />
                      <div className='whitespace-pre-wrap break-words'>{selectedRun.error}</div>
                    </div>
                  )}

                  {selectedRun.outputs?.length > 0 && (
                    <div className='rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] p-4 space-y-2.5'>
                      <div className='text-xs font-semibold text-[var(--ui-text-primary)] flex items-center gap-1.5'>
                        <FileText size={13} className='text-[var(--ui-accent-blue)]' />
                        <span>生成与修改产物 ({selectedRun.outputs.length})</span>
                      </div>
                      <div className='grid grid-cols-1 md:grid-cols-2 gap-2'>
                        {selectedRun.outputs.map((out, idx) => {
                          const name = out.name || out.filePath.split(/[\\/]/).pop() || out.filePath;
                          const isMd = /\.(md|markdown|html|htm|docx|txt)$/i.test(out.filePath);
                          return (
                            <div
                              key={`${out.filePath}_${idx}`}
                              className='px-3 py-2 rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] flex items-center justify-between gap-2'
                            >
                              <div className='min-w-0'>
                                <div className='text-xs font-medium text-[var(--ui-text-primary)] truncate'>
                                  {name}
                                </div>
                                <div className='text-[10px] text-[var(--ui-text-muted)] truncate'>
                                  {out.filePath}
                                </div>
                              </div>
                              <div className='flex items-center gap-1 flex-shrink-0'>
                                <button
                                  onClick={() => window.electronAPI?.showInFolder?.(out.filePath)}
                                  className='p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] cursor-pointer'
                                  title='在访达中定位'
                                >
                                  <FolderOpen size={12} />
                                </button>
                                <button
                                  onClick={() => void handleExportOutput(out.filePath, 'original')}
                                  className='p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] cursor-pointer'
                                  title='另存为'
                                >
                                  <Download size={12} />
                                </button>
                                {isMd && (
                                  <button
                                    onClick={() => void handleExportOutput(out.filePath, 'pdf')}
                                    className='px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] cursor-pointer'
                                    title='导出为 PDF'
                                  >
                                    PDF
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className='rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] p-5'>
                    {selectedRun.status === 'running' ? (
                      <div className='flex items-center gap-2.5 text-xs text-[var(--ui-text-secondary)]'>
                        <Loader2 size={15} className='animate-spin text-[var(--ui-accent-blue)]' />
                        <span>定时任务正在后台静默执行中，完成后将自动更新报告并发送通知...</span>
                      </div>
                    ) : selectedRun.summary ? (
                      <MarkdownContent content={selectedRun.summary} />
                    ) : (
                      <p className='text-xs text-[var(--ui-text-muted)]'>暂无文本摘要内容。</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      ) : activeTab === 'rules' ? (
        <div className='flex-1 overflow-y-auto p-6 custom-scrollbar'>
          <div className='max-w-5xl mx-auto space-y-5'>
            {/* 预设模板区 */}
            <div className='rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] p-4 space-y-3'>
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-2 text-xs font-semibold text-[var(--ui-text-primary)]'>
                  <Sparkles size={14} className='text-[var(--ui-accent-amber)]' />
                  <span>开箱即用场景模板</span>
                </div>
                <span className='text-[11px] text-[var(--ui-text-muted)]'>
                  点击一键预填创建定时任务
                </span>
              </div>
              <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5'>
                {AUTOMATION_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => {
                      setEditingRule(null);
                      setPresetSeed(preset);
                      setRuleModalOpen(true);
                    }}
                    className='text-left p-3 rounded-xl bg-[var(--ui-card-inner-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-hairline)] transition-colors cursor-pointer'
                  >
                    <div className='text-xs font-semibold text-[var(--ui-text-primary)]'>
                      {preset.name}
                    </div>
                    <p className='text-[11px] text-[var(--ui-text-muted)] mt-1 line-clamp-2 leading-relaxed'>
                      {preset.description}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            {/* 规则列表 */}
            {rules.length === 0 ? (
              <div className='rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] p-12 text-center'>
                <CalendarClock size={28} className='mx-auto mb-2.5 text-[var(--ui-text-muted)] opacity-50' />
                <p className='text-sm font-medium text-[var(--ui-text-primary)]'>还没有配置定时任务</p>
                <p className='text-xs text-[var(--ui-text-muted)] mt-1'>
                  可以从上方模板快速创建，或点击右上角「新建定时任务」自定义调度规则。
                </p>
              </div>
            ) : (
              <div className='space-y-3'>
                {rules.map((rule) => {
                  const target = webhookTargets.find((t) => t.id === rule.webhook_target_id);
                  const isRunning = runs.some(
                    (r) => r.automation_id === rule.id && r.status === 'running'
                  );
                  return (
                    <div
                      key={rule.id}
                      className='rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] p-4 flex flex-wrap items-center justify-between gap-4'
                    >
                      <div className='min-w-0 flex-1 space-y-1'>
                        <div className='flex items-center gap-2 flex-wrap'>
                          <span className='text-sm font-semibold text-[var(--ui-text-primary)]'>
                            {rule.name}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                              rule.enabled
                                ? 'bg-emerald-500/15 text-emerald-400'
                                : 'bg-neutral-500/20 text-[var(--ui-text-muted)]'
                            }`}
                          >
                            {rule.enabled ? '调度已启用' : '已暂停'}
                          </span>
                          <span className='px-2 py-0.5 rounded-full text-[10px] bg-[var(--ui-chip-bg)] text-[var(--ui-text-secondary)]'>
                            {formatScheduleLabel(rule)}
                          </span>
                          <span className='px-2 py-0.5 rounded-full text-[10px] bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)]'>
                            {rule.agent_mode === 'work' ? 'Work 模式' : 'Code 模式'} ·{' '}
                            {rule.permission_mode === 'plan' ? '只读' : '沙箱写'}
                          </span>
                          {target && (
                            <span className='px-2 py-0.5 rounded-full text-[10px] bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]'>
                              推送: {target.name}
                            </span>
                          )}
                        </div>

                        {rule.description && (
                          <p className='text-xs text-[var(--ui-text-secondary)]'>
                            {rule.description}
                          </p>
                        )}

                        <div className='flex flex-wrap items-center gap-4 text-[11px] text-[var(--ui-text-muted)]'>
                          <span>工作目录：{rule.work_dir || '未绑定目录'}</span>
                          {rule.enabled && rule.next_run_at && (
                            <span>
                              下次执行：{new Date(rule.next_run_at).toLocaleString('zh-CN')}
                            </span>
                          )}
                          {rule.last_run_at && (
                            <span>
                              上次执行：{formatRelativeTime(rule.last_run_at)} (
                              {rule.last_status === 'success'
                                ? '成功'
                                : rule.last_status === 'failed'
                                ? '失败'
                                : rule.last_status || '-'}
                              )
                            </span>
                          )}
                        </div>
                      </div>

                      <div className='flex items-center gap-1.5 flex-shrink-0'>
                        <button
                          onClick={() => void handleRunNow(rule.id, rule.name)}
                          disabled={isRunning}
                          className='h-8 px-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-medium flex items-center gap-1 cursor-pointer'
                        >
                          {isRunning ? (
                            <Loader2 size={12} className='animate-spin' />
                          ) : (
                            <Play size={12} />
                          )}
                          <span>{isRunning ? '执行中' : '立即执行'}</span>
                        </button>
                        <button
                          onClick={() => void handleToggleRule(rule)}
                          className='h-8 px-2.5 rounded-xl bg-[var(--ui-card-inner-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-hairline)] text-xs text-[var(--ui-text-secondary)] cursor-pointer'
                        >
                          {rule.enabled ? '暂停' : '启用'}
                        </button>
                        <button
                          onClick={() => {
                            setEditingRule(rule);
                            setPresetSeed(null);
                            setRuleModalOpen(true);
                          }}
                          className='h-8 w-8 rounded-xl bg-[var(--ui-card-inner-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] flex items-center justify-center cursor-pointer'
                          title='编辑规则'
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => void handleDeleteRule(rule)}
                          className='h-8 w-8 rounded-xl bg-[var(--ui-card-inner-bg)] hover:bg-red-500/15 border border-[color:var(--ui-border-hairline)] text-[var(--ui-text-muted)] hover:text-red-400 flex items-center justify-center cursor-pointer'
                          title='删除规则'
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ─── 推送与触发 (Outbound & Inbound Webhooks) ─── */
        <div className='flex-1 overflow-y-auto p-6 custom-scrollbar'>
          <div className='max-w-5xl mx-auto space-y-6'>
            {/* Outbound 通知通道 */}
            <div className='rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] p-5 space-y-4'>
              <div className='flex items-center justify-between gap-3'>
                <div>
                  <h2 className='text-sm font-semibold text-[var(--ui-text-primary)]'>
                    结果推送通道（飞书 / 钉钉 / 企业微信 / Webhook）
                  </h2>
                  <p className='text-[11px] text-[var(--ui-text-muted)] mt-0.5'>
                    定时任务执行完毕或失败后，自动将成果摘要推送到群机器人或外部服务
                  </p>
                </div>
                <button
                  onClick={() => {
                    setEditingWebhook(null);
                    setWebhookModalOpen(true);
                  }}
                  className='h-8 px-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium flex items-center gap-1.5 cursor-pointer'
                >
                  <Plus size={13} />
                  <span>添加推送通道</span>
                </button>
              </div>

              {webhookTargets.length === 0 ? (
                <div className='py-8 text-center text-xs text-[var(--ui-text-muted)] border border-dashed border-[color:var(--ui-border-hairline)] rounded-xl'>
                  尚未配置任何外部推送通道，点击右上角「添加推送通道」即可接入飞书/钉钉/企业微信群机器人。
                </div>
              ) : (
                <div className='grid grid-cols-1 md:grid-cols-2 gap-3'>
                  {webhookTargets.map((target) => {
                    const meta = WEBHOOK_PROVIDER_META[target.provider];
                    const isTesting = testingTargetId === target.id;
                    return (
                      <div
                        key={target.id}
                        className='p-3.5 rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] flex flex-col gap-2.5'
                      >
                        <div className='flex items-center justify-between gap-2'>
                          <div className='flex items-center gap-2 min-w-0'>
                            <span className='px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)]'>
                              {meta.badge}
                            </span>
                            <span className='text-xs font-semibold truncate text-[var(--ui-text-primary)]'>
                              {target.name}
                            </span>
                          </div>
                          <span
                            className={`text-[10px] ${
                              target.enabled ? 'text-emerald-400' : 'text-[var(--ui-text-muted)]'
                            }`}
                          >
                            {target.enabled ? '已启用' : '已停用'}
                          </span>
                        </div>

                        <div className='text-[11px] font-mono text-[var(--ui-text-muted)] truncate'>
                          {target.url_masked || '未配置 URL'}
                          {target.has_secret ? ' · 已配置签名密钥' : ''}
                        </div>

                        <div className='flex items-center justify-end gap-1.5 pt-1'>
                          <button
                            onClick={() => void handleTestWebhook(target)}
                            disabled={isTesting}
                            className='h-7 px-2.5 rounded-lg bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-subtle)] text-[11px] text-[var(--ui-text-secondary)] flex items-center gap-1 cursor-pointer disabled:opacity-50'
                          >
                            {isTesting ? (
                              <Loader2 size={11} className='animate-spin' />
                            ) : (
                              <Send size={11} />
                            )}
                            <span>发送测试</span>
                          </button>
                          <button
                            onClick={() => {
                              setEditingWebhook(target);
                              setWebhookModalOpen(true);
                            }}
                            className='h-7 px-2.5 rounded-lg bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-subtle)] text-[11px] text-[var(--ui-text-secondary)] cursor-pointer'
                          >
                            编辑
                          </button>
                          <button
                            onClick={() => void handleDeleteWebhook(target)}
                            className='h-7 px-2 rounded-lg bg-[var(--ui-card-bg)] hover:bg-red-500/15 border border-[color:var(--ui-border-subtle)] text-[11px] text-[var(--ui-text-muted)] hover:text-red-400 cursor-pointer'
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Inbound 本地 HTTP 触发器 */}
            <div className='rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] p-5 space-y-4'>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <div>
                  <div className='flex items-center gap-2'>
                    <h2 className='text-sm font-semibold text-[var(--ui-text-primary)]'>
                      本地 Inbound Webhook 触发器
                    </h2>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        inboundStatus.listening
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : 'bg-neutral-500/20 text-[var(--ui-text-muted)]'
                      }`}
                    >
                      {inboundStatus.listening
                        ? `监听中 127.0.0.1:${inboundStatus.port}`
                        : '未开启'}
                    </span>
                  </div>
                  <p className='text-[11px] text-[var(--ui-text-muted)] mt-0.5'>
                    仅监听本机回环地址 127.0.0.1，外部脚本或 CI 可携带 Bearer Token 立即触发指定定时任务
                  </p>
                </div>

                <button
                  onClick={() => void handleSaveInbound(!inboundConfig.enabled)}
                  className={`h-8 px-3.5 rounded-xl text-xs font-medium cursor-pointer transition-colors ${
                    inboundConfig.enabled
                      ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
                      : 'bg-blue-600 hover:bg-blue-500 text-white'
                  }`}
                >
                  {inboundConfig.enabled ? '关闭触发器' : '启用触发器'}
                </button>
              </div>

              {inboundStatus.error && (
                <div className='px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400'>
                  端口监听失败：{inboundStatus.error}
                </div>
              )}

              <div className='grid grid-cols-1 md:grid-cols-2 gap-3'>
                <div className='p-3 rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] space-y-1.5'>
                  <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)]'>
                    本地监听端口 (1024 - 65535)
                  </label>
                  <div className='flex items-center gap-2'>
                    <input
                      type='number'
                      min={1024}
                      max={65535}
                      value={inboundPortInput}
                      onChange={(e) => setInboundPortInput(e.target.value)}
                      className='flex-1 h-8 px-2.5 rounded-lg font-mono text-xs bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none'
                    />
                    <button
                      onClick={() =>
                        void handleSaveInbound(
                          inboundConfig.enabled,
                          Number(inboundPortInput) || 17890
                        )
                      }
                      className='h-8 px-3 rounded-lg bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-subtle)] text-xs text-[var(--ui-text-secondary)] cursor-pointer'
                    >
                      应用端口
                    </button>
                  </div>
                </div>

                <div className='p-3 rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] space-y-1.5'>
                  <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)]'>
                    Bearer 鉴权密钥
                  </label>
                  <div className='flex items-center gap-2'>
                    <input
                      readOnly
                      value={revealedToken || inboundConfig.token_masked || '未生成'}
                      className='flex-1 h-8 px-2.5 rounded-lg font-mono text-xs bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none select-text'
                    />
                    {revealedToken && (
                      <button
                        onClick={() => handleCopyText('inbound_token', revealedToken)}
                        className='h-8 px-2.5 rounded-lg bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] text-xs flex items-center gap-1 cursor-pointer'
                      >
                        {copiedId === 'inbound_token' ? <Check size={12} /> : <Copy size={12} />}
                        <span>复制</span>
                      </button>
                    )}
                    <button
                      onClick={() => void handleRotateToken()}
                      className='h-8 px-2.5 rounded-lg bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-subtle)] text-xs text-[var(--ui-text-secondary)] flex items-center gap-1 cursor-pointer'
                      title='重新生成新 Token（旧 Token 立即失效）'
                    >
                      <RotateCw size={12} />
                      <span>轮换密钥</span>
                    </button>
                  </div>
                </div>
              </div>

              {rules.length > 0 && (
                <div className='p-3.5 rounded-xl bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-hairline)] space-y-2'>
                  <div className='flex items-center justify-between'>
                    <span className='text-[11px] font-medium text-[var(--ui-text-secondary)]'>
                      cURL 外部触发示例（以「{rules[0].name}」为例）
                    </span>
                    <button
                      onClick={() => {
                        const port = inboundStatus.port || inboundConfig.port || 17890;
                        const tokenStr = revealedToken || '<YOUR_BEARER_TOKEN>';
                        const cmd = `curl -X POST http://127.0.0.1:${port}/hooks/automation/${rules[0].id} \\\n  -H "Authorization: Bearer ${tokenStr}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"input":"请重点汇总今天下午的变更"}'`;
                        handleCopyText('curl_sample', cmd);
                      }}
                      className='text-[11px] text-[var(--ui-accent-blue)] hover:underline flex items-center gap-1 cursor-pointer'
                    >
                      {copiedId === 'curl_sample' ? <Check size={11} /> : <Copy size={11} />}
                      <span>{copiedId === 'curl_sample' ? '已复制' : '复制命令'}</span>
                    </button>
                  </div>
                  <pre className='text-[11px] font-mono text-[var(--ui-text-muted)] overflow-x-auto select-text leading-relaxed'>
                    {`curl -X POST http://127.0.0.1:${inboundStatus.port || inboundConfig.port || 17890}/hooks/automation/${rules[0].id} \\
  -H "Authorization: Bearer ${revealedToken || '<点击上方轮换密钥获取完整Token>'}" \\
  -H "Content-Type: application/json" \\
  -d '{"input":"附加触发上下文"}'`}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <AutomationRuleModal
        open={ruleModalOpen}
        editingRule={editingRule}
        presetSeed={presetSeed}
        workspaces={workspaces}
        models={models}
        webhookTargets={webhookTargets}
        defaultWorkDir={defaultWorkDir}
        onClose={() => setRuleModalOpen(false)}
        onSaved={() => {
          void loadAll();
          showNotice('ok', editingRule ? '定时任务已更新' : '定时任务已创建');
        }}
      />

      <WebhookTargetModal
        open={webhookModalOpen}
        editingTarget={editingWebhook}
        onClose={() => setWebhookModalOpen(false)}
        onSaved={() => {
          void loadAll();
          showNotice('ok', '推送通道已保存');
        }}
      />
    </div>
  );
};

export default AutomationsView;
