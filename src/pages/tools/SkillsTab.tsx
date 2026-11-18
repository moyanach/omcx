import React, { useState } from 'react';
import {
  Sparkles,
  FolderGit2,
  Globe,
  Power,
  Trash2,
  Upload,
  Store,
} from 'lucide-react';
import { SkillItem } from '@/stores/chatStore';
import SkillMarketModal from '@/components/skills/SkillMarketModal';

interface SkillsTabProps {
  skills: SkillItem[];
  workDir?: string;
  refreshMcpAndSkills: (workDir?: string) => Promise<void>;
  onInspectSkill: (skill: SkillItem) => void;
}

export const SkillsTab: React.FC<SkillsTabProps> = ({
  skills,
  workDir,
  refreshMcpAndSkills,
  onInspectSkill,
}) => {
  const [skillFilter, setSkillFilter] = useState<'all' | 'project' | 'global'>('all');
  const [skillNotice, setSkillNotice] = useState('');
  const [marketOpen, setMarketOpen] = useState(false);

  // 技能次级筛选
  const filteredSkills = skills.filter((s) => {
    if (skillFilter === 'project') return s.scope === 'project';
    if (skillFilter === 'global') return s.scope === 'global';
    return true;
  });

  const projectSkillsCount = skills.filter((s) => s.scope === 'project').length;
  const globalSkillsCount = skills.filter((s) => s.scope === 'global').length;

  const flashSkillNotice = (text: string) => {
    setSkillNotice(text);
    setTimeout(() => setSkillNotice((current) => (current === text ? '' : current)), 3000);
  };

  const handleToggleSkill = async (skill: SkillItem, event: React.MouseEvent) => {
    event.stopPropagation();
    if (!window.electronAPI?.toggleSkill) return;
    const nextEnabled = skill.enabled === false;
    const res = await window.electronAPI.toggleSkill(skill.name, nextEnabled);
    if (!res?.success) {
      flashSkillNotice(res?.error || '切换技能状态失败');
      return;
    }
    flashSkillNotice(nextEnabled ? `已启用「${skill.name}」` : `已停用「${skill.name}」`);
    await refreshMcpAndSkills(workDir);
  };

  const handleDeleteSkill = async (skill: SkillItem, event: React.MouseEvent) => {
    event.stopPropagation();
    if (!window.electronAPI?.deleteSkill || !skill.filePath) return;
    const confirmed = window.confirm(
      `确认删除技能「${skill.name}」？\n\n将删除磁盘上的技能文件${
        skill.scope === 'project' ? '（项目专属技能，仅影响当前项目）' : ''
      }，此操作不可撤销。`
    );
    if (!confirmed) return;
    const res = await window.electronAPI.deleteSkill(skill.filePath, workDir);
    if (!res?.success) {
      flashSkillNotice(res?.error || '删除技能失败');
      return;
    }
    flashSkillNotice(`已删除「${skill.name}」`);
    await refreshMcpAndSkills(workDir);
  };

  const handleImportSkill = async (mode: 'file' | 'folder') => {
    if (!window.electronAPI?.importSkill) return;
    const payload = { mode, workDir: workDir };
    let res = await window.electronAPI.importSkill(payload);
    if (res?.canceled) return;
    if (res?.code === 'exists') {
      const overwrite = window.confirm(`技能「${res.name}」已存在，是否覆盖安装？`);
      if (!overwrite) return;
      res = await window.electronAPI.importSkill({ ...payload, sourcePath: res.sourcePath, overwrite: true });
    }
    if (!res?.success) {
      flashSkillNotice(res?.error || '导入技能失败');
      return;
    }
    flashSkillNotice(`已导入「${res.name}」`);
    await refreshMcpAndSkills(workDir);
  };

  return (
    <>
            <div className='flex flex-col gap-4'>
              {/* 次级筛选与操作工具条 */}
              <div className='px-4 py-2.5 rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] shadow-sm flex flex-wrap items-center justify-between gap-3'>
                <div className='flex items-center gap-1 bg-[var(--ui-card-inner-bg)] p-1 rounded-xl border border-[color:var(--ui-border-hairline)]'>
                  <button
                    onClick={() => setSkillFilter('all')}
                    className={`px-3 py-1 rounded-lg text-xs transition-colors cursor-pointer ${
                      skillFilter === 'all'
                        ? 'bg-[var(--ui-chip-hover-bg)] text-[var(--ui-text-primary)] font-semibold shadow-sm'
                        : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]'
                    }`}
                  >
                    全部 ({skills.length})
                  </button>
                  <button
                    onClick={() => setSkillFilter('project')}
                    className={`px-3 py-1 rounded-lg text-xs transition-colors flex items-center gap-1.5 cursor-pointer ${
                      skillFilter === 'project'
                        ? 'bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] font-semibold border border-[color:var(--ui-accent-emerald-border)]'
                        : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]'
                    }`}
                  >
                    <FolderGit2 size={12} />
                    <span>项目专属 ({projectSkillsCount})</span>
                  </button>
                  <button
                    onClick={() => setSkillFilter('global')}
                    className={`px-3 py-1 rounded-lg text-xs transition-colors flex items-center gap-1.5 cursor-pointer ${
                      skillFilter === 'global'
                        ? 'bg-[var(--ui-accent-blue-soft)] text-[var(--ui-accent-blue)] font-semibold border border-[color:var(--ui-accent-blue-border)]'
                        : 'text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-block-hover-bg)]'
                    }`}
                  >
                    <Globe size={12} />
                    <span>系统全局 ~/.agents/skills ({globalSkillsCount})</span>
                  </button>
                </div>

                <div className='flex items-center gap-2 flex-shrink-0'>
                  {skillNotice && (
                    <span className='text-[11px] text-[var(--ui-accent-emerald)] max-w-[220px] truncate'>{skillNotice}</span>
                  )}
                  <button
                    onClick={() => handleImportSkill('file')}
                    className='h-7 px-2.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] transition-colors flex items-center gap-1.5 cursor-pointer'
                    title='导入单个 .md 技能或 .zip 技能包到 ~/.omcx/skills'
                  >
                    <Upload size={12} />
                    <span>上传技能</span>
                  </button>
                  <button
                    onClick={() => handleImportSkill('folder')}
                    className='h-7 px-2.5 rounded-lg bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[11px] text-[var(--ui-text-secondary)] hover:text-[var(--ui-text-primary)] hover:bg-[var(--ui-chip-hover-bg)] transition-colors flex items-center gap-1.5 cursor-pointer'
                    title='导入包含 SKILL.md 的技能文件夹'
                  >
                    <FolderGit2 size={12} />
                    <span>导入文件夹</span>
                  </button>
                  <button
                    onClick={() => setMarketOpen(true)}
                    className='h-7 px-2.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-600 border border-emerald-500/40 text-[11px] text-white font-medium transition-colors flex items-center gap-1.5 cursor-pointer shadow-sm'
                    title='粘贴技能市场链接，分页浏览并直接下载'
                  >
                    <Store size={12} />
                    <span>技能市场</span>
                  </button>
                </div>
              </div>

            {/* 卡片网格 */}
            {filteredSkills.length === 0 ? (
              <div className='py-16 text-center rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] text-xs text-[var(--ui-text-muted)]'>
                当前分类下暂无已声明的技能规范
              </div>
            ) : (
              <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5'>
                {filteredSkills.map((skill) => {
                  const isProject = skill.scope === 'project';
                  return (
                    <div
                      key={skill.id}
                      onClick={() => onInspectSkill(skill)}
                      className={`p-4 rounded-2xl bg-[var(--ui-card-bg)] border border-[color:var(--ui-border-subtle)] hover:bg-[var(--ui-card-hover-bg)] hover:border-[color:var(--ui-accent-blue-border)] hover:shadow-md transition-all duration-150 cursor-pointer flex flex-col justify-between gap-3 group shadow-sm ${
                        skill.enabled === false ? 'opacity-65' : ''
                      }`}
                    >
                      <div className='flex flex-col gap-2.5'>
                        <div className='flex items-center justify-between gap-2'>
                          <div className='flex items-center gap-2 min-w-0'>
                            <Sparkles size={14} className='text-[var(--ui-accent-amber)] flex-shrink-0' />
                            <span className='font-bold text-sm text-[var(--ui-text-primary)] group-hover:text-[var(--ui-accent-blue)] transition-colors truncate'>
                              {skill.name}
                            </span>
                          </div>
                          <div className='flex items-center gap-1.5 flex-shrink-0'>
                            {skill.version && (
                              <span className='px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-[var(--ui-chip-bg)] text-[var(--ui-text-secondary)] border border-[color:var(--ui-border-hairline)]'>
                                v{skill.version}
                              </span>
                            )}
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-wide border ${
                                isProject
                                  ? 'bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border-[color:var(--ui-accent-emerald-border)]'
                                  : 'bg-[var(--ui-chip-bg)] text-[var(--ui-text-secondary)] border-[color:var(--ui-border-hairline)]'
                              }`}
                            >
                              {isProject ? 'Project' : 'Global'}
                            </span>
                            {skill.enabled === false && (
                              <span className='px-1.5 py-0.5 rounded-full text-[10px] bg-[var(--ui-accent-amber-soft)] text-[var(--ui-accent-amber)] border border-[color:var(--ui-accent-amber-border)]'>
                                已停用
                              </span>
                            )}
                            <button
                              onClick={(event) => handleToggleSkill(skill, event)}
                              className={`p-1 rounded-md border transition-colors cursor-pointer ${
                                skill.enabled === false
                                  ? 'bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border-[color:var(--ui-border-hairline)] hover:text-[var(--ui-accent-emerald)] hover:border-[color:var(--ui-accent-emerald-border)]'
                                  : 'bg-[var(--ui-accent-emerald-soft)] text-[var(--ui-accent-emerald)] border-[color:var(--ui-accent-emerald-border)] hover:brightness-110'
                              }`}
                              title={skill.enabled === false ? '点击启用（重新注入 Agent 上下文）' : '点击停用（不再进入 Agent 上下文）'}
                            >
                              <Power size={12} />
                            </button>
                            <button
                              onClick={(event) => handleDeleteSkill(skill, event)}
                              className='p-1 rounded-md bg-[var(--ui-chip-bg)] text-[var(--ui-text-muted)] border border-[color:var(--ui-border-hairline)] hover:text-[var(--ui-accent-rose)] hover:bg-[var(--ui-accent-rose-soft)] hover:border-[color:var(--ui-accent-rose-border)] transition-colors cursor-pointer'
                              title='删除该技能文件'
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>

                        <p className='text-xs text-[var(--ui-text-secondary)] line-clamp-3 leading-relaxed'>
                          {skill.description || '无详细描述'}
                        </p>
                      </div>

                      <div className='space-y-2 pt-2.5 border-t border-[color:var(--ui-divider-hairline)]'>
                        {/* 依赖工具列表 */}
                        <div className='flex items-center gap-1.5 flex-wrap min-h-[20px]'>
                          {skill.tools && skill.tools.length > 0 ? (
                            skill.tools.map((t, idx) => (
                              <span
                                key={idx}
                                className='px-2 py-0.5 rounded-md bg-[var(--ui-chip-bg)] border border-[color:var(--ui-border-hairline)] text-[10px] font-mono text-[var(--ui-text-secondary)]'
                              >
                                {t}
                              </span>
                            ))
                          ) : (
                            <span className='text-[10px] text-[var(--ui-text-muted)] font-mono'>无特定依赖工具</span>
                          )}
                        </div>

                        {/* 权限范围与可执行脚本 */}
                        {((skill.allowedTools?.length ?? 0) > 0 || (skill.scripts?.length ?? 0) > 0) && (
                          <div className='flex items-center gap-1.5 flex-wrap'>
                            {skill.allowedTools && skill.allowedTools.length > 0 && (
                              <span
                                className='px-2 py-0.5 rounded-md bg-[var(--ui-accent-blue-soft)] border border-[color:var(--ui-accent-blue-border)] text-[10px] font-mono text-[var(--ui-accent-blue)]'
                                title={`激活此技能时仅允许调用: ${skill.allowedTools.join(', ')}`}
                              >
                                允许工具 {skill.allowedTools.length}
                              </span>
                            )}
                            {skill.scripts && skill.scripts.length > 0 && (
                              <span
                                className='px-2 py-0.5 rounded-md bg-[var(--ui-accent-emerald-soft)] border border-[color:var(--ui-accent-emerald-border)] text-[10px] font-mono text-[var(--ui-accent-emerald)]'
                                title={skill.scripts.map((s) => s.name).join(', ')}
                              >
                                可执行脚本 {skill.scripts.length}
                              </span>
                            )}
                          </div>
                        )}

                        {/* 路径缩略 */}
                        {skill.filePath && (
                          <div className='text-[10px] font-mono text-[var(--ui-text-muted)] truncate' title={skill.filePath}>
                            {skill.filePath}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
      <SkillMarketModal
        open={marketOpen}
        onClose={() => setMarketOpen(false)}
        onInstalled={() => refreshMcpAndSkills(workDir)}
      />
    </>
  );
};
