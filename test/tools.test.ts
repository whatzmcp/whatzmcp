import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, inbound, type Harness } from './helpers.js';
import { parseRecipient } from '../src/sender.js';
import { ToolError } from '../src/wire.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const ALICE = '14155550123@s.whatsapp.net';

describe('one recipient only', () => {
  it.each([
    [{ phone: '+14155550123, +14155550124' }],
    [{ phone: '+14155550123;+14155550124' }],
    [{ phone: '+14155550123 +14155550124' }],
    [{ contact_id: 'a@s.whatsapp.net,b@s.whatsapp.net' }],
    [{ phone: '+14155550123', contact_id: ALICE }],
    [['+14155550123']],
    [{}],
  ])('rejects %j', (to) => {
    expect(() => parseRecipient(to)).toThrowError(ToolError);
    try {
      parseRecipient(to);
    } catch (e) {
      expect((e as ToolError).code).toBe('invalid_recipient');
    }
  });

  it('accepts one E.164 number with spacing', () => {
    expect(parseRecipient({ phone: '+1 (415) 555-0123' })).toEqual({ phone: '14155550123' });
  });

  it('rejects numbers without +', () => {
    expect(() => parseRecipient({ phone: '14155550123' })).toThrowError(/E\.164/);
  });

  it('an array for to is refused by the tool and nothing is sent', async () => {
    h = await harness();
    const r = await h.call('send_message', { to: ['+14155550123', '+14155550124'], text: 'hi' });
    expect(r.isError).toBe(true);
    expect(h.sock.callsOf('sendMessage')).toHaveLength(0);
  });

  it('a comma list is refused with invalid_recipient JSON', async () => {
    h = await harness();
    const r = await h.call('send_message', { to: { phone: '+14155550123,+14155550124' }, text: 'hi' });
    expect(r.isError).toBe(true);
    expect(r.data.error_code).toBe('invalid_recipient');
    expect(h.sock.callsOf('sendMessage')).toHaveLength(0);
  });
});

