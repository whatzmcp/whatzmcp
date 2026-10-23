/** Small helpers for WhatsApp ids ("jids"). No network, no Baileys dependency. */

export const PN_SERVER = 's.whatsapp.net';
export const LID_SERVER = 'lid';
export const GROUP_SERVER = 'g.us';

export function serverOf(jid: string): string {
  const at = jid.lastIndexOf('@');
  return at === -1 ? '' : jid.slice(at + 1);
}

/** Drops the device and agent parts: "123:4@s.whatsapp.net" becomes "123@s.whatsapp.net". */
export function normaliseJid(jid: string): string {
  const at = jid.lastIndexOf('@');
  if (at === -1) return jid;
  let user = jid.slice(0, at);
  let server = jid.slice(at + 1);
  if (server === 'c.us') server = PN_SERVER;
  const colon = user.indexOf(':');
  if (colon !== -1) user = user.slice(0, colon);
  const underscore = user.indexOf('_');
  if (underscore !== -1 && server !== GROUP_SERVER) user = user.slice(0, underscore);
  return `${user}@${server}`;
}

export const isPnJid = (jid: string) => serverOf(jid) === PN_SERVER;
export const isLidJid = (jid: string) => serverOf(jid) === LID_SERVER;
export const isGroupJid = (jid: string) => serverOf(jid) === GROUP_SERVER;
export const isNewsletterJid = (jid: string) => serverOf(jid) === 'newsletter';
export const isBroadcastJid = (jid: string) => serverOf(jid) === 'broadcast';

/** "+31612345678" for a phone-number jid, otherwise undefined. */
export function phoneOf(jid: string | null | undefined): string | undefined {
  if (!jid || !isPnJid(jid)) return undefined;
  const user = normaliseJid(jid).split('@')[0];
  return /^\d{6,15}$/.test(user) ? `+${user}` : undefined;
}

/** True for chats a message can be sent to: people (phone or LID) and groups. */
export function isSendableJid(jid: string): boolean {
  return /^[0-9]{5,20}@s\.whatsapp\.net$/.test(jid) || /^[0-9]{5,20}@lid$/.test(jid) || /^[0-9-]{5,40}@g\.us$/.test(jid);
}

/**
 * Parses an E.164 phone number. Spaces, dots, dashes and brackets are ignored.
 * Returns the digits without "+", or null when it is not exactly one valid number.
 */
export function parseE164(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('+')) return null;
  const digits = trimmed.slice(1).replace(/[\s().-]/g, '');
  return /^[1-9]\d{6,14}$/.test(digits) ? digits : null;
}

/** Signs that a string holds more than one recipient. */
export function looksLikeList(input: string): boolean {
  if (/[,;\n|]/.test(input)) return true;
  // two separate "+" numbers, or two jids
  if ((input.match(/\+/g) ?? []).length > 1) return true;
  if ((input.match(/@/g) ?? []).length > 1) return true;
  return false;
}
