# Contributing

Thanks for helping. Bug reports, fixes and docs improvements are welcome.

## Setup

```bash
git clone https://github.com/whatzmcp/whatzmcp
cd whatzmcp
npm ci
npm run typecheck
npm test
npm run build
```

Node 20 or newer is required. Tests never touch the network: tool handlers run against a fake socket.

## Ground rules

- The tool names, input fields, output shapes and error codes follow `contract/door-contract.json` (door-contract 1.0). They are never renamed or removed within a major version. New optional fields or new tools are fine; `test/contract.test.ts` checks the server against the contract.
- No telemetry, analytics, update checks or calls to any server other than WhatsApp.
- No bulk sending. Send tools take exactly one recipient.
- Keep the safety module (`src/safety.ts`) small and readable.
- Logs go to stderr. stdout belongs to the MCP stdio channel.

## Pull requests

Keep each pull request focused, add or update tests, and describe what changed and why. For a user facing change, update the README and `CHANGELOG.md`.
