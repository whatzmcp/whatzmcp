# whatzmcp: the open source WhatsApp MCP server

whatzmcp is an open source MCP server that connects your own WhatsApp account to Claude and other AI assistants. It runs on your machine as a linked device, so your assistant can read your chats, search your message history and send messages for you. It is free and MIT licensed.

Don't want to run it yourself? A hosted version is coming at whatzmcp.com.

```bash
npx whatzmcp login
```

Scan the QR code with WhatsApp on your phone, add whatzmcp to your MCP client, and ask your assistant things like "What did Sarah send me about the invoice?" or "Reply to Tom that I am running ten minutes late."

## Quick start

You need Node.js 20 or newer and a phone with WhatsApp.

1. Link your account:

   ```bash
   npx whatzmcp login
   ```

   On your phone open WhatsApp, go to Settings, Linked devices, Link a device, and scan the QR code in the terminal. Prefer a code? Run `npx whatzmcp login --pair-code +14155550123` with your own number, then choose "Link with phone number instead" on the phone and type the 8 character code.

2. Add the server to your MCP client (config blocks below) and restart the client.

3. Ask your assistant to run `get_whatsapp_status`. It should say `connected`.

You can also skip step 1: start your client with whatzmcp configured and ask it to call `connect_whatsapp`. It returns the QR code as an image right in the chat.

## Configure your MCP client

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "whatzmcp": {
      "command": "npx",
      "args": ["-y", "whatzmcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add whatzmcp -- npx -y whatzmcp
```

### OpenClaw

```bash
openclaw mcp add whatzmcp --command npx --arg -y --arg whatzmcp
openclaw mcp doctor whatzmcp --probe
```

Or in `~/.openclaw/openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "whatzmcp": {
        "command": "npx",
        "args": ["-y", "whatzmcp"]
      }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "whatzmcp": {
      "command": "npx",
      "args": ["-y", "whatzmcp"]
    }
  }
}
```

### Any other MCP client (stdio)

```json
{
  "command": "npx",
  "args": ["-y", "whatzmcp"],
  "env": { "WHATZMCP_HOME": "/path/to/data" }
}
```

### Local HTTP

```bash
npx whatzmcp serve --http --port 8787 --token "$(openssl rand -hex 16)"
```

The endpoint is `http://127.0.0.1:8787/mcp` (Streamable HTTP). It only listens on 127.0.0.1. Send the token as `Authorization: Bearer <token>`.

### Docker

```bash
# link once, interactively
docker run -it --rm -v whatzmcp-data:/data ghcr.io/whatzmcp/whatzmcp login

# then use this as the command in your MCP client
docker run -i --rm -v whatzmcp-data:/data ghcr.io/whatzmcp/whatzmcp
```

The `/data` volume keeps the session, the message database and `config.json`.

## Tools

| Tool | What it does |
| --- | --- |
| `get_whatsapp_status` | Connection status, your number, today's sends and caps, warm-up day |
| `connect_whatsapp` | Start linking: returns a QR code image, or an 8 character pairing code with `method: "code"` and `phone_number` |
| `get_whatsapp_qr` | The current QR code as an image, with how many seconds it stays valid |
| `disconnect_whatsapp` | Unlink this device and delete the saved session |
| `list_accounts` | The one account on this server (`local`) |
| `list_chats` | Chats, most recent first, filtered by `query` and `type` (user, group, channel) |
| `list_messages` | Messages newest first, for all chats or one `chat_id`, paged with `before` |
| `get_message` | One message by id |
| `search_messages` | Full text search over your stored messages |
| `wait_for_messages` | Wait up to 55 seconds for new inbound messages; pass the returned `cursor` to the next call |
| `send_message` | Send one message to one recipient (`to.phone` or `to.contact_id`), with optional media (`media_url` over https, or a local `media_path`) and `reply_to` |
| `mark_read` | Send read receipts for a chat and clear its unread count |
| `get_usage` | Today's sends, new contacts, caps and warm-up day |

Messages come back as JSON with `id`, `chat_id`, `direction`, `text`, `timestamp`, `status` and a `contact` (id, phone, name). A refused call returns JSON with an `error_code` (for example `new_contact_cap` or `daily_send_cap`), a readable `error`, and `retry_after_s` when waiting helps. The tool names and fields follow door-contract 1.0 (`contract/door-contract.json`) and stay stable within a major version.

## Safety limits

WhatsApp watches how new linked devices behave. whatzmcp starts slow and builds up, the way a person getting started would.

The warm-up ramp counts calendar days in your local time since the day you first linked the number (that day is day 1):

| Day | Messages per day | New contacts per day |
| --- | --- | --- |
| 1 | 50 | 0 |
| 2 | 58 | 0 |
| 3 | 66 | 1 |
| 7 | 98 | 5 |
| 14 | 154 | 10 |
| 30 | 282 | 24 |
| 58 | 500 | 47 |
| 61 and later | 500 | 50 |

