// @ts-nocheck
import { mockTest } from "./playwright.global.setup";
import { expect } from "@playwright/test";

mockTest(
  "compiled standards resolve the canonical V2 faucet transfer callbacks",
  async ({ page }) => {
    const result = await page.evaluate(async () => {
      const client = await window.MidenClient.createMock();
      try {
        const component = await client.compile.component({
          namespace: "test::faucet_policy_v2",
          code: `
          pub use {invoke_receive_policy_v2} from miden::standards::faucets::policies::policy_manager
          pub use {invoke_send_policy_v2} from miden::standards::faucets::policies::policy_manager
        `,
        });
        try {
          return {
            receive: component.getProcedureHash("invoke_receive_policy_v2"),
            send: component.getProcedureHash("invoke_send_policy_v2"),
          };
        } finally {
          component.free();
        }
      } finally {
        client.terminate();
      }
    });
    expect(result.receive).toBe(
      "0xefc0d6dc729c05e93107be949d6cca2e20daf02e20b923934c1c0420a466ace2"
    );
    expect(result.send).toBe(
      "0xc2e107aed78761fe6b1b174992fdfbcc998dd41f57c7f72a1ef498adad65dbc6"
    );
  }
);
