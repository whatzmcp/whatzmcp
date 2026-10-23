import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, type Harness } from './helpers.js';
import { SERVER_INSTRUCTIONS } from '../src/tools.js';

const contract = JSON.parse(readFileSync(new URL('../contract/door-contract.json', import.meta.url), 'utf8'));
const expected = [...contract.shared_tools, ...contract.channels.whatsapp_web.tools] as {
  name: string;
  input: { properties: Record<string, unknown>; required?: string[] };
}[];

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});

describe('door-contract 1.0', () => {
  it('registers exactly the contract tools for whatsapp_web', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(expected.map((t) => t.name).sort());
  });

  it('every tool has the contract input keys and required fields', async () => {
    const { tools } = await h.client.listTools();
    for (const want of expected) {
      const got = tools.find((t) => t.name === want.name)!;
      const props = Object.keys(got.inputSchema.properties ?? {}).sort();
      expect(props, want.name).toEqual(Object.keys(want.input.properties).sort());
      expect((got.inputSchema.required ?? []).slice().sort(), want.name).toEqual((want.input.required ?? []).slice().sort());
    }
  });

  it('send_message.to has the WhatsApp recipient fields', async () => {
    const { tools } = await h.client.listTools();
    const to = (tools.find((t) => t.name === 'send_message')!.inputSchema.properties as any).to;
    expect(Object.keys(to.properties).sort()).toEqual(Object.keys(contract.channels.whatsapp_web.recipient.properties).sort());
  });

  it('states the contract version', async () => {
    expect(SERVER_INSTRUCTIONS).toContain(`door-contract ${contract.version}`);
    expect(h.client.getInstructions()).toContain('door-contract 1.0');
    const usage = await h.call('get_usage');
    expect(usage.data.contract_version).toBe(contract.version);
  });

  it('every error code the server can return is in the contract', () => {
    const src = ['sender.ts', 'tools.ts', 'safety.ts', 'wire.ts']
      .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'))
      .join('\n');
    const used = new Set([...src.matchAll(/(?:ToolError\(|error_code: )'([a-z_]+)'/g)].map((m) => m[1]));
    for (const code of used) expect(Object.keys(contract.error_codes), code).toContain(code);
  });

  it('lifecycle tools refuse with an integer HTTP status, shared tools with a string code', async () => {
    const src = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8');
    const statuses = [...src.matchAll(/LifecycleError\((\d+)/g)].map((m) => Number(m[1]));
    expect(statuses.length).toBeGreaterThan(0);
    for (const s of statuses) expect([400, 403, 404, 409, 410, 429, 502, 503], String(s)).toContain(s);

    const lifecycle = contract.channels.whatsapp_web.tools.map((t: { name: string }) => t.name).filter((n: string) => n !== 'connect_whatsapp');
    for (const name of lifecycle) {
      const r = await h.call(name, { phoneNumber: '+14155550199' });
      expect(r.isError, name).toBe(true);
      expect(r.data.success, name).toBe(false);
      expect(Number.isInteger(r.data.error_code), name).toBe(true);
      expect(typeof r.data.error, name).toBe('string');
    }
    const shared = await h.call('get_message', { id: 'nope' });
    expect(shared.isError).toBe(true);
    expect(typeof shared.data.error_code).toBe('string');
    expect(shared.data.success).toBeUndefined();
  });

  it('WireMessage error.code is an integer', async () => {
    h.store.ingestMessage({ id: 'CF1', chatJid: '14155550123@s.whatsapp.net', fromMe: true, ts: 1000, text: 'x', status: 'failed', live: true });
    const m = await h.call('get_message', { id: 'CF1' });
    expect(Number.isInteger(m.data.error.code)).toBe(true);
    expect(m.data.media).toBeNull();
  });
});
