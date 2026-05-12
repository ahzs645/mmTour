#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_PORT = 4173;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_OUTPUT_DIR = 'artifacts/direct-renderer-frames';

function parseArgs(argv) {
  const args = {
    scene: 'segment4.swf',
    start: 0,
    end: null,
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
    if (token === '--scene' && next) {
      args.scene = next;
      i += 1;
    } else if (token === '--start' && next) {
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
    console.error('[capture-direct-renderer-frames] Unable to import `playwright`.');
    console.error('Install it first with: npm i -D playwright');
    throw error;
  }
}

async function ensureWritableDirectory(dirPath) {
  await mkdir(dirPath, { recursive: true });
  await access(dirPath, constants.W_OK);
}

async function selectScene(page, scene) {
  await page.$eval('#sceneSelect', (select, targetScene) => {
    const option = [...select.options].find((candidate) => candidate.textContent?.endsWith(` - ${targetScene}`));
    if (!option) throw new Error(`Scene is not available in #sceneSelect: ${targetScene}`);
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, scene);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(process.cwd(), args.outputDir);
  await ensureWritableDirectory(outputDir);

  const baseUrl = `http://${args.host}:${args.port}/`;
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

    await selectScene(page, args.scene);
    await page.selectOption('#renderMode', 'direct');
    await page.waitForFunction(() => {
      const layer = document.querySelector('#directSwfLayer');
      return layer && !layer.hasAttribute('hidden') && layer.children.length > 0;
    }, { timeout: 60000 });

    const totalFrames = await page.$eval('#frameScrubber', (input) => Number(input.max) + 1);
    const endFrame = args.end === null ? totalFrames - 1 : Math.min(args.end, totalFrames - 1);

    console.log(`[capture-direct-renderer-frames] Capturing ${args.scene} frames ${args.start}..${endFrame} step=${args.step}`);
    for (let frame = args.start; frame <= endFrame; frame += args.step) {
      await page.$eval('#frameScrubber', (input, value) => {
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, frame);
      await page.waitForFunction((value) => document.querySelector('#frameScrubber')?.value === String(value), frame);
      const fileName = `${args.scene.replace(/\.swf$/i, '')}-frame-${String(frame).padStart(4, '0')}.png`;
      const outputPath = path.join(outputDir, fileName);
      await page.locator('#assetStage').screenshot({ path: outputPath });
      console.log(`[capture-direct-renderer-frames] Saved ${outputPath}`);
    }

    await browser.close();
    console.log('[capture-direct-renderer-frames] Done.');
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
  }
}

main().catch((error) => {
  console.error('[capture-direct-renderer-frames] Failed:', error);
  process.exitCode = 1;
});
