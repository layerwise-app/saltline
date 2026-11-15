// Offline DSP toolkit for the procedural sound synthesis: seeded RNG, buffer helpers, biquad
// filters, envelopes, noise/modal/scrape primitives, and the gunshot + reverb-tail synthesizers.
// Also hosts the shared types for sound generators and sound-table entries.

/** A uniform random source in [0, 1), e.g. from `mulberry32`. */
export type RandomFn = () => number;

/** Rendered audio of a generator: a mono buffer or one buffer per channel. */
export type SoundOutput = Float32Array | Float32Array[];

/** Incremental generator: each bare `yield` is a slice point; the return value is the audio. */
export type SoundIterator = Generator<unknown, SoundOutput, unknown>;

/**
 * Sound generator: `(sampleRate, rng, variant)` -> audio, either synchronously or as an
 * incremental `function*` generator that is stepped across frames.
 */
export type SoundGenerator = (
  sampleRate: number,
  rng: RandomFn,
  variant: number
) => SoundOutput | SoundIterator;

/** Mixer bus a one-shot sound plays on. */
export type SoundBus = 'gun' | 'tail' | 'music' | (string & {});

/** One entry of the sound-definition table (`SOUNDS` in soundTable.ts). */
export interface SoundDef {
  /** Generator producing the audio. */
  gen: SoundGenerator;
  /** Number of variants to render (variant index is `i % n`). */
  n: number;
  /** Sample rate to render at. */
  sr: number;
  /** Target peak after normalization. */
  peak: number;
  /** If set, only attenuate down to `peak` (never boost). */
  fixed?: number;
  /** Looping sound (no edge fades). */
  loop?: number;
  /** Music loop stem. */
  music?: number;
  /** Impulse response for a convolver (short edge fades). */
  ir?: number;
  /** Render during boot. */
  boot?: number;
  /** Soft voice stealing (fade instead of cut). */
  soft?: number;
  /** Mixer bus. */
  bus?: SoundBus;
  /** Max simultaneous voices. */
  max?: number;
  /** Voice priority. */
  pri?: number;
  /** Panner reference distance. */
  ref?: number;
  /** Panner rolloff factor. */
  roll?: number;
}

/** Biquad filter type: low-pass, high-pass or (constant 0 dB peak) band-pass. */
export type BiquadType = 'lp' | 'hp' | 'bp';

/** Normalized biquad coefficients `[b0, b1, b2, a1, a2]`. */
export type BiquadCoeffs = [number, number, number, number, number];

/** A modal partial: `[frequency Hz, decay time constant s, amplitude]`. */
export type ModalPartial = [number, number, number];

/** Options for `noiseBurst` / `crackleBurst` filtering. */
export interface NoiseFilterOpts {
  hp?: number;
  lp?: number;
  bp?: number;
  /** Band-pass Q. */
  q?: number;
}

export interface NoiseBurstOpts extends NoiseFilterOpts {
  /** Attack time constant (s). */
  att?: number;
}

export interface CrackleOpts extends NoiseFilterOpts {
  /** Earliest crackle time (s). */
  from?: number;
  /** Exponent biasing crackle times towards the start. */
  fall?: number;
  minLen?: number;
  maxLen?: number;
  /** Amplitude decay time constant over the burst (s). */
  ampFall?: number;
}

export interface MetalClickOpts {
  /** Frequency jitter amount (default 0.02). */
  jit?: number;
  /** Ring level (default 0.6). */
  ring?: number;
  /** Tick level (default 0.7, 0 disables). */
  tick?: number;
  tickTau?: number;
  /** Tick high-pass (default 2500). */
  hp?: number;
}

export interface FrictionScrapeOpts {
  q?: number;
  /** Roughness rate (grains/s) at the start. */
  rough?: number;
  /** Roughness rate at the end. */
  rough1?: number;
  curve?: number;
  /** Level of an extra upper band. */
  hi?: number;
  /** Envelope over normalized time 0..1. */
  env?: (t: number) => number;
}

/** Function of normalized time / position (0..1). */
export type CurveFn = (t: number) => number;

export const TWO_PI = Math.PI * 2;

/** Seeded 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): RandomFn {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 1831565813) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a hash of a string. */
export function fnv1aHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Zeroed buffer of `seconds` at `sampleRate` (at least 1 sample). */
export const allocSamples = (sampleRate: number, seconds: number): Float32Array =>
  new Float32Array(Math.max(1, Math.round(sampleRate * seconds)));
/** Uniform random value in [min, max). */
export const randRange = (rng: RandomFn, min: number, max: number): number =>
  min + (max - min) * rng();
/** MIDI note number to frequency in Hz. */
export const midiToFreq = (note: number): number => 440 * Math.pow(2, (note - 69) / 12);

/** White noise in [-1, 1). */
export function noiseBuffer(sampleRate: number, seconds: number, rng: RandomFn): Float32Array {
  const buf = allocSamples(sampleRate, seconds);
  for (let i = 0; i < buf.length; i++) buf[i] = rng() * 2 - 1;
  return buf;
}

