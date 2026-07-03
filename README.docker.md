# Docker Setup Guide — UC Stats Bot

This guide walks you through installing Docker Desktop on Windows and getting the bot running from scratch.

---

## Part 1 — Install Docker Desktop

### What is Docker?

Docker packages the bot and all its dependencies into a self-contained "container" that runs identically on any PC. You don't need to install Node.js, Python, or any libraries manually.

### Install Steps

1. Go to **https://www.docker.com/products/docker-desktop**
2. Click **"Download for Windows"**
3. Run the installer — it will ask to enable WSL 2 (say **Yes**)
4. Restart your PC when prompted
5. Open **Docker Desktop** from the Start menu
6. Wait for the whale icon in the system tray to stop animating (this means Docker is ready)

> **Auto-install via winget (if you have it):**
> ```powershell
> winget install --id Docker.DockerDesktop
> ```

### Verify Docker is Working

Open PowerShell and run:

```powershell
docker --version
docker info
```

If both commands return output without errors, Docker is ready.

---

## Part 2 — Run the Setup Wizard

The `setup.ps1` wizard automates all configuration and building.

1. Open **PowerShell** (right-click the Start button → Windows Terminal)
2. Navigate to the bot folder:
   ```powershell
   cd C:\Users\YourName\Desktop\uc-statstracking-teamspeak3-bot
   ```
3. Allow PowerShell to run local scripts (one-time):
   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```
4. Run the wizard:
   ```powershell
   .\setup.ps1
   ```

The wizard will:
- ✅ Check Docker is running
- ✅ Ask for your TS3 ServerQuery credentials
- ✅ Build the Docker image

---

## Part 3 — Start the Bot

After setup completes, double-click **`start_bot.bat`** — or from PowerShell:

```powershell
docker compose up -d
```

The `-d` flag runs it in the background.

---

## Part 4 — Verify Everything is Working

### Check the bot is running

```powershell
docker ps
```

You should see two containers:
- `uc-stats-bot` — the tracking bot
- `uc-stats-tunnel` — the Cloudflare public URL service

### View live logs

```powershell
docker logs -f uc-stats-bot
```

A healthy startup looks like:
```
===================================================
   UC Stats Tracking Bot for TeamSpeak 3
   Connecting to : host.docker.internal:10011
   Web Dashboard : http://localhost:3000
===================================================
[Web] Dashboard running at http://localhost:3000
[TS3] Connecting to host.docker.internal:10011 ...
[TS3] Connected and authenticated.
[TS3] Monitoring all channels (global tracking).
[Tracker] Polling every 60s
```

If you see repeated "Connection failed — retrying" messages, see the [Troubleshooting section in README.md](README.md#troubleshooting).

### Get the public Cloudflare URL

```powershell
docker logs uc-stats-tunnel
```

Look for:
```
Your quick Tunnel has been created! Visit it at:
https://abc-def-ghi.trycloudflare.com
```

Share this URL with your friends — it's the live leaderboard!

---

## Part 5 — Managing the Bot

### Stop the bot

```powershell
docker compose down
```

### Restart the bot

```powershell
docker compose restart
```

### Start with live logs (foreground mode)

```powershell
docker compose up
```

Press `Ctrl+C` to stop.

### Rebuild after code changes

```powershell
docker compose down
docker compose build
docker compose up -d
```

### Force a clean rebuild (if something is broken)

```powershell
docker compose down
docker compose build --no-cache
docker compose up -d
```

---

## Part 6 — Auto-Start on Windows Boot

To have the bot start automatically when your PC boots:

1. Press `Win+R`, type `shell:startup`, press Enter — this opens the startup folder
2. Copy `start_bot.bat` (or a shortcut to it) into that folder
3. The bat file waits for Docker Desktop to be ready before starting the bot

> **Note:** Docker Desktop itself must also be set to launch on startup. Open Docker Desktop → Settings → General → check "Start Docker Desktop when you log in".

---

## Part 7 — Updating the Bot

```powershell
git pull
docker compose down
docker compose build
docker compose up -d
```

Your database is preserved in the Docker volume `uc_stats_data` and is NOT affected by updates.

---

## Docker Command Cheat Sheet

| Task | Command |
|---|---|
| Start bot (background) | `docker compose up -d` |
| Stop bot | `docker compose down` |
| View bot logs | `docker logs -f uc-stats-bot` |
| View tunnel URL | `docker logs uc-stats-tunnel` |
| Restart bot | `docker compose restart uc-stats-bot` |
| List running containers | `docker ps` |
| List all containers | `docker ps -a` |
| Check disk usage | `docker system df` |
| Remove unused images | `docker system prune` |
| View volumes | `docker volume ls` |
| Backup the database | `docker cp uc-stats-bot:/app/data/stats.sqlite ./backup.sqlite` |

---

## Networking — Same PC Setup

When your TS3 server and the bot both run on the same Windows PC:

```
┌─────────────────────────── Your PC ──────────────────────────────┐
│                                                                    │
│   TS3 Server (ts3server.exe)    UC Stats Bot (Docker container)  │
│   Port 9987  (voice)            connects via:                     │
│   Port 10011 (ServerQuery) ◄──  host.docker.internal:10011       │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

`host.docker.internal` is a special hostname Docker automatically resolves to your PC's local IP. This is pre-configured in `docker-compose.yml` via `extra_hosts`.

**You don't need to change anything** — just keep `TS3_HOST=host.docker.internal` in your `.env`.

---

## Data & Privacy

- All data is stored locally in a Docker volume on your PC
- The only external connections are:
  - **To your TS3 server** (ServerQuery on port 10011)
  - **To Discord** (outbound POST to your webhook URL)
  - **Cloudflare Tunnel** (outbound only — your data doesn't leave your machine, Cloudflare just routes HTTP traffic to it)
- No data is ever sent to any third party or analytics service
