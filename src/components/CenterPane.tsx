import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { AppTheme } from "../store";
import { Play, Download, GitBranch, Clock } from "lucide-react";
import Editor, { useMonaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import type { DbSchema, AISettings, QueryMeta } from "../App";
import ChatPane, { type Message } from "./ChatPane";
import { formatMs, uid } from "../lib/utils";

interface HumanError { title: string; hint: string; }

function humanizeError(raw: string): HumanError {
  const s = raw.toLowerCase();
  if (s.includes("unique constraint failed"))
    return { title: "Duplicate value", hint: "A row with that value already exists. Check the column marked UNIQUE." };
  if (s.includes("no such table"))
    return { title: "Table not found", hint: "The query references a table that doesn't exist in this database." };
  if (s.includes("no such column"))
    return { title: "Column not found", hint: "One of the column names in the query doesn't match the table schema." };
  if (s.includes("syntax error"))
    return { title: "SQL syntax error", hint: "The query has a syntax error. Check for missing commas, quotes, or keywords." };
  if (s.includes("401") || s.includes("unauthorized") || s.includes("api key"))
    return { title: "Invalid API key", hint: "Your AI provider rejected the key. Check Settings → AI." };
  if (s.includes("429") || s.includes("rate limit"))
    return { title: "Rate limit hit", hint: "Too many requests. Wait a moment before trying again." };
  if (s.includes("timed out") || s.includes("timeout"))
    return { title: "Request timed out", hint: "The query or AI call took too long. Try a smaller query." };
  if (s.includes("no such file") || s.includes("unable to open"))
    return { title: "Database file not found", hint: "The database file may have been moved or deleted." };
  if (s.includes("blocked") || s.includes("not permitted"))
    return { title: "Query blocked", hint: raw };
  return { title: "Error", hint: raw };
}

interface QueryResult {
  columns: string[];
  rows: (string | number | null)[][];
  rows_affected: number;
  elapsed_ms: number;
}

type QueryStatus = "idle" | "running" | "success" | "error";

interface Props {
  db: DbSchema | null;
  onOpen: () => void;
  onOpenPath?: (path: string) => void;
  recentDbs?: string[];
  appTheme?: AppTheme;
  settings: AISettings;
  externalMessages?: Message[] | null;
  onQueryExecuted?: (meta: QueryMeta) => void;
  onTokensUsed?: (prompt: number, completion: number, isReal?: boolean) => void;
  onAssistantMessage?: (msg: string) => void;
  pendingChatInput?: string | null;
  onPendingChatInputConsumed?: () => void;
  showChat?: boolean;
}

const DEFAULT_SQL = "SELECT * FROM sqlite_master WHERE type = 'table';";
const RESULT_PAGE_SIZE = 200;

const TX_KEY_LABELS: Record<string, string> = {
  CmdShiftB: "⌘⇧B", CmdShiftT: "⌘⇧T", F6: "F6",
  CmdShiftK: "⌘⇧K", CmdShiftC: "⌘⇧C", F7: "F7",
  CmdShiftZ: "⌘⇧Z", CmdShiftR: "⌘⇧R", F8: "F8",
};


function lsGet(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function exportCsv(columns: string[], rows: (string | number | null)[][]) {
  const header = columns.join(",");
  const body = rows.map((r) =>
    r.map((cell) => (cell === null ? "" : `"${String(cell).replace(/"/g, '""')}"`)).join(",")
  );
  const csv = [header, ...body].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "results.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export default function CenterPane({ db, onOpen, onOpenPath, recentDbs = [], appTheme = "dark", settings, externalMessages, onQueryExecuted, onTokensUsed, onAssistantMessage, pendingChatInput, onPendingChatInputConsumed, showChat = true }: Props) {
const [sql, setSql] = useState(() => lsGet("editor_sql", DEFAULT_SQL));
  const [result, setResult] = useState<QueryResult | null>(null);
  const [status, setStatus] = useState<QueryStatus>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resultSearch, setResultSearch] = useState("");

  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const [sqlHeight, setSqlHeight] = useState(160);
  const [resultPage, setResultPage] = useState(0);
  const monacoRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const runQueryRef = useRef<() => void>(() => {});
  const setSqlRef = useRef<(v: string) => void>(() => {});
  const queryHistoryRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);

  useEffect(() => {
    invoke<string[]>("load_query_history").then((entries) => {
      queryHistoryRef.current = entries;
    }).catch(() => {});
  }, []);
  const { txActive, setTxActive, setTxFlash } = useAppStore();
  const [txError, setTxError] = useState<string | null>(null);
  const historyScratchRef = useRef<string>("");
  const monaco = useMonaco();

  const onSqlDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = sqlHeight;
    function onMove(ev: MouseEvent) {
      const next = startH + (ev.clientY - startY);
      setSqlHeight(Math.max(80, Math.min(480, next)));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [sqlHeight]);

  useEffect(() => {
    if (pendingChatInput) {
      setInput(pendingChatInput);
      onPendingChatInputConsumed?.();
      setTimeout(() => chatInputRef.current?.focus(), 50);
    }
  }, [pendingChatInput]);

  const isLight = appTheme === "light";
  const monacoThemeName = isLight ? "quarylite-light" : "quarylite-dark";

  useEffect(() => {
    if (!monaco) return;
    monaco.editor.defineTheme("quarylite-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "keyword.sql", foreground: "5b9cf6", fontStyle: "bold" },
        { token: "keyword", foreground: "5b9cf6", fontStyle: "bold" },
        { token: "string.sql", foreground: "a8d8a8" },
        { token: "string", foreground: "a8d8a8" },
        { token: "number", foreground: "f2c97d" },
        { token: "comment", foreground: "72727c", fontStyle: "italic" },
        { token: "operator.sql", foreground: "c792ea" },
        { token: "identifier", foreground: "e8e8ea" },
        { token: "predefined", foreground: "e07b75" },
      ],
      colors: {
        "editor.background": "#212125",
        "editor.foreground": "#e8e8ea",
        "editor.lineHighlightBackground": "#2b2b3088",
        "editor.selectionBackground": "#5b9cf630",
        "editorLineNumber.foreground": "#52525a",
        "editorLineNumber.activeForeground": "#9898a0",
        "editorCursor.foreground": "#5b9cf6",
        "editorIndentGuide.background": "#28282d",
        "editorIndentGuide.activeBackground": "#34343a",
        "editor.findMatchBackground": "#5b9cf640",
        "scrollbar.shadow": "#00000000",
        "scrollbarSlider.background": "#34343a80",
        "scrollbarSlider.hoverBackground": "#34343a",
        "scrollbarSlider.activeBackground": "#5b9cf680",
        "editorWidget.background": "#212125",
        "editorWidget.border": "#28282d",
        "editorSuggestWidget.background": "#212125",
        "editorSuggestWidget.border": "#34343a",
        "editorSuggestWidget.selectedBackground": "#2b2b30",
      },
    });
    monaco.editor.defineTheme("quarylite-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "keyword.sql", foreground: "1d4ed8", fontStyle: "bold" },
        { token: "keyword", foreground: "1d4ed8", fontStyle: "bold" },
        { token: "string.sql", foreground: "166534" },
        { token: "string", foreground: "166534" },
        { token: "number", foreground: "9a3412" },
        { token: "comment", foreground: "6b7280", fontStyle: "italic" },
        { token: "operator.sql", foreground: "7c3aed" },
        { token: "identifier", foreground: "18181b" },
        { token: "predefined", foreground: "dc2626" },
      ],
      colors: {
        "editor.background": "#ffffff",
        "editor.foreground": "#18181b",
        "editor.lineHighlightBackground": "#f4f4f588",
        "editor.selectionBackground": "#3b82f630",
        "editorLineNumber.foreground": "#a1a1aa",
        "editorLineNumber.activeForeground": "#52525b",
        "editorCursor.foreground": "#3b82f6",
        "editor.findMatchBackground": "#3b82f640",
        "scrollbar.shadow": "#00000000",
        "scrollbarSlider.background": "#d0d0d880",
        "scrollbarSlider.hoverBackground": "#d0d0d8",
        "scrollbarSlider.activeBackground": "#3b82f680",
        "editorWidget.background": "#ffffff",
        "editorWidget.border": "#d0d0d8",
        "editorSuggestWidget.background": "#ffffff",
        "editorSuggestWidget.border": "#d0d0d8",
        "editorSuggestWidget.selectedBackground": "#f4f4f5",
      },
    });
    monaco.editor.setTheme(monacoThemeName);
  }, [monaco, monacoThemeName]);

  const prevExternalRef = useRef<Message[] | null | undefined>(null);
  if (externalMessages !== prevExternalRef.current) {
    prevExternalRef.current = externalMessages;
    if (externalMessages) {
      setMessages(externalMessages);
      setConversationId(null);
    }
  }

  const handleConversationSaved = useCallback((msgs: Message[]) => {
    if (!db) return;
    const id = conversationId ?? uid();
    if (!conversationId) setConversationId(id);
    const firstUser = msgs.find((m) => m.role === "user");
    const title = firstUser ? firstUser.content.slice(0, 60) : "Untitled";
    const serialized = msgs.map((m) => ({ id: m.id, role: m.role, content: m.content }));
    invoke("save_conversation", {
      conv: {
        id,
        title,
        db_path: db.file_path,
        db_name: db.file_name,
        created_at: Date.now(),
        updated_at: Date.now(),
        messages: serialized,
      },
    }).catch(() => {});
  }, [db, conversationId]);

  const runQuery = useCallback(async () => {
    if (!db || !sql.trim()) return;
    setStatus("running");
    setErrorMsg(null);
    try {
      const res = await invoke<QueryResult>("execute_query", { path: db.file_path, sql: sql.trim() });
      setResult(res);
      setStatus("success");
      setResultSearch("");
      setResultPage(0);
      const trimmed = sql.trim();
      const prev = queryHistoryRef.current;
      if (prev[0] !== trimmed) {
        const next = [trimmed, ...prev.filter((q) => q !== trimmed)].slice(0, 50);
        queryHistoryRef.current = next;
        invoke("save_query_history", { entries: next }).catch(() => {});
      }
      historyIndexRef.current = -1;
      onQueryExecuted?.({
        sql: sql.trim(),
        elapsed_ms: res.elapsed_ms,
        rows: res.rows.length,
        source: "manual",
        executedAt: Date.now(),
      });
    } catch (e) {
      setErrorMsg(String(e));
      setStatus("error");
      setResult(null);
    }
  }, [db, sql, onQueryExecuted]);

  useEffect(() => {
    runQueryRef.current = runQuery;
  }, [runQuery]);

  const beginTx = useCallback(async () => {
    if (!db) return;
    try {
      await invoke("begin_transaction", { path: db.file_path });
      setTxActive(true);
      setTxError(null);
    } catch (e) {
      setTxError(String(e));
    }
  }, [db]);

  const commitTx = useCallback(async () => {
    try {
      await invoke("commit_transaction");
      setTxActive(false);
      setTxFlash("commit");
      setTxError(null);
    } catch (e) {
      setTxError(String(e));
    }
  }, []);

  const rollbackTx = useCallback(async () => {
    try {
      await invoke("rollback_transaction");
      setTxActive(false);
      setTxFlash("rollback");
      setTxError(null);
    } catch (e) {
      setTxError(String(e));
    }
  }, []);

  // Refs for Monaco editor command overrides
  const txActiveRef = useRef(txActive);
  const beginTxRef = useRef(beginTx);
  const commitTxRef = useRef(commitTx);
  const rollbackTxRef = useRef(rollbackTx);
  const txBeginKeyRef = useRef(settings.tx_begin_key);
  const txCommitKeyRef = useRef(settings.tx_commit_key);
  const txRollbackKeyRef = useRef(settings.tx_rollback_key);
  const historyModRef = useRef(settings.history_modifier);
  useEffect(() => { txActiveRef.current = txActive; }, [txActive]);
  useEffect(() => { beginTxRef.current = beginTx; }, [beginTx]);
  useEffect(() => { commitTxRef.current = commitTx; }, [commitTx]);
  useEffect(() => { rollbackTxRef.current = rollbackTx; }, [rollbackTx]);
  useEffect(() => { txBeginKeyRef.current = settings.tx_begin_key; }, [settings.tx_begin_key]);
  useEffect(() => { txCommitKeyRef.current = settings.tx_commit_key; }, [settings.tx_commit_key]);
  useEffect(() => { txRollbackKeyRef.current = settings.tx_rollback_key; }, [settings.tx_rollback_key]);
  useEffect(() => { historyModRef.current = settings.history_modifier; }, [settings.history_modifier]);

  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem("editor_sql", sql); } catch { /* ignore */ }
    }, 500);
    return () => clearTimeout(t);
  }, [sql]);

  useEffect(() => {
    setSqlRef.current = setSql;
  }, [setSql]);


  const filteredRows = result
    ? result.rows.filter((row) =>
        !resultSearch ||
        row.some((cell) =>
          cell !== null && String(cell).toLowerCase().includes(resultSearch.toLowerCase())
        )
      )
    : [];

  const totalResultPages = Math.ceil(filteredRows.length / RESULT_PAGE_SIZE);
  const pagedRows = filteredRows.slice(resultPage * RESULT_PAGE_SIZE, (resultPage + 1) * RESULT_PAGE_SIZE);

  const [showErrorDetail, setShowErrorDetail] = useState(false);

  if (!db) {
    return (
      <main className="center-pane" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="empty-state">
          <div className="empty-state-wordmark" role="img" aria-label="QuaryLite" />
          <div className="empty-state-tagline">Open a SQLite database to start querying.</div>
          <button className="empty-open-btn" onClick={onOpen}>
            Open Database
          </button>
          {recentDbs.length > 0 && (
            <div className="empty-recent">
              <div className="empty-recent-label">
                <Clock style={{ width: 12, height: 12 }} />
                Recent
              </div>
              <ul className="empty-recent-list">
                {recentDbs.map((path) => {
                  const name = path.split("/").pop() ?? path;
                  return (
                    <li key={path}>
                      <button
                        className="empty-recent-item"
                        onClick={() => onOpenPath?.(path)}
                        title={path}
                      >
                        <span className="empty-recent-name">{name}</span>
                        <span className="empty-recent-path">{path}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="center-pane">
      <div className="tab-bar">
        <span className="tab-bar-spacer" />
      </div>

      {/* ── SQL + Chat integrated view ── */}
      <div className="sql-chat-layout">

        {/* SQL editor section */}
        <div className="sql-editor-section">
          <div className="editor-toolbar">
            <button className="run-btn" onClick={runQuery} disabled={status === "running"}>
              <Play style={{ width: 11, height: 11 }} />
              {status === "running" ? "Running…" : "Run"}
              <span className="kbd">⌘↵</span>
            </button>
            <button
              className="editor-btn"
              onClick={() => { if (result) exportCsv(result.columns, result.rows); }}
              disabled={!result}
              title="Export CSV"
            >
              <Download style={{ width: 12, height: 12 }} />
              Export
            </button>
            {!txActive && (
              <button className="editor-btn" onClick={beginTx} title={`Begin transaction (${TX_KEY_LABELS[settings.tx_begin_key] ?? settings.tx_begin_key})`}>
                <GitBranch style={{ width: 12, height: 12 }} />
                BEGIN TX
                <span className="kbd">{TX_KEY_LABELS[settings.tx_begin_key] ?? settings.tx_begin_key}</span>
              </button>
            )}
          </div>

          {txActive && (
            <div className="tx-banner">
              <span className="tx-dot" />
              <span>Transaction active</span>
              <span style={{ flex: 1 }} />
              <button className="tx-btn tx-commit" onClick={commitTx} title={`Commit (${TX_KEY_LABELS[settings.tx_commit_key] ?? settings.tx_commit_key})`}>
                Commit <span className="tx-kbd">{TX_KEY_LABELS[settings.tx_commit_key] ?? settings.tx_commit_key}</span>
              </button>
              <button className="tx-btn tx-rollback" onClick={rollbackTx} title={`Rollback (${TX_KEY_LABELS[settings.tx_rollback_key] ?? settings.tx_rollback_key})`}>
                Rollback <span className="tx-kbd">{TX_KEY_LABELS[settings.tx_rollback_key] ?? settings.tx_rollback_key}</span>
              </button>
            </div>
          )}
          {txError && (() => { const { title, hint } = humanizeError(txError); return <div className="tx-error"><strong>{title}:</strong> {hint}</div>; })()}

          <div className="sql-editor" style={{ height: sqlHeight }}>
            <Editor
              height="100%"
              language="sql"
              theme={monacoThemeName}
              value={sql}
              onChange={(val) => setSql(val ?? "")}
              onMount={(ed, mon) => {
                monacoRef.current = ed;

                // Run query
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.CtrlCmd | mon.KeyCode.Enter, () => runQueryRef.current());
                ed.addCommand(mon.KeyCode.F5, () => runQueryRef.current());
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.Shift | mon.KeyCode.Enter, () => runQueryRef.current());

                // History navigation — registered for all modifier variants, gated at runtime
                const navigateHistory = (direction: 1 | -1) => {
                  const history = queryHistoryRef.current;
                  if (direction === 1) {
                    if (!history.length) return;
                    const next = historyIndexRef.current + 1;
                    if (next >= history.length) return;
                    if (historyIndexRef.current === -1) historyScratchRef.current = ed.getValue();
                    historyIndexRef.current = next;
                    const val = history[next];
                    ed.setValue(val);
                    setSqlRef.current(val);
                  } else {
                    if (historyIndexRef.current === -1) return;
                    const next = historyIndexRef.current - 1;
                    historyIndexRef.current = next;
                    const val = next === -1 ? historyScratchRef.current : history[next];
                    ed.setValue(val);
                    setSqlRef.current(val);
                  }
                  const lineCount = ed.getModel()?.getLineCount() ?? 1;
                  ed.setPosition({ lineNumber: lineCount, column: Number.MAX_SAFE_INTEGER });
                };
                const guard = (wanted: string, fn: () => void) => () => {
                  if (historyModRef.current === wanted) fn();
                };
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.Alt | mon.KeyCode.UpArrow, guard("Alt", () => navigateHistory(1)));
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.Alt | mon.KeyCode.DownArrow, guard("Alt", () => navigateHistory(-1)));
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.CtrlCmd | mon.KeyCode.UpArrow, guard("Ctrl", () => navigateHistory(1)));
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.CtrlCmd | mon.KeyCode.DownArrow, guard("Ctrl", () => navigateHistory(-1)));
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.Shift | mon.KeyCode.UpArrow, guard("Shift", () => navigateHistory(1)));
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.Shift | mon.KeyCode.DownArrow, guard("Shift", () => navigateHistory(-1)));

                // Transaction keybinds — override Monaco built-ins (⌘⇧K=deleteLine, ⌘⇧Z=redo)
                const tryBegin    = () => { if (!txActiveRef.current) beginTxRef.current(); };
                const tryCommit   = () => { if (txActiveRef.current)  commitTxRef.current(); };
                const tryRollback = () => { if (txActiveRef.current)  rollbackTxRef.current(); };
                // Begin variants
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.CtrlCmd | mon.KeyMod.Shift | mon.KeyCode.KeyB, () => { if (txBeginKeyRef.current === "CmdShiftB") tryBegin(); });
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.CtrlCmd | mon.KeyMod.Shift | mon.KeyCode.KeyT, () => { if (txBeginKeyRef.current === "CmdShiftT") tryBegin(); });
                ed.addCommand(mon.KeyCode.F6, () => { if (txBeginKeyRef.current === "F6") tryBegin(); });
                // Commit variants
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.CtrlCmd | mon.KeyMod.Shift | mon.KeyCode.KeyK, () => { if (txCommitKeyRef.current === "CmdShiftK") tryCommit(); });
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.CtrlCmd | mon.KeyMod.Shift | mon.KeyCode.KeyC, () => { if (txCommitKeyRef.current === "CmdShiftC") tryCommit(); });
                ed.addCommand(mon.KeyCode.F7, () => { if (txCommitKeyRef.current === "F7") tryCommit(); });
                // Rollback variants
                // eslint-disable-next-line no-bitwise
                ed.addCommand(mon.KeyMod.CtrlCmd | mon.KeyMod.Shift | mon.KeyCode.KeyZ, () => { if (txRollbackKeyRef.current === "CmdShiftZ") tryRollback(); });
                ed.addCommand(mon.KeyCode.F8, () => { if (txRollbackKeyRef.current === "F8") tryRollback(); });
              }}
              options={{
                fontSize: settings.editor_font_size,
                fontFamily: `'${settings.editor_font_family}', monospace`,
                lineHeight: Math.round(settings.editor_font_size * 1.6),
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: settings.editor_word_wrap ? "on" : "off",
                lineNumbers: settings.editor_line_numbers ? "on" : "off",
                renderLineHighlight: "line",
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
                overviewRulerBorder: false,
                scrollbar: {
                  vertical: "hidden",
                  horizontal: "hidden",
                  alwaysConsumeMouseWheel: false,
                },
                padding: { top: 12, bottom: 12 },
                suggest: { showKeywords: true },
                quickSuggestions: false,
                contextmenu: false,
                folding: false,
                lineDecorationsWidth: 8,
                lineNumbersMinChars: 4,
              }}
            />
          </div>

          <div className="status-bar">
            {status === "idle" && <span style={{ color: "var(--text-muted)" }}>Ready</span>}
            {status === "running" && <span style={{ color: "var(--text-muted)" }}>Executing…</span>}
            {status === "success" && result && (
              <span className="status-success">
                ✓ {result.columns.length > 0
                  ? `${result.rows.length} row${result.rows.length !== 1 ? "s" : ""}`
                  : `${result.rows_affected} row${result.rows_affected !== 1 ? "s" : ""} affected`}
              </span>
            )}
            {status === "error" && <span style={{ color: "#f08080" }}>✗ Error</span>}
            {status !== "idle" && result && (
              <span style={{ color: "var(--text-muted)", marginLeft: "auto" }}>
                {formatMs(result.elapsed_ms)}
              </span>
            )}
          </div>

          {/* Inline results */}
          {(status === "error" && errorMsg) || (result && result.columns.length > 0) || (result && result.columns.length === 0 && status === "success") ? (
            <div className="inline-results">
              {status === "error" && errorMsg && (() => {
                const { title, hint } = humanizeError(errorMsg);
                return (
                  <div className="query-error">
                    <div className="query-error-header">
                      <div className="query-error-titles">
                        <div className="query-error-title">{title}</div>
                        <div className="query-error-hint">{hint}</div>
                      </div>
                      <button
                        className="query-error-dismiss"
                        onClick={() => { setErrorMsg(null); setStatus("idle"); }}
                        aria-label="Dismiss error"
                      >✕</button>
                    </div>
                    {hint !== errorMsg && (
                      <details className="query-error-details">
                        <summary onClick={() => setShowErrorDetail((v) => !v)}>
                          {showErrorDetail ? "Hide" : "Details"}
                        </summary>
                        <pre className="query-error-raw">{errorMsg}</pre>
                      </details>
                    )}
                  </div>
                );
              })()}
              {result && result.columns.length > 0 && (
                <>
                  <div className="results-header">
                    <span className="results-title">Results</span>
                    <span className="results-count">
                      {filteredRows.length !== result.rows.length
                        ? `${filteredRows.length} / ${result.rows.length} rows`
                        : `${result.rows.length} row${result.rows.length !== 1 ? "s" : ""}`}
                    </span>
                    <span className="results-spacer" />
                    <input
                      className="results-search"
                      placeholder="Filter results…"
                      value={resultSearch}
                      onChange={(e) => { setResultSearch(e.target.value); setResultPage(0); }}
                    />
                  </div>
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th className="rownum-col">#</th>
                          {result.columns.map((col) => <th key={col}>{col}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {pagedRows.map((row, ri) => (
                          <tr key={ri}>
                            <td className="rownum-col">{resultPage * RESULT_PAGE_SIZE + ri + 1}</td>
                            {row.map((cell, ci) => (
                              <td key={ci} className={cell === null ? "null-cell" : ""}>
                                {cell === null ? "NULL" : String(cell)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {totalResultPages > 1 && (
                    <div className="results-pagination">
                      <button
                        className="results-page-btn"
                        onClick={() => setResultPage((p) => Math.max(0, p - 1))}
                        disabled={resultPage === 0}
                      >‹</button>
                      <span className="results-page-label">
                        {resultPage + 1} / {totalResultPages}
                      </span>
                      <button
                        className="results-page-btn"
                        onClick={() => setResultPage((p) => Math.min(totalResultPages - 1, p + 1))}
                        disabled={resultPage === totalResultPages - 1}
                      >›</button>
                    </div>
                  )}
                </>
              )}
              {result && result.columns.length === 0 && status === "success" && (
                <div className="results-empty">
                  Query executed — {result.rows_affected} row{result.rows_affected !== 1 ? "s" : ""} affected
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Draggable divider + chat */}
        {showChat && <div className="resize-divider resize-divider-h" onMouseDown={onSqlDividerDown} />}
        {showChat && <ChatPane
          db={db}
          settings={settings}
          messages={messages}
          setMessages={setMessages}
          streaming={streaming}
          setStreaming={setStreaming}
          input={input}
          setInput={setInput}
          inputRef={chatInputRef}
          onConversationSaved={handleConversationSaved}
          onQueryExecuted={onQueryExecuted}
          onTokensUsed={onTokensUsed}
          onAssistantMessage={onAssistantMessage}
          editorSql={sql}
          editorResult={result}
        />}
      </div>


    </main>
  );
}
