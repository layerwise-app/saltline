// Procedural "soft" cargo props: a tarp-covered pallet load, a sandbag wall and a pile of
// cardboard boxes. Built with `CargoPropBuilder` and registered with the prop registry.
import * as THREE from 'three';
import type { Group } from 'three';
import type { Rng } from '../core/rng';
import type { Game } from '../core/types';
import type { MaterialOptions } from '../materials/index';
import { tubeThroughPoints, worldUvBox } from '../render/geometry';
import type { TransformSpec } from '../render/geometry';
import {
  HALF_PI,
  PI,
  clamp,
  computeWeldedNormals,
  flipGeometry,
  mapVertices,
  removeGeometryGroup,
  ribbonGeometry,
  roundedBoxGeometry,
  subdividedRoundedBox,
  valueNoise3d
} from './meshUtils';
import { CargoPropBuilder, addPalletGeometry } from './cargo';

/** Options accepted by the soft cargo prop builders (all optional). */
export interface SoftCargoPropOptions {
  seed?: number;
  /** Sandbag wall courses (1..7, default 5). */
  courses?: number;
}

/** Builder callback signature expected by `registerProp`. */
export type SoftCargoPropBuilderFn = (game: Game, options?: SoftCargoPropOptions) => Group;

const smoothstepSoftCargo = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Plane whose uvs are its local XY position plus an offset (metric texture tiling). */
function offsetUvPlaneSoftCargo(
  width: number,
  height: number,
  offsetU = 0,
  offsetV = 0
): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(width, height);
  const uv = geometry.attributes.uv;
  const position = geometry.attributes.position;
  for (let i = 0; i < uv.count; i++)
    uv.setXY(i, position.getX(i) + offsetU, position.getY(i) + offsetV);
  return geometry;
}

/** `[minX, maxX, minZ, maxZ, height]` of a load block under the tarp. */
type LoadBlock = [number, number, number, number, number];
/** A tarp border vertex: `[gridX, gridZ, outwardX, outwardZ]`. */
type BorderVertex = [number, number, number, number];

