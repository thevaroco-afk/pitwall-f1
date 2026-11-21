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


// ---- news.js ----
// Notícias: proxy do site (Cloudflare) com cache; alternativa rss2json no browser.


function clean(s) { const d = document.createElement('div'); d.innerHTML = s || ''; return (d.textContent || '').replace(/\s+/g, ' ').trim(); }
function firstImg(html) { const m = /<img[^>]+src=["']([^"']+)/i.exec(html || ''); return m ? m[1] : null; }

async function viaProxy(ids) {
  const data = await getJSON(`${CONFIG.newsProxy}?feeds=${ids.join(',')}`, { ttl: 600, retries: 0 });
  if (!data || !Array.isArray(data.items)) throw new Error('proxy sem itens');
  return data.items;
}
async function viaRss2json(feeds) {
  const res = await Promise.allSettled(feeds.map(async (f) => {
    const d = await getJSON(CONFIG.rss2json + encodeURIComponent(f.url), { ttl: 900, retries: 0 });
    return (d.items || []).map((it) => ({
      title: clean(it.title), link: it.link, date: it.pubDate ? it.pubDate.replace(' ', 'T') + 'Z' : null,
      image: it.enclosure?.link || it.thumbnail || firstImg(it.content || it.description),
      summary: clean(it.description).slice(0, 280), source: f.name, sourceId: f.id,
    }));
  }));
  return res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

async function loadNews(ids = FEEDS.map((f) => f.id)) {
  let items = [];
  if (location.protocol !== 'file:') try { items = await viaProxy(ids); } catch (e) { console.warn('Proxy de notícias indisponível, a usar rss2json', e); }
  if (!items.length) items = await viaRss2json(FEEDS.filter((f) => ids.includes(f.id)));
  const seen = new Set();
  return items
    .filter((i) => i.title && i.link && !seen.has(i.link) && seen.add(i.link))
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

function newsCard(it) {
  const img = it.image ? `style="background-image:url('${esc(it.image)}')"` : '';
  return `<a class="news-card fade-in" href="${esc(it.link)}" target="_blank" rel="noopener">
    <div class="img ${it.image ? '' : 'ph'}" ${img}><span class="src chip">${esc(it.source)}</span></div>
    <div class="body"><h3>${esc(it.title)}</h3>${it.summary ? `<p>${esc(it.summary)}</p>` : ''}<div class="meta">${it.date ? esc(fmt.rel(it.date)) : ''}</div></div>
  </a>`;
}
function newsRow(it) {
  return `<a class="item" href="${esc(it.link)}" target="_blank" rel="noopener">
    <div class="th" ${it.image ? `style="background-image:url('${esc(it.image)}')"` : ''}></div>
    <div><h4>${esc(it.title)}</h4><div class="meta">${esc(it.source)} · ${it.date ? esc(fmt.rel(it.date)) : ''}</div></div></a>`;
}

// ---- home.js ----


async function getSchedule() {
  const y = new Date().getFullYear();
  let races = (await erg('current', {}, 3600)).RaceTable.Races;
  const now = Date.now();
  let next = races.find((r) => raceDate(r).getTime() + 3 * 3600e3 > now);
  if (!next) {
    try { const nxt = (await erg(`${y + 1}`, {}, 3600)).RaceTable.Races; if (nxt.length) { races = nxt; next = nxt[0]; } } catch { /* */ }
  }
  return { races, next };
}

// ---------- Temporizador do fim-de-semana ----------
// Antes de uma sessão: tempo até ao início. Durante treinos/qualificação: tempo até ao fim.
// Durante a corrida (e sprint): voltas em falta. Só depois de a sessão terminar passa à seguinte.
const IS_RACE = (s) => s.key === 'Race' || s.key === 'Sprint';
const NOMINAL_MIN = { FirstPractice: 60, SecondPractice: 60, ThirdPractice: 60, Qualifying: 60, SprintQualifying: 44, SprintShootout: 44, Sprint: 60, Race: 120 };
const FEED_NAME = { FirstPractice: 'Practice 1', SecondPractice: 'Practice 2', ThirdPractice: 'Practice 3', Qualifying: 'Qualifying', SprintQualifying: 'Sprint Qualifying', SprintShootout: 'Sprint Qualifying', Sprint: 'Sprint', Race: 'Race' };
const MAX_WINDOW = 4 * 3600e3; // nunca considerar uma sessão "a decorrer" mais de 4 h depois do início

// cronometragem oficial (endereço /api/live/state do próprio site, se existir)
let feed = null, feedAt = 0, feedBusy = false;
async function refreshFeed() {
  if (feedBusy || Date.now() - feedAt < 20000) return;
  feedBusy = true;
  try {
    const r = await fetch('api/live/state', { cache: 'no-store' });
    feed = r.ok && (r.headers.get('content-type') || '').includes('json') ? (await r.json()).state || null : null;
  } catch { feed = null; }
  feedAt = Date.now(); feedBusy = false;
}
/** Dados oficiais, só se forem desta sessão. */
function feedFor(s) {
  const name = feed?.SessionInfo?.Name || '';
  if (!feed || name.toLowerCase().replace('shootout', 'qualifying') !== (FEED_NAME[s.key] || '').toLowerCase()) return null;
  return feed;
}
const FEED_DONE = /^(Finished|Finalised|Ends)$/i;
function parseHMS(t) { const m = /^(\d+):(\d\d):(\d\d)/.exec(t || ''); return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 : null; }

function sessionEnded(s, now) {
  const start = s.date.getTime();
  if (now < start) return false;
  if (now > start + MAX_WINDOW) return true;
  const f = feedFor(s);
  if (f?.SessionStatus?.Status) return FEED_DONE.test(f.SessionStatus.Status);
  return now > start + NOMINAL_MIN[s.key] * 60e3;
}

/** Estado do temporizador: { kind: 'start'|'end'|'laps'|'race'|'over', session, target?, lap?, total? } */
function timerState(sess, now = Date.now()) {
  const live = sess.find((s) => s.date.getTime() <= now && !sessionEnded(s, now));
  if (live) {
    const f = feedFor(live);
    if (IS_RACE(live)) {
      const lc = f?.LapCount;
      if (lc?.TotalLaps) return { kind: 'laps', session: live, lap: lc.CurrentLap || 0, total: lc.TotalLaps };
      return { kind: 'race', session: live };
    }
    const ec = f?.ExtrapolatedClock;
    const rem = parseHMS(ec?.Remaining);
    if (rem != null) {
      const base = ec.Extrapolating ? Date.parse(ec.Utc) || now : now;
      return { kind: 'end', session: live, target: base + rem, paused: !ec.Extrapolating };
    }
    return { kind: 'end', session: live, target: live.date.getTime() + NOMINAL_MIN[live.key] * 60e3, approx: true };
  }
  const nxt = sess.find((s) => s.date.getTime() > now);
  return nxt ? { kind: 'start', session: nxt, target: nxt.date.getTime() } : { kind: 'over' };
}

const box = (v, l) => `<div class="u"><b>${String(v).padStart(2, '0')}</b><span>${l}</span></div>`;
function clockBoxes(ms) {
  let s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return (d ? box(d, 'dias') : '') + box(h, 'horas') + box(m, 'min') + box(s, 'seg');
}
function timerLabel(st) {
  const when = (s) => `<b style="color:#fff">${esc(s.name)}</b> · ${esc(fmt.weekday(s.date))} às ${esc(fmt.time(s.date))}`;
  switch (st.kind) {
    case 'start': return `Próxima sessão: ${when(st.session)} · começa dentro de`;
    case 'end': return `<span class="chip live">A DECORRER</span> <b style="color:#fff">${esc(st.session.name)}</b> · ${st.paused ? 'relógio parado (bandeira vermelha?)' : st.approx ? 'termina dentro de (aprox.)' : 'termina dentro de'}`;
    case 'laps': return `<span class="chip live">A DECORRER</span> <b style="color:#fff">${esc(st.session.name)}</b> · volta ${st.lap} de ${st.total}`;
    case 'race': return `<span class="chip live">A DECORRER</span> <b style="color:#fff">${esc(st.session.name)}</b>`;
    default: return 'Fim-de-semana terminado';
  }
}
function timerBoxes(st, now) {
  if (st.kind === 'start' || st.kind === 'end') return clockBoxes(st.target - now);
  if (st.kind === 'laps') return box(Math.max(0, st.total - st.lap), st.total - st.lap === 1 ? 'volta em falta' : 'voltas em falta');
  if (st.kind === 'race') return `<a class="btn" href="aovivo.html">Seguir a corrida em directo →</a>`;
  return '';
}

function startTimer(sess, onPhase) {
  let phase = '';
  const tick = () => {
    const now = Date.now();
    // perto ou durante uma sessão, perguntar à cronometragem oficial (de 20 em 20 s)
    if (sess.some((s) => now > s.date.getTime() - 10 * 60e3 && now < s.date.getTime() + MAX_WINDOW)) refreshFeed();
    const st = timerState(sess, now);
    const key = `${st.kind}|${st.session?.key || ''}`;
    if (key !== phase) { phase = key; onPhase(st); }
    const lbl = $('#cdLabel'); if (lbl) lbl.innerHTML = timerLabel(st);
    const cd = $('#cd'); if (cd) cd.innerHTML = timerBoxes(st, now);
  };
  tick();
  setInterval(tick, 1000);
}

function heroHtml(next) {
  const sess = weekendSessions(next);
  const now = Date.now();
  const st = timerState(sess, now);
  const current = st.session || null;
  const loc = next.Circuit.Location;
  return `<div class="hero-card fade-in">
    <div>
      <div class="eyebrow"><span>Ronda ${next.round} · ${next.season}</span><span id="liveChip"></span></div>
      <h1>${flagCountry(loc.country)} ${esc(next.raceName.replace('Grand Prix', 'GP'))}</h1>
      <div class="sub">${esc(next.Circuit.circuitName)} · ${esc(loc.locality)}, ${esc(loc.country)}</div>
      <div class="sub mt-s" style="font-size:15px" id="cdLabel">${timerLabel(st)}</div>
      <div class="countdown" id="cd"></div>
      <div class="row-flex mt">
        <a class="btn primary" href="aovivo.html">● Ao Vivo / Replay</a>
        <a class="btn" href="epoca.html">Calendário completo</a>
        <a class="btn" href="circuitos.html?c=${esc(next.Circuit.circuitId)}">Sobre o circuito</a>
      </div>
    </div>
    <div>
      <div class="card-title">Horários do fim-de-semana <span class="right muted">hora local</span></div>
      <div class="sessions-list">${sess.map((s) => {
        const done = sessionEnded(s, now);
        return `<div class="s ${done ? 'done' : ''} ${s === current ? 'next' : ''}"><span class="nm">${esc(s.name)}</span><span class="d">${esc(fmt.weekday(s.date))}</span><span class="h">${esc(fmt.time(s.date))}</span></div>`;
      }).join('')}</div>
    </div>
  </div>`;
}

function barRows(list, max) {
  return list.map((x, i) => `<div class="bar-row"><span class="pos mono ${i < 3 ? 'p' + (i + 1) : ''}">${i + 1}</span><span class="nm">${x.flag || ''} ${esc(x.name)}</span><span class="bar"><i style="width:${(x.v / (max || 1)) * 100}%;background:${x.color}"></i></span><span class="n">${fmt.pts(x.v)}</span></div>`).join('');
}

init(async () => {
  const app = $('#app');
  app.innerHTML = `
    <section class="hero container"><div id="hero">${`<div class="hero-card"><div>${skeleton(6)}</div><div>${skeleton(6)}</div></div>`}</div></section>
    <section class="section container">
      <div class="grid g-3">
        <div class="card"><div class="card-title">Último Grande Prémio <a class="right link" href="epoca.html" id="lastLink">resultados →</a></div><div id="last">${skeleton(5)}</div></div>
        <div class="card"><div class="card-title">Pilotos <a class="right link" href="epoca.html?tab=pilotos">tabela →</a></div><div id="drv">${skeleton(8)}</div></div>
        <div class="card"><div class="card-title">Construtores <a class="right link" href="epoca.html?tab=construtores">tabela →</a></div><div id="con">${skeleton(8)}</div></div>
      </div>
    </section>
    <section class="section container" style="padding-top:0">
      <div class="section-head"><h2>A época em números</h2><a class="link" href="epoca.html?tab=stats">mais estatísticas →</a></div>
      <div class="grid g-4" id="nums">${Array(4).fill(`<div class="card">${skeleton(2)}</div>`).join('')}</div>
    </section>
    <section class="section container" style="padding-top:0">
      <div class="section-head"><h2>Últimas notícias</h2><a class="link" href="noticias.html">todas as notícias →</a></div>
      <div class="news-grid" id="news">${Array(6).fill(`<div class="card">${skeleton(4)}</div>`).join('')}</div>
    </section>
    <section class="section container" style="padding-top:0">
      <div class="grid g-3">
        <a class="card hover" href="telemetria.html"><div class="card-title">Telemetria</div><h3 style="font-size:22px">Quem trava mais tarde?</h3><p class="text-2 mt-s">Compare velocidade, acelerador, travão e mudanças volta a volta, com delta e domínio por mini-sector.</p></a>
        <a class="card hover" href="historia.html"><div class="card-title">História</div><h3 style="font-size:22px">75 anos de campeões</h3><p class="text-2 mt-s">Todos os campeões, recordes de sempre e comparação de pilotos de épocas diferentes.</p></a>
        <a class="card hover" href="circuitos.html"><div class="card-title">Circuitos</div><h3 style="font-size:22px">Uma volta ao mundo</h3><p class="text-2 mt-s">O mapa de todos os circuitos que já receberam a F1, com os vencedores de cada um.</p></a>
      </div>
    </section>`;

  // Próxima corrida
  getSchedule().then(({ next }) => {
    if (!next) { $('#hero').innerHTML = errorBox('Calendário indisponível.'); return; }
    const sess = weekendSessions(next);
    let first = true;
    // redesenha o cartão quando muda de fase (ex.: a sessão terminou → contagem para a seguinte)
    startTimer(sess, () => {
      const chip = first ? '' : $('#liveChip')?.innerHTML || '';
      $('#hero').innerHTML = heroHtml(next);
      if (chip) $('#liveChip').innerHTML = chip;
      first = false;
    });
    currentLiveSession().then((s) => {
      if (s) $('#liveChip').innerHTML = `<a class="chip live" href="aovivo.html">AO VIVO · ${esc(s.session_name)}</a>`;
    }).catch(() => {});
  }).catch((e) => { $('#hero').innerHTML = `<div class="card">${errorBox('Não foi possível ler o calendário.', e.message)}</div>`; });

  // Último GP
  erg('current/last/results', {}, 900).then((d) => {
    const r = d.RaceTable.Races[0];
    if (!r) { $('#last').innerHTML = errorBox('Ainda não há corridas esta época.'); return; }
    $('#lastLink').href = `epoca.html?ano=${r.season}&ronda=${r.round}`;
    const top = r.Results.slice(0, 3);
    const order = [top[1], top[0], top[2]].filter(Boolean);
    const fl = r.Results.find((x) => x.FastestLap?.rank === '1');
    $('#last').innerHTML = `<div class="fade-in">
      <div style="font-weight:800;font-size:19px">${flagCountry(r.Circuit.Location.country)} ${esc(r.raceName)}</div>
      <div class="muted" style="font-size:14px">${esc(fmt.date(raceDate(r)))} · ${esc(r.Circuit.circuitName)}</div>
      <div class="podium mt">${order.map((x) => `<div class="pd"><div class="who">${flagNat(x.Driver.nationality)} ${esc(x.Driver.code || x.Driver.familyName)}</div><div class="tm">${esc(x.Constructor.name)}</div><div class="bar" style="background:${teamColor(x.Constructor.constructorId)}"></div><div class="blk">${x.position}</div></div>`).join('')}</div>
      ${fl ? `<div class="row-flex mt-s" style="font-size:14px"><span class="chip" style="background:rgba(177,76,255,.18);color:#d39bff">Volta mais rápida</span><b>${esc(fl.Driver.familyName)}</b><span class="mono">${esc(fl.FastestLap.Time?.time || '')}</span></div>` : ''}
    </div>`;
  }).catch((e) => { $('#last').innerHTML = errorBox('Sem resultados.', e.message); });

  // Classificações
  erg('current/driverStandings', {}, 900).then((d) => {
    const L = d.StandingsTable.StandingsLists[0]?.DriverStandings || [];
    const list = L.slice(0, 10).map((x) => ({ name: `${x.Driver.givenName[0]}. ${x.Driver.familyName}`, flag: flagNat(x.Driver.nationality), v: +x.points, color: teamColor(x.Constructors.at(-1)?.constructorId) }));
    $('#drv').innerHTML = list.length ? barRows(list, list[0]?.v) : errorBox('Sem classificação.');
  }).catch((e) => { $('#drv').innerHTML = errorBox('Sem classificação.', e.message); });
  erg('current/constructorStandings', {}, 900).then((d) => {
    const L = d.StandingsTable.StandingsLists[0]?.ConstructorStandings || [];
    const list = L.map((x) => ({ name: x.Constructor.name, v: +x.points, color: teamColor(x.Constructor.constructorId, x.Constructor.name) }));
    $('#con').innerHTML = list.length ? barRows(list, list[0]?.v) : errorBox('Sem classificação.');
  }).catch((e) => { $('#con').innerHTML = errorBox('Sem classificação.', e.message); });

  // Números
  Promise.all([ergAll('current/results/1', 900), erg('current', {}, 3600), ergAll('current/qualifying/1', 900).catch(() => [])]).then(([wins, sched, poles]) => {
    const total = sched.RaceTable.Races.length;
    const done = wins.length;
    const byW = {};
    for (const r of wins) { const x = r.Results[0]; const k = x.Driver.familyName; byW[k] = (byW[k] || 0) + 1; }
    const winners = Object.entries(byW).sort((a, b) => b[1] - a[1]);
    const poleWins = wins.filter((r) => r.Results[0].grid === '1').length;
    const byP = {};
    for (const r of poles) { const k = r.QualifyingResults?.[0]?.Driver.familyName; if (k) byP[k] = (byP[k] || 0) + 1; }
    const topPole = Object.entries(byP).sort((a, b) => b[1] - a[1])[0];
    const cards = [
      [`${done}<span class="muted" style="font-size:20px">/${total}</span>`, 'Corridas disputadas'],
      [winners.length, 'Vencedores diferentes'],
      [winners[0] ? winners[0][1] : '—', `Mais vitórias${winners[0] ? ' · ' + esc(winners[0][0]) : ''}`],
      [topPole ? topPole[1] : (done ? `${Math.round((poleWins / done) * 100)}%` : '—'), topPole ? `Mais poles · ${esc(topPole[0])}` : 'Vitórias desde a pole'],
    ];
    $('#nums').innerHTML = cards.map(([v, l]) => `<div class="card fade-in"><div class="stat"><span class="v">${v}</span><span class="l">${l}</span></div></div>`).join('');
  }).catch((e) => { $('#nums').innerHTML = `<div class="card">${errorBox('Sem estatísticas.', e.message)}</div>`; });

  // Notícias
  loadNews().then((items) => {
    $('#news').innerHTML = items.length ? items.slice(0, 6).map(newsCard).join('') : errorBox('Sem notícias de momento.');
  }).catch(() => { $('#news').innerHTML = errorBox('Não foi possível carregar as notícias.'); });
});

})();
