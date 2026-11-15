// World and ambience sound synthesis: footsteps, landing/jump/hurt, bullet impacts per
// surface, enemy (gull drone / hound walker) loops and deaths, alerts, environment one-shots
// (thunder, foghorn, gulls, halyards), UI clicks, looping beds (rain, wind, sea), impulse
// responses for the convolver, plus the music entries of the sound table.
import {
  TWO_PI,
  allocSamples,
  applyEnvelope,
  biquad,
  biquadSweep,
  chirp,
  crackleBurst,
  crossfadeLoop,
  expDecay,
  expRamp,
  loopedNoise,
  mixBuffers,
  mixInto,
  mixIntoWrapped,
  modalResonators,
  mulberry32,
  noiseBuffer,
  noiseBurst,
  pitchDropSine,
  randRange,
  scaleBuffer,
  softClip
} from './dsp';
import type { RandomFn, SoundDef, SoundGenerator } from './dsp';
import {
  MUSIC,
  MUSIC_SR,
  MUSIC_SR_LO,
  synthCompleteSting,
  synthDeathSting,
  synthMusCell,
  synthMusFill,
  synthMusHit,
  synthMusHorn,
  synthMusImpact,
  synthMusRiser,
  synthMusicBrass,
  synthMusicDrone,
  synthMusicDrums,
  synthMusicLift,
  synthMusicPulse,
  synthMusicStrings,
  synthMusicTicks,
  synthObjectiveSting
} from './music';
import type { MusicGenerator } from './music';

/** Builds the sound-table entry for a looping music stem. */
export const musicLoopEntry = (gen: SoundGenerator, sr: number): SoundDef => ({
  gen,
  n: 1,
  sr,
  peak: 0.9,
  fixed: 1,
  loop: 1,
  music: 1
});
/** Builds the sound-table entry for a music sting with `variants` variants. */
export const musicStingEntry = (
  gen: SoundGenerator,
  variants: number,
  sr: number,
  peak: number,
  maxVoices = 2
): SoundDef => ({
  gen,
  n: variants,
  sr,
  peak,
  bus: 'music',
  max: maxVoices,
  pri: 9
});
/** Music stems and stings, merged into the main sound table. */
export const MUSIC_SOUNDS = {
  music_drone: musicLoopEntry(synthMusicDrone, MUSIC_SR),
  music_strings: musicLoopEntry(synthMusicStrings, MUSIC_SR),
  music_pulse: musicLoopEntry(synthMusicPulse, MUSIC_SR_LO),
  music_ticks: musicLoopEntry(synthMusicTicks, MUSIC_SR),
  music_drums: musicLoopEntry(synthMusicDrums, MUSIC_SR_LO),
  music_brass: musicLoopEntry(synthMusicBrass, MUSIC_SR_LO),
  music_lift: musicLoopEntry(synthMusicLift, MUSIC_SR),
  mus_cell: musicStingEntry(synthMusCell, 4, MUSIC_SR, 0.5),
  mus_horn: musicStingEntry(synthMusHorn, 4, MUSIC_SR, 0.6),
  mus_fill: musicStingEntry(synthMusFill, 3, MUSIC_SR_LO, 0.6),
  mus_hit: musicStingEntry(synthMusHit, 2, MUSIC_SR, 0.6),
  mus_riser: musicStingEntry(synthMusRiser, 1, MUSIC_SR, 0.6, 1),
  mus_impact: musicStingEntry(synthMusImpact, 1, MUSIC_SR, 0.8, 1),
  objective: musicStingEntry(synthObjectiveSting, 1, MUSIC_SR, 0.7, 1),
  death: musicStingEntry(synthDeathSting, 1, MUSIC_SR, 0.85, 1),
  complete: musicStingEntry(synthCompleteSting, 1, MUSIC_SR, 0.8, 1)
};
/** Names of the looping music stems (keys of MUSIC.loops). */
export const MUSIC_LOOP_NAMES = Object.keys(MUSIC.loops);

/** Footstep on concrete (variant picks one of four pitches). */
export function synthStepConcrete(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.3);
  const pitch = [1, 1.07, 0.94, 1.03][variant & 3];
  mixInto(out, pitchDropSine(sr, 0.06, 112 * pitch, 58 * pitch, 0.018, 0.02, 0.002), 0, 0.75, sr);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.06, 0.016, {
      lp: 720 * pitch
    }),
    0,
    0.9,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.1, 0.028, {
      bp: 2500 * pitch,
      q: 0.7,
      att: 0.004
    }),
    0.012,
    0.22,
    sr
  );
  const grit = noiseBurst(sr, rng, 0.2, 0.05, {
    hp: 3800,
    att: 0.01
  });
  let gate = 1;
  for (let i = 0; i < grit.length; i++) {
    if (i % 70 === 0) gate = 0.3 + rng() * 0.7;
    grit[i] *= gate;
  }
  mixInto(out, grit, 0.02, 0.16, sr);
  return out;
}

/** Water splash: swept noise body, spray and random droplet chirps; `size` scales it. */
function splashNoise(sr: number, rng: RandomFn, dur: number, size: number): Float32Array {
  const out = allocSamples(sr, dur);
  const body = noiseBuffer(sr, dur * 0.9, rng);
  biquadSweep(body, 'bp', expRamp(1500, 520), 0.8, sr);
  mixInto(out, applyEnvelope(body, sr, expDecay(0.085 * size, 0.007)), 0, 0.9, sr);
  mixInto(
    out,
    noiseBurst(sr, rng, dur * 0.8, 0.07 * size, {
      hp: 3000,
      att: 0.012
    }),
    0.01,
    0.25,
    sr
  );
  const drops = Math.round(5 * size);
  for (let i = 0; i < drops; i++) {
    const freq = randRange(rng, 500, 1700);
    mixInto(
      out,
      chirp(sr, randRange(rng, 0.008, 0.02), freq, freq * randRange(rng, 1.3, 1.9)),
      randRange(rng, 0.03, dur * 0.6),
      randRange(rng, 0.1, 0.3),
      sr
    );
  }
  return out;
}

/** Footstep in shallow water. */
export function synthStepWater(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = splashNoise(sr, rng, 0.46, 1 + variant * 0.08);
  mixInto(out, pitchDropSine(sr, 0.06, 100, 55, 0.02, 0.02, 0.002), 0, 0.5, sr);
  return out;
}

