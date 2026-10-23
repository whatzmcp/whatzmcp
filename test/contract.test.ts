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
    const src = ['sender.ts', 'tools.ts', 'safety.ts']
      .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'))
      .join('\n');
    const used = new Set([...src.matchAll(/(?:ToolError\(|error_code: )'([a-z_]+)'/g)].map((m) => m[1]));
    for (const code of used) expect(Object.keys(contract.error_codes), code).toContain(code);
  });
});
