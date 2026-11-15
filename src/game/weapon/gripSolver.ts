/**
 * Grip solver: fits hand poses onto weapon collider shapes (curl-until-contact,
 * finger reach / search), measures mesh profiles for grip placement, and drives
 * the two first-person arms (`createArmRig`) from per-frame hand targets supplied
 * by the active viewmodel, including blending between targets and the "drop"
 * animation when the player dies.
 */
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Object3D } from 'three';
import type { Game } from '../core/types';
import { SHOULDER } from './animConfig';
import {
  DIGITS,
  LIMITS,
  POSES,
  POSE_LENGTH,
  capsule,
  computeDigitFk,
  computeHandFk,
  createHandFk,
  curlUntilContact,
  lerpPose,
  minColliderDistance,
  penetration,
  solveDigitPadIk,
  transformColliders
} from './hand/skeleton';
import type { PadIkOptions } from './hand/skeleton';
import { palmSdf } from './hand/glove';
import { GRIPS } from './hand/grips';
import { DEFAULT_POLE, createArm, mirrorColliders } from './arms';
import type { Arm, CurlOptions, HandCollider } from './arms';
import type { ViewOffset } from './index';

/** Which hand / arm. */
export type HandSide = 'left' | 'right';

/** A position + orientation pair (e.g. a grip frame or a hand placement). */
export interface HandFrame {
  p: Vector3;
  q: Quaternion;
}

/** A hand placed on a weapon: placement, finger pose and the colliders it holds (in hand space). */
export interface HandGrip extends HandFrame {
  name: string;
  side: HandSide;
  pose: Float32Array;
  shapes: HandCollider[];
}

/** Result of the grip fitting functions (`fitGripPose`, `reachFingerTo`, ...). */
export interface GripFit extends HandGrip {
  /** Deepest finger penetration into `shapes` (metres, negative = clearance). */
  depth: number;
  /** Lazily measures the palm's penetration into the shapes. */
  palm?: () => number;
  /** Distance of the finger pad from the requested target. */
  miss?: number;
  /** Deepest phalanx penetration of the searched finger. */
  deep?: number;
}

/** Options of `reachFingerTo` (forwarded to `solveDigitPadIk`). */
export interface FingerReachOptions extends PadIkOptions {
  /** Initial joint angles of the digit before solving. */
  start?: ArrayLike<number>;
}

/** Options of `searchFingerPose`. */
export interface FingerSearchOptions {
  /** Pose to start from (defaults to the grip's pose). */
  base?: ArrayLike<number>;
  /** Allowed clearance before penetration is penalised. */
  skin?: number;
  /** Where along the thumb's proximal phalanx sampling starts (thumb only). */
  root?: number;
}

/** Axis-aligned bounds of the vertices of a mesh that fall inside a box. */
export interface MeshBounds {
  min: number[];
  max: number[];
  /** Number of vertices inside the box. */
  n: number;
}

/** One horizontal slice of a mesh profile. */
export interface MeshProfileSlice {
  y: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  n: number;
}

/** Linear fit of a pistol-grip profile. */
export interface GripProfileFit {
  rake: number;
  hw: number;
  top: number;
  bottom: number;
  front: (y: number) => number;
  back: (y: number) => number;
  centre: (y: number) => number;
  depth: (y: number) => number;
}

/** Hand target written by a viewmodel each frame (camera space unless the rig is attached). */
export interface ArmTarget {
  p: Vector3;
  q: Quaternion;
  pose: Float32Array;
  /** Trigger pull 0..1. */
  trig: number;
  /** Elbow pole direction. */
  pole: Vector3;
  /** Shoulder position. */
  sh: Vector3;
}

/** Right (`r`) and left (`l`) hand targets. */
export interface ArmTargets {
  r: ArmTarget;
  l: ArmTarget;
}

/** Something that can place the hands (a weapon viewmodel). */
export interface ArmDriver {
  armTargets(targets: ArmTargets, dt: number): void;
}

