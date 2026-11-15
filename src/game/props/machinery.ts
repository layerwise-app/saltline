// Procedural yard machinery props: forklift, diesel generator, dumpster and
// mechanic's toolbox cart. Each builder assembles merged, vertex-tinted meshes
// through `CargoPropBuilder` and registers itself with the prop registry.
import * as THREE from 'three';
import type { Group } from 'three';
import type { Game } from '../core/types';
import type { Rng } from '../core/rng';
import { tubeThroughPoints, worldUvBox, worldUvCylinder } from '../render/geometry';
import {
  HALF_PI,
  PI,
  clamp,
  computeWeldedNormals,
  cylinderBetween,
  extrudePolygon,
  flatPlaneGeometry,
  mapVertices,
  metricSphereGeometry,
  metricTorusGeometry,
  paintMaterialFor,
  ribbonGeometry,
  roundedBoxGeometry,
  smoothLatheGeometry,
  subdividedRoundedBox,
  valueNoise3d
} from './meshUtils';
import { CargoPropBuilder, buildTireGeometry } from './cargo';

type Vec2 = [number, number];
type Vec3 = [number, number, number];
/** A per-mesh tint: uniform grey factor or RGB multiplier. */
type Tint = number | number[];

/** An axis-aligned collision box in prop-local space. */
interface MachineryCollider {
  min: Vec3;
  max: Vec3;
  surface: string;
}

/** Options accepted by the machinery prop builders (all optional). */
export interface MachineryPropOptions {
  seed?: number;
  /** Paint colour name, e.g. `'yellow'`, `'red'` (see `paintMaterialFor`). */
  color?: string;
  /** Forklift fleet number painted on the counterweight. */
  number?: string;
  /** Forklift fork height, 0 (down) .. 1 (fully raised). */
  forksUp?: number | string;
  /** Overrides the stencilled label on generator / dumpster / toolbox cart. */
  label?: string;
}

/** Builder callback signature expected by `registerProp`. */
export type MachineryPropBuilder = (game: Game, options?: MachineryPropOptions) => Group;

/** Returns a tint factory scaling the paint's base tint by `factor`. */
function makePaintTint(baseTint: Tint): (factor?: number) => Tint {
  return (factor = 1) =>
    typeof baseTint == 'number' ? baseTint * factor : baseTint.map((channel) => channel * factor);
}

const tmpBeamQuat = new THREE.Quaternion();
const BEAM_UP_AXIS = new THREE.Vector3(0, 1, 0);
const tmpBeamDir = new THREE.Vector3();
const tmpBeamMatrix = new THREE.Matrix4();

/**
 * A box beam of cross-section `width` x `depth` spanning `from` to `to`.
 * Rounded with `radius` unless `sharp` is set (plain world-UV box).
 */
function beamBetweenPoints(
  from: readonly number[],
  to: readonly number[],
  width: number,
  depth: number,
  radius = 0.006,
  sharp = false
): THREE.BufferGeometry {
  tmpBeamDir.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const length = tmpBeamDir.length();
  tmpBeamDir.normalize();
  const geometry = sharp
    ? worldUvBox(width, length, depth)
    : roundedBoxGeometry(width, length, depth, radius);
  tmpBeamQuat.setFromUnitVectors(BEAM_UP_AXIS, tmpBeamDir);
  tmpBeamMatrix.compose(
    new THREE.Vector3((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2),
    tmpBeamQuat,
    new THREE.Vector3(1, 1, 1)
  );
  geometry.applyMatrix4(tmpBeamMatrix);
  return geometry;
}

/** Returns the polygon in counter-clockwise winding (reversed copy if it was clockwise). */
const ensureCounterClockwise = (points: Vec2[]): Vec2[] => {
  let signedArea = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    signedArea += current[0] * next[1] - next[0] * current[1];
  }
  return signedArea < 0 ? points.slice().reverse() : points;
};

/** Adds one forklift wheel (tyre, painted rim, hub and lug nuts) at axle `x`. */
function addForkliftWheel(
  builder: InstanceType<typeof CargoPropBuilder>,
  x: number,
  radius: number,
  width: number,
  halfTrack: number,
  side: number,
  rimRadius: number,
  segments: number,
  _unused: number,
  rng: Rng
): void {
  const tire = buildTireGeometry(radius, width, rimRadius, segments);
  builder.push({
    p: [x, radius, side > 0 ? halfTrack - width / 2 : -(halfTrack - width / 2)],
    r: [side > 0 ? HALF_PI : -HALF_PI, 0, 0]
  });
  builder.push({
    r: [0, rng() * 6, 0]
  });
  const noiseOffset = rng() * 20;
  builder.add('tire', tire, null, (px: number, _py: number, pz: number) => {
    const radial = Math.hypot(px, pz);
    return radial < rimRadius + 0.01
      ? 0.45
      : 0.78 + 0.22 * valueNoise3d(Math.atan2(pz, px) * 3 + noiseOffset, radial * 30);
  });
  const hubY = width * 0.8;
  builder.add(
    'paint_yellow',
    smoothLatheGeometry(
      [
        [rimRadius + 0.006, hubY + 0.012],
        [rimRadius - 0.012, hubY + 0.016],
        [rimRadius - 0.03, hubY - 0.02],
        [rimRadius * 0.62, hubY - 0.05],
        [rimRadius * 0.5, hubY - 0.02],
        [rimRadius * 0.42, hubY - 0.012],
        [0, hubY - 0.012]
      ],
      14
    ),
    null,
    (px: number, _py: number, pz: number) =>
      Math.hypot(px, pz) > rimRadius * 0.7 ? [0.55, 0.5, 0.42] : [0.8, 0.78, 0.7]
  );
  builder.add(
    'steel_dark',
    smoothLatheGeometry(
      [
        [0, width * 0.2],
        [rimRadius + 0.004, width * 0.2]
      ],
      10
    ),
    null,
    0.4
  );
  builder.add(
    'steel_dark',
    worldUvCylinder(rimRadius * 0.2, rimRadius * 0.24, 0.035, 8),
    {
      p: [0, hubY, 0]
    },
    0.7
  );
  for (let nut = 0; nut < 6; nut++) {
    const angle = (nut * PI) / 3;
    builder.add(
      'steel_galv',
      worldUvCylinder(0.011, 0.012, 0.016, 6),
      {
        p: [Math.cos(angle) * rimRadius * 0.33, hubY - 0.006, Math.sin(angle) * rimRadius * 0.33]
      },
      rng.range(0.5, 0.8)
    );
  }
  builder.pop();
  builder.pop();
}

