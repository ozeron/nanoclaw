---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# NanoClaw Container Debugging

This guide covers v2 NanoClaw container debugging. It avoids stale v1-only flows (old `store/messages.db`, `/workspace/ipc`, and legacy session path assumptions).

## Architecture Overview

```
Host (Node)                           Container (runtime)
────────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns container                      │ reads session DB + mcp tools
    │ with volume mounts                   │ writes via outbound DB
    │                                      │
    ├── data/v2-sessions/<agent>/session-dir ──> /workspace
    │     (inbound.db/outbound.db/outbox)         (inbound.db/outbound.db/outbox)
    ├── groups/<folder>                    ──> /workspace/agent
    ├── data/v2-sessions/<agent>/.claude-shared ─> /home/node/.claude
    └── container/CLAUDE.md (global)       ──> /app/CLAUDE.md
```

**Important:** The container runs as user `node` with `HOME=/home/node`. Shared Claude state is mounted from `/home/node/.claude`.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Router/sweep/container spawn, container exit events |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side failures |
| **Container runtime logs** | `${CONTAINER_RUNTIME:-docker} logs <container>` | Current container stderr when inspecting a live container |
| **Agent state** | `data/v2-sessions/<agent>/.claude-shared` and per-session `codex/` dirs | Runtime prompt settings, skills, and Codex auth/config copies |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug pnpm run dev

# For launchd service (macOS), add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
# For systemd service (Linux), add to unit [Service] section:
# Environment=LOG_LEVEL=debug
```

Debug level shows:
- Full mount configurations
- Container command arguments
- Real-time container stderr

## Common Issues

### 1. "No adapter for channel type" / Messages silently lost (null platformMsgId)

**Symptom:** The bot stops replying. `logs/nanoclaw.error.log` shows repeated:
```
WARN No adapter for channel type channelType="telegram"
WARN No adapter for channel type channelType="signal"
```
The main log shows "Message delivered" entries with `platformMsgId=undefined` — meaning the delivery poll ran, found no adapter, and permanently marked the message as delivered without sending it.

**Root cause: two NanoClaw service instances running simultaneously.**

When a second service instance (often `nanoclaw-v2-<id>.service` running alongside `nanoclaw.service`) is active with a stale binary, it has no channel adapters registered. Its delivery poll races against the working instance and wins — permanently marking outbound messages as delivered without ever sending them.

**Diagnosis:**
```bash
# Check for duplicate running instances
ps aux | grep 'nanoclaw/dist/index.js' | grep -v grep

# Check which services are active
systemctl --user list-units 'nanoclaw*' --all

# Confirm channel adapters registered by the current process
grep "Channel adapter started" logs/nanoclaw.log | tail -10
```

**Fix:**
1. Identify which service has the correct binary and EnvironmentFile (the one showing `signal`, `telegram`, `cli` all started in the log).
2. Stop and disable the stale duplicate service:
   ```bash
   systemctl --user stop nanoclaw.service   # or whichever is the old one
   systemctl --user disable nanoclaw.service
   ```
3. If the remaining service unit is missing `EnvironmentFile`, add it:
   ```bash
   # Edit the service unit — add this line under [Service]:
   # EnvironmentFile=/home/[user]/nanoclaw/.env
   systemctl --user daemon-reload
   systemctl --user restart nanoclaw-v2-<id>.service
   ```
4. Verify only one instance runs: `ps aux | grep nanoclaw/dist/index.js | grep -v grep`

**Note:** Messages that were marked delivered with a null `platform_message_id` cannot be automatically retried — they are permanently lost. The user must resend their message.

### 2. "Codex process exited with code 1"

**Check startup and error lines in host logs**:

Common causes:

#### Missing Authentication
```
Invalid API key · Please run /login
```
**Fix:** Ensure either host auth or key is configured for the selected provider:
```bash
cat .env | grep -E 'OPENAI_API_KEY|CODEX_MODEL|ONECLI_URL'
ls "$HOME/.codex/auth.json"
```

#### Root User Restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER node`.

### 3. Environment Variables and credentials

Most credentials now move through OneCLI and are injected per request. Host env pass-through is intentionally limited:

```bash
# Verify credentials are discoverable to OneCLI
onecli secrets list | head -n 20
```

For direct Codex/OpenAI auth, check:
```bash
ls "$HOME/.codex/auth.json" && echo "codex auth.json exists"
grep -q '^OPENAI_API_KEY=' .env && echo "OPENAI_API_KEY set"
```

### 3. Mount Issues

**Container mount notes:**
- Use `${RUNTIME}` for local runtime (docker or podman), not `docker` literals
- Use `:ro` suffix for readonly mounts:
  ```bash
  # Readonly
  -v /path:/container/path:ro

  # Read-write
  -v /path:/container/path
  ```

To check what's mounted inside a container:
```bash
RUNTIME="${CONTAINER_RUNTIME:-docker}"
"${RUNTIME}" run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace /workspace/agent /home/node/.claude /app'
```

Expected structure:
```
/workspace/
├── inbound.db            # Host writes messages_in + delivered/routing projections
├── outbound.db           # Container writes messages_out + processing_ack
├── outbox/               # Legacy compatibility dir for host writes
└── .heartbeat            # Heartbeat touch file

/workspace/agent
├── CLAUDE.md
├── CLAUDE.local.md
├── .claude-fragments/
└── <group files>
```

