/**
 * Procedural glove + sleeve mesh. The glove is a signed distance field built
 * from smooth-blended primitives (round cones and ellipsoids) attached to the
 * hand bones; it is meshed with surface nets on an adaptive grid, skinned
 * from primitive influence, welded, and joined to a lathed sleeve. Also
 * exports the palm SDF used for finger-vs-palm contact and a few landmarks
 * the arm shader uses.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { ARM } from '../animConfig';
import { BONE, DIGITS, REST, computeHandFk, createHandFk } from './skeleton';

/** Knuckle guard landmark (ellipsoid centre, radii and yaw). */
export interface GloveGuardLandmark {
  c: number[];
  r: number[];
  yaw: number;
}

/** Thumb web landmark: centre and axis direction of the web ellipsoid. */
export interface GloveWebLandmark {
  c: number[];
  ab: number[];
}

/** Glove landmarks for the arm shader (filled in while this module loads). */
export interface GloveLandmarks {
  guard: GloveGuardLandmark[];
  /** Set while the primitives are built at module load, so importers always see it. */
  web: GloveWebLandmark;
}

/** Options of `buildGloveMesh`. */
export interface GloveMeshOptions {
  /** Rebuild even if a cached mesh exists. */
  force?: boolean;
  /** Grid spacing in X/Y (default 0.0034). */
  hxy?: number;
  /** Grid spacing in Z over the fingers (default 0.0047). */
  hzF?: number;
  /** Grid spacing in Z over the palm (default 0.006). */
  hzP?: number;
  /** Grid spacing in Z over the cuff (default 0.008). */
  hzC?: number;
  /** Skin weight relaxation passes (default 3). */
  relax?: number;
}

/** Skinned glove + sleeve geometry arrays. */
export interface GloveMesh {
  position: Float32Array;
  normal: Float32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  /** Rest position (xyz) + sleeve wrinkle (w). */
  rest: Float32Array;
  /** Hand-space shading coordinates (along, digit, side, across). */
  hand: Float32Array;
  index: Uint32Array;
  vertexCount: number;
  triCount: number;
  gloveVerts: number;
  gloveTris: number;
  /** Number of SDF evaluations used. */
  evals: number;
  /** Build time in milliseconds. */
  ms: number;
}

/** Growable mesh arrays used while building. */
interface MeshArrays {
  pos: number[];
  nrm: number[];
  idx: number[];
  si: number[];
  sw: number[];
  rest: number[];
  hand: number[];
}

interface PrimitiveBase {
  bone: number;
  group: number;
  /** Origin. */
  o: number[];
  /** Rotation (3x3, rows of the inverse basis). */
  m: number[];
  /** Blend radius. */
  k: number;
  /** Skin influence radius. */
  R: number;
  /** Bounding sphere centre / radius. */
  bc: number[];
  br: number;
}

interface RoundConePrimitive extends PrimitiveBase {
  type: typeof PRIM_ROUND_CONE;
  h: number;
  ra: number;
  rb: number;
  sx: number;
  b: number;
  a_: number;
  ta: number;
  tb: number;
}

interface EllipsoidPrimitive extends PrimitiveBase {
  type: typeof PRIM_ELLIPSOID;
  r: number[];
}

/** Rounded box primitive: supported by the packer but never created. */
interface BoxPrimitive extends PrimitiveBase {
  type: 2;
  hh: number[];
  rr: number;
}

type GlovePrimitive = RoundConePrimitive | EllipsoidPrimitive | BoxPrimitive;

interface RoundConeOptions {
  wide?: number;
  k?: number;
  ta?: number;
  tb?: number;
  R?: number;
}

interface EllipsoidOptions {
  k?: number;
  R?: number;
}

const GROUP_PALM = 0;
const GROUP_THUMB = 5;
const GROUP_CUFF = 6;
const GROUP_KNUCKLE_GUARD = 7;
const GROUP_COUNT = 8;
const PRIM_ROUND_CONE = 0;
const PRIM_ELLIPSOID = 1;
const BOUND_SKIP_MARGIN = 0.03;
const FINGER_BLEND_K = 0.0065;
const THUMB_BLEND_K = 0.01;
const CUFF_BLEND_K = 0.012;
const GUARD_BLEND_K = 0.0015;
const SLEEVE_SPEC = {
  hem: 0.046,
  end: 0.535,
  band: [0.128, 0.172],
  refl: [0.1445, 0.1555]
};
const glovePrimitives: GlovePrimitive[] = [];
const tmpRotationMatrix = new Matrix4();
const tmpIdentityQuat = new Quaternion();
const tmpOffsetVec = new Vector3();

function quatToMat3Array(quat: Quaternion): number[] {
  const e = tmpRotationMatrix.makeRotationFromQuaternion(quat).elements;
  return [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
}

/** Adds a round cone along -Z of `rotation` from `origin`, of length `length`. */
function addRoundCone(
  bone: number,
  group: number,
  origin: Vector3,
  rotation: Quaternion,
  length: number,
  radiusA: number,
  radiusB: number,
  options: RoundConeOptions = {}
): void {
  const slope = (radiusA - radiusB) / length;
  glovePrimitives.push({
    type: PRIM_ROUND_CONE,
    bone,
    group,
    o: [origin.x, origin.y, origin.z],
    m: quatToMat3Array(rotation),
    h: length,
    ra: radiusA,
    rb: radiusB,
    sx: options.wide || 1,
    b: slope,
    a_: Math.sqrt(1 - slope * slope),
    k: options.k ?? 0.004,
    ta: options.ta || 0,
    tb: options.tb || 0,
    R: options.R || 0.01,
    bc: [origin.x, origin.y, origin.z].map(
      (value, axis) => value - quatToMat3Array(rotation)[6 + axis] * length * 0.5
    ),
    br: length * 0.5 + Math.max(radiusA, radiusB) * (options.wide || 1)
  });
}

/** Adds an ellipsoid with centre `center`, radii `radii` and optional rotation. */
function addEllipsoid(
  bone: number,
  group: number,
  center: number[],
  radii: number[],
  rotation: Quaternion | null = null,
  options: EllipsoidOptions = {}
): void {
  glovePrimitives.push({
    type: PRIM_ELLIPSOID,
    bone,
    group,
    o: [center[0], center[1], center[2]],
    m: quatToMat3Array(rotation || tmpIdentityQuat.identity()),
    r: radii,
    k: options.k ?? 0.004,
    R: options.R || 0.01,
    bc: center.slice(),
    br: Math.max(radii[0], radii[1], radii[2])
  });
}

const yawQuat = (angle: number): Quaternion =>
  new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle);
const IDENTITY_QUAT = new Quaternion();
const REST_FK = computeHandFk(REST, createHandFk());

/** Joint position of the REST pose (`joint` 3 is the tip). */
export const restJoint = (digit: number, joint: number): Vector3 => REST_FK.j[digit * 4 + joint];
/** Phalanx orientation of the REST pose. */
export const restPhalanxQuat = (digit: number, phalanx: number): Quaternion =>
  REST_FK.q[digit * 3 + phalanx];
/** Local axis (0 = X, 1 = Y, 2 = Z) of a phalanx in the REST pose. */
export const restPhalanxAxis = (digit: number, phalanx: number, axis: number): Vector3 =>
  new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0).applyQuaternion(
    restPhalanxQuat(digit, phalanx)
  );
export const GLOVE_LANDMARKS: GloveLandmarks = {
  guard: [],
  // Filled in by buildGlovePrimitives() below, before any importer runs.
  web: null!
};

