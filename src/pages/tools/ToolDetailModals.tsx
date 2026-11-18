import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, Bot, Copy, Check, X, FileCode } from 'lucide-react';
import { SkillItem, SubagentItem } from '@/stores/chatStore';

interface ToolDetailModalsProps {
  inspectingSkill: SkillItem | null;
  inspectingSubagent: SubagentItem | null;
  onCloseSkill: () => void;
  onCloseSubagent: () => void;
}

export const ToolDetailModals: React.FC<ToolDetailModalsProps> = ({
  inspectingSkill,
  inspectingSubagent,
  onCloseSkill,
  onCloseSubagent,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopyPrompt = (text: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      {/* ═════════ 3. SKILL 详情弹窗 (createPortal 挂载至 body 顶层，z-[99999] 防遮挡) ═════════ */}
      {inspectingSkill && typeof document !== 'undefined' && createPortal(
        <div
          className='fixed inset-0 z-[99999] bg-[var(--ui-modal-overlay)] backdrop-blur-sm flex items-center justify-center p-6 select-none animate-in fade-in duration-150'
          onClick={() => onCloseSkill()}
        >
          <div
            className='w-full max-w-2xl bg-[var(--ui-modal-bg)] backdrop-blur-2xl backdrop-saturate-150 border border-[color:var(--ui-border-subtle)] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] text-[var(--ui-text-primary)]'
            onClick={(e) => e.stopPropagation()}
          >
            {/* 弹窗头部 */}
            <div className='px-5 py-3.5 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between flex-shrink-0'>
              <div className='flex items-center gap-2 min-w-0'>
                <Sparkles size={16} className='text-yellow-400 flex-shrink-0' />
                <h3 className='font-bold text-sm text-[var(--ui-text-primary)] truncate'>
                  {inspectingSkill.name}
                </h3>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${
                    inspectingSkill.scope === 'project'
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                      : 'bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border-[color:var(--ui-border-hairline)]'
                  }`}
                >
                  {inspectingSkill.scope === 'project' ? 'Project' : 'Global'}
                </span>
                {inspectingSkill.version && (
                  <span className='px-1.5 py-0.2 rounded text-[10px] font-mono bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border border-[color:var(--ui-border-hairline)]'>
                    v{inspectingSkill.version}
                  </span>
                )}
              </div>

              <div className='flex items-center gap-1.5 flex-shrink-0'>
                <button
                  onClick={() => handleCopyPrompt(inspectingSkill.prompt || '')}
                  className='px-2.5 py-1 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] text-xs flex items-center gap-1 transition-colors'
                  title='复制 Prompt'
                >
                  {copied ? <Check size={12} className='text-emerald-400' /> : <Copy size={12} />}
                  <span>{copied ? '已复制' : '复制'}</span>
                </button>
                <button
                  onClick={() => onCloseSkill()}
                  className='p-1 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors'
                  title='关闭'
                >
                  <X size={15} />
                </button>
              </div>
            </div>

            {/* 弹窗信息栏 */}
            <div className='px-5 py-3 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-inner-bg)] flex flex-col gap-2 flex-shrink-0 text-xs'>
              {inspectingSkill.description && (
                <p className='text-[var(--ui-text-secondary)] leading-relaxed'>{inspectingSkill.description}</p>
              )}
              {inspectingSkill.filePath && (
                <div className='flex items-center gap-1.5 text-[11px] text-[var(--ui-text-muted)] font-mono truncate'>
                  <FileCode size={12} className='flex-shrink-0 text-[var(--ui-text-muted)]' />
                  <span className='truncate'>{inspectingSkill.filePath}</span>
                </div>
              )}
              {inspectingSkill.tools && inspectingSkill.tools.length > 0 && (
                <div className='flex items-center gap-1.5 flex-wrap pt-1'>
                  <span className='text-[10px] text-[var(--ui-text-faint)]'>依赖工具:</span>
                  {inspectingSkill.tools.map((t, idx) => (
                    <span
                      key={idx}
                      className='px-2 py-0.5 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[10px] font-mono text-[var(--ui-text-secondary)]'
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Prompt 正文 */}
            <div className='flex-1 overflow-y-auto p-5 custom-scrollbar'>
              <pre className='text-xs font-mono text-[var(--ui-text-primary)] whitespace-pre-wrap leading-relaxed select-text'>
                {inspectingSkill.prompt || '该技能未包含额外的提示词正文'}
              </pre>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ═════════ 4. SUBAGENT 详情弹窗 (createPortal 挂载至 body 顶层) ═════════ */}
      {inspectingSubagent && typeof document !== 'undefined' && createPortal(
        <div
          className='fixed inset-0 z-[99999] bg-[var(--ui-modal-overlay)] backdrop-blur-sm flex items-center justify-center p-6 select-none animate-in fade-in duration-150'
          onClick={() => onCloseSubagent()}
        >
          <div
            className='w-full max-w-2xl bg-[var(--ui-modal-bg)] backdrop-blur-2xl backdrop-saturate-150 border border-[color:var(--ui-border-subtle)] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] text-[var(--ui-text-primary)]'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='px-5 py-3.5 border-b border-[color:var(--ui-divider-hairline)] flex items-center justify-between flex-shrink-0'>
              <div className='flex items-center gap-2 min-w-0'>
                <Bot size={16} className='text-sky-400 flex-shrink-0' />
                <h3 className='font-bold text-sm text-[var(--ui-text-primary)] truncate'>
                  {inspectingSubagent.name}
                </h3>
                <code className='px-2 py-0.5 rounded text-[10px] font-mono bg-[var(--ui-chip-bg)] text-sky-400 border border-[color:var(--ui-border-hairline)]'>
                  @agent:{inspectingSubagent.id}
                </code>
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-mono border ${
                    inspectingSubagent.readOnly
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25'
                      : 'bg-amber-500/10 text-amber-300 border-amber-500/25'
                  }`}
                >
                  {inspectingSubagent.readOnly ? '只读安全' : '完整读写'}
                </span>
              </div>

              <div className='flex items-center gap-1.5 flex-shrink-0'>
                <button
                  onClick={() => handleCopyPrompt(inspectingSubagent.systemPrompt || '')}
                  className='px-2.5 py-1 rounded-lg bg-[var(--ui-chip-bg)] hover:bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] text-xs flex items-center gap-1 transition-colors'
                  title='复制系统提示词'
                >
                  {copied ? <Check size={12} className='text-emerald-400' /> : <Copy size={12} />}
                  <span>{copied ? '已复制' : '复制'}</span>
                </button>
                <button
                  onClick={() => onCloseSubagent()}
                  className='p-1 rounded-lg text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)] transition-colors'
                  title='关闭'
                >
                  <X size={15} />
                </button>
              </div>
            </div>

            <div className='px-5 py-3 border-b border-[color:var(--ui-divider-hairline)] bg-[var(--ui-card-inner-bg)] flex flex-col gap-2 flex-shrink-0 text-xs'>
              <p className='text-[var(--ui-text-secondary)] leading-relaxed'>{inspectingSubagent.description}</p>
              <div className='flex items-center gap-1.5 flex-wrap pt-1'>
                <span className='text-[10px] text-[var(--ui-text-faint)]'>授权工具白名单:</span>
                {(inspectingSubagent.tools || []).map((t) => (
                  <span
                    key={t}
                    className='px-2 py-0.5 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[10px] font-mono text-[var(--ui-text-secondary)]'
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>

            <div className='flex-1 overflow-y-auto p-5 custom-scrollbar'>
              <pre className='text-xs font-mono text-[var(--ui-text-primary)] whitespace-pre-wrap leading-relaxed select-text'>
                {inspectingSubagent.systemPrompt || '无独立系统提示词'}
              </pre>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
