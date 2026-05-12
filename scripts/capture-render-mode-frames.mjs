#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 5184;
const DEFAULT_OUTPUT_DIR = "verification/render-modes";
const MODES = ["frame", "asset", "gsap"];

function parseArgs(argv) {
  const args = {
    scene: "segment4.swf",
    modes: MODES,
    start: 45,
    end: 45,
    step: 1,
    outputDir: DEFAULT_OUTPUT_DIR,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    useExistingServer: false,
    timeoutMs: 120000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--scene" && next) {
      args.scene = next;
      i += 1;
    } else if (token === "--mode" && next) {
      args.modes = next.split(",").map((mode) => mode.trim()).filter(Boolean);
      i += 1;
    } else if (token === "--start" && next) {
      args.start = Number.parseInt(next, 10);
      i += 1;
    } else if (token === "--end" && next) {
      args.end = Number.parseInt(next, 10);
      i += 1;
    } else if (token === "--step" && next) {
      args.step = Number.parseInt(next, 10);
      i += 1;
    } else if (token === "--out" && next) {
      args.outputDir = next;
      i += 1;
    } else if (token === "--host" && next) {
      args.host = next;
      i += 1;
    } else if (token === "--port" && next) {
      args.port = Number.parseInt(next, 10);
      i += 1;
    } else if (token === "--timeout" && next) {
      args.timeoutMs = Number.parseInt(next, 10);
      i += 1;
    } else if (token === "--use-existing-server") {
      args.useExistingServer = true;
    }
  }

  args.modes = args.modes.filter((mode) => MODES.includes(mode));
  if (!args.modes.length) args.modes = MODES;
  if (!Number.isFinite(args.start) || args.start < 0) args.start = 0;
  if (!Number.isFinite(args.end) || args.end < args.start) args.end = args.start;
  if (!Number.isFinite(args.step) || args.step < 1) args.step = 1;
  if (!Number.isFinite(args.port) || args.port <= 0) args.port = DEFAULT_PORT;
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 5000) args.timeoutMs = 120000;
  return args;
}

async function waitForUrl(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function ensureWritableDirectory(dirPath) {
  await mkdir(dirPath, { recursive: true });
  await access(dirPath, constants.W_OK);
}

async function importPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    console.error("[capture-render-mode-frames] Unable to import `playwright`.");
    console.error("Install it first with: npm i -D playwright");
    throw error;
  }
}

async function selectScene(page, swf) {
  await page.waitForSelector("#sceneSelect", { timeout: 60000 });
  const value = await page.$eval("#sceneSelect", (select, targetSwf) => {
    const options = Array.from(select.options);
    const option = options.find((candidate) => candidate.textContent?.toLowerCase().includes(String(targetSwf).toLowerCase()));
    return option?.value ?? "";
  }, swf);
  if (!value) throw new Error(`Could not find scene option for ${swf}`);
  await page.selectOption("#sceneSelect", value);
  await page.waitForTimeout(300);
}

async function setModeAndFrame(page, mode, frame) {
  await page.selectOption("#renderMode", mode);
  await page.$eval("#frameScrubber", (input, targetFrame) => {
    input.value = String(targetFrame);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, frame);
  await page.waitForTimeout(250);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(process.cwd(), args.outputDir);
  await ensureWritableDirectory(outputDir);

  let serverProcess = null;
  const baseUrl = `http://${args.host}:${args.port}/`;

  if (!args.useExistingServer) {
    serverProcess = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "dev", "--", "--host", args.host, "--port", String(args.port), "--strictPort"],
      { cwd: process.cwd(), stdio: "inherit" },
    );
  }

  try {
    await waitForUrl(baseUrl, args.timeoutMs);
    const { chromium } = await importPlaywright();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await selectScene(page, args.scene);

    const stage = page.locator("#assetStage");
    await stage.waitFor({ state: "visible", timeout: 60000 });

    for (const mode of args.modes) {
      const modeDir = path.join(outputDir, args.scene.replace(/\.swf$/i, ""), mode);
      await ensureWritableDirectory(modeDir);
      for (let frame = args.start; frame <= args.end; frame += args.step) {
        await setModeAndFrame(page, mode, frame);
        const outputPath = path.join(modeDir, `frame-${String(frame).padStart(4, "0")}.png`);
        await stage.screenshot({ path: outputPath });
        console.log(`[capture-render-mode-frames] ${mode} frame ${frame}: ${outputPath}`);
      }
    }

    await browser.close();
  } finally {
    if (serverProcess) serverProcess.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error("[capture-render-mode-frames] Failed:", error);
  process.exitCode = 1;
});
