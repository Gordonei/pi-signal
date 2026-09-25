---
name: signal
description: >
  Connect pi to Signal Messenger via the bbernhard/signal-cli-rest-api
  container. Use when the user wants to set up two-way messaging between pi
  and a mobile Signal account, or asks to "set up signal", "connect signal",
  "text pi on signal".
---

# Signal ↔ pi Integration

Two-way messaging between pi and Signal. The pi extension talks to a
[bbernhard/signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) Docker
container over REST (send, reactions, contacts, health) and a persistent
WebSocket (`/v1/receive/{number}`) for incoming messages. signal-cli runs
inside the container — no host daemon, no log file, no systemd unit.

## Prerequisites

- Docker (or Podman)
- Signal app on your phone

Java and signal-cli are **not** needed on the host — they run inside the container.

## Installation

Installing the pi package (via npm) and provisioning the container (via `setup.sh`) are two
separate steps — the package ships `scripts/setup.sh` inside it, so no `git clone` is needed.

```bash
# 1. Install the pi package
pi install @gordoneiza/pi-signal
```

Restart pi or run `/reload`.

## Step 2 — Run the setup wizard

```
/signal-setup
```

This prints setup guidance — the bbernhard/signal-cli-rest-api container must be
reachable at `PI_SIGNAL_DAEMON_URL` (default `http://127.0.0.1:8090`). Use
`/signal-status` to verify reachability. If the container isn't running yet, run
the wizard in a real terminal:

```bash
bash <installed-path>/scripts/setup.sh
```

pi's command can't run it for you — the script needs a blocking phone QR scan,
and `pi.exec` runs commands without a terminal attached. It will:
1. Find a container runtime (docker or podman)
2. Ask for your Signal number (E.164)
3. Reuse or recreate the `signal-api` container (volume `signal-api-data` keeps link state)
4. Publish `127.0.0.1:8090:8080` and start the `bbernhard/signal-cli-rest-api` container
5. Link your Signal device (`signal-cli -a NUMBER link` — QR scan)
6. Verify the REST API (`/v1/about`) and print the export lines to add to your shell config

## Step 3 — Set environment variables

Add to your shell config (`~/.profile`, `~/.zshrc`, etc.) — `setup.sh` prints these at the end:

```bash
export PI_SIGNAL_ACCOUNT=+1234567890   # your Signal number (E.164)
export PI_SIGNAL_PRIMARY=true          # marks this instance as handling Signal
# Optional — numbers allowed to send/receive with the agent (default: self only)
# export PI_SIGNAL_ALLOWLIST=+15551234567,+441234567890
```

Then reload: `source ~/.profile`, restart pi (or `/reload`).

## Step 4 — Test it

Verify with `/signal-setup` and `/signal-status` in pi, then send a Note-to-Self
message from your phone. pi receives it (👀) and responds (✅).

---

## How It Works

```
bbernhard/signal-cli-rest-api container ("signal-api")
  ├── signal-cli process (inside the container, data in /root/.local/share/signal-cli)
  ├── REST API on 127.0.0.1:8090 (container 8080)
  │   ├── POST /v1/send                      — send a message
  │   ├── POST|DELETE /v1/reactions/{number} — add/remove a reaction
  │   ├── GET  /v1/contacts/{number}         — contact list (name → number)
  │   └── GET  /v1/about                     — health/version
  └── WebSocket: /v1/receive/{number}
      └── Streams incoming envelopes in real time (json-rpc-native mode)

pi extension (signal.ts)
  ├── WebSocket listener (primary instance only)
  │   ├── Auto-reconnects with exponential backoff (2s–60s)
  │   └── parseEnvelope() — handles dataMessage + syncMessage
  ├── Sender filter — self always allowed; others only if in PI_SIGNAL_ALLOWLIST
  ├── React with 👀
  └── Command dispatch:
      ├── /model <name>    → fuzzy match & switch model
      ├── /abort           → stop current generation
      ├── /clear           → new session / reset context
      ├── /stats [mode]    → toggle usage stats
      ├── /status /whoami  → in-memory status (no network, no hang)
      ├── /resend          → replay last reply
      ├── /pause /resume   → gate message forwarding
      └── else             → pi.sendUserMessage() → LLM processes
         └── agent_end → auto-reply via REST POST /v1/send + stats footer
            └── Swap 👀 → ✅
```

## Security model

- **Default-deny allowlist.** Only `PI_SIGNAL_ACCOUNT` (self) is allowed by default.
  Incoming messages from any other number get a 🚫 reaction and a short rejection
  reply; they never reach the agent. `signal_send` and `/signal-send` likewise
  refuse to deliver to non-allowlisted numbers. Add trusted numbers via
  `PI_SIGNAL_ALLOWLIST` (comma-separated E.164).