/** RBJ biquad coefficients (frequency clamped to [10, 0.47 * sampleRate]). */
export function biquadCoeffs(
  type: BiquadType,
  freq: number,
  q: number,
  sampleRate: number
): BiquadCoeffs {
  const w0 = (TWO_PI * Math.max(10, Math.min(freq, sampleRate * 0.47))) / sampleRate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const alpha = sinW / (2 * q);
  let b0: number;
  let b1: number;
  let b2: number;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW;
  const a2 = 1 - alpha;
  if (type === 'lp') {
    b0 = (1 - cosW) / 2;
    b1 = 1 - cosW;
    b2 = b0;
  } else if (type === 'hp') {
    b0 = (1 + cosW) / 2;
    b1 = -(1 + cosW);
    b2 = b0;
  } else {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** Filters `buf` in place with a static biquad (transposed direct form II). */
export function biquad(
  buf: Float32Array,
  type: BiquadType,
  freq: number,
  q: number,
  sampleRate: number
): Float32Array {
  const [b0, b1, b2, a1, a2] = biquadCoeffs(type, freq, q, sampleRate);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    buf[i] = y;
  }
  return buf;
}

/**
 * Time-varying biquad: `freqAt(pos)` / `qAt(pos)` give frequency and Q over normalized position,
 * coefficients are refreshed every 32 samples. With `passes > 1` the filter state carries over
 * between passes (via `biquadSweep.z1/z2`) and only the last pass writes the output.
 */
export function biquadSweep(
  buf: Float32Array,
  type: BiquadType,
  freqAt: CurveFn,
  qAt: number | CurveFn,
  sampleRate: number,
  passes = 1
): Float32Array {
  const len = buf.length;
  for (let pass = 0; pass < passes; pass++) {
    let z1 = 0;
    let z2 = 0;
    // Always assigned at i === 0 before use.
    let coeffs: BiquadCoeffs = [0, 0, 0, 0, 0];
    if (pass > 0) {
      z1 = biquadSweep.z1;
      z2 = biquadSweep.z2;
    }
    const out = pass === passes - 1 ? buf : null;
    for (let i = 0; i < len; i++) {
      if ((i & 31) === 0) {
        coeffs = biquadCoeffs(
          type,
          freqAt(i / len),
          typeof qAt == 'function' ? qAt(i / len) : qAt,
          sampleRate
        );
      }
      const x = buf[i];
      const y = coeffs[0] * x + z1;
      z1 = coeffs[1] * x - coeffs[3] * y + z2;
      z2 = coeffs[2] * x - coeffs[4] * y;
      if (out) out[i] = y;
    }
    biquadSweep.z1 = z1;
    biquadSweep.z2 = z2;
  }
  return buf;
}
// Filter state carried between passes (always written before being read).
biquadSweep.z1 = 0;
biquadSweep.z2 = 0;

/** Exponential ramp from `from` to `to` over normalized time, with optional curve exponent. */
export const expRamp =
  (from: number, to: number, curve = 1): CurveFn =>
  (t) =>
    from * Math.pow(to / from, Math.pow(t, curve));

/** Multiplies `buf` by `env(seconds)`. */
export function applyEnvelope(buf: Float32Array, sampleRate: number, env: CurveFn): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] *= env(i / sampleRate);
  return buf;
}

/** Exponential decay envelope over seconds, with optional exponential attack. */
export const expDecay = (tau: number, attack = 0): CurveFn =>
  attack > 0 ? (t) => (1 - Math.exp(-t / attack)) * Math.exp(-t / tau) : (t) => Math.exp(-t / tau);

/** Adds `src * gain` into `dst` starting at `offsetSec` (clipped at both ends). */
export function mixInto(
  dst: Float32Array,
  src: Float32Array,
  offsetSec: number,
  gain: number,
  sampleRate: number
): Float32Array {
  const offset = Math.round(offsetSec * sampleRate);
  const end = Math.min(src.length, dst.length - offset);
  for (let i = Math.max(0, -offset); i < end; i++) dst[offset + i] += src[i] * gain;
  return dst;
}

/** Like `mixInto` but wraps around the end of `dst` (for loops). */
export function mixIntoWrapped(
  dst: Float32Array,
  src: Float32Array,
  offsetSec: number,
  gain: number,
  sampleRate: number
): Float32Array {
  const len = dst.length;
  let pos = Math.round(offsetSec * sampleRate) % len;
  if (pos < 0) pos += len;
  for (let i = 0; i < src.length; i++) {
    dst[pos] += src[i] * gain;
    if (++pos >= len) pos = 0;
  }
  return dst;
}

/** Maximum absolute sample value. */
export function peakAbs(buf: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Multiplies `buf` by `gain` in place. */
export function scaleBuffer(buf: Float32Array, gain: number): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] *= gain;
  return buf;
}

/** Normalized tanh saturation (unity at full scale). */
export function softClip(buf: Float32Array, drive: number): Float32Array {
  const norm = 1 / Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) * norm;
  return buf;
}

/** Linear fade-in and quadratic fade-out of the given durations (s). */
export function fadeEdges(
  buf: Float32Array,
  sampleRate: number,
  fadeIn: number,
  fadeOut: number
): Float32Array {
  const inLen = Math.min(buf.length >> 1, Math.round(fadeIn * sampleRate));
  const outLen = Math.min(buf.length >> 1, Math.round(fadeOut * sampleRate));
  for (let i = 0; i < inLen; i++) buf[i] *= i / inLen;
  for (let i = 0; i < outLen; i++) {
    const g = i / outLen;
    buf[buf.length - 1 - i] *= g * g;
  }
  return buf;
}

/** Filtered, exponentially decaying noise burst normalized to peak 1. */
export function noiseBurst(
  sampleRate: number,
  rng: RandomFn,
  seconds: number,
  tau: number,
  opts: NoiseBurstOpts = {}
): Float32Array {
  const buf = noiseBuffer(sampleRate, seconds, rng);
  if (opts.hp) biquad(buf, 'hp', opts.hp, 0.707, sampleRate);
  if (opts.lp) biquad(buf, 'lp', opts.lp, 0.707, sampleRate);
  if (opts.bp) biquad(buf, 'bp', opts.bp, opts.q || 1, sampleRate);
  applyEnvelope(buf, sampleRate, expDecay(tau, opts.att || 0));
  const peak = peakAbs(buf);
  return peak > 0 ? scaleBuffer(buf, 1 / peak) : buf;
}

