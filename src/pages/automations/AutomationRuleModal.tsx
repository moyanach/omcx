import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, FolderOpen, Sparkles, Clock, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { LlmModelItem, WorkspaceItem } from '@/stores/chatStore';
import {
  AUTOMATION_PRESETS,
  CRON_SHORTCUTS,
  type AutomationPreset,
  type AutomationRule,
  type WebhookTargetView,
} from './automationPresets';

interface Props {
  open: boolean;
  editingRule: AutomationRule | null;
  presetSeed?: AutomationPreset | null;
  workspaces: WorkspaceItem[];
  models: LlmModelItem[];
  webhookTargets: WebhookTargetView[];
  defaultWorkDir: string | null;
  onClose: () => void;
  onSaved: (rule: AutomationRule) => void;
}

export const AutomationRuleModal: React.FC<Props> = ({
  open,
  editingRule,
  presetSeed,
  workspaces,
  models,
  webhookTargets,
  defaultWorkDir,
  onClose,
  onSaved,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [scheduleType, setScheduleType] = useState<'interval' | 'cron' | 'manual'>('cron');
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [cronExpr, setCronExpr] = useState('0 9 * * 1-5');
  const [prompt, setPrompt] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [agentMode, setAgentMode] = useState<'work' | 'code'>('work');
  const [permissionMode, setPermissionMode] = useState<'auto' | 'plan'>('auto');
  const [model, setModel] = useState('');
  const [webhookTargetId, setWebhookTargetId] = useState('');
  const [notifyOn, setNotifyOn] = useState<'always' | 'on_error' | 'never'>('always');

  const [cronPreview, setCronPreview] = useState<{
    valid: boolean;
    error?: string;
    nextRuns: number[];
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (editingRule) {
      setName(editingRule.name);
      setDescription(editingRule.description || '');
      setEnabled(editingRule.enabled);
      setScheduleType(editingRule.schedule_type);
      setIntervalMinutes(editingRule.interval_minutes || 60);
      setCronExpr(editingRule.cron_expr || '0 9 * * 1-5');
      setPrompt(editingRule.prompt || '');
      setWorkDir(editingRule.work_dir || '');
      setAgentMode(editingRule.agent_mode === 'code' ? 'code' : 'work');
      setPermissionMode(editingRule.permission_mode === 'plan' ? 'plan' : 'auto');
      setModel(editingRule.model || '');
      setWebhookTargetId(editingRule.webhook_target_id || '');
      setNotifyOn(editingRule.notify_on || 'always');
    } else if (presetSeed) {
      setName(presetSeed.name);
      setDescription(presetSeed.description);
      setEnabled(true);
      setScheduleType(presetSeed.schedule_type);
      setIntervalMinutes(presetSeed.interval_minutes);
      setCronExpr(presetSeed.cron_expr);
      setPrompt(presetSeed.prompt);
      setWorkDir(defaultWorkDir || '');
      setAgentMode(presetSeed.agent_mode);
      setPermissionMode(presetSeed.permission_mode);
      setModel('');
      setWebhookTargetId('');
      setNotifyOn('always');
    } else {
      setName('');
      setDescription('');
      setEnabled(true);
      setScheduleType('cron');
      setIntervalMinutes(60);
      setCronExpr('0 9 * * 1-5');
      setPrompt('');
      setWorkDir(defaultWorkDir || '');
      setAgentMode('work');
      setPermissionMode('auto');
      setModel('');
      setWebhookTargetId('');
      setNotifyOn('always');
    }
  }, [open, editingRule, presetSeed, defaultWorkDir]);

  useEffect(() => {
    if (!open || scheduleType !== 'cron') {
      setCronPreview(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await window.electronAPI?.previewCronExpression?.(cronExpr);
        if (!cancelled && res) {
          setCronPreview(res);
        }
      } catch {}
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, scheduleType, cronExpr]);

  if (!open || typeof document === 'undefined') return null;

  const applyPreset = (p: AutomationPreset) => {
    setName(p.name);
    setDescription(p.description);
    setScheduleType(p.schedule_type);
    setIntervalMinutes(p.interval_minutes);
    setCronExpr(p.cron_expr);
    setAgentMode(p.agent_mode);
    setPermissionMode(p.permission_mode);
    setPrompt(p.prompt);
  };

  const handleSelectFolder = async () => {
    const dir = await window.electronAPI?.dialogSelectWorkDirectory?.();
    if (dir) setWorkDir(dir);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError('请填写任务名称');
      return;
    }
    if (!prompt.trim()) {
      setError('请填写执行提示词 (Prompt)');
      return;
    }
    if (scheduleType === 'cron' && cronPreview && !cronPreview.valid) {
      setError(cronPreview.error || 'Cron 表达式格式有误');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await window.electronAPI.saveAutomation({
        id: editingRule?.id,
        name: name.trim(),
        description: description.trim(),
        enabled,
        schedule_type: scheduleType,
        interval_minutes: Math.max(1, Number(intervalMinutes) || 60),
        cron_expr: cronExpr.trim(),
        prompt: prompt.trim(),
        work_dir: workDir.trim() || null,
        agent_mode: agentMode,
        permission_mode: permissionMode,
        model: model.trim(),
        webhook_target_id: webhookTargetId || null,
        notify_on: notifyOn,
      });
      if (res?.rule) {
        onSaved(res.rule);
        onClose();
      }
    } catch (err: any) {
      setError(err?.message || '保存定时任务失败');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className='fixed inset-0 z-[99999] bg-[var(--ui-modal-overlay)] backdrop-blur-sm flex items-center justify-center p-4 select-none'
      onClick={onClose}
    >
      <div
        className='w-full max-w-2xl max-h-[88vh] rounded-2xl bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] shadow-[var(--ui-popover-shadow)] flex flex-col overflow-hidden text-[var(--ui-text-primary)]'
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className='px-5 py-3.5 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between flex-shrink-0'>
          <div className='flex items-center gap-2.5'>
            <div className='w-7 h-7 rounded-lg bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] flex items-center justify-center'>
              <Clock size={14} />
            </div>
            <div>
              <h3 className='text-sm font-semibold'>
                {editingRule ? '编辑定时任务' : '新建定时任务'}
              </h3>
              <p className='text-[11px] text-[var(--ui-text-muted)]'>
                后台定时静默执行，结果自动归集到收件箱并支持 Webhook 推送
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className='p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] transition-colors cursor-pointer'
          >
            <X size={15} />
          </button>
        </div>

        {/* 主体表单 */}
        <div className='flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar'>
          {!editingRule && (
            <div className='space-y-1.5'>
              <div className='flex items-center gap-1.5 text-[11px] font-medium text-[var(--ui-text-secondary)]'>
                <Sparkles size={12} className='text-[var(--ui-accent-amber)]' />
                <span>快速套用场景模板</span>
              </div>
              <div className='grid grid-cols-2 sm:grid-cols-4 gap-2'>
                {AUTOMATION_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type='button'
                    onClick={() => applyPreset(p)}
                    className='text-left px-2.5 py-2 rounded-xl bg-[var(--ui-card-bg)] hover:bg-[var(--ui-block-hover-bg)] border border-[color:var(--ui-border-hairline)] transition-colors cursor-pointer'
                  >
                    <div className='text-[11px] font-semibold text-[var(--ui-text-primary)] truncate'>
                      {p.name}
                    </div>
                    <div className='text-[10px] text-[var(--ui-text-muted)] truncate mt-0.5'>
                      {p.agent_mode === 'work' ? 'Work 模式' : 'Code 模式'} ·{' '}
                      {p.permission_mode === 'plan' ? '只读' : '沙箱写'}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className='grid grid-cols-1 sm:grid-cols-3 gap-3'>
            <div className='sm:col-span-2'>
              <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
                任务名称 *
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='例如：每日项目进展简报'
                className='w-full h-9 px-3 rounded-xl text-xs bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none focus:border-blue-500/60'
              />
            </div>
            <div>
              <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
                启用调度
              </label>
              <button
                type='button'
                onClick={() => setEnabled((v) => !v)}
                className={`w-full h-9 px-3 rounded-xl text-xs font-medium border flex items-center justify-between cursor-pointer transition-colors ${
                  enabled
                    ? 'bg-[var(--ui-accent-blue-soft)] border-[color:var(--ui-accent-blue-border)] text-[var(--ui-accent-blue)]'
                    : 'bg-[var(--ui-card-bg)] border-[color:var(--ui-border-subtle)] text-[var(--ui-text-muted)]'
                }`}
              >
                <span>{enabled ? '已启用定时' : '已暂停定时'}</span>
                <span
                  className={`w-2 h-2 rounded-full ${enabled ? 'bg-blue-500' : 'bg-neutral-500'}`}
                />
              </button>
            </div>
          </div>

          <div>
            <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
              简短说明（可选）
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder='说明该定时任务的目的或适用目录'
              className='w-full h-8 px-3 rounded-xl text-xs bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none focus:border-blue-500/60'
            />
          </div>

          {/* 调度方式 */}
          <div className='p-3.5 rounded-xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-hairline)] space-y-2.5'>
            <div className='flex items-center justify-between gap-2 flex-wrap'>
              <span className='text-[11px] font-semibold text-[var(--ui-text-secondary)]'>
                触发频率
              </span>
              <div className='flex items-center gap-1 bg-[var(--ui-card-inner-bg)] p-0.5 rounded-lg border border-[color:var(--ui-border-hairline)]'>
                {[
                  { id: 'cron', label: 'Cron 计划' },
                  { id: 'interval', label: '固定间隔' },
                  { id: 'manual', label: '仅手动/Webhook' },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    type='button'
                    onClick={() => setScheduleType(opt.id as any)}
                    className={`px-2.5 py-1 rounded-md text-[11px] transition-colors cursor-pointer ${
                      scheduleType === opt.id
                        ? 'bg-blue-600 text-white font-medium'
                        : 'text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {scheduleType === 'interval' && (
              <div className='flex items-center gap-2 text-xs'>
                <span className='text-[var(--ui-text-muted)]'>每隔</span>
                <input
                  type='number'
                  min={1}
                  max={10080}
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(Math.max(1, Number(e.target.value) || 1))}
                  className='w-24 h-8 px-2.5 rounded-lg bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none focus:border-blue-500/60'
                />
                <span className='text-[var(--ui-text-muted)]'>分钟执行一次</span>
                <div className='flex items-center gap-1 ml-auto'>
                  {[15, 60, 120, 1440].map((m) => (
                    <button
                      key={m}
                      type='button'
                      onClick={() => setIntervalMinutes(m)}
                      className='px-2 py-1 rounded-md text-[10px] bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-block-hover-bg)] text-[var(--ui-text-secondary)] cursor-pointer'
                    >
                      {m >= 1440 ? '每天' : m >= 60 ? `${m / 60}小时` : `${m}分`}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {scheduleType === 'cron' && (
              <div className='space-y-2'>
                <div className='flex items-center gap-2'>
                  <input
                    value={cronExpr}
                    onChange={(e) => setCronExpr(e.target.value)}
                    placeholder='分 时 日 月 星期，例如: 0 9 * * 1-5'
                    className='flex-1 h-8 px-3 rounded-lg font-mono text-xs bg-[var(--ui-card-inner-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none focus:border-blue-500/60'
                  />
                </div>
                <div className='flex flex-wrap gap-1.5'>
                  {CRON_SHORTCUTS.map((s) => (
                    <button
                      key={s.expr}
                      type='button'
                      onClick={() => setCronExpr(s.expr)}
                      className={`px-2 py-0.5 rounded-md text-[10px] border cursor-pointer transition-colors ${
                        cronExpr.trim() === s.expr
                          ? 'bg-[var(--ui-accent-blue-soft)] border-[color:var(--ui-accent-blue-border)] text-[var(--ui-accent-blue)]'
                          : 'bg-[var(--ui-chip-bg)] border-transparent text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)]'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                {cronPreview && (
                  <div
                    className={`flex items-center gap-1.5 text-[11px] ${
                      cronPreview.valid ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {cronPreview.valid ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                    {cronPreview.valid ? (
                      <span>
                        下次运行：
                        {cronPreview.nextRuns[0]
                          ? new Date(cronPreview.nextRuns[0]).toLocaleString('zh-CN', {
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '无匹配时间'}
                      </span>
                    ) : (
                      <span>{cronPreview.error}</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {scheduleType === 'manual' && (
              <p className='text-[11px] text-[var(--ui-text-muted)]'>
                不按时间自动触发，仅在点击「立即执行」或外部调用本地 Webhook 时运行。
              </p>
            )}
          </div>

          {/* 执行参数 */}
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
            <div>
              <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
                目标工作目录
              </label>
              <div className='flex items-center gap-1.5'>
                <input
                  value={workDir}
                  onChange={(e) => setWorkDir(e.target.value)}
                  placeholder='可选，留空则在无目录模式下执行'
                  className='flex-1 h-8 px-2.5 rounded-lg text-xs bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none focus:border-blue-500/60'
                />
                <button
                  type='button'
                  onClick={handleSelectFolder}
                  className='h-8 px-2.5 rounded-lg bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] cursor-pointer'
                  title='选择文件夹'
                >
                  <FolderOpen size={13} />
                </button>
              </div>
              {workspaces.length > 0 && (
                <div className='flex flex-wrap gap-1 mt-1.5'>
                  {workspaces.slice(0, 4).map((ws) => {
                    const p =
                      ws.folders.find((f) => f.isPrimary)?.path || ws.folders[0]?.path || '';
                    if (!p) return null;
                    return (
                      <button
                        key={ws.id}
                        type='button'
                        onClick={() => setWorkDir(p)}
                        className='px-1.5 py-0.5 rounded text-[10px] bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] cursor-pointer truncate max-w-[140px]'
                        title={p}
                      >
                        {ws.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
                指定模型
              </label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className='w-full h-8 px-2.5 rounded-lg text-xs bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none focus:border-blue-500/60'
              >
                <option value=''>自动选用当前可用默认模型</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.model_id}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className='grid grid-cols-2 sm:grid-cols-4 gap-3'>
            <div>
              <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
                运行模式
              </label>
              <select
                value={agentMode}
                onChange={(e) => setAgentMode(e.target.value as any)}
                className='w-full h-8 px-2 rounded-lg text-xs bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none'
              >
                <option value='work'>Work 通用工作</option>
                <option value='code'>Code 编程研发</option>
              </select>
            </div>

            <div>
              <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
                安全权限
              </label>
              <select
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.target.value as any)}
                className='w-full h-8 px-2 rounded-lg text-xs bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none'
              >
                <option value='auto'>自动模式 (沙箱隔离 + AI 安全评估)</option>
                <option value='plan'>只读巡检 (Plan)</option>
              </select>
            </div>

            <div>
              <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
                Webhook 推送
              </label>
              <select
                value={webhookTargetId}
                onChange={(e) => setWebhookTargetId(e.target.value)}
                className='w-full h-8 px-2 rounded-lg text-xs bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none'
              >
                <option value=''>不推送外部通知</option>
                {webhookTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
                推送条件
              </label>
              <select
                value={notifyOn}
                disabled={!webhookTargetId}
                onChange={(e) => setNotifyOn(e.target.value as any)}
                className='w-full h-8 px-2 rounded-lg text-xs bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none disabled:opacity-50'
              >
                <option value='always'>每次完成推送</option>
                <option value='on_error'>仅异常失败时</option>
                <option value='never'>关闭推送</option>
              </select>
            </div>
          </div>

          <div>
            <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
              执行指令 (Prompt) *
            </label>
            <textarea
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder='描述定时任务触发时 Agent 需要完成的工作内容、输出格式及落盘位置...'
              className='w-full p-3 rounded-xl text-xs bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none focus:border-blue-500/60 resize-y leading-relaxed select-text'
            />
          </div>

          {error && (
            <div className='px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-center gap-2'>
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className='px-5 py-3 border-t border-[color:var(--ui-divider-hairline)] flex items-center justify-end gap-2 flex-shrink-0'>
          <button
            type='button'
            onClick={onClose}
            className='px-3.5 py-1.5 rounded-xl text-xs text-[var(--ui-text-secondary)] hover:bg-[var(--ui-chip-bg)] cursor-pointer'
          >
            取消
          </button>
          <button
            type='button'
            disabled={saving}
            onClick={handleSave}
            className='px-4 py-1.5 rounded-xl text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 cursor-pointer'
          >
            {saving ? '保存中...' : editingRule ? '保存更新' : '创建定时任务'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
