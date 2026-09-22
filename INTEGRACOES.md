# Integração de marketplaces — estado e pendências

Primeira análise em 18/09/2026, atualizada em 19/09/2026 depois de a integração rodar em produção.
Aplicação publicada em `https://omnicommerce.vercel.app` (Vercel), banco no Neon (`sa-east-1`), fila no QStash (`us-east-1`).

**Os dois provedores estão integrados e validados de ponta a ponta com pedido real**, cada um com a notificação entregue pelo próprio provedor. No Mercado Livre a validação foi feita com usuários de teste criados pela API.

## Decisões tomadas

- **Fila:** QStash para entrega HTTP, mantendo Next.js, Prisma e PostgreSQL. RabbitMQ foi descartado por exigir broker gerenciado e consumidor contínuo hospedado.
- **Estágio do payload:** `IntegrationEvent.payload` guarda a notificação crua; consultar o pedido e normalizar acontece no job. Um salto de fila por notificação.
- **Agendador:** schedules do próprio QStash, para não amarrar a hospedagem. `omnicommerce-dispatch-outbox` a cada 5 minutos publica o outbox; `omnicommerce-reconcile` roda de hora em hora, no minuto 17 para não bater com os ticks do dispatcher, porque a conciliação é rede de segurança e não via principal. Ambos estão registrados e repassam o `CRON_SECRET` no `Authorization`, sem retentativa: a rodada seguinte recupera.
- **Loja própria pelo mesmo caminho dos marketplaces:** o Sebo entra como provedor `SEBO_ONLINE` e reaproveita todo o pipeline. Um modelo mental só.
- **Migrations na publicação:** Build Command `npm run build:vercel`. O `build` normal não toca o banco, senão o estágio builder do Dockerfile quebraria.

## O que existe

Verificado por leitura do código e por **361 testes automatizados**. `npm run test:orders` sobe PostgreSQL 16 em contêiner efêmero, aplica as 19 migrations, aborta se houver divergência entre schema e migrations, e roda as suítes. Nenhum teste toca a rede: provedores e publicação são dublês.

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

## Isolamento por organização: validado, e o que saiu do ambiente

A propriedade foi **verificada porta por porta**, não por leitura:
`tests/tenant-isolation.test.ts` monta duas organizações completas e, para cada
função de serviço que a tela chama com um identificador, o ator de uma tenta
alcançar o registro da outra — editar produto, mexer em estoque, publicar,
navegar e buscar árvore de categorias, escolher categoria, ler e gravar
atributos, criar venda em canal alheio, mudar venda alheia. Todas as portas
recusaram, e o trabalhador de publicação respeita a organização pedida na
rodada.

Uma varredura das 124 consultas a modelos de tenant mostra 73 sem filtro de
organização no próprio `where` — e isso é o desenho, não um defeito: o padrão do
código é "valide o id dentro da organização, depois opere por chave primária".
O que garante a propriedade é o primeiro passo, e é ele que o teste exercita.
O restante das consultas sem filtro é de plataforma (login por e-mail, papel do
ator) ou de identidade de provedor (o aviso resolve a conexão por
`externalAccountId`, que é como o tenant é DESCOBERTO, não vazado).

**Dado de organização saiu do `.env`.** Telefone e CEP do anunciante da OLX
viviam em variável de ambiente, e isso está errado num deploy que atende várias
empresas: uma variável serve a todas ao mesmo tempo, e o anúncio de uma sairia
com o telefone da outra. Agora moram no cadastro da organização (razão social,
CNPJ, contato e endereço), editável na tela de Organizações pelo administrador
da própria empresa — o operador da plataforma edita qualquer uma. Quem publica
lê pela organização do produto.

