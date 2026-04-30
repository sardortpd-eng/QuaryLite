import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Eye, EyeOff, CheckCircle, XCircle, Loader, RefreshCw } from "lucide-react";
import type { AISettings, AppTheme } from "../App";

interface Props {
  initial: AISettings;
  onSave: (s: AISettings) => void;
  onClose: () => void;
  theme: AppTheme;
  onThemeChange: (t: AppTheme) => void;
}

type Provider = AISettings["provider"];
type TestStatus = "idle" | "testing" | "ok" | "fail";
type SettingsTab = "ai" | "editor" | "keybinds" | "theme";

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "anthropic",  label: "Anthropic" },
  { id: "openai",     label: "OpenAI" },
  { id: "ollama",     label: "Ollama" },
  { id: "openrouter", label: "OpenRouter" },
];

const ANTHROPIC_MODELS = [
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

const OPENAI_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
];

const FONT_FAMILIES = [
  "JetBrains Mono",
  "Fira Code",
  "Monaco",
  "Menlo",
  "Consolas",
  "Courier New",
];

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "ai",       label: "AI" },
  { id: "editor",   label: "Editor" },
  { id: "keybinds", label: "Keybinds" },
  { id: "theme",    label: "Theme" },
];

const THEMES: { id: AppTheme; label: string; description: string; preview: { bg: string; surface: string; accent: string; text: string } }[] = [
  { id: "dark",     label: "Obsidian",     description: "Default dark theme",        preview: { bg: "#1a1a1d", surface: "#212125", accent: "#5b9cf6", text: "#f2f2f4" } },
  { id: "light",    label: "Light",        description: "Clean light theme",         preview: { bg: "#f4f4f5", surface: "#ffffff", accent: "#3b82f6", text: "#18181b" } },
  { id: "midnight", label: "Midnight",     description: "GitHub-inspired dark blue", preview: { bg: "#0d1117", surface: "#161b22", accent: "#58a6ff", text: "#e6edf3" } },
  { id: "mocha",    label: "Mocha",        description: "Warm purple dark",          preview: { bg: "#1e1e2e", surface: "#25253a", accent: "#cba6f7", text: "#cdd6f4" } },
];

interface KbRowProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function KbRow({ label, hint, children }: KbRowProps) {
  return (
    <div className="settings-kb-row">
      <div className="settings-kb-label">
        <span>{label}</span>
        {hint && <span className="settings-hint">{hint}</span>}
      </div>
      <div className="settings-kb-control">{children}</div>
    </div>
  );
}