/** Counterbalance forklift with mast, overhead guard, LPG tank and forks (`forksUp` lifts them). */
function buildForklift(game: Game, options: MachineryPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'forklift', options.seed || 0);
  const rng = builder.rng;
  const forksUp = clamp(+(options.forksUp ?? 0) || 0, 0, 1);
  const liftHeight = forksUp * 1.5;
  const mastExtension = liftHeight / 2;
  const [paintMat, paintTint] = paintMaterialFor(options.color, 'yellow');
  const tint = makePaintTint(paintTint);
  const frameMat = 'steel_dark';
  const frameTint = () => rng.range(0.68, 0.95);
  const fleetNumber = options.number || ['04', '07', '12', '22'][builder.seed % 4];
  const frontRadius = 0.33;
  const frontWidth = 0.23;
  const frontAxleX = 0.22;
  const frontHalfTrack = 0.47;
  const rearRadius = 0.27;
  const rearWidth = 0.18;
  const rearAxleX = -1.1;
  const rearHalfTrack = 0.46;

  // Wheels and axles.
  for (const side of [1, -1]) {
    addForkliftWheel(
      builder,
      frontAxleX,
      frontRadius,
      frontWidth,
      frontHalfTrack,
      side,
      0.195,
      24,
      0,
      rng
    );
    addForkliftWheel(
      builder,
      rearAxleX,
      rearRadius,
      rearWidth,
      rearHalfTrack,
      side,
      0.155,
      20,
      0,
      rng
    );
  }
  builder.add(
    frameMat,
    cylinderBetween([frontAxleX, frontRadius, -0.4], [frontAxleX, frontRadius, 0.4], 0.07, 8),
    null,
    0.5
  );
  builder.add(
    frameMat,
    roundedBoxGeometry(0.12, 0.1, 0.78, 0.01),
    {
      p: [rearAxleX, rearRadius, 0]
    },
    0.5
  );
  builder.add(
    frameMat,
    roundedBoxGeometry(1.95, 0.34, 0.68, 0.02),
    {
      p: [-0.425, 0.37, 0]
    },
    0.55
  );

  // Side steps and front wheel arches.
  for (const side of [1, -1]) {
    builder.add(
      paintMat,
      roundedBoxGeometry(0.6, 0.3, 0.17, 0.02),
      {
        p: [-0.47, 0.4, side * 0.42]
      },
      tint(0.92)
    );
    builder.add(
      'diamond_plate',
      roundedBoxGeometry(0.3, 0.012, 0.16, 0.003),
      {
        p: [-0.32, 0.556, side * 0.42]
      },
      0.7
    );
    builder.add(
      frameMat,
      worldUvCylinder(0.03, 0.03, 0.02, 8),
      {
        p: [-0.62, 0.56, side * 0.42]
      },
      0.6
    );
    const archOutline: Vec2[] = [];
    const innerRadius = frontRadius + 0.035;
    const outerRadius = frontRadius + 0.06;
    for (let step = 0; step <= 7; step++) {
      const angle = 0.12 + ((PI - 0.5) * step) / 7;
      archOutline.push([
        frontAxleX + Math.cos(angle) * outerRadius,
        frontRadius + Math.sin(angle) * outerRadius
      ]);
    }
    for (let step = 7; step >= 0; step--) {
      const angle = 0.12 + ((PI - 0.5) * step) / 7;
      archOutline.push([
        frontAxleX + Math.cos(angle) * innerRadius,
        frontRadius + Math.sin(angle) * innerRadius
      ]);
    }
    builder.add(
      paintMat,
      extrudePolygon(archOutline, 0.27, {
        soft: 0.7
      }),
      {
        p: [0, 0, side * 0.475]
      },
      tint(0.95)
    );
  }

  // Floor plate and pedals.
  builder.add(
    'diamond_plate',
    worldUvBox(0.66, 0.016, 0.68),
    {
      p: [0.2, 0.548, 0]
    },
    0.6
  );
  for (const pedalZ of [-0.12, 0.1]) {
    builder.add(
      'rubber',
      roundedBoxGeometry(0.1, 0.02, 0.07, 0.006),
      {
        p: [0.33, 0.6, pedalZ],
        r: [0, 0, 0.5]
      },
      0.8
    );
  }

  // Counterweight.
  const counterweight = subdividedRoundedBox(0.62, 0.63, 1.12, 0.12, 3, 3, 3);
  mapVertices(counterweight, (vertex: THREE.Vector3) => {
    if (vertex.y > 0.1) {
      const slope = (vertex.y - 0.1) / 0.215;
      vertex.x += 0.03 * slope * (vertex.x < 0 ? 1 : 0);
    }
  });
  builder.add(
    paintMat,
    computeWeldedNormals(counterweight),
    {
      p: [-1.39, 0.915, 0]
    },
    tint(0.97)
  );
  builder.add(
    paintMat,
    roundedBoxGeometry(0.56, 0.37, 0.64, 0.05),
    {
      p: [-1.4, 0.43, 0]
    },
    tint(0.85)
  );
  builder.add(
    'hazard_stripes',
    roundedBoxGeometry(0.014, 0.085, 0.84, 0.004),
    {
      p: [-1.702, 0.77, 0]
    },
    0.95
  );
  builder.label(
    fleetNumber,
    {
      color: 'black',
      font: 'stencil',
      distress: 0.35
    },
    0.4,
    0.2,
    {
      p: [-1.703, 0.96, 0],
      r: [0, -HALF_PI, 0]
    }
  );
  for (const side of [1, -1]) {
    // Tail light, its housing, side branding and tow-pin bracket.
    builder.add(
      game.mats.emissive(0xff2a12, 0.16),
      roundedBoxGeometry(0.012, 0.05, 0.11, 0.004),
      {
        p: [-1.69, 1.1, side * 0.37]
      },
      1,
      {
        raw: true
      }
    );
    builder.add(
      frameMat,
      roundedBoxGeometry(0.016, 0.066, 0.126, 0.004),
      {
        p: [-1.684, 1.1, side * 0.37]
      },
      0.4
    );
    builder.label(
      'SALTLINE',
      {
        color: 'black',
        font: 'sans',
        distress: 0.3
      },
      0.42,
      0.085,
      {
        p: [-1.39, 0.99, side * 0.5625],
        r: [0, side > 0 ? 0 : PI, 0]
      }
    );
    builder.add(
      frameMat,
      roundedBoxGeometry(0.06, 0.05, 0.02, 0.004),
      {
        p: [-1.67, 0.44, side * 0.05]
      },
      0.5
    );
  }
  builder.add(
    'steel_worn',
    worldUvCylinder(0.02, 0.02, 0.13, 8),
    {
      p: [-1.68, 0.44, 0]
    },
    0.7
  );

  // Engine hood with louvred side vents.
  builder.add(
    paintMat,
    roundedBoxGeometry(0.98, 0.46, 0.94, 0.04),
    {
      p: [-0.59, 0.79, 0]
    },
    tint()
  );
  for (const side of [1, -1]) {
    builder.label(
      fleetNumber,
      {
        color: 'black',
        font: 'stencil',
        distress: 0.35
      },
      0.3,
      0.19,
      {
        p: [-0.84, 0.8, side * 0.4715],
        r: [0, side > 0 ? 0 : PI, 0]
      }
    );
    builder.add(
      frameMat,
      worldUvBox(0.34, 0.2, 0.004),
      {
        p: [-0.36, 0.8, side * 0.47]
      },
      0.2
    );
    for (let slat = 0; slat < 5; slat++) {
      builder.add(
        paintMat,
        worldUvBox(0.34, 0.03, 0.006),
        {
          p: [-0.36, 0.72 + slat * 0.04, side * 0.474],
          r: [side * 0.5, 0, 0]
        },
        tint(0.85)
      );
    }
  }

  // Seat.
  builder.add(
    frameMat,
    roundedBoxGeometry(0.4, 0.05, 0.4, 0.01),
    {
      p: [-0.54, 1.045, 0]
    },
    0.5
  );
  const seatCushion = subdividedRoundedBox(0.46, 0.1, 0.46, 0.04, 3, 3, 3);
  mapVertices(seatCushion, (vertex: THREE.Vector3) => {
    if (vertex.y > 0) vertex.y -= 0.018 * Math.cos(vertex.x * 5) * Math.cos(vertex.z * 5);
  });
  builder.add(
    'rubber',
    computeWeldedNormals(seatCushion),
    {
      p: [-0.53, 1.115, 0]
    },
    1
  );
  const seatBack = subdividedRoundedBox(0.1, 0.5, 0.44, 0.04, 3, 4, 3);
  mapVertices(seatBack, (vertex: THREE.Vector3) => {
    if (vertex.x > 0) vertex.x -= 0.02 * Math.cos(vertex.z * 5.5);
  });
  builder.add(
    'rubber',
    computeWeldedNormals(seatBack),
    {
      p: [-0.8, 1.39, 0],
      r: [0, 0, 0.16]
    },
    1
  );
  for (const side of [1, -1]) {
    builder.add(
      frameMat,
      beamBetweenPoints([-0.78, 1.08, side * 0.24], [-0.82, 1.3, side * 0.24], 0.03, 0.012, 0.004),
      null,
      0.5
    );
  }

  // Dashboard / steering column cowl.
  builder.add(
    paintMat,
    extrudePolygon(
      [
        [0.2, 0.55],
        [0.54, 0.55],
        [0.54, 1],
        [0.46, 1.12],
        [0.3, 1.14],
        [0.21, 1.02]
      ],
      0.7,
      {
        soft: 0.5
      }
    ),
    null,
    tint()
  );
  const dashAngle = Math.atan2(0.12, 0.09);
  builder.push({
    p: [0.253, 1.082, 0],
    r: [0, 0, dashAngle]
  });
  builder.add(
    frameMat,
    roundedBoxGeometry(0.012, 0.13, 0.44, 0.004),
    {
      p: [-0.006, 0, 0]
    },
    0.45
  );
  builder.add(
    game.mats.emissive(0x8fe0b0, 0.3),
    flatPlaneGeometry(0.09, 0.05),
    {
      p: [-0.0135, 0.01, 0.1],
      r: [0, -HALF_PI, 0]
    },
    1,
    {
      raw: true,
      cast: false
    }
  );
  builder.decal(game.mats.decal('csc_plate'), 0.09, {
    p: [-0.0135, 0, -0.12],
    r: [0, -HALF_PI, 0]
  });
  builder.add(
    'plastic_red',
    worldUvCylinder(0.016, 0.016, 0.02, 8),
    {
      p: [-0.02, 0, 0.19],
      r: [0, 0, HALF_PI]
    },
    0.9
  );
  builder.add(
    'steel_bare',
    worldUvCylinder(0.009, 0.009, 0.02, 6),
    {
      p: [-0.018, -0.03, -0.01],
      r: [0, 0, HALF_PI]
    },
    0.9
  );
  builder.pop();

  // Steering column and wheel.
  const columnBase: Vec3 = [0.3, 1.1, 0.04];
  const columnTop: Vec3 = [0.1, 1.31, 0.04];
  builder.add(frameMat, cylinderBetween(columnBase, columnTop, 0.024, 8), null, 0.5);
  builder.push({
    p: columnTop,
    r: [0, 0, Math.atan2(columnTop[1] - columnBase[1], columnTop[0] - columnBase[0])]
  });
  builder.add(
    'rubber',
    metricTorusGeometry(0.165, 0.014, 6, 18),
    {
      r: [0, HALF_PI, 0]
    },
    1
  );
  for (let spoke = 0; spoke < 3; spoke++) {
    const angle = (spoke * PI * 2) / 3 + 0.5;
    builder.add(
      frameMat,
      cylinderBetween([-0.01, 0, 0], [0, Math.cos(angle) * 0.16, Math.sin(angle) * 0.16], 0.009, 5),
      null,
      0.5
    );
  }
  builder.add(
    frameMat,
    worldUvCylinder(0.035, 0.04, 0.03, 10),
    {
      p: [-0.005, 0, 0],
      r: [0, 0, HALF_PI]
    },
    0.5
  );
  builder.add(
    'rubber',
    worldUvCylinder(0.016, 0.014, 0.045, 8),
    {
      p: [0.03, 0.16, 0.02],
      r: [0, 0, HALF_PI]
    },
    1
  );
  builder.pop();

  // Hydraulic control levers.
  for (let lever = 0; lever < 3; lever++) {
    const leverZ = -0.2 - lever * 0.055;
    const leverBase: Vec3 = [0.33, 1.12, leverZ];
    const leverTip: Vec3 = [0.25 - lever * 0.012, 1.3 - lever * 0.01, leverZ - 0.01];
    builder.add('steel_bare', cylinderBetween(leverBase, leverTip, 0.007, 5), null, 0.8);
    builder.add(
      'rubber',
      metricSphereGeometry(0.02, 7, 5),
      {
        p: leverTip
      },
      1
    );
  }
  {
    // Direction lever.
    const leverBase: Vec3 = [0.3, 1.1, 0.27];
    const leverTip: Vec3 = [0.2, 1.24, 0.29];
    builder.add('steel_bare', cylinderBetween(leverBase, leverTip, 0.008, 5), null, 0.8);
    builder.add(
      'plastic_red',
      worldUvCylinder(0.016, 0.016, 0.07, 7),
      {
        p: leverTip,
        r: [0, 0, 0.6]
      },
      0.9
    );
  }

  // Overhead guard: posts, rails, roof slats, mirrors, work lights.
  const guardTopY = 2.045;
  const guardColliders: MachineryCollider[] = [];
  for (const side of [1, -1]) {
    const frontPostBase: Vec3 = [0.47, 1.08, side * 0.4];
    const frontPostTop: Vec3 = [0.27, guardTopY, side * 0.46];
    const rearPostBase: Vec3 = [-1, 1, side * 0.44];
    const rearPostTop: Vec3 = [-0.95, guardTopY, side * 0.46];
    builder.add(
      frameMat,
      beamBetweenPoints(frontPostBase, frontPostTop, 0.06, 0.05, 0.01),
      null,
      frameTint()
    );
    builder.add(
      frameMat,
      beamBetweenPoints(rearPostBase, rearPostTop, 0.06, 0.05, 0.01),
      null,
      frameTint()
    );
    builder.add(
      frameMat,
      beamBetweenPoints(
        [0.3, guardTopY, side * 0.46],
        [-0.98, guardTopY, side * 0.46],
        0.05,
        0.06,
        0.01
      ),
      null,
      frameTint()
    );
    builder.add(
      frameMat,
      roundedBoxGeometry(0.09, 0.012, 0.08, 0.003),
      {
        p: [0.47, 1.085, side * 0.4]
      },
      0.5
    );
    builder.add(
      frameMat,
      roundedBoxGeometry(0.09, 0.012, 0.08, 0.003),
      {
        p: [-1, 1.024, side * 0.44]
      },
      0.5
    );
    const lampX = 0.36;
    const lampY = 1.66;
    builder.add(
      frameMat,
      subdividedRoundedBox(0.085, 0.1, 0.13, 0.02, 3, 3, 3),
      {
        p: [lampX + 0.045, lampY, side * 0.47]
      },
      0.45
    );
    builder.add(
      game.mats.emissive(0xfff0d2, 0.7),
      roundedBoxGeometry(0.006, 0.075, 0.105, 0.002),
      {
        p: [lampX + 0.089, lampY, side * 0.47]
      },
      1,
      {
        raw: true
      }
    );
    builder.add(
      frameMat,
      cylinderBetween([0.385, 1.5, side * 0.42], [0.42, 1.52, side * 0.57], 0.008, 5),
      null,
      0.5
    );
    builder.add(
      frameMat,
      roundedBoxGeometry(0.022, 0.17, 0.1, 0.006),
      {
        p: [0.42, 1.52, side * 0.573],
        r: [0, side * 0.25, 0]
      },
      0.5
    );
    builder.add(
      'steel_bare',
      worldUvBox(0.002, 0.15, 0.084),
      {
        p: [0.408, 1.52, side * 0.57],
        r: [0, side * 0.25, 0]
      },
      1
    );
    guardColliders.push(
      {
        min: [-1.03, 1, side > 0 ? 0.41 : -0.5],
        max: [-0.92, guardTopY, side > 0 ? 0.5 : -0.41],
        surface: 'metal'
      },
      {
        min: [0.24, 1.08, side > 0 ? 0.37 : -0.5],
        max: [0.5, guardTopY, side > 0 ? 0.5 : -0.37],
        surface: 'metal'
      }
    );
  }
  for (const railX of [0.28, -0.96]) {
    builder.add(
      frameMat,
      roundedBoxGeometry(0.05, 0.06, 0.92, 0.01),
      {
        p: [railX, guardTopY, 0]
      },
      frameTint()
    );
  }
  for (let slat = 0; slat < 8; slat++) {
    builder.add(
      frameMat,
      roundedBoxGeometry(0.03, 0.028, 0.9, 0.006),
      {
        p: [-0.83 + slat * 0.139, guardTopY + 0.012, 0]
      },
      frameTint()
    );
  }
  builder.add(
    frameMat,
    tubeThroughPoints(
      [
        [0.44, 1.2, 0.44],
        [0.47, 1.25, 0.49],
        [0.41, 1.55, 0.5],
        [0.36, 1.6, 0.455]
      ],
      0.011,
      5,
      false,
      0.5
    ),
    null,
    0.5
  );
  // Amber beacon.
  builder.add(
    frameMat,
    worldUvCylinder(0.045, 0.05, 0.03, 10),
    {
      p: [-0.86, guardTopY + 0.045, 0.3]
    },
    0.5
  );
  builder.add(
    game.mats.emissive(0xff8a12, 0.9),
    smoothLatheGeometry(
      [
        [0.04, 0],
        [0.04, 0.06],
        [0.03, 0.082],
        [0, 0.09]
      ],
      10
    ),
    {
      p: [-0.86, guardTopY + 0.06, 0.3]
    },
    1,
    {
      raw: true
    }
  );

  // LPG tank on the counterweight.
  const tankX = -1.4;
  const tankY = 1.23 + 0.05 + 0.155;
  for (const cradleZ of [-0.2, 0.2]) {
    builder.add(
      frameMat,
      roundedBoxGeometry(0.3, 0.07, 0.04, 0.008),
      {
        p: [tankX, 1.262, cradleZ]
      },
      0.5
    );
    builder.add(
      frameMat,
      worldUvCylinder(0.159, 0.159, 0.035, 16, true),
      {
        p: [tankX, tankY, cradleZ],
        r: [HALF_PI, 0, 0]
      },
      0.35
    );
  }
  builder.add(
    'steel_galv',
    smoothLatheGeometry(
      [
        [0, -0.37],
        [0.08, -0.36],
        [0.132, -0.33],
        [0.155, -0.27],
        [0.155, 0.27],
        [0.132, 0.33],
        [0.08, 0.36],
        [0, 0.37]
      ],
      16
    ),
    {
      p: [tankX, tankY, 0],
      r: [HALF_PI, 0, 0]
    },
    (px: number, py: number, pz: number) => 0.8 + 0.2 * valueNoise3d(px * 8, py * 8, pz * 8)
  );
  builder.add(
    'steel_galv',
    worldUvCylinder(0.09, 0.09, 0.07, 12, true),
    {
      p: [tankX, tankY, 0.39],
      r: [HALF_PI, 0, 0]
    },
    0.7
  );
  builder.add(
    'steel_galv',
    worldUvCylinder(0.02, 0.02, 0.05, 8),
    {
      p: [tankX, tankY, 0.39],
      r: [HALF_PI, 0, 0]
    },
    0.9
  );
  builder.add(
    'rubber',
    tubeThroughPoints(
      [
        [tankX, tankY, 0.41],
        [tankX + 0.05, tankY - 0.02, 0.46],
        [tankX + 0.2, tankY - 0.15, 0.44],
        [-1.07, 1.1, 0.38],
        [-1, 0.98, 0.36]
      ],
      0.012,
      5,
      false,
      0.5
    ),
    null,
    1
  );
  builder.push({
    p: [tankX, tankY, 0],
    r: [0, 0, 0.7]
  });
  builder.cdecal(game.mats.decal('hazard_flammable'), 0.157, 0.12, {
    p: [0, 0, -0.05],
    r: [-HALF_PI, 0, 0]
  });
  builder.cdecal(
    game.mats.label('LPG', {
      color: 'red',
      font: 'stencil',
      distress: 0.3
    }),
    0.157,
    0.16,
    {
      p: [0, 0, 0.14],
      r: [-HALF_PI, 0, 0]
    }
  );
  builder.pop();

  // Mast: outer channels, inner rails, lift chains.
  const mastInnerX = 0.6;
  const mastOuterX = 0.73;
  const mastHalfWidth = 0.375;
  const mastBottom = 0.08;
  const mastTop = 2.02;
  for (const side of [1, -1]) {
    const channelZ = side * mastHalfWidth;
    const channelProfile: Vec2[] = [
      [mastInnerX, channelZ],
      [mastOuterX, channelZ],
      [mastOuterX, channelZ - side * 0.065],
      [mastOuterX - 0.014, channelZ - side * 0.065],
      [mastOuterX - 0.014, channelZ - side * 0.014],
      [mastInnerX + 0.014, channelZ - side * 0.014],
      [mastInnerX + 0.014, channelZ - side * 0.065],
      [mastInnerX, channelZ - side * 0.065]
    ];
    builder.add(
      frameMat,
      extrudePolygon(
        ensureCounterClockwise(channelProfile.map((point): Vec2 => [point[0], -point[1]])),
        mastTop - mastBottom,
        {
          soft: 0
        }
      ),
      {
        p: [0, (mastBottom + mastTop) / 2, 0],
        r: [-HALF_PI, 0, 0]
      },
      frameTint()
    );
    builder.add(
      frameMat,
      roundedBoxGeometry(0.085, 1.86, 0.036, 0.006),
      {
        p: [0.665, 0.13 + mastExtension + 0.93, side * 0.335]
      },
      frameTint() * 1.25
    );
    builder.decal(game.mats.decal('hazard_general'), 0.1, {
      p: [0.665, 1.3, side * (mastHalfWidth + 0.002)],
      r: [0, side > 0 ? 0 : PI, 0]
    });
    // Tilt cylinder.
    const tiltBase: Vec3 = [0.36, 0.66, side * 0.3];
    const tiltEnd: Vec3 = [0.6, 0.86, side * 0.33];
    const tiltMid: Vec3 = [0.5, 0.777, side * 0.317];
    builder.add(frameMat, cylinderBetween(tiltBase, tiltMid, 0.034, 8, true), null, 0.55);
    builder.add('steel_bare', cylinderBetween(tiltMid, tiltEnd, 0.018, 6), null, 1);
    // Lift chain looped over the sheave.
    const chainZ = side * 0.13;
    const sheaveY = 1.9 + mastExtension;
    const sheaveRadius = 0.055;
    const chainPath: Vec3[] = [
      [0.725, 0.5 + liftHeight, chainZ],
      [0.725, sheaveY, chainZ]
    ];
    for (let angle = 0.5; angle < PI; angle += 0.55)
      chainPath.push([
        0.67 + Math.cos(angle) * sheaveRadius,
        sheaveY + Math.sin(angle) * sheaveRadius,
        chainZ
      ]);
    chainPath.push([0.615, sheaveY, chainZ], [0.615, 1, chainZ]);
    let linkIndex = 0;
    for (let segment = 0; segment < chainPath.length - 1; segment++) {
      const start = chainPath[segment];
      const end = chainPath[segment + 1];
      const segmentLength = Math.hypot(end[0] - start[0], end[1] - start[1]);
      const linkCount = Math.max(1, Math.round(segmentLength / 0.058));
      for (let link = 0; link < linkCount; link++, linkIndex++) {
        const linkStart = link / linkCount;
        const linkEnd = (link + 0.86) / linkCount;
        const lerpPoint = (t: number): Vec3 => [
          start[0] + (end[0] - start[0]) * t,
          start[1] + (end[1] - start[1]) * t,
          chainZ
        ];
        builder.add(
          'steel_worn',
          beamBetweenPoints(
            lerpPoint(linkStart),
            lerpPoint(linkEnd),
            0.011,
            linkIndex % 2 ? 0.034 : 0.022,
            0,
            true
          ),
          null,
          linkIndex % 2 ? 0.55 : 0.75
        );
      }
    }
    builder.add(
      frameMat,
      worldUvCylinder(sheaveRadius - 0.006, sheaveRadius - 0.006, 0.04, 12),
      {
        p: [0.67, sheaveY, chainZ],
        r: [HALF_PI, 0, 0]
      },
      0.7
    );
  }
  builder.add(
    frameMat,
    roundedBoxGeometry(0.04, 0.09, 0.78, 0.008),
    {
      p: [mastInnerX - 0.012, 1.96, 0]
    },
    frameTint()
  );
  builder.add(
    frameMat,
    roundedBoxGeometry(0.04, 0.12, 0.78, 0.008),
    {
      p: [mastInnerX - 0.012, 0.42, 0]
    },
    frameTint()
  );
  builder.add(
    frameMat,
    roundedBoxGeometry(0.07, 0.09, 0.66, 0.008),
    {
      p: [0.665, 1.99 + mastExtension, 0]
    },
    frameTint()
  );
  // Main lift cylinder.
  builder.add(
    frameMat,
    worldUvCylinder(0.048, 0.048, 1.15, 10),
    {
      p: [0.645, 0.72, 0]
    },
    0.6
  );
  builder.add(
    frameMat,
    worldUvCylinder(0.055, 0.055, 0.05, 10),
    {
      p: [0.645, 1.3, 0]
    },
    0.5
  );
  builder.add(
    'steel_bare',
    worldUvCylinder(0.027, 0.027, 0.64 + mastExtension, 8, true),
    {
      p: [0.645, 1.31 + (0.64 + mastExtension) / 2, 0]
    },
    1
  );
  builder.label(
    'MAX 2500 kg',
    {
      color: 'yellow',
      font: 'stencil',
      distress: 0.3
    },
    0.5,
    0.05,
    {
      p: [mastInnerX - 0.033, 0.42, 0],
      r: [0, -HALF_PI, 0]
    }
  );
  // Hydraulic hoses over the mast.
  for (const hoseZ of [0.21, 0.245]) {
    builder.add(
      'rubber',
      tubeThroughPoints(
        [
          [0.6, 1.25, hoseZ],
          [0.59, 1.65 + mastExtension * 0.6, hoseZ],
          [0.655, 1.86 + mastExtension, hoseZ + 0.005],
          [0.735, 1.6 + mastExtension * 1.2, hoseZ],
          [0.74, 0.56 + liftHeight, hoseZ]
        ],
        0.011,
        5,
        false,
        0.5
      ),
      null,
      1
    );
  }

  // Fork carriage and forks (raised by `liftHeight`).
  builder.push({
    p: [0, liftHeight, 0]
  });
  const carriageBase = 0.06;
  for (const barY of [carriageBase + 0.12, carriageBase + 0.5]) {
    builder.add(
      frameMat,
      roundedBoxGeometry(0.04, 0.1, 1.02, 0.008),
      {
        p: [0.755, barY, 0]
      },
      frameTint()
    );
  }
  builder.add(
    'hazard_stripes',
    worldUvBox(0.003, 0.06, 0.4),
    {
      p: [0.7765, carriageBase + 0.5, 0]
    },
    0.9
  );
  for (const side of [1, -1]) {
    builder.add(
      frameMat,
      roundedBoxGeometry(0.03, 0.5, 0.06, 0.006),
      {
        p: [0.745, carriageBase + 0.31, side * 0.3]
      },
      frameTint()
    );
    builder.add(
      frameMat,
      roundedBoxGeometry(0.11, 0.36, 0.022, 0.005),
      {
        p: [0.685, carriageBase + 0.31, side * 0.305]
      },
      frameTint()
    );
    builder.add(
      frameMat,
      roundedBoxGeometry(0.03, 0.78, 0.04, 0.006),
      {
        p: [0.755, carriageBase + 0.94, side * 0.5]
      },
      frameTint()
    );
    builder.add(
      'steel_worn',
      worldUvCylinder(0.04, 0.04, 0.03, 10),
      {
        p: [0.67, carriageBase + 0.2, side * 0.325],
        r: [HALF_PI, 0, 0]
      },
      0.7
    );
  }
  // Load backrest.
  builder.add(
    frameMat,
    roundedBoxGeometry(0.03, 0.04, 1.04, 0.006),
    {
      p: [0.755, carriageBase + 1.33, 0]
    },
    frameTint()
  );
  builder.add(
    frameMat,
    roundedBoxGeometry(0.02, 0.03, 1, 0.004),
    {
      p: [0.755, carriageBase + 0.94, 0]
    },
    frameTint()
  );
  for (let bar = -2; bar <= 2; bar++) {
    builder.add(
      frameMat,
      roundedBoxGeometry(0.02, 0.76, 0.02, 0.004),
      {
        p: [0.755, carriageBase + 0.94, bar * 0.165]
      },
      frameTint()
    );
  }
  const forkBaseY = 0.035;
  for (const side of [1, -1]) {
    const fork = extrudePolygon(
      [
        [0.777, forkBaseY],
        [1.45, forkBaseY],
        [1.7, forkBaseY + 0.006],
        [1.7, forkBaseY + 0.016],
        [0.87, forkBaseY + 0.046],
        [0.826, forkBaseY + 0.075],
        [0.822, forkBaseY + 0.62],
        [0.777, forkBaseY + 0.62]
      ],
      0.1,
      {
        soft: 0.45
      }
    );
    builder.add(
      'steel_worn',
      fork,
      {
        p: [0, 0, side * 0.26]
      },
      (px: number, _py: number, pz: number) => {
        const wear = clamp((px - 0.8) / 0.9, 0, 1);
        const noise = valueNoise3d(px * 14, pz * 30 + side);
        return (0.5 + 0.5 * wear) * (0.8 + 0.2 * noise);
      }
    );
    builder.add(
      frameMat,
      roundedBoxGeometry(0.075, 0.05, 0.112, 0.006),
      {
        p: [0.772, carriageBase + 0.575, side * 0.26]
      },
      0.55
    );
    builder.add(
      frameMat,
      roundedBoxGeometry(0.03, 0.04, 0.112, 0.006),
      {
        p: [0.79, carriageBase + 0.07, side * 0.26]
      },
      0.55
    );
  }
  builder.pop();

  const height = Math.max(2.2, 0.06 + liftHeight + 1.36, 2.04 + mastExtension);
  return builder.finish({
    size: [3.4, height, 1.25],
    colliders: [
      {
        min: [-1.7, 0, -0.6],
        max: [0.58, 1.24, 0.6],
        surface: 'metal'
      },
      {
        min: [-1.56, 1.24, -0.4],
        max: [-1.22, 1.6, 0.4],
        surface: 'metal'
      },
      {
        min: [-0.88, 1.24, -0.24],
        max: [-0.7, 1.66, 0.24],
        surface: 'rubber'
      },
      {
        min: [0.56, 0, -0.42],
        max: [0.78, 2.04 + mastExtension, 0.42],
        surface: 'metal'
      },
      {
        min: [0.72, liftHeight, -0.53],
        max: [0.8, liftHeight + 1.42, 0.53],
        surface: 'metal'
      },
      {
        min: [0.8, liftHeight, -0.33],
        max: [1.7, liftHeight + 0.1, 0.33],
        surface: 'metal'
      },
      {
        min: [-1.02, 2, -0.5],
        max: [0.32, 2.1, 0.5],
        surface: 'metal'
      },
      ...guardColliders
    ]
  });
}

