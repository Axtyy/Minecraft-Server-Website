'use strict';
/**
 * One-line timestamped logging.
 *
 * Deliberately small: the bot runs under systemd, which already timestamps and
 * rotates, so anything more would be duplicating the journal.
 */
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const write = (stream, level, msg) => stream.write(`${stamp()} ${level} ${msg}\n`);

module.exports = {
  info: (msg) => write(process.stdout, 'INFO ', msg),
  warn: (msg) => write(process.stdout, 'WARN ', msg),
  error: (msg) => write(process.stderr, 'ERROR', msg),
};
