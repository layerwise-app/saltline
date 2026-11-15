// Procedural yard cargo props: barrels, pallets, wooden crates, IBC totes, cable reels,
// tyre stacks, jerry cans, traffic cones, gas cylinder racks and pipe stacks. Also exports
// `CargoPropBuilder`, the shared batching helper every procedural prop module builds with.
import * as THREE from 'three';
import { Group, Matrix4, Mesh } from 'three';
import type { BufferGeometry, Material } from 'three';
import { createRng } from '../core/rng';
import type { Rng } from '../core/rng';
import type { Game } from '../core/types';
import type { DecalEntry, LabelOptions } from '../materials/decalArt';
import type { MaterialOptions } from '../materials/index';
import {
  applyTransform,
  mergeGeometryList,
  tubeThroughPoints,
  worldUvBox,
  worldUvCylinder
} from '../render/geometry';
import type { TransformSpec } from '../render/geometry';
import { PROP_SIZES, type PropSizeSpec } from './registry';
import {
  HALF_PI,
  PI,
  clamp,
  composeTransform,
  computeWeldedNormals,
  curvedPanelGeometry,
  cylinderBetween,
  extrudePolygon,
  flatPlaneGeometry,
  flipGeometry,
  mapVertices,
  metricTorusGeometry,
  paintMaterialFor,
  ribbonGeometry,
  roundedBoxGeometry,
  smoothLatheGeometry,
  subdividedRoundedBox,
  tintVertexColors,
  valueNoise3d
} from './meshUtils';
import type { PaintSpec, VertexTint } from './meshUtils';

type Vec3 = [number, number, number];

/** An axis-aligned collision box in prop-local space. */
export interface PropCollider {
  min: readonly number[];
  max: readonly number[];
  surface: string;
}

/** Options for {@link CargoPropBuilder.finish}. */
export interface PropFinishOptions {
  /** Bounding size `[x, y, z]`; defaults to the `PROP_SIZES` entry. */
  size?: readonly number[];
  /** Explicit colliders; defaults to one box of `size`. */
  colliders?: PropCollider[];
  /** Strength of the baked ambient-occlusion / grime darkening (0 disables). */
  grime?: number;
  /** Surface type of the default collider (defaults to the `PROP_SIZES` entry). */
  surface?: string;
}

/** Per-geometry options for {@link CargoPropBuilder.add}. */
export interface PropAddOptions {
  /** Skip vertex tinting and grime (decals, labels). */
  raw?: boolean;
  /** Whether the merged mesh casts shadows. */
  cast?: boolean;
}

/** Options accepted by the cargo prop builders (all optional). */
export interface CargoPropOptions {
  seed?: number;
  /** Paint colour name (see `paintMaterialFor`). */
  color?: string;
  /** Barrel / traffic cone lies on its side. */
  lying?: boolean;
  /** Barrel without a lid. */
  open?: boolean;
  /** Pallet with a missing top board. */
  broken?: boolean;
  /** Number of stacked pallets / tyres. */
  count?: number;
  /** Crate stencil text (`''` for none). */
  label?: string;
  /** Crate side code. */
  code?: string;
}

/** Builder callback signature expected by `registerProp`. */
export type CargoPropBuilderFn = (game: Game, options?: CargoPropOptions) => Group;

/** A batch of geometries sharing a material and shadow mode, merged into one mesh. */
interface MeshBatch {
  mat: Material;
  geos: BufferGeometry[];
  raw: boolean;
  cast: boolean;
}

const lookupPropSize = (name: string): PropSizeSpec | undefined => PROP_SIZES[name];

/**
 * Accumulates transformed, vertex-tinted geometry per material under a transform stack,
 * then merges each batch into a single mesh with baked grime in {@link finish}.
 */
export class CargoPropBuilder {
  G: Game;
  name: string;
  seed: number;
  rng: Rng;
  private batches: Map<string, MeshBatch>;
  stack: Matrix4[];

  constructor(game: Game, name: string, seed = 1) {
    this.G = game;
    this.name = name;
    this.seed = Math.abs(seed | 0);
    this.rng = createRng((this.seed + 1) * 7919 + name.length * 131);
    this.batches = new Map();
    this.stack = [new Matrix4()];
  }

  /** Pushes `transform` (relative to the current top) onto the transform stack. */
  push(transform: TransformSpec): this {
    this.stack.push(
      this.stack[this.stack.length - 1].clone().multiply(composeTransform(transform))
    );
    return this;
  }

  pop(): this {
    this.stack.pop();
    return this;
  }

  /** Library material `name` with vertex colours enabled. */
  mat(name: string, options?: MaterialOptions): THREE.MeshStandardMaterial {
    return this.G.mats.get(name, {
      vertexColors: true,
      ...(options || {})
    });
  }

  /** Transforms `geometry` (local `transform`, then the stack), tints it and batches it. */
  add(
    material: string | Material,
    geometry: BufferGeometry,
    transform?: TransformSpec | null,
    tint: VertexTint = 1,
    { raw = false, cast = true }: PropAddOptions = {}
  ): this {
    const resolved = typeof material == 'string' ? this.mat(material) : material;
    if (transform) applyTransform(geometry, transform);
    geometry.applyMatrix4(this.stack[this.stack.length - 1]);
    if (!raw) tintVertexColors(geometry, tint);
    const key = resolved.uuid + (cast ? 'c' : 'n');
    let batch = this.batches.get(key);
    if (!batch) {
      batch = {
        mat: resolved,
        geos: [],
        raw,
        cast
      };
      this.batches.set(key, batch);
    }
    batch.geos.push(geometry);
    return this;
  }

  /** Flat decal quad `width` wide (height from the decal's aspect unless given). */
  decal(entry: DecalEntry, width: number, transform?: TransformSpec | null, height?: number): this {
    return this.add(
      entry.material,
      flatPlaneGeometry(width, height || width / (entry.aspect || 1)),
      transform,
      1,
      {
        raw: true,
        cast: false
      }
    );
  }

  /** Text label fitted into `maxWidth` x `height`. */
  label(
    text: string,
    options: LabelOptions,
    maxWidth: number,
    height: number,
    transform?: TransformSpec | null
  ): this {
    const entry = this.G.mats.label(text, options);
    const width = Math.min(maxWidth, height * (entry.aspect || 1));
    return this.add(
      entry.material,
      flatPlaneGeometry(width, width / (entry.aspect || 1)),
      transform,
      1,
      {
        raw: true,
        cast: false
      }
    );
  }

  /** Decal bent around a cylinder of `radius` (arc `arcWidth` wide). */
  cdecal(
    entry: DecalEntry,
    radius: number,
    arcWidth: number,
    transform?: TransformSpec | null,
    height?: number
  ): this {
    return this.add(
      entry.material,
      curvedPanelGeometry(radius, arcWidth, height || arcWidth / (entry.aspect || 1)),
      transform,
      1,
      {
        raw: true,
        cast: false
      }
    );
  }

