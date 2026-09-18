# Integração Mercado Livre + Shopee — diagnóstico e proposta

Análise em 18/09/2026, atualizada no mesmo dia após a implementação da recepção e do processamento.
Destino informado: Vercel ou outra plataforma serverless.
Escopo desta atualização: o encanamento da fila, o modelo de conexão e o adapter do Mercado Livre foram implementados e cobertos por testes contra PostgreSQL com dublês. Nenhuma chamada real ao Mercado Livre ou ao QStash foi feita e nenhuma credencial foi provisionada.

## Decisões tomadas

- **Fila:** QStash para entrega HTTP dos trabalhos, mantendo Next.js, Prisma e PostgreSQL. RabbitMQ foi descartado por exigir broker gerenciado e um consumidor contínuo hospedado. SQS com Lambda segue como alternativa caso a infraestrutura migre para AWS.
- **Estágio do payload:** `IntegrationEvent.payload` guarda a notificação crua; consultar o pedido e normalizar acontece no job. Um salto de fila por notificação. A alternativa de um modelo de inbox cru separado foi descartada por dobrar o consumo de cota e por exigir dois modelos e dois outbox em operação.
- **Agendador:** schedule do próprio QStash chamando o dispatcher, para não amarrar a decisão de hospedagem. Cron da Vercel foi descartado por prender o deploy e por ter frequência diária no plano Hobby.
- **Módulos no mesmo repositório**, sem microsserviços. Estoque, preços e publicação de anúncios seguem fora de escopo porque esses domínios não existem no banco.

## O que existe

Verificado por leitura do código e por 55 testes automatizados. `npm run test:orders` sobe PostgreSQL 16 em contêiner efêmero, aplica as migrations, checa divergência entre schema e migrations e roda as suítes; `npm run test:models` valida as migrations do modelo de pedidos.

Base:
- package.json: Next.js 16.2.6, React 19.2.4, TypeScript, NextAuth 5 beta e Prisma 6.
- prisma/schema.prisma: Organization, User, Marketplace, MarketplaceConnection, Sale, SaleItem, SaleStatusHistory, IntegrationEvent, OutboxMessage e AuditLog.
- Sale tem valores monetários Decimal, `statusVersion` para concorrência otimista e restrição única por marketplaceId + externalOrderId.
- Dockerfile e docker-compose.yaml: execução standalone com app e PostgreSQL locais. Isso não comprova implantação em produção.
- O seed cadastra Mercado Livre, Shopee e Amazon como nomes e códigos. Cadastro de canal não equivale a conexão autorizada: a autorização vive em MarketplaceConnection.

Autorização e domínio:
- lib/current-actor.ts resolve ator, organização e papel no banco. Papel vindo da sessão ou de formulário não decide autorização; os serviços releem o papel dentro da transação.
- Perfis: PLATFORM_ADMIN é o único que cruza organizações, ADMIN administra a própria e OPERATOR apenas opera vendas.
- lib/services/sales.ts separa operação humana de importação. lib/services/members.ts e lib/services/organizations.ts fazem gestão de equipe e de empresas, com auditoria na mesma transação.
- lib/domain/order-input.ts valida dinheiro em Decimal e rejeita datas impossíveis; lib/domain/sale-status.ts concentra as transições permitidas.
- Transações em Serializable com repetição de P2034 em lib/services/transactions.ts.

Fila e integração:
- IntegrationEvent e OutboxMessage com claim atômico por lease, backoff exponencial até oito tentativas de publicação e idempotência por marketplaceId + externalEventId.
- lib/messaging/qstash.ts publica com destino fixo e lista de hosts permitidos, e verifica assinatura com rotação de chave.
- O processamento tem teto de tentativas: esgotado, o evento vira FAILED e aparece em /integrations para reprocessamento, em vez de permanecer PENDING depois que a fila desiste.
- lib/integrations/mercadolivre/ contém parser do aviso, cliente, normalizador e recepção do webhook. O `resource` do aviso nunca é usado como URL: o id é extraído e a chamada remontada num host fixo.
- Tokens das conexões são cifrados em AES-256-GCM (lib/integrations/crypto.ts) e nunca vão ao navegador nem a log.
- Rotas: app/api/webhooks/mercadolivre/[secret], app/api/jobs/marketplace-events e app/api/jobs/dispatch-outbox.

## Ajustes que precediam a integração

Os seis pontos do diagnóstico original estão resolvidos, com uma ressalva no quinto.