/** Per-arm blending / drop state of the rig. */
export interface ArmRigState {
  /** Last solved target (world space). */
  last: ArmTarget;
  /** Target blended away from. */
  from: ArmTarget;
  /** `from` in camera-local space (for blending while the camera moves). */
  fromL: HandFrame;
  /** Drop linear velocity. */
  v: Vector3;
  /** Drop angular velocity. */
  w: Vector3;
  /** +1 for right, -1 for left. */
  side: number;
}

/** IK diagnostics of one arm, as returned by `ArmRig.report()`. */
export interface ArmReport {
  side: HandSide;
  reach: number;
  violation: number;
  lean: number;
  flex: number;
  deviation: number;
  twist: number;
}

/** The two first-person arms, driven by the active weapon's hand targets. */
export interface ArmRig {
  right: Arm;
  left: Arm;
  list: Arm[];
  targets: ArmTargets;
  state: ArmRigState[];
  /** True while the drop animation plays. */
  readonly dropping: boolean;
  setVisible(visible: boolean): void;
  /** Blends from the last solved hands to the new targets over `duration` seconds. */
  blend(duration?: number): void;
  /** Cancels any blend (hands jump to their targets). */
  snap(): void;
  /** Parents the arms to `root` (posed by `pose`) or back to the camera when `root` is null. */
  attach(root: Object3D | null, pose?: ViewOffset | null, layer?: number): void;
  update(dt: number, driver: ArmDriver | null | undefined, frame: Object3D): void;
  /** Starts the death "drop" animation. */
  startDrop(random?: () => number): void;
  dropUpdate(dt: number): void;
  /** Ends the drop animation and shows the arms again. */
  restore(): void;
  report(): ArmReport[];
  dispose(): void;
}

const UNIT_SCALE = new Vector3(1, 1, 1);

const smootherstep = (t: number): number => {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * t * (t * (6 * t - 15) + 10);
};

/** Quaternion whose -Z points along `forward` and whose +Y is closest to `up`. */
export function quatFromForwardUp(forward: ArrayLike<number>, up: ArrayLike<number>): Quaternion {
  const back = new Vector3(forward[0], forward[1], forward[2]).normalize().negate();
  const upAxis = new Vector3(up[0], up[1], up[2]);
  upAxis.addScaledVector(back, -upAxis.dot(back)).normalize();
  return new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(new Vector3().crossVectors(upAxis, back), upAxis, back)
  );
}

/** Hand origin such that the hand-local point `localOffset` (mirrored for the left hand) lands on `target`. */
export function originFromLocalOffset(
  side: HandSide,
  rotation: Quaternion,
  target: ArrayLike<number>,
  localOffset: ArrayLike<number>
): Vector3 {
  return new Vector3(
    side === 'left' ? -localOffset[0] : localOffset[0],
    localOffset[1],
    localOffset[2]
  )
    .applyQuaternion(rotation)
    .negate()
    .add(new Vector3(target[0], target[1], target[2]));
}

/** Hand placement that puts the grip frame `frame` (or named grip) at `position` / `rotation`. */
export function handPoseFromSocket(
  side: HandSide,
  frame: string | HandFrame,
  position: Vector3,
  rotation: Quaternion = new Quaternion()
): HandFrame {
  const gripFrame = typeof frame == 'string' ? GRIPS[frame].frame : frame;
  const handPos = new Vector3();
  const handQuat = new Quaternion();
  const isLeft = side === 'left';
  const socketPos = isLeft ? new Vector3(-position.x, position.y, position.z) : position;
  const socketQuat = isLeft
    ? new Quaternion(rotation.x, -rotation.y, -rotation.z, rotation.w)
    : rotation;
  handQuat.copy(socketQuat).multiply(new Quaternion().copy(gripFrame.q).invert());
  handPos.copy(gripFrame.p).negate().applyQuaternion(handQuat).add(socketPos);
  if (isLeft) {
    handPos.x = -handPos.x;
    handQuat.y = -handQuat.y;
    handQuat.z = -handQuat.z;
  }
  return {
    p: handPos,
    q: handQuat
  };
}

