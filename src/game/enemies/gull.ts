// Gull drone: the procedural rig definitions for both enemy types (the hound's body is
// modelled here too, sharing the tint palette and geometry helpers), the gull's tuning,
// and the gull instance factory with its flight, gimbal-lamp and burst-fire AI.
import {
  ConeGeometry,
  LatheGeometry,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3
} from 'three';
import type { BufferGeometry } from 'three';
import { applyTransform, roundedBox, tubeThroughPoints, worldUvCylinder } from '../render/geometry';
import type { Vec3Tuple } from '../render/geometry';
import { RigBuilder, createSkinnedRig } from './rig';
import type { RigDef, Tint } from './rig';
import type {
  Enemy,
  EnemyAudioSource,
  EnemyContext,
  EnemyMaterials,
  EnemyRayHit,
  EnemySpawnOptions
} from './index';

const SHELL_WHITE_TINT = [1.15, 1.15, 1.15];
const SHELL_OFFWHITE_TINT = [0.95, 0.96, 0.97];
const ORANGE_ACCENT_TINT = [1, 0.34, 0.08];
const CHARCOAL_TINT = [0.1, 0.11, 0.12];
const RUBBER_BLACK_TINT = [0.035, 0.035, 0.038];
const YELLOW_ACCENT_TINT = [1, 0.7, 0.07];
const WHITE_TINT = [1, 1, 1];
const BRIGHT_METAL_TINT = [2.4, 2.5, 2.6];
const DARK_METAL_TINT = [0.45, 0.46, 0.48];
const CHROME_TINT = [9, 9, 9.6];
const AMBER_GLOW_TINT = [5.5, 4, 1.6];
const HALF_PI = Math.PI / 2;

/** Rounded box with a smaller default bevel. */
const roundedBoxGeo = (width: number, height: number, depth: number, radius = 0.008) =>
  roundedBox(width, height, depth, radius);

/** Positions, rotates (Euler XYZ) and scales `geometry` in place. */
const placeGeo = <T extends BufferGeometry>(
  geometry: T,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  scale: number | Vec3Tuple = 1
) =>
  applyTransform(geometry, {
    p: [x, y, z],
    r: [rx, ry, rz],
    s: scale
  });

/** Cylinder along Y. */
const cylinderGeoY = (radiusTop: number, radiusBottom: number, height: number, segments = 12) =>
  worldUvCylinder(radiusTop, radiusBottom, height, segments);

/** Cylinder along X. */
const cylinderGeoX = (radiusTop: number, radiusBottom: number, height: number, segments = 12) =>
  applyTransform(worldUvCylinder(radiusTop, radiusBottom, height, segments), {
    r: [0, 0, -HALF_PI]
  });

/** Cylinder along Z. */
const cylinderGeoZ = (radiusTop: number, radiusBottom: number, height: number, segments = 12) =>
  applyTransform(worldUvCylinder(radiusTop, radiusBottom, height, segments), {
    r: [HALF_PI, 0, 0]
  });

const tmpStrutStart = new Vector3();
const tmpStrutEnd = new Vector3();
const tmpStrutQuat = new Quaternion();
const STRUT_UP_AXIS = new Vector3(0, 1, 0);
const tmpStrutMatrix = new Matrix4();
const UNIT_SCALE = new Vector3(1, 1, 1);

/** Cylinder strut from point `from` to point `to` (radii at each end). */
function strutBetween(
  from: Vec3Tuple,
  to: Vec3Tuple,
  fromRadius: number,
  toRadius = fromRadius,
  segments = 8
): BufferGeometry {
  tmpStrutStart.set(from[0], from[1], from[2]);
  tmpStrutEnd.set(to[0], to[1], to[2]);
  const length = tmpStrutStart.distanceTo(tmpStrutEnd);
  const geometry = worldUvCylinder(toRadius, fromRadius, length, segments);
  tmpStrutQuat.setFromUnitVectors(
    STRUT_UP_AXIS,
    tmpStrutEnd.clone().sub(tmpStrutStart).normalize()
  );
  tmpStrutMatrix.compose(
    tmpStrutStart.clone().add(tmpStrutEnd).multiplyScalar(0.5),
    tmpStrutQuat,
    UNIT_SCALE
  );
  geometry.applyMatrix4(tmpStrutMatrix);
  return geometry;
}

/** Sphere scaled per axis. */
export const ellipsoidGeo = (
  radius: number,
  widthSegments = 14,
  heightSegments = 10,
  scaleX = 1,
  scaleY = 1,
  scaleZ = 1
) => {
  const geometry = new SphereGeometry(radius, widthSegments, heightSegments);
  geometry.scale(scaleX, scaleY, scaleZ);
  return geometry;
};

/** Small bolt head facing X / Y / Z at (x, y, z). */
export const boltHeadX = (x: number, y: number, z: number) =>
  placeGeo(cylinderGeoX(0.0075, 0.0075, 0.006, 6), x, y, z);

export const boltHeadY = (x: number, y: number, z: number) =>
  placeGeo(cylinderGeoY(0.0075, 0.0075, 0.006, 6), x, y, z);

export const boltHeadZ = (x: number, y: number, z: number) =>
  placeGeo(cylinderGeoZ(0.0075, 0.0075, 0.006, 6), x, y, z);

/** Hound body / leg proportions (shared with the hound AI's IK and gait). */
export const HOUND_DIMENSIONS = {
  stand: 0.72,
  L1: 0.4,
  L2: 0.42,
  l0: 0.075,
  hipX: 0.165,
  hipY: -0.01,
  hipZ: 0.4,
  footX: 0.275,
  footZ: [0.37, 0.37, -0.42, -0.42],
  legs: ['FL', 'FR', 'RL', 'RR'],
  side: [1, -1, 1, -1],
  fore: [1, 1, -1, -1],
  muzzle: [0, 0, 0.43],
  eye: [0, 0, 0.14],
  footR: 0.046
};

