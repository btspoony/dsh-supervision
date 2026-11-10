const shared = {
  outDir: 'lib',
  format: 'esm' as const,
  fixedExtension: false,
  deps: { alwaysBundle: ['dsh-supervision-protocol'] },
}

/** The plugin ships as one self-contained module; tests bundle beside it. */
export default [
  { ...shared, entry: ['src/index.ts'], dts: true, clean: true, inlineDynamicImports: true },
  { ...shared, entry: ['src/*.test.ts'], dts: false },
]
