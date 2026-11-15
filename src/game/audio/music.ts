// Procedural score: tempo/key constants, the instrument renderers (super-saw pads, brass,
// Karplus-Strong plucks, modal piano, taiko/boom/steel percussion, FDN reverb) and the
// incremental generators that render every looping music stem and one-shot sting.
import {
  TWO_PI,
  allocSamples,
  biquad,
  biquadCoeffs,
  biquadSweep,
  expRamp,
  midiToFreq,
  mixInto,
  mixIntoWrapped,
  modalResonators,
  mulberry32,
  noiseBuffer,
  peakAbs,
  scaleBuffer
} from './dsp';
import type { BiquadType, ModalPartial, RandomFn } from './dsp';

/** Incremental synth: yields between work chunks and returns the rendered channel(s). */
export type MusicGenerator<T extends Float32Array | Float32Array[] = Float32Array> = Generator<
  undefined,
  T,
  unknown
>;
/** A peaking EQ band: [centre frequency Hz, Q, linear boost amount]. */
type EqBand = [number, number, number];

/** Tempo, key and layout constants shared by the music stems and the music director. */
export interface MusicConfig {
  bpm: number;
  beat: number;
  bar: number;
  s16: number;
  cycleBars: number;
  formBars: number;
  sr: number;
  srLo: number;
  key: string;
  scale: number[];
  swing: number;
  riserPeak: number;
  chords: string[];
  motif: { call: string[]; answer: string[]; resolve: string[] };
  cells: [number, number][];
  cellSecond: number;
  loops: Record<string, number>;
}

export const MUSIC: MusicConfig = {
  bpm: 96,
  beat: 0.625,
  bar: 2.5,
  s16: 0.15625,
  cycleBars: 8,
  formBars: 16,
  sr: 22050,
  srLo: 16000,
  key: 'D minor (aeolian)',
  scale: [2, 4, 5, 7, 9, 10, 0],
  swing: 0.01,
  riserPeak: 5,
  chords: ['Dm', 'Bb/D', 'Gm/D', 'Dsus2 | Am7/D'],
  motif: {
    call: ['D4', 'A4', 'Bb4', 'F4'],
    answer: ['D4', 'G4', 'A4', 'E4'],
    resolve: ['F4', 'E4', 'D4']
  },
  cells: [
    [62, 69],
    [70, 65],
    [62, 67],
    [69, 64]
  ],
  cellSecond: 0.9375,
  loops: {
    music_drone: 16,
    music_strings: 8,
    music_pulse: 16,
    music_ticks: 6,
    music_drums: 8,
    music_brass: 8,
    music_lift: 8
  }
};
export const MUSIC_BAR = MUSIC.bar;
export const MUSIC_BEAT = MUSIC.beat;
export const MUSIC_SIXTEENTH = MUSIC.s16;
export const MUSIC_SR = MUSIC.sr;
export const MUSIC_SR_LO = MUSIC.srLo;
export const DRONE_PAD_LOW_NOTES = [57, 58, 58, 57];
export const DRONE_PAD_HIGH_NOTES = [65, 65, 67, 64];
export const STRINGS_LOW_NOTES = [69, 70, 70, 69];
export const STRINGS_HIGH_NOTES = [74, 74, 74, 76];
export const PULSE_PASSING_NOTES = [57, 58, 58, 57];
export const PULSE_FIFTH_NOTES = [53, 53, 55, 52];
export const BRASS_STAB_CHORDS = [
  [38, 50, 57],
  [38, 53, 58],
  [38, 55, 58],
  [38, 52, 57]
];
export const BRASS_SWELL_CHORDS = [
  [50, 57, 62],
  [53, 58, 62],
  [55, 58, 62],
  [52, 57, 64]
];
export const MUSIC_STEM_RMS = {
  drone: 0.071,
  strings: 0.062,
  pulse: 0.078,
  ticks: 0.03,
  drums: 0.122,
  brass: 0.08,
  lift: 0.071
};

/** Scales all stems together so their combined RMS equals `targetRms`. */
function normalizeStemsRms(stems: Float32Array[], targetRms: number): Float32Array[] {
  let sumSquares = 0;
  let count = 0;
  for (const stem of stems) {
    for (let i = 0; i < stem.length; i++) sumSquares += stem[i] * stem[i];
    count += stem.length;
  }
  const gain = targetRms / Math.sqrt(sumSquares / count || 1);
  for (const stem of stems) scaleBuffer(stem, gain);
  return stems;
}

const PULSE_ACCENT_STEPS = [0, 3, 6, 8, 11, 14];
const clampMusic = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** In-place x/sqrt(1+x^2) saturation, normalised so a full-scale input stays full-scale. */
function softClipAlgebraic(buf: Float32Array, drive: number): Float32Array {
  const norm = Math.sqrt(1 + drive * drive) / drive;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i] * drive;
    buf[i] = (x / Math.sqrt(1 + x * x)) * norm;
  }
  return buf;
}

interface NoiseBurstOptions {
  hp?: number;
  lp?: number;
  bp?: number;
  q?: number;
  att?: number;
}

/** Filtered noise burst with exponential decay (and optional attack), peak-normalised. */
function noiseBurstMusic(
  sr: number,
  rng: RandomFn,
  dur: number,
  decay: number,
  opts: NoiseBurstOptions = {}
): Float32Array {
  const buf = noiseBuffer(sr, dur, rng);
  if (opts.hp) biquad(buf, 'hp', opts.hp, 0.707, sr);
  if (opts.lp) biquad(buf, 'lp', opts.lp, 0.707, sr);
  if (opts.bp) biquad(buf, 'bp', opts.bp, opts.q || 1, sr);
  const decayMul = Math.exp(-1 / (decay * sr));
  const attackMul = opts.att !== undefined && opts.att > 0 ? Math.exp(-1 / (opts.att * sr)) : 0;
  let env = 1;
  let attackEnv = 1;
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] * env * (1 - attackEnv);
    buf[i] = v;
    env *= decayMul;
    attackEnv *= attackMul;
    if (v > peak) peak = v;
    else if (-v > peak) peak = -v;
  }
  return peak > 0 ? scaleBuffer(buf, 1 / peak) : buf;
}

/** Sine whose pitch glides exponentially from `startFreq` to `endFreq` (kick/tom body). */
function pitchDropSineMusic(
  sr: number,
  dur: number,
  startFreq: number,
  endFreq: number,
  sweepTau: number,
  decayTau: number,
  attackTau = 0.0006
): Float32Array {
  const out = allocSamples(sr, dur);
  const sweepMul = Math.exp(-1 / (sweepTau * sr));
  const decayMul = Math.exp(-1 / (decayTau * sr));
  const attackMul = Math.exp(-1 / (attackTau * sr));
  const baseInc = (TWO_PI * endFreq) / sr;
  let phase = 0;
  let extraInc = (TWO_PI * (startFreq - endFreq)) / sr;
  let amp = 1;
  let attackEnv = 1;
  for (let i = 0; i < out.length; i++) {
    phase += baseInc + extraInc;
    if (phase > TWO_PI) phase -= TWO_PI;
    out[i] = Math.sin(phase) * amp * (1 - attackEnv);
    extraInc *= sweepMul;
    amp *= decayMul;
    attackEnv *= attackMul;
  }
  return out;
}

