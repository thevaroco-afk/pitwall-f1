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

// ---- telemetry.js ----
// =========================================================
// TELEMETRIA — FastF1 (exportado) ou OpenF1 (2023+)
// =========================================================




const API = CONFIG.openf1;
const MAX_SEL = 4;
const q = (path, params) => `${API}/${path}?${Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
const iso = (ms) => new Date(ms).toISOString().slice(0, 23);

const S = { source: null, sess: null, sel: [], lapChoice: new Map(), laps: new Map(), mapMode: 'dominance', group: new ChartGroup(), cursorD: null };

// ---------- utilitários numéricos ----------
function interp(xs, ys, x) {
  if (!xs.length) return null;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const f = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * f;
}

// ---------- Fonte: FastF1 ----------
const FastF1 = {
  async index() { const d = await getLocal(`${CONFIG.telemetryData}/index.json`); return d?.sessions?.length ? d.sessions : null; },
  async load(id) {
    const m = await getLocal(`${CONFIG.telemetryData}/${id}/meta.json`);
    if (!m) throw new Error('meta.json não encontrado');
    const drivers = new Map(m.drivers.filter((d) => m.telemetryDrivers.includes(d.abbr)).map((d) => [d.abbr, { key: d.abbr, acr: d.abbr, name: d.name, team: d.team, color: hex(d.color), bestLap: d.bestLap, bestLapNumber: d.bestLapNumber, position: d.position, headshot: d.headshot }]));
    const laps = m.laps.map((l) => ({ key: l.d, n: l.n, t: l.t, s1: l.s1, s2: l.s2, s3: l.s3, compound: l.c, life: l.life, stint: l.stint, pitOut: l.pitOut, pitIn: l.pitIn, deleted: l.del }));
    return { id, title: `${flagCountry(m.country)} ${m.event} · ${m.sessionName} ${m.year}`, drivers, laps, corners: m.circuit?.corners || [], rotation: m.circuit?.rotation || 0, allLaps: m.lapsMode === 'all', raw: m, isRace: /Race|Sprint$/.test(m.session) };
  },
  async lap(sess, key, which) {
    const file = await getLocal(`${CONFIG.telemetryData}/${sess.id}/${key}.json`);
    if (!file) throw new Error('sem telemetria');
    const k = which === 'fastest' ? 'fastest' : `lap${which}`;
    const L = file.laps[k] || file.laps.fastest;
    return { ...L, t: L.t.map((v) => v - L.t[0]) };
  },
};

// ---------- Fonte: OpenF1 ----------
const OpenF1 = {
  async sessions(year) {
    const [ss, ms] = await Promise.all([getJSON(q('sessions', { year }), { ttl: 1800 }), getJSON(q('meetings', { year }), { ttl: 3600 }).catch(() => [])]);
    const mm = new Map(ms.map((m) => [m.meeting_key, m]));
    return ss.filter((s) => parseT(s.date_end) < Date.now()).map((s) => ({ ...s, meeting: mm.get(s.meeting_key) })).filter((s) => !/test/i.test(s.meeting?.meeting_name || ''));
  },
  async load(s) {
    const K = s.session_key;
    const [drv, laps, stints] = await Promise.all([getJSON(q('drivers', { session_key: K }), { ttl: 86400 }), getJSON(q('laps', { session_key: K }), { ttl: 86400 }), getJSON(q('stints', { session_key: K }), { ttl: 86400 }).catch(() => [])]);
    const stintOf = (num, lap) => stints.find((x) => x.driver_number === num && lap >= x.lap_start && lap <= (x.lap_end || 999));
    const L = laps.map((l) => { const st = stintOf(l.driver_number, l.lap_number); return { key: l.driver_number, n: l.lap_number, t: l.lap_duration, s1: l.duration_sector_1, s2: l.duration_sector_2, s3: l.duration_sector_3, compound: st?.compound, life: st ? (st.tyre_age_at_start || 0) + l.lap_number - st.lap_start : null, stint: st?.stint_number, pitOut: l.is_pit_out_lap, date: l.date_start, st: l.st_speed }; });
    const drivers = new Map();
    for (const d of drv) {
      const my = L.filter((l) => l.key === d.driver_number && l.t && !l.pitOut);
      const best = my.sort((a, b) => a.t - b.t)[0];
      drivers.set(d.driver_number, { key: d.driver_number, acr: d.name_acronym, name: d.full_name, team: d.team_name, color: hex(d.team_colour || '888888'), bestLap: best?.t, bestLapNumber: best?.n, headshot: d.headshot_url });
    }
    for (const [k, d] of drivers) if (!d.bestLap) drivers.delete(k);
    const order = [...drivers.values()].sort((a, b) => a.bestLap - b.bestLap);
    return { id: K, title: `${flagCountry(s.country_name)} ${s.meeting?.meeting_name || s.country_name} · ${s.session_name} ${s.year}`, drivers: new Map(order.map((d) => [d.key, d])), laps: L, stints, corners: [], rotation: 0, allLaps: true, isRace: s.session_type === 'Race' };
  },
  async lap(sess, key, which) {
    const n = which === 'fastest' ? sess.drivers.get(key).bestLapNumber : +which;
    const lap = sess.laps.find((l) => l.key === key && l.n === n);
    if (!lap?.date || !lap.t) throw new Error('volta sem dados');
    const t0 = parseT(lap.date), t1 = t0 + lap.t * 1000;
    const [car, loc] = await Promise.all([
      getJSON(q('car_data', { session_key: sess.id, driver_number: key, 'date>': iso(t0 - 300), 'date<': iso(t1 + 300) }), { ttl: 86400 }),
      getJSON(q('location', { session_key: sess.id, driver_number: key, 'date>': iso(t0 - 300), 'date<': iso(t1 + 300) }), { ttl: 86400 }),
    ]);
    const C = car.map((c) => ({ ...c, ms: parseT(c.date) })).sort((a, b) => a.ms - b.ms);
    const P = loc.filter((p) => p.x || p.y).map((p) => ({ ...p, ms: parseT(p.date) })).sort((a, b) => a.ms - b.ms);
    if (C.length < 10) throw new Error('sem car_data');
    // distância por integração da velocidade, normalizada para começar em t0
    const out = { d: [], t: [], speed: [], throttle: [], brake: [], gear: [], rpm: [], drs: [], x: [], y: [], lap: n, lapTime: lap.t, compound: lap.compound };
    let dist = 0, prev = null;
    const px = P.map((p) => p.ms), xs = P.map((p) => p.x), ys = P.map((p) => p.y);
    for (const c of C) {
      if (c.ms < t0 || c.ms > t1) continue;
      if (prev) dist += ((prev.speed + c.speed) / 2 / 3.6) * ((c.ms - prev.ms) / 1000);
      prev = c;
      out.d.push(+dist.toFixed(1)); out.t.push((c.ms - t0) / 1000);
      out.speed.push(c.speed); out.throttle.push(clamp(c.throttle, 0, 100)); out.brake.push(c.brake > 0 ? 100 : 0); out.gear.push(c.n_gear); out.rpm.push(c.rpm); out.drs.push(c.drs >= 10 ? 1 : 0);
      out.x.push(P.length ? interp(px, xs, c.ms) : null); out.y.push(P.length ? interp(px, ys, c.ms) : null);
    }
    return out;
  },
};

// ---------- Selecção e carregamento ----------
async function getLap(key) {
  const which = S.lapChoice.get(key) || 'fastest';
  const ck = `${S.sess.id}|${key}|${which}`;
  if (!S.laps.has(ck)) S.laps.set(ck, S.source.lap(S.sess, key, which).catch((e) => { S.laps.delete(ck); throw e; }));
  return S.laps.get(ck);
}

function renderPicker() {
  const el = $('#drvPick');
  el.innerHTML = [...S.sess.drivers.values()].map((d) => {
    const on = S.sel.includes(d.key);
    return `<button data-k="${d.key}" class="${on ? 'on' : ''}" style="${on ? `color:${d.color}` : ''}" ${!on && S.sel.length >= MAX_SEL ? 'disabled' : ''}><i style="background:${d.color}"></i><span style="color:var(--text)">${esc(d.acr)}</span><span class="mono muted" style="font-size:11.5px">${fmt.lap(d.bestLap)}</span></button>`;
  }).join('');
}

async function analyse() {
  setQs({ drv: S.sel.join(',') });
  renderPicker();
  const body = $('#teleBody');
  S.group.clear();
  if (!S.sel.length) { body.innerHTML = `<div class="card">${errorBox('Escolha até 4 pilotos para comparar.')}</div>`; return; }
  body.innerHTML = `<div class="card">${skeleton(10)}</div>`;
  const results = await Promise.allSettled(S.sel.map(getLap));
  const L = [];
  results.forEach((r, i) => { if (r.status === 'fulfilled' && r.value?.d?.length) L.push({ drv: S.sess.drivers.get(S.sel[i]), data: r.value }); });
  if (!L.length) { body.innerHTML = `<div class="card">${errorBox('Não há telemetria para estas voltas.', results.find((r) => r.status === 'rejected')?.reason?.message)}</div>`; return; }

  // companheiros de equipa têm a mesma cor: usar cores alternativas
  const ALT = ['#ffffff', '#ffd60a', '#b14cff', '#22d36b'];
  const used = new Set();
  for (const l of L) { if (used.has(l.drv.color.toLowerCase())) l.drv = { ...l.drv, color: ALT.find((c) => !used.has(c)) }; used.add(l.drv.color.toLowerCase()); }
  // normalizar distância à volta de referência (primeiro piloto)
  const ref = L[0];
  const refLen = ref.data.d.at(-1);
  for (const l of L) { const k = refLen / (l.data.d.at(-1) || refLen); l.nd = l.data.d.map((v) => v * k); }
  // delta face à referência
  for (const l of L.slice(1)) l.delta = ref.nd.map((d, i) => interp(l.nd, l.data.t, d) - ref.data.t[i]);

  const stats = (l) => {
    const sp = l.data.speed; const n = sp.length;
    const ft = l.data.throttle.filter((v) => v >= 98).length / n;
    const br = l.data.brake.filter((v) => v > 0).length / n;
    const drs = l.data.drs.filter((v) => v).length / n;
    let shifts = 0; for (let i = 1; i < n; i++) if (l.data.gear[i] !== l.data.gear[i - 1]) shifts++;
    return { vmax: Math.max(...sp), vavg: sp.reduce((a, b) => a + b, 0) / n, ft, br, drs, shifts, vmin: Math.min(...sp.filter((v) => v > 30)) };
  };
  const lapOpts = (key) => {
    const my = S.sess.laps.filter((l) => l.key === key && l.t).sort((a, b) => a.n - b.n);
    const cur = S.lapChoice.get(key) || 'fastest';
    const opts = [`<option value="fastest" ${cur === 'fastest' ? 'selected' : ''}>Volta mais rápida</option>`];
    if (S.sess.allLaps) for (const l of my) opts.push(`<option value="${l.n}" ${String(cur) === String(l.n) ? 'selected' : ''}>V${l.n} · ${fmt.lap(l.t)}${l.compound ? ' · ' + tyreLetter(l.compound) : ''}${l.pitOut ? ' · saída box' : ''}</option>`);
    return opts.join('');
  };
  const sectors = (l) => S.sess.laps.find((x) => x.key === l.drv.key && x.n === l.data.lap) || {};
  const bestSec = [1, 2, 3].map((i) => Math.min(...L.map((l) => sectors(l)['s' + i] || Infinity)));

  body.innerHTML = `
    <div class="tele-head">${L.map((l, i) => { const s = sectors(l); const st = stats(l); return `<div class="d" style="border-color:${l.drv.color}">
      <div class="row-flex" style="justify-content:space-between"><span class="n">${esc(l.drv.name || l.drv.acr)}</span>${l.data.compound ? `<span class="tyre ${l.data.compound}">${tyreLetter(l.data.compound)}</span>` : ''}</div>
      <div class="lt">${fmt.lap(l.data.lapTime)} ${i > 0 ? `<span style="font-size:15px;color:${l.data.lapTime - ref.data.lapTime > 0 ? 'var(--red)' : 'var(--green)'}">${l.data.lapTime - ref.data.lapTime > 0 ? '+' : ''}${(l.data.lapTime - ref.data.lapTime).toFixed(3)}</span>` : '<span class="chip" style="vertical-align:middle">REF</span>'}</div>
      <div class="sx">${[1, 2, 3].map((k) => `<span style="color:${s['s' + k] && s['s' + k] === bestSec[k - 1] ? 'var(--purple)' : 'inherit'}">S${k} ${s['s' + k] ? s['s' + k].toFixed(3) : '—'}</span>`).join('')}</div>
      <div class="sx mt-s"><span>Vmáx ${fmt.num(st.vmax)} km/h</span><span>Vméd ${fmt.num(st.vavg)} km/h</span></div>
      <select class="select mt-s lapSel" data-k="${l.drv.key}" style="width:100%;min-height:34px;padding:5px 30px 5px 10px;font-size:13.5px">${lapOpts(l.drv.key)}</select>
    </div>`; }).join('')}</div>
    <div class="grid g-main mt">
      <div class="card"><div class="card-title">Mapa do circuito <span class="right"><span class="tabs" id="mapMode" style="display:inline-flex"><button class="tab ${S.mapMode === 'dominance' ? 'active' : ''}" data-tab="dominance">Domínio</button><button class="tab ${S.mapMode === 'speed' ? 'active' : ''}" data-tab="speed">Velocidade</button><button class="tab ${S.mapMode === 'gear' ? 'active' : ''}" data-tab="gear">Mudanças</button></span></span></div>
        <div class="track-box" style="aspect-ratio:16/11"><canvas id="teleMap"></canvas></div><div class="legend" id="mapLegend"></div></div>
      <div class="card"><div class="card-title">Resumo da volta</div><div class="table-wrap"><table class="t" style="font-size:14px"><thead><tr><th></th>${L.map((l) => `<th class="r" style="color:${l.drv.color}">${esc(l.drv.acr)}</th>`).join('')}</tr></thead><tbody>
        ${[['Velocidade máx.', (s) => fmt.num(s.vmax) + ' km/h'], ['Velocidade média', (s) => fmt.num(s.vavg, 1) + ' km/h'], ['Velocidade mín.', (s) => fmt.num(s.vmin) + ' km/h'], ['Acelerador a fundo', (s) => fmt.num(s.ft * 100, 1) + '%'], ['A travar', (s) => fmt.num(s.br * 100, 1) + '%'], ['DRS aberto', (s) => fmt.num(s.drs * 100, 1) + '%'], ['Mudanças de caixa', (s) => s.shifts]].map(([lbl, f]) => `<tr><td class="muted">${lbl}</td>${L.map((l) => `<td class="r mono">${f(stats(l))}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>
      <p class="muted mt-s" style="font-size:12.5px">Distâncias normalizadas à volta de referência (${esc(ref.drv.acr)}: ${fmt.num(refLen)} m). Arraste nos gráficos para ampliar, duplo-clique para repor.</p></div>
    </div>
    <div class="card mt"><div class="card-title">Velocidade (km/h)</div><div id="cSpeed"></div></div>
    ${L.length > 1 ? `<div class="card mt-s"><div class="card-title">Delta para ${esc(ref.drv.acr)} (s) <span class="right muted">acima de zero = mais lento</span></div><div id="cDelta"></div></div>` : ''}
    <div class="grid g-2 mt-s"><div class="card"><div class="card-title">Acelerador (%)</div><div id="cThr"></div></div><div class="card"><div class="card-title">Travão</div><div id="cBrk"></div></div></div>
    <div class="grid g-2 mt-s"><div class="card"><div class="card-title">Mudança engrenada</div><div id="cGear"></div></div><div class="card"><div class="card-title">RPM</div><div id="cRpm"></div></div></div>`;

  const xF = (v) => `${(v / 1000).toFixed(1)} km`;
  const markers = (S.sess.corners || []).map((c) => ({ x: c.dist, label: `${c.n}${c.l || ''}` }));
  const mk = (id, key, opts = {}) => {
    const el = $('#' + id); if (!el) return;
    const series = L.map((l) => ({ name: l.drv.acr, color: l.drv.color, xs: l.nd, ys: l.data[key], width: 1.6 }));
    const c = new LineChart(el, series, { xFormat: xF, legend: false, onCursor: (x) => { S.cursorD = x; drawMap(L); }, tipTitle: (x) => xF(x), ...opts });
    S.group.add(c);
  };
  mk('cSpeed', 'speed', { height: 280, yFormat: (v) => Math.round(v), markers });
  if (L.length > 1) {
    const el = $('#cDelta');
    const c = new LineChart(el, L.slice(1).map((l) => ({ name: l.drv.acr, color: l.drv.color, xs: ref.nd, ys: l.delta, width: 2 })), { height: 170, xFormat: xF, yFormat: (v) => (v > 0 ? '+' : '') + v.toFixed(2), zeroLine: true, legend: false, onCursor: (x) => { S.cursorD = x; drawMap(L); }, tipTitle: (x) => xF(x) });
    S.group.add(c);
  }
  mk('cThr', 'throttle', { height: 150, yMin: 0, yMax: 100, yFormat: (v) => Math.round(v) });
  mk('cBrk', 'brake', { height: 150, yMin: 0, yMax: 100, step: true, yFormat: (v) => (v > 0 ? 'ON' : 'OFF'), yTicks: [0, 100] });
  mk('cGear', 'gear', { height: 150, yMin: 0, yMax: 8.5, step: true, yFormat: (v) => Math.round(v), yTicks: [1, 2, 3, 4, 5, 6, 7, 8] });
  mk('cRpm', 'rpm', { height: 150, yFormat: (v) => fmt.num(v) });

  $$('.lapSel', body).forEach((s) => s.addEventListener('change', () => { S.lapChoice.set(isNaN(+s.dataset.k) ? s.dataset.k : +s.dataset.k, s.value); analyse(); }));
  $('#mapMode').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (!b) return; S.mapMode = b.dataset.tab; $$('#mapMode .tab').forEach((t) => t.classList.toggle('active', t === b)); drawMap(L); });
  const cv = $('#teleMap');
  new ResizeObserver(() => drawMap(L)).observe(cv);
  drawMap(L);
}

// ---------- Mapa ----------
function speedColor(v, min, max) { const f = clamp((v - min) / (max - min || 1), 0, 1); return `hsl(${240 - f * 240} 90% ${45 + f * 10}%)`; }
const GEAR_COL = ['#444', '#6a00ff', '#3b5bff', '#00a6ff', '#00d18f', '#7bd300', '#ffd000', '#ff7a00', '#ff1e2d'];
function drawMap(L) {
  const cv = $('#teleMap'); if (!cv || !L.length) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = cv.clientWidth, H = cv.clientHeight; if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const ref = L[0];
  const X = ref.data.x, Y = ref.data.y;
  if (!X?.length || X[0] == null) { ctx.fillStyle = '#7d7d92'; ctx.font = '14px Titillium Web'; ctx.fillText('Sem coordenadas para esta volta.', 16, 24); return; }
  const rot = ((S.sess.rotation || 0) * Math.PI) / 180;
  const R = (x, y) => [x * Math.cos(rot) - y * Math.sin(rot), x * Math.sin(rot) + y * Math.cos(rot)];
  const P = X.map((x, i) => R(x, Y[i]));
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const pad = 30, sc = Math.min((W - pad * 2) / (x1 - x0), (H - pad * 2) / (y1 - y0));
  const ox = (W - (x1 - x0) * sc) / 2, oy = (H - (y1 - y0) * sc) / 2;
  const T = ([x, y]) => [ox + (x - x0) * sc, H - (oy + (y - y0) * sc)];
  const S2 = P.map(T);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000'; ctx.lineWidth = 13; ctx.beginPath(); S2.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
  const legend = $('#mapLegend');
  ctx.lineWidth = 7;
  if (S.mapMode === 'dominance' && L.length > 1) {
    const N = 25, len = ref.nd.at(-1);
    const winners = [];
    for (let k = 0; k < N; k++) {
      const a = (len * k) / N, b = (len * (k + 1)) / N;
      let best = null;
      for (const l of L) { const dt = interp(l.nd, l.data.t, b) - interp(l.nd, l.data.t, a); if (!best || dt < best.dt) best = { l, dt }; }
      winners.push(best.l);
    }
    for (let i = 1; i < S2.length; i++) {
      const k = Math.min(N - 1, Math.floor((ref.nd[i] / len) * N));
      ctx.strokeStyle = winners[k].drv.color; ctx.beginPath(); ctx.moveTo(...S2[i - 1]); ctx.lineTo(...S2[i]); ctx.stroke();
    }
    const cnt = new Map(); winners.forEach((w) => cnt.set(w.drv.acr, (cnt.get(w.drv.acr) || 0) + 1));
    legend.innerHTML = L.map((l) => `<span><i style="background:${l.drv.color}"></i>${esc(l.drv.acr)} · ${cnt.get(l.drv.acr) || 0}/${N} mini-sectores</span>`).join('');
  } else if (S.mapMode === 'gear') {
    for (let i = 1; i < S2.length; i++) { ctx.strokeStyle = GEAR_COL[ref.data.gear[i]] || '#888'; ctx.beginPath(); ctx.moveTo(...S2[i - 1]); ctx.lineTo(...S2[i]); ctx.stroke(); }
    legend.innerHTML = GEAR_COL.slice(1).map((c, i) => `<span><i style="background:${c}"></i>${i + 1}ª</span>`).join('') + `<span class="muted">· ${esc(ref.drv.acr)}</span>`;
  } else {
    const sp = ref.data.speed, mn = Math.min(...sp), mx = Math.max(...sp);
    for (let i = 1; i < S2.length; i++) { ctx.strokeStyle = speedColor(sp[i], mn, mx); ctx.beginPath(); ctx.moveTo(...S2[i - 1]); ctx.lineTo(...S2[i]); ctx.stroke(); }
    legend.innerHTML = `<span><i style="background:linear-gradient(90deg,hsl(240 90% 45%),hsl(120 90% 50%),hsl(0 90% 55%));width:80px"></i>${fmt.num(mn)} → ${fmt.num(mx)} km/h · ${esc(ref.drv.acr)}</span>`;
  }
  // curvas
  ctx.font = '700 10.5px JetBrains Mono'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (const c of S.sess.corners || []) {
    const [rx, ry] = R(c.x, c.y);
    const ang = Math.atan2(ry - cy, rx - cx);
    const [sx, sy] = T([rx + Math.cos(ang) * 0, ry + Math.sin(ang) * 0]);
    const ox2 = Math.cos(ang) * 16, oy2 = -Math.sin(ang) * 16;
    ctx.fillStyle = 'rgba(20,20,28,.9)'; ctx.beginPath(); ctx.arc(sx + ox2, sy + oy2, 8.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#cfcfe0'; ctx.fillText(`${c.n}${c.l || ''}`, sx + ox2, sy + oy2 + .5);
  }
  // linha de partida
  ctx.fillStyle = '#fff'; const [s0x, s0y] = S2[0]; ctx.fillRect(s0x - 2, s0y - 8, 4, 16);
  // cursor
  if (S.cursorD != null) {
    for (const l of L) {
      const xr = interp(l.nd, l.data.x, S.cursorD), yr = interp(l.nd, l.data.y, S.cursorD);
      if (xr == null) continue;
      const [sx, sy] = T(R(xr, yr));
      ctx.fillStyle = l.drv.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, 7); ctx.fill(); ctx.stroke();
    }
  }
}

// ---------- Análise da sessão ----------
function renderSessionCharts() {
  const el = $('#sessCharts');
  const drivers = new Map([...S.sess.drivers.values()].map((d) => [d.key, { acr: d.acr, color: d.color }]));
  const order = [...S.sess.drivers.keys()];
  const laps = S.sess.laps.filter((l) => drivers.has(l.key)).map((l) => ({ driver_number: l.key, lap_number: l.n, lap_duration: l.deleted ? null : l.t, is_pit_out_lap: l.pitOut || l.pitIn }));
  el.innerHTML = `<div class="card"><div class="row-flex mb" style="justify-content:space-between"><div class="card-title" style="margin:0">Sessão completa</div><div class="tabs" id="sTabs"><button class="tab active" data-tab="laps">Tempos por volta</button><button class="tab" data-tab="tyres">Pneus</button></div></div><div id="sBody"></div></div>`;
  const stints = S.sess.stints || (() => {
    const out = []; const seen = new Map();
    for (const l of S.sess.laps) {
      if (!l.stint) continue; const k = `${l.key}|${l.stint}`;
      if (!seen.has(k)) { const s = { driver_number: l.key, stint_number: l.stint, compound: l.compound, lap_start: l.n, lap_end: l.n, tyre_age_at_start: Math.max(0, (l.life || 1) - 1) }; seen.set(k, s); out.push(s); } else seen.get(k).lap_end = l.n;
    }
    return out;
  })();
  const show = (t) => { const b = $('#sBody'); if (t === 'laps') lapTimeChart(b, laps, drivers, { order }); else strategyChart(b, stints, order, drivers); };
  show('laps');
  $('#sTabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (!b) return; $$('#sTabs .tab').forEach((x) => x.classList.toggle('active', x === b)); show(b.dataset.tab); });
}

async function openSession(source, ref) {
  S.source = source; S.laps.clear(); S.lapChoice.clear();
  $('#teleBody').innerHTML = `<div class="card">${skeleton(8)}</div>`;
  $('#drvPick').innerHTML = '';
  try { S.sess = await source.load(ref); }
  catch (e) { $('#teleBody').innerHTML = `<div class="card">${errorBox('Não foi possível carregar a sessão.', e.message)}</div>`; return; }
  $('#teleTitle').innerHTML = S.sess.title;
  const want = (qs('drv') || '').split(',').filter(Boolean).map((k) => (S.sess.drivers.has(k) ? k : +k)).filter((k) => S.sess.drivers.has(k));
  S.sel = want.length ? want.slice(0, MAX_SEL) : [...S.sess.drivers.keys()].slice(0, 2);
  renderSessionCharts();
  await analyse();
}

// ---------- Página ----------
init(async () => {
  const NOW_Y = new Date().getFullYear();
  $('#app').innerHTML = `
    <section class="page-hero container">
      <h1>Tele<em>metria</em></h1>
      <p>Compare voltas lado a lado: velocidade, acelerador, travão, mudanças e RPM, delta ao longo da volta e quem domina cada mini-sector. Passe o rato pelos gráficos para seguir os carros no mapa.</p>
      <div class="tabs mt" id="srcTabs" style="display:inline-flex"><button class="tab" data-tab="fastf1">FastF1 · alta resolução</button><button class="tab" data-tab="openf1">OpenF1 · 2023+</button></div>
      <div class="controls mt" id="srcControls"></div>
    </section>
    <section class="section container" style="padding-top:10px">
      <h2 id="teleTitle" style="font-size:22px;margin-bottom:12px">—</h2>
      <div class="drv-pick mb" id="drvPick"></div>
      <div id="teleBody"></div>
      <div id="sessCharts" class="mt"></div>
    </section>`;

  const ffIndex = await FastF1.index();
  const ctl = $('#srcControls');

  const useFastF1 = () => {
    if (!ffIndex?.length) {
      ctl.innerHTML = `<div class="notice" style="max-width:760px">Ainda não há sessões FastF1 exportadas. No seu computador, corra <code>pip install fastf1</code> e depois <code>python tools/fastf1_export.py 2025 Monaco R</code>, e envie a pasta <code>data/telemetry</code> para o site. Entretanto, use a fonte <b>OpenF1</b>.</div>`;
      $('#teleBody').innerHTML = ''; $('#drvPick').innerHTML = ''; $('#sessCharts').innerHTML = ''; $('#teleTitle').textContent = '';
      return;
    }
    ctl.innerHTML = `<select class="select" id="ffSel" style="min-width:320px">${ffIndex.map((s) => `<option value="${esc(s.id)}">${s.year} · ${esc(s.event)} · ${esc(s.sessionName)}</option>`).join('')}</select>`;
    const want = qs('ff');
    if (want && ffIndex.some((s) => s.id === want)) $('#ffSel').value = want;
    $('#ffSel').onchange = (e) => { setQs({ ff: e.target.value, s: null, drv: null }); openSession(FastF1, e.target.value); };
    setQs({ ff: $('#ffSel').value, s: null });
    openSession(FastF1, $('#ffSel').value);
  };

  const useOpenF1 = async () => {
    ctl.innerHTML = `<select class="select" id="oY">${Array.from({ length: NOW_Y - 2022 }, (_, i) => NOW_Y - i).map((y) => `<option>${y}</option>`).join('')}</select><select class="select" id="oS" style="min-width:320px"><option>A carregar…</option></select>`;
    let list = [];
    const fill = async (y, wantKey, wantDate) => {
      try { list = (await OpenF1.sessions(y)).sort((a, b) => parseT(b.date_start) - parseT(a.date_start)); }
      catch (e) { $('#oS').innerHTML = '<option>OpenF1 indisponível</option>'; return; }
      $('#oS').innerHTML = list.map((s) => `<option value="${s.session_key}">${esc(s.meeting?.meeting_name || s.country_name)} · ${esc(s.session_name)}</option>`).join('');
      let pick = list.find((s) => String(s.session_key) === String(wantKey));
      if (!pick && wantDate) pick = list.find((s) => s.session_name === 'Race' && Math.abs(parseT(s.date_start) - Date.parse(wantDate)) < 2 * 86400e3);
      if (!pick) pick = list.find((s) => /Qualifying|Race/.test(s.session_name)) || list[0];
      if (pick) $('#oS').value = pick.session_key;
    };
    const go = () => { const s = list.find((x) => String(x.session_key) === $('#oS').value); if (s) { setQs({ s: s.session_key, ff: null, d: null }); openSession(OpenF1, s); } };
    $('#oY').onchange = async (e) => { setQs({ drv: null }); await fill(+e.target.value); go(); };
    $('#oS').onchange = () => { setQs({ drv: null }); go(); };
    const wantS = qs('s'), wantD = qs('d');
    let y = NOW_Y;
    if (wantD) y = +wantD.slice(0, 4);
    if (wantS) { try { const [s] = await getJSON(q('sessions', { session_key: wantS }), { ttl: 86400 }); if (s) y = s.year; } catch { /* */ } }
    $('#oY').value = y;
    await fill(y, wantS, wantD);
    if (!list.length && y === NOW_Y) { $('#oY').value = y - 1; await fill(y - 1); }
    go();
  };

  const setSrc = (t) => { $$('#srcTabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t)); t === 'fastf1' ? useFastF1() : useOpenF1(); };
  $('#srcTabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) { setQs({ drv: null }); setSrc(b.dataset.tab); } });
  $('#drvPick').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]'); if (!b || !S.sess) return;
    const k = S.sess.drivers.has(b.dataset.k) ? b.dataset.k : +b.dataset.k;
    S.sel = S.sel.includes(k) ? S.sel.filter((x) => x !== k) : [...S.sel, k].slice(0, MAX_SEL);
    analyse();
  });
  setSrc(qs('s') || qs('d') || !ffIndex ? 'openf1' : 'fastf1');
});

})();
