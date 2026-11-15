// The moored container ship "KITTIWAKE" (procedural hull, container bays, deckhouse,
// bridge, funnel, gangway, mooring lines) and the small RIB boat moored at the quay, plus
// container colour helpers shared with the skyline.
import type { Material } from 'three';
import type { Game } from '../core/types';
import type { BackdropCollider, BatchGeometry, BlinkLightBatch, Rgb } from './geometry';
import {
  BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  Float32BufferAttribute,
  Group,
  Quaternion,
  TorusGeometry,
  TubeGeometry,
  Vector3
} from 'three';
import {
  MaterialBatcher,
  beamBetween,
  boxBetween,
  cylinderAt,
  planeAt,
  polylineRods,
  railingAlong,
  rodBetween,
  sagCurvePoints,
  v3,
  weatheredMaterial,
  weatheredVertexColor
} from './geometry';
import { beaconGeometry } from './cranes';
const SHIP_CENTER_X = 41;
const SHIP_HALF_BEAM = 8;
const SHIP_BOW_Z = -9;
const SHIP_LENGTH = 63;
const SHIP_KEEL_Y = -4.4;
const SHIP_DECK_Y = 13;
const SHIP_WATERLINE_Y = -1.6;
const hullSmoothstep = (edge0: number, edge1: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return k * k * (3 - 2 * k);
};
/** Deck sheer (rise towards bow and stern) at distance `s` aft of the bow. */
const deckSheerAt = (s: number): number =>
  1.7 * Math.pow(Math.max(0, 1 - s / 20), 2) +
  0.5 * Math.pow(Math.max(0, (s - (SHIP_LENGTH - 12)) / 12), 2);
const deckHeightAt = (s: number): number => SHIP_DECK_Y + deckSheerAt(s);
const bulwarkHeightAt = (s: number): number =>
  1.15 * (1 - hullSmoothstep(14.5, 18, s) + hullSmoothstep(SHIP_LENGTH - 10.5, SHIP_LENGTH - 8, s));
const hullTopAt = (s: number): number => deckHeightAt(s) + bulwarkHeightAt(s);
const HULL_TOP_AT_BOW = hullTopAt(0);
/** Point on the hull skin at distance `s` aft of the bow, height `y`, on `side` (-1 port, 1 starboard). */
function hullSurfacePoint(s: number, y: number, side: number): Vector3 {
  const flare = (HULL_TOP_AT_BOW - y) * 0.22;
  const bowFade = Math.max(0, 1 - s / 22);
  const z = SHIP_BOW_Z - s - flare * bowFade;
  const heightFrac = Math.min(
    1,
    Math.max(0, (y - SHIP_WATERLINE_Y) / (SHIP_DECK_Y - SHIP_WATERLINE_Y))
  );
  const entryLength = 17 - 8.5 * Math.pow(heightFrac, 1.3);
  const entryT = s / entryLength;
  const widthFrac = entryT >= 1 ? 1 : Math.pow(Math.sin((entryT * Math.PI) / 2), 0.72);
  let halfWidth = 0.2 + (SHIP_HALF_BEAM - 0.2) * widthFrac;
  const sternT = (s - (SHIP_LENGTH - 10)) / 10;
  if (sternT > 0) {
    halfWidth *= 1 - 0.24 * sternT * sternT * (1 - 0.6 * heightFrac);
  }
  return new Vector3(SHIP_CENTER_X + side * halfWidth, y, z);
}
function hullSurfaceNormal(s: number, y: number, side: number): Vector3 {
  const alongS = hullSurfacePoint(s + 0.05, y, side).sub(
    hullSurfacePoint(Math.max(0, s - 0.05), y, side)
  );
  const alongY = hullSurfacePoint(s, y + 0.05, side).sub(hullSurfacePoint(s, y - 0.05, side));
  const normal = alongS.cross(alongY).normalize();
  if (normal.x * side + normal.z * 0.25 < 0) {
    normal.negate();
  }
  return normal;
}
/** Grid patch lying just off the hull skin (for names, decals and draft marks). */
function hullPatchGeometry(
  s0: number,
  s1: number,
  y0: number,
  y1: number,
  side: number,
  offset = 0.012,
  segS = 6,
  segY = 1
): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= segY; row++)
    for (let col = 0; col <= segS; col++) {
      const s = s0 + ((s1 - s0) * col) / segS;
      const y = y0 + ((y1 - y0) * row) / segY;
      const normal = hullSurfaceNormal(s, y, side);
      const point = hullSurfacePoint(s, y, side).addScaledVector(normal, offset);
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(side < 0 ? 1 - col / segS : col / segS, row / segY);
    }
  const stride = segS + 1;
  for (let row = 0; row < segY; row++)
    for (let col = 0; col < segS; col++) {
      const i00 = row * stride + col;
      const i01 = i00 + 1;
      const i11 = i00 + stride + 1;
      const i10 = i00 + stride;
      if (side > 0) {
        indices.push(i00, i01, i11, i00, i11, i10);
      } else {
        indices.push(i00, i11, i01, i00, i10, i11);
      }
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}
/** Accumulates non-indexed triangles with per-vertex normals, uvs and colours. */
class ColoredMeshBuilder {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];

  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.colors = [];
  }

  vertex(position: Vector3, normal: Vector3, u: number, v: number, color: Rgb): void {
    this.positions.push(position.x, position.y, position.z);
    this.normals.push(normal.x, normal.y, normal.z);
    this.uvs.push(u, v);
    this.colors.push(color[0], color[1], color[2]);
  }

  /** Adds a quad as two triangles, wound to face along `normals[0]`. */
  quad(points: Vector3[], normals: Vector3[], uvs: number[][], colors: Rgb[]): void {
    const edgeA = points[1].clone().sub(points[0]);
    const edgeB = points[3].clone().sub(points[0]);
    const order = edgeA.cross(edgeB).dot(normals[0]) >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (const idx of order)
      this.vertex(points[idx], normals[idx], uvs[idx][0], uvs[idx][1], colors[idx]);
  }

  geo(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2));
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    return geometry;
  }
}
const hashCell2 = (x: number, y: number): number => {
  let hash = Math.imul(x + 31, 374761393) ^ Math.imul(y + 17, 668265263);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
};
/** The moored container ship. */
export interface ContainerShip {
  root: Group;
  /** Radar scanner bar, spun by the backdrop update. */
  radar: Group;
  colliders: BackdropCollider[];
  tris: number;
  name: string;
}

