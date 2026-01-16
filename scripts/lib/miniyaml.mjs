import { readFile } from "node:fs/promises";

function stripYamlComment(line) {
  // Simple comment stripping: good enough for our config files.
  // If you need literal '#' in values, quote them.
  const idx = line.indexOf("#");
  return idx === -1 ? line : line.slice(0, idx);
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === "") return "";
  if (s === "[]") return [];
  if (s === "{}") return {};
  if (s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function nextKind(lines, startIndex, parentIndent) {
  for (let i = startIndex; i < lines.length; i++) {
    const raw = stripYamlComment(lines[i]);
    if (!raw.trim()) continue;
    const indent = raw.match(/^\s*/)[0].length;
    if (indent <= parentIndent) return "object";
    return raw.trim().startsWith("- ") ? "array" : "object";
  }
  return "object";
}

export function parseYaml(text) {
  // Minimal YAML subset for our config files:
  // - maps via "key: value" and "key:" blocks
  // - arrays via "- value"
  // - scalars: string/bool/null/number plus []/{}
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const root = {};
  const stack = [{ indent: -1, kind: "object", value: root }];

  const top = () => stack[stack.length - 1];

  for (let i = 0; i < lines.length; i++) {
    const raw = stripYamlComment(lines[i]);
    if (!raw.trim()) continue;

    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();

    while (stack.length > 1 && indent <= top().indent) stack.pop();

    if (line.startsWith("- ")) {
      if (top().kind !== "array") throw new Error("YAML parse error: list item under non-array.");
      top().value.push(parseScalar(line.slice(2)));
      continue;
    }

    const idx = line.indexOf(":");
    if (idx < 1) throw new Error(`YAML parse error: expected "key: value" (got: ${line})`);
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();

    if (top().kind !== "object") throw new Error("YAML parse error: key/value under array.");

    if (rest === "") {
      const kind = nextKind(lines, i + 1, indent);
      const nextValue = kind === "array" ? [] : {};
      top().value[key] = nextValue;
      stack.push({ indent, kind, value: nextValue });
      continue;
    }

    top().value[key] = parseScalar(rest);
  }

  return root;
}

export async function loadYamlFile(path) {
  return parseYaml(await readFile(path, "utf8"));
}

