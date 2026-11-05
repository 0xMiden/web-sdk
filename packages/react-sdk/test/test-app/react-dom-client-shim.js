const ReactDOM = window.ReactDOM;

if (!ReactDOM || typeof ReactDOM.createRoot !== "function") {
  throw new Error(
    "ReactDOM.createRoot not found. Ensure /vendor/react.js is loaded."
  );
}

export const createRoot = ReactDOM.createRoot;
