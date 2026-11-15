// Procedural port fixtures: ISO shipping containers (with doors, corrugation, dents, rust
// and decals), jersey barriers, light masts, fences, guard booth, gate arm, bollards,
// signs, floodlight stand, stairs, catwalk, pallet shelf rack, reefer unit and the relay
// node. Each builder is registered with the prop registry at module load.
import { BufferAttribute, Color, Group, MathUtils, Mesh, PlaneGeometry } from 'three';
import type { BufferGeometry, Material } from 'three';
import type { Game } from '../core/types';
import { mergeGeometryList, worldUvBox, worldUvCylinder } from '../render/geometry';
import { PROP_SIZES, registerProp } from './registry';
import {
  corrugationProfile,
  latheFromPoints,
  lerpRgb,
  makeTransformMatrix,
  metricPlaneGeometry,
  seededRandom,
  simplePlaneGeometry,
  smoothstep,
  sphereSegmentGeometry,
  stadiumGeometry,
  sweepProfileGeometry,
  transformGeometry,
  valueNoise2d
} from './propGeometry';
import {
  PropBuilder,
  finalizeProp,
  labelDecal,
  meshGroupFromParts,
  namedDecal
} from './propBuilder';
import type { DecalInfo, GeometryBucket, PropCollider, PropPart } from './propBuilder';

/** Options common to most fixtures: `seed` picks the variation. */
interface SeedOptions {
  seed?: number;
}

/** Options of the container props. */
interface ContainerOptions extends SeedOptions {
  /** Door opening 0..1. */
  doors?: number;
  /** Weathering 0..1 (default 0.5). */
  wear?: number;
  /** Paint colour name (see CONTAINER_COLORS); defaults per seed / size. */
  color?: string;
}

/** Placard data printed on a container type. */
interface ContainerSpec {
  type: string;
  gross: string;
  tare: string;
  net: string;
  cu: string;
  /** Default colour. */
  def: string;
}

/** Corrugation shape: pitch, depth, flat (crest) width and slope width. */
interface CorrugationSpec {
  P: number;
  d: number;
  fo: number;
  sl: number;
}

/** Cached, colour-independent container geometry. */
interface ContainerParts {
  parts: PropPart[];
  colliders: PropCollider[];
}

type Rgb = number[];

const CONTAINER_WIDTH = 2.438;
const CONTAINER_SPECS: Record<string, ContainerSpec> = {
  container20: {
    type: '22G1',
    gross: '30,480',
    tare: '2,230',
    net: '28,250',
    cu: '33.2',
    def: 'red'
  },
  container40: {
    type: '42G1',
    gross: '32,500',
    tare: '3,750',
    net: '28,750',
    cu: '67.7',
    def: 'blue'
  },
  container40hc: {
    type: '45G1',
    gross: '32,500',
    tare: '3,940',
    net: '28,560',
    cu: '76.3',
    def: 'green'
  }
};
const CONTAINER_IDS = [
  'SLTU 482915 7',
  'HBMU 307144 2',
  'NRDU 665201 9',
  'OKTU 119873 4',
  'VSLU 850362 1',
  'TQLU 274590 6'
];
const CONTAINER_LOGOS = ['logo_a', 'logo_b', 'logo_c', 'logo_d'];
const CONTAINER_COLORS = ['red', 'blue', 'green', 'yellow', 'orange', 'white', 'grey', 'teal'];
/** Placeholder material key for the painted body; swapped for `paint_<color>` per instance. */
const CONTAINER_BODY_SLOT = {
  body: true
};
const CONTAINER_VARIANT_COUNT = 6;
const containerPartsCache = new Map<object, Map<string, ContainerParts>>();
const CORNER_CASTING_X = 0.178;
const CORNER_CASTING_Y = 0.118;
const CORNER_CASTING_Z = 0.162;
const SIDE_WALL_CORRUGATION: CorrugationSpec = {
  P: 0.278,
  d: 0.036,
  fo: 0.072,
  sl: 0.068
};
const ROOF_CORRUGATION: CorrugationSpec = {
  P: 0.209,
  d: 0.02,
  fo: 0.09,
  sl: 0.03
};
const END_WALL_CORRUGATION: CorrugationSpec = {
  P: 0.25,
  d: 0.042,
  fo: 0.07,
  sl: 0.06
};

/**
 * Build the geometry of one container variant (shared by all paint colours): frame,
 * corrugated walls with dents / rust, doors (optionally open, with interior), decals,
 * and colliders.
 */
