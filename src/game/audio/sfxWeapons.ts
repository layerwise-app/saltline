// Procedural weapon and combat sound effects: dry fire, reload/bolt/slide mechanics, weapon draw
// and holster, shell casings, explosions, enemy weapon fire and bullet whizzes. Every generator
// has the `SoundGenerator` shape `(sampleRate, rng, variant)` and is registered in soundTable.ts.
import {
  TWO_PI,
  allocSamples,
  applyEnvelope,
  biquad,
  biquadSweep,
  chirp,
  compressBuffer,
  crackleBurst,
  dcBlock,
  duckAfterOnset,
  expDecay,
  expRamp,
  frictionScrape,
  friedlanderPulse,
  metalClick,
  mixInto,
  modalResonators,
  noiseBuffer,
  noiseBurst,
  normalize,
  peakEnvelope,
  pitchDropSine,
  randRange,
  rustleNoise,
  softClip
} from './dsp';
import type { ModalPartial, RandomFn, SoundIterator } from './dsp';

/** Rifle trigger click on an empty chamber. */
export function synthRifleDry(sampleRate: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sampleRate, 0.2);
  const t0 = 5e-4;
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [2260, 0.005, 1],
        [3640, 0.0045, 0.75],
        [5880, 0.003, 0.5],
        [8100, 0.002, 0.3]
      ],
      {
        hp: 2200,
        tick: 0.9
      }
    ),
    t0,
    1,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.05,
      [
        [640, 0.009, 1],
        [1180, 0.007, 0.6]
      ],
      rng
    ),
    t0,
    0.3,
    sampleRate
  );
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.02, 0.004, {
      lp: 900
    }),
    t0,
    0.22,
    sampleRate
  );
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [3050, 0.003, 1],
        [4700, 0.0025, 0.6]
      ],
      {
        hp: 3200,
        tick: 0.5
      }
    ),
    t0 + 0.0125,
    0.16,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.18,
      [
        [742, 0.04, 1],
        [1493, 0.028, 0.45],
        [2260, 0.016, 0.2]
      ],
      rng
    ),
    t0 + 0.002,
    0.045,
    sampleRate
  );
  return dcBlock(out, sampleRate, 60);
}

/** Pistol trigger click on an empty chamber. */
export function synthPistolDry(sampleRate: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sampleRate, 0.14);
  const t0 = 5e-4;
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [3480, 0.0038, 1],
        [5350, 0.003, 0.7],
        [7900, 0.0022, 0.45],
        [1950, 0.005, 0.4]
      ],
      {
        hp: 3e3,
        tick: 0.8
      }
    ),
    t0,
    1,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.03,
      [
        [980, 0.006, 1],
        [1620, 0.005, 0.5]
      ],
      rng
    ),
    t0,
    0.22,
    sampleRate
  );
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [4300, 0.0025, 1],
        [6600, 0.002, 0.5]
      ],
      {
        hp: 3800,
        tick: 0.5
      }
    ),
    t0 + 0.009,
    0.14,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.09,
      [
        [1310, 0.018, 1],
        [2650, 0.012, 0.4]
      ],
      rng
    ),
    t0 + 0.002,
    0.03,
    sampleRate
  );
  return dcBlock(out, sampleRate, 90);
}

/** Rifle magazine release and pull-out. */
export function synthReloadMagOut(sampleRate: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sampleRate, 0.38);
  const t0 = 0.003;
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [3340, 0.004, 1],
        [5210, 0.003, 0.6],
        [1880, 0.006, 0.45],
        [7600, 0.002, 0.3]
      ],
      {
        hp: 2600,
        tick: 0.75
      }
    ),
    t0,
    0.62,
    sampleRate
  );
  mixInto(
    out,
    frictionScrape(sampleRate, rng, 0.17, 2700, 1450, {
      rough: 210,
      rough1: 130,
      env: peakEnvelope(0.25, 0.8)
    }),
    t0 + 0.018,
    0.4,
    sampleRate
  );
  const hiss = noiseBuffer(sampleRate, 0.24, rng);
  biquad(hiss, 'hp', 4200, 0.7, sampleRate);
  applyEnvelope(hiss, sampleRate, (t) => Math.pow(Math.sin((Math.PI * t) / 0.24), 2));
  mixInto(out, normalize(hiss), t0 + 0.05, 0.075, sampleRate);
  const rub = noiseBuffer(sampleRate, 0.22, rng);
  biquadSweep(rub, 'bp', expRamp(520, 260), 0.8, sampleRate);
  applyEnvelope(rub, sampleRate, (t) => Math.pow(Math.sin((Math.PI * t) / 0.22), 2));
  mixInto(out, normalize(rub), t0 + 0.08, 0.1, sampleRate);
  const handleTime = t0 + 0.2;
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.12,
      [
        [418, 0.026, 1],
        [1135, 0.016, 0.6],
        [2280, 0.009, 0.4],
        [3420, 0.005, 0.25]
      ],
      rng
    ),
    handleTime,
    0.3,
    sampleRate
  );
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.05, 0.009, {
      lp: 1e3
    }),
    handleTime,
    0.3,
    sampleRate
  );
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.004, 8e-4, {
      hp: 2800
    }),
    handleTime,
    0.18,
    sampleRate
  );
  return dcBlock(out, sampleRate, 70);
}

