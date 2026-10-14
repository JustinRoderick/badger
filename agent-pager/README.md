# Agent Pager

Agent Pager turns the Universe 2025 badge into a remote for your
[T3 Code](https://t3.codes) agents. The badge shows what each agent is doing,
takes over the screen when an agent needs approval or asks a question, and
lets you interrupt agents or send them a canned prompt.

```text
T3 Code ──WebSocket──► bridge.mjs (your computer) ◄──Wi-Fi, HTTP── badge
```

The badge app is in [`../badge25/apps/agent_pager/`](../badge25/apps/agent_pager/).
The bridge has no dependencies and needs Node 22 or newer.

## Badge controls

| Screen | Controls |
| --- | --- |
| Agent list | UP/DOWN select, B open, C send a prompt, A refresh, hold B to interrupt the selected agent, hold A+C to stop all agents |
| Agent detail | A back, C send a prompt, hold B to interrupt |
| Needs approval | A deny, B later, C allow, UP/DOWN switch between requests |
| Question | UP/DOWN choose, C answer, B later |

The case LEDs blink while an agent is waiting for you and pulse slowly while
agents are working.

## Setup

1. Issue a T3 token limited to reading and operating threads. Run this on the
   machine where T3 Code runs:

   ```sh
   ~/.t3/bin/t3 auth session issue --scope orchestration:read \
     --scope orchestration:operate --label agent-pager --ttl 90d --token-only
   ```

   Put it in `~/.config/agent-pager/config.json`:

   ```json
   { "t3": { "token": "<t3 token>" } }
   ```

   Revoke it any time with `t3 auth session list` and `t3 auth session revoke <id>`.

2. Start the bridge:

   ```sh
   node agent-pager/bridge.mjs
   ```

   On first run it adds a random badge `token` to the config file.

   Run it as a service so it survives terminals, agent sessions, and reboots.
   On macOS, create `~/Library/LaunchAgents/com.agent-pager.bridge.plist` with
   `ProgramArguments` set to your `node` path and `bridge.mjs`, and set
   `RunAtLoad` and `KeepAlive` to true. Then run
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-pager.bridge.plist`.
   Restart it with `launchctl kickstart -k gui/$(id -u)/com.agent-pager.bridge`.
   Remove it with `launchctl bootout gui/$(id -u)/com.agent-pager.bridge`.
   On Linux, use the systemd unit below.

3. Add these lines to the badge's `secrets.py`. Put the badge in mass-storage mode
   to edit it. The badge needs a 2.4 GHz network.

   ```python
   WIFI_SSID = "your-network"
   WIFI_PASSWORD = "..."
   PAGER_URL = "http://<bridge-ip>:8787"
   PAGER_TOKEN = "<token from ~/.config/agent-pager/config.json>"
   ```

4. Copy `badge25/apps/agent_pager/` to `/system/apps/` on the badge. The stock
   menu only lists six hard-coded apps. Copy `badge25/apps/menu/` as well to get
   the auto-discovering, paginated menu.

## Configuration

`~/.config/agent-pager/config.json` (override the path with `PAGER_CONFIG`):

| Key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `token` | `PAGER_TOKEN` | generated | Shared secret the badge sends |
| `backend` | `PAGER_BACKEND` | `t3` | `t3`, or `mock` for fake agents |
| `host` | `PAGER_HOST` | `0.0.0.0` | Interface to listen on |
| `port` | `PAGER_PORT` | `8787` | Port to listen on |
| `prompts` | | see `config.mjs` | Canned prompts offered on the badge |
| `t3.token` | `T3_TOKEN` | | T3 bearer token from step 1 |
| `t3.origin` | `T3_ORIGIN` | from `~/.t3/userdata/server-runtime.json` | T3 server URL |
| `t3.maxIdleHours` | | `24` | Hide idle threads older than this |

## Running on Linux

The bridge runs as-is on Linux. Point it at a T3 server with `T3_ORIGIN`:

- **Same machine as T3** (`t3 serve` or the service): nothing to change.
  The bridge reads `~/.t3/userdata/server-runtime.json` or falls back to
  `http://127.0.0.1:3773`.
- **Different machine:** start T3 with `t3 serve --host <lan-or-tailnet-ip>`,
  then set `T3_ORIGIN=http://<that-ip>:3773`.

A systemd user unit, saved as `~/.config/systemd/user/agent-pager.service`:

```ini
[Unit]
Description=Agent Pager bridge
After=network-online.target

[Service]
ExecStart=/usr/bin/node %h/badger/agent-pager/bridge.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

Enable it with `systemctl --user enable --now agent-pager`.

## Testing without real agents

```sh
PAGER_BACKEND=mock PAGER_TOKEN=devtoken node agent-pager/bridge.mjs
```

The mock backend makes fake agents that ask for approval and ask questions
every few seconds. The Universe 2025 simulator can run the badge app against it.

## Security

- Anyone with the badge token can approve commands and send prompts to your
  agents. Keep the bridge on a trusted network or a tailnet.
- The badge uses plain HTTP. Don't forward the port to the internet.
- The T3 token only has the `orchestration:read` and `orchestration:operate`
  scopes.
