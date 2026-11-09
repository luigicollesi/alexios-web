# V3 — não escutar durante reprodução

O Alexios V3 permanece capaz de conversar normalmente entre respostas,
mas **descarta eventos recebidos enquanto sua voz está efetivamente tocando**.
O navegador autorizado informa início, pulsos a cada 2 s e fim da reprodução
à rota `POST /api/v2/alexios/playback`. Cada instância do player recebe
`playbackId` distinto e mantém um lease com expiração de 6 s.

O servidor usa a tabela `public.alexios_v3_playbacks`. Uma janela só fica
ativa com o mesmo `run_id` da sessão e enquanto o lease estiver válido.
Os `turn_end`, `turn_chunk` e `floor_open` enviados pelo Python durante
ela são inseridos **sem texto, sem locutor e sem prompt**; apenas um hash do
payload original é guardado para validar reenvios idempotentes. A fila
consome a sequência como `obsolete`, sem chamar OBSERVE, RESPOND ou Fast,
sem modificar memória e sem interferir na fala atual. Os eventos de
`speech_started` não mudam a pose durante a reprodução.

## Migração aplicada no Neon de produção

A migração aditiva `db/migrations/007_v3_playback_guard.sql` foi aplicada
em **2026-11-09** ao projeto `long-bar-99133807`, banco `neondb`,
branch `production` (`br-withered-band-b65f8x75`).

Verificação após aplicação: tabela `public.alexios_v3_playbacks` existente,
6 colunas, índice `alexios_v3_playbacks_active_idx` existente.
A migração foi preparada e testada em branch temporária, depois aplicada
na produção e a branch temporária foi eliminada. Não há nova env var.

**A implementação continua apenas nesta PR até ser aprovada e integrada
à `main`**.

## Memória de locutores

`speaker_unknown` não cria registro de locutor ou vínculo por nome.
O core não deve solicitar nomes nem inferir identidade com IDs instáveis.
Apenas apresentações explícitas, voluntárias e vindas de um `turn_end`
com duração indicada de **pelo menos 2000 ms**, podem gerar vínculo
temporário dentro da execução atual. Uma nova execução descarta esses
vínculos. O intervalo início/fim do turno enviado pelo Python é uma
aproximação da fala contínua; não mede intensidade vocal quadro a quadro.

## Observações operacionais

- O descarte é feito **na chegada do evento ao servidor**, sob lease válido.
  Turnos que chegaram antes de iniciar ou depois de encerrar a reprodução
  continuam sendo processados normalmente.
- Se navegador cair sem finalizar, o lease expira em no máximo ~6 s após
  o último pulso recebido. Leases antigos não bloqueiam novas falas.
- A abertura de fala descartada não dispara Fast; o contador de sequência
  é avançado para não travar o processamento da fila.
- Outros navegadores podem manter suas próprias janelas; o silêncio só
  termina quando nenhum lease válido permanece.
- O TTS espera confirmação de início da janela antes de emitir o primeiro
  fragmento de som. Caso a confirmação falhe, a reprodução não começa.
- Só o navegador com sessão autorizada pode criar ou renovar leases.
- FIM, logout e término da reprodução fecham o lease; perda de rede expira
  automaticamente.

## Validação

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

Teste no navegador com a API e o banco configurados: falar perto do microfone
enquanto o Alexios fala; confirmar que o texto é ignorado no servidor e a voz
não é cortada. Aguardar o fim, falar novamente e verificar nova resposta.
Confirmar que um nome dito rapidamente ou por `speaker_unknown` não cria
vínculo, mas uma apresentação explícita com turno >=2 s pode criá-lo.
