const shared = {
  outDir: 'lib',
  format: 'esm' as const,
  fixedExtension: false,
  deps: { alwaysBundle: ['dsh-supervision-protocol'] },
}

/** The bin ships as one self-contained module; tests bundle beside it. */
export default [
  { ...shared, entry: ['src/main.ts'], dts: false, clean: true, inlineDynamicImports: true },
  { ...shared, entry: ['src/*.test.ts'], dts: false },
]
