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
   * via `libraries` before compilation, as source modules with `linkModule` -
   * the same sequence a caller would run on a raw `createCodeBuilder()`, so a
   * component already deployed that way keeps its code commitment. Two entries
   * sharing a `namespace` cause a link error.
   *
   * @param {{ code: string, namespace?: string, slots?: StorageSlot[], supportAllTypes?: boolean, libraries?: Array<{ namespace: string, code: string }> }} opts
   * @returns {Promise<AccountComponent>}
   */
  async component({
    code,
    namespace,
    slots = [],
    supportAllTypes = true,
    libraries = [],
  }) {
    this.#client?.assertNotTerminated();
    const wasm = await this.#getWasm();
    const builder = await this.#inner.createCodeBuilder();
    libraries.forEach((lib, i) => {
      assertLibrarySource(lib, i, "compile.component");
      builder.linkModule(lib.namespace, lib.code);
    });
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
    // Ensure WASM is initialized (result unused - only #inner needs it)
    await this.#getWasm();
    const builder = await this.#inner.createCodeBuilder();
    linkLibraries(builder, libraries, "compile.txScript");
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
    linkLibraries(builder, libraries, "compile.noteScript");
    return builder.compileNoteScript(code);
  }
}

// A `{ namespace, code }` source entry, whichever surface takes it. Checked here
// so a malformed entry names its index instead of failing inside the binding.
function assertLibrarySource(lib, i, caller) {
  if (typeof lib?.namespace !== "string" || typeof lib?.code !== "string") {
    throw new TypeError(
      `${caller}: libraries[${i}] must be { namespace: string, code: string }`
    );
  }
}

// Builds and links each library entry against `builder`. Account component entries use the exact
// compiled code installed by the component. Inline `{ namespace, code, linking? }` entries are
// built via `buildLibrary`. Linking defaults to dynamic, matching tutorial behavior. Pre-built
// library objects are also linked dynamically.
function linkLibraries(builder, libraries, caller) {
  for (const [i, lib] of libraries.entries()) {
    // An entry carrying `namespace` or `code` is meant to be a source entry, so
    // it is validated here rather than inside the binding, which cannot say
    // which entry was bad. Anything else (a pre-built `Library`, from this realm
    // or another) still falls through to the dynamic link below.
    if (
      lib == null ||
      typeof lib !== "object" ||
      (!lib.component && ("namespace" in lib || "code" in lib))
    ) {
      assertLibrarySource(lib, i, caller);
    }
    if (lib && lib.component) {
      const componentCode = lib.component.componentCode();
      if (lib.linking === "static") {
        builder.linkStaticAccountComponentCode(componentCode);
      } else {
        builder.linkDynamicAccountComponentCode(componentCode);
      }
    } else if (typeof lib.namespace === "string") {
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