describe('send_message', () => {
  it('day 1: refuses a new contact, allows a reply, with typing first', async () => {
    h = await harness();
    const r1 = await h.call('send_message', { to: { phone: '+14155550124' }, text: 'hello' });
    expect(r1.isError).toBe(true);
    expect(r1.data).toEqual({
      error_code: 'new_contact_cap',
      error: 'Daily limit of 0 new contacts reached on warm-up day 1. You can reply to people who wrote to you. New contacts unlock on day 3.',
      retry_after_s: 12 * 3600,
    });
    expect(h.sock.callsOf('sendMessage')).toHaveLength(0);
    h.sock.calls = [];

    inbound(h.store, ALICE, 'IN1', 'hi, are you open today?', 1000);
    const r2 = await h.call('send_message', { to: { phone: '+14155550123' }, text: 'Yes, until 6pm.' });
    expect(r2.isError).toBe(false);
    expect(r2.data).toEqual({ message_id: 'SENT1', status: 'sent' });
    const order = h.sock.calls.map((c) => (c.fn === 'sendPresenceUpdate' ? `presence:${c.args[0]}` : c.fn));
    expect(order).toEqual(['presence:composing', 'presence:paused', 'sendMessage']);
    expect(h.sock.callsOf('sendMessage')[0].args[1]).toEqual({ text: 'Yes, until 6pm.', linkPreview: null });
    expect(h.sleeps).toContain(1500);

    const usage = await h.call('get_usage');
    expect(usage.data).toMatchObject({ plan: 'self-hosted', day: '2026-06-10', sends: 1, sends_cap: 50, new_contacts: 0, new_contacts_cap: 0, ramp_day: 1 });
  });

  it('reply by contact_id with reply_to quotes the stored message', async () => {
    h = await harness();
    inbound(h.store, ALICE, 'IN1', 'question', 1000);
    const r = await h.call('send_message', { to: { contact_id: ALICE }, text: 'answer', reply_to: 'IN1' });
    expect(r.isError).toBe(false);
    const opts = h.sock.callsOf('sendMessage')[0].args[2] as any;
    expect(opts.quoted.key.id).toBe('IN1');
  });

  it('unknown contact_id and unknown reply_to are refused', async () => {
    h = await harness();
    expect((await h.call('send_message', { to: { contact_id: '123456789@s.whatsapp.net' }, text: 'x' })).data.error_code).toBe('contact_not_found');
    inbound(h.store, ALICE, 'IN1', 'q', 1000);
    expect((await h.call('send_message', { to: { contact_id: ALICE }, text: 'x', reply_to: 'NOPE' })).data.error_code).toBe('message_not_found');
  });

  it('day 3: one new contact, then the jittered new contact delay, then the cap', async () => {
    h = await harness({ daily_new_contact_cap: 2 }, { pairedDaysAgo: 2 });
    const r1 = await h.call('send_message', { to: { phone: '+14155550124' }, text: 'hi' });
    expect(r1.isError).toBe(false);
    const r2 = await h.call('send_message', { to: { phone: '+14155550125' }, text: 'hi' });
    expect(r2.data.error_code).toBe('rate_limited');
    // random() = 0.5 -> 45 + 0.5 * 75 = 82.5 s
    expect(r2.data.retry_after_s).toBe(83);
    h.now.value = new Date(h.now.value.getTime() + 90_000);
    expect((await h.call('send_message', { to: { phone: '+14155550125' }, text: 'hi' })).isError).toBe(false);
    h.now.value = new Date(h.now.value.getTime() + 200_000);
    const r4 = await h.call('send_message', { to: { phone: '+447700900123' }, text: 'hi' });
    expect(r4.data.error_code).toBe('new_contact_cap');
    expect(r4.data.error).toContain('Daily limit of 2 new contacts reached on warm-up day 3');
    // replies still go out
    expect((await h.call('send_message', { to: { phone: '+14155550124' }, text: 'follow up' })).isError).toBe(false);
  });

  it('daily message cap refuses and never queues', async () => {
    h = await harness({ daily_message_cap: 1 });
    inbound(h.store, ALICE, 'IN1', 'q', 1000);
    expect((await h.call('send_message', { to: { contact_id: ALICE }, text: 'one' })).isError).toBe(false);
    const r = await h.call('send_message', { to: { contact_id: ALICE }, text: 'two' });
    expect(r.data.error_code).toBe('daily_send_cap');
    expect(r.data.retry_after_s).toBeGreaterThan(0);
    expect(h.sock.callsOf('sendMessage')).toHaveLength(1);
  });

  it('numbers not on WhatsApp are invalid recipients', async () => {
    h = await harness({}, { pairedDaysAgo: 10 });
    const r = await h.call('send_message', { to: { phone: '+19995550100' }, text: 'x' });
    expect(r.data.error_code).toBe('invalid_recipient');
  });

  it('blocked (403) and disconnected states refuse', async () => {
    h = await harness();
    h.conn.state = 'restricted';
    expect((await h.call('send_message', { to: { phone: '+14155550123' }, text: 'x' })).data.error_code).toBe('account_suspended');
    h.conn.state = 'disconnected';
    expect((await h.call('send_message', { to: { phone: '+14155550123' }, text: 'x' })).data.error_code).toBe('no_connected_account');
    expect(h.sock.callsOf('sendMessage')).toHaveLength(0);
  });

  it('media: local file, bad paths and non https URLs', async () => {
    h = await harness();
    inbound(h.store, ALICE, 'IN1', 'q', 1000);
    const file = join(h.dir, 'photo.jpg');
    writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff]));
    const ok = await h.call('send_message', { to: { contact_id: ALICE }, text: 'look', media_path: file });
    expect(ok.isError).toBe(false);
    const content = h.sock.callsOf('sendMessage')[0].args[1] as any;
    expect(content.caption).toBe('look');
    expect(content.mimetype).toBe('image/jpeg');
    expect(Buffer.isBuffer(content.image)).toBe(true);
    expect((await h.call('send_message', { to: { contact_id: ALICE }, media_path: join(h.dir, 'missing.pdf') })).data.error_code).toBe('media_unavailable');
    expect((await h.call('send_message', { to: { contact_id: ALICE }, media_url: 'http://example.com/a.png' })).data.error_code).toBe('media_unavailable');
    const url = await h.call('send_message', { to: { contact_id: ALICE }, media_url: 'https://example.com/files/report.pdf', text: 'report' });
    expect(url.isError).toBe(false);
    expect(h.sock.callsOf('sendMessage')[1].args[1]).toMatchObject({ document: { url: 'https://example.com/files/report.pdf' }, fileName: 'report.pdf', caption: 'report' });
  });
});