/** Rifle magazine sliding into the well. */
export function synthReloadMagInsert(sampleRate: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sampleRate, 0.26);
  const t0 = 0.004;
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [2210, 0.004, 1],
        [3580, 0.003, 0.6]
      ],
      {
        hp: 2400,
        tick: 0.5
      }
    ),
    t0,
    0.3,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.06,
      [
        [520, 0.014, 1],
        [1240, 0.009, 0.5]
      ],
      rng
    ),
    t0,
    0.26,
    sampleRate
  );
  mixInto(
    out,
    frictionScrape(sampleRate, rng, 0.19, 1e3, 3300, {
      rough: 140,
      rough1: 320,
      hi: 0.35,
      env: (pos) => Math.pow(pos, 0.8) * (pos > 0.93 ? (1 - pos) / 0.07 : 1)
    }),
    t0 + 0.012,
    0.62,
    sampleRate
  );
  for (const [time, gain] of [
    [0.085, 0.14],
    [0.142, 0.2]
  ]) {
    mixInto(
      out,
      metalClick(
        sampleRate,
        rng,
        [
          [2850, 0.003, 1],
          [4420, 0.0025, 0.6]
        ],
        {
          hp: 3e3,
          tick: 0.6
        }
      ),
      t0 + time,
      gain,
      sampleRate
    );
  }
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.03, 0.006, {
      bp: 720,
      q: 1
    }),
    t0 + 0.2,
    0.22,
    sampleRate
  );
  return dcBlock(out, sampleRate, 70);
}

/** Rifle magazine seating with a firm latch click. */
export function synthReloadMagIn(sampleRate: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sampleRate, 0.21);
  const t0 = 8e-4;
  const latchTime = t0 + 0.031;
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [2390, 0.0055, 1],
        [3760, 0.0045, 0.75],
        [5640, 0.0035, 0.5],
        [1270, 0.007, 0.45]
      ],
      {
        hp: 2400,
        tick: 0.95,
        tickTau: 8e-4
      }
    ),
    t0,
    0.62,
    sampleRate
  );
  mixInto(out, pitchDropSine(sampleRate, 0.08, 172, 74, 0.014, 0.02, 8e-4), t0, 0.5, sampleRate);
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.04, 0.008, {
      lp: 720
    }),
    t0,
    0.3,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.07,
      [
        [432, 0.016, 1],
        [915, 0.011, 0.6]
      ],
      rng
    ),
    t0,
    0.2,
    sampleRate
  );
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [3130, 0.011, 1],
        [4690, 0.009, 0.85],
        [7160, 0.006, 0.55],
        [1890, 0.012, 0.5],
        [9420, 0.0035, 0.3]
      ],
      {
        hp: 2800,
        tick: 1.1,
        tickTau: 0.001
      }
    ),
    latchTime,
    1.05,
    sampleRate
  );
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.012, 0.0022, {
      bp: 2600,
      q: 0.8
    }),
    latchTime,
    0.4,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.16,
      [
        [1485, 0.028, 1],
        [2215, 0.024, 0.6],
        [3320, 0.016, 0.35]
      ],
      rng
    ),
    latchTime + 8e-4,
    0.11,
    sampleRate
  );
  return dcBlock(softClip(normalize(out), 1.5), sampleRate, 45);
}

/** Bolt pulled back (variant 1: short pull without the end-stop clack). */
export function synthReloadBoltBack(
  sampleRate: number,
  rng: RandomFn,
  variant: number
): Float32Array {
  const short = variant === 1;
  const pullDur = short ? 0.085 : 0.15;
  const out = allocSamples(sampleRate, short ? 0.16 : 0.26);
  const t0 = 0.001;
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [2710, 0.004, 1],
        [4130, 0.003, 0.6],
        [1560, 0.006, 0.4]
      ],
      {
        hp: 2600,
        tick: 0.7
      }
    ),
    t0,
    short ? 0.4 : 0.45,
    sampleRate
  );
  mixInto(
    out,
    frictionScrape(sampleRate, rng, pullDur, 1350, short ? 2e3 : 2650, {
      rough: 260,
      rough1: 420,
      hi: 0.5,
      q: 2.2,
      env: (pos) => 0.35 + 0.65 * pos
    }),
    t0 + 0.006,
    0.34,
    sampleRate
  );
  const tickCount = short ? 4 : 8;
  for (let k = 0; k < tickCount; k++) {
    const pos = (k + 0.5) / tickCount;
    const time = t0 + 0.01 + pullDur * Math.pow(pos, 0.85);
    const freq = 1900 + 1500 * pos;
    mixInto(
      out,
      metalClick(
        sampleRate,
        rng,
        [
          [freq, 0.003, 1],
          [freq * 1.62, 0.0025, 0.6],
          [freq * 2.71, 0.0018, 0.3]
        ],
        {
          hp: 2800,
          tick: 0.6,
          jit: 0.04
        }
      ),
      time,
      0.2 + 0.2 * pos,
      sampleRate
    );
  }
  const whine = allocSamples(sampleRate, pullDur);
  let phase = 0;
  for (let i = 0; i < whine.length; i++) {
    const pos = i / whine.length;
    phase += (TWO_PI * (470 + 300 * pos)) / sampleRate;
    whine[i] = (Math.sin(phase) + 0.4 * Math.sin(2.02 * phase)) * pos * Math.min(1, (1 - pos) * 12);
  }
  mixInto(out, whine, t0 + 0.008, 0.055, sampleRate);
  if (short) {
    mixInto(
      out,
      noiseBurst(sampleRate, rng, 0.02, 0.004, {
        bp: 1500,
        q: 1
      }),
      t0 + 0.012 + pullDur,
      0.3,
      sampleRate
    );
  } else {
    const stopTime = t0 + 0.012 + pullDur;
    mixInto(
      out,
      metalClick(
        sampleRate,
        rng,
        [
          [1660, 0.012, 1],
          [2750, 0.01, 0.7],
          [4210, 0.006, 0.5],
          [6300, 0.004, 0.3]
        ],
        {
          hp: 2e3,
          tick: 1
        }
      ),
      stopTime,
      0.75,
      sampleRate
    );
    mixInto(
      out,
      pitchDropSine(sampleRate, 0.05, 205, 100, 0.012, 0.014, 8e-4),
      stopTime,
      0.35,
      sampleRate
    );
  }
  return dcBlock(softClip(normalize(out), 1.2), sampleRate, 60);
}

