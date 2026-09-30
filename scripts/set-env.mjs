// Sets KEY=VALUE pairs in .env.local (adds or replaces lines).
//
//   node scripts/set-env.mjs NAME=value OTHER=value

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../.env.local", import.meta.url));
let lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];

const pairs = process.argv.slice(2);
if (!pairs.length) {
  console.error("Usage: node scripts/set-env.mjs NAME=value [NAME=value ...]");
  process.exit(1);
}

for (const pair of pairs) {
  const i = pair.indexOf("=");
  if (i < 1) {
    console.error(`Skipping "${pair}" (expected NAME=value)`);
    continue;
  }
  const name = pair.slice(0, i);
  const idx = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (idx >= 0) lines[idx] = pair;
  else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, pair);
  console.log(`Set ${name}`);
}

writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
