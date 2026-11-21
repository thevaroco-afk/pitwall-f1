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


// ---- officiallive.js ----
// =========================================================
// CRONOMETRAGEM OFICIAL EM DIRECTO — feed público da F1 (sem conta)
// O Worker (Durable Object LiveTiming) liga-se a livetiming.formula1.com
// e reenvia os dados por WebSocket para /api/live/ws.
// =========================================================

const ST = { state: {}, status: null, ws: null, tries: 0, el: null, timer: null, dirty: false, prevPos: new Map(), lastRC: 0 };

// mesma regra de fusão do Worker: objectos fundidos, arrays por índice
function merge(target, delta) {
  if (delta === null || typeof delta !== 'object' || Array.isArray(delta)) return delta;
  if (target === null || typeof target !== 'object') target = {};
  for (const [k, v] of Object.entries(delta)) {
    if (k === '_deleted') { for (const d of v || []) { if (Array.isArray(target)) target[d] = undefined; else delete target[d]; } continue; }
    if (Array.isArray(v)) target[k] = v;
    else if (v !== null && typeof v === 'object') target[k] = merge(target[k], v);
    else target[k] = v;
  }
  return target;
}
const vals = (o) => (o == null ? [] : Array.isArray(o) ? o.filter(Boolean) : Object.keys(o).sort((a, b) => a - b).map((k) => o[k]).filter(Boolean));

/** "1:23.456" / "23.456" -> segundos */
function secs(s) {
  if (!s || typeof s !== 'string') return null;
  const p = s.split(':').map(Number);
  if (p.some(isNaN)) return null;
  return p.reduce((a, x) => a * 60 + x, 0);
}

const TRACK = {
  1: ['GREEN', 'Pista livre'], 2: ['YELLOW', 'Bandeira amarela'], 3: ['YELLOW', 'Bandeira amarela'], 4: ['SC', 'Safety Car'],
  5: ['RED', 'Bandeira vermelha'], 6: ['VSC', 'Virtual Safety Car'], 7: ['VSC', 'VSC a terminar'],
};
const STATUS_PT = { Inactive: 'Por começar', Started: 'A decorrer', Aborted: 'Interrompida', Finished: 'Terminada', Finalised: 'Terminada', Ends: 'Terminada' };
const NAME_PT = { 'Practice 1': 'Treinos Livres 1', 'Practice 2': 'Treinos Livres 2', 'Practice 3': 'Treinos Livres 3', Qualifying: 'Qualificação', 'Sprint Qualifying': 'Qualificação Sprint', 'Sprint Shootout': 'Sprint Shootout', Sprint: 'Sprint', Race: 'Corrida' };
const TYPE_PT = { Practice: 'Treinos Livres', Qualifying: 'Qualificação', Race: 'Corrida' };

function mountOfficialLive(el) {
  ST.el = el;
  if (location.protocol === 'file:') return; // precisa do Worker
  connect();
  setInterval(() => { if (ST.dirty) { ST.dirty = false; render(); } else renderClock(); }, 500);
}

function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live/ws`;
  let ws;
  try { ws = new WebSocket(url); } catch { return retry(); }
  ST.ws = ws;
  ws.onopen = () => { ST.tries = 0; };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'snap') { ST.state = m.state || {}; ST.status = m.status; }
    else if (m.t === 'd') { for (const [topic, data] of m.d) ST.state[topic] = merge(ST.state[topic], data); }
    else if (m.t === 'status') ST.status = m.status;
    ST.dirty = true;
  };
  ws.onclose = () => { ST.ws = null; retry(); };
  ws.onerror = () => { try { ws.close(); } catch { /* */ } };
}
function retry() {
  ST.tries++;
  clearTimeout(ST.timer);
  ST.timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(ST.tries, 5)));
}

function isLive() {
  const s = ST.state.SessionStatus?.Status;
  const hb = Date.parse(ST.state.Heartbeat?.Utc || '');
  return (s === 'Started' || s === 'Aborted') || (hb && Date.now() - hb < 120_000 && s !== 'Finalised' && s !== 'Ends');
}

function remaining() {
  const c = ST.state.ExtrapolatedClock;
  if (!c?.Remaining) return null;
  let r = secs(c.Remaining);
  if (r == null) return null;
  if (c.Extrapolating) r -= (Date.now() - Date.parse(c.Utc)) / 1000;
  r = Math.max(0, Math.round(r));
  const h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), s = r % 60;
  return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
}
function renderClock() { const el = ST.el?.querySelector('#olClock'); if (el) el.textContent = remaining() ?? ''; }

function render() {
  const el = ST.el;
  if (!el) return;
  const S = ST.state;
  const drivers = S.DriverList || {};
  const lines = S.TimingData?.Lines || {};
  const nums = Object.keys(lines).filter((n) => drivers[n] || lines[n]);
  if (!nums.length) {
    const st = ST.status;
    el.innerHTML = st?.upstream === 'error'
      ? `<p class="muted" style="font-size:13px">Cronometragem oficial F1: sem ligação neste momento (${esc(st.error || 'erro')}). A tentar de novo…</p>`
      : `<p class="muted" style="font-size:13px">Cronometragem oficial F1: ${st?.upstream === 'connected' ? 'ligado, à espera de dados da sessão.' : 'a ligar…'}</p>`;
    return;
  }
  const info = S.SessionInfo || {};
  const type = info.Type || '';
  const isRace = /race|sprint/i.test(type) && !/qualifying|shootout/i.test(info.Name || '');
  const isQuali = /qualifying|shootout/i.test(type + ' ' + (info.Name || ''));
  const part = S.TimingData?.SessionPart; // Q1/Q2/Q3
  const live = isLive();
  const ended = /^(Finished|Finalised|Ends)$/i.test(S.SessionStatus?.Status || '');
  const ts = live ? (TRACK[S.TrackStatus?.Status] || TRACK[1]) : ended ? ['CHEQUERED', 'Sessão terminada'] : null;
  const statusTxt = STATUS_PT[S.SessionStatus?.Status] || S.SessionStatus?.Status || '';
  const lapCount = S.LapCount?.CurrentLap ? `VOLTA ${S.LapCount.CurrentLap}${S.LapCount.TotalLaps ? '/' + S.LapCount.TotalLaps : ''}` : '';
  const app = S.TimingAppData?.Lines || {};
  const stats = S.TimingStats?.Lines || {};

  const rows = nums.map((n) => ({ n, l: lines[n], d: drivers[n] || {}, pos: +(lines[n].Position || lines[n].Line || 99) }))
    .sort((a, b) => a.pos - b.pos);

  const body = rows.map(({ n, l, d, pos }, i) => {
    const color = d.TeamColour ? `#${d.TeamColour}` : '#888';
    const stints = vals(app[n]?.Stints);
    const st = stints.at(-1);
    const tyre = st?.Compound ? `<span class="tyre ${esc(st.Compound)}" title="${esc(st.Compound)} · ${st.TotalLaps ?? 0} voltas${st.New === 'false' ? ' (usado)' : ''}">${esc(st.Compound[0])}</span><small class="muted">${st.TotalLaps ?? ''}</small>` : '';
    let gap = '', sub = '';
    if (isRace) {
      const iv = l.IntervalToPositionAhead?.Value ?? '';
      const g = l.GapToLeader ?? '';
      gap = i === 0 ? (S.LapCount?.CurrentLap ? `Volta ${S.LapCount.CurrentLap}` : 'Líder') : iv || g;
      sub = i > 1 && iv && g && g !== iv ? g : '';
    } else {
      const best = isQuali ? (vals(l.BestLapTimes)[(part || 1) - 1]?.Value || l.BestLapTime?.Value) : l.BestLapTime?.Value;
      gap = best || '—';
      const diff = isQuali ? vals(l.Stats)[(part || 1) - 1]?.TimeDiffToFastest : l.TimeDiffToFastest;
      sub = i > 0 && diff ? diff : '';
    }
    const last = l.LastLapTime || {};
    const lastColor = last.OverallFastest ? 'var(--purple)' : last.PersonalFastest ? 'var(--green)' : 'inherit';
    const sectors = vals(l.Sectors).slice(0, 3).map((s) => {
      const c = s.OverallFastest ? 'var(--purple)' : s.PersonalFastest ? 'var(--green)' : s.Value ? 'var(--yellow)' : 'var(--surface-3)';
      return `<i title="${esc(s.Value || '')}" style="background:${c}"></i>`;
    }).join('');
    const flags = l.Retired ? '<span class="chip red" style="padding:1px 7px">DNF</span>'
      : l.Stopped ? '<span class="chip red" style="padding:1px 7px">PARADO</span>'
      : live && l.InPit ? '<span class="chip yellow" style="padding:1px 7px">BOX</span>'
      : live && l.PitOut ? '<span class="chip blue" style="padding:1px 7px">SAÍDA</span>'
      : l.KnockedOut ? '<span class="chip" style="padding:1px 7px">ELIM.</span>' : '';
    const pp = ST.prevPos.get(n);
    const mv = pp && pp !== pos ? (pos < pp ? 'up' : 'down') : '';
    ST.prevPos.set(n, pos);
    return `<div class="row ${mv}" title="${esc(d.FullName || '')} · ${esc(d.TeamName || '')}">
      <span class="p">${pos < 99 ? pos : ''}</span><span class="team-bar" style="background:${color};height:20px"></span>
      <span class="ab">${esc(d.Tla || n)}</span>
      <span class="gp">${flags || esc(gap)}${sub && !flags ? `<small>${esc(sub)}</small>` : ''}</span>
      <span class="gap"><span style="color:${lastColor}">${esc(last.Value || '')}</span></span>
      <span class="sec">${sectors}</span>
      <span class="ty">${tyre}</span>
      <span class="pits mono muted">${l.NumberOfPitStops ? l.NumberOfPitStops + '×' : ''}</span>
    </div>`;
  }).join('');

  const rc = vals(S.RaceControlMessages?.Messages).slice(-12).reverse();
  const w = S.WeatherData;
  const weather = w ? [[`${w.AirTemp}°`, 'Ar'], [`${w.TrackTemp}°`, 'Pista'], [`${w.Humidity}%`, 'Humidade'], [`${w.WindSpeed} m/s`, 'Vento'], [+w.Rainfall ? '🌧 Sim' : '☀ Não', 'Chuva']]
    .map(([v, l]) => `<div class="w"><b>${esc(v)}</b><span>${l}</span></div>`).join('') : '';

  el.innerHTML = `
    <div class="card">
      <div class="row-flex mb" style="justify-content:space-between">
        <div class="row-flex">
          <div class="card-title" style="margin:0">Cronometragem oficial F1</div>
          ${live ? '<span class="chip live">AO VIVO</span>' : ended ? '' : `<span class="chip">${esc(statusTxt || 'Sem sessão em curso')}</span>`}
        </div>
        <div class="row-flex">
          ${ts ? `<span class="flag-banner flag-${ts[0]}">${ts[1]}</span>` : ''}
          ${lapCount ? `<span class="lapbig">${lapCount}</span>` : ''}
          ${live ? `<span class="lapbig" id="olClock">${remaining() ?? ''}</span>` : ''}
        </div>
      </div>
      <h3 style="font-size:18px;margin:0 0 10px">${esc(info.Meeting?.Name || '')} · ${esc(NAME_PT[info.Name] || info.Name || TYPE_PT[info.Type] || '')}${part && isQuali ? ` · Q${part}` : ''}</h3>
      <div class="ol-grid">
        <div class="timing ol">
          <div class="row hd"><span>P</span><span></span><span>Piloto</span><span>${isRace ? 'Intervalo' : 'Melhor volta'}</span><span style="text-align:right">Última</span><span>Sect.</span><span>Pneu</span><span>Box</span></div>
          ${body}
        </div>
        <div>
          <div class="card-title">Direcção de corrida</div>
          <div class="feed">${rc.map((m) => `<div class="it"><span class="tm">${esc((m.Utc ? fmt.clock(Date.parse(m.Utc + (/Z$/.test(m.Utc) ? '' : 'Z'))) : '').slice(0, 8))}${m.Lap ? `<br>V${m.Lap}` : ''}</span><span>${esc(m.Message)}</span></div>`).join('') || '<p class="muted">Sem mensagens.</p>'}</div>
          ${weather ? `<div class="card-title mt">Meteorologia</div><div class="weather">${weather}</div>` : ''}
        </div>
      </div>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">Dados oficiais da Formula 1 (livetiming.formula1.com), em directo e sem conta. O mapa com os carros e a telemetria em directo exigem F1 TV e não estão incluídos.</p>
    </div>`;
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