function buildContainerParts(
  game: Game,
  name: string,
  variant: number,
  doorOpen: number,
  wear: number
): ContainerParts {
  const length = PROP_SIZES[name][0];
  const height = PROP_SIZES[name][1];
  const spec = CONTAINER_SPECS[name];
  const rng = seededRandom(1000 + variant * 77 + name.length * 13);
  const builder = new PropBuilder(game);
  const galvMat = builder.M('steel_galv');
  const woodMat = builder.M('wood_pallet');
  const halfWidth = CONTAINER_WIDTH / 2;
  const halfLength = length / 2;
  const wallZ = halfWidth - 0.012;
  const wallStartX = -halfLength + 0.085;
  const wallEndX = halfLength - 0.135;
  const wallBottomY = 0.167;
  const wallTopY = height - 0.06;
  const dents: { side: number; x: number; y: number; r: number; depth: number }[] = [];
  const dentCount = Math.round((1 + rng() * 2.4) * (0.4 + wear));
  const dentExclusions = [
    [-halfLength * 0.75, -halfLength * 0.05],
    [halfLength - 2.2, halfLength]
  ];
  for (let i = 0; i < dentCount; i++) {
    const side = rng() < 0.5 ? 1 : -1;
    let dentX = 0;
    let tries = 0;
    do {
      dentX = (rng() * 2 - 1) * (halfLength - 0.9);
      tries++;
    } while (
      tries < 8 &&
      dentExclusions.some(
        (range) => dentX > range[0] - 0.4 && dentX < range[1] + 0.4 && rng() < 0.9
      )
    );
    dents.push({
      side,
      x: side * dentX,
      y: 0.45 + rng() * 1.3,
      r: 0.22 + rng() * 0.3,
      depth: 0.025 + rng() * 0.04
    });
  }
  const rustStreaks: { side: number; x: number; w: number; k: number }[] = [];
  const streakCount = Math.round((length / 2.2) * (0.5 + wear) * (0.6 + rng()));
  for (let i = 0; i < streakCount * 2; i++)
    rustStreaks.push({
      side: i % 2 ? 1 : -1,
      x: (rng() * 2 - 1) * (halfLength - 0.3),
      w: 0.05 + rng() * 0.12,
      k: 0.4 + rng() * 0.6
    });
  const RUST_TINT = [0.5, 0.44, 0.38];
  const STREAK_TINT = [0.62, 0.38, 0.24];
  const noiseOffset = variant * 9.7;
  /** Weathered body vertex colour (paint variation + rust toward the bottom). */
  const bodyColor = (x: number, y: number, z: number): Rgb => {
    let shade =
      1 + (valueNoise2d(x * 0.9 + noiseOffset, y * 1.7 + z * 0.4) - 0.5) * 0.16 * (0.5 + wear);
    shade *= 0.94 + 0.06 * valueNoise2d(x * 6.1 + z * 3.3, y * 5 + noiseOffset);
    let color: Rgb = [shade, shade, shade];
    const rust =
      smoothstep(0.62, 0.02, y) *
      (0.45 + 0.5 * wear) *
      (0.75 + 0.5 * valueNoise2d(x * 2.3 + z, noiseOffset));
    color = lerpRgb(
      color,
      [RUST_TINT[0] * shade, RUST_TINT[1] * shade, RUST_TINT[2] * shade],
      Math.min(1, rust)
    );
    return color;
  };
  builder.defCol.set(CONTAINER_BODY_SLOT, bodyColor);
  /** Inward dent depth of the side wall `side` at (x, y). */
  const dentDepthAt = (x: number, y: number, side: number): number => {
    let depth = 0;
    for (const dent of dents)
      if (dent.side === side) {
        const dist = Math.hypot(x - dent.x, (y - dent.y) * 0.9) / dent.r;
        if (dist < 1) {
          const falloff = 1 - dist * dist;
          depth += dent.depth * falloff * falloff;
        }
      }
    return depth;
  };
  const CASTING_HOLE_COLOR = [0.035, 0.035, 0.04];
  // Corner castings with their oval holes
  for (const endX of [-1, 1])
    for (const top of [0, 1])
      for (const sideZ of [-1, 1]) {
        const cx = endX * (halfLength - CORNER_CASTING_X / 2);
        const cy = top ? height - CORNER_CASTING_Y / 2 : CORNER_CASTING_Y / 2;
        const cz = sideZ * (halfWidth - CORNER_CASTING_Z / 2);
        builder.box(
          CONTAINER_BODY_SLOT,
          CORNER_CASTING_X,
          CORNER_CASTING_Y,
          CORNER_CASTING_Z,
          cx,
          cy,
          cz,
          {
            r: 0.012
          }
        );
        builder.add(
          CONTAINER_BODY_SLOT,
          transformGeometry(
            stadiumGeometry(0.078, 0.052, 3),
            cx,
            cy,
            sideZ * (halfWidth + 0.0012),
            [0, sideZ > 0 ? 0 : Math.PI, 0]
          ),
          CASTING_HOLE_COLOR
        );
        builder.add(
          CONTAINER_BODY_SLOT,
          transformGeometry(stadiumGeometry(0.064, 0.05, 3), endX * (halfLength + 0.0012), cy, cz, [
            0,
            (endX * Math.PI) / 2,
            0
          ]),
          CASTING_HOLE_COLOR
        );
        if (top) {
          builder.add(
            CONTAINER_BODY_SLOT,
            transformGeometry(stadiumGeometry(0.124, 0.064, 3), cx, height + 0.0012, cz, [
              -Math.PI / 2,
              0,
              0
            ]),
            CASTING_HOLE_COLOR
          );
        }
      }
  // Corner posts and side rails
  for (const side of [-1, 1]) {
    builder.box(
      CONTAINER_BODY_SLOT,
      0.085,
      height - 2 * CORNER_CASTING_Y + 0.01,
      0.15,
      -halfLength + 0.0465,
      height / 2,
      side * (halfWidth - 0.079),
      {
        r: 0.014
      }
    );
    builder.box(
      CONTAINER_BODY_SLOT,
      0.14,
      height - 2 * CORNER_CASTING_Y + 0.01,
      0.056,
      halfLength - 0.074,
      height / 2,
      side * (halfWidth - 0.032),
      {
        r: 0.012
      }
    );
    builder.box(
      CONTAINER_BODY_SLOT,
      length - 0.2,
      0.062,
      0.062,
      -0.02,
      height - 0.031,
      side * (halfWidth - 0.035),
      {
        r: 0.008
      }
    );
    builder.box(
      CONTAINER_BODY_SLOT,
      length - 0.2,
      0.158,
      0.05,
      -0.02,
      0.012 + 0.079,
      side * (halfWidth - 0.029),
      {
        r: 0.008
      }
    );
  }
  // End rails / door header and sill
  builder.box(
    CONTAINER_BODY_SLOT,
    0.062,
    0.062,
    CONTAINER_WIDTH - 0.2,
    -halfLength + 0.035,
    height - 0.031,
    0,
    {
      r: 0.008
    }
  );
  builder.box(
    CONTAINER_BODY_SLOT,
    0.05,
    0.158,
    CONTAINER_WIDTH - 0.2,
    -halfLength + 0.029,
    0.091,
    0,
    {
      r: 0.008
    }
  );
  builder.box(
    CONTAINER_BODY_SLOT,
    0.13,
    0.12,
    CONTAINER_WIDTH - 0.12,
    halfLength - 0.072,
    height - 0.06,
    0,
    {
      r: 0.01
    }
  );
  builder.box(
    CONTAINER_BODY_SLOT,
    0.13,
    0.158,
    CONTAINER_WIDTH - 0.12,
    halfLength - 0.072,
    0.091,
    0,
    {
      r: 0.01
    }
  );
  builder.box(
    CONTAINER_BODY_SLOT,
    0.03,
    0.012,
    CONTAINER_WIDTH - 0.4,
    halfLength - 0.012,
    height - 0.125,
    0,
    {
      r: 0.003,
      rot: [0, 0, -0.5]
    }
  );
  if (name === 'container20')
    // Forklift pockets
    for (const side of [-1, 1])
      for (const pocketX of [-1.025, 1.025]) {
        builder.add(
          CONTAINER_BODY_SLOT,
          transformGeometry(
            simplePlaneGeometry(0.36, 0.112),
            pocketX,
            0.075,
            side * (halfWidth - 0.0035),
            [0, side > 0 ? 0 : Math.PI, 0]
          ),
          CASTING_HOLE_COLOR
        );
        builder.box(
          CONTAINER_BODY_SLOT,
          0.46,
          0.018,
          0.012,
          pocketX,
          0.142,
          side * (halfWidth - 0.002),
          {
            r: 0.003
          }
        );
        for (const edge of [-1, 1])
          builder.box(
            CONTAINER_BODY_SLOT,
            0.018,
            0.13,
            0.01,
            pocketX + edge * 0.19,
            0.078,
            side * (halfWidth - 0.003),
            {
              r: 0.003
            }
          );
      }
  // Corrugated side walls, vertex-coloured with edge shading, rust streaks and dents
  const wallStations = [wallBottomY, 0.44, 1.25, height - 0.5, wallTopY];
  const sideProfile = corrugationProfile(
    wallStartX,
    wallEndX,
    SIDE_WALL_CORRUGATION.P,
    SIDE_WALL_CORRUGATION.d,
    SIDE_WALL_CORRUGATION.fo,
    SIDE_WALL_CORRUGATION.sl,
    wallStartX + 0.02
  );
  for (const side of [-1, 1]) {
    const wall = sweepProfileGeometry(
      sideProfile,
      wallStations,
      (u, v, station) => [u, station, side * (wallZ + v - dentDepthAt(u, station, side))],
      {
        center: [0, height / 2, 0]
      }
    );
    wall.computeVertexNormals();
    const position = wall.attributes.position;
    const colors = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      let color = bodyColor(x, y, z);
      const recess = wallZ - Math.abs(z);
      const grooveShade = smoothstep(0.008, 0.034, recess);
      color = [
        color[0] * (1 - 0.17 * grooveShade),
        color[1] * (1 - 0.18 * grooveShade),
        color[2] * (1 - 0.18 * grooveShade)
      ];
      const topFade = smoothstep(height - 0.75, wallTopY, y);
      if (topFade > 0) {
        for (const streak of rustStreaks)
          if (streak.side === side) {
            const dist = Math.abs(x - streak.x) / streak.w;
            if (dist < 1) {
              color = lerpRgb(
                color,
                [color[0] * STREAK_TINT[0], color[1] * STREAK_TINT[1], color[2] * STREAK_TINT[2]],
                topFade * topFade * streak.k * (1 - dist * dist) * (0.45 + 0.55 * wear)
              );
            }
          }
      }
      const dent = dentDepthAt(x, y, side);
      if (dent > 0.004) {
        color = lerpRgb(
          color,
          [color[0] * 0.66, color[1] * 0.46, color[2] * 0.36],
          Math.min(0.8, dent * 22)
        );
      }
      colors[i * 3] = color[0];
      colors[i * 3 + 1] = color[1];
      colors[i * 3 + 2] = color[2];
    }
    wall.setAttribute('color', new BufferAttribute(colors, 3));
    // The body bucket already exists (castings / rails were added above).
    (builder.buckets.get(CONTAINER_BODY_SLOT) as GeometryBucket).geos.push(wall);
  }
  // Side vents
  for (const side of [-1, 1])
    for (const endSign of length > 7 ? [-1, 1] : [1]) {
      const ventX = side * endSign * (halfLength - 0.62);
      const ventY = height - 0.165;
      const ventZ = side * (wallZ - 0.004);
      builder.box(CONTAINER_BODY_SLOT, 0.24, 0.1, 0.03, ventX, ventY, ventZ, {
        r: 0.008
      });
      for (let slat = -1; slat <= 1; slat++)
        builder.add(
          CONTAINER_BODY_SLOT,
          transformGeometry(
            simplePlaneGeometry(0.18, 0.012),
            ventX,
            ventY + slat * 0.026,
            side * (wallZ + 0.0116),
            [0, side > 0 ? 0 : Math.PI, 0]
          ),
          CASTING_HOLE_COLOR
        );
    }
  // Front end wall
  {
    const profile = corrugationProfile(
      -halfWidth + 0.155,
      halfWidth - 0.155,
      END_WALL_CORRUGATION.P,
      END_WALL_CORRUGATION.d,
      END_WALL_CORRUGATION.fo,
      END_WALL_CORRUGATION.sl,
      -halfWidth + 0.155 + 0.03
    );
    const endWall = sweepProfileGeometry(
      profile,
      [wallBottomY, 1.25, wallTopY],
      (u, v, station) => [-(halfLength - 0.014 + v), station, u],
      {
        center: [0, height / 2, 0]
      }
    );
    const endWallX = -(halfLength - 0.014);
    builder.add(CONTAINER_BODY_SLOT, endWall, (x, y, z) => {
      const color = bodyColor(x, y, z);
      const grooveShade = smoothstep(0.008, 0.038, x - endWallX);
      return [
        color[0] * (1 - 0.17 * grooveShade),
        color[1] * (1 - 0.18 * grooveShade),
        color[2] * (1 - 0.18 * grooveShade)
      ];
    });
  }
  // Roof
  {
    const profile = corrugationProfile(
      -halfLength + 0.07,
      halfLength - 0.13,
      ROOF_CORRUGATION.P,
      ROOF_CORRUGATION.d,
      ROOF_CORRUGATION.fo,
      ROOF_CORRUGATION.sl,
      -halfLength + 0.1
    );
    const roofY = height - 0.008;
    const roof = sweepProfileGeometry(
      profile,
      length > 7
        ? [-(halfWidth - 0.066), halfWidth - 0.066]
        : [-(halfWidth - 0.066), 0, halfWidth - 0.066],
      (u, v, station) => [u, roofY + v + (Math.abs(station) < 0.01 ? 0.006 : 0), station],
      {
        center: [0, height / 2, 0]
      }
    );
    builder.add(CONTAINER_BODY_SLOT, roof, (x, y, z) => {
      const shade = 0.78 + 0.3 * valueNoise2d(x * 0.8 + noiseOffset, z * 1.1);
      const grooveShade = smoothstep(0.004, 0.018, roofY - y);
      return [
        shade * (1 - 0.25 * grooveShade),
        shade * (1 - 0.3 * grooveShade) * 0.97,
        shade * (1 - 0.32 * grooveShade) * 0.94
      ];
    });
  }
  const doorsOpen = doorOpen > 0.03;
  const floorY = 0.172;
  if (doorsOpen) {
    // Interior: darkening toward the front end
    const interiorColor = (x: number, y: number): Rgb => {
      const shade =
        (0.16 +
          0.62 * smoothstep(-halfLength, halfLength, x) * smoothstep(-halfLength, halfLength, x)) *
        (0.8 + 0.2 * smoothstep(0.2, 1.4, y));
      return [shade, shade, shade];
    };
    const profile = corrugationProfile(
      wallStartX,
      wallEndX,
      SIDE_WALL_CORRUGATION.P,
      SIDE_WALL_CORRUGATION.d,
      SIDE_WALL_CORRUGATION.fo,
      SIDE_WALL_CORRUGATION.sl,
      wallStartX + 0.02
    );
    for (const side of [-1, 1])
      builder.add(
        CONTAINER_BODY_SLOT,
        sweepProfileGeometry(
          profile,
          [floorY, wallTopY - 0.02],
          (u, v, station) => [u, station, side * (wallZ + v - 0.004)],
          {
            center: [0, height / 2, 0],
            inward: true
          }
        ),
        interiorColor
      );
    builder.add(
      CONTAINER_BODY_SLOT,
      transformGeometry(
        simplePlaneGeometry(wallEndX - wallStartX, 2 * wallZ),
        (wallStartX + wallEndX) / 2,
        wallTopY - 0.03,
        0,
        [Math.PI / 2, 0, 0]
      ),
      interiorColor
    );
    builder.add(
      CONTAINER_BODY_SLOT,
      transformGeometry(
        simplePlaneGeometry(2 * wallZ, wallTopY - floorY),
        wallStartX + 0.03,
        (floorY + wallTopY) / 2,
        0,
        [0, Math.PI / 2, 0]
      ),
      interiorColor
    );
    const floor = metricPlaneGeometry(wallEndX - wallStartX + 0.1, 2 * wallZ - 0.02);
    builder.add(
      woodMat,
      transformGeometry(floor, (wallStartX + wallEndX) / 2 + 0.05, floorY, 0, [-Math.PI / 2, 0, 0]),
      (x) => {
        const shade = 0.3 + 0.6 * smoothstep(-halfLength, halfLength, x) ** 2;
        return [shade, shade * 0.97, shade * 0.93];
      }
    );
    builder.box(galvMat, 0.05, 0.006, 2 * wallZ - 0.1, halfLength - 0.11, floorY + 0.001, 0, {
      r: 0.002
    });
  }
  // Doors
  const doorBottom = 0.175;
  const doorTop = height - 0.124;
  const doorHeight = doorTop - doorBottom;
  const doorWidth = halfWidth - 0.058 - 0.004;
  const hingeX = halfLength - 0.066;
  const doorColor = (x: number, y: number, z: number): Rgb => bodyColor(x, y, z);
  const colliders: PropCollider[] = [];
  for (const doorSide of [1, -1]) {
    const openAngle =
      doorOpen * (doorSide > 0 ? 1 : 0.88) * MathUtils.degToRad(doorSide > 0 ? 112 : 100);
    const hingeZ = doorSide * (halfWidth - 0.058);
    builder.push(makeTransformMatrix(hingeX, 0, hingeZ, [0, -doorSide * openAngle, 0]));
    /** Local z of a point `distance` from the hinge along the door leaf. */
    const along = (distance: number): number => -doorSide * distance;
    const doorMidY = (doorBottom + doorTop) / 2;
    builder.box(
      CONTAINER_BODY_SLOT,
      0.034,
      doorHeight,
      doorWidth - 0.006,
      0,
      doorMidY,
      along(doorWidth / 2),
      {
        r: 0.008,
        col: doorColor
      }
    );
    const panelCount = name === 'container40hc' ? 7 : 6;
    const panelStart = doorBottom + 0.085;
    const panelEnd = doorTop - 0.085;
    const panelPitch = (panelEnd - panelStart) / panelCount;
    const flatDepth = 0.019;
    const raisedDepth = 0.031;
    const doorProfile: number[][] = [];
    for (let i = 0; i < panelCount; i++) {
      const y = panelStart + i * panelPitch;
      doorProfile.push(
        [y, flatDepth],
        [y + 0.022, flatDepth],
        [y + 0.05, raisedDepth],
        [y + panelPitch - 0.05, raisedDepth],
        [y + panelPitch - 0.022, flatDepth]
      );
    }
    doorProfile.push([panelEnd, flatDepth]);
    builder.add(
      CONTAINER_BODY_SLOT,
      sweepProfileGeometry(
        doorProfile,
        [0.075, doorWidth - 0.085],
        (u, v, station) => [v, u, along(station)],
        {
          center: [-1, doorMidY, along(doorWidth / 2)]
        }
      ),
      (x, y, z) => bodyColor(x, y, z)
    );
    const panelCenterY = (index: number): number => panelStart + (index + 0.5) * panelPitch;
    const SEAL_COLOR = [0.05, 0.05, 0.05];
    builder.box(
      CONTAINER_BODY_SLOT,
      0.022,
      doorHeight + 0.012,
      0.018,
      0.004,
      doorMidY,
      along(doorWidth + 0.001),
      {
        r: 0,
        col: SEAL_COLOR
      }
    );
    builder.box(
      CONTAINER_BODY_SLOT,
      0.022,
      0.016,
      doorWidth,
      0.004,
      doorTop + 0.004,
      along(doorWidth / 2),
      {
        r: 0,
        col: SEAL_COLOR
      }
    );
    builder.box(
      CONTAINER_BODY_SLOT,
      0.022,
      0.016,
      doorWidth,
      0.004,
      doorBottom - 0.004,
      along(doorWidth / 2),
      {
        r: 0,
        col: SEAL_COLOR
      }
    );
    // Hinges
    const hingeCount = name === 'container40hc' ? 5 : 4;
    for (let i = 0; i < hingeCount; i++) {
      const y = doorBottom + 0.16 + (i * (doorHeight - 0.32)) / (hingeCount - 1);
      builder.box(CONTAINER_BODY_SLOT, 0.012, 0.062, 0.15, 0.021, y, along(0.085), {
        r: 0
      });
      builder.cyl(galvMat, 0.013, 0.013, 0.086, 0.026, y, along(-0.002), {
        seg: 6,
        open: true
      });
    }
    // Locking bars with keepers, guides and handles
    for (const barPos of [0.31, 0.83]) {
      builder.cyl(galvMat, 0.0155, 0.0155, doorHeight + 0.2, 0.052, doorMidY, along(barPos), {
        seg: 7,
        open: true
      });
      for (const end of [-1, 1]) {
        builder.add(
          galvMat,
          transformGeometry(
            worldUvBox(0.03, 0.045, 0.085),
            0.052 - 0.004,
            doorMidY + end * (doorHeight / 2 + 0.065),
            along(barPos)
          )
        );
        builder.box(
          CONTAINER_BODY_SLOT,
          0.03,
          0.05,
          0.075,
          0.052 - 0.012,
          doorMidY + end * (doorHeight / 2 - 0.035),
          along(barPos),
          {
            r: 0
          }
        );
      }
      for (const guideY of [doorBottom + doorHeight * 0.3, doorBottom + doorHeight * 0.72])
        builder.box(CONTAINER_BODY_SLOT, 0.026, 0.04, 0.07, 0.052 - 0.012, guideY, along(barPos), {
          r: 0
        });
      const handleY = 1.02 + (barPos > 0.5 ? 0 : 0.13);
      const handleDir = barPos > 0.5 ? -1 : 1;
      builder.box(galvMat, 0.02, 0.05, 0.05, 0.052 + 0.008, handleY, along(barPos), {
        r: 0
      });
      builder.box(
        galvMat,
        0.011,
        0.032,
        0.36,
        0.052 + 0.016,
        handleY,
        along(barPos + handleDir * 0.19),
        {
          r: 0.004
        }
      );
      builder.box(
        CONTAINER_BODY_SLOT,
        0.03,
        0.07,
        0.05,
        0.052 - 0.008,
        handleY,
        along(barPos + handleDir * 0.33),
        {
          r: 0
        }
      );
      builder.box(
        galvMat,
        0.012,
        0.085,
        0.012,
        0.052 + 0.012,
        handleY + 0.005,
        along(barPos + handleDir * 0.33),
        {
          r: 0
        }
      );
    }
    // Door decals
    const decalX = 0.031 + 0.0025;
    const DECAL_ROT = [0, Math.PI / 2, 0];
    const addDoorDecal = (
      decal: DecalInfo,
      decalHeight: number,
      y: number,
      distance: number,
      maxWidth?: number
    ): void => {
      let decalWidth = decalHeight * decal.aspect;
      if (maxWidth && decalWidth > maxWidth) {
        decalHeight *= maxWidth / decalWidth;
        decalWidth = maxWidth;
      }
      builder.add(
        decal.material,
        transformGeometry(
          simplePlaneGeometry(decalWidth, decalHeight),
          decalX,
          y,
          along(distance),
          DECAL_ROT
        ),
        null,
        true
      );
    };
    if (doorSide < 0) {
      addDoorDecal(
        labelDecal(game, CONTAINER_IDS[variant % CONTAINER_IDS.length], {
          color: 'white',
          font: 'stencil',
          distress: 0.3
        }),
        0.115,
        panelCenterY(panelCount - 1),
        doorWidth / 2,
        doorWidth - 0.24
      );
      addDoorDecal(
        labelDecal(game, spec.type, {
          color: 'white',
          font: 'stencil',
          distress: 0.3
        }),
        0.1,
        panelCenterY(panelCount - 2),
        doorWidth / 2 + 0.2,
        0.4
      );
      const smallText = {
        color: 'white',
        font: 'sans',
        distress: 0.2
      };
      addDoorDecal(
        labelDecal(game, 'MAX GROSS ' + spec.gross + ' KG', smallText),
        0.052,
        panelCenterY(panelCount - 3) + 0.062,
        doorWidth / 2 - 0.01,
        0.44
      );
      addDoorDecal(
        labelDecal(game, 'TARE ' + spec.tare + ' KG   NET ' + spec.net + ' KG', smallText),
        0.045,
        panelCenterY(panelCount - 3),
        doorWidth / 2 - 0.01,
        0.44
      );
      addDoorDecal(
        labelDecal(game, 'CU.CAP. ' + spec.cu + ' CU.M', smallText),
        0.045,
        panelCenterY(panelCount - 3) - 0.062,
        doorWidth / 2 - 0.01,
        0.44
      );
    } else {
      addDoorDecal(
        namedDecal(game, CONTAINER_LOGOS[variant % 4]),
        0.2,
        panelCenterY(panelCount - 1),
        doorWidth / 2,
        doorWidth - 0.36
      );
      addDoorDecal(
        namedDecal(game, 'csc_plate'),
        0.17,
        panelCenterY(1),
        doorWidth / 2 + 0.05,
        0.36
      );
      if (name === 'container40hc') {
        addDoorDecal(
          namedDecal(game, 'caution_stripes'),
          0.1,
          doorTop - 0.04,
          doorWidth / 2,
          doorWidth - 0.1
        );
      }
    }
    builder.pop();
    if (doorsOpen)
      // Open door leaf colliders, in three segments along the swung leaf
      for (let i = 0; i < 3; i++) {
        const d0 = (doorWidth * i) / 3;
        const d1 = (doorWidth * (i + 1)) / 3;
        const p0 = [
          hingeX + Math.sin(openAngle) * d0,
          hingeZ - doorSide * Math.cos(openAngle) * d0
        ];
        const p1 = [
          hingeX + Math.sin(openAngle) * d1,
          hingeZ - doorSide * Math.cos(openAngle) * d1
        ];
        colliders.push({
          min: [Math.min(p0[0], p1[0]) - 0.03, doorBottom, Math.min(p0[1], p1[1]) - 0.03],
          max: [Math.max(p0[0], p1[0]) + 0.03, doorTop, Math.max(p0[1], p1[1]) + 0.03],
          surface: 'metal'
        });
      }
  }
  // Lock-bar keepers on the door frame
  for (const doorSide of [1, -1])
    for (const barPos of [0.31, 0.83])
      for (const end of [-1, 1]) {
        const z = doorSide * (halfWidth - 0.058) - doorSide * barPos;
        builder.add(
          CONTAINER_BODY_SLOT,
          transformGeometry(
            worldUvBox(0.035, 0.05, 0.11),
            halfLength - 0.03,
            end > 0 ? height - 0.07 : 0.115,
            z
          )
        );
      }
  /**
   * Decal following the side-wall corrugation and dents; returns its width.
   * `centerX` is measured along the outside face (mirrored on the -z side).
   */
  const addWallDecal = (
    decal: DecalInfo,
    side: number,
    centerX: number,
    centerY: number,
    decalHeight: number,
    maxWidth?: number
  ): number => {
    let decalWidth = decalHeight * decal.aspect;
    if (maxWidth && decalWidth > maxWidth) {
      decalHeight *= maxWidth / decalWidth;
      decalWidth = maxWidth;
    }
    const left = centerX - decalWidth / 2;
    const right = centerX + decalWidth / 2;
    const u0 = side > 0 ? left : -right;
    const u1 = side > 0 ? right : -left;
    const profile = corrugationProfile(
      Math.max(wallStartX, u0),
      Math.min(wallEndX, u1),
      SIDE_WALL_CORRUGATION.P,
      SIDE_WALL_CORRUGATION.d,
      SIDE_WALL_CORRUGATION.fo,
      SIDE_WALL_CORRUGATION.sl,
      wallStartX + 0.02
    );
    const bottom = centerY - decalHeight / 2;
    const top = centerY + decalHeight / 2;
    const geometry = sweepProfileGeometry(
      profile,
      [bottom, top],
      (u, v, station) => [u, station, side * (wallZ + v + 0.003 - dentDepthAt(u, station, side))],
      {
        center: [0, height / 2, 0]
      }
    );
    const position = geometry.attributes.position;
    const uv = geometry.attributes.uv;
    for (let i = 0; i < position.count; i++) {
      const t = (position.getX(i) - u0) / (u1 - u0);
      uv.setXY(i, side > 0 ? t : 1 - t, (position.getY(i) - bottom) / decalHeight);
    }
    builder.add(decal.material, geometry, null, true);
    return decalWidth;
  };
  const idLabel = labelDecal(game, CONTAINER_IDS[variant % CONTAINER_IDS.length], {
    color: 'white',
    font: 'stencil',
    distress: 0.3
  });
  const typeLabel = labelDecal(game, spec.type, {
    color: 'white',
    font: 'stencil',
    distress: 0.3
  });
  const logo = namedDecal(game, CONTAINER_LOGOS[variant % 4]);
  for (const side of [-1, 1]) {
    const logoHeight = Math.min(height * 0.4, 1.05);
    const logoWidth = Math.min(logoHeight * logo.aspect, name === 'container20' ? 2.2 : 3.4);
    addWallDecal(
      logo,
      side,
      name === 'container20' ? -0.75 : -halfLength * 0.42,
      height * 0.52,
      logoWidth / logo.aspect,
      logoWidth
    );
    const idWidth = Math.min(0.14 * idLabel.aspect, 1.9);
    addWallDecal(idLabel, side, halfLength - 0.3 - idWidth / 2, height - 0.32, 0.14, 1.9);
    const typeWidth = Math.min(0.11 * typeLabel.aspect, 0.6);
    addWallDecal(typeLabel, side, halfLength - 0.3 - typeWidth / 2, height - 0.52, 0.11, 0.6);
    // Rust runs / grime streaks hanging from the top rail
    const grimeCount = Math.round((1 + rng() * 2) * (0.4 + wear) * (length > 7 ? 1.6 : 1));
    for (let i = 0; i < grimeCount; i++) {
      const grime = namedDecal(game, rng() < 0.6 ? 'rust_run' : 'grime_streak');
      const grimeHeight = 0.5 + rng() * 0.7;
      const grimeWidth = Math.min(0.5, Math.max(0.16, grimeHeight * grime.aspect));
      addWallDecal(
        {
          material: grime.material,
          aspect: grimeWidth / grimeHeight
        },
        side,
        (rng() * 2 - 1) * (halfLength - 0.6),
        wallTopY - grimeHeight / 2 - 0.005,
        grimeHeight
      );
    }
  }
  if (doorsOpen) {
    colliders.push(
      {
        min: [-halfLength, 0, -halfWidth],
        max: [halfLength, floorY, halfWidth],
        surface: 'wood'
      },
      {
        min: [-halfLength, height - 0.09, -halfWidth],
        max: [halfLength, height, halfWidth],
        surface: 'metal'
      },
      {
        min: [-halfLength, 0, -halfWidth],
        max: [halfLength, height, -halfWidth + 0.07],
        surface: 'metal'
      },
      {
        min: [-halfLength, 0, halfWidth - 0.07],
        max: [halfLength, height, halfWidth],
        surface: 'metal'
      },
      {
        min: [-halfLength, 0, -halfWidth],
        max: [-halfLength + 0.07, height, halfWidth],
        surface: 'metal'
      }
    );
  } else {
    colliders.push({
      min: [-halfLength, 0, -halfWidth],
      max: [halfLength, height, halfWidth],
      surface: 'metal'
    });
  }
  return {
    parts: builder.parts(),
    colliders
  };
}

/** Container prop: cached variant geometry + per-instance paint colour. */
function buildContainer(game: Game, name: string, options: ContainerOptions = {}): Group {
  const spec = CONTAINER_SPECS[name];
  const seed = options.seed === undefined ? 0 : Math.abs(Math.floor(options.seed));
  const variant = seed % CONTAINER_VARIANT_COUNT;
  const doors = Math.round(MathUtils.clamp(options.doors || 0, 0, 1) * 10) / 10;
  const wear =
    Math.round(MathUtils.clamp(options.wear === undefined ? 0.5 : options.wear, 0, 1) * 2) / 2;
  const key = name + '|' + variant + '|' + doors + '|' + wear;
  let cache = containerPartsCache.get(game.mats);
  if (!cache) {
    cache = new Map();
    containerPartsCache.set(game.mats, cache);
  }
  if (!cache.has(key)) cache.set(key, buildContainerParts(game, name, variant, doors, wear));
  const parts = cache.get(key) as ContainerParts;
  let color = options.color;
  if (!CONTAINER_COLORS.includes(color as string)) {
    color =
      options.seed === undefined
        ? spec.def
        : CONTAINER_COLORS[(seed * 7 + 3) % CONTAINER_COLORS.length];
  }
  const group = meshGroupFromParts(
    parts.parts,
    new Map([
      [
        CONTAINER_BODY_SLOT,
        game.mats.get('paint_' + color, {
          vertexColors: true
        })
      ]
    ])
  );
  const size = PROP_SIZES[name];
  group.userData.color = color;
  group.userData.doors = doors;
  return finalizeProp(
    group,
    name,
    [size[0], size[1], size[2]],
    parts.colliders.map((collider) => ({
      min: collider.min.slice(),
      max: collider.max.slice(),
      surface: collider.surface
    }))
  );
}

/** `[width, height, depth]` of a prop from PROP_SIZES. */
const fixtureSize = (name: string): number[] => PROP_SIZES[name].slice(0, 3) as number[];
const PI_FIXTURES = Math.PI;

interface JerseyBarrierOptions extends SeedOptions {
  /** Paint hazard stripes on top. */
  stripe?: boolean;
}

