import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { isGroupJid, isLidJid, isPnJid, normaliseJid } from './jid.js';

export interface MessageRecord {
  id: string;
  chatJid: string;
  /** The other id of the same chat (LID or phone jid), when known. */
  chatAltJid?: string | null;
  fromMe: boolean;
  senderJid?: string | null;
  senderAltJid?: string | null;
  senderName?: string | null;
  /** Unix seconds. */
  ts: number;
  text?: string | null;
  mediaType?: string | null;
  mimetype?: string | null;
  status?: string | null;
  /** Arrived while connected (not from history sync). */
  live?: boolean;
  raw?: string | null;
}

export interface MessageRow {
  seq: number;
  id: string;
  chat_jid: string;
  from_me: number;
  sender_jid: string | null;
  sender_name: string | null;
  ts: number;
  text: string | null;
  media_type: string | null;
  mimetype: string | null;
  status: string | null;
  live: number;
  raw: string | null;
}

export interface ChatRow {
  jid: string;
  alt_jid: string | null;
  name: string | null;
  is_group: number;
  unread_count: number;
  last_message_at: number | null;
}

export interface ContactRecord {
  jid: string;
  lid?: string | null;
  pn?: string | null;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}

export interface ChatRecord {
  jid: string;
  altJid?: string | null;
  name?: string | null;
  unreadCount?: number | null;
  lastMessageAt?: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS lid_map (lid TEXT PRIMARY KEY, pn TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS lid_map_pn ON lid_map(pn);
CREATE TABLE IF NOT EXISTS contacts (
  jid TEXT PRIMARY KEY, lid TEXT, pn TEXT, name TEXT, notify TEXT, verified_name TEXT, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY, alt_jid TEXT, name TEXT, is_group INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0, last_message_at INTEGER
);
CREATE INDEX IF NOT EXISTS chats_alt ON chats(alt_jid);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL, chat_jid TEXT NOT NULL, from_me INTEGER NOT NULL,
  sender_jid TEXT, sender_name TEXT, ts INTEGER NOT NULL,
  text TEXT, media_type TEXT, mimetype TEXT, status TEXT,
  live INTEGER NOT NULL DEFAULT 0, raw TEXT,
  UNIQUE(chat_jid, id)
);
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_jid, ts);
CREATE INDEX IF NOT EXISTS messages_id ON messages(id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='seq');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.seq, coalesce(new.text, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.seq, coalesce(old.text, ''));
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.seq, coalesce(old.text, ''));
  INSERT INTO messages_fts(rowid, text) VALUES (new.seq, coalesce(new.text, ''));
END;
CREATE TABLE IF NOT EXISTS send_ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL, chat_jid TEXT NOT NULL, message_id TEXT,
  kind TEXT NOT NULL, new_contact INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS send_ledger_at ON send_ledger(at_ms);
