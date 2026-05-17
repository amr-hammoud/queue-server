const BC = new BroadcastChannel('nasa_queue');
let S = { stations:[], queues:{}, serving:{}, onBreak:{}, settings:{ queueSize:3, showQueue:true } };
let prevServing = {};
let prevQueues  = {};

BC.onmessage = (e) => {
  prevServing = { ...S.serving };
  prevQueues  = JSON.parse(JSON.stringify(S.queues || {}));
  const prevRecallTs = (S.recall || {}).ts || null;
  S = e.data;
  localStorage.setItem('nasa_q_v2', JSON.stringify(S));

  if (S.recall && S.recall.ts !== prevRecallTs) {
    const recallSt = (S.stations || []).find(s => s.id === S.recall.stationId);
    if (recallSt) {
      requestAnimationFrame(() => {
        playChime();
        showCallingOverlay(recallSt.name, recallSt.nameAr || '', S.recall.cid);
      });
    }
  }

  render();
};

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* ── WAIT TIME ───────────────────────────── */
function avgServiceMs(stationId) {
  const times = (S.serveTimes || {})[stationId] || [];
  const valid = times.filter(t => t >= 30_000 && t <= 30 * 60_000);
  if (valid.length < 3) return 5 * 60_000;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function estimatedWaitMins(stationId, queueLength) {
  if (!queueLength) return 0;
  const avgMs = avgServiceMs(stationId);
  const serveStart = (S.serveStart || {})[stationId];
  const remainingCurrent = serveStart ? Math.max(0, avgMs - (Date.now() - serveStart)) : 0;
  const totalMs = remainingCurrent + avgMs * (queueLength - 1);
  if (totalMs < 60_000) return 0;
  return Math.round(totalMs / 60_000);
}

/* ── TICKER ──────────────────────────────── */
const TICKER_MESSAGES = [
  'Welcome to NASA International Schools Annual Recruitment Fair · أهلاً بكم في معرض التوظيف السنوي لمدارس ناسا العالمية',
  'NASA International Schools — Inspiring Excellence · Shaping Tomorrow\'s Leaders · Home of Visionaries',
  'Thank you for joining us today · We are delighted to meet you · نشكركم على حضوركم ونسعد بلقائكم'
];
let tickerIndex = 0;

function startTicker() {
  const el = document.getElementById('ticker-text');
  if (!el) return;
  el.textContent = TICKER_MESSAGES[tickerIndex];
  el.classList.remove('ticker-slide');
  void el.offsetWidth;
  el.classList.add('ticker-slide');
}

function advanceTicker() {
  tickerIndex = (tickerIndex + 1) % TICKER_MESSAGES.length;
  startTicker();
}

document.addEventListener('DOMContentLoaded', () => {
  startTicker();
  setInterval(advanceTicker, 11000);
});

/* ── AUDIO ───────────────────────────────── */
let audioCtx = null;

function enableSound() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume().then(() => {
    const btn = document.getElementById('sound-btn');
    if (btn) { btn.textContent = '🔊 Sound on'; btn.classList.add('active'); }
  });
}

function playChime() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  try {
    const play = (freq, start, dur, vol = 0.25) => {
      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(vol, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    };
    const t = audioCtx.currentTime;
    play(392, t,        1.2);   // G4 — same ascending major triad, one 4th deeper
    play(494, t + 0.45, 1.2);   // B4
    play(588, t + 0.90, 1.2);   // D5
    play(784, t + 1.35, 2.2);   // G5 — long ring-out
  } catch(e) {}
}

/* ── NOW CALLING OVERLAY ─────────────────── */
let overlayTimer = null;

function showCallingOverlay(stationName, stationNameAr, number) {
  const overlay = document.getElementById('calling-overlay');
  if (!overlay) return;

  const enEl   = overlay.querySelector('.co-station');
  const arEl   = overlay.querySelector('.co-station-ar');
  const sepEl  = overlay.querySelector('.co-name-sep');
  const nameRow = overlay.querySelector('.co-name-row');

  enEl.textContent = stationName;
  const hasAr = !!(stationNameAr && stationNameAr !== stationName);
  arEl.textContent        = hasAr ? stationNameAr : '';
  arEl.style.display      = hasAr ? '' : 'none';
  sepEl.style.display     = hasAr ? '' : 'none';

  overlay.querySelector('.co-number').textContent = number;

  // Auto-shrink: start at 4.5 vw, step down until the name row fits within 90 vw
  const maxPx    = Math.min(68, window.innerWidth * 0.045);
  const limitPx  = window.innerWidth * 0.90;
  let   size     = maxPx;
  enEl.style.fontSize = arEl.style.fontSize = size + 'px';
  while (nameRow.scrollWidth > limitPx && size > 14) {
    size -= 1;
    enEl.style.fontSize = arEl.style.fontSize = size + 'px';
  }

  overlay.classList.remove('visible');
  void overlay.offsetWidth;
  overlay.classList.add('visible');
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => overlay.classList.remove('visible'), 4500);
}