/** Footstep on a metal deck. */
export function synthStepMetal(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.38);
  const pitch = [1, 1.08, 0.92][variant % 3];
  mixInto(out, pitchDropSine(sr, 0.06, 120, 62, 0.018, 0.02, 0.002), 0, 0.6, sr);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.04, 0.008, {
      lp: 2400
    }),
    0,
    0.6,
    sr
  );
  mixInto(
    out,
    modalResonators(
      sr,
      0.36,
      [
        [178 * pitch, 0.09, 1],
        [412 * pitch, 0.075, 0.8],
        [733 * pitch, 0.06, 0.55],
        [1214 * pitch, 0.045, 0.4],
        [1958 * pitch, 0.03, 0.3],
        [3130 * pitch, 0.016, 0.18]
      ],
      rng
    ),
    0.001,
    0.3,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.08, 0.02, {
      bp: 3000,
      q: 0.8,
      att: 0.003
    }),
    0.01,
    0.1,
    sr
  );
  return out;
}

/** Player landing thud with gear rattles. */
export function synthLand(sr: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 0.45);
  mixInto(out, pitchDropSine(sr, 0.14, 124, 44, 0.03, 0.045, 0.002), 0, 1, sr);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.14, 0.035, {
      lp: 520
    }),
    0,
    1,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.2, 0.06, {
      bp: 1500,
      q: 0.7,
      att: 0.01
    }),
    0.01,
    0.16,
    sr
  );
  for (const offset of [0.022, 0.05, 0.088])
    mixInto(
      out,
      noiseBurst(sr, rng, 0.012, 0.003, {
        bp: randRange(rng, 2200, 4200),
        q: 2
      }),
      offset,
      randRange(rng, 0.1, 0.22),
      sr
    );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.2, 0.05, {
      hp: 3500,
      att: 0.01
    }),
    0.015,
    0.1,
    sr
  );
  return softClip(out, 1.2);
}

/** Jump push-off (cloth swish and light thump). */
export function synthJump(sr: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 0.26);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.2, 0.05, {
      bp: 900,
      q: 0.7,
      att: 0.02
    }),
    0,
    0.6,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.1, 0.025, {
      bp: 2600,
      q: 0.8,
      att: 0.004
    }),
    0.005,
    0.35,
    sr
  );
  mixInto(out, pitchDropSine(sr, 0.05, 95, 60, 0.02, 0.018, 0.003), 0, 0.4, sr);
  return out;
}

/** Player taking damage: low body thump. */
export function synthHurt(sr: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 0.5);
  mixInto(out, pitchDropSine(sr, 0.25, 92, 38, 0.04, 0.06, 0.0015), 0, 1.1, sr);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.2, 0.04, {
      lp: 320
    }),
    0,
    1.2,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.06, 0.01, {
      bp: 820,
      q: 1
    }),
    0,
    0.55,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.03, 0.004, {
      hp: 1800,
      lp: 5000
    }),
    0,
    0.2,
    sr
  );
  return softClip(out, 1.6);
}

/** Tinnitus-style ear ring after a close explosion. */
export function synthEarRing(sr: number): Float32Array {
  const out = allocSamples(sr, 2.4);
  for (let i = 0; i < out.length; i++) {
    const time = i / sr;
    out[i] =
      (Math.sin(TWO_PI * 3150 * time) +
        0.7 * Math.sin(TWO_PI * 4013 * time + 1) +
        0.35 * Math.sin(TWO_PI * 5310 * time + 2)) *
      (1 - Math.exp(-time / 0.12)) *
      Math.exp(-time / 0.55);
  }
  return out;
}

/** Bullet impact on metal: click, thud and ringing plate modes. */
export function synthImpactMetal(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.5);
  const freq = [640, 880, 745][variant % 3] * randRange(rng, 0.97, 1.03);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.015, 0.003, {
      hp: 1500
    }),
    0,
    1,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.04, 0.008, {
      lp: 1800
    }),
    0,
    0.6,
    sr
  );
  mixInto(
    out,
    modalResonators(
      sr,
      0.48,
      [1, 1.58, 2.24, 2.92, 3.71, 4.93, 6.31, 8.1].map((ratio, k): [number, number, number] => [
        freq * ratio,
        0.13 / (1 + k * 0.55),
        1 / (1 + k * 0.5)
      ]),
      rng
    ),
    0.0005,
    0.42,
    sr
  );
  return out;
}

/** Bullet impact on concrete: thud, crack, grit and debris crackle. */
export function synthImpactConcrete(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.36);
  const pitch = [1, 1.1, 0.9][variant % 3];
  mixInto(
    out,
    noiseBurst(sr, rng, 0.06, 0.013, {
      lp: 950 * pitch
    }),
    0,
    1.1,
    sr
  );
  mixInto(out, pitchDropSine(sr, 0.05, 150 * pitch, 70, 0.012, 0.016), 0, 0.6, sr);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.012, 0.002, {
      hp: 2000
    }),
    0,
    0.6,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.12, 0.024, {
      bp: 3500 * pitch,
      q: 0.7
    }),
    0.003,
    0.3,
    sr
  );
  mixInto(
    out,
    crackleBurst(sr, rng, 0.34, 16, {
      from: 0.03,
      fall: 1.8,
      hp: 1800,
      ampFall: 0.1
    }),
    0,
    0.35,
    sr
  );
  return out;
}

/** Bullet impact on wood: hollow knock and splinter crackle. */
export function synthImpactWood(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.26);
  const pitch = variant ? 1.14 : 1;
  mixInto(
    out,
    modalResonators(
      sr,
      0.2,
      [
        [238 * pitch, 0.03, 1],
        [512 * pitch, 0.022, 0.8],
        [893 * pitch, 0.016, 0.6],
        [1410 * pitch, 0.01, 0.4]
      ],
      rng
    ),
    0,
    0.6,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.03, 0.006, {
      lp: 2100
    }),
    0,
    0.8,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.01, 0.002, {
      hp: 3000
    }),
    0,
    0.5,
    sr
  );
  mixInto(
    out,
    crackleBurst(sr, rng, 0.2, 6, {
      from: 0.01,
      fall: 2,
      bp: 2600,
      q: 1.5
    }),
    0,
    0.3,
    sr
  );
  return out;
}

