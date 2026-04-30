import { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toBlob } from "html-to-image";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  Position,
  Handle,
  BackgroundVariant,
  ReactFlowProvider,
} from "@xyflow/react";
import dagre from "dagre";
import "@xyflow/react/dist/style.css";
import { Key, Link2, Hash, Waves, Type, Binary, X, Workflow, ImageDown } from "lucide-react";
import type { DbSchema, ColumnInfo } from "../App";

interface FkEdge {
  from_table: string;
  from_col: string;
  to_table: string;
  to_col: string;
}

interface SchemaGraph {
  tables: Array<{ name: string; columns: ColumnInfo[]; row_count: number }>;
  edges: FkEdge[];
}

interface Props {
  db: DbSchema;
  onClose: () => void;
}

const ICON_XS = { width: 10, height: 10, flexShrink: 0 as const };
const NODE_W = 220;

function nodeHeight(colCount: number) {
  return 36 + colCount * 22 + 8;
}

function colIcon(col: ColumnInfo) {
  if (col.pk) return <Key style={ICON_XS} />;
  if (col.name.endsWith("_id")) return <Link2 style={ICON_XS} />;
  const t = col.col_type.toUpperCase();
  if (t.includes("INT")) return <Hash style={ICON_XS} />;
  if (t.includes("REAL") || t.includes("FLOAT") || t.includes("NUM")) return <Waves style={ICON_XS} />;
  if (t.includes("BLOB")) return <Binary style={ICON_XS} />;
  return <Type style={ICON_XS} />;
}

function TableNode({ data }: { data: { name: string; columns: ColumnInfo[]; rowCount: number } }) {
  return (
    <div className="er-node">
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="er-node-header">
        <span className="er-node-name">{data.name}</span>
        <span className="er-node-count">{data.rowCount < 0 ? "…" : data.rowCount.toLocaleString()}</span>
      </div>
      <div className="er-node-cols">
        {data.columns.map((col) => (
          <div key={col.name} className={`er-col-row${col.pk ? " er-col-pk" : ""}`}>
            <span className="er-col-icon">{colIcon(col)}</span>
            <span className="er-col-name">{col.name}</span>
            <span className="er-col-type">{col.col_type || "—"}</span>
          </div>
        ))}
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </div>
  );
}

const NODE_TYPES = { table: TableNode };

function buildEdges(fkEdges: FkEdge[]): Edge[] {
  return fkEdges.map((e, i) => ({
    id: `e-${i}`,
    source: e.from_table,
    target: e.to_table,
    title: `${e.from_col} → ${e.to_col}`,
    type: "smoothstep",
    animated: false,
    style: { stroke: "#4a4a52", strokeWidth: 1.5 },
  }));
}

function gridLayout(graph: SchemaGraph): Node[] {
  const COLS = 4;
  const GAP_X = 80;
  const GAP_Y = 60;
  return graph.tables.map((t, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    return {
      id: t.name,
      type: "table",
      position: { x: col * (NODE_W + GAP_X), y: row * (nodeHeight(t.columns.length) + GAP_Y) },
      data: { name: t.name, columns: t.columns, rowCount: t.row_count },
    };
  });
}

function dagreLayout(nodes: Node[], edges: Edge[], graph: SchemaGraph): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 });

  const colMap = Object.fromEntries(graph.tables.map((t) => [t.name, t.columns.length]));

  nodes.forEach((n) => {
    g.setNode(n.id, { width: NODE_W, height: nodeHeight(colMap[n.id] ?? 4) });
  });
  edges.forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - NODE_W / 2, y: pos.y - nodeHeight(colMap[n.id] ?? 4) / 2 } };
  });
}

function DiagramInner({ onClose, graph }: { onClose: () => void; graph: SchemaGraph }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(gridLayout(graph));
  const [edges, , onEdgesChange] = useEdgesState<Edge>(buildEdges(graph.edges));
  const { fitView } = useReactFlow();
  const flowWrapRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const autoLayout = useCallback(() => {
    setNodes((prev) => dagreLayout(prev, edges, graph));
    setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 50);
  }, [edges, graph, fitView, setNodes]);

  const exportPng = useCallback(async () => {
    const wrap = flowWrapRef.current;
    if (!wrap) return;
    setExporting(true);
    setExportError(null);
    try {
      const opts = {
        backgroundColor: "#18181c",
        pixelRatio: 4,
        width: wrap.offsetWidth,
        height: wrap.offsetHeight,
        filter: (node: Element | Text) => {
          if (node instanceof Element) {
            const cls = node.classList;
            if (cls.contains("react-flow__controls") || cls.contains("react-flow__minimap") || cls.contains("react-flow__panel")) return false;
          }
          return true;
        },
      };

      // First call primes the font cache (known html-to-image quirk)
      await toBlob(wrap, opts).catch(() => null);
      const blob = await toBlob(wrap, opts);
      if (!blob) throw new Error("Capture returned empty — try again");

      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(",")[1]);
        reader.onerror = () => reject(new Error("Failed to read image data"));
        reader.readAsDataURL(blob);
      });

      const saved = await invoke<boolean>("save_png_file", { data: base64 });
      if (!saved) return;
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExporting(false);
    }
  }, []);

  return (
    <>
      <div className="relationship-header">
        <span className="relationship-title">Relationships — {graph.tables.length} tables · {graph.edges.length} FK{graph.edges.length !== 1 ? "s" : ""}</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="er-toolbar-btn" onClick={autoLayout}>
            <Workflow style={{ width: 13, height: 13 }} />
            Auto Layout
          </button>
          <button className="er-toolbar-btn" onClick={exportPng} disabled={exporting} title={exportError ?? undefined}>
            <ImageDown style={{ width: 13, height: 13 }} />
            {exporting ? "Exporting…" : exportError ? "Export failed" : "Export PNG"}
          </button>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X style={{ width: 14, height: 14 }} />
          </button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }} ref={flowWrapRef}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          snapToGrid
          snapGrid={[20, 20]}
          minZoom={0.05}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} color="#4a4a55" />
          <Controls style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }} />
          <MiniMap
            nodeColor={() => "var(--bg-elevated)"}
            maskColor="rgba(0,0,0,0.4)"
            style={{ background: "var(--bg-surface)", border: "1px solid var(--border)" }}
          />
        </ReactFlow>
      </div>
    </>
  );
}

export default function RelationshipPane({ db, onClose }: Props) {
  const [graph, setGraph] = useState<SchemaGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    invoke<SchemaGraph>("get_schema_graph", { path: db.file_path })
      .then(setGraph)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [db.file_path]);

  return (
    <main className="relationship-pane">
      {loading && (
        <>
          <div className="relationship-header">
            <span className="relationship-title">Relationships — {db.file_name}</span>
          </div>
          <div className="relationship-loading">Building diagram…</div>
        </>
      )}
      {error && (
        <>
          <div className="relationship-header">
            <span className="relationship-title">Relationships — {db.file_name}</span>
            <button className="icon-btn" onClick={onClose}><X style={{ width: 14, height: 14 }} /></button>
          </div>
          <div className="relationship-error">{error}</div>
        </>
      )}
      {!loading && !error && graph && (
        <ReactFlowProvider>
          <DiagramInner onClose={onClose} graph={graph} />
        </ReactFlowProvider>
      )}
    </main>
  );
}
