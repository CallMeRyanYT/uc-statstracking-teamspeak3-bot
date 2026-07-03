# UC Stats Tracking Bot — TeamSpeak 3

A **fully-featured activity & stats tracking bot** for TeamSpeak 3 servers. Tracks how long every user spends online server-wide, reports leaderboards automatically to Discord every hour, and serves a live web dashboard — accessible publicly via Cloudflare Tunnel with zero port forwarding required.

---

## Features

| Feature | Details |
|---|---|
| **Global Server Tracking** | Tracks hours per user across **all channels** automatically |
| **Away / AFK Detection** | If a user has TS3 "away" toggled for **≥ 5 minutes**, their time is paused |
| **Per-period Leaderboards** | All-time, today, this week, this month |
| **Session Tracking** | Individual session start/end, duration, channel |
| **Channel Stats** | Time spent per channel per user |
| **Peak Hours Heatmap** | What hours each person is most active |
| **AFK Time Log** | Tracks separately so you can see real vs AFK presence |
| **Chat Commands** | Type commands in TS3 chat to query stats (prefix: `#`) |
| **Discord Webhook** | Hourly leaderboard, daily MVP, weekly summary — automatically posted |
| **Web Dashboard** | Dark-mode live leaderboard at `localhost:3010` |
| **Cloudflare Tunnel** | Public URL auto-generated — no port forwarding needed |
| **Localhost Support** | Works when TS3 server and bot run on the **same PC** |
| **Persistent Data** | SQLite database stored in a Docker volume — survives restarts |

---

## Quick Start

> **Prerequisites:** Docker Desktop must be installed and running. See [README.docker.md](README.docker.md) for a step-by-step Docker guide.

### Step 1 — Run the Setup Wizard

Open **PowerShell** in the project folder and run:

```powershell
.\setup.ps1
```

