#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# TENTACLES — One-command install and run
# Usage: sudo bash run.sh
# Ubuntu 20.04 / 22.04 / 24.04 — checks what's already installed first
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $*"; }
info() { echo -e "${CYAN}[i]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
skip() { echo -e "${CYAN}[~]${NC} $* (already installed)"; }
err()  { echo -e "${RED}[✗]${NC} $*"; exit 1; }

clear
echo -e "${BOLD}"
echo "████████╗███████╗███╗   ██╗████████╗ █████╗  ██████╗██╗     ███████╗███████╗"
echo "╚══██╔══╝██╔════╝████╗  ██║╚══██╔══╝██╔══██╗██╔════╝██║     ██╔════╝██╔════╝"
echo "   ██║   █████╗  ██╔██╗ ██║   ██║   ███████║██║     ██║     █████╗  ███████╗"
echo "   ██║   ██╔══╝  ██║╚██╗██║   ██║   ██╔══██║██║     ██║     ██╔══╝  ╚════██║"
echo "   ██║   ███████╗██║ ╚████║   ██║   ██║  ██║╚██████╗███████╗███████╗███████║"
echo "   ╚═╝   ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚══════╝╚══════╝╚══════╝"
echo -e "${NC}"

echo "  Workbench —  recon and bug-hunting assistant"
echo ""

[[ $EUID -ne 0 ]] && err "Run as root: sudo bash run.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Detect VPS public IP ──────────────────────────────────────────────────────
log "Detecting VPS public IP..."
VPS_IP=""
for svc in ifconfig.me icanhazip.com api.ipify.org ipecho.net/plain; do
  VPS_IP=$(curl -s --max-time 5 "$svc" 2>/dev/null | tr -d '[:space:]')
  [[ "$VPS_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break
  VPS_IP=""
done
[[ -z "$VPS_IP" ]] && VPS_IP=$(hostname -I | awk '{print $1}')
ok "VPS IP: ${BOLD}$VPS_IP${NC}"

# ── Already running? ──────────────────────────────────────────────────────────
if systemctl is-active --quiet tentacles 2>/dev/null; then
  echo ""
  echo -e "${GREEN}Tentacles is already running.${NC}"
  echo -e "  UI:  ${CYAN}${BOLD}http://${VPS_IP}:5173${NC}"
  echo -e "  API: ${CYAN}http://${VPS_IP}:4000/api/health${NC}"
  echo ""
  read -rp "Restart Tentacles? (y/N): " DO_RESTART
  if [[ "$DO_RESTART" =~ ^[Yy]$ ]]; then
    systemctl restart tentacles && ok "Restarted."
  fi
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# CHECK WHAT'S ALREADY INSTALLED
# ─────────────────────────────────────────────────────────────────────────────
echo ""
log "Checking what's already installed..."
echo ""

# Helper: check and report
_has() { command -v "$1" &>/dev/null; }
_has_dir() { [[ -d "$1" ]]; }

# System packages
APT_PKGS=()
for pkg in curl wget git unzip jq nmap whois dnsutils python3 python3-pip \
           libssl-dev build-essential chromium-browser; do
  if dpkg -l "$pkg" 2>/dev/null | grep -q "^ii"; then
    skip "$pkg"
  else
    info "  Will install: $pkg"
    APT_PKGS+=("$pkg")
  fi
done

# Node.js
NODE_NEEDS_INSTALL=false
if _has node; then
  NODE_VER=$(node --version | cut -d. -f1 | tr -d 'v')
  if [[ $NODE_VER -ge 18 ]]; then
    skip "Node.js ($(node --version))"
  else
    warn "Node.js $(node --version) is too old — will upgrade to v20"
    NODE_NEEDS_INSTALL=true
  fi
else
  info "  Will install: Node.js 20"
  NODE_NEEDS_INSTALL=true
fi

# Go
GO_NEEDS_INSTALL=false
if _has go; then
  skip "Go ($(go version | awk '{print $3}'))"
else
  info "  Will install: Go 1.22.2"
  GO_NEEDS_INSTALL=true
fi

# Go-based security tools
GO_TOOLS=(subfinder httpx ffuf dnsx katana waybackurls gau anew nuclei gowitness subzy)
GO_TOOLS_TO_INSTALL=()
for t in "${GO_TOOLS[@]}"; do
  if _has "$t"; then
    skip "$t"
  else
    info "  Will install: $t"
    GO_TOOLS_TO_INSTALL+=("$t")
  fi
done

# Python tools
ARJUN_NEEDS_INSTALL=false
if _has arjun; then
  skip "arjun"
else
  info "  Will install: arjun (pip)"
  ARJUN_NEEDS_INSTALL=true
fi

# SecLists
SECLISTS_NEEDS_INSTALL=false
if _has_dir /opt/SecLists || _has_dir /usr/share/seclists; then
  skip "SecLists wordlists"
else
  info "  Will install: SecLists"
  SECLISTS_NEEDS_INSTALL=true
fi

# Reflection (SPINEL) Python venv
REFLECTION_VENV_NEEDS_INSTALL=false
REFLECTION_DIR="${SCRIPT_DIR}/tools/reflection"
if [[ -d "$REFLECTION_DIR" ]]; then
  if [[ -f "$REFLECTION_DIR/.venv/bin/python" ]] && \
     [[ -d "$REFLECTION_DIR/.venv/lib" ]] && \
     "$REFLECTION_DIR/.venv/bin/python" -c "import httpx, yaml, pydantic, orjson" 2>/dev/null; then
    skip "Reflection (SPINEL) venv"
  else
    info "  Will install: Reflection (SPINEL) Python venv"
    REFLECTION_VENV_NEEDS_INSTALL=true
  fi
fi

# python3-venv (needed to create the SPINEL venv)
if [[ $REFLECTION_VENV_NEEDS_INSTALL == true ]]; then
  if ! dpkg -l python3-venv 2>/dev/null | grep -q "^ii"; then
    info "  Will install: python3-venv (required for Reflection tool)"
    APT_PKGS+=(python3-venv)
  fi
fi

echo ""

# Summary before doing anything
TOTAL_NEW=$((${#APT_PKGS[@]} + (${#GO_TOOLS_TO_INSTALL[@]}) ))
if [[ $NODE_NEEDS_INSTALL == true ]]; then ((TOTAL_NEW++)) || true; fi
if [[ $GO_NEEDS_INSTALL == true ]]; then ((TOTAL_NEW++)) || true; fi
if [[ $ARJUN_NEEDS_INSTALL == true ]]; then ((TOTAL_NEW++)) || true; fi
if [[ $SECLISTS_NEEDS_INSTALL == true ]]; then ((TOTAL_NEW++)) || true; fi
if [[ $REFLECTION_VENV_NEEDS_INSTALL == true ]]; then ((TOTAL_NEW++)) || true; fi

if [[ $TOTAL_NEW -eq 0 ]]; then
  ok "Everything is already installed — skipping to Tentacles setup"
else
  log "$TOTAL_NEW item(s) to install"
  read -rp "Proceed with installation? (Y/n): " DO_INSTALL
  [[ "$DO_INSTALL" =~ ^[Nn]$ ]] && err "Aborted."
fi

# ─────────────────────────────────────────────────────────────────────────────
# INSTALL ONLY WHAT'S MISSING
# ─────────────────────────────────────────────────────────────────────────────

# System packages
if [[ ${#APT_PKGS[@]} -gt 0 ]]; then
  log "Installing system packages: ${APT_PKGS[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq "${APT_PKGS[@]}" 2>/dev/null || \
    apt-get install -y "${APT_PKGS[@]}" 2>/dev/null || true
  ok "System packages installed"
fi

# Node.js
if [[ $NODE_NEEDS_INSTALL == true ]]; then
  log "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null 2>&1
  ok "Node.js $(node --version)"
fi

# Go
export PATH=$PATH:/usr/local/go/bin:/root/go/bin
export GOPATH="${GOPATH:-/root/go}"
if [[ $GO_NEEDS_INSTALL == true ]]; then
  log "Installing Go 1.22.2..."
  wget -q "https://go.dev/dl/go1.22.2.linux-amd64.tar.gz" -O /tmp/go.tar.gz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf /tmp/go.tar.gz
  rm /tmp/go.tar.gz
  ok "Go $(go version | awk '{print $3}')"
fi
# Always ensure go paths are in profile
grep -q "/usr/local/go/bin" /etc/profile.d/go.sh 2>/dev/null || \
  echo 'export PATH=$PATH:/usr/local/go/bin:/root/go/bin' > /etc/profile.d/go.sh

# Go tools — only missing ones
declare -A GO_PKG_MAP=(
  [subfinder]="github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest"
  [httpx]="github.com/projectdiscovery/httpx/cmd/httpx@latest"
  [ffuf]="github.com/ffuf/ffuf/v2@latest"
  [dnsx]="github.com/projectdiscovery/dnsx/cmd/dnsx@latest"
  [katana]="github.com/projectdiscovery/katana/cmd/katana@latest"
  [waybackurls]="github.com/tomnomnom/waybackurls@latest"
  [gau]="github.com/lc/gau/v2/cmd/gau@latest"
  [anew]="github.com/tomnomnom/anew@latest"
  [nuclei]="github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest"
  [gowitness]="github.com/sensepost/gowitness@latest"
  [subzy]="github.com/PentestPad/subzy@latest"
)

if [[ ${#GO_TOOLS_TO_INSTALL[@]} -gt 0 ]]; then
  log "Installing ${#GO_TOOLS_TO_INSTALL[@]} Go tool(s)..."
  for t in "${GO_TOOLS_TO_INSTALL[@]}"; do
    info "  → $t"
    go install -v "${GO_PKG_MAP[$t]}" >/dev/null 2>&1 && \
      cp "$GOPATH/bin/$t" /usr/local/bin/ 2>/dev/null || \
      warn "  $t install failed — continuing"
  done
  ok "Go tools installed"
fi

# Nuclei templates (separate step — also runs if nuclei was already installed)
if _has nuclei; then
  if [[ ! -d /root/nuclei-templates ]] && [[ ! -d ~/nuclei-templates ]]; then
    log "Updating nuclei templates (one-time, ~30s)..."
    nuclei -update-templates -silent >/dev/null 2>&1 || \
      warn "nuclei template update failed — Nuclei tool will use empty template set"
  else
    skip "nuclei-templates"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────
# ADDITIONAL PENTEST TOOLS (wafw00f, whatweb, testssl.sh, trufflehog,
# s3scanner, xnLinkFinder)
# ─────────────────────────────────────────────────────────────────────────

# wafw00f via pip (system)
if ! _has wafw00f; then
  log "Installing wafw00f..."
  pip3 install --break-system-packages -q wafw00f 2>&1 | tail -2 || \
    warn "  wafw00f install failed (pip)"
else
  skip "wafw00f"
fi

# whatweb via apt (Ubuntu has it; otherwise gem install whatweb)
if ! _has whatweb; then
  log "Installing whatweb..."
  if apt-cache show whatweb >/dev/null 2>&1; then
    apt-get install -y whatweb 2>&1 | tail -2 || warn "  whatweb apt install failed"
  else
    info "  No apt package — trying gem install"
    gem install whatweb 2>&1 | tail -2 || warn "  whatweb gem install failed"
  fi
else
  skip "whatweb"
fi

# testssl.sh — git clone (no apt package on most Ubuntu)
if ! _has testssl.sh; then
  log "Installing testssl.sh..."
  if [[ ! -d /opt/testssl.sh ]]; then
    git clone --depth 1 https://github.com/drwetter/testssl.sh.git /opt/testssl.sh 2>&1 | tail -2 || \
      warn "  testssl.sh git clone failed"
  fi
  if [[ -f /opt/testssl.sh/testssl.sh ]]; then
    ln -sf /opt/testssl.sh/testssl.sh /usr/local/bin/testssl.sh
    ok "  testssl.sh linked to /usr/local/bin/"
  fi
else
  skip "testssl.sh"
fi

# trufflehog — official install script (Go binary)
if ! _has trufflehog; then
  log "Installing trufflehog..."
  curl -sSfL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh | \
    sh -s -- -b /usr/local/bin 2>&1 | tail -2 || warn "  trufflehog install failed"
else
  skip "trufflehog"
fi

# s3scanner via pip — tries s3scanner, falls back to cloud_enum
if ! _has s3scanner && ! _has cloud_enum; then
  log "Installing s3scanner..."
  if pip3 install --break-system-packages -q s3scanner 2>&1 | tail -2; then
    if _has s3scanner; then ok "s3scanner installed"; else warn "  s3scanner install reported success but binary not found"; fi
  else
    warn "  s3scanner pip install failed, trying cloud_enum as fallback..."
    pip3 install --break-system-packages -q cloud-enum 2>&1 | tail -2 || \
      warn "  cloud_enum install also failed — Cloud Bucket Scan stage will skip"
  fi
else
  if _has s3scanner; then skip "s3scanner"; else skip "cloud_enum"; fi
fi

# xnLinkFinder via pip (better JS endpoint extraction)
if ! _has xnLinkFinder; then
  log "Installing xnLinkFinder..."
  pip3 install --break-system-packages -q xnLinkFinder 2>&1 | tail -2 || \
    warn "  xnLinkFinder install failed (will fall back to regex)"
else
  skip "xnLinkFinder"
fi

# uro — URL deduplication / normalization (used in baseline-augment helpers)
if ! _has uro; then
  log "Installing uro..."
  pip3 install --break-system-packages -q uro 2>&1 | tail -2 || \
    warn "  uro install failed"
else
  skip "uro"
fi

# qsreplace + unfurl — already provided by go tools? Add only if missing.
if ! _has qsreplace; then
  log "Installing qsreplace..."
  go install -v github.com/tomnomnom/qsreplace@latest >/dev/null 2>&1 && \
    cp "$GOPATH/bin/qsreplace" /usr/local/bin/ 2>/dev/null || warn "  qsreplace install failed"
else
  skip "qsreplace"
fi
if ! _has unfurl; then
  log "Installing unfurl..."
  go install -v github.com/tomnomnom/unfurl@latest >/dev/null 2>&1 && \
    cp "$GOPATH/bin/unfurl" /usr/local/bin/ 2>/dev/null || warn "  unfurl install failed"
else
  skip "unfurl"
fi

# gf + Gf-Patterns
if ! _has gf; then
  log "Installing gf..."
  go install -v github.com/tomnomnom/gf@latest >/dev/null 2>&1 && \
    cp "$GOPATH/bin/gf" /usr/local/bin/ 2>/dev/null || warn "  gf install failed"
  if [[ ! -d "$HOME/.gf" ]] && _has gf; then
    log "Installing Gf-Patterns..."
    git clone --depth 1 https://github.com/1ndianl33t/Gf-Patterns "$HOME/.gf" 2>&1 | tail -2 || \
      warn "  Gf-Patterns clone failed"
  fi
else
  skip "gf"
fi

# subjs — JS link extraction
if ! _has subjs; then
  log "Installing subjs..."
  go install -v github.com/lc/subjs@latest >/dev/null 2>&1 && \
    cp "$GOPATH/bin/subjs" /usr/local/bin/ 2>/dev/null || warn "  subjs install failed"
else
  skip "subjs"
fi

# Reflection tool Python venv (verbose — surfaces errors so you can fix them)
if [[ $REFLECTION_VENV_NEEDS_INSTALL == true ]] && [[ -d "$REFLECTION_DIR" ]]; then
  log "Setting up Reflection (SPINEL) Python venv..."

  # Step 1: ensure python3-venv is available
  if ! python3 -c "import venv" 2>/dev/null; then
    info "  Installing python3-venv..."
    apt-get install -y python3-venv 2>&1 | grep -E "^(E:|Setting|already)" | head -3 || true
  fi

  # Step 2: create the venv (delete any broken stub first)
  if [[ -d "$REFLECTION_DIR/.venv" ]] && [[ ! -f "$REFLECTION_DIR/.venv/bin/pip" ]]; then
    info "  Removing broken .venv stub..."
    rm -rf "$REFLECTION_DIR/.venv"
  fi
  if [[ ! -f "$REFLECTION_DIR/.venv/bin/python" ]]; then
    info "  Creating venv at $REFLECTION_DIR/.venv..."
    python3 -m venv "$REFLECTION_DIR/.venv" || warn "  venv creation failed"
  fi

  # Step 3: install requirements
  if [[ -f "$REFLECTION_DIR/.venv/bin/pip" ]]; then
    info "  Upgrading pip..."
    "$REFLECTION_DIR/.venv/bin/pip" install --upgrade pip 2>&1 | tail -1 | grep -v "^$" || true
    info "  Installing httpx, PyYAML, pydantic, orjson..."
    if "$REFLECTION_DIR/.venv/bin/pip" install -r "$REFLECTION_DIR/requirements.txt" 2>&1 | tail -3; then
      # Step 4: verify imports work
      if "$REFLECTION_DIR/.venv/bin/python" -c "import httpx, yaml, pydantic, orjson" 2>/dev/null; then
        ok "Reflection venv ready (httpx, yaml, pydantic, orjson all importable)"
      else
        warn "Reflection venv created but imports failed — Reflection tool may not work"
        warn "  Try: cd $REFLECTION_DIR && rm -rf .venv && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
      fi
    else
      warn "  Pip install failed — Reflection tool will fail when launched"
    fi
  else
    warn "  No pip in venv — Reflection unavailable. Install python3-venv manually:"
    warn "    apt install python3-venv && cd $REFLECTION_DIR && python3 -m venv .venv"
  fi
fi

# Reflection — final safety net: always verify imports and repair if missing.
# Catches cases where the venv exists but deps weren't installed
# (the gated block above only runs when REFLECTION_VENV_NEEDS_INSTALL=true).
if [[ -d "$REFLECTION_DIR" ]] && [[ -f "$REFLECTION_DIR/.venv/bin/python" ]]; then
  if ! "$REFLECTION_DIR/.venv/bin/python" -c "import httpx, yaml, pydantic, orjson" 2>/dev/null; then
    warn "Reflection venv exists but imports failed — repairing..."
    "$REFLECTION_DIR/.venv/bin/pip" install -r "$REFLECTION_DIR/requirements.txt" 2>&1 | tail -3 || true
    if "$REFLECTION_DIR/.venv/bin/python" -c "import httpx, yaml, pydantic, orjson" 2>/dev/null; then
      ok "Reflection venv repaired"
    else
      warn "Reflection venv repair failed. Manual fix:"
      warn "  cd $REFLECTION_DIR && rm -rf .venv && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
    fi
  fi
fi

# arjun
if [[ $ARJUN_NEEDS_INSTALL == true ]]; then
  log "Installing arjun..."
  pip3 install --break-system-packages --quiet arjun 2>/dev/null || \
    pip3 install --quiet arjun 2>/dev/null || \
    warn "arjun install failed — parameter discovery limited"
fi

# SecLists
if [[ $SECLISTS_NEEDS_INSTALL == true ]]; then
  log "Installing SecLists wordlists (this may take a moment)..."
  git clone --depth 1 https://github.com/danielmiessler/SecLists /opt/SecLists >/dev/null 2>&1
  ln -sf /opt/SecLists /usr/share/seclists 2>/dev/null || true
  ok "SecLists installed"
fi

# ─────────────────────────────────────────────────────────────────────────────
# TENTACLES SETUP
# ─────────────────────────────────────────────────────────────────────────────
log "Setting up Tentacles directories..."
mkdir -p /opt/tentacles/{workspace,reports,scripts,recon_output,logs,nuclei-templates}

log "Installing Node dependencies..."
npm install --silent 2>/dev/null
cd frontend && npm install --silent 2>/dev/null && cd ..
ok "Dependencies ready"

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURE .env
# ─────────────────────────────────────────────────────────────────────────────
log "Configuring environment..."

if [[ ! -f .env ]]; then
  cp .env.example .env
  # Auto-generate secret key
  sed -i "s/change-this-to-a-random-secret-key/$(openssl rand -hex 32)/" .env
fi

# Always write the detected VPS IP
sed -i "s|YOUR_VPS_PUBLIC_IP_HERE|${VPS_IP}|g" .env
sed -i "s|VPS_PUBLIC_IP=.*|VPS_PUBLIC_IP=${VPS_IP}|" .env
sed -i "s|http://YOUR_VPS_IP:5173|http://${VPS_IP}:5173|g" .env
ok "VPS IP set to $VPS_IP"

# Load current values
set +u
source .env 2>/dev/null || true
set -u

# Prompt for any missing keys
echo ""
echo -e "${BOLD}  Setup${NC}"
echo "  (Press Enter to skip — you can edit .env later)"
echo ""

if [[ -z "${FRONTEND_PASSWORD:-}" || "${FRONTEND_PASSWORD:-}" == "your-login-password-here" ]]; then
  echo -e "  ${CYAN}UI login password${NC} — protects your Tentacles web interface"
  read -rsp "  Choose a password: " FE_PASS; echo ""
  [[ -n "${FE_PASS:-}" ]] && sed -i "s|FRONTEND_PASSWORD=.*|FRONTEND_PASSWORD=${FE_PASS}|" .env
  echo ""
fi

ok "Configuration saved to .env"

# ─────────────────────────────────────────────────────────────────────────────
# FIREWALL
# ─────────────────────────────────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
  ufw allow 4000/tcp >/dev/null 2>&1 || true   # API
  ufw allow 5173/tcp >/dev/null 2>&1 || true   # Frontend
  ufw allow 7331/tcp >/dev/null 2>&1 || true   # Blind XSS callbacks
fi

# ─────────────────────────────────────────────────────────────────────────────
# SYSTEMD SERVICE
# ─────────────────────────────────────────────────────────────────────────────
log "Creating systemd service..."
APP_DIR="$(pwd)"
cat > /etc/systemd/system/tentacles.service << EOF
[Unit]
Description=TENTACLES Workbench
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=$(which node) src/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=tentacles
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tentacles >/dev/null 2>&1
systemctl start tentacles

# Wait for API to respond (up to 10s)
echo -n "  Waiting for API"
for i in {1..10}; do
  sleep 1
  echo -n "."
  curl -s http://localhost:4000/api/health >/dev/null 2>&1 && break
done
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# TOOL VERIFICATION SUMMARY
# ─────────────────────────────────────────────────────────────────────────────
echo ""
log "Tool verification:"
ALL_TOOLS=(subfinder httpx ffuf dnsx katana waybackurls gau arjun nuclei gowitness subzy wafw00f whatweb testssl.sh trufflehog s3scanner xnLinkFinder uro qsreplace unfurl gf subjs nmap dig jq curl)
MISSING=()
for t in "${ALL_TOOLS[@]}"; do
  if _has "$t"; then
    ok "  $t"
  else
    warn "  $t — not installed (some features limited)"
    MISSING+=("$t")
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
# DONE
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}  ══════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}    Tentacles is running!${NC}"
echo -e "${GREEN}${BOLD}  ══════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Open in browser:${NC}  ${CYAN}${BOLD}http://${VPS_IP}:5173${NC}"
echo ""
echo "  Useful commands:"
echo "    journalctl -u tentacles -f      # live logs"
echo "    systemctl restart tentacles     # restart after config changes"
echo "    nano ${APP_DIR}/.env           # edit password / settings"
echo ""
echo "  Recon: ${APP_DIR}/recon/retrox-recon.sh"
echo "    runs automatically when you create a workbench"
echo ""

if curl -s http://localhost:4000/api/health >/dev/null 2>&1; then
  ok "API healthy — you're good to go"
else
  warn "API not responding yet. Check logs:"
  warn "  journalctl -u tentacles -n 30"
  warn "Common fix: add API keys to .env then restart:"
  warn "  nano .env  →  systemctl restart tentacles"
fi

[[ ${#MISSING[@]} -gt 0 ]] && \
  warn "Missing tools: ${MISSING[*]} — re-run setup.sh to install them"

# Reflection venv check — verify imports actually work
REFLECTION_VENV="${SCRIPT_DIR}/tools/reflection/.venv/bin/python"
if [[ -f "$REFLECTION_VENV" ]]; then
  if "$REFLECTION_VENV" -c "import httpx, yaml, pydantic, orjson" 2>/dev/null; then
    ok "  Reflection (SPINEL) venv (deps verified)"
  else
    warn "  Reflection venv exists but deps missing — Reflection tool will fail"
    warn "    Fix: ${SCRIPT_DIR}/tools/reflection/.venv/bin/pip install -r ${SCRIPT_DIR}/tools/reflection/requirements.txt"
  fi
else
  warn "  Reflection venv missing — Reflection tool will fail when launched"
  warn "    Fix: cd ${SCRIPT_DIR}/tools/reflection && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
fi

echo ""
