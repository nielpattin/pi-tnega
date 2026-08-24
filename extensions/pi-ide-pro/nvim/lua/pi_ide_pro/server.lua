local websocket = require("pi_ide_pro.websocket")
local state = require("pi_ide_pro.state")

local M = {}
local Server = {}
Server.__index = Server

local function json(value)
  return vim.json.encode(value)
end

local function parse_headers(request)
  local headers = {}
  for key, value in request:gmatch("\r\n([^:\r\n]+):%s*([^\r\n]+)") do
    headers[key:lower()] = value
  end
  return headers
end

local function send_http(socket, status, body, content_type)
  body = body or ""
  socket:write(table.concat({
    "HTTP/1.1 " .. status,
    "Content-Type: " .. (content_type or "text/plain; charset=utf-8"),
    "Content-Length: " .. #body,
    "Connection: close",
    "",
    body,
  }, "\r\n"), function()
    if not socket:is_closing() then
      socket:shutdown(function()
        socket:close()
      end)
    end
  end)
end

local function comparable(path)
  return vim.fs.normalize(path):gsub("\\", "/"):gsub("/$", ""):lower()
end

local function client_inside_workspace(client, workspace_folders)
  local cwd = comparable(client.cwd)
  for _, workspace in ipairs(workspace_folders) do
    workspace = comparable(workspace)
    if cwd == workspace or cwd:sub(1, #workspace + 1) == workspace .. "/" then
      return true
    end
  end
  return false
end

function Server:send(connection, value)
  if connection.socket:is_closing() or not connection.handshaken then
    return
  end
  connection.socket:write(websocket.encode_frame(json(value)))
end

function Server:broadcast(value)
  for connection in pairs(self.connections) do
    if connection.client then
      self:send(connection, value)
    end
  end
end

function Server:clients_for_workspace()
  local clients = {}
  for connection in pairs(self.connections) do
    if connection.client and client_inside_workspace(connection.client, self.workspace_folders) then
      clients[#clients + 1] = connection.client
    end
  end
  return clients
end

function Server:publish_clients()
  self:broadcast({
    jsonrpc = "2.0",
    method = "clients_changed",
    params = { clients = self:clients_for_workspace() },
  })
end

function Server:publish_state()
  local selection = state.selection(self.workspace_folders[1])
  self:broadcast({
    jsonrpc = "2.0",
    method = selection and "selection_changed" or "selection_cleared",
    params = selection or { source = "nvim", reason = "no-selection" },
  })
  self:broadcast({
    jsonrpc = "2.0",
    method = "open_files_changed",
    params = { files = state.open_files(self.workspace_folders[1]) },
  })
end

function Server:open_file(file_path, line)
  vim.cmd.edit(vim.fn.fnameescape(file_path))
  local last_line = vim.api.nvim_buf_line_count(0)
  vim.api.nvim_win_set_cursor(0, { math.max(1, math.min(tonumber(line) or 1, last_line)), 0 })
end

function Server:handle_rpc(connection, value)
  if value.method == "initialize" then
    local client = value.params and value.params.client
    if type(client) ~= "table" or type(client.sessionId) ~= "string" or type(client.cwd) ~= "string" then
      return
    end
    connection.client = {
      sessionId = client.sessionId,
      cwd = client.cwd,
      connectedAt = math.floor(vim.uv.now()),
    }
    self:send(connection, {
      jsonrpc = "2.0",
      id = value.id,
      result = {
        protocolVersion = 1,
        server = { name = "Pi IDE Pro Neovim", ide = "nvim" },
        selection = state.selection(self.workspace_folders[1]),
        files = state.open_files(self.workspace_folders[1]),
      },
    })
    self:publish_clients()
    return
  end

  if not connection.client then
    return
  end
  local result
  if value.method == "get_open_files" then
    result = state.open_files(self.workspace_folders[1])
  elseif value.method == "get_diagnostics" then
    result = state.diagnostics(self.workspace_folders[1])
  elseif value.method == "get_clients" then
    result = self:clients_for_workspace()
  elseif value.method == "open_file" then
    local ok, error_message = pcall(self.open_file, self, value.params.filePath, value.params.line)
    if not ok then
      self:send(connection, { jsonrpc = "2.0", id = value.id, error = { code = -1, message = error_message } })
      return
    end
    result = true
  elseif value.method == "send_diagnostic" then
    local target
    for candidate in pairs(self.connections) do
      if candidate.client and candidate.client.sessionId == value.params.clientSessionId then
        target = candidate
        break
      end
    end
    if not target then
      self:send(connection, {
        jsonrpc = "2.0",
        id = value.id,
        error = { code = -1, message = "Pi session is no longer connected" },
      })
      return
    end
    self:send(target, {
      jsonrpc = "2.0",
      method = "diagnostic_request",
      params = { request = value.params.request },
    })
    result = true
  else
    return
  end
  self:send(connection, { jsonrpc = "2.0", id = value.id, result = result })
end

function Server:handle_frames(connection, data)
  connection.frame_buffer = connection.frame_buffer .. data
  local frames
  frames, connection.frame_buffer = websocket.decode_frames(connection.frame_buffer)
  for _, frame in ipairs(frames) do
    if frame.opcode == 8 then
      self:close_connection(connection)
    elseif frame.opcode == 9 then
      connection.socket:write(websocket.encode_frame(frame.payload, 10))
    elseif frame.opcode == 1 and frame.final then
      local ok, value = pcall(vim.json.decode, frame.payload)
      if ok and type(value) == "table" then
        vim.schedule(function()
          if self.connections[connection] then
            self:handle_rpc(connection, value)
          end
        end)
      end
    end
  end
end

function Server:close_connection(connection)
  if not self.connections[connection] then
    return
  end
  self.connections[connection] = nil
  if not connection.socket:is_closing() then
    connection.socket:close()
  end
  vim.schedule(function()
    self:publish_clients()
  end)
end

function Server:handle_http(connection, request, remainder)
  local headers = parse_headers(request)
  if headers.upgrade and headers.upgrade:lower() == "websocket" then
    if headers["x-pi-ide-pro-authorization"] ~= self.token or not headers["sec-websocket-key"] then
      send_http(connection.socket, "401 Unauthorized")
      return
    end
    connection.handshaken = true
    connection.socket:write(table.concat({
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Accept: " .. websocket.accept_key(headers["sec-websocket-key"]),
      "",
      "",
    }, "\r\n"))
    if remainder ~= "" then
      self:handle_frames(connection, remainder)
    end
    return
  end

  send_http(connection.socket, "404 Not Found")
end

function Server:accept(socket)
  local connection = { socket = socket, buffer = "", frame_buffer = "", handshaken = false }
  self.connections[connection] = true
  socket:read_start(function(error_message, chunk)
    if error_message or not chunk then
      self:close_connection(connection)
      return
    end
    if connection.handshaken then
      self:handle_frames(connection, chunk)
      return
    end
    connection.buffer = connection.buffer .. chunk
    local boundary = connection.buffer:find("\r\n\r\n", 1, true)
    if boundary then
      local request = connection.buffer:sub(1, boundary + 3)
      local remainder = connection.buffer:sub(boundary + 4)
      connection.buffer = ""
      self:handle_http(connection, request, remainder)
    end
  end)
end

function Server:stop()
  for connection in pairs(self.connections) do
    if not connection.socket:is_closing() then
      connection.socket:close()
    end
  end
  self.connections = {}
  if self.socket and not self.socket:is_closing() then
    self.socket:close()
  end
end

function M.start(options)
  local server = setmetatable({
    token = options.token,
    workspace_folders = options.workspace_folders,
    connections = {},
  }, Server)
  server.socket = vim.uv.new_tcp()
  assert(server.socket:bind("127.0.0.1", 0))
  assert(server.socket:listen(128, function(error_message)
    if error_message then
      return
    end
    local client = vim.uv.new_tcp()
    server.socket:accept(client)
    server:accept(client)
  end))
  server.port = server.socket:getsockname().port
  return server
end

return M
