# pi-processes

Standalone background process supervision for Pi. `process_start` handles retained services and finite commands explicitly requested to run in the background. Use `bash` for foreground one-shot commands.

## Tools

- `process_start`
- `process_list`
- `process_snapshot`
- `process_restart`
- `process_stop`

`process_snapshot` returns the newest 100 lines by default. Pass `lines` for a larger window, or pass the returned `before` value to read older retained lines. Results are capped at 2,000 lines or 50 KB.

Use `/processes` to open the full-screen process dashboard. Select a process to open its detail view.
