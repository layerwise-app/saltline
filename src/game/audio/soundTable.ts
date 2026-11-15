// Sound-definition table: maps every sound name to its generator and render/mix settings,
// plus helpers that render (optionally incrementally) and normalize a sound variant.
import type { SoundDef, SoundIterator, SoundOutput } from './dsp';
import {
  fadeEdges,
  fnv1aHash,
  mulberry32,
  peakAbs,
  scaleBuffer,
  synthPistolShot,
  synthPistolTailIn,
  synthPistolTailOut,
  synthRifleShot,
  synthRifleTailIn,
  synthRifleTailOut
} from './dsp';
import {
  synthExplosion,
  synthExplosionBig,
  synthGearRustle,
  synthGullFire,
  synthHoundFire,
  synthPistolDry,
  synthPistolMagIn,
  synthPistolMagInsert,
  synthPistolMagOut,
  synthPistolSlide,
  synthReloadBolt,
  synthReloadBoltBack,
  synthReloadMagIn,
  synthReloadMagInsert,
  synthReloadMagOut,
  synthRifleDry,
  synthShellBounce,
  synthShellBounceMetal,
  synthWeaponDraw,
  synthWeaponHolster,
  synthWhiz
} from './sfxWeapons';
import {
  MUSIC_SOUNDS,
  synthAlert,
  synthContainerBang,
  synthEarRing,
  synthFoghorn,
  synthGullCry,
  synthGullDie,
  synthGullRotor,
  synthHalyard,
  synthHoundDie,
  synthHoundServo,
  synthHoundStep,
  synthHurt,
  synthImpactConcrete,
  synthImpactEnemy,
  synthImpactGlass,
  synthImpactMetal,
  synthImpactWater,
  synthImpactWood,
  synthIrOutdoor,
  synthIrShed,
  synthJump,
  synthLand,
  synthRain,
  synthRainInterior,
  synthRelayCut,
  synthRelayHum,
  synthRicochet,
  synthSea,
  synthStepConcrete,
  synthTelegraph,
  synthThunder,
  synthUiClick,
  synthUiHover,
  synthWind
} from './sfxWorld';
import {
  synthGuardDie,
  synthGuardFire,
  synthGuardRadio,
  synthGuardReady,
  synthGuardStep,
  synthImpactFlesh
} from './sfxGuard';

export type { SoundDef } from './dsp';

export const SAMPLE_RATE_HI = 44100;
export const SAMPLE_RATE_MID = 32e3;
export const SAMPLE_RATE_LO = 22050;