  /** Merges every batch into meshes (with baked grime) and returns the finished prop group. */
  finish({ size, colliders, grime = 1, surface }: PropFinishOptions = {}): Group {
    const group = new Group();
    const noiseOffset = this.seed * 3.71;
    for (const batch of this.batches.values()) {
      const merged = mergeGeometryList(batch.geos);
      if (!batch.raw && grime > 0 && merged.attributes.color) {
        const position = merged.attributes.position;
        const normal = merged.attributes.normal;
        const colors = merged.attributes.color.array;
        for (let i = 0; i < position.count; i++) {
          const x = position.getX(i);
          const y = position.getY(i);
          const z = position.getZ(i);
          const normalY = normal.getY(i);
          const coarse = valueNoise3d(x * 1.9 + noiseOffset, y * 1.9, z * 1.9 + 5.3);
          const fine = valueNoise3d(x * 9 + 2.1, y * 9 + noiseOffset, z * 9);
          let shade =
            (0.82 + 0.18 * coarse) *
            (0.92 + 0.08 * fine) *
            (0.76 + 0.24 * clamp(normalY * 0.6 + 0.62, 0, 1));
          const ground = clamp(1 - y / 0.2, 0, 1);
          shade *= 1 - 0.42 * ground * ground * (0.55 + 0.45 * fine);
          shade = 1 + (shade - 1) * grime;
          colors[i * 3] *= shade;
          colors[i * 3 + 1] *= shade * (1 - 0.05 * ground * grime);
          colors[i * 3 + 2] *= shade * (1 - 0.12 * ground * grime);
        }
      }
      const mesh = new Mesh(merged, batch.mat);
      mesh.castShadow = batch.cast;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    const sizeEntry: PropSizeSpec = lookupPropSize(this.name) || [1, 1, 1, '', 'metal'];
    const finalSize = size || [sizeEntry[0], sizeEntry[1], sizeEntry[2]];
    group.userData.size = finalSize;
    group.userData.colliders = colliders || [
      {
        min: [-finalSize[0] / 2, 0, -finalSize[2] / 2],
        max: [finalSize[0] / 2, finalSize[1], finalSize[2] / 2],
        surface: surface || sizeEntry[4]
      }
    ];
    return group;
  }
}

const propTemplateCache = new Map<string, Group>();

/** Builds a prop once per `key` and returns deep clones of the cached template. */
function cloneCachedProp(key: string, build: () => Group): Group {
  let template = propTemplateCache.get(key);
  if (!template) {
    template = build();
    propTemplateCache.set(key, template);
  }
  return template.clone(true);
}

const smoothstepCargo = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Plane whose uvs are its local XY position plus an offset (metric texture tiling). */
function offsetUvPlaneCargo(
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

type CrateFace = 'pz' | 'nz' | 'px' | 'nx';

const CRATE_FACE_ROTATIONS: Record<CrateFace, Vec3> = {
  pz: [0, 0, 0],
  nz: [0, PI, 0],
  px: [0, HALF_PI, 0],
  nx: [0, -HALF_PI, 0]
};

/** Lathe profile of a 200 L drum (rolling hoops, chimes; open drums get an inner wall). */
function barrelProfilePoints(open: boolean): number[][] {
  const points = [
    [0, 0.016],
    [0.262, 0.016],
    [0.262, 0.016],
    [0.268, 0.002],
    [0.288, 0],
    [0.295, 0.008],
    [0.295, 0.022],
    [0.284, 0.034]
  ];
  for (const hoopY of [0.305, 0.595])
    points.push(
      [0.283, hoopY - 0.03],
      [0.291, hoopY - 0.018],
      [0.297, hoopY],
      [0.291, hoopY + 0.018],
      [0.283, hoopY + 0.03]
    );
  points.push([0.284, 0.866], [0.295, 0.878], [0.295, 0.892], [0.288, 0.9], [0.268, 0.898]);
  if (open) points.push([0.268, 0.898], [0.272, 0.888], [0.272, 0.03], [0.272, 0.03], [0, 0.03]);
  else points.push([0.262, 0.884], [0.262, 0.884], [0, 0.884]);
  return points;
}

function buildBarrel(game: Game, options: CargoPropOptions, variant: number): Group {
  const builder = new CargoPropBuilder(game, 'barrel', variant);
  const rng = builder.rng;
  const segments = 22;
  const [paintMaterial, paintTint] = paintMaterialFor(options.color, 'blue');
  if (options.lying)
    builder.push({
      p: [-0.45, 0.297, 0],
      r: [0, 0, -HALF_PI]
    });
  const shell = smoothLatheGeometry(barrelProfilePoints(!!options.open), segments);
  const dents: number[][] = [];
  for (let i = 0; i < 2 + (variant % 2); i++)
    dents.push([
      rng() * PI * 2,
      rng.range(0.12, 0.78),
      rng.range(0.07, 0.13),
      rng.range(0.006, 0.014)
    ]);
  mapVertices(shell, (vertex) => {
    const radius = Math.hypot(vertex.x, vertex.z);
    if (radius < 0.27) return;
    const angle = Math.atan2(vertex.z, vertex.x);
    for (const dent of dents) {
      let angleDelta = Math.abs(angle - dent[0]) % (PI * 2);
      if (angleDelta > PI) angleDelta = PI * 2 - angleDelta;
      const distance = Math.hypot(angleDelta * 0.285, vertex.y - dent[1]);
      if (distance < dent[2]) {
        const scale = 1 - (dent[3] * (0.5 + 0.5 * Math.cos((PI * distance) / dent[2]))) / radius;
        vertex.x *= scale;
        vertex.z *= scale;
      }
    }
  });
  shell.computeVertexNormals();
  // Average the normals across the lathe seam so it doesn't show.
  const normal = shell.attributes.normal;
  const ringCount = shell.attributes.position.count / (segments + 1);
  for (let ring = 0; ring < ringCount; ring++) {
    const first = ring * (segments + 1);
    const last = first + segments;
    const nx = normal.getX(first) + normal.getX(last);
    const ny = normal.getY(first) + normal.getY(last);
    const nz = normal.getZ(first) + normal.getZ(last);
    const length = Math.hypot(nx, ny, nz) || 1;
    normal.setXYZ(first, nx / length, ny / length, nz / length);
    normal.setXYZ(last, nx / length, ny / length, nz / length);
  }
  const noiseOffset = variant * 2.37;
  const isRust = options.color === 'rust';
  builder.add(paintMaterial, shell, null, (x, y, z) => {
    const radius = Math.hypot(x, z);
    const angle = Math.atan2(z, x);
    if (radius < 0.27) {
      const inner = y > 0.5 ? 0.62 + 0.3 * valueNoise3d(x * 9 + noiseOffset, z * 9) : 0.6;
      return [inner, inner, inner];
    }
    const wear = Math.pow(valueNoise3d(angle * 2.6 + noiseOffset, 3.1), 2.2);
    const bandDistance =
      y > 0.6 ? (0.88 - y) / 0.28 : y > 0.31 ? (0.6 - y) / 0.29 : (0.31 - y) / 0.31;
    const shade = 1 - 0.55 * wear * (1 - 0.6 * clamp(bandDistance, 0, 1));
    const rust =
      (radius > 0.289 ? 1 : 0) * (0.35 + 0.65 * valueNoise3d(angle * 7 + noiseOffset, y * 20));
    const color = [shade * (1 - 0.25 * rust), shade * (1 - 0.42 * rust), shade * (1 - 0.55 * rust)];
    if (typeof paintTint != 'number') {
      color[0] *= paintTint[0];
      color[1] *= paintTint[1];
      color[2] *= paintTint[2];
    }
    return color;
  });
  if (!options.open) {
    builder.add(
      'steel_galv',
      worldUvCylinder(0.036, 0.038, 0.016, 8),
      {
        p: [0.17, 0.891, 0.02]
      },
      0.8
    );
    builder.add(
      'steel_galv',
      worldUvCylinder(0.017, 0.018, 0.014, 8),
      {
        p: [-0.16, 0.89, -0.08]
      },
      0.8
    );
  }
  if (!isRust && variant % 3 !== 2)
    builder.cdecal(game.mats.decal('hazard_flammable'), 0.2855, 0.15, {
      p: [0, 0.455, 0],
      r: [0, 0.9 + variant, 0]
    });
  if (variant % 2 === 0)
    builder.cdecal(
      game.mats.label('UN 1202', {
        color:
          isRust || options.color === 'white' || options.color === 'yellow' ? 'black' : 'white',
        font: 'stencil',
        distress: 0.5
      }),
      0.2855,
      0.2,
      {
        p: [0, 0.74, 0],
        r: [0, 2.6 + variant, 0]
      }
    );
  return builder.finish(
    options.lying
      ? {
          size: [0.9, 0.6, 0.6]
        }
      : {}
  );
}

/** Options for {@link addPalletGeometry}. */
export interface PalletOptions {
  /** Leave out one top deck board. */
  broken?: boolean;
  /** Add the "EUR" stamps on the blocks. */
  stamp?: boolean;
  /** Use bevelled boards instead of plain boxes. */
  bevel?: boolean;
}

/** Adds a 1.2 x 1.0 m EUR pallet (0.144 m tall) at the builder's current transform. */
export function addPalletGeometry(
  builder: CargoPropBuilder,
  rng: Rng,
  { broken = false, stamp = true, bevel = false }: PalletOptions = {}
): void {
  const board = bevel
    ? (width: number, height: number, depth: number) =>
        roundedBoxGeometry(width, height, depth, 0.004)
    : (width: number, height: number, depth: number) => worldUvBox(width, height, depth);
  const woodTint = (): number[] => {
    const shade = rng.range(0.62, 1);
    const warmth = rng.range(0.9, 1);
    return [shade, shade * (0.93 + 0.07 * warmth), shade * (0.82 + 0.18 * warmth)];
  };
  const jitter = (amount = 0.003) => rng.range(-amount, amount);
  // Bottom deck boards.
  for (const [z, depth] of [
    [-0.45, 0.1],
    [0, 0.145],
    [0.45, 0.1]
  ])
    builder.add(
      'wood_pallet',
      board(1.2, 0.022, depth),
      {
        p: [jitter(), 0.011, z + jitter()],
        r: [0, jitter(0.006), 0]
      },
      woodTint()
    );
  const chamferedRect = (width: number, depth: number, chamfer = 0.012) => [
    [-width / 2 + chamfer, -depth / 2],
    [width / 2 - chamfer, -depth / 2],
    [width / 2, -depth / 2 + chamfer],
    [width / 2, depth / 2 - chamfer],
    [width / 2 - chamfer, depth / 2],
    [-width / 2 + chamfer, depth / 2],
    [-width / 2, depth / 2 - chamfer],
    [-width / 2, -depth / 2 + chamfer]
  ];
  // Nine blocks.
  for (const x of [-0.5275, 0, 0.5275])
    for (const z of [-0.45, 0, 0.45])
      builder.add(
        'wood_pallet',
        extrudePolygon(chamferedRect(0.145, z === 0 ? 0.145 : 0.1), 0.078, {
          caps: false,
          soft: 0
        }),
        {
          p: [x + jitter(), 0.061, z + jitter()],
          r: [-HALF_PI, jitter(0.03), 0]
        },
        woodTint().map((channel) => channel * 0.8)
      );
  // Stringer boards.
  for (const x of [-0.5275, 0, 0.5275])
    builder.add(
      'wood_pallet',
      board(0.145, 0.022, 1),
      {
        p: [x + jitter(), 0.111, jitter()],
        r: [0, jitter(0.006), 0]
      },
      woodTint()
    );
  // Top deck boards.
  [
    [-0.4275, 0.145],
    [-0.215, 0.1],
    [0, 0.145],
    [0.215, 0.1],
    [0.4275, 0.145]
  ].forEach(([z, depth], index) => {
    if (!(broken && index === 3))
      builder.add(
        'wood_pallet',
        board(1.2, 0.022, depth),
        {
          p: [jitter(), 0.133, z + jitter(0.006)],
          r: [jitter(0.004), jitter(0.008), 0]
        },
        woodTint()
      );
  });
  if (stamp) {
    const eurLabel = builder.G.mats.label('EUR', {
      color: 'black',
      font: 'sans',
      distress: 0.6
    });
    builder.decal(eurLabel, 0.085, {
      p: [-0.5275, 0.062, 0.5015]
    });
    builder.decal(eurLabel, 0.085, {
      p: [0.5275, 0.062, -0.5015],
      r: [0, PI, 0]
    });
  }
}

function buildPallet(game: Game, options: CargoPropOptions, variant: number): Group {
  const builder = new CargoPropBuilder(game, 'pallet', variant);
  addPalletGeometry(builder, builder.rng, {
    broken: !!options.broken,
    bevel: true
  });
  return builder.finish();
}

function buildPalletStack(game: Game, options: CargoPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'pallet_stack', options.seed || 0);
  const rng = builder.rng;
  const count = clamp((options.count ?? 0) | 0 || 8, 1, 12);
  for (let level = 0; level < count; level++) {
    const isTop = level === count - 1;
    builder.push({
      p: [
        level ? rng.range(-0.028, 0.028) : 0,
        level * 0.144,
        level ? rng.range(-0.022, 0.022) : 0
      ],
      r: [
        0,
        rng.range(-0.035, 0.035) + (rng() < 0.3 ? PI : 0) + (isTop ? rng.range(-0.06, 0.06) : 0),
        0
      ]
    });
    addPalletGeometry(builder, rng, {
      broken: !isTop && rng() < 0.2,
      stamp: level % 3 === 0,
      bevel: isTop
    });
    builder.pop();
  }
  return builder.finish({
    size: [1.2, count * 0.144, 1]
  });
}

/** Options for {@link addWoodCrateGeometry}. */
interface WoodCrateOptions {
  /** Bevelled framing, diagonal braces and extra decals. */
  detail?: boolean;
  /** Stencil text on the long sides (`''` for none). */
  label?: string;
  /** Code stencilled on the +X end (`''` for none). */
  code?: string;
  /** Skids underneath. */
  skids?: boolean;
}

/** Adds a framed wooden crate `width` x `height` x `depth` at the builder's current transform. */
function addWoodCrateGeometry(
  builder: CargoPropBuilder,
  width: number,
  height: number,
  depth: number,
  { detail = true, label = 'FRAGILE', code = 'B4-117', skids = true }: WoodCrateOptions = {}
): void {
  const rng = builder.rng;
  const game = builder.G;
  const boardThickness = 0.022;
  const frameWidth = 0.07;
  const skidHeight = skids ? 0.07 : 0;
  const bodyHeight = height - skidHeight;
  const bodyCenterY = skidHeight + bodyHeight / 2;
  const woodTint = (scale = 1): number[] => {
    const shade = rng.range(0.7, 1) * scale;
    return [shade, shade * rng.range(0.92, 1), shade * rng.range(0.82, 0.95)];
  };
  const frameBox = detail
    ? (x: number, y: number, z: number) => roundedBoxGeometry(x, y, z, 0.004)
    : (x: number, y: number, z: number) => worldUvBox(x, y, z);
  if (skids)
    for (const x of [-(width / 2 - 0.13), 0, width / 2 - 0.13])
      builder.add(
        'wood_pallet',
        roundedBoxGeometry(0.09, skidHeight, depth - 0.02, 0.006),
        {
          p: [x, skidHeight / 2, 0]
        },
        woodTint(0.6)
      );
  // Dark inner box behind the planks.
  builder.add(
    'wood_dark',
    worldUvBox(
      width - 2 * boardThickness - 0.012,
      bodyHeight - boardThickness - 0.012,
      depth - 2 * boardThickness - 0.012
    ),
    {
      p: [0, skidHeight + (bodyHeight - boardThickness - 0.012) / 2 + 0.002, 0]
    },
    0.25
  );
  // Side planks.
  const plankRows = Math.max(3, Math.round(bodyHeight / 0.125));
  const plankHeight = bodyHeight / plankRows;
  for (let row = 0; row < plankRows; row++) {
    const y = skidHeight + plankHeight * (row + 0.5);
    const faces: [CrateFace, number, number][] = [
      ['pz', width, depth / 2 - boardThickness],
      ['nz', width, depth / 2 - boardThickness],
      ['px', depth, width / 2 - boardThickness],
      ['nx', depth, width / 2 - boardThickness]
    ];
    for (const [face, faceWidth, faceOffset] of faces) {
      const inset = faceOffset - rng.range(0, 0.004);
      const position =
        face === 'pz'
          ? [0, y, inset]
          : face === 'nz'
            ? [0, y, -inset]
            : face === 'px'
              ? [inset, y, 0]
              : [-inset, y, 0];
      builder.add(
        'wood_pallet',
        offsetUvPlaneCargo(faceWidth - 0.03, plankHeight - 0.005, rng() * 3, rng() * 3),
        {
          p: position,
          r: CRATE_FACE_ROTATIONS[face]
        },
        woodTint()
      );
    }
  }
  // Lid planks.
  const lidPlanks = Math.max(3, Math.round(depth / 0.13));
  const lidPlankDepth = (depth - 0.02) / lidPlanks;
  for (let i = 0; i < lidPlanks; i++)
    builder.add(
      'wood_pallet',
      offsetUvPlaneCargo(width - 0.03, lidPlankDepth - 0.005, rng() * 3, rng() * 3),
      {
        p: [
          0,
          height - boardThickness - rng.range(0, 0.003),
          -depth / 2 + 0.01 + lidPlankDepth * (i + 0.5)
        ],
        r: [-HALF_PI, 0, 0]
      },
      woodTint()
    );
  // Frames on the long sides and ends.
  const braceAngle = Math.atan2(bodyHeight - 2 * frameWidth, width - 2 * frameWidth);
  const braceLength = Math.hypot(width - 2 * frameWidth, bodyHeight - 2 * frameWidth);
  for (const side of [1, -1]) {
    const sideZ = side * (depth / 2 - boardThickness / 2);
    builder.add(
      'wood_pallet',
      frameBox(width, frameWidth, boardThickness),
      {
        p: [0, skidHeight + frameWidth / 2, sideZ]
      },
      woodTint(0.85)
    );
    builder.add(
      'wood_pallet',
      frameBox(width, frameWidth, boardThickness),
      {
        p: [0, height - frameWidth / 2, sideZ]
      },
      woodTint(0.85)
    );
    for (const end of [1, -1])
      builder.add(
        'wood_pallet',
        frameBox(frameWidth, bodyHeight - 2 * frameWidth, boardThickness),
        {
          p: [end * (width / 2 - frameWidth / 2), bodyCenterY, sideZ]
        },
        woodTint(0.85)
      );
    if (detail)
      builder.add(
        'wood_pallet',
        roundedBoxGeometry(braceLength, frameWidth * 0.85, boardThickness * 0.8, 0.004),
        {
          p: [0, bodyCenterY, side * (depth / 2 - boardThickness * 0.6)],
          r: [0, 0, side * braceAngle]
        },
        woodTint(0.8)
      );
    const endX = side * (width / 2 - boardThickness / 2);
    const innerDepth = depth - 2 * boardThickness;
    for (const end of [1, -1])
      builder.add(
        'wood_pallet',
        frameBox(boardThickness, bodyHeight, frameWidth),
        {
          p: [endX, bodyCenterY, end * (innerDepth / 2 - frameWidth / 2)]
        },
        woodTint(0.85)
      );
    builder.add(
      'wood_pallet',
      frameBox(boardThickness, frameWidth, innerDepth - 2 * frameWidth),
      {
        p: [endX, skidHeight + frameWidth / 2, 0]
      },
      woodTint(0.85)
    );
    builder.add(
      'wood_pallet',
      frameBox(boardThickness, frameWidth, innerDepth - 2 * frameWidth),
      {
        p: [endX, height - frameWidth / 2, 0]
      },
      woodTint(0.85)
    );
    builder.add(
      'wood_pallet',
      frameBox(width, boardThickness, frameWidth),
      {
        p: [0, height - boardThickness / 2, side * (depth / 2 - frameWidth / 2)]
      },
      woodTint(0.85)
    );
    builder.add(
      'wood_pallet',
      frameBox(frameWidth, boardThickness, depth - 2 * frameWidth),
      {
        p: [side * (width / 2 - frameWidth / 2), height - boardThickness / 2, 0]
      },
      woodTint(0.85)
    );
  }
  if (detail)
    builder.add(
      'wood_pallet',
      roundedBoxGeometry(frameWidth, boardThickness, depth - 2 * frameWidth, 0.004),
      {
        p: [0, height - boardThickness / 2, 0]
      },
      woodTint(0.85)
    );
  // Galvanised corner brackets.
  const bracketSize = 0.085;
  const steelTint = (): number[] => {
    const shade = rng.range(0.55, 0.9);
    return [shade, shade * 0.9, shade * 0.8];
  };
  for (const sideX of [1, -1])
    for (const sideZ of [1, -1])
      for (const atTop of detail ? [1, 0] : [1]) {
        const y = atTop ? height - bracketSize / 2 : skidHeight + bracketSize / 2;
        const tint = steelTint();
        builder.add(
          'steel_galv',
          worldUvBox(bracketSize, bracketSize, 0.003),
          {
            p: [sideX * (width / 2 - bracketSize / 2), y, sideZ * (depth / 2 + 0.0015)]
          },
          tint
        );
        builder.add(
          'steel_galv',
          worldUvBox(0.003, bracketSize, bracketSize),
          {
            p: [sideX * (width / 2 + 0.0015), y, sideZ * (depth / 2 - bracketSize / 2)]
          },
          tint
        );
        if (atTop)
          builder.add(
            'steel_galv',
            worldUvBox(bracketSize, 0.003, bracketSize),
            {
              p: [
                sideX * (width / 2 - bracketSize / 2),
                height + 0.0015,
                sideZ * (depth / 2 - bracketSize / 2)
              ]
            },
            tint
          );
      }
  // Stencils and decals.
  const faceZ = depth / 2 - boardThickness + 0.003;
  const textHeight = Math.min(0.11, bodyHeight * 0.15);
  if (label) {
    builder.label(
      label,
      {
        color: 'black',
        font: 'stencil',
        distress: 0.25
      },
      width * 0.4,
      textHeight,
      {
        p: [-width * 0.2, height - frameWidth - textHeight * 0.95, faceZ]
      }
    );
    builder.label(
      label,
      {
        color: 'black',
        font: 'stencil',
        distress: 0.25
      },
      width * 0.4,
      textHeight,
      {
        p: [width * 0.2, height - frameWidth - textHeight * 0.95, -faceZ],
        r: [0, PI, 0]
      }
    );
    builder.decal(game.mats.decal('arrow'), Math.min(0.14, bodyHeight * 0.2), {
      p: [width * 0.27, skidHeight + frameWidth + bodyHeight * 0.16, faceZ],
      r: [0, 0, HALF_PI]
    });
  }
  if (code)
    builder.label(
      code,
      {
        color: 'black',
        font: 'stencil',
        distress: 0.3
      },
      depth * 0.5,
      textHeight * 0.9,
      {
        p: [width / 2 - boardThickness + 0.003, bodyCenterY + bodyHeight * 0.12, 0],
        r: CRATE_FACE_ROTATIONS.px
      }
    );
  if (detail)
    builder.decal(game.mats.decal('logo_b'), Math.min(0.2, bodyHeight * 0.25), {
      p: [-(width / 2 - boardThickness + 0.003), bodyCenterY - bodyHeight * 0.05, 0],
      r: CRATE_FACE_ROTATIONS.nx
    });
}

function buildWoodCrate(game: Game, options: CargoPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'crate_wood', options.seed || 0);
  addWoodCrateGeometry(builder, 1.1, 1, 0.9, {
    label:
      options.label === undefined
        ? ['FRAGILE', 'THIS SIDE UP', 'KEEP DRY', 'MACHINE PARTS'][builder.seed % 4]
        : options.label,
    code: options.code || 'B4-' + [117, 204, 318][builder.seed % 3]
  });
  return builder.finish();
}

