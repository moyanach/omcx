import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import SessionList from '@/pages/chat/SessionList';
import WorkspaceSessionsPanel from './WorkspaceSessionsPanel';

export const SecondarySidebar: React.FC = () => {
  const activeNavTab = useAppStore((s) => s.activeNavTab);
  const {
    sessions,
    activeSessionId,
    addSessionWithWorkspacePrompt,
    setActiveSession,
    deleteSession,
    updateSessionTitle,
  } = useChatStore(
    useShallow((s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      addSessionWithWorkspacePrompt: s.addSessionWithWorkspacePrompt,
      setActiveSession: s.setActiveSession,
      deleteSession: s.deleteSession,
      updateSessionTitle: s.updateSessionTitle,
    }))
  );

  if (activeNavTab === 'settings' || activeNavTab === 'tools') {
    return null;
  }

  if (activeNavTab === 'workspaces') {
    return <WorkspaceSessionsPanel />;
  }

  // 默认：会话列表
  return (
    <SessionList
      sessions={sessions}
      activeSessionId={activeSessionId}
      onAddSession={addSessionWithWorkspacePrompt}
      onSelectSession={setActiveSession}
      onDeleteSession={deleteSession}
      onRenameSession={updateSessionTitle}
    />
  );
};

export default SecondarySidebar;
