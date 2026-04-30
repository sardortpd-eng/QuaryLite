import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { AISettings } from "../App";

interface Props {
  settings: AISettings;
  onClose: () => void;
}

const TX_LABELS: Record<string, string> = {
  CmdShiftB: "⌘⇧B", CmdShiftT: "⌘⇧T", F6: "F6",
  CmdShiftK: "⌘⇧K", CmdShiftC: "⌘⇧C", F7: "F7",
  CmdShiftZ: "⌘⇧Z", CmdShiftR: "⌘⇧R", F8: "F8",
  CmdEnter: "⌘↵", ShiftEnter: "⇧↵", F5: "F5",
  Alt: "Alt", Ctrl: "Ctrl", Shift: "⇧",
};

function label(key: string) {
  return TX_LABELS[key] ?? key;
}

export default function ShortcutSheet({ settings, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { triggerRef.current?.focus(); };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "?") { onClose(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sections: { heading: string; rows: [string, string][] }[] = [
    {
      heading: "Editor",
      rows: [
        ["Run query", label(settings.run_query_key)],
        ["Navigate history ↑", `${label(settings.history_modifier)} ↑`],
        ["Navigate history ↓", `${label(settings.history_modifier)} ↓`],
      ],
    },
    {
      heading: "Transactions",
      rows: [
        ["Begin transaction", label(settings.tx_begin_key)],
        ["Commit transaction", label(settings.tx_commit_key)],
        ["Roll back transaction", label(settings.tx_rollback_key)],
      ],
    },
    {
      heading: "AI Chat",
      rows: [
        ["Send message", label(settings.chat_send_key)],
      ],
    },
    {
      heading: "App",
      rows: [
        ["Keyboard shortcuts", "?"],
      ],
    },
  ];

  return (
    <div className="shortcut-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="shortcut-sheet" onClick={(e) => e.stopPropagation()} ref={ref}>
        <div className="shortcut-header">
          <span className="shortcut-title">Keyboard Shortcuts</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>
        <div className="shortcut-body">
          {sections.map((sec) => (
            <div key={sec.heading} className="shortcut-section">
              <div className="shortcut-section-heading">{sec.heading}</div>
              <table className="shortcut-table">
                <tbody>
                  {sec.rows.map(([action, kbd]) => (
                    <tr key={action}>
                      <td className="shortcut-action">{action}</td>
                      <td className="shortcut-kbd"><kbd>{kbd}</kbd></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
