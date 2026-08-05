import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const secretsPath = resolve(".prod.vars");
const key = "SESSION_SECRET";
const isDryRun = process.argv.includes("--dry-run");

function readSessionSecret(contents) {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1 || line.slice(0, separator).trim() !== key) continue;
    return line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
}

if (!existsSync(secretsPath)) {
  const secret = randomBytes(48).toString("base64url");
  writeFileSync(
    secretsPath,
    `# Generated locally for Cloudflare deployment. Do not commit this file.\n${key}=${secret}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  console.log("Created .prod.vars with a cryptographically secure SESSION_SECRET.");
}

const secret = readSessionSecret(readFileSync(secretsPath, "utf8"));
if (!secret || secret.length < 32 || secret.startsWith("replace-with-")) {
  console.error(".prod.vars must contain a non-placeholder SESSION_SECRET of at least 32 characters.");
  process.exit(1);
}

console.log("Using SESSION_SECRET from .prod.vars (the value will not be printed).\n");

const npmCli = process.env.npm_execpath;

if (!npmCli) {
  console.error("Run this deploy helper through `npm run deploy:cloudflare` or `npm run deploy:check`.");
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [npmCli, "test"]);
run(process.execPath, [npmCli, "run", "build"]);
if (!isDryRun) {
  run(process.execPath, [npmCli, "run", "db:migrate:remote"]);
}
run(process.execPath, [
  npmCli,
  "exec",
  "--",
  "wrangler",
  "deploy",
  ...(isDryRun ? ["--dry-run"] : []),
  "--secrets-file",
  ".prod.vars",
]);
