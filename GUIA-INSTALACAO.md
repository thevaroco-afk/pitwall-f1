# Guia: pôr o PITWALL no ar com GitHub + Cloudflare Pages

Tempo total: cerca de 20 minutos. Não precisa de instalar Python nem de escrever código.

**Como funciona, em resumo:** o GitHub guarda os ficheiros do site. O Cloudflare vai buscá-los ao GitHub e publica o site (grátis, rápido, com HTTPS). Todas as semanas, o GitHub corre sozinho os scripts que buscam a telemetria nova e grava-a; o Cloudflare repara na mudança e volta a publicar. Não tem de fazer mais nada.

A versão do InfinityFree continua a funcionar como está. Pode desligá-la quando a nova estiver no ar.

---

## Passo 1 — Criar o repositório no GitHub

1. Entre em <https://github.com> com a sua conta.
2. Canto superior direito: clique no **+** e depois em **New repository**.
3. Preencha:
   - **Repository name:** `pitwall-f1` (ou outro nome à escolha).
   - Escolha **Public** ou **Private** (os dois funcionam; *Public* dá minutos ilimitados ao GitHub Actions, *Private* dá 2000 minutos por mês, que chegam bem).
   - **Não** marque "Add a README file" (o repositório tem de ficar vazio).
4. Clique em **Create repository**.

## Passo 2 — Enviar os ficheiros

O site tem mais de 3000 ficheiros (os dados históricos), e a página do GitHub só aceita 100 de cada vez. Por isso há duas formas:

### Opção A (mais fácil): o Claude envia por si

1. Dê acesso ao Claude no GitHub: <https://claude.ai/connect-github> e, se pedir, instale a app do Claude e escolha o repositório `pitwall-f1`.
2. Diga ao Claude, na conversa, o nome do repositório. Ele envia tudo e avisa quando estiver pronto.

### Opção B: com a aplicação GitHub Desktop

1. Instale o **GitHub Desktop**: <https://desktop.github.com> e entre com a sua conta.
2. Na página do repositório vazio no GitHub, clique em **Set up in Desktop** (ou, no GitHub Desktop: *File → Clone repository* e escolha `pitwall-f1`). Escolha uma pasta no computador.
3. Descompacte o `pitwall-cloudflare.zip` e copie **todo o conteúdo** (as pastas `htdocs`, `functions`, `tools`, `.github` e os ficheiros soltos) para dentro dessa pasta.
   - A pasta `.github` começa por um ponto e pode estar escondida. No Mac carregue em `Cmd + Shift + .` no Finder para a ver; no Windows, no Explorador, *Ver → Mostrar → Itens ocultos*. **Ela é essencial**: é lá que estão as actualizações automáticas.
4. No GitHub Desktop aparecem os ficheiros novos. Em baixo à esquerda escreva "Primeira versão" no campo *Summary* e clique em **Commit to main**.
5. Clique em **Publish branch** / **Push origin** (em cima).

Confirme no site do GitHub que vê as pastas `.github`, `functions`, `htdocs` e `tools`.

## Passo 3 — Ligar o Cloudflare Pages

1. Entre em <https://dash.cloudflare.com>.
2. No menu da esquerda: **Workers & Pages** (às vezes dentro de *Compute*).
3. Clique em **Create** (ou *Create application*) e escolha o separador **Pages**. Se só lhe aparecer a opção de Workers, procure a ligação *"Looking to deploy Pages? Get started"*.
4. Escolha **Import an existing Git repository** (ou *Connect to Git*).
5. Clique em **Connect GitHub**, autorize o Cloudflare e escolha o repositório `pitwall-f1`. Clique em **Begin setup**.
6. Preencha **exactamente** assim:
   - **Project name:** `pitwall-f1` (vai ser o endereço: `pitwall-f1.pages.dev`; se estiver ocupado, escolha outro)
   - **Production branch:** `main`
   - **Framework preset:** `None`
   - **Build command:** deixe **vazio**
   - **Build output directory:** `htdocs`
   - (Root directory: deixe vazio)
7. Clique em **Save and Deploy**. Espere 1–2 minutos até aparecer "Success".
8. Abra o endereço `https://<nome>.pages.dev`. O site já deve estar no ar.

**Verificar que está tudo bem:** abra `https://<nome>.pages.dev/diagnostico.html`. As linhas "OpenF1 via proxy do site" e "Proxy de notícias" devem estar com ✅. Teste também no Safari (iPhone/Mac).

## Passo 4 — Ligar as actualizações automáticas (GitHub Actions)

1. No GitHub, abra o repositório e vá a **Settings** (separador de cima) → **Actions** → **General**.
2. Em **Actions permissions**, confirme que está marcado **Allow all actions and reusable workflows**.
3. Mais abaixo, em **Workflow permissions**, escolha **Read and write permissions** e clique em **Save**. (Isto deixa os scripts gravarem os dados novos.)
4. Vá ao separador **Actions** (em cima). Se aparecer um botão verde *"I understand my workflows, go ahead and enable them"*, clique nele.

A partir daqui fica tudo automático:

| O quê | Quando |
|---|---|
| **Telemetria FastF1** dos GP que faltam (qualificação, sprint e corrida) | Todas as segundas e terças às 07:00 (hora de Lisboa no Inverno) |
| **Dados históricos** 1950 até à última época | Uma vez por ano, a 10 de Janeiro |

### Primeira execução (recomendado)

O site começa sem telemetria FastF1. Para encher já a época actual:

1. Separador **Actions** → à esquerda **Telemetria FastF1** → botão **Run workflow** (à direita).
2. Em "Máximo de GP a exportar" escreva `30` e clique no botão verde **Run workflow**.
3. Demora (cerca de 2 a 4 horas para uma época inteira). Pode fechar a página. Quando acabar aparece um ✅ verde e o site é republicado sozinho.

Para outra época (ex.: 2025), faça o mesmo e escreva `2025` em "Época".

Para testar o histórico: **Actions** → **Dados históricos** → **Run workflow**.

---

## Se algo correr mal

- **Um ❌ vermelho no Actions:** clique na execução para ver o erro e copie-o para a conversa com o Claude.
- **"Dados históricos" falha a descarregar do Kaggle:** o Kaggle pode exigir conta. Crie uma conta em <https://www.kaggle.com>, vá a *Settings → API → Create New Token* (descarrega um ficheiro `kaggle.json` com `username` e `key`). No GitHub: **Settings → Secrets and variables → Actions → New repository secret**, crie `KAGGLE_USERNAME` e `KAGGLE_KEY` com esses dois valores. Volte a correr o processo.
- **O GitHub desliga as tarefas agendadas** se o repositório estiver 60 dias sem alterações (pode acontecer no defeso). Recebe um email; basta ir ao separador **Actions**, escolher a tarefa e clicar em **Enable workflow**.
- **Telemetria de um GP não aparece na segunda-feira:** os dados às vezes saem tarde. A tarefa volta a tentar na terça; também pode correr à mão (ver acima).

## Endereço próprio (opcional)

Se tiver um domínio, no Cloudflare: projecto `pitwall-f1` → **Custom domains** → **Set up a custom domain** e siga os passos.

## Desligar o InfinityFree

Quando confirmar que o novo site funciona (incluindo no Safari), pode apagar a conta ou o site no InfinityFree. Não há nada a migrar de lá.