- **No local message logs.** Messages flow over a loopback WebSocket; pi-signal
  writes no message content to a log file. The signal-cli data store inside the
  container volume (`signal-api-data`) does hold conversation data — protect the
  volume and the container accordingly.
- **Unauthenticated REST API on loopback — trust boundary.** The bbernhard
  container exposes its REST API on `127.0.0.1:8090` with **no API key by
  default**. It is bound to loopback, so it is not reachable over the network —
  but **any local user or process on the host** can reach it. Such a process
  could send Signal messages as your account, read incoming message content and
  your contact list, or drive the pi agent by injecting a message. **Run
  pi-signal only on a single-trusted-user host.** Do not expose port 8090 beyond
  loopback. (bbernhard optionally supports an API key via its `API_KEY` env var;
  this extension does not currently send one.)
- **Contact names are treated as untrusted.** Display names and usernames
  returned by `signal_list_contacts` come from third-party Signal profiles, so
  they are sanitized (control characters, newlines, and zero-width/bidi marks
  stripped; length capped) before reaching the agent, to blunt prompt-injection
  via a crafted profile name.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PI_SIGNAL_ACCOUNT` | Yes | — | Your Signal phone number, E.164 format: `+1234567890` |
| `PI_SIGNAL_PRIMARY` | No | `false` | Set to `"true"` on the ONE instance that should handle Signal messages |
| `PI_SIGNAL_DAEMON_URL` | No | `http://127.0.0.1:8090` | Base URL of the bbernhard/signal-cli-rest-api container (REST + WebSocket) |
| `PI_SIGNAL_ALLOWLIST` | No | empty = self only | Comma-separated E.164 numbers allowed to send/receive with the agent. `PI_SIGNAL_ACCOUNT` is always allowed regardless. |
| `PI_SIGNAL_STATS` | No | `short` | Default stats mode: `off`, `short`, or `full` |
| `PI_SIGNAL_DEBUG` | No | `false` | Set to `"true"` or `"1"` to enable verbose debug logging from the Signal extension. When off, only `console.error` messages appear. |

---

## Auto-Reply Behavior

1. Message arrives (self, or allowlisted) → extension sends 👀 reaction
2. Message forwarded to LLM via `pi.sendUserMessage()`
3. LLM responds → `agent_end` event fires
4. Response auto-sent to Signal via REST `POST /v1/send`
   - Sends as **sync message** (recipient-based delivery with resolved UUID) so it appears **grey** (synced from another device), not blue (outgoing). Requires the phone to be a separate linked device.
5. 👀 swapped to ✅ (or ❌ on failure)
6. **Stats footer** appended after response (if `PI_SIGNAL_STATS != off`)

If the agent calls `signal_send` during processing, auto-reply is suppressed to prevent duplicates.

---

## Signal Commands

Send these as Note-to-Self messages from your phone (allowlisted senders can use
them too). Commands are intercepted by the extension and handled locally (not sent to the LLM).

| Command | Args | Purpose |
|---|---|---|
| `/model <partial>` | Model name fragment | Fuzzy-match and switch to a model. E.g. `/model claude`, `/model gpt-4o`, `/model sonnet`. Shows closest matches if ambiguous. |
| `/abort` | — | Stop the current LLM generation immediately. Swaps 👀 → 🛑 on your original message. |
| `/clear` | — | Start a fresh session — clears conversation context and restarts. Aborts any in-progress generation first. |
| `/stats` | `short` / `full` / `off` | View current stats mode or change it. `/stats full` enables detailed stats, `/stats off` disables them. |
| `/status` | — | Report live connection & model info from in-memory state (no network call, cannot hang). **Only ever answers when pi is up** — if pi or the container is down, the message is never received, so no reply comes. Use it as a liveness ping, not a down-detector. |
| `/whoami` | — | Show current model/provider, working directory, and session name. |
| `/resend` | — | Re-send the exact text of the last reply. Recovers a message Signal dropped without re-running the LLM. |
| `/pause` | — | Stop forwarding incoming messages to the agent. Commands (including `/resume`) still work. |
| `/resume` | — | Resume forwarding messages to the agent. |
| `/help` | — | Show a list of available phone commands. |

### Sending to another number from the phone

