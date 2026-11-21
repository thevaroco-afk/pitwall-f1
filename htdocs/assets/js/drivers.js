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


// ---- charts.js ----
// =========================================================
// Gráficos de linhas em canvas: hover, zoom por arrasto, sincronização
// =========================================================

const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

function bisect(xs, x) {
  let lo = 0, hi = xs.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid; else hi = mid; }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

class ChartGroup {
  constructor() { this.charts = []; }
  add(c) { this.charts.push(c); c.group = this; }
  cursor(x, src) { for (const c of this.charts) if (c !== src) c.setCursor(x, false); }
  zoom(range, src) { for (const c of this.charts) if (c !== src) c.setXRange(range, false); }
  clear() { this.charts.forEach((c) => c.destroy()); this.charts = []; }
}

/**
 * series: [{ name, color, xs:[], ys:[], dash?, width?, hidden? }]
 * opts: { height, yLabel, xFormat, yFormat, yMin, yMax, invertY, step, xLabel, legend, tipTitle, onCursor, markers }
 */
class LineChart {
  constructor(el, series, opts = {}) {
    this.el = el;
    this.opts = { height: 260, pad: { l: 52, r: 16, t: 14, b: 28 }, legend: true, xFormat: (v) => v, yFormat: (v) => v, ...opts };
    this.series = series;
    this.xRange = null;
    this.cursorX = null;
    el.classList.add('chart');
    el.innerHTML = '';
    this.canvas = document.createElement('canvas');
    this.canvas.style.height = this.opts.height + 'px';
    this.canvas.style.touchAction = 'pan-y';
    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    el.append(this.canvas, this.tip);
    if (this.opts.legend && series.length > 1) {
      this.legendEl = document.createElement('div');
      this.legendEl.className = 'legend';
      el.append(this.legendEl);
      this.renderLegend();
    }
    this.ctx = this.canvas.getContext('2d');
    this.computeExtents();
    this.bind();
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(el);
  }

  destroy() { this.ro?.disconnect(); this.el.innerHTML = ''; }

  renderLegend() {
    this.legendEl.innerHTML = this.series.map((s, i) => `<span data-i="${i}" class="${s.hidden ? 'off' : ''}"><i style="background:${s.color}${s.dash ? ';background:repeating-linear-gradient(90deg,' + s.color + ' 0 4px,transparent 4px 6px)' : ''}"></i>${esc(s.name)}</span>`).join('');
    this.legendEl.onclick = (e) => {
      const sp = e.target.closest('span[data-i]');
      if (!sp) return;
      const s = this.series[+sp.dataset.i];
      s.hidden = !s.hidden;
      sp.classList.toggle('off', s.hidden);
      this.computeExtents(); this.draw();
    };
  }

