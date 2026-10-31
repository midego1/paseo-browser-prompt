// Pure migration for the `preferences` settings document, kept import-free so tests can load it.

/** Converts a stored `preferences` document from `fromVersion` to the current shape. */
export function migratePreferences(values: unknown, fromVersion: number): unknown {
  const old = (values ?? {}) as { done?: unknown; reportBack?: unknown };
  // v1 only had startMode ("web-agent" | "copy-only") and done. The app is the new default.
  if (fromVersion < 2) return { done: Array.isArray(old.done) ? old.done : [] };
  // v5 stored reportBack as a boolean: true becomes auto, false becomes off.
  if (fromVersion < 6 && typeof old.reportBack === "boolean") {
    return { ...(values as object), reportBack: old.reportBack ? "auto" : "off" };
  }
  // v3 to v6 only add fields with defaults.
  return values;
}
