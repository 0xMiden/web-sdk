// @ts-nocheck
// End-to-end check that `debugMode: true` surfaces MASM debug output on the browser console.
//
// Uses the base Playwright `test` (not playwright.global.setup) so it does NOT require a running
// node: it loads the SDK from the dist server and drives a *mock* client entirely in the browser.
// The mock is created with `useWorker: false` so the debug output (a `console.log` from the WASM
// `ConsoleWriter`) fires on the main thread, where Playwright's `page.on("console")` observes it.
import { test, expect } from "@playwright/test";

const COUNTER_CODE = `
  use miden::protocol::active_account
  use miden::core::word
  use miden::core::sys

  const COUNTER_SLOT = word("miden::tutorials::counter")

  pub proc get_count
      push.COUNTER_SLOT[0..2] exec.active_account::get_item
      exec.sys::truncate_stack
  end
`;
const COUNTER_SLOT_NAME = "miden::tutorials::counter";

// A standalone transaction script that prints the operand stack. On the 0.16 surface `debug.*` is
// no longer an instruction: printing goes through the `miden::core::debug` procedures, which emit
// `miden::core::debug::print_*` events. Those events reach a writer only when the client executes
// through the debug-routing executor, which `debugMode: true` selects.
const DEBUG_SCRIPT = `
  use miden::core::debug
  use miden::core::sys

  @transaction_script
  pub proc main
    push.1.2.3
    exec.debug::print_stack
    exec.sys::truncate_stack
  end
`;

test("debug print_stack output reaches the browser console when debugMode is enabled", async ({
  page,
}) => {
  const consoleLogs: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "log") consoleLogs.push(msg.text());
  });
  page.on("pageerror", (err) => console.error("PAGE ERROR:", err));

  await page.goto("http://localhost:8080");

  const result = await page.evaluate(
    async ({ code, slotName, script }) => {
      const sdk = await import("./index.js");
      for (const [key, value] of Object.entries(sdk)) {
        (window as any)[key] = value;
      }

      // Mock client in debug mode, on the main thread so console output is observable here.
      const client = await (window as any).MidenClient.createMock({
        debugMode: true,
        useWorker: false,
      });

      const component = await client.compile.component({
        code,
        slots: [(window as any).StorageSlot.emptyValue(slotName)],
      });

      const seed = new Uint8Array(32);
      seed.fill(0x60);
      const auth = (window as any).AuthSecretKey.rpoFalconWithRNG(seed);
      const account = await client.accounts.create({
        type: "ImmutableContract",
        storage: "public",
        seed,
        auth,
        components: [component],
      });

      const dbgScript = await client.compile.txScript({ code: script });
      await client.transactions.executeProgram({
        account: account.id(),
        script: dbgScript,
      });

      return { ok: true };
    },
    { code: COUNTER_CODE, slotName: COUNTER_SLOT_NAME, script: DEBUG_SCRIPT }
  );

  expect(result.ok).toBe(true);
  // `print_stack` prints a "Stack state ..." block; assert it reached the page console.
  const joined = consoleLogs.join("\n");
  expect(joined).toMatch(/stack state/i);
});
