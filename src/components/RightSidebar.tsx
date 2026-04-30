import { Zap, ChevronRight, RotateCcw } from "lucide-react";
import type { QueryMeta, SessionTokens, AISettings, DbSchema } from "../App";
import { formatMs } from "../lib/utils";

interface Props {
  lastQueryMeta: QueryMeta | null;
  sessionTokens: SessionTokens;
  lastAssistantMessage: string;
  settings: AISettings;
  db: DbSchema | null;
  onResetTokens: () => void;
  onSuggestionClick?: (text: string) => void;
  width?: number;
}

// Pricing per 1M tokens (input / output) in USD — updated 2025-04
const MODEL_PRICING: Record<string, [number, number]> = {
  "claude-opus-4-7":   [15,   75],
  "claude-sonnet-4-6": [3,    15],
  "claude-haiku-4-5":  [0.80, 4.0],
  "gpt-4o":            [2.50, 10],
  "gpt-4o-mini":       [0.15, 0.60],
  "gpt-4-turbo":       [10,   30],
  "gpt-3.5-turbo":     [0.50, 1.50],
};

function estimateCost(model: string, prompt: number, completion: number): number {
  const [p, c] = MODEL_PRICING[model] ?? [5, 15];
  return (prompt / 1_000_000) * p + (completion / 1_000_000) * c;
}

function formatCost(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}


function generateSuggestions(assistantMsg: string, meta: QueryMeta | null): string[] {
  if (!assistantMsg && !meta) return [];

  const sql = meta?.sql?.toUpperCase() ?? "";
  const suggestions: string[] = [];

  if (sql.includes("DATE") || sql.includes("MONTH") || sql.includes("YEAR") || sql.includes("CREATED_AT")) {
    suggestions.push("Group these results by month");
  }
  if (meta && meta.rows > 50) {
    suggestions.push("Filter to the top 10 by value");
  }
  if ((sql.match(/JOIN/g) ?? []).length >= 1) {
    suggestions.push("Show only the unmatched records");
  }
  if (sql.includes("COUNT") || sql.includes("SUM") || sql.includes("AVG")) {
    suggestions.push("Compare with the previous period");
  }

  const fallbacks = [
    "Explain what this query does",
    "Show me related tables",
    "Find any outliers in this data",
    "What indexes would speed this up?",
  ];
  for (const f of fallbacks) {
    if (suggestions.length >= 3) break;
    if (!suggestions.includes(f)) suggestions.push(f);
  }

  return suggestions.slice(0, 3);
}

export default function RightSidebar({
  lastQueryMeta,
  sessionTokens,
  lastAssistantMessage,
  settings,
  db,
  onResetTokens,
  onSuggestionClick,
  width,
}: Props) {
  const activeModel =
    settings.provider === "anthropic" ? settings.anthropic_model
    : settings.provider === "openai" ? settings.openai_model
    : settings.provider === "ollama" ? settings.ollama_model
    : settings.openrouter_model;

  const cost = estimateCost(activeModel, sessionTokens.promptTokens, sessionTokens.completionTokens);
  const suggestions = generateSuggestions(lastAssistantMessage, lastQueryMeta);
  const schemaTableCount = db?.tables.length ?? 0;
  const schemaColCount = db?.tables.reduce((s, t) => s + t.columns.length, 0) ?? 0;

  return (
    <aside className="right-sidebar" style={width ? { width } : undefined}>

      {/* ── Compact stats strip ── */}
      <div className="rs-stats-strip">
        {lastQueryMeta ? (
          <>
            <div className="rs-stat">
              <span className="rs-stat-value">{formatMs(lastQueryMeta.elapsed_ms)}</span>
              <span className="rs-stat-label">duration</span>
            </div>
            <div className="rs-stat-sep" />
            <div className="rs-stat">
              <span className="rs-stat-value">{lastQueryMeta.rows.toLocaleString()}</span>
              <span className="rs-stat-label">rows</span>
            </div>
            <div className="rs-stat-sep" />
            <div className="rs-stat">
              <span className="rs-stat-value rs-stat-source">
                {lastQueryMeta.source === "ai" ? "AI" : "SQL"}
              </span>
              <span className="rs-stat-label">source</span>
            </div>
          </>
        ) : (
          <span className="rs-stat-empty">No query yet</span>
        )}
      </div>

      {/* ── Token / cost strip ── */}
      {sessionTokens.queryCount > 0 && (
        <div className="rs-token-strip">
          <Zap style={{ width: 11, height: 11, opacity: 0.5 }} />
          <span className="rs-token-strip-text">
            {(sessionTokens.promptTokens + sessionTokens.completionTokens).toLocaleString()}
            {!sessionTokens.hasRealUsage && "~"} tok
          </span>
          <span className="rs-token-strip-cost">
            {formatCost(cost)}
            {!sessionTokens.hasRealUsage && <span className="rs-est-tilde">~</span>}
          </span>
          <button className="rs-reset-btn" onClick={onResetTokens} title="Reset session">
            <RotateCcw style={{ width: 10, height: 10 }} />
          </button>
        </div>
      )}

      {/* ── Suggestions ── */}
      {suggestions.length > 0 && (
        <div className="rs-panel rs-suggestions-panel">
          <div className="rs-panel-header">
            <span className="rs-panel-title">Suggestions</span>
          </div>
          {suggestions.map((s) => (
            <div
              key={s}
              className="rs-suggestion"
              onClick={() => onSuggestionClick?.(s)}
              style={{ cursor: onSuggestionClick ? "pointer" : undefined }}
            >
              <span>{s}</span>
              <ChevronRight style={{ width: 12, height: 12, flexShrink: 0 }} />
            </div>
          ))}
        </div>
      )}

      {/* ── Schema context ── */}
      {schemaTableCount > 0 && (
        <div className="rs-schema-context">
          {schemaTableCount} tables · {schemaColCount} columns in context
        </div>
      )}

    </aside>
  );
}
