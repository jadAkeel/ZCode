import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

// Build the actual guest manager + public client, not a replacement browser backend.
const desktop = resolve(import.meta.dirname, "..");
const require = createRequire(join(desktop, "package.json"));
const root = await mkdtemp(join(tmpdir(), "zcode-iab-upload-smoke-"));
await mkdir(join(root, "profile"));
const fixtureRuntime = process.argv
  .find((arg) => arg.startsWith("--fixture-runtime="))
  ?.slice("--fixture-runtime=".length);
if (fixtureRuntime) {
  const manifest = JSON.parse(
    await readFile(join(fixtureRuntime, "resources/app/package.json"), "utf8"),
  );
  if (manifest.name !== "zcode-iab-upload-verification")
    throw new Error("Only an isolated fixture runtime is accepted");
}
const output = fixtureRuntime
  ? join(fixtureRuntime, "resources/app/smoke.mjs")
  : join(root, "smoke.mjs");
// Playwright's pinned generated selector source is loaded at runtime by the real IAB executor.
await symlink(
  resolve(desktop, "../../node_modules"),
  join(dirname(output), "node_modules"),
  "junction",
).catch((error) => {
  if (error.code !== "EEXIST") throw error;
});
await build({
  entryPoints: [join(import.meta.dirname, "iab-upload-smoke.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  banner: {
    js: 'import { createRequire as __fixtureRequire } from "node:module"; const require = __fixtureRequire(import.meta.url);',
  },
  target: "node24",
  external: ["electron"],
  logLevel: "warning",
  plugins: [
    {
      name: "isolated-fixture-diagnostics",
      setup(build) {
        build.onLoad({ filter: /[\\/]main[\\/]logger\.ts$/ }, () => ({
          contents:
            "export const logger = { debug() {}, info() {}, warn: console.warn, error: console.error };",
          loader: "js",
        }));
      },
    },
  ],
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.ZCODE_DATA_BASE_DIR = root;
env.NODE_PATH = [resolve(desktop, "../../node_modules"), env.NODE_PATH]
  .filter(Boolean)
  .join(process.platform === "win32" ? ";" : ":");
console.log(`Isolated embedded upload fixture: ${root}`);
const child = spawn(
  fixtureRuntime ? join(fixtureRuntime, "ZCode.exe") : require("electron"),
  [...(fixtureRuntime ? [] : [output]), `--upload-smoke-root=${root}`],
  {
    env,
    stdio: "inherit",
  },
);
const timer = setTimeout(() => {
  child.kill();
  console.error("Embedded upload fixture exceeded 120 seconds");
}, 120_000);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
  clearTimeout(timer);
});
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exitCode = code ?? 1;
});
