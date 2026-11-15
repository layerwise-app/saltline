// Guard: the human port-security rifleman. Holds the guard tuning, the carbine, the instance
// factory with patrol / cover-to-cover AI, burst fire with difficulty-scaled spread and a
// low-health radio call and retreat, and two bodies: the animated character model from
// guardAsset.ts (clip blending plus procedural aim / recoil / flinch layers and death clips)
// and, if that model can't be loaded, the procedural humanoid rig with procedural walk / run /
// kneel / aim / death animation driven by arm IK onto the rifle.
import {
  CapsuleGeometry,
  Euler,
  Mesh,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3
} from 'three';
import type { AnimationAction, Bone, BufferGeometry, MeshBasicMaterial, Object3D } from 'three';
import { applyTransform, roundedBox, worldUvCylinder } from '../render/geometry';
import type { Player } from '../player/index';
import { RigBuilder, createSkinnedRig } from './rig';
import type { RigDef, SkinnedRig, Tint } from './rig';
import { GUARD_STRIDE, createGuardModel, playGuardDeath, resetGuardModel } from './guardAsset';
import type { GuardAsset, GuardDeathClip, GuardLoopClip } from './guardAsset';
import { houndAngleDelta as angleDelta, houndClamp as clamp, rayCapsuleHit, raySphereHit } from './hound';
import type { Spring } from './hound';
import type { Enemy, EnemyContext, EnemyMaterials, EnemyRayHit, EnemySpawnOptions } from './index';

/** Guard combat / locomotion tuning (difficulty presets and holdout waves override parts). */
export const GUARD_TUNING = {
  hp: 85,
  /** Extra multiplier on top of combat's weak-point bonus (a rifle headshot is lethal). */
  headMult: 1.6,
  shotDamage: 4,
  /** Rounds per burst (about +-1 at random). */
  burst: 4,
  /** Seconds between rounds (~600 rpm). */
  burstGap: 0.1,
  /** Bursts fired per peek before ducking back into cover. */
  volley: 2,
  /** Pause between the bursts of one volley (s). */
  volleyGap: [0.25, 0.5],
  /** Time spent shouldering and settling the rifle before the first round. */
  telegraph: 0.45,
  /** Time in cover between volleys (s). */
  cooldown: [1.4, 2.2],
  /** Sight time needed to go from patrol to engage. */
  reactTime: 0.6,
  /** Chance that taking a hit breaks off the current volley. */
  flinch: 0.3,
  /** Keeps firing at the last known position this long after losing sight (suppression). */
  suppressTime: 1.2,
  /** Relocation bias toward the player (0 = keeps its distance, higher = pushes in). */
  advance: 0.08,
  runSpeed: 4.2,
  stalkSpeed: 2.2,
  walkSpeed: 1.45,
  accel: 9,
  turnRate: 5,
  rangeMin: 7,
  rangeMax: 22,
  // Wide enough that sustained fire is mostly near misses (pressure) rather than a laser.
  spreadFar: 0.11,
  spreadNear: 0.055,
  /** Spread growth per round within a burst. */
  recoilSpread: 0.15,
  /** Fraction of max hp below which the guard radios for support and falls back. */
  retreatBelow: 0.35,
  supportRadius: 40,
  corpseTime: 12,
  replan: 0.5
};

const CFG = GUARD_TUNING;
const HALF_PI = Math.PI / 2;

/** Rig dimensions (metres, bind pose). */
const GUARD_DIMS = {
  hipY: 0.98,
  spine: 0.1,
  chest: 0.2,
  neck: 0.2,
  head: 0.08,
  shoulderX: 0.19,
  shoulderY: 0.15,
  upper: 0.29,
  fore: 0.25,
  hipX: 0.095,
  hipDrop: 0.05,
  thigh: 0.43,
  shin: 0.42,
  /** Hip height when kneeling. */
  kneelDrop: 0.42
};
const D = GUARD_DIMS;

// Palette (vertex tints; cloth/gear materials are white-based so these are the colours).
const NAVY: Tint = [0.07, 0.095, 0.165];
const NAVY_DARK: Tint = [0.045, 0.06, 0.1];
const CHARCOAL: Tint = [0.15, 0.16, 0.17];
const GEAR_BLACK: Tint = [0.06, 0.062, 0.068];
const BOOT: Tint = [0.05, 0.045, 0.04];
const HIVIS: Tint = [1.35, 1.05, 0.12];
const REFLECT: Tint = [1.5, 1.52, 1.55];
const SKIN: Tint = [0.5, 0.34, 0.26];
const GUN_DARK: Tint = [0.42, 0.43, 0.45];
const GUN_MID: Tint = [0.7, 0.72, 0.74];
const LED_RED: Tint = [6, 0.5, 0.25];
const LENS_WHITE: Tint = [1, 1, 1];

export const GUARD_LIGHT_IDLE: number[] = [0.3, 0.29, 0.26];
export const GUARD_LIGHT_ALERT: number[] = [0.85, 0.8, 0.68];

const box = (w: number, h: number, d: number, r = 0.012) => roundedBox(w, h, d, r);
const place = <T extends BufferGeometry>(
  geometry: T,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  s: number | [number, number, number] = 1
) => applyTransform(geometry, { p: [x, y, z], r: [rx, ry, rz], s });
const cylY = (rt: number, rb: number, h: number, seg = 10) => worldUvCylinder(rt, rb, h, seg);
const cylZ = (rt: number, rb: number, h: number, seg = 10) =>
  applyTransform(worldUvCylinder(rt, rb, h, seg), { r: [HALF_PI, 0, 0] });
const capsule = (r: number, len: number, seg = 10) => new CapsuleGeometry(r, len, 3, seg);
const ellipsoid = (r: number, sx: number, sy: number, sz: number, w = 14, h = 10) => {
  const geometry = new SphereGeometry(r, w, h);
  geometry.scale(sx, sy, sz);
  return geometry;
};

/** Grip (right wrist) and handguard (left wrist) positions in rifle space. */
const GRIP_RIGHT = new Vector3(0, 0.0, -0.06);
const GRIP_LEFT = new Vector3(0, -0.035, 0.27);
/** Muzzle position in rifle space. */
const MUZZLE_LOCAL = new Vector3(0, 0.045, 0.56);
/** Ejection port in rifle space. */
const PORT_LOCAL = new Vector3(-0.035, 0.04, 0.08);

