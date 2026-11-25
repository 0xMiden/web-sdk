import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("reads browser sync height without keeping the client borrowed", () => {
  const source = readFileSync(
    new URL("../../src/sync.rs", import.meta.url),
    "utf8"
  );
  const method = source.slice(source.indexOf("pub async fn get_sync_height"));
  const browserRead =
    method.match(
      /#\[cfg\(feature = "browser"\)\]([\s\S]*?)#\[cfg\(feature = "nodejs"\)\]/
    )?.[1] ?? method;

  expect(browserRead).not.toMatch(/\b(?:inner|get_mut_inner)\b/);
  expect(browserRead).toMatch(/store\.get_sync_height\(\)\.await/);
});
