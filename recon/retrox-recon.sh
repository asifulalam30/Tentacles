#!/bin/bash
# recon.sh - Subdomain Recon & Web App Testing Pipeline
# Usage: bash recon.sh <domain> [output_dir]
# WARNING: Run only on systems you are authorized to test.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "[!] Run with: bash recon.sh <domain>"
  exit 1
fi
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "[!] bash 4+ required (you have $BASH_VERSION)"
  exit 1
fi

set -uo pipefail
IFS=$'\n\t'

# ==================== HELPERS ====================
log()  { echo "[*] $(date '+%H:%M:%S') $*"; }
ok()   { echo "[+] $(date '+%H:%M:%S') $*"; }
warn() { echo "[!] $(date '+%H:%M:%S') $*"; }
lc()   { [[ -f "$1" ]] && wc -l < "$1" 2>/dev/null || echo 0; }
die()  { warn "$*"; exit 1; }

phase_banner() {
  echo ""
  echo "=============================================="
  echo "  PHASE $1: $2"
  echo "  $(date '+%Y-%m-%d %H:%M:%S')"
  echo "=============================================="
}

# ==================== CONFIG ====================
TARGET_DOMAIN="${1:-}"
BASE_OUTDIR="${2:-recon_output}"

if [[ -z "$TARGET_DOMAIN" ]]; then
  read -rp "Enter target domain (e.g., example.com): " TARGET_DOMAIN
  TARGET_DOMAIN=$(echo "$TARGET_DOMAIN" | xargs | sed 's|https\?://||; s|/.*||')
  [[ -z "$TARGET_DOMAIN" ]] && die "No domain provided."
  read -rp "Output directory [recon_output]: " user_outdir
  [[ -n "${user_outdir:-}" ]] && BASE_OUTDIR="$user_outdir"
fi

# ---- Tuning ----
THREADS=${THREADS:-30}
WB_TIMEOUT=${WB_TIMEOUT:-60}
DEEP_SCAN=${DEEP_SCAN:-0}

# ---- Arjun ----
ARJUN_CONCURRENCY=${ARJUN_CONCURRENCY:-3}
ARJUN_THREADS=${ARJUN_THREADS:-5}
ARJUN_TIMEOUT=${ARJUN_TIMEOUT:-120}

# ---- FFUF ----
FFUF_THREADS=${FFUF_THREADS:-5}
FFUF_RATE=${FFUF_RATE:-5}
FFUF_DELAY=${FFUF_DELAY:-0.2}
FFUF_CONCURRENCY=${FFUF_CONCURRENCY:-1}
FFUF_TIMEOUT=${FFUF_TIMEOUT:-400}
FFUF_WORDLIST="${FFUF_WORDLIST:-/root/SecLists/Discovery/Web-Content/raft-medium-directories.txt}"
FFUF_EXT="${FFUF_EXT:-php,html,js,txt,json,xml,asp,aspx,jsp,bak,old,zip}"

# Cloudflare-specific overrides
CF_FFUF_RATE=${CF_FFUF_RATE:-2}
CF_FFUF_THREADS=${CF_FFUF_THREADS:-2}
CF_FFUF_DELAY=${CF_FFUF_DELAY:-0.5}

# ---- Skip flags ----
SKIP_NMAP=${SKIP_NMAP:-0}
SKIP_URLS=${SKIP_URLS:-0}
SKIP_SUBS=${SKIP_SUBS:-0}
SKIP_DNS=${SKIP_DNS:-0}
SKIP_HTTP=${SKIP_HTTP:-0}
SKIP_PARAMS=${SKIP_PARAMS:-0}

# ==================== SETUP ====================
sanitize() { echo "$1" | sed 's/[^A-Za-z0-9._-]/_/g'; }
DOMAIN="$TARGET_DOMAIN"
OUT="$BASE_OUTDIR/$(sanitize "$DOMAIN")"
mkdir -p "$OUT" || die "Cannot create output dir: $OUT"
cd "$OUT"

TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
LOGFILE="${DOMAIN}_${TIMESTAMP}.log"
touch "$LOGFILE" || true

