export class CompilerResource {
  #inner;
  #getWasm;
  #client;

  constructor(inner, getWasm, client = null) {
    this.#inner = inner;
    this.#getWasm = getWasm;
    this.#client = client;
  }

  /**
   * Compiles MASM code + slots into an AccountComponent ready for accounts.create().
   *
   * Dependency modules the component imports (e.g. auth libraries) are linked
   * via `libraries` before compilation. Each entry is statically linked as a
   * source module with `linkModule`, so the compiled component — and therefore
   * the account's code commitment — is identical to building it directly off a
   * `createCodeBuilder()`. This matters: changing the link path would change the
   * MAST and break accounts already created with the original component.
   *
   * @param {{ code: string, slots?: StorageSlot[], supportAllTypes?: boolean, libraries?: Array<{ namespace: string, code: string }> }} opts
   * @returns {Promise<AccountComponent>}
   */
  async component({
    code,
    slots = [],
    supportAllTypes = true,
    libraries = [],
  }) {
    this.#client?.assertNotTerminated();
    const wasm = await this.#getWasm();
    const builder = await this.#inner.createCodeBuilder();
    for (const lib of libraries) {
      builder.linkModule(lib.namespace, lib.code);
    }
    const compiled = builder.compileAccountComponentCode(code);
    const component = wasm.AccountComponent.compile(compiled, slots);
    return supportAllTypes ? component.withSupportsAllTypes() : component;
  }

  /**
   * Compiles a transaction script, optionally linking named libraries inline.
   *
   * @param {{ code: string, libraries?: Array<{ namespace: string, code: string, linking?: "dynamic" | "static" }> }} opts
   * @returns {Promise<TransactionScript>}
   */
  async txScript({ code, libraries = [] }) {
    this.#client?.assertNotTerminated();
    // Ensure WASM is initialized (result unused — only #inner needs it)
    await this.#getWasm();
    const builder = await this.#inner.createCodeBuilder();
    linkLibraries(builder, libraries);
    return builder.compileTxScript(code);
  }

  /**
   * Compiles a note script, optionally linking named libraries inline.
   *
   * @param {{ code: string, libraries?: Array<{ namespace: string, code: string, linking?: "dynamic" | "static" }> }} opts
   * @returns {Promise<NoteScript>}
   */
  async noteScript({ code, libraries = [] }) {
    this.#client?.assertNotTerminated();
    await this.#getWasm();
    const builder = await this.#inner.createCodeBuilder();
    linkLibraries(builder, libraries);
    return builder.compileNoteScript(code);
  }
}

// Builds and links each library entry against `builder`. Inline
// `{ namespace, code, linking? }` entries are built via `buildLibrary` and
// linked according to `linking` (defaulting to dynamic, matching tutorial
// behavior). Pre-built library objects are linked dynamically.
function linkLibraries(builder, libraries) {
  for (const lib of libraries) {
    if (lib && typeof lib.namespace === "string") {
      const built = builder.buildLibrary(lib.namespace, lib.code);
      if (lib.linking === "static") {
        builder.linkStaticLibrary(built);
      } else {
        builder.linkDynamicLibrary(built);
      }
    } else {
      builder.linkDynamicLibrary(lib);
    }
  }
}