/** Biquad filter for a looping buffer: the state is pre-warmed on the buffer's tail. */
function biquadLooped(
  buf: Float32Array,
  type: BiquadType,
  freq: number,
  q: number,
  sr: number,
  preroll = 0.4
): Float32Array {
  const [b0, b1, b2, a1, a2] = biquadCoeffs(type, freq, q, sr);
  const len = buf.length;
  let z1 = 0;
  let z2 = 0;
  for (let i = Math.max(0, len - Math.round(preroll * sr)); i < len; i++) {
    const x = buf[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
  }
  for (let i = 0; i < len; i++) {
    const x = buf[i];
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    buf[i] = y;
  }
  return buf;
}

/** Time-varying low-pass for a looping buffer; `cutoffAt` maps loop position (0..1) to Hz. */
function lowpassSweepLooped(
  buf: Float32Array,
  cutoffAt: (pos: number) => number,
  q: number,
  sr: number,
  preroll = 0.4
): Float32Array {
  const len = buf.length;
  const warmStart = Math.max(0, len - Math.round(preroll * sr));
  let z1 = 0;
  let z2 = 0;
  // Always assigned before first use (at `warmStart` or index 0).
  let coeffs: number[] = [];
  for (let i = warmStart; i < len; i++) {
    if ((i & 63) === 0 || i === warmStart) coeffs = biquadCoeffs('lp', cutoffAt(i / len), q, sr);
    const x = buf[i];
    const y = coeffs[0] * x + z1;
    z1 = coeffs[1] * x - coeffs[3] * y + z2;
    z2 = coeffs[2] * x - coeffs[4] * y;
  }
  for (let i = 0; i < len; i++) {
    if ((i & 63) === 0) coeffs = biquadCoeffs('lp', cutoffAt(i / len), q, sr);
    const x = buf[i];
    const y = coeffs[0] * x + z1;
    z1 = coeffs[1] * x - coeffs[3] * y + z2;
    z2 = coeffs[2] * x - coeffs[4] * y;
    buf[i] = y;
  }
  return buf;
}

/** Series of peaking-EQ boosts; with `looped` the filter state is pre-warmed on the tail. */
function peakingEqBank(
  buf: Float32Array,
  sr: number,
  bands: EqBand[],
  looped?: boolean
): Float32Array {
  const len = buf.length;
  const warmStart = looped ? Math.max(0, len - Math.round(0.3 * sr)) : len;
  for (const [freq, q, boost] of bands) {
    const gainAmp = Math.sqrt(1 + boost);
    const w0 = (TWO_PI * freq) / sr;
    const alpha = Math.sin(w0) / (2 * q);
    const cosW0 = Math.cos(w0);
    const a0 = 1 + alpha / gainAmp;
    const b0 = (1 + alpha * gainAmp) / a0;
    const b1 = (-2 * cosW0) / a0;
    const b2 = (1 - alpha * gainAmp) / a0;
    const a1 = (-2 * cosW0) / a0;
    const a2 = (1 - alpha / gainAmp) / a0;
    let z1 = 0;
    let z2 = 0;
    for (let i = warmStart; i < len; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
    }
    for (let i = 0; i < len; i++) {
      const x = buf[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      buf[i] = y;
    }
  }
  return buf;
}

const MUSIC_EQ_BANDS: EqBand[] = [
  [520, 1.4, 0.35],
  [1350, 1.6, 0.22]
];

/** Looping chorus: each channel mixes in a modulated delayed copy (opposite polarity on R). */
function chorusLooped(
  channels: Float32Array[],
  sr: number,
  lfoCycles: number,
  baseMs = 13,
  depthMs = 2.2,
  mix = 0.3
): Float32Array[] {
  channels.forEach((channel, chIndex) => {
    const len = channel.length;
    const dry = channel.slice();
    const lfoPhase = chIndex * 2.1;
    const wetGain = mix * (chIndex ? -1 : 1);
    const delayAt = (i: number) =>
      (baseMs +
        depthMs * Math.sin((TWO_PI * lfoCycles * i) / len + lfoPhase) +
        (chIndex ? 3.1 : 0)) *
      0.001 *
      sr;
    let delay = delayAt(0);
    let delayStep = 0;
    for (let i = 0; i < len; i++) {
      if ((i & 63) === 0) {
        delay = delayAt(i);
        delayStep = (delayAt(i + 64) - delay) / 64;
      }
      let readPos = i - delay;
      delay += delayStep;
      if (readPos < 0) readPos += len;
      const idx = readPos | 0;
      const frac = readPos - idx;
      channel[i] =
        dry[i] + wetGain * (dry[idx] + (dry[idx + 1 < len ? idx + 1 : 0] - dry[idx]) * frac);
    }
  });
  return channels;
}

/** High-passes the mid and side signals separately (side harder) on a looping stereo pair. */
function midSideHighpass(
  left: Float32Array,
  right: Float32Array,
  sr: number,
  midHz = 40,
  sideHz = 120
): void {
  const len = left.length;
  const mid = new Float32Array(len);
  const side = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    mid[i] = 0.5 * (left[i] + right[i]);
    side[i] = 0.5 * (left[i] - right[i]);
  }
  biquadLooped(mid, 'hp', midHz, 0.707, sr, 0.6);
  biquadLooped(side, 'hp', sideHz, 0.707, sr);
  biquadLooped(side, 'hp', sideHz, 0.707, sr);
  for (let i = 0; i < len; i++) {
    left[i] = mid[i] + side[i];
    right[i] = mid[i] - side[i];
  }
}

const FDN_DELAY_TIMES = [0.0297, 0.0371, 0.0411, 0.0437, 0.0533, 0.0617, 0.0683, 0.0741];

/** Reverb settings: RT60 (s), room size scale, HF damping, pre-delay (s), wet high-pass (Hz). */
interface ReverbOptions {
  rt?: number;
  size?: number;
  damp?: number;
  pre?: number;
  hp?: number;
}

/**
 * 8-line feedback-delay-network reverb running at half rate; the wet signal is
 * upsampled and added back into `buf` in place.
 */
function fdnReverb(buf: Float32Array, sr: number, opts: ReverbOptions = {}, wet = 1): Float32Array {
  const halfSr = sr / 2;
  const len = buf.length;
  const halfLen = len >> 1;
  const wetBuf = new Float32Array(halfLen);
  const rt60 = opts.rt || 2.4;
  const size = opts.size || 1;
  const damp = opts.damp ?? 0.3;
  const preDelay = Math.round((opts.pre ?? 0.018) * sr) & -2;
  const dampCoef = 1 - damp;
  const delayLens = FDN_DELAY_TIMES.map((time) => Math.round(time * size * halfSr) | 1);
  const delayGains = delayLens.map((dl) => Math.pow(10, (-3 * dl) / halfSr / rt60));
  const line0 = new Float32Array(delayLens[0]);
  const line1 = new Float32Array(delayLens[1]);
  const line2 = new Float32Array(delayLens[2]);
  const line3 = new Float32Array(delayLens[3]);
  const line4 = new Float32Array(delayLens[4]);
  const line5 = new Float32Array(delayLens[5]);
  const line6 = new Float32Array(delayLens[6]);
  const line7 = new Float32Array(delayLens[7]);
  const [len0, len1, len2, len3, len4, len5, len6, len7] = delayLens;
  const [gain0, gain1, gain2, gain3, gain4, gain5, gain6, gain7] = delayGains;
  let idx0 = 0;
  let idx1 = 0;
  let idx2 = 0;
  let idx3 = 0;
  let idx4 = 0;
  let idx5 = 0;
  let idx6 = 0;
  let idx7 = 0;
  let lp0 = 0;
  let lp1 = 0;
  let lp2 = 0;
  let lp3 = 0;
  let lp4 = 0;
  let lp5 = 0;
  let lp6 = 0;
  let lp7 = 0;
  const ap1Len = Math.round(0.0051 * halfSr) | 1;
  const ap2Len = Math.round(0.0127 * halfSr) | 1;
  const ap1 = new Float32Array(ap1Len);
  const ap2 = new Float32Array(ap2Len);
  let ap1Idx = 0;
  let ap2Idx = 0;
  for (let i = 0; i < halfLen; i++) {
    const src = 2 * i - preDelay;
    // Half-band decimation of the (pre-delayed) input.
    let input =
      src >= 3 && src < len - 3
        ? (16 * buf[src] + 9 * (buf[src - 1] + buf[src + 1]) - (buf[src - 3] + buf[src + 3])) *
          0.0109375
        : 0;
    {
      const delayed = ap1[ap1Idx];
      const fed = input + 0.6 * delayed;
      ap1[ap1Idx] = fed;
      input = delayed - 0.6 * fed;
      if (++ap1Idx === ap1Len) ap1Idx = 0;
    }
    {
      const delayed = ap2[ap2Idx];
      const fed = input + 0.6 * delayed;
      ap2[ap2Idx] = fed;
      input = delayed - 0.6 * fed;
      if (++ap2Idx === ap2Len) ap2Idx = 0;
    }
    const out0 = line0[idx0];
    const out1 = line1[idx1];
    const out2 = line2[idx2];
    const out3 = line3[idx3];
    const out4 = line4[idx4];
    const out5 = line5[idx5];
    const out6 = line6[idx6];
    const out7 = line7[idx7];
    // Householder feedback matrix: subtract a quarter of the sum from every line.
    const mix = (out0 + out1 + out2 + out3 + out4 + out5 + out6 + out7) * 0.25;
    lp0 += (out0 - mix - lp0) * dampCoef;
    line0[idx0] = lp0 * gain0 + input;
    if (++idx0 === len0) idx0 = 0;
    lp1 += (out1 - mix - lp1) * dampCoef;
    line1[idx1] = lp1 * gain1 + input;
    if (++idx1 === len1) idx1 = 0;
    lp2 += (out2 - mix - lp2) * dampCoef;
    line2[idx2] = lp2 * gain2 + input;
    if (++idx2 === len2) idx2 = 0;
    lp3 += (out3 - mix - lp3) * dampCoef;
    line3[idx3] = lp3 * gain3 + input;
    if (++idx3 === len3) idx3 = 0;
    lp4 += (out4 - mix - lp4) * dampCoef;
    line4[idx4] = lp4 * gain4 + input;
    if (++idx4 === len4) idx4 = 0;
    lp5 += (out5 - mix - lp5) * dampCoef;
    line5[idx5] = lp5 * gain5 + input;
    if (++idx5 === len5) idx5 = 0;
    lp6 += (out6 - mix - lp6) * dampCoef;
    line6[idx6] = lp6 * gain6 + input;
    if (++idx6 === len6) idx6 = 0;
    lp7 += (out7 - mix - lp7) * dampCoef;
    line7[idx7] = lp7 * gain7 + input;
    if (++idx7 === len7) idx7 = 0;
    wetBuf[i] = (out0 - out1 + out2 - out3 + out4 - out5 + out6 - out7) * 0.5;
  }
  biquad(wetBuf, 'hp', opts.hp || 180, 0.707, halfSr);
  const wetGain = wet;
  // 2x interpolating upsample of the wet signal, summed into the dry buffer.
  for (let i = 2; i < halfLen - 3; i++) {
    buf[2 * i] += wetBuf[i] * wetGain;
    buf[2 * i + 1] +=
      (3 * (wetBuf[i - 2] + wetBuf[i + 3]) -
        25 * (wetBuf[i - 1] + wetBuf[i + 2]) +
        150 * (wetBuf[i] + wetBuf[i + 1])) *
      (wetGain / 256);
  }
  return buf;
}

/** Adds `wet` amount of FDN reverb to `buf` in place. */
function addReverb(buf: Float32Array, sr: number, wet: number, opts: ReverbOptions): Float32Array {
  return fdnReverb(buf, sr, opts, wet);
}

/** Tremolo applied to every super-saw voice. */
interface TremoloOptions {
  rate: number;
  depth: number;
}

/** Super-saw pad note options (`rng` drives detune, drift and phase randomisation). */
interface SuperSawOptions {
  /** Voice count. */
  n?: number;
  /** Detune spread in cents. */
  det?: number;
  att?: number;
  rel?: number;
  rng: RandomFn;
  /** Overall gain. */
  g?: number;
  /** Amplitude ramp [start, end] across the held part of the note. */
  swell?: [number, number];
  /** Swell curve exponent. */
  swp?: number;
  /** Maximum release tail (s). */
  tail?: number;
  width?: number;
  pan?: number;
  drift?: number;
  trem?: TremoloOptions;
}

/**
 * Adds a band-limited (polyBLEP) super-saw note into a looping mono or stereo buffer,
 * wrapping around the loop end.
 */
function addSuperSawPad(
  channels: Float32Array[],
  sr: number,
  freq: number,
  start: number,
  dur: number,
  opts: SuperSawOptions
): void {
  const loopLen = channels[0].length;
  const stereo = channels.length > 1;
  const voices = opts.n || 5;
  const detune = opts.det ?? 8;
  const attack = opts.att ?? 0.5;
  const release = opts.rel ?? 0.6;
  const rng = opts.rng;
  const voiceGain = (opts.g ?? 1) / Math.sqrt(voices);
  const swellStart = opts.swell ? opts.swell[0] : 1;
  const swellEnd = opts.swell ? opts.swell[1] : 1;
  const swellCurve = opts.swp || 1;
  const tailLen = Math.min(release * 3, opts.tail ?? 99);
  const totalSamples = Math.round((dur + tailLen) * sr);
  const startIdx = ((Math.round(start * sr) % loopLen) + loopLen) % loopLen;
  const width = stereo ? (opts.width ?? 0.75) : 0;
  const pan = opts.pan || 0;
  const drift = opts.drift ?? 0.0012;
  const trem = opts.trem;
  const left = channels[0];
  const right = stereo ? channels[1] : null;
  for (let v = 0; v < voices; v++) {
    const spread = voices > 1 ? (v / (voices - 1)) * 2 - 1 : 0;
    const voiceFreq = freq * Math.pow(2, (spread * detune + (rng() - 0.5) * detune * 0.4) / 1200);
    const panSpread = voices > 1 ? (((v * 3 + 1) % voices) / (voices - 1)) * 2 - 1 : 0;
    const voicePan = clampMusic(pan + panSpread * width, -1, 1);
    const gainL = stereo
      ? Math.cos(((voicePan + 1) * Math.PI) / 4) * voiceGain * Math.SQRT2
      : voiceGain;
    const gainR = stereo ? Math.sin(((voicePan + 1) * Math.PI) / 4) * voiceGain * Math.SQRT2 : 0;
    const voiceAttack = attack * (0.65 + 0.7 * rng());
    const driftDepth = drift * (0.5 + rng());
    const driftRate = TWO_PI * (0.07 + 0.2 * rng());
    const driftPhase = rng() * TWO_PI;
    const tremRate = trem ? TWO_PI * trem.rate * (0.93 + 0.14 * rng()) : 0;
    const tremPhase = rng() * TWO_PI;
    const tremDepth = trem ? trem.depth : 0;
    const envAt = (time: number): number => {
      let env = time < voiceAttack ? 0.5 - 0.5 * Math.cos((Math.PI * time) / voiceAttack) : 1;
      if (time < dur) {
        if (swellStart !== swellEnd) {
          env *=
            swellStart +
            (swellEnd - swellStart) *
              (swellCurve === 1 ? time / dur : Math.pow(time / dur, swellCurve));
        } else {
          env *= swellStart;
        }
      } else {
        const sinceRelease = time - dur;
        env *=
          swellEnd * Math.exp(-sinceRelease / release) * Math.max(0, 1 - sinceRelease / tailLen);
      }
      if (tremDepth) env *= 1 - tremDepth * (0.5 - 0.5 * Math.cos(tremRate * time + tremPhase));
      return env;
    };
    let phase = rng();
    let writeIdx = startIdx;
    let nextEnv = envAt(0);
    // Envelope and pitch drift are evaluated per 32-sample block and interpolated.
    for (let blockStart = 0; blockStart < totalSamples; blockStart += 32) {
      const blockTime = blockStart / sr;
      const blockEnv = nextEnv;
      nextEnv = envAt((blockStart + 32) / sr);
      const envStep = (nextEnv - blockEnv) / 32;
      const inc =
        (voiceFreq * (1 + driftDepth * Math.sin(driftRate * blockTime + driftPhase))) / sr;
      const incComplement = 1 - inc;
      const blockLen = Math.min(32, totalSamples - blockStart);
      let env = blockEnv;
      if (writeIdx + blockLen <= loopLen) {
        if (right)
          for (let k = 0; k < blockLen; k++, writeIdx++) {
            phase += inc;
            if (phase >= 1) phase -= 1;
            let saw = phase + phase - 1;
            if (phase < inc) {
              const t = phase / inc;
              saw -= t + t - t * t - 1;
            } else if (phase > incComplement) {
              const t = (phase - 1) / inc;
              saw -= t * t + t + t + 1;
            }
            saw *= env;
            env += envStep;
            left[writeIdx] += saw * gainL;
            right[writeIdx] += saw * gainR;
          }
        else
          for (let k = 0; k < blockLen; k++, writeIdx++) {
            phase += inc;
            if (phase >= 1) phase -= 1;
            let saw = phase + phase - 1;
            if (phase < inc) {
              const t = phase / inc;
              saw -= t + t - t * t - 1;
            } else if (phase > incComplement) {
              const t = (phase - 1) / inc;
              saw -= t * t + t + t + 1;
            }
            left[writeIdx] += saw * env * gainL;
            env += envStep;
          }
        if (writeIdx === loopLen) writeIdx = 0;
      } else
        for (let k = 0; k < blockLen; k++) {
          phase += inc;
          if (phase >= 1) phase -= 1;
          let saw = phase + phase - 1;
          if (phase < inc) {
            const t = phase / inc;
            saw -= t + t - t * t - 1;
          } else if (phase > incComplement) {
            const t = (phase - 1) / inc;
            saw -= t * t + t + t + 1;
          }
          saw *= env;
          env += envStep;
          left[writeIdx] += saw * gainL;
          if (right) right[writeIdx] += saw * gainR;
          if (++writeIdx >= loopLen) writeIdx = 0;
        }
    }
  }
}

/** 2x upsampling with a 6-tap interpolator; `wrap` treats the buffer as a loop at the edges. */
function upsample2x(buf: Float32Array, wrap: boolean): Float32Array {
  const len = buf.length;
  const out = new Float32Array(len * 2);
  const sampleAt = wrap
    ? (i: number) => buf[(i + len) % len]
    : (i: number) => (i < 0 || i >= len ? 0 : buf[i]);
  for (let i = 0; i < len; i++) {
    out[2 * i] = buf[i];
    out[2 * i + 1] =
      i >= 2 && i < len - 3
        ? (3 * (buf[i - 2] + buf[i + 3]) -
            25 * (buf[i - 1] + buf[i + 2]) +
            150 * (buf[i] + buf[i + 1])) /
          256
        : (3 * (sampleAt(i - 2) + sampleAt(i + 3)) -
            25 * (sampleAt(i - 1) + sampleAt(i + 2)) +
            150 * (sampleAt(i) + sampleAt(i + 1))) /
          256;
  }
  return out;
}

/** Brass note options (`rng` drives detune and initial phases). */
interface BrassOptions {
  /** Voice count. */
  n?: number;
  /** Detune spread in cents. */
  det?: number;
  /** Velocity 0..1 (brightness and breath noise). */
  vel?: number;
  att?: number;
  rel?: number;
  rng: RandomFn;
  /** Amplitude ramp [start, end] over the held part. */
  swell?: [number, number];
  /** Swell curve exponent. */
  swp?: number;
  /** Initial pitch scoop in cents. */
  scoop?: number;
  /** Filter brightness factor. */
  bright?: number;
  /** Vibrato amount. */
  vib?: number;
}

/**
 * Renders a brass-like note: detuned polyBLEP saws through an envelope-tracking low-pass,
 * soft-clipped, plus a breath noise burst. Low notes render at half rate and are upsampled.
 */
function renderBrassNote(sr: number, freq: number, dur: number, opts: BrassOptions): Float32Array {
  const halfRate = freq < 400;
  const rate = halfRate ? sr / 2 : sr;
  const voices = opts.n || 4;
  const detune = opts.det ?? 7;
  const vel = opts.vel ?? 0.8;
  const attack = opts.att ?? 0.045;
  const release = opts.rel ?? 0.16;
  const rng = opts.rng;
  const swell = opts.swell || [1, 1];
  const swellCurve = opts.swp || 1.6;
  const len = Math.round((dur + release * 3.5) * rate);
  const out = new Float32Array(len);
  const swellMax = Math.max(swell[0], swell[1]);
  const releaseLevel = 1 - Math.exp(-dur / attack);
  const blockCount = Math.ceil(len / 32) + 1;
  const envAt = (time: number) =>
    time < dur
      ? (1 - Math.exp(-time / attack)) *
        (swell[0] + (swell[1] - swell[0]) * Math.pow(time / dur, swellCurve))
      : releaseLevel * swell[1] * Math.exp(-(time - dur) / release);
  const scoop = opts.scoop ?? -35;
  const bright = opts.bright ?? 8;
  const vibrato = opts.vib ?? 1;
  const voiceGain = 0.8 / Math.sqrt(voices);
  const envBlocks = new Float32Array(blockCount);
  const pitchBlocks = new Float32Array(blockCount);
  for (let b = 0; b < blockCount; b++) {
    const time = (b * 32) / rate;
    envBlocks[b] = envAt(time);
    pitchBlocks[b] =
      Math.pow(2, (scoop * Math.exp(-time / 0.028)) / 1200) *
      (1 + 0.0035 * vibrato * Math.sin(TWO_PI * 5.2 * time) * Math.min(1, time / 0.7));
  }
  for (let v = 0; v < voices; v++) {
    const baseInc =
      (freq *
        Math.pow(
          2,
          ((voices > 1 ? (v / (voices - 1)) * 2 - 1 : 0) * detune + (rng() - 0.5) * 3) / 1200
        )) /
      rate;
    let phase = rng();
    for (let blockStart = 0, b = 0; blockStart < len; blockStart += 32, b++) {
      const inc = baseInc * pitchBlocks[b];
      const incComplement = 1 - inc;
      const blockEnd = Math.min(len, blockStart + 32);
      for (let i = blockStart; i < blockEnd; i++) {
        phase += inc;
        if (phase >= 1) phase -= 1;
        let saw = phase + phase - 1;
        if (phase < inc) {
          const t = phase / inc;
          saw -= t + t - t * t - 1;
        } else if (phase > incComplement) {
          const t = (phase - 1) / inc;
          saw -= t * t + t + t + 1;
        }
        out[i] += saw;
      }
    }
  }
  const coeffsForBlock = (b: number) =>
    biquadCoeffs(
      'lp',
      Math.min(
        rate * 0.42,
        freq *
          (1.3 + bright * vel * Math.pow(envBlocks[Math.min(blockCount - 1, b)] / swellMax, 1.4))
      ),
      0.9,
      rate
    );
  let z1 = 0;
  let z2 = 0;
  let nextCoeffs = coeffsForBlock(0);
  for (let blockStart = 0, b = 0; blockStart < len; blockStart += 32, b++) {
    const cur = nextCoeffs;
    nextCoeffs = coeffsForBlock(b + 1);
    const blockEnd = Math.min(len, blockStart + 32);
    const envStep = (envBlocks[Math.min(blockCount - 1, b + 1)] - envBlocks[b]) / 32;
    const db0 = (nextCoeffs[0] - cur[0]) / 32;
    const db1 = (nextCoeffs[1] - cur[1]) / 32;
    const db2 = (nextCoeffs[2] - cur[2]) / 32;
    const da1 = (nextCoeffs[3] - cur[3]) / 32;
    const da2 = (nextCoeffs[4] - cur[4]) / 32;
    let env = envBlocks[b];
    let b0 = cur[0];
    let b1 = cur[1];
    let b2 = cur[2];
    let a1 = cur[3];
    let a2 = cur[4];
    for (let i = blockStart; i < blockEnd; i++) {
      const x = out[i] * voiceGain;
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      const driven = y * env * 1.3;
      out[i] = (driven / Math.sqrt(1 + driven * driven)) * 0.8;
      env += envStep;
      b0 += db0;
      b1 += db1;
      b2 += db2;
      a1 += da1;
      a2 += da2;
    }
  }
  mixInto(
    out,
    noiseBurstMusic(rate, rng, 0.05, 0.014, {
      bp: Math.min(2400, freq * 5),
      q: 0.8,
      att: 0.004
    }),
    0,
    0.05 * vel,
    rate
  );
  const fadeLen = Math.min(len, Math.round(0.02 * rate));
  for (let i = 0; i < fadeLen; i++) out[len - 1 - i] *= i / fadeLen;
  return halfRate ? upsample2x(out, false) : out;
}

interface PluckOptions {
  dur?: number;
  damp?: number;
  tau?: number;
  mute?: number;
}

/** Karplus-Strong plucked string with fractional-delay tuning and a palm-mute envelope. */
function karplusPluck(
  sr: number,
  freq: number,
  brightness: number,
  rng: RandomFn,
  opts: PluckOptions = {}
): Float32Array {
  const dur = opts.dur || 0.5;
  const len = Math.round(dur * sr);
  const out = new Float32Array(len);
  const period = sr / freq;
  const damp = opts.damp ?? 0.5 - 0.22 * brightness;
  const tau = opts.tau || 0.2;
  const delayInt = Math.floor(period - damp - 0.1);
  const delayFrac = period - damp - delayInt;
  const allpassCoef = (1 - delayFrac) / (1 + delayFrac);
  const loopGain = Math.exp(-period / (sr * tau * 2.2));
  const excitation = new Float32Array(delayInt);
  let lpState = 0;
  let mean = 0;
  const lpCoef = 0.16 + 0.62 * brightness;
  for (let i = 0; i < delayInt; i++) {
    lpState += (rng() * 2 - 1 - lpState) * lpCoef;
    excitation[i] = lpState;
    mean += lpState;
  }
  mean /= delayInt;
  // Pick-position comb on the DC-removed excitation.
  const combOffset = Math.max(1, Math.round(delayInt * 0.19));
  const shaped = new Float32Array(delayInt);
  for (let i = 0; i < delayInt; i++)
    shaped[i] = excitation[i] - mean - 0.55 * (excitation[(i + combOffset) % delayInt] - mean);
  let apIn = 0;
  let apOut = 0;
  for (let i = 0; i < len; i++) {
    const tap0 = i >= delayInt ? out[i - delayInt] : 0;
    const tap1 = i > delayInt ? out[i - delayInt - 1] : 0;
    const filtered = (1 - damp) * tap0 + damp * tap1;
    const allpassed = allpassCoef * filtered + apIn - allpassCoef * apOut;
    apIn = filtered;
    apOut = allpassed;
    out[i] = (i < delayInt ? shaped[i] : 0) + loopGain * allpassed;
  }
  const mute = opts.mute || 0.14;
  for (let i = 0; i < len; i++) {
    const time = i / sr;
    out[i] *= Math.exp(-time / mute) * Math.min(1, i / (0.0012 * sr));
  }
  mixInto(
    out,
    noiseBurstMusic(sr, rng, 0.03, 0.007, {
      lp: 500
    }),
    0,
    0.12 * peakAbs(out) * brightness,
    sr
  );
  const peak = peakAbs(out);
  if (peak > 0) scaleBuffer(out, 1 / peak);
  const fadeLen = Math.round(0.02 * sr);
  for (let i = 0; i < fadeLen; i++) out[len - 1 - i] *= i / fadeLen;
  return out;
}

/** Bank of decaying sine resonators (zero phase), skipping modes that are inaudible or too high. */
function modalResonatorsMusic(sr: number, dur: number, modes: ModalPartial[]): Float32Array {
  const out = allocSamples(sr, dur);
  let maxAmp = 0;
  for (const mode of modes) maxAmp = Math.max(maxAmp, mode[2]);
  for (const [freq, tau, amp] of modes) {
    if (freq > sr * 0.46 || amp < maxAmp * 0.001) continue;
    const w = (TWO_PI * freq) / sr;
    const radius = Math.exp(-1 / (tau * sr));
    const coef1 = 2 * radius * Math.cos(w);
    const coef2 = radius * radius;
    const ringLen = Math.min(
      out.length,
      Math.ceil(Math.log((maxAmp * 0.001) / amp) / Math.log(radius)) + 1
    );
    let prev = (-amp / radius) * Math.sin(w);
    let cur = 0;
    for (let i = 0; i < ringLen; i++) {
      out[i] += cur;
      const next = coef1 * cur - coef2 * prev;
      prev = cur;
      cur = next;
    }
  }
  return out;
}

/** Modal piano note (slightly inharmonic, detuned unison on low partials) plus hammer thump. */
function renderPianoNote(
  sr: number,
  freq: number,
  velocity: number,
  decay: number,
  rng: RandomFn
): Float32Array {
  const halfSr = sr / 2;
  const inharmonicity = 0.00032 * Math.pow(freq / 262, 1.2);
  const partials = Math.min(8, Math.floor((0.46 * halfSr) / freq));
  const modes: ModalPartial[] = [];
  for (let h = 1; h <= partials; h++) {
    const partialFreq = h * freq * Math.sqrt(1 + inharmonicity * h * h);
    const amp =
      Math.pow(h, -1.45) *
      Math.abs(Math.sin((Math.PI * h) / 7.6)) *
      Math.pow(velocity, (h - 1) * 0.3);
    const tau = (decay * 0.36) / (1 + 0.33 * (h - 1));
    if (h <= 2) {
      modes.push(
        [partialFreq * 0.9996, tau, amp * 0.55],
        [partialFreq * 1.0006, tau * 0.82, amp * 0.45]
      );
    } else {
      modes.push([partialFreq, tau, amp]);
    }
  }
  const out = modalResonatorsMusic(halfSr, decay, modes);
  const fadeInLen = Math.round(0.007 * halfSr);
  for (let i = 0; i < fadeInLen; i++) out[i] *= i / fadeInLen;
  mixInto(
    out,
    noiseBurstMusic(halfSr, rng, 0.06, 0.014, {
      lp: 420,
      att: 0.003
    }),
    0,
    0.1 * velocity,
    halfSr
  );
  const fadeOutLen = Math.round(0.25 * halfSr);
  for (let i = 0; i < fadeOutLen && i < out.length; i++) out[out.length - 1 - i] *= i / fadeOutLen;
  return upsample2x(scaleBuffer(out, velocity), false);
}

/** Taiko drum hit: pitched body, overtone, shell modes and skin/slap noise. */
function renderTaikoHit(sr: number, rng: RandomFn, freq: number, vel: number): Float32Array {
  const out = allocSamples(sr, 0.9);
  mixInto(
    out,
    pitchDropSineMusic(sr, 0.9, freq * (1.5 + 0.6 * vel), freq, 0.016, 0.16 + 0.1 * vel, 0.0012),
    0,
    1,
    sr
  );
  mixInto(
    out,
    pitchDropSineMusic(sr, 0.35, freq * 1.59 * 1.25, freq * 1.59, 0.02, 0.07, 0.001),
    0,
    0.3,
    sr
  );
  mixInto(
    out,
    modalResonators(
      sr,
      0.25,
      [
        [freq * 2.3, 0.05, 0.16],
        [freq * 2.65, 0.04, 0.11],
        [freq * 3.16, 0.03, 0.08],
        [freq * 3.6, 0.025, 0.05]
      ],
      rng
    ),
    0,
    1,
    sr
  );
  mixInto(
    out,
    noiseBurstMusic(sr, rng, 0.14, 0.026, {
      bp: 520,
      q: 0.6
    }),
    0,
    0.2 + 0.32 * vel,
    sr
  );
  mixInto(
    out,
    noiseBurstMusic(sr, rng, 0.012, 0.0022, {
      hp: 2200
    }),
    0,
    0.1 + 0.2 * vel,
    sr
  );
  return softClipAlgebraic(out, 1.2 + 0.5 * vel);
}

/** Cinematic sub boom with rumble and transient noise. */
function renderBoomHit(sr: number, rng: RandomFn, decayScale = 1): Float32Array {
  const out = allocSamples(sr, 1.6);
  mixInto(out, pitchDropSineMusic(sr, 1.6, 124, 55, 0.045, 0.34 * decayScale, 0.002), 0, 1, sr);
  mixInto(
    out,
    noiseBurstMusic(sr, rng, 0.5, 0.09, {
      lp: 150
    }),
    0,
    0.7,
    sr
  );
  mixInto(
    out,
    noiseBurstMusic(sr, rng, 0.16, 0.03, {
      bp: 700,
      q: 0.5
    }),
    0,
    0.3,
    sr
  );
  mixInto(
    out,
    noiseBurstMusic(sr, rng, 0.02, 0.004, {
      hp: 1800
    }),
    0,
    0.12,
    sr
  );
  return softClipAlgebraic(out, 1.5);
}

/** Struck steel plate/anvil: bar-like partials plus random inharmonic modes. */
function renderSteelHit(
  sr: number,
  rng: RandomFn,
  freq: number,
  decay: number,
  brightness = 1
): Float32Array {
  const modes: ModalPartial[] = [];
  for (const [ratio, amp] of [
    [1, 1],
    [2.756, 0.7],
    [5.404, 0.5],
    [8.933, 0.32],
    [13.34, 0.2]
  ])
    modes.push([
      freq * ratio * (1 + (rng() - 0.5) * 0.01),
      (decay * 0.3) / (1 + (ratio - 1) * 0.16),
      amp * Math.pow(brightness, Math.log2(ratio))
    ]);
  for (let i = 0; i < 14; i++) {
    const ratio = 1.2 + 9 * Math.pow(rng(), 1.4);
    modes.push([
      freq * ratio,
      ((decay * 0.2) / (1 + (ratio - 1) * 0.3)) * (0.5 + rng()),
      0.22 * rng() * Math.pow(brightness, Math.log2(ratio))
    ]);
  }
  const out = modalResonators(sr, decay, modes, rng);
  mixInto(
    out,
    noiseBurstMusic(sr, rng, 0.01, 0.0018, {
      hp: 1500
    }),
    0,
    0.5 * brightness,
    sr
  );
  const peak = peakAbs(out);
  return softClipAlgebraic(scaleBuffer(out, 1 / peak), 1.4);
}

/** Adds a slowly swelling, saturated D1 sine+triangle sub drone tuned to loop seamlessly. */
function addSubDrone(buf: Float32Array, sr: number, loopDur: number): void {
  const len = buf.length;
  const freq = Math.round(midiToFreq(38) * loopDur) / loopDur;
  const cyclesPerSample = freq / sr;
  const w = TWO_PI * cyclesPerSample;
  const recurrence = 2 * Math.cos(w);
  let triPhase = 0;
  let swell = 1;
  let sinCur = 0;
  let sinPrev = -Math.sin(w);
  for (let i = 0; i < len; i++) {
    // Resync the sine recurrence (and the swell LFO) every 256 samples to avoid drift.
    if ((i & 255) === 0) {
      swell = 0.8 + 0.2 * Math.sin((TWO_PI * 4 * i) / len - 1.2);
      sinCur = Math.sin(w * i);
      sinPrev = Math.sin(w * (i - 1));
    }
    const tri =
      triPhase < 0.25 ? 4 * triPhase : triPhase < 0.75 ? 2 - 4 * triPhase : 4 * triPhase - 4;
    const x = (0.8 * sinCur + 0.24 * tri) * 1.5 * swell;
    buf[i] += (x / Math.sqrt(1 + x * x)) * 0.105;
    const sinNext = recurrence * sinCur - sinPrev;
    sinPrev = sinCur;
    sinCur = sinNext;
    triPhase += cyclesPerSample;
    if (triPhase >= 1) triPhase -= 1;
  }
}

/** dst += src * gain, in place. */
const addBuffer = (dst: Float32Array, src: Float32Array, gain = 1): Float32Array => {
  for (let i = 0; i < dst.length; i++) dst[i] += src[i] * gain;
  return dst;
};

/** Adds wrapped echoes: tap k is delayed by (k + 1) * `spacing` samples. */
function addLoopedEchoes(
  buf: Float32Array,
  spacing: number,
  taps: [Float32Array, number][]
): Float32Array {
  const len = buf.length;
  for (let k = 0; k < taps.length; k++) {
    const [src, gain] = taps[k];
    const delay = (k + 1) * spacing;
    for (let i = 0; i < len; i++) {
      let readIdx = i - delay;
      if (readIdx < 0) readIdx += len;
      buf[i] += gain * src[readIdx];
    }
  }
  return buf;
}

/** 16-bar stereo drone loop: sub, low pads and the evolving chord pads (rendered at half rate). */
export function* synthMusicDrone(sr: number, rng: RandomFn): MusicGenerator<Float32Array[]> {
  const halfSr = sr / 2;
  const loopDur = 16 * MUSIC_BAR;
  const len = Math.round(loopDur * halfSr);
  const sub = new Float32Array(len);
  const left = new Float32Array(len);
  const right = new Float32Array(len);
  const stereo = [left, right];
  addSubDrone(sub, halfSr, loopDur);
  yield;
  {
    const padLen = Math.round(4 * MUSIC_BAR * halfSr);
    const lowPad = new Float32Array(padLen);
    const octavePad = new Float32Array(padLen);
    addSuperSawPad([lowPad], halfSr, midiToFreq(38), -0.9, 4 * MUSIC_BAR - 1, {
      n: 3,
      det: 6,
      att: 1.5,
      rel: 0.9,
      g: 0.15,
      swell: [0.8, 1],
      rng
    });
    yield;
    addSuperSawPad([octavePad], halfSr, midiToFreq(50), -0.9, 4 * MUSIC_BAR - 1, {
      n: 3,
      det: 8,
      att: 1.7,
      rel: 0.9,
      g: 0.16,
      swell: [0.85, 1],
      rng
    });
    yield;
    for (let k = 0; k < 4; k++) {
      mixIntoWrapped(sub, lowPad, k * 4 * MUSIC_BAR, 1, halfSr);
      mixIntoWrapped(sub, octavePad, (k * 4 + 2) * MUSIC_BAR, 1, halfSr);
    }
  }
  lowpassSweepLooped(
    sub,
    (pos) => 520 + 150 * Math.sin(TWO_PI * pos - 0.6) + 70 * Math.sin(TWO_PI * 3 * pos + 1),
    0.8,
    halfSr
  );
  yield;
  addSuperSawPad(stereo, halfSr, midiToFreq(62), -1, 8 * MUSIC_BAR - 0.8, {
    n: 2,
    det: 7,
    att: 2.2,
    rel: 0.8,
    g: 0.085,
    width: 0.5,
    rng
  });
  yield;
  for (let k = 0; k < 4; k++) {
    const start = k * 2 * MUSIC_BAR - 0.7;
    addSuperSawPad(stereo, halfSr, midiToFreq(DRONE_PAD_LOW_NOTES[k]), start, 2 * MUSIC_BAR - 0.1, {
      n: 3,
      det: 9,
      att: 1.4,
      rel: 0.7,
      g: 0.12,
      width: 0.8,
      swell: [0.75, 1],
      rng
    });
    yield;
    addSuperSawPad(
      stereo,
      halfSr,
      midiToFreq(DRONE_PAD_HIGH_NOTES[k]),
      start + 0.25,
      2 * MUSIC_BAR - 0.35,
      {
        n: 3,
        det: 10,
        att: 1.7,
        rel: 0.75,
        g: 0.095,
        width: 0.9,
        swell: [0.7, 1],
        rng
      }
    );
    yield;
  }
  for (let k = 0; k < 4; k++) {
    addSuperSawPad(
      stereo,
      halfSr,
      midiToFreq(DRONE_PAD_LOW_NOTES[k]),
      (8 + k * 2) * MUSIC_BAR - 0.7,
      2 * MUSIC_BAR - 0.1,
      {
        n: 4,
        det: 10,
        att: 1.6,
        rel: 0.75,
        g: 0.16,
        width: 0.85,
        swell: [0.8, 1],
        rng
      }
    );
    yield;
  }
  addSuperSawPad(stereo, halfSr, midiToFreq(74), 8 * MUSIC_BAR + 0.5, 6 * MUSIC_BAR, {
    n: 2,
    det: 5,
    att: 3.5,
    rel: 1.2,
    g: 0.045,
    width: 0.9,
    swell: [0.6, 1],
    rng
  });
  yield;
  addSuperSawPad(stereo, halfSr, midiToFreq(81), 10 * MUSIC_BAR, 3.5 * MUSIC_BAR, {
    n: 2,
    det: 4,
    att: 3,
    rel: 1.3,
    g: 0.02,
    width: 0.9,
    rng
  });
  yield;
  addSuperSawPad(stereo, halfSr, midiToFreq(60), 14 * MUSIC_BAR - 0.4, 2 * MUSIC_BAR - 0.4, {
    n: 3,
    det: 9,
    att: 1.5,
    rel: 0.7,
    g: 0.09,
    width: 0.7,
    rng
  });
  yield;
  addSuperSawPad(stereo, halfSr, midiToFreq(64), 14 * MUSIC_BAR - 0.1, 2 * MUSIC_BAR - 0.7, {
    n: 3,
    det: 9,
    att: 1.7,
    rel: 0.7,
    g: 0.085,
    width: 0.9,
    rng
  });
  yield;
  for (const channel of stereo) {
    lowpassSweepLooped(
      channel,
      (pos) => 1250 + 380 * Math.sin(TWO_PI * 2 * pos + 0.5) + 160 * Math.sin(TWO_PI * 5 * pos),
      0.75,
      halfSr
    );
    yield;
    peakingEqBank(
      channel,
      halfSr,
      [
        [290, 1.3, 0.4],
        [1050, 1.6, 0.3]
      ],
      true
    );
    yield;
  }
  chorusLooped(stereo, halfSr, 7);
  yield;
  addBuffer(left, sub);
  addBuffer(right, sub);
  midSideHighpass(left, right, halfSr, 42, 120);
  yield;
  normalizeStemsRms(stereo, MUSIC_STEM_RMS.drone);
  const upLeft = upsample2x(left, true);
  yield;
  return [upLeft, upsample2x(right, true)];
}

/** 8-bar stereo tremolo-strings loop following the chord cycle. */
export function* synthMusicStrings(sr: number, rng: RandomFn): MusicGenerator<Float32Array[]> {
  const len = Math.round(8 * MUSIC_BAR * sr);
  const left = new Float32Array(len);
  const right = new Float32Array(len);
  const stereo = [left, right];
  for (let k = 0; k < 4; k++) {
    const start = k * 2 * MUSIC_BAR - 0.35;
    const trem: TremoloOptions = {
      rate: 12.8,
      depth: 0.5
    };
    addSuperSawPad(stereo, sr, midiToFreq(STRINGS_LOW_NOTES[k]), start, 2 * MUSIC_BAR - 0.15, {
      n: 4,
      det: 10,
      att: 0.9,
      rel: 0.45,
      g: 0.1,
      width: 0.9,
      pan: -0.15,
      swell: [0.5, 1],
      swp: 1.5,
      trem,
      rng
    });
    yield;
    addSuperSawPad(
      stereo,
      sr,
      midiToFreq(STRINGS_HIGH_NOTES[k]),
      start + 0.1,
      2 * MUSIC_BAR - 0.25,
      {
        n: 4,
        det: 11,
        att: 1.1,
        rel: 0.45,
        g: 0.085,
        width: 0.9,
        pan: 0.15,
        swell: [0.45, 1],
        swp: 1.5,
        trem,
        rng
      }
    );
    yield;
    addSuperSawPad(stereo, sr, midiToFreq(STRINGS_LOW_NOTES[k] - 12), start, 2 * MUSIC_BAR - 0.15, {
      n: 2,
      det: 8,
      att: 1.2,
      rel: 0.5,
      g: 0.05,
      width: 0.6,
      swell: [0.6, 1],
      rng
    });
    yield;
  }
  addSuperSawPad(stereo, sr, midiToFreq(86), 0.4, 8 * MUSIC_BAR - 2.2, {
    n: 2,
    det: 4,
    att: 3,
    rel: 0.5,
    g: 0.012,
    width: 1,
    swell: [0.7, 1],
    rng
  });
  yield;
  for (const channel of stereo) {
    lowpassSweepLooped(
      channel,
      (pos) => 2900 + 800 * Math.sin(TWO_PI * 4 * pos - 1.57) + 300 * Math.sin(TWO_PI * 3 * pos),
      0.7,
      sr
    );
    yield;
    peakingEqBank(
      channel,
      sr,
      [
        [480, 1.4, 0.3],
        [1500, 1.8, 0.28]
      ],
      true
    );
    yield;
  }
  chorusLooped(stereo, sr, 5, 11, 1.8, 0.25);
  biquadLooped(left, 'hp', 240, 0.707, sr);
  biquadLooped(right, 'hp', 240, 0.707, sr);
  return normalizeStemsRms(stereo, MUSIC_STEM_RMS.strings);
}

/** One step of a bass pattern: [sixteenth index, MIDI note, velocity]. */
type PatternStep = [number, number, number];

/** Sixteenth-note bass pattern for `bar` (0..15) of the form, transposed by `transpose`. */
function pulseBassPattern(bar: number, transpose: number): PatternStep[] {
  const chord = (bar >> 1) & 3;
  const secondHalf = bar >= 8;
  const steps: PatternStep[] = [];
  const root = 50 + transpose;
  const velocities = [
    1, 0.42, 0.52, 0.86, 0.4, 0.5, 0.8, 0.46, 0.95, 0.4, 0.52, 0.82, 0.42, 0.5, 0.76, 0.5
  ];
  for (let step = 0; step < 16; step++) {
    if (secondHalf && (step === 5 || step === 13)) continue;
    let note = root;
    let vel = velocities[step];
    if (step === 3 || step === 11) note = PULSE_PASSING_NOTES[chord] + transpose;
    else if (step === 6 || step === 14) note = PULSE_FIFTH_NOTES[chord] + 12 + transpose;
    if (secondHalf) {
      if (step === 6) note = 62 + transpose;
      if (step === 14) note = PULSE_PASSING_NOTES[chord] + transpose;
      if (step === 8) vel = 1;
    }
    if (bar === 15)
      vel = Math.min(1, 0.45 + 0.04 * step + (PULSE_ACCENT_STEPS.includes(step) ? 0.12 : 0));
    if (bar % 4 === 3 && step === 15) note = PULSE_PASSING_NOTES[chord] + transpose;
    steps.push([step, note, vel]);
  }
  return steps;
}

/** 16-bar plucked bass pulse with dotted-eighth echoes and a low square "thump" layer. */
export function* synthMusicPulse(sr: number, rng: RandomFn): MusicGenerator {
  const len = Math.round(16 * MUSIC_BAR * sr);
  const plucks = new Float32Array(len);
  const thumps = new Float32Array(len);
  const pluckCache = new Map<number, Float32Array>();
  const getPluck = (note: number, layer: number): Float32Array => {
    const key = note * 4 + layer;
    let pluck = pluckCache.get(key);
    if (!pluck) {
      pluck = karplusPluck(sr, midiToFreq(note), [0.4, 0.7, 1][layer], rng, {
        mute: 0.12 + 0.05 * layer
      });
      pluckCache.set(key, pluck);
    }
    return pluck;
  };
  const thump = (() => {
    const thumpLen = Math.round(0.3 * sr);
    const buf = new Float32Array(thumpLen);
    const freq = midiToFreq(38);
    let lp1 = 0;
    let lp2 = 0;
    for (let i = 0; i < thumpLen; i++) {
      const time = i / sr;
      const square = (time * freq) % 1 < 0.5 ? 1 : -1;
      const coef = 1 - Math.exp((-TWO_PI * (90 + 380 * Math.exp(-time / 0.05))) / sr);
      lp1 += (square - lp1) * coef;
      lp2 += (lp1 - lp2) * coef;
      buf[i] = lp2 * Math.exp(-time / 0.11) * Math.min(1, i / 60);
    }
    const fadeLen = Math.round(0.03 * sr);
    for (let i = 0; i < fadeLen; i++) buf[thumpLen - 1 - i] *= i / fadeLen;
    return buf;
  })();
  for (let bar = 0; bar < 16; bar++) {
    for (const [step, note, baseVel] of pulseBassPattern(bar, 0)) {
      const vel = baseVel * (0.93 + 0.14 * rng());
      mixIntoWrapped(
        plucks,
        getPluck(note, vel > 0.78 ? 2 : vel > 0.55 ? 1 : 0),
        bar * MUSIC_BAR + step * MUSIC_SIXTEENTH,
        0.3 * (0.35 + 0.65 * vel),
        sr
      );
    }
    mixIntoWrapped(thumps, thump, bar * MUSIC_BAR, 0.2, sr);
    mixIntoWrapped(thumps, thump, bar * MUSIC_BAR + 2 * MUSIC_BEAT, 0.14, sr);
    yield;
  }
  biquadLooped(plucks, 'hp', 115, 0.707, sr);
  const echo1 = plucks.slice();
  biquadLooped(echo1, 'lp', 1900, 0.7, sr);
  const echo2 = echo1.slice();
  biquadLooped(echo2, 'lp', 1200, 0.7, sr);
  yield;
  addLoopedEchoes(plucks, Math.round(3 * MUSIC_SIXTEENTH * sr), [
    [echo1, 0.27],
    [echo2, 0.1]
  ]);
  addBuffer(plucks, thumps);
  scaleBuffer(plucks, 1 / peakAbs(plucks));
  softClipAlgebraic(plucks, 1.6);
  return normalizeStemsRms([plucks], MUSIC_STEM_RMS.pulse)[0];
}

/** 6-bar metallic tick/hi-hat loop (6 bars so it phases against the 8/16-bar stems). */
export function* synthMusicTicks(sr: number, rng: RandomFn): MusicGenerator {
  const len = Math.round(6 * MUSIC_BAR * sr);
  const out = new Float32Array(len);
  const accentClick = modalResonators(sr, 0.06, [
    [2349.3, 0.011, 1],
    [3520, 0.006, 0.4],
    [5870, 0.004, 0.2]
  ]);
  const offClick = modalResonators(sr, 0.06, [
    [1760, 0.012, 1],
    [2637, 0.007, 0.35],
    [4186, 0.004, 0.15]
  ]);
  mixInto(
    accentClick,
    noiseBurstMusic(sr, rng, 0.004, 0.001, {
      hp: 3000
    }),
    0,
    0.5,
    sr
  );
  mixInto(
    offClick,
    noiseBurstMusic(sr, rng, 0.004, 0.001, {
      hp: 2500
    }),
    0,
    0.4,
    sr
  );
  const hats: Float32Array[] = [];
  for (let k = 0; k < 6; k++)
    hats.push(
      noiseBurstMusic(sr, rng, 0.07, 0.012 + 0.012 * (k % 3), {
        hp: 5200 + 900 * (k % 2),
        att: 0.0012
      })
    );
  const steel = renderSteelHit(sr, rng, midiToFreq(86), 0.5, 0.7);
  const hatPatterns = [
    [0.9, 0.3, 0.45, 0.7, 0.28, 0.4, 0.75, 0.3, 0.85, 0.3, 0.45, 0.7, 0.3, 0.42, 0.72, 0.4],
    [0.9, 0.25, 0.5, 0.65, 0.3, 0.3, 0.8, 0.45, 0.8, 0.25, 0.3, 0.75, 0.35, 0.5, 0.7, 0.55],
    [0.85, 0.35, 0.4, 0.75, 0.25, 0.5, 0.7, 0.25, 0.9, 0.4, 0.5, 0.65, 0.25, 0.35, 0.8, 0.6]
  ];
  for (let bar = 0; bar < 6; bar++) {
    const pattern = hatPatterns[bar % 3];
    for (let step = 0; step < 16; step++) {
      const time = bar * MUSIC_BAR + step * MUSIC_SIXTEENTH;
      if (step % 4 === 0) mixIntoWrapped(out, accentClick, time, step === 0 ? 0.42 : 0.32, sr);
      else if (step % 4 === 2) mixIntoWrapped(out, offClick, time, 0.24, sr);
      const vel = pattern[(step + (bar >= 3 ? 8 : 0)) % 16] * (0.9 + 0.2 * rng());
      mixIntoWrapped(
        out,
        hats[(step * 5 + bar) % 6],
        time + (step & 1 ? MUSIC.swing : 0),
        0.2 * vel,
        sr
      );
    }
    yield;
  }
  mixIntoWrapped(out, steel, 2 * MUSIC_BAR + 14 * MUSIC_SIXTEENTH, 0.1, sr);
  mixIntoWrapped(out, steel, 5 * MUSIC_BAR + 11 * MUSIC_SIXTEENTH, 0.08, sr);
  biquadLooped(out, 'hp', 1100, 0.707, sr);
  return normalizeStemsRms([out], MUSIC_STEM_RMS.ticks)[0];
}

/** Pre-reverberated taiko kit; `lo`/`mid`/`hi` hold [soft, hard] variants. */
interface DrumKit {
  lo: Float32Array[];
  mid: Float32Array[];
  hi: Float32Array[];
  big: Float32Array;
  steel: Float32Array;
  sr: number;
}
type DrumVoice = 'lo' | 'mid' | 'hi';

let drumKitCache: DrumKit | null = null;
let drumKitCacheUses = 0;

/** Builds (or reuses, up to 4 times) the shared drum kit for `sr`. Uses its own fixed seed. */
function getDrumKit(sr: number): DrumKit {
  if (drumKitCache && drumKitCache.sr === sr) {
    const cached = drumKitCache;
    if (++drumKitCacheUses >= 4) {
      drumKitCache = null;
      drumKitCacheUses = 0;
    }
    return cached;
  }
  const rng = mulberry32(23063 + sr);
  const withReverb = (hit: Float32Array, wet: number, opts: ReverbOptions, dur: number) => {
    const buf = new Float32Array(Math.round(dur * sr));
    buf.set(hit.subarray(0, Math.min(hit.length, buf.length)));
    return addReverb(buf, sr, wet, opts);
  };
  const roomReverb: ReverbOptions = {
    rt: 2.3,
    size: 1.25,
    damp: 0.3,
    pre: 0.022,
    hp: 170
  };
  const lo: Float32Array[] = [];
  const mid: Float32Array[] = [];
  const hi: Float32Array[] = [];
  for (const vel of [0.55, 1]) {
    lo.push(withReverb(renderTaikoHit(sr, rng, 55, vel), 0.3, roomReverb, 2));
    mid.push(withReverb(renderTaikoHit(sr, rng, 73.42, vel), 0.28, roomReverb, 1.8));
    hi.push(withReverb(renderTaikoHit(sr, rng, 110, vel), 0.26, roomReverb, 1.6));
  }
  const big = withReverb(
    renderBoomHit(sr, rng, 1),
    0.55,
    {
      rt: 3.2,
      size: 1.5,
      damp: 0.35,
      pre: 0.03,
      hp: 150
    },
    3.6
  );
  const steel = withReverb(
    renderSteelHit(sr, rng, midiToFreq(57), 1.6, 0.8),
    0.5,
    {
      rt: 2.8,
      size: 1.4,
      damp: 0.22,
      pre: 0.025,
      hp: 250
    },
    3
  );
  const kit: DrumKit = { lo, mid, hi, big, steel, sr };
  drumKitCache = kit;
  drumKitCacheUses = 1;
  return kit;
}

/** 8-bar taiko groove loop. The kit uses its own seed, so `_rng` is unused. */
export function* synthMusicDrums(sr: number, _rng: RandomFn): MusicGenerator {
  const len = Math.round(8 * MUSIC_BAR * sr);
  const out = new Float32Array(len);
  const kit = getDrumKit(sr);
  yield;
  const hit = (voice: DrumVoice, variant: number, time: number, gain: number) =>
    mixIntoWrapped(out, kit[voice][variant], time, gain, sr);
  for (let bar = 0; bar < 8; bar++) {
    const barTime = bar * MUSIC_BAR;
    const odd = bar & 1;
    const last = bar === 7;
    hit('lo', 1, barTime, 0.62);
    hit('lo', 1, barTime + 8 * MUSIC_SIXTEENTH, last ? 0.4 : 0.5);
    if (!last) {
      hit('mid', 0, barTime + 3 * MUSIC_SIXTEENTH, 0.3);
      hit('mid', 1, barTime + 6 * MUSIC_SIXTEENTH, 0.4);
      if (odd) {
        hit('hi', 1, barTime + 12 * MUSIC_SIXTEENTH, 0.36);
        hit('hi', 0, barTime + 13 * MUSIC_SIXTEENTH, 0.2);
        hit('mid', 1, barTime + 14 * MUSIC_SIXTEENTH, 0.44);
        if (bar === 3) hit('lo', 0, barTime + 15 * MUSIC_SIXTEENTH, 0.3);
      } else {
        hit('hi', 0, barTime + 11 * MUSIC_SIXTEENTH, 0.3);
        hit('mid', 1, barTime + 14 * MUSIC_SIXTEENTH, 0.42);
      }
    }
    if (bar === 0 || bar === 4) mixIntoWrapped(out, kit.big, barTime, bar === 0 ? 0.6 : 0.5, sr);
    if (bar === 2 || bar === 6)
      mixIntoWrapped(out, kit.steel, barTime + 8 * MUSIC_SIXTEENTH, bar === 2 ? 0.2 : 0.16, sr);
    yield;
  }
  biquadLooped(out, 'hp', 38, 0.707, sr, 0.6);
  return normalizeStemsRms([softClipAlgebraic(out, 1.15)], MUSIC_STEM_RMS.drums)[0];
}

/** 8-bar brass loop of short chord stabs and slow swells. */
export function* synthMusicBrass(sr: number, rng: RandomFn): MusicGenerator {
  const len = Math.round(8 * MUSIC_BAR * sr);
  const out = new Float32Array(len);
  const stab = (bar: number, step: number, vel: number) => {
    const chord = (bar >> 1) & 3;
    for (const note of BRASS_STAB_CHORDS[chord])
      mixIntoWrapped(
        out,
        renderBrassNote(sr, midiToFreq(note), 0.2, {
          vel,
          att: 0.012,
          rel: 0.07,
          n: 3,
          det: 8,
          bright: 9,
          rng
        }),
        bar * MUSIC_BAR + step * MUSIC_SIXTEENTH - 0.006,
        0.17 * (0.5 + 0.5 * vel) * (note === 38 ? 0.8 : 1),
        sr
      );
  };
  const swell = (bar: number, step: number, dur: number, vel: number) => {
    const chord = (bar >> 1) & 3;
    for (const note of BRASS_SWELL_CHORDS[chord])
      mixIntoWrapped(
        out,
        renderBrassNote(sr, midiToFreq(note), dur, {
          vel,
          att: 0.25,
          rel: 0.1,
          swell: [0.12, 1],
          swp: 2.2,
          n: 3,
          det: 9,
          bright: 7,
          rng
        }),
        bar * MUSIC_BAR + step * MUSIC_SIXTEENTH,
        0.15,
        sr
      );
  };
  stab(0, 0, 1);
  stab(0, 11, 0.6);
  yield;
  swell(1, 4, 12 * MUSIC_SIXTEENTH - 0.05, 0.9);
  yield;
  stab(2, 0, 0.9);
  stab(2, 6, 0.7);
  yield;
  stab(3, 3, 0.55);
  stab(3, 14, 0.75);
  yield;
  stab(4, 0, 1);
  stab(4, 8, 0.6);
  yield;
  swell(5, 4, 12 * MUSIC_SIXTEENTH - 0.05, 0.9);
  yield;
  stab(6, 0, 0.9);
  stab(6, 6, 0.7);
  stab(6, 11, 0.55);
  yield;
  swell(7, 0, 16 * MUSIC_SIXTEENTH - 0.05, 1);
  yield;
  biquadLooped(out, 'hp', 60, 0.707, sr, 0.5);
  peakingEqBank(out, sr, MUSIC_EQ_BANDS, true);
  scaleBuffer(out, 1 / peakAbs(out));
  softClipAlgebraic(out, 1.3);
  return normalizeStemsRms([out], MUSIC_STEM_RMS.brass)[0];
}

/** 8-bar "lift" layer: octave-up plucks with echoes plus a rising scale of tremolo pads. */
export function* synthMusicLift(sr: number, rng: RandomFn): MusicGenerator {
  const len = Math.round(8 * MUSIC_BAR * sr);
  const plucks = new Float32Array(len);
  const pads = new Float32Array(len);
  const pluckCache = new Map<number, Float32Array>();
  const getPluck = (note: number, layer: number): Float32Array => {
    const key = note * 4 + layer;
    let pluck = pluckCache.get(key);
    if (!pluck) {
      pluck = karplusPluck(sr, midiToFreq(note), [0.55, 0.8, 1][layer], rng, {
        mute: 0.1 + 0.03 * layer,
        dur: 0.4
      });
      pluckCache.set(key, pluck);
    }
    return pluck;
  };
  for (let bar = 0; bar < 8; bar++) {
    for (const [step, note, baseVel] of pulseBassPattern(bar + (bar >= 4 ? 8 : 0), 12)) {
      const vel = Math.min(1, baseVel * 1.08 * (0.93 + 0.14 * rng()));
      mixIntoWrapped(
        plucks,
        getPluck(note, vel > 0.78 ? 2 : vel > 0.55 ? 1 : 0),
        bar * MUSIC_BAR + step * MUSIC_SIXTEENTH,
        0.22 * (0.4 + 0.6 * vel),
        sr
      );
    }
    yield;
  }
  biquadLooped(plucks, 'hp', 230, 0.707, sr);
  [74, 76, 77, 79, 81, 82, 84, 86].forEach((note, bar) => {
    addSuperSawPad([pads], sr, midiToFreq(note), bar * MUSIC_BAR - 0.12, MUSIC_BAR - 0.1, {
      n: 3,
      det: 11,
      att: 0.35,
      rel: 0.3,
      g: 0.1,
      swell: [0.55, 1],
      swp: 1.4,
      trem: {
        rate: 12.8,
        depth: 0.4
      },
      rng
    });
    addSuperSawPad([pads], sr, midiToFreq(note - 12), bar * MUSIC_BAR - 0.12, MUSIC_BAR - 0.1, {
      n: 2,
      det: 8,
      att: 0.4,
      rel: 0.3,
      g: 0.06,
      swell: [0.6, 1],
      rng
    });
  });
  yield;
  lowpassSweepLooped(pads, (pos) => 3300 + 900 * Math.sin(TWO_PI * pos - 1.57), 0.7, sr);
  biquadLooped(pads, 'hp', 300, 0.707, sr);
  yield;
  const echo = plucks.slice();
  biquadLooped(echo, 'lp', 2600, 0.7, sr);
  addLoopedEchoes(plucks, Math.round(3 * MUSIC_SIXTEENTH * sr), [[echo, 0.22]]);
  return normalizeStemsRms([addBuffer(plucks, pads)], MUSIC_STEM_RMS.lift)[0];
}

const STING_REVERB: ReverbOptions = {
  rt: 3,
  size: 1.45,
  damp: 0.3,
  pre: 0.03,
  hp: 200
};

/** Two-note piano motif cell `variant` (index into MUSIC.cells). */
export function* synthMusCell(sr: number, rng: RandomFn, variant: number): MusicGenerator {
  const out = allocSamples(sr, 5.4);
  const [first, second] = MUSIC.cells[variant];
  mixInto(out, renderPianoNote(sr, midiToFreq(first), 0.62, 3.2, rng), 0.002, 0.55, sr);
  yield;
  mixInto(
    out,
    renderPianoNote(sr, midiToFreq(second), 0.8, 4.3, rng),
    MUSIC.cellSecond + 0.002,
    0.6,
    sr
  );
  mixInto(
    out,
    renderPianoNote(sr, midiToFreq(second - 12), 0.5, 4, rng),
    MUSIC.cellSecond + 0.002,
    0.2,
    sr
  );
  yield;
  addReverb(out, sr, 0.5, STING_REVERB);
  return out;
}

/** Two-note brass (horn) motif cell `variant`, doubled an octave below. */
export function* synthMusHorn(sr: number, rng: RandomFn, variant: number): MusicGenerator {
  const out = allocSamples(sr, 4.8);
  const [first, second] = MUSIC.cells[variant];
  for (const octave of [-12, 0]) {
    mixInto(
      out,
      renderBrassNote(sr, midiToFreq(first + octave), MUSIC.cellSecond - 0.1, {
        vel: 0.7,
        att: 0.05,
        rel: 0.09,
        n: 4,
        det: 8,
        bright: 6.5,
        rng
      }),
      0,
      octave ? 0.3 : 0.36,
      sr
    );
    yield;
    mixInto(
      out,
      renderBrassNote(sr, midiToFreq(second + octave), 2.5, {
        vel: 0.9,
        att: 0.07,
        rel: 0.25,
        swell: [0.75, 1],
        swp: 0.7,
        n: 4,
        det: 9,
        bright: 6.5,
        rng
      }),
      MUSIC.cellSecond,
      octave ? 0.34 : 0.4,
      sr
    );
    yield;
  }
  biquad(out, 'hp', 110, 0.707, sr);
  peakingEqBank(out, sr, MUSIC_EQ_BANDS);
  addReverb(out, sr, 0.3, {
    rt: 2.4,
    size: 1.3,
    damp: 0.3,
    pre: 0.025,
    hp: 220
  });
  return out;
}

/** One-bar drum fill (`variant` 0..2) using the shared drum kit. */
export function* synthMusFill(sr: number, _rng: RandomFn, variant: number): MusicGenerator {
  const out = allocSamples(sr, MUSIC_BAR + 1.1);
  const kit = getDrumKit(sr);
  yield;
  const hit = (voice: DrumVoice, kitVariant: number, step: number, gain: number) =>
    mixInto(out, kit[voice][kitVariant], step * MUSIC_SIXTEENTH, gain, sr);
  if (variant === 0) {
    [8, 9, 10, 11, 12, 13, 14, 15].forEach((step, k) =>
      hit(k < 4 ? 'mid' : 'lo', k % 2 ? 0 : 1, step, 0.28 + 0.06 * k)
    );
    hit('hi', 1, 6, 0.4);
  } else if (variant === 1) {
    hit('hi', 1, 0, 0.4);
    hit('hi', 0, 2, 0.26);
    hit('hi', 1, 3, 0.42);
    hit('mid', 1, 6, 0.46);
    hit('mid', 0, 8, 0.3);
    hit('mid', 1, 9, 0.48);
    hit('lo', 1, 12, 0.56);
    hit('lo', 0, 14, 0.4);
    hit('lo', 1, 15, 0.6);
  } else {
    hit('lo', 1, 8, 0.5);
    hit('mid', 1, 11, 0.5);
    hit('hi', 1, 12, 0.4);
    hit('hi', 1, 13, 0.46);
    hit('lo', 1, 14, 0.62);
    hit('lo', 0, 15, 0.42);
    mixInto(out, kit.steel, 4 * MUSIC_SIXTEENTH, 0.2, sr);
  }
  const fadeStart = out.length - Math.round(0.35 * sr);
  for (let i = fadeStart; i < out.length; i++)
    out[i] *= 1 - (i - fadeStart) / (out.length - fadeStart);
  return softClipAlgebraic(out, 1.1);
}

/** Boom hit; variant 1 adds steel strikes and a brighter filter. */
export function* synthMusHit(sr: number, rng: RandomFn, variant: number): MusicGenerator {
  const out = allocSamples(sr, 4.6);
  mixInto(out, renderBoomHit(sr, rng, 1.2), 0.03, variant ? 0.5 : 0.9, sr);
  yield;
  if (variant) {
    mixInto(out, renderSteelHit(sr, rng, midiToFreq(45), 2.6, 0.55), 0.03, 0.4, sr);
    mixInto(out, renderSteelHit(sr, rng, midiToFreq(50) * 1.012, 2.2, 0.5), 0.09, 0.22, sr);
    yield;
  }
  biquad(out, 'lp', variant ? 1500 : 500, 0.7, sr);
  addReverb(out, sr, 1.1, {
    rt: 3.6,
    size: 1.6,
    damp: 0.4,
    pre: 0.045,
    hp: 120
  });
  return out;
}

/**
 * Riser body: five detuned saws gliding up an octave towards `peakTime`, written into `out`;
 * also applies the matching swell envelope to `noise` in place.
 */
function renderRiserSaws(
  out: Float32Array,
  noise: Float32Array,
  sr: number,
  peakTime: number,
  rng: RandomFn
): void {
  const len = out.length;
  const phases = [rng(), rng(), rng(), rng(), rng()];
  const detunes = [-11, -5, 0, 6, 12].map((cents) => Math.pow(2, cents / 1200) / sr);
  let tremPhase = 0;
  let freq = 0;
  let sawGain = 0;
  let noiseGain = 0;
  for (let i = 0; i < len; i++) {
    if ((i & 15) === 0) {
      const time = i / sr;
      const progress = Math.min(1, time / peakTime);
      freq = midiToFreq(50) * Math.pow(2, Math.pow(progress, 1.8));
      tremPhase += (16 * (3.2 + 9.6 * progress * progress)) / sr;
      sawGain =
        (time < peakTime ? Math.pow(progress, 2.2) : Math.exp(-(time - peakTime) / 0.07)) *
        (1 - 0.3 * (0.5 - 0.5 * Math.cos(TWO_PI * tremPhase)) * progress) *
        0.2;
      noiseGain =
        (time < peakTime ? Math.pow(progress, 2.6) : Math.exp(-(time - peakTime) / 0.05)) * 1.6;
    }
    let sum = 0;
    for (let v = 0; v < 5; v++) {
      const inc = freq * detunes[v];
      let phase = phases[v] + inc;
      if (phase >= 1) phase -= 1;
      phases[v] = phase;
      let saw = phase + phase - 1;
      if (phase < inc) {
        const t = phase / inc;
        saw -= t + t - t * t - 1;
      } else if (phase > 1 - inc) {
        const t = (phase - 1) / inc;
        saw -= t * t + t + t + 1;
      }
      sum += saw;
    }
    out[i] = sum * sawGain;
    noise[i] *= noiseGain;
  }
}

/** Riser that peaks at MUSIC.riserPeak seconds (sweeping noise + gliding saws). */
export function* synthMusRiser(sr: number, rng: RandomFn): MusicGenerator {
  const peakTime = MUSIC.riserPeak;
  const out = allocSamples(sr, peakTime + 0.6);
  const len = out.length;
  const noise = noiseBuffer(sr, peakTime + 0.6, rng);
  biquadSweep(
    noise,
    'bp',
    (pos: number) => 320 * Math.pow(18, Math.min(1, (pos * (peakTime + 0.6)) / peakTime)),
    1.3,
    sr
  );
  yield;
  const saws = new Float32Array(len);
  renderRiserSaws(saws, noise, sr, peakTime, rng);
  yield;
  biquadSweep(
    saws,
    'lp',
    (pos: number) => 350 * Math.pow(11, Math.min(1, (pos * (peakTime + 0.6)) / peakTime)),
    0.9,
    sr
  );
  biquad(saws, 'hp', 200, 0.707, sr);
  for (let i = 0; i < len; i++) out[i] = saws[i] + noise[i];
  return out;
}

/** Big impact: boom, taiko, steel and a falling brass cluster. */
export function* synthMusImpact(sr: number, rng: RandomFn): MusicGenerator {
  const out = allocSamples(sr, 5);
  mixInto(out, renderBoomHit(sr, rng, 1.25), 0, 1, sr);
  mixInto(out, renderTaikoHit(sr, rng, 55, 1), 0, 0.7, sr);
  yield;
  mixInto(out, renderSteelHit(sr, rng, midiToFreq(50), 2.4, 0.9), 0, 0.3, sr);
  mixInto(out, renderSteelHit(sr, rng, midiToFreq(57) * 0.99, 1.8, 0.8), 0.004, 0.16, sr);
  yield;
  const brass = allocSamples(sr, 4);
  for (const [note, gain] of [
    [38, 1],
    [45, 0.8],
    [50, 0.9],
    [57, 0.5]
  ]) {
    mixInto(
      brass,
      renderBrassNote(sr, midiToFreq(note), 1.3, {
        vel: 1,
        att: 0.02,
        rel: 0.4,
        swell: [1, 0.3],
        swp: 0.5,
        n: 5,
        det: 12,
        bright: 7,
        scoop: -60,
        rng
      }),
      0,
      0.24 * gain,
      sr
    );
    yield;
  }
  mixInto(out, peakingEqBank(brass, sr, MUSIC_EQ_BANDS), 0, 1, sr);
  addReverb(out, sr, 0.45, {
    rt: 3.4,
    size: 1.55,
    damp: 0.3,
    pre: 0.03,
    hp: 160
  });
  return softClipAlgebraic(out, 1.3);
}

/** Objective-complete sting: resolving piano phrase over a soft brass chord. */
export function* synthObjectiveSting(sr: number, rng: RandomFn): MusicGenerator {
  const out = allocSamples(sr, 5);
  mixInto(out, renderPianoNote(sr, midiToFreq(65), 0.7, 1.6, rng), 0.002, 0.6, sr);
  mixInto(
    out,
    renderPianoNote(sr, midiToFreq(64), 0.7, 1.6, rng),
    0.002 + MUSIC_BEAT / 2,
    0.58,
    sr
  );
  yield;
  mixInto(out, renderPianoNote(sr, midiToFreq(62), 0.9, 4.2, rng), 0.002 + MUSIC_BEAT, 0.72, sr);
  mixInto(out, renderPianoNote(sr, midiToFreq(50), 0.6, 4, rng), 0.002 + MUSIC_BEAT, 0.3, sr);
  mixInto(
    out,
    renderPianoNote(sr, midiToFreq(74), 0.55, 3, rng),
    0.002 + MUSIC_BEAT * 2.5,
    0.3,
    sr
  );
  yield;
  const brass = allocSamples(sr, 4.6);
  for (const [note, gain] of [
    [50, 1],
    [57, 0.9],
    [62, 0.8]
  ]) {
    mixInto(
      brass,
      renderBrassNote(sr, midiToFreq(note), 1.9, {
        vel: 0.55,
        att: 0.3,
        rel: 0.5,
        swell: [0.6, 1],
        swp: 0.8,
        n: 4,
        det: 8,
        bright: 5,
        scoop: 0,
        rng
      }),
      MUSIC_BEAT - 0.1,
      0.2 * gain,
      sr
    );
    yield;
  }
  mixInto(out, peakingEqBank(brass, sr, MUSIC_EQ_BANDS), 0, 1, sr);
  mixInto(out, renderBoomHit(sr, rng, 1), MUSIC_BEAT, 0.3, sr);
  addReverb(out, sr, 0.5, STING_REVERB);
  return out;
}

/** Death chord: three detuned saws per note, all sagging down ~16 semitones over 4 s. */
function renderDeathChordSaws(out: Float32Array, sr: number, notes: number[], rng: RandomFn): void {
  const len = out.length;
  const phases: number[] = [];
  const incs: number[] = [];
  for (let v = 0; v < notes.length * 3; v++) {
    phases.push(rng());
    incs.push(
      (midiToFreq(notes[(v / 3) | 0]) *
        Math.pow(2, (((v % 3) - 1) * 9 + (rng() - 0.5) * 4) / 1200)) /
        sr
    );
  }
  let pitchMul = 1;
  let gain = 0;
  for (let i = 0; i < len; i++) {
    if ((i & 15) === 0) {
      const time = i / sr;
      pitchMul = Math.pow(2, (-16 / 12) * Math.pow(Math.min(1, time / 4.2), 1.35));
      gain = 0.07 * (1 - Math.exp(-time / 0.03)) * Math.pow(Math.max(0, 1 - time / 4.4), 1.2);
    }
    let sum = 0;
    for (let v = 0; v < phases.length; v++) {
      const inc = incs[v] * pitchMul;
      let phase = phases[v] + inc;
      if (phase >= 1) phase -= 1;
      phases[v] = phase;
      let saw = phase + phase - 1;
      if (phase < inc) {
        const t = phase / inc;
        saw -= t + t - t * t - 1;
      } else if (phase > 1 - inc) {
        const t = (phase - 1) / inc;
        saw -= t * t + t + t + 1;
      }
      sum += saw;
    }
    out[i] = sum * gain;
  }
}

/** Player-death sting: collapsing saw chord, boom and a long sub drop. */
export function* synthDeathSting(sr: number, rng: RandomFn): MusicGenerator {
  const out = allocSamples(sr, 5.2);
  const chord = allocSamples(sr / 2, 5.2);
  const notes = [50, 57, 62, 65];
  renderDeathChordSaws(chord, sr / 2, notes, rng);
  yield;
  biquadSweep(chord, 'lp', expRamp(2400, 140, 0.6), 0.9, sr / 2);
  biquad(chord, 'hp', 60, 0.707, sr / 2);
  mixInto(out, upsample2x(chord, false), 0, 1, sr);
  mixInto(out, renderBoomHit(sr, rng, 1.2), 0, 0.75, sr);
  mixInto(out, pitchDropSineMusic(sr, 2.6, 98, 41, 0.9, 0.9, 0.004), 0.02, 0.4, sr);
  yield;
  addReverb(out, sr, 0.5, {
    rt: 3.4,
    size: 1.5,
    damp: 0.4,
    pre: 0.03,
    hp: 150
  });
  return out;
}

/** Mission-complete finale: Bb - C - Dm pad progression with brass, piano melody and booms. */
export function* synthCompleteSting(sr: number, rng: RandomFn): MusicGenerator {
  const out = allocSamples(sr, 12.5);
  const padBuf = allocSamples(sr / 2, 12.5);
  const padChannels = [padBuf];
  const padChord = (
    start: number,
    dur: number,
    notes: number[],
    gain: number,
    swell: [number, number]
  ) => {
    for (const note of notes)
      addSuperSawPad(padChannels, sr / 2, midiToFreq(note), start - 0.25, dur, {
        n: 3,
        det: 9,
        att: 0.5,
        rel: 0.7,
        g: gain * (note < 48 ? 1.1 : 0.8),
        swell,
        tail: 2.2,
        rng
      });
  };
  padChord(0, MUSIC_BAR, [46, 53, 58, 62], 0.075, [0.7, 1]);
  yield;
  padChord(MUSIC_BAR, MUSIC_BAR, [48, 55, 60, 64], 0.08, [0.75, 1]);
  yield;
  padChord(2 * MUSIC_BAR, 2.6 * MUSIC_BAR, [38, 45, 50, 57, 62], 0.085, [1, 0.5]);
  yield;
  biquadSweep(padBuf, 'lp', (pos: number) => 1700 - 700 * pos, 0.75, sr / 2);
  biquad(padBuf, 'hp', 45, 0.707, sr / 2);
  mixInto(out, upsample2x(padBuf, false), 0, 1, sr);
  yield;
  const brass = allocSamples(sr, 12.5);
  for (const [note, gain] of [
    [46, 0.8],
    [58, 1]
  ])
    mixInto(
      brass,
      renderBrassNote(sr, midiToFreq(note), MUSIC_BAR - 0.2, {
        vel: 0.6,
        att: 0.2,
        rel: 0.2,
        swell: [0.6, 1],
        n: 3,
        det: 8,
        bright: 5,
        scoop: 0,
        rng
      }),
      0,
      0.13 * gain,
      sr
    );
  for (const [note, gain] of [
    [48, 0.8],
    [60, 1]
  ])
    mixInto(
      brass,
      renderBrassNote(sr, midiToFreq(note), MUSIC_BAR - 0.2, {
        vel: 0.7,
        att: 0.2,
        rel: 0.2,
        swell: [0.65, 1],
        n: 3,
        det: 8,
        bright: 5.5,
        scoop: 0,
        rng
      }),
      MUSIC_BAR,
      0.14 * gain,
      sr
    );
  yield;
  for (const [note, gain] of [
    [38, 0.9],
    [50, 1],
    [57, 0.8]
  ])
    mixInto(
      brass,
      renderBrassNote(sr, midiToFreq(note), 2 * MUSIC_BAR, {
        vel: 0.7,
        att: 0.1,
        rel: 0.8,
        swell: [1, 0.3],
        swp: 0.8,
        n: 3,
        det: 8,
        bright: 5,
        scoop: -20,
        rng
      }),
      2 * MUSIC_BAR,
      0.15 * gain,
      sr
    );
  mixInto(out, peakingEqBank(brass, sr, MUSIC_EQ_BANDS), 0, 1, sr);
  yield;
  const piano = (time: number, note: number, vel: number, decay: number, gain: number) =>
    mixInto(out, renderPianoNote(sr, midiToFreq(note), vel, decay, rng), time + 0.002, gain, sr);
  piano(0, 65, 0.7, 2.6, 0.5);
  piano(2 * MUSIC_BEAT, 67, 0.72, 2.4, 0.5);
  piano(MUSIC_BAR, 69, 0.85, 3.4, 0.6);
  piano(MUSIC_BAR, 57, 0.5, 3, 0.2);
  yield;
  piano(2 * MUSIC_BAR, 62, 0.9, 5.5, 0.7);
  piano(2 * MUSIC_BAR, 50, 0.7, 5.5, 0.4);
  piano(2 * MUSIC_BAR + MUSIC.cellSecond, 69, 0.7, 5, 0.5);
  piano(3 * MUSIC_BAR, 74, 0.6, 4.5, 0.4);
  piano(3 * MUSIC_BAR + 2 * MUSIC_BEAT, 78, 0.45, 4.4, 0.3);
  yield;
  mixInto(out, renderBoomHit(sr, rng, 1), 0, 0.35, sr);
  mixInto(out, renderTaikoHit(sr, rng, 55, 0.8), MUSIC_BAR, 0.3, sr);
  mixInto(out, renderBoomHit(sr, rng, 1.25), 2 * MUSIC_BAR, 0.6, sr);
  addReverb(out, sr, 0.5, {
    rt: 3.6,
    size: 1.55,
    damp: 0.3,
    pre: 0.03,
    hp: 190
  });
  const fadeStart = Math.round(10.4 * sr);
  for (let i = fadeStart; i < out.length; i++)
    out[i] *= Math.pow(1 - (i - fadeStart) / (out.length - fadeStart), 1.5);
  return out;
}