O CNPJ é conferido pelos dígitos verificadores, pela mesma razão que o cartão
passa por Luhn: um dígito trocado só apareceria na nota do cliente. CNPJ
repetido em outra organização é recusado nomeando ela, porque é quase sempre
cadastro duplicado da mesma empresa — e a conferência é no serviço, não num
índice único, porque a coluna nasce vazia em todas as organizações existentes e
o índice recusaria a segunda vazia.

Continuam em ambiente, corretamente, as credenciais de APLICAÇÃO (as do
Mercado Livre, Shopee e OLX são uma por integração, não por cliente), as chaves
de cifra e assinatura, e o endereço do banco.

## Shopee e OLX: código pronto, nada medido

Os dois adapters estão completos — autorização, publicação, pedido onde existe, e
testes com dublês — e **nenhuma linha deles falou com o provedor de verdade**. O
motivo é o mesmo nos dois casos, e é de cadastro, não de código: a Shopee exige
conta de desenvolvedor aprovada e, no Brasil, CNPJ (o tipo "Individual Seller"
está fechado para BR); a OLX entrega `client_id` por aprovação manual por e-mail
e veda a API a plano de autônomo.

O que cada um tem:

- **Shopee** (Open Platform v2): assinatura HMAC-SHA256 com a base
  `partner_id + caminho + timestamp` (+ `access_token` + `shop_id` nas rotas de
  loja), erro reportado DENTRO de HTTP 200, sandbox como host separado,
  `access_token` de 4h com `refresh_token` de 30 dias e autorização de até 365
  dias — o oposto do Mercado Livre, que sem `offline_access` morre em 6 horas.
  Publicação com upload de imagem, logística lida da loja, preço e estoque em
  rotas próprias, e um resumo do que foi publicado em `publishedAttributes` para
  não reenviar o álbum a cada venda. Pedido, conciliação por cursor e push com
  assinatura conferível (desligada por padrão, porque a construção dela não foi
  medida e um palpite errado derrubaria todo aviso com 404).
- **OLX** (autoupload): é **classificados**, não marketplace. Publica anúncio e
  **não tem API de pedido** — a venda acontece no telefone ou no chat, fora da
  plataforma. Então participa só da jornada de saída, e conciliação e resolução
  de pedido recusam com essa frase, em vez de "não implementado". O identificador
  do anúncio é o nosso (a OLX casa a importação por ele, então reenviar é
  edição), a imagem vai por URL e não por arquivo, o preço é inteiro em reais, e
  produto desativado vira `operation: delete`. A importação é assíncrona: o `PUT`
  devolve um token e o destino de cada anúncio sai numa segunda chamada.

## Aviso de pedido que não existe mais

Uma venda do Sebo demorou a aparecer, e o rastro explicou três coisas de uma vez.
O aviso tinha chegado em segundos; o que atrasou foi a fila. Na hora em que a
loja voltou a receber compra, ela despejou **46 avisos atrasados de uma vez** --
a fila dela só é esvaziada quando alguém compra --, e a venda nova entrou atrás
de todos. O despachante mandava **4 por rodada a cada 5 minutos**: uma hora de
espera. E a maior parte daqueles 46 apontava para pedidos que a loja **já tinha
apagado**, então cada um virava uma consulta que respondia 404 e uma falha
permanente aqui. Eram 224 eventos assim, todos pedindo atenção numa tela onde
ninguém podia fazer nada a respeito.

O conserto é dos dois lados, e cada um resolve uma coisa:

- **No Sebo (quem avisa)**: o aviso de um pedido apagado é descartado **antes de
  sair** (`DISCARDED`/`ORDER_GONE`), e o mesmo vale para aviso que envelheceu na
  fila além do prazo (`TOO_OLD`, três dias por padrão). Anunciar um pedido que
  não se pode servir é o defeito na origem; pedido antigo entra pela
  conciliação, que existe para isso.
