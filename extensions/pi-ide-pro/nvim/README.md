# Pi IDE Pro for Neovim

This dependency-free Lua companion connects Neovim to the `pi-ide-pro` Pi extension.

## Requirements

- Neovim 0.11 or newer
- A local `file:` workspace

## Lazy.nvim installation

```lua
---@type LazySpec
return {
  dir = vim.fs.joinpath(vim.fn.expand "~", ".pi", "agent", "extensions", "pi-ide-pro", "nvim"),
  name = "pi-ide-pro",
  lazy = false,
}
```

The companion starts with Neovim, listens only on `127.0.0.1`, authenticates Pi with a per-process token, and writes connection metadata to `~/.pi/pi-ide-pro/lock/`.

## Features

- Live visual-selection context
- Open-buffer autocomplete in Pi
- Neovim diagnostics in `/ide problems`
- File navigation from Pi
- Multiple Pi sessions in one workspace

The plugin uses `vim.uv`, `vim.json`, and `vim.diagnostic`. It has no external plugin dependencies.
