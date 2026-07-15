#!/usr/bin/env bash
# ==============================================================================
# UC Stats Bot - Automated Docker Setup Wizard for Debian 13 and other Debian
# based Linux distributions. Run from the project folder with: ./setup.sh
# ==============================================================================

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ENV_FILE="$SCRIPT_DIR/.env"
readonly ENV_TEMPLATE="$SCRIPT_DIR/.env.example"

DOCKER_CMD=(docker)
COMPOSE_MODE=""
REPLY_VALUE=""

on_error() {
  printf '\nERROR: setup stopped at line %s.\n' "$1" >&2
}
trap 'on_error $LINENO' ERR

heading() {
  printf '\n==================================================\n'
  printf '   UC Stats Bot - Automated Setup Wizard\n'
  printf '==================================================\n'
}

success() { printf '✓ %s\n' "$*"; }
notice() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

ask_yes_no() {
  local prompt="$1" answer
  read -r -p "$prompt [Y/n] " answer || true
  [[ -z "$answer" || "$answer" =~ ^[Yy]$ ]]
}

sudo_cmd() {
  if [[ "$EUID" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    die "This operation needs root access. Install sudo or run this script as root."
  fi
}

install_docker_debian() {
  [[ -r /etc/os-release ]] || die "Docker installation is supported here only on Debian-based systems."
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "debian" || "${ID_LIKE:-}" == *debian* ]] || \
    die "Install Docker Engine for this distribution, then run setup.sh again."
  [[ -n "${VERSION_CODENAME:-}" ]] || die "Could not determine the Debian release codename."

  notice "Installing Docker Engine and the Docker Compose plugin from Docker's Debian repository..."
  sudo_cmd apt-get update
  sudo_cmd apt-get install -y ca-certificates curl
  sudo_cmd install -m 0755 -d /etc/apt/keyrings
  sudo_cmd curl -fsSL https://download.docker.com/linux/debian/gpg \
    -o /etc/apt/keyrings/docker.asc
  sudo_cmd chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian %s stable\n' \
    "$(dpkg --print-architecture)" "$VERSION_CODENAME" | \
    sudo_cmd tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo_cmd apt-get update
  sudo_cmd apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo_cmd systemctl enable --now docker
}

configure_docker_command() {
  if docker info >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
    return
  fi

  if [[ "$EUID" -eq 0 ]]; then
    DOCKER_CMD=(docker)
    docker info >/dev/null 2>&1 || return 1
    return
  fi

  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER_CMD=(sudo docker)
    notice "Using sudo for Docker commands in this setup run."
    notice "To use Docker without sudo later, run: sudo usermod -aG docker $USER"
    notice "Then sign out and back in."
    return
  fi

  return 1
}

docker_cmd() {
  "${DOCKER_CMD[@]}" "$@"
}

ensure_docker() {
  notice ""
  notice "[1/4] Checking Docker..."

  if ! command -v docker >/dev/null 2>&1; then
    notice "Docker was not found."
    if ask_yes_no "Install Docker Engine for Debian now?"; then
      install_docker_debian
    else
      die "Docker is required. Install it from https://docs.docker.com/engine/install/debian/ and re-run setup.sh."
    fi
  fi

  if ! configure_docker_command; then
    notice "Docker is installed but the daemon is unavailable."
    if ask_yes_no "Start the Docker service now?"; then
      command -v systemctl >/dev/null 2>&1 || die "systemctl is unavailable; start Docker manually and re-run setup.sh."
      sudo_cmd systemctl start docker
    else
      die "Docker must be running. Start it and re-run setup.sh."
    fi

    for _ in $(seq 1 30); do
      if configure_docker_command; then
        break
      fi
      sleep 2
    done
    configure_docker_command || die "Docker did not become ready in time."
  fi

  success "Docker is running."
}

configure_compose() {
  if docker_cmd compose version >/dev/null 2>&1; then
    COMPOSE_MODE="plugin"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_MODE="legacy"
  else
    die "Docker Compose is required. Install the Docker Compose plugin and re-run setup.sh."
  fi
}

