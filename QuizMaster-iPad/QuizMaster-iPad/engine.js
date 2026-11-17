/* QuizMaster für iPad – die Server-Logik von server.py, im Browser.
   Alles liegt in IndexedDB auf dem Gerät. Die App ruft weiter /api/... auf,
   diese Schicht beantwortet die Aufrufe direkt hier. */
(function () {
'use strict';
const QM = window.QM = window.QM || {};
const BUILD = 13;
const _fetch = window.fetch.bind(window);

/* ---------------- kleine Helfer ---------------- */
const clone = o => o === undefined ? undefined : JSON.parse(JSON.stringify(o));
const pad = n => String(n).padStart(2, '0');
function strftime(f, d) {
  d = d || new Date();
  return f.replace(/%Y/g, d.getFullYear()).replace(/%m/g, pad(d.getMonth() + 1)).replace(/%d/g, pad(d.getDate()))
    .replace(/%H/g, pad(d.getHours())).replace(/%M/g, pad(d.getMinutes())).replace(/%S/g, pad(d.getSeconds()));
}
const hex = n => { const a = new Uint8Array(Math.ceil(n / 2)); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, n); };
const nowMs = () => Date.now();
const clean = s => String(s || '').replace(/[^\w-]/g, '');
async function sha1(blob) {
  try { const b = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer()); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
  catch (e) { return 'x' + blob.size; }
}

/* ---------------- Speicher: IndexedDB ---------------- */
let db = null;
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('quizmaster', 1);
    r.onupgradeneeded = () => { const d = r.result; ['kv', 'files', 'trash', 'backups'].forEach(s => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
function store(name, mode) { return db.transaction(name, mode || 'readonly').objectStore(name); }
async function getAllWithKeys(name) {
  const s = store(name); const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
  return keys.map((k, i) => [k, vals[i]]);
}
const idbPut = (name, key, val) => req(store(name, 'readwrite').put(val, key));
const idbDel = (name, key) => req(store(name, 'readwrite').delete(key));
const idbGet = (name, key) => req(store(name).get(key));

/* KV: Pfad -> {v, m}. Hält quizze/… als JSON (wie die Dateien am Mac). */
const KV = new Map();
const FILES = new Map(); // name -> {blob, size, m, sha, url}
const dirty = new Set();
let flushT = null, flushing = Promise.resolve();
const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('quizmaster') : null;
const WIN = hex(8);

function persist(p) { dirty.add(p); if (!flushT) flushT = setTimeout(flush, 0); }
function flush() {
  clearTimeout(flushT); flushT = null;
  if (!dirty.size || !db) return flushing;
  const keys = [...dirty]; dirty.clear();
  flushing = flushing.then(() => new Promise(res => {
    const tx = db.transaction('kv', 'readwrite'), s = tx.objectStore('kv');
    keys.forEach(k => KV.has(k) ? s.put(KV.get(k), k) : s.delete(k));
    tx.oncomplete = () => { bc && bc.postMessage({ t: 'kv', from: WIN, keys }); res(); };
    tx.onerror = tx.onabort = () => { console.warn('Speichern fehlgeschlagen', tx.error); QM.storageError && QM.storageError(tx.error); res(); };
  }));
  return flushing;
}
addEventListener('pagehide', () => flush());
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

/* Dateisystem-Ersatz über KV */
const join = (...a) => a.filter(x => x !== '' && x != null).join('/');
const fs = {
  read(p, def) { return KV.has(p) ? clone(KV.get(p).v) : def; },
  write(p, v) { KV.set(p, { v: clone(v), m: nowMs() }); persist(p); },
  text(p) { const e = KV.get(p); return e && typeof e.v === 'string' ? e.v : null; },
  isfile(p) { return KV.has(p); },
  isdir(d) { const pre = d + '/'; for (const k of KV.keys()) if (k.startsWith(pre)) return true; return false; },
  mtime(p) { const e = KV.get(p); return e ? e.m / 1000 : 0; },
  listdir(d) { const pre = d + '/', out = new Set(); for (const k of KV.keys()) if (k.startsWith(pre)) out.add(k.slice(pre.length).split('/')[0]); return [...out]; },
  remove(p) { if (KV.delete(p)) persist(p); },
  keysUnder(d) { const pre = d + '/'; return [...KV.keys()].filter(k => k.startsWith(pre)); },
  rmtree(d) { fs.keysUnder(d).forEach(k => fs.remove(k)); },
};
const LIB = 'quizze', ACTIVE_FILE = 'quizze/aktiv.txt';
const qdir = qid => join(LIB, clean(qid));
const edir = qid => join(qdir(qid), 'abende');
const epath = (qid, eid) => join(edir(qid), clean(eid) + '.json');
const qpath = qid => join(qdir(qid), 'quiz.json');
const newId = () => strftime('%Y%m%d') + '-' + hex(6);

async function toTrash(kind, name, data) {
  const id = strftime('%Y-%m-%d_%H-%M-%S_') + hex(4);
  await idbPut('trash', id, { kind, name, data, at: nowMs() });
  return id;
}
function backupCopy(name, obj) { idbPut('backups', name, { at: nowMs(), v: clone(obj) }).catch(() => {}); }

/* ---------------- Zustand wie in server.py ---------------- */
let TEMPLATE = null;
let ACTIVE = [null, null], quiz = {}, state = {};
let VERSION = 0, lastBackup = 0;
const listeners = new Set();

function newState() {
  return { teams: [], points: {}, notes: {}, live: { r: 0, q: 0, hint: 0, screen: 'title', showAns: false, after: -1 }, ended: {},
    timer: { end: 0, left: 0, dur: 0, running: false }, log: {}, run: { status: 'idle' }, check: {}, handed: {}, ev: {} };
}

const DEMO_ID = 'demo';
function demoQuiz() {
  const q = (i, text, show, kw) => Object.assign({ id: 'd' + i, type: 'std', text, show, time: 2, max: 2 }, kw || {});
  const rounds = [
    { id: 'dr1', name: 'Allgemeinwissen', pause: 10, color: '#007aff', qs: [
      q(1, 'Wie viele Beine hat eine Spinne?', '8', { tags: ['wissen'] }),
      q(2, 'Welches chemische Element hat das Symbol O?', 'Sauerstoff', { tags: ['wissen'] }),
      q(3, 'In welcher Stadt steht der Eiffelturm?', 'Paris', { tags: ['wissen'] }),
      q(4, 'Wie viele Staaten gehören zur Europäischen Union?', '27', { rule: '± 1 gilt als halb richtig', tags: ['schaetzen'] }),
      q(5, 'Risiko: Nennt ein deutsches Bundesland ohne Küste', 'Baden-Württemberg, Bayern, Berlin, Brandenburg, Hessen, Nordrhein-Westfalen, Rheinland-Pfalz, Saarland, Sachsen, Sachsen-Anhalt, Thüringen', { type: 'risk', max: 5, time: 4 })] },
    { id: 'dr2', name: 'Musik & Tiere', pause: 10, color: '#af52de', qs: [
      q(6, 'Wer veröffentlichte 1982 das Album „Thriller“?', 'Michael Jackson', { tags: ['musik'],
        media: [{ label: 'Billie Jean (Spotify)', target: 'https://open.spotify.com/track/5ChkMS8OtdzJeqyybCc9R5', start: 30, dur: 20 },
          { label: 'Billie Jean, Musikvideo (YouTube)', target: 'https://www.youtube.com/watch?v=Zi_XLOBDo_Y' }] }),
      q(7, 'Welches Tier ist gesucht?', 'Elefant', { type: 'hint', max: 5, time: 4, tags: ['wissen'],
        hints: ['Es lebt in Afrika und in Asien.', 'Es ist das größte lebende Landsäugetier.', 'Es hat einen Rüssel.'], pts: [5, 3, 1] }),
      q(8, 'Welches Instrument hat 88 Tasten?', 'Klavier', { tags: ['musik'],
        media: [{ label: 'Hörbeispiel (YouTube-Suche)', target: 'https://www.youtube.com/results?search_query=klavier+solo' }] })] },
    { id: 'dr3', name: 'Papier & Bilder', pause: 0, color: '#ff9500', qs: [
      q(9, 'Flaggen erkennen (Bogen mit 10 Flaggen)', '', { type: 'manual', max: 10, time: 8, paper: true, tags: ['bild'], rule: '1 Punkt pro richtig erkannter Flagge' }),
      q(10, 'Welche Farbe entsteht aus Blau und Gelb?', 'Grün', { tags: ['bild'] })] }];
  const meta = { title: 'Demo-Quiz', sound: true, demo: true };
  const teams = [{ id: 't1', name: 'Die Besserwisser', table: '1', people: 4, paid: true }, { id: 't2', name: 'Quizzly Bears', table: '2', people: 3, paid: true },
    { id: 't3', name: 'Team Tiramisu', table: '4', people: 5, paid: true }, { id: 't4', name: 'Bayes Watch', table: '3', people: 2 }];
  const pts = { d1: [2, 2, 2, 0], d2: [2, 1, 2, 2], d3: [2, 2, 2, 2], d4: [1, 2, 0, 1], d5: [5, 3, 3, 0], d6: [2, 2, 0, 2], d7: [3, 5, 1, 0], d8: [2, 0, 2, 2] };
  const st = newState(), tn = nowMs();
  st.teams = teams;
  st.points = {}; for (const [qid, vals] of Object.entries(pts)) { st.points[qid] = {}; vals.forEach((v, i) => st.points[qid][teams[i].id] = v); }
  st.ended = { dr1: tn, dr2: tn };
  st.handed = { dr1: Object.fromEntries(teams.map(t => [t.id, tn])), dr2: Object.fromEntries(teams.slice(0, 3).map(t => [t.id, tn])) };
  st.check = { c0: tn, c1: tn, c2: tn, c3: tn };
  st.run = { status: 'live', start: tn - 80 * 60000, pausedMs: 20 * 60000 };
  Object.assign(st.live, { r: 1, q: 0, after: 1 });
  st.ev = { date: strftime('%Y-%m-%d'), start: strftime('%H:00'), place: 'Beispielkneipe', fee: 3, feeMode: 'person', created: tn };
  return [{ meta, rounds }, st];
}
function startDemo() {
  if (ACTIVE[0] !== DEMO_ID) fs.write(join(LIB, 'demo-zurueck.txt'), (ACTIVE[0] || '') + '/' + (ACTIVE[1] || ''));
  fs.rmtree(qdir(DEMO_ID));
  const [qz, st] = demoQuiz();
  fs.write(qpath(DEMO_ID), qz);
  fs.write(epath(DEMO_ID, 'demo'), st);
  activate(DEMO_ID, 'demo');
}
function endDemo() {
  const back = (fs.text(join(LIB, 'demo-zurueck.txt')) || '').trim();
  const i = back.indexOf('/'); const q = i < 0 ? back : back.slice(0, i), e = i < 0 ? '' : back.slice(i + 1);
  activate(q, e || null);
}

function template() { return TEMPLATE && TEMPLATE.meta && TEMPLATE.meta.tpl ? TEMPLATE : null; }
function needsUpdate(q) {
  const t = template(); if (!t) return false;
  const tm = t.meta, m = (q && q.meta) || {};
  const same = m.tpl === tm.tpl || (!m.tpl && m.title === tm.title);
  return same && (m.rev || 1) < (tm.rev || 1);
}
function applyTemplate(qid) {
  const t = template();
  const old = fs.read(qpath(qid), { meta: {}, rounds: [] }); const m = old.meta || {};
  const bid = newId();
  // Sicherung: Quiz ohne Abende kopieren
  fs.keysUnder(qdir(qid)).forEach(k => {
    const rel = k.slice(qdir(qid).length + 1);
    if (/^(abende|sicherungen)\//.test(rel) || rel === 'aktiv-abend.txt' || rel.startsWith('spielstand')) return;
    fs.write(join(qdir(bid), rel), fs.read(k));
  });
  const bq = fs.read(qpath(bid), {}); bq.meta = bq.meta || {};
  bq.meta.title = (m.title || 'Quiz') + ' (Sicherung ' + strftime('%d.%m. %H:%M') + ')';
  delete bq.meta.tpl; bq.meta.backup = true; bq.meta.rev = 0;
  fs.write(qpath(bid), bq);
  const nw = clone(t);
  ['pin', 'pinLen', 'autolock', 'sound', 'title', 'subtitle', 'date', 'start', 'place'].forEach(k => { if (m[k] != null && m[k] !== '') nw.meta[k] = m[k]; });
  const notes = {}; (old.rounds || []).forEach(r => (r.qs || []).forEach(x => { if (x.note) notes[x.id] = x.note; }));
  nw.rounds.forEach(r => r.qs.forEach(x => { if (notes[x.id]) x.note = notes[x.id]; }));
  fs.write(qpath(qid), nw);
  return bid;
}

const BLOCK_RE = /^(.*?)\s*(?:Nr\.\s*)?(\d+)\s*\??\s*$/s;
const sol = q => q.show ? q.show : (q.accept || []).join(' / ');
function mergeBlocksQuiz(qz) {
  const moved = {};
  for (const r of qz.rounds || []) {
    const qs = r.qs || [], out = []; let i = 0;
    while (i < qs.length) {
      const q = qs[i];
      const m = q.type === 'std' && !q.slots ? BLOCK_RE.exec(q.text || '') : null;
      let j = i + 1;
      if (m) {
        const pre = m[1];
        while (j < qs.length) {
          const n = qs[j]; const mm = n.type === 'std' && !n.slots ? BLOCK_RE.exec(n.text || '') : null;
          if (!mm || mm[1] !== pre || !!n.paper !== !!q.paper) break;
          j++;
        }
      }
      const grp = qs.slice(i, j);
      if (grp.length < 2) { out.push(q); i++; continue; }
      const nums = grp.map(x => BLOCK_RE.exec(x.text)[2]);
      const nr = (q.text || '').includes('Nr. ');
      const ints = nums.map(Number);
      const lst = ints.every((v, k) => v === ints[0] + k) ? nums[0] + ' bis ' + nums[nums.length - 1] : nums.slice(0, -1).join(', ') + ' und ' + nums[nums.length - 1];
      const base = Object.assign({}, q);
      let plu = m[1];
      for (const [a, b] of [['Wie heißt Stadtteil', 'Wie heißen die Stadtteile'], ['Bilderwort', 'Bilderwörter'], ['Wie heißt', 'Wie heißen']]) {
        if (plu.includes(a)) { plu = plu.replace(a, b); break; }
      }
      base.text = plu + ' ' + (nr ? 'Nr. ' : '') + lst + ((q.text || '').trim().endsWith('?') ? '?' : '');
      base.slots = nums.map((n, k) => ({ l: (nr ? 'Nr. ' : '') + n, a: sol(grp[k]) }));
      base.per = q.max || 1; base.max = base.per * grp.length;
      base.time = grp.reduce((a, x) => a + (x.time || 0), 0);
      const media = [], seen = new Set();
      grp.forEach(x => (x.media || []).forEach(mm => { if (!seen.has(mm.target)) { seen.add(mm.target); media.push(mm); } }));
      if (media.length) base.media = media;
      ['accept', 'show', 'half', 'rule'].forEach(k => delete base[k]);
      grp.forEach((x, k) => moved[x.id] = [base.id, k]);
      out.push(base); i = j;
    }
    r.qs = out;
  }
  return moved;
}
function mergeBlocks(qid) {
  const p = qpath(qid), q = fs.read(p, null);
  if (!q || (q.meta || {}).blocks) return;
  const moved = mergeBlocksQuiz(q);
  (q.meta = q.meta || {}).blocks = 1;
  fs.write(p, q);
  if (!Object.keys(moved).length) return;
  for (const f of fs.listdir(edir(qid))) {
    if (!f.endsWith('.json')) continue;
    const fp = join(edir(qid), f), st = fs.read(fp, null); if (!st) continue;
    const pts = st.points || (st.points = {}); const sp = st.slotpts || (st.slotpts = {});
    for (const [old, [nw, k]] of Object.entries(moved)) {
      for (const [tid, v] of Object.entries(pts[old] || {})) if (typeof v === 'number') ((sp[nw] = sp[nw] || {})[tid] = sp[nw][tid] || {})[String(k)] = v;
    }
    for (const nw of new Set(Object.values(moved).map(x => x[0]))) for (const [tid, d] of Object.entries(sp[nw] || {})) (pts[nw] = pts[nw] || {})[tid] = Object.values(d).reduce((a, b) => a + b, 0);
    for (const [old, [nw]] of Object.entries(moved)) if (old !== nw) delete pts[old];
    if (st.snap) mergeBlocksQuiz(st.snap);
    fs.write(fp, st);
  }
}
function migrate(qid) { mergeBlocks(qid); }

function teamTotals(st) {
  const tot = {}; (st.teams || []).forEach(t => tot[t.id] = 0);
  for (const per of Object.values(st.points || {})) for (const [tid, v] of Object.entries(per || {})) if (tid in tot && typeof v === 'number') tot[tid] += v;
  return tot;
}
function eventSummary(qid, eid, st, title) {
  const ev = st.ev || {}, tot = teamTotals(st), names = {};
  (st.teams || []).forEach(t => names[t.id] = t.name);
  const top = Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const run = (st.run || {}).status || 'idle';
  const played = !!(Object.keys(st.points || {}).length || Object.keys(st.ended || {}).length || Object.keys(st.log || {}).length);
  return { qid, eid, quiz: title, date: ev.date || '', start: ev.start || '', place: ev.place || '',
    status: (run !== 'idle' || !played || (ev.date || '9999') >= strftime('%Y-%m-%d')) ? run : 'played',
    trial: run === 'idle' && played, teams: (st.teams || []).length, top: top.filter(([, v]) => v > 0).map(([t, v]) => [names[t] || '?', v]),
    created: ev.created || 0, end: (st.run || {}).end || 0, probe: !!ev.trial };
}
const evSort = (a, b) => { const ka = (a.date || ''), kb = (b.date || ''); return ka < kb ? 1 : ka > kb ? -1 : (b.created || 0) - (a.created || 0); };
function listEvents(qid, title, probes) {
  const out = [];
  for (const f of fs.listdir(edir(qid))) {
    if (!f.endsWith('.json')) continue;
    const st = fs.read(join(edir(qid), f), null);
    if (st != null && (probes || !(st.ev || {}).trial)) out.push(eventSummary(qid, f.slice(0, -5), st, title));
  }
  return out.sort(evSort);
}
function listQuizzes() {
  const out = [];
  for (const d of fs.listdir(LIB).sort()) {
    if (d === DEMO_ID) continue;
    const p = join(LIB, d, 'quiz.json'); if (!fs.isfile(p)) continue;
    migrate(d);
    const q = fs.read(p, {}), m = q.meta || {};
    const evs = listEvents(d, m.title || 'Ohne Titel');
    const kinds = {};
    (q.rounds || []).forEach(r => (r.qs || []).forEach(x => [...(x.tags || []), x.type || 'std', ...(x.paper ? ['paper'] : [])].forEach(k => kinds[k] = (kinds[k] || 0) + 1)));
    out.push({ id: d, title: m.title || 'Ohne Titel', rounds: (q.rounds || []).length, kinds, backup: !!(m.backup || (m.title || '').includes(' (Sicherung ')),
      questions: (q.rounds || []).reduce((a, r) => a + (r.qs || []).length, 0), events: evs,
      played: evs.filter(e => ['done', 'played', 'live', 'pause'].includes(e.status)).length, modified: fs.mtime(p), update: needsUpdate(q) });
  }
  const key = x => Math.max(x.modified * 1000, ...x.events.map(e => e.created || 0));
  return out.sort((a, b) => key(b) - key(a));
}
function createEvent(qid, ev, teamsFrom) {
  const st = newState(); st.ev = Object.assign({}, ev || {}); st.ev.created = nowMs();
  if (teamsFrom) {
    const src = fs.read(epath(qid, teamsFrom), {});
    st.teams = (src.teams || []).map(t => { const o = Object.assign({}, t); delete o.paid; return o; });
    ['fee', 'feeMode'].forEach(k => { if ((src.ev || {})[k] != null && !(k in st.ev)) st.ev[k] = src.ev[k]; });
  }
  const eid = newId(); fs.write(epath(qid, eid), st); return eid;
}
function createQuiz(title, src) {
  const qid = newId(); let qz;
  if (src) {
    qz = fs.read(qpath(src), { meta: {}, rounds: [] }); qz.meta = qz.meta || {}; qz.meta.title = title;
    ['tpl', 'rev', 'changes', 'date', 'start', 'subtitle'].forEach(k => delete qz.meta[k]);
    (qz.rounds || []).forEach(r => (r.qs || []).forEach(q => delete q.note));
  } else qz = { meta: { title, sound: true }, rounds: [] };
  fs.write(qpath(qid), qz); return qid;
}
const TEST_TEAMS = ['Die Quizzly Bären', 'Wissensdurst', 'Team Trivia', 'Die Ratefüchse', 'Klugscheißer & Co.', 'Letzter Platz'];
function startTrial(qid, prev) {
  const eid = createEvent(qid, { trial: true, prev, date: strftime('%Y-%m-%d'), start: strftime('%H:%M'), place: 'Probelauf' });
  const st = fs.read(epath(qid, eid), {});
  st.teams = TEST_TEAMS.map((n, i) => ({ id: 't' + hex(7), name: n, table: String(i + 1), people: 4 }));
  fs.write(epath(qid, eid), st); activate(qid, eid); return eid;
}
function cleanupTrials(maxH) {
  maxH = maxH || 12;
  for (const d of fs.listdir(LIB)) {
    for (const f of fs.listdir(edir(d))) {
      if (!f.endsWith('.json')) continue;
      const st = fs.read(join(edir(d), f), null) || {}, ev = st.ev || {};
      if (!ev.trial || nowMs() - (ev.created || 0) < maxH * 3600000) continue;
      fs.remove(join(edir(d), f));
      const ak = join(qdir(d), 'aktiv-abend.txt');
      if ((fs.text(ak) || '').trim() === f.slice(0, -5)) {
        const prev = ev.prev || [null, null];
        if (prev[0] === d && prev[1]) fs.write(ak, prev[1]); else fs.remove(ak);
        if (prev[0] && prev[0] !== d && (fs.text(ACTIVE_FILE) || '').trim() === d) fs.write(ACTIVE_FILE, prev[0]);
      }
    }
  }
}
async function deleteEvent(qid, eid) {
  const p = epath(qid, eid); if (!fs.isfile(p)) return;
  await toTrash('abend', qid + '/' + eid, { qid, eid, state: fs.read(p) });
  fs.remove(p);
}

function activate(qid, eid, create) {
  if (!qid || !fs.isfile(qpath(qid))) { const qs = listQuizzes(); qid = qs.length ? qs[0].id : null; }
  if (!qid) { ACTIVE = [null, null]; quiz = { meta: {}, rounds: [] }; state = newState(); saveActive(); return; }
  migrate(qid);
  if (!eid || !fs.isfile(epath(qid, eid))) {
    eid = (fs.text(join(qdir(qid), 'aktiv-abend.txt')) || '').trim();
    if (!eid || !fs.isfile(epath(qid, eid))) {
      const evs = listEvents(qid, '');
      if (evs.length) eid = evs[0].eid;
      else if (create) {
        const m = (fs.read(qpath(qid), {}).meta) || {}, ev = {};
        [['date', 'date'], ['start', 'start'], ['place', 'subtitle']].forEach(([k, o]) => { if (m[o]) ev[k] = m[o]; });
        eid = createEvent(qid, ev);
      } else eid = null;
    }
  }
  ACTIVE = [qid, eid];
  fs.write(ACTIVE_FILE, qid);
  if (eid) fs.write(join(qdir(qid), 'aktiv-abend.txt'), eid);
  quiz = fs.read(qpath(qid), { meta: {}, rounds: [] });
  state = (eid ? fs.read(epath(qid, eid), null) : null) || newState();
  for (const [k, v] of Object.entries(newState())) if (!(k in state)) state[k] = v;
  saveActive();
}
function closeEvent() { ACTIVE[1] = null; state = newState(); saveActive(); }
function saveActive() { fs.write('__active', ACTIVE.slice()); }

function bump(saveState, saveQuiz) {
  if (saveState === undefined) saveState = true;
  if (saveState && ACTIVE[1]) {
    fs.write(epath(ACTIVE[0], ACTIVE[1]), state);
    if (nowMs() - lastBackup > 120000) { backupCopy(ACTIVE[0] + '/' + ACTIVE[1] + '-' + strftime('%H-%M'), state); lastBackup = nowMs(); }
  }
  if (saveQuiz && ACTIVE[0]) fs.write(qpath(ACTIVE[0]), quiz);
  saveActive();
  notify();
}
function notify() { VERSION++; listeners.forEach(fn => { try { fn(VERSION); } catch (e) {} }); }

function listOp(obj, path, op) {
  for (const k of path.slice(0, -1)) { if (!obj[k] || typeof obj[k] !== 'object' || Array.isArray(obj[k])) obj[k] = {}; obj = obj[k]; }
  const last = path[path.length - 1]; let lst = obj[last];
  if (!Array.isArray(lst)) lst = obj[last] = [];
  if ('push' in op) { if (!lst.some(x => x && typeof x === 'object' && x.id === op.push.id)) lst.push(op.push); }
  else if ('pull' in op) obj[last] = lst.filter(x => !(x && typeof x === 'object' && x.id === op.pull));
  else if ('patch' in op) {
    const pid = op.patch.id, fields = op.patch.set || {};
    lst.forEach(x => { if (x && typeof x === 'object' && x.id === pid) for (const [fk, fv] of Object.entries(fields)) { if (fv == null) delete x[fk]; else x[fk] = fv; } });
  }
}
function setPath(obj, path, value) {
  for (const k of path.slice(0, -1)) { if (!obj[k] || typeof obj[k] !== 'object' || Array.isArray(obj[k])) obj[k] = {}; obj = obj[k]; }
  const last = path[path.length - 1];
  if (value == null) delete obj[last]; else obj[last] = value;
}

/* ---------------- Dateien ---------------- */
function fileEntry(name, blob, sha) {
  const old = FILES.get(name); if (old && old.url) URL.revokeObjectURL(old.url);
  const e = { blob, size: blob.size, m: nowMs(), sha: sha || null, type: blob.type, url: null };
  FILES.set(name, e); return e;
}
function fileURL(name) {
  const e = FILES.get(name); if (!e) return null;
  if (!e.url) e.url = URL.createObjectURL(e.blob.type ? e.blob : new Blob([e.blob], { type: mimeOf(name) }));
  return e.url;
}
function mimeOf(n) {
  const x = (String(n).split('.').pop() || '').toLowerCase();
  return ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm',
    txt: 'text/plain', json: 'application/json', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })[x] || 'application/octet-stream';
}
const safeName = n => (String(n || '').split(/[\\/]/).pop().replace(/[^\w .()\-äöüÄÖÜß]/g, '_')) || 'datei';
async function saveFile(name, blob, sha) {
  if (!(blob instanceof Blob)) blob = new Blob([blob]);
  if (!blob.type) blob = new Blob([blob], { type: mimeOf(name) });
  sha = sha || await sha1(blob);
  const e = fileEntry(name, blob, sha);
  await idbPut('files', name, { blob, size: blob.size, m: e.m, sha });
  bc && bc.postMessage({ t: 'files', from: WIN });
}
async function trashFile(name) {
  const e = FILES.get(name); if (!e) return;
  await toTrash('datei', name, { blob: e.blob, sha: e.sha });
  if (e.url) URL.revokeObjectURL(e.url);
  FILES.delete(name); await idbDel('files', name);
  bc && bc.postMessage({ t: 'files', from: WIN });
}

/* ---------------- /api/meta: Titel zu einem Link ---------------- */
async function fetchMeta(url) {
  if (url.startsWith('spotify:')) { const p = url.split(':'); if (p.length >= 3) url = 'https://open.spotify.com/' + p[1] + '/' + p[2]; }
  try {
    if (/open\.spotify\.com/.test(url)) {
      try { const d = await (await _fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(url))).json(); if (d.title) return { title: d.title.trim() }; } catch (e) {}
    }
    const d = await (await _fetch('https://noembed.com/embed?url=' + encodeURIComponent(url))).json();
    let title = d.title || ''; const author = d.author_name || '';
    if (author && !title.toLowerCase().includes(author.toLowerCase()) && !/spotify/.test(url)) title = author + ' – ' + title;
    return { title: title.trim() };
  } catch (e) { return { title: '', error: String(e) }; }
}

/* ---------------- Anfragen beantworten ---------------- */
const J = (obj, status) => ({ status: status || 200, json: obj });
async function handle(method, path, query, body) {
  await QM.ready;
  if (method === 'GET') {
    if (path === '/api/all') return J({ id: ACTIVE[0], eid: ACTIVE[1], state, quiz: state.snap || quiz, mac: true, win: false, ipad: true, home: 'iPad',
      now: nowMs(), ip: QM.peer ? QM.peer.code() : null, port: null, v: VERSION, tplUpdate: needsUpdate(quiz), tplChanges: ((template() || {}).meta || {}).changes || '' });
    if (path === '/api/library') {
      const qs = listQuizzes();
      const hist = qs.filter(q => !q.backup).flatMap(q => q.events).sort(evSort);
      return J({ items: qs, history: hist, active: ACTIVE[0], eid: ACTIVE[1] });
    }
    if (path === '/api/bank') {
      const out = [];
      for (const it of listQuizzes()) {
        if (it.backup) continue;
        const qq = it.id === ACTIVE[0] ? quiz : fs.read(qpath(it.id), {});
        (qq.rounds || []).forEach((r, ri) => (r.qs || []).forEach((x, qi) => out.push({ qid: it.id, quiz: it.title, rid: r.id, round: r.name || '', ri, qi, q: x })));
      }
      return J({ items: out });
    }
    if (path === '/api/quiz') {
      const qid = query.get('id') || '';
      if (qid === ACTIVE[0]) return J({ id: qid, quiz });
      if (!qid || !fs.isfile(qpath(qid))) return J({ ok: false, msg: 'Quiz nicht gefunden' }, 404);
      return J({ id: qid, quiz: fs.read(qpath(qid), { meta: {}, rounds: [] }) });
    }
    if (path === '/api/meta') return J(await fetchMeta(query.get('url') || ''));
    if (path === '/api/ping') return J({ app: 'QuizMaster', build: BUILD, home: 'iPad' });
    if (path === '/api/files') {
      const out = [...FILES.entries()].filter(([n]) => !n.startsWith('.')).map(([name, e]) => ({ name, size: e.size }));
      out.sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
      return J({ files: out });
    }
    return J({ ok: false, msg: 'Nicht gefunden' }, 404);
  }
  // POST
  if (path === '/api/upload') {
    const target = query.get('replace'); let name;
    if (target) { if (!FILES.has(target)) return J({ ok: false, msg: 'Datei nicht gefunden' }, 404); name = target; }
    else name = safeName(query.get('name') || 'datei');
    if (FILES.has(name)) await trashFile(name);
    await saveFile(name, body);
    return J({ ok: true, name });
  }
  if (path === '/api/file-delete') {
    const name = (body || {}).name || '';
    if (!FILES.has(name)) return J({ ok: false, msg: 'Datei nicht gefunden' }, 404);
    await trashFile(name); return J({ ok: true });
  }
  const data = body || {};
  if (path === '/api/set') {
    if (!ACTIVE[1]) return J({ ok: false, msg: 'Kein Abend geöffnet' });
    for (const op of data.ops || []) { if (['push', 'pull', 'patch'].some(k => k in op)) listOp(state, op.path, op); else setPath(state, op.path, op.value); }
    bump(); return J({ ok: true, v: VERSION });
  }
  if (path === '/api/quiz') {
    const [qid, bd] = 'quiz' in data ? [data.id, data.quiz] : [ACTIVE[0], data];
    if (!qid || !fs.isfile(qpath(qid))) return J({ ok: false, msg: 'Quiz nicht gefunden' }, 404);
    if (qid === ACTIVE[0]) { quiz = bd; bump(false, true); }
    else { fs.write(qpath(qid), bd); bump(false); }
    return J({ ok: true, v: VERSION });
  }
  if (path === '/api/library') {
    const a = data.action; let out = null;
    if (a === 'create') out = createQuiz(data.title || 'Neues Quiz');
    else if (a === 'duplicate') out = createQuiz(data.title || 'Kopie', data.id);
    else if (a === 'event-new') { out = createEvent(data.id, data.ev, data.teamsFrom); if (data.open) activate(data.id, out); }
    else if (a === 'event-open') activate(data.id, data.eid);
    else if (a === 'event-delete') {
      await deleteEvent(data.id, data.eid);
      if (data.id === ACTIVE[0] && data.eid === ACTIVE[1]) { activate(data.id); if (ACTIVE[1] === data.eid) ACTIVE[1] = null; }
    } else if (a === 'history-clear') {
      for (const qd of listQuizzes()) for (const e of qd.events)
        if (['done', 'played'].includes(e.status) && !(qd.id === ACTIVE[0] && e.eid === ACTIVE[1])) await deleteEvent(qd.id, e.eid);
    } else if (a === 'template-update') { applyTemplate(data.id); if (data.id === ACTIVE[0]) activate(data.id, ACTIVE[1]); }
    else if (a === 'demo') startDemo();
    else if (a === 'demo-end') endDemo();
    else if (a === 'delete') {
      if (listQuizzes().length <= 1) return J({ ok: false, msg: 'Das letzte Quiz kann nicht gelöscht werden' });
      const keys = fs.keysUnder(qdir(data.id)), dump = {};
      keys.forEach(k => dump[k] = fs.read(k));
      await toTrash('quiz', (fs.read(qpath(data.id), {}).meta || {}).title || data.id, { qid: data.id, kv: dump });
      fs.rmtree(qdir(data.id));
      if (data.id === ACTIVE[0]) activate('');
    } else if (a === 'restore-backup') {
      const qq = fs.read(qpath(data.id), null);
      if (qq) { qq.meta = qq.meta || {}; delete qq.meta.backup; qq.meta.title = data.title || qq.meta.title; fs.write(qpath(data.id), qq); }
    } else if (a === 'trial-start') {
      let prev = [ACTIVE[0], ACTIVE[1]];
      if ((state.ev || {}).trial) { const old = ACTIVE.slice(); prev = (state.ev || {}).prev || [null, null]; fs.remove(epath(old[0], old[1])); }
      out = startTrial(data.id, prev);
    } else if (a === 'trial-end') {
      const qid = data.id, eid = data.eid;
      const st = (qid === ACTIVE[0] && eid === ACTIVE[1]) ? state : fs.read(epath(qid, eid), {});
      if (!(st.ev || {}).trial) return J({ ok: false, msg: 'Das ist kein Probelauf' });
      const prev = (st.ev || {}).prev || [null, null];
      fs.remove(epath(qid, eid));
      const ak = join(qdir(qid), 'aktiv-abend.txt'); if ((fs.text(ak) || '').trim() === eid) fs.remove(ak);
      if (data.restart) out = startTrial(qid, prev);
      else if (prev[0] && fs.isfile(qpath(prev[0]))) { activate(prev[0], prev[1]); if (!prev[1] || ACTIVE[1] !== prev[1]) closeEvent(); }
      else { activate(qid); closeEvent(); }
    } else if (a === 'copy-q') {
      const src = data.from || {}, dst = data.to || {};
      const sq = src.qid === ACTIVE[0] ? quiz : fs.read(qpath(src.qid || ''), null);
      let item = null;
      ((sq || {}).rounds || []).forEach(r => (r.qs || []).forEach(x => { if (x.id === src.id) item = clone(x); }));
      if (!item || !fs.isfile(qpath(dst.qid || ''))) return J({ ok: false, msg: 'Frage oder Ziel nicht gefunden' });
      item.id = 'q' + hex(7);
      const tq = dst.qid === ACTIVE[0] ? quiz : fs.read(qpath(dst.qid), null);
      const rounds = tq.rounds || (tq.rounds = []);
      let tr = rounds.find(r => r.id === dst.rid);
      if (!tr) { tr = { id: 'r' + hex(7), name: dst.roundName || 'Neue Runde', pause: 0, qs: [] }; rounds.push(tr); }
      (tr.qs || (tr.qs = [])).push(item); out = item.id;
      if (dst.qid === ACTIVE[0]) bump(false, true); else fs.write(qpath(dst.qid), tq);
    } else if (a === 'rename') {
      const qq = fs.read(qpath(data.id), null);
      if (qq) { qq.meta = qq.meta || {}; qq.meta.title = data.title || qq.meta.title; fs.write(qpath(data.id), qq); if (data.id === ACTIVE[0]) quiz.meta.title = qq.meta.title; }
    }
    bump(false);
    return J({ ok: true, active: ACTIVE[0], eid: ACTIVE[1], new: out });
  }
  if (path === '/api/reset') {
    const keep = data.keepTeams !== false;
    const teams = keep ? state.teams : [], check = keep ? (state.check || {}) : {}, ev = state.ev || {};
    backupCopy(ACTIVE[0] + '/' + ACTIVE[1] + '-vor-neustart-' + strftime('%Y%m%d-%H%M%S'), state);
    state = newState(); state.teams = teams; state.check = check; state.ev = ev;
    bump(); return J({ ok: true });
  }
  if (path === '/api/restore') {
    if ('quiz' in data) quiz = data.quiz;
    if ('state' in data) state = data.state;
    bump(true, true); return J({ ok: true });
  }
  if (path === '/api/quit') return J({ ok: true });
  if (path === '/api/open') { const r = QM.media ? await QM.media.open(data.target || '') : [false, 'Nicht verfügbar']; return J({ ok: r[0], msg: r[1], note: r[2] }); }
  if (path === '/api/spotify') {
    const r = QM.spotify ? await QM.spotify.action(data.action || '', data.uri || '', data.pos || 0, data.dur || 0, data.frac || 0) : [false, 'Spotify ist nicht verfügbar'];
    return J({ ok: r[0], msg: r[1], note: r[2] });
  }
  return J({ ok: false, msg: 'Nicht gefunden' }, 404);
}
QM.handle = handle;

/* ---------------- fetch und EventSource umleiten ---------------- */
async function readBody(init) {
  if (!init || init.body == null) return null;
  const b = init.body;
  if (b instanceof Blob) return b;
  if (typeof b === 'string') { try { return JSON.parse(b || '{}'); } catch (e) { return {}; } }
  return b;
}
window.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (!url.startsWith('/api/')) return _fetch(input, init);
  const u = new URL(url, 'http://x');
  const method = ((init && init.method) || 'GET').toUpperCase();
  const body = await readBody(init);
  await QM.ready;
  let r;
  try { r = QM.remote ? await QM.remote.request(method, u.pathname, u.search, body) : await handle(method, u.pathname, u.searchParams, body); }
  catch (e) { console.error(e); r = { status: 500, json: { ok: false, msg: 'Interner Fehler: ' + (e && e.message || e) } }; }
  return new Response(JSON.stringify(r.json), { status: r.status, headers: { 'Content-Type': 'application/json' } });
};
const _ES = window.EventSource;
window.EventSource = function (url) {
  if (!String(url).startsWith('/api/events')) return new _ES(url);
  const es = this; es.readyState = 1; es.onmessage = null; es.onerror = null;
  const fn = v => es.onmessage && es.onmessage({ data: String(v) });
  const src = QM.remote ? QM.remote : { on: f => listeners.add(f), off: f => listeners.delete(f), v: () => VERSION };
  src.on(fn); es.close = () => { es.readyState = 2; src.off(fn); };
  setTimeout(() => fn(src.v()), 0);
};
QM.onBump = f => listeners.add(f);
QM.offBump = f => listeners.delete(f);
QM.version = () => VERSION;

