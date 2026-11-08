# Alexios V3 — contrato de contexto circular (PR #14)

Toda inferência recebe **três camadas separadas**, jamais uma transcrição
acumulativa que se repete indefinidamente:

1. **Contexto core**: persona Alexios, regras de comportamento, oito imagens
   disponíveis (`{crossed-arm,hand-in-pocket} ×
   {listening,speaking,waiting_1,waiting_2}`), postura e quadro visual atual.
   O núcleo é estável e está definido em `src/lib/v3/persona-core.ts`.
2. **Memória variável**: o texto consolidado pela IA, salvo em
   `alexios_sessions.context_text`. Não é um histórico literal. A IA deve
   conservar informações relevantes e eliminar repetições, dúvidas atendidas,
   falas sem importância e ruído. Cada inferência retorna uma memória nova.
3. **Falas novas**: somente os turnos que pertencem à requisição. Para uma
   observação, a transcrição do turno recebido. Para uma janela de resposta,
   as falas após o `floor_open` anterior do mesmo `runId`, até o atual.
   Limites de tamanho protegem o modelo, priorizando trechos recentes.

## Resposta exigida

Quando a janela está **fechada** (OBSERVE):

```json
{"context":"Resumo semântico atualizado","stance":"hand-in-pocket","waitingVariant":1}
```

Quando a janela está **aberta** (Fast Response ou RESPOND legado):

```json
{"context":"Resumo semântico atualizado","stance":"crossed-arm","waitingVariant":2,"shouldSpeak":false,"speech":""}
```

Mesmo quando `shouldSpeak=false`, o backend persiste a memória e postura
devolvidas, desde que a inferência continue válida. A IA pode responder uma
pergunta, fazer uma contribuição ou perguntar para esclarecer o assunto;
em conversas sem oportunidade relevante, escolhe silêncio.

O modelo escolhe `stance` e `waitingVariant`. Os estados `listening` e
`speaking` são impostos pelo backend: não se deve representar fala quando
o modelo escolheu silêncio ou quando um novo `speech_started` cancelou a
resposta.

## Isolamento das perguntas

O SQL `FRESH_FLOOR_TURNS_SQL` usa a última fronteira `floor_open` do mesmo
`runId`, independente do resultado anterior: `published`, `silent`,
`revoked` ou `timed_out`. Perguntas das janelas anteriores permanecem
apenas como possíveis fatos já resumidos na memória, nunca como pedidos novos.

Os eventos Neon conservam transcrições para diagnóstico. Quando OBSERVE
falha, seu fallback **não** inclui transcrição bruta na memória variável;
preserva o contexto anterior e registra a falha. Erros não autorizam fala.

## Concorrência e compatibilidade

Fast Response atualiza memória, postura e (se houver) fala na mesma
transação, condicionada a `runId`, `activityEpoch`, lease, power, FIM e
prazo de nove segundos. Usa comparação otimista do contexto lido para não
sobrescrever um resumo consolidado mais novo. O processamento sequencial
também verifica a memória de origem antes de gravá-la.

A V2 não muda; as variáveis `OPENROUTER_MODEL` e os tokens existentes são
reutilizados. Nenhuma migração é necessária.

## Limites e validação

O formato de Fast Response agora precisa gerar texto adicional de memória e
pose, então `max_tokens` foi ampliado para 560. Isso pode aumentar o tempo
de inferência: a meta anterior de dois segundos deve ser medida novamente.

Antes de produção, exercitar: várias perguntas consecutivas, respostas
silenciosas, turnos com mais de uma fala, dois locutores, nova fala durante
inferência, FIM, indisponibilidade OpenRouter, JSON truncado e backlog
OBSERVE/Fast em paralelo. Testes de unidade/CI e EXPLAIN não substituem
esse teste com microfone e API reais.
