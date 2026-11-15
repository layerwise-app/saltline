/**
 * Hand skeleton: digit definitions, the 20-float finger pose format and its
 * joint limits, named reference poses, finger forward kinematics, simple
 * collider shapes (capsules / rounded boxes) with signed distances, and the
 * solvers that curl fingers until contact or reach a fingertip pad to a target.
 *
 * Pose layout: 4 floats per digit (thumb, index, middle, ring, little):
 * `[flex0, flex1, flex2, splay]`. For the thumb, slot 0 is CMC rotation and
 * slot 3 the CMC splay.
 */
import { Matrix4 } from 'three';
import type { Quaternion, Vector3 } from 'three';
import { HandQuat, HandVec3 } from '../animConfig';

/** Three numbers (x, y, z). */
export type Vec3Tuple = [number, number, number];
/** Four numbers (x, y, z, w). */
export type QuatTuple = [number, number, number, number];
/** A finger pose: `POSE_LENGTH` joint angles in radians. */
export type Pose = Float32Array;
/** A pose (any 20-number array) or the name of an entry in `POSES`. */
export type PoseRef = string | ArrayLike<number>;
export type DigitName = 'thumb' | 'index' | 'middle' | 'ring' | 'little';
/** Joint values `[flex0, flex1, flex2, splay]` keyed by digit name (`thumb` .. `little`); `fingers` applies to all four fingers. */
export type PoseSpec = Partial<Record<string, ArrayLike<number>>>;
/** Signed distance function of a point (negative inside). */
export type PointSdf = (x: number, y: number, z: number) => number;

/** One digit of the hand (in hand space, metres). */
export interface HandDigit {
  name: DigitName;
  /** Knuckle (first joint) position. */
  base: Vec3Tuple;
  /** Thumb only: rest direction of the metacarpal. */
  dir?: Vec3Tuple;
  /** Thumb only: rest up vector. */
  up?: Vec3Tuple;
  /** Fingers only: base yaw. */
  yaw?: number;
  /** Fingers only: base roll. */
  roll?: number;
  /** Fingers only: sign applied to the splay value. */
  sgn?: number;
  /** Phalanx lengths. */
  len: Vec3Tuple;
  /** Radii at the 4 joints (base .. tip). */
  rad: QuatTuple;
  /** Horizontal widening factor of the phalanx cross-section. */
  wide: number;
  /** Thumb only: rest orientation built from `dir`/`up`. */
  q0?: Quaternion;
  /** Fingers only: rotation for `roll`. */
  qRoll?: Quaternion;
  /** Sum of `len`. */
  total: number;
}

/** Capsule collider: segment `a`-`b` with radius `r`. */
export interface CapsuleCollider {
  type: 'capsule';
  /** Segment start `[x, y, z]`. */
  a: number[];
  /** Segment end `[x, y, z]`. */
  b: number[];
  r: number;
}

/** Rounded oriented box collider. */
export interface BoxCollider {
  type: 'box';
  /** Centre `[x, y, z]`. */
  c: number[];
  /** Half extents `[x, y, z]`. */
  h: number[];
  /** Orientation quaternion `[x, y, z, w]`. */
  q: number[];
  /** Rotation matrix (3x3, column-major: columns are the box axes). */
  m: number[];
  /** Corner rounding radius. */
  r: number;
}

export type Collider = CapsuleCollider | BoxCollider;

/** Forward-kinematics result: 15 phalanx orientations and 20 joint positions (hand space). */
export interface HandFk {
  /** Phalanx orientation, index `digit * 3 + phalanx`. */
  q: Quaternion[];
  /** Joint position, index `digit * 4 + joint` (joint 3 is the tip). */
  j: Vector3[];
}

/** Deepest penetration found by `penetration`. */
export interface PenetrationResult {
  depth: number;
  digit: number;
  phalanx: number;
}

/** Deepest finger-vs-finger (or finger-vs-palm when `b === -1`) overlap. */
export interface SelfPenetrationResult {
  depth: number;
  a: number;
  b: number;
}

/** Options of `curlUntilContact`. */
export interface CurlOptions {
  /** Open pose the curl starts from (default `'open'`). */
  from?: PoseRef;
  /** Closed pose the curl moves towards (default `'fist'`). */
  to?: PoseRef;
  /** Contact skin distance (default 0.0008). */
  skin?: number;
  /** Curl steps (default 40). */
  steps?: number;
  /** Optional palm surface the fingertips must not enter. */
  palm?: PointSdf | null;
  /** Output pose (default: a new one). */
  out?: Pose;
  /** Pose used for the digits that are not curled (default `from`). */
  rest?: PoseRef;
  /** Digits to curl, in order (default fingers then thumb). */
  digits?: number[];
  /** Set to false to let the thumb pass through the fingers. */
  self?: boolean;
  /** Per-digit values written over the result. */
  hold?: PoseSpec;
}

