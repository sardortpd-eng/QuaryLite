import { useRef, useEffect, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Send, Loader, Zap, Terminal, Table2, AlertCircle, RotateCcw, CheckCircle, XCircle } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { streamChat, type ChatMessage } from "../lib/aiStream";
import type { DbSchema, AISettings, QueryMeta } from "../App";
import { formatMs, uid } from "../lib/utils";

marked.setOptions({ breaks: true, gfm: true });

interface QueryResult {
  columns: string[];
  rows: (string | number | null)[][];
  rows_affected: number;
  elapsed_ms: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: string;
  streaming?: boolean;
  sqlBlocks?: SqlBlock[];
  error?: string;
}

export type SqlBlockKind = "read" | "write" | "ddl";

export interface SqlBlock {
  sql: string;
  kind?: SqlBlockKind;
  result?: QueryResult;
  error?: string;
  executing?: boolean;
  pendingApproval?: boolean;
  rejected?: boolean;
}

function classifySql(sql: string): SqlBlockKind {
  const t = sql.trim().toUpperCase();
  if (/^(CREATE|DROP|ALTER|TRUNCATE|RENAME)\b/.test(t)) return "ddl";
  if (/^(INSERT|UPDATE|DELETE|REPLACE|UPSERT)\b/.test(t)) return "write";
  return "read";
}

interface Props {
  db: DbSchema;
  settings: AISettings;
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  streaming: boolean;
  setStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  onConversationSaved?: (messages: Message[]) => void;
  onQueryExecuted?: (meta: QueryMeta) => void;
  onTokensUsed?: (prompt: number, completion: number, isReal?: boolean) => void;
  onAssistantMessage?: (msg: string) => void;
  editorSql?: string;
  editorResult?: QueryResult | null;
  aiWriteMode?: "off" | "confirm" | "auto";
}

function buildSchema(db: DbSchema): string {
  return db.tables
    .map((t) => {
      const cols = t.columns
        .map((c) => `  ${c.name} ${c.col_type}${c.pk ? " PRIMARY KEY" : ""}${c.not_null && !c.pk ? " NOT NULL" : ""}`)
        .join("\n");
      const rowStr = t.row_count < 0 ? "?" : t.row_count.toLocaleString();
      return `TABLE ${t.name} (${rowStr} rows)\n${cols}`;
    })
    .join("\n\n");
}

function serializeMessageForAI(msg: Message): ChatMessage {
  if (msg.role === "user" || !msg.sqlBlocks?.length) {
    return { role: msg.role, content: msg.content };
  }

  const resultParts = msg.sqlBlocks
    .map((block) => {
      if (block.error) return `Query error: ${block.error}`;
      if (!block.result) return "";
      const { columns, rows, rows_affected } = block.result;
      if (columns.length === 0) return `Query affected ${rows_affected} row(s).`;
      const header = columns.join(" | ");
      const sep = columns.map(() => "---").join(" | ");
      const dataRows = rows
        .slice(0, 20)
        .map((row) => row.map((cell) => (cell === null ? "NULL" : String(cell))).join(" | "));
      const overflow = rows.length > 20 ? `\n(${rows.length - 20} more rows not shown)` : "";
      return `Results (${rows.length} row${rows.length !== 1 ? "s" : ""}):\n${header}\n${sep}\n${dataRows.join("\n")}${overflow}`;
    })
    .filter(Boolean);

  if (resultParts.length === 0) return { role: msg.role, content: msg.content };

  return {
    role: msg.role,
    content: msg.content + "\n\n" + resultParts.join("\n\n"),
  };
}

function extractSqlBlocks(content: string): string[] {
  const matches = [...content.matchAll(/```sql\s*([\s\S]*?)```/gi)];
  return matches.map((m) => m[1].trim()).filter(Boolean);
}

function StatusLine({ text }: { text: string }) {
  return (
    <div className="chat-status-line">
      <Loader style={{ width: 11, height: 11 }} className="spin" />
      <span>{text}</span>
    </div>
  );
}

function SqlConfirmCard({ block, onApprove, onReject }: {
  block: SqlBlock;
  onApprove: () => void;
  onReject: () => void;
}) {
  const label = block.kind === "ddl" ? "DDL" : "Write";
  return (
    <div className="chat-tool-block chat-confirm-card">
      <div className="chat-tool-header">
        <AlertCircle style={{ width: 11, height: 11 }} />
        <span>{label} query — approve before running</span>
      </div>
      <div className="chat-confirm-actions">
        <button className="chat-confirm-approve" onClick={onApprove}>
          <CheckCircle style={{ width: 12, height: 12 }} /> Run
        </button>
        <button className="chat-confirm-reject" onClick={onReject}>
          <XCircle style={{ width: 12, height: 12 }} /> Reject
        </button>
      </div>
    </div>
  );
}