export default function SettingsModal({ initial, onSave, onClose, theme, onThemeChange }: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Capture focus origin so we can restore it on close
  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement;
    // Move focus into modal
    const first = modalRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    first?.focus();
    return () => { triggerRef.current?.focus(); };
  }, []);

  // Esc to close + focus trap
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const modal = modalRef.current;
      if (!modal) return;
      const focusable = Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const [tab, setTab] = useState<SettingsTab>(
    () => (localStorage.getItem("settings_tab") as SettingsTab | null) ?? "ai"
  );

  function switchTab(t: SettingsTab) {
    setTab(t);
    localStorage.setItem("settings_tab", t);
  }
  const [s, setS] = useState<AISettings>({ ...initial });
  const [showKey, setShowKey] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaScanning, setOllamaScanning] = useState(false);
  const [ollamaSource, setOllamaSource] = useState<"local" | "server">("local");
  const [orModels, setOrModels] = useState<string[]>([]);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testMsg, setTestMsg] = useState("");
  const [saving, setSaving] = useState(false);

  function patch(fields: Partial<AISettings>) {
    setS((prev) => ({ ...prev, ...fields }));
    setTestStatus("idle");
  }

  useEffect(() => {
    if (s.provider !== "ollama") return;
    scanLocalOllamaModels();
  }, [s.provider]);

  async function scanLocalOllamaModels() {
    setOllamaScanning(true);
    setOllamaSource("local");
    try {
      const names = await invoke<string[]>("list_ollama_models");
      mergeOllamaModels(names);
    } catch {
      await fetchOllamaServerModels(s.ollama_base_url);
    } finally {
      setOllamaScanning(false);
    }
  }

  async function fetchOllamaServerModels(baseUrl: string) {
    setOllamaSource("server");
    try {
      const headers: Record<string, string> = {};
      if (s.ollama_key) headers["Authorization"] = `Bearer ${s.ollama_key}`;
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { headers });
      const json = await res.json();
      const names: string[] = (json.models ?? []).map((m: { name: string }) => m.name);
      mergeOllamaModels(names);
    } catch {
      setOllamaModels([]);
    }
  }

  function mergeOllamaModels(names: string[]) {
    setOllamaModels(names);
    if (names.length > 0 && !names.includes(s.ollama_model)) {
      patch({ ollama_model: names[0] });
    }
  }

  async function fetchOpenRouterModels(key: string) {
    if (!key) return;
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
      });
      const json = await res.json();
      const names: string[] = (json.data ?? []).map((m: { id: string }) => m.id).sort();
      setOrModels(names);
      if (names.length > 0 && !names.includes(s.openrouter_model)) {
        patch({ openrouter_model: names[0] });
      }
    } catch {
      setOrModels([]);
    }
  }

  async function testConnection() {
    setTestStatus("testing");
    setTestMsg("");
    try {
      if (s.provider === "anthropic") {
        const res = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": s.anthropic_key, "anthropic-version": "2023-06-01" },
        });
        if (res.ok) { setTestStatus("ok"); setTestMsg("Connected"); }
        else { setTestStatus("fail"); setTestMsg(`Error ${res.status}`); }
      } else if (s.provider === "openai") {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${s.openai_key}` },
        });
        if (res.ok) { setTestStatus("ok"); setTestMsg("Connected"); }
        else { setTestStatus("fail"); setTestMsg(`Error ${res.status}`); }
      } else if (s.provider === "ollama") {
        const headers: Record<string, string> = {};
        if (s.ollama_key) headers["Authorization"] = `Bearer ${s.ollama_key}`;
        const res = await fetch(`${s.ollama_base_url.replace(/\/$/, "")}/api/tags`, { headers });
        if (res.ok) { setTestStatus("ok"); setTestMsg("Ollama running"); }
        else { setTestStatus("fail"); setTestMsg("Could not reach Ollama"); }
      } else if (s.provider === "openrouter") {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${s.openrouter_key}` },
        });
        if (res.ok) { setTestStatus("ok"); setTestMsg("Connected"); }
        else { setTestStatus("fail"); setTestMsg(`Error ${res.status}`); }
      }
    } catch (e) {
      setTestStatus("fail");
      setTestMsg(String(e));
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await invoke("save_settings", { settings: s });
      onSave(s);
      onClose();
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  }

  const activeKey = s.provider === "anthropic" ? s.anthropic_key
    : s.provider === "openai" ? s.openai_key
    : s.provider === "openrouter" ? s.openrouter_key
    : "";

  const activeModel = s.provider === "anthropic" ? s.anthropic_model
    : s.provider === "openai" ? s.openai_model
    : s.provider === "ollama" ? s.ollama_model
    : s.openrouter_model;

  const modelList = s.provider === "anthropic" ? ANTHROPIC_MODELS
    : s.provider === "openai" ? OPENAI_MODELS
    : s.provider === "ollama" ? ollamaModels
    : orModels;

  function setActiveKey(val: string) {
    if (s.provider === "anthropic") patch({ anthropic_key: val });
    else if (s.provider === "openai") patch({ openai_key: val });
    else if (s.provider === "openrouter") patch({ openrouter_key: val });
  }

  function setActiveModel(val: string) {
    if (s.provider === "anthropic") patch({ anthropic_model: val });
    else if (s.provider === "openai") patch({ openai_model: val });
    else if (s.provider === "ollama") patch({ ollama_model: val });
    else patch({ openrouter_model: val });
  }

  return (
    <div className="settings-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-modal" onClick={(e) => e.stopPropagation()} ref={modalRef}>

        {/* Header */}
        <div className="settings-header">
          <span className="settings-title">Settings</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            <X style={{ width: 15, height: 15 }} />
          </button>
        </div>

        {/* Tab bar */}
        <div className="settings-tab-bar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`settings-tab${tab === t.id ? " active" : ""}`}
              onClick={() => switchTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── AI tab ── */}
        {tab === "ai" && (
          <div className="settings-body">
            <div className="settings-section">
              <div className="settings-label">Provider</div>
              <div className="provider-tabs">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    className={`provider-tab${s.provider === p.id ? " active" : ""}`}
                    onClick={() => { patch({ provider: p.id }); setShowKey(false); setTestStatus("idle"); }}
                  >
                    {p.label}
                    {s.provider === p.id && initial.provider === p.id && activeKey && (
                      <span className="provider-dot" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {s.provider === "ollama" && (
              <>
                <div className="settings-section">
                  <div className="settings-label">Base URL</div>
                  <input
                    className="settings-input"
                    value={s.ollama_base_url}
                    onChange={(e) => patch({ ollama_base_url: e.target.value })}
                    onBlur={() => fetchOllamaServerModels(s.ollama_base_url)}
                    placeholder="http://localhost:11434"
                  />
                </div>
                <div className="settings-section">
                  <div className="settings-label">
                    API Key <span className="settings-optional">(optional — required for cloud models)</span>
                  </div>
                  <div className="settings-input-wrap">
                    <input
                      className="settings-input"
                      type={showKey ? "text" : "password"}
                      value={s.ollama_key}
                      onChange={(e) => patch({ ollama_key: e.target.value })}
                      placeholder="Leave blank for local Ollama"
                      autoComplete="off"
                    />
                    <button className="settings-eye" onClick={() => setShowKey((v) => !v)}>
                      {showKey ? <EyeOff style={{ width: 13, height: 13 }} /> : <Eye style={{ width: 13, height: 13 }} />}
                    </button>
                  </div>
                </div>
              </>
            )}

            {s.provider !== "ollama" && (
              <div className="settings-section">
                <div className="settings-label">API Key</div>
                <div className="settings-input-wrap">
                  <input
                    className="settings-input"
                    type={showKey ? "text" : "password"}
                    value={activeKey}
                    onChange={(e) => setActiveKey(e.target.value)}
                    onBlur={() => {
                      if (s.provider === "openrouter") fetchOpenRouterModels(s.openrouter_key);
                    }}
                    placeholder={
                      s.provider === "anthropic" ? "sk-ant-…"
                      : s.provider === "openai" ? "sk-…"
                      : "sk-or-…"
                    }
                    autoComplete="off"
                  />
                  <button className="settings-eye" onClick={() => setShowKey((v) => !v)}>
                    {showKey ? <EyeOff style={{ width: 13, height: 13 }} /> : <Eye style={{ width: 13, height: 13 }} />}
                  </button>
                </div>
              </div>
            )}

            <div className="settings-section">
              <div className="settings-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>
                  Model
                  {s.provider === "ollama" && !ollamaScanning && ollamaModels.length > 0 && (
                    <span className="settings-optional"> · {ollamaModels.length} {ollamaSource === "local" ? "local" : "server"} model{ollamaModels.length !== 1 ? "s" : ""}</span>
                  )}
                </span>
                {s.provider === "ollama" && (
                  <button className="ollama-refresh-btn" onClick={scanLocalOllamaModels} disabled={ollamaScanning} title="Scan for models">
                    <RefreshCw style={{ width: 11, height: 11 }} className={ollamaScanning ? "spin" : ""} />
                    {ollamaScanning ? "Scanning…" : "Scan"}
                  </button>
                )}
              </div>
              {ollamaScanning ? (
                <div className="settings-no-models" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Loader style={{ width: 12, height: 12 }} className="spin" />
                  Scanning for local Ollama models…
                </div>
              ) : modelList.length > 0 ? (
                <select className="settings-select" value={activeModel} onChange={(e) => setActiveModel(e.target.value)}>
                  {modelList.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : (
                <div className="settings-no-models">
                  {s.provider === "ollama"
                    ? "No models found — run \"ollama pull <model>\" to install one"
                    : s.provider === "openrouter"
                    ? "Enter your API key to load models"
                    : "No models available"}
                </div>
              )}
            </div>

            <div className="settings-section">
              <button className="settings-test-btn" onClick={testConnection} disabled={testStatus === "testing"}>
                {testStatus === "testing" && <Loader style={{ width: 13, height: 13 }} className="spin" />}
                {testStatus === "ok" && <CheckCircle style={{ width: 13, height: 13, color: "var(--green)" }} />}
                {testStatus === "fail" && <XCircle style={{ width: 13, height: 13, color: "#ff6b6b" }} />}
                {testStatus === "testing" ? "Testing…" : "Test Connection"}
              </button>
              {testMsg && <span className={`settings-test-msg ${testStatus}`}>{testMsg}</span>}
            </div>
          </div>
        )}

        {/* ── Editor tab ── */}
        {tab === "editor" && (
          <div className="settings-body">
            <div className="settings-section">
              <div className="settings-label">Font Family</div>
              <select
                className="settings-select"
                value={s.editor_font_family}
                onChange={(e) => patch({ editor_font_family: e.target.value })}
              >
                {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>

            <div className="settings-section">
              <div className="settings-label">Font Size</div>
              <div className="settings-slider-row">
                <input
                  type="range"
                  className="settings-slider"
                  min={10}
                  max={20}
                  step={1}
                  value={s.editor_font_size}
                  onChange={(e) => patch({ editor_font_size: Number(e.target.value) })}
                />
                <span className="settings-slider-value">{s.editor_font_size}px</span>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-label">Options</div>
              <div className="settings-toggles">
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={s.editor_word_wrap}
                    onChange={(e) => patch({ editor_word_wrap: e.target.checked })}
                  />
                  <span className="settings-toggle-track" />
                  <span className="settings-toggle-label">Word wrap</span>
                </label>
                <label className="settings-toggle">
                  <input
                    type="checkbox"
                    checked={s.editor_line_numbers}
                    onChange={(e) => patch({ editor_line_numbers: e.target.checked })}
                  />
                  <span className="settings-toggle-track" />
                  <span className="settings-toggle-label">Line numbers</span>
                </label>
              </div>
            </div>
          </div>
        )}

        {/* ── Keybinds tab ── */}
        {tab === "keybinds" && (
          <div className="settings-body">
            <div className="settings-section">
              <div className="settings-label">SQL Editor</div>
              <div className="settings-kb-list">
                <KbRow label="Run query" hint="Execute the current SQL">
                  <select
                    className="settings-select settings-select-sm"
                    value={s.run_query_key}
                    onChange={(e) => patch({ run_query_key: e.target.value as AISettings["run_query_key"] })}
                  >
                    <option value="CmdEnter">⌘ Cmd + ↵ Enter</option>
                    <option value="F5">F5</option>
                    <option value="ShiftEnter">⇧ Shift + ↵ Enter</option>
                  </select>
                </KbRow>
                <KbRow label="History back" hint="Previous executed query">
                  <select
                    className="settings-select settings-select-sm"
                    value={s.history_modifier}
                    onChange={(e) => patch({ history_modifier: e.target.value as AISettings["history_modifier"] })}
                  >
                    <option value="Alt">⌥ Option + ↑</option>
                    <option value="Ctrl">⌃ Ctrl + ↑</option>
                    <option value="Shift">⇧ Shift + ↑</option>
                  </select>
                </KbRow>
                <KbRow label="History forward" hint="Next executed query (same modifier + ↓)" >
                  <span className="settings-kb-derived">Same modifier + ↓</span>
                </KbRow>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-label">Chat</div>
              <div className="settings-kb-list">
                <KbRow label="Send message" hint="Submit the chat input">
                  <select
                    className="settings-select settings-select-sm"
                    value={s.chat_send_key}
                    onChange={(e) => patch({ chat_send_key: e.target.value as AISettings["chat_send_key"] })}
                  >
                    <option value="CmdEnter">⌘ Cmd + ↵ Enter</option>
                    <option value="ShiftEnter">⇧ Shift + ↵ Enter</option>
                  </select>
                </KbRow>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-label">Transactions</div>
              <div className="settings-kb-list">
                <KbRow label="Begin transaction" hint="Open a new transaction">
                  <select
                    className="settings-select settings-select-sm"
                    value={s.tx_begin_key}
                    onChange={(e) => patch({ tx_begin_key: e.target.value as AISettings["tx_begin_key"] })}
                  >
                    <option value="CmdShiftB">⌘⇧B</option>
                    <option value="CmdShiftT">⌘⇧T</option>
                    <option value="F6">F6</option>
                  </select>
                </KbRow>
                <KbRow label="Commit" hint="Commit the active transaction">
                  <select
                    className="settings-select settings-select-sm"
                    value={s.tx_commit_key}
                    onChange={(e) => patch({ tx_commit_key: e.target.value as AISettings["tx_commit_key"] })}
                  >
                    <option value="CmdShiftK">⌘⇧K</option>
                    <option value="CmdShiftC">⌘⇧C</option>
                    <option value="F7">F7</option>
                  </select>
                </KbRow>
                <KbRow label="Rollback" hint="Roll back the active transaction">
                  <select
                    className="settings-select settings-select-sm"
                    value={s.tx_rollback_key}
                    onChange={(e) => patch({ tx_rollback_key: e.target.value as AISettings["tx_rollback_key"] })}
                  >
                    <option value="CmdShiftZ">⌘⇧Z</option>
                    <option value="F8">F8</option>
                  </select>
                </KbRow>
              </div>
            </div>
          </div>
        )}

        {/* ── Theme tab ── */}
        {tab === "theme" && (
          <div className="settings-body">
            <div className="settings-section">
              <div className="settings-label">Color theme</div>
              <div className="theme-grid">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    className={`theme-card${theme === t.id ? " active" : ""}`}
                    onClick={() => onThemeChange(t.id)}
                    aria-pressed={theme === t.id}
                  >
                    <div className="theme-preview" style={{ background: t.preview.bg }}>
                      <div className="theme-preview-bar" style={{ background: t.preview.surface, borderColor: t.preview.surface }}>
                        <span className="theme-preview-dot" style={{ background: t.preview.accent }} />
                        <span className="theme-preview-dot" style={{ background: t.preview.accent, opacity: 0.5 }} />
                      </div>
                      <div className="theme-preview-content">
                        <span className="theme-preview-line" style={{ background: t.preview.text, opacity: 0.85, width: "60%" }} />
                        <span className="theme-preview-line" style={{ background: t.preview.text, opacity: 0.4, width: "40%" }} />
                        <span className="theme-preview-accent-pill" style={{ background: t.preview.accent }} />
                      </div>
                    </div>
                    <div className="theme-card-label">{t.label}</div>
                    <div className="theme-card-desc">{t.description}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="settings-footer">
          <button className="settings-cancel" onClick={onClose}>Cancel</button>
          <button className="settings-save" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

      </div>
    </div>
  );
}
