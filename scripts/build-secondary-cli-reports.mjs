import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["A-tour.swf", "intro.swf", "nav.swf", "segment1.swf", "segment2.swf", "segment3.swf", "segment4.swf", "segment5.swf"];

for (const target of targets) {
  const swfPath = resolveSwfPath(target);
  if (!existsSync(swfPath)) throw new Error(`SWF not found: ${swfPath}`);

  const scene = basename(target, ".swf");
  const outputDir = join(root, "public/generated", scene, "secondary");
  mkdirSync(outputDir, { recursive: true });

  runToFile(localOrPath("flasm", "tools/flasm-bin/flasm"), ["-d", swfPath], join(outputDir, "flasm.flm"), { required: true });
  runToFile("swfdump", ["-a", "-B", "-F", "-b", "-u", swfPath], join(outputDir, "swfdump.txt"), { required: true });
  runToFile("swfextract", [swfPath], join(outputDir, "swfextract.txt"), { required: true });
  runToFile("swfmill", ["swf2xml", swfPath, join(outputDir, "swfmill.xml")], join(outputDir, "swfmill.stderr.txt"), { required: true });

  console.log(`${scene}: wrote SWFTools/swfmill secondary reports`);
}

function resolveSwfPath(target) {
  const direct = resolve(root, target);
  if (existsSync(direct)) return direct;

  const publicPath = resolve(root, "public", basename(target));
  if (existsSync(publicPath)) return publicPath;

  return direct;
}

function runToFile(command, args, outputPath, { required }) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 100 });
  if (result.error?.code === "ENOENT") {
    const message = `${command} not found`;
    if (required) throw new Error(message);
    writeFileSync(outputPath, `${message}\n`);
    return;
  }

  const output = `${result.stdout ?? ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`;
  writeFileSync(outputPath, output);

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}. See ${outputPath}`);
  }
}

function localOrPath(pathCommand, localPath) {
  const resolved = join(root, localPath);
  return existsSync(resolved) ? resolved : pathCommand;
}