/** Bullet impact in water: splash plus a rising "plip" chirp. */
export function synthImpactWater(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = splashNoise(sr, rng, 0.5, 0.8 + variant * 0.2);
  mixInto(out, chirp(sr, 0.035, 420, 1150), 0, 0.5, sr);
  return out;
}

/** Bullet hitting a robotic enemy: bright metal ping, electrical buzz and sparks. */
export function synthImpactEnemy(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.3);
  const pitch = [1, 1.12, 0.9][variant % 3];
  mixInto(
    out,
    noiseBurst(sr, rng, 0.03, 0.007, {
      hp: 4000
    }),
    0,
    0.9,
    sr
  );
  mixInto(
    out,
    modalResonators(
      sr,
      0.12,
      [
        [2920 * pitch, 0.022, 1],
        [4730 * pitch, 0.018, 0.8],
        [7310 * pitch, 0.012, 0.6],
        [1180 * pitch, 0.03, 0.5]
      ],
      rng
    ),
    0,
    0.4,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.05, 0.012, {
      bp: 320 * pitch,
      q: 1.5
    }),
    0,
    0.9,
    sr
  );
  const buzz = noiseBuffer(sr, 0.06, rng);
  biquad(buzz, 'bp', 2400, 1, sr);
  for (let i = 0; i < buzz.length; i++) {
    const time = i / sr;
    buzz[i] *= (Math.sin(TWO_PI * 118 * time) > 0.2 ? 1 : 0.1) * Math.exp(-time / 0.02);
  }
  mixInto(out, buzz, 0.004, 0.5, sr);
  mixInto(
    out,
    crackleBurst(sr, rng, 0.28, 10, {
      from: 0.02,
      fall: 1.6,
      hp: 5000,
      ampFall: 0.08
    }),
    0,
    0.3,
    sr
  );
  return out;
}

/** Glass breaking: transient plus nine random high glass pings. */
export function synthImpactGlass(sr: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 0.45);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.01, 0.002, {
      hp: 2500
    }),
    0,
    1,
    sr
  );
  for (let i = 0; i < 9; i++) {
    const freq = randRange(rng, 3200, 9500);
    mixInto(
      out,
      modalResonators(
        sr,
        0.1,
        [
          [freq, randRange(rng, 0.01, 0.03), 1],
          [freq * 1.47, 0.01, 0.5]
        ],
        rng
      ),
      Math.pow(rng(), 2) * 0.3,
      randRange(rng, 0.1, 0.35),
      sr
    );
  }
  return out;
}

/** Ricochet whine: falling warbling tone with a matching swept-noise layer. */
export function synthRicochet(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.75);
  const startFreq = [3300, 2700, 3900][variant % 3];
  const endFreq = [820, 1100, 700][variant % 3];
  let phase = 0;
  const noise = noiseBuffer(sr, 0.75, rng);
  for (let i = 0; i < out.length; i++) {
    const time = i / sr;
    const freq = endFreq + (startFreq - endFreq) * Math.exp(-time / 0.16);
    const wobble = 1 + 0.035 * Math.sin(TWO_PI * (18 + 30 * time) * time);
    phase += (TWO_PI * freq * wobble) / sr;
    out[i] =
      (Math.sin(phase) + 0.3 * Math.sin(2 * phase)) *
      (1 - Math.exp(-time / 0.004)) *
      Math.exp(-time / 0.19);
  }
  biquadSweep(
    noise,
    'bp',
    (pos: number) => endFreq + (startFreq - endFreq) * Math.exp((-pos * 0.75) / 0.16),
    6,
    sr
  );
  mixInto(out, applyEnvelope(noise, sr, expDecay(0.15, 0.003)), 0, 1.6, sr);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.01, 0.002, {
      hp: 2500
    }),
    0,
    0.7,
    sr
  );
  return out;
}

/** Rounds `freq` so it completes a whole number of cycles in `loopDur` seconds. */
const snapToLoopFreq = (freq: number, loopDur: number): number =>
  Math.round(freq * loopDur) / loopDur;

/** 2 s seamless loop of the gull drone's four rotors plus filtered air noise. */
export function* synthGullRotor(sr: number, rng: RandomFn): MusicGenerator {
  const len = sr * 2;
  const out = new Float32Array(len);
  const rotors = [
    [184, 2.5],
    [207.5, 3.5],
    [233, 2],
    [258.5, 4.5]
  ];
  for (const [rotorFreq, amRate] of rotors) {
    const freq = snapToLoopFreq(rotorFreq, 2);
    const amFreq = snapToLoopFreq(amRate, 2);
    const phase = rng() * TWO_PI;
    const amPhase = rng() * TWO_PI;
    for (let i = 0; i < len; i++) {
      const time = i / sr;
      const x = TWO_PI * freq * time + phase;
      out[i] +=
        (Math.sin(x) +
          0.5 * Math.sin(2 * x + 1) +
          0.3 * Math.sin(3 * x + 2) +
          0.16 * Math.sin(4 * x) +
          0.08 * Math.sin(6 * x)) *
        (0.72 + 0.28 * Math.sin(TWO_PI * amFreq * time + amPhase)) *
        0.25;
    }
    yield;
  }
  const air = loopedNoise(
    sr,
    2,
    rng,
    (buf: Float32Array) => {
      biquad(buf, 'hp', 1100, 0.7, sr);
      biquad(buf, 'lp', 5200, 0.7, sr);
    },
    0.25
  );
  const chopFreq = snapToLoopFreq(46, 2);
  for (let i = 0; i < len; i++)
    out[i] += air[i] * (0.55 + 0.45 * Math.sin((TWO_PI * chopFreq * i) / sr)) * 0.5;
  return out;
}

