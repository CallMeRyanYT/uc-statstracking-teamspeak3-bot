# ==============================================================================
# UC Stats Bot - Automated Docker Setup Wizard for Windows
# Run this script from PowerShell in the project folder:
#   .\setup.ps1
# ==============================================================================

$ErrorActionPreference = "Stop"
$checkmark = [char]0x2714

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "   UC Stats Bot - Automated Setup Wizard" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan

# ------------------------------------------------------------------------------
# 1. Check Docker
# ------------------------------------------------------------------------------
Write-Host ""
Write-Host "[1/4] Checking Docker..." -ForegroundColor Yellow

$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
    Write-Host "Docker not found." -ForegroundColor Yellow
    $choice = Read-Host "Install Docker Desktop via winget? (Y/N)"
    if ($choice -eq 'Y' -or $choice -eq 'y') {
        Start-Process winget -ArgumentList "install --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements" -Wait -NoNewWindow
        Write-Host "$checkmark Docker installation started. Launch Docker Desktop, then re-run this script." -ForegroundColor Green
        Exit 0
    } else {
        Write-Error "Docker is required. Install from https://www.docker.com/products/docker-desktop"
    }
}

$dockerInfo = docker info --format "{{.Name}}" 2>$null
if ($LastExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($dockerInfo)) {
    Write-Host "Docker is installed but not running." -ForegroundColor Yellow
    $startChoice = Read-Host "Start Docker Desktop now? (Y/N)"
    if ($startChoice -eq 'Y' -or $startChoice -eq 'y') {
        $exe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
        if (Test-Path $exe) {
            Start-Process $exe
            Write-Host "Waiting for Docker daemon..." -ForegroundColor Gray
            $ready = $false
            for ($i = 0; $i -le 30; $i++) {
                Start-Sleep -Seconds 2
                $null = docker info 2>$null
                if ($LastExitCode -eq 0) { $ready = $true; break }
            }
            if (-not $ready) {
                Write-Error "Docker did not start in time. Open Docker Desktop manually and re-run."
            }
        } else {
            Write-Error "Could not find Docker Desktop. Start it manually then re-run."
        }
    } else {
        Write-Error "Docker must be running. Start Docker Desktop and re-run."
    }
}

Write-Host "$checkmark Docker is running." -ForegroundColor Green

# ------------------------------------------------------------------------------
# 2. Configure .env
# ------------------------------------------------------------------------------
Write-Host ""
Write-Host "[2/4] Configuring environment..." -ForegroundColor Yellow

$envFile     = Join-Path $PSScriptRoot ".env"
$envTemplate = Join-Path $PSScriptRoot ".env.example"

if (-not (Test-Path $envTemplate)) {
    Write-Error "Missing .env.example template. Make sure you are running this from the bot folder."
}

function Get-EnvVal {
    param([string[]]$Lines, [string]$Key, [string]$Default = "")
    $pattern = "^\s*#?\s*" + [regex]::Escape($Key) + "\s*=(.*)"
    foreach ($line in $Lines) {
        if ($line -match $pattern) {
            return $Matches[1].Trim()
        }
    }
    return $Default
}

function Set-EnvVal {
    param([string[]]$Lines, [string]$Key, [string]$Value)
    $pattern = "^\s*#?\s*" + [regex]::Escape($Key) + "\s*="
    $out = [System.Collections.Generic.List[string]]::new()
    $found = $false
    foreach ($line in $Lines) {
        if ($line -match $pattern) {
            $out.Add("$Key=$Value")
            $found = $true
        } else {
            $out.Add($line)
        }
    }
    if (-not $found) { $out.Add("$Key=$Value") }
    return $out.ToArray()
}

function Read-Val {
    param([string]$Prompt, [string]$Current)
    if ([string]::IsNullOrWhiteSpace($Current)) {
        $display = "<blank>"
    } else {
        $display = $Current
    }
    $v = Read-Host "$Prompt [$display]"
    if ($v -eq "") {
        return $Current
    }
    return $v.Trim()
}

function Read-Secret {
    param([string]$Prompt, [string]$Current)
    if ([string]::IsNullOrWhiteSpace($Current)) {
        $display = "<blank>"
    } else {
        $display = "configured (press Enter to keep, or type: clear)"
    }
    $sec = Read-Host "$Prompt [$display]" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)

    if ($plain -eq "") {
        return $Current
    }
    if ($plain -ieq "clear") {
        return ""
    }
    return $plain
}

$createdNew = $false
if (-not (Test-Path $envFile)) {
    Copy-Item $envTemplate $envFile
    $createdNew = $true
    Write-Host "  Created new .env from template." -ForegroundColor Gray
}

$runWizard = $createdNew
if (-not $createdNew) {
    Write-Host "$checkmark Existing .env found." -ForegroundColor Green
    $updateChoice = Read-Host "Update configuration now? (Y/n)"
    if ([string]::IsNullOrWhiteSpace($updateChoice) -or $updateChoice -eq 'Y' -or $updateChoice -eq 'y') {
        $runWizard = $true
    } else {
        $runWizard = $false
    }
}

