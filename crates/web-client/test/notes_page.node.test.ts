// @ts-nocheck
import { test, expect, loadNodeSdk } from "./test-setup";
import {
  createWasmWebClient,
  createMockWasmWebClient,
} from "../js/node/client-factory.js";
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
    console.info(
      "notes_page.node: paging refusal and details lookup assertions passed"
    );
  } finally {
    client.terminate();
  }
});

test("native Node explicitly refuses acquisition callbacks during initialization", async () => {
  const rawSdk = loadNodeSdk();
  const options = {
    beforeNoteAcquisition: async () => {},
    noteAcquisitionLimits: {
      maxNotes: 1,
      maxNoteFileBytes: 65536,
      maxTotalNoteFileBytes: 65536,
    },
  };
  await expect(
    createMockWasmWebClient(rawSdk).createClient(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      options
    )
  ).rejects.toThrow(/unsupported.*native Node/i);
  await expect(
    createWasmWebClient(rawSdk).createClient(
      "http://localhost:57291",
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      options
    )
  ).rejects.toThrow(/unsupported.*native Node/i);
  console.info(
    "note acquisition native Node: both production-factory unsupported-option assertions passed"
  );
});