/** Concrete jersey barrier with weathering, chips and lifting slots. */
function buildJerseyBarrier(game: Game, options: JerseyBarrierOptions = {}): Group {
  const builder = new PropBuilder(game);
  const seed = options.seed! | 0;
  const rng = seededRandom(seed + 11);
  const noiseOffset = seed * 3.7;
  const concreteMat = builder.M('concrete', {
    vertexColors: true
  });
  const profile = [
    [-0.3, 0],
    [0.3, 0],
    [0.3, 0.076],
    [0.127, 0.33],
    [0.1, 0.57],
    [0.077, 0.79],
    [0.06, 0.81],
    [-0.06, 0.81],
    [-0.077, 0.79],
    [-0.1, 0.57],
    [-0.127, 0.33],
    [-0.3, 0.076]
  ];
  const stations = [-1.5, -1.47];
  for (let x = -1.25; x <= 1.26; x += 0.25) stations.push(x);
  stations.push(1.47, 1.5);
  /** Chipped spots: [x, y, radius, side]. */
  const chips: number[][] = [];
  for (let i = 0; i < 7; i++)
    chips.push([(rng() * 2 - 1) * 1.5, rng() * 0.8, 0.08 + rng() * 0.14, rng() < 0.5 ? 1 : -1]);
  const body = sweepProfileGeometry(
    profile,
    stations,
    (u, v, station) => {
      // Slightly shrink the end sections to fake a bevel.
      const isEnd = Math.abs(station) > 1.49 ? 1 : 0;
      return [station, v - isEnd * 0.022 * (v / 0.81), u * (1 - isEnd * 0.09)];
    },
    {
      closed: true,
      caps: true
    }
  );
  builder.add(concreteMat, body, (x, y, z) => {
    const shade =
      0.86 +
      0.2 * valueNoise2d(x * 1.3 + noiseOffset, y * 3 + z * 2) +
      0.08 * valueNoise2d(x * 7, y * 9 + noiseOffset);
    let color: Rgb = [shade, shade * 0.99, shade * 0.97];
    color = lerpRgb(color, [shade * 0.5, shade * 0.48, shade * 0.44], smoothstep(0.3, 0, y) * 0.8);
    const stain =
      smoothstep(0.55, 0.8, valueNoise2d(x * 4.5 + noiseOffset, 3.3)) * smoothstep(0.25, 0.8, y);
    color = lerpRgb(color, [shade * 0.62, shade * 0.6, shade * 0.56], stain * 0.6);
    const tireMark =
      smoothstep(0.6, 0.85, valueNoise2d(x * 2.1 + noiseOffset * 2, z * 3)) *
      smoothstep(0.2, 0.33, y) *
      smoothstep(0.62, 0.4, y);
    color = lerpRgb(color, [0.22, 0.22, 0.22], tireMark * 0.65);
    for (const chip of chips)
      if (Math.sign(z || 1) === chip[3]) {
        const dist = Math.hypot(x - chip[0], y - chip[1]) / chip[2];
        if (dist < 1) color = lerpRgb(color, [1.12, 1.1, 1.05], (1 - dist) * 0.7);
      }
    if (Math.abs(x) > 1.4) {
      color = lerpRgb(color, [1.08, 1.06, 1.02], 0.4 * valueNoise2d(y * 9, z * 9 + noiseOffset));
    }
    return color;
  });
  // Forklift slots at the base
  const SLOT_COLOR = [0.05, 0.05, 0.05];
  for (const side of [-1, 1])
    for (const slotX of [-0.85, 0.85]) {
      builder.add(
        concreteMat,
        transformGeometry(simplePlaneGeometry(0.3, 0.058), slotX, 0.03, side * 0.3008, [
          0,
          side > 0 ? 0 : PI_FIXTURES,
          0
        ]),
        SLOT_COLOR
      );
      builder.box(concreteMat, 0.34, 0.012, 0.012, slotX, 0.064, side * 0.3, {
        r: 0.003,
        col: [0.7, 0.7, 0.68]
      });
    }
  // Lifting loops
  for (const loopX of [-0.9, 0.9])
    builder.tube(
      builder.M('steel_rust'),
      [
        [loopX - 0.05, 0.8, 0],
        [loopX - 0.04, 0.85, 0],
        [loopX + 0.04, 0.85, 0],
        [loopX + 0.05, 0.8, 0]
      ],
      0.008,
      {
        seg: 5
      }
    );
  if (options.stripe) {
    const stripeMat = builder.M('hazard_stripes');
    builder.add(
      stripeMat,
      transformGeometry(metricPlaneGeometry(2.9, 0.118), 0, 0.8125, 0, [-PI_FIXTURES / 2, 0, 0])
    );
    for (const side of [-1, 1])
      builder.add(
        stripeMat,
        transformGeometry(metricPlaneGeometry(2.9, 0.2), 0, 0.68, side * 0.0905, [
          side > 0 ? -0.108 : 0.108,
          side > 0 ? 0 : PI_FIXTURES,
          0
        ])
      );
  }
  return finalizeProp(builder.group(), 'jersey_barrier', fixtureSize('jersey_barrier'), [
    {
      min: [-1.5, 0, -0.3],
      max: [1.5, 0.33, 0.3],
      surface: 'concrete'
    },
    {
      min: [-1.5, 0.33, -0.13],
      max: [1.5, 0.81, 0.13],
      surface: 'concrete'
    }
  ]);
}

/**
 * Floodlight head (housing, emissive lens, guard grid, yoke bracket) at (x, y, z),
 * turned by `yaw` and tilted by `tilt`.
 */
function addFloodlightHead(
  builder: PropBuilder,
  bracketMat: Material,
  housingMat: Material,
  lensMat: Material,
  x: number,
  y: number,
  z: number,
  yaw: number,
  tilt: number
): void {
  builder.push(makeTransformMatrix(x, y, z, [0, yaw, 0]));
  builder.push(makeTransformMatrix(0, 0, 0, [0, 0, tilt]));
  builder.box(housingMat, 0.1, 0.34, 0.46, 0.09, 0, 0, {
    r: 0.014
  });
  builder.add(
    lensMat,
    transformGeometry(simplePlaneGeometry(0.4, 0.28), 0.1415, 0, 0, [0, PI_FIXTURES / 2, 0]),
    null,
    true
  );
  builder.box(housingMat, 0.012, 0.018, 0.47, 0.146, 0.156, 0, {
    r: 0
  });
  builder.box(housingMat, 0.012, 0.018, 0.47, 0.146, -0.156, 0, {
    r: 0
  });
  builder.box(housingMat, 0.012, 0.33, 0.018, 0.146, 0, 0.222, {
    r: 0
  });
  builder.box(housingMat, 0.012, 0.33, 0.018, 0.146, 0, -0.222, {
    r: 0
  });
  builder.box(housingMat, 0.09, 0.008, 0.48, 0.17, 0.175, 0, {
    r: 0,
    rot: [0, 0, -0.12]
  });
  // Cooling fins
  for (let i = -3; i <= 3; i++)
    builder.add(housingMat, transformGeometry(worldUvBox(0.045, 0.3, 0.008), 0.02, 0, i * 0.062));
  builder.pop();
  builder.box(bracketMat, 0.03, 0.05, 0.56, 0.02, -0.02, 0, {
    r: 0.004
  });
  for (const side of [-1, 1])
    builder.box(bracketMat, 0.1, 0.05, 0.012, 0.05, -0.02, side * 0.275, {
      r: 0,
      rot: [0, 0, tilt * 0.5]
    });
  builder.pop();
}

interface LightMastOptions extends SeedOptions {
  /** Lamps lit (default true). */
  on?: boolean;
}

/** Light emitted by a lamp, stored in `userData.lamps`. */
interface LampInfo {
  pos: number[];
  dir: number[];
  color: number;
}

/** 14 m tapered light mast on a concrete footing with four floodlights. */
function buildLightMast(game: Game, options: LightMastOptions = {}): Group {
  const builder = new PropBuilder(game);
  const galvMat = builder.M('steel_galv');
  const concreteMat = builder.M('concrete', {
    vertexColors: true
  });
  const darkMat = builder.M('steel_dark');
  const lampMat = game.mats.emissive(0xffe3bd, options.on === false ? 0.02 : 8);
  // Footing and base plate with anchor bolts
  builder.box(concreteMat, 0.8, 0.32, 0.8, 0, 0.16, 0, {
    r: 0.03,
    col: (x, y, z) => {
      const shade = 0.62 + 0.36 * smoothstep(0, 0.3, y) + 0.1 * valueNoise2d(x * 5, z * 5);
      return [shade, shade, shade * 0.97];
    }
  });
  builder.box(galvMat, 0.5, 0.03, 0.5, 0, 0.335, 0, {
    r: 0.006
  });
  for (let i = 0; i < 8; i++) {
    const angle = ((i + 0.5) * PI_FIXTURES) / 4;
    const boltX = Math.cos(angle) * 0.215;
    const boltZ = Math.sin(angle) * 0.215;
    builder.cyl(galvMat, 0.014, 0.014, 0.1, boltX, 0.38, boltZ, {
      seg: 6
    });
    builder.cyl(galvMat, 0.027, 0.027, 0.024, boltX, 0.362, boltZ, {
      seg: 6,
      flat: true
    });
  }
  // Tapered octagonal pole in three telescoping sections
  const poleBottom = 0.35;
  const poleTop = 13.3;
  const bottomRadius = 0.168;
  const topRadius = 0.07;
  const radiusAt = (y: number): number =>
    bottomRadius + ((topRadius - bottomRadius) * (y - poleBottom)) / (poleTop - poleBottom);
  const sections = [
    [poleBottom, 4.75, 0],
    [4.6, 9.15, 0.007],
    [9, poleTop, 0.014]
  ];
  for (const [y0, y1, extra] of sections)
    builder.cyl(galvMat, radiusAt(y1) + extra, radiusAt(y0) + extra, y1 - y0, 0, (y0 + y1) / 2, 0, {
      seg: 8,
      flat: true,
      open: true,
      rot: [0, PI_FIXTURES / 8, 0]
    });
  // Base gussets
  for (let i = 0; i < 4; i++) {
    const angle = (i * PI_FIXTURES) / 2;
    builder.box(galvMat, 0.012, 0.2, 0.12, Math.cos(angle) * 0.2, 0.45, -Math.sin(angle) * 0.2, {
      r: 0,
      rot: [0, angle + PI_FIXTURES / 2, 0]
    });
  }
  builder.cyl(galvMat, 0.2, 0.2, 0.02, 0, 0.36, 0, {
    seg: 8,
    rot: [0, PI_FIXTURES / 8, 0]
  });
  builder.cyl(galvMat, 0.09, 0.09, 0.03, 0, poleTop, 0, {
    seg: 8,
    rot: [0, PI_FIXTURES / 8, 0]
  });
  // Access hatch, warning decal, cable conduit and a small service platform
  const hatchZ = radiusAt(1.05) * 0.924;
  builder.box(galvMat, 0.13, 0.52, 0.012, 0, 1.05, hatchZ + 0.005, {
    r: 0.004
  });
  builder.box(darkMat, 0.03, 0.045, 0.012, 0.04, 1.05, hatchZ + 0.013, {
    r: 0.003
  });
  builder.decal(namedDecal(game, 'hazard_voltage'), 0.09, -0.01, 1.2, hatchZ + 0.0125, null);
  builder.tube(
    darkMat,
    [
      [-0.3, 0.3, 0.28],
      [-0.3, 0.52, 0.28],
      [-0.24, 0.72, 0.2],
      [-0.1, 0.8, 0.1]
    ],
    0.024,
    {
      seg: 6
    }
  );
  builder.cyl(darkMat, 0.034, 0.034, 0.03, -0.3, 0.335, 0.28, {
    seg: 8
  });
  builder.bar(galvMat, [0.1, 3, -0.13], [0.42, 3, -0.13], 0.012);
  builder.bar(galvMat, [0.1, 3, 0.13], [0.42, 3, 0.13], 0.012);
  builder.bar(galvMat, [0.42, 3, -0.16], [0.42, 3, 0.16], 0.012, {
    caps: true
  });
  builder.bar(galvMat, [0.42, 3, -0.13], [0.42, 3.09, -0.13], 0.012, {
    caps: true
  });
  builder.bar(galvMat, [0.42, 3, 0.13], [0.42, 3.09, 0.13], 0.012, {
    caps: true
  });
  builder.cyl(galvMat, radiusAt(3) + 0.012, radiusAt(3) + 0.012, 0.05, 0, 3, 0, {
    seg: 8,
    rot: [0, PI_FIXTURES / 8, 0]
  });
  // Step rungs, alternating sides
  let rung = 0;
  for (let y = 3.45; y < 12.9; y += 0.38, rung++) {
    const side = rung % 2 ? 1 : -1;
    builder.bar(
      galvMat,
      [0, y, side * radiusAt(y) * 0.8],
      [0, y, side * (radiusAt(y) + 0.15)],
      0.009,
      {
        seg: 5,
        caps: true
      }
    );
  }
  // Head frame
  const headY = poleTop + 0.12;
  builder.box(galvMat, 0.1, 0.1, 1.9, 0, headY, 0, {
    r: 0.012
  });
  builder.box(galvMat, 0.5, 0.07, 0.07, 0, headY + 0.085, 0.55, {
    r: 0.01
  });
  builder.box(galvMat, 0.5, 0.07, 0.07, 0, headY + 0.085, -0.55, {
    r: 0.01
  });
  builder.beam(galvMat, [0, poleTop - 0.5, 0.08], [0, headY - 0.03, 0.7], 0.04, 0.04);
  builder.beam(galvMat, [0, poleTop - 0.5, -0.08], [0, headY - 0.03, -0.7], 0.04, 0.04);
  for (const z of [-0.55, 0.55]) {
    addFloodlightHead(builder, galvMat, darkMat, lampMat, 0.22, headY - 0.14, z, 0, -0.62);
    addFloodlightHead(
      builder,
      galvMat,
      darkMat,
      lampMat,
      -0.22,
      headY - 0.14,
      z,
      PI_FIXTURES,
      -0.62
    );
  }
  builder.box(darkMat, 0.16, 0.2, 0.12, 0, poleTop - 0.25, -0.14, {
    r: 0.01
  });
  // Lightning rod
  builder.bar(galvMat, [0, headY, 0], [0, 14, 0], 0.012, {
    r2: 0.003,
    seg: 5,
    caps: true
  });
  const group = builder.group();
  const lamps: LampInfo[] = [];
  group.userData.lamps = lamps;
  for (const z of [-0.55, 0.55])
    for (const side of [-1, 1])
      lamps.push({
        pos: [side * 0.34, headY - 0.22, z],
        dir: [side * 0.81, -0.58, 0],
        color: 0xffe3bd
      });
  return finalizeProp(group, 'light_mast', fixtureSize('light_mast'), [
    {
      min: [-0.4, 0, -0.4],
      max: [0.4, 0.32, 0.4],
      surface: 'concrete'
    },
    {
      min: [-0.17, 0.32, -0.17],
      max: [0.17, 14, 0.17],
      surface: 'metal'
    }
  ]);
}

interface FencePanelOptions extends SeedOptions {
  /** Which end posts to build: 'both' (default), 'left', 'right' or anything else for none. */
  posts?: string;
  /** Barbed-wire outrigger lean direction (1 = +z, otherwise -z). */
  lean?: number;
}

/** 3 m chain-link fence panel with posts, rails and a barbed-wire outrigger. */
function buildFencePanel(game: Game, options: FencePanelOptions = {}): Group {
  const builder = new PropBuilder(game);
  const rng = seededRandom((options.seed! | 0) + 5);
  const galvMat = builder.M('steel_galv');
  const concreteMat = builder.M('concrete', {
    vertexColors: true
  });
  const meshMat = builder.M('chainlink', {
    doubleSide: true
  });
  const posts = options.posts || 'both';
  const lean = options.lean === 1 ? 1 : -1;
  const postXs =
    posts === 'both' ? [-1.5, 1.5] : posts === 'left' ? [-1.5] : posts === 'right' ? [1.5] : [];
  for (const postX of postXs) {
    builder.box(concreteMat, 0.32, 0.09, 0.32, postX, 0.035, 0, {
      r: 0.02,
      col: (_x, y) => {
        const shade = 0.6 + 0.4 * smoothstep(0, 0.08, y);
        return [shade, shade, shade];
      }
    });
    builder.cyl(galvMat, 0.03, 0.03, 2.02, postX, 1.05, 0, {
      seg: 8,
      open: true
    });
    builder.cyl(galvMat, 0.05, 0.05, 0.012, postX, 0.086, 0, {
      seg: 8
    });
    builder.bar(galvMat, [postX, 2.02, 0], [postX, 2.4 - 0.02, lean * 0.36], 0.019, {
      seg: 6,
      caps: true
    });
    builder.cyl(galvMat, 0.034, 0.034, 0.05, postX, 2.03, 0, {
      seg: 8
    });
    for (const clampY of [0.2, 1.05, 1.9])
      builder.cyl(galvMat, 0.034, 0.034, 0.03, postX, clampY, 0, {
        seg: 8,
        open: true
      });
  }
  builder.bar(galvMat, [-1.5, 2, 0.036], [1.5, 2, 0.036], 0.021, {
    seg: 7
  });
  for (const wireY of [0.09, 1.02])
    builder.bar(galvMat, [-1.5, wireY, 0.012], [1.5, wireY, 0.012], 0.0035, {
      seg: 4
    });
  builder.box(galvMat, 0.008, 1.9, 0.02, -1.462, 1.03, 0.012, {
    r: 0
  });
  builder.box(galvMat, 0.008, 1.9, 0.02, 1.462, 1.03, 0.012, {
    r: 0
  });
  // Slightly bulging chain-link mesh
  const mesh = new PlaneGeometry(2.92, 1.93, 6, 3);
  const position = mesh.attributes.position;
  const uv = mesh.attributes.uv;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    uv.setXY(i, x + 1.5, y + 1);
    position.setZ(
      i,
      0.012 +
        0.02 *
          (valueNoise2d(x * 1.3 + (options.seed! | 0), y * 1.5) - 0.5) *
          (1 - Math.abs(x) / 1.46)
    );
  }
  mesh.computeVertexNormals();
  builder.add(meshMat, transformGeometry(mesh, 0, 1.025, 0));
  // Barbed wire strands with barbs
  for (let strand = 0; strand < 3; strand++) {
    const along = 0.3 + strand * 0.33;
    const y = 2.02 + along * 0.36;
    const z = lean * along * 0.36;
    builder.bar(galvMat, [-1.5, y, z], [1.5, y, z], 0.0032, {
      seg: 4
    });
    for (let x = -1.42 + (strand % 2) * 0.09; x < 1.45; x += 0.18)
      builder.add(
        galvMat,
        transformGeometry(worldUvBox(0.004, 0.032, 0.004), x, y, z, [rng() * 3, 0, 0.8 + rng()])
      );
  }
  // Tie clips on the top rail
  for (let i = 0; i < 5; i++)
    builder.add(
      galvMat,
      transformGeometry(worldUvBox(0.012, 0.012, 0.03), -1.2 + i * 0.6, 2, 0.02)
    );
  return finalizeProp(builder.group(), 'fence_panel', fixtureSize('fence_panel'), [
    {
      min: [-1.5, 0, -0.04],
      max: [1.5, 2.4, 0.04],
      surface: 'metal'
    }
  ]);
}

interface GuardBoothOptions extends SeedOptions {
  /** 'white' (default), 'grey' or 'teal'. */
  color?: string;
  /** Door lamp lit (default true). */
  on?: boolean;
}