/** Builds the container ship moored along the quay. */
export function buildContainerShip(game: Game, blinkLights: BlinkLightBatch): ContainerShip {
  const batcher = new MaterialBatcher();
  // Railings, rope and fittings: hidden on low quality (see render/detail.ts).
  batcher.minorSize = 0.6;
  const hullPaint = weatheredMaterial(game, 'hull_paint');
  const hullRed = weatheredMaterial(game, 'hull_red');
  const whitePaint = weatheredMaterial(game, 'paint_white');
  const darkSteel = game.mats.get('steel_dark');
  const galvSteel = game.mats.get('steel_galv');
  const rope = game.mats.get('rope');
  const rubber = game.mats.get('rubber');
  const windowGlow = [2.6, 1.75, 0.95];
  const addWindow = (geometry: BufferGeometry) => blinkLights.add(geometry, windowGlow, 0);
  const add = (material: Material, geometry: BatchGeometry, tint?: Rgb) =>
    batcher.add(material, geometry, tint);
  const stations = [0, 0.35, 0.9, 1.8, 3, 4.5, 6, 8, 10, 12, 14.5, 17, 20];
  for (let s = 23; s < SHIP_LENGTH - 0.5; s += 3) stations.push(s);
  stations.push(SHIP_LENGTH);
  const deckRowFracs = [0, 0.17, 0.34, 0.5, 0.66, 0.83, 1];
  const hullRowYs = (s: number): number[] => {
    const deckY = deckHeightAt(s);
    const ys = [SHIP_KEEL_Y, -2.3, -0.4, 1];
    for (let k = 1; k < deckRowFracs.length; k++) ys.push(1 + (deckY - 1) * deckRowFracs[k]);
    ys.push(hullTopAt(s));
    return ys;
  };
  const hullRows = 10;
  const bootRows = 3;
  const redMesh = new ColoredMeshBuilder();
  const hullMesh = new ColoredMeshBuilder();
  const plateColor = (point: Vector3, row: number, upper: boolean, shade: number): number[] => {
    const weather = weatheredVertexColor(point.x * 0.6, point.y, point.z * 0.6, undefined, 0.8);
    const color = [weather[0] * shade, weather[1] * shade, weather[2] * shade];
    if (row < bootRows) {
      if (point.y < -0.2) {
        color[0] *= 0.55;
        color[1] *= 0.72;
        color[2] *= 0.55;
      } else if (upper) {
        color[0] *= 1.12;
        color[1] *= 1;
        color[2] *= 0.92;
      }
    } else if (point.y < 1.1) {
      color[0] *= 1.7;
      color[1] *= 1.62;
      color[2] *= 1.45;
    }
    return color;
  };
  for (const side of [-1, 1])
    for (let seg = 0; seg < stations.length - 1; seg++) {
      const s0 = stations[seg];
      const s1 = stations[seg + 1];
      const rowsA = hullRowYs(s0);
      const rowsB = hullRowYs(s1);
      for (let row = 0; row < hullRows; row++) {
        if (row === hullRows - 1 && bulwarkHeightAt(s0) < 0.02 && bulwarkHeightAt(s1) < 0.02)
          continue;
        const shade =
          (row < bootRows ? 0.8 : 0.58) + 0.36 * hashCell2(seg * 7 + (side > 0 ? 100 : 0), row);
        const corners = [
          hullSurfacePoint(s0, rowsA[row], side),
          hullSurfacePoint(s1, rowsB[row], side),
          hullSurfacePoint(s1, rowsB[row + 1], side),
          hullSurfacePoint(s0, rowsA[row + 1], side)
        ];
        const cornerNormals = [
          hullSurfaceNormal(s0, rowsA[row], side),
          hullSurfaceNormal(s1, rowsB[row], side),
          hullSurfaceNormal(s1, rowsB[row + 1], side),
          hullSurfaceNormal(s0, rowsA[row + 1], side)
        ];
        const cornerUvs = [
          [s0, rowsA[row]],
          [s1, rowsB[row]],
          [s1, rowsB[row + 1]],
          [s0, rowsA[row + 1]]
        ];
        const cornerColors = [
          plateColor(corners[0], row, false, shade),
          plateColor(corners[1], row, false, shade),
          plateColor(corners[2], row, true, shade),
          plateColor(corners[3], row, true, shade)
        ];
        if (s0 > 1.5 && row >= 2 && row < hullRows - 1) {
          const center = corners[0]
            .clone()
            .add(corners[1])
            .add(corners[2])
            .add(corners[3])
            .multiplyScalar(0.25);
          for (let c = 0; c < 4; c++)
            cornerNormals[c]
              .addScaledVector(center.clone().sub(corners[c]).normalize(), 0.075)
              .normalize();
        }
        (row < bootRows ? redMesh : hullMesh).quad(corners, cornerNormals, cornerUvs, cornerColors);
      }
    }
  {
    const bowRows = hullRowYs(0);
    const sternRows = hullRowYs(SHIP_LENGTH);
    const bowNormal = v3(0, 0.2, 1).normalize();
    const sternNormal = v3(0, 0, -1);
    const up = v3(0, 1, 0);
    for (let row = 0; row < hullRows; row++) {
      const color = row < bootRows ? [0.8, 0.8, 0.8] : [0.9, 0.9, 0.9];
      (row < bootRows ? redMesh : hullMesh).quad(
        [
          hullSurfacePoint(0, bowRows[row], -1),
          hullSurfacePoint(0, bowRows[row], 1),
          hullSurfacePoint(0, bowRows[row + 1], 1),
          hullSurfacePoint(0, bowRows[row + 1], -1)
        ],
        [bowNormal, bowNormal, bowNormal, bowNormal],
        [
          [0, bowRows[row]],
          [0.4, bowRows[row]],
          [0.4, bowRows[row + 1]],
          [0, bowRows[row + 1]]
        ],
        [color, color, color, color]
      );
      (row < bootRows ? redMesh : hullMesh).quad(
        [
          hullSurfacePoint(SHIP_LENGTH, sternRows[row], -1),
          hullSurfacePoint(SHIP_LENGTH, sternRows[row], 1),
          hullSurfacePoint(SHIP_LENGTH, sternRows[row + 1], 1),
          hullSurfacePoint(SHIP_LENGTH, sternRows[row + 1], -1)
        ],
        [sternNormal, sternNormal, sternNormal, sternNormal],
        [
          [0, sternRows[row]],
          [14, sternRows[row]],
          [14, sternRows[row + 1]],
          [0, sternRows[row + 1]]
        ],
        [color, color, color, color]
      );
    }
    for (let seg = 0; seg < stations.length - 1; seg++) {
      const p0 = hullSurfacePoint(stations[seg], deckHeightAt(stations[seg]), -1);
      const p1 = hullSurfacePoint(stations[seg], deckHeightAt(stations[seg]), 1);
      const p2 = hullSurfacePoint(stations[seg + 1], deckHeightAt(stations[seg + 1]), 1);
      const p3 = hullSurfacePoint(stations[seg + 1], deckHeightAt(stations[seg + 1]), -1);
      const deckColor = [0.75, 0.72, 0.7];
      redMesh.quad(
        [p0, p1, p2, p3],
        [up, up, up, up],
        [
          [p0.x, p0.z],
          [p1.x, p1.z],
          [p2.x, p2.z],
          [p3.x, p3.z]
        ],
        [deckColor, deckColor, deckColor, deckColor]
      );
    }
  }
  add(hullRed, redMesh.geo());
  add(hullPaint, hullMesh.geo());
  {
    const portSkin = (s: number, y: number) =>
      hullSurfacePoint(s, y, -1).addScaledVector(hullSurfaceNormal(s, y, -1), 0.012);
    const weldTint = [1.05, 0.92, 0.8];
    for (let seg = 2; seg < stations.length - 1; seg++) {
      const rowsA = hullRowYs(stations[seg]);
      const rowsB = hullRowYs(stations[seg + 1]);
      for (let row = 4; row <= 9; row++)
        add(
          hullPaint,
          beamBetween(
            portSkin(stations[seg], rowsA[row]),
            portSkin(stations[seg + 1], rowsB[row]),
            0.03,
            0.045
          ),
          weldTint
        );
      for (let row = 3; row < 9; row++)
        if ((seg + row) % 2 === 0) {
          add(
            hullPaint,
            beamBetween(
              portSkin(stations[seg], rowsA[row]),
              portSkin(stations[seg], rowsA[row + 1]),
              0.035,
              0.03
            ),
            weldTint
          );
        }
    }
  }
  for (const side of [-1, 1]) {
    for (let seg = 3; seg < stations.length - 1; seg++) {
      const rubbing = (s: number, y: number) =>
        hullSurfacePoint(s, y, side).addScaledVector(hullSurfaceNormal(s, y, side), 0.07);
      add(
        hullPaint,
        beamBetween(rubbing(stations[seg], 9.6), rubbing(stations[seg + 1], 9.6), 0.16, 0.3),
        [0.55, 0.55, 0.55]
      );
      if (bulwarkHeightAt(stations[seg]) > 0.6 && bulwarkHeightAt(stations[seg + 1]) > 0.6) {
        add(
          darkSteel,
          rodBetween(
            hullSurfacePoint(stations[seg], hullTopAt(stations[seg]), side),
            hullSurfacePoint(stations[seg + 1], hullTopAt(stations[seg + 1]), side),
            0.07,
            6
          )
        );
      }
    }
    for (let seg = 0; seg < 3; seg++)
      add(
        darkSteel,
        rodBetween(
          hullSurfacePoint(stations[seg], hullTopAt(stations[seg]), side),
          hullSurfacePoint(stations[seg + 1], hullTopAt(stations[seg + 1]), side),
          0.07,
          6
        )
      );
    const railPoints = [];
    for (let s = 18; s <= SHIP_LENGTH - 10.4; s += 3)
      railPoints.push(hullSurfacePoint(s, deckHeightAt(s), side).add(v3(-side * 0.12, 0, 0)));
    railingAlong(batcher, darkSteel, railPoints, {
      h: 1.05,
      post: 1.5,
      r: 0.028
    });
    const anchorS = 4.6;
    const anchorY = deckHeightAt(anchorS) - 2.3;
    const hawse = hullSurfacePoint(anchorS, anchorY, side);
    const hawseNormal = hullSurfaceNormal(anchorS, anchorY, side);
    add(
      darkSteel,
      rodBetween(
        hawse.clone().addScaledVector(hawseNormal, -0.3),
        hawse.clone().addScaledVector(hawseNormal, 0.22),
        0.5,
        12,
        true
      )
    );
    const offsetPoint = (s: number, y: number, offset: number) =>
      hullSurfacePoint(s, y, side).addScaledVector(hullSurfaceNormal(s, y, side), offset);
    add(
      darkSteel,
      beamBetween(
        offsetPoint(anchorS, anchorY - 0.1, 0.34),
        offsetPoint(anchorS, anchorY - 2.3, 0.3),
        0.22,
        0.22,
        0.03
      )
    );
    add(
      darkSteel,
      beamBetween(
        offsetPoint(anchorS - 0.95, anchorY - 2.45, 0.34),
        offsetPoint(anchorS + 0.95, anchorY - 2.45, 0.34),
        0.42,
        0.42,
        0.05
      )
    );
    for (const fluke of [-0.8, 0.8])
      add(
        darkSteel,
        beamBetween(
          offsetPoint(anchorS + fluke, anchorY - 2.4, 0.3),
          offsetPoint(anchorS + fluke * 1.1, anchorY - 1.1, 0.34),
          0.5,
          0.12,
          0.02
        )
      );
  }
  const nameLabel = game.mats.label('KITTIWAKE', {
    color: 'white',
    font: 'sans',
    distress: 0.3
  });
  {
    const nameLength = Math.min(12, 1.7 * Math.max(2, nameLabel.aspect || 6));
    add(
      nameLabel.material,
      hullPatchGeometry(7.6, 7.6 + nameLength, 10.25, 10.25 + 1.7, -1, 0.014, 10, 1)
    );
    add(
      nameLabel.material,
      hullPatchGeometry(7.6, 7.6 + nameLength, 10.25, 10.25 + 1.7, 1, 0.014, 10, 1)
    );
  }
  const rustDecal = game.mats.decal('rust_run');
  add(
    rustDecal.material,
    hullPatchGeometry(
      4.6 - 0.8,
      4.6 + 0.8,
      deckHeightAt(4.6) - 9.5,
      deckHeightAt(4.6) - 2.6,
      -1,
      0.012,
      2,
      3
    )
  );
  for (let s = 21.5; s < SHIP_LENGTH - 11; s += 5.5) {
    const scupper = hullSurfacePoint(s, SHIP_DECK_Y - 0.45, -1);
    add(
      darkSteel,
      boxBetween(
        scupper.x - 0.04,
        scupper.y - 0.09,
        scupper.z - 0.3,
        scupper.x + 0.01,
        scupper.y + 0.09,
        scupper.z + 0.3
      )
    );
    const streak = 2.6 + 3.2 * hashCell2(Math.round(s * 10), 5);
    add(
      rustDecal.material,
      hullPatchGeometry(
        s - 0.45,
        s + 0.45,
        SHIP_DECK_Y - 0.5 - streak,
        SHIP_DECK_Y - 0.5,
        -1,
        0.012,
        1,
        1
      )
    );
  }
  for (const s of [6.4, SHIP_LENGTH - 7])
    for (let mark = 0; mark < 9; mark++) {
      const markY = 1.6 + mark * 0.62;
      add(
        whitePaint,
        hullPatchGeometry(s, s + (mark % 2 ? 0.28 : 0.5), markY, markY + 0.13, -1, 0.01, 1, 1),
        [1.1, 1.1, 1.05]
      );
    }
  add(whitePaint, hullPatchGeometry(33, 33.9, 3.2, 3.3, -1, 0.01, 1, 1), [1.1, 1.1, 1.05]);
  add(whitePaint, hullPatchGeometry(33.4, 33.5, 2.4, 4.1, -1, 0.01, 1, 1), [1.1, 1.1, 1.05]);
  const foredeckY = deckHeightAt(7);
  for (const side of [-1, 1]) {
    add(
      darkSteel,
      cylinderAt(
        0.55,
        0.55,
        0.9,
        'x',
        SHIP_CENTER_X + side * 1.5,
        foredeckY + 0.75,
        SHIP_BOW_Z - 6.2,
        12
      )
    );
    add(
      darkSteel,
      boxBetween(
        SHIP_CENTER_X + side * 0.5,
        foredeckY,
        SHIP_BOW_Z - 6.9,
        SHIP_CENTER_X + side * 2.6,
        foredeckY + 0.5,
        SHIP_BOW_Z - 5.5,
        0.04
      )
    );
    for (const dz of [0, 0.7])
      add(
        darkSteel,
        cylinderAt(
          0.16,
          0.16,
          0.7,
          'y',
          SHIP_CENTER_X + side * 4.2,
          foredeckY + 0.35,
          SHIP_BOW_Z - 8.5 - dz,
          8
        )
      );
  }
  const mastZ = SHIP_BOW_Z - 10.5;
  const mastTopY = foredeckY + 15;
  add(
    whitePaint,
    cylinderAt(0.26, 0.42, 15, 'y', SHIP_CENTER_X, foredeckY + 7.5, mastZ, 10),
    [0.85, 0.8, 0.7]
  );
  add(
    whitePaint,
    boxBetween(
      SHIP_CENTER_X - 2.6,
      foredeckY + 10,
      mastZ - 0.12,
      SHIP_CENTER_X + 2.6,
      foredeckY + 10.24,
      mastZ + 0.12
    ),
    [0.85, 0.8, 0.7]
  );
  add(
    darkSteel,
    rodBetween([SHIP_CENTER_X, mastTopY, mastZ], [SHIP_CENTER_X, mastTopY + 2.4, mastZ], 0.03, 5)
  );
  for (const side of [-1, 1]) {
    add(
      darkSteel,
      rodBetween(
        [SHIP_CENTER_X + side * 2.5, foredeckY + 10.2, mastZ],
        [SHIP_CENTER_X + side * 5.6, foredeckY + 0.6, mastZ - 1.2],
        0.022,
        4
      )
    );
    add(
      darkSteel,
      rodBetween(
        [SHIP_CENTER_X + side * 2.5, foredeckY + 10.2, mastZ],
        [SHIP_CENTER_X, mastTopY, mastZ],
        0.02,
        4
      )
    );
  }
  add(
    darkSteel,
    rodBetween(
      [SHIP_CENTER_X, mastTopY, mastZ],
      [SHIP_CENTER_X, hullTopAt(0) + 0.3, SHIP_BOW_Z - 0.4],
      0.022,
      4
    )
  );
  add(
    darkSteel,
    rodBetween(
      [SHIP_CENTER_X, hullTopAt(0), SHIP_BOW_Z - 0.3],
      [SHIP_CENTER_X, hullTopAt(0) + 2.6, SHIP_BOW_Z - 0.15],
      0.03,
      5
    )
  );
  const derrickFoot = v3(SHIP_CENTER_X, foredeckY + 2.2, mastZ - 0.5);
  const derrickTip = v3(SHIP_CENTER_X + 1.2, foredeckY + 9.5, mastZ - 11.5);
  add(whitePaint, rodBetween(derrickFoot, derrickTip, 0.2, 8, true), [0.85, 0.8, 0.7]);
  add(darkSteel, rodBetween(derrickTip, [SHIP_CENTER_X, mastTopY - 0.4, mastZ], 0.022, 4));
  add(darkSteel, rodBetween(derrickTip, [derrickTip.x, SHIP_DECK_Y + 4, derrickTip.z], 0.018, 4));
  add(
    darkSteel,
    boxBetween(
      derrickTip.x - 0.18,
      SHIP_DECK_Y + 3.4,
      derrickTip.z - 0.18,
      derrickTip.x + 0.18,
      SHIP_DECK_Y + 4,
      derrickTip.z + 0.18,
      0.04
    )
  );
  blinkLights.add(
    beaconGeometry(SHIP_CENTER_X, mastTopY - 0.6, mastZ + 0.5, 0.14),
    [5, 4.6, 3.8],
    0
  );
  const containerColors = [
    [0.62, 0.17, 0.13],
    [0.17, 0.29, 0.5],
    [0.2, 0.42, 0.3],
    [0.78, 0.36, 0.12],
    [0.8, 0.62, 0.16],
    [0.82, 0.83, 0.8],
    [0.4, 0.43, 0.47],
    [0.16, 0.42, 0.45]
  ];
  [
    [-45.6, 12.19],
    [-32.7, 12.19],
    [-22.8, 6.06]
  ].forEach(([bayZ, bayLength], bay) => {
    add(
      hullRed,
      boxBetween(
        SHIP_CENTER_X - 7.7,
        SHIP_DECK_Y,
        bayZ - bayLength / 2 - 0.2,
        SHIP_CENTER_X + 7.7,
        SHIP_DECK_Y + 0.42,
        bayZ + bayLength / 2 + 0.2,
        0.04
      ),
      [0.6, 0.6, 0.62]
    );
    for (let col = 0; col < 6; col++) {
      const stackX = SHIP_CENTER_X + (col - 2.5) * 2.52;
      const tiers = bay === 2 ? 2 : 2 + (hashCell2(col * 3 + bay, 9) > 0.4 ? 1 : 0);
      for (let tier = 0; tier < tiers; tier++) {
        const tierY = SHIP_DECK_Y + 0.44 + tier * 2.61;
        const color =
          containerColors[
            Math.floor(hashCell2(col * 5 + tier * 13 + bay * 29, 2) * containerColors.length)
          ];
        add(
          whitePaint,
          boxBetween(
            stackX - 1.22,
            tierY,
            bayZ - bayLength / 2,
            stackX + 1.22,
            tierY + 2.59,
            bayZ + bayLength / 2,
            0.035
          ),
          color
        );
        if (col === 0)
          for (
            let ribZ = bayZ - bayLength / 2 + 0.5;
            ribZ < bayZ + bayLength / 2 - 0.3;
            ribZ += 0.58
          )
            add(
              whitePaint,
              boxBetween(
                stackX - 1.24,
                tierY + 0.15,
                ribZ - 0.1,
                stackX - 1.21,
                tierY + 2.45,
                ribZ + 0.1
              ),
              color
            );
      }
    }
    for (const lashZ of [bayZ - bayLength / 2 - 0.45, bayZ + bayLength / 2 + 0.45]) {
      for (let col = 0; col <= 6; col++)
        add(
          darkSteel,
          boxBetween(
            SHIP_CENTER_X + (col - 3) * 2.52 - 0.05,
            SHIP_DECK_Y,
            lashZ - 0.05,
            SHIP_CENTER_X + (col - 3) * 2.52 + 0.05,
            SHIP_DECK_Y + 5.6,
            lashZ + 0.05
          )
        );
      for (const lashY of [SHIP_DECK_Y + 2.9, SHIP_DECK_Y + 5.6])
        add(
          darkSteel,
          boxBetween(
            SHIP_CENTER_X - 7.6,
            lashY - 0.05,
            lashZ - 0.12,
            SHIP_CENTER_X + 7.6,
            lashY + 0.05,
            lashZ + 0.12
          )
        );
    }
  });
  const houseTint = [0.92, 0.93, 0.92];
  const houseFrontZ = -53;
  const houseBackZ = -66.5;
  [
    [7.2, 13, 15.9, 0],
    [6.7, 15.9, 18.7, 0.5],
    [6.3, 18.7, 21.5, 1],
    [6.5, 21.5, 24.4, 1.5]
  ].forEach(([halfWidth, floorY, ceilingY, setback], level) => {
    add(
      whitePaint,
      boxBetween(
        SHIP_CENTER_X - halfWidth,
        floorY,
        houseBackZ + setback * 0.4,
        SHIP_CENTER_X + halfWidth,
        ceilingY,
        houseFrontZ - setback,
        0.08
      ),
      houseTint
    );
    add(
      whitePaint,
      boxBetween(
        SHIP_CENTER_X - halfWidth - 0.7,
        ceilingY - 0.06,
        houseBackZ + setback * 0.4 - 0.3,
        SHIP_CENTER_X + halfWidth + 0.7,
        ceilingY + 0.06,
        houseFrontZ - setback + 1
      ),
      [0.7, 0.72, 0.72]
    );
    const walkY = ceilingY + 0.06;
    const walkX0 = SHIP_CENTER_X - halfWidth - 0.67;
    const walkX1 = SHIP_CENTER_X + halfWidth + 0.67;
    const walkZ1 = houseFrontZ - setback + 0.97;
    const walkZ0 = houseBackZ + setback * 0.4 - 0.27;
    railingAlong(
      batcher,
      galvSteel,
      [
        [walkX0, walkY, walkZ0],
        [walkX0, walkY, walkZ1],
        [walkX1, walkY, walkZ1],
        [walkX1, walkY, walkZ0]
      ],
      {
        h: 1.05,
        post: 1.6,
        r: 0.026
      }
    );
    if (level < 3)
      for (
        let windowZ = houseFrontZ - setback - 1.2, w = 0;
        windowZ > houseBackZ + 1.5;
        windowZ -= 1.45, w++
      ) {
        const lit = hashCell2(w * 3 + level * 11, 4) > 0.8;
        for (const side of [-1, 1]) {
          const pane = boxBetween(
            SHIP_CENTER_X + side * (halfWidth + 0.012) - 0.012,
            floorY + 1.25,
            windowZ - 0.33,
            SHIP_CENTER_X + side * (halfWidth + 0.012) + 0.012,
            floorY + 1.85,
            windowZ + 0.33
          );
          if (lit && side < 0) {
            addWindow(pane);
          } else {
            add(darkSteel, pane);
          }
        }
      }
    if (level < 3)
      for (
        let windowX = SHIP_CENTER_X - halfWidth + 1, w = 0;
        windowX < SHIP_CENTER_X + halfWidth - 0.6;
        windowX += 1.5, w++
      ) {
        const pane = boxBetween(
          windowX - 0.33,
          floorY + 1.25,
          houseFrontZ - setback - 0.01,
          windowX + 0.33,
          floorY + 1.85,
          houseFrontZ - setback + 0.014
        );
        if (hashCell2(w + level * 7, 8) > 0.84) {
          addWindow(pane);
        } else {
          add(darkSteel, pane);
        }
      }
  });
  const bridgeY = 21.5;
  const bridgeFrontZ = houseFrontZ - 1.5;
  const bridgeHalfWidth = 6.5;
  add(
    darkSteel,
    boxBetween(
      SHIP_CENTER_X - bridgeHalfWidth + 0.2,
      bridgeY + 1.3,
      bridgeFrontZ - 0.01,
      SHIP_CENTER_X + bridgeHalfWidth - 0.2,
      bridgeY + 2.25,
      bridgeFrontZ + 0.02
    )
  );
  for (
    let windowX = SHIP_CENTER_X - bridgeHalfWidth + 0.75, w = 0;
    windowX < SHIP_CENTER_X + bridgeHalfWidth - 0.4;
    windowX += 1.05, w++
  ) {
    if (hashCell2(w, 21) > 0.62) {
      addWindow(
        boxBetween(
          windowX - 0.44,
          bridgeY + 1.36,
          bridgeFrontZ + 0.02,
          windowX + 0.44,
          bridgeY + 2.19,
          bridgeFrontZ + 0.03
        )
      );
    }
    add(
      whitePaint,
      boxBetween(
        windowX + 0.48,
        bridgeY + 1.3,
        bridgeFrontZ,
        windowX + 0.57,
        bridgeY + 2.25,
        bridgeFrontZ + 0.04
      ),
      houseTint
    );
  }
  for (const side of [-1, 1]) {
    add(
      darkSteel,
      boxBetween(
        SHIP_CENTER_X + side * bridgeHalfWidth - 0.02,
        bridgeY + 1.3,
        bridgeFrontZ - 5,
        SHIP_CENTER_X + side * bridgeHalfWidth + 0.02,
        bridgeY + 2.25,
        bridgeFrontZ - 0.2
      )
    );
    add(
      whitePaint,
      boxBetween(
        SHIP_CENTER_X + side * 6.4,
        bridgeY - 0.12,
        bridgeFrontZ - 3.4,
        SHIP_CENTER_X + side * 8.3,
        bridgeY + 0.02,
        bridgeFrontZ + 0.9,
        0.03
      ),
      houseTint
    );
    add(
      whitePaint,
      boxBetween(
        SHIP_CENTER_X + side * 8.22,
        bridgeY,
        bridgeFrontZ - 3.4,
        SHIP_CENTER_X + side * 8.3,
        bridgeY + 1.1,
        bridgeFrontZ + 0.9
      ),
      houseTint
    );
    add(
      whitePaint,
      boxBetween(
        SHIP_CENTER_X + side * 6.5,
        bridgeY,
        bridgeFrontZ + 0.82,
        SHIP_CENTER_X + side * 8.3,
        bridgeY + 1.1,
        bridgeFrontZ + 0.9
      ),
      houseTint
    );
    add(
      darkSteel,
      beamBetween(
        [SHIP_CENTER_X + side * 6.6, bridgeY - 2.6, bridgeFrontZ - 1.2],
        [SHIP_CENTER_X + side * 8.1, bridgeY - 0.1, bridgeFrontZ - 1.2],
        0.12,
        0.12
      )
    );
    blinkLights.add(
      beaconGeometry(SHIP_CENTER_X + side * 8.25, bridgeY + 1.35, bridgeFrontZ - 0.4, 0.13),
      side < 0 ? [0.3, 5, 1.6] : [6, 0.4, 0.3],
      0
    );
  }
  addWindow(
    boxBetween(
      SHIP_CENTER_X - 2.2,
      24.42,
      bridgeFrontZ + 0.6,
      SHIP_CENTER_X - 1.6,
      24.52,
      bridgeFrontZ + 0.9
    )
  );
  addWindow(
    boxBetween(
      SHIP_CENTER_X + 1.6,
      24.42,
      bridgeFrontZ + 0.6,
      SHIP_CENTER_X + 2.2,
      24.52,
      bridgeFrontZ + 0.9
    )
  );
  const radarMast = v3(SHIP_CENTER_X, 24.46, -57.5);
  add(
    whitePaint,
    cylinderAt(0.16, 0.28, 8.5, 'y', radarMast.x, radarMast.y + 4.25, radarMast.z, 8),
    houseTint
  );
  add(
    whitePaint,
    boxBetween(
      radarMast.x - 2.4,
      radarMast.y + 5.2,
      radarMast.z - 0.08,
      radarMast.x + 2.4,
      radarMast.y + 5.36,
      radarMast.z + 0.08
    ),
    houseTint
  );
  add(
    whitePaint,
    boxBetween(
      radarMast.x - 1.3,
      radarMast.y + 7.3,
      radarMast.z - 0.06,
      radarMast.x + 1.3,
      radarMast.y + 7.42,
      radarMast.z + 0.06
    ),
    houseTint
  );
  add(
    whitePaint,
    boxBetween(
      radarMast.x - 0.5,
      radarMast.y + 3.2,
      radarMast.z,
      radarMast.x + 0.5,
      radarMast.y + 3.3,
      radarMast.z + 1.2
    ),
    houseTint
  );
  for (const rodX of [-2.3, -1.2, 1.2, 2.3])
    add(
      darkSteel,
      rodBetween(
        [radarMast.x + rodX, radarMast.y + 5.36, radarMast.z],
        [radarMast.x + rodX, radarMast.y + 5.36 + (Math.abs(rodX) > 2 ? 3.2 : 1.2), radarMast.z],
        0.012,
        4
      )
    );
  add(
    darkSteel,
    rodBetween(
      [radarMast.x, radarMast.y + 8.5, radarMast.z],
      [radarMast.x, radarMast.y + 10.8, radarMast.z],
      0.015,
      4
    )
  );
  for (const side of [-1, 1])
    add(
      darkSteel,
      rodBetween(
        [radarMast.x + side * 2.3, radarMast.y + 5.3, radarMast.z],
        [SHIP_CENTER_X + side * 6, 24.5, houseBackZ + 2],
        0.014,
        4
      )
    );
  blinkLights.add(
    beaconGeometry(radarMast.x, radarMast.y + 8.7, radarMast.z + 0.3, 0.14),
    [5, 4.6, 3.8],
    0
  );
  blinkLights.add(
    beaconGeometry(radarMast.x, radarMast.y + 7.6, radarMast.z, 0.12),
    [8, 0.4, 0.25],
    3.4,
    0.6,
    0.4
  );
  const funnelZ = -62.6;
  add(
    whitePaint,
    boxBetween(
      SHIP_CENTER_X - 1.7,
      24.4,
      funnelZ - 2.3,
      SHIP_CENTER_X + 1.7,
      29.3,
      funnelZ + 2.1,
      0.25
    ),
    [0.2, 0.34, 0.5]
  );
  add(
    whitePaint,
    boxBetween(
      SHIP_CENTER_X - 1.72,
      27.2,
      funnelZ - 2.32,
      SHIP_CENTER_X + 1.72,
      28.1,
      funnelZ + 2.12,
      0.1
    ),
    [0.9, 0.88, 0.8]
  );
  add(
    whitePaint,
    boxBetween(
      SHIP_CENTER_X - 1.75,
      29.3,
      funnelZ - 2.35,
      SHIP_CENTER_X + 1.75,
      30.3,
      funnelZ + 2.15,
      0.2
    ),
    [0.07, 0.07, 0.08]
  );
  for (const pipeZ of [-0.9, 0.5])
    add(darkSteel, cylinderAt(0.28, 0.28, 1.1, 'y', SHIP_CENTER_X, 30.7, funnelZ + pipeZ, 10));
  const funnelLogo = game.mats.decal('logo_b');
  add(
    funnelLogo.material,
    planeAt(
      2.6,
      2.6 / Math.max(1, funnelLogo.aspect || 1),
      SHIP_CENTER_X - 1.705,
      26.1,
      funnelZ - 0.1,
      -Math.PI / 2
    )
  );
  {
    const boatX = SHIP_CENTER_X - 7.9;
    const boatY = 17.5;
    const boatZ = -61;
    const boatTint = [1.25, 0.42, 0.1];
    const lifeboat = new CapsuleGeometry(1.15, 3.6, 4, 12);
    lifeboat.rotateX(Math.PI / 2);
    lifeboat.scale(0.95, 0.82, 1);
    lifeboat.translate(boatX, boatY, boatZ);
    add(whitePaint, lifeboat, boatTint);
    add(
      whitePaint,
      boxBetween(
        boatX - 0.6,
        boatY + 0.7,
        boatZ - 1.2,
        boatX + 0.6,
        boatY + 1.25,
        boatZ + 0.9,
        0.12
      ),
      boatTint
    );
    for (const davitZ of [-2.1, 2.1]) {
      add(
        darkSteel,
        beamBetween(
          [SHIP_CENTER_X - 6.9, 15.9, boatZ + davitZ],
          [boatX - 0.2, boatY + 2.3, boatZ + davitZ],
          0.16,
          0.22
        )
      );
      add(
        darkSteel,
        rodBetween(
          [boatX - 0.2, boatY + 2.2, boatZ + davitZ],
          [boatX, boatY + 0.9, boatZ + davitZ * 0.8],
          0.02,
          4
        )
      );
    }
  }
  add(
    darkSteel,
    rodBetween(
      [SHIP_CENTER_X, hullTopAt(SHIP_LENGTH), SHIP_BOW_Z - SHIP_LENGTH + 0.4],
      [SHIP_CENTER_X, hullTopAt(SHIP_LENGTH) + 3.4, SHIP_BOW_Z - SHIP_LENGTH - 0.3],
      0.03,
      5
    )
  );
  blinkLights.add(
    beaconGeometry(
      SHIP_CENTER_X,
      hullTopAt(SHIP_LENGTH) + 0.6,
      SHIP_BOW_Z - SHIP_LENGTH - 0.1,
      0.1
    ),
    [4, 3.7, 3],
    0
  );
  {
    const gangwayTop = v3(32.55, 13, -51.5);
    const gangwayBottom = v3(31.4, 1.25, -38.5);
    for (const side of [-0.4, 0.4]) {
      add(
        galvSteel,
        beamBetween(
          [gangwayTop.x + side, gangwayTop.y - 0.1, gangwayTop.z],
          [gangwayBottom.x + side, gangwayBottom.y - 0.1, gangwayBottom.z],
          0.05,
          0.3
        )
      );
      add(
        galvSteel,
        rodBetween(
          [gangwayTop.x + side, gangwayTop.y + 1, gangwayTop.z],
          [gangwayBottom.x + side, gangwayBottom.y + 1, gangwayBottom.z],
          0.025,
          5
        )
      );
      add(
        galvSteel,
        rodBetween(
          [gangwayTop.x + side, gangwayTop.y + 0.5, gangwayTop.z],
          [gangwayBottom.x + side, gangwayBottom.y + 0.5, gangwayBottom.z],
          0.02,
          4
        )
      );
    }
    for (let k = 0; k <= 8; k++) {
      const point = gangwayTop.clone().lerp(gangwayBottom, k / 8);
      for (const side of [-0.4, 0.4])
        add(
          galvSteel,
          rodBetween(
            [point.x + side, point.y - 0.1, point.z],
            [point.x + side, point.y + 1, point.z],
            0.02,
            4
          )
        );
    }
    for (let k = 1; k < 44; k++) {
      const point = gangwayTop.clone().lerp(gangwayBottom, k / 44);
      add(
        galvSteel,
        boxBetween(
          point.x - 0.38,
          point.y - 0.02,
          point.z - 0.12,
          point.x + 0.38,
          point.y,
          point.z + 0.12
        )
      );
    }
    add(galvSteel, boxBetween(31, 1.15, -38.5, 32, 1.2, -37.3));
    add(galvSteel, beamBetween([31.2, 1.2, -37.9], [29.2, 0.12, -37.9], 0.8, 0.06));
    railingAlong(
      batcher,
      galvSteel,
      [
        [31, 1.2, -37.32],
        [32, 1.2, -37.32],
        [32, 1.2, -38.5]
      ],
      {
        post: 1.1
      }
    );
    add(
      darkSteel,
      rodBetween(
        [gangwayTop.x, gangwayTop.y + 3.2, gangwayTop.z + 4],
        [gangwayBottom.x, gangwayBottom.y + 1.2, gangwayBottom.z + 0.3],
        0.014,
        4
      )
    );
    add(
      darkSteel,
      beamBetween([33.2, 13.2, gangwayTop.z + 4], [32.2, 16.4, gangwayTop.z + 4], 0.14, 0.14)
    );
  }
  const addMooringLine = (s: number, y: number, bollard: Vector3, sag: number) => {
    const fairlead = hullSurfacePoint(s, y, -1);
    fairlead.x -= 0.1;
    add(rope, polylineRods(sagCurvePoints(fairlead, bollard, sag, 12), 0.042, 5));
    const guardPoint = sagCurvePoints(fairlead, bollard, sag, 12)[3];
    const guardDir = sagCurvePoints(fairlead, bollard, sag, 12)[4]
      .clone()
      .sub(guardPoint)
      .normalize();
    const ratGuard = cylinderAt(0.42, 0.42, 0.012, 'y', 0, 0, 0, 12);
    ratGuard.applyQuaternion(new Quaternion().setFromUnitVectors(v3(0, 1, 0), guardDir));
    ratGuard.translate(guardPoint.x, guardPoint.y, guardPoint.z);
    add(galvSteel, ratGuard);
    add(
      darkSteel,
      boxBetween(
        fairlead.x - 0.12,
        fairlead.y - 0.28,
        fairlead.z - 0.35,
        fairlead.x + 0.12,
        fairlead.y + 0.28,
        fairlead.z + 0.35,
        0.05
      )
    );
  };
  addMooringLine(4.4, deckHeightAt(4.4) + 0.55, v3(29.2, 0.5, -12), 1.3);
  addMooringLine(4.9, deckHeightAt(4.9) + 0.55, v3(29.2, 0.36, -12.1), 1.7);
  addMooringLine(1.6, deckHeightAt(1.6) + 0.6, v3(29.2, 0.5, -2), 1.6);
  addMooringLine(2.2, deckHeightAt(2.2) + 0.6, v3(29.2, 0.36, -2.1), 2.2);
  addMooringLine(SHIP_LENGTH - 5, deckHeightAt(SHIP_LENGTH - 5) + 0.6, v3(29.2, 0.5, -82), 1.6);
  addMooringLine(SHIP_LENGTH - 9, deckHeightAt(SHIP_LENGTH - 9) + 0.6, v3(29.2, 0.45, -58), 1.2);
  for (const bollardZ of [-82, -58]) {
    add(darkSteel, cylinderAt(0.2, 0.26, 0.55, 'y', 29.2, 0.27, bollardZ, 10));
    add(darkSteel, cylinderAt(0.34, 0.3, 0.14, 'y', 29.2, 0.6, bollardZ, 10));
  }
  for (const fenderZ of [-17.6, -37, -54]) {
    add(rubber, cylinderAt(1.25, 1.25, 2.2, 'z', 31.55, SHIP_WATERLINE_Y + 0.35, fenderZ, 14));
    add(
      rubber,
      cylinderAt(0.45, 1.25, 0.5, 'z', 31.55, SHIP_WATERLINE_Y + 0.35, fenderZ + 1.35, 14)
    );
    add(
      rubber,
      cylinderAt(1.25, 0.45, 0.5, 'z', 31.55, SHIP_WATERLINE_Y + 0.35, fenderZ - 1.35, 14)
    );
    add(
      rope,
      rodBetween([31.55, SHIP_WATERLINE_Y + 1.6, fenderZ], [29.9, 0.1, fenderZ + 0.6], 0.03, 4)
    );
  }
  const root = batcher.build({
    cast: true,
    recv: true
  });
  root.name = 'ship';
  const radarBatcher = new MaterialBatcher();
  radarBatcher.add(whitePaint, boxBetween(-1.25, -0.07, -0.1, 1.25, 0.07, 0.1, 0.02), houseTint);
  radarBatcher.add(whitePaint, cylinderAt(0.1, 0.12, 0.25, 'y', 0, -0.18, 0, 8), houseTint);
  const radar = radarBatcher.build({
    cast: false
  });
  radar.position.set(radarMast.x, radarMast.y + 3.62, radarMast.z + 0.8);
  radar.userData.noMerge = true;
  root.add(radar);
  const colliders = [
    {
      min: [33, -5, SHIP_BOW_Z - SHIP_LENGTH],
      max: [49, 15, -17.5]
    },
    {
      min: [34.9, -5, -17.5],
      max: [47.1, 15.5, -13]
    },
    {
      min: [37.7, -5, -13],
      max: [44.3, 16, -9.3]
    },
    {
      min: [SHIP_CENTER_X - 7.2, 13, houseBackZ],
      max: [SHIP_CENTER_X + 7.2, 24.4, houseFrontZ]
    }
  ];
  return {
    root,
    radar,
    colliders,
    tris: batcher.tris,
    name: 'KITTIWAKE'
  };
}
/** The small rigid-inflatable boat moored at the quay. */
export interface MooredBoat {
  root: Group;
  /** Hull group that pitches and rolls on the swell. */
  hullGrp: Group;
  tris: number;
}

