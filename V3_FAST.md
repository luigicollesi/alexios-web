# Alexios Web V3 — Fast Response (meta: 2 segundos)

## O que mudou

O `OBSERVE` continua processando os turnos em ordem para atualizar o
contexto compartilhado por instância no Neon. Contudo, um `floor_open`
novo pode ser processado **independentemente do backlog de OBSERVE**.

Fluxo:

1. Python envia `turn_end`, que é persistido imediatamente no Neon.
2. Python envia `floor_open`. O backend grava um evento de sequência
   normal com `fast_status='pending'`, confirma `202 Accepted` e
   inicia `processFastFloorV3` em `next/server.after()`.
3. O caminho rápido lê contexto atual + até quatro transcrições recentes
   diretamente do Neon, incluindo eventos ainda pendentes de `OBSERVE`.
4. Chama o OpenRouter com `reasoning.enabled=false`,
   `max_tokens=560`, sem streaming. O roteamento é escolhido pelo OpenRouter.
   A IA recebe contexto core (persona, poses e pose atual), memória variável
   e somente falas posteriores ao último `floor_open` dessa execução.
   O JSON deve incluir `context`, `stance`, `waitingVariant`,
   `shouldSpeak` e `speech`, inclusive quando escolher silêncio.
5. O commit da memória, pose e eventual fala verifica novamente
   **runId, activityEpoch, versão de protocolo, power, FIM, lease do Python
   e prazo**. Mesmo no silêncio, atualiza memória e pose quando o evento é
   válido. Uma checagem otimista evita sobrescrever resumos alterados por
   inferências concorrentes. Se a autorização mudou, não publica texto nem
   incrementa `speech_seq`.
6. Vercel Queue continua processando o evento em ordem para avançar o
   cursor do Neon, mas **não gera uma segunda resposta**. Falhas de
   `after()` resultam em silêncio e não bloqueiam o fluxo.
7. O painel V3 consulta o estado a cada 650 ms enquanto `running`.
   O botão **ATIVAR VOZ** habilita a Web Speech API do navegador
   (`pt-BR`). Sem gesto explícito do usuário o áudio permanece desligado.

A meta de 2s é para *floor recebido pelo servidor → início da resposta
percebida pelo navegador*. Ela não inclui o tempo de espera de silêncio
do Silero/Smart Turn/Whisper, nem garante uma latência máxima do provedor.

## Instalação

**A migração é aditiva e deve ser aplicada ANTES do deploy de produção:**

```text
db/migrations/005_v3_fast_response.sql
```

Depois do merge na `main` e do deployment `READY`, configurar:

| Env var | Valor | Efeito |
|---|---|---|
| `ALEXIOS_V3_FAST_ENABLED` | `true` | Ativa o novo caminho rápido somente para floors futuros |
| `OPENROUTER_MODEL` | `nvidia/nemotron-3.5-lightning:free` | Modelo compartilhado pelo OBSERVE e Fast Response |\n| `ALEXIOS_V3_FAST_MODEL` | Não necessária | Override opcional apenas para Fast Response |\n| `ALEXIOS_V3_FAST_FALLBACK_MODEL` | Não necessária | Adicionar apenas se quiser um fallback diferente |
| `ALEXIOS_V3_FAST_MODEL_TIMEOUT_MS` | `2600` (padrão) | Timeout de inferência, limitado entre 1100 e 4500 ms |
| `OPENROUTER_MODEL` | Existente | Continua responsável pelo `OBSERVE`; não foi alterado |
| `OPENROUTER_API_KEY` | Existente | Autentica chamadas ao OpenRouter |

**Padrão seguro:** `ALEXIOS_V3_FAST_ENABLED` é falso se não configurado.
A V2 não muda. O modelo fast padrão é gratuito, mas sujeito a limites
e variações de latência do OpenRouter. Nenhum modelo pago é habilitado automaticamente.

