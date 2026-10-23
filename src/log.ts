import pino, { type Logger } from 'pino';

/** All logs go to stderr. stdout is reserved for the MCP stdio channel. */
export function createLogger(level: string = process.env.WHATZMCP_LOG_LEVEL || 'warn'): Logger {
  return pino({ level, base: undefined }, pino.destination(2));
}