/** Every synthesized sound by name. */
export const SOUNDS: Record<string, SoundDef> = {
  rifle_shot: {
    gen: synthRifleShot,
    n: 5,
    sr: SAMPLE_RATE_HI,
    peak: 0.97,
    bus: 'gun',
    max: 9,
    pri: 9,
    boot: 1
  },
  pistol_shot: {
    gen: synthPistolShot,
    n: 4,
    sr: SAMPLE_RATE_HI,
    peak: 0.97,
    bus: 'gun',
    max: 6,
    pri: 9
  },
  rifle_tail_out: {
    gen: synthRifleTailOut,
    n: 2,
    sr: SAMPLE_RATE_MID,
    peak: 0.8,
    fixed: 1,
    bus: 'tail',
    max: 4,
    pri: 8,
    soft: 1
  },
  rifle_tail_in: {
    gen: synthRifleTailIn,
    n: 2,
    sr: SAMPLE_RATE_MID,
    peak: 0.75,
    fixed: 1,
    bus: 'tail',
    max: 4,
    pri: 8,
    soft: 1
  },
  pistol_tail_out: {
    gen: synthPistolTailOut,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.62,
    fixed: 1,
    bus: 'tail',
    max: 3,
    pri: 8,
    soft: 1
  },
  pistol_tail_in: {
    gen: synthPistolTailIn,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.6,
    fixed: 1,
    bus: 'tail',
    max: 3,
    pri: 8,
    soft: 1
  },
  rifle_dry: {
    gen: synthRifleDry,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.5,
    bus: 'gun',
    max: 2,
    pri: 6,
    boot: 1
  },
  pistol_dry: {
    gen: synthPistolDry,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.42,
    bus: 'gun',
    max: 2,
    pri: 6
  },
  reload_magout: {
    gen: synthReloadMagOut,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.45,
    bus: 'gun',
    max: 2,
    pri: 6
  },
  reload_maginsert: {
    gen: synthReloadMagInsert,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.36,
    bus: 'gun',
    max: 2,
    pri: 6
  },
  reload_magin: {
    gen: synthReloadMagIn,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.64,
    bus: 'gun',
    max: 2,
    pri: 7
  },
  reload_boltback: {
    gen: synthReloadBoltBack,
    n: 2,
    sr: SAMPLE_RATE_HI,
    peak: 0.48,
    bus: 'gun',
    max: 2,
    pri: 6
  },
  reload_bolt: {
    gen: synthReloadBolt,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.72,
    bus: 'gun',
    max: 2,
    pri: 7
  },
  pistol_magout: {
    gen: synthPistolMagOut,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.38,
    bus: 'gun',
    max: 2,
    pri: 6
  },
  pistol_maginsert: {
    gen: synthPistolMagInsert,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.3,
    bus: 'gun',
    max: 2,
    pri: 6
  },
  pistol_magin: {
    gen: synthPistolMagIn,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.52,
    bus: 'gun',
    max: 2,
    pri: 7
  },
  pistol_slide: {
    gen: synthPistolSlide,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.6,
    bus: 'gun',
    max: 2,
    pri: 7
  },
  weapon_holster: {
    gen: synthWeaponHolster,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.32,
    bus: 'gun',
    max: 2,
    pri: 5
  },
  weapon_draw: {
    gen: synthWeaponDraw,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.32,
    bus: 'gun',
    max: 2,
    pri: 5
  },
  gear_rustle: {
    gen: synthGearRustle,
    n: 2,
    sr: SAMPLE_RATE_MID,
    peak: 0.18,
    bus: 'gun',
    max: 2,
    pri: 3
  },
  shell_bounce: {
    gen: synthShellBounce,
    n: 4,
    sr: SAMPLE_RATE_HI,
    peak: 0.3,
    bus: 'world',
    max: 4,
    pri: 1,
    ref: 2,
    roll: 1
  },
  shell_bounce_metal: {
    gen: synthShellBounceMetal,
    n: 3,
    sr: SAMPLE_RATE_HI,
    peak: 0.32,
    bus: 'world',
    max: 4,
    pri: 1,
    ref: 2,
    roll: 1
  },
  step_concrete: {
    gen: synthStepConcrete,
    n: 6,
    sr: SAMPLE_RATE_MID,
    peak: 0.45,
    bus: 'near',
    max: 3,
    pri: 3,
    boot: 1
  },
  land: {
    gen: synthLand,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.7,
    bus: 'near',
    max: 2,
    pri: 4
  },
  jump: {
    gen: synthJump,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.35,
    bus: 'near',
    max: 2,
    pri: 3
  },
  hurt: {
    gen: synthHurt,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.85,
    bus: 'dry',
    max: 2,
    pri: 8
  },
  ear_ring: {
    gen: synthEarRing,
    n: 1,
    sr: SAMPLE_RATE_LO,
    peak: 0.2,
    bus: 'dry',
    max: 1,
    pri: 5
  },
  impact_metal: {
    gen: synthImpactMetal,
    n: 3,
    sr: SAMPLE_RATE_HI,
    peak: 0.7,
    bus: 'world',
    max: 4,
    pri: 4,
    ref: 4,
    roll: 0.7
  },
  impact_concrete: {
    gen: synthImpactConcrete,
    n: 3,
    sr: SAMPLE_RATE_HI,
    peak: 0.7,
    bus: 'world',
    max: 4,
    pri: 4,
    ref: 4,
    roll: 0.7
  },
  impact_wood: {
    gen: synthImpactWood,
    n: 2,
    sr: SAMPLE_RATE_HI,
    peak: 0.7,
    bus: 'world',
    max: 3,
    pri: 4,
    ref: 4,
    roll: 0.7
  },
  impact_water: {
    gen: synthImpactWater,
    n: 2,
    sr: SAMPLE_RATE_MID,
    peak: 0.6,
    bus: 'world',
    max: 3,
    pri: 4,
    ref: 4,
    roll: 0.7
  },
  impact_enemy: {
    gen: synthImpactEnemy,
    n: 3,
    sr: SAMPLE_RATE_HI,
    peak: 0.75,
    bus: 'world',
    max: 4,
    pri: 5,
    ref: 5,
    roll: 0.6
  },
  impact_glass: {
    gen: synthImpactGlass,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.6,
    bus: 'world',
    max: 2,
    pri: 4,
    ref: 4,
    roll: 0.7
  },
  whiz: {
    gen: synthWhiz,
    n: 3,
    sr: SAMPLE_RATE_HI,
    peak: 0.5,
    bus: 'world',
    max: 3,
    pri: 5,
    ref: 2.5,
    roll: 0.6
  },
  ricochet: {
    gen: synthRicochet,
    n: 3,
    sr: SAMPLE_RATE_HI,
    peak: 0.4,
    bus: 'world',
    max: 2,
    pri: 3,
    ref: 5,
    roll: 0.6
  },
  gull_fire: {
    gen: synthGullFire,
    n: 3,
    sr: SAMPLE_RATE_HI,
    peak: 0.7,
    bus: 'world',
    max: 5,
    pri: 7,
    ref: 7,
    roll: 0.55
  },
  hound_fire: {
    gen: synthHoundFire,
    n: 3,
    sr: SAMPLE_RATE_HI,
    peak: 0.6,
    bus: 'world',
    max: 5,
    pri: 7,
    ref: 8,
    roll: 0.5
  },
  hound_step: {
    gen: synthHoundStep,
    n: 3,
    sr: SAMPLE_RATE_MID,
    peak: 0.7,
    bus: 'world',
    max: 4,
    pri: 3,
    ref: 5,
    roll: 0.8
  },
  guard_fire: {
    gen: synthGuardFire,
    n: 3,
    sr: SAMPLE_RATE_HI,
    peak: 0.62,
    bus: 'world',
    max: 5,
    pri: 7,
    ref: 8,
    roll: 0.5
  },
  guard_step: {
    gen: synthGuardStep,
    n: 6,
    sr: SAMPLE_RATE_MID,
    peak: 0.42,
    bus: 'world',
    max: 4,
    pri: 2,
    ref: 3,
    roll: 0.9
  },
  guard_ready: {
    gen: synthGuardReady,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.4,
    bus: 'world',
    max: 3,
    pri: 5,
    ref: 4,
    roll: 0.7
  },
  guard_radio: {
    gen: synthGuardRadio,
    n: 2,
    sr: SAMPLE_RATE_MID,
    peak: 0.5,
    bus: 'world',
    max: 2,
    pri: 6,
    ref: 6,
    roll: 0.6
  },
  guard_die: {
    gen: synthGuardDie,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.8,
    bus: 'world',
    max: 3,
    pri: 7,
    ref: 6,
    roll: 0.55
  },
  impact_flesh: {
    gen: synthImpactFlesh,
    n: 3,
    sr: SAMPLE_RATE_HI,
    peak: 0.7,
    bus: 'world',
    max: 4,
    pri: 5,
    ref: 5,
    roll: 0.6
  },
  gull_die: {
    gen: synthGullDie,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.85,
    bus: 'world',
    max: 3,
    pri: 7,
    ref: 7,
    roll: 0.5
  },
  hound_die: {
    gen: synthHoundDie,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.9,
    bus: 'world',
    max: 3,
    pri: 7,
    ref: 7,
    roll: 0.5
  },
  telegraph: {
    gen: synthTelegraph,
    n: 2,
    sr: SAMPLE_RATE_MID,
    peak: 0.42,
    bus: 'world',
    max: 4,
    pri: 6,
    ref: 6,
    roll: 0.6
  },
  alert: {
    gen: synthAlert,
    n: 2,
    sr: SAMPLE_RATE_MID,
    peak: 0.5,
    bus: 'world',
    max: 3,
    pri: 6,
    ref: 8,
    roll: 0.5
  },
  explosion: {
    gen: synthExplosion,
    n: 2,
    sr: SAMPLE_RATE_HI,
    peak: 0.95,
    bus: 'world',
    max: 3,
    pri: 10,
    ref: 12,
    roll: 0.5
  },
  explosion_big: {
    gen: synthExplosionBig,
    n: 2,
    sr: SAMPLE_RATE_MID,
    peak: 0.97,
    bus: 'world',
    max: 2,
    pri: 11,
    ref: 16,
    roll: 0.45
  },
  relay_cut: {
    gen: synthRelayCut,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.75,
    bus: 'world',
    max: 2,
    pri: 8,
    ref: 6,
    roll: 0.5
  },
  thunder: {
    gen: synthThunder,
    n: 2,
    sr: SAMPLE_RATE_LO,
    peak: 0.8,
    bus: 'dry',
    max: 2,
    pri: 6
  },
  foghorn: {
    gen: synthFoghorn,
    n: 1,
    sr: SAMPLE_RATE_LO,
    peak: 0.5,
    bus: 'world',
    max: 1,
    pri: 2
  },
  gull_cry: {
    gen: synthGullCry,
    n: 2,
    sr: SAMPLE_RATE_LO,
    peak: 0.4,
    bus: 'world',
    max: 2,
    pri: 1
  },
  halyard: {
    gen: synthHalyard,
    n: 2,
    sr: SAMPLE_RATE_MID,
    peak: 0.3,
    bus: 'world',
    max: 2,
    pri: 1
  },
  container_bang: {
    gen: synthContainerBang,
    n: 1,
    sr: SAMPLE_RATE_LO,
    peak: 0.6,
    bus: 'world',
    max: 1,
    pri: 2
  },
  ui_click: {
    gen: synthUiClick,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.3,
    bus: 'dry',
    max: 2,
    pri: 9
  },
  ui_hover: {
    gen: synthUiHover,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.12,
    bus: 'dry',
    max: 2,
    pri: 9
  },
  gull_rotor: {
    gen: synthGullRotor,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.6,
    loop: 1,
    ref: 5,
    roll: 0.9
  },
  hound_servo: {
    gen: synthHoundServo,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.42,
    loop: 1,
    ref: 4,
    roll: 1
  },
  relay_hum: {
    gen: synthRelayHum,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.4,
    loop: 1,
    ref: 2.5,
    roll: 1.4
  },
  rain: {
    gen: synthRain,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.5,
    loop: 1
  },
  rain_interior: {
    gen: synthRainInterior,
    n: 1,
    sr: SAMPLE_RATE_MID,
    peak: 0.7,
    loop: 1
  },
  wind: {
    gen: synthWind,
    n: 1,
    sr: SAMPLE_RATE_LO,
    peak: 0.5,
    loop: 1
  },
  sea: {
    gen: synthSea,
    n: 1,
    sr: SAMPLE_RATE_LO,
    peak: 0.5,
    loop: 1,
    ref: 10,
    roll: 0.6
  },
  ...MUSIC_SOUNDS,
  ir_outdoor: {
    gen: synthIrOutdoor,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.9,
    ir: 1
  },
  ir_shed: {
    gen: synthIrShed,
    n: 1,
    sr: SAMPLE_RATE_HI,
    peak: 0.9,
    ir: 1
  }
};