/** Builds the guard's skinned rig: humanoid skeleton plus a carbine bone held in chest space. */
export function buildGuardRigDef(): RigDef {
  const rig = new RigBuilder();
  rig.bone('root', null, 0, 0, 0);
  rig.bone('hips', 'root', 0, D.hipY, 0);
  rig.bone('spine', 'hips', 0, D.spine, 0);
  rig.bone('chest', 'spine', 0, D.chest, 0);
  rig.bone('neck', 'chest', 0, D.neck, 0);
  rig.bone('head', 'neck', 0, D.head, 0);
  rig.bone('gun', 'chest', 0, 0, 0);
  // Side +1 = the guard's left (+X when facing +Z), -1 = right (gun hand).
  for (const [name, side] of [
    ['L', 1],
    ['R', -1]
  ] as const) {
    rig.bone('upper' + name, 'chest', side * D.shoulderX, D.shoulderY, 0);
    rig.bone('fore' + name, 'upper' + name, 0, -D.upper, 0);
    rig.bone('hand' + name, 'fore' + name, 0, -D.fore, 0);
    rig.bone('thigh' + name, 'hips', side * D.hipX, -D.hipDrop, 0);
    rig.bone('shin' + name, 'thigh' + name, 0, -D.thigh, 0);
    rig.bone('foot' + name, 'shin' + name, 0, -D.shin, 0);
  }
  const add = (slot: string, bone: string, geometry: BufferGeometry, tint: Tint, shade = true) =>
    rig.add(slot, bone, geometry, tint, shade);

  // Pelvis, belt and holster.
  add('cloth', 'hips', place(box(0.33, 0.2, 0.21, 0.05), 0, -0.04, 0), NAVY);
  add('gear', 'hips', place(box(0.35, 0.05, 0.23, 0.015), 0, 0.05, 0), GEAR_BLACK);
  add('metal', 'hips', place(box(0.05, 0.035, 0.012, 0.004), 0, 0.05, 0.118), GUN_MID);
  add('gear', 'hips', place(box(0.06, 0.14, 0.09, 0.012), -0.19, -0.03, 0.01), GEAR_BLACK);
  add('gear', 'hips', place(box(0.07, 0.08, 0.05, 0.01), 0.12, 0.0, -0.12), CHARCOAL);
  // Abdomen.
  add('cloth', 'spine', place(box(0.31, 0.22, 0.19, 0.06), 0, 0.09, 0), NAVY);
  // Torso, plate carrier, hi-vis band and pouches.
  add('cloth', 'chest', place(box(0.4, 0.3, 0.21, 0.07), 0, 0.06, 0), NAVY);
  add('gear', 'chest', place(box(0.34, 0.32, 0.27, 0.03), 0, 0.03, 0), CHARCOAL);
  add('gear', 'chest', place(box(0.345, 0.045, 0.275, 0.008), 0, -0.04, 0), HIVIS);
  add('gear', 'chest', place(box(0.345, 0.014, 0.277, 0.004), 0, -0.04, 0), REFLECT);
  add('gear', 'chest', place(box(0.345, 0.045, 0.275, 0.008), 0, 0.075, 0), HIVIS);
  add('gear', 'chest', place(box(0.345, 0.014, 0.277, 0.004), 0, 0.075, 0), REFLECT);
  for (const x of [-0.1, 0, 0.1]) {
    add('gear', 'chest', place(box(0.085, 0.11, 0.05, 0.012), x, -0.08, 0.15), GEAR_BLACK);
  }
  for (const side of [1, -1]) {
    add('gear', 'chest', place(box(0.07, 0.03, 0.27, 0.01), side * 0.12, 0.2, 0), CHARCOAL);
    add('cloth', 'chest', place(ellipsoid(0.072, 1, 0.9, 1), side * D.shoulderX, 0.135, 0), NAVY);
  }
  // Shoulder radio with a status LED.
  add('gear', 'chest', place(box(0.045, 0.08, 0.03, 0.008), 0.11, 0.17, 0.145), GEAR_BLACK);
  add('metal', 'chest', place(cylY(0.004, 0.004, 0.07, 5), 0.125, 0.24, 0.145), GUN_DARK);
  add('glow', 'chest', place(box(0.012, 0.012, 0.006, 0.002), 0.11, 0.2, 0.162), LED_RED, false);
  add('cloth', 'chest', place(cylY(0.075, 0.085, 0.06, 12), 0, 0.2, 0), NAVY_DARK);
  // Neck and head.
  add('skin', 'neck', place(cylY(0.05, 0.056, 0.12, 10), 0, 0.02, 0.005), SKIN);
  add('skin', 'head', place(ellipsoid(0.1, 0.92, 1.1, 1.02), 0, 0.1, 0.01), SKIN);
  add('skin', 'head', place(ellipsoid(0.02, 0.75, 1, 0.9), 0, 0.085, 0.108), SKIN);
  add('skin', 'head', place(box(0.11, 0.05, 0.08, 0.02), 0, 0.03, 0.05), SKIN);
  add('gear', 'head', place(box(0.15, 0.03, 0.03, 0.01), 0, 0.125, 0.085), GEAR_BLACK);
  add('gear', 'head', place(box(0.05, 0.022, 0.012, 0.004), -0.035, 0.126, 0.101), [0.02, 0.025, 0.03]);
  add('gear', 'head', place(box(0.05, 0.022, 0.012, 0.004), 0.035, 0.126, 0.101), [0.02, 0.025, 0.03]);
  // Helmet: dome, rim and side rails.
  const dome = new SphereGeometry(0.128, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
  add('gear', 'head', place(dome, 0, 0.12, 0.0, 0, 0, 0, [1, 0.95, 1.08]), NAVY_DARK);
  add('gear', 'head', place(cylY(0.13, 0.133, 0.02, 16), 0, 0.12, 0.0, 0, 0, 0, [1, 1, 1.08]), GEAR_BLACK);
  for (const side of [1, -1]) {
    add('gear', 'head', place(box(0.012, 0.035, 0.11, 0.004), side * 0.128, 0.13, 0), GEAR_BLACK);
    add('gear', 'head', place(box(0.01, 0.1, 0.012, 0.003), side * 0.085, 0.06, 0.04, 0.25 * side, 0, 0), GEAR_BLACK);
  }
  // Arms (sleeves, cuffs, gloves).
  for (const name of ['L', 'R']) {
    add('cloth', 'upper' + name, place(capsule(0.058, 0.19), 0, -0.14, 0), NAVY);
    add('cloth', 'fore' + name, place(capsule(0.048, 0.16, 8), 0, -0.12, 0), NAVY);
    add('gear', 'fore' + name, place(cylY(0.05, 0.05, 0.03, 8), 0, -0.22, 0), NAVY_DARK);
    add('gear', 'hand' + name, place(box(0.07, 0.1, 0.045, 0.018), 0, -0.05, 0), GEAR_BLACK);
    add('gear', 'hand' + name, place(box(0.025, 0.05, 0.03, 0.01), 0.03, -0.03, 0.03), GEAR_BLACK);
  }
  // Legs (cargo trousers, knee pads, boots).
  for (const [name, side] of [
    ['L', 1],
    ['R', -1]
  ] as const) {
    add('cloth', 'thigh' + name, place(capsule(0.078, 0.28), 0, -0.21, 0), NAVY);
    add('cloth', 'thigh' + name, place(box(0.03, 0.12, 0.1, 0.012), side * 0.08, -0.24, 0.0), NAVY_DARK);
    add('cloth', 'shin' + name, place(capsule(0.062, 0.29, 8), 0, -0.2, 0), NAVY);
    add('gear', 'shin' + name, place(box(0.1, 0.11, 0.05, 0.02), 0, -0.02, 0.06), GEAR_BLACK);
    add('gear', 'foot' + name, place(box(0.11, 0.11, 0.25, 0.03), 0, -0.02, 0.045), BOOT);
    add('gear', 'foot' + name, place(box(0.115, 0.025, 0.26, 0.008), 0, -0.07, 0.045), [0.03, 0.03, 0.03]);
  }
  addCarbine(rig, 'gun');
  return rig.build(['cloth', 'gear', 'skin', 'metal', 'glow', 'lens']);
}

/** Adds the carbine (rifle space: +Z barrel, origin above the pistol grip) to `bone`. */
function addCarbine(rig: RigBuilder, bone: string): void {
  rig.add('metal', bone, place(box(0.05, 0.07, 0.3, 0.008), 0, 0.03, 0.08), GUN_DARK);
  rig.add('metal', bone, place(box(0.058, 0.062, 0.21, 0.01), 0, 0.035, 0.33), GUN_DARK);
  rig.add('metal', bone, place(cylZ(0.011, 0.011, 0.16, 8), 0, 0.045, 0.49), GUN_MID);
  rig.add('metal', bone, place(cylZ(0.016, 0.016, 0.035, 8), 0, 0.045, 0.555), GUN_DARK);
  rig.add('metal', bone, place(box(0.028, 0.15, 0.065, 0.006), 0, -0.07, 0.13, 0.2, 0, 0), GUN_DARK);
  rig.add('gear', bone, place(box(0.03, 0.1, 0.042, 0.008), 0, -0.04, -0.03, -0.3, 0, 0), GEAR_BLACK);
  rig.add('gear', bone, place(box(0.042, 0.085, 0.19, 0.012), 0, 0.005, -0.2), GEAR_BLACK);
  rig.add('metal', bone, place(cylZ(0.013, 0.013, 0.11, 8), 0, 0.035, -0.08), GUN_DARK);
  rig.add('metal', bone, place(box(0.034, 0.045, 0.1, 0.006), 0, 0.09, 0.07), GUN_DARK);
  rig.add('metal', bone, place(cylZ(0.019, 0.019, 0.025, 10), 0, 0.093, 0.125), GUN_MID);
  rig.add('metal', bone, place(cylZ(0.016, 0.016, 0.08, 10), 0.042, 0.035, 0.38), GUN_DARK);
  rig.add('lens', bone, place(cylZ(0.014, 0.014, 0.006, 10), 0.042, 0.035, 0.422), LENS_WHITE, false);
}

/** The carbine alone on a single 'gun' bone, held by the animated character's right hand. */
export function buildGuardGunDef(): RigDef {
  const rig = new RigBuilder();
  rig.bone('gun', null, 0, 0, 0);
  addCarbine(rig, 'gun');
  return rig.build(['gear', 'metal', 'lens']);
}

/** Engage sub-states: run to cover, crouch in cover, shoulder the rifle, fire, radio, fall back. */
export type GuardEngageState = 'move' | 'cover' | 'aim' | 'fire' | 'radio';

/** A guard instance. */
export interface GuardEnemy extends Enemy {
  type: 'guard';
  speed: number;
  yawRate: number;
  wantYaw: number;
  goal: Vector3;
  firePos: Vector3;
  firePlayer: Vector3;
  /** Head centre (headshot sphere), refreshed every pose. */
  headPos: Vector3;
  chestPos: Vector3;
  hipsPos: Vector3;
  push: Vector3;
  modeSeen: string;
  es: GuardEngageState;
  esT: number;
  cool: number;
  shots: number;
  shotIndex: number;
  bursts: number;
  /** Bursts fired in the current volley. */
  volley: number;
  path: Vector3[] | null;
  wp: number;
  planT: number;
  hasGoal: boolean;
  waitT: number;
  moveT: number;
  stuckT: number;
  feelT: number;
  blocked: boolean;
  patrolR: number;
  patrolLine: Vector3[] | null;
  patrolI: number;
  /** The current fire position hides a kneeling guard from the player. */
  coverHidden: boolean;
  /** Gait phase (radians) and the half-cycle index used for footstep events. */
  gait: number;
  stepIdx: number;
  /** Kneel blend (0 standing .. 1 kneeling) and target. */
  crouch: number;
  /** Rifle raise blend (0 low ready .. 1 shouldered). */
  aim: number;
  aimPitch: number;
  /** Torso twist toward the aim target, relative to the body. */
  twist: number;
  lookYaw: number;
  lookPitch: number;
  recoil: number;
  /** Hit-reaction springs: torso pitch / roll and head snap. */
  fP: Spring;
  fR: Spring;
  hS: Spring;
  /** Seconds of hit stagger left. */
  stagger: number;
  radioed: boolean;
  retreating: boolean;
  /** Showcase hold pose (stand still, aim at the player). */
  hold: { aim: number; crouch: number } | null;
  /** Death: +1 falls forward, -1 backward; sideways twist; resting bounce. */
  dieDir: number;
  dieTwist: number;
  landed: boolean;
  sink: number;
  prevSpeed: number;
  maxSpeed: number;
}

const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpDir = new Vector3();
const tmpGunPos = new Vector3();
const tmpTarget = new Vector3();
const tmpElbow = new Vector3();
const tmpN = new Vector3();
const tmpPole = new Vector3();
const tmpU = new Vector3();
const tmpF = new Vector3();
const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const tmpGunQ = new Quaternion();
const tmpEuler = new Euler();
const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);
const HAND_R_Q = new Quaternion().setFromUnitVectors(DOWN, new Vector3(0, -0.85, 0.5).normalize());
const HAND_L_Q = new Quaternion().setFromUnitVectors(DOWN, new Vector3(0.3, 0.2, 1).normalize());
const SHOULDER_L = new Vector3(D.shoulderX, D.shoulderY, 0);
const SHOULDER_R = new Vector3(-D.shoulderX, D.shoulderY, 0);
const POLE_L = new Vector3(0.8, -1, -0.2);
const POLE_R = new Vector3(-0.8, -1, -0.3);

