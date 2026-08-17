import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, "../dist/mt");

const contentTypes = new Map([
  [".js", "text/javascript; charset=utf-8"],
  [".map", "application/json"],
  [".wasm", "application/wasm"],
]);

const server = createServer(async (request, response) => {
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");

  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        "<!doctype html><meta charset=utf-8><title>MT release smoke</title>"
      );
      return;
    }

    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const filePath = path.resolve(distDir, relativePath);
    if (!filePath.startsWith(`${distDir}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      response.writeHead(404).end();
      return;
    }

    response.setHeader(
      "Content-Type",
      contentTypes.get(path.extname(filePath)) ?? "application/octet-stream"
    );
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Failed to resolve MT smoke-test server address");
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);

  const result = await page.evaluate(async () => {
    const sdk = await import("/eager.js");
    await sdk.initThreadPool(2);
    return {
      crossOriginIsolated: globalThis.crossOriginIsolated,
      threadCount: sdk.rayonThreadCount(),
      syncProbe: sdk.mtProbeSync(),
      asyncProbe: await sdk.mtProbeAsync(),
    };
  });

  if (!result.crossOriginIsolated) {
    throw new Error("MT smoke-test page is not cross-origin isolated");
  }
  if (result.threadCount !== 2) {
    throw new Error(`Expected two Rayon threads, got ${result.threadCount}`);
  }
  for (const [name, probe] of [
    ["sync", result.syncProbe],
    ["async", result.asyncProbe],
  ]) {
    if (!probe.includes("inside={0, 1}")) {
      throw new Error(`${name} MT probe did not use both workers: ${probe}`);
    }
  }

  console.log(
    `MT release smoke passed: threads=${result.threadCount}, sync="${result.syncProbe}", async="${result.asyncProbe}"`
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