Uma alternativa paga para reduzir a latência (medir antes da adoção):
`google/gemini-3.1-flash-lite`, modelo de baixa latência disponível
no OpenRouter. As chamadas desse modelo têm cobrança por tokens;
o usuário deve autorizá-las ao configurar a variável de ambiente.
Modelos gratuitos não garantem o objetivo de 2s, mesmo sem reasoning.

## Segurança de concorrência

- O fast lane tem token de reivindicação único por `eventId`, impedindo
  publicações duplicadas.
- Uma nova fala altera `activityEpoch` e invalida respostas em execução.
- FIM/microfone parado invalidam respostas, com verificação novamente no
  instante do commit. Uma execução Python substituída também invalida.
- A validade do piso rápido é de no máximo 9s desde o recebimento.
  Uma requisição lenta não pode publicar depois disso.
- A fila encerra o evento rápido em ordem, preservando `speech_seq`,
  `speech_text` e postura; apenas o fast lane pode publicar essa fala.
- Se `after()` não executar, o worker marca `timed_out` após 11s.
- Novos turnos `OBSERVE` podem atualizar contexto em paralelo ao
  `RESPOND`, sem esperar duas inferências em série.
- Não enviamos áudio bruto ao servidor, só transcrições.

## Observabilidade e teste

Vercel Runtime Logs:

```text
[Alexios V3 FAST] finalizado
  modelMs: ...
  endToEndMs: ...
  published: true/false
  status: published/silent/revoked
```

No Neon:

```sql
SELECT sequence, event_type, fast_status, fast_model_ms,
       fast_finished_at, fast_error
FROM public.alexios_v3_events
ORDER BY received_at DESC LIMIT 10;
```

Testar: pergunta simples, vários locutores, nova fala durante geração,
FIM, perda de lease, reenvio de eventId, falha JSON, timeout, rollback e
recuperação da fila. O teste de ponta a ponta com modelos reais é
necessário antes de afirmar a meta de P50 < 2s.

## Rollback

Remover/desativar `ALEXIOS_V3_FAST_ENABLED` na Vercel e redeployar.
Novos pisos voltam ao fluxo antigo, mantendo todas as tabelas e
documentos V3. Os eventos antigos marcados `fast_status='legacy'`
continuam usando a inferência antiga. Nenhuma tabela precisa ser apagada.

## Diagnóstico OpenRouter: HTTP em vez de Error genérico

A versão inicial registrava apenas `fast_error=Error` e encerrava o evento
como `silent`, ocultando falhas HTTP. A correção registra códigos sanitizados
como `http_400`, `http_402`, `http_404`, `http_429`,
`model_timeout` ou `invalid_json`, sem gravar mensagens brutas do modelo.

A chamada rápida padrão usa um payload mínimo e compatível:
`reasoning.enabled=false` no Gemma 4; sem `provider.sort` e
sem `response_format` para evitar filtros incompatíveis de roteamento.

Se a chamada falhar, tenta `openrouter/free` sem configurações opcionais,
mantendo as proteções de segurança. Modelo de fallback pode ser escolhido
explicitamente em `ALEXIOS_V3_FAST_FALLBACK_MODEL`, mas **não** se deve
configurar um modelo pago sem aprovação de gastos. A meta de 2 segundos
continua relativa ao caminho primário bem-sucedido; o fallback pode
demorar mais, mas não publica fala após 9 segundos nem após FIM/nova voz.

Observabilidade na Vercel:

```text
[Alexios V3 FAST] modelo falhou
  model: ...
  reason: http_400 ou http_429
  fallbackAvailable: true

[Alexios V3 FAST] finalizado
  published: true
  modelIndex: 0 | 1
  endToEndMs: ...
```

Erros 429 e 402 indicam limites e saldo da conta; nesse caso,
trocar os parâmetros HTTP não resolve cotas. Verifique as regras atuais
de limites do OpenRouter, sem expor as chaves da API.

## Contexto circular V3

A implementação detalhada, contrato de entrada/saída e limites de consumo
estão documentados em [V3_CONTEXT.md](V3_CONTEXT.md).
