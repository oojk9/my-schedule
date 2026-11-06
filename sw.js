/* 일정·근무 수첩 - 서비스워커
   역할 1: 앱 파일을 휴대폰에 보관해서 인터넷이 없어도 앱이 열리게 해 줍니다.
          인터넷이 되면 항상 최신 파일을 받아오고(그리고 보관), 안 되면 보관한 파일을 씁니다.
   역할 2: 미리 알림 — 앱이 꺼져 있어도 크롬이 하루 한두 번 이 파일을 깨우면(periodicsync),
          앱이 적어 둔 알림 목록(IndexedDB 'ilsu-remind')에서 오늘 울릴 것을 폰 알림으로 보여 줍니다.
   ※ 기록은 여기가 아니라 '이 기기 저장소' 또는 'Firebase 계정'에 저장돼요.
   ※ 같은 주소(아이디.github.io)의 '내 자산관리' 앱 보관함은 건드리지 않아요. */
const CACHE = 'ilsu-v1.4.1';
const LIB = 'ilsu-lib'; // 연동 기능(Firebase)·글꼴 파일 보관함 — 주소에 버전이 있어서 따로 오래 보관
const CORE = [
  './',
  './index.html',
  './config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './badge-96.png',
];
const LIB_PREFIX = 'https://www.gstatic.com/firebasejs/';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(CORE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ilsu-') && k !== CACHE && k !== LIB).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

async function appFile(req) {
  const cache = await caches.open(CACHE);
  try {
    const net = req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req, { cache: 'no-cache' });
    const res = await Promise.race([net, timeout(4000)]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const shell = (await cache.match('./index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    throw err;
  }
}

async function libFile(req) {
  const cache = await caches.open(LIB);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) { event.respondWith(appFile(req)); return; }
  if (req.url.startsWith(LIB_PREFIX) || FONT_HOSTS.includes(url.hostname)) event.respondWith(libFile(req));
  // 그 밖의 요청(로그인·기록 저장)은 그대로 인터넷으로 보냅니다.
});

/* ================= 미리 알림 ================= */
const REM_TAG = 'ilsu-remind';
const REM_DB = 'ilsu-remind';

function kvDo(mode, fn) {
  return new Promise((resolve, reject) => {
    const q = indexedDB.open(REM_DB, 1);
    q.onupgradeneeded = () => q.result.createObjectStore('kv');
    q.onerror = () => reject(q.error);
    q.onsuccess = () => {
      const db = q.result, tx = db.transaction('kv', mode), out = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
const kvGet = (k) => kvDo('readonly', (s) => s.get(k));
const kvSet = (k, v) => kvDo('readwrite', (s) => { s.put(v, k); });

const pad = (n) => String(n).padStart(2, '0');
const ymdLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };

/* 오늘 울릴 알림(울릴 날이 지났고, 그 일정 날짜는 아직 안 지난 것)을 폰 알림으로 — 같은 알림은 한 번만 */
async function remCheck() {
  const sch = await kvGet('schedule');
  if (!sch || !sch.on || !Array.isArray(sch.items)) return 0;
  if (self.Notification && self.Notification.permission !== 'granted') return 0;
  const t = ymdLocal(new Date());
  const shown = (await kvGet('shown')) || {};
  const due = sch.items.filter((x) => x && x.k && x.fire <= t && x.occ >= t && !shown[x.k]);
  if (!due.length) return 0;
  // 같은 일정에 여러 알림이 밀려 있으면 가장 최근 것 하나만 (예: 3개월 전·D-7이 함께 밀렸으면 D-7만)
  const best = new Map();
  for (const x of due) { const b = best.get(x.g); if (!b || x.fire > b.fire) best.set(x.g, x); }
  const list = [...best.values()].sort((a, b) => (a.occ < b.occ ? -1 : a.occ > b.occ ? 1 : 0)).slice(0, 8);
  for (const x of list) {
    const n = dayNum(x.occ) - dayNum(t);
    const head = n === 0 ? '오늘' : n === 1 ? '내일' : `D-${n}`;
    await self.registration.showNotification(`${head} · ${x.title}`, {
      body: x.sub || '', tag: x.g, icon: 'icon-192.png', badge: 'badge-96.png', lang: 'ko', data: { url: './' }
    });
  }
  for (const x of due) shown[x.k] = t;
  for (const [k, v] of Object.entries(shown)) if (typeof v !== 'string' || dayNum(t) - dayNum(v) > 400) delete shown[k];
  await kvSet('shown', shown);
  return list.length;
}

// 크롬이 하루 한두 번 깨워 줄 때 (설치한 앱에서만)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === REM_TAG) event.waitUntil(remCheck().catch(() => 0));
});

// 앱이 "지금 확인해 줘" 하고 부탁할 때 (시험용)
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'remind-check') return;
  event.waitUntil(remCheck().catch(() => 0).then((n) => { if (event.source) event.source.postMessage({ type: 'remind-checked', n }); }));
});

// 알림을 누르면 앱을 열고 오늘 화면으로
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (mine) {
      try { mine.postMessage({ type: 'open-today' }); } catch (e) { /* 무시 */ }
      return mine.focus();
    }
    return self.clients.openWindow('./');
  })());
});