/** 2 s seamless loop of the hound walker's servo whine and motor hum. */
export function synthHoundServo(sr: number, rng: RandomFn): Float32Array {
  const len = sr * 2;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const time = i / sr;
    const fm = 1.1 * Math.sin(TWO_PI * 0.5 * time) + 0.5 * Math.sin(TWO_PI * 1.5 * time + 1);
    const whinePhase = TWO_PI * 310 * time + fm;
    const am = 0.7 + 0.3 * Math.sin(TWO_PI * 1.5 * time);
    let sample =
      (Math.sin(whinePhase) +
        0.45 * Math.sin(2 * whinePhase + fm) +
        0.2 * Math.sin(4 * whinePhase + 0.5)) *
      0.3 *
      am;
    const humPhase = TWO_PI * 62 * time;
    sample +=
      (Math.sin(humPhase) +
        0.5 * Math.sin(2 * humPhase) +
        0.33 * Math.sin(3 * humPhase) +
        0.2 * Math.sin(5 * humPhase)) *
      0.28;
    out[i] = sample;
  }
  const hiss = loopedNoise(
    sr,
    2,
    rng,
    (buf: Float32Array) => {
      biquad(buf, 'hp', 2800, 0.7, sr);
      biquad(buf, 'lp', 7000, 0.7, sr);
    },
    0.25
  );
  for (let i = 0; i < len; i++)
    out[i] += hiss[i] * 0.12 * (0.6 + 0.4 * Math.sin((TWO_PI * 1.5 * i) / sr + 2));
  return out;
}

/** 2 s seamless loop of the radio relay's 50 Hz mains hum, whistle and buzz. */
export function synthRelayHum(sr: number, rng: RandomFn): Float32Array {
  const len = sr * 2;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const time = i / sr;
    const humPhase = TWO_PI * 50 * time;
    out[i] =
      (Math.sin(humPhase) * 0.5 +
        Math.sin(2 * humPhase + 0.4) +
        0.5 * Math.sin(3 * humPhase + 1) +
        0.3 * Math.sin(4 * humPhase) +
        0.22 * Math.sin(6 * humPhase + 2) +
        0.12 * Math.sin(10 * humPhase)) *
        0.3 *
        (0.9 + 0.1 * Math.sin(TWO_PI * 0.5 * time)) +
      Math.sin(TWO_PI * 4100 * time) * 0.012 * (0.6 + 0.4 * Math.sin(TWO_PI * 1 * time)) +
      Math.sin(TWO_PI * 1250 * time + 0.6 * Math.sin(TWO_PI * 2 * time)) * 0.02;
  }
  const buzz = loopedNoise(
    sr,
    2,
    rng,
    (buf: Float32Array) => biquad(buf, 'bp', 2100, 1.2, sr),
    0.25
  );
  for (let i = 0; i < len; i++)
    out[i] += buzz[i] * 0.16 * Math.pow(0.5 + 0.5 * Math.sin((TWO_PI * 100 * i) / sr), 3);
  return out;
}

/** Heavy hound walker footstep: servo chirp, stomp and leg-casing ring. */
export function synthHoundStep(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.42);
  const pitch = [1, 1.07, 0.93][variant % 3];
  mixInto(out, chirp(sr, 0.035, 920 * pitch, 610 * pitch), 0, 0.06, sr);
  const stompTime = 0.03;
  mixInto(out, pitchDropSine(sr, 0.2, 84 * pitch, 41, 0.03, 0.05, 0.002), stompTime, 1.1, sr);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.12, 0.03, {
      lp: 360
    }),
    stompTime,
    1.1,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.03, 0.006, {
      lp: 2600,
      hp: 500
    }),
    stompTime,
    0.4,
    sr
  );
  mixInto(
    out,
    modalResonators(
      sr,
      0.12,
      [
        [522 * pitch, 0.026, 1],
        [1133 * pitch, 0.02, 0.7],
        [1871 * pitch, 0.014, 0.5],
        [3040 * pitch, 0.008, 0.3]
      ],
      rng
    ),
    stompTime,
    0.2,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.14, 0.04, {
      hp: 3000,
      att: 0.006
    }),
    stompTime + 0.01,
    0.06,
    sr
  );
  return softClip(out, 1.5);
}

/** Gull drone destroyed: rotors spinning down, then a crash with debris. */
export function synthGullDie(sr: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 1.5);
  const phases = [0, 0, 0, 0];
  mixInto(
    out,
    noiseBurst(sr, rng, 0.02, 0.004, {
      hp: 2500
    }),
    0,
    0.9,
    sr
  );
  const rotorFreqs = [184, 207, 233, 258];
  for (let i = 0; i < Math.round(1.1 * sr); i++) {
    const time = i / sr;
    const pitchMul =
      Math.pow(0.16, time / 1) * (1 + 0.06 * Math.sin(TWO_PI * (9 - 5 * time) * time));
    let sum = 0;
    for (let r = 0; r < 4; r++) {
      phases[r] += (TWO_PI * rotorFreqs[r] * pitchMul) / sr;
      sum += Math.sin(phases[r]) + 0.5 * Math.sin(2 * phases[r]) + 0.3 * Math.sin(3 * phases[r]);
    }
    const sputter = 0.6 + 0.4 * Math.sign(Math.sin(TWO_PI * (26 - 16 * time) * time));
    out[i] += sum * 0.16 * sputter * Math.exp(-time / 0.55) * (1 - Math.exp(-time / 0.01));
  }
  const whoosh = noiseBuffer(sr, 1, rng);
  biquadSweep(whoosh, 'bp', expRamp(3200, 500), 1, sr);
  mixInto(out, applyEnvelope(whoosh, sr, expDecay(0.35, 0.01)), 0, 0.3, sr);
  const crashTime = 0.72;
  mixInto(
    out,
    noiseBurst(sr, rng, 0.2, 0.035, {
      lp: 3000
    }),
    crashTime,
    1,
    sr
  );
  mixInto(out, pitchDropSine(sr, 0.12, 130, 55, 0.02, 0.035), crashTime, 0.8, sr);
  mixInto(
    out,
    modalResonators(
      sr,
      0.4,
      [
        [705, 0.07, 1],
        [1490, 0.05, 0.7],
        [2610, 0.035, 0.5],
        [4020, 0.02, 0.3]
      ],
      rng
    ),
    crashTime,
    0.28,
    sr
  );
  mixInto(
    out,
    crackleBurst(sr, rng, 0.7, 26, {
      from: 0.02,
      fall: 1.7,
      hp: 1500,
      ampFall: 0.2,
      maxLen: 0.008
    }),
    crashTime,
    0.5,
    sr
  );
  mixInto(
    out,
    modalResonators(
      sr,
      0.2,
      [
        [1900, 0.03, 1],
        [3350, 0.02, 0.6]
      ],
      rng
    ),
    crashTime + 0.19,
    0.14,
    sr
  );
  return softClip(out, 1.4);
}

