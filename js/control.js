const BC = new BroadcastChannel('nasa_queue');

let S = {
  stations:   [],
  queues:     {},
  serving:    {},
  onBreak:    {},
  hidden:     {},
  unassigned: [],
  ghosted:    [],
  done:       [],
  log:        [],
  settings:   { queueSize: 3, showQueue: true }
};

// null | { type:'card', cid, fromStation, fromZone } | { type:'column', stationId }
let drag = null;
let undoStack = [];

/* ── PERSISTENCE ─────────────────────────── */
function save() { localStorage.setItem('nasa_q_v2', JSON.stringify(S)); }
function load() {
  try {
    const d = localStorage.getItem('nasa_q_v2');
    if (d) {
      S = JSON.parse(d);
      S.onBreak = S.onBreak || {};
      S.hidden  = S.hidden  || {};
      S.ghosted = S.ghosted || [];
      S.log     = S.log     || [];
    }
  } catch(e) {}
}

/* ── BROADCAST ───────────────────────────── */
function sync() { save(); BC.postMessage(S); render(); }

/* ── UNDO ────────────────────────────────── */
function saveUndo() {
  undoStack.push(JSON.parse(JSON.stringify(S)));
  if (undoStack.length > 20) undoStack.shift();
  refreshUndoBtn();
}

function undo() {
  if (!undoStack.length) return;
  S = undoStack.pop();
  refreshUndoBtn();
  sync();
}

function refreshUndoBtn() {
  const btn = document.getElementById('undo-btn');
  if (btn) btn.disabled = undoStack.length === 0;
}

/* ── UTILS ───────────────────────────────── */
function uid() { return 'st' + Date.now().toString(36) + Math.random().toString(36).slice(2,5); }

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function jstr(s) { return esc(JSON.stringify(s)); }

function pluck(cid) {
  S.unassigned = S.unassigned.filter(x => x !== cid);
  S.done       = S.done.filter(x => x !== cid);
  S.ghosted    = (S.ghosted || []).filter(x => x !== cid);
  S.stations.forEach(st => {
    S.queues[st.id] = (S.queues[st.id] || []).filter(x => x !== cid);
    if (S.serving[st.id] === cid) S.serving[st.id] = null;
  });
}

function allCids() {
  return [
    ...S.unassigned, ...(S.ghosted || []), ...S.done,
    ...S.stations.flatMap(st => [
      ...(S.queues[st.id] || []),
      ...(S.serving[st.id] ? [S.serving[st.id]] : [])
    ])
  ];
}

function logEntry(stationId, cid, type) {
  S.log = S.log || [];
  S.log.push({
    time:        new Date().toISOString(),
    stationId,
    stationName: S.stations.find(s => s.id === stationId)?.name || stationId,
    cid,
    type
  });
}

/* ── CANDIDATE ACTIONS ───────────────────── */
function addCandidate() {
  const inp = document.getElementById('new-cid');
  const val = inp.value.trim();
  if (!val) return;

  const m = val.match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) {
    let from = parseInt(m[1], 10), to = parseInt(m[2], 10);
    if (from > to) { const tmp = from; from = to; to = tmp; }
    if (to - from > 500) { alert('Range too large — max 500 at once.'); return; }
    const existing = new Set(allCids());
    let added = 0;
    for (let i = from; i <= to; i++) {
      const cid = String(i);
      if (!existing.has(cid)) { S.unassigned.push(cid); added++; }
    }
    inp.value = '';
    if (added) sync();
    return;
  }

  if (allCids().includes(val)) {
    inp.style.outline = '2px solid #e24b4a';
    setTimeout(() => inp.style.outline = '', 900);
    inp.focus(); return;
  }
  S.unassigned.push(val);
  inp.value = ''; inp.focus();
  sync();
}

function removeCandidate(cid) { saveUndo(); pluck(cid); sync(); }

function reQueueGhost(cid) {
  S.ghosted = (S.ghosted || []).filter(x => x !== cid);
  S.unassigned.push(cid);
  sync();
}

/* ── STATION ACTIONS ─────────────────────── */
function promptStation() {
  const name = prompt('Station name (English):');
  if (!name || !name.trim()) return;
  const nameAr = prompt('Station name (Arabic) — optional, press Cancel to skip:', '') || '';
  const id = uid();
  S.stations.push({ id, name: name.trim(), nameAr: nameAr.trim() });
  S.queues[id] = []; S.serving[id] = null;
  sync();
}

