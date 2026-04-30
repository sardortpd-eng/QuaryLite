import { useEffect, useCallback, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import LeftSidebar from "./components/LeftSidebar";
import CenterPane from "./components/CenterPane";
import ExplorerPane from "./components/ExplorerPane";
import RelationshipPane from "./components/RelationshipPane";
import SettingsModal from "./components/SettingsModal";
import RightSidebar from "./components/RightSidebar";
import Toolbar from "./components/Toolbar";
import ShortcutSheet from "./components/ShortcutSheet";
import { useAppStore } from "./store";
export type { AppTheme } from "./store";

export interface ColumnInfo {
  name: string;
  col_type: string;
  not_null: boolean;
  pk: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  row_count: number;
}

export interface ViewInfo {
  name: string;
  sql: string;
}

export interface IndexInfo {
  name: string;
  table_name: string;
  unique: boolean;
  columns: string[];
}

export interface DbSchema {
  file_name: string;
  file_path: string;
  file_size_mb: number;
  sqlite_version: string;
  tables: TableInfo[];
  views: ViewInfo[];
  indexes: IndexInfo[];
}

export interface AISettings {
  provider: "anthropic" | "openai" | "ollama" | "openrouter";
  anthropic_key: string;
  openai_key: string;
  openrouter_key: string;
  ollama_base_url: string;
  ollama_key: string;
  anthropic_model: string;
  openai_model: string;
  ollama_model: string;
  openrouter_model: string;
  // Editor
  editor_font_size: number;
  editor_font_family: string;
  editor_word_wrap: boolean;
  editor_line_numbers: boolean;
  // Keybinds
  history_modifier: "Alt" | "Ctrl" | "Shift";
  run_query_key: "CmdEnter" | "F5" | "ShiftEnter";
  chat_send_key: "CmdEnter" | "ShiftEnter";
  tx_begin_key: "CmdShiftB" | "CmdShiftT" | "F6";
  tx_commit_key: "CmdShiftK" | "CmdShiftC" | "F7";
  tx_rollback_key: "CmdShiftZ" | "F8";
}

export type ActiveView = "overview" | "explorer" | "relationships";

export interface QueryMeta {
  sql: string;
  elapsed_ms: number;
  rows: number;
  source: "manual" | "ai";
  model?: string;
  executedAt: number;
}

export interface SessionTokens {
  promptTokens: number;
  completionTokens: number;
  queryCount: number;
  hasRealUsage: boolean;
}

const LEFT_MIN = 160;
const LEFT_MAX = 380;
const RIGHT_MIN = 200;
const RIGHT_MAX = 400;

function useResizeDivider(
  getValue: () => number,
  setValue: (v: number) => void,
  min: number,
  max: number,
  direction: "left" | "right"
) {
  return useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startVal = getValue();
    function onMove(ev: MouseEvent) {
      const delta = ev.clientX - startX;
      const next = direction === "left" ? startVal + delta : startVal - delta;
      setValue(Math.max(min, Math.min(max, next)));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [getValue, setValue, min, max, direction]);
}

function App() {
  const {
    db, error, setDb, setError, applyRowCounts,
    activeView, selectedTable, showLeft, showRight, showChat, showSettings,
    leftWidth, rightWidth,
    setActiveView, setSelectedTable, toggleLeft, toggleRight, toggleChat,
    setShowSettings, setLeftWidth, setRightWidth,
    lastQueryMeta, sessionTokens, lastAssistantMessage, pendingChatInput,
    loadConversationMessages,
    setLastQueryMeta, addTokens, resetTokens,
    setLastAssistantMessage, setPendingChatInput, setLoadConversationMessages,
    settings, setSettings,
    txActive, txFlash, setTxActive, setTxFlash,
    recentDbs, addRecentDb,
    theme, setTheme,
  } = useAppStore();

  const [showShortcuts, setShowShortcuts] = useState(false);

  // Apply theme data attribute to <html>
  useEffect(() => {
    if (theme === "dark") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, [theme]);
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("tx-active", txActive);
  }, [txActive]);

  useEffect(() => {
    if (!txFlash) return;
    document.documentElement.setAttribute("data-tx-flash", txFlash);
    const t = setTimeout(() => {
      document.documentElement.removeAttribute("data-tx-flash");
      setTxFlash(null);
    }, 800);
    return () => clearTimeout(t);
  }, [txFlash]);

  // Global tx keybinds — work on every tab
  const txActiveRef = useRef(txActive);
  useEffect(() => { txActiveRef.current = txActive; }, [txActive]);
  const txBeginKeyRef = useRef(settings.tx_begin_key);
  const txCommitKeyRef = useRef(settings.tx_commit_key);
  const txRollbackKeyRef = useRef(settings.tx_rollback_key);
  useEffect(() => { txBeginKeyRef.current = settings.tx_begin_key; }, [settings.tx_begin_key]);
  useEffect(() => { txCommitKeyRef.current = settings.tx_commit_key; }, [settings.tx_commit_key]);
  useEffect(() => { txRollbackKeyRef.current = settings.tx_rollback_key; }, [settings.tx_rollback_key]);

  useEffect(() => {
    function matchesTxKey(e: KeyboardEvent, key: string): boolean {
      const cmd = e.metaKey || e.ctrlKey;
      switch (key) {
        case "CmdShiftB": return cmd && (e.key === "B" || e.key === "b");
        case "CmdShiftT": return cmd && (e.key === "T" || e.key === "t");
        case "F6":        return e.key === "F6";
        case "CmdShiftK": return cmd && (e.key === "K" || e.key === "k");
        case "CmdShiftC": return cmd && (e.key === "C" || e.key === "c");
        case "F7":        return e.key === "F7";
        case "CmdShiftZ": return cmd && (e.key === "Z" || e.key === "z");
        case "CmdShiftR": return cmd && (e.key === "R" || e.key === "r");
        case "F8":        return e.key === "F8";
        default:          return false;
      }
    }
    async function onKeyDown(e: KeyboardEvent) {
      // ? shortcut sheet — only when not typing in an input/textarea
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          setShowShortcuts((v) => !v);
          return;
        }
      }
      if (!db) return;
      if (matchesTxKey(e, txBeginKeyRef.current) && !txActiveRef.current) {
        e.preventDefault();
        try { await invoke("begin_transaction", { path: db.file_path }); setTxActive(true); } catch {}
      } else if (matchesTxKey(e, txCommitKeyRef.current) && txActiveRef.current) {
        e.preventDefault();
        try { await invoke("commit_transaction"); setTxActive(false); setTxFlash("commit"); } catch {}
      } else if (matchesTxKey(e, txRollbackKeyRef.current) && txActiveRef.current) {
        e.preventDefault();
        try { await invoke("rollback_transaction"); setTxActive(false); setTxFlash("rollback"); } catch {}
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [db]);

  const getLeftWidth = useCallback(() => leftWidth, [leftWidth]);
  const getRightWidth = useCallback(() => rightWidth, [rightWidth]);
  const onLeftDividerDown = useResizeDivider(getLeftWidth, setLeftWidth, LEFT_MIN, LEFT_MAX, "left");
  const onRightDividerDown = useResizeDivider(getRightWidth, setRightWidth, RIGHT_MIN, RIGHT_MAX, "right");

  useEffect(() => {
    invoke<AISettings>("load_settings").then(setSettings).catch(() => {});
  }, []);

  function lazyLoadCounts(path: string) {
    invoke<Record<string, number>>("load_row_counts", { path })
      .then(applyRowCounts)
      .catch(() => {});
  }

  async function openDbByPath(path: string) {
    try {
      const schema = await invoke<DbSchema>("open_database", { path });
      setDb(schema);
      setError(null);
      addRecentDb(path);
      lazyLoadCounts(path);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleOpenDb() {
    try {
      const path = await open({
        filters: [{ name: "SQLite Database", extensions: ["db", "sqlite", "sqlite3"] }],
      });
      if (!path) return;
      await openDbByPath(path as string);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleReloadDb() {
    if (!db) return;
    try {
      const schema = await invoke<DbSchema>("open_database", { path: db.file_path });
      setDb(schema);
      setError(null);
      lazyLoadCounts(db.file_path);
    } catch (e) {
      setError(String(e));
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "open" as DataTransfer["dropEffect"];
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    // Tauri exposes the native path via the webkitRelativePath workaround or via the path property
    const path = (file as File & { path?: string }).path;
    if (!path) return;
    await openDbByPath(path);
  }

  return (
    <div
      className={`app${isDragOver ? " drag-over" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Toolbar
        db={db}
        showLeft={showLeft}
        showRight={showRight}
        showChat={showChat}
        onToggleLeft={toggleLeft}
        onToggleRight={toggleRight}
        onToggleChat={toggleChat}
        onOpenDb={handleOpenDb}
        onReloadDb={handleReloadDb}
      />

      <div className="app-body">
        {showLeft && (
          <>
            <LeftSidebar
              db={db}
              onOpen={handleOpenDb}
              activeView={activeView}
              onViewChange={setActiveView}
              selectedTable={selectedTable}
              onSelectTable={setSelectedTable}
              onOpenSettings={() => setShowSettings(true)}
              onLoadConversation={setLoadConversationMessages}
              width={leftWidth}
            />
            <div className="resize-divider resize-divider-v" onMouseDown={onLeftDividerDown} />
          </>
        )}

        {activeView === "explorer" && db ? (
          <ExplorerPane
            db={db}
            selectedTable={selectedTable}
            onSelectTable={setSelectedTable}
          />
        ) : activeView === "relationships" && db ? (
          <RelationshipPane db={db} onClose={() => setActiveView("overview")} />
        ) : (
          <CenterPane
            db={db}
            onOpen={handleOpenDb}
            onOpenPath={openDbByPath}
            recentDbs={recentDbs}
            appTheme={theme}
            settings={settings}
            externalMessages={loadConversationMessages}
            onQueryExecuted={setLastQueryMeta}
            onTokensUsed={addTokens}
            onAssistantMessage={setLastAssistantMessage}
            pendingChatInput={pendingChatInput}
            onPendingChatInputConsumed={() => setPendingChatInput(null)}
            showChat={showChat}
          />
        )}

        {showRight && (
          <>
            <div className="resize-divider resize-divider-v" onMouseDown={onRightDividerDown} />
            <RightSidebar
              lastQueryMeta={lastQueryMeta}
              sessionTokens={sessionTokens}
              lastAssistantMessage={lastAssistantMessage}
              settings={settings}
              db={db}
              width={rightWidth}
              onResetTokens={resetTokens}
              onSuggestionClick={setPendingChatInput}
            />
          </>
        )}
      </div>

      {showSettings && (
        <SettingsModal
          initial={settings}
          onSave={setSettings}
          onClose={() => setShowSettings(false)}
          theme={theme}
          onThemeChange={setTheme}
        />
      )}

      {showShortcuts && (
        <ShortcutSheet
          settings={settings}
          onClose={() => setShowShortcuts(false)}
        />
      )}

      {isDragOver && (
        <div className="drag-drop-overlay" aria-hidden="true">
          <div className="drag-drop-label">Drop .db file to open</div>
        </div>
      )}

      {error && (
        <div style={{
          position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)",
          background: "#3a1a1a", border: "1px solid #7a2a2a", borderRadius: 6,
          padding: "8px 16px", color: "#ff6b6b", fontSize: 13, zIndex: 999,
        }}>
          {error}
        </div>
      )}
    </div>
  );
}

export default App;
