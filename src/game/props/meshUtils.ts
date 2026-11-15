// Mesh-building utilities for props: 3D value noise, smooth lathes, rounded boxes,
// vertex mapping / welding / flipping, tubes between points, polygon extrusion, ribbons,
// curved panels, metric-uv primitives, vertex-colour tinting and paint colour lookup.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Euler,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  ShapeUtils,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3
} from 'three';
import { mergeGeometryList, worldUvCylinder } from '../render/geometry';

/** A point / vector / RGB triple given as an array. */
type NumArray = ArrayLike<number>;

/** Vertex tint: a scalar, an RGB triple, or a function of the vertex position. */
export type VertexTint =
  number | NumArray | ((x: number, y: number, z: number) => number | NumArray) | null | undefined;

/** `[materialName, tint]` for a paint colour name. */
export type PaintSpec = [string, number | number[]];

/** Position / euler rotation / scale for {@link composeTransform}. */
export interface TransformSpec {
  p?: NumArray;
  r?: NumArray;
  s?: number | NumArray;
}

export const PI = Math.PI;
export const HALF_PI = Math.PI / 2;
export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function latticeHash3d(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth 3D value noise in [0, 1). */
export function valueNoise3d(x: number, y = 0, z = 0): number {
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
      lerp(latticeHash3d(ix, iy, iz), latticeHash3d(ix + 1, iy, iz), fx),
      lerp(latticeHash3d(ix, iy + 1, iz), latticeHash3d(ix + 1, iy + 1, iz), fx),
      fy
    ),
    lerp(
      lerp(latticeHash3d(ix, iy, iz + 1), latticeHash3d(ix + 1, iy, iz + 1), fx),
      lerp(latticeHash3d(ix, iy + 1, iz + 1), latticeHash3d(ix + 1, iy + 1, iz + 1), fx),
      fy
    ),
    fz
  );
}
/** Geometry from flat arrays; normals are computed when not given. */
function buildIndexedGeometry(
  positions: number[],
  normals: number[] | null,
  uvs: number[],
  indices: number[] | null
): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  if (normals) geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  if (indices) geometry.setIndex(indices);
  if (!normals) geometry.computeVertexNormals();
  return geometry;
}
/**
 * Lathe of `[radius, y]` points with smooth (averaged) profile normals and metric uvs
 * (u = circumference at the widest radius, v = profile arc length).
 */
