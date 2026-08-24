if vim.g.loaded_pi_ide_pro then
  return
end
vim.g.loaded_pi_ide_pro = true

require("pi_ide_pro").setup()
