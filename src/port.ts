/**
 * The small slice of a Baileys socket this server uses. Tests pass a fake object with the same shape,
 * so the tool handlers run without any network.
 */
export interface WaSocketLike {
  user?: { id: string; lid?: string; name?: string } | undefined;
  sendMessage(jid: string, content: any, options?: any): Promise<any>;
  sendPresenceUpdate(type: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused', toJid?: string): Promise<void>;
  readMessages(keys: any[]): Promise<void>;
  onWhatsApp(...phoneNumbers: string[]): Promise<{ jid: string; exists: boolean }[] | undefined>;
}

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'restricted';

/** What the tools need from the WhatsApp connection. */
export interface ConnectionLike {
  status(): ConnectionStatus;
  socket(): WaSocketLike | null;
  /** Own phone jid, e.g. "31612345678@s.whatsapp.net". */
  ownJid(): string | null;
  connectedAt(): Date | null;
  /** When the account was first paired (start of the warm-up ramp). */
  pairedAt(): Date | null;
  connectKind(): 'qr' | 'code';
  lastError(): string | null;
  /** Starts linking. Resolves with the first QR string, a pairing code, or the connected state. */
  startPairing(opts: { method: 'qr' | 'code'; phone?: string; timeoutMs: number }): Promise<{ qr?: string; pairingCode?: string; status: ConnectionStatus }>;
  /** Current QR and how many seconds it stays valid, or null. */
  currentQr(): { qr: string; expiresInS: number } | null;
  /** Unlinks the device and wipes the local session. */
  logout(): Promise<void>;
}