// ---- raceviz.js ----
// Visualizações partilhadas: estratégia de pneus, gráfico de posições e tempos por volta


const TYRE_COLORS = { SOFT: '#ff3b3b', MEDIUM: '#ffd60a', HARD: '#f2f2f2', INTERMEDIATE: '#2fbf4a', WET: '#2f7dff', UNKNOWN: '#666', TEST_UNKNOWN: '#666' };
const tyreLetter = (c) => ({ SOFT: 'S', MEDIUM: 'M', HARD: 'H', INTERMEDIATE: 'I', WET: 'W' }[c] || '?');

/**
 * stints: [{driver_number, stint_number, compound, lap_start, lap_end, tyre_age_at_start}]
 * order: driver_numbers ordenados; drivers: Map num -> {acr, color}
 */
function strategyChart(el, stints, order, drivers, totalLaps) {
  const byD = new Map();
  for (const s of stints) { if (!byD.has(s.driver_number)) byD.set(s.driver_number, []); byD.get(s.driver_number).push(s); }
  const maxLap = totalLaps || Math.max(1, ...stints.map((s) => s.lap_end || s.lap_start || 0));
  const rows = order.filter((n) => byD.has(n));
  if (!rows.length) { el.innerHTML = '<p class="muted">Sem dados de pneus para esta sessão.</p>'; return; }
  const ticks = [];
  const step = maxLap > 40 ? 10 : 5;
  for (let l = step; l < maxLap; l += step) ticks.push(l);
  el.innerHTML = `<div style="position:relative;padding-left:52px">
    ${rows.map((n) => {
      const d = drivers.get(n) || { acr: n, color: '#888' };
      return `<div style="display:flex;align-items:center;height:24px;margin:3px 0;position:relative">
        <span style="position:absolute;left:-52px;width:46px;font-weight:800;font-size:13px;border-left:3px solid ${d.color};padding-left:6px">${esc(d.acr)}</span>
        <div style="position:relative;flex:1;height:18px;background:var(--surface-2);border-radius:4px">
        ${byD.get(n).sort((a, b) => a.stint_number - b.stint_number).map((s) => {
          const a = (s.lap_start || 1) - 1, b = s.lap_end || maxLap;
          const c = TYRE_COLORS[s.compound] || '#666';
          return `<div title="${esc(s.compound || '?')} · voltas ${a + 1}–${b}${s.tyre_age_at_start ? ' · usado (' + s.tyre_age_at_start + ' voltas)' : ' · novo'}" style="position:absolute;top:0;bottom:0;left:${(a / maxLap) * 100}%;width:calc(${((b - a) / maxLap) * 100}% - 2px);background:${c};border-radius:4px;opacity:${s.tyre_age_at_start ? .65 : .95};display:flex;align-items:center;justify-content:center;font:800 11px var(--mono);color:#000;overflow:hidden">${b - a >= 4 ? tyreLetter(s.compound) + ' ' + (b - a) : ''}</div>`;
        }).join('')}</div></div>`;
    }).join('')}
    <div style="position:relative;height:18px;margin-top:4px;font:11px var(--mono);color:var(--muted)">${ticks.map((l) => `<span style="position:absolute;left:${(l / maxLap) * 100}%;transform:translateX(-50%)">${l}</span>`).join('')}</div>
  </div>
  <div class="legend">${['SOFT', 'MEDIUM', 'HARD', 'INTERMEDIATE', 'WET'].map((c) => `<span><i style="background:${TYRE_COLORS[c]};height:10px;width:10px;border-radius:50%"></i>${{ SOFT: 'Macio', MEDIUM: 'Médio', HARD: 'Duro', INTERMEDIATE: 'Intermédio', WET: 'Chuva' }[c]}</span>`).join('')}<span class="muted">Mais claro = pneu usado</span></div>`;
}