/** Skid-mounted diesel generator with louvred panels, control panel and exhaust. */
function buildGenerator(game: Game, options: MachineryPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'generator', options.seed || 0);
  const rng = builder.rng;
  const [paintMat, paintTint] = paintMaterialFor(options.color, 'yellow');
  const tint = makePaintTint(paintTint);
  const darkMat = 'steel_dark';
  const halfDepth = 0.46;
  const halfLength = 1.03;
  const bodyBottom = 0.3;
  const bodyTop = 1.16;
  const bodyMidY = (bodyBottom + bodyTop) / 2;

  // Skid frame.
  for (const side of [1, -1]) {
    builder.add(
      darkMat,
      roundedBoxGeometry(2.2, 0.14, 0.1, 0.012),
      {
        p: [0, 0.07, side * 0.4]
      },
      0.6
    );
    for (const pocketX of [-0.45, 0.45]) {
      builder.add(
        darkMat,
        worldUvBox(0.22, 0.075, 0.004),
        {
          p: [pocketX, 0.075, side * 0.451]
        },
        0.12
      );
    }
  }
  for (const crossX of [-0.85, 0, 0.85]) {
    builder.add(
      darkMat,
      worldUvBox(0.1, 0.1, 0.72),
      {
        p: [crossX, 0.07, 0]
      },
      0.55
    );
  }
  builder.add(
    darkMat,
    roundedBoxGeometry(2.1, 0.17, 0.94, 0.012),
    {
      p: [0, 0.215, 0]
    },
    0.8
  );

  // Enclosure and roof.
  builder.add(
    paintMat,
    roundedBoxGeometry(2.06, bodyTop - bodyBottom, halfDepth * 2, 0.025),
    {
      p: [0, bodyMidY, 0]
    },
    tint()
  );
  builder.add(
    paintMat,
    roundedBoxGeometry(2.13, 0.045, 0.99, 0.014),
    {
      p: [0, bodyTop + 0.02, 0]
    },
    tint(0.9)
  );
  for (const ribX of [-0.52, 0.52]) {
    builder.add(
      paintMat,
      worldUvBox(0.04, 0.012, 0.95),
      {
        p: [ribX, bodyTop + 0.046, 0]
      },
      tint(0.85)
    );
  }

  // Side access doors with latches, hinges and louvres.
  for (const side of [1, -1]) {
    const faceYaw = side > 0 ? 0 : PI;
    [-0.66, 0, 0.66].forEach((doorX, doorIndex) => {
      builder.add(
        paintMat,
        roundedBoxGeometry(0.62, 0.72, 0.012, 0.006),
        {
          p: [doorX, bodyMidY + 0.01, side * (halfDepth + 0.004)]
        },
        tint(rng.range(0.9, 1))
      );
      builder.add(
        darkMat,
        worldUvBox(0.03, 0.11, 0.016),
        {
          p: [doorX + 0.27, bodyMidY, side * (halfDepth + 0.012)]
        },
        0.6
      );
      builder.add(
        'steel_galv',
        worldUvBox(0.012, 0.03, 0.006),
        {
          p: [doorX + 0.27, bodyMidY + 0.03, side * (halfDepth + 0.022)]
        },
        0.8
      );
      for (const hingeY of [-0.25, 0.25]) {
        builder.add(
          'steel_galv',
          worldUvCylinder(0.009, 0.009, 0.06, 5, true),
          {
            p: [doorX - 0.305, bodyMidY + hingeY, side * (halfDepth + 0.012)]
          },
          0.7
        );
      }
      if (doorIndex > 0) {
        const louvreCount = doorIndex === 2 ? 8 : 5;
        const louvreWidth = 0.42;
        const louvreY = doorIndex === 2 ? bodyMidY + 0.14 : bodyMidY - 0.16;
        builder.add(
          darkMat,
          worldUvBox(louvreWidth, louvreCount * 0.05, 0.004),
          {
            p: [doorX - 0.03, louvreY, side * (halfDepth + 0.0105)]
          },
          0.12
        );
        for (let louvre = 0; louvre < louvreCount; louvre++) {
          builder.add(
            paintMat,
            worldUvBox(louvreWidth, 0.04, 0.005),
            {
              p: [
                doorX - 0.03,
                louvreY + (louvre - (louvreCount - 1) / 2) * 0.05,
                side * (halfDepth + 0.018)
              ],
              r: [side * 0.6, 0, 0]
            },
            tint(0.82)
          );
        }
        if (doorIndex === 2) {
          builder.decal(game.mats.decal('rust_run'), 0.3, {
            p: [doorX - 0.03, louvreY - 0.36, side * (halfDepth + 0.011)],
            r: [0, faceYaw, 0]
          });
        }
      }
    });
    builder.label(
      options.label || 'GEN-0' + (1 + (builder.seed % 2)),
      {
        color: 'black',
        font: 'stencil',
        distress: 0.35
      },
      0.5,
      0.13,
      {
        p: [-0.66 * side, bodyMidY + 0.17, side * (halfDepth + 0.0108)],
        r: [0, faceYaw, 0]
      }
    );
    builder.decal(game.mats.decal('hazard_voltage'), 0.15, {
      p: [-0.66 * side - side * 0.18, bodyMidY - 0.17, side * (halfDepth + 0.0108)],
      r: [0, faceYaw, 0]
    });
  }

  // Radiator grille on the +X end.
  builder.add(
    darkMat,
    worldUvBox(0.004, 0.66, 0.74),
    {
      p: [halfLength + 0.001, bodyMidY, 0]
    },
    0.1
  );
  for (let slat = 0; slat < 11; slat++) {
    builder.add(
      paintMat,
      worldUvBox(0.006, 0.046, 0.74),
      {
        p: [halfLength + 0.012, bodyMidY - 0.3 + slat * 0.06, 0],
        r: [0, 0, -0.6]
      },
      tint(0.8)
    );
  }
  for (const side of [1, -1]) {
    builder.add(
      paintMat,
      worldUvBox(0.03, 0.72, 0.03),
      {
        p: [halfLength + 0.012, bodyMidY, side * 0.385]
      },
      tint(0.9)
    );
    builder.add(
      paintMat,
      worldUvBox(0.03, 0.03, 0.8),
      {
        p: [halfLength + 0.012, bodyMidY + side * 0.345, 0]
      },
      tint(0.9)
    );
  }

  // Control panel on the -X end with hood, display, lamps and switches.
  const panelX = -halfLength - 0.004;
  const panelZ = 0.14;
  builder.add(
    darkMat,
    roundedBoxGeometry(0.01, 0.44, 0.52, 0.004),
    {
      p: [panelX, 0.87, panelZ]
    },
    0.45
  );
  builder.add(
    paintMat,
    roundedBoxGeometry(0.075, 0.014, 0.56, 0.004),
    {
      p: [panelX - 0.03, 1.1, panelZ],
      r: [0, 0, 0.12]
    },
    tint(0.9)
  );
  for (const side of [1, -1]) {
    builder.add(
      paintMat,
      worldUvBox(0.06, 0.44, 0.012),
      {
        p: [panelX - 0.025, 0.87, panelZ + side * 0.268]
      },
      tint(0.9)
    );
  }
  const panelFaceX = panelX - 0.0055;
  const facingNegX: Vec3 = [0, -HALF_PI, 0];
  builder.add(
    game.mats.emissive(0x86e3a8, 0.32),
    flatPlaneGeometry(0.13, 0.07),
    {
      p: [panelFaceX - 0.001, 0.99, panelZ - 0.12],
      r: facingNegX
    },
    1,
    {
      raw: true,
      cast: false
    }
  );
  builder.add(
    darkMat,
    roundedBoxGeometry(0.008, 0.09, 0.15, 0.003),
    {
      p: [panelFaceX + 0.003, 0.99, panelZ - 0.12]
    },
    0.3
  );
  builder.add(
    'steel_galv',
    worldUvCylinder(0.02, 0.02, 0.012, 10),
    {
      p: [panelFaceX - 0.004, 1, panelZ + 0.19],
      r: [0, 0, HALF_PI]
    },
    0.7
  );
  builder.add(
    game.mats.emissive(0x3dff6a, 3.2),
    worldUvCylinder(0.013, 0.013, 0.014, 10),
    {
      p: [panelFaceX - 0.009, 1, panelZ + 0.19],
      r: [0, 0, HALF_PI]
    },
    1,
    {
      raw: true
    }
  );
  // Emergency stop button.
  builder.add(
    paintMat,
    worldUvCylinder(0.042, 0.042, 0.006, 12),
    {
      p: [panelFaceX - 0.003, 0.8, panelZ + 0.17],
      r: [0, 0, HALF_PI]
    },
    1
  );
  builder.add(
    'plastic_red',
    smoothLatheGeometry(
      [
        [0, 0],
        [0.018, 0],
        [0.018, 0.018],
        [0.03, 0.02],
        [0.03, 0.034],
        [0.02, 0.042],
        [0, 0.044]
      ],
      10
    ),
    {
      p: [panelFaceX - 0.004, 0.8, panelZ + 0.17],
      r: [0, 0, HALF_PI]
    },
    0.95
  );
  // Analogue gauges.
  for (let gauge = 0; gauge < 3; gauge++) {
    const gaugeZ = panelZ - 0.2 + gauge * 0.105;
    builder.add(
      'aluminium',
      worldUvCylinder(0.04, 0.042, 0.012, 10),
      {
        p: [panelFaceX - 0.004, 0.86, gaugeZ],
        r: [0, 0, HALF_PI]
      },
      0.8
    );
    builder.add(
      'aluminium',
      worldUvCylinder(0.034, 0.034, 0.002, 10),
      {
        p: [panelFaceX - 0.0105, 0.86, gaugeZ],
        r: [0, 0, HALF_PI]
      },
      1
    );
    builder.add(
      darkMat,
      worldUvBox(0.002, 0.028, 0.004),
      {
        p: [panelFaceX - 0.0125, 0.868, gaugeZ + 0.005],
        r: [rng.range(-1, 1), 0, 0]
      },
      0.3
    );
  }
  // Toggle switches.
  for (let toggle = 0; toggle < 5; toggle++) {
    builder.add(
      toggle === 0 ? 'plastic_red' : darkMat,
      worldUvBox(0.014, 0.04, 0.022),
      {
        p: [panelFaceX - 0.006, 0.74, panelZ - 0.2 + toggle * 0.03],
        r: [0, 0, rng() < 0.5 ? 0.25 : -0.25]
      },
      0.8
    );
  }
  builder.decal(game.mats.decal('hazard_voltage'), 0.13, {
    p: [-halfLength - 0.002, 0.95, -0.28],
    r: facingNegX
  });
  builder.label(
    'DANGER',
    {
      color: 'red',
      font: 'stencil',
      distress: 0.3
    },
    0.22,
    0.05,
    {
      p: [-halfLength - 0.002, 0.82, -0.28],
      r: facingNegX
    }
  );

  // Power outlets (one with a cable snaking off along the ground).
  const outlets: [string, number][] = [
    ['plastic_red', 0.02],
    ['plastic_blue', 0.2],
    ['plastic_blue', -0.25]
  ];
  for (const [outletMat, outletZ] of outlets) {
    builder.add(
      darkMat,
      roundedBoxGeometry(0.02, 0.12, 0.1, 0.006),
      {
        p: [-halfLength - 0.008, 0.5, outletZ]
      },
      0.4
    );
    builder.add(
      outletMat,
      cylinderBetween(
        [-halfLength - 0.01, 0.5, outletZ],
        [-halfLength - 0.06, 0.47, outletZ],
        0.036,
        10,
        true
      ),
      null,
      0.9
    );
  }
  builder.add(
    'plastic_blue',
    cylinderBetween(
      [-halfLength - 0.06, 0.47, 0.2],
      [-halfLength - 0.068, 0.39, 0.2],
      0.03,
      8,
      true,
      0.02
    ),
    null,
    0.85
  );
  builder.add(
    'rubber',
    tubeThroughPoints(
      [
        [-halfLength - 0.066, 0.4, 0.2],
        [-halfLength - 0.064, 0.25, 0.21],
        [-halfLength - 0.05, 0.06, 0.26],
        [-halfLength + 0.05, 0.016, 0.4],
        [-halfLength + 0.3, 0.016, 0.478],
        [-0.35, 0.016, 0.486]
      ],
      0.014,
      5,
      false,
      0.5
    ),
    null,
    1
  );

  // Lifting eye on the roof.
  const roofY = bodyTop + 0.0425;
  builder.add(
    darkMat,
    roundedBoxGeometry(0.2, 0.012, 0.14, 0.004),
    {
      p: [0, roofY + 0.004, 0]
    },
    0.6
  );
  builder.add(
    'steel_galv',
    metricTorusGeometry(0.045, 0.014, 5, 10),
    {
      p: [0, roofY + 0.058, 0]
    },
    0.7
  );

  // Rusty exhaust stack with rain cap and soot.
  const exhaustPos: Vec3 = [0.72, roofY, 0.24];
  builder.add(
    'steel_rust',
    worldUvCylinder(0.062, 0.066, 0.025, 12),
    {
      p: [exhaustPos[0], roofY + 0.012, exhaustPos[2]]
    },
    0.6
  );
  builder.add(
    'steel_rust',
    worldUvCylinder(0.04, 0.04, 0.17, 12, true),
    {
      p: [exhaustPos[0], roofY + 0.085, exhaustPos[2]]
    },
    (_px: number, py: number) => 0.45 + 0.55 * clamp((roofY + 0.17 - py) / 0.17, 0, 1)
  );
  builder.add(
    'steel_rust',
    worldUvCylinder(0.034, 0.034, 0.002, 10),
    {
      p: [exhaustPos[0], roofY + 0.15, exhaustPos[2]]
    },
    0.08
  );
  builder.add(
    'steel_rust',
    worldUvCylinder(0.046, 0.046, 0.005, 12),
    {
      p: [exhaustPos[0] - 0.012, roofY + 0.186, exhaustPos[2]],
      r: [0, 0, 0.5]
    },
    0.6
  );
  builder.decal(game.mats.decal('scorch'), 0.3, {
    p: [exhaustPos[0], roofY + 0.001, exhaustPos[2]],
    r: [-HALF_PI, 0, 0]
  });

  // Fuel filler.
  builder.add(
    darkMat,
    cylinderBetween([-0.72, 0.25, 0.46], [-0.72, 0.32, 0.5], 0.03, 8, true),
    null,
    0.6
  );
  builder.add(
    'plastic_red',
    cylinderBetween([-0.72, 0.32, 0.5], [-0.72, 0.338, 0.51], 0.037, 10, true),
    null,
    0.9
  );
  builder.decal(game.mats.decal('hazard_flammable'), 0.11, {
    p: [-0.52, 0.215, 0.4712]
  });
  builder.label(
    'DIESEL',
    {
      color: 'white',
      font: 'stencil',
      distress: 0.4
    },
    0.2,
    0.05,
    {
      p: [-0.34, 0.215, 0.4712]
    }
  );
  return builder.finish({
    colliders: [
      {
        min: [-1.1, 0, -0.5],
        max: [1.1, 1.21, 0.5],
        surface: 'metal'
      }
    ]
  });
}