function buildGlovePrimitives(): void {
  const handBone = BONE.hand;
  // Metacarpals and knuckle pads.
  for (let digit = 1; digit < 5; digit++) {
    const def = DIGITS[digit];
    const knuckle = new Vector3(...def.base);
    const wrist = new Vector3(def.base[0] * 0.74 + 0.001, 5e-4, -0.02);
    const direction = knuckle.clone().sub(wrist);
    const length = direction.length() - 0.002;
    direction.normalize();
    const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), direction);
    addRoundCone(
      handBone,
      GROUP_PALM,
      wrist,
      rotation,
      length,
      0.0142,
      digit === 4 ? 0.0112 : 0.0122,
      {
        k: 0.012,
        tb: 0.005,
        R: 0.012
      }
    );
    addEllipsoid(
      BONE.helper(digit, 0),
      GROUP_PALM,
      [def.base[0], def.base[1] + 0.0022, def.base[2] + 0.001],
      [0.0112, 0.0108, 0.0112].map((radius) => radius * (digit === 4 ? 0.9 : 1)),
      null,
      {
        k: 0.006
      }
    );
  }
  // Palm body.
  addEllipsoid(handBone, GROUP_PALM, [0, 0.005, -0.056], [0.037, 0.009, 0.046], null, {
    k: 0.012,
    R: 0.012
  });
  addEllipsoid(
    handBone,
    GROUP_PALM,
    [0.0265, -0.0098, -0.047],
    [0.0135, 0.0108, 0.035],
    yawQuat(-0.1),
    {
      k: 0.01,
      R: 0.012
    }
  );
  addEllipsoid(
    handBone,
    GROUP_PALM,
    [5e-4, -0.0068, -0.084],
    [0.037, 0.0078, 0.014],
    yawQuat(-0.1),
    {
      k: 0.012,
      R: 0.012
    }
  );
  addEllipsoid(handBone, GROUP_PALM, [0.001, 0, -0.014], [0.0305, 0.019, 0.024], null, {
    k: 0.012,
    R: 0.012
  });
  // Webbing between neighbouring fingers.
  for (let digit = 1; digit < 4; digit++) {
    const base = DIGITS[digit].base;
    const nextBase = DIGITS[digit + 1].base;
    for (const side of [-1, 1])
      addEllipsoid(
        BONE.digit(side < 0 ? digit : digit + 1, 0),
        GROUP_PALM,
        [
          (base[0] + nextBase[0]) / 2 + side * 0.0025,
          (base[1] + nextBase[1]) / 2 - 0.002,
          (base[2] + nextBase[2]) / 2 - 0.008
        ],
        [0.0062, 0.0064, 0.0082],
        null,
        {
          k: 0.006,
          R: 0.012
        }
      );
  }
  // Knuckle guards and the bars joining them.
  for (let digit = 1; digit < 5; digit++) {
    const def = DIGITS[digit];
    const scale = digit === 4 ? 0.88 : 1;
    const center = [def.base[0], def.base[1] + 0.01, def.base[2] + 0.003];
    const radii = [0.0112 * scale, 0.0042, 0.013 * scale];
    // Fingers always have `yaw`.
    addEllipsoid(BONE.helper(digit, 0), GROUP_KNUCKLE_GUARD, center, radii, yawQuat(def.yaw!), {
      k: 0.004,
      R: 0.012
    });
    GLOVE_LANDMARKS.guard.push({
      c: center,
      r: radii,
      yaw: def.yaw!
    });
    if (digit < 4) {
      const next = DIGITS[digit + 1];
      const start = new Vector3(center[0], center[1] - 0.0012, center[2] + 0.003);
      const end = new Vector3(next.base[0], next.base[1] + 0.0094, next.base[2] + 0.006);
      const direction = end.clone().sub(start);
      const length = direction.length();
      direction.normalize();
      addRoundCone(
        handBone,
        GROUP_KNUCKLE_GUARD,
        start,
        new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), direction),
        length,
        0.0042,
        0.0042,
        {
          k: 0.004,
          R: 0.012
        }
      );
    }
  }
  // Finger phalanges, joint pads and fingertip pads.
  for (let digit = 1; digit < 5; digit++) {
    const def = DIGITS[digit];
    const radii = def.rad;
    const wide = def.wide;
    for (let phalanx = 0; phalanx < 3; phalanx++) {
      const isTip = phalanx === 2;
      const length = def.len[phalanx] - (isTip ? radii[3] : 0);
      addRoundCone(
        BONE.digit(digit, phalanx),
        digit,
        restJoint(digit, phalanx),
        restPhalanxQuat(digit, phalanx),
        length,
        radii[phalanx],
        radii[phalanx + 1],
        {
          wide,
          k: 0.0018,
          ta: 0.005,
          tb: isTip ? 0 : 0.005
        }
      );
      if (phalanx > 0) {
        const jointPad = restJoint(digit, phalanx)
          .clone()
          .addScaledVector(restPhalanxAxis(digit, phalanx, 1), 0.0012);
        addEllipsoid(
          BONE.helper(digit, phalanx),
          digit,
          jointPad.toArray(),
          [radii[phalanx] * wide * 0.95, radii[phalanx] * 0.95, radii[phalanx] * 1.05],
          restPhalanxQuat(digit, phalanx),
          {
            k: 0.002
          }
        );
      }
    }
    const tipPad = restJoint(digit, 2)
      .clone()
      .addScaledVector(restPhalanxAxis(digit, 2, 2), -def.len[2] * 0.56)
      .addScaledVector(restPhalanxAxis(digit, 2, 1), -0.0012);
    addEllipsoid(
      BONE.digit(digit, 2),
      digit,
      tipPad.toArray(),
      [radii[3] * wide * 1.04, radii[3] * 0.98, def.len[2] * 0.4],
      restPhalanxQuat(digit, 2),
      {
        k: 0.003
      }
    );
  }
  // Thumb.
  {
    const thumb = DIGITS[0];
    const radii = thumb.rad;
    const wide = thumb.wide;
    const metacarpalBone = BONE.digit(0, 0);
    addRoundCone(
      metacarpalBone,
      GROUP_THUMB,
      restJoint(0, 0),
      restPhalanxQuat(0, 0),
      thumb.len[0],
      radii[0],
      radii[1] * 1.04,
      {
        wide: 1.06,
        k: 0.006,
        ta: 0.006,
        tb: 0.005,
        R: 0.012
      }
    );
    const thenarCenter = restJoint(0, 0)
      .clone()
      .addScaledVector(restPhalanxAxis(0, 0, 2), -0.02)
      .addScaledVector(restPhalanxAxis(0, 0, 1), -0.0048)
      .add(tmpOffsetVec.set(0.0055, -0.003, 0));
    addEllipsoid(
      metacarpalBone,
      GROUP_THUMB,
      thenarCenter.toArray(),
      [0.0158, 0.0122, 0.027],
      restPhalanxQuat(0, 0),
      {
        k: 0.01,
        R: 0.012
      }
    );
    // Web between thumb and index.
    {
      const webStart = restJoint(0, 1)
        .clone()
        .addScaledVector(restPhalanxAxis(0, 1, 2), -0.004);
      const webEnd = new Vector3(
        DIGITS[1].base[0],
        DIGITS[1].base[1] - 0.004,
        DIGITS[1].base[2] + 0.02
      );
      const webAxis = webEnd.clone().sub(webStart);
      const halfLength = webAxis.length() / 2;
      webAxis.normalize();
      const upHint = new Vector3(0.25, 1, 0).normalize();
      const webNormal = new Vector3().crossVectors(webAxis, upHint).normalize();
      if (webNormal.z < 0) webNormal.negate();
      const webUp = new Vector3().crossVectors(webNormal, webAxis);
      const webRotation = new Quaternion().setFromRotationMatrix(
        new Matrix4().makeBasis(webAxis, webUp, webNormal)
      );
      const webCenter = webStart
        .clone()
        .add(webEnd)
        .multiplyScalar(0.5)
        .addScaledVector(webNormal, 0.0075);
      addEllipsoid(
        BONE.helper(0, 0),
        GROUP_THUMB,
        webCenter.toArray(),
        [halfLength + 0.003, 0.0058, 0.015],
        webRotation,
        {
          k: 0.012,
          R: 0.014
        }
      );
      GLOVE_LANDMARKS.web = {
        c: webCenter.toArray(),
        ab: webAxis.toArray()
      };
    }
    addEllipsoid(
      BONE.helper(0, 0),
      GROUP_THUMB,
      [thumb.base[0] + 0.002, thumb.base[1], thumb.base[2] + 0.002],
      [0.015, 0.014, 0.015],
      null,
      {
        k: 0.01,
        R: 0.012
      }
    );
    for (let phalanx = 1; phalanx < 3; phalanx++) {
      const isTip = phalanx === 2;
      const length = thumb.len[phalanx] - (isTip ? radii[3] : 0);
      addRoundCone(
        BONE.digit(0, phalanx),
        GROUP_THUMB,
        restJoint(0, phalanx),
        restPhalanxQuat(0, phalanx),
        length,
        radii[phalanx],
        radii[phalanx + 1],
        {
          wide: isTip ? wide * 1.03 : wide,
          k: 0.002,
          ta: 0.005,
          tb: isTip ? 0 : 0.005
        }
      );
      const jointPad = restJoint(0, phalanx)
        .clone()
        .addScaledVector(restPhalanxAxis(0, phalanx, 1), 0.0012);
      addEllipsoid(
        BONE.helper(0, phalanx),
        GROUP_THUMB,
        jointPad.toArray(),
        [radii[phalanx] * wide * 0.95, radii[phalanx] * 0.96, radii[phalanx] * 1.06],
        restPhalanxQuat(0, phalanx),
        {
          k: 0.002
        }
      );
    }
    const tipPad = restJoint(0, 2)
      .clone()
      .addScaledVector(restPhalanxAxis(0, 2, 2), -thumb.len[2] * 0.56)
      .addScaledVector(restPhalanxAxis(0, 2, 1), -0.0014);
    addEllipsoid(
      BONE.digit(0, 2),
      GROUP_THUMB,
      tipPad.toArray(),
      [radii[3] * wide * 1.1, radii[3] * 0.98, thumb.len[2] * 0.4],
      restPhalanxQuat(0, 2),
      {
        k: 0.003
      }
    );
  }
  // Cuff.
  addRoundCone(
    BONE.twist2,
    GROUP_CUFF,
    new Vector3(0, 5e-4, 0.084),
    IDENTITY_QUAT,
    0.088,
    0.0232,
    0.0222,
    {
      wide: 1.43,
      k: 0.006,
      ta: 0,
      tb: 0.012,
      R: 0.022
    }
  );
  addRoundCone(
    BONE.twist2,
    GROUP_CUFF,
    new Vector3(0, 5e-4, 0.084),
    IDENTITY_QUAT,
    0.064,
    0.0246,
    0.024,
    {
      wide: 1.4,
      k: 0.0035,
      ta: 0,
      tb: 0,
      R: 0.01
    }
  );
}
buildGlovePrimitives();

