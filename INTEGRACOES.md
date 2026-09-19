# Integração de marketplaces — estado e pendências

Primeira análise em 18/09/2026, atualizada em 19/09/2026 depois de a integração rodar em produção.
Aplicação publicada em `https://omnicommerce.vercel.app` (Vercel), banco no Neon (`sa-east-1`), fila no QStash (`us-east-1`).

**O Sebo On-Line está integrado e validado de ponta a ponta com pedido real.** O Mercado Livre está conectado, mas nenhuma venda real passou por ele — o mapeamento de valores dele segue sem validação, e é a pendência de maior risco.

## Decisões tomadas

- **Fila:** QStash para entrega HTTP, mantendo Next.js, Prisma e PostgreSQL. RabbitMQ foi descartado por exigir broker gerenciado e consumidor contínuo hospedado.
- **Estágio do payload:** `IntegrationEvent.payload` guarda a notificação crua; consultar o pedido e normalizar acontece no job. Um salto de fila por notificação.
- **Agendador:** schedules do próprio QStash, para não amarrar a hospedagem. `omnicommerce-dispatch-outbox` a cada 5 minutos publica o outbox; `omnicommerce-reconcile` roda de hora em hora, no minuto 17 para não bater com os ticks do dispatcher, porque a conciliação é rede de segurança e não via principal. Ambos estão registrados e repassam o `CRON_SECRET` no `Authorization`, sem retentativa: a rodada seguinte recupera.
- **Loja própria pelo mesmo caminho dos marketplaces:** o Sebo entra como provedor `SEBO_ONLINE` e reaproveita todo o pipeline. Um modelo mental só.
- **Migrations na publicação:** Build Command `npm run build:vercel`. O `build` normal não toca o banco, senão o estágio builder do Dockerfile quebraria.

## O que existe

Verificado por leitura do código e por **90 testes automatizados**. `npm run test:orders` sobe PostgreSQL 16 em contêiner efêmero, aplica as 9 migrations, aborta se houver divergência entre schema e migrations, e roda as suítes. Nenhum teste toca a rede: provedores e publicação são dublês.

Base e autorização:
- Next.js 16.2.6, React 19.2.4, Prisma 6, NextAuth 5 beta.
- Perfis: `PLATFORM_ADMIN` é o único que cruza organizações, `ADMIN` administra a própria, `OPERATOR` só opera vendas. O papel é relido no banco dentro da transação — claim de sessão ou campo de formulário não decide autorização.
- Transações em Serializable com repetição de P2034.

Fila e integração:
- `IntegrationEvent` + `OutboxMessage` com claim atômico por lease, backoff exponencial e idempotência por `marketplaceId + externalEventId`.
- Teto de tentativas no processamento: esgotado, o evento vira `FAILED` e aparece em `/integrations` para reprocessar, em vez de ficar `PENDING` depois que a fila desiste.
- `MarketplaceConnection` representa a loja autorizada, com credenciais em AES-256-GCM e unicidade por `(provider, externalAccountId)` — é o que faz uma notificação resolver para exatamente um tenant.
- Recepção comum em `lib/integrations/webhook.ts`: Mercado Livre e Sebo compartilham autenticação por segredo, validação, resolução de conexão e gravação.
- OAuth do Mercado Livre: `state` cifrado em cookie de uso único (só o nonce viaja na URL), renovação de token com compare-and-swap pelo `updatedAt`, e recusa de renovação marcando a conexão `EXPIRED`.
- O provedor de um canal é derivado do código do canal, num lugar só que tela e backend compartilham.

## Jornada validada em produção

Compra real no Sebo On-Line, 18/09/2026:

| Hora | Etapa |
|---|---|
| 23:10:40 | compra fechada na loja |
| 23:10:42 | o sebo emitiu o aviso e o webhook gravou o evento |
| 23:11:2x | dispatcher publicou no QStash |
| 23:11:25 | job consultou o pedido pelo gateway e sincronizou |
| 23:11:26 | evento `PROCESSED` em 1 tentativa |

