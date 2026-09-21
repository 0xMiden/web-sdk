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
  isNetworkAccount: boolean;
  allowlist?: string[];
  allowlistedNoteRoot: string;
  senderIsNetworkAccount: boolean;
  senderAllowlist?: string[];
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
        @account_procedure
        pub proc get_count
            push.COUNTER_SLOT[0..2] exec.active_account::get_item
            exec.sys::truncate_stack
        end

        # => []
        @account_procedure
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
    // The module path is part of procedure identity, so the component is compiled
    // under the same path the note script imports: the call then resolves to the
    // procedure root actually installed on the account.
    const accountComponentCode = builder.compileAccountComponentCodeWithPath(
      "external_contract::counter_contract",
      accountCode
    );
    const counterComponent = window.AccountComponent.compile(
      accountComponentCode,
      [window.StorageSlot.emptyValue(COUNTER_SLOT_NAME)]
    ).withSupportsAllTypes();

    // Link the exact code installed on the account, then compile the note script
    // once and reuse it for both the allowlist root and the note.
    builder.linkDynamicAccountComponentCode(counterComponent.componentCode());
    const noteScript = await builder.compileNoteScript(noteScriptCode);

    // The deploy needs an effect: since 0.17 the network-account auth component
    // asserts the transaction consumed a note, created one, or changed account
    // state BEFORE it pays the fee, so an empty transaction aborts with
    // `network account transactions must have an effect before fee payment`.
    // Bumping its own counter is the effect used here, and the script is
    // allowlisted below so the auth component admits it. (Consuming a note would
    // also work - `createNetworkAuthComponents` installs BasicWallet itself and
    // 0.17 allowlists the P2ID root by default - but that costs a mint and a
    // second transaction, and this route also exercises the tx-script
    // allowlist.)
    const deployScript = builder.compileTxScript(`
        use external_contract::counter_contract
        @transaction_script
        pub proc main
            call.counter_contract::increment_count
        end
      `);

    // A network account is a Public account carrying the network-account auth
    // component. Its note-script allowlist is the standardized storage slot the
    // node inspects to identify the account as a network account and route
    // matching notes to it.
    //
    // Each allowed note script carries the fee the account charges to consume it,
    // denominated in the asset of a fee faucet. This test node charges no
    // verification fee, so the note is priced at zero.
    const feeFaucet = await client.newFaucet(
      window.AccountStorageMode.tryFromStr("public"),
      false,
      "FEE",
      "FEE",
      8,
      BigInt(10000000),
      2
    );
    const networkAuth = window.AccountComponent.createNetworkAuthComponents(
      [new window.NoteScriptFee(noteScript.root(), BigInt(0))],
      feeFaucet.id(),
      // Any transaction script but the canonical expiration one is refused
      // unless it is named here.
      [deployScript.root()]
    );

    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    const accountBuilder = new window.AccountBuilder(seed)
      .storageMode(window.AccountStorageMode.public())
      .withComponent(counterComponent);
    // `createNetworkAuthComponents` returns the auth component plus the components backing
    // its fee policy; all of them belong on the account.
    for (const component of networkAuth) {
      accountBuilder.withComponent(component);
    }
    const built = accountBuilder.build();
    await client.newAccount(built.account, false);

    // Readback: the built account identifies as a network account and reports
    // exactly the allowlisted note-script root.
    const isNetworkAccount = built.account.isNetworkAccount();
    const allowlist = built.account
      .networkNoteAllowlist()
      ?.map((root) => root.toHex());
    const allowlistedNoteRoot = noteScript.root().toHex();

    // Deploy with the allowlisted counter bump, which both commits the account
    // on-chain and gives the transaction the effect 0.17 requires. The counter
    // therefore reads 1 after deployment, not 0.
    const deployTx = await window.helpers.executeAndApplyTransaction(
      built.account.id(),
      new window.TransactionRequestBuilder()
        .withCustomScript(deployScript)
        .build()
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

    // A plain wallet is not a network account (no allowlist slot).
    const senderIsNetworkAccount = sender.isNetworkAccount();
    const senderAllowlist = sender.networkNoteAllowlist();

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

    // Since 0.17 the kernel prices a NetworkAccountTarget note through a
    // procedure call on the target account, so the emitting transaction declares
    // it as a foreign account. This request is built by hand rather than through
    // `transactions.createNetworkNote`, which declares it for you.
    //
    // Pricing the note calls `estimate_note_fee` on the target, which applies
    // the standards' default expiration delta: this transaction must be
    // included within 20 blocks of its reference block, and an expiration can
    // only be lowered, so nothing here can widen it. A local WASM prove on a
    // CI runner can exceed that, and the node then rejects the submission as
    // expired. Re-execute against a fresh reference block, which is what a
    // consumer has to do; it is not a blanket retry, and any other failure
    // still fails the test on the first attempt.
    // Fresh arrays per attempt: both builder methods take their array BY VALUE,
    // so wasm-bindgen moves the handle and a second build would hit a consumed
    // one. `push` borrows and clones, so the note and the foreign account can
    // be reused. Without this the retry below could never retry - it would
    // throw `null pointer passed to rust` instead.
    const emitRequest = () => {
      const notes = new window.NoteArray();
      notes.push(note);
      const accounts = new window.ForeignAccountArray();
      accounts.push(
        window.ForeignAccount.public(
          built.account.id(),
          new window.AccountStorageRequirements()
        )
      );
      return new window.TransactionRequestBuilder()
        .withOwnOutputNotes(notes)
        .withForeignAccounts(accounts)
        .build();
    };

    let emitTx;
    for (let attempt = 0; ; attempt++) {
      try {
        emitTx = await window.helpers.executeAndApplyTransaction(
          sender.id(),
          emitRequest(),
          // Prove this one remotely. A local WASM prove on a CI runner takes
          // longer than the 20-block window the pricing call imposes, so it
          // expires however many times it is retried; the node runs a prover
          // beside its RPC. Done per call rather than by configuring the run,
          // because TEST_MIDEN_PROVER_URL also flips Playwright's
          // `fullyParallel` for every project.
          window.TransactionProver.newRemoteProver(
            window.localTxProverUrl,
            BigInt(120_000)
          )
        );
        break;
      } catch (err) {
        const message = String(err?.message ?? err);
        if (attempt >= 2 || !message.includes("transaction expired")) throw err;
        await client.syncState();
      }
    }
    await window.helpers.waitForTransaction(
      emitTx.executedTransaction().id().toHex()
    );

    // The node's network-transaction builder consumes the note in a subsequent
    // block and bumps the counter again. Poll until it does or the window elapses.
    let finalCounter = deployedCounter;
    for (let i = 0; i < 15; i++) {
      await window.helpers.waitForBlocks(1);
      await client.syncState();
      finalCounter = await readCounter();
      if (finalCounter === "2") break;
    }

    // The deployed network account's code carries the counter component.
    const finalAccount = await client.getAccount(built.account.id());
    const code = finalAccount?.code();
    const hasCounterComponent = code
      ? counterComponent
          .getProcedures()
          .every((procedure) => code.hasProcedure(procedure.digest))
      : false;

    return {
      deployedCounter,
      finalCounter,
      hasCounterComponent,
      isNetworkAccount,
      allowlist,
      allowlistedNoteRoot,
      senderIsNetworkAccount,
      senderAllowlist,
    };
  });
};