/** laps: [{driver_number, lap_number, lap_duration, is_pit_out_lap}] */
function lapTimeChart(el, laps, drivers, { order = null, filterOutliers = true, height = 360 } = {}) {
  const byD = new Map();
  for (const l of laps) { if (!l.lap_duration) continue; if (!byD.has(l.driver_number)) byD.set(l.driver_number, []); byD.get(l.driver_number).push(l); }
  const all = [...byD.values()].flat().map((l) => l.lap_duration).sort((a, b) => a - b);
  const best = all[0] || 0;
  const cut = filterOutliers ? best * 1.12 : Infinity;
  const nums = order || [...byD.keys()];
  const series = nums.filter((n) => byD.has(n)).map((n, i) => {
    const d = drivers.get(n) || { acr: String(n), color: '#888' };
    const L = byD.get(n).sort((a, b) => a.lap_number - b.lap_number);
    return { name: d.acr, color: d.color, xs: L.map((l) => l.lap_number), ys: L.map((l) => (l.lap_duration <= cut && !l.is_pit_out_lap ? l.lap_duration : null)), dots: true, width: 1.4, hidden: i >= 6 };
  });
  if (!series.length) { el.innerHTML = '<p class="muted">Sem tempos por volta.</p>'; return null; }
  return new LineChart(el, series, { height, yLabel: 'Tempo de volta', xFormat: (v) => `V${Math.round(v)}`, yFormat: (v) => fmt.lap(v), sortTip: true, invertY: false, tipTitle: (x) => `Volta ${Math.round(x)}` });
}

/** positionsByLap: Map num -> [{lap, pos}] */
function positionChart(el, positionsByLap, drivers, order, height = 420) {
  const series = order.filter((n) => positionsByLap.has(n)).map((n) => {
    const d = drivers.get(n) || { acr: String(n), color: '#888' };
    const P = positionsByLap.get(n);
    return { name: d.acr, color: d.color, xs: P.map((p) => p.lap), ys: P.map((p) => p.pos), width: 2 };
  });
  const seen = new Map();
  for (const s of series) { const k = s.color; s.dash = seen.has(k) ? [5, 4] : null; seen.set(k, 1); }
  return new LineChart(el, series, { height, yLabel: 'Posição', invertY: true, yMin: 1, yMax: Math.max(10, series.length), yTicks: [1, 5, 10, 15, 20], xFormat: (v) => `V${Math.round(v)}`, yFormat: (v) => `P${Math.round(v)}`, sortTip: true, tipTitle: (x) => `Volta ${Math.round(x)}` });
}

function driverMapFromOpenF1(list) {
  const m = new Map();
  for (const d of list) m.set(d.driver_number, { num: d.driver_number, acr: d.name_acronym || String(d.driver_number), name: d.full_name || d.broadcast_name, team: d.team_name, color: hex(d.team_colour || '888888'), headshot: d.headshot_url, country: d.country_code });
  return m;
}

// ---- live.js ----
// =========================================================
// AO VIVO / REPLAY — OpenF1
// =========================================================




const API = CONFIG.openf1;
const WIN = 60_000;          // janelas de localização de 60 s
const LIVE_DELAY = 8_000;    // atraso em directo (latência dos dados)
const ROW_H = 35;

const S = {
  session: null, meeting: null, drivers: new Map(), outline: null, bounds: null,
  tStart: 0, tEnd: 0, T: 0, playing: false, speed: 1, live: false, followLive: false,
  windows: new Map(), loading: new Set(),
  pos: new Map(), ints: new Map(), laps: new Map(), stints: [], pits: [], rc: [], weather: [], radio: [],
  selected: null, car: new Map(), carLoading: new Set(),
  lastTower: 0, lastRCCount: -1, isRace: false, token: 0,
};