/** Bolt released forward and slamming home. */
export function synthReloadBolt(sampleRate: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sampleRate, 0.33);
  const t0 = 8e-4;
  const slamTime = t0 + 0.019;
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [2950, 0.003, 1],
        [4580, 0.0025, 0.6]
      ],
      {
        hp: 3e3,
        tick: 0.6
      }
    ),
    t0,
    0.11,
    sampleRate
  );
  const swish = noiseBuffer(sampleRate, 0.018, rng);
  biquadSweep(swish, 'bp', expRamp(1700, 5600), 2.5, sampleRate);
  applyEnvelope(swish, sampleRate, (t) => Math.pow(t / 0.018, 1.6));
  mixInto(out, normalize(swish), t0 + 0.001, 0.16, sampleRate);
  mixInto(
    out,
    applyEnvelope(chirp(sampleRate, 0.018, 850, 2500, false), sampleRate, (t) =>
      Math.pow(t / 0.018, 2)
    ),
    t0 + 0.001,
    0.05,
    sampleRate
  );
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.02, 0.0016, {
      hp: 1400
    }),
    slamTime,
    1.15,
    sampleRate
  );
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.04, 0.007, {
      hp: 500,
      lp: 1900
    }),
    slamTime,
    0.95,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.08,
      [
        [820, 0.012, 1],
        [1240, 0.011, 0.9],
        [1710, 0.009, 0.7]
      ],
      rng
    ),
    slamTime,
    0.4,
    sampleRate
  );
  mixInto(
    out,
    pitchDropSine(sampleRate, 0.07, 255, 104, 0.01, 0.02, 6e-4),
    slamTime,
    0.55,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.2,
      [
        [2290, 0.024, 1],
        [3420, 0.02, 0.85],
        [4640, 0.016, 0.6],
        [2880, 0.018, 0.5],
        [6410, 0.008, 0.35],
        [8350, 0.005, 0.25]
      ].map(([freq, decay, amp]): ModalPartial => [
        freq * randRange(rng, 0.985, 1.015),
        decay,
        amp
      ]),
      rng
    ),
    slamTime,
    0.46,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.28,
      [
        [706, 0.07, 1],
        [1421, 0.045, 0.35]
      ],
      rng
    ),
    slamTime + 0.002,
    0.07,
    sampleRate
  );
  return dcBlock(softClip(normalize(out), 1.6), sampleRate, 45);
}

/** Pistol magazine release and pull-out. */
export function synthPistolMagOut(sampleRate: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sampleRate, 0.27);
  const t0 = 0.003;
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [4120, 0.0035, 1],
        [6340, 0.0028, 0.6],
        [2480, 0.005, 0.4]
      ],
      {
        hp: 3200,
        tick: 0.7
      }
    ),
    t0,
    0.6,
    sampleRate
  );
  mixInto(
    out,
    frictionScrape(sampleRate, rng, 0.09, 3100, 2050, {
      rough: 300,
      rough1: 200,
      hi: 0.4,
      q: 2.4,
      env: peakEnvelope(0.2, 0.8)
    }),
    t0 + 0.012,
    0.42,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.1,
      [
        [3320, 0.02, 1],
        [5150, 0.014, 0.5]
      ],
      rng
    ),
    t0 + 0.02,
    0.05,
    sampleRate
  );
  const hiss = noiseBuffer(sampleRate, 0.14, rng);
  biquad(hiss, 'hp', 4500, 0.7, sampleRate);
  applyEnvelope(hiss, sampleRate, (t) => Math.pow(Math.sin((Math.PI * t) / 0.14), 2));
  mixInto(out, normalize(hiss), t0 + 0.04, 0.05, sampleRate);
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [1720, 0.008, 1],
        [2960, 0.006, 0.6],
        [690, 0.012, 0.5]
      ],
      {
        hp: 2600,
        tick: 0.4
      }
    ),
    t0 + 0.108,
    0.3,
    sampleRate
  );
  return dcBlock(out, sampleRate, 90);
}

/** Pistol magazine sliding into the grip. */
export function synthPistolMagInsert(sampleRate: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sampleRate, 0.19);
  const t0 = 0.003;
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [2900, 0.0035, 1],
        [4650, 0.003, 0.6]
      ],
      {
        hp: 2800,
        tick: 0.5
      }
    ),
    t0,
    0.3,
    sampleRate
  );
  mixInto(
    out,
    frictionScrape(sampleRate, rng, 0.115, 1650, 4300, {
      rough: 220,
      rough1: 420,
      hi: 0.4,
      q: 2.2,
      env: (pos) => Math.pow(pos, 0.7) * (pos > 0.92 ? (1 - pos) / 0.08 : 1)
    }),
    t0 + 0.01,
    0.6,
    sampleRate
  );
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [3700, 0.003, 1],
        [5600, 0.0025, 0.5]
      ],
      {
        hp: 3200,
        tick: 0.6
      }
    ),
    t0 + 0.07,
    0.16,
    sampleRate
  );
  return dcBlock(out, sampleRate, 90);
}

