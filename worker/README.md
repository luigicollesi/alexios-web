# Alexios Agent Hub — Cloudflare Durable Object

Serviço **persistente** de long polling, comandos do painel, agregação de transcrições e análises de contexto a cada ~8 segundos com OpenRouter. O Worker é o upstream `ALEXIOS_API_BASE_URL` esperado pelo Next.js. A versão com SQLite Durable Objects mantém estado mesmo quando instâncias são reiniciadas.

## Execução local

Requer Node.js 22+, npm e uma conta Cloudflare para publicar.

1. `cd worker && npm install`
2. `cp .dev.vars.example .dev.vars` (Windows: copie o arquivo manualmente).
3. Gere um segredo aleatório de 32+ caracteres para `ALEXIOS_AGENT_TOKEN`; use exatamente o mesmo em `alexios/.env` e no upstream do Next.js.
4. Informe `OPENROUTER_API_KEY` somente no Worker.
5. `npm run dev` (localhost:8787).
6. `npm run check` para validar a montagem de transcrições e o código.

Para produção, execute `npx wrangler secret put ALEXIOS_AGENT_TOKEN`, `npx wrangler secret put OPENROUTER_API_KEY` e `npm run deploy`. Atualize `PUBLIC_SITE_URL` e os URLs de ambos os clientes. Não use `.dev.vars` na produção.

## Rotas (Bearer ALEXIOS_AGENT_TOKEN)

| Rota | Uso |
| --- | --- |
| `GET /v1/status` | Status do Agent, postura escolhida, última fala |
| `POST /v1/power` | Comando start/stop idempotente por requestId |
| `GET /v1/agent/poll?instanceId=...&after=N&speechAfter=N` | Long poll de até 20 s; sempre ativo, inclusive desligado |
| `POST /v1/agent/state` | Ack da mudança real do microfone |
| `POST /v1/transcript` | Palavras com timestamps absolutos e IDs de janela |

A gravação é feita no Python: janelas 0–4 s, 3–7 s, 6–10 s etc. O Whisper local envia **somente palavras e timestamps**, não arquivos de áudio. O Hub remove repetições do segundo compartilhado, mantém fila curta e solicita à IA um JSON `{ speech, pose, context }`. Uma string vazia em `speech` não produz fala nova. O contexto anterior só é substituído após resposta válida; falhas são tentadas novamente na próxima análise. Uma única sessão de Agent é permitida por vez, com lease de 45 segundos.

## Limitações

- O estado é compartilhado por uma instância lógica `primary`. Para múltiplos usuários, implementar isolamento por conta e IDs de objeto distintos.
- O histórico bruto de áudio não é armazenado, mas o resumo do contexto e a última fala ficam no armazenamento do Durable Object. Configure políticas de retenção adequadas aos usuários envolvidos.
- A primeira inferência ocorre aproximadamente 8 s após o início da captação; limites de CPU, rede ou do modelo podem aumentar o atraso.
- A remoção da sobreposição usa timestamps de palavras do Whisper; erros de reconhecimento nas fronteiras não podem ser eliminados com certeza de 100%.
- O modelo gratuito pode ter limites de taxa e nem sempre produzir JSON válido. O servidor valida a resposta antes de modificar a postura e o contexto.
