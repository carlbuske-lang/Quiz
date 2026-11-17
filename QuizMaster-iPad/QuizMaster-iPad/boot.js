/* QuizMaster für iPad – Startschalter: Beamer-Fenster, zweites Gerät, Service Worker */
(function () {
  const QM = window.QM = window.QM || {};
  const sp = new URLSearchParams(location.search);
  QM.VER = '13.1';
  QM.isBeamer = sp.has('beamer') || /\/beamer$/.test(location.pathname);
  QM.joinCode = (sp.get('join') || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
  // Ein Beamer-Fenster auf demselben Gerät liest nur mit und schreibt nichts
  QM.passive = QM.isBeamer && !QM.joinCode;
  QM.standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  QM.touch = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 1;
  const h = document.documentElement;
  h.classList.add('qm-ipad');
  if (QM.touch) h.classList.add('qm-touch');
  if (QM.standalone) h.classList.add('qm-standalone');
  if (/iPad|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) h.classList.add('qm-ios');

  // Zweites Gerät: alles läuft über das Hauptgerät
  if (QM.joinCode) QM.remoteBoot = new Promise((res, rej) => {
    const start = () => QM.peer.join(QM.joinCode).then(res, rej);
    if (QM.peer) start(); else document.addEventListener('qm-peer-ready', start, { once: true });
  });

  // Offline-Speicher
  let swTest = false; try { swTest = !!localStorage.getItem('qm-sw-test'); } catch (e) {}
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || swTest)) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
