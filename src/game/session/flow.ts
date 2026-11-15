/**
 * Game flow / session state machine: title attract camera, intro, playing,
 * pause, death and debrief. Runs the mission (cut three relays -> waves ->
 * pursuit -> reach the boat) and the endless holdout mode, enemy spawn
 * queues, difficulty presets, radio lines, adaptive music intensity, pad aim
 * assist / rumble and menu navigation. Stored as `game.game`.
 */
import { PLAYER_BODY } from '../core/config';
import { Vector3 } from 'three';
import { clamp, clamp01, damp, smoothstep } from '../core/math';
import type { Game } from '../core/types';
import type { EnemySpawnOptions } from '../enemies/index';
import type { CinematicShot, EnemySpawn, LevelObjective } from '../level/index';
import { createMenu } from '../ui/menu';
import { getLocale, t } from '../i18n';
import type { MessageKey } from '../i18n';
import type { HoldoutResult, Menu } from '../ui/menu';
import type { HudMarker } from '../ui/hud';

/** Per-type enemy counts. */
interface EnemyCounts {
  gull: number;
  hound: number;
  /** Human guards replace part of the gull count, so wave sizes stay the same. */
  guard: number;
}

const FLOW_TUNING = {
  introSeconds: 2.4,
  retryIntroSeconds: 1.1,
  interactRange: 2.2,
  interactFacing: 0.45,
  cutSeconds: 2.4,
  /**
   * Enemies already patrolling when the mission starts. The force is mostly human guards;
   * the mission fields one hound and one gull drone in total (see MACHINE_CAP).
   */
  patrol: {
    gull: 1,
    hound: 1,
    guard: 2
  } as EnemyCounts,
  /** Wave sent after each relay cut (guards only; the machines are already out on patrol). */
  waves: [
    {
      gull: 0,
      hound: 0,
      guard: 3
    },
    {
      gull: 0,
      hound: 0,
      guard: 4
    },
    {
      gull: 0,
      hound: 0,
      guard: 5
    }
  ] as EnemyCounts[],
  maxAlive: 7,
  spawnStagger: 0.85,
  spawnFar: 18,
  pursuitEvery: 7,
  pursuitMinAlive: 4,
  pursuitExtra: 5,
  titleSpeed: 1.15,
  titleFov: 50
};

/** Mission flow tuning (`game.game.flow`; difficulty presets override parts of it). */
export type FlowTuning = typeof FLOW_TUNING;

/** A table of tuning values overridden by a difficulty preset. */
type TuningOverrides = Record<string, number | number[]>;

interface DifficultyPreset {
  label: string;
  gull?: TuningOverrides;
  hound?: TuningOverrides;
  guard?: TuningOverrides;
  ai?: TuningOverrides;
  player?: TuningOverrides;
  flow?: Partial<FlowTuning>;
}

const DIFFICULTY_PRESETS: Record<string, DifficultyPreset | undefined> & {
  hard: DifficultyPreset;
} = {
  standard: {
    label: 'Standard'
  },
  hard: {
    label: 'Hard',
    gull: {
      hp: 55,
      boltDamage: 10,
      telegraph: 0.46,
      cooldown: [1.4, 2.5],
      spreadFar: 0.052,
      spreadNear: 0.016
    },
    hound: {
      hp: 170,
      shotDamage: 8,
      burst: 5,
      cooldown: [1.4, 2.4],
      spreadFar: 0.095,
      spreadNear: 0.038,
      lungeDamage: 22,
      runSpeed: 5
    },
    guard: {
      hp: 95,
      shotDamage: 5,
      burst: 5,
      volley: 3,
      volleyGap: [0.2, 0.4],
      telegraph: 0.35,
      cooldown: [0.9, 1.6],
      reactTime: 0.45,
      flinch: 0.18,
      suppressTime: 1.8,
      advance: 0.18,
      retreatBelow: 0.25,
      spreadFar: 0.09,
      spreadNear: 0.045
    },
    ai: {
      maxTokens: 3,
      maxTokensCrowd: 4,
      tokenGap: 0.85,
      guardTokens: 5,
      guardTokenGap: 0.35,
      exposureUp: 0.14
    },
    player: {
      regenDelay: 5.5,
      regenRate: 16
    },
    flow: {
      patrol: {
        gull: 1,
        hound: 1,
        guard: 3
      },
      waves: [
        {
          gull: 0,
          hound: 0,
          guard: 4
        },
        {
          gull: 0,
          hound: 0,
          guard: 5
        },
        {
          gull: 0,
          hound: 0,
          guard: 7
        }
      ],
      maxAlive: 9,
      pursuitEvery: 5.5,
      pursuitExtra: 8
    }
  },
  brutal: {
    label: 'Brutal',
    gull: {
      hp: 60,
      boltDamage: 13,
      telegraph: 0.38,
      cooldown: [1, 1.9],
      spreadFar: 0.042,
      spreadNear: 0.014
    },
    hound: {
      hp: 200,
      shotDamage: 10,
      burst: 6,
      cooldown: [1, 1.9],
      spreadFar: 0.08,
      spreadNear: 0.032,
      lungeDamage: 30,
      runSpeed: 5.4
    },
    guard: {
      hp: 105,
      shotDamage: 6,
      burst: 6,
      volley: 4,
      volleyGap: [0.15, 0.3],
      telegraph: 0.28,
      cooldown: [0.5, 1.1],
      reactTime: 0.35,
      flinch: 0.08,
      suppressTime: 2.5,
      advance: 0.3,
      retreatBelow: 0.15,
      spreadFar: 0.075,
      spreadNear: 0.035
    },
    ai: {
      maxTokens: 4,
      maxTokensCrowd: 5,
      tokenGap: 0.6,
      guardTokens: 7,
      guardTokenGap: 0.2,
      exposureUp: 0.18
    },
    player: {
      regenDelay: 7,
      regenRate: 10
    },
    flow: {
      patrol: {
        gull: 1,
        hound: 1,
        guard: 4
      },
      waves: [
        {
          gull: 0,
          hound: 0,
          guard: 5
        },
        {
          gull: 0,
          hound: 0,
          guard: 7
        },
        {
          gull: 0,
          hound: 0,
          guard: 8
        }
      ],
      maxAlive: 11,
      pursuitEvery: 4.5,
      pursuitExtra: 12
    }
  }
};

/** Most hounds and gull drones alive at once; further requests spawn guards. */
const MACHINE_CAP: Record<string, number | undefined> = { gull: 1, hound: 1 };