/** Sine whose pitch drops exponentially from `f0` to `f1` (kick/thump). */
export function pitchDropSine(
  sampleRate: number,
  seconds: number,
  f0: number,
  f1: number,
  pitchTau: number,
  ampTau: number,
  attack = 6e-4
): Float32Array {
  const buf = allocSamples(sampleRate, seconds);
  let phase = 0;
  for (let i = 0; i < buf.length; i++) {
    const t = i / sampleRate;
    phase += (TWO_PI * (f1 + (f0 - f1) * Math.exp(-t / pitchTau))) / sampleRate;
    buf[i] = Math.sin(phase) * Math.exp(-t / ampTau) * (1 - Math.exp(-t / attack));
  }
  return buf;
}

/** Exponential sine sweep from `f0` to `f1`, optionally with a half-sine window. */
export function chirp(
  sampleRate: number,
  seconds: number,
  f0: number,
  f1: number,
  windowed = true
): Float32Array {
  const buf = allocSamples(sampleRate, seconds);
  let phase = 0;
  const len = buf.length;
  for (let i = 0; i < len; i++) {
    const pos = i / len;
    phase += (TWO_PI * f0 * Math.pow(f1 / f0, pos)) / sampleRate;
    buf[i] = Math.sin(phase) * (windowed ? Math.sin(Math.PI * pos) : 1);
  }
  return buf;
}

/** Sum of decaying sinusoidal modes (impact ring); random phases if `rng` is given. */
export function modalResonators(
  sampleRate: number,
  seconds: number,
  partials: readonly ModalPartial[],
  rng?: RandomFn | null
): Float32Array {
  const buf = allocSamples(sampleRate, seconds);
  for (const [freq, decay, amp] of partials) {
    if (freq > sampleRate * 0.46) continue;
    const w = (TWO_PI * freq) / sampleRate;
    const phase = rng ? rng() * TWO_PI : 0;
    const r = Math.exp(-1 / (decay * sampleRate));
    const c1 = 2 * r * Math.cos(w);
    const c2 = r * r;
    const len = Math.min(
      buf.length,
      Math.ceil(Math.log(1e-5 / Math.max(amp, 1e-5)) / Math.log(r)) + 1
    );
    let prev = (amp / r) * Math.sin(phase - w);
    let cur = amp * Math.sin(phase);
    for (let i = 0; i < len; i++) {
      buf[i] += cur;
      const next = c1 * cur - c2 * prev;
      prev = cur;
      cur = next;
    }
  }
  const rampLen = Math.min(buf.length, Math.round(4e-4 * sampleRate));
  for (let i = 0; i < rampLen; i++) buf[i] *= i / rampLen;
  return buf;
}

/** Random short decaying noise grains (crackle, debris). */
export function crackleBurst(
  sampleRate: number,
  rng: RandomFn,
  seconds: number,
  count: number,
  opts: CrackleOpts = {}
): Float32Array {
  const buf = allocSamples(sampleRate, seconds);
  const from = opts.from || 0;
  const fall = opts.fall || 1;
  for (let k = 0; k < count; k++) {
    const t = from + (seconds - from - 0.02) * Math.pow(rng(), fall);
    const start = Math.round(t * sampleRate);
    const len = Math.round(randRange(rng, opts.minLen || 0.001, opts.maxLen || 0.004) * sampleRate);
    const amp = randRange(rng, 0.2, 1) * (opts.ampFall ? Math.exp(-t / opts.ampFall) : 1);
    for (let i = 0; i < len && start + i < buf.length; i++) {
      buf[start + i] += (rng() * 2 - 1) * amp * Math.exp((-4 * i) / len);
    }
  }
  if (opts.hp) biquad(buf, 'hp', opts.hp, 0.707, sampleRate);
  if (opts.lp) biquad(buf, 'lp', opts.lp, 0.707, sampleRate);
  if (opts.bp) biquad(buf, 'bp', opts.bp, opts.q || 1, sampleRate);
  return buf;
}

/** Makes a seamless loop: the `buf.length - loopLen` overhang is crossfaded into the start. */
export function crossfadeLoop(
  buf: Float32Array,
  loopLen: number,
  equalPower?: boolean
): Float32Array {
  const fadeLen = buf.length - loopLen;
  const out = new Float32Array(loopLen);
  out.set(buf.subarray(0, loopLen));
  for (let i = 0; i < fadeLen; i++) {
    const pos = (i + 0.5) / fadeLen;
    const gainIn = equalPower ? Math.sin((pos * Math.PI) / 2) : pos;
    const gainOut = equalPower ? Math.cos((pos * Math.PI) / 2) : 1 - pos;
    out[i] = buf[i] * gainIn + buf[loopLen + i] * gainOut;
  }
  return out;
}

/** Loopable noise of `seconds`, processed in place by `process` before crossfading. */
export function loopedNoise(
  sampleRate: number,
  seconds: number,
  rng: RandomFn,
  process: (buf: Float32Array) => unknown,
  overlap = 0.4
): Float32Array {
  const buf = noiseBuffer(sampleRate, seconds + overlap, rng);
  process(buf);
  return crossfadeLoop(buf, Math.round(sampleRate * seconds), true);
}

/** Sum of `[buffer, gain]` pairs into a new buffer of `length` samples. */
export function mixBuffers(length: number, ...parts: [Float32Array, number][]): Float32Array {
  const out = new Float32Array(length);
  for (const [buf, gain] of parts) {
    for (let i = 0; i < Math.min(length, buf.length); i++) out[i] += buf[i] * gain;
  }
  return out;
}

/** Scales `buf` in place to the given peak (if non-silent). */
export const normalize = (buf: Float32Array, peak = 1): Float32Array => {
  const current = peakAbs(buf);
  return current > 0 ? scaleBuffer(buf, peak / current) : buf;
};

/** Friedlander blast-wave pressure pulse with positive-phase duration `tPlus` (s). */
export function friedlanderPulse(sampleRate: number, tPlus: number): Float32Array {
  const buf = allocSamples(sampleRate, tPlus * 12);
  for (let i = 0; i < buf.length; i++) {
    const x = i / sampleRate / tPlus;
    buf[i] = (1 - x) * Math.exp(-x);
  }
  return buf;
}

