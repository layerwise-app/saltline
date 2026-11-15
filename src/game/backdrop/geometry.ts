// Shared geometry helpers for the harbour backdrop: value noise, weathered vertex colours,
// a per-material geometry batcher, primitive builders (boxes, rods, beams, sag curves,
// railings) and a batched blinking-light mesh driven by a shared `uTime` uniform.
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3
} from 'three';
import type { IUniform, Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  mergeGeometryList,
  roundedBox,
  setVertexColors,
  worldUvBox,
  worldUvCylinder
} from '../render/geometry';
import type { Game } from '../core/types';

/** A point given either as a `Vector3` or as an `[x, y, z]` array. */
export type Vec3Input = Vector3 | readonly number[];
/** An RGB triple (linear multipliers, usually 0..1+). */
export type Rgb = readonly number[];
/** Cylinder/axis orientation used by `cylinderAt`. */
export type Axis = 'x' | 'y' | 'z';
/** Axis-aligned collision box contributed by a backdrop piece (registered with physics). */
export interface BackdropCollider {
  min: number[];
  max: number[];
  bulletOnly?: boolean;
  noNav?: boolean;
}

/** Shorthand `new Vector3(x, y, z)`. */
export const v3 = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
/** Returns the input if it is already a `Vector3`, otherwise builds one from `[x, y, z]`. */
export const toVec3 = (point: Vec3Input): Vector3 =>
  (point as Partial<Vector3>).isVector3
    ? (point as Vector3)
    : new Vector3(
        (point as readonly number[])[0],
        (point as readonly number[])[1],
        (point as readonly number[])[2]
      );
export const UP_AXIS = new Vector3(0, 1, 0);
export const UNIT_SCALE = new Vector3(1, 1, 1);
export const tmpQuat = new Quaternion();
export const tmpMatrix = new Matrix4();

function hashLattice3(x: number, y: number, z: number): number {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967295;
}

/** Smooth 3D value noise in [0, 1]. */
export function valueNoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  let fx = x - ix;
  let fy = y - iy;
  let fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  return lerp(
    lerp(
      lerp(hashLattice3(ix, iy, iz), hashLattice3(ix + 1, iy, iz), fx),
      lerp(hashLattice3(ix, iy + 1, iz), hashLattice3(ix + 1, iy + 1, iz), fx),
      fy
    ),
    lerp(
      lerp(hashLattice3(ix, iy, iz + 1), hashLattice3(ix + 1, iy, iz + 1), fx),
      lerp(hashLattice3(ix, iy + 1, iz + 1), hashLattice3(ix + 1, iy + 1, iz + 1), fx),
      fy
    ),
    fz
  );
}

/** Deterministic linear congruential generator returning floats in [0, 1). */
export function createLcgRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const scratchWeatherRgb: number[] = [1, 1, 1];
const NEUTRAL_TINT: Rgb = [1, 1, 1];

/**
 * Grime/rust vertex colour at world position (x, y, z), multiplied by `tint`.
 * Returns a shared scratch array (copy it if you need to keep it).
 */
export function weatheredVertexColor(
  x: number,
  y: number,
  z: number,
  tint: Rgb = NEUTRAL_TINT,
  strength = 1
): number[] {
  const grime = valueNoise3(x * 0.31 + 11.3, y * 0.23 + 5.1, z * 0.31 + 3.7);
  const rustMask = valueNoise3(x * 1.7 + 40.2, 9.5, z * 1.7 + 17.9);
  const shade = 1 - strength * (0.3 - 0.36 * grime);
  let r = tint[0] * shade;
  let g = tint[1] * shade;
  let b = tint[2] * shade;
  if (rustMask > 0.68) {
    const rust =
      Math.min(1, (rustMask - 0.68) / 0.3) *
      0.6 *
      strength *
      (0.35 + 0.65 * valueNoise3(x * 0.9, y * 0.45, z * 0.9));
    r *= 1 + 0.45 * rust;
    g *= 1 - 0.3 * rust;
    b *= 1 - 0.6 * rust;
  }
  scratchWeatherRgb[0] = r;
  scratchWeatherRgb[1] = g;
  scratchWeatherRgb[2] = b;
  return scratchWeatherRgb;
}

