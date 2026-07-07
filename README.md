# UC Stats Tracking Bot

Website-only TeamSpeak 3 activity tracker.

The bot uses TeamSpeak ServerQuery to poll who is online, which channel they are in, and how long they stay active. Everything is shown on the web dashboard. There are no TS3 chat commands and no Discord webhooks.

## What It Does

| Feature | Description |
| --- | --- |
| Server-wide tracking | Tracks regular voice clients across the whole virtual server |
| Live dashboard | Leaderboard, online users, channels, recent activity, and user profiles |
| Persistent data | SQLite database in the Docker volume |
| AFK handling | Pauses active time after the configured away threshold |
| Period resets | Daily, weekly, and monthly counters reset automatically |
| Cloudflare tunnel | Optional public dashboard URL without port forwarding |

## Quick Start

1. Copy the env example:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Edit `.env`.

   If Docker runs on the same PC as your TS3 server:

   ```env
   TS3_HOST=host.docker.internal
   TS3_QUERY_PORT=10011
   TS3_QUERY_USER=serveradmin
   TS3_QUERY_PASS=your_password
   TS3_SERVER_ID=1
   TS3_SERVER_PORT=9987
   HOST_WEB_PORT=3000
   ```

3. Start it:

   ```powershell
   docker compose up -d --build
   docker logs -f uc-stats-bot
   ```

4. Open the dashboard:

   http://localhost:3000

## Cloudflare Public URL

The Docker setup starts a temporary Cloudflare quick tunnel by default. This lets other people open the dashboard without port forwarding.

1. Start the stack:

   ```powershell
   docker compose up -d --build
   ```

2. Show the public URL:

   ```powershell
   docker logs uc-stats-tunnel
   ```

3. Look for a URL like:

   ```text
   https://example-name.trycloudflare.com
   ```

That URL points to the same dashboard as `http://localhost:3000`. It changes when the tunnel container is recreated. For a permanent domain, create a named tunnel in Cloudflare Zero Trust and point it to `http://uc-stats-bot:3000` inside Docker, or to `http://localhost:3000` if you run `cloudflared` directly on Windows.

To disable the public URL, comment out or remove the `cloudflare-tunnel` service in `docker-compose.yml`.

## Required TeamSpeak Setup

You still need ServerQuery. A normal visible TS3 client cannot reliably inspect every user server-wide, so this app intentionally uses ServerQuery only.

On your end, make sure:

| Requirement | Why |
| --- | --- |
| ServerQuery TCP is enabled | The bot connects to `TS3_QUERY_PORT`, usually `10011` |
| Docker can reach the TS3 host | Use `host.docker.internal` when TS3 is on the same Windows PC |
| Query account can log in | `TS3_QUERY_USER` and `TS3_QUERY_PASS` must be valid |
| Query account can select the virtual server | Usually `TS3_SERVER_ID=1` |
| Query account can run `clientlist` | Needed to see online users |
| Query account can run `channellist` | Needed to resolve channel names |
| Query account can run `clientinfo` | Used by profile/online detail paths when needed |

The bot does not need to join `Stalking Room`. It does not need text-message permissions anymore.

## Config Reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `TS3_HOST` | `host.docker.internal` | TS3 ServerQuery host |
| `TS3_QUERY_PORT` | `10011` | TS3 ServerQuery TCP port |
| `TS3_QUERY_USER` | `serveradmin` | ServerQuery username |
| `TS3_QUERY_PASS` | | ServerQuery password |
| `TS3_SERVER_ID` | `1` | Virtual server ID |
| `TS3_SERVER_PORT` | `9987` | Virtual server voice port |
| `TS3_CONNECT_TIMEOUT_MS` | `10000` | Query connection timeout |
| `TS3_BOT_NICKNAME` | `UC Stats Bot` | ServerQuery display nickname |
| `AFK_AWAY_THRESHOLD_MINUTES` | `5` | Away time before active tracking pauses |
| `EXCLUDED_CHANNELS` | | Comma-separated channel IDs to skip |
| `BOT_NICKNAMES` | `UC Stats Bot,serveradmin` | Nicknames to never track |
| `POLL_INTERVAL_MS` | `60000` | Poll frequency |
| `WEB_PORT` | `3000` | App port inside Docker |
| `HOST_WEB_PORT` | `3000` | Dashboard port on Windows |
| `TZ` | `UTC` | Timezone for scheduled reset logs |

## Useful Commands

```powershell
docker compose up -d --build
docker logs -f uc-stats-bot
docker compose ps
Invoke-WebRequest http://localhost:3000/api/health
```

Reset all tracked stats:

```powershell
docker compose down
docker volume rm uc_stats_data
docker compose up -d --build
```

## Troubleshooting

### Dashboard Loads But No Data

Wait one poll interval, usually 60 seconds. Then check:

```powershell
Invoke-WebRequest http://localhost:3000/api/health
Invoke-WebRequest http://localhost:3000/api/leaderboard
```

If `bot_connected` is `false`, the bot is not connected to ServerQuery yet.

### Cannot Connect To ServerQuery

Check these first:

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 10011
docker logs -f uc-stats-bot
```

If TS3 is on the same Windows PC and Docker is used, keep:

```env
TS3_HOST=host.docker.internal
```

### Query Login Fails

Use a valid ServerQuery account. The default `serveradmin` password is printed in TS3 server logs when the server is first created. If you made a custom query user, confirm it can run:

```text
use sid=1
clientlist
channellist
```

### Excluding AFK Or Bot Channels

Put channel IDs in `.env`:

```env
EXCLUDED_CHANNELS=12,18,27
```

Then rebuild:

```powershell
docker compose up -d --build
```