/** Deepest penetration of the palm surface into the colliders (sampled over their surfaces). */
function palmPenetrationDepth(colliders: HandCollider[]): number {
  let deepest = -1e9;
  const point = new Vector3();
  const boxQuat = new Quaternion();
  const sample = (x: number, y: number, z: number): void => {
    const depth = -palmSdf(x, y, z);
    if (depth > deepest) deepest = depth;
  };
  for (const collider of colliders)
    if (collider.type === 'capsule') {
      const start = new Vector3(collider.a[0], collider.a[1], collider.a[2]);
      const end = new Vector3(collider.b[0], collider.b[1], collider.b[2]);
      const axis = end.clone().sub(start);
      const length = axis.length() || 1e-9;
      axis.multiplyScalar(1 / length);
      const sideA = new Vector3(1, 0, 0);
      if (Math.abs(axis.x) > 0.9) sideA.set(0, 1, 0);
      sideA.addScaledVector(axis, -sideA.dot(axis)).normalize();
      const sideB = new Vector3().crossVectors(axis, sideA);
      for (let ring = 0; ring <= 8; ring++)
        for (let k = 0; k < 12; k++) {
          const angle = (k / 12) * Math.PI * 2;
          point
            .copy(start)
            .addScaledVector(axis, (length * ring) / 8)
            .addScaledVector(sideA, Math.cos(angle) * collider.r)
            .addScaledVector(sideB, Math.sin(angle) * collider.r);
          sample(point.x, point.y, point.z);
        }
    } else {
      boxQuat.set(collider.q[0], collider.q[1], collider.q[2], collider.q[3]);
      const half = collider.h;
      const steps = 6;
      for (let face = 0; face < 6; face++) {
        const axis = face >> 1;
        const sign = face & 1 ? 1 : -1;
        const axisU = (axis + 1) % 3;
        const axisV = (axis + 2) % 3;
        for (let iu = 0; iu <= steps; iu++)
          for (let iv = 0; iv <= steps; iv++) {
            const local = [0, 0, 0];
            local[axis] = sign * half[axis];
            local[axisU] = ((iu / steps) * 2 - 1) * Math.max(0, half[axisU] - collider.r);
            local[axisV] = ((iv / steps) * 2 - 1) * Math.max(0, half[axisV] - collider.r);
            point.set(local[0], local[1], local[2]).applyQuaternion(boxQuat);
            sample(point.x + collider.c[0], point.y + collider.c[1], point.z + collider.c[2]);
          }
      }
    }
  return deepest;
}

/** Places a hand at `position` / `rotation` and curls its fingers onto `colliders` (given in weapon space). */
export function fitGripPose(
  name: string,
  side: HandSide,
  position: Vector3,
  rotation: Quaternion,
  colliders: HandCollider[],
  options: CurlOptions = {}
): GripFit {
  const toHand = new Matrix4().compose(position, rotation, UNIT_SCALE).invert();
  let shapes = transformColliders(colliders, toHand);
  if (side === 'left') shapes = mirrorColliders(shapes);
  const pose = curlUntilContact(shapes, {
    palm: palmSdf,
    ...options
  });
  return {
    name,
    side,
    p: position.clone(),
    q: rotation.clone(),
    pose,
    shapes,
    depth: penetration(pose, shapes).depth,
    palm: () => palmPenetrationDepth(shapes)
  };
}

/** Re-curls an existing grip, optionally adding extra colliders (weapon space). */
export function refitGripWithShapes(
  grip: GripFit,
  name: string,
  options: CurlOptions,
  extraColliders: HandCollider[] | null = null
): GripFit {
  let shapes = grip.shapes;
  if (extraColliders) {
    const toHand = new Matrix4().compose(grip.p, grip.q, UNIT_SCALE).invert();
    let extra = transformColliders(extraColliders, toHand);
    if (grip.side === 'left') extra = mirrorColliders(extra);
    shapes = shapes.concat(extra);
  }
  const pose = curlUntilContact(shapes, {
    palm: palmSdf,
    ...options
  });
  return {
    ...grip,
    name,
    pose,
    shapes,
    depth: penetration(pose, shapes).depth
  };
}