- **Aqui (quem recebe)**: 404 ao ler o pedido virou `ProviderOrderGoneError`, e
  o evento é **encerrado** (`IGNORED`) em vez de marcado como falha. Continua
  permanente -- repetir não traz o pedido de volta --, mas não pede atenção,
  porque não há nada a corrigir. E o despacho subiu para **20 por rodada**, que
  drena uma rajada em uma ou duas rodadas em vez de uma hora.

No caminho apareceu um defeito que só existia em produção: o histórico de
tentativas classificava o erro por `error.constructor.name`, e **o build é
minificado** -- a classe chegava como `"i"`. Como o nome nunca casava com a
lista de erros nossos, o histórico gravava uma letra e **nenhuma mensagem**,
justamente nos erros que podiam ser mostrados. Nenhum teste pegava, porque teste
roda sem minificar. Agora cada classe nossa declara `name` como texto (que o
minificador não toca) e o registro usa `error.name`.

## Facebook: catálogo do Meta, não Marketplace

O canal do Facebook existe, e é importante dizer o que ele **não** é: não há API
pública para anunciar no Marketplace. A de parceiros (Marketplace Partner
Program) é fechada, sai por aprovação comercial e atende sobretudo veículos e
imóveis. O que é aberto é o **catálogo do Commerce Manager**, e é nele que este
adapter escreve, pela Graph API. O produto publicado aqui abastece a loja do
Facebook e do Instagram; chega ao Marketplace só para quem está no programa — e,
aí, o catálogo já é a fonte. A frase está no cabeçalho de
`lib/integrations/facebook/client.ts` porque a tela, ao mostrar "Facebook" na
lista de canais, promete sozinha o que a integração não entrega.

Como a OLX, é canal **só de publicação**: conciliação e resolução de pedido
recusam com essa frase, em vez de "não implementado". A diferença é o motivo —
a OLX não tem pedido nenhum; a Meta tem checkout, mas só nos Estados Unidos, e a
venda do Marketplace acontece na conversa entre as pessoas.

O que o adapter faz:

- **`UPDATE` com `allow_upsert`, nunca `CREATE`**: cria o que não existe e edita
  o que existe, que é o que o modelo de estado desejado pede — a rodada reenvia
  o valor atual sem saber se o item já está lá.
- **O identificador do item é o SKU** (`retailer_id`), e não um id nosso como na
  OLX: é o que o catálogo do cliente já usa, inclusive se ele o alimentar por
  outra fonte. Em troca, corrigir um SKU aqui deixa o item antigo órfão lá.
- **Estoque zero esgota, produto desativado remove**: `availability: out of
  stock` preserva histórico e anúncios; `DELETE` é como se despublica.
- **Imagem por URL em HTTPS**, nunca embutida — a Meta busca no endereço.
- **O link é obrigatório e não existe no produto**: vem de `productUrlBase` na
  configuração do canal, com o SKU no fim. Mesma ideia do telefone e do CEP da
  OLX, que são do anunciante e não do produto.
- **Gravação assíncrona**: `items_batch` devolve um `handle` e o destino sai em
  `check_batch_request_status`. Uma consulta só, sem espera — falha de consulta
  não derruba item que a Meta já aceitou, e o `handle` fica registrado.
- **Erro classificado pelo código, não pelo status**: a Meta responde 400 em
  quase tudo, inclusive em token vencido e em excesso de chamadas. `190` vira
  reautorização; `4`, `17`, `32`, `613`, `80004` viram nova tentativa; o resto é
  problema do que mandamos, e repetir só queima as tentativas do anúncio.

Na autorização, duas escolhas próprias da Meta: **não há refresh token** (o
token longo vale cerca de 60 dias e um vencido não serve nem para pedir outro),
então a troca pelo token de longa duração acontece **na hora**, e não depois; e
o escopo `catalog_management` é conferido **na autorização**, porque sem ele a
conexão nasceria ativa e toda publicação voltaria como falta de permissão, dias
depois e sem ligação visível com a causa.

Categoria: o catálogo da Meta não exige categoria de canal (a dela é opcional),
então este canal fica no modo `texto-livre`, sem aba de categoria a preencher.

