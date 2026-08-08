# ❓ ask-user — Multiple-Choice Question Tool for Pi

`ask-user` is a native [Pi coding agent](https://pi.dev) extension that gives the AI model the ability to ask the user structured, multiple-choice questions during a session.

---

## ✨ Features

- **Interactive Multiple-Choice Popup**: Presents 2 to 5 model-provided choices with labels and descriptions.
- **Custom Response Option**: Includes an automatic "Write my own answer" option for freeform text input.
- **TUI Controls**: Simple keyboard navigation using arrow keys or number shortcuts (1–5) and `Enter` to confirm.
- **Graceful Cancellation**: Dismiss questions using `Esc` (notifies the model that the user declined to answer).

---

## 🛠️ Tools

| Tool       | Purpose                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- |
| `ask_user` | Prompt the user with a question and 2 to 5 multiple-choice options (plus custom text input). |

---

## 📦 Installation

To use `ask-user` in Pi, add `extensions/ask-user` to your workspace extension list, or try it directly from the repository root:

```bash
pi -e ./extensions/ask-user
```