/** Position / yaw of a crate stacked on another. */
interface StackedCrate {
  x: number;
  z: number;
  th: number;
}

function buildCrateStack(game: Game, options: CargoPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'crate_stack', options.seed || 0);
  const rng = builder.rng;
  addWoodCrateGeometry(builder, 1.2, 0.95, 1, {
    label: 'HEAVY',
    code: 'SLT 04' + (builder.seed % 2)
  });
  const middle = {
    x: rng.range(-0.1, 0.02),
    z: rng.range(-0.05, 0.05),
    th: (rng() < 0.5 ? -1 : 1) * rng.range(0.1, 0.16),
    L: 0.86,
    W: 0.72
  };
  builder.push({
    p: [middle.x, 0.95, middle.z],
    r: [0, middle.th, 0]
  });
  addWoodCrateGeometry(builder, middle.L, 0.6, middle.W, {
    detail: false,
    skids: false,
    label: 'FRAGILE',
    code: 'B4-204'
  });
  builder.pop();
  const top: StackedCrate = {
    x: middle.x + rng.range(-0.05, 0.05),
    z: middle.z + rng.range(-0.04, 0.04),
    th: rng.range(-0.12, 0.12)
  };
  builder.push({
    p: [top.x, 1.55, top.z],
    r: [0, top.th, 0]
  });
  addWoodCrateGeometry(builder, 0.55, 0.35, 0.45, {
    detail: false,
    skids: false,
    label: '',
    code: ''
  });
  builder.pop();
  /** Z of a yawed crate's `side` face at world x (where a strap at `x` passes over it). */
  const strapFaceZ = (
    x: number,
    crate: StackedCrate,
    yaw: number,
    halfDepth: number,
    side: number
  ): number => {
    const along = (x - crate.x - side * halfDepth * Math.sin(yaw)) / Math.cos(yaw);
    return crate.z - along * Math.sin(yaw) + side * halfDepth * Math.cos(yaw);
  };
  // Two ratchet straps over the whole stack.
  for (const strapX of [-0.2, 0.17]) {
    const path: number[][] = [];
    const sidePoints = (side: number): number[][] => [
      [strapX, 0.09, side * 0.506],
      [strapX, 0.956, side * 0.506],
      [strapX, 1.556, strapFaceZ(strapX, middle, middle.th, middle.W / 2, side) + side * 0.006],
      [strapX, 1.906, strapFaceZ(strapX, top, top.th, 0.225, side) + side * 0.006]
    ];
    path.push(...sidePoints(1), ...sidePoints(-1).reverse());
    builder.add('paint_orange', ribbonGeometry(path, [0.02, 0, 0]), null, [1, 0.8, 0.5]);
    builder.add(
      'steel_worn',
      roundedBoxGeometry(0.06, 0.09, 0.025, 0.006),
      {
        p: [strapX, 0.62, 0.5 + 0.016]
      },
      0.8
    );
    builder.add(
      'steel_dark',
      cylinderBetween([strapX - 0.035, 0.66, 0.53], [strapX + 0.035, 0.66, 0.53], 0.008, 6, true),
      null,
      0.8
    );
  }
  return builder.finish();
}

