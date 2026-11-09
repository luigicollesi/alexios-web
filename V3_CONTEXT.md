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

## Participação natural na conversa

A decisão `shouldSpeak` pertence principalmente à IA. Ela pode:
- responder quando for provavelmente chamada a participar (nome explícito **não** é obrigatório);
- complementar um argumento com informação verificável e útil;
- perguntar para esclarecer uma ambiguidade relevante ou informação ausente;
- fazer um comentário breve relacionado ao tema, desde que acrescente valor;
- continuar ouvindo se a pergunta for dirigida a outra pessoa, se houver
  uma conversa em andamento ou se a intervenção for desnecessária.

**Uma interrogação não é autorização automática para falar.** Não se usa
a frase na memória como nova pergunta. Transcrições são hipóteses falíveis:
podem conter palavras erradas, pontuação incorreta, lacunas ou cortes. A IA
deve inferir o sentido apenas até onde o contexto sustentar e perguntar
com delicadeza quando faltar informação, evitando inventar a fala original.

Cada `floor_open` contém `payload.silenceMs`, duração da pausa observada
pelo agente Python. A inferência agora recebe esse valor e a contagem de
IDs de vozes **distintas observadas nos últimos três minutos da mesma execução**,
não de pessoas presentes. A existência de apenas um ID reconhecido nunca prova
que o usuário está sozinho; os demais podem estar distantes do microfone ou
o detector pode errar a diarização. O evento oferece uma oportunidade de fala,
mas não prova uma pausa maior do que o valor informado.

Exemplo: `Alô, tá conseguindo ver?` com uma única voz observada recentemente
e pausa de 1.216 ms pode justificar uma resposta contextual ou a pergunta
`Está falando comigo?`. Se houver indícios de outros interlocutores ou a
pausa for insuficiente, uma decisão de silêncio também pode estar correta.

O código mantém uma última proteção restrita: se o **modelo ficar em silêncio**
apesar de endereçamento explícito, responde com confirmação segura; no caso
de uma verificação ambígua de comunicação, só sugere esclarecimento quando
houve pelo menos 1.100 ms de pausa e exatamente um ID de voz recente.
**Perguntas genéricas, pontuação e saudações por si sós não forçam resposta.**
O modelo pode intervir por valor contextual mesmo sem qualquer heurística;
se a rede falhar, as proteções de `runId`, `activityEpoch`, validade e FIM
continuam sendo necessárias para publicar fala.

## Transcrições incrementais e identidade provisória de vozes

O agente Python pode enviar uma transcrição cumulativa: por exemplo, depois
de `Alô?` o próximo evento pode conter `Alô? Seu nome é Alexios mesmo?`.
Ao receber o evento, o backend compara um prefixo completo com o turno
anterior da **mesma execução**, com distância máxima de 45 segundos.
Somente quando houver uma continuação textual efetiva, grava o trecho novo
em `alexios_v3_events.transcript`, preservando o
`payload.transcript` original para auditoria e idempotência. O painel também
normaliza o último evento já registrado, sem editar eventos históricos.
Ao iniciar nova execução, não apresenta o último turno de uma execução antiga.

Rótulos de diarização (`speaker_01`, `speaker_03`, etc.) não são nomes
nem uma identidade biométrica. Um mesmo locutor pode ganhar IDs diferentes
durante a conversa. Se a pessoa informar diretamente `Me chamo Luigi`,
o backend registra na memória variável da execução atual, por exemplo:

```text
[Vozes da execucao 6c2dc782]
speaker_03 = Luigi
```

A associação é provisória, não passa para a próxima execução e não se
baseia em menção a terceiros ou em nomes inventados pelo modelo.
O núcleo da persona autoriza pedir o nome quando necessário e oportuno,
sem repetir a pergunta toda vez que o diarizador mudar o rótulo.
O modelo recebe o mapa atual, mas o servidor preserva as associações
confirmadas mesmo se uma inferência reescrever o resumo e as descartar.

**A validação não exige deployment:** testes, lint, tipos e build são
executados no GitHub Actions. O `vercel.json` limita deployments Git à
`main`, evitando previews das branches. Fazer merge somente após CI aprovado;
um único deployment final deve ser suficiente.

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
`dev-alexios-web-v3`. A migração 006 já foi aplicada à produção antes da PR #14.

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

A migração 006 já existe em produção; não aplicá-la novamente. Nesta revisão não há alteração de banco de dados.

## Economia de deployments

Validar código e testes no GitHub Actions antes do merge e agrupar as
correções na mesma PR. Evitar builds e previews intermediários; publicar
uma única revisão pronta em produção, respeitando os limites da Vercel.
