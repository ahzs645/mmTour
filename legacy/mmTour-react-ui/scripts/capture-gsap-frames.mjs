#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_OUTPUT_DIR = 'artifacts/gsap-frames';

function parseArgs(argv) {
  const args = {
    start: 0,
    end: null,
    step: 1,
    outputDir: DEFAULT_OUTPUT_DIR,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    useExistingServer: false,
    mode: 'gsap',
    timeoutMs: 120000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--start' && next) {
      args.start = Number.parseInt(next, 10);
      i += 1;
    } else if (token === '--end' && next) {
      args.end = Number.parseInt(next, 10);
      i += 1;
    } else if (token === '--step' && next) {
      args.step = Math.max(1, Number.parseInt(next, 10));
      i += 1;
    } else if (token === '--out' && next) {
      args.outputDir = next;
      i += 1;
    } else if (token === '--host' && next) {
      args.host = next;
      i += 1;
    } else if (token === '--port' && next) {
      args.port = Number.parseInt(next, 10);
      i += 1;
    } else if (token === '--mode' && next) {
      args.mode = next;
      i += 1;
    } else if (token === '--timeout' && next) {
      args.timeoutMs = Number.parseInt(next, 10);
      i += 1;
    } else if (token === '--use-existing-server') {
      args.useExistingServer = true;
    }
  }

  if (!Number.isFinite(args.start) || args.start < 0) args.start = 0;
  if (args.end !== null && (!Number.isFinite(args.end) || args.end < args.start)) args.end = null;
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
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url} after ${timeoutMs}ms`);
}

async function importPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    console.error('[capture-gsap-frames] Unable to import `playwright`.');
    console.error('Install it first with: npm i -D playwright');
    throw error;
  }
}

async function ensureWritableDirectory(dirPath) {
  await mkdir(dirPath, { recursive: true });
  await access(dirPath, constants.W_OK);
}

function buildBaseUrl(host, port, mode) {
  const params = new URLSearchParams({
    mode,
    autoplay: '0',
    frame: '0',
  });
  return `http://${host}:${port}/?${params.toString()}`;
}

async function getTotalFrames(page) {
  await page.waitForFunction(() => {
    const state = (window).__GSAP_RENDERERS__;
    return Boolean(state && (state.intro || state.nav));
  }, { timeout: 60000 });

  const totalFrames = await page.evaluate(() => {
    const state = (window).__GSAP_RENDERERS__;
    const intro = state?.intro ?? null;
    const nav = state?.nav ?? null;
    if (intro) return intro.totalFrames;
    if (nav) return nav.totalFrames;
    return 0;
  });

  if (!totalFrames || totalFrames < 1) {
    throw new Error(`Invalid frame count returned from renderer: ${totalFrames}`);
  }
  return totalFrames;
}

async function seekFrame(page, frame) {
  await page.evaluate((targetFrame) => {
    const state = (window).__GSAP_RENDERERS__;
    const intro = state?.intro ?? null;
    const nav = state?.nav ?? null;
    intro?.pause();
    nav?.pause();
    if (intro) {
      intro.seekToFrame(Math.min(targetFrame, intro.totalFrames - 1));
    }
    if (nav) {
      nav.seekToFrame(Math.min(targetFrame, nav.totalFrames - 1));
    }
  }, frame);
  await page.waitForTimeout(34);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(process.cwd(), args.outputDir);
  await ensureWritableDirectory(outputDir);

  const baseUrl = buildBaseUrl(args.host, args.port, args.mode);
  let serverProcess = null;

  if (!args.useExistingServer) {
    serverProcess = spawn(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'dev', '--', '--host', args.host, '--port', String(args.port), '--strictPort'],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
      },
    );
  }

  try {
    await waitForUrl(baseUrl, args.timeoutMs);
    const { chromium } = await importPlaywright();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1420, height: 920 } });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });

    const stageSelector = '.gsap-stage';
    await page.waitForSelector(stageSelector, { timeout: 60000 });
    const totalFrames = await getTotalFrames(page);
    const endFrame = args.end === null ? totalFrames - 1 : Math.min(args.end, totalFrames - 1);

    console.log(`[capture-gsap-frames] Capturing frames ${args.start}..${endFrame} step=${args.step}`);
    for (let frame = args.start; frame <= endFrame; frame += args.step) {
      await seekFrame(page, frame);
      const stage = page.locator(stageSelector).first();
      const fileName = `frame-${String(frame).padStart(4, '0')}.png`;
      const outputPath = path.join(outputDir, fileName);
      await stage.screenshot({ path: outputPath });
      console.log(`[capture-gsap-frames] Saved ${outputPath}`);
    }

    await browser.close();
    console.log('[capture-gsap-frames] Done.');
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
  }
}

main().catch((error) => {
  console.error('[capture-gsap-frames] Failed:', error);
  process.exitCode = 1;
});
