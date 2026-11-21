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

// ---- epoca.js ----


const NOW_Y = new Date().getFullYear();
let Y = +qs('ano', NOW_Y);
const cache = {};
const once = (k, fn) => (cache[k] ??= fn());

const data = {
  schedule: () => once('s' + Y, () => erg(`${Y}`, {}, 3600).then((d) => d.RaceTable.Races)),
  winners: () => once('w' + Y, () => ergAll(`${Y}/results/1`, Y < NOW_Y ? 86400 * 7 : 900)),
  results: () => once('r' + Y, () => ergAll(`${Y}/results`, Y < NOW_Y ? 86400 * 7 : 900)),
  sprints: () => once('sp' + Y, () => (Y >= 2021 ? ergAll(`${Y}/sprint`, Y < NOW_Y ? 86400 * 7 : 900) : Promise.resolve([]))),
  quali: () => once('q' + Y, () => (Y >= 1994 ? ergAll(`${Y}/qualifying`, Y < NOW_Y ? 86400 * 7 : 900) : Promise.resolve([]))),
  dStand: () => once('ds' + Y, () => erg(`${Y}/driverStandings`, {}, 900).then((d) => d.StandingsTable.StandingsLists[0]?.DriverStandings || [])),
  cStand: () => once('cs' + Y, () => (Y >= 1958 ? erg(`${Y}/constructorStandings`, {}, 900).then((d) => d.StandingsTable.StandingsLists[0]?.ConstructorStandings || []) : Promise.resolve([]))),
};

function driverCell(d, c, extra = '') {
  return `<div class="driver-cell"><span class="team-bar" style="background:${teamColor(c?.constructorId, c?.name)}"></span><span class="name">${flagNat(d.nationality)} ${esc(d.givenName)} <b>${esc(d.familyName)}</b><small>${esc(c?.name || '')}${extra}</small></span></div>`;
}

// ---------- Calendário ----------
async function renderCalendar(el) {
  const [races, winners] = await Promise.all([data.schedule(), data.winners().catch(() => [])]);
  const wmap = new Map(winners.map((r) => [r.round, r.Results[0]]));
  const now = Date.now();
  const nextR = races.find((r) => raceDate(r).getTime() + 3 * 3600e3 > now);
  el.innerHTML = `<div class="cal-grid">${races.map((r) => {
    const d = raceDate(r);
    const w = wmap.get(r.round);
    const done = !!w || d.getTime() < now - 3 * 3600e3;
    const fp1 = raceDate(r, 'FirstPractice');
    const sprint = r.Sprint ? '<span class="chip blue">Sprint</span>' : '';
    return `<div class="race-card ${done ? 'done' : ''} ${r === nextR ? 'next' : ''}" data-round="${r.round}">
      <div class="rnd"><span>Ronda ${r.round}</span>${r === nextR ? '<span class="chip red">Próxima</span>' : sprint}</div>
      <div class="flag">${flagCountry(r.Circuit.Location.country)}</div>
      <h3>${esc(r.raceName)}</h3>
      <div class="loc">${esc(r.Circuit.circuitName)}</div>
      <div class="dt">${fp1 ? esc(fmt.dayMonth(fp1)) + ' – ' : ''}${esc(fmt.date(d))}</div>
      ${w ? `<div class="win"><span class="team-bar" style="height:16px;background:${teamColor(w.Constructor.constructorId)}"></span>🏆 <b>${esc(w.Driver.givenName)} ${esc(w.Driver.familyName)}</b></div>` : ''}
    </div>`;
  }).join('')}</div>`;
  el.onclick = (e) => {
    const c = e.target.closest('.race-card');
    if (c) raceModal(races.find((r) => r.round === c.dataset.round));
  };
}

