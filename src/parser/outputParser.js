'use strict';
/**
 * OUTPUT PARSER  v4.0
 * Every tool that produces security-relevant output has a dedicated parser.
 * Parsers return { summary, structured, findings[] }.
 * Findings are CRITICAL | HIGH | MEDIUM only — LOW/INFO dropped.
 */

const parsers = {

  // ── WHOIS ─────────────────────────────────────────────────────────────────
  whois(output) {
    const lines = output.split('\n');
    const extract = keys => {
      for (const line of lines)
        for (const k of keys)
          if (line.toLowerCase().startsWith(k.toLowerCase()))
            return line.split(':').slice(1).join(':').trim();
      return null;
    };
    const registrar   = extract(['Registrar:', 'registrar:']);
    const created     = extract(['Creation Date', 'Created:', 'created:']);
    const expires     = extract(['Registry Expiry', 'Expiry Date', 'expires:']);
    const nameservers = lines.filter(l => /name.?server/i.test(l)).map(l => l.split(':').slice(1).join(':').trim()).filter(Boolean);
    const org         = extract(['Registrant Organization', 'org:']);
    const findings    = [];
    if (expires) {
      const daysLeft = Math.floor((new Date(expires) - Date.now()) / 86400000);
      if (!isNaN(daysLeft) && daysLeft < 30)
        findings.push({ severity: 'MEDIUM', text: `Domain expires in ${daysLeft} days` });
    }
    return { summary: `Registrar: ${registrar||'?'} | Expires: ${expires||'?'}`, structured: { registrar, created, expires, nameservers, org }, findings };
  },

  // ── DIG ───────────────────────────────────────────────────────────────────
  dig_any(output) {
    const records = [];
    for (const line of output.split('\n')) {
      const m = line.match(/^(\S+)\s+\d+\s+IN\s+(\w+)\s+(.+)$/);
      if (m) records.push({ name: m[1], type: m[2], value: m[3].trim() });
    }
    const findings = [];
    if (!records.find(r => r.type === 'TXT' && r.value.includes('v=spf1')))
      findings.push({ severity: 'MEDIUM', text: 'No SPF record — email spoofing possible' });
    const cnames = records.filter(r => r.type === 'CNAME');
    return { summary: `${records.length} DNS records`, structured: { records, cnames }, findings };
  },

  // ── NMAP ──────────────────────────────────────────────────────────────────
  nmap_quick(output)   { return parseNmapOutput(output); },
  nmap_service(output) { return parseNmapOutput(output); },
  nmap_vuln(output) {
    const base = parseNmapOutput(output);
    const cves = [...output.matchAll(/CVE-(\d{4}-\d+)/g)].map(m => `CVE-${m[1]}`);
    if (cves.length) {
      base.findings.push({ severity: 'HIGH', text: `Nmap NSE CVEs: ${[...new Set(cves)].slice(0,5).join(', ')}` });
      base.structured.cves = [...new Set(cves)];
    }
    return base;
  },

  // ── HTTP HEADERS ──────────────────────────────────────────────────────────
  curl_headers(output) {
    const headers = {};
    for (const line of output.split('\n')) {
      const m = line.match(/^([^:]+):\s*(.+)$/);
      if (m) headers[m[1].trim().toLowerCase()] = m[2].trim();
    }
    const findings = [];
    if (headers['server'] && /\d/.test(headers['server']))
      findings.push({ severity: 'MEDIUM', text: `Server version disclosed: ${headers['server']}` });
    if (headers['x-powered-by'] && /\d/.test(headers['x-powered-by']))
      findings.push({ severity: 'MEDIUM', text: `Tech stack disclosed: ${headers['x-powered-by']}` });
    if (headers['access-control-allow-origin'] === '*' && /true/i.test(headers['access-control-allow-credentials'] || ''))
      findings.push({ severity: 'CRITICAL', text: 'CORS: wildcard origin + credentials=true' });
    if (!headers['content-security-policy'] && headers['content-type']?.includes('html'))
      findings.push({ severity: 'MEDIUM', text: 'Missing Content-Security-Policy header' });
    return { summary: `${output.split('\n')[0]} | ${Object.keys(headers).length} headers`, structured: { headers }, findings };
  },

  // ── HTTP BODY + HEADERS ───────────────────────────────────────────────────
  curl_body(output) {
    const lines = output.split('\n');
    const hdrEnd = output.indexOf('\n\n');
    const headerSection = hdrEnd > -1 ? output.slice(0, hdrEnd) : output.slice(0, 800);
    const body = hdrEnd > -1 ? output.slice(hdrEnd + 2) : '';
    const headers = {};
    for (const line of headerSection.split('\n')) {
      const m = line.match(/^([^:]+):\s*(.+)$/);
      if (m) headers[m[1].trim().toLowerCase()] = m[2].trim();
    }
    const findings = [];
    if (headers['access-control-allow-origin'] === '*' && /true/i.test(headers['access-control-allow-credentials'] || ''))
      findings.push({ severity: 'CRITICAL', text: 'CORS: wildcard origin + credentials=true' });
    if (headers['server'] && /\d/.test(headers['server']))
      findings.push({ severity: 'MEDIUM', text: `Server version: ${headers['server']}` });
    if (headers['x-powered-by'] && /\d/.test(headers['x-powered-by']))
      findings.push({ severity: 'MEDIUM', text: `Tech stack: ${headers['x-powered-by']}` });
    if (body.length > 1) {
      if (/password_hash|password_digest|hashed_password/i.test(body))
        findings.push({ severity: 'CRITICAL', text: 'Password hash in API response', evidence: body.slice(0,300) });
      if (/["']?is_?admin["']?\s*:\s*true|["']?role["']?\s*:\s*["']admin/i.test(body))
        findings.push({ severity: 'HIGH', text: 'Admin flag in API response — attempt privilege escalation' });
      if (/api[_-]?key["']?\s*:\s*["'][A-Za-z0-9_\-]{16,}/i.test(body))
        findings.push({ severity: 'CRITICAL', text: 'API key or token in response body' });
      if (/\bssn\b|social.?security|credit.?card|card_number|cvv/i.test(body))
        findings.push({ severity: 'CRITICAL', text: 'PII or financial data in response body' });
      if ((body.match(/"id"\s*:\s*\d+/g) || []).length > 3)
        findings.push({ severity: 'MEDIUM', text: 'Multiple user IDs in response — enumerate for IDOR' });
    }
    const statusLine = lines[0] || '';
    return {
      summary: `${statusLine.slice(0,40)} | ${Object.keys(headers).length} hdr | ${findings.length} finding(s)`,
      structured: { headers, statusLine, bodyLength: body.length },
      findings,
    };
  },

  // ── DIRECTORY FUZZING ─────────────────────────────────────────────────────
  ffuf_dirs(output)          { return parseFfufOutput(output); },
  ffuf_params(output)        { return parseFfufOutput(output); },
  ffuf_params_post(output)   { return parseFfufOutput(output); },

  // ── SUBFINDER ─────────────────────────────────────────────────────────────
  subfinder(output) {
    // Strip ANSI color codes that subfinder may emit
    const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
    const subs = clean.split('\n')
      .map(l => l.trim())
      .filter(l => l && l.includes('.') && !l.includes(' ') && !l.startsWith('#') && /^[a-z0-9._-]+$/i.test(l));
    const uniq = [...new Set(subs)];
    const interesting = uniq.filter(s => /admin|internal|dev|stage|test|vpn|mail|api|beta|corp|old|legacy|backup|sit\d|uat|pet\d|qa/i.test(s));
    return {
      summary: `${uniq.length} subdomains | ${interesting.length} interesting`,
      // Return BOTH 'subs' (legacy) and 'subdomains' (what reconRunner reads).
      // Was: only 'subs' — reconRunner.subdomains stayed undefined and always
      // fell back to [target] only. Discovered subdomains were dropped on the floor.
      structured: { subs: uniq, subdomains: uniq, interesting },
      findings: interesting.length ? [{ severity: 'MEDIUM', text: `Interesting subdomains: ${interesting.slice(0,5).join(', ')}` }] : [],
    };
  },

  // ── HTTPX ─────────────────────────────────────────────────────────────────
  httpx_probe(output) {
    // Strip ANSI color codes (httpx outputs them with -no-color sometimes ignored)
    const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
    // Extract HTTP/HTTPS URLs and their status + tech
    const hosts = [];
    const technologies = new Set();
    for (const line of clean.split('\n')) {
      const m = line.trim().match(/^(https?:\/\/[^\s\[]+)/);
      if (!m) continue;
      const url = m[1];
      const sm = line.match(/\[(\d{3})\]/);
      const status = sm ? sm[1] : '';
      const techMatch = line.match(/\[([A-Za-z][A-Za-z0-9 ,/.-]*)\]/g) || [];
      const techs = techMatch.flatMap(t => t.replace(/[\[\]]/g,'').split(',').map(x=>x.trim()))
                             .filter(t => t && !/^\d+$/.test(t));
      techs.forEach(t => technologies.add(t));
      hosts.push({ url, status, tech: techs });
    }
    const alive = hosts.map(h => h.url); // legacy field
    return {
      summary: `${hosts.length} alive hosts`,
      // hosts: array of {url, status, tech} — what reconRunner reads
      // alive: legacy plain-URL list — kept for compatibility
      structured: { hosts, alive, technologies: [...technologies] },
      findings: []
    };
  },

  // ── NUCLEI ────────────────────────────────────────────────────────────────
  nuclei_scan(output) {
    const vulns = [];
    for (const line of output.split('\n').filter(Boolean)) {
      // Format 1: JSON output (nuclei -json)
      try {
        const j = JSON.parse(line);
        if (j.info) {
          const sev = j.info.severity?.toUpperCase();
          if (sev === 'LOW' || sev === 'INFO') continue;
          vulns.push({ template: j['template-id'], severity: sev || 'MEDIUM', name: j.info.name, url: j.matched || j.host });
          continue;
        }
      } catch {}
      // Format 2: plain text  [severity] [template-id] [type] url
      const sevM = line.match(/\[(critical|high|medium)\]/i);
      if (!sevM) continue;
      const sev  = sevM[1].toUpperCase();
      const url  = line.match(/https?:\/\/[^\s\]]+/)?.[0] || '';
      const tmpl = (line.match(/\[([a-z0-9_:-]{3,60})\]/gi) || []).slice(1, 3).join(' ');
      vulns.push({ template: tmpl, severity: sev, name: tmpl || line.slice(0, 60), url });
    }
    const findings = vulns.map(v => ({
      severity: v.severity,
      text: `Nuclei ${v.severity}: ${v.name || v.template} at ${v.url}`.slice(0, 160),
      evidence: v.url,
    }));
    return { summary: `Nuclei: ${vulns.length} finding(s)`, structured: { vulns }, findings };
  },
  nuclei(output) { return parsers.nuclei_scan(output); },

  // ── SQLMAP ────────────────────────────────────────────────────────────────
  sqlmap_test(output) {
    const findings = [];
    if (/sqlmap identified the following injection/i.test(output)) {
      const param = output.match(/Parameter: (\S+)/)?.[1] || '?';
      const type  = output.match(/Type: (.+)/)?.[1] || '?';
      const db    = output.match(/back-end DBMS: (.+)/)?.[1] || '?';
      findings.push({ severity: 'CRITICAL', text: `SQLi confirmed — param: ${param}, type: ${type}, DBMS: ${db}` });
    }
    const databases = [...output.matchAll(/\[\*\] (\w+)/g)].map(m => m[1]).filter(d => !['starting','ending'].includes(d));
    return { summary: `SQLMap: ${findings.length} injection(s)${databases.length ? ` | DBs: ${databases.join(', ')}` : ''}`, structured: { databases }, findings };
  },

  // ── WHATWEB ───────────────────────────────────────────────────────────────
  whatweb(output) {
    const technologies = [];
    for (const m of output.matchAll(/(\w[\w\s]+)\[([^\]]+)\]/g))
      technologies.push({ name: m[1].trim(), detail: m[2] });
    return { summary: `${technologies.length} technologies`, structured: { technologies }, findings: [] };
  },

  // ── ZONE TRANSFER ─────────────────────────────────────────────────────────
  dig_axfr(output) {
    const records = output.split('\n').filter(l => l.match(/\s+IN\s+/));
    const findings = records.length > 10 ? [{ severity: 'HIGH', text: `DNS Zone Transfer SUCCESS — ${records.length} records` }] : [];
    return { summary: records.length > 10 ? `AXFR SUCCESS: ${records.length} records` : 'AXFR refused', structured: { records }, findings };
  },

  // ── GOBUSTER ──────────────────────────────────────────────────────────────
  gobuster(output) {
    const paths = output.split('\n').filter(l => l.match(/^\//) || l.match(/Status:/));
    const interesting = paths.filter(p => /admin|backup|config|\.env|\.git|db|sql|upload/i.test(p));
    const findings = interesting.length ? [{ severity: 'HIGH', text: `Sensitive paths: ${interesting.slice(0,5).join(', ')}` }] : [];
    return { summary: `${paths.length} paths`, structured: { paths, interesting }, findings };
  },

  // ── DALFOX XSS ────────────────────────────────────────────────────────────
  dalfox_scan(output) {
    const vulnLines = output.split('\n').filter(l => l.includes('[V]') || l.includes('VULN'));
    const findings = vulnLines.map(line => ({
      severity: 'HIGH',
      text: `XSS confirmed by dalfox: ${line.slice(0,120)}`,
    }));
    return { summary: `Dalfox: ${vulnLines.length} XSS`, structured: { vulnLines }, findings };
  },

  // ── CORS TEST ─────────────────────────────────────────────────────────────
  cors_test(output) {
    const findings = [];
    for (const line of output.split('\n')) {
      if (/CORS CRITICAL|Wildcard.*Credentials/i.test(line))
        findings.push({ severity: 'CRITICAL', text: 'CORS: wildcard + credentials=true' });
      else if (/CORS VULN|evil\.com.*allow-origin/i.test(line))
        findings.push({ severity: 'HIGH', text: `CORS misconfiguration: ${line.trim().slice(0,120)}` });
    }
    return { summary: `CORS: ${findings.length} issue(s)`, structured: {}, findings };
  },

  // ── JWT ───────────────────────────────────────────────────────────────────
  jwt_analyze(output) {
    const findings = [];
    if (/"alg"\s*:\s*"none"/i.test(output))
      findings.push({ severity: 'CRITICAL', text: 'JWT alg:none — signature not verified' });
    const alg = output.match(/"alg"\s*:\s*"([^"]+)"/)?.[1] || 'unknown';
    if (['HS256','HS384','HS512'].includes(alg))
      findings.push({ severity: 'MEDIUM', text: `JWT symmetric alg ${alg} — key confusion possible` });
    return { summary: `JWT: alg=${alg} | ${findings.length} issue(s)`, structured: { alg }, findings };
  },

  // ── GRAPHQL ───────────────────────────────────────────────────────────────
  graphql_test(output) {
    const findings = [];
    if (output.includes('__schema') || output.includes('"types"'))
      findings.push({ severity: 'MEDIUM', text: 'GraphQL introspection enabled — full schema exposed' });
    const mutations = (output.match(/mutation/gi) || []).length;
    if (mutations > 5) findings.push({ severity: 'MEDIUM', text: `${mutations} mutations in schema — test auth on each` });
    return { summary: `GraphQL: introspection=${output.includes('__schema')}`, structured: {}, findings };
  },

  // ── SSRF ──────────────────────────────────────────────────────────────────
  ssrf_test(output) {
    const findings = [];
    if (/ami-id|instance-id|iam\/security-credentials|meta-data/i.test(output))
      findings.push({ severity: 'CRITICAL', text: 'SSRF confirmed — cloud metadata accessible' });
    else if (output.length > 100 && !/error|invalid|not found/i.test(output))
      findings.push({ severity: 'HIGH', text: 'SSRF possible — internal URL returned content' });
    return { summary: `SSRF: ${output.length}b`, structured: {}, findings };
  },

  // ── WAF DETECT ────────────────────────────────────────────────────────────
  waf_detect(output) {
    const wafs = [
      { re: /cloudflare/i, name: 'Cloudflare' }, { re: /incapsula|imperva/i, name: 'Imperva' },
      { re: /akamai/i, name: 'Akamai' },          { re: /sucuri/i, name: 'Sucuri' },
      { re: /fastly/i, name: 'Fastly' },           { re: /aws.*waf/i, name: 'AWS WAF' },
    ].filter(w => w.re.test(output)).map(w => w.name);
    const findings = wafs.length ? [{ severity: 'MEDIUM', text: `WAF detected: ${wafs.join(', ')} — use encoded payloads` }] : [];
    return { summary: `WAF: ${wafs.length ? wafs.join(', ') : 'not detected'}`, structured: { wafs }, findings };
  },

  // ── PROTOTYPE POLLUTION ───────────────────────────────────────────────────
  prototype_test(output) {
    const findings = [];
    if (/polluted|__proto__|prototype.*modified/i.test(output))
      findings.push({ severity: 'HIGH', text: 'Prototype pollution confirmed' });
    return { summary: `Prototype: ${output.length}b`, structured: {}, findings };
  },

  // ── CRLF ──────────────────────────────────────────────────────────────────
  crlf_test(output) {
    const findings = [];
    if (/X-Injected|crlfinjected|Set-Cookie.*crlf/i.test(output))
      findings.push({ severity: 'HIGH', text: 'CRLF injection confirmed — response header injection' });
    return { summary: `CRLF: ${output.length}b`, structured: {}, findings };
  },

  // ── CACHE POISONING ───────────────────────────────────────────────────────
  cache_poison_test(output) {
    const findings = [];
    if (/cachebust|sentinel.*cache|unkeyed.*reflected/i.test(output))
      findings.push({ severity: 'HIGH', text: 'Cache poisoning — unkeyed header reflected' });
    return { summary: `Cache: ${output.length}b`, structured: {}, findings };
  },

  // ── MASS ASSIGNMENT ───────────────────────────────────────────────────────
  mass_assign_test(output) {
    const findings = [];
    if (/"is_admin"\s*:\s*true|"role"\s*:\s*"admin"|"admin"\s*:\s*true/i.test(output))
      findings.push({ severity: 'HIGH', text: 'Mass assignment confirmed — privilege field accepted' });
    return { summary: `Mass assign: ${output.length}b`, structured: {}, findings };
  },

  // ── RACE CONDITION ────────────────────────────────────────────────────────
  race_test(output) {
    const codes = (output.match(/HTTP[/ ]\d+ (\d+)|status[": ]+(\d+)/gi) || [])
      .map(s => parseInt(s.match(/\d{3}/)[0]));
    const success = codes.filter(c => c >= 200 && c < 300).length;
    const findings = success > 1 ? [{ severity: 'HIGH', text: `Race condition: ${success}/${codes.length} parallel requests succeeded` }] : [];
    return { summary: `Race: ${success}/${codes.length} succeeded`, structured: { codes }, findings };
  },

  // ── OOB ───────────────────────────────────────────────────────────────────
  oob_payload_gen(output) {
    const findings = [];
    if (/callback|interaction|dns.*query/i.test(output))
      findings.push({ severity: 'CRITICAL', text: 'OOB interaction received — blind injection confirmed' });
    return { summary: `OOB: ${output.length}b`, structured: {}, findings };
  },

  // ── SUBDOMAIN TAKEOVER ────────────────────────────────────────────────────
  takeover_check(output) {
    const findings = [];
    if (/TAKEOVER POSSIBLE/i.test(output))
      findings.push({ severity: 'HIGH', text: `Subdomain takeover: ${output.match(/TAKEOVER POSSIBLE: (.+)/)?.[1] || 'fingerprint matched'}` });
    const cname = output.match(/CNAME: (\S+)/)?.[1];
    return { summary: `Takeover: ${findings.length ? 'VULNERABLE' : 'safe'} | CNAME: ${cname||'none'}`, structured: { cname }, findings };
  },

  // ── KATANA CRAWL ──────────────────────────────────────────────────────────
  katana_crawl(output) {
    const urls = output.split('\n').filter(l => l.startsWith('http'));
    const interesting = urls.filter(u => /admin|api|graphql|swagger|debug|config|backup|\.env|internal/i.test(u));
    const findings = interesting.length ? [{ severity: 'MEDIUM', text: `Interesting crawled URLs: ${interesting.slice(0,3).join(', ')}` }] : [];
    return { summary: `Crawled ${urls.length} URLs | ${interesting.length} interesting`, structured: { urls, interesting }, findings };
  },

  // ── STORED XSS ────────────────────────────────────────────────────────────
  stored_xss_probe(output) {
    const findings = [];
    if (/200|201|202/.test(output.split('\n')[0]))
      findings.push({ severity: 'MEDIUM', text: 'XSS payload submitted — verify it renders in other views' });
    return { summary: `Stored XSS probe: ${output.slice(0,50)}`, structured: {}, findings };
  },

  // ── PARAM MINER ───────────────────────────────────────────────────────────
  param_miner(output) {
    const findings = [];
    if (/evil\.com/i.test(output))
      findings.push({ severity: 'HIGH', text: 'Header injection — unkeyed header reflects attacker value' });
    return { summary: `Param miner: ${output.length}b`, structured: {}, findings };
  },

  // ── HTTP SMUGGLING ────────────────────────────────────────────────────────
  smuggling_test(output) {
    const findings = [];
    if (/CL\.TE|TE\.CL|timeout|unexpected response|desync/i.test(output))
      findings.push({ severity: 'HIGH', text: 'HTTP request smuggling candidate — desync detected' });
    return { summary: `Smuggling: ${output.length}b`, structured: {}, findings };
  },

  // ── API DISCOVER ──────────────────────────────────────────────────────────
  api_discover(output) {
    const exposed = output.split('\n').filter(l => /\[200\]/.test(l));
    const sensitive = exposed.filter(l => /actuator|env|config|debug|swagger|graphql|admin/i.test(l));
    const findings = sensitive.length ? [{ severity: 'HIGH', text: `Sensitive API endpoints: ${sensitive.slice(0,3).join(', ')}` }] : [];
    return { summary: `API discovery: ${exposed.length} live`, structured: { exposed, sensitive }, findings };
  },

  // ── OAUTH ─────────────────────────────────────────────────────────────────
  oauth_test(output) {
    const findings = [];
    if (/\[200\].*oauth|authorize|token/i.test(output))
      findings.push({ severity: 'MEDIUM', text: 'OAuth endpoints found — test state param, redirect_uri, token leakage' });
    return { summary: `OAuth: ${output.length}b`, structured: {}, findings };
  },
  oauth_flow_test(output) {
    const findings = [];
    if (/missing.*state|no.*state.*param/i.test(output)) findings.push({ severity: 'HIGH', text: 'OAuth missing state — CSRF possible' });
    if (/redirect_uri.*bypass/i.test(output)) findings.push({ severity: 'CRITICAL', text: 'OAuth redirect_uri bypass — code theft possible' });
    if (/pkce.*not.*enforced/i.test(output)) findings.push({ severity: 'MEDIUM', text: 'OAuth PKCE not enforced' });
    return { summary: `OAuth flow: ${findings.length} issue(s)`, structured: {}, findings };
  },

  // ── SSTI ──────────────────────────────────────────────────────────────────
  ssti_test(output) {
    const findings = [];
    if (/\b49\b/.test(output)) findings.push({ severity: 'CRITICAL', text: 'SSTI confirmed — 7*7=49 reflected' });
    if (/TemplateSyntaxError|jinja.*error|twig.*error|freemarker.*error/i.test(output))
      findings.push({ severity: 'HIGH', text: 'Template engine error — SSTI surface confirmed' });
    return { summary: `SSTI: ${findings.length} finding(s)`, structured: {}, findings };
  },

  // ── FILE UPLOAD ───────────────────────────────────────────────────────────
  file_upload_test(output) {
    const findings = [];
    if (/uid=\d+|root:|www-data/i.test(output))
      findings.push({ severity: 'CRITICAL', text: 'File upload RCE — webshell executed' });
    else if (/success|uploaded|\.php|location.*\.php/i.test(output) && !/error|rejected/i.test(output))
      findings.push({ severity: 'HIGH', text: 'Malicious file upload accepted' });
    return { summary: `Upload: ${findings.length} finding(s)`, structured: {}, findings };
  },

  // ── NOSQL ─────────────────────────────────────────────────────────────────
  nosql_test(output) {
    const findings = [];
    if (/token|dashboard|welcome.*back|login.*success/i.test(output) && !/error|invalid/i.test(output.slice(0,200)))
      findings.push({ severity: 'CRITICAL', text: 'NoSQL injection — auth bypass confirmed' });
    return { summary: `NoSQL: ${findings.length} finding(s)`, structured: {}, findings };
  },

  // ── PASSWORD RESET ────────────────────────────────────────────────────────
  password_reset_test(output) {
    const findings = [];
    if (/success|sent|email.*reset/i.test(output) && !/error/i.test(output.slice(0,200)))
      findings.push({ severity: 'HIGH', text: 'Password reset accepted attacker host header' });
    return { summary: `PwdReset: ${findings.length} finding(s)`, structured: {}, findings };
  },

  // ── MFA BYPASS ────────────────────────────────────────────────────────────
  mfa_bypass_test(output) {
    const findings = [];
    if (/success|token|dashboard/i.test(output) && !/invalid|error|incorrect/i.test(output.slice(0,200)))
      findings.push({ severity: 'CRITICAL', text: 'MFA bypass confirmed' });
    return { summary: `MFA: ${findings.length} finding(s)`, structured: {}, findings };
  },

  // ── XXE ───────────────────────────────────────────────────────────────────
  xxe_test(output) {
    const findings = [];
    if (/root:.*:0:0|etc\/passwd|daemon:|www-data:/i.test(output))
      findings.push({ severity: 'CRITICAL', text: 'XXE confirmed — /etc/passwd in response' });
    else if (/ami-id|instance-id|iam\/security-credentials/i.test(output))
      findings.push({ severity: 'CRITICAL', text: 'XXE SSRF — cloud metadata accessible' });
    return { summary: `XXE: ${findings.length} finding(s)`, structured: {}, findings };
  },

  // ── DESERIALIZATION ───────────────────────────────────────────────────────
  deserialization_test(output) {
    const findings = [];
    if (/ClassNotFoundException|InvalidClassException|readObject/i.test(output))
      findings.push({ severity: 'CRITICAL', text: 'Java deserialization triggered' });
    if (/unserialize|__wakeup|__destruct/i.test(output))
      findings.push({ severity: 'CRITICAL', text: 'PHP object injection triggered' });
    return { summary: `Deser: ${findings.length} finding(s)`, structured: {}, findings };
  },

  // ── BUSINESS LOGIC ────────────────────────────────────────────────────────
  balance_test(output) {
    const ok = /200|201|success/i.test(output) && !/error|invalid|must.*positive/i.test(output.slice(0,300));
    const findings = ok ? [{ severity: 'HIGH', text: 'Negative financial value accepted — balance manipulation possible' }] : [];
    return { summary: `Balance: ${findings.length} finding(s)`, structured: {}, findings };
  },
  referral_test(output) {
    const ok = /success|bonus|credit|reward/i.test(output) && !/invalid|expired|already.*used/i.test(output.slice(0,300));
    const findings = ok ? [{ severity: 'HIGH', text: 'Referral code accepted — test for self-referral and reuse' }] : [];
    return { summary: `Referral: ${findings.length} finding(s)`, structured: {}, findings };
  },
  enumeration_test(output) {
    const findings = [];
    if (/wrong.*password|invalid.*password|incorrect.*password/i.test(output))
      findings.push({ severity: 'MEDIUM', text: 'Account enumeration — response distinguishes valid vs invalid' });
    return { summary: `Enumeration: ${findings.length} signal(s)`, structured: {}, findings };
  },
  state_machine_test(output) {
    const ok = /success|updated|200|201/i.test(output) && !/invalid.*status|cannot.*transition/i.test(output.slice(0,300));
    const findings = ok ? [{ severity: 'HIGH', text: 'Invalid state transition accepted' }] : [];
    return { summary: `State machine: ${findings.length} finding(s)`, structured: {}, findings };
  },
  import_test(output) {
    const findings = [];
    if (/ami-id|instance-id|169\.254/i.test(output))
      findings.push({ severity: 'CRITICAL', text: 'SSRF via import — cloud metadata accessible' });
    return { summary: `Import: ${findings.length} finding(s)`, structured: {}, findings };
  },
  excessive_data_test(output) {
    const sensitiveFields = ['password','password_hash','salt','token_secret','credit_card','ssn','api_key','private_key','webhook_secret'];
    const found = sensitiveFields.filter(f => new RegExp(`["']?${f}["']?\\s*:`).test((output||'').toLowerCase()));
    const findings = found.length ? [{ severity: found.some(f => ['password','password_hash','credit_card','ssn'].includes(f)) ? 'HIGH' : 'MEDIUM', text: `Excessive data: ${found.slice(0,4).join(', ')} in response` }] : [];
    return { summary: `Data exposure: ${found.length} sensitive field(s)`, structured: { found }, findings };
  },
  toctou_test(output) {
    const successes = (output.match(/success|order.*created|payment.*ok|confirmed/gi) || []).length;
    const findings = successes > 1 ? [{ severity: 'HIGH', text: `TOCTOU race: ${successes} simultaneous transactions succeeded` }] : [];
    return { summary: `TOCTOU: ${successes} success(es)`, structured: { successes }, findings };
  },

  // ── OTHER TESTS ───────────────────────────────────────────────────────────
  ldap_test(output) {
    const findings = [];
    if (/token|session|dashboard|welcome/i.test(output) && !/invalid|error/i.test(output.slice(0,200)))
      findings.push({ severity: 'CRITICAL', text: 'LDAP injection — auth bypass confirmed' });
    return { summary: `LDAP: ${findings.length} finding(s)`, structured: {}, findings };
  },
  xpath_test(output) {
    const findings = [];
    if (/token|session|success/i.test(output) && !/error|invalid/i.test(output.slice(0,200)))
      findings.push({ severity: 'CRITICAL', text: 'XPath injection — auth bypass confirmed' });
    return { summary: `XPath: ${findings.length} finding(s)`, structured: {}, findings };
  },
  websocket_test(output) {
    const findings = [];
    if (/101|switching protocols/i.test(output))
      findings.push({ severity: 'HIGH', text: 'WebSocket upgrade accepted — test for auth bypass and CSWSH' });
    return { summary: `WebSocket: ${findings.length} finding(s)`, structured: {}, findings };
  },
  cookie_test(output) {
    const findings = [];
    if (/set-cookie/i.test(output) && !/httponly/i.test(output))
      findings.push({ severity: 'MEDIUM', text: 'Session cookie missing HttpOnly — XSS can steal session' });
    if (/samesite=none/i.test(output) && !/secure/i.test(output))
      findings.push({ severity: 'HIGH', text: 'SameSite=None without Secure — CSRF possible' });
    return { summary: `Cookie: ${findings.length} issue(s)`, structured: {}, findings };
  },
  dep_confusion_test(output) {
    const findings = [];
    if (/squattable|not.*found.*registry/i.test(output))
      findings.push({ severity: 'CRITICAL', text: 'Dependency confusion — internal package squattable on public registry' });
    return { summary: `DepConfusion: ${findings.length} finding(s)`, structured: {}, findings };
  },
  http_verb_override(output) {
    const findings = [];
    if (/200|204|deleted|removed/i.test(output))
      findings.push({ severity: 'HIGH', text: 'HTTP verb override accepted — restricted method bypassed' });
    return { summary: `Verb override: ${findings.length} finding(s)`, structured: {}, findings };
  },
  server_prototype_test(output) {
    const findings = [];
    if (/"polluted"\s*:\s*"yes"|__proto__.*accepted/i.test(output))
      findings.push({ severity: 'HIGH', text: 'Server-side prototype pollution confirmed' });
    return { summary: `Prototype pollution: ${findings.length} finding(s)`, structured: {}, findings };
  },

  // ── CRAWLERS / HISTORY ────────────────────────────────────────────────────
  waybackurls(output) { return parseUrlList(output); },
  gau(output)         { return parseUrlList(output); },
  arjun(output) {
    const paramList = output.split('\n').filter(l => l.includes('- ')).map(l => l.replace('- ','').trim());
    const findings = paramList.length ? [{ severity: 'MEDIUM', text: `Arjun found hidden params: ${paramList.slice(0,5).join(', ')}` }] : [];
    return { summary: `Arjun: ${paramList.length} params`, structured: { params: paramList }, findings };
  },

  // ── USER SCRIPT ───────────────────────────────────────────────────────────
  run_user_script(output) {
    const findings = [];
    for (const line of output.split('\n')) {
      const m = line.match(/\[(CRITICAL|HIGH|MEDIUM)\]\s*(.+)/i);
      if (m) findings.push({ severity: m[1].toUpperCase(), text: m[2].trim() });
    }
    return { summary: `User script: ${output.length}b | ${findings.length} finding(s)`, structured: {}, findings };
  },

  // ── JS ANALYSIS ───────────────────────────────────────────────────────────
  js_analysis(output) {
    const findings = [];
    let structured = {};
    try {
      const jsonMatch = output.match(/[{][\s\S]*"all_endpoints"[\s\S]*[}]/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        structured = data;
        // Endpoints
        const eps = data.all_endpoints || [];
        if (eps.length > 0)
          findings.push({ severity: 'MEDIUM', text: `JS analysis: ${eps.length} API endpoints found: ${eps.slice(0,5).join(', ')}${eps.length>5?'...':''}`, evidence: eps.join('\n') });
        // Routes (React/Vue router)
        const routes = data.all_routes || [];
        if (routes.length > 0)
          findings.push({ severity: 'MEDIUM', text: `JS routes discovered: ${routes.slice(0,5).join(', ')}${routes.length>5?'...':''}`, evidence: routes.join('\n') });
        // Secrets
        for (const s of (data.all_secrets || []))
          findings.push({ severity: 'CRITICAL', text: `Hardcoded ${s.type} in JS: ${(s.value||'').slice(0,50)}`, evidence: JSON.stringify(s) });
        // Internal URLs
        if ((data.internal_urls || []).length > 0)
          findings.push({ severity: 'HIGH', text: `Internal URLs in JS: ${(data.internal_urls||[]).slice(0,3).join(', ')}` });
        // Admin flags
        const adminFlags = (data.all_flags || []).filter(f => /admin|super|staff|bypass|debug/i.test(f));
        if (adminFlags.length > 0)
          findings.push({ severity: 'MEDIUM', text: `Admin/bypass flags in JS code: ${adminFlags.slice(0,4).join(', ')}` });
        // Inline config
        for (const cfg of (data.config_snippets || []).slice(0, 2))
          findings.push({ severity: 'MEDIUM', text: `Inline app config found in JS: ${cfg.slice(0,100)}` });
      }
    } catch {}
    // Also run generic secret scan on raw output
    const base = parseSensitiveFileOutput(output);
    findings.push(...base.findings);
    return {
      summary: `JS analysis: ${structured.all_endpoints?.length||0} endpoints, ${structured.all_routes?.length||0} routes, ${structured.all_secrets?.length||0} secrets, ${structured.js_files_found?.length||0} JS files`,
      structured,
      findings: findings.filter((f,i,a) => a.findIndex(x=>x.text===f.text)===i),
    };
  },

  // ── SPINEL REFLECTION ─────────────────────────────────────────────────────
  spinel_reflection(output) { return parseSpinelOutput(output); },

  // ── SHELL / BASH / SCRIPTS ────────────────────────────────────────────────
  shell(output)         { return parseShellOutput(output); },
  bash_command(output)  { return parseShellOutput(output); },
  script(output)        { return parseShellOutput(output); },
  write_and_run(output) { return parseShellOutput(output); },
  python_run(output)    { return parseShellOutput(output); },

  // ── EXPLOIT ───────────────────────────────────────────────────────────────
  curl_exploit(output)  { return parseExploitOutput(output); },
  exec_script(output)   { return parseExploitOutput(output); },
  debug_script(output)  { return parseExploitOutput(output); },
  write_script(output)  { return { summary: 'Script written', structured: {}, findings: [] }; },

  // ── INSTALL ───────────────────────────────────────────────────────────────
  install_tool(output)  { return parseInstallOutput(output); },

  // ── FILE READS ────────────────────────────────────────────────────────────
  read_file(output)     { return parseSensitiveFileOutput(output); },
  read_vps_file(output) { return parseSensitiveFileOutput(output); },
  list_vps_dir(output)  { return { summary: `Directory: ${output.split('\n').length} entries`, structured: {}, findings: [] }; },
};

// ── Shared helpers ────────────────────────────────────────────────────────────

function parseNmapOutput(output) {
  const ports = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^(\d+)\/(tcp|udp)\s+(open|filtered)\s+(\S+)(?:\s+(.+))?$/);
    if (m) ports.push({ port: parseInt(m[1]), proto: m[2], state: m[3], service: m[4], version: m[5]?.trim() || '' });
  }
  const DANGER = { 21:'FTP cleartext',23:'Telnet cleartext',3306:'MySQL exposed',5432:'PostgreSQL exposed',27017:'MongoDB unauthenticated',6379:'Redis unauthenticated',9200:'Elasticsearch open',445:'SMB',3389:'RDP brute-force',5900:'VNC exposed',2375:'Docker API' };
  const findings = ports.filter(p => DANGER[p.port]).map(p => ({ severity: 'HIGH', text: `Exposed: ${p.service}/${p.port} — ${DANGER[p.port]}` }));
  return { summary: `${ports.length} open: ${ports.map(p=>`${p.port}/${p.service}`).join(', ')}`, structured: { ports }, findings };
}

function parseFfufOutput(output) {
  const hits = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    // Format 1: default ffuf "200      Size: N   Words: N   Lines: N   /path"
    const m1 = line.match(/^\s*(\d{3})\s+\S+\s+\S+\s+\S+\s+(\S+)/);
    if (m1) { hits.push({ status: parseInt(m1[1]), url: m1[2] }); continue; }
    // Format 2: "[Status: 200, ...] url"
    const m2 = line.match(/\[Status:\s*(\d+)[^\]]*\].*?(https?:\/\/\S+|\S*\/\S+)/);
    if (m2) { hits.push({ status: parseInt(m2[1]), url: m2[2] }); continue; }
    // Format 3: JSON
    try { const j = JSON.parse(line); if (j.status && j.url) hits.push({ status: j.status, url: j.url }); } catch {}
  }
  const INTERESTING = /admin|config|backup|\.env|\.git|secret|passwd|shadow|db|sql|upload|phpinfo|swagger|graphql|metrics|actuator|debug|internal|manage|console/i;
  const CRITICAL_RE = /\.env|\.git|\.sql|\.bak|\.zip|backup|passwd|shadow/i;
  const interesting = hits.filter(h => INTERESTING.test(h.url));
  const findings = interesting.map(h => ({
    severity: CRITICAL_RE.test(h.url) ? 'CRITICAL' : 'HIGH',
    text: `Sensitive path [${h.status}]: ${h.url}`,
    evidence: h.url,
  }));
  const two00s = hits.filter(h => h.status === 200 && !interesting.some(i => i.url === h.url));
  if (two00s.length > 0)
    findings.push({ severity: 'MEDIUM', text: `${two00s.length} accessible paths: ${two00s.slice(0,4).map(h=>h.url).join(', ')}` });
  return { summary: `${hits.length} paths | ${interesting.length} sensitive`, structured: { hits, interesting }, findings };
}

function parseExploitOutput(output) {
  const findings = [];
  if (/root:.*:0:0|\/etc\/passwd/i.test(output))
    findings.push({ severity: 'CRITICAL', text: 'LFI/RCE confirmed — /etc/passwd in response' });
  if (/uid=\d+.*gid=\d+/i.test(output))
    findings.push({ severity: 'CRITICAL', text: 'RCE confirmed — id command output detected' });
  if (/alert\(|<script>|onerror=/i.test(output))
    findings.push({ severity: 'HIGH', text: 'XSS payload reflected in response' });
  if (/Access-Control-Allow-Origin:\s*evil\.com/i.test(output))
    findings.push({ severity: 'HIGH', text: 'CORS — evil.com origin reflected' });
  return { summary: `Exploit: ${output.length}b | ${findings.length} finding(s)`, structured: {}, findings };
}

function parseSensitiveFileOutput(output) {
  const findings = [];
  const patterns = [
    { re: /DB_PASSWORD\s*=\s*\S+/i,                sev: 'CRITICAL', label: 'DB credential' },
    { re: /APP_KEY\s*=\s*base64:/i,                sev: 'HIGH',     label: 'Laravel app key' },
    { re: /AWS_SECRET[^=]*=\s*[A-Za-z0-9+/]{40}/i, sev: 'CRITICAL', label: 'AWS secret key' },
    { re: /(AKIA[0-9A-Z]{16})/,                    sev: 'CRITICAL', label: 'AWS access key' },
    { re: /api[_-]?key\s*=\s*\S{16,}/i,            sev: 'HIGH',     label: 'API key' },
    { re: /private[_-]?key|BEGIN RSA PRIVATE/i,    sev: 'CRITICAL', label: 'Private key' },
    { re: /password\s*=\s*['"']?[^'"]{6,}/i,       sev: 'HIGH',     label: 'Password' },
    { re: /SECRET\s*=\s*\S{8,}/i,                  sev: 'HIGH',     label: 'Secret value' },
  ];
  for (const { re, sev, label } of patterns)
    if (re.test(output)) findings.push({ severity: sev, text: label + ' found' });
  return { summary: `File: ${output.length}b | ${findings.length} sensitive item(s)`, structured: {}, findings };
}

function parseUrlList(output) {
  const urls  = output.split('\n').filter(l => l.startsWith('http'));
  const juicy = urls.filter(u => /\.env|admin|backup|config|api|internal|swagger|debug|token|secret/i.test(u));
  const findings = juicy.length ? [{ severity: 'MEDIUM', text: `Interesting historical URLs: ${juicy.slice(0,3).join(', ')}` }] : [];
  return { summary: `${urls.length} URLs | ${juicy.length} interesting`, structured: { urls, juicy }, findings };
}

function parseSpinelOutput(output) {
  const findings = [];
  let structured = {};
  try {
    const jsonMatch = output.match(/[{][\s\S]*"schema_version"[\s\S]*[}]/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      structured = { totalRequests: data.requests_total, reflections: data.reflections_total };
      for (const r of (data.results || [])) {
        if (!r.reflected || r.deduplicated) continue;
        const sev = r.severity === 'critical' ? 'CRITICAL' : r.severity === 'high' ? 'HIGH' : 'MEDIUM';
        findings.push({
          severity: sev,
          text: `Reflection via ${r.injection_point}:${r.parameter_name} — ${r.target}`,
          poc_curl: `curl -s "${r.request_url}"${r.request_body ? ` -d '${r.request_body}'` : ''}`,
          target: r.target,
          evidence: `Status: ${r.status_code} | Point: ${r.injection_point} | Param: ${r.parameter_name}`,
          metadata: { injection_point: r.injection_point, parameter_name: r.parameter_name, snippets: r.snippets },
        });
      }
    }
  } catch {}
  for (const line of output.split('\n').filter(l => l.includes('[HIT]'))) {
    if (!findings.some(f => f.text.includes(line.slice(0,30))))
      findings.push({ severity: 'MEDIUM', text: `Reflection detected: ${line.slice(0,120)}` });
  }
  return { summary: `Spinel: ${findings.length} reflection(s)`, structured, findings };
}

function parseShellOutput(output) {
  const findings = [];
  if (/root:x:0:0/.test(output))
    findings.push({ severity: 'CRITICAL', text: 'LFI confirmed — /etc/passwd read', evidence: output.slice(0,300) });
  if (/uid=0\(root\)/.test(output))
    findings.push({ severity: 'CRITICAL', text: 'RCE confirmed — running as root' });
  if (/uid=\d+\(\w+\)\s+gid=\d+/.test(output))
    findings.push({ severity: 'CRITICAL', text: 'RCE confirmed — command execution', evidence: output.slice(0,200) });
  if (/AKIA[0-9A-Z]{16}/.test(output))
    findings.push({ severity: 'CRITICAL', text: 'AWS access key in output' });
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/.test(output))
    findings.push({ severity: 'HIGH', text: 'JWT token visible in output' });
  if (/"(password|secret|token|api_?key)"\s*:\s*"[^"]{4,}"/.test(output))
    findings.push({ severity: 'HIGH', text: 'Credential in JSON response' });
  if (/SQL syntax|mysql_fetch|ORA-\d{5}|pg_query|SQLite|SQLSTATE/.test(output))
    findings.push({ severity: 'HIGH', text: 'SQL error — potential SQLi surface' });
  if (/<script>alert|onerror=alert|javascript:alert/.test(output))
    findings.push({ severity: 'HIGH', text: 'XSS payload reflected' });
  return { summary: `Shell: ${output.length}b | ${findings.length} finding(s)`, structured: {}, findings };
}

function parseInstallOutput(output) {
  const success = /successfully installed|already installed|installed to|compiled ok/i.test(output);
  return { summary: success ? 'Install: success' : 'Install: check output', structured: { success }, findings: [] };
}

// ── Public ────────────────────────────────────────────────────────────────────
function parse(toolId, rawOutput) {
  const parser = parsers[toolId] || (output => ({ summary: `${output.length}b`, structured: {}, findings: [] }));
  try {
    const result = parser(rawOutput);
    result.findings = (result.findings || []).filter(f => !['LOW','INFO'].includes(f.severity?.toUpperCase()));
    return result;
  } catch (err) {
    return { summary: `Parse error: ${err.message}`, structured: {}, findings: [] };
  }
}

module.exports = { parse, parsers };