function buildIbcTote(game: Game, options: CargoPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'ibc_tote', options.seed || 0);
  const rng = builder.rng;
  const steelShade = () => rng.range(0.75, 1);
  // Steel pallet base.
  for (const z of [-0.44, 0, 0.44])
    builder.add(
      'steel_galv',
      worldUvBox(1.2, 0.028, 0.1),
      {
        p: [0, 0.014, z]
      },
      steelShade()
    );
  for (const x of [-0.54, 0, 0.54])
    for (const z of [-0.44, 0, 0.44])
      builder.add(
        'steel_galv',
        roundedBoxGeometry(0.12, 0.074, 0.1, 0.008),
        {
          p: [x, 0.065, z]
        },
        steelShade() * 0.85
      );
  for (const z of [-0.48, 0.48])
    builder.add(
      'steel_galv',
      roundedBoxGeometry(1.2, 0.03, 0.04, 0.006),
      {
        p: [0, 0.115, z]
      },
      steelShade()
    );
  for (const x of [-0.58, 0.58])
    builder.add(
      'steel_galv',
      roundedBoxGeometry(0.04, 0.03, 0.92, 0.006),
      {
        p: [x, 0.115, 0]
      },
      steelShade()
    );
  builder.add(
    'steel_galv',
    worldUvBox(1.12, 0.012, 0.92),
    {
      p: [0, 0.124, 0]
    },
    0.6
  );
  // Bulging plastic bottle.
  const bottleWidth = 1.1;
  const bottleHeight = 0.95;
  const bottleDepth = 0.9;
  const bottleCenterY = 0.13 + bottleHeight / 2;
  const bottle = subdividedRoundedBox(bottleWidth, bottleHeight, bottleDepth, 0.07, 8, 6, 8);
  mapVertices(bottle, (vertex) => {
    const nx = vertex.x / (bottleWidth / 2);
    const ny = vertex.y / (bottleHeight / 2);
    const nz = vertex.z / (bottleDepth / 2);
    const sideBulge = Math.cos(HALF_PI * ny) * Math.cos(HALF_PI * nz);
    const topBulge = Math.cos(HALF_PI * nx) * Math.cos(HALF_PI * nz);
    const endBulge = Math.cos(HALF_PI * nx) * Math.cos(HALF_PI * ny);
    if (Math.abs(nx) > 0.9)
      vertex.x +=
        Math.sign(nx) *
        (0.016 * sideBulge + 0.004 * Math.abs(Math.sin((vertex.y * PI) / 0.22)) * sideBulge);
    if (Math.abs(nz) > 0.9)
      vertex.z +=
        Math.sign(nz) *
        (0.016 * endBulge + 0.004 * Math.abs(Math.sin((vertex.y * PI) / 0.22)) * endBulge);
    if (ny > 0.9)
      vertex.y += 0.012 * topBulge - 0.01 * Math.max(0, 1 - Math.hypot(vertex.x, vertex.z) / 0.3);
  });
  computeWeldedNormals(bottle);
  const fillLevel = 0.13 + bottleHeight * rng.range(0.45, 0.8);
  const noiseOffset = builder.seed * 1.3;
  const plastic = builder.mat('plastic_grey', {
    color: 0xd9ddd0
  });
  builder.add(
    plastic,
    bottle,
    {
      p: [0, bottleCenterY, 0]
    },
    (x, y, z) => {
      const filled = smoothstepCargo(
        fillLevel - 0.03,
        fillLevel + 0.03,
        y + 0.02 * valueNoise3d(x * 3 + noiseOffset, z * 3)
      );
      const shade = 0.9 + 0.1 * valueNoise3d(x * 6, y * 6 + noiseOffset, z * 6);
      return [
        shade * (0.52 + 0.48 * filled),
        shade * (0.6 + 0.4 * filled),
        shade * (0.66 + 0.34 * filled)
      ];
    }
  );
  builder.add(
    plastic,
    worldUvCylinder(0.12, 0.125, 0.03, 14),
    {
      p: [0, 0.13 + bottleHeight + 0.005, 0]
    },
    0.9
  );
  builder.add(
    'plastic_red',
    smoothLatheGeometry(
      [
        [0.105, 0],
        [0.105, 0.042],
        [0.105, 0.042],
        [0.09, 0.05],
        [0, 0.05]
      ],
      14
    ),
    {
      p: [0, 0.13 + bottleHeight + 0.015, 0]
    },
    0.9
  );
  for (let i = 0; i < 8; i++) {
    const angle = (i * PI) / 4;
    builder.add(
      'plastic_red',
      worldUvBox(0.012, 0.04, 0.02),
      {
        p: [Math.cos(angle) * 0.108, 0.13 + bottleHeight + 0.036, Math.sin(angle) * 0.108],
        r: [0, -angle, 0]
      },
      0.8
    );
  }
  // Galvanised cage.
  const cageHalfX = 0.575;
  const cageHalfZ = 0.475;
  const cageBottom = 0.13;
  const cageTop = 1.1;
  const barRadius = 0.011;
  for (const y of [0.2, 0.42, 0.64, 0.86, cageTop]) {
    const radius = y === cageTop ? 0.014 : barRadius;
    for (const side of [1, -1]) {
      builder.add(
        'steel_galv',
        cylinderBetween(
          [-cageHalfX, y, side * cageHalfZ],
          [cageHalfX, y, side * cageHalfZ],
          radius,
          5
        ),
        null,
        steelShade()
      );
      builder.add(
        'steel_galv',
        cylinderBetween(
          [side * cageHalfX, y, -cageHalfZ],
          [side * cageHalfX, y, cageHalfZ],
          radius,
          5
        ),
        null,
        steelShade()
      );
    }
  }
  for (const side of [1, -1]) {
    for (let x = -0.46; x <= 0.461; x += 0.184)
      builder.add(
        'steel_galv',
        cylinderBetween(
          [x, cageBottom, side * (cageHalfZ - 0.012)],
          [x, cageTop, side * (cageHalfZ - 0.012)],
          barRadius,
          5
        ),
        null,
        steelShade()
      );
    for (let z = -0.36; z <= 0.361; z += 0.18)
      builder.add(
        'steel_galv',
        cylinderBetween(
          [side * (cageHalfX - 0.012), cageBottom, z],
          [side * (cageHalfX - 0.012), cageTop, z],
          barRadius,
          5
        ),
        null,
        steelShade()
      );
    builder.add(
      'steel_galv',
      cylinderBetween(
        [side * 0.28, cageTop + 0.01, -cageHalfZ],
        [side * 0.28, cageTop + 0.01, cageHalfZ],
        0.013,
        5
      ),
      null,
      steelShade()
    );
  }
  // Data plate, hazard decals and outlet valve.
  builder.add(
    'aluminium',
    roundedBoxGeometry(0.42, 0.3, 0.004, 0.0015),
    {
      p: [-0.1, 0.72, cageHalfZ + 0.014]
    },
    0.85
  );
  builder.label(
    'IBC 1000 L',
    {
      color: 'black',
      font: 'sans',
      distress: 0.2
    },
    0.36,
    0.06,
    {
      p: [-0.1, 0.8, cageHalfZ + 0.0175]
    }
  );
  builder.decal(game.mats.decal(['hazard_flammable', 'hazard_general'][builder.seed % 2]), 0.15, {
    p: [-0.19, 0.67, cageHalfZ + 0.0175]
  });
  builder.decal(game.mats.decal('numbers_0_9'), 0.2, {
    p: [0, 0.66, cageHalfZ + 0.0175]
  });
  builder.decal(game.mats.decal('leak_stain'), 0.3, {
    p: [cageHalfX + 0.004, 0.3, 0.02],
    r: CRATE_FACE_ROTATIONS.px
  });
  builder.add(
    'polymer_black',
    cylinderBetween([0.52, 0.2, 0], [0.575, 0.2, 0], 0.05, 10, true),
    null,
    1
  );
  builder.add(
    'plastic_red',
    cylinderBetween([0.575, 0.2, 0], [0.598, 0.2, 0], 0.045, 10, true),
    null,
    0.9
  );
  builder.add(
    'plastic_red',
    roundedBoxGeometry(0.02, 0.022, 0.13, 0.005),
    {
      p: [0.55, 0.262, 0.02],
      r: [0, 0.4, 0]
    },
    0.9
  );
  builder.add('polymer_black', worldUvCylinder(0.012, 0.012, 0.03, 6), {
    p: [0.55, 0.245, 0]
  });
  return builder.finish();
}