/** Options of `solveDigitPadIk`. */
export interface PadIkOptions {
  /** Coupling of the distal flexion to the middle flexion (default 0.6). */
  couple?: number;
  /** Position along the distal phalanx of the pad (default 0.5). */
  at?: number;
  /** Iteration cap (default 40). */
  iters?: number;
}

/** Number of floats in a pose. */
export const POSE_LENGTH = 20;
export const DIGIT_NAMES: string[] = ['thumb', 'index', 'middle', 'ring', 'little'];
// `q0`, `qRoll` and `total` are filled in right below.
export const DIGITS = [
  {
    name: 'thumb',
    base: [-0.0235, -0.01, -0.02],
    dir: [-0.3, -0.05, -0.95],
    up: [-0.72, 0.69, 0],
    len: [0.044, 0.033, 0.029],
    rad: [0.015, 0.0122, 0.0112, 0.0098],
    wide: 1.15
  },
  {
    name: 'index',
    base: [-0.0335, 0.0015, -0.096],
    yaw: 0.07,
    roll: -0.05,
    sgn: 1,
    len: [0.0405, 0.0235, 0.022],
    rad: [0.0102, 0.0093, 0.0085, 0.0076],
    wide: 1.12
  },
  {
    name: 'middle',
    base: [-0.011, 0.0035, -0.101],
    yaw: 0.01,
    roll: 0,
    sgn: 1,
    len: [0.044, 0.0262, 0.0238],
    rad: [0.0104, 0.0095, 0.0087, 0.0078],
    wide: 1.12
  },
  {
    name: 'ring',
    base: [0.0105, 0.002, -0.0965],
    yaw: -0.06,
    roll: 0.05,
    sgn: -1,
    len: [0.0412, 0.0245, 0.0223],
    rad: [0.0099, 0.009, 0.0082, 0.0073],
    wide: 1.12
  },
  {
    name: 'little',
    base: [0.0305, -0.0015, -0.0875],
    yaw: -0.14,
    roll: 0.12,
    sgn: -1,
    len: [0.0325, 0.0188, 0.02],
    rad: [0.0089, 0.0081, 0.0073, 0.0065],
    wide: 1.12
  }
] as HandDigit[];
export const THUMB_CMC_AXIS = new HandVec3(0.2, 0, 0.98).normalize();
export const FLEX_AXIS = new HandVec3(1, 0, 0);
export const SPLAY_AXIS = new HandVec3(0, 1, 0);
export const ROLL_AXIS = new HandVec3(0, 0, 1);

/** Orientation whose -Z points along `dir` and whose +Y is near `up`. */
function quatFromDirUp(
  dir: ArrayLike<number>,
  up: ArrayLike<number>,
  target: Quaternion = new HandQuat()
): Quaternion {
  const zAxis = new HandVec3(-dir[0], -dir[1], -dir[2]).normalize();
  const xAxis = new HandVec3(up[0], up[1], up[2]).cross(zAxis).normalize();
  const yAxis = new HandVec3().crossVectors(zAxis, xAxis);
  return target.setFromRotationMatrix(new Matrix4().makeBasis(xAxis, yAxis, zAxis));
}
DIGITS[0].q0 = quatFromDirUp(DIGITS[0].dir!, DIGITS[0].up!);
for (let digit = 1; digit < 5; digit++)
  DIGITS[digit].qRoll = new HandQuat().setFromAxisAngle(ROLL_AXIS, DIGITS[digit].roll!);
for (const digit of DIGITS) digit.total = digit.len[0] + digit.len[1] + digit.len[2];

/** Bone indices of the arm skeleton. */
export const BONE = {
  upperArm: 0,
  forearm: 1,
  twist1: 2,
  twist2: 3,
  hand: 4,
  /** Phalanx bone of a digit. */
  digit: (digit: number, phalanx: number): number => 5 + digit * 3 + phalanx,
  /** Joint helper bone (knuckle padding) of a digit. */
  helper: (digit: number, phalanx: number): number => 20 + digit * 3 + phalanx,
  count: 35
};
export const BONE_NAMES = ['upperArm', 'forearm', 'forearmTwist1', 'forearmTwist2', 'hand'];
for (const suffix of ['', 'Helper'])
  for (let digit = 0; digit < 5; digit++)
    for (let phalanx = 0; phalanx < 3; phalanx++)
      BONE_NAMES.push(DIGIT_NAMES[digit] + suffix + (phalanx + 1));