// Primitives packed into flat arrays for fast SDF evaluation.
const PRIM_COUNT = glovePrimitives.length;
const primTypes = new Uint8Array(PRIM_COUNT);
const primGroups = new Uint8Array(PRIM_COUNT);
const primBones = new Uint8Array(PRIM_COUNT);
const primOrigins = new Float64Array(PRIM_COUNT * 3);
const primBases = new Float64Array(PRIM_COUNT * 9);
const primParams = new Float64Array(PRIM_COUNT * 8);
const primBlendK = new Float64Array(PRIM_COUNT);
const primBoundSpheres = new Float64Array(PRIM_COUNT * 4);
glovePrimitives.forEach((prim, index) => {
  primTypes[index] = prim.type;
  primGroups[index] = prim.group;
  primBones[index] = prim.bone;
  primBlendK[index] = prim.k;
  primOrigins.set(prim.o, index * 3);
  primBases.set(prim.m, index * 9);
  primBoundSpheres.set([prim.bc[0], prim.bc[1], prim.bc[2], prim.br], index * 4);
  if (prim.type === PRIM_ROUND_CONE)
    primParams.set(
      [prim.h, prim.ra, prim.rb, 1 / prim.sx, prim.b, prim.a_, prim.ta, prim.tb],
      index * 8
    );
  else if (prim.type === PRIM_ELLIPSOID)
    primParams.set(
      [1 / prim.r[0], 1 / prim.r[1], 1 / prim.r[2], Math.min(prim.r[0], prim.r[1], prim.r[2])],
      index * 8
    );
  else primParams.set([prim.hh[0], prim.hh[1], prim.hh[2], prim.rr], index * 8);
});

/** Influence distance of the last `primitiveDistance` call (used for skinning). */
let lastPrimInfluenceDistance = 0;

/** Signed distance from a point to one packed primitive. */
function primitiveDistance(prim: number, x: number, y: number, z: number): number {
  const originOffset = prim * 3;
  const basisOffset = prim * 9;
  const paramOffset = prim * 8;
  const dx = x - primOrigins[originOffset];
  const dy = y - primOrigins[originOffset + 1];
  const dz = z - primOrigins[originOffset + 2];
  const localX =
    dx * primBases[basisOffset] + dy * primBases[basisOffset + 1] + dz * primBases[basisOffset + 2];
  const localY =
    dx * primBases[basisOffset + 3] +
    dy * primBases[basisOffset + 4] +
    dz * primBases[basisOffset + 5];
  const localZ =
    dx * primBases[basisOffset + 6] +
    dy * primBases[basisOffset + 7] +
    dz * primBases[basisOffset + 8];
  const type = primTypes[prim];
  if (type === PRIM_ROUND_CONE) {
    const length = primParams[paramOffset];
    const radiusA = primParams[paramOffset + 1];
    const scaledX = localX * primParams[paramOffset + 3];
    const radial = Math.sqrt(scaledX * scaledX + localY * localY);
    const along = -localZ;
    const slope = primParams[paramOffset + 4];
    const slopeCos = primParams[paramOffset + 5];
    const k = along * slopeCos - radial * slope;
    const distance =
      k < 0
        ? Math.sqrt(radial * radial + along * along) - radiusA
        : k > slopeCos * length
          ? Math.sqrt(radial * radial + (along - length) * (along - length)) -
            primParams[paramOffset + 2]
          : radial * slopeCos + along * slope - radiusA;
    lastPrimInfluenceDistance = Math.max(
      distance,
      primParams[paramOffset + 6] - along,
      along - length + primParams[paramOffset + 7]
    );
    return distance;
  }
  if (type === PRIM_ELLIPSOID) {
    const sx = localX * primParams[paramOffset];
    const sy = localY * primParams[paramOffset + 1];
    const sz = localZ * primParams[paramOffset + 2];
    const k0 = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (k0 < 1e-9) return (lastPrimInfluenceDistance = -primParams[paramOffset + 3]);
    const gx = sx * primParams[paramOffset];
    const gy = sy * primParams[paramOffset + 1];
    const gz = sz * primParams[paramOffset + 2];
    return (lastPrimInfluenceDistance = (k0 * (k0 - 1)) / Math.sqrt(gx * gx + gy * gy + gz * gz));
  }
  const round = primParams[paramOffset + 3];
  const qx = Math.abs(localX) - primParams[paramOffset] + round;
  const qy = Math.abs(localY) - primParams[paramOffset + 1] + round;
  const qz = Math.abs(localZ) - primParams[paramOffset + 2] + round;
  const ox = qx > 0 ? qx : 0;
  const oy = qy > 0 ? qy : 0;
  const oz = qz > 0 ? qz : 0;
  return (lastPrimInfluenceDistance =
    Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - round);
}

