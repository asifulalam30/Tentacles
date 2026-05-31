import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Sidebar, ShellHeader, StatCards, ReconTable, RerunModal, LiveScanPanel, HeaderPhasePill, ToolLauncherPanel, ToolRunsTab, FindingsTab, RECON_FILES_ORDERED } from './WorkbenchShell';

// ─────────────────────────────────────────────────────────────────────────
// Error Boundary — catches React render errors so the screen stays usable
// ─────────────────────────────────────────────────────────────────────────
class WorkbenchErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('Workbench render error:', error, info);
    this.setState({ info });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: '#0B0F1A', color: '#F0F4FC',
          padding: 24, overflow: 'auto',
          fontFamily: "'DM Sans', system-ui, sans-serif",
        }}>
          <div style={{ maxWidth: 720, margin: '40px auto' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#F87171', marginBottom: 12 }}>
              ⚠ Workbench crashed
            </div>
            <div style={{ fontSize: 13, color: '#94A8C4', marginBottom: 16, lineHeight: 1.6 }}>
              The workbench hit a render error. The data on the server is fine — this is a UI-only issue.
              Click "Reload" to recover, or "Go home" to pick a different workbench.
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              <button onClick={() => window.location.reload()} style={{
                background: '#3B82F6', color: '#fff', border: 'none',
                padding: '8px 14px', borderRadius: 6, fontSize: 13,
                fontWeight: 500, cursor: 'pointer',
              }}>↻ Reload</button>
              <button onClick={() => { this.props.onClose && this.props.onClose(); this.setState({ hasError: false, error: null, info: null }); }} style={{
                background: 'transparent', color: '#94A8C4',
                border: '1px solid #1E2D45', padding: '8px 14px',
                borderRadius: 6, fontSize: 13, cursor: 'pointer',
              }}>← Go home</button>
            </div>
            <details style={{ background: '#111827', border: '1px solid #1E2D45', borderRadius: 6, padding: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: '#94A8C4' }}>Error details</summary>
              <pre style={{
                marginTop: 10, padding: 10, background: '#0B0F1A',
                borderRadius: 4, fontSize: 11, color: '#F87171',
                fontFamily: "'JetBrains Mono', monospace",
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                maxHeight: 400, overflow: 'auto',
              }}>{String(this.state.error?.stack || this.state.error || 'Unknown')}{'\n\n'}{this.state.info?.componentStack || ''}</pre>
            </details>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}



const _RECON_PHASES = {
  starting: { label: 'Starting', pct: 5 },
  subdomain_enum: { label: 'Subdomain enum', pct: 25 },
  alive_probing: { label: 'Probing alive', pct: 50 },
  dangling_check: { label: 'Dangling DNS', pct: 70 },
  js_analysis: { label: 'JS analysis', pct: 90 },
  recon_running: { label: 'Recon running', pct: 60 },
  brief_generation: { label: 'Building brief', pct: 95 },
};

// Theme matches App.jsx
const T = {
  bg0: '#0B0F1A', bg1: '#111827', bg2: '#1A2236', bg3: '#243047',
  border: '#1E2D45', borderHi: '#2E4165',
  textPrimary: '#F0F4FC', textSecondary: '#94A8C4', textTertiary: '#6B82A0', textMuted: '#4A6080',
  accent: '#3B82F6', accentHi: '#60A5FA', accentDim: '#1D3461',
  green: '#4ADE80', amber: '#FBBF24', red: '#F87171', purple: '#A78BFA',
  fontMono: "'JetBrains Mono','Fira Code',monospace",
  fontSans: "'DM Sans','Segoe UI',system-ui,sans-serif",
};

const ROLE_STYLES = {
  user:      { bg: T.accentDim,  fg: T.textPrimary,   border: T.accent + '44',   align: 'right' },
  tentacles: { bg: T.bg1,        fg: T.textPrimary,   border: T.border,           align: 'left' },
  recon:     { bg: T.bg2,        fg: T.textSecondary, border: T.amber + '44',     align: 'left', accent: T.amber },
  system:    { bg: 'transparent', fg: T.textMuted,    border: T.border,           align: 'center' },
};

function fmtTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// ── Markdown-lite renderer (handles headers, code blocks, lists, bold) ────
function renderMarkdown(text) {
  if (!text) return null;
  // Step 1: extract code blocks first (so their content isn't mangled by other rules)
  const blocks = [];
  let working = text.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push({ type: 'code', lang, code });
    return `\x00BLOCK${blocks.length - 1}\x00`;
  });

  // Step 2: simple inline markdown
  // bold **text**
  working = working.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // inline code `code`
  working = working.replace(/`([^`]+)`/g, '<code>$1</code>');
  // links [text](url)
  working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Step 3: split into paragraphs, render structurally
  const lines = working.split('\n');
  const elements = [];
  let listBuffer = null;

  const flushList = () => {
    if (listBuffer) {
      elements.push(<ul key={`ul${elements.length}`} style={{ paddingLeft: 20, margin: '6px 0', color: T.textSecondary }}>
        {listBuffer.map((item, i) => (
          <li key={i} style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 2 }} dangerouslySetInnerHTML={{ __html: item }} />
        ))}
      </ul>);
      listBuffer = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Code block placeholder
    const codeBlockMatch = line.match(/^\x00BLOCK(\d+)\x00$/);
    if (codeBlockMatch) {
      flushList();
      const block = blocks[parseInt(codeBlockMatch[1], 10)];
      elements.push(<CodeBlock key={`cb${i}`} code={block.code} lang={block.lang} />);
      continue;
    }
    // Headers
    if (line.startsWith('### ')) { flushList(); elements.push(<h4 key={i} style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, margin: '10px 0 4px' }}>{line.slice(4)}</h4>); continue; }
    if (line.startsWith('## ')) { flushList(); elements.push(<h3 key={i} style={{ fontSize: 14, fontWeight: 600, color: T.textPrimary, margin: '10px 0 4px' }}>{line.slice(3)}</h3>); continue; }
    if (line.startsWith('# ')) { flushList(); elements.push(<h2 key={i} style={{ fontSize: 15, fontWeight: 600, color: T.textPrimary, margin: '12px 0 4px' }}>{line.slice(2)}</h2>); continue; }
    // List items
    const liMatch = line.match(/^\s*[-•]\s+(.+)$/);
    if (liMatch) {
      if (!listBuffer) listBuffer = [];
      listBuffer.push(liMatch[1]);
      continue;
    }
    flushList();
    // Empty line = paragraph break
    if (line.trim() === '') {
      elements.push(<div key={i} style={{ height: 6 }} />);
      continue;
    }
    elements.push(
      <div key={i} style={{ fontSize: 13, lineHeight: 1.6, color: T.textPrimary }}
           dangerouslySetInnerHTML={{ __html: line }} />
    );
  }
  flushList();
  return elements;
}

function CodeBlock({ code, lang }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div style={{
      background: T.bg0,
      border: `1px solid ${T.border}`,
      borderRadius: 6,
      margin: '8px 0',
      overflow: 'hidden',
      position: 'relative',
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '4px 10px',
        background: T.bg1,
        borderBottom: `1px solid ${T.border}`,
        fontSize: 10, color: T.textTertiary, fontFamily: T.fontMono,
      }}>
        <span>{lang || 'code'}</span>
        <button onClick={onCopy} style={{
          background: copied ? T.green + '22' : 'transparent',
          border: `1px solid ${copied ? T.green : T.border}`,
          color: copied ? T.green : T.textSecondary,
          padding: '2px 8px', fontSize: 10, borderRadius: 3,
        }}>
          {copied ? '✓ copied' : 'copy'}
        </button>
      </div>
      <pre style={{
        margin: 0, padding: '10px 12px',
        fontFamily: T.fontMono, fontSize: 12, color: T.textPrimary,
        overflow: 'auto', maxHeight: 400,
        whiteSpace: 'pre',
      }}>{code}</pre>
    </div>
  );
}

// ── Collapsible paste block with quote-selection ──────────────────────────
function PasteBlock({ content, onQuoteSelection }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const preRef = useRef(null);
  const sizeBytes = new Blob([content]).size;
  const isHttp = /^HTTP\/[\d.]+\s+\d{3}/.test(content.trim()) ||
                 /\nHTTP\/[\d.]+\s+\d{3}/.test(content);
  const sizeStr = sizeBytes > 1024 ? `${(sizeBytes/1024).toFixed(1)} KB` : `${sizeBytes} B`;

  // Watch for selection changes within this paste block
  useEffect(() => {
    if (!expanded) { setSelectedText(''); return; }
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !preRef.current) {
        setSelectedText('');
        return;
      }
      const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      if (range && preRef.current.contains(range.commonAncestorContainer)) {
        const text = sel.toString().trim();
        setSelectedText(text.length > 4 ? text : '');
      } else {
        setSelectedText('');
      }
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [expanded]);

  return (
    <div style={{
      background: T.bg0,
      border: `1px solid ${T.border}`,
      borderRadius: 5,
      padding: '6px 10px',
      margin: '4px 0',
    }}>
      <div onClick={() => setExpanded(e => !e)}
           style={{
             cursor: 'pointer',
             display: 'flex', alignItems: 'center', gap: 6,
             color: T.textSecondary, fontSize: 11,
           }}>
        <span style={{ fontFamily: T.fontMono }}>{expanded ? '▼' : '▶'}</span>
        <span>📋 {isHttp ? 'HTTP response' : 'Pasted content'} — {sizeStr}</span>
      </div>
      {expanded && (
        <>
          <pre ref={preRef} style={{
            margin: '6px 0 0 0',
            padding: 8, background: T.bg1, borderRadius: 4,
            fontFamily: T.fontMono, fontSize: 11, color: T.textSecondary,
            maxHeight: 400, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            userSelect: 'text', cursor: 'text',
          }}>{content}</pre>
          {/* Quote-selection bar: appears when user has selected text */}
          {onQuoteSelection && selectedText && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              marginTop: 6, padding: '6px 8px',
              background: T.accentDim, border: `1px solid ${T.accent}66`,
              borderRadius: 4,
            }}>
              <span style={{ fontSize: 10, color: T.accentHi, fontWeight: 600 }}>
                {selectedText.length} chars selected
              </span>
              <button onClick={() => onQuoteSelection(selectedText)}
                style={{
                  background: T.accent, color: '#fff',
                  border: 'none', padding: '4px 10px', borderRadius: 4,
                  fontSize: 10, fontWeight: 600,
                  cursor: 'pointer', marginLeft: 'auto',
                }}>💬 Ask about this</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}


// ── Directive plan card (special chat message with Run/Cancel) ────────────
function DirectivePlanCard({ planId, plan, onConfirm, onCancel, onEdit, status }) {
  const [showAllProbes, setShowAllProbes] = useState(false);
  const probes = plan?.probes || [];
  const probesToShow = showAllProbes ? probes : probes.slice(0, 3);
  const classLabel = {
    reflected_xss: 'Reflected XSS',
    cname_takeover: 'CNAME takeover',
    idor_sweep: 'IDOR sweep',
    schema_discovery: 'Schema discovery',
    header_injection: 'Header injection',
    open_redirect: 'Open redirect',
    ssrf_callback: 'SSRF callback',
  }[plan?.test_class] || plan?.test_class;

  const isPending = status === 'pending' || !status;
  const isRunning = status === 'running';
  const isDone = status === 'done';

  return (
    <div style={{
      background: T.bg0,
      border: `1px solid ${T.accent}66`,
      borderLeft: `3px solid ${T.accent}`,
      borderRadius: 6,
      padding: 12,
      marginTop: 6,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 8, flexWrap: 'wrap',
      }}>
        <span style={{
          fontSize: 9, padding: '2px 7px', borderRadius: 3,
          background: T.accentDim, color: T.accentHi,
          fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
        }}>{classLabel || 'Test plan'}</span>
        <span style={{
          fontSize: 10, color: T.textTertiary,
        }}>{probes.length} probe{probes.length === 1 ? '' : 's'}</span>
      </div>

      {plan?.target && (
        <div style={{ fontSize: 11, color: T.textSecondary, marginBottom: 4 }}>
          <span style={{ color: T.textMuted }}>Target: </span>
          <span style={{ color: T.textPrimary, fontFamily: T.fontMono, wordBreak: 'break-all' }}>
            {plan.target}
          </span>
        </div>
      )}
      {plan?.rationale && (
        <div style={{ fontSize: 11, color: T.textTertiary, marginBottom: 8, lineHeight: 1.5 }}>
          {plan.rationale}
        </div>
      )}

      <div style={{
        background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 4,
        padding: 8, marginBottom: 10,
      }}>
        <div style={{
          fontSize: 9, fontWeight: 600, color: T.textTertiary,
          textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6,
        }}>
          Probes
        </div>
        {probesToShow.map((p, i) => (
          <div key={i} style={{
            fontSize: 10, color: T.textSecondary, fontFamily: T.fontMono,
            marginBottom: 4, paddingLeft: 8, borderLeft: `2px solid ${T.border}`,
            lineHeight: 1.4, wordBreak: 'break-all',
          }}>
            <div style={{ color: T.accentHi, fontSize: 10 }}>{p.label}</div>
            <div>{p.method || 'GET'} {p.url}</div>
          </div>
        ))}
        {probes.length > 3 && (
          <button onClick={() => setShowAllProbes(s => !s)} style={{
            background: 'transparent', border: 'none',
            color: T.textTertiary, fontSize: 10, cursor: 'pointer', marginTop: 4,
            padding: 0,
          }}>
            {showAllProbes ? '▲ collapse' : `▼ show all ${probes.length} probes`}
          </button>
        )}
      </div>

      {/* Action buttons */}
      {isPending && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={() => onConfirm(planId)} style={{
            background: T.accent, color: '#fff',
            border: 'none', borderRadius: 5,
            padding: '8px 14px', fontSize: 12, fontWeight: 600,
            cursor: 'pointer', flex: '1 1 auto', minWidth: 80,
          }}>▶ Run</button>
          <button onClick={() => onCancel(planId)} style={{
            background: 'transparent', color: T.textTertiary,
            border: `1px solid ${T.border}`, borderRadius: 5,
            padding: '8px 14px', fontSize: 12,
            cursor: 'pointer',
          }}>Cancel</button>
        </div>
      )}
      {isRunning && (
        <div style={{
          fontSize: 11, color: T.amber, padding: '6px 0',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ animation: 'pulse 1s infinite' }}>●</span>
          Running probes...
        </div>
      )}
      {isDone && (
        <div style={{ fontSize: 10, color: T.textMuted, fontStyle: 'italic' }}>
          Plan executed — see verdict above.
        </div>
      )}
    </div>
  );
}

// ── Single chat message render ─────────────────────────────────────────────
function ChatMessage({ message, onArtifactClick, onConfirmDirective, onCancelDirective, directiveStatus, onDisputeLead, onQuoteSelection }) {
  const role = message.role || 'tentacles';
  const styleConf = ROLE_STYLES[role] || ROLE_STYLES.tentacles;
  const isUser = role === 'user';
  const isRecon = role === 'recon';
  const isSystem = role === 'system';
  const isLargePaste = (message.kind === 'paste' || message.kind === 'http_response_paste')
                       && (message.content || '').length > 500;
  const artifacts = message.meta?.artifacts || [];
  const isDirectiveProposal = message.kind === 'directive_proposal';
  const directivePlanId = message.meta?.planId;
  const directivePlan = message.meta?.plan;

  if (isSystem) {
    return (
      <div style={{
        textAlign: 'center', margin: '10px 0',
        fontSize: 11, color: T.textMuted,
        fontStyle: 'italic',
      }}>
        — {message.content} —
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: isUser ? 'flex-end' : 'stretch',
      marginBottom: 14,
      animation: 'fadeUp 0.18s ease',
    }}>
      <div style={{
        maxWidth: isUser ? '88%' : '100%',
        background: styleConf.bg,
        border: `1px solid ${styleConf.border}`,
        borderLeft: isRecon ? `3px solid ${T.amber}` : styleConf.border,
        borderRadius: isUser ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
        padding: '10px 14px',
        color: styleConf.fg,
      }}>
        {/* Role label */}
        <div style={{ fontSize: 10, color: T.textMuted, marginBottom: 4, fontWeight: 500 }}>
          {isUser ? 'You' : isRecon ? '⚡ Recon' : 'Tentacles'} · {fmtTime(message.ts)}
        </div>
        {/* Body */}
        {isLargePaste ? (
          <PasteBlock content={message.content} onQuoteSelection={onQuoteSelection} />
        ) : (
          <div>{renderMarkdown(message.content)}</div>
        )}
        {/* Artifact references */}
        {artifacts.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {artifacts.map(a => (
              <button key={a.artifactId}
                onClick={() => onArtifactClick(a.artifactId)}
                style={{
                  background: T.bg0, border: `1px solid ${T.accent}66`,
                  borderRadius: 5, padding: '6px 10px',
                  color: T.accentHi, fontSize: 11,
                  cursor: 'pointer', textAlign: 'left',
                  fontFamily: T.fontMono,
                }}>
                📄 Open <b>{a.name}</b>
              </button>
            ))}
          </div>
        )}
        {/* Directive plan card (interactive Run/Cancel) */}
        {isDirectiveProposal && directivePlanId && directivePlan && (
          <DirectivePlanCard
            planId={directivePlanId}
            plan={directivePlan}
            status={directiveStatus}
            onConfirm={onConfirmDirective}
            onCancel={onCancelDirective}
          />
        )}
        {/* Lead evaluation — disagree button */}
        {message.kind === 'lead_evaluation' && message.meta?.lead_id && (message.meta?.verdict === 'dead_end' || message.meta?.verdict === 'not_vulnerable') && onDisputeLead && (
          <div style={{ marginTop: 8 }}>
            <button onClick={() => onDisputeLead(message.meta.lead_id)}
              title="Tentacles got this wrong — reopen the lead with my reasoning"
              style={{
                background: 'transparent', border: `1px solid ${T.border}`,
                color: T.textTertiary, padding: '4px 10px', borderRadius: 4,
                fontSize: 10, cursor: 'pointer',
              }}>
              ⚠ I disagree — reopen this lead
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Chat input area ────────────────────────────────────────────────────────
function ChatInput({ onSend, disabled, isMobile, pendingQuote, onClearQuote }) {
  const [value, setValue] = useState('');
  const [showCmdHint, setShowCmdHint] = useState(false);
  const inputRef = useRef(null);

  const send = () => {
    const v = value.trim();
    if (!v || disabled) return;
    // If there's a pending quote, prepend it as a markdown blockquote
    let toSend = v;
    if (pendingQuote) {
      const quoted = pendingQuote.split('\n').map(l => '> ' + l).join('\n');
      toSend = quoted + '\n\n' + v;
      onClearQuote && onClearQuote();
    }
    onSend(toSend);
    setValue('');
    setShowCmdHint(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // Auto-grow textarea
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  }, [value]);

  // Show slash command hint
  useEffect(() => {
    setShowCmdHint(value.startsWith('/'));
  }, [value]);

  return (
    <div style={{
      borderTop: `1px solid ${T.border}`,
      background: T.bg1,
      padding: isMobile ? '8px 10px' : '10px 14px',
      // Add safe-area padding on iOS for the home indicator
      paddingBottom: isMobile ? 'max(8px, env(safe-area-inset-bottom))' : 10,
    }}>
      {pendingQuote && (
        <div style={{
          background: T.accentDim,
          border: `1px solid ${T.accent}55`,
          borderLeft: `3px solid ${T.accent}`,
          borderRadius: 5,
          padding: '6px 10px',
          marginBottom: 6,
          display: 'flex', alignItems: 'flex-start', gap: 8,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 9, color: T.accentHi, fontWeight: 600, marginBottom: 2 }}>
              QUOTING {pendingQuote.length} CHARS
            </div>
            <div style={{
              fontFamily: T.fontMono, fontSize: 10, color: T.textSecondary,
              lineHeight: 1.4,
              maxHeight: 60, overflow: 'auto',
              whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {pendingQuote.length > 200 ? pendingQuote.slice(0, 200) + '…' : pendingQuote}
            </div>
          </div>
          <button onClick={onClearQuote}
            style={{
              background: 'transparent', border: 'none',
              color: T.textTertiary, fontSize: 14, padding: '0 4px',
              cursor: 'pointer', flexShrink: 0,
            }}>✕</button>
        </div>
      )}
      {showCmdHint && (
        <div style={{
          fontSize: 10, color: T.textTertiary,
          marginBottom: 6, fontFamily: T.fontMono,
          overflowX: 'auto', whiteSpace: 'nowrap',
        }}>
          /pivot · /explain · /code · /report · /clear-context · /help
        </div>
      )}
      <div style={{ display: 'flex', gap: isMobile ? 6 : 8, alignItems: 'flex-end' }}>
        <textarea
          ref={inputRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={disabled ? 'Connecting...' : isMobile
            ? 'Message, paste, or /help'
            : 'Type a message, paste a response, or /help for commands · Enter to send · Shift+Enter for newline'}
          style={{
            flex: 1, resize: 'none',
            background: T.bg0, color: T.textPrimary,
            border: `1px solid ${T.border}`, borderRadius: 10,
            padding: isMobile ? '12px 14px' : '10px 12px',
            fontSize: 16, // 16px prevents iOS zoom-on-focus
            fontFamily: T.fontSans,
            outline: 'none',
            minHeight: isMobile ? 48 : 44, maxHeight: 240,
            lineHeight: 1.4,
          }}
        />
        <button
          onClick={send}
          disabled={disabled || !value.trim()}
          style={{
            background: !value.trim() || disabled ? T.bg2 : T.accent,
            color: !value.trim() || disabled ? T.textMuted : '#fff',
            border: 'none', borderRadius: 10,
            padding: isMobile ? '12px 14px' : '10px 16px',
            fontSize: isMobile ? 14 : 13, fontWeight: 600,
            cursor: !value.trim() || disabled ? 'not-allowed' : 'pointer',
            minWidth: isMobile ? 60 : 70,
            minHeight: isMobile ? 48 : 'auto',
          }}>
          {isMobile ? '➤' : 'Send'}
        </button>
      </div>
    </div>
  );
}


// ── RECON VIEW SWITCHER ────────────────────────────────────────────────────
// Toggles between the flat "by category" view and the pivoted "by subdomain"
// view. Both read the same on-disk data — different lenses on it.
function ReconViewSwitcher({ wbId, apiKey, isMobile }) {
  const [view, setView] = useState('subdomain');  // subdomain | category

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      background: T.bg1, border: `1px solid ${T.border}`,
      borderRadius: 8, overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', gap: 4,
        padding: '8px 10px',
        borderBottom: `1px solid ${T.border}`,
        background: T.bg0,
      }}>
        <button onClick={() => setView('subdomain')}
          style={{
            background: view === 'subdomain' ? T.accentDim : 'transparent',
            border: `1px solid ${view === 'subdomain' ? T.accent : T.border}`,
            color: view === 'subdomain' ? T.accentHi : T.textSecondary,
            padding: '5px 12px', borderRadius: 5,
            fontSize: 11, fontWeight: 500, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
          <span style={{ fontSize: 11 }}>◊</span>
          By subdomain
        </button>
        <button onClick={() => setView('category')}
          style={{
            background: view === 'category' ? T.accentDim : 'transparent',
            border: `1px solid ${view === 'category' ? T.accent : T.border}`,
            color: view === 'category' ? T.accentHi : T.textSecondary,
            padding: '5px 12px', borderRadius: 5,
            fontSize: 11, fontWeight: 500, cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
          <span style={{ fontSize: 11 }}>⊟</span>
          By category (raw files)
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={async () => {
          try {
            await fetch(`/api/workbenches/${wbId}/recon/action/subdomain_refresh`, {
              method: 'POST',
              headers: apiKey ? { 'x-api-key': apiKey } : {},
            });
          } catch {}
        }}
          title="Re-run subfinder + crt.sh and merge new subdomains"
          style={{
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            color: T.accentHi, padding: '5px 10px',
            borderRadius: 5, fontSize: 11, cursor: 'pointer',
            fontWeight: 500,
          }}>🔄 Refresh subs</button>
      </div>

      {view === 'subdomain' ? (
        <SubdomainView wbId={wbId} apiKey={apiKey} isMobile={isMobile} />
      ) : (
        <ReconTable
          wbId={wbId} apiKey={apiKey}
          filenames={RECON_FILES_ORDERED}
          isMobile={isMobile}
          groupByCategory={true}
          emptyText="No recon data yet — start a scan, then run tools. Files appear here as soon as they have content."
        />
      )}
    </div>
  );
}

// ── SUBDOMAIN VIEW ─────────────────────────────────────────────────────────
// Per-host data view. Left pane: subdomain list (sortable, hot indicators).
// Right pane: full data for the selected host.
function SubdomainView({ wbId, apiKey, isMobile }) {
  const [list, setList] = useState(null);
  const [selectedHost, setSelectedHost] = useState(null);
  const [hostData, setHostData] = useState(null);
  const [hostLoading, setHostLoading] = useState(false);
  const [view, setView] = useState('subdomains');  // subdomains | targetwide
  const [targetWide, setTargetWide] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');  // all | hot | alive | dangling

  // Fetch subdomain list on mount
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workbenches/${wbId}/by-subdomain`, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    }).then(r => r.json()).then(d => {
      if (cancelled) return;
      setList(d);
      // Auto-select the first hot subdomain
      const firstHot = (d.items || []).find(s => s.hot && s.hasData);
      const firstWithData = (d.items || []).find(s => s.hasData);
      const initialPick = firstHot || firstWithData;
      if (initialPick) setSelectedHost(initialPick.host);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [wbId, apiKey]);

  // Fetch host data when selection changes
  useEffect(() => {
    if (!selectedHost) { setHostData(null); return; }
    let cancelled = false;
    setHostLoading(true);
    fetch(`/api/workbenches/${wbId}/by-subdomain/${encodeURIComponent(selectedHost)}`, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    }).then(r => r.json()).then(d => {
      if (cancelled) return;
      setHostData(d);
      setHostLoading(false);
    }).catch(() => { if (!cancelled) setHostLoading(false); });
    return () => { cancelled = true; };
  }, [wbId, apiKey, selectedHost]);

  // Fetch target-wide data when that view is opened
  useEffect(() => {
    if (view !== 'targetwide' || targetWide) return;
    fetch(`/api/workbenches/${wbId}/by-subdomain/target-wide`, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    }).then(r => r.json()).then(setTargetWide).catch(() => {});
  }, [wbId, apiKey, view, targetWide]);

  if (!list) {
    return <div style={{ padding: 20, fontSize: 11, color: T.textMuted }}>Loading...</div>;
  }

  if (list.error) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: T.textMuted, fontSize: 11 }}>
        <div style={{ fontSize: 32, opacity: 0.4, marginBottom: 12 }}>◊</div>
        {list.error}
      </div>
    );
  }

  if (!list.items || list.items.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: T.textMuted, fontSize: 11 }}>
        <div style={{ fontSize: 32, opacity: 0.4, marginBottom: 12 }}>◊</div>
        No subdomains discovered yet — run baseline recon first.
      </div>
    );
  }

  // Filter the list
  const filtered = list.items.filter(item => {
    if (search && !item.host.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === 'hot' && !item.hot) return false;
    if (filter === 'alive' && !item.alive) return false;
    if (filter === 'dangling' && !item.dangling) return false;
    return true;
  });

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
      {/* LEFT pane: subdomain list */}
      <div style={{
        width: isMobile ? '100%' : 280,
        minWidth: isMobile ? 'unset' : 240,
        borderRight: isMobile ? 'none' : `1px solid ${T.border}`,
        display: (isMobile && selectedHost && view === 'subdomains') ? 'none' : 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: 8, borderBottom: `1px solid ${T.border}`,
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Filter subdomains..."
            style={{
              background: T.bg0, border: `1px solid ${T.border}`,
              borderRadius: 4, padding: '5px 8px',
              color: T.textPrimary, fontSize: 11,
              fontFamily: T.fontMono, outline: 'none',
            }} />
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[
              { id: 'all',      label: `All (${list.items.length})` },
              { id: 'hot',      label: `🔥 Hot (${list.items.filter(s => s.hot).length})` },
              { id: 'alive',    label: `Alive (${list.items.filter(s => s.alive).length})` },
              { id: 'dangling', label: `Dangling (${list.items.filter(s => s.dangling).length})` },
            ].map(f => (
              <button key={f.id} onClick={() => setFilter(f.id)}
                style={{
                  background: filter === f.id ? T.accentDim : 'transparent',
                  border: `1px solid ${filter === f.id ? T.accent : T.border}`,
                  color: filter === f.id ? T.accentHi : T.textTertiary,
                  padding: '3px 7px', borderRadius: 3,
                  fontSize: 9, cursor: 'pointer',
                }}>{f.label}</button>
            ))}
          </div>
          {(list.targetWide.s3FindingsCount > 0 || list.targetWide.githubSecretsCount > 0) && (
            <button onClick={() => { setView('targetwide'); setSelectedHost(null); }}
              style={{
                background: view === 'targetwide' ? T.amber + '33' : T.bg0,
                border: `1px solid ${view === 'targetwide' ? T.amber : T.border}`,
                color: view === 'targetwide' ? T.amber : T.textSecondary,
                padding: '5px 8px', borderRadius: 4, fontSize: 10,
                cursor: 'pointer', textAlign: 'left',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
              <span>🌐 Target-wide</span>
              <span style={{ fontSize: 9, color: T.textMuted }}>
                {list.targetWide.s3FindingsCount + list.targetWide.githubSecretsCount} item(s)
              </span>
            </button>
          )}
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filtered.map(item => {
            const active = selectedHost === item.host && view === 'subdomains';
            const totalCounts = Object.values(item.counts).reduce((s, n) => s + n, 0);
            return (
              <div key={item.host} onClick={() => { setSelectedHost(item.host); setView('subdomains'); }}
                style={{
                  padding: '8px 10px',
                  borderBottom: `1px solid ${T.border}`,
                  background: active ? T.accentDim : 'transparent',
                  borderLeft: active ? `3px solid ${T.accent}` : '3px solid transparent',
                  cursor: 'pointer',
                  opacity: item.hasData ? 1 : 0.5,
                }}>
                <div style={{
                  fontSize: 11, fontFamily: T.fontMono,
                  color: active ? T.accentHi : T.textPrimary,
                  fontWeight: active ? 600 : 400,
                  wordBreak: 'break-all',
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  {item.hot && <span style={{ fontSize: 9 }}>🔥</span>}
                  {item.takeoverConfirmed && <span style={{ fontSize: 9 }}>🚨</span>}
                  {item.dangling && !item.takeoverConfirmed && <span style={{ fontSize: 9, color: T.amber }}>⚑</span>}
                  {item.host}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                  {item.alive && <span style={{ fontSize: 8, color: T.green, padding: '0 4px', background: T.green + '22', borderRadius: 2 }}>alive</span>}
                  {item.behindCloudflare && <span style={{ fontSize: 8, color: T.textTertiary, padding: '0 4px', background: T.bg2, borderRadius: 2 }}>CF</span>}
                  {item.direct && <span style={{ fontSize: 8, color: T.amber, padding: '0 4px', background: T.amber + '22', borderRadius: 2 }}>direct</span>}
                  {totalCounts > 0 && <span style={{ fontSize: 8, color: T.textMuted, marginLeft: 'auto' }}>{totalCounts} item(s)</span>}
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ padding: 16, fontSize: 10, color: T.textMuted, textAlign: 'center' }}>
              No subdomains match this filter.
            </div>
          )}
        </div>
      </div>

      {/* RIGHT pane: details */}
      <div style={{
        flex: 1, minWidth: 0, overflow: 'auto',
        display: (isMobile && !selectedHost && view !== 'targetwide') ? 'none' : 'flex',
        flexDirection: 'column',
      }}>
        {isMobile && (selectedHost || view === 'targetwide') && (
          <button onClick={() => { setSelectedHost(null); setView('subdomains'); }}
            style={{
              background: T.bg2, border: `1px solid ${T.border}`,
              color: T.textSecondary, padding: '6px 10px', margin: 8,
              borderRadius: 4, fontSize: 11, cursor: 'pointer', alignSelf: 'flex-start',
            }}>← Back to list</button>
        )}
        {view === 'targetwide' ? (
          <TargetWidePanel data={targetWide} />
        ) : selectedHost ? (
          <HostDetailPanel data={hostData} loading={hostLoading} wbId={wbId} apiKey={apiKey} />
        ) : (
          <div style={{ padding: 24, textAlign: 'center', color: T.textMuted, fontSize: 11 }}>
            <div style={{ fontSize: 28, opacity: 0.4, marginBottom: 8 }}>◊</div>
            Select a subdomain on the left to see its data.
          </div>
        )}
      </div>
    </div>
  );
}

function TargetWidePanel({ data }) {
  if (!data || !data.targetWide) {
    return <div style={{ padding: 20, fontSize: 11, color: T.textMuted }}>Loading...</div>;
  }
  const tw = data.targetWide;
  return (
    <div style={{ padding: 16, fontSize: 11, color: T.textSecondary }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: T.textPrimary, marginBottom: 12 }}>
        🌐 Target-wide findings
      </div>
      <div style={{ fontSize: 10, color: T.textTertiary, marginBottom: 16, lineHeight: 1.5 }}>
        Findings that don't belong to a single subdomain — cloud buckets discovered by org-name permutation, GitHub secrets across the org, JS endpoints from minified bundles where we couldn't trace the host.
      </div>

      <DetailSection title={`Cloud buckets (${tw.s3Findings.length})`} items={tw.s3Findings} mono hot />
      <DetailSection title={`GitHub secrets (${tw.githubSecrets.length})`} items={tw.githubSecrets} mono hot />
      <DetailSection title={`JS endpoints (no host context, ${tw.jsEndpointsRelative.length})`} items={tw.jsEndpointsRelative} mono />
      <DetailSection title={`Cross-host takeover candidates (${tw.crossHostTakeoverCandidates.length})`} items={tw.crossHostTakeoverCandidates} mono />
    </div>
  );
}

function HostDetailPanel({ data, loading, wbId, apiKey }) {
  if (loading || !data) {
    return <div style={{ padding: 20, fontSize: 11, color: T.textMuted }}>Loading...</div>;
  }
  if (data.error) {
    return <div style={{ padding: 20, fontSize: 11, color: T.red }}>{data.error}</div>;
  }
  const d = data.data;

  return (
    <div style={{ padding: 16, fontSize: 11, color: T.textSecondary }}>
      {/* Header */}
      <div style={{ marginBottom: 12 }}>
        <div style={{
          fontSize: 14, fontWeight: 600, color: T.textPrimary,
          fontFamily: T.fontMono, wordBreak: 'break-all',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ fontSize: 12 }}>◊</span>
          {data.host}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          {d.alive && <span style={{ fontSize: 9, color: T.green, padding: '2px 7px', background: T.green + '22', borderRadius: 3, border: `1px solid ${T.green}55` }}>✓ alive</span>}
          {!d.alive && <span style={{ fontSize: 9, color: T.textMuted, padding: '2px 7px', background: T.bg2, borderRadius: 3 }}>not alive</span>}
          {d.behindCloudflare && <span style={{ fontSize: 9, color: T.textTertiary, padding: '2px 7px', background: T.bg2, borderRadius: 3, border: `1px solid ${T.border}` }}>⛨ Cloudflare</span>}
          {d.direct && <span style={{ fontSize: 9, color: T.amber, padding: '2px 7px', background: T.amber + '22', borderRadius: 3, border: `1px solid ${T.amber}55` }}>⤴ direct (no CDN)</span>}
          {d.dangling && <span style={{ fontSize: 9, color: T.amber, padding: '2px 7px', background: T.amber + '22', borderRadius: 3, border: `1px solid ${T.amber}55` }}>⚑ dangling</span>}
          {d.takeoverConfirmed && <span style={{ fontSize: 9, color: T.red, padding: '2px 7px', background: T.red + '22', borderRadius: 3, border: `1px solid ${T.red}55` }}>🚨 takeover confirmed</span>}
        </div>
        {(d.ip || d.cnameTarget || d.waf) && (
          <div style={{ marginTop: 8, fontSize: 10, color: T.textTertiary, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {d.ip && <span>IP: <span style={{ color: T.textSecondary, fontFamily: T.fontMono }}>{d.ip}</span></span>}
            {d.cnameTarget && <span>CNAME → <span style={{ color: T.textSecondary, fontFamily: T.fontMono }}>{d.cnameTarget}</span></span>}
            {d.waf && <span>WAF: <span style={{ color: T.textSecondary }}>{d.waf}</span></span>}
          </div>
        )}
      </div>

      {/* Screenshot if available */}
      {data.screenshot && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: T.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
            Screenshot
          </div>
          <img
            src={`/api/workbenches/${wbId}/tools/runs/${data.screenshot.runId}/download/${data.screenshot.filename}`}
            alt={`Screenshot of ${data.host}`}
            style={{
              maxWidth: '100%', maxHeight: 320,
              border: `1px solid ${T.border}`, borderRadius: 5,
              objectFit: 'contain', background: T.bg0,
            }}
          />
        </div>
      )}

      {/* Tech / WAF */}
      {d.technologies.length > 0 && (
        <DetailSection title={`Technologies (${d.technologies.length})`}
          items={d.technologies} chips />
      )}
      {d.whatweb.length > 0 && (
        <DetailSection title={`whatweb fingerprints (${d.whatweb.length})`} items={d.whatweb} mono />
      )}

      {/* Hot findings up top */}
      {d.gitExposed && (
        <div style={{ padding: 8, marginBottom: 10, background: T.red + '22', border: `1px solid ${T.red}55`, borderRadius: 4, fontSize: 11, color: T.red }}>
          ⚠ <strong>.git directory exposed</strong> — clone with git-dumper
        </div>
      )}
      {d.envExposed && (
        <div style={{ padding: 8, marginBottom: 10, background: T.red + '22', border: `1px solid ${T.red}55`, borderRadius: 4, fontSize: 11, color: T.red }}>
          ⚠ <strong>.env file exposed</strong> — download immediately
        </div>
      )}
      {d.jsSecrets.length > 0 && (
        <DetailSection title={`Possible JS secrets (${d.jsSecrets.length})`} items={d.jsSecrets} mono hot />
      )}
      {d.nucleiFindings.length > 0 && (
        <DetailSection title={`Nuclei findings (${d.nucleiFindings.length})`} items={d.nucleiFindings} mono hot />
      )}
      {d.reflectionFindings.length > 0 && (
        <DetailSection title={`Reflection findings (${d.reflectionFindings.length})`} items={d.reflectionFindings} mono hot />
      )}
      {d.testsslFindings.length > 0 && (
        <DetailSection title={`TLS/SSL findings (${d.testsslFindings.length})`} items={d.testsslFindings} mono />
      )}

      {/* Surface */}
      {d.forms.length > 0 && (
        <DetailSection title={`Forms (${d.forms.length})`} items={d.forms} mono />
      )}
      {d.params.length > 0 && (
        <DetailSection title={`Parameters (${d.params.length})`} items={d.params} chips />
      )}
      {d.urls.length > 0 && (
        <DetailSection title={`URLs (${d.urls.length})`} items={d.urls} mono collapsible />
      )}
      {d.apiEndpoints.length > 0 && (
        <DetailSection title={`API endpoints (${d.apiEndpoints.length})`} items={d.apiEndpoints} mono />
      )}
      {d.ffufHits.length > 0 && (
        <DetailSection title={`FFUF hits (${d.ffufHits.length})`} items={d.ffufHits} mono hot />
      )}
      {d.graphqlEndpoints.length > 0 && (
        <DetailSection title={`GraphQL (${d.graphqlEndpoints.length})`} items={d.graphqlEndpoints} mono hot />
      )}

      {/* JS */}
      {d.jsFiles.length > 0 && (
        <DetailSection title={`JS files (${d.jsFiles.length})`} items={d.jsFiles} mono collapsible />
      )}
      {d.jsEndpoints.length > 0 && (
        <DetailSection title={`JS endpoints (${d.jsEndpoints.length})`} items={d.jsEndpoints} mono collapsible />
      )}

      {/* Other */}
      {d.openPorts.length > 0 && (
        <DetailSection title={`Open ports (${d.openPorts.length})`} items={d.openPorts} mono />
      )}
      {d.htmlComments.length > 0 && (
        <DetailSection title={`HTML comments (${d.htmlComments.length})`} items={d.htmlComments} mono collapsible />
      )}
      {d.backupFiles.length > 0 && (
        <DetailSection title={`Backup files (${d.backupFiles.length})`} items={d.backupFiles} mono hot />
      )}
      {d.urlsArchive.length > 0 && (
        <DetailSection title={`Archived URLs (${d.urlsArchive.length})`} items={d.urlsArchive} mono collapsible />
      )}

      {/* Empty-state if literally nothing */}
      {!d.alive && d.urls.length === 0 && d.forms.length === 0 && d.jsFiles.length === 0 &&
       d.nucleiFindings.length === 0 && !d.dangling && d.params.length === 0 && (
        <div style={{ padding: 14, color: T.textMuted, fontSize: 11, textAlign: 'center', fontStyle: 'italic' }}>
          No data for this subdomain yet — it's discovered but no tool has produced output for it.
        </div>
      )}
    </div>
  );
}

// Section component used in the per-host detail panel
function DetailSection({ title, items, mono, chips, hot, collapsible }) {
  const [collapsed, setCollapsed] = useState(collapsible || (items && items.length > 30));
  if (!items || items.length === 0) return null;

  const visibleItems = collapsed ? items.slice(0, 8) : items;

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
        color: hot ? T.amber : T.textTertiary,
        marginBottom: 6,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {title}
        {(collapsible || items.length > 30) && (
          <button onClick={() => setCollapsed(!collapsed)}
            style={{
              background: 'transparent', border: 'none',
              color: T.accentHi, fontSize: 9, cursor: 'pointer',
              padding: 0, marginLeft: 'auto',
            }}>
            {collapsed ? `Show all ${items.length}` : 'Show less'}
          </button>
        )}
      </div>
      {chips ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {visibleItems.map((item, i) => (
            <span key={i} style={{
              fontSize: 10, padding: '2px 7px', borderRadius: 3,
              background: T.bg2, border: `1px solid ${T.border}`,
              color: T.textSecondary, fontFamily: T.fontMono,
            }}>{item}</span>
          ))}
          {collapsed && items.length > visibleItems.length && (
            <span style={{ fontSize: 10, color: T.textMuted, padding: '2px 7px' }}>
              +{items.length - visibleItems.length} more
            </span>
          )}
        </div>
      ) : (
        <div style={{
          background: T.bg0, border: `1px solid ${T.border}`,
          borderRadius: 4, padding: 8,
          fontSize: 10,
          fontFamily: mono ? T.fontMono : 'inherit',
          color: hot ? T.amber : T.textSecondary,
          maxHeight: collapsed ? 'auto' : 320, overflowY: 'auto',
          lineHeight: 1.5,
        }}>
          {visibleItems.map((item, i) => (
            <div key={i} style={{
              padding: '2px 0', wordBreak: 'break-all',
              borderBottom: i < visibleItems.length - 1 ? `1px solid ${T.bg1}` : 'none',
            }}>{item}</div>
          ))}
          {collapsed && items.length > visibleItems.length && (
            <div style={{ fontSize: 9, color: T.textMuted, paddingTop: 4, fontStyle: 'italic' }}>
              ...+{items.length - visibleItems.length} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}


// ── DeepenMenu — dropdown to trigger focused recon deepening ──────────────
function DeepenMenu({ onDeepen, disabled }) {
  const [open, setOpen] = useState(false);
  const modes = [
    { id: 'js_secrets',     label: 'JS secrets', detail: 'Re-scan JS bundles for tokens & endpoints' },
    { id: 'forms',          label: 'Forms',      detail: 'Crawl HTML for input forms' },
    { id: 'schemas',        label: 'Schemas',    detail: 'OpenAPI/Swagger/GraphQL discovery' },
  ];
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => !disabled && setOpen(o => !o)} disabled={disabled}
        title={disabled ? 'Wait for current recon to finish' : 'Deepen recon in a focused area'}
        style={{
          background: disabled ? T.bg3 : T.accentDim,
          border: `1px solid ${T.accent}66`, borderRadius: 4,
          padding: '3px 8px', fontSize: 10, color: T.accentHi,
          cursor: disabled ? 'not-allowed' : 'pointer',
          marginLeft: 6,
        }}>↓ deepen</button>
      {open && (
        <div style={{
          position: 'absolute', top: '110%', right: 0,
          background: T.bg1, border: `1px solid ${T.border}`,
          borderRadius: 5, padding: 4, minWidth: 200, zIndex: 50,
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>
          {modes.map(m => (
            <button key={m.id} onClick={() => { setOpen(false); onDeepen && onDeepen(m.id); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: 'transparent', border: 'none',
                padding: '6px 10px', borderRadius: 3,
                color: T.textPrimary, fontSize: 11, cursor: 'pointer',
              }}
              onMouseEnter={(e) => e.target.style.background = T.bg2}
              onMouseLeave={(e) => e.target.style.background = 'transparent'}>
              <div style={{ fontWeight: 600 }}>{m.label}</div>
              <div style={{ fontSize: 9, color: T.textTertiary, marginTop: 1 }}>{m.detail}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ReconDataPanel — quick summary stats inside BriefPanel ─────────────────
function ReconDataPanel({ wbId, apiKey }) {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    if (!wbId) return;
    let cancelled = false;
    fetch(`/api/workbenches/${wbId}/recon-summary`, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    }).then(r => r.json()).then(d => {
      if (!cancelled) setSummary(d);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [wbId, apiKey]);

  if (!summary || !summary.counts) return null;
  const c = summary.counts;
  const rows = [
    ['Subdomains', c.subdomains],
    ['Alive hosts', c.aliveHosts],
    ['Direct hosts (no CDN)', c.directHosts],
    ['URLs', c.allUrls],
    ['Parameters', c.params],
    ['JS files', c.jsFiles],
    ['JS secrets', c.jsSecrets],
    ['Nuclei findings', c.nucleiFindings],
    ['FFUF hits', c.ffufFindings],
  ].filter(([_, n]) => n !== undefined && n > 0);
  if (rows.length === 0) return null;

  return (
    <div style={{ marginBottom: 12, fontSize: 11 }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: T.textTertiary,
                    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
        Recon snapshot
      </div>
      <div style={{ background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, padding: 8 }}>
        {rows.map(([label, n]) => (
          <div key={label} style={{
            display: 'flex', justifyContent: 'space-between',
            padding: '2px 0', color: T.textSecondary,
          }}>
            <span>{label}</span>
            <span style={{ color: T.accentHi, fontWeight: 600, fontFamily: T.fontMono }}>{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── SweepPanel — launch + monitor Full Tool Sweep ─────────────────────────
function SweepPanel({ wbId, apiKey, reconRunning }) {
  const [status, setStatus] = useState(null);
  const [showLaunch, setShowLaunch] = useState(false);
  const [launchLevel, setLaunchLevel] = useState('heavy');
  const [launchStealth, setLaunchStealth] = useState(false);
  const [launchSpeed, setLaunchSpeed] = useState('standard');
  const [launchPat, setLaunchPat] = useState('');
  const [launchError, setLaunchError] = useState(null);
  const [launchPending, setLaunchPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer;
    const tick = async () => {
      try {
        const r = await fetch(`/api/workbenches/${wbId}/sweep/status`, {
          headers: apiKey ? { 'x-api-key': apiKey } : {},
        });
        if (r.ok && !cancelled) {
          const d = await r.json();
          setStatus(d);
        }
      } catch {}
      if (cancelled) return;
      const running = status && status.status === 'running';
      timer = setTimeout(tick, running ? 4000 : 30000);
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wbId, apiKey, status?.status]);

  const isRunning = status && status.status === 'running';
  const completed = (status?.stages || []).filter(s => s.status === 'completed').length;
  const skipped = (status?.stages || []).filter(s => s.status === 'skipped').length;
  const failed = (status?.stages || []).filter(s => s.status === 'failed').length;
  const total = status?.totalStages || 13;
  const current = (status?.stages || []).find(s => s.status === 'running');

  const startSweep = async () => {
    setLaunchPending(true);
    setLaunchError(null);
    try {
      const r = await fetch(`/api/workbenches/${wbId}/sweep/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
        body: JSON.stringify({
          level: launchLevel, stealth: launchStealth, speed: launchSpeed, githubPat: launchPat,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setLaunchError((d.error || 'failed') + (d.issues ? ': ' + d.issues.join(' / ') : ''));
      } else {
        setShowLaunch(false);
        setLaunchPat('');
      }
    } catch (e) {
      setLaunchError(e.message);
    } finally {
      setLaunchPending(false);
    }
  };

  const cancelSweep = async () => {
    if (!window.confirm('Cancel the sweep? Tools that ran will keep their results.')) return;
    try {
      await fetch(`/api/workbenches/${wbId}/sweep/cancel`, {
        method: 'POST',
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
    } catch {}
  };

  const skipTool = async () => {
    try {
      await fetch(`/api/workbenches/${wbId}/sweep/skip-tool`, {
        method: 'POST',
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
    } catch {}
  };

  const fmtTime = () => {
    if (!status?.startedAt) return '';
    const sec = Math.floor((Date.now() - new Date(status.startedAt).getTime()) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    return `${Math.floor(min/60)}h ${min%60}m`;
  };

  return (
    <>
      <div style={{
        background: T.bg1, border: `1px solid ${T.border}`,
        borderRadius: 8, padding: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: isRunning ? 12 : 0 }}>
          <span style={{ fontSize: 16 }}>🚀</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.textPrimary }}>Full Tool Sweep</div>
            <div style={{ fontSize: 10, color: T.textTertiary, marginTop: 2 }}>
              Runs every tool in dependency order — takes hours.
            </div>
          </div>
          {!isRunning && (
            <button onClick={() => setShowLaunch(true)} disabled={reconRunning}
              title={reconRunning ? 'Wait for recon to finish' : 'Launch sweep'}
              style={{
                background: reconRunning ? T.bg2 : T.accent,
                border: 'none', borderRadius: 5,
                color: reconRunning ? T.textMuted : '#fff',
                padding: '7px 14px', fontSize: 11, fontWeight: 600,
                cursor: reconRunning ? 'not-allowed' : 'pointer',
              }}>🚀 Run Full Sweep</button>
          )}
          {isRunning && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={skipTool}
                style={{
                  background: T.bg2, border: `1px solid ${T.border}`,
                  color: T.amber, padding: '6px 10px',
                  fontSize: 10, borderRadius: 4, cursor: 'pointer',
                }}>⏭ Skip</button>
              <button onClick={cancelSweep}
                style={{
                  background: T.red + '22', border: `1px solid ${T.red}66`,
                  color: T.red, padding: '6px 10px',
                  fontSize: 10, borderRadius: 4, cursor: 'pointer',
                }}>⛔ Cancel</button>
            </div>
          )}
        </div>

        {isRunning && (
          <div>
            <div style={{ display: 'flex', gap: 16, fontSize: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ color: T.textSecondary }}>
                Level: <span style={{ color: T.accentHi, fontWeight: 600 }}>{status.level}</span>
              </span>
              <span style={{ color: T.textSecondary }}>
                Runtime: <span style={{ color: T.textPrimary, fontWeight: 600 }}>{fmtTime()}</span>
              </span>
              <span style={{ color: T.green }}>✓ {completed}</span>
              {skipped > 0 && <span style={{ color: T.textMuted }}>⊘ {skipped}</span>}
              {failed > 0 && <span style={{ color: T.red }}>⚠ {failed}</span>}
              <span style={{ color: T.textTertiary, marginLeft: 'auto' }}>
                {status.stages.length} / {total}
              </span>
            </div>
            <div style={{ height: 6, background: T.bg0, borderRadius: 3, overflow: 'hidden', marginBottom: 10 }}>
              <div style={{
                height: '100%', width: `${Math.round(status.stages.length / total * 100)}%`,
                background: T.accent, transition: 'width 0.3s',
              }} />
            </div>
            {current && (
              <div style={{
                fontSize: 10, color: T.accentHi,
                padding: '6px 10px',
                background: T.accent + '11', border: `1px solid ${T.accent}33`,
                borderRadius: 4,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ animation: 'pulse 1.5s infinite' }}>▶</span>
                <span style={{ fontWeight: 600 }}>Now running:</span>
                <span>{current.label}</span>
              </div>
            )}
          </div>
        )}

        {!isRunning && status && status.status && status.status !== 'never_run' && (status.stages || []).length > 0 && (
          <div style={{
            marginTop: 10, padding: 8, fontSize: 10,
            background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4,
            display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          }}>
            <span style={{
              color: status.status === 'completed' ? T.green
                : status.status === 'cancelled' ? T.amber : T.red,
              fontWeight: 600,
            }}>Last sweep: {status.status}</span>
            <span style={{ color: T.green }}>✓ {completed}</span>
            {skipped > 0 && <span style={{ color: T.textMuted }}>⊘ {skipped}</span>}
            {failed > 0 && <span style={{ color: T.red }}>⚠ {failed}</span>}
          </div>
        )}
      </div>

      {showLaunch && (
        <div onClick={() => !launchPending && setShowLaunch(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: T.bg1, border: `1px solid ${T.border}`,
            borderRadius: 8, padding: 22, maxWidth: 540, width: '100%',
            maxHeight: '85vh', overflowY: 'auto',
          }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: T.textPrimary, marginBottom: 12 }}>
              🚀 Launch Full Tool Sweep
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, marginBottom: 6 }}>
                Aggression
              </div>
              {[
                { id: 'polite', label: 'Polite' },
                { id: 'standard', label: 'Standard' },
                { id: 'heavy', label: 'Heavy' },
              ].map(opt => (
                <label key={opt.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '7px 10px', marginBottom: 4,
                  background: launchLevel === opt.id ? T.accent + '22' : T.bg0,
                  border: `1px solid ${launchLevel === opt.id ? T.accent : T.border}`,
                  borderRadius: 5, cursor: 'pointer',
                }}>
                  <input type="radio" checked={launchLevel === opt.id} onChange={() => setLaunchLevel(opt.id)} />
                  <span style={{ fontSize: 11, color: T.textPrimary }}>{opt.label}</span>
                </label>
              ))}
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '10px 12px',
                background: launchStealth ? T.accent + '22' : T.bg0,
                border: `1px solid ${launchStealth ? T.accent : T.border}`,
                borderRadius: 5, cursor: 'pointer',
              }}>
                <input type="checkbox" checked={launchStealth} onChange={e => setLaunchStealth(e.target.checked)} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: T.textPrimary }}>🥷 Stealth mode</div>
                  <div style={{ fontSize: 9, color: T.textTertiary, marginTop: 2 }}>
                    Random UAs, lower rates, downgrades Nuclei full→default.
                  </div>
                </div>
              </label>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, marginBottom: 6 }}>
                Speed
              </div>
              {[
                { id: 'standard', label: 'Standard', detail: 'Default rates' },
                { id: 'slow', label: 'Slow', detail: 'Rate ÷ 5' },
                { id: 'glacial', label: 'Glacial', detail: 'Rate ÷ 17' },
              ].map(opt => (
                <label key={opt.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '6px 10px', marginBottom: 4,
                  background: launchSpeed === opt.id ? T.accent + '22' : T.bg0,
                  border: `1px solid ${launchSpeed === opt.id ? T.accent : T.border}`,
                  borderRadius: 5, cursor: 'pointer',
                }}>
                  <input type="radio" checked={launchSpeed === opt.id} onChange={() => setLaunchSpeed(opt.id)} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: T.textPrimary }}>{opt.label}</div>
                    <div style={{ fontSize: 9, color: T.textTertiary }}>{opt.detail}</div>
                  </div>
                </label>
              ))}
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, marginBottom: 6 }}>
                GitHub PAT <span style={{ color: T.textMuted, fontWeight: 400 }}>(optional)</span>
              </div>
              <input type="password" value={launchPat}
                onChange={e => setLaunchPat(e.target.value)}
                placeholder="ghp_... (blank to skip GitHub Recon)"
                style={{
                  width: '100%', padding: '7px 10px',
                  background: T.bg0, border: `1px solid ${T.border}`,
                  color: T.textPrimary, fontSize: 11, fontFamily: T.fontMono,
                  borderRadius: 4, outline: 'none',
                }} />
            </div>

            {launchError && (
              <div style={{
                padding: 10, marginBottom: 12, fontSize: 10,
                background: T.red + '22', border: `1px solid ${T.red}66`,
                color: T.red, borderRadius: 4,
              }}>{launchError}</div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowLaunch(false)} disabled={launchPending}
                style={{
                  background: T.bg2, border: `1px solid ${T.border}`,
                  color: T.textSecondary, padding: '8px 16px',
                  borderRadius: 4, fontSize: 11, cursor: 'pointer',
                }}>Cancel</button>
              <button onClick={startSweep} disabled={launchPending}
                style={{
                  background: launchPending ? T.bg2 : T.accent,
                  border: 'none', color: '#fff',
                  padding: '8px 16px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                  cursor: launchPending ? 'wait' : 'pointer',
                }}>{launchPending ? 'Starting...' : '🚀 Launch'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── ExportPanel — download workbench data as zip ──────────────────────────
function ExportPanel({ wbId, apiKey }) {
  const [showModal, setShowModal] = useState(false);
  const [include, setInclude] = useState({
    recon: true, summaries: true, tools: false, mirror: false,
  });
  const [estimate, setEstimate] = useState(null);

  useEffect(() => {
    if (!showModal) return;
    let cancelled = false;
    const params = new URLSearchParams({
      recon: include.recon ? '1' : '0',
      summaries: include.summaries ? '1' : '0',
      tools: include.tools ? '1' : '0',
      mirror: include.mirror ? '1' : '0',
    });
    fetch(`/api/workbenches/${wbId}/export/estimate?${params}`, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    }).then(r => r.json()).then(d => { if (!cancelled) setEstimate(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [wbId, apiKey, showModal, include.recon, include.summaries, include.tools, include.mirror]);

  const download = () => {
    const params = new URLSearchParams({
      recon: include.recon ? '1' : '0',
      summaries: include.summaries ? '1' : '0',
      tools: include.tools ? '1' : '0',
      mirror: include.mirror ? '1' : '0',
    });
    const url = `/api/workbenches/${wbId}/export/zip?${params}`;
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = url;
    document.body.appendChild(iframe);
    setTimeout(() => iframe.remove(), 60000);
    setShowModal(false);
  };

  const big = estimate && estimate.totalBytes > 200 * 1024 * 1024;

  return (
    <>
      <div style={{
        background: T.bg1, border: `1px solid ${T.border}`,
        borderRadius: 8, padding: 14,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontSize: 16 }}>💾</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.textPrimary }}>Export workbench</div>
          <div style={{ fontSize: 10, color: T.textTertiary, marginTop: 2 }}>
            Download recon, findings, and optionally tool runs as a zip.
          </div>
        </div>
        <button onClick={() => setShowModal(true)}
          style={{
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            color: T.accentHi, padding: '7px 14px', borderRadius: 5,
            fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}>↓ Export...</button>
      </div>

      {showModal && (
        <div onClick={() => setShowModal(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: T.bg1, border: `1px solid ${T.border}`,
            borderRadius: 8, padding: 22, maxWidth: 480, width: '100%',
          }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: T.textPrimary, marginBottom: 12 }}>
              💾 Export workbench
            </div>
            {[
              { key: 'recon', title: 'Recon data', detail: 'All flat files' },
              { key: 'summaries', title: 'Summaries', detail: 'recon_summary, findings, brief.md' },
              { key: 'tools', title: 'Tool runs', detail: 'Per-tool output dirs' },
              { key: 'mirror', title: 'Site Mirror downloads', detail: 'Full HTML/JS dumps' },
            ].map(opt => (
              <label key={opt.key} style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '10px 12px', marginBottom: 6,
                background: include[opt.key] ? T.accent + '22' : T.bg0,
                border: `1px solid ${include[opt.key] ? T.accent : T.border}`,
                borderRadius: 5, cursor: 'pointer',
              }}>
                <input type="checkbox" checked={include[opt.key]}
                  onChange={e => setInclude(prev => ({ ...prev, [opt.key]: e.target.checked }))} />
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: T.textPrimary }}>{opt.title}</div>
                  <div style={{ fontSize: 9, color: T.textTertiary, marginTop: 2 }}>{opt.detail}</div>
                </div>
              </label>
            ))}
            <div style={{
              margin: '14px 0', padding: 10, fontSize: 11,
              background: big ? T.amber + '22' : T.bg0,
              border: `1px solid ${big ? T.amber + '66' : T.border}`,
              borderRadius: 4,
            }}>
              {estimate ? (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                  <span style={{ color: T.textSecondary }}>
                    {estimate.fileCount || 0} file(s), {estimate.formatted || '0B'}
                  </span>
                  {big && <span style={{ color: T.amber, fontSize: 10 }}>⚠ Large download</span>}
                </div>
              ) : <span style={{ color: T.textMuted }}>Calculating...</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowModal(false)}
                style={{
                  background: T.bg2, border: `1px solid ${T.border}`,
                  color: T.textSecondary, padding: '8px 16px',
                  borderRadius: 4, fontSize: 11, cursor: 'pointer',
                }}>Cancel</button>
              <button onClick={download}
                disabled={!estimate || estimate.error || estimate.fileCount === 0}
                style={{
                  background: (!estimate || estimate.error || estimate.fileCount === 0) ? T.bg2 : T.accent,
                  border: 'none', color: '#fff',
                  padding: '8px 16px', borderRadius: 4,
                  fontSize: 11, fontWeight: 600,
                  cursor: (!estimate || estimate.error || estimate.fileCount === 0) ? 'not-allowed' : 'pointer',
                }}>↓ Download zip</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


// ── Brief / hypothesis side panel ──────────────────────────────────────────
function BriefPanel({ reconRunning, reconPhase, onRunRecon, onDeepen, wbId, apiKey }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 8,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '10px 12px', borderBottom: collapsed ? 'none' : `1px solid ${T.border}`, background: T.bg2,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setCollapsed(c => !c)}
            title={collapsed ? 'Expand panel' : 'Collapse panel'}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: T.textTertiary, padding: 0, fontSize: 12,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 16, height: 16,
              transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s',
            }}>
            ▾
          </button>
          <span style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Workbench
          </span>
          {reconRunning && (
            <span style={{
              fontSize: 10, color: T.amber,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.amber, animation: 'pulse 1.5s infinite' }} />
              {reconPhase || 'recon running'}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={onRunRecon}
            disabled={reconRunning}
            title="Re-run the full streaming recon from scratch"
            style={{
              background: reconRunning ? T.bg3 : T.accentDim,
              border: `1px solid ${T.accent}66`, borderRadius: 4,
              padding: '3px 8px', fontSize: 10, color: T.accentHi,
              cursor: reconRunning ? 'wait' : 'pointer',
            }}>
            {reconRunning ? '...' : '↻ rerun'}
          </button>
          <DeepenMenu onDeepen={onDeepen} disabled={reconRunning} />
        </div>
      </div>

      {!collapsed && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          <ReconDataPanel wbId={wbId} apiKey={apiKey} />
          <DirectiveHistory wbId={wbId} apiKey={apiKey} />
        </div>
      )}
    </div>
  );
}

// ── Artifact viewer modal ──────────────────────────────────────────────────
function ArtifactModal({ artifact, onClose }) {
  const [copied, setCopied] = useState(false);
  if (!artifact) return null;

  const copy = () => {
    navigator.clipboard.writeText(artifact.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const download = () => {
    const blob = new Blob([artifact.code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = artifact.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(900px, 100%)', height: 'min(700px, 90vh)',
        background: T.bg0, border: `1px solid ${T.border}`,
        borderRadius: 10,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px',
          background: T.bg1, borderBottom: `1px solid ${T.border}`,
        }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.textPrimary }}>
              📄 {artifact.name}
            </div>
            <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>
              {artifact.language} · {artifact.code?.length || 0} chars
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={copy} style={{
              background: copied ? T.green + '22' : T.accentDim,
              border: `1px solid ${copied ? T.green : T.accent}66`,
              color: copied ? T.green : T.accentHi,
              padding: '5px 10px', borderRadius: 4, fontSize: 11,
            }}>{copied ? '✓ Copied' : 'Copy'}</button>
            <button onClick={download} style={{
              background: T.accentDim, border: `1px solid ${T.accent}66`,
              color: T.accentHi, padding: '5px 10px', borderRadius: 4, fontSize: 11,
            }}>Download</button>
            <button onClick={onClose} style={{
              background: 'transparent', border: 'none',
              color: T.textTertiary, fontSize: 18, padding: '0 6px',
              cursor: 'pointer',
            }}>✕</button>
          </div>
        </div>
        <pre style={{
          flex: 1, overflow: 'auto', margin: 0,
          padding: 16,
          fontFamily: T.fontMono, fontSize: 13, lineHeight: 1.5,
          color: T.textPrimary, background: T.bg0,
          whiteSpace: 'pre',
        }}>{artifact.code}</pre>
      </div>
    </div>
  );
}


// ── Workbench switcher (header dropdown) ───────────────────────────────────
function WorkbenchSwitcher({ currentWbId, currentTarget, apiKey, isMobile, onSwitch }) {
  const [open, setOpen] = useState(false);
  const [workbenches, setWorkbenches] = useState([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Fetch list when opened
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetch('/api/workbenches', { headers: apiKey ? { 'x-api-key': apiKey } : {} })
      .then(r => r.json())
      .then(d => { if (!cancelled) setWorkbenches(d.workbenches || []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, apiKey]);

  return (
    <div ref={ref} style={{ position: 'relative', minWidth: 0, flex: 1 }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Switch to a different workbench"
        style={{
          background: open ? T.bg2 : 'transparent',
          border: `1px solid ${open ? T.borderHi : 'transparent'}`,
          borderRadius: 5,
          padding: isMobile ? '4px 8px' : '4px 10px',
          cursor: 'pointer',
          color: T.textPrimary, fontSize: 13, fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 6,
          minWidth: 0, maxWidth: '100%',
          textAlign: 'left',
        }}>
        <span style={{
          color: T.accentHi,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
        }}>{currentTarget || 'Workbench'}</span>
        <span style={{ color: T.textTertiary, fontSize: 10, flexShrink: 0 }}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', left: 0, top: 'calc(100% + 4px)',
          minWidth: 280, maxWidth: 'min(420px, 90vw)',
          maxHeight: '60vh', overflowY: 'auto',
          background: T.bg1, border: `1px solid ${T.border}`,
          borderRadius: 6, boxShadow: '0 6px 20px rgba(0,0,0,0.5)',
          zIndex: 200,
        }}>
          <div style={{
            padding: '8px 12px', borderBottom: `1px solid ${T.border}`,
            fontSize: 10, color: T.textTertiary,
            textTransform: 'uppercase', letterSpacing: 0.5,
          }}>
            Switch workbench {workbenches.length > 0 ? `(${workbenches.length})` : ''}
          </div>
          {loading && (
            <div style={{ padding: 12, fontSize: 11, color: T.textMuted, fontStyle: 'italic' }}>
              Loading...
            </div>
          )}
          {!loading && workbenches.length === 0 && (
            <div style={{ padding: 12, fontSize: 11, color: T.textMuted, fontStyle: 'italic' }}>
              No other workbenches.
            </div>
          )}
          {!loading && workbenches.map(w => {
            const isCurrent = w.wbId === currentWbId;
            return (
              <div key={w.wbId}
                onClick={() => {
                  setOpen(false);
                  if (!isCurrent) onSwitch(w.wbId);
                }}
                style={{
                  padding: '8px 12px',
                  cursor: isCurrent ? 'default' : 'pointer',
                  borderBottom: `1px solid ${T.border}`,
                  background: isCurrent ? T.accentDim : 'transparent',
                  opacity: isCurrent ? 0.6 : 1,
                }}
                onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = T.bg2; }}
                onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = 'transparent'; }}>
                <div style={{
                  fontSize: 12, fontWeight: 500, color: T.textPrimary,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span style={{
                    color: isCurrent ? T.accentHi : T.textPrimary,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{w.target}</span>
                  {isCurrent && <span style={{ fontSize: 9, color: T.accentHi }}>(current)</span>}
                </div>
                <div style={{
                  fontSize: 9, color: T.textMuted, marginTop: 2,
                  display: 'flex', justifyContent: 'space-between',
                }}>
                  <span style={{ fontFamily: T.fontMono }}>{w.wbId}</span>
                  <span>{w.lastActiveAt ? new Date(w.lastActiveAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—'}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


// ── Directive history (collapsible section in brief panel) ─────────────────
function DirectiveHistory({ wbId, apiKey }) {
  const [records, setRecords] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(null); // currently-viewing record full detail
  const [openLoading, setOpenLoading] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    fetch(`/api/workbenches/${wbId}/directives`, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    }).then(r => r.json()).then(d => { if (!cancelled) setRecords(d.records || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [expanded, wbId, apiKey]);

  const openDetail = async (planId) => {
    setOpenLoading(true);
    try {
      const r = await fetch(`/api/workbenches/${wbId}/directives/${planId}`, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      if (r.ok) {
        const d = await r.json();
        setOpen(d.record);
      }
    } finally {
      setOpenLoading(false);
    }
  };

  return (
    <div style={{ marginTop: 16 }}>
      <div onClick={() => setExpanded(e => !e)}
        style={{
          cursor: 'pointer',
          fontSize: 10, fontWeight: 600, color: T.textSecondary,
          textTransform: 'uppercase', letterSpacing: 0.5,
          display: 'flex', alignItems: 'center', gap: 6,
          marginBottom: 8,
        }}>
        <span style={{ color: T.textTertiary, fontSize: 9 }}>{expanded ? '▼' : '▶'}</span>
        Directive history {records.length > 0 && expanded ? `(${records.length})` : ''}
      </div>
      {expanded && (
        <>
          {records.length === 0 ? (
            <div style={{ fontSize: 10, color: T.textMuted, fontStyle: 'italic', padding: '4px 8px' }}>
              No directives executed yet. Ask Tentacles to "test apidev for XSS" or similar.
            </div>
          ) : records.map(r => {
            const accent = r.verdict === 'vulnerable' ? T.red
                        : r.verdict === 'not_vulnerable' ? T.green
                        : T.amber;
            const icon = r.verdict === 'vulnerable' ? '🚨'
                       : r.verdict === 'not_vulnerable' ? '✓'
                       : '🤔';
            return (
              <div key={r.planId}
                onClick={() => openDetail(r.planId)}
                style={{
                  background: T.bg0, border: `1px solid ${T.border}`,
                  borderLeft: `2px solid ${accent}`,
                  borderRadius: 4, padding: '6px 8px',
                  marginBottom: 4, cursor: 'pointer',
                  fontSize: 10,
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 11 }}>{icon}</span>
                  <span style={{ color: T.textPrimary, fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.test_class}: {r.target}
                  </span>
                </div>
                {r.headline && (
                  <div style={{ color: T.textTertiary, fontSize: 9, marginTop: 2, lineHeight: 1.4,
                    overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
                    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  }}>
                    {r.headline}
                  </div>
                )}
                <div style={{ fontSize: 8, color: T.textMuted, marginTop: 2 }}>
                  {new Date(r.finished_at).toLocaleString()}
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* Detail modal for a specific past directive */}
      {open && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1100,
          background: 'rgba(0,0,0,0.75)', padding: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setOpen(null)}>
          <div onClick={e => e.stopPropagation()} style={{
            width: 'min(720px, 100%)', maxHeight: '85vh',
            background: T.bg1, border: `1px solid ${T.border}`,
            borderRadius: 10, overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{
              padding: '10px 14px', borderBottom: `1px solid ${T.border}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: T.textPrimary }}>
                  {open.plan?.test_class} on {open.plan?.target}
                </div>
                <div style={{ fontSize: 10, color: T.textMuted, marginTop: 2 }}>
                  {open.directive}
                </div>
              </div>
              <button onClick={() => setOpen(null)}
                style={{
                  background: 'transparent', border: 'none',
                  color: T.textTertiary, fontSize: 18, padding: '0 6px',
                  cursor: 'pointer',
                }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: T.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Verdict</div>
                <div style={{ fontSize: 12, color: T.textPrimary, marginBottom: 4 }}>
                  {open.verdict?.headline}
                </div>
                <div style={{ fontSize: 11, color: T.textSecondary, lineHeight: 1.5 }}>
                  {open.verdict?.evidence}
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 9, fontWeight: 600, color: T.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Probes ({open.results?.length || 0})</div>
                {(open.results || []).map((r, i) => (
                  <details key={i} style={{
                    background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4,
                    padding: 6, marginBottom: 4,
                  }}>
                    <summary style={{ fontSize: 10, color: T.textPrimary, cursor: 'pointer', fontFamily: T.fontMono }}>
                      {r.label} ({r.duration_ms}ms)
                    </summary>
                    <div style={{ marginTop: 6, fontFamily: T.fontMono, fontSize: 10, color: T.textTertiary }}>
                      <div style={{ color: T.accentHi, wordBreak: 'break-all' }}>$ {r.command}</div>
                      <pre style={{ margin: '4px 0', padding: 6, background: T.bg1, borderRadius: 3, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {r.output || r.error || '(no output)'}
                      </pre>
                    </div>
                  </details>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Workbench ──────────────────────────────────────────────────────────
function WorkbenchInner({ wbId, apiKey, onClose, onSwitch }) {
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);

  const [wb, setWb] = useState(null);
  const [messages, setMessages] = useState([]);
  const [brief, setBrief] = useState('');
  const [artifacts, setArtifacts] = useState([]);
  const [openArtifact, setOpenArtifact] = useState(null);
  const [connStatus, setConnStatus] = useState('connecting');
  const [typing, setTyping] = useState(false);
  const [reconRunning, setReconRunning] = useState(false);
  const [reconPhase, setReconPhase] = useState(null);
  const [directiveStatus, setDirectiveStatus] = useState({}); // planId -> 'pending' | 'running' | 'done'
  const [reconnectIn, setReconnectIn] = useState(0);
  const [pendingQuote, setPendingQuote] = useState(''); // selected text waiting to be sent
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 720);

  // Shell layout state
  const [activeTab, setActiveTab] = useState('overview');  // overview | findings | tool_runs | reports | recon
  const [chatVisible, setChatVisible] = useState(true);
  const [reconSummary, setReconSummary] = useState({ counts: {}, hasData: false });
  const [workbenchList, setWorkbenchList] = useState([]);
  const [showRerunModal, setShowRerunModal] = useState(false);
  const [rerunBusy, setRerunBusy] = useState(false);

  // Mobile breakpoint listener
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 720);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // When wbId changes (workbench switcher), clear all per-workbench state
  // so the new workbench starts fresh from the 'attached' payload
  useEffect(() => {
    setMessages([]);
    setBrief('');
    setArtifacts([]);
    setOpenArtifact(null);
    setReconRunning(false);
    setReconPhase(null);
    setDirectiveStatus({});
    setPendingQuote('');
    setTyping(false);
  }, [wbId]);

  // Load recon summary for stat cards (refreshes when recon completes)
  useEffect(() => {
    if (!wbId) return;
    let cancelled = false;
    const loadSummary = async () => {
      try {
        const r = await fetch(`/api/workbenches/${wbId}/recon-summary`, {
          headers: apiKey ? { 'x-api-key': apiKey } : {},
        });
        if (!r.ok) return;
        const d = await r.json();
        if (cancelled) return;
        setReconSummary(d || { counts: {}, hasData: false });
        // Polling fallback: if backend says recon is no longer running but UI thinks it still is,
        // sync local state. Covers the case where the recon_finished WS message was missed.
        if (reconRunning && d && d.reconRunning === false) {
          setReconRunning(false);
          setReconPhase(null);
        }
      } catch {}
    };
    loadSummary();
    // Reload when recon stops (so counts update)
    const id = setInterval(loadSummary, reconRunning ? 4000 : 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [wbId, apiKey, reconRunning]);

  // Load workbench list for the header dropdown
  useEffect(() => {
    if (!apiKey && !wbId) return;
    let cancelled = false;
    fetch('/api/workbenches', { headers: apiKey ? { 'x-api-key': apiKey } : {} })
      .then(r => r.json())
      .then(d => { if (!cancelled) setWorkbenchList(d.workbenches || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [wbId, apiKey]);

  const stopRecon = useCallback(async () => {
    try {
      await fetch(`/api/workbenches/${wbId}/recon/stop`, {
        method: 'POST',
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
    } catch {}
  }, [wbId, apiKey]);

  // Build WebSocket connection — with auto-reconnect on drop
  // (laptop sleep, wifi blip, server restart all transparently recover)
  useEffect(() => {
    if (!wbId) return;
    let attempt = 0;
    let pingInterval = null;
    let reconnectTimer = null;
    let countdownInterval = null;
    let cancelled = false;
    let manualClose = false;

    const handleMessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      switch (msg.type) {
        case 'attached':
          setWb(msg.wb);
          setMessages(msg.messages || []);
          setBrief(msg.brief || '');
          setArtifacts(msg.artifacts || []);
          setReconRunning(!!msg.reconRunning);
          setConnStatus('connected');
          attempt = 0;
          setReconnectIn(0);
          break;
        case 'directive_started':
          setDirectiveStatus(prev => ({ ...prev, [msg.planId]: 'running' }));
          break;
        case 'directive_done':
          setDirectiveStatus(prev => ({ ...prev, [msg.planId]: 'done' }));
          break;
        case 'chat_message':
          setMessages(prev => {
            // Idempotent insert — skip if already present (handles replay after reconnect)
            if (prev.find(p => p.ts === msg.message.ts && p.role === msg.message.role && p.content === msg.message.content)) {
              return prev;
            }
            return [...prev, msg.message];
          });
          break;
        case 'artifact':
          setArtifacts(prev => {
            const exists = prev.find(a => a.artifactId === msg.artifact.artifactId);
            if (exists) return prev;
            return [msg.artifact, ...prev];
          });
          break;
        case 'pong': break;
        case 'recon_finished':
          // Backend signals baseline recon has finished — flip UI state so tools become enabled
          setReconRunning(false);
          setReconPhase(null);
          // Also refresh recon summary + brief so counts/text update immediately
          fetch(`/api/workbenches/${wbId}/recon-summary`, {
            headers: apiKey ? { 'x-api-key': apiKey } : {},
          }).then(r => r.json()).then(d => setReconSummary(d || {})).catch(() => {});
          fetch(`/api/workbenches/${wbId}/brief`, {
            headers: apiKey ? { 'x-api-key': apiKey } : {},
          }).then(r => r.text()).then(t => setBrief(t)).catch(() => {});
          break;
        case 'error':
          console.error('Workbench WS error:', msg.message);
          break;
      }
    };

    const scheduleReconnect = () => {
      attempt += 1;
      // Exponential backoff with jitter, capped at 30 seconds
      const base = Math.min(30, Math.pow(2, attempt));
      const jitter = Math.random() * 0.4 + 0.8;
      const delaySec = Math.max(1, Math.round(base * jitter));
      setConnStatus('reconnecting');
      setReconnectIn(delaySec);
      let countdown = delaySec;
      if (countdownInterval) clearInterval(countdownInterval);
      countdownInterval = setInterval(() => {
        countdown -= 1;
        setReconnectIn(Math.max(0, countdown));
        if (countdown <= 0) clearInterval(countdownInterval);
      }, 1000);
      reconnectTimer = setTimeout(() => {
        if (countdownInterval) clearInterval(countdownInterval);
        connect();
      }, delaySec * 1000);
    };

    const connect = () => {
      if (cancelled) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws/workbench`;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      setConnStatus(attempt === 0 ? 'connecting' : 'reconnecting');

      ws.onopen = () => {
        if (cancelled) { try { ws.close(); } catch {}; return; }
        setConnStatus('attaching');
        ws.send(JSON.stringify({ type: 'attach', wbId }));
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
        }, 25000);
      };
      ws.onmessage = handleMessage;
      ws.onerror = () => { /* onclose will fire too */ };
      ws.onclose = () => {
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
        if (manualClose || cancelled) return;
        scheduleReconnect();
      };
    };

    connect();

    // When user comes back to the tab, try to reconnect immediately
    const onVisible = () => {
      if (document.visibilityState === 'visible' &&
          wsRef.current && wsRef.current.readyState !== 1 && wsRef.current.readyState !== 0) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (countdownInterval) clearInterval(countdownInterval);
        attempt = Math.max(0, attempt - 1);
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      manualClose = true;
      document.removeEventListener('visibilitychange', onVisible);
      if (pingInterval) clearInterval(pingInterval);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (countdownInterval) clearInterval(countdownInterval);
      try { wsRef.current && wsRef.current.close(); } catch {}
    };
  }, [wbId, apiKey]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, typing]);

  // Poll recon status every 5s while running
  useEffect(() => {
    if (!wbId) return;
    const tick = async () => {
      try {
        const r = await fetch(`/api/workbenches/${wbId}/recon`, {
          headers: apiKey ? { 'x-api-key': apiKey } : {},
        });
        if (r.ok) {
          const data = await r.json();
          setReconRunning(!!data.running);
          setReconPhase(data.phase);
          if (!data.running) {
            // Recon finished — refresh brief
            const briefR = await fetch(`/api/workbenches/${wbId}/brief`, {
              headers: apiKey ? { 'x-api-key': apiKey } : {},
            });
            if (briefR.ok) setBrief(await briefR.text());
          }
        }
      } catch {}
    };
    const id = setInterval(tick, 5000);
    tick();
    return () => clearInterval(id);
  }, [wbId, apiKey]);

  const onQuoteSelection = useCallback((selected) => {
    // Set as pending — ChatInput will display it as a quote-block above the textarea
    setPendingQuote(selected);
  }, []);

  // sendMessage / confirmDirective / cancelDirective are no-ops now that
  // chat input + LLM directives are removed. Kept as defined symbols so
  // ChatMessage components that still receive these as props don't crash.
  const sendMessage = useCallback(() => {}, []);
  const confirmDirective = useCallback(() => {}, []);
  const cancelDirective = useCallback(() => {}, []);

  const onArtifactClick = useCallback(async (artifactId) => {
    let art = artifacts.find(a => a.artifactId === artifactId);
    if (!art || !art.code) {
      // Fetch full artifact
      const r = await fetch(`/api/workbenches/${wbId}/artifacts/${artifactId}`, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      if (r.ok) {
        const data = await r.json();
        art = data.artifact;
      }
    }
    if (art) setOpenArtifact(art);
  }, [artifacts, wbId, apiKey]);

  const deepenRecon = useCallback(async (mode) => {
    try {
      const r = await fetch(`/api/workbenches/${wbId}/recon/deepen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
        body: JSON.stringify({ mode }),
      });
      // The deepen runs in background, findings stream into chat
      // No need to set local state — the chat updates on its own
    } catch {}
  }, [wbId, apiKey]);

  // Opens the rerun modal — the modal calls rerunWithOptions on confirm
  const triggerRecon = useCallback(() => {
    setShowRerunModal(true);
  }, []);

  const rerunWithOptions = useCallback(async (reconOptions) => {
    setRerunBusy(true);
    setReconRunning(true);
    try {
      await fetch(`/api/workbenches/${wbId}/recon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
        body: JSON.stringify({ reconOptions }),
      });
    } catch {}
    setRerunBusy(false);
    setShowRerunModal(false);
  }, [wbId, apiKey]);

  if (!wbId) return null;

  // Mobile-specific styles injected (slideUp keyframe)
  const mobileStyles = `
    @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  `;

  // ── Helper: render the activity stream panel (main + side dock) ─────────
  const renderChatPanel = (compact) => (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: T.bg1, border: `1px solid ${T.border}`,
      borderRadius: 8, overflow: 'hidden', minHeight: 0,
      flex: 1,
    }}>
      <div style={{
        padding: '8px 12px', borderBottom: `1px solid ${T.border}`,
        display: 'flex', alignItems: 'center', gap: 8,
        background: T.bg2,
      }}>
        <span style={{ color: T.amber, fontSize: 12 }}>⚡</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: T.textPrimary, letterSpacing: 0.3 }}>
          Activity
        </span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 9, color: connStatus === 'connected' ? T.green : T.amber,
        }}>
          ●
        </span>
        <span style={{ fontSize: 9, color: T.textTertiary }}>
          {connStatus}
        </span>
      </div>
      <div style={{
        flex: 1, overflowY: 'auto',
        padding: compact ? '10px 12px' : '12px 14px',
        background: T.bg0,
        WebkitOverflowScrolling: 'touch',
      }}>
        {messages.length === 0 ? (
          <div style={{
            color: T.textMuted, fontSize: 12,
            padding: 20, textAlign: 'center',
          }}>
            Live recon, sweep, and tool findings appear here as they happen.
          </div>
        ) : messages.map((m, i) => (
          <ChatMessage
            key={`${m.ts}-${i}`}
            message={m}
            onArtifactClick={onArtifactClick}
            onConfirmDirective={confirmDirective}
            onCancelDirective={cancelDirective}
            directiveStatus={m.meta?.planId ? directiveStatus[m.meta.planId] : null}
            onQuoteSelection={onQuoteSelection}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div style={{
        padding: '10px 14px',
        borderTop: `1px solid ${T.border}`,
        background: T.bg2,
        fontSize: 11,
        color: T.textTertiary,
        textAlign: 'center',
      }}>
        Live activity stream — recon, sweep, and tool findings appear here as they happen
      </div>
    </div>
  );

  // ── Tab content renderer ─────────────────────────────────────────────────
  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1, overflow: 'auto' }}>
            <StatCards summary={reconSummary} isMobile={isMobile} />
            <ToolLauncherPanel
              wbId={wbId}
              apiKey={apiKey}
              reconRunning={reconRunning}
              isMobile={isMobile}
              onLaunched={() => {/* tool started — chat will stream output */}}
            />
            <SweepPanel
              wbId={wbId}
              apiKey={apiKey}
              reconRunning={reconRunning}
            />
            <ExportPanel
              wbId={wbId}
              apiKey={apiKey}
            />
            <LiveScanPanel
              messages={messages}
              reconRunning={reconRunning}
              reconPhase={reconPhase}
              isMobile={isMobile}
            />
            <div style={{
              minHeight: 320,
              background: T.bg1, border: `1px solid ${T.border}`,
              borderRadius: 8, overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
            }}>
              <BriefPanel
                reconRunning={reconRunning}
                reconPhase={reconPhase}
                onRunRecon={triggerRecon}
                onDeepen={deepenRecon}
                wbId={wbId}
                apiKey={apiKey}
              />
            </div>
          </div>
        );

      case 'findings':
        return (
          <FindingsTab
            wbId={wbId}
            apiKey={apiKey}
            isMobile={isMobile}
          />
        );

      case 'tool_runs':
        return (
          <ToolRunsTab
            wbId={wbId}
            apiKey={apiKey}
            isMobile={isMobile}
          />
        );

      case 'reports':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 }}>
            <div style={{
              flex: 1, minHeight: 0,
              background: T.bg1, border: `1px solid ${T.border}`,
              borderRadius: 8, overflow: 'auto', padding: 18,
            }}>
              {brief ? (
                <div style={{
                  fontFamily: T.fontSans, fontSize: 13,
                  color: T.textPrimary, lineHeight: 1.7,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {brief}
                </div>
              ) : (
                <div style={{
                  color: T.textMuted, fontSize: 12, fontStyle: 'italic',
                  padding: 20, textAlign: 'center',
                }}>
                  {reconRunning
                    ? 'Brief will be generated when recon finishes — watch the live stream above for findings as they arrive.'
                    : 'No brief yet — run scan to generate one.'}
                </div>
              )}
            </div>
          </div>
        );

      case 'recon':
        return (
          <ReconViewSwitcher
            wbId={wbId}
            apiKey={apiKey}
            isMobile={isMobile}
          />
        );

      default:
        return null;
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: T.bg0, color: T.textPrimary,
      fontFamily: T.fontSans,
      display: 'flex', flexDirection: 'row',
      overflow: 'hidden',
    }}>
      <style>{mobileStyles}</style>

      {/* Sidebar (desktop only) */}
      {!isMobile && (
        <Sidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          isMobile={false}
          onClose={onClose}
        />
      )}

      {/* Main column (header + content + bottom mobile nav) */}
      <div style={{
        flex: 1, minWidth: 0,
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <ShellHeader
          target={wb?.target}
          wbId={wbId}
          onRunRecon={triggerRecon}
          onStopRecon={stopRecon}
          reconRunning={reconRunning}
          reconPhase={reconPhase}
          connStatus={connStatus}
          isMobile={isMobile}
          onToggleSidebar={() => {/* mobile drawer — see bottom nav */}}
          onToggleChat={() => setChatVisible(v => !v)}
          chatVisible={chatVisible}
          onSwitchWb={(newWbId) => onSwitch && onSwitch(newWbId)}
          workbenches={workbenchList}
        />

        {/* Content row: tab content + (optional) docked activity stream */}
        <div style={{
          flex: 1, minHeight: 0,
          display: 'flex', flexDirection: 'row',
          padding: isMobile ? 6 : 12,
          gap: isMobile ? 6 : 10,
          overflow: 'hidden',
        }}>
          {/* Tab content */}
          <div style={{
            flex: 1, minWidth: 0,
            display: (isMobile && chatVisible) ? 'none' : 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}>
            {renderTabContent()}
          </div>

          {/* Docked activity stream (desktop) */}
          {!isMobile && chatVisible && (
            <div style={{
              width: 380, flexShrink: 0,
              display: 'flex', flexDirection: 'column',
              minHeight: 0,
            }}>
              {renderChatPanel(true)}
            </div>
          )}

          {/* Mobile chat (full-width when shown) */}
          {isMobile && chatVisible && (
            <div style={{
              flex: 1, minWidth: 0,
              display: 'flex', flexDirection: 'column',
              minHeight: 0,
            }}>
              {renderChatPanel(true)}
            </div>
          )}
        </div>

        {/* Mobile bottom nav */}
        {isMobile && (
          <div style={{
            flexShrink: 0,
            background: T.bg1, borderTop: `1px solid ${T.border}`,
            display: 'flex', overflowX: 'auto',
            scrollbarWidth: 'none',
          }}>
            {[
              { id: 'overview',   label: 'Overview',   icon: '◈' },
              { id: 'recon',      label: 'Recon',      icon: '◊' },
              { id: 'findings',   label: 'Findings',   icon: '🚨' },
              { id: 'tool_runs',  label: 'Tools',      icon: '⚙' },
              { id: 'reports',    label: 'Reports',    icon: '◇' },
            ].map(item => {
              const active = activeTab === item.id && !chatVisible;
              return (
                <button key={item.id} onClick={() => { setActiveTab(item.id); setChatVisible(false); }}
                  style={{
                    flex: 1, minWidth: 60,
                    background: active ? T.accentDim : 'transparent',
                    border: 'none',
                    borderTop: `2px solid ${active ? T.accent : 'transparent'}`,
                    color: active ? T.accentHi : T.textTertiary,
                    padding: '8px 4px',
                    fontSize: 9, fontWeight: 500,
                    cursor: 'pointer',
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', gap: 2,
                  }}>
                  <span style={{ fontSize: 14 }}>{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Artifact modal */}
      {openArtifact && (
        <ArtifactModal artifact={openArtifact} onClose={() => setOpenArtifact(null)} />
      )}

      {/* Re-run recon modal */}
      {showRerunModal && (
        <RerunModal
          onClose={() => setShowRerunModal(false)}
          onRun={rerunWithOptions}
          busy={rerunBusy}
        />
      )}

    </div>
  );
}

export default function Workbench(props) {
  return (
    <WorkbenchErrorBoundary onClose={props.onClose}>
      <WorkbenchInner {...props} />
    </WorkbenchErrorBoundary>
  );
}
