import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, BellRing, AlertCircle } from 'lucide-react';
import { WEBHOOK_PROVIDER_META, type WebhookTargetView } from './automationPresets';

interface Props {
  open: boolean;
  editingTarget: WebhookTargetView | null;
  onClose: () => void;
  onSaved: (target: WebhookTargetView) => void;
}

export const WebhookTargetModal: React.FC<Props> = ({
  open,
  editingTarget,
  onClose,
  onSaved,
}) => {
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<'feishu' | 'dingtalk' | 'wecom' | 'generic'>('feishu');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setClearSecret(false);
    if (editingTarget) {
      setName(editingTarget.name);
      setProvider(editingTarget.provider);
      setUrl('');
      setSecret('');
      setEnabled(editingTarget.enabled);
    } else {
      setName('');
      setProvider('feishu');
      setUrl('');
      setSecret('');
      setEnabled(true);
    }
  }, [open, editingTarget]);

  if (!open || typeof document === 'undefined') return null;

  const meta = WEBHOOK_PROVIDER_META[provider];

  const handleSave = async () => {
    if (!name.trim()) {
      setError('请填写推送通道名称');
      return;
    }
    if (!editingTarget && !url.trim()) {
      setError('请填写 Webhook 地址');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await window.electronAPI.saveWebhookTarget({
        id: editingTarget?.id,
        name: name.trim(),
        provider,
        url: url.trim(),
        preserveUrl: Boolean(editingTarget && !url.trim()),
        secret: secret.trim(),
        preserveSecret: Boolean(editingTarget && !secret.trim() && !clearSecret),
        clearSecret,
        enabled,
      });
      if (res?.target) {
        onSaved(res.target);
        onClose();
      }
    } catch (err: any) {
      setError(err?.message || '保存通道配置失败');
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
        className='w-full max-w-lg rounded-2xl bg-[var(--ui-popover-bg)] border border-[color:var(--ui-border-subtle)] shadow-[var(--ui-popover-shadow)] flex flex-col overflow-hidden text-[var(--ui-text-primary)]'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='px-5 py-3.5 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <div className='w-7 h-7 rounded-lg bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] flex items-center justify-center'>
              <BellRing size={14} />
            </div>
            <div>
              <h3 className='text-sm font-semibold'>
                {editingTarget ? '编辑通知推送通道' : '添加通知推送通道'}
              </h3>
              <p className='text-[11px] text-[var(--ui-text-muted)]'>
                Webhook URL 与签名密钥均经系统安全存储加密保存
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className='p-1.5 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-bg)] cursor-pointer'
          >
            <X size={15} />
          </button>
        </div>

        <div className='p-5 space-y-3.5'>
          <div>
            <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1.5'>
              渠道类型
            </label>
            <div className='grid grid-cols-4 gap-1.5'>
              {(['feishu', 'dingtalk', 'wecom', 'generic'] as const).map((key) => (
                <button
                  key={key}
                  type='button'
                  onClick={() => setProvider(key)}
                  className={`py-2 px-2 rounded-xl text-[11px] font-medium border transition-colors cursor-pointer ${
                    provider === key
                      ? 'bg-[var(--ui-accent-blue-soft)] border-[color:var(--ui-accent-blue-border)] text-[var(--ui-accent-blue)]'
                      : 'bg-[var(--ui-card-bg)] border-[color:var(--ui-border-hairline)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)]'
                  }`}
                >
                  {WEBHOOK_PROVIDER_META[key].label.replace('群机器人', '').replace('机器人', '')}
                </button>
              ))}
            </div>
            <p className='text-[11px] text-[var(--ui-text-muted)] mt-1.5 leading-relaxed'>
              {meta.hint}
            </p>
          </div>

          <div className='grid grid-cols-3 gap-2.5'>
            <div className='col-span-2'>
              <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
                通道名称 *
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`例如：研发日报群（${meta.badge}）`}
                className='w-full h-9 px-3 rounded-xl text-xs bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none focus:border-blue-500/60'
              />
            </div>
            <div>
              <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
                状态
              </label>
              <button
                type='button'
                onClick={() => setEnabled((v) => !v)}
                className={`w-full h-9 px-3 rounded-xl text-xs border flex items-center justify-between cursor-pointer ${
                  enabled
                    ? 'bg-[var(--ui-accent-blue-soft)] border-[color:var(--ui-accent-blue-border)] text-[var(--ui-accent-blue)]'
                    : 'bg-[var(--ui-card-bg)] border-[color:var(--ui-border-subtle)] text-[var(--ui-text-muted)]'
                }`}
              >
                <span>{enabled ? '启用' : '停用'}</span>
                <span className={`w-2 h-2 rounded-full ${enabled ? 'bg-blue-500' : 'bg-neutral-500'}`} />
              </button>
            </div>
          </div>

          <div>
            <label className='block text-[11px] font-medium text-[var(--ui-text-secondary)] mb-1'>
              Webhook URL {editingTarget?.has_url ? '（留空则保持原有地址不变）' : '*'}
            </label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                editingTarget?.has_url
                  ? `已配置: ${editingTarget.url_masked}`
                  : meta.urlPlaceholder
              }
              className='w-full h-9 px-3 rounded-xl text-xs font-mono bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none focus:border-blue-500/60 select-text'
            />
          </div>

          <div>
            <div className='flex items-center justify-between mb-1'>
              <label className='text-[11px] font-medium text-[var(--ui-text-secondary)]'>
                {meta.secretLabel}
              </label>
              {editingTarget?.has_secret && !clearSecret && (
                <button
                  type='button'
                  onClick={() => {
                    setClearSecret(true);
                    setSecret('');
                  }}
                  className='text-[10px] text-red-400 hover:underline cursor-pointer'
                >
                  清除已有密钥
                </button>
              )}
            </div>
            <input
              type='password'
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                if (e.target.value) setClearSecret(false);
              }}
              placeholder={
                clearSecret
                  ? '保存后将移除签名密钥'
                  : editingTarget?.has_secret
                  ? `已加密保存 (${editingTarget.secret_masked})，留空不变`
                  : meta.secretPlaceholder
              }
              className='w-full h-9 px-3 rounded-xl text-xs font-mono bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-[var(--ui-text-primary)] outline-none focus:border-blue-500/60 select-text'
            />
          </div>

          {error && (
            <div className='px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400 flex items-center gap-2'>
              <AlertCircle size={14} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className='px-5 py-3 border-t border-[color:var(--ui-divider-hairline)] flex items-center justify-end gap-2'>
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
            {saving ? '保存中...' : '保存通道'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
