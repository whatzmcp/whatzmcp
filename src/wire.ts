import type { ChatRow, MessageRow, Store } from './db.js';
import { isGroupJid, phoneOf } from './jid.js';

/** door-contract 1.0 shapes. */
export const CONTRACT_VERSION = '1.0';
export const CHANNEL = 'whatsapp_web';
export const ACCOUNT_ID = 'local';

export interface WireMessage {
  id: string;
  account_id: string;
  channel: string;
  direction: 'inbound' | 'outbound';
  text: string;
  media?: { url?: string; content_type: string };
  status: string;
  error?: { code: string; message: string };
  timestamp: string;
  contact: { id: string; phone?: string; name?: string };
  chat_id: string;
}

export interface WireAccount {
  id: string;
  channel: string;
  connect_kind: string;
  identifier: string | null;
  status: 'connected' | 'connecting' | 'disconnected' | 'restricted';
  connected_at: string | null;
  limits: {
    sends_today: number;
    sends_cap: number;
    new_contacts_today: number;
    new_contacts_cap: number;
    ramp_day: number | null;
  };
}

export interface WireChat {
  chat_id: string;
  name: string | null;
  type: 'user' | 'group' | 'channel';
  unread_count: number;
  last_message_at: string | null;
}

export interface WireError {
  error_code: string;
  error: string;
  retry_after_s?: number;
}

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

export function toWireMessage(row: MessageRow, store: Store, ownJid: string | null): WireMessage {
  const direction = row.from_me ? 'outbound' : 'inbound';
  // contact = the other person in a 1:1 chat, or the sender in a group.
  let contactId = row.chat_jid;
  if (isGroupJid(row.chat_jid)) contactId = row.from_me ? (ownJid ?? row.chat_jid) : (row.sender_jid ?? row.chat_jid);
  const name = (isGroupJid(row.chat_jid) && !row.from_me ? row.sender_name : null) ?? store.nameFor(contactId) ?? undefined;
  const msg: WireMessage = {
    id: row.id,
    account_id: ACCOUNT_ID,
    channel: CHANNEL,
    direction,
    text: row.text ?? '',
    status: row.status ?? (row.from_me ? 'sent' : 'received'),
    timestamp: iso(row.ts),
    contact: { id: contactId },
    chat_id: row.chat_jid,
  };
  const phone = phoneOf(contactId);
  if (phone) msg.contact.phone = phone;
  if (name) msg.contact.name = name;
  if (row.media_type) msg.media = { content_type: row.mimetype ?? row.media_type };
  if (row.status === 'failed') msg.error = { code: 'send_failed', message: 'WhatsApp did not accept this message.' };
  return msg;
}

export function toWireChat(row: ChatRow): WireChat {
  return {
    chat_id: row.jid,
    name: row.name,
    type: row.is_group ? 'group' : row.jid.endsWith('@newsletter') ? 'channel' : 'user',
    unread_count: row.unread_count,
    last_message_at: row.last_message_at ? iso(row.last_message_at) : null,
  };
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
  }

  toWire(): WireError {
    const e: WireError = { error_code: this.code, error: this.message };
    if (this.retryAfterS !== undefined) e.retry_after_s = this.retryAfterS;
    return e;
  }
}