/** Gatehouse booth: glazed walls, door, roof, AC unit, desk with monitor and chair. */
function buildGuardBooth(game: Game, options: GuardBoothOptions = {}): Group {
  const builder = new PropBuilder(game);
  const seed = options.seed! | 0;
  const noiseOffset = seed * 1.3;
  const width = 2.6;
  const depth = 2.2;
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const paintMat = builder.M(
    'paint_' +
      (['white', 'grey', 'teal'].includes(options.color as string) ? options.color : 'white'),
    {
      vertexColors: true
    }
  );
  const darkMat = builder.M('steel_dark');
  const galvMat = builder.M('steel_galv');
  const glassMat = builder.M('glass', {
    doubleSide: true
  });
  const woodMat = builder.M('wood_dark');
  const polymerMat = builder.M('polymer_black');
  const paintColor = (x: number, y: number, z: number): Rgb => {
    const shade =
      (0.9 + 0.14 * valueNoise2d(x * 2 + noiseOffset, y * 2 + z)) *
      (0.6 + 0.4 * smoothstep(0.1, 0.7, y)) *
      (1 - 0.25 * smoothstep(2.25, 2.45, y));
    return [shade, shade * 0.985, shade * 0.96];
  };
  builder.defCol.set(paintMat, paintColor);
  const floorY = 0.12;
  const sillY = 1;
  const windowTop = 2.08;
  const roofY = 2.42;
  // Base frame and skids
  builder.box(darkMat, width, 0.12, depth, 0, 0.06, 0, {
    r: 0.015
  });
  for (const z of [-0.7, 0.7])
    builder.box(darkMat, width + 0.06, 0.06, 0.1, 0, 0.03, z, {
      r: 0.01
    });
  // Corner posts
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      builder.box(
        paintMat,
        0.09,
        roofY - floorY,
        0.09,
        sx * (halfWidth - 0.045),
        (roofY + floorY) / 2,
        sz * (halfDepth - 0.045),
        {
          r: 0.012
        }
      );
  const doorLeft = 0.3;
  const doorRight = 1.12;
  /** Long wall at `z` (facing +/-z): panels below the sill, glazing above, header. */
  const addLongWall = (z: number, facing: number): void => {
    const spans =
      facing > 0 ? [[-halfWidth + 0.09, doorLeft - 0.04]] : [[-halfWidth + 0.09, halfWidth - 0.09]];
    for (const [x0, x1] of spans) {
      builder.box(paintMat, x1 - x0, sillY - floorY, 0.05, (x0 + x1) / 2, (sillY + floorY) / 2, z, {
        r: 0.006
      });
      builder.box(paintMat, x1 - x0, 0.05, 0.075, (x0 + x1) / 2, sillY + 0.01, z + facing * 0.005, {
        r: 0.008
      });
      builder.box(
        glassMat,
        x1 - x0,
        windowTop - sillY - 0.03,
        0.008,
        (x0 + x1) / 2,
        (sillY + windowTop) / 2 + 0.01,
        z,
        {
          r: 0
        }
      );
      const mullions = x1 - x0 > 1.6 ? 2 : 1;
      for (let i = 1; i <= mullions; i++)
        builder.box(
          paintMat,
          0.04,
          windowTop - sillY,
          0.05,
          x0 + ((x1 - x0) * i) / (mullions + 1),
          (sillY + windowTop) / 2,
          z,
          {
            r: 0.006
          }
        );
      for (let i = 1; i < 3; i++)
        builder.box(
          paintMat,
          0.006,
          sillY - floorY - 0.04,
          0.056,
          x0 + ((x1 - x0) * i) / 3,
          (sillY + floorY) / 2,
          z,
          {
            r: 0
          }
        );
    }
    builder.box(paintMat, width - 0.18, roofY - windowTop, 0.05, 0, (roofY + windowTop) / 2, z, {
      r: 0.006
    });
  };
  addLongWall(halfDepth - 0.03, 1);
  addLongWall(-halfDepth + 0.03, -1);
  // End walls
  for (const side of [-1, 1]) {
    const x = side * (halfWidth - 0.03);
    builder.box(paintMat, 0.05, sillY - floorY, depth - 0.18, x, (sillY + floorY) / 2, 0, {
      r: 0.006
    });
    builder.box(paintMat, 0.075, 0.05, depth - 0.18, x + side * 0.005, sillY + 0.01, 0, {
      r: 0.008
    });
    builder.box(
      glassMat,
      0.008,
      windowTop - sillY - 0.03,
      depth - 0.18,
      x,
      (sillY + windowTop) / 2 + 0.01,
      0,
      {
        r: 0
      }
    );
    builder.box(paintMat, 0.05, windowTop - sillY, 0.04, x, (sillY + windowTop) / 2, 0, {
      r: 0.006
    });
    builder.box(paintMat, 0.05, roofY - windowTop, depth - 0.18, x, (roofY + windowTop) / 2, 0, {
      r: 0.006
    });
  }
  // Door frame and wall right of the door
  const frontZ = halfDepth - 0.03;
  builder.box(
    paintMat,
    0.05,
    windowTop - floorY,
    0.07,
    doorLeft - 0.015,
    (windowTop + floorY) / 2,
    frontZ,
    {
      r: 0.006
    }
  );
  builder.box(
    paintMat,
    0.05,
    windowTop - floorY,
    0.07,
    doorRight + 0.015,
    (windowTop + floorY) / 2,
    frontZ,
    {
      r: 0.006
    }
  );
  builder.box(
    paintMat,
    halfWidth - 0.09 - doorRight - 0.04,
    windowTop - floorY,
    0.05,
    (halfWidth - 0.09 + doorRight + 0.04) / 2,
    (windowTop + floorY) / 2,
    frontZ,
    {
      r: 0.006
    }
  );
  // Door leaf
  const doorWidth = doorRight - doorLeft - 0.02;
  const doorX = (doorLeft + doorRight) / 2;
  builder.box(
    paintMat,
    doorWidth,
    sillY - floorY - 0.01,
    0.04,
    doorX,
    (sillY + floorY) / 2,
    frontZ + 0.005,
    {
      r: 0.006
    }
  );
  builder.box(paintMat, doorWidth, 0.07, 0.04, doorX, windowTop - 0.04, frontZ + 0.005, {
    r: 0.006
  });
  for (const side of [-1, 1])
    builder.box(
      paintMat,
      0.07,
      windowTop - sillY,
      0.04,
      doorX + side * (doorWidth / 2 - 0.035),
      (sillY + windowTop) / 2,
      frontZ + 0.005,
      {
        r: 0.006
      }
    );
  builder.box(
    glassMat,
    doorWidth - 0.12,
    windowTop - sillY - 0.08,
    0.008,
    doorX,
    (sillY + windowTop) / 2 - 0.02,
    frontZ + 0.005,
    {
      r: 0
    }
  );
  builder.box(galvMat, doorWidth - 0.06, 0.22, 0.004, doorX, floorY + 0.14, frontZ + 0.027, {
    r: 0
  });
  builder.box(galvMat, 0.03, 0.14, 0.02, doorLeft + 0.09, 1.05, frontZ + 0.035, {
    r: 0.004
  });
  builder.bar(
    galvMat,
    [doorLeft + 0.09, 1, frontZ + 0.06],
    [doorLeft + 0.2, 1, frontZ + 0.06],
    0.009,
    {
      caps: true
    }
  );
  for (const hingeY of [0.4, 1.75])
    builder.cyl(galvMat, 0.012, 0.012, 0.1, doorRight + 0.002, hingeY, frontZ + 0.03, {
      seg: 6
    });
  // Step, roof slab, roof cap and gutters
  builder.box(darkMat, 0.9, 0.03, 0.3, doorX, 0.105, halfDepth + 0.15, {
    r: 0.006
  });
  builder.box(paintMat, width + 0.36, 0.1, depth + 0.4, 0, roofY + 0.05, 0, {
    r: 0.02,
    col: (x, _y, z) => {
      const shade = 0.72 + 0.2 * valueNoise2d(x * 1.5, z * 1.5 + noiseOffset);
      return [shade, shade, shade * 0.97];
    }
  });
  builder.box(darkMat, width + 0.3, 0.03, depth + 0.34, 0, roofY + 0.112, 0, {
    r: 0.01
  });
  for (const side of [-1, 1])
    builder.box(
      galvMat,
      width + 0.36,
      0.06,
      0.08,
      0,
      roofY - 0.005,
      side * (halfDepth + 0.2 + 0.03),
      {
        r: 0.012
      }
    );
  // Downpipe
  builder.tube(
    galvMat,
    [
      [-halfWidth - 0.16, roofY - 0.03, halfDepth + 0.23],
      [-halfWidth - 0.1, roofY - 0.2, halfDepth + 0.1],
      [-halfWidth - 0.03, roofY - 0.4, halfDepth + 0.03],
      [-halfWidth - 0.03, 0.2, halfDepth + 0.03],
      [-halfWidth - 0.1, 0.06, halfDepth + 0.1]
    ],
    0.03,
    {
      seg: 6,
      tension: 0.2
    }
  );
  // Wall-mounted AC unit with fan grille, brackets and condensate hose
  const acX = -halfWidth - 0.17;
  builder.box(paintMat, 0.3, 0.52, 0.78, acX, 0.62, -0.25, {
    r: 0.02
  });
  builder.add(
    paintMat,
    transformGeometry(stadiumGeometry(0.44, 0.44, 6), acX - 0.151, 0.62, -0.14, [
      0,
      -PI_FIXTURES / 2,
      0
    ]),
    [0.06, 0.06, 0.06]
  );
  for (let i = -3; i <= 3; i++)
    builder.add(
      darkMat,
      transformGeometry(
        worldUvBox(0.006, 0.008, Math.sqrt(0.22 * 0.22 - (i * 0.06) ** 2) * 2),
        acX - 0.154,
        0.62 + i * 0.06,
        -0.14
      )
    );
  builder.cyl(darkMat, 0.05, 0.05, 0.012, acX - 0.156, 0.62, -0.14, {
    seg: 8,
    rot: [0, 0, PI_FIXTURES / 2]
  });
  for (const z of [-0.55, 0.05])
    builder.beam(darkMat, [-halfWidth, 0.32, z], [acX - 0.1, 0.34, z], 0.03, 0.03, {
      r: 0
    });
  builder.tube(
    builder.M('rubber'),
    [
      [acX + 0.05, 0.86, 0.14],
      [acX + 0.06, 1, 0.2],
      [-halfWidth - 0.02, 1.25, 0.24],
      [-halfWidth - 0.02, 2.2, 0.24]
    ],
    0.014,
    {
      seg: 5
    }
  );
  // Interior: floor, desk, monitor, keyboard, chair
  builder.add(
    builder.M('floor_epoxy'),
    transformGeometry(metricPlaneGeometry(width - 0.1, depth - 0.1), 0, 0.122, 0, [
      -PI_FIXTURES / 2,
      0,
      0
    ])
  );
  builder.box(woodMat, 0.6, 0.04, depth - 0.3, -halfWidth + 0.4, 0.76, 0, {
    r: 0.008
  });
  for (const z of [-0.85, 0.85])
    builder.box(darkMat, 0.5, 0.64, 0.03, -halfWidth + 0.4, 0.44, z, {
      r: 0.005
    });
  builder.box(polymerMat, 0.05, 0.32, 0.5, -halfWidth + 0.3, 1.02, -0.3, {
    r: 0.01,
    rot: [0, 0.25, 0]
  });
  builder.add(
    game.mats.emissive(0x8fb8e8, 1.6),
    transformGeometry(
      simplePlaneGeometry(0.45, 0.27),
      -halfWidth + 0.3 + 0.027,
      1.02,
      -0.3 - 0.007,
      [0, PI_FIXTURES / 2 + 0.25, 0]
    ),
    null,
    true
  );
  builder.box(polymerMat, 0.05, 0.1, 0.06, -halfWidth + 0.28, 0.83, -0.3, {
    r: 0.008
  });
  builder.box(polymerMat, 0.18, 0.015, 0.22, -halfWidth + 0.28, 0.787, -0.3, {
    r: 0.004
  });
  builder.box(polymerMat, 0.14, 0.02, 0.42, -halfWidth + 0.52, 0.79, -0.25, {
    r: 0.004
  });
  builder.box(polymerMat, 0.46, 0.07, 0.46, -halfWidth + 1, 0.5, -0.2, {
    r: 0.02,
    rot: [0, 0.3, 0]
  });
  builder.box(polymerMat, 0.07, 0.55, 0.42, -halfWidth + 1.22, 0.86, -0.13, {
    r: 0.02,
    rot: [0, 0.3, -0.12]
  });
  builder.cyl(darkMat, 0.025, 0.025, 0.36, -halfWidth + 1, 0.3, -0.2, {
    seg: 6
  });
  for (let i = 0; i < 5; i++) {
    const angle = i * PI_FIXTURES * 0.4;
    builder.beam(
      darkMat,
      [-halfWidth + 1, 0.16, -0.2],
      [-halfWidth + 1 + Math.cos(angle) * 0.26, 0.14, -0.2 + Math.sin(angle) * 0.26],
      0.03,
      0.025,
      {
        r: 0
      }
    );
  }
  // Door lamp and decals
  builder.box(darkMat, 0.2, 0.07, 0.1, doorX, windowTop + 0.19, halfDepth + 0.03, {
    r: 0.012
  });
  builder.add(
    game.mats.emissive(0xffd9a6, options.on === false ? 0.02 : 5),
    transformGeometry(
      simplePlaneGeometry(0.17, 0.05),
      doorX,
      windowTop + 0.152,
      halfDepth + 0.035,
      [PI_FIXTURES / 2, 0, 0]
    ),
    null,
    true
  );
  builder.decal(
    labelDecal(game, 'GATE CONTROL', {
      color: 'black',
      font: 'stencil',
      distress: 0.2
    }),
    0.1,
    -0.45,
    (roofY + windowTop) / 2,
    halfDepth - 0.003,
    null,
    0.9
  );
  builder.decal(namedDecal(game, 'berth4'), 0.34, halfWidth - 0.003, 0.56, 0.3, [
    0,
    PI_FIXTURES / 2,
    0
  ]);
  builder.decal(namedDecal(game, 'no_entry'), 0.2, doorX, 0.72, frontZ + 0.0265, null);
  builder.decal(namedDecal(game, 'grime_streak'), 0.7, -0.6, 0.55, halfDepth - 0.003, null, 0.3);
  builder.decal(
    namedDecal(game, 'rust_run'),
    0.6,
    -halfWidth + 0.003 - 0,
    0.6,
    0.55,
    [0, -PI_FIXTURES / 2, 0],
    0.25
  );
  const group = builder.group();
  const lamps: LampInfo[] = [
    {
      pos: [doorX, windowTop + 0.14, halfDepth + 0.04],
      dir: [0, -1, 0.2],
      color: 0xffd9a6
    }
  ];
  group.userData.lamps = lamps;
  return finalizeProp(group, 'guard_booth', fixtureSize('guard_booth'), [
    {
      min: [-halfWidth, 0, -halfDepth],
      max: [halfWidth, 2.54, halfDepth],
      surface: 'metal'
    }
  ]);
}

interface GateArmOptions extends SeedOptions {
  /** Boom raise amount 0..1. */
  open?: number;
}

/** Boom barrier: drive cabinet, striped boom (raised by `open`) and a boom rest post. */
function buildGateArm(game: Game, options: GateArmOptions = {}): Group {
  const builder = new PropBuilder(game);
  const open = MathUtils.clamp(options.open || 0, 0, 1);
  const cabinetMat = builder.M('paint_orange', {
    vertexColors: true
  });
  const whiteMat = builder.M('paint_white');
  const redMat = builder.M('paint_red');
  const darkMat = builder.M('steel_dark');
  const galvMat = builder.M('steel_galv');
  const yellowMat = builder.M('paint_yellow');
  const cabinetX = -2.5 + 0.19;
  const pivotY = 0.92;
  // Drive cabinet
  builder.box(builder.M('concrete'), 0.5, 0.06, 0.46, cabinetX, 0.03, 0, {
    r: 0.015
  });
  builder.box(cabinetMat, 0.36, 1, 0.3, cabinetX, 0.56, 0, {
    r: 0.02,
    col: (_x, y) => {
      const shade = 0.6 + 0.4 * smoothstep(0.05, 0.5, y);
      return [shade, shade, shade];
    }
  });
  builder.box(darkMat, 0.4, 0.04, 0.34, cabinetX, 1.075, 0, {
    r: 0.012
  });
  builder.box(cabinetMat, 0.3, 0.6, 0.012, cabinetX, 0.5, 0.151, {
    r: 0.004,
    col: [0.9, 0.9, 0.9]
  });
  builder.cyl(galvMat, 0.012, 0.012, 0.016, cabinetX + 0.1, 0.5, 0.16, {
    seg: 6,
    rot: [PI_FIXTURES / 2, 0, 0]
  });
  builder.decal(namedDecal(game, 'hazard_general'), 0.14, cabinetX, 0.9, 0.153, null);
  builder.decal(namedDecal(game, 'caution_stripes'), 0.08, cabinetX, 0.12, 0.153, null, 0.34);
  builder.cyl(darkMat, 0.03, 0.03, 0.05, cabinetX, 1.12, 0, {
    seg: 8
  });
  builder.add(
    game.mats.emissive(0xff5a1e, 2.2),
    transformGeometry(worldUvCylinder(0.026, 0.026, 0.045, 8), cabinetX, 1.165, 0),
    null,
    true
  );
  // Boom (rotates about the pivot)
  builder.push(makeTransformMatrix(cabinetX, pivotY, 0, [0, 0, open * 1.48]));
  builder.cyl(darkMat, 0.075, 0.075, 0.36, 0, 0, 0, {
    seg: 10,
    rot: [PI_FIXTURES / 2, 0, 0]
  });
  for (const side of [-1, 1])
    builder.box(darkMat, 0.62, 0.11, 0.012, 0.05, 0, side * 0.175, {
      r: 0.004
    });
  builder.box(darkMat, 0.3, 0.16, 0.3, -0.33, -0.02, 0, {
    r: 0.02
  });
  const boomLength = 4.62;
  const boomStart = 0.12;
  const stripeCount = 9;
  const stripeLength = boomLength / stripeCount;
  for (let i = 0; i < stripeCount; i++)
    builder.box(
      i % 2 ? whiteMat : redMat,
      stripeLength + 0.001,
      0.1 - i * 0.003,
      0.05,
      boomStart + stripeLength * (i + 0.5),
      0,
      0,
      {
        r: 0.008
      }
    );
  builder.box(darkMat, 0.03, 0.11, 0.06, boomStart + boomLength + 0.012, 0, 0, {
    r: 0.008
  });
  builder.add(
    game.mats.emissive(0xff2a12, 1.5),
    transformGeometry(worldUvBox(0.05, 0.03, 0.054), boomStart + boomLength - 0.5, 0.058, 0),
    null,
    true
  );
  builder.pop();
  // Boom rest post
  const restX = 2.5 - 0.1;
  builder.box(builder.M('concrete'), 0.3, 0.05, 0.3, restX, 0.025, 0, {
    r: 0.012
  });
  builder.cyl(yellowMat, 0.04, 0.04, 0.8, restX, 0.45, 0, {
    seg: 8
  });
  builder.box(yellowMat, 0.14, 0.02, 0.16, restX, 0.855, 0, {
    r: 0.005
  });
  for (const side of [-1, 1])
    builder.box(yellowMat, 0.14, 0.14, 0.014, restX, 0.93, side * 0.073, {
      r: 0.004
    });
  builder.cyl(galvMat, 0.07, 0.07, 0.01, restX, 0.055, 0, {
    seg: 8
  });
  const colliders: PropCollider[] = [
    {
      min: [cabinetX - 0.2, 0, -0.17],
      max: [cabinetX + 0.2, 1.1, 0.17],
      surface: 'metal'
    },
    {
      min: [restX - 0.07, 0, -0.08],
      max: [restX + 0.07, 1, 0.08],
      surface: 'metal'
    }
  ];
  if (open < 0.5) {
    colliders.push({
      min: [cabinetX, pivotY - 0.07, -0.04],
      max: [restX, pivotY + 0.07, 0.04],
      surface: 'metal'
    });
  }
  return finalizeProp(builder.group(), 'gate_arm', fixtureSize('gate_arm'), colliders);
}

/** Cast-iron mooring bollard on a base plate. */
function buildMooringBollard(game: Game, options: SeedOptions = {}): Group {
  const builder = new PropBuilder(game);
  const noiseOffset = (options.seed! | 0) * 2.1;
  const ironMat = builder.M('steel_dark', {
    vertexColors: true
  });
  const rustMat = builder.M('steel_rust');
  /** Mottled iron, polished where mooring lines rub around the waist. */
  const ironColor = (x: number, y: number, z: number): Rgb => {
    const ropeWear = smoothstep(0.3, 0.4, y) * smoothstep(0.47, 0.4, y);
    const shade = 0.75 + 0.4 * valueNoise2d(x * 6 + noiseOffset, z * 6 + y * 4) + ropeWear * 0.9;
    return [shade, shade * 0.97, shade * 0.93];
  };
  builder.defCol.set(ironMat, ironColor);
  builder.cyl(ironMat, 0.34, 0.35, 0.045, 0, 0.0225, 0, {
    seg: 20
  });
  builder.cyl(rustMat, 0.37, 0.37, 0.006, 0, 0.003, 0, {
    seg: 20
  });
  // Anchor bolts
  for (let i = 0; i < 6; i++) {
    const angle = (i * PI_FIXTURES) / 3 + 0.3;
    builder.cyl(
      rustMat,
      0.026,
      0.026,
      0.03,
      Math.cos(angle) * 0.285,
      0.058,
      Math.sin(angle) * 0.285,
      {
        seg: 6,
        flat: true
      }
    );
    builder.cyl(
      rustMat,
      0.013,
      0.013,
      0.022,
      Math.cos(angle) * 0.285,
      0.08,
      Math.sin(angle) * 0.285,
      {
        seg: 6
      }
    );
  }
  builder.add(
    ironMat,
    latheFromPoints(
      [
        [0.25, 0.045],
        [0.21, 0.08],
        [0.165, 0.16],
        [0.145, 0.27],
        [0.15, 0.36],
        [0.17, 0.43],
        [0.19, 0.5],
        [0.17, 0.57],
        [0.1, 0.6],
        [0, 0.602]
      ],
      18
    )
  );
  // Cross horn
  builder.cyl(ironMat, 0.105, 0.115, 0.5, 0, 0.485, 0, {
    seg: 14,
    open: true,
    rot: [0, 0, PI_FIXTURES / 2]
  });
  for (const side of [-1, 1]) {
    const hornCap = sphereSegmentGeometry(0.108, 14, 8);
    hornCap.scale(0.55, 1, 1);
    builder.add(ironMat, transformGeometry(hornCap, side * 0.25, 0.485, 0));
    builder.cyl(ironMat, 0.125, 0.125, 0.03, side * 0.235, 0.485, 0, {
      seg: 14,
      rot: [0, 0, PI_FIXTURES / 2]
    });
  }
  return finalizeProp(builder.group(), 'bollard_mooring', fixtureSize('bollard_mooring'), [
    {
      min: [-0.3, 0, -0.22],
      max: [0.3, 0.6, 0.22],
      surface: 'metal'
    }
  ]);
}