  computeExtents() {
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const s of this.series) {
      if (s.hidden) continue;
      for (let i = 0; i < s.xs.length; i++) {
        const x = s.xs[i], y = s.ys[i];
        if (x == null || y == null || isNaN(y)) continue;
        if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      }
    }
    const [rx0, rx1] = this.xRange || [xmin, xmax];
    for (const s of this.series) {
      if (s.hidden) continue;
      for (let i = 0; i < s.xs.length; i++) {
        const x = s.xs[i], y = s.ys[i];
        if (y == null || isNaN(y) || x < rx0 || x > rx1) continue;
        if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      }
    }
    if (!isFinite(xmin)) { xmin = 0; xmax = 1; }
    if (!isFinite(ymin)) { ymin = 0; ymax = 1; }
    if (this.opts.yMin != null) ymin = this.opts.yMin;
    if (this.opts.yMax != null) ymax = this.opts.yMax;
    if (ymin === ymax) { ymin -= 1; ymax += 1; }
    const padY = this.opts.yMin != null && this.opts.yMax != null ? 0 : (ymax - ymin) * 0.06;
    this.full = [xmin, xmax];
    this.ext = { x0: rx0, x1: rx1, y0: this.opts.yMin ?? ymin - padY, y1: this.opts.yMax ?? ymax + padY };
  }

  setXRange(r, propagate = true) {
    this.xRange = r;
    this.computeExtents(); this.draw();
    if (propagate) this.group?.zoom(r, this);
  }
  setCursor(x, propagate = true) {
    this.cursorX = x;
    this.draw();
    if (x == null) this.tip.style.display = 'none';
    if (propagate) { this.group?.cursor(x, this); this.opts.onCursor?.(x); }
  }

  sx(x) { const { l, r } = this.opts.pad; return l + ((x - this.ext.x0) / (this.ext.x1 - this.ext.x0 || 1)) * (this.w - l - r); }
  sy(y) {
    const { t, b } = this.opts.pad;
    const f = (y - this.ext.y0) / (this.ext.y1 - this.ext.y0 || 1);
    return this.opts.invertY ? t + f * (this.h - t - b) : this.h - b - f * (this.h - t - b);
  }
  ix(px) { const { l, r } = this.opts.pad; return this.ext.x0 + ((px - l) / (this.w - l - r)) * (this.ext.x1 - this.ext.x0); }

  bind() {
    const c = this.canvas;
    let drag = null;
    const pos = (e) => { const r = c.getBoundingClientRect(); const p = e.touches ? e.touches[0] : e; return { x: p.clientX - r.left, y: p.clientY - r.top }; };
    c.addEventListener('mousemove', (e) => {
      const p = pos(e);
      if (drag) { drag.x1 = p.x; this.draw(); }
      this.setCursor(this.ix(p.x));
      this.showTip(p);
    });
    c.addEventListener('mouseleave', () => { this.setCursor(null); this.tip.style.display = 'none'; });
    c.addEventListener('mousedown', (e) => { if (this.opts.zoom === false) return; const p = pos(e); drag = { x0: p.x, x1: p.x }; this.drag = drag; });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      const a = Math.min(drag.x0, drag.x1), b = Math.max(drag.x0, drag.x1);
      this.drag = drag = null;
      if (b - a > 12) this.setXRange([this.ix(a), this.ix(b)]); else this.draw();
    });
    c.addEventListener('dblclick', () => this.setXRange(null));
    c.addEventListener('touchmove', (e) => { const p = pos(e); this.setCursor(this.ix(p.x)); this.showTip(p); }, { passive: true });
    c.addEventListener('touchstart', (e) => { const p = pos(e); this.setCursor(this.ix(p.x)); this.showTip(p); }, { passive: true });
  }

  valuesAt(x) {
    return this.series.filter((s) => !s.hidden && s.xs.length).map((s) => {
      const i = bisect(s.xs, x);
      return { s, i, y: s.ys[i], x: s.xs[i] };
    });
  }

  showTip(p) {
    if (this.cursorX == null) return;
    const vals = this.valuesAt(this.cursorX).filter((v) => v.y != null && !isNaN(v.y));
    if (!vals.length) { this.tip.style.display = 'none'; return; }
    if (this.opts.sortTip) vals.sort((a, b) => (this.opts.invertY ? a.y - b.y : b.y - a.y));
    const title = this.opts.tipTitle ? this.opts.tipTitle(this.cursorX, vals) : this.opts.xFormat(vals[0].x);
    this.tip.innerHTML = `<div class="tt">${esc(title)}</div>` + vals.slice(0, 12).map((v) => `<div class="rw"><span><i style="background:${v.s.color}"></i>${esc(v.s.name)}</span><b>${esc(this.opts.yFormat(v.y))}</b></div>`).join('') + (vals.length > 12 ? `<div class="muted">+${vals.length - 12}</div>` : '');
    this.tip.style.display = 'block';
    const tw = this.tip.offsetWidth;
    let left = p.x + 16;
    if (left + tw > this.w) left = p.x - tw - 16;
    this.tip.style.left = Math.max(0, left) + 'px';
    this.tip.style.top = Math.max(0, Math.min(p.y - 20, this.h - this.tip.offsetHeight)) + 'px';
  }

  draw() {
    const dpr = DPR();
    const w = this.canvas.clientWidth, h = this.opts.height;
    if (!w) return;
    this.w = w; this.h = h;
    if (this.canvas.width !== Math.round(w * dpr)) this.canvas.width = Math.round(w * dpr);
    if (this.canvas.height !== Math.round(h * dpr)) this.canvas.height = Math.round(h * dpr);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { l, r, t, b } = this.opts.pad;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textBaseline = 'middle';

    // grelha Y
    const yt = this.opts.yTicks || niceTicks(this.ext.y0, this.ext.y1, Math.max(2, Math.floor((h - t - b) / 45)));
    ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.fillStyle = '#7d7d92'; ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (const v of yt) {
      if (v < Math.min(this.ext.y0, this.ext.y1) || v > Math.max(this.ext.y0, this.ext.y1)) continue;
      const y = Math.round(this.sy(v)) + .5;
      ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(w - r, y); ctx.stroke();
      ctx.fillText(this.opts.yFormat(v), l - 8, y);
    }
    // grelha X
    const xt = this.opts.xTicks ? this.opts.xTicks(this.ext.x0, this.ext.x1) : niceTicks(this.ext.x0, this.ext.x1, Math.max(2, Math.floor((w - l - r) / 90)));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of xt) {
      if (v < this.ext.x0 || v > this.ext.x1) continue;
      const x = Math.round(this.sx(v)) + .5;
      ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, h - b); ctx.stroke();
      ctx.fillText(this.opts.xFormat(v), x, h - b + 7);
    }
    if (this.opts.yLabel) {
      ctx.save(); ctx.translate(11, t + (h - t - b) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#9a9ab0'; ctx.font = '600 11px "Titillium Web", sans-serif'; ctx.fillText(this.opts.yLabel.toUpperCase(), 0, 0); ctx.restore();
    }
    // zonas de fundo (ex.: SC)
    for (const band of this.opts.bands || []) {
      const x0 = Math.max(l, this.sx(band.from)), x1 = Math.min(w - r, this.sx(band.to));
      if (x1 <= x0) continue;
      ctx.fillStyle = band.color; ctx.fillRect(x0, t, x1 - x0, h - t - b);
      if (band.label) { ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '700 10px "Titillium Web"'; ctx.textAlign = 'left'; ctx.fillText(band.label, x0 + 3, t + 2); }
    }
    // séries
    ctx.save();
    ctx.beginPath(); ctx.rect(l, t - 2, w - l - r, h - t - b + 4); ctx.clip();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const s of this.series) {
      if (s.hidden || !s.xs.length) continue;
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.8; ctx.setLineDash(s.dash || []);
      ctx.globalAlpha = s.alpha ?? 1;
      ctx.beginPath();
      let pen = false, lastY = null;
      // reduzir pontos em zonas densas
      const i0 = Math.max(0, bisect(s.xs, this.ext.x0) - 1), i1 = Math.min(s.xs.length - 1, bisect(s.xs, this.ext.x1) + 1);
      for (let i = i0; i <= i1; i++) {
        const y = s.ys[i];
        if (y == null || isNaN(y)) { pen = false; continue; }
        const px = this.sx(s.xs[i]), py = this.sy(y);
        if (!pen) { ctx.moveTo(px, py); pen = true; }
        else if (this.opts.step) { ctx.lineTo(px, lastY); ctx.lineTo(px, py); }
        else ctx.lineTo(px, py);
        lastY = py;
      }
      ctx.stroke();
      if (s.dots) {
        ctx.fillStyle = s.color;
        for (let i = i0; i <= i1; i++) { const y = s.ys[i]; if (y == null || isNaN(y)) continue; ctx.beginPath(); ctx.arc(this.sx(s.xs[i]), this.sy(y), 2.4, 0, 7); ctx.fill(); }
      }
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.restore();
    // marcadores verticais (ex.: curvas)
    for (const m of this.opts.markers || []) {
      if (m.x < this.ext.x0 || m.x > this.ext.x1) continue;
      const x = this.sx(m.x);
      ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, h - b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#9a9ab0'; ctx.font = '700 10px "JetBrains Mono"'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(m.label, x, t);
    }
    // cursor
    if (this.cursorX != null && this.cursorX >= this.ext.x0 && this.cursorX <= this.ext.x1) {
      const x = this.sx(this.cursorX);
      ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, h - b); ctx.stroke();
      for (const v of this.valuesAt(this.cursorX)) {
        if (v.y == null || isNaN(v.y)) continue;
        ctx.fillStyle = v.s.color; ctx.beginPath(); ctx.arc(this.sx(v.x), this.sy(v.y), 3.5, 0, 7); ctx.fill();
      }
    }
    // selecção de zoom
    if (this.drag) {
      ctx.fillStyle = 'rgba(255,30,45,.12)';
      const a = Math.min(this.drag.x0, this.drag.x1), bb = Math.max(this.drag.x0, this.drag.x1);
      ctx.fillRect(a, t, bb - a, h - t - b);
    }
    // zero
    if (this.opts.zeroLine && this.ext.y0 < 0 && this.ext.y1 > 0) {
      const y = this.sy(0); ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(w - r, y); ctx.stroke();
    }
  }
}

