# V3 — formas, posturas e emoção por resposta

## Catálogo

A única fonte de verdade é `src/lib/v3/avatar-catalog.ts`. Há 52
imagens: 7 posturas masculinas e 6 femininas, cada qual em 4 frames
(`listening`, `speaking`, `waiting_1`, `waiting_2`).

`public/characters/{men|woman}/{stance}/{frame}.png`

As duas antigas pastas `doble-biceps` foram renomeadas para
`double-biceps` sem modificar os pixels. **Não** use os caminhos antigos
de `/characters/stand/`.

Postura padrão: `men/hand-in-pocket` ou `woman/elegant`.

## Contrato da IA

O modelo sempre retorna memória, `form`, `stance` e `waitingVariant`,
inclusive em `OBSERVE`, quando **não produz áudio**. Ele pode escolher
`thumbs-up`, `thumbs-down`, `anger` e `fury` durante a escuta.
A escolha de `form` é seguida pelo servidor sempre que válida, sem um
classificador extra de intenção. O prompt recomenda manter a forma
existente, exceto em pedidos explícitos ou implicitamente claros.
Posturas inválidas retornam à padrão da forma escolhida.

No `RESPOND` a resposta acrescenta `shouldSpeak`, `speech`, `emotion`.
O backend valida `emotion` contra valores suportados, com fallback
`neutral`. O modelo não escolhe os frames operacionais.

## Persistência Neon

Migração: `db/migrations/008_v3_dual_avatar_expressions.sql` —
**aplicar antes de publicar a implementação no ambiente de produção**.
O banco guarda a forma atual `character_form`, a postura `character_stance`,
a forma de cada resposta `speech_form` e sua `speech_emotion`.
A constraint evita pares sem PNG, como `woman/hand-in-pocket`.

Tanto o consumidor sequencial quanto a Fast Lane atualizam a postura
inclusive em silêncio. Quando a fala é publicada, os metadados da voz
são vinculados ao `speech_seq` correspondente. O frontend TTS usa
**speech_form**, não a forma atual, para evitar inconsistência em mudanças
de avatar entre duas respostas.

## Cartesia

- `men`: `CARTESIA_VOICE_ID`, padrão `07b6f895-78b9-4921-8e10-8a21c99c2e8a`
- `woman`: `CARTESIA_WOMAN_VOICE_ID`, padrão `9904416a-0831-44ea-b8ee-5f145e8f9bbf`
- `CARTESIA_EMOTION_ENABLED`: `true` por padrão; `false` elimina
  a dica de emoção e deixa o modelo TTS inferir o tom naturalmente

A Cartesia documenta `generation_config.emotion` como **beta e suportado
apenas para inglês**. O envio explícito em pt-BR pode ser ignorado ou não
produzir o efeito esperado. Respostas HTTP 400/422 com emoção são
repetidas **uma vez sem o controle beta**. Não existe garantia de
expressividade igual nas duas vozes sem teste auditivo.

## Validação

1. Executar `npm test`, `npm run lint`, `npm run typecheck` e `npm run build`.
2. Conferir as 52 imagens e fallback por forma.
3. Confirmar que uma observação sem resposta muda postura.
4. Confirmar pedido de troca para `woman`, posterior retorno a `men`.
5. Confirmar voz masculina/feminina pelo `speech_form` de cada publicação.
6. Confirmar que escuta segue bloqueada enquanto o áudio toca e reabre
   após seu fim. Testar Cartesia em pt-BR com emoção ativada/desativada.

A integração não necessita de mudança no cliente Python V3.