// ---------- Classificações ----------
async function renderDrivers(el) {
  const L = await data.dStand();
  if (!L.length) { el.innerHTML = errorBox('Sem classificação para esta época.'); return; }
  const leader = +L[0].points;
  el.innerHTML = `<div class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th>Pos</th><th>Piloto</th><th class="r">Vitórias</th><th class="r">Pontos</th><th class="r">Diferença</th></tr></thead><tbody>
    ${L.map((x) => `<tr class="clickable" data-id="${esc(x.Driver.driverId)}"><td class="pos ${+x.position <= 3 ? 'p' + x.position : ''}">${x.positionText}</td><td>${driverCell(x.Driver, x.Constructors.at(-1), x.Driver.permanentNumber ? ' · #' + x.Driver.permanentNumber : '')}</td><td class="r mono">${x.wins}</td><td class="r mono"><b>${fmt.pts(+x.points)}</b></td><td class="r mono muted">${x.position === '1' ? '—' : '-' + fmt.pts(leader - x.points)}</td></tr>`).join('')}
  </tbody></table></div></div>`;
  el.onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) location.href = `pilotos.html?id=${tr.dataset.id}`; };
}
async function renderConstructors(el) {
  const L = await data.cStand();
  if (!L.length) { el.innerHTML = errorBox('Não existia campeonato de construtores nesta época (começou em 1958).'); return; }
  const max = +L[0].points || 1;
  el.innerHTML = `<div class="card flush"><div class="table-wrap"><table class="t"><thead><tr><th>Pos</th><th>Equipa</th><th>Pontos</th><th class="r">Vitórias</th><th class="r">Pontos</th></tr></thead><tbody>
    ${L.map((x) => { const c = teamColor(x.Constructor.constructorId, x.Constructor.name); return `<tr><td class="pos ${+x.position <= 3 ? 'p' + x.position : ''}">${x.positionText}</td><td><div class="driver-cell"><span class="team-bar" style="background:${c}"></span><span class="name"><b>${esc(x.Constructor.name)}</b><small>${flagNat(x.Constructor.nationality)} ${esc(x.Constructor.nationality)}</small></span></div></td><td style="width:40%"><div class="bar-row" style="grid-template-columns:1fr"><span class="bar"><i style="width:${(x.points / max) * 100}%;background:${c}"></i></span></div></td><td class="r mono">${x.wins}</td><td class="r mono"><b>${fmt.pts(+x.points)}</b></td></tr>`; }).join('')}
  </tbody></table></div></div>`;
}

// ---------- Evolução ----------
async function renderEvolution(el) {
  el.innerHTML = `<div class="card"><div class="row-flex mb"><div class="tabs" id="evoMode"><button class="tab active" data-tab="driver">Pilotos</button><button class="tab" data-tab="constructor">Construtores</button></div><div class="tabs" id="evoKind"><button class="tab active" data-tab="pts">Pontos acumulados</button><button class="tab" data-tab="pos">Posição</button></div><span class="muted" style="font-size:13px">Arraste para fazer zoom · duplo-clique para repor · clique na legenda para esconder</span></div><div id="evoChart">${skeleton(8)}</div></div>`;
  const [races, sprints, sched] = await Promise.all([data.results(), data.sprints(), data.schedule()]);
  const names = new Map(sched.map((r) => [+r.round, r.raceName.replace(' Grand Prix', '')]));
  let mode = 'driver', kind = 'pts';
  const draw = () => {
    const { rounds, series } = cumulativePoints(races, sprints, mode);
    let S = series.slice(0, mode === 'driver' ? 12 : 11).map((s) => ({ name: s.name, color: s.color, xs: rounds, ys: s.data, width: 2.2 }));
    if (kind === 'pos') {
      // posição no campeonato depois de cada ronda
      const all = series;
      S = S.map((s) => ({ ...s, ys: rounds.map((_, i) => 1 + all.filter((o) => o.data[i] > all.find((a) => a.name === s.name).data[i]).length), dots: true }));
    }
    dashTeammates(S);
    new LineChart($('#evoChart'), S, {
      height: 420, yLabel: kind === 'pts' ? 'Pontos' : 'Posição', invertY: kind === 'pos', yMin: kind === 'pos' ? 1 : 0, yMax: kind === 'pos' ? Math.min(series.length, 15) : undefined,
      xFormat: (v) => `R${Math.round(v)}`, yFormat: (v) => (kind === 'pos' ? `P${Math.round(v)}` : fmt.pts(v)), sortTip: true,
      tipTitle: (x) => `R${Math.round(x)} · ${names.get(Math.round(x)) || ''}`,
    });
  };
  draw();
  tabs($('#evoMode'), (t) => { mode = t; draw(); });
  tabs($('#evoKind'), (t) => { kind = t; draw(); });
}

