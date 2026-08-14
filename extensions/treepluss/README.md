# 🌳 treepluss: Enhanced Session Tree Component for Pi

`treepluss` is a native [Pi coding agent](https://pi.dev) extension that enhances session tree visualization and interactive TUI turn rendering.

---

## ✨ Features

- **Enhanced Conversation Tree Rendering**: Upgrades default conversation branch visualization with clean structural tree guides and indicators.
- **Native Component Interception**: Patches interactive mode turn components (`AssistantMessageComponent`, `ToolExecutionComponent`, `UserMessageComponent`, `CompactionSummaryMessageComponent`) to maintain visual alignment across branching sessions.
- **Clean Lifecycle Cleanup**: Automatically unpatches TUI components on session shutdown (`session_shutdown`).

---

## 📦 Installation

To load `treepluss` in Pi, add `extensions/treepluss` to your workspace extension list, or try it directly from the repository root:

```bash
pi -e ./extensions/treepluss
```
