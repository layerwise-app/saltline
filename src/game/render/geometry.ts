/**
 * Geometry helpers: boxes/cylinders/tubes with world-scale UVs, transforms,
 * vertex colours, and merging of static meshes into few draw calls.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Euler,
  Group,
  Material,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  TubeGeometry,
  Vector3
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Where a generated shape sits: centred on the origin, or standing on y = 0. */
export type GeometryAnchor = 'center' | 'bottom';
/** An `[x, y, z]` triple. */
export type Vec3Tuple = readonly [number, number, number] | readonly number[];

const tmpBevelDir = new Vector3();

/** Box whose UVs are in metres (planar-projected per face), so textures tile at world scale. */
export function worldUvBox(
  width: number,
  height: number,
  depth: number,
  anchor: GeometryAnchor = 'center'
): BoxGeometry {
  const geometry = new BoxGeometry(width, height, depth);
  const uv = geometry.attributes.uv;
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    const nx = Math.abs(normal.getX(i));
    const ny = Math.abs(normal.getY(i));
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    if (nx > 0.5) uv.setXY(i, z, y);
    else if (ny > 0.5) uv.setXY(i, x, z);
    else uv.setXY(i, x, y);
  }
  if (anchor === 'bottom') geometry.translate(0, height / 2, 0);
  return geometry;
}

/** Box with bevelled (rounded) edges of the given radius and world-scale UVs. */
export function roundedBox(
  width: number,
  height: number,
  depth: number,
  radius = 0.02,
  anchor: GeometryAnchor = 'center'
): BoxGeometry {
  radius = Math.min(radius, width / 2 - 1e-4, height / 2 - 1e-4, depth / 2 - 1e-4);
  const geometry = new BoxGeometry(width, height, depth, 3, 3, 3);
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const halfW = width / 2;
  const halfH = height / 2;
  const halfD = depth / 2;
  // Pull the inner grid lines of the 3x3x3 box in to (half - radius); keep faces on the surface.
  const snap = (coord: number, half: number) => {
    const abs = Math.abs(coord);
    const sign = Math.sign(coord);
    return abs > half - 1e-5 ? sign * half : sign * (half - radius);
  };
  for (let i = 0; i < position.count; i++) {
    let x = snap(position.getX(i), halfW);
    let y = snap(position.getY(i), halfH);
    let z = snap(position.getZ(i), halfD);
    const coreX = Math.max(-(halfW - radius), Math.min(halfW - radius, x));
    const coreY = Math.max(-(halfH - radius), Math.min(halfH - radius, y));
    const coreZ = Math.max(-(halfD - radius), Math.min(halfD - radius, z));
    tmpBevelDir.set(x - coreX, y - coreY, z - coreZ);
    if (tmpBevelDir.lengthSq() > 1e-10) {
      tmpBevelDir.normalize();
      const nx = normal.getX(i);
      const ny = normal.getY(i);
      const nz = normal.getZ(i);
      const surfaceAxes =
        (Math.abs(x) > halfW - 1e-5 ? 1 : 0) +
        (Math.abs(y) > halfH - 1e-5 ? 1 : 0) +
        (Math.abs(z) > halfD - 1e-5 ? 1 : 0);
      if (surfaceAxes >= 2) {
        // edge / corner vertex: project onto the rounding sphere
        x = coreX + tmpBevelDir.x * radius;
        y = coreY + tmpBevelDir.y * radius;
        z = coreZ + tmpBevelDir.z * radius;
        normal.setXYZ(i, tmpBevelDir.x, tmpBevelDir.y, tmpBevelDir.z);
      } else normal.setXYZ(i, nx, ny, nz);
    }
    position.setXYZ(i, x, y, z);
    const ax = Math.abs(normal.getX(i));
    const ay = Math.abs(normal.getY(i));
    const az = Math.abs(normal.getZ(i));
    if (ax >= ay && ax >= az) uv.setXY(i, z, y);
    else if (ay >= ax && ay >= az) uv.setXY(i, x, z);
    else uv.setXY(i, x, y);
  }
  if (anchor === 'bottom') geometry.translate(0, height / 2, 0);
  return geometry;
}

