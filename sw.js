/* 일정·근무 수첩 - 서비스워커
   역할 1: 앱 파일을 휴대폰에 보관해서 인터넷이 없어도 앱이 열리게 해 줍니다.
          인터넷이 되면 항상 최신 파일을 받아오고(그리고 보관), 안 되면 보관한 파일을 씁니다.
   역할 2: 미리 알림 — 앱이 꺼져 있어도 크롬이 하루 한두 번 이 파일을 깨우면(periodicsync),
          앱이 적어 둔 알림 목록(IndexedDB 'ilsu-remind')에서 오늘 울릴 것을 폰 알림으로 보여 줍니다.
   역할 3: 나라장터 새 공고 — 같은 때에 공고 파일(bids/*.json)을 읽어, 앱이 적어 둔 조건에 맞는
          새 공고가 있으면 "새 입찰 공고 N건" 알림을 보여 줍니다. (조건 맞추기는 bid-match.js 공용)
   ※ 기록은 여기가 아니라 '이 기기 저장소' 또는 'Firebase 계정'에 저장돼요.
   ※ 같은 주소(아이디.github.io)의 '내 자산관리' 앱 보관함은 건드리지 않아요. */
try { importScripts('./bid-match.js'); } catch (e) { /* 파일이 없으면 새 공고 알림만 빠지고, 나머지는 그대로 동작 */ }

const CACHE = 'ilsu-v1.6.0';
const LIB = 'ilsu-lib';   // 연동 기능(Firebase)·글꼴 파일 보관함 — 주소에 버전이 있어서 따로 오래 보관
const BIDS = 'ilsu-bids'; // 나라장터 공고 날짜 파일 보관함 — ?v=갱신시각이 같으면 그대로 씀, 오래된 날짜는 정리
const CORE = [
  './',
  './index.html',
  './config.js',
  './bid-match.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './badge-96.png',
];
const LIB_PREFIX = 'https://www.gstatic.com/firebasejs/';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const BIDS_KEEP_DAYS = 21;

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
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ilsu-') && k !== CACHE && k !== LIB && k !== BIDS).map((k) => caches.delete(k))))
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

