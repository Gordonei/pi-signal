# @gordoneiza/pi-signal

> A fork of [aalzubidy's package](https://github.com/aalzubidy/pi-signal).

Connect [pi](https://pi.dev) to [Signal Messenger](https://signal.org/) for two-way messaging. Send a message from your phone to the Signal account that pi is connected to, and pi receives it, the LLM processes it, and pi replies back automatically. A standalone Signal CLI REST API implementation is used to handle talking to the Signal. 

> **By default, only your own number is allowed.** Note-to-Self messages are always processed; messages from other numbers are only accepted if that number is in `PI_SIGNAL_ALLOWLIST`. Non-allowlisted senders get a 🚫 reaction and a short rejection reply, and sends to them are blocked.

## How It Works

```
Phone → bbernhard/signal-cli-rest-api (Docker, REST + WebSocket) → pi extension
    → 👀 reaction → ⌨️ typing indicator → LLM processes → auto-reply → ✅ reaction
```

The extension talks to the [bbernhard/signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) container over REST (send, reactions, contacts, health, typing indicator) and a persistent WebSocket on `/v1/receive/{number}` for incoming messages. While the agent is working on a response, the Signal typing indicator ("message is being written…") is shown to the sender and cleared when the reply arrives. signal-cli itself runs inside the container — there is no host daemon, no log file, and no systemd unit to manage.

Commands (`/model`, `/abort`, `/clear`, `/stats`, `/status`, `/whoami`, `/resend`, `/pause`, `/resume`, `/help`) are handled locally without LLM. Everything else is forwarded to the LLM.

![Note-to-Self message](docs/img/note-to-self-img.png)

![pi agent response](docs/img/pi-agent-response-img.png)

You can also send the response to someone else in your contacts using their name or phone number (the number must be allowlisted — see [Security](#security)).

![Note-to-Self-Send-to message](docs/img/note-to-self-send-to-img.png)

![pi agent response](docs/img/pi-agent-response-send-to-img.png)

## Installation

**Prerequisites:** [Docker](https://www.docker.com/) (or Podman), a Signal app on your phone. 

```bash
# 1. Install the pi package
pi install @gordoneiza/pi-signal

# 2. Run the signal-cli REST API container (adjust image/port/volume to taste)
docker run -d --name signal-api --restart unless-stopped \
  -p 127.0.0.1:8090:8080 \
  -v signal-api-data:/root/.local/share/signal-cli \
  bbernhard/signal-cli-rest-api

# 3. Link your Signal account (QR scan, as the account you want pi to use)
docker exec -it signal-api signal-cli -a +1234567890 link

# 4. Configure pi — add these to your shell config (~/.bashrc, ~/.zshrc, ...):
export PI_SIGNAL_ACCOUNT=+1234567890   # your Signal number (E.164)
export PI_SIGNAL_PRIMARY=true          # marks this instance as the one handling Signal
# Optional — numbers allowed to send/receive with the agent (self is always allowed):
# export PI_SIGNAL_ALLOWLIST=+15551234567,+441234567890
# Optional — download media attachments (images, PDFs) to disk:
# export PI_SIGNAL_ATTACHMENTS_DIR=/tmp/pi-signal/attachments  # default
# export PI_SIGNAL_MAX_ATTACHMENT_AGE_DAYS=7                     # default

# 5. Start pi (restart it or run /reload if already running), then verify:
pi
# /signal-setup  — setup guidance (where the REST API container must be running)
# /signal-status — shows REST API health + WebSocket state
```

Send a Note-to-Self from your phone. pi receives it (👀), processes it, and replies automatically (✅).

**Media attachments:** When you send an image or PDF with text, pi downloads the attachment
and provides the file path to the LLM, which can inspect it using pi's built-in `read` tool.
Attachments are stored in `PI_SIGNAL_ATTACHMENTS_DIR` and auto-cleaned after
`PI_SIGNAL_MAX_ATTACHMENT_AGE_DAYS` days.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PI_SIGNAL_ACCOUNT` | Yes | — | Your Signal number in E.164: `+1234567890` |
| `PI_SIGNAL_PRIMARY` | No | `false` | Set `"true"` on the ONE instance handling Signal messages |
| `PI_SIGNAL_DAEMON_URL` | No | `http://127.0.0.1:8090` | Base URL of the bbernhard/signal-cli-rest-api container (REST + WebSocket) |
| `PI_SIGNAL_ALLOWLIST` | No | empty = self only | Comma-separated E.164 numbers allowed to send/receive with the agent. `PI_SIGNAL_ACCOUNT` is always allowed regardless. |
| `PI_SIGNAL_STATS` | No | `short` | Stats mode: `off`, `short`, or `full` |
| `PI_SIGNAL_DEBUG` | No | `false` | Set to `"true"`, `"1"`, or `"log"` to enable verbose debug logging. When on, `createDebug()` output and all `isLoggingEnabled()`-gated `console.error`/`console.warn` calls are emitted. |
| `PI_SIGNAL_ATTACHMENTS_DIR` | No | `/tmp/pi-signal/attachments` | Directory for downloaded media attachments (images, PDFs) |
| `PI_SIGNAL_MAX_ATTACHMENT_AGE_DAYS` | No | `7` | Days before old attachments are auto-deleted |

## Commands (from Signal)

| Command | Purpose |
|---|---|
| `/model <name>` | Switch model (fuzzy match) |
| `/abort` | Stop current generation |
| `/clear` | New session |
| `/stats [short\|full\|off]` | Toggle usage stats |
| `/status` | Live connection & model info (in-memory, never hangs — only answers when pi is up) |
| `/whoami` | Show model, working directory, and session |
| `/resend` | Re-send the last reply (recover a dropped message) |
| `/pause` | Stop processing incoming messages (commands still work) |
| `/resume` | Resume processing |
| `/help` | Show available commands |

> **Send to another number:** just ask the LLM naturally — e.g. *"summarize this and text it to +1555…"*, or by name: *"send this to Mike"*. For a name, the agent resolves it via `signal_list_contacts` first (names only resolve if signal-cli knows them — a synced contact or Signal profile name). The target must be in `PI_SIGNAL_ALLOWLIST`, otherwise the send is blocked. The agent's confirmation reply comes back to your Note-to-Self so you can see who it was sent to.

## TUI Commands (in pi)

`/signal-setup`, `/signal-status`, `/signal-send <+E164> <msg>`, `/signal-model`, `/signal-abort`, `/signal-stats`

## Tools (LLM-accessible)

- **`signal_send`** — Send a Signal message to a phone number (E.164). Blocked for numbers not in the allowlist.
- **`signal_status`** — Check connection status and health (REST API reachable, WebSocket connected)
- **`signal_list_contacts`** — List contacts (name → number) so the agent can resolve a name before sending

## Multiple Instances

Set `PI_SIGNAL_PRIMARY=true` on one pi instance. Other instances ignore Signal messages.

## Security

- **Default-deny allowlist:** only your own number is allowed by default. Incoming messages from any other number get a 🚫 reaction and a rejection reply; `signal_send` and `/signal-send` refuse to deliver to non-allowlisted numbers. Add trusted numbers via `PI_SIGNAL_ALLOWLIST`.
- **No local message logs:** messages flow over a loopback WebSocket; message content is not written to a log file by pi-signal. (The signal-cli data store inside the container holds conversation data — protect the container volume accordingly.)
- **Unauthenticated REST API on loopback:** the bbernhard container exposes its REST API (default `127.0.0.1:8090`) without an API key by default. It is bound to loopback, but any local process can reach it and could send messages as your account, read contacts, or drive the agent. Run pi-signal only on a **single-trusted-user host** and don't expose the port. (bbernhard optionally supports an API key; this extension does not currently send one.)
- Third-party contact names from `signal_list_contacts` are sanitized before reaching the agent.

## Troubleshooting

```bash
docker ps                                # container running?
docker logs --tail 50 -f signal-api      # container / signal-cli output
curl -s http://127.0.0.1:8090/v1/about   # REST API reachable?
```

- `/signal-status` in pi — shows REST API health and WebSocket state
- `PI_SIGNAL_DEBUG=true` — verbose extension logging (WebSocket frames, parsing, sends, REST requests, attachment downloads)

See [skills/signal/SKILL.md](skills/signal/SKILL.md) for full troubleshooting.

## Files

```
pi-signal/
├── package.json
├── README.md
├── CHANGELOG.md
├── LICENSE
├── extensions/
│   ├── signal.ts                # Business logic / plumbing (commands, WebSocket, agent integration)
│   ├── utils.ts                 # Shared utilities (phone parsing, fuzzy match, envelope parsing)
│   ├── rest-client.ts           # REST API client for signal-cli container
│   └── attachments.ts           # Attachment download and cleanup
├── skills/
│   └── signal/SKILL.md          # Full setup & troubleshooting guide
└── scripts/
    └── setup.sh                 # Interactive Docker setup wizard (container "signal-api")
```

## License

MPL-2.0 — see [LICENSE](LICENSE).
