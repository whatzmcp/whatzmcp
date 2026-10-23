#!/usr/bin/env node
import qrcodeTerminal from 'qrcode-terminal';
import { openApp } from './app.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { parseE164, phoneOf } from './jid.js';
import { ensureHome, resolvePaths } from './paths.js';
import { Sender } from './sender.js';
import { localDayString, rampMessageCap, rampNewContactCap } from './safety.js';
import { serveHttp, serveStdio } from './server.js';
import { VERSION } from './version.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { ConnectionLike } from './port.js';

const HELP = `whatzmcp ${VERSION}
Open source WhatsApp MCP server. Runs on your machine and talks only to WhatsApp.

Usage:
  whatzmcp login                     Link your WhatsApp account by QR code in this terminal
  whatzmcp login --pair-code +<num>  Link with an 8 character pairing code instead
  whatzmcp [serve]                   Run the MCP server on stdio (for Claude Desktop, Claude Code, Cursor)
  whatzmcp serve --http [--port 8787] [--token <secret>]
                                     Run the MCP server over Streamable HTTP on 127.0.0.1 (endpoint /mcp)
  whatzmcp status                    Show the link status and today's usage
  whatzmcp limits                    Show today's caps, usage and the warm-up ramp
  whatzmcp logout                    Unlink this device and delete the saved session
  whatzmcp --help | --version

Data directory: ~/.whatzmcp (set WHATZMCP_HOME to change it). Limits: config.json in that directory.
Token for --http can also come from WHATZMCP_TOKEN.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

function out(line = ''): void {
  process.stdout.write(line + '\n');
}

function fail(msg: string): never {
  process.stderr.write(`whatzmcp: ${msg}\n`);
  process.exit(1);
}

async function login(args: string[]): Promise<void> {
  const pairCode = flag(args, '--pair-code');
  let digits: string | null = null;
  if (pairCode !== undefined) {
    digits = parseE164(pairCode);
    if (!digits) fail('--pair-code needs your WhatsApp number in E.164 format, for example --pair-code +14155550123');
  }
  const app = openApp({
    onQr: digits
      ? undefined
      : (qr) => {
          out('\nScan this QR code: WhatsApp on your phone > Settings > Linked devices > Link a device\n');
          qrcodeTerminal.generate(qr, { small: true });
        },
  });
  const { conn } = app;
  const interrupted = async () => {
    await app.shutdown();
    process.exit(130);
  };
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  if (conn.status() === 'restricted') {
    out('This session was refused by WhatsApp (403). Run whatzmcp logout first, then whatzmcp login.');
    await app.shutdown();
    process.exit(1);
  }
  if (conn.isPaired()) {
    await conn.start();
    const ok = await conn.waitForOpen(20_000);
    out(ok ? `Already linked as ${conn.ownPhone() ?? conn.ownJid()}. Run whatzmcp logout first to link another number.` : 'A saved session exists but could not connect right now. Run whatzmcp status, or whatzmcp logout to start over.');
    await app.shutdown();
    process.exit(ok ? 0 : 1);
  }
  conn.events.on('pairing-timeout', async () => {
    out('The QR code expired before it was scanned. Run whatzmcp login again.');
    await app.shutdown();
    process.exit(1);
  });
  conn.events.on('blocked', async () => {
    out('WhatsApp refused this session (403).');
    await app.shutdown();
    process.exit(1);
  });
  if (digits) {
    out('Requesting a pairing code...');
    const r = await conn.startPairing({ method: 'code', phone: digits, timeoutMs: 30_000 }).catch((e) => fail((e as Error).message));
    if (!r.pairingCode) fail('Could not get a pairing code from WhatsApp. Check your internet connection and try again.');
    const c = r.pairingCode;
    out(`\nPairing code: ${c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c}`);
    out('On your phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead, then enter the code.\n');
  } else {
    await conn.start();
  }
  const opened = await conn.waitForOpen(5 * 60_000);
  if (!opened) {
    out('Timed out waiting for the link. Run whatzmcp login again.');
    await app.shutdown();
    process.exit(1);
  }
  out(`Linked as ${conn.ownPhone() ?? conn.ownJid()}. Starting the first history sync...`);
  if (!conn.historyStarted()) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 30_000);
      conn.events.once('history', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  // Give the sync a few seconds to save its first batch; the server keeps syncing later.
  await new Promise((r) => setTimeout(r, 5000));
  out('Session saved. Now add whatzmcp to your MCP client (see the README) or run: whatzmcp serve');
  await app.shutdown();
  process.exit(0);
}

async function serve(args: string[]): Promise<void> {
  const http = args.includes('--http');
  const app = openApp();
  const stop = async () => {
    await app.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (app.conn.isPaired()) {
    app.conn.start().catch((err) => process.stderr.write(`whatzmcp: could not start WhatsApp: ${(err as Error).message}\n`));
  }
  if (http) {
    const portArg = flag(args, '--port');
    const port = portArg ? Number(portArg) : 8787;
    if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be a number');
    const token = flag(args, '--token') || process.env.WHATZMCP_TOKEN || undefined;
    const s = await serveHttp(app.ctx, { port, token });
    process.stderr.write(`whatzmcp ${VERSION}: MCP over HTTP at http://127.0.0.1:${s.port}/mcp${token ? ' (bearer token required)' : ' (no token: any local program can connect)'}\n`);
  } else {
    // Exit when the MCP client closes stdin.
    process.stdin.on('end', stop);
    await serveStdio(app.ctx);
  }
}

