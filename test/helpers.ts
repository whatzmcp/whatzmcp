import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { Store } from '../src/db.js';
import type { ConnectionLike, ConnectionStatus, WaSocketLike } from '../src/port.js';
import { Sender } from '../src/sender.js';
import { createMcpServer } from '../src/server.js';
import type { ToolContext } from '../src/tools.js';

export const OWN = '31600000001@s.whatsapp.net';

export class FakeSocket implements WaSocketLike {
  user = { id: '31600000001:3@s.whatsapp.net', lid: '99000000001@lid' };
  calls: { fn: string; args: unknown[] }[] = [];
  registered = new Set<string>(['14155550123', '14155550124', '14155550125', '447700900123']);
  failNext: Error | null = null;
  private n = 0;

  async sendMessage(jid: string, content: any, options?: any) {
    this.calls.push({ fn: 'sendMessage', args: [jid, content, options] });
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.n++;
    return { key: { remoteJid: jid, fromMe: true, id: `SENT${this.n}` }, message: content.text ? { conversation: content.text } : {} };
  }
  async sendPresenceUpdate(type: string, toJid?: string) {
    this.calls.push({ fn: 'sendPresenceUpdate', args: [type, toJid] });
  }
  async readMessages(keys: any[]) {
    this.calls.push({ fn: 'readMessages', args: [keys] });
  }
  async onWhatsApp(...phones: string[]) {
    this.calls.push({ fn: 'onWhatsApp', args: phones });
    return phones.map((p) => ({ jid: `${p}@s.whatsapp.net`, exists: this.registered.has(p) }));
  }
  callsOf(fn: string) {
    return this.calls.filter((c) => c.fn === fn);
  }
}

export class FakeConnection implements ConnectionLike {
  state: ConnectionStatus = 'connected';
  paired: Date | null = new Date();
  qr: string | null = 'fake-qr-payload';
  loggedOut = false;
  constructor(public sock: FakeSocket) {}
  status() {
    return this.state;
  }
  socket() {
    return this.state === 'connected' ? this.sock : null;
  }
  ownJid() {
    return OWN;
  }
  connectedAt() {
    return this.state === 'connected' ? new Date('2026-01-01T00:00:00Z') : null;
  }
  pairedAt() {
    return this.paired;
  }
  connectKind() {
    return 'qr' as const;
  }
  lastError() {
    return null;
  }
  async startPairing(opts: { method: 'qr' | 'code'; phone?: string }) {
    if (opts.method === 'code') return { pairingCode: 'ABCD1234', status: this.state };
    return { qr: this.qr ?? undefined, status: this.state };
  }
  currentQr() {
    return this.qr && this.state !== 'connected' ? { qr: this.qr, expiresInS: 17 } : null;
  }
  async logout() {
    this.loggedOut = true;
    this.state = 'disconnected';
  }
}

export interface Harness {
  dir: string;
  store: Store;
  sock: FakeSocket;
  conn: FakeConnection;
  sender: Sender;
  config: Config;
  sleeps: number[];
  now: { value: Date };
  ctx: ToolContext;
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; data: any; raw: any }>;
  close: () => Promise<void>;
}

export async function harness(over: Partial<Config> = {}, opts: { pairedDaysAgo?: number } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'whatzmcp-test-'));
  const store = new Store(join(dir, 'test.db'));
  const sock = new FakeSocket();
  const conn = new FakeConnection(sock);
  const now = { value: new Date(2026, 5, 10, 12, 0, 0) };
  const days = opts.pairedDaysAgo ?? 0;
  conn.paired = new Date(2026, 5, 10 - days, 9, 0, 0);
  const config: Config = { ...DEFAULT_CONFIG, ...over };
  const sleeps: number[] = [];
  const sender = new Sender({
    store,
    conn,
    config: () => config,
    now: () => now.value,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
  const ctx: ToolContext = { store, conn, sender, config: () => config, maxWaitS: 5 };
  const server = createMcpServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const raw: any = await client.callTool({ name, arguments: args });
    const textItem = raw.content.find((c: any) => c.type === 'text');
    let data: any = textItem?.text;
    try {
      data = JSON.parse(textItem.text);
    } catch {
      /* not JSON */
    }
    return { isError: !!raw.isError, data, raw };
  };
  return {
    dir,
    store,
    sock,
    conn,
    sender,
    config,
    sleeps,
    now,
    ctx,
    client,
    call,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Stores an inbound message as if it arrived live. */
export function inbound(store: Store, chat: string, id: string, text: string, ts = Math.floor(Date.now() / 1000), live = true) {
  return store.ingestMessage({ id, chatJid: chat, fromMe: false, senderJid: chat, senderName: 'Alice', ts, text, live, raw: JSON.stringify({ key: { remoteJid: chat, id, fromMe: false }, message: { conversation: text } }) });
}
