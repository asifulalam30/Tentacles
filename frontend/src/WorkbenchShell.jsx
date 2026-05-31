/**
 * WorkbenchShell — the new layout wrapper
 *
 * Provides: persistent sidebar + header with target/scan controls + stat cards
 * row + tab system + docked activity stream (right column).
 *
 * The actual chat / leads / directives / recon-data components live inside
 * Workbench.jsx as before — this file only provides the shell + the table
 * tabs that read from /api/workbenches/:wbId/recon-files/:filename.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { TentaclesLogo } from './TentaclesLogo';

// Shared theme — kept in sync with Workbench.jsx
export const T = {
  bg0: '#0B0F1A', bg1: '#111827', bg2: '#1A2236', bg3: '#243047',
  border: '#1E2D45', borderHi: '#2E4165',
  textPrimary: '#F0F4FC', textSecondary: '#94A8C4', textTertiary: '#6B82A0', textMuted: '#4A6080',
  accent: '#3B82F6', accentHi: '#60A5FA', accentDim: '#1D3461',
  green: '#4ADE80', amber: '#FBBF24', red: '#F87171', purple: '#A78BFA',
  fontMono: "'JetBrains Mono','Fira Code',monospace",
  fontSans: "'DM Sans','Segoe UI',system-ui,sans-serif",
  fontDisplay: "'Syne','DM Sans',system-ui,sans-serif",
};

// ─────────────────────────────────────────────────────────────────────────
// Sidebar
// ─────────────────────────────────────────────────────────────────────────

const NAV_GROUPS = [
  {
    title: 'WORKBENCH',
    items: [
      { id: 'overview',   label: 'Overview',   icon: '◈' },
      { id: 'recon',      label: 'Recon',      icon: '◊' },
      { id: 'findings',   label: 'Findings',   icon: '🚨' },
      { id: 'tool_runs',  label: 'Tool Runs',  icon: '⚙' },
      { id: 'reports',    label: 'Reports',    icon: '◇' },
    ],
  },
];

export function Sidebar({ activeTab, onSelectTab, isMobile, onClose }) {
  if (isMobile) return null; // sidebar collapses to bottom-bar on mobile (handled in Workbench)

  return (
    <div style={{
      width: 200, flexShrink: 0,
      background: T.bg1, borderRight: `1px solid ${T.border}`,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div onClick={onClose} title="Go to home"
        style={{
          padding: '14px 16px', borderBottom: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
          cursor: onClose ? 'pointer' : 'default',
          transition: 'background 0.12s',
        }}
        onMouseEnter={e => { if (onClose) e.currentTarget.style.background = T.bg2; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
        <TentaclesLogo size={30} radius={7} />
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 700, color: T.textPrimary,
            fontFamily: T.fontDisplay, letterSpacing: '0.4px', lineHeight: 1,
          }}>TENTACLES</div>
          <div style={{ fontSize: 9, color: T.textMuted, letterSpacing: '1.2px', marginTop: 3 }}>
            WORKBENCH
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 8px' }}>
        {NAV_GROUPS.map(group => (
          <div key={group.title} style={{ marginBottom: 18 }}>
            <div style={{
              fontSize: 9, color: T.textMuted, letterSpacing: '1.2px',
              padding: '0 10px', marginBottom: 6, fontWeight: 600,
            }}>{group.title}</div>
            {group.items.map(item => {
              const active = activeTab === item.id;
              return (
                <button key={item.id} onClick={() => onSelectTab(item.id)}
                  style={{
                    width: '100%', textAlign: 'left',
                    background: active ? T.accentDim : 'transparent',
                    border: 'none',
                    borderLeft: `2px solid ${active ? T.accent : 'transparent'}`,
                    color: active ? T.accentHi : T.textSecondary,
                    padding: '8px 10px',
                    fontSize: 13, fontWeight: 500,
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 10,
                    borderRadius: 0,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = T.bg2; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
                  <span style={{ fontSize: 14, color: active ? T.accent : T.textTertiary, width: 14 }}>
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{
        padding: 12, borderTop: `1px solid ${T.border}`,
        fontSize: 10, color: T.textMuted,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>v3.0.0</span>
          <button onClick={onClose} style={{
            background: 'transparent', border: 'none',
            color: T.textTertiary, fontSize: 10,
            cursor: 'pointer', padding: 0,
          }}>← Home</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Header — target/scope display + recon controls + status
// ─────────────────────────────────────────────────────────────────────────

export function ShellHeader({
  target, wbId, onRunRecon, onStopRecon, reconRunning, reconPhase, connStatus,
  isMobile, onToggleSidebar, onToggleChat, chatVisible,
  onSwitchWb, currentTarget,
  workbenches,
}) {
  const phaseLabel = reconPhase ? reconPhase.replace('phase_', '').replace('_', '/').replace(/_/g,'.') : '';
  const phasePct = _phasePct(reconPhase);

  const [wbDropdownOpen, setWbDropdownOpen] = useState(false);

  return (
    <div style={{
      flexShrink: 0,
      background: T.bg1, borderBottom: `1px solid ${T.border}`,
      padding: isMobile ? '8px 10px' : '10px 16px',
      display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 12,
    }}>
      {isMobile && (
        <button onClick={onToggleSidebar} style={{
          background: T.bg2, border: `1px solid ${T.border}`,
          borderRadius: 5, padding: '6px 10px', color: T.textSecondary,
          fontSize: 14, cursor: 'pointer',
        }}>≡</button>
      )}

      {/* Target selector */}
      <div style={{ position: 'relative', minWidth: 0, flex: isMobile ? 1 : 'unset' }}>
        <button onClick={() => setWbDropdownOpen(o => !o)} style={{
          background: T.bg2, border: `1px solid ${T.border}`,
          borderRadius: 6, padding: '7px 12px',
          display: 'flex', alignItems: 'center', gap: 8,
          color: T.textPrimary, fontSize: 13, fontWeight: 500,
          cursor: 'pointer', minWidth: 0,
          fontFamily: T.fontMono,
        }}>
          <span style={{ color: T.textTertiary, fontSize: 11 }}>Target</span>
          <span style={{ color: T.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap', maxWidth: isMobile ? 130 : 220 }}>
            {target || '—'}
          </span>
          {connStatus === 'connected' && (
            <span style={{
              background: T.green + '22', border: `1px solid ${T.green}55`,
              color: T.green, fontSize: 9, fontWeight: 600,
              padding: '1px 6px', borderRadius: 3, letterSpacing: 0.5,
            }}>ACTIVE</span>
          )}
          <span style={{ color: T.textTertiary, fontSize: 9 }}>▾</span>
        </button>
        {wbDropdownOpen && workbenches && workbenches.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4,
            background: T.bg2, border: `1px solid ${T.border}`,
            borderRadius: 6, padding: 4, zIndex: 1000,
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
            minWidth: 240, maxHeight: 320, overflowY: 'auto',
          }}>
            {workbenches.map(w => (
              <button key={w.wbId} onClick={() => {
                setWbDropdownOpen(false);
                if (w.wbId !== wbId) onSwitchWb(w.wbId);
              }} style={{
                width: '100%', textAlign: 'left',
                background: w.wbId === wbId ? T.accentDim : 'transparent',
                border: 'none', color: w.wbId === wbId ? T.accentHi : T.textSecondary,
                padding: '8px 10px', fontSize: 12, cursor: 'pointer',
                borderRadius: 4, fontFamily: T.fontMono,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {w.target}
                </span>
                {w.state === 'recon_running' && <span style={{ color: T.amber, fontSize: 9 }}>● scan</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Recon phase pill (when running) */}
      <HeaderPhasePill reconRunning={reconRunning} reconPhase={reconPhase} />

      <div style={{ flex: 1 }} />

      {/* Scan controls */}
      {!reconRunning ? (
        <button onClick={onRunRecon} style={{
          background: `linear-gradient(135deg, ${T.accent}, #1D4ED8)`,
          color: '#fff', border: 'none',
          borderRadius: 6, padding: '7px 14px',
          fontSize: 12, fontWeight: 600,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
          boxShadow: `0 2px 12px ${T.accent}55`,
        }}>
          <span style={{ fontSize: 10 }}>▶</span>
          {isMobile ? 'Scan' : 'Re-run scan'}
        </button>
      ) : (
        <button onClick={onStopRecon} style={{
          background: T.red, color: '#fff', border: 'none',
          borderRadius: 6, padding: '7px 14px',
          fontSize: 12, fontWeight: 600,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ fontSize: 10 }}>■</span>
          Stop
        </button>
      )}

      {/* Activity stream toggle */}
      <button onClick={onToggleChat} title={chatVisible ? "Hide activity" : "Show activity"} style={{
        background: chatVisible ? T.accentDim : T.bg2,
        border: `1px solid ${chatVisible ? T.accent : T.border}`,
        borderRadius: 6, padding: '7px 12px',
        color: chatVisible ? T.accentHi : T.textSecondary,
        fontSize: 12, fontWeight: 500,
        cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ fontSize: 11 }}>⚡</span>
        {!isMobile && 'Activity'}
      </button>

      {/* Connection dot */}
      <div title={`Connection: ${connStatus}`} style={{
        width: 8, height: 8, borderRadius: '50%',
        background: connStatus === 'connected' ? T.green
                  : connStatus === 'reconnecting' || connStatus === 'connecting' ? T.amber
                  : T.red,
        boxShadow: connStatus === 'connected' ? `0 0 6px ${T.green}88` : 'none',
        flexShrink: 0,
      }} />
    </div>
  );
}

function _phasePct(phaseId) {
  const map = {
    phase_starting: 2,
    phase_1_10: 10, phase_2_10: 20, phase_3_10: 28, phase_4_10: 38,
    phase_5_10: 50, 'phase_5.5_10': 58, phase_6_10: 65, phase_7_10: 72,
    phase_8_10: 88, phase_9_10: 96,
  };
  return map[phaseId] || 50;
}

// ─────────────────────────────────────────────────────────────────────────
// Stat cards row
// ─────────────────────────────────────────────────────────────────────────

function _StatCards({ summary, isMobile }) {
  const counts = (summary && summary.counts) || {};

  // Build stat list — only show stats that have backing data, plus the "hot" ones
  // even when zero (so users see the slots exist)
  const stats = [
    { key: 'subdomains', label: 'Subdomains', value: counts.subdomains, icon: '◊', color: T.accentHi,
      sub: counts.resolved ? `${counts.resolved} resolved` : '' },
    { key: 'aliveHosts', label: 'Live Hosts', value: counts.aliveHosts, icon: '⌬', color: T.green,
      sub: counts.directHosts != null ? `${counts.directHosts} direct` : '' },
    { key: 'allUrls', label: 'URLs', value: counts.allUrls, icon: '⟿', color: T.purple,
      sub: counts.apiEndpoints ? `${counts.apiEndpoints} API` : '' },
    { key: 'params', label: 'Parameters', value: counts.params, icon: '⌗', color: T.accent,
      sub: counts.jsEndpoints ? `${counts.jsEndpoints} JS endpts` : '' },
    { key: 'dangling', label: 'Dangling CNAME', value: counts.dangling, icon: '⚑', color: T.amber,
      sub: counts.dangling ? 'takeover candidates' : 'no candidates', hot: counts.dangling > 0 },
    { key: 'cheapWins', label: 'Cheap Wins', value: (counts.gitExposed || 0) + (counts.envExposed || 0) + (counts.graphqlEndpoints || 0) + (counts.backupFiles || 0),
      icon: '✦', color: T.red, sub: 'git/env/graphql/backup',
      hot: ((counts.gitExposed || 0) + (counts.envExposed || 0) + (counts.graphqlEndpoints || 0) + (counts.backupFiles || 0)) > 0 },
  ];

  // On mobile, show only first 4 in 2 cols
  const visible = isMobile ? stats.slice(0, 4) : stats;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : `repeat(${visible.length}, 1fr)`,
      gap: isMobile ? 6 : 10,
      marginBottom: isMobile ? 10 : 14,
    }}>
      {visible.map(s => {
        const v = s.value || 0;
        return (
          <div key={s.key} style={{
            background: T.bg1,
            border: `1px solid ${s.hot ? s.color + '55' : T.border}`,
            borderRadius: 8,
            padding: isMobile ? '10px 12px' : '12px 14px',
            position: 'relative',
            overflow: 'hidden',
          }}>
            {s.hot && (
              <div style={{
                position: 'absolute', top: 0, right: 0,
                width: 6, height: 6,
                background: s.color, borderRadius: '50%',
                margin: 8, boxShadow: `0 0 6px ${s.color}`,
                animation: 'pulse 2s infinite',
              }}/>
            )}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 9, color: T.textTertiary,
              fontWeight: 600, letterSpacing: 0.6,
              textTransform: 'uppercase', marginBottom: 6,
            }}>
              <span style={{ color: s.color, fontSize: 11 }}>{s.icon}</span>
              {s.label}
            </div>
            <div style={{
              fontSize: isMobile ? 22 : 26, fontWeight: 700,
              color: s.hot ? s.color : T.textPrimary,
              fontFamily: T.fontDisplay,
              lineHeight: 1, letterSpacing: '-0.5px',
              marginBottom: 4,
            }}>
              {v.toLocaleString()}
            </div>
            {s.sub && (
              <div style={{ fontSize: 10, color: T.textTertiary }}>
                {s.sub}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// LiveReconStream — phase progress + scrolling log of recon findings
// Shows during recon, becomes a "completed" log after recon finishes
// ─────────────────────────────────────────────────────────────────────────

const _PHASE_LABELS = {
  starting:        { num: '0',    label: 'Starting',           pct: 2 },
  phase_1_10:      { num: '1/10', label: 'Subdomain enumeration', pct: 10 },
  phase_2_10:      { num: '2/10', label: 'DNS resolution + CNAMEs', pct: 20 },
  phase_3_10:      { num: '3/10', label: 'Port scanning',      pct: 28 },
  phase_4_10:      { num: '4/10', label: 'HTTP probing + CDN', pct: 38 },
  phase_5_10:      { num: '5/10', label: 'URL collection',     pct: 50 },
  'phase_5.5_10':  { num: '5.5/10', label: 'JS analysis',      pct: 58 },
  phase_6_10:      { num: '6/10', label: 'Parameter extraction', pct: 65 },
  phase_7_10:      { num: '7/10', label: 'Arjun param discovery', pct: 72 },
  phase_8_10:      { num: '8/10', label: 'Web fuzzing (FFUF)', pct: 88 },
  phase_9_10:      { num: '9/10', label: 'Cheap-win probes',   pct: 96 },
};

// Map phase names to log tag colors (mockup-style)
function _phaseTag(headline = '') {
  const h = headline.toLowerCase();
  if (h.includes('subdomain'))  return { tag: 'RECON',    color: T.accentHi };
  if (h.includes('dns') || h.includes('resolution'))
                                return { tag: 'DNS',      color: T.purple };
  if (h.includes('dangling'))   return { tag: 'TAKEOVER', color: T.amber };
  if (h.includes('alive') || h.includes('host'))
                                return { tag: 'HTTPX',    color: T.green };
  if (h.includes('port'))       return { tag: 'PORTSCAN', color: T.purple };
  if (h.includes('url') || h.includes('endpoint'))
                                return { tag: 'CRAWL',    color: T.accentHi };
  if (h.includes('js') || h.includes('javascript') || h.includes('secret'))
                                return { tag: 'JS',       color: T.purple };
  if (h.includes('param') || h.includes('arjun'))
                                return { tag: 'PARAMS',   color: T.accent };
  if (h.includes('fuzz') || h.includes('ffuf'))
                                return { tag: 'FFUF',     color: T.amber };
  if (h.includes('graphql') || h.includes('git') || h.includes('env') || h.includes('backup') || h.includes('cheap'))
                                return { tag: 'PROBE',    color: T.red };
  if (h.includes('complete'))   return { tag: 'DONE',     color: T.green };
  if (h.includes('start'))      return { tag: 'START',    color: T.accentHi };
  if (h.includes('fail') || h.includes('error') || h.includes('skip'))
                                return { tag: 'WARN',     color: T.red };
  return { tag: 'INFO', color: T.textTertiary };
}

export function LiveReconStream({ messages, reconRunning, reconPhase, target, isMobile }) {
  const scrollRef = React.useRef(null);

  // Filter to recon-role messages only — defensive
  const reconMessages = React.useMemo(
    () => Array.isArray(messages) ? messages.filter(m => m && m.role === 'recon') : [],
    [messages]
  );

  // Auto-scroll to bottom on new messages while recon is running
  React.useEffect(() => {
    if (reconRunning && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [reconMessages.length, reconRunning]);

  const phaseInfo = _PHASE_LABELS[reconPhase] || (reconRunning ? _PHASE_LABELS.starting : null);

  const headerColor = reconRunning ? T.amber : T.green;
  const headerLabel = reconRunning
    ? 'LIVE'
    : reconMessages.length > 0
      ? 'COMPLETE'
      : null;

  return (
    <div style={{
      background: T.bg1, border: `1px solid ${T.border}`,
      borderRadius: 8, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      minHeight: 0,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${T.border}`,
        background: T.bg2,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ color: headerColor, fontSize: 11 }}>
          {reconRunning ? '●' : reconMessages.length > 0 ? '✓' : '○'}
        </span>
        <span style={{
          fontSize: 11, fontWeight: 600, color: T.textPrimary,
          letterSpacing: 0.4, textTransform: 'uppercase',
        }}>Live Scan Output</span>
        {headerLabel && (
          <span style={{
            background: headerColor + '22',
            border: `1px solid ${headerColor}55`,
            color: headerColor,
            fontSize: 9, fontWeight: 700,
            padding: '2px 7px', borderRadius: 3,
            letterSpacing: 0.6,
            animation: reconRunning ? 'pulse 2s infinite' : 'none',
          }}>{headerLabel}</span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: T.textMuted, fontFamily: T.fontMono }}>
          {reconMessages.length} event{reconMessages.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Phase progress bar (only while running) */}
      {reconRunning && phaseInfo && (
        <div style={{
          padding: '8px 14px', borderBottom: `1px solid ${T.border}`,
          background: T.bg1,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center',
            fontSize: 10, color: T.textTertiary,
            marginBottom: 5, gap: 8,
          }}>
            <span style={{
              color: T.amber, fontFamily: T.fontMono,
              fontWeight: 600, fontSize: 10,
            }}>PHASE {phaseInfo.num}</span>
            <span style={{ color: T.textSecondary }}>{phaseInfo.label}</span>
            <span style={{ flex: 1 }} />
            <span style={{ color: T.textMuted, fontFamily: T.fontMono }}>
              {phaseInfo.pct}%
            </span>
          </div>
          <div style={{
            height: 4, background: T.bg2,
            borderRadius: 2, overflow: 'hidden',
          }}>
            <div style={{
              width: `${phaseInfo.pct}%`,
              height: '100%',
              background: `linear-gradient(90deg, ${T.amber}, ${T.accent})`,
              transition: 'width 0.5s ease',
              boxShadow: `0 0 8px ${T.amber}66`,
            }}/>
          </div>
        </div>
      )}

      {/* Log */}
      <div ref={scrollRef} style={{
        flex: 1, overflowY: 'auto',
        background: T.bg0,
        padding: '8px 0',
        fontFamily: T.fontMono, fontSize: 11,
        WebkitOverflowScrolling: 'touch',
      }}>
        {reconMessages.length === 0 ? (
          <div style={{
            padding: '24px 16px', textAlign: 'center',
            color: T.textMuted, fontSize: 11, fontStyle: 'italic',
          }}>
            {reconRunning
              ? 'Recon starting — findings will appear here as they happen.'
              : `No recon yet. Click "Re-run scan" to start RetroX recon on ${target || 'this target'}.`}
          </div>
        ) : (
          reconMessages.map((m, i) => {
            // Parse the markdown-formatted content: icon, then bold headline, then optional detail
            const content = m.content || '';
            const headlineMatch = content.match(/^(\S+)\s+\*\*(.+?)\*\*/);
            const icon = headlineMatch ? headlineMatch[1] : '';
            const headline = headlineMatch ? headlineMatch[2] : content.slice(0, 100);
            const detail = headlineMatch
              ? content.slice(headlineMatch[0].length).replace(/^\n+/, '').trim()
              : '';
            const { tag, color } = _phaseTag(headline);
            const time = m.ts ? new Date(m.ts).toLocaleTimeString([], { hour12: false }) : '';

            return (
              <div key={`${m.ts}-${i}`} style={{
                padding: '4px 14px',
                display: 'flex', alignItems: 'flex-start', gap: 10,
                borderLeft: `2px solid transparent`,
                animation: i === reconMessages.length - 1 && reconRunning ? 'fadeUp 0.3s ease' : 'none',
              }}>
                <span style={{
                  color: T.textMuted, fontSize: 10,
                  whiteSpace: 'nowrap', flexShrink: 0,
                  paddingTop: 1,
                }}>
                  {time}
                </span>
                <span style={{
                  color, fontSize: 9, fontWeight: 700,
                  letterSpacing: 0.5, padding: '2px 6px',
                  background: color + '15',
                  border: `1px solid ${color}33`,
                  borderRadius: 3,
                  flexShrink: 0, minWidth: 60, textAlign: 'center',
                }}>{tag}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    color: T.textPrimary, fontSize: 11,
                    fontFamily: T.fontSans,
                    wordBreak: 'break-word',
                  }}>
                    {icon && <span style={{ marginRight: 5 }}>{icon}</span>}
                    {headline}
                  </div>
                  {detail && !isMobile && (
                    <div style={{
                      color: T.textTertiary, fontSize: 10,
                      fontFamily: T.fontMono,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                      marginTop: 3, lineHeight: 1.5,
                      maxHeight: 120, overflow: 'hidden',
                    }}>
                      {detail.length > 400 ? detail.slice(0, 400) + '...' : detail}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export const StatCards = React.memo(_StatCards, (prev, next) => {
  // Only re-render if counts actually changed (avoid reflow from harmless prop updates)
  const a = prev.summary?.counts || {};
  const b = next.summary?.counts || {};
  if (prev.isMobile !== next.isMobile) return false;
  for (const k of Object.keys({ ...a, ...b })) {
    if (a[k] !== b[k]) return false;
  }
  return true;
});

// ─────────────────────────────────────────────────────────────────────────
// Generic recon table — for Subdomains / Hosts / Endpoints / Params / JS / Probes tabs
// ─────────────────────────────────────────────────────────────────────────

const FILE_META = {
  // Subdomains
  'all_subs.txt':           { label: 'All subdomains',         icon: '◊', category: 'Subdomains' },
  'resolved.txt':           { label: 'Resolved (sub → IP)',    icon: '◉', category: 'Subdomains' },
  'cnames.txt':             { label: 'CNAMEs',                 icon: '↳', category: 'Subdomains' },
  'dangling.txt':           { label: 'Dangling CNAMEs',        icon: '⚑', hot: true, category: 'Subdomains' },
  'takeover_findings.txt':  { label: 'Confirmed takeovers',    icon: '🚨', hot: true, category: 'Subdomains' },
  // Hosts
  'alive_hosts.txt':        { label: 'Alive hosts (all)',      icon: '✓', category: 'Hosts' },
  'cloudflare_hosts.txt':   { label: 'Behind Cloudflare',      icon: '⛨', category: 'Hosts' },
  'direct_hosts.txt':       { label: 'Direct (no CDN)',        icon: '⤴', hot: true, category: 'Hosts' },
  'technologies.txt':       { label: 'Technology stack',       icon: '⚙', category: 'Hosts' },
  'whatweb_findings.txt':   { label: 'whatweb fingerprints',   icon: '◇', category: 'Hosts' },
  'waf_detections.txt':     { label: 'WAF detections',         icon: '◮', category: 'Hosts' },
  'open_ports.txt':         { label: 'Open ports',             icon: '⊞', category: 'Hosts' },
  // Endpoints
  'all_urls.txt':           { label: 'All URLs',               icon: '⟿', category: 'Endpoints' },
  'urls_archive.txt':       { label: 'Archived URLs',          icon: '⟆', category: 'Endpoints' },
  'api_endpoints.txt':      { label: 'API endpoints',          icon: '⟿', category: 'Endpoints' },
  'ffuf_findings.txt':      { label: 'FFUF findings',          icon: '⊕', hot: true, category: 'Endpoints' },
  'forms.txt':              { label: 'HTML forms',             icon: '⊟', category: 'Endpoints' },
  'html_comments.txt':      { label: 'Interesting comments',   icon: '◔', category: 'Endpoints' },
  // Parameters
  'params.txt':             { label: 'Parameters',             icon: '⌗', category: 'Parameters' },
  'params_detailed.txt':    { label: 'Params with values',     icon: '⌬', category: 'Parameters' },
  // JavaScript
  'js_files.txt':           { label: 'JS files',               icon: '⟦', category: 'JavaScript' },
  'js_endpoints.txt':       { label: 'JS endpoints',           icon: '⟶', category: 'JavaScript' },
  'js_secrets.txt':         { label: 'Possible JS secrets',    icon: '✦', hot: true, category: 'JavaScript' },
  // Cheap wins
  'graphql_endpoints.txt':  { label: 'GraphQL endpoints',      icon: '◆', hot: true, category: 'Cheap wins' },
  'git_exposed.txt':        { label: 'Exposed .git',           icon: '⚠', hot: true, category: 'Cheap wins' },
  'env_exposed.txt':        { label: 'Exposed .env',           icon: '⚠', hot: true, category: 'Cheap wins' },
  'backup_files.txt':       { label: 'Backup files',           icon: '◧', hot: true, category: 'Cheap wins' },
  'security_txt.txt':       { label: 'security.txt',           icon: '✉', category: 'Cheap wins' },
  // Tool findings
  'testssl_findings.txt':   { label: 'TLS/SSL issues',         icon: '◐', hot: true, category: 'Tool findings' },
  's3_findings.txt':        { label: 'Cloud bucket findings',  icon: '◭', hot: true, category: 'Tool findings' },
  'github_secrets.txt':     { label: 'GitHub secrets',         icon: '🚨', hot: true, category: 'Tool findings' },
  'nuclei_findings.txt':    { label: 'Nuclei findings',        icon: '◬', hot: true, category: 'Tool findings' },
  'reflection_findings.txt':{ label: 'Reflection findings',    icon: '✦', hot: true, category: 'Tool findings' },
};

// All recon files in display order — categories grouped together. Used by the unified Recon tab.
export const RECON_FILES_ORDERED = [
  // Subdomains
  'all_subs.txt', 'resolved.txt', 'cnames.txt', 'dangling.txt', 'takeover_findings.txt',
  // Hosts
  'alive_hosts.txt', 'cloudflare_hosts.txt', 'direct_hosts.txt', 'technologies.txt',
  'whatweb_findings.txt', 'waf_detections.txt', 'open_ports.txt',
  // Endpoints
  'all_urls.txt', 'urls_archive.txt', 'api_endpoints.txt', 'ffuf_findings.txt',
  'forms.txt', 'html_comments.txt',
  // Parameters
  'params.txt', 'params_detailed.txt',
  // JavaScript
  'js_files.txt', 'js_endpoints.txt', 'js_secrets.txt',
  // Cheap wins
  'graphql_endpoints.txt', 'git_exposed.txt', 'env_exposed.txt',
  'backup_files.txt', 'security_txt.txt',
  // Tool findings
  'testssl_findings.txt', 's3_findings.txt', 'github_secrets.txt',
  'nuclei_findings.txt', 'reflection_findings.txt',
];


// RowActions — per-row "..." menu for ad-hoc recon actions
function RowActions({ row, wbId, apiKey }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(null);

  if (!row || !row.line) return null;
  const isUrl = /^https?:\/\//.test(row.line);
  const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(row.line.trim());
  // Extract host from URL or use as-is
  const hostFromLine = isUrl ? row.line : row.line;
  // Guess actions based on which file the line came from
  const file = row.file;

  const callAction = async (action, body) => {
    setBusy(action);
    try {
      const r = await fetch(`/api/workbenches/${wbId}/recon/action/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.error) alert(d.error);
    } catch (e) {
      alert('Failed to start: ' + e.message);
    }
    setBusy(null);
    setOpen(false);
  };

  // Decide which actions apply
  const actions = [];
  if (file === 'all_subs.txt' || file === 'alive_hosts.txt' || file === 'direct_hosts.txt' || file === 'cloudflare_hosts.txt') {
    actions.push({ id: 'ffuf',  label: '🎯 Run ffuf here',     fn: () => callAction('ffuf',  { host: hostFromLine }) });
    actions.push({ id: 'probe', label: '🔬 Cheap-win probes',   fn: () => callAction('probe', { host: hostFromLine }) });
  }
  if (file === 'ips.txt' || isIp) {
    actions.push({ id: 'portscan', label: '🚪 Port scan',       fn: () => callAction('portscan', { ip: row.line.trim() }) });
  }
  if (file === 'resolved.txt') {
    // resolved.txt is "sub IP" per line — extract IP
    const parts = row.line.split(/\s+/);
    const ip = parts[1];
    if (ip && /^\d/.test(ip)) {
      actions.push({ id: 'portscan', label: '🚪 Port scan IP', fn: () => callAction('portscan', { ip }) });
    }
  }

  if (actions.length === 0) {
    return (
      <button onClick={() => navigator.clipboard.writeText(row.line)} title="Copy"
        style={{
          background: 'transparent', border: 'none',
          color: T.textMuted, cursor: 'pointer',
          fontSize: 11, padding: 2,
        }}>⧉</button>
    );
  }

  return (
    <div style={{ position: 'relative', display: 'inline-flex', gap: 2 }}>
      <button onClick={() => navigator.clipboard.writeText(row.line)} title="Copy"
        style={{
          background: 'transparent', border: 'none',
          color: T.textMuted, cursor: 'pointer',
          fontSize: 11, padding: 2,
        }}>⧉</button>
      <button onClick={() => setOpen(o => !o)} title="Actions"
        style={{
          background: open ? T.accentDim : 'transparent',
          border: 'none', color: open ? T.accentHi : T.textMuted,
          cursor: 'pointer', fontSize: 12, padding: '0 4px',
          borderRadius: 3,
        }}>⋯</button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 2,
          background: T.bg1, border: `1px solid ${T.border}`,
          borderRadius: 5, padding: 3, zIndex: 80,
          boxShadow: '0 6px 20px rgba(0,0,0,0.6)',
          minWidth: 160,
        }} onMouseLeave={() => setOpen(false)}>
          {actions.map(a => (
            <button key={a.id} onClick={a.fn} disabled={!!busy}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: busy === a.id ? T.accentDim : 'transparent',
                border: 'none', color: T.textSecondary,
                padding: '6px 10px', fontSize: 11,
                cursor: busy ? 'wait' : 'pointer',
                borderRadius: 3, fontFamily: T.fontSans,
              }}
              onMouseEnter={e => { if (!busy) e.currentTarget.style.background = T.bg2; }}
              onMouseLeave={e => { if (busy !== a.id) e.currentTarget.style.background = 'transparent'; }}>
              {busy === a.id ? '...' : a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ReconTable — shows one or more recon files as a unified searchable table.
 * filenames: array of recon filenames to merge/show (each line becomes a row).
 * Each row has the source file as a small badge.
 */
export function ReconTable({ wbId, apiKey, filenames, emptyText, isMobile, toolbarActions, groupByCategory }) {
  const safeFilenames = Array.isArray(filenames) ? filenames : [];
  const [filesData, setFilesData] = useState({}); // { filename: [lines] }
  const [search, setSearch] = useState('');
  const [activeFile, setActiveFile] = useState(safeFilenames[0] || null);
  // When data loads, if the current activeFile has no rows but others do, jump to the first non-empty file.
  useEffect(() => {
    if (!groupByCategory) return;
    const hasData = (fn) => (filesData[fn] || []).length > 0;
    if (activeFile && hasData(activeFile)) return;
    const firstNonEmpty = safeFilenames.find(hasData);
    if (firstNonEmpty && firstNonEmpty !== activeFile) {
      setActiveFile(firstNonEmpty);
    }
  }, [filesData, groupByCategory, safeFilenames.join(','), activeFile]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!wbId || !safeFilenames.length) return;
    setLoading(true);
    const next = {};
    await Promise.all(safeFilenames.map(async (fn) => {
      try {
        const r = await fetch(`/api/workbenches/${wbId}/recon-files/${fn}`, {
          headers: apiKey ? { 'x-api-key': apiKey } : {},
        });
        if (r.ok) {
          const d = await r.json();
          next[fn] = (d.content || '').split('\n').filter(Boolean);
        } else {
          next[fn] = [];
        }
      } catch { next[fn] = []; }
    }));
    setFilesData(next);
    setLoading(false);
  }, [wbId, apiKey, safeFilenames.join(',')]);

  useEffect(() => { load(); }, [load]);

  const allRows = useMemo(() => {
    const rows = [];
    for (const fn of safeFilenames) {
      for (const line of (filesData[fn] || [])) {
        rows.push({ file: fn, line });
      }
    }
    return rows;
  }, [filesData, safeFilenames.join(',')]);

  const filtered = useMemo(() => {
    let r = allRows;
    if (activeFile && safeFilenames.length > 1) {
      r = r.filter(row => row.file === activeFile);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter(row => row.line.toLowerCase().includes(q));
    }
    return r;
  }, [allRows, activeFile, search, safeFilenames.length]);

  // Make file tabs from the filenames provided
  const fileTabs = safeFilenames.length > 1 ? safeFilenames : [];

  return (
    <div style={{
      background: T.bg1, border: `1px solid ${T.border}`,
      borderRadius: 8, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      minHeight: 0, flex: 1,
    }}>
      {/* Toolbar */}
      <div style={{
        padding: '10px 12px', borderBottom: `1px solid ${T.border}`,
        display: 'flex', alignItems: 'center', gap: 10,
        flexWrap: 'wrap',
      }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search..."
          style={{
            background: T.bg0, border: `1px solid ${T.border}`,
            borderRadius: 5, padding: '6px 10px',
            color: T.textPrimary, fontSize: 12,
            fontFamily: T.fontMono,
            minWidth: 180, flex: isMobile ? 1 : 'unset',
          }}
        />
        {/* Render file tabs. If groupByCategory is on, group them by category with small separators between. */}
        {fileTabs.length > 0 && (() => {
          // Filter to only files that have content
          const nonEmpty = fileTabs.filter(fn => (filesData[fn] || []).length > 0);
          if (nonEmpty.length === 0) return null;

          if (groupByCategory) {
            // Group by category, render each group with a label separator
            const byCat = {};
            const catOrder = [];
            for (const fn of nonEmpty) {
              const cat = (FILE_META[fn] && FILE_META[fn].category) || 'Other';
              if (!byCat[cat]) { byCat[cat] = []; catOrder.push(cat); }
              byCat[cat].push(fn);
            }
            const out = [];
            catOrder.forEach((cat, ci) => {
              if (ci > 0) {
                out.push(
                  <span key={'sep-' + cat} style={{
                    width: 1, alignSelf: 'stretch',
                    background: T.border, margin: '0 4px',
                  }} />
                );
              }
              out.push(
                <span key={'lbl-' + cat} style={{
                  fontSize: 9, fontWeight: 600, color: T.textMuted,
                  textTransform: 'uppercase', letterSpacing: 0.5,
                  alignSelf: 'center', marginRight: 2,
                }}>{cat}</span>
              );
              for (const fn of byCat[cat]) {
                const meta = FILE_META[fn] || { label: fn, icon: '◦' };
                const count = (filesData[fn] || []).length;
                const active = activeFile === fn;
                out.push(
                  <button key={fn} onClick={() => setActiveFile(fn)}
                    style={{
                      background: active ? T.accentDim : 'transparent',
                      border: `1px solid ${active ? T.accent : T.border}`,
                      borderRadius: 5, padding: '5px 10px',
                      color: active ? T.accentHi : (meta.hot && count > 0 ? T.amber : T.textSecondary),
                      fontSize: 11, fontWeight: 500, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 5,
                    }}>
                    <span style={{ fontSize: 10 }}>{meta.icon}</span>
                    {meta.label}
                    <span style={{
                      background: active ? T.accent + '44' : T.bg0,
                      color: active ? T.accentHi : T.textTertiary,
                      padding: '0px 5px', borderRadius: 3,
                      fontSize: 9, fontFamily: T.fontMono,
                    }}>{count}</span>
                  </button>
                );
              }
            });
            return out;
          }

          // Default: flat list, but still hide empty
          return nonEmpty.map(fn => {
            const meta = FILE_META[fn] || { label: fn, icon: '◦' };
            const count = (filesData[fn] || []).length;
            const active = activeFile === fn;
            return (
              <button key={fn} onClick={() => setActiveFile(fn)}
                style={{
                  background: active ? T.accentDim : 'transparent',
                  border: `1px solid ${active ? T.accent : T.border}`,
                  borderRadius: 5, padding: '5px 10px',
                  color: active ? T.accentHi : (meta.hot && count > 0 ? T.amber : T.textSecondary),
                  fontSize: 11, fontWeight: 500, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}>
                <span style={{ fontSize: 10 }}>{meta.icon}</span>
                {meta.label}
                <span style={{
                  background: active ? T.accent + '44' : T.bg0,
                  color: active ? T.accentHi : T.textTertiary,
                  padding: '0px 5px', borderRadius: 3,
                  fontSize: 9, fontFamily: T.fontMono,
                }}>{count}</span>
              </button>
            );
          });
        })()}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: T.textMuted, fontFamily: T.fontMono }}>
          {loading ? 'Loading...' : `${filtered.length} / ${allRows.length}`}
        </span>
        {toolbarActions && toolbarActions}
        <button onClick={load} title="Refresh" style={{
          background: T.bg2, border: `1px solid ${T.border}`,
          color: T.textTertiary, padding: '5px 10px',
          borderRadius: 5, fontSize: 11, cursor: 'pointer',
        }}>↻</button>
      </div>

      {/* Rows */}
      <div style={{
        flex: 1, overflowY: 'auto',
        background: T.bg0,
        WebkitOverflowScrolling: 'touch',
      }}>
        {filtered.length === 0 ? (
          <div style={{
            padding: '40px 20px', textAlign: 'center',
            color: T.textMuted, fontSize: 12, fontStyle: 'italic',
          }}>
            {loading ? 'Loading recon data...'
              : allRows.length === 0
                ? (emptyText || 'No recon data yet — run scan to populate.')
                : 'No matches for your search.'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <tbody>
              {filtered.slice(0, 1000).map((row, i) => {
                const meta = FILE_META[row.file] || { label: row.file, icon: '◦' };
                const isUrl = /^https?:\/\//.test(row.line);
                const showFileBadge = safeFilenames.length > 1 && !activeFile;
                return (
                  <tr key={i} style={{
                    borderBottom: `1px solid ${T.border}33`,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = T.bg2 + '88'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                    {showFileBadge && (
                      <td style={{
                        padding: '6px 12px',
                        color: meta.hot ? T.amber : T.textTertiary,
                        fontSize: 9, fontFamily: T.fontMono,
                        whiteSpace: 'nowrap', width: 1,
                      }}>
                        {meta.icon} {meta.label.split(' ')[0]}
                      </td>
                    )}
                    <td style={{
                      padding: '6px 12px',
                      color: T.textSecondary,
                      fontFamily: T.fontMono, fontSize: 11,
                      wordBreak: 'break-all',
                    }}>
                      {isUrl ? (
                        <a href={row.line} target="_blank" rel="noopener noreferrer"
                          style={{ color: T.accentHi, textDecoration: 'none' }}
                          onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
                          onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}>
                          {row.line}
                        </a>
                      ) : row.line}
                    </td>
                    <td style={{
                      padding: '6px 12px',
                      color: T.textMuted, fontSize: 9,
                      whiteSpace: 'nowrap', width: 1,
                    }}>
                      <RowActions row={row} wbId={wbId} apiKey={apiKey} />
                    </td>
                  </tr>
                );
              })}
              {filtered.length > 1000 && (
                <tr>
                  <td colSpan={3} style={{
                    padding: '12px', textAlign: 'center',
                    color: T.textMuted, fontSize: 11, fontStyle: 'italic',
                  }}>
                    Showing first 1,000 of {filtered.length}. Refine with search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ReconStreamDrawer — fixed-position bottom panel (collapsible)
// Shows live recon findings without affecting page layout.
// ─────────────────────────────────────────────────────────────────────────

export function ReconStreamDrawer({ messages, reconRunning, reconPhase, target, isMobile }) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [autoCollapsed, setAutoCollapsed] = React.useState(false);
  const scrollRef = React.useRef(null);

  // Filter to recon messages only — defensive against undefined/null
  const reconMessages = React.useMemo(
    () => Array.isArray(messages) ? messages.filter(m => m && m.role === 'recon') : [],
    [messages]
  );

  // Auto-collapse 5s after recon finishes (so the user can glance at the final lines)
  React.useEffect(() => {
    if (reconRunning) {
      setAutoCollapsed(false);
    } else if (reconMessages.length > 0 && !autoCollapsed) {
      const t = setTimeout(() => setAutoCollapsed(true), 6000);
      return () => clearTimeout(t);
    }
  }, [reconRunning, reconMessages.length, autoCollapsed]);

  // Auto-scroll to bottom on new messages while running
  React.useEffect(() => {
    if (reconRunning && scrollRef.current && !collapsed) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [reconMessages.length, reconRunning, collapsed]);

  // Don't render at all if no recon has happened
  if (reconMessages.length === 0 && !reconRunning) return null;

  const isCollapsed = collapsed || autoCollapsed;
  const phaseInfo = _PHASE_LABELS[reconPhase] || (reconRunning ? _PHASE_LABELS.starting : null);
  const headerColor = reconRunning ? T.amber : T.green;
  const headerLabel = reconRunning ? 'LIVE' : 'COMPLETE';

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      // Sit above mobile bottom-nav (~52px), aligned right of desktop sidebar (200px wide)
      left: isMobile ? 0 : 200,
      right: 0,
      height: isCollapsed ? 36 : (isMobile ? 220 : 260),
      background: T.bg1,
      borderTop: `1px solid ${headerColor}55`,
      zIndex: 50,
      display: 'flex', flexDirection: 'column',
      transition: 'height 0.25s ease',
      boxShadow: '0 -8px 24px rgba(0,0,0,0.4)',
    }}>
      {/* Header — always visible, click to expand/collapse */}
      <div onClick={() => { setCollapsed(c => !c); setAutoCollapsed(false); }}
        style={{
          height: 36, flexShrink: 0,
          padding: '0 14px',
          display: 'flex', alignItems: 'center', gap: 10,
          background: T.bg2,
          borderBottom: isCollapsed ? 'none' : `1px solid ${T.border}`,
          cursor: 'pointer', userSelect: 'none',
        }}>
        <span style={{
          color: headerColor, fontSize: 11,
          animation: reconRunning ? 'pulse 1.5s infinite' : 'none',
        }}>{reconRunning ? '●' : '✓'}</span>
        <span style={{
          fontSize: 11, fontWeight: 600, color: T.textPrimary,
          letterSpacing: 0.4, textTransform: 'uppercase',
        }}>Live Scan Output</span>
        <span style={{
          background: headerColor + '22',
          border: `1px solid ${headerColor}55`,
          color: headerColor,
          fontSize: 9, fontWeight: 700,
          padding: '2px 7px', borderRadius: 3,
          letterSpacing: 0.6,
        }}>{headerLabel}</span>
        {phaseInfo && reconRunning && !isMobile && (
          <>
            <span style={{ color: T.textTertiary, fontSize: 10, marginLeft: 8 }}>
              Phase {phaseInfo.num} · {phaseInfo.label}
            </span>
            <div style={{
              width: 80, height: 3,
              background: T.bg0, borderRadius: 2,
              overflow: 'hidden', marginLeft: 4,
            }}>
              <div style={{
                width: `${phaseInfo.pct}%`, height: '100%',
                background: T.amber,
                transition: 'width 0.5s ease',
              }}/>
            </div>
          </>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: T.textMuted, fontFamily: T.fontMono }}>
          {reconMessages.length} event{reconMessages.length === 1 ? '' : 's'}
        </span>
        <span style={{
          color: T.textTertiary, fontSize: 12,
          marginLeft: 4, transform: isCollapsed ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.2s',
        }}>▾</span>
      </div>

      {/* Body — scrolling log */}
      {!isCollapsed && (
        <div ref={scrollRef} style={{
          flex: 1, overflowY: 'auto',
          background: T.bg0,
          padding: '8px 14px',
          fontFamily: T.fontMono, fontSize: 11,
          WebkitOverflowScrolling: 'touch',
        }}>
          {reconMessages.length === 0 && (
            <div style={{ color: T.textMuted, fontStyle: 'italic', padding: '4px 0' }}>
              Waiting for output...
            </div>
          )}
          {reconMessages.map((m, i) => (
            <div key={`${m.ts}-${i}`} style={{
              padding: '2px 0',
              color: T.textSecondary,
              lineHeight: 1.5,
              borderBottom: `1px solid ${T.border}22`,
            }}>
              <span style={{
                color: T.textMuted,
                fontSize: 10, marginRight: 8,
              }}>{(() => { try { return new Date(m.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}); } catch { return ''; } })()}</span>
              {m.icon && <span style={{ marginRight: 6 }}>{m.icon}</span>}
              <span style={{ color: T.textPrimary }}>{m.headline || m.content}</span>
              {m.detail && (
                <div style={{
                  color: T.textTertiary, fontSize: 10,
                  marginLeft: 56, marginTop: 2,
                  whiteSpace: 'pre-wrap',
                }}>{m.detail}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────
// RerunModal — pick which phases to re-run
// ─────────────────────────────────────────────────────────────────────────

export function RerunModal({ onClose, onRun, busy }) {
  const [mode, setMode] = React.useState('quick');
  const [skipFlags, setSkipFlags] = React.useState({
    skipPorts: false, skipUrls: false, skipJs: false,
    skipArjun: false, skipFfuf: false, skipProbes: false,
  });

  const handleRun = () => {
    let opts = {};
    if (mode === 'preset_fast') {
      opts = { skipPorts: true, skipFfuf: true, skipArjun: true };
    } else if (mode === 'customize') {
      opts = skipFlags;
    }
    onRun(opts);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1100, padding: 16,
    }} onClick={() => !busy && onClose()}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(460px, 100%)', background: T.bg1,
        border: `1px solid ${T.border}`, borderRadius: 10, padding: 22,
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: T.textPrimary }}>Re-run recon</div>
          <button onClick={onClose} disabled={busy} style={{
            background: 'transparent', border: 'none',
            color: T.textTertiary, fontSize: 18, cursor: 'pointer',
          }}>✕</button>
        </div>

        <div style={{ fontSize: 11, color: T.textTertiary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
          Mode
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 14 }}>
          {[
            { id: 'quick',       label: '◆ Full',     sub: 'all phases' },
            { id: 'preset_fast', label: '⚡ Quick',    sub: 'skip slow' },
            { id: 'customize',   label: '⚙ Custom',   sub: 'pick phases' },
          ].map(m => {
            const active = mode === m.id;
            return (
              <button key={m.id} onClick={() => setMode(m.id)} disabled={busy} style={{
                background: active ? T.accentDim : T.bg2,
                border: `1px solid ${active ? T.accent : T.border}`,
                color: active ? T.accentHi : T.textSecondary,
                borderRadius: 6, padding: '8px 10px',
                cursor: busy ? 'not-allowed' : 'pointer',
                textAlign: 'left',
              }}>
                <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 2 }}>{m.label}</div>
                <div style={{ fontSize: 10, opacity: 0.7 }}>{m.sub}</div>
              </button>
            );
          })}
        </div>

        {mode === 'customize' && (
          <div style={{
            background: T.bg0, border: `1px solid ${T.border}`,
            borderRadius: 6, padding: 12, marginBottom: 12,
          }}>
            {[
              { key: 'skipPorts',  label: 'Phase 3 — Port scanning' },
              { key: 'skipUrls',   label: 'Phase 5 — URL collection' },
              { key: 'skipJs',     label: 'Phase 5.5 — JS analysis' },
              { key: 'skipArjun',  label: 'Phase 7 — Arjun' },
              { key: 'skipFfuf',   label: 'Phase 8 — FFUF' },
              { key: 'skipProbes', label: 'Phase 9 — Cheap-win probes' },
            ].map(p => (
              <label key={p.key} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0',
                cursor: 'pointer', fontSize: 11, color: T.textSecondary,
              }}>
                <input type="checkbox" checked={!skipFlags[p.key]}
                  onChange={e => setSkipFlags(s => ({ ...s, [p.key]: !e.target.checked }))}
                  style={{ accentColor: T.accent }}/>
                <span>{p.label}</span>
              </label>
            ))}
          </div>
        )}

        <div style={{
          padding: '8px 10px', background: T.bg2, borderRadius: 5,
          fontSize: 10, color: T.textTertiary, lineHeight: 1.5, marginBottom: 14,
        }}>
          Re-running recon will re-probe targets and merge new findings into existing files.
          Existing data is preserved.
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onClose} disabled={busy} style={{
            flex: 1, background: 'transparent', border: `1px solid ${T.border}`,
            color: T.textSecondary, padding: '8px 14px',
            borderRadius: 6, fontSize: 12, cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={handleRun} disabled={busy} style={{
            flex: 2, background: `linear-gradient(135deg, ${T.accent}, #1D4ED8)`,
            color: '#fff', border: 'none',
            padding: '8px 14px', borderRadius: 6,
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
          }}>
            {busy ? 'Starting...' : 'Re-run scan'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// LiveScanPanel — in-flow recon stream section (lives in Overview tab)
// Replaces the floating ReconStreamDrawer. Sits in the document flow, no
// overlap with tab content. Expands while recon runs, collapses when idle.
// ─────────────────────────────────────────────────────────────────────────

export function LiveScanPanel({ messages, reconRunning, reconPhase, isMobile }) {
  const [expanded, setExpanded] = React.useState(true);
  const scrollRef = React.useRef(null);

  const reconMessages = React.useMemo(
    () => Array.isArray(messages) ? messages.filter(m => m && m.role === 'recon') : [],
    [messages]
  );

  // Default-collapsed once idle and the user has seen it. Default-expanded
  // when running so the user sees output without clicking.
  React.useEffect(() => {
    if (reconRunning) setExpanded(true);
  }, [reconRunning]);

  // Auto-scroll while running and expanded
  React.useEffect(() => {
    if (reconRunning && expanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [reconMessages.length, reconRunning, expanded]);

  // Don't render at all if no recon has happened ever
  if (reconMessages.length === 0 && !reconRunning) return null;

  const headerColor = reconRunning ? T.amber : T.green;
  const headerLabel = reconRunning ? 'LIVE' : 'COMPLETE';

  return (
    <div style={{
      background: T.bg1,
      border: `1px solid ${T.border}`,
      borderRadius: 8,
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      {/* Header — always visible, click to expand/collapse */}
      <div onClick={() => setExpanded(e => !e)}
        style={{
          padding: '10px 14px',
          background: T.bg2,
          borderBottom: expanded ? `1px solid ${T.border}` : 'none',
          display: 'flex', alignItems: 'center', gap: 10,
          cursor: 'pointer', userSelect: 'none',
          fontSize: 11,
        }}>
        <span style={{
          color: headerColor,
          animation: reconRunning ? 'pulse 1.5s infinite' : 'none',
        }}>{reconRunning ? '●' : '✓'}</span>
        <span style={{
          fontWeight: 600, color: T.textPrimary,
          letterSpacing: 0.4, textTransform: 'uppercase',
        }}>Live Scan Output</span>
        <span style={{
          background: headerColor + '22',
          border: `1px solid ${headerColor}55`,
          color: headerColor,
          fontSize: 9, fontWeight: 700,
          padding: '2px 7px', borderRadius: 3,
          letterSpacing: 0.6,
        }}>{headerLabel}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: T.textMuted, fontFamily: T.fontMono, fontSize: 10 }}>
          {reconMessages.length} event{reconMessages.length === 1 ? '' : 's'}
        </span>
        <span style={{
          color: T.textTertiary, fontSize: 11,
          marginLeft: 4,
          transform: expanded ? 'rotate(0deg)' : 'rotate(180deg)',
          transition: 'transform 0.2s',
        }}>▾</span>
      </div>

      {/* Body — scrolling log */}
      {expanded && (
        <div ref={scrollRef} style={{
          maxHeight: isMobile ? 220 : 280,
          overflowY: 'auto',
          background: T.bg0,
          padding: '8px 14px',
          fontFamily: T.fontMono, fontSize: 11,
          WebkitOverflowScrolling: 'touch',
        }}>
          {reconMessages.length === 0 && (
            <div style={{ color: T.textMuted, fontStyle: 'italic', padding: '4px 0' }}>
              Waiting for output...
            </div>
          )}
          {reconMessages.map((m, i) => {
            let timeStr = '';
            try { timeStr = new Date(m.ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}); } catch {}
            return (
              <div key={`${m.ts}-${i}`} style={{
                padding: '2px 0',
                color: T.textSecondary,
                lineHeight: 1.5,
                borderBottom: `1px solid ${T.border}22`,
              }}>
                <span style={{ color: T.textMuted, fontSize: 10, marginRight: 8 }}>{timeStr}</span>
                {m.icon && <span style={{ marginRight: 6 }}>{m.icon}</span>}
                <span style={{ color: T.textPrimary }}>{m.headline || m.content}</span>
                {m.detail && (
                  <div style={{
                    color: T.textTertiary, fontSize: 10,
                    marginLeft: 56, marginTop: 2,
                    whiteSpace: 'pre-wrap',
                  }}>{m.detail}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// HeaderPhasePill — tiny live-progress indicator in the header strip
// Visible from any tab while recon runs, so users don't need to switch
// to Overview to see what's happening.
// ─────────────────────────────────────────────────────────────────────────

const _HEADER_PHASE_LABELS = {
  starting: 'starting',
  phase_1_10: '1/10 subs',
  phase_2_10: '2/10 dns',
  phase_3_10: '3/10 ports',
  phase_4_10: '4/10 http',
  phase_5_10: '5/10 urls',
  'phase_5.5_10': '5.5/10 js',
  phase_6_10: '6/10 params',
  phase_7_10: '7/10 arjun',
  phase_8_10: '8/10 ffuf',
  phase_9_10: '9/10 probes',
};

export function HeaderPhasePill({ reconRunning, reconPhase }) {
  if (!reconRunning) return null;
  const label = _HEADER_PHASE_LABELS[reconPhase] || 'starting';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: T.amber + '15',
      border: `1px solid ${T.amber}44`,
      borderRadius: 5,
      padding: '4px 9px',
      fontSize: 10,
      fontFamily: T.fontMono,
      color: T.amber,
      fontWeight: 500,
      whiteSpace: 'nowrap',
    }}>
      <span style={{ animation: 'pulse 1.5s infinite' }}>●</span>
      {label}
    </span>
  );
}


// ─────────────────────────────────────────────────────────────────────────
// ToolLauncherPanel — pick a tool, fill in inputs, run it
// Replaces ReconControlsPanel. Dynamic forms driven by /api/.../tools/registry.
// ─────────────────────────────────────────────────────────────────────────

function _fmtAgo(ts) {
  if (!ts) return null;
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60)   return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec/3600)}h ago`;
  return `${Math.floor(sec/86400)}d ago`;
}

function _fmtDuration(sec) {
  if (sec == null) return '';
  const s = Math.floor(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s % 60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s % 3600)/60)}m`;
}

// Renders file content from readRunFile responses. Handles:
//   - text strings (normal text/JSON files)
//   - { binary: true } responses (shows download button)
//   - { directory: true } responses
//   - { tooLarge: true } responses
//   - null/loading
function FileContentView({ content, wbId, runId, apiKey }) {
  if (!content) return (
    <div style={{
      background: T.bg0, border: `1px solid ${T.border}`,
      borderRadius: 5, padding: 14, fontSize: 11,
      color: T.textMuted, fontFamily: T.fontMono, fontStyle: 'italic',
    }}>(no file selected)</div>
  );

  // Plain text/JSON
  if (typeof content === 'string') {
    return (
      <div style={{
        background: T.bg0, border: `1px solid ${T.border}`,
        borderRadius: 5, padding: 10,
        maxHeight: 400, overflow: 'auto',
        fontFamily: T.fontMono, fontSize: 10,
        color: T.textSecondary,
        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      }}>{content}</div>
    );
  }

  // Binary file — show download button + image preview if it's an image
  if (content.binary) {
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(content.fname || '');
    const safeName = (content.fname || '').split('/').map(encodeURIComponent).join('/');
    const downloadUrl = `/api/workbenches/${wbId}/tools/runs/${runId}/download/${safeName}` +
                         (apiKey ? `?_k=${encodeURIComponent(apiKey)}` : '');
    return (
      <div style={{
        background: T.bg0, border: `1px solid ${T.border}`,
        borderRadius: 5, padding: 14, fontSize: 11,
      }}>
        <div style={{ color: T.textTertiary, marginBottom: 10 }}>{content.message}</div>
        {isImage && (
          <img src={downloadUrl}
            alt={content.fname}
            style={{ maxWidth: '100%', maxHeight: 300, border: `1px solid ${T.border}`, borderRadius: 4, marginBottom: 10 }}
          />
        )}
        <a href={downloadUrl} target="_blank" rel="noopener noreferrer"
          style={{
            display: 'inline-block',
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            color: T.accentHi, padding: '5px 12px', borderRadius: 4,
            fontSize: 11, textDecoration: 'none', cursor: 'pointer',
          }}>↓ Open / download</a>
      </div>
    );
  }

  if (content.directory) {
    return (
      <div style={{
        background: T.bg0, border: `1px solid ${T.amber}55`,
        borderRadius: 5, padding: 14, fontSize: 11, color: T.amber,
      }}>{content.message}</div>
    );
  }

  if (content.tooLarge) {
    const safeName = (content.fname || '').split('/').map(encodeURIComponent).join('/');
    const downloadUrl = `/api/workbenches/${wbId}/tools/runs/${runId}/download/${safeName}` +
                         (apiKey ? `?_k=${encodeURIComponent(apiKey)}` : '');
    return (
      <div style={{
        background: T.bg0, border: `1px solid ${T.border}`,
        borderRadius: 5, padding: 14, fontSize: 11,
      }}>
        <div style={{ color: T.textTertiary, marginBottom: 10 }}>{content.message}</div>
        <a href={downloadUrl} target="_blank" rel="noopener noreferrer"
          style={{
            display: 'inline-block',
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            color: T.accentHi, padding: '5px 12px', borderRadius: 4,
            fontSize: 11, textDecoration: 'none', cursor: 'pointer',
          }}>↓ Download</a>
      </div>
    );
  }

  return (
    <div style={{
      background: T.bg0, border: `1px solid ${T.border}`,
      borderRadius: 5, padding: 10,
      fontFamily: T.fontMono, fontSize: 10,
      color: T.textSecondary,
    }}>{JSON.stringify(content, null, 2)}</div>
  );
}

// Status badge for a run
function StatusBadge({ status }) {
  const colors = {
    running:   { bg: T.amber, label: 'RUNNING' },
    completed: { bg: T.green, label: 'DONE' },
    failed:    { bg: T.red,   label: 'FAILED' },
    stopped:   { bg: T.textMuted, label: 'STOPPED' },
  };
  const c = colors[status] || colors.failed;
  return (
    <span style={{
      background: c.bg + '22',
      border: `1px solid ${c.bg}55`,
      color: c.bg,
      fontSize: 9, fontWeight: 700,
      padding: '2px 7px', borderRadius: 3,
      letterSpacing: 0.6,
    }}>{c.label}</span>
  );
}

// ToolForm — renders the right input for a single registry entry
function ToolFormField({ field, value, onChange, disabled }) {
  const inputStyle = {
    width: '100%',
    background: T.bg2,
    border: `1px solid ${T.border}`,
    color: T.textPrimary,
    borderRadius: 5,
    padding: '6px 9px',
    fontSize: 12,
    fontFamily: T.fontSans,
  };
  const renderHelp = () => field.help && (
    <div style={{ fontSize: 10, color: T.textMuted, marginTop: 3, lineHeight: 1.4 }}>{field.help}</div>
  );

  switch (field.type) {
    case 'string':
      return (
        <div>
          <input type="text" value={value || ''} disabled={disabled}
            placeholder={field.placeholder || ''}
            onChange={e => onChange(e.target.value)}
            style={inputStyle} />
          {renderHelp()}
        </div>
      );
    case 'number':
      return (
        <div>
          <input type="number" value={value ?? field.default} disabled={disabled}
            min={field.min} max={field.max}
            onChange={e => onChange(Number(e.target.value))}
            style={inputStyle} />
          {renderHelp()}
        </div>
      );
    case 'boolean':
      return (
        <label style={{
          display: 'flex', alignItems: 'center', gap: 8,
          cursor: disabled ? 'not-allowed' : 'pointer',
          fontSize: 12, color: T.textSecondary,
        }}>
          <input type="checkbox" checked={!!value} disabled={disabled}
            onChange={e => onChange(e.target.checked)}
            style={{ accentColor: T.accent }} />
          {field.help || 'Enabled'}
        </label>
      );
    case 'select':
    case 'file':
      return (
        <div>
          <select value={value || (field.type === 'select' ? field.default : '')} disabled={disabled}
            onChange={e => onChange(e.target.value)}
            style={inputStyle}>
            {field.type === 'file'
              ? field.accepts.map(f => <option key={f} value={f}>{f}</option>)
              : field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {renderHelp()}
        </div>
      );
    case 'multi':
      return (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
            {field.options.map(o => {
              const arr = Array.isArray(value) ? value : (field.default || []);
              const checked = arr.includes(o.value);
              return (
                <label key={o.value} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontSize: 11, color: T.textSecondary,
                  background: checked ? T.accentDim : T.bg2,
                  border: `1px solid ${checked ? T.accent + '88' : T.border}`,
                  padding: '5px 8px', borderRadius: 4,
                }}>
                  <input type="checkbox" checked={checked} disabled={disabled}
                    onChange={e => {
                      const next = e.target.checked ? [...arr, o.value] : arr.filter(x => x !== o.value);
                      onChange(next);
                    }}
                    style={{ accentColor: T.accent }} />
                  {o.label}
                </label>
              );
            })}
          </div>
          {renderHelp()}
        </div>
      );
    default:
      return null;
  }
}

// One run's row in the history list
function RunRow({ run, wbId, apiKey, onRefresh }) {
  const [expanded, setExpanded] = React.useState(false);
  const [outputs, setOutputs] = React.useState(null);
  const [activeFile, setActiveFile] = React.useState(null);
  const [fileContent, setFileContent] = React.useState(null);

  const loadOutputs = async () => {
    try {
      const r = await fetch(`/api/workbenches/${wbId}/tools/runs/${run.runId}`, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      if (r.ok) {
        const d = await r.json();
        setOutputs(d.output);
      }
    } catch {}
  };

  const loadFile = async (fname) => {
    setActiveFile(fname);
    setFileContent('Loading...');
    try {
      // Path may contain slashes (nested files) — split & re-encode each segment
      const safeName = fname.split('/').map(encodeURIComponent).join('/');
      const r = await fetch(`/api/workbenches/${wbId}/tools/runs/${run.runId}/output/${safeName}`, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      const d = await r.json();
      if (r.ok) {
        setFileContent(d.content);
      } else if (r.status === 415 && d.error === 'binary') {
        // Binary file — show metadata + download link instead
        setFileContent({ binary: true, size: d.size, message: d.message, fname });
      } else if (r.status === 415 && d.error === 'directory') {
        setFileContent({ directory: true, message: d.message });
      } else if (r.status === 415 && d.error === 'too_large') {
        setFileContent({ tooLarge: true, message: d.message, fname });
      } else {
        setFileContent('Failed to load: ' + (d.error || r.statusText));
      }
    } catch (e) { setFileContent('Error: ' + e.message); }
  };

  const stopThis = async () => {
    try {
      await fetch(`/api/workbenches/${wbId}/tools/runs/${run.runId}/stop`, {
        method: 'POST',
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      onRefresh && onRefresh();
    } catch {}
  };

  const handleExpand = () => {
    setExpanded(e => !e);
    if (!expanded && !outputs) loadOutputs();
  };

  return (
    <div style={{
      borderBottom: `1px solid ${T.border}33`,
      background: expanded ? T.bg0 : 'transparent',
    }}>
      <div onClick={handleExpand} style={{
        padding: '8px 12px',
        display: 'flex', alignItems: 'center', gap: 10,
        cursor: 'pointer',
        fontSize: 11,
      }}>
        <span style={{ color: T.accentHi, fontSize: 13, width: 16 }}>{run.toolId === 'ffuf' ? '⊕' : run.toolId === 'arjun' ? '⌬' : run.toolId === 'js_analyzer' ? '⟦' : run.toolId === 'nuclei' ? '◬' : '✦'}</span>
        <span style={{ color: T.textPrimary, fontWeight: 500, minWidth: 90 }}>{run.label || run.toolId}</span>
        <StatusBadge status={run.status} />
        <span style={{ color: T.textTertiary, fontSize: 10, fontFamily: T.fontMono }}>
          {run.options?.inputFile || ''}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: T.textSecondary, fontSize: 10 }}>
          {run.findings?.summary || (run.status === 'running' ? '...' : '')}
        </span>
        <span style={{ color: T.textMuted, fontSize: 10 }}>
          {_fmtAgo(run.startedAt)}
        </span>
        {run.status === 'running' && (
          <button onClick={(e) => { e.stopPropagation(); stopThis(); }}
            style={{
              background: T.red + '22', border: `1px solid ${T.red}55`,
              color: T.red, padding: '3px 8px', borderRadius: 4,
              fontSize: 10, cursor: 'pointer',
            }}>Stop</button>
        )}
        <span style={{
          color: T.textTertiary, fontSize: 11,
          transform: expanded ? 'rotate(0deg)' : 'rotate(180deg)',
          transition: 'transform 0.2s',
        }}>▾</span>
      </div>
      {expanded && (
        <div style={{ padding: '10px 14px', borderTop: `1px solid ${T.border}33`, fontSize: 11 }}>
          <div style={{ marginBottom: 8, color: T.textTertiary, fontSize: 10, lineHeight: 1.6 }}>
            <strong style={{ color: T.textSecondary }}>Run ID:</strong> <code style={{ fontFamily: T.fontMono }}>{run.runId}</code>
            {run.completedAt && <> · <strong>Duration:</strong> {_fmtDuration(run.durationSec)} · <strong>Exit:</strong> {run.exitCode}</>}
          </div>
          <div style={{ marginBottom: 8, color: T.textTertiary, fontSize: 10, lineHeight: 1.6 }}>
            <strong style={{ color: T.textSecondary }}>Options:</strong>{' '}
            {Object.entries(run.options || {}).map(([k, v]) => (
              <span key={k} style={{ marginRight: 10 }}>
                <code style={{ fontFamily: T.fontMono, color: T.accentHi }}>{k}</code>=<code style={{ fontFamily: T.fontMono }}>{Array.isArray(v) ? v.join(',') : String(v).slice(0, 30)}</code>
              </span>
            ))}
          </div>
          {outputs && outputs.files && outputs.files.length > 0 && (
            <>
              <div style={{ marginTop: 10, marginBottom: 6, fontWeight: 600, fontSize: 11, color: T.textPrimary }}>
                Output files ({outputs.files.length}):
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {outputs.files.filter(f => !f.isDir).map(f => (
                  <button key={f.name} onClick={() => loadFile(f.name)}
                    title={f.name + (f.isBinary ? ' (binary)' : '')}
                    style={{
                      background: activeFile === f.name ? T.accentDim : T.bg2,
                      border: `1px solid ${activeFile === f.name ? T.accent : T.border}`,
                      color: activeFile === f.name ? T.accentHi : T.textSecondary,
                      padding: '4px 9px', borderRadius: 4,
                      fontSize: 10, fontFamily: T.fontMono,
                      cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                    }}>
                    {f.isBinary && <span style={{ fontSize: 9, color: T.amber }}>◆</span>}
                    {f.name === 'findings.txt' && <span style={{ fontSize: 9, color: T.green }}>★</span>}
                    {f.name}
                    <span style={{ color: T.textMuted, fontSize: 9 }}>
                      {f.size > 1024 ? `${(f.size/1024).toFixed(1)}KB` : `${f.size}B`}
                    </span>
                  </button>
                ))}
              </div>
              {activeFile && (
                <FileContentView
                  content={fileContent}
                  wbId={wbId}
                  runId={run.runId}
                  apiKey={apiKey}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ToolLauncherPanel({ wbId, apiKey, reconRunning, isMobile, onLaunched }) {
  const [registry, setRegistry] = React.useState([]);
  const [selectedToolId, setSelectedToolId] = React.useState(null);
  const [formValues, setFormValues] = React.useState({});
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [runs, setRuns] = React.useState([]);
  const [activeRun, setActiveRun] = React.useState(null);
  const [expanded, setExpanded] = React.useState(true);
  const [reconFiles, setReconFiles] = React.useState([]);
  // Modal state — when a tool is launched, opens a modal showing live progress
  const [modalRun, setModalRun] = React.useState(null);  // { runId, toolLabel, toolIcon }

  // Load tool registry once
  React.useEffect(() => {
    fetch('/api/workbenches/tools/registry', {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    }).then(r => r.json()).then(d => {
      setRegistry(d.tools || []);
    }).catch(() => {});
  }, [apiKey]);

  // Load tool runs + poll while a tool is active
  const loadRuns = React.useCallback(async () => {
    if (!wbId) return;
    try {
      const r = await fetch(`/api/workbenches/${wbId}/tools/runs`, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      if (r.ok) {
        const d = await r.json();
        setRuns(d.runs || []);
        setActiveRun(d.active || null);
      }
    } catch {}
  }, [wbId, apiKey]);

  React.useEffect(() => { loadRuns(); }, [loadRuns]);

  // Poll while a tool is running
  React.useEffect(() => {
    if (!activeRun) {
      // One-shot refresh after stop
      const t = setTimeout(loadRuns, 1500);
      return () => clearTimeout(t);
    }
    const id = setInterval(loadRuns, 4000);
    return () => clearInterval(id);
  }, [activeRun, loadRuns]);

  // Load list of recon files (so we know which are available for input)
  React.useEffect(() => {
    if (!wbId) return;
    fetch(`/api/workbenches/${wbId}/recon-files`, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    }).then(r => r.json()).then(d => {
      setReconFiles(d.files || []);
    }).catch(() => {});
  }, [wbId, apiKey, runs.length]);  // refresh after each run

  // When user picks a tool, initialize form with defaults
  React.useEffect(() => {
    if (!selectedToolId) return;
    const tool = registry.find(t => t.id === selectedToolId);
    if (!tool) return;
    const reconFileNames = new Set(reconFiles.map(f => f.name));
    const initial = {};
    for (const f of tool.inputs) {
      if (f.default !== undefined) {
        initial[f.name] = f.default;
      } else if (f.type === 'file' && Array.isArray(f.accepts) && f.accepts.length > 0) {
        // File fields have no `default` in the registry — pick first available file
        // that exists in the workbench's recon directory if possible
        const available = f.accepts.filter(name => reconFileNames.has(name));
        initial[f.name] = available.length > 0 ? available[0] : f.accepts[0];
      } else if (f.type === 'select' && Array.isArray(f.options) && f.options.length > 0) {
        // Select with no default — pick first option
        initial[f.name] = f.options[0].value;
      } else if (f.type === 'multi') {
        initial[f.name] = [];
      } else if (f.type === 'string') {
        initial[f.name] = '';
      } else if (f.type === 'boolean') {
        initial[f.name] = false;
      }
    }
    setFormValues(initial);
    setError(null);
  }, [selectedToolId, registry, reconFiles]);

  const submit = async () => {
    if (!selectedToolId) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/workbenches/${wbId}/tools/${selectedToolId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
        body: JSON.stringify(formValues),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || 'Failed to start');
      } else {
        const tool = registry.find(t => t.id === selectedToolId);
        onLaunched && onLaunched(selectedToolId);
        // Open the run modal so user sees live progress
        setModalRun({
          runId: d.runId,
          toolLabel: tool?.label || selectedToolId,
          toolIcon: tool?.icon || '⚙',
        });
        setSelectedToolId(null);
        loadRuns();
      }
    } catch (e) {
      setError(e.message);
    }
    setSubmitting(false);
  };

  const selectedTool = registry.find(t => t.id === selectedToolId);
  const reconFileNames = new Set(reconFiles.map(f => f.name));

  // Adjust file fields' accepted list to only show files that exist (intersection)
  const filteredFields = selectedTool ? selectedTool.inputs.map(f => {
    if (f.type !== 'file') return f;
    const available = (f.accepts || []).filter(name => reconFileNames.has(name));
    return { ...f, accepts: available.length > 0 ? available : f.accepts };
  }) : [];

  const noRecon = reconFiles.length === 0;
  const totalRuns = runs.length;
  const completedRuns = runs.filter(r => r.status === 'completed').length;

  return (
    <div style={{
      background: T.bg1,
      border: `1px solid ${T.border}`,
      borderRadius: 8,
      overflow: 'hidden',
      flexShrink: 0,
    }}>
      <div onClick={() => setExpanded(e => !e)}
        style={{
          padding: '10px 14px',
          background: T.bg2,
          borderBottom: expanded ? `1px solid ${T.border}` : 'none',
          display: 'flex', alignItems: 'center', gap: 10,
          cursor: 'pointer', userSelect: 'none',
          fontSize: 11,
        }}>
        <span style={{ color: T.accentHi, fontSize: 13 }}>⚙</span>
        <span style={{
          fontWeight: 600, color: T.textPrimary,
          letterSpacing: 0.4, textTransform: 'uppercase',
        }}>Tools</span>
        {activeRun && (
          <span style={{
            background: T.amber + '22',
            border: `1px solid ${T.amber}55`,
            color: T.amber,
            fontSize: 9, fontWeight: 700,
            padding: '2px 7px', borderRadius: 3,
            animation: 'pulse 1.5s infinite',
          }}>● {activeRun.toolId} RUNNING</span>
        )}
        <span style={{
          background: T.bg0, color: T.textTertiary,
          padding: '2px 7px', borderRadius: 3,
          fontSize: 9, fontFamily: T.fontMono,
        }}>{completedRuns} / {totalRuns} runs</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: T.textMuted, fontSize: 10 }}>
          Launch FFUF, Arjun, JS analyzer, Nuclei, Reflection
        </span>
        <span style={{
          color: T.textTertiary, fontSize: 11,
          transform: expanded ? 'rotate(0deg)' : 'rotate(180deg)',
          transition: 'transform 0.2s',
        }}>▾</span>
      </div>

      {expanded && (
        <div>
          {/* Pre-flight warning */}
          {noRecon && (
            <div style={{
              background: T.amber + '15', borderBottom: `1px solid ${T.amber}33`,
              padding: '8px 14px', fontSize: 11, color: T.amber, lineHeight: 1.5,
            }}>
              ⚠ Baseline recon hasn't produced any files yet. Run baseline first or wait for it to finish.
            </div>
          )}
          {reconRunning && (
            <div style={{
              background: T.amber + '15', borderBottom: `1px solid ${T.amber}33`,
              padding: '8px 14px', fontSize: 11, color: T.amber, lineHeight: 1.5,
            }}>
              Baseline recon is running. Tools will be available after it completes.
            </div>
          )}

          {/* Tool picker */}
          <div style={{ padding: 10, background: T.bg0, borderBottom: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: T.textTertiary,
                          textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
              Launch a tool
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(5, 1fr)',
              gap: 6,
            }}>
              {registry.map(t => {
                const active = selectedToolId === t.id;
                const disabled = noRecon || reconRunning || !!activeRun;
                return (
                  <button key={t.id}
                    onClick={() => !disabled && setSelectedToolId(active ? null : t.id)}
                    disabled={disabled}
                    title={t.description}
                    style={{
                      background: active ? T.accentDim : T.bg2,
                      border: `1px solid ${active ? T.accent : T.border}`,
                      color: active ? T.accentHi : (disabled ? T.textMuted : T.textSecondary),
                      borderRadius: 6, padding: '10px 8px',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      textAlign: 'center', fontSize: 11,
                      transition: 'all 0.15s',
                      opacity: disabled ? 0.5 : 1,
                    }}>
                    <div style={{ fontSize: 16, marginBottom: 4 }}>{t.icon}</div>
                    <div style={{ fontWeight: 600 }}>{t.label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Selected tool form */}
          {selectedTool && (
            <div style={{ padding: 14, background: T.bg0, borderBottom: `1px solid ${T.border}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                <span style={{ color: T.accentHi, fontSize: 14 }}>{selectedTool.icon}</span>
                <span style={{ fontWeight: 600, fontSize: 13, color: T.textPrimary }}>{selectedTool.label}</span>
                <span style={{ fontSize: 10, color: T.textMuted }}>· {selectedTool.estimatedTime}</span>
              </div>
              <div style={{ fontSize: 11, color: T.textTertiary, marginBottom: 12, lineHeight: 1.5 }}>
                {selectedTool.longDescription}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {filteredFields.map(field => (
                  <div key={field.name}>
                    <label style={{
                      display: 'block', fontSize: 11, color: T.textSecondary,
                      marginBottom: 4, fontWeight: 500,
                    }}>
                      {field.label} {field.required && <span style={{ color: T.red }}>*</span>}
                    </label>
                    <ToolFormField
                      field={field}
                      value={formValues[field.name]}
                      onChange={v => setFormValues(s => ({ ...s, [field.name]: v }))}
                      disabled={submitting}
                    />
                  </div>
                ))}
              </div>
              {error && (
                <div style={{
                  marginTop: 12, padding: '8px 10px',
                  background: T.red + '15', border: `1px solid ${T.red}55`,
                  color: T.red, borderRadius: 5, fontSize: 11,
                }}>{error}</div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
                <button onClick={() => setSelectedToolId(null)} disabled={submitting}
                  style={{
                    background: 'transparent', border: `1px solid ${T.border}`,
                    color: T.textSecondary, padding: '7px 14px',
                    borderRadius: 5, fontSize: 12, cursor: 'pointer',
                  }}>Cancel</button>
                <button onClick={submit} disabled={submitting || !!activeRun}
                  style={{
                    background: `linear-gradient(135deg, ${T.accent}, #1D4ED8)`,
                    color: '#fff', border: 'none',
                    padding: '7px 16px', borderRadius: 5,
                    fontSize: 12, fontWeight: 600,
                    cursor: submitting ? 'wait' : 'pointer',
                    opacity: (submitting || !!activeRun) ? 0.5 : 1,
                  }}>
                  {submitting ? 'Starting...' : `▶ Run ${selectedTool.label}`}
                </button>
              </div>
            </div>
          )}

          {/* Run history */}
          {runs.length > 0 && (
            <div>
              <div style={{
                padding: '8px 14px', background: T.bg0,
                fontSize: 10, fontWeight: 600, color: T.textTertiary,
                textTransform: 'uppercase', letterSpacing: 0.5,
                borderBottom: `1px solid ${T.border}`,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span>Recent runs</span>
                <button onClick={loadRuns} title="Refresh"
                  style={{
                    background: 'transparent', border: 'none',
                    color: T.textTertiary, fontSize: 11, cursor: 'pointer',
                    padding: 0, marginLeft: 'auto',
                  }}>↻</button>
              </div>
              <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {runs.slice(0, 50).map(run => (
                  <RunRow key={run.runId} run={run} wbId={wbId} apiKey={apiKey} onRefresh={loadRuns} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {/* Run modal — opens when user launches a tool */}
      {modalRun && (
        <ToolRunModal
          wbId={wbId}
          runId={modalRun.runId}
          apiKey={apiKey}
          toolLabel={modalRun.toolLabel}
          toolIcon={modalRun.toolIcon}
          onClose={() => { setModalRun(null); loadRuns(); }}
          onMinimize={() => { setModalRun(null); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ToolRunsTab — full-width view of all tool runs in a workbench
// Lives at the "Tool Runs" sidebar tab.
// ─────────────────────────────────────────────────────────────────────────

export function ToolRunsTab({ wbId, apiKey, isMobile }) {
  const [runs, setRuns] = React.useState([]);
  const [activeRun, setActiveRun] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [filter, setFilter] = React.useState('all'); // all | running | completed | failed
  const [toolFilter, setToolFilter] = React.useState('all'); // all | ffuf | arjun | ...

  const loadRuns = React.useCallback(async () => {
    if (!wbId) return;
    try {
      const r = await fetch(`/api/workbenches/${wbId}/tools/runs`, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      if (r.ok) {
        const d = await r.json();
        setRuns(d.runs || []);
        setActiveRun(d.active || null);
      }
    } catch {}
    setLoading(false);
  }, [wbId, apiKey]);

  React.useEffect(() => { loadRuns(); }, [loadRuns]);

  // Poll while a run is active
  React.useEffect(() => {
    if (!activeRun) return;
    const id = setInterval(loadRuns, 4000);
    return () => clearInterval(id);
  }, [activeRun, loadRuns]);

  // Filter runs
  const filtered = runs.filter(r => {
    if (filter !== 'all' && r.status !== filter) return false;
    if (toolFilter !== 'all' && r.toolId !== toolFilter) return false;
    return true;
  });

  // Compute aggregate stats
  const stats = {
    total: runs.length,
    completed: runs.filter(r => r.status === 'completed').length,
    failed: runs.filter(r => r.status === 'failed').length,
    running: runs.filter(r => r.status === 'running').length,
    totalFindings: runs.reduce((sum, r) => sum + (r.findings?.count || 0), 0),
  };

  const uniqueTools = Array.from(new Set(runs.map(r => r.toolId)));

  return (
    <div style={{
      flex: 1, minHeight: 0,
      background: T.bg1, border: `1px solid ${T.border}`,
      borderRadius: 8, display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${T.border}`,
        background: T.bg2,
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        flexWrap: isMobile ? 'wrap' : 'nowrap',
      }}>
        <span style={{ color: T.accentHi, fontSize: 13 }}>⚙</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: T.textPrimary }}>Tool Runs</span>
        <span style={{
          background: T.bg0, color: T.textTertiary,
          padding: '1px 7px', borderRadius: 3,
          fontSize: 10, fontFamily: T.fontMono,
        }}>{runs.length}</span>
        {activeRun && (
          <span style={{
            background: T.amber + '22',
            border: `1px solid ${T.amber}55`,
            color: T.amber,
            fontSize: 9, fontWeight: 700,
            padding: '2px 7px', borderRadius: 3,
            animation: 'pulse 1.5s infinite',
          }}>● {activeRun.toolId} RUNNING</span>
        )}
        <span style={{ flex: 1 }} />
        <button onClick={loadRuns} title="Refresh"
          style={{
            background: T.bg2, border: `1px solid ${T.border}`,
            color: T.textTertiary, padding: '4px 10px',
            borderRadius: 5, fontSize: 11, cursor: 'pointer',
          }}>↻</button>
      </div>

      {/* Aggregate stats */}
      {runs.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? 'repeat(3, 1fr)' : 'repeat(5, 1fr)',
          gap: 1, background: T.border,
          flexShrink: 0,
        }}>
          <StatTile label="Total runs"  value={stats.total}      color={T.textPrimary} />
          <StatTile label="Completed"   value={stats.completed}  color={T.green} />
          <StatTile label="Failed"      value={stats.failed}     color={T.red} />
          <StatTile label="Running"     value={stats.running}    color={T.amber} />
          <StatTile label="Findings"    value={stats.totalFindings} color={T.accentHi} />
        </div>
      )}

      {/* Filter bar */}
      {runs.length > 0 && (
        <div style={{
          padding: '8px 14px', background: T.bg0,
          borderBottom: `1px solid ${T.border}`,
          display: 'flex', gap: 8, flexShrink: 0,
          flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 9, fontWeight: 600, color: T.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 4 }}>Status:</span>
            {['all', 'running', 'completed', 'failed'].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                style={{
                  background: filter === f ? T.accentDim : 'transparent',
                  border: `1px solid ${filter === f ? T.accent : T.border}`,
                  color: filter === f ? T.accentHi : T.textTertiary,
                  padding: '3px 9px', borderRadius: 4,
                  fontSize: 10, cursor: 'pointer',
                  textTransform: 'capitalize',
                }}>{f}</button>
            ))}
          </div>
          {uniqueTools.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 9, fontWeight: 600, color: T.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 4 }}>Tool:</span>
              <button onClick={() => setToolFilter('all')}
                style={{
                  background: toolFilter === 'all' ? T.accentDim : 'transparent',
                  border: `1px solid ${toolFilter === 'all' ? T.accent : T.border}`,
                  color: toolFilter === 'all' ? T.accentHi : T.textTertiary,
                  padding: '3px 9px', borderRadius: 4,
                  fontSize: 10, cursor: 'pointer',
                }}>all</button>
              {uniqueTools.map(t => (
                <button key={t} onClick={() => setToolFilter(t)}
                  style={{
                    background: toolFilter === t ? T.accentDim : 'transparent',
                    border: `1px solid ${toolFilter === t ? T.accent : T.border}`,
                    color: toolFilter === t ? T.accentHi : T.textTertiary,
                    padding: '3px 9px', borderRadius: 4,
                    fontSize: 10, fontFamily: T.fontMono, cursor: 'pointer',
                  }}>{t}</button>
              ))}
            </div>
          )}
          {(filter !== 'all' || toolFilter !== 'all') && (
            <span style={{ fontSize: 10, color: T.textMuted, alignSelf: 'center' }}>
              Showing {filtered.length} of {runs.length}
            </span>
          )}
        </div>
      )}

      {/* Run list (full body) */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: T.textMuted, fontSize: 12 }}>
            Loading...
          </div>
        ) : runs.length === 0 ? (
          <div style={{
            padding: 30, textAlign: 'center',
            color: T.textMuted, fontSize: 12,
          }}>
            <div style={{ fontSize: 32, opacity: 0.4, marginBottom: 12 }}>⚙</div>
            <div style={{ color: T.textSecondary, fontSize: 13, marginBottom: 6 }}>
              No tool runs yet
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.6, maxWidth: 360, margin: '0 auto' }}>
              Launch a tool from the Overview tab — runs and their output files will appear here.
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: T.textMuted, fontSize: 12 }}>
            No runs match the current filter.
          </div>
        ) : (
          <div>
            {filtered.map(run => (
              <RunRow key={run.runId} run={run} wbId={wbId} apiKey={apiKey} onRefresh={loadRuns} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Small reusable stat tile (used by ToolRunsTab)
function StatTile({ label, value, color }) {
  return (
    <div style={{
      background: T.bg1, padding: '8px 12px',
      display: 'flex', flexDirection: 'column',
      alignItems: 'flex-start', justifyContent: 'center',
      minHeight: 50,
    }}>
      <span style={{
        fontSize: 9, color: T.textMuted, fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: 0.5,
      }}>{label}</span>
      <span style={{
        fontSize: 18, fontWeight: 600, color: color || T.textPrimary,
        fontFamily: T.fontMono, marginTop: 2,
      }}>{value}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ToolRunModal — modal that opens when you launch a tool. Shows live
// status + chat messages tagged with this run's icon. Closeable when done.
// ─────────────────────────────────────────────────────────────────────────

export function ToolRunModal({ wbId, runId, apiKey, toolLabel, toolIcon, onClose, onMinimize }) {
  const [run, setRun] = React.useState(null);
  const [output, setOutput] = React.useState(null);
  const [activeFile, setActiveFile] = React.useState(null);
  const [fileContent, setFileContent] = React.useState(null);
  const [stopping, setStopping] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);

  const isRunning = run?.status === 'running';
  const isDone = run && !isRunning;

  // Load run status — poll while running, single shot when done
  const loadRun = React.useCallback(async () => {
    if (!wbId || !runId) return;
    try {
      const r = await fetch(`/api/workbenches/${wbId}/tools/runs/${runId}`, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      if (r.ok) {
        const d = await r.json();
        setRun(d.run);
        setOutput(d.output);
      }
    } catch {}
  }, [wbId, runId, apiKey]);

  React.useEffect(() => { loadRun(); }, [loadRun]);

  React.useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(loadRun, 2000);
    return () => clearInterval(id);
  }, [isRunning, loadRun]);

  // Local elapsed-time ticker
  React.useEffect(() => {
    if (!run?.startedAt) return;
    const tick = () => setElapsed(Math.floor((Date.now() - run.startedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [run?.startedAt]);

  const fmtSec = (s) => {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s/60)}m ${s % 60}s`;
    return `${Math.floor(s/3600)}h ${Math.floor((s % 3600)/60)}m`;
  };

  const stop = async () => {
    if (!runId) return;
    setStopping(true);
    try {
      await fetch(`/api/workbenches/${wbId}/tools/runs/${runId}/stop`, {
        method: 'POST',
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      await new Promise(r => setTimeout(r, 1000));
      loadRun();
    } catch {}
    setStopping(false);
  };

  const loadFile = async (fname) => {
    setActiveFile(fname);
    setFileContent('Loading...');
    try {
      const safeName = fname.split('/').map(encodeURIComponent).join('/');
      const r = await fetch(`/api/workbenches/${wbId}/tools/runs/${runId}/output/${safeName}`, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      const d = await r.json();
      if (r.ok) {
        setFileContent(d.content);
      } else if (r.status === 415 && d.error === 'binary') {
        setFileContent({ binary: true, size: d.size, message: d.message, fname });
      } else if (r.status === 415 && d.error === 'directory') {
        setFileContent({ directory: true, message: d.message });
      } else if (r.status === 415 && d.error === 'too_large') {
        setFileContent({ tooLarge: true, message: d.message, fname });
      } else {
        setFileContent('Failed to load: ' + (d.error || r.statusText));
      }
    } catch (e) {
      setFileContent('Error: ' + e.message);
    }
  };

  // Status header colour
  const statusColor =
    !run                       ? T.textTertiary :
    run.status === 'running'   ? T.amber :
    run.status === 'completed' ? T.green :
    run.status === 'stopped'   ? T.textMuted :
                                 T.red;

  const statusLabel =
    !run                       ? 'STARTING' :
    run.status === 'running'   ? 'RUNNING' :
    run.status === 'completed' ? 'COMPLETED' :
    run.status === 'stopped'   ? 'STOPPED' :
                                 'FAILED';

  return (
    <div onClick={isDone ? onClose : null}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0, 0, 0, 0.65)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: 20,
      }}>
      <div onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 720, maxHeight: '90vh',
          background: T.bg1, border: `1px solid ${T.border}`,
          borderRadius: 12, overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
        }}>
        {/* Header */}
        <div style={{
          padding: '14px 18px', background: T.bg2,
          borderBottom: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0,
        }}>
          <span style={{ fontSize: 18, color: T.accentHi }}>{toolIcon || '⚙'}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary }}>
              {toolLabel || 'Tool run'}
            </div>
            <div style={{ fontSize: 10, color: T.textMuted, fontFamily: T.fontMono, marginTop: 2 }}>
              {runId || 'allocating run...'}
            </div>
          </div>
          <span style={{
            background: statusColor + '22',
            border: `1px solid ${statusColor}55`,
            color: statusColor,
            fontSize: 10, fontWeight: 700,
            padding: '4px 10px', borderRadius: 4,
            letterSpacing: 0.6,
            animation: isRunning ? 'pulse 1.5s infinite' : 'none',
          }}>
            {isRunning && '● '}{statusLabel}
          </span>
          <span style={{
            fontSize: 11, color: T.textTertiary, fontFamily: T.fontMono,
            minWidth: 60, textAlign: 'right',
          }}>{fmtSec(elapsed)}</span>
        </div>

        {/* Body — scrollable */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {/* Summary line if available */}
          {run?.findings?.summary && (
            <div style={{
              padding: '10px 14px',
              background: run.status === 'failed' ? T.red + '15' : T.accentDim,
              border: `1px solid ${run.status === 'failed' ? T.red + '55' : T.accent + '44'}`,
              borderRadius: 6, marginBottom: 14,
              fontSize: 12, color: run.status === 'failed' ? T.red : T.textPrimary,
              lineHeight: 1.5,
            }}>
              {run.findings.summary}
            </div>
          )}

          {/* Run options collapsible */}
          {run?.options && (
            <div style={{ marginBottom: 14 }}>
              <div style={{
                fontSize: 9, fontWeight: 600, color: T.textMuted,
                textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6,
              }}>Options used</div>
              <div style={{
                background: T.bg0, border: `1px solid ${T.border}`,
                borderRadius: 5, padding: '8px 12px',
                fontSize: 10, fontFamily: T.fontMono,
                color: T.textSecondary, lineHeight: 1.7,
              }}>
                {Object.entries(run.options).map(([k, v]) => (
                  <div key={k}>
                    <span style={{ color: T.accentHi }}>{k}</span>
                    <span style={{ color: T.textTertiary }}> = </span>
                    <span>{Array.isArray(v) ? v.join(', ') : String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Output files */}
          {output?.files?.length > 0 && (
            <div>
              <div style={{
                fontSize: 9, fontWeight: 600, color: T.textMuted,
                textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6,
              }}>Output files ({output.files.length})</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {output.files.filter(f => !f.isDir).map(f => (
                  <button key={f.name} onClick={() => loadFile(f.name)}
                    title={f.name + (f.isBinary ? ' (binary)' : '')}
                    style={{
                      background: activeFile === f.name ? T.accentDim : T.bg2,
                      border: `1px solid ${activeFile === f.name ? T.accent : T.border}`,
                      color: activeFile === f.name ? T.accentHi : T.textSecondary,
                      padding: '5px 10px', borderRadius: 4,
                      fontSize: 10, fontFamily: T.fontMono,
                      cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                    }}>
                    {f.isBinary && <span style={{ fontSize: 9, color: T.amber }}>◆</span>}
                    {f.name === 'findings.txt' && <span style={{ fontSize: 9, color: T.green }}>★</span>}
                    {f.name}
                    <span style={{ color: T.textMuted, fontSize: 9 }}>
                      {f.size > 1024 ? `${(f.size/1024).toFixed(1)}KB` : `${f.size}B`}
                    </span>
                  </button>
                ))}
              </div>
              {activeFile && (
                <FileContentView
                  content={fileContent}
                  wbId={wbId}
                  runId={runId}
                  apiKey={apiKey}
                />
              )}
            </div>
          )}

          {!run && (
            <div style={{
              padding: 30, textAlign: 'center',
              color: T.textTertiary, fontSize: 12,
            }}>
              <div style={{ fontSize: 24, marginBottom: 8, animation: 'pulse 1.5s infinite' }}>⏱</div>
              Allocating run...
            </div>
          )}
          {isRunning && !output?.files?.length && (
            <div style={{
              padding: 24, textAlign: 'center',
              color: T.textTertiary, fontSize: 12,
            }}>
              <div style={{ fontSize: 24, marginBottom: 8, animation: 'pulse 1.5s infinite' }}>{toolIcon || '⚙'}</div>
              Tool is running. Watch the chat for live output, or come back to this screen later.
              <div style={{ fontSize: 10, color: T.textMuted, marginTop: 10, lineHeight: 1.6 }}>
                You can minimize this and the tool will keep running. Output files will appear here as they're written.
              </div>
            </div>
          )}
        </div>

        {/* Footer with action buttons */}
        <div style={{
          padding: '12px 18px', background: T.bg2,
          borderTop: `1px solid ${T.border}`,
          display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0,
        }}>
          {isRunning && (
            <button onClick={stop} disabled={stopping}
              style={{
                background: T.red + '22', border: `1px solid ${T.red}55`,
                color: T.red, padding: '7px 14px',
                borderRadius: 5, fontSize: 12, fontWeight: 500,
                cursor: stopping ? 'wait' : 'pointer',
              }}>
              {stopping ? 'Stopping...' : '■ Stop run'}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button onClick={onMinimize}
            style={{
              background: 'transparent', border: `1px solid ${T.border}`,
              color: T.textSecondary, padding: '7px 14px',
              borderRadius: 5, fontSize: 12, cursor: 'pointer',
            }}>
            {isRunning ? 'Minimize (keep running)' : 'Hide'}
          </button>
          {isDone && (
            <button onClick={onClose}
              style={{
                background: `linear-gradient(135deg, ${T.accent}, #1D4ED8)`,
                border: 'none', color: '#fff',
                padding: '7px 18px', borderRadius: 5,
                fontSize: 12, fontWeight: 600,
                cursor: 'pointer',
              }}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// FindingsTab — aggregated, ranked list of all findings across every tool
// ─────────────────────────────────────────────────────────────────────────

const SEV_COLORS = {
  critical: '#DC2626',
  high:     '#EA580C',
  medium:   '#CA8A04',
  low:      '#0891B2',
  info:     '#6B7280',
  unknown:  '#9CA3AF',
};

function SevPill({ severity }) {
  const color = SEV_COLORS[severity] || SEV_COLORS.unknown;
  return (
    <span style={{
      background: color + '22',
      border: `1px solid ${color}55`,
      color, fontSize: 9, fontWeight: 700,
      padding: '2px 7px', borderRadius: 3,
      letterSpacing: 0.5, textTransform: 'uppercase',
      minWidth: 56, textAlign: 'center', display: 'inline-block',
    }}>{severity || 'info'}</span>
  );
}

export function FindingsTab({ wbId, apiKey, isMobile }) {
  const [findings, setFindings] = React.useState([]);
  const [stats, setStats] = React.useState({ total: 0, bySeverity: {}, byTool: {} });
  const [sevFilter, setSevFilter] = React.useState('all');
  const [toolFilter, setToolFilter] = React.useState('all');
  const [searchTerm, setSearchTerm] = React.useState('');
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    if (!wbId) return;
    try {
      const r = await fetch(`/api/workbenches/${wbId}/findings`, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      if (r.ok) {
        const d = await r.json();
        setFindings(d.findings || []);
        setStats({ total: d.total || 0, bySeverity: d.bySeverity || {}, byTool: d.byTool || {} });
      }
    } catch {}
    setLoading(false);
  }, [wbId, apiKey]);

  React.useEffect(() => { load(); }, [load]);
  // Auto-refresh every 8s in case tools are running
  React.useEffect(() => {
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [load]);

  const filtered = findings.filter(f => {
    if (sevFilter !== 'all' && f.severity !== sevFilter) return false;
    if (toolFilter !== 'all' && f.tool !== toolFilter) return false;
    if (searchTerm) {
      const t = searchTerm.toLowerCase();
      if (!(f.title || '').toLowerCase().includes(t) &&
          !(f.target || '').toLowerCase().includes(t)) return false;
    }
    return true;
  });

  const uniqueTools = Object.keys(stats.byTool).sort();

  return (
    <div style={{
      flex: 1, minHeight: 0,
      background: T.bg1, border: `1px solid ${T.border}`,
      borderRadius: 8, display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${T.border}`,
        background: T.bg2,
        display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
        flexWrap: isMobile ? 'wrap' : 'nowrap',
      }}>
        <span style={{ color: T.red, fontSize: 13 }}>🚨</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: T.textPrimary }}>Findings</span>
        <span style={{
          background: T.bg0, color: T.textTertiary,
          padding: '1px 7px', borderRadius: 3,
          fontSize: 10, fontFamily: T.fontMono,
        }}>{stats.total}</span>
        <span style={{ flex: 1 }} />
        <button onClick={load} title="Refresh"
          style={{
            background: T.bg2, border: `1px solid ${T.border}`,
            color: T.textTertiary, padding: '4px 10px',
            borderRadius: 5, fontSize: 11, cursor: 'pointer',
          }}>↻</button>
      </div>

      {/* Severity counters */}
      {stats.total > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(6, 1fr)',
          gap: 1, background: T.border,
          flexShrink: 0,
        }}>
          {['critical','high','medium','low','info','unknown'].map(sev => {
            const count = stats.bySeverity[sev] || 0;
            const color = SEV_COLORS[sev];
            return (
              <div key={sev}
                onClick={() => setSevFilter(sevFilter === sev ? 'all' : sev)}
                style={{
                  background: sevFilter === sev ? color + '22' : T.bg1,
                  padding: '8px 10px',
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'flex-start', justifyContent: 'center',
                  minHeight: 50, cursor: 'pointer',
                  transition: 'background 0.15s',
                }}>
                <span style={{
                  fontSize: 9, fontWeight: 700, color, letterSpacing: 0.5,
                  textTransform: 'uppercase',
                }}>{sev}</span>
                <span style={{
                  fontSize: 18, fontWeight: 600, color: count > 0 ? color : T.textMuted,
                  fontFamily: T.fontMono, marginTop: 2,
                }}>{count}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Filter bar */}
      {stats.total > 0 && (
        <div style={{
          padding: '8px 14px', background: T.bg0,
          borderBottom: `1px solid ${T.border}`,
          display: 'flex', gap: 8, flexShrink: 0,
          flexWrap: 'wrap', alignItems: 'center',
        }}>
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="Search title or target..."
            style={{
              background: T.bg2, border: `1px solid ${T.border}`,
              color: T.textPrimary, borderRadius: 4,
              padding: '4px 9px', fontSize: 11, fontFamily: T.fontSans,
              minWidth: 220, flex: '0 0 auto',
            }}
          />
          {uniqueTools.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 9, fontWeight: 600, color: T.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Tool:</span>
              <button onClick={() => setToolFilter('all')}
                style={{
                  background: toolFilter === 'all' ? T.accentDim : 'transparent',
                  border: `1px solid ${toolFilter === 'all' ? T.accent : T.border}`,
                  color: toolFilter === 'all' ? T.accentHi : T.textTertiary,
                  padding: '3px 9px', borderRadius: 4,
                  fontSize: 10, cursor: 'pointer',
                }}>all</button>
              {uniqueTools.map(t => (
                <button key={t} onClick={() => setToolFilter(t)}
                  style={{
                    background: toolFilter === t ? T.accentDim : 'transparent',
                    border: `1px solid ${toolFilter === t ? T.accent : T.border}`,
                    color: toolFilter === t ? T.accentHi : T.textTertiary,
                    padding: '3px 9px', borderRadius: 4,
                    fontSize: 10, fontFamily: T.fontMono, cursor: 'pointer',
                  }}>{t} <span style={{ color: T.textMuted }}>({stats.byTool[t]})</span></button>
              ))}
            </div>
          )}
          {(sevFilter !== 'all' || toolFilter !== 'all' || searchTerm) && (
            <span style={{ fontSize: 10, color: T.textMuted, marginLeft: 'auto' }}>
              Showing {filtered.length} of {stats.total}
            </span>
          )}
        </div>
      )}

      {/* Findings list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: T.textMuted, fontSize: 12 }}>
            Loading findings...
          </div>
        ) : findings.length === 0 ? (
          <div style={{
            padding: 30, textAlign: 'center',
            color: T.textMuted, fontSize: 12,
          }}>
            <div style={{ fontSize: 32, opacity: 0.4, marginBottom: 12 }}>🔍</div>
            <div style={{ color: T.textSecondary, fontSize: 13, marginBottom: 6 }}>
              No findings yet
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.6, maxWidth: 360, margin: '0 auto' }}>
              Run tools (Nuclei, FFUF, Reflection, JS Analyzer, etc.) — their findings will appear here, ranked by severity.
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: T.textMuted, fontSize: 12 }}>
            No findings match the current filters.
          </div>
        ) : (
          <div>
            {filtered.map((f, i) => (
              <div key={i} style={{
                padding: '10px 14px',
                borderBottom: `1px solid ${T.border}33`,
                display: 'flex', alignItems: 'center', gap: 10,
                fontSize: 11,
              }}>
                <SevPill severity={f.severity} />
                <span style={{ color: T.textTertiary, fontSize: 14, width: 18, textAlign: 'center' }}>
                  {f.icon}
                </span>
                <span style={{
                  background: T.bg2, color: T.textTertiary,
                  fontSize: 9, fontFamily: T.fontMono,
                  padding: '2px 6px', borderRadius: 3,
                  minWidth: 70, textAlign: 'center',
                }}>{f.tool}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: T.textPrimary, fontSize: 12, fontWeight: 500,
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {f.title}
                  </div>
                  <div style={{ color: T.textTertiary, fontSize: 10, fontFamily: T.fontMono, marginTop: 2,
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {f.target}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