Messages per day are `50 + 8 × (day − 1)` up to 500. New contacts per day are `floor((day − 1) × 5 / 6)` up to 50. Every message this server sends counts, replies included. A new contact is a chat with no earlier message in either direction. On day 1 and day 2 you can reply to anyone who wrote to you, but you cannot start new conversations.

whatzmcp also:

* waits a random 45 to 120 seconds between first messages to two different new contacts,
* waits a random 1 to 3 seconds between any two sends,
* shows "typing..." for a moment before each message,
* sends to one recipient per call, never a list,
* refuses instead of queueing: when a limit is reached, nothing is sent and the assistant gets a clear reason,
* stops all sending if WhatsApp refuses the session, and never retries a send after that.

Check where you are with `npx whatzmcp limits`. To change the caps, edit `~/.whatzmcp/config.json` (changes apply without a restart):

```json
{
  "warmup": true,
  "daily_message_cap": null,
  "daily_new_contact_cap": null,
  "new_contact_delay_seconds": { "min": 45, "max": 120 },
  "send_delay_seconds": { "min": 1, "max": 3 },
  "typing_indicator": true,
  "max_media_mb": 64
}
```

Set `daily_message_cap` or `daily_new_contact_cap` to a number to use a fixed cap instead of the ramp. Set `warmup` to `false` to use only fixed caps (500 messages and 50 new contacts when none are set).

## Where your data lives

Everything stays in `~/.whatzmcp` (set `WHATZMCP_HOME` to use another folder):

* `auth/`: your linked device session. Keep it private.
* `whatzmcp.db`: SQLite database with your chats, contacts, messages and a ledger of what this server sent.
* `config.json`: your limits.

whatzmcp talks only to WhatsApp. There is no telemetry, no analytics, no update check and no hosted API. The one exception is a `media_url` you pass to `send_message`, which is downloaded so it can be sent.

## CLI

```text
whatzmcp login [--pair-code +<number>]   link your account
whatzmcp [serve]                         MCP server on stdio
whatzmcp serve --http [--port 8787] [--token <secret>]
whatzmcp status                          link status and today's usage
whatzmcp limits                          caps, usage and the warm-up ramp
whatzmcp logout                          unlink and delete the session
```

Run one whatzmcp per data directory. Two processes with the same session would knock each other offline, so a second one refuses to start.

## FAQ

### Is there a WhatsApp MCP server?

Yes. whatzmcp is an open source WhatsApp MCP server. Install it with `npx whatzmcp login`, add it to Claude Desktop, Claude Code, Cursor, OpenClaw or any MCP client, and your assistant can read, search and send WhatsApp messages from your own account. Don't want to run it yourself? A hosted version is coming at whatzmcp.com.

### Will WhatsApp ban my number?

WhatsApp decides that, based on how an account behaves. whatzmcp is built to behave like a careful person: a warm-up ramp that starts at 50 messages and no new contacts on day 1, a random wait between new contacts, a typing indicator before each message, one recipient per send, and a full stop if WhatsApp refuses the session. Messaging people who know you and replying to people who wrote first keeps you in the safest place.

### Does it need the WhatsApp Business API?

No. It links to your normal WhatsApp or WhatsApp Business app as a linked device, the same way WhatsApp on a computer does. No Meta developer account, templates or API fees.

### Does it send my messages anywhere?

No. Messages go between your machine and WhatsApp only, and are stored in a SQLite file in your data folder. Your MCP client sees the messages your assistant reads, so the client's own data handling applies to those.

### Can it send bulk messages?

No. There is no bulk tool, and `send_message` takes exactly one recipient per call. Lists and comma separated numbers are rejected.

### Does it work with groups?

Yes. Groups show up in `list_chats` with `type: "group"`, their messages are stored and searchable, each message names the member who sent it, and you can reply in a group by passing its `chat_id` as `to.contact_id`.

### How do I unlink it?

Run `npx whatzmcp logout`, or ask your assistant to call `disconnect_whatsapp`. You can also remove it on your phone under Settings, Linked devices. Delete `~/.whatzmcp` to remove the stored messages too.

### Can I run it in Docker?

Yes: `docker run -it --rm -v whatzmcp-data:/data ghcr.io/whatzmcp/whatzmcp login` once, then use `docker run -i --rm -v whatzmcp-data:/data ghcr.io/whatzmcp/whatzmcp` as the command in your MCP client.

## Limitations

* whatzmcp uses the WhatsApp Web protocol, which is unofficial and can change. An update may be needed when WhatsApp changes it.
* Your phone must keep its WhatsApp account registered. If the phone stays offline for a long time, WhatsApp signs out linked devices and you link again with `whatzmcp login`.
* WhatsApp allows a limited number of linked devices per account, and whatzmcp uses one of them.
* Media: WhatsApp applies its own size limits per media type, and whatzmcp refuses local files over `max_media_mb` (64 MB by default). Received media is listed with its type; the files are not downloaded.
* History: the first sync brings in what your phone shares with a new linked device, which may not be your full history.
* Calls, status updates, polls and reactions are not supported.

whatzmcp is not affiliated with, endorsed by or sponsored by WhatsApp or Meta.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

MIT. See [LICENSE](LICENSE).
