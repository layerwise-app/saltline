/**
 * First-person weapon system (`game.weapon`): owns the rifle and pistol
 * viewmodels and the shared arm rig, and runs firing (hitscan, tracers,
 * shells, flash), reloads, holster/draw switching, spread/bloom, the death
 * drop, and the procedural viewmodel motion (ADS, sprint, idle, gait bob,
 * inertia, sway, jump/land, recoil springs). Also hosts the weapon showcase.
 */
import { Color, Euler, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import type * as THREE from 'three';
import { VIEWMODEL_LAYER, WORLD_LAYER } from '../core/config';
import { clamp, clamp01, damp, lerp } from '../core/math';
import type { CameraShot, Game } from '../core/types';
import type { InputState } from '../input/index';
import type { Player } from '../player/index';
import type { ImpactInfo } from '../session/combat';
import type { RaycastHit } from '../world/physics';
import {
  advanceSpring,
  applyWeaponFinish,
  createSpring,
  easeInQuad,
  easeOutBack,
  gradientNoise1D,
  resetSpring,
  smootherstep01,
  softClampTanh,
  weaponRainUniform
} from './meshKit';
import type { KitSpring } from './meshKit';
import { HOLSTER_TIMING } from './animConfig';
import type { ViewmodelMotion } from './animConfig';
import { armWetUniform } from './arms';
import { createArmRig } from './gripSolver';
import type { ArmRig, ArmTargets } from './gripSolver';
import { createRifleViewmodel } from './rifle';
import { createPistolViewmodel } from './pistol';

// ---------------------------------------------------------------------------
// Shared weapon types (consumed by rifle.ts / pistol.ts viewmodels).
// ---------------------------------------------------------------------------

/** Damped spring state used by `createSpring` / `advanceSpring` (x: value, v: velocity, w: omega, z: zeta). */
export type WeaponSpring = KitSpring;

/** A position / Euler-rotation offset pair, both `[x, y, z]`. */
export interface ViewOffset {
  p: number[];
  r: number[];
}

/** One camera framing ("view") of a viewmodel: hip/ADS placement plus additive pose offsets. */
export interface WeaponViewSet {
  name: string;
  HIP: ViewOffset;
  ADS: ViewOffset;
  SPRINT: ViewOffset;
  SPRINT_ARC: ViewOffset;
  RELOAD: ViewOffset;
  RACK: ViewOffset;
}

/** Spread (cone half-angle, radians) tuning for a weapon. */
export interface WeaponSpread {
  hip: number;
  ads: number;
  moveHip: number;
  moveAds: number;
  bloomHip: number;
  bloomAds: number;
  air: number;
  crouch: number;
  shot: number;
  decay: number;
}

/** Static ballistic / handling definition of a weapon. */
export interface WeaponDef {
  magSize: number;
  reserve: number;
  rpm: number;
  damage: number;
  range: number;
  auto: boolean;
  adsTime: number;
  inspect: boolean;
  flashLight: number;
  flashScale: number;
  smoke: boolean;
  spread: WeaponSpread;
}

/** Live ammo counters of a weapon (shown by the HUD). */
export interface AmmoSlot {
  id: string;
  name: string;
  ammo: number;
  magSize: number;
  reserve: number;
}

/** Procedural viewmodel motion tuning (see `VIEWMODEL_MOTION` in animConfig). */
export type { ViewmodelMotion };

/** Muzzle flash mesh; its shader exposes `uSeed`, `uJet`, `uInt` and `uHeat` uniforms. */
export type MuzzleFlashMesh = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;

/** Reload bookkeeping shared between the weapon system and the active viewmodel. */
export interface ReloadState {
  /** Seconds since the reload started. */
  t: number;
  /** Total reload duration. */
  T: number;
  /** Whether the magazine was empty when the reload began. */
  empty: boolean;
  rig: WeaponViewmodel | null;
  /** Whether the new magazine has been seated (ammo transferred). */
  seated: boolean;
  /** True on the first frame (time does not advance yet). */
  fresh: boolean;
  /** One-shot event flags fired so far (`magout`, `magin`, ...). */
  f: Record<string, number> | null;
}

/** A reload that is in progress: `rig` and `f` are always set. */
export interface ActiveReload extends ReloadState {
  rig: WeaponViewmodel;
  f: Record<string, number>;
}

/**
 * Fires reload event `phase` once `reload.t` reaches `at` (emits `weapon:reload`
 * with `extra` merged in). Returns true on the frame it fires.
 */
export type ReloadEventFn = (
  reload: ActiveReload,
  phase: string,
  at: number,
  extra?: Record<string, unknown> | null
) => boolean;

/** Materials shared by both viewmodels. */
export interface WeaponMaterials {
  ano: THREE.MeshStandardMaterial;
  plain: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  poly: THREE.MeshStandardMaterial;
  tan: THREE.MeshStandardMaterial;
  slide: THREE.MeshStandardMaterial;
  dots: THREE.MeshStandardMaterial;
  fab: THREE.Material;
  brass: THREE.Material;
}

/** Creates a viewmodel mesh (no shadow casting, never frustum-culled). */
export type ViewmodelMeshFactory = (
  geometry: THREE.BufferGeometry,
  material: THREE.Material
) => THREE.Mesh;

/** Mutable per-frame animation state of the weapon system (springs, timers, wants). */
export interface WeaponAnimState {
  t: number;
  cooldown: number;
  prevFire: boolean;
  dryDone: boolean;
  fireQ: number;
  autoReload: number;
  reload: ActiveReload | null;
  burst: number;
  lastShot: number;
  bloom: number;
  heat: number;
  smoke: number;
  smokeTick: number;
  adsLin: number;
  adsE: number;
  sprintT: number;
  reloadW: number;
  rackW: number;
  finger: number;
  flashT: number;
  flashDur: number;
  recPhase: number;
  wasGround: boolean;
  lastVy: number;
  spreadS: number;
  idleT: number;
  inspect: number;
  hol: number;
  adsWant: boolean;
  spWant: boolean;
  urgent: boolean;
  antYT: number;
  antRT: number;
  gait: number;
  gOffT: number;
  gOff: WeaponSpring;
  stride: WeaponSpring;
  spd: number;
  stepEv: number;
  jumpEv: number;
  landEv: number;
  landSide: number;
  lpR: number;
  lpF: number;
  breath: number;
  exert: number;
  wallT: number;
  wallK: number;
  adsV: WeaponSpring;
  adsS: WeaponSpring;
  spV: WeaponSpring;
  rwS: WeaponSpring;
  rkS: WeaponSpring;
  wall: WeaponSpring;
  amt: WeaponSpring;
  kZ: WeaponSpring;
  kP: WeaponSpring;
  kY: WeaponSpring;
  kR: WeaponSpring;
  kX: WeaponSpring;
  kU: WeaponSpring;
  swY: WeaponSpring;
  swP: WeaponSpring;
  jY: WeaponSpring;
  jP: WeaponSpring;
  jR: WeaponSpring;
  inZ: WeaponSpring;
  inX: WeaponSpring;
  inP: WeaponSpring;
  inR: WeaponSpring;
  stance: WeaponSpring;
  stance2: WeaponSpring;
  bump: WeaponSpring;
  antY: WeaponSpring;
  antR: WeaponSpring;
}

/** Context handed to `createRifleViewmodel` / `createPistolViewmodel`. */
export interface ViewmodelContext {
  G: Game;
  S: WeaponAnimState;
  mats: WeaponMaterials;
  mk: ViewmodelMeshFactory;
  rng: () => number;
  ev: ReloadEventFn;
  arms: ArmRig | null;
}

/** Whatever receives a shot's recoil (the player). */
export interface RecoilReceiver {
  crouching?: boolean;
  addRecoil?(pitch?: number, yaw?: number): void;
  addShake?(amount?: number): void;
}

/** A first-person weapon viewmodel (rifle or pistol) driven by the weapon system. */
export interface WeaponViewmodel {
  id: 'rifle' | 'pistol';
  name: string;
  root: THREE.Group;
  flash: MuzzleFlashMesh;
  /** Muzzle / ejection port / sight positions in viewmodel space. */
  muzzle: number[];
  eject: number[];
  sight: number[];
  info: { tris: number; meshes: number };
  slot: AmmoSlot;
  def: WeaponDef;
  views: WeaponViewSet[];
  view: number;
  /** The current view (`views[view]`). */
  readonly pose: WeaponViewSet;
  setView(index: number): void;
  motion: ViewmodelMotion;
  reloadTime(empty: boolean): number;
  reset(): void;
  cancelReload(seated: boolean): void;
  shot(emptied: boolean): void;
  recoil(burst: number, scale: number, player: RecoilReceiver): void;
  reload(reload: ActiveReload, t: number): void;
  endReload(): void;
  parts(dt: number, finger: number, reloading: boolean): void;
  /** Writes this frame's hand targets for the arm rig. */
  armTargets(targets: ArmTargets, dt: number): void;
  snapArms(): void;
  setLocked(locked: boolean): void;
  readonly locked: boolean;
  /** Fitted hand grips (`grip`, `trigger`, `fore`, ...) plus the measured colliders; debug only. */
  holds: object;
}

/** Debug overrides (`?show=weapon`, `__setShot`) that freeze or force weapon states. */
export interface WeaponDebug {
  /** Skip the procedural pose (viewmodel placed by the showcase). */
  freeze: boolean;
  /** Skip the whole update. */
  pause: boolean;
  /** Forced reload time, or null for a normal reload. */
  reloadT: number | null;
  empty: boolean;
  flash: boolean;
  noFire: boolean;
  ads: boolean;
  sprint: boolean;
  noIdle: boolean;
  S: WeaponAnimState;
}

/** What the weapon system is doing (shown by the HUD). */
export type WeaponStateName =
  'idle' | 'dropped' | 'switching' | 'reloading' | 'inspect' | 'sprinting' | 'firing';

/** The two viewmodels by id (a type alias, so it is indexable by string). */
export type WeaponRigs = {
  rifle: WeaponViewmodel;
  pistol: WeaponViewmodel;
};

/** The first-person weapon system stored on `game.weapon`. */
export interface WeaponSystem {
  state: WeaponStateName;
  /** Eased aim-down-sights blend, 0..1. */
  ads: number;
  /** Current spread cone half-angle (radians). */
  spread: number;
  debug: WeaponDebug;
  slots: AmmoSlot[];
  rigs: WeaponRigs;
  /** Id of the weapon being switched to, or null. */
  pending: string | null;
  arms: ArmRig;
  info: { tris: number; meshes: number; pistol: { tris: number; meshes: number } };
  update(dt: number): void;
  reset(): void;
  /** Starts switching to `name` (`rifle` / `pistol`); false if nothing changes. */
  switchTo(name: string): boolean;
  swap(): boolean;
  /** Instantly equips `name` (no holster animation). */
  equip(name: string): void;
  setVisible(visible: boolean): void;
  /** World position of the current muzzle (written into `target`). */
  muzzleWorld(target?: THREE.Vector3): THREE.Vector3;
  /** Starts a reload if possible; returns whether it started. */
  reloadNow(): boolean;
  addAmmo(amount: number): void;
  /** Rain wetness 0..1 of the weapon finish and gloves. */
  setWetness(wetness: number | string): void;
  /** Snaps every spring / blend to its current target (no easing on the next frame). */
  snap(): void;
  /** Camera framing 1..3. */
  view: number;
  setView(view: number | string): number;
  readonly name: string;
  ammo: number;
  readonly magSize: number;
  reserve: number;
  readonly damage: number;
  readonly rpm: number;
  readonly current: WeaponViewmodel['id'];
  readonly root: THREE.Group;
}

/** The weapon showcase (`?show=weapon`): a posed viewmodel with a fixed camera. */
export interface WeaponShowcase {
  cam: number[];
  target: number[];
  update(dt: number): void;
}

/** Spring keys of the recoil kick (their tuning comes from `motion.recoil.spr`). */
const RECOIL_SPRING_KEYS = ['kZ', 'kP', 'kY', 'kR', 'kX', 'kU'] as const;
/** Springs reset by `snap()` / `reset()`. */
const SPRING_STATE_KEYS = [
  'kZ',
  'kP',
  'kY',
  'kR',
  'kX',
  'kU',
  'swY',
  'swP',
  'jY',
  'jP',
  'jR',
  'inZ',
  'inX',
  'inP',
  'inR',
  'bump',
  'antY',
  'antR',
  'amt',
  'wall'
] as const;
/** Additive viewmodel offset when fully holstered. */
const HOLSTER_OFFSET: ViewOffset = {
  p: [0.085, -0.34, 0.07],
  r: [-0.5, 0.22, -0.42]
};
const DRAW_EASE_POWER = 1.25;
const TWO_PI = Math.PI * 2;
const GAIT_PHASE_OFFSET = 0.965;
/** Vertical walk bob waveform over one gait cycle. */
const gaitBobWave = (phase: number): number =>
  -(0.9 * Math.sin(phase) + 0.318 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase)) * 0.9416;