/** Yellow traffic bollard post with reflective bands, on a bolted base plate. */
function buildBollardPost(game: Game, options: SeedOptions = {}): Group {
  const builder = new PropBuilder(game);
  const noiseOffset = (options.seed! | 0) * 1.7;
  const paintMat = builder.M('paint_yellow', {
    vertexColors: true
  });
  const galvMat = builder.M('steel_galv');
  const radius = 0.083;
  const isBand = (y: number): boolean => (y > 0.6 && y < 0.69) || (y > 0.78 && y < 0.87);
  const breaks = [0.012, 0.3, 0.6, 0.6001, 0.69, 0.6901, 0.78, 0.7801, 0.87, 0.8701, 0.955];
  for (let i = 0; i < breaks.length - 1; i++) {
    const y0 = breaks[i];
    const y1 = breaks[i + 1];
    if (y1 - y0 < 0.001) continue;
    const band = isBand((y0 + y1) / 2);
    builder.cyl(paintMat, radius, radius, y1 - y0, 0, (y0 + y1) / 2, 0, {
      seg: 14,
      open: true,
      col: (x, y, z) => {
        if (band) return [0.05, 0.05, 0.05];
        const shade =
          (0.55 + 0.45 * smoothstep(0, 0.35, y)) *
          (0.9 + 0.2 * valueNoise2d(x * 30 + noiseOffset, y * 6 + z * 30));
        return [shade, shade * 0.97, shade * 0.9];
      }
    });
  }
  const cap = sphereSegmentGeometry(radius, 14, 5, PI_FIXTURES * 2, 0, PI_FIXTURES / 2);
  cap.scale(1, 0.55, 1);
  builder.add(paintMat, transformGeometry(cap, 0, 0.955, 0), [0.95, 0.93, 0.88]);
  builder.cyl(galvMat, 0.085, 0.085, 0.012, 0, 0.006, 0, {
    seg: 4,
    rot: [0, PI_FIXTURES / 4, 0]
  });
  builder.box(galvMat, 0.17, 0.012, 0.17, 0, 0.006, 0, {
    r: 0.004
  });
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      builder.cyl(galvMat, 0.011, 0.011, 0.012, sx * 0.066, 0.017, sz * 0.066, {
        seg: 6
      });
  builder.cyl(paintMat, radius + 0.006, radius + 0.006, 0.02, 0, 0.022, 0, {
    seg: 14,
    open: true,
    col: [0.5, 0.48, 0.42]
  });
  return finalizeProp(builder.group(), 'bollard_post', fixtureSize('bollard_post'), [
    {
      min: [-0.085, 0, -0.085],
      max: [0.085, 1, 0.085],
      surface: 'metal'
    }
  ]);
}

const SIGN_DECALS = [
  'hazard_general',
  'no_entry',
  'hazard_voltage',
  'berth4',
  'arrow',
  'hazard_flammable'
];
const SIGN_TEXTS = [
  'AUTHORISED PERSONNEL ONLY',
  'NO PEDESTRIANS',
  'HI-VIS AND HELMET',
  'AUTOMATED VEHICLES',
  'KEEP CLEAR'
];

interface SignPostOptions extends SeedOptions {
  /** Sign decal name (one of SIGN_DECALS); picked from the seed otherwise. */
  sign?: string;
  /** Text of the lower plate; picked from the seed otherwise. */
  text?: string;
}

/** Sign post with a pictogram plate and a text plate. */
function buildSignPost(game: Game, options: SignPostOptions = {}): Group {
  const builder = new PropBuilder(game);
  const seed = options.seed! | 0;
  const galvMat = builder.M('steel_galv');
  const aluMat = builder.M('aluminium');
  const whiteMat = builder.M('paint_white');
  const yellowMat = builder.M('paint_yellow');
  const sign = SIGN_DECALS.includes(options.sign as string)
    ? (options.sign as string)
    : SIGN_DECALS[seed % SIGN_DECALS.length];
  builder.box(builder.M('concrete'), 0.3, 0.07, 0.3, 0, 0.03, 0, {
    r: 0.015
  });
  builder.box(galvMat, 0.05, 2.38, 0.05, 0, 1.2, 0, {
    r: 0.006
  });
  builder.box(galvMat, 0.058, 0.012, 0.058, 0, 2.395, 0, {
    r: 0.004
  });
  builder.box(galvMat, 0.13, 0.012, 0.13, 0, 0.07, 0, {
    r: 0.003
  });
  // Slightly crooked plates
  const tilt = ((seed % 5) - 2) * 0.006;
  builder.push(makeTransformMatrix(0, 0, 0, [0, 0, tilt]));
  builder.box(aluMat, 0.6, 0.6, 0.004, 0, 2.02, 0.031, {
    r: 0.0015
  });
  builder.box(sign.startsWith('hazard') ? yellowMat : whiteMat, 0.58, 0.58, 0.002, 0, 2.02, 0.034, {
    r: 0.0008
  });
  builder.decal(namedDecal(game, sign), 0.5, 0, 2.02, 0.0362, null, 0.5);
  builder.box(aluMat, 0.6, 0.22, 0.004, 0, 1.56, 0.031, {
    r: 0.0015
  });
  builder.box(whiteMat, 0.58, 0.2, 0.002, 0, 1.56, 0.034, {
    r: 0.0008
  });
  builder.decal(
    labelDecal(game, options.text || SIGN_TEXTS[seed % SIGN_TEXTS.length], {
      color: 'black',
      font: 'sans',
      distress: 0.15
    }),
    0.07,
    0,
    1.56,
    0.0362,
    null,
    0.52
  );
  // Mounting straps and clamps
  for (const y of [1.85, 2.2, 1.56]) {
    builder.box(galvMat, 0.5, 0.03, 0.012, 0, y, 0.024, {
      r: 0
    });
    builder.box(galvMat, 0.09, 0.04, 0.07, 0, y, -0.002, {
      r: 0.004
    });
  }
  // Rivets
  for (const [x, y] of [
    [-0.26, 2.28],
    [0.26, 2.28],
    [-0.26, 1.76],
    [0.26, 1.76]
  ])
    builder.cyl(galvMat, 0.008, 0.008, 0.004, x, y, 0.0365, {
      seg: 6,
      rot: [PI_FIXTURES / 2, 0, 0]
    });
  builder.pop();
  return finalizeProp(builder.group(), 'sign_post', fixtureSize('sign_post'), [
    {
      min: [-0.03, 0, -0.03],
      max: [0.03, 2.4, 0.03],
      surface: 'metal'
    },
    {
      min: [-0.3, 1.44, 0.02],
      max: [0.3, 2.33, 0.04],
      surface: 'metal',
      bulletOnly: true
    }
  ]);
}

interface FloodlightStandOptions extends SeedOptions {
  /** Lamps lit (default true). */
  on?: boolean;
}

/** Portable tripod floodlight with two lamp heads and a power cable on the ground. */
function buildFloodlightStand(game: Game, options: FloodlightStandOptions = {}): Group {
  const builder = new PropBuilder(game);
  const seed = options.seed! | 0;
  const rng = seededRandom(seed + 3);
  const yellowMat = builder.M('paint_yellow');
  const darkMat = builder.M('steel_dark');
  const aluMat = builder.M('aluminium');
  const rubberMat = builder.M('rubber');
  const lampMat = game.mats.emissive(0xfff1dc, options.on === false ? 0.02 : 10);
  // Telescoping mast with clamps
  builder.cyl(aluMat, 0.021, 0.021, 1.1, 0, 0.75, 0, {
    seg: 8,
    open: true
  });
  builder.cyl(aluMat, 0.016, 0.016, 0.9, 0, 1.6, 0, {
    seg: 8,
    open: true
  });
  builder.cyl(darkMat, 0.03, 0.03, 0.06, 0, 1.3, 0, {
    seg: 8
  });
  builder.bar(darkMat, [0.03, 1.3, 0], [0.085, 1.3, 0], 0.008, {
    caps: true
  });
  builder.box(darkMat, 0.02, 0.03, 0.05, 0.09, 1.3, 0, {
    r: 0.005
  });
  builder.cyl(darkMat, 0.032, 0.032, 0.07, 0, 0.82, 0, {
    seg: 8
  });
  builder.cyl(darkMat, 0.03, 0.03, 0.05, 0, 0.36, 0, {
    seg: 8
  });
  // Tripod legs, braces and rubber feet
  for (let i = 0; i < 3; i++) {
    const angle = (i * PI_FIXTURES * 2) / 3 + 0.5;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    builder.bar(aluMat, [dx * 0.035, 0.82, dz * 0.035], [dx * 0.5, 0.025, dz * 0.5], 0.013, {
      seg: 6
    });
    builder.bar(aluMat, [dx * 0.03, 0.36, dz * 0.03], [dx * 0.3, 0.37, dz * 0.3], 0.008, {
      seg: 5
    });
    builder.add(
      rubberMat,
      transformGeometry(sphereSegmentGeometry(0.028, 8, 5), dx * 0.5, 0.02, dz * 0.5)
    );
  }
  // Light bar with two heads
  builder.box(darkMat, 0.05, 0.04, 0.72, 0, 2.03, 0, {
    r: 0.008
  });
  for (const side of [-1, 1]) {
    builder.push(makeTransformMatrix(0.03, 2.03, side * 0.2, [0, side * -0.12, 0]));
    builder.push(makeTransformMatrix(0, 0, 0, [0, 0, -0.22]));
    builder.box(yellowMat, 0.075, 0.24, 0.32, 0.06, 0.02, 0, {
      r: 0.012
    });
    builder.add(
      lampMat,
      transformGeometry(simplePlaneGeometry(0.28, 0.2), 0.0985, 0.02, 0, [0, PI_FIXTURES / 2, 0]),
      null,
      true
    );
    builder.box(darkMat, 0.012, 0.25, 0.012, 0.1, 0.02, 0.157, {
      r: 0
    });
    builder.box(darkMat, 0.012, 0.25, 0.012, 0.1, 0.02, -0.157, {
      r: 0
    });
    builder.box(darkMat, 0.012, 0.012, 0.33, 0.1, 0.143, 0, {
      r: 0
    });
    builder.box(darkMat, 0.012, 0.012, 0.33, 0.1, -0.103, 0, {
      r: 0
    });
    for (let i = -3; i <= 3; i++)
      builder.add(
        darkMat,
        transformGeometry(worldUvBox(0.035, 0.2, 0.006), 0.008, 0.02, i * 0.043)
      );
    // Carry handle
    builder.tube(
      yellowMat,
      [
        [0.05, 0.14, -0.1],
        [0.05, 0.2, -0.06],
        [0.05, 0.2, 0.06],
        [0.05, 0.14, 0.1]
      ],
      0.008,
      {
        seg: 5
      }
    );
    builder.pop();
    builder.pop();
  }
  // Power cable trailing off in a random direction, ending in a plug
  const cableAngle = rng() * PI_FIXTURES * 2;
  const cos = Math.cos(cableAngle);
  const sin = Math.sin(cableAngle);
  builder.tube(
    rubberMat,
    [
      [0, 2, 0.03],
      [-0.03, 1.7, 0.04],
      [0.035, 1.25, 0.02],
      [-0.03, 0.9, 0.03],
      [0.05, 0.5, 0.06],
      [0.12, 0.08, 0.1],
      [0.25, 0.012, 0.16],
      [0.3 + cos * 0.3, 0.012, 0.2 + sin * 0.3],
      [0.2 + cos * 0.75 - sin * 0.2, 0.012, 0.1 + sin * 0.75 + cos * 0.2],
      [cos * 1.2, 0.012, sin * 1.2]
    ],
    0.011,
    {
      seg: 5
    }
  );
  builder.box(yellowMat, 0.09, 0.05, 0.06, cos * 1.24, 0.026, sin * 1.24, {
    r: 0.01,
    rot: [0, -cableAngle, 0]
  });
  const group = builder.group();
  const lamps: LampInfo[] = [
    {
      pos: [0.14, 2.03, 0],
      dir: [0.976, -0.218, 0],
      color: 0xfff1dc
    }
  ];
  group.userData.lamps = lamps;
  return finalizeProp(group, 'floodlight_stand', fixtureSize('floodlight_stand'), [
    {
      min: [-0.12, 0, -0.12],
      max: [0.12, 2.2, 0.12],
      surface: 'metal'
    }
  ]);
}

/** `[width, height, depth]` of a structure prop from PROP_SIZES. */
const structureSize = (name: string): number[] => PROP_SIZES[name].slice(0, 3) as number[];
const PI_STRUCTURES = Math.PI;

/** 12-step steel stair with a landing platform, handrails and colliders per step. */
function buildMetalStairs(game: Game, _options: SeedOptions = {}): Group {
  const builder = new PropBuilder(game);
  const plateMat = builder.M('diamond_plate');
  const darkMat = builder.M('steel_dark');
  const yellowMat = builder.M('paint_yellow');
  const galvMat = builder.M('steel_galv');
  const stepCount = 12;
  const rise = 0.2;
  const run = 0.2;
  const startX = -1.5;
  const halfWidth = 0.5;
  const topX = startX + stepCount * run;
  const colliders: PropCollider[] = [];
  // Treads with yellow nosings
  for (let i = 0; i < stepCount; i++) {
    const stepY = (i + 1) * rise;
    const stepX = startX + i * run;
    builder.box(plateMat, 0.25, 0.03, 0.9, stepX + 0.125, stepY - 0.015, 0, {
      r: 0.005
    });
    builder.box(yellowMat, 0.035, 0.034, 0.9, stepX + 0.016, stepY - 0.015, 0, {
      r: 0.006
    });
    for (const side of [-1, 1])
      builder.box(darkMat, 0.2, 0.05, 0.01, stepX + 0.13, stepY - 0.05, side * 0.452, {
        r: 0
      });
    colliders.push({
      min: [stepX, 0, -halfWidth],
      max: [stepX + run, stepY, halfWidth],
      surface: 'metal'
    });
  }
  // Stringers and foot plates
  for (const side of [-1, 1]) {
    builder.beam(
      darkMat,
      [startX + 0.07, 0.13, side * 0.465],
      [topX + 0.04, 2.5, side * 0.465],
      0.24,
      0.014,
      {
        r: 0.004
      }
    );
    builder.box(galvMat, 0.3, 0.012, 0.12, startX + 0.06, 0.006, side * 0.465, {
      r: 0
    });
    for (const boltX of [-0.08, 0.1])
      builder.cyl(galvMat, 0.012, 0.012, 0.02, startX + 0.06 + boltX, 0.02, side * 0.5, {
        seg: 6
      });
  }
  // Landing
  const landingY = (stepCount + 1) * rise;
  builder.box(plateMat, 0.64, 0.035, 0.96, topX + 0.3, landingY - 0.0175, 0, {
    r: 0.005
  });
  builder.box(yellowMat, 0.035, 0.038, 0.96, topX + 0.016, landingY - 0.0175, 0, {
    r: 0.006
  });
  for (const side of [-1, 1])
    builder.box(darkMat, 0.66, 0.16, 0.06, topX + 0.3, landingY - 0.115, side * 0.47, {
      r: 0.008
    });
  builder.box(darkMat, 0.06, 0.16, 0.96, 1.47, landingY - 0.115, 0, {
    r: 0.008
  });
  builder.box(darkMat, 0.06, 0.12, 0.9, topX + 0.02, landingY - 0.1, 0, {
    r: 0.008
  });
  // Landing legs, braces
  for (const side of [-1, 1]) {
    builder.box(darkMat, 0.08, landingY - 0.19, 0.08, 1.44, (landingY - 0.19) / 2, side * 0.45, {
      r: 0.008
    });
    builder.box(galvMat, 0.18, 0.012, 0.18, 1.44, 0.006, side * 0.45, {
      r: 0
    });
    builder.beam(
      darkMat,
      [1.44, 1.5, side * 0.45],
      [topX + 0.1, landingY - 0.2, side * 0.45],
      0.05,
      0.05,
      {
        r: 0.006
      }
    );
  }
  builder.beam(darkMat, [1.44, 0.15, -0.42], [1.44, 2.2, 0.42], 0.045, 0.008, {
    r: 0
  });
  builder.beam(darkMat, [1.44, 0.15, 0.42], [1.44, 2.2, -0.42], 0.045, 0.008, {
    r: 0
  });
  builder.box(darkMat, 0.06, 0.06, 0.82, 1.44, 1.2, 0, {
    r: 0.006
  });
  colliders.push({
    min: [topX, landingY - 0.2, -halfWidth],
    max: [1.5, landingY, halfWidth],
    surface: 'metal'
  });
  for (const side of [-1, 1])
    colliders.push({
      min: [1.4, 0, side * 0.45 - 0.04],
      max: [1.48, landingY - 0.2, side * 0.45 + 0.04],
      surface: 'metal'
    });
  // Handrails
  const stairHeightAt = (x: number): number => ((x - startX) / run) * rise + rise;
  for (const side of [-1, 1]) {
    const railZ = side * 0.485;
    const posts = [
      [startX + 0.1, stairHeightAt(startX + 0.1)],
      [startX + 0.9, stairHeightAt(startX + 0.9) - 0.1],
      [startX + 1.7, stairHeightAt(startX + 1.7) - 0.1],
      [topX + 0.03, landingY],
      [1.47, landingY]
    ];
    for (const [x, y] of posts) {
      builder.bar(yellowMat, [x, y - 0.12, railZ], [x, y + 1, railZ], 0.019, {
        seg: 7
      });
      builder.box(darkMat, 0.07, 0.1, 0.012, x, y - 0.1, railZ - side * 0.012, {
        r: 0
      });
    }
    for (const railHeight of [1, 0.52]) {
      const railRadius = railHeight === 1 ? 0.021 : 0.016;
      builder.bar(
        yellowMat,
        [posts[0][0], posts[0][1] + railHeight, railZ],
        [posts[3][0], posts[3][1] + railHeight, railZ],
        railRadius,
        {
          seg: 7
        }
      );
      builder.bar(
        yellowMat,
        [posts[3][0], posts[3][1] + railHeight, railZ],
        [posts[4][0], posts[4][1] + railHeight, railZ],
        railRadius,
        {
          seg: 7
        }
      );
      builder.add(
        yellowMat,
        transformGeometry(
          sphereSegmentGeometry(railRadius * 1.05, 7, 5),
          posts[3][0],
          posts[3][1] + railHeight,
          railZ
        )
      );
      builder.add(
        yellowMat,
        transformGeometry(
          sphereSegmentGeometry(railRadius * 1.05, 7, 5),
          posts[0][0],
          posts[0][1] + railHeight,
          railZ
        )
      );
      builder.add(
        yellowMat,
        transformGeometry(
          sphereSegmentGeometry(railRadius * 1.05, 7, 5),
          posts[4][0],
          posts[4][1] + railHeight,
          railZ
        )
      );
    }
    // Toe board
    builder.box(darkMat, 0.6, 0.1, 0.008, topX + 0.3, landingY + 0.05, side * 0.476, {
      r: 0
    });
    colliders.push({
      min: [topX, landingY, railZ - 0.03],
      max: [1.5, landingY + 1.02, railZ + 0.03],
      surface: 'metal'
    });
  }
  return finalizeProp(builder.group(), 'stairs_metal', structureSize('stairs_metal'), colliders);
}