1. **Isolamento por organização.** As ações derivam a organização da sessão e conferem as entidades no servidor; no processamento automático a organização vem da conexão registrada, nunca do corpo recebido. Testes cobrem rejeição entre organizações em vendas, equipe, empresas e eventos.
2. **Auditoria de sistema.** AuditLog aceita ator humano ou de integração, com vínculo ao evento. Venda, itens, histórico e auditoria confirmam na mesma transação; há teste que derruba a auditoria por trigger e verifica que nada sobra. O antigo lib/audit.ts, que desistia sem sessão, foi removido.
3. **Serviço de pedidos.** Serviço de domínio independente de sessão e de revalidatePath, com mapeamento de estados externos, upsert, versão de status e tratamento de evento atrasado. DELIVERED passou a admitir REFUNDED.
4. **Contas por canal.** MarketplaceConnection representa cada loja autorizada, com índice único por provedor e conta externa — é o que faz uma notificação resolver para exatamente um tenant. A identidade do pedido segue em marketplaceId + externalOrderId, preservando vendas manuais e relatórios.
5. **Precisão financeira.** O caminho de pedidos usa Decimal de ponta a ponta, e valor monetário ausente é erro nomeado em vez de zero presumido. **Pendente:** a agregação do dashboard ainda converte Decimal para Number para exibição, o que perde precisão em somas grandes.
6. **Preparação para deploy.** next.config.ts não ignora mais erros de TypeScript e não contém a opção removida no Next.js 16. O middleware foi migrado para a convenção proxy, que roda obrigatoriamente no runtime Node.js — isso também remove o risco de carregar o cliente Prisma no edge. Lint e checagem de tipos estão limpos. Permanecem: PostgreSQL gerenciado, migrations controladas na publicação e limite de pool adequado.

## Fluxo implementado

Marketplace → webhook Next.js → registro durável no PostgreSQL → QStash → endpoint de processamento → adapter da plataforma → API oficial → normalização → Sale + SaleItem + auditoria.

Recepção:
- Valida formato, tamanho, tópico e aplicação, e autentica por segredo no caminho com comparação em tempo constante. Responde 404 em vez de 401 para não confirmar o endpoint.
- Resolve a conexão pelo vendedor do aviso e persiste IntegrationEvent e a pendência de publicação em uma transação curta antes de confirmar o recebimento.
- Não consulta pedido, não renova token e não executa regra de negócio. A documentação do ML pede HTTP 200 em até 500 ms; a latência real, incluindo partida a frio e conexão ao banco, **não foi medida**.
- Tópico alheio, aplicação alheia e vendedor desconhecido são confirmados com 200 e descartados, para não gerar reenvio indefinido. Isso não deixa rastro do descarte.
- A publicação no QStash fica a cargo do dispatcher agendado, que recupera o outbox pendente com lease e tentativas limitadas. Duplicação de publicação é esperada em falhas intermediárias e absorvida pela idempotência a jusante.

Processamento:
- Verifica a assinatura do QStash com o corpo original e a URL esperada, e consome apenas o identificador do evento.
- Carrega evento e conexão do banco, consulta o pedido com a credencial da loja em host conhecido, normaliza e só então abre a transação. A consulta ao provedor nunca mantém transação aberta.
- O status do evento é reconferido dentro da transação, porque uma entrega concorrente pode ter concluído primeiro. Há idempotência de evento e de pedido, proteção contra versão antiga e histórico append-only com unicidade por evento.
- Falha permanente encerra o evento como FAILED com motivo; falha transitória repete até o teto. 429 e 5xx do provedor são classificados como transitórios; 401 e 403 exigem reautorizar.

Ainda não implementado: autorização OAuth, renovação de token, estado de envio, conciliação periódica e Shopee.

## O que falta para operar

Provisionamento, fora do repositório:
- APP_URL, QSTASH_TOKEN, as duas signing keys, CRON_SECRET, INTEGRATION_ENCRYPTION_KEY, MERCADO_LIVRE_WEBHOOK_SECRET e MERCADO_LIVRE_APP_ID. Sem as de mensageria, as rotas de job respondem 503. O template está em `.env.example`.
- Schedule no QStash apontando para /api/jobs/dispatch-outbox e entregando o cabeçalho Authorization com o CRON_SECRET. O repositório não provisiona agendamento.
- Aplicação de desenvolvedor no Mercado Livre e URL de callback com o segredo no caminho.
- URL pública HTTPS: `messagingConfig()` recusa http e localhost, e o QStash precisa alcançar a aplicação. Exercitar a fila localmente exige túnel.

Código, em ordem de risco:
1. **Validar o mapeamento de valores contra um pedido real.** É a pendência de maior risco e está isolada em lib/integrations/mercadolivre/normalize.ts, com o contrato assumido declarado no topo do arquivo e coberto por fixture. Trocar a fixture por um pedido real da conta autorizada faz qualquer divergência aparecer como teste vermelho.
2. OAuth do Mercado Livre e renovação de token com controle de concorrência. Enquanto não existe, a conexão é cadastrada por `npm run connection:register` e credencial expirada falha com mensagem explícita em vez de renovar.
3. Estado de envio: SHIPPED e DELIVERED dependem do recurso de shipments, que o recurso de pedido não carrega. O mapeamento atual chega até PAID e CANCELLED.
4. Conciliação periódica de pedidos alterados, para recuperar lacunas de notificação. O teto de tentativas limita repetição, mas não repesca aviso perdido.
5. Interface para cadastrar e revogar conexões, hoje só por script.
6. Shopee, depois de conferir permissões, credenciais e documentação acessível na conta. O resolver falha com erro nomeado para esse provedor.
7. Catálogo, estoque e preços, com regras de origem e reconciliação próprias.