/** Polynomial smooth minimum with blend radius `k`. */
const smoothMin = (a: number, b: number, k: number): number => {
  const h = k - Math.abs(a - b);
  return h <= 0 ? (a < b ? a : b) : (a < b ? a : b) - (h * h) / (4 * k);
};
const tmpGroupDistances = new Float64Array(GROUP_COUNT);
const primDistances = new Float64Array(PRIM_COUNT);
const primInfluenceDistances = new Float64Array(PRIM_COUNT);
let gloveSdfEvalCount = 0;

/** Glove signed distance; with `record`, stores per-primitive distances for skinning. */
function gloveSdf(x: number, y: number, z: number, record = false): number {
  gloveSdfEvalCount++;
  for (let group = 0; group < GROUP_COUNT; group++) tmpGroupDistances[group] = 1e9;
  for (let prim = 0; prim < PRIM_COUNT; prim++) {
    const sphereOffset = prim * 4;
    const dx = x - primBoundSpheres[sphereOffset];
    const dy = y - primBoundSpheres[sphereOffset + 1];
    const dz = z - primBoundSpheres[sphereOffset + 2];
    const boundDistance =
      Math.sqrt(dx * dx + dy * dy + dz * dz) - primBoundSpheres[sphereOffset + 3];
    let distance: number;
    if (boundDistance > BOUND_SKIP_MARGIN) {
      distance = boundDistance;
      if (record) {
        primDistances[prim] = boundDistance;
        primInfluenceDistances[prim] = boundDistance;
      }
    } else {
      distance = primitiveDistance(prim, x, y, z);
      if (record) {
        primDistances[prim] = distance;
        primInfluenceDistances[prim] = lastPrimInfluenceDistance;
      }
    }
    const group = primGroups[prim];
    tmpGroupDistances[group] = smoothMin(tmpGroupDistances[group], distance, primBlendK[prim]);
  }
  let body = smoothMin(
    tmpGroupDistances[GROUP_PALM],
    tmpGroupDistances[GROUP_THUMB],
    THUMB_BLEND_K
  );
  body = smoothMin(body, tmpGroupDistances[GROUP_CUFF], CUFF_BLEND_K);
  const fingers = Math.min(
    tmpGroupDistances[1],
    tmpGroupDistances[2],
    tmpGroupDistances[3],
    tmpGroupDistances[4]
  );
  return smoothMin(
    smoothMin(body, fingers, FINGER_BLEND_K),
    tmpGroupDistances[GROUP_KNUCKLE_GUARD],
    GUARD_BLEND_K
  );
}

const palmPrimIndices: number[] = [];
glovePrimitives.forEach((prim, index) => {
  if (prim.bone === BONE.hand && prim.group !== GROUP_THUMB) palmPrimIndices.push(index);
});

/** Signed distance to the palm part of the glove (hand space). */
export function palmSdf(x: number, y: number, z: number): number {
  let palm = 1e9;
  let guard = 1e9;
  for (const prim of palmPrimIndices) {
    const distance = primitiveDistance(prim, x, y, z);
    if (primGroups[prim] === GROUP_KNUCKLE_GUARD)
      guard = smoothMin(guard, distance, primBlendK[prim]);
    else palm = smoothMin(palm, distance, primBlendK[prim]);
  }
  return Math.min(palm, guard);
}

/** Grid coordinates from `start` to at least `end`, spaced by `step(coordinate)`. */
function adaptiveGridAxis(start: number, end: number, step: (at: number) => number): Float64Array {
  const coords = [start];
  while (coords[coords.length - 1] < end)
    coords.push(coords[coords.length - 1] + step(coords[coords.length - 1]));
  return Float64Array.from(coords);
}

const CUBE_CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1]
];
const CUBE_EDGES = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7]
];

/**
 * Surface nets over the glove SDF on the given grid axes, flood-filled from
 * the cell containing `seed`. Returns vertex positions and triangle indices.
 */
