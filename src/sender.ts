import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { BufferJSON } from '@whiskeysockets/baileys';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { isBroadcastJid, isNewsletterJid, isSendableJid, looksLikeList, normaliseJid, parseE164, PN_SERVER } from './jid.js';
import { detectMedia, mediaContent } from './media.js';
import type { ConnectionLike } from './port.js';
import { checkSend, effectiveCaps, jitterMs, startOfLocalDay, typingMs } from './safety.js';
import { ToolError } from './wire.js';

export interface Recipient {
  phone?: unknown;
  contact_id?: unknown;
}

export interface SendRequest {
  to: Recipient | unknown;
  text?: string;
  media_url?: string;
  media_path?: string;
  reply_to?: string;
  /** The person agreed to hear from you. Accepted and logged; it does not lift any limit here. */
  opt_in?: boolean;
}

export interface SendResult {
  message_id: string;
  status: 'sent';
  /** True when the message quotes reply_to. */
  reply_to_applied: boolean;
}

export interface SenderDeps {
  store: Store;
  conn: ConnectionLike;
  config: () => Config;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: { info: (obj: object, msg?: string) => void };
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Checks that `to` is exactly one recipient. Returns the phone digits or the chat id. */
export function parseRecipient(to: unknown): { phone: string } | { contactId: string } {
  if (Array.isArray(to)) throw new ToolError('invalid_recipient', 'Send to one recipient at a time. Lists are not accepted.');
  if (!to || typeof to !== 'object') throw new ToolError('invalid_recipient', 'to must be an object with phone or contact_id.');
  const r = to as Recipient;
  const keys = Object.keys(r).filter((k) => (r as Record<string, unknown>)[k] !== undefined);
  if (keys.length !== 1 || !['phone', 'contact_id'].includes(keys[0])) {
    throw new ToolError('invalid_recipient', 'to must have exactly one of phone or contact_id.');
  }
  const value = keys[0] === 'phone' ? r.phone : r.contact_id;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolError('invalid_recipient', 'Send to one recipient at a time. Lists are not accepted.');
  }
  if (looksLikeList(value)) throw new ToolError('invalid_recipient', 'Send to one recipient at a time. Lists are not accepted.');
  if (keys[0] === 'phone') {
    const digits = parseE164(value);
    if (!digits) throw new ToolError('invalid_recipient', `"${value}" is not a phone number in E.164 format, for example +14155550123.`);
    return { phone: digits };
  }
  return { contactId: value.trim() };
}

