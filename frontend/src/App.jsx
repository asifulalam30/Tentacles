import Workbench from './Workbench';
import React, { useState, useEffect, useRef, useCallback } from "react";
import { TentaclesLogo } from './TentaclesLogo';

// ─────────────────────────────────────────────────────────────────────────────
// TENTACLES — minimal app shell (lock screen + workbench list/create)
// All actual work happens inside <Workbench />. This file is just routing.
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = "";

const SESSION_KEY = "tentacles_auth_v2";
const SESSION_TTL = 8 * 60 * 60 * 1000;
function loadAuthSession() {
  try { const { exp } = JSON.parse(sessionStorage.getItem(SESSION_KEY)||"{}"); return Date.now() < (exp||0); } catch { return false; }
}
function saveAuthSession() { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ exp: Date.now() + SESSION_TTL })); }
function clearAuthSession() { sessionStorage.removeItem(SESSION_KEY); }
function loadApiKey() { return localStorage.getItem("tentacles_api_key") || ""; }
function saveApiKey(k) { localStorage.setItem("tentacles_api_key", k); }

const T = {
  bg0:"#0B0F1A", bg1:"#111827", bg2:"#1A2236", bg3:"#243047",
  border:"#1E2D45", borderHi:"#2E4165",
  textPrimary:"#F0F4FC", textSecondary:"#94A8C4", textTertiary:"#6B82A0", textMuted:"#4A6080",
  accent:"#3B82F6", accentHi:"#60A5FA", accentDim:"#1D3461",
  green:"#4ADE80", amber:"#FBBF24", red:"#F87171",
  fontSans:"'DM Sans','Segoe UI',system-ui,sans-serif",
  fontMono:"'JetBrains Mono','Fira Code',monospace",
  fontDisplay:"'Syne','DM Sans',system-ui,sans-serif",
};

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html{-webkit-text-size-adjust:100%;touch-action:manipulation}
  body{background:#0B0F1A;color:#F0F4FC;font-family:'DM Sans','Segoe UI',system-ui,sans-serif}
  ::-webkit-scrollbar{width:6px;height:6px}
  ::-webkit-scrollbar-track{background:#0B0F1A}
  ::-webkit-scrollbar-thumb{background:#1E2D45;border-radius:3px}
  @keyframes fadeUp  {from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  @keyframes fadeIn  {from{opacity:0}to{opacity:1}}
  @keyframes pulse   {0%,100%{opacity:1}50%{opacity:0.3}}
  @keyframes spin    {from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  @keyframes shake   {0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-7px)}40%,80%{transform:translateX(7px)}}
  @keyframes glow    {0%,100%{opacity:0.55}50%{opacity:1}}
  button{cursor:pointer;font-family:inherit;-webkit-tap-highlight-color:transparent}
  button:focus-visible{outline:2px solid #3B82F6;outline-offset:2px}
  input{-webkit-appearance:none;border-radius:0;font-family:inherit}
  input:focus,textarea:focus{outline:none;border-color:#3B82F6!important;box-shadow:0 0 0 3px #3B82F618!important}
  .card{background:#111827;border:1px solid #1E2D45;border-radius:8px}
  .cardh:hover{border-color:#2E4165;box-shadow:0 3px 16px rgba(0,0,0,0.3)}
`;

function Btn({variant="primary", onClick, disabled, children, style={}, title}){
  const vs = {
    primary: {background:T.accent, color:"#fff"},
    danger:  {background:T.red,    color:"#fff"},
    ghost:   {background:"transparent", color:T.textSecondary, border:`1px solid ${T.border}`},
  };
  return (
    <button disabled={disabled} onClick={onClick} title={title}
      style={{borderRadius:6, padding:"8px 14px", fontSize:13, fontWeight:500,
              border:"none", cursor:disabled?"not-allowed":"pointer",
              opacity:disabled?0.45:1, transition:"opacity 0.15s",
              ...vs[variant], ...style}}
      onMouseEnter={e=>{if(!disabled)e.currentTarget.style.opacity="0.82";}}
      onMouseLeave={e=>{e.currentTarget.style.opacity="1";}}>
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCK SCREEN
// ─────────────────────────────────────────────────────────────────────────────
function LockScreen({ onUnlock }) {
  const [val, setVal] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const ref = useRef(null);
  useEffect(() => { setTimeout(() => ref.current?.focus(), 100); }, []);

  async function submit(e) {
    e?.preventDefault();
    if (!val.trim() || busy) return;
    setBusy(true); setErr("");
    try {
      const res = await fetch(`${API_BASE}/api/auth/verify`, {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ password: val }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.apiKey) saveApiKey(data.apiKey);
        saveAuthSession(); onUnlock();
      } else {
        const j = await res.json().catch(() => ({}));
        setErr(j.error || "Incorrect password.");
        setVal(""); setShake(true);
        setTimeout(() => setShake(false), 600);
        ref.current?.focus();
      }
    } catch { setErr("Cannot reach backend — is it running?"); }
    setBusy(false);
  }

  return (
    <div style={{minHeight:"100vh", background:T.bg0, display:"flex",
                 alignItems:"center", justifyContent:"center", padding:16}}>
      <div style={{width:"min(420px, 100%)", background:T.bg1,
                   border:`1px solid ${T.border}`, borderRadius:14, padding:"32px 28px",
                   boxShadow:"0 40px 90px rgba(0,0,0,0.7)",
                   animation: shake ? "shake 0.5s ease both" : "fadeUp 0.4s ease both"}}>
        <div style={{display:"flex", alignItems:"center", gap:12, marginBottom:24}}>
          <TentaclesLogo size={40} radius={10} />
          <div>
            <div style={{fontSize:15, fontWeight:700, color:T.textPrimary,
                         fontFamily:T.fontDisplay, letterSpacing:"0.5px"}}>TENTACLES</div>
            <div style={{fontSize:9, color:T.textMuted, letterSpacing:"1.6px", marginTop:2}}>WORKBENCH</div>
          </div>
        </div>

        <h1 style={{fontSize:18, fontWeight:700, color:T.textPrimary,
                    fontFamily:T.fontDisplay, marginBottom:6}}>Sign in</h1>
        <p style={{fontSize:13, color:T.textTertiary, lineHeight:1.6, marginBottom:20}}>
          Enter your access password.
        </p>

        <form onSubmit={submit}>
          <input ref={ref} type="password" value={val} autoComplete="current-password"
            onChange={e=>{setVal(e.target.value); setErr("");}} disabled={busy}
            placeholder="Password"
            style={{width:"100%", background:T.bg2, color:T.textPrimary,
                    border:`1px solid ${T.border}`, borderRadius:6,
                    padding:"10px 12px", fontSize:14, marginBottom:12}}/>
          {err && (
            <div style={{fontSize:12, color:T.red, marginBottom:12}}>{err}</div>
          )}
          <Btn variant="primary" disabled={busy || !val.trim()}
            style={{width:"100%", padding:"10px 14px"}}>
            {busy ? "..." : "Sign in"}
          </Btn>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT TEST CREDS MANAGER (modal)
// ─────────────────────────────────────────────────────────────────────────────
function DefaultCredsModal({ apiKey, onClose }) {
  const [accounts, setAccounts] = useState([
    { label: "Attacker", username: "", password: "", loginPath: "/login" },
    { label: "Victim",   username: "", password: "", loginPath: "/login" },
  ]);
  const [busy, setBusy] = useState(false);
  const [exists, setExists] = useState(false);

  useEffect(() => {
    fetch('/api/default-credentials', {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    }).then(r => r.json()).then(d => {
      if (d.accounts && d.accounts.length > 0) {
        setAccounts(d.accounts);
        setExists(true);
      }
    }).catch(() => {});
  }, [apiKey]);

  const save = async () => {
    setBusy(true);
    try {
      await fetch('/api/default-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
        body: JSON.stringify({ accounts: accounts.filter(a => a.username) }),
      });
      onClose(true);
    } finally { setBusy(false); }
  };

  const del = async () => {
    if (!confirm("Delete saved test credentials?")) return;
    setBusy(true);
    try {
      await fetch('/api/default-credentials', {
        method: 'DELETE',
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      onClose(true);
    } finally { setBusy(false); }
  };

  return (
    <div style={{position:"fixed", inset:0, background:"rgba(0,0,0,0.75)",
                 display:"flex", alignItems:"center", justifyContent:"center",
                 zIndex:1000, padding:16}} onClick={() => onClose(false)}>
      <div className="card" onClick={e => e.stopPropagation()}
        style={{width:"min(560px, 100%)", padding:24, maxHeight:"90vh", overflowY:"auto"}}>
        <div style={{display:"flex", justifyContent:"space-between", marginBottom:14}}>
          <div style={{fontSize:15, fontWeight:600, color:T.textPrimary}}>Default Test Accounts</div>
          <button onClick={() => onClose(false)} style={{background:"transparent", border:"none",
            color:T.textTertiary, fontSize:20, padding:2, cursor:"pointer"}}>✕</button>
        </div>
        <div style={{padding:"10px 12px", background:T.bg2, borderRadius:6,
                     fontSize:11, color:T.textTertiary, lineHeight:1.6, marginBottom:14}}>
          Saved on the VPS at <code style={{color:T.accentHi}}>/opt/tentacles/default-credentials.json</code>
          {' '}(file mode 0600). Used by Tentacles when it runs authenticated tests.
        </div>
        {accounts.map((acc, idx) => (
          <div key={idx} style={{background:T.bg0, borderRadius:6, padding:"10px 12px",
            marginBottom:10, border:`1px solid ${T.border}`}}>
            <div style={{fontSize:11, fontWeight:600, color:T.accentHi, marginBottom:6}}>
              {acc.label || `Account ${idx+1}`}
            </div>
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:6}}>
              <input placeholder="Username/email" value={acc.username||""}
                onChange={e => setAccounts(prev => prev.map((a,i) => i===idx ? {...a, username:e.target.value} : a))}
                style={{background:T.bg2, color:T.textPrimary, border:`1px solid ${T.border}`,
                        borderRadius:5, padding:"6px 8px", fontSize:12}}/>
              <input type="password" placeholder="Password" value={acc.password||""}
                onChange={e => setAccounts(prev => prev.map((a,i) => i===idx ? {...a, password:e.target.value} : a))}
                style={{background:T.bg2, color:T.textPrimary, border:`1px solid ${T.border}`,
                        borderRadius:5, padding:"6px 8px", fontSize:12}}/>
            </div>
            <input placeholder="Login path" value={acc.loginPath||"/login"}
              onChange={e => setAccounts(prev => prev.map((a,i) => i===idx ? {...a, loginPath:e.target.value} : a))}
              style={{width:"100%", background:T.bg2, color:T.textPrimary,
                      border:`1px solid ${T.border}`, borderRadius:5, padding:"6px 8px", fontSize:12}}/>
          </div>
        ))}
        <button onClick={() => setAccounts(prev => [...prev, {label:"", username:"", password:"", loginPath:"/login"}])}
          style={{background:"transparent", border:`1px dashed ${T.border}`, borderRadius:6,
                  padding:"6px 10px", fontSize:11, color:T.textSecondary, marginBottom:14, width:"100%"}}>
          + Add another account
        </button>
        <div style={{display:"flex", gap:8}}>
          <Btn variant="primary" onClick={save} disabled={busy} style={{flex:1}}>
            {busy ? "..." : "💾 Save"}
          </Btn>
          {exists && <Btn variant="ghost" onClick={del} disabled={busy} style={{color:T.red}}>🗑 Delete</Btn>}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKBENCH HOME — list + create + delete
// ─────────────────────────────────────────────────────────────────────────────
// Map raw phase tokens (from retrox-recon.sh "PHASE N/10" banners) to friendly labels
const PHASE_LABELS = {
  '1/10':   'subdomain enum',
  '2/10':   'DNS resolution',
  '3/10':   'port scan',
  '3.5/10': 'HTTP probe',
  '4/10':   'HTTP probe',
  '5/10':   'URL collection',
  '6/10':   'JS analysis',
  '7/10':   'param extraction',
  '8/10':   'arjun discovery',
  '9/10':   'directory fuzzing',
  '10/10':  'cheap-win probes',
};

// Compact status pill for the dashboard list. Renders:
// Status pill for the dashboard. Dot color + blink reflect the combined
// recon + sweep state. Table:
//
//   pure idle (never run)        → blue,   solid
//   recon running                → yellow, blinking
//   recon done (no sweep)        → yellow, solid
//   sweep queued                 → blue,   solid
//   sweep running                → green,  blinking
//   sweep complete               → green,  solid
//   recon or sweep crashed       → red,    solid
function WorkbenchStatusPill({ wb }) {
  const reconRunning = wb.state === 'recon_running';
  const reconDone = wb.state === 'recon_complete';
  const sweepStatus = wb.sweepStatus;       // 'running' | 'completed' | 'cancelled' | 'crashed' | undefined
  const sweepQueued = !!wb.sweepQueued;
  const archived = !!wb.archived;

  let label;
  let dotColor;
  let pulse = false;

  // Priority order:
  //   1. Crash overrides everything
  //   2. Recon running
  //   3. Sweep running
  //   4. Sweep queued
  //   5. Sweep completed
  //   6. Recon done (no sweep yet)
  //   7. Idle (never run)
  if (sweepStatus === 'crashed' || sweepStatus === 'cancelled') {
    label = sweepStatus === 'crashed' ? 'sweep crashed' : 'sweep cancelled';
    dotColor = T.red;
  } else if (reconRunning) {
    const friendly = wb.reconPhase && PHASE_LABELS[wb.reconPhase];
    label = friendly || (wb.reconPhaseLabel ? String(wb.reconPhaseLabel).toLowerCase() : 'recon running');
    dotColor = T.amber;
    pulse = true;
  } else if (sweepStatus === 'running') {
    label = 'sweep running';
    dotColor = T.green;
    pulse = true;
  } else if (sweepQueued) {
    label = 'sweep queued';
    dotColor = T.accent;
  } else if (sweepStatus === 'completed') {
    label = 'sweep complete';
    dotColor = T.green;
  } else if (reconDone) {
    label = 'recon complete';
    dotColor = T.amber;
  } else {
    label = archived ? 'archived' : 'idle';
    dotColor = archived ? T.textMuted : T.accent;
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10, color: T.textMuted }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: dotColor,
        boxShadow: `0 0 6px ${dotColor}88`,
        animation: pulse ? 'pulse 1.5s ease-in-out infinite' : 'none',
        flexShrink: 0,
      }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </span>
  );
}

function WorkbenchHome({ apiKey, onOpen, onLogout }) {
  const [workbenches, setWorkbenches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createTarget, setCreateTarget] = useState("");
  const [creating, setCreating] = useState(false);
  const [pickerMode, setPickerMode] = useState('baseline'); // baseline | empty
  const [showCreds, setShowCreds] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [selectedWbIds, setSelectedWbIds] = useState(new Set());
  const [showMultiSweep, setShowMultiSweep] = useState(false);
  const [multiSweepLevel, setMultiSweepLevel] = useState('heavy');
  const [multiSweepStealth, setMultiSweepStealth] = useState(false);
  const [multiSweepSpeed, setMultiSweepSpeed] = useState('standard');
  const [multiSweepResult, setMultiSweepResult] = useState(null);
  const [multiSweepLaunching, setMultiSweepLaunching] = useState(false);
  const [queueState, setQueueState] = useState(null);

  // Poll the global sweep queue every 8s so the user can see slot usage
  useEffect(() => {
    let cancelled = false;
    const fetchQueue = async () => {
      try {
        const r = await fetch('/api/workbenches/sweep/queue', {
          headers: apiKey ? { 'x-api-key': apiKey } : {},
        });
        if (r.ok && !cancelled) setQueueState(await r.json());
      } catch {}
    };
    fetchQueue();
    const t = setInterval(fetchQueue, 8000);
    return () => { cancelled = true; clearInterval(t); };
  }, [apiKey]);

  const toggleSelected = (wbId) => {
    setSelectedWbIds(prev => {
      const next = new Set(prev);
      if (next.has(wbId)) next.delete(wbId);
      else next.add(wbId);
      return next;
    });
  };

  const launchMultiSweep = async () => {
    setMultiSweepLaunching(true);
    setMultiSweepResult(null);
    try {
      const r = await fetch('/api/workbenches/sweep/multi-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
        body: JSON.stringify({
          wbIds: Array.from(selectedWbIds),
          level: multiSweepLevel,
          stealth: multiSweepStealth,
          speed: multiSweepSpeed,
        }),
      });
      const d = await r.json();
      setMultiSweepResult(d);
    } catch (e) {
      setMultiSweepResult({ error: e.message });
    } finally {
      setMultiSweepLaunching(false);
    }
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const url = '/api/workbenches' + (showArchived ? '?includeArchived=1' : '');
      const r = await fetch(url, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      const d = await r.json();
      setWorkbenches(d.workbenches || []);
    } catch {}
    setLoading(false);
  }, [apiKey, showArchived]);

  // Silent refresh — used by the polling loop so we don't flicker the loading state
  const refreshSilent = useCallback(async () => {
    try {
      const url = '/api/workbenches' + (showArchived ? '?includeArchived=1' : '');
      const r = await fetch(url, {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
      });
      const d = await r.json();
      setWorkbenches(d.workbenches || []);
    } catch {}
  }, [apiKey, showArchived]);

  useEffect(() => { refresh(); }, [refresh]);

  // Adaptive polling: 3s while any workbench is recon_running OR has a sweep
  // running (so the dot/status feels live), 15s otherwise.
  useEffect(() => {
    const anyRunning = workbenches.some(w => w.state === 'recon_running' || w.sweepStatus === 'running');
    const period = anyRunning ? 3000 : 15000;
    const t = setInterval(refreshSilent, period);
    return () => clearInterval(t);
  }, [refreshSilent, workbenches]);

  const [autoSweepOnCreate, setAutoSweepOnCreate] = useState(true);

  const create = async () => {
    if (!createTarget.trim()) return;
    setCreating(true);
    try {
      const target = createTarget.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const skipRecon = pickerMode === 'empty';
      const r = await fetch('/api/workbenches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
        body: JSON.stringify({ target, skipRecon, skipAutoSweep: !autoSweepOnCreate }),
      });
      const d = await r.json();
      if (d.workbench) onOpen(d.workbench.wbId);
      else alert(d.error || 'Failed to create workbench');
    } finally { setCreating(false); setShowCreate(false); setCreateTarget(""); setPickerMode('baseline'); }
  };

  const remove = async (wbId, target) => {
    if (!confirm(`Delete workbench for ${target}?`)) return;
    await fetch(`/api/workbenches/${wbId}`, {
      method: 'DELETE',
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    });
    refresh();
  };

  return (
    <div style={{minHeight:"100vh", background:T.bg0, padding:"20px 16px"}}>
      <div style={{maxWidth:960, margin:"0 auto"}}>
        {/* Header */}
        <div style={{display:"flex", alignItems:"center", justifyContent:"space-between",
                     marginBottom:24, flexWrap:"wrap", gap:12}}>
          <div style={{display:"flex", alignItems:"center", gap:12}}>
            <TentaclesLogo size={36} radius={8} />
            <div>
              <div style={{fontSize:18, fontWeight:700, color:T.textPrimary,
                           fontFamily:T.fontDisplay, letterSpacing:"0.4px"}}>TENTACLES</div>
              <div style={{fontSize:10, color:T.textMuted, letterSpacing:"1.4px"}}>WORKBENCH</div>
            </div>
          </div>
          <div style={{display:"flex", gap:8}}>
            <Btn variant="ghost" onClick={() => setShowCreds(true)}>🔑 Creds</Btn>
            <Btn variant="ghost" onClick={onLogout}>↩ Sign out</Btn>
          </div>
        </div>

        {/* List + create button */}
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center",
                     marginBottom:14, flexWrap:"wrap", gap:8}}>
          <div style={{fontSize:14, color:T.textSecondary}}>
            {loading ? "Loading…"
              : workbenches.length === 0 ? "No workbenches yet."
              : `${workbenches.length} workbench${workbenches.length===1?"":"es"}`}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <label style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              cursor: 'pointer', fontSize: 11, color: T.textTertiary,
              userSelect: 'none',
            }}>
              <input type="checkbox" checked={showArchived}
                onChange={e => setShowArchived(e.target.checked)} />
              Show archived
            </label>
            <Btn variant="primary" onClick={() => setShowCreate(true)}>+ New workbench</Btn>
          </div>
        </div>

        {/* Sweep queue + multi-select toolbar */}
        {workbenches.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            marginBottom: 14, padding: '8px 12px',
            background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 6,
          }}>
            {queueState && queueState.running && Array.isArray(queueState.running) && (
              <div style={{ fontSize: 11, color: T.textSecondary }}>
                Sweep queue: <span style={{ color: T.accentHi, fontWeight: 600 }}>
                  {queueState.running.length}/{queueState.maxConcurrent || 3}
                </span>
                {' '}running{(queueState.queued || []).length > 0 ? `, ${queueState.queued.length} queued` : ''}
              </div>
            )}
            <span style={{ flex: 1 }} />
            {selectedWbIds.size > 0 && (
              <>
                <span style={{ fontSize: 11, color: T.amber, fontWeight: 600 }}>
                  {selectedWbIds.size} selected
                </span>
                <button onClick={() => setSelectedWbIds(new Set())}
                  style={{
                    background: T.bg2, border: `1px solid ${T.border}`,
                    color: T.textSecondary, padding: '5px 10px', borderRadius: 4,
                    fontSize: 11, cursor: 'pointer',
                  }}>Clear</button>
                <button onClick={() => setShowMultiSweep(true)}
                  style={{
                    background: T.accent, border: 'none',
                    color: '#fff', padding: '6px 12px', borderRadius: 4,
                    fontSize: 11, fontWeight: 600, cursor: 'pointer',
                  }}>🚀 Sweep {selectedWbIds.size} target{selectedWbIds.size === 1 ? '' : 's'}</button>
              </>
            )}
          </div>
        )}

        {/* Workbench cards */}
        <div style={{display:"grid",
                     gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))",
                     gap:12}}>
          {workbenches.map(w => {
            const selected = selectedWbIds.has(w.wbId);
            const reconDone = w.state === 'recon_complete';
            const sweepStatus = w.sweepStatus;
            const sweepQueued = !!w.sweepQueued;
            const canRunSweep = reconDone && sweepStatus !== 'running' && !sweepQueued;
            const canArchive = !w.archived && (sweepStatus === 'completed' || sweepStatus === 'cancelled' || sweepStatus === 'crashed');
            const isArchived = !!w.archived;
            return (
            <div key={w.wbId} className="card cardh" style={{
              padding: 14, transition: 'all 0.15s',
              border: selected ? `2px solid ${T.accent}` : undefined,
              opacity: isArchived ? 0.55 : 1,
            }}>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start",
                           marginBottom:8, gap:8}}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flex: 1, minWidth: 0 }}>
                  <input type="checkbox" checked={selected}
                    onChange={() => toggleSelected(w.wbId)}
                    onClick={e => e.stopPropagation()}
                    title="Select for multi-target sweep"
                    style={{ marginTop: 4, cursor: 'pointer' }} />
                  <div onClick={() => onOpen(w.wbId)} style={{cursor:"pointer", flex:1, minWidth:0}}>
                    <div style={{fontSize:14, fontWeight:600, color:T.accentHi,
                                 overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                      {w.target}
                    </div>
                    <div style={{fontSize:10, color:T.textMuted, fontFamily:T.fontMono, marginTop:2}}>
                      {w.wbId}
                    </div>
                  </div>
                </div>
                <button onClick={(e) => { e.stopPropagation(); remove(w.wbId, w.target); }}
                  style={{background:"transparent", border:"none", color:T.textTertiary,
                          fontSize:16, padding:"2px 6px", cursor:"pointer"}}
                  title="Delete">🗑</button>
              </div>
              <div style={{display:"flex", justifyContent:"space-between", alignItems:"center",
                           fontSize:10, color:T.textMuted, gap: 6}}>
                <WorkbenchStatusPill wb={w} />
                <span>{w.lastActiveAt ? new Date(w.lastActiveAt).toLocaleString([], {dateStyle:"short", timeStyle:"short"}) : '—'}</span>
              </div>
              {/* Action row */}
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <button onClick={() => onOpen(w.wbId)}
                  style={{flex:1, background:T.accentDim,
                          border:`1px solid ${T.accent}55`, color:T.accentHi,
                          padding:"6px 10px", borderRadius:5, fontSize:11,
                          cursor:"pointer", fontWeight:500}}>
                  Open
                </button>
                {canRunSweep && (
                  <button onClick={() => {
                    setSelectedWbIds(new Set([w.wbId]));
                    setShowMultiSweep(true);
                  }}
                  title="Run full sweep on this target"
                  style={{background:T.accent,
                          border:'none', color:'#fff',
                          padding:"6px 10px", borderRadius:5, fontSize:11,
                          cursor:"pointer", fontWeight:600}}>
                    🚀 Sweep
                  </button>
                )}
                {canArchive && (
                  <button onClick={async () => {
                    try {
                      await fetch(`/api/workbenches/${w.wbId}/archive`, {
                        method: 'POST',
                        headers: apiKey ? { 'x-api-key': apiKey } : {},
                      });
                      refresh();
                    } catch {}
                  }}
                  title="Archive this workbench — hides from main list, data stays on disk"
                  style={{background:'transparent',
                          border:`1px solid ${T.border}`, color:T.textTertiary,
                          padding:"6px 10px", borderRadius:5, fontSize:11,
                          cursor:"pointer"}}>
                    📦 Archive
                  </button>
                )}
                {isArchived && (
                  <button onClick={async () => {
                    try {
                      await fetch(`/api/workbenches/${w.wbId}/unarchive`, {
                        method: 'POST',
                        headers: apiKey ? { 'x-api-key': apiKey } : {},
                      });
                      refresh();
                    } catch {}
                  }}
                  title="Restore this workbench to the main list"
                  style={{background:'transparent',
                          border:`1px solid ${T.border}`, color:T.accentHi,
                          padding:"6px 10px", borderRadius:5, fontSize:11,
                          cursor:"pointer"}}>
                    ↩ Unarchive
                  </button>
                )}
              </div>
            </div>
          );})}
        </div>

        {!loading && workbenches.length === 0 && (
          <div className="card" style={{padding:32, marginTop:20, textAlign:"center"}}>
            <div style={{fontSize:32, marginBottom:10, opacity:0.5}}>🎯</div>
            <div style={{fontSize:14, color:T.textSecondary, marginBottom:6}}>
              Start your first workbench
            </div>
            <div style={{fontSize:12, color:T.textTertiary, lineHeight:1.6, maxWidth:380, margin:"0 auto 14px"}}>
              Enter a target domain. Recon will run automatically (subdomain enum, JS analysis,
              fuzzing, dangling CNAME checks, GraphQL/.git/.env probes). Open the workbench to browse
              the results by subdomain or run a full tool sweep.
            </div>
            <Btn variant="primary" onClick={() => setShowCreate(true)}>+ New workbench</Btn>
          </div>
        )}
      </div>

      {/* Multi-target sweep modal */}
      {showMultiSweep && (
        <div onClick={() => !multiSweepLaunching && setShowMultiSweep(false)} style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.7)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: T.bg1, border: `1px solid ${T.border}`,
            borderRadius: 8, padding: 22,
            maxWidth: 540, width: '100%', maxHeight: '85vh', overflowY: 'auto',
          }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: T.textPrimary, marginBottom: 4 }}>
              🚀 Sweep {selectedWbIds.size} target{selectedWbIds.size === 1 ? '' : 's'}
            </div>
            <div style={{ fontSize: 11, color: T.textTertiary, marginBottom: 14 }}>
              Each gets a Full Tool Sweep with the settings below. The first {queueState?.maxConcurrent || 3} run in parallel; the rest queue and start as slots free up.
            </div>

            {/* Selected targets list */}
            <div style={{ marginBottom: 14, padding: 8, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 4, maxHeight: 100, overflowY: 'auto' }}>
              {Array.from(selectedWbIds).map(wbId => {
                const wb = workbenches.find(w => w.wbId === wbId);
                return (
                  <div key={wbId} style={{ fontSize: 10, fontFamily: T.fontMono, color: T.textSecondary, padding: '2px 0' }}>
                    {wb?.target || wbId}
                  </div>
                );
              })}
            </div>

            {/* Aggression */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, marginBottom: 6 }}>
                Aggression level
              </div>
              {[
                { id: 'polite',   label: 'Polite',   detail: 'Lighter wordlists, critical/high only' },
                { id: 'standard', label: 'Standard', detail: 'Default templates' },
                { id: 'heavy',    label: 'Heavy',    detail: 'Full templates, large wordlist' },
              ].map(opt => (
                <label key={opt.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', marginBottom: 4,
                  background: multiSweepLevel === opt.id ? T.accent + '22' : T.bg0,
                  border: `1px solid ${multiSweepLevel === opt.id ? T.accent : T.border}`,
                  borderRadius: 5, cursor: 'pointer',
                }}>
                  <input type="radio" checked={multiSweepLevel === opt.id}
                    onChange={() => setMultiSweepLevel(opt.id)} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: T.textPrimary }}>{opt.label}</div>
                    <div style={{ fontSize: 9, color: T.textTertiary }}>{opt.detail}</div>
                  </div>
                </label>
              ))}
            </div>

            {/* Stealth */}
            <div style={{ marginBottom: 14 }}>
              <label style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                background: multiSweepStealth ? T.accent + '22' : T.bg0,
                border: `1px solid ${multiSweepStealth ? T.accent : T.border}`,
                borderRadius: 5, cursor: 'pointer',
              }}>
                <input type="checkbox" checked={multiSweepStealth}
                  onChange={e => setMultiSweepStealth(e.target.checked)}
                  style={{ marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: T.textPrimary, marginBottom: 2 }}>
                    🥷 Stealth mode
                  </div>
                  <div style={{ fontSize: 9, color: T.textTertiary, lineHeight: 1.4 }}>
                    Real browser User-Agents, lower default rates. Reduces basic detection. Won't beat Cloudflare Bot Management.
                  </div>
                </div>
              </label>
            </div>

            {/* Speed */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.textSecondary, marginBottom: 6 }}>
                Speed preset
              </div>
              {[
                { id: 'standard', label: 'Standard', detail: 'Default rates' },
                { id: 'slow',     label: 'Slow',     detail: 'Rate ÷ 5 — less likely to trip rate limits' },
                { id: 'glacial',  label: 'Glacial',  detail: 'Rate ÷ ~17 — stays under most rolling-window thresholds' },
              ].map(opt => (
                <label key={opt.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', marginBottom: 4,
                  background: multiSweepSpeed === opt.id ? T.accent + '22' : T.bg0,
                  border: `1px solid ${multiSweepSpeed === opt.id ? T.accent : T.border}`,
                  borderRadius: 5, cursor: 'pointer',
                }}>
                  <input type="radio" checked={multiSweepSpeed === opt.id}
                    onChange={() => setMultiSweepSpeed(opt.id)} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, fontWeight: 600, color: T.textPrimary }}>{opt.label}</div>
                    <div style={{ fontSize: 9, color: T.textTertiary }}>{opt.detail}</div>
                  </div>
                </label>
              ))}
            </div>

            {/* Result */}
            {multiSweepResult && (
              <div style={{
                padding: 10, marginBottom: 12, fontSize: 10, lineHeight: 1.5,
                background: multiSweepResult.error ? T.red + '22' : T.bg0,
                border: `1px solid ${multiSweepResult.error ? T.red : T.border}`,
                borderRadius: 4,
              }}>
                {multiSweepResult.error ? (
                  <div style={{ color: T.red }}>Error: {multiSweepResult.error}</div>
                ) : (
                  <>
                    <div style={{ color: T.green, fontWeight: 600, marginBottom: 6 }}>
                      ✓ {multiSweepResult.results.filter(r => r.status === 'started').length} started, {multiSweepResult.results.filter(r => r.status === 'queued').length} queued
                    </div>
                    {multiSweepResult.results.map(r => {
                      const wb = workbenches.find(w => w.wbId === r.wbId);
                      return (
                        <div key={r.wbId} style={{ fontSize: 9, color: r.ok ? T.textSecondary : T.red }}>
                          {wb?.target || r.wbId}: {r.status || r.error}
                          {r.position ? ` (#${r.position})` : ''}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowMultiSweep(false); setMultiSweepResult(null); }}
                disabled={multiSweepLaunching}
                style={{
                  background: T.bg2, border: `1px solid ${T.border}`,
                  color: T.textSecondary, padding: '8px 16px',
                  borderRadius: 4, fontSize: 11,
                  cursor: multiSweepLaunching ? 'not-allowed' : 'pointer',
                }}>{multiSweepResult ? 'Close' : 'Cancel'}</button>
              {!multiSweepResult && (
                <button onClick={launchMultiSweep}
                  disabled={multiSweepLaunching}
                  style={{
                    background: multiSweepLaunching ? T.bg2 : T.accent,
                    border: 'none', color: '#fff',
                    padding: '8px 16px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                    cursor: multiSweepLaunching ? 'wait' : 'pointer',
                  }}>{multiSweepLaunching ? 'Launching...' : `🚀 Launch ${selectedWbIds.size} sweep${selectedWbIds.size === 1 ? '' : 's'}`}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div style={{position:"fixed", inset:0, background:"rgba(0,0,0,0.75)",
                     display:"flex", alignItems:"center", justifyContent:"center",
                     zIndex:1000, padding:16, animation:"fadeIn 0.15s ease"}}
          onClick={() => !creating && setShowCreate(false)}>
          <div className="card" onClick={e => e.stopPropagation()}
            style={{width:"min(440px, 100%)", padding:24, animation:"fadeUp 0.2s ease"}}>
            <div style={{display:"flex", justifyContent:"space-between", marginBottom:14}}>
              <div style={{fontSize:15, fontWeight:600, color:T.textPrimary}}>New workbench</div>
              <button onClick={() => !creating && setShowCreate(false)} disabled={creating}
                style={{background:"transparent", border:"none", color:T.textTertiary,
                        fontSize:20, padding:2, cursor:"pointer"}}>✕</button>
            </div>
            <div style={{fontSize:12, color:T.textTertiary, marginBottom:8}}>
              Target domain (just the apex — Tentacles handles subdomains)
            </div>
            <input value={createTarget} autoFocus
              onChange={e => setCreateTarget(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && createTarget.trim() && pickerMode === 'quick') create(); }}
              placeholder="example.com"
              disabled={creating}
              style={{width:"100%", background:T.bg2, color:T.textPrimary,
                      border:`1px solid ${T.border}`, borderRadius:6,
                      padding:"10px 12px", fontSize:14, marginBottom:14,
                      fontFamily:T.fontMono}}/>

            {/* Mode selector — just two options now */}
            <div style={{fontSize:11, color:T.textTertiary, marginBottom:6, textTransform:"uppercase", letterSpacing:0.5, fontWeight:600}}>
              Mode
            </div>
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:12}}>
              {[
                { id: 'baseline', label: '◆ Run baseline now', sub: '6-phase recon (subs → params)' },
                { id: 'empty',    label: '○ Create empty',     sub: 'add tools manually' },
              ].map(m => {
                const active = pickerMode === m.id;
                return (
                  <button key={m.id} onClick={() => setPickerMode(m.id)} disabled={creating}
                    style={{
                      background: active ? T.accentDim : T.bg2,
                      border: `1px solid ${active ? T.accent : T.border}`,
                      color: active ? T.accentHi : T.textSecondary,
                      borderRadius: 6, padding: "10px 12px",
                      cursor: creating ? "not-allowed" : "pointer",
                      textAlign: "left", fontSize: 11,
                    }}>
                    <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 2 }}>{m.label}</div>
                    <div style={{ fontSize: 10, opacity: 0.7 }}>{m.sub}</div>
                  </button>
                );
              })}
            </div>

            {pickerMode === 'empty' ? (
              <div style={{
                padding: "10px 12px", background: T.bg2, borderRadius: 6,
                fontSize: 11, color: T.textTertiary, lineHeight: 1.6, marginBottom: 14,
              }}>
                Workbench will be created without baseline recon. You can run baseline later
                or launch tools (FFUF, Arjun, Nuclei, etc.) directly once you have data.
              </div>
            ) : (
              <>
                <div style={{padding:"10px 12px", background:T.bg2, borderRadius:6,
                             fontSize:11, color:T.textTertiary, lineHeight:1.6, marginBottom:10}}>
                  Baseline runs subdomain enum → DNS → port scan → HTTP probe → URL collection →
                  params (5-15 min). Confirm you have authorization to test this domain.
                </div>
                <label style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '10px 12px', marginBottom: 14, cursor: 'pointer',
                  background: autoSweepOnCreate ? T.accent + '22' : T.bg2,
                  border: `1px solid ${autoSweepOnCreate ? T.accent : T.border}`,
                  borderRadius: 6,
                }}>
                  <input type="checkbox" checked={autoSweepOnCreate}
                    onChange={e => setAutoSweepOnCreate(e.target.checked)}
                    disabled={creating}
                    style={{ marginTop: 2 }} />
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: T.textPrimary }}>
                      🚀 Auto-run full sweep when recon finishes
                    </div>
                    <div style={{ fontSize: 10, color: T.textTertiary, marginTop: 3, lineHeight: 1.5 }}>
                      Queues a heavy + stealth + standard-speed sweep automatically.
                      Takes hours. Uncheck if you want to review recon first.
                    </div>
                  </div>
                </label>
              </>
            )}

            <div style={{display:"flex", gap:8}}>
              <Btn variant="ghost" onClick={() => setShowCreate(false)} disabled={creating}>Cancel</Btn>
              <Btn variant="primary" onClick={create} disabled={creating || !createTarget.trim()} style={{flex:1}}>
                {creating ? "Creating..."
                  : pickerMode === 'empty' ? "Create empty workbench"
                  : "Create + run baseline"}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {showCreds && (
        <DefaultCredsModal apiKey={apiKey} onClose={() => setShowCreds(false)}/>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [authed, setAuthed] = useState(loadAuthSession());
  const [apiKey, setApiKey] = useState(loadApiKey());
  const [workbenchId, setWorkbenchId] = useState(null);

  const logout = () => {
    clearAuthSession();
    setAuthed(false);
    setWorkbenchId(null);
  };

  if (!authed) {
    return (
      <>
        <style>{CSS}</style>
        <LockScreen onUnlock={() => { setAuthed(true); setApiKey(loadApiKey()); }}/>
      </>
    );
  }

  if (workbenchId) {
    return (
      <>
        <style>{CSS}</style>
        <Workbench
          wbId={workbenchId}
          apiKey={apiKey}
          onClose={() => setWorkbenchId(null)}
          onSwitch={(newId) => setWorkbenchId(newId)}
        />
      </>
    );
  }

  return (
    <>
      <style>{CSS}</style>
      <WorkbenchHome
        apiKey={apiKey}
        onOpen={(id) => setWorkbenchId(id)}
        onLogout={logout}
      />
    </>
  );
}
