// NETWORK TRANSACTION TEST
// =======================================================================================================
//
// End-to-end gate for network transactions against a real node with a running
// network-transaction builder (NTB). Deploys a counter contract as a *network
// account* (a Public account carrying the network-account auth component), emits
// a Public note carrying a `NetworkAccountTarget` attachment, and verifies the
// node auto-consumes the note and bumps the account's counter — no manual
// `consume` on the recipient side. Mirrors miden-client's `test_counter_contract_ntx`.
//
// Requires the real node harness (see playwright.global.setup): the mock chain
// has no NTB, so this cannot run against it. In CI the node + NTB is started by
// miden-client's scripts/start-test-node.sh.
import test from "./playwright.global.setup";
import { expect, Page } from "@playwright/test";

const networkCounterTransaction = async (
  testingPage: Page
): Promise<{
  deployedCounter?: string;
  finalCounter?: string;
  hasCounterComponent: boolean;
}> => {
  return await testingPage.evaluate(async () => {
    const COUNTER_SLOT_NAME = "miden::testing::counter_contract::counter";
    const client = window.client;
    await client.syncState();

    const accountCode = `
        use miden::protocol::active_account
        use miden::protocol::native_account
        use miden::core::word
        use miden::core::sys

        const COUNTER_SLOT = word("${COUNTER_SLOT_NAME}")

        # => []
        pub proc get_count
            push.COUNTER_SLOT[0..2] exec.active_account::get_item
            exec.sys::truncate_stack
        end

        # => []
        pub proc increment_count
            push.COUNTER_SLOT[0..2] exec.active_account::get_item
            # => [count]
            push.1 add
            # => [count+1]
            push.COUNTER_SLOT[0..2] exec.native_account::set_item
            # => []
            exec.sys::truncate_stack
            # => []
        end
      `;

    // Note script that bumps the counter. Its root is allowlisted on the network
    // account and the same compiled script builds the network note, so the roots
    // match exactly (the node only consumes notes whose script root is allowed).
    const noteScriptCode = `
        use external_contract::counter_contract
        @note_script
        pub proc main
            call.counter_contract::increment_count
        end
      `;

    const builder = await client.createCodeBuilder();
    const accountComponentCode =
      builder.compileAccountComponentCode(accountCode);
    const counterComponent = window.AccountComponent.compile(
      accountComponentCode,
      [window.StorageSlot.emptyValue(COUNTER_SLOT_NAME)]
    ).withSupportsAllTypes();

    // Link the counter contract so the note script can call into it, then compile
    // the note script once and reuse it for both the allowlist root and the note.
    const counterLib = builder.buildLibrary(
      "external_contract::counter_contract",
      accountCode
    );
    builder.linkDynamicLibrary(counterLib);
    const noteScript = await builder.compileNoteScript(noteScriptCode);

    // A network account is a Public account carrying the network-account auth
    // component. Its note-script allowlist is the standardized storage slot the
    // node inspects to identify the account as a network account and route
    // matching notes to it.
    const networkAuth = window.AccountComponent.createNetworkAuth([
      noteScript.root(),
    ]);

    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    const built = new window.AccountBuilder(seed)
      .storageMode(window.AccountStorageMode.public())
      .withComponent(counterComponent)
      .withAuthComponent(networkAuth)
      .build();
    await client.newAccount(built.account, false);

    // Scriptless deploy: the network-account auth component forbids tx scripts
    // and bumps the nonce on its own, so an empty transaction is enough to commit
    // the account on-chain. The counter is 0 after deployment.
    const deployTx = await window.helpers.executeAndApplyTransaction(
      built.account.id(),
      new window.TransactionRequestBuilder().build()
    );
    await window.helpers.waitForTransaction(
      deployTx.executedTransaction().id().toHex()
    );
    await client.syncState();

    const readCounter = async () => {
      const account = await client.getAccount(built.account.id());
      const counter = account?.storage().getItem(COUNTER_SLOT_NAME)?.toHex();
      return counter?.replace(/^0x/, "").replace(/^0+|0+$/g, "");
    };
    const deployedCounter = await readCounter();

    // An ordinary public wallet emits the network note.
    const sender = await client.newWallet(
      window.AccountStorageMode.public(),
      window.AuthScheme.AuthRpoFalcon512
    );
    await client.syncState();

    const target = new window.NetworkAccountTarget(built.account.id());
    const recipient = window.NoteRecipient.fromScript(
      noteScript,
      new window.NoteStorage(new window.FeltArray([]))
    );
    const note = window.Note.withAttachments(
      new window.NoteAssets([]),
      new window.NoteMetadata(
        sender.id(),
        window.NoteType.Public,
        window.NoteTag.withAccountTarget(built.account.id())
      ),
      recipient,
      [target.toAttachment()]
    );

    const ownOutputs = new window.NoteArray();
    ownOutputs.push(note);
    const emitTx = await window.helpers.executeAndApplyTransaction(
      sender.id(),
      new window.TransactionRequestBuilder()
        .withOwnOutputNotes(ownOutputs)
        .build()
    );
    await window.helpers.waitForTransaction(
      emitTx.executedTransaction().id().toHex()
    );

    // The node's network-transaction builder consumes the note in a subsequent
    // block and bumps the counter to 1. Poll until it does or the window elapses.
    let finalCounter = deployedCounter;
    for (let i = 0; i < 15; i++) {
      await window.helpers.waitForBlocks(1);
      await client.syncState();
      finalCounter = await readCounter();
      if (finalCounter === "1") break;
    }

    // The deployed network account's code carries the counter component.
    const finalAccount = await client.getAccount(built.account.id());
    const code = finalAccount?.code();
    const hasCounterComponent = code
      ? counterComponent
          .getProcedures()
          .every((procedure) => code.hasProcedure(procedure.digest))
      : false;

    return { deployedCounter, finalCounter, hasCounterComponent };
  });
};

test.describe("network transaction tests", () => {
  test.describe.configure({ timeout: 720000 });

  test("network account consumes a network note and bumps its counter", async ({
    page,
  }) => {
    test.slow();
    const { deployedCounter, finalCounter, hasCounterComponent } =
      await networkCounterTransaction(page);
    // The scriptless deploy leaves the counter at 0 (empty once normalized) —
    // unlike the pre-0.15 flow, a network account cannot run a deploy script.
    expect(deployedCounter).toBeFalsy();
    // The node's network transaction consumed the note and bumped it to 1.
    expect(finalCounter).toEqual("1");
    // The network account's on-chain code carries the counter component.
    expect(hasCounterComponent).toBe(true);
  });
});
