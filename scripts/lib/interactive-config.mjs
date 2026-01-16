import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { loadYamlFile } from "./miniyaml.mjs";

function resolveFrom(baseDir, maybePath) {
  if (typeof maybePath !== "string") return maybePath;
  return isAbsolute(maybePath) ? maybePath : resolve(baseDir, maybePath);
}

function normalizeEnvMap(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Config YAML: env must be a mapping (object).");
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    else throw new Error(`Config YAML: env.${key} must be a scalar.`);
  }
  return out;
}

function normalizeDefaultOpts(configDir, input) {
  const defaultOpts = input ?? {};
  if (typeof defaultOpts !== "object" || Array.isArray(defaultOpts)) {
    throw new Error("Config YAML: defaultOpts must be an object.");
  }

  // Convenience: allow `permissions: yolo` as shorthand.
  if (typeof defaultOpts.permissions === "string" && defaultOpts.permissions.trim().toLowerCase() === "yolo") {
    defaultOpts.permissions = { yolo: true };
  }

  if (defaultOpts.workspace && typeof defaultOpts.workspace === "object" && !Array.isArray(defaultOpts.workspace)) {
    const ws = defaultOpts.workspace;
    defaultOpts.workspace = {
      ...(typeof ws.cwd === "string" ? { cwd: resolveFrom(configDir, ws.cwd) } : {}),
      ...(Array.isArray(ws.additionalDirs)
        ? { additionalDirs: ws.additionalDirs.filter((d) => typeof d === "string").map((d) => resolveFrom(configDir, d)) }
        : {}),
    };
  }

  return defaultOpts;
}

async function assertWorkspaceExists(defaultOpts) {
  const ws = defaultOpts?.workspace;
  const cwd = ws?.cwd;
  if (typeof cwd === "string") {
    try {
      const st = await stat(cwd);
      if (!st.isDirectory()) throw new Error("not a directory");
    } catch {
      throw new Error(`workspace.cwd does not exist or is not a directory: ${cwd}`);
    }
  }
  if (Array.isArray(ws?.additionalDirs)) {
    for (const d of ws.additionalDirs) {
      try {
        const st = await stat(d);
        if (!st.isDirectory()) throw new Error("not a directory");
      } catch {
        throw new Error(`workspace.additionalDirs entry does not exist or is not a directory: ${d}`);
      }
    }
  }
}

function normalizeClaudeConfig(configDir, input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("Config YAML: claude must be an object.");
  return {
    ...(typeof input.executable === "string" ? { executable: resolveFrom(configDir, input.executable) } : {}),
    ...(Array.isArray(input.executableArgs) ? { executableArgs: input.executableArgs } : {}),
    ...(typeof input.pathToClaudeCodeExecutable === "string"
      ? { pathToClaudeCodeExecutable: resolveFrom(configDir, input.pathToClaudeCodeExecutable) }
      : {}),
  };
}

export async function loadInteractiveConfig({ configPath, providerKey }) {
  const absoluteConfigPath = resolve(configPath);
  const configDir = dirname(absoluteConfigPath);
  const raw = await loadYamlFile(absoluteConfigPath);

  const env = normalizeEnvMap(raw.env);
  const defaultOpts = normalizeDefaultOpts(configDir, raw.defaultOpts);
  await assertWorkspaceExists(defaultOpts);
  const claude = providerKey === "claude" ? normalizeClaudeConfig(configDir, raw.claude) : undefined;

  return { configPath: absoluteConfigPath, env, defaultOpts, claude };
}
