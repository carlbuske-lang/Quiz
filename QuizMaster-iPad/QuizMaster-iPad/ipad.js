/* QuizMaster für iPad – alles, was am Mac das Betriebssystem erledigt:
   Dateien zeigen, Spotify und YouTube, Beamer, zweites Gerät, Sicherung, Touch. */
(function () {
'use strict';
const QM = window.QM;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = s => document.querySelector(s);
const toast = t => (QM.app ? QM.app.toast(t) : console.log(t));
const icon = n => ({
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M6.5 11H6a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 18 11h-.5"/>',
  print: '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="8" rx="2"/><path d="M7 14h10v6H7z"/>',
  ext: '<path d="M14 4.5h5.5V10M19.5 4.5L11 13"/><path d="M17.5 13.5v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8A1.5 1.5 0 0 1 6 6.5h4.5"/>',
  beam: '<rect x="3.5" y="5" width="17" height="11" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  pause: '<path d="M8 5.5v13M16 5.5v13" stroke-width="3"/>',
  minus: '<path d="M6 12h12"/>', plus: '<path d="M12 6v12M6 12h12"/>',
}[n] || '');
const ic = (n, s) => `<svg class="i" viewBox="0 0 24 24" style="width:${s || 16}px;height:${s || 16}px">${icon(n)}</svg>`;
const sheet = (title, body, actions) => window.sheet(title, body, actions);
const closeModals = () => document.querySelectorAll('.modal').forEach(m => m.remove());
const kindOf = t => {
  t = String(t || '');
  if (/^spotify:|open\.spotify\.com/.test(t)) return 'spotify';
  if (/youtube\.com|youtu\.be/.test(t)) return 'youtube';
  if (/^https?:/.test(t)) return 'link';
  if (/\.(png|jpe?g|gif|webp|heic|svg|bmp)$/i.test(t)) return 'image';
  if (/\.pdf$/i.test(t)) return 'pdf';
  if (/\.(mp4|mov|m4v|webm)$/i.test(t)) return 'video';
  if (/\.(mp3|m4a|aac|wav|ogg|flac|aiff?)$/i.test(t)) return 'audio';
  return 'file';
};
QM.kindOf = kindOf;

/* ======================= Sichern (Datei aus der App heraus) ======================= */
async function shareOrDownload(name, blob) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (QM.touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e && e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  return true;
}
// Teilen braucht einen frischen Fingertipp. Nach längerem Rechnen fragt ein kleiner Dialog noch einmal.
QM.save = function (name, blob, late) {
  if (!late) return shareOrDownload(name, blob).catch(() => QM.save(name, blob, true));
  sheet('Datei ist bereit', `<div class="muted">${esc(name)}, ${fsize(blob.size)}</div>`,
    `<button class="btn" onclick="closeModals()">Abbrechen</button><button class="btn pri" id="qmsave">${ic('share', 14)}Sichern oder teilen</button>`);
  $('#qmsave').onclick = () => { closeModals(); shareOrDownload(name, blob); };
};
const fsize = b => b > 1e6 ? (b / 1e6).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';

/* ======================= Drucken ======================= */
QM.printHTML = function (html) {
  let d = $('#qmprint'); if (d) d.remove();
  d = document.createElement('div'); d.id = 'qmprint'; d.innerHTML = html; document.body.appendChild(d);
  document.documentElement.classList.add('qm-printing');
  const done = () => { document.documentElement.classList.remove('qm-printing'); d.remove(); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { try { window.print(); } catch (e) { toast('Drucken ging nicht'); done(); } }, 120);
  setTimeout(() => { if (document.hasFocus()) {} }, 0);
};

/* ======================= Ansicht für Dateien, YouTube, Audio ======================= */
const V = { el: null, beam: null, target: null, pdf: null, page: 1, pages: 0 };
function viewerShell(title, tools) {
  const tg = V.next; closeViewer(true); V.target = tg;
  const el = document.createElement('div'); el.className = 'qmv'; el.innerHTML = `
    <div class="qmv-bar"><div class="qmv-t">${esc(title)}</div><div class="qmv-tools">${tools || ''}
      <button class="btn" data-beam title="Auf dem Beamer zeigen">${ic('beam', 15)}<span>Beamer</span></button>
      <button class="btn pri" data-close>Fertig</button></div></div>
    <div class="qmv-body"></div>`;
  document.body.appendChild(el); V.el = el;
  el.querySelector('[data-close]').onclick = () => closeViewer();
  const bb = el.querySelector('[data-beam]');
  const S = QM.app && QM.app.S, Qz = QM.app && QM.app.Q;
  if (!(Qz && Qz.meta && Qz.meta.beamer) || !S || !S.ev) bb.remove();
  else bb.onclick = () => { V.beam = !V.beam; bb.classList.toggle('on', V.beam); beamSync(); toast(V.beam ? 'Läuft jetzt auch auf dem Beamer' : 'Beamer zeigt wieder das Quiz'); };
  requestAnimationFrame(() => el.classList.add('on'));
  return el.querySelector('.qmv-body');
}
function closeViewer(silent) {
  if (!V.el) return;
  const el = V.el; V.el = null;
  el.querySelectorAll('video,audio').forEach(m => { try { m.pause(); } catch (e) {} });
  el.remove();
  if (V.beam) { V.beam = false; beamSync(); }
  V.target = null; V.pdf = null;
}
QM.closeViewer = closeViewer;
function beamSync() {
  const S = QM.app && QM.app.S; if (!S || !S.ev) return;
  const val = V.beam && V.target ? { target: V.target, page: V.page || 1, at: Date.now() } : null;
  window.setOps && window.setOps([{ path: ['live', 'qmMedia'], value: val }]);
}
addEventListener('keydown', e => { if (V.el && e.key === 'Escape') closeViewer(); }, true);

async function showImage(name, url) {
  const body = viewerShell(name, `<button class="btn" data-share>${ic('share', 15)}<span>Teilen</span></button>`);
  body.classList.add('qmv-img');
  body.innerHTML = `<div class="qmv-zoom"><img src="${url}" alt=""></div>`;
  const z = body.firstChild, img = z.firstChild; let big = false;
  img.ondblclick = () => { big = !big; z.classList.toggle('big', big); };
  V.el.querySelector('[data-share]').onclick = () => shareFile(name);
}
async function shareFile(name) { const e = QM.files.get(name); if (e) shareOrDownload(name, e.blob); }

let pdfjs = null;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href;
  return pdfjs;
}
async function renderPdf(box, blob, opts) {
  opts = opts || {};
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
  const pages = opts.only ? [opts.only] : Array.from({ length: doc.numPages }, (_, i) => i + 1);
  const W = opts.width || box.clientWidth || 800, H = opts.height || 0, dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const n of pages) {
    const page = await doc.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    let k = (W - (opts.only ? 0 : 32)) / vp1.width; if (H) k = Math.min(k, H / vp1.height);
    const vp = page.getViewport({ scale: k * dpr });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    c.style.width = vp.width / dpr + 'px'; c.style.height = vp.height / dpr + 'px'; c.dataset.page = n; c.className = 'qmv-page';
    box.appendChild(c);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
  return doc;
}
async function showPdf(name, blob) {
  const body = viewerShell(name, `<span class="qmv-pg muted small"></span><button class="btn" data-print>${ic('print', 15)}<span>Drucken</span></button><button class="btn" data-share>${ic('share', 15)}<span>Teilen</span></button>`);
  body.classList.add('qmv-pdf');
  body.innerHTML = '<div class="qmv-load muted">PDF wird geladen …</div>';
  V.el.querySelector('[data-share]').onclick = () => shareFile(name);
  V.el.querySelector('[data-print]').onclick = () => printPdf(name, blob);
  try {
    const box = document.createElement('div'); box.className = 'qmv-pages';
    body.innerHTML = ''; body.appendChild(box);
    const doc = await renderPdf(box, blob, { width: Math.min(body.clientWidth, 1100) });
    V.pages = doc.numPages; V.page = 1;
    const pg = V.el && V.el.querySelector('.qmv-pg');
    const upd = () => {
      if (!V.el) return;
      let best = 1, top = body.scrollTop + body.clientHeight * 0.35;
      box.querySelectorAll('canvas').forEach(c => { if (c.offsetTop <= top) best = +c.dataset.page; });
      if (best !== V.page) { V.page = best; if (V.beam) beamSync(); }
      if (pg) pg.textContent = `Seite ${V.page} von ${V.pages}`;
    };
    body.addEventListener('scroll', upd, { passive: true }); upd();
  } catch (e) {
    console.error(e);
    body.innerHTML = `<div class="qmv-load"><b>Die PDF lässt sich hier nicht anzeigen.</b><div class="muted" style="margin-top:6px">Über „Teilen“ öffnest du sie in einer anderen App.</div></div>`;
  }
}
function printPdf(name, blob) {
  // iPad: Drucken über das Teilen-Menü ist am zuverlässigsten (AirPrint)
  const file = new File([blob], name, { type: 'application/pdf' });
  if (QM.touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file] }).catch(() => {});
    toast('Im Menü „Drucken“ wählen');
    return;
  }
  const w = window.open(URL.createObjectURL(blob), '_blank');
  if (!w) shareOrDownload(name, blob);
}
function showMediaFile(name, url, kind) {
  const body = viewerShell(name, `<button class="btn" data-share>${ic('share', 15)}<span>Teilen</span></button>`);
  body.classList.add('qmv-av');
  body.innerHTML = kind === 'video' ? `<video src="${url}" controls playsinline autoplay></video>` : `<div class="qmv-audio"><div class="qmv-an">${esc(name)}</div><audio src="${url}" controls autoplay></audio></div>`;
  V.el.querySelector('[data-share]').onclick = () => shareFile(name);
  const m = body.querySelector('video,audio'); m.play && m.play().catch(() => {});
}
const ytId = u => { const m = String(u).match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/); return m ? m[1] : null; };
const ytStart = u => { const m = String(u).match(/[?&#](?:t|start)=(\d+h)?(\d+m)?(\d+)s?/); if (!m) return 0; return (parseInt(m[1]) || 0) * 3600 + (parseInt(m[2]) || 0) * 60 + (parseInt(m[3]) || 0); };
const ytEmbed = (id, start, mute) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0&modestbranding=1${start ? '&start=' + start : ''}${mute ? '&mute=1' : ''}`;
function showYoutube(url, title) {
  const id = ytId(url);
  if (!id) { openLink(url); return [true, 'ok', 'In YouTube geöffnet']; }
  const body = viewerShell(title || 'YouTube', `<button class="btn" data-ext>${ic('ext', 15)}<span>In YouTube öffnen</span></button>`);
  body.classList.add('qmv-yt');
  body.innerHTML = `<div class="qmv-16x9"><iframe src="${ytEmbed(id, ytStart(url))}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe></div>`;
  V.el.querySelector('[data-ext]').onclick = () => openLink(url);
  return [true, 'ok', 'Video läuft. Startet es nicht, einmal auf das Bild tippen.'];
}
function openLink(url) { const w = window.open(url, '_blank', 'noopener'); if (!w) location.href = url; }

QM.media = {
  async open(t) {
    t = String(t || '');
    if (!t) return [false, 'Kein Ziel angegeben'];
    if (t === '.') { QM.ui.dataSheet(); return [true, 'ok', false]; }
    const k = kindOf(t);
    V.next = t;
    if (k === 'spotify') return QM.spotify.openApp(t);
    if (k === 'youtube') return showYoutube(t);
    if (k === 'link') { openLink(t); return [true, 'ok', 'Im Browser geöffnet']; }
    const e = QM.files.get(t);
    if (!e) return [false, 'Datei nicht gefunden: ' + t];
    const url = QM.files.url(t);
    if (k === 'image') { showImage(t, url); return [true, 'ok', false]; }
    if (k === 'pdf') { showPdf(t, e.blob); return [true, 'ok', false]; }
    if (k === 'video' || k === 'audio') { showMediaFile(t, url, k); return [true, 'ok', false]; }
    await shareOrDownload(t, e.blob); return [true, 'ok', 'Zum Öffnen an eine andere App übergeben'];
  },
};

/* ======================= Spotify ======================= */
const SPK = 'qm-spotify';
const spCfg = () => { try { return JSON.parse(localStorage.getItem(SPK) || '{}'); } catch (e) { return {}; } };
const spSave = c => { try { localStorage.setItem(SPK, JSON.stringify(c)); } catch (e) {} };
const REDIRECT = () => location.origin + location.pathname;
const SCOPES = 'user-read-playback-state user-modify-playback-state';
function spParse(s) {
  s = String(s || '').trim();
  let m = s.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist|episode|artist)\/([A-Za-z0-9]+)/);
  if (m) return { type: m[1], id: m[2], uri: `spotify:${m[1]}:${m[2]}`, web: `https://open.spotify.com/${m[1]}/${m[2]}` };
  m = s.match(/^spotify:(track|album|playlist|episode|artist):([A-Za-z0-9]+)/);
  if (m) return { type: m[1], id: m[2], uri: s, web: `https://open.spotify.com/${m[1]}/${m[2]}` };
  return null;
}
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rnd = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a).slice(0, n); };
let spTimer = null, spEmbed = null;