/** Hound walker destroyed: power-down whine and a series of collapsing metal clanks. */
export function synthHoundDie(sr: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 1.9);
  let sawPhase = 0;
  let sinePhase = 0;
  const whine = allocSamples(sr, 1.3);
  for (let i = 0; i < whine.length; i++) {
    const time = i / sr;
    const freq = 30 + 112 * Math.pow(1 - time / 1.3, 1.6);
    sawPhase += freq / sr;
    sinePhase += (180 + 1050 * Math.exp(-time / 0.3)) / sr;
    whine[i] =
      (2 * (sawPhase - Math.floor(sawPhase)) - 1) *
        (1 - Math.exp(-time / 0.02)) *
        Math.pow(1 - time / 1.3, 0.7) +
      Math.sin(TWO_PI * sinePhase) * 0.25 * Math.exp(-time / 0.4);
  }
  biquadSweep(whine, 'lp', expRamp(1100, 160), 2.5, sr);
  mixInto(out, whine, 0, 0.55, sr);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.03, 0.006, {
      hp: 2000
    }),
    0,
    0.5,
    sr
  );
  for (const [time, gain, pitch] of [
    [0.62, 1, 1],
    [0.84, 0.75, 1.22],
    [0.98, 0.5, 0.86],
    [1.17, 0.42, 1.4],
    [1.33, 0.22, 1.1]
  ]) {
    mixInto(out, pitchDropSine(sr, 0.1, 105 * pitch, 48, 0.02, 0.035), time, gain * 0.9, sr);
    mixInto(
      out,
      noiseBurst(sr, rng, 0.08, 0.016, {
        lp: 2400
      }),
      time,
      gain * 0.8,
      sr
    );
    mixInto(
      out,
      modalResonators(
        sr,
        0.3,
        [
          [388 * pitch, 0.07, 1],
          [861 * pitch, 0.05, 0.7],
          [1540 * pitch, 0.035, 0.5],
          [2750 * pitch, 0.02, 0.35]
        ],
        rng
      ),
      time,
      gain * 0.3,
      sr
    );
  }
  mixInto(
    out,
    crackleBurst(sr, rng, 1, 22, {
      from: 0,
      fall: 1.2,
      hp: 1800,
      ampFall: 0.4,
      maxLen: 0.007
    }),
    0.62,
    0.3,
    sr
  );
  return softClip(scaleBuffer(out, 0.55), 1.5);
}

/** Enemy alert chirp; variant 1 is the lower hound version with an extra falling tone. */
export function synthAlert(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.52);
  const baseFreq = variant ? 622 : 1320;
  const secondFreq = baseFreq * 1.4142;
  let phase = 0;
  const tone = (start: number, dur: number, freq: number, bend: number) => {
    const toneLen = Math.round(dur * sr);
    const startIdx = Math.round(start * sr);
    for (let i = 0; i < toneLen; i++) {
      const progress = i / toneLen;
      const time = i / sr;
      phase += (TWO_PI * freq * (1 + bend * progress)) / sr;
      const v = Math.sin(phase + 1.6 * Math.sin(phase * 0.25) + 0.4 * Math.sin(TWO_PI * 71 * time));
      out[startIdx + i] +=
        Math.tanh(v * 2.2) * Math.min(1, i / (0.004 * sr), (toneLen - i) / (0.012 * sr));
    }
  };
  tone(0, 0.09, baseFreq, 0);
  tone(0.12, 0.17, secondFreq, -0.05);
  if (variant) tone(0.3, 0.2, baseFreq * 0.5, 0.5);
  biquad(out, 'bp', variant ? 1100 : 2100, 0.6, sr);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.4, 0.2, {
      hp: 4000,
      att: 0.02
    }),
    0,
    0.03,
    sr
  );
  return out;
}

/** Attack wind-up telegraph (variant 1: low hound charge; 0: high gull charge) with clicks. */
export function synthTelegraph(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 0.6);
  const len = out.length;
  const rampDur = 0.55;
  let phase1 = 0;
  let phase2 = 0;
  for (let i = 0; i < len; i++) {
    const time = i / sr;
    const progress = Math.min(1, time / rampDur);
    const env =
      Math.pow(progress, 1.4) * (time < rampDur ? 1 : Math.exp(-(time - rampDur) / 0.008));
    if (variant) {
      phase1 += (170 + 380 * progress * progress) / sr;
      phase2 += (680 + 900 * progress) / sr;
      const saw = 2 * (phase1 - Math.floor(phase1)) - 1;
      out[i] =
        (saw * (0.7 + 0.3 * Math.sin(TWO_PI * 38 * time)) + 0.35 * Math.sin(TWO_PI * phase2)) * env;
    } else {
      phase1 += (620 + 1900 * progress * progress * progress) / sr;
      phase2 += ((1240 + 3800 * progress * progress * progress) * 1.003) / sr;
      out[i] =
        (Math.sin(TWO_PI * phase1) +
          0.4 * Math.sin(TWO_PI * phase2) +
          0.25 * Math.sign(Math.sin(TWO_PI * phase1 * 0.5))) *
        env *
        (0.8 + 0.2 * Math.sin(TWO_PI * (20 + 60 * progress) * time));
    }
  }
  biquad(out, 'lp', variant ? 2600 : 7000, 0.7, sr);
  biquad(out, 'hp', variant ? 120 : 400, 0.7, sr);
  const clicks = variant ? 7 : 5;
  for (let k = 0; k < clicks; k++) {
    const clickTime = rampDur * Math.sqrt(k / clicks);
    mixInto(
      out,
      modalResonators(
        sr,
        0.03,
        [
          [variant ? 1500 : 3800, 0.004, 1],
          [variant ? 2600 : 6100, 0.003, 0.6]
        ],
        rng
      ),
      clickTime,
      0.12 + (0.2 * k) / clicks,
      sr
    );
  }
  return out;
}