There is no `/send` command — instead, ask the LLM naturally: *"summarize the last email and text it to +15551234567."* The agent calls the `signal_send` tool with that recipient, which delivers the message to that number. The target must be in `PI_SIGNAL_ALLOWLIST` (your own number is always allowed); otherwise the send is blocked. Because the recipient is not yourself, the extension keeps the reply context, so the agent's own confirmation (e.g. *"I've sent the summary to +15551234567."*) comes back to your Note-to-Self.

You can also refer to people **by name** — *"send this to Mike."* The agent first calls `signal_list_contacts` (optionally with a `query` like "Mike") to resolve the name to a number, asks you which one if several match, then sends. A name only resolves if signal-cli knows it: a contact name synced from your phone's address book, or the person's Signal profile name. Contacts with no phone number (uuid-only) are not offered, since `signal_send` needs an E.164 number.

> The confirmation is the agent's final message. If a model returns only the tool call with no closing text, no confirmation is sent — but in practice models narrate after sending. When the agent sends to **yourself**, the self auto-reply is suppressed to avoid a duplicate.

### `/model` — Fuzzy Matching Details

The extension matches your query against model names and provider IDs:

1. **Exact match** (case-insensitive) — switches immediately
2. **Substring match** — e.g. `sonnet` matches any model with "sonnet" in its name
3. **Levenshtein (typo-tolerant)** — e.g. `claud` matches `claude`
4. **Closest matches shown** — if nothing close, shows top 5 candidates

---

## Usage Stats

A stats footer is appended to every LLM response (configurable). This shows context usage and model info.

**Short format (default):**
```
───
Claude Sonnet 4 · 1.2K ctx · 24%
```

**Full format:**
```
───
Model: Claude Sonnet 4 (anthropic/claude-sonnet-4-20250514)
Context: 1,234 tokens
Window: 200,000 tokens
Usage: 24%
```

Control via `/stats` command or `PI_SIGNAL_STATS` environment variable.

---

## Commands (in pi TUI)

These are also available as slash commands in pi's interactive TUI mode:

| Command | Purpose |
|---|---|
| `/signal-setup` | Setup guidance (container must be reachable at `PI_SIGNAL_DAEMON_URL`); run `setup.sh` for the full Docker wizard |
| `/signal-status` | Show REST API health (`/v1/about`), WebSocket state, account, stats mode |
| `/signal-send <+E164> <msg>` | Send a Signal message from the TUI (validates E.164, subject to the allowlist) |
| `/signal-model <name>` | Switch model by fuzzy-matching partial name |
| `/signal-abort` | Stop current LLM generation |
| `/signal-stats [short\|full\|off]` | View or toggle stats mode |

## Tools (LLM-accessible)

| Tool | Purpose |
|---|---|
| `signal_send` | Send a Signal message to a phone number (E.164). Blocked for numbers not in the allowlist. |
| `signal_status` | Check REST API reachability and WebSocket connection state |
| `signal_list_contacts` | List contacts as name → number pairs (optional `query` filter) so the agent can resolve a name to a number before `signal_send` |

---

## Troubleshooting

### Container not running

```bash
docker ps                                  # is "signal-api" running?
docker logs --tail 50 -f signal-api        # container / signal-cli output
```

Common issues:
- **Container exits immediately** — check `docker logs signal-api`; usually a bad image pull or an existing lock on the data volume from another signal-cli process.
- **Port 8090 already in use** — `lsof -tiTCP:8090 -sTCP:LISTEN` to find the culprit; stop it or pick another port and set `PI_SIGNAL_DAEMON_URL`.

### Messages not appearing in pi

```bash
# Is the container running?
docker ps

# Is the REST API healthy?
curl -s http://127.0.0.1:8090/v1/about

# Check pi's WebSocket connection status
/signal-status        # in pi
```

> **Note:** There is no log file to tail. Set `PI_SIGNAL_DEBUG=true` and restart pi
> for verbose extension logging (WebSocket frames, envelope parsing, sends).

### Commands not working

- If `/model`, `/abort`, `/clear`, or `/stats` don't respond, the extension may not have captured the session context yet. Ensure the extension loaded correctly with `/signal-status`.
- Check pi's logs for any errors from the signal extension.

### General

- `/signal-status` in pi — shows REST API health, WebSocket state, stats mode
- `curl -s http://127.0.0.1:8090/v1/about` — REST API version/health
- `docker logs --tail 50 signal-api` — container-side signal-cli output
- `PI_SIGNAL_DEBUG=true` — verbose extension logging

---

## File Locations

| File | Path |
|---|---|
| Container | `signal-api` (image `bbernhard/signal-cli-rest-api`) |
| Container volume | `signal-api-data` (signal-cli data, mounted at `/root/.local/share/signal-cli`) |
| Setup wizard | `scripts/setup.sh` in the installed package |