function buildTarpCargo(game: Game, options: SoftCargoPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'tarp_cargo', options.seed || 0);
  const rng = builder.rng;
  const noiseOffset = builder.seed * 1.7;
  const palletHeight = 0.144;
  const blocks: LoadBlock[] = [
    [-1.06, -0.12, -0.58, 0.58, rng.range(0.98, 1.12)],
    [-0.06, 1.06, -0.58, 0.12, rng.range(1.32, 1.42)],
    [0.02, 0.62, 0.16, 0.58, rng.range(0.72, 0.86)],
    [0.66, 1.06, 0.18, 0.56, rng.range(0.5, 0.62)]
  ];
  for (const x of [-0.6, 0.6]) {
    builder.push({
      p: [x, 0, 0],
      r: [0, 0, 0]
    });
    addPalletGeometry(builder, rng, {
      stamp: false
    });
    builder.pop();
  }
  // Load blocks (crates under the tarp).
  for (const block of blocks) {
    const sizeX = block[1] - block[0];
    const sizeZ = block[3] - block[2];
    const blockHeight = block[4] - palletHeight;
    const centerX = (block[0] + block[1]) / 2;
    const centerZ = (block[2] + block[3]) / 2;
    const shade = rng.range(0.7, 0.95);
    builder.add(
      'wood_pallet',
      roundedBoxGeometry(sizeX, blockHeight, sizeZ, 0.006),
      {
        p: [centerX, palletHeight + blockHeight / 2, centerZ]
      },
      [shade, shade * 0.95, shade * 0.88]
    );
    builder.add(
      'wood_pallet',
      worldUvBox(sizeX + 0.012, 0.07, sizeZ + 0.012),
      {
        p: [centerX, palletHeight + 0.04, centerZ]
      },
      shade * 0.75
    );
  }
  // Tarp top: a height-field grid draped over the blocks.
  const uvScale = 1.9;
  const gridX = 22;
  const gridZ = 14;
  const minX = -1.125;
  const maxX = 1.125;
  const minZ = -0.645;
  const maxZ = 0.645;
  const skirtRows = 5;
  const drapeHeight = (x: number, z: number) => {
    let height = 0.3;
    for (const block of blocks) {
      const dx = Math.max(block[0] - x, 0, x - block[1]);
      const dz = Math.max(block[2] - z, 0, z - block[3]);
      const distance = Math.hypot(dx, dz);
      height = Math.max(height, block[4] - 0.95 * distance - 0.9 * distance * distance);
    }
    return (
      height +
      0.016 +
      0.022 * valueNoise3d(x * 5 + noiseOffset, z * 5) +
      0.008 * Math.sin(x * 23 + z * 7 + noiseOffset) +
      0.006 * Math.sin(z * 31 - x * 5)
    );
  };
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const gridIndex = (ix: number, iz: number) => iz * (gridX + 1) + ix;
  for (let iz = 0; iz <= gridZ; iz++)
    for (let ix = 0; ix <= gridX; ix++) {
      const x = minX + ((maxX - minX) * ix) / gridX;
      const z = minZ + ((maxZ - minZ) * iz) / gridZ;
      positions.push(x, drapeHeight(x, z), z);
      uvs.push(x * uvScale, z * uvScale);
    }
  for (let iz = 0; iz < gridZ; iz++)
    for (let ix = 0; ix < gridX; ix++) {
      const a = gridIndex(ix, iz);
      const b = gridIndex(ix + 1, iz);
      const c = gridIndex(ix + 1, iz + 1);
      const d = gridIndex(ix, iz + 1);
      indices.push(a, d, b, b, d, c);
    }
  // Border loop around the grid, with outward directions.
  const border: BorderVertex[] = [];
  for (let i = 0; i < gridX; i++) border.push([i, 0, 0, -1]);
  for (let i = 0; i < gridZ; i++) border.push([gridX, i, 1, 0]);
  for (let i = gridX; i > 0; i--) border.push([i, gridZ, 0, 1]);
  for (let i = gridZ; i > 0; i--) border.push([0, i, -1, 0]);
  const borderCount = border.length;
  const gridVertexCount = (gridX + 1) * (gridZ + 1);
  const borderLookup = new Map<string, number>();
  const sagCenter = rng() * borderCount;
  // Skirt hanging down from each border vertex.
  border.forEach((vertex, borderIndex) => {
    borderLookup.set(vertex[0] + ',' + vertex[1], borderIndex);
    const isCorner =
      (vertex[0] === 0 || vertex[0] === gridX) && (vertex[1] === 0 || vertex[1] === gridZ);
    let outX = vertex[2];
    let outZ = vertex[3];
    if (isCorner) {
      outX = vertex[0] === 0 ? -0.707 : 0.707;
      outZ = vertex[1] === 0 ? -0.707 : 0.707;
    }
    const topIndex = gridIndex(vertex[0], vertex[1]);
    const topX = positions[topIndex * 3];
    const topY = positions[topIndex * 3 + 1];
    const topZ = positions[topIndex * 3 + 2];
    let sagDistance = Math.abs(borderIndex - sagCenter);
    sagDistance = Math.min(sagDistance, borderCount - sagDistance);
    const hemY =
      0.17 +
      0.07 * Math.sin(borderIndex * 0.55 + noiseOffset) +
      0.07 * valueNoise3d(borderIndex * 0.31 + noiseOffset, 2.2) +
      0.3 * Math.exp((-sagDistance * sagDistance) / 14);
    const wavePhase = rng() * 6;
    for (let row = 1; row <= skirtRows; row++) {
      const t = row / skirtRows;
      const y = topY + (hemY - topY) * (0.25 * t + 0.75 * t * t) - (row === 1 ? 0.02 : 0);
      const strapPinch =
        (vertex[0] === 5 || vertex[0] === 16) && vertex[2] === 0
          ? 0.035 * Math.sin(Math.PI * t)
          : 0;
      const wave =
        t *
          (0.04 * Math.sin(borderIndex * 1.7 + wavePhase * 0.2) +
            0.028 * Math.sin(borderIndex * 0.83 + 1.3 + noiseOffset)) +
        0.02 * t * valueNoise3d(borderIndex * 0.8, row * 0.9 + noiseOffset) -
        strapPinch;
      const outward = (row === 1 ? 0.028 : 0.04 + 0.03 * t) + wave + (isCorner ? 0.012 * t : 0);
      const x = clamp(topX + outX * outward, -1.2, 1.2);
      const z = clamp(topZ + outZ * outward, -0.7, 0.7);
      const drop = topY - y;
      positions.push(x, y, z);
      uvs.push(
        (topX + outX * (outward + drop)) * uvScale,
        (topZ + outZ * (outward + drop)) * uvScale
      );
    }
  });
  const skirtIndex = (borderIndex: number, row: number) =>
    row === 0
      ? gridIndex(border[borderIndex][0], border[borderIndex][1])
      : gridVertexCount + borderIndex * skirtRows + (row - 1);
  for (let i = 0; i < borderCount; i++)
    for (let row = 0; row < skirtRows; row++) {
      const next = (i + 1) % borderCount;
      const a = skirtIndex(i, row);
      const b = skirtIndex(next, row);
      const c = skirtIndex(next, row + 1);
      const d = skirtIndex(i, row + 1);
      indices.push(a, b, d, b, c, d);
    }
  const tarp = new THREE.BufferGeometry();
  tarp.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  tarp.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  tarp.setIndex(indices);
  tarp.computeVertexNormals();
  const tarpNormal = tarp.attributes.normal;
  const tarpPosition = tarp.attributes.position;
  /** Vertex `index` pushed `offset` along its normal. */
  const offsetVertex = (index: number, offset: number): number[] => [
    tarpPosition.getX(index) + tarpNormal.getX(index) * offset,
    tarpPosition.getY(index) + tarpNormal.getY(index) * offset,
    tarpPosition.getZ(index) + tarpNormal.getZ(index) * offset
  ];
  // Two ratchet straps across the short axis.
  const strapPaths: number[][][] = [];
  for (const column of [5, 16]) {
    const path: number[][] = [];
    const frontBorder = borderLookup.get(column + ',0') as number;
    const backBorder = borderLookup.get(column + ',' + gridZ) as number;
    path.push([tarpPosition.getX(skirtIndex(frontBorder, skirtRows)), 0.11, -0.52]);
    for (let row = skirtRows; row >= 1; row--)
      path.push(offsetVertex(skirtIndex(frontBorder, row), 0.007));
    for (let iz = 0; iz <= gridZ; iz++) path.push(offsetVertex(gridIndex(column, iz), 0.007));
    for (let row = 1; row <= skirtRows; row++)
      path.push(offsetVertex(skirtIndex(backBorder, row), 0.007));
    path.push([tarpPosition.getX(skirtIndex(backBorder, skirtRows)), 0.11, 0.52]);
    strapPaths.push(path);
  }
  // A tie-down rope along the long axis.
  const ropeRow = 6;
  const ropePath: number[][] = [];
  const leftBorder = borderLookup.get('0,' + ropeRow) as number;
  const rightBorder = borderLookup.get(gridX + ',' + ropeRow) as number;
  ropePath.push([-1.1, 0.1, tarpPosition.getZ(skirtIndex(leftBorder, skirtRows))]);
  for (let row = skirtRows; row >= 1; row -= 2)
    ropePath.push(offsetVertex(skirtIndex(leftBorder, row), 0.012));
  for (let ix = 0; ix <= gridX; ix += 2) ropePath.push(offsetVertex(gridIndex(ix, ropeRow), 0.012));
  for (let row = 1; row <= skirtRows; row += 2)
    ropePath.push(offsetVertex(skirtIndex(rightBorder, row), 0.012));
  ropePath.push([1.1, 0.1, tarpPosition.getZ(skirtIndex(rightBorder, skirtRows))]);
  builder.add(
    builder.mat('tarp', {
      doubleSide: true
    }),
    tarp,
    null,
    (x, y, z) => {
      const coarse = valueNoise3d(x * 2.3 + noiseOffset, y * 2.3, z * 2.3);
      const fine = valueNoise3d(x * 11, y * 11, z * 11 + noiseOffset);
      return (
        (0.72 + 0.28 * coarse) *
        (0.9 + 0.1 * fine) *
        (0.8 + 0.2 * smoothstepSoftCargo(0.15, 0.6, y))
      );
    }
  );
  for (const path of strapPaths) {
    builder.add('paint_orange', ribbonGeometry(path, [0.024, 0, 0]), null, [1, 0.82, 0.5]);
    const ratchetAt = path[path.length - 4];
    builder.add(
      'steel_worn',
      roundedBoxGeometry(0.065, 0.1, 0.03, 0.006),
      {
        p: [ratchetAt[0], ratchetAt[1], ratchetAt[2] + 0.014],
        r: [0.25, 0, 0]
      },
      0.8
    );
    builder.add(
      'steel_dark',
      roundedBoxGeometry(0.02, 0.09, 0.012, 0.003),
      {
        p: [ratchetAt[0] + 0.03, ratchetAt[1] + 0.06, ratchetAt[2] + 0.04],
        r: [0.9, 0, 0]
      },
      0.8
    );
  }
  builder.add('rope', tubeThroughPoints(ropePath, 0.009, 4, false, 0.5), null, 0.85);
  const size = [2.4, 1.5, 1.4];
  const topHeight = Math.max(...blocks.map((block) => block[4])) + 0.04;
  return builder.finish({
    size,
    colliders: [
      {
        min: [-1.2, 0, -0.7],
        max: [1.2, topHeight, 0.7],
        surface: 'dirt'
      }
    ]
  });
}

