local M = {}

local function timestamp()
  return os.date("!%Y-%m-%dT%H:%M:%SZ")
end

local function encode(value)
  return vim.json.encode(value) .. "\n"
end

function M.default_directory()
  local home = vim.env.USERPROFILE or vim.env.HOME
  return vim.fs.joinpath(home, ".pi", "pi-ide-pro", "lock")
end

function M.write(directory, port, token, workspace_folders)
  vim.fn.mkdir(directory, "p")
  local path = vim.fs.joinpath(directory, ("nvim-%d-%d.lock"):format(vim.fn.getpid(), port))
  local temporary = path .. ".tmp"
  local now = timestamp()
  local file, error_message = io.open(temporary, "wb")
  if not file then
    return nil, error_message
  end
  file:write(encode({
    version = 1,
    name = "Pi IDE Pro Neovim",
    host = "127.0.0.1",
    port = port,
    authToken = token,
    workspaceFolders = workspace_folders,
    pid = vim.fn.getpid(),
    createdAt = now,
    updatedAt = now,
  }))
  file:close()
  local renamed, rename_error = os.rename(temporary, path)
  if not renamed then
    os.remove(temporary)
    return nil, rename_error
  end
  return path
end

function M.remove(path)
  if path then
    os.remove(path)
  end
end

return M