/** `[min, max]` per pose slot of the thumb. */
export const THUMB_JOINT_LIMITS: [number, number][] = [
  [-0.25, 1.35],
  [-0.2, 1],
  [-0.35, 1.4],
  [-0.15, 1]
];
/** `[min, max]` per pose slot of a finger. */
export const FINGER_JOINT_LIMITS: [number, number][] = [
  [-0.45, 1.6],
  [0, 1.95],
  [-0.1, 1.45],
  [-0.3, 0.4]
];
/** Per-slot pose limits. */
export const LIMITS = {
  min: new Float32Array(POSE_LENGTH),
  max: new Float32Array(POSE_LENGTH)
};
for (let digit = 0; digit < 5; digit++)
  for (let slot = 0; slot < 4; slot++) {
    const range = (digit ? FINGER_JOINT_LIMITS : THUMB_JOINT_LIMITS)[slot];
    LIMITS.min[digit * 4 + slot] = range[0];
    LIMITS.max[digit * 4 + slot] = range[1];
  }

/** Builds a pose from per-digit values, starting from `base` (or zeros). */
export function makePose(spec: PoseSpec = {}, base: ArrayLike<number> | null = null): Pose {
  const pose = new Float32Array(POSE_LENGTH);
  if (base) pose.set(base);
  for (let digit = 0; digit < 5; digit++) {
    const values = spec[DIGIT_NAMES[digit]] || (digit && spec.fingers);
    if (values) for (let slot = 0; slot < 4; slot++) pose[digit * 4 + slot] = values[slot] || 0;
  }
  return pose;
}

/** `out = from + (to - from) * t`, per slot. */
export function lerpPose(
  out: Pose,
  from: ArrayLike<number>,
  to: ArrayLike<number>,
  t: number
): Pose {
  for (let slot = 0; slot < POSE_LENGTH; slot++)
    out[slot] = from[slot] + (to[slot] - from[slot]) * t;
  return out;
}

/** Clamps a pose to `LIMITS` in place; returns the largest correction applied. */
export function clampPose(pose: Pose): number {
  let worst = 0;
  for (let slot = 0; slot < POSE_LENGTH; slot++) {
    const min = LIMITS.min[slot];
    const max = LIMITS.max[slot];
    if (pose[slot] < min) {
      worst = Math.max(worst, min - pose[slot]);
      pose[slot] = min;
    } else if (pose[slot] > max) {
      worst = Math.max(worst, pose[slot] - max);
      pose[slot] = max;
    }
  }
  return worst;
}

/** Largest amount by which a pose exceeds `LIMITS` (0 when within). */
export function limitViolation(pose: ArrayLike<number>): number {
  let worst = 0;
  for (let slot = 0; slot < POSE_LENGTH; slot++)
    worst = Math.max(worst, LIMITS.min[slot] - pose[slot], pose[slot] - LIMITS.max[slot]);
  return Math.max(0, worst);
}

/** Neutral resting pose. */
export const REST = makePose({
  thumb: [0.34, 0.08, 0.14, 0.5],
  index: [0.14, 0.22, 0.12, 0.075],
  middle: [0.18, 0.26, 0.14, 0],
  ring: [0.22, 0.28, 0.15, 0.065],
  little: [0.26, 0.3, 0.16, 0.13]
});
/** Named poses; grip reference poses are added by `installReferencePoses`. */
export const POSES: Record<string, Pose> = {
  rest: REST,
  relaxed: makePose({
    thumb: [0.42, 0.14, 0.22, 0.34],
    index: [0.3, 0.44, 0.24, 0.03],
    middle: [0.4, 0.52, 0.28, 0],
    ring: [0.48, 0.56, 0.3, 0.02],
    little: [0.54, 0.58, 0.32, 0.06]
  }),
  open: makePose({
    thumb: [0.2, -0.05, -0.05, 0.75],
    index: [-0.05, 0.04, 0.02, 0.12],
    middle: [-0.05, 0.04, 0.02, 0],
    ring: [-0.05, 0.04, 0.02, 0.1],
    little: [-0.05, 0.04, 0.02, 0.18]
  }),
  flat: makePose({
    thumb: [0.05, 0, 0.02, 0.2],
    index: [0, 0.02, 0.01, -0.04],
    middle: [0, 0.02, 0.01, 0],
    ring: [0, 0.02, 0.01, -0.03],
    little: [0, 0.02, 0.01, -0.06]
  }),
  fist: makePose({
    thumb: [0.98, 0.42, 0.62, 0.16],
    index: [1.4, 1.72, 1.02, -0.04],
    middle: [1.44, 1.74, 1.02, 0],
    ring: [1.46, 1.74, 1.02, -0.03],
    little: [1.48, 1.72, 1.02, -0.08]
  })
};

