/* gerado por tools/build_js.py — edite os ficheiros em src/ */
(() => {
'use strict';
// ---- config.js ----
// Configuração do site — altere à vontade.
const CONFIG = {
  siteName: 'PITWALL',
  // API em directo / sessões (gratuita para dados históricos, 2023+)
  openf1: 'https://api.openf1.org/v1',
  openf1Proxy: 'api/openf1', // proxy no próprio site (Cloudflare Pages Function)
  // Sucessor da Ergast: calendário, resultados e classificações 1950–hoje
  jolpica: 'https://api.jolpi.ca/ergast/f1',
  // Proxy de notícias (Cloudflare Pages Function) e alternativa pública
  newsProxy: 'api/news',
  rss2json: 'https://api.rss2json.com/v1/api.json?rss_url=',
  // Dados exportados pelos scripts Python (pasta data/)
  historyData: 'data/history',
  telemetryData: 'data/telemetry',
};

// Fontes de notícias (têm de existir também em functions/api/news.js)
const FEEDS = [
  { id: 'f1', name: 'Formula1.com', url: 'https://www.formula1.com/en/latest/all.xml' },
  { id: 'autosport', name: 'Autosport', url: 'https://www.autosport.com/rss/f1/news/' },
  { id: 'motorsport', name: 'Motorsport.com', url: 'https://www.motorsport.com/rss/f1/news/' },
  { id: 'therace', name: 'The Race', url: 'https://www.the-race.com/formula-1/feed/' },
  { id: 'racefans', name: 'RaceFans', url: 'https://www.racefans.net/feed/' },
  { id: 'bbc', name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml' },
];

// ---- core.js ----
// =========================================================
// PITWALL — núcleo partilhado: layout, fetch com cache, formatação
// =========================================================

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- Layout ----------
const NAV = [
  ['index.html', 'Início'],
  ['epoca.html', 'Época'],
  ['aovivo.html', 'Ao Vivo', true],
  ['telemetria.html', 'Telemetria'],
  ['historia.html', 'História'],
  ['pilotos.html', 'Pilotos'],
  ['circuitos.html', 'Circuitos'],
  ['noticias.html', 'Notícias'],
];

function mountLayout() {
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const header = document.createElement('header');
  header.className = 'site-header';
  header.innerHTML = `
    <div class="inner">
      <a class="logo" href="index.html" aria-label="${esc(CONFIG.siteName)} — início">
        <span class="logo-mark"><span></span><span></span><span></span></span>
        <span>${esc(CONFIG.siteName.slice(0, 3))}<b>${esc(CONFIG.siteName.slice(3))}</b></span>
      </a>
      <button class="menu-btn" aria-label="Menu"><span></span><span></span><span></span></button>
      <nav class="nav">
        ${NAV.map(([href, label, live]) => `<a href="${href}" class="${here === href ? 'active' : ''}">${live ? '<i class="live-dot" id="navLiveDot"></i>' : ''}${label}</a>`).join('')}
      </nav>
    </div>`;
  document.body.prepend(header);
  const nav = $('.nav', header);
  $('.menu-btn', header).addEventListener('click', () => nav.classList.toggle('open'));

  const footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML = `
    <div class="container inner">
      <div><b style="color:var(--text)">${esc(CONFIG.siteName)}</b> · feito por fãs, para fãs. Site não oficial, sem ligação à Formula 1, FIA ou equipas.</div>
      <div>Dados: <a href="https://openf1.org" target="_blank" rel="noopener">OpenF1</a> ·
        <a href="https://github.com/jolpica/jolpica-f1" target="_blank" rel="noopener">Jolpica/Ergast</a> ·
        <a href="https://docs.fastf1.dev" target="_blank" rel="noopener">FastF1</a> ·
        <a href="https://www.kaggle.com/datasets/rohanrao/formula-1-world-championship-1950-2020" target="_blank" rel="noopener">Kaggle</a></div>
    </div>`;
  document.body.append(footer);
  checkLiveDot();
}

async function checkLiveDot() {
  try {
    const s = await currentLiveSession();
    const dot = $('#navLiveDot');
    if (dot && s) { dot.classList.add('on'); dot.title = `${s.session_name} a decorrer`; }
  } catch { /* sem ligação: ignora */ }
}

/** Devolve a sessão OpenF1 a decorrer agora (com margem), ou null. */
async function currentLiveSession() {
  const now = Date.now();
  const year = new Date().getUTCFullYear();
  const sessions = await getJSON(`${CONFIG.openf1}/sessions?year=${year}`, { ttl: 3600 });
  return sessions.find((s) => parseT(s.date_start) - 15 * 60e3 <= now && now <= parseT(s.date_end) + 30 * 60e3) || null;
}

// ---------- Fetch com cache (memória + localStorage) ----------
const mem = new Map();
const inflight = new Map();
const LS_PREFIX = 'pw1:';
const LS_MAX = 400_000; // não guardar respostas muito grandes

function lsGet(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function lsSet(key, value) {
  try {
    const raw = JSON.stringify(value);
    if (raw.length > LS_MAX) return;
    localStorage.setItem(LS_PREFIX + key, raw);
  } catch {
    // quota cheia: limpa entradas antigas do site
    try { Object.keys(localStorage).filter((k) => k.startsWith(LS_PREFIX)).slice(0, 40).forEach((k) => localStorage.removeItem(k)); } catch { /* */ }
  }
}

// Limitador simples para o Jolpica (máx ~4 pedidos/s)
let jolpicaChain = Promise.resolve();
function throttleJolpica() {
  const p = jolpicaChain.then(() => sleep(280));
  jolpicaChain = p;
  return p;
}

// OpenF1: se o browser não conseguir ligar directamente (ex.: Safari), usa o proxy do site
let of1Proxy = (() => { try { return sessionStorage.getItem('pw-of1-proxy') === '1'; } catch { return false; } })();
function of1ProxyUrl(url) {
  const rest = url.slice(CONFIG.openf1.length + 1);
  const i = rest.indexOf('?');
  const ep = i < 0 ? rest : rest.slice(0, i);
  const q = i < 0 ? '' : rest.slice(i + 1);
  return `${CONFIG.openf1Proxy}?ep=${encodeURIComponent(ep)}&q=${encodeURIComponent(q)}`;
}
/** fetch() que, para a OpenF1, recorre ao proxy do próprio site em caso de falha de rede. */
async function smartFetch(url, opts) {
  if (!url.startsWith(CONFIG.openf1) || location.protocol === 'file:') return fetch(url, opts);
  if (!of1Proxy) {
    try { return await fetch(url, opts); }
    catch (e) { of1Proxy = true; try { sessionStorage.setItem('pw-of1-proxy', '1'); } catch { /* */ } console.warn('OpenF1 directa falhou; a usar proxy', e); }
  }
  return fetch(of1ProxyUrl(url), opts);
}

/**
 * GET JSON com cache. ttl em segundos (0 = sem cache).
 * stale: em caso de erro de rede, devolve cache expirada se existir.
 */
async function getJSON(url, { ttl = 300, retries = 2 } = {}) {
  const now = Date.now();
  const m = mem.get(url);
  if (ttl && m && m.exp > now) return m.data;
  if (ttl) {
    const l = lsGet(url);
    if (l && l.exp > now) { mem.set(url, l); return l.data; }
  }
  if (inflight.has(url)) return inflight.get(url);
  const job = (async () => {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        if (url.includes('jolpi.ca')) await throttleJolpica();
        const res = await smartFetch(url, { headers: { Accept: 'application/json' } });
        if (res.status === 429) { await sleep(1500 * (i + 1)); throw new Error('429'); }
        if (res.status === 404 && url.includes('openf1')) return [];
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (ttl) {
          const entry = { data, exp: now + ttl * 1000 };
          mem.set(url, entry);
          lsSet(url, entry);
        }
        return data;
      } catch (e) {
        lastErr = e;
        if (i < retries) await sleep(500 * (i + 1));
      }
    }
    const l = lsGet(url);
    if (l) return l.data; // cache expirada é melhor que nada
    throw lastErr;
  })();
  inflight.set(url, job);
  try { return await job; } finally { inflight.delete(url); }
}

/**
 * Carrega dados exportados (pasta data/). Devolve null se não existirem.
 * Os scripts Python gravam cada ficheiro em .json e também em .js, para o
 * site funcionar quando é aberto directamente do disco (file://), onde o
 * browser não deixa ler JSON.
 */
function loadDataScript(path) {
  const key = path.replace(/^\.?\//, '');
  window.__PW_DATA = window.__PW_DATA || {};
  if (key in window.__PW_DATA) return Promise.resolve(window.__PW_DATA[key]);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = key.replace(/\.json$/, '.js');
    s.onload = () => { resolve(window.__PW_DATA[key] ?? null); s.remove(); };
    s.onerror = () => { resolve(null); s.remove(); };
    document.head.append(s);
  });
}
async function getLocal(path) {
  if (location.protocol === 'file:') return loadDataScript(path);
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (res.ok && !(res.headers.get('content-type') || '').includes('text/html')) return await res.json();
  } catch { /* */ }
  return loadDataScript(path);
}

