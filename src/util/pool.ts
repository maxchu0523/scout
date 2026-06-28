/** Run async tasks over `items` with a bounded concurrency. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/** Parse a port spec like "3000", "3000,8080", "1-1024", "80,443,8000-8100". */
export function parsePorts(spec: string): number[] {
  const set = new Set<number>();
  for (const partRaw of spec.split(",")) {
    const part = partRaw.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let a = Number(range[1]);
      let b = Number(range[2]);
      if (a > b) [a, b] = [b, a];
      for (let p = a; p <= b; p++) if (validPort(p)) set.add(p);
    } else {
      const p = Number(part);
      if (validPort(p)) set.add(p);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function validPort(p: number): boolean {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

/**
 * Curated default ports where local MCP/dev HTTP servers commonly listen.
 * Keeps the default scan fast; users can widen with --ports / --full.
 */
export const DEFAULT_PORTS: number[] = [
  80,
  443,
  3000,
  3001,
  3333,
  4000,
  4111,
  5000,
  5173,
  5174,
  6274,
  6277, // MCP Inspector proxy/client defaults
  7000,
  8000,
  8001,
  8008,
  8080,
  8081,
  8443,
  8787, // wrangler / common MCP worker default
  8888,
  9000,
  9090,
  3845, // common MCP server default seen in the wild
  11434, // ollama
];