/** Pistol magazine seating with a latch click. */
export function synthPistolMagIn(sampleRate: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sampleRate, 0.15);
  const t0 = 8e-4;
  const latchTime = t0 + 0.013;
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [2620, 0.004, 1],
        [4050, 0.0035, 0.7],
        [1480, 0.006, 0.4]
      ],
      {
        hp: 2600,
        tick: 0.8
      }
    ),
    t0,
    0.55,
    sampleRate
  );
  mixInto(out, pitchDropSine(sampleRate, 0.05, 215, 108, 0.01, 0.013, 8e-4), t0, 0.3, sampleRate);
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.03, 0.006, {
      hp: 350,
      lp: 1600
    }),
    t0,
    0.4,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.04,
      [
        [760, 0.008, 1],
        [1330, 0.007, 0.7]
      ],
      rng
    ),
    t0,
    0.25,
    sampleRate
  );
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [3610, 0.008, 1],
        [5420, 0.0065, 0.75],
        [8130, 0.004, 0.45],
        [2110, 0.008, 0.4]
      ],
      {
        hp: 3200,
        tick: 1
      }
    ),
    latchTime,
    1,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.08,
      [
        [1920, 0.016, 1],
        [2870, 0.012, 0.5]
      ],
      rng
    ),
    latchTime + 6e-4,
    0.07,
    sampleRate
  );
  return dcBlock(softClip(normalize(out), 1.4), sampleRate, 60);
}

/** Pistol slide released forward. */
export function synthPistolSlide(sampleRate: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sampleRate, 0.2);
  const t0 = 8e-4;
  const slamTime = t0 + 0.012;
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [3900, 0.0028, 1],
        [5900, 0.0022, 0.6]
      ],
      {
        hp: 3400,
        tick: 0.6
      }
    ),
    t0,
    0.13,
    sampleRate
  );
  const swish = noiseBuffer(sampleRate, 0.011, rng);
  biquadSweep(swish, 'bp', expRamp(2400, 7200), 2.5, sampleRate);
  applyEnvelope(swish, sampleRate, (t) => Math.pow(t / 0.011, 1.5));
  mixInto(out, normalize(swish), t0 + 0.001, 0.17, sampleRate);
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.012, 0.0011, {
      hp: 2400
    }),
    slamTime,
    1.1,
    sampleRate
  );
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.025, 0.005, {
      hp: 700,
      lp: 2400
    }),
    slamTime,
    0.8,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.05,
      [
        [1180, 0.008, 1],
        [1760, 0.007, 0.8]
      ],
      rng
    ),
    slamTime,
    0.3,
    sampleRate
  );
  mixInto(
    out,
    pitchDropSine(sampleRate, 0.04, 330, 165, 0.007, 0.011, 5e-4),
    slamTime,
    0.32,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.12,
      [
        [3060, 0.012, 1],
        [4490, 0.011, 0.85],
        [6920, 0.008, 0.6],
        [9350, 0.005, 0.35],
        [1710, 0.012, 0.4]
      ].map(([freq, decay, amp]): ModalPartial => [
        freq * randRange(rng, 0.985, 1.015),
        decay,
        amp
      ]),
      rng
    ),
    slamTime,
    0.5,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.1,
      [
        [1190, 0.022, 1],
        [2400, 0.014, 0.4]
      ],
      rng
    ),
    slamTime + 0.002,
    0.05,
    sampleRate
  );
  return dcBlock(softClip(normalize(out), 1.5), sampleRate, 70);
}

/** Adds small jittered metal ticks (buckles, sling swivels) at the given times. */
function addMetalTicks(
  out: Float32Array,
  sampleRate: number,
  rng: RandomFn,
  times: number[],
  gain: number,
  baseFreq: number
): void {
  for (const time of times) {
    const freq = baseFreq * randRange(rng, 0.85, 1.2);
    mixInto(
      out,
      metalClick(
        sampleRate,
        rng,
        [
          [freq, 0.005, 1],
          [freq * 1.47, 0.004, 0.6],
          [freq * 2.3, 0.003, 0.3]
        ],
        {
          hp: 3500,
          tick: 0.4
        }
      ),
      time,
      gain * randRange(rng, 0.5, 1),
      sampleRate
    );
  }
}

/** Weapon put away: fabric rustle, buckle ticks and a holster thump. */
export function synthWeaponHolster(sampleRate: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sampleRate, 0.31);
  mixInto(
    out,
    rustleNoise(sampleRate, rng, 0.26, 2500, 900, peakEnvelope(0.32, 1.2)),
    0.004,
    0.7,
    sampleRate
  );
  addMetalTicks(out, sampleRate, rng, [0.055, 0.112, 0.168], 0.2, 4100);
  mixInto(
    out,
    pitchDropSine(sampleRate, 0.07, 125, 68, 0.02, 0.022, 0.003),
    0.215,
    0.5,
    sampleRate
  );
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.05, 0.012, {
      lp: 520
    }),
    0.215,
    0.45,
    sampleRate
  );
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.05,
      [
        [610, 0.012, 1],
        [1340, 0.008, 0.5]
      ],
      rng
    ),
    0.217,
    0.14,
    sampleRate
  );
  return dcBlock(out, sampleRate, 50);
}