/** Holdout mode tuning; the functions take the wave number (1-based). */
const HOLDOUT_TUNING = {
  firstDelay: 3.5,
  breather: 9,
  count: (wave: number) => Math.min(4 + 2 * wave, 26),
  /** Machines per wave (the rest are guards): one gull drone, plus one hound from wave 2. */
  gulls: (_wave: number) => 1,
  hounds: (wave: number) => (wave >= 2 ? 1 : 0),
  stagger: (wave: number) => Math.max(0.35, 0.9 - 0.04 * wave),
  hp: (wave: number) => Math.min(2.5, 1 + 0.07 * (wave - 1)),
  dmg: (wave: number) => Math.min(2, 1 + 0.05 * (wave - 1)),
  cool: (wave: number) => Math.max(0.6, 1 - 0.03 * (wave - 1)),
  extraAlive: (wave: number) => Math.min(5, Math.floor(wave / 2)),
  resupply: 90,
  reserveCap: 240,
  heal: 35,
  killScore: {
    gull: 100,
    hound: 250,
    guard: 175
  } as Record<string, number | undefined>,
  waveBonus: 500,
  bestKey: 'saltline.holdout.best'
};

/** Holdout mode tuning (`game.game.holdout`). */
export type HoldoutTuning = typeof HOLDOUT_TUNING;

/** Translated name of the compass direction nearest to `bearing` (degrees). */
function directionName(bearing: number): string {
  return t(`dir.${Math.round(bearing / 45) % 8}` as MessageKey);
}
/** Radio lines in the active language. */
const radioLines = () => ({
  intro: t('radio.intro'),
  contact: t('radio.contact'),
  guards: t('radio.guards'),
  cut: [t('radio.cut1'), t('radio.cut2')],
  all: t('radio.all'),
  low: t('radio.low'),
  done: t('radio.done')
});

/** Game states. `'showcase'` is only used by the placeholder flow of showcase mode. */
export type GameState = 'title' | 'intro' | 'playing' | 'paused' | 'dead' | 'complete' | 'showcase';

/** A relay objective during a run. */
export interface RelayState {
  o: LevelObjective;
  id: string;
  /** Single-letter name shown on markers ("A", "B", ...). */
  short: string;
  /** Cut progress, 0..1. */
  t: number;
  cut: boolean;
  cutting: boolean;
}

/** A queued enemy spawn. */
export interface SpawnRequest {
  type: string;
  pos: Vector3;
  /** Run time at which to spawn. */
  at: number;
  tries?: number;
}

/** State of the current run (`game.game.run`). */
export interface FlowRun {
  time: number;
  retries: number;
  relays: RelayState[];
  cut: number;
  allCut: boolean;
  queue: SpawnRequest[];
  /** Seconds the latest wave counts as "hot" for music intensity. */
  waveHot: number;
  alertT: number;
  pursuitT: number;
  pursuitLeft: number;
  contactSaid: boolean;
  /** The one-time radio line about human guards has played. */
  guardsSaid: boolean;
  lowSaid: boolean;
  extractHint: number;
  intensity: number;
  /** Spawn point -> run time it was last used. */
  used: Map<EnemySpawn, number>;
  mode: string;
  wave: number;
  waveOn: boolean;
  breakT: number;
  score: number;
  kills: number;
  wavesCleared: number;
}

/** Options for {@link GameFlow.start}. */
export interface GameStartOptions {
  skipIntro?: boolean;
  quick?: boolean;
  /** `'mission'` / `'holdout'`; defaults to the menu setting. */
  mode?: string | null;
}

/**
 * The game flow (`game.game`). Only `state`, `update` and `start` exist on
 * the placeholder flow used in showcase mode.
 */
export interface GameFlow {
  state: GameState;
  flow?: FlowTuning;
  run?: FlowRun;
  menus?: Menu;
  holdout?: HoldoutTuning;
  difficulty?: string;
  setDifficulty?(name: string): void;
  start(options?: GameStartOptions): void;
  pause?(): void;
  resume?(): void;
  /** Advances the state machine; returns false when gameplay systems should not tick. */
  update(dt: number): boolean;
  /** Debug: cuts the next relay. */
  debugCut?(): void;
}

/** Post-chain parameters the flow animates. */
interface FlowPostParams {
  saturation?: number;
  fade?: number;
  flash?: number;
}

/** Enemy tuning fields scaled per holdout wave. */
interface EnemyWaveTuning {
  gull: { hp: number; boltDamage: number; cooldown: number[] };
  hound: { hp: number; shotDamage: number; lungeDamage: number; cooldown: number[] };
  guard: { hp: number; shotDamage: number; cooldown: number[] };
}

interface EnemyKilledEvent {
  type?: string;
}
interface InputLockEvent {
  locked: boolean;
}
interface WeaponFireEvent {
  weapon?: string;
}
interface PlayerHitEvent {
  amount?: number;
}
interface ExplosionEvent {
  pos?: Vector3;
  size?: number;
}

