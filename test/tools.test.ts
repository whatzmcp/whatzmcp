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
    expect(r2.data).toEqual({ message_id: 'SENT1', status: 'sent', reply_to_applied: false });
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
    expect(r.data.reply_to_applied).toBe(true);
  });

  it('reply_to on a stored message without its payload sends without the quote', async () => {
    h = await harness();
    h.store.ingestMessage({ id: 'BARE', chatJid: ALICE, fromMe: false, senderJid: ALICE, ts: 1000, text: 'q', live: true });
    const r = await h.call('send_message', { to: { contact_id: ALICE }, text: 'answer', reply_to: 'BARE' });
    expect(r.isError).toBe(false);
    expect(r.data.reply_to_applied).toBe(false);
    expect(h.sock.callsOf('sendMessage')[0].args[2]).toBeUndefined();
  });

  it('text is required, also with media', async () => {
    h = await harness();
    inbound(h.store, ALICE, 'IN1', 'q', 1000);
    const noText = await h.client.callTool({ name: 'send_message', arguments: { to: { contact_id: ALICE }, media_url: 'https://example.com/a.png' } }).catch((e) => ({ isError: true, thrown: e }));
    expect((noText as any).isError).toBe(true);
    const empty = await h.client.callTool({ name: 'send_message', arguments: { to: { contact_id: ALICE }, text: '' } }).catch((e) => ({ isError: true, thrown: e }));
    expect((empty as any).isError).toBe(true);
    expect(h.sock.callsOf('sendMessage')).toHaveLength(0);
    await expect(h.sender.send({ to: { contact_id: ALICE } })).rejects.toMatchObject({ code: 'invalid_text' });
    await expect(h.sender.send({ to: { contact_id: ALICE }, text: 'x'.repeat(4097) })).rejects.toMatchObject({ code: 'invalid_text' });
  });

  it('opt_in is accepted', async () => {
    h = await harness();
    inbound(h.store, ALICE, 'IN1', 'q', 1000);
    const r = await h.call('send_message', { to: { contact_id: ALICE }, text: 'hi', opt_in: true });
    expect(r.isError).toBe(false);
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
    expect((await h.call('send_message', { to: { contact_id: ALICE }, text: 'x', media_path: join(h.dir, 'missing.pdf') })).data.error_code).toBe('media_unavailable');
    expect((await h.call('send_message', { to: { contact_id: ALICE }, text: 'x', media_url: 'http://example.com/a.png' })).data.error_code).toBe('invalid_media_url');
    expect((await h.call('send_message', { to: { contact_id: ALICE }, text: 'x', media_url: 'not a url' })).data.error_code).toBe('invalid_media_url');
    expect((await h.call('send_message', { to: { contact_id: ALICE }, text: 'x', media_url: 'https://example.com/a.png', media_path: file })).data.error_code).toBe('invalid_request');
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
      { chat_id: '120363000000000001@g.us', channel: 'whatsapp_web', name: 'Team', type: 'group', unread_count: 1, last_message_at: new Date(2000_000).toISOString() },
      { chat_id: ALICE, channel: 'whatsapp_web', name: 'Alice Smith', type: 'user', unread_count: 3, last_message_at: new Date(1003_000).toISOString() },
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
      media: null,
      status: 'received',
      error: null,
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
  });

  it('an unknown chat_id filter returns an empty list; a malformed one is invalid_chat_id', async () => {
    h = await harness();
    inbound(h.store, ALICE, 'IN1', 'invoice', 1000);
    const lm = await h.call('list_messages', { chat_id: 'unknown@s.whatsapp.net' });
    expect(lm.isError).toBe(false);
    expect(lm.data.messages).toEqual([]);
    const sm = await h.call('search_messages', { query: 'invoice', chat_id: '+19995550100' });
    expect(sm.isError).toBe(false);
    expect(sm.data.messages).toEqual([]);
    const wm = await h.call('wait_for_messages', { chat_id: 'unknown@s.whatsapp.net', timeout_s: 0 });
    expect(wm.isError).toBe(false);
    expect(wm.data.messages).toEqual([]);
    expect((await h.call('list_messages', { chat_id: 'not a chat' })).data.error_code).toBe('invalid_chat_id');
    expect((await h.call('mark_read', { chat_id: 'unknown@s.whatsapp.net' })).data.error_code).toBe('contact_not_found');
  });

  it('a malformed cursor is invalid_cursor', async () => {
    h = await harness();
    expect((await h.call('list_messages', { before: 'abc' })).data.error_code).toBe('invalid_cursor');
    expect((await h.call('wait_for_messages', { cursor: 'abc', timeout_s: 0 })).data.error_code).toBe('invalid_cursor');
  });

  it('a failed outbound message carries an integer error code', async () => {
    h = await harness();
    h.store.ingestMessage({ id: 'F1', chatJid: ALICE, fromMe: true, ts: 1000, text: 'x', status: 'failed', live: true });
    const m = await h.call('get_message', { id: 'F1' });
    expect(m.data.error).toEqual({ code: 0, message: expect.any(String) });
  });

  it('mark_read sends receipts and clears unread', async () => {
    h = await harness();
    inbound(h.store, ALICE, 'IN1', 'a', 1000);
    inbound(h.store, ALICE, 'IN2', 'b', 1001);
    const r = await h.call('mark_read', { chat_id: ALICE });
    expect(r.data).toEqual({ marked: true, receipt_sent: true });
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
  const ME = '+31600000001';

  it('list_accounts and get_usage', async () => {
    h = await harness();
    const acc = await h.call('list_accounts');
    expect(acc.data.accounts).toHaveLength(1);
    expect(acc.data.channels).toEqual([{ channel: 'whatsapp_web', label: 'WhatsApp', connect_kind: 'qr', max_accounts: 1 }]);
    const u = await h.call('get_usage');
    expect(u.data).toMatchObject({ status: 'active', accounts_total: 1, accounts_connected: 1, accounts_cap: 1, ramp_day: 1, contract_version: '1.0' });
    expect(u.data.suspended_reason).toBeUndefined();
    h.conn.state = 'restricted';
    expect((await h.call('get_usage')).data).toMatchObject({ status: 'suspended', accounts_connected: 0, suspended_reason: expect.any(String) });
  });

  it('status, connect and disconnect', async () => {
    h = await harness();
    inbound(h.store, ALICE, 'IN1', 'a', 1000);
    const st = await h.call('get_whatsapp_status', { phoneNumber: ME });
    expect(st.data).toEqual({
      success: true,
      phone_number: ME,
      status: 'connected',
      has_qr: false,
      qr_expires_at: null,
      last_activity: new Date(1000_000).toISOString(),
      message_count: 1,
      proxy: null,
      live: true,
      limits: { sends_today: 0, sends_cap: 50, new_contacts_today: 0, new_contacts_cap: 0, ramp_day: 1 },
    });
    expect((await h.call('connect_whatsapp', { phone_number: ME })).data).toEqual({ success: true, phone_number: ME, status: 'connected', session_id: 'local' });
    const other = await h.call('connect_whatsapp', { phone_number: '+14155550123' });
    expect(other.isError).toBe(true);
    expect(other.data.error_code).toBe(409);

    h.conn.state = 'disconnected';
    const c = await h.call('connect_whatsapp', { phone_number: ME });
    const img = c.raw.content.find((x: any) => x.type === 'image');
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(c.data).toMatchObject({ success: true, phone_number: ME, status: 'qr_pending', session_id: 'local', qr_png_base64: img.data });

    const code = await h.call('connect_whatsapp', { phone_number: ME, link_method: 'pairing_code' });
    expect(code.data).toMatchObject({ success: true, phone_number: ME, status: 'qr_pending', pairing_code: 'ABCD-1234' });
    const bad = await h.call('connect_whatsapp', { phone_number: '0612345678' });
    expect(bad.isError).toBe(true);
    expect(bad.data).toEqual({ success: false, error_code: 400, error: expect.any(String) });

    expect((await h.call('get_whatsapp_status', { phoneNumber: ME })).data).toMatchObject({ status: 'qr_pending', has_qr: true, live: false });

    const qr = await h.call('get_whatsapp_qr', { phoneNumber: ME });
    expect(qr.raw.content[0].type).toBe('image');
    expect(qr.data).toMatchObject({ success: true, phone_number: ME, status: 'qr_pending', qr_code: 'fake-qr-payload', expires_in_s: 17 });
    expect(qr.data.qr_data_url).toBe(`data:image/png;base64,${qr.raw.content[0].data}`);
    expect(Number.isNaN(Date.parse(qr.data.expires_at))).toBe(false);

    expect((await h.call('disconnect_whatsapp', { phoneNumber: ME })).data).toEqual({ success: true, phone_number: ME, status: 'disconnected' });
    expect(h.conn.loggedOut).toBe(true);
  });

  it('get_whatsapp_qr when already connected', async () => {
    h = await harness();
    expect((await h.call('get_whatsapp_qr', { phoneNumber: ME })).data).toEqual({ success: true, phone_number: ME, status: 'connected', qr_code: null, qr_data_url: null, expires_at: null });
  });

  it('force_new logs out and starts a fresh link', async () => {
    h = await harness();
    const r = await h.call('connect_whatsapp', { phone_number: ME, force_new: true });
    expect(h.conn.loggedOut).toBe(true);
    expect(r.data).toMatchObject({ success: true, status: 'qr_pending' });
  });

  it('a phoneNumber that is not this account is a 404 refusal', async () => {
    h = await harness();
    for (const tool of ['get_whatsapp_status', 'get_whatsapp_qr', 'disconnect_whatsapp']) {
      const r = await h.call(tool, { phoneNumber: '+14155550123' });
      expect(r.isError, tool).toBe(true);
      expect(r.data, tool).toEqual({ success: false, error_code: 404, error: 'No connection for that number.' });
    }
    expect(h.conn.loggedOut).toBe(false);
  });

  it('a restricted account refuses connect with 403', async () => {
    h = await harness();
    h.conn.state = 'restricted';
    expect((await h.call('connect_whatsapp', { phone_number: ME })).data).toEqual({ success: false, error_code: 403, error: expect.any(String) });
    expect((await h.call('get_whatsapp_status', { phoneNumber: ME })).data.status).toBe('restricted');
  });

  it('unknown account_id is account_not_found', async () => {
    h = await harness();
    expect((await h.call('list_chats', { account_id: 'other' })).data.error_code).toBe('account_not_found');
    expect((await h.call('send_message', { account_id: 'other', to: { phone: '+14155550123' }, text: 'x' })).data.error_code).toBe('account_not_found');
  });
});