const iso = (ms) => new Date(ms).toISOString().slice(0, 23);
const q = (path, params) => `${API}/${path}?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;

async function raw(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await smartFetch(url);
      if (r.status === 404) return [];
      if (r.status === 401 || r.status === 403) { const e = new Error('auth'); e.auth = true; throw e; }
      if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    } catch (e) { if (e.auth || i === 2) throw e; await sleep(600 * (i + 1)); }
  }
  return [];
}

function bisectT(arr, t) { // último índice com arr[i].t <= t
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function groupBy(rows, key = 'driver_number', tKey = 'date') {
  const m = new Map();
  for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push({ ...r, t: parseT(r[tKey]) }); }
  for (const a of m.values()) a.sort((x, y) => x.t - y.t);
  return m;
}
function mergeGrouped(target, rows, key = 'driver_number', tKey = 'date') {
  const g = groupBy(rows, key, tKey);
  for (const [k, arr] of g) {
    const cur = target.get(k) || [];
    const lastT = cur.length ? cur[cur.length - 1].t : -Infinity;
    for (const r of arr) if (r.t > lastT) cur.push(r);
    target.set(k, cur);
  }
}

// ---------- Selecção de sessão ----------
async function loadSessionList(year) {
  const [sessions, meetings] = await Promise.all([
    getJSON(q('sessions', { year }), { ttl: 1800 }),
    getJSON(q('meetings', { year }), { ttl: 3600 }).catch(() => []),
  ]);
  const mName = new Map(meetings.map((m) => [m.meeting_key, m]));
  const now = Date.now();
  const byMeeting = new Map();
  for (const s of sessions.filter((s) => parseT(s.date_start) < now + 3600e3).sort((a, b) => parseT(a.date_start) - parseT(b.date_start))) {
    if (!byMeeting.has(s.meeting_key)) byMeeting.set(s.meeting_key, { meeting: mName.get(s.meeting_key) || { meeting_name: `${s.country_name} — ${s.circuit_short_name}`, country_name: s.country_name }, sessions: [] });
    byMeeting.get(s.meeting_key).sessions.push(s);
  }
  return [...byMeeting.entries()].filter(([, v]) => !/test/i.test(v.meeting.meeting_name || ''));
}
const SESSION_PT = { 'Practice 1': 'Treinos Livres 1', 'Practice 2': 'Treinos Livres 2', 'Practice 3': 'Treinos Livres 3', Qualifying: 'Qualificação', 'Sprint Qualifying': 'Qualificação Sprint', 'Sprint Shootout': 'Sprint Shootout', Sprint: 'Sprint', Race: 'Corrida' };
const ptName = (n) => SESSION_PT[n] || n;

// ---------- Carregar sessão ----------
async function loadSession(session, meeting) {
  const token = ++S.token;
  Object.assign(S, {
    session, meeting, outline: null, bounds: null, windows: new Map(), loading: new Set(), pos: new Map(), ints: new Map(), laps: new Map(),
    stints: [], pits: [], rc: [], weather: [], radio: [], selected: null, car: new Map(), carLoading: new Set(), lastRCCount: -1, playing: false,
  });
  S.isRace = /race|sprint$/i.test(session.session_type || session.session_name) && !/qual|shootout/i.test(session.session_name);
  const now = Date.now();
  S.tStart = parseT(session.date_start) - 5 * 60e3;
  S.tEnd = Math.min(parseT(session.date_end) + 10 * 60e3, now);
  S.live = now >= parseT(session.date_start) - 15 * 60e3 && now <= parseT(session.date_end) + 30 * 60e3;
  S.followLive = S.live;
  setQs({ s: session.session_key, d: null });
  $('#sessTitle').innerHTML = `${flagCountry(session.country_name)} ${esc(meeting?.meeting_name || session.country_name)} <span class="muted" style="font-weight:600">· ${esc(ptName(session.session_name))} ${session.year}</span>`;
  $('#liveChip').innerHTML = S.live ? '<span class="chip live">AO VIVO</span>' : '<span class="chip">REPLAY</span>';
  $('#tower').innerHTML = skeleton(12);
  $('#status').textContent = 'A carregar pilotos e dados da sessão…';

  const K = session.session_key;
  let drivers;
  try { drivers = await raw(q('drivers', { session_key: K })); }
  catch (e) { return showAuthOrError(e); }
  if (token !== S.token) return;
  S.drivers = driverMapFromOpenF1(drivers);
  if (!S.drivers.size) { $('#status').innerHTML = ''; $('#tower').innerHTML = errorBox('Ainda não há dados para esta sessão.', S.live ? 'Em directo, a OpenF1 gratuita só disponibiliza os dados depois da sessão terminar. Escolha uma sessão anterior acima para ver o replay.' : 'Escolha outra sessão acima.'); return; }

  const eps = [['position', 'pos'], ['laps', 'laps'], ['stints', null], ['pit', null], ['race_control', null], ['weather', null], ['team_radio', null]];
  if (S.isRace) eps.push(['intervals', 'ints']);
  const res = await Promise.allSettled(eps.map(([ep]) => raw(q(ep, { session_key: K }))));
  if (token !== S.token) return;
  res.forEach((r, i) => {
    const [ep] = eps[i];
    const rows = r.status === 'fulfilled' ? r.value : [];
    if (ep === 'position') S.pos = groupBy(rows);
    else if (ep === 'intervals') S.ints = groupBy(rows);
    else if (ep === 'laps') S.laps = groupBy(rows.map((l) => ({ ...l, date: l.date_start || null })).filter((l) => l.date), 'driver_number', 'date');
    else if (ep === 'stints') S.stints = rows;
    else if (ep === 'pit') S.pits = rows.map((p) => ({ ...p, t: parseT(p.date) }));
    else if (ep === 'race_control') S.rc = rows.map((p) => ({ ...p, t: parseT(p.date) })).sort((a, b) => a.t - b.t);
    else if (ep === 'weather') S.weather = rows.map((p) => ({ ...p, t: parseT(p.date) })).sort((a, b) => a.t - b.t);
    else if (ep === 'team_radio') S.radio = rows.map((p) => ({ ...p, t: parseT(p.date) })).sort((a, b) => a.t - b.t);
  });
  const lastData = Math.max(...[...S.pos.values()].map((a) => a.at(-1)?.t || 0), ...S.rc.map((r) => r.t), 0);
  if (!S.live && lastData) S.tEnd = Math.min(S.tEnd, lastData + 3 * 60e3);

  // ponto de partida: em corrida, perto do arranque
  S.T = S.tStart + 5 * 60e3;
  if (S.isRace) {
    const lap2 = [...S.laps.values()].map((a) => a.find((l) => l.lap_number === 2)?.t).filter(Boolean);
    const lapDurs = [...S.laps.values()].flat().map((l) => l.lap_duration).filter(Boolean).sort((a, b) => a - b);
    if (lap2.length && lapDurs.length) S.T = Math.min(...lap2) - lapDurs[Math.floor(lapDurs.length / 2)] * 1000 * 1.15 - 20_000;
  }
  if (S.followLive) S.T = Date.now() - LIVE_DELAY;
  S.T = clamp(S.T, S.tStart, S.tEnd);

  $('#status').textContent = 'A desenhar o circuito…';
  await loadOutline(K, token);
  if (token !== S.token) return;
  $('#status').textContent = '';
  setupScrubber();
  renderAnalysis();
  await ensureWindows();
  updateTower(true);
}

function showAuthOrError(e) {
  $('#status').textContent = '';
  $('#tower').innerHTML = e.auth
    ? `<div class="notice warn" style="margin:14px">A OpenF1 só disponibiliza dados <b>em tempo real</b> a contas pagas. Veja a tabela de tempos em directo no quadro <b>Cronometragem oficial F1</b> acima; o mapa e o replay completo ficam disponíveis pouco depois de a sessão terminar.</div>`
    : errorBox('Não foi possível ligar à OpenF1.', e.message);
}

async function loadOutline(K, token) {
  // Volta mais rápida de qualquer piloto = traçado limpo do circuito
  const all = [...S.laps.values()].flat().filter((l) => l.lap_duration && l.t && !l.is_pit_out_lap).sort((a, b) => a.lap_duration - b.lap_duration);
  let pts = [];
  for (const lap of all.slice(0, 3)) {
    try {
      pts = await raw(q('location', { session_key: K, driver_number: lap.driver_number, 'date>': iso(lap.t), 'date<': iso(lap.t + lap.lap_duration * 1000 + 500) }));
    } catch { pts = []; }
    pts = pts.filter((p) => p.x || p.y);
    if (pts.length > 40) break;
  }
  if (pts.length < 40) {
    // sem voltas: usar 2 minutos de um piloto em pista
    const first = [...S.drivers.keys()][0];
    try {
      const t0 = Math.max(S.tStart + 20 * 60e3, S.T);
      pts = (await raw(q('location', { session_key: K, driver_number: first, 'date>': iso(t0), 'date<': iso(t0 + 150_000) }))).filter((p) => p.x || p.y);
    } catch { pts = []; }
  }
  if (token !== S.token) return;
  S.outline = pts.map((p) => [p.x, p.y]);
  computeBounds(S.outline);
}
function computeBounds(points) {
  if (!points.length) { S.bounds = null; return; }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  S.bounds = { x0, x1, y0, y1 };
}

// ---------- Janelas de localização ----------
function winIdx(t) { return Math.floor((t - S.tStart) / WIN); }
async function loadWindow(w, token) {
  if (S.loading.has(w)) return;
  const existing = S.windows.get(w);
  if (existing?.complete) return;
  S.loading.add(w);
  const from = S.tStart + w * WIN, to = from + WIN;
  const since = existing?.lastT ? existing.lastT : from;
  try {
    const rows = await raw(q('location', { session_key: S.session.session_key, 'date>': iso(since), 'date<': iso(to) }));
    if (token !== S.token) return;
    const win = existing || { byD: new Map(), lastT: from, complete: false };
    for (const r of rows) {
      if (!r.x && !r.y) continue;
      const t = parseT(r.date);
      if (!win.byD.has(r.driver_number)) win.byD.set(r.driver_number, []);
      win.byD.get(r.driver_number).push({ t, x: r.x, y: r.y });
      if (t > win.lastT) win.lastT = t;
    }
    for (const a of win.byD.values()) a.sort((a1, b1) => a1.t - b1.t);
    win.complete = to < Date.now() - 30_000;
    S.windows.set(w, win);
    // libertar memória de janelas antigas
    for (const k of S.windows.keys()) if (Math.abs(k - w) > 12) S.windows.delete(k);
  } catch (e) {
    if (e.auth) { S.playing = false; showAuthOrError(e); }
  } finally { S.loading.delete(w); }
}
async function ensureWindows() {
  const token = S.token;
  const w = winIdx(S.T);
  const ahead = S.playing ? Math.ceil((S.speed * 25_000) / WIN) + 1 : 1;
  const jobs = [];
  for (let i = -1; i <= ahead; i++) {
    const k = w + i;
    if (k < 0 || S.tStart + k * WIN > S.tEnd + WIN) continue;
    const win = S.windows.get(k);
    const isLiveEdge = S.followLive && S.tStart + (k + 1) * WIN > Date.now() - 60_000;
    if (!win || (!win.complete && (isLiveEdge || !win.lastT))) jobs.push(k);
  }
  for (const k of jobs.slice(0, 3)) await loadWindow(k, token);
}

function carPos(num, t) {
  const w = winIdx(t);
  let a = null, b = null;
  for (const k of [w - 1, w, w + 1]) {
    const arr = S.windows.get(k)?.byD.get(num);
    if (!arr?.length) continue;
    const i = bisectT(arr, t);
    if (i >= 0 && (!a || arr[i].t > a.t)) a = arr[i];
    if (i + 1 < arr.length && (!b || arr[i + 1].t < b.t)) b = arr[i + 1];
  }
  if (!a) return null;
  if (t - a.t > 6000) return null; // dados velhos: carro provavelmente nas boxes / sem sinal
  if (!b || b.t - a.t > 3000) return { x: a.x, y: a.y };
  const f = (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// ---------- Estado no instante T ----------
function at(map, num, t) { const arr = map.get(num); if (!arr) return null; const i = bisectT(arr, t); return i >= 0 ? arr[i] : null; }
function lapInfo(num, t) {
  const arr = S.laps.get(num) || [];
  const i = bisectT(arr, t);
  const cur = i >= 0 ? arr[i] : null;
  let last = null, best = null;
  for (let j = 0; j <= i; j++) {
    const l = arr[j];
    if (!l.lap_duration) continue;
    if (l.t + l.lap_duration * 1000 > t) continue;
    last = l;
    if (!best || l.lap_duration < best.lap_duration) best = l;
  }
  return { lap: cur?.lap_number || (arr.length && arr[0].t > t ? 0 : null), cur, last, best };
}
function tyreAt(num, lap) {
  const st = S.stints.filter((s) => s.driver_number === num).sort((a, b) => a.stint_number - b.stint_number);
  if (!st.length) return null;
  let s = st.find((x) => lap >= (x.lap_start || 0) && lap <= (x.lap_end || 999)) || st[0];
  if (lap > (st.at(-1).lap_end || 999)) s = st.at(-1);
  return { compound: s.compound || 'UNKNOWN', age: (s.tyre_age_at_start || 0) + Math.max(0, (lap || 1) - (s.lap_start || 1)) };
}
function trackStatus(t) {
  let st = { k: 'GREEN', label: 'Pista livre' };
  for (const m of S.rc) {
    if (m.t > t) break;
    const msg = (m.message || '').toUpperCase();
    if (m.category === 'SafetyCar' || msg.includes('SAFETY CAR')) {
      if (msg.includes('VIRTUAL') && msg.includes('DEPLOYED')) st = { k: 'VSC', label: 'Virtual Safety Car' };
      else if (msg.includes('DEPLOYED')) st = { k: 'SC', label: 'Safety Car' };
      else if (msg.includes('ENDING') || msg.includes('IN THIS LAP')) st = { ...st, label: st.label + ' · a terminar' };
    } else if (m.flag === 'RED') st = { k: 'RED', label: 'Bandeira vermelha' };
    else if (m.flag === 'CHEQUERED') st = { k: 'CHEQUERED', label: 'Bandeira axadrezada' };
    else if ((m.flag === 'GREEN' || m.flag === 'CLEAR') && m.scope === 'Track') st = { k: 'GREEN', label: 'Pista livre' };
  }
  return st;
}

// ---------- Desenho do mapa ----------
let canvas, ctx, view = null;
function setupCanvas() {
  canvas = $('#track'); ctx = canvas.getContext('2d');
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view = null;
  };
  new ResizeObserver(resize).observe(canvas);
  resize();
  canvas.addEventListener('click', (e) => {
    if (!view) return;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let bestD = 22, sel = null;
    for (const num of S.drivers.keys()) {
      const p = carPos(num, S.T); if (!p) continue;
      const [sx, sy] = view.tr(p.x, p.y);
      const d = Math.hypot(sx - mx, sy - my);
      if (d < bestD) { bestD = d; sel = num; }
    }
    selectDriver(sel === S.selected ? null : sel);
  });
}
function makeView() {
  const W = canvas.clientWidth, H = canvas.clientHeight, b = S.bounds;
  if (!b || !W) return null;
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const rotate = bh > bw * 1.15 && W > H; // circuitos "altos" rodados 90°
  const w = rotate ? bh : bw, h = rotate ? bw : bh;
  const pad = 34;
  const sc = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
  const ox = (W - w * sc) / 2, oy = (H - h * sc) / 2;
  const tr = (x, y) => {
    let u = x - b.x0, v = y - b.y0;
    if (rotate) [u, v] = [v, bw - u];
    return [ox + u * sc, H - (oy + v * sc)];
  };
  return { tr, W, H };
}
function drawTrack() {
  if (!ctx) return;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  if (!S.bounds) return;
  if (!view) view = makeView();
  if (!view) return;
  const { tr } = view;
  // traçado
  if (S.outline?.length) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const path = new Path2D();
    S.outline.forEach(([x, y], i) => { const [sx, sy] = tr(x, y); i ? path.lineTo(sx, sy) : path.moveTo(sx, sy); });
    ctx.strokeStyle = '#000'; ctx.lineWidth = 16; ctx.stroke(path);
    ctx.strokeStyle = '#2e2e3c'; ctx.lineWidth = 11; ctx.stroke(path);
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.setLineDash([4, 6]); ctx.stroke(path); ctx.setLineDash([]);
    const [sx, sy] = tr(...S.outline[0]);
    ctx.fillStyle = '#fff'; ctx.fillRect(sx - 2, sy - 9, 4, 18);
  }
  // carros (por ordem inversa da posição para o líder ficar por cima)
  const order = towerOrder(S.T).reverse();
  for (const num of order) {
    const p = carPos(num, S.T); if (!p) continue;
    const d = S.drivers.get(num);
    const [sx, sy] = tr(p.x, p.y);
    const sel = num === S.selected;
    const dim = S.selected && !sel;
    ctx.globalAlpha = dim ? .45 : 1;
    ctx.beginPath(); ctx.arc(sx, sy, sel ? 9 : 6.5, 0, Math.PI * 2);
    ctx.fillStyle = d.color; ctx.fill();
    ctx.lineWidth = sel ? 3 : 1.6; ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,.8)'; ctx.stroke();
    ctx.font = `800 ${sel ? 13 : 11}px "Titillium Web", sans-serif`;
    const label = d.acr;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(8,8,12,.82)';
    ctx.fillRect(sx + 9, sy - 8, tw + 8, 16);
    ctx.fillStyle = sel ? '#fff' : '#e8e8f0';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(label, sx + 13, sy);
    ctx.globalAlpha = 1;
  }
}

// ---------- Torre de tempos ----------
function towerOrder(t) {
  const nums = [...S.drivers.keys()];
  const p = new Map(nums.map((n) => [n, at(S.pos, n, t)?.position ?? 99]));
  return nums.sort((a, b) => p.get(a) - p.get(b));
}
const prevPos = new Map();
function updateTower(force = false) {
  const now = performance.now();
  if (!force && now - S.lastTower < 250) return;
  S.lastTower = now;
  const t = S.T;
  const order = towerOrder(t);
  const el = $('#towerRows');
  if (!el) return;
  if (el.dataset.session !== String(S.session.session_key)) {
    el.dataset.session = S.session.session_key;
    el.style.height = order.length * ROW_H + 'px';
    el.innerHTML = order.map((n) => { const d = S.drivers.get(n); return `<div class="row" data-n="${n}" style="position:absolute;left:0;right:0;transition:transform .6s cubic-bezier(.2,.8,.2,1)"><span class="p"></span><span class="team-bar" style="background:${d.color};height:20px"></span><span class="ab">${esc(d.acr)}</span><span class="gp"></span><span class="gap"></span><span class="ty"></span></div>`; }).join('');
    $('#tower').innerHTML = '';
    el.onclick = (e) => { const r = e.target.closest('.row'); if (r) selectDriver(+r.dataset.n === S.selected ? null : +r.dataset.n); };
  }
  // melhor volta global até T (roxo)
  let overallBest = Infinity;
  const info = new Map();
  for (const n of order) { const li = lapInfo(n, t); info.set(n, li); if (li.best && li.best.lap_duration < overallBest) overallBest = li.best.lap_duration; }
  let leaderLap = 0;
  order.forEach((n, i) => {
    const row = el.querySelector(`.row[data-n="${n}"]`);
    if (!row) return;
    const posRec = at(S.pos, n, t);
    const P = posRec?.position;
    const li = info.get(n);
    if (i === 0 && li.lap) leaderLap = li.lap;
    row.style.transform = `translateY(${i * ROW_H}px)`;
    row.classList.toggle('sel', n === S.selected);
    const pp = prevPos.get(n);
    if (pp && P && pp !== P) { row.classList.remove('up', 'down'); void row.offsetWidth; row.classList.add(P < pp ? 'up' : 'down'); }
    if (P) prevPos.set(n, P);
    row.querySelector('.p').textContent = P ?? '';
    const gapEl = row.querySelector('.gp'), lastEl = row.querySelector('.gap');
    const pitting = S.pits.some((p) => p.driver_number === n && p.t <= t && p.t + (p.pit_duration || 25) * 1000 >= t);
    if (S.isRace) {
      const iv = at(S.ints, n, t);
      const g = iv?.gap_to_leader, it = iv?.interval;
      const gs = i === 0 ? (li.lap ? `Volta ${li.lap}` : 'Líder') : g == null ? '' : typeof g === 'string' ? g : `+${g.toFixed(3)}`;
      const is = i === 0 ? '' : it == null ? '' : typeof it === 'string' ? it : `+${it.toFixed(3)}`;
      gapEl.innerHTML = pitting ? '<span class="chip yellow" style="padding:1px 7px">BOX</span>' : `${esc(is || gs)}${is && gs && i > 1 ? `<small>${esc(gs)}</small>` : ''}`;
    } else {
      const bestTop = info.get(order[0])?.best?.lap_duration;
      const b = li.best?.lap_duration;
      gapEl.innerHTML = pitting ? '<span class="chip yellow" style="padding:1px 7px">BOX</span>' : b ? `${fmt.lap(b)}${i > 0 && bestTop ? `<small>+${(b - bestTop).toFixed(3)}</small>` : ''}` : '<span class="muted">—</span>';
    }
    const lt = li.last?.lap_duration;
    lastEl.innerHTML = lt ? `<span style="color:${lt === overallBest ? 'var(--purple)' : li.best && lt === li.best.lap_duration ? 'var(--green)' : 'inherit'}">${fmt.lap(lt)}</span>` : '';
    const ty = tyreAt(n, li.lap || 1);
    row.querySelector('.ty').innerHTML = ty ? `<span class="tyre ${ty.compound}" title="${ty.compound} · ${ty.age} voltas">${tyreLetter(ty.compound)}</span>` : '';
  });
  // cabeçalho do mapa
  const st = trackStatus(t);
  $('#flag').className = `flag-banner flag-${st.k}`;
  $('#flag').textContent = st.label;
  $('#lapNo').textContent = S.isRace && leaderLap ? `VOLTA ${leaderLap}` : ptName(S.session.session_name).toUpperCase();
  updateFeeds(t);
  updateDriverPanel(t);
}

// ---------- Direcção de corrida, meteo, rádio ----------
function updateFeeds(t) {
  const msgs = S.rc.filter((m) => m.t <= t);
  if (msgs.length !== S.lastRCCount) {
    const isNew = S.lastRCCount >= 0 && msgs.length > S.lastRCCount;
    S.lastRCCount = msgs.length;
    $('#rc').innerHTML = msgs.slice(-40).reverse().map((m, i) => {
      const color = m.flag === 'RED' ? 'var(--red)' : /YELLOW/.test(m.flag || '') ? 'var(--yellow)' : m.flag === 'GREEN' || m.flag === 'CLEAR' ? 'var(--green)' : m.category === 'SafetyCar' ? 'var(--orange)' : m.flag === 'BLUE' ? 'var(--blue)' : 'var(--text-2)';
      return `<div class="it ${isNew && i === 0 ? 'new' : ''}"><span class="tm">${fmt.clock(m.t).slice(0, 8)}${m.lap_number ? `<br>V${m.lap_number}` : ''}</span><span style="border-left:3px solid ${color};padding-left:9px">${esc(m.message)}</span></div>`;
    }).join('') || '<p class="muted" style="padding:10px 0">Sem mensagens até este momento.</p>';
    const radios = S.radio.filter((r) => r.t <= t).slice(-12).reverse();
    $('#radio').innerHTML = radios.map((r) => { const d = S.drivers.get(r.driver_number); return `<div class="it"><span class="mono" style="min-width:60px;font-size:12.5px;color:var(--muted)">${fmt.clock(r.t).slice(0, 5)}</span><b style="min-width:42px;border-left:3px solid ${d?.color || '#888'};padding-left:6px">${esc(d?.acr || r.driver_number)}</b><audio controls preload="none" src="${esc(r.recording_url)}"></audio></div>`; }).join('') || '<p class="muted" style="padding:10px 0">Sem rádio até este momento.</p>';
  }
  const i = bisectT(S.weather, t);
  const w = i >= 0 ? S.weather[i] : S.weather[0];
  $('#weather').innerHTML = w ? [
    [`${fmt.num(w.air_temperature, 1)}°`, 'Ar'], [`${fmt.num(w.track_temperature, 1)}°`, 'Pista'], [`${fmt.num(w.humidity)}%`, 'Humidade'],
    [`${fmt.num(w.wind_speed, 1)} m/s`, 'Vento'], [`${['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round((w.wind_direction || 0) / 45) % 8]}`, 'Direcção'], [w.rainfall ? '🌧 Sim' : '☀ Não', 'Chuva'],
  ].map(([v, l]) => `<div class="w"><b>${v}</b><span>${l}</span></div>`).join('') : '<p class="muted">Sem dados meteorológicos.</p>';
}

