-- OLX como provedor. Só acrescenta valor ao enum: nenhuma coluna muda, e
-- nenhum registro existente é afetado.
--
-- O valor novo não pode ser USADO na mesma transação que o cria, então esta
-- migração não insere nada -- o que é o caso, porque canal e conexão da OLX
-- nascem pelo cadastro e pela autorização, nunca por migração.
ALTER TYPE "MarketplaceProvider" ADD VALUE 'OLX';
