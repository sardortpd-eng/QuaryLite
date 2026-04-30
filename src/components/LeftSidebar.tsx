import { useState, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Database, ChevronDown, ChevronRight,
  LayoutDashboard, Compass, Table2,
  Key, Link2, Hash, Waves, Type, Binary,
  GitFork, FolderOpen, Settings, MessageSquare,
  Eye, Zap,
} from "lucide-react";
import type { DbSchema, ColumnInfo, ActiveView } from "../App";
import ConversationHistory from "./ConversationHistory";
import type { Message } from "./ChatPane";

interface Props {
  db: DbSchema | null;
  onOpen: () => void;
  activeView: ActiveView;
  onViewChange: (v: ActiveView) => void;
  selectedTable: string | null;
  onSelectTable: (name: string) => void;
  onOpenSettings: () => void;
  onLoadConversation: (msgs: Message[]) => void;
  width?: number;
}

const ICON_SM = { width: 12, height: 12, flexShrink: 0 as const };
const ICON_MD = { width: 14, height: 14, flexShrink: 0 as const };
const ICON_LG = { width: 16, height: 16, flexShrink: 0 as const };

function colIcon(col: ColumnInfo): React.ReactNode {
  if (col.pk) return <Key style={ICON_SM} />;
  if (col.name.endsWith("_id")) return <Link2 style={ICON_SM} />;
  const t = col.col_type.toUpperCase();
  if (t.includes("INT")) return <Hash style={ICON_SM} />;
  if (t.includes("REAL") || t.includes("FLOAT") || t.includes("NUM")) return <Waves style={ICON_SM} />;
  if (t.includes("BLOB")) return <Binary style={ICON_SM} />;
  return <Type style={ICON_SM} />;
}

function typeBadgeClass(col_type: string): string {
  const t = col_type.toUpperCase();
  if (t.includes("INT")) return "badge badge-int";
  if (t.includes("TEXT") || t.includes("CHAR") || t.includes("CLOB")) return "badge badge-text";
  if (t.includes("REAL") || t.includes("FLOAT") || t.includes("NUM") || t.includes("DEC")) return "badge badge-real";
  return "badge badge-blob";
}