/** Cylinder with world-scale UVs (caps planar, side unrolled by circumference). */
export function worldUvCylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments = 16,
  openEnded = false,
  anchor: GeometryAnchor = 'center'
): CylinderGeometry {
  const geometry = new CylinderGeometry(
    radiusTop,
    radiusBottom,
    height,
    radialSegments,
    1,
    openEnded
  );
  const uv = geometry.attributes.uv;
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const circumference = Math.PI * (radiusTop + radiusBottom);
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(normal.getY(i)) > 0.9) uv.setXY(i, position.getX(i), position.getZ(i));
    else uv.setXY(i, uv.getX(i) * circumference, position.getY(i));
  }
  if (anchor === 'bottom') geometry.translate(0, height / 2, 0);
  return geometry;
}

const isVector3 = (point: Vector3 | Vec3Tuple): point is Vector3 =>
  !!(point as Partial<Vector3>).isVector3;

/** Tube along a Catmull-Rom curve through `points`, with UVs in metres. */
export function tubeThroughPoints(
  points: ReadonlyArray<Vector3 | Vec3Tuple>,
  radius = 0.03,
  radialSegments = 8,
  closed = false,
  tension = 0
): TubeGeometry {
  const vectors = points.map((point) =>
    isVector3(point) ? point : new Vector3(point[0], point[1], point[2])
  );
  const curve = new CatmullRomCurve3(vectors, closed, 'catmullrom', tension);
  const length = curve.getLength();
  const segments = Math.max(2, Math.ceil(length / Math.max(0.08, radius * 3)));
  const geometry = new TubeGeometry(curve, Math.min(segments, 400), radius, radialSegments, closed);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++)
    uv.setXY(i, uv.getX(i) * length, uv.getY(i) * Math.PI * 2 * radius);
  return geometry;
}

const tmpXformMatrix = new Matrix4();
const tmpXformQuat = new Quaternion();
const tmpXformEuler = new Euler();
const tmpXformPos = new Vector3();
const tmpXformScale = new Vector3();

/** Compact transform: position `p`, Euler rotation `r`, uniform or per-axis scale `s`. */
export interface TransformSpec {
  p?: Vec3Tuple;
  r?: Vec3Tuple;
  s?: number | Vec3Tuple;
}

/** Applies a position/rotation/scale transform to a geometry or object in place; returns it. */
export function applyTransform<T extends { applyMatrix4(matrix: Matrix4): unknown }>(
  target: T,
  { p: position = [0, 0, 0], r: rotation = [0, 0, 0], s: scale = 1 }: TransformSpec = {}
): T {
  tmpXformEuler.set(rotation[0], rotation[1], rotation[2]);
  tmpXformQuat.setFromEuler(tmpXformEuler);
  tmpXformPos.set(position[0], position[1], position[2]);
  if (typeof scale == 'number') tmpXformScale.set(scale, scale, scale);
  else tmpXformScale.set(scale[0], scale[1], scale[2]);
  tmpXformMatrix.compose(tmpXformPos, tmpXformQuat, tmpXformScale);
  target.applyMatrix4(tmpXformMatrix);
  return target;
}

/** A constant RGB colour, or a function of vertex position returning one. */
export type VertexColorSource = Vec3Tuple | ((x: number, y: number, z: number) => Vec3Tuple);

