import { glob } from "glob";
import { rimraf } from "rimraf";

// Drop the `wasm.js` entry stub that rollup emits as a side effect of the
// shared input array `["./js/wasm.js", "./js/index.js", "./js/eager.js"]`.
// We don't expose `wasm.js` as a public subpath — it's just the wasm-bindgen
// glue's loader. Cleaning it keeps `dist/{st,mt}/` lean and `attw` happy.
//
// Glob both subdirs (dist/st, dist/mt) so the cleanup runs on whichever
// variants the build produced.
glob("dist/{st,mt}/wasm*", (err, files) => {
  if (err) {
    console.error("Error finding files:", err);
    return;
  }

  // Iterate through the matched files/directories and delete them
  files.forEach((file) => {
    rimraf(file, (rimrafErr) => {
      if (rimrafErr) {
        console.error(`Error deleting ${file}:`, rimrafErr);
      } else {
        console.log(`Deleted: ${file}`);
      }
    });
  });
});
