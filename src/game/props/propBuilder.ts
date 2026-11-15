// PropBuilder: accumulates primitive geometries per material (with an optional transform
// stack and per-material default vertex colours) and merges them into one mesh per
// material. Also: prop finalisation and cached label / decal lookups.
import { Group, Matrix4, Mesh, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Material, Object3D } from 'three';
import type { Game } from '../core/types';
import {
  mergeGeometryList,
  setVertexColors,
  tubeThroughPoints,
  worldUvBox,
  worldUvCylinder
} from '../render/geometry';
import type { VertexColorSource } from '../render/geometry';
import {
  UNIT_SCALE,
  chamferedBoxGeometry,
  flatShadedGeometry,
  simplePlaneGeometry,
  transformGeometry
} from './propGeometry';
import type { NumArray } from './propGeometry';

/**
 * Bucket key: a real material, or a placeholder object (e.g. `{ body: true }`) that is
 * swapped for a material later via the `materialMap` of {@link meshGroupFromParts}.
 */
export type MaterialKey = Material | Record<string, unknown>;

/** Geometries collected for one material. */
export interface GeometryBucket {
  mat: MaterialKey;
  geos: BufferGeometry[];
  cast: boolean;
}

/** One merged mesh part produced by {@link PropBuilder.parts}. */
export interface PropPart {
  mat: MaterialKey;
  geo: BufferGeometry;
  cast: boolean;
}

/** A decal / label material with its width-to-height aspect ratio. */
export interface DecalInfo {
  material: Material;
  aspect: number;
}

/** Axis-aligned collider in a prop's local space (`userData.colliders`). */
export interface PropCollider {
  min: number[];
  max: number[];
  surface?: string;
  /** Only stops bullets. */
  bulletOnly?: boolean;
}

/** Common options of the PropBuilder primitives. */
export interface BoxOptions {
  /** Chamfer radius; 0 = sharp world-uv box. */
  r?: number;
  rot?: NumArray | null;
  col?: VertexColorSource | null;
}
export interface CylinderOptions {
  seg?: number;
  open?: boolean;
  flat?: boolean;
  rot?: NumArray | null;
  col?: VertexColorSource | null;
}
export interface TubeOptions {
  seg?: number;
  tension?: number;
  col?: VertexColorSource | null;
}
export interface BarOptions {
  /** Radius at the start point (defaults to the end radius). */
  r2?: number;
  seg?: number;
  caps?: boolean;
  col?: VertexColorSource | null;
}
export interface BeamOptions {
  r?: number;
  twist?: number;
  col?: VertexColorSource | null;
}

type MaterialOptions = Parameters<Game['mats']['get']>[1];