_log_write() { echo "$*" | tee -a "$LOGFILE"; }
log()  { _log_write "[*] $(date '+%H:%M:%S') $*"; }
ok()   { _log_write "[+] $(date '+%H:%M:%S') $*"; }
warn() { _log_write "[!] $(date '+%H:%M:%S') $*"; }

phase_banner() {
  _log_write ""
  _log_write "=============================================="
  _log_write "  PHASE $1: $2"
  _log_write "  $(date '+%Y-%m-%d %H:%M:%S')"
  _log_write "=============================================="
}

_log_write "=============================================="
_log_write "  recon.sh"
_log_write "  Domain  : $DOMAIN"
_log_write "  Output  : $OUT"
_log_write "  Log     : $OUT/$LOGFILE"
_log_write "  Started : $(date)"
_log_write "  Bash    : $BASH_VERSION"
_log_write "=============================================="

# ==================== TOOL VALIDATION ====================
REQUIRED=(curl jq dig httpx waybackurls gau)
[[ "$SKIP_NMAP"  -eq 0 ]] && REQUIRED+=(nmap)
OPTIONAL=(amass assetfinder subfinder dnsx katana)

MISSING=()
for cmd in "${REQUIRED[@]}"; do
  command -v "$cmd" &>/dev/null || MISSING+=("$cmd")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  warn "Missing required tools: ${MISSING[*]}"
  exit 2
fi
for cmd in "${OPTIONAL[@]}"; do
  command -v "$cmd" &>/dev/null || warn "Optional tool not found (skipping): $cmd"
done
log "Tool check passed."