/* ── RENDER ──────────────────────────────── */
function render() {
  const row = document.getElementById('stations-row');
  const { stations=[], queues={}, serving={}, onBreak={}, settings={} } = S;
  const qSize = settings.queueSize ?? 3;
  const showQ = settings.showQueue ?? true;

  if (!stations.length) {
    row.innerHTML = '<div class="waiting-msg">Waiting for session to begin…</div>';
    return;
  }

  // Filter out hidden stations — they exist in control panel but not on display
  const visibleStations = stations.filter(st => !(S.hidden || {})[st.id]);

  if (!visibleStations.length) {
    row.innerHTML = '<div class="waiting-msg">Waiting for session to begin…</div>';
    return;
  }

  row.style.setProperty('--sc', visibleStations.length);

  // Collect which stations have a newly served candidate before re-rendering
  const newlyCalled = [];
  visibleStations.forEach(st => {
    const srv     = serving[st.id] || null;
    const changed = srv !== (prevServing[st.id] || null);
    if (changed && srv) newlyCalled.push({ name: st.name, nameAr: st.nameAr || '', number: srv });
  });

  row.innerHTML = visibleStations.map(st => {
    const srv      = serving[st.id]  || null;
    const q        = queues[st.id]   || [];
    const changed  = srv !== (prevServing[st.id] || null);
    const isActive = !!srv;
    const isBreak  = !!(onBreak[st.id]);

    const nameArHtml = st.nameAr
      ? `<div class="st-name-ar">${esc(st.nameAr)}</div>` : '';

    if (isBreak) {
      return `
        <div class="st-card break-card">
          <div class="st-header">
            <div class="st-name-en">${esc(st.name)}</div>
            ${nameArHtml}
          </div>
          <div class="st-body">
            <div class="on-break-icon">☕</div>
            <div class="on-break-text">On Break</div>
          </div>
        </div>`;
    }

    const numHtml = srv
      ? `<div class="now-num"${changed ? ' data-flash' : ''}>${esc(srv)}</div>`
      : `<div class="now-num empty">---</div>`;

    let queueHtml = '';
    if (showQ) {
      const visible  = q.slice(0, qSize);
      const waitMins = estimatedWaitMins(st.id, q.length);
      const waitHtml = waitMins ? `<div class="est-wait-display">~${waitMins} min wait</div>` : '';
      const prevQ    = prevQueues[st.id] || [];
      const newItems = new Set(q.filter(x => !prevQ.includes(x)));
      queueHtml = visible.length
        ? `<div class="q-list">${visible.map((cid, i) =>
            `<div class="q-item${newItems.has(cid) ? ' q-item-new' : ''}">
               <span class="qi-ord">${i + 1}</span>
               <span class="qi-num">${esc(cid)}</span>
             </div>`).join('')}</div>${waitHtml}`
        : `<div class="st-empty">No one waiting</div>`;
    }

    const centered = !showQ || qSize === 0;

    return `
      <div class="st-card${isActive ? ' active' : ''}${centered ? ' center-num' : ''}">
        <div class="st-header">
          <div class="st-name-en">${esc(st.name)}</div>
          ${nameArHtml}
        </div>
        <div class="st-body">
          <div class="now-label">Now Serving · يُخدم الآن</div>
          ${numHtml}
          <div class="st-divider"></div>
          ${queueHtml}
        </div>
      </div>`;
  }).join('');

  requestAnimationFrame(() => {
    document.querySelectorAll('[data-flash]').forEach(el => {
      el.removeAttribute('data-flash');
      el.classList.remove('flip-enter');
      void el.offsetWidth;
      el.classList.add('flip-enter');
      setTimeout(() => el.classList.remove('flip-enter'), 700);
    });

    if (newlyCalled.length) {
      playChime();
      showCallingOverlay(newlyCalled[0].name, newlyCalled[0].nameAr, newlyCalled[0].number);
    }
  });
}

try {
  const d = localStorage.getItem('nasa_q_v2');
  if (d) {
    S = JSON.parse(d);
    S.onBreak = S.onBreak || {};
    render();
  }
} catch(e) {}