describe('reading', () => {
  it('list_chats, list_messages paging, get_message and search return wire shapes', async () => {
    h = await harness();
    h.store.upsertContact({ jid: ALICE, name: 'Alice Smith' });
    for (let i = 1; i <= 3; i++) inbound(h.store, ALICE, `M${i}`, `invoice number ${i}`, 1000 + i);
    h.store.ingestMessage({ id: 'G1', chatJid: '120363000000000001@g.us', fromMe: false, senderJid: '14155550124@s.whatsapp.net', senderName: 'Bob', ts: 2000, text: 'group hello', live: true });
    h.store.upsertChat({ jid: '120363000000000001@g.us', name: 'Team' });

    const chats = await h.call('list_chats', {});
    expect(chats.data.chats).toEqual([
      { chat_id: '120363000000000001@g.us', name: 'Team', type: 'group', unread_count: 1, last_message_at: new Date(2000_000).toISOString() },
      { chat_id: ALICE, name: 'Alice Smith', type: 'user', unread_count: 3, last_message_at: new Date(1003_000).toISOString() },
    ]);
    expect((await h.call('list_chats', { type: 'user' })).data.chats).toHaveLength(1);
    expect((await h.call('list_chats', { query: 'alice' })).data.chats[0].chat_id).toBe(ALICE);

    const p1 = await h.call('list_messages', { chat_id: ALICE, limit: 2 });
    expect(p1.data.messages.map((m: any) => m.id)).toEqual(['M3', 'M2']);
    const p2 = await h.call('list_messages', { chat_id: ALICE, limit: 2, before: p1.data.next_cursor });
    expect(p2.data.messages.map((m: any) => m.id)).toEqual(['M1']);
    expect(p2.data.next_cursor).toBeNull();

    const m = await h.call('get_message', { id: 'M1' });
    expect(m.data).toEqual({
      id: 'M1',
      account_id: 'local',
      channel: 'whatsapp_web',
      direction: 'inbound',
      text: 'invoice number 1',
      status: 'received',
      timestamp: new Date(1001_000).toISOString(),
      contact: { id: ALICE, phone: '+14155550123', name: 'Alice Smith' },
      chat_id: ALICE,
    });
    const g = await h.call('get_message', { id: 'G1' });
    expect(g.data.contact).toEqual({ id: '14155550124@s.whatsapp.net', phone: '+14155550124', name: 'Bob' });
    expect(g.data.chat_id).toBe('120363000000000001@g.us');

    const s = await h.call('search_messages', { query: 'invoice 2' });
    expect(s.data.messages.map((x: any) => x.id)).toEqual(['M2']);
    expect((await h.call('get_message', { id: 'nope' })).data.error_code).toBe('message_not_found');
    expect((await h.call('list_messages', { chat_id: 'unknown@s.whatsapp.net' })).data.error_code).toBe('contact_not_found');
  });

  it('mark_read sends receipts and clears unread', async () => {
    h = await harness();
    inbound(h.store, ALICE, 'IN1', 'a', 1000);
    inbound(h.store, ALICE, 'IN2', 'b', 1001);
    const r = await h.call('mark_read', { chat_id: ALICE });
    expect(r.data).toEqual({ marked: true });
    const keys = h.sock.callsOf('readMessages')[0].args[0] as any[];
    expect(keys.map((k) => k.id).sort()).toEqual(['IN1', 'IN2']);
    expect(h.store.getChat(ALICE)?.unread_count).toBe(0);
  });
});