### 4. Permission Issues

The container runs as user `node` (uid 1000). Check ownership:
```bash
RUNTIME="${CONTAINER_RUNTIME:-docker}"
"${RUNTIME}" run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  whoami
  ls -la /workspace/
  ls -la /app/
'
```

All of `/workspace/` and `/app/` should be owned by `node`.

### 5. Session Not Resuming / "Codex process exited with code 1"

If sessions aren't resuming (new session ID every time), check v2 session DB and resume state:

**Check current mount target:**
```bash
# In container-runner.ts, verify mount is to /home/node/.claude/, NOT /root/.claude/
grep -n "per-group .claude-shared" src/container-runner.ts
```

**Verify per-session DB path:**
```bash
ls data/v2-sessions/*/*/inbound.db | head
```

### 6. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the container logs for MCP initialization errors.

## Manual Container Testing (limited in v2)

### Test the full agent flow:
```bash
# v2 has no stdin API into the image; full flow should be exercised through host routing.
# Use a host-side message send (ncl / existing group tooling) instead.
```

### Interactive shell in container:
```bash
RUNTIME="${CONTAINER_RUNTIME:-docker}"
"${RUNTIME}" run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

## Rebuilding After Changes

```bash
# Rebuild main app
pnpm run build

# Rebuild container (use --no-cache for clean rebuild)
./container/build.sh

# Or force full rebuild
RUNTIME="${CONTAINER_RUNTIME:-docker}"
${RUNTIME} builder prune -af
./container/build.sh
```

## Checking Container Image

```bash
# List images
RUNTIME="${CONTAINER_RUNTIME:-docker}"
"${RUNTIME}" images

# Check what's in the image
RUNTIME="${CONTAINER_RUNTIME:-docker}"
"${RUNTIME}" run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  echo "=== Node version ==="
  node --version

  echo "=== Codex version ==="
  codex --version

  echo "=== Installed packages ==="
  ls /app/node_modules/
'
```

## Session Persistence

Codex/OpenAI sessions are stored per-session in v2 folders:

- `data/v2-sessions/<agent-group>/<session-id>/inbound.db`
- `data/v2-sessions/<agent-group>/<session-id>/outbound.db`
- Shared agent-side state in `data/v2-sessions/<agent-group>/.claude-shared` (v2)

**Critical:** The mount path must match the container user's HOME directory:
- Container user: `node`
- Container HOME: `/home/node`
- Mount target: `/home/node/.claude/`

To clear sessions:

```bash
# Clear all sessions for all groups
rm -rf data/v2-sessions/*/*/

# Clear sessions for one agent group and tracking row
rm -rf data/v2-sessions/<agent-group>/<session-id>/
pnpm exec tsx scripts/q.ts data/v2.db "DELETE FROM sessions WHERE id = '<session-id>'"
```

To verify session resumption is working, check the logs for the same session ID across messages:
```bash
grep "Session initialized" logs/nanoclaw.log | tail -5
# Should show the SAME session ID for consecutive messages in the same group
```

## IPC Debugging

NanoClaw v2 does not communicate via the old `/workspace/ipc` file protocol.
Use `inbound.db`/`outbound.db` and host logs instead.

### DB-backed checks
```bash
pnpm exec tsx scripts/q.ts data/v2-sessions/<agent>/<session>/outbound.db "SELECT * FROM messages_out ORDER BY id DESC LIMIT 5"
```

## Quick Diagnostic Script

Run this to check common issues:

```bash
RUNTIME="${CONTAINER_RUNTIME:-docker}"

echo "=== Checking NanoClaw Container Setup ==="

echo -e "\n1. Authentication configured?"
if [ -f "$HOME/.codex/auth.json" ]; then
  echo "OK (~/.codex/auth.json)"
elif [ -f .env ] && grep -q '^OPENAI_API_KEY=' .env; then
  echo "OK (OPENAI_API_KEY)"
else
  echo "MISSING - set OPENAI_API_KEY or run codex login"
fi

echo -e "\n2. Codex auth file for subscription auth?"
[ -f "$HOME/.codex/auth.json" ] && echo "OK" || echo "No ~/.codex/auth.json (token auth optional)"

echo -e "\n3. Container runtime running?"
${RUNTIME} info &>/dev/null && echo "OK" || echo "NOT RUNNING - start ${RUNTIME}"

echo -e "\n4. Container image exists?"
echo '{}' | ${RUNTIME} run -i --entrypoint /bin/echo nanoclaw-agent:latest "OK" 2>/dev/null || echo "MISSING - run ./container/build.sh"

echo -e "\n5. Session mount path correct?"
grep -q "/home/node/.claude" src/container-runner.ts 2>/dev/null && echo "OK" || echo "WRONG - should mount /home/node/.claude/"

echo -e "\n6. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n7. Recent container logs?"
grep "spawn" logs/nanoclaw.log 2>/dev/null | tail -1 || echo "No recent container-spawn logs"

echo -e "\n8. Session continuity working?"
SESSIONS=$(grep "Session initialized" logs/nanoclaw.log 2>/dev/null | tail -5 | awk '{print $NF}' | sort -u | wc -l)
[ "$SESSIONS" -le 2 ] && echo "OK (recent sessions reusing IDs)" || echo "CHECK - multiple session IDs in recent startup events"
```