/** Game event names that map to a differently named sound. */
export const EVENT_SOUND_ALIASES: Record<string, string> = {
  step: 'step_concrete',
  impact: 'impact_concrete',
  hurt: 'hurt',
  objective_done: 'objective',
  objective_all: 'objective',
  extraction: 'complete',
  enemy_alert: 'alert'
};

const isIterator = (value: SoundOutput | SoundIterator): value is SoundIterator =>
  !!value && typeof (value as Partial<SoundIterator>).next == 'function';

/** A rendered, normalized sound variant. */
export interface RenderedSound {
  /** Sample rate. */
  sr: number;
  /** One buffer per channel. */
  ch: Float32Array[];
  loop: boolean;
}

/** Handle for rendering a sound across several frames. */
export interface IncrementalSound {
  /** Advances the generator one slice; returns the finished sound or null if not done yet. */
  step(): RenderedSound | null;
}

/** Edge-fades (non-loops) and normalizes the generator output to the definition's peak. */
function finalizeSound(def: SoundDef, output: SoundOutput, sampleRate: number): RenderedSound {
  const channels = Array.isArray(output) ? output : [output];
  if (!def.loop) {
    for (const ch of channels) fadeEdges(ch, sampleRate, def.ir ? 0 : 3e-4, def.ir ? 0.05 : 0.012);
  }
  let peak = 0;
  for (const ch of channels) peak = Math.max(peak, peakAbs(ch));
  const gain = def.fixed ? Math.min(1, def.peak / (peak || 1)) : peak > 0 ? def.peak / peak : 1;
  for (const ch of channels) scaleBuffer(ch, gain);
  return {
    sr: sampleRate,
    ch: channels,
    loop: !!def.loop
  };
}