if ($runWizard) {
    $lines = @(Get-Content $envFile)

    Write-Host ""
    Write-Host "--- TeamSpeak 3 ServerQuery ---" -ForegroundColor Cyan
    Write-Host "  ServerQuery password is shown when your TS3 server first starts." -ForegroundColor Gray
    Write-Host "  Look for a line like:  password= XXXXXXXXXX" -ForegroundColor Gray
    Write-Host "  If running on the same PC, keep host as: host.docker.internal" -ForegroundColor Gray
    Write-Host ""

    $ts3Host   = Read-Val "TS3 server host"              (Get-EnvVal $lines "TS3_HOST" "host.docker.internal")
    $qport     = Read-Val "ServerQuery port"             (Get-EnvVal $lines "TS3_QUERY_PORT" "10011")
    $quser     = Read-Val "ServerQuery username"         (Get-EnvVal $lines "TS3_QUERY_USER" "serveradmin")
    $qpass     = Read-Secret "ServerQuery password"      (Get-EnvVal $lines "TS3_QUERY_PASS" "")
    $botnick   = Read-Val "Bot display name"             (Get-EnvVal $lines "TS3_BOT_NICKNAME" "UC Stats Bot")

    Write-Host ""
    Write-Host "--- Tracking Settings ---" -ForegroundColor Cyan
    $afkMin    = Read-Val "AFK pause threshold in minutes" (Get-EnvVal $lines "AFK_AWAY_THRESHOLD_MINUTES" "5")
    $webport   = Read-Val "Web dashboard port"             (Get-EnvVal $lines "WEB_PORT" "3000")
    $hostport  = Read-Val "Windows dashboard port"         (Get-EnvVal $lines "HOST_WEB_PORT" "3000")
    $tz        = Read-Val "Timezone (e.g. UTC, Europe/Helsinki)" (Get-EnvVal $lines "TZ" "UTC")

    $lines = Set-EnvVal $lines "TS3_HOST"                    $ts3Host
    $lines = Set-EnvVal $lines "TS3_QUERY_PORT"              $qport
    $lines = Set-EnvVal $lines "TS3_QUERY_USER"              $quser
    $lines = Set-EnvVal $lines "TS3_QUERY_PASS"              $qpass
    $lines = Set-EnvVal $lines "TS3_BOT_NICKNAME"            $botnick
    $lines = Set-EnvVal $lines "AFK_AWAY_THRESHOLD_MINUTES"  $afkMin
    $lines = Set-EnvVal $lines "WEB_PORT"                    $webport
    $lines = Set-EnvVal $lines "HOST_WEB_PORT"               $hostport
    $lines = Set-EnvVal $lines "TZ"                          $tz

    $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.File]::WriteAllLines($envFile, [string[]]$lines, $utf8NoBom)

    if ([string]::IsNullOrWhiteSpace($qpass)) {
        Write-Host "  WARNING: ServerQuery password is blank. The bot may fail to connect." -ForegroundColor Yellow
    }

    Write-Host "$checkmark .env saved successfully." -ForegroundColor Green
} else {
    Write-Host "$checkmark Keeping existing .env settings." -ForegroundColor Green
}

# ------------------------------------------------------------------------------
# 3. Build Docker image
# ------------------------------------------------------------------------------
Write-Host ""
Write-Host "[3/4] Building Docker image..." -ForegroundColor Yellow
Write-Host "  This downloads Node.js packages and compiles the SQLite native module." -ForegroundColor Gray
Write-Host "  First build may take 3-5 minutes. Please wait..." -ForegroundColor Gray

try {
    $composeCmd = Get-Command docker-compose -ErrorAction SilentlyContinue
    if ($composeCmd) {
        docker-compose build
    } else {
        docker compose build
    }
    if ($LastExitCode -ne 0) {
        throw "Docker build exited with code $LastExitCode"
    }
    Write-Host "$checkmark Image built successfully." -ForegroundColor Green
} catch {
    Write-Host "ERROR: Build failed: $_" -ForegroundColor Red
    Write-Host "Check your internet connection and that Docker has enough disk space." -ForegroundColor Red
    Exit 1
}

# ------------------------------------------------------------------------------
# 4. Done
# ------------------------------------------------------------------------------
Write-Host ""
Write-Host "[4/4] Setup complete!" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "To START the bot:" -ForegroundColor White
Write-Host "  Double-click start_bot.bat" -ForegroundColor Green
Write-Host "  -- or --" -ForegroundColor Gray
Write-Host "  docker compose up -d" -ForegroundColor Green
Write-Host ""
Write-Host "Web dashboard (local):" -ForegroundColor White
Write-Host "  http://localhost:3000" -ForegroundColor Green
Write-Host ""
Write-Host "Get public Cloudflare URL:" -ForegroundColor White
Write-Host "  docker logs uc-stats-tunnel" -ForegroundColor Green
Write-Host ""
Write-Host "View bot logs:" -ForegroundColor White
Write-Host "  docker logs -f uc-stats-bot" -ForegroundColor Green
Write-Host ""
Write-Host "To STOP the bot:" -ForegroundColor White
Write-Host "  docker compose down" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Cyan