function formatRowCount(n: number): string {
  if (n < 0) return "…";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

type FlatRow =
  | { kind: "table"; table: DbSchema["tables"][number] }
  | { kind: "col"; col: ColumnInfo; isLast: boolean };

export default function LeftSidebar({ db, onOpen, activeView, onViewChange, selectedTable, onSelectTable, onOpenSettings, onLoadConversation, width }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [indexesOpen, setIndexesOpen] = useState(false);

  const totalColumns = db?.tables.reduce((sum, t) => sum + t.columns.length, 0) ?? 0;

  const q = search.toLowerCase();
  const showViews = viewsOpen || q.length > 0;
  const showIndexes = indexesOpen || q.length > 0;

  const filtered = db
    ? db.tables.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.columns.some((c) => c.name.toLowerCase().includes(q))
      )
    : [];

  const filteredViews = db
    ? db.views.filter((v) => v.name.toLowerCase().includes(q))
    : [];

  const filteredIndexes = db
    ? db.indexes.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.table_name.toLowerCase().includes(q) ||
          i.columns.some((c) => c.toLowerCase().includes(q))
      )
    : [];

  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const table of filtered) {
      rows.push({ kind: "table", table });
      const open = expanded.has(table.name) || (search.length > 0 && filtered.some((t) => t.name === table.name));
      if (open) {
        table.columns.forEach((col, idx) => {
          rows.push({ kind: "col", col, isLast: idx === table.columns.length - 1 });
        });
      }
    }
    return rows;
  }, [filtered, expanded, search]);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => (flatRows[i].kind === "table" ? 30 : 24),
    overscan: 8,
  });

  function toggleTable(name: string) {
    onSelectTable(name);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const isExpanded = (name: string) =>
    expanded.has(name) || (search.length > 0 && filtered.some((t) => t.name === name));

  return (
    <aside className="left-sidebar" style={width ? { width } : undefined}>
      <div className="db-header" onClick={onOpen} title="Click to open a database">
        <div className="db-icon">
          <Database style={ICON_LG} />
        </div>
        <div className="db-info">
          <div className="db-name">{db ? db.file_name : "Open Database..."}</div>
          <div className="db-meta">
            {db
              ? `SQLite ${db.sqlite_version} · ${db.file_size_mb.toFixed(1)} MB`
              : "Click to open a .db file"}
          </div>
        </div>
        <span className="db-chevron">
          <ChevronDown style={ICON_MD} />
        </span>
      </div>

      {db && (
        <>
          <div className="sidebar-section">
            <div className="sidebar-section-label">Database</div>
            <div
              className={`nav-item${activeView === "overview" ? " active" : ""}`}
              onClick={() => onViewChange("overview")}
            >
              <span className="nav-item-icon"><LayoutDashboard style={ICON_MD} /></span>
              Overview
            </div>
            <div
              className={`nav-item${activeView === "explorer" ? " active" : ""}`}
              onClick={() => onViewChange("explorer")}
            >
              <span className="nav-item-icon"><Compass style={ICON_MD} /></span>
              Explorer
            </div>
          </div>

          <div className="tables-header">
            <span className="tables-label">Tables ({db.tables.length})</span>
            <span className="tables-chevron"><ChevronDown style={ICON_SM} /></span>
          </div>

          <input
            className="search-input"
            placeholder="Search tables & columns..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          <div className="table-list" ref={listRef}>
            {filtered.length === 0 && search ? (
              <div style={{ padding: "12px 8px", color: "var(--text-muted)", fontSize: 12 }}>
                No tables or columns match "{search}"
              </div>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((vitem) => {
                  const row = flatRows[vitem.index];
                  return (
                    <div
                      key={vitem.key}
                      data-index={vitem.index}
                      ref={virtualizer.measureElement}
                      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vitem.start}px)` }}
                    >
                      {row.kind === "table" ? (() => {
                        const open = isExpanded(row.table.name);
                        const isSelected = selectedTable === row.table.name;
                        return (
                          <div
                            className={`table-item${isSelected ? " selected" : ""}`}
                            onClick={() => toggleTable(row.table.name)}
                          >
                            <div className="table-item-left">
                              <span className="table-item-icon"><Table2 style={ICON_MD} /></span>
                              <span className="table-item-name">{row.table.name}</span>
                            </div>
                            <div className="table-item-right">
                              <span className="table-item-count">{formatRowCount(row.table.row_count)}</span>
                              <span className={`table-item-chevron${open ? " open" : ""}`}>
                                <ChevronRight style={ICON_SM} />
                              </span>
                            </div>
                          </div>
                        );
                      })() : (
                        <div className="col-row">
                          <span className="col-connector">{row.isLast ? "└─" : "├─"}</span>
                          <span className="col-icon">{colIcon(row.col)}</span>
                          <span className="col-name">{row.col.name}</span>
                          <div className="col-badges">
                            <span className={typeBadgeClass(row.col.col_type)}>
                              {row.col.col_type || "—"}
                            </span>
                            {row.col.not_null && !row.col.pk && (
                              <span className="badge badge-nn">NN</span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Views */}
          {filteredViews.length > 0 && (
            <div className="schema-group">
              <div className="schema-group-header" onClick={() => setViewsOpen((v) => !v)} style={{ cursor: "pointer" }}>
                <Eye style={ICON_SM} />
                <span>Views ({filteredViews.length})</span>
                <span style={{ marginLeft: "auto" }}>
                  {viewsOpen ? <ChevronDown style={ICON_SM} /> : <ChevronRight style={ICON_SM} />}
                </span>
              </div>
              {showViews && filteredViews.map((v) => (
                <div key={v.name} className="schema-group-item" title={v.sql}>
                  <Eye style={{ ...ICON_SM, opacity: 0.5 }} />
                  <span className="schema-group-item-name">{v.name}</span>
                </div>
              ))}
            </div>
          )}

          {/* Indexes */}
          {filteredIndexes.length > 0 && (
            <div className="schema-group">
              <div className="schema-group-header" onClick={() => setIndexesOpen((v) => !v)} style={{ cursor: "pointer" }}>
                <Zap style={ICON_SM} />
                <span>Indexes ({filteredIndexes.length})</span>
                <span style={{ marginLeft: "auto" }}>
                  {indexesOpen ? <ChevronDown style={ICON_SM} /> : <ChevronRight style={ICON_SM} />}
                </span>
              </div>
              {showIndexes && filteredIndexes.map((idx) => (
                <div key={idx.name} className="schema-group-item" title={`${idx.table_name}(${idx.columns.join(", ")})`}>
                  <Zap style={{ ...ICON_SM, opacity: 0.5 }} />
                  <span className="schema-group-item-name">{idx.name}</span>
                  {idx.unique && <span className="schema-group-badge">U</span>}
                </div>
              ))}
            </div>
          )}

          <div className="schema-summary">
            <div className="schema-summary-title">Schema Summary</div>
            <div className="schema-summary-meta">
              {db.tables.length} tables · {totalColumns} columns
              {db.views.length > 0 && ` · ${db.views.length} views`}
              {db.indexes.length > 0 && ` · ${db.indexes.length} indexes`}
            </div>
          </div>

          <div className="view-relationships" onClick={() => onViewChange("relationships")}>
            <GitFork style={ICON_MD} />
            View Relationships
          </div>

          <div className="history-section">
            <div className="history-section-header" onClick={() => setHistoryOpen((v) => !v)}>
              <MessageSquare style={ICON_SM} />
              <span>Chat History</span>
              <span className="history-chevron">
                {historyOpen
                  ? <ChevronDown style={ICON_SM} />
                  : <ChevronRight style={ICON_SM} />}
              </span>
            </div>
            {historyOpen && (
              <ConversationHistory
                dbPath={db.file_path}
                onLoad={onLoadConversation}
              />
            )}
          </div>
        </>
      )}

      {!db && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ textAlign: "center", padding: "0 20px" }}>
            <img
              src="/brand/mark-light.svg"
              alt=""
              style={{ width: 36, height: 36, opacity: 0.45, display: "block", margin: "0 auto 12px" }}
              draggable={false}
            />
            <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
              Click the header above to open a SQLite database file
            </div>
          </div>
        </div>
      )}

      <div className="sidebar-footer">
        {db && (
          <div className="connected-badge">
            <div className="connected-dot" style={{ background: "var(--green)" }} />
            Connected
          </div>
        )}
        <div className="footer-actions">
          <button className="icon-btn" onClick={onOpen} title="Open database">
            <FolderOpen style={ICON_MD} />
          </button>
          <button className="icon-btn" title="Settings" onClick={onOpenSettings}>
            <Settings style={ICON_MD} />
          </button>
        </div>
      </div>
    </aside>
  );
}