// ---------- Painel do piloto seleccionado ----------
function selectDriver(n) {
  S.selected = n;
  $('#drvPanel').classList.toggle('hidden', !n);
  if (n) loadCar(n, S.T);
  updateTower(true);
  drawTrack();
}
async function loadCar(n, t) {
  const w = winIdx(t);
  const key = `${n}:${w}`;
  if (S.car.has(key) || S.carLoading.has(key)) return;
  S.carLoading.add(key);
  const from = S.tStart + w * WIN;
  try {
    const rows = await raw(q('car_data', { session_key: S.session.session_key, driver_number: n, 'date>': iso(from), 'date<': iso(from + WIN) }));
    S.car.set(key, rows.map((r) => ({ ...r, t: parseT(r.date) })).sort((a, b) => a.t - b.t));
    if (S.car.size > 40) S.car.delete(S.car.keys().next().value);
  } catch { /* */ } finally { S.carLoading.delete(key); }
}
const SEG = { 2048: 'var(--yellow)', 2049: 'var(--green)', 2051: 'var(--purple)', 2064: 'var(--blue)', 0: 'var(--surface-3)' };
function updateDriverPanel(t) {
  const n = S.selected;
  if (!n) return;
  const d = S.drivers.get(n);
  const w = winIdx(t);
  loadCar(n, t);
  if (t - (S.tStart + w * WIN) > WIN * 0.7) loadCar(n, t + WIN);
  const arr = S.car.get(`${n}:${w}`) || [];
  const i = bisectT(arr, t);
  const c = i >= 0 ? arr[i] : null;
  const li = lapInfo(n, t);
  const ty = tyreAt(n, li.lap || 1);
  const pits = S.pits.filter((p) => p.driver_number === n && p.t <= t).length;
  const segs = (l) => l ? [1, 2, 3].map((s) => `<div style="flex:1"><div class="muted" style="font-size:11px;font-weight:700">S${s} <span class="mono" style="color:var(--text)">${l['duration_sector_' + s] ? l['duration_sector_' + s].toFixed(3) : '—'}</span></div><div style="display:flex;gap:2px;margin-top:3px">${(l['segments_sector_' + s] || []).map((v) => `<i style="flex:1;height:6px;border-radius:2px;background:${SEG[v] || 'var(--surface-3)'}"></i>`).join('')}</div></div>`).join('') : '';
  const gauge = (label, v, max, col, unit = '') => `<div><div class="row-flex" style="justify-content:space-between;font-size:12px"><span class="muted" style="font-weight:700;text-transform:uppercase;letter-spacing:.06em">${label}</span><b class="mono">${v ?? '—'}${unit}</b></div><div style="height:6px;background:var(--surface-3);border-radius:4px;overflow:hidden;margin-top:3px"><i style="display:block;height:100%;width:${clamp(((v || 0) / max) * 100, 0, 100)}%;background:${col};transition:width .15s"></i></div></div>`;
  $('#drvPanel').innerHTML = `
    <div class="row-flex" style="gap:14px">
      ${d.headshot ? `<img src="${esc(d.headshot)}" alt="" style="width:62px;height:62px;border-radius:12px;background:var(--surface-3);object-fit:cover">` : ''}
      <div style="flex:1;min-width:0"><div style="font-weight:900;font-size:20px;line-height:1.1">${esc(d.name || d.acr)}</div><div class="muted" style="font-size:13.5px"><span style="color:${d.color}">■</span> ${esc(d.team || '')} · #${n}</div></div>
      <button class="btn small" id="closeDrv">✕</button>
    </div>
    <div class="grid g-2 mt" style="gap:12px">
      <div class="stat"><span class="v" style="font-size:40px">${c?.speed ?? '—'}<small class="muted" style="font-size:14px"> km/h</small></span><span class="l">Velocidade</span></div>
      <div class="stat"><span class="v" style="font-size:40px">${c ? (c.n_gear || 'N') : '—'}</span><span class="l">Mudança ${c && c.drs >= 10 ? '<span class="chip green">DRS</span>' : ''}</span></div>
    </div>
    <div class="grid mt-s" style="gap:8px">${gauge('Acelerador', c?.throttle, 100, 'var(--green)', '%')}${gauge('Travão', c ? (c.brake > 0 ? 100 : 0) : null, 100, 'var(--red)', c?.brake > 0 ? '' : '')}${gauge('RPM', c?.rpm, 13000, 'var(--blue)')}</div>
    <div class="row-flex mt" style="font-size:14px;gap:16px"><span>Volta <b class="mono">${li.lap ?? '—'}</b></span><span>Melhor <b class="mono">${fmt.lap(li.best?.lap_duration)}</b></span><span>Pneu ${ty ? `<span class="tyre ${ty.compound}" style="vertical-align:middle">${tyreLetter(ty.compound)}</span> <b class="mono">${ty.age}v</b>` : '—'}</span><span>Paragens <b class="mono">${pits}</b></span></div>
    ${li.last ? `<div class="mt-s"><div class="muted" style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Última volta · ${fmt.lap(li.last.lap_duration)} ${li.last.st_speed ? `· speed trap ${li.last.st_speed} km/h` : ''}</div><div style="display:flex;gap:10px">${segs(li.last)}</div></div>` : ''}`;
  $('#closeDrv').onclick = () => selectDriver(null);
}

