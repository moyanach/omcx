import React, { useEffect, useRef, useState } from "react";
import { Edit2, MessageSquare, Plus, Trash2, FolderGit2 } from "lucide-react";
import { Session } from "../../stores/chatStore";

interface Props {
  sessions: Session[];
  activeSessionId: string | null;
  onAddSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
}

const SessionList: React.FC<Props> = ({
  sessions,
  activeSessionId,
  onAddSession,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
}) => {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingSessionId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingSessionId]);

  const startRename = (session: Session) => {
    setEditingSessionId(session.id);
    setEditingTitle(session.title);
  };

  const finishRename = (sessionId: string) => {
    const nextTitle = editingTitle.trim();
    if (!nextTitle) {
      setEditingSessionId(null);
      setEditingTitle("");
      return;
    }

    onRenameSession(sessionId, nextTitle);
    setEditingSessionId(null);
    setEditingTitle("");
  };

  // 过滤未归档的活动会话
  const activeSessions = sessions.filter((s) => !s.archived);

  return (
    <div className="w-[260px] h-full bg-[#141414] border-r border-[#222222] flex flex-col flex-shrink-0 select-none">
      {/* 顶部现代化新建会话按钮 (彻底去掉图 6 突兀的聊天标题和右侧加号) */}
      <div className="p-3 border-b border-[#202020] flex-shrink-0">
        <button
          onClick={onAddSession}
          className="w-full h-9 px-3 rounded-xl bg-[#1c1c1c] hover:bg-[#242424] active:bg-[#1a1a1a] border border-[#2b2b2b] hover:border-[#383838] text-neutral-200 hover:text-white flex items-center justify-between transition-all duration-150 shadow-sm group"
        >
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-md bg-blue-500/10 text-blue-400 flex items-center justify-center">
              <Plus size={13} />
            </div>
            <span className="text-xs font-semibold">新建会话</span>
          </div>
          <span className="text-[10px] text-neutral-500 font-mono group-hover:text-neutral-400">
            ⌘N
          </span>
        </button>
      </div>

      {/* 现有会话列表 (异化色彩，告别突兀紫色，采用项目统一的深空科技蓝/暗夜灰) */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        {activeSessions.length === 0 ? (
          <div className="py-8 text-center text-xs text-neutral-500">
            暂无活动会话，点击上方新建
          </div>
        ) : (
          activeSessions.map((session) => {
            const isEditing = editingSessionId === session.id;
            const isActive = activeSessionId === session.id;

            return (
              <div
                key={session.id}
                onClick={() => !isEditing && onSelectSession(session.id)}
                className={`group relative flex flex-col gap-1 px-2.5 py-2 rounded-xl cursor-pointer transition-all duration-150 border ${
                  isActive
                    ? "bg-blue-500/10 text-blue-300 border-blue-500/25 shadow-sm font-medium"
                    : "text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.03] border-transparent"
                }`}
              >
                <div className="flex items-center gap-2">
                  <MessageSquare
                    size={14}
                    className={`flex-shrink-0 ${
                      isActive ? "text-blue-400" : "text-neutral-500 group-hover:text-neutral-400"
                    }`}
                  />

                  {isEditing ? (
                    <input
                      ref={inputRef}
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          finishRename(session.id);
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setEditingSessionId(null);
                          setEditingTitle("");
                        }
                      }}
                      onBlur={() => finishRename(session.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="h-6 flex-1 px-1.5 text-xs rounded bg-[#202020] text-neutral-100 border border-blue-500 outline-none"
                    />
                  ) : (
                    <span className="text-xs truncate flex-1 tracking-tight">
                      {session.title || "新的 Agent 会话"}
                    </span>
                  )}

                  {/* 悬浮操作按钮 */}
                  {!isEditing && (
                    <div className="hidden group-hover:flex items-center gap-0.5 flex-shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(session);
                        }}
                        className="p-1 text-neutral-500 hover:text-neutral-200 hover:bg-white/[0.08] rounded transition-colors"
                        title="重命名"
                      >
                        <Edit2 size={11} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession(session.id);
                        }}
                        className="p-1 text-neutral-500 hover:text-rose-400 hover:bg-rose-500/10 rounded transition-colors"
                        title="删除会话"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  )}
                </div>

                {/* 会话绑定的工作区小标签 */}
                {session.workDir && !isEditing && (
                  <div className="flex items-center gap-1 text-[10px] text-neutral-500 pl-5 truncate font-mono">
                    <FolderGit2 size={10} className="flex-shrink-0" />
                    <span className="truncate">{session.workDir.split(/[\\/]/).filter(Boolean).pop()}</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default SessionList;