function renameStation(id, val) {
  const st = S.stations.find(s => s.id === id);
  if (st && val.trim()) { st.name = val.trim(); sync(); }
}

function renameStationAr(id, val) {
  const st = S.stations.find(s => s.id === id);
  if (st) { st.nameAr = val.trim(); sync(); }
}

function deleteStation(id) {
  const st = S.stations.find(s => s.id === id);
  if (!st) return;
  if (!confirm('Delete station "' + st.name + '"?\nCandidates will be moved back to Unassigned.')) return;
  saveUndo();
  const q   = S.queues[id] || [];
  const srv = S.serving[id];
  if (srv) S.unassigned.unshift(srv);
  S.unassigned.unshift(...q);
  delete S.queues[id]; delete S.serving[id];
  if (S.onBreak) delete S.onBreak[id];
  if (S.hidden)  delete S.hidden[id];
  S.stations = S.stations.filter(s => s.id !== id);
  sync();
}

function toggleBreak(stationId) {
  S.onBreak = S.onBreak || {};
  S.onBreak[stationId] = !S.onBreak[stationId];
  sync();
}

function toggleHidden(stationId) {
  S.hidden = S.hidden || {};
  S.hidden[stationId] = !S.hidden[stationId];
  sync();
}

/* ── QUEUE ACTIONS ───────────────────────── */
function callNext(stationId) {
  const q = S.queues[stationId] || [];
  if (!q.length) return;
  saveUndo();
  if (S.serving[stationId]) {
    logEntry(stationId, S.serving[stationId], 'served');
    S.done.push(S.serving[stationId]);
  }
  S.serving[stationId] = q.shift();
  sync();
}

function dismiss(stationId) {
  const cid = S.serving[stationId];
  if (!cid) return;
  saveUndo();
  logEntry(stationId, cid, 'served');
  S.done.push(cid);
  S.serving[stationId] = null;
  sync();
}

function recallServing(stationId) {
  const cid = S.serving[stationId];
  if (!cid) return;
  S.recall = { stationId, cid, ts: Date.now() };
  sync();
}

function ghostCandidate(stationId) {
  const cid = S.serving[stationId];
  if (!cid) return;
  saveUndo();
  logEntry(stationId, cid, 'ghosted');
  S.serving[stationId] = null;
  S.ghosted = S.ghosted || [];
  S.ghosted.push(cid);
  sync();
}

/* ── BULK ACTIONS ────────────────────────── */
function autoDistribute() {
  const active = S.stations.filter(st => !(S.onBreak || {})[st.id]);
  if (!active.length) { alert('No active stations to distribute to.'); return; }
  if (!S.unassigned.length) return;
  saveUndo();
  const candidates = [...S.unassigned];
  S.unassigned = [];
  candidates.forEach((cid, i) => {
    const st = active[i % active.length];
    (S.queues[st.id] = S.queues[st.id] || []).push(cid);
  });
  sync();
}

function exportLog() {
  const log = S.log || [];
  if (!log.length) { alert('No log entries yet.'); return; }
  const rows = [['Time', 'Station', 'Candidate ID', 'Status']];
  log.forEach(e => rows.push([
    new Date(e.time).toLocaleString(),
    e.stationName || e.stationId,
    e.cid,
    e.type
  ]));
  const csv = rows.map(r =>
    r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')
  ).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'job-fair-log-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
}

/* ── RESET MODAL ─────────────────────────── */
function openResetModal()  { document.getElementById('reset-modal').classList.add('open'); }
function closeResetModal() { document.getElementById('reset-modal').classList.remove('open'); }