/** Bends `digit` so its pad reaches `target` (weapon space) using pad IK. */
export function reachFingerTo(
  grip: HandGrip,
  name: string,
  digit: number,
  target: ArrayLike<number>,
  basePose: ArrayLike<number> | null = null,
  options: FingerReachOptions = {}
): GripFit {
  basePose = basePose || grip.pose;
  const localTarget = new Vector3(target[0], target[1], target[2]).applyMatrix4(
    new Matrix4().compose(grip.p, grip.q, UNIT_SCALE).invert()
  );
  if (grip.side === 'left') localTarget.x = -localTarget.x;
  const pose = Float32Array.from(basePose);
  if (options.start)
    for (let joint = 0; joint < 4; joint++) pose[digit * 4 + joint] = options.start[joint];
  const miss = solveDigitPadIk(pose, digit, [localTarget.x, localTarget.y, localTarget.z], options);
  return {
    ...grip,
    name,
    pose,
    depth: penetration(pose, grip.shapes).depth,
    miss
  };
}

const fingertipFk = createHandFk();

/** World (weapon-space) position of a digit's distal pad, `along` its last phalanx. */
export function fingerPadPosition(
  grip: HandGrip,
  digit: number,
  pose: ArrayLike<number> = grip.pose,
  along = 0.5
): Vector3 {
  computeDigitFk(pose, digit, fingertipFk);
  const digitDef = DIGITS[digit];
  const jointBase = digit * 4;
  const pad = new Vector3()
    .copy(fingertipFk.j[jointBase + 2])
    .lerp(fingertipFk.j[jointBase + 3], along);
  pad.addScaledVector(
    new Vector3(0, -1, 0).applyQuaternion(fingertipFk.q[digit * 3 + 2]),
    digitDef.rad[2] + (digitDef.rad[3] - digitDef.rad[2]) * along
  );
  if (grip.side === 'left') pad.x = -pad.x;
  return pad.applyMatrix4(new Matrix4().compose(grip.p, grip.q, UNIT_SCALE));
}

const searchFk = createHandFk();
const padPos = new Vector3();
const padNormal = new Vector3();

/** Cost of a candidate digit pose: pad distance to the target plus a penetration penalty. */
function fingerPlacementCost(
  pose: ArrayLike<number>,
  digit: number,
  colliders: HandCollider[],
  targetX: number,
  targetY: number,
  targetZ: number,
  skin: number,
  thumbRoot: number
): { cost: number; miss: number; deep: number } {
  computeDigitFk(pose, digit, searchFk);
  const digitDef = DIGITS[digit];
  const joints = searchFk.j;
  const jointBase = digit * 4;
  let deepest = -1e9;
  for (let phalanx = digit === 0 ? 1 : 0; phalanx < 3; phalanx++) {
    const from = joints[jointBase + phalanx];
    const to = joints[jointBase + phalanx + 1];
    const tipCut = phalanx === 2 ? digitDef.rad[3] / digitDef.len[2] : 0;
    for (let k = 0; k < 6; k++) {
      const along = digit === 0 && phalanx === 1 ? thumbRoot + ((1 - thumbRoot) * k) / 5 : k / 5;
      const t = along * (1 - tipCut);
      const depth =
        digitDef.rad[phalanx] +
        (digitDef.rad[phalanx + 1] - digitDef.rad[phalanx]) * along -
        minColliderDistance(
          colliders,
          from.x + (to.x - from.x) * t,
          from.y + (to.y - from.y) * t,
          from.z + (to.z - from.z) * t
        );
      if (depth > deepest) deepest = depth;
    }
  }
  padPos.copy(joints[jointBase + 2]).lerp(joints[jointBase + 3], 0.55);
  padNormal.set(0, -1, 0).applyQuaternion(searchFk.q[digit * 3 + 2]);
  padPos.addScaledVector(padNormal, digitDef.rad[2] + (digitDef.rad[3] - digitDef.rad[2]) * 0.55);
  const miss = Math.hypot(padPos.x - targetX, padPos.y - targetY, padPos.z - targetZ);
  return {
    cost: miss + 6 * Math.max(0, deepest + skin),
    miss,
    deep: deepest
  };
}