// ---------- Jolpica (Ergast) ----------
function ergUrl(path, params = {}) {
  const q = new URLSearchParams({ limit: 100, ...params });
  return `${CONFIG.jolpica}/${path.replace(/^\//, '')}.json?${q}`;
}
async function erg(path, params = {}, ttl = 600) {
  const d = await getJSON(ergUrl(path, params), { ttl });
  return d.MRData;
}
/** Pagina automaticamente; junta Races com o mesmo round. */
async function ergAll(path, ttl = 600, tableKey = 'RaceTable', listKey = 'Races') {
  const first = await erg(path, { limit: 100, offset: 0 }, ttl);
  const total = +first.total;
  const pages = [first];
  for (let off = 100; off < total; off += 100) pages.push(await erg(path, { limit: 100, offset: off }, ttl));
  const out = [];
  const byKey = new Map();
  for (const p of pages) {
    for (const item of p[tableKey]?.[listKey] || []) {
      const k = item.season + '-' + (item.round ?? item.driverId ?? item.constructorId ?? item.circuitId ?? JSON.stringify(item).slice(0, 40));
      if (listKey === 'Races' && byKey.has(k)) {
        const ex = byKey.get(k);
        for (const key of ['Results', 'SprintResults', 'QualifyingResults', 'Laps', 'PitStops']) if (item[key]) ex[key] = (ex[key] || []).concat(item[key]);
      } else { byKey.set(k, item); out.push(item); }
    }
  }
  return out;
}