/** Builds the hound rig: body, neck/head, turret/gun, antenna, beacon and four 3-bone legs. */
export function buildHoundRigDef(): RigDef {
  const dims = HOUND_DIMENSIONS;
  const rig = new RigBuilder();
  rig.bone('root', null, 0, 0, 0);
  rig.bone('body', 'root', 0, dims.stand, 0);
  rig.bone('neck', 'body', 0, 0.06, 0.49);
  rig.bone('head', 'neck', 0, 0.13, 0.12);
  rig.bone('turret', 'body', 0, 0.152, -0.03);
  rig.bone('gun', 'turret', 0, 0.095, 0.02);
  rig.bone('antenna', 'body', -0.105, 0.15, -0.46);
  rig.bone('beacon', 'body', 0.105, 0.2, -0.455);
  for (let leg = 0; leg < 4; leg++) {
    const legName = dims.legs[leg];
    const side = dims.side[leg];
    rig.bone('abd' + legName, 'body', side * dims.hipX, dims.hipY, dims.fore[leg] * dims.hipZ);
    rig.bone('thigh' + legName, 'abd' + legName, side * dims.l0, 0, 0);
    rig.bone('shin' + legName, 'thigh' + legName, 0, -dims.L1, 0);
  }
  const addPart = (
    slot: string,
    bone: string,
    geometry: BufferGeometry,
    tint: Tint,
    shade?: boolean
  ) => rig.add(slot, bone, geometry, tint, shade);
  addPart(
    'metal',
    'body',
    placeGeo(roundedBoxGeo(0.27, 0.2, 0.98, 0.02), 0, -0.01, 0),
    DARK_METAL_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(roundedBoxGeo(0.35, 0.05, 0.3, 0.014), 0, 0.125, 0.33),
    SHELL_WHITE_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(roundedBoxGeo(0.35, 0.05, 0.36, 0.014), 0, 0.125, -0.012),
    SHELL_WHITE_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(roundedBoxGeo(0.1, 0.052, 0.36, 0.01), 0, 0.126, -0.012 + 0),
    SHELL_OFFWHITE_TINT
  );
  for (const x of [-0.15, 0.15]) {
    for (const z of [0.21, 0.45, -0.17, 0.145]) {
      addPart('metal', 'body', boltHeadY(x, 0.152, z), BRIGHT_METAL_TINT);
    }
  }
  addPart(
    'metal',
    'body',
    placeGeo(roundedBoxGeo(0.31, 0.03, 0.25, 0.006), 0, 0.112, -0.335),
    WHITE_TINT
  );
  for (let i = 0; i < 10; i++) {
    addPart(
      'metal',
      'body',
      placeGeo(roundedBoxGeo(0.007, 0.062, 0.225, 0.002), -0.126 + i * 0.028, 0.155, -0.335),
      BRIGHT_METAL_TINT
    );
  }
  addPart(
    'metal',
    'body',
    placeGeo(roundedBoxGeo(0.3, 0.012, 0.02, 0.003), 0, 0.186, -0.24),
    DARK_METAL_TINT
  );
  addPart(
    'metal',
    'body',
    placeGeo(roundedBoxGeo(0.3, 0.012, 0.02, 0.003), 0, 0.186, -0.43),
    DARK_METAL_TINT
  );
  for (const side of [1, -1]) {
    addPart(
      'shell',
      'body',
      placeGeo(roundedBoxGeo(0.032, 0.15, 0.31, 0.012), side * 0.15, 0.022, -0.075),
      SHELL_WHITE_TINT
    );
    addPart(
      'shell',
      'body',
      placeGeo(roundedBoxGeo(0.032, 0.15, 0.135, 0.012), side * 0.15, 0.022, 0.1625),
      SHELL_OFFWHITE_TINT
    );
    addPart(
      'metal',
      'body',
      tubeThroughPoints(
        [
          [side * 0.168, 0.06, 0.125],
          [side * 0.182, 0.06, 0.135],
          [side * 0.182, 0.06, 0.19],
          [side * 0.168, 0.06, 0.2]
        ],
        0.005,
        5
      ),
      BRIGHT_METAL_TINT
    );
    addPart(
      'shell',
      'body',
      placeGeo(roundedBoxGeo(0.034, 0.016, 0.135, 0.004), side * 0.151, -0.035, 0.1625),
      YELLOW_ACCENT_TINT
    );
    addPart(
      'shell',
      'body',
      placeGeo(roundedBoxGeo(0.034, 0.042, 0.46, 0.008), side * 0.151, -0.078, 0),
      ORANGE_ACCENT_TINT
    );
    addPart(
      'shell',
      'body',
      placeGeo(roundedBoxGeo(0.028, 0.1, 0.11, 0.008), side * 0.146, 0.01, 0.305),
      CHARCOAL_TINT
    );
    for (let slat = 0; slat < 4; slat++) {
      addPart(
        'metal',
        'body',
        placeGeo(
          roundedBoxGeo(0.004, 0.012, 0.085, 0.001),
          side * 0.161,
          -0.02 + slat * 0.022,
          0.305
        ),
        DARK_METAL_TINT
      );
    }
    for (const y of [-0.035, 0.08]) {
      for (const z of [-0.21, 0.06, 0.115, 0.21]) {
        addPart('metal', 'body', boltHeadX(side * 0.167, y, z), BRIGHT_METAL_TINT);
      }
    }
    addPart(
      'metal',
      'body',
      tubeThroughPoints(
        [
          [side * 0.135, 0.148, -0.19],
          [side * 0.135, 0.205, -0.16],
          [side * 0.135, 0.212, 0],
          [side * 0.135, 0.205, 0.43],
          [side * 0.135, 0.148, 0.465]
        ],
        0.0105,
        6
      ),
      BRIGHT_METAL_TINT
    );
    for (const z of [0, 0.26]) {
      addPart(
        'metal',
        'body',
        placeGeo(cylinderGeoY(0.008, 0.008, 0.06, 6), side * 0.135, 0.178, z),
        BRIGHT_METAL_TINT
      );
    }
    addPart(
      'shell',
      'body',
      tubeThroughPoints(
        [
          [side * 0.118, -0.105, -0.36],
          [side * 0.132, -0.118, -0.2],
          [side * 0.13, -0.112, 0.1],
          [side * 0.118, -0.1, 0.36]
        ],
        0.009,
        5
      ),
      RUBBER_BLACK_TINT
    );
    addPart(
      'metal',
      'body',
      placeGeo(new TorusGeometry(0.02, 0.005, 5, 10), side * 0.17, 0.085, -0.335, 0, HALF_PI, 0),
      BRIGHT_METAL_TINT
    );
  }
  addPart(
    'shell',
    'body',
    placeGeo(roundedBoxGeo(0.3, 0.15, 0.075, 0.018), 0, -0.005, 0.505),
    ORANGE_ACCENT_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(roundedBoxGeo(0.2, 0.07, 0.02, 0.006), 0, 0.012, 0.545),
    CHARCOAL_TINT
  );
  for (let i = 0; i < 6; i++) {
    addPart(
      'shell',
      'body',
      placeGeo(roundedBoxGeo(0.05, 0.034, 0.014, 0.003), -0.125 + i * 0.05, -0.098, 0.538, 0, 0, 0),
      i % 2 ? CHARCOAL_TINT : YELLOW_ACCENT_TINT
    );
  }
  for (const x of [-0.115, 0.115]) {
    addPart(
      'metal',
      'body',
      placeGeo(cylinderGeoZ(0.021, 0.021, 0.014, 10), x, 0.012, 0.547),
      DARK_METAL_TINT
    );
    addPart(
      'glow',
      'body',
      placeGeo(cylinderGeoZ(0.015, 0.015, 0.004, 10), x, 0.012, 0.556),
      [6.5, 4.6, 2.2],
      false
    );
  }
  addPart(
    'metal',
    'body',
    placeGeo(roundedBoxGeo(0.24, 0.095, 0.56, 0.02), 0, -0.145, 0),
    WHITE_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(roundedBoxGeo(0.246, 0.03, 0.09, 0.006), 0, -0.14, 0.12),
    ORANGE_ACCENT_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(roundedBoxGeo(0.246, 0.03, 0.09, 0.006), 0, -0.14, -0.12),
    ORANGE_ACCENT_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(roundedBoxGeo(0.29, 0.15, 0.05, 0.014), 0, 0, -0.495),
    SHELL_WHITE_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(roundedBoxGeo(0.17, 0.05, 0.012, 0.004), 0, 0.03, -0.523),
    CHARCOAL_TINT
  );
  addPart(
    'glow',
    'body',
    placeGeo(roundedBoxGeo(0.13, 0.012, 0.004, 0.001), 0, 0.03, -0.531),
    [5, 0.3, 0.1],
    false
  );
  addPart(
    'metal',
    'body',
    placeGeo(cylinderGeoZ(0.022, 0.022, 0.02, 10), 0.085, -0.035, -0.525),
    BRIGHT_METAL_TINT
  );
  addPart(
    'metal',
    'body',
    placeGeo(new TorusGeometry(0.024, 0.006, 5, 10), -0.07, -0.05, -0.528, HALF_PI, 0, 0),
    BRIGHT_METAL_TINT
  );
  for (const x of [-0.125, 0.125]) {
    for (const y of [-0.055, 0.055]) {
      addPart('metal', 'body', boltHeadZ(x, y, -0.523), BRIGHT_METAL_TINT);
    }
  }
  addPart(
    'shell',
    'body',
    tubeThroughPoints(
      [
        [0.09, 0.15, -0.2],
        [0.13, 0.2, -0.16],
        [0.12, 0.2, -0.08],
        [0.09, 0.165, -0.05]
      ],
      0.009,
      5
    ),
    RUBBER_BLACK_TINT
  );
  addPart(
    'metal',
    'neck',
    strutBetween([0, -0.02, -0.02], [0, 0.11, 0.1], 0.045, 0.036, 10),
    DARK_METAL_TINT
  );
  for (let i = 0; i < 3; i++) {
    const along = 0.2 + i * 0.28;
    addPart(
      'shell',
      'neck',
      strutBetween(
        [0, -0.02 + 0.13 * along - 0.008, -0.02 + 0.12 * along - 0.0075],
        [0, -0.02 + 0.13 * along + 0.008, -0.02 + 0.12 * along + 0.0075],
        0.052,
        0.052,
        10
      ),
      RUBBER_BLACK_TINT
    );
  }
  addPart(
    'shell',
    'neck',
    placeGeo(roundedBoxGeo(0.13, 0.05, 0.1, 0.012), 0, -0.01, -0.03),
    SHELL_WHITE_TINT
  );
  addPart(
    'shell',
    'neck',
    tubeThroughPoints(
      [
        [0.05, -0.02, -0.04],
        [0.07, 0.05, 0.02],
        [0.06, 0.11, 0.07],
        [0.045, 0.12, 0.1]
      ],
      0.007,
      5
    ),
    RUBBER_BLACK_TINT
  );
  addPart(
    'shell',
    'head',
    placeGeo(roundedBoxGeo(0.19, 0.118, 0.25, 0.03), 0, 0, 0),
    SHELL_WHITE_TINT
  );
  addPart(
    'shell',
    'head',
    placeGeo(roundedBoxGeo(0.168, 0.074, 0.03, 0.012), 0, -0.004, 0.118),
    CHARCOAL_TINT
  );
  addPart(
    'lens',
    'head',
    placeGeo(roundedBoxGeo(0.128, 0.024, 0.006, 0.002), 0, 0.006, 0.1345),
    [1, 1, 1],
    false
  );
  for (const x of [-0.056, 0.056]) {
    addPart(
      'metal',
      'head',
      placeGeo(cylinderGeoZ(0.015, 0.015, 0.012, 10), x, -0.022, 0.132),
      DARK_METAL_TINT
    );
    addPart(
      'metal',
      'head',
      placeGeo(cylinderGeoZ(0.009, 0.009, 0.004, 8), x, -0.022, 0.139),
      [0.1, 0.12, 0.2]
    );
  }
  addPart(
    'shell',
    'head',
    placeGeo(roundedBoxGeo(0.062, 0.008, 0.2, 0.003), 0, 0.06, -0.005),
    ORANGE_ACCENT_TINT
  );
  addPart(
    'metal',
    'head',
    placeGeo(cylinderGeoX(0.032, 0.032, 0.214, 12), 0, 0, -0.055),
    DARK_METAL_TINT
  );
  for (const side of [1, -1]) {
    addPart(
      'shell',
      'head',
      placeGeo(cylinderGeoX(0.022, 0.022, 0.006, 10), side * 0.108, 0, -0.055),
      ORANGE_ACCENT_TINT
    );
  }
  addPart(
    'metal',
    'head',
    placeGeo(cylinderGeoY(0.036, 0.036, 0.026, 14), 0, 0.072, -0.05),
    DARK_METAL_TINT
  );
  addPart(
    'metal',
    'head',
    placeGeo(cylinderGeoY(0.037, 0.037, 0.006, 14), 0, 0.074, -0.05),
    [0.2, 0.3, 0.5]
  );
  addPart(
    'metal',
    'head',
    placeGeo(roundedBoxGeo(0.12, 0.03, 0.13, 0.008), 0, -0.068, 0.02),
    WHITE_TINT
  );
  for (const x of [-0.08, 0.08]) {
    for (const z of [-0.09, 0.07]) {
      addPart('metal', 'head', boltHeadY(x, 0.061, z), BRIGHT_METAL_TINT);
    }
  }
  addPart(
    'metal',
    'turret',
    placeGeo(cylinderGeoY(0.105, 0.118, 0.034, 18), 0, 0, 0),
    DARK_METAL_TINT
  );
  addPart(
    'metal',
    'turret',
    placeGeo(roundedBoxGeo(0.18, 0.02, 0.16, 0.005), 0, 0.026, 0),
    WHITE_TINT
  );
  for (const side of [1, -1]) {
    addPart(
      'shell',
      'turret',
      placeGeo(roundedBoxGeo(0.028, 0.115, 0.15, 0.012), side * 0.078, 0.085, 0.005),
      SHELL_WHITE_TINT
    );
    addPart(
      'metal',
      'turret',
      placeGeo(cylinderGeoX(0.022, 0.022, 0.008, 10), side * 0.094, 0.095, 0.02),
      BRIGHT_METAL_TINT
    );
  }
  addPart(
    'shell',
    'gun',
    placeGeo(roundedBoxGeo(0.108, 0.086, 0.21, 0.016), 0, 0, -0.012),
    SHELL_WHITE_TINT
  );
  addPart(
    'shell',
    'gun',
    placeGeo(roundedBoxGeo(0.11, 0.02, 0.212, 0.006), 0, -0.022, -0.012),
    ORANGE_ACCENT_TINT
  );
  addPart(
    'metal',
    'gun',
    placeGeo(cylinderGeoZ(0.035, 0.035, 0.11, 12), 0, 0, 0.145),
    DARK_METAL_TINT
  );
  for (let i = 0; i < 4; i++) {
    addPart(
      'metal',
      'gun',
      placeGeo(cylinderGeoZ(0.039, 0.039, 0.008, 12), 0, 0, 0.105 + i * 0.026),
      WHITE_TINT
    );
  }
  addPart('metal', 'gun', placeGeo(cylinderGeoZ(0.022, 0.024, 0.3, 12), 0, 0, 0.25), WHITE_TINT);
  addPart(
    'metal',
    'gun',
    placeGeo(cylinderGeoZ(0.036, 0.036, 0.06, 10), 0, 0, 0.395),
    DARK_METAL_TINT
  );
  addPart(
    'metal',
    'gun',
    placeGeo(roundedBoxGeo(0.08, 0.012, 0.025, 0.003), 0, 0, 0.395),
    [0.15, 0.15, 0.15]
  );
  addPart(
    'metal',
    'gun',
    placeGeo(cylinderGeoX(0.056, 0.056, 0.06, 14), 0.084, -0.004, -0.045),
    DARK_METAL_TINT
  );
  addPart(
    'metal',
    'gun',
    placeGeo(cylinderGeoX(0.02, 0.02, 0.066, 8), 0.084, -0.004, -0.045),
    AMBER_GLOW_TINT
  );
  addPart(
    'metal',
    'gun',
    placeGeo(roundedBoxGeo(0.036, 0.036, 0.095, 0.008), -0.03, 0.06, 0),
    DARK_METAL_TINT
  );
  addPart(
    'glow',
    'gun',
    placeGeo(cylinderGeoZ(0.011, 0.011, 0.003, 8), -0.03, 0.06, 0.049),
    [1.6, 0.12, 0.05],
    false
  );
  addPart(
    'shell',
    'gun',
    tubeThroughPoints(
      [
        [0.05, -0.03, -0.11],
        [0.06, -0.07, -0.13],
        [0.04, -0.09, -0.1]
      ],
      0.008,
      5
    ),
    RUBBER_BLACK_TINT
  );
  addPart(
    'metal',
    'body',
    placeGeo(cylinderGeoY(0.022, 0.026, 0.05, 10), 0.105, 0.175, -0.455),
    DARK_METAL_TINT
  );
  addPart(
    'glow',
    'beacon',
    placeGeo(ellipsoidGeo(0.02, 10, 6, 1, 1.25, 1), 0, 0.012, 0),
    [14, 5.5, 0.5],
    false
  );
  addPart(
    'metal',
    'antenna',
    placeGeo(cylinderGeoY(0.011, 0.014, 0.05, 8), 0, 0.025, 0),
    DARK_METAL_TINT
  );
  addPart(
    'metal',
    'antenna',
    placeGeo(cylinderGeoY(0.0028, 0.005, 0.62, 5), 0, 0.36, 0),
    DARK_METAL_TINT
  );
  addPart('shell', 'antenna', placeGeo(ellipsoidGeo(0.009, 6, 4), 0, 0.67, 0), ORANGE_ACCENT_TINT);
  for (let leg = 0; leg < 4; leg++) {
    const legName = dims.legs[leg];
    const side = dims.side[leg];
    const abdBone = 'abd' + legName;
    const thighBone = 'thigh' + legName;
    const shinBone = 'shin' + legName;
    addPart(
      'metal',
      abdBone,
      placeGeo(cylinderGeoZ(0.06, 0.06, 0.17, 14), -side * 0.02, 0, 0),
      DARK_METAL_TINT
    );
    addPart(
      'shell',
      abdBone,
      placeGeo(roundedBoxGeo(0.11, 0.05, 0.155, 0.014), side * 0, 0.058, 0),
      SHELL_WHITE_TINT
    );
    addPart(
      'metal',
      abdBone,
      placeGeo(cylinderGeoZ(0.03, 0.03, 0.18, 8), -side * 0.02, 0, 0),
      BRIGHT_METAL_TINT
    );
    addPart(
      'shell',
      thighBone,
      placeGeo(cylinderGeoX(0.078, 0.078, 0.07, 18), 0, 0, 0),
      SHELL_WHITE_TINT
    );
    addPart(
      'shell',
      thighBone,
      placeGeo(cylinderGeoX(0.081, 0.081, 0.016, 18), side * 0.012, 0, 0),
      ORANGE_ACCENT_TINT
    );
    addPart(
      'metal',
      thighBone,
      placeGeo(cylinderGeoX(0.048, 0.048, 0.082, 12), 0, 0, 0),
      DARK_METAL_TINT
    );
    for (let bolt = 0; bolt < 5; bolt++) {
      const angle = bolt * 1.2566;
      addPart(
        'metal',
        thighBone,
        boltHeadX(side * 0.039, Math.cos(angle) * 0.062, Math.sin(angle) * 0.062),
        BRIGHT_METAL_TINT
      );
    }
    addPart(
      'shell',
      thighBone,
      placeGeo(roundedBoxGeo(0.062, dims.L1 - 0.07, 0.1, 0.022), 0, -dims.L1 * 0.5 - 0.005, 0.004),
      SHELL_WHITE_TINT
    );
    addPart(
      'metal',
      thighBone,
      placeGeo(roundedBoxGeo(0.044, dims.L1 - 0.04, 0.06, 0.012), 0, -dims.L1 * 0.5, -0.035),
      DARK_METAL_TINT
    );
    addPart(
      'shell',
      thighBone,
      placeGeo(roundedBoxGeo(0.065, 0.045, 0.103, 0.01), 0, -0.145, 0.004),
      ORANGE_ACCENT_TINT
    );
    addPart(
      'shell',
      thighBone,
      placeGeo(roundedBoxGeo(0.064, 0.012, 0.102, 0.004), 0, -0.26, 0.004),
      CHARCOAL_TINT
    );
    addPart(
      'metal',
      thighBone,
      strutBetween([0, -0.06, -0.082], [0, -dims.L1 * 0.62, -0.078], 0.021, 0.021, 10),
      BRIGHT_METAL_TINT
    );
    addPart(
      'metal',
      thighBone,
      strutBetween([0, -dims.L1 * 0.62, -0.078], [0, -dims.L1 + 0.025, -0.058], 0.009, 0.009, 6),
      CHROME_TINT
    );
    addPart(
      'metal',
      thighBone,
      placeGeo(roundedBoxGeo(0.05, 0.03, 0.035, 0.006), 0, -0.055, -0.07),
      WHITE_TINT
    );
    addPart(
      'shell',
      thighBone,
      tubeThroughPoints(
        [
          [side * 0.036, -0.02, 0.05],
          [side * 0.044, -0.13, 0.062],
          [side * 0.042, -0.28, 0.058],
          [side * 0.034, -dims.L1 + 0.03, 0.035]
        ],
        0.0065,
        5
      ),
      RUBBER_BLACK_TINT
    );
    addPart(
      'metal',
      thighBone,
      placeGeo(cylinderGeoX(0.05, 0.05, 0.086, 14), 0, -dims.L1, 0),
      DARK_METAL_TINT
    );
    addPart(
      'shell',
      thighBone,
      placeGeo(cylinderGeoX(0.036, 0.036, 0.092, 12), 0, -dims.L1, 0),
      SHELL_OFFWHITE_TINT
    );
    addPart(
      'metal',
      shinBone,
      placeGeo(cylinderGeoY(0.03, 0.021, dims.L2 - 0.08, 10), 0, -(dims.L2 - 0.08) / 2 - 0.01, 0),
      DARK_METAL_TINT
    );
    addPart(
      'shell',
      shinBone,
      placeGeo(roundedBoxGeo(0.052, 0.21, 0.04, 0.014), 0, -0.14, 0.02),
      SHELL_WHITE_TINT
    );
    addPart(
      'shell',
      shinBone,
      placeGeo(roundedBoxGeo(0.054, 0.02, 0.042, 0.006), 0, -0.215, 0.02),
      ORANGE_ACCENT_TINT
    );
    addPart(
      'metal',
      shinBone,
      placeGeo(roundedBoxGeo(0.03, 0.06, 0.05, 0.008), 0, -0.02, -0.03),
      WHITE_TINT
    );
    addPart(
      'metal',
      shinBone,
      placeGeo(cylinderGeoY(0.024, 0.03, 0.03, 10), 0, -dims.L2 + 0.085, 0),
      BRIGHT_METAL_TINT
    );
    addPart(
      'shell',
      shinBone,
      placeGeo(
        ellipsoidGeo(dims.footR + 0.002, 12, 8, 1, 0.86, 1.08),
        0,
        -dims.L2 + dims.footR * 0.86,
        0.004
      ),
      RUBBER_BLACK_TINT
    );
  }
  return rig.build(['shell', 'metal', 'glow', 'lens']);
}

