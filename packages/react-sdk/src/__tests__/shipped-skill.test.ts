import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The skill and AGENTS.md ship in the npm tarball, so they must carry the same
// note-safety guidance as the hook JSDoc and README.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const skill = read("../../skills/react-sdk-patterns/SKILL.md");
const agents = read("../../AGENTS.md");

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n###", start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

describe("shipped react-sdk docs", () => {
  it("skill tells useNoteStream callers to check standardPayment", () => {
    const text = section(skill, "### useNoteStream(");
    expect(text).toContain("note.standardPayment");
    expect(text).toContain("P2ID or P2IDE");
    expect(text).toContain("note's script");
  });

  it("skill says useConsume runs each note's script", () => {
    const text = section(skill, "### useConsume(");
    expect(text).toContain("isStandardPayment(record)");
    expect(text).toContain("each note's script");
  });

  it("AGENTS.md Claim Notes example says consuming runs each note's script", () => {
    const text = section(agents, "### Claim Notes");
    expect(text).toContain("isStandardPayment(record)");
    expect(text).toContain("each note's script");
  });

  it("AGENTS.md useConsume row names the payment check", () => {
    const row = agents
      .split("\n")
      .find((line) => line.includes("| `useConsume()`"));
    expect(row).toContain("isStandardPayment(record)");
    expect(row).toContain("each note script");
  });
});
