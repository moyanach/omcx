import { StateCreator } from "zustand";
import type { ChatState } from "../chatStore";

export interface BtwToolStep {
  id: string;
  tool: string;
  status: "running" | "done";
  args?: any;
  success?: boolean;
  error?: string;
}

export interface BtwUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface BtwQuote {
  text: string;
  messageId?: string;
  createdAt: number;
}

export interface BtwThread {
  id: string;
  question: string;
  answer: string;
  status: "streaming" | "done" | "error" | "cancelled";
  error?: string;
  hitRoundLimit?: boolean;
  quotedText?: string;
  toolSteps: BtwToolStep[];
  usage?: BtwUsage;
  createdAt: number;
  finishedAt?: number;
}

export interface BtwSlice {
  btwThreadsBySession: Record<string, BtwThread[]>;
  btwOpenBySession: Record<string, boolean>;
  btwRunningBySession: Record<string, string | null>;
  btwQuoteBySession: Record<string, BtwQuote | null>;

  openBtwPanel: (sessionId: string) => void;
  closeBtwPanel: (sessionId: string) => void;
  setBtwQuote: (sessionId: string, quote: BtwQuote | null) => void;
  clearBtwQuote: (sessionId: string) => void;
  startBtwThread: (sessionId: string, thread: BtwThread) => void;
  appendBtwDelta: (sessionId: string, btwId: string, delta: string) => void;
  upsertBtwToolStep: (sessionId: string, btwId: string, step: BtwToolStep) => void;
  finishBtwThread: (
    sessionId: string,
    btwId: string,
    patch: Partial<Omit<BtwThread, "id" | "question" | "createdAt">>
  ) => void;
  clearBtwThreads: (sessionId: string) => void;
}

function ensureBtwTab(get: () => ChatState) {
  const existing = get().workbenchTabs.find((tab) => tab.type === "btw");
  if (existing) {
    get().setWorkbenchOpen(true);
    get().setActiveWorkbenchTab(existing.id);
    return;
  }
  get().addWorkbenchTab({ title: "旁路问答", type: "btw" });
}

export const createBtwSlice: StateCreator<ChatState, [], [], BtwSlice> = (
  set,
  get
) => ({
  btwThreadsBySession: {},
  btwOpenBySession: {},
  btwRunningBySession: {},
  btwQuoteBySession: {},

  openBtwPanel: (sessionId) => {
    if (!sessionId) return;
    set((state) => ({
      btwOpenBySession: { ...state.btwOpenBySession, [sessionId]: true },
    }));
    ensureBtwTab(get);
  },

  closeBtwPanel: (sessionId) => {
    if (!sessionId) return;
    set((state) => ({
      btwOpenBySession: { ...state.btwOpenBySession, [sessionId]: false },
    }));
  },

  setBtwQuote: (sessionId, quote) => {
    if (!sessionId) return;
    set((state) => ({
      btwQuoteBySession: {
        ...state.btwQuoteBySession,
        [sessionId]: quote
          ? {
              text: String(quote.text || "").slice(0, 8000),
              messageId: quote.messageId,
              createdAt: quote.createdAt || Date.now(),
            }
          : null,
      },
    }));
  },

  clearBtwQuote: (sessionId) => {
    if (!sessionId) return;
    set((state) => ({
      btwQuoteBySession: { ...state.btwQuoteBySession, [sessionId]: null },
    }));
  },

  startBtwThread: (sessionId, thread) => {
    if (!sessionId || !thread?.id) return;
    set((state) => ({
      btwThreadsBySession: {
        ...state.btwThreadsBySession,
        [sessionId]: [...(state.btwThreadsBySession[sessionId] || []), thread],
      },
      btwOpenBySession: { ...state.btwOpenBySession, [sessionId]: true },
      btwRunningBySession: { ...state.btwRunningBySession, [sessionId]: thread.id },
    }));
    ensureBtwTab(get);
  },

  appendBtwDelta: (sessionId, btwId, delta) => {
    if (!sessionId || !btwId || !delta) return;
    set((state) => ({
      btwThreadsBySession: {
        ...state.btwThreadsBySession,
        [sessionId]: (state.btwThreadsBySession[sessionId] || []).map((thread) =>
          thread.id === btwId
            ? { ...thread, answer: `${thread.answer}${delta}` }
            : thread
        ),
      },
    }));
  },

  upsertBtwToolStep: (sessionId, btwId, step) => {
    if (!sessionId || !btwId || !step?.id) return;
    set((state) => ({
      btwThreadsBySession: {
        ...state.btwThreadsBySession,
        [sessionId]: (state.btwThreadsBySession[sessionId] || []).map((thread) => {
          if (thread.id !== btwId) return thread;
          const steps = Array.isArray(thread.toolSteps) ? thread.toolSteps : [];
          const existingIndex = steps.findIndex((item) => item.id === step.id);
          const nextSteps =
            existingIndex >= 0
              ? steps.map((item, index) =>
                  index === existingIndex ? { ...item, ...step } : item
                )
              : [...steps, step];
          return { ...thread, toolSteps: nextSteps };
        }),
      },
    }));
  },

  finishBtwThread: (sessionId, btwId, patch) => {
    if (!sessionId || !btwId) return;
    set((state) => {
      const threads = (state.btwThreadsBySession[sessionId] || []).map((thread) =>
        thread.id === btwId
          ? {
              ...thread,
              ...patch,
              finishedAt: patch.finishedAt || Date.now(),
            }
          : thread
      );
      return {
        btwThreadsBySession: {
          ...state.btwThreadsBySession,
          [sessionId]: threads,
        },
        btwRunningBySession:
          state.btwRunningBySession[sessionId] === btwId
            ? { ...state.btwRunningBySession, [sessionId]: null }
            : state.btwRunningBySession,
      };
    });
  },

  clearBtwThreads: (sessionId) => {
    if (!sessionId) return;
    set((state) => ({
      btwThreadsBySession: {
        ...state.btwThreadsBySession,
        [sessionId]: [],
      },
      btwRunningBySession: {
        ...state.btwRunningBySession,
        [sessionId]: null,
      },
    }));
  },
});
