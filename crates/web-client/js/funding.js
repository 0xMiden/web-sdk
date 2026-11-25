/**
 * Development faucet protocol (testnet / devnet) used by
 * `accounts.requestFundingNote` and `accounts.fundAccount`.
 *
 * Matches the faucet HTTP + SHA-256 proof-of-work shape from the closed
 * rust-sdk funding helper (0xMiden/rust-sdk#2595).
 */

export const DEFAULT_FAUCET_URLS = Object.freeze({
  testnet: "https://faucet-api.testnet.miden.io",
  devnet: "https://faucet-api.devnet.miden.io",
});

/** Browser `setTimeout` / `setInterval` upper bound (i32 max). */
const MAX_TIMER_MS = 2_147_483_647;

const CONSUMED_STATES = new Set([
  "ConsumedAuthenticatedLocal",
  "ConsumedUnauthenticatedLocal",
  "ConsumedExternal",
]);

const PROCESSING_STATES = new Set([
  "ProcessingAuthenticated",
  "ProcessingUnauthenticated",
]);

/**
 * @typedef {object} FundingOptions
 * @property {string} [faucetUrl] Faucet API base URL. Required outside testnet/devnet.
 * @property {bigint | number | string} [amount] Base units; omit for the faucet base amount.
 * @property {number} [timeout] Per-stage limit in ms (faucet, note wait, confirm). Default 60_000.
 * @property {number} [pollInterval] Delay between chain syncs in ms. Default 5_000.
 * @property {"testnet" | "devnet" | "mainnet" | string} [network] Override network inferred from the RPC endpoint.
 * @property {typeof fetch} [fetch] Injected fetch (tests).
 */

/**
 * @param {FundingOptions | undefined} options
 * @returns {{ faucetUrl: string | null, amount: bigint | null, timeoutMs: number, pollIntervalMs: number, network: string | null, fetch: typeof fetch }}
 */
export function normalizeFundingOptions(options = {}) {
  const timeoutMs = options.timeout ?? 60_000;
  const pollIntervalMs = options.pollInterval ?? 5_000;
  validateTimerMs(timeoutMs, "timeout");
  validateTimerMs(pollIntervalMs, "pollInterval");

  let amount = null;
  if (options.amount != null) {
    amount = toPositiveU64(options.amount, "amount");
  }

  const faucetUrl =
    options.faucetUrl == null || options.faucetUrl === ""
      ? null
      : String(options.faucetUrl);

  return {
    faucetUrl,
    amount,
    timeoutMs,
    pollIntervalMs,
    network: options.network ?? null,
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
  };
}

/**
 * Infer testnet / devnet / mainnet from an RPC endpoint URL.
 * @param {string | null | undefined} endpoint
 * @returns {"testnet" | "devnet" | "mainnet" | null}
 */
export function networkFromEndpoint(endpoint) {
  if (endpoint == null || typeof endpoint !== "string") return null;
  const lower = endpoint.toLowerCase();
  if (lower.includes("testnet")) return "testnet";
  if (lower.includes("devnet")) return "devnet";
  if (lower.includes("mainnet")) return "mainnet";
  return null;
}

/**
 * @param {string | null} network
 * @returns {string}
 */
export function defaultFaucetUrl(network) {
  if (network === "testnet") return DEFAULT_FAUCET_URLS.testnet;
  if (network === "devnet") return DEFAULT_FAUCET_URLS.devnet;
  throw fundingInvalid(
    "this network requires a faucetUrl (only testnet and devnet have defaults)"
  );
}

/**
 * @param {string} bech32
 * @returns {"testnet" | "devnet" | "mainnet" | null}
 */
export function networkFromBech32(bech32) {
  const s = String(bech32);
  if (s.startsWith("mtst")) return "testnet";
  if (s.startsWith("mdev")) return "devnet";
  if (s.startsWith("mm")) return "mainnet";
  return null;
}

/**
 * Race `work` against a deadline. Same stage-timeout model as the Rust helper.
 * The signal passed to `work` aborts at the deadline so its loops and fetches
 * stop instead of running on after the caller has given up.
 * @template T
 * @param {number} timeoutMs
 * @param {string} stage
 * @param {(signal: AbortSignal) => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withinTimeout(timeoutMs, stage, work) {
  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(fundingTimeout(stage));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeoutPromise]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * @param {AbortSignal | undefined} signal
 */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw fundingAborted();
}