/**
 * Flat planks filling a disc of `radius` (a cable-reel flange), one geometry per plank.
 * Each plank consumes two `rng` draws for its uv offset.
 */
function buildReelFlangePlanks(
  radius: number,
  plankCount: number,
  rng: Rng,
  _unused = 0
): BufferGeometry[] {
  const planks: BufferGeometry[] = [];
  const plankWidth = (2 * radius) / plankCount;
  for (let i = 0; i < plankCount; i++) {
    const left = -radius + i * plankWidth + 0.003;
    const right = -radius + (i + 1) * plankWidth - 0.003;
    const columns = [left, (left + right) / 2, right];
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const halfChord = (x: number) => Math.sqrt(Math.max(0, radius * radius - x * x));
    const uvOffsetU = rng() * 2;
    const uvOffsetV = rng() * 2;
    for (const x of columns) {
      positions.push(x, -halfChord(x), 0, x, halfChord(x), 0);
      normals.push(0, 0, 1, 0, 0, 1);
      uvs.push(-halfChord(x) + uvOffsetU, x + uvOffsetV, halfChord(x) + uvOffsetU, x + uvOffsetV);
    }
    indices.push(0, 2, 3, 0, 3, 1, 2, 4, 5, 2, 5, 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geometry.setIndex(indices);
    planks.push(geometry);
  }
  return planks;
}

function buildCableReel(game: Game, options: CargoPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'cable_reel', options.seed || 0);
  const rng = builder.rng;
  const flangeRadius = 0.65;
  const axleHeight = flangeRadius;
  const halfLength = 0.4;
  const flangeThickness = 0.045;
  const woodTint = (scale = 1): number[] => {
    const shade = rng.range(0.7, 1) * scale;
    return [shade, shade * rng.range(0.93, 1), shade * rng.range(0.85, 0.97)];
  };
  const spin = rng.range(-0.5, 0.5);
  builder.push({
    p: [0, axleHeight, 0],
    r: [0, 0, spin]
  });
  for (const side of [1, -1]) {
    for (const plank of buildReelFlangePlanks(flangeRadius - 0.004, 9, rng))
      builder.add(
        'wood_dark',
        plank,
        {
          p: [0, 0, side * (halfLength + rng.range(0, 0.003))],
          r: [0, side > 0 ? 0 : PI, 0]
        },
        woodTint()
      );
    for (const plank of buildReelFlangePlanks(flangeRadius - 0.004, 9, rng))
      builder.add(
        'wood_dark',
        plank,
        {
          p: [0, 0, side * (halfLength - flangeThickness)],
          r: [0, side > 0 ? PI : 0, HALF_PI]
        },
        woodTint(0.8)
      );
    builder.add(
      'wood_dark',
      worldUvCylinder(flangeRadius, flangeRadius, flangeThickness, 24, true),
      {
        p: [0, 0, side * (halfLength - flangeThickness / 2)],
        r: [HALF_PI, 0, 0]
      },
      woodTint(0.75)
    );
    builder.add(
      'steel_dark',
      worldUvCylinder(0.105, 0.105, 0.008, 12),
      {
        p: [0, 0, side * (halfLength + 0.006)],
        r: [HALF_PI, 0, 0]
      },
      0.9
    );
    builder.add(
      'polymer_black',
      worldUvCylinder(0.04, 0.04, 0.004, 10),
      {
        p: [0, 0, side * (halfLength + 0.0105)],
        r: [HALF_PI, 0, 0]
      },
      0.3
    );
    for (let i = 0; i < 6; i++) {
      const angle = (i * PI) / 3 + 0.3;
      builder.add(
        'steel_galv',
        worldUvCylinder(0.017, 0.017, 0.014, 6),
        {
          p: [Math.cos(angle) * 0.3, Math.sin(angle) * 0.3, side * (halfLength + 0.006)],
          r: [HALF_PI, 0, 0]
        },
        rng.range(0.5, 0.9)
      );
    }
    builder.label(
      side > 0 ? 'NYY-J 4x95 mm2  500 m' : 'SALTLINE TERMINAL',
      {
        color: 'white',
        font: 'stencil',
        distress: 0.45
      },
      0.7,
      0.085,
      {
        p: [0, 0.4, side * (halfLength + 0.006)],
        r: [0, side > 0 ? 0 : PI, 0]
      }
    );
    if (side > 0)
      builder.decal(game.mats.decal('arrow'), 0.2, {
        p: [0.36, -0.2, halfLength + 0.006],
        r: [0, 0, -1.2]
      });
  }
  // Wound cable: a ribbed lathe between the flanges.
  const windings = 16;
  const innerHalf = halfLength - flangeThickness;
  const windingPitch = (2 * innerHalf) / windings;
  const cableRadius = 0.47;
  const profile: number[][] = [];
  for (let i = 0; i <= windings; i++) {
    profile.push([cableRadius - 0.017, -innerHalf + i * windingPitch]);
    if (i < windings) profile.push([cableRadius, -innerHalf + (i + 0.5) * windingPitch]);
  }
  const noiseOffset = builder.seed * 0.7;
  builder.add(
    'rubber',
    smoothLatheGeometry(profile, 20),
    {
      r: [HALF_PI, 0, 0]
    },
    (x, y, z) => 0.7 + 0.5 * valueNoise3d(Math.atan2(y, x) * 2 + noiseOffset, z * 30)
  );
  builder.pop();
  // Loose cable end trailing onto the ground.
  const tailZ = 0.2;
  const tail: number[][] = [];
  for (let angle = 1.9; angle >= -0.25; angle -= 0.36)
    tail.push([
      Math.cos(angle) * (cableRadius + 0.012),
      axleHeight + Math.sin(angle) * (cableRadius + 0.012),
      tailZ + (1.9 - angle) * 0.02
    ]);
  tail.push(
    [0.53, 0.3, tailZ + 0.05],
    [0.56, 0.08, tailZ + 0.06],
    [0.5, 0.024, tailZ + 0.02],
    [0.3, 0.022, tailZ - 0.1],
    [0.05, 0.022, tailZ - 0.02],
    [-0.2, 0.022, tailZ + 0.06],
    [-0.38, 0.022, tailZ - 0.05]
  );
  builder.add('rubber', tubeThroughPoints(tail, 0.02, 6, false, 0.5), null, 0.9);
  builder.add(
    'brass',
    cylinderBetween([-0.38, 0.022, tailZ - 0.05], [-0.41, 0.022, tailZ - 0.07], 0.014, 6, true),
    null,
    0.9
  );
  // Wheel chocks.
  for (const z of [halfLength - flangeThickness / 2, -(halfLength - flangeThickness / 2)]) {
    builder.add(
      'wood_pallet',
      extrudePolygon(
        [
          [0.14, 0],
          [0.37, 0],
          [0.37, 0.1]
        ],
        0.1,
        {
          soft: 0
        }
      ),
      {
        p: [0, 0, z]
      },
      woodTint(0.8)
    );
    builder.add(
      'wood_pallet',
      extrudePolygon(
        [
          [-0.37, 0],
          [-0.14, 0],
          [-0.37, 0.1]
        ],
        0.1,
        {
          soft: 0
        }
      ),
      {
        p: [0, 0, z]
      },
      woodTint(0.8)
    );
  }
  return builder.finish();
}