// ---------- Tempo ----------
/** Converte data ISO (com microssegundos) para ms. */
function parseT(s) {
  if (s == null) return NaN;
  if (typeof s === 'number') return s;
  return Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1'));
}
function raceDate(r, key) {
  const o = key ? r[key] : r;
  if (!o?.date) return null;
  return new Date(`${o.date}T${o.time || '12:00:00Z'}`);
}
const LOCALE = 'pt-PT';
const fmt = {
  date: (d, o = { day: 'numeric', month: 'short', year: 'numeric' }) => (d ? new Date(d).toLocaleDateString(LOCALE, o) : '—'),
  dayMonth: (d) => (d ? new Date(d).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }) : '—'),
  weekday: (d) => new Date(d).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' }),
  time: (d) => (d ? new Date(d).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) : '—'),
  clock: (ms) => new Date(ms).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  rel: (d) => {
    const s = (Date.now() - new Date(d)) / 1000;
    if (isNaN(s)) return '';
    if (s < 60) return 'agora mesmo';
    if (s < 3600) return `há ${Math.round(s / 60)} min`;
    if (s < 86400) return `há ${Math.round(s / 3600)} h`;
    if (s < 86400 * 7) return `há ${Math.round(s / 86400)} dias`;
    return fmt.date(d);
  },
  /** segundos -> 1:23.456 */
  lap: (sec) => {
    if (sec == null || isNaN(sec) || sec <= 0) return '—';
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3);
  },
  gap: (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return `+${v.toFixed(3)}`;
  },
  num: (n, d = 0) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d })),
  pts: (n) => (n == null ? '—' : (Math.round(n * 10) / 10).toLocaleString(LOCALE)),
};