`;

/** Turns free text into a safe FTS5 query: every word must appear (prefix match on the last). */
export function ftsQuery(input: string): string | null {
  const words = input
    .split(/\s+/)
    .map((w) => w.replace(/["]/g, '').trim())
    .filter(Boolean);
  if (!words.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

/** Local SQLite store for chats, contacts, messages, the send ledger and small state values. */
export class Store {
  readonly db: Database.Database;
  /** Emits "inbound" with the seq of every live inbound message that was newly inserted. */
  readonly events = new EventEmitter();

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.events.setMaxListeners(100);
  }

  close(): void {
    this.db.close();
  }

  // ---- state ----
  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setState(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM state WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- LID and phone ids ----
  /** Records that a LID and a phone jid are the same person, and folds a LID chat into the phone chat. */
  addLidMapping(lidJid: string, pnJid: string): void {
    const lid = normaliseJid(lidJid);
    const pn = normaliseJid(pnJid);
    if (!isLidJid(lid) || !isPnJid(pn)) return;
    const existing = this.db.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(lid) as { pn: string } | undefined;
    if (existing?.pn === pn) return;
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT INTO lid_map(lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn').run(lid, pn);
      // Move a chat stored under the LID to the phone jid.
      const lidChat = this.db.prepare('SELECT * FROM chats WHERE jid = ?').get(lid) as ChatRow | undefined;
      if (lidChat) {
        const pnChat = this.db.prepare('SELECT jid FROM chats WHERE jid = ?').get(pn);
        if (pnChat) {
          this.db
            .prepare(
              `UPDATE chats SET alt_jid = ?, name = coalesce(name, ?),
               last_message_at = max(coalesce(last_message_at, 0), coalesce(?, 0)),
               unread_count = unread_count + ? WHERE jid = ?`,
            )
            .run(lid, lidChat.name, lidChat.last_message_at, lidChat.unread_count, pn);
          this.db.prepare('DELETE FROM chats WHERE jid = ?').run(lid);
        } else {
          this.db.prepare('UPDATE chats SET jid = ?, alt_jid = ? WHERE jid = ?').run(pn, lid, lid);
        }
        this.db.prepare('UPDATE OR IGNORE messages SET chat_jid = ? WHERE chat_jid = ?').run(pn, lid);
        this.db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(lid);
      } else {
        this.db.prepare('UPDATE chats SET alt_jid = ? WHERE jid = ? AND alt_jid IS NULL').run(lid, pn);
      }
    });
    tx();
  }

  pnForLid(lid: string): string | null {
    const row = this.db.prepare('SELECT pn FROM lid_map WHERE lid = ?').get(normaliseJid(lid)) as { pn: string } | undefined;
    return row?.pn ?? null;
  }

  lidForPn(pn: string): string | null {
    const row = this.db.prepare('SELECT lid FROM lid_map WHERE pn = ?').get(normaliseJid(pn)) as { lid: string } | undefined;
    return row?.lid ?? null;
  }

  /** The id a person's chat is stored under: the phone jid when known, else the LID. */
  canonicalJid(jid: string, alt?: string | null): { jid: string; alt: string | null } {
    const a = normaliseJid(jid);
    const b = alt ? normaliseJid(alt) : null;
    if (isLidJid(a)) {
      if (b && isPnJid(b)) {
        this.addLidMapping(a, b);
        return { jid: b, alt: a };
      }
      const pn = this.pnForLid(a);
      return pn ? { jid: pn, alt: a } : { jid: a, alt: null };
    }
    if (isPnJid(a)) {
      if (b && isLidJid(b)) {
        this.addLidMapping(b, a);
        return { jid: a, alt: b };
      }
      return { jid: a, alt: this.lidForPn(a) };
    }
    return { jid: a, alt: null };
  }

  // ---- contacts and chats ----
  upsertContact(c: ContactRecord): void {
    const ids = this.canonicalJid(c.jid, c.lid && c.lid !== c.jid ? c.lid : c.pn);
    if (c.lid && c.pn) this.addLidMapping(c.lid, c.pn);
    this.db
      .prepare(
        `INSERT INTO contacts(jid, lid, pn, name, notify, verified_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET
           lid = coalesce(excluded.lid, lid), pn = coalesce(excluded.pn, pn),
           name = coalesce(excluded.name, name), notify = coalesce(excluded.notify, notify),
           verified_name = coalesce(excluded.verified_name, verified_name), updated_at = excluded.updated_at`,
      )
      .run(
        ids.jid,
        c.lid ?? (isLidJid(ids.alt ?? '') ? ids.alt : null),
        c.pn ?? (isPnJid(ids.jid) ? ids.jid : null),
        c.name ?? null,
        c.notify ?? null,
        c.verifiedName ?? null,
        Date.now(),
      );
  }

  upsertChat(c: ChatRecord): void {
    const ids = this.canonicalJid(c.jid, c.altJid);
    this.db
      .prepare(
        `INSERT INTO chats(jid, alt_jid, name, is_group, unread_count, last_message_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET
           alt_jid = coalesce(excluded.alt_jid, alt_jid), name = coalesce(excluded.name, name),
           unread_count = CASE WHEN ? THEN excluded.unread_count ELSE unread_count END,
           last_message_at = max(coalesce(last_message_at, 0), coalesce(excluded.last_message_at, 0))`,
      )
      .run(
        ids.jid,
        ids.alt,
        c.name ?? null,
        isGroupJid(ids.jid) ? 1 : 0,
        c.unreadCount ?? 0,
        c.lastMessageAt ?? null,
        c.unreadCount === undefined || c.unreadCount === null ? 0 : 1,
      );
  }

  getChat(jid: string): ChatRow | null {
    const n = normaliseJid(jid);
    return (this.db.prepare('SELECT * FROM chats WHERE jid = ? OR alt_jid = ?').get(n, n) as ChatRow | undefined) ?? null;
  }

  /** Display name for a jid from contacts or chats. */
  nameFor(jid: string): string | null {
    const n = normaliseJid(jid);
    const c = this.db
      .prepare('SELECT coalesce(name, notify, verified_name) AS n FROM contacts WHERE jid = ? OR lid = ? OR pn = ?')
      .get(n, n, n) as { n: string | null } | undefined;
    if (c?.n) return c.n;
    const chat = this.getChat(n);
    return chat?.name ?? null;
  }

  listChats(opts: { query?: string; limit: number; type?: 'user' | 'group' | 'channel' }): ChatRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.type === 'group') where.push('c.is_group = 1');
    if (opts.type === 'user') where.push("c.is_group = 0 AND c.jid NOT LIKE '%@newsletter'");
    if (opts.type === 'channel') where.push("c.jid LIKE '%@newsletter'");
    where.push("c.jid NOT LIKE '%@broadcast'");
    if (opts.query) {
      where.push(`(c.name LIKE ? OR c.jid LIKE ? OR ct.name LIKE ? OR ct.notify LIKE ?)`);
      const q = `%${opts.query}%`;
      args.push(q, `%${opts.query.replace(/[^\d]/g, '') || opts.query}%`, q, q);
    }
    const sql = `SELECT c.jid, c.alt_jid, coalesce(c.name, ct.name, ct.notify, ct.verified_name) AS name, c.is_group,
                   c.unread_count, c.last_message_at
                 FROM chats c LEFT JOIN contacts ct ON ct.jid = c.jid
                 WHERE ${where.join(' AND ')}
                 ORDER BY coalesce(c.last_message_at, 0) DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, opts.limit) as ChatRow[];
  }

  markChatRead(jid: string): void {
    this.db.prepare('UPDATE chats SET unread_count = 0 WHERE jid = ?').run(normaliseJid(jid));
  }

  // ---- messages ----
  /** Inserts or updates one message. Returns true when it is new. */
  ingestMessage(m: MessageRecord): boolean {
    const chat = this.canonicalJid(m.chatJid, m.chatAltJid);
    const sender = m.senderJid ? this.canonicalJid(m.senderJid, m.senderAltJid).jid : null;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO messages(id, chat_jid, from_me, sender_jid, sender_name, ts, text, media_type, mimetype, status, live, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const res = insert.run(
      m.id,
      chat.jid,
      m.fromMe ? 1 : 0,
      sender,
      m.senderName ?? null,
      Math.floor(m.ts),
      m.text ?? null,
      m.mediaType ?? null,
      m.mimetype ?? null,
      m.status ?? null,
      m.live ? 1 : 0,
      m.raw ?? null,
    );
    const isNew = res.changes > 0;
    if (!isNew) {
      this.db
        .prepare(
          `UPDATE messages SET text = coalesce(?, text), status = coalesce(?, status),
             sender_name = coalesce(?, sender_name), raw = coalesce(raw, ?) WHERE chat_jid = ? AND id = ?`,
        )
        .run(m.text ?? null, m.status ?? null, m.senderName ?? null, m.raw ?? null, chat.jid, m.id);
    }
    this.upsertChat({ jid: chat.jid, altJid: chat.alt, lastMessageAt: Math.floor(m.ts) });
    if (isNew && m.live && !m.fromMe) {
      this.db.prepare('UPDATE chats SET unread_count = unread_count + 1 WHERE jid = ?').run(chat.jid);
    }
    if (sender && m.senderName && !m.fromMe) {
      this.db
        .prepare(`INSERT INTO contacts(jid, notify, updated_at) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET notify = excluded.notify`)
        .run(sender, m.senderName, Date.now());
    }
    if (isNew && m.live && !m.fromMe) {
      const seq = Number(res.lastInsertRowid);
      this.events.emit('inbound', seq);
    }
    return isNew;
  }

  updateMessageStatus(chatJid: string, id: string, status: string): void {
    const chat = this.canonicalJid(chatJid);
    this.db.prepare('UPDATE messages SET status = ? WHERE chat_jid = ? AND id = ?').run(status, chat.jid, id);
  }

  getMessage(id: string): MessageRow | null {
    return (this.db.prepare('SELECT * FROM messages WHERE id = ? ORDER BY seq DESC LIMIT 1').get(id) as MessageRow | undefined) ?? null;
  }

  /** Newest first. `beforeSeq` pages backwards. */
  listMessages(opts: { chatJid?: string; direction?: 'inbound' | 'outbound'; beforeSeq?: number; limit: number }): MessageRow[] {
    const where: string[] = ['1 = 1'];
    const args: unknown[] = [];
    if (opts.chatJid) {
      where.push('chat_jid = ?');
      args.push(opts.chatJid);
    }
    if (opts.direction) where.push(opts.direction === 'inbound' ? 'from_me = 0' : 'from_me = 1');
    if (opts.beforeSeq !== undefined) {
      // Order by timestamp, then seq, so history sync rows sort by when they were sent.
      where.push('(ts, seq) < (SELECT ts, seq FROM messages WHERE seq = ?)');
      args.push(opts.beforeSeq);
    }
    return this.db
      .prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY ts DESC, seq DESC LIMIT ?`)
      .all(...args, opts.limit) as MessageRow[];
  }

  /** Highest seq stored so far (0 when empty). */
  maxSeq(): number {
    const row = this.db.prepare('SELECT max(seq) AS m FROM messages').get() as { m: number | null };
    return row.m ?? 0;
  }

  /** Live inbound messages inserted after `afterSeq`, in arrival order. */
  inboundAfter(afterSeq: number, chatJid?: string, limit = 100): MessageRow[] {
    const args: unknown[] = [afterSeq];
    let sql = 'SELECT * FROM messages WHERE seq > ? AND from_me = 0 AND live = 1';
    if (chatJid) {
      sql += ' AND chat_jid = ?';
      args.push(chatJid);
    }
    sql += ' ORDER BY seq ASC LIMIT ?';
    return this.db.prepare(sql).all(...args, limit) as MessageRow[];
  }

  searchMessages(query: string, opts: { chatJid?: string; limit: number }): MessageRow[] {
    const q = ftsQuery(query);
    if (!q) return [];
    const args: unknown[] = [q];
    let sql = `SELECT m.* FROM messages_fts f JOIN messages m ON m.seq = f.rowid WHERE messages_fts MATCH ?`;
    if (opts.chatJid) {
      sql += ' AND m.chat_jid = ?';
      args.push(opts.chatJid);
    }
    sql += ' ORDER BY m.ts DESC LIMIT ?';
    return this.db.prepare(sql).all(...args, opts.limit) as MessageRow[];
  }

  /** Recent inbound messages in a chat, for read receipts. */
  recentInbound(chatJid: string, limit: number): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE chat_jid = ? AND from_me = 0 ORDER BY ts DESC, seq DESC LIMIT ?')
      .all(chatJid, limit) as MessageRow[];
  }

  /** True when no message in either direction, and no send, exists for this chat. */
  isNewContact(chatJid: string): boolean {
    const ids = [normaliseJid(chatJid)];
    const chat = this.getChat(chatJid);
    if (chat) ids.push(chat.jid, ...(chat.alt_jid ? [chat.alt_jid] : []));
    const alt = isLidJid(ids[0]) ? this.pnForLid(ids[0]) : this.lidForPn(ids[0]);
    if (alt) ids.push(alt);
    const unique = [...new Set(ids)];
    const marks = unique.map(() => '?').join(',');
    const m = this.db.prepare(`SELECT 1 FROM messages WHERE chat_jid IN (${marks}) LIMIT 1`).get(...unique);
    if (m) return false;
    const s = this.db.prepare(`SELECT 1 FROM send_ledger WHERE chat_jid IN (${marks}) LIMIT 1`).get(...unique);
    return !s;
  }

  // ---- send ledger ----
  recordSend(s: { atMs: number; chatJid: string; messageId: string | null; kind: string; newContact: boolean }): void {
    this.db
      .prepare('INSERT INTO send_ledger(at_ms, chat_jid, message_id, kind, new_contact) VALUES (?, ?, ?, ?, ?)')
      .run(s.atMs, normaliseJid(s.chatJid), s.messageId, s.kind, s.newContact ? 1 : 0);
  }

  countSends(sinceMs: number): { messages: number; newContacts: number } {
    const row = this.db
      .prepare('SELECT count(*) AS m, coalesce(sum(new_contact), 0) AS n FROM send_ledger WHERE at_ms >= ?')
      .get(sinceMs) as { m: number; n: number };
    return { messages: row.m, newContacts: row.n };
  }

  lastSendAt(newContactOnly = false): number | null {
    const row = this.db
      .prepare(`SELECT max(at_ms) AS t FROM send_ledger ${newContactOnly ? 'WHERE new_contact = 1' : ''}`)
      .get() as { t: number | null };
    return row.t ?? null;
  }
}