/** Grid-searches the four joint angles of `digit` (3 refinement passes) to put its pad on `target`. */
export function searchFingerPose(
  grip: HandGrip,
  name: string,
  digit: number,
  target: ArrayLike<number>,
  options: FingerSearchOptions = {}
): GripFit {
  const localTarget = new Vector3(target[0], target[1], target[2]).applyMatrix4(
    new Matrix4().compose(grip.p, grip.q, UNIT_SCALE).invert()
  );
  if (grip.side === 'left') localTarget.x = -localTarget.x;
  const pose = Float32Array.from(options.base || grip.pose);
  const jointBase = digit * 4;
  const skin = options.skin ?? 8e-4;
  const lo = [0, 0, 0, 0];
  const hi = [0, 0, 0, 0];
  const best = [0, 0, 0, 0];
  const steps = [7, 6, 4, 5];
  for (let joint = 0; joint < 4; joint++) {
    lo[joint] = LIMITS.min[jointBase + joint];
    hi[joint] = LIMITS.max[jointBase + joint];
  }
  let bestCost = 1e9;
  let bestMiss = 0;
  let bestDeep = 0;
  for (let pass = 0; pass < 3; pass++) {
    const idx = [0, 0, 0, 0];
    for (idx[0] = 0; idx[0] < steps[0]; idx[0]++)
      for (idx[1] = 0; idx[1] < steps[1]; idx[1]++)
        for (idx[2] = 0; idx[2] < steps[2]; idx[2]++)
          for (idx[3] = 0; idx[3] < steps[3]; idx[3]++) {
            for (let joint = 0; joint < 4; joint++)
              pose[jointBase + joint] =
                lo[joint] +
                (hi[joint] - lo[joint]) *
                  (steps[joint] > 1 ? idx[joint] / (steps[joint] - 1) : 0.5);
            const result = fingerPlacementCost(
              pose,
              digit,
              grip.shapes,
              localTarget.x,
              localTarget.y,
              localTarget.z,
              skin,
              options.root ?? 0.35
            );
            if (result.cost < bestCost) {
              bestCost = result.cost;
              bestMiss = result.miss;
              bestDeep = result.deep;
              for (let joint = 0; joint < 4; joint++) best[joint] = pose[jointBase + joint];
            }
          }
    for (let joint = 0; joint < 4; joint++) {
      const cell = (hi[joint] - lo[joint]) / (steps[joint] - 1);
      lo[joint] = Math.max(LIMITS.min[jointBase + joint], best[joint] - cell);
      hi[joint] = Math.min(LIMITS.max[jointBase + joint], best[joint] + cell);
    }
  }
  for (let joint = 0; joint < 4; joint++) pose[jointBase + joint] = best[joint];
  return {
    ...grip,
    name,
    pose,
    depth: penetration(pose, grip.shapes).depth,
    miss: bestMiss,
    deep: bestDeep
  };
}

/** Capsule colliders (weapon space) of the given digits' phalanges, so another hand can grip around them. */
export function fingerColliders(
  grip: HandGrip,
  pose: ArrayLike<number> = grip.pose,
  digits: number[] = [1, 2, 3, 4]
): HandCollider[] {
  const fk = computeHandFk(pose, createHandFk());
  const toWeapon = new Matrix4().compose(grip.p, grip.q, UNIT_SCALE);
  const mirror = grip.side === 'left' ? -1 : 1;
  const colliders: HandCollider[] = [];
  const toWeaponArray = (v: Vector3): number[] =>
    new Vector3(v.x * mirror, v.y, v.z).applyMatrix4(toWeapon).toArray();
  for (const digit of digits)
    for (let phalanx = 0; phalanx < 3; phalanx++) {
      const digitDef = DIGITS[digit];
      const from = fk.j[digit * 4 + phalanx];
      const to = fk.j[digit * 4 + phalanx + 1];
      const end = phalanx === 2 ? to.clone().lerp(from, digitDef.rad[3] / digitDef.len[2]) : to;
      colliders.push(
        capsule(
          toWeaponArray(from),
          toWeaponArray(end),
          (digitDef.rad[phalanx] + digitDef.rad[phalanx + 1]) / 2
        )
      );
    }
  return colliders;
}