/** A lumpy sandbag `length` x `height` x `width` (bottom face removed), centred at the origin. */
function buildSandbagGeometry(
  length: number,
  height: number,
  width: number,
  rng: Rng
): THREE.BoxGeometry {
  const geometry = removeGeometryGroup(
    subdividedRoundedBox(length, height, width, Math.min(height * 0.46, 0.075), 3, 3, 3),
    3
  );
  const noiseOffset = rng() * 9;
  const tilt = rng.range(-0.05, 0.05);
  const slump = rng.range(0.4, 1);
  mapVertices(geometry, (vertex) => {
    const nx = vertex.x / (length / 2);
    const nz = vertex.z / (width / 2);
    const ny = vertex.y / (height / 2);
    const pinch = 1 - 0.22 * Math.pow(Math.abs(nx), 2.5);
    vertex.z *= pinch * (ny < 0 ? 1.05 : 1);
    vertex.y = (vertex.y + height / 2) * (1 - 0.3 * Math.pow(Math.abs(nx), 3)) - height / 2;
    if (ny > 0) vertex.y += 0.016 * Math.cos(HALF_PI * nx) * Math.cos(HALF_PI * nz);
    vertex.y -=
      slump * 0.018 * Math.abs(nx) * Math.abs(nx) * (ny > -0.9 ? 1 : 0) + tilt * vertex.x * 0.3;
    const lump =
      valueNoise3d(vertex.x * 9 + noiseOffset, vertex.y * 9, vertex.z * 9 + noiseOffset) - 0.5;
    vertex.x += lump * 0.014;
    vertex.z += lump * 0.016;
    if (ny > -0.9) vertex.y += lump * 0.014;
  });
  return computeWeldedNormals(geometry);
}

