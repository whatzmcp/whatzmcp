import QRCode from 'qrcode';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { BufferJSON } from '@whiskeysockets/baileys';
import { normaliseJid, parseE164, phoneOf } from './jid.js';
import type { ConnectionLike } from './port.js';
import { localDayString } from './safety.js';
import { Sender } from './sender.js';
import { ACCOUNT_ID, CHANNEL, CONTRACT_VERSION, toWireChat, toWireMessage, ToolError, type WireAccount } from './wire.js';

export interface ToolContext {
  store: Store;
  conn: ConnectionLike;
  sender: Sender;
  config: () => Config;
  /** Upper bound for wait_for_messages, in seconds (tests lower it). */
  maxWaitS?: number;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  handler: (args: any) => Promise<CallToolResult>;
}

export const SERVER_INSTRUCTIONS =
  'whatzmcp, door-contract 1.0. Your own WhatsApp account through a linked device on this machine. ' +
  'If get_whatsapp_status says disconnected, call connect_whatsapp and show the user the QR code (or the pairing code). ' +
  'send_message takes exactly one recipient: to.phone (E.164) or to.contact_id (a chat_id from list_chats). There is no bulk sending. ' +
  'Daily limits follow a warm-up ramp from the pairing day; a refused send returns JSON with error_code and nothing is sent or queued. ' +
  'Use wait_for_messages with the returned cursor to follow new inbound messages.';

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

export function errorResult(err: unknown): CallToolResult {
  const e = err instanceof ToolError ? err : new ToolError('send_failed', (err as Error)?.message ?? String(err));
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(e.toWire()) }] };
}

function wrap(fn: (args: any) => Promise<CallToolResult>): (args: any) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args ?? {});
    } catch (err) {
      return errorResult(err);
    }
  };
}

const accountId = z.string().optional().describe('Account id from list_accounts. Optional: this server has one account, "local".');

