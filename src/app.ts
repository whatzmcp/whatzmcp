import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { loadConfig, type Config } from './config.js';
import { Store } from './db.js';
import { createLogger } from './log.js';
import { ensureHome, resolvePaths, type Paths } from './paths.js';
import { Sender } from './sender.js';
import type { ToolContext } from './tools.js';
import { Connection } from './whatsapp.js';

/** Re-reads config.json when the file changes, so edits apply without a restart. */
export function configWatcher(path: string): () => Config {
  let cached = loadConfig(path);
  let mtime = statSync(path).mtimeMs;
  return () => {
    try {
      const m = statSync(path).mtimeMs;
      if (m !== mtime) {
        cached = loadConfig(path);
        mtime = m;
      }
    } catch {
      /* keep the last good config */
    }
    return cached;
  };
}

/** One whatzmcp process per data directory: two linked sessions on one login would knock each other off. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(paths: Paths): () => void {
  let pid = 0;
  try {
    pid = Number(readFileSync(paths.lock, 'utf8').trim());
  } catch {
    /* no lock file */
  }
  if (pid && pid !== process.pid && alive(pid)) {
    throw new Error(`Another whatzmcp is already running with this data directory (pid ${pid}). Stop it first.`);
  }
  writeFileSync(paths.lock, String(process.pid));
  return () => {
    try {
      if (readFileSync(paths.lock, 'utf8').trim() === String(process.pid)) rmSync(paths.lock, { force: true });
    } catch {
      /* already gone */
    }
  };
}

export interface App {
  paths: Paths;
  store: Store;
  conn: Connection;
  ctx: ToolContext;
  shutdown: () => Promise<void>;
}

export function openApp(opts: { onQr?: (qr: string) => void; lock?: boolean } = {}): App {
  const paths = resolvePaths();
  ensureHome(paths);
  const release = opts.lock === false ? () => undefined : acquireLock(paths);
  const config = configWatcher(paths.config);
  const logger = createLogger();
  const store = new Store(paths.db);
  const conn = new Connection({ paths, store, logger, onQr: opts.onQr });
  const sender = new Sender({ store, conn, config, logger });
  const ctx: ToolContext = { store, conn, sender, config };
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    await conn.stop().catch(() => undefined);
    store.close();
    release();
  };
  return { paths, store, conn, ctx, shutdown };
}