/** Bounds of the geometry's vertices that lie inside the box `[min, max]`. */
export function meshBoundsInBox(
  geometry: BufferGeometry,
  min: ArrayLike<number>,
  max: ArrayLike<number>
): MeshBounds {
  const positions = geometry.attributes.position.array;
  const lo = [1e9, 1e9, 1e9];
  const hi = [-1e9, -1e9, -1e9];
  let count = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < min[0] || x > max[0] || y < min[1] || y > max[1] || z < min[2] || z > max[2]) continue;
    count++;
    if (x < lo[0]) lo[0] = x;
    if (x > hi[0]) hi[0] = x;
    if (y < lo[1]) lo[1] = y;
    if (y > hi[1]) hi[1] = y;
    if (z < lo[2]) lo[2] = z;
    if (z > hi[2]) hi[2] = z;
  }
  return {
    min: lo,
    max: hi,
    n: count
  };
}

/** Slices the geometry inside `[min, max]` top-down into `step`-high horizontal bands. */
export function sliceMeshProfile(
  geometry: BufferGeometry,
  min: ArrayLike<number>,
  max: ArrayLike<number>,
  step = 0.01
): MeshProfileSlice[] {
  const slices: MeshProfileSlice[] = [];
  for (let y = max[1]; y > min[1] + 1e-9; y -= step) {
    const bounds = meshBoundsInBox(
      geometry,
      [min[0], Math.max(min[1], y - step), min[2]],
      [max[0], y, max[2]]
    );
    if (bounds.n)
      slices.push({
        y: y - step / 2,
        x0: bounds.min[0],
        x1: bounds.max[0],
        z0: bounds.min[2],
        z1: bounds.max[2],
        n: bounds.n
      });
  }
  return slices;
}

/** Fits straight front/back lines (z as a function of y) through the deep slices of a grip profile. */
export function fitGripProfile(slices: MeshProfileSlice[]): GripProfileFit {
  const maxDepth = Math.max(...slices.map((slice) => slice.z1 - slice.z0));
  const deepSlices = slices.filter((slice) => slice.z1 - slice.z0 > 0.75 * maxDepth);
  const fitLine = (key: 'z0' | 'z1'): [number, number] => {
    let sumY = 0;
    let sumV = 0;
    let sumYY = 0;
    let sumYV = 0;
    for (const slice of deepSlices) {
      sumY += slice.y;
      sumV += slice[key];
      sumYY += slice.y * slice.y;
      sumYV += slice.y * slice[key];
    }
    const count = deepSlices.length;
    const slope = count > 1 ? (count * sumYV - sumY * sumV) / (count * sumYY - sumY * sumY) : 0;
    return [(sumV - slope * sumY) / count, slope];
  };
  const frontLine = fitLine('z0');
  const backLine = fitLine('z1');
  const front = (y: number): number => frontLine[0] + frontLine[1] * y;
  const back = (y: number): number => backLine[0] + backLine[1] * y;
  return {
    rake: Math.atan(-(frontLine[1] + backLine[1]) / 2),
    hw: Math.max(...deepSlices.map((slice) => Math.max(-slice.x0, slice.x1))),
    top: Math.max(...slices.map((slice) => slice.y)),
    bottom: Math.min(...slices.map((slice) => slice.y)),
    front,
    back,
    centre: (y) => (front(y) + back(y)) / 2,
    depth: (y) => back(y) - front(y)
  };
}

const ARM_RIG_DEFAULTS = {
  shoulder: {
    right: [SHOULDER.right[0], SHOULDER.right[1], SHOULDER.right[2]],
    left: [SHOULDER.left[0], SHOULDER.left[1], SHOULDER.left[2]]
  },
  lean: 0.2
};

const createArmTarget = (side: HandSide): ArmTarget => ({
  p: new Vector3(),
  q: new Quaternion(),
  pose: new Float32Array(POSE_LENGTH),
  trig: 0,
  pole: new Vector3().fromArray(DEFAULT_POLE[side]),
  sh: new Vector3().fromArray(ARM_RIG_DEFAULTS.shoulder[side])
});

/** Parent the arms get attached to while a weapon is shown off in the world (showcase). */
interface ArmAttachment {
  root: Object3D;
  /** Inverse rotation of the attach pose. */
  qi: Quaternion;
  /** Position of the attach pose. */
  p: Vector3;
}