Dois segundos entre a compra e o aviso. Venda gravada com valores conferindo com o pedido de origem, histórico de status e auditoria com ator `INTEGRATION`.

Estão provados: emissão pelo sebo, recepção autenticada, resolução de conexão, fila durável, verificação de assinatura, busca pelo gateway, normalização e gravação.

## Defeitos que só o dado real revelou

Nenhum destes aparecia com a suíte verde. É o argumento mais concreto a favor de validar contra payload e ambiente reais antes de confiar numa integração.

1. **Fração de segundo na data.** O validador aceitava até milissegundos, que é o que o Mercado Livre manda; o `isoformat()` do Python emite microssegundos. Todo pedido do sebo era recusado, com uma mensagem que nem apontava a causa.
2. **Dois-pontos no id de deduplicação.** O QStash recusa com 400. A publicação **nunca** tinha funcionado; os testes passavam porque o publicador dublê não validava o formato. Hoje o dublê impõe a mesma regra do provedor.
3. **`APP_URL` com `vercel.ap`.** Um caractere a menos fazia a verificação de assinatura recusar toda entrega com 401, com a fila parecendo configurada.
4. **`QSTASH_URL` ausente.** Projeto QStash regional não é atendido pelo endpoint global, que responde 404. A variável estava documentada como opcional — não é.
5. **Botão de autorizar em qualquer canal.** Como a conexão é única por `(provider, externalAccountId)` e o upsert reescreve o `marketplaceId`, autorizar o ML a partir da linha errada moveria a conexão, e os pedidos do ML passariam a entrar noutro canal sem erro visível.
6. **Rotas de API sem proteção de sessão.** O matcher do proxy exclui `/api`, então authorize e callback devolviam 500 em vez de mandar ao login — e o callback descartaria o código de autorização.

O que encurtou cada diagnóstico foi instrumentação, não tentativa: o status HTTP no erro de publicação, o destino assinado na resposta do dispatcher, e os nomes dos campos, o escopo pedido e o escopo concedido na auditoria da conexão. Vale manter.

## Limitações conhecidas

- **O Mercado Livre não concede `offline_access` a esta aplicação.** Provado pela auditoria: escopo pedido `offline_access read write`, escopo concedido sem ele, resposta de token sem `refresh_token`. O portal também não oferece esse escopo na lista selecionável. Consequência: a credencial vale 6 horas e exige reautorizar na tela. O código trata isso com mensagem explícita e conexão marcada como expirada; a saída é do lado do ML (outra aplicação, usuário de teste ou suporte), não do código.
- **Nenhum provedor chega a `SHIPPED` ou `DELIVERED`.** No ML isso depende do recurso de shipments, que o recurso de pedido não carrega; o sebo não tem o conceito. O mapeamento vai até `PAID`/`CANCELLED`.
- **O sebo não tem frete, taxa nem desconto.** São zero declarado e documentado, diferente do zero presumido que o normalizador do ML proíbe.
- **A janela da conciliação tem marca própria (`lastReconciledAt`).** Não sai de `lastSyncedAt`, que avança a cada aviso entregue: se saísse, um aviso recente empurraria o começo da janela para frente e o pedido mais antigo cujo aviso se perdeu — exatamente o caso que a rotina existe para repescar — ficaria fora para sempre. A marca só avança quando a rodada termina inteira, e é carimbada com o instante em que a rodada começou.
- **Conciliação implementada só para o Sebo.** O job pergunta ao provedor o que mudou e enfileira o que falta, fechando a janela entre gravar o pedido e gravar o aviso. Para o Mercado Livre ela falha com erro nomeado: os parâmetros de busca por data não foram confirmados na documentação e não há pedido para exercitar.

## O que falta

