// Starts an isolated Vite dev server for the Playwright verifiers and resolves once
// it answers HTTP. Shared by the Ruffle verification scripts so each harness can run
// standalone (no server) or against an already-running one via VERIFY_URL.

import { spawn } from "node:child_process";

/** Spawn `npm run dev` on `port` and resolve when it serves 200, else reject with logs. */
export async function startDevServer(root, port, { timeoutMs = 20_000 } = {}) {
  const child = spawn("npm", ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for Vite dev server on ${port}\n${output}`)), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Vite dev server exited with ${code}\n${output}`));
    });
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) { clearTimeout(timer); clearInterval(poll); resolve(); }
      } catch {
        // Keep polling until Vite is ready or the timeout fires.
      }
    }, 250);
  });

  return child;
}

/** Terminate a dev server started by {@link startDevServer}. */
export async function stopDevServer(child) {
  if (!child) return;
  if (child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}
