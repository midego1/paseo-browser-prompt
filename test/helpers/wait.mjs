// Test helper: wait for a condition to hold instead of sleeping a fixed time, so a slow or
// loaded machine only makes the wait longer, never the assertion wrong.
/**
 * Polls `condition` (sync or async) until it returns truthy and returns that value.
 * Throws with a clear message after `timeoutMs`, so a real regression is not hidden by a long sleep.
 */
export async function waitFor(condition, { timeoutMs = 3000, intervalMs = 5, message = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for: ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