## Estrutura

Implementado:
- app/api/webhooks/mercadolivre/[secret]/route.ts — recepção, casca fina sobre lib.
- app/api/jobs/marketplace-events/route.ts — processamento assinado.
- app/api/jobs/dispatch-outbox/route.ts — publicação de pendências, autenticada por segredo de serviço.
- lib/integrations/mercadolivre/{notification,client,normalize,webhook}.ts e lib/integrations/{crypto,resolve}.ts.
- lib/messaging/ — publicação, validação de assinatura e limite de corpo.
- lib/services/ — sales, integration-events, outbox, members, organizations, access, transactions.
- MarketplaceConnection, IntegrationEvent, OutboxMessage e SaleStatusHistory no schema.

A criar:
- app/api/integrations/[provider]/... — autorização e callback, com state validado e vínculo seguro à organização.
- lib/integrations/shopee/ — autenticação, cliente e normalização.
- Job de conciliação e tela de conexões.

## Ordem de entrega e critérios

1. **Concluído.** Autorização corrigida e serviço de vendas extraído; testes cobrem rejeição entre organizações, Decimal e auditoria sem sessão.
2. **Concluído em parte.** Conexões, eventos e outbox existem. O fluxo de autorização do Mercado Livre não.
3. **Concluído em parte.** O pedido é consultado no recurso oficial e mapeado ao modelo atual; o mapeamento de valores não foi validado contra payload real.
4. **Concluído.** QStash, dispatcher e reprocessamento ligados. Testes cobrem duplicação, publicação indisponível, falha antes e depois do commit, concorrência, credencial expirada, evento fora de ordem e esgotamento de tentativas.
5. Pendente: Shopee.
6. Pendente: PostgreSQL gerenciado e deploy; validar callback HTTPS, latência, limites de execução, volume e observabilidade.
7. Pendente: catálogo, estoque e preços.

Critérios do primeiro ciclo, cobertos por teste: a venda entra uma única vez na organização correta; mudança de status não sofre regressão por evento antigo; falha é recuperável e visível; toda alteração automática tem origem rastreável na auditoria. O que nenhum teste cobre é o comportamento contra o provedor real.

## Custos e documentação

- [QStash](https://upstash.com/pricing/qstash): gratuito com 1.000 entregas/dia e mensagem até 1 MB. Cada tentativa conta, inclusive retry, e o schedule do dispatcher também consome cota. Uma venda pode gerar vários eventos. O plano por uso publica US$ 1 por 100 mil mensagens, com condições adicionais de banda. Custo total não estimado sem volume.
- [CloudAMQP](https://www.cloudamqp.com/plans.html): Little Lemur gratuito, apresentado para desenvolvimento, com 1 milhão de mensagens/mês, 100 filas, 10 mil mensagens enfileiradas e 20 conexões. Não é promessa de disponibilidade para produção.
- [SQS](https://aws.amazon.com/sqs/pricing/): 1 milhão de requests/mês gratuitos; enviar, receber e remover são ações distintas. Não equivale a 1 milhão de pedidos completos.
- [Notificações ML](https://developers.mercadolivre.com.br/produto-receba-notificacoes): orders_v2 e confirmação HTTP 200 em até 500 ms.
- [QStash: introdução](https://upstash.com/docs/qstash/overall/getstarted) e [assinaturas](https://upstash.com/docs/qstash/howto/signature).
- [Shopee Open Platform](https://open.shopee.com/documents): a consulta automática retornou HTTP 403. Requisitos de elegibilidade, autorização e assinatura não foram confirmados; não assumir equivalência com o ML.
- Nesta atualização, as páginas do portal de desenvolvedores do Mercado Livre também responderam HTTP 403 à consulta automatizada. O contrato de campos do pedido não foi reconfirmado, e é por isso que o mapeamento de valores está declarado como intenção a validar.

O gratuito da fila não cobre hospedagem, banco, tráfego e execução. Permanecem a dimensionar: lojas conectadas, eventos por dia, histórico a importar, provedor do banco e disponibilidade das credenciais de desenvolvedor.

## Limites do que foi verificado

- Nenhuma chamada real ao Mercado Livre ou ao QStash. Os testes usam dublês para o provedor e para a publicação.
- Não houve medição de latência do webhook, teste de carga, deploy, nem exploração de segurança.
- O mapeamento de valores e o mapeamento de status do Mercado Livre são intenção declarada, não contrato confirmado.
- O repositório tem alterações não commitadas.

Referências locais: prisma/schema.prisma; lib/services/; lib/integrations/; lib/messaging/; app/api/webhooks/; app/api/jobs/; .env.example; tests/.
Guias lidos: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md, .../proxy.md e trechos de 01-app/02-guides/upgrading/version-16.md.
