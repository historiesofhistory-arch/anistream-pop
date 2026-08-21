#!/bin/bash
# Loads .env if present, then exports the required env vars and starts the server.
# The .env file is gitignored — never committed. In production, set these in
# your hosting platform's env vars dashboard.

export PATH="/home/z/.npm-global/bin:$PATH"
cd /home/z/my-project/anistream

# Load .env if it exists (local dev only — production injects env vars directly)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# ── Required env vars (defaults shown) ──────────────────────────────────────
# Override via .env or environment. Order: explicit env > .env > default.
export EMBED_API_URL="${EMBED_API_URL:-https://animani58hggktstisruarusrusrirustis.onrender.com}"
export EPISODES_API_URL="${EPISODES_API_URL:-https://api.bine.me}"
export STATIC_DIR="${STATIC_DIR:-/home/z/my-project/anistream/runtime/public}"
export PORT="${PORT:-3000}"

# ── MAL integration env vars (PARKED — code not yet implemented) ──────────────
# DATA_SOURCE: which API to use for catalog pages (home, search, browse,
#              details, schedule). Stream/episode IDs always use AniList.
#              Values: anilist (default) | mal
# MAL_CLIENT_ID: required when DATA_SOURCE=mal. Get one at:
#              https://myanimelist.net/apiconfig/create
export DATA_SOURCE="${DATA_SOURCE:-anilist}"
# MAL_CLIENT_ID is passed through as-is (no default — empty means MAL disabled)

exec node api-server/dist/index.mjs