function extractSurfaceNets(
  xs: Float64Array,
  ys: Float64Array,
  zs: Float64Array,
  seed: number[]
): { pos: number[]; idx: number[] } {
  const nx = xs.length;
  const ny = ys.length;
  const nz = zs.length;
  const strideX = 1;
  const strideY = nx;
  const strideZ = nx * ny;
  const total = nx * ny * nz;
  const samples = new Float32Array(total).fill(NaN);
  const cellVertex = new Int32Array(total).fill(-1);
  const cornerValues = new Float64Array(8);
  const sample = (cell: number): number => {
    let value = samples[cell];
    if (value !== value) {
      const iz = (cell / strideZ) | 0;
      const rest = cell - iz * strideZ;
      const iy = (rest / nx) | 0;
      value = gloveSdf(xs[rest - iy * nx], ys[iy], zs[iz]);
      if (value === 0) value = 1e-9;
      samples[cell] = value;
    }
    return value;
  };
  const cornerOffsets = CUBE_CORNERS.map(
    (corner) => corner[0] * strideX + corner[1] * strideY + corner[2] * strideZ
  );
  let startX = 0;
  let startY = 0;
  let startZ = 0;
  while (xs[startX + 1] < seed[0]) startX++;
  while (ys[startY + 1] < seed[1]) startY++;
  while (zs[startZ + 1] < seed[2]) startZ++;
  // Walk up from the seed until the surface is crossed.
  while (
    startY < ny - 2 &&
    !(
      sample(startX + startY * strideY + startZ * strideZ) < 0 &&
      sample(startX + (startY + 1) * strideY + startZ * strideZ) > 0
    )
  )
    startY++;
  const positions: number[] = [];
  const vertexCells: number[] = [];
  const stack = [startX + startY * strideY + startZ * strideZ];
  while (stack.length) {
    const cell = stack.pop()!; // non-empty: checked by the loop condition
    if (cellVertex[cell] !== -1) continue;
    const iz = (cell / strideZ) | 0;
    const rest = cell - iz * strideZ;
    const iy = (rest / nx) | 0;
    const ix = rest - iy * nx;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx - 1 || iy >= ny - 1 || iz >= nz - 1) {
      cellVertex[cell] = -2;
      continue;
    }
    let mask = 0;
    for (let corner = 0; corner < 8; corner++) {
      cornerValues[corner] = sample(cell + cornerOffsets[corner]);
      if (cornerValues[corner] < 0) mask |= 1 << corner;
    }
    if (mask === 0 || mask === 255) {
      cellVertex[cell] = -2;
      continue;
    }
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let crossings = 0;
    for (let edge = 0; edge < 12; edge++) {
      const cornerA = CUBE_EDGES[edge][0];
      const cornerB = CUBE_EDGES[edge][1];
      if (((mask >> cornerA) & 1) === ((mask >> cornerB) & 1)) continue;
      const t = cornerValues[cornerA] / (cornerValues[cornerA] - cornerValues[cornerB]);
      const a = CUBE_CORNERS[cornerA];
      const b = CUBE_CORNERS[cornerB];
      sumX += xs[ix + a[0]] + (xs[ix + b[0]] - xs[ix + a[0]]) * t;
      sumY += ys[iy + a[1]] + (ys[iy + b[1]] - ys[iy + a[1]]) * t;
      sumZ += zs[iz + a[2]] + (zs[iz + b[2]] - zs[iz + a[2]]) * t;
      crossings++;
    }
    cellVertex[cell] = vertexCells.length;
    vertexCells.push(cell);
    positions.push(sumX / crossings, sumY / crossings, sumZ / crossings);
    // True if the face with these four corners is crossed by the surface.
    const faceCrossed = (c0: number, c1: number, c2: number, c3: number): boolean => {
      const inside = (mask >> c0) & 1;
      return (
        inside !== ((mask >> c1) & 1) ||
        inside !== ((mask >> c2) & 1) ||
        inside !== ((mask >> c3) & 1)
      );
    };
    if (faceCrossed(0, 2, 4, 6)) stack.push(cell - strideX);
    if (faceCrossed(1, 3, 5, 7)) stack.push(cell + strideX);
    if (faceCrossed(0, 1, 4, 5)) stack.push(cell - strideY);
    if (faceCrossed(2, 3, 6, 7)) stack.push(cell + strideY);
    if (faceCrossed(0, 1, 2, 3)) stack.push(cell - strideZ);
    if (faceCrossed(4, 5, 6, 7)) stack.push(cell + strideZ);
  }
  const indices: number[] = [];
  const verts = positions;
  // Emits a quad as two triangles split along its shorter diagonal.
  const emitQuad = (v0: number, v1: number, v2: number, v3: number, flip: boolean): void => {
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return;
    if (flip) {
      const swap = v1;
      v1 = v3;
      v3 = swap;
    }
    const diagonalA =
      (verts[v0 * 3] - verts[v2 * 3]) ** 2 +
      (verts[v0 * 3 + 1] - verts[v2 * 3 + 1]) ** 2 +
      (verts[v0 * 3 + 2] - verts[v2 * 3 + 2]) ** 2;
    const diagonalB =
      (verts[v1 * 3] - verts[v3 * 3]) ** 2 +
      (verts[v1 * 3 + 1] - verts[v3 * 3 + 1]) ** 2 +
      (verts[v1 * 3 + 2] - verts[v3 * 3 + 2]) ** 2;
    if (diagonalA <= diagonalB) indices.push(v0, v1, v2, v0, v2, v3);
    else indices.push(v0, v1, v3, v1, v2, v3);
  };
  for (let vertex = 0; vertex < vertexCells.length; vertex++) {
    const cell = vertexCells[vertex];
    const value = samples[cell];
    if (value < 0 !== samples[cell + strideX] < 0)
      emitQuad(
        cellVertex[cell],
        cellVertex[cell - strideY],
        cellVertex[cell - strideY - strideZ],
        cellVertex[cell - strideZ],
        value > 0
      );
    if (value < 0 !== samples[cell + strideY] < 0)
      emitQuad(
        cellVertex[cell],
        cellVertex[cell - strideX],
        cellVertex[cell - strideX - strideZ],
        cellVertex[cell - strideZ],
        value < 0
      );
    if (value < 0 !== samples[cell + strideZ] < 0)
      emitQuad(
        cellVertex[cell],
        cellVertex[cell - strideX],
        cellVertex[cell - strideX - strideY],
        cellVertex[cell - strideY],
        value > 0
      );
  }
  return {
    pos: positions,
    idx: indices
  };
}

/** Skin weight from a normalised influence distance (1 inside, 0 at >= 1). */
const skinWeightFalloff = (distance: number): number => {
  if (distance >= 1) return 0;
  if (distance <= 0) return 1;
  const t = 1 - distance;
  return t * t * (3 - 2 * t);
};
const SKIN_BONE_COUNT = BONE.count;
const tmpBoneWeights = new Float64Array(SKIN_BONE_COUNT);
/** Which bones may share a vertex (symmetric matrix). */
const BONE_ADJACENCY = new Uint8Array(SKIN_BONE_COUNT * SKIN_BONE_COUNT);
{
  const link = (a: number, b: number): void => {
    BONE_ADJACENCY[a * SKIN_BONE_COUNT + b] = BONE_ADJACENCY[b * SKIN_BONE_COUNT + a] = 1;
  };
  for (let bone = 0; bone < SKIN_BONE_COUNT; bone++)
    BONE_ADJACENCY[bone * SKIN_BONE_COUNT + bone] = 1;
  link(BONE.hand, BONE.twist2);
  for (let digit = 0; digit < 5; digit++) {
    const chain = [
      BONE.hand,
      BONE.helper(digit, 0),
      BONE.digit(digit, 0),
      BONE.helper(digit, 1),
      BONE.digit(digit, 1),
      BONE.helper(digit, 2),
      BONE.digit(digit, 2)
    ];
    for (let i = 0; i < chain.length; i++)
      for (let j = i + 1; j <= i + 2 && j < chain.length; j++) link(chain[i], chain[j]);
    if (digit > 0 && digit < 4)
      for (const bone of [BONE.helper(digit, 0), BONE.digit(digit, 0)])
        for (const neighbour of [BONE.helper(digit + 1, 0), BONE.digit(digit + 1, 0)])
          link(bone, neighbour);
  }
}

const KNUCKLE_XS = [1, 2, 3, 4].map((digit) => DIGITS[digit].base[0]);
const KNUCKLE_ZS = [1, 2, 3, 4].map((digit) => DIGITS[digit].base[2]);

/** Continuous finger coordinate (1..4) and knuckle Z for a palm X position. */
function palmDigitCoord(x: number): [number, number] {
  if (x <= KNUCKLE_XS[0]) return [Math.max(0.3, 1 + (x - KNUCKLE_XS[0]) / 0.016), KNUCKLE_ZS[0]];
  for (let i = 0; i < 3; i++)
    if (x <= KNUCKLE_XS[i + 1]) {
      const t = (x - KNUCKLE_XS[i]) / (KNUCKLE_XS[i + 1] - KNUCKLE_XS[i]);
      return [1 + i + t, KNUCKLE_ZS[i] + (KNUCKLE_ZS[i + 1] - KNUCKLE_ZS[i]) * t];
    }
  return [Math.min(4.7, 4 + (x - KNUCKLE_XS[3]) / 0.016), KNUCKLE_ZS[3]];
}

const tmpDigitCoord = [0, 0, 0, 0];

/**
 * Point coordinates relative to a digit in the REST pose:
 * `[distance along the digit, up component, side component, distance to axis]`.
 * Returns a shared scratch array.
 */
function digitLocalCoord(digit: number, x: number, y: number, z: number): number[] {
  let best = 1e9;
  for (let phalanx = 0; phalanx < 3; phalanx++) {
    const start = restJoint(digit, phalanx);
    const end = restJoint(digit, phalanx + 1);
    const ax = end.x - start.x;
    const ay = end.y - start.y;
    const az = end.z - start.z;
    const lengthSq = ax * ax + ay * ay + az * az;
    let t = ((x - start.x) * ax + (y - start.y) * ay + (z - start.z) * az) / lengthSq;
    t = Math.max(phalanx === 0 ? -0.5 : 0, Math.min(1, t));
    const ox = x - start.x - ax * t;
    const oy = y - start.y - ay * t;
    const oz = z - start.z - az * t;
    const distance = Math.hypot(ox, oy, oz);
    if (distance < best) {
      best = distance;
      const sideAxis = restPhalanxAxis(digit, phalanx, 0);
      const upAxis = restPhalanxAxis(digit, phalanx, 1);
      const norm = distance || 1;
      tmpDigitCoord[0] =
        (phalanx > 0 ? DIGITS[digit].len[0] : 0) +
        (phalanx > 1 ? DIGITS[digit].len[1] : 0) +
        t * DIGITS[digit].len[phalanx];
      tmpDigitCoord[1] = (ox * upAxis.x + oy * upAxis.y + oz * upAxis.z) / norm;
      tmpDigitCoord[2] = (ox * sideAxis.x + oy * sideAxis.y + oz * sideAxis.z) / norm;
    }
  }
  tmpDigitCoord[3] = best;
  return tmpDigitCoord;
}

const gloveSmoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Sleeve radius (with wrinkles) at distance `z` along the forearm and angle
 * `angle`. When `wrinkleOut` is given, its slot 0 receives the wrinkle amount.
 */
function sleeveRadiusAt(z: number, angle: number, wrinkleOut: number[] | null): number {
  const along = (z - 0.066) / (SLEEVE_SPEC.end - 0.066);
  const wristBunch = 0.0042 * Math.exp(-Math.pow((z - 0.105) / 0.04, 2));
  const elbowBunch = 0.005 * gloveSmoothstep(0.19, 0.25, z) * (1 - gloveSmoothstep(0.33, 0.4, z));
  const foldsA =
    Math.pow(
      Math.abs(
        Math.sin(
          (Math.PI * z) / 0.029 + 1.7 * Math.sin(angle + 0.5) + 0.8 * Math.sin(2 * angle + 1.3)
        )
      ),
      0.6
    ) *
      2 -
    1.25;
  const foldsB =
    Math.pow(
      Math.abs(
        Math.sin((Math.PI * z) / 0.036 + 1.9 * Math.sin(angle - 0.8) + 0.7 * Math.sin(2 * angle))
      ),
      0.6
    ) *
      2 -
    1.25;
  const ripple =
    Math.sin(z * 38 + 2 * Math.sin(angle * 2 + 1)) + 0.6 * Math.sin(3 * angle + z * 23);
  const baseRadius =
    0.041 +
    0.015 * Math.pow(Math.max(0, Math.min(1, along * 1.9)), 0.8) +
    0.0035 * gloveSmoothstep(0.3, 0.42, z) +
    0.0022 * Math.exp(-Math.pow((z - 0.08) / 0.012, 2));
  const seam =
    0.0016 * Math.exp(-Math.pow(Math.atan2(Math.sin(angle + 1.9), Math.cos(angle + 1.9)) / 0.1, 2));
  if (wrinkleOut)
    wrinkleOut[0] =
      ((wristBunch * foldsA + elbowBunch * foldsB) / (wristBunch + elbowBunch + 8e-4)) * 0.8 +
      0.1 * ripple;
  return baseRadius + wristBunch * foldsA + elbowBunch * foldsB + 0.0015 * ripple + seam;
}

/** Appends the lathed sleeve (cuff hem, wrinkled sleeve, end cap) to the mesh arrays. */
function appendSleeveMesh(mesh: MeshArrays): void {
  // Profile rows: [z, radius (or -1 for the wrinkled sleeve), 0].
  const profile: number[][] = [];
  const wrinkle = [0];
  const hemProfile = [
    [0.053, 0.0238, 0],
    [0.049, 0.0262, 0],
    [0.0462, 0.0318, 0],
    [0.0462, 0.0356, 0],
    [0.049, 0.0382, 0],
    [0.053, 0.0388, 0],
    [0.06, 0.0384, 0],
    [0.065, 0.0368, 0]
  ];
  for (const row of hemProfile) profile.push(row);
  for (let z = 0.072; z < 0.3; z += 0.0072) profile.push([z, -1, 0]);
  for (let z = 0.309; z < SLEEVE_SPEC.end - 0.02; z += 0.015) profile.push([z, -1, 0]);
  const rowCount = profile.length;
  const capZ = [SLEEVE_SPEC.end - 0.018, SLEEVE_SPEC.end - 0.006, SLEEVE_SPEC.end];
  const firstVertex = mesh.pos.length / 3;
  const ringPoints: number[][] = [];
  const profilePoint = (row: number, angle: number): number[] => {
    const [z, radius] = profile[row];
    if (radius >= 0) {
      const hemBlend = gloveSmoothstep(0.0262, 0.0356, radius);
      return [
        Math.cos(angle) * radius * (1.4 - 0.4 * hemBlend),
        Math.sin(angle) * radius * (1 - 0.1 * hemBlend) + 5e-4,
        z
      ];
    }
    const sleeveRadius =
      sleeveRadiusAt(z, angle, wrinkle) * (0.9 + 0.1 * gloveSmoothstep(0.066, 0.085, z));
    return [Math.cos(angle) * sleeveRadius, Math.sin(angle) * sleeveRadius * 0.9 + 5e-4, z];
  };
  const pushVertex = (
    point: number[],
    normal: number[],
    z: number,
    angle: number,
    wrinkleAmount: number
  ): void => {
    mesh.pos.push(point[0], point[1], point[2]);
    mesh.nrm.push(normal[0], normal[1], normal[2]);
    mesh.rest.push(point[0], point[1], point[2], 1);
    mesh.hand.push(z, wrinkleAmount, Math.sin(angle), Math.cos(angle));
    const twist1Blend = gloveSmoothstep(0.095, 0.165, z);
    const forearmBlend = gloveSmoothstep(0.165, 0.235, z);
    const elbowBlend = gloveSmoothstep(ARM.fore - 0.045, ARM.fore + 0.045, z);
    mesh.si.push(BONE.twist2, BONE.twist1, BONE.forearm, BONE.upperArm);
    mesh.sw.push(
      (1 - twist1Blend) * (1 - elbowBlend),
      twist1Blend * (1 - forearmBlend) * (1 - elbowBlend),
      forearmBlend * (1 - elbowBlend),
      elbowBlend
    );
  };
  for (let row = 0; row < rowCount; row++)
    for (let segment = 0; segment < 24; segment++) {
      const angle = (segment / 24) * Math.PI * 2;
      const point = profilePoint(row, angle);
      const pointAround = profilePoint(row, angle + 0.001);
      const pointNext = row < rowCount - 1 ? profilePoint(row + 1, angle) : null;
      const pointPrev = row > 0 ? profilePoint(row - 1, angle) : null;
      const tangentAround = [
        pointAround[0] - point[0],
        pointAround[1] - point[1],
        pointAround[2] - point[2]
      ];
      const ahead = pointNext || point;
      const behind = pointPrev || point;
      const tangentAlong = [ahead[0] - behind[0], ahead[1] - behind[1], ahead[2] - behind[2]];
      let normal = [
        tangentAround[1] * tangentAlong[2] - tangentAround[2] * tangentAlong[1],
        tangentAround[2] * tangentAlong[0] - tangentAround[0] * tangentAlong[2],
        tangentAround[0] * tangentAlong[1] - tangentAround[1] * tangentAlong[0]
      ];
      const normalLength = Math.hypot(normal[0], normal[1], normal[2]) || 1;
      normal = normal.map((value) => value / normalLength);
      // Recompute the wrinkle for this exact point (the neighbours overwrote it).
      if (profile[row][1] < 0) sleeveRadiusAt(profile[row][0], angle, wrinkle);
      else wrinkle[0] = 0;
      pushVertex(point, normal, profile[row][0], angle, wrinkle[0]);
      ringPoints.push(point);
    }
  // End cap rings and centre.
  for (let ring = 0; ring < 2; ring++)
    for (let segment = 0; segment < 24; segment++) {
      const angle = (segment / 24) * Math.PI * 2;
      const shrink = [0.8, 0.42][ring];
      const radius = sleeveRadiusAt(SLEEVE_SPEC.end - 0.02, angle, null);
      const point = [
        Math.cos(angle) * radius * shrink,
        Math.sin(angle) * radius * 0.9 * shrink + 5e-4,
        capZ[ring]
      ];
      const normalZ = [0.55, 0.9][ring];
      const normalXY = Math.sqrt(1 - normalZ * normalZ);
      pushVertex(
        point,
        [Math.cos(angle) * normalXY, Math.sin(angle) * normalXY, normalZ],
        capZ[ring],
        angle,
        0
      );
    }
  pushVertex([0, 5e-4, capZ[2]], [0, 0, 1], capZ[2], 0, 0);
  const ringCount = rowCount + 2;
  const centerVertex = firstVertex + ringCount * 24;
  for (let ring = 0; ring < ringCount - 1; ring++)
    for (let segment = 0; segment < 24; segment++) {
      const a = firstVertex + ring * 24 + segment;
      const b = firstVertex + ring * 24 + ((segment + 1) % 24);
      const c = a + 24;
      const d = b + 24;
      mesh.idx.push(a, b, c, b, d, c);
    }
  for (let segment = 0; segment < 24; segment++)
    mesh.idx.push(
      firstVertex + (ringCount - 1) * 24 + segment,
      firstVertex + (ringCount - 1) * 24 + ((segment + 1) % 24),
      centerVertex
    );
}

