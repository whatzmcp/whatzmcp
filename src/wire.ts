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
  media: { url?: string; content_type: string } | null;
  status: string;
  error: { code: number; message: string } | null;
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
  channel: string;
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
    media: null,
    status: row.status ?? (row.from_me ? 'sent' : 'received'),
    timestamp: iso(row.ts),
    error: null,
    contact: { id: contactId },
    chat_id: row.chat_jid,
  };
  const phone = phoneOf(contactId);
  if (phone) msg.contact.phone = phone;
  if (name) msg.contact.name = name;
  if (row.media_type) msg.media = { content_type: row.mimetype ?? row.media_type };
  if (row.status === 'failed') msg.error = { code: 0, message: 'WhatsApp did not accept this message.' };
  return msg;
}

export function toWireChat(row: ChatRow): WireChat {
  return {
    chat_id: row.jid,
    channel: CHANNEL,
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

/** The refusal of a lifecycle tool (connect, QR, status, disconnect): the hosted connection API shape. */
export interface LifecycleRefusal {
  success: false;
  error_code: number;
  error: string;
  retry_after_s?: number;
}

/** A lifecycle refusal with an HTTP status as its code. */
export class LifecycleError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

/** HTTP status for a shared error code, when a lifecycle tool hits one. */
function httpStatusFor(code: string): number {
  if (code.startsWith('invalid_')) return 400;
  switch (code) {
    case 'account_suspended':
      return 403;
    case 'no_connected_account':
    case 'account_not_found':
      return 404;
    case 'code_required':
    case 'password_required':
      return 409;
    case 'rate_limited':
      return 429;
    default:
      return 502;
  }
}

export function toLifecycleRefusal(err: unknown): LifecycleRefusal {
  let r: LifecycleRefusal;
  if (err instanceof LifecycleError) {
    r = { success: false, error_code: err.status, error: err.message };
    if (err.retryAfterS !== undefined) r.retry_after_s = err.retryAfterS;
  } else if (err instanceof ToolError) {
    r = { success: false, error_code: httpStatusFor(err.code), error: err.message };
    if (err.retryAfterS !== undefined) r.retry_after_s = err.retryAfterS;
  } else {
    r = { success: false, error_code: 502, error: (err as Error)?.message ?? String(err) };
  }
  return r;
}