const GULL_DIMENSIONS = {
  rotors: [
    [0.33, 0.035, 0.3],
    [-0.33, 0.035, 0.3],
    [0.33, 0.035, -0.3],
    [-0.33, 0.035, -0.3]
  ],
  gimbal: [0, -0.095, 0.275],
  ball: [0, -0.072, 0],
  gun: [0, -0.085, -0.1],
  muzzle: [0, -0.032, 0.27],
  lamp: [0, -0.066, 0.025]
};

/** Lathed rotor duct ring profile. */
function createRotorDuctGeometry(): LatheGeometry {
  const profile = [
    [0.176, -0.036],
    [0.196, -0.032],
    [0.206, 0],
    [0.202, 0.03],
    [0.19, 0.04],
    [0.178, 0.032],
    [0.173, 0],
    [0.176, -0.036]
  ].map((point) => new Vector2(point[0], point[1]));
  return new LatheGeometry(profile, 28);
}

/** Gull rig def plus the translucent overlay rig (rotor discs, lamp cone). */
export type GullRigDef = RigDef & { extra: RigDef };

/** Builds the gull rig: body, four rotors, gimbal ball with lamp, gun and three strobes. */
export function buildGullRigDef(): GullRigDef {
  const dims = GULL_DIMENSIONS;
  const rig = new RigBuilder();
  const extraRig = new RigBuilder();
  const addBone = (name: string, parent: string | null, x: number, y: number, z: number) => {
    rig.bone(name, parent, x, y, z);
    extraRig.bone(name, parent, x, y, z);
  };
  addBone('root', null, 0, 0, 0);
  addBone('body', 'root', 0, 0, 0);
  for (let rotor = 0; rotor < 4; rotor++) {
    addBone(
      'rotor' + rotor,
      'body',
      dims.rotors[rotor][0],
      dims.rotors[rotor][1],
      dims.rotors[rotor][2]
    );
  }
  addBone('gimbalYaw', 'body', dims.gimbal[0], dims.gimbal[1], dims.gimbal[2]);
  addBone('ball', 'gimbalYaw', dims.ball[0], dims.ball[1], dims.ball[2]);
  addBone('lamp', 'ball', dims.lamp[0], dims.lamp[1], dims.lamp[2]);
  addBone('gun', 'body', dims.gun[0], dims.gun[1], dims.gun[2]);
  addBone('strobeG', 'body', 0, 0, 0);
  addBone('strobeR', 'body', 0, 0, 0);
  addBone('strobeW', 'body', 0, 0, 0);
  const addPart = (
    slot: string,
    bone: string,
    geometry: BufferGeometry,
    tint: Tint,
    shade?: boolean
  ) => rig.add(slot, bone, geometry, tint, shade);
  addPart(
    'shell',
    'body',
    placeGeo(ellipsoidGeo(1, 20, 12, 0.118, 0.074, 0.27), 0, 0.02, 0),
    SHELL_WHITE_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(worldUvCylinder(1, 0.9, 1, 20), 0, 0.02, 0.165, HALF_PI, 0, 0, [0.094, 0.05, 0.06]),
    ORANGE_ACCENT_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(worldUvCylinder(1, 1, 1, 20), 0, 0.02, -0.02, HALF_PI, 0, 0, [0.121, 0.012, 0.0765]),
    CHARCOAL_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(roundedBoxGeo(0.118, 0.014, 0.2, 0.005), 0, 0.089, -0.03),
    SHELL_OFFWHITE_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(roundedBoxGeo(0.03, 0.006, 0.2, 0.002), 0, 0.0975, -0.03),
    ORANGE_ACCENT_TINT
  );
  for (const x of [-0.05, 0.05]) {
    for (const z of [-0.12, 0.06]) {
      addPart('metal', 'body', boltHeadY(x, 0.097, z), BRIGHT_METAL_TINT);
    }
  }
  addPart(
    'metal',
    'body',
    placeGeo(roundedBoxGeo(0.175, 0.06, 0.37, 0.016), 0, -0.035, -0.005),
    DARK_METAL_TINT
  );
  addPart(
    'metal',
    'body',
    placeGeo(roundedBoxGeo(0.12, 0.075, 0.11, 0.014), 0, 0.005, -0.265),
    WHITE_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(roundedBoxGeo(0.124, 0.02, 0.03, 0.005), 0, 0.03, -0.3),
    ORANGE_ACCENT_TINT
  );
  addPart(
    'glow',
    'body',
    placeGeo(roundedBoxGeo(0.05, 0.006, 0.003, 0.001), 0, 0, -0.321),
    [0.3, 1.6, 0.4],
    false
  );
  for (const side of [1, -1]) {
    for (let slat = 0; slat < 4; slat++) {
      addPart(
        'metal',
        'body',
        placeGeo(
          roundedBoxGeo(0.004, 0.01, 0.06, 0.001),
          side * 0.0885,
          -0.045 + slat * 0.016,
          -0.06
        ),
        [0.2, 0.2, 0.2]
      );
    }
    addPart(
      'metal',
      'body',
      tubeThroughPoints(
        [
          [side * 0.075, -0.055, 0.13],
          [side * 0.135, -0.175, 0.16],
          [side * 0.135, -0.192, 0.11],
          [side * 0.135, -0.192, -0.14],
          [side * 0.135, -0.175, -0.19],
          [side * 0.075, -0.055, -0.15]
        ],
        0.0085,
        6,
        false,
        0.5
      ),
      BRIGHT_METAL_TINT
    );
    for (const z of [0.07, -0.1]) {
      addPart(
        'shell',
        'body',
        placeGeo(cylinderGeoZ(0.0135, 0.0135, 0.07, 8), side * 0.135, -0.192, z),
        RUBBER_BLACK_TINT
      );
    }
    addPart(
      'metal',
      'body',
      strutBetween([side * 0.04, 0.07, -0.17], [side * 0.085, 0.37, -0.27], 0.004, 0.002, 5),
      DARK_METAL_TINT
    );
    addPart(
      'metal',
      'body',
      placeGeo(cylinderGeoY(0.008, 0.01, 0.025, 6), side * 0.04, 0.078, -0.17),
      BRIGHT_METAL_TINT
    );
  }
  addPart(
    'metal',
    'body',
    placeGeo(cylinderGeoY(0.007, 0.007, 0.04, 6), 0, 0.105, 0.1),
    BRIGHT_METAL_TINT
  );
  addPart(
    'shell',
    'body',
    placeGeo(cylinderGeoY(0.034, 0.036, 0.018, 14), 0, 0.132, 0.1),
    SHELL_WHITE_TINT
  );
  addPart(
    'metal',
    'body',
    placeGeo(roundedBoxGeo(0.07, 0.03, 0.09, 0.008), 0, -0.075, 0.235),
    WHITE_TINT
  );
  const ductGeometry = createRotorDuctGeometry();
  for (let rotor = 0; rotor < 4; rotor++) {
    let [rotorX, rotorY, rotorZ] = dims.rotors[rotor];
    const sideX = Math.sign(rotorX);
    const sideZ = Math.sign(rotorZ);
    addPart(
      'metal',
      'body',
      strutBetween(
        [sideX * 0.07, 0, sideZ * 0.09],
        [rotorX, rotorY - 0.05, rotorZ],
        0.017,
        0.015,
        8
      ),
      DARK_METAL_TINT
    );
    addPart(
      'shell',
      'body',
      placeGeo(
        roundedBoxGeo(0.07, 0.045, 0.07, 0.014),
        sideX * 0.085,
        0,
        sideZ * 0.1,
        0,
        sideX * sideZ * 0.74,
        0
      ),
      SHELL_WHITE_TINT
    );
    addPart(
      'shell',
      'body',
      tubeThroughPoints(
        [
          [sideX * 0.09, 0.02, sideZ * 0.12],
          [sideX * 0.18, 0.012, sideZ * 0.19],
          [rotorX - sideX * 0.05, rotorY - 0.03, rotorZ - sideZ * 0.04]
        ],
        0.005,
        5
      ),
      RUBBER_BLACK_TINT
    );
    addPart(
      'metal',
      'body',
      placeGeo(cylinderGeoY(0.04, 0.03, 0.075, 12), rotorX, rotorY - 0.05, rotorZ),
      DARK_METAL_TINT
    );
    addPart(
      'metal',
      'body',
      placeGeo(cylinderGeoY(0.042, 0.042, 0.012, 12), rotorX, rotorY - 0.02, rotorZ),
      BRIGHT_METAL_TINT
    );
    addPart(
      'shell',
      'body',
      placeGeo(ductGeometry.clone(), rotorX, rotorY, rotorZ),
      SHELL_WHITE_TINT
    );
    addPart(
      'shell',
      'body',
      placeGeo(
        new TorusGeometry(0.196, 0.0085, 6, 28),
        rotorX,
        rotorY + 0.036,
        rotorZ,
        HALF_PI,
        0,
        0
      ),
      ORANGE_ACCENT_TINT
    );
    for (let blade = 0; blade < 3; blade++) {
      const angle = blade * 2.094 + 0.5 + rotor;
      addPart(
        'metal',
        'body',
        placeGeo(
          roundedBoxGeo(0.145, 0.007, 0.016, 0.002),
          rotorX + Math.cos(angle) * 0.105,
          rotorY - 0.022,
          rotorZ - Math.sin(angle) * 0.105,
          0,
          angle,
          0
        ),
        DARK_METAL_TINT
      );
    }
    for (let fin = -1; fin <= 1; fin++) {
      const angle = Math.atan2(sideZ, sideX) + fin * 0.2;
      addPart(
        'shell',
        'body',
        placeGeo(
          roundedBoxGeo(0.012, 0.05, 0.036, 0.003),
          rotorX + Math.cos(angle) * 0.205,
          rotorY,
          rotorZ + Math.sin(angle) * 0.205,
          0,
          -angle,
          0
        ),
        fin === 0 ? CHARCOAL_TINT : YELLOW_ACCENT_TINT
      );
    }
    addPart(
      'metal',
      'rotor' + rotor,
      placeGeo(cylinderGeoY(0.017, 0.02, 0.03, 8), 0, -0.002, 0),
      BRIGHT_METAL_TINT
    );
    addPart(
      'metal',
      'rotor' + rotor,
      placeGeo(roundedBoxGeo(0.158, 0.0035, 0.03, 0.001), 0.088, 0.008, 0, 0.22, 0, 0),
      DARK_METAL_TINT
    );
    addPart(
      'metal',
      'rotor' + rotor,
      placeGeo(roundedBoxGeo(0.158, 0.0035, 0.03, 0.001), -0.088, 0.008, 0, -0.22, 0, 0),
      DARK_METAL_TINT
    );
    addPart(
      'shell',
      'rotor' + rotor,
      placeGeo(roundedBoxGeo(0.02, 0.004, 0.031, 0.001), 0.158, 0.008, 0, 0.22, 0, 0),
      YELLOW_ACCENT_TINT
    );
    addPart(
      'shell',
      'rotor' + rotor,
      placeGeo(roundedBoxGeo(0.02, 0.004, 0.031, 0.001), -0.158, 0.008, 0, -0.22, 0, 0),
      YELLOW_ACCENT_TINT
    );
    const discGeometry = new RingGeometry(0.03, 0.168, 24, 1);
    discGeometry.rotateX(-HALF_PI);
    extraRig.add(
      'disc',
      'body',
      placeGeo(discGeometry, rotorX, rotorY + 0.008, rotorZ),
      [1, 1, 1],
      false
    );
  }
  addPart(
    'glow',
    'strobeR',
    placeGeo(ellipsoidGeo(0.012, 8, 6), 0.33 + 0.215, 0.035, 0.3),
    [10, 0.4, 0.2],
    false
  );
  addPart(
    'glow',
    'strobeR',
    placeGeo(ellipsoidGeo(0.012, 8, 6), 0.33 + 0.215, 0.035, -0.3),
    [10, 0.4, 0.2],
    false
  );
  addPart(
    'glow',
    'strobeG',
    placeGeo(ellipsoidGeo(0.012, 8, 6), -0.33 - 0.215, 0.035, 0.3),
    [0.3, 9, 1],
    false
  );
  addPart(
    'glow',
    'strobeG',
    placeGeo(ellipsoidGeo(0.012, 8, 6), -0.33 - 0.215, 0.035, -0.3),
    [0.3, 9, 1],
    false
  );
  addPart(
    'glow',
    'strobeW',
    placeGeo(ellipsoidGeo(0.011, 8, 6), 0, 0.05, -0.325),
    [9, 9, 9],
    false
  );
  addPart(
    'metal',
    'gimbalYaw',
    placeGeo(cylinderGeoY(0.036, 0.036, 0.014, 12), 0, -0.004, 0),
    DARK_METAL_TINT
  );
  addPart(
    'metal',
    'gimbalYaw',
    placeGeo(roundedBoxGeo(0.156, 0.01, 0.03, 0.003), 0, -0.014, 0),
    WHITE_TINT
  );
  for (const side of [1, -1]) {
    addPart(
      'metal',
      'gimbalYaw',
      placeGeo(roundedBoxGeo(0.009, 0.075, 0.03, 0.003), side * 0.0735, -0.05, 0),
      WHITE_TINT
    );
  }
  addPart('metal', 'ball', placeGeo(ellipsoidGeo(0.06, 18, 12), 0, 0, 0), DARK_METAL_TINT);
  addPart(
    'metal',
    'ball',
    placeGeo(cylinderGeoX(0.013, 0.013, 0.142, 8), 0, 0, 0),
    BRIGHT_METAL_TINT
  );
  addPart(
    'metal',
    'ball',
    placeGeo(cylinderGeoZ(0.031, 0.036, 0.03, 14), 0, 0.004, 0.048),
    WHITE_TINT
  );
  addPart(
    'lens',
    'ball',
    placeGeo(cylinderGeoZ(0.025, 0.025, 0.004, 14), 0, 0.004, 0.0645),
    [1, 1, 1],
    false
  );
  addPart(
    'metal',
    'ball',
    placeGeo(cylinderGeoZ(0.012, 0.012, 0.01, 8), 0.03, 0.036, 0.04),
    [0.1, 0.12, 0.2]
  );
  addPart(
    'metal',
    'ball',
    placeGeo(
      cylinderGeoZ(0.019, 0.023, 0.045, 10),
      dims.lamp[0],
      dims.lamp[1],
      dims.lamp[2] - 0.022
    ),
    DARK_METAL_TINT
  );
  addPart(
    'glow',
    'lamp',
    placeGeo(cylinderGeoZ(0.016, 0.016, 0.003, 10), 0, 0, 0.001),
    [11, 9.8, 7.6],
    false
  );
  {
    const coneGeometry = new ConeGeometry(1.25, 9, 20, 6, true);
    coneGeometry.translate(0, -9 / 2, 0);
    coneGeometry.rotateX(-HALF_PI);
    extraRig.add('cone', 'lamp', coneGeometry, [1, 1, 1], false);
  }
  addPart(
    'metal',
    'gun',
    placeGeo(roundedBoxGeo(0.05, 0.03, 0.05, 0.006), 0, 0.012, 0),
    WHITE_TINT
  );
  addPart(
    'metal',
    'gun',
    placeGeo(cylinderGeoX(0.012, 0.012, 0.07, 8), 0, -0.005, 0),
    BRIGHT_METAL_TINT
  );
  addPart(
    'metal',
    'gun',
    placeGeo(roundedBoxGeo(0.052, 0.046, 0.13, 0.008), 0, -0.032, 0),
    WHITE_TINT
  );
  addPart(
    'shell',
    'gun',
    placeGeo(roundedBoxGeo(0.054, 0.012, 0.05, 0.003), 0, -0.02, -0.03),
    ORANGE_ACCENT_TINT
  );
  for (const x of [-0.014, 0.014]) {
    addPart(
      'metal',
      'gun',
      placeGeo(cylinderGeoZ(0.0085, 0.0085, 0.2, 8), x, -0.032, 0.16),
      DARK_METAL_TINT
    );
    addPart(
      'metal',
      'gun',
      placeGeo(cylinderGeoZ(0.012, 0.012, 0.03, 8), x, -0.032, 0.255),
      WHITE_TINT
    );
  }
  addPart(
    'metal',
    'gun',
    placeGeo(roundedBoxGeo(0.045, 0.012, 0.012, 0.002), 0, -0.032, 0.2),
    BRIGHT_METAL_TINT
  );
  addPart(
    'metal',
    'gun',
    placeGeo(roundedBoxGeo(0.03, 0.05, 0.05, 0.006), 0.04, -0.035, -0.02),
    DARK_METAL_TINT
  );
  const def = rig.build(['shell', 'metal', 'glow', 'lens']);
  const extraDef = extraRig.build(['disc', 'cone']);
  return Object.assign(def, { extra: extraDef });
}

