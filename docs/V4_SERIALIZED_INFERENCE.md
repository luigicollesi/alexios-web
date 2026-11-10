# V4 — Inferência serializada por instância

## Objetivo
Uma única inferência ativa por agente. OBSERVE e RESPOND utilizam
`alexios_v4_inference_state` e tokens de geração que invalidam commits antigos.

## Fluxo
1. Eventos continuam sendo persistidos e reconhecidos via HTTP 202.
2. A fila consulta se há um `floor_open` cobrindo a observação pendente.
3. Se houver, marca o evento como `processed`/`covered_by_respond` sem apagar a transcrição.
4. O RESPOND lê as falas da janela pelos eventos, sem executar OBSERVE duplicado.
5. Se OBSERVE já estiver ativo, Fast espera até 4 segundos e, se a reserva
   continuar ocupada, passa a execução para a recuperação sequencial.
6. Ambas as inferências fazem commit somente com a reserva válida e liberam
   seu token após o processamento.

## Operação
Executar `009_v4_inference_coordinator.sql` em Neon antes do deploy.
O mecanismo só passa a funcionar depois de aplicada a migração.
A reserva pode ser recuperada após 150 segundos de atividade, acima
do limite de 120 segundos da função de fila. Execuções antigas são
impedidas de confirmar o contexto após a troca da geração.

## Limitações
Não é possível garantir que um provedor externo tenha cancelado a geração
apenas porque a conexão HTTP expirou. A garantia operacional é de no máximo
um detentor de reserva/commit válido por instância, com recuperação conservadora.

## Verificação
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`
- OBSERVE ativo seguido de floor: Fast não roda em paralelo
- floor antes de OBSERVE: decisão RESPOND absorve os eventos anteriores
- Duas instâncias distintas continuam paralelas
- Redelivery não publica duas falas
- Falha/cancelamento não deixa reserva permanente
