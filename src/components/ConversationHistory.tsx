import { useState, useEffect, useCallback, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { MessageSquare, Trash2, Loader } from "lucide-react";
import type { Message } from "./ChatPane";
import { relativeTime } from "../lib/utils";

interface SerializedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface SavedConversation {
  id: string;
  title: string;
  db_path: string;
  db_name: string;
  created_at: number;
  updated_at: number;
  messages: SerializedMessage[];
}

interface Props {
  dbPath: string | null;
  onLoad: (messages: Message[]) => void;
}


export default function ConversationHistory({ dbPath, onLoad }: Props) {
  const [conversations, setConversations] = useState<SavedConversation[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const all = await invoke<SavedConversation[]>("load_conversations");
      setConversations(all);
    } catch {
      setConversations([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    try {
      await invoke("delete_conversation", { id });
      setConversations((prev) => prev.filter((c) => c.id !== id));
    } catch {}
  }

  function handleLoad(conv: SavedConversation) {
    const msgs: Message[] = conv.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
    }));
    onLoad(msgs);
  }

  const filtered = dbPath
    ? conversations.filter((c) => c.db_path === dbPath)
    : conversations;

  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 52,
    overscan: 5,
  });

  if (loading) {
    return (
      <div className="history-loading">
        <Loader style={{ width: 12, height: 12 }} className="spin" />
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="history-empty">No saved chats yet</div>
    );
  }

  return (
    <div className="history-list" ref={listRef}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vitem) => {
          const conv = filtered[vitem.index];
          return (
            <div
              key={conv.id}
              data-index={vitem.index}
              ref={virtualizer.measureElement}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vitem.start}px)` }}
            >
              <div
                className="history-item"
                onClick={() => handleLoad(conv)}
                title={conv.title}
              >
                <MessageSquare style={{ width: 11, height: 11, flexShrink: 0 }} />
                <div className="history-item-body">
                  <div className="history-item-title">{conv.title}</div>
                  <div className="history-item-meta">{relativeTime(conv.updated_at)}</div>
                </div>
                <button
                  className="history-delete-btn"
                  onClick={(e) => handleDelete(e, conv.id)}
                  title="Delete"
                >
                  <Trash2 style={{ width: 11, height: 11 }} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