/** Weapon drawn: rustle, ticks and a grip/handling knock. */
export function synthWeaponDraw(sampleRate: number, rng: RandomFn): Float32Array {
  const out = allocSamples(sampleRate, 0.29);
  mixInto(
    out,
    rustleNoise(sampleRate, rng, 0.22, 900, 2800, peakEnvelope(0.5, 1.2)),
    0.004,
    0.65,
    sampleRate
  );
  addMetalTicks(out, sampleRate, rng, [0.04, 0.097, 0.15], 0.17, 4600);
  const knockTime = 0.205;
  mixInto(
    out,
    modalResonators(
      sampleRate,
      0.06,
      [
        [615, 0.012, 1],
        [1510, 0.008, 0.6],
        [2920, 0.005, 0.4]
      ],
      rng
    ),
    knockTime,
    0.4,
    sampleRate
  );
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.02, 0.004, {
      lp: 1400
    }),
    knockTime,
    0.45,
    sampleRate
  );
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.004, 8e-4, {
      hp: 2600
    }),
    knockTime,
    0.3,
    sampleRate
  );
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [2480, 0.004, 1],
        [3900, 0.003, 0.6]
      ],
      {
        hp: 2800,
        tick: 0.5
      }
    ),
    knockTime + 0.022,
    0.14,
    sampleRate
  );
  return dcBlock(out, sampleRate, 60);
}

/** Short gear/clothing rustle while moving (even variants sweep up, odd sweep down). */
export function synthGearRustle(sampleRate: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sampleRate, 0.2);
  const sweepUp = variant % 2 === 0;
  mixInto(
    out,
    rustleNoise(
      sampleRate,
      rng,
      0.17,
      sweepUp ? 1100 : 2300,
      sweepUp ? 2400 : 1200,
      peakEnvelope(0.4, 1.3)
    ),
    0.004,
    0.8,
    sampleRate
  );
  addMetalTicks(out, sampleRate, rng, [0.03 + 0.02 * variant, 0.11], 0.1, 4300);
  return dcBlock(out, sampleRate, 80);
}

/** Brass casing partials: `[frequency Hz, amplitude]`. */
const SHELL_RING_PARTIALS: [number, number][] = [
  [4180, 1],
  [6830, 0.7],
  [9760, 0.5],
  [11900, 0.3],
  [2470, 0.3]
];

/** Ringing brass casing at `pitch` with base decay `decay` (s). */
function shellRing(
  sampleRate: number,
  rng: RandomFn,
  pitch: number,
  decay: number,
  _unused?: number
): Float32Array {
  return modalResonators(
    sampleRate,
    decay * 6,
    SHELL_RING_PARTIALS.map(([freq, amp], index): ModalPartial => [
      freq * pitch,
      decay / (1 + index * 0.35),
      amp
    ]),
    rng
  );
}

/** Spent casing bouncing on concrete. */
export function synthShellBounce(sampleRate: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sampleRate, 0.5);
  const pitch = [1, 1.09, 0.93, 1.04][variant & 3];
  let time = 6e-4;
  let gain = 1;
  const bounces = 2 + (variant !== 1 ? 1 : 0);
  for (let k = 0; k < bounces; k++) {
    const bouncePitch = pitch * (k & 1 ? 1.19 : 1) * randRange(rng, 0.97, 1.04);
    mixInto(
      out,
      shellRing(sampleRate, rng, bouncePitch, randRange(rng, 0.016, 0.03)),
      time,
      gain * 0.5,
      sampleRate
    );
    mixInto(
      out,
      noiseBurst(sampleRate, rng, 0.004, 8e-4, {
        hp: 3200
      }),
      time,
      gain * 0.5,
      sampleRate
    );
    mixInto(
      out,
      noiseBurst(sampleRate, rng, 0.012, 0.0025, {
        bp: 1900,
        q: 0.8
      }),
      time,
      gain * 0.3,
      sampleRate
    );
    time += randRange(rng, 0.085, 0.15) * (k ? 0.72 : 1);
    gain *= randRange(rng, 0.42, 0.6);
  }
  return dcBlock(out, sampleRate, 200);
}

/** Spent casing bouncing on a metal surface, with a rattle unless variant 1. */
export function synthShellBounceMetal(
  sampleRate: number,
  rng: RandomFn,
  variant: number
): Float32Array {
  const out = allocSamples(sampleRate, 0.7);
  const pitch = [1, 1.11, 0.94][variant % 3];
  let time = 6e-4;
  let gain = 1;
  for (let k = 0; k < 3; k++) {
    const bouncePitch = pitch * (k & 1 ? 1.19 : 1) * randRange(rng, 0.97, 1.04);
    mixInto(
      out,
      shellRing(sampleRate, rng, bouncePitch, randRange(rng, 0.045, 0.075)),
      time,
      gain * 0.5,
      sampleRate
    );
    mixInto(
      out,
      noiseBurst(sampleRate, rng, 0.003, 6e-4, {
        hp: 4500
      }),
      time,
      gain * 0.55,
      sampleRate
    );
    mixInto(
      out,
      modalResonators(
        sampleRate,
        0.3,
        [
          [1320 * pitch, 0.05, 1],
          [2130 * pitch, 0.04, 0.6],
          [3350 * pitch, 0.028, 0.4],
          [640 * pitch, 0.03, 0.3]
        ],
        rng
      ),
      time,
      gain * 0.16,
      sampleRate
    );
    time += randRange(rng, 0.075, 0.13) * (k ? 0.7 : 1);
    gain *= randRange(rng, 0.5, 0.66);
  }
  if (variant !== 1) {
    for (let k = 0; k < 6; k++) {
      mixInto(
        out,
        shellRing(sampleRate, rng, pitch * randRange(rng, 1, 1.25), 0.012),
        time,
        gain * 0.3,
        sampleRate
      );
      time += 0.016 + 0.004 * k;
      gain *= 0.75;
    }
  }
  return dcBlock(out, sampleRate, 200);
}