// ---------- Estatísticas ----------
function topBars(title, counts, colorOf, unit = '') {
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = list[0]?.[1] || 1;
  return `<div class="card"><div class="card-title">${title}</div>${list.length ? list.map(([k, v], i) => `<div class="bar-row"><span class="pos mono">${i + 1}</span><span class="nm">${esc(k)}</span><span class="bar"><i style="width:${(v / max) * 100}%;background:${colorOf(k)}"></i></span><span class="n">${fmt.num(v, unit === '%' ? 0 : 0)}${unit}</span></div>`).join('') : '<p class="muted">Sem dados.</p>'}</div>`;
}
async function renderStats(el) {
  el.innerHTML = skeleton(10);
  const [races, quali] = await Promise.all([data.results(), data.quali()]);
  const col = new Map();
  const inc = (m, k, v = 1) => m.set(k, (m.get(k) || 0) + v);
  const wins = new Map(), pods = new Map(), poles = new Map(), fls = new Map(), dnf = new Map(), gained = new Map(), lapsLed = new Map(), teamWins = new Map(), pts = new Map();
  for (const r of races) {
    for (const x of r.Results) {
      const n = `${x.Driver.givenName[0]}. ${x.Driver.familyName}`;
      col.set(n, teamColor(x.Constructor.constructorId, x.Constructor.name));
      col.set(x.Constructor.name, teamColor(x.Constructor.constructorId, x.Constructor.name));
      if (x.position === '1') { inc(wins, n); inc(teamWins, x.Constructor.name); }
      if (+x.position <= 3) inc(pods, n);
      if (x.FastestLap?.rank === '1') inc(fls, n);
      if (!/Finished|\+\d+ Laps?|Lapped/.test(x.status)) inc(dnf, n);
      if (+x.grid > 0 && /^\d+$/.test(x.positionText)) inc(gained, n, +x.grid - +x.position);
      inc(pts, n, 0);
    }
  }
  for (const q of quali) { const x = q.QualifyingResults?.find((r) => r.position === '1'); if (x) inc(poles, `${x.Driver.givenName[0]}. ${x.Driver.familyName}`); }
  const c = (k) => col.get(k) || '#888';
  const gainedPos = new Map([...gained].filter(([, v]) => v > 0));
  el.innerHTML = `<div class="grid g-3">
    ${topBars('Vitórias', wins, c)}${topBars('Pódios', pods, c)}${topBars('Pole positions', poles, c)}
    ${topBars('Voltas mais rápidas', fls, c)}${topBars('Posições ganhas (grelha → final)', gainedPos, c)}${topBars('Abandonos / não classificados', dnf, c)}
    ${topBars('Vitórias por equipa', teamWins, c)}
  </div>`;
}

// ---------- Duelos entre colegas ----------
async function renderH2H(el) {
  el.innerHTML = skeleton(10);
  const [races, quali] = await Promise.all([data.results(), data.quali()]);
  const pairs = new Map();
  const key = (r, a, b) => `${r.Constructor.constructorId}|${[a, b].sort().join('|')}`;
  const ensure = (k, team, a, b) => { if (!pairs.has(k)) pairs.set(k, { team, a, b, race: { [a.driverId]: 0, [b.driverId]: 0 }, quali: { [a.driverId]: 0, [b.driverId]: 0 }, pts: { [a.driverId]: 0, [b.driverId]: 0 } }); return pairs.get(k); };
  const byTeam = (list) => { const m = new Map(); for (const x of list) { const t = x.Constructor.constructorId; if (!m.has(t)) m.set(t, []); m.get(t).push(x); } return m; };
  for (const r of races) {
    for (const [, xs] of byTeam(r.Results)) {
      if (xs.length !== 2) continue;
      const [a, b] = xs; const p = ensure(key(a, a.Driver.driverId, b.Driver.driverId), a.Constructor, a.Driver, b.Driver);
      p.race[(+a.position < +b.position ? a : b).Driver.driverId]++;
      p.pts[a.Driver.driverId] += +a.points; p.pts[b.Driver.driverId] += +b.points;
    }
  }
  for (const q of quali) {
    for (const [, xs] of byTeam(q.QualifyingResults || [])) {
      if (xs.length !== 2) continue;
      const [a, b] = xs; const k = key(a, a.Driver.driverId, b.Driver.driverId);
      const p = pairs.get(k) || ensure(k, a.Constructor, a.Driver, b.Driver);
      p.quali[(+a.position < +b.position ? a : b).Driver.driverId]++;
    }
  }
  const list = [...pairs.values()].filter((p) => p.race[p.a.driverId] + p.race[p.b.driverId] >= 3);
  if (!list.length) { el.innerHTML = errorBox('Sem dados suficientes para duelos nesta época.'); return; }
  const row = (label, A, B, col) => {
    const t = A + B || 1;
    return `<div style="display:grid;grid-template-columns:40px 1fr 40px;gap:10px;align-items:center;margin:6px 0"><b class="mono" style="text-align:right">${fmt.pts(A)}</b><div><div class="muted" style="font-size:11.5px;text-align:center;text-transform:uppercase;letter-spacing:.08em;font-weight:700">${label}</div><div style="display:flex;height:8px;border-radius:5px;overflow:hidden;background:var(--surface-3)"><i style="width:${(A / t) * 100}%;background:${col}"></i><i style="width:${(B / t) * 100}%;background:${col};opacity:.4"></i></div></div><b class="mono">${fmt.pts(B)}</b></div>`;
  };
  el.innerHTML = `<div class="grid g-3">${list.map((p) => {
    const col = teamColor(p.team.constructorId, p.team.name);
    return `<div class="card"><div class="card-title" style="color:${col}">${esc(p.team.name)}</div>
      <div style="display:flex;justify-content:space-between;font-weight:800;font-size:17px"><span>${flagNat(p.a.nationality)} ${esc(p.a.familyName)}</span><span>${esc(p.b.familyName)} ${flagNat(p.b.nationality)}</span></div>
      ${row('Corrida', p.race[p.a.driverId], p.race[p.b.driverId], col)}${row('Qualificação', p.quali[p.a.driverId], p.quali[p.b.driverId], col)}${row('Pontos', p.pts[p.a.driverId], p.pts[p.b.driverId], col)}
    </div>`;
  }).join('')}</div>`;
}

