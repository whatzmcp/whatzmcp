import { describe, expect, it } from 'vitest';
import { toRecord } from '../src/whatsapp.js';

describe('Baileys message ingest', () => {
  it('maps text, captions, LID alt ids, groups and status', () => {
    const r = toRecord(
      {
        key: { remoteJid: '777@lid', remoteJidAlt: '14155550123@s.whatsapp.net', fromMe: false, id: 'A' } as any,
        message: { conversation: 'hello' },
        messageTimestamp: 1700000000,
        pushName: 'Alice',
      } as any,
      true,
    );
    expect(r).toMatchObject({ id: 'A', chatJid: '777@lid', chatAltJid: '14155550123@s.whatsapp.net', text: 'hello', ts: 1700000000, senderName: 'Alice', status: 'received', live: true });

    const img = toRecord({ key: { remoteJid: '120363@g.us', fromMe: false, id: 'B', participant: '14155550124@s.whatsapp.net' }, message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg' } }, messageTimestamp: 1 } as any, false);
    expect(img).toMatchObject({ text: 'look', mediaType: 'image', mimetype: 'image/jpeg', senderJid: '14155550124@s.whatsapp.net', live: false });

    const ext = toRecord({ key: { remoteJid: '1@s.whatsapp.net', fromMe: true, id: 'C' }, message: { extendedTextMessage: { text: 'see https://x.y' } }, status: 4, messageTimestamp: 1 } as any, true);
    expect(ext).toMatchObject({ text: 'see https://x.y', fromMe: true, status: 'read' });
  });

  it('skips protocol noise and status broadcasts', () => {
    expect(toRecord({ key: { remoteJid: '1@s.whatsapp.net', id: 'P' }, message: { protocolMessage: { type: 0 } } } as any, true)).toBeNull();
    expect(toRecord({ key: { remoteJid: 'status@broadcast', id: 'S' }, message: { conversation: 'x' } } as any, true)).toBeNull();
    expect(toRecord({ key: { remoteJid: '1@s.whatsapp.net', id: 'E' }, message: null } as any, true)).toBeNull();
  });
});
