import type * as THREE from 'three';
import type { AudioSystem } from '../audio/engine';
import type { Backdrop } from '../backdrop/index';
import type { EnemySystem } from '../enemies/index';
import type { FxSystem } from '../fx/index';
import type { Ground } from '../ground/index';
import type { InputState } from '../input/index';
import type { Level } from '../level/index';
import type { MaterialLibrary } from '../materials/index';
import type { Player } from '../player/index';
import type { PropFactory } from '../props/registry';
import type { RenderSystem } from '../render/index';
import type { CombatResolver } from '../session/combat';
import type { GameFlow } from '../session/flow';
import type { Hud } from '../ui/hud';
import type { WeaponSystem } from '../weapon/index';
import type { Explosives } from '../world/explosives';
import type { CollisionWorld } from '../world/physics';
import type { QualityPreset } from './config';
import type { EventBus } from './events';
import type { Rng } from './rng';

/** URL query parameters (`?q=low&seed=7&show=weapon` ...) that tune or debug a run. */
export type GameParams = Record<string, string | undefined>;

/**
 * Debug camera override passed to `window.__setShot`: `cam` is `x,y,z[,lookX,lookY,lookZ]`
 * (an empty `cam` clears it). Showcases wrap `__setShot` and read their own extra keys.
 */
export interface CameraShot {
  cam?: string;
  fov?: string | number;
  exposure?: string | number;
  [param: string]: string | number | undefined;
}

/** Player-selected weather, read every frame by the rain, wetness and audio systems. */
export interface GameWeather {
  /** Target rain amount: 1 = the default storm, 0 = clear and dry. */
  rain: number;
}

export interface GameTime {
  /** Simulation time in seconds (pauses with the game). */
  t: number;
  /** Clamped delta of the current frame, in seconds. */
  dt: number;
  frame: number;
  /** Wall-clock seconds since boot. */
  real: number;
}

/**
 * The shared game context. `main.ts` creates it and fills in each subsystem
 * during boot; every subsystem factory receives it and reads its siblings
 * from it. Subsystems that fail to boot are replaced by stubs from
 * `core/stubs.ts`, which implement the same interface.
 */
export interface Game {
  THREE: typeof THREE;
  params: GameParams;
  events: EventBus;
  rng: Rng;
  time: GameTime;
  quality: QualityPreset;
  weather: GameWeather;
  /** Name of the debug showcase being rendered (`?show=`), or null in normal play. */
  showcase: string | null;
  showcaseInfo?: Record<string, unknown>;

  render: RenderSystem;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  viewCamera: THREE.PerspectiveCamera;

  mats: MaterialLibrary;
  physics: CollisionWorld;
  props: PropFactory;
  input: InputState;
  level: Level;
  backdrop: Backdrop;
  ground: Ground;
  fx: FxSystem;
  audio: AudioSystem;
  player: Player;
  combat: CombatResolver;
  explosives: Explosives;
  weapon: WeaponSystem;
  enemies: EnemySystem;
  hud: Hud;
  game: GameFlow;
}