/** Grenade-sized explosion: blast crack, body, rumble, debris crackle and metal pings. */
export function synthExplosion(sampleRate: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sampleRate, 2.2);
  const pitch = variant ? 0.9 : 1;
  const onset = 5e-4;
  const crack = allocSamples(sampleRate, 0.08);
  mixInto(crack, friedlanderPulse(sampleRate, 9e-4), 0, 1.2, sampleRate);
  mixInto(
    crack,
    noiseBurst(sampleRate, rng, 0.03, 0.005, {
      hp: 1500
    }),
    0,
    1.5,
    sampleRate
  );
  softClip(normalize(crack, 2), 2);
  const body = allocSamples(sampleRate, 2.1);
  mixInto(
    body,
    pitchDropSine(sampleRate, 0.9, 122 * pitch, 47, 0.08, 0.16, 0.001),
    0,
    1,
    sampleRate
  );
  const roar = noiseBuffer(sampleRate, 1.4, rng);
  biquadSweep(roar, 'lp', expRamp(3e3, 240, 0.5), 0.7, sampleRate);
  mixInto(
    body,
    normalize(applyEnvelope(roar, sampleRate, expDecay(0.2, 0.002))),
    0,
    1.3,
    sampleRate
  );
  mixInto(
    body,
    noiseBurst(sampleRate, rng, 0.45, 0.08, {
      bp: 500 * pitch,
      q: 1.2
    }),
    0,
    0.8,
    sampleRate
  );
  const rumble = noiseBuffer(sampleRate, 2, rng);
  biquad(rumble, 'lp', 115, 0.7, sampleRate);
  mixInto(
    body,
    normalize(applyEnvelope(rumble, sampleRate, expDecay(0.45, 0.03))),
    0,
    0.4,
    sampleRate
  );
  for (const [time, gain, lpFreq] of [
    [0.13, 0.3, 1900],
    [0.235, 0.2, 1300],
    [0.41, 0.12, 800]
  ]) {
    mixInto(
      body,
      noiseBurst(sampleRate, rng, 0.25, 0.045, {
        hp: 110,
        lp: lpFreq,
        att: 0.004
      }),
      time * (variant ? 1.1 : 1),
      gain,
      sampleRate
    );
  }
  compressBuffer(normalize(body), sampleRate, 0.3, 4, 5e-4, 0.09);
  softClip(normalize(body, 1.6), 1.8);
  mixInto(out, crack, onset, 1, sampleRate);
  mixInto(out, body, onset, 0.8, sampleRate);
  mixInto(
    out,
    normalize(
      crackleBurst(sampleRate, rng, 1.9, 70, {
        from: 0.2,
        fall: 1.5,
        hp: 1500,
        lp: 9e3,
        ampFall: 0.6,
        maxLen: 0.008
      })
    ),
    0,
    0.3,
    sampleRate
  );
  for (let k = 0; k < 5; k++) {
    const freq = randRange(rng, 1e3, 3800);
    mixInto(
      out,
      modalResonators(
        sampleRate,
        0.2,
        [
          [freq, randRange(rng, 0.02, 0.05), 1],
          [freq * 1.61, 0.02, 0.5]
        ],
        rng
      ),
      randRange(rng, 0.35, 1.5),
      randRange(rng, 0.03, 0.08),
      sampleRate
    );
  }
  return duckAfterOnset(
    softClip(normalize(dcBlock(out, sampleRate, 22), 2.2), 1.6),
    sampleRate,
    onset
  );
}

/**
 * Large explosion (barrels, demolition), rendered incrementally: each `yield` lets the caller
 * spread the work across frames.
 */