# ==================== USER AGENT POOL ====================
UA_POOL=(
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15"
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
UA="${UA_POOL[$((RANDOM % ${#UA_POOL[@]}))]}"

# ==================== PARALLEL RUNNER ====================
# PID-based, no FIFOs. $1 inside body = current line.
parallel_run() {
  local max="$1" tsecs="$2" input="$3" body="$4"
  [[ ! -s "$input" ]] && return 0
  local -a pids=()
  _pr_reap() {
    local -a live=(); local p
    for p in "${pids[@]:-}"; do
      kill -0 "$p" 2>/dev/null && live+=("$p")
    done
    pids=("${live[@]:-}")
  }
  while IFS= read -r line; do
    while [[ ${#pids[@]} -ge $max ]]; do _pr_reap; sleep 0.2; done
    ( timeout "$tsecs" bash -c "$body" _ "$line" 2>/dev/null || true ) &
    pids+=($!)
  done < "$input"
  for p in "${pids[@]:-}"; do wait "$p" 2>/dev/null || true; done
}

# ==================== PRE-CREATE OUTPUT FILES ====================
for _f in all_subs.txt resolved.txt ips.txt cnames.txt dangling.txt \
           alive_hosts.txt cloudflare_hosts.txt direct_hosts.txt \
           technologies.txt all_urls.txt urls_archive.txt \
           params.txt params_detailed.txt api_endpoints.txt \
           open_ports.txt ffuf_findings.txt \
           js_files.txt js_endpoints.txt js_secrets.txt \
           graphql_endpoints.txt git_exposed.txt env_exposed.txt \
           backup_files.txt security_txt.txt; do
  : > "$_f"
done

# ============================================================
# PHASE 1: SUBDOMAIN ENUMERATION
# ============================================================
phase_banner "1/6" "SUBDOMAIN ENUMERATION"

if [[ "$SKIP_SUBS" -eq 1 ]]; then
  log "Subdomain enumeration skipped (SKIP_SUBS=1)"
else

for _f in amass.tmp assetfinder.tmp subfinder.tmp crtsh.tmp bufferover.tmp hackertarget.tmp; do
  : > "$_f"
done

if command -v amass &>/dev/null; then
  log "amass passive..."
  amass enum -passive -d "$DOMAIN" -norecursive -o amass.tmp 2>/dev/null || true
fi
if command -v assetfinder &>/dev/null; then
  log "assetfinder..."
  assetfinder --subs-only "$DOMAIN" > assetfinder.tmp 2>/dev/null || true
fi
if command -v subfinder &>/dev/null; then
  log "subfinder..."
  subfinder -d "$DOMAIN" -silent -all -o subfinder.tmp 2>/dev/null || true
fi

log "crt.sh..."
curl -s --max-time 30 "https://crt.sh/?q=%25.${DOMAIN}&output=json" \
  | jq -r '.[]|.name_value,.common_name' 2>/dev/null \
  | tr ',' '\n' | sed 's/^\*\.//g' \
  | grep -E "\.${DOMAIN}$" | sort -u > crtsh.tmp 2>/dev/null || true

log "bufferover.run..."
curl -s --max-time 15 "https://dns.bufferover.run/dns?q=.${DOMAIN}" \
  | jq -r 'try (.FDNS_A[],.RDNS[])' 2>/dev/null \
  | cut -d',' -f2 | grep -E "\.${DOMAIN}$" > bufferover.tmp 2>/dev/null || true

log "hackertarget..."
curl -s --max-time 15 "https://api.hackertarget.com/hostsearch/?q=${DOMAIN}" \
  | awk -F, '{print $1}' | grep -E "\.${DOMAIN}$" > hackertarget.tmp 2>/dev/null || true

cat amass.tmp assetfinder.tmp subfinder.tmp crtsh.tmp bufferover.tmp hackertarget.tmp 2>/dev/null \
  | sed 's/^\*\.//g; /^$/d' \
  | grep -E "^[a-zA-Z0-9._-]+$" \
  | sort -u > all_subs.txt

rm -f amass.tmp assetfinder.tmp subfinder.tmp crtsh.tmp bufferover.tmp hackertarget.tmp

SUB_COUNT=$(lc all_subs.txt)
ok "Subdomains found: $SUB_COUNT"
if [[ "$SUB_COUNT" -eq 0 ]]; then
  warn "No subdomains found — adding base domain and continuing..."
  echo "$DOMAIN" > all_subs.txt
fi

fi  # SKIP_SUBS

# ============================================================
# PHASE 2: DNS RESOLUTION + CNAMEs
# ============================================================
phase_banner "2/6" "DNS RESOLUTION + CNAMEs"

if [[ "$SKIP_DNS" -eq 1 ]]; then
  log "DNS resolution skipped (SKIP_DNS=1)"
else

if command -v dnsx &>/dev/null; then
  log "dnsx..."
  dnsx -silent -a -resp -retry 2 -threads 50 \
    -l all_subs.txt 2>/dev/null > dnsx_raw.txt || true
  while IFS= read -r line; do
    local_sub=$(echo "$line" | awk '{print $1}')
    local_ip=$(echo "$line" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    [[ -n "$local_sub" && -n "$local_ip" ]] && echo "$local_sub $local_ip"
  done < dnsx_raw.txt >> resolved.txt 2>/dev/null || true
  rm -f dnsx_raw.txt
else
  warn "dnsx not found — using dig only"
fi

_resolved_hosts() { awk '{print $1}' resolved.txt 2>/dev/null | sort -u; }
sort -u all_subs.txt > _all_sorted.txt

comm -23 _all_sorted.txt <(_resolved_hosts) > _need1.txt 2>/dev/null || cp _all_sorted.txt _need1.txt
if [[ -s _need1.txt ]]; then
  log "dig @8.8.8.8 fallback for $(lc _need1.txt) hosts..."
  xargs -a _need1.txt -n1 -P20 bash -c '
    ip=$(dig +short A "$0" @8.8.8.8 +timeout=4 +tries=2 2>/dev/null \
         | grep -oE "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+" | head -1)
    [[ -n "$ip" ]] && echo "$0 $ip"
  ' >> resolved.txt 2>/dev/null || true
fi

comm -23 _all_sorted.txt <(_resolved_hosts) > _need2.txt 2>/dev/null || true
if [[ -s _need2.txt ]]; then
  log "dig @1.1.1.1 fallback for $(lc _need2.txt) hosts..."
  xargs -a _need2.txt -n1 -P20 bash -c '
    ip=$(dig +short A "$0" @1.1.1.1 +timeout=4 +tries=2 2>/dev/null \
         | grep -oE "^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+" | head -1)
    [[ -n "$ip" ]] && echo "$0 $ip"
  ' >> resolved.txt 2>/dev/null || true
fi

sort -u resolved.txt -o resolved.txt
awk '{print $2}' resolved.txt \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' \
  | sort -u > ips.txt
rm -f _all_sorted.txt _need1.txt _need2.txt

log "Resolving CNAMEs..."
xargs -a all_subs.txt -n1 -P20 bash -c '
  c=$(dig +short CNAME "$0" @8.8.8.8 +timeout=4 +tries=1 2>/dev/null \
      | head -1 | sed "s/\.$//")
  [[ -n "$c" ]] && printf "%s\t%s\n" "$0" "$c"
' >> cnames.txt 2>/dev/null || true

grep -Ei \
  'amazonaws|azure|heroku|github\.io|fastly|pages\.dev|vercel\.app|zendesk|shopify|\
tumblr|wordpress|ghost\.io|readme\.io|bitbucket\.io|surge\.sh|helpscout|\
statuspage\.io|uservoice|pantheon\.io|sendgrid|ngrok|webflow|unbounce' \
  cnames.txt > dangling.txt 2>/dev/null || true

ok "Resolved: $(lc resolved.txt) | IPs: $(lc ips.txt) | CNAMEs: $(lc cnames.txt) | Dangling: $(lc dangling.txt)"

fi  # SKIP_DNS

# ============================================================
# PHASE 3: PORT SCANNING
# ============================================================
phase_banner "3/6" "PORT SCANNING"

if [[ "$SKIP_NMAP" -eq 0 && -s ips.txt ]]; then
  log "Scanning $(lc ips.txt) IPs..."
  PORT_RANGE="-p 21,22,25,53,80,443,445,3306,3389,8080,8443,8888"
  [[ "$DEEP_SCAN" -eq 1 ]] && PORT_RANGE="-p 1-65535"
  nmap -sT -Pn $PORT_RANGE -iL ips.txt --open -T3 \
    --host-timeout 5m --max-retries 2 \
    --min-rtt-timeout 100ms --max-rtt-timeout 2s \
    -oA nmap_scan 2>/dev/null | tee -a "$LOGFILE" || true
  grep -E '^[0-9]+/(tcp|udp).*open' nmap_scan.nmap 2>/dev/null \
    | awk '{print $1}' | sed 's|/[a-z]*||' | sort -u > open_ports.txt || true
  ok "Open ports: $(lc open_ports.txt)"
else
  log "Port scanning skipped (SKIP_NMAP=1 or no IPs)"
fi

# ============================================================
# PHASE 4: HTTP PROBING + CDN DETECTION
# ============================================================
phase_banner "4/6" "HTTP PROBING + CDN DETECTION"

if [[ "$SKIP_HTTP" -eq 1 ]]; then
  log "HTTP probing skipped (SKIP_HTTP=1)"
else

{
  sed 's|^|https://|' all_subs.txt
  sed 's|^|http://|'  all_subs.txt
} > subs_with_scheme.txt

log "Probing $(lc subs_with_scheme.txt) targets..."
httpx -list subs_with_scheme.txt \
  -silent -threads "$THREADS" -no-color -json \
  -timeout 10 -status-code -title -tech-detect -ip \
  -follow-redirects \
  -H "User-Agent: $UA" \
  -o httpx_subs.json 2>/dev/null || true

jq -r 'select(.url != null) | .url' httpx_subs.json 2>/dev/null \
  | sort -u > alive_hosts.txt || true
jq -r 'select(.technologies != null) | .url + " => " + (.technologies | join(", "))' \
  httpx_subs.json 2>/dev/null | sort -u > technologies.txt || true
rm -f subs_with_scheme.txt

# ---- CDN detection using the 'ip' field from httpx JSON ----
# httpx outputs "host" as the hostname and "ip" as the resolved IP
log "Detecting CDN / Cloudflare hosts..."
while IFS= read -r url; do
  # Try 'ip' field first, then 'a' array, then fall back to resolving ourselves
  ip=$(jq -r --arg u "$url" \
    'select(.url==$u) | .ip // (.a // [])[0] // ""' \
    httpx_subs.json 2>/dev/null | head -1)

  # If httpx didn't give us an IP, resolve it ourselves
  if [[ -z "$ip" || "$ip" == "null" ]]; then
    host_only=$(echo "$url" | sed 's|https\?://||; s|/.*||; s|:.*||')
    ip=$(dig +short A "$host_only" @8.8.8.8 +timeout=3 2>/dev/null \
         | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
  fi

  # Match against known Cloudflare IP ranges
  if echo "$ip" | grep -qE \
    '^(104\.(1[6-9]|2[0-9]|3[0-1])\.|172\.(6[4-9]|7[0-1])\.|162\.158\.|198\.41\.(12[89]|1[3-5][0-9])\.|190\.93\.|188\.114\.|197\.234\.|103\.(21\.(24[4-7])\.|22\.(19[2-9]|2[0-3])\.|31\.(12[0-7])\.|))'; then
    echo "$url" >> cloudflare_hosts.txt
  else
    echo "$url" >> direct_hosts.txt
  fi
done < alive_hosts.txt

ok "Alive: $(lc alive_hosts.txt) | Cloudflare: $(lc cloudflare_hosts.txt) | Direct: $(lc direct_hosts.txt) | Tech: $(lc technologies.txt)"

fi  # SKIP_HTTP

# ============================================================
# PHASE 5: URL COLLECTION
# ============================================================
phase_banner "5/6" "URL COLLECTION"

if [[ "$SKIP_URLS" -eq 1 ]]; then
  log "URL collection skipped (SKIP_URLS=1)"
else

log "waybackurls (${WB_TIMEOUT}s/host)..."
while IFS= read -r sub; do
  timeout "$WB_TIMEOUT" waybackurls "$sub" 2>/dev/null >> urls_archive.txt || true
done < all_subs.txt

log "gau (${WB_TIMEOUT}s/host)..."
while IFS= read -r sub; do
  timeout "$WB_TIMEOUT" bash -c \
    "printf '%s\n' \"\$1\" | gau --subs 2>/dev/null" _ "$sub" \
    >> urls_archive.txt || true
done < all_subs.txt

sort -u urls_archive.txt -o urls_archive.txt

if command -v katana &>/dev/null && [[ -s alive_hosts.txt ]]; then
  log "katana active crawl..."
  timeout 300 katana -list alive_hosts.txt -silent -d 3 -jc -kf all \
    -H "User-Agent: $UA" -o urls_katana.txt 2>/dev/null || true
  cat urls_archive.txt urls_katana.txt 2>/dev/null | sort -u > all_urls.txt
else
  cp urls_archive.txt all_urls.txt
fi

ok "URLs collected: $(lc all_urls.txt)"

fi  # SKIP_URLS
# ============================================================
# PHASE 6: PARAMETER EXTRACTION
# ============================================================
phase_banner "6/6" "PARAMETER EXTRACTION"

if [[ "$SKIP_PARAMS" -eq 1 ]]; then
  log "Param extraction skipped (SKIP_PARAMS=1)"
else

grep '?' all_urls.txt 2>/dev/null \
  | sed -n 's/.*?\([^#]*\).*/\1/p' \
  | tr '&' '\n' | sed 's/=.*//' \
  | grep -E '^[a-zA-Z0-9_-]+$' \
  | sort -u > params.txt || true

if grep -q '?' all_urls.txt 2>/dev/null; then
  grep '?' all_urls.txt | while IFS= read -r url; do
    qs=$(echo "$url" | sed -n 's/^[^?]*?\(.*\)$/\1/p' | sed 's/#.*//')
    [[ -z "$qs" ]] && continue
    echo "$qs" | tr '&' '\n' | while IFS= read -r pair; do
      name=${pair%%=*}; value=${pair#*=}
      [[ -n "$name" ]] && printf '%s\t%s\t%s\n' "$name" "$value" "$url"
    done
  done >> params_detailed.txt
  sort -u params_detailed.txt -o params_detailed.txt
fi

grep -iE '\.json($|\?)|/api/|/v[0-9]+/' all_urls.txt 2>/dev/null \
  | sort -u > api_endpoints.txt || true

ok "Unique params: $(lc params.txt) | Detailed: $(lc params_detailed.txt) | API: $(lc api_endpoints.txt)"

fi  # SKIP_PARAMS

# ============================================================
# FINAL SUMMARY
# ============================================================
_log_write ""
_log_write "=================================================="
_log_write "  RECON COMPLETE"
_log_write "  Domain  : $DOMAIN"
_log_write "  Finished: $(date)"
_log_write "  Log     : $OUT/$LOGFILE"
_log_write "=================================================="
_log_write "$(printf "  %-26s %s" "Subdomains:"       "$(lc all_subs.txt)")"
_log_write "$(printf "  %-26s %s" "Resolved:"         "$(lc resolved.txt)")"
_log_write "$(printf "  %-26s %s" "Unique IPs:"       "$(lc ips.txt)")"
_log_write "$(printf "  %-26s %s" "CNAMEs:"           "$(lc cnames.txt)")"
_log_write "$(printf "  %-26s %s" "Dangling CNAMEs:"  "$(lc dangling.txt)")"
_log_write "$(printf "  %-26s %s" "Alive Hosts:"      "$(lc alive_hosts.txt)")"
_log_write "$(printf "  %-26s %s" "Cloudflare Hosts:" "$(lc cloudflare_hosts.txt)")"
_log_write "$(printf "  %-26s %s" "Direct Hosts:"     "$(lc direct_hosts.txt)")"
_log_write "$(printf "  %-26s %s" "URLs Collected:"   "$(lc all_urls.txt)")"
_log_write "$(printf "  %-26s %s" "Unique Params:"    "$(lc params.txt)")"
_log_write "$(printf "  %-26s %s" "API Endpoints:"    "$(lc api_endpoints.txt)")"
_log_write "$(printf "  %-26s %s" "Open Ports:"       "$(lc open_ports.txt)")"
_log_write "$(printf "  %-26s %s" "FFUF Findings:"    "$(lc ffuf_findings.txt)")"
_log_write "$(printf "  %-26s %s" "JS Files:"         "$(lc js_files.txt)")"
_log_write "$(printf "  %-26s %s" "JS Endpoints:"     "$(lc js_endpoints.txt)")"
_log_write "$(printf "  %-26s %s" "JS Secrets:"       "$(lc js_secrets.txt)")"
_log_write "$(printf "  %-26s %s" "GraphQL Endpoints:" "$(lc graphql_endpoints.txt)")"
_log_write "$(printf "  %-26s %s" "Git Exposed:"      "$(lc git_exposed.txt)")"
_log_write "$(printf "  %-26s %s" "Env Exposed:"      "$(lc env_exposed.txt)")"
_log_write "$(printf "  %-26s %s" "Backup Files:"     "$(lc backup_files.txt)")"
_log_write "$(printf "  %-26s %s" "Security.txt:"     "$(lc security_txt.txt)")"
_log_write "=================================================="
_log_write "  Key files:"
_log_write "    $LOGFILE              -- full run log"
_log_write "    cloudflare_hosts.txt  -- CF-protected hosts"
_log_write "    direct_hosts.txt      -- hosts not behind CDN"
_log_write "    dangling.txt          -- takeover candidates"
_log_write "    ffuf_findings.txt     -- fuzzing hits"
_log_write "    js_secrets.txt        -- secrets in JS"
_log_write "    params_detailed.txt   -- params for testing"
_log_write "    technologies.txt      -- tech stack"
_log_write "    alive_hosts.txt       -- all live targets"
_log_write "    arjun_results/        -- discovered params"
_log_write "=================================================="