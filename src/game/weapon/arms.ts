/**
 * First-person arms: the skinned glove + sleeve mesh (with its procedural
 * fabric/leather/rubber shader), the per-arm two-bone IK with wrist twist
 * distribution, finger posing and recoil "impulse" springs, collider helpers
 * used by grip fitting, and the `?show=hands` debug showcase.
 */
import * as THREE from 'three';
import {
  Bone,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Euler,
  Group,
  Matrix4,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Sphere,
  Vector3
} from 'three';
import type { Material, MeshStandardMaterial } from 'three';
import { VIEWMODEL_LAYER, WORLD_LAYER } from '../core/config';
import type { CameraShot, Game } from '../core/types';
import { ARM, SHOULDER } from './animConfig';
import {
  BONE,
  BONE_NAMES,
  DIGITS,
  DIGIT_NAMES,
  POSES,
  POSE_LENGTH,
  REST,
  box,
  capsule,
  clampPose,
  curlUntilContact,
  fingerSelfPenetration,
  lerpPose,
  penetration,
  phalanxLocalRotation,
  resolvePose,
  transformColliders
} from './hand/skeleton';
import type {
  BoxCollider,
  CapsuleCollider,
  Collider,
  CurlOptions,
  PenetrationResult,
  PointSdf,
  PoseRef,
  SelfPenetrationResult
} from './hand/skeleton';
import { GLOVE_LANDMARKS, buildGloveMesh, mirrorGloveMesh, palmSdf } from './hand/glove';
import { GRIPS, handSocket, installReferencePoses } from './hand/grips';
import type { HandSide } from './gripSolver';

/** A hand collision shape (see `capsule()` / `box()`). */
export type HandCollider = Collider;
/** A finger pose: a 20-float joint array or the name of a pose in `POSES`. */
export type PoseLike = PoseRef;
/** Signed distance from the palm surface. */
export type PalmSdf = PointSdf;
export type { CapsuleCollider, BoxCollider, CurlOptions };

/** Options of `Arm.fitGrip`. */
export interface ArmFitOptions extends CurlOptions {
  /** Space the colliders are given in (default: hand space). */
  space?: 'parent' | 'world';
  /** Apply the fitted pose to the arm (default true). */
  apply?: boolean;
}

/** A position given either as a vector or as `[x, y, z]`. */
export type Vec3Like = Vector3 | ArrayLike<number>;

/** IK diagnostics of the last `solve`. */
export interface ArmIk {
  /** How far the wrist target was out of reach. */
  reach: number;
  wristFlex: number;
  wristDeviation: number;
  twist: number;
  /** Largest wrist limit violation (radians). */
  violation: number;
  /** How far the shoulder leaned towards the target. */
  lean: number;
  elbow: Vector3;
  shoulder: Vector3;
}

/** Options of `Arm.solve`. */
export interface ArmSolveOptions {
  /** Maximum shoulder lean towards an out-of-reach target (metres). */
  lean?: number;
}

/** Options of `createArm`. */
export interface ArmOptions {
  side?: HandSide;
  material?: Material;
  layer?: number;
}

/** One skinned first-person arm. All setters return the arm for chaining. */
export interface Arm {
  side: HandSide;
  group: Group;
  mesh: SkinnedMesh;
  bones: Bone[];
  skeleton: Skeleton;
  ik: ArmIk;
  /** Target finger pose (before trigger pull / impulse offsets). */
  pose: Float32Array;
  hand: Bone;
  bone: Record<string, Bone>;
  triCount: number;
  setLayer(layer: number): Arm;
  setVisible(visible: boolean): Arm;
  setFingers(pose: PoseLike, weight?: number): Arm;
  blendFingers(from: PoseLike, to: PoseLike, t: number): Arm;
  setFinger(digit: number | string, joints: ArrayLike<number>, weight?: number): Arm;
  setTrigger(pull: number): Arm;
  readonly trigger: number;
  /** Pose actually shown (with trigger pull and impulse offsets, clamped). */
  readonly shown: Float32Array;
  solve(
    shoulder: Vec3Like,
    wrist: Vec3Like,
    hand: Quaternion,
    pole?: Vec3Like | null,
    options?: ArmSolveOptions | null
  ): ArmIk;
  solveMatrix(
    shoulder: Vec3Like,
    handMatrix: Matrix4,
    pole?: Vec3Like | null,
    options?: ArmSolveOptions | null
  ): ArmIk;
  /** Searches the elbow pole direction with the least wrist limit violation. */
  findPole(shoulder: Vec3Like, wrist: Vec3Like, hand: Quaternion, pole?: Vec3Like | null): Vector3;
  fitGrip(colliders: HandCollider[], options?: ArmFitOptions): Float32Array;
  /** Hand placement (`outPos` / `outQuat`) that puts grip `name`'s frame at `position` / `rotation`. */
  socket(
    name: string,
    position: Vector3,
    rotation: Quaternion,
    outPos: Vector3,
    outQuat: Quaternion
  ): Vector3;
  gripFrame(name: string, outPos: Vector3, outQuat: Quaternion): Vector3;
  penetration(colliders: HandCollider[], out?: PenetrationResult): PenetrationResult;
  selfPenetration(out?: SelfPenetrationResult): SelfPenetrationResult;
  /** Kicks the finger / wrist springs (recoil, magazine slap). */
  impulse(strength?: number): void;
  update(dt: number): void;
  dispose(): void;
}

/** Glove / sleeve colours (linear RGB). */
export const GLOVE_COLORS = {
  olive: [0.15, 0.156, 0.094],
  gusset: [0.066, 0.071, 0.05],
  tan: [0.33, 0.245, 0.14],
  tanDark: [0.235, 0.172, 0.1],
  rubber: [0.06, 0.062, 0.068],
  stitch: [0.5, 0.44, 0.3],
  cuff: [0.062, 0.066, 0.056],
  strap: [0.036, 0.038, 0.04],
  tab: [0.56, 0.15, 0.03],
  navy: [0.046, 0.068, 0.106],
  hem: [0.028, 0.04, 0.062],
  orange: [0.5, 0.145, 0.028],
  refl: [0.42, 0.42, 0.4]
};
/** Rain wetness (0..1) shared by the arm shader. */
export const armWetUniform = {
  value: 0.7
};
const GLOVE_PALETTE = GLOVE_COLORS;
const FINGER_JOINT_SPANS = DIGITS.map((digit) => [
  digit.len[0],
  digit.len[0] + digit.len[1],
  digit.total
]);
const WEB_PATCH = GLOVE_LANDMARKS.web;
const WEB_SADDLE_START = WEB_PATCH.c.map((value, axis) => value - WEB_PATCH.ab[axis] * 0.009);
const WEB_SADDLE_DIR = WEB_PATCH.ab.map((value) => value * 0.018);
const WEB_SADDLE_LEN_SQ =
  WEB_SADDLE_DIR[0] * WEB_SADDLE_DIR[0] +
  WEB_SADDLE_DIR[1] * WEB_SADDLE_DIR[1] +
  WEB_SADDLE_DIR[2] * WEB_SADDLE_DIR[2];
const KNUCKLE_GUARD_ELLIPSOIDS = GLOVE_LANDMARKS.guard.map((guard) => [
  guard.c[0],
  guard.c[1],
  guard.c[2],
  Math.cos(guard.yaw),
  Math.sin(guard.yaw),
  1 / (guard.r[0] + 0.001),
  1 / (guard.r[1] + 0.0035),
  1 / (guard.r[2] + 0.001)
]);
const PALM_HEEL_ELLIPSE = [0.0165, -0.037, 0.02, 0.028];
const KNUCKLE_PLATE_LINE = [-0.047, 0.0085, 0.22];