export function* synthExplosionBig(
  sampleRate: number,
  rng: RandomFn,
  variant: number
): SoundIterator {
  const out = allocSamples(sampleRate, 4.2);
  const pitch = variant ? 0.93 : 1;
  const onset = 5e-4;
  const crack = allocSamples(sampleRate, 0.12);
  mixInto(crack, friedlanderPulse(sampleRate, 0.0014), 0, 1.3, sampleRate);
  mixInto(
    crack,
    noiseBurst(sampleRate, rng, 0.03, 0.004, {
      hp: 2e3
    }),
    0,
    1.6,
    sampleRate
  );
  mixInto(
    crack,
    noiseBurst(sampleRate, rng, 0.1, 0.016, {
      hp: 500,
      lp: 8e3
    }),
    0,
    1.1,
    sampleRate
  );
  softClip(normalize(crack, 2.4), 2.4);
  const body = allocSamples(sampleRate, 4.1);
  mixInto(
    body,
    pitchDropSine(sampleRate, 2.4, 52 * pitch, 29, 0.28, 0.42, 0.004),
    0,
    1,
    sampleRate
  );
  mixInto(
    body,
    pitchDropSine(sampleRate, 1.4, 104 * pitch, 60, 0.2, 0.26, 0.002),
    0,
    0.7,
    sampleRate
  );
  yield;
  const roar = noiseBuffer(sampleRate, 2.6, rng);
  biquadSweep(roar, 'lp', expRamp(4200, 170, 0.45), 0.7, sampleRate);
  mixInto(
    body,
    normalize(applyEnvelope(roar, sampleRate, expDecay(0.36, 0.003))),
    0,
    1.5,
    sampleRate
  );
  mixInto(
    body,
    noiseBurst(sampleRate, rng, 0.8, 0.14, {
      bp: 300 * pitch,
      q: 1
    }),
    0,
    1,
    sampleRate
  );
  yield;
  const rumble = noiseBuffer(sampleRate, 4, rng);
  biquad(rumble, 'lp', 95, 0.7, sampleRate);
  mixInto(body, normalize(applyEnvelope(rumble, sampleRate, expDecay(1, 0.05))), 0, 1, sampleRate);
  const rolling = noiseBuffer(sampleRate, 4, rng);
  biquadSweep(rolling, 'lp', expRamp(420, 110, 0.6), 0.7, sampleRate);
  // Random swells of the rolling rumble: [centerSec, widthSec, amplitude].
  const swells: [number, number, number][] = [];
  for (let k = 0; k < 6; k++) {
    swells.push([randRange(rng, 0.5, 2.8), randRange(rng, 0.12, 0.35), randRange(rng, 0.4, 1)]);
  }
  const rollingEnv = (t: number): number => {
    let level = 0.3;
    for (const [center, width, amp] of swells) {
      const x = (t - center) / width;
      level += amp * Math.exp(-x * x);
    }
    return level * Math.exp(-t / 1.3) * (1 - Math.exp(-t / 0.15));
  };
  for (let i = 0, gain = 0, slope = 0; i < rolling.length; i++) {
    if ((i & 63) === 0) {
      gain = rollingEnv(i / sampleRate);
      slope = (rollingEnv((i + 64) / sampleRate) - gain) / 64;
    }
    rolling[i] *= gain;
    gain += slope;
  }
  mixInto(body, normalize(rolling), 0, 0.55, sampleRate);
  yield;
  for (const [time, gain, lpFreq] of [
    [0.16, 0.42, 1700],
    [0.29, 0.34, 1300],
    [0.47, 0.26, 950],
    [0.79, 0.17, 700],
    [1.22, 0.1, 520]
  ]) {
    mixInto(
      body,
      noiseBurst(sampleRate, rng, 0.5, 0.05 + time * 0.07, {
        hp: 70,
        lp: lpFreq,
        att: 0.006
      }),
      time * (variant ? 1.08 : 1),
      gain,
      sampleRate
    );
  }
  compressBuffer(normalize(body), sampleRate, 0.4, 3, 5e-4, 0.1);
  softClip(normalize(body, 1.7), 1.8);
  mixInto(out, crack, onset, 1, sampleRate);
  mixInto(out, body, onset, 0.85, sampleRate);
  yield;
  mixInto(
    out,
    normalize(
      crackleBurst(sampleRate, rng, 3.4, 170, {
        from: 0.3,
        fall: 1.6,
        hp: 1200,
        lp: 9e3,
        ampFall: 1,
        maxLen: 0.01
      })
    ),
    0,
    0.42,
    sampleRate
  );
  for (let k = 0; k < 11; k++) {
    const freq = randRange(rng, 900, 4200);
    mixInto(
      out,
      modalResonators(
        sampleRate,
        0.3,
        [
          [freq, randRange(rng, 0.02, 0.07), 1],
          [freq * 1.61, 0.025, 0.5],
          [freq * 2.4, 0.012, 0.25]
        ],
        rng
      ),
      randRange(rng, 0.35, 2.7),
      randRange(rng, 0.04, 0.11),
      sampleRate
    );
  }
  const clangTime = randRange(rng, 0.95, 1.3);
  for (const [delay, gain] of [
    [0, 1],
    [0.21, 0.5],
    [0.33, 0.28]
  ]) {
    mixInto(
      out,
      modalResonators(
        sampleRate,
        1,
        [
          [312 * pitch, 0.2, 1],
          [489 * pitch, 0.16, 0.8],
          [744 * pitch, 0.12, 0.6],
          [1183 * pitch, 0.08, 0.4],
          [1735 * pitch, 0.05, 0.3],
          [2620 * pitch, 0.03, 0.2]
        ],
        rng
      ),
      clangTime + delay,
      0.12 * gain,
      sampleRate
    );
    mixInto(
      out,
      noiseBurst(sampleRate, rng, 0.02, 0.004, {
        hp: 900,
        lp: 5e3
      }),
      clangTime + delay,
      0.1 * gain,
      sampleRate
    );
  }
  return duckAfterOnset(
    softClip(normalize(dcBlock(out, sampleRate, 18), 2.2), 1.6),
    sampleRate,
    onset
  );
}

