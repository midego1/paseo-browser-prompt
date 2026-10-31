// Static guard: on Paseo 0.11 plugin screens (addScreen, addSettingsScreen) get no client-state
// provider, so useAgent/useWorkspace throw "Plugin state hooks must run inside a workspace panel".
// Walk every screen component's module graph and fail if it reaches one of those hooks.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_HOOKS = /\buse(Agent|Workspace)\s*\(/;

function resolveModule(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        readFileSync(candidate);
        return candidate;
      } catch {}
    }
  }
  throw new Error(`Cannot resolve ${spec} from ${fromFile}`);
}

function relativeImports(file) {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gms)].map((m) => resolveModule(file, m[1]));
}

function reachesStateHook(entry, seen = new Set()) {
  if (seen.has(entry)) return null;
  seen.add(entry);
  if (STATE_HOOKS.test(readFileSync(entry, "utf8"))) return entry;
  for (const dep of relativeImports(entry)) {
    const hit = reachesStateHook(dep, seen);
    if (hit) return hit;
  }
  return null;
}

/** Screen component names registered in index.client.tsx, mapped to their modules. */
function screenModules() {
  const entry = join(root, "index.client.tsx");
  const source = readFileSync(entry, "utf8");
  const names = [...source.matchAll(/add(?:Screen|SettingsScreen)\(\{[^}]*?Component:\s*(\w+)/gs)].map((m) => m[1]);
  const modules = new Map();
  for (const name of names) {
    const imp = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"(\\.[^"]+)"`).exec(source);
    assert.ok(imp, `import for ${name} not found`);
    modules.set(name, resolveModule(entry, imp[1]));
  }
  return modules;
}

test("screens are registered and found", () => {
  const modules = screenModules();
  assert.ok(modules.has("AgentRunScreen"));
  assert.ok(modules.has("SettingsScreen"));
});

test("screen modules never reach useAgent/useWorkspace", () => {
  for (const [name, file] of screenModules()) {
    const hit = reachesStateHook(file);
    assert.equal(hit, null, `${name} (${file}) reaches a panel-only state hook in ${hit}`);
  }
});
