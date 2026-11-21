# PITWALL — site de fãs de Fórmula 1

Versão para **GitHub + Cloudflare (Worker com ficheiros estáticos)**. O site é estático (HTML/CSS/JS) e os dois pequenos "proxies" que antes eram PHP passaram a correr num Cloudflare Worker (`worker/index.js` + `functions/api/`). Os dados de telemetria (OpenF1, exportados) e o histórico (Kaggle) são actualizados **sozinhos** pelo GitHub Actions.

👉 **Para pôr o site no ar, siga o [GUIA-INSTALACAO.md](GUIA-INSTALACAO.md).**

## Como está organizado

| Pasta / ficheiro | Para que serve |
|---|---|
| `wrangler.jsonc` | Configuração do Cloudflare (publica a pasta `htdocs/` e o Worker) |
| `worker/index.js` | Encaminha `/api/news` e `/api/openf1`; tudo o resto são os ficheiros de `htdocs/` |
| `htdocs/` | O site em si (é esta a pasta que o Cloudflare publica) |
| `htdocs/_headers` | Regras de cache (substitui o `.htaccess`) |
| `functions/api/news.js` | Notícias RSS → `/api/news` (substitui `api/news.php`) |
| `functions/api/openf1.js` | Proxy da OpenF1 → `/api/openf1`, usado quando o browser (ex.: Safari) não consegue ligar directamente (substitui `api/openf1.php`) |
| `.github/workflows/telemetria.yml` | Todas as segundas e terças de manhã exporta a telemetria (OpenF1) dos GP que faltam, com `tools/openf1_export.py` |
| `.github/workflows/historico.yml` | Todos os anos a 10 de Janeiro actualiza o histórico 1950–hoje (dataset Kaggle de Rohan Rao) |
| `tools/` | Os scripts Python (também podem correr no seu computador) |

Sempre que um destes processos grava dados novos no GitHub, o Cloudflare volta a publicar o site automaticamente (1–2 minutos).

## O que tem


| Página | O que mostra | Fonte de dados |
|---|---|---|
| **Início** (`index.html`) | Próximo GP com contagem decrescente e horários na hora local, pódio do último GP, classificações, a época em números, últimas notícias | Jolpica (Ergast), OpenF1, RSS |
| **Época** (`epoca.html`) | Qualquer época de 1950 até hoje: calendário, classificações de pilotos e construtores, gráfico da evolução do campeonato (pontos e posição), estatísticas (vitórias, poles, posições ganhas, abandonos), duelos entre colegas de equipa. Clique numa corrida para ver resultados, qualificação, sprint e paragens nas boxes | Jolpica |
| **Ao Vivo** (`aovivo.html`) | Mapa da pista com os carros em movimento, torre de tempos animada (intervalos, última volta, pneus, BOX), bandeiras/Safety Car, direcção de corrida, meteorologia, rádio das equipas, painel do piloto (velocidade, mudança, acelerador, travão, RPM, DRS, mini-sectores). Modo replay de qualquer sessão desde 2023 com velocidades de 1× a 32×. Gráficos de posições por volta, tempos por volta e estratégia de pneus | OpenF1 |
| **Telemetria** (`telemetria.html`) | Compara até 4 pilotos: velocidade, delta, acelerador, travão, mudança, RPM, mapa com domínio por mini-sector / velocidade / mudanças, números das curvas, resumo da volta. Zoom por arrasto e cursor sincronizado com o mapa | FastF1 (exportado) ou OpenF1 |
| **História** (`historia.html`) | Todos os campeões, títulos por piloto/equipa/nacionalidade, recordes de sempre, curiosidades (vencedores mais novos, vitórias de mais atrás na grelha, títulos mais renhidos), gráficos de eras | Kaggle (+ Jolpica) |
| **Pilotos** (`pilotos.html`) | Grelha actual, pesquisa de todos os pilotos da história, perfil de carreira com gráficos e comparação entre dois pilotos | Kaggle ou Jolpica |
| **Circuitos** (`circuitos.html`) | Mapa-mundo com todos os circuitos, vencedores de cada um, % de vitórias da pole | Jolpica + Kaggle |
| **Notícias** (`noticias.html`) | Formula1.com, Autosport, Motorsport.com, The Race, RaceFans, BBC, com filtro e pesquisa | RSS via `/api/news` |

Funciona logo sem instalar nada: as páginas que dependem do Kaggle e do FastF1 usam a Jolpica e a OpenF1 enquanto não tiver os dados exportados.


## Limites das fontes


- **OpenF1**: os dados históricos (2023 em diante) são gratuitos. Durante uma sessão a decorrer, a OpenF1 só dá dados em tempo real a contas pagas; o site detecta isso, avisa, e o replay fica disponível pouco depois de a sessão terminar.
- **Jolpica**: limite de cerca de 4 pedidos por segundo e 500 por hora por visitante. O site guarda as respostas no browser para poupar pedidos.
- **Notícias**: os títulos e resumos vêm em inglês, porque as fontes são inglesas.


## Personalizar


- Nome do site, endereços das APIs e fontes de notícias: `htdocs/assets/js/src/config.js` (os feeds também têm de estar em `functions/api/news.js`).
- Cores e tipografia: variáveis no topo de `htdocs/assets/css/style.css`.
- Cores das equipas: `TEAM` em `htdocs/assets/js/src/core.js`.
- O código JavaScript está em `htdocs/assets/js/src/`. Depois de o alterar, corra `python tools/build_js.py` para gerar os ficheiros que as páginas usam.

Site não oficial, feito por fãs. Sem ligação à Formula 1, FIA ou equipas.
