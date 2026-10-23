import { existsSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  extractMessageContent,
  getContentType,
  makeCacheableSignalKeyStore,
  toNumber,
  useMultiFileAuthState,
  type WAMessage,
} from '@whiskeysockets/baileys';
import type { Logger } from 'pino';
import type { MessageRecord, Store } from './db.js';
import { isBroadcastJid, normaliseJid, phoneOf } from './jid.js';
import type { Paths } from './paths.js';
import type { ConnectionLike, ConnectionStatus, WaSocketLike } from './port.js';

type Sock = ReturnType<typeof makeWASocket>;

const STATUS_NAMES: Record<number, string> = { 0: 'failed', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' };
const QR_TTL_S = 20;

const MEDIA_KEYS: Record<string, string> = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  ptvMessage: 'video',
};

/** Turns a Baileys message into a plain record for the store. Returns null for protocol noise. */
export function toRecord(msg: WAMessage, live: boolean): MessageRecord | null {
  const key = msg.key as WAMessage['key'] & { remoteJidAlt?: string; participantAlt?: string };
  if (!key?.remoteJid || !key.id) return null;
  if (isBroadcastJid(normaliseJid(key.remoteJid))) return null;
  const content = extractMessageContent(msg.message);
  if (!content) return null;
  const type = getContentType(content);
  if (!type || ['protocolMessage', 'senderKeyDistributionMessage', 'reactionMessage', 'pollUpdateMessage', 'keepInChatMessage'].includes(type)) return null;
  const c = content as Record<string, any>;
  const text: string | null =
    c.conversation ??
    c.extendedTextMessage?.text ??
    c.imageMessage?.caption ??
    c.videoMessage?.caption ??
    c.documentMessage?.caption ??
    c.ptvMessage?.caption ??
    (c.locationMessage ? `[location] ${c.locationMessage.degreesLatitude},${c.locationMessage.degreesLongitude}` : null) ??
    (c.contactMessage ? `[contact] ${c.contactMessage.displayName ?? ''}` : null) ??
    (c.pollCreationMessage ? `[poll] ${c.pollCreationMessage.name ?? ''}` : null) ??
    null;
  const mediaType = MEDIA_KEYS[type] ?? null;
  const mimetype: string | null = mediaType ? (c[type]?.mimetype ?? null) : null;
  const status = key.fromMe ? (msg.status !== undefined && msg.status !== null ? STATUS_NAMES[msg.status] ?? 'sent' : 'sent') : 'received';
  return {
    id: key.id,
    chatJid: key.remoteJid,
    chatAltJid: key.remoteJidAlt ?? null,
    fromMe: !!key.fromMe,
    senderJid: key.participant ?? (key.fromMe ? null : key.remoteJid),
    senderAltJid: key.participantAlt ?? null,
    senderName: msg.pushName ?? null,
    ts: toNumber(msg.messageTimestamp as any) || Math.floor(Date.now() / 1000),
    text: text ?? (mediaType ? null : null),
    mediaType,
    mimetype,
    status,
    live,
    raw: JSON.stringify({ key: msg.key, message: msg.message }, BufferJSON.replacer),
  };
}

export interface ConnectionOptions {
  paths: Paths;
  store: Store;
  logger: Logger;
  /** Called with every new QR string (the CLI prints it). */
  onQr?: (qr: string) => void;
  /** Download the full history on first link. */
  syncFullHistory?: boolean;
}

/**
 * One WhatsApp Web linked device. Reconnects on transient drops; stops on logout (401) and on 403.
 * Talks only to WhatsApp.
 */
export class Connection implements ConnectionLike {
  readonly events = new EventEmitter();
  private sock: Sock | null = null;
  private state: ConnectionStatus = 'disconnected';
  private qr: { value: string; at: number } | null = null;
  private error: string | null = null;
  private openedAt: Date | null = null;
  private backoffMs = 1000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private kind: 'qr' | 'code' = 'qr';
  private pairingPhone: string | null = null;
  private historySeen = false;

  constructor(private readonly opts: ConnectionOptions) {
    if (opts.store.getState('blocked')) {
      this.state = 'restricted';
      this.error = 'WhatsApp refused this session (403). Sending is stopped. Check the phone, then run whatzmcp logout and whatzmcp login.';
    }
    const k = opts.store.getState('connect_kind');
    if (k === 'qr' || k === 'code') this.kind = k;
    this.events.setMaxListeners(50);
  }

  /** True when a saved session exists on disk. */
  isPaired(): boolean {
    return existsSync(`${this.opts.paths.auth}/creds.json`) && this.opts.store.getState('registered') === '1';
  }

