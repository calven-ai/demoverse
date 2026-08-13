/**
 * Deterministic, seedable RNG + sampling helpers.
 *
 * The whole point of the engine is reproducibility: replaying the ledger must
 * yield the same world. We therefore never use Math.random(); every stochastic
 * choice flows through a seeded generator keyed on stable inputs (e.g. the
 * world seed + period index + a salt), so a given period always resolves the
 * same way.
 */

/** mulberry32 — small, fast, good-enough PRNG for synthetic data. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash an arbitrary string to a 32-bit seed (FNV-1a). */
export function hashSeed(...parts: (string | number)[]): number {
  const str = parts.join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private next: () => number;

  constructor(seed: number | string) {
    this.next = mulberry32(typeof seed === "string" ? hashSeed(seed) : seed);
  }

  /** Float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Bernoulli trial: true with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniformly pick one element. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick: empty array");
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Shuffle a copy (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /**
   * Weighted choice from a {key: weight} map. Weights need not sum to 1.
   */
  weighted<K extends string>(weights: Record<K, number>): K {
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    if (total <= 0) throw new Error("Rng.weighted: weights sum to 0");
    let r = this.next() * total;
    for (const [k, w] of entries) {
      r -= w;
      if (r < 0) return k;
    }
    return entries[entries.length - 1]![0];
  }

  /**
   * Triangular distribution — natural for deal sizes (min/mode/max).
   * Returns an integer.
   */
  triangular(min: number, mode: number, max: number): number {
    const u = this.next();
    const c = (mode - min) / (max - min);
    const v =
      u < c
        ? min + Math.sqrt(u * (max - min) * (mode - min))
        : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
    return Math.round(v);
  }
}
