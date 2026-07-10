# UC Stats Tracking Bot

TeamSpeak 3 activity tracker with a live web dashboard and optional Discord statistics reports.

The bot uses TeamSpeak ServerQuery to poll who is online, which channel they are in, and how long they stay active. There are no TS3 chat commands. Discord support is one-way: it posts scheduled leaderboard summaries through a webhook.

## What It Does

| Feature | Description |
| --- | --- |
| Server-wide tracking | Tracks regular voice clients across the whole virtual server |
| Live dashboard | Leaderboard, online users, channels, recent activity, and user profiles |
| Persistent data | SQLite database in the Docker volume |
| AFK handling | Pauses active time after the configured away threshold |
| Period resets | Daily, weekly, and monthly counters reset automatically |
| Discord reports | Posts totals, top users, top channels, and the public website on a schedule |
| Admin controls | Reset one user or all tracked data from the dashboard |
| Stable identities | Uses the permanent TeamSpeak client UID, not the temporary connection ID |
| Public website | Uses the configured domain or subdomain in dashboard and Discord links |

## Quick Start

1. Run the Windows setup wizard:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\setup.ps1
   ```

   It asks for ServerQuery details, the optional Discord webhook, Server Admin group IDs, tracking settings, and dashboard ports. Secrets are written only to the ignored `.env` file.

2. If you prefer manual setup, copy `.env.example` to `.env` and edit it.

   If Docker runs on the same PC as your TS3 server:

   ```env
   TS3_HOST=host.docker.internal
   TS3_QUERY_PORT=10011
   TS3_QUERY_USER=serveradmin
   TS3_QUERY_PASS=your_password
   TS3_SERVER_ID=1
   TS3_SERVER_PORT=9987
   HOST_WEB_PORT=3000
   HOST_ADMIN_PORT=3001
   TS3_ADMIN_GROUP_IDS=6
   DISCORD_WEBHOOK_URL=
   PUBLIC_DASHBOARD_URL=https://uct.aquaweb.cc/
   ```

3. Start it:

   ```powershell
   docker compose up -d --build --remove-orphans
   docker logs -f uc-stats-bot
   ```

4. Open the dashboard:

   http://localhost:3000

## Discord Setup

1. In Discord, open the destination channel.
2. Open **Edit Channel > Integrations > Webhooks**.
3. Create a webhook and copy its URL.
4. Run `.\setup.ps1` again, choose to update configuration, copy the URL, and press Enter at the webhook prompt. The wizard reads it from your clipboard without displaying it.
5. Choose the automatic report interval. The default is 60 minutes and the minimum is 5 minutes.
6. Enter `https://uct.aquaweb.cc/` at the public website prompt. This link is added to each report.
7. Rebuild and start:

   ```powershell
   docker compose up -d --build --remove-orphans
   ```

The first automatic report is sent when tracked data exists and a report is due. From the local dashboard, open **Manage** and use **Send now** to test it immediately.

Treat the webhook URL like a password. If it is ever pasted into a public chat, delete or rotate it in Discord and update `.env`.

## Public Website At uct.aquaweb.cc

The project no longer starts or manages a tunnel container. The public dashboard address is:

```text
https://uct.aquaweb.cc/
```

Set it through `setup.ps1` or `.env`:

```env
PUBLIC_DASHBOARD_URL=https://uct.aquaweb.cc/
```

This setting controls the website link shown in the dashboard and Discord reports. It does not create DNS, HTTPS, or a reverse proxy. The server that manages `uct.aquaweb.cc` must forward public HTTPS requests to this app's dashboard port, normally `http://<bot-host>:3000`.

1. Configure the website host or reverse proxy for `uct.aquaweb.cc` to target the machine running this app on port `3000`.
2. Keep admin port `3001` private. Docker binds it only to `127.0.0.1`.
3. Run `./setup.ps1` and enter `https://uct.aquaweb.cc/` when asked for the public website.
4. Start the current stack and remove any old containers:

   ```powershell
   docker compose up -d --build --remove-orphans
   ```

5. If `uct.aquaweb.cc` is served by another PC or VPS, run the same update and Compose command on that host. Rebuilding a development laptop does not replace a container running on a different machine.
6. Verify both endpoints:

   ```powershell
   Invoke-WebRequest http://localhost:3000/api/health
   Invoke-WebRequest https://uct.aquaweb.cc/api/health
   ```