/** Returns the pose itself, or looks a name up in `POSES` (throws if unknown). */
export function resolvePose(pose: string | Pose): Pose;
export function resolvePose(pose: PoseRef): ArrayLike<number>;
export function resolvePose(pose: PoseRef): ArrayLike<number> {
  if (typeof pose == 'string') {
    const named = POSES[pose];
    if (!named) throw new Error('weapon_hands: unknown pose "' + pose + '"');
    return named;
  }
  return pose;
}

const tmpJointQuat = new HandQuat();
const tmpPhalanxQuat = new HandQuat();
const tmpSegmentPoint = new HandVec3();

/** Writes the local rotation of one phalanx (relative to its parent) into `target`. */
export function phalanxLocalRotation(
  digit: number,
  phalanx: number,
  pose: ArrayLike<number>,
  target: Quaternion
): Quaternion {
  const def = DIGITS[digit];
  const offset = digit * 4;
  if (phalanx > 0) return target.setFromAxisAngle(FLEX_AXIS, -pose[offset + phalanx]);
  if (digit === 0)
    return target
      .setFromAxisAngle(THUMB_CMC_AXIS, pose[0])
      .multiply(tmpJointQuat.setFromAxisAngle(SPLAY_AXIS, pose[3]))
      .multiply(def.q0!);
  return target
    .setFromAxisAngle(SPLAY_AXIS, def.yaw! + def.sgn! * pose[offset + 3])
    .multiply(def.qRoll!)
    .multiply(tmpJointQuat.setFromAxisAngle(FLEX_AXIS, -pose[offset]));
}

/** Allocates a forward-kinematics buffer. */
export function createHandFk(): HandFk {
  return {
    q: Array.from(
      {
        length: 15
      },
      () => new HandQuat()
    ),
    j: Array.from(
      {
        length: 20
      },
      () => new HandVec3()
    )
  };
}

/** Forward kinematics of one digit into `fk`. */
export function computeDigitFk(pose: ArrayLike<number>, digit: number, fk: HandFk): void {
  const def = DIGITS[digit];
  const quats = fk.q;
  const joints = fk.j;
  const quatOffset = digit * 3;
  const jointOffset = digit * 4;
  phalanxLocalRotation(digit, 0, pose, quats[quatOffset]);
  quats[quatOffset + 1]
    .copy(quats[quatOffset])
    .multiply(phalanxLocalRotation(digit, 1, pose, tmpPhalanxQuat));
  quats[quatOffset + 2]
    .copy(quats[quatOffset + 1])
    .multiply(phalanxLocalRotation(digit, 2, pose, tmpPhalanxQuat));
  joints[jointOffset].set(def.base[0], def.base[1], def.base[2]);
  for (let phalanx = 0; phalanx < 3; phalanx++)
    joints[jointOffset + phalanx + 1]
      .copy(joints[jointOffset + phalanx])
      .add(
        tmpSegmentPoint.set(0, 0, -def.len[phalanx]).applyQuaternion(quats[quatOffset + phalanx])
      );
}

/** Forward kinematics of all five digits into `fk`. */
export function computeHandFk(pose: ArrayLike<number>, fk: HandFk): HandFk {
  for (let digit = 0; digit < 5; digit++) computeDigitFk(pose, digit, fk);
  return fk;
}

/** Makes a capsule collider (copies the points). */
export function capsule(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  radius: number
): CapsuleCollider {
  return {
    type: 'capsule',
    a: [a[0], a[1], a[2]],
    b: [b[0], b[1], b[2]],
    r: radius
  };
}

function isQuaternion(value: Quaternion | ArrayLike<number>): value is Quaternion {
  return Boolean((value as Quaternion).isQuaternion);
}

/** Makes a rounded box collider from centre, half extents, optional rotation and rounding. */
export function box(
  center: ArrayLike<number>,
  half: ArrayLike<number>,
  rotation: Quaternion | ArrayLike<number> | null = null,
  round = 0
): BoxCollider {
  const quat = rotation
    ? isQuaternion(rotation)
      ? rotation.clone()
      : new HandQuat(rotation[0], rotation[1], rotation[2], rotation[3])
    : new HandQuat();
  const m = new Matrix4().makeRotationFromQuaternion(quat).elements;
  return {
    type: 'box',
    c: [center[0], center[1], center[2]],
    h: [half[0], half[1], half[2]],
    q: [quat.x, quat.y, quat.z, quat.w],
    m: [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]],
    r: round
  };
}

