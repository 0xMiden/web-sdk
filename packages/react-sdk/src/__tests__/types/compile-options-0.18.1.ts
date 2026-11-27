// Type-level test, checked by `tsc --noEmit` in the React SDK typecheck job. The first block is
// code written against the 0.18.1 types, which must keep compiling on 0.18.x.
import type {
  CompileComponentOptions,
  CompileComponentPackageOptions,
  CompileNoteScriptOptions,
  CompileTxScriptOptions,
  CompilerResource,
  NoteScript,
  TransactionScript,
} from "@miden-sdk/miden-sdk";
import type { UseCompileResult } from "../../hooks/useCompile";

export interface TaggedComponent extends CompileComponentOptions {
  tag: string;
}
export interface TaggedTxScript extends CompileTxScriptOptions {
  tag: string;
}
export interface TaggedNoteScript extends CompileNoteScriptOptions {
  tag: string;
}

export const componentSource = (options: CompileComponentOptions): string =>
  options.code;
export const txScriptSource = (options: CompileTxScriptOptions): string =>
  options.code;
export const noteScriptSource = (options: CompileNoteScriptOptions): string =>
  options.code;
export const resourceSource = (
  options: Parameters<CompilerResource["txScript"]>[0]
): string => options.code;
export const hookSource = (
  options: Parameters<UseCompileResult["noteScript"]>[0]
): string => options.code;

// A hand-written double typed with the 0.18.1 signatures.
export const hookDouble = (
  txScript: (options: CompileTxScriptOptions) => Promise<TransactionScript>,
  noteScript: (options: CompileNoteScriptOptions) => Promise<NoteScript>
): Pick<UseCompileResult, "txScript" | "noteScript"> => ({
  txScript,
  noteScript,
});

// Package input, and source and package staying exclusive.
export function packageInput(
  resource: CompilerResource,
  hook: UseCompileResult,
  bytes: Uint8Array,
  tagged: TaggedTxScript,
  fromPackage: CompileComponentPackageOptions
) {
  void resource.txScript(tagged);
  void resource.txScript({ package: bytes });
  void resource.noteScript({ package: bytes });
  void resource.component(fromPackage);
  void hook.txScript({ package: bytes });
  void hook.component(fromPackage);
  // @ts-expect-error source and package input are exclusive
  void resource.txScript({ code: "begin end", package: bytes });
  // @ts-expect-error source and package input are exclusive
  void resource.noteScript({ code: "begin end", package: bytes });
  // @ts-expect-error source and package input are exclusive
  void hook.component({ code: "begin end", package: bytes });
  // @ts-expect-error one of source and package is required
  void resource.txScript({});
}