function buildSandbags(game: Game, options: SoftCargoPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'sandbags', options.seed || 0);
  const rng = builder.rng;
  const courseHeight = 0.18;
  const courses = clamp((options.courses ?? 0) | 0 || 5, 1, 7);
  const fabric = builder.mat(SANDBAG_MATERIAL[0], SANDBAG_MATERIAL[1]);
  const addBag = (length: number, width: number, base: number[], yaw: number) => {
    const height = courseHeight * rng.range(1.02, 1.12);
    const shade = rng() < 0.3 ? rng.range(0.55, 0.75) : rng.range(0.82, 1);
    const noiseOffset = rng() * 30;
    const transform = {
      p: [
        base[0] + rng.range(-0.012, 0.012),
        base[1] + height / 2 - 0.004,
        base[2] + rng.range(-0.012, 0.012)
      ],
      r: [rng.range(-0.03, 0.03), yaw + rng.range(-0.06, 0.06), 0]
    };
    builder.add(fabric, buildSandbagGeometry(length, height, width, rng), transform, (x, y, z) => {
      const grain = valueNoise3d(x * 7 + noiseOffset, y * 7, z * 7);
      return [
        shade * (0.85 + 0.15 * grain),
        shade * (0.84 + 0.15 * grain),
        shade * (0.8 + 0.16 * grain)
      ];
    });
    // Tied-off ends.
    for (const end of [1, -1])
      builder.add(
        fabric,
        ribbonGeometry(
          [
            [end * (length / 2 - 0.004), rng.range(-0.008, 0.008), -width * 0.27],
            [end * (length / 2 - 0.002), rng.range(-0.008, 0.008), width * 0.27]
          ],
          [end * 0.009, 0.001, 0]
        ),
        transform,
        shade * 0.9
      );
  };
  for (let course = 0; course < courses; course++) {
    const y = course * courseHeight;
    const isTop = course === courses - 1;
    if (course % 2 === 0) {
      // Stretcher course: two rows of three bags.
      for (let i = 0; i < 3; i++)
        for (const side of [1, -1])
          if (!(isTop && i === 2 && side === 1 && courses > 2))
            addBag(0.655, 0.3, [(i - 1) * 0.655, y, side * 0.148], 0);
    } else {
      // Header course: five bags across.
      for (let i = 0; i < 5; i++)
        if (!(isTop && i === 0 && courses > 2))
          addBag(0.585, 0.385, [(i - 2) * 0.392, y, 0], HALF_PI);
    }
  }
  return builder.finish({
    size: [2, courses * courseHeight, 0.6],
    surface: 'dirt'
  });
}

