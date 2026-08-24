local lock = require("pi_ide_pro.lock")
local server_module = require("pi_ide_pro.server")
local state = require("pi_ide_pro.state")

local M = {}
local instance

local function token()
  return vim.fn.sha256(table.concat({ tostring(vim.uv.hrtime()), tostring(vim.fn.getpid()), tostring(math.random()) }, ":"))
end

local function default_workspaces()
  return { state.workspace_root(vim.fn.getcwd()) }
end

local function schedule_publish(current)
  if current.timer then
    current.timer:stop()
  else
    current.timer = vim.uv.new_timer()
  end
  current.timer:start(100, 0, function()
    vim.schedule(function()
      if instance == current then
        current.server:publish_state()
      end
    end)
  end)
end

local function stop(current)
  if not current then
    return
  end
  if current.timer and not current.timer:is_closing() then
    current.timer:stop()
    current.timer:close()
  end
  current.server:stop()
  lock.remove(current.lock_path)
  vim.g.pi_ide_pro_status = nil
  if instance == current then
    instance = nil
  end
end

function M.setup(options)
  if instance then
    return instance
  end
  options = options or {}
  local auth_token = token()
  local workspace_folders = options.workspace_folders or default_workspaces()
  for index, workspace in ipairs(workspace_folders) do
    workspace_folders[index] = vim.fs.normalize(vim.fn.fnamemodify(workspace, ":p"))
  end

  local server = server_module.start({ token = auth_token, workspace_folders = workspace_folders })
  local lock_path, error_message =
    lock.write(options.lock_dir or lock.default_directory(), server.port, auth_token, workspace_folders)
  if not lock_path then
    server:stop()
    error("Pi IDE Pro could not write its lock file: " .. tostring(error_message))
  end

  local current = { server = server, lock_path = lock_path, timer = nil }
  instance = current
  vim.g.pi_ide_pro_status = "listening"

  local group = vim.api.nvim_create_augroup("PiIdePro", { clear = true })
  vim.api.nvim_create_autocmd({
    "BufAdd",
    "BufDelete",
    "BufEnter",
    "BufWritePost",
    "CursorMoved",
    "CursorMovedI",
    "DiagnosticChanged",
    "ModeChanged",
  }, {
    group = group,
    callback = function()
      schedule_publish(current)
    end,
  })
  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = group,
    once = true,
    callback = function()
      stop(current)
    end,
  })
  return current
end

function M.stop()
  stop(instance)
end

function M.status()
  if not instance then
    return { status = "stopped", clients = {} }
  end
  return { status = "listening", port = instance.server.port, clients = instance.server:clients_for_workspace() }
end

return M