// ---- drivers.js ----
// =========================================================
// PILOTOS — pesquisa, perfil de carreira e comparação
// =========================================================



const H = CONFIG.historyData;
const NOW_Y = new Date().getFullYear();
let ALL = null; // drivers.json (Kaggle) ou lista Jolpica

async function allDrivers() {
  if (ALL) return ALL;
  const k = await getLocal(`${H}/drivers.json`);
  if (k?.length) { ALL = { kaggle: true, list: k }; return ALL; }
  const list = await ergAll('drivers', 86400 * 7, 'DriverTable', 'Drivers');
  ALL = { kaggle: false, list: list.map((d) => ({ id: d.driverId, name: `${d.givenName} ${d.familyName}`, nat: d.nationality, dob: d.dateOfBirth, code: d.code, num: d.permanentNumber })) };
  return ALL;
}
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------- Perfil ----------
async function profile(id) {
  const [all, kd] = await Promise.all([getLocal(`${H}/drivers.json`), getLocal(`${H}/drivers/${id}.json`)]);
  const base = all?.find((d) => d.id === id);
  // dados recentes da Jolpica (a época actual pode não estar no Kaggle)
  const [info, stand, res] = await Promise.all([
    erg(`drivers/${id}`, {}, 86400 * 7).then((d) => d.DriverTable.Drivers[0]).catch(() => null),
    kd ? Promise.resolve(null) : ergAll(`drivers/${id}/driverStandings`, 86400, 'StandingsTable', 'StandingsLists').catch(() => []),
    kd ? Promise.resolve(null) : ergAll(`drivers/${id}/results`, 86400).catch(() => []),
  ]);
  if (!info && !base) throw new Error('Piloto não encontrado');
  const P = {
    id, name: base?.name || `${info.givenName} ${info.familyName}`, nat: base?.nat || info?.nationality, dob: base?.dob || info?.dateOfBirth,
    num: base?.num || info?.permanentNumber, code: base?.code || info?.code, url: info?.url, teams: base?.teams || [],
  };
  if (kd) {
    P.seasons = kd.seasons; P.wins = kd.wins; P.finishes = kd.finishes; P.dnf = kd.dnf;
    P.totals = { titles: base.titles, wins: base.wins, podiums: base.podiums, poles: base.poles, starts: base.starts, points: base.points, fl: base.fl };
    P.source = 'Kaggle';
  } else {
    const seasons = new Map();
    for (const s of stand) {
      const ds = s.DriverStandings[0];
      seasons.set(+s.season, { year: +s.season, team: ds.Constructors.map((c) => c.name).join(', '), teamId: ds.Constructors.at(-1)?.constructorId, pos: +ds.position || null, points: +ds.points, wins: +ds.wins, starts: 0, podiums: 0, poles: 0, best: null, dnf: 0 });
    }
    const finishes = {}; let dnf = 0; const wins = []; let poles = 0, podiums = 0, fl = 0;
    for (const r of res) {
      const x = r.Results[0];
      const y = +r.season;
      const s = seasons.get(y) || (seasons.set(y, { year: y, team: x.Constructor.name, teamId: x.Constructor.constructorId, pos: null, points: 0, wins: 0, starts: 0, podiums: 0, poles: 0, best: null, dnf: 0 }), seasons.get(y));
      s.starts++;
      const fin = /^\d+$/.test(x.positionText);
      const pos = +x.position;
      if (fin) { finishes[pos] = (finishes[pos] || 0) + 1; s.best = s.best ? Math.min(s.best, pos) : pos; }
      if (!/Finished|\+\d+ Laps?/.test(x.status)) { dnf++; s.dnf++; }
      if (pos <= 3 && fin) { podiums++; s.podiums++; }
      if (x.grid === '1') { poles++; s.poles++; }
      if (x.FastestLap?.rank === '1') fl++;
      if (pos === 1 && fin) wins.push({ year: y, round: +r.round, race: r.raceName, grid: +x.grid });
    }
    P.seasons = [...seasons.values()].sort((a, b) => a.year - b.year);
    P.finishes = finishes; P.dnf = dnf; P.wins = wins;
    P.totals = { titles: P.seasons.filter((s) => s.pos === 1 && s.year < NOW_Y).length, wins: wins.length, podiums, poles, starts: res.length, points: P.seasons.reduce((a, s) => a + (s.points || 0), 0), fl };
    P.source = 'Jolpica';
  }
  // época actual (se o Kaggle ainda não a tiver)
  if (kd && !P.seasons.some((s) => s.year === NOW_Y)) {
    try {
      const cur = await erg(`${NOW_Y}/drivers/${id}/driverStandings`, {}, 1800);
      const ds = cur.StandingsTable.StandingsLists[0]?.DriverStandings[0];
      if (ds) P.seasons.push({ year: NOW_Y, team: ds.Constructors.map((c) => c.name).join(', '), teamId: ds.Constructors.at(-1)?.constructorId, pos: +ds.position, points: +ds.points, wins: +ds.wins, live: true });
    } catch { /* */ }
  }
  P.teamId = P.seasons.at(-1)?.teamId;
  P.color = teamColor(P.teamId, P.seasons.at(-1)?.team);
  // fotografia (OpenF1, só pilotos recentes)
  if (P.seasons.at(-1)?.year >= 2023 && P.code) {
    try { const d = await getJSON(`${CONFIG.openf1}/drivers?session_key=latest&name_acronym=${P.code}`, { ttl: 86400 }); P.headshot = d[0]?.headshot_url; } catch { /* */ }
  }
  return P;
}

