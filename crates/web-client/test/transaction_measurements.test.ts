// @ts-nocheck
import { test, expect } from "./test-setup";

// TRANSACTION MEASUREMENTS
// =======================================================================================================
//
// `ExecutedTransaction.measurements()` reports the VM cycle count of each execution phase. See issue #90.

test.describe("ExecutedTransaction.measurements", () => {
  test("reports per-phase cycle counts for a note-consuming transaction", async ({
    run,
  }) => {
    const result = await run(async ({ client, sdk, helpers }) => {
      const { wallet, faucet } = await helpers.setupWalletAndFaucet();
      const { createdNoteId } = await helpers.mockMint(
        wallet.id(),
        faucet.id()
      );
      const inputNote = await client.getInputNote(createdNoteId);
      const request = await client.newConsumeTransactionRequest(
        [inputNote.toNote()],
        wallet.id()
      );
      const executed = (
        await client.executeTransaction(wallet.id(), request)
      ).executedTransaction();

      const m = executed.measurements();
      const notes = m.noteExecution;
      return {
        isModel: m instanceof sdk.TransactionMeasurements,
        prologue: m.prologue,
        notesProcessing: m.notesProcessing,
        txScriptProcessing: m.txScriptProcessing,
        epilogue: m.epilogue,
        authProcedure: m.authProcedure,
        totalCycles: m.totalCycles,
        noteIds: notes.map((n) => n.noteId.toString()),
        noteCycles: notes.map((n) => n.cycles),
        consumed: executed
          .inputNotes()
          .notes()
          .map((n) => n.id().toString()),
      };
    });

    expect(result.isModel).toBe(true);
    expect(result.totalCycles).toBeGreaterThan(0);
    expect(result.prologue).toBeGreaterThan(0);
    expect(result.notesProcessing).toBeGreaterThan(0);
    expect(result.epilogue).toBeGreaterThan(0);
    expect(result.authProcedure).toBeGreaterThanOrEqual(0);
    expect(result.txScriptProcessing).toBeGreaterThanOrEqual(0);
    expect(result.noteIds).toEqual(result.consumed);
    expect(result.noteCycles.length).toBe(1);
    expect(result.noteCycles[0]).toBeGreaterThan(0);
    // `totalCycles` is the sum of the phases the VM measured.
    expect(result.totalCycles).toBe(
      result.prologue +
        result.notesProcessing +
        result.txScriptProcessing +
        result.epilogue
    );
  });
});