// ---------- Bandeiras ----------
const NAT = {
  British: 'GB', English: 'GB', Scottish: 'GB', Welsh: 'GB', German: 'DE', 'East German': 'DE', 'West German': 'DE', Dutch: 'NL', Spanish: 'ES', French: 'FR', Monegasque: 'MC',
  Mexican: 'MX', Australian: 'AU', Canadian: 'CA', Finnish: 'FI', Danish: 'DK', Thai: 'TH', Japanese: 'JP', Chinese: 'CN', American: 'US',
  'American-Italian': 'US', Italian: 'IT', Brazilian: 'BR', Argentine: 'AR', Argentinian: 'AR', Austrian: 'AT', Belgian: 'BE', Swiss: 'CH', Swedish: 'SE', 'New Zealander': 'NZ',
  Polish: 'PL', Russian: 'RU', Venezuelan: 'VE', Colombian: 'CO', Portuguese: 'PT', Hungarian: 'HU', Irish: 'IE', Indian: 'IN', Indonesian: 'ID',
  Malaysian: 'MY', 'United States': 'US', 'Brazil': 'BR', 'South African': 'ZA', Czech: 'CZ', Chilean: 'CL', Uruguayan: 'UY', Rhodesian: 'ZW', Liechtensteiner: 'LI', Moroccan: 'MA', 'Argentine-Italian': 'AR',
  Estonian: 'EE', Israeli: 'IL', Emirati: 'AE', Saudi: 'SA', Qatari: 'QA', Bahraini: 'BH', Azerbaijani: 'AZ', Singaporean: 'SG', Korean: 'KR', Turkish: 'TR', Hong: 'HK',
};
const COUNTRY = {
  UK: 'GB', 'United Kingdom': 'GB', 'Great Britain': 'GB', USA: 'US', 'United States': 'US', 'United States of America': 'US', UAE: 'AE', 'Abu Dhabi': 'AE', 'United Arab Emirates': 'AE', Korea: 'KR', 'South Korea': 'KR',
  Russia: 'RU', Italy: 'IT', Monaco: 'MC', Spain: 'ES', Belgium: 'BE', Netherlands: 'NL', Austria: 'AT', Hungary: 'HU', Germany: 'DE', France: 'FR', Portugal: 'PT',
  Brazil: 'BR', Mexico: 'MX', Canada: 'CA', Japan: 'JP', China: 'CN', Singapore: 'SG', Australia: 'AU', Bahrain: 'BH', 'Saudi Arabia': 'SA', Qatar: 'QA', Azerbaijan: 'AZ',
  Argentina: 'AR', 'South Africa': 'ZA', Sweden: 'SE', Switzerland: 'CH', Morocco: 'MA', Malaysia: 'MY', Turkey: 'TR', India: 'IN', Vietnam: 'VN', Indonesia: 'ID',
  'Las Vegas': 'US', Miami: 'US', Emilia: 'IT', Imola: 'IT', Madrid: 'ES',
};
const ISO3 = { GBR: 'GB', NED: 'NL', ESP: 'ES', FRA: 'FR', MON: 'MC', MEX: 'MX', AUS: 'AU', CAN: 'CA', FIN: 'FI', DEN: 'DK', THA: 'TH', JPN: 'JP', CHN: 'CN', USA: 'US', ITA: 'IT', BRA: 'BR', ARG: 'AR', AUT: 'AT', BEL: 'BE', SUI: 'CH', NZL: 'NZ', GER: 'DE', DEU: 'DE', POL: 'PL', RUS: 'RU', POR: 'PT', PRT: 'PT', SWE: 'SE', IRL: 'IE', IND: 'IN', IDN: 'ID', ZAF: 'ZA', RSA: 'ZA', ISR: 'IL', EST: 'EE', CHE: 'CH', NLD: 'NL', DNK: 'DK', MCO: 'MC', UAE: 'AE', ARE: 'AE', KSA: 'SA', SAU: 'SA', BRN: 'BH', BHR: 'BH', QAT: 'QA', AZE: 'AZ', SGP: 'SG', HUN: 'HU', KOR: 'KR' };
/** Emoji de bandeira (para texto simples, ex.: <option>). */
function flagEmoji(code) {
  if (!code || code.length !== 2) return '🏁';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}
/** Bandeira em imagem (funciona também no Windows, que não mostra emojis de bandeira). */
function iso2Flag(code) {
  if (!code || code.length !== 2) return '<span class="flag-ico">🏁</span>';
  const c = code.toLowerCase();
  return `<img class="flag-ico" src="https://flagcdn.com/24x18/${c}.png" srcset="https://flagcdn.com/48x36/${c}.png 2x" width="24" height="18" alt="${c.toUpperCase()}" loading="lazy">`;
}
const natCode = (n) => NAT[n] || NAT[(n || '').split(' ')[0]];
const countryCode = (c) => COUNTRY[c] || (c?.length === 2 ? c : ISO3[c]);
const flagTextCountry = (c) => flagEmoji(countryCode(c));
const flagNat = (n) => iso2Flag(natCode(n));
const flagCountry = (c) => iso2Flag(countryCode(c));