/** Formats a number as a GLSL float literal. */
const glslFloat = (value: number): string => {
  const text = (+value).toPrecision(6).replace(/\.?0+$/, '');
  return /[.e]/.test(text) ? text : text + '.0';
};
const glslVec3 = (values: number[]): string => `vec3(${values.map(glslFloat).join(', ')})`;
/** GLSL expression selecting joint span `joint` of finger `F`. */
const glslFingerJointSelect = (joint: number): string =>
  `(F < 0.5 ? ${glslFloat(FINGER_JOINT_SPANS[0][joint])} : F < 1.5 ? ${glslFloat(FINGER_JOINT_SPANS[1][joint])} : F < 2.5 ? ${glslFloat(FINGER_JOINT_SPANS[2][joint])} : F < 3.5 ? ${glslFloat(FINGER_JOINT_SPANS[3][joint])} : ${glslFloat(FINGER_JOINT_SPANS[4][joint])})`;

const ARM_SHADER_CHUNK = `
float aBand(float x, float a, float b, float w) { return smoothstep(a - w, a, x) * (1.0 - smoothstep(b, b + w, x)); }
float aHash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float aNoise(vec3 x) { vec3 i = floor(x), q = fract(x); q = q * q * (3.0 - 2.0 * q);
  return mix(mix(mix(aHash(i), aHash(i + vec3(1, 0, 0)), q.x), mix(aHash(i + vec3(0, 1, 0)), aHash(i + vec3(1, 1, 0)), q.x), q.y),
             mix(mix(aHash(i + vec3(0, 0, 1)), aHash(i + vec3(1, 0, 1)), q.x), mix(aHash(i + vec3(0, 1, 1)), aHash(i + vec3(1, 1, 1)), q.x), q.y), q.z); }
// hc = (A, F, D, S), rs = rest position + zone. Returns albedo; rough, h (metres), kind as in surfaceJS.
vec3 armSurface(vec4 hc, vec4 rs, float gD, out float rough, out float h, out float kind) {
  float A = hc.x, F = hc.y, D = hc.z, S = hc.w, x = rs.x, y = rs.y, z = rs.z; vec3 col; h = 0.0;
  if (rs.w > 0.5) {
    float ang = atan(D, S);
    col = ${glslVec3(GLOVE_PALETTE.navy)}; rough = 0.50; kind = 4.0;
    col *= 0.80 + 0.26 * smoothstep(-0.9, 0.6, F);
    float bandM = aBand(A, 0.128, 0.172, 0.0012), refl = aBand(A, 0.1445, 0.1555, 0.0008);
    col = mix(col, ${glslVec3(GLOVE_PALETTE.orange)}, bandM); col = mix(col, ${glslVec3(GLOVE_PALETTE.refl)}, refl); rough = mix(rough, 0.62, bandM); rough = mix(rough, 0.30, refl); kind = mix(kind, 5.0, refl);
    h += 0.00035 * bandM + 0.00015 * refl;
    float edge = aBand(A, 0.1268, 0.1292, 0.0006) + aBand(A, 0.1708, 0.1732, 0.0006);
    col = mix(col, ${glslVec3(GLOVE_PALETTE.stitch)}, 0.55 * edge * step(fract(ang * 9.5), 0.62));
    float hem = 1.0 - smoothstep(0.0655, 0.0675, A), rib = 0.5 + 0.5 * cos(ang * 44.0);
    col = mix(col, ${glslVec3(GLOVE_PALETTE.hem)}, hem); col *= mix(1.0, 0.62 + 0.5 * rib, hem); h += 0.0007 * rib * hem; rough = mix(rough, 0.82, hem); kind = mix(kind, 3.0, hem);
    float sa = atan(sin(ang + 1.9), cos(ang + 1.9)) / 0.045, seam = exp(-sa * sa) * (1.0 - hem);
    rough = mix(rough, 0.34, seam * 0.8); col *= 1.0 - 0.25 * seam;
  } else {
    float j1 = ${glslFingerJointSelect(0)}, j2 = ${glslFingerJointSelect(1)}, j3 = ${glslFingerJointSelect(2)};
    float u = A < j1 ? A / j1 : A < j2 ? 1.0 + (A - j1) / (j2 - j1) : 2.0 + (A - j2) / (j3 - j2);
    float thumb = 1.0 - smoothstep(0.35, 0.65, F), digit = smoothstep(0.003, 0.010, A), cuff = smoothstep(0.0045, 0.0060, z);
    float sw = 0.025 + 0.31 * digit * mix(1.0, smoothstep(0.9, 1.15, u), thumb);
    float back = smoothstep(sw - 0.035, sw + 0.035, D), palmar = 1.0 - smoothstep(-sw - 0.035, -sw + 0.035, D), side = 1.0 - back - palmar;
    float r = length(rs.xyz);
    col = ${glslVec3(GLOVE_PALETTE.olive)}; rough = 0.92; kind = 0.0;
    col = mix(col, ${glslVec3(GLOVE_PALETTE.gusset)}, side); rough = mix(rough, 0.95, side);
    col = mix(col, ${glslVec3(GLOVE_PALETTE.tan)}, palmar); rough = mix(rough, 0.66, palmar); kind = mix(kind, 1.0, palmar);
    float cap = smoothstep(2.40, 2.46, u) * (1.0 - palmar);
    col = mix(col, ${glslVec3(GLOVE_PALETTE.tan)}, cap); rough = mix(rough, 0.66, cap); kind = mix(kind, 1.0, cap);
    float ex = (x - ${glslFloat(PALM_HEEL_ELLIPSE[0])}) / ${glslFloat(PALM_HEEL_ELLIPSE[2])}, ez = (z - ${glslFloat(PALM_HEEL_ELLIPSE[1])}) / ${glslFloat(PALM_HEEL_ELLIPSE[3])}, he = sqrt(ex * ex + ez * ez), heelOn = palmar * (1.0 - digit);
    float heel = (1.0 - smoothstep(0.94, 1.0, he)) * heelOn;
    vec3 wv = rs.xyz - ${glslVec3(WEB_SADDLE_START)}, sdv = ${glslVec3(WEB_SADDLE_DIR)}; float wt = clamp(dot(wv, sdv) / ${glslFloat(WEB_SADDLE_LEN_SQ)}, 0.0, 1.0);
    float sdist = length(wv - sdv * wt), saddle = (1.0 - smoothstep(0.0158, 0.0168, sdist)) * (1.0 - smoothstep(0.30, 0.50, D));
    float reinf = max(heel, saddle) * (1.0 - cuff);
    col = mix(col, ${glslVec3(GLOVE_PALETTE.tanDark)}, reinf); rough = mix(rough, 0.76, reinf); h += 0.0005 * reinf; kind = mix(kind, 1.0, reinf);
    float prow = max(aBand(he, 0.86, 0.89, 0.012) * heelOn, aBand(sdist, 0.0138, 0.0144, 0.0003) * (1.0 - smoothstep(-0.25, -0.05, D))) * (1.0 - cuff);
    float ge = 9.0, gE; vec3 gv; vec2 gl = vec2(0.0), gL;
${KNUCKLE_GUARD_ELLIPSOIDS.map(
  (guard) =>
    `    gv = rs.xyz - ${glslVec3(guard.slice(0, 3))}; gL = vec2(gv.x * ${glslFloat(guard[3])} - gv.z * ${glslFloat(guard[4])}, gv.x * ${glslFloat(guard[4])} + gv.z * ${glslFloat(guard[3])}); gE = length(vec3(gL.x * ${glslFloat(guard[5])}, gv.y * ${glslFloat(guard[6])}, gL.y * ${glslFloat(guard[7])})); if (gE < ge) { ge = gE; gl = gL; }`
).join(`
`)}
    float gs = 9.0; vec2 gp, gb;
${[0, 1, 2].map(
  (index) =>
    `    gp = rs.xz - vec2(${glslFloat(KNUCKLE_GUARD_ELLIPSOIDS[index][0])}, ${glslFloat(KNUCKLE_GUARD_ELLIPSOIDS[index][2] + 0.0045)}); gb = vec2(${glslFloat(KNUCKLE_GUARD_ELLIPSOIDS[index + 1][0] - KNUCKLE_GUARD_ELLIPSOIDS[index][0])}, ${glslFloat(KNUCKLE_GUARD_ELLIPSOIDS[index + 1][2] - KNUCKLE_GUARD_ELLIPSOIDS[index][2])}); gs = min(gs, length(gp - gb * clamp(dot(gp, gb) / dot(gb, gb), 0.0, 1.0)));`
).join(`
`)}
    float lobe = clamp(1.15 - ge, 0.0, 1.0), guard = max(1.0 - smoothstep(0.94, 1.0, ge), (1.0 - smoothstep(0.0066, 0.0074, gs)) * smoothstep(0.004, 0.006, y - ${glslFloat(KNUCKLE_GUARD_ELLIPSOIDS[1][1] - 0.011)})) * smoothstep(0.15, 0.35, D);
    float top = smoothstep(0.835, 0.875, D), fs = fract(u);
    float ribs = aBand(fs, 0.24, 0.80, 0.02) * (1.0 - 0.85 * (aBand(fs, 0.405, 0.435, 0.008) + aBand(fs, 0.605, 0.635, 0.008)));
    float bars = top * ribs * (u < 2.0 ? 1.0 : 0.0) * (u < 1.0 ? 1.0 - thumb : 1.0) * digit;
    float rz = (${glslFloat(KNUCKLE_PLATE_LINE[0])} + ${glslFloat(KNUCKLE_PLATE_LINE[2])} * x - z) / ${glslFloat(KNUCKLE_PLATE_LINE[1])}, ri = clamp(floor(rz + 0.5), 0.0, 2.0);
    float plate = aBand((rz - ri) * ${glslFloat(KNUCKLE_PLATE_LINE[1])}, -0.0016, 0.0016, 0.0006) * aBand(x, -0.0175 + 0.004 * ri, 0.0200 - 0.002 * ri, 0.0012) * smoothstep(0.62, 0.70, D) * (1.0 - digit);
    float rub = max(guard, max(bars, plate));
    col = mix(col, ${glslVec3(GLOVE_PALETTE.rubber)}, rub); rough = mix(rough, 0.46, rub); kind = mix(kind, 2.0, rub);
    float rim = aBand(ge, 0.80, 0.87, 0.02) * guard;
    float slot = (aBand(gl.y, -0.0052, -0.0036, 0.0004) + aBand(gl.y, 0.0012, 0.0028, 0.0004)) * aBand(gl.x, -0.0052, 0.0052, 0.0006) * (1.0 - smoothstep(0.70, 0.80, ge)) * guard;
    h += 0.0011 * bars + 0.0010 * plate + 0.0006 * guard * (0.4 + 0.6 * lobe) - 0.00035 * rim - 0.0006 * slot;
    col *= (1.0 + 0.5 * guard * lobe * lobe) * (1.0 - 0.3 * rim) * (1.0 - 0.55 * slot);
    float dash = step(fract(r / 0.0024), 0.60), free = (1.0 - rub) * (1.0 - cuff) * (1.0 - saddle);
    float gd = clamp(gD, 25.0, 700.0), sA = abs(D - sw) / gd, sB = abs(D + sw) / gd, sd = min(sA, sB), groove = (1.0 - smoothstep(0.0, 0.0006, sd)) * free;
    float row = aBand(sd, 0.0010, 0.0016, 0.00025) * free * (sA < sB ? step(sw, D) : step(D, -sw));
    float cs = abs(u - 2.43) * (j3 - j2), capSeam = (1.0 - smoothstep(0.0, 0.0006, cs)) * (1.0 - palmar);
    float capRow = aBand(cs, 0.0010, 0.0016, 0.00025) * (1.0 - palmar) * step(fract(S * 5.5 + D * 2.0), 0.6);
    float gr = max(groove, capSeam); h -= 0.00045 * gr; col *= 1.0 - 0.45 * gr;
    float st = max(row * dash, max(capRow, prow * 0.55)); col = mix(col, ${glslVec3(GLOVE_PALETTE.stitch)}, 0.85 * st); h += 0.00022 * st;
    float c1 = (A - j1) / 0.0013, c2 = (A - j2) / 0.0013, c0 = (A - 0.0135) / 0.0014;
    float cre = (exp(-c1 * c1) + exp(-c2 * c2)) * digit, root = exp(-c0 * c0) * (1.0 - thumb) * palmar;
    h -= 0.0006 * (cre * palmar + root) + 0.00025 * cre * back * (1.0 - rub); col *= 1.0 - 0.35 * (cre * palmar + root);
    float ang = atan(y, x), rib = 0.5 + 0.5 * cos(ang * 46.0);
    col = mix(col, ${glslVec3(GLOVE_PALETTE.cuff)}, cuff); col *= mix(1.0, 0.70 + 0.45 * rib, cuff); h = mix(h, 0.0005 * rib, cuff); rough = mix(rough, 0.88, cuff); kind = mix(kind, 3.0, cuff);
    float strap = aBand(z, 0.0165, 0.0345, 0.0005) * smoothstep(-0.55, -0.45, D) * cuff;
    col = mix(col, ${glslVec3(GLOVE_PALETTE.strap)}, strap); h = mix(h, 0.0012, strap); rough = mix(rough, 0.80, strap); kind = mix(kind, 0.0, strap);
    float tabE = strap * aBand(x, 0.0080, 0.0280, 0.0008) * smoothstep(0.2, 0.3, D); col = mix(col, ${glslVec3(GLOVE_PALETTE.rubber)}, tabE); h += 0.0009 * tabE; rough = mix(rough, 0.45, tabE); kind = mix(kind, 2.0, tabE);
    float srow = strap * (1.0 - tabE) * (aBand(z, 0.0176, 0.0186, 0.0003) + aBand(z, 0.0324, 0.0334, 0.0003)) * step(fract(ang * 14.0), 0.6); col = mix(col, ${glslVec3(GLOVE_PALETTE.stitch)}, 0.8 * srow);
    float tab = aBand(z, 0.0078, 0.0140, 0.0003) * aBand(x, -0.0225, -0.0090, 0.0005) * smoothstep(0.3, 0.4, D); col = mix(col, ${glslVec3(GLOVE_PALETTE.tab)}, tab); h += 0.0006 * tab; rough = mix(rough, 0.7, tab); kind = mix(kind, 0.0, tab);
    col *= 1.0 - 0.4 * aBand(z, 0.0040, 0.0064, 0.0006);
  }
  return col;
}
// sub-millimetre detail by kind: weave (0), pebbled grain (1), moulded rubber (2), knit rib (3), waxed ripstop + beads (4), glass bead tape (5)
vec3 armMicro(vec3 col, vec4 hc, vec4 rs, vec3 rn, float kind, float wet, inout float rough, inout float h) {
  vec3 p = rs.xyz, an = abs(rn); an = an * an; an /= an.x + an.y + an.z + 1e-5;
  float px = max(length(dFdx(p)), length(dFdy(p))), fine = 1.0 - smoothstep(0.00018, 0.00050, px);      // fade detail the pixels cannot hold
  float wf = 5712.0, weave = (sin(p.y * wf) * sin(p.z * wf)) * an.x + (sin(p.x * wf) * sin(p.z * wf)) * an.y + (sin(p.x * wf) * sin(p.y * wf)) * an.z;
  float n1 = aNoise(p * 950.0), n2 = aNoise(p * 2300.0 + 7.3), big = aNoise(p * 90.0 + 3.1);
  float kFab = 1.0 - min(1.0, abs(kind - 0.0)), kLea = 1.0 - min(1.0, abs(kind - 1.0)), kRub = 1.0 - min(1.0, abs(kind - 2.0)), kRib = 1.0 - min(1.0, abs(kind - 3.0)), kShell = 1.0 - min(1.0, abs(kind - 4.0)), kRefl = 1.0 - min(1.0, abs(kind - 5.0));
  h += fine * (kFab * 0.00005 * weave + kLea * 0.00011 * (n1 * 0.7 + n2 * 0.3 - 0.5) + kRub * 0.00003 * (n2 - 0.5) + kRib * 0.00006 * weave + kShell * 0.000035 * weave + kRefl * 0.00004 * (n2 - 0.5));
  col *= 1.0 + fine * (kFab * 0.06 * weave + kLea * 0.16 * (n1 - 0.5) + kRib * 0.08 * weave + kShell * 0.04 * weave) + (big - 0.5) * (0.16 * kLea + 0.10 * kFab + 0.10 * kShell + 0.06 * kRub);
  rough += (big - 0.5) * (0.10 * kLea + 0.10 * kShell + 0.12 * kRub) + fine * (n1 - 0.5) * 0.10 * kLea;
  // rain beads on the shell (laid out in the sleeve's own angle / length coordinates) and, sparser, on the rubber
  if (wet > 0.01 && (kShell + kRefl + kRub) > 0.3) {
    vec2 q = rs.w > 0.5 ? vec2(atan(hc.z, hc.w) * 0.046, hc.x) : vec2(dot(p, vec3(0.8, 0.0, 0.6)), dot(p, vec3(-0.42, 0.7, 0.57)));
    float bead = 0.0, wetR = 0.0;
    for (int o = 0; o < 2; o++) {
      float cell = o == 0 ? 0.0085 : 0.0041; vec2 g = q / cell + float(o) * 13.7, id = floor(g), fr = fract(g);
      float r1 = aHash(vec3(id, 1.0 + float(o))), r2 = aHash(vec3(id, 5.0)), r3 = aHash(vec3(id, 9.0));
      float rad = (o == 0 ? 0.0019 : 0.0010) * (0.55 + 0.6 * r3), on = step(r1, (o == 0 ? 0.42 : 0.5) * wet * (rs.w > 0.5 ? 1.0 : 0.5));
      float d = length((fr - (0.25 + 0.5 * vec2(r2, r3))) * cell) / rad;
      bead = max(bead, on * sqrt(max(0.0, 1.0 - d * d)) * rad * 0.55); wetR = max(wetR, on * (1.0 - smoothstep(0.85, 1.0, d)));
    }
    h += bead; rough = mix(rough, 0.07, wetR); col *= 1.0 - 0.18 * wetR;
  }
  rough = clamp(rough, 0.05, 1.0);
  return col;
}
vec3 armBump(vec3 N, vec3 vp, float h) {
  vec3 dpx = dFdx(vp), dpy = dFdy(vp), r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1); vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * N - g);
}
`;

