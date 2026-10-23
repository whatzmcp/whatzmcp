import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildTools, SERVER_INSTRUCTIONS, type ToolContext } from './tools.js';
import { VERSION } from './version.js';

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'whatzmcp', version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  for (const t of buildTools(ctx)) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }, t.handler as any);
  }
  return server;
}

export async function serveStdio(ctx: ToolContext): Promise<void> {
  const server = createMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}

function tokenOk(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const h = req.headers.authorization ?? '';
  const given = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Streamable HTTP on 127.0.0.1 only. Stateless: each request gets its own transport. */
export async function serveHttp(ctx: ToolContext, opts: { port: number; token?: string; host?: string }): Promise<{ close: () => Promise<void>; port: number }> {
  const host = opts.host ?? '127.0.0.1';
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found. The MCP endpoint is /mcp\n');
      return;
    }
    if (!tokenOk(req, opts.token)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`],
    });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
    }
  });
  let actualPort = opts.port;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, host, () => resolve());
  });
  const addr = http.address();
  if (addr && typeof addr === 'object') actualPort = addr.port;
  return {
    port: actualPort,
    close: () => new Promise((r) => http.close(() => r())),
  };
}
