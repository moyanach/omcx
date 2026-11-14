import { TodoItem } from '@/components/agent/TodoListCard';
import { BtwSelectionPayload } from '@/pages/chat/BtwSelectionMenu';
import { Message } from '../../../stores/chatStore';

export interface ToolStatusEvent {
  tool: string;
  status: 'running' | 'done';
  args: any;
  result?: any;
  callId?: string;
  subSteps?: Array<{
    callId: string;
    tool: string;
    args?: any;
    status: 'running' | 'done';
    summary?: string;
    agentName?: string;
  }>;
}

export interface MessageListProps {
  messages: Message[];
  isGenerating: boolean;
  activeSearchProgress: any;
  activeToolCalls: ToolStatusEvent[];
  activeTodos?: TodoItem[];
  onCopy: (text: string) => void;
  onRetry: (msg: Message) => void;
  /** 选中主会话文本后右键「旁路会话」：把选中内容作为只读引用带入旁路问答 */
  onSideChatSelection?: (payload: BtwSelectionPayload) => void;
}