The wizard will ask you for:
- Your TS3 server address (use `host.docker.internal` if the server is on the **same PC**)
- Your **ServerQuery password** (see [How to find your ServerQuery password](#how-to-find-your-serverquery-password))
- Your Discord webhook URL (already pre-configured)

It then builds the Docker image for you.

### Step 2 — Start the Bot

```bat
start_bot.bat
```

Or from PowerShell:

```powershell
docker compose up -d
```

### Step 3 — View the Dashboard

- **Local:** http://localhost:3010
- **Public (Cloudflare Tunnel):** Run `docker logs uc-stats-tunnel` — the public URL is printed there

---

## How to Find Your ServerQuery Password

TeamSpeak 3's **ServerQuery** is a separate admin interface (not the same as your regular TS3 login). You need this to let the bot connect.

### Method 1 — Server startup log (easiest)

When your TS3 server starts for the **very first time**, it prints:

```
------------------------------------------------------------------
                      I M P O R T A N T
------------------------------------------------------------------
               Server Query Admin Account created
         loginname= "serveradmin", password= "XXXXXXXXXX"
------------------------------------------------------------------
```

Copy that password and put it in your `.env` as `TS3_QUERY_PASS`.

> **If you missed it:** The password is stored in `query_ip_whitelist.txt` inside your TS3 server folder — or you can reset it using the steps below.

### Method 2 — Reset via TS3 server console

1. Open your TS3 server executable **from the command line**:
   ```
   ts3server.exe serveradmin_password=newpassword
   ```
2. Use `newpassword` as your `TS3_QUERY_PASS`.

### Method 3 — Read from the server's files

Look inside your TS3 server data folder for a file called `serveradmin.password` or check the `ts3server.log` for the initial password line.

---

## Chat Commands

Type these in **any TS3 channel** (the bot listens server-wide). All commands start with `#`.

| Command | Description |
|---|---|
| `#help` | Show all available commands |
| `#stats` | Your full stats card (total time, rank, AFK time, sessions…) |
| `#stats [name]` | Stats for another user (partial name match works) |
| `#rank` | Your current leaderboard rank |
| `#rank [name]` | Another user's rank |
| `#top` | All-time top 10 leaderboard |
| `#today` | Today's top 10 |
| `#week` | This week's top 10 |
| `#month` | This month's top 10 |
| `#online` | Who's currently online + their current session time |
| `#session` | Your current session duration |
| `#peak` | Your most active hours of the day |
| `#channels` | Your top 5 channels by time |
| `#history` | Your last 5 completed sessions |
| `#afk` | Your total AFK time + percentage |
| `#afk [name]` | Another user's AFK time |
| `#server` | Server-wide stats (total users, hours, sessions) |

---

## Discord Reports

The bot posts automatically to your Discord webhook:

| Schedule | Report |
|---|---|
| **Every hour** | All-time top 10 leaderboard + online user count |
| **Daily (midnight)** | Today's leaderboard + "Most active today" badge |
| **Weekly (Sunday)** | Weekly leaderboard + all-time top 10 |

> The webhook is pre-configured to post to the UC Discord channel. You can change it in your `.env` file (`DISCORD_WEBHOOK_URL`).

### Optional: Join/Leave Notifications

Set `JOIN_LEAVE_WEBHOOK=true` in your `.env` to also post when users join or leave the server.

---

## Cloudflare Tunnel Setup

Cloudflare Tunnel is used only for the public web dashboard. It does not make the bot able to connect to TeamSpeak ServerQuery. The bot still needs direct TCP access to your TS3 ServerQuery port, usually `10011`.

### Option A: Temporary Quick Tunnel

This is the easiest option. It creates a random `trycloudflare.com` URL without a Cloudflare account.

1. Start Docker Desktop.
2. In this project folder, run:
   ```powershell
   docker compose up -d --build
   ```
3. Wait a few seconds, then get the public URL:
   ```powershell
   docker logs uc-stats-tunnel
   ```
4. Look for a line like:
   ```text
   Your quick Tunnel has been created! Visit it at:
   https://example-example-example.trycloudflare.com
   ```
5. Open that URL. You should see the same dashboard as `http://localhost:3010`.

Quick tunnel notes:
- The URL changes when the tunnel container is recreated.
- Use this for testing or sharing the dashboard temporarily.
- The compose command for quick tunnels is:
  ```yaml
  command: tunnel --no-autoupdate --url http://uc-stats-bot:3000
  ```

### Option B: Permanent Cloudflare Dashboard URL

Use this if you own a domain in Cloudflare and want a stable URL such as `stats.yourdomain.com`.

1. Log in to [Cloudflare](https://dash.cloudflare.com).
2. Open **Zero Trust**.
3. Go to **Networks** -> **Tunnels**.
4. Select **Create a tunnel**.
5. Choose **Cloudflared**.
6. Name it something like `uc-stats-dashboard`.
7. Choose **Docker** as the environment.
8. Copy the generated tunnel token.
9. Add the token to `.env`:
   ```env
   CLOUDFLARE_TUNNEL_TOKEN=your_tunnel_token_here
   ```
10. In `docker-compose.yml`, replace the quick tunnel command with:
    ```yaml
    command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
    ```
11. In the Cloudflare tunnel route settings, add a public hostname:
    - Subdomain: `stats`
    - Domain: your Cloudflare domain
    - Type: `HTTP`
    - URL: `http://uc-stats-bot:3000`
12. Restart:
    ```powershell
    docker compose down
    docker compose up -d
    ```
13. In Cloudflare, the tunnel should show **Healthy**. Open your hostname.

### Cloudflare Troubleshooting

If the public dashboard does not load:

1. Check the local dashboard first:
   ```powershell
   Invoke-WebRequest http://localhost:3010/api/health
   ```
2. Check the tunnel logs:
   ```powershell
   docker logs -f uc-stats-tunnel
   ```
3. Check both containers are running:
   ```powershell
   docker ps
   ```
4. For quick tunnels, restart only the tunnel:
   ```powershell
   docker compose restart cloudflare-tunnel
   ```

If the dashboard loads but says **Bot Offline**, Cloudflare is fine. The problem is the bot's connection to TeamSpeak ServerQuery.

---

## AFK / Away Tracking Rules

| Situation | Time Counted? |
|---|---|
| User is **online and active** | ✅ Yes |
| User has **away status for < 5 min** | ✅ Yes (grace period) |
| User has **away status for ≥ 5 min** | ❌ No — paused, AFK time accumulates separately |
| User is **offline** | ❌ No |

The 5-minute threshold matches the server rule: if you toggle away and stay away, your activity is paused. Time resumes the moment you come back.

---

## Configuration Reference (`.env`)

| Variable | Default | Description |
|---|---|---|
| `TS3_HOST` | `host.docker.internal` | TS3 server address. Use `host.docker.internal` for same-PC. |
| `TS3_QUERY_PORT` | `10011` | ServerQuery TCP port |
| `TS3_QUERY_USER` | `serveradmin` | ServerQuery username |
| `TS3_QUERY_PASS` | *(required)* | ServerQuery password |
| `TS3_SERVER_ID` | `1` | Virtual server ID |
| `TS3_SERVER_PORT` | `9987` | Virtual server voice port inside TeamSpeak |
| `TS3_CONNECT_TIMEOUT_MS` | `10000` | TCP/login timeout for ServerQuery |
| `TS3_BOT_NICKNAME` | `UC Stats Bot` | Bot's display name in server tools |
| `DISCORD_WEBHOOK_URL` | *(pre-set)* | Discord webhook for leaderboard posts |
| `JOIN_LEAVE_WEBHOOK` | `false` | Post join/leave events to Discord |
| `MIRROR_COMMAND_RESULTS_TO_DISCORD` | `true` | Mirror command results to Discord, except `#help` |
| `AFK_AWAY_THRESHOLD_MINUTES` | `5` | Minutes before away is treated as AFK |
| `EXCLUDED_CHANNELS` | *(blank)* | Comma-separated channel IDs to skip tracking |
| `BOT_NICKNAMES` | `UC Stats Bot,serveradmin` | Nicknames to never track |
| `POLL_INTERVAL_MS` | `60000` | How often to check online clients (ms) |
| `WEB_PORT` | `3000` | Port the app listens on inside the container |
| `HOST_WEB_PORT` | `3010` | Port exposed on your Windows PC |
| `TZ` | `UTC` | Timezone for cron labels |
| `COMMAND_PREFIX` | `#` | Prefix for chat commands |
| `DEBUG_RAW_TS3` | `false` | Print raw ServerQuery text-message traffic |

---

## Troubleshooting

### Bot won't connect — "Connection refused"

**Cause:** The bot can't reach the TS3 ServerQuery port.

**Fix checklist:**
1. Is your TS3 server actually running?
2. Is ServerQuery enabled? Open your `ts3server.ini` and check `queryport=10011` is set.
3. **Same-PC setup:** Make sure `TS3_HOST=host.docker.internal` in your `.env`.
4. **Firewall:** Allow TCP port 10011 in Windows Firewall.
5. Check the IP allowlist: open `query_ip_whitelist.txt` in your TS3 server folder and make sure `127.0.0.1` is listed.

```powershell
# Test if the port is reachable from your machine:
Test-NetConnection -ComputerName 127.0.0.1 -Port 10011
```

---

### Bot won't connect - "Socket Timeout reached"

**Cause:** The hostname resolves, but the TCP ServerQuery port is not answering. This usually means the port in `.env` points to the TeamSpeak voice/UDP tunnel, the tunnel is down, or ServerQuery TCP is not forwarded.

**Fix checklist:**
1. If your `.env` has `TS3_HOST=hostname:port`, that `port` must be the ServerQuery TCP port.
2. Test the exact host and port:
   ```powershell
   Test-NetConnection -ComputerName viscous-salmon.gl.at.ply.gg -Port 53645
   ```
3. If `TcpTestSucceeded` is `False`, the bot cannot connect yet. Fix the tunnel/forward/firewall first.
4. If the TS3 server is on your same PC, use:
   ```env
   TS3_HOST=host.docker.internal
   TS3_QUERY_PORT=10011
   ```
5. Make sure the TS3 server's ServerQuery is listening on TCP `10011`, not just voice UDP `9987`.
6. If the port is reachable but slow, raise:
   ```env
   TS3_CONNECT_TIMEOUT_MS=20000
   ```

---

### Bot connects but then disconnects immediately — "Error 1" or "Not allowed"

**Cause:** Wrong ServerQuery password or username.

**Fix:**
- Double-check `TS3_QUERY_PASS` in your `.env`
- Make sure `TS3_QUERY_USER=serveradmin`

---

### Bot is running but not tracking anyone

**Cause:** The bot may be filtering out clients.

**Fix checklist:**
1. Check `BOT_NICKNAMES` in `.env` — make sure regular users aren't accidentally listed
2. Check `EXCLUDED_CHANNELS` — make sure the target channel ID isn't in the exclusion list
3. Check the bot logs: `docker logs -f uc-stats-bot`

---

### Web dashboard is blank / shows no data

1. Visit http://localhost:3010/api/leaderboard in your browser
2. If it returns `[]` — no data yet. Wait for the next poll (up to 1 minute).
3. If it returns an error — check bot logs: `docker logs uc-stats-bot`

---

### Discord webhook not posting

1. Check `DISCORD_WEBHOOK_URL` in your `.env` — make sure it's the full URL
2. The hourly post only fires at the top of each hour (e.g. 14:00, 15:00…)
3. Force a test: restart the bot — it will NOT post immediately; wait for the next hour mark
4. Check logs: `docker logs -f uc-stats-bot`

---

### "Cannot find module ts3-nodejs-library"

Run inside the project folder:
```powershell
docker compose build --no-cache
```

---

### Docker build fails with "g++: not found" or Python error

The Dockerfile installs `python3`, `make`, `g++` for the SQLite native module. If the build fails:

```powershell
docker compose build --no-cache --progress=plain
```

This shows full output so you can see what error occurred.

---

### Database is wiped after container restart

This should NOT happen if using the `docker-compose.yml` provided — it mounts a named volume (`uc_stats_data`) that persists across restarts.

To verify:
```powershell
docker volume ls
# Should show: uc_stats_data
```

---

### How to update the bot

```powershell
git pull
docker compose down
docker compose build
docker compose up -d
```

---

## Project Structure

```
uc-statstracking-teamspeak3-bot/
├── src/
│   ├── index.js       # Main entry — TS3 connection, polling, cron, express
│   ├── database.js    # SQLite schema and promisified helpers
│   ├── tracker.js     # Core tracking logic, AFK detection, session management
│   ├── commands.js    # #command handlers for TS3 chat
│   └── discord.js     # Discord webhook report functions
├── web/
│   └── index.html     # Web dashboard (self-contained, dark mode)
├── data/              # SQLite database files (created automatically)
├── .env               # Your configuration (never commit this!)
├── .env.example       # Template — copy to .env and fill in
├── docker-compose.yml # Docker services (bot + Cloudflare tunnel)
├── Dockerfile         # Node.js 20 image
├── setup.ps1          # Interactive setup wizard (Windows)
├── start_bot.bat      # One-click launcher (Windows)
└── README.md          # This file
```

---

## License

MIT — do whatever you want with it.