// ---------- Detalhe de corrida ----------
async function raceModal(r) {
  const d = raceDate(r);
  const m = openModal(`${flagCountry(r.Circuit.Location.country)} ${esc(r.raceName)}`, `Ronda ${r.round} · ${esc(fmt.date(d))} · ${esc(r.Circuit.circuitName)}`, skeleton(8));
  const y = r.season;
  const [res, q, sp, pits] = await Promise.all([
    erg(`${y}/${r.round}/results`, {}, 3600).then((x) => x.RaceTable.Races[0]).catch(() => null),
    erg(`${y}/${r.round}/qualifying`, {}, 3600).then((x) => x.RaceTable.Races[0]).catch(() => null),
    r.Sprint ? erg(`${y}/${r.round}/sprint`, {}, 3600).then((x) => x.RaceTable.Races[0]).catch(() => null) : null,
    +y >= 2012 ? erg(`${y}/${r.round}/pitstops`, {}, 3600).then((x) => x.RaceTable.Races[0]).catch(() => null) : null,
  ]);
  const links = +y >= 2023 ? `<div class="row-flex mb"><a class="btn small primary" href="aovivo.html?d=${r.date}">▶ Replay da corrida</a><a class="btn small" href="telemetria.html?d=${r.date}">Telemetria</a><a class="btn small" href="circuitos.html?c=${r.Circuit.circuitId}">Circuito</a></div>` : `<div class="row-flex mb"><a class="btn small" href="circuitos.html?c=${r.Circuit.circuitId}">Circuito</a></div>`;
  if (!res) {
    const sess = weekendSessions(r);
    m.el.innerHTML = links + `<div class="card-title">Horários (hora local)</div><div class="sessions-list">${sess.map((s) => `<div class="s"><span class="nm">${esc(s.name)}</span><span class="d">${esc(fmt.weekday(s.date))}</span><span class="h">${esc(fmt.time(s.date))}</span></div>`).join('')}</div>`;
    return;
  }
  const tabsHtml = `<div class="tabs mb" id="rmTabs"><button class="tab active" data-tab="race">Corrida</button>${q ? '<button class="tab" data-tab="quali">Qualificação</button>' : ''}${sp ? '<button class="tab" data-tab="sprint">Sprint</button>' : ''}${pits?.PitStops?.length ? '<button class="tab" data-tab="pits">Paragens</button>' : ''}</div>`;
  const resultTable = (rows) => `<div class="table-wrap"><table class="t"><thead><tr><th>Pos</th><th>Piloto</th><th class="r">Grelha</th><th class="r">+/-</th><th class="r">Voltas</th><th>Tempo / Estado</th><th class="r">Pts</th></tr></thead><tbody>${rows.map((x) => {
    const delta = +x.grid > 0 && /^\d+$/.test(x.positionText) ? +x.grid - +x.position : null;
    const fl = x.FastestLap?.rank === '1';
    return `<tr><td class="pos ${+x.position <= 3 ? 'p' + x.position : ''}">${esc(x.positionText)}</td><td>${driverCell(x.Driver, x.Constructor)}</td><td class="r mono">${x.grid === '0' ? 'Pit' : x.grid}</td><td class="r mono" style="color:${delta > 0 ? 'var(--green)' : delta < 0 ? 'var(--red)' : 'var(--muted)'}">${delta == null ? '' : delta > 0 ? '▲' + delta : delta < 0 ? '▼' + -delta : '='}</td><td class="r mono">${x.laps}</td><td class="mono" style="font-size:13.5px">${esc(x.Time?.time || x.status)}${fl ? ' <span class="chip" style="background:rgba(177,76,255,.2);color:#d39bff">VMR ' + esc(x.FastestLap.Time?.time || '') + '</span>' : ''}</td><td class="r mono"><b>${x.points}</b></td></tr>`;
  }).join('')}</tbody></table></div>`;
  const qTable = () => `<div class="table-wrap"><table class="t"><thead><tr><th>Pos</th><th>Piloto</th><th class="r">Q1</th><th class="r">Q2</th><th class="r">Q3</th></tr></thead><tbody>${q.QualifyingResults.map((x) => `<tr><td class="pos ${+x.position <= 3 ? 'p' + x.position : ''}">${x.position}</td><td>${driverCell(x.Driver, x.Constructor)}</td><td class="r mono">${esc(x.Q1 || '')}</td><td class="r mono">${esc(x.Q2 || '')}</td><td class="r mono"><b>${esc(x.Q3 || '')}</b></td></tr>`).join('')}</tbody></table></div>`;
  const pitTable = () => {
    const drivers = new Map(res.Results.map((x) => [x.Driver.driverId, x]));
    return `<div class="table-wrap"><table class="t"><thead><tr><th>Piloto</th><th class="r">Volta</th><th class="r">Paragem</th><th class="r">Duração</th></tr></thead><tbody>${[...pits.PitStops].sort((a, b) => +a.duration - +b.duration).map((p) => { const x = drivers.get(p.driverId); return `<tr><td>${x ? driverCell(x.Driver, x.Constructor) : esc(p.driverId)}</td><td class="r mono">${p.lap}</td><td class="r mono">${p.stop}</td><td class="r mono"><b>${esc(p.duration)}</b>s</td></tr>`; }).join('')}</tbody></table></div><p class="muted mt-s" style="font-size:13px">Duração = tempo total no pit lane, ordenado do mais rápido.</p>`;
  };
  m.el.innerHTML = links + tabsHtml + `<div id="rmBody">${resultTable(res.Results)}</div>`;
  tabs($('#rmTabs'), (t) => {
    $('#rmBody').innerHTML = t === 'race' ? resultTable(res.Results) : t === 'quali' ? qTable() : t === 'sprint' ? resultTable(sp.SprintResults) : pitTable();
  });
}