// ---------- Cores de equipa ----------
const TEAM = {
  red_bull: '#3671C6', mercedes: '#27F4D2', ferrari: '#E8002D', mclaren: '#FF8000', aston_martin: '#229971', alpine: '#FF87BC',
  williams: '#64C4FF', rb: '#6692FF', alphatauri: '#5E8FAA', toro_rosso: '#469BFF', sauber: '#52E252', alfa: '#C92D4B', haas: '#B6BABD',
  kick_sauber: '#52E252', audi: '#F50537', cadillac: '#C9A86A', racing_point: '#F596C8', force_india: '#F596C8', renault: '#FFF500', lotus_f1: '#FFB800',
  manor: '#ED1C24', marussia: '#6E0000', caterham: '#005030', hrt: '#B2945E', virgin: '#C82E37', brawn: '#B8FD6E', toyota: '#E10600', bmw_sauber: '#6CD3BF',
  honda: '#FFFFFF', super_aguri: '#C00000', spyker: '#FF6600', midland: '#E10600', jordan: '#F7DF00', minardi: '#191919', jaguar: '#0A5F37', bar: '#E8E8E8',
  prost: '#0F23B4', arrows: '#F68B1F', stewart: '#FFFFFF', benetton: '#00A0DE', tyrrell: '#0E2F6B', ligier: '#0055A5', brabham: '#00704A', lotus: '#FFD700',
  team_lotus: '#FFD700', march: '#FF6B00', cooper: '#004225', vanwall: '#004225', maserati: '#B8002E', alfa_romeo: '#900000', matra: '#0055A5', mclaren_ford: '#FF8000',
};
function teamColor(id, fallbackName = '') {
  if (!id && !fallbackName) return '#888';
  const k = String(id || '').toLowerCase();
  if (TEAM[k]) return TEAM[k];
  const n = (fallbackName || k).toLowerCase();
  for (const [key, c] of Object.entries(TEAM)) if (n.includes(key.replace('_', ' ')) || n.includes(key)) return c;
  if (n.includes('red bull') && !n.includes('racing bulls')) return TEAM.red_bull;
  if (n.includes('racing bulls') || n.includes('visa')) return TEAM.rb;
  if (n.includes('aston')) return TEAM.aston_martin;
  if (n.includes('stake') || n.includes('kick')) return TEAM.kick_sauber;
  // cor estável a partir do nome
  let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 60% 55%)`;
}
const hex = (c) => (c ? (c.startsWith('#') ? c : `#${c}`) : '#888');

// ---------- UI helpers ----------
function skeleton(lines = 5) {
  return Array.from({ length: lines }, (_, i) => `<div class="skeleton sk-line" style="width:${70 + ((i * 37) % 30)}%"></div>`).join('');
}
function errorBox(msg = 'Não foi possível carregar os dados.', detail = '') {
  return `<div class="empty"><h3>Ups… sem dados</h3><p>${esc(msg)}</p>${detail ? `<p class="muted" style="font-size:13px;margin-top:6px">${esc(detail)}</p>` : ''}</div>`;
}
function openModal(title, sub, bodyHtml) {
  const m = document.createElement('div');
  m.className = 'modal fade-in';
  m.innerHTML = `<div class="box"><div class="hd"><div><h2 style="font-size:26px;font-weight:900">${title}</h2>${sub ? `<div class="text-2 mt-s">${sub}</div>` : ''}</div><button class="close" aria-label="Fechar">×</button></div><div class="bd">${bodyHtml}</div></div>`;
  const close = () => { m.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('.close')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(m);
  document.body.style.overflow = 'hidden';
  return { el: $('.bd', m), close };
}
function tabs(container, onChange) {
  container.addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    $$('.tab', container).forEach((t) => t.classList.toggle('active', t === b));
    onChange(b.dataset.tab);
  });
}
function qs(name, def = null) { return new URLSearchParams(location.search).get(name) ?? def; }
function setQs(obj) {
  const u = new URL(location.href);
  for (const [k, v] of Object.entries(obj)) (v == null || v === '') ? u.searchParams.delete(k) : u.searchParams.set(k, v);
  history.replaceState(null, '', u);
}