/** Builds the arm material: a MeshStandardMaterial whose shader is patched with the procedural glove surface. */
function createArmMaterial(three: typeof THREE): MeshStandardMaterial {
  const material = new three.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0
  });
  material.name = 'saltline_arm';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uArmWet = armWetUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aRest; attribute vec4 aHand; varying vec4 vArmRest; varying vec4 vArmHand; varying vec3 vArmN;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vArmRest = aRest; vArmHand = aHand; vArmN = normal;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uArmWet; varying vec4 vArmRest; varying vec4 vArmHand; varying vec3 vArmN;
` + ARM_SHADER_CHUNK
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  vec3 armPx = dFdx(-vViewPosition), armPy = dFdy(-vViewPosition), armNg = normalize(cross(armPx, armPy)), armR1 = cross(armPy, armNg), armR2 = cross(armNg, armPx);
  float armGD = length(dFdx(vArmHand.z) * armR1 + dFdy(vArmHand.z) * armR2) / max(abs(dot(armPx, armR1)), 1e-12);
  float armRough, armH, armKind; vec3 armCol = armSurface(vArmHand, vArmRest, armGD, armRough, armH, armKind);
  armCol = armMicro(armCol, vArmHand, vArmRest, normalize(vArmN), armKind, uArmWet, armRough, armH);
  diffuseColor.rgb = armCol;`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = armRough;`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  normal = armBump(normal, -vViewPosition, armH);`
      );
  };
  material.customProgramCacheKey = () => 'saltline-arm-1';
  return material;
}