function doReset(type) {
  const messages = {
    queues:     'Move all candidates from station queues back to Unassigned?',
    unassigned: 'Remove all candidates from the Unassigned pool?',
    ghosted:    'Discard all ghosted (no-show) candidates?',
    log:        'Clear the activity log? Export first if you need the data.',
    session:    'Start a new session?\n\nAll candidates, queues, and log will be cleared. Stations are kept.',
    full:       'FULL RESET\n\nThis will delete all stations, candidates, and data. Are you sure?'
  };
  if (!confirm(messages[type])) return;
  saveUndo();

  switch (type) {
    case 'queues':
      S.stations.forEach(st => {
        S.unassigned.push(...(S.queues[st.id] || []));
        S.queues[st.id] = [];
      });
      break;
    case 'unassigned':
      S.unassigned = [];
      break;
    case 'ghosted':
      S.ghosted = [];
      break;
    case 'log':
      S.log = []; S.done = [];
      break;
    case 'session':
      S.unassigned = []; S.ghosted = []; S.done = []; S.log = [];
      S.stations.forEach(st => { S.queues[st.id] = []; S.serving[st.id] = null; });
      S.onBreak = {}; S.hidden = {};
      break;
    case 'full':
      S = {
        stations: [], queues: {}, serving: {}, onBreak: {}, hidden: {},
        unassigned: [], ghosted: [], done: [], log: [],
        settings: S.settings
      };
      break;
  }

  closeResetModal();
  sync();
}

/* ── SETTINGS ────────────────────────────── */
function setQueueSize(n) {
  S.settings.queueSize = Math.max(0, Math.min(10, n || 0));
  sync();
}

function toggleShowQueue() {
  S.settings.showQueue = !S.settings.showQueue;
  sync();
}

/* ── KEYBOARD SHORTCUTS ──────────────────── */
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault(); undo(); return;
  }
  if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
    e.preventDefault();
    const idx = parseInt(e.code.replace('Digit', ''), 10) - 1;
    const st  = S.stations[idx];
    if (st && !(S.onBreak || {})[st.id]) callNext(st.id);
  }
  if (e.key === 'Escape') closeResetModal();
});

/* ── DRAG & DROP ─────────────────────────── */
function onDragStart(e, cid, fromStation, fromZone) {
  drag = { type: 'card', cid, fromStation, fromZone };
  e.dataTransfer.setData('text/plain', cid);
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => {
    document.querySelectorAll('[data-cid]').forEach(el => {
      if (el.dataset.cid === cid) el.classList.add('dragging');
    });
  }, 0);
}

function onColDragStart(e, stationId) {
  drag = { type: 'column', stationId };
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => {
    document.getElementById('col-' + stationId)?.classList.add('col-dragging');
  }, 0);
}

function onDragEnd() {
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.col-dragging').forEach(el => el.classList.remove('col-dragging'));
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  document.querySelectorAll('.col-drop-left').forEach(el => el.classList.remove('col-drop-left'));
  document.querySelectorAll('.col-drop-right').forEach(el => el.classList.remove('col-drop-right'));
  document.querySelectorAll('.drop-before,.drop-after').forEach(el => {
    el.classList.remove('drop-before', 'drop-after');
  });
  document.querySelectorAll('.drop-active').forEach(el => el.classList.remove('drop-active'));
  drag = null;
}

function onColOver(e, sid) {
  if (drag && drag.type === 'column') {
    if (drag.stationId === sid || sid === 'unassigned') return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const col = document.getElementById('col-' + sid);
    if (!col) return;
    document.querySelectorAll('.col-drop-left,.col-drop-right').forEach(el => {
      el.classList.remove('col-drop-left', 'col-drop-right');
    });
    const r = col.getBoundingClientRect();
    col.classList.add(e.clientX < r.left + r.width / 2 ? 'col-drop-left' : 'col-drop-right');
    return;
  }
  e.preventDefault(); e.dataTransfer.dropEffect = 'move';
  document.getElementById('col-' + sid)?.classList.add('drag-over');
}

function onColLeave(e, sid) {
  const col = document.getElementById('col-' + sid);
  if (!col || col.contains(e.relatedTarget)) return;
  col.classList.remove('drag-over', 'col-drop-left', 'col-drop-right');
}

function onColDrop(e, sid) {
  e.preventDefault();
  const col = document.getElementById('col-' + sid);
  if (col) col.classList.remove('drag-over', 'col-drop-left', 'col-drop-right');
  if (!drag) return;

  if (drag.type === 'column') {
    if (sid === 'unassigned') { drag = null; return; }
    const fromId  = drag.stationId;
    if (fromId === sid) { drag = null; return; }
    const r       = col ? col.getBoundingClientRect() : null;
    const before  = r ? e.clientX < r.left + r.width / 2 : false;
    const fromIdx = S.stations.findIndex(s => s.id === fromId);
    const toIdx   = S.stations.findIndex(s => s.id === sid);
    if (fromIdx < 0 || toIdx < 0) { drag = null; return; }
    const [station] = S.stations.splice(fromIdx, 1);
    const newToIdx  = S.stations.findIndex(s => s.id === sid);
    S.stations.splice(before ? newToIdx : newToIdx + 1, 0, station);
    drag = null; sync(); return;
  }

  saveUndo();
  const { cid } = drag;
  pluck(cid);
  if (sid === 'unassigned') S.unassigned.push(cid);
  else (S.queues[sid] = S.queues[sid] || []).push(cid);
  drag = null; sync();
}

