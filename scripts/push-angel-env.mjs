// Copies the ANGEL_* values from .env.local to the Vercel project's
// Production environment, using the Vercel CLI (log in first with
// `npx vercel login`). Values are passed on stdin, never as arguments.
//
//   node scripts/push-angel-env.mjs

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const KEYS = ["ANGEL_API_KEY", "ANGEL_CLIENT_CODE", "ANGEL_PIN", "ANGEL_TOTP_SECRET"];

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);

const missing = KEYS.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Fill these in .env.local first: ${missing.join(", ")}`);
  process.exit(1);
}

const vercel = (args, input) =>
  spawnSync("npx", ["--yes", "vercel", ...args], { cwd: root, input, encoding: "utf8", shell: true });

// Make sure this folder is linked to the trade-terminal project.
const link = vercel(["link", "--yes", "--project", "trade-terminal"]);
if (link.status !== 0) {
  console.error(link.stderr || link.stdout);
  console.error("\nCould not link to the Vercel project. Run `npx vercel login` first, then try again.");
  process.exit(1);
}

let failed = false;
for (const key of KEYS) {
  vercel(["env", "rm", key, "production", "--yes"]); // ignore "not found"
  const add = vercel(["env", "add", key, "production"], env[key]);
  if (add.status === 0) {
    console.log(`✔ ${key} set for Production`);
  } else {
    failed = true;
    console.error(`✘ ${key}: ${(add.stderr || add.stdout).trim().split("\n").pop()}`);
  }
}

console.log(failed ? "\nSome values failed — see above." : "\nDone. Tell Claude to redeploy (or click Redeploy in Vercel).");