function SqlResultTable({ block, onApprove, onReject }: {
  block: SqlBlock;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  if (block.pendingApproval && onApprove && onReject) {
    return <SqlConfirmCard block={block} onApprove={onApprove} onReject={onReject} />;
  }
  if (block.rejected) {
    return (
      <div className="chat-tool-block chat-tool-rejected">
        <div className="chat-tool-header">
          <XCircle style={{ width: 11, height: 11 }} />
          <span>Query rejected</span>
        </div>
      </div>
    );
  }
  if (block.executing) {
    return (
      <div className="chat-tool-block">
        <div className="chat-tool-header">
          <Terminal style={{ width: 11, height: 11 }} />
          <span>Running query…</span>
          <Loader style={{ width: 10, height: 10 }} className="spin" />
        </div>
      </div>
    );
  }
  if (block.error) {
    return (
      <div className="chat-tool-block chat-tool-error">
        <div className="chat-tool-header">
          <AlertCircle style={{ width: 11, height: 11 }} />
          <span>Query failed</span>
        </div>
        <div className="chat-tool-error-msg">{block.error}</div>
      </div>
    );
  }
  if (!block.result) return null;
  const { columns, rows, elapsed_ms } = block.result;
  return (
    <div className="chat-tool-block">
      <div className="chat-tool-header">
        <Table2 style={{ width: 11, height: 11 }} />
        <span>{rows.length} row{rows.length !== 1 ? "s" : ""}</span>
        <span className="chat-tool-time">{formatMs(elapsed_ms)}</span>
      </div>
      {columns.length > 0 && (
        <div className="chat-result-wrap">
          <table className="chat-result-table">
            <thead>
              <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className={cell === null ? "chat-null" : ""}>
                      {cell === null ? "NULL" : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 50 && (
            <div className="chat-result-overflow">Showing 50 of {rows.length} rows</div>
          )}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ msg, onRetry, onApproveBlock, onRejectBlock }: {
  msg: Message;
  onRetry?: () => void;
  onApproveBlock?: (sql: string) => void;
  onRejectBlock?: (sql: string) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="chat-user-msg">
        <div className="chat-user-bubble">{msg.content}</div>
      </div>
    );
  }

  const parts = msg.content.split(/(```sql[\s\S]*?```)/gi);

  return (
    <div className="chat-assistant-msg">
      <div className="chat-assistant-icon">
        <Zap style={{ width: 12, height: 12 }} />
      </div>
      <div className="chat-assistant-body">
        {msg.status && msg.streaming && <StatusLine text={msg.status} />}

        {msg.error ? (
          <div className="chat-error-msg">
            <AlertCircle style={{ width: 13, height: 13 }} />
            <span>{msg.error}</span>
            {onRetry && (
              <button className="chat-retry-btn" onClick={onRetry}>
                <RotateCcw style={{ width: 11, height: 11 }} /> Retry
              </button>
            )}
          </div>
        ) : (
          <>
            {parts.map((part, i) => {
              const sqlMatch = part.match(/```sql\s*([\s\S]*?)```/i);
              if (sqlMatch) {
                const sql = sqlMatch[1].trim();
                const blockIdx = msg.sqlBlocks?.findIndex((b) => b.sql === sql) ?? -1;
                const block = blockIdx >= 0 ? msg.sqlBlocks![blockIdx] : null;
                return (
                  <div key={i}>
                    <pre className="chat-sql-block"><code>{sql}</code></pre>
                    {block && (
                      <SqlResultTable
                        block={block}
                        onApprove={block.pendingApproval ? () => onApproveBlock?.(sql) : undefined}
                        onReject={block.pendingApproval ? () => onRejectBlock?.(sql) : undefined}
                      />
                    )}
                  </div>
                );
              }
              if (!part) return null;
              if (msg.streaming) {
                return <div key={i} className="chat-md chat-md-plain">{part}</div>;
              }
              const html = DOMPurify.sanitize(marked(part) as string);
              return (
                <div
                  key={i}
                  className="chat-md"
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              );
            })}
            {msg.streaming && !msg.status && (
              <span className="chat-cursor" />
            )}
          </>
        )}
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  "What are the top 10 rows in the largest table?",
  "Show me the schema of all tables",
  "Which tables have the most relationships?",
  "Find any duplicate values in primary key columns",
];

export default function ChatPane({
  db,
  settings,
  messages,
  setMessages,
  streaming,
  setStreaming,
  input,
  setInput,
  inputRef,
  onConversationSaved,
  onQueryExecuted,
  onTokensUsed,
  onAssistantMessage,
  editorSql,
  editorResult,
  aiWriteMode = "confirm",
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [pendingApprovals, setPendingApprovals] = useState<Map<string, (approved: boolean) => void>>(new Map());
  const aiWriteModeRef = useRef(aiWriteMode);
  useEffect(() => { aiWriteModeRef.current = aiWriteMode; }, [aiWriteMode]);
  const schema = useRef(buildSchema(db));
  const editorContextRef = useRef<string>("");

  useEffect(() => {
    schema.current = buildSchema(db);
  }, [db]);

  useEffect(() => {
    if (!editorSql?.trim() || !editorResult) { editorContextRef.current = ""; return; }
    const { columns, rows, elapsed_ms } = editorResult;
    if (columns.length === 0) { editorContextRef.current = ""; return; }
    const header = columns.join(" | ");
    const sep = columns.map(() => "---").join(" | ");
    const dataRows = rows.slice(0, 50).map((r) => r.map((c) => c === null ? "NULL" : String(c)).join(" | "));
    const overflow = rows.length > 50 ? `\n(${rows.length - 50} more rows not shown)` : "";
    editorContextRef.current = `Current editor query (${formatMs(elapsed_ms)}):\n\`\`\`sql\n${editorSql.trim()}\n\`\`\`\nResults (${rows.length} row${rows.length !== 1 ? "s" : ""}):\n${header}\n${sep}\n${dataRows.join("\n")}${overflow}`;
  }, [editorSql, editorResult]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const updateMessage = useCallback((id: string, patch: Partial<Message>) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m))
    );
  }, [setMessages]);

  const runSingleBlock = useCallback(async (sql: string): Promise<SqlBlock> => {
    try {
      const result = await invoke<QueryResult>("execute_query", { path: db.file_path, sql });
      onQueryExecuted?.({
        sql,
        elapsed_ms: result.elapsed_ms,
        rows: result.rows.length,
        source: "ai",
        model: settings.provider === "anthropic" ? settings.anthropic_model
          : settings.provider === "openai" ? settings.openai_model
          : settings.provider === "ollama" ? settings.ollama_model
          : settings.openrouter_model,
        executedAt: Date.now(),
      });
      return { sql, kind: classifySql(sql), result, executing: false };
    } catch (e) {
      return { sql, kind: classifySql(sql), error: String(e), executing: false };
    }
  }, [db.file_path, settings, onQueryExecuted]);

  const executeSqlBlocks = useCallback(async (msgId: string, content: string) => {
    const sqls = extractSqlBlocks(content);
    if (sqls.length === 0) return;

    const initial: SqlBlock[] = sqls.map((sql) => {
      const kind = classifySql(sql);
      const needsConfirm = aiWriteModeRef.current === "confirm" && (kind === "write" || kind === "ddl");
      return { sql, kind, executing: !needsConfirm, pendingApproval: needsConfirm };
    });
    updateMessage(msgId, { sqlBlocks: initial });

    const resolved: SqlBlock[] = await Promise.all(
      initial.map(async (block) => {
        if (!block.pendingApproval) return runSingleBlock(block.sql);

        // Wait for user approval
        const approved = await new Promise<boolean>((resolve) => {
          const key = `${msgId}::${block.sql}`;
          setPendingApprovals((prev) => new Map(prev).set(key, resolve));
          updateMessage(msgId, {
            sqlBlocks: initial.map((b) =>
              b.sql === block.sql ? { ...b, pendingApproval: true } : b
            ),
          });
        });

        if (!approved) return { sql: block.sql, kind: block.kind, rejected: true, executing: false };
        return runSingleBlock(block.sql);
      })
    );

    updateMessage(msgId, { sqlBlocks: resolved });
    setPendingApprovals(new Map());
  }, [updateMessage, runSingleBlock]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || streaming) return;

    const userMsg: Message = { id: uid(), role: "user", content: text.trim() };
    const assistantId = uid();
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      status: "Thinking…",
      streaming: true,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput("");
    setStreaming(true);

    const ctx = editorContextRef.current;
    const history: ChatMessage[] = [
      ...(ctx ? [
        { role: "user" as const, content: ctx },
        { role: "assistant" as const, content: "Got it — I can see your current query and its results." },
      ] : []),
      ...messages.map(serializeMessageForAI),
      { role: "user", content: text.trim() },
    ];

    let fullContent = "";
    let realPromptTokens = 0;
    let realCompletionTokens = 0;

    try {
      for await (const chunk of streamChat(settings, history, schema.current)) {
        if (chunk.type === "status") {
          updateMessage(assistantId, { status: chunk.text });
        } else if (chunk.type === "token") {
          fullContent += chunk.text;
          const hasSql = /```sql/i.test(fullContent);
          updateMessage(assistantId, {
            content: fullContent,
            status: hasSql ? "Generating SQL…" : "Generating response…",
          });
        } else if (chunk.type === "usage") {
          realPromptTokens = chunk.promptTokens;
          realCompletionTokens = chunk.completionTokens;
        } else if (chunk.type === "error") {
          updateMessage(assistantId, {
            error: chunk.text,
            streaming: false,
            status: undefined,
          });
          setStreaming(false);
          return;
        } else if (chunk.type === "done") {
          break;
        }
      }
    } catch (e) {
      updateMessage(assistantId, {
        error: String(e),
        streaming: false,
        status: undefined,
      });
      setStreaming(false);
      return;
    }

    updateMessage(assistantId, { streaming: false, status: undefined });
    setStreaming(false);

    if (extractSqlBlocks(fullContent).length > 0) {
      updateMessage(assistantId, { status: "Running queries…", streaming: true });
      await executeSqlBlocks(assistantId, fullContent);
      updateMessage(assistantId, { status: undefined, streaming: false });
    }

    // Use real token counts from provider when available; fall back to char estimate
    // Fallback includes system prompt length for a more accurate estimate
    const promptTokens = realPromptTokens > 0
      ? realPromptTokens
      : Math.ceil((history.reduce((s, m) => s + m.content.length, 0) + schema.current.length) / 4);
    const completionTokens = realCompletionTokens > 0
      ? realCompletionTokens
      : Math.ceil(fullContent.length / 4);
    onTokensUsed?.(promptTokens, completionTokens, realPromptTokens > 0);
    onAssistantMessage?.(fullContent);

    setMessages((prev) => {
      onConversationSaved?.(prev);
      return prev;
    });
  }, [messages, settings, streaming, setMessages, setInput, setStreaming, updateMessage, executeSqlBlocks, onConversationSaved, onTokensUsed, onAssistantMessage]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const sendKey = settings.chat_send_key ?? "CmdEnter";
    const isCmdEnter = (e.metaKey || e.ctrlKey) && e.key === "Enter";
    const isShiftEnter = e.shiftKey && e.key === "Enter";
    const triggered = sendKey === "ShiftEnter" ? isShiftEnter : isCmdEnter;
    if (triggered) {
      e.preventDefault();
      sendMessage(input);
    }
  }

  const hasProvider = Boolean(
    (settings.provider === "anthropic" && settings.anthropic_key) ||
    (settings.provider === "openai" && settings.openai_key) ||
    (settings.provider === "ollama" && settings.ollama_model) ||
    (settings.provider === "openrouter" && settings.openrouter_key)
  );

  return (
    <div className="chat-pane">
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-welcome">
            <div className="chat-welcome-icon">
              <img src="/brand/mark-light.svg" alt="" className="chat-welcome-mark" draggable={false} />
            </div>
            <div className="chat-welcome-title">Ask anything about your database</div>
            <div className="chat-welcome-sub">
              {hasProvider
                ? `Using ${settings.provider} · ${settings.provider === "anthropic" ? settings.anthropic_model : settings.provider === "openai" ? settings.openai_model : settings.provider === "ollama" ? settings.ollama_model : settings.openrouter_model}`
                : "Configure an AI provider in Settings ⚙ to get started"}
            </div>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chat-suggestion" onClick={() => sendMessage(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            onRetry={msg.role === "assistant" && msg.error ? () => {
              const lastUser = [...messages].reverse().find((m) => m.role === "user");
              if (lastUser) {
                setMessages((prev) => prev.filter((m) => m.id !== msg.id));
                sendMessage(lastUser.content);
              }
            } : undefined}
            onApproveBlock={(sql) => {
              const key = `${msg.id}::${sql}`;
              const resolve = pendingApprovals.get(key);
              if (resolve) { resolve(true); setPendingApprovals((p) => { const n = new Map(p); n.delete(key); return n; }); }
            }}
            onRejectBlock={(sql) => {
              const key = `${msg.id}::${sql}`;
              const resolve = pendingApprovals.get(key);
              if (resolve) { resolve(false); setPendingApprovals((p) => { const n = new Map(p); n.delete(key); return n; }); }
            }}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-area">
        <div className="chat-input-wrap">
          <textarea
            ref={inputRef}
            className="chat-input"
            placeholder="  Ask a question about your data…   (⌘↵ to send)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={streaming}
            rows={1}
          />
          <button
            className="chat-send-btn"
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || streaming}
          >
            {streaming
              ? <Loader style={{ width: 14, height: 14 }} className="spin" />
              : <Send style={{ width: 14, height: 14 }} />}
          </button>
        </div>
      </div>
    </div>
  );
}
