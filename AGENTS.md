# Regras de desenvolvimento — Alexios Web

## Fluxo Git e publicação

1. Criar uma **branch separada** a partir da `main` para cada alteração.
2. Fazer commits e validar na branch. Nunca enviar código experimental diretamente à `main`.
3. Validar testes, lint, tipos e build com `npm run test`, `npm run lint`,
   `npm run typecheck` e `npm run build` em ambiente local ou **GitHub Actions**.
   O build do GitHub Actions não é uma publicação na Vercel.
4. **Nunca executar deployment na Vercel enquanto a mudança estiver em branch**,
   inclusive preview e deployments de validação de build.
5. O `vercel.json` deve manter `git.deploymentEnabled` bloqueado para todas as
   branches que não sejam `main`. Não trocar essa configuração sem orientação explícita.
6. Somente depois de validações aprovadas, mesclar a branch na `main`.
7. Publicar apenas a revisão final na Vercel, procurando reutilizar o deployment
   automático da `main` quando existir. Não disparar um segundo deploy sem
   verificar antes o domínio e o SHA publicados.

## Regras do protocolo V3

- Os IDs `speaker_XX` são rótulos incertos do algoritmo e podem mudar
  mesmo para a mesma pessoa. Não deduzir nome a partir de um ID.
- Uma pessoa pode informar seu nome. Na execução corrente, relacionar
  temporariamente o ID àquele nome na memória variável, por exemplo
  `speaker_03 = Luigi`; nunca reutilizar o vínculo em outra execução.
- Transcrições consecutivas podem incluir texto anterior. O campo
  `payload.transcript` preserva o envio bruto, mas `transcript` deve conter
  apenas a nova fala deduplicada para exibição e inferência.
- Não tratar perguntas antigas da memória como solicitação atual.
- Falhas do provedor não equivalem a decisão voluntária de silêncio.

## Cuidados operacionais

- Evitar alterações no banco Neon sem necessidade; nunca executar SQL
  destrutivo sem autorização explícita.
- Não registrar falas integrais, contexto privado, chave OpenRouter ou
  conteúdo do provedor em logs de aplicação.
- Testes com o microfone e a API reais são uma validação adicional após
  a publicação final, não motivo para criar previews intermediários.