/** Gull combat / flight tuning. */
export const GULL_TUNING = {
  hp: 45,
  boltDamage: 7,
  boltSpeed: 70,
  burst: 3,
  burstGap: 0.12,
  telegraph: 0.55,
  cooldown: [1.9, 3.3],
  rangeMin: 12,
  rangeMax: 25,
  altMin: 4,
  altMax: 8,
  maxSpeed: 8,
  patrolSpeed: 3,
  accel: 11,
  spreadFar: 0.065,
  spreadNear: 0.018,
  fireRange: 42,
  explodeRadius: 3,
  explodeDamage: 30
};

export const GULL_CFG = GULL_TUNING;
export const tmpGullVec = new Vector3();
export const tmpGullVecUnusedA = new Vector3();
export const tmpGullBoltDir = new Vector3();
export const tmpGullSteer = new Vector3();
export const tmpGullVecUnusedB = new Vector3();
export const tmpGimbalTarget = new Vector3();
export const GULL_UP = new Vector3(0, 1, 0);
export const GULL_DOWN = new Vector3(0, -1, 0);
export const GULL_LENS_IDLE_COLOR: number[] = [8, 4, 0.7];
export const GULL_LENS_ALERT_COLOR: number[] = [14, 1, 0.35];

/** Signed angle a - b wrapped to [-PI, PI]. */
export const gullAngleDelta = (a: number, b: number): number => {
  let delta = (a - b) % (Math.PI * 2);
  if (delta > Math.PI) {
    delta -= Math.PI * 2;
  } else if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return delta;
};