const weatheredMaterials = new WeakSet<Material>();

/**
 * Fetches a library material with vertex colours enabled and marks it as "weathered", so the
 * `MaterialBatcher` paints weathered vertex colours onto geometry added with it.
 */
export function weatheredMaterial(
  game: Game,
  name: string,
  options: Record<string, unknown> = {}
): Material {
  const material: Material = game.mats.get(name, {
    vertexColors: true,
    ...options
  });
  weatheredMaterials.add(material);
  return material;
}

interface MaterialBucket {
  mat: Material;
  geos: BufferGeometry[];
  minor?: boolean;
}

/** Remaps a material (and tint) to another, e.g. for low-detail proxies; null drops the geometry. */
export type MaterialRemap = (material: Material, tint: Rgb | undefined) => [Material, Rgb] | null;

/** Geometry accepted by `MaterialBatcher.add`; null entries (degenerate rods) are skipped. */
export type BatchGeometry = BufferGeometry | null | undefined | (BufferGeometry | null)[];

/** Collects geometry per material and merges each group into one mesh on `build()`. */
export class MaterialBatcher {
  buckets: Map<string, MaterialBucket>;
  tris: number;
  remap: MaterialRemap | null;
  dz: number;
  minSize: number;
  /**
   * When set, geometry smaller than this (largest extent, in metres) goes into separate
   * "minor detail" meshes (`userData.detail = 'minor'`) that low quality hides.
   */
  minorSize: number;

  constructor() {
    this.buckets = new Map();
    this.tris = 0;
    this.remap = null;
    this.dz = 0;
    this.minSize = 0;
    this.minorSize = 0;
  }

  add(material: Material, geometry: BatchGeometry, tint?: Rgb): void {
    if (!geometry) return;
    if (Array.isArray(geometry)) {
      for (const part of geometry) this.add(material, part, tint);
      return;
    }
    if (this.remap) {
      const remapped = this.remap(material, tint);
      if (!remapped) return;
      if (this.minSize) {
        geometry.computeBoundingBox();
        const box = geometry.boundingBox!;
        if (
          Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) <
          this.minSize
        )
          return;
      }
      material = remapped[0];
      tint = remapped[1];
      if (this.dz) geometry.translate(0, 0, this.dz);
    }
    if (weatheredMaterials.has(material) && !geometry.attributes.color) {
      setVertexColors(geometry, (x: number, y: number, z: number) =>
        weatheredVertexColor(x, y, z, tint || NEUTRAL_TINT)
      );
    }
    let minor = false;
    if (this.minorSize) {
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      minor =
        Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) <
        this.minorSize;
    }
    const key = minor ? material.uuid + ':minor' : material.uuid;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        mat: material,
        geos: [],
        minor
      };
      this.buckets.set(key, bucket);
    }
    bucket.geos.push(geometry);
    this.tris += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
  }

  build({ cast = true, recv = true }: { cast?: boolean; recv?: boolean } = {}): Group {
    const group = new Group();
    for (const bucket of this.buckets.values()) {
      const merged = mergeGeometryList(bucket.geos);
      const mesh = new Mesh(merged, bucket.mat);
      const unlit =
        (bucket.mat as Partial<MeshBasicMaterial>).isMeshBasicMaterial || bucket.mat.transparent;
      mesh.castShadow = cast && !unlit;
      mesh.receiveShadow = recv && !unlit;
      if (bucket.minor) mesh.userData.detail = 'minor';
      group.add(mesh);
    }
    this.buckets.clear();
    return group;
  }
}

/** Axis-aligned box spanning two corners (optionally with rounded edges). */
export function boxBetween(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  bevel = 0
): BufferGeometry {
  const sizeX = Math.abs(x1 - x0);
  const sizeY = Math.abs(y1 - y0);
  const sizeZ = Math.abs(z1 - z0);
  const box: BufferGeometry =
    bevel > 0 ? roundedBox(sizeX, sizeY, sizeZ, bevel) : worldUvBox(sizeX, sizeY, sizeZ);
  box.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return box;
}