/** Creates both first-person arms (parented to the camera on `layer`). */
export function createArmRig(game: Game, layer = 1): ArmRig {
  const rightArm = createArm(game, {
    side: 'right'
  });
  const leftArm = createArm(game, {
    side: 'left'
  });
  const arms = [rightArm, leftArm];
  for (const arm of arms) {
    arm.setLayer(layer);
    if (game.camera) game.camera.add(arm.group);
  }
  const targets: ArmTargets = {
    r: createArmTarget('right'),
    l: createArmTarget('left')
  };
  const targetList = [targets.r, targets.l];
  targets.r.pose.set(POSES.relaxed);
  targets.l.pose.set(POSES.relaxed);
  const armStates: ArmRigState[] = arms.map((arm, index) => ({
    last: createArmTarget(arm.side),
    from: createArmTarget(arm.side),
    fromL: {
      p: new Vector3(),
      q: new Quaternion()
    },
    v: new Vector3(),
    w: new Vector3(),
    side: index ? -1 : 1
  }));
  const handPos = new Vector3();
  const handQuat = new Quaternion();
  const polePos = new Vector3();
  const blendPose = new Float32Array(POSE_LENGTH);
  const solveOptions = {
    lean: ARM_RIG_DEFAULTS.lean
  };
  const attachQuat = new Quaternion();
  const invQuat = new Quaternion();
  const attachOffset = new Vector3();
  const shoulderPos = new Vector3();
  const spinAxis = new Vector3();
  /** Blend progress 0..1 (1 = fully on the targets). */
  let blendT = 1;
  let blendDuration = 0;
  let visible = true;
  /** Seconds into the drop animation, or -1 when not dropping. */
  let dropT = -1;
  let attachment: ArmAttachment | null = null;
  /** Whether the arms have been solved at least once (so `last` is meaningful). */
  let hasSolved = false;
  /** A blend just started: re-express its `from` targets in camera space. */
  let rebaseBlend = false;
  return {
    right: rightArm,
    left: leftArm,
    list: arms,
    targets,
    state: armStates,
    get dropping() {
      return dropT >= 0;
    },
    setVisible(value) {
      visible = !!value;
      if (dropT < 0) for (const arm of arms) arm.group.visible = visible;
    },
    blend(duration = 0.2) {
      if (hasSolved) {
        for (const state of armStates) {
          state.from.p.copy(state.last.p);
          state.from.q.copy(state.last.q);
          state.from.pose.set(state.last.pose);
          state.from.pole.copy(state.last.pole);
          state.from.sh.copy(state.last.sh);
        }
        blendT = 0;
        blendDuration = duration;
        rebaseBlend = true;
      }
    },
    snap() {
      blendT = 1;
      blendDuration = 0;
      rebaseBlend = false;
    },
    attach(root, pose = null, attachLayer = 0) {
      attachment = root
        ? {
            root,
            qi: new Quaternion(),
            p: new Vector3()
          }
        : null;
      for (const arm of arms) {
        (root || game.camera).add(arm.group);
        arm.setLayer(root ? attachLayer : layer);
      }
      if (root && attachment) {
        // A root without a pose throws here, exactly like the original.
        const attachPose = pose as ViewOffset;
        attachQuat.setFromEuler(
          new Euler(attachPose.r[0], attachPose.r[1], attachPose.r[2], 'YXZ')
        );
        invQuat.copy(attachQuat).invert();
        attachOffset.fromArray(attachPose.p);
        attachment.qi = invQuat.clone();
        attachment.p = attachOffset.clone();
      }
      blendT = 1;
    },
    update(dt, driver, frame) {
      if (dropT >= 0 || !driver || !driver.armTargets) return;
      driver.armTargets(targets, dt);
      const weight =
        blendT < 1 && blendDuration > 0 ? smootherstep((blendT += dt / blendDuration)) : 1;
      if (weight >= 1) blendT = 1;
      if (rebaseBlend) {
        rebaseBlend = false;
        invQuat.copy(frame.quaternion).invert();
        for (const state of armStates) {
          state.fromL.p.copy(state.from.p).sub(frame.position).applyQuaternion(invQuat);
          state.fromL.q.copy(invQuat).multiply(state.from.q);
        }
      }
      if (weight < 1)
        for (const state of armStates) {
          state.from.p.copy(state.fromL.p).applyQuaternion(frame.quaternion).add(frame.position);
          state.from.q.copy(frame.quaternion).multiply(state.fromL.q);
        }
      for (let index = 0; index < 2; index++) {
        const target = targetList[index];
        const state = armStates[index];
        const arm = arms[index];
        let pose: Float32Array = target.pose;
        if (attachment) {
          handPos.copy(target.p);
          handQuat.copy(target.q);
          polePos.copy(target.pole).applyQuaternion(attachment.qi);
          shoulderPos.copy(target.sh).sub(attachment.p).applyQuaternion(attachment.qi);
        } else {
          handPos.copy(target.p).applyQuaternion(frame.quaternion).add(frame.position);
          handQuat.copy(frame.quaternion).multiply(target.q);
          polePos.copy(target.pole);
          shoulderPos.copy(target.sh);
        }
        if (weight < 1) {
          handPos.lerpVectors(state.from.p, handPos, weight);
          handQuat.slerpQuaternions(state.from.q, handQuat, weight);
          polePos.lerpVectors(state.from.pole, polePos, weight);
          shoulderPos.lerpVectors(state.from.sh, shoulderPos, weight);
          pose = lerpPose(blendPose, state.from.pose, target.pose, weight);
        }
        state.last.p.copy(handPos);
        state.last.q.copy(handQuat);
        state.last.pose.set(pose);
        state.last.pole.copy(polePos);
        state.last.sh.copy(shoulderPos);
        arm.setFingers(pose);
        arm.setTrigger(target.trig);
        arm.solve(shoulderPos, handPos, handQuat, polePos, solveOptions);
        arm.update(dt);
      }
      hasSolved = true;
    },
    startDrop(random = Math.random) {
      if (hasSolved) {
        dropT = 0;
        blendT = 1;
        for (const state of armStates) {
          state.from.p.copy(state.last.p);
          state.from.q.copy(state.last.q);
          state.from.pose.set(state.last.pose);
          state.v.set(state.side * (0.1 + random() * 0.08), -0.05, 0.1);
          state.w.set(-1.5 - random() * 0.5, state.side * 0.5, state.side * (0.7 + random() * 0.4));
        }
      }
    },
    dropUpdate(dt) {
      if (dropT < 0) return;
      dropT += dt;
      const relax = smootherstep(dropT / 0.15);
      for (let index = 0; index < 2; index++) {
        const state = armStates[index];
        const arm = arms[index];
        if (!arm.group.visible) continue;
        state.v.y -= 2.2 * dt;
        state.from.p.addScaledVector(state.v, dt);
        const spin = state.w.length() * dt;
        if (spin > 0) {
          handQuat.setFromAxisAngle(spinAxis.copy(state.w).normalize(), spin);
          state.from.q.multiply(handQuat);
        }
        arm.setFingers(lerpPose(blendPose, state.from.pose, POSES.relaxed, relax));
        arm.setTrigger(0);
        arm.solve(state.last.sh, state.from.p, state.from.q, state.last.pole, solveOptions);
        arm.update(dt);
        state.last.p.copy(state.from.p);
        state.last.q.copy(state.from.q);
        if (dropT > 0.9 || state.from.p.y < -0.6) arm.group.visible = false;
      }
    },
    restore() {
      if (!(dropT < 0)) {
        dropT = -1;
        blendT = 1;
        hasSolved = false;
        for (const arm of arms) arm.group.visible = visible;
      }
    },
    report() {
      return arms.map((arm) => ({
        side: arm.side,
        reach: arm.ik.reach,
        violation: arm.ik.violation,
        lean: arm.ik.lean,
        flex: arm.ik.wristFlex,
        deviation: arm.ik.wristDeviation,
        twist: arm.ik.twist
      }));
    },
    dispose() {
      for (const arm of arms) arm.dispose();
    }
  };
}
