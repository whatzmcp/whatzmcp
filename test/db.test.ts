import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ftsQuery, Store } from '../src/db.js';
import { inbound } from './helpers.js';

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whatzmcp-db-'));
  store = new Store(join(dir, 'db.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('store', () => {
  it('ingests messages once and creates the chat', () => {
    expect(inbound(store, '14155550123@s.whatsapp.net', 'A1', 'hello there', 1000)).toBe(true);
    expect(inbound(store, '14155550123@s.whatsapp.net', 'A1', 'hello there', 1000)).toBe(false);
    const chats = store.listChats({ limit: 10 });
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ jid: '14155550123@s.whatsapp.net', unread_count: 1, last_message_at: 1000 });
  });

  it('full text search finds words and prefixes, and survives odd input', () => {
    inbound(store, '14155550123@s.whatsapp.net', 'A1', 'Can we move the meeting to Friday?', 1000);
    inbound(store, '14155550124@s.whatsapp.net', 'B1', 'Invoice attached', 1001);
    expect(store.searchMessages('meeting friday', { limit: 10 }).map((m) => m.id)).toEqual(['A1']);
    expect(store.searchMessages('invo', { limit: 10 }).map((m) => m.id)).toEqual(['B1']);
    expect(store.searchMessages('"broken -query AND (', { limit: 10 })).toEqual([]);
    expect(store.searchMessages('meeting', { chatJid: '14155550124@s.whatsapp.net', limit: 10 })).toEqual([]);
    expect(ftsQuery('   ')).toBeNull();
  });

  it('keeps LID and phone ids together', () => {
    inbound(store, '777000111@lid', 'L1', 'from lid', 1000);
    expect(store.getChat('777000111@lid')?.jid).toBe('777000111@lid');
    store.addLidMapping('777000111@lid', '14155550123@s.whatsapp.net');
    const chat = store.getChat('777000111@lid');
    expect(chat).toMatchObject({ jid: '14155550123@s.whatsapp.net', alt_jid: '777000111@lid' });
    // a later message on the LID lands in the same chat
    store.ingestMessage({ id: 'L2', chatJid: '777000111@lid', fromMe: false, ts: 1001, text: 'again', live: true });
    expect(store.listMessages({ chatJid: '14155550123@s.whatsapp.net', limit: 10 }).map((m) => m.id)).toEqual(['L2', 'L1']);
    // remoteJidAlt style
    store.ingestMessage({ id: 'X1', chatJid: '888@lid', chatAltJid: '447700900123@s.whatsapp.net', fromMe: false, ts: 1002, text: 'x' });
    expect(store.getChat('888@lid')?.jid).toBe('447700900123@s.whatsapp.net');
  });

  it('detects new contacts from messages in either direction and the ledger', () => {
    const a = '14155550123@s.whatsapp.net';
    expect(store.isNewContact(a)).toBe(true);
    store.ingestMessage({ id: 'O1', chatJid: a, fromMe: true, ts: 1, text: 'hi' });
    expect(store.isNewContact(a)).toBe(false);
    const b = '14155550124@s.whatsapp.net';
    store.recordSend({ atMs: 1, chatJid: b, messageId: null, kind: 'text', newContact: true });
    expect(store.isNewContact(b)).toBe(false);
    // known through the LID of the same person
    store.ingestMessage({ id: 'Z', chatJid: '555@lid', fromMe: false, ts: 1, text: 'z' });
    store.addLidMapping('555@lid', '14155550125@s.whatsapp.net');
    expect(store.isNewContact('14155550125@s.whatsapp.net')).toBe(false);
  });

  it('pages newest first and returns live inbound after a cursor', () => {
    const a = '14155550123@s.whatsapp.net';
    for (let i = 1; i <= 5; i++) inbound(store, a, `M${i}`, `msg ${i}`, 1000 + i, i > 3);
    const page1 = store.listMessages({ limit: 2 });
    expect(page1.map((m) => m.id)).toEqual(['M5', 'M4']);
    const page2 = store.listMessages({ limit: 2, beforeSeq: page1[1].seq });
    expect(page2.map((m) => m.id)).toEqual(['M3', 'M2']);
    expect(store.inboundAfter(0).map((m) => m.id)).toEqual(['M4', 'M5']);
  });
});