export function smoothLatheGeometry(profile: NumArray[], segments = 16): BufferGeometry {
  const pointCount = profile.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const normalR: number[] = [];
  const normalY: number[] = [];
  const arcAt: number[] = [];
  let maxRadius = 0;
  let arcLength = 0;
  for (let i = 0; i < pointCount; i++) {
    let tangentR = 0;
    let tangentY = 0;
    if (i > 0) {
      const dr = profile[i][0] - profile[i - 1][0];
      const dy = profile[i][1] - profile[i - 1][1];
      const len = Math.hypot(dr, dy);
      if (len > 1e-6) {
        tangentR += dr / len;
        tangentY += dy / len;
        arcLength += len;
      }
    }
    if (i < pointCount - 1) {
      const dr = profile[i + 1][0] - profile[i][0];
      const dy = profile[i + 1][1] - profile[i][1];
      const len = Math.hypot(dr, dy);
      if (len > 1e-6) {
        tangentR += dr / len;
        tangentY += dy / len;
      }
    }
    const tangentLen = Math.hypot(tangentR, tangentY) || 1;
    normalR.push(tangentY / tangentLen);
    normalY.push(-tangentR / tangentLen);
    arcAt.push(arcLength);
    maxRadius = Math.max(maxRadius, profile[i][0]);
  }
  for (let i = 0; i < pointCount; i++)
    for (let s = 0; s <= segments; s++) {
      const angle = (s / segments) * PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(profile[i][0] * cos, profile[i][1], profile[i][0] * sin);
      normals.push(normalR[i] * cos, normalY[i], normalR[i] * sin);
      uvs.push((s / segments) * PI * 2 * maxRadius, arcAt[i]);
    }
  for (let i = 0; i < pointCount - 1; i++)
    if (!(Math.hypot(profile[i + 1][0] - profile[i][0], profile[i + 1][1] - profile[i][1]) < 1e-6))
      for (let s = 0; s < segments; s++) {
        const a = i * (segments + 1) + s;
        const b = a + segments + 1;
        const c = b + 1;
        const d = a + 1;
        // Skip degenerate triangles on the axis.
        if (profile[i][0] > 1e-6) indices.push(a, b, d);
        if (profile[i + 1][0] > 1e-6) indices.push(b, c, d);
      }
  return buildIndexedGeometry(positions, normals, uvs, indices);
}
/** Low-poly box with chamfered edges (3 vertices per corner); `anchor` 'bottom' puts y=0 at the base. */
export function roundedBoxGeometry(
  width: number,
  height: number,
  depth: number,
  radius = 0.008,
  anchor = 'center'
): BufferGeometry {
  const half = [width / 2, height / 2, depth / 2];
  radius = Math.min(radius, half[0] * 0.9, half[1] * 0.9, half[2] * 0.9);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let corner = 0; corner < 8; corner++)
    for (let axis = 0; axis < 3; axis++) {
      const signs = [corner & 1 ? 1 : -1, corner & 2 ? 1 : -1, corner & 4 ? 1 : -1];
      const p = [0, 1, 2].map((k) => signs[k] * (half[k] - (k !== axis ? radius : 0)));
      positions.push(p[0], p[1], p[2]);
      normals.push(axis === 0 ? signs[0] : 0, axis === 1 ? signs[1] : 0, axis === 2 ? signs[2] : 0);
      if (axis === 0) uvs.push(p[2], p[1]);
      else if (axis === 1) uvs.push(p[0], p[2]);
      else uvs.push(p[0], p[1]);
    }
  const vertexIndex = (corner: number, axis: number): number => corner * 3 + axis;
  /** Add triangle (a, b, c), flipping it so its normal agrees with (nx, ny, nz). */
  const addTriangle = (
    a: number,
    b: number,
    c: number,
    nx: number,
    ny: number,
    nz: number
  ): void => {
    const abx = positions[b * 3] - positions[a * 3];
    const aby = positions[b * 3 + 1] - positions[a * 3 + 1];
    const abz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const acx = positions[c * 3] - positions[a * 3];
    const acy = positions[c * 3 + 1] - positions[a * 3 + 1];
    const acz = positions[c * 3 + 2] - positions[a * 3 + 2];
    if (
      (aby * acz - abz * acy) * nx + (abz * acx - abx * acz) * ny + (abx * acy - aby * acx) * nz >=
      0
    )
      indices.push(a, b, c);
    else indices.push(a, c, b);
  };
  for (let axis = 0; axis < 3; axis++) {
    const axisU = (axis + 1) % 3;
    const axisV = (axis + 2) % 3;
    // Main faces
    for (const side of [0, 1]) {
      const corners = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1]
      ].map(([u, v]) => (side << axis) | (u << axisU) | (v << axisV));
      const normal = [0, 0, 0];
      normal[axis] = side ? 1 : -1;
      addTriangle(
        vertexIndex(corners[0], axis),
        vertexIndex(corners[1], axis),
        vertexIndex(corners[2], axis),
        normal[0],
        normal[1],
        normal[2]
      );
      addTriangle(
        vertexIndex(corners[0], axis),
        vertexIndex(corners[2], axis),
        vertexIndex(corners[3], axis),
        normal[0],
        normal[1],
        normal[2]
      );
    }
    // Edge chamfers along `axis`
    for (const sideU of [0, 1])
      for (const sideV of [0, 1]) {
        const cornerLow = (sideU << axisU) | (sideV << axisV);
        const cornerHigh = cornerLow | (1 << axis);
        const normal = [0, 0, 0];
        normal[axisU] = sideU ? 1 : -1;
        normal[axisV] = sideV ? 1 : -1;
        addTriangle(
          vertexIndex(cornerLow, axisU),
          vertexIndex(cornerHigh, axisU),
          vertexIndex(cornerHigh, axisV),
          normal[0],
          normal[1],
          normal[2]
        );
        addTriangle(
          vertexIndex(cornerLow, axisU),
          vertexIndex(cornerHigh, axisV),
          vertexIndex(cornerLow, axisV),
          normal[0],
          normal[1],
          normal[2]
        );
      }
  }
  // Corner triangles
  for (let corner = 0; corner < 8; corner++)
    addTriangle(
      vertexIndex(corner, 0),
      vertexIndex(corner, 1),
      vertexIndex(corner, 2),
      corner & 1 ? 1 : -1,
      corner & 2 ? 1 : -1,
      corner & 4 ? 1 : -1
    );
  const geometry = buildIndexedGeometry(positions, normals, uvs, indices);
  if (anchor === 'bottom') geometry.translate(0, height / 2, 0);
  return geometry;
}
/**
 * Subdivided BoxGeometry whose edge vertices are pulled onto rounded edges of `radius`,
 * with planar-projected metric uvs.
 */