interface CatwalkOptions extends SeedOptions {
  /** Which sides get handrails: 'both' (default), 'left', 'right' or anything else for none. */
  rails?: string;
}

/** 3 m grating catwalk section with optional handrails. */
function buildCatwalk(game: Game, options: CatwalkOptions = {}): Group {
  const builder = new PropBuilder(game);
  const darkMat = builder.M('steel_dark');
  const yellowMat = builder.M('paint_yellow');
  const galvMat = builder.M('steel_galv');
  const rails = options.rails || 'both';
  const railSides =
    rails === 'both' ? [-1, 1] : rails === 'left' ? [-1] : rails === 'right' ? [1] : [];
  const deckY = 0.05;
  // Bar grating
  for (let z = -0.51; z <= 0.511; z += 0.034)
    builder.add(galvMat, transformGeometry(worldUvBox(2.98, 0.03, 0.004), 0, deckY - 0.015, z));
  for (let x = -1.45; x <= 1.451; x += 0.1)
    builder.add(galvMat, transformGeometry(worldUvBox(0.006, 0.006, 1.04), x, deckY - 0.004, 0));
  for (const side of [-1, 1]) {
    builder.add(
      galvMat,
      transformGeometry(worldUvBox(2.99, 0.032, 0.005), 0, deckY - 0.016, side * 0.525)
    );
    builder.add(
      galvMat,
      transformGeometry(worldUvBox(0.005, 0.032, 1.05), side * 1.493, deckY - 0.016, 0)
    );
  }
  // Side channels and cross members
  for (const side of [-1, 1])
    builder.box(darkMat, 3, 0.18, 0.06, 0, deckY - 0.09, side * 0.565, {
      r: 0.008
    });
  for (const x of [-1.45, -0.5, 0.5, 1.45])
    builder.box(darkMat, 0.05, 0.1, 1.08, x, deckY - 0.085, 0, {
      r: 0.006
    });
  const colliders: PropCollider[] = [
    {
      min: [-1.5, deckY - 0.08, -0.6],
      max: [1.5, deckY, 0.6],
      surface: 'metal'
    }
  ];
  for (const side of railSides) {
    const railZ = side * 0.565;
    builder.box(darkMat, 3, 0.1, 0.008, 0, deckY + 0.05, side * 0.535, {
      r: 0
    });
    for (const postX of [-1.42, 0, 1.42]) {
      builder.box(yellowMat, 0.045, 1.07, 0.045, postX, deckY + 0.52, railZ, {
        r: 0.006
      });
      builder.box(darkMat, 0.09, 0.012, 0.09, postX, deckY + 0.006, railZ, {
        r: 0
      });
    }
    builder.bar(yellowMat, [-1.5, deckY + 1.05, railZ], [1.5, deckY + 1.05, railZ], 0.021, {
      seg: 7,
      caps: true
    });
    builder.bar(yellowMat, [-1.5, deckY + 0.55, railZ], [1.5, deckY + 0.55, railZ], 0.016, {
      seg: 6,
      caps: true
    });
    colliders.push({
      min: [-1.5, deckY, railZ - 0.035],
      max: [1.5, deckY + 1.05, railZ + 0.035],
      surface: 'metal'
    });
  }
  return finalizeProp(builder.group(), 'catwalk', structureSize('catwalk'), colliders);
}

/** Euro pallet (1.2 x 1.0) at (x, y, z): top boards, stringers, blocks and bottom boards. */
function addPallet(builder: PropBuilder, woodMat: Material, x: number, y: number, z: number): void {
  for (let i = -2; i <= 2; i++)
    builder.add(
      woodMat,
      transformGeometry(
        worldUvBox(0.14 + (i === 0 ? 0.02 : 0), 0.022, 1),
        x + i * 0.2525,
        y + 0.133,
        z
      )
    );
  for (const row of [-1, 0, 1])
    builder.add(
      woodMat,
      transformGeometry(worldUvBox(1.15, 0.022, 0.1), x, y + 0.111, z + row * 0.45)
    );
  for (const row of [-1, 0, 1])
    for (const col of [-1, 0, 1])
      builder.add(
        woodMat,
        transformGeometry(worldUvBox(0.14, 0.078, 0.1), x + col * 0.505, y + 0.061, z + row * 0.45)
      );
  for (const row of [-1, 0, 1])
    builder.add(
      woodMat,
      transformGeometry(worldUvBox(1.15, 0.022, 0.1), x, y + 0.011, z + row * 0.45)
    );
}

/** Materials used for pallet loads on the shelf rack. */
interface PalletLoadMaterials {
  wood: Material;
  card: Material;
  tape: Material;
  poly: Material;
  wrap: Material;
  drum: Material;
  drum2: Material;
  dark: Material;
}

/** A pallet with a load of `kind` ('cartons' | 'wrapped' | 'drums' | 'pallets'); randomised by `rng`. */
function addPalletLoad(
  builder: PropBuilder,
  mats: PalletLoadMaterials,
  kind: string,
  x: number,
  y: number,
  z: number,
  rng: () => number
): void {
  addPallet(builder, mats.wood, x, y, z);
  const loadY = y + 0.144;
  if (kind === 'cartons') {
    const layers = 2 + Math.floor(rng() * 2);
    const cartonHeight = 0.36;
    for (let layer = 0; layer < layers; layer++)
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          // Some cartons missing from the top layer
          if (layer === layers - 1 && rng() < 0.25) continue;
          builder.box(
            mats.card,
            0.53,
            cartonHeight - 0.006,
            0.46,
            x + sx * 0.272 + (rng() - 0.5) * 0.02,
            loadY + cartonHeight * (layer + 0.5),
            z + sz * 0.237 + (rng() - 0.5) * 0.02,
            {
              r: 0.008,
              rot: [0, (rng() - 0.5) * 0.05, 0]
            }
          );
          builder.add(
            mats.tape,
            transformGeometry(
              worldUvBox(0.535, 0.002, 0.05),
              x + sx * 0.272,
              loadY + cartonHeight * (layer + 1) - 0.004,
              z + sz * 0.237
            )
          );
        }
    // Strapping
    for (const strapX of [-0.3, 0.3]) {
      builder.add(
        mats.poly,
        transformGeometry(
          worldUvBox(0.016, layers * cartonHeight + 0.004, 0.002),
          x + strapX,
          loadY + (layers * cartonHeight) / 2,
          z + 0.475
        )
      );
      builder.add(
        mats.poly,
        transformGeometry(
          worldUvBox(0.016, layers * cartonHeight + 0.004, 0.002),
          x + strapX,
          loadY + (layers * cartonHeight) / 2,
          z - 0.475
        )
      );
    }
  } else if (kind === 'wrapped') {
    const loadHeight = 0.9 + rng() * 0.25;
    builder.box(mats.card, 1.08, loadHeight, 0.92, x, loadY + loadHeight / 2, z, {
      r: 0.012
    });
    builder.box(mats.wrap, 1.1, loadHeight + 0.012, 0.94, x, loadY + loadHeight / 2 + 0.002, z, {
      r: 0.03
    });
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        builder.box(
          mats.card,
          0.05,
          loadHeight * 0.96,
          0.05,
          x + sx * 0.535,
          loadY + loadHeight / 2,
          z + sz * 0.455,
          {
            r: 0.004
          }
        );
    builder.decal(
      labelDecal(builder.G, 'LOT ' + (1000 + Math.floor(rng() * 8999)), {
        color: 'black',
        font: 'sans',
        distress: 0.1
      }),
      0.06,
      x + 0.2,
      loadY + loadHeight * 0.7,
      z + 0.474,
      null,
      0.3
    );
  } else if (kind === 'drums') {
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const drumX = x + sx * 0.285;
        const drumZ = z + sz * 0.24;
        const drumMat = rng() < 0.3 ? mats.drum2 : mats.drum;
        builder.cyl(drumMat, 0.225, 0.225, 0.86, drumX, loadY + 0.43, drumZ, {
          seg: 14,
          open: true
        });
        for (const ribY of [0.29, 0.58])
          builder.cyl(drumMat, 0.233, 0.233, 0.022, drumX, loadY + ribY, drumZ, {
            seg: 14,
            open: true
          });
        builder.cyl(drumMat, 0.232, 0.232, 0.02, drumX, loadY + 0.85, drumZ, {
          seg: 14,
          open: true
        });
        builder.cyl(drumMat, 0.232, 0.232, 0.02, drumX, loadY + 0.01, drumZ, {
          seg: 14,
          open: true
        });
        builder.add(
          mats.dark,
          transformGeometry(stadiumGeometry(0.44, 0.44, 4), drumX, loadY + 0.845, drumZ, [
            -PI_STRUCTURES / 2,
            0,
            0
          ])
        );
        builder.cyl(mats.dark, 0.03, 0.03, 0.02, drumX + 0.13, loadY + 0.855, drumZ, {
          seg: 6
        });
      }
    builder.add(
      mats.poly,
      transformGeometry(worldUvBox(1.04, 0.03, 0.002), x, loadY + 0.6, z + 0.468)
    );
    builder.add(
      mats.poly,
      transformGeometry(worldUvBox(1.04, 0.03, 0.002), x, loadY + 0.6, z - 0.468)
    );
  } else if (kind === 'pallets') {
    const count = 2 + Math.floor(rng() * 4);
    for (let i = 0; i < count; i++)
      addPallet(
        builder,
        mats.wood,
        x + (rng() - 0.5) * 0.04,
        loadY + i * 0.146,
        z + (rng() - 0.5) * 0.04
      );
  }
}

/** Two-bay pallet rack (three levels) with random pallet loads. */
function buildShelfRack(game: Game, options: SeedOptions = {}): Group {
  const builder = new PropBuilder(game);
  const seed = options.seed! | 0;
  const rng = seededRandom(seed + 21);
  const frameMat = builder.M('paint_blue', {
    vertexColors: true
  });
  const beamMat = builder.M('paint_orange');
  const galvMat = builder.M('steel_galv');
  const loadMats: PalletLoadMaterials = {
    wood: builder.M('wood_pallet'),
    card: builder.M('cardboard'),
    tape: builder.M('polymer_tan'),
    poly: builder.M('polymer_black'),
    wrap: builder.M('glass_dirty'),
    drum: builder.M('plastic_blue'),
    drum2: builder.M('paint_red'),
    dark: builder.M('steel_dark')
  };
  const height = 4.2;
  const halfSpan = 1.305;
  const halfDepth = 0.5;
  const SLOT_COLOR = [0.04, 0.04, 0.05];
  // Upright frames
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      builder.box(frameMat, 0.09, height, 0.07, sx * halfSpan, height / 2, sz * halfDepth, {
        r: 0.008,
        col: (_x, y) => {
          const shade = 0.7 + 0.3 * smoothstep(0, 0.5, y);
          return [shade, shade, shade];
        }
      });
      builder.box(galvMat, 0.14, 0.01, 0.12, sx * halfSpan, 0.005, sz * halfDepth, {
        r: 0
      });
      for (const boltX of [-0.05, 0.05])
        builder.cyl(galvMat, 0.01, 0.01, 0.02, sx * halfSpan + boltX, 0.016, sz * halfDepth, {
          seg: 6
        });
      // Beam slots
      for (let y = 0.12; y < height - 0.05; y += 0.1)
        for (const slotX of [-0.022, 0.022])
          builder.add(
            frameMat,
            transformGeometry(
              simplePlaneGeometry(0.014, 0.034),
              sx * halfSpan + slotX,
              y,
              sz * (halfDepth + 0.0356),
              [0, sz > 0 ? 0 : PI_STRUCTURES, 0]
            ),
            SLOT_COLOR
          );
    }
    // Horizontal and diagonal frame bracing
    const braceYs = [0.2, 1.1, 2, 2.9, 3.8];
    for (let i = 0; i < braceYs.length; i++) {
      builder.box(frameMat, 0.03, 0.03, 2 * halfDepth - 0.07, sx * halfSpan, braceYs[i], 0, {
        r: 0
      });
      if (i < braceYs.length - 1) {
        builder.beam(
          frameMat,
          [sx * halfSpan, braceYs[i], i % 2 ? halfDepth - 0.04 : -halfDepth + 0.04],
          [sx * halfSpan, braceYs[i + 1], i % 2 ? -halfDepth + 0.04 : halfDepth - 0.04],
          0.03,
          0.03,
          {
            r: 0
          }
        );
      }
    }
    // Column guard
    builder.box(builder.M('paint_yellow'), 0.14, 0.4, 0.02, sx * halfSpan, 0.2, halfDepth + 0.06, {
      r: 0.006
    });
  }
  // Beam levels with wire decks
  const levelYs = [1.45, 2.86];
  for (const levelY of levelYs) {
    for (const sz of [-1, 1]) {
      builder.box(beamMat, 2 * halfSpan - 0.09, 0.12, 0.05, 0, levelY, sz * (halfDepth + 0.01), {
        r: 0.008
      });
      for (const sx of [-1, 1])
        builder.box(
          beamMat,
          0.012,
          0.2,
          0.065,
          sx * (halfSpan - 0.051),
          levelY - 0.02,
          sz * (halfDepth + 0.005),
          {
            r: 0
          }
        );
    }
    for (const x of [-0.85, 0, 0.85])
      builder.add(
        galvMat,
        transformGeometry(worldUvBox(0.04, 0.025, 2 * halfDepth), x, levelY + 0.045, 0)
      );
    for (let z = -0.45; z <= 0.451; z += 0.1)
      builder.add(
        galvMat,
        transformGeometry(worldUvBox(2 * halfSpan - 0.1, 0.005, 0.005), 0, levelY + 0.062, z)
      );
    for (let x = -1.2; x <= 1.201; x += 0.2)
      builder.add(
        galvMat,
        transformGeometry(worldUvBox(0.005, 0.005, 2 * halfDepth + 0.04), x, levelY + 0.066, 0)
      );
  }
  builder.decal(
    labelDecal(game, 'BAY ' + String.fromCharCode(65 + (seed % 6)) + '-' + (10 + (seed % 40)), {
      color: 'black',
      font: 'sans',
      distress: 0.1
    }),
    0.07,
    0,
    levelYs[0],
    halfDepth + 0.0365,
    null,
    0.34
  );
  builder.decal(
    labelDecal(game, 'MAX 2000 KG / LEVEL', {
      color: 'black',
      font: 'sans',
      distress: 0.1
    }),
    0.045,
    0.6,
    levelYs[1],
    halfDepth + 0.0365,
    null,
    0.5
  );
  const LOAD_KINDS = ['cartons', 'wrapped', 'drums', 'cartons', 'wrapped', 'pallets', 'none'];
  [0, levelYs[0] + 0.068, levelYs[1] + 0.068].forEach((levelY, level) => {
    for (const side of [-1, 1]) {
      let kind = LOAD_KINDS[Math.floor(rng() * LOAD_KINDS.length)];
      // No drums on the top level
      if (level === 2 && kind === 'drums') kind = 'wrapped';
      if (kind !== 'none') {
        addPalletLoad(
          builder,
          loadMats,
          kind,
          side * 0.615 + (rng() - 0.5) * 0.03,
          levelY,
          (rng() - 0.5) * 0.05,
          rng
        );
      }
    }
  });
  return finalizeProp(builder.group(), 'shelf_rack', structureSize('shelf_rack'), [
    {
      min: [-1.35, 0, -0.55],
      max: [1.35, 4.2, 0.55],
      surface: 'metal'
    }
  ]);
}

interface ReeferUnitOptions extends SeedOptions {
  /** Don't rotate the unit by 180 degrees. */
  flip?: boolean;
}