async function spToken() {
  const c = spCfg(); if (!c.refresh || !c.clientId) return null;
  if (c.access && c.exp > Date.now() + 30000) return c.access;
  const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { if (j.error === 'invalid_grant') { delete c.refresh; delete c.access; spSave(c); } throw new Error('Spotify-Anmeldung abgelaufen. Unter Einstellungen › Spotify neu verbinden.'); }
  c.access = j.access_token; c.exp = Date.now() + (j.expires_in || 3600) * 1000; if (j.refresh_token) c.refresh = j.refresh_token; spSave(c);
  return c.access;
}
async function spApi(method, path, body) {
  const tok = await spToken();
  const r = await fetch('https://api.spotify.com/v1' + path, { method, headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || ('Spotify antwortet mit ' + r.status)); e.status = r.status; e.reason = j.error && j.error.reason; throw e; }
  return j;
}
async function spDevice() {
  const c = spCfg(); const d = (await spApi('GET', '/me/player/devices')).devices || [];
  if (!d.length) return null;
  return d.find(x => x.id === c.device) || d.find(x => x.is_active) || d.find(x => /ipad|tablet/i.test(x.name + x.type)) || d[0];
}
async function spPlayApi(info, pos, dur, frac) {
  const dev = await spDevice();
  if (!dev) return [false, 'Kein Spotify-Gerät gefunden. Öffne die Spotify-App, spiele kurz irgendetwas an und tippe dann noch mal auf Abspielen.'];
  if (frac && !pos && info.type === 'track') {
    try { const t = await spApi('GET', '/tracks/' + info.id); const L = (t.duration_ms || 0) / 1000; if (L) pos = Math.max(0, Math.min(L * frac, L - (dur || 0) - 3)); } catch (e) {}
  }
  const body = ['track', 'episode'].includes(info.type) ? { uris: [info.uri] } : { context_uri: info.uri };
  if (pos) body.position_ms = Math.round(pos * 1000);
  await spApi('PUT', '/me/player/play?device_id=' + encodeURIComponent(dev.id), body);
  if (dev.volume_percent != null && dev.supports_volume !== false) spApi('PUT', '/me/player/volume?volume_percent=100&device_id=' + encodeURIComponent(dev.id)).catch(() => {});
  clearTimeout(spTimer);
  if (dur) spTimer = setTimeout(() => spFadeApi(dev), dur * 1000);
  return [true, 'ok', `Spotify spielt auf „${dev.name}“${pos ? ` ab ${fmtS(pos)}` : ''}${dur ? `, ${dur} Sekunden` : ''}`];
}
const fmtS = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
async function spFadeApi(dev) {
  clearTimeout(spTimer);
  if (dev && dev.supports_volume !== false) {
    try { for (const v of [80, 60, 45, 30, 18, 8]) { await spApi('PUT', '/me/player/volume?volume_percent=' + v); await new Promise(r => setTimeout(r, 220)); } } catch (e) {}
  }
  try { await spApi('PUT', '/me/player/pause'); } catch (e) {}
  if (dev && dev.supports_volume !== false) spApi('PUT', '/me/player/volume?volume_percent=100').catch(() => {});
}
// Ohne Verbindung: Spotify-Player in der App. Spielt die 30-Sekunden-Vorschau, mit Anmeldung im Browser auch ganze Songs.
let iframeApi = null;
function loadIframeApi() {
  if (iframeApi) return iframeApi;
  iframeApi = new Promise((res, rej) => {
    window.onSpotifyIframeApiReady = api => res(api);
    const s = document.createElement('script'); s.src = 'https://open.spotify.com/embed/iframe-api/v1'; s.async = true;
    s.onerror = () => { iframeApi = null; rej(new Error('Spotify ist ohne Internet nicht erreichbar')); };
    document.head.appendChild(s);
    setTimeout(() => rej(new Error('Spotify antwortet nicht')), 12000);
  });
  return iframeApi;
}
async function spPlayEmbed(info, dur) {
  let box = $('#qmsp');
  if (!box) {
    box = document.createElement('div'); box.id = 'qmsp'; box.className = 'qmsp';
    box.innerHTML = `<div class="qmsp-h"><span>Spotify</span><span class="grow"></span><button class="btn plain small" data-app>${ic('ext', 13)}In Spotify öffnen</button><button class="btn icon plain" data-x title="Schließen">${ic('x', 14)}</button></div><div class="qmsp-f"><div id="qmspf"></div></div>`;
    document.body.appendChild(box);
    box.querySelector('[data-x]').onclick = () => { try { spEmbed && spEmbed.pause(); } catch (e) {} box.classList.remove('on'); };
  }
  box.querySelector('[data-app]').onclick = () => openLink(info.web);
  box.classList.add('on');
  const api = await loadIframeApi();
  const start = () => { try { spEmbed.play(); } catch (e) {} };
  if (!spEmbed) {
    await new Promise(res => api.createController($('#qmspf'), { uri: info.uri, width: '100%', height: 152 }, c => { spEmbed = c; c.addListener('ready', () => { start(); res(); }); setTimeout(res, 4000); }));
  } else { spEmbed.loadUri(info.uri); setTimeout(start, 600); }
  clearTimeout(spTimer);
  if (dur) spTimer = setTimeout(() => { try { spEmbed.pause(); } catch (e) {} }, (dur + 1.5) * 1000);
  return [true, 'ok', 'Spotify-Vorschau läuft (Startet sie nicht, im Player auf Play tippen). Für ganze Songs ab beliebiger Stelle: Einstellungen › Spotify verbinden.'];
}
QM.spotify = {
  connected: () => !!spCfg().refresh,
  async action(a, uri, pos, dur, frac) {
    const info = spParse(uri);
    try {
      if (a === 'play') {
        if (!info) return [false, 'Das ist kein Spotify-Link'];
        if (QM.spotify.connected()) {
          try { return await spPlayApi(info, +pos || 0, +dur || 0, +frac || 0); }
          catch (e) {
            if (e.reason === 'PREMIUM_REQUIRED') return [false, 'Die Steuerung braucht Spotify Premium'];
            if (e.status === 404) return [false, 'Spotify-Gerät nicht erreichbar. Öffne die Spotify-App, spiele kurz etwas an und tippe noch mal.'];
            return [false, e.message];
          }
        }
        return await spPlayEmbed(info, +dur || 0);
      }
      if (a === 'pause' || a === 'fade') {
        clearTimeout(spTimer);
        if (spEmbed) try { spEmbed.pause(); } catch (e) {}
        if (QM.spotify.connected()) { if (a === 'fade') await spFadeApi({}); else await spApi('PUT', '/me/player/pause'); }
        return [true, 'ok'];
      }
      return [false, 'Unbekannte Aktion'];
    } catch (e) { return [false, e.message || String(e)]; }
  },
  openApp(t) { const info = spParse(t); openLink(info ? info.web : t); return [true, 'ok', 'In Spotify geöffnet']; },
  async connect() {
    const id = ($('#spcid') && $('#spcid').value.trim()) || spCfg().clientId;
    if (!id || !/^[0-9a-f]{32}$/i.test(id)) return toast('Bitte erst die Client ID eintragen (32 Zeichen)');
    const c = spCfg(); c.clientId = id; const verifier = rnd(64), nonce = rnd(10); c.pending = nonce; spSave(c);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    // Der Schlüssel reist im state mit, damit die Anmeldung auch klappt, wenn iOS sie in Safari statt in der App öffnet
    const state = 'qm.' + btoa(JSON.stringify({ v: verifier, n: nonce, c: id })).replace(/=+$/, '');
    location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({ response_type: 'code', client_id: id, scope: SCOPES, redirect_uri: REDIRECT(), code_challenge_method: 'S256', code_challenge: challenge, state });
  },
  disconnect() { const c = spCfg(); delete c.refresh; delete c.access; delete c.exp; delete c.device; spSave(c); QM.app.render(); toast('Spotify getrennt'); },
  async callback(sp) {
    const st = sp.get('state') || '', code = sp.get('code'), err = sp.get('error');
    history.replaceState(null, '', location.pathname);
    if (err) return toast('Spotify-Anmeldung abgebrochen');
    let d; try { d = JSON.parse(atob(st.slice(3))); } catch (e) { return toast('Spotify-Anmeldung unvollständig'); }
    const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT(), client_id: d.c, code_verifier: d.v }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.refresh_token) return sheet('Spotify', `<div class="muted">Die Anmeldung hat nicht geklappt: ${esc(j.error_description || j.error || r.status)}. Prüfe, ob die Weiterleitungsadresse im Spotify-Dashboard genau so eingetragen ist:</div><div class="url" style="font-size:14px">${esc(REDIRECT())}</div>`, '<button class="btn pri" onclick="closeModals()">OK</button>');
    const c = spCfg(); const same = c.pending === d.n;
    Object.assign(c, { clientId: d.c, refresh: j.refresh_token, access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }); delete c.pending; spSave(c);
    if (same) { toast('Spotify ist verbunden'); return; }
    // iOS hat die Anmeldung in Safari statt in der Home-Bildschirm-App geöffnet: Schlüssel per Hand übertragen
    const key = btoa(JSON.stringify({ c: d.c, r: j.refresh_token }));
    sheet('Fast fertig', `<div class="muted">Spotify ist hier in Safari verbunden. Damit die QuizMaster-App auf dem Home-Bildschirm es auch kann: Schlüssel kopieren, die App öffnen, unter Einstellungen › Spotify „Schlüssel einfügen“ tippen.</div><textarea readonly class="qm-key">${esc(key)}</textarea>`,
      `<button class="btn" onclick="closeModals()">Schließen</button><button class="btn pri" id="qmkeycp">Schlüssel kopieren</button>`);
    $('#qmkeycp').onclick = () => navigator.clipboard.writeText(key).then(() => toast('Kopiert. Jetzt die App öffnen.'));
  },
  async pasteKey() {
    let t = ''; try { t = await navigator.clipboard.readText(); } catch (e) {}
    if (!t) { t = prompt('Schlüssel einfügen') || ''; }
    try { const d = JSON.parse(atob(t.trim())); const c = spCfg(); Object.assign(c, { clientId: d.c, refresh: d.r }); delete c.access; spSave(c); await spToken(); toast('Spotify ist verbunden'); QM.app.render(); }
    catch (e) { toast('Das ist kein gültiger Schlüssel'); }
  },
  async devices() {
    try { const d = (await spApi('GET', '/me/player/devices')).devices || []; return d; } catch (e) { toast(e.message); return []; }
  },
  async chooseDevice() {
    const d = await QM.spotify.devices(), c = spCfg();
    if (!d.length) return sheet('Spotify-Gerät', '<div class="muted">Gerade ist kein Gerät online. Öffne die Spotify-App auf dem iPad oder einem anderen Gerät, spiele kurz etwas an und schau dann noch mal hier.</div>', '<button class="btn pri" onclick="closeModals()">OK</button>');
    sheet('Worauf soll Spotify spielen?', `<div class="group" style="margin-top:12px">${d.map(x => `<label class="gr click"><input type="radio" name="spdev" value="${esc(x.id)}" ${(c.device ? c.device === x.id : x.is_active) ? 'checked' : ''}><div class="grow">${esc(x.name)}<div class="muted small">${esc(x.type)}${x.is_active ? ', spielt gerade' : ''}</div></div></label>`).join('')}</div>`,
      `<button class="btn" onclick="closeModals()">Abbrechen</button><button class="btn pri" id="spdevok">Übernehmen</button>`);
    $('#spdevok').onclick = () => { const v = (document.querySelector('input[name=spdev]:checked') || {}).value; const cc = spCfg(); cc.device = v || null; cc.deviceName = (d.find(x => x.id === v) || {}).name; spSave(cc); closeModals(); QM.app.render(); };
  },
  test() { return QM.spotify.action('play', 'spotify:track:5ChkMS8OtdzJeqyybCc9R5', 0, 8, 0.3).then(r => toast(r[0] ? (r[2] || 'Läuft') : r[1])); },
  help() {
    sheet('Spotify wie am Mac steuern', `<div class="muted" style="line-height:1.55">Ohne Verbindung spielt QuizMaster die 30-Sekunden-Vorschau von Spotify. Mit Verbindung startet jeder Song in der Spotify-App an der eingestellten Stelle (vom Anfang, feste Sekunde oder zufällig) und stoppt nach der eingestellten Dauer. Dafür braucht es Spotify Premium und einmalig einen kostenlosen Zugang bei Spotify:</div>
      <ol class="qm-steps"><li>Auf <b>developer.spotify.com/dashboard</b> mit deinem Spotify-Konto anmelden, die Bedingungen bestätigen.</li>
      <li><b>Create app</b>: Name „QuizMaster“, Beschreibung beliebig. Bei <b>Redirect URI</b> genau diese Adresse eintragen:<div class="url" style="font-size:13px;user-select:all">${esc(REDIRECT())}</div></li>
      <li>Bei „Which API/SDKs“ <b>Web API</b> ankreuzen, speichern.</li>
      <li>In der App unter <b>Settings</b> die <b>Client ID</b> kopieren und hier eintragen, dann „Verbinden“.</li>
      <li>Soll eine Freundin es auch nutzen: im Dashboard unter <b>User Management</b> ihre Spotify-E-Mail eintragen (bis zu 5 Personen), oder sie legt ihren eigenen Zugang an.</li></ol>
      <div class="muted small">Zum Abspielen muss die Spotify-App auf dem iPad (oder einem anderen Gerät) geöffnet sein. Die Lautstärke regelt das iPad selbst.</div>`,
      '<button class="btn pri" onclick="closeModals()">Verstanden</button>');
  },
};