export function subdividedRoundedBox(
  width: number,
  height: number,
  depth: number,
  radius = 0.03,
  segmentsX = 3,
  segmentsY = 3,
  segmentsZ = 3,
  anchor = 'center'
): BoxGeometry {
  const geometry = new BoxGeometry(width, height, depth, segmentsX, segmentsY, segmentsZ);
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;
  radius = Math.min(radius, hx * 0.95, hy * 0.95, hz * 0.95);
  /** Move the first interior grid line onto the start of the rounding. */
  const remap = (value: number, half: number, segments: number): number => {
    if (Math.abs(value) > half - 1e-6 || segments < 3) return value;
    const cellSize = (2 * half) / segments;
    return (value * (half - radius)) / (half - cellSize);
  };
  const offset = new Vector3();
  for (let i = 0; i < position.count; i++) {
    let x = remap(position.getX(i), hx, segmentsX);
    let y = remap(position.getY(i), hy, segmentsY);
    let z = remap(position.getZ(i), hz, segmentsZ);
    const innerX = clamp(x, -(hx - radius), hx - radius);
    const innerY = clamp(y, -(hy - radius), hy - radius);
    const innerZ = clamp(z, -(hz - radius), hz - radius);
    offset.set(x - innerX, y - innerY, z - innerZ);
    if (
      (Math.abs(x) > hx - 1e-5 ? 1 : 0) +
        (Math.abs(y) > hy - 1e-5 ? 1 : 0) +
        (Math.abs(z) > hz - 1e-5 ? 1 : 0) >=
        2 &&
      offset.lengthSq() > 1e-12
    ) {
      offset.normalize();
      x = innerX + offset.x * radius;
      y = innerY + offset.y * radius;
      z = innerZ + offset.z * radius;
      normal.setXYZ(i, offset.x, offset.y, offset.z);
    }
    position.setXYZ(i, x, y, z);
    const absNx = Math.abs(normal.getX(i));
    const absNy = Math.abs(normal.getY(i));
    const absNz = Math.abs(normal.getZ(i));
    if (absNx >= absNy && absNx >= absNz) uv.setXY(i, z, y);
    else if (absNy >= absNx && absNy >= absNz) uv.setXY(i, x, z);
    else uv.setXY(i, x, y);
  }
  if (anchor === 'bottom') geometry.translate(0, height / 2, 0);
  return geometry;
}
/** Run `fn` on every vertex position (mutating the Vector3 updates the vertex); returns the geometry. */
export function mapVertices<T extends BufferGeometry>(
  geometry: T,
  fn: (vertex: Vector3, index: number) => void
): T {
  const position = geometry.attributes.position;
  const vertex = new Vector3();
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i);
    fn(vertex, i);
    position.setXYZ(i, vertex.x, vertex.y, vertex.z);
  }
  return geometry;
}
/** Smooth normals averaged across vertices sharing a position (welds seams), in place. */
export function computeWeldedNormals<T extends BufferGeometry>(geometry: T): T {
  const position = geometry.attributes.position;
  const index = geometry.index;
  const vertexCount = position.count;
  const sums = new Map<string, number[]>();
  const positionKey = (i: number): string =>
    Math.round(position.getX(i) * 2000) +
    ',' +
    Math.round(position.getY(i) * 2000) +
    ',' +
    Math.round(position.getZ(i) * 2000);
  const keys: string[] = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) keys[i] = positionKey(i);
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const indexCount = index ? index.count : vertexCount;
  for (let i = 0; i < indexCount; i += 3) {
    const ia = index ? index.getX(i) : i;
    const ib = index ? index.getX(i + 1) : i + 1;
    const ic = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    b.sub(a);
    c.sub(a);
    b.cross(c);
    for (const vertex of [ia, ib, ic]) {
      let sum = sums.get(keys[vertex]);
      if (!sum) {
        sum = [0, 0, 0];
        sums.set(keys[vertex], sum);
      }
      sum[0] += b.x;
      sum[1] += b.y;
      sum[2] += b.z;
    }
  }
  const normals = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const sum = sums.get(keys[i]) || [0, 1, 0];
    const len = Math.hypot(sum[0], sum[1], sum[2]) || 1;
    normals[i * 3] = sum[0] / len;
    normals[i * 3 + 1] = sum[1] / len;
    normals[i * 3 + 2] = sum[2] / len;
  }
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  return geometry;
}
/** Reverse triangle winding and negate normals, in place. */
export function flipGeometry<T extends BufferGeometry>(geometry: T): T {
  if (geometry.index) {
    const indices = geometry.index.array;
    for (let i = 0; i < indices.length; i += 3) {
      const swap = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = swap;
    }
  } else
    for (const name of Object.keys(geometry.attributes)) {
      const attribute = geometry.attributes[name] as BufferAttribute;
      const itemSize = attribute.itemSize;
      const array = attribute.array;
      for (let vertex = 0; vertex < attribute.count; vertex += 3)
        for (let k = 0; k < itemSize; k++) {
          const swap = array[(vertex + 1) * itemSize + k];
          array[(vertex + 1) * itemSize + k] = array[(vertex + 2) * itemSize + k];
          array[(vertex + 2) * itemSize + k] = swap;
        }
    }
  const normals = (geometry.attributes.normal as BufferAttribute).array;
  for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
  return geometry;
}
/** Delete the triangles of draw group `groupIndex` from an indexed geometry (group left empty). */
export function removeGeometryGroup<T extends BufferGeometry>(geometry: T, groupIndex: number): T {
  const group = geometry.groups[groupIndex];
  if (!group) return geometry;
  const indices = Array.from((geometry.index as BufferAttribute).array);
  indices.splice(group.start, group.count);
  geometry.setIndex(indices);
  for (const other of geometry.groups) if (other.start > group.start) other.start -= group.count;
  group.count = 0;
  return geometry;
}
const tmpTubeQuat = new Quaternion();
const UP_AXIS = new Vector3(0, 1, 0);
const tmpTubeDir = new Vector3();
const tmpTubeMat4 = new Matrix4();
/** Cylinder from point `from` to point `to` (radius at `to` is `radius`, at `from` `fromRadius`). */
export function cylinderBetween(
  from: NumArray,
  to: NumArray,
  radius = 0.02,
  radialSegments = 6,
  capped = false,
  fromRadius = radius
): BufferGeometry {
  tmpTubeDir.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const length = tmpTubeDir.length();
  tmpTubeDir.normalize();
  const geometry = worldUvCylinder(fromRadius, radius, length, radialSegments, !capped);
  tmpTubeQuat.setFromUnitVectors(UP_AXIS, tmpTubeDir);
  tmpTubeMat4.compose(
    new Vector3((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2),
    tmpTubeQuat,
    new Vector3(1, 1, 1)
  );
  geometry.applyMatrix4(tmpTubeMat4);
  return geometry;
}
/**
 * Extrude a 2D polygon (XY) by `depth` along Z (centred). Side normals are smoothed across
 * corners sharper than `soft` radians apart; `caps` adds triangulated front/back faces.
 */
export function extrudePolygon(
  polygon: NumArray[],
  depth: number,
  { soft = 0.6, caps = true }: { soft?: number; caps?: boolean } = {}
): BufferGeometry {
  const pointCount = polygon.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const halfDepth = depth / 2;
  const edgeNormals: number[][] = [];
  let perimeter = 0;
  const arcAt = [0];
  for (let i = 0; i < pointCount; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % pointCount];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    edgeNormals.push([dy / len, -dx / len]);
    perimeter += len;
    arcAt.push(perimeter);
  }
  /** Normal of edge `edge` at its shared vertex with edge `neighbor` (averaged if the corner is soft). */
  const cornerNormal = (edge: number, neighbor: number): number[] => {
    const n0 = edgeNormals[edge];
    const n1 = edgeNormals[(neighbor + pointCount) % pointCount];
    if (n0[0] * n1[0] + n0[1] * n1[1] > Math.cos(soft)) {
      const sx = n0[0] + n1[0];
      const sy = n0[1] + n1[1];
      const len = Math.hypot(sx, sy) || 1;
      return [sx / len, sy / len];
    }
    return n0;
  };
  for (let i = 0; i < pointCount; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % pointCount];
    const normalA = cornerNormal(i, i - 1);
    const normalB = cornerNormal(i, i + 1);
    const base = positions.length / 3;
    positions.push(
      a[0],
      a[1],
      halfDepth,
      a[0],
      a[1],
      -halfDepth,
      b[0],
      b[1],
      -halfDepth,
      b[0],
      b[1],
      halfDepth
    );
    normals.push(
      normalA[0],
      normalA[1],
      0,
      normalA[0],
      normalA[1],
      0,
      normalB[0],
      normalB[1],
      0,
      normalB[0],
      normalB[1],
      0
    );
    uvs.push(
      arcAt[i],
      halfDepth,
      arcAt[i],
      -halfDepth,
      arcAt[i + 1],
      -halfDepth,
      arcAt[i + 1],
      halfDepth
    );
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  if (caps) {
    const triangles = ShapeUtils.triangulateShape(
      polygon.map((point) => new Vector2(point[0], point[1])),
      []
    );
    for (const side of [1, -1]) {
      const base = positions.length / 3;
      for (const point of polygon) {
        positions.push(point[0], point[1], side * halfDepth);
        normals.push(0, 0, side);
        uvs.push(point[0], point[1]);
      }
      for (const tri of triangles) {
        if (side > 0) indices.push(base + tri[0], base + tri[1], base + tri[2]);
        else indices.push(base + tri[0], base + tri[2], base + tri[1]);
      }
    }
  }
  return buildIndexedGeometry(positions, normals, uvs, indices);
}
/**
 * Flat strip along a 3D polyline, offset by +/- `halfWidth` at each point; uvs are metric.
 * When `doubleSided`, a flipped copy is merged in.
 */
