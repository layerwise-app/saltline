// Hero ship-to-shore container crane on the quay (legs, girders, boom, machinery house,
// stairs, operator cab, floodlights, trolley and hanging spreader) plus a cheap box
// silhouette used for distant cranes in the skyline.
import { OctahedronGeometry } from 'three';
import type { BufferGeometry, Group, Material } from 'three';
import type { Game } from '../core/types';
import {
  MaterialBatcher,
  beamBetween,
  boxBetween,
  cylinderAt,
  planeAt,
  polylineRods,
  railingAlong,
  rodBetween,
  v3,
  weatheredMaterial
} from './geometry';
import type { BackdropCollider, BatchGeometry, BlinkLightBatch, Rgb } from './geometry';

/** Small octahedron used as a blinking aviation-warning beacon at (x, y, z). */
export const beaconGeometry = (
  x: number,
  y: number,
  z: number,
  radius = 0.12
): OctahedronGeometry => {
  const geometry = new OctahedronGeometry(radius, 0);
  geometry.translate(x, y, z);
  return geometry;
};
const CRANE_RAIL_LAND_X = 18.5;
const CRANE_RAIL_SEA_X = 28.5;
const CRANE_LEG_HALF_SPAN = 5.4;
const CRANE_GIRDER_Y0 = 21.2;
const CRANE_GIRDER_Y1 = 22.8;
const CRANE_GIRDER_HALF_GAP = 1.8;
const CRANE_BOOM_X0 = 12;
const CRANE_BOOM_X1 = 62;
const CRANE_TROLLEY_X = 41;
const CRANE_FRAME_TINT = [0.82, 0.95, 1.12];
const CRANE_SHADOW_TINT = [0.6, 0.72, 0.86];
const CRANE_YELLOW_TINT = [1, 0.95, 0.85];
const CRANE_WHITE_TINT = [0.95, 0.96, 0.97];

/**
 * Options for building the crane into a shared batch instead of as its own mesh: every
 * material is remapped to `mat` with a flat colour, tiny parts are dropped and the whole
 * thing is shifted by `dz` (used by the skyline for a second, distant crane).
 */
export interface QuayCraneOptions {
  into?: MaterialBatcher;
  mat?: Material;
  dz?: number;
}

/** The hero crane: root mesh group, swaying spreader and its colliders. */
export interface QuayCrane {
  root: Group;
  spreader: Group;
  colliders: BackdropCollider[];
  tris: number;
}

/**
 * Builds the quay crane. Without `options.into` it returns the finished crane; with it the
 * geometry is added to that batch (and its beacons to `blinkLights`) and null is returned.
 */
