import { create } from "zustand";

export type View = "chat" | "settings";
export type NavTab = "sessions" | "tools" | "workspaces" | "settings";
export type ThemeMode = "light" | "dark" | "system";

interface AppState {
  activeView: View;
  setActiveView: (view: View) => void;
  activeNavTab: NavTab;
  setActiveNavTab: (tab: NavTab) => void;
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  currentWorkDir: string | null;
  setCurrentWorkDir: (dir: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeView: "chat",
  setActiveView: (view) => set({ activeView: view }),
  activeNavTab: "sessions",
  setActiveNavTab: (tab) => {
    if (tab === "settings") {
      set({ activeNavTab: "settings", activeView: "settings" });
    } else {
      set({ activeNavTab: tab, activeView: "chat" });
    }
  },
  theme: "system",
  setTheme: (mode) => set({ theme: mode }),
  currentWorkDir: null,
  setCurrentWorkDir: (dir) => set({ currentWorkDir: dir }),
}));
