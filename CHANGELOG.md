# Changelog

## 0.1.1 (2026-10-23)

Tool inputs and outputs now match the shared door contract exactly. Breaking changes are marked.

- Breaking: `send_message` requires `text` (1 to 4096 characters). With media it is the caption, so a media only send needs a short caption.
- Breaking: `connect_whatsapp` requires `phone_number` (E.164) and takes `link_method` (`qr` or `pairing_code`) instead of `method` (`qr` or `code`). New `force_new` logs out and starts a fresh link. A few options used by hosted servers are accepted and ignored.
- Breaking: `get_whatsapp_qr`, `get_whatsapp_status` and `disconnect_whatsapp` require `phoneNumber`. A number that is not the one on this server is refused with 404.
- Breaking: the four connection tools answer with `success: true` and `phone_number`, and refuse with `{success: false, error_code: <HTTP status>, error}` instead of a string error code. `connect_whatsapp` reports `qr_pending` while linking. `get_whatsapp_qr` adds `qr_code`, `qr_data_url` and `expires_at`. `get_whatsapp_status` adds `has_qr`, `qr_expires_at`, `last_activity`, `message_count`, `live` and the states `qr_pending` and `not_initialized`. `disconnect_whatsapp` returns `status: "disconnected"`.
- `send_message` accepts `opt_in` (logged, limits still apply) and returns `reply_to_applied`. A non https or malformed `media_url` is `invalid_media_url`, an over long or empty `text` is `invalid_text`, and passing both `media_url` and `media_path` is `invalid_request`.
- An unknown `account_id` is `account_not_found` (was `no_connected_account`).
- An unknown `chat_id` used as a filter in `list_messages`, `search_messages` and `wait_for_messages` returns an empty list; a malformed one is `invalid_chat_id`. `mark_read` on an unknown chat is still `contact_not_found`.
- A malformed `before` or `cursor` is `invalid_cursor`; `wait_for_messages` no longer silently restarts from now.
- Messages always carry `media` and `error` (null when empty); `error.code` is an integer (0 when WhatsApp gives none).
- `list_accounts` adds `channels`. `list_chats` items add `channel`. `get_usage` adds `status`, `accounts_total`, `accounts_connected` and `accounts_cap`. `mark_read` adds `receipt_sent`.
- `list_chats` `query` is limited to 200 characters; `search_messages` `query` to 2 to 200.

## 0.1.0

First release.

- WhatsApp Web linked device with QR code or pairing code login.
- MCP server on stdio, or Streamable HTTP on 127.0.0.1 with an optional bearer token.
- Tools from door-contract 1.0: list_accounts, send_message, get_message, list_messages, wait_for_messages, get_usage, list_chats, search_messages, mark_read, connect_whatsapp, get_whatsapp_qr, get_whatsapp_status, disconnect_whatsapp.
- Local SQLite storage with full text search.
- Warm-up ramp, editable daily caps, new contact delay and typing indicator.
