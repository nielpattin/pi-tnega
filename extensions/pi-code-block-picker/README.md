# 📋 pi-code-block-picker: Conversation Code Block Selector for Pi

`pi-code-block-picker` is a native [Pi coding agent](https://pi.dev) extension that extracts code blocks from session history and lets you fuzzy search and copy them directly to your clipboard.

---

## ✨ Features

- **Code Block Extraction**: Parses and extracts code blocks from previous assistant and user turns.
- **Fuzzy Search & Selector**: Filter code blocks by language or content preview using a TUI picker.
- **Cross-Platform Clipboard**: Copies code terminal-safely via OSC 52, `pbcopy` (macOS), `clip` (Windows), `xclip`/`wl-copy` (Linux), and `termux-clipboard-set`.
- **Keyboard Shortcut**: Press `Ctrl+Shift+Y` or type `/codeblocks` to launch the picker anywhere in a session.

---

## 🚀 Commands & Shortcuts

| Command / Shortcut | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| `/codeblocks`      | Open the interactive code block picker for the current session. |
| `Ctrl+Shift+Y`     | Global keybinding shortcut to open the code block picker.       |

---

## 📦 Installation

To load `pi-code-block-picker` in Pi, add `extensions/pi-code-block-picker` to your workspace extension list, or try it directly from the repository root:

```bash
pi -e ./extensions/pi-code-block-picker
```