/** Pontos de séries a partir de lista de corridas Ergast com Results e SprintResults. */
function cumulativePoints(races, sprints = [], by = 'driver') {
  const rounds = races.map((r) => +r.round).sort((a, b) => a - b);
  const sprintByRound = new Map(sprints.map((s) => [+s.round, s]));
  const series = new Map();
  const ensure = (id, name, color) => {
    if (!series.has(id)) series.set(id, { id, name, color, pts: new Map() });
    return series.get(id);
  };
  for (const r of races) {
    const rnd = +r.round;
    const add = (res) => {
      for (const x of res || []) {
        const id = by === 'driver' ? x.Driver.driverId : x.Constructor.constructorId;
        const name = by === 'driver' ? (x.Driver.code || x.Driver.familyName) : x.Constructor.name;
        const s = ensure(id, name, teamColor(x.Constructor.constructorId, x.Constructor.name));
        s.pts.set(rnd, (s.pts.get(rnd) || 0) + +x.points);
      }
    };
    add(r.Results);
    add(sprintByRound.get(rnd)?.SprintResults);
  }
  const out = [];
  for (const s of series.values()) {
    let acc = 0;
    const data = rounds.map((rd) => (acc += s.pts.get(rd) || 0));
    out.push({ id: s.id, name: s.name, color: s.color, data, total: acc });
  }
  out.sort((a, b) => b.total - a.total);
  return { rounds, series: out };
}

/** Distingue cores iguais (companheiros de equipa) com tracejado. */
function dashTeammates(series) {
  const seen = new Map();
  for (const s of series) {
    const n = seen.get(s.color) || 0;
    s.dash = n > 0 ? [6, 4] : null;
    seen.set(s.color, n + 1);
  }
  return series;
}

function init(fn) {
  mountLayout();
  const run = () => fn().catch((e) => console.error(e));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
}

// ---------- Fim-de-semana ----------
const SESS = [
  ['FirstPractice', 'Treinos Livres 1'], ['SecondPractice', 'Treinos Livres 2'], ['ThirdPractice', 'Treinos Livres 3'],
  ['SprintQualifying', 'Qualificação Sprint'], ['SprintShootout', 'Qualificação Sprint'], ['Sprint', 'Sprint'], ['Qualifying', 'Qualificação'],
];

function weekendSessions(r) {
  const list = SESS.filter(([k]) => r[k]).map(([k, n]) => ({ key: k, name: n, date: raceDate(r, k) }));
  list.push({ key: 'Race', name: 'Grande Prémio', date: raceDate(r) });
  return list.filter((s) => s.date).sort((a, b) => a.date - b.date);
}


// ---- circuits.js ----
// =========================================================
// CIRCUITOS — mapa-mundo (Leaflet) + história de cada circuito
// =========================================================


let map, markers = new Map(), list = [];

async function loadCircuits() {
  const [k, all, cur] = await Promise.all([
    getLocal(`${CONFIG.historyData}/circuits.json`),
    ergAll('circuits', 86400 * 7, 'CircuitTable', 'Circuits'),
    erg('current', {}, 3600).then((d) => d.RaceTable.Races).catch(() => []),
  ]);
  const kmap = new Map((k || []).map((c) => [c.id, c]));
  const curIds = new Map(cur.map((r) => [r.Circuit.circuitId, r]));
  return all.map((c) => {
    const kc = kmap.get(c.circuitId);
    return {
      id: c.circuitId, name: c.circuitName, loc: c.Location.locality, country: c.Location.country,
      lat: +c.Location.lat, lng: +c.Location.long, url: c.url,
      races: kc?.races, first: kc?.first, last: kc?.last, topWinners: kc?.topWinners,
      current: curIds.get(c.circuitId) || null,
    };
  }).sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || a.name.localeCompare(b.name));
}

// Mapa simples (sem Leaflet): projecção equirectangular com grelha
function simpleMap(cs) {
  const el = $('#map');
  const W = 1000, H = 500;
  const px = (lng) => ((lng + 180) / 360) * W, py = (lat) => ((90 - lat) / 180) * H;
  let grid = '';
  for (let lng = -180; lng <= 180; lng += 30) grid += `<line x1="${px(lng)}" y1="0" x2="${px(lng)}" y2="${H}"/>`;
  for (let lat = -60; lat <= 60; lat += 30) grid += `<line x1="0" y1="${py(lat)}" x2="${W}" y2="${py(lat)}"/>`;
  el.style.height = 'auto';
  el.innerHTML = `<svg viewBox="0 40 ${W} ${H - 120}" style="width:100%;display:block">
    <g stroke="rgba(255,255,255,.06)" stroke-width="1">${grid}</g>
    <line x1="0" y1="${py(0)}" x2="${W}" y2="${py(0)}" stroke="rgba(255,255,255,.15)"/>
    ${cs.map((c) => `<circle data-id="${esc(c.id)}" cx="${px(c.lng).toFixed(1)}" cy="${py(c.lat).toFixed(1)}" r="${c.current ? 6 : 4}" fill="${c.current ? '#ff1e2d' : '#666'}" stroke="#fff" stroke-width="${c.current ? 1.5 : .8}" style="cursor:pointer"><title>${esc(c.name)} — ${esc(c.country)}</title></circle>`).join('')}
  </svg><p class="muted" style="font-size:12.5px;padding:8px 12px">Mapa simplificado (o mapa interactivo não carregou: verifique a internet ou bloqueadores de anúncios).</p>`;
  el.onclick = (e) => { const d = e.target.closest('circle[data-id]'); if (d) showCircuit(cs.find((c) => c.id === d.dataset.id)); };
}