/** Cylinder oriented along `axis` and centred at (x, y, z). */
export function cylinderAt(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  axis: Axis,
  x: number,
  y: number,
  z: number,
  segments = 12,
  openEnded = false
): BufferGeometry {
  const cylinder: BufferGeometry = worldUvCylinder(
    radiusTop,
    radiusBottom,
    height,
    segments,
    openEnded
  );
  if (axis === 'x') cylinder.rotateZ(Math.PI / 2);
  else if (axis === 'z') cylinder.rotateX(Math.PI / 2);
  cylinder.translate(x, y, z);
  return cylinder;
}

/** Round rod from `start` to `end`; null when the two points coincide. */
export function rodBetween(
  start: Vec3Input,
  end: Vec3Input,
  radius = 0.03,
  segments = 5,
  capped = false
): BufferGeometry | null {
  const from = toVec3(start);
  const to = toVec3(end);
  const dir = new Vector3().subVectors(to, from);
  const length = dir.length();
  if (length < 1e-5) return null;
  const rod: BufferGeometry = worldUvCylinder(radius, radius, length, segments, !capped);
  tmpQuat.setFromUnitVectors(UP_AXIS, dir.multiplyScalar(1 / length));
  tmpMatrix.compose(new Vector3().addVectors(from, to).multiplyScalar(0.5), tmpQuat, UNIT_SCALE);
  rod.applyMatrix4(tmpMatrix);
  return rod;
}

