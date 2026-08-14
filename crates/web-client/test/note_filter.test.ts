// @ts-nocheck
import { test, expect } from "./test-setup";

test.describe("new note filter", () => {
  test("creates an All filter without note IDs", async ({ run }) => {
    const result = await run(async ({ sdk }) => {
      const filter = new sdk.NoteFilter(sdk.NoteFilterTypes.All);
      return { threw: false, hasFilter: !!filter };
    });
    expect(result.threw).toBe(false);
    expect(result.hasFilter).toBe(true);
  });

  test("throws instead of panicking when a List filter is created without note IDs", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      try {
        new sdk.NoteFilter(sdk.NoteFilterTypes.List, null);
        return { threw: false };
      } catch (e) {
        return { threw: true, message: e.message };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.message).toContain("Note IDs required for List filter");
  });

  test("throws instead of panicking when a Unique filter is created without a note ID", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      try {
        new sdk.NoteFilter(sdk.NoteFilterTypes.Unique, null);
        return { threw: false };
      } catch (e) {
        return { threw: true, message: e.message };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.message).toContain("Note ID required for Unique filter");
  });

  test("throws instead of panicking when a Unique filter is created with an empty note ID list", async ({
    run,
  }) => {
    const result = await run(async ({ sdk }) => {
      try {
        new sdk.NoteFilter(sdk.NoteFilterTypes.Unique, []);
        return { threw: false };
      } catch (e) {
        return { threw: true, message: e.message };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.message).toContain(
      "Exactly one Note ID must be provided for Unique filter"
    );
  });
});