async function showCircuit(c) {
  setQs({ c: c.id });
  $$('.circuit-list .it').forEach((x) => x.classList.toggle('active', x.dataset.id === c.id));
  const m = markers.get(c.id);
  if (m) { map.flyTo([c.lat, c.lng], 6, { duration: .8 }); m.openPopup(); }
  const el = $('#detail');
  el.innerHTML = `<div class="card">${skeleton(8)}</div>`;
  let winners = [];
  try { winners = await ergAll(`circuits/${c.id}/results/1`, 86400); } catch { /* */ }
  const byD = new Map(), byT = new Map();
  for (const r of winners) { const x = r.Results[0]; const k = `${x.Driver.givenName} ${x.Driver.familyName}`; byD.set(k, { n: (byD.get(k)?.n || 0) + 1, id: x.Driver.driverId, nat: x.Driver.nationality }); byT.set(x.Constructor.name, { n: (byT.get(x.Constructor.name)?.n || 0) + 1, id: x.Constructor.constructorId }); }
  const topD = [...byD.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6);
  const topT = [...byT.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 6);
  const poleWins = winners.filter((r) => r.Results[0].grid === '1').length;
  const avgGrid = winners.length ? winners.reduce((a, r) => a + (+r.Results[0].grid || 0), 0) / winners.length : 0;
  const nr = c.current;
  el.innerHTML = `<div class="card fade-in">
    <div class="row-flex" style="justify-content:space-between;align-items:start">
      <div><div class="muted" style="font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:13px">${flagCountry(c.country)} ${esc(c.loc)}, ${esc(c.country)}</div><h2 style="font-size:28px;font-weight:900">${esc(c.name)}</h2></div>
      ${nr ? `<a class="chip red" href="epoca.html?ronda=${nr.round}">No calendário · Ronda ${nr.round} · ${esc(fmt.date(nr.date))}</a>` : '<span class="chip">Fora do calendário actual</span>'}
    </div>
    <div class="grid g-4 mt">${[[winners.length || c.races || '—', 'Grandes Prémios'], [winners[0]?.season || c.first || '—', 'Primeiro GP'], [winners.at(-1)?.season || c.last || '—', 'Último GP'], [winners.length ? Math.round((poleWins / winners.length) * 100) + '%' : '—', 'Vitórias da pole']].map(([v, l]) => `<div class="stat"><span class="v" style="font-size:28px">${v}</span><span class="l">${l}</span></div>`).join('')}</div>
    <div class="grid g-2 mt">
      <div><div class="card-title">Mais vitórias · pilotos</div><ol class="record-list">${topD.map(([n, v], i) => `<li><span class="mono muted">${i + 1}</span><a href="pilotos.html?id=${esc(v.id)}">${flagNat(v.nat)} ${esc(n)}</a><span class="n">${v.n}</span></li>`).join('') || '<li class="muted">—</li>'}</ol></div>
      <div><div class="card-title">Mais vitórias · equipas</div><ol class="record-list">${topT.map(([n, v], i) => `<li><span class="mono muted">${i + 1}</span><span><span class="team-bar" style="display:inline-block;height:12px;vertical-align:middle;background:${teamColor(v.id, n)}"></span> ${esc(n)}</span><span class="n">${v.n}</span></li>`).join('') || '<li class="muted">—</li>'}</ol></div>
    </div>
    ${winners.length ? `<div class="card-title mt">Todos os vencedores <span class="right muted">grelha média do vencedor: P${avgGrid.toFixed(1)}</span></div>
      <div class="table-wrap scroll-y" style="max-height:340px"><table class="t"><thead><tr><th>Ano</th><th>Vencedor</th><th>Equipa</th><th class="r">Grelha</th></tr></thead><tbody>${[...winners].reverse().map((r) => { const x = r.Results[0]; return `<tr class="clickable" onclick="location.href='epoca.html?ano=${r.season}&ronda=${r.round}'"><td class="mono"><b>${r.season}</b></td><td>${flagNat(x.Driver.nationality)} ${esc(x.Driver.givenName)} <b>${esc(x.Driver.familyName)}</b></td><td><span class="team-bar" style="display:inline-block;height:12px;vertical-align:middle;background:${teamColor(x.Constructor.constructorId, x.Constructor.name)}"></span> ${esc(x.Constructor.name)}</td><td class="r mono">P${x.grid}</td></tr>`; }).join('')}</tbody></table></div>` : ''}
    ${c.url ? `<p class="mt-s"><a class="link muted" href="${esc(c.url)}" target="_blank" rel="noopener" style="text-decoration:underline">Mais na Wikipedia →</a></p>` : ''}
  </div>`;
}

