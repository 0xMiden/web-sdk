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
   * @param {{ code: string, namespace?: string, slots: StorageSlot[], supportAllTypes?: boolean }} opts
   * @returns {Promise<AccountComponent>}
   */
  async component({ code, namespace, slots = [], supportAllTypes = true }) {
    this.#client?.assertNotTerminated();
    const wasm = await this.#getWasm();
    const builder = await this.#inner.createCodeBuilder();
    const compiled = namespace
      ? builder.compileAccountComponentCodeWithPath(namespace, code)
      : builder.compileAccountComponentCode(code);
    const component = wasm.AccountComponent.compile(compiled, slots);
    return supportAllTypes ? component.withSupportsAllTypes() : component;
  }

  /**
   * Compiles a transaction script, optionally linking named libraries inline or linking the exact
   * code installed by an AccountComponent.
   *
   * @param {{ code: string, libraries?: Array<Library | { namespace: string, code: string, linking?: "dynamic" | "static" } | { component: AccountComponent, linking?: "dynamic" | "static" }> }} opts
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
   * Compiles a note script, optionally linking named libraries inline or linking the exact code
   * installed by an AccountComponent.
   *
   * @param {{ code: string, libraries?: Array<Library | { namespace: string, code: string, linking?: "dynamic" | "static" } | { component: AccountComponent, linking?: "dynamic" | "static" }> }} opts
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

// Builds and links each library entry against `builder`. Account component entries use the exact
// compiled code installed by the component. Inline `{ namespace, code, linking? }` entries are
// built via `buildLibrary`. Linking defaults to dynamic, matching tutorial behavior. Pre-built
// library objects are also linked dynamically.
function linkLibraries(builder, libraries) {
  for (const lib of libraries) {
    if (lib && lib.component) {
      const componentCode = lib.component.componentCode();
      if (lib.linking === "static") {
        builder.linkStaticAccountComponentCode(componentCode);
      } else {
        builder.linkDynamicAccountComponentCode(componentCode);
      }
    } else if (lib && typeof lib.namespace === "string") {
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