  status(): ConnectionStatus {
    return this.state;
  }
  socket(): WaSocketLike | null {
    return this.state === 'connected' ? (this.sock as unknown as WaSocketLike) : null;
  }
  ownJid(): string | null {
    const id = this.sock?.user?.id ?? this.opts.store.getState('own_jid');
    return id ? normaliseJid(id) : null;
  }
  connectedAt(): Date | null {
    return this.openedAt;
  }
  pairedAt(): Date | null {
    const own = this.ownJid();
    const v = own ? this.opts.store.getState(`first_paired_at:${own}`) : null;
    return v ? new Date(v) : null;
  }
  connectKind(): 'qr' | 'code' {
    return this.kind;
  }
  lastError(): string | null {
    return this.error;
  }
  historyStarted(): boolean {
    return this.historySeen;
  }

  currentQr(): { qr: string; expiresInS: number } | null {
    if (!this.qr || this.state === 'connected') return null;
    const left = QR_TTL_S - Math.floor((Date.now() - this.qr.at) / 1000);
    return left > 0 ? { qr: this.qr.value, expiresInS: left } : null;
  }

  /** Connects with the saved session, or starts a new link when none exists. */
  async start(): Promise<void> {
    if (this.state === 'restricted') return;
    if (this.sock) return;
    this.stopped = false;
    this.state = 'connecting';
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.paths.auth);
    const logger = this.opts.logger.child({ module: 'baileys' });
    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger as any) },
      logger: logger as any,
      // Ubuntu + Desktop: accepted by WhatsApp for new links and gets the long history sync.
      browser: Browsers.ubuntu('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: this.opts.syncFullHistory ?? true,
      getMessage: async (key) => {
        const row = key.id ? this.opts.store.getMessage(key.id) : null;
        if (!row?.raw) return undefined;
        return JSON.parse(row.raw, BufferJSON.reviver).message ?? undefined;
      },
    });
    this.sock = sock;
    const store = this.opts.store;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        this.qr = { value: u.qr, at: Date.now() };
        this.events.emit('qr', u.qr);
        this.opts.onQr?.(u.qr);
        if (this.pairingPhone && !sock.authState.creds.registered) {
          const phone = this.pairingPhone;
          this.pairingPhone = null;
          try {
            const code = await sock.requestPairingCode(phone);
            this.events.emit('pairing-code', code);
          } catch (err) {
            this.events.emit('pairing-code-error', err);
          }
        }
      }
      if (u.connection === 'open') {
        this.state = 'connected';
        this.error = null;
        this.qr = null;
        this.openedAt = new Date();
        this.backoffMs = 1000;
        const own = sock.user?.id ? normaliseJid(sock.user.id) : null;
        if (own) {
          store.setState('own_jid', own);
          if (!store.getState(`first_paired_at:${own}`)) store.setState(`first_paired_at:${own}`, new Date().toISOString());
          if (sock.user?.lid) store.addLidMapping(sock.user.lid, own);
        }
        store.setState('registered', '1');
        store.setState('blocked', null);
        this.events.emit('open');
      }
      if (u.connection === 'close') {
        this.sock = null;
        this.openedAt = null;
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode as number | undefined;
        this.handleClose(code, sock.authState.creds.registered);
      }
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
      this.historySeen = true;
      const tx = store.db.transaction(() => {
        for (const m of lidPnMappings ?? []) store.addLidMapping(m.lid, m.pn);
        for (const c of contacts) store.upsertContact({ jid: c.id, lid: c.lid, pn: c.phoneNumber, name: c.name, notify: c.notify, verifiedName: c.verifiedName });
        for (const c of chats) {
          if (!c.id) continue;
          const anyC = c as any;
          store.upsertChat({
            jid: c.id,
            altJid: anyC.lidJid ?? anyC.pnJid ?? null,
            name: c.name ?? null,
            unreadCount: c.unreadCount ?? 0,
            lastMessageAt: c.conversationTimestamp ? toNumber(c.conversationTimestamp as any) : null,
          });
        }
        for (const m of messages) {
          const r = toRecord(m, false);
          if (r) store.ingestMessage(r);
        }
      });
      tx();
      this.events.emit('history', messages.length);
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) {
        const r = toRecord(m, type === 'notify');
        if (r) store.ingestMessage(r);
      }
    });

    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        if (key.remoteJid && key.id && typeof update.status === 'number') {
          store.updateMessageStatus(key.remoteJid, key.id, STATUS_NAMES[update.status] ?? 'sent');
        }
      }
    });

    sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) if (c.id) store.upsertChat({ jid: c.id, name: c.name ?? null, unreadCount: c.unreadCount ?? null });
    });
    sock.ev.on('chats.update', (chats) => {
      for (const c of chats) if (c.id) store.upsertChat({ jid: c.id, name: c.name ?? null, unreadCount: c.unreadCount ?? null });
    });
    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) store.upsertContact({ jid: c.id, lid: c.lid, pn: c.phoneNumber, name: c.name, notify: c.notify, verifiedName: c.verifiedName });
    });
    sock.ev.on('contacts.update', (contacts) => {
      for (const c of contacts) if (c.id) store.upsertContact({ jid: c.id, lid: c.lid, pn: c.phoneNumber, name: c.name, notify: c.notify, verifiedName: c.verifiedName });
    });
    sock.ev.on('lid-mapping.update', (m) => store.addLidMapping(m.lid, m.pn));
  }

  private handleClose(code: number | undefined, registered: boolean): void {
    this.opts.logger.warn({ code }, 'whatsapp connection closed');
    if (this.stopped) {
      this.state = this.state === 'restricted' ? 'restricted' : 'disconnected';
      return;
    }
    if (code === DisconnectReason.loggedOut) {
      this.wipeAuth();
      this.state = 'disconnected';
      this.error = 'Logged out from the phone. Run whatzmcp login to link again.';
      this.events.emit('logged-out');
      return;
    }
    if (code === DisconnectReason.forbidden) {
      this.opts.store.setState('blocked', new Date().toISOString());
      this.state = 'restricted';
      this.error = 'WhatsApp refused this session (403). Sending is stopped. Check the phone, then run whatzmcp logout and whatzmcp login.';
      this.events.emit('blocked');
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      this.state = 'disconnected';
      this.error = 'Another session with the same login took over. Only run one whatzmcp at a time.';
      this.events.emit('replaced');
      return;
    }
    if (!registered && code !== DisconnectReason.restartRequired) {
      // Pairing window ended without a scan.
      this.state = 'disconnected';
      this.qr = null;
      this.error = 'Not linked. Call connect_whatsapp (or run whatzmcp login) to get a new QR code.';
      this.events.emit('pairing-timeout');
      return;
    }
    // Transient: reconnect, immediately after a pairing restart, otherwise with backoff.
    this.state = 'connecting';
    const delay = code === DisconnectReason.restartRequired ? 0 : this.backoffMs;
    this.backoffMs = Math.min(60_000, this.backoffMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((err) => {
        this.opts.logger.error({ err }, 'reconnect failed');
        this.handleClose(undefined, registered);
      });
    }, delay);
  }

  async startPairing(opts: { method: 'qr' | 'code'; phone?: string; timeoutMs: number }): Promise<{ qr?: string; pairingCode?: string; status: ConnectionStatus }> {
    if (this.state === 'connected' || this.state === 'restricted') return { status: this.state };
    this.kind = opts.method;
    this.opts.store.setState('connect_kind', opts.method);
    if (opts.method === 'code') {
      if (!opts.phone) throw new Error('phone_number is required for the pairing code method.');
      // Restart so the code is requested on a fresh socket.
      if (this.sock && !this.sock.authState.creds.registered) await this.stop();
      this.pairingPhone = opts.phone;
    }
    const result = new Promise<{ qr?: string; pairingCode?: string; status: ConnectionStatus }>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve({ status: this.state });
      }, opts.timeoutMs);
      const onQr = (qr: string) => {
        if (opts.method === 'qr') done({ qr, status: this.state });
      };
      const onCode = (code: string) => done({ pairingCode: code, status: this.state });
      const onCodeErr = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onOpen = () => done({ status: 'connected' });
      const done = (v: { qr?: string; pairingCode?: string; status: ConnectionStatus }) => {
        cleanup();
        resolve(v);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.events.off('qr', onQr);
        this.events.off('pairing-code', onCode);
        this.events.off('pairing-code-error', onCodeErr);
        this.events.off('open', onOpen);
      };
      this.events.on('qr', onQr);
      this.events.on('pairing-code', onCode);
      this.events.on('pairing-code-error', onCodeErr);
      this.events.on('open', onOpen);
    });
    const existing = this.currentQr();
    if (opts.method === 'qr' && existing) return { qr: existing.qr, status: this.state };
    if (!this.sock) await this.start();
    return result;
  }

  /** Waits for the connection to open, or gives up after timeoutMs. */
  waitForOpen(timeoutMs: number): Promise<boolean> {
    if (this.state === 'connected') return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.events.off('open', on);
        resolve(false);
      }, timeoutMs);
      const on = () => {
        clearTimeout(t);
        resolve(true);
      };
      this.events.once('open', on);
    });
  }

  /** Closes the socket without logging out. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const s = this.sock;
    this.sock = null;
    if (s) {
      try {
        s.end(undefined);
      } catch {
        /* already closed */
      }
    }
    if (this.state !== 'restricted') this.state = 'disconnected';
  }

  async logout(): Promise<void> {
    const s = this.sock;
    this.stopped = true;
    if (s && this.state === 'connected') {
      try {
        await s.logout();
      } catch {
        /* the local wipe below still unlinks this machine */
      }
    }
    await this.stop();
    this.wipeAuth();
    const store = this.opts.store;
    store.setState('blocked', null);
    this.state = 'disconnected';
    this.error = null;
  }

  private wipeAuth(): void {
    rmSync(this.opts.paths.auth, { recursive: true, force: true });
    this.opts.store.setState('registered', null);
  }

  ownPhone(): string | null {
    return phoneOf(this.ownJid()) ?? null;
  }
}