/** Refrigeration unit for a reefer container: fans, coils, compressor, control box, cables. */
function buildReeferUnit(game: Game, options: ReeferUnitOptions = {}): Group {
  const builder = new PropBuilder(game);
  const seed = options.seed! | 0;
  const noiseOffset = seed * 2.3;
  const bodyMat = builder.M('paint_white', {
    vertexColors: true
  });
  const darkMat = builder.M('steel_dark');
  const galvMat = builder.M('steel_galv');
  const greyMat = builder.M('paint_grey');
  const brassMat = builder.M('brass');
  const rubberMat = builder.M('rubber');
  const aluMat = builder.M('aluminium');
  const bodyColor = (_x: number, y: number, z: number): Rgb => {
    const shade =
      (0.86 + 0.18 * valueNoise2d(z * 2 + noiseOffset, y * 2)) *
      (0.62 + 0.38 * smoothstep(0, 0.6, y));
    return [shade, shade * 0.985, shade * 0.955];
  };
  builder.defCol.set(bodyMat, bodyColor);
  const RECESS_COLOR = [0.05, 0.05, 0.055];
  if (!options.flip) builder.push(makeTransformMatrix(0, 0, 0, [0, PI_STRUCTURES, 0]));
  const faceX = 0.13;
  // Housing and frame
  builder.box(bodyMat, 0.38, 2.3, 2.3, -0.06, 1.15, 0, {
    r: 0.012
  });
  for (const side of [-1, 1])
    builder.box(bodyMat, 0.12, 2.3, 0.09, 0.19, 1.15, side * 1.105, {
      r: 0.012
    });
  builder.box(bodyMat, 0.12, 0.09, 2.12, 0.19, 2.255, 0, {
    r: 0.012
  });
  builder.box(bodyMat, 0.12, 0.1, 2.12, 0.19, 0.05, 0, {
    r: 0.012
  });
  builder.box(bodyMat, 0.1, 0.06, 2.12, 0.18, 1.42, 0, {
    r: 0.01
  });
  builder.box(bodyMat, 0.1, 0.06, 2.12, 0.18, 0.9, 0, {
    r: 0.01
  });
  // Frame bolts
  for (const y of [0.3, 0.9, 1.5, 2.1])
    for (const side of [-1, 1])
      builder.cyl(galvMat, 0.014, 0.014, 0.012, 0.255, y, side * 1.105, {
        seg: 6,
        rot: [0, 0, PI_STRUCTURES / 2]
      });
  for (const z of [-0.8, -0.3, 0.3, 0.8])
    for (const y of [0.05, 2.255])
      builder.cyl(galvMat, 0.014, 0.014, 0.012, 0.255, y, z, {
        seg: 6,
        rot: [0, 0, PI_STRUCTURES / 2]
      });
  // Condenser fans with grilles
  for (const side of [-1, 1]) {
    const fanZ = side * 0.53;
    const fanY = 1.83;
    builder.add(
      bodyMat,
      transformGeometry(stadiumGeometry(0.66, 0.66, 6), faceX + 0.004, fanY, fanZ, [
        0,
        PI_STRUCTURES / 2,
        0
      ]),
      RECESS_COLOR
    );
    builder.cyl(bodyMat, 0.335, 0.345, 0.1, faceX + 0.05, fanY, fanZ, {
      seg: 20,
      open: true,
      rot: [0, 0, PI_STRUCTURES / 2]
    });
    builder.cyl(bodyMat, 0.36, 0.36, 0.014, faceX + 0.006, fanY, fanZ, {
      seg: 20,
      open: true,
      rot: [0, 0, PI_STRUCTURES / 2]
    });
    // Blades
    for (let i = 0; i < 3; i++)
      builder.add(
        darkMat,
        transformGeometry(worldUvBox(0.012, 0.6, 0.12), faceX + 0.04, fanY, fanZ, [
          (i * PI_STRUCTURES) / 3 + side * 0.4,
          0.5,
          0
        ])
      );
    builder.cyl(darkMat, 0.07, 0.07, 0.06, faceX + 0.05, fanY, fanZ, {
      seg: 10,
      rot: [0, 0, PI_STRUCTURES / 2]
    });
    // Grille spokes and rings
    for (let i = 0; i < 8; i++) {
      const angle = (i * PI_STRUCTURES) / 4;
      builder.add(
        galvMat,
        transformGeometry(worldUvBox(0.005, 0.66, 0.005), faceX + 0.098, fanY, fanZ, [angle, 0, 0])
      );
    }
    for (const ringRadius of [0.12, 0.22, 0.32])
      builder.cyl(galvMat, ringRadius, ringRadius, 0.006, faceX + 0.1, fanY, fanZ, {
        seg: 20,
        open: true,
        rot: [0, 0, PI_STRUCTURES / 2]
      });
  }
  builder.decal(
    labelDecal(game, 'KELVAR  MARINE  REFRIGERATION', {
      color: 'black',
      font: 'sans',
      distress: 0.2
    }),
    0.05,
    0.2505,
    2.255,
    0,
    [0, PI_STRUCTURES / 2, 0],
    1.2
  );
  // Louvred coil panels
  for (const side of [-1, 1]) {
    builder.add(
      bodyMat,
      transformGeometry(simplePlaneGeometry(0.98, 0.44), faceX + 0.004, 1.16, side * 0.53, [
        0,
        PI_STRUCTURES / 2,
        0
      ]),
      RECESS_COLOR
    );
    for (let i = 0; i < 9; i++)
      builder.box(bodyMat, 0.06, 0.006, 0.98, faceX + 0.035, 0.965 + i * 0.049, side * 0.53, {
        r: 0,
        rot: [0, 0, -0.75]
      });
    builder.box(bodyMat, 0.05, 0.46, 0.03, faceX + 0.03, 1.16, side * 0.53, {
      r: 0.005
    });
  }
  // Compressor bay: receiver tank, drier, brass piping
  builder.add(
    bodyMat,
    transformGeometry(simplePlaneGeometry(1, 0.76), faceX + 0.004, 0.49, -0.53, [
      0,
      PI_STRUCTURES / 2,
      0
    ]),
    RECESS_COLOR
  );
  builder.cyl(darkMat, 0.15, 0.15, 0.46, faceX + 0.1, 0.36, -0.58, {
    seg: 14,
    open: true,
    rot: [PI_STRUCTURES / 2, 0, 0]
  });
  for (const side of [-1, 1]) {
    const tankEnd = sphereSegmentGeometry(0.15, 14, 6);
    tankEnd.scale(1, 1, 0.45);
    builder.add(darkMat, transformGeometry(tankEnd, faceX + 0.1, 0.36, -0.58 + side * 0.23));
  }
  builder.box(darkMat, 0.26, 0.03, 0.5, faceX + 0.1, 0.19, -0.58, {
    r: 0.006
  });
  builder.cyl(aluMat, 0.07, 0.07, 0.4, faceX + 0.07, 0.5, -0.17, {
    seg: 10
  });
  builder.tube(
    brassMat,
    [
      [faceX + 0.1, 0.5, -0.5],
      [faceX + 0.1, 0.68, -0.5],
      [faceX + 0.08, 0.78, -0.4],
      [faceX + 0.08, 0.8, -0.2],
      [faceX + 0.07, 0.72, -0.17]
    ],
    0.012,
    {
      seg: 6
    }
  );
  builder.tube(
    brassMat,
    [
      [faceX + 0.12, 0.42, -0.36],
      [faceX + 0.14, 0.6, -0.33],
      [faceX + 0.1, 0.84, -0.34],
      [faceX + 0.06, 0.88, -0.6],
      [faceX + 0.03, 0.88, -0.9]
    ],
    0.009,
    {
      seg: 6
    }
  );
  builder.tube(
    brassMat,
    [
      [faceX + 0.1, 0.36, -0.82],
      [faceX + 0.1, 0.36, -0.93],
      [faceX + 0.06, 0.6, -0.96],
      [faceX + 0.04, 0.86, -0.96]
    ],
    0.012,
    {
      seg: 6
    }
  );
  builder.box(builder.M('paint_red'), 0.04, 0.05, 0.05, faceX + 0.12, 0.6, -0.33, {
    r: 0.008
  });
  // Control box with display, status LED and keypad
  const controlZ = 0.55;
  builder.box(greyMat, 0.11, 0.56, 0.74, faceX + 0.055, 0.5, controlZ, {
    r: 0.012
  });
  builder.box(greyMat, 0.012, 0.5, 0.68, faceX + 0.114, 0.5, controlZ, {
    r: 0.004
  });
  builder.add(
    darkMat,
    transformGeometry(simplePlaneGeometry(0.26, 0.11), faceX + 0.1215, 0.66, controlZ - 0.1, [
      0,
      PI_STRUCTURES / 2,
      0
    ])
  );
  builder.add(
    game.mats.emissive(0xffb45a, 2.4),
    transformGeometry(simplePlaneGeometry(0.15, 0.05), faceX + 0.122, 0.665, controlZ - 0.06, [
      0,
      PI_STRUCTURES / 2,
      0
    ]),
    null,
    true
  );
  builder.add(
    game.mats.emissive(0x58ff7a, 3),
    transformGeometry(simplePlaneGeometry(0.014, 0.014), faceX + 0.122, 0.66, controlZ - 0.2, [
      0,
      PI_STRUCTURES / 2,
      0
    ]),
    null,
    true
  );
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 2; row++)
      builder.box(
        darkMat,
        0.008,
        0.03,
        0.03,
        faceX + 0.122,
        0.5 - row * 0.045,
        controlZ - 0.04 - col * 0.045,
        {
          r: 0.003
        }
      );
  // Emergency stop, isolator, cables and power plug
  builder.box(builder.M('paint_red'), 0.03, 0.09, 0.03, faceX + 0.13, 0.42, controlZ + 0.22, {
    r: 0.006
  });
  builder.cyl(galvMat, 0.012, 0.012, 0.1, faceX + 0.124, 0.5, controlZ + 0.325, {
    seg: 6
  });
  builder.decal(namedDecal(game, 'hazard_voltage'), 0.11, faceX + 0.1215, 0.64, controlZ + 0.2, [
    0,
    PI_STRUCTURES / 2,
    0
  ]);
  builder.tube(
    rubberMat,
    [
      [faceX + 0.06, 0.78, controlZ + 0.2],
      [faceX + 0.06, 0.95, controlZ + 0.25],
      [faceX + 0.05, 1.4, controlZ + 0.5],
      [faceX + 0.05, 1.5, controlZ - 0]
    ],
    0.012,
    {
      seg: 5
    }
  );
  builder.tube(
    rubberMat,
    [
      [faceX + 0.06, 0.78, controlZ - 0.2],
      [faceX + 0.06, 0.92, controlZ - 0.3],
      [faceX + 0.05, 0.93, -0.1]
    ],
    0.01,
    {
      seg: 5
    }
  );
  builder.cyl(galvMat, 0.022, 0.022, 0.04, faceX + 0.06, 0.2, controlZ + 0.2, {
    seg: 8
  });
  builder.tube(
    rubberMat,
    [
      [faceX + 0.06, 0.2, controlZ + 0.2],
      [faceX + 0.08, 0.12, controlZ + 0.1],
      [faceX + 0.1, 0.16, controlZ - 0.15],
      [faceX + 0.1, 0.2, controlZ - 0.3],
      [faceX + 0.1, 0.13, controlZ - 0.36],
      [faceX + 0.09, 0.12, controlZ - 0.1],
      [faceX + 0.09, 0.14, controlZ + 0.05]
    ],
    0.016,
    {
      seg: 6
    }
  );
  builder.box(builder.M('paint_blue'), 0.07, 0.07, 0.12, faceX + 0.09, 0.14, controlZ + 0.1, {
    r: 0.015
  });
  builder.decal(
    namedDecal(game, 'grime_streak'),
    0.8,
    0.2512,
    0.5,
    -1.105,
    [0, PI_STRUCTURES / 2, 0],
    0.08
  );
  if (!options.flip) builder.pop();
  return finalizeProp(builder.group(), 'reefer_unit', structureSize('reefer_unit'), [
    {
      min: [-0.25, 0, -1.15],
      max: [0.25, 2.3, 1.15],
      surface: 'metal'
    }
  ]);
}

const PI_RELAY = Math.PI;
const RELAY_LIVE_COLOR = new Color(0xffa028);
const RELAY_CUT_COLOR = new Color(0xff2814);
const RELAY_SPARK_COLOR = new Color(0xffd9a0);

/** Relay states: powered, being cut (sparking) or cut (dark, door swung open). */
type RelayState = 'live' | 'cutting' | 'cut';

interface RelayNodeOptions extends SeedOptions {
  /** Relay identifier shown on the door (falls back to `label`, then A/B/C by seed). */
  id?: string;
  label?: string;
  /** Initial state. */
  state?: RelayState;
}

/**
 * Material whose glow can be driven by the relay: either via a custom
 * `userData.setEmissive`, a standard material's emissive, a shader `color` uniform,
 * or a plain `color`.
 */
type EmissiveLike = Material & {
  emissive?: Color;
  emissiveIntensity?: number;
  isMeshStandardMaterial?: boolean;
  uniforms?: { color?: { value?: Color }; intensity?: { value: number } };
  color?: Color;
};

/**
 * Harbour-master relay cabinet: a mission objective. Its userData exposes `state`,
 * `setState(state)`, `update(dt)`, `level` (glow intensity), `beacon` / `interact` points
 * and the cloned `emissiveMaterial`. Cutting it opens the door and spins down the dish.
 */