If the local URL works but the public URL does not, the remaining problem is in DNS, HTTPS, firewall, port forwarding, or the external reverse proxy rather than this container.

If both URLs work but show different page titles or designs, the public host is running an older image. Pull or copy this project onto that host and run `docker compose up -d --build --remove-orphans` there.

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
| Query account can include client groups | Needed for Server Admin web verification |
| Query account can run `channellist` | Needed to resolve channel names |
| Query account can run `clientinfo` | Used by profile/online detail paths when needed |

The bot does not need to join `Stalking Room`. It does not need text-message permissions anymore.

## Identity And Admin Access

TeamSpeak exposes both a temporary connection ID and a permanent client unique identifier (UID). This tracker stores users by the permanent UID. Reconnecting or changing a nickname updates the existing leaderboard row and historical display name instead of creating a second user.

Dashboard editing works in two ways:

- On `http://localhost:3000`, the laptop gets automatic access through the loopback-only admin port.
- On the public URL, a Server Admin selects **Admin access**, receives a five-minute code, briefly adds it to their TeamSpeak nickname, and clicks **Verify now**. The tracker checks the online UID and its server groups before granting a one-hour session. Access ends if that UID goes offline or loses the configured admin group.

Set `TS3_ADMIN_GROUP_IDS` to the comma-separated IDs that should have access. `6` is a common default for Server Admin, but confirm the ID on your server.

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
| `TS3_ADMIN_GROUP_IDS` | `6` | Server groups allowed to verify dashboard editing |
| `AFK_AWAY_THRESHOLD_MINUTES` | `5` | Away time before active tracking pauses |
| `EXCLUDED_CHANNELS` | | Comma-separated channel IDs to skip |
| `BOT_NICKNAMES` | `UC Stats Bot,serveradmin,UC Music Bot,Admonus` | Nicknames to never track |
| `POLL_INTERVAL_MS` | `60000` | Poll frequency |
| `DISCORD_WEBHOOK_URL` | | Discord channel webhook; blank disables reports |
| `DISCORD_REPORT_INTERVAL_MINUTES` | `60` | Automatic statistics report frequency |
| `PUBLIC_DASHBOARD_URL` | `https://uct.aquaweb.cc/` | Website included in dashboard and Discord links |
| `WEB_PORT` | `3000` | App port inside Docker |
| `HOST_WEB_PORT` | `3000` | Dashboard port on Windows |
| `ADMIN_PORT` | `3001` | Internal local-admin API port |
| `HOST_ADMIN_PORT` | `3001` | Loopback-only admin port on Windows |
| `TZ` | `UTC` | Timezone for scheduled reset logs |

Names in `BOT_NICKNAMES` are ignored during tracking and purged from existing stats on startup.

## Useful Commands

```powershell
docker compose up -d --build --remove-orphans
docker logs -f uc-stats-bot
docker compose ps
Invoke-WebRequest http://localhost:3000/api/health
```

Back up the database before a large reset:

```powershell
docker cp uc-stats-bot:/app/data/stats.sqlite ./stats-backup.sqlite
```

Use **Manage > Reset all data** on the local dashboard to clear everything, or open a user profile and select **Reset this user**. Both actions require confirmation. Deleting the Docker volume remains an emergency fallback, but it is no longer needed for normal resets.

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

### Excluding Channels

Put channel IDs in `.env`:

```env
EXCLUDED_CHANNELS=12,18,27
```

Then rebuild:

```powershell
docker compose up -d --build --remove-orphans
```

### Discord Report Fails

Open **Manage** on the local dashboard and use **Send now**, then inspect:

```powershell
docker logs --tail 100 uc-stats-bot
```

An HTTP `401` or `404` usually means the webhook was deleted or rotated. Run `.\setup.ps1`, enter the replacement URL, and rebuild.

### Server Admin Verification Fails

Confirm the bot is connected, the user is online, and `.env` contains the correct server group ID:

```env
TS3_ADMIN_GROUP_IDS=6
```

The check uses the permanent TeamSpeak UID plus the groups returned by `clientlist -groups`; typing a nickname into the website is never enough to grant access.