const age = (dob) => { if (!dob) return null; const d = new Date(dob); const n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n < new Date(n.getFullYear(), d.getMonth(), d.getDate())) a--; return a; };

const STAT_KEYS = [['titles', 'Títulos'], ['wins', 'Vitórias'], ['podiums', 'Pódios'], ['poles', 'Poles'], ['starts', 'GP'], ['points', 'Pontos']];
function statCards(P, V) {
  const show = (k, v) => (v == null ? '—' : k === 'points' ? fmt.pts(v) : v);
  if (!V) return STAT_KEYS.map(([k, l]) => `<div class="card"><div class="stat"><span class="v">${show(k, P.totals[k])}</span><span class="l">${l}</span></div></div>`).join('');
  // com comparação: valor de cada piloto numa ponta do mesmo quadrado
  const vc = V.color === P.color ? '#ffffff' : V.color;
  return STAT_KEYS.map(([k, l]) => {
    const a = P.totals[k] || 0, b = V.totals[k] || 0;
    const sa = String(show(k, P.totals[k])), sb = String(show(k, V.totals[k]));
    const fs = Math.max(sa.length, sb.length) >= 5 ? 'clamp(16px,1.7vw,22px)' : 'clamp(20px,2.4vw,30px)';
    return `<div class="card"><div class="stat"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
      <span class="v" style="font-size:${fs};color:${P.color}">${sa}</span>
      <span class="v" style="font-size:${fs};text-align:right;color:${vc}">${sb}</span>
    </div><span class="l" style="text-align:center">${l}</span></div></div>`;
  }).join('');
}