/** Wheeled skip/dumpster with tapered body, plastic lids and spilled rubbish bags. */
function buildDumpster(game: Game, options: MachineryPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'dumpster', options.seed || 0);
  const rng = builder.rng;
  const [paintMat, paintTint] = paintMaterialFor(options.color, 'green');
  const tint = makePaintTint(paintTint);
  const halfWidth = 0.89;
  const floorY = 0.2;
  const rimY = 1.12;
  const frontBottomZ = 0.3;
  const frontTopZ = 0.5;
  const backBottomZ = -0.44;
  const backTopZ = -0.5;
  const wallThickness = 0.022;
  // Side profile (Z/Y) of the tub, outer outline then inner outline.
  const tubProfile: Vec2[] = [
    [-frontTopZ, rimY],
    [-frontBottomZ, floorY],
    [-backBottomZ, floorY],
    [-backTopZ, rimY],
    [-backTopZ - wallThickness, rimY],
    [-backBottomZ - wallThickness * 0.8, floorY + wallThickness],
    [-frontBottomZ + wallThickness * 0.8, floorY + wallThickness],
    [-frontTopZ + wallThickness, rimY]
  ];
  const noiseOffset = builder.seed * 2.3;
  builder.add(
    paintMat,
    extrudePolygon(tubProfile, halfWidth * 2, {
      soft: 0
    }),
    {
      r: [0, HALF_PI, 0]
    },
    (px: number, py: number, pz: number) => {
      // Unused (kept from the original): whether the vertex lies on a flat panel.
      const onPanel =
        Math.abs(pz) < 0.4 &&
        py > floorY + 0.01 &&
        py < rimY - 0.01 &&
        Math.abs(px) < halfWidth - 0.01;
      return tint(0.9 + 0.1 * valueNoise3d(px * 3 + noiseOffset, py * 3));
    }
  );

  // End walls, rims, stiffeners and lifting trunnions.
  for (const side of [1, -1]) {
    builder.add(
      paintMat,
      extrudePolygon(
        [
          [-frontTopZ, rimY],
          [-frontBottomZ, floorY],
          [-backBottomZ, floorY],
          [-backTopZ, rimY]
        ],
        wallThickness,
        {
          soft: 0
        }
      ),
      {
        p: [side * (halfWidth - wallThickness / 2), 0, 0],
        r: [0, HALF_PI, 0]
      },
      tint(0.95)
    );
    builder.add(
      paintMat,
      roundedBoxGeometry(0.05, 0.045, frontTopZ - backTopZ + 0.04, 0.008),
      {
        p: [side * halfWidth, rimY, 0]
      },
      tint(0.9)
    );
    for (const stiffenerZ of [-0.22, 0.14]) {
      builder.add(
        paintMat,
        roundedBoxGeometry(0.03, 0.84, 0.05, 0.006),
        {
          p: [side * (halfWidth + 0.012), 0.66, stiffenerZ]
        },
        tint(0.9)
      );
    }
    builder.add(
      paintMat,
      roundedBoxGeometry(0.035, 0.1, 0.84, 0.008),
      {
        p: [side * (halfWidth + 0.014), 0.93, 0]
      },
      tint(0.85)
    );
    builder.add(
      'steel_worn',
      cylinderBetween(
        [side * (halfWidth + 0.01), 0.93, 0.3],
        [side * (halfWidth + 0.065), 0.93, 0.3],
        0.03,
        10,
        true
      ),
      null,
      0.7
    );
    builder.add(
      'steel_worn',
      worldUvCylinder(0.042, 0.042, 0.008, 10),
      {
        p: [side * (halfWidth + 0.064), 0.93, 0.3],
        r: [0, 0, HALF_PI]
      },
      0.6
    );
  }
  builder.add(
    paintMat,
    roundedBoxGeometry(halfWidth * 2 + 0.04, 0.045, 0.05, 0.008),
    {
      p: [0, rimY, frontTopZ]
    },
    tint(0.9)
  );
  builder.add(
    paintMat,
    roundedBoxGeometry(halfWidth * 2 + 0.04, 0.045, 0.05, 0.008),
    {
      p: [0, rimY, backTopZ]
    },
    tint(0.9)
  );

  // Ribs on the sloped front/back faces.
  const frontSlope = Math.atan2(frontTopZ - frontBottomZ, rimY - floorY);
  const backSlope = Math.atan2(backTopZ - backBottomZ, rimY - floorY);
  for (const ribX of [-0.6, -0.2, 0.2, 0.6]) {
    builder.add(
      paintMat,
      beamBetweenPoints(
        [ribX, floorY + 0.03, frontBottomZ + 0.022],
        [ribX, rimY - 0.04, frontTopZ + 0.012],
        0.055,
        0.03,
        0.006
      ),
      null,
      tint(0.9)
    );
    builder.add(
      paintMat,
      beamBetweenPoints(
        [ribX, floorY + 0.03, backBottomZ - 0.016],
        [ribX, rimY - 0.04, backTopZ - 0.012],
        0.055,
        0.03,
        0.006
      ),
      null,
      tint(0.9)
    );
  }
  builder.add(
    paintMat,
    beamBetweenPoints(
      [
        -halfWidth,
        floorY + 0.5,
        frontBottomZ + 0.022 + (0.5 * (frontTopZ - frontBottomZ)) / (rimY - floorY)
      ],
      [
        halfWidth,
        floorY + 0.5,
        frontBottomZ + 0.022 + (0.5 * (frontTopZ - frontBottomZ)) / (rimY - floorY)
      ],
      0.03,
      0.06,
      0.006
    ),
    {
      r: [0, 0, 0]
    },
    tint(0.88)
  );

  // Labels and grime decals on the sloped front face.
  const frontFaceZ = (y: number) =>
    frontBottomZ + ((y - floorY) * (frontTopZ - frontBottomZ)) / (rimY - floorY) + 0.003;
  builder.label(
    options.label || 'B4 WASTE ' + (11 + (builder.seed % 2)),
    {
      color: 'white',
      font: 'stencil',
      distress: 0.5
    },
    0.36,
    0.09,
    {
      p: [-0.4, 0.93, frontFaceZ(0.93)],
      r: [-frontSlope, 0, 0]
    }
  );
  builder.decal(game.mats.decal('grime_streak'), 0.36, {
    p: [0.4, 0.82, frontFaceZ(0.82)],
    r: [-frontSlope, 0, 0]
  });
  builder.decal(game.mats.decal('rust_run'), 0.3, {
    p: [0, 0.5, frontFaceZ(0.5)],
    r: [-frontSlope, 0, 0]
  });
  builder.decal(game.mats.decal('logo_c'), 0.26, {
    p: [0.4, 0.42, frontFaceZ(0.42)],
    r: [-frontSlope, 0, 0]
  });
  builder.decal(game.mats.decal('leak_stain'), 0.34, {
    p: [-0.4, 0.45, frontFaceZ(0.45)],
    r: [-frontSlope, 0, 0]
  });

  // Lid hinge bar and two plastic lids (one closed, one flipped open).
  const hingeY = rimY + 0.045;
  const hingeZ = backTopZ - 0.02;
  builder.add(
    'steel_galv',
    cylinderBetween(
      [-halfWidth - 0.02, hingeY, hingeZ],
      [halfWidth + 0.02, hingeY, hingeZ],
      0.013,
      6,
      true
    ),
    null,
    0.7
  );
  const addLid = (lidX: number, openAngle: number): void => {
    builder.push({
      p: [lidX, hingeY, hingeZ],
      r: [openAngle, 0, 0]
    });
    const lidDepth = 1.07;
    const lid = subdividedRoundedBox(0.885, 0.04, lidDepth, 0.016, 3, 3, 4);
    mapVertices(lid, (vertex: THREE.Vector3) => {
      if (vertex.y > 0)
        vertex.y +=
          0.018 * Math.cos((vertex.z / lidDepth) * PI) * Math.cos((vertex.x / 0.885) * PI);
    });
    lid.computeVertexNormals();
    const lidTint = rng.range(0.75, 0.95);
    builder.add(
      'plastic_grey',
      lid,
      {
        p: [0, 0.005, lidDepth / 2]
      },
      lidTint
    );
    for (const ribX of [-0.26, 0.26]) {
      builder.add(
        'plastic_grey',
        roundedBoxGeometry(0.07, 0.016, lidDepth - 0.16, 0.006),
        {
          p: [ribX, 0.036, lidDepth / 2]
        },
        lidTint * 0.9
      );
    }
    builder.add(
      'plastic_grey',
      roundedBoxGeometry(0.3, 0.035, 0.05, 0.01),
      {
        p: [0, 0.02, lidDepth + 0.01]
      },
      lidTint * 0.8
    );
    for (const hingeX of [-0.3, 0.3]) {
      builder.add(
        'plastic_grey',
        roundedBoxGeometry(0.08, 0.03, 0.09, 0.008),
        {
          p: [hingeX, 0.005, 0.03]
        },
        lidTint * 0.8
      );
    }
    builder.pop();
  };
  addLid(-0.45, 0);
  addLid(0.45, HALF_PI + 0.07 + rng.range(0, 0.05));

  // Rubbish bags poking out of the open half.
  const bags: [number, number, number, number][] = [
    [0.45, 0.93, 0.05, 1],
    [0.66, 0.9, -0.24, 0.8],
    [0.22, 0.86, -0.2, 0.85]
  ];
  for (const [bagX, bagY, bagZ, bagScale] of bags) {
    const bag = subdividedRoundedBox(
      0.46 * bagScale,
      0.4 * bagScale,
      0.42 * bagScale,
      0.17 * bagScale,
      3,
      3,
      3
    );
    const bagNoiseOffset = rng() * 20;
    mapVertices(bag, (vertex: THREE.Vector3) => {
      const lump = valueNoise3d(vertex.x * 9 + bagNoiseOffset, vertex.y * 9, vertex.z * 9) - 0.5;
      vertex.x += lump * 0.06;
      vertex.z += lump * 0.06;
      vertex.y += lump * 0.04;
    });
    builder.add(
      'polymer_black',
      computeWeldedNormals(bag),
      {
        p: [bagX, bagY, bagZ],
        r: [rng() * 0.5, rng() * 6, 0]
      },
      0.8
    );
  }
  builder.add(
    'cardboard',
    ribbonGeometry(
      [
        [0.2, 0.9, 0.2],
        [0.24, 1.14, 0.26],
        [0.3, 1.2, 0.33]
      ],
      [0.16, 0, -0.05]
    ),
    null,
    0.7
  );

  // Swivel castors.
  for (const castorX of [-0.7, 0.7]) {
    for (const castorZ of [-0.3, 0.17]) {
      builder.push({
        p: [castorX, 0, castorZ],
        r: [0, rng() * 6, 0]
      });
      builder.add(
        'steel_galv',
        roundedBoxGeometry(0.13, 0.012, 0.11, 0.003),
        {
          p: [0, 0.194, 0]
        },
        0.7
      );
      for (const forkSide of [1, -1]) {
        builder.add(
          'steel_galv',
          beamBetweenPoints(
            [0, 0.19, forkSide * 0.034],
            [0.035, 0.08, forkSide * 0.034],
            0.05,
            0.006,
            0,
            true
          ),
          null,
          0.65
        );
      }
      builder.add(
        'rubber',
        worldUvCylinder(0.08, 0.08, 0.045, 14),
        {
          p: [0.035, 0.08, 0],
          r: [HALF_PI, 0, 0]
        },
        0.9
      );
      builder.add(
        'steel_galv',
        worldUvCylinder(0.035, 0.035, 0.05, 8),
        {
          p: [0.035, 0.08, 0],
          r: [HALF_PI, 0, 0]
        },
        0.6
      );
      builder.pop();
    }
  }
  return builder.finish({
    colliders: [
      {
        min: [-0.95, 0.05, -0.56],
        max: [0.95, 1.2, 0.55],
        surface: 'metal'
      }
    ]
  });
}

