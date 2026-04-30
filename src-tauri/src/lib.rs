use rusqlite::Connection;
use serde::{Serialize, Deserialize};
use std::path::Path;
use std::sync::Mutex;
use tauri_plugin_store::StoreExt;
use keyring::Entry;

struct TxState(Mutex<Option<Connection>>);

const KEYRING_SERVICE: &str = "querylite";

fn keyring_set(account: &str, value: &str) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, account).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())
}

fn keyring_get(account: &str) -> String {
    Entry::new(KEYRING_SERVICE, account)
        .ok()
        .and_then(|e| e.get_password().ok())
        .unwrap_or_default()
}



fn validate_table_name(conn: &Connection, table: &str) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','view') AND name = ?1",
            rusqlite::params![table],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false);
    if exists {
        Ok(())
    } else {
        Err(format!("Unknown table: {}", table))
    }
}

#[derive(Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub col_type: String,
    pub not_null: bool,
    pub pk: bool,
}

#[derive(Serialize)]
pub struct TableInfo {
    pub name: String,
    pub columns: Vec<ColumnInfo>,
    pub row_count: i64,
}

#[derive(Serialize)]
pub struct ViewInfo {
    pub name: String,
    pub sql: String,
}

#[derive(Serialize)]
pub struct IndexInfo {
    pub name: String,
    pub table_name: String,
    pub unique: bool,
    pub columns: Vec<String>,
}

#[derive(Serialize)]
pub struct DbSchema {
    pub file_name: String,
    pub file_path: String,
    pub file_size_mb: f64,
    pub sqlite_version: String,
    pub tables: Vec<TableInfo>,
    pub views: Vec<ViewInfo>,
    pub indexes: Vec<IndexInfo>,
}