function stepSpring(spring: Spring, target: number, k: number, damping: number, dt: number): number {
  spring.v += ((target - spring.x) * k - spring.v * damping) * dt;
  spring.x += spring.v * dt;
  return spring.x;
}

const smooth01 = (t: number) => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};

/** Creates pooled guard number `index` (inactive until spawned). */
export function createGuard(
  ctx: EnemyContext,
  def: RigDef,
  mats: EnemyMaterials,
  index: number,
  asset: GuardAsset | null = null,
  gunDef: RigDef | null = null
): GuardEnemy {
  const game = ctx.G;
  const rng = ctx.rng;
  const lensMat = mats.lensBase.clone() as MeshBasicMaterial;
  // Animated character (loaded model) when available, otherwise the procedural rig.
  const model = asset && gunDef ? createGuardModel(asset) : null;
  let rig: SkinnedRig;
  let gunBone: Bone;
  let gunKick: Object3D | null = null;
  if (model && gunDef) {
    const gunRig = createSkinnedRig(
      gunDef,
      { gear: mats.gear, metal: mats.metal, lens: lensMat },
      { radius: 0.5, center: [0, 0, 0.15] }
    );
    model.gunMount.add(gunRig.group);
    gunBone = gunRig.bones.gun;
    gunKick = gunRig.group;
    rig = {
      group: model.group,
      mesh: model.mesh,
      bones: model.bones,
      skeleton: model.mesh.skeleton,
      extraMesh: null
    };
  } else {
    rig = createSkinnedRig(
      def,
      {
        cloth: mats.cloth,
        gear: mats.gear,
        skin: mats.skin,
        metal: mats.metal,
        glow: mats.glow,
        lens: lensMat
      },
      {
        radius: 1.3,
        center: [0, 0.9, 0]
      }
    );
    gunBone = rig.bones.gun;
  }
  rig.group.visible = false;
  const bones = rig.bones;
  /** Leg capsule bones (hip, knee, ankle) per side for the active body. */
  const legBones = model
    ? [
        ['LeftUpLeg', 'LeftLeg', 'LeftFoot'],
        ['RightUpLeg', 'RightLeg', 'RightFoot']
      ]
    : [
        ['thighL', 'shinL', 'footL'],
        ['thighR', 'shinR', 'footR']
      ];
  // Death clip state for the animated body.
  let deathAction: AnimationAction | null = null;
  let deathFade = 0;
  const loopWeights: Record<GuardLoopClip, number> = {
    idle: 1,
    aim: 0,
    walk: 0,
    run: 0,
    crouch: 0,
    crouchAim: 0
  };
  if (!model) {
    // "SECURITY" print on the back of the plate carrier.
    const label = game.mats.label('SECURITY', {
      color: 'white',
      font: 'sans',
      distress: 0.25
    });
    const labelWidth = 0.26;
    const labelHeight = Math.min(0.07, labelWidth / (label.aspect || 4));
    const labelGeo = new PlaneGeometry(labelWidth, labelHeight);
    labelGeo.rotateY(Math.PI);
    labelGeo.translate(0, 0.15, -0.137);
    const labelMesh = new Mesh(labelGeo, label.material);
    labelMesh.castShadow = false;
    labelMesh.receiveShadow = true;
    bones.chest.add(labelMesh);
  }
  void index;

  const guard: GuardEnemy = {
    id: 0,
    type: 'guard',
    pos: rig.group.position,
    alive: false,
    active: false,
    hp: CFG.hp,
    rig,
    lens: lensMat,
    yaw: 0,
    speed: 0,
    yawRate: 0,
    wantYaw: 0,
    home: new Vector3(),
    lastKnown: new Vector3(),
    goal: new Vector3(),
    firePos: new Vector3(),
    firePlayer: new Vector3(),
    sensor: new Vector3(),
    fwd: new Vector3(0, 0, 1),
    muzzle: new Vector3(),
    headPos: new Vector3(),
    chestPos: new Vector3(),
    hipsPos: new Vector3(),
    push: new Vector3(),
    mode: 'patrol',
    modeSeen: 'patrol',
    los: false,
    seeT: 0,
    noSeeT: 0,
    senseT: 0,
    exposure: 0,
    modeT: 0,
    passive: false,
    hasToken: false,
    flare: 0,
    lensC: [GUARD_LIGHT_IDLE[0], GUARD_LIGHT_IDLE[1], GUARD_LIGHT_IDLE[2]],
    smokeT: 0,
    phase: 0,
    dieT: 0,
    loop: null,
    es: 'move',
    esT: 0,
    cool: 1,
    shots: 0,
    shotIndex: 0,
    bursts: 0,
    volley: 0,
    path: null,
    wp: 0,
    planT: 0,
    hasGoal: false,
    waitT: 0,
    moveT: 0,
    stuckT: 0,
    feelT: 0,
    blocked: false,
    patrolR: 8,
    patrolLine: null,
    patrolI: 0,
    coverHidden: false,
    gait: 0,
    stepIdx: 0,
    crouch: 0,
    aim: 0,
    aimPitch: 0,
    twist: 0,
    lookYaw: 0,
    lookPitch: 0,
    recoil: 0,
    fP: { x: 0, v: 0 },
    fR: { x: 0, v: 0 },
    hS: { x: 0, v: 0 },
    stagger: 0,
    hold: null,
    radioed: false,
    retreating: false,
    dieDir: -1,
    dieTwist: 0,
    landed: false,
    sink: 0,
    prevSpeed: 0,
    maxSpeed: 0,
    damage(amount, point, dir, part) {
      if (!guard.alive) {
        return false;
      }
      const head = part === 'weak';
      if (head) {
        amount *= CFG.headMult;
      }
      guard.hp -= amount;
      game.events.emit('enemy:hit', {
        enemy: guard,
        point,
        part: part || 'body'
      });
      if (dir) {
        const cosYaw = Math.cos(guard.yaw);
        const sinYaw = Math.sin(guard.yaw);
        const strength = Math.min(1.5, amount / 26);
        const hitFwd = dir.x * sinYaw + dir.z * cosYaw;
        const hitSide = dir.x * cosYaw - dir.z * sinYaw;
        guard.fP.v += hitFwd * 5 * strength;
        guard.fR.v -= hitSide * 5 * strength;
        if (head) {
          guard.hS.v += (hitFwd >= 0 ? 1 : -1) * 12;
        }
      }
      guard.stagger = Math.max(guard.stagger, head ? 0.5 : 0.3);
      ctx.provoke(guard);
      if (guard.hp <= 0) {
        die(dir, head);
        return true;
      }
      if (guard.mode === 'engage' && (guard.es === 'aim' || guard.es === 'fire') && rng() < CFG.flinch) {
        ctx.releaseToken(guard);
        guard.es = 'cover';
        guard.esT = 0;
        guard.cool = Math.max(guard.cool, 0.7 + rng() * 0.6);
      }
      return false;
    },
    _activate(pos, opts = {}) {
      guard.active = true;
      guard.alive = true;
      guard.hp = CFG.hp;
      guard.passive = !!opts.passive;
      guard.hold = opts.hold ?? null;
      guard.pos.copy(pos);
      guard.pos.y = game.physics.groundHeight(pos.x, pos.z, pos.y + 1);
      guard.home.copy(guard.pos);
      guard.yaw = opts.yaw ?? rng() * 6.283;
      guard.wantYaw = guard.yaw;
      guard.speed = 0;
      guard.yawRate = 0;
      guard.push.set(0, 0, 0);
      guard.mode = opts.state === 'alert' ? 'investigate' : 'patrol';
      guard.modeT = 10;
      guard.modeSeen = guard.mode;
      guard.lastKnown.copy(opts.target || (game.player ? game.player.pos : pos));
      guard.los = false;
      guard.seeT = guard.noSeeT = 0;
      guard.exposure = 0;
      guard.senseT = rng() * 0.2;
      guard.hasToken = false;
      guard.patrolR = opts.patrolRadius ?? 8;
      guard.patrolLine = opts.patrolLine || null;
      guard.patrolI = 0;
      guard.es = 'move';
      guard.cool = 0.8 + rng();
      guard.path = null;
      guard.hasGoal = false;
      guard.waitT = rng() * 1.5;
      guard.planT = 0;
      guard.feelT = 0;
      guard.blocked = false;
      guard.coverHidden = false;
      guard.gait = rng() * 6.283;
      guard.stepIdx = Math.floor(guard.gait / Math.PI);
      guard.crouch = 0;
      guard.aim = guard.mode === 'patrol' ? 0 : 0.5;
      guard.aimPitch = 0;
      guard.twist = 0;
      guard.lookYaw = guard.lookPitch = 0;
      guard.recoil = 0;
      guard.stagger = 0;
      guard.radioed = false;
      guard.retreating = false;
      guard.flare = 0;
      guard.phase = rng() * 6.283;
      guard.dieT = 0;
      guard.landed = false;
      guard.sink = 0;
      for (const spring of [guard.fP, guard.fR, guard.hS]) {
        spring.x = 0;
        spring.v = 0;
      }
      rig.group.visible = true;
      if (model) {
        resetGuardModel(model, rng());
        deathAction = null;
        deathFade = 0;
      }
      pose(0.016);
    },
    _deactivate() {
      guard.active = false;
      guard.alive = false;
      rig.group.visible = false;
      ctx.releaseToken(guard);
    },
    _raycast(origin, dir, maxDist, hit) {
      let didHit = false;
      if (raySphereHit(origin, dir, guard.headPos, 0.13, maxDist, hit)) {
        hit.part = 'weak';
        hit.enemy = guard;
        didHit = true;
      }
      if (rayCapsuleHit(origin, dir, guard.hipsPos, guard.chestPos, 0.2, maxDist, hit)) {
        hit.part = 'body';
        hit.enemy = guard;
        didHit = true;
      }
      for (const [hipBone, kneeBone, ankleBone] of legBones) {
        tmpA.setFromMatrixPosition(bones[hipBone].matrixWorld);
        tmpB.setFromMatrixPosition(bones[kneeBone].matrixWorld);
        if (rayCapsuleHit(origin, dir, tmpA, tmpB, 0.095, maxDist, hit)) {
          hit.part = 'body';
          hit.enemy = guard;
          didHit = true;
        }
        tmpA.setFromMatrixPosition(bones[ankleBone].matrixWorld);
        if (rayCapsuleHit(origin, dir, tmpB, tmpA, 0.075, maxDist, hit)) {
          hit.part = 'body';
          hit.enemy = guard;
          didHit = true;
        }
      }
      return didHit;
    },
    _update(dt) {
      if (guard.alive) {
        updateAlive(dt);
      } else {
        updateDead(dt);
      }
    }
  };

  function setGoal(target: Vector3, force?: boolean): void {
    if (!force && guard.hasGoal && guard.goal.distanceToSquared(target) < 0.25) {
      return;
    }
    guard.goal.copy(target);
    guard.hasGoal = true;
    guard.planT = 0;
    guard.stuckT = 0;
  }

  function replan(): void {
    guard.planT = CFG.replan + rng() * 0.15;
    let path: Vector3[] | null = null;
    try {
      path = game.physics.nav.findPath(guard.pos, guard.goal);
    } catch {
      path = null;
    }
    guard.path = path && path.length ? path : null;
    guard.wp = 0;
    if (guard.path && guard.path.length > 1 && guard.path[0].distanceToSquared(guard.pos) < 0.36) {
      guard.wp = 1;
    }
  }

  /** Steers along the current path; returns true when there is no goal or it was reached. */
  function followPath(dt: number, speed: number): boolean {
    if (!guard.hasGoal) {
      guard.maxSpeed = 0;
      return true;
    }
    guard.planT -= dt;
    if (guard.planT <= 0) {
      replan();
    }
    let waypoint = guard.goal;
    if (guard.path) {
      while (
        guard.wp < guard.path.length - 1 &&
        Math.hypot(guard.path[guard.wp].x - guard.pos.x, guard.path[guard.wp].z - guard.pos.z) < 0.5
      ) {
        guard.wp++;
      }
      waypoint = guard.path[Math.min(guard.wp, guard.path.length - 1)];
    }
    const goalDist = Math.hypot(guard.goal.x - guard.pos.x, guard.goal.z - guard.pos.z);
    if (goalDist < 0.4) {
      guard.hasGoal = false;
      guard.maxSpeed = 0;
      return true;
    }
    guard.wantYaw = Math.atan2(waypoint.x - guard.pos.x, waypoint.z - guard.pos.z);
    const turnNeeded = Math.abs(angleDelta(guard.wantYaw, guard.yaw));
    guard.maxSpeed =
      turnNeeded > 1.4 ? 0.3 : Math.min(speed * (1 - turnNeeded * 0.4), 0.5 + goalDist * 2.4);
    return false;
  }

  /**
   * Picks a fire position: level cover points and random spots in rifle range, preferring
   * ones that hide a kneeling guard but let a standing one see the player. `retreat` prefers
   * spots farther from the player.
   */
  function pickCover(retreat = false): void {
    const player = game.player;
    if (!player) {
      return;
    }
    const playerEye = player.eye || player.pos;
    const curDist = Math.hypot(guard.pos.x - player.pos.x, guard.pos.z - player.pos.z);
    const minRange = retreat ? Math.max(CFG.rangeMin, curDist + 4) : CFG.rangeMin;
    const maxRange = retreat ? CFG.rangeMax + 10 : CFG.rangeMax;
    let bestScore = Infinity;
    let bestHidden = false;
    let found = false;
    const consider = (candidate: Vector3, bias: number) => {
      const distToPlayer = Math.hypot(candidate.x - player.pos.x, candidate.z - player.pos.z);
      if (
        distToPlayer < minRange ||
        distToPlayer > maxRange ||
        (game.physics.nav.isWalkable && !game.physics.nav.isWalkable(candidate.x, candidate.z))
      ) {
        return;
      }
      let score =
        Math.hypot(candidate.x - guard.pos.x, candidate.z - guard.pos.z) * (retreat ? 0.3 : 0.7) +
        bias +
        rng() * 2.5 -
        (retreat ? distToPlayer * 0.5 : -distToPlayer * CFG.advance);
      for (const other of ctx.list) {
        if (other === guard || !other.alive || other.type !== 'guard') {
          continue;
        }
        const otherSpot = other.mode === 'engage' && other.es === 'move' ? other.firePos : other.pos;
        if (Math.hypot(candidate.x - otherSpot.x, candidate.z - otherSpot.z) < 2.5) {
          score += 12;
        }
      }
      if (score - 8 >= bestScore) {
        return;
      }
      tmpA.set(candidate.x, candidate.y + 0.85, candidate.z);
      const hidden = !game.physics.lineOfSight(tmpA, playerEye);
      tmpA.y = candidate.y + 1.55;
      const peek = game.physics.lineOfSight(tmpA, playerEye);
      if (hidden && peek) {
        score -= 8;
      } else if (hidden) {
        score -= 1;
      } else if (!peek) {
        score += 20;
      }
      if (score < bestScore) {
        bestScore = score;
        bestHidden = hidden && peek;
        found = true;
        guard.firePos.set(candidate.x, candidate.y, candidate.z);
      }
    };
    const coverPoints = game.level && game.level.coverPoints;
    if (coverPoints) {
      for (let i = 0; i < coverPoints.length; i++) {
        consider(coverPoints[i], -2);
      }
    }
    for (let i = 0; i < 6; i++) {
      const point = game.physics.nav.randomPoint(player.pos, maxRange);
      if (point) {
        consider(point, 0);
      }
    }
    const awayAngle = Math.atan2(guard.pos.z - player.pos.z, guard.pos.x - player.pos.x);
    for (let i = 0; i < 5; i++) {
      const angle = awayAngle + (rng() - 0.5) * 2.4;
      const radius = minRange + 1 + rng() * Math.max(1, maxRange - minRange - 2);
      tmpB.set(player.pos.x + Math.cos(angle) * radius, player.pos.y, player.pos.z + Math.sin(angle) * radius);
      tmpB.y = game.physics.groundHeight(tmpB.x, tmpB.z, player.pos.y + 1);
      consider(tmpB, 1);
    }
    if (!found) {
      guard.firePos.copy(guard.pos);
    }
    guard.coverHidden = found && bestHidden;
    guard.firePlayer.copy(player.pos);
    setGoal(guard.firePos, true);
    guard.es = 'move';
    guard.esT = 0;
    guard.moveT = 0;
    guard.bursts = 0;
  }

  /** Counts living, non-passive allies within the support radius. */
  function alliesNear(): number {
    let count = 0;
    for (const other of ctx.list) {
      if (
        other !== guard &&
        other.alive &&
        !other.passive &&
        other.pos.distanceToSquared(guard.pos) < CFG.supportRadius * CFG.supportRadius
      ) {
        count++;
      }
    }
    return count;
  }

  function startRetreat(): void {
    guard.retreating = true;
    ctx.releaseToken(guard);
    if (!guard.radioed && alliesNear() > 0) {
      guard.es = 'radio';
      guard.esT = 1.5;
    } else {
      pickCover(true);
    }
  }

  function updateAlive(dt: number): void {
    const player = game.player;
    guard.fwd.set(Math.sin(guard.yaw), 0, Math.cos(guard.yaw));
    guard.sensor.set(guard.pos.x, guard.pos.y + 1.6, guard.pos.z);
    ctx.think(guard, dt, CFG.reactTime);
    if (guard.mode !== guard.modeSeen) {
      guard.modeSeen = guard.mode;
      guard.hasGoal = false;
      guard.path = null;
      guard.waitT = 0;
      if (guard.mode === 'engage') {
        pickCover();
      } else if (guard.es === 'aim' || guard.es === 'fire') {
        ctx.releaseToken(guard);
        guard.es = 'move';
      }
    }
    guard.maxSpeed = 0;
    guard.cool -= dt;
    guard.stagger = Math.max(0, guard.stagger - dt);
    let aimTarget: Vector3 | null = null;
    let lookTarget: Vector3 | null = null;
    let crouchTarget = 0;
    let aimWant = 0;
    let moveSpeed = CFG.walkSpeed;
    const playerDist = player
      ? Math.hypot(player.pos.x - guard.pos.x, player.pos.z - guard.pos.z)
      : 1e9;
    if (guard.mode === 'patrol') {
      if (guard.hasGoal) {
        if (followPath(dt, CFG.walkSpeed)) {
          guard.waitT = 2 + rng() * 3;
        }
      } else {
        guard.waitT -= dt;
        guard.wantYaw = guard.yaw;
        if (guard.waitT <= 0) {
          if (guard.patrolLine) {
            guard.patrolI = (guard.patrolI + 1) % guard.patrolLine.length;
            setGoal(guard.patrolLine[guard.patrolI], true);
          } else {
            const point = game.physics.nav.randomPoint(guard.home, guard.patrolR);
            if (point) {
              setGoal(point, true);
            } else {
              guard.waitT = 1;
            }
          }
        }
      }
    } else if (guard.mode === 'investigate' || guard.mode === 'search') {
      aimWant = 0.55;
      lookTarget = guard.lastKnown;
      const dist = Math.hypot(guard.lastKnown.x - guard.pos.x, guard.lastKnown.z - guard.pos.z);
      if (dist > 2.2) {
        setGoal(guard.lastKnown);
        moveSpeed = dist < 9 ? CFG.stalkSpeed : CFG.runSpeed;
        followPath(dt, moveSpeed);
      } else {
        guard.hasGoal = false;
        guard.phase += dt * 0.8;
        guard.wantYaw = guard.yaw + Math.sin(guard.phase) * 0.9;
        lookTarget = null;
      }
    } else if (player) {
      aimTarget = player.pos;
      lookTarget = player.pos;
      const playerYaw = Math.atan2(player.pos.x - guard.pos.x, player.pos.z - guard.pos.z);
      if (
        !guard.retreating &&
        guard.hp < CFG.hp * CFG.retreatBelow &&
        guard.es !== 'fire'
      ) {
        startRetreat();
      }
      switch (guard.es) {
        case 'move': {
          aimWant = 0.3;
          guard.moveT += dt;
          const arrived = followPath(dt, CFG.runSpeed);
          if (guard.hasGoal && guard.maxSpeed < 0.6) {
            aimWant = 0.7;
          }
          const inRange = playerDist > CFG.rangeMin - 2 && playerDist < CFG.rangeMax + 3;
          if (arrived || guard.moveT > 8) {
            guard.es = 'cover';
            guard.esT = 0;
            guard.hasGoal = false;
          } else if (
            !guard.retreating &&
            guard.moveT > 1.5 &&
            guard.los &&
            inRange &&
            rng() < dt * 0.4
          ) {
            // Opportunistic stop: engage from where he stands.
            guard.coverHidden = false;
            guard.es = 'cover';
            guard.esT = 0;
            guard.hasGoal = false;
          } else if (!guard.retreating && player.pos.distanceToSquared(guard.firePlayer) > 49) {
            pickCover();
          }
          break;
        }
        case 'cover': {
          guard.wantYaw = playerYaw;
          guard.esT += dt;
          crouchTarget = 1;
          aimWant = 0.45;
          const close = playerDist < 4;
          if (close && guard.cool > 0.25) {
            guard.cool = 0.25;
          }
          if (
            guard.cool <= 0 &&
            player.alive &&
            (guard.los || close || guard.noSeeT < CFG.suppressTime) &&
            guard.stagger <= 0 &&
            ctx.requestToken(guard)
          ) {
            guard.es = 'aim';
            guard.esT = close ? CFG.telegraph * 0.45 : CFG.telegraph;
            game.events.emit('enemy:telegraph', {
              enemy: guard,
              type: 'guard',
              time: guard.esT,
              pos: guard.pos
            });
          } else if (
            (playerDist < CFG.rangeMin - 3 && guard.esT > 1.2 && !close) ||
            (guard.noSeeT > 2 && guard.esT > 2) ||
            guard.esT > 7
          ) {
            pickCover();
          }
          break;
        }
        case 'aim': {
          guard.wantYaw = playerYaw;
          crouchTarget = guard.coverHidden ? 0 : 1;
          aimWant = 1;
          guard.esT -= dt;
          if (guard.esT <= 0 && guard.aim > 0.85 && Math.abs(angleDelta(playerYaw, guard.yaw)) < 0.35) {
            guard.es = 'fire';
            guard.shots = burstRounds();
            guard.shotIndex = 0;
            guard.volley = 0;
            guard.esT = 0;
          } else if (guard.noSeeT > CFG.suppressTime && playerDist > 4) {
            ctx.releaseToken(guard);
            guard.es = 'cover';
            guard.esT = 0;
          }
          break;
        }
        case 'fire': {
          guard.wantYaw = playerYaw;
          crouchTarget = guard.coverHidden ? 0 : 1;
          aimWant = 1;
          guard.esT -= dt;
          if (guard.esT <= 0 && guard.shots > 0) {
            guard.esT = CFG.burstGap * (0.85 + rng() * 0.3);
            guard.shots--;
            fireShot(player, playerDist);
          }
          if (guard.shots <= 0 && guard.esT <= 0) {
            guard.volley++;
            // Keep the pressure on: another burst while the target is in view (or was just
            // seen, as suppression), then duck back into cover.
            if (
              guard.volley < CFG.volley &&
              player.alive &&
              (guard.los || guard.noSeeT < CFG.suppressTime)
            ) {
              guard.shots = burstRounds();
              guard.shotIndex = Math.floor(guard.shotIndex * 0.3);
              guard.esT = CFG.volleyGap[0] + rng() * (CFG.volleyGap[1] - CFG.volleyGap[0]);
              break;
            }
            ctx.releaseToken(guard);
            guard.cool = CFG.cooldown[0] + rng() * (CFG.cooldown[1] - CFG.cooldown[0]);
            guard.bursts++;
            if (guard.bursts >= 2 + (rng() < 0.35 ? 1 : 0) && !guard.retreating) {
              pickCover();
            } else {
              guard.es = 'cover';
              guard.esT = 0;
            }
          }
          break;
        }
        case 'radio': {
          crouchTarget = 1;
          aimWant = 0.15;
          guard.wantYaw = playerYaw;
          guard.esT -= dt;
          if (guard.esT <= 0) {
            guard.radioed = true;
            game.events.emit('enemy:support', {
              enemy: guard,
              pos: guard.pos,
              type: 'guard'
            });
            ctx.rally(guard.pos, CFG.supportRadius, player.pos, guard);
            pickCover(true);
          }
          break;
        }
      }
      if (guard.es === 'move') {
        moveSpeed = CFG.runSpeed;
      }
    }
    // Turning and speed.
    const yawError = angleDelta(guard.wantYaw, guard.yaw);
    const targetYawRate = clamp(yawError * 8, -CFG.turnRate, CFG.turnRate);
    guard.yawRate += (targetYawRate - guard.yawRate) * (1 - Math.exp(-14 * dt));
    guard.yaw += guard.yawRate * dt;
    const maxSpeed = guard.maxSpeed * (1 - guard.crouch * 0.6) * (guard.stagger > 0 ? 0.5 : 1);
    const accel = maxSpeed > guard.speed ? CFG.accel : -CFG.accel * 1.5;
    guard.prevSpeed = guard.speed;
    guard.speed = clamp(guard.speed + accel * dt, 0, Math.max(maxSpeed, 0));
    if (accel < 0 && guard.speed < maxSpeed) {
      guard.speed = maxSpeed;
    }
    void moveSpeed;
    // Separation from other ground enemies and the player.
    const moveSin = Math.sin(guard.yaw);
    const moveCos = Math.cos(guard.yaw);
    for (const other of ctx.list) {
      if (other === guard || other.type === 'gull' || !other.active || !other.alive) {
        continue;
      }
      const dx = guard.pos.x - other.pos.x;
      const dz = guard.pos.z - other.pos.z;
      const dist = Math.hypot(dx, dz);
      const minDist = other.type === 'hound' ? 1.4 : 0.9;
      if (dist < minDist && dist > 0.001) {
        const pushStrength = ((minDist - dist) * 2.4) / dist;
        guard.push.x += dx * pushStrength * dt * 6;
        guard.push.z += dz * pushStrength * dt * 6;
      }
    }
    if (player && playerDist < 0.9 && playerDist > 0.001) {
      const pushStrength = ((0.9 - playerDist) * 3) / playerDist;
      guard.push.x += (guard.pos.x - player.pos.x) * pushStrength * dt * 6;
      guard.push.z += (guard.pos.z - player.pos.z) * pushStrength * dt * 6;
    }
    guard.push.multiplyScalar(Math.exp(-5 * dt));
    let nextX = guard.pos.x + (moveSin * guard.speed + guard.push.x) * dt;
    let nextZ = guard.pos.z + (moveCos * guard.speed + guard.push.z) * dt;
    const nav = game.physics.nav;
    guard.feelT -= dt;
    if (guard.feelT <= 0 && guard.speed > 0.3) {
      guard.feelT = 0.12;
      tmpA.set(guard.pos.x, guard.pos.y + 0.6, guard.pos.z);
      tmpDir.set(moveSin, 0, moveCos);
      guard.blocked = !!game.physics.raycast(tmpA, tmpDir, 0.45 + guard.speed * 0.1);
    } else if (guard.speed <= 0.3) {
      guard.blocked = false;
    }
    if ((nav.isWalkable && !nav.isWalkable(nextX, nextZ)) || guard.blocked) {
      if (guard.blocked) {
        nextX = guard.pos.x + guard.push.x * dt;
        nextZ = guard.pos.z + guard.push.z * dt;
        guard.yawRate += (guard.phase > 3.14 ? 1 : -1) * 5 * dt;
      } else if (nav.isWalkable(nextX, guard.pos.z)) {
        nextZ = guard.pos.z;
      } else if (nav.isWalkable(guard.pos.x, nextZ)) {
        nextX = guard.pos.x;
      } else {
        nextX = guard.pos.x;
        nextZ = guard.pos.z;
      }
      guard.speed *= 0.6;
      guard.stuckT += dt;
      if (guard.stuckT > 0.5) {
        guard.stuckT = 0;
        guard.planT = 0;
        if (guard.mode === 'engage' && guard.es === 'move') {
          // Can't get through: fight from here instead of re-planning forever.
          guard.coverHidden = false;
          guard.hasGoal = false;
          guard.es = 'cover';
          guard.esT = 0;
        } else if (guard.mode === 'patrol') {
          guard.hasGoal = false;
        }
      }
    }
    guard.pos.x = nextX;
    guard.pos.z = nextZ;
    guard.pos.y +=
      (game.physics.groundHeight(nextX, nextZ, guard.pos.y + 0.6) - guard.pos.y) *
      (1 - Math.exp(-12 * dt));
    // Gait phase and footsteps.
    const strideLen = model
      ? GUARD_STRIDE.walk + (GUARD_STRIDE.run - GUARD_STRIDE.walk) * clamp((guard.speed - 2.4) / 1.6, 0, 1)
      : 1.05 + guard.speed * 0.32;
    guard.gait += (guard.speed / strideLen) * Math.PI * 2 * dt;
    const stepIdx = Math.floor(guard.gait / Math.PI);
    if (stepIdx !== guard.stepIdx) {
      guard.stepIdx = stepIdx;
      if (guard.speed > 0.6) {
        game.events.emit('enemy:step', {
          pos: guard.pos,
          type: 'guard',
          enemy: guard,
          speed: guard.speed
        });
      }
    }
    if (guard.hold && player) {
      // Showcase hold: stand in place and aim at the player.
      aimTarget = player.pos;
      lookTarget = player.pos;
      aimWant = guard.hold.aim;
      crouchTarget = guard.hold.crouch;
      guard.yaw = Math.atan2(player.pos.x - guard.pos.x, player.pos.z - guard.pos.z);
      guard.wantYaw = guard.yaw;
    }
    // Stance / aim blends.
    if (guard.stagger > 0) {
      aimWant = Math.min(aimWant, 0.6);
    }
    if (guard.speed > 0.8) {
      crouchTarget = 0;
    }
    guard.crouch += (crouchTarget - guard.crouch) * (1 - Math.exp(-7 * dt));
    guard.aim += (aimWant - guard.aim) * (1 - Math.exp(-(aimWant > guard.aim ? 9 : 5) * dt));
    const cosYaw = Math.cos(guard.yaw);
    const sinYaw = Math.sin(guard.yaw);
    let twist = 0;
    let pitch = 0;
    if (aimTarget) {
      const dx = aimTarget.x - guard.pos.x;
      const dz = aimTarget.z - guard.pos.z;
      const shoulderY = guard.pos.y + 1.45 - guard.crouch * D.kneelDrop;
      const dy = aimTarget.y + 1.05 - shoulderY;
      twist = clamp(Math.atan2(dx * cosYaw - dz * sinYaw, dx * sinYaw + dz * cosYaw), -0.7, 0.7);
      pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.8, 0.8);
    }
    let lookYaw = 0;
    let lookPitch = 0;
    if (lookTarget) {
      const dx = lookTarget.x - guard.pos.x;
      const dz = lookTarget.z - guard.pos.z;
      const dy = lookTarget.y + 1.5 - (guard.pos.y + 1.6 - guard.crouch * D.kneelDrop);
      lookYaw = clamp(Math.atan2(dx * cosYaw - dz * sinYaw, dx * sinYaw + dz * cosYaw), -1, 1);
      lookPitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -0.5, 0.5);
    } else {
      lookYaw = Math.sin(ctx.t * 0.6 + guard.phase) * (guard.mode === 'patrol' && !guard.hasGoal ? 0.7 : 0.25);
    }
    const blend = 1 - Math.exp(-10 * dt);
    guard.twist += (twist - guard.twist) * blend;
    guard.aimPitch += (pitch - guard.aimPitch) * blend;
    const lookBlend = 1 - Math.exp(-6 * dt);
    guard.lookYaw += (lookYaw - guard.lookYaw) * lookBlend;
    guard.lookPitch += (lookPitch - guard.lookPitch) * lookBlend;
    guard.recoil *= Math.exp(-14 * dt);
    pose(dt);
    // Weapon light.
    const lightTarget = guard.mode === 'engage' ? GUARD_LIGHT_ALERT : GUARD_LIGHT_IDLE;
    // Steady (no flash on firing) so the light is never mistaken for the muzzle.
    for (let i = 0; i < 3; i++) {
      guard.lensC[i] += (lightTarget[i] - guard.lensC[i]) * (1 - Math.exp(-6 * dt));
    }
    lensMat.color.setRGB(guard.lensC[0], guard.lensC[1], guard.lensC[2]);
    guard.flare = Math.max(0, guard.flare - dt * 8);
  }

  /** Rounds in the next burst (the tuned burst, +-1). */
  function burstRounds(): number {
    return Math.max(2, Math.round(CFG.burst) + Math.floor(rng() * 3) - 1);
  }

  function fireShot(player: Player, playerDist: number): void {
    // Out of sight it is suppressive fire at the last known position.
    const aimAt = guard.los ? player.pos : guard.lastKnown;
    tmpTarget.set(aimAt.x, aimAt.y + (player.crouching ? 0.75 : 1.05), aimAt.z);
    guard.muzzle.copy(MUZZLE_LOCAL).applyMatrix4(gunBone.matrixWorld);
    if (
      !Number.isFinite(guard.muzzle.x) ||
      Math.abs(guard.muzzle.x - guard.pos.x) > 2 ||
      Math.abs(guard.muzzle.z - guard.pos.z) > 2
    ) {
      guard.muzzle.set(guard.pos.x, guard.pos.y + 1.45, guard.pos.z);
    }
    tmpDir.copy(tmpTarget).sub(guard.muzzle).normalize();
    const spread =
      (CFG.spreadFar + (CFG.spreadNear - CFG.spreadFar) * guard.exposure) *
      (1 + ctx.playerSpeed * 0.25) *
      (1 + guard.shotIndex * CFG.recoilSpread) *
      (1 + guard.stagger * 2) *
      (1 + playerDist / 80);
    tmpDir.x += (rng() - 0.5) * 2 * spread;
    tmpDir.y += (rng() - 0.5) * 2 * spread;
    tmpDir.z += (rng() - 0.5) * 2 * spread;
    tmpDir.normalize();
    guard.shotIndex++;
    const hit = game.physics.raycast(guard.muzzle, tmpDir, 200);
    const tracerLen = game.combat.enemyShot(guard.muzzle, tmpDir, {
      damage: CFG.shotDamage,
      range: 200
    })
      ? guard.muzzle.distanceTo(tmpTarget)
      : hit
        ? hit.dist
        : 90;
    tmpA.copy(guard.muzzle).addScaledVector(tmpDir, tracerLen);
    game.fx.tracer(guard.muzzle, tmpA, {
      color: 0xffe0a0,
      speed: 300,
      width: 0.025
    });
    game.fx.muzzleFlash(guard.muzzle, tmpDir, {
      scale: 0.65
    });
    if (game.render && game.render.lightPool) {
      game.render.lightPool.flash(guard.muzzle, 0xffc080, 16, 6, 0.04);
    }
    // Brass out of the ejection port, to the guard's right.
    tmpA.copy(PORT_LOCAL).applyMatrix4(gunBone.matrixWorld);
    tmpB.set(-Math.cos(guard.yaw) * 2.2, 1.6, Math.sin(guard.yaw) * 2.2);
    game.fx.shell(tmpA, tmpB);
    game.events.emit('enemy:fire', {
      enemy: guard,
      pos: guard.muzzle,
      dir: tmpDir,
      type: 'guard'
    });
    guard.recoil = Math.min(1.6, guard.recoil + 1);
    guard.flare = 1;
  }

  /** Two-bone arm IK in chest space: puts the wrist of arm `name` on `target`. */
  function solveArm(name: 'L' | 'R', shoulder: Vector3, target: Vector3, pole: Vector3, handQ: Quaternion): void {
    tmpN.copy(target).sub(shoulder);
    let dist = tmpN.length();
    tmpN.divideScalar(dist || 1);
    const l1 = D.upper;
    const l2 = D.fore;
    dist = clamp(dist, Math.abs(l1 - l2) + 0.02, (l1 + l2) * 0.999);
    const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    tmpPole.copy(pole).addScaledVector(tmpN, -pole.dot(tmpN));
    if (tmpPole.lengthSq() < 1e-6) {
      tmpPole.set(0, -1, 0);
    }
    tmpPole.normalize();
    tmpU.copy(tmpN).multiplyScalar(cosA).addScaledVector(tmpPole, sinA);
    tmpElbow.copy(shoulder).addScaledVector(tmpU, l1);
    tmpF.copy(shoulder).addScaledVector(tmpN, dist).sub(tmpElbow).normalize();
    const upper = bones['upper' + name];
    const fore = bones['fore' + name];
    const hand = bones['hand' + name];
    upper.quaternion.setFromUnitVectors(DOWN, tmpU);
    tmpQ.setFromUnitVectors(DOWN, tmpF);
    fore.quaternion.copy(upper.quaternion).invert().multiply(tmpQ);
    tmpQ2.copy(tmpQ).invert().multiply(handQ);
    hand.quaternion.copy(tmpQ2);
  }

  function pose(dt: number): void {
    if (model) {
      poseModel(dt);
    } else {
      poseRig(dt);
    }
  }

  /** Rotates `bone` by `angle` about a world-space `axis` (applied on top of its animated pose). */
  function rotateWorld(bone: Object3D, axis: Vector3, angle: number): void {
    if (Math.abs(angle) < 1e-5 || !bone.parent) {
      return;
    }
    bone.parent.getWorldQuaternion(tmpQ);
    tmpQ2.setFromAxisAngle(axis, angle);
    bone.quaternion.premultiply(tmpQ).premultiply(tmpQ2).premultiply(tmpQ.invert());
  }

  /**
   * Animated body: blends the stance / locomotion clips (walk and run are foot-locked to the
   * gait phase), plays the death clip, then layers the aim twist and pitch, hit flinch, head
   * look and recoil on top.
   */
  function poseModel(dt: number): void {
    const m = model!;
    if (dt > 0) {
      stepSpring(guard.fP, 0, 90, 9, dt);
      stepSpring(guard.fR, 0, 90, 9, dt);
      stepSpring(guard.hS, 0, 120, 10, dt);
    }
    rig.group.rotation.y = guard.yaw;
    if (guard.alive) {
      const moving = clamp((guard.speed - 0.15) / 0.9, 0, 1);
      const running = clamp((guard.speed - 2.4) / 1.6, 0, 1);
      const c = guard.crouch;
      const a = guard.aim;
      const stand = 1 - moving;
      loopWeights.idle = stand * (1 - c) * (1 - a);
      loopWeights.aim = stand * (1 - c) * a;
      loopWeights.crouch = stand * c * (1 - a);
      loopWeights.crouchAim = stand * c * a;
      loopWeights.walk = moving * (1 - running);
      loopWeights.run = moving * running;
      const cycle = guard.gait / (Math.PI * 2);
      const phase = cycle - Math.floor(cycle);
      m.loops.walk.time = phase * m.loops.walk.getClip().duration;
      m.loops.run.time = phase * m.loops.run.getClip().duration;
    } else if (deathAction) {
      deathFade = Math.min(1, deathFade + dt / 0.18);
      deathAction.setEffectiveWeight(deathFade);
    }
    const keep = 1 - deathFade;
    for (const name of Object.keys(loopWeights) as GuardLoopClip[]) {
      m.loops[name].setEffectiveWeight(loopWeights[name] * keep);
    }
    m.mixer.update(dt);
    // Procedural layers on top of the clips.
    const alive = guard.alive;
    const live = alive ? 1 : 1 - deathFade;
    const yaw = guard.yaw;
    const aimW = guard.aim * live;
    tmpU.set(0, 1, 0);
    const twist = guard.twist * live;
    rotateWorld(bones.Spine, tmpU, twist * 0.3);
    rotateWorld(bones.Spine1, tmpU, twist * 0.3);
    rotateWorld(bones.Spine2, tmpU, twist * 0.4);
    // Right axis after the twist (+X of the guard's frame) and forward axis.
    tmpN.set(Math.cos(yaw + twist), 0, -Math.sin(yaw + twist));
    tmpF.set(Math.sin(yaw + twist), 0, Math.cos(yaw + twist));
    const pitch = -guard.aimPitch * aimW + guard.fP.x * 0.5 * live;
    rotateWorld(bones.Spine1, tmpN, pitch * 0.4);
    rotateWorld(bones.Spine2, tmpN, pitch * 0.6 - guard.recoil * 0.04 * live);
    rotateWorld(bones.Spine1, tmpF, guard.fR.x * 0.5 * live);
    if (alive) {
      const lookYaw = guard.lookYaw - guard.twist;
      rotateWorld(bones.Neck, tmpU, lookYaw * 0.4);
      rotateWorld(bones.Head, tmpU, lookYaw * 0.5);
      const lookPitch = -(guard.lookPitch - guard.aimPitch * aimW) * 0.5;
      rotateWorld(bones.Neck, tmpN, lookPitch * 0.4);
      rotateWorld(bones.Head, tmpN, lookPitch * 0.6 + guard.hS.x * 0.3);
      if (guard.es === 'radio') {
        // Head cocked toward the shoulder radio.
        rotateWorld(bones.Head, tmpF, -0.3 * clamp((1.5 - guard.esT) * 4, 0, 1));
      }
    }
    if (gunKick) {
      gunKick.position.z = -guard.recoil * 0.03 * live;
    }
    rig.group.updateMatrixWorld(true);
    tmpA.setFromMatrixPosition(bones.Head.matrixWorld);
    tmpB.setFromMatrixPosition(bones.HeadTop_End.matrixWorld);
    guard.headPos.copy(tmpA).lerp(tmpB, 0.45);
    guard.chestPos.setFromMatrixPosition(bones.Spine2.matrixWorld);
    guard.hipsPos.setFromMatrixPosition(bones.Hips.matrixWorld);
  }

  /** Writes the full body pose: legs (gait / kneel), torso, head, rifle and arm IK. */
  function poseRig(dt: number): void {
    const alive = guard.alive;
    const c = guard.crouch;
    const run = clamp((guard.speed - 1.8) / 2.2, 0, 1);
    const amp = alive ? clamp(guard.speed * 0.17, 0, 0.55) * (1 - c * 0.8) : 0;
    const phi = guard.gait;
    // Hit springs.
    if (dt > 0) {
      stepSpring(guard.fP, 0, 90, 9, dt);
      stepSpring(guard.fR, 0, 90, 9, dt);
      stepSpring(guard.hS, 0, 120, 10, dt);
    }
    // Legs: walk/run cycle, blended into a kneel (right knee down).
    const legs = { L: phi, R: phi + Math.PI } as const;
    const kneel = {
      L: { thigh: -1.3, shin: 1.35, foot: 0 },
      R: { thigh: 0.12, shin: 1.5, foot: -0.55 }
    };
    for (const name of ['L', 'R'] as const) {
      const psi = legs[name];
      const swing = Math.max(0, Math.cos(psi));
      const walkThigh = -amp * Math.sin(psi) - run * 0.12;
      const walkKnee = (0.12 + 1.7 * amp) * Math.pow(swing, 1.4) + 0.1 * amp + run * 0.1;
      const walkFoot = -(walkThigh + walkKnee) * 0.75 + amp * 0.3 * Math.sin(psi);
      bones['thigh' + name].rotation.set(walkThigh + (kneel[name].thigh - walkThigh) * c, 0, 0);
      bones['shin' + name].rotation.set(walkKnee + (kneel[name].shin - walkKnee) * c, 0, 0);
      bones['foot' + name].rotation.set(walkFoot + (kneel[name].foot - walkFoot) * c, 0, 0);
    }
    const bob = alive ? -Math.abs(Math.sin(phi)) * 0.035 * Math.min(1, amp * 3) + 0.012 * amp : 0;
    const breathe = alive ? Math.sin(ctx.t * 1.6 + guard.phase) * 0.012 : 0;
    let hipsY = D.hipY - c * D.kneelDrop + bob;
    let hipsPitch = 0;
    let hipsRoll = alive ? Math.sin(phi) * 0.05 * amp : 0;
    let hipsYaw = alive ? Math.sin(phi) * 0.12 * amp : 0;
    let lean = run * 0.2 + c * 0.12;
    let armsLimp = 0;
    if (!alive) {
      // Death: knees buckle, then the body topples about the hips and settles.
      const t = guard.dieT;
      const buckle = smooth01(t / 0.28);
      const fallT = clamp((t - 0.1) / 0.62, 0, 1);
      const fall = fallT * fallT;
      const settle = guard.landed ? Math.exp(-(t - 0.72) * 9) * Math.sin((t - 0.72) * 30) * 0.05 : 0;
      for (const name of ['L', 'R'] as const) {
        const knee = 0.9 * buckle * (1 - fall * 0.75);
        bones['thigh' + name].rotation.set(
          -knee * 0.7 * (guard.dieDir > 0 ? 1 : 0.4) + (name === 'L' ? 0.08 : -0.06) * fall,
          0,
          (name === 'L' ? 0.12 : -0.12) * fall
        );
        bones['shin' + name].rotation.set(knee, 0, 0);
        bones['foot' + name].rotation.set(-0.3 * fall * guard.dieDir, 0, 0);
      }
      const startY = D.hipY - c * D.kneelDrop;
      hipsY = startY - 0.22 * buckle + (0.15 - (startY - 0.22)) * fall + settle;
      hipsPitch = guard.dieDir * (HALF_PI - 0.06) * fall;
      hipsRoll = guard.dieTwist * fall;
      hipsYaw = guard.dieTwist * 0.5 * fall;
      lean = 0.25 * buckle * (1 - fall);
      armsLimp = smooth01((t - 0.15) / 0.5);
    }
    const hips = bones.hips;
    hips.position.set(0, hipsY, 0);
    hips.rotation.set(hipsPitch, hipsYaw, hipsRoll);
    rig.group.rotation.y = guard.yaw;
    // Torso: lean, aim pitch, twist toward the target, hit flinch, recoil.
    const aim = guard.aim;
    const ap = guard.aimPitch * aim;
    bones.spine.rotation.set(
      lean * 0.6 - ap * 0.2 + guard.fP.x * 0.6 + breathe * 0.5,
      guard.twist * 0.4 - hipsYaw * 0.8,
      guard.fR.x * 0.6 - hipsRoll * 0.8
    );
    bones.chest.rotation.set(
      lean * 0.4 - ap * 0.3 + guard.fP.x * 0.4 - guard.recoil * 0.035 + breathe,
      guard.twist * 0.6,
      guard.fR.x * 0.4
    );
    const deadHead = alive ? 0 : 0.5 * armsLimp * -guard.dieDir;
    bones.neck.rotation.set(-guard.lookPitch * 0.4 + lean * -0.3, (guard.lookYaw - guard.twist) * 0.4, 0);
    bones.head.rotation.set(
      -guard.lookPitch * 0.6 + guard.hS.x * 0.25 + deadHead,
      (guard.lookYaw - guard.twist) * 0.6,
      alive ? 0 : guard.dieTwist * armsLimp
    );
    // Rifle pose in chest space: low ready (pointing down-left) blended to shouldered.
    const lowX = -0.1;
    const lowY = -0.03;
    const lowZ = 0.25;
    const aimX = -0.085;
    const aimY = 0.19;
    const aimZ = 0.25;
    tmpGunPos.set(
      lowX + (aimX - lowX) * aim,
      lowY + (aimY - lowY) * aim,
      lowZ + (aimZ - lowZ) * aim - guard.recoil * 0.035
    );
    const gunPitch = 0.6 * (1 - aim) + -ap * 0.5 * aim - guard.recoil * 0.09 + armsLimp * 0.5;
    const gunYaw = 0.5 * (1 - aim) + armsLimp * 0.3;
    if (alive) {
      // Small sway while walking.
      tmpGunPos.y += Math.sin(phi * 2) * 0.008 * amp;
    } else {
      tmpGunPos.y -= 0.12 * armsLimp;
      tmpGunPos.z -= 0.05 * armsLimp;
    }
    tmpEuler.set(gunPitch, gunYaw, (1 - aim) * 0.25);
    tmpGunQ.setFromEuler(tmpEuler);
    bones.gun.position.copy(tmpGunPos);
    bones.gun.quaternion.copy(tmpGunQ);
    // Arm IK (chest space).
    tmpTarget.copy(GRIP_RIGHT).applyQuaternion(tmpGunQ).add(tmpGunPos);
    tmpQ2.copy(tmpGunQ).multiply(HAND_R_Q);
    solveArm('R', SHOULDER_R, tmpTarget, POLE_R, tmpQ2);
    tmpTarget.copy(GRIP_LEFT).applyQuaternion(tmpGunQ).add(tmpGunPos);
    if (guard.es === 'radio' && alive) {
      // Left hand up to the shoulder radio.
      tmpB.set(0.1, 0.2, 0.12);
      tmpTarget.lerp(tmpB, clamp((1.5 - guard.esT) * 4, 0, 1));
    }
    tmpQ2.copy(tmpGunQ).multiply(HAND_L_Q);
    solveArm('L', SHOULDER_L, tmpTarget, POLE_L, tmpQ2);
    rig.group.updateMatrixWorld(true);
    guard.headPos.set(0, 0.1, 0.01).applyMatrix4(bones.head.matrixWorld);
    guard.chestPos.set(0, 0.12, 0).applyMatrix4(bones.chest.matrixWorld);
    guard.hipsPos.set(0, -0.02, 0).applyMatrix4(bones.hips.matrixWorld);
  }

  function die(dir: Vector3 | null | undefined, headshot: boolean): void {
    guard.alive = false;
    ctx.releaseToken(guard);
    guard.dieT = 0;
    guard.landed = false;
    guard.es = 'move';
    guard.speed *= 0.4;
    let hitFwd = -1;
    if (dir) {
      hitFwd = dir.x * Math.sin(guard.yaw) + dir.z * Math.cos(guard.yaw);
    }
    // Shot from the front topples him backward, from behind forward.
    guard.dieDir = hitFwd >= 0 ? 1 : -1;
    guard.dieTwist = (rng() - 0.5) * 0.7;
    if (model) {
      // Pick the death clip from the stance, the hit side and whether it was a headshot.
      let hitSide = 0;
      if (dir) {
        hitSide = dir.x * Math.cos(guard.yaw) - dir.z * Math.sin(guard.yaw);
      }
      let clip: GuardDeathClip;
      if (guard.crouch > 0.5) {
        clip = 'deathCrouch';
      } else if (!headshot && hitSide > 0.6) {
        clip = 'deathSide';
      } else if (guard.dieDir < 0) {
        clip = headshot ? 'deathHeadFront' : 'deathFront';
      } else {
        clip = headshot ? 'deathHeadBack' : 'deathBack';
      }
      deathAction = playGuardDeath(model, clip);
      deathFade = 0;
    }
    lensMat.color.setRGB(0.4, 0.38, 0.34);
    game.events.emit('enemy:killed', {
      enemy: guard,
      pos: guard.pos,
      type: 'guard',
      label: 'Guard',
      verb: 'down',
      headshot
    });
  }

  function updateDead(dt: number): void {
    if (guard.sink > 0) {
      guard.sink += dt;
      guard.pos.y -= 0.18 * dt;
      rig.group.updateMatrixWorld(true);
      if (guard.sink > 2.5) {
        ctx.retire(guard);
      }
      return;
    }
    guard.dieT += dt;
    const t = guard.dieT;
    const animEnd = deathAction ? deathAction.getClip().duration + 0.2 : 1.6;
    if (t < animEnd) {
      guard.pos.x += Math.sin(guard.yaw) * guard.speed * dt;
      guard.pos.z += Math.cos(guard.yaw) * guard.speed * dt;
      guard.speed *= Math.exp(-6 * dt);
      guard.aim += (0 - guard.aim) * (1 - Math.exp(-6 * dt));
      guard.crouch *= Math.exp(-2 * dt);
      const down = model ? t > 0.3 && guard.hipsPos.y - guard.pos.y < 0.3 : t >= 0.72;
      if (!guard.landed && down) {
        guard.landed = true;
        tmpA.set(guard.hipsPos.x, guard.pos.y + 0.05, guard.hipsPos.z);
        game.fx.dust(tmpA, UP, 0.6, 0.3, 0.3, 0.31);
        game.events.emit('enemy:step', {
          pos: guard.pos,
          type: 'guard',
          enemy: guard,
          speed: 6,
          crash: true
        });
      }
      pose(dt);
    }
    if (t > CFG.corpseTime) {
      guard.sink = 0.001;
    }
  }

  return guard;
}

/** Helper for spawn: marks the oldest corpse (largest `dieT`) for reuse. */
export function oldestGuardCorpse(pool: GuardEnemy[]): GuardEnemy | null {
  let best: GuardEnemy | null = null;
  for (const guard of pool) {
    if (guard.active && !guard.alive && (!best || guard.dieT > best.dieT)) {
      best = guard;
    }
  }
  return best;
}
