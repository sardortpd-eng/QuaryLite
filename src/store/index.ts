import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DbSchema, AISettings, ActiveView, QueryMeta, SessionTokens } from "../App";
import type { Message } from "../components/ChatPane";

const EMPTY_TOKENS: SessionTokens = {
  promptTokens: 0,
  completionTokens: 0,
  queryCount: 0,
  hasRealUsage: false,
};

// ── Types ────────────────────────────────────────────────────────────────────

interface DbState {
  db: DbSchema | null;
  error: string | null;
  setDb: (db: DbSchema | null) => void;
  setError: (error: string | null) => void;
  applyRowCounts: (counts: Record<string, number>) => void;
}

interface UiState {
  activeView: ActiveView;
  selectedTable: string | null;
  showLeft: boolean;
  showRight: boolean;
  showChat: boolean;
  showSettings: boolean;
  leftWidth: number;
  rightWidth: number;
  setActiveView: (v: ActiveView) => void;
  setSelectedTable: (t: string | null) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  toggleChat: () => void;
  setShowSettings: (v: boolean) => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
}

interface TxState {
  txActive: boolean;
  txFlash: "commit" | "rollback" | null;
  setTxActive: (v: boolean) => void;
  setTxFlash: (v: "commit" | "rollback" | null) => void;
}

interface SessionState {
  lastQueryMeta: QueryMeta | null;
  sessionTokens: SessionTokens;
  lastAssistantMessage: string;
  pendingChatInput: string | null;
  loadConversationMessages: Message[] | null;
  setLastQueryMeta: (m: QueryMeta) => void;
  addTokens: (prompt: number, completion: number, isReal?: boolean) => void;
  resetTokens: () => void;
  setLastAssistantMessage: (m: string) => void;
  setPendingChatInput: (v: string | null) => void;
  setLoadConversationMessages: (msgs: Message[] | null) => void;
}

interface SettingsState {
  settings: AISettings;
  setSettings: (s: AISettings) => void;
}

export type AppTheme = "dark" | "light" | "midnight" | "mocha";

interface RecentDbsState {
  recentDbs: string[];
  addRecentDb: (path: string) => void;
}

interface ThemeState {
  theme: AppTheme;
  setTheme: (t: AppTheme) => void;
}

type AppStore = DbState & UiState & TxState & SessionState & SettingsState & RecentDbsState & ThemeState;

// ── Store ────────────────────────────────────────────────────────────────────

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      // db
      db: null,
      error: null,
      setDb: (db) => set({ db }),
      setError: (error) => set({ error }),
      applyRowCounts: (counts) =>
        set((s) => {
          if (!s.db) return {};
          return {
            db: {
              ...s.db,
              tables: s.db.tables.map((t) => ({
                ...t,
                row_count: counts[t.name] ?? t.row_count,
              })),
            },
          };
        }),

      // ui
      activeView: "overview",
      selectedTable: null,
      showLeft: true,
      showRight: true,
      showChat: true,
      showSettings: false,
      leftWidth: 220,
      rightWidth: 260,
      setActiveView: (activeView) => set({ activeView }),
      setSelectedTable: (selectedTable) => set({ selectedTable }),
      toggleLeft: () => set((s) => ({ showLeft: !s.showLeft })),
      toggleRight: () => set((s) => ({ showRight: !s.showRight })),
      toggleChat: () => set((s) => ({ showChat: !s.showChat })),
      setShowSettings: (showSettings) => set({ showSettings }),
      setLeftWidth: (leftWidth) => set({ leftWidth }),
      setRightWidth: (rightWidth) => set({ rightWidth }),

      // tx
      txActive: false,
      txFlash: null,
      setTxActive: (txActive) => set({ txActive }),
      setTxFlash: (txFlash) => set({ txFlash }),

      // session
      lastQueryMeta: null,
      sessionTokens: EMPTY_TOKENS,
      lastAssistantMessage: "",
      pendingChatInput: null,
      loadConversationMessages: null,
      setLastQueryMeta: (lastQueryMeta) => set({ lastQueryMeta }),
      addTokens: (prompt, completion, isReal) =>
        set((s) => ({
          sessionTokens: {
            promptTokens: s.sessionTokens.promptTokens + prompt,
            completionTokens: s.sessionTokens.completionTokens + completion,
            queryCount: s.sessionTokens.queryCount + 1,
            hasRealUsage: s.sessionTokens.hasRealUsage || Boolean(isReal),
          },
        })),
      resetTokens: () => set({ sessionTokens: EMPTY_TOKENS }),
      setLastAssistantMessage: (lastAssistantMessage) => set({ lastAssistantMessage }),
      setPendingChatInput: (pendingChatInput) => set({ pendingChatInput }),
      setLoadConversationMessages: (loadConversationMessages) => set({ loadConversationMessages }),

      // settings — default filled in by App on load from Tauri backend
      settings: {
        provider: "anthropic",
        anthropic_key: "",
        openai_key: "",
        openrouter_key: "",
        ollama_base_url: "http://localhost:11434",
        ollama_key: "",
        anthropic_model: "claude-sonnet-4-6",
        openai_model: "gpt-4o",
        ollama_model: "",
        openrouter_model: "",
        editor_font_size: 13,
        editor_font_family: "JetBrains Mono",
        editor_word_wrap: true,
        editor_line_numbers: true,
        history_modifier: "Alt",
        run_query_key: "CmdEnter",
        chat_send_key: "CmdEnter",
        tx_begin_key: "CmdShiftB",
        tx_commit_key: "CmdShiftK",
        tx_rollback_key: "CmdShiftZ",
      },
      setSettings: (settings) => set({ settings }),

      // recent dbs
      recentDbs: [],
      addRecentDb: (path) =>
        set((s) => ({
          recentDbs: [path, ...s.recentDbs.filter((p) => p !== path)].slice(0, 10),
        })),

      // theme
      theme: "dark",
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: "querylite-ui",
      // Only persist layout, navigation, and recent DBs — never API keys or session data
      partialize: (s) => ({
        activeView: s.activeView,
        selectedTable: s.selectedTable,
        showLeft: s.showLeft,
        showRight: s.showRight,
        showChat: s.showChat,
        leftWidth: s.leftWidth,
        rightWidth: s.rightWidth,
        recentDbs: s.recentDbs,
        theme: s.theme,
      }),
    }
  )
);