export function buildQuayCrane(game: Game, blinkLights: BlinkLightBatch): QuayCrane;
export function buildQuayCrane(
  game: Game,
  blinkLights: BlinkLightBatch,
  options: QuayCraneOptions
): QuayCrane | null;
export function buildQuayCrane(
  game: Game,
  blinkLights: BlinkLightBatch,
  options: QuayCraneOptions = {}
): QuayCrane | null {
  const isProxy = !!options.into;
  const zOffset = options.dz || 0;
  const batcher = options.into || new MaterialBatcher();
  const lights: Pick<BlinkLightBatch, 'add'> = isProxy
    ? {
        add(geometry, color, period, phase, duty) {
          // Only ever called with real beacon/box geometry.
          geometry!.translate(0, 0, zOffset);
          blinkLights.add(geometry, color, period, phase, duty);
        }
      }
    : blinkLights;
  const greyPaint = weatheredMaterial(game, 'paint_grey');
  const yellowPaint = weatheredMaterial(game, 'paint_yellow');
  const whitePaint = weatheredMaterial(game, 'paint_white');
  const redPaint = weatheredMaterial(game, 'paint_red');
  const galvSteel = game.mats.get('steel_galv');
  const darkSteel = game.mats.get('steel_dark');
  const hazardStripes = game.mats.get('hazard_stripes');
  const glass = game.mats.get('glass');
  const lampEmissive = game.mats.emissive(0xffe2b4, 6);
  const add = (material: Material, geometry: BatchGeometry, tint?: Rgb) =>
    batcher.add(material, geometry, tint);
  const colliders: BackdropCollider[] = [];
  if (isProxy) {
    const proxyColors = new Map<string, Rgb>([
      [greyPaint.uuid, [0.2, 0.25, 0.31]],
      [yellowPaint.uuid, [0.72, 0.52, 0.12]],
      [whitePaint.uuid, [0.78, 0.78, 0.76]],
      [redPaint.uuid, [0.5, 0.14, 0.1]],
      [galvSteel.uuid, [0.5, 0.52, 0.54]],
      [darkSteel.uuid, [0.1, 0.1, 0.11]],
      [hazardStripes.uuid, [0.7, 0.5, 0.1]]
    ]);
    const proxyMaterial = options.mat as Material;
    batcher.remap = (material, tint) => {
      const proxyColor = proxyColors.get(material.uuid);
      return proxyColor
        ? [
            proxyMaterial,
            tint
              ? [proxyColor[0] * tint[0], proxyColor[1] * tint[1], proxyColor[2] * tint[2]]
              : proxyColor
          ]
        : null;
    };
    batcher.dz = zOffset;
    batcher.minSize = 2.6;
  }
  function addLegBogie(railX: number, legZ: number) {
    const outward = railX < 23.5 ? 1 : -1;
    for (const bogieOffset of [-1.12, 1.12]) {
      const bogieZ = legZ + bogieOffset;
      add(
        yellowPaint,
        boxBetween(railX - 0.3, 0.36, bogieZ - 0.98, railX + 0.3, 0.84, bogieZ + 0.98, 0.04),
        CRANE_YELLOW_TINT
      );
      for (const wheelOffset of [-0.56, 0.56]) {
        add(darkSteel, cylinderAt(0.33, 0.33, 0.14, 'x', railX, 0.33, bogieZ + wheelOffset, 16));
        add(
          darkSteel,
          cylinderAt(0.37, 0.37, 0.025, 'x', railX - 0.085, 0.33, bogieZ + wheelOffset, 16)
        );
        add(
          darkSteel,
          cylinderAt(0.37, 0.37, 0.025, 'x', railX + 0.085, 0.33, bogieZ + wheelOffset, 16)
        );
        add(galvSteel, cylinderAt(0.11, 0.11, 0.7, 'x', railX, 0.33, bogieZ + wheelOffset, 8));
      }
      add(darkSteel, cylinderAt(0.16, 0.16, 0.5, 'z', railX + outward * 0.5, 0.6, bogieZ, 10));
      add(
        yellowPaint,
        boxBetween(
          railX + outward * 0.3,
          0.42,
          bogieZ - 0.56 - 0.16,
          railX + outward * 0.62,
          0.8,
          bogieZ - 0.3,
          0.03
        ),
        CRANE_YELLOW_TINT
      );
    }
    add(darkSteel, boxBetween(railX - 0.2, 0.1, legZ - 0.22, railX + 0.2, 0.9, legZ + 0.22, 0.03));
    add(
      greyPaint,
      boxBetween(railX - 0.34, 0.9, legZ - 1.8, railX + 0.34, 1.42, legZ + 1.8, 0.05),
      CRANE_FRAME_TINT
    );
    for (const axleOffset of [-1.12, 0, 1.12])
      add(
        galvSteel,
        cylinderAt(0.14, 0.14, 0.8, 'x', railX, axleOffset ? 1.08 : 1.22, legZ + axleOffset, 10)
      );
    add(
      greyPaint,
      boxBetween(railX - 0.54, 1.42, legZ - 0.54, railX + 0.54, 1.6, legZ + 0.54, 0.03),
      CRANE_SHADOW_TINT
    );
    for (const side of [-1, 1]) {
      const bufferZ = legZ + side * 2.1;
      add(
        yellowPaint,
        boxBetween(railX - 0.16, 0.44, bufferZ - 0.12, railX + 0.16, 0.8, bufferZ + 0.12, 0.02),
        CRANE_YELLOW_TINT
      );
      add(galvSteel, cylinderAt(0.08, 0.08, 0.34, 'z', railX, 0.62, bufferZ + side * 0.28, 8));
      add(darkSteel, cylinderAt(0.17, 0.15, 0.12, 'z', railX, 0.62, bufferZ + side * 0.5, 12));
      add(
        hazardStripes,
        boxBetween(
          railX - 0.28,
          0.04,
          bufferZ + side * 0.13,
          railX + 0.28,
          0.4,
          bufferZ + side * 0.16
        )
      );
    }
    colliders.push({
      min: [railX - 0.5, 0, legZ - 2.7],
      max: [railX + 0.5, 1.5, legZ + 2.7]
    });
    colliders.push({
      min: [railX - 0.62, 0, legZ - 0.62],
      max: [railX + 0.62, 24, legZ + 0.62]
    });
  }
  const legJointYs = [3.6, 7.6, 11.2, 12.5, 13.5, 17.2, 20.6, 23.8];
  for (const railX of [CRANE_RAIL_LAND_X, CRANE_RAIL_SEA_X])
    for (const legZ of [-CRANE_LEG_HALF_SPAN, CRANE_LEG_HALF_SPAN]) {
      addLegBogie(railX, legZ);
      add(
        hazardStripes,
        boxBetween(railX - 0.6, 1.6, legZ - 0.6, railX + 0.6, 3.6, legZ + 0.6, 0.04)
      );
      for (let seg = 0; seg < legJointYs.length - 1; seg++) {
        add(
          greyPaint,
          boxBetween(
            railX - 0.6,
            legJointYs[seg],
            legZ - 0.6,
            railX + 0.6,
            legJointYs[seg + 1],
            legZ + 0.6,
            0.05
          ),
          CRANE_FRAME_TINT
        );
        if (seg === 0 || seg === 1 || seg === 5) {
          add(
            greyPaint,
            boxBetween(
              railX - 0.64,
              legJointYs[seg] - 0.05,
              legZ - 0.64,
              railX + 0.64,
              legJointYs[seg] + 0.05,
              legZ + 0.64
            ),
            CRANE_SHADOW_TINT
          );
        }
      }
    }
  const voltageDecal = game.mats.decal('hazard_voltage');
  for (const legZ of [-CRANE_LEG_HALF_SPAN, CRANE_LEG_HALF_SPAN]) {
    const panelX = CRANE_RAIL_LAND_X - 0.6;
    add(
      whitePaint,
      boxBetween(panelX - 0.035, 1.72, legZ - 0.36, panelX, 3.48, legZ + 0.36, 0.012),
      [0.62, 0.66, 0.7]
    );
    add(darkSteel, boxBetween(panelX - 0.05, 1.66, legZ - 0.42, panelX - 0.005, 1.72, legZ + 0.42));
    add(darkSteel, boxBetween(panelX - 0.05, 3.48, legZ - 0.42, panelX - 0.005, 3.54, legZ + 0.42));
    add(darkSteel, boxBetween(panelX - 0.05, 1.66, legZ - 0.42, panelX - 0.005, 3.54, legZ - 0.36));
    add(darkSteel, boxBetween(panelX - 0.05, 1.66, legZ + 0.36, panelX - 0.005, 3.54, legZ + 0.42));
    add(
      galvSteel,
      rodBetween([panelX - 0.08, 2.45, legZ + 0.26], [panelX - 0.08, 2.75, legZ + 0.26], 0.014, 5)
    );
    for (const latchY of [2, 3.2])
      add(
        darkSteel,
        boxBetween(
          panelX - 0.06,
          latchY - 0.07,
          legZ - 0.37,
          panelX - 0.03,
          latchY + 0.07,
          legZ - 0.33
        )
      );
    add(galvSteel, boxBetween(panelX - 0.3, 1.5, legZ - 0.4, panelX, 1.56, legZ + 0.4));
    add(galvSteel, boxBetween(panelX - 0.3, 1, legZ - 0.4, panelX - 0.02, 1.05, legZ + 0.4));
    add(voltageDecal.material, planeAt(0.3, 0.3, panelX - 0.04, 3.1, legZ, -Math.PI / 2));
  }
  for (const railX of [CRANE_RAIL_LAND_X, CRANE_RAIL_SEA_X]) {
    add(
      greyPaint,
      boxBetween(
        railX - 0.45,
        3.6,
        -CRANE_LEG_HALF_SPAN + 0.6,
        railX + 0.45,
        4.6,
        CRANE_LEG_HALF_SPAN - 0.6,
        0.05
      ),
      CRANE_FRAME_TINT
    );
    for (const ribZ of [-2.4, 0, 2.4])
      add(
        greyPaint,
        boxBetween(railX - 0.48, 3.58, ribZ - 0.03, railX + 0.48, 4.62, ribZ + 0.03),
        CRANE_SHADOW_TINT
      );
  }
  add(
    yellowPaint,
    cylinderAt(1.15, 1.15, 0.06, 'x', CRANE_RAIL_LAND_X - 0.62, 5.85, -2.2, 24),
    CRANE_YELLOW_TINT
  );
  add(
    yellowPaint,
    cylinderAt(1.15, 1.15, 0.06, 'x', CRANE_RAIL_LAND_X - 1.02, 5.85, -2.2, 24),
    CRANE_YELLOW_TINT
  );
  add(darkSteel, cylinderAt(0.7, 0.7, 0.36, 'x', CRANE_RAIL_LAND_X - 0.82, 5.85, -2.2, 20));
  add(galvSteel, cylinderAt(0.12, 0.12, 0.9, 'x', CRANE_RAIL_LAND_X - 0.6, 5.85, -2.2, 8));
  add(
    greyPaint,
    boxBetween(CRANE_RAIL_LAND_X - 0.5, 4.6, -2.5, CRANE_RAIL_LAND_X + 0.3, 5.9, -1.9, 0.03),
    CRANE_SHADOW_TINT
  );
  add(
    darkSteel,
    rodBetween(
      [CRANE_RAIL_LAND_X - 0.82, 4.75, -2.2 + 1],
      [CRANE_RAIL_LAND_X - 0.82, 0.02, -1.2 + 0.3],
      0.035,
      6
    )
  );
  add(
    galvSteel,
    boxBetween(CRANE_RAIL_LAND_X - 1, 0, -1.15, CRANE_RAIL_LAND_X - 0.64, 0.5, -0.65, 0.02)
  );
  colliders.push({
    min: [CRANE_RAIL_LAND_X - 1, 0, -1.15],
    max: [CRANE_RAIL_LAND_X - 0.64, 0.5, -0.65]
  });
  add(
    whitePaint,
    boxBetween(CRANE_RAIL_LAND_X - 0.42, 4.6, 1, CRANE_RAIL_LAND_X + 0.42, 6.3, 3.6, 0.03),
    CRANE_WHITE_TINT
  );
  for (const ventZ of [1.65, 2.3, 2.95])
    add(
      darkSteel,
      boxBetween(
        CRANE_RAIL_LAND_X - 0.44,
        4.7,
        ventZ - 0.01,
        CRANE_RAIL_LAND_X - 0.42,
        6.2,
        ventZ + 0.01
      )
    );
  add(
    galvSteel,
    boxBetween(CRANE_RAIL_LAND_X - 0.47, 5.6, 1.2, CRANE_RAIL_LAND_X - 0.42, 6.1, 1.55)
  );
  for (const legZ of [-CRANE_LEG_HALF_SPAN, CRANE_LEG_HALF_SPAN]) {
    add(
      greyPaint,
      boxBetween(
        CRANE_RAIL_LAND_X + 0.6,
        12.5,
        legZ - 0.45,
        CRANE_RAIL_SEA_X - 0.6,
        13.5,
        legZ + 0.45,
        0.05
      ),
      CRANE_FRAME_TINT
    );
    for (const ribX of [21, 23.5, 26])
      add(
        greyPaint,
        boxBetween(ribX - 0.03, 12.48, legZ - 0.48, ribX + 0.03, 13.52, legZ + 0.48),
        CRANE_SHADOW_TINT
      );
    const legSide = Math.sign(legZ);
    add(
      greyPaint,
      beamBetween(
        [CRANE_RAIL_LAND_X + 0.5, 9.6, legZ],
        [CRANE_RAIL_LAND_X + 3.4, 12.6, legZ],
        0.4,
        0.4,
        0.03
      ),
      CRANE_FRAME_TINT
    );
    add(
      greyPaint,
      beamBetween(
        [CRANE_RAIL_SEA_X - 0.5, 9.6, legZ],
        [CRANE_RAIL_SEA_X - 3.4, 12.6, legZ],
        0.4,
        0.4,
        0.03
      ),
      CRANE_FRAME_TINT
    );
    for (const railX of [CRANE_RAIL_LAND_X, CRANE_RAIL_SEA_X])
      add(
        greyPaint,
        beamBetween(
          [railX, 9.6, legZ - legSide * 0.5],
          [railX, 12.6, legZ - legSide * 3.4],
          0.4,
          0.4,
          0.03
        ),
        CRANE_FRAME_TINT
      );
    add(
      greyPaint,
      rodBetween(
        [CRANE_RAIL_SEA_X - 0.4, 13.7, legZ],
        [CRANE_RAIL_LAND_X + 0.4, 22.7, legZ],
        0.2,
        10
      ),
      CRANE_FRAME_TINT
    );
    add(
      greyPaint,
      rodBetween(
        [CRANE_RAIL_LAND_X + 0.4, 13.7, legZ],
        [CRANE_RAIL_SEA_X - 0.4, 22.7, legZ],
        0.2,
        10
      ),
      CRANE_FRAME_TINT
    );
    add(
      greyPaint,
      boxBetween(23.5 - 0.5, 17.7, legZ - 0.24, 23.5 + 0.5, 18.7, legZ + 0.24, 0.03),
      CRANE_SHADOW_TINT
    );
    add(
      greyPaint,
      boxBetween(
        CRANE_RAIL_LAND_X + 0.6,
        22.95,
        legZ - 0.35,
        CRANE_RAIL_SEA_X - 0.6,
        23.7,
        legZ + 0.35,
        0.04
      ),
      CRANE_FRAME_TINT
    );
  }
  for (const railX of [CRANE_RAIL_LAND_X, CRANE_RAIL_SEA_X]) {
    add(
      greyPaint,
      boxBetween(
        railX - 0.45,
        12.5,
        -CRANE_LEG_HALF_SPAN + 0.6,
        railX + 0.45,
        13.5,
        CRANE_LEG_HALF_SPAN - 0.6,
        0.05
      ),
      CRANE_FRAME_TINT
    );
    add(
      greyPaint,
      boxBetween(
        railX - 0.45,
        22.8,
        -CRANE_LEG_HALF_SPAN + 0.6,
        railX + 0.45,
        23.8,
        CRANE_LEG_HALF_SPAN - 0.6,
        0.05
      ),
      CRANE_FRAME_TINT
    );
    for (const side of [-1, 1])
      add(
        greyPaint,
        beamBetween(
          [railX, 20.2, side * (CRANE_LEG_HALF_SPAN - 0.5)],
          [railX, 22.8, side * (CRANE_GIRDER_HALF_GAP + 1.2)],
          0.36,
          0.36,
          0.03
        ),
        CRANE_FRAME_TINT
      );
  }
  add(
    galvSteel,
    boxBetween(CRANE_RAIL_LAND_X + 0.9, 13.5, 4.05, CRANE_RAIL_SEA_X - 0.9, 13.55, 4.95)
  );
  railingAlong(
    batcher,
    yellowPaint,
    [
      [CRANE_RAIL_LAND_X + 0.9, 13.55, 4.08],
      [CRANE_RAIL_SEA_X - 0.9, 13.55, 4.08]
    ],
    {
      tint: CRANE_YELLOW_TINT
    }
  );
  add(
    galvSteel,
    boxBetween(CRANE_RAIL_LAND_X + 0.45, 13.45, -4.6, CRANE_RAIL_LAND_X + 1.25, 13.5, 4.05)
  );
  railingAlong(
    batcher,
    yellowPaint,
    [
      [CRANE_RAIL_LAND_X + 1.22, 13.5, -4.6],
      [CRANE_RAIL_LAND_X + 1.22, 13.5, 4.05]
    ],
    {
      tint: CRANE_YELLOW_TINT
    }
  );
  const sheaveX = CRANE_RAIL_SEA_X + 1.3;
  for (const side of [-1, 1]) {
    const girderZ = side * CRANE_GIRDER_HALF_GAP;
    const girderJoints = [
      CRANE_BOOM_X0,
      15.4,
      CRANE_RAIL_LAND_X,
      22,
      25.2,
      CRANE_RAIL_SEA_X,
      sheaveX - 0.15,
      sheaveX + 0.15,
      34.6,
      39.2,
      43.8,
      48.4,
      53,
      57.6,
      CRANE_BOOM_X1
    ];
    for (let seg = 0; seg < girderJoints.length - 1; seg++)
      if (seg !== 6) {
        add(
          greyPaint,
          boxBetween(
            girderJoints[seg],
            CRANE_GIRDER_Y0,
            girderZ - 0.45,
            girderJoints[seg + 1],
            CRANE_GIRDER_Y1,
            girderZ + 0.45,
            0.05
          ),
          CRANE_FRAME_TINT
        );
        if (seg > 0 && seg !== 7) {
          add(
            greyPaint,
            boxBetween(
              girderJoints[seg] - 0.035,
              CRANE_GIRDER_Y0 - 0.05,
              girderZ - 0.5,
              girderJoints[seg] + 0.035,
              CRANE_GIRDER_Y1 + 0.05,
              girderZ + 0.5
            ),
            CRANE_SHADOW_TINT
          );
        }
      }
    add(
      greyPaint,
      boxBetween(
        sheaveX - 0.7,
        CRANE_GIRDER_Y1 - 0.1,
        girderZ - 0.52,
        sheaveX + 0.7,
        CRANE_GIRDER_Y1 + 0.55,
        girderZ - 0.4,
        0.03
      ),
      CRANE_SHADOW_TINT
    );
    add(
      greyPaint,
      boxBetween(
        sheaveX - 0.7,
        CRANE_GIRDER_Y1 - 0.1,
        girderZ + 0.4,
        sheaveX + 0.7,
        CRANE_GIRDER_Y1 + 0.55,
        girderZ + 0.52,
        0.03
      ),
      CRANE_SHADOW_TINT
    );
    add(galvSteel, cylinderAt(0.16, 0.16, 1.2, 'z', sheaveX, CRANE_GIRDER_Y1 + 0.22, girderZ, 12));
    add(
      darkSteel,
      boxBetween(
        CRANE_BOOM_X0 + 0.3,
        CRANE_GIRDER_Y1,
        girderZ - side * 0.32 - 0.05,
        CRANE_BOOM_X1 - 0.3,
        CRANE_GIRDER_Y1 + 0.09,
        girderZ - side * 0.32 + 0.05
      )
    );
    const walkInnerZ = girderZ + side * 0.45;
    const walkOuterZ = girderZ + side * 1.35;
    add(
      galvSteel,
      boxBetween(
        CRANE_BOOM_X0 + 0.2,
        21.86,
        Math.min(walkInnerZ, walkOuterZ),
        CRANE_BOOM_X1 - 0.2,
        21.9,
        Math.max(walkInnerZ, walkOuterZ)
      )
    );
    for (let postX = CRANE_BOOM_X0 + 0.6; postX < CRANE_BOOM_X1; postX += 2.45) {
      add(
        greyPaint,
        beamBetween([postX, 21.84, walkInnerZ], [postX, 21.3, walkInnerZ], 0.07, 0.07),
        CRANE_SHADOW_TINT
      );
      add(
        greyPaint,
        beamBetween([postX, 21.82, walkOuterZ], [postX, 21.36, walkInnerZ], 0.06, 0.08),
        CRANE_SHADOW_TINT
      );
    }
    railingAlong(
      batcher,
      yellowPaint,
      [
        [CRANE_BOOM_X0 + 0.2, 21.9, walkOuterZ - side * 0.03],
        [CRANE_BOOM_X1 - 0.2, 21.9, walkOuterZ - side * 0.03]
      ],
      {
        post: 2.45,
        tint: CRANE_YELLOW_TINT
      }
    );
    add(
      yellowPaint,
      boxBetween(
        CRANE_BOOM_X0 + 0.2,
        21.9,
        walkOuterZ - side * 0.03 - 0.008,
        CRANE_BOOM_X1 - 0.2,
        22.02,
        walkOuterZ - side * 0.03 + 0.008
      ),
      CRANE_YELLOW_TINT
    );
    for (const hangerX of [44, 58])
      add(
        greyPaint,
        boxBetween(
          hangerX - 0.18,
          CRANE_GIRDER_Y1,
          girderZ - 0.2,
          hangerX + 0.18,
          CRANE_GIRDER_Y1 + 1.5,
          girderZ + 0.2,
          0.03
        ),
        CRANE_FRAME_TINT
      );
  }
  for (const hangerX of [44, 58])
    add(
      greyPaint,
      boxBetween(
        hangerX - 0.2,
        CRANE_GIRDER_Y1 + 1.2,
        -CRANE_GIRDER_HALF_GAP - 0.3,
        hangerX + 0.2,
        CRANE_GIRDER_Y1 + 1.6,
        CRANE_GIRDER_HALF_GAP + 0.3,
        0.04
      ),
      CRANE_FRAME_TINT
    );
  for (const endX of [CRANE_BOOM_X0 + 0.25, CRANE_BOOM_X1 - 0.25]) {
    add(
      greyPaint,
      boxBetween(
        endX - 0.25,
        CRANE_GIRDER_Y0 + 0.1,
        -CRANE_GIRDER_HALF_GAP + 0.45,
        endX + 0.25,
        CRANE_GIRDER_Y1 - 0.1,
        CRANE_GIRDER_HALF_GAP - 0.45,
        0.05
      ),
      CRANE_FRAME_TINT
    );
    const inward = endX < 30 ? 1 : -1;
    for (const sheaveZ of [-0.8, 0.8])
      add(darkSteel, cylinderAt(0.14, 0.14, 0.4, 'x', endX + inward * 0.45, 22, sheaveZ, 10));
  }
  add(
    galvSteel,
    boxBetween(
      CRANE_BOOM_X1 - 0.1,
      21.86,
      -CRANE_GIRDER_HALF_GAP - 1.35,
      CRANE_BOOM_X1 + 0.9,
      21.9,
      CRANE_GIRDER_HALF_GAP + 1.35
    )
  );
  railingAlong(
    batcher,
    yellowPaint,
    [
      [CRANE_BOOM_X1 - 0.1, 21.9, -CRANE_GIRDER_HALF_GAP - 1.32],
      [CRANE_BOOM_X1 + 0.87, 21.9, -CRANE_GIRDER_HALF_GAP - 1.32],
      [CRANE_BOOM_X1 + 0.87, 21.9, CRANE_GIRDER_HALF_GAP + 1.32],
      [CRANE_BOOM_X1 - 0.1, 21.9, CRANE_GIRDER_HALF_GAP + 1.32]
    ],
    {
      post: 1.4,
      tint: CRANE_YELLOW_TINT
    }
  );
  add(
    galvSteel,
    rodBetween([CRANE_BOOM_X1 + 0.6, 21.9, 0], [CRANE_BOOM_X1 + 0.6, 25.2, 0], 0.035, 6)
  );
  add(
    galvSteel,
    rodBetween([CRANE_BOOM_X1 + 0.6, 24.8, -0.45], [CRANE_BOOM_X1 + 0.6, 24.8, 0.45], 0.015, 4)
  );
  lights.add(beaconGeometry(CRANE_BOOM_X1 + 0.6, 25.32, 0, 0.13), [9, 0.5, 0.25], 2.6, 0.5, 0.45);
  add(darkSteel, cylinderAt(0.1, 0.12, 0.1, 'y', CRANE_BOOM_X1 + 0.6, 25.2, 0, 8));
  const apexX = 27.6;
  const apexY = 30;
  const apexHalfWidth = 1.5;
  for (const side of [-1, 1]) {
    add(
      greyPaint,
      beamBetween(
        [CRANE_RAIL_SEA_X, 23.8, side * CRANE_LEG_HALF_SPAN],
        [apexX, apexY, side * apexHalfWidth],
        0.55,
        0.55,
        0.04
      ),
      CRANE_FRAME_TINT
    );
    add(
      greyPaint,
      beamBetween(
        [CRANE_RAIL_LAND_X, 23.8, side * CRANE_LEG_HALF_SPAN],
        [apexX, apexY, side * apexHalfWidth],
        0.5,
        0.5,
        0.04
      ),
      CRANE_FRAME_TINT
    );
    for (const [anchorX, radius] of [
      [44, 0.1],
      [58, 0.1]
    ]) {
      const tieStart = v3(apexX + 0.3, apexY, side * apexHalfWidth);
      const tieEnd = v3(anchorX, CRANE_GIRDER_Y1 + 1.45, side * CRANE_GIRDER_HALF_GAP);
      add(greyPaint, rodBetween(tieStart, tieEnd, radius, 8), CRANE_FRAME_TINT);
      const tieMid = tieStart.clone().lerp(tieEnd, 0.5);
      add(
        greyPaint,
        boxBetween(
          tieMid.x - 0.3,
          tieMid.y - 0.16,
          tieMid.z - 0.14,
          tieMid.x + 0.3,
          tieMid.y + 0.16,
          tieMid.z + 0.14,
          0.03
        ),
        CRANE_SHADOW_TINT
      );
    }
    add(
      darkSteel,
      rodBetween(
        [apexX + 0.2, apexY + 0.35, side * 0.9],
        [50, CRANE_GIRDER_Y1 + 0.2, side * 1],
        0.022,
        5
      )
    );
    add(darkSteel, cylinderAt(0.5, 0.5, 0.18, 'z', apexX, apexY + 0.25, side * 0.9, 16));
  }
  add(
    greyPaint,
    boxBetween(
      apexX - 0.45,
      apexY - 0.35,
      -apexHalfWidth - 0.5,
      apexX + 0.45,
      apexY + 0.3,
      apexHalfWidth + 0.5,
      0.05
    ),
    CRANE_FRAME_TINT
  );
  {
    const seaLegPoint = (t: number, side: number) =>
      v3(
        CRANE_RAIL_SEA_X + (apexX - CRANE_RAIL_SEA_X) * t,
        23.8 + (apexY - 23.8) * t,
        side * (CRANE_LEG_HALF_SPAN + (apexHalfWidth - CRANE_LEG_HALF_SPAN) * t)
      );
    const landLegPoint = (t: number, side: number) =>
      v3(
        CRANE_RAIL_LAND_X + (apexX - CRANE_RAIL_LAND_X) * t,
        23.8 + (apexY - 23.8) * t,
        side * (CRANE_LEG_HALF_SPAN + (apexHalfWidth - CRANE_LEG_HALF_SPAN) * t)
      );
    add(
      greyPaint,
      beamBetween(seaLegPoint(0.5, -1), seaLegPoint(0.5, 1), 0.3, 0.3, 0.02),
      CRANE_FRAME_TINT
    );
    add(
      greyPaint,
      beamBetween(landLegPoint(0.55, -1), landLegPoint(0.55, 1), 0.3, 0.3, 0.02),
      CRANE_FRAME_TINT
    );
    add(
      greyPaint,
      rodBetween(landLegPoint(0.55, -1), seaLegPoint(0.5, -1), 0.09, 6),
      CRANE_FRAME_TINT
    );
    add(
      greyPaint,
      rodBetween(landLegPoint(0.55, 1), seaLegPoint(0.5, 1), 0.09, 6),
      CRANE_FRAME_TINT
    );
    const ladderStart = seaLegPoint(0.02, 1);
    const ladderEnd = seaLegPoint(0.97, 1);
    for (const railOffset of [-0.22, 0.22])
      add(
        galvSteel,
        rodBetween(
          [ladderStart.x - 0.42, ladderStart.y, ladderStart.z + railOffset],
          [ladderEnd.x - 0.42, ladderEnd.y, ladderEnd.z + railOffset],
          0.02,
          4
        )
      );
    for (let t = 0.03; t < 1; t += 0.045) {
      const rungCenter = ladderStart.clone().lerp(ladderEnd, t);
      add(
        galvSteel,
        rodBetween(
          [rungCenter.x - 0.42, rungCenter.y, rungCenter.z - 0.22],
          [rungCenter.x - 0.42, rungCenter.y, rungCenter.z + 0.22],
          0.012,
          4
        )
      );
    }
  }
  add(
    greyPaint,
    boxBetween(
      CRANE_BOOM_X0 + 0.05,
      CRANE_GIRDER_Y1,
      -3.6,
      CRANE_BOOM_X0 + 0.55,
      CRANE_GIRDER_Y1 + 0.4,
      3.6,
      0.04
    ),
    CRANE_FRAME_TINT
  );
  for (const side of [-1, 1]) {
    add(
      greyPaint,
      boxBetween(
        CRANE_BOOM_X0 + 0.08,
        CRANE_GIRDER_Y1 + 0.4,
        side * 3.3 - 0.2,
        CRANE_BOOM_X0 + 0.52,
        CRANE_GIRDER_Y1 + 1,
        side * 3.3 + 0.2,
        0.03
      ),
      CRANE_SHADOW_TINT
    );
    add(
      greyPaint,
      rodBetween(
        [apexX - 0.3, apexY, side * apexHalfWidth],
        [CRANE_BOOM_X0 + 0.3, CRANE_GIRDER_Y1 + 0.8, side * 3.3],
        0.1,
        8
      ),
      CRANE_FRAME_TINT
    );
    add(
      galvSteel,
      cylinderAt(0.12, 0.12, 0.6, 'z', CRANE_BOOM_X0 + 0.3, CRANE_GIRDER_Y1 + 0.8, side * 3.3, 10)
    );
  }
  add(
    galvSteel,
    boxBetween(
      apexX - 1,
      apexY + 0.3,
      -apexHalfWidth - 0.6,
      apexX + 1,
      apexY + 0.34,
      apexHalfWidth + 0.6
    )
  );
  railingAlong(
    batcher,
    yellowPaint,
    [
      [apexX - 0.98, apexY + 0.34, -apexHalfWidth - 0.58],
      [apexX + 0.98, apexY + 0.34, -apexHalfWidth - 0.58],
      [apexX + 0.98, apexY + 0.34, apexHalfWidth + 0.58],
      [apexX - 0.98, apexY + 0.34, apexHalfWidth + 0.58],
      [apexX - 0.98, apexY + 0.34, -apexHalfWidth - 0.58]
    ],
    {
      post: 1.2,
      tint: CRANE_YELLOW_TINT
    }
  );
  add(galvSteel, rodBetween([apexX, apexY + 0.34, 0], [apexX, apexY + 2, 0], 0.045, 6));
  add(galvSteel, rodBetween([apexX, apexY + 2, 0], [apexX, apexY + 3.6, 0], 0.016, 4));
  add(
    galvSteel,
    rodBetween([apexX - 0.5, apexY + 1.5, 0], [apexX + 0.5, apexY + 1.5, 0], 0.018, 4)
  );
  for (const beaconOffset of [-0.5, 0.5]) {
    add(darkSteel, cylinderAt(0.1, 0.12, 0.1, 'y', apexX + beaconOffset, apexY + 1.56, 0, 8));
    lights.add(
      beaconGeometry(apexX + beaconOffset, apexY + 1.72, 0, 0.15),
      [10, 0.5, 0.25],
      2.6,
      0,
      0.45
    );
  }
  const machX0 = 20.4;
  const machX1 = 27.9;
  const machY0 = CRANE_GIRDER_Y1;
  const machY1 = 26;
  const machHalfDepth = 2.9;
  add(
    whitePaint,
    boxBetween(machX0, machY0, -machHalfDepth, machX1, machY1, machHalfDepth, 0.06),
    CRANE_WHITE_TINT
  );
  add(
    greyPaint,
    boxBetween(
      machX0 - 0.15,
      machY0 - 0.12,
      -machHalfDepth - 0.15,
      machX1 + 0.15,
      machY0 + 0.1,
      machHalfDepth + 0.15,
      0.03
    ),
    CRANE_SHADOW_TINT
  );
  add(
    galvSteel,
    boxBetween(
      machX0 - 0.2,
      machY1,
      -machHalfDepth - 0.2,
      machX1 + 0.2,
      machY1 + 0.12,
      machHalfDepth + 0.2,
      0.03
    )
  );
  for (let ribX = machX0 + 1.3; ribX < machX1; ribX += 1.3)
    for (const side of [-1, 1])
      add(
        whitePaint,
        boxBetween(
          ribX - 0.02,
          machY0 + 0.1,
          side * machHalfDepth - 0.015,
          ribX + 0.02,
          machY1,
          side * machHalfDepth + 0.015
        ),
        [0.7, 0.72, 0.74]
      );
  function addLouvreVent(
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    rotY: number
  ) {
    const parts = [boxBetween(-width / 2, -height / 2, 0, width / 2, height / 2, 0.02)];
    const slatCount = Math.round(height / 0.12);
    for (let i = 0; i < slatCount; i++) {
      const slat = boxBetween(-width / 2 + 0.03, -0.012, 0, width / 2 - 0.03, 0.012, 0.11);
      slat.rotateX(0.7);
      slat.translate(0, -height / 2 + (i + 0.5) * (height / slatCount), 0.03);
      parts.push(slat);
    }
    for (const part of parts) {
      part.rotateY(rotY);
      part.translate(x, y, z);
    }
    add(darkSteel, parts.shift());
    add(galvSteel, parts);
  }
  for (const side of [-1, 1])
    for (const ventX of [machX0 + 1.4, machX0 + 3.9, machX0 + 6.1])
      addLouvreVent(ventX, 24.5, side * (machHalfDepth + 0.005), 1.5, 1.3, side > 0 ? 0 : Math.PI);
  addLouvreVent(machX0 - 0.005, 23.75, -1.9, 1.4, 1.1, -Math.PI / 2);
  add(
    whitePaint,
    boxBetween(machX0 - 0.03, machY0 + 0.15, 0.8, machX0, machY0 + 2.15, 1.7, 0.01),
    [0.6, 0.64, 0.68]
  );
  add(
    galvSteel,
    rodBetween([machX0 - 0.06, machY0 + 1, 1.55], [machX0 - 0.06, machY0 + 1.3, 1.55], 0.014, 5)
  );
  add(galvSteel, boxBetween(machX0 - 0.9, machY0 + 0.05, 0.3, machX0, machY0 + 0.1, 2.2));
  railingAlong(
    batcher,
    yellowPaint,
    [
      [machX0, machY0 + 0.1, 0.32],
      [machX0 - 0.88, machY0 + 0.1, 0.32],
      [machX0 - 0.88, machY0 + 0.1, 2.18],
      [machX0, machY0 + 0.1, 2.18]
    ],
    {
      post: 1,
      tint: CRANE_YELLOW_TINT
    }
  );
  const logoDecal = game.mats.decal('logo_a');
  add(
    logoDecal.material,
    planeAt(1.1 * Math.min(3, logoDecal.aspect || 1), 1.1, machX0 - 0.012, 25.2, 0, -Math.PI / 2)
  );
  railingAlong(
    batcher,
    yellowPaint,
    [
      [machX0, machY1 + 0.12, -machHalfDepth],
      [machX1, machY1 + 0.12, -machHalfDepth],
      [machX1, machY1 + 0.12, machHalfDepth],
      [machX0, machY1 + 0.12, machHalfDepth],
      [machX0, machY1 + 0.12, -machHalfDepth]
    ],
    {
      post: 1.95,
      tint: CRANE_YELLOW_TINT
    }
  );
  for (const fanX of [machX0 + 1.9, machX0 + 5.6]) {
    add(galvSteel, cylinderAt(0.28, 0.28, 0.5, 'y', fanX, machY1 + 0.37, -1.2, 10));
    add(galvSteel, cylinderAt(0.1, 0.5, 0.22, 'y', fanX, machY1 + 0.72, -1.2, 10));
  }
  add(darkSteel, cylinderAt(0.13, 0.13, 1.6, 'y', machX0 + 3.7, machY1 + 0.9, 1.9, 8));
  add(darkSteel, cylinderAt(0.2, 0.14, 0.2, 'y', machX0 + 3.7, machY1 + 1.75, 1.9, 8));
  add(
    whitePaint,
    boxBetween(machX0 + 5.4, machY1 + 0.12, 0.4, machX0 + 6.7, machY1 + 0.85, 1.8, 0.03),
    [0.7, 0.72, 0.75]
  );
  add(
    galvSteel,
    rodBetween([machX0 + 0.3, machY1 + 0.12, 2.5], [machX0 + 0.3, machY1 + 1.9, 2.5], 0.03, 5)
  );
  lights.add(
    beaconGeometry(machX0 + 0.3, machY1 + 2.02, 2.5, 0.13),
    [9, 0.5, 0.25],
    2.6,
    0.25,
    0.45
  );
  const stairZ0 = 6.15;
  const stairZMid = 6.97;
  const stairZ1 = 7.8;
  const landLanding = [19.4, 20.6];
  const seaLanding = [26.4, 27.6];
  function addStairFlight(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number) {
    const rise = y1 - y0;
    const stepCount = Math.max(2, Math.round(rise / 0.21));
    for (const railZ of [z0 + 0.03, z1 - 0.03]) {
      add(galvSteel, beamBetween([x0, y0 - 0.12, railZ], [x1, y1 - 0.12, railZ], 0.05, 0.24));
      add(
        yellowPaint,
        rodBetween([x0, y0 + 1, railZ], [x1, y1 + 1, railZ], 0.024, 5),
        CRANE_YELLOW_TINT
      );
      add(
        yellowPaint,
        rodBetween([x0, y0 + 0.5, railZ], [x1, y1 + 0.5, railZ], 0.018, 4),
        CRANE_YELLOW_TINT
      );
      for (let k = 0; k <= 4; k++) {
        const t = k / 4;
        const postX = x0 + (x1 - x0) * t;
        const postY = y0 + rise * t;
        add(
          yellowPaint,
          rodBetween([postX, postY - 0.05, railZ], [postX, postY + 1, railZ], 0.02, 4),
          CRANE_YELLOW_TINT
        );
      }
    }
    for (let step = 1; step <= stepCount; step++) {
      const t = (step - 0.5) / stepCount;
      const stepX = x0 + (x1 - x0) * t;
      const stepY = y0 + rise * (step / stepCount);
      add(
        galvSteel,
        boxBetween(stepX - 0.13, stepY - 0.03, z0 + 0.06, stepX + 0.13, stepY, z1 - 0.06)
      );
    }
  }
  function addLanding(x0: number, x1: number, y: number, dir: number) {
    add(galvSteel, boxBetween(x0, y - 0.05, stairZ0, x1, y, stairZ1));
    add(galvSteel, boxBetween(x0, y - 0.2, stairZ0, x1, y - 0.05, stairZ0 + 0.06));
    add(galvSteel, boxBetween(x0, y - 0.2, stairZ1 - 0.06, x1, y - 0.05, stairZ1));
    const railX = dir > 0 ? x1 - 0.03 : x0 + 0.03;
    const openX = dir > 0 ? x0 : x1;
    railingAlong(
      batcher,
      yellowPaint,
      [
        [openX, y, stairZ1 - 0.03],
        [railX, y, stairZ1 - 0.03],
        [railX, y, stairZ0 + 0.03]
      ],
      {
        post: 0.9,
        tint: CRANE_YELLOW_TINT
      }
    );
  }
  const landingYs = [3.6, 6.9, 10.2, 13.5, 16.8, 20.1];
  for (let flight = 0; flight < 5; flight++)
    if (flight % 2 === 0) {
      addLanding(landLanding[0], landLanding[1], landingYs[flight], -1);
      addStairFlight(
        landLanding[1],
        landingYs[flight],
        seaLanding[0],
        landingYs[flight + 1],
        stairZ0,
        stairZMid
      );
    } else {
      addLanding(seaLanding[0], seaLanding[1], landingYs[flight], 1);
      addStairFlight(
        seaLanding[0],
        landingYs[flight],
        landLanding[1],
        landingYs[flight + 1],
        stairZMid,
        stairZ1
      );
    }
  addLanding(seaLanding[0], seaLanding[1], landingYs[5], 1);
  addStairFlight(seaLanding[0], landingYs[5], 23.4, 21.9, stairZMid, stairZ1);
  add(galvSteel, boxBetween(22.5, 21.85, CRANE_GIRDER_HALF_GAP + 1.35, 23.4, 21.9, stairZ1));
  railingAlong(
    batcher,
    yellowPaint,
    [
      [22.53, 21.9, CRANE_GIRDER_HALF_GAP + 1.4],
      [22.53, 21.9, stairZ1 - 0.03],
      [23.37, 21.9, stairZ1 - 0.03]
    ],
    {
      post: 1.3,
      tint: CRANE_YELLOW_TINT
    }
  );
  railingAlong(
    batcher,
    yellowPaint,
    [
      [23.37, 21.9, CRANE_GIRDER_HALF_GAP + 1.4],
      [23.37, 21.9, stairZMid]
    ],
    {
      post: 1.3,
      tint: CRANE_YELLOW_TINT
    }
  );
  add(galvSteel, boxBetween(seaLanding[0], 13.45, 4.95, seaLanding[1], 13.5, stairZ0));
  for (const postX of [landLanding[0], seaLanding[1]])
    for (const postZ of [stairZ0 - 0.05, stairZ1 + 0.05])
      add(
        greyPaint,
        boxBetween(postX - 0.07, 3.3, postZ - 0.07, postX + 0.07, 21.4, postZ + 0.07),
        CRANE_FRAME_TINT
      );
  for (let level = 0; level < landingYs.length; level++) {
    const braceY = landingYs[level] - 0.25;
    add(
      greyPaint,
      boxBetween(
        landLanding[0],
        braceY - 0.06,
        stairZ1 + 0,
        seaLanding[1],
        braceY + 0.06,
        stairZ1 + 0.1
      ),
      CRANE_SHADOW_TINT
    );
    for (const postX of [landLanding[0], seaLanding[1]])
      add(
        greyPaint,
        boxBetween(postX - 0.05, braceY - 0.06, 5.9, postX + 0.05, braceY + 0.06, stairZ1 + 0.1),
        CRANE_SHADOW_TINT
      );
    if (level < landingYs.length - 1) {
      const nextY = landingYs[level + 1] - 0.25;
      add(
        greyPaint,
        rodBetween(
          [landLanding[0], braceY, stairZ1 + 0.05],
          [seaLanding[1], nextY, stairZ1 + 0.05],
          0.03,
          5
        ),
        CRANE_FRAME_TINT
      );
      add(
        greyPaint,
        rodBetween(
          [seaLanding[1], braceY, stairZ1 + 0.05],
          [landLanding[0], nextY, stairZ1 + 0.05],
          0.03,
          5
        ),
        CRANE_FRAME_TINT
      );
    }
  }
  {
    const ladderX = landLanding[0] - 0.05;
    const ladderZ = 7.35;
    for (const railOffset of [-0.22, 0.22])
      add(
        galvSteel,
        rodBetween(
          [ladderX, 0.05, ladderZ + railOffset],
          [ladderX, 4.75, ladderZ + railOffset],
          0.022,
          5
        )
      );
    for (let rungY = 0.3; rungY < 4.7; rungY += 0.3)
      add(
        galvSteel,
        rodBetween([ladderX, rungY, ladderZ - 0.22], [ladderX, rungY, ladderZ + 0.22], 0.012, 4)
      );
    const cageHoop = (y: number) => {
      const points = [];
      for (let k = 0; k <= 8; k++) {
        const angle = (Math.PI * k) / 8;
        points.push(v3(ladderX - Math.sin(angle) * 0.7, y, ladderZ - Math.cos(angle) * 0.36));
      }
      return points;
    };
    for (let hoopY = 2.3; hoopY <= 4.75; hoopY += 0.6)
      add(galvSteel, polylineRods(cageHoop(hoopY), 0.012, 4));
    for (let k = 1; k < 8; k += 1.5) {
      const angle = (Math.PI * k) / 8;
      add(
        galvSteel,
        rodBetween(
          [ladderX - Math.sin(angle) * 0.7, 2.3, ladderZ - Math.cos(angle) * 0.36],
          [ladderX - Math.sin(angle) * 0.7, 4.75, ladderZ - Math.cos(angle) * 0.36],
          0.01,
          4
        )
      );
    }
    colliders.push({
      min: [ladderX - 0.72, 0, ladderZ - 0.4],
      max: [ladderX + 0.05, 4.7, ladderZ + 0.4],
      bulletOnly: false
    });
  }
  add(
    darkSteel,
    boxBetween(
      13,
      21.02,
      -CRANE_GIRDER_HALF_GAP - 0.95,
      CRANE_TROLLEY_X - 1.2,
      21.12,
      -CRANE_GIRDER_HALF_GAP - 0.85
    )
  );
  for (let hangerX = 13.5; hangerX < CRANE_TROLLEY_X - 1.2; hangerX += 3.3)
    add(
      darkSteel,
      boxBetween(
        hangerX - 0.03,
        21.1,
        -CRANE_GIRDER_HALF_GAP - 0.93,
        hangerX + 0.03,
        21.86,
        -CRANE_GIRDER_HALF_GAP - 0.87
      )
    );
  {
    const festoonSpacing = (CRANE_TROLLEY_X - 1.6 - 13.6) / 15;
    for (let i = 0; i < 15; i++) {
      const festoonX = 13.6 + i * festoonSpacing;
      const sag = 1.1 + 0.25 * Math.sin(i * 2.1);
      add(
        darkSteel,
        boxBetween(
          festoonX - 0.1,
          20.9,
          -CRANE_GIRDER_HALF_GAP - 0.98,
          festoonX + 0.1,
          21.02,
          -CRANE_GIRDER_HALF_GAP - 0.82
        )
      );
      for (const offset of [-0.05, 0.05]) {
        const points = [];
        for (let k = 0; k <= 7; k++) {
          const t = k / 7;
          points.push(
            v3(
              festoonX + festoonSpacing * t,
              20.92 - sag * (1 - (2 * t - 1) ** 2),
              -CRANE_GIRDER_HALF_GAP - 0.9 + offset
            )
          );
        }
        add(darkSteel, polylineRods(points, 0.03, 4));
      }
    }
  }
  function addFloodlights(x: number, y: number, z: number, count: number, axis: 'x' | 'z' = 'z') {
    const span = count * 0.46;
    if (axis === 'z') {
      add(darkSteel, boxBetween(x - 0.03, y, z - span / 2, x + 0.03, y + 0.06, z + span / 2));
    } else {
      add(darkSteel, boxBetween(x - span / 2, y, z - 0.03, x + span / 2, y + 0.06, z + 0.03));
    }
    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * 0.46;
      const lampX = axis === 'z' ? x : x + offset;
      const lampZ = axis === 'z' ? z + offset : z;
      add(
        darkSteel,
        boxBetween(lampX - 0.17, y - 0.2, lampZ - 0.17, lampX + 0.17, y, lampZ + 0.17, 0.02)
      );
      add(
        lampEmissive,
        boxBetween(lampX - 0.14, y - 0.215, lampZ - 0.14, lampX + 0.14, y - 0.2, lampZ + 0.14)
      );
    }
  }
  for (const lightX of [33, 47.5, 59.5])
    for (const side of [-1, 1])
      addFloodlights(lightX, 21.3, side * (CRANE_GIRDER_HALF_GAP + 1.3), 3, 'x');
  for (const side of [-1, 1]) {
    addFloodlights(23.5, 12.28, side * (CRANE_LEG_HALF_SPAN - 0.2), 4, 'x');
    addFloodlights(15, 21.3, side * (CRANE_GIRDER_HALF_GAP + 1.3), 2, 'x');
  }
  addFloodlights(CRANE_RAIL_SEA_X + 0.1, 12.28, 0, 3, 'z');
  addFloodlights(CRANE_RAIL_LAND_X - 0.1, 12.28, 0, 3, 'z');
  addFloodlights(apexX + 0.6, apexY - 0.55, 0, 3, 'z');
  add(
    yellowPaint,
    boxBetween(CRANE_TROLLEY_X - 2.3, 21.35, -1.25, CRANE_TROLLEY_X + 2.3, 22.2, 1.25, 0.06),
    CRANE_YELLOW_TINT
  );
  add(
    yellowPaint,
    boxBetween(CRANE_TROLLEY_X - 1.6, 20.7, -1.1, CRANE_TROLLEY_X + 1.6, 21.35, 1.1, 0.05),
    CRANE_YELLOW_TINT
  );
  for (const wheelX of [-1.8, 1.8])
    for (const side of [-1, 1]) {
      add(
        darkSteel,
        cylinderAt(0.24, 0.24, 0.16, 'z', CRANE_TROLLEY_X + wheelX, 22.42, side * 1.3, 12)
      );
      add(
        yellowPaint,
        boxBetween(
          CRANE_TROLLEY_X + wheelX - 0.35,
          22.1,
          side * 1.3 - 0.14,
          CRANE_TROLLEY_X + wheelX + 0.35,
          22.5,
          side * 1.3 + 0.14,
          0.03
        ),
        CRANE_YELLOW_TINT
      );
    }
  add(darkSteel, cylinderAt(0.42, 0.42, 1.5, 'z', CRANE_TROLLEY_X - 0.9, 22.35, 0, 14));
  add(darkSteel, cylinderAt(0.42, 0.42, 1.5, 'z', CRANE_TROLLEY_X + 0.9, 22.35, 0, 14));
  const cabX0 = CRANE_TROLLEY_X + 0.25;
  const cabX1 = CRANE_TROLLEY_X + 2.65;
  const cabZ0 = 2.35;
  const cabZ1 = 4.4;
  const cabFloorY = 18.3;
  const cabRoofY = 20.7;
  for (const hangerX of [cabX0 + 0.12, cabX1 - 0.3]) {
    add(
      yellowPaint,
      boxBetween(hangerX - 0.12, 20.88, -1, hangerX + 0.12, 21.16, cabZ1, 0.03),
      CRANE_YELLOW_TINT
    );
    for (const hangerZ of [cabZ0 + 0.1, cabZ1 - 0.1])
      add(
        yellowPaint,
        boxBetween(hangerX - 0.06, cabRoofY, hangerZ - 0.06, hangerX + 0.06, 20.9, hangerZ + 0.06),
        CRANE_YELLOW_TINT
      );
  }
  add(
    whitePaint,
    boxBetween(cabX0, cabFloorY, cabZ0, cabX1, cabFloorY + 0.14, cabZ1, 0.03),
    CRANE_WHITE_TINT
  );
  add(
    whitePaint,
    boxBetween(
      cabX0 - 0.08,
      cabRoofY - 0.02,
      cabZ0 - 0.08,
      cabX1 + 0.12,
      cabRoofY + 0.12,
      cabZ1 + 0.08,
      0.03
    ),
    CRANE_WHITE_TINT
  );
  add(
    whitePaint,
    boxBetween(cabX0, cabFloorY + 0.14, cabZ0, cabX0 + 0.08, cabRoofY, cabZ1),
    CRANE_WHITE_TINT
  );
  for (const wallZ of [cabZ0, cabZ1 - 0.06]) {
    add(
      whitePaint,
      boxBetween(cabX0, cabFloorY + 0.14, wallZ, cabX1 - 0.5, cabFloorY + 0.95, wallZ + 0.06),
      CRANE_WHITE_TINT
    );
    add(
      glass,
      boxBetween(cabX0 + 0.08, cabFloorY + 0.95, wallZ + 0.02, cabX1 - 0.06, cabRoofY, wallZ + 0.04)
    );
    add(
      glass,
      boxBetween(
        cabX1 - 0.5,
        cabFloorY + 0.14,
        wallZ + 0.02,
        cabX1 - 0.06,
        cabFloorY + 0.95,
        wallZ + 0.04
      )
    );
  }
  for (const mullionX of [cabX1 - 0.06])
    for (const mullionZ of [cabZ0, cabZ1 - 0.06, (cabZ0 + cabZ1) / 2 - 0.03])
      add(
        whitePaint,
        boxBetween(
          mullionX,
          cabFloorY + 0.14,
          mullionZ,
          mullionX + 0.06,
          cabRoofY,
          mullionZ + 0.06
        ),
        CRANE_WHITE_TINT
      );
  add(
    glass,
    boxBetween(cabX1 - 0.04, cabFloorY + 0.14, cabZ0 + 0.06, cabX1 - 0.02, cabRoofY, cabZ1 - 0.06)
  );
  add(
    glass,
    boxBetween(
      cabX1 - 0.9,
      cabFloorY + 0.02,
      cabZ0 + 0.3,
      cabX1 - 0.1,
      cabFloorY + 0.04,
      cabZ1 - 0.3
    )
  );
  add(
    darkSteel,
    boxBetween(cabX0 + 0.9, cabFloorY + 0.14, 3.1, cabX0 + 1.45, cabFloorY + 0.6, 3.65, 0.04)
  );
  add(
    darkSteel,
    boxBetween(cabX0 + 0.82, cabFloorY + 0.6, 3.1, cabX0 + 0.96, cabFloorY + 1.35, 3.65, 0.04)
  );
  for (const consoleZ of [2.75, 4]) {
    add(
      darkSteel,
      boxBetween(
        cabX0 + 1.2,
        cabFloorY + 0.14,
        consoleZ - 0.16,
        cabX0 + 1.75,
        cabFloorY + 0.85,
        consoleZ + 0.16,
        0.03
      )
    );
    lights.add(
      boxBetween(
        cabX0 + 1.3,
        cabFloorY + 0.855,
        consoleZ - 0.1,
        cabX0 + 1.6,
        cabFloorY + 0.865,
        consoleZ + 0.1
      ),
      [0.75, 0.5, 0.26],
      0
    );
  }
  lights.add(
    boxBetween(cabX0 + 0.5, cabRoofY - 0.045, 3, cabX0 + 1.5, cabRoofY - 0.03, 3.2),
    [0.75, 0.5, 0.26],
    0
  );
  addFloodlights(cabX1 + 0.15, cabFloorY + 0.1, 3.37, 2, 'z');
  add(galvSteel, boxBetween(cabX0 - 0.9, cabFloorY + 0.1, cabZ0, cabX0, cabFloorY + 0.14, cabZ1));
  railingAlong(
    batcher,
    yellowPaint,
    [
      [cabX0, cabFloorY + 0.14, cabZ0 + 0.03],
      [cabX0 - 0.87, cabFloorY + 0.14, cabZ0 + 0.03],
      [cabX0 - 0.87, cabFloorY + 0.14, cabZ1 - 0.03],
      [cabX0, cabFloorY + 0.14, cabZ1 - 0.03]
    ],
    {
      post: 1,
      tint: CRANE_YELLOW_TINT
    }
  );
  const craneLabel = game.mats.label('SALTLINE 04', {
    color: 'white',
    font: 'stencil',
    distress: 0.35
  });
  const labelAspect = Math.max(1, craneLabel.aspect || 6);
  {
    const labelHeight = Math.min(1.15, 8.6 / labelAspect);
    for (const side of [-1, 1])
      add(
        craneLabel.material,
        planeAt(
          labelHeight * labelAspect,
          labelHeight,
          36.9,
          22,
          side * (CRANE_GIRDER_HALF_GAP + 0.453),
          side > 0 ? 0 : Math.PI
        )
      );
  }
  {
    const labelHeight = Math.min(0.86, 9.4 / labelAspect);
    add(
      craneLabel.material,
      planeAt(
        labelHeight * labelAspect,
        labelHeight,
        CRANE_RAIL_LAND_X - 0.453,
        13,
        0,
        -Math.PI / 2
      )
    );
  }
  if (isProxy) {
    batcher.remap = null;
    batcher.dz = 0;
    batcher.minSize = 0;
    return null;
  }
  const root = batcher.build({
    cast: true,
    recv: true
  });
  root.name = 'crane';
  const spreaderBatcher = new MaterialBatcher();
  const addSpreader = (material: Material, geometry: BatchGeometry, tint?: Rgb) =>
    spreaderBatcher.add(material, geometry, tint);
  const hoistDrop = 8.3;
  for (const ropeX of [-0.9, 0.9])
    for (const ropeZ of [-0.8, 0.8])
      addSpreader(
        darkSteel,
        rodBetween([ropeX, 0, ropeZ], [ropeX * 0.8, -hoistDrop, ropeZ * 0.7], 0.022, 5)
      );
  addSpreader(
    yellowPaint,
    boxBetween(-0.95, -hoistDrop - 0.55, -0.75, 0.95, -hoistDrop, 0.75, 0.05),
    CRANE_YELLOW_TINT
  );
  for (const sheaveZ of [-0.45, 0.45])
    addSpreader(darkSteel, cylinderAt(0.3, 0.3, 0.12, 'z', 0, -hoistDrop + 0.12, sheaveZ, 12));
  const frameTop = -hoistDrop - 0.55;
  const frameBottom = frameTop - 0.34;
  for (const beamX of [-0.6, 0.6])
    addSpreader(
      yellowPaint,
      boxBetween(beamX - 0.16, frameBottom, -6.02, beamX + 0.16, frameTop, 6.02, 0.03),
      CRANE_YELLOW_TINT
    );
  for (const beamZ of [-5.92, 5.92])
    addSpreader(
      yellowPaint,
      boxBetween(-1.22, frameBottom, beamZ - 0.14, 1.22, frameTop, beamZ + 0.14, 0.03),
      CRANE_YELLOW_TINT
    );
  addSpreader(
    yellowPaint,
    boxBetween(-0.9, frameBottom - 0.02, -1.3, 0.9, frameTop + 0.1, 1.3, 0.04),
    CRANE_YELLOW_TINT
  );
  for (const cornerX of [-1.2, 1.2])
    for (const cornerZ of [-6, 6]) {
      addSpreader(
        darkSteel,
        boxBetween(
          cornerX - 0.1,
          frameBottom - 0.1,
          cornerZ - 0.1,
          cornerX + 0.1,
          frameBottom + 0.05,
          cornerZ + 0.1
        )
      );
      addSpreader(
        yellowPaint,
        beamBetween(
          [cornerX * 1.02, frameBottom, cornerZ * 1.01],
          [cornerX * 1.22, frameBottom - 0.55, cornerZ * 1.04],
          0.28,
          0.03
        ),
        CRANE_YELLOW_TINT
      );
    }
  const boxTop = frameBottom - 0.08;
  const boxBottom = boxTop - 2.59;
  const containerTint = [0.9, 0.82, 0.8];
  addSpreader(redPaint, boxBetween(-1.2, boxBottom, -6.08, 1.2, boxTop, 6.08, 0.03), containerTint);
  for (const sideX of [-1.22, 1.22])
    for (let ribZ = -5.7; ribZ <= 5.71; ribZ += 0.57)
      addSpreader(
        redPaint,
        boxBetween(
          sideX - 0.02,
          boxBottom + 0.16,
          ribZ - 0.1,
          sideX + 0.02,
          boxTop - 0.12,
          ribZ + 0.1
        ),
        containerTint
      );
  for (const endZ of [-6.095, 6.095])
    for (const cornerX of [-1.22, 1.22])
      addSpreader(
        redPaint,
        boxBetween(cornerX - 0.08, boxBottom, endZ - 0.08, cornerX + 0.08, boxTop, endZ + 0.08),
        [0.7, 0.62, 0.6]
      );
  for (const barX of [-0.8, -0.3, 0.3, 0.8])
    addSpreader(
      darkSteel,
      rodBetween([barX, boxBottom + 0.08, 6.1], [barX, boxTop - 0.08, 6.1], 0.02, 5)
    );
  const spreader = spreaderBatcher.build({
    cast: true,
    recv: true
  });
  spreader.position.set(CRANE_TROLLEY_X, 20.7, 0);
  spreader.userData.noMerge = true;
  spreader.name = 'crane-spreader';
  root.add(spreader);
  return {
    root,
    spreader,
    colliders,
    tris: batcher.tris + spreaderBatcher.tris
  };
}
/** Options for `addDistantCraneSilhouette`. */
export interface CraneSilhouetteOptions {
  /** Uniform scale. */
  s?: number;
  /** Boom raised (true) or lowered over the water. */
  up?: boolean;
  tint?: Rgb;
}