/** Simple feed-forward peak compressor (in place). */
export function compressBuffer(
  buf: Float32Array,
  sampleRate: number,
  threshold: number,
  ratio: number,
  attack: number,
  release: number
): Float32Array {
  const attackCoef = Math.exp(-1 / (attack * sampleRate));
  const releaseCoef = Math.exp(-1 / (release * sampleRate));
  const exponent = 1 / ratio - 1;
  let env = 0;
  for (let i = 0; i < buf.length; i++) {
    const level = Math.abs(buf[i]);
    env =
      level > env
        ? attackCoef * env + (1 - attackCoef) * level
        : releaseCoef * env + (1 - releaseCoef) * level;
    if (env > threshold) buf[i] *= Math.pow(env / threshold, exponent);
  }
  return buf;
}

/** Feedback comb filter mixed in place with `wet` amount. */
function feedbackComb(
  buf: Float32Array,
  sampleRate: number,
  delaySec: number,
  feedback: number,
  wet = 1
): Float32Array {
  const delay = Math.max(1, Math.round(delaySec * sampleRate));
  const combed = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++)
    combed[i] = buf[i] + (i >= delay ? combed[i - delay] * feedback : 0);
  const norm = 1 - feedback * 0.5;
  for (let i = 0; i < buf.length; i++) buf[i] = buf[i] * (1 - wet) + combed[i] * norm * wet;
  return buf;
}

/** Metallic click: jittered modal ring plus a high-passed noise tick. */
export function metalClick(
  sampleRate: number,
  rng: RandomFn,
  partials: readonly ModalPartial[],
  opts: MetalClickOpts = {}
): Float32Array {
  let longestDecay = 0.004;
  for (const partial of partials) longestDecay = Math.max(longestDecay, partial[1]);
  const buf = allocSamples(sampleRate, Math.min(0.5, longestDecay * 7 + 0.004));
  const jitter = opts.jit == null ? 0.02 : opts.jit;
  mixInto(
    buf,
    modalResonators(
      sampleRate,
      buf.length / sampleRate,
      partials.map(([freq, decay, amp]): ModalPartial => [
        freq * (1 + (rng() * 2 - 1) * jitter),
        decay,
        amp
      ]),
      rng
    ),
    0,
    opts.ring == null ? 0.6 : opts.ring,
    sampleRate
  );
  if (opts.tick !== 0) {
    mixInto(
      buf,
      noiseBurst(sampleRate, rng, 0.006, opts.tickTau || 9e-4, {
        hp: opts.hp || 2500
      }),
      0,
      opts.tick == null ? 0.7 : opts.tick,
      sampleRate
    );
  }
  return buf;
}

/** Band-pass swept noise with random roughness grains (sliding/scraping). */
export function frictionScrape(
  sampleRate: number,
  rng: RandomFn,
  seconds: number,
  f0: number,
  f1: number,
  opts: FrictionScrapeOpts = {}
): Float32Array {
  const buf = noiseBuffer(sampleRate, seconds, rng);
  const q = opts.q || 1.8;
  const rough0 = opts.rough || 200;
  const rough1 = opts.rough1 || rough0;
  const len = buf.length;
  biquadSweep(buf, 'bp', expRamp(f0, f1, opts.curve || 1), q, sampleRate);
  if (opts.hi) {
    const upper = noiseBuffer(sampleRate, seconds, rng);
    biquadSweep(upper, 'bp', expRamp(f0 * 2.37, f1 * 2.37, opts.curve || 1), q * 1.5, sampleRate);
    for (let i = 0; i < len; i++) buf[i] += upper[i] * opts.hi;
  }
  let level = 0.5;
  let target = 0.5;
  let nextGrain = 0;
  const env = opts.env || ((t: number) => Math.sin(Math.PI * Math.pow(t, 0.7)));
  for (let i = 0; i < len; i++) {
    const pos = i / len;
    if (i >= nextGrain) {
      target = 0.2 + rng() * 0.8;
      nextGrain = i + (sampleRate / (rough0 + (rough1 - rough0) * pos)) * (0.6 + rng() * 0.8);
    }
    level += (target - level) * 0.03;
    buf[i] *= level * env(pos);
  }
  return normalize(buf);
}

/** Fabric/foliage rustle: swept band noise with random grain and flutter modulation. */
export function rustleNoise(
  sampleRate: number,
  rng: RandomFn,
  seconds: number,
  f0: number,
  f1: number,
  env: CurveFn
): Float32Array {
  const buf = noiseBuffer(sampleRate, seconds, rng);
  const len = buf.length;
  biquadSweep(buf, 'bp', expRamp(f0, f1), 0.7, sampleRate);
  const low = noiseBuffer(sampleRate, seconds, rng);
  biquad(low, 'lp', 420, 0.7, sampleRate);
  let level = 0.4;
  let target = 0.6;
  let nextGrain = 0;
  let flutter = 0.5;
  let flutterTarget = 0.5;
  for (let i = 0; i < len; i++) {
    const pos = i / len;
    if (i >= nextGrain) {
      target = 0.15 + rng() * 0.85;
      nextGrain = i + sampleRate * (0.006 + rng() * 0.016);
    }
    if ((i & 63) === 0) flutterTarget = 0.5 + rng() * 0.5;
    level += (target - level) * 0.004;
    flutter += (flutterTarget - flutter) * 0.05;
    buf[i] = (buf[i] * level * flutter + low[i] * 0.9 * level) * env(pos);
  }
  return normalize(buf);
}

/** DC-blocking high-pass (in place). */
export const dcBlock = (buf: Float32Array, sampleRate: number, freq = 28): Float32Array =>
  biquad(buf, 'hp', freq, 0.707, sampleRate);

