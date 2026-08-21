#!/bin/bash
# Loads .env if present (without overriding env vars already set on the
# command line or by the parent process), then exports the required env vars
# and starts the server. The .env file is gitignored — never committed.
# In production, set these in your hosting platform's env vars dashboard.

export PATH="/home/z/.npm-global/bin:$PATH"
cd /home/z/my-project/anistream

# Load .env if it exists, but DON'T override env vars already set externally.
# We use `${VAR+x}` to detect if VAR was set (even to empty) — if so, skip
# the .env assignment. This lets `DATA_SOURCE=mal bash start.sh` win over
# the .env file's `DATA_SOURCE=anilist`.
if [ -f .env ]; then
  while IFS='=' read -r key value || [ -n "$key" ]; do
    # Skip comments + blank lines
    case "$key" in
      ''|\#*) continue ;;
    esac
    # Only set if not already in the environment
    if [ -z "${!key+x}" ]; then
      # Strip any surrounding quotes from value
      value="${value%\"}"
      value="${value#\"}"
      value="${value%\'}"
      value="${value#\'}"
      export "$key=$value"
    fi
  done < .env
fi

# ── Required env vars (defaults shown) ──────────────────────────────────────
export EMBED_API_URL="${EMBED_API_URL:-https://animani58hggktstisruarusrusrirustis.onrender.com}"
export EPISODES_API_URL="${EPISODES_API_URL:-https://api.bine.me}"
export STATIC_DIR="${STATIC_DIR:-/home/z/my-project/anistream/runtime/public}"
export PORT="${PORT:-3000}"

# ── MAL integration env vars ─────────────────────────────────────────────────
# DATA_SOURCE: which API to use for catalog pages (home, search, browse,
#              details, schedule). Stream/episode IDs always use AniList.
#              Values: anilist (default) | mal
# MAL_CLIENT_ID: required when DATA_SOURCE=mal. Get one at:
#              https://myanimelist.net/apiconfig/create
export DATA_SOURCE="${DATA_SOURCE:-anilist}"
# MAL_CLIENT_ID is passed through as-is (no default — empty means MAL disabled)

exec node api-server/dist/index.mjs