/** Renders variant `variant` of sound `name` synchronously (null if unknown). */
export function synthSound(name: string, variant = 0, sampleRate?: number): RenderedSound | null {
  const def = SOUNDS[name];
  if (!def) return null;
  const sr = sampleRate || def.sr;
  const variantIndex = variant % def.n;
  let output = def.gen(sr, mulberry32(fnv1aHash(name) + variantIndex * 7919), variantIndex);
  if (isIterator(output)) {
    let result: IteratorResult<unknown, SoundOutput>;
    do result = output.next();
    while (!result.done);
    output = result.value;
  }
  return finalizeSound(def, output, sr);
}

/** Starts rendering a sound incrementally; call `step()` once per frame until it returns the sound. */
export function synthSoundIncremental(
  name: string,
  variant = 0,
  sampleRate?: number
): IncrementalSound | null {
  const def = SOUNDS[name];
  if (!def) return null;
  const sr = sampleRate || def.sr;
  const variantIndex = variant % def.n;
  let output = def.gen(sr, mulberry32(fnv1aHash(name) + variantIndex * 7919), variantIndex);
  let finished: RenderedSound | null = null;
  return {
    step() {
      if (finished) return finished;
      if (isIterator(output)) {
        const result = output.next();
        if (!result.done) return null;
        output = result.value;
      }
      return (finished = finalizeSound(def, output, sr));
    }
  };
}