function buildRelayNode(game: Game, options: RelayNodeOptions = {}): Group {
  const seed = options.seed! | 0;
  const noiseOffset = seed * 1.9;
  const relayId = options.id || options.label || 'ABC'[seed % 3];
  const builder = new PropBuilder(game);
  /** Door that swings open when cut (kept separate, animated). */
  const doorBuilder = new PropBuilder(game);
  /** Status lights (glow with the shared cloned emissive material). */
  const lightBuilder = new PropBuilder(game);
  /** Rotating dish antenna. */
  const dishBuilder = new PropBuilder(game);
  const cabinetMat = builder.M('paint_grey', {
    vertexColors: true
  });
  const darkMat = builder.M('steel_dark');
  const galvMat = builder.M('steel_galv');
  const aluMat = builder.M('aluminium');
  const rubberMat = builder.M('rubber');
  const concreteMat = builder.M('concrete', {
    vertexColors: true
  });
  const cabinetColor = (x: number, y: number, z: number): Rgb => {
    const shade =
      (0.88 + 0.2 * valueNoise2d(x * 3 + noiseOffset, y * 3 + z * 2)) *
      (0.6 + 0.4 * smoothstep(0.16, 0.7, y));
    return [shade, shade, shade * 0.98];
  };
  builder.defCol.set(cabinetMat, cabinetColor);
  doorBuilder.defCol.set(cabinetMat, (x, y) => {
    const shade = 0.9 + 0.14 * valueNoise2d(x * 4 + noiseOffset, y * 3);
    return [shade, shade, shade];
  });
  const VENT_COLOR = [0.035, 0.035, 0.04];
  /** Placeholder key for the glowing light strips. */
  const LIGHT_SLOT = {
    em: true
  };
  // Concrete plinth with anchor bolts
  builder.box(concreteMat, 1.36, 0.16, 0.96, 0, 0.08, 0, {
    r: 0.025,
    col: (x, y, z) => {
      const shade = 0.6 + 0.38 * smoothstep(0, 0.15, y) + 0.1 * valueNoise2d(x * 5, z * 5);
      return [shade, shade, shade * 0.97];
    }
  });
  builder.decal(namedDecal(game, 'caution_stripes'), 0.1, 0, 0.085, 0.4815, null, 1.2);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      builder.cyl(galvMat, 0.016, 0.016, 0.03, sx * 0.44, 0.185, sz * 0.36, {
        seg: 6
      });
      builder.box(galvMat, 0.1, 0.012, 0.1, sx * 0.44, 0.166, sz * 0.36, {
        r: 0
      });
    }
  // Cabinet shell (open front, behind the doors)
  const cabinetLeft = -0.5;
  const cabinetRight = 0.5;
  const cabinetBottom = 0.18;
  const cabinetTop = 1.62;
  const cabinetBack = -0.3;
  const cabinetFront = 0.3;
  const wall = 0.025;
  const cabinetMidY = (cabinetBottom + cabinetTop) / 2;
  const cabinetHeight = cabinetTop - cabinetBottom;
  builder.box(cabinetMat, 1, cabinetHeight, wall, 0, cabinetMidY, cabinetBack + wall / 2, {
    r: 0.006
  });
  for (const side of [-1, 1])
    builder.box(cabinetMat, wall, cabinetHeight, 0.6, side * (0.5 - wall / 2), cabinetMidY, 0, {
      r: 0.006
    });
  builder.box(cabinetMat, 1, wall, 0.6, 0, cabinetBottom + wall / 2, 0, {
    r: 0.006
  });
  builder.box(cabinetMat, 1, wall, 0.6, 0, cabinetTop - wall / 2, 0, {
    r: 0.006
  });
  builder.box(cabinetMat, wall, cabinetHeight, 0.58, 0, cabinetMidY, 0, {
    r: 0.004
  });
  builder.box(cabinetMat, 1, 0.12, wall, 0, cabinetTop - 0.06, cabinetFront - wall / 2, {
    r: 0.006
  });
  builder.box(cabinetMat, 1, 0.07, wall, 0, cabinetBottom + 0.035, cabinetFront - wall / 2, {
    r: 0.006
  });
  builder.box(darkMat, 1.04, 0.04, 0.64, 0, cabinetBottom - 0.01, 0, {
    r: 0.008
  });
  builder.box(cabinetMat, 1.12, 0.05, 0.74, 0, cabinetTop + 0.025, 0.01, {
    r: 0.012
  });
  // Lifting eyes
  for (const side of [-1, 1])
    builder.tube(
      galvMat,
      [
        [side * 0.4 - 0.04, cabinetTop + 0.05, 0.2],
        [side * 0.4 - 0.03, cabinetTop + 0.1, 0.2],
        [side * 0.4 + 0.03, cabinetTop + 0.1, 0.2],
        [side * 0.4 + 0.04, cabinetTop + 0.05, 0.2]
      ],
      0.008,
      {
        seg: 5
      }
    );
  // Dark interior faces
  const interiorColor = (): Rgb => [0.16, 0.16, 0.17];
  builder.add(
    cabinetMat,
    transformGeometry(
      simplePlaneGeometry(0.45, cabinetHeight - 0.06),
      -0.25,
      cabinetMidY,
      cabinetBack + wall + 0.002
    ),
    interiorColor
  );
  builder.add(
    cabinetMat,
    transformGeometry(
      simplePlaneGeometry(0.55, cabinetHeight - 0.06),
      cabinetLeft + wall + 0.002,
      cabinetMidY,
      0,
      [0, PI_RELAY / 2, 0]
    ),
    interiorColor
  );
  builder.add(
    cabinetMat,
    transformGeometry(
      simplePlaneGeometry(0.55, cabinetHeight - 0.06),
      -wall / 2 - 0.002,
      cabinetMidY,
      0,
      [0, -PI_RELAY / 2, 0]
    ),
    interiorColor
  );
  // Relay modules with indicator LEDs and terminals
  for (let i = 0; i < 5; i++) {
    const moduleY = 0.42 + i * 0.22;
    builder.box(darkMat, 0.42, 0.17, 0.4, -0.25, moduleY, -0.05, {
      r: 0.008
    });
    builder.box(aluMat, 0.4, 0.02, 0.012, -0.25, moduleY + 0.06, 0.152, {
      r: 0
    });
    for (let led = 0; led < 4; led++)
      lightBuilder.add(
        LIGHT_SLOT,
        transformGeometry(
          simplePlaneGeometry(0.012, 0.012),
          -0.41 + led * 0.035,
          moduleY - 0.04,
          0.1512
        )
      );
    for (let terminal = 0; terminal < 3; terminal++)
      builder.add(
        darkMat,
        transformGeometry(
          stadiumGeometry(0.03, 0.022, 2),
          -0.2 + terminal * 0.06,
          moduleY - 0.03,
          0.1512
        ),
        VENT_COLOR
      );
  }
  // Patch cables between modules
  const cableMats = [rubberMat, rubberMat, rubberMat];
  for (let i = 0; i < 4; i++)
    builder.tube(
      cableMats[i % 3],
      [
        [-0.2 + (i % 3) * 0.06, 0.39 + i * 0.22, 0.15],
        [-0.14 + (i % 3) * 0.05, 0.36 + i * 0.22, 0.24],
        [-0.07, 0.55 + i * 0.22, 0.22],
        [-0.2 + ((i + 1) % 3) * 0.06, 0.61 + i * 0.22, 0.15]
      ],
      0.007,
      {
        seg: 5
      }
    );
  const doorWidth = 0.474;
  const doorHeight = 1.3;
  const doorMidY = 0.9;
  /** Cabinet door leaf starting at `left` with louvres, handle and hinges (hinged on the left if `hingeLeft`). */
  const addDoor = (target: PropBuilder, left: number, hingeLeft: boolean): void => {
    const centerX = left + doorWidth / 2;
    const z = 0;
    target.box(cabinetMat, doorWidth, doorHeight, 0.024, centerX, doorMidY, z, {
      r: 0.006
    });
    target.box(
      cabinetMat,
      doorWidth - 0.07,
      doorHeight - 0.07,
      0.006,
      centerX,
      doorMidY,
      z + 0.013,
      {
        r: 0.003
      }
    );
    for (const louvreY of [doorMidY + 0.36, doorMidY - 0.4]) {
      target.add(
        cabinetMat,
        transformGeometry(simplePlaneGeometry(doorWidth - 0.14, 0.3), centerX, louvreY, z + 0.0165),
        VENT_COLOR
      );
      for (let i = 0; i < 7; i++)
        target.box(
          cabinetMat,
          doorWidth - 0.13,
          0.034,
          0.005,
          centerX,
          louvreY - 0.125 + i * 0.042,
          z + 0.027,
          {
            r: 0,
            rot: [0.75, 0, 0]
          }
        );
      target.box(
        cabinetMat,
        0.02,
        0.31,
        0.02,
        centerX - (doorWidth - 0.13) / 2,
        louvreY,
        z + 0.022,
        {
          r: 0.003
        }
      );
      target.box(
        cabinetMat,
        0.02,
        0.31,
        0.02,
        centerX + (doorWidth - 0.13) / 2,
        louvreY,
        z + 0.022,
        {
          r: 0.003
        }
      );
    }
    const handleX = hingeLeft ? left + 0.07 : left + doorWidth - 0.07;
    target.box(darkMat, 0.045, 0.2, 0.02, handleX, doorMidY - 0.02, z + 0.026, {
      r: 0.006
    });
    target.box(galvMat, 0.028, 0.13, 0.018, handleX, doorMidY + 0, z + 0.042, {
      r: 0.006
    });
    target.cyl(galvMat, 0.012, 0.012, 0.012, handleX, doorMidY - 0.09, z + 0.04, {
      seg: 8,
      rot: [PI_RELAY / 2, 0, 0]
    });
    const hingeX = hingeLeft ? left + doorWidth : left;
    for (const hingeY of [doorMidY - 0.5, doorMidY, doorMidY + 0.5])
      target.cyl(galvMat, 0.011, 0.011, 0.09, hingeX, hingeY, z + 0.016, {
        seg: 6
      });
  };
  // Fixed right door with labels
  builder.push(makeTransformMatrix(0, 0, cabinetFront - 0.004));
  addDoor(builder, 0.013, true);
  builder.decal(
    labelDecal(game, 'RELAY ' + relayId, {
      color: 'yellow',
      font: 'stencil',
      distress: 0.15
    }),
    0.12,
    0.013 + doorWidth / 2,
    doorMidY + 0.02,
    0.018,
    null,
    doorWidth - 0.1
  );
  builder.decal(
    labelDecal(game, 'HARBORMASTER UPLINK', {
      color: 'white',
      font: 'sans',
      distress: 0.15
    }),
    0.034,
    0.013 + doorWidth / 2,
    doorMidY - 0.1,
    0.018,
    null,
    doorWidth - 0.1
  );
  builder.decal(
    namedDecal(game, 'hazard_voltage'),
    0.13,
    0.013 + doorWidth / 2 + 0.1,
    doorMidY + 0.14,
    0.018,
    null
  );
  builder.pop();
  // Swinging left door (local origin at its hinge), with inside bracing and wiring diagram
  const doorHinge = [-0.487, 0, cabinetFront - 0.004];
  addDoor(doorBuilder, 0, false);
  doorBuilder.decal(
    namedDecal(game, 'hazard_general'),
    0.13,
    doorWidth / 2,
    doorMidY + 0.1,
    0.018,
    null
  );
  doorBuilder.box(
    cabinetMat,
    doorWidth - 0.1,
    0.03,
    0.014,
    doorWidth / 2,
    doorMidY + 0.55,
    -0.018,
    {
      r: 0.003
    }
  );
  doorBuilder.box(
    cabinetMat,
    doorWidth - 0.1,
    0.03,
    0.014,
    doorWidth / 2,
    doorMidY - 0.55,
    -0.018,
    {
      r: 0.003
    }
  );
  doorBuilder.box(cabinetMat, 0.03, 1.1, 0.014, 0.07, doorMidY, -0.018, {
    r: 0.003
  });
  doorBuilder.box(cabinetMat, 0.03, 1.1, 0.014, doorWidth - 0.07, doorMidY, -0.018, {
    r: 0.003
  });
  doorBuilder.box(darkMat, 0.24, 0.3, 0.02, doorWidth / 2, doorMidY - 0.05, -0.02, {
    r: 0.004
  });
  doorBuilder.add(
    labelDecal(game, 'WIRING DIAGRAM  SLT-R4', {
      color: 'white',
      font: 'sans',
      distress: 0.1
    }).material,
    transformGeometry(simplePlaneGeometry(0.2, 0.03), doorWidth / 2, doorMidY + 0.03, -0.0305, [
      0,
      PI_RELAY,
      0
    ]),
    null,
    true
  );
  for (const louvreY of [doorMidY + 0.36, doorMidY - 0.4])
    doorBuilder.add(
      cabinetMat,
      transformGeometry(
        simplePlaneGeometry(doorWidth - 0.14, 0.3),
        doorWidth / 2,
        louvreY,
        -0.0125,
        [0, PI_RELAY, 0]
      ),
      VENT_COLOR
    );
  doorBuilder.decal(
    labelDecal(game, 'ISOLATE BEFORE SERVICE', {
      color: 'white',
      font: 'sans',
      distress: 0.15
    }),
    0.03,
    doorWidth / 2,
    doorMidY - 0.03,
    0.018,
    null,
    doorWidth - 0.1
  );
  // Side heat-sink fins
  for (const side of [-1, 1]) {
    builder.box(aluMat, 0.012, 0.98, 0.5, side * 0.506, 1.06, 0, {
      r: 0.003
    });
    for (let i = -6; i <= 6; i++)
      builder.add(
        aluMat,
        transformGeometry(worldUvBox(0.06, 0.94, 0.007), side * 0.54, 1.06, i * 0.038)
      );
    builder.box(cabinetMat, 0.075, 0.03, 0.52, side * 0.54, 1.56, 0, {
      r: 0.006
    });
  }
  // Power feed cables into the ground
  for (let i = 0; i < 3; i++) {
    const cableZ = -0.17 + i * 0.17;
    const cableY = 0.44 - i * 0.02;
    const groundX = 0.86 + i * 0.07;
    builder.tube(
      rubberMat,
      [
        [0.5, cableY, cableZ],
        [0.6, cableY, cableZ],
        [0.72 + i * 0.04, cableY - 0.06, cableZ],
        [groundX - 0.02, 0.16, cableZ + 0.02],
        [groundX, -0.03, cableZ + 0.02]
      ],
      0.04,
      {
        seg: 8,
        tension: 0.4
      }
    );
    builder.cyl(galvMat, 0.055, 0.055, 0.05, 0.515, cableY, cableZ, {
      seg: 8,
      flat: true,
      rot: [0, 0, PI_RELAY / 2]
    });
    builder.cyl(galvMat, 0.06, 0.066, 0.03, groundX, 0.015, cableZ + 0.02, {
      seg: 8
    });
  }
  builder.tube(
    rubberMat,
    [
      [-0.3, 0.35, cabinetBack],
      [-0.3, 0.33, cabinetBack - 0.1],
      [-0.34, 0.2, cabinetBack - 0.2],
      [-0.5, 0.165, cabinetBack - 0.3],
      [-0.9, 0.02, cabinetBack - 0.36],
      [-1.5, 0.018, cabinetBack - 0.2]
    ],
    0.022,
    {
      seg: 6
    }
  );
  builder.box(darkMat, 0.3, 0.22, 0.1, 0.2, 0.75, cabinetBack - 0.05, {
    r: 0.012
  });
  builder.tube(
    rubberMat,
    [
      [0.2, 0.86, cabinetBack - 0.06],
      [0.2, 1.2, cabinetBack - 0.04],
      [-0.1, 1.55, cabinetBack - 0.03],
      [-0.3, 1.66, -0.16]
    ],
    0.012,
    {
      seg: 5
    }
  );
  // Lattice antenna mast on the roof
  const mastX = -0.3;
  const mastZ = -0.14;
  const mastBottom = cabinetTop + 0.05;
  const mastTop = 2.5;
  const mastLegs = [0, 1, 2].map((i) => [
    mastX + Math.cos(i * 2.094 + 0.52) * 0.085,
    mastZ + Math.sin(i * 2.094 + 0.52) * 0.085
  ]);
  builder.box(galvMat, 0.24, 0.012, 0.24, mastX, mastBottom + 0.006, mastZ, {
    r: 0
  });
  for (let i = 0; i < 3; i++) {
    const leg = mastLegs[i];
    const nextLeg = mastLegs[(i + 1) % 3];
    builder.bar(galvMat, [leg[0], mastBottom, leg[1]], [leg[0], mastTop, leg[1]], 0.011, {
      seg: 6
    });
    const bays = 5;
    const bayHeight = (mastTop - mastBottom) / bays;
    for (let bay = 0; bay < bays; bay++) {
      builder.bar(
        galvMat,
        [leg[0], mastBottom + bay * bayHeight, leg[1]],
        [nextLeg[0], mastBottom + (bay + 1) * bayHeight, nextLeg[1]],
        0.005,
        {
          seg: 4
        }
      );
      builder.bar(
        galvMat,
        [leg[0], mastBottom + (bay + 1) * bayHeight, leg[1]],
        [nextLeg[0], mastBottom + (bay + 1) * bayHeight, nextLeg[1]],
        0.005,
        {
          seg: 4
        }
      );
    }
  }
  builder.cyl(galvMat, 0.11, 0.11, 0.014, mastX, mastTop + 0.007, mastZ, {
    seg: 10
  });
  builder.cyl(darkMat, 0.05, 0.06, 0.1, mastX, mastTop + 0.06, mastZ, {
    seg: 10
  });
  /** Whip antenna on an insulator at (x, z) reaching up to `topY`. */
  const addWhipAntenna = (x: number, z: number, topY: number): void => {
    builder.cyl(darkMat, 0.016, 0.02, 0.07, x, cabinetTop + 0.085, z, {
      seg: 8
    });
    builder.cyl(galvMat, 0.011, 0.011, 0.06, x, cabinetTop + 0.15, z, {
      seg: 6
    });
    builder.bar(darkMat, [x, cabinetTop + 0.17, z], [x + 0.02, topY, z - 0.015], 0.005, {
      r2: 0.0018,
      seg: 5,
      caps: true
    });
  };
  addWhipAntenna(0.4, -0.24, 3.15);
  addWhipAntenna(0.26, -0.24, 2.72);
  builder.cyl(darkMat, 0.03, 0.03, 0.26, 0.42, cabinetTop + 0.18, 0.18, {
    seg: 8
  });
  builder.add(
    darkMat,
    transformGeometry(
      sphereSegmentGeometry(0.03, 8, 4, PI_RELAY * 2, 0, PI_RELAY / 2),
      0.42,
      cabinetTop + 0.31,
      0.18
    )
  );
  // Dish antenna (rotates; built around its own origin)
  const dish = latheFromPoints(
    [
      [0, 0],
      [0.06, 0.006],
      [0.12, 0.024],
      [0.18, 0.054],
      [0.215, 0.078],
      [0.222, 0.078],
      [0.185, 0.05],
      [0.12, 0.016],
      [0.06, -0.003],
      [0, -0.01]
    ],
    18
  );
  dish.computeVertexNormals();
  dishBuilder.add(aluMat, transformGeometry(dish, 0, 0.3, 0.02, [PI_RELAY / 2 - 0.12, 0, 0]));
  dishBuilder.cyl(aluMat, 0.022, 0.03, 0.2, 0, 0.1, 0, {
    seg: 8
  });
  dishBuilder.box(aluMat, 0.07, 0.1, 0.06, 0, 0.26, -0.02, {
    r: 0.01
  });
  for (const angle of [0.5, 2.6, 4.7])
    dishBuilder.bar(
      aluMat,
      [Math.cos(angle) * 0.2, 0.3 + Math.sin(angle) * 0.2, 0.09],
      [0, 0.325, 0.25],
      0.0045,
      {
        seg: 4
      }
    );
  dishBuilder.cyl(aluMat, 0.022, 0.016, 0.05, 0, 0.325, 0.25, {
    seg: 8,
    rot: [PI_RELAY / 2, 0, 0]
  });
  const dishMount = [mastX, mastTop + 0.11, mastZ];
  // Status light strips
  builder.box(darkMat, 0.9, 0.07, 0.03, 0, cabinetTop - 0.06, cabinetFront + 0.012, {
    r: 0.008
  });
  lightBuilder.add(
    LIGHT_SLOT,
    transformGeometry(simplePlaneGeometry(0.84, 0.036), 0, cabinetTop - 0.06, cabinetFront + 0.0275)
  );
  for (let i = 1; i < 6; i++)
    builder.add(
      darkMat,
      transformGeometry(
        worldUvBox(0.008, 0.05, 0.006),
        -0.42 + i * 0.14,
        cabinetTop - 0.06,
        cabinetFront + 0.028
      )
    );
  builder.box(darkMat, 0.6, 0.06, 0.03, 0, cabinetTop - 0.06, cabinetBack - 0.012, {
    r: 0.008
  });
  lightBuilder.add(
    LIGHT_SLOT,
    transformGeometry(simplePlaneGeometry(0.54, 0.03), 0, cabinetTop - 0.06, cabinetBack - 0.0275, [
      0,
      PI_RELAY,
      0
    ])
  );
  for (const side of [-1, 1]) {
    builder.box(darkMat, 0.03, 1.2, 0.03, side * 0.5, 0.86, cabinetFront, {
      r: 0.008,
      rot: [0, PI_RELAY / 4, 0]
    });
    lightBuilder.add(
      LIGHT_SLOT,
      transformGeometry(simplePlaneGeometry(0.014, 1.14), side * 0.5, 0.86, cabinetFront + 0.0215, [
        0,
        (side * PI_RELAY) / 4,
        0
      ]).translate(side * 0.0152, 0, 0)
    );
    lightBuilder.add(
      LIGHT_SLOT,
      transformGeometry(simplePlaneGeometry(0.014, 0.9), side * 0.5715, 1.06, 0.262, [
        0,
        (side * PI_RELAY) / 2,
        0
      ])
    );
  }
  for (const side of [-1, 1]) {
    builder.box(darkMat, 0.03, 0.06, 0.46, side * 0.587, cabinetTop - 0.01, 0, {
      r: 0.008
    });
    lightBuilder.add(
      LIGHT_SLOT,
      transformGeometry(simplePlaneGeometry(0.4, 0.032), side * 0.6025, cabinetTop - 0.01, 0, [
        0,
        (side * PI_RELAY) / 2,
        0
      ])
    );
  }
  // Beacon on a pole
  builder.cyl(darkMat, 0.028, 0.028, 0.02, mastX + 0.2, cabinetTop + 0.06, mastZ, {
    seg: 8
  });
  builder.bar(galvMat, [mastX + 0.2, cabinetTop + 0.06, mastZ], [mastX + 0.2, 2.64, mastZ], 0.009, {
    seg: 6
  });
  lightBuilder.add(
    LIGHT_SLOT,
    transformGeometry(worldUvCylinder(0.045, 0.045, 0.1, 10), mastX + 0.2, 2.69, mastZ)
  );
  builder.cyl(darkMat, 0.05, 0.05, 0.014, mastX + 0.2, 2.747, mastZ, {
    seg: 10
  });
  builder.cyl(darkMat, 0.05, 0.05, 0.014, mastX + 0.2, 2.633, mastZ, {
    seg: 10
  });
  builder.decal(namedDecal(game, 'rust_run'), 0.5, 0.5135, 0.3, 0.2, [0, PI_RELAY / 2, 0], 0.14);
  builder.decal(
    namedDecal(game, 'grime_streak'),
    0.6,
    -0.2,
    1.2,
    cabinetBack - 0.001,
    [0, PI_RELAY, 0],
    0.2
  );
  // Assemble: static merged body + dynamic (non-merged) lights, door and dish
  const group = builder.group();
  const dynamicRoot = new Group();
  dynamicRoot.userData.noMerge = true;
  dynamicRoot.name = 'relay_dynamic';
  group.add(dynamicRoot);
  let glowMat = game.mats.emissive(0xffa028, 4) as EmissiveLike;
  glowMat = glowMat.clone() as EmissiveLike;
  const lightMesh = new Mesh(
    mergeGeometryList((lightBuilder.buckets.get(LIGHT_SLOT) as GeometryBucket).geos),
    glowMat
  );
  lightMesh.userData.noMerge = true;
  dynamicRoot.add(lightMesh);
  const doorParts = doorBuilder.group().children.slice();
  for (const part of doorParts) {
    part.position.set(doorHinge[0], doorHinge[1], doorHinge[2]);
    part.userData.noMerge = true;
    dynamicRoot.add(part);
  }
  const dishParts = dishBuilder.group().children.slice();
  for (const part of dishParts) {
    part.position.set(dishMount[0], dishMount[1], dishMount[2]);
    part.userData.noMerge = true;
    dynamicRoot.add(part);
  }
  const tmpColor = new Color();
  /** Set the glow colour / intensity on whatever kind of material `glowMat` is. */
  const setGlow = (color: Color, intensity: number): void => {
    if (glowMat.userData && typeof glowMat.userData.setEmissive == 'function') {
      glowMat.userData.setEmissive(color, intensity);
      return;
    }
    if (glowMat.emissive && glowMat.emissive.isColor && glowMat.isMeshStandardMaterial) {
      glowMat.emissive.copy(color);
      glowMat.emissiveIntensity = intensity;
    } else if (
      glowMat.uniforms &&
      glowMat.uniforms.color &&
      glowMat.uniforms.color.value &&
      glowMat.uniforms.color.value.isColor
    ) {
      glowMat.uniforms.color.value.copy(color).multiplyScalar(intensity);
      if (glowMat.uniforms.intensity) glowMat.uniforms.intensity.value = 1;
    } else if (glowMat.color && glowMat.color.isColor) {
      glowMat.color.copy(color).multiplyScalar(intensity);
    }
  };
  let state: RelayState = 'live';
  let time = (seed % 7) * 0.9;
  let cutTime = 0;
  let dishSpeed = 0.7;
  let doorAngle = 0;
  let doorVelocity = 0;
  let doorTarget = 0;
  const data = group.userData;
  data.state = state;
  data.beacon = [mastX + 0.2, 2.68, mastZ];
  data.interact = [0, 1, 0.75];
  data.emissiveMaterial = glowMat;
  data.level = 0;
  data.setState = (next: string): void => {
    if (next !== 'live' && next !== 'cutting' && next !== 'cut') return;
    if (next !== state) {
      state = next;
      data.state = next;
      if (next === 'cut') {
        cutTime = 0;
        doorTarget = 1.32;
        doorVelocity = 2.5;
      }
      if (next === 'live') doorTarget = 0;
    }
  };
  data.update = (dt: number): void => {
    dt = Math.min(dt || 0, 0.1);
    time += dt;
    let level = 0;
    let color = RELAY_LIVE_COLOR;
    let dishTarget = 0.7;
    if (state === 'live') level = 5.5 + 3 * Math.sin(time * 2.2);
    else if (state === 'cutting') {
      const sparkOn = Math.sin(time * 2 * PI_RELAY * 5.5) > 0;
      level = sparkOn ? 9 : 0.5;
      color = sparkOn ? RELAY_SPARK_COLOR : RELAY_LIVE_COLOR;
      dishTarget = 2.6 + Math.sin(time * 9) * 1.5;
    } else {
      cutTime += dt;
      color = RELAY_CUT_COLOR;
      dishTarget = 0;
      if (cutTime < 0.3) level = 9;
      else if (cutTime < 2.6) {
        // Dying flicker
        const fade = 1 - (cutTime - 0.3) / 2.3;
        level =
          7 * fade * fade * (Math.sin(cutTime * 37) * Math.sin(cutTime * 13.3) > -0.2 ? 1 : 0.08);
      } else level = 0;
    }
    data.level = level;
    setGlow(tmpColor.copy(color), level);
    dishSpeed += (dishTarget - dishSpeed) * Math.min(1, dt * (state === 'cut' ? 1.6 : 3));
    if (Math.abs(dishSpeed) > 0.001) for (const part of dishParts) part.rotateY(dishSpeed * dt);
    // Door: damped spring toward the target angle, bouncing off its limits
    if (Math.abs(doorTarget - doorAngle) > 1e-4 || Math.abs(doorVelocity) > 0.001) {
      doorVelocity += (-(doorAngle - doorTarget) * 30 - doorVelocity * 3.2) * dt;
      let nextAngle = doorAngle + doorVelocity * dt;
      if (nextAngle < 0) {
        nextAngle = 0;
        doorVelocity = Math.abs(doorVelocity) * 0.3;
      }
      if (nextAngle > 1.9) {
        nextAngle = 1.9;
        doorVelocity = -Math.abs(doorVelocity) * 0.4;
      }
      const delta = nextAngle - doorAngle;
      doorAngle = nextAngle;
      for (const part of doorParts) part.rotateY(-delta);
    }
  };
  if (options.state === 'cut') {
    data.setState('cut');
    for (let i = 0; i < 80; i++) data.update(0.05);
  } else {
    if (options.state === 'cutting') data.setState('cutting');
    data.update(0);
    if (state === 'live') setGlow(tmpColor.copy(RELAY_LIVE_COLOR), 6);
  }
  return finalizeProp(group, 'relay_node', PROP_SIZES.relay_node.slice(0, 3) as number[], [
    {
      min: [-0.68, 0, -0.48],
      max: [0.68, 0.16, 0.48],
      surface: 'concrete'
    },
    {
      min: [-0.57, 0.16, -0.32],
      max: [0.57, 1.67, 0.33],
      surface: 'metal'
    },
    {
      min: [-0.42, 1.67, -0.26],
      max: [-0.18, 2.5, -0.02],
      surface: 'metal',
      bulletOnly: true
    }
  ]);
}

for (const name of ['container20', 'container40', 'container40hc'])
  registerProp(name, (game, options: ContainerOptions) => buildContainer(game, name, options));
registerProp('jersey_barrier', buildJerseyBarrier);
registerProp('light_mast', buildLightMast);
registerProp('fence_panel', buildFencePanel);
registerProp('guard_booth', buildGuardBooth);
registerProp('gate_arm', buildGateArm);
registerProp('bollard_mooring', buildMooringBollard);
registerProp('bollard_post', buildBollardPost);
registerProp('sign_post', buildSignPost);
registerProp('floodlight_stand', buildFloodlightStand);
registerProp('stairs_metal', buildMetalStairs);
registerProp('catwalk', buildCatwalk);
registerProp('shelf_rack', buildShelfRack);
registerProp('reefer_unit', buildReeferUnit);
registerProp('relay_node', buildRelayNode);