/** Rectangular beam (width x depth cross-section) from `start` to `end`. */
export function beamBetween(
  start: Vec3Input,
  end: Vec3Input,
  width = 0.3,
  depth = 0.3,
  bevel = 0
): BufferGeometry {
  const from = toVec3(start);
  const to = toVec3(end);
  const dir = new Vector3().subVectors(to, from);
  const length = dir.length();
  dir.multiplyScalar(1 / length);
  const side = new Vector3().crossVectors(dir, UP_AXIS);
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  else side.normalize();
  const normal = new Vector3().crossVectors(side, dir);
  const beam: BufferGeometry =
    bevel > 0 ? roundedBox(width, length, depth, bevel) : worldUvBox(width, length, depth);
  tmpMatrix
    .makeBasis(side, dir, normal)
    .setPosition((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  beam.applyMatrix4(tmpMatrix);
  return beam;
}

/** Rods joining consecutive points of a polyline. */
export function polylineRods(
  points: readonly Vec3Input[],
  radius = 0.03,
  segments = 5
): BufferGeometry[] {
  const rods: BufferGeometry[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const rod = rodBetween(points[i], points[i + 1], radius, segments);
    if (rod) rods.push(rod);
  }
  return rods;
}

/** Points along a straight segment sagging parabolically by `sag` at its middle (cables, ropes). */
export function sagCurvePoints(start: Vec3Input, end: Vec3Input, sag = 1, steps = 10): Vector3[] {
  const from = toVec3(start);
  const to = toVec3(end);
  const points: Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const point = new Vector3().lerpVectors(from, to, t);
    point.y -= sag * 4 * t * (1 - t);
    points.push(point);
  }
  return points;
}

/** Plane rotated by `rotX` then `rotY` and moved to (x, y, z). */
export function planeAt(
  width: number,
  height: number,
  x: number,
  y: number,
  z: number,
  rotY = 0,
  rotX = 0
): PlaneGeometry {
  const plane = new PlaneGeometry(width, height);
  if (rotX) plane.rotateX(rotX);
  if (rotY) plane.rotateY(rotY);
  plane.translate(x, y, z);
  return plane;
}

/** Options for `railingAlong`. */
export interface RailingOptions {
  /** Rail height. */
  h?: number;
  /** Target post spacing. */
  post?: number;
  /** Rod radius. */
  r?: number;
  tint?: Rgb;
  /** Whether to add a mid-height rail. */
  mid?: boolean;
}

/** Anything with a `MaterialBatcher`-like `add` (the skyline passes a shading adapter). */
export interface GeometrySink<M> {
  add(material: M, geometry: BufferGeometry | null, tint?: Rgb): void;
}

/** Adds posts plus top (and optional mid) rails along a polyline to `batcher`. */
export function railingAlong<M>(
  batcher: GeometrySink<M>,
  material: M,
  path: readonly Vec3Input[],
  {
    h: height = 1.1,
    post: postSpacing = 2.2,
    r: radius = 0.022,
    tint,
    mid = true
  }: RailingOptions = {}
): void {
  const points = path.map(toVec3);
  for (let seg = 0; seg < points.length - 1; seg++) {
    const a = points[seg];
    const b = points[seg + 1];
    const length = a.distanceTo(b);
    const postCount = Math.max(1, Math.round(length / postSpacing));
    for (let k = seg === 0 ? 0 : 1; k <= postCount; k++) {
      const base = new Vector3().lerpVectors(a, b, k / postCount);
      batcher.add(material, rodBetween(base, v3(base.x, base.y + height, base.z), radius, 4), tint);
    }
    batcher.add(
      material,
      rodBetween(v3(a.x, a.y + height, a.z), v3(b.x, b.y + height, b.z), radius * 1.15, 5),
      tint
    );
    if (mid) {
      batcher.add(
        material,
        rodBetween(
          v3(a.x, a.y + height * 0.5, a.z),
          v3(b.x, b.y + height * 0.5, b.z),
          radius * 0.9,
          4
        ),
        tint
      );
    }
  }
}

/** Batched unlit "nav light" geometry that blinks on the GPU via a shared time uniform. */
export interface BlinkLightBatch {
  uTime: IUniform<number>;
  mat: MeshBasicMaterial;
  /**
   * Adds a light. `period` <= 0 means steady; otherwise the light is on for the `duty`
   * fraction of each `period` seconds, offset by `phase` (fraction of a period).
   */
  add(
    geometry: BufferGeometry | null | undefined,
    color: Rgb,
    period?: number,
    phase?: number,
    duty?: number
  ): void;
  /** Merges everything added so far into one mesh, or null if nothing was added. */
  build(): Mesh | null;
}

/** Creates an empty blink-light batch. */
export function createBlinkLightBatch(): BlinkLightBatch {
  const uTime: IUniform<number> = {
    value: 0
  };
  const material = new MeshBasicMaterial({
    vertexColors: true,
    fog: false
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader =
      `attribute vec3 blink;
uniform float uTime;
varying float vBlink;
` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
 float bph = fract(uTime / max(blink.x, 0.001) + blink.y);
 vBlink = blink.x <= 0.0 ? 1.0 : mix(0.02, 1.0, smoothstep(0.0, 0.06, bph) * (1.0 - smoothstep(blink.z, blink.z + 0.12, bph)));`
      );
    shader.fragmentShader =
      `varying float vBlink;
` +
      shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
 diffuseColor.rgb *= vBlink;`
      );
  };
  material.customProgramCacheKey = () => 'saltline-blink';
  const pending: BufferGeometry[] = [];
  return {
    uTime,
    mat: material,
    add(geometry, color, period = 0, phase = 0, duty = 0.5) {
      if (!geometry) return;
      const flat = geometry.index ? geometry.toNonIndexed() : geometry;
      const count = flat.attributes.position.count;
      const colors = new Float32Array(count * 3);
      const blink = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colors[i * 3] = color[0];
        colors[i * 3 + 1] = color[1];
        colors[i * 3 + 2] = color[2];
        blink[i * 3] = period;
        blink[i * 3 + 1] = phase;
        blink[i * 3 + 2] = duty;
      }
      const light = new BufferGeometry();
      light.setAttribute('position', flat.attributes.position);
      light.setAttribute('color', new BufferAttribute(colors, 3));
      light.setAttribute('blink', new BufferAttribute(blink, 3));
      pending.push(light);
    },
    build() {
      if (!pending.length) return null;
      const mesh = new Mesh(mergeGeometries(pending.splice(0), false), material);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      return mesh;
    }
  };
}
