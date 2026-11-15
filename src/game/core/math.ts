/** Small scalar math helpers. */

/** Clamps `value` into [min, max]. */
export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
/** Linear interpolation from `a` to `b` by `t`. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Clamps into [0, 1]. */
export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
/** Hermite smoothstep of `x` between `edge0` and `edge1`. */
export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach of `current` towards `target`. */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  target + (current - target) * Math.exp(-rate * dt);
