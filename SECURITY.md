# Security

## Reporting a vulnerability

Please report security issues privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem. We aim to reply within a few days.

## What whatzmcp protects

whatzmcp runs on your machine and connects only to WhatsApp. It sends no telemetry and makes no update checks. The only other outbound requests are the ones you ask for: an `https` media URL you pass to `send_message` is downloaded so it can be sent.

Your WhatsApp session keys live in `~/.whatzmcp/auth` (or `$WHATZMCP_HOME/auth`). Anyone who can read that folder can act as your linked device, so keep it private (the folder is created with mode 700) and never commit it.

The optional HTTP mode listens on 127.0.0.1 only and checks the Host header. Set `--token` (or `WHATZMCP_TOKEN`) so that other programs on the same machine cannot use your WhatsApp without it.

To revoke access at any time, run `whatzmcp logout`, or remove the device under Settings, Linked devices on your phone.