Categoria ganhou um terceiro modo por causa deles: além de árvore importada
(Mercado Livre) e texto livre do produto (Sebo), existe **código digitado** —
Shopee e OLX exigem a categoria deles e a árvore não é importada aqui. Sem esse
modo, a tela mandava usar texto livre e a publicação recusava para sempre.

## Configuração de canal: do ambiente para o banco

A tela de Marketplaces tinha um campo de **código livre**, e o sistema derivava
a integração desse texto: quem digitasse `mercadolivre_2` ficava com um canal
que nunca se conectava, sem erro em lugar nenhum. Agora o provedor vem de uma
**lista suspensa**, é gravado em `Marketplace.provider`, e o código é derivado
dele -- os valores continuam sendo `mercado_livre`, `shopee`, `olx` e `sebo`,
porque URL, log e a árvore de categorias os referenciam.

Junto veio a parte que faltava para a plataforma atender mais de uma empresa: as
**credenciais de cada provedor saíram do ambiente**. Eram `MERCADO_LIVRE_APP_ID`,
`SHOPEE_PARTNER_KEY`, `SEBO_API_URL` e companhia -- uma aplicação e uma loja
para todas as organizações do mesmo deploy. Uma organização nova dependia de
alguém mexer em variável de ambiente. Hoje cada uma cadastra as suas em
`MarketplaceSetting`, e a tela mostra os campos **daquele** provedor, vindos de
um catálogo único (`lib/domain/marketplace-config.ts`) que a tela e a validação
do servidor compartilham.

Quatro decisões que valem registro:

- **Um canal por provedor por organização**, garantido por índice único. Não é
  gosto: a conexão é única por (provedor, conta), então autorizar a partir de um
  segundo canal do mesmo provedor MOVE a conexão para ele, e os pedidos passam a
  entrar no canal errado sem nenhum erro visível.
- **Segredo não volta.** O que é segredo é gravado cifrado (mesmo cofre do token
  da conexão), a tela só sabe que existe, e a auditoria registra o NOME do campo
  alterado -- nunca o valor, porque o log é lido por mais gente que o cofre.
- **O segredo do webhook identifica o tenant.** O provedor chama a URL sem dizer
  de quem é o aviso, e o segredo deixou de ser um só do deploy. Ele é encontrado
  por `sha256` (`lookupHash`), porque o ciphertext tem IV aleatório e não serve
  para busca; a confirmação é comparação de tempo constante. Quem não casa
  recebe 404, igual a antes.
- **A configuração é lida no ramo que precisa dela.** Consultar um pedido do
  Mercado Livre com token válido não vai ao banco buscar credencial; a
  renovação, sim. E a recusa da OLX ("não tem pedido") continua sem tocar no
  banco -- há teste que passa um banco nulo justamente para provar isso.

`APP_URL` e `INTEGRATION_ENCRYPTION_KEY` continuam no ambiente de propósito: são
da instalação, não de uma organização. As variáveis de provedor ainda existem
para uma única finalidade -- `npm run config:import`, que roda no `build:vercel`
e leva para o banco o que ainda não estiver lá, **sem sobrescrever** o que foi
digitado na tela. É idempotente e não derruba o build: falhar ali deixa a tela
dizendo o que falta, o que é melhor que um deploy que não sai.

## Histórico por tentativa

A listagem de eventos mostrava `lastError`, que é **sobrescrito**: um evento com
oito tentativas exibia só o motivo da oitava. E quando a falha era transitória
nem isso, porque a coluna recebia o código genérico `PROCESSING_FAILED` e a
razão real se perdia. A pergunta "por que ESTE pedido não entrou?" não tinha
resposta no sistema.

`IntegrationEventAttempt` grava uma linha por tentativa, das duas metades da
jornada -- processar o aviso e entregar o resultado na fila --, com o resultado
(sucesso, falha temporária, falha definitiva), a duração e o erro. A tela fica
em `/integrations/events/[id]`, com link em cada linha da listagem.