/** Gull drone weapon fire: buzzy square/saw zap with a high crack. */
export function synthGullFire(sampleRate: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sampleRate, 0.26);
  const pitch = [1, 1.08, 0.93][variant % 3];
  const t0 = 5e-4;
  let phase = 0;
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.006, 9e-4, {
      hp: 4200
    }),
    t0,
    0.9,
    sampleRate
  );
  const zap = allocSamples(sampleRate, 0.085);
  for (let i = 0; i < zap.length; i++) {
    const t = i / sampleRate;
    const freq = (520 + 2300 * Math.exp(-t / 0.014)) * pitch;
    phase += freq / sampleRate;
    const wave =
      Math.sign(Math.sin(TWO_PI * phase)) * 0.6 +
      (2 * (phase * 1.5 - Math.floor(phase * 1.5)) - 1) * 0.5;
    zap[i] = wave * (0.75 + 0.25 * Math.sin(TWO_PI * 310 * t)) * Math.exp(-t / 0.02);
  }
  biquad(zap, 'hp', 700 * pitch, 0.8, sampleRate);
  biquad(zap, 'lp', 5200, 0.8, sampleRate);
  mixInto(out, normalize(zap), t0, 1, sampleRate);
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.12, 0.022, {
      hp: 2600,
      lp: 9500,
      att: 0.0015
    }),
    t0 + 0.002,
    0.5,
    sampleRate
  );
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.05, 0.009, {
      bp: 1750 * pitch,
      q: 2.5
    }),
    t0,
    0.4,
    sampleRate
  );
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [3450 * pitch, 0.005, 1],
        [5300, 0.004, 0.6],
        [2050, 0.007, 0.4]
      ],
      {
        hp: 3200,
        tick: 0.5
      }
    ),
    t0 + 0.024,
    0.24,
    sampleRate
  );
  return dcBlock(softClip(normalize(out), 1.5), sampleRate, 350);
}

/** Hound walker weapon fire: ring-modulated saw blast with a thump and mechanical clack. */
export function synthHoundFire(sampleRate: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sampleRate, 0.42);
  const pitch = [1, 0.94, 1.06][variant % 3];
  const t0 = 5e-4;
  let phase = 0;
  let modPhase = 0;
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.008, 0.0013, {
      hp: 2800
    }),
    t0,
    0.8,
    sampleRate
  );
  const blast = allocSamples(sampleRate, 0.17);
  for (let i = 0; i < blast.length; i++) {
    const t = i / sampleRate;
    const freq = (150 + 760 * Math.exp(-t / 0.028)) * pitch;
    phase += freq / sampleRate;
    modPhase += (freq * 2.76 + 90) / sampleRate;
    const saw = 2 * (phase - Math.floor(phase)) - 1;
    blast[i] =
      (saw * 0.8 + Math.sin(TWO_PI * phase) * Math.sin(TWO_PI * modPhase) * 0.9) *
      Math.exp(-t / 0.04) *
      (1 - Math.exp(-t / 6e-4));
  }
  biquad(blast, 'hp', 170, 0.8, sampleRate);
  biquad(blast, 'lp', 3600, 0.8, sampleRate);
  mixInto(out, normalize(blast), t0, 1, sampleRate);
  mixInto(
    out,
    pitchDropSine(sampleRate, 0.09, 210 * pitch, 92 * pitch, 0.016, 0.024, 8e-4),
    t0,
    0.6,
    sampleRate
  );
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.07, 0.014, {
      bp: 640 * pitch,
      q: 1.8
    }),
    t0,
    0.55,
    sampleRate
  );
  const hiss = noiseBuffer(sampleRate, 0.3, rng);
  biquadSweep(hiss, 'bp', expRamp(3800, 1500), 0.9, sampleRate);
  applyEnvelope(hiss, sampleRate, expDecay(0.065, 0.012));
  mixInto(out, normalize(hiss), t0 + 0.03, 0.34, sampleRate);
  mixInto(
    out,
    metalClick(
      sampleRate,
      rng,
      [
        [1380 * pitch, 0.012, 1],
        [2260 * pitch, 0.009, 0.7],
        [3540, 0.006, 0.45]
      ],
      {
        hp: 1800,
        tick: 0.6
      }
    ),
    t0 + 0.062,
    0.26,
    sampleRate
  );
  return dcBlock(softClip(normalize(out), 1.7), sampleRate, 80);
}

/** Bullet passing close by: swept band-noise whiz with a supersonic crack. */
export function synthWhiz(sampleRate: number, rng: RandomFn, variant: number): Float32Array {
  const out = allocSamples(sampleRate, 0.32);
  const whiz = noiseBuffer(sampleRate, 0.3, rng);
  const f0 = [5200, 4300, 6100][variant % 3];
  const f1 = [1300, 1e3, 1700][variant % 3];
  const passTime = 0.05;
  biquadSweep(whiz, 'bp', expRamp(f0, f1, 0.8), 3.5, sampleRate);
  for (let i = 0; i < whiz.length; i++) {
    const x = (i / sampleRate - passTime) / (i / sampleRate < passTime ? 0.018 : 0.055);
    whiz[i] *= Math.exp(-x * x);
  }
  mixInto(out, normalize(whiz), 0, 1, sampleRate);
  mixInto(out, friedlanderPulse(sampleRate, 18e-5), passTime - 0.002, 0.5, sampleRate);
  mixInto(
    out,
    noiseBurst(sampleRate, rng, 0.006, 7e-4, {
      hp: 3500
    }),
    passTime - 0.002,
    0.55,
    sampleRate
  );
  mixInto(out, chirp(sampleRate, 0.2, f0 * 0.5, f1 * 0.6), 0, 0.03, sampleRate);
  return dcBlock(out, sampleRate, 300);
}