/**
 * Lathed tyre (axis +Y, from y=0 to `width`) with tread grooves; uvs are metric around the
 * circumference and mirror across the tread centre.
 */
export function buildTireGeometry(
  outerRadius: number,
  width: number,
  innerRadius: number,
  segments = 20
): BufferGeometry {
  const sidewall = outerRadius - innerRadius;
  const grooveDepth = Math.min(0.011, sidewall * 0.08);
  const profile = [
    [innerRadius, width * 0.18],
    [innerRadius + sidewall * 0.45, width * 0.035],
    [outerRadius - sidewall * 0.2, width * 0.02],
    [outerRadius - sidewall * 0.06, width * 0.07],
    [outerRadius, width * 0.17],
    [outerRadius, width * 0.17],
    [outerRadius, width * 0.355],
    [outerRadius - grooveDepth, width * 0.385],
    [outerRadius, width * 0.415],
    [outerRadius, width * 0.585],
    [outerRadius - grooveDepth, width * 0.615],
    [outerRadius, width * 0.645],
    [outerRadius, width * 0.83],
    [outerRadius, width * 0.83],
    [outerRadius - sidewall * 0.06, width * 0.93],
    [outerRadius - sidewall * 0.2, width * 0.98],
    [innerRadius + sidewall * 0.45, width * 0.965],
    [innerRadius, width * 0.82],
    [innerRadius, width * 0.82],
    [innerRadius, width * 0.18]
  ];
  const geometry = smoothLatheGeometry(profile, segments);
  const uv = geometry.attributes.uv;
  const pointCount = profile.length;
  const arcLength = [0];
  for (let i = 1; i < pointCount; i++)
    arcLength.push(
      arcLength[i - 1] +
        Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1])
    );
  const treadCenter = (arcLength[8] + arcLength[9]) / 2;
  const treadHalf = treadCenter - arcLength[4];
  const sidewallLength = arcLength[4] - arcLength[0];
  const circumference = Math.max(1, Math.round((2 * PI * outerRadius) / 0.5)) * 0.5;
  for (let i = 0; i < pointCount; i++) {
    const offset = i >= pointCount - 2 ? -(treadHalf + sidewallLength) : arcLength[i] - treadCenter;
    const distance = Math.abs(offset);
    const v =
      Math.sign(offset) *
      (distance <= treadHalf + 1e-6
        ? (distance / treadHalf) * 0.126
        : 0.126 + Math.min(1, (distance - treadHalf) / sidewallLength) * 0.022);
    for (let j = 0; j <= segments; j++)
      uv.setXY(i * (segments + 1) + j, (j / segments) * circumference, v);
  }
  return geometry;
}

function buildTireStack(game: Game, options: CargoPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'tire_stack', options.seed || 0);
  const rng = builder.rng;
  const count = clamp((options.count ?? 0) | 0 || 4, 1, 5);
  for (let level = 0; level < count; level++) {
    const tire = buildTireGeometry(0.39, 0.25, 0.215, count > 4 ? 16 : 20);
    const transform: { p: Vec3; r: Vec3 } = {
      p: [
        level ? rng.range(-0.022, 0.022) : 0,
        level * 0.25 - (level ? 0.004 : 0),
        level ? rng.range(-0.022, 0.022) : 0
      ],
      r: [0, rng() * 6, 0]
    };
    const shade = rng.range(0.75, 1);
    const noiseOffset = level * 3.1;
    builder.add('tire', tire, transform, (x, y, z) => {
      const radius = Math.hypot(x - transform.p[0], z - transform.p[2]);
      return (
        shade *
        (radius < 0.23
          ? 0.5
          : 0.8 + 0.2 * valueNoise3d(Math.atan2(z, x) * 3 + noiseOffset, radius * 30))
      );
    });
  }
  return builder.finish({
    size: [0.8, count * 0.25, 0.8]
  });
}

function buildJerryCan(game: Game, options: CargoPropOptions, variant: number): Group {
  const builder = new CargoPropBuilder(game, 'jerry_can', variant);
  const [paintMaterial, paintTint] = paintMaterialFor(options.color, 'olive');
  const body = subdividedRoundedBox(0.336, 0.36, 0.156, 0.022, 3, 3, 3, 'bottom');
  /** Slopes the top-front shoulder down towards +x. */
  const shoulderY = (x: number, y: number) => (y > 0.3 && x > 0.04 ? y - (x - 0.04) * 0.5 : y);
  mapVertices(body, (vertex) => {
    vertex.y = shoulderY(vertex.x, vertex.y);
    if (Math.abs(vertex.z) > 0.07 && Math.abs(vertex.x) < 0.14 && vertex.y > 0.04 && vertex.y < 0.3)
      vertex.z *= 1.02;
  });
  body.computeVertexNormals();
  builder.add(paintMaterial, body, null, paintTint);
  builder.add(
    paintMaterial,
    extrudePolygon(
      [
        [-0.172, 0],
        [0.172, 0],
        [0.172, 0.297],
        [0.045, 0.364],
        [-0.172, 0.364]
      ],
      0.007,
      {
        soft: 0
      }
    ),
    null,
    typeof paintTint == 'number' ? 0.8 : paintTint.map((channel) => channel * 0.8)
  );
  // Embossed X ribs on both faces.
  const ribWidth = 0.24;
  const ribHeight = 0.2;
  const ribCenterX = -0.025;
  const ribCenterY = 0.165;
  const diagonalLength = Math.hypot(ribWidth, ribHeight) - 0.02;
  const diagonalAngle = Math.atan2(ribHeight, ribWidth);
  for (const side of [1, -1]) {
    const z = side * 0.079;
    for (const edge of [1, -1])
      builder.add(
        paintMaterial,
        roundedBoxGeometry(ribWidth, 0.016, 0.007, 0.003),
        {
          p: [ribCenterX, ribCenterY + (edge * ribHeight) / 2, z]
        },
        paintTint
      );
    for (const edge of [1, -1])
      builder.add(
        paintMaterial,
        roundedBoxGeometry(0.016, ribHeight, 0.007, 0.003),
        {
          p: [ribCenterX + (edge * ribWidth) / 2, ribCenterY, z]
        },
        paintTint
      );
    for (const edge of [1, -1])
      builder.add(
        paintMaterial,
        roundedBoxGeometry(diagonalLength, 0.018, 0.008, 0.003),
        {
          p: [ribCenterX, ribCenterY, z],
          r: [0, 0, edge * diagonalAngle]
        },
        paintTint
      );
  }
  // Triple handle.
  for (const z of [-0.042, 0, 0.042])
    builder.add(
      paintMaterial,
      tubeThroughPoints(
        [
          [-0.135, 0.35, z],
          [-0.125, 0.42, z],
          [-0.09, 0.44, z],
          [-0.02, 0.44, z],
          [0.01, 0.42, z],
          [0.02, 0.35, z]
        ],
        0.0105,
        5,
        false,
        0.5
      ),
      null,
      paintTint
    );
  // Spout along a tilted axis.
  const spoutBase = [0.1, 0.33, 0];
  const spoutDir = [0.42, 0.9, 0];
  const spoutPoint = (t: number) => [
    spoutBase[0] + spoutDir[0] * t,
    spoutBase[1] + spoutDir[1] * t,
    0
  ];
  builder.add(
    paintMaterial,
    cylinderBetween(spoutPoint(-0.02), spoutPoint(0.07), 0.03, 8, true),
    null,
    paintTint
  );
  builder.add(
    'steel_dark',
    cylinderBetween(spoutPoint(0.07), spoutPoint(0.1), 0.036, 8, true),
    null,
    0.9
  );
  builder.add(
    'steel_galv',
    roundedBoxGeometry(0.07, 0.008, 0.02, 0.002),
    {
      p: spoutPoint(0.108),
      r: [0, 0, -0.44]
    },
    0.8
  );
  builder.decal(game.mats.decal('hazard_flammable'), 0.055, {
    p: [0.125, 0.25, 0.0795]
  });
  builder.decal(game.mats.decal('hazard_flammable'), 0.055, {
    p: [-0.125, 0.25, -0.0795],
    r: [0, PI, 0]
  });
  return builder.finish();
}