installReferencePoses();

export const ArmVec3 = Vector3;
export const ArmQuat = Quaternion;
export const ArmMat4 = Matrix4;
export const UPPER_ARM_LENGTH = ARM.upper;
export const FOREARM_LENGTH = ARM.fore;
export const ARM_PI = Math.PI;
/** Share of the wrist twist taken by the two forearm twist bones. */
export const TWIST_SHARE = [0.42, 0.84];
/** Wrist joint limits (radians). */
export const WRIST_LIMITS = {
  flex: [-1.22, 1.4],
  deviation: [-0.61, 0.35],
  twist: [-1.66, 1.66]
};
/** Default elbow pole direction per side. */
export const DEFAULT_POLE: Record<HandSide, number[]> = {
  right: [0.8, -0.6, 0],
  left: [-0.8, -0.6, 0]
};
/** Index-finger joint offsets at full trigger pull. */
export const TRIGGER_PULL = [0.04, 0.22, 0.16, 0];
/** Knuckle bulge (fraction of phalanx radius) per phalanx. */
export const KNUCKLE_BULGE = [0.16, 0.2, 0.2];
/** Finger/finger and finger/palm self-penetration of a pose. */
export const selfPenetration = (
  pose: PoseLike,
  out?: SelfPenetrationResult
): SelfPenetrationResult => fingerSelfPenetration(pose, palmSdf, out);
/** Curls the fingers onto colliders (hand space), using the palm SDF unless `options.palm` is given. */
export const fitGrip = (colliders: HandCollider[], options: CurlOptions = {}): Float32Array =>
  curlUntilContact(
    colliders,
    options.palm === undefined
      ? {
          ...options,
          palm: palmSdf
        }
      : options
  );

/** Mirrors colliders across the YZ plane (right hand <-> left hand). */
export function mirrorColliders(colliders: HandCollider[]): HandCollider[] {
  return colliders.map((collider) =>
    collider.type === 'capsule'
      ? capsule(
          [-collider.a[0], collider.a[1], collider.a[2]],
          [-collider.b[0], collider.b[1], collider.b[2]],
          collider.r
        )
      : box(
          [-collider.c[0], collider.c[1], collider.c[2]],
          collider.h,
          [collider.q[0], -collider.q[1], -collider.q[2], collider.q[3]],
          collider.r
        )
  );
}

const armGeometryCache: Partial<Record<HandSide, BufferGeometry>> = {};

/** The skinned glove + sleeve geometry for one side (built once, cached). */
export function armGeometry(side: HandSide = 'right'): BufferGeometry {
  const cached = armGeometryCache[side];
  if (cached) return cached;
  const mesh = side === 'left' ? mirrorGloveMesh(buildGloveMesh()) : buildGloveMesh();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(mesh.position, 3));
  geometry.setAttribute('normal', new BufferAttribute(mesh.normal, 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(mesh.skinIndex, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(mesh.skinWeight, 4));
  geometry.setAttribute('aRest', new BufferAttribute(mesh.rest, 4));
  geometry.setAttribute('aHand', new BufferAttribute(mesh.hand, 4));
  geometry.setIndex(new BufferAttribute(mesh.index, 1));
  geometry.boundingSphere = new Sphere(new Vector3(0, 0, 0.2), 0.7);
  geometry.boundingBox = new Box3(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.9));
  geometry.userData = {
    triCount: mesh.triCount,
    buildMs: mesh.ms
  };
  armGeometryCache[side] = geometry;
  return geometry;
}

let sharedArmMaterial: MeshStandardMaterial | null = null;

/** The shared arm material (created on first use). */
export function armMaterial(): MeshStandardMaterial {
  return sharedArmMaterial || (sharedArmMaterial = createArmMaterial(THREE));
}

