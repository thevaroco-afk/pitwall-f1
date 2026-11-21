// Configuração do site — altere à vontade.
export const CONFIG = {
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
export const FEEDS = [
  { id: 'f1', name: 'Formula1.com', url: 'https://www.formula1.com/en/latest/all.xml' },
  { id: 'autosport', name: 'Autosport', url: 'https://www.autosport.com/rss/f1/news/' },
  { id: 'motorsport', name: 'Motorsport.com', url: 'https://www.motorsport.com/rss/f1/news/' },
  { id: 'therace', name: 'The Race', url: 'https://www.the-race.com/formula-1/feed/' },
  { id: 'racefans', name: 'RaceFans', url: 'https://www.racefans.net/feed/' },
  { id: 'bbc', name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml' },
];