/** Radio relay sabotaged: switch click, stuttering electrical buzz and a spin-down. */
export function synthRelayCut(sr: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 1.7);
  mixInto(
    out,
    noiseBurst(sr, rng, 0.01, 0.002, {
      hp: 2500
    }),
    0,
    1,
    sr
  );
  const buzz = noiseBuffer(sr, 0.5, rng);
  biquad(buzz, 'bp', 3000, 0.8, sr);
  let gate = 1;
  for (let i = 0; i < buzz.length; i++) {
    const time = i / sr;
    if (i % 220 === 0) gate = rng() < 0.55 + 0.4 * (1 - time / 0.5) ? 1 : 0;
    buzz[i] =
      (buzz[i] * (Math.sin(TWO_PI * 100 * time) > -0.2 ? 1 : 0.15) +
        0.35 * Math.sign(Math.sin(TWO_PI * 100 * time)) * (rng() - 0.3)) *
      gate *
      Math.exp(-time / 0.3);
  }
  mixInto(out, buzz, 0.005, 0.8, sr);
  const spinDown = allocSamples(sr, 1.25);
  let humPhase = 0;
  let whinePhase = 0;
  for (let i = 0; i < spinDown.length; i++) {
    const time = i / sr;
    const pitchMul = Math.pow(0.22, time / 1.2);
    humPhase += (TWO_PI * 100 * pitchMul) / sr;
    whinePhase += (TWO_PI * (150 + 1900 * Math.pow(1 - time / 1.25, 2.2))) / sr;
    spinDown[i] =
      ((Math.sin(humPhase) +
        0.6 * Math.sin(2 * humPhase) +
        0.4 * Math.sin(3 * humPhase) +
        0.25 * Math.sin(5 * humPhase)) *
        0.5 +
        Math.sin(whinePhase) * 0.22) *
      Math.pow(1 - time / 1.25, 1.2) *
      (1 - Math.exp(-time / 0.03));
  }
  mixInto(out, spinDown, 0.4, 0.8, sr);
  mixInto(out, pitchDropSine(sr, 0.12, 140, 60, 0.03, 0.04), 0.4, 0.5, sr);
  return softClip(out, 1.3);
}

/** Distant thunder roll (variant 1 is closer: brighter, with an initial crack). */
export function* synthThunder(sr: number, rng: RandomFn, variant: number): MusicGenerator {
  const out = allocSamples(sr, 6.5);
  const rumble = noiseBuffer(sr, 6.4, rng);
  yield;
  biquadSweep(rumble, 'lp', expRamp(variant ? 520 : 380, 70, 0.6), 0.7, sr);
  yield;
  /** Rolls: [centre time s, width s, amplitude]. */
  const rolls: [number, number, number][] = [];
  for (let k = 0; k < 9; k++)
    rolls.push([randRange(rng, 0.05, 3.6), randRange(rng, 0.12, 0.5), randRange(rng, 0.4, 1)]);
  let env = 0;
  let envStep = 0;
  const envAt = (time: number) => {
    let sum = 0;
    for (const [center, width, amp] of rolls) {
      const x = (time - center) / width;
      sum += amp * Math.exp(-x * x);
    }
    return (0.25 + sum) * Math.exp(-time / 1.9) * (1 - Math.exp(-time / 0.05));
  };
  for (let i = 0; i < rumble.length; i++) {
    if ((i & 31) === 0) {
      env = envAt(i / sr);
      envStep = (envAt((i + 32) / sr) - env) / 32;
    }
    rumble[i] *= env;
    env += envStep;
  }
  mixInto(out, rumble, 0, 1, sr);
  yield;
  const sub = noiseBuffer(sr, 6, rng);
  biquad(sub, 'bp', 48, 1.2, sr);
  mixInto(out, applyEnvelope(sub, sr, expDecay(2, 0.2)), 0.05, 3, sr);
  if (variant)
    mixInto(
      out,
      noiseBurst(sr, rng, 0.3, 0.06, {
        hp: 300,
        lp: 2500
      }),
      0.02,
      0.25,
      sr
    );
  return out;
}

const FOGHORN_HARMONICS = [0, 1, 0.435, 0.268, 0.19, 0.145, 0.116, 0.097];

/** Distant two-tone foghorn blast (deterministic; `_rng` unused). */
export function synthFoghorn(sr: number, _rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 5);
  const len = out.length;
  for (let i = 0; i < len; i++) {
    const time = i / sr;
    const vibrato = 0.0025 * Math.sin(TWO_PI * 4.3 * time);
    const env =
      Math.min(1, time / 0.45) *
      Math.min(1, (5 - time) / 1.5) *
      (time < 3.2 ? 1 : Math.exp(-(time - 3.2) / 0.7));
    let sum = 0;
    for (let h = 1; h <= 7; h++)
      sum += Math.sin(TWO_PI * 92.5 * h * time * (1 + vibrato) + h) * FOGHORN_HARMONICS[h];
    for (let h = 1; h <= 4; h++)
      sum += 0.45 * Math.sin(TWO_PI * 138.6 * h * time + h * 2) * FOGHORN_HARMONICS[h];
    out[i] = sum * env;
  }
  biquad(out, 'lp', 520, 0.7, sr);
  return out;
}

/** Seagull cry: 3-4 rising-falling calls (variant 1 is lower and slower). */
export function synthGullCry(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 1.4);
  const calls = variant ? 3 : 4;
  let callStart = 0.02;
  for (let c = 0; c < calls; c++) {
    const dur = randRange(rng, 0.17, 0.26) * (variant ? 1.4 : 1);
    const callLen = Math.round(dur * sr);
    const startIdx = Math.round(callStart * sr);
    const baseFreq = (variant ? 1250 : 1550) * (1 - c * 0.04);
    let phase = 0;
    for (let i = 0; i < callLen && startIdx + i < out.length; i++) {
      const progress = i / callLen;
      const freq =
        baseFreq * (1 + 0.55 * Math.sin(Math.PI * Math.pow(progress, 0.6)) - 0.25 * progress);
      phase += (TWO_PI * freq) / sr;
      const rasp = 1 + 0.3 * Math.sin((TWO_PI * 63 * i) / sr);
      out[startIdx + i] +=
        (Math.sin(phase) +
          0.6 * Math.sin(2 * phase + 0.5) +
          0.35 * Math.sin(3 * phase) +
          0.15 * Math.sin(4 * phase)) *
        rasp *
        Math.pow(Math.sin(Math.PI * progress), 0.7) *
        (1 - c * 0.14);
    }
    callStart += dur + randRange(rng, 0.05, 0.12);
  }
  biquad(out, 'lp', 4200, 0.7, sr);
  return out;
}

