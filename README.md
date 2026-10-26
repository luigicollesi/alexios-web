# Alexios Web — Vercel + Neon

Painel futurista do assistente Alexios em Next.js 16, React 19 e Tailwind CSS 4. A branch `feature/ambient-listening-bridge` integra diretamente o Agent Python com o servidor `https://alexios-web.vercel.app/`, usando **somente Vercel Functions e Neon PostgreSQL** para o backend. Não há Cloudflare, Worker ou cron externo.

## Arquitetura

```text
Alexios Python (microfone / Whisper / TTS)
    ├── GET  https://alexios-web.vercel.app/v1/agent/poll
    ├── POST https://alexios-web.vercel.app/v1/agent/state
    ├── POST https://alexios-web.vercel.app/v1/transcript
    └── POST https://alexios-web.vercel.app/v1/agent/analyze  (a cada ~8s)
                         │
                Next.js API na Vercel
                    │          │
           Neon PostgreSQL    OpenRouter
             estado/lease      inferência
                contexto
                decisões
                         │
             dashboard /api/alexios/status e /power
```

O Python grava janelas de quatro segundos começando a cada três, com um segundo de sobreposição. Faster-Whisper transcreve **localmente**; somente palavras e timestamps são enviados por HTTPS ao Next.js. A API remove duplicatas da sobreposição e acumula texto pendente no Neon. O Python solicita uma análise contextual em um ciclo separado de aproximadamente oito segundos. O servidor recupera o contexto anterior, as posturas disponíveis e a transcrição, consulta o OpenRouter, valida o JSON `{speech,pose,context}` e atualiza o banco.

As posturas são `idle`, `listening`, `thinking` e `speaking`. `speech` vazio significa silêncio. O dashboard mostra a última fala e a postura; o TTS reproduz localmente. O botão **FIM** cessa o microfone sem desconectar o polling; **INICIAR** retoma.

## Banco Neon

Projeto: **`long-bar-99133807`** (Alexios), branch padrão `production`. Migração versionada em `db/migrations/001_alexios_runtime.sql`:

- `alexios_sessions`: sessão ativa, lease, energia, contexto, expressão, texto pendente, inferência ativa.
- `alexios_power_requests`: idempotência dos comandos de energia.
- `alexios_inference_history`: histórico de decisões (sem gravações de áudio).

A migração está aplicada ao banco do projeto informado. Os dados são isolados dos demais projetos Neon.

## Configuração na Vercel

Em **Vercel → Projeto alexios-web → Settings → Environment Variables**, configure no ambiente de produção:

```dotenv
DATABASE_URL=postgresql://...URL-do-projeto-long-bar-99133807...
ALEXIOS_DASHBOARD_TOKEN=token-aleatorio-exclusivo-do-painel-com-24-ou-mais-caracteres
ALEXIOS_AGENT_TOKEN=outro-token-aleatorio-compartilhado-com-python
OPENROUTER_API_KEY=sk-or-v1-sua-chave
OPENROUTER_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
```

Copie `DATABASE_URL` do painel **Neon → Projeto Alexios → Connect**, preferencialmente a conexão pooled com SSL. O *project ID* não substitui a URL. Não configure `ALEXIOS_API_BASE_URL`, que pertencia à antiga ponte externa; a API agora consulta o Neon diretamente. **Nunca use `NEXT_PUBLIC_` para segredos.**

Faça deploy desta branch no endereço oficial. Se `https://alexios-web.vercel.app` ainda publica outra branch, as novas rotas não estarão presentes até o deploy. Nada neste repositório implanta a Vercel automaticamente.

## Desenvolvimento local

Requer Node.js 22+ e npm:

```bash
npm install
cp .env.example .env.local
npm run dev
```

Configure a URL do Neon em `.env.local`, preferencialmente em uma branch Neon de teste. O Agent Python pode usar `ALEXIOS_BRIDGE_URL=http://localhost:3000` durante o desenvolvimento e `https://alexios-web.vercel.app` em produção.

Verificações: `npm run lint`, `npm run typecheck` e `npm run build`. O GitHub Actions executa esses comandos a cada pull request. As alterações ficam na branch de integração e não são mescladas automaticamente.

## Long polling e segurança

- Cada GET `/v1/agent/poll` aguarda até 20 segundos, verificando alterações periodicamente no Neon. Isso funciona com instâncias efêmeras da Vercel; nenhum `setInterval` é executado em segundo plano após o término da requisição.
- A lease expira após 45 segundos sem renovação. Somente uma instância Python pode controlar a sessão `primary`.
- Requisições são autenticadas com `ALEXIOS_AGENT_TOKEN`; o navegador usa somente `ALEXIOS_DASHBOARD_TOKEN`.
- A análise de IA tem *claim* atômico, evita chamadas concorrentes e descarta respostas obsoletas após desligamento.
- As palavras em análise e o contexto sobrevivem às reinicializações das funções da Vercel. O banco mantém histórico de decisões e contexto até que uma política de retenção seja definida.
- A latência real depende do Whisper, do Neon, da rede e do OpenRouter. Não existe garantia rígida de conclusão em oito segundos.
- O projeto recebe **transcrições** (dados pessoais potenciais), mas não áudio bruto. Informe pessoas próximas sobre a escuta permanente quando ligada.

## Imagens da persona

Adicione à pasta `public/characters/` os quatro PNGs transparentes finais: `idle.png`, `listening.png`, `thinking.png` e `speaking.png`. Até isso ocorrer, o painel utiliza `placeholder.svg`. A composição permanece dimensionada proporcionalmente à resolução disponível.

Consulte também [Alexios Python — documentação do modo ambiente](https://github.com/luigicollesi/alexios/blob/feature/ambient-listening/AMBIENT.md).
