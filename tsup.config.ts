import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  sourcemap: true,
  target: 'node20',
  // Polyfill import.meta.url in the CJS build so rules/ resolution (src/rules.ts)
  // works from both the ESM CLI and CJS library consumers.
  shims: true,
});