export const gullClamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** Gull attack state: idle -> telegraph (lamp flare) -> burst of bolts. */
export type GullAttackState = 'idle' | 'tele' | 'burst';

/** A gull drone instance. */
export interface GullEnemy extends Enemy {
  type: 'gull';
  vel: Vector3;
  pitch: number;
  roll: number;
  /** Orbit angle around the player / patrol centre. */
  orbitA: number;
  orbitDir: number;
  orbitR: number;
  /** Preferred altitude above the target. */
  alt: number;
  hoverY: number;
  /** Fixed hover altitude (showcase / `hover` option): no ground or ceiling clamping. */
  hoverFixed?: boolean;
  patrolR?: number;
  /** Ceiling height found by the upward probe. */
  ceil: number;
  ceilT: number;
  flipT: number;
  avoid: Vector3;
  atk: GullAttackState;
  atkT: number;
  cool: number;
  shots: number;
  /** Bolt lead factor for the current burst. */
  lead?: number;
  /** Round-robin index of the obstacle probe run this frame. */
  feeler: number;
  strobeT: number;
  spin: number;
  /** Rotor knocked off on death (-1 while alive). */
  lostRotor: number;
  /** Gimbal yaw / pitch. */
  gy: number;
  gp: number;
  sweep: number;
  /** Throttle (scales rotor spin and pitch of the rotor sound). */
  thr: number;
}

