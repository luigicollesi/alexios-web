# Alexios Web V2 — Migracao e operacao

## Estado de desenvolvimento

- Branch Git: `feature/multi-instance-web-v2`; branch Neon: `dev-multi-instance-web-v2`.
- API `/v1` mantida para compatibilidade com o Python legado.
- API `/v2` integra multi-instancia e Vercel Queues.
- A `main` e a branch Neon `production` nao devem ser alteradas antes dos testes de ponta a ponta.

## Banco de dados

Executar, em ordem e **primeiro no Neon de desenvolvimento**:
1. `db/migrations/001_alexios_runtime.sql` (apenas para banco novo).
2. `db/migrations/002_multi_instance.sql`.
3. `db/migrations/003_v2_reliability.sql`.

As migracoes sao aditivas e preservam a sessao legada `primary`. O banco precisa de:
`alexios_instances`, `alexios_sessions`, `alexios_dashboard_sessions`,
`alexios_auth_rate_limits`, `alexios_power_requests`,
`alexios_inference_history` e `alexios_inference_jobs`.

## Variaveis privadas da Vercel

- `DATABASE_URL`: Neon da branch selecionada.
- `ALEXIOS_AGENT_TOKEN`: valor compartilhado com o Python; minimo de 24 caracteres.
- `ALEXIOS_INSTANCE_HASH_KEY`: segredo HMAC com 32 ou mais caracteres; nao mudar apos registrar instancias sem um plano de rotacao.
- `OPENROUTER_API_KEY`: chave para processar as transcricoes.
- `OPENROUTER_MODEL`: opcional; usa o modelo padrao se omitido.
- `ALEXIOS_DASHBOARD_TOKEN`: apenas para `/v1`, nao usado pela autorizacao `/api/v2`.

A Vercel Queues usa autenticacao OIDC fornecida automaticamente pelo deployment; nao gravar tokens de fila manualmente.
O `ALEXIOS_INSTANCE_ID` fica no agente **Python**, nao nas variaveis do web.

## Contratos Python V2

O Python **ainda precisa ser adaptado** antes do teste ponta a ponta. O formato planejado e:

```http
POST /v2/agent/poll
Authorization: Bearer ALEXIOS_AGENT_TOKEN
Content-Type: application/json

{"instanceId":"alx_<segredo_aleatorio>","runId":"<uuid-v4>","after":-1}
```

Resposta: `{"commandSeq":0,"captureEnabled":true}`. Long polling continua mesmo com o microfone desligado. Os comandos possuem apenas liga/desliga.

```http
POST /v2/agent/state
Authorization: Bearer ALEXIOS_AGENT_TOKEN
Content-Type: application/json

{"instanceId":"alx_<segredo_aleatorio>","runId":"<uuid-v4>","power":"running"}
```

```http
POST /v2/transcript
Authorization: Bearer ALEXIOS_AGENT_TOKEN
Content-Type: application/json

{"instanceId":"alx_<segredo_aleatorio>","runId":"<uuid-v4>","captureId":"<id_captura>","windowIndex":0,"words":[{"text":"ola","startMs":0,"endMs":350}]}
```

**Obrigatorio no cliente Python:** retry da mesma janela apos falha HTTP, preservando `captureId` e `windowIndex`, pois o backend pode salvar a janela e falhar ao publicar na fila. A API deduplica o trabalho por `agentId/captureId/windowIndex`.

Nao existe endpoint Python de analise nem fala retornada no long polling. O Python apenas capta, transcreve e envia os metadados.

## API do painel

1. `POST /api/v2/alexios/authorize` com `{"instanceId":"..."}` — exige agente online e cria sessao HttpOnly. `ALEXIOS_INSTANCE_ID` deve ser aleatorio e secreto (nao utilizar `alexios-v1`).
2. `GET /api/v2/alexios/status` — usa o cookie para escolher somente a instancia autorizada.
3. `POST /api/v2/alexios/power` — `{"action":"stop","requestId":"<uuid-v4>"}` ou `start`.
4. `POST /api/v2/alexios/logout` — revoga a sessao.
5. A UI usa polling independente de aproximadamente 3,5 s para mostrar `speech_text` e `expression_id`.

## Inferencia duravel

- Um `POST /v2/transcript` aceito inclui, na mesma declaracao SQL, as palavras novas e um job em `alexios_inference_jobs`.
- A API publica `jobId` em `alexios-inference-v2` no Vercel Queues com atraso de 8 s e chave de idempotencia.
- O consumidor privado `src/app/api/queues/alexios-inference/route.ts` processa um job. O Neon faz claim exclusivo por instancia, salva resposta, postura e historico atomicamente.
- Falhas recuperaveis provocam retry; trabalhos permanentemente falhos ficam registrados no Neon.
- A validacao da IA nao depende de o Python ainda estar conectado nem do navegador aberto.
- Por ser Queue Beta, deve-se verificar o consumidor e o fluxo de reentrega no Preview antes da producao.

## Validacao e promocao

```bash
npm install
npm run test
npm run lint
npm run typecheck
npm run build
```

O workflow `.github/workflows/validate-v2.yml` inclui essas verificacoes.
A integracao final deve testar **dois agentes simultaneos**, isolamento do painel, liga/desliga, expiracao da presenca (45 s), retries, fila e OpenRouter.

A URL publica `https://alexios-web.vercel.app` permanece em `main` ate aprovacao dos testes, migracao do Neon de producao e deploy coordenado com Python V2.


## Ativacao gradual apos merge na main

A `main` inclui os dois painéis. Por padrao, `ALEXIOS_WEB_V2_ENABLED` ausente
ou diferente de `true` preserva o painel /v1 e o Python atual em producao.

Para habilitar o painel V2, depois de aplicar as migrations e configurar
`ALEXIOS_INSTANCE_HASH_KEY` em Production, e depois de atualizar o Python:
- Adicionar `ALEXIOS_WEB_V2_ENABLED=true` nas variaveis da Vercel Production.
- Criar um novo deployment de producao.
- Testar autorizacao pelo `ALEXIOS_INSTANCE_ID`, captura, long polling e IA.

Para rollback imediato da interface, definir `ALEXIOS_WEB_V2_ENABLED=false`
e reimplantar. Isso nao desfaz migracoes do banco, que sao aditivas.

Apenas fazer merge de `feature/multi-instance-web-v2` em `main`
**nao** ativa a interface V2 por padrao.