test.describe("network transaction tests", () => {
  test.describe.configure({ timeout: 720000 });

  test("network account consumes a network note and bumps its counter", async ({
    page,
  }) => {
    test.slow();
    const {
      deployedCounter,
      finalCounter,
      hasCounterComponent,
      isNetworkAccount,
      allowlist,
      allowlistedNoteRoot,
      senderIsNetworkAccount,
      senderAllowlist,
    } = await networkCounterTransaction(page);
    // Readback: the built account identifies as a network account and its
    // allowlist holds the note-script root it was created with, plus the three
    // roots the protocol allowlists itself - the network-account config note,
    // the fee-sponsorship note, and, since 0.17, P2ID. The allowlist is a set
    // ordered by root value rather than insertion, so assert membership and size
    // instead of contents. The size is load-bearing: a longer allowlist means
    // the account would auto-consume note scripts it was never meant to, which
    // is exactly what the P2ID default does - upstream marks it a stopgap until
    // a dedicated DEPLOY note script lands.
    expect(isNetworkAccount).toBe(true);
    expect(allowlist).toContain(allowlistedNoteRoot);
    expect(allowlist).toHaveLength(4);
    // A plain wallet is not a network account.
    expect(senderIsNetworkAccount).toBe(false);
    expect(senderAllowlist).toBeUndefined();
    // The deploy ran the allowlisted counter bump, so it reads 1.
    expect(deployedCounter).toEqual("1");
    // The node's network transaction consumed the note and bumped it again.
    expect(finalCounter).toEqual("2");
    // The network account's on-chain code carries the counter component.
    expect(hasCounterComponent).toBe(true);
  });
});