function buildTrafficCone(game: Game, options: CargoPropOptions, variant: number): Group {
  const builder = new CargoPropBuilder(game, 'traffic_cone', variant);
  const rng = builder.rng;
  const noiseOffset = variant * 4.1;
  if (options.lying) {
    builder.push({
      p: [-0.34, 0.18, 0],
      r: [0, rng() * 6, 0]
    });
    builder.push({
      r: [0, 0, -HALF_PI + 0.16]
    });
  }
  /** Cone radius at height `y`. */
  const radiusAt = (y: number) => 0.128 + ((0.031 - 0.128) * (y - 0.05)) / (0.685 - 0.05);
  builder.add('rubber', roundedBoxGeometry(0.36, 0.03, 0.36, 0.008, 'bottom'), null, 0.9);
  const scuffTint = (x: number, y: number, z: number) => {
    const scuff = valueNoise3d(Math.atan2(z, x) * 3 + noiseOffset, y * 14);
    return scuff > 0.68 ? 0.45 : 0.85 + 0.15 * scuff;
  };
  const coneBand = (fromY: number, toY: number, before: number[][] = [], after: number[][] = []) =>
    smoothLatheGeometry([...before, [radiusAt(fromY), fromY], [radiusAt(toY), toY], ...after], 16);
  const orange = builder.mat('plastic_red', {
    color: 0xc24f1a
  });
  const reflective = builder.mat('plastic_grey', {
    color: 0xc9c9c2
  });
  builder.add(
    orange,
    coneBand(0.05, 0.36, [
      [0.165, 0.03],
      [0.15, 0.04],
      [0.136, 0.05]
    ]),
    null,
    scuffTint
  );
  builder.add(reflective, coneBand(0.36, 0.5), null, (x, y, z) => 0.85 * scuffTint(x, y, z));
  builder.add(orange, coneBand(0.5, 0.56), null, scuffTint);
  builder.add(reflective, coneBand(0.56, 0.61), null, (x, y, z) => 0.85 * scuffTint(x, y, z));
  builder.add(
    orange,
    coneBand(
      0.61,
      0.685,
      [],
      [
        [0.028, 0.696],
        [0.018, 0.7],
        [0.018, 0.7],
        [0, 0.7]
      ]
    ),
    null,
    scuffTint
  );
  if (options.lying) {
    builder.pop();
    builder.pop();
  }
  return builder.finish(
    options.lying
      ? {
          size: [0.72, 0.36, 0.36]
        }
      : {}
  );
}

function buildGasCylinderRack(game: Game, options: CargoPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'gas_cylinders', options.seed || 0);
  const rng = builder.rng;
  const segments = 12;
  const frameShade = () => rng.range(0.6, 0.9);
  builder.add('diamond_plate', roundedBoxGeometry(0.9, 0.016, 0.5, 0.004, 'bottom'), null, 0.8);
  // Rack frame.
  for (const x of [-0.43, 0.43]) {
    builder.add(
      'steel_dark',
      roundedBoxGeometry(0.04, 1.14, 0.04, 0.005),
      {
        p: [x, 0.585, -0.225]
      },
      frameShade()
    );
    builder.add(
      'steel_dark',
      roundedBoxGeometry(0.036, 0.036, 0.43, 0.005),
      {
        p: [x, 1.06, -0.01]
      },
      frameShade()
    );
    builder.add(
      'steel_dark',
      roundedBoxGeometry(0.036, 0.036, 0.43, 0.005),
      {
        p: [x, 0.3, -0.01]
      },
      frameShade()
    );
    builder.add(
      'steel_dark',
      roundedBoxGeometry(0.036, 0.32, 0.036, 0.005),
      {
        p: [x, 0.16, 0.19]
      },
      frameShade()
    );
    builder.add(
      'steel_galv',
      metricTorusGeometry(0.016, 0.004, 4, 8),
      {
        p: [x - Math.sign(x) * 0, 1.06, 0.215],
        r: [0, HALF_PI, 0]
      },
      0.8
    );
  }
  for (const y of [0.45, 1.06])
    builder.add(
      'steel_dark',
      roundedBoxGeometry(0.9, 0.04, 0.036, 0.005),
      {
        p: [0, y, -0.225]
      },
      frameShade()
    );
  builder.add(
    'paint_yellow',
    roundedBoxGeometry(0.3, 0.2, 0.004, 0.001),
    {
      p: [0, 0.76, -0.245]
    },
    0.9
  );
  builder.decal(game.mats.decal('hazard_flammable'), 0.15, {
    p: [0, 0.76, -0.2475],
    r: [0, PI, 0]
  });
  // Cylinders.
  const shoulderPaints: PaintSpec[] = [
    ['paint_red', 1],
    ['paint_white', 1],
    ['paint_blue', 1],
    ['paint_yellow', 1],
    ['paint_grey', 0.5]
  ];
  const bodyPaints: PaintSpec[] = [
    ['paint_grey', 0.75],
    ['paint_grey', 0.55],
    ['paint_red', [0.55, 0.4, 0.4]],
    ['paint_blue', 0.8]
  ];
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 0.272;
    const heightScale = 1 - rng.range(0, 0.05);
    const radius = 0.115;
    const shoulderPaint = shoulderPaints[(builder.seed + i * 2) % shoulderPaints.length];
    const bodyPaint = bodyPaints[(builder.seed + i) % bodyPaints.length];
    const noiseOffset = i * 5.3 + builder.seed;
    const yaw = rng() * 6;
    builder.push({
      p: [x, 0.016, 0.015 + rng.range(-0.01, 0.01)],
      r: [0, yaw, 0],
      s: [1, heightScale, 1]
    });
    builder.add(
      bodyPaint[0],
      smoothLatheGeometry(
        [
          [0, 0.012],
          [0.095, 0.012],
          [0.095, 0.012],
          [0.1, 0],
          [0.111, 0],
          [radius, 0.008],
          [radius, 0.4],
          [radius, 0.8],
          [radius, 1.22]
        ],
        segments
      ),
      null,
      (px, py, pz) => {
        const chip = valueNoise3d(Math.atan2(pz, px) * 3 + noiseOffset, py * 5);
        const shade = chip > 0.7 ? 0.55 : 1;
        const base =
          typeof bodyPaint[1] == 'number'
            ? [bodyPaint[1], bodyPaint[1], bodyPaint[1]]
            : bodyPaint[1];
        return [
          base[0] * shade,
          base[1] * shade * (chip > 0.7 ? 0.85 : 1),
          base[2] * shade * (chip > 0.7 ? 0.7 : 1)
        ];
      }
    );
    builder.add(
      shoulderPaint[0],
      smoothLatheGeometry(
        [
          [radius, 1.22],
          [0.111, 1.285],
          [0.098, 1.34],
          [0.075, 1.385],
          [0.052, 1.41],
          [0.04, 1.42]
        ],
        segments
      ),
      null,
      shoulderPaint[1]
    );
    builder.add(
      'steel_dark',
      smoothLatheGeometry(
        [
          [0.04, 1.42],
          [0.057, 1.42],
          [0.057, 1.42],
          [0.057, 1.448],
          [0.057, 1.448],
          [0.05, 1.452],
          [0.053, 1.53],
          [0.046, 1.565],
          [0.026, 1.585],
          [0, 1.588]
        ],
        segments
      ),
      null,
      0.8
    );
    for (const angle of [0, PI])
      builder.add(
        'polymer_black',
        worldUvCylinder(0.016, 0.016, 0.004, 6),
        {
          p: [Math.cos(angle) * 0.052, 1.5, Math.sin(angle) * 0.052],
          r: [0, -angle, HALF_PI]
        },
        0.2
      );
    if (i !== 1)
      builder.cdecal(
        game.mats.decal(i ? 'hazard_general' : 'hazard_flammable'),
        radius + 0.0015,
        0.1,
        {
          p: [0, 1.08, 0],
          r: [0, rng.range(-0.5, 0.5) - yaw, 0]
        }
      );
    builder.cdecal(
      game.mats.label(['ACETYLENE', 'OXYGEN', 'ARGON', 'PROPANE'][(builder.seed + i) % 4], {
        color: 'white',
        font: 'stencil',
        distress: 0.4
      }),
      radius + 0.0015,
      0.2,
      {
        p: [0, 0.86, 0],
        r: [0, rng.range(-0.4, 0.4) - yaw, 0]
      }
    );
    builder.pop();
  }
  // Retaining chain draped over the cylinders.
  const chainLinks = 19;
  /** Z the chain must clear at rack x (in front of any cylinder). */
  const chainClearance = (x: number) => {
    let z = 0.215;
    for (let slot = -1; slot <= 1; slot++) {
      const dx = x - slot * 0.272;
      if (Math.abs(dx) < 0.115) z = Math.max(z, 0.015 + Math.sqrt(0.123 * 0.123 - dx * dx) + 0);
    }
    return Math.max(z, 0.1);
  };
  for (let i = 0; i < chainLinks; i++) {
    const t = i / (chainLinks - 1);
    const x = -0.425 + 0.85 * t;
    const z =
      Math.max(chainClearance(x), chainClearance(x - 0.03), chainClearance(x + 0.03)) + 0.004;
    const y = 1.05 - 0.035 * Math.sin(PI * ((t * 3) % 1)) - 0.01;
    builder.add(
      'steel_galv',
      metricTorusGeometry(0.017, 0.0045, 3, 6),
      {
        p: [x, y, z],
        r: [i % 2 ? HALF_PI : 0.15, 0, 0],
        s: [1.35, 1, 1]
      },
      rng.range(0.6, 0.95)
    );
  }
  return builder.finish();
}