// ---------- Página ----------
init(async () => {
  const app = $('#app');
  const years = Array.from({ length: NOW_Y - 1949 }, (_, i) => NOW_Y - i);
  app.innerHTML = `
    <section class="page-hero container">
      <h1>Época <em id="yTitle">${Y}</em></h1>
      <p>Calendário, classificações, evolução do campeonato, estatísticas e duelos entre colegas de equipa. Clique numa corrida para ver resultados, qualificação e paragens nas boxes.</p>
      <div class="row-flex mt">
        <select class="select" id="ySel" aria-label="Época">${years.map((y) => `<option ${y === Y ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <div class="tabs" id="tabs">
          <button class="tab" data-tab="calendario">Calendário</button><button class="tab" data-tab="pilotos">Pilotos</button><button class="tab" data-tab="construtores">Construtores</button>
          <button class="tab" data-tab="evolucao">Evolução</button><button class="tab" data-tab="stats">Estatísticas</button><button class="tab" data-tab="duelos">Duelos</button>
        </div>
      </div>
    </section>
    <section class="section container" style="padding-top:18px"><div id="view"></div></section>`;
  const renderers = { calendario: renderCalendar, pilotos: renderDrivers, construtores: renderConstructors, evolucao: renderEvolution, stats: renderStats, duelos: renderH2H };
  let cur = qs('tab', 'calendario');
  if (!renderers[cur]) cur = 'calendario';
  const show = async (t) => {
    cur = t;
    $$('#tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    setQs({ tab: t === 'calendario' ? null : t, ano: Y === NOW_Y ? null : Y });
    const v = $('#view');
    v.innerHTML = `<div class="card">${skeleton(10)}</div>`;
    try { await renderers[t](v); } catch (e) { console.error(e); v.innerHTML = `<div class="card">${errorBox('Não foi possível carregar estes dados. Tente novamente dentro de momentos.', e.message)}</div>`; }
  };
  tabs($('#tabs'), show);
  $('#ySel').addEventListener('change', (e) => { Y = +e.target.value; $('#yTitle').textContent = Y; show(cur); });
  await show(cur);
  const rnd = qs('ronda');
  if (rnd) { const races = await data.schedule(); const r = races.find((x) => x.round === rnd); if (r) raceModal(r); }
});

})();