// ---------- Leitor / scrubber ----------
function setupScrubber() {
  const r = $('#scrub');
  r.min = 0; r.max = Math.round((S.tEnd - S.tStart) / 1000); r.value = Math.round((S.T - S.tStart) / 1000);
  $('#liveBtn').classList.toggle('hidden', !S.live);
  updatePlayer();
}
function updatePlayer() {
  $('#scrub').value = Math.round((S.T - S.tStart) / 1000);
  $('#clock').textContent = fmt.clock(S.T);
  $('#playBtn').innerHTML = S.playing ? '❚❚' : '▶';
  $('#liveBtn').classList.toggle('primary', S.followLive);
}
let lastFrame = 0, lastEnsure = 0;
function loop(ts) {
  const dt = lastFrame ? Math.min(ts - lastFrame, 250) : 0;
  lastFrame = ts;
  if (S.session) {
    if (S.followLive) {
      S.T = Date.now() - LIVE_DELAY;
      S.tEnd = Math.max(S.tEnd, Date.now());
      $('#scrub').max = Math.round((S.tEnd - S.tStart) / 1000);
    } else if (S.playing) {
      S.T += dt * S.speed;
      if (S.T >= S.tEnd) { S.T = S.tEnd; S.playing = false; }
    }
    if (ts - lastEnsure > 700) { lastEnsure = ts; ensureWindows(); }
    drawTrack();
    updateTower();
    if (S.playing || S.followLive) updatePlayer();
  }
  requestAnimationFrame(loop);
}