const SANDBAG_MATERIAL: [string, MaterialOptions] = [
  'glove_fabric',
  {
    color: 0x8c7d5e
  }
];

/** Options for {@link addCardboardBox}. */
interface CardboardBoxOptions {
  /** How much the box is crushed from above (0..1). */
  crush?: number;
  /** Height fraction of the damp (darker) lower band. */
  damp?: number;
  /** Open top with flaps instead of a closed lid. */
  open?: boolean;
  /** Packing tape over a closed lid. */
  tape?: boolean;
  /** Printed label (`''` for none). */
  label?: string;
  /** "This way up" arrows on the ends. */
  arrow?: boolean;
  /** Overall brightness multiplier. */
  tint?: number;
}

/** Adds one cardboard box `width` x `height` x `depth` placed by `transform`. */
function addCardboardBox(
  builder: CargoPropBuilder,
  width: number,
  height: number,
  depth: number,
  transform: TransformSpec,
  {
    crush = 0,
    damp = 0.3,
    open = false,
    tape = true,
    label = '',
    arrow = false,
    tint = 1
  }: CardboardBoxOptions = {}
): void {
  const rng = builder.rng;
  const game = builder.G;
  const noiseOffset = rng() * 40;
  builder.push(transform);
  const crushVertex = (vertex: THREE.Vector3) => {
    if (!crush) return;
    const heightFraction = clamp(vertex.y / height, 0, 1);
    const falloff = heightFraction * heightFraction;
    vertex.y -=
      crush *
      height *
      0.32 *
      falloff *
      (0.55 + 0.45 * Math.cos(((PI * vertex.x) / width) * 0.9 + 0.5)) *
      (0.8 + 0.2 * Math.cos((PI * vertex.z) / depth));
    vertex.z *= 1 + 0.1 * crush * Math.sin(PI * heightFraction);
    vertex.x +=
      0.12 * crush * height * heightFraction +
      0.02 * crush * Math.sin(PI * heightFraction) * Math.sign(vertex.x);
  };
  const box = subdividedRoundedBox(width, height, depth, 0.007, 4, 5, 4, 'bottom');
  if (open) removeGeometryGroup(box, 2);
  if (crush) {
    mapVertices(box, crushVertex);
    computeWeldedNormals(box);
  }
  const dampLine = damp * height;
  const boxColor = (x: number, y: number, z: number): number[] => {
    const edgeNoise = valueNoise3d(x * 6 + noiseOffset, y * 3, z * 6 + noiseOffset);
    const dry = smoothstepSoftCargo(dampLine - 0.03, dampLine + 0.04, y + 0.08 * (edgeNoise - 0.5));
    const shade = (0.86 + 0.14 * valueNoise3d(x * 13, y * 13 + noiseOffset, z * 13)) * tint;
    return [shade * (0.5 + 0.5 * dry), shade * (0.47 + 0.53 * dry), shade * (0.42 + 0.58 * dry)];
  };
  {
    const position = box.attributes.position;
    const colors = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      const color = boxColor(position.getX(i), position.getY(i), position.getZ(i));
      colors[i * 3] = color[0];
      colors[i * 3 + 1] = color[1];
      colors[i * 3 + 2] = color[2];
    }
    box.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  builder.add('cardboard', box);
  const tapeOffset = 0.0025;
  if (open) {
    const innerDepth = Math.min(0.16, height * 0.6);
    // Contents surface and inner walls.
    builder.add(
      'cardboard',
      offsetUvPlaneSoftCargo(width - 0.012, depth - 0.012),
      {
        p: [0, height - innerDepth, 0],
        r: [-HALF_PI, 0, 0]
      },
      0.45 * tint
    );
    for (const [angle, wallWidth, wallOffset] of [
      [0, width, depth / 2],
      [PI, width, depth / 2],
      [HALF_PI, depth, width / 2],
      [-HALF_PI, depth, width / 2]
    ])
      builder.add(
        'cardboard',
        flipGeometry(offsetUvPlaneSoftCargo(wallWidth - 0.012, innerDepth)),
        {
          p: [
            Math.sin(angle) * (wallOffset - 0.006),
            height - innerDepth / 2,
            Math.cos(angle) * (wallOffset - 0.006)
          ],
          r: [0, angle, 0]
        },
        0.55 * tint
      );
    // Unused in the original build; kept as-is.
    const _flapFrame = (x: number, y: number, angle: number) => {
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      return [x, y, sin, cos];
    };
    // Long flaps.
    for (const side of [1, -1]) {
      const angle = rng.range(0.3, 1.9);
      const flapLength = depth / 2 - 0.01;
      builder.add(
        'cardboard',
        ribbonGeometry(
          [
            [0, height, (side * depth) / 2],
            [
              0,
              height + Math.sin(angle) * flapLength * 0.5,
              side * (depth / 2 + Math.cos(angle) * flapLength * 0.5)
            ],
            [
              0,
              height + Math.sin(angle) * flapLength,
              side * (depth / 2 + Math.cos(angle) * flapLength + 0.01)
            ]
          ],
          [width / 2 - 0.004, 0, 0]
        ),
        null,
        0.9 * tint
      );
    }
    // Short flaps.
    for (const side of [1, -1]) {
      const angle = rng.range(0.9, 2.3);
      const flapLength = depth / 2 - 0.02;
      builder.add(
        'cardboard',
        ribbonGeometry(
          [
            [(side * width) / 2, height, 0],
            [
              side * (width / 2 + Math.cos(angle) * flapLength),
              height + Math.sin(angle) * flapLength,
              0
            ]
          ],
          [0, 0, depth / 2 - 0.004]
        ),
        null,
        0.82 * tint
      );
    }
  } else if (tape) {
    const tapePath: number[][] = [];
    tapePath.push([-width / 2 - tapeOffset, height - 0.075, 0]);
    for (let i = 0; i <= 8; i++)
      tapePath.push([(-0.5 + i / 8) * (width + 2 * tapeOffset), height + tapeOffset, 0]);
    tapePath.push([width / 2 + tapeOffset, height - 0.075, 0]);
    const point = new THREE.Vector3();
    for (const tapePoint of tapePath) {
      point.set(tapePoint[0], tapePoint[1], tapePoint[2]);
      crushVertex(point);
      tapePoint[0] = point.x;
      tapePoint[1] = point.y + (crush ? 0.004 : 0);
      tapePoint[2] = point.z;
    }
    builder.add('polymer_tan', ribbonGeometry(tapePath, [0, 0, 0.025], false), null, 0.9);
  }
  const faceZ = depth / 2 + tapeOffset;
  const labelHeight = Math.min(0.055, height * 0.2);
  if (label && !crush) {
    builder.label(
      label,
      {
        color: 'black',
        font: 'sans',
        distress: 0.3
      },
      width * 0.6,
      labelHeight,
      {
        p: [-width * 0.1, height * 0.62, faceZ]
      }
    );
    builder.add(
      'paint_white',
      offsetUvPlaneSoftCargo(0.11, 0.075),
      {
        p: [width * 0.26, height * 0.3, faceZ - 0.001]
      },
      0.9,
      {
        cast: false
      }
    );
    builder.decal(game.mats.decal('numbers_0_9'), 0.095, {
      p: [width * 0.26, height * 0.3, faceZ + 0.0006]
    });
  }
  if (arrow && !crush)
    for (const side of [1, -1])
      builder.decal(game.mats.decal('arrow'), Math.min(0.09, height * 0.3), {
        p: [side * (width / 2 + tapeOffset), height * 0.55, side * depth * 0.2],
        r: [0, side * HALF_PI, HALF_PI]
      });
  builder.pop();
}

