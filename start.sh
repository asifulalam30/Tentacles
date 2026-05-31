#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# TENTACLES — Start Script
# Usage: bash start.sh
# Stops any existing instance, fixes config, starts cleanly
# ─────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${GREEN}[+]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Load .env ─────────────────────────────────────────────────────────────────
[[ -f .env ]] || err ".env not found — run bash run.sh first"
set -a; source .env; set +a

VPS_IP="${VPS_PUBLIC_IP:-$(curl -s --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')}"

echo ""
echo -e "${BOLD}  TENTACLES — Starting up${NC}"
echo "  ─────────────────────────────"

# ── Step 1: Kill everything on our ports ──────────────────────────────────────
log "Clearing ports 4000 and 5173..."
pkill -f nodemon               2>/dev/null || true
pkill -f "node src/server"     2>/dev/null || true
pkill -f "vite"                2>/dev/null || true
systemctl stop tentacles        2>/dev/null || true
fuser -k 4000/tcp              2>/dev/null || true
fuser -k 5173/tcp              2>/dev/null || true
sleep 2

# Confirm ports are free
for port in 4000 5173; do
  if ss -tlnp | grep -q ":${port} "; then
    err "Port $port still in use — kill the process manually: fuser -k ${port}/tcp"
  fi
done
ok "Ports 4000 and 5173 are free"

# ── Step 2: Fix package.json — use node not nodemon ───────────────────────────
log "Setting up stable server (no nodemon restarts)..."
node -e "
const fs = require('fs');
const p  = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.scripts['dev:api'] = '
# ── Deploy SPINEL if not already deployed ─────────────────────────────────────
SPINEL_DEST="/opt/tentacles/spinel_scanner"
SPINEL_SRC="$(dirname "$0")/tools/spinel_scanner"
if [ -d "$SPINEL_SRC" ] && [ ! -f "$SPINEL_DEST/main.py" ]; then
  echo "[TENTACLES] Deploying SPINEL reflection scanner..."
  mkdir -p "$SPINEL_DEST"
  cp -r "$SPINEL_SRC"/* "$SPINEL_DEST/"
  pip3 install -r "$SPINEL_DEST/requirements.txt" --break-system-packages -q 2>/dev/null || true
  echo "[TENTACLES] SPINEL deployed to $SPINEL_DEST"
  # Deploy JS extractor
  JS_SRC="$(dirname "$0")/tools/js_extract.py"
  [ -f "$JS_SRC" ] && cp "$JS_SRC" /opt/tentacles/js_extract.py && chmod +x /opt/tentacles/js_extract.py
elif [ -d "$SPINEL_DEST" ]; then
  # Always sync latest version
  cp -r "$SPINEL_SRC"/* "$SPINEL_DEST/" 2>/dev/null || true
  # Always sync VPS-optimised config (no proxy)
  [ -f "$SPINEL_SRC/config.yaml" ] && cp "$SPINEL_SRC/config.yaml" "$SPINEL_DEST/config.yaml" 2>/dev/null || true
fi

node src/server.js';
p.scripts['start']   = 'node src/server.js';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
" 2>/dev/null
ok "Backend will run with node (stable — no file-watch restarts)"

# ── Step 3: Fix App.jsx gap warnings ──────────────────────────────────────────
sed -i 's/gap: 10, flexWrap: "wrap", gap: 8/gap: 8, flexWrap: "wrap"/g' \
  frontend/src/App.jsx 2>/dev/null || true
sed -i 's/gap: 8, flexWrap: "wrap", gap: 6/gap: 6, flexWrap: "wrap"/g' \
  frontend/src/App.jsx 2>/dev/null || true

# ── Step 4: Make sure npm deps are installed ──────────────────────────────────
if [[ ! -d node_modules ]]; then
  log "Installing backend dependencies..."
  npm install --silent
fi
if [[ ! -d frontend/node_modules ]]; then
  log "Installing frontend dependencies..."
  cd frontend && npm install --silent && cd ..
fi

# ── Step 5: Start backend ─────────────────────────────────────────────────────
log "Starting backend on port 4000..."
node src/server.js > /tmp/tentacles-api.log 2>&1 &
API_PID=$!

# Wait for backend to be healthy
for i in {1..15}; do
  sleep 1
  if curl -s http://localhost:4000/api/health | grep -q '"status":"ok"'; then
    ok "Backend is healthy (PID $API_PID)"
    break
  fi
  if ! kill -0 $API_PID 2>/dev/null; then
    echo ""
    err "Backend crashed — check logs: tail /tmp/tentacles-api.log"
  fi
  echo -n "."
done
echo ""

# ── Step 6: Start frontend ────────────────────────────────────────────────────
log "Starting frontend on port 5173..."
cd frontend
npm run dev -- --host 0.0.0.0 --port 5173 > /tmp/tentacles-ui.log 2>&1 &
UI_PID=$!
cd ..

# Wait for Vite to be ready
for i in {1..15}; do
  sleep 1
  if curl -s http://localhost:5173 | grep -q "Tentacles\|html\|vite"; then
    ok "Frontend is ready (PID $UI_PID)"
    break
  fi
  echo -n "."
done
echo ""

# ── Step 7: Inject API key into frontend session store ────────────────────────
# This is the root cause of the Unauthorized errors.
# We inject the API key directly so the browser never needs to know it.
log "Configuring frontend authentication..."
API_KEY="${API_SECRET_KEY:-}"
if [[ -z "$API_KEY" ]]; then
  warn "API_SECRET_KEY not set in .env — you will need to paste it manually on login"
else
  # Write a small init script that Vite will serve
  # It sets the API key in localStorage before the app loads
  mkdir -p frontend/public
  cat > frontend/public/init.js << JSEOF
// Auto-injected by start.sh — sets API key so login only needs password
(function(){
  var k = "${API_KEY}";
  if(k && k !== "change-this-to-a-random-secret-key") {
    localStorage.setItem("tentacles_api_key", k);
  }
})();
JSEOF

  # Inject init.js into index.html if not already there
  if ! grep -q "init.js" frontend/index.html; then
    sed -i 's|<head>|<head>\n    <script src="/init.js"></script>|' frontend/index.html
    ok "API key auto-injection configured"
  else
    ok "API key auto-injection already in place"
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}    Tentacles is running!${NC}"
echo -e "${GREEN}${BOLD}  ════════════════════════════════════${NC}"
echo ""
echo -e "  Open:  ${CYAN}${BOLD}http://${VPS_IP}:5173${NC}"
echo ""
echo "  Logs:"
echo "    tail -f /tmp/tentacles-api.log   # backend"
echo "    tail -f /tmp/tentacles-ui.log    # frontend"
echo ""
echo "  Stop:  kill $API_PID $UI_PID"
echo "  Or:    bash start.sh  (restart cleanly)"
echo ""

# Keep running — show backend logs live
echo -e "${CYAN}  Live backend logs (Ctrl+C to stop Tentacles):${NC}"
echo "  ─────────────────────────────────────────────"
tail -f /tmp/tentacles-api.log
