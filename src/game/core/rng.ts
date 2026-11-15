/** Seeded pseudo-random generator (mulberry32 variant) with convenience helpers. */

/** A seeded generator: call it for a float in [0, 1). */
export interface Rng {
  (): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Random element of `items`. */
  pick<T>(items: ArrayLike<T>): T;
  /** -1 or 1. */
  sign(): -1 | 1;
  /** Independent generator seeded from this one (consumes one draw). */
  fork(): Rng;
}

/** Creates a generator from a 32-bit seed. */
export function createRng(seed = 1337): Rng {
  let state = seed >>> 0;
  const next = () => {
    state |= 0;
    state = (state + 1831565813) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = Object.assign(next, {
    range: (min: number, max: number) => min + (max - min) * next(),
    int: (min: number, max: number) => Math.floor(min + (max - min + 1) * next()),
    pick: <T>(items: ArrayLike<T>): T => items[Math.floor(next() * items.length)],
    sign: (): -1 | 1 => (next() < 0.5 ? -1 : 1),
    fork: (): Rng => createRng(Math.floor(next() * 4294967296))
  });
  return rng;
}