/** Ducks everything after `onsetSec` towards `floor` with time constant `tau`. */
export function duckAfterOnset(
  buf: Float32Array,
  sampleRate: number,
  onsetSec: number,
  floor = 0.72,
  tau = 0.0012
): Float32Array {
  for (let i = 0; i < buf.length; i++) {
    buf[i] *= floor + (1 - floor) * Math.exp(-Math.max(0, i / sampleRate - onsetSec) / tau);
  }
  return buf;
}

/** Triangle-ish envelope over normalized time peaking at `peakPos`, with exponent. */
export const peakEnvelope =
  (peakPos: number, exponent = 1): CurveFn =>
  (t) =>
    Math.pow(t < peakPos ? t / peakPos : (1 - t) / (1 - peakPos), exponent);

/** Noise layer of a gunshot: `[hpHz, lpHz, holdLevel, transientLevel, transientTau]`. */
export type GunshotLayer = [number, number, number, number, number];

/** Mechanical click of a gunshot: `[timeSec, gain, partials, tickHighpassHz]`. */
export type GunshotMech = [number, number, ModalPartial[], number];

/** Parameters of the `synthGunshot` model. */
export interface GunshotParams {
  len: number;
  /** Number of variants. */
  n: number;
  /** Per-variant pitch factor. */
  pitch: number[];
  /** Per-variant brightness factor. */
  bright: number[];
  layers: GunshotLayer[];
  hold: number;
  holdTau: number;
  drive: number;
  tPlus: number;
  blast: number;
  f0: number;
  f1: number;
  tauF: number;
  tauA: number;
  thump: number;
  lpEnd: number;
  lpMid: number;
  lpMidTau: number;
  lpTop: number;
  lpTopTau: number;
  shelfF: number;
  shelf: number;
  plateau: number;
  reDrive: number;
  mech: GunshotMech[];
  spring: ModalPartial[];
  springG: number;
}

export const RIFLE_SHOT: GunshotParams = {
  len: 0.64,
  n: 5,
  pitch: [1, 0.965, 1.035, 0.985, 1.018],
  bright: [1, 1.07, 0.94, 1.04, 0.97],
  layers: [
    [85, 220, 1.75, 0.115, 0.125],
    [220, 950, 2.2, 0.1, 0.052],
    [950, 5e3, 1.5, 0.055, 0.026]
  ],
  hold: 0.022,
  holdTau: 0.0095,
  drive: 1.6,
  tPlus: 4e-4,
  blast: 2.5,
  f0: 150,
  f1: 62,
  tauF: 0.03,
  tauA: 0.055,
  thump: 0.2,
  lpEnd: 800,
  lpMid: 2600,
  lpMidTau: 0.07,
  lpTop: 15e3,
  lpTopTau: 0.0028,
  shelfF: 230,
  shelf: 0.55,
  plateau: 0.8,
  reDrive: 1.5,
  mech: [
    [
      0.021,
      0.05,
      [
        [2180, 0.007, 1],
        [3460, 0.006, 0.7],
        [1840, 0.009, 0.5]
      ],
      3e3
    ],
    [
      0.058,
      0.07,
      [
        [1930, 0.009, 1],
        [2910, 0.007, 0.75],
        [4380, 0.005, 0.5],
        [860, 0.014, 0.4]
      ],
      2400
    ]
  ],
  spring: [
    [706, 0.055, 1],
    [1418, 0.035, 0.4]
  ],
  springG: 0.02
};

export const PISTOL_SHOT: GunshotParams = {
  len: 0.44,
  n: 4,
  pitch: [1, 1.04, 0.962, 1.02],
  bright: [1, 0.95, 1.06, 1.02],
  layers: [
    [100, 270, 1.3, 0.16, 0.055],
    [270, 1400, 2.2, 0.2, 0.038],
    [1400, 5500, 1.8, 0.12, 0.016]
  ],
  hold: 0.01,
  holdTau: 0.005,
  drive: 1.5,
  tPlus: 45e-5,
  blast: 2.5,
  f0: 230,
  f1: 105,
  tauF: 0.014,
  tauA: 0.028,
  thump: 0.25,
  lpEnd: 1e3,
  lpMid: 2200,
  lpMidTau: 0.04,
  lpTop: 15e3,
  lpTopTau: 0.0024,
  shelfF: 260,
  shelf: 0.2,
  plateau: 0.78,
  reDrive: 1.5,
  mech: [
    [
      0.016,
      0.09,
      [
        [2920, 0.006, 1],
        [4410, 0.005, 0.8],
        [1650, 0.007, 0.4]
      ],
      3400
    ],
    [
      0.046,
      0.12,
      [
        [3380, 0.008, 1],
        [5180, 0.007, 0.8],
        [1230, 0.01, 0.35]
      ],
      3e3
    ]
  ],
  spring: [
    [1180, 0.02, 1],
    [2390, 0.012, 0.4]
  ],
  springG: 0.015
};