/** Sets a `color` attribute on every vertex; returns the geometry. */
export function setVertexColors<T extends BufferGeometry>(
  geometry: T,
  color: VertexColorSource
): T {
  const position = geometry.attributes.position;
  const count = position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const rgb =
      typeof color == 'function'
        ? color(position.getX(i), position.getY(i), position.getZ(i))
        : color;
    colors[i * 3] = rgb[0];
    colors[i * 3 + 1] = rgb[1];
    colors[i * 3 + 2] = rgb[2];
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Merges geometries (falsy entries skipped) into one, first normalising their
 * attributes to position/normal/uv(/color) and their indexing. Mutates the inputs.
 */
export function mergeGeometryList(
  geometries: ReadonlyArray<BufferGeometry | null | undefined | false>
): BufferGeometry {
  const prepared = geometries
    .filter((geometry): geometry is BufferGeometry => Boolean(geometry))
    .map((geometry) => {
      if (!geometry.attributes.uv)
        geometry.setAttribute(
          'uv',
          new BufferAttribute(new Float32Array(geometry.attributes.position.count * 2), 2)
        );
      if (!geometry.attributes.normal) geometry.computeVertexNormals();
      return geometry;
    });
  if (!prepared.length) return new BufferGeometry();
  const anyColored = prepared.some((geometry) => geometry.attributes.color);
  const normalized = prepared.map((geometry) => {
    if (anyColored && !geometry.attributes.color) {
      const white = new Float32Array(geometry.attributes.position.count * 3).fill(1);
      geometry.setAttribute('color', new BufferAttribute(white, 3));
    }
    for (const name of Object.keys(geometry.attributes))
      if (!['position', 'normal', 'uv', 'color'].includes(name)) geometry.deleteAttribute(name);
    return geometry;
  });
  const allIndexed = normalized.every((geometry) => geometry.index);
  const noneIndexed = normalized.every((geometry) => !geometry.index);
  const mergeable =
    allIndexed || noneIndexed
      ? normalized
      : normalized.map((geometry) => (geometry.index ? geometry.toNonIndexed() : geometry));
  return mergeGeometries(mergeable, false) || new BufferGeometry();
}

interface MergeBucket {
  mat: Material;
  geos: BufferGeometry[];
  cast: boolean;
  recv: boolean;
  layers: number;
}

type MeshLike = Object3D & {
  isMesh?: boolean;
  isSkinnedMesh?: boolean;
  isInstancedMesh?: boolean;
};

/**
 * Bakes all static meshes under `root` into one mesh per material/shadow/layer
 * combination. Meshes flagged `userData.noMerge` (or under such a parent), skinned,
 * instanced and multi-material meshes are moved over unmerged. Returns a new group.
 */
export function mergeStaticMeshes(
  root: Object3D,
  {
    castShadow = true,
    receiveShadow = true
  }: { castShadow?: boolean; receiveShadow?: boolean } = {}
): Group {
  root.updateMatrixWorld(true);
  const buckets = new Map<string, MergeBucket>();
  const keptAsIs: Mesh[] = [];
  root.traverse((object) => {
    const candidate = object as MeshLike;
    if (!candidate.isMesh) return;
    const mesh = object as Mesh;
    let ancestor: Object3D | null = mesh;
    let noMerge = false;
    while (ancestor) {
      if (ancestor.userData && ancestor.userData.noMerge) {
        noMerge = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    const material = mesh.material;
    if (
      noMerge ||
      candidate.isSkinnedMesh ||
      candidate.isInstancedMesh ||
      Array.isArray(material)
    ) {
      keptAsIs.push(mesh);
      return;
    }
    const key =
      material.uuid +
      (mesh.castShadow ? 'c' : 'n') +
      (mesh.receiveShadow ? 'r' : 'n') +
      ':' +
      mesh.layers.mask;
    if (!buckets.has(key))
      buckets.set(key, {
        mat: material,
        geos: [],
        cast: mesh.castShadow,
        recv: mesh.receiveShadow,
        layers: mesh.layers.mask
      });
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    buckets.get(key)!.geos.push(geometry);
  });
  const group = new Group();
  for (const bucket of buckets.values()) {
    const merged = new Mesh(mergeGeometryList(bucket.geos), bucket.mat);
    merged.castShadow = bucket.cast && castShadow;
    merged.receiveShadow = bucket.recv && receiveShadow;
    merged.layers.mask = bucket.layers;
    group.add(merged);
  }
  for (const mesh of keptAsIs) {
    mesh.updateMatrixWorld(true);
    const worldMatrix = mesh.matrixWorld.clone();
    group.add(mesh);
    mesh.matrix.copy(worldMatrix);
    mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
  }
  return group;
}

/** Creates a mesh with shadow casting/receiving switched on (by default). */
export function shadowedMesh<
  G extends BufferGeometry = BufferGeometry,
  M extends Material | Material[] = Material | Material[]
>(
  geometry: G,
  material: M,
  { cast = true, recv = true }: { cast?: boolean; recv?: boolean } = {}
): Mesh<G, M> {
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = cast;
  mesh.receiveShadow = recv;
  return mesh;
}
