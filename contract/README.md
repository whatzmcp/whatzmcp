# Door contract

`door-contract.json` is the tool contract shared by the door servers: one MCP server per messaging channel (whatsapp_web, telegram, linkedin), each run by you on your own machine. The file is byte-identical in every door repo. Change it in all of them at once, never in one alone.

Version: door-contract 1.0.

What it holds:

- `objects`: the shapes every server returns (WireMessage, WireAccount, WireError).
- `shared_tools`: the tools every door server registers, with their input schemas.
- `channels.<channel>`: the recipient fields for `send_message.to`, the tools only that channel has, and any error codes only that channel returns.
- `error_codes`: the codes every server may return. A refusal is a tool result with `isError: true` whose text is JSON `{error_code, error, retry_after_s?}`.

Fields marked `local_only` are accepted by self-hosted servers only. An agent that never sends them works with every server.

Versioning:

- Within a major version, a tool, field or error code is never renamed or removed.
- Additions within a major version are optional fields or new tools (and new error codes). A new required field, a rename or a removal needs a new major version.
- Clients handle an unknown error code by reading `error`.
- Each server reports the version it implements in `get_usage.contract_version` and in its MCP server instructions.