/* 공고 날짜 파일(bids/2026-11-13.json?v=...): 같은 v면 보관한 것을, 아니면 받아서 보관 (오래된 날짜는 지움) */
const BID_DAY_RE = /\/bids\/(\d{4}-\d{2}-\d{2})\.json$/;
async function bidsFile(url) {
  const cache = await caches.open(BIDS);
  const hit = await cache.match(url);
  if (hit) return hit;
  const res = await fetch(url, { cache: 'no-cache' });
  if (res && res.ok) {
    cache.put(url, res.clone());
    pruneBids(cache).catch(() => null);
  }
  return res;
}
async function pruneBids(cache) {
  const keys = await cache.keys();
  const cut = dayNum(ymdLocal(new Date())) - BIDS_KEEP_DAYS;
  for (const k of keys) {
    const m = BID_DAY_RE.exec(new URL(k.url).pathname);
    if (!m || dayNum(m[1]) < cut) await cache.delete(k);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (BID_DAY_RE.test(url.pathname) && url.searchParams.has('v')) { event.respondWith(bidsFile(req.url)); return; }
    event.respondWith(appFile(req)); return;
  }
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
const nowStamp = () => { const d = new Date(); return `${ymdLocal(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

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
      body: x.sub || '', tag: x.g, icon: 'icon-192.png', badge: 'badge-96.png', lang: 'ko', data: { url: x.url || './' }
    });
  }
  for (const x of due) shown[x.k] = t;
  for (const [k, v] of Object.entries(shown)) if (typeof v !== 'string' || dayNum(t) - dayNum(v) > 400) delete shown[k];
  await kvSet('shown', shown);
  return list.length;
}

/* ================= 나라장터 새 공고 =================
   앱이 적어 둔 kv 'bids' = { on, filters, seen(앱에서 본 공고), acted(저장·숨김한 공고) }
   여기서 적는 kv 'bidsNotified' = 이미 알린 공고 (같은 공고를 두 번 알리지 않게) */
async function bidsCheck() {
  const cfg = await kvGet('bids');
  if (!cfg || !cfg.on || !cfg.filters || !self.BidMatch) return 0;
  if (self.Notification && self.Notification.permission !== 'granted') return 0;
  const BM = self.BidMatch, filters = BM.normFilters(cfg.filters);
  if (!BM.hasFilters(filters)) return 0;
  const idxRes = await fetch('./bids/index.json', { cache: 'no-cache' });
  if (!idxRes.ok) return 0;
  const idx = await idxRes.json();
  // 새 공고는 최근 날짜 파일에 들어오므로 최근 3일 치만 봄
  const days = Object.entries((idx && idx.days) || {}).filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 3);
  const notified = (await kvGet('bidsNotified')) || {};
  const seen = cfg.seen || {}, acted = new Set(Array.isArray(cfg.acted) ? cfg.acted : []);
  const t = ymdLocal(new Date()), now = nowStamp(), fresh = [], keys = new Set();
  for (const [d, m] of days) {
    let items = [];
    try {
      const res = await bidsFile(new URL(`./bids/${d}.json?v=${encodeURIComponent(String((m && m.v) || ''))}`, self.registration.scope).href);
      const j = res && res.ok ? await res.json() : null;
      items = j && Array.isArray(j.items) ? j.items : [];
    } catch (e) { items = []; }
    for (const it of items) {
      if (!it || !it.n) continue;
      const k = BM.bidKey(it);
      if (keys.has(k) || notified[k] || seen[k] || acted.has(k)) continue;
      if (it.e && it.e < now) continue;              // 이미 마감
      if (!BM.bidMatch(it, filters)) continue;
      keys.add(k); fresh.push(it);
    }
  }
  if (!fresh.length) return 0;
  const first = fresh[0];
  const title = fresh.length === 1 ? `새 입찰 공고 · ${first.t}` : `새 입찰 공고 ${fresh.length}건`;
  const body = fresh.length === 1
    ? [first.i, first.e ? `마감 ${first.e}` : ''].filter(Boolean).join(' · ')
    : fresh.slice(0, 3).map((x) => x.t).join(' · ') + (fresh.length > 3 ? ` 외 ${fresh.length - 3}건` : '');
  await self.registration.showNotification(title, {
    body, tag: 'ilsu-bids', icon: 'icon-192.png', badge: 'badge-96.png', lang: 'ko', renotify: true, data: { url: './#bid' }
  });
  for (const k of keys) notified[k] = t;
  for (const [k, v] of Object.entries(notified)) if (typeof v !== 'string' || dayNum(t) - dayNum(v) > 60) delete notified[k];
  await kvSet('bidsNotified', notified);
  return fresh.length;
}

// 크롬이 하루 한두 번 깨워 줄 때 (설치한 앱에서만)
self.addEventListener('periodicsync', (event) => {
  if (event.tag === REM_TAG) event.waitUntil(Promise.all([remCheck().catch(() => 0), bidsCheck().catch(() => 0)]));
});

// 앱이 "지금 확인해 줘" 하고 부탁할 때 (시험용)
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'remind-check') event.waitUntil(remCheck().catch(() => 0).then((n) => { if (event.source) event.source.postMessage({ type: 'remind-checked', n }); }));
  else if (event.data.type === 'bids-check') event.waitUntil(bidsCheck().catch(() => 0).then((n) => { if (event.source) event.source.postMessage({ type: 'bids-checked', n }); }));
});

// 알림을 누르면 앱을 열고 오늘 화면(또는 입찰 화면)으로
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  const toBid = url.indexOf('#bid') >= 0;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (mine) {
      try { mine.postMessage({ type: toBid ? 'open-bid' : 'open-today' }); } catch (e) { /* 무시 */ }
      return mine.focus();
    }
    return self.clients.openWindow(url);
  })());
});
