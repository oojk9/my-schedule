/* 일정·근무 수첩 - 서비스워커
   역할: 앱 파일을 휴대폰에 보관해서 인터넷이 없어도 앱이 열리게 해 줍니다.
   방식: 인터넷이 되면 항상 최신 파일을 받아오고(그리고 보관), 안 되면 보관한 파일을 씁니다.
   ※ 기록은 여기가 아니라 '이 기기 저장소' 또는 'Firebase 계정'에 저장돼요.
   ※ 같은 주소(아이디.github.io)의 '내 자산관리' 앱 보관함은 건드리지 않아요. */
const CACHE = 'ilsu-v1.2.0';
const LIB = 'ilsu-lib'; // 연동 기능(Firebase)·글꼴 파일 보관함 — 주소에 버전이 있어서 따로 오래 보관
const CORE = [
  './',
  './index.html',
  './config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
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