/** Collects geometry per material and merges it into a prop group. */
export class PropBuilder {
  G: Game;
  buckets: Map<MaterialKey, GeometryBucket>;
  stack: (Matrix4 | null)[];
  /** Current transform (null = identity). */
  m: Matrix4 | null;
  /** Default vertex colour per material. */
  defCol: Map<MaterialKey, VertexColorSource>;
  constructor(game: Game) {
    this.G = game;
    this.buckets = new Map();
    this.stack = [];
    this.m = null;
    this.defCol = new Map();
  }
  /** Material lookup shortcut. */
  M(name: string, options?: MaterialOptions): Material {
    return this.G.mats.get(name, options);
  }
  /** Push `matrix` onto the transform stack (post-multiplied with the current one). */
  push(matrix: Matrix4): this {
    this.stack.push(this.m);
    this.m = this.m ? this.m.clone().multiply(matrix) : matrix.clone();
    return this;
  }
  pop(): this {
    this.m = this.stack.pop() ?? null;
    return this;
  }
  /** Add a geometry (transformed by the current matrix) to the bucket for `mat`. */
  add<T extends BufferGeometry>(
    mat: MaterialKey,
    geometry: T,
    color?: VertexColorSource | null,
    noShadow?: boolean
  ): T {
    if (this.m) geometry.applyMatrix4(this.m);
    const vertexColor = color || this.defCol.get(mat);
    if (vertexColor) setVertexColors(geometry, vertexColor);
    let bucket = this.buckets.get(mat);
    if (!bucket) {
      bucket = {
        mat,
        geos: [],
        cast: !noShadow
      };
      this.buckets.set(mat, bucket);
    }
    bucket.geos.push(geometry);
    return geometry;
  }
  /** Box of size (w, h, d) centred at (x, y, z). */
  box(
    mat: MaterialKey,
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    options: BoxOptions = {}
  ): BufferGeometry {
    return this.add(
      mat,
      transformGeometry(
        options.r === 0
          ? worldUvBox(width, height, depth)
          : chamferedBoxGeometry(
              width,
              height,
              depth,
              options.r || Math.min(0.012, Math.min(width, height, depth) * 0.25)
            ),
        x,
        y,
        z,
        options.rot
      ),
      options.col
    );
  }
  /** Vertical cylinder (radiusTop, radiusBottom, height) centred at (x, y, z). */
  cyl(
    mat: MaterialKey,
    radiusTop: number,
    radiusBottom: number,
    height: number,
    x: number,
    y: number,
    z: number,
    options: CylinderOptions = {}
  ): BufferGeometry {
    let geometry: BufferGeometry = worldUvCylinder(
      radiusTop,
      radiusBottom,
      height,
      options.seg || 12,
      !!options.open
    );
    if (options.flat) geometry = flatShadedGeometry(geometry);
    return this.add(mat, transformGeometry(geometry, x, y, z, options.rot), options.col);
  }
  /** Tube of `radius` through `points`. */
  tube(
    mat: MaterialKey,
    points: Parameters<typeof tubeThroughPoints>[0],
    radius: number,
    options: TubeOptions = {}
  ): BufferGeometry {
    return this.add(
      mat,
      tubeThroughPoints(
        points,
        radius,
        options.seg || 6,
        false,
        options.tension === undefined ? 0.5 : options.tension
      ),
      options.col
    );
  }
  /** Round bar from `from` to `to`. */
  bar(
    mat: MaterialKey,
    from: NumArray,
    to: NumArray,
    radius: number,
    options: BarOptions = {}
  ): BufferGeometry {
    const dir = new Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const length = dir.length();
    const geometry = worldUvCylinder(
      options.r2 === undefined ? radius : options.r2,
      radius,
      length,
      options.seg || 6,
      !options.caps
    );
    const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
    geometry.applyMatrix4(
      new Matrix4().compose(
        new Vector3((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2),
        rotation,
        UNIT_SCALE
      )
    );
    return this.add(mat, geometry, options.col);
  }
  /** Rectangular beam (width x depth cross-section) from `from` to `to`. */
  beam(
    mat: MaterialKey,
    from: NumArray,
    to: NumArray,
    width: number,
    depth: number,
    options: BeamOptions = {}
  ): BufferGeometry {
    const dir = new Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const length = dir.length();
    const geometry =
      options.r === 0
        ? worldUvBox(width, length, depth)
        : chamferedBoxGeometry(width, length, depth, options.r || Math.min(width, depth) * 0.2);
    const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
    if (options.twist) {
      rotation.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), options.twist));
    }
    geometry.applyMatrix4(
      new Matrix4().compose(
        new Vector3((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2),
        rotation,
        UNIT_SCALE
      )
    );
    return this.add(mat, geometry, options.col);
  }
  /** Decal quad `height` tall (width from the aspect unless given) at (x, y, z); casts no shadow. */
  decal(
    decal: DecalInfo,
    height: number,
    x: number,
    y: number,
    z: number,
    rotation?: NumArray | null,
    width?: number
  ): BufferGeometry {
    return this.add(
      decal.material,
      transformGeometry(
        simplePlaneGeometry(width || height * decal.aspect, height),
        x,
        y,
        z,
        rotation
      ),
      null,
      true
    );
  }
  /** Merge each material's geometries. */
  parts(): PropPart[] {
    const parts: PropPart[] = [];
    for (const bucket of this.buckets.values())
      parts.push({
        mat: bucket.mat,
        geo: mergeGeometryList(bucket.geos),
        cast: bucket.cast
      });
    return parts;
  }
  /** Merged parts as a group of meshes (materials optionally swapped via `materialMap`). */
  group(materialMap?: Map<MaterialKey, Material> | null): Group {
    return meshGroupFromParts(this.parts(), materialMap);
  }
}

/** One shadow-receiving mesh per part; `materialMap` can swap materials. */
export function meshGroupFromParts(
  parts: PropPart[],
  materialMap?: Map<MaterialKey, Material> | null
): Group {
  const group = new Group();
  for (const part of parts) {
    // Placeholder keys are expected to be mapped; unmapped ones are passed through as-is.
    const mesh = new Mesh(
      part.geo,
      (materialMap && materialMap.get(part.mat)) || (part.mat as Material)
    );
    mesh.castShadow = part.cast;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Store size / colliders on a prop's userData and name it; returns the prop. */
export function finalizeProp<T extends Object3D>(
  prop: T,
  name: string,
  size: NumArray,
  colliders: PropCollider[]
): T {
  prop.userData.size = size;
  prop.userData.colliders = colliders;
  prop.name = name;
  return prop;
}

const labelDecalCache = new WeakMap<object, Map<string, DecalInfo>>();

type LabelOptions = Parameters<Game['mats']['label']>[1];

/** Cached text-label decal (falls back to plain white paint if label rendering fails). */
export function labelDecal(game: Game, text: string, options?: LabelOptions | null): DecalInfo {
  let cache = labelDecalCache.get(game.mats);
  if (!cache) {
    cache = new Map();
    labelDecalCache.set(game.mats, cache);
  }
  const key = 'L|' + text + '|' + JSON.stringify(options || {});
  if (!cache.has(key)) {
    let label: DecalInfo | null;
    try {
      label = game.mats.label(text, options || {});
    } catch {
      label = null;
    }
    cache.set(
      key,
      label && label.material
        ? label
        : {
            material: game.mats.get('paint_white'),
            aspect: Math.max(1, text.length * 0.6)
          }
    );
  }
  return cache.get(key) as DecalInfo;
}

/** Cached named decal (falls back to plain white paint if unavailable). */
export function namedDecal(game: Game, name: string): DecalInfo {
  let cache = labelDecalCache.get(game.mats);
  if (!cache) {
    cache = new Map();
    labelDecalCache.set(game.mats, cache);
  }
  const key = 'D|' + name;
  if (!cache.has(key)) {
    let decal: DecalInfo | null;
    try {
      decal = game.mats.decal(name);
    } catch {
      decal = null;
    }
    cache.set(
      key,
      decal && decal.material
        ? decal
        : {
            material: game.mats.get('paint_white'),
            aspect: 1
          }
    );
  }
  return cache.get(key) as DecalInfo;
}