/**
 * Resolve after `ms`; reject with `FundingAborted` and clear the timer as soon
 * as `signal` aborts, so a long delay never outlives its stage.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(fundingAborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(fundingAborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Solve the faucet SHA-256 proof of work: find `nonce` such that
 * `SHA-256(challenge_bytes || nonce_be)[0..8] as u64 BE < target`.
 *
 * @param {string} challengeHex
 * @param {bigint | number | string} target
 * @param {AbortSignal} [signal] Stops the search when aborted.
 * @returns {Promise<bigint>}
 */
export async function solvePow(challengeHex, target, signal) {
  const challenge = String(challengeHex).replace(/^0x/i, "");
  // JSON.parse rounds a u64 target near u64::MAX up to 2 ** 64 or beyond.
  const targetValue =
    typeof target === "number" && target >= 2 ** 64
      ? 0xffff_ffff_ffff_ffffn
      : toU64(target, "PoW target");
  if (
    targetValue === 0n ||
    challenge.length === 0 ||
    challenge.length % 2 !== 0 ||
    challenge.length > 1024 ||
    !/^[0-9a-fA-F]+$/.test(challenge)
  ) {
    throw fundingInvalid("invalid faucet proof-of-work challenge or target");
  }

  const bytes = hexToBytes(challenge);
  throwIfAborted(signal);
  for (let nonce = 0n; nonce <= 0xffff_ffff_ffff_ffffn; nonce++) {
    const hash = await sha256(concatChallengeAndNonce(bytes, nonce));
    const digest = readU64Be(hash, 0);
    if (digest < targetValue) {
      return nonce;
    }
    if (nonce % 1000n === 999n) {
      await sleep(1, signal);
    }
  }
  throw fundingInvalid("faucet proof of work has no solution");
}

/**
 * HTTP faucet request: metadata, then PoW, then get_tokens.
 *
 * @param {object} args
 * @param {string} args.faucetUrl
 * @param {string} args.accountIdHex
 * @param {string} args.feeFaucetIdHex
 * @param {string | null} args.network
 * @param {bigint | null} args.amount
 * @param {{ AccountId: { fromHex: Function, fromBech32: Function } }} args.wasm
 * @param {typeof fetch} args.fetch
 * @param {AbortSignal} [args.signal] Cancels pending requests and the PoW search.
 * @returns {Promise<{ noteId: string, transactionId: string, faucetId: string, amount: bigint }>}
 */
export async function requestNoteFromFaucet({
  faucetUrl,
  accountIdHex,
  feeFaucetIdHex,
  network,
  amount,
  wasm,
  fetch: fetchFn,
  signal,
}) {
  const base = parseFaucetBaseUrl(faucetUrl);
  const metadata = await getJson(
    fetchFn,
    joinUrl(base, "get_metadata"),
    signal
  );
  if (
    metadata == null ||
    typeof metadata.id !== "string" ||
    metadata.base_amount == null
  ) {
    throw fundingInvalid("invalid faucet metadata response");
  }

  const actualIdHex = resolveFaucetAccountIdHex(metadata.id, network, wasm);
  if (normalizeHex(actualIdHex) !== normalizeHex(feeFaucetIdHex)) {
    throw fundingInvalid(
      `faucet issues ${actualIdHex}, but the chain's fee asset is ${feeFaucetIdHex}`
    );
  }

  const resolvedAmount =
    amount != null
      ? amount
      : toPositiveU64(metadata.base_amount, "faucet base_amount");
  if (resolvedAmount === 0n) {
    throw fundingInvalid("faucet amount must be positive");
  }

  const powUrl = joinUrl(base, "pow");
  // Faucet wire names are snake_case.
  powUrl.searchParams.set("account_id", accountIdHex);
  powUrl.searchParams.set("amount", resolvedAmount.toString());
  const challengeBody = await getJson(fetchFn, powUrl, signal);
  if (
    challengeBody == null ||
    typeof challengeBody.challenge !== "string" ||
    challengeBody.target == null
  ) {
    throw fundingInvalid("invalid faucet proof-of-work response");
  }

  const nonce = await solvePow(
    challengeBody.challenge,
    challengeBody.target,
    signal
  );

  const tokensUrl = joinUrl(base, "get_tokens");
  tokensUrl.searchParams.set("account_id", accountIdHex);
  tokensUrl.searchParams.set("is_private_note", "false");
  tokensUrl.searchParams.set("asset_amount", resolvedAmount.toString());
  tokensUrl.searchParams.set("challenge", challengeBody.challenge);
  tokensUrl.searchParams.set("nonce", nonce.toString());
  const mint = await getJson(fetchFn, tokensUrl, signal);
  if (
    mint == null ||
    typeof mint.note_id !== "string" ||
    typeof mint.tx_id !== "string"
  ) {
    throw fundingInvalid("invalid faucet get_tokens response");
  }

  return {
    noteId: mint.note_id,
    transactionId: mint.tx_id,
    faucetId: feeFaucetIdHex,
    amount: resolvedAmount,
  };
}