fn fetch_views(conn: &Connection) -> Result<Vec<ViewInfo>, String> {
    let mut stmt = conn
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='view' ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows: Vec<ViewInfo> = stmt
        .query_map([], |row| {
            Ok(ViewInfo {
                name: row.get(0)?,
                sql: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

fn fetch_index_names(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

fn fetch_indexes(conn: &Connection) -> Result<Vec<IndexInfo>, String> {
    let idx_rows = fetch_index_names(conn)?;
    let mut result = Vec::new();
    for (idx_name, tbl_name) in idx_rows {
        let columns = fetch_index_columns(conn, &idx_name)?;
        let unique = fetch_index_unique(conn, &tbl_name, &idx_name)?;
        result.push(IndexInfo { name: idx_name, table_name: tbl_name, unique, columns });
    }
    Ok(result)
}

fn fetch_index_columns(conn: &Connection, idx_name: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA index_info(\"{}\")", idx_name))
        .map_err(|e| e.to_string())?;
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(2))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(cols)
}

fn fetch_index_unique(conn: &Connection, tbl_name: &str, idx_name: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA index_list(\"{}\")", tbl_name))
        .map_err(|e| e.to_string())?;
    let pairs: Vec<(String, bool)> = stmt
        .query_map([], |row| Ok((row.get::<_, String>(1)?, row.get::<_, i32>(2)? != 0)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(pairs.into_iter().find(|(n, _)| n == idx_name).map(|(_, u)| u).unwrap_or(false))
}

#[tauri::command]
fn open_database(path: String) -> Result<DbSchema, String> {
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;

    let file_name = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown.db")
        .to_string();

    let file_size_mb = std::fs::metadata(&path)
        .map(|m| m.len() as f64 / 1_048_576.0)
        .unwrap_or(0.0);

    let sqlite_version: String = conn
        .query_row("SELECT sqlite_version()", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|e| e.to_string())?;

    let table_names: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut tables = Vec::new();

    for table_name in table_names {
        let mut col_stmt = conn
            .prepare(&format!("PRAGMA table_info(\"{}\")", table_name))
            .map_err(|e| e.to_string())?;

        let columns: Vec<ColumnInfo> = col_stmt
            .query_map([], |row| {
                Ok(ColumnInfo {
                    name: row.get(1)?,
                    col_type: row.get::<_, String>(2).unwrap_or_default(),
                    not_null: row.get::<_, i32>(3).unwrap_or(0) != 0,
                    pk: row.get::<_, i32>(5).unwrap_or(0) != 0,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        tables.push(TableInfo {
            name: table_name,
            columns,
            row_count: -1, // populated lazily via load_row_counts
        });
    }

    let views = fetch_views(&conn).unwrap_or_default();
    let indexes = fetch_indexes(&conn).unwrap_or_default();

    Ok(DbSchema {
        file_name,
        file_path: path,
        file_size_mb,
        sqlite_version,
        tables,
        views,
        indexes,
    })
}

#[tauri::command]
fn load_row_counts(path: String) -> Result<std::collections::HashMap<String, i64>, String> {
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;

    let table_names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    if table_names.is_empty() {
        return Ok(std::collections::HashMap::new());
    }

    // One UNION ALL query — single round-trip for all counts
    let union_sql = table_names
        .iter()
        .map(|t| format!("SELECT '{}' AS name, COUNT(*) AS cnt FROM \"{}\"",
            t.replace('\'', "''"), t))
        .collect::<Vec<_>>()
        .join(" UNION ALL ");

    let mut stmt = conn.prepare(&union_sql).map_err(|e| e.to_string())?;
    let counts = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(counts)
}

#[tauri::command]
fn get_table_preview(path: String, table: String) -> Result<Vec<serde_json::Value>, String> {
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    validate_table_name(&conn, &table)?;

    let query = format!("SELECT * FROM \"{}\" LIMIT 3", table);
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;

    let col_count = stmt.column_count();
    let col_names: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("col").to_string())
        .collect();

    let rows: Vec<serde_json::Value> = stmt
        .query_map([], |row| {
            let mut obj = serde_json::Map::new();
            for (i, name) in col_names.iter().enumerate() {
                let val: serde_json::Value = match row.get_ref(i) {
                    Ok(rusqlite::types::ValueRef::Null) => serde_json::Value::Null,
                    Ok(rusqlite::types::ValueRef::Integer(n)) => serde_json::Value::Number(n.into()),
                    Ok(rusqlite::types::ValueRef::Real(f)) => {
                        serde_json::Number::from_f64(f)
                            .map(serde_json::Value::Number)
                            .unwrap_or(serde_json::Value::Null)
                    }
                    Ok(rusqlite::types::ValueRef::Text(s)) => {
                        serde_json::Value::String(String::from_utf8_lossy(s).into_owned())
                    }
                    Ok(rusqlite::types::ValueRef::Blob(_)) => serde_json::Value::String("[blob]".into()),
                    Err(_) => serde_json::Value::Null,
                };
                obj.insert(name.clone(), val);
            }
            Ok(serde_json::Value::Object(obj))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

#[derive(Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub rows_affected: i64,
    pub elapsed_ms: f64,
}

fn check_sql_safety(sql: &str) -> Result<(), String> {
    let upper = sql.to_uppercase();
    let denied = [
        "ATTACH DATABASE", "ATTACH ", "DETACH DATABASE",
        "PRAGMA WRITABLE_SCHEMA", "LOAD_EXTENSION", "LOAD EXTENSION",
    ];
    for pattern in &denied {
        if upper.contains(pattern) {
            return Err(format!("Blocked: '{}' is not permitted for security reasons.", pattern.trim()));
        }
    }
    Ok(())
}

fn run_query_on_conn(conn: &Connection, sql: &str) -> Result<QueryResult, String> {
    check_sql_safety(sql)?;
    let start = std::time::Instant::now();
    let trimmed = sql.trim().to_uppercase();
    let is_select = trimmed.starts_with("SELECT") || trimmed.starts_with("WITH") || trimmed.starts_with("EXPLAIN");

    if is_select {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let col_count = stmt.column_count();
        let columns: Vec<String> = (0..col_count)
            .map(|i| stmt.column_name(i).unwrap_or("col").to_string())
            .collect();

        let rows: Vec<Vec<serde_json::Value>> = stmt
            .query_map([], |row| {
                let cells = (0..col_count)
                    .map(|i| match row.get_ref(i) {
                        Ok(rusqlite::types::ValueRef::Null) => serde_json::Value::Null,
                        Ok(rusqlite::types::ValueRef::Integer(n)) => serde_json::Value::Number(n.into()),
                        Ok(rusqlite::types::ValueRef::Real(f)) => {
                            serde_json::Number::from_f64(f)
                                .map(serde_json::Value::Number)
                                .unwrap_or(serde_json::Value::Null)
                        }
                        Ok(rusqlite::types::ValueRef::Text(s)) => {
                            serde_json::Value::String(String::from_utf8_lossy(s).into_owned())
                        }
                        Ok(rusqlite::types::ValueRef::Blob(_)) => serde_json::Value::String("[blob]".into()),
                        Err(_) => serde_json::Value::Null,
                    })
                    .collect();
                Ok(cells)
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        Ok(QueryResult { columns, rows, rows_affected: 0, elapsed_ms })
    } else {
        let rows_affected = conn.execute(sql, []).map_err(|e| e.to_string())? as i64;
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        Ok(QueryResult { columns: vec![], rows: vec![], rows_affected, elapsed_ms })
    }
}

fn lock_tx<'a>(state: &'a tauri::State<'a, TxState>) -> std::sync::MutexGuard<'a, Option<Connection>> {
    match state.0.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

#[tauri::command]
fn execute_query(state: tauri::State<TxState>, path: String, sql: String) -> Result<QueryResult, String> {
    let guard = lock_tx(&state);
    if let Some(ref conn) = *guard {
        run_query_on_conn(conn, &sql)
    } else {
        drop(guard);
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(30)).map_err(|e| e.to_string())?;
        run_query_on_conn(&conn, &sql)
    }
}

#[tauri::command]
fn begin_transaction(state: tauri::State<TxState>, path: String) -> Result<(), String> {
    let mut guard = lock_tx(&state);
    if guard.is_some() {
        return Err("A transaction is already active. Commit or roll back first.".into());
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(30)).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys=ON; BEGIN;").map_err(|e| e.to_string())?;
    *guard = Some(conn);
    Ok(())
}

#[tauri::command]
fn commit_transaction(state: tauri::State<TxState>) -> Result<(), String> {
    let mut guard = lock_tx(&state);
    let conn = guard.take().ok_or("No active transaction to commit.")?;
    conn.execute_batch("COMMIT;").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn rollback_transaction(state: tauri::State<TxState>) -> Result<(), String> {
    let mut guard = lock_tx(&state);
    let conn = guard.take().ok_or("No active transaction to roll back.")?;
    conn.execute_batch("ROLLBACK;").map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
pub struct TableData {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub total: i64,
}

#[tauri::command]
fn get_table_data(path: String, table: String, limit: i64, offset: i64) -> Result<TableData, String> {
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    validate_table_name(&conn, &table)?;

    let total: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM \"{}\"", table), [], |r| r.get(0))
        .unwrap_or(0);

    let query = format!("SELECT * FROM \"{}\" LIMIT {} OFFSET {}", table, limit, offset);
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;

    let col_count = stmt.column_count();
    let columns: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("col").to_string())
        .collect();

    let rows: Vec<Vec<serde_json::Value>> = stmt
        .query_map([], |row| {
            let cells: Vec<serde_json::Value> = (0..col_count)
                .map(|i| match row.get_ref(i) {
                    Ok(rusqlite::types::ValueRef::Null) => serde_json::Value::Null,
                    Ok(rusqlite::types::ValueRef::Integer(n)) => serde_json::Value::Number(n.into()),
                    Ok(rusqlite::types::ValueRef::Real(f)) => {
                        serde_json::Number::from_f64(f)
                            .map(serde_json::Value::Number)
                            .unwrap_or(serde_json::Value::Null)
                    }
                    Ok(rusqlite::types::ValueRef::Text(s)) => {
                        serde_json::Value::String(String::from_utf8_lossy(s).into_owned())
                    }
                    Ok(rusqlite::types::ValueRef::Blob(_)) => serde_json::Value::String("[blob]".into()),
                    Err(_) => serde_json::Value::Null,
                })
                .collect();
            Ok(cells)
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(TableData { columns, rows, total })
}

#[derive(Serialize)]
pub struct FkEdge {
    pub from_table: String,
    pub from_col: String,
    pub to_table: String,
    pub to_col: String,
}

#[derive(Serialize)]
pub struct SchemaGraph {
    pub tables: Vec<TableInfo>,
    pub edges: Vec<FkEdge>,
}

#[tauri::command]
fn get_schema_graph(path: String) -> Result<SchemaGraph, String> {
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .map_err(|e| e.to_string())?;

    let table_names: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut tables = Vec::new();
    let mut edges = Vec::new();

    for table_name in &table_names {
        let mut col_stmt = conn
            .prepare(&format!("PRAGMA table_info(\"{}\")", table_name))
            .map_err(|e| e.to_string())?;

        let columns: Vec<ColumnInfo> = col_stmt
            .query_map([], |row| {
                Ok(ColumnInfo {
                    name: row.get(1)?,
                    col_type: row.get::<_, String>(2).unwrap_or_default(),
                    not_null: row.get::<_, i32>(3).unwrap_or(0) != 0,
                    pk: row.get::<_, i32>(5).unwrap_or(0) != 0,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let row_count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM \"{}\"", table_name), [], |r| r.get(0))
            .unwrap_or(0);

        tables.push(TableInfo { name: table_name.clone(), columns, row_count });

        let mut fk_stmt = conn
            .prepare(&format!("PRAGMA foreign_key_list(\"{}\")", table_name))
            .map_err(|e| e.to_string())?;

        let fks: Vec<FkEdge> = fk_stmt
            .query_map([], |row| {
                Ok(FkEdge {
                    from_table: table_name.clone(),
                    from_col: row.get(3)?,
                    to_table: row.get(2)?,
                    to_col: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        edges.extend(fks);
    }

    Ok(SchemaGraph { tables, edges })
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AISettings {
    pub provider: String,
    pub anthropic_key: String,
    pub openai_key: String,
    pub openrouter_key: String,
    pub ollama_base_url: String,
    pub ollama_key: String,
    pub anthropic_model: String,
    pub openai_model: String,
    pub ollama_model: String,
    pub openrouter_model: String,
    #[serde(default = "default_editor_font_size")]
    pub editor_font_size: u32,
    #[serde(default = "default_editor_font_family")]
    pub editor_font_family: String,
    #[serde(default = "default_true")]
    pub editor_word_wrap: bool,
    #[serde(default = "default_true")]
    pub editor_line_numbers: bool,
    #[serde(default = "default_history_modifier")]
    pub history_modifier: String,
    #[serde(default = "default_run_query_key")]
    pub run_query_key: String,
    #[serde(default = "default_chat_send_key")]
    pub chat_send_key: String,
    #[serde(default = "default_tx_begin_key")]
    pub tx_begin_key: String,
    #[serde(default = "default_tx_commit_key")]
    pub tx_commit_key: String,
    #[serde(default = "default_tx_rollback_key")]
    pub tx_rollback_key: String,
}

fn default_editor_font_size() -> u32 { 13 }
fn default_editor_font_family() -> String { "JetBrains Mono".into() }
fn default_true() -> bool { true }
fn default_history_modifier() -> String { "Alt".into() }
fn default_run_query_key() -> String { "CmdEnter".into() }
fn default_chat_send_key() -> String { "CmdEnter".into() }
fn default_tx_begin_key() -> String { "CmdShiftB".into() }
fn default_tx_commit_key() -> String { "CmdShiftK".into() }
fn default_tx_rollback_key() -> String { "CmdShiftZ".into() }

impl Default for AISettings {
    fn default() -> Self {
        Self {
            provider: "anthropic".into(),
            anthropic_key: String::new(),
            openai_key: String::new(),
            openrouter_key: String::new(),
            ollama_base_url: "http://localhost:11434".into(),
            ollama_key: String::new(),
            anthropic_model: "claude-sonnet-4-6".into(),
            openai_model: "gpt-4o".into(),
            ollama_model: String::new(),
            openrouter_model: String::new(),
            editor_font_size: 13,
            editor_font_family: "JetBrains Mono".into(),
            editor_word_wrap: true,
            editor_line_numbers: true,
            history_modifier: "Alt".into(),
            run_query_key: "CmdEnter".into(),
            chat_send_key: "CmdEnter".into(),
            tx_begin_key: "CmdShiftB".into(),
            tx_commit_key: "CmdShiftK".into(),
            tx_rollback_key: "CmdShiftZ".into(),
        }
    }
}

#[tauri::command]
fn list_ollama_models() -> Result<Vec<String>, String> {
    let output = std::process::Command::new("ollama")
        .arg("list")
        .output()
        .map_err(|_| "ollama not found — is it installed?".to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let models: Vec<String> = stdout
        .lines()
        .skip(1) // skip header row
        .filter_map(|line| {
            let name = line.split_whitespace().next()?;
            if name.is_empty() { None } else { Some(name.to_string()) }
        })
        .collect();

    Ok(models)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: AISettings) -> Result<(), String> {
    // Store API keys in OS keychain, not on disk
    keyring_set("anthropic_key", &settings.anthropic_key)?;
    keyring_set("openai_key", &settings.openai_key)?;
    keyring_set("openrouter_key", &settings.openrouter_key)?;
    keyring_set("ollama_key", &settings.ollama_key)?;

    let mut safe = settings.clone();
    safe.anthropic_key = String::new();
    safe.openai_key = String::new();
    safe.openrouter_key = String::new();
    safe.ollama_key = String::new();

    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    store.set("ai", serde_json::to_value(&safe).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<AISettings, String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    let mut settings: AISettings = match store.get("ai") {
        Some(val) => {
            let mut s: AISettings = serde_json::from_value(val).map_err(|e| e.to_string())?;
            // Migration: if keys still in JSON (old version), move to keychain
            if !s.anthropic_key.is_empty() { let _ = keyring_set("anthropic_key", &s.anthropic_key); s.anthropic_key = String::new(); }
            if !s.openai_key.is_empty() { let _ = keyring_set("openai_key", &s.openai_key); s.openai_key = String::new(); }
            if !s.openrouter_key.is_empty() { let _ = keyring_set("openrouter_key", &s.openrouter_key); s.openrouter_key = String::new(); }
            if !s.ollama_key.is_empty() { let _ = keyring_set("ollama_key", &s.ollama_key); s.ollama_key = String::new(); }
            s
        }
        None => AISettings::default(),
    };

    // Load keys from keychain
    settings.anthropic_key = keyring_get("anthropic_key");
    settings.openai_key = keyring_get("openai_key");
    settings.openrouter_key = keyring_get("openrouter_key");
    settings.ollama_key = keyring_get("ollama_key");

    Ok(settings)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SerializedMessage {
    pub id: String,
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SavedConversation {
    pub id: String,
    pub title: String,
    pub db_path: String,
    pub db_name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: Vec<SerializedMessage>,
}

#[tauri::command]
fn save_query_history(app: tauri::AppHandle, entries: Vec<String>) -> Result<(), String> {
    let store = app.store("query_history.json").map_err(|e| e.to_string())?;
    store.set("entries", serde_json::to_value(&entries).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_query_history(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let store = app.store("query_history.json").map_err(|e| e.to_string())?;
    let entries = store
        .get("entries")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    Ok(entries)
}

#[tauri::command]
fn save_conversation(app: tauri::AppHandle, conv: SavedConversation) -> Result<(), String> {
    let store = app.store("conversations.json").map_err(|e| e.to_string())?;
    store.set(conv.id.clone(), serde_json::to_value(&conv).map_err(|e| e.to_string())?);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_conversations(app: tauri::AppHandle) -> Result<Vec<SavedConversation>, String> {
    let store = app.store("conversations.json").map_err(|e| e.to_string())?;
    let mut convs: Vec<SavedConversation> = store
        .keys()
        .into_iter()
        .filter_map(|k| {
            store.get(&k).and_then(|v| serde_json::from_value(v).ok())
        })
        .collect();
    convs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(convs)
}

#[tauri::command]
fn delete_conversation(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let store = app.store("conversations.json").map_err(|e| e.to_string())?;
    store.delete(id);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn save_png_file(app: tauri::AppHandle, data: String) -> Result<bool, String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use tauri_plugin_dialog::DialogExt;

    let bytes = STANDARD.decode(&data).map_err(|e| e.to_string())?;

    let path = app.dialog()
        .file()
        .add_filter("PNG Image", &["png"])
        .set_file_name("schema-diagram.png")
        .blocking_save_file();

    match path {
        Some(p) => {
            let path_buf = p.as_path().ok_or("Invalid path")?.to_path_buf();
            std::fs::write(&path_buf, &bytes).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TxState(Mutex::new(None)))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            open_database, load_row_counts, get_table_preview, get_table_data, execute_query,
            get_schema_graph, save_settings, load_settings, list_ollama_models,
            save_query_history, load_query_history,
            save_conversation, load_conversations, delete_conversation,
            begin_transaction, commit_transaction, rollback_transaction,
            save_png_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
