// The content key of a browser-prompt block, for repeated blocks, shared runs and done marks. Pure, and
// imported by both the transformer (shared/browser-prompt.ts) and the chat index (shared/repeats.ts).
/** Keys of this shape start with this prefix; older card ids (8 hex digits) never do. */
export const KEY_PREFIX = "k1-";

/**
 * One line of a block for its key: NFKC-normalized, outer and repeated inner whitespace collapsed,
 * and a step number written as `N. ` (`1.Open`, `1.   Open` and `1) Open` all become `1. Open`).
 */
function normalizeLine(line: string): string {
  return line
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(\d+)[.)]\s*/, "$1. ");
}

/**
 * A block's text as its key sees it: line endings unified, each line normalized, blank lines
 * dropped. Case and everything else are kept.
 */
export function normalizeBlockText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(normalizeLine)
    .filter(Boolean)
    .join("\n");
}

/** cyrb53: a fast 53-bit string hash (public domain), as 14 hex digits. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

function normalizedBlock(title: string, body: string): string {
  return `${normalizeBlockText(title)}\u0000${normalizeBlockText(body)}`;
}

/** The block's content key: its title and steps, normalized, hashed. Equal blocks share a key. */
export function blockKey(title: string, body: string): string {
  return `${KEY_PREFIX}${hash53(normalizedBlock(title, body))}`;
}

/** FNV-1a 32-bit, hex: a second hash, independent of cyrb53. */
function fnv32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The key plus what makes a false match practically impossible: the normalized text's length and a
 * second, independent hash. Two blocks are the same only when all three match.
 */
export interface BlockFingerprint {
  key: string;
  length: number;
  check: string;
}

export function blockFingerprint(title: string, body: string): BlockFingerprint {
  const text = normalizedBlock(title, body);
  return { key: `${KEY_PREFIX}${hash53(text)}`, length: text.length, check: fnv32(text) };
}

export function sameBlock(a: BlockFingerprint, b: BlockFingerprint): boolean {
  return a.key === b.key && a.length === b.length && a.check === b.check;
}