/**
 * Classify an `InputNoteRecord.state()` value.
 * @param {unknown} state
 * @param {object} [wasm]
 * @returns {"committed" | "consumed" | "invalid" | "processing" | "other"}
 */
export function classifyInputNoteState(state, wasm) {
  const InputNoteState = wasm?.InputNoteState;
  if (InputNoteState) {
    if (state === InputNoteState.Committed) return "committed";
    if (state === InputNoteState.Invalid) return "invalid";
    if (
      state === InputNoteState.ProcessingAuthenticated ||
      state === InputNoteState.ProcessingUnauthenticated
    ) {
      return "processing";
    }
    if (
      state === InputNoteState.ConsumedAuthenticatedLocal ||
      state === InputNoteState.ConsumedUnauthenticatedLocal ||
      state === InputNoteState.ConsumedExternal
    ) {
      return "consumed";
    }
  }

  const name =
    typeof state === "string"
      ? state
      : typeof state === "number"
        ? String(state)
        : String(state?.toString?.() ?? state ?? "");

  if (name === "Committed" || name.endsWith(".Committed")) return "committed";
  if (name === "Invalid" || name.endsWith(".Invalid")) return "invalid";
  if (PROCESSING_STATES.has(name) || name.includes("Processing")) {
    return "processing";
  }
  if (CONSUMED_STATES.has(name) || name.includes("Consumed")) {
    return "consumed";
  }
  // Numeric wasm-bindgen order: Expected=0 … Committed=2 …
  if (name === "2") return "committed";
  if (name === "3") return "invalid";
  if (name === "4" || name === "5") return "processing";
  if (name === "6" || name === "7" || name === "8") return "consumed";
  return "other";
}

/**
 * @param {Error} source
 * @param {{ noteId: string, transactionId?: string | null }} receipt
 * @returns {Error}
 */
export function wrapAfterRequest(source, receipt) {
  // consume can throw after the node accepted the transaction, with its id on the error.
  const transactionId = receipt.transactionId ?? source.transactionId ?? null;
  const err = new Error(
    `funding note ${receipt.noteId}, consumption transaction ${transactionId ?? "none"}: ${source.message}`
  );
  err.code = "FundingAfterRequest";
  err.noteId = receipt.noteId;
  err.transactionId = transactionId;
  err.cause = source;
  if (source.code) err.sourceCode = source.code;
  return err;
}

export function fundingInvalid(message) {
  const err = new Error(message);
  err.code = "FundingInvalid";
  return err;
}

function fundingAborted() {
  const err = new Error("funding stage aborted");
  err.code = "FundingAborted";
  return err;
}

function fundingTimeout(stage) {
  const err = new Error(`funding timed out while waiting for ${stage}`);
  err.code = "FundingTimeout";
  err.stage = stage;
  return err;
}

function fundingHttp(status, body) {
  const err = new Error(
    `faucet request failed: HTTP ${status}${body ? `: ${body}` : ""}`
  );
  err.code = "FundingHttp";
  err.status = status;
  return err;
}

