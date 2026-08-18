# Pi IDE Pro for VS Code

This companion extension connects a local VS Code workspace to the `pi-ide-pro` Pi extension.

Connection retry test.

## Local installation

From the repository root, build the VSIX and install it:

```text
pnpm package
code --install-extension extensions/pi-ide-pro/dist/pi-ide-pro.vsix
```

The same `pnpm package` command works from `extensions/pi-ide-pro/`.

Select **Pi IDE Pro** in the Output panel to view connection and error logs.

The extension listens on localhost, authenticates Pi with a per-window token, and writes connection metadata to `~/.pi/pi-ide-pro/lock/`.
