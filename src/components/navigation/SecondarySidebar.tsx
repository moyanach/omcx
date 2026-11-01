import React from 'react';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import SessionList from '@/pages/chat/SessionList';
import ToolsPanel from './ToolsPanel';
import WorkspaceSessionsPanel from './WorkspaceSessionsPanel';

export const SecondarySidebar: React.FC = () => {
  const { activeNavTab } = useAppStore();
  const {
    sessions,
    activeSessionId,
    addSessionWithWorkspacePrompt,
    setActiveSession,
    deleteSession,
    updateSessionTitle,
  } = useChatStore();

  if (activeNavTab === 'settings' || activeNavTab === 'tools') {
    return null;
  }

  if (activeNavTab === 'tools') {
    return <ToolsPanel />;
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