/* ---------------- andere Fenster (Beamer) mitnehmen ---------------- */
async function reloadKV(keys) {
  const s = store('kv');
  if (keys) for (const k of keys) { if (dirty.has(k)) continue; const v = await req(s.get(k)); if (v === undefined) KV.delete(k); else KV.set(k, v); }
  else { const all = await getAllWithKeys('kv'); KV.clear(); all.forEach(([k, v]) => KV.set(k, v)); }
}
function loadActiveFromKV() {
  const a = fs.read('__active', null) || [(fs.text(ACTIVE_FILE) || '').trim() || null, null];
  ACTIVE = a;
  quiz = a[0] ? fs.read(qpath(a[0]), { meta: {}, rounds: [] }) : { meta: {}, rounds: [] };
  state = (a[1] ? fs.read(epath(a[0], a[1]), null) : null) || newState();
  for (const [k, v] of Object.entries(newState())) if (!(k in state)) state[k] = v;
}
async function reloadFiles() {
  const all = await getAllWithKeys('files');
  const seen = new Set();
  all.forEach(([k, v]) => { seen.add(k); const o = FILES.get(k); if (!o || o.m !== v.m) { if (o && o.url) URL.revokeObjectURL(o.url); FILES.set(k, { blob: v.blob, size: v.size, m: v.m, sha: v.sha, url: null }); } });
  [...FILES.keys()].forEach(k => { if (!seen.has(k)) { const o = FILES.get(k); if (o.url) URL.revokeObjectURL(o.url); FILES.delete(k); } });
}
bc && (bc.onmessage = async e => {
  const d = e.data || {}; if (d.from === WIN) return;
  if (d.t === 'kv') { await reloadKV(d.keys); loadActiveFromKV(); notify(); }
  if (d.t === 'files') { await reloadFiles(); notify(); }
  if (d.t === 'all') { await reloadKV(); await reloadFiles(); loadActiveFromKV(); notify(); }
});

