function formatLogLine(level, message, at = new Date()) {
   return `${at.toISOString()} [${level.toUpperCase()}] ${message}`;
}

module.exports = { formatLogLine };