/** Returns copies of the colliders transformed by `matrix` (rotation + translation). */
export function transformColliders(colliders: Collider[], matrix: Matrix4): Collider[] {
  const position = new HandVec3();
  const scale = new HandVec3();
  const rotation = new HandQuat();
  matrix.decompose(position, rotation, scale);
  return colliders.map((collider) =>
    collider.type === 'capsule'
      ? capsule(
          new HandVec3(collider.a[0], collider.a[1], collider.a[2]).applyMatrix4(matrix).toArray(),
          new HandVec3(collider.b[0], collider.b[1], collider.b[2]).applyMatrix4(matrix).toArray(),
          collider.r
        )
      : box(
          new HandVec3(collider.c[0], collider.c[1], collider.c[2]).applyMatrix4(matrix).toArray(),
          collider.h,
          rotation
            .clone()
            .multiply(new HandQuat(collider.q[0], collider.q[1], collider.q[2], collider.q[3])),
          collider.r
        )
  );
}

/** Signed distance from a point to one collider. */
function colliderSignedDistance(collider: Collider, x: number, y: number, z: number): number {
  if (collider.type === 'capsule') {
    const a = collider.a;
    const b = collider.b;
    const abX = b[0] - a[0];
    const abY = b[1] - a[1];
    const abZ = b[2] - a[2];
    const apX = x - a[0];
    const apY = y - a[1];
    const apZ = z - a[2];
    let t = (apX * abX + apY * abY + apZ * abZ) / (abX * abX + abY * abY + abZ * abZ || 1e-12);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(apX - abX * t, apY - abY * t, apZ - abZ * t) - collider.r;
  }
  const m = collider.m;
  const half = collider.h;
  const round = collider.r;
  const dx = x - collider.c[0];
  const dy = y - collider.c[1];
  const dz = z - collider.c[2];
  const qx = Math.abs(dx * m[0] + dy * m[1] + dz * m[2]) - half[0] + round;
  const qy = Math.abs(dx * m[3] + dy * m[4] + dz * m[5]) - half[1] + round;
  const qz = Math.abs(dx * m[6] + dy * m[7] + dz * m[8]) - half[2] + round;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) +
    Math.min(Math.max(qx, qy, qz), 0) -
    round
  );
}

/** Smallest signed distance from a point to any of the colliders (1e9 if none). */
export function minColliderDistance(
  colliders: Collider[],
  x: number,
  y: number,
  z: number
): number {
  let best = 1e9;
  for (let i = 0; i < colliders.length; i++) {
    const distance = colliderSignedDistance(colliders[i], x, y, z);
    if (distance < best) best = distance;
  }
  return best;
}

const tmpHandFk = createHandFk();
const tmpSelfFk = createHandFk();
const PHALANX_SAMPLES = 6;
const tmpPhalanxDepths: Vec3Tuple = [0, 0, 0];

/**
 * Deepest penetration of each phalanx of one digit into the colliders (and,
 * for the outer phalanges, into `palm`). Returns a shared scratch array.
 */
export function digitPenetration(
  pose: ArrayLike<number>,
  digit: number,
  colliders: Collider[],
  palm: PointSdf | null = null,
  extraColliders: Collider[] | null = null
): Vec3Tuple {
  computeDigitFk(pose, digit, tmpHandFk);
  const def = DIGITS[digit];
  const joints = tmpHandFk.j;
  const jointOffset = digit * 4;
  for (let phalanx = 0; phalanx < 3; phalanx++) {
    let deepest = -1e9;
    if (!(digit === 0 && phalanx === 0)) {
      const start = joints[jointOffset + phalanx];
      const end = joints[jointOffset + phalanx + 1];
      const startRadius = def.rad[phalanx];
      const endRadius = def.rad[phalanx + 1];
      const tipInset = phalanx === 2 ? endRadius / def.len[phalanx] : 0;
      const checkPalm = palm && phalanx >= (digit === 0 ? 2 : 1);
      for (let sample = 0; sample < PHALANX_SAMPLES; sample++) {
        const along =
          digit === 0 && phalanx === 1
            ? 0.35 + (0.65 * sample) / (PHALANX_SAMPLES - 1)
            : sample / (PHALANX_SAMPLES - 1);
        const t = along * (1 - tipInset);
        const px = start.x + (end.x - start.x) * t;
        const py = start.y + (end.y - start.y) * t;
        const pz = start.z + (end.z - start.z) * t;
        let distance = minColliderDistance(colliders, px, py, pz);
        if (extraColliders)
          distance = Math.min(distance, minColliderDistance(extraColliders, px, py, pz));
        if (checkPalm) distance = Math.min(distance, palm(px, py, pz));
        const depth = startRadius + (endRadius - startRadius) * along - distance;
        if (depth > deepest) deepest = depth;
      }
    }
    tmpPhalanxDepths[phalanx] = deepest;
  }
  return tmpPhalanxDepths;
}

