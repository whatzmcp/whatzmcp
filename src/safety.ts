import { MAX_MESSAGES_PER_DAY, MAX_NEW_CONTACTS_PER_DAY, type Config } from './config.js';

/**
 * Sending limits. Everything here is a pure function so it is easy to read and test.
 *
 * Warm-up ramp, counted by calendar day since pairing (day 1 = pairing day, local time):
 *   messages per day     = 50 + 8 x (day - 1), up to 500
 *   new contacts per day = floor((day - 1) x 5 / 6), up to 50 (0 on day 1 and day 2)
 */

export function rampMessageCap(day: number): number {
  return Math.min(MAX_MESSAGES_PER_DAY, 50 + 8 * (Math.max(1, day) - 1));
}

export function rampNewContactCap(day: number): number {
  return Math.min(MAX_NEW_CONTACTS_PER_DAY, Math.floor(((Math.max(1, day) - 1) * 5) / 6));
}

/** Local midnight at the start of the given date. */
export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function nextLocalMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

/** YYYY-MM-DD in local time. */
export function localDayString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Calendar day number since pairing: the pairing day is day 1. */
export function warmupDay(pairedAt: Date, now: Date): number {
  const a = startOfLocalDay(pairedAt);
  const b = startOfLocalDay(now);
  // Math.round absorbs the 23 or 25 hour days around daylight saving changes.
  const days = Math.round((b.getTime() - a.getTime()) / 86_400_000);
  return Math.max(1, days + 1);
}

export interface Caps {
  messages: number;
  newContacts: number;
  /** Warm-up day, or null when the ramp is off or the account was never paired. */
  day: number | null;
  /** True when a fixed cap from config.json is in force for that limit. */
  fixedMessages: boolean;
  fixedNewContacts: boolean;
}

export function effectiveCaps(config: Config, pairedAt: Date | null, now: Date): Caps {
  const day = config.warmup && pairedAt ? warmupDay(pairedAt, now) : null;
  const rampMsgs = day !== null ? rampMessageCap(day) : config.warmup ? rampMessageCap(1) : MAX_MESSAGES_PER_DAY;
  const rampNew = day !== null ? rampNewContactCap(day) : config.warmup ? rampNewContactCap(1) : MAX_NEW_CONTACTS_PER_DAY;
  return {
    messages: config.daily_message_cap ?? rampMsgs,
    newContacts: config.daily_new_contact_cap ?? rampNew,
    day,
    fixedMessages: config.daily_message_cap !== null,
    fixedNewContacts: config.daily_new_contact_cap !== null,
  };
}

/** First warm-up day on which the ramp allows more new contacts than `used`. */
export function dayNewContactsUnlock(used: number): number | null {
  if (used >= MAX_NEW_CONTACTS_PER_DAY) return null;
  // smallest d with floor((d - 1) * 5 / 6) > used
  let d = 1;
  while (rampNewContactCap(d) <= used) d++;
  return d;
}

export interface Usage {
  messagesToday: number;
  newContactsToday: number;
}

export interface Refusal {
  error_code: string;
  error: string;
  retry_after_s?: number;
}

function secondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000));
}

/**
 * Decides whether one more send is allowed. Returns null when it is, or the refusal.
 * Refusals never queue: the caller sends nothing.
 */
export function checkSend(opts: { caps: Caps; usage: Usage; isNewContact: boolean; now: Date }): Refusal | null {
  const { caps, usage, isNewContact, now } = opts;
  const retry = secondsUntil(nextLocalMidnight(now), now);
  const dayText = caps.day !== null ? ` on warm-up day ${caps.day}` : '';

  if (usage.messagesToday >= caps.messages) {
    return {
      error_code: 'daily_send_cap',
      error: `Daily limit of ${caps.messages} messages reached${dayText}. The limit resets at midnight local time.`,
      retry_after_s: retry,
    };
  }
  if (isNewContact && usage.newContactsToday >= caps.newContacts) {
    let next = 'The limit resets at midnight local time.';
    if (caps.day !== null && !caps.fixedNewContacts && caps.newContacts === 0) {
      const unlock = dayNewContactsUnlock(0);
      if (unlock !== null) next = `New contacts unlock on day ${unlock}.`;
    }
    return {
      error_code: 'new_contact_cap',
      error:
        `Daily limit of ${caps.newContacts} new contacts reached${dayText}. ` +
        `You can reply to people who wrote to you. ${next}`,
      retry_after_s: retry,
    };
  }
  return null;
}

/** Random number of milliseconds within a range given in seconds. */
export function jitterMs(range: { min: number; max: number }, rnd: () => number = Math.random): number {
  return Math.round((range.min + (range.max - range.min) * rnd()) * 1000);
}

/** How long to show "typing..." for a text, in milliseconds (1.5 s to 8 s). */
export function typingMs(text: string): number {
  return Math.min(8000, Math.max(1500, Math.round(text.length * 60)));
}