const tmpArmOffset = new Vector3();
const tmpSolvePos = new Vector3();
const tmpMirroredPos = new Vector3();
const tmpShoulder = new Vector3();
const tmpWrist = new Vector3();
const tmpElbow = new Vector3();
const tmpReachDir = new Vector3();
const tmpPole = new Vector3();
const tmpBasisX = new Vector3();
const tmpBasisY = new Vector3();
const tmpBasisZ = new Vector3();
const tmpWristRel = new Quaternion();
const tmpWristSwing = new Quaternion();
const tmpHandQuat = new Quaternion();
const tmpUpperArmQuat = new Quaternion();
const tmpForearmQuat = new Quaternion();
const tmpBasisMat = new Matrix4();
const tmpSolveScale = new Vector3();
const ARM_AXIS_Z = new Vector3(0, 0, 1);
const tmpGunEuler = new Euler();
const isVector3 = (value: Vec3Like): value is Vector3 => !!(value as Vector3).isVector3;
const toArmVec3 = (value: Vec3Like, out: Vector3): Vector3 =>
  isVector3(value) ? out.copy(value) : out.set(value[0], value[1], value[2]);

/**
 * Creates one arm (bones, skinned mesh, IK). Positions passed to its methods
 * are in the arm group's parent space; the left arm mirrors everything in X.
 * `_game` is unused (kept for call-site compatibility).
 */