/** Deepest penetration of any phalanx of the posed hand into the colliders. */
export function penetration(
  pose: PoseRef,
  colliders: Collider[],
  out: PenetrationResult = {} as PenetrationResult
): PenetrationResult {
  const resolved = resolvePose(pose);
  out.depth = -1e9;
  out.digit = 0;
  out.phalanx = 0;
  for (let digit = 0; digit < 5; digit++) {
    const depths = digitPenetration(resolved, digit, colliders);
    for (let phalanx = 0; phalanx < 3; phalanx++)
      if (depths[phalanx] > out.depth) {
        out.depth = depths[phalanx];
        out.digit = digit;
        out.phalanx = phalanx;
      }
  }
  return out;
}

/**
 * Curls each digit from `from` towards `to`, phalanx by phalanx, stopping
 * each phalanx where it first touches the colliders (or the palm, or for the
 * thumb the other fingers). Returns the fitted pose.
 */
export function curlUntilContact(colliders: Collider[], options: CurlOptions = {}): Pose {
  const fromPose = resolvePose(options.from || 'open');
  const toPose = resolvePose(options.to || 'fist');
  const skin = options.skin ?? 8e-4;
  const steps = options.steps || 40;
  const palm = options.palm || null;
  const pose = options.out || new Float32Array(POSE_LENGTH);
  pose.set(resolvePose(options.rest || fromPose));
  const progress = [0, 0, 0];
  for (const digit of options.digits || [1, 2, 3, 4, 0]) {
    let fingerColliders: Collider[] | null = null;
    if (digit === 0 && options.self !== false) {
      computeHandFk(pose, tmpSelfFk);
      fingerColliders = [];
      for (let finger = 1; finger < 5; finger++)
        for (let phalanx = 0; phalanx < 3; phalanx++) {
          const def = DIGITS[finger];
          const start = tmpSelfFk.j[finger * 4 + phalanx];
          const end = tmpSelfFk.j[finger * 4 + phalanx + 1];
          fingerColliders.push(
            capsule(
              [start.x, start.y, start.z],
              phalanx === 2
                ? [
                    end.x + ((start.x - end.x) * def.rad[3]) / def.len[2],
                    end.y + ((start.y - end.y) * def.rad[3]) / def.len[2],
                    end.z + ((start.z - end.z) * def.rad[3]) / def.len[2]
                  ]
                : [end.x, end.y, end.z],
              (def.rad[phalanx] + def.rad[phalanx + 1]) / 2
            )
          );
        }
    }
    const offset = digit * 4;
    // Applies the curl progress (plus `extraSteps` for phalanges after `lockedUpTo`).
    const applyCurl = (extraSteps: number, lockedUpTo: number): void => {
      for (let phalanx = 0; phalanx < 3; phalanx++) {
        const amount =
          phalanx > lockedUpTo
            ? Math.min(1, progress[phalanx] + extraSteps / steps)
            : progress[phalanx];
        pose[offset + phalanx] =
          fromPose[offset + phalanx] +
          (toPose[offset + phalanx] - fromPose[offset + phalanx]) * amount;
        if (phalanx === 0)
          pose[offset + 3] =
            fromPose[offset + 3] + (toPose[offset + 3] - fromPose[offset + 3]) * amount;
      }
    };
    const baseline = [0, 0, 0];
    // Index of the last free phalanx that newly touches something, or -1.
    const findContact = (lockedUpTo: number): number => {
      const depths = digitPenetration(pose, digit, colliders, palm, fingerColliders);
      let hit = -1;
      for (let phalanx = lockedUpTo + 1; phalanx < 3; phalanx++)
        if (depths[phalanx] + skin > 0 && depths[phalanx] > baseline[phalanx] + 1e-7) hit = phalanx;
      return hit;
    };
    const recordBaseline = (): void => {
      const depths = digitPenetration(pose, digit, colliders, palm, fingerColliders);
      baseline[0] = depths[0];
      baseline[1] = depths[1];
      baseline[2] = depths[2];
    };
    progress[0] = progress[1] = progress[2] = 0;
    applyCurl(0, 2);
    recordBaseline();
    let locked = -1;
    for (let step = 0; step < steps && locked < 2; step++) {
      applyCurl(1, locked);
      let hit = findContact(locked);
      if (hit < 0) {
        for (let phalanx = locked + 1; phalanx < 3; phalanx++)
          progress[phalanx] = Math.min(1, progress[phalanx] + 1 / steps);
        recordBaseline();
        continue;
      }
      // Bisect the step for the contact point.
      let low = 0;
      let high = 1;
      for (let iteration = 0; iteration < 10; iteration++) {
        const mid = (low + high) / 2;
        applyCurl(mid, locked);
        const midHit = findContact(locked);
        if (midHit < 0) {
          low = mid;
        } else {
          high = mid;
          hit = midHit;
        }
      }
      for (let phalanx = locked + 1; phalanx < 3; phalanx++)
        progress[phalanx] = Math.min(1, progress[phalanx] + low / steps);
      applyCurl(0, 2);
      recordBaseline();
      locked = hit;
      step--;
    }
    applyCurl(0, 2);
  }
  if (options.hold)
    for (let digit = 0; digit < 5; digit++) {
      const values = options.hold[DIGIT_NAMES[digit]];
      if (values) for (let slot = 0; slot < 4; slot++) pose[digit * 4 + slot] = values[slot];
    }
  return pose;
}