compose_cmd() {
  if [[ "$COMPOSE_MODE" == "plugin" ]]; then
    docker_cmd compose "$@"
  elif [[ "$EUID" -eq 0 ]]; then
    docker-compose "$@"
  else
    sudo_cmd docker-compose "$@"
  fi
}

compose_display() {
  if [[ "$COMPOSE_MODE" == "plugin" ]]; then
    printf 'docker compose'
  else
    printf 'docker-compose'
  fi
}

get_env_value() {
  local key="$1" default_value="$2" value
  value="$(awk -v key="$key" '
    $0 ~ "^[[:space:]]*#?[[:space:]]*" key "[[:space:]]*=" {
      sub("^[[:space:]]*#?[[:space:]]*" key "[[:space:]]*=", "")
      sub(/\r$/, "")
      print
      exit
    }
  ' "$ENV_FILE")"
  REPLY_VALUE="${value:-$default_value}"
}

set_env_value() {
  local key="$1" value="$2" tmp_file found
  tmp_file="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  found="$(awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $0 ~ "^[[:space:]]*#?[[:space:]]*" key "[[:space:]]*=" {
      print key "=" value
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" > "$tmp_file"; printf '%s' "$?")"
  [[ "$found" == "0" ]] || { rm -f "$tmp_file"; return 1; }
  mv "$tmp_file" "$ENV_FILE"
}

read_value() {
  local prompt="$1" current="$2" value display
  display="${current:-<blank>}"
  read -r -p "$prompt [$display]: " value || true
  REPLY_VALUE="${value:-$current}"
}

read_secret() {
  local prompt="$1" current="$2" value display
  if [[ -n "$current" ]]; then
    display="configured (press Enter to keep, or type: clear)"
  else
    display="<blank>"
  fi
  read -r -s -p "$prompt [$display]: " value || true
  printf '\n'
  if [[ -z "$value" ]]; then
    REPLY_VALUE="$current"
  elif [[ "${value,,}" == "clear" ]]; then
    REPLY_VALUE=""
  else
    REPLY_VALUE="$value"
  fi
}

is_discord_webhook() {
  [[ "$1" =~ ^https://(www\.|canary\.|ptb\.)?(discord(app)?\.com)/api/(v[0-9]+/)?webhooks/[0-9]+/[^/]+/?(\?.*)?$ ]]
}

read_discord_webhook() {
  local current="$1" value display
  if [[ -n "$current" ]]; then
    display="configured (press Enter to keep, or type: clear)"
  else
    display="<blank>"
  fi
  notice "  Paste the webhook URL directly. It will be saved only in .env."
  read -r -s -p "Discord webhook URL [$display]: " value || true
  printf '\n'
  if [[ -z "$value" ]]; then
    REPLY_VALUE="$current"
  elif [[ "${value,,}" == "clear" ]]; then
    REPLY_VALUE=""
  else
    REPLY_VALUE="$value"
  fi
}

format_report_schedule_preview() {
  local interval="$1" minute slots=()
  if [[ "$interval" -eq 60 ]]; then
    REPLY_VALUE="Hourly at :00"
  elif [[ "$interval" -lt 60 ]]; then
    for ((minute = 0; minute < 60; minute += interval)); do
      slots+=("$(printf ':%02d' "$minute")")
    done
    REPLY_VALUE="Every $interval minutes at ${slots[*]// /, }"
  elif [[ "$interval" -eq 1440 ]]; then
    REPLY_VALUE="Daily at 00:00"
  else
    REPLY_VALUE="Every $interval minutes, aligned from 00:00 each day"
  fi
}

read_report_interval() {
  local current="$1" value
  while true; do
    read_value "Automatic report interval in minutes" "$current"
    value="$REPLY_VALUE"
    if [[ "$value" =~ ^[0-9]+$ && "$value" -ge 5 && "$value" -le 1440 ]]; then
      REPLY_VALUE="$value"
      return
    fi
    notice "  Enter a whole number from 5 to 1440."
  done
}

normalize_public_url() {
  local candidate="$1" base suffix=""
  [[ -n "$candidate" ]] || die "Public dashboard URL cannot be blank."
  [[ "$candidate" =~ ^https?:// ]] || candidate="https://$candidate"
  [[ "$candidate" =~ ^https?://[^/?#]+ ]] || die "Invalid public dashboard URL: $1"
  [[ ! "$candidate" =~ [[:space:]] ]] || die "Invalid public dashboard URL: $1"
  [[ ! "$candidate" =~ ^https?://[^/]*@ ]] || die "Public dashboard URL cannot contain login credentials."
  [[ "${#candidate}" -le 500 ]] || die "Public dashboard URL is too long."

  candidate="${candidate%%\#*}"
  base="$candidate"
  if [[ "$candidate" == *\?* ]]; then
    base="${candidate%%\?*}"
    suffix="?${candidate#*\?}"
  fi
  [[ "$base" == */ ]] || base="${base}/"
  REPLY_VALUE="${base}${suffix}"
}

configure_environment() {
  notice ""
  notice "[2/4] Configuring environment..."
  [[ -f "$ENV_TEMPLATE" ]] || die "Missing .env.example. Run this script from the bot folder."

  local created_new=false run_wizard=false update_choice
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$ENV_TEMPLATE" "$ENV_FILE"
    created_new=true
    run_wizard=true
    notice "  Created new .env from template."
  else
    success "Existing .env found."
    if ask_yes_no "Update configuration now?"; then
      run_wizard=true
    fi
  fi

  if [[ "$run_wizard" != true ]]; then
    success "Keeping existing .env settings."
    return
  fi

  local ts3_host query_port query_user query_pass bot_nickname admin_groups
  local discord_webhook discord_interval public_url afk_minutes web_port host_port admin_port timezone

  notice ""
  notice "--- TeamSpeak 3 ServerQuery ---"
  notice "  ServerQuery password is shown when your TS3 server first starts."
  notice "  Look for a line like: password= XXXXXXXXXX"
  notice "  If TS3 runs on this host, host.docker.internal works with this Compose setup."
  get_env_value "TS3_HOST" "host.docker.internal"; read_value "TS3 server host" "$REPLY_VALUE"; ts3_host="$REPLY_VALUE"
  get_env_value "TS3_QUERY_PORT" "10011"; read_value "ServerQuery port" "$REPLY_VALUE"; query_port="$REPLY_VALUE"
  get_env_value "TS3_QUERY_USER" "serveradmin"; read_value "ServerQuery username" "$REPLY_VALUE"; query_user="$REPLY_VALUE"
  get_env_value "TS3_QUERY_PASS" ""; read_secret "ServerQuery password" "$REPLY_VALUE"; query_pass="$REPLY_VALUE"
  get_env_value "TS3_BOT_NICKNAME" "UC Stats Bot"; read_value "Bot display name" "$REPLY_VALUE"; bot_nickname="$REPLY_VALUE"
  get_env_value "TS3_ADMIN_GROUP_IDS" "6"; read_value "Server Admin group IDs (comma-separated)" "$REPLY_VALUE"; admin_groups="$REPLY_VALUE"

  notice ""
  notice "--- Discord Statistics ---"
  notice "  Create a webhook in Discord channel settings and copy its URL."
  notice "  The URL is a secret and is stored only in your local .env file."
  notice "  Automatic reports align to clock slots instead of the bot start time."
  get_env_value "DISCORD_WEBHOOK_URL" ""; read_discord_webhook "$REPLY_VALUE"; discord_webhook="$REPLY_VALUE"
  get_env_value "DISCORD_REPORT_INTERVAL_MINUTES" "60"; read_report_interval "$REPLY_VALUE"; discord_interval="$REPLY_VALUE"
  format_report_schedule_preview "$discord_interval"; success "Schedule: $REPLY_VALUE"

  notice ""
  notice "--- Public Website ---"
  notice "  This link is shown at the bottom of Discord statistics reports."
  get_env_value "PUBLIC_DASHBOARD_URL" "https://uct.aquaweb.cc/"; read_value "Domain or subdomain URL" "$REPLY_VALUE"
  normalize_public_url "$REPLY_VALUE"; public_url="$REPLY_VALUE"

  notice ""
  notice "--- Tracking Settings ---"
  get_env_value "AFK_AWAY_THRESHOLD_MINUTES" "5"; read_value "AFK pause threshold in minutes" "$REPLY_VALUE"; afk_minutes="$REPLY_VALUE"
  get_env_value "WEB_PORT" "3000"; read_value "Web dashboard port" "$REPLY_VALUE"; web_port="$REPLY_VALUE"
  get_env_value "HOST_WEB_PORT" "3000"; read_value "Host dashboard port" "$REPLY_VALUE"; host_port="$REPLY_VALUE"
  get_env_value "HOST_ADMIN_PORT" "3001"; read_value "Local admin port" "$REPLY_VALUE"; admin_port="$REPLY_VALUE"
  get_env_value "TZ" "UTC"; read_value "Timezone (e.g. UTC, Europe/Bucharest)" "$REPLY_VALUE"; timezone="$REPLY_VALUE"

  set_env_value "TS3_HOST" "$ts3_host"
  set_env_value "TS3_QUERY_PORT" "$query_port"
  set_env_value "TS3_QUERY_USER" "$query_user"
  set_env_value "TS3_QUERY_PASS" "$query_pass"
  set_env_value "TS3_BOT_NICKNAME" "$bot_nickname"
  set_env_value "TS3_ADMIN_GROUP_IDS" "$admin_groups"
  set_env_value "DISCORD_WEBHOOK_URL" "$discord_webhook"
  set_env_value "DISCORD_REPORT_INTERVAL_MINUTES" "$discord_interval"
  set_env_value "PUBLIC_DASHBOARD_URL" "$public_url"
  set_env_value "AFK_AWAY_THRESHOLD_MINUTES" "$afk_minutes"
  set_env_value "WEB_PORT" "$web_port"
  set_env_value "HOST_WEB_PORT" "$host_port"
  set_env_value "ADMIN_PORT" "3001"
  set_env_value "HOST_ADMIN_PORT" "$admin_port"
  set_env_value "TZ" "$timezone"

  [[ -n "$query_pass" ]] || notice "WARNING: ServerQuery password is blank. The bot may fail to connect."
  [[ -z "$discord_webhook" ]] || is_discord_webhook "$discord_webhook" || \
    notice "WARNING: The Discord webhook URL does not look like an official Discord webhook."
  success ".env saved successfully."
}

build_image() {
  notice ""
  notice "[3/4] Building Docker image..."
  notice "  This downloads Node.js packages and compiles the SQLite native module."
  notice "  The first build may take a few minutes."
  configure_compose
  compose_cmd build
  success "Image built successfully."
}

finish() {
  local host_port public_url compose
  get_env_value "HOST_WEB_PORT" "3000"; host_port="$REPLY_VALUE"
  get_env_value "PUBLIC_DASHBOARD_URL" "https://uct.aquaweb.cc/"; public_url="$REPLY_VALUE"
  compose="$(compose_display)"

  notice ""
  success "[4/4] Setup complete!"
  notice "=================================================="
  notice ""
  notice "To START the bot:"
  notice "  $compose up -d --remove-orphans"
  notice ""
  notice "Web dashboard (local):"
  notice "  http://localhost:$host_port"
  notice ""
  notice "Public dashboard:"
  notice "  $public_url"
  notice ""
  notice "View bot logs:"
  notice "  docker logs -f uc-stats-bot"
  notice ""
  notice "To STOP the bot:"
  notice "  $compose down"
  notice "=================================================="
}

main() {
  cd "$SCRIPT_DIR"
  heading
  ensure_docker
  configure_environment
  build_image
  finish
}

main "$@"
