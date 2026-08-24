local M = {}

local bit = bit or require("bit")
local band = bit.band
local bor = bit.bor
local bxor = bit.bxor
local bnot = bit.bnot
local lshift = bit.lshift
local rshift = bit.rshift
local rol = bit.rol
local UINT32 = 0xffffffff
local GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

local function u32(value)
  return band(value, UINT32)
end

local function word(bytes, index)
  return bor(
    lshift(bytes[index], 24),
    lshift(bytes[index + 1], 16),
    lshift(bytes[index + 2], 8),
    bytes[index + 3]
  )
end

local function append_word(output, value)
  output[#output + 1] = string.char(
    band(rshift(value, 24), 0xff),
    band(rshift(value, 16), 0xff),
    band(rshift(value, 8), 0xff),
    band(value, 0xff)
  )
end

local function sha1(value)
  local bytes = { value:byte(1, #value) }
  local bit_length = #bytes * 8
  bytes[#bytes + 1] = 0x80
  while #bytes % 64 ~= 56 do
    bytes[#bytes + 1] = 0
  end
  for shift = 56, 0, -8 do
    bytes[#bytes + 1] = math.floor(bit_length / 2 ^ shift) % 256
  end

  local h0, h1, h2, h3, h4 = 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0
  for chunk = 1, #bytes, 64 do
    local words = {}
    for index = 0, 15 do
      words[index] = word(bytes, chunk + index * 4)
    end
    for index = 16, 79 do
      words[index] = rol(bxor(words[index - 3], words[index - 8], words[index - 14], words[index - 16]), 1)
    end

    local a, b, c, d, e = h0, h1, h2, h3, h4
    for index = 0, 79 do
      local f, k
      if index < 20 then
        f, k = bor(band(b, c), band(bnot(b), d)), 0x5a827999
      elseif index < 40 then
        f, k = bxor(b, c, d), 0x6ed9eba1
      elseif index < 60 then
        f, k = bor(band(b, c), band(b, d), band(c, d)), 0x8f1bbcdc
      else
        f, k = bxor(b, c, d), 0xca62c1d6
      end
      local temporary = u32(rol(a, 5) + f + e + k + words[index])
      e, d, c, b, a = d, c, rol(b, 30), a, temporary
    end
    h0, h1, h2, h3, h4 = u32(h0 + a), u32(h1 + b), u32(h2 + c), u32(h3 + d), u32(h4 + e)
  end

  local output = {}
  append_word(output, h0)
  append_word(output, h1)
  append_word(output, h2)
  append_word(output, h3)
  append_word(output, h4)
  return table.concat(output)
end

function M.accept_key(key)
  return vim.base64.encode(sha1(key .. GUID))
end

local function length_bytes(length)
  if length < 126 then
    return string.char(length)
  end
  if length <= 0xffff then
    return string.char(126, math.floor(length / 256), length % 256)
  end
  local bytes = { 127 }
  for shift = 56, 0, -8 do
    bytes[#bytes + 1] = math.floor(length / 2 ^ shift) % 256
  end
  return string.char(unpack(bytes))
end

function M.encode_frame(payload, opcode, mask)
  opcode = opcode or 1
  local first = string.char(0x80 + opcode)
  local length = length_bytes(#payload)
  if not mask then
    return first .. length .. payload
  end

  local length_first = length:byte(1) + 0x80
  length = string.char(length_first) .. length:sub(2)
  local output = {}
  for index = 1, #payload do
    output[index] = string.char(bxor(payload:byte(index), mask[(index - 1) % 4 + 1]))
  end
  return first .. length .. string.char(unpack(mask)) .. table.concat(output)
end

local function read_length(data, index, marker)
  if marker < 126 then
    return marker, index
  end
  local count = marker == 126 and 2 or 8
  if #data < index + count - 1 then
    return nil
  end
  local length = 0
  for offset = 0, count - 1 do
    length = length * 256 + data:byte(index + offset)
  end
  return length, index + count
end

function M.decode_frames(data)
  local frames = {}
  local index = 1
  while #data - index + 1 >= 2 do
    local first, second = data:byte(index, index + 1)
    local final = band(first, 0x80) ~= 0
    local opcode = band(first, 0x0f)
    local masked = band(second, 0x80) ~= 0
    local length, payload_index = read_length(data, index + 2, band(second, 0x7f))
    if not length then
      break
    end
    local mask
    if masked then
      if #data < payload_index + 3 then
        break
      end
      mask = { data:byte(payload_index, payload_index + 3) }
      payload_index = payload_index + 4
    end
    if #data < payload_index + length - 1 then
      break
    end

    local payload = data:sub(payload_index, payload_index + length - 1)
    if mask then
      local output = {}
      for offset = 1, #payload do
        output[offset] = string.char(bxor(payload:byte(offset), mask[(offset - 1) % 4 + 1]))
      end
      payload = table.concat(output)
    end
    frames[#frames + 1] = { opcode = opcode, payload = payload, final = final }
    index = payload_index + length
  end
  return frames, data:sub(index)
end

return M
