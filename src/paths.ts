import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface Paths {
  home: string;
  auth: string;
  db: string;
  config: string;
  lock: string;
}

/** Resolves the data directory: WHATZMCP_HOME, or ~/.whatzmcp. */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = resolve(env.WHATZMCP_HOME && env.WHATZMCP_HOME.trim() ? env.WHATZMCP_HOME : join(homedir(), '.whatzmcp'));
  return {
    home,
    auth: join(home, 'auth'),
    db: join(home, 'whatzmcp.db'),
    config: join(home, 'config.json'),
    lock: join(home, 'whatzmcp.lock'),
  };
}

export function ensureHome(paths: Paths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
}