const tmpPadPoint = new HandVec3();
const tmpPadOffsetDir = new HandVec3();

/** Point on the palmar surface of the distal phalanx, `t` of the way to the tip. */
function distalPadPoint(
  pose: ArrayLike<number>,
  digit: number,
  t: number,
  target: Vector3
): Vector3 {
  computeDigitFk(pose, digit, tmpHandFk);
  const def = DIGITS[digit];
  const jointOffset = digit * 4;
  target.copy(tmpHandFk.j[jointOffset + 2]).lerp(tmpHandFk.j[jointOffset + 3], t);
  tmpPadOffsetDir.set(0, -1, 0).applyQuaternion(tmpHandFk.q[digit * 3 + 2]);
  return target.addScaledVector(tmpPadOffsetDir, def.rad[2] + (def.rad[3] - def.rad[2]) * t);
}

/**
 * Damped Gauss-Newton IK moving one digit's distal pad onto `target`
 * (base flexion, splay and middle flexion; distal flexion coupled to middle).
 * Edits `pose` in place and returns the remaining distance.
 */
export function solveDigitPadIk(
  pose: Pose,
  digit: number,
  target: ArrayLike<number>,
  options: PadIkOptions = {}
): number {
  const couple = options.couple ?? 0.6;
  const padAt = options.at ?? 0.5;
  const offset = digit * 4;
  const slots = [offset, offset + 3, offset + 1];
  const delta = 0.001;
  const jacobian = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  const error = [0, 0, 0];
  const clampSlots = (): void => {
    for (const slot of [offset, offset + 1, offset + 3])
      pose[slot] = Math.min(LIMITS.max[slot], Math.max(LIMITS.min[slot], pose[slot]));
    pose[offset + 2] = Math.min(
      LIMITS.max[offset + 2],
      Math.max(LIMITS.min[offset + 2], couple * pose[offset + 1])
    );
  };
  const targetX = target[0];
  const targetY = target[1];
  const targetZ = target[2];
  let distance = 1e9;
  let damping = 1e-4;
  clampSlots();
  for (let iteration = 0; iteration < (options.iters || 40); iteration++) {
    distalPadPoint(pose, digit, padAt, tmpPadPoint);
    error[0] = targetX - tmpPadPoint.x;
    error[1] = targetY - tmpPadPoint.y;
    error[2] = targetZ - tmpPadPoint.z;
    distance = Math.hypot(error[0], error[1], error[2]);
    if (distance < 2e-5) break;
    // Finite-difference Jacobian.
    for (let column = 0; column < 3; column++) {
      const slot = slots[column];
      const saved = pose[slot];
      const savedDistal = pose[offset + 2];
      pose[slot] = saved + delta;
      if (slot === offset + 1) pose[offset + 2] = couple * pose[slot];
      tmpPadOffsetDir.set(0, 0, 0);
      distalPadPoint(pose, digit, padAt, tmpPadPoint);
      jacobian[0][column] = (tmpPadPoint.x - (targetX - error[0])) / delta;
      jacobian[1][column] = (tmpPadPoint.y - (targetY - error[1])) / delta;
      jacobian[2][column] = (tmpPadPoint.z - (targetZ - error[2])) / delta;
      pose[slot] = saved;
      pose[offset + 2] = savedDistal;
    }
    // Normal equations (J^T J + damping I) x = J^T e, solved with Cramer's rule.
    const normal = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ];
    const rhs = [0, 0, 0];
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        let sum = 0;
        for (let k = 0; k < 3; k++) sum += jacobian[k][row] * jacobian[k][column];
        normal[row][column] = sum + (row === column ? damping : 0);
      }
      rhs[row] =
        jacobian[0][row] * error[0] + jacobian[1][row] * error[1] + jacobian[2][row] * error[2];
    }
    const determinant = (mat: number[][]): number =>
      mat[0][0] * (mat[1][1] * mat[2][2] - mat[1][2] * mat[2][1]) -
      mat[0][1] * (mat[1][0] * mat[2][2] - mat[1][2] * mat[2][0]) +
      mat[0][2] * (mat[1][0] * mat[2][1] - mat[1][1] * mat[2][0]);
    const det = determinant(normal);
    if (Math.abs(det) < 1e-18) break;
    const previous = [pose[offset], pose[offset + 3], pose[offset + 1], pose[offset + 2]];
    for (let column = 0; column < 3; column++) {
      const replaced = normal.map((row, rowIndex) =>
        row.map((value, colIndex) => (colIndex === column ? rhs[rowIndex] : value))
      );
      pose[slots[column]] += Math.max(-0.35, Math.min(0.35, determinant(replaced) / det));
    }
    clampSlots();
    distalPadPoint(pose, digit, padAt, tmpPadPoint);
    if (
      Math.hypot(targetX - tmpPadPoint.x, targetY - tmpPadPoint.y, targetZ - tmpPadPoint.z) >
      distance
    ) {
      // The step made it worse: undo it and damp harder.
      pose[offset] = previous[0];
      pose[offset + 3] = previous[1];
      pose[offset + 1] = previous[2];
      pose[offset + 2] = previous[3];
      damping *= 8;
      if (damping > 1e3) break;
    } else damping = Math.max(1e-6, damping * 0.4);
  }
  distalPadPoint(pose, digit, padAt, tmpPadPoint);
  return Math.hypot(targetX - tmpPadPoint.x, targetY - tmpPadPoint.y, targetZ - tmpPadPoint.z);
}