/* ---------------- Gesamtsicherung, Papierkorb ---------------- */
async function blobToB64(b) { return new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(b); }); }
function b64ToBlob(s, type) { const bin = atob(s), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], { type: type || '' }); }
QM.data = {
  async exportAll(withFiles) {
    await flush();
    const kv = {}; for (const [k, v] of KV) if (!k.startsWith(join(LIB, DEMO_ID) + '/')) kv[k] = v;
    const files = {};
    if (withFiles !== false) for (const [n, e] of FILES) files[n] = { type: e.blob.type || mimeOf(n), sha: e.sha, data: await blobToB64(e.blob) };
    return { app: 'QuizMaster', kind: 'gesamtsicherung', build: BUILD, at: nowMs(), kv, files };
  },
  async importAll(d, mode) {
    if (!d || d.kind !== 'gesamtsicherung') throw new Error('Das ist keine Gesamtsicherung von QuizMaster');
    await flush();
    if (mode === 'replace') { for (const k of [...KV.keys()]) fs.remove(k); }
    // Unberührtes Startquiz („Mein Quiz“, leer) räumt beim ersten Einspielen den Platz
    let pristine = false;
    if (mode !== 'replace') { const qs = listQuizzes(); if (qs.length === 1 && qs[0].title === 'Mein Quiz' && !qs[0].questions && !qs[0].played) { fs.rmtree(qdir(qs[0].id)); pristine = true; } }
    for (const [k, v] of Object.entries(d.kv || {})) { if (k === '__active' && mode !== 'replace') continue; KV.set(k, v); persist(k); }
    for (const [n, f] of Object.entries(d.files || {})) { if (FILES.has(n) && FILES.get(n).sha === f.sha) continue; if (FILES.has(n)) await trashFile(n); await saveFile(n, b64ToBlob(f.data, f.type), f.sha); }
    await flush();
    if (mode === 'replace') loadActiveFromKV(); else if (pristine || !ACTIVE[0]) activate('', null, true);
    bc && bc.postMessage({ t: 'all', from: WIN });
    notify();
  },
  async trashList() { const all = await getAllWithKeys('trash'); return all.map(([id, v]) => ({ id, kind: v.kind, name: v.name, at: v.at, size: v.data && v.data.blob ? v.data.blob.size : 0 })).sort((a, b) => b.at - a.at); },
  async trashRestore(id) {
    const t = await idbGet('trash', id); if (!t) return 'Nicht mehr im Papierkorb';
    let msg = '';
    if (t.kind === 'datei') { let n = t.name; if (FILES.has(n)) await trashFile(n); await saveFile(n, t.data.blob, t.data.sha); msg = `„${n}“ ist wieder da`; }
    else if (t.kind === 'quiz') { let qid = t.data.qid; if (fs.isdir(qdir(qid))) qid = newId(); for (const [k, v] of Object.entries(t.data.kv)) fs.write(join(qdir(qid), k.slice(qdir(t.data.qid).length + 1)), v); msg = `Quiz „${t.name}“ ist wieder da`; }
    else if (t.kind === 'abend') { const { qid, eid, state: st } = t.data; if (!fs.isfile(qpath(qid))) return 'Das Quiz zu diesem Abend gibt es nicht mehr'; fs.write(epath(qid, eid), st); msg = 'Abend ist wieder da'; }
    await idbDel('trash', id); await flush(); bump(false); return msg;
  },
  async trashEmpty() { await req(store('trash', 'readwrite').clear()); },
  async trashDelete(id) { await idbDel('trash', id); },
  async usage() { try { const e = await navigator.storage.estimate(); return e; } catch (e) { return null; } },
  async persisted() { try { return navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) { return false; } },
  async persist() { try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (e) { return false; } },
  async backups() { const all = await getAllWithKeys('backups'); return all.map(([k, v]) => ({ name: k, at: v.at })).sort((a, b) => b.at - a.at); },
  async backupGet(name) { const v = await idbGet('backups', name); return v && v.v; },
  async pruneBackups(keep) { const all = await QM.data.backups(); for (const b of all.slice(keep || 400)) await idbDel('backups', b.name); },
};
QM.files = { url: fileURL, has: n => FILES.has(n), get: n => FILES.get(n), mime: mimeOf, list: () => [...FILES.keys()] };
QM.flush = flush;

