#!/usr/bin/env node
/**
 * Long-running loop: poll for new launches and notify every N minutes.
 * Use for Railway or any always-on process.
 *
 * Env:
 *   POLL_INTERVAL_MS  - Milliseconds between polls (default: 300000 = 5 min)
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || "300000", 10);

async function runNotify() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(__dirname, "notify.js")],
      {
        stdio: "inherit",
        env: process.env,
      }
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

async function loop() {
  while (true) {
    try {
      await runNotify();
    } catch (e) {
      console.error("Notify failed:", e.message);
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

loop();
