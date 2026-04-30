import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Table2, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import type { DbSchema } from "../App";

interface TableData {
  columns: string[];
  rows: string[][];
  total: number;
}

interface Props {
  db: DbSchema;
  selectedTable: string | null;
  onSelectTable: (name: string) => void;
}

const PAGE_SIZE = 50;

export default function ExplorerPane({ db, selectedTable, onSelectTable }: Props) {
  const [data, setData] = useState<TableData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  const table = selectedTable ?? (db.tables[0]?.name ?? null);

  useEffect(() => {
    if (!table) return;
    setPage(0);
  }, [table]);

  useEffect(() => {
    if (!table) return;
    setLoading(true);
    setError(null);
    invoke<TableData>("get_table_data", {
      path: db.file_path,
      table,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
      .then(setData)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [table, page, db.file_path, refreshKey]);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <main className="explorer-pane">
      <div className="explorer-header">
        <div className="explorer-table-tabs">
          {db.tables.map((t) => (
            <button
              key={t.name}
              className={`explorer-tab${t.name === table ? " active" : ""}`}
              onClick={() => { onSelectTable(t.name); setPage(0); }}
            >
              <Table2 style={{ width: 12, height: 12 }} />
              {t.name}
            </button>
          ))}
        </div>
        <button
          className="explorer-refresh"
          onClick={() => setRefreshKey((k) => k + 1)}
          title="Refresh"
        >
          <RefreshCw style={{ width: 13, height: 13 }} />
        </button>
      </div>

      {error && (
        <div className="explorer-error">{error}</div>
      )}

      {!table && (
        <div className="explorer-empty">Select a table to browse its data</div>
      )}

      {table && (
        <>
          <div className="explorer-meta">
            <span className="explorer-table-name">{table}</span>
            {data && (
              <span className="explorer-row-count">{data.total.toLocaleString()} rows</span>
            )}
          </div>

          <div className="explorer-grid-wrap">
            {loading && <div className="explorer-loading">Loading…</div>}
            {!loading && data && (
              <table className="explorer-grid">
                <thead>
                  <tr>
                    <th className="explorer-rownum">#</th>
                    {data.columns.map((col) => (
                      <th key={col}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, ri) => (
                    <tr key={ri}>
                      <td className="explorer-rownum">{page * PAGE_SIZE + ri + 1}</td>
                      {row.map((cell, ci) => (
                        <td key={ci} className={cell === null ? "explorer-null" : ""}>
                          {cell === null ? "NULL" : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {data && totalPages > 1 && (
            <div className="explorer-pagination">
              <span className="explorer-page-info">
                Page {page + 1} of {totalPages}
              </span>
              <button
                className="page-btn"
                disabled={page === 0}
                onClick={() => setPage(0)}
              >«</button>
              <button
                className="page-btn"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft style={{ width: 12, height: 12 }} />
              </button>
              <button
                className="page-btn"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight style={{ width: 12, height: 12 }} />
              </button>
              <button
                className="page-btn"
                disabled={page >= totalPages - 1}
                onClick={() => setPage(totalPages - 1)}
              >»</button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