function buildPipeStack(game: Game, options: CargoPropOptions): Group {
  const builder = new CargoPropBuilder(game, 'pipe_stack', options.seed || 0);
  const rng = builder.rng;
  const pipeRadius = 0.1365;
  const wallThickness = 0.012;
  const dunnageHeight = 0.08;
  const radialSegments = 14;
  const woodTint = (scale = 1): number[] => {
    const shade = rng.range(0.6, 0.95) * scale;
    return [shade, shade * 0.95, shade * 0.86];
  };
  // Dunnage beams with wedge chocks.
  for (const x of [-2.2, 0, 2.2]) {
    builder.add(
      'wood_dark',
      roundedBoxGeometry(0.11, dunnageHeight, 1.2, 0.008),
      {
        p: [x + rng.range(-0.1, 0.1), dunnageHeight / 2, 0],
        r: [0, rng.range(-0.03, 0.03), 0]
      },
      woodTint()
    );
    for (const side of [1, -1])
      builder.add(
        'wood_pallet',
        extrudePolygon(
          side > 0
            ? [
                [0, 0],
                [0.158, 0],
                [0.158, 0.1]
              ]
            : [
                [-0.158, 0],
                [0, 0],
                [-0.158, 0.1]
              ],
          0.1,
          {
            soft: 0
          }
        ),
        {
          p: [x, dunnageHeight, side * 0.44],
          r: [0, -HALF_PI, 0]
        },
        woodTint(0.9)
      );
  }
  // Pipes in a 4-3-2 pyramid.
  const rowCounts = [4, 3, 2];
  const rowSpacing = 2 * pipeRadius * Math.sin(PI / 3);
  rowCounts.forEach((pipesInRow, row) => {
    for (let i = 0; i < pipesInRow; i++) {
      const z = (i - (pipesInRow - 1) / 2) * 2 * pipeRadius;
      const y = dunnageHeight + pipeRadius + row * rowSpacing;
      const length = rng.range(5.78, 5.92);
      const startX = rng.range(-3, 3 - length) * 0.999 + 0;
      const centerX = Math.max(-3, Math.min(3 - length, startX)) + length / 2;
      const material = rng() < 0.7 ? 'steel_rust' : 'steel_dark';
      const noiseOffset = rng() * 50;
      const shade = rng.range(0.75, 1);
      const outer = new THREE.CylinderGeometry(
        pipeRadius,
        pipeRadius,
        length,
        radialSegments,
        4,
        true
      );
      {
        const uv = outer.attributes.uv;
        const position = outer.attributes.position;
        for (let j = 0; j < uv.count; j++)
          uv.setXY(j, uv.getX(j) * 2 * PI * pipeRadius, position.getY(j));
      }
      const transform = {
        p: [centerX, y, z],
        r: [rng() * 6, 0, HALF_PI]
      };
      builder.add(
        material,
        outer,
        transform,
        (px, py, pz) => shade * (0.75 + 0.35 * valueNoise3d(px * 1.3 + noiseOffset, pz * 9, py * 9))
      );
      const inner = flipGeometry(
        worldUvCylinder(
          pipeRadius - wallThickness,
          pipeRadius - wallThickness,
          length - 0.002,
          radialSegments,
          true
        )
      );
      // Bore darkens towards the middle of the pipe.
      builder.add(
        'steel_rust',
        inner,
        transform,
        (px) =>
          0.16 +
          0.5 *
            smoothstepCargo(
              length / 2 + Math.abs(centerX) - 0.9,
              length / 2 + Math.abs(centerX) + 0.2,
              Math.abs(px - centerX) + Math.abs(centerX)
            )
      );
      for (const end of [1, -1])
        builder.add(
          material,
          smoothLatheGeometry(
            end > 0
              ? [
                  [pipeRadius, 0],
                  [pipeRadius - wallThickness, 0]
                ]
              : [
                  [pipeRadius - wallThickness, 0],
                  [pipeRadius, 0]
                ],
            radialSegments
          ),
          {
            p: [centerX + (end * length) / 2, y, z],
            r: [0, 0, -HALF_PI]
          },
          shade * 1.1
        );
    }
  });
  // Steel strapping bands around the pyramid.
  for (const x of [-1.35, 1.5]) {
    const pitch = 2 * pipeRadius;
    const topY = dunnageHeight + pipeRadius + 2 * rowSpacing + pipeRadius + 0.004;
    const band: number[][] = [];
    const outline = [
      [-(1.5 * pitch + pipeRadius + 0.004), dunnageHeight + pipeRadius],
      [
        -(0.5 * pitch + pipeRadius * 0.5 + 0.004),
        dunnageHeight + pipeRadius + 2 * rowSpacing + pipeRadius * 0.87
      ],
      [-0.5 * pitch, topY],
      [0.5 * pitch, topY],
      [
        0.5 * pitch + pipeRadius * 0.5 + 0.004,
        dunnageHeight + pipeRadius + 2 * rowSpacing + pipeRadius * 0.87
      ],
      [1.5 * pitch + pipeRadius + 0.004, dunnageHeight + pipeRadius],
      [1.5 * pitch, dunnageHeight - 0.004],
      [-1.5 * pitch, dunnageHeight - 0.004],
      [-(1.5 * pitch + pipeRadius + 0.004), dunnageHeight + pipeRadius]
    ];
    for (const point of outline) band.push([x, point[1], point[0]]);
    builder.add('steel_dark', ribbonGeometry(band, [0.016, 0, 0]), null, 0.7);
    builder.add(
      'steel_galv',
      roundedBoxGeometry(0.04, 0.012, 0.05, 0.003),
      {
        p: [x, topY + 0.005, 0.03]
      },
      0.8
    );
  }
  builder.cdecal(
    game.mats.label('API 5L X52  273.1 x 12.5  HEAT 40719', {
      color: 'white',
      font: 'stencil',
      distress: 0.5
    }),
    pipeRadius + 0.002,
    0.2,
    {
      p: [0.9, dunnageHeight + pipeRadius + 2 * rowSpacing, pipeRadius],
      r: [-HALF_PI + 0.9, 0, HALF_PI]
    },
    1.6
  );
  return builder.finish();
}

/** Registers the cargo prop builders (barrels, cones and jerry cans are cached per variant). */
export function registerCargoProps(
  register: (name: string, builder: CargoPropBuilderFn) => void
): void {
  register('barrel', (game, options = {}) => {
    const variant = Math.abs((options.seed ?? 0) | 0) % 4;
    return cloneCachedProp(
      `barrel|${options.color}|${!!options.lying}|${!!options.open}|${variant}`,
      () => buildBarrel(game, options, variant)
    );
  });
  register('pallet', (game, options = {}) => {
    const variant = Math.abs((options.seed ?? 0) | 0) % 4;
    return cloneCachedProp(`pallet|${!!options.broken}|${variant}`, () =>
      buildPallet(game, options, variant)
    );
  });
  register('pallet_stack', (game, options = {}) => buildPalletStack(game, options));
  register('crate_wood', (game, options = {}) => buildWoodCrate(game, options));
  register('crate_stack', (game, options = {}) => buildCrateStack(game, options));
  register('ibc_tote', (game, options = {}) => buildIbcTote(game, options));
  register('cable_reel', (game, options = {}) => buildCableReel(game, options));
  register('tire_stack', (game, options = {}) => buildTireStack(game, options));
  register('jerry_can', (game, options = {}) => {
    const variant = Math.abs((options.seed ?? 0) | 0) % 2;
    return cloneCachedProp(`jerry|${options.color}|${variant}`, () =>
      buildJerryCan(game, options, variant)
    );
  });
  register('traffic_cone', (game, options = {}) => {
    const variant = Math.abs((options.seed ?? 0) | 0) % 3;
    return cloneCachedProp(`cone|${!!options.lying}|${variant}`, () =>
      buildTrafficCone(game, options, variant)
    );
  });
  register('gas_cylinders', (game, options = {}) => buildGasCylinderRack(game, options));
  register('pipe_stack', (game, options = {}) => buildPipeStack(game, options));
}