/**
 * Adds a low-poly crane silhouette at (x, 0, z) to `batcher` and returns the boom-tip
 * position `[x, y, z]` (where a beacon goes).
 */
export function addDistantCraneSilhouette(
  batcher: MaterialBatcher,
  material: Material,
  x: number,
  z: number,
  { s: scale = 1, up: boomUp = false, tint = [0.3, 0.36, 0.44] }: CraneSilhouetteOptions = {}
): [number, number, number] {
  const parts: BufferGeometry[] = [];
  const addBox = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
    parts.push(boxBetween(x0, y0, z0, x1, y1, z1));
  for (const legX of [-5, 5])
    for (const legZ of [-5.4, 5.4]) addBox(legX - 0.6, 0, legZ - 0.6, legX + 0.6, 24, legZ + 0.6);
  for (const frameZ of [-5.4, 5.4]) {
    addBox(-5, 12.5, frameZ - 0.45, 5, 13.5, frameZ + 0.45);
    addBox(-5, 23, frameZ - 0.4, 5, 23.8, frameZ + 0.4);
    parts.push(beamBetween([-5, 13.5, frameZ], [5, 23, frameZ], 0.4, 0.4));
  }
  for (const frameX of [-5, 5]) {
    addBox(frameX - 0.45, 12.5, -5.4, frameX + 0.45, 13.5, 5.4);
    addBox(frameX - 0.45, 22.8, -5.4, frameX + 0.45, 23.8, 5.4);
    addBox(frameX - 0.45, 3.6, -5.4, frameX + 0.45, 4.6, 5.4);
  }
  addBox(-11.5, 21.2, -2.3, 6.3, 22.8, 2.3);
  addBox(-10.9, 22.8, -2.9, -3.1, 26, 2.9);
  for (const side of [-1, 1]) {
    parts.push(beamBetween([5, 23.8, side * 5.4], [4.1, 30, side * 1.5], 0.6, 0.6));
    parts.push(beamBetween([-5, 23.8, side * 5.4], [4.1, 30, side * 1.5], 0.5, 0.5));
  }
  addBox(3.6, 29.6, -2, 4.6, 30.4, 2);
  if (boomUp) {
    parts.push(beamBetween([6.6, 22, 0], [10.5, 52, 0], 4.6, 1.6));
    parts.push(beamBetween([4.1, 30, 0], [9.4, 44, 0], 0.3, 0.3));
  } else {
    addBox(6.6, 21.2, -2.3, 38.5, 22.8, 2.3);
    parts.push(beamBetween([4.1, 30, 0], [20.5, 24.3, 0], 0.3, 0.3));
    parts.push(beamBetween([4.1, 30, 0], [34.5, 24.3, 0], 0.3, 0.3));
    addBox(15, 18.3, 2.4, 19.5, 22.2, 4.4);
  }
  for (const part of parts) {
    part.scale(scale, scale, scale);
    part.translate(x, 0, z);
    batcher.add(material, part, tint);
  }
  return boomUp ? [x + 10.5 * scale, 52.6 * scale, z] : [x + 4.1 * scale, 31 * scale, z];
}