/** Deep copy of plain JSON data. */
const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Creates the game flow, its menus, and shows the title screen. */
export function createGameFlow(game: Game): GameFlow {
  const post: FlowPostParams = (game.render && game.render.post) || {};
  const baseSaturation = typeof post.saturation == 'number' ? post.saturation : 1;
  const player = game.player;
  const level = game.level;
  const hud = game.hud;
  const input = game.input;
  /** Calls `target[method](...args)` if it exists, logging (not throwing) errors. */
  const safeCall = (
    target: object | null | undefined,
    method: string,
    ...args: unknown[]
  ): unknown => {
    try {
      const record = target as Record<string, unknown> | null | undefined;
      if (record && typeof record[method] == 'function') {
        return (record[method] as (...callArgs: unknown[]) => unknown)(...args);
      }
    } catch (err) {
      console.error(`[game] ${method} threw`, err);
    }
    return undefined;
  };
  const menus = createMenu(game, {
    difficulty(name) {
      applyDifficulty(name);
    },
    deploy() {
      safeCall(game.audio, 'resume');
      input.requestLock();
      beginRun({});
    },
    resume() {
      resume(true);
    },
    home() {
      toTitle();
    },
    restart() {
      safeCall(game.audio, 'resume');
      input.requestLock();
      run.retries++;
      beginRun({
        quick: true,
        keepRetries: true
      });
    },
    retry() {
      safeCall(game.audio, 'resume');
      input.requestLock();
      run.retries++;
      beginRun({
        quick: true,
        keepRetries: true
      });
    },
    redeploy() {
      safeCall(game.audio, 'resume');
      input.requestLock();
      beginRun({
        quick: true
      });
    }
  });
  menus.applySettings();

  // Difficulty presets apply on top of these untouched copies of the tuning tables.
  const enemyTune = (): EnemyWaveTuning | null => (game.enemies && game.enemies.TUNE) || null;
  const baseline: {
    flow: FlowTuning;
    player: object | null;
    enemies: EnemyWaveTuning | null;
  } = {
    flow: cloneJson(FLOW_TUNING),
    player: player.tuning ? cloneJson(player.tuning) : null,
    enemies: null
  };

  function applyDifficulty(name: string): void {
    const preset = DIFFICULTY_PRESETS[name] || DIFFICULTY_PRESETS.hard;
    const tune = enemyTune();
    if (tune && !baseline.enemies) baseline.enemies = cloneJson(tune);
    /** Restores `target`'s scalar / array fields from `base`, then applies `overrides`. */
    const assignTuning = (
      target: object | null | undefined,
      base: object | null | undefined,
      overrides: TuningOverrides | undefined
    ) => {
      if (!target || !base) return;
      const dst = target as Record<string, unknown>;
      const src = base as Record<string, unknown>;
      for (const key in src) {
        const value = src[key];
        if (typeof value != 'object' || Array.isArray(value)) {
          dst[key] = Array.isArray(value) ? value.slice() : value;
        }
      }
      const extra: TuningOverrides = overrides || {};
      for (const key in extra) {
        dst[key] = Array.isArray(extra[key]) ? (extra[key] as number[]).slice() : extra[key];
      }
    };
    if (tune) {
      assignTuning(tune, baseline.enemies, preset.ai);
      assignTuning(tune.gull, baseline.enemies!.gull, preset.gull);
      assignTuning(tune.hound, baseline.enemies!.hound, preset.hound);
      assignTuning(tune.guard, baseline.enemies!.guard, preset.guard);
    }
    assignTuning(player.tuning, baseline.player, preset.player);
    Object.assign(FLOW_TUNING, cloneJson(baseline.flow), cloneJson(preset.flow || {}));
    flowApi.difficulty = DIFFICULTY_PRESETS[name] ? name : 'hard';
  }

  const isHoldout = () => run.mode === 'holdout';
  const fmtScore = (score: number) => Math.round(score).toLocaleString(getLocale());

  function updateTally(): void {
    if (isHoldout() && hud.setTally) {
      hud.setTally(
        run.wave > 0 ? t('tally.wave', { n: run.wave, score: fmtScore(run.score) }) : t('tally.standby')
      );
    }
  }

  /** Holdout: scales enemies for the next wave and queues it. */
  function startWave(): void {
    const wave = ++run.wave;
    const tune = enemyTune();
    applyDifficulty(flowApi.difficulty);
    if (tune) {
      const hpScale = HOLDOUT_TUNING.hp(wave);
      const damageScale = HOLDOUT_TUNING.dmg(wave);
      const cooldownScale = HOLDOUT_TUNING.cool(wave);
      tune.gull.hp = Math.round(tune.gull.hp * hpScale);
      tune.hound.hp = Math.round(tune.hound.hp * hpScale);
      tune.guard.hp = Math.round(tune.guard.hp * hpScale);
      tune.gull.boltDamage *= damageScale;
      tune.hound.shotDamage *= damageScale;
      tune.hound.lungeDamage *= damageScale;
      tune.guard.shotDamage *= damageScale;
      tune.gull.cooldown = tune.gull.cooldown.map((secs) => secs * cooldownScale);
      tune.hound.cooldown = tune.hound.cooldown.map((secs) => secs * cooldownScale);
      tune.guard.cooldown = tune.guard.cooldown.map((secs) => secs * cooldownScale);
    }
    FLOW_TUNING.maxAlive += HOLDOUT_TUNING.extraAlive(wave);
    const count = HOLDOUT_TUNING.count(wave);
    // Mostly guards; the machines arrive mid-wave (MACHINE_CAP keeps one of each alive).
    const types: string[] = [];
    for (let i = 0; i < count; i++) types.push('guard');
    if (HOLDOUT_TUNING.gulls(wave) > 0) types[Math.min(count - 1, 1)] = 'gull';
    if (HOLDOUT_TUNING.hounds(wave) > 0) types[Math.min(count - 1, Math.floor(count / 2))] = 'hound';
    let sumX = 0;
    let sumZ = 0;
    const stagger = HOLDOUT_TUNING.stagger(wave);
    types.forEach((type, index) => {
      const pos = pickSpawn(type);
      sumX += pos.x - player.pos.x;
      sumZ += pos.z - player.pos.z;
      run.queue.push({
        type,
        pos,
        at: run.time + 1.2 + index * stagger
      });
    });
    run.waveOn = true;
    run.waveHot = 30;
    const bearing = ((Math.atan2(sumX, -sumZ) * 180) / Math.PI + 360) % 360;
    if (hud.warn) {
      hud.warn(t('warn.wave', { n: wave, dir: directionName(bearing) }), 3.6);
    }
    hud.setObjective(t('obj.hold'));
    updateTally();
    game.events.emit('holdout:wave', {
      wave,
      count
    });
  }

  /** Holdout: wave cleared -> bonus, resupply, heal and a breather. */
  function endWave(): void {
    run.waveOn = false;
    run.wavesCleared = run.wave;
    run.breakT = HOLDOUT_TUNING.breather;
    run.score += HOLDOUT_TUNING.waveBonus * run.wave;
    try {
      const weapon = game.weapon as typeof game.weapon & { slots?: { reserve: number }[] };
      const primary = weapon.slots && weapon.slots[0];
      if (primary && Number.isFinite(primary.reserve)) {
        primary.reserve = Math.min(
          HOLDOUT_TUNING.reserveCap,
          primary.reserve + HOLDOUT_TUNING.resupply
        );
      }
    } catch {}
    player.heal(HOLDOUT_TUNING.heal);
    if (run.wave % 2 === 0) safeCall(game.explosives, 'reset');
    if (hud.radio) {
      hud.radio(
        t('radio.waveDown', { n: run.wave, s: HOLDOUT_TUNING.breather }),
        3.4
      );
    }
    hud.setObjective(t('obj.breath'));
    updateTally();
    game.events.emit('objective:done', {
      id: 'wave',
      index: run.wave,
      total: run.wave
    });
  }

  function updateHoldout(dt: number): void {
    if (run.waveOn) {
      if (!run.queue.length && aliveCount() === 0) endWave();
    } else {
      run.breakT -= dt;
      if (run.breakT <= 0) startWave();
      else if (
        run.wave > 0 &&
        run.breakT < 3.05 &&
        Math.ceil(run.breakT) !== Math.ceil(run.breakT + dt)
      ) {
        hud.message(t('msg.waveIn', { n: run.wave + 1, s: Math.ceil(run.breakT) }), 1);
      }
    }
  }

  game.events.on('enemy:killed', (event: EnemyKilledEvent | null) => {
    if (!isHoldout() || flowApi.state !== 'playing') return;
    run.kills++;
    run.score +=
      (HOLDOUT_TUNING.killScore[(event && event.type) as string] || 100) *
      (1 + 0.1 * (run.wave - 1));
    updateTally();
  });

  /** Holdout results for the death screen; stores a new best score. */
  function holdoutResult(): HoldoutResult {
    let best = 0;
    try {
      best = Number(localStorage.getItem(HOLDOUT_TUNING.bestKey)) || 0;
    } catch {}
    const score = Math.round(run.score);
    const record = score > best;
    if (record) {
      best = score;
      try {
        localStorage.setItem(HOLDOUT_TUNING.bestKey, String(best));
      } catch {}
    }
    return {
      waves: run.wavesCleared,
      kills: run.kills,
      score,
      best,
      record
    };
  }

  const run: FlowRun = {
    time: 0,
    retries: 0,
    relays: [],
    cut: 0,
    allCut: false,
    queue: [],
    waveHot: 0,
    alertT: 0,
    pursuitT: 0,
    pursuitLeft: 0,
    contactSaid: false,
    guardsSaid: false,
    lowSaid: false,
    extractHint: 0,
    intensity: 0.15,
    used: new Map(),
    mode: 'mission',
    wave: 0,
    waveOn: false,
    breakT: 0,
    score: 0,
    kills: 0,
    wavesCleared: 0
  };
  let stateTime = 0;
  let introLength = FLOW_TUNING.introSeconds;
  let locationCardShown = false;
  let introRadioSaid = false;
  /** After pausing, ignore the pause key briefly so the same press doesn't resume. */
  let pauseGrace = 0;
  let unusedTimer = 0; // never read (kept from the original)
  /** Pointer lock was acquired during play; losing it then pauses. */
  let hadLock = false;
  let lastLookText = '';
  let lockHintTimer = 0.8;
  const tmpA = new Vector3();
  const tmpB = new Vector3();
  const objectives = (): LevelObjective[] => (level && level.objectives) || [];
  const flowApi: Required<GameFlow> = {
    state: 'title',
    flow: FLOW_TUNING,
    run,
    menus,
    holdout: HOLDOUT_TUNING,
    difficulty: 'hard',
    setDifficulty: (name) => applyDifficulty(name),
    start(options = {}) {
      beginRun({
        skipIntro: !!options.skipIntro,
        quick: !!options.quick,
        mode: options.mode || (game.params.mode === 'holdout' ? 'holdout' : null)
      });
    },
    pause() {
      pause();
    },
    resume() {
      resume(false);
    },
    update,
    debugCut() {
      const relay = run.relays.find((r) => !r.cut);
      if (relay) cutRelay(relay);
    }
  };

  function setState(next: GameState): void {
    const prev = flowApi.state;
    if (next !== prev) {
      flowApi.state = next;
      stateTime = 0;
      game.events.emit('game:state', {
        state: next,
        prev
      });
    }
  }

  // Title screen attract camera along the level's cinematic path.
  const cine: { pos: Vector3[]; look: Vector3[]; len: number; t: number } = {
    pos: [],
    look: [],
    len: 1,
    t: 0
  };
  function buildCinePath(): void {
    const path: CinematicShot[] = (level && level.cinematicPath) || [];
    cine.pos = path.map((shot) => new Vector3(...shot.pos));
    cine.look = path.map((shot) => new Vector3(...shot.look));
    if (cine.pos.length < 2) {
      const start = (level && level.playerStart && level.playerStart.pos) || new Vector3();
      cine.pos = [new Vector3(start.x, 2.2, start.z), new Vector3(start.x + 8, 2, start.z)];
      cine.look = [
        new Vector3(start.x + 30, 2.5, start.z - 2),
        new Vector3(start.x + 40, 3, start.z - 2)
      ];
    }
    let length = 0;
    for (let i = 1; i < cine.pos.length; i++) length += cine.pos[i].distanceTo(cine.pos[i - 1]);
    cine.len = Math.max(length, 4);
  }

  /** Catmull-Rom spline through `points` at `t` in 0..1, written to `out`. */
  function catmullRom(points: Vector3[], t: number, out: Vector3): Vector3 {
    const last = points.length - 1;
    const f = clamp(t, 0, 1) * last;
    const i = Math.min(last - 1, Math.floor(f));
    const u = f - i;
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(last, i + 2)];
    const u2 = u * u;
    const u3 = u2 * u;
    const spline = (a: number, b: number, c: number, d: number) =>
      0.5 *
      (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
    return out.set(
      spline(p0.x, p1.x, p2.x, p3.x),
      spline(p0.y, p1.y, p2.y, p3.y),
      spline(p0.z, p1.z, p2.z, p3.z)
    );
  }

  function updateTitleCamera(dt: number): void {
    const duration = Math.max(26, cine.len / FLOW_TUNING.titleSpeed);
    cine.t += dt;
    if (cine.t >= duration) cine.t = 0;
    const u = cine.t / duration;
    const s = u * u * (3 - 2 * u) * 0.25 + u * 0.75;
    const camera = game.camera;
    const time = game.time.t;
    catmullRom(cine.pos, s, tmpA);
    catmullRom(cine.look, s, tmpB);
    // Gentle handheld drift.
    tmpA.x += Math.sin(time * 0.31) * 0.05;
    tmpA.y += Math.sin(time * 0.43 + 1.7) * 0.035;
    tmpA.z += Math.sin(time * 0.27 + 0.6) * 0.05;
    tmpB.y += Math.sin(time * 0.19) * 0.12;
    tmpB.x += Math.sin(time * 0.13 + 2) * 0.2;
    camera.position.copy(tmpA);
    camera.lookAt(tmpB);
    camera.rotation.z += Math.sin(time * 0.21) * 0.006;
    if (!game.params.fov && Math.abs(camera.fov - FLOW_TUNING.titleFov) > 0.01) {
      camera.fov = FLOW_TUNING.titleFov;
      camera.updateProjectionMatrix();
    }
    post.fade = Math.max(
      1 - smoothstep(0, 1.8, cine.t),
      smoothstep(duration - 1.6, duration, cine.t)
    );
  }

  /** Resets every subsystem and the run state for a fresh attempt. */
  function resetRun(): void {
    safeCall(game.enemies, 'clear');
    safeCall(game.fx, 'clear');
    safeCall(game.combat, 'reset');
    safeCall(game.weapon, 'reset');
    safeCall(game.explosives, 'reset');
    run.time = 0;
    run.cut = 0;
    run.allCut = false;
    run.queue.length = 0;
    run.waveHot = 0;
    run.alertT = 0;
    run.pursuitT = 0;
    run.pursuitLeft = 0;
    run.contactSaid = false;
    run.guardsSaid = false;
    run.lowSaid = false;
    run.extractHint = 0;
    run.used.clear();
    run.wave = 0;
    run.waveOn = false;
    run.breakT = HOLDOUT_TUNING.firstDelay;
    run.score = 0;
    run.kills = 0;
    run.wavesCleared = 0;
    applyDifficulty(flowApi.difficulty);
    run.relays = objectives().map((objective, index) => {
      const match = /([a-z0-9])$/i.exec(String(objective.id || ''));
      const short = (match ? match[1] : String.fromCharCode(65 + index)).toUpperCase();
      setRelayState(objective, 'live');
      return {
        o: objective,
        id: objective.id || 'relay_' + index,
        short,
        t: 0,
        cut: false,
        cutting: false
      };
    });
    player.reset(level.playerStart);
    // QA: `?god=1` keeps the player alive (enemies still aim, fire and hit).
    if (game.params.god) player.invulnerable = true;
    if (hud.reset) hud.reset();
    post.saturation = baseSaturation;
    post.flash = 0;
    if (isHoldout()) {
      for (const relay of run.relays) setRelayState(relay.o, 'cut');
      run.relays = [];
    }
    refreshMarkers();
    if (hud.setRelays) hud.setRelays(0, run.relays.length);
    if (hud.setTally) hud.setTally(isHoldout() ? t('tally.standby') : null);
    if (!isHoldout()) spawnPatrols();
    if (game.params.qa === 'guard') spawnQaGuards();
  }

  /**
   * QA (`?qa=guard`): a passive guard holding still with his chest in the crosshair 11 m
   * ahead (a target for the QA click-to-fire) and an alerted guard engaging from ahead-right.
   */
  function spawnQaGuards(): void {
    const fx = -Math.sin(player.yaw);
    const fz = -Math.cos(player.yaw);
    const facePlayer = Math.atan2(-fx, -fz);
    const dummy = new Vector3(player.pos.x + fx * 11, player.pos.y, player.pos.z + fz * 11);
    spawnEnemy('guard', dummy, {
      passive: true,
      yaw: facePlayer,
      patrolLine: [dummy.clone()],
      hold: { aim: 1, crouch: 0 }
    });
    // Tip the view down onto his chest (the rifle stance keeps the head about 1.55 m high).
    player.pitch = -Math.atan2(PLAYER_BODY.eye - 1.3, 11);
    const active = new Vector3(
      player.pos.x + fx * 19 - fz * 1.5,
      player.pos.y,
      player.pos.z + fz * 19 + fx * 1.5
    );
    spawnEnemy('guard', active, {
      state: 'alert',
      yaw: facePlayer,
      target: player.pos
    });
  }

  /** Switches a relay prop's visual state ('live' / 'cutting' / 'cut'). */
  function setRelayState(objective: LevelObjective | null | undefined, state: string): void {
    try {
      const userData = objective && objective.object && objective.object.userData;
      if (userData && typeof userData.setState == 'function') userData.setState(state);
    } catch (err) {
      console.error('[game] relay setState threw', err);
    }
  }

  function refreshMarkers(): void {
    if (!hud.setMarkers) return;
    const markers: HudMarker[] = run.relays
      .filter((relay) => !relay.cut)
      .map((relay) => ({
        id: relay.id,
        short: relay.short,
        label: relay.o.label || 'Relay ' + relay.short,
        pos: relay.o.pos,
        kind: 'relay'
      }));
    if (run.allCut && level.extraction) {
      markers.push({
        id: 'extract',
        short: 'EX',
        label: 'Boat',
        pos: level.extraction.pos,
        kind: 'extract'
      });
    }
    hud.setMarkers(markers);
  }

  function beginRun({
    skipIntro = false,
    quick = false,
    keepRetries = false,
    mode = null
  }: {
    skipIntro?: boolean;
    quick?: boolean;
    keepRetries?: boolean;
    mode?: string | null;
  } = {}): void {
    run.mode = mode || (keepRetries || quick ? run.mode : menus.settings.mode) || 'mission';
    if (!keepRetries) run.retries = 0;
    menus.show('none');
    menus.locationCard(false);
    safeCall(game.audio, 'setPaused', false);
    resetRun();
    safeCall(game.weapon, 'setVisible', true);
    hadLock = false;
    if (skipIntro) {
      post.fade = 0;
      startPlaying();
      return;
    }
    introLength = quick ? FLOW_TUNING.retryIntroSeconds : FLOW_TUNING.introSeconds;
    locationCardShown = quick;
    introRadioSaid = quick;
    player.enabled = true;
    if (input.setGameplay) input.setGameplay(true);
    hud.show(true);
    hud.setObjective(objectiveText());
    post.fade = 1;
    safeCall(game.audio, 'setIntensity', 0.15);
    setState('intro');
  }

  function startPlaying(): void {
    player.enabled = true;
    hud.show(true);
    if (input.setGameplay) input.setGameplay(true);
    hud.setObjective(objectiveText());
    setState('playing');
    updateLookHint(true);
  }

  function objectiveText(): string {
    if (isHoldout()) {
      return run.waveOn ? t('obj.hold') : run.wave ? t('obj.breath') : t('obj.inbound');
    }
    if (run.allCut) return t('obj.boat');
    const remaining = run.relays.length - run.cut;
    return run.cut === 0
      ? t('obj.cutThree')
      : remaining === 1
        ? t('obj.cutLast')
        : t('obj.cutRemaining', { n: remaining });
  }

  /** Shows how looking works (mouse capture / drag fallback) when it changes. */
  function updateLookHint(force: boolean): void {
    const text = input.describeMode ? input.describeMode() : '';
    menus.setLookMode(text);
    if (!force && text === lastLookText) return;
    lastLookText = text;
    if (input.device === 'pad') {
      hud.message('', 0);
      return;
    }
    if (
      flowApi.state === 'playing' &&
      (input.mode === 'drag' ||
        (input.mode === 'lock' && !input.locked && !game.params.shot && !game.params.autostart))
    ) {
      hud.message(text, input.mode === 'drag' ? 7 : 4);
    } else if (flowApi.state === 'playing' && input.locked) {
      hud.message('', 0);
    }
  }

  if (input.onModeChange) input.onModeChange(() => updateLookHint(false));
  game.events.on('input:lock', (event: InputLockEvent) => {
    if (event.locked) {
      hadLock = true;
      updateLookHint(false);
      return;
    }
    if ((flowApi.state === 'playing' || flowApi.state === 'intro') && hadLock) pause();
    hadLock = false;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && (flowApi.state === 'playing' || flowApi.state === 'intro')) pause();
  });
  // Enter on the title screen deploys.
  addEventListener('keydown', (event) => {
    if (
      flowApi.state !== 'title' ||
      menus.panelOpen ||
      (event.code !== 'Enter' && event.code !== 'NumpadEnter') ||
      (event.target && (event.target as HTMLElement).tagName === 'BUTTON')
    )
      return;
    safeCall(game.audio, 'resume');
    input.requestLock();
    beginRun({});
  });

  function pause(): void {
    if (flowApi.state === 'intro') {
      menus.locationCard(false);
      post.fade = 0;
      setState('playing');
    }
    if (flowApi.state === 'playing') {
      if (input.setGameplay) input.setGameplay(false);
      input.exitLock();
      safeCall(game.audio, 'setPaused', true);
      menus.setLookMode(
        input.mode === 'drag'
          ? input.describeMode!()
          : input.touch
            ? ''
            : t('look.resume')
      );
      hud.show(false);
      menus.show('paused');
      pauseGrace = 0.35;
      setState('paused');
    }
  }

  /** Abandons the paused run and returns to the title screen and its attract camera. */
  function toTitle(): void {
    if (flowApi.state !== 'paused') return;
    safeCall(game.enemies, 'clear');
    safeCall(game.fx, 'clear');
    if (hud.reset) hud.reset();
    if (hud.setPrompt) hud.setPrompt(null);
    hud.show(false);
    menus.locationCard(false);
    player.enabled = false;
    safeCall(game.weapon, 'setVisible', false);
    if (input.setGameplay) input.setGameplay(false);
    input.exitLock();
    safeCall(game.audio, 'setPaused', false);
    safeCall(game.audio, 'setIntensity', 0.15);
    post.saturation = baseSaturation;
    post.flash = 0;
    cine.t = 0;
    setState('title');
    menus.show('title');
  }

  function resume(_fromMenu: boolean): void {
    if (flowApi.state !== 'paused') return;
    menus.show('none');
    safeCall(game.audio, 'setPaused', false);
    hud.show(true);
    if (input.setGameplay) input.setGameplay(true);
    hadLock = false;
    input.requestLock();
    setState('playing');
    setTimeout(() => updateLookHint(true), 700);
  }

  /** Spawn points matching the enemy type (gulls fly, hounds and guards walk), else all of them. */
  function spawnPointsFor(type: string): EnemySpawn[] {
    const kind = type === 'gull' ? 'air' : 'ground';
    const all = (level && level.enemySpawns) || [];
    const matching = all.filter((spawn) => spawn.type === kind);
    return matching.length ? matching : all;
  }

  /** Picks a spawn position: far enough away, preferably out of sight, not reused recently. */
  function pickSpawn(
    type: string,
    {
      minDist = FLOW_TUNING.spawnFar,
      from = player.pos,
      preferHidden = true
    }: { minDist?: number; from?: Vector3; preferHidden?: boolean } = {}
  ): Vector3 {
    const points = spawnPointsFor(type);
    let best: EnemySpawn | null = null;
    let bestScore = -1e9;
    for (const point of points) {
      const dist = Math.hypot(point.pos.x - from.x, point.pos.z - from.z);
      let score = game.rng() * 1.5;
      score +=
        dist >= minDist ? 2 + Math.min(1, (dist - minDist) / 30) * 0.5 : -(minDist - dist) / 4;
      if (preferHidden) {
        tmpA.copy(point.pos);
        tmpA.y += type === 'gull' ? 0 : 1;
        let visible = true;
        try {
          visible = game.physics.lineOfSight(tmpA, player.eye);
        } catch {}
        if (!visible) score += 2.5;
      }
      const lastUsed = run.used.get(point);
      if (lastUsed !== undefined && run.time - lastUsed < 6) score -= 3;
      if (score > bestScore) {
        bestScore = score;
        best = point;
      }
    }
    const pos = new Vector3();
    if (best) {
      run.used.set(best, run.time);
      pos.copy(best.pos);
      const jitterX = (game.rng() - 0.5) * 2.4;
      const jitterZ = (game.rng() - 0.5) * 2.4;
      let canJitter = type === 'gull';
      try {
        if (!canJitter) canJitter = game.physics.nav.isWalkable(pos.x + jitterX, pos.z + jitterZ);
      } catch {
        canJitter = false;
      }
      if (canJitter) {
        pos.x += jitterX;
        pos.z += jitterZ;
      }
    } else {
      const angle = game.rng() * Math.PI * 2;
      pos.set(
        clamp(from.x + Math.cos(angle) * 26, -34, 26),
        0,
        clamp(from.z + Math.sin(angle) * 26, -26, 24)
      );
    }
    if (type === 'gull' && pos.y < 2.5) pos.y = 6 + game.rng() * 3;
    return pos;
  }

  /** Alive enemies of `type`. */
  function aliveOfType(type: string): number {
    const list = (game.enemies && game.enemies.list) || [];
    let count = 0;
    for (const enemy of list) if (enemy.alive && enemy.type === type) count++;
    return count;
  }

  function spawnEnemy(type: string, pos: Vector3, options: EnemySpawnOptions): unknown {
    // Machines are rare: past the cap, the request is filled by a guard on the ground instead.
    const cap = MACHINE_CAP[type];
    if (cap !== undefined && aliveOfType(type) >= cap) {
      type = 'guard';
      pos = pickSpawn('guard');
    }
    let enemy: unknown = null;
    try {
      enemy = game.enemies.spawn(type, pos, options);
    } catch (err) {
      console.error('[game] enemies.spawn threw', err);
    }
    return enemy;
  }

  function spawnPatrols(): void {
    const from = (level.playerStart && level.playerStart.pos) || player.pos;
    for (const type of ['gull', 'hound', 'guard'] as const) {
      for (let i = 0; i < (FLOW_TUNING.patrol[type] || 0); i++) {
        spawnEnemy(
          type,
          pickSpawn(type, {
            minDist: 32,
            from,
            preferHidden: true
          }),
          {
            state: 'patrol'
          }
        );
      }
    }
  }

  /** Mission: queues the wave sent after relay `index` is cut and warns where it comes from. */
  function queueWave(index: number): void {
    const wave = FLOW_TUNING.waves[Math.min(index, FLOW_TUNING.waves.length - 1)];
    const types: string[] = [];
    for (let i = 0; i < wave.gull; i++) types.push('gull');
    for (let i = 0; i < wave.hound; i++)
      types.splice(Math.min(types.length, 1 + i * 2), 0, 'hound');
    for (let i = 0; i < (wave.guard || 0); i++)
      types.splice(Math.min(types.length, 2 + i * 3), 0, 'guard');
    let sumX = 0;
    let sumZ = 0;
    types.forEach((type, i) => {
      const pos = pickSpawn(type);
      sumX += pos.x - player.pos.x;
      sumZ += pos.z - player.pos.z;
      run.queue.push({
        type,
        pos,
        at: run.time + 1.6 + i * FLOW_TUNING.spawnStagger
      });
    });
    run.waveHot = 30;
    const bearing = ((Math.atan2(sumX, -sumZ) * 180) / Math.PI + 360) % 360;
    if (hud.warn) {
      hud.warn(t('warn.contact', { dir: directionName(bearing) }), 3.4);
    }
  }

  /** Spawns at most one due enemy per frame (respecting maxAlive), plus post-cut pursuit. */
  function processQueue(dt: number): void {
    const alive = aliveCount();
    const enemies = game.enemies as typeof game.enemies & { stub?: boolean };
    for (let i = 0; i < run.queue.length; i++) {
      const request = run.queue[i];
      if (run.time < request.at) continue;
      if (alive >= FLOW_TUNING.maxAlive) {
        request.at = run.time + 1;
        continue;
      }
      if (
        !spawnEnemy(request.type, request.pos, {
          state: 'alert',
          target: player.pos
        }) &&
        !enemies.stub &&
        (request.tries = (request.tries || 0) + 1) < 6
      ) {
        request.at = run.time + 1.5;
        continue;
      }
      run.queue.splice(i, 1);
      safeCall(game.enemies, 'alert', player.pos, 60);
      break;
    }
    if (run.allCut) {
      run.pursuitT -= dt;
      if (
        run.pursuitT <= 0 &&
        run.pursuitLeft > 0 &&
        !run.queue.length &&
        alive < FLOW_TUNING.pursuitMinAlive
      ) {
        run.pursuitT = FLOW_TUNING.pursuitEvery;
        run.pursuitLeft--;
        // Pursuers are guards; a machine only if none of its kind is still up.
        const roll = game.rng();
        const type = roll < 0.15 ? 'hound' : roll < 0.3 ? 'gull' : 'guard';
        run.queue.push({
          type,
          pos: pickSpawn(type),
          at: run.time + 0.5
        });
      }
      if (run.pursuitT <= 0) {
        run.pursuitT = 4;
        safeCall(game.enemies, 'alert', player.pos, 90);
      }
    }
  }

  function aliveCount(): number {
    try {
      return game.enemies.aliveCount
        ? game.enemies.aliveCount()
        : game.enemies.list.filter((enemy) => enemy.alive).length;
    } catch {
      return 0;
    }
  }

  function enemyNear(radius: number): boolean {
    const list = (game.enemies && game.enemies.list) || [];
    for (let i = 0; i < list.length; i++) {
      const enemy = list[i];
      if (
        enemy &&
        enemy.alive &&
        enemy.pos &&
        Math.hypot(enemy.pos.x - player.pos.x, enemy.pos.z - player.pos.z) < radius
      )
        return true;
    }
    return false;
  }

  game.events.on('enemy:alert', (event: { enemy?: { type?: string } } | null) => {
    run.alertT = 10;
    if (flowApi.state === 'playing' && !run.contactSaid) {
      run.contactSaid = true;
      if (hud.radio) hud.radio(radioLines().contact, 3.2);
    }
    if (
      flowApi.state === 'playing' &&
      !run.guardsSaid &&
      event &&
      event.enemy &&
      event.enemy.type === 'guard'
    ) {
      run.guardsSaid = true;
      if (hud.radio) hud.radio(radioLines().guards, 3.4);
    }
  });
  game.events.on('player:hit', () => {
    run.alertT = Math.max(run.alertT, 8);
  });
  game.events.on('player:rescued', () => {
    if (flowApi.state === 'playing') hud.message(t('msg.hauled'), 2.5);
  });

  /** The closest uncut relay within reach that the player is facing, if any. */
  function nearestRelay(): RelayState | null {
    let best: RelayState | null = null;
    let bestDist = FLOW_TUNING.interactRange;
    for (const relay of run.relays) {
      if (relay.cut) continue;
      const dx = relay.o.pos.x - player.pos.x;
      const dz = relay.o.pos.z - player.pos.z;
      const dist = Math.hypot(dx, dz);
      if (
        dist > bestDist ||
        Math.abs((relay.o.pos.y || 0) - player.pos.y) > 2.5 ||
        (dist > 0.9 &&
          (dx * player.forward.x + dz * player.forward.z) /
            (dist * Math.max(0.2, Math.hypot(player.forward.x, player.forward.z))) <
            FLOW_TUNING.interactFacing)
      )
        continue;
      best = relay;
      bestDist = dist;
    }
    return best;
  }

  /** Relay cutting (hold interact), the prompt, and the extraction zone. */
  function updateInteract(dt: number): void {
    const target = player.alive ? nearestRelay() : null;
    for (const relay of run.relays) {
      if (relay.cut) continue;
      if (relay === target && input.down('interact')) {
        if (!relay.cutting) {
          relay.cutting = true;
          setRelayState(relay.o, 'cutting');
        }
        relay.t += dt / FLOW_TUNING.cutSeconds;
        game.events.emit('objective:progress', {
          id: relay.id,
          t: Math.min(1, relay.t)
        });
        if (relay.t >= 1) cutRelay(relay);
      } else if (relay.t > 0) {
        relay.t = Math.max(0, relay.t - dt * 1.6);
        if (relay.cutting) {
          relay.cutting = false;
          setRelayState(relay.o, 'live');
          game.events.emit('objective:progress', {
            id: relay.id,
            t: 0
          });
        }
      }
    }
    if (target && !target.cut) {
      if (hud.setPrompt) hud.setPrompt(t('prompt.cutRelay', { id: target.short }), clamp01(target.t));
    } else if (hud.setPrompt) {
      hud.setPrompt(null);
    }
    const extraction = level.extraction;
    if (extraction && extraction.pos) {
      const dist = Math.hypot(extraction.pos.x - player.pos.x, extraction.pos.z - player.pos.z);
      const inside =
        dist < (extraction.radius || 2.5) && Math.abs(extraction.pos.y - player.pos.y) < 3.5;
      if (inside && run.allCut && player.alive && !isHoldout()) {
        reachExtraction();
      } else if (inside && !run.allCut && !isHoldout() && run.extractHint <= 0) {
        run.extractHint = 8;
        hud.message(t('msg.relaysLive'), 3.5);
      }
      run.extractHint = Math.max(0, run.extractHint - dt);
    }
  }

  function cutRelay(relay: RelayState): void {
    relay.cut = true;
    relay.cutting = false;
    relay.t = 1;
    run.cut++;
    setRelayState(relay.o, 'cut');
    const total = run.relays.length;
    game.events.emit('objective:done', {
      id: relay.id,
      index: run.cut,
      total
    });
    if (hud.setRelays) hud.setRelays(run.cut, total);
    if (hud.setPrompt) hud.setPrompt(null);
    player.addShake(0.18);
    queueWave(run.cut - 1);
    if (run.cut >= total) {
      run.allCut = true;
      run.pursuitLeft = FLOW_TUNING.pursuitExtra;
      run.pursuitT = 12;
      game.events.emit('objective:all', {});
      if (hud.radio) hud.radio(radioLines().all, 4.5);
    } else if (hud.radio) {
      hud.radio(radioLines().cut[Math.min(run.cut - 1, 1)], 3.6);
    }
    hud.setObjective(objectiveText());
    refreshMarkers();
  }

  game.events.on('player:dead', () => {
    if (flowApi.state !== 'playing' && flowApi.state !== 'paused') return;
    if (input.setGameplay) input.setGameplay(false);
    input.exitLock();
    if (hud.setPrompt) hud.setPrompt(null);
    hud.show(false);
    if (hud.clearRadio) hud.clearRadio();
    menus.setDead({
      time: run.time,
      relays: run.cut,
      total: run.relays.length,
      holdout: isHoldout() ? holdoutResult() : null
    });
    setState('dead');
  });

  /** Mission complete: rate the run and show the debrief. */
  function reachExtraction(): void {
    player.invulnerable = true;
    player.enabled = false;
    if (input.setGameplay) input.setGameplay(false);
    input.exitLock();
    if (hud.setPrompt) hud.setPrompt(null);
    hud.show(false);
    game.events.emit('extraction:reached', {});
    if (hud.clearRadio) hud.clearRadio();
    if (hud.radio) hud.radio(radioLines().done, 2.2);
    const stats = (game.combat && game.combat.stats) || {
      shots: 0,
      hits: 0,
      kills: 0
    };
    const accuracy = stats.shots > 0 ? clamp(stats.hits / stats.shots, 0, 1) : null;
    // A null accuracy compares like 0.
    const accuracyForRating = accuracy ?? 0;
    const ratingIndex =
      (run.time < 270 ? 2 : run.time < 400 ? 1 : 0) +
      (accuracyForRating >= 0.5 ? 2 : accuracyForRating >= 0.3 ? 1 : 0) +
      (run.retries === 0 ? 1 : 0);
    const rating = t(`rating.${ratingIndex}` as MessageKey);
    menus.setDebrief({
      time: run.time,
      accuracy,
      kills: stats.kills || 0,
      retries: run.retries,
      rating
    });
    setState('complete');
  }

  // Gamepad aim assist: slow the look rate while the crosshair is on a visible enemy.
  let assistTimer = 0;
  let assistTarget: number | undefined;
  function updateAimAssist(dt: number): void {
    if (input.device !== 'pad') {
      input.assist = 1;
      return;
    }
    assistTimer -= dt;
    if (assistTimer <= 0) {
      assistTimer = 0.05;
      let onTarget = false;
      try {
        const hit = game.enemies.raycast(player.eye, game.camera.getWorldDirection(tmpA), 60);
        if (hit) onTarget = !game.physics.raycast(player.eye, tmpA, hit.dist);
      } catch {}
      assistTarget = onTarget ? 0.55 : 1;
    }
    input.assist = damp(input.assist || 1, assistTarget || 1, 14, dt);
  }

  game.events.on('weapon:fire', (event: WeaponFireEvent | null) => {
    if (input.rumble) {
      input.rumble(
        event && event.weapon === 'pistol' ? 0.35 : 0.18,
        event && event.weapon === 'pistol' ? 0.6 : 0.5,
        55
      );
    }
  });
  game.events.on('player:hit', (event: PlayerHitEvent) => {
    if (input.rumble) input.rumble(Math.min(1, 0.45 + (event.amount || 0) / 30), 0.3, 160);
  });
  game.events.on('explosion', (event: ExplosionEvent | null) => {
    if (!event || !event.pos) return;
    const dist = player.pos.distanceTo(event.pos);
    const strength = clamp01(1 - dist / 22) * Math.min(1.2, event.size || 1);
    if (strength > 0.05 && input.rumble) {
      input.rumble(Math.min(1, strength), Math.min(1, strength * 0.8), 240 + 200 * strength);
    }
  });
  game.events.on('input:device', () => {
    updateLookHint(true);
  });

  /** Gamepad menu navigation. */
  function handleMenuInput(): void {
    if (!input.uiPressed || menus.screen === 'none') return;
    if (input.uiPressed('up')) menus.nav(-1);
    else if (input.uiPressed('down')) menus.nav(1);
    if (input.uiPressed('left')) menus.adjust(-1);
    else if (input.uiPressed('right')) menus.adjust(1);
    if (input.uiPressed('accept')) menus.accept();
    else if (input.uiPressed('back')) {
      if (!menus.closePanel() && flowApi.state === 'paused') resume(false);
    } else if (input.uiPressed('start') && flowApi.state !== 'paused') {
      menus.closePanel();
      menus.primary();
    }
  }

  function update(dt: number): boolean {
    stateTime += dt;
    handleMenuInput();
    switch (flowApi.state) {
      case 'title':
        updateTitleCamera(dt);
        return false;
      case 'intro':
        post.fade = 1 - smoothstep(0.05, Math.min(introLength, 1.3), stateTime);
        if (!locationCardShown && stateTime > 0.25) {
          locationCardShown = true;
          menus.locationCard(true);
        }
        if (!introRadioSaid && stateTime > 0.9) {
          introRadioSaid = true;
          if (hud.radio) hud.radio(radioLines().intro, 4.2);
        }
        if (input.pressed('pause')) {
          pause();
          return false;
        }
        if (stateTime >= introLength) {
          menus.locationCard(false);
          post.fade = 0;
          startPlaying();
        }
        return true;
      case 'playing': {
        run.time += dt;
        post.fade = damp(post.fade || 0, 0, 6, dt);
        if (pauseGrace > 0) pauseGrace -= dt;
        if (input.pressed('pause')) {
          pause();
          return false;
        }
        updateInteract(dt);
        if (flowApi.state !== 'playing') return true;
        processQueue(dt);
        if (isHoldout()) updateHoldout(dt);
        run.alertT = Math.max(0, run.alertT - dt);
        run.waveHot = Math.max(0, run.waveHot - dt);
        const alive = aliveCount();
        if (run.waveHot > 0 && alive === 0 && !run.queue.length && run.waveHot < 24) {
          run.waveHot = 0;
        }
        const intensity =
          run.allCut || run.queue.length || (run.waveHot > 0 && alive > 0)
            ? 1
            : run.alertT > 0 || (alive > 0 && enemyNear(26))
              ? 0.6
              : 0.15;
        if (intensity !== run.intensity) {
          run.intensity = intensity;
          safeCall(game.audio, 'setIntensity', intensity);
        }
        // Remind keyboard players to click when the mouse isn't captured.
        if (
          input.mode === 'lock' &&
          !input.locked &&
          !input.touch &&
          input.device !== 'pad' &&
          !game.params.shot &&
          !game.params.autostart
        ) {
          lockHintTimer -= dt;
          if (lockHintTimer <= 0) {
            lockHintTimer = 6;
            hud.message(input.describeMode!(), 2.6);
          }
        } else {
          lockHintTimer = 1.5;
        }
        updateAimAssist(dt);
        if (!run.lowSaid && player.alive && player.health < 30) {
          run.lowSaid = true;
          if (hud.radio) hud.radio(radioLines().low, 3);
        }
        return true;
      }
      case 'paused':
        if (pauseGrace > 0) pauseGrace -= dt;
        else if (input.pressed('pause')) {
          if (!menus.closePanel()) resume(false);
        }
        return false;
      case 'dead':
        post.saturation = damp(post.saturation ?? 1, 0.12, 2.2, dt);
        post.fade = damp(post.fade || 0, 0.55, 1.4, dt);
        if (stateTime > 1.5 && menus.screen !== 'dead') {
          menus.show('dead');
          safeCall(game.audio, 'setIntensity', 0.15);
        }
        return true;
      case 'complete':
        post.fade = damp(post.fade || 0, 0.72, 0.9, dt);
        post.saturation = damp(post.saturation ?? 1, baseSaturation * 0.7, 1, dt);
        if (stateTime > 3.3 && menus.screen !== 'complete') {
          menus.show('complete');
          safeCall(game.audio, 'setIntensity', 0.15);
        }
        return true;
    }
    return false;
  }

  buildCinePath();
  applyDifficulty(menus.settings.difficulty);
  player.enabled = false;
  hud.show(false);
  safeCall(game.weapon, 'setVisible', false);
  if (input.setGameplay) input.setGameplay(false);
  safeCall(game.audio, 'setIntensity', 0.15);
  if (!(game.params.shot || game.params.autostart)) menus.show('title');
  return flowApi;
}