/** Sends one message with the limits, delays and typing indicator applied. Sends are serialised. */
export class Sender {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly deps: SenderDeps) {
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? realSleep;
    this.random = deps.random ?? Math.random;
  }

  send(req: SendRequest): Promise<SendResult> {
    const run = this.chain.then(() => this.sendNow(req));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Today's usage and caps, shared by get_usage and get_whatsapp_status. */
  usage(): { day: Date; sends: number; newContacts: number; caps: ReturnType<typeof effectiveCaps> } {
    const now = this.now();
    const counts = this.deps.store.countSends(startOfLocalDay(now).getTime());
    const caps = effectiveCaps(this.deps.config(), this.deps.conn.pairedAt(), now);
    return { day: now, sends: counts.messages, newContacts: counts.newContacts, caps };
  }

  private async resolveChat(to: unknown): Promise<string> {
    const r = parseRecipient(to);
    const { store, conn } = this.deps;
    if ('contactId' in r) {
      const id = normaliseJid(r.contactId);
      if (isBroadcastJid(id) || isNewsletterJid(id)) throw new ToolError('invalid_recipient', 'Broadcast lists, status and channels cannot be messaged.');
      const chat = store.getChat(id);
      if (chat) return chat.jid;
      if (isSendableJid(id) && store.nameFor(id) !== null) return store.canonicalJid(id).jid;
      throw new ToolError('contact_not_found', `No chat with id ${r.contactId}. Use list_chats to find one, or send to a phone number.`);
    }
    const pnJid = `${r.phone}@${PN_SERVER}`;
    const known = store.getChat(pnJid);
    if (known) return known.jid;
    const sock = conn.socket();
    if (!sock) throw new ToolError('no_connected_account', 'WhatsApp is not connected.');
    const res = await sock.onWhatsApp(r.phone);
    const hit = res?.find((x) => x.exists);
    if (!hit) throw new ToolError('invalid_recipient', `+${r.phone} is not on WhatsApp.`);
    return store.canonicalJid(hit.jid).jid;
  }

  private async sendNow(req: SendRequest): Promise<SendResult> {
    const { store, conn } = this.deps;
    const config = this.deps.config();
    if (typeof req.text !== 'string' || req.text.length === 0) throw new ToolError('invalid_text', 'text is required. With media it is the caption.');
    const text = req.text;
    if (text.length > 4096) throw new ToolError('invalid_text', 'text is longer than 4096 characters.');
    if (req.media_url && req.media_path) throw new ToolError('invalid_request', 'Pass media_url or media_path, not both.');
    if (!text.trim() && !req.media_url && !req.media_path) throw new ToolError('invalid_text', 'text is empty.');

    // Validate the recipient shape before anything that needs the connection.
    parseRecipient(req.to);

    const status = conn.status();
    if (status === 'restricted') {
      throw new ToolError('account_suspended', 'WhatsApp refused this session (403). Sending is stopped. Check the phone, then run whatzmcp logout and whatzmcp login.');
    }
    const sock = conn.socket();
    if (status !== 'connected' || !sock) {
      throw new ToolError('no_connected_account', conn.lastError() ?? 'WhatsApp is not connected. Run whatzmcp login or call connect_whatsapp.');
    }

    // Media checks come before any limit is used.
    let media: Buffer | { url: string } | null = null;
    let mediaInfo: ReturnType<typeof detectMedia> | null = null;
    if (req.media_url) {
      let u: URL;
      try {
        u = new URL(req.media_url);
      } catch {
        throw new ToolError('invalid_media_url', 'media_url is not a valid URL.');
      }
      if (u.protocol !== 'https:') throw new ToolError('invalid_media_url', 'media_url must start with https://');
      media = { url: u.toString() };
      mediaInfo = detectMedia(u.toString());
    } else if (req.media_path) {
      if (!isAbsolute(req.media_path)) throw new ToolError('media_unavailable', 'media_path must be an absolute path.');
      let size: number;
      try {
        const st = await stat(req.media_path);
        if (!st.isFile()) throw new Error('not a file');
        size = st.size;
      } catch {
        throw new ToolError('media_unavailable', `Cannot read ${req.media_path}.`);
      }
      if (size > config.max_media_mb * 1024 * 1024) {
        throw new ToolError('media_unavailable', `File is larger than ${config.max_media_mb} MB (max_media_mb in config.json).`);
      }
      media = await readFile(req.media_path);
      mediaInfo = detectMedia(req.media_path);
    }

    let quoted: unknown;
    if (req.reply_to) {
      const row = store.getMessage(req.reply_to);
      if (!row) throw new ToolError('message_not_found', `No stored message with id ${req.reply_to} to reply to.`);
      // A stored message without its original payload cannot be quoted: it is sent without the quote.
      if (row.raw) {
        try {
          quoted = JSON.parse(row.raw, BufferJSON.reviver);
        } catch {
          quoted = undefined;
        }
      }
    }

    const chatJid = await this.resolveChat(req.to);
    if (req.opt_in) this.deps.logger?.info({ chat: chatJid, opt_in: true }, 'send_message with opt_in');
    const isNew = store.isNewContact(chatJid);
    const now = this.now();
    const u = this.usage();
    const refusal = checkSend({ caps: u.caps, usage: { messagesToday: u.sends, newContactsToday: u.newContacts }, isNewContact: isNew, now });
    if (refusal) throw new ToolError(refusal.error_code, refusal.error, refusal.retry_after_s);

    if (isNew) {
      const nextAt = Number(store.getState('next_new_contact_at') ?? 0);
      if (nextAt > now.getTime()) {
        const wait = Math.ceil((nextAt - now.getTime()) / 1000);
        throw new ToolError('rate_limited', `Wait ${wait} seconds before messaging another new contact. Replies to existing chats are not affected.`, wait);
      }
    }

    // Small random gap between any two sends.
    const last = store.lastSendAt();
    if (last !== null) {
      const gap = jitterMs(config.send_delay_seconds, this.random);
      const waitMs = last + gap - this.now().getTime();
      if (waitMs > 0) await this.sleep(waitMs);
    }

    if (config.typing_indicator) {
      try {
        await sock.sendPresenceUpdate('composing', chatJid);
        await this.sleep(typingMs(text));
        await sock.sendPresenceUpdate('paused', chatJid);
      } catch {
        /* presence is best effort */
      }
    }

    const content = media && mediaInfo ? mediaContent(media, mediaInfo.kind, mediaInfo.mimetype, mediaInfo.fileName, text) : { text, linkPreview: null };
    let sent: any;
    try {
      sent = await sock.sendMessage(chatJid, content, quoted ? { quoted } : undefined);
    } catch (err) {
      if (this.deps.conn.status() === 'restricted') throw new ToolError('account_suspended', 'WhatsApp refused this session (403). Sending is stopped.');
      const msg = (err as Error).message || String(err);
      if (media && /fetch|ENOTFOUND|ECONN|status code|40\d|50\d|timeout/i.test(msg)) throw new ToolError('media_unavailable', `Could not get the media: ${msg}`);
      throw new ToolError('send_failed', `WhatsApp did not accept the message: ${msg}`);
    }

    const messageId: string = sent?.key?.id ?? '';
    const at = this.now().getTime();
    store.recordSend({ atMs: at, chatJid, messageId: messageId || null, kind: media ? 'media' : 'text', newContact: isNew });
    if (isNew) store.setState('next_new_contact_at', String(at + jitterMs(config.new_contact_delay_seconds, this.random)));
    if (messageId) {
      store.ingestMessage({
        id: messageId,
        chatJid,
        fromMe: true,
        ts: Math.floor(at / 1000),
        text: text || null,
        mediaType: mediaInfo?.kind ?? null,
        mimetype: mediaInfo?.mimetype ?? null,
        status: 'sent',
        live: true,
        raw: sent ? JSON.stringify({ key: sent.key, message: sent.message }, BufferJSON.replacer) : null,
      });
    }
    return { message_id: messageId, status: 'sent', reply_to_applied: quoted !== undefined };
  }
}