init(async () => {
  $('#app').innerHTML = `
    <section class="page-hero container"><h1>Cir<em>cuitos</em></h1><p>Todos os circuitos que já receberam um Grande Prémio de F1. Os pontos vermelhos estão no calendário desta época.</p></section>
    <section class="section container" style="padding-top:16px">
      <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(260px,1fr)" id="mapGrid">
        <div id="map"></div>
        <div class="card flush"><div style="padding:12px"><input class="input" id="cSearch" placeholder="Pesquisar circuito ou país…" style="width:100%"></div><div class="circuit-list" id="cList" style="padding:0 8px 8px">${skeleton(10)}</div></div>
      </div>
      <div id="detail" class="mt"></div>
    </section>`;
  const mq = matchMedia('(max-width: 900px)');
  const lay = () => { $('#mapGrid').style.gridTemplateColumns = mq.matches ? '1fr' : 'minmax(0,2fr) minmax(260px,1fr)'; $('#map').style.height = mq.matches ? '380px' : '560px'; };
  lay(); mq.addEventListener('change', lay);

  if (window.L) {
    map = L.map('map', { worldCopyJump: true, zoomControl: true }).setView([30, 10], 2);
    // mapa-mundo próprio (Natural Earth, ficheiro local): não depende de serviços de mosaicos nem de chaves de API
    map.getContainer().style.background = '#0b0d14';
    map.attributionControl.addAttribution('Natural Earth');
    getLocal('data/world.json').then((w) => {
      if (!w) return;
      const renderer = L.canvas({ padding: 0.5 });
      L.geoJSON(w.land, { interactive: false, renderer, style: { stroke: false, fillColor: '#1f2230', fillOpacity: 1 } }).addTo(map);
      L.geoJSON(w.borders, { interactive: false, renderer, style: { color: '#3a3e52', weight: 0.7, fill: false } }).addTo(map);
    }).catch(() => { /* sem mapa de fundo: os marcadores continuam a aparecer */ });
  }
  try { list = await loadCircuits(); } catch (e) { $('#cList').innerHTML = errorBox('Sem dados de circuitos.', e.message); return; }
  if (!map) simpleMap(list);
  for (const c of list) {
    if (!map) break;
    const icon = L.divIcon({ className: '', html: `<div class="circuit-marker ${c.current ? '' : 'old'}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });
    const m = L.marker([c.lat, c.lng], { icon, zIndexOffset: c.current ? 1000 : 0 }).addTo(map).bindPopup(`<b>${esc(c.name)}</b><br>${flagCountry(c.country)} ${esc(c.loc)}, ${esc(c.country)}`);
    m.on('click', () => showCircuit(c));
    markers.set(c.id, m);
  }
  const drawList = () => {
    const qv = $('#cSearch').value.toLowerCase();
    $('#cList').innerHTML = list.filter((c) => !qv || `${c.name} ${c.loc} ${c.country}`.toLowerCase().includes(qv)).map((c) => `<div class="it" data-id="${esc(c.id)}"><span>${flagCountry(c.country)} <b>${esc(c.name)}</b><br><small class="muted">${esc(c.loc)}, ${esc(c.country)}</small></span>${c.current ? `<span class="chip red">R${c.current.round}</span>` : c.races ? `<span class="mono muted" style="font-size:12px">${c.races} GP</span>` : ''}</div>`).join('');
  };
  drawList();
  $('#cSearch').addEventListener('input', drawList);
  $('#cList').addEventListener('click', (e) => { const it = e.target.closest('.it'); if (it) showCircuit(list.find((c) => c.id === it.dataset.id)); });
  const want = qs('c');
  const first = list.find((c) => c.id === want) || list.find((c) => c.current) || list[0];
  if (first) showCircuit(first);
});

})();
