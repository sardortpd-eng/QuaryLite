import { useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, ChevronDown, PanelLeft, PanelRight, PanelBottom } from "lucide-react";
import type { DbSchema } from "../App";

interface Props {
  db: DbSchema | null;
  showLeft: boolean;
  showRight: boolean;
  showChat: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onToggleChat: () => void;
  onOpenDb: () => void;
  onReloadDb: () => Promise<void> | void;
}

export default function Toolbar({ db, showLeft, showRight, showChat, onToggleLeft, onToggleRight, onToggleChat, onOpenDb, onReloadDb }: Props) {
  const [reloading, setReloading] = useState(false);

  async function handleReload() {
    if (reloading) return;
    setReloading(true);
    try {
      await onReloadDb();
    } finally {
      setReloading(false);
    }
  }

  return (
    <div className="toolbar">
      {/* Left: nav + title */}
      <div className="toolbar-left">
        <button className="toolbar-nav-btn" disabled title="Back">
          <ChevronLeft style={{ width: 14, height: 14 }} />
        </button>
        <button className="toolbar-nav-btn" disabled title="Forward">
          <ChevronRight style={{ width: 14, height: 14 }} />
        </button>
        <div className="toolbar-sep" />
        <span className="toolbar-title">QuaryLite</span>
      </div>

      {/* Center: db status */}
      <div className="toolbar-center">
        {db ? (
          <>
            <span className="toolbar-status-dot active" />
            <span className="toolbar-status-text">{db.file_name}</span>
            <button
              className={`toolbar-icon-btn${reloading ? " toolbar-reloading" : ""}`}
              onClick={handleReload}
              disabled={reloading}
              title="Reload schema"
            >
              <RefreshCw style={{ width: 12, height: 12 }} />
            </button>
            <button className="toolbar-icon-btn toolbar-chevron-btn" onClick={onOpenDb} title="Switch database">
              <ChevronDown style={{ width: 12, height: 12 }} />
            </button>
          </>
        ) : (
          <>
            <span className="toolbar-status-dot" />
            <span className="toolbar-status-text" style={{ color: "var(--text-muted)" }}>No database</span>
          </>
        )}
      </div>

      {/* Right: layout toggles */}
      <div className="toolbar-right">
        <div className="toolbar-sep" />
        <button
          className={`toolbar-layout-btn${showLeft ? " active" : ""}`}
          onClick={onToggleLeft}
          title="Toggle sidebar"
        >
          <PanelLeft style={{ width: 15, height: 15 }} />
        </button>
        <button
          className={`toolbar-layout-btn${showChat ? " active" : ""}`}
          onClick={onToggleChat}
          title="Toggle chat"
        >
          <PanelBottom style={{ width: 15, height: 15 }} />
        </button>
        <button
          className={`toolbar-layout-btn${showRight ? " active" : ""}`}
          onClick={onToggleRight}
          title="Toggle panel"
        >
          <PanelRight style={{ width: 15, height: 15 }} />
        </button>
      </div>
    </div>
  );
}
