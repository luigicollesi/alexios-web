# Alexios Web

Painel futurista de controle do Alexios Core em Next.js 16, React 19, TypeScript e Tailwind CSS 4.

## Implementado

- Personagem central com fallback vetorial até os PNGs finais serem adicionados.
- HUD escuro (três tons de cinza/preto) com grades, linhas, anéis, ornamentos e detalhes vermelhos.
- Escala contínua da composição 1600x900 para notebooks e monitores Full HD, QHD e 4K.
- Botão neutro sem Agent fazendo long polling; vermelho FIM quando Core running; verde INICIAR quando Core stopped.
- Consulta de estado a cada 3,5 segundos, com TTL de 45 segundos para a lease de polling.
- Sem atualizações otimistas: comando aceito não é comando executado; o dashboard espera confirmação real.
- Chave de acesso ao painel em memória e segredo da API do Agent somente no servidor.
- Proxy Next.js protegido por token para status e energia, com nova checagem do estado antes do comando.

## Configuração

Requer Node.js 22 e npm.

1. Execute npm install
2. Copie .env.example para .env.local
3. Configure ALEXIOS_DASHBOARD_TOKEN (mínimo de 24 caracteres aleatórios), ALEXIOS_API_BASE_URL e ALEXIOS_AGENT_TOKEN
4. Execute npm run dev
5. Abra http://localhost:3000 e use AUTORIZAR ACESSO com a chave do dashboard

Scripts de validação: npm run lint, npm run typecheck e npm run build.

Sem API configurada, o dashboard é exibido, mas permanece desconectado e nunca simula um Agent online.

## API esperada do Agent

O servidor Next.js encaminha as chamadas à URL definida em ALEXIOS_API_BASE_URL. A API upstream deve exigir Authorization: Bearer [ALEXIOS_AGENT_TOKEN] e usar HTTPS (HTTP local só em desenvolvimento).

GET /v1/status

    {
      "agent": {
        "connected": true,
        "pollingActive": true,
        "lastPollAt": "2026-10-21T18:00:00.000Z",
        "instanceId": "local-main"
      },
      "core": {
        "power": "running",
        "expressionId": "listening"
      }
    }

O Agent deve estar realmente executando long polling autenticado. lastPollAt precisa ser atualizado em cada início ou renovação de poll e representar a mesma lease ativa. Datas inválidas, polling inativo ou atraso superior a 45 segundos forçam o modo offline. core.power admite running, stopped, starting, stopping e unknown. core.expressionId admite idle, listening, thinking e speaking.

POST /v1/power

    {
      "action": "stop",
      "requestId": "550e8400-e29b-41d4-a716-446655440000"
    }

Qualquer resposta 2xx do upstream confirma apenas aceitação do comando. O dashboard mantém o estado pendente até o GET confirmar a transição, ou informa falta de confirmação após 18 segundos. O Agent deve utilizar requestId para idempotência e publicar o estado real após executar.

O Worker/serviço de long polling, a persistência Durable Objects e os processos Python são componentes separados e precisam implementar ou adaptar esse contrato.

## Imagens da persona

Adicione arquivos transparentes, todos de corpo inteiro e com o mesmo alinhamento, em public/characters/:

- idle.png: braços cruzados, postura padrão
- listening.png: escutando
- thinking.png: distraído/pensativo
- speaking.png: falando

Até que esses PNGs existam, placeholder.svg é utilizado como alternativa visual original. A pose vem do Core, não da interpretação feita no navegador.

## Responsividade

O layout de referência mede 1600 x 900. A escala visual resulta de:

    min(viewportWidth / 1600, viewportHeight / 900)

Essa escala é contínua, inclui tipografia, ilustração e controle de energia e mantém a mesma proporção em desktops, mesmo com resoluções muito diferentes. O cenário de fundo cobre o espaço adicional em telas ultrawide.

## Segurança e publicação

Não utilize NEXT_PUBLIC_ para segredos. As rotas /api/alexios/status e /api/alexios/power recusam acesso sem uma chave de painel válida; o segredo da API upstream nunca é enviado ao navegador. O servidor deve ser publicado sob HTTPS.

Cloudflare recomenda atualmente vinext para novos projetos Next.js em Workers. A configuração final de deploy e a implantação do Worker/DO do Agent são uma etapa separada; a aplicação inicial roda em Next.js nativo.