1. **Validar o normalizador do Mercado Livre contra um pedido real.** É a pendência de maior risco. A conta não tem vendas; o usuário de teste do ML permitiria criar uma. O mapeamento está isolado em `lib/integrations/mercadolivre/normalize.ts` e coberto por fixture — trocar a fixture por um pedido real faz qualquer divergência virar teste vermelho, como já aconteceu com o sebo.
3. **Estado de envio**, integrando o recurso de shipments do ML.
4. **Shopee**, depois de conferir permissões e documentação acessível na conta. O resolver falha com erro nomeado para esse provedor.
5. **Precisão no dashboard**: a agregação ainda converte Decimal para Number na exibição, o que perde precisão em somas grandes. O caminho de pedidos usa Decimal de ponta a ponta.
6. **Catálogo, estoque e preços**, com regras de origem próprias.

## Estrutura

Implementado:
- `app/api/webhooks/{mercadolivre,sebo}/[secret]/route.ts` — recepção, cascas finas sobre `lib`.
- `app/api/integrations/mercadolivre/{authorize,callback}/route.ts` — autorização OAuth.
- `app/api/jobs/{marketplace-events,dispatch-outbox,reconcile}/route.ts` — processamento assinado, publicação e conciliação.
- `lib/integrations/` — `webhook.ts` comum, `crypto.ts`, `oauth-state.ts`, `resolve.ts`, e os adapters `mercadolivre/` e `sebo/`.
- `lib/services/` — sales, integration-events, outbox, connections, members, organizations, access, transactions.
- `lib/domain/` — order-input, sale-status, roles, marketplace-provider, audit-filter.

A criar: `lib/integrations/shopee/`, listagem de alterados do Mercado Livre em `lib/integrations/reconcile.ts`, e a tela de conexões ganhar remoção/revogação.

## Configuração

Variáveis em `.env.example`. As que causaram falha silenciosa e merecem atenção:

- `APP_URL` — https, sem caminho. É a base do destino assinado; divergência devolve 401 em toda entrega.
- `QSTASH_URL` — obrigatória em projeto regional.
- `DATABASE_URL` pooled (host com `-pooler` no Neon) e `DIRECT_DATABASE_URL` sem pooler, para `prisma migrate`. **Manter as duas sempre no mesmo ambiente:** com elas divergentes, um comando de migration mira produção enquanto a aplicação roda local.
- `INTEGRATION_ENCRYPTION_KEY` — 32 bytes base64. Regerar torna ilegíveis os tokens já cifrados.

O seed não roda no build: banco novo nasce sem organização e sem usuário, e ninguém consegue entrar até rodar `prisma db seed`.

## Custos

- [QStash](https://upstash.com/pricing/qstash): gratuito com 1.000 entregas/dia. Cada tentativa conta, inclusive retry, e o schedule a cada 5 minutos consome 288 por dia. Entrega recusada por assinatura inválida ainda gera as retentativas configuradas — foi assim que uma configuração errada queimou dezenas de entregas num diagnóstico.
- [SQS](https://aws.amazon.com/sqs/pricing/) e [CloudAMQP](https://www.cloudamqp.com/plans.html) seguem como alternativas se a infraestrutura migrar.
- O gratuito da fila não cobre hospedagem, banco, tráfego e execução.

## Limites do que foi verificado

- O Sebo On-Line foi validado com pedido real em produção. **O Mercado Livre não**: nenhuma venda passou por ele, e o mapeamento de valores é intenção declarada.
- O portal de desenvolvedores do Mercado Livre responde 403 a consulta automatizada. Os endpoints de autorização e token foram confirmados na prática — a autorização fecha e a conexão é gravada — mas continuam configuráveis por variável.
- Não houve medição de latência do webhook, teste de carga nem exploração de segurança.
- A renovação de token do ML nunca rodou de verdade, porque o provedor não emite refresh token para esta aplicação. O caminho está coberto por teste com dublê, incluindo a corrida do compare-and-swap.