/* ======================= Beamer ======================= */
QM.beamer = {
  open() {
    sheet('Beamer öffnen', `<div class="muted">Wie ist der Beamer angeschlossen?</div>
      <div class="qm-choice">
       <button class="fct" onclick="QM.beamer.overlay()"><div><b>Bildschirm spiegeln</b><div class="muted small">Per Kabel oder AirPlay. Das iPad zeigt dann die Beamer-Ansicht, ein Tipp oben links holt das Cockpit zurück.</div></div></button>
       <button class="fct" onclick="QM.beamer.window()"><div><b>Eigenes Fenster</b><div class="muted small">Für einen externen Bildschirm als erweiterter Bildschirm (Stage Manager). Nur in Safari, nicht in der Home-Bildschirm-App.</div></div></button>
       <button class="fct" onclick="closeModals();QM.peer.dialog(true)"><div><b>Anderes Gerät am Beamer</b><div class="muted small">Laptop, Fernseher-Browser oder zweites Tablet zeigt die Beamer-Ansicht über einen Code.</div></div></button>
      </div>`, '<button class="btn" onclick="closeModals()">Abbrechen</button>');
  },
  window() {
    closeModals();
    const w = window.open('?beamer', 'qmbeamer');
    if (!w) return toast('Fenster wurde blockiert');
    toast(QM.standalone ? 'Die Home-Bildschirm-App kann kein zweites Fenster. Nutze „Bildschirm spiegeln“.' : 'Fenster auf den externen Bildschirm ziehen');
  },
  overlay() {
    closeModals();
    let o = $('#qmbeam'); if (o) o.remove();
    o = document.createElement('div'); o.id = 'qmbeam';
    o.innerHTML = `<iframe src="?beamer" title="Beamer"></iframe><button class="qmb-x" title="Zurück zum Cockpit">Cockpit</button>`;
    document.body.appendChild(o);
    const x = o.querySelector('.qmb-x');
    let t = null; const show = () => { x.classList.add('on'); clearTimeout(t); t = setTimeout(() => x.classList.remove('on'), 2500); };
    o.addEventListener('pointerdown', show); show();
    x.onclick = e => { e.stopPropagation(); o.remove(); };
    try { o.requestFullscreen && o.requestFullscreen().catch(() => {}); } catch (e) {}
  },
};
// Beamer-Fenster: Bilder, PDF-Seiten und YouTube vom Cockpit mitzeigen
function beamerMedia() {
  let cur = null, layer = null;
  setInterval(async () => {
    const S = QM.app && QM.app.S; const m = S && S.live && S.live.qmMedia;
    const key = m ? m.target + '#' + (m.page || 1) : null;
    if (key === cur) return; cur = key;
    if (layer) { layer.remove(); layer = null; }
    if (!m) return;
    layer = document.createElement('div'); layer.className = 'qmbm'; document.body.appendChild(layer);
    const k = kindOf(m.target);
    if (k === 'youtube') { const id = ytId(m.target); if (id) layer.innerHTML = `<iframe src="${ytEmbed(id, ytStart(m.target), true)}" allow="autoplay; fullscreen"></iframe>`; return; }
    const e = QM.files.get(m.target); if (!e) return;
    if (k === 'image') layer.innerHTML = `<img src="${QM.files.url(m.target)}" alt="">`;
    else if (k === 'video') layer.innerHTML = `<video src="${QM.files.url(m.target)}" autoplay muted playsinline></video>`;
    else if (k === 'pdf') { const box = document.createElement('div'); box.className = 'qmbm-pdf'; layer.appendChild(box); try { await renderPdf(box, e.blob, { only: m.page || 1, width: innerWidth, height: innerHeight }); } catch (er) {} }
  }, 300);
}