O que entra no campo de erro segue a regra que o despacho da fila já aplicava:
**mensagem de terceiro não é registrada**, porque pode carregar cabeçalho, URL
assinada ou credencial -- e credencial que apareceu num log precisa ser trocada
no provedor. Entra sempre o NOME DA CLASSE, que é seguro e é o que separa
`TypeError` (defeito nosso) de `ProviderTransientError` (o provedor caiu) de
`PrismaClientKnownRequestError` (o banco recusou); a mensagem entra apenas
quando o erro é nosso. A duração acompanha porque falha em 30 s é timeout e
falha em 30 ms é recusa, e as duas pedem investigação diferente.

Registrar histórico nunca derruba o processamento: o registro do sucesso vai na
mesma transação do resultado (um histórico dizendo "deu certo" sobre um evento
que não concluiu seria pior que nenhum), e a falha em gravar é engolida -- o
histórico existe para explicar o que aconteceu, não para decidir se acontece.

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

Compra real no Mercado Livre, 19/09/2026, com usuários de teste criados pela API (`POST /users/test_user`):

| Hora | Etapa |
|---|---|
| 22:18:25 | compra fechada no ML |
| 22:18:29 | ML emitiu o aviso; o webhook gravou em 153 ms |
| 22:18:31, 22:18:32 | segundo e terceiro avisos do mesmo pedido |
| 22:19:04 | job consultou o pedido e gravou a venda |
| 22:19:06 | os três eventos concluídos |

Quatro segundos entre a compra e o aviso. Dos três avisos, o primeiro virou `PROCESSED` e os outros dois `IGNORED`: uma venda, um registro de histórico, nenhuma duplicata — idempotência exercitada com dado real, não com dublê. Valores conferidos contra a resposta do ML: bruto 123,45 (`total_amount`, igual à soma dos itens), taxas 16,05 (`sale_fee`), frete 0,00 vindo de `payments[].shipping_cost` (zero declarado, não presumido), líquido 107,40.

## Defeitos que só o dado real revelou

Nenhum destes aparecia com a suíte verde. É o argumento mais concreto a favor de validar contra payload e ambiente reais antes de confiar numa integração.

1. **Fração de segundo na data.** O validador aceitava até milissegundos, que é o que o Mercado Livre manda; o `isoformat()` do Python emite microssegundos. Todo pedido do sebo era recusado, com uma mensagem que nem apontava a causa.
2. **Dois-pontos no id de deduplicação.** O QStash recusa com 400. A publicação **nunca** tinha funcionado; os testes passavam porque o publicador dublê não validava o formato. Hoje o dublê impõe a mesma regra do provedor.
3. **`APP_URL` com `vercel.ap`.** Um caractere a menos fazia a verificação de assinatura recusar toda entrega com 401, com a fila parecendo configurada.
4. **`QSTASH_URL` ausente.** Projeto QStash regional não é atendido pelo endpoint global, que responde 404. A variável estava documentada como opcional — não é.
5. **Botão de autorizar em qualquer canal.** Como a conexão é única por `(provider, externalAccountId)` e o upsert reescreve o `marketplaceId`, autorizar o ML a partir da linha errada moveria a conexão, e os pedidos do ML passariam a entrar noutro canal sem erro visível.
6. **URL de notificações truncada no DevCenter.** O campo corta em 120 caracteres sem avisar. Com `openssl rand -hex 32` -- que era a receita no próprio `.env.example` -- a URL fica com 122 e o portal salva os 120 primeiros, exibindo a URL cortada como se estivesse correta. Os dois últimos caracteres do segredo somem e **toda** notificação do Mercado Livre bate num 404. O segredo passou a ser de 32 caracteres.
7. **Rotas de API sem proteção de sessão.** O matcher do proxy exclui `/api`, então authorize e callback devolviam 500 em vez de mandar ao login — e o callback descartaria o código de autorização.

