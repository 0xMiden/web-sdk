import { describe, it, expectTypeOf } from "vitest";
import type { InputNoteDetails } from "../types";

describe("InputNoteDetails", () => {
  it("carries an optional standardPayment flag", () => {
    expectTypeOf<InputNoteDetails>().toHaveProperty("standardPayment");
  });
});