/** Dry gunshot: layered filtered noise, thump, blast pulse, saturation, mechanism clicks. */
function synthGunshot(
  sampleRate: number,
  rng: RandomFn,
  variant: number,
  params: GunshotParams
): Float32Array {
  const variantIndex = variant % params.n;
  const pitch = params.pitch[variantIndex];
  const bright = params.bright[variantIndex];
  const startSec = 5e-4;
  const out = allocSamples(sampleRate, params.len);
  const bodyLen = out.length - Math.round(0.004 * sampleRate);
  const body = new Float32Array(bodyLen);
  for (const [hpFreq, lpFreq, holdLevel, transientLevel, transientTau] of params.layers) {
    const layer = new Float32Array(bodyLen);
    for (let i = 0; i < bodyLen; i++) layer[i] = rng() * 2 - 1;
    biquad(layer, 'hp', hpFreq * pitch, 0.707, sampleRate);
    biquad(layer, 'hp', hpFreq * pitch, 0.707, sampleRate);
    biquad(layer, 'lp', lpFreq * pitch * bright, 0.707, sampleRate);
    let energy = 0;
    const measureLen = Math.min(bodyLen, Math.round(0.12 * sampleRate));
    for (let i = 0; i < measureLen; i++) energy += layer[i] * layer[i];
    const rmsNorm = 1 / Math.sqrt(energy / measureLen + 1e-12);
    const transientCoef = Math.exp(-1 / (transientTau * sampleRate));
    const holdCoef = Math.exp(-1 / (params.holdTau * sampleRate));
    const holdSamples = Math.round(params.hold * sampleRate);
    let transient = transientLevel;
    let hold = holdLevel;
    for (let i = 0; i < bodyLen; i++) {
      body[i] += layer[i] * rmsNorm * (hold + transient);
      transient *= transientCoef;
      if (i >= holdSamples) hold *= holdCoef;
    }
  }
  mixInto(
    body,
    pitchDropSine(
      sampleRate,
      0.3,
      params.f0 * pitch,
      params.f1 * pitch,
      params.tauF,
      params.tauA,
      0.001
    ),
    0,
    params.thump,
    sampleRate
  );
  mixInto(body, friedlanderPulse(sampleRate, params.tPlus / pitch), 0, params.blast, sampleRate);
  for (let i = 0; i < bodyLen; i++) body[i] = Math.tanh(body[i] * params.drive);
  const cutoffAt = (pos: number): number => {
    const t = (pos * bodyLen) / sampleRate;
    return (
      (params.lpEnd + params.lpMid * Math.exp(-t / params.lpMidTau)) * bright +
      params.lpTop * Math.exp(-t / params.lpTopTau)
    );
  };
  biquadSweep(body, 'lp', cutoffAt, 0.6, sampleRate);
  biquadSweep(body, 'lp', cutoffAt, 0.6, sampleRate);
  const shelf = Float32Array.from(body);
  biquad(shelf, 'lp', params.shelfF, 0.707, sampleRate);
  for (let i = 0; i < bodyLen; i++) body[i] += shelf[i] * params.shelf;
  dcBlock(body, sampleRate, 30);
  {
    let energy = 0;
    const from = Math.round(0.004 * sampleRate);
    const to = Math.round((params.hold + 0.004) * sampleRate);
    for (let i = from; i < to; i++) energy += body[i] * body[i];
    scaleBuffer(body, params.plateau / Math.sqrt(energy / (to - from) + 1e-12));
  }
  softClip(body, params.reDrive);
  mixInto(out, body, startSec, 1, sampleRate);
  for (let m = 0; m < params.mech.length; m++) {
    const [time, gain, partials, tickHp] = params.mech[m];
    const clickTime = startSec + time * randRange(rng, 0.94, 1.06);
    mixInto(
      out,
      metalClick(
        sampleRate,
        rng,
        partials.map(([freq, decay, amp]): ModalPartial => [freq * pitch, decay, amp]),
        {
          hp: tickHp,
          tick: 0.6,
          ring: 0.7
        }
      ),
      clickTime,
      gain,
      sampleRate
    );
    if (m === params.mech.length - 1) {
      mixInto(
        out,
        modalResonators(
          sampleRate,
          0.22,
          params.spring.map(([freq, decay, amp]): ModalPartial => [freq * pitch, decay, amp]),
          rng
        ),
        clickTime + 0.002,
        params.springG,
        sampleRate
      );
    }
  }
  return out;
}

export const synthRifleShot = (sampleRate: number, rng: RandomFn, variant: number): Float32Array =>
  synthGunshot(sampleRate, rng, variant, RIFLE_SHOT);
export const synthPistolShot = (sampleRate: number, rng: RandomFn, variant: number): Float32Array =>
  synthGunshot(sampleRate, rng, variant, PISTOL_SHOT);
/** Decibels to linear gain. */
export const dbToGain = (db: number): number => Math.pow(10, db / 20);
/** Soft limiter `ceil * tanh(x / ceil)` (in place). */
export const tanhLimit = (buf: Float32Array, ceil: number): Float32Array => {
  for (let i = 0; i < buf.length; i++) buf[i] = ceil * Math.tanh(buf[i] / ceil);
  return buf;
};
/** RMS of `buf[from, to)` (indices truncated to integers and clamped). */
export const rmsRange = (buf: Float32Array, from: number, to: number): number => {
  let sum = 0;
  from = Math.max(0, from | 0);
  to = Math.min(buf.length, to | 0);
  for (let i = from; i < to; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / Math.max(1, to - from));
};

/** Highest 10 ms windowed RMS (2 ms hop). */
function maxWindowRms(buf: Float32Array, sampleRate: number): number {
  const windowLen = Math.round(0.01 * sampleRate);
  const hop = Math.round(0.002 * sampleRate);
  let max = 0;
  for (let i = 0; i + windowLen <= buf.length; i += hop) {
    max = Math.max(max, rmsRange(buf, i, i + windowLen));
  }
  return max;
}

/** Outdoor slapback echo: `[timeSec, dB, lowpassHz, pan, combDelayMs]`. */
export type SlapbackEcho = [number, number, number, number, number];

/** Parameters of the outdoor gunshot tail (slapbacks, diffuse floor, far echo, rumble). */
export interface OutdoorTailParams {
  len: number;
  ref: number;
  ceil: number;
  /** Slapback sets, chosen by `variant % slaps.length`. */
  slaps: SlapbackEcho[][];
  slapHold: number;
  slapTau: number;
  lp0: number;
  lp1: number;
  early: number;
  earlyTau: number;
  floor: number;
  lateT: number;
  farT: number;
  far: number;
  rumble: number;
}

/** Parameters of the indoor gunshot tail (early reflections, flutter, room modes). */
export interface IndoorTailParams {
  len: number;
  ref: number;
  ceil: number;
  lp0: number;
  lp1: number;
  tau: number;
  early: number;
  level: number;
  modes: number;
}

