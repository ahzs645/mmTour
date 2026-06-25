import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const ffdecJar = join(root, "tools/ffdec-runtime/ffdec_26.0.0/ffdec-cli.jar");
const swfs = process.argv.slice(2);

if (!existsSync(ffdecJar)) {
  throw new Error(`FFDec CLI jar not found at ${ffdecJar}`);
}

const targets = swfs.length > 0
  ? swfs
  : ["A-tour.swf", "intro.swf", "nav.swf", "segment1.swf", "segment2.swf", "segment3.swf", "segment4.swf", "segment5.swf", "bnl.swf"];

for (const target of targets) {
  const swfPath = resolveSwfPath(target);
  const scene = basename(target, ".swf");
  const outDir = join(root, "extracted", scene);

  if (!existsSync(swfPath)) {
    throw new Error(`SWF not found: ${swfPath}`);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  run("java", [
    "-jar",
    ffdecJar,
    "-charset",
    "UTF-8",
    "-format",
    "shape:svg,sprite:svg,button:svg,image:png,frame:svg,text:plain,script:as,sound:mp3_wav,font:ttf",
    "-export",
    "shape,image,sprite,button,frame,text,script,sound,font",
    outDir,
    swfPath,
  ]);

  run("java", ["-jar", ffdecJar, "-charset", "UTF-8", "-swf2xml", swfPath, join(outDir, `${scene}.xml`)]);
}

function resolveSwfPath(target) {
  const direct = resolve(root, target);
  if (existsSync(direct)) return direct;

  const publicPath = resolve(root, "public", basename(target));
  if (existsSync(publicPath)) return publicPath;

  return direct;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}
