# Cartesia Sonic 3.6 — Rafael (TTS de baixa latência)

## Escopo

- Backend: Alexios Web V3 (`src/app/api/v2/alexios/tts/route.ts`).
- Voz: Rafael, ID `07b6f895-78b9-4921-8e10-8a21c99c2e8a`.
- Modelo: `sonic-3.6` (estável), locale `pt-BR`.
- API: `POST https://api.cartesia.ai/tts/bytes`, resposta PCM f32le raw a 44100 Hz.
- Som sai **no navegador autorizado**, não automaticamente no computador
  que executa o agente Python. API keys nunca vão ao cliente.

## Variáveis de ambiente

Adicionar ao `.env.local` (desenvolvimento) e ao ambiente de produção
na Vercel **somente depois que a PR for aprovada**:

```dotenv
CARTESIA_API_KEYS=sk_car_primeira_chave,sk_car_segunda_chave
CARTESIA_MODEL=sonic-3.6
CARTESIA_VOICE_ID=07b6f895-78b9-4921-8e10-8a21c99c2e8a
CARTESIA_LOCALE=pt-BR
CARTESIA_API_VERSION=2026-08-14
```

Não usar `NEXT_PUBLIC_`. A lista preserva a ordem, remove duplicatas e
espaços e não é registrada nos logs. Não substitua a chave do OpenRouter:
a Cartesia é usada só para transformar resposta escrita em áudio.

## Execução

```bash
git fetch origin
git switch feat/cartesia-sonic36-tts
git pull --ff-only origin feat/cartesia-sonic36-tts
npm install
npm run dev
```

O redesign é o painel padrão no `npm run dev` nesta branch.
Configure `DATABASE_URL`, segredos V2, acesso do painel e agente V3
normalmente. No navegador em `http://localhost:3000`, autorize a
instância e clique **ATIVAR VOZ**. Essa ação desbloqueia o áudio do
navegador, conforme as políticas de autoplay.

O painel não reproduz a última fala existente quando faz login, recarrega
ou habilita a voz. Após a ativação, a primeira **nova** resposta publicada
na sessão V3 será sintetizada. O frontend envia apenas `sequence` e
`activityEpoch` à rota autenticada; o backend recupera o texto atual da
instância autorizada e bloqueia solicitações velhas ou substituídas.

### Estados visuais

- `generating`: solicitação de áudio em andamento, sem forçar speaking.
- `playing`: primeiro trecho agendado na Web Audio API; postura
  `speaking` e PNG de personagem `speaking.png` prevalecem.
- `idle`: último trecho efetivamente encerrado; postura normal volta.
- Nova fala identificada pelo Python, FIM, desconexão, logout, desativação
  da voz ou desmontagem do painel: aborta fetch e fontes de áudio.

A V3 mantém seu temporizador estimado de speaking no banco para outros
clientes; **no navegador que reproduz áudio Cartesia**, o estado efetivo do
áudio toma precedência. Não haverá persistência de estado de áudio global
entre navegadores nesta entrega.

### Failover e limites

`quota_exceeded` (código estruturado Cartesia) ou um erro 402
identificado explicitamente como falta de créditos passa à próxima chave.
Erros 401, 403, `concurrency_limited` e erros de rede **não** passam
à próxima chave.

Uma chave que retornou erro de créditos é ignorada temporariamente
por 30 minutos no processo Node atual. Cada instância de função da
Vercel tem sua própria memória, de modo que o cooldown **não é global**.
Quando todas as chaves estão esgotadas, o navegador informa a falha.
Se diferentes chaves pertencem ao mesmo workspace Cartesia, o saldo
pode ser compartilhado e a rotação pode não ajudar. A política de uso
do provedor deve ser respeitada.

**Failover somente antes de encaminhar bytes:** se um stream falhar
depois que o som começou, a fala não reinicia, evitando duplicações.
Não há cache persistente de áudios ou retransmissão do mesmo texto.

### Testes automatizados

```bash
npm run test
npm run lint
npm run typecheck
npm run build
```

Os testes cobrem: lista de chaves, erros de crédito x outros erros,
cooldown, fragmentação PCM em qualquer posição, valores não finitos,
não sintetizar fala antiga, proteção por `activityEpoch` e postura
`speaking` derivada da reprodução. É indispensável validar em navegador
real com uma chave Cartesia válida: não há credenciais nos testes CI.

### Teste de aceitação recomendado

1. Clique **ATIVAR VOZ** com o V3 ligado; faça o Python produzir
   uma resposta nova em português (por exemplo, "Olá, Luigi.").
2. Confirme se a voz corresponde à identidade do Rafael e sotaque pt-BR.
3. Confirme primeiro fragmento audível antes do fim da requisição.
4. Confirme que a figura mantém `speaking` até o último som.
5. Durante o áudio, fale de novo e confirme interrupção imediata.
6. Teste FIM, desligamento da voz e troca de instância.
7. Teste a rotação com chaves independentes e um erro de créditos
   real, observando que não surge áudio duplicado.
8. Teste respostas longas e fragmentos de PCM quebrados pela rede.

## Referências oficiais

- https://docs.cartesia.ai/api-reference/tts/bytes
- https://docs.cartesia.ai/use-the-api/api-errors
- https://docs.cartesia.ai/examples/nextjs
- https://docs.cartesia.ai/build-with-cartesia/tts-models/latest

Nenhum deploy de preview é necessário: trabalhar nesta branch, validar
CI e revisar PR antes de integrar na main.