function onCardOver(e, sid, cardCid) {
  if (drag && drag.type === 'column') return;
  e.preventDefault(); e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  document.querySelectorAll('.drop-before,.drop-after').forEach(el => {
    el.classList.remove('drop-before', 'drop-after');
  });
  e.currentTarget.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
}

function onCardDrop(e, sid, cardCid) {
  if (drag && drag.type === 'column') return;
  e.preventDefault(); e.stopPropagation();
  document.querySelectorAll('.drop-before,.drop-after').forEach(el => {
    el.classList.remove('drop-before', 'drop-after');
  });
  if (!drag || drag.cid === cardCid) { drag = null; return; }
  saveUndo();
  const { cid } = drag;
  const r      = e.currentTarget.getBoundingClientRect();
  const before = e.clientY < r.top + r.height / 2;
  pluck(cid);
  const q   = S.queues[sid] = S.queues[sid] || [];
  const idx = q.indexOf(cardCid);
  q.splice(before ? Math.max(0, idx) : idx + 1, 0, cid);
  drag = null; sync();
}

function onServingOver(e, sid) {
  if (drag && drag.type === 'column') return;
  e.preventDefault(); e.stopPropagation();
  e.currentTarget.classList.add('drop-active');
}

function onServingDrop(e, sid) {
  e.preventDefault(); e.stopPropagation();
  e.currentTarget.classList.remove('drop-active');
  if (!drag || drag.type !== 'card') return;
  saveUndo();
  const { cid } = drag;
  if (S.serving[sid]) {
    logEntry(sid, S.serving[sid], 'served');
    S.done.push(S.serving[sid]);
  }
  pluck(cid);
  S.serving[sid] = cid;
  drag = null; sync();
}

/* ── RENDER ──────────────────────────────── */
function renderUnassigned() {
  const pool    = document.getElementById('pool-unassigned');
  const ghosted = S.ghosted || [];
  document.getElementById('u-badge').textContent = S.unassigned.length;

  let html = S.unassigned.length
    ? S.unassigned.map(cid => `
        <div class="c-card" data-cid="${esc(cid)}"
          draggable="true"
          ondragstart="onDragStart(event,${jstr(cid)},'unassigned','pool')"
          ondragend="onDragEnd()">
          <span class="c-num">${esc(cid)}</span>
          <button class="remove-btn" onclick="removeCandidate(${jstr(cid)})" title="Remove">✕</button>
        </div>`).join('')
    : '<div class="empty-msg">No unassigned candidates</div>';

  if (ghosted.length) {
    html += `<div class="ghost-section-label">👻 Ghosted &middot; ${ghosted.length}</div>`;
    html += ghosted.map(cid => `
        <div class="c-card ghost-card" data-cid="${esc(cid)}"
          draggable="true"
          ondragstart="onDragStart(event,${jstr(cid)},'ghosted','pool')"
          ondragend="onDragEnd()">
          <span class="ghost-badge">👻</span>
          <span class="c-num">${esc(cid)}</span>
          <button class="remove-btn requeue-btn" onclick="reQueueGhost(${jstr(cid)})" title="Move back to unassigned">↩</button>
        </div>`).join('');
  }

  pool.innerHTML = html;
}