/* ======================= Zweites Gerät: Verbindung per Code ======================= */
const CODE_KEY = 'qm-peer-code', ON_KEY = 'qm-peer-on';
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ALPH[b % ALPH.length]).join('');
const peerOpts = { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] } };
try { Object.assign(peerOpts, JSON.parse(localStorage.getItem('qm-peer-server') || '{}')); } catch (e) {}
const H = { peer: null, conns: new Set(), code: null, status: 'aus', err: '' };
function hostStart() {
  if (H.peer && !H.peer.destroyed) return;
  if (!window.Peer) { H.status = 'fehler'; H.err = 'Verbindungsbaustein fehlt'; return; }
  let code = localStorage.getItem(CODE_KEY); if (!code) { code = newCode(); localStorage.setItem(CODE_KEY, code); }
  H.code = code; H.status = 'startet'; H.err = '';
  const p = new window.Peer('quizmaster-' + code, peerOpts); H.peer = p;
  p.on('open', () => { H.status = 'bereit'; refreshDialog(); });
  p.on('error', e => {
    if (e.type === 'unavailable-id') { localStorage.setItem(CODE_KEY, newCode()); p.destroy(); H.peer = null; setTimeout(hostStart, 300); return; }
    if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) { H.status = 'fehler'; H.err = 'Keine Internetverbindung zum Vermittlungsdienst'; refreshDialog(); setTimeout(() => { if (localStorage.getItem(ON_KEY) && (!H.peer || H.peer.disconnected)) { try { H.peer.reconnect(); } catch (er) {} } }, 4000); return; }
    H.err = e.message || String(e); refreshDialog();
  });
  p.on('disconnected', () => { if (!p.destroyed) setTimeout(() => { try { p.reconnect(); } catch (e) {} }, 2000); });
  p.on('connection', conn => {
    conn.on('open', () => { H.conns.add(conn); refreshDialog(); toast(`${conn.metadata && conn.metadata.beamer ? 'Beamer' : 'Zweites Gerät'} verbunden`); conn.send({ t: 'v', v: QM.version() }); });
    conn.on('data', async msg => {
      if (!msg || msg.t !== 'req') return;
      let body = msg.body;
      if (body && body.__blob) body = new Blob([body.data], { type: body.type || '' });
      const r = await QM.handle(msg.method, msg.path, new URLSearchParams(msg.search || ''), body).catch(e => ({ status: 500, json: { ok: false, msg: String(e) } }));
      try { conn.send({ t: 'res', id: msg.id, r }); } catch (e) {}
    });
    const gone = () => { if (H.conns.delete(conn)) { refreshDialog(); toast('Zweites Gerät getrennt'); } };
    conn.on('close', gone); conn.on('error', gone);
  });
}
function hostStop() { localStorage.removeItem(ON_KEY); if (H.peer) H.peer.destroy(); H.peer = null; H.conns.clear(); H.status = 'aus'; refreshDialog(); }
QM.onBump && QM.onBump(v => H.conns.forEach(c => { try { c.send({ t: 'v', v }); } catch (e) {} }));
const joinLink = beam => `${location.origin}${location.pathname}?join=${H.code}${beam ? '&beamer' : ''}`;
function qrSVG(text) {
  if (!window.qrcode) return '';
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
function dialogHTML(beam) {
  const on = H.status === 'bereit', n = H.conns.size;
  return `<div class="muted">Ein Handy, Tablet oder Laptop sieht den geöffneten Abend live und kann auswerten${beam ? ' oder als Beamer laufen' : ''}. Quizze bearbeiten geht nur hier. Beide Geräte brauchen Internet, die Daten gehen direkt von Gerät zu Gerät.</div>
   ${H.status === 'aus' ? '' : `<div class="qm-peer">
     <div class="qm-qr">${on ? qrSVG(joinLink(beam)) : '<div class="muted small">Verbindung wird aufgebaut …</div>'}</div>
     <div><div class="muted small">Code</div><div class="qm-code">${esc(H.code || '······')}</div>
       <div class="muted small" style="margin-top:8px">Mit der Kamera den QR-Code scannen oder diese Adresse öffnen:</div><div class="qm-link">${esc(on ? joinLink(beam) : '')}</div>
       <div class="small" style="margin-top:10px;color:${H.status === 'fehler' ? 'var(--bad)' : 'var(--ink2)'}">${H.status === 'fehler' ? esc(H.err) : on ? (n ? `${n} ${n === 1 ? 'Gerät' : 'Geräte'} verbunden` : 'Wartet auf ein Gerät') : ''}</div></div></div>`}`;
}
let dlgBeam = false;
function refreshDialog() { const b = $('#qmpeerbody'); if (b) b.innerHTML = dialogHTML(dlgBeam); const s = $('#qmpeerset'); if (s && QM.app) QM.app.render(); }
QM.peer = {
  code: () => (H.status === 'bereit' ? H.code : null),
  dialog(beam) {
    dlgBeam = !!beam;
    if (!QM.joinCode) { localStorage.setItem(ON_KEY, '1'); hostStart(); }
    sheet(beam ? 'Beamer über ein anderes Gerät' : 'Zweites Gerät verbinden', `<div id="qmpeerbody">${dialogHTML(beam)}</div>`,
      `${H.status !== 'aus' ? '<button class="btn" onclick="QM.peer.copy()">Adresse kopieren</button><button class="btn" onclick="QM.peer.stop()">Ausschalten</button>' : ''}<button class="btn pri" onclick="closeModals()">Fertig</button>`);
  },
  copy() { navigator.clipboard && navigator.clipboard.writeText(joinLink(dlgBeam)).then(() => toast('Adresse kopiert')); },
  stop() { hostStop(); closeModals(); toast('Zweites Gerät ausgeschaltet'); },
  status: () => H,
  // Auf dem zweiten Gerät
  join(code) {
    return new Promise((res, rej) => {
      const pend = new Map(), subs = new Set(); let v = 0, conn = null, tries = 0, first = true;
      const setMsg = t => { let b = $('#qmjoin'); if (!b) { b = document.createElement('div'); b.id = 'qmjoin'; document.body.appendChild(b); } b.textContent = t; b.classList.toggle('on', !!t); };
      const peer = new window.Peer(undefined, peerOpts);
      const connect = () => {
        conn = peer.connect('quizmaster-' + code, { reliable: true, metadata: { beamer: QM.isBeamer } });
        conn.on('open', () => {
          tries = 0; setMsg('');
          if (first) { first = false; QM.remote = remote; res(); }
          else { subs.forEach(f => f(++v)); }
        });
        conn.on('data', m => {
          if (!m) return;
          if (m.t === 'res') { const p = pend.get(m.id); if (p) { pend.delete(m.id); p(m.r); } }
          if (m.t === 'v') { v = m.v; subs.forEach(f => f(v)); }
        });
        conn.on('close', retry); conn.on('error', retry);
      };
      const retry = () => { setMsg('Verbindung zum Hauptgerät unterbrochen, verbinde neu …'); pend.forEach(p => p({ status: 503, json: { ok: false, msg: 'Keine Verbindung zum Hauptgerät' } })); pend.clear(); setTimeout(() => { if (++tries < 400) connect(); }, 1500); };
      peer.on('open', connect);
      peer.on('error', e => {
        if (e.type === 'peer-unavailable') { if (first) { setMsg(''); rej(new Error('Kein Gerät mit dem Code ' + code + ' gefunden. Ist „Zweites Gerät“ auf dem iPad eingeschaltet?')); } else retry(); return; }
        if (first) rej(new Error('Keine Verbindung: ' + (e.message || e.type)));
      });
      const remote = {
        request(method, path, search, body) {
          return new Promise(async ok => {
            const id = Math.random().toString(36).slice(2);
            if (body instanceof Blob) body = { __blob: 1, type: body.type, data: await body.arrayBuffer() };
            pend.set(id, ok);
            try { conn.send({ t: 'req', id, method, path, search, body }); } catch (e) { pend.delete(id); ok({ status: 503, json: { ok: false, msg: 'Keine Verbindung zum Hauptgerät' } }); }
            setTimeout(() => { if (pend.has(id)) { pend.delete(id); ok({ status: 504, json: { ok: false, msg: 'Das Hauptgerät antwortet nicht' } }); } }, 20000);
          });
        },
        on: f => subs.add(f), off: f => subs.delete(f), v: () => v,
      };
    });
  },
};

/* ======================= Einstellungen ======================= */
QM.ui = {
  bootError(e) {
    if (QM.joinCode) return esc((e && e.message) || 'Das Hauptgerät ist nicht erreichbar.') + '<div style="margin-top:14px"><button class="btn pri" onclick="location.reload()">Noch mal versuchen</button></div>';
    return 'Der Speicher dieses Geräts ist nicht erreichbar. In Safari: Einstellungen › Apps › Safari › Erweitert › Website-Daten prüfen, und nicht im privaten Modus öffnen.<div class="muted small" style="margin-top:10px">' + esc(e && e.message || '') + '</div>';
  },
  settingsDevice() {
    if (QM.joinCode) return `<div class="gt">Zweites Gerät</div><div class="group"><div class="gr"><div class="grow">Verbunden mit dem Hauptgerät<div class="muted small">Code ${esc(QM.joinCode)}. Quizze bearbeiten geht nur dort.</div></div></div></div>`;
    const h = QM.peer.status(), on = h.status === 'bereit';
    return `<div class="gt">Zweites Gerät</div><div class="group" id="qmpeerset"><div class="gr"><div class="grow">Handy, Tablet oder Laptop verbinden<div class="muted small">Sieht den geöffneten Abend live und kann auswerten oder als Beamer laufen. Quizze bearbeiten geht nur hier.${on ? ` Code: <b>${esc(h.code)}</b>, ${h.conns.size} verbunden.` : ''}</div></div><button class="btn" onclick="QM.peer.dialog()">${on ? 'Code zeigen' : 'Einschalten'}</button></div></div>`;
  },
  settingsData() {
    usageText().then(t => { const e = $('#qmusage'); if (e) e.innerHTML = t; });
    return `<div class="gr"><div class="grow">Speicher auf diesem Gerät<div class="muted small" id="qmusage">Alles wird sofort gespeichert, zusätzlich alle zwei Minuten als Sicherungskopie.</div></div></div>
     <div class="gr"><div class="grow">Gesamtsicherung<div class="muted small">Alle Quizze, Abende und Medien in einer Datei. Damit ziehst du auf ein neues Gerät um oder gibst alles weiter.</div></div><button class="btn" onclick="QM.ui.exportAll()">Sichern</button><label class="btn">Einspielen<input type="file" accept=".json,application/json" style="display:none" onchange="QM.ui.importAll(this.files[0]);this.value=''"></label></div>
     <div class="gr"><div class="grow">Papierkorb<div class="muted small">Gelöschte Quizze, Abende und ersetzte Dateien</div></div><button class="btn" onclick="QM.ui.dataSheet()">Öffnen</button></div>`;
  },
  settingsApp() {
    const how = QM.standalone ? '' : `<div class="gr"><div class="grow">Auf den Home-Bildschirm<div class="muted small">In Safari unten oder oben auf Teilen tippen, dann „Zum Home-Bildschirm“. QuizMaster öffnet sich dann als eigene App im Vollbild und behält seine Daten dauerhaft.</div></div></div>`;
    return `${how}<div class="gr"><div class="grow">Neu laden<div class="muted small">Holt eine neue Version, wenn es eine gibt. Daten bleiben.</div></div><button class="btn" onclick="QM.ui.update()">Neu laden</button></div>`;
  },
  settingsSpotify() {
    if (QM.joinCode) return '';
    const c = spCfg(), on = !!c.refresh;
    return `<div class="gt">Spotify</div><div class="group">
      <div class="gr"><div class="grow">${on ? 'Verbunden' : 'Vorschau-Modus'}<div class="muted small">${on ? `Songs starten in der Spotify-App an der eingestellten Stelle und stoppen nach der Dauer. Gerät: ${esc(c.deviceName || 'das gerade aktive')}.` : 'Spielt die 30-Sekunden-Vorschau. Für ganze Songs ab beliebiger Stelle Spotify verbinden (Premium nötig).'}</div></div>
        ${on ? `<button class="btn" onclick="QM.spotify.chooseDevice()">Gerät</button><button class="btn" onclick="QM.spotify.test()">Testen</button><button class="btn" onclick="QM.spotify.disconnect()">Trennen</button>` : `<button class="btn" onclick="QM.spotify.help()">Anleitung</button>`}</div>
      ${on ? '' : `<div class="gr"><div class="grow"><label class="fld" style="margin:0"><span>Client ID aus dem Spotify-Dashboard</span><input type="text" id="spcid" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="32 Zeichen" value="${esc(c.clientId || '')}"></label></div><button class="btn pri" onclick="QM.spotify.connect()">Verbinden</button></div>
      <div class="gr"><div class="grow muted small">Anmeldung in Safari erledigt?</div><button class="btn" onclick="QM.spotify.pasteKey()">Schlüssel einfügen</button></div>`}</div>`;
  },
  async exportAll() {
    toast('Sicherung wird erstellt …');
    const d = await QM.data.exportAll(true);
    const name = `QuizMaster-Gesamtsicherung-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
    QM.save(name, new Blob([JSON.stringify(d)], { type: 'application/json' }), true);
  },
  async importAll(f) {
    if (!f) return;
    let d; try { d = JSON.parse(await f.text()); } catch (e) { return toast('Die Datei ist keine gültige Sicherung'); }
    if (d && d.quiz && d.state && !d.kind) return window.restore(f);
    if (!d || d.kind !== 'gesamtsicherung') return toast('Das ist keine Gesamtsicherung von QuizMaster');
    const nq = new Set(Object.keys(d.kv || {}).filter(k => /^quizze\/[^/]+\/quiz\.json$/.test(k))).size, nf = Object.keys(d.files || {}).length;
    sheet('Gesamtsicherung einspielen', `<div class="muted">${nq} ${nq === 1 ? 'Quiz' : 'Quizze'} und ${nf} ${nf === 1 ? 'Datei' : 'Dateien'}, gesichert am ${new Date(d.at).toLocaleString('de-DE')}.</div>
      <div class="qm-choice"><button class="fct" id="imadd"><div><b>Dazunehmen</b><div class="muted small">Quizze und Dateien kommen dazu. Gleichnamige Dateien werden ersetzt, die alten landen im Papierkorb.</div></div></button>
      <button class="fct" id="imrep"><div><b>Alles ersetzen</b><div class="muted small">Dieses Gerät sieht danach genau so aus wie das gesicherte.</div></div></button></div>`, '<button class="btn" onclick="closeModals()">Abbrechen</button>');
    const go = async mode => { closeModals(); toast('Wird eingespielt …'); try { await QM.data.importAll(d, mode); await QM.app.load(); resetCaches(); QM.app.render(); toast('Sicherung eingespielt'); } catch (e) { toast(e.message); } };
    $('#imadd').onclick = () => go('merge'); $('#imrep').onclick = () => go('replace');
  },
  async dataSheet() {
    const items = await QM.data.trashList();
    const kinds = { datei: 'Datei', quiz: 'Quiz', abend: 'Abend' };
    sheet('Papierkorb', items.length ? `<div class="muted">Wiederherstellen holt den Eintrag an seinen Platz zurück.</div><div class="group qm-trash" style="margin-top:12px">${items.slice(0, 80).map(x => `<div class="gr"><div class="grow" style="min-width:0"><div class="ell">${esc(x.name)}</div><div class="muted small">${kinds[x.kind] || x.kind}, gelöscht ${new Date(x.at).toLocaleString('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${x.size ? ', ' + fsize(x.size) : ''}</div></div><button class="btn" onclick="QM.ui.restoreTrash('${esc(x.id)}')">Wiederherstellen</button></div>`).join('')}</div>`
      : '<div class="muted">Der Papierkorb ist leer.</div>',
      `${items.length ? '<button class="btn danger" onclick="QM.ui.emptyTrash()">Papierkorb leeren</button>' : ''}<button class="btn pri" onclick="closeModals()">Fertig</button>`);
  },
  async restoreTrash(id) { const m = await QM.data.trashRestore(id); resetCaches(); await QM.app.load(); QM.app.render(); toast(m); QM.ui.dataSheet(); },
  emptyTrash() { window.ask('Papierkorb leeren?', 'Alles darin wird endgültig gelöscht.', 'Leeren', async () => { await QM.data.trashEmpty(); toast('Papierkorb ist leer'); }, true); },
  async update() {
    try { const r = await navigator.serviceWorker.getRegistration(); if (r) await r.update(); } catch (e) {}
    await QM.flush(); location.reload();
  },
};
/* global ui, FILES, LIBR, BANK */
function resetCaches() { try { FILES = null; LIBR = null; BANK = null; } catch (e) {} }
async function usageText() {
  const u = await QM.data.usage(), p = await QM.data.persisted();
  const used = u && u.usage ? fsize(u.usage) : null;
  return `Alles wird sofort gespeichert, zusätzlich alle zwei Minuten als Sicherungskopie.${used ? ` Belegt: ${used}.` : ''} ${p || QM.standalone ? 'Dauerhaft gespeichert.' : '<b>Tipp:</b> Auf den Home-Bildschirm legen, sonst kann Safari die Daten nach Wochen ohne Nutzung löschen.'}`;
}

/* ======================= Touch und iPad-Komfort ======================= */
// iPad hochkant (744 bis 834 Punkte breit): etwas breiter rechnen, damit die Tablet- statt der Handy-Ansicht greift
const vpMeta = document.querySelector('meta[name=viewport]');
const VP_DEV = 'width=device-width, initial-scale=1, viewport-fit=cover';
function fitViewport() {
  if (!vpMeta || !QM.touch) return;
  const portraitW = Math.min(screen.width, screen.height), landscape = (screen.orientation && /landscape/.test(screen.orientation.type)) || Math.abs(window.orientation || 0) === 90;
  const fullW = landscape ? Math.max(screen.width, screen.height) : portraitW;
  // nur wenn das Fenster den ganzen Bildschirm nutzt (kein Split View)
  const want = !landscape && portraitW >= 700 && portraitW < 860 && Math.abs(document.documentElement.clientWidth - fullW) < 40 ? 'width=860, viewport-fit=cover' : VP_DEV;
  if (vpMeta.content !== want) vpMeta.content = want;
}
fitViewport();
addEventListener('orientationchange', () => { vpMeta && (vpMeta.content = VP_DEV); setTimeout(fitViewport, 350); });

// Wischen in der Live-Ansicht: nach links nächste Frage, nach rechts vorige
let sw = null;
document.addEventListener('touchstart', e => {
  if (e.touches.length !== 1 || QM.isBeamer) return;
  const t = e.target; if (!t.closest || !t.closest('.lv-grid') || t.closest('input,textarea,select,button,.lprog,.qmv,.modal,[contenteditable]')) return;
  const p = e.touches[0]; sw = { x: p.clientX, y: p.clientY, t: Date.now() };
}, { passive: true });
document.addEventListener('touchend', e => {
  if (!sw) return; const p = e.changedTouches[0], dx = p.clientX - sw.x, dy = p.clientY - sw.y, dt = Date.now() - sw.t; sw = null;
  if (dt > 600 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  if (typeof window.step === 'function' && typeof ui !== 'undefined' && ui.view === 'live' && ui.mode === 'event') { window.step(dx < 0 ? 1 : -1); swipeHint(dx < 0 ? 1 : -1); }
}, { passive: true });
function swipeHint(d) { const h = document.createElement('div'); h.className = 'qm-swipe ' + (d > 0 ? 'r' : 'l'); h.textContent = d > 0 ? 'Nächste Frage' : 'Vorige Frage'; document.body.appendChild(h); setTimeout(() => h.remove(), 700); }

// Bildschirm bleibt an, solange ein Abend läuft
let wake = null;
async function wakeCheck() {
  const S = QM.app && QM.app.S, st = S && S.run && S.run.status;
  const want = !document.hidden && (QM.isBeamer || st === 'live' || st === 'pause');
  try {
    if (want && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
    else if (!want && wake) { await wake.release(); wake = null; }
  } catch (e) {}
}
setInterval(wakeCheck, 4000); document.addEventListener('visibilitychange', wakeCheck);

// Hinweis auf den Home-Bildschirm (nur Safari auf iPad/iPhone, einmal ausblendbar)
function installHint() {
  if (QM.standalone || QM.isBeamer || QM.joinCode || !document.documentElement.classList.contains('qm-ios')) return;
  try { if (localStorage.getItem('qm-hint-home')) return; } catch (e) {}
  const b = document.createElement('div'); b.className = 'qm-home';
  b.innerHTML = `<span>${ic('share', 16)}</span><div class="grow"><b>Als App nutzen:</b> Teilen tippen, dann „Zum Home-Bildschirm“. Vollbild, und die Daten bleiben dauerhaft.</div><button class="btn plain small">Später</button>`;
  b.querySelector('button').onclick = () => { b.remove(); try { localStorage.setItem('qm-hint-home', '1'); } catch (e) {} };
  document.body.appendChild(b);
}

// Neue Version bereit
if ('serviceWorker' in navigator) {
  let had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('Neue Version geladen. Beim nächsten Öffnen aktiv.'); had = true; });
}
QM.storageError = e => toast('Speichern fehlgeschlagen: ' + ((e && e.message) || 'Speicher voll?'));

addEventListener('DOMContentLoaded', () => {
  const sp = new URLSearchParams(location.search);
  if (sp.get('state') && sp.get('state').startsWith('qm.')) QM.ready.then(() => setTimeout(() => QM.spotify.callback(sp), 300));
  if (QM.isBeamer) beamerMedia();
  else setTimeout(installHint, 1500);
  if (!QM.joinCode && !QM.isBeamer && localStorage.getItem(ON_KEY)) QM.ready.then(hostStart);
});
document.dispatchEvent(new Event('qm-peer-ready'));
})();