/** Halyard (rope fitting) clanking against a flagpole: 3-4 metallic pings. */
export function synthHalyard(sr: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sr, 1.1);
  const pitch = variant ? 1.19 : 1;
  let time = 0.01;
  const pings = variant ? 3 : 4;
  for (let k = 0; k < pings; k++) {
    mixInto(
      out,
      modalResonators(
        sr,
        0.5,
        [
          [2310 * pitch, randRange(rng, 0.06, 0.13), 1],
          [3740 * pitch, 0.07, 0.7],
          [5910 * pitch, 0.04, 0.5],
          [8130 * pitch, 0.025, 0.3],
          [1012 * pitch, 0.03, 0.3]
        ],
        rng
      ),
      time,
      randRange(rng, 0.35, 1),
      sr
    );
    mixInto(
      out,
      noiseBurst(sr, rng, 0.004, 0.001, {
        hp: 3000
      }),
      time,
      0.3,
      sr
    );
    time += randRange(rng, 0.09, 0.26);
  }
  return out;
}

/** Shipping-container bang: low steel box modes with two echoes. */
export function synthContainerBang(sr: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 2.8);
  const bang = allocSamples(sr, 2.2);
  mixInto(
    bang,
    modalResonators(
      sr,
      2.2,
      [
        [47, 0.7, 1],
        [77, 0.55, 0.9],
        [121, 0.4, 0.7],
        [163, 0.3, 0.5],
        [214, 0.22, 0.4],
        [330, 0.12, 0.25]
      ],
      rng
    ),
    0,
    0.5,
    sr
  );
  mixInto(
    bang,
    noiseBurst(sr, rng, 0.5, 0.11, {
      lp: 420
    }),
    0,
    1,
    sr
  );
  mixInto(out, bang, 0, 1, sr);
  mixInto(out, bang, 0.36, 0.3, sr);
  mixInto(out, bang, 0.61, 0.12, sr);
  return out;
}

/** UI button click. */
export function synthUiClick(sr: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 0.09);
  mixInto(
    out,
    modalResonators(
      sr,
      0.08,
      [
        [1820, 0.009, 1],
        [2730, 0.007, 0.6],
        [640, 0.012, 0.5]
      ],
      rng
    ),
    0,
    1,
    sr
  );
  mixInto(
    out,
    noiseBurst(sr, rng, 0.004, 0.001, {
      hp: 2500
    }),
    0,
    0.5,
    sr
  );
  return out;
}

/** UI hover tick. */
export function synthUiHover(sr: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sr, 0.06);
  mixInto(
    out,
    modalResonators(
      sr,
      0.05,
      [
        [3200, 0.008, 1],
        [4800, 0.005, 0.3]
      ],
      rng
    ),
    0,
    1,
    sr
  );
  return out;
}

/** 6 s stereo outdoor rain loop: hiss, body, drop impacts and droplet chirps. */
export function* synthRain(sr: number, rng: RandomFn): MusicGenerator<Float32Array[]> {
  const renderChannel = function* (chRng: RandomFn): MusicGenerator {
    const hiss = loopedNoise(sr, 6, chRng, (buf: Float32Array) => {
      biquad(buf, 'hp', 900, 0.6, sr);
      biquad(buf, 'lp', 8500, 0.6, sr);
    });
    yield;
    const body = loopedNoise(sr, 6, chRng, (buf: Float32Array) => {
      biquad(buf, 'bp', 420, 0.5, sr);
    });
    const len = hiss.length;
    const mix = mixBuffers(len, [hiss, 0.5], [body, 0.75]);
    const drops = new Float32Array(len);
    for (let d = 0; d < 1020; d++) {
      let pos = Math.floor(chRng() * len);
      const dropLen = Math.round(randRange(chRng, 0.0006, 0.003) * sr);
      const amp = Math.pow(chRng(), 3) * 1.6 + 0.15;
      for (let i = 0; i < dropLen; i++) {
        drops[pos] += (chRng() * 2 - 1) * amp * Math.exp((-5 * i) / dropLen);
        if (++pos >= len) pos = 0;
      }
    }
    yield;
    biquadSweep(drops, 'hp', () => 2200, 0.7, sr, 2);
    yield;
    for (let k = 0; k < 30; k++) {
      const freq = randRange(chRng, 700, 2100);
      mixIntoWrapped(
        drops,
        chirp(sr, randRange(chRng, 0.008, 0.02), freq, freq * 1.7),
        chRng() * 6,
        randRange(chRng, 0.08, 0.3),
        sr
      );
    }
    for (let i = 0; i < len; i++) mix[i] += drops[i] * 0.55;
    return mix;
  };
  return [
    yield* renderChannel(mulberry32(Math.floor(rng() * 1e9))),
    yield* renderChannel(mulberry32(Math.floor(rng() * 1e9)))
  ];
}

/** 6 s stereo loop of rain heard from indoors: muffled bed plus resonant roof-drum taps. */
export function* synthRainInterior(sr: number, rng: RandomFn): MusicGenerator<Float32Array[]> {
  const renderChannel = function* (chRng: RandomFn): MusicGenerator {
    const bed = loopedNoise(sr, 6, chRng, (buf: Float32Array) => {
      biquad(buf, 'lp', 1300, 0.6, sr);
      biquad(buf, 'hp', 110, 0.7, sr);
    });
    const len = bed.length;
    const impulses = new Float32Array(len);
    for (let d = 0; d < 1560; d++)
      impulses[Math.floor(chRng() * len)] += (chRng() * 2 - 1) * (0.2 + Math.pow(chRng(), 4) * 3);
    const mix = mixBuffers(len, [bed, 0.8]);
    for (const [freq, q, gain] of [
      [1820, 14, 1],
      [2740, 16, 0.8],
      [4150, 18, 0.6],
      [6200, 14, 0.35],
      [940, 8, 0.7]
    ]) {
      const ringing = Float32Array.from(impulses);
      biquadSweep(ringing, 'bp', () => freq, q, sr, 2);
      for (let i = 0; i < len; i++) mix[i] += ringing[i] * gain * 5;
      yield;
    }
    for (let k = 0; k < 4; k++) {
      const freq = randRange(chRng, 900, 1600);
      mixIntoWrapped(mix, chirp(sr, 0.014, freq, freq * 1.8), chRng() * 6, 0.25, sr);
    }
    return mix;
  };
  return [
    yield* renderChannel(mulberry32(Math.floor(rng() * 1e9))),
    yield* renderChannel(mulberry32(Math.floor(rng() * 1e9)))
  ];
}