function renderStations() {
  const area     = document.getElementById('stations-area');
  const onBreak  = S.onBreak || {};
  const hidden   = S.hidden  || {};

  area.innerHTML = S.stations.map((st, idx) => {
    const q        = S.queues[st.id]  || [];
    const srv      = S.serving[st.id] || null;
    const isBreak  = !!onBreak[st.id];
    const isHidden = !!hidden[st.id];
    const kbdHint  = idx < 9
      ? `<span class="kbd-hint" title="Keyboard shortcut">Alt+${idx + 1}</span>`
      : '';

    return `
    <div class="station-col${isBreak ? ' col-on-break' : ''}${isHidden ? ' col-hidden' : ''}" id="col-${st.id}"
      ondragover="onColOver(event,'${st.id}')"
      ondragleave="onColLeave(event,'${st.id}')"
      ondrop="onColDrop(event,'${st.id}')">

      <div class="station-header">
        <span class="col-drag-handle" draggable="true"
          ondragstart="onColDragStart(event,'${st.id}')"
          ondragend="onDragEnd()"
          title="Drag to reorder column">⠿</span>
        <div class="name-stack">
          <input class="station-name-input" value="${esc(st.name)}" placeholder="English name"
            onblur="renameStation('${st.id}',this.value)"
            onkeydown="if(event.key==='Enter')this.blur()" />
          <input class="station-name-ar" value="${esc(st.nameAr || '')}" placeholder="الاسم بالعربي (اختياري)"
            onblur="renameStationAr('${st.id}',this.value)"
            onkeydown="if(event.key==='Enter')this.blur()" />
        </div>
        <button class="icon-btn hide-toggle${isHidden ? ' is-hidden' : ''}"
          onclick="toggleHidden('${st.id}')"
          title="${isHidden ? 'Show on display screen' : 'Hide from display screen'}">
          ${isHidden ? '○' : '●'}
        </button>
        <button class="icon-btn break-toggle${isBreak ? ' is-break' : ''}"
          onclick="toggleBreak('${st.id}')"
          title="${isBreak ? 'Resume station' : 'Put station on break'}">
          ${isBreak ? '▶' : '☕'}
        </button>
        <button class="icon-btn del" onclick="deleteStation('${st.id}')" title="Delete station">🗑</button>
      </div>

      ${isHidden ? `<div class="hidden-banner">Hidden from display</div>` : ''}

      ${isBreak ? `
        <div class="break-banner">☕ On Break</div>
      ` : `
        <div class="serving-zone"
          ondragover="onServingOver(event,'${st.id}')"
          ondragleave="this.classList.remove('drop-active')"
          ondrop="onServingDrop(event,'${st.id}')">
          <div class="zone-label">▶ Now Serving</div>
          ${srv
            ? `<div class="serving-card" data-cid="${esc(srv)}"
                 draggable="true"
                 ondragstart="onDragStart(event,${jstr(srv)},'${st.id}','serving')"
                 ondragend="onDragEnd()">
                 <span class="serving-num">${esc(srv)}</span>
                 <button class="recall-btn" onclick="recallServing('${st.id}')" title="Re-announce on display screen">📣</button>
                 <button class="ghost-btn" onclick="ghostCandidate('${st.id}')" title="No-show — move to ghosted list">👻</button>
                 <button class="done-btn" onclick="dismiss('${st.id}')">✓ Done</button>
               </div>`
            : '<div class="empty-serving">Nobody here — drag or press Call Next</div>'}
        </div>

        <button class="call-next-btn" onclick="callNext('${st.id}')" ${!q.length ? 'disabled' : ''}>
          ► Call Next${q.length ? ' (' + q.length + ')' : ''}${kbdHint}
        </button>

        <div class="queue-scroll">
          <div class="section-label">Queue</div>
          ${q.length
            ? q.map((cid, i) => `
                <div class="c-card" data-cid="${esc(cid)}"
                  draggable="true"
                  ondragstart="onDragStart(event,${jstr(cid)},'${st.id}','queue')"
                  ondragend="onDragEnd()"
                  ondragover="onCardOver(event,'${st.id}',${jstr(cid)})"
                  ondrop="onCardDrop(event,'${st.id}',${jstr(cid)})">
                  <span class="q-order">${i + 1}</span>
                  <span class="c-num">${esc(cid)}</span>
                </div>`).join('')
            : '<div class="empty-msg">Empty</div>'}
        </div>
      `}
    </div>`;
  }).join('');
}

function render() {
  renderUnassigned();
  renderStations();
  refreshUndoBtn();

  const qsi = document.getElementById('q-size-inp');
  if (qsi) qsi.value = S.settings.queueSize;

  const sqb = document.getElementById('show-q-btn');
  if (sqb) {
    sqb.classList.toggle('on', S.settings.showQueue);
    sqb.textContent = S.settings.showQueue ? '✓ Shown' : 'Hidden';
  }

  const st = document.getElementById('served-total');
  if (st) st.textContent = S.done.length;

  const ghost = document.getElementById('ghosted-total');
  if (ghost) ghost.textContent = (S.ghosted || []).length;
}

load();
render();