describe('wait_for_messages', () => {
  it('wakes up on a new inbound message and returns a cursor', async () => {
    h = await harness();
    inbound(h.store, ALICE, 'OLD', 'old', 1000);
    const started = Date.now();
    const pending = h.call('wait_for_messages', { timeout_s: 5 });
    setTimeout(() => inbound(h.store, ALICE, 'NEW', 'fresh one'), 150);
    const r = await pending;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.data.messages.map((m: any) => m.id)).toEqual(['NEW']);
    // same cursor again returns nothing new after a short timeout
    const again = await h.call('wait_for_messages', { cursor: r.data.cursor, timeout_s: 0 });
    expect(again.data.messages).toEqual([]);
    expect(again.data.cursor).toBe(r.data.cursor);
  });

  it('returns messages that arrived between calls when given the cursor', async () => {
    h = await harness();
    const first = await h.call('wait_for_messages', { timeout_s: 0 });
    inbound(h.store, ALICE, 'A', 'one');
    inbound(h.store, ALICE, 'B', 'two');
    const r = await h.call('wait_for_messages', { cursor: first.data.cursor, timeout_s: 0 });
    expect(r.data.messages.map((m: any) => m.id)).toEqual(['A', 'B']);
  });

  it('ignores history sync rows and other chats when chat_id is set', async () => {
    h = await harness();
    inbound(h.store, '14155550124@s.whatsapp.net', 'X', 'x');
    inbound(h.store, ALICE, 'Y', 'y');
    const pending = h.call('wait_for_messages', { chat_id: ALICE, timeout_s: 3 });
    setTimeout(() => {
      inbound(h.store, ALICE, 'H', 'history', 5, false);
      inbound(h.store, '14155550124@s.whatsapp.net', 'Z', 'other chat');
      inbound(h.store, ALICE, 'W', 'wanted');
    }, 100);
    const r = await pending;
    expect(r.data.messages.map((m: any) => m.id)).toEqual(['W']);
  });

  it('times out with an empty list', async () => {
    h = await harness();
    const r = await h.call('wait_for_messages', { timeout_s: 1 });
    expect(r.isError).toBe(false);
    expect(r.data.messages).toEqual([]);
  });
});

describe('account tools', () => {
  it('status, accounts, connect and disconnect', async () => {
    h = await harness();
    const st = await h.call('get_whatsapp_status');
    expect(st.data).toMatchObject({
      id: 'local',
      channel: 'whatsapp_web',
      identifier: '+31600000001',
      status: 'connected',
      limits: { sends_today: 0, sends_cap: 50, new_contacts_today: 0, new_contacts_cap: 0, ramp_day: 1 },
    });
    expect((await h.call('list_accounts')).data.accounts).toHaveLength(1);
    expect((await h.call('connect_whatsapp')).data).toEqual({ account_id: 'local', status: 'connected' });

    h.conn.state = 'disconnected';
    const c = await h.call('connect_whatsapp', {});
    const img = c.raw.content.find((x: any) => x.type === 'image');
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(c.data.qr_png_base64).toBe(img.data);

    const code = await h.call('connect_whatsapp', { method: 'code', phone_number: '+31600000001' });
    expect(code.data.pairing_code).toBe('ABCD-1234');
    expect((await h.call('connect_whatsapp', { method: 'code' })).data.error_code).toBe('invalid_recipient');

    const qr = await h.call('get_whatsapp_qr');
    expect(qr.raw.content[0].type).toBe('image');
    expect(qr.data.expires_in_s).toBe(17);

    expect((await h.call('disconnect_whatsapp')).data).toEqual({ disconnected: true });
    expect(h.conn.loggedOut).toBe(true);
  });

  it('unknown account_id is refused', async () => {
    h = await harness();
    expect((await h.call('list_chats', { account_id: 'other' })).data.error_code).toBe('no_connected_account');
  });
});
