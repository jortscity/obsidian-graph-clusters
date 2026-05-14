import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { promises as fs } from "fs";

const prod = process.argv[2] === "production";

// @xenova/transformers' env.js sniffs for fs/path/url at runtime to decide
// "RUNNING_LOCALLY" and then uses import.meta.url to compute __dirname. In
// Obsidian's Electron renderer Node is available, so it takes that branch,
// but esbuild's CJS output stubs import.meta to {} -> fileURLToPath(undefined)
// throws and env init dies. Stub these three builtins to empty modules so
// transformers takes the browser path (RUNNING_LOCALLY = false, no Node FS).
const NODE_STUBS = new Set(["fs", "path", "url"]);
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (NODE_STUBS.has(args.path)) {
        return { path: args.path, namespace: "stub-empty" };
      }
      return null;
    });
    build.onLoad({ filter: /.*/, namespace: "stub-empty" }, () => ({
      contents: "module.exports = {};",
      loader: "js",
    }));
  },
};

// Electron's renderer exposes `process.release.name === "node"`, which makes
// @xenova/transformers pick its ONNX_NODE backend — but onnxruntime-node is
// stubbed out by our browser mainFields, so that backend is empty and
// `env.backends.onnx` ends up undefined. Patch onnx.js so it always takes the
// web branch.
const forceOnnxWeb = {
  name: "force-onnx-web",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]@xenova[\\/]transformers[\\/]src[\\/]backends[\\/]onnx\.js$/ },
      async (args) => {
        const text = await fs.readFile(args.path, "utf8");
        const patched = text.replace(
          /process\?\.release\?\.name === ['"]node['"]/g,
          "false"
        );
        if (patched === text) {
          throw new Error(
            "force-onnx-web: failed to patch onnx.js — node check string changed?"
          );
        }
        return { contents: patched, loader: "js" };
      }
    );
  },
};

// onnxruntime-web's emscripten bundle has its OWN Node detection that hijacks
// globalThis.Worker with require("worker_threads").Worker. In Electron's
// renderer this triggers (Node-ish), the require returns our empty stub, and
// then anything that does `new Worker(...)` crashes with
// "Worker is not a constructor". Force the detection variable to false.
const forceOrtWebBrowser = {
  name: "force-ort-web-browser",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]onnxruntime-web[\\/]dist[\\/]ort-web\.min\.js$/ },
      async (args) => {
        const text = await fs.readFile(args.path, "utf8");
        // Minified pattern emitted by emscripten:
        //   _="object"==typeof process&&"object"==typeof process.versions&&"string"==typeof process.versions.node
        // (with `_` being any single-letter identifier). Replace with `=!1`.
        const re =
          /=\s*"object"\s*==\s*typeof\s+process\s*&&\s*"object"\s*==\s*typeof\s+process\.versions\s*&&\s*"string"\s*==\s*typeof\s+process\.versions\.node/g;
        const patched = text.replace(re, "=!1");
        if (patched === text) {
          throw new Error(
            "force-ort-web-browser: failed to patch ort-web.min.js — emscripten Node check pattern changed?"
          );
        }
        return { contents: patched, loader: "js" };
      }
    );
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins.filter((m) => !NODE_STUBS.has(m)),
  ],
  plugins: [stubNodeBuiltins, forceOnnxWeb, forceOrtWebBrowser],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  // Use browser main fields so @xenova/transformers picks up its WASM/browser
  // bundle rather than the Node native-addon build. The renderer process is
  // Chromium, so the WASM backend is what we want at runtime.
  mainFields: ["browser", "module", "main"],
  conditions: ["browser", "import", "require", "default"],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
