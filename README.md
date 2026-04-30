# QuaryLite

**A fast, open-source SQLite IDE with AI-powered SQL generation.**

Browse tables, run queries, explore schema relationships, manage transactions, and ask an AI assistant to write SQL — all in a native desktop app.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](#install)

---

## Features

- **SQL Editor** — Monaco-based editor with syntax highlighting, query history, and configurable keybinds
- **AI SQL Assistant** — Ask questions in plain English; the AI writes and runs the SQL. Supports Anthropic, OpenAI, OpenRouter, and local Ollama models
- **Table Explorer** — Browse rows with pagination, column sorting, and full-text search
- **Schema Graph** — Visual relationship diagram of all tables and foreign keys, exportable as PNG
- **Transactions** — Begin, commit, and roll back transactions with a keyboard shortcut; the entire app border glows amber while a transaction is active
- **Conversation History** — AI chats are saved and can be reloaded across sessions
- **Bring Your Own Key** — API keys are stored in the OS keychain, never on disk

---

## Install

Download the latest release for your platform from the [Releases](../../releases) page.

| Platform | File |
|----------|------|
| macOS | `.dmg` |
| Windows | `.msi` |
| Linux | `.AppImage` or `.deb` |

> **macOS:** Apple will show a Gatekeeper warning because the app is not yet notarized. Right-click the `.dmg` → **Open** → **Open** to bypass it.
>
> **Windows:** SmartScreen may warn on first run. Click **More info** → **Run anyway**.

---

## Build from source

**Prerequisites:** [Rust](https://rustup.rs), [Node.js 18+](https://nodejs.org), the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/querylite/querylite
cd querylite
npm install
npm run tauri dev
```

To produce a release build:

```bash
npm run tauri build
```

---

## Keyboard shortcuts

| Action | Default |
|--------|---------|
| Run query | `⌘ Enter` |
| Send chat message | `⌘ Enter` |
| Navigate query history | `Alt ↑ / Alt ↓` |
| Begin transaction | `⌘ Shift B` |
| Commit transaction | `⌘ Shift K` |
| Roll back transaction | `⌘ Shift Z` |

All shortcuts are configurable in **Settings → Keybinds**.

---

## AI providers

Configure your provider in **Settings → AI**.

| Provider | Notes |
|----------|-------|
| Anthropic | Claude models — recommended |
| OpenAI | GPT-4o and others |
| OpenRouter | Access many models with one key |
| Ollama | Fully local, no API key needed |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to build locally, report bugs, and propose features.

---

## License

[MIT](LICENSE) © 2026 QuaryLite
