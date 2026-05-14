import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

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
    ...builtins,
  ],
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