let cachedGloveMesh: GloveMesh | null = null;

/** Builds (once, then cached) the skinned right-hand glove + sleeve mesh. */
export function buildGloveMesh(options: GloveMeshOptions = {}): GloveMesh {
  if (cachedGloveMesh && !options.force) return cachedGloveMesh;
  const startTime = performance.now();
  gloveSdfEvalCount = 0;
  const spacingXY = options.hxy || 0.0034;
  const spacingFingers = options.hzF || 0.0047;
  const spacingPalm = options.hzP || 0.006;
  const spacingCuff = options.hzC || 0.008;
  const boundsMin = [1e9, 1e9, 1e9];
  const boundsMax = [-1e9, -1e9, -1e9];
  for (const prim of glovePrimitives)
    for (let axis = 0; axis < 3; axis++) {
      boundsMin[axis] = Math.min(boundsMin[axis], prim.bc[axis] - prim.br);
      boundsMax[axis] = Math.max(boundsMax[axis], prim.bc[axis] + prim.br);
    }
  const margin = 0.006;
  const xs = adaptiveGridAxis(boundsMin[0] - margin, boundsMax[0] + margin, () => spacingXY);
  const ys = adaptiveGridAxis(boundsMin[1] - margin, boundsMax[1] + margin, () => spacingXY);
  const zs = adaptiveGridAxis(boundsMin[2] - margin, boundsMax[2] + margin, (z) =>
    z < -0.022 ? spacingFingers : z < 0.004 ? spacingPalm : spacingCuff
  );
  const { pos: positions, idx: indices } = extractSurfaceNets(xs, ys, zs, [0, 0, -0.05]);
  const vertexCount = positions.length / 3;
  const mesh: MeshArrays = {
    pos: positions,
    nrm: new Array(vertexCount * 3),
    idx: indices,
    si: new Array(vertexCount * 4),
    sw: new Array(vertexCount * 4),
    rest: new Array(vertexCount * 4),
    hand: new Array(vertexCount * 4)
  };
  const epsilon = 6e-4;
  const topBones = [0, 0, 0, 0];
  const topWeights = [0, 0, 0, 0];
  const digitWeights = [0, 0, 0, 0, 0];

  // Project vertices onto the surface, compute normals and initial skin weights.
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    let x = positions[vertex * 3];
    let y = positions[vertex * 3 + 1];
    let z = positions[vertex * 3 + 2];
    // Tetrahedral gradient.
    const d0 = gloveSdf(x + epsilon, y - epsilon, z - epsilon);
    const d1 = gloveSdf(x - epsilon, y - epsilon, z + epsilon);
    const d2 = gloveSdf(x - epsilon, y + epsilon, z - epsilon);
    const d3 = gloveSdf(x + epsilon, y + epsilon, z + epsilon);
    let gx = (d0 - d1 - d2 + d3) / (4 * epsilon);
    let gy = (-d0 - d1 + d2 + d3) / (4 * epsilon);
    let gz = (-d0 + d1 - d2 + d3) / (4 * epsilon);
    const gradientSq = gx * gx + gy * gy + gz * gz || 1e-12;
    let step = -((d0 + d1 + d2 + d3) / 4) / gradientSq;
    const stepLength = Math.abs(step) * Math.sqrt(gradientSq);
    if (stepLength > 0.0012) step *= 0.0012 / stepLength;
    x += gx * step;
    y += gy * step;
    z += gz * step;
    positions[vertex * 3] = x;
    positions[vertex * 3 + 1] = y;
    positions[vertex * 3 + 2] = z;
    const gradientLength = Math.sqrt(gradientSq);
    gx /= gradientLength;
    gy /= gradientLength;
    gz /= gradientLength;
    mesh.nrm[vertex * 3] = gx;
    mesh.nrm[vertex * 3 + 1] = gy;
    mesh.nrm[vertex * 3 + 2] = gz;
    gloveSdf(x, y, z, true);
    tmpBoneWeights.fill(0);
    let nearestBone = 0;
    let nearestDistance = 1e9;
    for (let prim = 0; prim < PRIM_COUNT; prim++) {
      const normalized = primInfluenceDistances[prim] / glovePrimitives[prim].R;
      const weight = skinWeightFalloff(normalized);
      if (weight > tmpBoneWeights[primBones[prim]]) tmpBoneWeights[primBones[prim]] = weight;
      if (normalized < nearestDistance) {
        nearestDistance = normalized;
        nearestBone = primBones[prim];
      }
    }
    if (tmpBoneWeights[nearestBone] < 1e-4) tmpBoneWeights[nearestBone] = 1e-4;
    let dominantBone = 0;
    for (let bone = 1; bone < SKIN_BONE_COUNT; bone++)
      if (tmpBoneWeights[bone] > tmpBoneWeights[dominantBone]) dominantBone = bone;
    topBones.fill(-1);
    topWeights.fill(0);
    // Keep the 4 heaviest bones adjacent to the dominant one (insertion sort).
    for (let bone = 0; bone < SKIN_BONE_COUNT; bone++) {
      const weight = BONE_ADJACENCY[dominantBone * SKIN_BONE_COUNT + bone]
        ? tmpBoneWeights[bone]
        : 0;
      if (weight <= topWeights[3]) continue;
      let slot = 3;
      while (slot > 0 && weight > topWeights[slot - 1]) {
        topWeights[slot] = topWeights[slot - 1];
        topBones[slot] = topBones[slot - 1];
        slot--;
      }
      topWeights[slot] = weight;
      topBones[slot] = bone;
    }
    const weightSum = topWeights[0] + topWeights[1] + topWeights[2] + topWeights[3] || 1;
    for (let slot = 0; slot < 4; slot++) {
      mesh.si[vertex * 4 + slot] = topBones[slot] < 0 ? 0 : topBones[slot];
      mesh.sw[vertex * 4 + slot] = topWeights[slot] / weightSum;
    }
  }

  // Relax skin weights over mesh neighbours.
  {
    const neighbours: number[][] = Array.from(
      {
        length: vertexCount
      },
      () => []
    );
    const seenEdges = new Set<number>();
    for (let tri = 0; tri < indices.length; tri += 3)
      for (let corner = 0; corner < 3; corner++) {
        const a = indices[tri + corner];
        const b = indices[tri + ((corner + 1) % 3)];
        const key = a < b ? a * vertexCount + b : b * vertexCount + a;
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          neighbours[a].push(b);
          neighbours[b].push(a);
        }
      }
    const accumulated = new Float64Array(SKIN_BONE_COUNT);
    for (let pass = 0; pass < (options.relax ?? 3); pass++) {
      const prevBones = mesh.si.slice();
      const prevWeights = mesh.sw.slice();
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        accumulated.fill(0);
        const around = neighbours[vertex];
        const neighbourShare = 1 / around.length;
        for (let slot = 0; slot < 4; slot++)
          accumulated[prevBones[vertex * 4 + slot]] += prevWeights[vertex * 4 + slot];
        for (const other of around)
          for (let slot = 0; slot < 4; slot++)
            accumulated[prevBones[other * 4 + slot]] +=
              prevWeights[other * 4 + slot] * neighbourShare;
        topBones.fill(-1);
        topWeights.fill(0);
        for (let bone = 0; bone < SKIN_BONE_COUNT; bone++) {
          const weight = accumulated[bone];
          if (weight <= topWeights[3]) continue;
          let slot = 3;
          while (slot > 0 && weight > topWeights[slot - 1]) {
            topWeights[slot] = topWeights[slot - 1];
            topBones[slot] = topBones[slot - 1];
            slot--;
          }
          topWeights[slot] = weight;
          topBones[slot] = bone;
        }
        const weightSum = topWeights[0] + topWeights[1] + topWeights[2] + topWeights[3];
        for (let slot = 0; slot < 4; slot++) {
          mesh.si[vertex * 4 + slot] = topBones[slot] < 0 ? 0 : topBones[slot];
          mesh.sw[vertex * 4 + slot] = topWeights[slot] / weightSum;
        }
      }
    }
  }

  // Rest positions and hand-space shading coordinates.
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const x = positions[vertex * 3];
    const y = positions[vertex * 3 + 1];
    const z = positions[vertex * 3 + 2];
    const normalY = mesh.nrm[vertex * 3 + 1];
    let palmWeight = 0;
    digitWeights.fill(0);
    for (let slot = 0; slot < 4; slot++) {
      const bone = mesh.si[vertex * 4 + slot];
      const weight = mesh.sw[vertex * 4 + slot];
      if (bone >= 5)
        digitWeights[bone >= 20 ? ((bone - 20) / 3) | 0 : ((bone - 5) / 3) | 0] += weight;
      else palmWeight += weight;
    }
    const palmCoord = palmDigitCoord(x);
    let along = (palmCoord[1] - z) * palmWeight;
    let digitCoord = palmCoord[0] * palmWeight;
    let up = normalY * palmWeight;
    let side = Math.max(-1, Math.min(1, x / 0.045)) * palmWeight;
    const palmSide = Math.max(-1, Math.min(1, x / 0.045));
    for (let digit = 0; digit < 5; digit++)
      if (digitWeights[digit] > 0) {
        const local = digitLocalCoord(digit, x, y, z);
        let localUp = local[1];
        let localSide = local[2];
        if (digit === 0) {
          // Fade the thumb's base into palm coordinates.
          const blend = gloveSmoothstep(0.55, 1.05, local[0] / DIGITS[0].len[0]);
          localUp = normalY + (localUp - normalY) * blend;
          localSide = palmSide + (localSide - palmSide) * blend;
        }
        along += local[0] * digitWeights[digit];
        digitCoord += digit * digitWeights[digit];
        up += localUp * digitWeights[digit];
        side += localSide * digitWeights[digit];
      }
    mesh.rest[vertex * 4] = x;
    mesh.rest[vertex * 4 + 1] = y;
    mesh.rest[vertex * 4 + 2] = z;
    mesh.rest[vertex * 4 + 3] = 0;
    mesh.hand[vertex * 4] = along;
    mesh.hand[vertex * 4 + 1] = digitCoord;
    mesh.hand[vertex * 4 + 2] = up;
    mesh.hand[vertex * 4 + 3] = side;
  }

  // Weld near-coincident vertices (union-find) and drop degenerate triangles.
  {
    const parent = new Int32Array(vertexCount);
    const kept: number[] = [];
    for (let vertex = 0; vertex < vertexCount; vertex++) parent[vertex] = vertex;
    const findRoot = (vertex: number): number => {
      while (parent[vertex] !== vertex) {
        const grandparent = parent[parent[vertex]];
        parent[vertex] = grandparent;
        vertex = grandparent;
      }
      return vertex;
    };
    for (let tri = 0; tri < indices.length; tri += 3)
      for (let corner = 0; corner < 3; corner++) {
        const a = findRoot(indices[tri + corner]);
        const b = findRoot(indices[tri + ((corner + 1) % 3)]);
        if (
          a !== b &&
          Math.hypot(
            positions[a * 3] - positions[b * 3],
            positions[a * 3 + 1] - positions[b * 3 + 1],
            positions[a * 3 + 2] - positions[b * 3 + 2]
          ) < 25e-5
        )
          parent[Math.max(a, b)] = Math.min(a, b);
      }
    const remap = new Int32Array(vertexCount).fill(-1);
    for (let vertex = 0; vertex < vertexCount; vertex++)
      if (findRoot(vertex) === vertex) {
        remap[vertex] = kept.length;
        kept.push(vertex);
      }
    if (kept.length < vertexCount) {
      const newIndices: number[] = [];
      for (let tri = 0; tri < indices.length; tri += 3) {
        const a = remap[findRoot(indices[tri])];
        const b = remap[findRoot(indices[tri + 1])];
        const c = remap[findRoot(indices[tri + 2])];
        if (a !== b && b !== c && a !== c) newIndices.push(a, b, c);
      }
      indices.length = 0;
      for (const index of newIndices) indices.push(index);
      const attributes: [number[], number][] = [
        [positions, 3],
        [mesh.nrm, 3],
        [mesh.si, 4],
        [mesh.sw, 4],
        [mesh.rest, 4],
        [mesh.hand, 4]
      ];
      for (const [array, size] of attributes) {
        for (let i = 0; i < kept.length; i++)
          for (let component = 0; component < size; component++)
            array[i * size + component] = array[kept[i] * size + component];
        array.length = kept.length * size;
      }
    }
  }
  const gloveVerts = positions.length / 3;
  const gloveTris = indices.length / 3;
  appendSleeveMesh(mesh);
  cachedGloveMesh = {
    position: Float32Array.from(mesh.pos),
    normal: Float32Array.from(mesh.nrm),
    skinIndex: Uint16Array.from(mesh.si),
    skinWeight: Float32Array.from(mesh.sw),
    rest: Float32Array.from(mesh.rest),
    hand: Float32Array.from(mesh.hand),
    index: Uint32Array.from(mesh.idx),
    vertexCount: mesh.pos.length / 3,
    triCount: mesh.idx.length / 3,
    gloveVerts,
    gloveTris,
    evals: gloveSdfEvalCount,
    ms: performance.now() - startTime
  };
  return cachedGloveMesh;
}

/** Mirrors a glove mesh across X (left hand): negates X and flips triangle winding. */
export function mirrorGloveMesh(source: GloveMesh): GloveMesh {
  const position = Float32Array.from(source.position);
  const normal = Float32Array.from(source.normal);
  const index = Uint32Array.from(source.index);
  for (let i = 0; i < position.length; i += 3) {
    position[i] = -position[i];
    normal[i] = -normal[i];
  }
  for (let i = 0; i < index.length; i += 3) {
    const swap = index[i + 1];
    index[i + 1] = index[i + 2];
    index[i + 2] = swap;
  }
  return {
    ...source,
    position,
    normal,
    index
  };
}