/** Cabeçalho de um piloto (side 'r' = espelhado, para o piloto comparado). */
function profileHead(P, side = 'l') {
  const initials = P.name.split(' ').map((w) => w[0]).slice(0, 2).join('');
  const r = side === 'r';
  const ss = P.seasons;
  const name = r ? `<a href="pilotos.html?id=${esc(P.id)}">${esc(P.name)}</a>` : esc(P.name);
  return `<div class="profile-head" style="${r ? 'flex-direction:row-reverse;text-align:right' : ''}">
        <div class="avatar" style="border:2px solid ${P.color}">${P.headshot ? `<img src="${esc(P.headshot)}" alt="">` : esc(P.num || initials)}</div>
        <div>
          <div class="muted" style="font-weight:700;letter-spacing:.1em;text-transform:uppercase;font-size:13px">${flagNat(P.nat)} ${esc(P.nat || '')}${P.num ? ` · #${esc(P.num)}` : ''}${P.code ? ` · ${esc(P.code)}` : ''}</div>
          <h2 style="font-size:clamp(28px,4vw,44px);font-weight:900;font-style:italic;text-transform:uppercase">${name}</h2>
          <div class="text-2">${P.dob ? `Nascido a ${esc(fmt.date(P.dob))} (${age(P.dob)} anos)` : ''} · ${ss[0]?.year}–${ss.at(-1)?.year}${P.url ? ` · <a href="${esc(P.url)}" target="_blank" rel="noopener" style="text-decoration:underline">Wikipedia</a>` : ''}</div>
        </div>
      </div>`;
}

async function renderProfile(id, vs) {
  const el = $('#view');
  el.innerHTML = `<div class="card">${skeleton(12)}</div>`;
  const [P, V] = await Promise.all([profile(id), vs ? profile(vs).catch(() => null) : null]);
  document.title = `${P.name} · ${CONFIG.siteName}`;
  const seasonsDone = P.seasons;
  const vc = V && V.color === P.color ? '#ffffff' : V?.color;
  el.innerHTML = `
    <div class="card" style="background:linear-gradient(115deg, ${P.color}33, transparent 55%)${V ? `, linear-gradient(245deg, ${vc}33, transparent 55%)` : ''}, var(--surface)">
      ${V ? `<div style="display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap">${profileHead(P)}<div style="margin-left:auto">${profileHead(V, 'r')}</div></div>` : profileHead(P)}
    </div>
    <div class="grid mt" style="grid-template-columns:repeat(auto-fit,minmax(${V ? 150 : 130}px,1fr))">${statCards(P, V)}</div>
    <div class="card mt">
      <div class="row-flex" style="justify-content:space-between"><div class="card-title" style="margin:0">Comparar com outro piloto</div>
      <div class="row-flex"><input class="input" id="vsInput" list="vsList" placeholder="Escreva um nome…" value="${V ? esc(V.name) : ''}" style="min-width:240px"><datalist id="vsList"></datalist>${V ? '<button class="btn small" id="vsClear">Limpar</button>' : ''}</div></div>
      ${V ? compareHtml(P, V) : ''}
    </div>
    <div class="grid g-2 mt">
      <div class="card"><div class="card-title">Posição no campeonato</div><div id="cPos"></div></div>
      <div class="card"><div class="card-title">Pontos por época <span class="right muted">sistemas de pontos variaram</span></div><div id="cPts"></div></div>
    </div>
    <div class="grid g-main mt">
      <div class="card flush"><div class="card-title" style="padding:16px 16px 0">Época a época</div><div class="table-wrap"><table class="t"><thead><tr><th>Ano</th><th>Equipa</th><th class="r">Pos</th><th class="r">Pts</th><th class="r">V</th><th class="r">Pód</th><th class="r">Poles</th><th class="r">GP</th></tr></thead><tbody>
        ${[...seasonsDone].reverse().map((s) => `<tr class="clickable" onclick="location.href='epoca.html?ano=${s.year}'"><td class="mono"><b>${s.year}</b></td><td><div class="driver-cell"><span class="team-bar" style="background:${teamColor(s.teamId, s.team)}"></span>${esc(s.team || '')}</div></td><td class="r mono ${s.pos <= 3 ? 'p' + s.pos : ''}">${s.pos ? 'P' + s.pos : '—'}${s.live ? ' <span class="chip red" style="font-size:10px">actual</span>' : ''}</td><td class="r mono">${fmt.pts(s.points)}</td><td class="r mono">${s.wins ?? '—'}</td><td class="r mono">${s.podiums ?? '—'}</td><td class="r mono">${s.poles ?? '—'}</td><td class="r mono">${s.starts ?? '—'}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div>
        <div class="card"><div class="card-title">Resultados finais <span class="right muted">${P.dnf} abandonos</span></div><div id="dist"></div></div>
        <div class="card mt-s"><div class="card-title">Vitórias (${P.wins.length})</div><div class="scroll-y" style="max-height:360px">${P.wins.length ? [...P.wins].reverse().map((w) => `<a class="row-flex" href="epoca.html?ano=${w.year}&ronda=${w.round}" style="padding:6px 0;border-bottom:1px solid var(--line-soft);font-size:14.5px"><span class="mono muted">${w.year}</span><span style="flex:1">${esc(w.race)}</span><span class="mono muted">P${w.grid} → P1</span></a>`).join('') : '<p class="muted">Ainda sem vitórias.</p>'}</div></div>
      </div>
    </div>
    <p class="muted mt" style="font-size:12.5px">Fonte: ${P.source === 'Kaggle' ? 'dataset Kaggle (+ Jolpica para a época actual)' : 'Jolpica/Ergast'}. Poles = largar do 1.º lugar.</p>`;

  const xs = seasonsDone.map((s) => s.year);
  const series = [{ name: P.name, color: P.color, xs, ys: seasonsDone.map((s) => s.pos), width: 2.4, dots: true }];
  if (V) series.push({ name: V.name, color: V.color === P.color ? '#ffffff' : V.color, xs: V.seasons.map((s) => s.year), ys: V.seasons.map((s) => s.pos), width: 2.4, dots: true, dash: [5, 4] });
  new LineChart($('#cPos'), series, { height: 240, invertY: true, yMin: 1, xFormat: (v) => Math.round(v), yFormat: (v) => `P${Math.round(v)}`, tipTitle: (x) => Math.round(x) });
  const ptsSeries = [{ name: P.name, color: P.color, xs, ys: seasonsDone.map((s) => s.points), width: 2.4, dots: true }];
  if (V) ptsSeries.push({ name: V.name, color: series[1].color, xs: V.seasons.map((s) => s.year), ys: V.seasons.map((s) => s.points), width: 2.4, dots: true, dash: [5, 4] });
  new LineChart($('#cPts'), ptsSeries, { height: 240, yMin: 0, xFormat: (v) => Math.round(v), yFormat: (v) => fmt.pts(v), tipTitle: (x) => Math.round(x) });

  const fin = Object.entries(P.finishes).map(([k, v]) => [+k, v]).filter(([k]) => k <= 20).sort((a, b) => a[0] - b[0]);
  const maxF = Math.max(1, ...fin.map(([, v]) => v), P.dnf);
  $('#dist').innerHTML = `<div style="display:flex;align-items:flex-end;gap:3px;height:150px">${[...fin, ['DNF', P.dnf]].map(([k, v]) => `<div title="${k === 'DNF' ? 'Abandonos' : 'P' + k}: ${v}" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;height:100%;justify-content:flex-end"><span class="mono" style="font-size:10px;color:var(--muted)">${v || ''}</span><i style="width:100%;height:${(v / maxF) * 100}%;min-height:${v ? 2 : 0}px;background:${k === 'DNF' ? 'var(--surface-3)' : k === 1 ? 'var(--yellow)' : k <= 3 ? P.color : P.color + '99'};border-radius:3px 3px 0 0"></i><span class="mono" style="font-size:10px">${k === 'DNF' ? '✕' : k}</span></div>`).join('')}</div>`;

  // comparação
  const all = await allDrivers().catch(() => null);
  if (all) $('#vsList').innerHTML = all.list.slice(0, 2000).map((d) => `<option value="${esc(d.name)}">`).join('');
  $('#vsInput').addEventListener('change', (e) => {
    const hit = all?.list.find((d) => norm(d.name) === norm(e.target.value));
    if (hit) { setQs({ vs: hit.id }); renderProfile(id, hit.id); }
  });
  $('#vsClear')?.addEventListener('click', () => { setQs({ vs: null }); renderProfile(id, null); });
}

function compareHtml(A, B) {
  const rows = [['Títulos', 'titles'], ['Vitórias', 'wins'], ['Pódios', 'podiums'], ['Poles', 'poles'], ['GP', 'starts'], ['Pontos', 'points']];
  const pct = (a, b) => (a + b ? (a / (a + b)) * 100 : 50);
  const ratios = [['% vitórias', (P) => (P.totals.starts ? (P.totals.wins / P.totals.starts) * 100 : 0)], ['% pódios', (P) => (P.totals.starts ? (P.totals.podiums / P.totals.starts) * 100 : 0)], ['% poles', (P) => (P.totals.starts ? (P.totals.poles / P.totals.starts) * 100 : 0)]];
  const bc = B.color === A.color ? '#ffffff' : B.color;
  const line = (lbl, a, b, f = (v) => fmt.pts(v)) => `<div style="display:grid;grid-template-columns:70px 1fr 70px;gap:10px;align-items:center;margin:7px 0"><b class="mono" style="text-align:right;${a > b ? `color:${A.color}` : ''}">${f(a)}</b><div><div class="muted" style="font-size:11.5px;text-align:center;font-weight:700;text-transform:uppercase;letter-spacing:.08em">${lbl}</div><div style="display:flex;height:8px;border-radius:5px;overflow:hidden;background:var(--surface-3)"><i style="width:${pct(a, b)}%;background:${A.color}"></i><i style="width:${100 - pct(a, b)}%;background:${bc}"></i></div></div><b class="mono" style="${b > a ? `color:${bc}` : ''}">${f(b)}</b></div>`;
  return `<div class="mt" style="max-width:720px;margin-left:auto;margin-right:auto">
    <div style="display:flex;justify-content:space-between;font-weight:900;font-size:18px"><span>${flagNat(A.nat)} ${esc(A.name)}</span><a href="pilotos.html?id=${esc(B.id)}">${esc(B.name)} ${flagNat(B.nat)}</a></div>
    ${rows.map(([l, k]) => line(l, A.totals[k] || 0, B.totals[k] || 0)).join('')}
    ${ratios.map(([l, f]) => line(l, f(A), f(B), (v) => v.toFixed(1) + '%')).join('')}
  </div>`;
}

// ---------- Lista ----------
async function renderList() {
  const el = $('#view');
  el.innerHTML = `<div class="card">${skeleton(10)}</div>`;
  // grelha actual em destaque
  let grid = [];
  try {
    const d = await erg('current/driverStandings', {}, 1800);
    grid = d.StandingsTable.StandingsLists[0]?.DriverStandings || [];
  } catch { /* */ }
  el.innerHTML = `
    ${grid.length ? `<div class="section-head"><h2>Grelha ${NOW_Y}</h2></div><div class="grid g-4 mb">${grid.map((x) => { const c = teamColor(x.Constructors.at(-1)?.constructorId); return `<a class="card hover" href="pilotos.html?id=${esc(x.Driver.driverId)}" style="border-left:4px solid ${c};padding:14px 16px"><div class="row-flex" style="justify-content:space-between"><span class="mono muted">P${x.position}</span><span class="mono" style="font-size:26px;font-weight:900;color:${c};opacity:.8">${esc(x.Driver.permanentNumber || '')}</span></div><div style="font-weight:600">${flagNat(x.Driver.nationality)} ${esc(x.Driver.givenName)}</div><div style="font-weight:900;font-size:20px;text-transform:uppercase;line-height:1">${esc(x.Driver.familyName)}</div><div class="muted" style="font-size:13px;margin-top:4px">${esc(x.Constructors.at(-1)?.name || '')} · ${fmt.pts(+x.points)} pts</div></a>`; }).join('')}</div>` : ''}
    <div class="section-head"><h2>Todos os pilotos</h2></div>
    <div class="row-flex mb"><input class="input" id="search" placeholder="Pesquisar por nome ou nacionalidade…" style="flex:1;min-width:220px"><select class="select" id="sort"></select></div>
    <div class="card flush"><div class="table-wrap" id="tbl">${skeleton(8)}</div></div>
    <div class="row-flex mt-s" style="justify-content:center"><button class="btn" id="more">Mostrar mais</button></div>`;
  const all = await allDrivers();
  const K = all.kaggle;
  $('#sort').innerHTML = K ? [['titles', 'Títulos'], ['wins', 'Vitórias'], ['podiums', 'Pódios'], ['poles', 'Poles'], ['starts', 'GP'], ['points', 'Pontos'], ['last', 'Mais recentes'], ['name', 'Nome']].map(([v, l]) => `<option value="${v}">Ordenar: ${l}</option>`).join('') : '<option value="name">Ordenar: Nome</option><option value="dob">Ordenar: Mais novos</option>';
  let shown = 60;
  const draw = () => {
    const qv = norm($('#search').value);
    const key = $('#sort').value;
    let L = all.list.filter((d) => !qv || norm(d.name).includes(qv) || norm(d.nat).includes(qv) || norm(d.code).includes(qv));
    L = [...L].sort((a, b) => (key === 'name' ? a.name.localeCompare(b.name) : key === 'dob' ? (b.dob || '').localeCompare(a.dob || '') : (b[key] || 0) - (a[key] || 0) || (b.wins || 0) - (a.wins || 0)));
    $('#more').classList.toggle('hidden', L.length <= shown);
    $('#tbl').innerHTML = `<table class="t"><thead><tr><th>Piloto</th>${K ? '<th class="r">Títulos</th><th class="r">Vitórias</th><th class="r">Pódios</th><th class="r">Poles</th><th class="r">GP</th><th class="r">Pontos</th><th class="r">Anos</th>' : '<th>Nascimento</th><th>Nº</th>'}</tr></thead><tbody>${L.slice(0, shown).map((d) => `<tr class="clickable" data-id="${esc(d.id)}"><td>${flagNat(d.nat)} <b>${esc(d.name)}</b> ${d.code ? `<span class="muted mono" style="font-size:12px">${esc(d.code)}</span>` : ''}</td>${K ? `<td class="r mono ${d.titles ? 'p1' : ''}">${d.titles || ''}</td><td class="r mono">${d.wins}</td><td class="r mono">${d.podiums}</td><td class="r mono">${d.poles}</td><td class="r mono">${d.starts}</td><td class="r mono">${fmt.pts(d.points)}</td><td class="r mono muted">${d.first}–${d.last}</td>` : `<td class="muted">${esc(fmt.date(d.dob))}</td><td class="mono">${esc(d.num || '')}</td>`}</tr>`).join('')}</tbody></table>${!K ? '<p class="muted" style="padding:12px 14px;font-size:13px">Instale os dados do Kaggle para ver estatísticas de carreira nesta tabela (ver README).</p>' : ''}`;
  };
  $('#search').addEventListener('input', () => { shown = 60; draw(); });
  $('#sort').addEventListener('change', draw);
  $('#more').addEventListener('click', () => { shown += 120; draw(); });
  $('#tbl').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) location.href = `pilotos.html?id=${tr.dataset.id}`; });
  draw();
}

init(async () => {
  $('#app').innerHTML = `<section class="page-hero container" id="hero"><h1>Pi<em>lotos</em></h1><p>Mais de 850 pilotos em 75 anos. Pesquise qualquer um, veja a carreira época a época e compare lendas de eras diferentes.</p></section><section class="section container" style="padding-top:16px"><div id="view"></div></section>`;
  const id = qs('id');
  if (id) {
    $('#hero').innerHTML = `<a class="link muted" href="pilotos.html">← Todos os pilotos</a>`;
    try { await renderProfile(id, qs('vs')); } catch (e) { $('#view').innerHTML = `<div class="card">${errorBox('Piloto não encontrado.', e.message)}</div>`; }
  } else {
    try { await renderList(); } catch (e) { $('#view').innerHTML = `<div class="card">${errorBox('Não foi possível carregar a lista de pilotos.', e.message)}</div>`; }
  }
});

})();