/** Stride lengths (m) used when the player has no tuning. */
const DEFAULT_STRIDE = {
  walk: 1.55,
  sprint: 2.1,
  crouch: 1.05
};

/** Holster / draw progress. */
interface SwitchState {
  active: boolean;
  phase: '' | 'holster' | 'draw';
  t: number;
  fresh: boolean;
  from: WeaponViewmodel | null;
  to: WeaponViewmodel | null;
}

/** The weapon thrown into the world when the player dies. */
interface DropState {
  active: boolean;
  rig: WeaponViewmodel | null;
  t: number;
  vel: Vector3;
  /** Angular velocity (Euler rates). */
  w: Vector3;
  rest: boolean;
  sunk: boolean;
  bounces: number;
  qRest: Quaternion;
  /** Bounce sounds played so far. */
  heard: number;
  restT: number;
}

/** Payload of the `player:land` event. */
interface LandEvent {
  speed?: number;
}

/** Creates the weapon system: both viewmodels, the shared arm rig, firing, reloads and viewmodel motion. */
export async function createWeapon(game: Game): Promise<WeaponSystem> {
  const MATERIAL_SCALE: Record<string, number> = {
    brass: 4,
    glove_fabric: 3
  };
  const libraryMaterial = (name: string) =>
    game.mats.get(name, {
      triplanar: true,
      vertexColors: true,
      scale: MATERIAL_SCALE[name] || 1
    });
  const makeMesh: ViewmodelMeshFactory = (geometry, material) => {
    const mesh = new Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  };
  const finishMaterial = (
    name: string,
    rgb: number[],
    roughness: number,
    metalness: number,
    finish: number
  ) => {
    const material = new MeshStandardMaterial({
      color: new Color(rgb[0], rgb[1], rgb[2]),
      roughness,
      metalness,
      vertexColors: true
    });
    material.name = name;
    if (finish >= 0) applyWeaponFinish(material, finish);
    return material;
  };
  const materials: WeaponMaterials = {
    ano: finishMaterial('pac9_anodised', [0.0085, 0.009, 0.0105], 0.4, 0.45, 0),
    plain: finishMaterial('pac9_matte', [1, 1, 1], 0.92, 0, 4),
    steel: finishMaterial('pac9_phosphate', [0.016, 0.016, 0.0165], 0.5, 0.7, 1),
    poly: finishMaterial('pac9_polymer', [0.0125, 0.0128, 0.0135], 0.62, 0, 2),
    tan: finishMaterial('pac9_polymer_tan', [0.105, 0.08, 0.05], 0.62, 0, 2),
    slide: finishMaterial('pac4_nitride', [0.008, 0.0083, 0.0092], 0.36, 0.55, 0),
    dots: new MeshStandardMaterial({
      color: new Color(0.3, 0.42, 0.3),
      emissive: new Color(0.16, 0.5, 0.2),
      emissiveIntensity: 0.55,
      roughness: 0.35,
      metalness: 0
    }),
    fab: libraryMaterial('glove_fabric'),
    brass: libraryMaterial('brass')
  };
  materials.dots.name = 'pac4_tritium';
  const rng: () => number = game.rng && game.rng.fork ? game.rng.fork() : Math.random;
  const anim: WeaponAnimState = {
    t: 0,
    cooldown: 0,
    prevFire: false,
    dryDone: false,
    fireQ: 0,
    autoReload: -1,
    reload: null,
    burst: 0,
    lastShot: -9,
    bloom: 0,
    heat: 0,
    smoke: 0,
    smokeTick: 0,
    adsLin: 0,
    adsE: 0,
    sprintT: 0,
    reloadW: 0,
    rackW: 0,
    finger: 0,
    flashT: 0,
    flashDur: 0.05,
    recPhase: 0,
    wasGround: true,
    lastVy: 0,
    spreadS: 0.0125,
    idleT: 0,
    inspect: -1,
    hol: 0,
    adsWant: false,
    spWant: false,
    urgent: false,
    antYT: 0,
    antRT: 0,
    gait: 0,
    gOffT: 0,
    gOff: createSpring(9, 1),
    stride: {
      x: 1.55,
      v: 0,
      w: 14,
      z: 1
    },
    spd: 0,
    stepEv: 0,
    jumpEv: 0,
    landEv: -1,
    landSide: 1,
    lpR: 0,
    lpF: 0,
    breath: 0,
    exert: 0,
    wallT: 0,
    wallK: 0,
    adsV: createSpring(23, 0.75),
    adsS: createSpring(9, 1),
    spV: createSpring(17, 1),
    rwS: createSpring(45, 1),
    rkS: createSpring(45, 1),
    wall: createSpring(10, 1),
    amt: createSpring(13, 1),
    kZ: createSpring(44, 0.55),
    kP: createSpring(36, 0.5),
    kY: createSpring(30, 0.45),
    kR: createSpring(31, 0.42),
    kX: createSpring(40, 0.5),
    kU: createSpring(40, 0.5),
    swY: createSpring(13.5, 0.64),
    swP: createSpring(13.5, 0.64),
    jY: createSpring(20.5, 0.56),
    jP: createSpring(20.5, 0.56),
    jR: createSpring(20.5, 0.56),
    inZ: createSpring(15, 0.48),
    inX: createSpring(15, 0.48),
    inP: createSpring(15, 0.48),
    inR: createSpring(15, 0.48),
    stance: createSpring(13, 1),
    stance2: createSpring(5.5, 1),
    bump: createSpring(24.5, 0.61),
    antY: createSpring(50, 0.8),
    antR: createSpring(50, 0.8)
  };
  if (game.events && game.events.on) {
    game.events.on('player:step', () => {
      anim.stepEv = 1;
    });
    game.events.on('player:jump', () => {
      anim.jumpEv = 1;
    });
    game.events.on<LandEvent | undefined>('player:land', (event) => {
      anim.landEv = event && event.speed !== undefined && event.speed > 0 ? event.speed : 0;
    });
  }
  const debug: WeaponDebug = {
    freeze: false,
    pause: false,
    reloadT: null,
    empty: false,
    flash: false,
    noFire: false,
    ads: false,
    sprint: false,
    noIdle: false,
    S: anim
  };
  const reloadState: ReloadState = {
    t: 0,
    T: 0,
    empty: false,
    rig: null,
    seated: false,
    fresh: false,
    f: null
  };
  const switchState: SwitchState = {
    active: false,
    phase: '',
    t: 0,
    fresh: false,
    from: null,
    to: null
  };

  /** Fires reload event `phase` once (when the reload time reaches `at`). */
  const fireReloadEvent: ReloadEventFn = (reload, phase, at, extra) => {
    if (reload.t < at || reload.f[phase]) return false;
    reload.f[phase] = 1;
    if (phase === 'magin') seatMagazine(reload);
    const payload: Record<string, unknown> = {
      phase,
      empty: reload.empty,
      weapon: reload.rig.id
    };
    if (extra) Object.assign(payload, extra);
    game.events.emit('weapon:reload', payload);
    return true;
  };

  /** Moves rounds from the reserve into the magazine. */
  function seatMagazine(reload: ActiveReload): void {
    const slot = reload.rig.slot;
    const rounds = Math.min(slot.magSize - slot.ammo, slot.reserve);
    slot.ammo += rounds;
    slot.reserve -= rounds;
    reload.seated = true;
  }

  const arms = createArmRig(game, VIEWMODEL_LAYER);
  const viewmodelContext: ViewmodelContext = {
    G: game,
    S: anim,
    mats: materials,
    mk: makeMesh,
    rng,
    ev: fireReloadEvent,
    arms
  };
  const rifle = createRifleViewmodel(viewmodelContext);
  const pistol = createPistolViewmodel(viewmodelContext);
  const rigs: WeaponRigs = {
    rifle,
    pistol
  };
  /** `rigs` looked up by an arbitrary (possibly unknown) name. */
  const rigsByName: Record<string, WeaponViewmodel | undefined> = rigs;
  const rigList = [rifle, pistol];
  for (const rig of rigList) {
    rig.root.traverse((child) => {
      child.layers.set(VIEWMODEL_LAYER);
    });
    rig.root.visible = false;
    game.camera.add(rig.root);
    console.log(
      `[weapon] ${rig.name}: ${rig.info.tris} tris, ${rig.info.meshes} meshes (flash only while firing, hidden while holstered)`
    );
  }
  console.log(
    `[weapon] arms: 2 x ${arms.right.triCount} tris, 2 draw calls, shared by both weapons`
  );
  let current = rifle;
  let visible = true;
  // `name`, `ammo`, ... are added as accessors by `Object.defineProperties` below.
  const system = {
    state: 'idle',
    ads: 0,
    spread: 0.0125,
    debug,
    slots: [rifle.slot, pistol.slot],
    rigs,
    pending: null,
    arms,
    info: {
      tris: rifle.info.tris,
      meshes: rifle.info.meshes,
      pistol: pistol.info
    },
    update,
    reset,
    switchTo,
    swap() {
      return switchTo(
        (switchState.active ? switchState.to : current) === rifle ? 'pistol' : 'rifle'
      );
    },
    equip(name: string) {
      const rig = rigsByName[name];
      if (rig) {
        cancelReload();
        switchState.active = false;
        system.pending = null;
        anim.hol = 0;
        equipRig(rig);
        arms.snap();
      }
    },
    setVisible(show: boolean) {
      visible = !!show;
      current.root.visible = visible;
      arms.setVisible(visible);
    },
    muzzleWorld,
    reloadNow,
    addAmmo(amount: number) {
      current.slot.reserve += amount;
    },
    setWetness(wetness: number | string) {
      weaponRainUniform.value = armWetUniform.value = Math.max(0, Math.min(1, +wetness || 0));
    },
    snap() {
      const player = game.player;
      const sprinting =
        (!!player.sprinting || debug.sprint) && !game.input.fire && !game.input.ads && !anim.reload;
      anim.adsLin = (game.input.ads || debug.ads) && !switchState.active ? 1 : 0;
      anim.adsE = smootherstep01(anim.adsLin);
      system.ads = anim.adsE;
      anim.adsWant = anim.adsLin > 0;
      anim.sprintT = sprinting ? 1 : 0;
      anim.spWant = sprinting;
      for (const key of SPRING_STATE_KEYS) resetSpring(anim[key]);
      resetSpring(anim.adsV, anim.adsLin);
      resetSpring(anim.adsS, anim.adsLin);
      resetSpring(anim.spV, anim.sprintT);
      resetSpring(anim.rwS, anim.reloadW);
      resetSpring(anim.rkS, anim.rackW);
      anim.lpR = 0;
      anim.lpF = 0;
      anim.gait += anim.gOff.x;
      resetSpring(anim.gOff);
      anim.gOffT = 0;
      anim.stepEv = 0;
      anim.jumpEv = 0;
      anim.landEv = -1;
      anim.wasGround = player.onGround !== false;
      resetSpring(anim.stance, player.crouching ? 1 : 0);
      resetSpring(anim.stance2, player.crouching ? 1 : 0);
      anim.wallK = 0;
      anim.antYT = 0;
      anim.antRT = 0;
      for (const rig of rigList) if (rig.snapArms) rig.snapArms();
      arms.snap();
    },
    view: 1,
    setView
  } as WeaponSystem;

  /** Sets the camera framing (1..3) of both viewmodels; returns the clamped value. */
  function setView(view: number | string): number {
    const clamped = Math.max(1, Math.min(3, Math.round(+view) || 1));
    system.view = clamped;
    for (const rig of rigList) if (rig.setView) rig.setView(clamped - 1);
    return clamped;
  }
  Object.defineProperties(system, {
    name: {
      enumerable: true,
      get: () => current.slot.name
    },
    ammo: {
      enumerable: true,
      get: () => current.slot.ammo,
      set: (value: number) => {
        current.slot.ammo = value;
      }
    },
    magSize: {
      enumerable: true,
      get: () => current.slot.magSize
    },
    reserve: {
      enumerable: true,
      get: () => current.slot.reserve,
      set: (value: number) => {
        current.slot.reserve = value;
      }
    },
    damage: {
      enumerable: true,
      get: () => current.def.damage
    },
    rpm: {
      enumerable: true,
      get: () => current.def.rpm
    },
    current: {
      enumerable: true,
      get: () => current.id
    },
    root: {
      enumerable: true,
      get: () => current.root
    }
  });

  /** Makes `rig` the current weapon and loads its spring tuning. */
  function equipRig(rig: WeaponViewmodel): void {
    if (current.flash) current.flash.visible = false;
    current.root.visible = false;
    current = rig;
    current.root.visible = visible;
    const motion = rig.motion;
    for (const key of RECOIL_SPRING_KEYS) {
      anim[key].w = motion.recoil.spr[key][0];
      anim[key].z = motion.recoil.spr[key][1];
      resetSpring(anim[key]);
    }
    for (const key of ['swY', 'swP'] as const) {
      anim[key].w = motion.sway.spr[0];
      anim[key].z = motion.sway.spr[1];
    }
    for (const key of ['jY', 'jP', 'jR'] as const) {
      anim[key].w = motion.air.spr[0];
      anim[key].z = motion.air.spr[1];
    }
    for (const key of ['inZ', 'inX', 'inP', 'inR'] as const) {
      anim[key].w = motion.inertia.spr[0];
      anim[key].z = motion.inertia.spr[1];
    }
    resetSpring(anim.adsV);
    resetSpring(anim.adsS);
    resetSpring(anim.rwS);
    resetSpring(anim.rkS);
    resetSpring(anim.antY);
    resetSpring(anim.antR);
    anim.antYT = 0;
    anim.antRT = 0;
    anim.adsWant = false;
    anim.reloadW = 0;
    anim.rackW = 0;
    anim.cooldown = 0;
    anim.fireQ = 0;
    anim.dryDone = false;
    anim.burst = 0;
    anim.bloom = 0;
    anim.heat = 0;
    anim.smoke = 0;
    anim.flashT = 0;
    anim.finger = 0;
    anim.adsLin = 0;
    anim.adsE = 0;
    anim.inspect = -1;
    anim.idleT = 0;
    anim.autoReload = -1;
  }

  /** Full reset: refills both weapons, recovers a dropped weapon and equips the rifle. */
  function reset(): void {
    recoverDrop();
    arms.snap();
    for (const rig of rigList) {
      rig.slot.ammo = rig.def.magSize;
      rig.slot.reserve = rig.def.reserve;
      rig.reset();
      if (rig.flash) rig.flash.visible = false;
    }
    anim.reload = null;
    switchState.active = false;
    system.pending = null;
    system.state = 'idle';
    system.ads = 0;
    Object.assign(anim, {
      prevFire: false,
      lastShot: -9,
      sprintT: 0,
      reloadW: 0,
      rackW: 0,
      hol: 0,
      gait: 0,
      gOffT: 0,
      spd: 0,
      stepEv: 0,
      jumpEv: 0,
      landEv: -1,
      lpR: 0,
      lpF: 0,
      exert: 0,
      wallK: 0,
      wasGround: true
    });
    for (const key of SPRING_STATE_KEYS) resetSpring(anim[key]);
    resetSpring(anim.spV);
    resetSpring(anim.stance);
    resetSpring(anim.stance2);
    resetSpring(anim.gOff);
    resetSpring(anim.stride, DEFAULT_STRIDE.walk);
    equipRig(rifle);
  }

  /**
   * Converts a viewmodel-space point to world space, compensating for the
   * viewmodel being rendered with a different FOV than the world camera.
   */
  function viewmodelToWorld(local: number[], target: Vector3): Vector3 {
    const root = current.root;
    root.updateMatrix();
    target.fromArray(local).applyMatrix4(root.matrix);
    const camera = game.camera;
    const fovScale =
      Math.tan((camera.fov * Math.PI) / 360) / Math.tan((game.viewCamera.fov * Math.PI) / 360);
    target.x *= fovScale;
    target.y *= fovScale;
    return target.applyQuaternion(camera.quaternion).add(camera.position);
  }

  function muzzleWorld(target = new Vector3()): Vector3 {
    return viewmodelToWorld(current.muzzle, target);
  }

  function beginReload(empty: boolean): void {
    reloadState.t = 0;
    reloadState.fresh = true;
    reloadState.T = current.reloadTime(empty);
    reloadState.empty = empty;
    reloadState.rig = current;
    reloadState.seated = false;
    reloadState.f = {};
    // `rig` and `f` were just set, so the state is now an active reload.
    anim.reload = reloadState as ActiveReload;
    anim.autoReload = -1;
  }

  function reloadNow(): boolean {
    const slot = current.slot;
    if (anim.reload || switchState.active || slot.ammo >= slot.magSize || slot.reserve <= 0)
      return false;
    beginReload(slot.ammo <= 0);
    game.events.emit('weapon:reload', {
      phase: 'start',
      empty: reloadState.empty,
      weapon: current.id
    });
    return true;
  }

  function cancelReload(): void {
    if (!anim.reload) return;
    const reload = anim.reload;
    anim.reload = null;
    arms.blend(0.22);
    reload.rig.cancelReload(reload.seated);
  }

  /** Begins holstering `from` to draw `to`, `startT` seconds into the holster. */
  function startSwitch(from: WeaponViewmodel, to: WeaponViewmodel, startT: number): void {
    cancelReload();
    anim.autoReload = -1;
    anim.inspect = -1;
    anim.fireQ = 0;
    switchState.active = true;
    switchState.phase = 'holster';
    switchState.t = startT;
    switchState.fresh = true;
    switchState.from = from;
    switchState.to = to;
    system.pending = to.id;
    game.events.emit('weapon:switch', {
      from: from.id,
      to: to.id,
      phase: 'holster'
    });
  }

  function switchTo(name: string): boolean {
    const target = rigsByName[name];
    if (!target) return false;
    if (switchState.active) {
      if (switchState.phase === 'holster') {
        if (switchState.to === target) return false;
        switchState.to = target;
        system.pending = target.id;
        return true;
      }
      if (target === current) return false;
      startSwitch(
        current,
        target,
        HOLSTER_TIMING.holster * (1 - clamp01(switchState.t / HOLSTER_TIMING.draw))
      );
      return true;
    }
    if (target === current) return false;
    startSwitch(current, target, 0);
    return true;
  }

  function updateSwitch(dt: number): void {
    if (switchState.fresh) switchState.fresh = false;
    else switchState.t += dt;
    if (switchState.phase === 'holster') {
      if (switchState.t >= HOLSTER_TIMING.holster) {
        // `from` / `to` are always set while a switch is active.
        const from = switchState.from!;
        arms.blend(0.13);
        equipRig(switchState.to!);
        switchState.phase = 'draw';
        switchState.t = Math.min(switchState.t - HOLSTER_TIMING.holster, HOLSTER_TIMING.draw * 0.5);
        game.events.emit('weapon:switch', {
          from: from.id,
          to: current.id,
          phase: 'draw'
        });
        anim.hol = 1 - easeOutBack(switchState.t / HOLSTER_TIMING.draw, DRAW_EASE_POWER);
      } else anim.hol = easeInQuad(switchState.t / HOLSTER_TIMING.holster);
    } else if (switchState.t >= HOLSTER_TIMING.draw) {
      switchState.active = false;
      system.pending = null;
      anim.hol = 0;
    } else anim.hol = 1 - easeOutBack(switchState.t / HOLSTER_TIMING.draw, DRAW_EASE_POWER);
  }

  const shotDir = new Vector3();
  const muzzlePos = new Vector3();
  const hitPoint = new Vector3();
  const ejectPos = new Vector3();
  const shellVel = new Vector3();
  const shotOrigin = new Vector3();

  /** Fires one round: hitscan, tracer, shell, flash light, recoil and flash randomisation. */
  function fireShot(): void {
    const player = game.player;
    const camera = game.camera;
    const rig = current;
    const def = rig.def;
    rig.slot.ammo--;
    anim.burst++;
    anim.lastShot = anim.t;
    anim.heat = Math.min(1.3, anim.heat + 0.05);
    const spread = system.spread;
    const angle = rng() * Math.PI * 2;
    const radius = Math.tan(spread) * Math.sqrt(rng());
    shotDir
      .set(Math.cos(angle) * radius, Math.sin(angle) * radius, -1)
      .normalize()
      .applyQuaternion(camera.quaternion);
    shotOrigin.copy(player.eye || camera.position);
    let hit: ImpactInfo | null = null;
    try {
      hit = game.combat.playerShot(shotOrigin, shotDir, {
        damage: def.damage,
        range: def.range
      });
    } catch {}
    if (hit && hit.point) hitPoint.copy(hit.point);
    else hitPoint.copy(shotOrigin).addScaledVector(shotDir, def.range);
    muzzleWorld(muzzlePos);
    const fx = game.fx;
    if (fx) {
      if (fx.tracer) fx.tracer(muzzlePos, hitPoint);
      if (fx.shell) {
        viewmodelToWorld(rig.eject, ejectPos);
        shellVel
          .set(2 + rng() * 1.2, 1.2 + rng() * 0.8, 0.5 - rng() * 0.6)
          .applyQuaternion(camera.quaternion);
        if (player.vel) shellVel.add(player.vel);
        fx.shell(ejectPos, shellVel);
      }
    }
    if (game.render && game.render.lightPool)
      game.render.lightPool.flash(muzzlePos, 0xffb060, def.flashLight, 9, 0.05);
    game.events.emit('weapon:fire', {
      origin: shotOrigin,
      dir: shotDir,
      muzzle: muzzlePos,
      ads: anim.adsE,
      weapon: rig.id
    });
    rig.recoil(anim.burst, lerp(1, 0.55, anim.adsE) * (player.crouching ? 0.85 : 1), player);
    anim.bloom = Math.min(1, anim.bloom + def.spread.shot);
    anim.flashT = anim.flashDur = 0.036 + rng() * 0.02;
    const flash = rig.flash;
    const uniforms = flash.material.uniforms;
    uniforms.uSeed.value = rng() * 100;
    uniforms.uJet.value = (0.6 + rng() * 0.6) * (def.auto ? 1 : 0.25);
    flash.rotation.z = (rng() - 0.5) * 0.4;
    const flashScale = (0.8 + rng() * 0.5) * lerp(1, 0.62, anim.adsE) * def.flashScale;
    flash.scale.set(flashScale, flashScale, flashScale * (0.8 + rng() * 0.5));
    rig.shot(rig.slot.ammo <= 0);
  }

  const drop: DropState = {
    active: false,
    rig: null,
    t: 0,
    vel: new Vector3(),
    w: new Vector3(),
    rest: false,
    sunk: false,
    bounces: 0,
    qRest: new Quaternion(),
    heard: 0,
    restT: 0
  };
  const tmpQuat = new Quaternion();
  const tmpVec = new Vector3();
  const tmpEuler = new Euler();

  /** On death: moves the current viewmodel into the world and throws it. */
  function dropWeapon(): void {
    if (drop.active || !visible || !current.root.visible) return;
    const rig = current;
    const root = rig.root;
    const camera = game.camera;
    const player = game.player;
    cancelReload();
    switchState.active = false;
    system.pending = null;
    if (rig.flash) rig.flash.visible = false;
    camera.updateMatrixWorld(true);
    root.updateMatrixWorld(true);
    arms.startDrop(rng);
    const fovScale =
      Math.tan((camera.fov * Math.PI) / 360) / Math.tan((game.viewCamera.fov * Math.PI) / 360);
    tmpVec.copy(root.position);
    tmpVec.z /= fovScale;
    tmpVec.applyQuaternion(camera.quaternion).add(camera.position);
    tmpQuat.copy(camera.quaternion).multiply(root.quaternion);
    game.scene.add(root);
    root.position.copy(tmpVec);
    root.quaternion.copy(tmpQuat);
    root.traverse((child) => {
      child.layers.set(WORLD_LAYER);
      if ((child as Partial<Mesh>).isMesh) child.castShadow = child !== rig.flash;
    });
    drop.vel.set(0.35 + rng() * 0.3, 0.5, -0.5 - rng() * 0.4).applyQuaternion(camera.quaternion);
    if (player && player.vel) drop.vel.addScaledVector(player.vel, 0.6);
    drop.w.set(2.2 + rng() * 1.5, (rng() - 0.5) * 3, -(3 + rng() * 2));
    Object.assign(drop, {
      active: true,
      rig,
      t: 0,
      rest: false,
      sunk: false,
      bounces: 0,
      heard: 0
    });
    system.state = 'dropped';
    game.events.emit('weapon:dropped', {
      weapon: rig.id,
      pos: root.position
    });
  }

  /** Clatter sounds for a ground impact of the dropped weapon (max 4). */
  function playDropSound(root: THREE.Object3D, impactSpeed: number): void {
    if (!game.audio || !game.audio.play || drop.heard > 3) return;
    drop.heard++;
    const gain = Math.min(1.4, 0.35 + impactSpeed * 0.28);
    try {
      game.audio.play('shell_bounce_metal', {
        pos: root.position,
        gain: gain * 1.3,
        pitch: 0.42 + rng() * 0.08
      });
      game.audio.play('reload_magout', {
        pos: root.position,
        gain,
        pitch: 0.7 + rng() * 0.1
      });
    } catch {}
  }

  /** Sub-stepped ballistic flight / bouncing of the dropped weapon. */
  function updateDropPhysics(dt: number): void {
    if (!drop.active) return;
    drop.t += dt;
    arms.dropUpdate(dt);
    // `rig` is always set while the drop is active.
    const root = drop.rig!.root;
    if (drop.rest || drop.sunk) return;
    const steps = Math.max(1, Math.ceil(dt / 0.012));
    const step = dt / steps;
    for (let i = 0; i < steps; i++) {
      drop.vel.y -= 13.5 * step;
      const horizontalSpeed = Math.hypot(drop.vel.x, drop.vel.z);
      if (horizontalSpeed > 0.05) {
        tmpVec.set(drop.vel.x / horizontalSpeed, 0, drop.vel.z / horizontalSpeed);
        let wallHit: RaycastHit | null = null;
        try {
          wallHit = game.physics.raycast(root.position, tmpVec, horizontalSpeed * step + 0.12);
        } catch {
          wallHit = null;
        }
        if (wallHit) {
          drop.vel.x *= -0.2;
          drop.vel.z *= -0.2;
        }
      }
      root.position.addScaledVector(drop.vel, step);
      tmpEuler.set(drop.w.x * step, drop.w.y * step, drop.w.z * step);
      tmpQuat.setFromEuler(tmpEuler);
      root.quaternion.multiply(tmpQuat);
      let ground = 0;
      try {
        ground = game.physics.groundHeight(root.position.x, root.position.z, root.position.y + 0.4);
      } catch {
        ground = 0;
      }
      if (!(ground > -1.5)) {
        // Over water: sink once below the surface.
        if (root.position.y < -1.7) {
          drop.sunk = true;
          root.visible = false;
          try {
            if (game.fx.splash) game.fx.splash(root.position, 0.8);
          } catch {}
        }
        continue;
      }
      const restHeight = 0.045;
      if (root.position.y < ground + restHeight && drop.vel.y < 0) {
        root.position.y = ground + restHeight;
        const impactSpeed = -drop.vel.y;
        playDropSound(root, impactSpeed);
        drop.bounces++;
        if (impactSpeed < 1.1 || drop.bounces >= 3) {
          // Settle flat on its side, keeping the current heading.
          tmpVec.set(0, 0, -1).applyQuaternion(root.quaternion);
          const heading = Math.atan2(-tmpVec.x, -tmpVec.z);
          const side = new Vector3(1, 0, 0).applyQuaternion(root.quaternion).y > 0 ? 1 : -1;
          drop.qRest.setFromEuler(tmpEuler.set(0, heading, side * (Math.PI / 2 - 0.06), 'YXZ'));
          drop.rest = true;
          drop.restT = 0;
          drop.vel.set(0, 0, 0);
          break;
        }
        drop.vel.y = impactSpeed * 0.3;
        drop.vel.x *= 0.55;
        drop.vel.z *= 0.55;
        drop.w.multiplyScalar(0.55);
        drop.w.x += (rng() - 0.5) * 3;
      }
    }
  }

  /** Eases the resting dropped weapon onto the ground (first 0.5 s). */
  function settleDrop(dt: number): void {
    if (!drop.active || !drop.rest || drop.sunk) return;
    drop.restT += dt;
    if (drop.restT > 0.5) return;
    const root = drop.rig!.root;
    root.quaternion.slerp(drop.qRest, 1 - Math.exp(-16 * dt));
    let ground = 0;
    try {
      ground = game.physics.groundHeight(root.position.x, root.position.z, root.position.y + 0.4);
    } catch {
      ground = 0;
    }
    root.position.y = damp(root.position.y, ground + 0.024, 18, dt);
  }

  /** Puts a dropped weapon back on the camera (hidden). */
  function recoverDrop(): void {
    if (!drop.active) return;
    const rig = drop.rig!;
    const root = rig.root;
    game.camera.add(root);
    root.scale.set(1, 1, 1);
    arms.restore();
    root.traverse((child) => {
      child.layers.set(VIEWMODEL_LAYER);
      if ((child as Partial<Mesh>).isMesh) child.castShadow = false;
    });
    root.visible = false;
    drop.active = false;
    drop.rig = null;
  }

  /** Per-frame update: input, firing, reloads, switching, spread, flash and viewmodel pose. */
  function update(dt: number): void {
    const player = game.player;
    const input = game.input;
    if (player && input && !player.alive && !debug.pause) {
      if (!drop.active) dropWeapon();
      updateDropPhysics(dt);
      settleDrop(dt);
    }
    if (!player || !input || !player.alive) {
      anim.prevFire = false;
      if (current.flash) current.flash.visible = false;
      return;
    }
    if (debug.pause) return;
    anim.t += dt;
    if (input.pressed) {
      if (input.pressed('swap')) system.swap();
      else if (input.pressed('weapon1')) switchTo('rifle');
      else if (input.pressed('weapon2')) switchTo('pistol');
    }
    if (switchState.active) updateSwitch(dt);
    const rig = current;
    const def = rig.def;
    const slot = rig.slot;
    const switching = switchState.active;
    const firing = !!input.fire && visible && !debug.noFire;
    const firePressed = firing && !anim.prevFire;
    anim.prevFire = firing;
    if (!firing) anim.dryDone = false;
    const wantSprint =
      (!!player.sprinting || debug.sprint) && !firing && !input.ads && !anim.reload;
    anim.sprintT = damp(anim.sprintT, wantSprint ? 1 : 0, 9, dt);
    anim.spWant = wantSprint;
    anim.urgent = !wantSprint && (firing || !!input.ads || !!anim.reload);
    if (input.pressed && input.pressed('reload')) reloadNow();
    if (anim.autoReload >= 0) {
      anim.autoReload -= dt;
      if (anim.autoReload < 0) reloadNow();
    }
    if (debug.reloadT != null && !anim.reload) beginReload(debug.empty);
    if (anim.reload) {
      const reload = anim.reload;
      if (debug.reloadT != null) reload.t = debug.reloadT;
      else if (reload.fresh) reload.fresh = false;
      else reload.t += dt;
      rig.reload(reload, reload.t);
      if (reload.t >= reload.T && debug.reloadT == null) {
        anim.reload = null;
        anim.reloadW = 0;
        anim.rackW = 0;
        anim.antYT = 0;
        anim.antRT = 0;
        rig.endReload();
        game.events.emit('weapon:reload', {
          phase: 'done',
          empty: reload.empty,
          weapon: rig.id
        });
      }
    } else {
      anim.reloadW = 0;
      anim.rackW = 0;
      anim.antYT = 0;
      anim.antRT = 0;
    }
    anim.cooldown -= dt;
    const canFire = !anim.reload && !switching && anim.sprintT < 0.45;
    if (def.auto) {
      if (firing && canFire) {
        if (slot.ammo > 0) {
          let shots = 0;
          while (anim.cooldown <= 0 && slot.ammo > 0 && shots < 3) {
            fireShot();
            anim.cooldown += 60 / def.rpm;
            shots++;
          }
        } else if (!anim.dryDone) {
          anim.dryDone = true;
          game.events.emit('weapon:dry', {
            weapon: rig.id
          });
          anim.bump.v -= 0.08;
          if (slot.reserve > 0) anim.autoReload = 0.32;
        }
      }
    } else {
      // Semi-auto: a press is buffered for 0.13 s.
      if (firePressed) anim.fireQ = 0.13;
      else if (anim.fireQ > 0) anim.fireQ -= dt;
      if (anim.fireQ > 0 && canFire && anim.cooldown <= 0) {
        anim.fireQ = 0;
        if (slot.ammo > 0) {
          fireShot();
          anim.cooldown = 60 / def.rpm;
        } else {
          game.events.emit('weapon:dry', {
            weapon: rig.id
          });
          anim.bump.v -= 0.08;
          anim.cooldown = 0.12;
          if (slot.reserve > 0) anim.autoReload = 0.28;
        }
      }
    }
    if (anim.cooldown < 0) anim.cooldown = Math.max(anim.cooldown, -0.001);
    if (anim.t - anim.lastShot > 0.24) {
      if (anim.burst > 0) anim.recPhase = rng() * 6.28;
      anim.burst = 0;
    }
    anim.bloom = Math.max(0, anim.bloom - dt * def.spread.decay);
    if (
      def.smoke &&
      anim.t - anim.lastShot > 0.11 &&
      anim.t - anim.lastShot < 0.11 + dt * 1.5 &&
      anim.heat > 0.4
    )
      anim.smoke = Math.min(1.6, anim.heat * 1.3);
    if (anim.smoke > 0) {
      anim.smoke -= dt;
      anim.smokeTick -= dt;
      if (anim.smokeTick <= 0 && game.fx && game.fx.smoke) {
        anim.smokeTick = 0.085;
        muzzleWorld(muzzlePos);
        game.fx.smoke(muzzlePos, {
          size: 0.1 + anim.smoke * 0.06,
          life: 1.3,
          rise: 0.5,
          count: 1,
          alpha: 0.22
        });
      }
    }
    anim.heat = Math.max(0, anim.heat - dt * 0.2);
    const wantAds = (!!input.ads || debug.ads) && !anim.reload && !switching && anim.sprintT < 0.35;
    anim.adsLin = clamp(anim.adsLin + (wantAds ? dt : -dt) / def.adsTime, 0, 1);
    anim.adsE = smootherstep01(anim.adsLin);
    system.ads = anim.adsE;
    anim.adsWant = wantAds;
    const speed = player.speed || 0;
    const moveK = clamp01(speed / 6);
    const spread = def.spread;
    const targetSpread =
      lerp(spread.hip, spread.ads, anim.adsE) +
      moveK * lerp(spread.moveHip, spread.moveAds, anim.adsE) +
      anim.bloom * lerp(spread.bloomHip, spread.bloomAds, anim.adsE) +
      (player.onGround === false ? spread.air : 0) -
      (player.crouching ? spread.crouch * (1 - anim.adsE) : 0);
    anim.spreadS = damp(anim.spreadS, targetSpread, 18, dt);
    system.spread = anim.spreadS;
    if (
      firing ||
      !!input.ads ||
      !!anim.reload ||
      switching ||
      speed > 0.2 ||
      (input.look && Math.abs(input.look.dx) + Math.abs(input.look.dy) > 0.002) ||
      anim.sprintT > 0.1
    ) {
      anim.idleT = 0;
      if (anim.inspect >= 0) anim.inspect = Math.max(anim.inspect, 2.9);
    } else anim.idleT += dt;
    if (def.inspect && anim.inspect < 0 && anim.idleT > 24) anim.inspect = 0;
    // Idle inspect animation weights.
    let inspectRoll = 0;
    let inspectFlip = 0;
    let inspectHold = 0;
    if (anim.inspect >= 0) {
      const t = (anim.inspect += dt);
      inspectRoll = smootherstep01(t / 0.5) * (1 - smootherstep01((t - 1.4) / 0.5));
      inspectFlip = smootherstep01((t - 1.5) / 0.5) * (1 - smootherstep01((t - 2.8) / 0.5));
      inspectHold = smootherstep01(t / 0.5) * (1 - smootherstep01((t - 2.9) / 0.5));
      if (t > 3.5) {
        anim.inspect = -1;
        anim.idleT = 0;
      }
    }
    system.state = switching
      ? 'switching'
      : anim.reload
        ? 'reloading'
        : anim.inspect >= 0
          ? 'inspect'
          : anim.sprintT > 0.5
            ? 'sprinting'
            : anim.t - anim.lastShot < 0.14
              ? 'firing'
              : 'idle';
    anim.finger = damp(anim.finger, (firing && canFire) || debug.flash ? 1 : 0, 30, dt);
    rig.parts(dt, anim.finger, !!anim.reload);
    const flash = rig.flash;
    const uniforms = flash.material.uniforms;
    if (debug.flash) {
      anim.flashT = anim.flashDur = 0.05;
      uniforms.uSeed.value = 3.7;
      flash.scale.setScalar(def.flashScale);
    }
    anim.flashT -= dt;
    if (debug.flash) anim.flashT = anim.flashDur * 0.6;
    uniforms.uInt.value =
      anim.flashT > 0
        ? 9.5 * Math.sqrt(anim.flashT / anim.flashDur)
        : anim.lastShot === anim.t
          ? 4.5
          : 0;
    uniforms.uHeat.value = def.smoke ? clamp01((anim.heat - 0.45) / 0.8) * 2.2 : 0;
    flash.visible = uniforms.uInt.value > 0 || uniforms.uHeat.value > 0.02;
    if (debug.freeze) {
      arms.update(dt, rig, rig.root);
      return;
    }
    applyViewmodelPose(
      Math.min(dt, 0.1),
      rig,
      player,
      input,
      inspectRoll,
      inspectFlip,
      inspectHold
    );
    arms.update(dt, rig, rig.root);
  }

  const baseQuat = new Quaternion();
  const offsetQuat = new Quaternion();
  const poseEuler = new Euler();
  const pivot = new Vector3();
  const pivotRotated = new Vector3();
  const kickOffset = new Vector3();
  /** Holster easing curves (vertical, horizontal, rotation). */
  const holsterCurveY = (t: number) => t * (0.35 + 0.65 * Math.abs(t));
  const holsterCurveXZ = (t: number) => t * (1.6 - 0.6 * Math.abs(t));
  const holsterCurveRot = (t: number) => t * (1.45 - 0.45 * Math.abs(t));
  /** Snaps a spring onto its target once it has (almost) settled. */
  const settleSpring = (spring: WeaponSpring, target: number) => {
    if (Math.abs(spring.x - target) < 1e-5 && Math.abs(spring.v) < 1e-4)
      resetSpring(spring, target);
  };

  /**
   * Procedural viewmodel placement: view pose blends (hip/ADS/sprint/reload/
   * rack/holster/wall), idle breathing, gait bob, inertia, look sway, jump /
   * land / crouch, and recoil springs.
   */
  function applyViewmodelPose(
    dt: number,
    rig: WeaponViewmodel,
    player: Player,
    input: InputState,
    inspectRoll: number,
    inspectFlip: number,
    inspectHold: number
  ): void {
    const motion = rig.motion;
    const views = rig.pose;
    const hip = views.HIP;
    const ads = views.ADS;
    const sprint = views.SPRINT;
    const sprintArc = views.SPRINT_ARC;
    const reloadOffset = views.RELOAD;
    const rackOffset = views.RACK;
    const adsArc = motion.ads.arc;
    const wallCfg = motion.wall;
    const onGround = player.onGround !== false;
    const speed = player.speed || 0;
    const velX = player.vel ? player.vel.x : 0;
    const velY = player.vel ? player.vel.y : 0;
    const velZ = player.vel ? player.vel.z : 0;
    const time = anim.t;
    advanceSpring(anim.adsV, anim.adsWant ? 1 : 0, dt, motion.ads.w, motion.ads.z);
    settleSpring(anim.adsV, anim.adsWant ? 1 : 0);
    advanceSpring(anim.adsS, anim.adsWant ? 1 : 0, dt);
    settleSpring(anim.adsS, anim.adsWant ? 1 : 0);
    // Pull the gun back slightly while the fast ADS spring leads the slow one.
    const adsLead = anim.adsS.x - anim.adsV.x;
    const adsPullBack = adsLead > 0 ? adsLead * adsLead * motion.ads.out : 0;
    advanceSpring(
      anim.spV,
      anim.spWant ? 1 : 0,
      dt,
      motion.sprint.spr[0] * (anim.urgent ? 1.5 : 1),
      motion.sprint.spr[1]
    );
    settleSpring(anim.spV, anim.spWant ? 1 : 0);
    advanceSpring(anim.rwS, anim.reloadW, dt);
    settleSpring(anim.rwS, anim.reloadW);
    advanceSpring(anim.rkS, anim.rackW, dt);
    settleSpring(anim.rkS, anim.rackW);
    const adsT = anim.adsV.x;
    const adsClamped = clamp01(adsT);
    const adsSmooth = adsClamped * adsClamped * (3 - 2 * adsClamped);
    const adsArcK = 4 * adsT * (1 - adsT);
    const sprintK = anim.spV.x;
    const sprintArcK = 4 * sprintK * (1 - sprintK);
    const reloadK = anim.rwS.x;
    const rackK = anim.rkS.x;
    const holster = anim.hol;
    const holsterXZ = holsterCurveXZ(holster);
    const holsterY = holsterCurveY(holster);
    const holsterRot = holsterCurveRot(holster);
    // Pull the gun in when the muzzle gets close to a wall.
    anim.wallT -= dt;
    if (anim.wallT <= 0 && game.physics && game.physics.raycast && player.forward && player.eye) {
      anim.wallT = 0.08;
      let hit: RaycastHit | null = null;
      try {
        hit = game.physics.raycast(player.eye, player.forward, wallCfg.far);
      } catch {
        hit = null;
      }
      anim.wallK = hit
        ? smootherstep01((wallCfg.far - hit.dist) / (wallCfg.far - wallCfg.near))
        : 0;
    }
    advanceSpring(anim.wall, anim.wallK, dt);
    settleSpring(anim.wall, anim.wallK);
    const wallK = anim.wall.x * (1 - 0.85 * adsSmooth) * (1 - clamp01(holster * holster));
    const posX =
      hip.p[0] +
      (ads.p[0] - hip.p[0]) * adsT +
      adsArc.p[0] * adsArcK +
      sprint.p[0] * sprintK +
      sprintArc.p[0] * sprintArcK +
      reloadOffset.p[0] * reloadK +
      rackOffset.p[0] * rackK +
      HOLSTER_OFFSET.p[0] * holsterXZ +
      wallCfg.p[0] * wallK -
      0.035 * inspectHold;
    const posY =
      hip.p[1] +
      (ads.p[1] - hip.p[1]) * adsT +
      adsArc.p[1] * adsArcK +
      sprint.p[1] * sprintK +
      sprintArc.p[1] * sprintArcK +
      reloadOffset.p[1] * reloadK +
      rackOffset.p[1] * rackK +
      HOLSTER_OFFSET.p[1] * holsterY +
      wallCfg.p[1] * wallK +
      0.045 * inspectHold;
    const posZ =
      hip.p[2] +
      (ads.p[2] - hip.p[2]) * adsT +
      adsArc.p[2] * adsArcK +
      sprint.p[2] * sprintK +
      sprintArc.p[2] * sprintArcK +
      reloadOffset.p[2] * reloadK +
      rackOffset.p[2] * rackK +
      HOLSTER_OFFSET.p[2] * holsterXZ +
      wallCfg.p[2] * wallK;
    const rotX =
      hip.r[0] * (1 - adsT) +
      adsArc.r[0] * adsArcK +
      sprint.r[0] * sprintK +
      sprintArc.r[0] * sprintArcK +
      reloadOffset.r[0] * reloadK +
      rackOffset.r[0] * rackK +
      HOLSTER_OFFSET.r[0] * holsterRot +
      wallCfg.r[0] * wallK +
      0.3 * inspectHold;
    const rotY =
      hip.r[1] * (1 - adsT) +
      adsArc.r[1] * adsArcK +
      sprint.r[1] * sprintK +
      sprintArc.r[1] * sprintArcK +
      reloadOffset.r[1] * reloadK +
      rackOffset.r[1] * rackK +
      HOLSTER_OFFSET.r[1] * holsterRot +
      wallCfg.r[1] * wallK +
      0.18 * inspectHold +
      0.25 * inspectFlip;
    const rotZ =
      hip.r[2] * (1 - adsT) +
      adsArc.r[2] * adsArcK +
      sprint.r[2] * sprintK +
      sprintArc.r[2] * sprintArcK +
      reloadOffset.r[2] * reloadK +
      rackOffset.r[2] * rackK +
      HOLSTER_OFFSET.r[2] * holsterRot +
      wallCfg.r[2] * wallK -
      0.75 * inspectRoll +
      0.55 * inspectFlip;
    // Additive procedural offsets (position and pitch/yaw/roll).
    let offX = 0;
    let offY = 0;
    let offZ = 0;
    let offPitch = 0;
    let offYaw = 0;
    let offRoll = 0;
    const adsPosScale = lerp(1, motion.ads.pos, adsSmooth);
    const adsRotScale = lerp(1, motion.ads.rot, adsSmooth);
    if (!debug.noIdle) {
      // Idle: breathing plus slow drift and noise.
      const idle = motion.idle;
      const exertion = anim.exert;
      const posAmp = adsPosScale * (1 - 0.5 * sprintK);
      const rotAmp = adsRotScale;
      anim.exert = damp(anim.exert, player.sprinting ? 1 : 0, player.sprinting ? 0.3 : 0.14, dt);
      anim.breath +=
        dt * TWO_PI * idle.hz * (1 + 0.5 * exertion) * (1 + 0.1 * gradientNoise1D(time * 0.11, 3));
      if (anim.breath > 4096) anim.breath -= 651 * TWO_PI;
      const breath = anim.breath;
      const breathAmp = (1 + 0.9 * exertion) * (1 + 0.2 * gradientNoise1D(time * 0.07, 5));
      const breathY = (Math.sin(breath) + 0.24 * Math.sin(2 * breath + 0.7)) * breathAmp;
      const breathP = (Math.sin(breath - 0.6) + 0.2 * Math.sin(2 * breath + 0.2)) * breathAmp;
      const driftA = 1.4 * gradientNoise1D(time * 0.09, 7);
      const driftB = 1.4 * gradientNoise1D(time * 0.08, 8);
      offX +=
        (Math.sin(time * 0.53 + driftA) * idle.drift +
          breathY * idle.breathY * 0.15 +
          gradientNoise1D(time * 2.3, 12) * idle.noise) *
        posAmp;
      offY +=
        (breathY * idle.breathY +
          Math.sin(time * 0.83 + 1.7 + driftB) * idle.drift * 0.6 +
          gradientNoise1D(time * 1.9, 11) * idle.noise) *
        posAmp;
      offPitch +=
        (breathP * idle.breathP +
          Math.sin(time * 0.41 + 0.9 + driftB) * idle.driftR * 0.5 +
          gradientNoise1D(time * 1.6, 13) * idle.noiseR) *
        rotAmp;
      offYaw +=
        (Math.sin(time * 0.37 + 2.2 + driftA) * idle.driftR +
          gradientNoise1D(time * 1.3, 14) * idle.noiseR) *
        rotAmp;
      offRoll +=
        (Math.sin(time * 0.29 + 0.4 - driftA) * idle.driftR * 0.8 +
          gradientNoise1D(time * 1.1, 15) * idle.noiseR) *
        rotAmp;
    }
    {
      // Gait bob, phase-locked to the player's footsteps.
      const strides = player.tuning && player.tuning.stride ? player.tuning.stride : DEFAULT_STRIDE;
      const strideLen = advanceSpring(
        anim.stride,
        player.crouching ? strides.crouch : player.sprinting ? strides.sprint : strides.walk,
        dt
      );
      anim.spd = damp(anim.spd, speed, 14, dt);
      const phase = anim.gait + anim.gOff.x;
      if (onGround) {
        const moving = clamp01(speed / 0.5);
        anim.gait +=
          (moving * speed * dt) / strideLen -
          (((1 - moving) * Math.sin(TWO_PI * phase)) / TWO_PI) * (1 - Math.exp(-8 * dt));
      }
      if (anim.landEv >= 0 || (!anim.wasGround && onGround))
        anim.gOffT += Math.floor(phase) + 0.35 - phase;
      else if (anim.stepEv) {
        const advance = (speed * dt) / strideLen;
        const stepError = Math.round(phase) - phase - advance * 0.5;
        if (Math.abs(stepError) > 0.55 * advance)
          anim.gOffT += stepError - (anim.gOffT - anim.gOff.x);
      }
      anim.stepEv = 0;
      advanceSpring(anim.gOff, anim.gOffT, dt);
      if (anim.gait > 2048) anim.gait -= 2048;
      advanceSpring(
        anim.amt,
        onGround ? Math.pow(clamp01(speed / 3.8), 0.8) * (player.crouching ? motion.crouch : 1) : 0,
        dt
      );
      const walk = motion.walk;
      const run = motion.run;
      const amount = anim.amt.x;
      const gaitPhase =
        anim.gait + anim.gOff.x - (lerp(walk.lag, run.lag, sprintK) * anim.spd) / strideLen;
      const wave = TWO_PI * gaitPhase - GAIT_PHASE_OFFSET;
      const halfWave = Math.PI * gaitPhase;
      const bobPosAmp = amount * lerp(1, 0.14, adsSmooth);
      const bobRotAmp = amount * lerp(1, 0.05, adsSmooth);
      const bobY = gaitBobWave(wave);
      const bobX = Math.sin(halfWave) + 0.16 * Math.sin(3 * halfWave + 0.5);
      const bobZ = Math.sin(wave + GAIT_PHASE_OFFSET + 2.2) + 0.25 * Math.sin(halfWave + 0.4);
      const bobPitch = gaitBobWave(wave - 0.55);
      const bobYaw = Math.sin(halfWave + 1.25) + 0.22 * Math.sin(wave + GAIT_PHASE_OFFSET);
      const bobRoll = Math.sin(halfWave + 0.35) + 0.25 * Math.sin(wave + GAIT_PHASE_OFFSET + 1);
      offX += bobX * lerp(walk.x, run.x, sprintK) * bobPosAmp;
      offY += bobY * lerp(walk.y, run.y, sprintK) * bobPosAmp;
      offZ += bobZ * lerp(walk.z, run.z, sprintK) * bobPosAmp;
      offPitch += bobPitch * lerp(walk.pitch, run.pitch, sprintK) * bobRotAmp;
      offYaw += bobYaw * lerp(walk.yaw, run.yaw, sprintK) * bobRotAmp;
      offRoll += bobRoll * lerp(walk.roll, run.roll, sprintK) * bobRotAmp;
    }
    {
      // Inertia: lag behind changes of the (view-relative) velocity.
      const inertia = motion.inertia;
      const yaw = player.yaw || 0;
      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);
      const velRight = velX * cosYaw - velZ * sinYaw;
      const velForward = -velX * sinYaw - velZ * cosYaw;
      const lowPassK = 1 - Math.exp(-dt / inertia.tau);
      anim.lpR += (velRight - anim.lpR) * lowPassK;
      anim.lpF += (velForward - anim.lpF) * lowPassK;
      const accelRight = velRight - anim.lpR;
      const accelForward = velForward - anim.lpF;
      const posK = lerp(1, 0.3, adsSmooth);
      const rotK = lerp(1, 0.08, adsSmooth);
      offZ += advanceSpring(anim.inZ, accelForward * inertia.z, dt) * posK;
      offX += advanceSpring(anim.inX, -accelRight * inertia.x, dt) * posK;
      offPitch += advanceSpring(anim.inP, accelForward * inertia.pitch, dt) * rotK;
      offRoll +=
        advanceSpring(
          anim.inR,
          -accelRight * inertia.roll - anim.lpR * inertia.lean * (1 - sprintK),
          dt
        ) * rotK;
    }
    {
      // Look sway.
      const sway = motion.sway;
      const kick = sway.spr[0] * sway.spr[0] * sway.lag;
      const limit = sway.max * 2.5;
      anim.swY.v += clamp(input.look ? input.look.dx : 0, -0.35, 0.35) * kick;
      anim.swP.v += clamp(input.look ? input.look.dy : 0, -0.35, 0.35) * kick * 0.8;
      advanceSpring(anim.swY, 0, dt);
      advanceSpring(anim.swP, 0, dt);
      if (anim.swY.x > limit || anim.swY.x < -limit) {
        anim.swY.x = clamp(anim.swY.x, -limit, limit);
        anim.swY.v = 0;
      }
      if (anim.swP.x > limit || anim.swP.x < -limit) {
        anim.swP.x = clamp(anim.swP.x, -limit, limit);
        anim.swP.v = 0;
      }
      const swayYaw = softClampTanh(anim.swY.x, sway.max);
      const swayPitch = softClampTanh(anim.swP.x, sway.max * 0.75);
      const rotK = lerp(1, sway.adsRot, adsSmooth);
      const posK = lerp(1, sway.adsPos, adsSmooth);
      offYaw += swayYaw * rotK;
      offRoll -= swayYaw * sway.roll * rotK;
      offPitch += swayPitch * rotK;
      offX -= swayYaw * sway.shift * posK;
      offY += swayPitch * sway.shift * posK;
    }
    {
      // Jump / fall / landing kicks and the crouch dip.
      const air = motion.air;
      const posK = lerp(1, 0.45, adsSmooth);
      const rotK = lerp(1, 0.1, adsSmooth);
      if (anim.wasGround && !onGround && (anim.jumpEv || velY > 1)) {
        anim.jY.v += air.jumpY;
        anim.jP.v += air.jumpP;
      }
      if (!anim.wasGround && onGround) {
        const impact = clamp(Math.max(anim.landEv, -anim.lastVy), 0, 14);
        anim.landSide = -anim.landSide;
        anim.jY.v -= impact * air.landY;
        anim.jP.v -= impact * air.landP;
        anim.jR.v += anim.landSide * impact * air.landR * (0.65 + 0.35 * rng());
      }
      anim.wasGround = onGround;
      anim.jumpEv = 0;
      anim.landEv = -1;
      if (!onGround) anim.lastVy = velY;
      const crouchDip = motion.crouchDip;
      const crouchTarget = player.crouching ? 1 : 0;
      const dip =
        (advanceSpring(anim.stance, crouchTarget, dt, crouchDip.w[0], 1) -
          advanceSpring(anim.stance2, crouchTarget, dt, crouchDip.w[1], 1)) *
        2.4;
      offY -= dip * crouchDip.y * posK;
      offPitch -= dip * crouchDip.pitch * rotK;
      offRoll += dip * crouchDip.roll * rotK;
      offY +=
        advanceSpring(anim.jY, onGround ? 0 : clamp(-velY * air.fallY, -0.004, 0.016), dt) * posK;
      offPitch +=
        advanceSpring(anim.jP, onGround ? 0 : clamp(-velY * air.fallP, -0.02, 0.04), dt) * rotK;
      offRoll += advanceSpring(anim.jR, 0, dt) * rotK;
    }
    // Recoil springs, then compose the final transform around the motion pivot.
    advanceSpring(anim.kZ, 0, dt);
    advanceSpring(anim.kP, 0, dt);
    advanceSpring(anim.kY, 0, dt);
    advanceSpring(anim.kR, 0, dt);
    advanceSpring(anim.kX, 0, dt);
    advanceSpring(anim.kU, 0, dt);
    advanceSpring(anim.bump, 0, dt);
    advanceSpring(anim.antY, anim.antYT, dt);
    advanceSpring(anim.antR, anim.antRT, dt);
    offPitch += anim.kP.x + anim.bump.x * 1.5;
    offYaw += anim.kY.x;
    offRoll += anim.kR.x + anim.antR.x;
    offY += anim.bump.x * 0.6 + anim.antY.x;
    baseQuat.setFromEuler(poseEuler.set(rotX, rotY, rotZ, 'YXZ'));
    offsetQuat.setFromEuler(poseEuler.set(offPitch, offYaw, offRoll, 'YXZ'));
    pivot.fromArray(motion.pivot);
    pivotRotated.copy(pivot).applyQuaternion(offsetQuat);
    pivot.sub(pivotRotated);
    kickOffset
      .set(pivot.x + anim.kX.x, pivot.y + anim.kU.x, pivot.z + anim.kZ.x - adsPullBack)
      .applyQuaternion(baseQuat);
    rig.root.position.set(
      posX + offX + kickOffset.x,
      posY + offY + kickOffset.y,
      posZ + offZ + kickOffset.z
    );
    rig.root.quaternion.copy(baseQuat).multiply(offsetQuat);
  }

  reset();
  if (game.params && game.params.wview) setView(game.params.wview);
  if (
    typeof window < 'u' &&
    game.params &&
    game.params.shot &&
    !game.showcase &&
    window.__setShot
  ) {
    // Screenshot harness: `__setShot({ wgun, wpose, wt, ... })` poses the weapon.
    const previousSetShot = window.__setShot;
    window.__setShot = (shot) => {
      if (shot && shot.wview) setView(shot.wview);
      if (shot && shot.wfill && game.render) game.render.viewFill = +shot.wfill;
      if (shot && (shot.wgun || shot.wpose)) {
        debug.pause = false;
        const gun = shot.wgun === 'pistol' ? 'pistol' : 'rifle';
        const pose = shot.wpose || 'hip';
        const empty = pose === 'empty';
        anim.reload = null;
        debug.reloadT = null;
        debug.empty = false;
        debug.flash = pose === 'fire';
        debug.ads = pose === 'ads' || !!shot.wads;
        debug.sprint = pose === 'sprint';
        for (const rig of rigList) {
          rig.slot.ammo = rig.def.magSize;
          rig.reset();
        }
        system.equip(gun);
        if (empty || pose === 'locked') {
          current.slot.ammo = 0;
          current.setLocked(true);
        }
        if (pose === 'reload' || empty) {
          debug.reloadT = shot.wt != null ? +shot.wt : 0.6;
          debug.empty = empty;
        }
        system.snap();
        update(0.016);
        system.snap();
        if (pose === 'switch') {
          switchTo(gun === 'rifle' ? 'pistol' : 'rifle');
          const duration = shot.wt != null ? +shot.wt : 0.14;
          for (let t = 0; t < duration - 1e-6; t += 0.005) update(0.005);
          debug.pause = true;
        }
      }
      previousSetShot(shot);
    };
  }
  return system;
}