export function createArm(_game: Game, options: ArmOptions = {}): Arm {
  const side: HandSide = options.side === 'left' ? 'left' : 'right';
  const mirror = side === 'left' ? -1 : 1;
  const group = new Group();
  group.name = 'arm-' + side;
  const bones = BONE_NAMES.map((name) => {
    const bone = new Bone();
    bone.name = name;
    return bone;
  });
  const upperArm = bones[0];
  const forearm = bones[1];
  const twist1 = bones[2];
  const twist2 = bones[3];
  const handBone = bones[4];
  group.add(upperArm);
  upperArm.add(forearm);
  forearm.add(twist1, twist2, handBone);
  forearm.position.set(0, 0, -UPPER_ARM_LENGTH);
  twist1.position.set(0, 0, -0.09);
  twist2.position.set(0, 0, -0.2);
  handBone.position.set(0, 0, -FOREARM_LENGTH);
  /** Rest-pose local rotation of each phalanx. */
  const restRotations: Quaternion[] = [];
  const phalanxBones: Bone[] = [];
  /** Knuckle helper bones (skin around the joints; half-way rotation plus bulge). */
  const helperBones: Bone[] = [];
  const helperRestPositions: Vector3[] = [];
  for (let digit = 0; digit < 5; digit++)
    for (let phalanx = 0; phalanx < 3; phalanx++) {
      const bone = bones[BONE.digit(digit, phalanx)];
      const helper = bones[BONE.helper(digit, phalanx)];
      const parent = phalanx ? bones[BONE.digit(digit, phalanx - 1)] : handBone;
      const digitDef = DIGITS[digit];
      parent.add(bone, helper);
      if (phalanx) bone.position.set(0, 0, -digitDef.len[phalanx - 1]);
      else bone.position.set(digitDef.base[0] * mirror, digitDef.base[1], digitDef.base[2]);
      helper.position.copy(bone.position);
      helperRestPositions.push(bone.position.clone());
      restRotations.push(phalanxLocalRotation(digit, phalanx, REST, new Quaternion()));
      phalanxBones.push(bone);
      helperBones.push(helper);
    }
  /** Mirrors a rotation for the left arm (in place). */
  const mirrorQuat = (quat: Quaternion): Quaternion => {
    if (mirror < 0) {
      quat.y = -quat.y;
      quat.z = -quat.z;
    }
    return quat;
  };
  const targetPose = new Float32Array(POSE_LENGTH);
  const shownPose = new Float32Array(POSE_LENGTH);
  /** Per-digit impulse spring offset / velocity. */
  const impulseCurl = new Float32Array(5);
  const impulseVel = new Float32Array(5);
  let triggerPull = 0;

  /** Composes the shown pose (target + trigger + impulse) and poses the finger bones. */
  function applyShownPose(): void {
    for (let i = 0; i < POSE_LENGTH; i++) shownPose[i] = targetPose[i];
    for (let i = 0; i < 4; i++) shownPose[4 + i] += TRIGGER_PULL[i] * triggerPull;
    for (let digit = 0; digit < 5; digit++) {
      const curl = impulseCurl[digit];
      if (curl !== 0) {
        shownPose[digit * 4 + 1] += curl;
        shownPose[digit * 4 + 2] += curl * 0.6;
        if (digit) shownPose[digit * 4] += curl * 0.4;
      }
    }
    clampPose(shownPose);
    for (let digit = 0; digit < 5; digit++)
      for (let phalanx = 0; phalanx < 3; phalanx++) {
        const index = digit * 3 + phalanx;
        const bone = phalanxBones[index];
        const helper = helperBones[index];
        mirrorQuat(phalanxLocalRotation(digit, phalanx, shownPose, bone.quaternion));
        helper.quaternion
          .copy(mirrorQuat(tmpWristRel.copy(restRotations[index])))
          .slerp(bone.quaternion, 0.5);
        const bend =
          digit === 0 && phalanx === 0
            ? 0
            : shownPose[digit * 4 + phalanx] - REST[digit * 4 + phalanx];
        const bulge = Math.sin(Math.min(Math.max(bend, 0), 2) * 0.5);
        tmpArmOffset
          .set(0, KNUCKLE_BULGE[phalanx] * DIGITS[digit].rad[phalanx] * bulge * bulge, 0)
          .applyQuaternion(helper.quaternion);
        helper.position.copy(helperRestPositions[index]).add(tmpArmOffset);
      }
  }
  function copyTargetPose(pose: ArrayLike<number>): void {
    for (let i = 0; i < POSE_LENGTH; i++) targetPose[i] = pose[i];
  }
  const ik: ArmIk = {
    reach: 0,
    wristFlex: 0,
    wristDeviation: 0,
    twist: 0,
    violation: 0,
    lean: 0,
    elbow: new Vector3(),
    shoulder: new Vector3()
  };
  const lastWrist = new Vector3();
  /** Wrist movement since the last applied solve (drives the wrist wobble). */
  const wristDelta = new Vector3();
  const twist1Quat = new Quaternion();
  let hasLastWrist = false;
  /** Wrist wobble spring (radians-ish offsets applied to twist bone 1). */
  const wobble = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0
  };

  /** Two-bone IK with shoulder lean, wrist swing/twist decomposition and limits; poses bones when `apply`. */
  function solveIk(
    shoulder: Vec3Like,
    wrist: Vec3Like,
    hand: Quaternion,
    pole: Vec3Like | null | undefined,
    maxLean: number,
    apply: boolean
  ): ArmIk {
    toArmVec3(shoulder, tmpShoulder);
    tmpShoulder.x *= mirror;
    toArmVec3(wrist, tmpWrist);
    tmpWrist.x *= mirror;
    tmpHandQuat.copy(hand);
    mirrorQuat(tmpHandQuat);
    if (pole) {
      toArmVec3(pole, tmpPole);
      tmpPole.x *= mirror;
    } else tmpPole.set(0.8, -0.6, 0);
    tmpReachDir.subVectors(tmpWrist, tmpShoulder);
    let distance = tmpReachDir.length() || 1e-6;
    tmpReachDir.multiplyScalar(1 / distance);
    const maxReach = (UPPER_ARM_LENGTH + FOREARM_LENGTH) * 0.999;
    const minReach = Math.abs(UPPER_ARM_LENGTH - FOREARM_LENGTH) + 0.02;
    let lean = 0;
    if (distance > maxReach && maxLean > 0) {
      lean = Math.min(maxLean, distance - maxReach);
      tmpShoulder.addScaledVector(tmpReachDir, lean);
      distance -= lean;
    }
    const overReach = Math.max(0, distance - maxReach);
    if (overReach > 0) {
      distance = maxReach;
      tmpWrist.copy(tmpShoulder).addScaledVector(tmpReachDir, distance);
    } else if (distance < minReach) {
      distance = minReach;
      tmpWrist.copy(tmpShoulder).addScaledVector(tmpReachDir, distance);
    }
    const elbowAlong =
      (distance * distance +
        UPPER_ARM_LENGTH * UPPER_ARM_LENGTH -
        FOREARM_LENGTH * FOREARM_LENGTH) /
      (2 * distance);
    const elbowOut = Math.sqrt(
      Math.max(0, UPPER_ARM_LENGTH * UPPER_ARM_LENGTH - elbowAlong * elbowAlong)
    );
    tmpPole.addScaledVector(tmpReachDir, -tmpPole.dot(tmpReachDir));
    if (tmpPole.lengthSq() < 1e-8) {
      tmpPole.set(0, -1, 0).addScaledVector(tmpReachDir, tmpReachDir.y);
      if (tmpPole.lengthSq() < 1e-8)
        tmpPole.set(1, 0, 0).addScaledVector(tmpReachDir, -tmpReachDir.x);
    }
    tmpPole.normalize();
    tmpElbow
      .copy(tmpShoulder)
      .addScaledVector(tmpReachDir, elbowAlong)
      .addScaledVector(tmpPole, elbowOut);
    tmpBasisX.crossVectors(tmpPole, tmpReachDir).normalize();
    tmpBasisZ.subVectors(tmpShoulder, tmpElbow).normalize();
    tmpBasisY.crossVectors(tmpBasisZ, tmpBasisX);
    tmpUpperArmQuat.setFromRotationMatrix(tmpBasisMat.makeBasis(tmpBasisX, tmpBasisY, tmpBasisZ));
    tmpBasisZ.subVectors(tmpElbow, tmpWrist).normalize();
    tmpBasisY.crossVectors(tmpBasisZ, tmpBasisX);
    tmpForearmQuat.setFromRotationMatrix(tmpBasisMat.makeBasis(tmpBasisX, tmpBasisY, tmpBasisZ));
    tmpWristRel.copy(tmpForearmQuat).invert().multiply(tmpHandQuat);
    if (tmpWristRel.w < 0) {
      tmpWristRel.x = -tmpWristRel.x;
      tmpWristRel.y = -tmpWristRel.y;
      tmpWristRel.z = -tmpWristRel.z;
      tmpWristRel.w = -tmpWristRel.w;
    }
    // Twist about the forearm axis, wrapped into (-1.5 pi, pi / 2].
    let twistAngle = 2 * Math.atan2(tmpWristRel.z, tmpWristRel.w);
    while (twistAngle > ARM_PI / 2) twistAngle -= 2 * ARM_PI;
    while (twistAngle <= -1.5 * ARM_PI) twistAngle += 2 * ARM_PI;
    tmpWristSwing.setFromAxisAngle(ARM_AXIS_Z, -twistAngle).multiply(tmpWristRel);
    if (tmpWristSwing.w < 0) {
      tmpWristSwing.x = -tmpWristSwing.x;
      tmpWristSwing.y = -tmpWristSwing.y;
      tmpWristSwing.z = -tmpWristSwing.z;
      tmpWristSwing.w = -tmpWristSwing.w;
    }
    const swingSin = Math.sqrt(
      tmpWristSwing.x * tmpWristSwing.x +
        tmpWristSwing.y * tmpWristSwing.y +
        tmpWristSwing.z * tmpWristSwing.z
    );
    const swingAngle = 2 * Math.atan2(swingSin, tmpWristSwing.w);
    const swingScale = swingSin > 1e-9 ? swingAngle / swingSin : 2;
    const flex = -tmpWristSwing.x * swingScale;
    const deviation = tmpWristSwing.y * swingScale;
    const twist = twistAngle + ARM_PI / 2;
    const limits = WRIST_LIMITS;
    ik.reach = overReach;
    ik.lean = lean;
    ik.wristFlex = flex;
    ik.wristDeviation = deviation;
    ik.twist = twist;
    ik.violation = Math.max(
      0,
      limits.flex[0] - flex,
      flex - limits.flex[1],
      limits.deviation[0] - deviation,
      deviation - limits.deviation[1],
      limits.twist[0] - twist,
      twist - limits.twist[1]
    );
    if (apply) {
      ik.elbow.set(tmpElbow.x * mirror, tmpElbow.y, tmpElbow.z);
      ik.shoulder.set(tmpShoulder.x * mirror, tmpShoulder.y, tmpShoulder.z);
      upperArm.position.copy(ik.shoulder);
      mirrorQuat(upperArm.quaternion.copy(tmpUpperArmQuat));
      mirrorQuat(forearm.quaternion.copy(tmpUpperArmQuat).invert().multiply(tmpForearmQuat));
      mirrorQuat(handBone.quaternion.copy(tmpWristRel));
      mirrorQuat(twist1Quat.setFromAxisAngle(ARM_AXIS_Z, twistAngle * TWIST_SHARE[0]));
      twist1.quaternion.copy(twist1Quat);
      mirrorQuat(twist2.quaternion.setFromAxisAngle(ARM_AXIS_Z, twistAngle * TWIST_SHARE[1]));
      tmpArmOffset.set(tmpWrist.x * mirror, tmpWrist.y, tmpWrist.z);
      if (hasLastWrist) wristDelta.subVectors(tmpArmOffset, lastWrist);
      lastWrist.copy(tmpArmOffset);
      hasLastWrist = true;
    }
    return ik;
  }

  copyTargetPose(REST);
  applyShownPose();
  upperArm.position.set(0, 0, UPPER_ARM_LENGTH + FOREARM_LENGTH);
  group.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);
  const mesh = new SkinnedMesh(armGeometry(side), options.material || armMaterial());
  mesh.name = 'arm-mesh-' + side;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  group.add(mesh);
  mesh.bind(skeleton, new Matrix4());
  const arm: Arm = {
    side,
    group,
    mesh,
    bones,
    skeleton,
    ik,
    pose: targetPose,
    hand: handBone,
    bone: Object.fromEntries(BONE_NAMES.map((name, index) => [name, bones[index]])),
    triCount: mesh.geometry.userData.triCount,
    setLayer(layer) {
      group.traverse((object) => object.layers.set(layer));
      return arm;
    },
    setVisible(visible) {
      group.visible = !!visible;
      return arm;
    },
    setFingers(pose, weight = 1) {
      const resolved = resolvePose(pose);
      if (weight >= 1) copyTargetPose(resolved);
      else lerpPose(targetPose, targetPose, resolved, weight);
      applyShownPose();
      return arm;
    },
    blendFingers(from, to, t) {
      lerpPose(targetPose, resolvePose(from), resolvePose(to), t);
      applyShownPose();
      return arm;
    },
    setFinger(digit, joints, weight = 1) {
      const digitIndex = typeof digit == 'string' ? DIGIT_NAMES.indexOf(digit) : digit;
      for (let joint = 0; joint < 4; joint++)
        targetPose[digitIndex * 4 + joint] +=
          (joints[joint] - targetPose[digitIndex * 4 + joint]) * weight;
      applyShownPose();
      return arm;
    },
    setTrigger(pull) {
      pull = pull < 0 ? 0 : pull > 1 ? 1 : pull;
      if (pull !== triggerPull) {
        triggerPull = pull;
        applyShownPose();
      }
      return arm;
    },
    get trigger() {
      return triggerPull;
    },
    get shown() {
      return shownPose;
    },
    solve(shoulder, wrist, hand, pole = null, solveOptions = null) {
      return solveIk(
        shoulder,
        wrist,
        hand,
        pole,
        solveOptions && solveOptions.lean ? solveOptions.lean : 0,
        true
      );
    },
    solveMatrix(shoulder, handMatrix, pole = null, solveOptions = null) {
      handMatrix.decompose(tmpSolvePos, tmpWristSwing, tmpSolveScale);
      return solveIk(
        shoulder,
        tmpSolvePos,
        tmpHandQuat.copy(tmpWristSwing),
        pole,
        solveOptions && solveOptions.lean ? solveOptions.lean : 0,
        true
      );
    },
    findPole(shoulder, wrist, hand, pole = null) {
      const shoulderPos = toArmVec3(shoulder, new Vector3());
      const wristPos = toArmVec3(wrist, new Vector3());
      const handQuat = hand.clone();
      const axis = wristPos.clone().sub(shoulderPos).normalize();
      const poleA = toArmVec3(pole || DEFAULT_POLE[side], new Vector3());
      poleA.addScaledVector(axis, -poleA.dot(axis)).normalize();
      const poleB = new Vector3().crossVectors(axis, poleA);
      const bestPole = new Vector3();
      const candidate = new Vector3();
      let bestCost = 1e9;
      for (let step = 0; step < 24; step++) {
        const angle = (step / 24) * 2 * ARM_PI;
        candidate
          .copy(poleA)
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(poleB, Math.sin(angle));
        const result = solveIk(shoulderPos, wristPos, handQuat, candidate, 0, false);
        const cost = result.violation + 0.12 * (1 - Math.cos(angle));
        if (cost < bestCost) {
          bestCost = cost;
          bestPole.copy(candidate);
        }
      }
      return bestPole;
    },
    fitGrip(colliders, fitOptions = {}) {
      let shapes = colliders;
      if (fitOptions.space === 'parent' || fitOptions.space === 'world') {
        const parent = group.parent;
        group.updateWorldMatrix(true, true);
        tmpBasisMat.copy(handBone.matrixWorld).invert();
        if (parent && fitOptions.space === 'parent') tmpBasisMat.multiply(parent.matrixWorld);
        shapes = transformColliders(colliders, tmpBasisMat);
      }
      if (mirror < 0) shapes = mirrorColliders(shapes);
      const pose = fitGrip(shapes, fitOptions);
      if (fitOptions.apply !== false) {
        copyTargetPose(pose);
        applyShownPose();
      }
      return pose;
    },
    socket(name, position, rotation, outPos, outQuat) {
      if (mirror > 0) return handSocket(name, position, rotation, outPos, outQuat);
      tmpMirroredPos.set(-position.x, position.y, position.z);
      tmpWristSwing.set(rotation.x, -rotation.y, -rotation.z, rotation.w);
      handSocket(name, tmpMirroredPos, tmpWristSwing, outPos, outQuat);
      outPos.x = -outPos.x;
      outQuat.y = -outQuat.y;
      outQuat.z = -outQuat.z;
      return outPos;
    },
    gripFrame(name, outPos, outQuat) {
      const frame = GRIPS[name].frame;
      outPos.copy(frame.p);
      outQuat.copy(frame.q);
      if (mirror < 0) {
        outPos.x = -outPos.x;
        outQuat.y = -outQuat.y;
        outQuat.z = -outQuat.z;
      }
      return outPos;
    },
    penetration(colliders, out) {
      return penetration(shownPose, mirror < 0 ? mirrorColliders(colliders) : colliders, out);
    },
    selfPenetration(out) {
      return fingerSelfPenetration(shownPose, palmSdf, out);
    },
    impulse(strength = 1) {
      for (let digit = 0; digit < 5; digit++) impulseVel[digit] += strength * (1.6 + 0.3 * digit);
      wobble.vx += strength * 0.5;
      wobble.vy -= strength * 0.35;
    },
    update(dt) {
      if (!(dt > 0)) return;
      if (dt > 0.05) dt = 0.05;
      let moving = false;
      for (let digit = 0; digit < 5; digit++) {
        impulseVel[digit] += (-impulseCurl[digit] * 900 - impulseVel[digit] * 34) * dt;
        impulseCurl[digit] += impulseVel[digit] * dt;
        if (Math.abs(impulseCurl[digit]) > 2e-4 || Math.abs(impulseVel[digit]) > 0.02)
          moving = true;
        else {
          impulseCurl[digit] = 0;
          impulseVel[digit] = 0;
        }
      }
      if (moving) applyShownPose();
      wobble.vx += (-wobble.x * 260 - wobble.vx * 18) * dt - wristDelta.y * 9;
      wobble.vy += (-wobble.y * 260 - wobble.vy * 18) * dt + wristDelta.x * 9 * mirror;
      wristDelta.set(0, 0, 0);
      wobble.x += wobble.vx * dt;
      wobble.y += wobble.vy * dt;
      const wobbleX = Math.max(-0.06, Math.min(0.06, wobble.x));
      const wobbleY = Math.max(-0.06, Math.min(0.06, wobble.y));
      if (Math.abs(wobbleX) > 1e-5 || Math.abs(wobbleY) > 1e-5) {
        tmpWristRel.set(wobbleX * 0.5, wobbleY * 0.5, 0, 1).normalize();
        twist1.quaternion.copy(twist1Quat).multiply(tmpWristRel);
      } else twist1.quaternion.copy(twist1Quat);
    },
    dispose() {
      if (group.parent) group.parent.remove(group);
      skeleton.dispose();
    }
  };
  if (options.layer != null) arm.setLayer(options.layer);
  return arm;
}

