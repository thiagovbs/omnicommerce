/* eslint-disable @typescript-eslint/no-require-imports */
// CommonJS de propósito: este arquivo REGISTRA o ts-node, e por isso não pode
// depender dele nem ser ESM -- `import` seria resolvido antes do registro.
/**
 * Roda um script TypeScript do projeto, no Windows e no Linux igual.
 *
 * Existe por dois motivos concretos:
 *
 * 1. O `tsconfig` do projeto é o do Next (módulos ESM, resolução de bundler), e
 *    o ts-node precisa de CommonJS para rodar fora dele. Isso era feito com uma
 *    variável de ambiente no script de teste em PowerShell -- que não funciona
 *    no build da Vercel, que é `sh`.
 * 2. `--conditions=react-server` é o que faz `import "server-only"` resolver
 *    fora do React. Sem isso, qualquer módulo de serviço quebra na importação.
 *    A condição vem na linha de comando do node, não daqui.
 *
 * Uso: node --conditions=react-server scripts/run-ts.js scripts/algum.ts
 */

const path = require("node:path");

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "CommonJS",
  moduleResolution: "node",
});
require("ts-node/register");

const alvo = process.argv[2];
if (!alvo) {
  console.error("Uso: node --conditions=react-server scripts/run-ts.js <script.ts>");
  process.exit(1);
}

const modulo = require(path.resolve(process.cwd(), alvo));

// O script expõe `main` em vez de rodar na importação: assim o mesmo arquivo
// pode ser importado por um teste sem falar com o banco.
if (typeof modulo.main === "function") {
  Promise.resolve(modulo.main()).catch((erro) => {
    console.error(erro);
    process.exit(1);
  });
}