function buildCardboardBoxes(game: Game, options: SoftCargoPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'cardboard_boxes', options.seed || 0);
  const rng = builder.rng;
  const jitter = () => rng.range(-0.015, 0.015);
  const brightness = () => rng.range(0.82, 1);
  addCardboardBox(
    builder,
    0.5,
    0.38,
    0.44,
    {
      p: [-0.23 + jitter(), 0, -0.16 + jitter()],
      r: [0, rng.range(-0.05, 0.05), 0]
    },
    {
      damp: 0.45,
      label: 'FRAGILE',
      arrow: true,
      tint: brightness()
    }
  );
  addCardboardBox(
    builder,
    0.42,
    0.33,
    0.4,
    {
      p: [0.26 + jitter(), 0, -0.17 + jitter()],
      r: [0, rng.range(-0.08, 0.08), 0]
    },
    {
      damp: 0.5,
      label: 'KEEP DRY',
      tint: brightness()
    }
  );
  addCardboardBox(
    builder,
    0.46,
    0.28,
    0.4,
    {
      p: [-0.24 + jitter(), 0.38, -0.15 + jitter()],
      r: [0, rng.range(-0.2, 0.2), 0]
    },
    {
      crush: 1,
      damp: 0.75,
      tint: brightness() * 0.92
    }
  );
  addCardboardBox(
    builder,
    0.33,
    0.26,
    0.32,
    {
      p: [0.27 + jitter(), 0.33, -0.18 + jitter()],
      r: [0, rng.range(-0.3, 0.3), 0]
    },
    {
      open: true,
      damp: 0.1,
      label: '',
      arrow: true,
      tint: brightness()
    }
  );
  addCardboardBox(
    builder,
    0.3,
    0.16,
    0.24,
    {
      p: [-0.26 + jitter(), 0.565, -0.16 + jitter()],
      r: [0.03, rng.range(-0.5, 0.5), -0.09]
    },
    {
      damp: 0.2,
      label: 'HX-2291',
      tint: brightness()
    }
  );
  addCardboardBox(
    builder,
    0.36,
    0.26,
    0.3,
    {
      p: [0.06 + jitter(), 0.105, 0.2],
      r: [0.62, rng.range(-0.25, 0.25), 0]
    },
    {
      damp: 0.9,
      crush: 0.25,
      tint: brightness() * 0.85
    }
  );
  return builder.finish();
}

/** Registers the tarp cargo, sandbag and cardboard box builders. */
export function registerSoftCargoProps(
  register: (name: string, builder: SoftCargoPropBuilderFn) => void
): void {
  register('tarp_cargo', (game, options = {}) => buildTarpCargo(game, options));
  register('sandbags', (game, options = {}) => buildSandbags(game, options));
  register('cardboard_boxes', (game, options = {}) => buildCardboardBoxes(game, options));
}
