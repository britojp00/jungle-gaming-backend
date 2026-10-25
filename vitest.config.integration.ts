import { defineConfig } from 'vitest/config';

/**
 * Configuração DEDICADA da suíte de integração (`bun run test:integration`).
 *
 * Deliberadamente separada de `vitest.config.ts` (unitários) e de
 * `vitest.config.e2e.ts` (scaffold do Nest): o escopo aqui é apenas
 * `test/integration/`, para que rodar integração não dependa do banco de
 * desenvolvimento nem dispare testes de outro ambiente.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/integration/**/*.e2e-spec.ts'],

    // Arquivos de integração compartilham o mesmo banco: rodar em paralelo
    // faria os suites truncarem as tabelas um do outro. Em série, a execução
    // é previsível e repetível.
    fileParallelism: false,

    server: {
      deps: {
        // O MikroORM descobre entidades e migrations com `import()` dinâmico
        // em tempo de execução. Sem isto, o Node 24 carrega esses `.ts` com o
        // strip-only mode, que não suporta `enum`, e a suíte falha com
        // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Inlinando, o Vite transforma.
        inline: [/@mikro-orm\//],
      },
    },
  },
});
