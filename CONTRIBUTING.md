# Contributing to QuaryLite

Thanks for taking the time to contribute!

---

## Build locally

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

The output is in `src-tauri/target/release/bundle/`.

---

## File a bug

Use the [Bug report](.github/ISSUE_TEMPLATE/bug_report.md) issue template. Include:

- OS and version
- Steps to reproduce
- What you expected vs. what happened
- Any error messages from the app or the browser devtools console (`View → Toggle Developer Tools`)

---

## Propose a feature

Use the [Feature request](.github/ISSUE_TEMPLATE/feature_request.md) issue template. Describe the problem you're trying to solve, not just the solution — it helps narrow down the best approach.

---

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make your change. Keep commits focused; one logical change per commit.
3. Test your change locally with `npm run tauri dev`.
4. Open a PR against `main` with a clear description of what and why.

PRs that touch security-sensitive code (SQL execution, keychain, file paths, AI output rendering) will be reviewed more carefully — please explain your reasoning in the PR description.

---

## Code style

- Frontend: TypeScript + React. Run `npx tsc --noEmit` before opening a PR.
- Backend: Rust. Run `cargo clippy` and `cargo fmt` before opening a PR.
- No new `unwrap()` calls in `lib.rs` — use the `lock_tx` helper or explicit `match`.

---

## License

By contributing you agree your work is released under the [MIT License](LICENSE).
