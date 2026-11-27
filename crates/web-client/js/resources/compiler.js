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
   * Only procedures exported with `@account_procedure` or `@auth_script` become component
   * procedures. A component with none logs a `[miden-sdk]` warning and is still returned, since a
   * storage-only component is legitimate beside one that has procedures; nothing can call into
   * it, and accounts.create rejects a contract none of whose components exports a non-auth
   * procedure.
   *
   * Dependency modules the component imports (e.g. auth libraries) are linked
   * via `libraries` before compilation, as source modules with `linkModule` -
   * the same sequence a caller would run on a raw `createCodeBuilder()`, so a
   * component already deployed that way keeps its code commitment. Two entries
   * sharing a `namespace` cause a link error.
   *
   * Pass `package` (a `Package` or its serialized `.masp` bytes) instead of `code` to build the
   * component from an already compiled package. `fromPackage` gives it the fixed metadata name
   * `"custom"`; `namespace` and `libraries` do not apply, since the package carries its own code.
   *
   * @param {{ code?: string, package?: Package | Uint8Array, namespace?: string, slots?: StorageSlot[], supportAllTypes?: boolean, libraries?: Array<{ namespace: string, code: string }> }} opts
   * @returns {Promise<AccountComponent>}
   */
  async component({
    code,
    package: pkg,
    namespace,
    slots = [],
    supportAllTypes = true,
    libraries = [],
  }) {
    this.#client?.assertNotTerminated();
    assertOneSource("compile.component", code, pkg);
    const wasm = await this.#getWasm();
    let component;
    if (pkg !== undefined) {
      if (namespace !== undefined || libraries.length > 0) {
        throw new TypeError(
          "compile.component: `namespace` and `libraries` do not apply to a `package`"
        );
      }
      // The browser binding takes a typed array; Node unwraps this one too.
      const slotArray = wasm.StorageSlotArray
        ? new wasm.StorageSlotArray(slots)
        : slots;
      component = wasm.AccountComponent.fromPackage(
        toPackage(wasm, pkg),
        slotArray
      );
    } else {
      const builder = await this.#inner.createCodeBuilder();
      libraries.forEach((lib, i) => {
        assertLibrarySource(lib, i, "compile.component");
        builder.linkModule(lib.namespace, lib.code);
      });
      const compiled = namespace
        ? builder.compileAccountComponentCodeWithPath(namespace, code)
        : builder.compileAccountComponentCode(code);
      component = wasm.AccountComponent.compile(compiled, slots);
    }
    if (component.getProcedures().length === 0) {
      console.warn(
        "[miden-sdk] compile.component produced a component with no procedures. " +
          "Only exports marked `@account_procedure` or `@auth_script` become account " +
          "procedures, so nothing can call into this component, and accounts.create " +
          "rejects a contract none of whose components exports a non-auth procedure. " +
          "Ignore this warning only if the component is intentionally storage-only."
      );
    }
    return supportAllTypes ? component.withSupportsAllTypes() : component;
  }

  /**
   * Compiles a transaction script, optionally linking named libraries inline or linking the exact
   * code installed by an AccountComponent.
   *
   * Pass `package` (a `Package` or its serialized bytes) instead of `code` to build the script
   * from a compiled package; `libraries` do not apply to it.
   *
   * @param {{ code?: string, package?: Package | Uint8Array, libraries?: Array<Library | { namespace: string, code: string, linking?: "dynamic" | "static" } | { component: AccountComponent, linking?: "dynamic" | "static" }> }} opts
   * @returns {Promise<TransactionScript>}
   */
  async txScript({ code, package: pkg, libraries = [] }) {
    this.#client?.assertNotTerminated();
    assertOneSource("compile.txScript", code, pkg, libraries);
    const wasm = await this.#getWasm();
    if (pkg !== undefined) {
      return wasm.TransactionScript.fromPackage(toPackage(wasm, pkg));
    }
    const builder = await this.#inner.createCodeBuilder();
    linkLibraries(builder, libraries, "compile.txScript");
    return builder.compileTxScript(code);
  }

  /**
   * Compiles a note script, optionally linking named libraries inline or linking the exact code
   * installed by an AccountComponent.
   *
   * Pass `package` (a `Package` or its serialized bytes) instead of `code` to build the script
   * from a compiled package; `libraries` do not apply to it.
   *
   * @param {{ code?: string, package?: Package | Uint8Array, libraries?: Array<Library | { namespace: string, code: string, linking?: "dynamic" | "static" } | { component: AccountComponent, linking?: "dynamic" | "static" }> }} opts
   * @returns {Promise<NoteScript>}
   */
  async noteScript({ code, package: pkg, libraries = [] }) {
    this.#client?.assertNotTerminated();
    assertOneSource("compile.noteScript", code, pkg, libraries);
    const wasm = await this.#getWasm();
    if (pkg !== undefined) {
      return wasm.NoteScript.fromPackage(toPackage(wasm, pkg));
    }
    const builder = await this.#inner.createCodeBuilder();
    linkLibraries(builder, libraries, "compile.noteScript");
    return builder.compileNoteScript(code);
  }
}

// Exactly one of `code` and `package` names what to build from. `libraries` link source, so they
// have no meaning beside a package, which already carries its code.
function assertOneSource(caller, code, pkg, libraries = []) {
  if ((code === undefined) === (pkg === undefined)) {
    throw new TypeError(`${caller}: pass either \`code\` or \`package\``);
  }
  if (pkg !== undefined && libraries.length > 0) {
    throw new TypeError(
      `${caller}: \`libraries\` do not apply to a \`package\``
    );
  }
}

// Serialized `.masp` bytes become a Package; a Package passes through. The binding borrows it, so
// the caller's object stays usable for further calls.
function toPackage(wasm, pkg) {
  return pkg instanceof Uint8Array ? wasm.Package.deserialize(pkg) : pkg;
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
