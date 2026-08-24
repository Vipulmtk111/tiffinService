/**
 * Update .env on any machine without opening an editor.
 *
 *   node scripts/setEnv.js KEY=VALUE [KEY=VALUE ...]
 *   node scripts/setEnv.js --show                  (list keys, values hidden)
 *
 * Examples:
 *   node scripts/setEnv.js WHATSAPP_FLOW_ID=2156938788204925 WHATSAPP_FLOW_MODE=draft
 *   node scripts/setEnv.js ORDER_CUTOFF=17:00 SUMMARY_TIME=18:05
 *
 * An existing key is replaced in place; a new one is appended. Everything else —
 * comments, blank lines, ordering, line endings — is left untouched, and the
 * previous file is kept as .env.bak. Values are never printed.
 */
const fs = require("fs");
const path = require("path");

const ENV = path.join(__dirname, "..", ".env");
const SECRET = /(TOKEN|KEY|SECRET|PASSWORD)/i;

function show(env) {
  console.log(`${ENV}\n`);
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    const shown = SECRET.test(key)
      ? (value ? `<set, ${value.length} chars>` : "<empty>")
      : value;
    console.log(`  ${key.padEnd(30)} ${shown}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (!fs.existsSync(ENV)) {
    console.error(`No .env at ${ENV}`);
    console.error("Run this from the repo root, or copy .env.example to .env first.");
    process.exit(1);
  }
  let env = fs.readFileSync(ENV, "utf8");

  if (!args.length || args[0] === "--show") return show(env);

  const pairs = [];
  for (const arg of args) {
    const i = arg.indexOf("=");
    if (i < 1) {
      console.error(`Not a KEY=VALUE argument: ${arg}`);
      process.exit(1);
    }
    const key = arg.slice(0, i).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) {
      console.error(`Not a valid env key: ${key}`);
      process.exit(1);
    }
    pairs.push([key, arg.slice(i + 1)]);
  }

  // Match the file's existing line ending so the diff stays clean on Windows.
  const nl = env.includes("\r\n") ? "\r\n" : "\n";
  const changed = [];
  for (const [key, value] of pairs) {
    const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "m");
    if (re.test(env)) {
      const before = env;
      env = env.replace(re, `${key}=${value}`);
      changed.push(`${key} (updated${before === env ? ", unchanged" : ""})`);
    } else {
      if (!env.endsWith(nl)) env += nl;
      env += `${key}=${value}${nl}`;
      changed.push(`${key} (added)`);
    }
  }

  fs.copyFileSync(ENV, `${ENV}.bak`);
  fs.writeFileSync(ENV, env);
  console.log(`Updated ${ENV}`);
  for (const c of changed) console.log(`  ${c}`);
  console.log(`\nPrevious file saved as .env.bak`);
  console.log("Restart the bot for changes to take effect (config is read at startup).");
}

main();