O que encurtou cada diagnóstico foi instrumentação, não tentativa: o status HTTP no erro de publicação, o destino assinado na resposta do dispatcher, e os nomes dos campos, o escopo pedido e o escopo concedido na auditoria da conexão. Vale manter.

## Limitações conhecidas

- **O Mercado Livre não concede `offline_access` a esta aplicação.** Provado pela auditoria: escopo pedido `offline_access read write`, escopo concedido sem ele, resposta de token sem `refresh_token`. O portal também não oferece esse escopo na lista selecionável. Consequência: a credencial vale 6 horas e exige reautorizar na tela. O código trata isso com mensagem explícita e conexão marcada como expirada; a saída é do lado do ML (outra aplicação, usuário de teste ou suporte), não do código.
- **Nenhum provedor chega a `SHIPPED` ou `DELIVERED`.** No ML isso depende do recurso de shipments, que o recurso de pedido não carrega; o sebo não tem o conceito. O mapeamento vai até `PAID`/`CANCELLED`.
- **O sebo não tem frete, taxa nem desconto.** São zero declarado e documentado, diferente do zero presumido que o normalizador do ML proíbe.
- **A janela da conciliação tem marca própria (`lastReconciledAt`).** Não sai de `lastSyncedAt`, que avança a cada aviso entregue: se saísse, um aviso recente empurraria o começo da janela para frente e o pedido mais antigo cujo aviso se perdeu — exatamente o caso que a rotina existe para repescar — ficaria fora para sempre. A marca só avança quando a rodada termina inteira, e é carimbada com o instante em que a rodada começou.
- **Conciliação implementada só para o Sebo.** O job pergunta ao provedor o que mudou e enfileira o que falta, fechando a janela entre gravar o pedido e gravar o aviso. Para o Mercado Livre ela falha com erro nomeado: os parâmetros de busca por data não foram confirmados na documentação e não há pedido para exercitar.

## O que falta

1. **Conciliação do Mercado Livre**, em `lib/integrations/reconcile.ts`. Agora existe um pedido real na conta de teste para confirmar os parâmetros de busca por data, que antes não dava para exercitar.
2. **Estado de envio**, integrando o recurso de shipments do ML.
3. **Shopee**, depois de conferir permissões e documentação acessível na conta. O resolver falha com erro nomeado para esse provedor.
4. **Precisão no dashboard**: a agregação ainda converte Decimal para Number na exibição, o que perde precisão em somas grandes. O caminho de pedidos usa Decimal de ponta a ponta.
5. **Catálogo, estoque e preços**, com regras de origem próprias.

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

- Os dois provedores foram validados com pedido real em produção. No Mercado Livre foi **um** pedido, de um usuário de teste, com um item, sem frete e sem desconto: o mapeamento de frete, cupom e múltiplos itens continua coberto só por fixture.
- O portal de desenvolvedores do Mercado Livre responde 403 a consulta automatizada. Os endpoints de autorização e token foram confirmados na prática — a autorização fecha e a conexão é gravada — mas continuam configuráveis por variável.
- **Shopee, OLX e Facebook não foram exercitados contra a API real** — nenhuma chamada, nem em sandbox. Tudo que existe vem da documentação pública, com os pontos incertos isolados em configuração de canal (hosts, caminho de `basic_user_info`, versão da Graph API) para que um palpite errado se corrija sem deploy. Os testes com dublê provam a nossa metade do contrato: assinatura, envelope, classificação de erro, corpo enviado e mapeamento de pedido.
- Não houve medição de latência do webhook, teste de carga nem exploração de segurança.
- A renovação de token do ML nunca rodou de verdade, porque o provedor não emite refresh token para esta aplicação. O caminho está coberto por teste com dublê, incluindo a corrida do compare-and-swap.
