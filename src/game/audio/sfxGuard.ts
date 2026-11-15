// Human guard sound synthesis: carbine report, boot steps, bullet hits on a body, the
// rifle-shouldering telegraph, the body fall on death and the garbled shoulder-radio call
// (used for spotting the player and for calling support). All generated offline from noise,
// sines and resonators like the rest of the sound table.
import {
  allocSamples,
  applyEnvelope,
  biquad,
  biquadSweep,
  chirp,
  crackleBurst,
  expDecay,
  expRamp,
  metalClick,
  mixInto,
  modalResonators,
  noiseBuffer,
  noiseBurst,
  normalize,
  pitchDropSine,
  softClip
} from './dsp';
import type { RandomFn } from './dsp';

/** Guard carbine shot heard from a distance: sharp crack, chesty thump and a short slap. */
export function synthGuardFire(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.55);
  const pitch = [1, 0.95, 1.05][variant % 3];
  mixInto(out, noiseBurst(sr, rng, 0.012, 0.0018, { hp: 3200 }), 0, 1, sr);
  mixInto(out, pitchDropSine(sr, 0.16, 190 * pitch, 62 * pitch, 0.012, 0.035, 4e-4), 0, 1, sr);
  mixInto(out, noiseBurst(sr, rng, 0.09, 0.016, { bp: 900 * pitch, q: 0.9 }), 0.001, 0.75, sr);
  mixInto(out, noiseBurst(sr, rng, 0.05, 0.008, { bp: 2400 * pitch, q: 1.2 }), 0.001, 0.4, sr);
  // Outdoor slap / short tail.
  const tail = noiseBuffer(sr, 0.45, rng);
  biquadSweep(tail, 'lp', expRamp(2600, 500), 0.7, sr);
  applyEnvelope(tail, sr, expDecay(0.11, 0.004));
  mixInto(out, normalize(tail), 0.02, 0.32, sr);
  mixInto(out, noiseBurst(sr, rng, 0.06, 0.012, { lp: 1400 }), 0.085, 0.18, sr);
  return softClip(out, 1.6);
}

/** Boot on wet concrete: heel thump, scuff and a little grit. */
export function synthGuardStep(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.28);
  const pitch = [1, 1.08, 0.93, 1.03][variant & 3];
  mixInto(out, pitchDropSine(sr, 0.07, 120 * pitch, 60 * pitch, 0.016, 0.022, 0.002), 0, 0.8, sr);
  mixInto(out, noiseBurst(sr, rng, 0.07, 0.018, { lp: 900 * pitch }), 0, 0.9, sr);
  mixInto(out, noiseBurst(sr, rng, 0.1, 0.03, { bp: 2200 * pitch, q: 0.8, att: 0.006 }), 0.015, 0.25, sr);
  // Gear jingle (sling swivel).
  if (variant % 2 === 0) {
    mixInto(
      out,
      metalClick(sr, rng, [
        [3100 * pitch, 0.012, 1],
        [4700 * pitch, 0.008, 0.6]
      ]),
      0.03,
      0.06,
      sr
    );
  }
  return out;
}

/** Bullet hitting a body: dull wet thwack plus fabric snap, no metal ring. */
export function synthImpactFlesh(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.22);
  const pitch = [1, 1.1, 0.9][variant % 3];
  mixInto(out, pitchDropSine(sr, 0.1, 210 * pitch, 80 * pitch, 0.01, 0.025, 3e-4), 0, 1, sr);
  mixInto(out, noiseBurst(sr, rng, 0.06, 0.012, { lp: 1100 * pitch }), 0, 0.9, sr);
  mixInto(out, noiseBurst(sr, rng, 0.02, 0.004, { hp: 2500 }), 0, 0.35, sr);
  const squelch = noiseBuffer(sr, 0.08, rng);
  biquadSweep(squelch, 'bp', expRamp(700 * pitch, 260 * pitch), 2.2, sr);
  applyEnvelope(squelch, sr, expDecay(0.02, 0.002));
  mixInto(out, normalize(squelch), 0.006, 0.4, sr);
  return out;
}

/** Rifle being shouldered: sling rustle, stock knock and a safety click. */
export function synthGuardReady(sr: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 0.4);
  const rustle = noiseBuffer(sr, 0.22, rng);
  biquadSweep(rustle, 'bp', expRamp(1800, 3400), 0.7, sr);
  for (let i = 0; i < rustle.length; i++) {
    const t = i / sr;
    rustle[i] *= Math.sin(Math.PI * Math.min(1, t / 0.22)) * (0.6 + 0.4 * Math.sin(t * 90));
  }
  mixInto(out, normalize(rustle), 0, 0.35, sr);
  mixInto(out, pitchDropSine(sr, 0.06, 260, 140, 0.01, 0.015), 0.16, 0.5, sr);
  mixInto(
    out,
    metalClick(sr, rng, [
      [2650, 0.01, 1],
      [4100, 0.007, 0.7],
      [6900, 0.004, 0.4]
    ]),
    0.24,
    0.7,
    sr
  );
  return out;
}