/** Rolling mechanic's tool chest with drawers (one open), handle, castors and tools on top. */
function buildToolboxCart(game: Game, options: MachineryPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'toolbox_cart', options.seed || 0);
  const rng = builder.rng;
  const [paintMat, paintTint] = paintMaterialFor(options.color, 'red');
  const tint = makePaintTint(paintTint);
  const centerX = 0.04;
  const width = 0.74;
  const bodyBottom = 0.125;
  const bodyTop = 0.785;
  const halfDepth = 0.23;
  builder.add(
    paintMat,
    roundedBoxGeometry(width, bodyTop - bodyBottom, halfDepth * 2, 0.012),
    {
      p: [centerX, (bodyBottom + bodyTop) / 2, 0]
    },
    tint()
  );
  builder.add(
    'steel_dark',
    roundedBoxGeometry(width + 0.01, 0.02, halfDepth * 2 + 0.01, 0.006),
    {
      p: [centerX, bodyBottom + 0.004, 0]
    },
    0.5
  );

  // Drawers, top to bottom; one is pulled open, a few are slightly ajar.
  const drawerHeights = [0.075, 0.075, 0.1, 0.13, 0.19];
  const openDrawer = 1 + (builder.seed % 3);
  let drawerTop = bodyTop - 0.03;
  drawerHeights.forEach((drawerHeight, drawerIndex) => {
    const pullOut = drawerIndex === openDrawer ? 0.05 : rng() < 0.3 ? 0.004 : 0;
    const drawerY = drawerTop - drawerHeight / 2;
    builder.add(
      paintMat,
      roundedBoxGeometry(width - 0.05, drawerHeight - 0.01, 0.014, 0.004),
      {
        p: [centerX, drawerY, halfDepth + 0.005 + pullOut]
      },
      tint(rng.range(0.9, 1))
    );
    builder.add(
      'aluminium',
      roundedBoxGeometry(width - 0.09, 0.016, 0.016, 0.004),
      {
        p: [centerX, drawerY + drawerHeight / 2 - 0.02, halfDepth + 0.019 + pullOut]
      },
      0.85
    );
    if (pullOut > 0.01) {
      builder.add(
        'steel_dark',
        worldUvBox(width - 0.07, drawerHeight - 0.02, pullOut),
        {
          p: [centerX, drawerY, halfDepth + pullOut / 2]
        },
        0.4
      );
      builder.add(
        'polymer_black',
        worldUvBox(width - 0.08, 0.004, pullOut),
        {
          p: [centerX, drawerY + drawerHeight / 2 - 0.012, halfDepth + pullOut / 2]
        },
        0.3
      );
      for (let tool = 0; tool < 4; tool++) {
        builder.add(
          'steel_bare',
          cylinderBetween(
            [centerX - 0.25 + tool * 0.15, drawerY + drawerHeight / 2 - 0.016, halfDepth + 0.008],
            [
              centerX - 0.23 + tool * 0.15,
              drawerY + drawerHeight / 2 - 0.014,
              halfDepth + pullOut - 0.012
            ],
            0.007,
            5,
            true
          ),
          null,
          0.8
        );
      }
    }
    drawerTop -= drawerHeight;
  });

  // Lock, top mat and rim.
  builder.add(
    'steel_bare',
    worldUvCylinder(0.011, 0.011, 0.008, 8),
    {
      p: [centerX + width / 2 - 0.06, bodyTop - 0.016, halfDepth + 0.004],
      r: [HALF_PI, 0, 0]
    },
    0.8
  );
  builder.add(
    'rubber',
    worldUvBox(width - 0.04, 0.006, halfDepth * 2 - 0.04),
    {
      p: [centerX, bodyTop + 0.003, 0]
    },
    0.9
  );
  builder.add(
    paintMat,
    roundedBoxGeometry(width, 0.03, 0.014, 0.004),
    {
      p: [centerX, bodyTop + 0.013, -halfDepth + 0.007]
    },
    tint(0.95)
  );
  for (const side of [1, -1]) {
    builder.add(
      paintMat,
      roundedBoxGeometry(0.014, 0.03, halfDepth * 2, 0.004),
      {
        p: [centerX + side * (width / 2 - 0.007), bodyTop + 0.013, 0]
      },
      tint(0.95)
    );
  }

  // Push handle.
  builder.add(
    'aluminium',
    tubeThroughPoints(
      [
        [centerX - width / 2, 0.56, -0.17],
        [-0.41, 0.6, -0.17],
        [-0.435, 0.73, -0.17],
        [-0.435, 0.73, 0.17],
        [-0.41, 0.6, 0.17],
        [centerX - width / 2, 0.56, 0.17]
      ],
      0.012,
      6,
      false,
      0.2
    ),
    null,
    0.85
  );

  // Castors (the +X pair swivel randomly).
  for (const sideX of [1, -1]) {
    for (const sideZ of [1, -1]) {
      builder.push({
        p: [centerX + sideX * (width / 2 - 0.07), 0, sideZ * (halfDepth - 0.06)],
        r: [0, sideX > 0 ? rng() * 6 : 0, 0]
      });
      builder.add(
        'steel_galv',
        roundedBoxGeometry(0.08, 0.008, 0.07, 0.002),
        {
          p: [0, 0.119, 0]
        },
        0.7
      );
      for (const forkSide of [1, -1]) {
        builder.add(
          'steel_galv',
          beamBetweenPoints(
            [0, 0.117, forkSide * 0.022],
            [0.02, 0.05, forkSide * 0.022],
            0.035,
            0.004,
            0,
            true
          ),
          null,
          0.65
        );
      }
      builder.add(
        'rubber',
        worldUvCylinder(0.05, 0.05, 0.03, 12),
        {
          p: [0.02, 0.05, 0],
          r: [HALF_PI, 0, 0]
        },
        0.9
      );
      builder.add(
        'steel_galv',
        worldUvCylinder(0.02, 0.02, 0.034, 6),
        {
          p: [0.02, 0.05, 0],
          r: [HALF_PI, 0, 0]
        },
        0.6
      );
      builder.pop();
    }
  }

  // Labels.
  builder.label(
    options.label || 'MAINT ' + (1 + (builder.seed % 2)),
    {
      color: 'white',
      font: 'stencil',
      distress: 0.4
    },
    0.3,
    0.07,
    {
      p: [centerX + width / 2 + 0.002, 0.6, 0],
      r: [0, HALF_PI, 0]
    }
  );
  builder.decal(game.mats.decal('logo_d'), 0.2, {
    p: [centerX + width / 2 + 0.002, 0.42, 0],
    r: [0, HALF_PI, 0]
  });
  builder.decal(game.mats.decal('grime_streak'), 0.3, {
    p: [centerX, 0.45, -halfDepth - 0.002],
    r: [0, PI, 0]
  });

  // Tools lying on top.
  const topY = bodyTop + 0.006;
  // Combination spanner.
  builder.push({
    p: [centerX - 0.18, topY, 0.08],
    r: [0, 0.5, 0]
  });
  builder.add(
    'steel_bare',
    roundedBoxGeometry(0.2, 0.006, 0.02, 0.002),
    {
      p: [0, 0.004, 0]
    },
    0.9
  );
  builder.add(
    'steel_bare',
    metricTorusGeometry(0.016, 0.006, 4, 10),
    {
      p: [0.11, 0.005, 0],
      r: [HALF_PI, 0, 0]
    },
    0.9
  );
  builder.add(
    'steel_bare',
    metricTorusGeometry(0.017, 0.006, 4, 7, PI * 1.4),
    {
      p: [-0.112, 0.005, 0],
      r: [HALF_PI, 0, 2.2]
    },
    0.9
  );
  builder.pop();
  // Hammer.
  builder.push({
    p: [centerX + 0.02, topY, -0.1],
    r: [0, -0.3, 0]
  });
  builder.add(
    'wood_pallet',
    cylinderBetween([-0.14, 0.014, 0], [0.12, 0.016, 0], 0.012, 6, true, 0.01),
    null,
    0.9
  );
  builder.add(
    'steel_dark',
    roundedBoxGeometry(0.032, 0.03, 0.1, 0.006),
    {
      p: [0.125, 0.017, 0.005]
    },
    0.8
  );
  builder.pop();
  // Socket rail.
  builder.push({
    p: [centerX + 0.2, topY, 0.1],
    r: [0, 0.12, 0]
  });
  builder.add(
    'polymer_black',
    roundedBoxGeometry(0.22, 0.014, 0.05, 0.004),
    {
      p: [0, 0.007, 0]
    },
    0.6
  );
  for (let socket = 0; socket < 6; socket++) {
    builder.add(
      'steel_bare',
      worldUvCylinder(0.008 + socket * 0.0014, 0.008 + socket * 0.0014, 0.03, 8),
      {
        p: [-0.085 + socket * 0.034, 0.029, 0]
      },
      0.9
    );
  }
  builder.pop();
  // Spray can.
  builder.add(
    'plastic_blue',
    worldUvCylinder(0.032, 0.032, 0.13, 12),
    {
      p: [centerX + 0.28, topY + 0.065, -0.12]
    },
    0.9
  );
  builder.add(
    'steel_bare',
    smoothLatheGeometry(
      [
        [0.032, 0],
        [0.028, 0.012],
        [0.014, 0.018],
        [0.014, 0.018],
        [0.014, 0.03],
        [0, 0.03]
      ],
      10
    ),
    {
      p: [centerX + 0.28, topY + 0.13, -0.12]
    },
    0.9
  );
  builder.add(
    'plastic_red',
    worldUvCylinder(0.012, 0.012, 0.014, 8),
    {
      p: [centerX + 0.28, topY + 0.165, -0.12]
    },
    0.95
  );
  // Screwdriver.
  builder.add(
    'paint_yellow',
    cylinderBetween(
      [centerX - 0.3, topY + 0.012, -0.13],
      [centerX - 0.2, topY + 0.012, -0.16],
      0.014,
      7,
      true
    ),
    null,
    0.9
  );
  builder.add(
    'steel_bare',
    cylinderBetween(
      [centerX - 0.2, topY + 0.012, -0.16],
      [centerX - 0.08, topY + 0.01, -0.196],
      0.004,
      5,
      true
    ),
    null,
    0.9
  );
  // Crumpled work glove.
  const glove = subdividedRoundedBox(0.2, 0.02, 0.15, 0.009, 4, 3, 4);
  const gloveNoiseOffset = rng() * 9;
  mapVertices(glove, (vertex: THREE.Vector3) => {
    vertex.y +=
      0.012 *
      valueNoise3d(vertex.x * 30 + gloveNoiseOffset, vertex.z * 30) *
      (vertex.y > 0 ? 1 : 0);
    vertex.x += 0.012 * (valueNoise3d(vertex.z * 20, gloveNoiseOffset) - 0.5);
  });
  builder.add(
    builder.mat('glove_fabric', {
      color: 0x7d2b24
    }),
    computeWeldedNormals(glove),
    {
      p: [centerX - 0.26, topY + 0.01, 0.12],
      r: [0, 0.8, 0]
    },
    0.9
  );
  return builder.finish();
}

/** Registers the forklift, generator, dumpster and toolbox-cart builders. */
export function registerMachineryProps(
  register: (name: string, builder: MachineryPropBuilder) => void
): void {
  register('forklift', (game, options = {}) => buildForklift(game, options));
  register('generator', (game, options = {}) => buildGenerator(game, options));
  register('dumpster', (game, options = {}) => buildDumpster(game, options));
  register('toolbox_cart', (game, options = {}) => buildToolboxCart(game, options));
}