// Em directo: actualizar endpoints incrementais
async function livePoll() {
  while (true) {
    await sleep(6000);
    if (!S.session || !S.live) continue;
    const K = S.session.session_key;
    const token = S.token;
    const since = iso(Date.now() - 20_000);
    try {
      const [pos, ints, rc, wx, radio, pits, stints, laps] = await Promise.all([
        raw(q('position', { session_key: K, 'date>': since })), S.isRace ? raw(q('intervals', { session_key: K, 'date>': since })) : [],
        raw(q('race_control', { session_key: K, 'date>': since })), raw(q('weather', { session_key: K, 'date>': since })),
        raw(q('team_radio', { session_key: K, 'date>': since })), raw(q('pit', { session_key: K, 'date>': since })),
        raw(q('stints', { session_key: K })), raw(q('laps', { session_key: K, 'date_start>': iso(Date.now() - 300_000) })),
      ]);
      if (token !== S.token) continue;
      mergeGrouped(S.pos, pos); mergeGrouped(S.ints, ints);
      mergeGrouped(S.laps, laps.map((l) => ({ ...l, date: l.date_start })).filter((l) => l.date));
      // voltas já existentes podem ganhar lap_duration mais tarde
      for (const l of laps) { const arr = S.laps.get(l.driver_number); const ex = arr?.find((x) => x.lap_number === l.lap_number); if (ex) Object.assign(ex, l); }
      const addT = (list, rows) => { const seen = new Set(list.map((x) => x.date + (x.message || x.recording_url || x.driver_number))); for (const r of rows) { const k = r.date + (r.message || r.recording_url || r.driver_number); if (!seen.has(k)) list.push({ ...r, t: parseT(r.date) }); } list.sort((a, b) => a.t - b.t); };
      addT(S.rc, rc); addT(S.weather, wx); addT(S.radio, radio); addT(S.pits, pits);
      if (stints.length) S.stints = stints;
      S.lastRCCount = -1;
    } catch (e) { if (e.auth) { S.live = false; showAuthOrError(e); } }
  }
}

// ---------- Análise (gráficos) ----------
function positionsByLap() {
  const out = new Map();
  for (const [n, laps] of S.laps) {
    const arr = [];
    for (const l of laps) { if (!l.t) continue; const p = at(S.pos, n, l.t + 1000); if (p) arr.push({ lap: l.lap_number, pos: p.position }); }
    if (arr.length) out.set(n, arr);
  }
  return out;
}
let analysisTab = 'pos';
function renderAnalysis() {
  const el = $('#anaBody');
  const order = towerOrder(S.tEnd);
  const flat = [...S.laps.values()].flat();
  const totalLaps = Math.max(0, ...flat.map((l) => l.lap_number || 0));
  if (!flat.length) { el.innerHTML = '<p class="muted">Sem dados de voltas para esta sessão.</p>'; return; }
  if (analysisTab === 'pos') {
    if (!S.isRace) { el.innerHTML = '<p class="muted">O gráfico de posições por volta está disponível para corridas e sprints. Veja os tempos por volta.</p>'; return; }
    positionChart(el, positionsByLap(), S.drivers, order);
  } else if (analysisTab === 'laps') lapTimeChart(el, flat, S.drivers, { order });
  else strategyChart(el, S.stints, order, S.drivers, totalLaps);
}