/** Guard killed: grunt-less body fall, kit rattle and the rifle clattering on concrete. */
export function synthGuardDie(sr: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 1.3);
  // Knees hitting the ground, then the body.
  mixInto(out, pitchDropSine(sr, 0.12, 110, 55, 0.02, 0.04), 0.3, 0.6, sr);
  mixInto(out, noiseBurst(sr, rng, 0.08, 0.02, { lp: 600 }), 0.3, 0.5, sr);
  mixInto(out, pitchDropSine(sr, 0.2, 95, 42, 0.03, 0.06), 0.72, 1, sr);
  mixInto(out, noiseBurst(sr, rng, 0.16, 0.04, { lp: 800 }), 0.72, 0.9, sr);
  mixInto(out, crackleBurst(sr, rng, 0.25, 14, { hp: 2500, ampFall: 0.1 }), 0.72, 0.3, sr);
  // Rifle clatter: a few bounces of a light metal/polymer body.
  for (const [time, gain, pitch] of [
    [0.78, 1, 1],
    [0.9, 0.55, 1.12],
    [0.98, 0.3, 0.94]
  ]) {
    mixInto(
      out,
      modalResonators(
        sr,
        0.18,
        [
          [930 * pitch, 0.03, 1],
          [2140 * pitch, 0.02, 0.6],
          [3870 * pitch, 0.012, 0.4]
        ],
        rng
      ),
      time,
      gain * 0.28,
      sr
    );
    mixInto(out, noiseBurst(sr, rng, 0.03, 0.006, { hp: 1500 }), time, gain * 0.3, sr);
  }
  return softClip(out, 1.3);
}

/**
 * Shoulder-radio transmission: squelch, a burst of band-limited babble (formant-filtered
 * pulse train with a wandering pitch, chopped into syllables) and the closing squelch.
 * Variant 0 is a short spotting call, variant 1 a longer call for support.
 */
export function synthGuardRadio(sr: number, rng: RandomFn, variant: number): Float32Array {
  const talk = variant % 2 === 0 ? 0.55 : 1.15;
  const total = talk + 0.4;
  const out = allocSamples(sr, total);
  // Key-up click and squelch.
  mixInto(out, noiseBurst(sr, rng, 0.06, 0.02, { bp: 2600, q: 0.8 }), 0, 0.5, sr);
  mixInto(out, chirp(sr, 0.03, 1900, 1900), 0.0, 0.08, sr);
  // Babble.
  const voice = allocSamples(sr, talk);
  let phase = 0;
  let syllableEnd = 0;
  let syllableStart = 0;
  let f0 = 140;
  let gate = 0;
  for (let i = 0; i < voice.length; i++) {
    const t = i / sr;
    if (t >= syllableEnd) {
      syllableStart = t + rng() * 0.04;
      syllableEnd = syllableStart + 0.07 + rng() * 0.13;
      f0 = 115 + rng() * 60;
    }
    const inSyl = t >= syllableStart && t < syllableEnd;
    const sylPos = inSyl ? (t - syllableStart) / (syllableEnd - syllableStart) : 0;
    gate += ((inSyl ? Math.sin(Math.PI * sylPos) : 0) - gate) * 0.02;
    phase += (f0 * (1 + 0.15 * Math.sin(t * 7)) * (1 - sylPos * 0.15)) / sr;
    const pulse = phase - Math.floor(phase) < 0.12 ? 1 : -0.14;
    voice[i] = (pulse + (rng() * 2 - 1) * 0.35) * gate;
  }
  // Two moving formants and the radio band-pass.
  const formA = voice.slice();
  const formB = voice.slice();
  biquadSweep(formA, 'bp', (p: number) => 520 + 300 * Math.sin(p * 40), 4, sr);
  biquadSweep(formB, 'bp', (p: number) => 1500 + 500 * Math.sin(p * 29 + 1), 5, sr);
  for (let i = 0; i < voice.length; i++) voice[i] = formA[i] + formB[i] * 0.7;
  biquad(voice, 'hp', 380, 0.8, sr);
  biquad(voice, 'lp', 2900, 0.8, sr);
  const voiceNorm = normalize(voice);
  for (let i = 0; i < voiceNorm.length; i++) {
    voiceNorm[i] = Math.tanh(voiceNorm[i] * 2.4) * 0.8;
  }
  mixInto(out, voiceNorm, 0.06, 0.8, sr);
  // Carrier hiss under the voice.
  const hiss = noiseBuffer(sr, talk, rng);
  biquad(hiss, 'bp', 2200, 0.6, sr);
  applyEnvelope(hiss, sr, (t: number) => (t < talk ? 1 : 0));
  mixInto(out, normalize(hiss), 0.06, 0.08, sr);
  // Closing squelch tail.
  mixInto(out, noiseBurst(sr, rng, 0.18, 0.05, { bp: 3000, q: 0.7 }), talk + 0.06, 0.45, sr);
  for (let i = 0; i < out.length; i++) {
    out[i] *= 1 - Math.exp(-(i / sr) / 0.002);
  }
  return out;
}