/** A showcase camera shot: `[yaw, camera position, look target, fov]`. */
type ShowcaseShot = [number, number[], number[], number];

/** Weapon showcase (`?show=weapon&wpose=...`): poses a viewmodel in the world or in first person. */
export async function weaponShowcase(game: Game): Promise<WeaponShowcase> {
  const weapon = await createWeapon(game);
  game.weapon = weapon;
  const eye = new Vector3(0, 1.68, 4);
  /** First-person look directions (`wlook`). */
  const LOOK_DIRS: Record<string, number[] | undefined> = {
    south: [0.28, -0.01, 1],
    east: [1, 0, 0.25],
    north: [-0.2, -0.01, -1],
    west: [-1, 0, 0.1],
    nw: [-0.75, -0.01, -0.65]
  };
  /** Third-person product shots of each gun, by pose name. */
  const SHOTS: Record<'rifle' | 'pistol', Record<string, ShowcaseShot | undefined>> = {
    rifle: {
      side: [Math.PI, [1.12, 1.3, 0.11], [0, 1.235, 0.11], 30],
      right: [0, [1.12, 1.3, -0.11], [0, 1.235, -0.11], 30],
      top: [Math.PI * 0.86, [0.62, 1.8, -0.42], [0, 1.24, 0.12], 32],
      hands: [Math.PI, [0.4, 1.4, 0.02], [0.02, 1.215, 0.25], 30],
      rhand: [0, [0.36, 1.22, 0.27], [0.03, 1.16, 0.09], 30],
      muzzle: [Math.PI, [0.26, 1.37, 0.98], [0, 1.262, 0.44], 30],
      optic: [Math.PI, [0.2, 1.4, -0.26], [0, 1.31, 0.02], 30],
      lower: [Math.PI, [0.34, 1.26, 0.04], [0, 1.2, 0.03], 30]
    },
    pistol: {
      side: [Math.PI, [0.5, 1.25, -0.03], [0, 1.215, -0.03], 30],
      right: [0, [0.5, 1.25, 0.03], [0, 1.215, 0.03], 30],
      top: [Math.PI * 0.86, [0.2, 1.56, -0.16], [0, 1.25, 0], 32],
      hands: [Math.PI * 0.8, [0.3, 1.36, -0.2], [0, 1.2, -0.01], 30],
      rear: [Math.PI * 0.93, [0.07, 1.33, -0.34], [0, 1.24, 0], 30],
      grip: [0, [0.28, 1.2, 0.16], [0, 1.19, 0.05], 30],
      under: [Math.PI, [0.26, 1.02, -0.16], [0, 1.17, -0.05], 30]
    }
  };
  const previousSetShot = window.__setShot;
  let currentPose: string | null = null;

  function applyPose(
    poseName: string,
    options: CameraShot = {}
  ): { cam: number[]; target: number[] } {
    const gun = options.wgun === 'pistol' ? 'pistol' : 'rifle';
    const productShot = SHOTS[gun][poseName];
    currentPose = poseName;
    if (options.wview) weapon.setView(options.wview);
    const input = game.input;
    const player = game.player;
    input.ads = false;
    input.fire = false;
    player.sprinting = false;
    player.speed = 0;
    weapon.debug.pause = false;
    weapon.debug.reloadT = null;
    weapon.debug.flash = false;
    weapon.debug.empty = false;
    weapon.debug.freeze = !!productShot;
    weapon.arms.attach(null);
    weapon.reset();
    weapon.equip(gun);
    for (const rig of Object.values(weapon.rigs)) {
      game.camera.add(rig.root);
      rig.root.traverse((child) => child.layers.set(VIEWMODEL_LAYER));
    }
    const root = weapon.root;
    const rig = weapon.rigs[gun];
    const forceReload = (t: number | string, empty: boolean) => {
      weapon.debug.reloadT = +t;
      weapon.debug.empty = !!empty;
      if (empty) {
        weapon.ammo = 0;
        rig.setLocked(true);
      }
    };
    let cam: number[];
    let target: number[];
    let fov: number;
    if (productShot) {
      game.scene.add(root);
      root.position.set(0, 1.25, 0);
      root.rotation.set(0, productShot[0], 0, 'YXZ');
      root.traverse((child) => child.layers.set(WORLD_LAYER));
      weapon.arms.attach(root, rig.pose.HIP, WORLD_LAYER);
      cam = productShot[1];
      target = productShot[2];
      fov = productShot[3];
      if (options.wt != null) forceReload(options.wt, !!options.wempty);
      else if (options.wempty) {
        weapon.ammo = 0;
        rig.setLocked(true);
      }
    } else {
      // First person from a fixed eye point.
      const look = LOOK_DIRS[String(options.wlook)] || LOOK_DIRS.south!;
      cam = [eye.x, eye.y, eye.z];
      target = [eye.x + look[0] * 50, eye.y + look[1] * 50, eye.z + look[2] * 50];
      fov = 74;
      if (poseName === 'ads') {
        input.ads = true;
        fov = 52;
      }
      if (poseName === 'sprint') {
        player.sprinting = true;
        player.speed = 6;
      }
      if (poseName === 'fire') {
        weapon.debug.flash = true;
        if (options.wads) {
          input.ads = true;
          fov = 52;
        }
      }
      if (poseName === 'reload' || poseName === 'empty')
        forceReload(options.wt != null ? options.wt : 0.62, poseName === 'empty');
      if (poseName === 'locked') {
        weapon.ammo = 0;
        rig.setLocked(true);
        if (options.wads) {
          input.ads = true;
          fov = 52;
        }
      }
    }
    weapon.snap();
    weapon.update(0.016);
    weapon.snap();
    if (poseName === 'switch') {
      weapon.switchTo(gun === 'rifle' ? 'pistol' : 'rifle');
      const duration = options.wt != null ? +options.wt : 0.14;
      for (let t = 0; t < duration - 1e-6; t += 0.005) weapon.update(0.005);
      weapon.debug.pause = true;
    }
    if (previousSetShot)
      previousSetShot({
        cam: options.cam || [...cam, ...target].join(','),
        fov: options.fov || fov,
        exposure: options.exposure
      });
    return {
      cam,
      target
    };
  }
  window.__setShot = (shot) => {
    if (shot && shot.wpose) applyPose(String(shot.wpose), shot);
    else if (previousSetShot) previousSetShot(shot);
  };
  const initial = applyPose(game.params.wpose || 'hip', game.params);
  return {
    cam: initial.cam,
    target: initial.target,
    update(dt: number) {
      weapon.update(dt);
      if (currentPose === 'fire') weapon.debug.flash = true;
    }
  };
}

export { createWeapon as create, weaponShowcase as showcase };