export function buildTools(ctx: ToolContext): ToolDef[] {
  const { store, conn, sender } = ctx;

  const checkAccount = (id: unknown) => {
    if (id !== undefined && id !== ACCOUNT_ID) throw new ToolError('no_connected_account', `Unknown account_id "${id}". This server has one account: "${ACCOUNT_ID}".`);
  };

  const resolveChat = (chatId: string): string => {
    const raw = chatId.trim();
    const digits = parseE164(raw);
    const jid = digits ? `${digits}@s.whatsapp.net` : normaliseJid(raw);
    const chat = store.getChat(jid);
    if (!chat) throw new ToolError('contact_not_found', `No chat with id ${chatId}. Use list_chats to find one.`);
    return chat.jid;
  };

  const account = (): WireAccount => {
    const u = sender.usage();
    return {
      id: ACCOUNT_ID,
      channel: CHANNEL,
      connect_kind: conn.connectKind(),
      identifier: phoneOf(conn.ownJid()) ?? null,
      status: conn.status(),
      connected_at: conn.connectedAt()?.toISOString() ?? null,
      limits: {
        sends_today: u.sends,
        sends_cap: u.caps.messages,
        new_contacts_today: u.newContacts,
        new_contacts_cap: u.caps.newContacts,
        ramp_day: u.caps.day,
      },
    };
  };

  const own = () => conn.ownJid();

  const qrImage = async (qr: string) => (await QRCode.toBuffer(qr, { type: 'png', width: 384, margin: 2 })).toString('base64');

  const QR_STEPS = 'On your phone open WhatsApp, go to Settings, Linked devices, Link a device, and scan this code.';
  const CODE_STEPS = 'On your phone open WhatsApp, go to Settings, Linked devices, Link a device, tap "Link with phone number instead" and enter this code.';

  return [
    {
      name: 'list_accounts',
      title: 'List accounts',
      description: 'List the WhatsApp accounts on this server. A self-hosted whatzmcp has exactly one account, id "local".',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      handler: wrap(async () => json({ accounts: [account()] })),
    },
    {
      name: 'send_message',
      title: 'Send a message',
      description:
        'Send one WhatsApp message to ONE recipient: to.phone (E.164, for example +14155550123) or to.contact_id (a chat_id from list_chats, groups included). ' +
        'Optional media: media_url (https) or media_path (absolute local file); text becomes the caption. reply_to quotes a message id. ' +
        'Shows "typing..." first. Daily caps and the new contact delay apply; a refusal sends nothing and returns error_code. Lists of recipients are rejected.',
      inputSchema: {
        account_id: accountId,
        to: z
          .object({
            phone: z.string().optional().describe('One phone number in E.164 format.'),
            contact_id: z.string().optional().describe('One chat id from list_chats or from a message.'),
          })
          .describe('Exactly one recipient. Pass phone OR contact_id.'),
        text: z.string().max(4096).optional().describe('Message text, or the caption when media is attached. Up to 4096 characters.'),
        media_url: z.string().optional().describe('https URL of an image, video, audio file or document to attach.'),
        reply_to: z.string().optional().describe('Id of a stored message to quote.'),
        media_path: z.string().optional().describe('Local only: absolute path of a file on this machine to attach.'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
      handler: wrap(async (a) => {
        checkAccount(a.account_id);
        return json(await sender.send({ to: a.to, text: a.text, media_url: a.media_url, media_path: a.media_path, reply_to: a.reply_to }));
      }),
    },
    {
      name: 'get_message',
      title: 'Get a message',
      description: 'Get one stored message by its id.',
      inputSchema: { id: z.string().describe('Message id.') },
      annotations: { readOnlyHint: true },
      handler: wrap(async (a) => {
        const row = store.getMessage(a.id);
        if (!row) throw new ToolError('message_not_found', `No stored message with id ${a.id}.`);
        return json(toWireMessage(row, store, own()));
      }),
    },
    {
      name: 'list_messages',
      title: 'List messages',
      description: 'List stored messages, newest first, across all chats or in one chat_id. Page back with before = next_cursor.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('1 to 100, default 50.'),
        direction: z.enum(['inbound', 'outbound']).optional(),
        account_id: accountId,
        before: z.string().optional().describe('Cursor from next_cursor of the previous page.'),
        chat_id: z.string().optional().describe('Only this chat (a chat_id from list_chats, or a phone number).'),
      },
      annotations: { readOnlyHint: true },
      handler: wrap(async (a) => {
        checkAccount(a.account_id);
        const limit = a.limit ?? 50;
        const chatJid = a.chat_id ? resolveChat(a.chat_id) : undefined;
        const beforeSeq = a.before !== undefined ? Number(a.before) : undefined;
        if (beforeSeq !== undefined && !Number.isInteger(beforeSeq)) throw new ToolError('invalid_recipient', 'before must be a cursor returned by list_messages.');
        const rows = store.listMessages({ chatJid, direction: a.direction, beforeSeq, limit });
        return json({
          messages: rows.map((r) => toWireMessage(r, store, own())),
          next_cursor: rows.length === limit ? String(rows[rows.length - 1].seq) : null,
        });
      }),
    },
    {
      name: 'wait_for_messages',
      title: 'Wait for new messages',
      description:
        'Wait until new inbound messages arrive (long poll), then return them in arrival order with a cursor. ' +
        'Pass the returned cursor on the next call so nothing is missed. Without a cursor it starts from now.',
      inputSchema: {
        cursor: z.string().optional().describe('Cursor from the previous call.'),
        account_id: accountId,
        timeout_s: z.number().int().min(0).max(55).optional().describe('0 to 55 seconds, default 25.'),
        chat_id: z.string().optional().describe('Only wait for this chat.'),
      },
      annotations: { readOnlyHint: true },
      handler: wrap(async (a) => {
        checkAccount(a.account_id);
        const st = conn.status();
        if (st === 'restricted') throw new ToolError('account_suspended', conn.lastError() ?? 'WhatsApp refused this session (403).');
        if (st === 'disconnected') throw new ToolError('no_connected_account', conn.lastError() ?? 'WhatsApp is not connected. Call connect_whatsapp.');
        const chatJid = a.chat_id ? resolveChat(a.chat_id) : undefined;
        let start = a.cursor !== undefined ? Number(a.cursor) : store.maxSeq();
        if (!Number.isInteger(start)) start = store.maxSeq();
        const timeoutMs = Math.min(a.timeout_s ?? 25, ctx.maxWaitS ?? 55) * 1000;
        let rows = store.inboundAfter(start, chatJid);
        if (!rows.length && timeoutMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(finish, timeoutMs);
            function onInbound() {
              if (store.inboundAfter(start, chatJid, 1).length) finish();
            }
            function finish() {
              clearTimeout(timer);
              store.events.off('inbound', onInbound);
              resolve();
            }
            store.events.on('inbound', onInbound);
          });
          rows = store.inboundAfter(start, chatJid);
        }
        const cursor = rows.length ? rows[rows.length - 1].seq : start;
        return json({ messages: rows.map((r) => toWireMessage(r, store, own())), cursor: String(cursor) });
      }),
    },
    {
      name: 'get_usage',
      title: 'Get usage',
      description: "Today's sends and new contacts against the caps, and the warm-up day.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      handler: wrap(async () => {
        const u = sender.usage();
        return json({
          plan: 'self-hosted',
          day: localDayString(u.day),
          sends: u.sends,
          sends_cap: u.caps.messages,
          new_contacts: u.newContacts,
          new_contacts_cap: u.caps.newContacts,
          ramp_day: u.caps.day,
          contract_version: CONTRACT_VERSION,
        });
      }),
    },
    {
      name: 'list_chats',
      title: 'List chats',
      description: 'List WhatsApp chats, most recent first. Filter by name or number with query, and by type (user, group, channel).',
      inputSchema: {
        account_id: accountId,
        query: z.string().optional().describe('Part of a name or phone number.'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
        type: z.enum(['user', 'group', 'channel']).optional(),
      },
      annotations: { readOnlyHint: true },
      handler: wrap(async (a) => {
        checkAccount(a.account_id);
        const rows = store.listChats({ query: a.query, limit: a.limit ?? 50, type: a.type });
        return json({ chats: rows.map(toWireChat) });
      }),
    },
    {
      name: 'search_messages',
      title: 'Search messages',
      description: 'Full text search over stored messages, newest first. Every word must match; the last word matches as a prefix.',
      inputSchema: {
        query: z.string().min(1).describe('Words to find.'),
        account_id: accountId,
        chat_id: z.string().optional().describe('Only search this chat.'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
      },
      annotations: { readOnlyHint: true },
      handler: wrap(async (a) => {
        checkAccount(a.account_id);
        const chatJid = a.chat_id ? resolveChat(a.chat_id) : undefined;
        const rows = store.searchMessages(a.query, { chatJid, limit: a.limit ?? 20 });
        return json({ messages: rows.map((r) => toWireMessage(r, store, own())) });
      }),
    },
    {
      name: 'mark_read',
      title: 'Mark a chat as read',
      description: 'Send read receipts for the latest messages in a chat and clear its unread count.',
      inputSchema: { chat_id: z.string().describe('A chat_id from list_chats.'), account_id: accountId },
      annotations: { idempotentHint: true },
      handler: wrap(async (a) => {
        checkAccount(a.account_id);
        const chatJid = resolveChat(a.chat_id);
        const sock = conn.socket();
        if (!sock) throw new ToolError(conn.status() === 'restricted' ? 'account_suspended' : 'no_connected_account', conn.lastError() ?? 'WhatsApp is not connected.');
        const keys = store
          .recentInbound(chatJid, 20)
          .map((r) => {
            if (r.raw) {
              try {
                return JSON.parse(r.raw, BufferJSON.reviver).key;
              } catch {
                /* fall through */
              }
            }
            return { remoteJid: r.chat_jid, id: r.id, fromMe: false, participant: r.sender_jid ?? undefined };
          })
          .filter(Boolean);
        if (keys.length) await sock.readMessages(keys);
        store.markChatRead(chatJid);
        return json({ marked: true });
      }),
    },
    {
      name: 'connect_whatsapp',
      title: 'Connect WhatsApp',
      description:
        'Link your WhatsApp account to this server as a linked device. method "qr" (default) returns a QR code to scan; ' +
        'method "code" with phone_number (E.164) returns an 8 character pairing code to type on the phone. No-op when already connected.',
      inputSchema: {
        phone_number: z.string().optional().describe('Your WhatsApp number in E.164, needed for method "code".'),
        method: z.enum(['qr', 'code']).optional(),
      },
      handler: wrap(async (a) => {
        const method: 'qr' | 'code' = a.method ?? (a.phone_number ? 'code' : 'qr');
        if (conn.status() === 'restricted') throw new ToolError('account_suspended', conn.lastError() ?? 'WhatsApp refused this session (403).');
        if (conn.status() === 'connected') return json({ account_id: ACCOUNT_ID, status: 'connected' });
        let digits: string | undefined;
        if (method === 'code') {
          digits = a.phone_number ? (parseE164(a.phone_number) ?? undefined) : undefined;
          if (!digits) throw new ToolError('invalid_recipient', 'method "code" needs phone_number in E.164 format, for example +14155550123.');
        }
        const r = await conn.startPairing({ method, phone: digits, timeoutMs: 20_000 });
        if (r.status === 'connected') return json({ account_id: ACCOUNT_ID, status: 'connected' });
        if (method === 'code') {
          if (!r.pairingCode) throw new ToolError('no_connected_account', 'Could not get a pairing code from WhatsApp. Check the internet connection and try again.');
          const code = r.pairingCode.length === 8 ? `${r.pairingCode.slice(0, 4)}-${r.pairingCode.slice(4)}` : r.pairingCode;
          return json({ account_id: ACCOUNT_ID, status: 'connecting', pairing_code: code, instructions: CODE_STEPS });
        }
        if (!r.qr) throw new ToolError('no_connected_account', 'Could not get a QR code from WhatsApp. Check the internet connection and try again.');
        const png = await qrImage(r.qr);
        return {
          content: [
            { type: 'image', data: png, mimeType: 'image/png' },
            { type: 'text', text: JSON.stringify({ account_id: ACCOUNT_ID, status: 'connecting', qr_png_base64: png, instructions: QR_STEPS }) },
          ],
        };
      }),
    },
    {
      name: 'get_whatsapp_qr',
      title: 'Get the pairing QR code',
      description: 'Get the current pairing QR code as an image, with how many seconds it stays valid. Starts linking if needed.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      handler: wrap(async () => {
        if (conn.status() === 'restricted') throw new ToolError('account_suspended', conn.lastError() ?? 'WhatsApp refused this session (403).');
        if (conn.status() === 'connected') return json({ status: 'connected', expires_in_s: 0 });
        let cur = conn.currentQr();
        if (!cur) {
          const r = await conn.startPairing({ method: 'qr', timeoutMs: 20_000 });
          if (r.status === 'connected') return json({ status: 'connected', expires_in_s: 0 });
          cur = conn.currentQr() ?? (r.qr ? { qr: r.qr, expiresInS: 20 } : null);
        }
        if (!cur) throw new ToolError('no_connected_account', 'Could not get a QR code from WhatsApp. Check the internet connection and try again.');
        return {
          content: [
            { type: 'image', data: await qrImage(cur.qr), mimeType: 'image/png' },
            { type: 'text', text: JSON.stringify({ status: 'connecting', expires_in_s: cur.expiresInS, instructions: QR_STEPS }) },
          ],
        };
      }),
    },
    {
      name: 'get_whatsapp_status',
      title: 'Get WhatsApp status',
      description: 'Connection status, own number, and today\'s limits (sends, new contacts, warm-up day).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
      handler: wrap(async () => {
        const a = account() as WireAccount & { error?: string };
        const err = conn.lastError();
        if (err && a.status !== 'connected') a.error = err;
        return json(a);
      }),
    },
    {
      name: 'disconnect_whatsapp',
      title: 'Disconnect WhatsApp',
      description: 'Unlink this linked device from your WhatsApp account and delete the saved session on this machine. Stored messages stay.',
      inputSchema: {},
      annotations: { destructiveHint: true },
      handler: wrap(async () => {
        await conn.logout();
        return json({ disconnected: true });
      }),
    },
  ];
}
