import { access, cp, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

// Optional offline Windows fixture host. Copies Electron binaries, never installed app code/data.
const sourceArg = process.argv.find((arg) => arg.startsWith("--source="))?.slice(9);
const outputArg = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6);
if (
  process.platform !== "win32" ||
  !sourceArg ||
  !outputArg ||
  !isAbsolute(sourceArg) ||
  !isAbsolute(outputArg)
) {
  throw new Error(
    "Usage (Windows): node prepare-iab-upload-fixture-runtime.mjs --source=<absolute installed ZCode directory> --out=<new absolute fixture directory>",
  );
}
const source = await realpath(resolve(sourceArg));
const requestedOutput = resolve(outputArg);
const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};
if (inside(source, output) || inside(output, source))
  throw new Error("Fixture runtime must be separate from the installed app");
await access(join(source, "ZCode.exe"));
// Require a new output so this command cannot replace an existing application or user directory.
await mkdir(output);
await mkdir(join(output, "resources/app"), { recursive: true });
const assets = [
  "ZCode.exe",
  "chrome_100_percent.pak",
  "chrome_200_percent.pak",
  "d3dcompiler_47.dll",
  "dxcompiler.dll",
  "dxil.dll",
  "ffmpeg.dll",
  "icudtl.dat",
  "libEGL.dll",
  "libGLESv2.dll",
  "resources.pak",
  "snapshot_blob.bin",
  "v8_context_snapshot.bin",
  "vk_swiftshader_icd.json",
  "vk_swiftshader.dll",
  "vulkan-1.dll",
  "locales",
];
for (const name of assets)
  await cp(join(source, name), join(output, name), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
await writeFile(
  join(output, "resources/app/package.json"),
  JSON.stringify({
    name: "zcode-iab-upload-verification",
    version: "0.0.0",
    type: "module",
    main: "smoke.mjs",
  }),
);
console.log(`Prepared isolated Electron fixture runtime: ${output}`);
