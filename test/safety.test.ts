import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { checkSend, dayNewContactsUnlock, effectiveCaps, rampMessageCap, rampNewContactCap, typingMs, warmupDay } from '../src/safety.js';

describe('warm-up ramp', () => {
  it.each([
    [1, 50, 0],
    [2, 58, 0],
    [3, 66, 1],
    [7, 98, 5],
    [14, 154, 10],
    [30, 282, 24],
    [57, 498, 46],
    [58, 500, 47],
    [61, 500, 50],
    [100, 500, 50],
  ])('day %i: %i messages, %i new contacts', (day, msgs, news) => {
    expect(rampMessageCap(day)).toBe(msgs);
    expect(rampNewContactCap(day)).toBe(news);
  });

  it('counts calendar days in local time, pairing day = day 1', () => {
    const paired = new Date(2026, 2, 1, 23, 59);
    expect(warmupDay(paired, new Date(2026, 2, 1, 23, 59, 59))).toBe(1);
    expect(warmupDay(paired, new Date(2026, 2, 2, 0, 0, 1))).toBe(2);
    expect(warmupDay(paired, new Date(2026, 2, 3, 12, 0))).toBe(3);
    // across a month boundary and a daylight saving change
    expect(warmupDay(paired, new Date(2026, 3, 1, 12, 0))).toBe(32);
  });

  it('new contacts unlock on day 3', () => {
    expect(dayNewContactsUnlock(0)).toBe(3);
    expect(dayNewContactsUnlock(50)).toBeNull();
  });
});

describe('caps', () => {
  const now = new Date(2026, 5, 10, 12);
  const pairedToday = new Date(2026, 5, 10, 8);

  it('uses the ramp by default', () => {
    const c = effectiveCaps(DEFAULT_CONFIG, pairedToday, now);
    expect(c).toMatchObject({ messages: 50, newContacts: 0, day: 1 });
  });

  it('fixed caps override the ramp', () => {
    const c = effectiveCaps({ ...DEFAULT_CONFIG, daily_message_cap: 20, daily_new_contact_cap: 7 }, pairedToday, now);
    expect(c).toMatchObject({ messages: 20, newContacts: 7, day: 1, fixedMessages: true, fixedNewContacts: true });
  });

  it('warmup false uses only fixed caps, else the maximums', () => {
    expect(effectiveCaps({ ...DEFAULT_CONFIG, warmup: false }, pairedToday, now)).toMatchObject({ messages: 500, newContacts: 50, day: null });
    expect(effectiveCaps({ ...DEFAULT_CONFIG, warmup: false, daily_message_cap: 100 }, pairedToday, now)).toMatchObject({ messages: 100, newContacts: 50 });
  });

  it('typing time is bounded', () => {
    expect(typingMs('hi')).toBe(1500);
    expect(typingMs('x'.repeat(1000))).toBe(8000);
  });
});

describe('refusals', () => {
  const now = new Date(2026, 5, 10, 12);
  const caps = effectiveCaps(DEFAULT_CONFIG, new Date(2026, 5, 10, 8), now);

  it('day 1 refuses new contacts with the exact text and retry to midnight', () => {
    const r = checkSend({ caps, usage: { messagesToday: 0, newContactsToday: 0 }, isNewContact: true, now });
    expect(r).toEqual({
      error_code: 'new_contact_cap',
      error: 'Daily limit of 0 new contacts reached on warm-up day 1. You can reply to people who wrote to you. New contacts unlock on day 3.',
      retry_after_s: 12 * 3600,
    });
  });

  it('day 1 allows replies', () => {
    expect(checkSend({ caps, usage: { messagesToday: 10, newContactsToday: 0 }, isNewContact: false, now })).toBeNull();
  });

  it('refuses when the daily message cap is reached', () => {
    const r = checkSend({ caps, usage: { messagesToday: 50, newContactsToday: 0 }, isNewContact: false, now });
    expect(r?.error_code).toBe('daily_send_cap');
    expect(r?.error).toBe('Daily limit of 50 messages reached on warm-up day 1. The limit resets at midnight local time.');
  });

  it('later days point to midnight', () => {
    const c = effectiveCaps(DEFAULT_CONFIG, new Date(2026, 5, 1), now);
    const r = checkSend({ caps: c, usage: { messagesToday: 0, newContactsToday: c.newContacts }, isNewContact: true, now });
    expect(r?.error).toBe(`Daily limit of ${c.newContacts} new contacts reached on warm-up day 10. You can reply to people who wrote to you. The limit resets at midnight local time.`);
  });
});