/**
 * Deepest overlap between phalanges of different digits (and, with `palm`,
 * of the outer phalanges with the palm, reported with `b = -1`).
 */
export function fingerSelfPenetration(
  pose: PoseRef,
  palm: PointSdf | null = null,
  out: SelfPenetrationResult = {} as SelfPenetrationResult
): SelfPenetrationResult {
  const resolved = resolvePose(pose);
  computeHandFk(resolved, tmpSelfFk);
  out.depth = -1e9;
  out.a = 0;
  out.b = 0;
  const joints = tmpSelfFk.j;
  // Moves tmpSegmentPoint to a sample on a phalanx axis and returns the radius there.
  const samplePhalanx = (digit: number, phalanx: number, sample: number): number => {
    const def = DIGITS[digit];
    const start = joints[digit * 4 + phalanx];
    const end = joints[digit * 4 + phalanx + 1];
    const along = sample / (PHALANX_SAMPLES - 1);
    const t = along * (1 - (phalanx === 2 ? def.rad[3] / def.len[2] : 0));
    tmpSegmentPoint.copy(start).lerp(end, t);
    return def.rad[phalanx] + (def.rad[phalanx + 1] - def.rad[phalanx]) * along;
  };
  for (let digit = 0; digit < 5; digit++)
    for (let phalanx = 0; phalanx < 3; phalanx++)
      for (let sample = 0; sample < PHALANX_SAMPLES; sample++) {
        const radius = samplePhalanx(digit, phalanx, sample);
        const px = tmpSegmentPoint.x;
        const py = tmpSegmentPoint.y;
        const pz = tmpSegmentPoint.z;
        if (palm && phalanx > 0 && !(digit === 0 && phalanx === 1)) {
          const depth = radius - palm(px, py, pz);
          if (depth > out.depth) {
            out.depth = depth;
            out.a = digit;
            out.b = -1;
          }
        }
        for (let other = digit + 1; other < 5; other++)
          for (let otherPhalanx = 0; otherPhalanx < 3; otherPhalanx++) {
            if (
              (phalanx === 0 && otherPhalanx === 0) ||
              (digit === 0 && phalanx === 0 && otherPhalanx === 0) ||
              (other - digit === 1 &&
                digit > 0 &&
                (phalanx === 0 || otherPhalanx === 0) &&
                phalanx + otherPhalanx < 2)
            )
              continue;
            const otherDef = DIGITS[other];
            const start = joints[other * 4 + otherPhalanx];
            const end = joints[other * 4 + otherPhalanx + 1];
            const axisX = end.x - start.x;
            const axisY = end.y - start.y;
            const axisZ = end.z - start.z;
            let t =
              ((px - start.x) * axisX + (py - start.y) * axisY + (pz - start.z) * axisZ) /
              (axisX * axisX + axisY * axisY + axisZ * axisZ);
            const tMax = 1 - (otherPhalanx === 2 ? otherDef.rad[3] / otherDef.len[2] : 0);
            t = t < 0 ? 0 : t > tMax ? tMax : t;
            const depth =
              radius +
              otherDef.rad[otherPhalanx] +
              (otherDef.rad[otherPhalanx + 1] - otherDef.rad[otherPhalanx]) * t -
              Math.hypot(
                px - start.x - axisX * t,
                py - start.y - axisY * t,
                pz - start.z - axisZ * t
              );
            if (depth > out.depth) {
              out.depth = depth;
              out.a = digit;
              out.b = other;
            }
          }
      }
  return out;
}