// ── internals ────────────────────────────────────────────────────

function validateTimerMs(value, name) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_TIMER_MS
  ) {
    throw fundingInvalid(
      `${name} must be an integer between 1 and ${MAX_TIMER_MS} milliseconds`
    );
  }
}

function toPositiveU64(value, label) {
  // An unsafe number may already be rounded: larger values must be a bigint or string.
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw fundingInvalid(
      `${label} must be a safe integer; pass a bigint or string for larger values`
    );
  }
  const n = toU64(value, label);
  if (n === 0n) {
    throw fundingInvalid(`${label} must be positive`);
  }
  return n;
}

function toU64(value, label) {
  let n;
  try {
    if (typeof value === "bigint") n = value;
    else if (typeof value === "number") {
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error("not an integer");
      }
      n = BigInt(value);
    } else if (typeof value === "string") n = BigInt(value);
    else throw new Error("unsupported type");
  } catch {
    throw fundingInvalid(`${label} must be a u64 integer`);
  }
  if (n < 0n || n > 0xffff_ffff_ffff_ffffn) {
    throw fundingInvalid(`${label} must fit in u64`);
  }
  return n;
}

function parseFaucetBaseUrl(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw fundingInvalid("faucet_url must be an HTTP(S) base URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw fundingInvalid(
      "faucet_url must be an HTTP(S) base URL without query or fragment"
    );
  }
  if (url.search || url.hash) {
    throw fundingInvalid(
      "faucet_url must be an HTTP(S) base URL without query or fragment"
    );
  }
  // Ensure trailing slash so join works like Rust Url::join on a directory.
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function joinUrl(base, path) {
  return new URL(path, base);
}

async function getJson(fetchFn, url, signal) {
  if (typeof fetchFn !== "function") {
    throw fundingInvalid("fetch is not available in this environment");
  }
  // A request that starts after the deadline can still mint a note nobody learns about.
  throwIfAborted(signal);
  let response;
  try {
    response = await fetchFn(url.href ?? String(url), {
      method: "GET",
      // Minting uses GET but changes server state: never auto-retry.
      cache: "no-store",
      signal,
    });
  } catch (cause) {
    const err = new Error(`faucet request failed: ${cause.message ?? cause}`);
    err.code = "FundingHttp";
    err.cause = cause;
    throw err;
  }
  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore
    }
    throw fundingHttp(response.status, body.slice(0, 200));
  }
  try {
    return await response.json();
  } catch {
    throw fundingInvalid("faucet returned non-JSON response");
  }
}

function resolveFaucetAccountIdHex(id, network, wasm) {
  if (id.startsWith("0x") || id.startsWith("0X")) {
    // Validate via wasm when present.
    if (wasm?.AccountId?.fromHex) {
      const parsed = wasm.AccountId.fromHex(id);
      return typeof parsed.toString === "function" ? parsed.toString() : id;
    }
    return id;
  }
  const bechNetwork = networkFromBech32(id);
  if (network && bechNetwork && bechNetwork !== network) {
    throw fundingInvalid("faucet address belongs to a different network");
  }
  if (!wasm?.AccountId?.fromBech32) {
    throw fundingInvalid("cannot decode faucet bech32 address");
  }
  const parsed = wasm.AccountId.fromBech32(id);
  return typeof parsed.toString === "function"
    ? parsed.toString()
    : String(parsed);
}

function normalizeHex(hex) {
  return String(hex).toLowerCase().replace(/^0x/, "");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concatChallengeAndNonce(challengeBytes, nonce) {
  const out = new Uint8Array(challengeBytes.length + 8);
  out.set(challengeBytes, 0);
  const view = new DataView(out.buffer, challengeBytes.length, 8);
  view.setBigUint64(0, nonce, false);
  return out;
}

function readU64Be(bytes, offset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return view.getBigUint64(0, false);
}

// Web Crypto is global in browsers and Node >= 20; a `node:crypto` fallback
// would break browser bundlers that cannot resolve the `node:` scheme.
async function sha256(data) {
  if (!globalThis.crypto?.subtle?.digest) {
    throw fundingInvalid("Web Crypto (crypto.subtle) is not available");
  }
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
}