/** 8 s seamless wind loop: gusting band-passed noise plus a whistling layer. */
export function synthWind(sr: number, rng: RandomFn): Float32Array {
  const gust = noiseBuffer(sr, 8.5, rng);
  const whistle = Float32Array.from(gust);
  biquadSweep(
    gust,
    'bp',
    (pos: number) => {
      const time = pos * 8.5;
      return 380 + 190 * Math.sin((TWO_PI * time) / 8) + 90 * Math.sin((TWO_PI * time) / 2.667 + 1);
    },
    1.3,
    sr
  );
  biquadSweep(
    whistle,
    'bp',
    (pos: number) => {
      const time = pos * 8.5;
      return 1350 + 260 * Math.sin((TWO_PI * time) / 4 + 2);
    },
    9,
    sr
  );
  for (let i = 0; i < gust.length; i++) {
    const time = i / sr;
    gust[i] =
      gust[i] * (0.7 + 0.3 * Math.sin((TWO_PI * time) / 8 + 0.5)) +
      whistle[i] * 0.22 * Math.pow(0.5 + 0.5 * Math.sin((TWO_PI * time) / 4 + 1), 2);
  }
  return crossfadeLoop(gust, sr * 8, true);
}

/** 8 s seamless sea loop: 4 s wave swells with crash and foam layers. */
export function* synthSea(sr: number, rng: RandomFn): MusicGenerator {
  const swell = noiseBuffer(sr, 8.5, rng);
  const foam = noiseBuffer(sr, 8 + 0.5, rng);
  const crash = noiseBuffer(sr, 8 + 0.5, rng);
  yield;
  biquad(swell, 'lp', 1100, 0.6, sr);
  biquad(swell, 'hp', 70, 0.7, sr);
  biquad(foam, 'hp', 2400, 0.7, sr);
  biquad(crash, 'bp', 520, 1.2, sr);
  yield;
  for (let i = 0; i < swell.length; i++) {
    const time = i / sr;
    const wavePos = (time % 4) / 4;
    const swellEnv = Math.pow(0.5 - 0.5 * Math.cos(TWO_PI * wavePos), 1.5);
    const crashEnv = Math.exp(-Math.pow((wavePos - 0.5) / 0.05, 2));
    const foamEnv = Math.exp(-Math.pow((wavePos - 0.68) / 0.16, 2));
    const secondary = 0.5 - 0.5 * Math.cos((TWO_PI * ((time + 1.3) % 2.667)) / 2.667);
    swell[i] =
      swell[i] * (0.3 + 0.7 * swellEnv + 0.25 * secondary) +
      crash[i] * crashEnv * 1.8 +
      foam[i] * foamEnv * 0.35;
  }
  return crossfadeLoop(swell, sr * 8, true);
}

/** Stereo outdoor impulse response: sparse early reflections plus a short diffuse tail. */
export function synthIrOutdoor(sr: number, rng: RandomFn): Float32Array[] {
  const renderChannel = (chRng: RandomFn, side: number) => {
    const out = allocSamples(sr, 1.4);
    const reflections = [
      [0.062, 0.55],
      [0.089, 0.42],
      [0.118, 0.36],
      [0.151, 0.26],
      [0.178, 0.2],
      [0.243, 0.1]
    ];
    for (const [time, gain] of reflections)
      mixInto(
        out,
        noiseBurst(sr, chRng, 0.01, 0.0018, {
          hp: 700,
          lp: 5500
        }),
        time * (side ? 1.07 : 0.96) + randRange(chRng, 0, 0.006),
        gain * randRange(chRng, 0.6, 1.15),
        sr
      );
    const tail = noiseBuffer(sr, 1.3, chRng);
    biquad(tail, 'hp', 300, 0.7, sr);
    biquadSweep(tail, 'lp', expRamp(6000, 900, 0.6), 0.7, sr);
    mixInto(out, applyEnvelope(tail, sr, expDecay(0.27, 0.04)), 0.04, 0.045, sr);
    return out;
  };
  return [
    renderChannel(mulberry32(Math.floor(rng() * 1e9)), 0),
    renderChannel(mulberry32(Math.floor(rng() * 1e9)), 1)
  ];
}

/** Stereo impulse response of a small corrugated shed. */
export function synthIrShed(sr: number, rng: RandomFn): Float32Array[] {
  const renderChannel = (chRng: RandomFn, side: number) => {
    const out = allocSamples(sr, 2.2);
    const diffuse = noiseBuffer(sr, 2.18, chRng);
    biquadSweep(diffuse, 'lp', expRamp(5200, 650, 0.5), 0.7, sr);
    mixInto(out, applyEnvelope(diffuse, sr, expDecay(0.33, 0.006)), 0.012, 0.3, sr);
    const boom = noiseBuffer(sr, 2.1, chRng);
    biquad(boom, 'lp', 260, 0.7, sr);
    mixInto(out, applyEnvelope(boom, sr, expDecay(0.4, 0.01)), 0.012, 0.5, sr);
    for (const [time, gain] of [
      [0.018, 0.7],
      [0.031, 0.55],
      [0.047, 0.45],
      [0.093, 0.3],
      [0.139, 0.2]
    ])
      mixInto(
        out,
        noiseBurst(sr, chRng, 0.008, 0.0015, {
          lp: 4500
        }),
        time * (side ? 1.09 : 0.95),
        gain,
        sr
      );
    return out;
  };
  return [
    renderChannel(mulberry32(Math.floor(rng() * 1e9)), 0),
    renderChannel(mulberry32(Math.floor(rng() * 1e9)), 1)
  ];
}
