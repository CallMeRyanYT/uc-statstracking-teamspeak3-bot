# Docker Setup Guide - UC Stats Bot

This guide walks you through installing Docker Desktop on Windows and running the TeamSpeak 3 stats tracker, dashboard, local admin controls, and optional Discord reports at `https://uct.aquaweb.cc/`.

## Part 1 - Install Docker Desktop

Docker packages the bot and its dependencies into containers, so you do not need to install Node.js or SQLite manually.

1. Go to https://www.docker.com/products/docker-desktop
2. Click "Download for Windows".
3. Run the installer and allow WSL 2 if prompted.
4. Restart your PC if the installer asks.
5. Open Docker Desktop from the Start menu.
6. Wait until Docker says it is running.

Optional winget install:

```powershell
winget install --id Docker.DockerDesktop
```

Verify Docker:

```powershell
docker --version
docker info
```

## Part 2 - Run The Setup Wizard

1. Open PowerShell.
2. Go to the bot folder:

   ```powershell
   cd C:\Users\YourName\Desktop\uc-statstracking-teamspeak3-bot
   ```

3. Allow local PowerShell scripts once:

   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```

4. Run the wizard:

   ```powershell
   .\setup.ps1
   ```

The wizard checks Docker, asks for TS3 ServerQuery settings, writes `.env`, and builds the Docker image.

## Part 3 - Start The Bot

After setup completes, double-click `start_bot.bat`, or run:

```powershell
docker compose up -d --remove-orphans
```

## Part 4 - Verify It Works

Check containers:

```powershell
docker compose ps
```

You should see one application container:

```text
uc-stats-bot
```

View live bot logs:

```powershell
docker logs -f uc-stats-bot
```

A healthy startup looks like:

```text
===================================================
   UC Stats Tracking Bot for TeamSpeak 3
   Connecting to : host.docker.internal:10011
   Web Dashboard : http://localhost:3000
===================================================
[Web] Dashboard running at http://localhost:3000
[TS3] Connected and authenticated.
[TS3] Monitoring all channels (global tracking).
[Tracker] Polling every 60s
```

Open the local dashboard:

```text
http://localhost:3000
```

The configured public website is:

```text
https://uct.aquaweb.cc/
```

The website host or reverse proxy must forward that domain to dashboard port `3000`. The `PUBLIC_DASHBOARD_URL` setting controls links only; it does not configure DNS or HTTPS.

## Part 5 - Managing The Bot

Stop:

```powershell
docker compose down
```

Restart:

```powershell
docker compose restart
```

Start with live logs:

```powershell
docker compose up
```

Rebuild after code changes:

```powershell
docker compose down
docker compose up -d --build --remove-orphans
```

Force a clean rebuild:

```powershell
docker compose down
docker compose build --no-cache
docker compose up -d --remove-orphans
```

## Part 6 - Auto-Start On Windows Boot

1. Press `Win+R`.
2. Type `shell:startup` and press Enter.
3. Copy `start_bot.bat`, or a shortcut to it, into that folder.
4. In Docker Desktop settings, enable "Start Docker Desktop when you log in".

## Part 7 - Updating The Bot

Run these commands on the machine that actually serves the dashboard. If `uct.aquaweb.cc` points to another PC or VPS, updating only your development laptop will not update the public site.

```powershell
git pull
docker compose down
docker compose up -d --build --remove-orphans
```

Your database is stored in the Docker volume `uc_stats_data` and is preserved across rebuilds.

The dashboard uses two published ports by default:

| Port | Access | Purpose |
| --- | --- | --- |
| `3000` | Local, LAN, or public website proxy | Read-only dashboard and verified Server Admin sessions |
| `3001` | `127.0.0.1` only | Automatic admin access for this Windows laptop |

Never expose or proxy port `3001`.

## Command Cheat Sheet

| Task | Command |
| --- | --- |
| Start bot | `docker compose up -d --remove-orphans` |
| Stop bot | `docker compose down` |
| View bot logs | `docker logs -f uc-stats-bot` |
| Restart bot | `docker compose restart uc-stats-bot` |
| List containers | `docker compose ps` |
| Backup database | `docker cp uc-stats-bot:/app/data/stats.sqlite ./backup.sqlite` |

## Same-PC Networking

When your TS3 server and Docker both run on the same Windows PC, keep this in `.env`:

```env
TS3_HOST=host.docker.internal
TS3_QUERY_PORT=10011
```

That Docker hostname points from the container back to your Windows host. Do not use your public TS3 voice address for this same-PC setup unless you have also exposed the ServerQuery TCP port.

## Data And Privacy

All stats are stored locally in the Docker volume. The app only needs:

- A TCP connection to your TS3 ServerQuery port.
- An optional outbound HTTPS connection to the configured Discord webhook.
- An inbound route from the configured website host or reverse proxy to dashboard port `3000`, if public access is enabled.

There are no TS3 chat commands. The Discord webhook is stored in `.env`, which is ignored by Git; never commit or publicly share it.
