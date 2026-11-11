const shared = {
  outDir: 'lib',
  format: 'esm' as const,
  fixedExtension: false,
  deps: { alwaysBundle: ['dsh-supervision-protocol'] },
}

/**
 * The plugin ships as one self-contained module; tests bundle beside it. The
 * client half (`src/client/index.ts`) is bundled separately by
 * `scripts/build-client.mjs` — it is a browser artifact, not this ESM module.
 */
export default [
  { ...shared, entry: ['src/index.ts'], dts: true, clean: true, inlineDynamicImports: true },
  { ...shared, entry: ['src/*.test.ts'], dts: false },
  { ...shared, entry: ['src/client/banner.test.ts'], outDir: 'lib/client', dts: false },
]
