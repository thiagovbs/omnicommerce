# Pedidos e histórico de status

Esta etapa evolui o modelo existente de pedidos (`Sale` e `SaleItem`), sem criar
uma segunda entidade `Order` nem alterar as telas. Inclui schema, migration e
testes de banco; ainda não implementa importação, webhooks ou gravação automática
de histórico pelas Server Actions existentes.

## Pedido

`Sale.status` continua sendo o estado normalizado: CREATED, PAID, INVOICED,
SHIPPED, DELIVERED, CANCELLED ou REFUNDED.

- `source`: MANUAL ou INTEGRATION. Indica como o pedido entrou no sistema,
  independentemente do canal; uma venda do Mercado Livre pode ser cadastrada
  manualmente.
- `externalStatus`: texto original do status no marketplace, opcional.
- `externalUpdatedAt`: data de atualização fornecida pelo marketplace, opcional;
  não deve receber a hora de chegada do webhook.
- `lastSyncedAt`: momento da última sincronização concluída, opcional.
- `statusVersion`: contador para controle de concorrência, iniciado em zero.
- `statusHistory`: relação com os registros do histórico.

A chave única `(marketplaceId, externalOrderId)` permanece intacta. O modelo
atual ainda representa um canal por organização, não várias contas autorizadas
no mesmo canal. A criação de conexões por loja e a evolução dessa chave ficam
para outra migration.

`SaleItem` recebe `externalItemId` e `externalVariationId`, ambos opcionais.
Não são únicos: um anúncio/variação pode aparecer em múltiplas linhas e pedidos.
Valores monetários continuam em Decimal(14,2).

## Histórico

`SaleStatusHistory` registra estado anterior e novo, origem da alteração,
versão, identificador de evento externo, status externo, ator opcional e motivo.

- `occurredAt`: quando a mudança ocorreu na origem; pode ser desconhecido.
- `recordedAt`: quando o sistema gravou a entrada.
- `changedById`: usuário responsável, opcional para integração ou inicialização.
- `source`: MANUAL, INTEGRATION ou INITIALIZATION.
- `(saleId, version)`: impede duas entradas com a mesma versão do pedido.
- `(saleId, externalEventId)`: impede registrar o mesmo evento externo duas vezes
  no mesmo pedido. Identificadores devem incluir o namespace do provedor.
  Eventos manuais usam null; PostgreSQL permite múltiplos null nessa chave.

A organização é obtida pela venda relacionada, sem outra coluna de organização
que possa divergir. O serviço deverá autorizar o acesso à venda e verificar se o
ator pertence à organização. Essa autorização não é imposta pela FK do usuário.

Excluir um usuário preserva o histórico e limpa a referência ao ator. Excluir a
venda exclui seu histórico. Não há alteração em `AuditLog` nesta etapa.

## Contrato do serviço a implementar

O schema oferece armazenamento e restrições; não executa sozinho transições,
idempotência completa, bloqueio de eventos antigos ou auditoria automática.

1. Resolver e validar a organização no servidor e validar o status de entrada.
2. Criar o pedido e sua entrada inicial de versão zero na mesma transação.
3. Para mudanças, ler a versão atual e atualizar com condição de organização,
   ID e versão esperada; incrementar a versão atomicamente. Se nenhuma linha for
   atualizada, reler/reprocessar o conflito em vez de sobrescrever.
4. Inserir a entrada de histórico com a nova versão na mesma transação.
5. Para integração, verificar identidade do evento e versão/data externa antes
   da escrita. A chave única é uma defesa adicional, não substitui essa lógica.
6. Definir regras explícitas de transição e registrar a auditoria apropriada.
   O histórico deve ser usado como append-only pelo serviço; não há trigger
   impedindo UPDATE/DELETE no banco.

Eventos diferentes podem atualizar o mesmo pedido. Não usar só o ID do pedido
como identificador de evento. Se o status normalizado não mudar, atualizar os
metadados de sincronização conforme a política do serviço, sem fabricar uma
transição. O registro de todos os eventos recebidos pertence à futura inbox.

Enquanto esse serviço não for conectado às actions, cadastros e alterações
manuais continuam usando o comportamento anterior e não alimentam o histórico
nem incrementam `statusVersion`. A versão zero do backfill é um retrato da
migration, não uma garantia de acompanhamento após ela.

## Migration e validação

`20260918190000_order_sync_and_status_history` é aditiva e transacional.
Mantém vendas/itens existentes e insere um snapshot INITIALIZATION, versão zero,
para cada venda. Estado anterior, ator e data de ocorrência ficam nulos, pois não
é possível reconstruir esses fatos a partir de `updatedAt`. `recordedAt` indica
o momento da migration. Nenhum histórico antigo é inventado.

Para aplicar no ambiente desejado, depois de conferir o destino de DATABASE_URL:

```sh
npx prisma migrate deploy
npx prisma generate
```

A migration não foi aplicada ao banco da aplicação durante esta implementação.
Ela foi testada em PostgreSQL 16 descartável, sem porta publicada, sem volumes
do projeto e sem usar DATABASE_URL:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-order-models.ps1
```

O teste aplica as migrations anteriores, cria pedidos legados, aplica a nova
migration e verifica preservação de dados, snapshots, duplicações, FKs,
histórico sem usuário e rollback. O container é removido ao final.

Validações executadas: Prisma format/validate, geração do cliente e teste da
migration em PostgreSQL. A checagem TypeScript global encontrou erros nos
arquivos não alterados `app/(protected)/dashboard/charts.tsx` (percent opcional)
e `next.config.ts` (opção eslint removida). Não houve novos erros reportados
relacionados aos modelos.
