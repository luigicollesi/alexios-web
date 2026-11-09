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
prazo de nove segundos. Usa revisão numérica crescente (`context_revision`) para não
sobrescrever um resumo consolidado mais novo. O processamento sequencial
também verifica a revisão antes de gravar.

A V2 não muda; as variáveis `OPENROUTER_MODEL` e os tokens existentes são
reutilizados. **A migração aditiva 006_v3_context_revision.sql é necessária
antes do deploy deste código.** Ela adiciona `context_revision` à sessão,
`fast_context_applied` aos eventos e índices para as janelas de fala.
A migração foi aplicada e validada apenas na branch Neon
`dev-alexios-web-v3`. A produção permanece intacta.

As transações Fast e OBSERVE só aplicam a memória gerada quando a revisão
lida no início ainda é a atual. Se outra inferência atualizar a memória
primeiro, o resultado atrasado preserva o resumo mais novo. O campo
`fast_context_applied` (true/false) indica isso no status autenticado.
Um `speech_started` com `activityEpoch` já confirmado é idempotente
e não pode trocar a pose exibida após uma resposta.

## Limites e validação

O formato de Fast Response agora precisa gerar texto adicional de memória e
pose, então `max_tokens` foi ampliado para 560. Isso pode aumentar o tempo
de inferência: a meta anterior de dois segundos deve ser medida novamente.

Antes de produção, exercitar: várias perguntas consecutivas, respostas
silenciosas, turnos com mais de uma fala, dois locutores, nova fala durante
inferência, FIM, indisponibilidade OpenRouter, JSON truncado e backlog
OBSERVE/Fast em paralelo. Testes de unidade/CI e EXPLAIN não substituem
esse teste com microfone e API reais.

## Catálogo visual verificado

O repositório contém exatamente oito PNGs sob
`public/characters/stand/`, e o core os enumera individualmente. O assistente
escolhe entre `crossed-arm` (mais concentrado/reservado) e `hand-in-pocket`
(mais casual), além de `waitingVariant` 1 ou 2. Os frames `listening` e
`speaking` são estados de atividade do servidor. As duas imagens de espera
são variações visuais, sem emoções impostas pela nomenclatura.

A memória tem meta de 900 e limite de 1.200 caracteres, compartilhado pelos
parsers de OBSERVE, RESPOND e Fast Response. Transcrições ficam persistidas
como eventos separados, não como um histórico duplicado no contexto.

## Recuperação quando o Fast Response falha

Uma falha de rede, HTTP transitório, JSON incompleto ou ausência de conteúdo
final do modelo **não é** uma decisão de silêncio. Nessas situações, o Fast
atualiza a mesma janela para `fast_status=legacy`, preservando `fast_error`
e liberando a fila V3 para uma nova chamada RESPOND, com a mesma restrição
de `runId`, `activityEpoch` e prazo. A fila permanece idempotente: uma
janela anterior nunca volta a ser solicitada ao modelo.

Somente uma resposta JSON válida com `shouldSpeak=false` conta como
**silêncio voluntário**. Credenciais ausentes/inválidas resultam em cancelamento
explícito, sem tentar a mesma chave novamente. O parser distingue
`empty_content`, `no_choice` e `truncated`; registra apenas metadados
estruturais seguros, nunca falas ou raciocínio do provedor.

O Fast continua usando `OPENROUTER_MODEL` por padrão; nenhum segundo modelo
pago é selecionado implicitamente.

## Rollout seguro

1. Verificar os testes e Preview com `DATABASE_URL` isolada na branch Neon V3.
2. Aplicar `db/migrations/006_v3_context_revision.sql` à produção Neon
   **antes** de publicar o backend desta PR. Não remover a migração 004/005.
3. Conferir a aplicação da revisão e as poses em silêncio e respostas reais.
4. Revalidar Fast Response com concorrência e limites de tokens.

O banco de produção NÃO recebeu a migração 006 nesta revisão.