/* ---------------- Start ---------------- */
async function seed() {
  // Vorlage und mitgelieferte Dateien
  try { TEMPLATE = await (await _fetch('vorlage.json', { cache: 'no-cache' })).json(); } catch (e) { TEMPLATE = null; }
  let idx = {};
  try { idx = await (await _fetch('dateien/index.json', { cache: 'no-cache' })).json(); } catch (e) {}
  const mf = join(LIB, 'mitgeliefert.json'); const seeded = fs.read(mf, {});
  for (const [f, h] of Object.entries(idx)) {
    const cur = FILES.get(f);
    if (cur && (cur.sha === h || cur.sha !== seeded[f])) { if (cur.sha === h) seeded[f] = h; continue; }
    try { const b = await (await _fetch('dateien/' + encodeURIComponent(f), { cache: 'no-cache' })).blob(); await saveFile(f, b, h); seeded[f] = h; } catch (e) {}
  }
  fs.write(mf, seeded);
  if (!listQuizzes().length) {
    const qid = createQuiz(TEMPLATE ? 'Kneipenquiz' : 'Mein Quiz');
    if (TEMPLATE) fs.write(qpath(qid), TEMPLATE);
    fs.write(ACTIVE_FILE, qid);
  }
}
QM.ready = (async () => {
  if (QM.remoteBoot) { await QM.remoteBoot; return; }
  db = await idbOpen();
  (await getAllWithKeys('kv')).forEach(([k, v]) => KV.set(k, v));
  (await getAllWithKeys('files')).forEach(([k, v]) => FILES.set(k, { blob: v.blob, size: v.size, m: v.m, sha: v.sha, url: null }));
  if (QM.passive) { TEMPLATE = null; loadActiveFromKV(); return; }
  await seed();
  cleanupTrials();
  const first = (fs.text(ACTIVE_FILE) || '').trim();
  activate(first, null, !listQuizzes().some(q => q.events.length));
  await flush();
  QM.data.persist();
  QM.data.pruneBackups(400);
})();
})();
