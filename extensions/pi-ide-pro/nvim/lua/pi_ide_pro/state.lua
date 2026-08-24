local M = {}

local function absolute_path(path)
  if path == "" then
    return nil
  end
  return vim.fs.normalize(vim.fn.fnamemodify(path, ":p"))
end

local function comparable(path)
  return vim.fs.normalize(path):gsub("\\", "/"):gsub("/$", ""):lower()
end

local function is_inside(parent, child)
  parent = comparable(parent)
  child = comparable(child)
  return child == parent or child:sub(1, #parent + 1) == parent .. "/"
end

function M.workspace_root(path)
  path = absolute_path(path or vim.fn.getcwd()) or vim.fn.getcwd()
  local marker = vim.fs.find({ ".git", "pnpm-workspace.yaml" }, { path = path, upward = true })[1]
  if marker then
    return vim.fs.dirname(marker)
  end
  return absolute_path(vim.fn.getcwd())
end

function M.workspace_for(file_path, workspace_root)
  if workspace_root and is_inside(workspace_root, file_path) then
    return vim.fs.normalize(workspace_root)
  end
end

function M.open_files(workspace_root)
  local active_buffer = vim.api.nvim_get_current_buf()
  local result = {}
  for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    local path = absolute_path(vim.api.nvim_buf_get_name(buffer))
    if path and vim.api.nvim_buf_is_loaded(buffer) and vim.bo[buffer].buftype == "" then
      result[#result + 1] = {
        filePath = path,
        workspaceFolder = M.workspace_for(path, workspace_root),
        languageId = vim.bo[buffer].filetype ~= "" and vim.bo[buffer].filetype or "text",
        isDirty = vim.bo[buffer].modified,
        isActive = buffer == active_buffer,
      }
    end
  end
  return result
end

local function get_selection_text(buffer, start_position, end_position, mode)
  local start_line, start_column = start_position[1], start_position[2]
  local end_line, end_column = end_position[1], end_position[2]
  if start_line > end_line or (start_line == end_line and start_column > end_column) then
    start_line, end_line = end_line, start_line
    start_column, end_column = end_column, start_column
  end

  local lines = vim.api.nvim_buf_get_lines(buffer, start_line - 1, end_line, false)
  if #lines == 0 then
    return nil
  end
  if mode == "V" then
    return table.concat(lines, "\n"), start_line, 0, end_line, #lines[#lines]
  end
  if mode == "\22" then
    local left = math.min(start_column, end_column)
    local right = math.max(start_column, end_column)
    for index, line in ipairs(lines) do
      lines[index] = line:sub(left + 1, right + 1)
    end
    return table.concat(lines, "\n"), start_line, left, end_line, right + 1
  end
  lines[1] = lines[1]:sub(start_column + 1)
  lines[#lines] = lines[#lines]:sub(1, end_column + 1)
  return table.concat(lines, "\n"), start_line, start_column, end_line, end_column + 1
end

function M.selection(workspace_root, override)
  local mode = override and override.mode or vim.fn.mode()
  if mode ~= "v" and mode ~= "V" and mode ~= "\22" then
    return nil
  end

  local buffer = vim.api.nvim_get_current_buf()
  local path = absolute_path(vim.api.nvim_buf_get_name(buffer))
  if not path or vim.bo[buffer].buftype ~= "" then
    return nil
  end

  local start_position
  local end_position
  if override then
    start_position = override.start_position
    end_position = override.end_position
  else
    local visual_start = vim.fn.getpos("v")
    local cursor = vim.api.nvim_win_get_cursor(0)
    start_position = { visual_start[2], math.max(0, visual_start[3] - 1) }
    end_position = { cursor[1], cursor[2] }
  end
  local text, start_line, start_column, end_line, end_column =
    get_selection_text(buffer, start_position, end_position, mode)
  if not text or text == "" then
    return nil
  end

  return {
    source = "nvim",
    filePath = path,
    workspaceFolder = M.workspace_for(path, workspace_root),
    languageId = vim.bo[buffer].filetype ~= "" and vim.bo[buffer].filetype or "text",
    ranges = {
      {
        text = text,
        selection = {
          start = { line = start_line - 1, character = start_column },
          ["end"] = { line = end_line - 1, character = end_column },
        },
      },
    },
  }
end

local severity_names = {
  [vim.diagnostic.severity.ERROR] = "error",
  [vim.diagnostic.severity.WARN] = "warning",
  [vim.diagnostic.severity.INFO] = "information",
  [vim.diagnostic.severity.HINT] = "hint",
}

function M.diagnostics(workspace_root)
  local result = {}
  for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    local path = absolute_path(vim.api.nvim_buf_get_name(buffer))
    if path and vim.api.nvim_buf_is_loaded(buffer) and vim.bo[buffer].buftype == "" then
      for _, diagnostic in ipairs(vim.diagnostic.get(buffer)) do
        local end_line = diagnostic.end_lnum or diagnostic.lnum
        local end_column = diagnostic.end_col or diagnostic.col
        result[#result + 1] = {
          filePath = path,
          workspaceFolder = M.workspace_for(path, workspace_root),
          severity = severity_names[diagnostic.severity] or "information",
          message = diagnostic.message,
          source = diagnostic.source,
          code = diagnostic.code,
          line = diagnostic.lnum + 1,
          column = diagnostic.col + 1,
          endLine = end_line + 1,
          endColumn = end_column + 1,
        }
      end
    end
  end
  return result
end

return M
