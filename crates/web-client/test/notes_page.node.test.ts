// @ts-nocheck
import { test, expect } from "./test-setup";
import { createMidenClient } from "./test-helpers";

test("native Node rejects bounded browser paging but supports details commitment queries", async ({
  sdk,
}) => {
  const MidenClient = await createMidenClient(sdk);
  expect(MidenClient).not.toBeNull();
  const client = await MidenClient.createMock();
  try {
    await expect(client.notes.listPage()).rejects.toThrow(
      /browser-only.*native Node/i
    );
    expect(await client.notes.list({ detailsCommitments: [] })).toEqual([]);
    expect(
      await client.notes.list({ detailsCommitments: [`0x${"00".repeat(32)}`] })
    ).toEqual([]);
  } finally {
    client.terminate();
  }
});