/** Creates pooled gull number `index` (inactive until spawned). */
export function createGull(
  ctx: EnemyContext,
  def: GullRigDef,
  mats: EnemyMaterials,
  index: number
): GullEnemy {
  const game = ctx.G;
  const rng = ctx.rng;
  const lensMat = mats.lensBase.clone();
  const rig = createSkinnedRig(
    def,
    {
      shell: mats.shell,
      metal: mats.metal,
      glow: mats.glow,
      lens: lensMat,
      disc: mats.disc,
      cone: mats.cone
    },
    {
      radius: 0.9,
      center: [0, 0, 0],
      extra: {
        def: def.extra,
        radius: 10
      }
    }
  );
  const bones = rig.bones;
  rig.group.rotation.order = 'YXZ';
  rig.group.visible = false;
  const label = game.mats.label('G-' + String(index + 11), {
    color: 'black',
    font: 'stencil',
    distress: 0.35
  });
  const labelWidth = 0.105;
  const labelHeight = Math.min(0.045, labelWidth / (label.aspect || 3));
  const labelGeo = new PlaneGeometry(labelWidth, labelHeight);
  labelGeo.rotateX(-Math.PI / 2);
  labelGeo.rotateY(Math.PI);
  const labelMesh = new Mesh(labelGeo, label.material);
  labelMesh.position.set(0, 0.0985, -0.085);
  labelMesh.castShadow = false;
  labelMesh.receiveShadow = true;
  bones.body.add(labelMesh);
  const gull: GullEnemy = {
    id: 0,
    type: 'gull',
    pos: rig.group.position,
    alive: false,
    hp: GULL_CFG.hp,
    active: false,
    rig: rig,
    lens: lensMat,
    vel: new Vector3(),
    yaw: 0,
    pitch: 0,
    roll: 0,
    home: new Vector3(),
    lastKnown: new Vector3(),
    sensor: new Vector3(),
    fwd: new Vector3(0, 0, 1),
    muzzle: new Vector3(),
    mode: 'patrol',
    los: false,
    seeT: 0,
    noSeeT: 0,
    senseT: 0,
    exposure: 0,
    modeT: 0,
    passive: false,
    hasToken: false,
    orbitA: 0,
    orbitDir: 1,
    orbitR: 16,
    alt: 6,
    hoverY: 0,
    phase: 0,
    ceil: 1e9,
    ceilT: 0,
    flipT: 0,
    avoid: new Vector3(),
    atk: 'idle',
    atkT: 0,
    cool: 1,
    shots: 0,
    smokeT: 0,
    feeler: 0,
    strobeT: 0,
    flare: 0,
    lensC: [GULL_LENS_IDLE_COLOR[0], GULL_LENS_IDLE_COLOR[1], GULL_LENS_IDLE_COLOR[2]],
    dieT: 0,
    spin: 0,
    lostRotor: 0,
    gy: 0,
    gp: 0,
    loop: null,
    sweep: 0,
    thr: 1,
    damage(amount, point, dir, part) {
      if (gull.alive) {
        gull.hp -= amount;
        game.events.emit('enemy:hit', {
          enemy: gull,
          point: point,
          part: part || 'body'
        });
        if (dir) {
          gull.vel.addScaledVector(dir, Math.min(3, amount * 0.09));
          gull.roll += (rng() - 0.5) * 0.5;
          gull.pitch += (rng() - 0.5) * 0.4;
        }
        ctx.provoke(gull);
        if (gull.hp <= 0) {
          die(dir);
          return true;
        } else {
          return false;
        }
      } else {
        return false;
      }
    },
    _activate(pos, opts = {}) {
      gull.active = true;
      gull.alive = true;
      gull.hp = GULL_CFG.hp;
      gull.passive = !!opts.passive;
      gull.pos.copy(pos);
      gull.home.copy(pos);
      gull.vel.set(0, 0, 0);
      gull.yaw = opts.yaw ?? rng() * 6.283;
      gull.pitch = gull.roll = 0;
      gull.mode = opts.state === 'alert' ? 'investigate' : 'patrol';
      gull.modeT = 8;
      gull.lastKnown.copy(opts.target || (game.player ? game.player.pos : pos));
      gull.los = false;
      gull.seeT = gull.noSeeT = 0;
      gull.exposure = 0;
      gull.senseT = rng() * 0.2;
      gull.hasToken = false;
      gull.orbitDir = rng() < 0.5 ? 1 : -1;
      gull.orbitR = GULL_CFG.rangeMin + 2 + rng() * (GULL_CFG.rangeMax - GULL_CFG.rangeMin - 5);
      gull.alt =
        opts.hover ?? GULL_CFG.altMin + 0.8 + rng() * (GULL_CFG.altMax - GULL_CFG.altMin - 1.6);
      gull.hoverFixed = opts.hover != null;
      gull.patrolR = opts.patrolRadius ?? 4 + rng() * 5;
      gull.phase = rng() * 6.283;
      gull.orbitA = rng() * 6.283;
      gull.ceil = 1e9;
      gull.flipT = 3 + rng() * 4;
      gull.atk = 'idle';
      gull.cool = 1 + rng() * 1.5;
      gull.dieT = 0;
      gull.spin = 0;
      gull.lostRotor = -1;
      gull.flare = 0;
      gull.thr = 1;
      for (let i = 0; i < 4; i++) {
        bones['rotor' + i].scale.setScalar(1);
      }
      bones.lamp.scale.setScalar(1);
      bones.body.rotation.set(0, 0, 0);
      rig.group.visible = true;
      rig.group.rotation.set(0, gull.yaw, 0);
      const audio = game.audio as EnemyAudioSource | undefined;
      if (audio && audio.loop && !gull.loop) {
        try {
          gull.loop = audio.loop('gull_rotor', {
            pos: gull.pos,
            gain: 0.5
          });
        } catch {
          gull.loop = null;
        }
      }
    },
    _deactivate() {
      gull.active = false;
      gull.alive = false;
      rig.group.visible = false;
      ctx.releaseToken(gull);
      if (gull.loop) {
        try {
          gull.loop.stop();
        } catch {}
        gull.loop = null;
      }
    },
    _raycast(origin, dir, maxDist, hit) {
      const ox = origin.x - gull.pos.x;
      const oy = (origin.y - gull.pos.y + 0.03) * 2.3;
      const oz = origin.z - gull.pos.z;
      const dx = dir.x;
      const dy = dir.y * 2.3;
      const dz = dir.z;
      const quadA = dx * dx + dy * dy + dz * dz;
      const quadB = ox * dx + oy * dy + oz * dz;
      const quadC = ox * ox + oy * oy + oz * oz - 0.5 * 0.5;
      const discriminant = quadB * quadB - quadA * quadC;
      if (discriminant < 0) {
        return false;
      }
      const hitDist = (-quadB - Math.sqrt(discriminant)) / quadA;
      if (hitDist < 0 || hitDist > maxDist || hitDist >= hit.dist) {
        return false;
      } else {
        hit.dist = hitDist;
        hit.part = 'body';
        hit.enemy = gull;
        hit.point.copy(origin).addScaledVector(dir, hitDist);
        hit.normal.copy(hit.point).sub(gull.pos);
        hit.normal.y *= 2.3;
        hit.normal.normalize();
        return true;
      }
    },
    _update(dt) {
      if (gull.alive) {
        updateAlive(dt);
      } else {
        updateWreck(dt);
      }
    }
  };
  function die(dir: Vector3 | null | undefined): void {
    gull.alive = false;
    ctx.releaseToken(gull);
    gull.dieT = 0;
    gull.lostRotor = Math.floor(rng() * 4);
    bones['rotor' + gull.lostRotor].scale.setScalar(1e-4);
    tmpGullVec
      .set(
        GULL_DIMENSIONS.rotors[gull.lostRotor][0],
        0.05,
        GULL_DIMENSIONS.rotors[gull.lostRotor][2]
      )
      .applyAxisAngle(GULL_UP, gull.yaw)
      .add(gull.pos);
    game.fx.sparks(tmpGullVec, GULL_UP, 14);
    game.fx.debris(tmpGullVec, {
      count: 3
    });
    game.fx.smoke(tmpGullVec, {
      size: 0.5,
      life: 1
    });
    gull.spin = (rng() < 0.5 ? -1 : 1) * (5 + rng() * 3);
    gull.vel.y += 1.5;
    if (dir) {
      gull.vel.addScaledVector(dir, 2.5);
    }
    bones.lamp.scale.setScalar(1e-4);
    bones.strobeG.scale.setScalar(1e-4);
    bones.strobeR.scale.setScalar(1e-4);
    bones.strobeW.scale.setScalar(1e-4);
    lensMat.color.setRGB(0.3, 0.05, 0.02);
    game.events.emit('enemy:killed', {
      enemy: gull,
      pos: gull.pos,
      type: 'gull'
    });
  }
  function updateWreck(dt: number): void {
    gull.dieT += dt;
    gull.vel.y -= 9.5 * dt;
    gull.vel.x *= 1 - 0.4 * dt;
    gull.vel.z *= 1 - 0.4 * dt;
    gull.spin += Math.sign(gull.spin) * 7 * dt;
    gull.yaw += gull.spin * dt;
    gull.roll += gull.spin * 0.35 * dt;
    gull.pitch += 0.9 * dt;
    const speed = gull.vel.length();
    const step = speed * dt;
    let crashed = gull.dieT > 5 || gull.pos.y < -3;
    if (!crashed && speed > 0.01) {
      tmpGullBoltDir.copy(gull.vel).multiplyScalar(1 / speed);
      const hit = game.physics.raycast(gull.pos, tmpGullBoltDir, step + 0.3);
      if (hit) {
        gull.pos.copy(hit.point).addScaledVector(hit.normal, 0.2);
        crashed = true;
      }
    }
    if (!crashed) {
      gull.pos.addScaledVector(gull.vel, dt);
    }
    rig.group.rotation.set(gull.pitch, gull.yaw, gull.roll);
    for (let i = 0; i < 4; i++) {
      if (i !== gull.lostRotor) {
        bones['rotor' + i].rotation.y +=
          (i % 3 === 0 ? 1 : -1) * 30 * Math.max(0.2, 1 - gull.dieT * 0.5) * dt;
      }
    }
    gull.smokeT -= dt;
    if (gull.smokeT <= 0) {
      gull.smokeT = 0.045;
      game.fx.smoke(gull.pos, {
        size: 0.45,
        life: 1.3,
        color: 0x15161a,
        rise: 0.6
      });
      if (rng() < 0.5) {
        tmpGullVec.set(rng() - 0.5, rng(), rng() - 0.5).normalize();
        game.fx.sparks(gull.pos, tmpGullVec, 3);
      }
    }
    if (gull.loop) {
      gull.loop.setPos(gull.pos);
      gull.loop.setPitch(Math.max(0.4, 1.25 - gull.dieT * 0.4));
      gull.loop.setGain(0.5);
    }
    if (crashed) {
      game.fx.explosion(gull.pos, 1.2);
      if (game.combat && game.combat.explode) {
        game.combat.explode(gull.pos, GULL_CFG.explodeRadius, GULL_CFG.explodeDamage, 'enemy');
      }
      ctx.retire(gull);
    }
  }
  function updateAlive(dt: number): void {
    const player = game.player;
    const time = ctx.t;
    gull.fwd.set(Math.sin(gull.yaw), 0, Math.cos(gull.yaw));
    gull.sensor.set(0, -0.17, 0.27).applyAxisAngle(GULL_UP, gull.yaw).add(gull.pos);
    ctx.think(gull, dt, 0.4);
    const engaged = gull.mode === 'engage';
    const damaged = gull.hp < GULL_CFG.hp * 0.5;
    let maxSpeed = GULL_CFG.patrolSpeed;
    let targetX: number;
    let targetY: number;
    let targetZ: number;
    if (engaged && player) {
      maxSpeed = GULL_CFG.maxSpeed;
      const attacking = gull.atk !== 'idle';
      gull.flipT -= dt;
      if (gull.flipT <= 0) {
        gull.flipT = 3 + rng() * 5;
        if (rng() < 0.6) {
          gull.orbitDir = -gull.orbitDir;
        }
        gull.orbitR = gullClamp(
          gull.orbitR + (rng() - 0.5) * 6,
          GULL_CFG.rangeMin + 1,
          GULL_CFG.rangeMax - 2
        );
      }
      if (gull.noSeeT > 1.5) {
        targetX = gull.lastKnown.x;
        targetZ = gull.lastKnown.z;
        targetY = gull.lastKnown.y + gull.alt + 1;
        gull.orbitA = Math.atan2(gull.pos.z - gull.lastKnown.z, gull.pos.x - gull.lastKnown.x);
      } else {
        gull.orbitA += ((gull.orbitDir * (attacking ? 0.9 : 3.6)) / gull.orbitR) * dt;
        targetX = player.pos.x + Math.cos(gull.orbitA) * gull.orbitR;
        targetZ = player.pos.z + Math.sin(gull.orbitA) * gull.orbitR;
        targetY = player.pos.y + gull.alt;
      }
    } else if (gull.mode === 'investigate' || gull.mode === 'search') {
      maxSpeed = 5.5;
      gull.orbitA += 0.5 * dt;
      targetX = gull.lastKnown.x + Math.cos(gull.orbitA) * 4.5;
      targetZ = gull.lastKnown.z + Math.sin(gull.orbitA) * 4.5;
      targetY = gull.lastKnown.y + Math.min(gull.alt, 5.5);
    } else {
      gull.orbitA += 0.28 * dt * gull.orbitDir;
      targetX = gull.home.x + Math.cos(gull.orbitA) * gull.patrolR!;
      targetZ = gull.home.z + Math.sin(gull.orbitA) * gull.patrolR!;
      targetY = gull.hoverFixed ? gull.alt : gull.home.y;
    }
    if (targetY > gull.ceil) {
      targetY = gull.ceil;
    }
    if (!gull.hoverFixed && targetY < 2.2) {
      targetY = 2.2;
    }
    tmpGullSteer.set(
      (targetX - gull.pos.x) * 2.2 - gull.vel.x * 2.4,
      (targetY - gull.pos.y) * 5 - gull.vel.y * 3.6,
      (targetZ - gull.pos.z) * 2.2 - gull.vel.z * 2.4
    );
    gull.feeler = (gull.feeler + 1) % 3;
    const flatSpeed = Math.hypot(gull.vel.x, gull.vel.z);
    if (gull.feeler === 0 && flatSpeed > 0.6) {
      tmpGullBoltDir.set(gull.vel.x / flatSpeed, 0, gull.vel.z / flatSpeed);
      const probeLen = 2.2 + flatSpeed * 0.5;
      const hit = game.physics.raycast(gull.pos, tmpGullBoltDir, probeLen);
      if (hit) {
        const closeness = 1 - hit.dist / probeLen;
        gull.avoid.copy(hit.normal).multiplyScalar(26 * closeness);
        gull.avoid.y += 9 * closeness;
        if (closeness > 0.5) {
          gull.orbitDir = -gull.orbitDir;
          gull.flipT = 2.5;
        }
      }
    } else if (gull.feeler === 1) {
      const hit = game.physics.raycast(gull.pos, GULL_DOWN, 2.4);
      if (hit && !gull.hoverFixed) {
        gull.avoid.y += (2.4 - hit.dist) * 10;
      }
    } else if (gull.feeler === 2) {
      gull.ceilT -= dt * 3;
      if (gull.ceilT <= 0) {
        gull.ceilT = 0.35;
        const hit = game.physics.raycast(gull.pos, GULL_UP, 4);
        gull.ceil = hit ? gull.pos.y + hit.dist - 1.3 : 1e9;
      }
    }
    tmpGullSteer.add(gull.avoid);
    gull.avoid.multiplyScalar(Math.exp(-6 * dt));
    if (damaged) {
      tmpGullSteer.x += Math.sin(time * 7.3 + gull.phase) * 5;
      tmpGullSteer.z += Math.cos(time * 6.1 + gull.phase) * 5;
      tmpGullSteer.y += Math.sin(time * 9.7) * 3;
    }
    const steerLen = tmpGullSteer.length();
    if (steerLen > GULL_CFG.accel) {
      tmpGullSteer.multiplyScalar(GULL_CFG.accel / steerLen);
    }
    gull.vel.addScaledVector(tmpGullSteer, dt);
    let speed = gull.vel.length();
    if (speed > maxSpeed) {
      gull.vel.multiplyScalar(maxSpeed / speed);
      speed = maxSpeed;
    }
    for (let axis = 0; axis < 3; axis++) {
      const axisVel = axis === 0 ? gull.vel.x : axis === 1 ? gull.vel.y : gull.vel.z;
      if (Math.abs(axisVel) < 0.02) {
        continue;
      }
      const axisSign = axisVel > 0 ? 1 : -1;
      const clearance = axis === 1 ? 0.35 : 0.62;
      tmpGullBoltDir.set(
        axis === 0 ? axisSign : 0,
        axis === 1 ? axisSign : 0,
        axis === 2 ? axisSign : 0
      );
      const hit = game.physics.raycast(
        gull.pos,
        tmpGullBoltDir,
        Math.abs(axisVel) * dt + clearance
      );
      if (hit) {
        gull.vel.setComponent(axis, -axisVel * 0.25);
        gull.avoid.setComponent(axis, gull.avoid.getComponent(axis) - axisSign * 8);
        if (hit.dist < clearance) {
          gull.pos.setComponent(
            axis,
            gull.pos.getComponent(axis) - axisSign * (clearance - hit.dist)
          );
        }
      }
    }
    gull.pos.addScaledVector(gull.vel, dt);
    if (!gull.hoverFixed) {
      const floorY = game.physics.groundHeight(gull.pos.x, gull.pos.z, gull.pos.y + 0.5) + 1.1;
      if (gull.pos.y < floorY) {
        gull.pos.y = floorY;
        if (gull.vel.y < 0) {
          gull.vel.y = 0;
        }
      }
    }
    let desiredYaw = gull.yaw;
    if ((engaged || gull.mode === 'search' || gull.mode === 'investigate') && player) {
      const lookAt = engaged && gull.noSeeT < 1.5 ? player.pos : gull.lastKnown;
      desiredYaw = Math.atan2(lookAt.x - gull.pos.x, lookAt.z - gull.pos.z);
    } else if (flatSpeed > 0.4) {
      desiredYaw = Math.atan2(gull.vel.x, gull.vel.z);
    }
    const yawError = gullAngleDelta(desiredYaw, gull.yaw);
    gull.yaw += gullClamp(yawError, -3.2 * dt, 3.2 * dt);
    const cosYaw = Math.cos(gull.yaw);
    const sinYaw = Math.sin(gull.yaw);
    const steerFwd = tmpGullSteer.x * sinYaw + tmpGullSteer.z * cosYaw;
    const steerSide = tmpGullSteer.x * cosYaw - tmpGullSteer.z * sinYaw;
    let targetPitch = gullClamp(steerFwd * 0.04, -0.42, 0.42);
    let targetRoll = gullClamp(-steerSide * 0.04, -0.42, 0.42);
    if (damaged) {
      targetPitch += Math.sin(time * 11 + gull.phase) * 0.1;
      targetRoll += Math.cos(time * 8.7 + gull.phase * 2) * 0.13;
    }
    const attitudeBlend = 1 - Math.exp(-7 * dt);
    gull.pitch += (targetPitch - gull.pitch) * attitudeBlend;
    gull.roll += (targetRoll - gull.roll) * attitudeBlend;
    rig.group.rotation.set(gull.pitch, gull.yaw, gull.roll);
    bones.body.position.y =
      Math.sin(time * 2.1 + gull.phase) * 0.045 + Math.sin(time * 3.7 + gull.phase * 1.7) * 0.018;
    gull.thr +=
      (1 + gullClamp(tmpGullSteer.y * 0.03, -0.25, 0.4) + flatSpeed * 0.02 - gull.thr) *
      attitudeBlend;
    const rotorSpin = 41 * gull.thr * dt;
    bones.rotor0.rotation.y += rotorSpin;
    bones.rotor1.rotation.y -= rotorSpin * 1.03;
    bones.rotor2.rotation.y -= rotorSpin * 0.98;
    bones.rotor3.rotation.y += rotorSpin * 1.01;
    const strobePhase = (time * 0.9 + gull.phase * 0.1) % 1;
    const strobeScale = strobePhase < 0.05 || (strobePhase > 0.13 && strobePhase < 0.18) ? 1 : 1e-4;
    bones.strobeR.scale.setScalar(strobeScale);
    bones.strobeG.scale.setScalar(strobeScale);
    bones.strobeW.scale.setScalar(strobePhase > 0.5 && strobePhase < 0.56 ? 1 : 1e-4);
    if (engaged && player) {
      tmpGimbalTarget.set(player.pos.x, player.pos.y + 1.1, player.pos.z);
    } else if (gull.mode !== 'patrol') {
      gull.sweep += dt;
      tmpGimbalTarget.set(
        gull.lastKnown.x + Math.sin(gull.sweep * 0.9) * 3,
        gull.lastKnown.y,
        gull.lastKnown.z + Math.cos(gull.sweep * 0.7) * 3
      );
    } else {
      gull.sweep += dt;
      const lookYaw = gull.yaw + Math.sin(gull.sweep * 0.5 + gull.phase) * 0.9;
      tmpGimbalTarget.set(
        gull.pos.x + Math.sin(lookYaw) * 5,
        gull.pos.y - (gull.hoverFixed ? 1.6 : 5),
        gull.pos.z + Math.cos(lookYaw) * 5
      );
    }
    tmpGullVec.copy(tmpGimbalTarget).sub(gull.sensor);
    const localX = tmpGullVec.x * cosYaw - tmpGullVec.z * sinYaw;
    const localZ = tmpGullVec.x * sinYaw + tmpGullVec.z * cosYaw;
    const localY = tmpGullVec.y;
    const targetGimbalYaw = Math.atan2(localX, localZ);
    const targetGimbalPitch = gullClamp(Math.atan2(-localY, Math.hypot(localX, localZ)), -0.5, 1.5);
    const gimbalBlend = 1 - Math.exp(-9 * dt);
    gull.gy += gullAngleDelta(targetGimbalYaw, gull.gy) * gimbalBlend;
    gull.gp += (targetGimbalPitch - gull.gp) * gimbalBlend;
    bones.gimbalYaw.rotation.y = gull.gy;
    bones.ball.rotation.x = gull.gp - gull.pitch;
    bones.gun.rotation.x = gullClamp(gull.gp, -0.2, 1.3) - gull.pitch;
    const lensTarget = engaged ? GULL_LENS_ALERT_COLOR : GULL_LENS_IDLE_COLOR;
    const lensGain = 1 + gull.flare * 3.2 + (engaged ? 0 : Math.sin(time * 3 + gull.phase) * 0.15);
    for (let i = 0; i < 3; i++) {
      gull.lensC[i] += (lensTarget[i] - gull.lensC[i]) * (1 - Math.exp(-8 * dt));
    }
    lensMat.color.setRGB(
      gull.lensC[0] * lensGain,
      gull.lensC[1] * lensGain,
      gull.lensC[2] * lensGain
    );
    gull.flare = Math.max(0, gull.flare - dt * 1.5);
    gull.muzzle.set(0, -0.12, 0.17).applyAxisAngle(GULL_UP, gull.yaw).add(gull.pos);
    gull.cool -= dt;
    if (gull.atk === 'idle') {
      if (
        engaged &&
        gull.los &&
        gull.cool <= 0 &&
        player &&
        player.alive &&
        Math.abs(yawError) < 0.35 &&
        gull.pos.distanceTo(player.pos) < GULL_CFG.fireRange &&
        ctx.requestToken(gull)
      ) {
        gull.atk = 'tele';
        gull.atkT = GULL_CFG.telegraph;
        game.events.emit('enemy:telegraph', {
          enemy: gull,
          type: 'gull',
          time: GULL_CFG.telegraph,
          pos: gull.pos
        });
      }
    } else if (gull.atk === 'tele') {
      gull.atkT -= dt;
      gull.flare = Math.min(1, gull.flare + dt * 4.5);
      if (engaged) {
        if (gull.atkT <= 0) {
          gull.atk = 'burst';
          gull.shots = GULL_CFG.burst;
          gull.atkT = 0;
          gull.lead = 0.2 + rng() * 0.65;
        }
      } else {
        gull.atk = 'idle';
        ctx.releaseToken(gull);
      }
    } else if (gull.atk === 'burst') {
      gull.atkT -= dt;
      gull.flare = 1;
      if (gull.atkT <= 0) {
        gull.atkT = GULL_CFG.burstGap;
        gull.shots--;
        if (player) {
          const dist = gull.muzzle.distanceTo(player.pos);
          const flightTime = dist / GULL_CFG.boltSpeed;
          tmpGimbalTarget.set(
            player.pos.x + player.vel.x * flightTime * gull.lead!,
            player.pos.y + 1.05,
            player.pos.z + player.vel.z * flightTime * gull.lead!
          );
          tmpGullBoltDir.copy(tmpGimbalTarget).sub(gull.muzzle).normalize();
          const spread =
            (GULL_CFG.spreadFar + (GULL_CFG.spreadNear - GULL_CFG.spreadFar) * gull.exposure) *
            (1 + ctx.playerSpeed * 0.45) *
            (damaged ? 1.5 : 1);
          tmpGullBoltDir.x += (rng() - 0.5) * 2 * spread;
          tmpGullBoltDir.y += (rng() - 0.5) * 2 * spread;
          tmpGullBoltDir.z += (rng() - 0.5) * 2 * spread;
          tmpGullBoltDir.normalize();
          ctx.fireBolt(gull.muzzle, tmpGullBoltDir, gull);
          game.fx.muzzleFlash(gull.muzzle, tmpGullBoltDir, {
            scale: 0.55
          });
          game.events.emit('enemy:fire', {
            enemy: gull,
            pos: gull.muzzle,
            dir: tmpGullBoltDir,
            type: 'gull'
          });
          gull.vel.addScaledVector(tmpGullBoltDir, -0.35);
        }
        if (gull.shots <= 0) {
          gull.atk = 'idle';
          gull.cool = GULL_CFG.cooldown[0] + rng() * (GULL_CFG.cooldown[1] - GULL_CFG.cooldown[0]);
          ctx.releaseToken(gull);
        }
      }
    }
    if (damaged) {
      gull.smokeT -= dt;
      if (gull.smokeT <= 0) {
        gull.smokeT = 0.16;
        game.fx.smoke(gull.pos, {
          size: 0.3,
          life: 1.1,
          color: 0x26282c,
          rise: 0.8
        });
        if (rng() < 0.15) {
          game.fx.sparks(gull.pos, GULL_DOWN, 2);
        }
      }
    }
    if (gull.loop) {
      gull.loop.setPos(gull.pos);
      gull.loop.setPitch(0.85 + gull.thr * 0.2 + (damaged ? Math.sin(time * 13) * 0.05 : 0));
    }
  }
  return gull;
}