function usageLines(conn: ConnectionLike, sender: Sender): string[] {
  const u = sender.usage();
  return [
    `Today (${localDayString(u.day)}): ${u.sends} of ${u.caps.messages} messages, ${u.newContacts} of ${u.caps.newContacts} new contacts`,
    u.caps.day !== null ? `Warm-up day: ${u.caps.day}` : 'Warm-up: ' + (conn.pairedAt() ? 'off (fixed caps)' : 'starts on the pairing day'),
  ];
}

/** Read-only view of the data directory; does not connect to WhatsApp. */
function offlineView() {
  const paths = resolvePaths();
  ensureHome(paths);
  const config = loadConfig(paths.config);
  const store = new Store(paths.db);
  const own = store.getState('own_jid');
  const paired = existsSync(`${paths.auth}/creds.json`) && store.getState('registered') === '1';
  const blocked = store.getState('blocked');
  const conn: ConnectionLike = {
    status: () => (blocked ? 'restricted' : paired ? 'connected' : 'disconnected'),
    socket: () => null,
    ownJid: () => own,
    connectedAt: () => null,
    pairedAt: () => {
      const v = own ? store.getState(`first_paired_at:${own}`) : null;
      return v ? new Date(v) : null;
    },
    connectKind: () => 'qr',
    lastError: () => null,
    startPairing: async () => ({ status: 'disconnected' }),
    currentQr: () => null,
    logout: async () => undefined,
  };
  const sender = new Sender({ store, conn, config: () => config });
  let runningPid: number | null = null;
  try {
    const pid = Number(readFileSync(paths.lock, 'utf8').trim());
    process.kill(pid, 0);
    runningPid = pid;
  } catch {
    /* not running */
  }
  return { paths, config, store, own, paired, blocked, conn, sender, runningPid };
}

function status(): void {
  const v = offlineView();
  out(`Data directory: ${v.paths.home}`);
  if (v.blocked) out(`Status: stopped. WhatsApp refused this session (403) on ${v.blocked}. Run whatzmcp logout, then whatzmcp login.`);
  else if (v.paired) out(`Status: linked as ${phoneOf(v.own) ?? v.own}`);
  else out('Status: not linked. Run whatzmcp login.');
  out(v.runningPid ? `Server: running (pid ${v.runningPid})` : 'Server: not running');
  const pairedAt = v.conn.pairedAt();
  if (pairedAt) out(`First paired: ${pairedAt.toISOString()}`);
  for (const l of usageLines(v.conn, v.sender)) out(l);
  v.store.close();
}

function limits(): void {
  const v = offlineView();
  for (const l of usageLines(v.conn, v.sender)) out(l);
  const c = v.config;
  out('');
  out(`Config: ${v.paths.config}`);
  out(`  warmup: ${c.warmup}`);
  out(`  daily_message_cap: ${c.daily_message_cap ?? 'ramp'}`);
  out(`  daily_new_contact_cap: ${c.daily_new_contact_cap ?? 'ramp'}`);
  out(`  new_contact_delay_seconds: ${c.new_contact_delay_seconds.min} to ${c.new_contact_delay_seconds.max}`);
  out('');
  out('Warm-up ramp (day: messages / new contacts):');
  for (const d of [1, 2, 3, 7, 14, 30, 58, 61]) out(`  day ${String(d).padStart(2)}: ${rampMessageCap(d)} / ${rampNewContactCap(d)}`);
  v.store.close();
}

async function logout(): Promise<void> {
  const paths = resolvePaths();
  if (!existsSync(paths.auth)) {
    out('Not linked. Nothing to remove.');
    return;
  }
  const app = openApp();
  const { conn } = app;
  if (conn.isPaired() && conn.status() !== 'restricted') {
    out('Connecting to unlink this device...');
    await conn.start();
    const ok = await conn.waitForOpen(20_000);
    if (!ok) out('Could not reach WhatsApp. The local session is deleted; also remove "whatzmcp" under Linked devices on your phone.');
  }
  await conn.logout();
  rmSync(paths.auth, { recursive: true, force: true });
  await app.shutdown();
  out('Unlinked. The saved session is deleted. Stored messages stay in whatzmcp.db; delete the data directory to remove them.');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'serve';
  if (args.includes('--help') || args.includes('-h') || cmd === 'help') {
    out(HELP);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    out(VERSION);
    return;
  }
  switch (cmd) {
    case 'serve':
      return serve(args);
    case 'login':
      return login(args);
    case 'status':
      return status();
    case 'limits':
      return limits();
    case 'logout':
      return logout();
    default:
      fail(`unknown command "${cmd}". Run whatzmcp --help`);
  }
}

main().catch((err) => fail((err as Error).message));