/** Builds the moored RIB; its nav lights are built into `blinkLights` and attached to the hull. */
export function buildMooredBoat(game: Game, blinkLights: BlinkLightBatch): MooredBoat {
  const batcher = new MaterialBatcher();
  const hullPlastic = weatheredMaterial(game, 'plastic_grey');
  const orangePaint = weatheredMaterial(game, 'paint_orange');
  const blackPolymer = game.mats.get('polymer_black');
  const galvSteel = game.mats.get('steel_galv');
  const glass = game.mats.get('glass');
  const add = (material: Material, geometry: BatchGeometry, tint?: Rgb) =>
    batcher.add(material, geometry, tint);
  const tubeTint = [2, 2.02, 2.08];
  const trimTint = [0.5, 0.5, 0.52];
  const ropeTint = [1.9, 1.7, 1.2];
  const tubeHalf = [
    [-3.35, 0.5, 1.03],
    [-1.6, 0.5, 1.06],
    [0.5, 0.52, 1.05],
    [1.8, 0.58, 0.93],
    [2.75, 0.68, 0.6],
    [3.3, 0.78, 0.22]
  ];
  const tubePoints = [
    ...tubeHalf.map((p) => v3(p[0], p[1], p[2])),
    v3(3.43, 0.8, 0),
    ...tubeHalf
      .slice()
      .reverse()
      .map((p) => v3(p[0], p[1], -p[2]))
  ];
  const tubeCurve = new CatmullRomCurve3(tubePoints, false, 'centripetal');
  const tube = new TubeGeometry(tubeCurve, 60, 0.27, 12, false);
  {
    const uv = tube.attributes.uv;
    const curveLength = tubeCurve.getLength();
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * curveLength, uv.getY(i) * 1.7);
  }
  add(hullPlastic, tube, tubeTint);
  for (const side of [-1, 1])
    add(hullPlastic, cylinderAt(0.07, 0.27, 0.42, 'x', -3.56, 0.5, side * 1.03, 12), tubeTint);
  const ringCount = 11;
  const lifelinePoints = [];
  for (let i = 0; i < ringCount; i++) {
    const t = 0.04 + (0.92 * i) / (ringCount - 1);
    const point = tubeCurve.getPointAt(t);
    const tangent = tubeCurve.getTangentAt(t);
    const ring = new TorusGeometry(0.276, 0.016, 5, 14);
    ring.applyQuaternion(new Quaternion().setFromUnitVectors(v3(0, 0, 1), tangent));
    ring.translate(point.x, point.y, point.z);
    add(hullPlastic, ring, trimTint);
    const outward = v3(point.x, 0, point.z)
      .sub(v3(Math.min(point.x, 2.2), 0, 0))
      .normalize();
    lifelinePoints.push(
      point
        .clone()
        .addScaledVector(outward, 0.2)
        .add(v3(0, 0.2, 0))
    );
  }
  for (let i = 0; i < ringCount - 1; i++)
    add(
      hullPlastic,
      polylineRods(sagCurvePoints(lifelinePoints[i], lifelinePoints[i + 1], 0.1, 4), 0.012, 4),
      ropeTint
    );
  const hullStations = [-3.4, -2, -0.5, 1, 2, 2.8, 3.3];
  const hullHalfWidths = [0.9, 0.93, 0.93, 0.85, 0.62, 0.34, 0.08];
  const chineYs = [0.22, 0.22, 0.24, 0.3, 0.42, 0.56, 0.7];
  const keelYs = [-0.3, -0.32, -0.33, -0.3, -0.15, 0.15, 0.62];
  const hullPositions: number[] = [];
  const addTri = (a: Vector3, b: Vector3, c: Vector3) => {
    const faceNormal = b.clone().sub(a).cross(c.clone().sub(a));
    const centroid = a
      .clone()
      .add(b)
      .add(c)
      .multiplyScalar(1 / 3);
    const outward = v3(0, centroid.y - 0.45, centroid.z);
    if (Math.abs(centroid.x) > 3.39) {
      outward.set(centroid.x, 0, 0);
    }
    if (faceNormal.dot(outward) < 0) {
      hullPositions.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
    } else {
      hullPositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  };
  for (const side of [-1, 1]) {
    for (let seg = 0; seg < hullStations.length - 1; seg++) {
      const keelA = v3(hullStations[seg], keelYs[seg], 0);
      const keelB = v3(hullStations[seg + 1], keelYs[seg + 1], 0);
      const chineA = v3(hullStations[seg], chineYs[seg], side * hullHalfWidths[seg]);
      const chineB = v3(hullStations[seg + 1], chineYs[seg + 1], side * hullHalfWidths[seg + 1]);
      const gunwaleA = v3(
        hullStations[seg],
        0.5 + Math.max(0, chineYs[seg] - 0.22) * 0.6,
        side * (hullHalfWidths[seg] + 0.1)
      );
      const gunwaleB = v3(
        hullStations[seg + 1],
        0.5 + Math.max(0, chineYs[seg + 1] - 0.22) * 0.6,
        side * (hullHalfWidths[seg + 1] + 0.1)
      );
      addTri(keelA, keelB, chineB);
      addTri(keelA, chineB, chineA);
      addTri(chineA, chineB, gunwaleB);
      addTri(chineA, gunwaleB, gunwaleA);
    }
    addTri(
      v3(-3.4, keelYs[0], 0),
      v3(-3.4, chineYs[0], side * hullHalfWidths[0]),
      v3(-3.4, 0.78, side * (hullHalfWidths[0] + 0.1))
    );
    addTri(
      v3(-3.4, keelYs[0], 0),
      v3(-3.4, 0.78, side * (hullHalfWidths[0] + 0.1)),
      v3(-3.4, 0.78, 0)
    );
  }
  const hullGeometry = new BufferGeometry();
  hullGeometry.setAttribute('position', new Float32BufferAttribute(hullPositions, 3));
  hullGeometry.computeVertexNormals();
  add(blackPolymer, hullGeometry);
  add(hullPlastic, boxBetween(-3.38, 0.2, -0.86, 2.1, 0.26, 0.86), trimTint);
  add(hullPlastic, boxBetween(2, 0.26, -0.62, 2.85, 0.56, 0.62, 0.05), trimTint);
  add(blackPolymer, boxBetween(-3.46, 0.1, -0.92, -3.34, 0.8, 0.92, 0.02));
  add(galvSteel, rodBetween([3.2, 0.95, -0.12], [3.2, 0.95, 0.12], 0.02, 5));
  add(galvSteel, rodBetween([3.2, 0.8, 0], [3.2, 0.95, 0], 0.018, 5));
  add(orangePaint, boxBetween(0.3, 0.26, -0.4, 1, 1.12, 0.4, 0.05), [1, 0.9, 0.85]);
  add(blackPolymer, beamBetween([0.28, 1.14, 0], [0.86, 1.3, 0], 0.76, 0.05));
  const windscreen = boxBetween(-0.012, 0, -0.42, 0.012, 0.5, 0.42);
  windscreen.rotateZ(0.42);
  windscreen.translate(0.95, 1.2, 0);
  add(glass, windscreen);
  for (const side of [-0.43, 0.43])
    add(
      galvSteel,
      rodBetween(
        [0.95, 1.2, side],
        [0.95 - Math.sin(0.42) * 0.52, 1.2 + Math.cos(0.42) * 0.52, side],
        0.016,
        5
      )
    );
  add(
    galvSteel,
    rodBetween(
      [0.95 - Math.sin(0.42) * 0.52, 1.2 + Math.cos(0.42) * 0.52, -0.43],
      [0.95 - Math.sin(0.42) * 0.52, 1.2 + Math.cos(0.42) * 0.52, 0.43],
      0.016,
      5
    )
  );
  const wheel = new TorusGeometry(0.18, 0.017, 6, 18);
  wheel.rotateY(Math.PI / 2);
  wheel.rotateZ(-0.5);
  wheel.translate(0.2, 1.12, -0.12);
  add(blackPolymer, wheel);
  add(galvSteel, rodBetween([0.2, 1.12, -0.12], [0.36, 1.03, -0.12], 0.02, 5));
  for (const angle of [0, 2.1, 4.2])
    add(
      galvSteel,
      rodBetween(
        [0.2, 1.12, -0.12],
        [
          0.2 + Math.sin(-0.5) * Math.cos(angle) * -0.17,
          1.12 + Math.cos(-0.5) * Math.cos(angle) * 0.17,
          -0.12 + Math.sin(angle) * 0.17
        ],
        0.01,
        4
      )
    );
  add(blackPolymer, boxBetween(0.34, 1.16, 0.16, 0.5, 1.34, 0.3, 0.02));
  add(galvSteel, rodBetween([0.42, 1.34, 0.23], [0.36, 1.48, 0.23], 0.012, 4));
  add(galvSteel, rodBetween([0.35, 0.3, -0.46], [0.35, 1, -0.46], 0.02, 5));
  add(galvSteel, rodBetween([0.35, 1, -0.46], [0.95, 1, -0.46], 0.02, 5));
  add(galvSteel, rodBetween([0.35, 0.3, 0.46], [0.35, 1, 0.46], 0.02, 5));
  add(galvSteel, rodBetween([0.35, 1, 0.46], [0.95, 1, 0.46], 0.02, 5));
  for (const seatX of [-0.75, -1.75]) {
    add(
      orangePaint,
      boxBetween(seatX - 0.28, 0.26, -0.2, seatX + 0.28, 0.82, 0.2, 0.05),
      [1, 0.9, 0.85]
    );
    add(blackPolymer, boxBetween(seatX - 0.3, 0.82, -0.22, seatX + 0.3, 0.93, 0.22, 0.04));
    add(blackPolymer, boxBetween(seatX - 0.34, 0.93, -0.2, seatX - 0.26, 1.2, 0.2, 0.03));
    add(galvSteel, rodBetween([seatX + 0.3, 0.6, -0.22], [seatX + 0.3, 1.02, 0], 0.014, 4));
    add(galvSteel, rodBetween([seatX + 0.3, 0.6, 0.22], [seatX + 0.3, 1.02, 0], 0.014, 4));
  }
  add(orangePaint, boxBetween(-2.9, 0.26, -0.3, -2.45, 0.58, 0.3, 0.04), [1.1, 0.5, 0.4]);
  for (const side of [-1, 1]) {
    add(galvSteel, rodBetween([-2.95, 0.55, side * 0.9], [-2.75, 2, side * 0.55], 0.03, 6));
    add(galvSteel, rodBetween([-2.3, 0.55, side * 0.9], [-2.75, 1.3, side * 0.7], 0.022, 5));
  }
  add(galvSteel, rodBetween([-2.75, 2, -0.55], [-2.75, 2, 0.55], 0.03, 6));
  add(galvSteel, boxBetween(-2.88, 2, -0.2, -2.62, 2.04, 0.2));
  add(blackPolymer, cylinderAt(0.05, 0.06, 0.1, 'y', -2.75, 2.09, 0, 8));
  add(blackPolymer, rodBetween([-2.75, 2, 0.42], [-2.9, 3.7, 0.46], 0.011, 5));
  add(blackPolymer, cylinderAt(0.16, 0.16, 0.07, 'y', -2.75, 2.1, -0.36, 10));
  for (const side of [-0.36, 0.36]) {
    add(galvSteel, boxBetween(-3.6, 0.42, side - 0.16, -3.44, 0.78, side + 0.16, 0.02));
    add(blackPolymer, boxBetween(-4.1, 0.78, side - 0.23, -3.48, 1.4, side + 0.23, 0.09));
    add(
      hullPlastic,
      boxBetween(-4.11, 1, side - 0.235, -3.47, 1.05, side + 0.235),
      [1.4, 1.4, 1.4]
    );
    add(blackPolymer, boxBetween(-3.92, -0.05, side - 0.085, -3.62, 0.8, side + 0.085, 0.03));
    add(blackPolymer, boxBetween(-4.02, -0.52, side - 0.04, -3.6, -0.05, side + 0.04, 0.015));
    add(blackPolymer, cylinderAt(0.07, 0.03, 0.42, 'x', -3.9, -0.3, side, 8));
  }
  for (const fenderX of [-1.8, 0.4, 1.7]) {
    add(orangePaint, cylinderAt(0.11, 0.11, 0.42, 'y', fenderX, 0.42, 1.36, 10), [1.2, 0.8, 0.7]);
    add(hullPlastic, rodBetween([fenderX, 0.63, 1.36], [fenderX, 0.78, 1.12], 0.01, 4), ropeTint);
  }
  const ringBuoy = new TorusGeometry(0.26, 0.07, 6, 16);
  ringBuoy.rotateY(Math.PI / 2);
  ringBuoy.translate(1.02, 0.72, 0);
  add(orangePaint, ringBuoy, [1.3, 0.6, 0.45]);
  const hullGroup = batcher.build({
    cast: true,
    recv: true
  });
  blinkLights.add(beaconGeometry(-2.75, 2.2, 0, 0.075), [1.2, 11, 3.2], 1.5, 0, 0.1);
  blinkLights.add(beaconGeometry(-2.75, 2.2, 0, 0.074), [1.2, 11, 3.2], 1.5, 0.2, 0.08);
  const lamps = blinkLights.build();
  if (lamps) {
    lamps.frustumCulled = false;
    hullGroup.add(lamps);
  }
  const root = new Group();
  root.name = 'boat';
  root.add(hullGroup);
  root.userData.noMerge = true;
  return {
    root,
    hullGrp: hullGroup,
    tris: batcher.tris
  };
}
/** Base albedo of the container material; tints are expressed relative to it. */
export const CONTAINER_BASE_COLOR = new Color(0xb9bbb6);
/** Vertex tint that turns the container base colour into `hex` (scaled by `scale`). */
export const containerTint = (hex: number, scale = 1): number[] => {
  const color = new Color(hex);
  return [
    (scale * color.r) / CONTAINER_BASE_COLOR.r,
    (scale * color.g) / CONTAINER_BASE_COLOR.g,
    (scale * color.b) / CONTAINER_BASE_COLOR.b
  ];
};
/** Palette of container tints (duplicates weight the common liveries). */
export const CONTAINER_TINTS = [
  0x7d2219, 0x7d2219, 0x6a2a1c, 0x1f3f66, 0x1f3f66, 0x23344a, 0x2c5a44, 0x2c5a44, 0xb3521a,
  0x8a4a22, 0x5a6068, 0x5a6068, 0x3f464c, 0x1f5d63, 0x9a7218, 0x7b7e7c, 0x6a3d24, 0x6a3d24
].map((hex) => containerTint(hex));
/** Flat colours for far-away container stacks. */
export const DISTANT_CONTAINER_COLORS = [
  [0.6, 0.17, 0.13],
  [0.17, 0.29, 0.5],
  [0.2, 0.42, 0.3],
  [0.76, 0.35, 0.12],
  [0.78, 0.6, 0.16],
  [0.8, 0.81, 0.78],
  [0.4, 0.43, 0.47],
  [0.16, 0.42, 0.45],
  [0.55, 0.2, 0.15],
  [0.2, 0.3, 0.45]
];
/** Clamped smoothstep of `x` between `edge0` and `edge1`. */
export const smoothstepRange = (edge0: number, edge1: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return k * k * (3 - 2 * k);
};
/** Darkening factor for skyline geometry with distance from the play area. */
export const skylineDistanceShade = (x: number, z: number): number =>
  1 - 0.6 * smoothstepRange(38, 160, Math.hypot(x + 5, z));
