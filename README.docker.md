# Docker Setup Guide - UC Stats Bot

This guide walks you through installing Docker Desktop on Windows and running the website-only TeamSpeak 3 stats tracker.

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
docker compose up -d
```

## Part 4 - Verify It Works

Check containers:

```powershell
docker compose ps
```

You should see:

```text
uc-stats-bot
uc-stats-tunnel
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

Get the temporary Cloudflare public URL:

```powershell
docker logs uc-stats-tunnel
```

Look for:

```text
https://example-name.trycloudflare.com
```

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
docker compose up -d --build
```

Force a clean rebuild:

```powershell
docker compose down
docker compose build --no-cache
docker compose up -d
```

## Part 6 - Auto-Start On Windows Boot

1. Press `Win+R`.
2. Type `shell:startup` and press Enter.
3. Copy `start_bot.bat`, or a shortcut to it, into that folder.
4. In Docker Desktop settings, enable "Start Docker Desktop when you log in".

## Part 7 - Updating The Bot

```powershell
git pull
docker compose down
docker compose up -d --build
```

Your database is stored in the Docker volume `uc_stats_data` and is preserved across rebuilds.

## Command Cheat Sheet

| Task | Command |
| --- | --- |
| Start bot | `docker compose up -d` |
| Stop bot | `docker compose down` |
| View bot logs | `docker logs -f uc-stats-bot` |
| View tunnel URL | `docker logs uc-stats-tunnel` |
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
- An optional outbound Cloudflare Tunnel connection for the public dashboard URL.

There are no Discord webhooks and no TS3 chat commands.