/** Mutable state of the hands showcase (driven by `h*` shot parameters). */
interface HandsShowcaseState {
  view: string;
  pose: [string, string];
  poseSet: boolean;
  /** `[from, to, t?]` pose names (and optional fixed blend). */
  blend: string[] | null;
  trig: number | 'anim';
  /** Foregrip socket position, or null. */
  grip: number[] | null;
  held: 'rifle' | 'pistol';
  /** Gun placement `[x, y, z, pitch, yaw, roll]`, or null for the default. */
  gun: number[] | null;
  t: number;
}

/** Camera request produced by the showcase (`fov` is numeric although `__setShot` is typed with strings). */
interface HandsShot extends CameraShot {
  cam?: string;
  fov?: number;
}

/** `?show=hands`: both arms in a studio (or first person) with poses, blends and grips from URL params. */
export async function handsShowcase(game: Game) {
  const rightArm = createArm(game, {
    side: 'right'
  });
  const leftArm = createArm(game, {
    side: 'left'
  });
  const studio = new Group();
  studio.name = 'hands-studio';
  game.scene.add(studio);
  const state: HandsShowcaseState = {
    view: 'back',
    pose: ['relaxed', 'relaxed'],
    poseSet: false,
    blend: null,
    trig: 0,
    grip: null,
    held: 'rifle',
    gun: null,
    t: 0
  };
  const gunPlacements: Record<string, number[]> = {
    rifle: [0.118, -0.122, -0.275, 0.034, 0.085, -0.03],
    pistol: [0.135, -0.078, -0.5, 0.06, 0.12, -0.07]
  };
  const gun = {
    p: new Vector3(),
    q: new Quaternion()
  };
  const rifleGripOffset = new Vector3(0, -0.055, 0.085);
  const rifleForeOffset = new Vector3(0, -0.04, -0.256);
  const pistolGripOffset = new Vector3(0, -0.012, 0.045);
  const handPos = new Vector3();
  const handQuat = new Quaternion();
  const socketPos = new Vector3();
  const socketQuat = new Quaternion();
  const eye = [0, 1.68, 4];
  /** Studio views: `[camera, target, fov, roll about the forearm axis]`. */
  const views: Record<string, [number[], number[], number, number]> = {
    back: [[0.2, 1.34, 0.78], [0, 1.25, 0], 26, 0],
    palm: [[0.2, 1.34, 0.78], [0, 1.25, 0], 26, ARM_PI],
    side: [[0.74, 1.3, 0.34], [0, 1.24, 0], 26, 0],
    arm: [[0.62, 1.02, 0.62], [0.06, 0.98, 0], 30, 0]
  };
  const prevSetShot = typeof window !== 'undefined' ? window.__setShot : null;

  /** Parents the arms to the camera (first person) or the studio and resets their bones. */
  function placeArms(): void {
    const firstPerson = state.view === 'fp';
    for (const arm of [rightArm, leftArm]) {
      (firstPerson ? game.camera : studio).add(arm.group);
      arm.setLayer(firstPerson ? VIEWMODEL_LAYER : WORLD_LAYER);
      arm.group.position.set(0, 0, 0);
      arm.group.quaternion.identity();
    }
    if (!firstPerson) {
      const view = views[state.view] || views.back;
      studio.position.set(0, 1.16, 0);
      studio.rotation.set(ARM_PI / 2, 0, 0);
      studio.rotateZ(view[3]);
      for (const arm of [rightArm, leftArm]) {
        const sign = arm === rightArm ? 1 : -1;
        arm.bone.upperArm.position.set(0.125 * sign, 0, UPPER_ARM_LENGTH + FOREARM_LENGTH);
        for (const name of ['upperArm', 'forearm', 'forearmTwist1', 'forearmTwist2', 'hand'])
          arm.bone[name].quaternion.identity();
      }
    }
  }

  /** Applies finger poses / trigger and, in first person, solves the arms onto the gun. */
  function poseArms(): void {
    const firstPerson = state.view === 'fp';
    if (state.blend) {
      const t = state.blend[2] != null ? +state.blend[2] : 0.5 - 0.5 * Math.cos(state.t * 1.6);
      rightArm.blendFingers(state.blend[0], state.blend[1], t);
      leftArm.blendFingers(state.blend[0], state.blend[1], t);
    } else if (state.poseSet) {
      rightArm.setFingers(state.pose[0]);
      leftArm.setFingers(state.pose[1]);
    } else if (state.grip) {
      rightArm.setFingers('foregrip');
      leftArm.setFingers('foregrip');
    } else if (firstPerson && state.held === 'pistol') {
      rightArm.setFingers(state.trig ? 'trigger' : 'pistol_grip');
      leftArm.setFingers('pistol_support');
    } else if (firstPerson) {
      rightArm.setFingers(state.trig ? 'trigger' : 'rifle_grip');
      leftArm.setFingers('foregrip');
    } else {
      rightArm.setFingers(state.pose[0]);
      leftArm.setFingers(state.pose[1]);
    }
    rightArm.setTrigger(
      state.trig === 'anim' ? 0.5 - 0.5 * Math.cos(state.t * 4) : +state.trig || 0
    );
    if (!firstPerson) return;
    if (state.grip)
      for (const arm of [rightArm, leftArm]) {
        const sign = arm === rightArm ? 1 : -1;
        handPos.set(state.grip[0] + 0.11 * sign, state.grip[1], state.grip[2]);
        handQuat.setFromRotationMatrix(
          tmpBasisMat.makeBasis(
            tmpBasisX.set(0, 0.86 * sign, -0.5 * sign).normalize(),
            tmpBasisY.set(-sign, 0, 0),
            tmpBasisZ.set(0, 0.5, 0.86).normalize()
          )
        );
        arm.socket('foregrip', handPos, handQuat, socketPos, socketQuat);
        arm.solve(SHOULDER[arm.side], socketPos, socketQuat, null, {
          lean: 0.15
        });
      }
    else {
      const placement = state.gun || gunPlacements[state.held] || gunPlacements.rifle;
      const isPistol = state.held === 'pistol';
      gun.p.set(placement[0], placement[1], placement[2]);
      gun.q.setFromEuler(
        tmpGunEuler.set(placement[3] || 0, placement[4] || 0, placement[5] || 0, 'YXZ')
      );
      handPos
        .copy(isPistol ? pistolGripOffset : rifleGripOffset)
        .applyQuaternion(gun.q)
        .add(gun.p);
      rightArm.socket(
        isPistol ? 'pistol_grip' : 'rifle_grip',
        handPos,
        gun.q,
        socketPos,
        socketQuat
      );
      rightArm.solve(SHOULDER.right, socketPos, socketQuat, null, {
        lean: 0.2
      });
      if (!isPistol) handPos.copy(rifleForeOffset).applyQuaternion(gun.q).add(gun.p);
      leftArm.socket(
        isPistol ? 'pistol_support' : 'foregrip',
        handPos,
        gun.q,
        socketPos,
        socketQuat
      );
      leftArm.solve(SHOULDER.left, socketPos, socketQuat, null, {
        lean: 0.2
      });
    }
  }

  /** Applies `h*` shot params; returns (and unless `silent`, requests) the matching camera. */
  function applyParams(params: CameraShot, silent: boolean): HandsShot {
    if (params.hview) state.view = String(params.hview);
    if (params.hpose != null) {
      const names = String(params.hpose).split(',');
      state.pose = [
        POSES[names[0]] ? names[0] : 'relaxed',
        POSES[names[1] || names[0]] ? names[1] || names[0] : 'relaxed'
      ];
      state.poseSet = params.hpose !== '';
      state.blend = null;
    }
    if (params.hblend != null) {
      const names = String(params.hblend).split(',');
      state.blend = POSES[names[0]] && POSES[names[1]] ? names : null;
    }
    if (params.htrig != null) state.trig = params.htrig === 'anim' ? 'anim' : +params.htrig;
    if (params.hgrip != null)
      state.grip = params.hgrip === '' ? null : String(params.hgrip).split(',').map(Number);
    if (params.hheld != null) state.held = params.hheld === 'pistol' ? 'pistol' : 'rifle';
    if (params.hgun != null)
      state.gun = params.hgun === '' ? null : String(params.hgun).split(',').map(Number);
    if (params.hwet != null) armWetUniform.value = +params.hwet;
    placeArms();
    poseArms();
    for (const arm of [rightArm, leftArm])
      console.log(
        `[hands] ${arm.side}: view ${state.view}, ${arm.triCount} tris` +
          (state.view === 'fp'
            ? `, reach ${arm.ik.reach.toFixed(3)} flex ${arm.ik.wristFlex.toFixed(2)} dev ${arm.ik.wristDeviation.toFixed(2)} twist ${arm.ik.twist.toFixed(2)} violation ${arm.ik.violation.toFixed(2)}`
            : '')
      );
    const shot: HandsShot = {};
    if (!params.cam)
      if (state.view === 'fp') {
        shot.cam = [...eye, eye[0] + 0.28, eye[1] - 0.01, eye[2] + 1].join(',');
        if (!params.fov) shot.fov = 74;
      } else {
        const view = views[state.view] || views.back;
        shot.cam = [...view[0], ...view[1]].join(',');
        if (!params.fov) shot.fov = view[2];
      }
    // `__setShot` is declared with string values but the render side accepts a numeric fov.
    if (!silent && prevSetShot) prevSetShot(shot);
    return shot;
  }

  if (typeof window !== 'undefined') {
    window.__setShot = (params) => {
      if (
        params &&
        (params.hview ||
          params.hpose != null ||
          params.hblend != null ||
          params.htrig != null ||
          params.hgrip != null ||
          params.hheld != null ||
          params.hgun != null ||
          params.hwet != null)
      )
        applyParams(params, false);
      if (prevSetShot) prevSetShot(params);
    };
    window.__hands = {
      R: rightArm,
      L: leftArm,
      st: state,
      apply: (params: CameraShot) => applyParams(params, false)
    };
  }
  const initialShot = applyParams(game.params || {}, true);
  const cam = initialShot.cam
    ? initialShot.cam.split(',').map(Number)
    : [0.2, 1.34, 0.78, 0, 1.25, 0];
  if (initialShot.fov && !(game.params && game.params.fov)) {
    game.camera.fov = initialShot.fov;
    game.camera.updateProjectionMatrix();
  }
  return {
    cam: cam.slice(0, 3),
    target: cam.slice(3, 6),
    R: rightArm,
    L: leftArm,
    state,
    update(dt: number) {
      state.t += dt;
      if (state.trig === 'anim' || (state.blend && state.blend[2] == null)) poseArms();
      rightArm.update(dt);
      leftArm.update(dt);
    }
  };
}
