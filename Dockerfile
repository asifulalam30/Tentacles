# ─────────────────────────────────────────────────────────────────────────────
# TENTACLES v3 — Dockerfile
# Builds a container with Node.js + all security tools pre-installed
# ─────────────────────────────────────────────────────────────────────────────
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV GO_VERSION=1.22.2
ENV GOPATH=/root/go
ENV PATH=$PATH:/usr/local/go/bin:/root/go/bin:/usr/local/bin

# ── System packages ───────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git unzip ca-certificates gnupg jq \
    nmap whois dnsutils \
    python3 python3-pip \
    build-essential libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# ── Python tools (arjun for parameter discovery) ──────────────────────────────
RUN pip3 install --break-system-packages arjun || pip3 install arjun || true

# ── Node.js 20 ────────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Go ────────────────────────────────────────────────────────────────────────
RUN wget -q "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" -O /tmp/go.tar.gz \
    && tar -C /usr/local -xzf /tmp/go.tar.gz \
    && rm /tmp/go.tar.gz

# ── Go-based security tools ───────────────────────────────────────────────────
RUN go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest 2>/dev/null || true
RUN go install -v github.com/projectdiscovery/httpx/cmd/httpx@latest 2>/dev/null || true
RUN go install -v github.com/ffuf/ffuf/v2@latest 2>/dev/null || true
RUN go install -v github.com/projectdiscovery/dnsx/cmd/dnsx@latest 2>/dev/null || true
RUN go install -v github.com/tomnomnom/waybackurls@latest 2>/dev/null || true
RUN go install -v github.com/lc/gau/v2/cmd/gau@latest 2>/dev/null || true
RUN go install -v github.com/projectdiscovery/katana/cmd/katana@latest 2>/dev/null || true
RUN go install -v github.com/tomnomnom/assetfinder@latest 2>/dev/null || true
RUN go install -v github.com/owasp-amass/amass/v4/...@latest 2>/dev/null || true

# Copy Go binaries to /usr/local/bin
RUN cp /root/go/bin/* /usr/local/bin/ 2>/dev/null || true

# ── App setup ─────────────────────────────────────────────────────────────────
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY src/ ./src/
COPY scripts/ ./scripts/
COPY recon/ ./recon/

# ── SecLists (used by retrox-recon.sh fuzzing phase) ──────────────────────────
RUN git clone --depth=1 https://github.com/danielmiessler/SecLists /root/SecLists 2>/dev/null || true

# ── Data directories ──────────────────────────────────────────────────────────
RUN mkdir -p \
    /data/workspace \
    /data/reports \
    /data/scripts \
    /data/recon_output \
    /data/logs

# ── Default wordlist (small, bundled) ─────────────────────────────────────────
RUN mkdir -p /usr/share/wordlists/dirb && \
    curl -sL "https://raw.githubusercontent.com/daviddias/node-dirbuster/master/lists/directory-list-2.3-small.txt" \
    -o /usr/share/wordlists/dirb/common.txt 2>/dev/null || \
    echo "admin\napi\nbackup\nconfig\nlogin\nphpmyadmin\n.env\n.git\ntest\ndev" > /usr/share/wordlists/dirb/common.txt

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:4000/api/health || exit 1

CMD ["node", "src/server.js"]