/** Stereo outdoor reverb tail for a gunshot. */
function synthOutdoorTail(
  sampleRate: number,
  rng: RandomFn,
  variant: number,
  params: OutdoorTailParams
): Float32Array[] {
  const seed = Math.floor(rng() * 1e9);
  const tailRng = mulberry32(seed);
  const len = params.len;
  const ref = params.ref;
  const slaps = params.slaps[variant % params.slaps.length].map(
    ([time, db, lpFreq, pan, combMs]) => {
      const slap = noiseBuffer(sampleRate, 0.16, tailRng);
      biquad(slap, 'hp', 300, 0.7, sampleRate);
      biquad(slap, 'lp', lpFreq, 0.7, sampleRate);
      applyEnvelope(
        slap,
        sampleRate,
        (t) =>
          (1 - Math.exp(-t / 0.002)) *
          (t < params.slapHold ? 1 : Math.exp(-(t - params.slapHold) / params.slapTau))
      );
      normalize(slap);
      feedbackComb(slap, sampleRate, combMs / 1e3, 0.5, 0.7);
      mixInto(
        slap,
        modalResonators(
          sampleRate,
          0.1,
          [
            [randRange(tailRng, 110, 190), 0.05, 1],
            [randRange(tailRng, 240, 420), 0.035, 0.6]
          ],
          tailRng
        ),
        0.002,
        0.12,
        sampleRate
      );
      return {
        b: scaleBuffer(slap, (ref * dbToGain(db)) / maxWindowRms(slap, sampleRate)),
        t: time - 0.007,
        pan
      };
    }
  );
  const sharedNoise = noiseBuffer(sampleRate, len, tailRng);
  const farEcho = noiseBurst(sampleRate, tailRng, 0.6, 0.14, {
    hp: 80,
    lp: 650,
    att: 0.04
  });
  scaleBuffer(farEcho, (ref * dbToGain(params.far)) / maxWindowRms(farEcho, sampleRate));
  const rumble = noiseBuffer(sampleRate, len - 0.1, tailRng);
  biquad(rumble, 'lp', 130, 0.7, sampleRate);
  biquad(rumble, 'hp', 34, 0.7, sampleRate);
  applyEnvelope(
    rumble,
    sampleRate,
    (t) => (1 - Math.exp(-t / 0.05)) * Math.exp(-Math.pow(t / params.lateT, 2))
  );
  scaleBuffer(
    rumble,
    (ref * dbToGain(params.rumble)) / rmsRange(rumble, 0.1 * sampleRate, 0.3 * sampleRate)
  );
  const measureFrom = Math.round(0.1 * sampleRate);
  const measureTo = Math.round(0.2 * sampleRate);
  const renderChannel = (channel: number): Float32Array => {
    const channelRng = mulberry32(seed + 101 + channel * 977);
    const out = allocSamples(sampleRate, len);
    const side = channel ? 1 : -1;
    const channelNoise = noiseBuffer(sampleRate, len, channelRng);
    const late = allocSamples(sampleRate, len);
    for (let i = 0; i < late.length; i++) late[i] = sharedNoise[i] * 0.72 + channelNoise[i] * 0.68;
    biquadSweep(late, 'lp', expRamp(params.lp0, params.lp1, 0.55), 0.6, sampleRate);
    biquad(late, 'hp', 140, 0.7, sampleRate);
    const early = Float32Array.from(late);
    applyEnvelope(
      early,
      sampleRate,
      (t) => (1 - Math.exp(-t / 0.003)) * Math.exp(-t / params.earlyTau)
    );
    applyEnvelope(
      late,
      sampleRate,
      (t) => (1 - Math.exp(-t / 0.03)) * Math.exp(-Math.pow(t / params.lateT, 2))
    );
    mixInto(
      out,
      early,
      0.004,
      (ref * dbToGain(params.early)) / rmsRange(early, 0, 0.05 * sampleRate),
      sampleRate
    );
    mixInto(
      out,
      late,
      0.004,
      (ref * dbToGain(params.floor)) / rmsRange(late, measureFrom, measureTo),
      sampleRate
    );
    for (const slap of slaps) {
      mixInto(
        out,
        slap.b,
        slap.t + (slap.pan * side > 0 ? 0 : Math.abs(slap.pan) * 9e-4),
        1 + 0.4 * slap.pan * side,
        sampleRate
      );
    }
    mixInto(out, farEcho, params.farT + (channel ? 7e-4 : 0), channel ? 0.85 : 1.1, sampleRate);
    mixInto(out, rumble, 0.03, 1, sampleRate);
    return tanhLimit(out, params.ceil);
  };
  return [renderChannel(0), renderChannel(1)];
}

