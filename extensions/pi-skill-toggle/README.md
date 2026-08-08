# 🎛️ pi-skill-toggle — Skill Invocation Toggle for Pi

`pi-skill-toggle` is a native [Pi coding agent](https://pi.dev) extension that lets you interactively toggle whether skills are agent-invocable or manual-only.

---

## ✨ Features

- **Interactive Skill Management**: View all discovered skills (global, project, and packages) in an interactive checklist UI via `/toggle-skills`.
- **Invocation Mode Control**: Toggle skills between agent-invocable (available to the AI model automatically) and manual-only (user-triggered).
- **Atomic Frontmatter Patching**: Safely updates `SKILL.md` YAML frontmatter metadata without corrupting skill instructions or existing fields.

---

## 🚀 Commands

| Command          | Description                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `/toggle-skills` | Open the interactive skill toggle menu to enable or disable automatic agent invocation for skills. |

---

## 📦 Installation

To load `pi-skill-toggle` in Pi, add `extensions/pi-skill-toggle` to your workspace extension list, or try it directly from the repository root:

```bash
pi -e ./extensions/pi-skill-toggle
```