// ---------- Página ----------
init(async () => {
  const app = $('#app');
  const NOW_Y = new Date().getFullYear();
  app.innerHTML = `
    <section class="page-hero container" style="padding-bottom:0">
      <div class="row-flex" style="justify-content:space-between">
        <div><h1>Ao <em>Vivo</em></h1><p>Mapa da pista em tempo real, torre de tempos, pneus, rádio das equipas e direcção de corrida. Fora das sessões, reveja qualquer sessão desde 2023 em modo replay.</p></div>
      </div>
      <div class="controls mt">
        <select class="select" id="yearSel" aria-label="Ano">${Array.from({ length: NOW_Y - 2022 }, (_, i) => NOW_Y - i).map((y) => `<option>${y}</option>`).join('')}</select>
        <select class="select" id="meetSel" aria-label="Grande Prémio" style="min-width:220px"></select>
        <select class="select" id="sessSel" aria-label="Sessão"></select>
        <span id="status" class="muted" style="font-size:14px"></span>
      </div>
    </section>
    <section class="section container" style="padding-top:18px">
      <div id="officialLive" class="mb"></div>
      <div class="row-flex mb"><h2 id="sessTitle" style="font-size:22px">—</h2><span id="liveChip"></span></div>
      <div class="live-layout">
        <div>
          <div class="track-box">
            <canvas id="track"></canvas>
            <div class="track-overlay"><span id="flag" class="flag-banner flag-GREEN">—</span><span class="lapbig" id="lapNo">—</span></div>
          </div>
          <div class="player mt-s">
            <button class="btn icon" id="back" title="-10 s">↺</button>
            <button class="btn icon primary" id="playBtn" title="Reproduzir / pausa">▶</button>
            <button class="btn icon" id="fwd" title="+10 s">↻</button>
            <span class="clock" id="clock">--:--:--</span>
            <input type="range" id="scrub" min="0" max="100" value="0" aria-label="Linha temporal">
            <select class="select" id="speed" aria-label="Velocidade">${[1, 2, 4, 8, 16, 32].map((s) => `<option value="${s}">${s}×</option>`).join('')}</select>
            <button class="btn small hidden" id="liveBtn">● DIRECTO</button>
          </div>
          <div class="card mt-s hidden" id="drvPanel"></div>
          <div class="grid g-2 mt-s">
            <div class="card"><div class="card-title">Direcção de corrida</div><div class="feed" id="rc"></div></div>
            <div class="card"><div class="card-title">Meteorologia</div><div class="weather" id="weather"></div>
              <div class="card-title mt">Rádio das equipas</div><div class="feed radio" id="radio"></div></div>
          </div>
        </div>
        <div class="card flush" style="align-self:start">
          <div class="timing">
            <div class="row hd"><span>P</span><span></span><span>Piloto</span><span id="gapHd">Intervalo</span><span style="text-align:right">Última</span><span></span></div>
            <div id="tower"></div>
            <div id="towerRows" style="position:relative"></div>
          </div>
          <p class="muted" style="font-size:12.5px;padding:10px 12px">Clique num piloto (aqui ou no mapa) para ver velocidade, mudança, acelerador, travão e mini-sectores.</p>
        </div>
      </div>
      <div class="card mt">
        <div class="row-flex mb" style="justify-content:space-between"><div class="card-title" style="margin:0">Análise da sessão</div>
          <div class="tabs" id="anaTabs"><button class="tab active" data-tab="pos">Posições por volta</button><button class="tab" data-tab="laps">Tempos por volta</button><button class="tab" data-tab="tyres">Estratégia de pneus</button></div></div>
        <div id="anaBody">${skeleton(6)}</div>
      </div>
      <p class="muted mt" style="font-size:13px">Dados: OpenF1 (gratuito para sessões terminadas; dados em tempo real exigem conta paga na OpenF1). Posições no mapa a ~4 Hz, interpoladas.</p>
    </section>`;

  mountOfficialLive($('#officialLive'));
  setupCanvas();
  requestAnimationFrame(loop);
  livePoll();

  $('#anaTabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (!b) return; $$('#anaTabs .tab').forEach((t) => t.classList.toggle('active', t === b)); analysisTab = b.dataset.tab; renderAnalysis(); });
  $('#playBtn').onclick = () => { S.followLive = false; S.playing = !S.playing; if (S.T >= S.tEnd) S.T = S.tStart; updatePlayer(); };
  $('#back').onclick = () => { S.followLive = false; S.T = clamp(S.T - 10_000, S.tStart, S.tEnd); updatePlayer(); updateTower(true); };
  $('#fwd').onclick = () => { S.followLive = false; S.T = clamp(S.T + 10_000, S.tStart, S.tEnd); updatePlayer(); updateTower(true); };
  $('#speed').onchange = (e) => { S.speed = +e.target.value; };
  $('#liveBtn').onclick = () => { S.followLive = !S.followLive; if (S.followLive) S.playing = false; updatePlayer(); };
  $('#scrub').oninput = (e) => { S.followLive = false; S.T = S.tStart + e.target.value * 1000; $('#clock').textContent = fmt.clock(S.T); updateTower(true); };
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input,select,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); $('#playBtn').click(); }
    if (e.code === 'ArrowLeft') $('#back').click();
    if (e.code === 'ArrowRight') $('#fwd').click();
  });

  let meetings = [];
  const fillSessions = (mk, wantKey) => {
    const m = meetings.find(([k]) => String(k) === String(mk));
    if (!m) return;
    $('#sessSel').innerHTML = m[1].sessions.map((s) => `<option value="${s.session_key}" ${String(s.session_key) === String(wantKey) ? 'selected' : ''}>${esc(ptName(s.session_name))} · ${esc(fmt.weekday(parseT(s.date_start)))}</option>`).join('');
    if (!wantKey) { const race = m[1].sessions.findLast((s) => parseT(s.date_start) < Date.now()); if (race) $('#sessSel').value = race.session_key; }
  };
  const loadYear = async (y, want = {}) => {
    $('#meetSel').innerHTML = '<option>A carregar…</option>';
    try { meetings = await loadSessionList(y); } catch (e) { $('#status').textContent = 'OpenF1 indisponível: ' + e.message; meetings = []; return; }
    $('#meetSel').innerHTML = meetings.map(([k, v]) => `<option value="${k}">${flagTextCountry(v.meeting.country_name)} ${esc(v.meeting.meeting_name)}</option>`).join('');
    let mk = want.meeting ?? meetings.at(-1)?.[0];
    if (want.date) {
      const target = Date.parse(want.date);
      const hit = meetings.find(([, v]) => v.sessions.some((s) => Math.abs(parseT(s.date_start) - target) < 2 * 86400e3 && /Race/.test(s.session_name)));
      if (hit) mk = hit[0];
    }
    $('#meetSel').value = mk;
    fillSessions(mk, want.session);
    if (want.date) { const m = meetings.find(([k]) => k === mk); const race = m?.[1].sessions.find((s) => s.session_name === 'Race'); if (race) $('#sessSel').value = race.session_key; }
  };
  const start = () => {
    const m = meetings.find(([k]) => String(k) === $('#meetSel').value);
    const s = m?.[1].sessions.find((x) => String(x.session_key) === $('#sessSel').value);
    if (s) { $('#gapHd').textContent = /qual|practice|shootout/i.test(s.session_name) ? 'Melhor volta' : 'Intervalo'; loadSession(s, m[1].meeting); }
  };
  $('#yearSel').onchange = async (e) => { await loadYear(+e.target.value); start(); };
  $('#meetSel').onchange = () => { fillSessions($('#meetSel').value); start(); };
  $('#sessSel').onchange = start;

  // escolha inicial: sessão em directo > ?s= > ?d= > última sessão
  const wantS = qs('s'), wantD = qs('d');
  let year = NOW_Y, want = {};
  try {
    if (wantS) {
      const [s] = await getJSON(q('sessions', { session_key: wantS }), { ttl: 3600 });
      if (s) { year = s.year; want = { meeting: s.meeting_key, session: s.session_key }; }
    } else if (wantD) { year = +wantD.slice(0, 4); want = { date: wantD }; }
    else {
      // sessão em directo, senão a última corrida/sessão já terminada (essas têm sempre dados)
      const live = await currentLiveSession().catch(() => null);
      let s = live;
      if (!s) {
        let all = await getJSON(q('sessions', { year: NOW_Y }), { ttl: 1800 }).catch(() => []);
        let done = all.filter((x) => parseT(x.date_end) < Date.now() - 3600e3);
        if (!done.length) { all = await getJSON(q('sessions', { year: NOW_Y - 1 }), { ttl: 86400 }).catch(() => []); done = all.filter((x) => parseT(x.date_end) < Date.now() - 3600e3); }
        done.sort((a, b) => parseT(a.date_start) - parseT(b.date_start));
        const lastMeeting = done.at(-1)?.meeting_key;
        s = done.filter((x) => x.meeting_key === lastMeeting).findLast((x) => /Race|Qualifying/.test(x.session_name)) || done.at(-1);
      }
      if (s) { year = s.year; want = { meeting: s.meeting_key, session: s.session_key }; }
    }
  } catch { /* */ }
  $('#yearSel').value = year;
  await loadYear(year, want);
  start();
});

})();