/** Stereo indoor (shed) reverb tail for a gunshot. */
function synthIndoorTail(
  sampleRate: number,
  rng: RandomFn,
  variant: number,
  params: IndoorTailParams
): Float32Array[] {
  const seed = Math.floor(rng() * 1e9);
  const tailRng = mulberry32(seed);
  const len = params.len;
  const ref = params.ref;
  const sharedNoise = noiseBuffer(sampleRate, len, tailRng);
  const reflectionCount = 18;
  // [timeSec, gain, pan, lowpassHz]
  const reflections: [number, number, number, number][] = [];
  for (let k = 0; k < reflectionCount; k++) {
    reflections.push([
      0.006 + 0.085 * Math.pow((k + tailRng()) / reflectionCount, 1.3),
      Math.pow(0.9, k) * randRange(tailRng, 0.6, 1.1),
      tailRng() * 2 - 1,
      randRange(tailRng, 3200, 7500)
    ]);
  }
  const flutterPeriod = variant & 1 ? 0.051 : 0.046;
  const measureFrom = Math.round(0.1 * sampleRate);
  const measureTo = Math.round(0.2 * sampleRate);
  const renderChannel = (channel: number): Float32Array => {
    const channelRng = mulberry32(seed + 211 + channel * 613);
    const out = allocSamples(sampleRate, len);
    const side = channel ? 1 : -1;
    const earlyBuf = allocSamples(sampleRate, 0.5);
    for (const [time, gain, pan, lpFreq] of reflections) {
      mixInto(
        earlyBuf,
        noiseBurst(sampleRate, channelRng, 0.03, 0.005, {
          hp: 350,
          lp: lpFreq,
          att: 4e-4
        }),
        time + (pan * side > 0 ? 0 : 6e-4),
        gain * (1 + 0.4 * pan * side),
        sampleRate
      );
    }
    for (let k = 1; k < 8; k++) {
      mixInto(
        earlyBuf,
        noiseBurst(sampleRate, channelRng, 0.04, 0.007, {
          hp: 600,
          lp: 5200 / (1 + k * 0.3)
        }),
        flutterPeriod * k * (channel ? 1.012 : 0.99),
        0.45 * Math.pow(0.72, k),
        sampleRate
      );
    }
    mixInto(
      out,
      earlyBuf,
      0,
      (ref * dbToGain(params.early)) / rmsRange(earlyBuf, 0, 0.05 * sampleRate),
      sampleRate
    );
    const channelNoise = noiseBuffer(sampleRate, len, channelRng);
    const late = allocSamples(sampleRate, len);
    for (let i = 0; i < late.length; i++) late[i] = sharedNoise[i] * 0.7 + channelNoise[i] * 0.7;
    biquadSweep(late, 'lp', expRamp(params.lp0, params.lp1, 0.5), 0.6, sampleRate);
    biquad(late, 'hp', 170, 0.7, sampleRate);
    applyEnvelope(late, sampleRate, expDecay(params.tau, 0.006));
    const lateGain = (ref * dbToGain(params.level)) / rmsRange(late, measureFrom, measureTo);
    mixInto(out, late, 0.004, lateGain, sampleRate);
    for (const [modeFreq, modeGain] of [
      [57, 1],
      [86, 0.8],
      [123, 0.6],
      [171, 0.4]
    ]) {
      const mode = noiseBuffer(sampleRate, Math.min(len - 0.05, 0.9), channelRng);
      biquad(mode, 'bp', modeFreq * (variant & 1 ? 1.05 : 1), 8, sampleRate);
      applyEnvelope(mode, sampleRate, expDecay(params.tau * 1.25, 0.02));
      mixInto(
        out,
        mode,
        0.01,
        (modeGain * ref * dbToGain(params.modes)) / rmsRange(mode, measureFrom, measureTo),
        sampleRate
      );
    }
    return tanhLimit(out, params.ceil);
  };
  return [renderChannel(0), renderChannel(1)];
}

export const RIFLE_OUTDOOR_SLAPBACKS: SlapbackEcho[][] = [
  [
    [0.078, -11.6, 4400, -0.8, 2.7],
    [0.124, -11.6, 3400, 0.7, 3.6],
    [0.171, -12, 2500, -0.3, 2.2],
    [0.262, -19, 1500, 0.5, 4.1]
  ],
  [
    [0.084, -11.4, 4200, 0.8, 3.1],
    [0.131, -11.6, 3600, -0.6, 2.4],
    [0.177, -12, 2400, 0.35, 3.9],
    [0.286, -19, 1400, -0.5, 2.9]
  ]
];

export const RIFLE_TAIL_OUT: OutdoorTailParams = {
  len: 2.2,
  ref: 0.7,
  ceil: 0.75,
  slaps: RIFLE_OUTDOOR_SLAPBACKS,
  slapHold: 0.024,
  slapTau: 0.009,
  lp0: 3600,
  lp1: 600,
  early: -15,
  earlyTau: 0.03,
  floor: -14.1,
  lateT: 0.8,
  farT: 0.42,
  far: -18,
  rumble: -22
};

export const PISTOL_TAIL_OUT: OutdoorTailParams = {
  len: 1.5,
  ref: 0.53,
  slaps: [
    [
      [0.076, -11.8, 5200, -0.7, 2.1],
      [0.121, -12, 3900, 0.75, 2.9],
      [0.168, -12.8, 2800, -0.25, 3.4]
    ]
  ],
  slapHold: 0.015,
  slapTau: 0.008,
  ceil: 0.6,
  lp0: 4400,
  lp1: 700,
  early: -15,
  earlyTau: 0.03,
  floor: -14.6,
  lateT: 0.55,
  farT: 0.34,
  far: -22,
  rumble: -28
};

export const RIFLE_TAIL_IN: IndoorTailParams = {
  len: 1.3,
  ref: 0.7,
  ceil: 0.7,
  lp0: 7800,
  lp1: 1300,
  tau: 0.15,
  early: -13,
  level: -9,
  modes: -21
};

export const PISTOL_TAIL_IN: IndoorTailParams = {
  len: 0.9,
  ref: 0.53,
  ceil: 0.55,
  lp0: 8500,
  lp1: 1700,
  tau: 0.105,
  early: -13,
  level: -10,
  modes: -27
};

export const synthRifleTailOut = (sampleRate: number, rng: RandomFn, variant: number) =>
  synthOutdoorTail(sampleRate, rng, variant, RIFLE_TAIL_OUT);
export const synthRifleTailIn = (sampleRate: number, rng: RandomFn, variant: number) =>
  synthIndoorTail(sampleRate, rng, variant, RIFLE_TAIL_IN);
export const synthPistolTailOut = (sampleRate: number, rng: RandomFn, variant: number) =>
  synthOutdoorTail(sampleRate, rng, variant, PISTOL_TAIL_OUT);
export const synthPistolTailIn = (sampleRate: number, rng: RandomFn, variant: number) =>
  synthIndoorTail(sampleRate, rng, variant, PISTOL_TAIL_IN);