export function ribbonGeometry(
  points: NumArray[],
  halfWidth: NumArray,
  doubleSided = true
): BufferGeometry {
  const pointCount = points.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let distance = 0;
  const width = Math.hypot(halfWidth[0], halfWidth[1], halfWidth[2]) * 2;
  for (let i = 0; i < pointCount; i++) {
    if (i) {
      distance += Math.hypot(
        points[i][0] - points[i - 1][0],
        points[i][1] - points[i - 1][1],
        points[i][2] - points[i - 1][2]
      );
    }
    positions.push(
      points[i][0] - halfWidth[0],
      points[i][1] - halfWidth[1],
      points[i][2] - halfWidth[2],
      points[i][0] + halfWidth[0],
      points[i][1] + halfWidth[1],
      points[i][2] + halfWidth[2]
    );
    uvs.push(distance, 0, distance, width);
  }
  for (let i = 0; i < pointCount - 1; i++) {
    const base = i * 2;
    indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
  }
  const front = buildIndexedGeometry(positions, null, uvs, indices);
  if (!doubleSided) return front;
  const back = front.clone();
  const backIndices = (back.index as BufferAttribute).array;
  for (let i = 0; i < backIndices.length; i += 3) {
    const swap = backIndices[i + 1];
    backIndices[i + 1] = backIndices[i + 2];
    backIndices[i + 2] = swap;
  }
  const backNormals = (back.attributes.normal as BufferAttribute).array;
  for (let i = 0; i < backNormals.length; i++) backNormals[i] = -backNormals[i];
  return mergeGeometryList([front, back]);
}
export function flatPlaneGeometry(width: number, height: number): PlaneGeometry {
  return new PlaneGeometry(width, height);
}
/** Vertical panel bent around the Y axis at `radius`, `arcLength` wide and `height` tall. */
export function curvedPanelGeometry(
  radius: number,
  arcLength: number,
  height: number,
  segments = 4
): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const angle = ((i / segments - 0.5) * arcLength) / radius;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    positions.push(radius * sin, -height / 2, radius * cos, radius * sin, height / 2, radius * cos);
    normals.push(sin, 0, cos, sin, 0, cos);
    uvs.push(i / segments, 0, i / segments, 1);
  }
  for (let i = 0; i < segments; i++) {
    const base = i * 2;
    indices.push(base, base + 2, base + 3, base, base + 3, base + 1);
  }
  return buildIndexedGeometry(positions, normals, uvs, indices);
}
/** TorusGeometry with uvs in metres. */
export function metricTorusGeometry(
  radius: number,
  tube: number,
  radialSegments = 6,
  tubularSegments = 12,
  arc = PI * 2
): TorusGeometry {
  const geometry = new TorusGeometry(radius, tube, radialSegments, tubularSegments, arc);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++)
    uv.setXY(i, uv.getX(i) * arc * radius, uv.getY(i) * 2 * PI * tube);
  return geometry;
}
/** SphereGeometry with uvs in metres. */
export function metricSphereGeometry(
  radius: number,
  widthSegments = 8,
  heightSegments = 6
): SphereGeometry {
  const geometry = new SphereGeometry(radius, widthSegments, heightSegments);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++)
    uv.setXY(i, uv.getX(i) * 2 * PI * radius, uv.getY(i) * PI * radius);
  return geometry;
}
/** Ensure a white `color` attribute exists, then multiply it by `tint`; returns the geometry. */
export function tintVertexColors<T extends BufferGeometry>(geometry: T, tint: VertexTint): T {
  const vertexCount = geometry.attributes.position.count;
  let color = geometry.attributes.color as BufferAttribute | undefined;
  if (!color) {
    color = new BufferAttribute(new Float32Array(vertexCount * 3).fill(1), 3);
    geometry.setAttribute('color', color);
  }
  if (tint === 1 || tint == null) return geometry;
  const colors = color.array;
  if (typeof tint == 'function') {
    const position = geometry.attributes.position;
    for (let i = 0; i < vertexCount; i++) {
      const value = tint(position.getX(i), position.getY(i), position.getZ(i));
      if (typeof value == 'number') {
        colors[i * 3] *= value;
        colors[i * 3 + 1] *= value;
        colors[i * 3 + 2] *= value;
      } else {
        colors[i * 3] *= value[0];
        colors[i * 3 + 1] *= value[1];
        colors[i * 3 + 2] *= value[2];
      }
    }
    return geometry;
  }
  const r = typeof tint == 'number' ? tint : tint[0];
  const g = typeof tint == 'number' ? tint : tint[1];
  const b = typeof tint == 'number' ? tint : tint[2];
  for (let i = 0; i < vertexCount; i++) {
    colors[i * 3] *= r;
    colors[i * 3 + 1] *= g;
    colors[i * 3 + 2] *= b;
  }
  return geometry;
}
const PAINT_COLOR_MATERIALS: Record<string, PaintSpec> = {
  red: ['paint_red', 1],
  blue: ['paint_blue', 1],
  green: ['paint_green', 1],
  yellow: ['paint_yellow', 1],
  orange: ['paint_orange', 1],
  white: ['paint_white', 1],
  grey: ['paint_grey', 1],
  teal: ['paint_teal', 1],
  rust: ['steel_rust', 1],
  black: ['paint_grey', [0.2, 0.2, 0.22]],
  olive: ['paint_green', [0.75, 0.8, 0.45]]
};
/** `[material, tint]` for a paint colour name, or for `fallback` when unknown. */
export function paintMaterialFor(color: string | undefined, fallback = 'blue'): PaintSpec {
  return PAINT_COLOR_MATERIALS[color as string] || PAINT_COLOR_MATERIALS[fallback];
}
const tmpUnusedMat4 = new Matrix4();
const tmpXformQuat = new Quaternion();
const tmpXformEuler = new Euler();
const tmpXformPos = new Vector3();
const tmpXformScale = new Vector3();
/** New matrix from position `p`, XYZ euler `r` and uniform or per-axis scale `s`. */
export function composeTransform({
  p = [0, 0, 0],
  r = [0, 0, 0],
  s = 1
}: TransformSpec = {}): Matrix4 {
  tmpXformEuler.set(r[0], r[1], r[2]);
  tmpXformQuat.setFromEuler(tmpXformEuler);
  tmpXformPos.set(p[0], p[1], p[2]);
  if (typeof s == 'number') tmpXformScale.set(s, s, s);
  else tmpXformScale.set(s[0], s[1], s[2]);
  return new Matrix4().compose(tmpXformPos, tmpXformQuat, tmpXformScale);
}
