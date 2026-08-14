# 🛠️ tool-selector: Tool Status Inspector for Pi

`tool-selector` is a native [Pi coding agent](https://pi.dev) extension that provides tool visibility and status inspection.

---

## ✨ Features

- **Tool Status Inspection**: Lists all registered tools (built-in, SDK, extension, and MCP tools) and displays whether each tool is currently active or inactive in the active session.

---

## 🚀 Commands

| Command  | Description                                                                        |
| -------- | ---------------------------------------------------------------------------------- |
| `/tools` | Display active and inactive status for all available tools in the current session. |

---

## 📦 Installation

To load `tool-selector` in Pi, add `extensions/tool-selector` to your workspace extension list, or try it directly from the repository root:

```bash
pi -e ./extensions/tool-selector
```
