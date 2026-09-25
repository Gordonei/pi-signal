# Changelog

## Unreleased

### Added
- **Signal typing indicator:** while the agent is working on a response, the extension shows the Signal typing indicator ("message is being written…") to the sender. A 10-second heartbeat keeps the indicator alive during long turns (signal-cli expires it after ~15 seconds). The indicator is cleared when the reply is sent or the turn ends.

## 2.0.0

Major release — the integration has moved from the native signal-cli daemon to the bbernhard/signal-cli-rest-api container. Breaking changes: `PI_SIGNAL_DAEMON_URL` default port moved 8080 → 8090, `PI_SIGNAL_QUIET_DAEMON` removed, TUI commands `/signal-start`, `/signal-stop`, `/signal-restart`, `/signal-logs` removed, and setup now requires Docker instead of host Java/signal-cli/systemd.

### Changed
- **Rewrote the extension to use the bbernhard/signal-cli-rest-api container** (REST for send/reactions/contacts/health + persistent WebSocket on `/v1/receive/{number}` for incoming). Replaces the JSON-RPC + SSE integration with the native signal-cli daemon.
- **Containerized deployment:** the systemd service (`signal-receive.service`), the native receive-loop script, and the Java/signal-cli-on-host setup helpers are gone. `scripts/setup.sh` is now a Docker/Podman wizard (container `signal-api`, volume `signal-api-data`).
- Default `PI_SIGNAL_DAEMON_URL` moved from `http://127.0.0.1:8080` to `http://127.0.0.1:8090`.
- Removed TUI commands `/signal-start`, `/signal-stop`, `/signal-restart`, and `/signal-logs` (no host service to manage). `/signal-status` now reports REST API health and WebSocket state.

### Added
- **`PI_SIGNAL_ALLOWLIST`** — comma-separated E.164 numbers allowed to send/receive with the agent. Default is self-only (default-deny); non-allowlisted senders get a 🚫 reaction and a rejection reply, and `signal_send`/`/signal-send` refuse non-allowlisted recipients.
- **`PI_SIGNAL_DEBUG`** — set `true`/`1` for verbose extension logging; when off, only `console.error` output appears.

### Fixed
- WebSocket messages are parsed in the container's JSON-RPC envelope format.
- `parseEnvelope` failures are logged at debug level instead of error, and dropped-message logging no longer breaks output.

### Removed
- `PI_SIGNAL_QUIET_DAEMON` — the daemon no longer runs on the host, so there is no journal output to quiet.

## 1.1.1

### Security
- **Quiet daemon by default:** `PI_SIGNAL_QUIET_DAEMON` now defaults to `true`, so signal-cli daemon output no longer lands in `journalctl`. Set it to `false` to surface daemon output for debugging. *(Applies to new/re-run setups; existing hosts pick it up after re-running `setup.sh` or restarting the service with the updated script.)*
- **Contact-name sanitization:** display names and usernames returned by `signal_list_contacts` are third-party controlled and are now stripped of control characters, newlines, and zero-width/bidi marks (and length-capped) before reaching the agent, reducing prompt-injection risk from a crafted Signal profile name.

## 1.1.0

### Added
- **Phone commands:** `/status` (live connection & model info, in-memory — never hangs), `/whoami` (model, directory, session), `/resend` (re-send last reply), `/pause` and `/resume` (gate message processing without stopping the service).
- **TUI commands:** `/signal-restart` (restart the systemd service), `/signal-logs [n]` (recent journal lines), `/signal-send <+E164> <msg>` (send from the TUI).
- **`signal_list_contacts` tool:** resolves a contact name to a number so you can say *"send this to Mike"* — the agent looks up the number, then sends.

### Changed
- Sending your response to another number now returns the agent's confirmation to your Note-to-Self, so you can see it was sent and to whom (self-sends still suppress the duplicate).

### Removed
- `/ping` — superseded by `/status`.
