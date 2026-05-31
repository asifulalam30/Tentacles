/**
 * STEALTH PROFILE
 *
 * Helpers that runners can opt into to look less like a scanner. Three
 * concerns kept separate:
 *
 *   1. User-Agent rotation — pick a real browser string per request
 *   2. Speed presets — translate "standard / slow / glacial" into concrete rates
 *   3. Stealth flags — bundle of headers/options that reduce fingerprint
 *
 * None of this makes you "undetected." It reduces the floor of automated
 * detection (rate-limit triggers, signature-based WAF rules, default-tool
 * fingerprints). A determined human reading logs will still see you.
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');

// Real browser UA strings, refreshed periodically. Kept short — we rotate per
// request, not per session, so 25 is plenty.
const USER_AGENTS = [
  // Chrome on Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  // Chrome on Mac
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  // Chrome on Linux
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  // Firefox
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:131.0) Gecko/20100101 Firefox/131.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  // Safari
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  // Edge
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  // Mobile Safari
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  // Mobile Chrome
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
];

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Speed presets translate to a multiplier applied to default rates.
// Lower = slower = less likely to trip rate limits.
//
//   standard: 1.0  → use default rates (5 req/s on FFUF, 30 on Nuclei)
//   slow:     0.2  → 1 req/s on FFUF, 6 on Nuclei
//   glacial:  0.06 → 0.3 req/s on FFUF, ~2 on Nuclei
const SPEED_MULTIPLIERS = {
  standard: 1.0,
  slow: 0.2,
  glacial: 0.06,
};

// Estimated wall time for a Heavy sweep on a 5-host target by speed preset.
// (Used for the launch modal to show "~3-4hr / ~12-18hr / ~3-7 days")
const SPEED_LABELS = {
  standard: { label: 'Standard', estimate: '~3-4 hr' },
  slow:     { label: 'Slow',     estimate: '~12-18 hr' },
  glacial:  { label: 'Glacial',  estimate: '~3-7 days' },
};

/**
 * Adjust a per-tool rate by the speed preset.
 * Returns at minimum 0.1 (one request every 10 seconds — that's the floor).
 */
function adjustRate(baseRate, speedPreset) {
  const mult = SPEED_MULTIPLIERS[speedPreset] || 1.0;
  return Math.max(0.1, baseRate * mult);
}

/**
 * Path to a UA list file the runners can pass to tools that want a header
 * file (e.g. ffuf -H "User-Agent: $(shuf -n1 ua.txt)" doesn't actually rotate,
 * but a static list seeded from real browsers is better than the default).
 *
 * Writes the file if it doesn't exist.
 */
async function ensureUserAgentFile(workbenchDir) {
  const fp = path.join(workbenchDir, 'stealth_uas.txt');
  if (!await fs.pathExists(fp)) {
    await fs.writeFile(fp, USER_AGENTS.join('\n') + '\n');
  }
  return fp;
}

/**
 * Build a merged options object for a tool given its registry defaults and
 * the active stealth/speed config. The sweep pipeline uses this to construct
 * the final options before invoking a runner.
 */
function applyStealthToOptions(toolId, baseOptions, { stealth, speed }) {
  const out = { ...baseOptions };
  const speedMult = SPEED_MULTIPLIERS[speed] || 1.0;

  // Per-tool rate adjustments. Conservative — drops, never raises.
  switch (toolId) {
    case 'ffuf':
      if (typeof out.rate === 'number') {
        out.rate = adjustRate(out.rate, speed);
      }
      // In stealth mode also drop rate further on the noisiest tool
      if (stealth && typeof out.rate === 'number') {
        out.rate = Math.max(0.5, out.rate * 0.5);
      }
      break;
    case 'nuclei':
      if (typeof out.rateLimit === 'number') {
        out.rateLimit = adjustRate(out.rateLimit, speed);
      }
      // Nuclei full templates are the most signature-loud — downgrade in stealth
      if (stealth && out.templateSet === 'full') {
        out.templateSet = 'default';
      }
      break;
    case 'reflection':
      if (typeof out.delayMin === 'number') {
        out.delayMin = Math.max(0.8, out.delayMin / speedMult);
        out.delayMax = Math.max(out.delayMin + 0.5, out.delayMax / speedMult);
      }
      break;
    case 'mirror':
      if (typeof out.rateLimit === 'number') {
        out.rateLimit = adjustRate(out.rateLimit, speed);
      }
      break;
    case 'arjun':
      // Arjun has thread/concurrency knobs but no rate
      if (stealth && typeof out.threadsPerHost === 'number') {
        out.threadsPerHost = Math.max(1, Math.floor(out.threadsPerHost / 2));
      }
      break;
    case 'whatweb':
      if (stealth) {
        out.aggression = '1';  // passive
      }
      break;
    case 'gowitness':
      if (stealth && typeof out.threads === 'number') {
        out.threads = Math.max(2, Math.floor(out.threads / 2));
      }
      break;
    case 'testssl':
      if (stealth && typeof out.concurrency === 'number') {
        out.concurrency = 1;  // serialize tls handshakes in stealth
      }
      break;
  }

  return out;
}

module.exports = {
  USER_AGENTS,
  pickUserAgent,
  ensureUserAgentFile,
  SPEED_MULTIPLIERS,
  SPEED_LABELS,
  adjustRate,
  applyStealthToOptions,
};
