import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Loads environment variables from a dotenv-style file (default: `.env`) into `process.env`.
 * This is intentionally lightweight to avoid a runtime dependency in tests.
 */
export function loadDotEnv({ cwd = process.cwd(), filename = ".env", override = false } = {}) {
  const envPath = resolve(cwd, filename);
  if (!existsSync(envPath)) return false;

  const raw = readFileSync(envPath, "utf8");
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(withoutExport);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (!override && process.env[key] !== undefined) continue;

    let value = unquote(rawValue.trim());
    value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
    process.env[key] = value;
  }

  return true;
}

