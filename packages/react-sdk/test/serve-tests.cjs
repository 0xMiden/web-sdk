/**
 * Simple static server that serves both the test app and the SDK.
 * - /        -> test/test-app/
 * - /sdk/    -> ../../crates/web-client/dist/st/
 * - /react-sdk/ -> ../dist/
 * - /vendor/react.js -> react + react-dom, assembled at startup (see below)
 * - /vendor/zustand/ -> ../node_modules/zustand/
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number.parseInt(process.env.PORT, 10) || 8081;
const MAX_URL_LENGTH = 2048;
const ALLOWED_METHODS = new Set(["GET", "HEAD"]);
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

const TEST_APP_DIR = path.join(__dirname, "test-app");
const SDK_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "crates",
  "web-client",
  "dist",
  "st"
);
const REACT_SDK_DIR = path.join(__dirname, "..", "dist");
const ZUSTAND_DIR = path.join(__dirname, "..", "node_modules", "zustand");

// React 19 ships no UMD build, and the test apps reach React through the
// window globals that the shims in test-app/ re-export. Assemble one script
// at startup that evaluates the CommonJS development builds of react,
// react-dom, react-dom/client and their scheduler dependency with a minimal
// require(), then sets those globals.
const REACT_VENDOR_PATH = "/vendor/react.js";

function packageDir(name, fromDir) {
  return path.dirname(
    require.resolve(`${name}/package.json`, { paths: [fromDir] })
  );
}

function buildReactVendorScript() {
  const reactDir = packageDir("react", __dirname);
  const reactDomDir = packageDir("react-dom", __dirname);
  const schedulerDir = packageDir("scheduler", reactDomDir);
  const modules = {
    react: path.join(reactDir, "cjs", "react.development.js"),
    "react-dom": path.join(reactDomDir, "cjs", "react-dom.development.js"),
    "react-dom/client": path.join(
      reactDomDir,
      "cjs",
      "react-dom-client.development.js"
    ),
    scheduler: path.join(schedulerDir, "cjs", "scheduler.development.js"),
  };

  const definitions = Object.entries(modules)
    .map(
      ([name, file]) =>
        `definitions[${JSON.stringify(name)}] = function (module, exports, require) {\n${fs.readFileSync(file, "utf8")}\n};`
    )
    .join("\n");

  return Buffer.from(`(function () {
  var process = { env: { NODE_ENV: "development" } };
  var definitions = {};
  var cache = {};
  function require(name) {
    if (cache[name]) return cache[name].exports;
    if (!definitions[name]) throw new Error("Unknown module: " + name);
    var module = { exports: {} };
    cache[name] = module;
    definitions[name](module, module.exports, require);
    return module.exports;
  }
${definitions}
  window.React = require("react");
  window.ReactDOM = Object.assign({}, require("react-dom"), require("react-dom/client"));
})();
`);
}

const REACT_VENDOR_SCRIPT = buildReactVendorScript();

const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

function setSecurityHeaders(res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
}

function sendPlain(res, statusCode, message) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(message);
}

function sanitizePath(urlPath) {
  if (!urlPath || urlPath.length > MAX_URL_LENGTH) {
    return null;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
    return null;
  }

  const normalized = path.posix.normalize(decodedPath);
  const endsWithSlash = decodedPath.endsWith("/");
  let relativePath = normalized.replace(/^\/+/, "");

  if (relativePath === "" || endsWithSlash) {
    relativePath = path.posix.join(relativePath, "index.html");
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "..")) {
    return null;
  }

  if (!SAFE_PATH_PATTERN.test(relativePath)) {
    return null;
  }

  return relativePath;
}

function buildFileMap(baseDir) {
  const fileMap = new Map();
  const stack = [baseDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relative = path.relative(baseDir, entryPath);
      const normalized = relative.split(path.sep).join("/");

      if (normalized.startsWith("..") || !SAFE_PATH_PATTERN.test(normalized)) {
        continue;
      }

      fileMap.set(normalized, entryPath);
    }
  }

  return fileMap;
}

function resolveRequestPath(requestPath) {
  if (requestPath === "/sdk") {
    return { baseDir: SDK_DIR, urlPath: "/" };
  }

  if (requestPath.startsWith("/sdk/")) {
    return { baseDir: SDK_DIR, urlPath: requestPath.slice("/sdk".length) };
  }

  if (requestPath === "/react-sdk") {
    return { baseDir: REACT_SDK_DIR, urlPath: "/" };
  }

  if (requestPath.startsWith("/react-sdk/")) {
    return {
      baseDir: REACT_SDK_DIR,
      urlPath: requestPath.slice("/react-sdk".length),
    };
  }

  if (requestPath.startsWith("/vendor/zustand/")) {
    return {
      baseDir: ZUSTAND_DIR,
      urlPath: requestPath.slice("/vendor/zustand".length),
    };
  }

  return { baseDir: TEST_APP_DIR, urlPath: requestPath };
}

const TEST_APP_FILES = buildFileMap(TEST_APP_DIR);
const SDK_FILES = buildFileMap(SDK_DIR);
const REACT_SDK_FILES = buildFileMap(REACT_SDK_DIR);
const ZUSTAND_FILES = buildFileMap(ZUSTAND_DIR);
const FILE_MAPS = new Map([
  [TEST_APP_DIR, TEST_APP_FILES],
  [SDK_DIR, SDK_FILES],
  [REACT_SDK_DIR, REACT_SDK_FILES],
  [ZUSTAND_DIR, ZUSTAND_FILES],
]);

const server = http.createServer((req, res) => {
  setSecurityHeaders(res);

  if (!ALLOWED_METHODS.has(req.method)) {
    res.setHeader("Allow", "GET, HEAD");
    sendPlain(res, 405, "Method Not Allowed");
    return;
  }

  if (!req.url) {
    sendPlain(res, 400, "Bad Request");
    return;
  }

  let requestPath;
  try {
    requestPath = new URL(req.url, "http://localhost").pathname;
  } catch {
    sendPlain(res, 400, "Bad Request");
    return;
  }

  if (requestPath === REACT_VENDOR_PATH) {
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[".js"],
      "Content-Length": REACT_VENDOR_SCRIPT.length,
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : REACT_VENDOR_SCRIPT);
    return;
  }

  const { baseDir, urlPath } = resolveRequestPath(requestPath);
  const relativePath = sanitizePath(urlPath);
  if (!relativePath) {
    sendPlain(res, 400, "Bad Request");
    return;
  }

  const fileMap = FILE_MAPS.get(baseDir);
  const absolutePath = fileMap ? fileMap.get(relativePath) : null;
  if (!absolutePath) {
    sendPlain(res, 404, "Not Found");
    return;
  }

  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = MIME_TYPES[ext];
  if (!contentType) {
    sendPlain(res, 404, "Not Found");
    return;
  }

  fs.stat(absolutePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      sendPlain(res, 404, "Not Found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stats.size,
      "Cache-Control": "no-store",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(absolutePath);
    stream.on("error", () => {
      sendPlain(res, 500, "Internal Server Error");
    });
    stream.pipe(res);
  });
});

server.on("clientError", (err, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(PORT, () => {
  console.log("Test server running", {
    url: `http://localhost:${PORT}`,
    testApp: TEST_APP_DIR,
    sdk: SDK_DIR,
  });
});
