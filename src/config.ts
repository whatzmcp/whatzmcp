import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface Config {
  /** Use the warm-up ramp. When false only the fixed caps apply. */
  warmup: boolean;
  /** Fixed daily message cap. Overrides the ramp when set. */
  daily_message_cap: number | null;
  /** Fixed daily new contact cap. Overrides the ramp when set. */
  daily_new_contact_cap: number | null;
  /** Random wait between first messages to new contacts, in seconds. */
  new_contact_delay_seconds: { min: number; max: number };
  /** Random wait between any two sends, in seconds. */
  send_delay_seconds: { min: number; max: number };
  /** Show "typing..." before each text message. */
  typing_indicator: boolean;
  /** Largest file send_message will upload, in megabytes. */
  max_media_mb: number;
}

export const DEFAULT_CONFIG: Config = {
  warmup: true,
  daily_message_cap: null,
  daily_new_contact_cap: null,
  new_contact_delay_seconds: { min: 45, max: 120 },
  send_delay_seconds: { min: 1, max: 3 },
  typing_indicator: true,
  max_media_mb: 64,
};

/** Caps used when warmup is false and no fixed cap is set. */
export const MAX_MESSAGES_PER_DAY = 500;
export const MAX_NEW_CONTACTS_PER_DAY = 50;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

function range(v: unknown, fallback: { min: number; max: number }): { min: number; max: number } {
  if (typeof v === 'number' && v >= 0) return { min: v, max: v };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const min = typeof o.min === 'number' && o.min >= 0 ? o.min : fallback.min;
    const max = typeof o.max === 'number' && o.max >= min ? o.max : Math.max(min, fallback.max);
    return { min, max };
  }
  return { ...fallback };
}

/** Normalises any parsed JSON into a valid Config, keeping defaults for bad values. */
export function normaliseConfig(raw: unknown): Config {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    warmup: typeof o.warmup === 'boolean' ? o.warmup : DEFAULT_CONFIG.warmup,
    daily_message_cap: num(o.daily_message_cap),
    daily_new_contact_cap: num(o.daily_new_contact_cap),
    new_contact_delay_seconds: range(o.new_contact_delay_seconds, DEFAULT_CONFIG.new_contact_delay_seconds),
    send_delay_seconds: range(o.send_delay_seconds, DEFAULT_CONFIG.send_delay_seconds),
    typing_indicator: typeof o.typing_indicator === 'boolean' ? o.typing_indicator : DEFAULT_CONFIG.typing_indicator,
    max_media_mb: num(o.max_media_mb) ?? DEFAULT_CONFIG.max_media_mb,
  };
}

/** Reads config.json, writing the defaults first if it does not exist. */
export function loadConfig(path: string): Config {
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', { mode: 0o600 });
    return { ...DEFAULT_CONFIG };
  }
  try {
    return normaliseConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch (err) {
    throw new Error(`Could not read ${path}: ${(err as Error).message}`);
  }
}
