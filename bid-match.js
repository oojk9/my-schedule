/* 나라장터 공고 조건 맞추기 — 앱(index.html)과 서비스워커(sw.js)가 같이 쓰는 파일
   공고 한 건(it)의 모양: { n:공고번호, o:차수, c:'물품'|'용역'|'공사'|'외자', t:공고명, i:공고기관, d:수요기관,
     p:게시 'YYYY-MM-DD HH:MM', e:입찰마감, g:개찰, b:배정예산(원), q:추정가격(원), k:공고종류, m:계약방법, w:입찰방식,
     u:상세 주소, r:참가 가능 지역, l:면허·업종 제한 }  (tools/fetch_bids.py가 만들어요) */
(function (root) {
  'use strict';
  const BID_CATS = ['물품', '용역', '공사', '외자'];
  /* "전기, 청소\n소방" → ['전기','청소','소방'] (쉼표·줄바꿈·세미콜론으로 나눔, 중복 제거) */
  function splitWords(s) {
    const out = [];
    for (const w of String(s || '').split(/[,\n;、]+/)) { const v = w.trim(); if (v && !out.includes(v)) out.push(v); }
    return out.slice(0, 50);
  }
  const fold = s => String(s || '').toLowerCase().replace(/\s+/g, '');
  const has = (hay, needle) => fold(hay).includes(fold(needle));
  const numOr0 = v => { const n = typeof v === 'number' ? v : parseInt(String(v || '').replace(/[^\d]/g, ''), 10); return isFinite(n) && n > 0 ? n : 0; };
  /* 저장된 조건을 안전한 모양으로 */
  function normFilters(f) {
    f = f && typeof f === 'object' ? f : {};
    const list = v => (Array.isArray(v) ? v : splitWords(v)).map(x => String(x).trim()).filter(Boolean).slice(0, 50);
    const cats = list(f.cats).filter(c => BID_CATS.includes(c));
    return {
      cats: cats.length ? cats : ['물품', '용역', '공사'],
      kw: list(f.kw), ex: list(f.ex), lic: list(f.lic), region: list(f.region), inst: list(f.inst),
      min: numOr0(f.min), max: numOr0(f.max)
    };
  }
  /* 조건이 하나라도 정해졌는지 (키워드·업종·기관 중 하나는 있어야 공고를 보여 줌 — 아니면 수천 건이 쏟아짐) */
  const hasFilters = f => f.kw.length + f.lic.length + f.inst.length > 0;
  function bidMatch(it, f) {
    if (!it || !f) return false;
    if (!f.cats.includes(it.c)) return false;
    if (has(it.k || '', '취소')) return false;                       /* 취소 공고는 제외 */
    const title = it.t || '';
    if (f.kw.length && !f.kw.some(w => has(title, w))) return false;
    if (f.ex.some(w => has(title, w))) return false;
    if (f.inst.length && !f.inst.some(w => has(it.i, w) || has(it.d, w))) return false;
    /* 지역 제한이 없는 공고(전국)는 통과, 있으면 내 지역이 들어 있어야 */
    if (f.region.length && it.r && !f.region.some(w => has(it.r, w))) return false;
    /* 업종·면허 제한이 없는 공고는 통과, 있으면 내 업종이 들어 있어야 */
    if (f.lic.length && it.l && !f.lic.some(w => has(it.l, w))) return false;
    const amt = numOr0(it.q) || numOr0(it.b);
    if (amt && f.min && amt < f.min) return false;
    if (amt && f.max && amt > f.max) return false;
    return true;
  }
  const bidKey = it => `${it.n}-${it.o || '00'}`;
  root.BidMatch = { BID_CATS, splitWords, normFilters, hasFilters, bidMatch, bidKey, fold };
})(typeof self !== 'undefined' ? self : this);
