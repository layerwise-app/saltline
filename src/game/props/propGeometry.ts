// Geometry helpers shared by the procedural prop builders: a seeded RNG, 2D value noise,
// chamfered boxes, profile sweeps, corrugated-sheet profiles, stadium caps and small
// transform utilities (with shared scratch objects).
import {
  BufferAttribute,
  BufferGeometry,
  Euler,
  LatheGeometry,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector2,
  Vector3
} from 'three';

/** A 2D / 3D point or RGB triple given as an array. */
export type NumArray = ArrayLike<number>;

/** Maps profile point (u, v) at sweep station `station` (index `index`) to an `[x, y, z]` point. */
export type SweepMapper = (u: number, v: number, station: number, index: number) => number[];

/** Options for {@link sweepProfileGeometry}. */
export interface SweepOptions {
  /** Treat the profile as a closed loop. */
  closed?: boolean;
  /** Reference point for orienting faces outward (defaults to the vertex centroid). */
  center?: NumArray | null;
  /** Orient faces toward the centre instead of away from it. */
  inward?: boolean;
  /** Add end caps (closed profiles only). */
  caps?: boolean;
}

/** Deterministic PRNG returning floats in [0, 1) for an integer seed. */
export function seededRandom(seed: number): () => number {
  let state = ((seed | 0) * 2654435761) | 0;
  return () => {
    state = (state + 1831565813) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2d(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
/** Smooth 2D value noise in [0, 1). */
export function valueNoise2d(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const h00 = hash2d(ix, iy);
  const h10 = hash2d(ix + 1, iy);
  const h01 = hash2d(ix, iy + 1);
  const h11 = hash2d(ix + 1, iy + 1);
  return h00 + (h10 - h00) * sx + (h01 - h00) * sy + (h00 - h10 - h01 + h11) * sx * sy;
}
export const saturate = (value: number): number => Math.max(0, Math.min(1, value));
export const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = saturate((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};
export const lerpRgb = (a: NumArray, b: NumArray, t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t
];

/** Box with 45-degree chamfered edges and corners (24 vertices); `anchor` 'bottom' puts y=0 at the base. */
export function chamferedBoxGeometry(
  width: number,
  height: number,
  depth: number,
  chamfer = 0.01,
  anchor = 'center'
): BufferGeometry {
  chamfer = Math.max(
    5e-4,
    Math.min(chamfer, width / 2 - 1e-4, height / 2 - 1e-4, depth / 2 - 1e-4)
  );
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;
  const positions = new Float32Array(72);
  const normals = new Float32Array(72);
  const uvs = new Float32Array(48);
  /** Vertex index of the corner (sx, sy, sz) on the face of `axis`. */
  const vertexIndex = (sx: number, sy: number, sz: number, axis: number): number =>
    ((sx > 0 ? 1 : 0) + (sy > 0 ? 2 : 0) + (sz > 0 ? 4 : 0)) * 3 + axis;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const corners = [
          [sx * hx, sy * (hy - chamfer), sz * (hz - chamfer)],
          [sx * (hx - chamfer), sy * hy, sz * (hz - chamfer)],
          [sx * (hx - chamfer), sy * (hy - chamfer), sz * hz]
        ];
        const faceNormals = [
          [sx, 0, 0],
          [0, sy, 0],
          [0, 0, sz]
        ];
        for (let axis = 0; axis < 3; axis++) {
          const index = vertexIndex(sx, sy, sz, axis);
          positions.set(corners[axis], index * 3);
          normals.set(faceNormals[axis], index * 3);
          if (axis === 0) {
            uvs[index * 2] = corners[axis][2];
            uvs[index * 2 + 1] = corners[axis][1];
          } else if (axis === 1) {
            uvs[index * 2] = corners[axis][0];
            uvs[index * 2 + 1] = corners[axis][2];
          } else {
            uvs[index * 2] = corners[axis][0];
            uvs[index * 2 + 1] = corners[axis][1];
          }
        }
      }
  const indices: number[] = [];
  /** Add a triangle, flipping its winding so it faces away from the origin. */
  const addTriangle = (a: number, b: number, c: number): void => {
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const abx = positions[b * 3] - ax;
    const aby = positions[b * 3 + 1] - ay;
    const abz = positions[b * 3 + 2] - az;
    const acx = positions[c * 3] - ax;
    const acy = positions[c * 3 + 1] - ay;
    const acz = positions[c * 3 + 2] - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const cx = ax + (abx + acx) / 3;
    const cy = ay + (aby + acy) / 3;
    const cz = az + (abz + acz) / 3;
    if (nx * cx + ny * cy + nz * cz >= 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  };
  const addQuad = (a: number, b: number, c: number, d: number): void => {
    addTriangle(a, b, c);
    addTriangle(a, c, d);
  };
  const quadCorners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1]
  ];
  const addFace = (corners: number[]): void => {
    addQuad(corners[0], corners[1], corners[2], corners[3]);
  };
  // Main faces
  for (const side of [-1, 1]) {
    addFace(quadCorners.map(([u, v]) => vertexIndex(side, u, v, 0)));
    addFace(quadCorners.map(([u, v]) => vertexIndex(u, side, v, 1)));
    addFace(quadCorners.map(([u, v]) => vertexIndex(u, v, side, 2)));
  }
  // Edge chamfers
  for (const a of [-1, 1])
    for (const b of [-1, 1]) {
      addQuad(
        vertexIndex(-1, a, b, 1),
        vertexIndex(1, a, b, 1),
        vertexIndex(1, a, b, 2),
        vertexIndex(-1, a, b, 2)
      );
      addQuad(
        vertexIndex(a, -1, b, 0),
        vertexIndex(a, 1, b, 0),
        vertexIndex(a, 1, b, 2),
        vertexIndex(a, -1, b, 2)
      );
      addQuad(
        vertexIndex(a, b, -1, 0),
        vertexIndex(a, b, 1, 0),
        vertexIndex(a, b, 1, 1),
        vertexIndex(a, b, -1, 1)
      );
    }
  // Corner triangles
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1])
        addTriangle(
          vertexIndex(sx, sy, sz, 0),
          vertexIndex(sx, sy, sz, 1),
          vertexIndex(sx, sy, sz, 2)
        );
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  if (anchor === 'bottom') geometry.translate(0, height / 2, 0);
  return geometry;
}

/**
 * Flip the winding of the non-indexed triangles in `positions[start, end)` (and their uvs)
 * if their summed facing relative to `center` disagrees with `inward`.
 */
function orientTrianglesOutward(
  positions: number[],
  uvs: number[],
  start: number,
  end: number,
  center: NumArray,
  inward: boolean
): void {
  let facing = 0;
  for (let i = start; i < end; i += 9) {
    const abx = positions[i + 3] - positions[i];
    const aby = positions[i + 4] - positions[i + 1];
    const abz = positions[i + 5] - positions[i + 2];
    const acx = positions[i + 6] - positions[i];
    const acy = positions[i + 7] - positions[i + 1];
    const acz = positions[i + 8] - positions[i + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    facing +=
      nx * ((positions[i] + positions[i + 3] + positions[i + 6]) / 3 - center[0]) +
      ny * ((positions[i + 1] + positions[i + 4] + positions[i + 7]) / 3 - center[1]) +
      nz * ((positions[i + 2] + positions[i + 5] + positions[i + 8]) / 3 - center[2]);
  }
  if (facing < 0 !== !!inward)
    for (let i = start; i < end; i += 9) {
      for (let c = 0; c < 3; c++) {
        const swap = positions[i + 3 + c];
        positions[i + 3 + c] = positions[i + 6 + c];
        positions[i + 6 + c] = swap;
      }
      const uvIndex = (i / 3) * 2;
      for (let c = 0; c < 2; c++) {
        const swap = uvs[uvIndex + 2 + c];
        uvs[uvIndex + 2 + c] = uvs[uvIndex + 4 + c];
        uvs[uvIndex + 4 + c] = swap;
      }
    }
}

/**
 * Sweep a 2D `profile` through `stations`, mapping each (u, v, station) to 3D with `mapPoint`.
 * Produces non-indexed triangles with uvs (arc length along the profile, station value).
 */
export function sweepProfileGeometry(
  profile: NumArray[],
  stations: number[],
  mapPoint: SweepMapper,
  { closed = false, center = null, inward = false, caps = false }: SweepOptions = {}
): BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const pointCount = profile.length;
  const segmentCount = closed ? pointCount : pointCount - 1;
  const arcLengths = [0];
  for (let i = 0; i < segmentCount; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % pointCount];
    arcLengths.push(arcLengths[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  for (let s = 0; s < stations.length - 1; s++) {
    const station0 = stations[s];
    const station1 = stations[s + 1];
    for (let i = 0; i < segmentCount; i++) {
      const a = profile[i];
      const b = profile[(i + 1) % pointCount];
      const a0 = mapPoint(a[0], a[1], station0, s);
      const b0 = mapPoint(b[0], b[1], station0, s);
      const b1 = mapPoint(b[0], b[1], station1, s + 1);
      const a1 = mapPoint(a[0], a[1], station1, s + 1);
      positions.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
      uvs.push(
        arcLengths[i],
        station0,
        arcLengths[i + 1],
        station0,
        arcLengths[i + 1],
        station1,
        arcLengths[i],
        station0,
        arcLengths[i + 1],
        station1,
        arcLengths[i],
        station1
      );
    }
  }
  const sideLength = positions.length;
  let centroid: number[] | null = null;
  const orientCenter = (): NumArray => {
    if (center) return center;
    if (!centroid) {
      centroid = [0, 0, 0];
      for (let i = 0; i < sideLength; i += 3) {
        centroid[0] += positions[i];
        centroid[1] += positions[i + 1];
        centroid[2] += positions[i + 2];
      }
      const scale = 3 / sideLength;
      centroid[0] *= scale;
      centroid[1] *= scale;
      centroid[2] *= scale;
    }
    return centroid;
  };
  orientTrianglesOutward(positions, uvs, 0, sideLength, orientCenter(), inward);
  if (caps && closed) {
    let midU = 0;
    let midV = 0;
    for (const point of profile) {
      midU += point[0];
      midV += point[1];
    }
    midU /= pointCount;
    midV /= pointCount;
    for (const stationIndex of [0, stations.length - 1]) {
      const capStart = positions.length;
      const station = stations[stationIndex];
      const mid = mapPoint(midU, midV, station, stationIndex);
      for (let i = 0; i < pointCount; i++) {
        const a = profile[i];
        const b = profile[(i + 1) % pointCount];
        positions.push(
          ...mid,
          ...mapPoint(a[0], a[1], station, stationIndex),
          ...mapPoint(b[0], b[1], station, stationIndex)
        );
        uvs.push(midU, midV, a[0], a[1], b[0], b[1]);
      }
      orientTrianglesOutward(positions, uvs, capStart, positions.length, orientCenter(), inward);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.computeVertexNormals();
  return geometry;
}

/** Depth offset (0 or negative) of a trapezoidal corrugation at position `x` within one pitch. */
function corrugationOffsetAt(
  x: number,
  pitch: number,
  depth: number,
  crestWidth: number,
  slopeWidth: number
): number {
  let local = x % pitch;
  if (local < 0) local += pitch;
  const troughWidth = pitch - crestWidth - 2 * slopeWidth;
  if (local <= crestWidth) return 0;
  if (local < crestWidth + slopeWidth) return (-depth * (local - crestWidth)) / slopeWidth;
  if (local <= crestWidth + slopeWidth + troughWidth) return -depth;
  return -depth * (1 - (local - crestWidth - slopeWidth - troughWidth) / slopeWidth);
}

/**
 * `[x, offset]` points of a trapezoidal corrugated-sheet profile from `start` to `end`,
 * with a breakpoint at every crest / slope / trough corner (phase origin `origin`).
 */
export function corrugationProfile(
  start: number,
  end: number,
  pitch: number,
  depth: number,
  crestWidth: number,
  slopeWidth: number,
  origin = start
): number[][] {
  const troughWidth = pitch - crestWidth - 2 * slopeWidth;
  const breakpoints = [
    0,
    crestWidth,
    crestWidth + slopeWidth,
    crestWidth + slopeWidth + troughWidth
  ];
  const xs = [start];
  const firstPitch = Math.floor((start - origin) / pitch) - 1;
  const lastPitch = Math.ceil((end - origin) / pitch) + 1;
  for (let k = firstPitch; k <= lastPitch; k++)
    for (const offset of breakpoints) {
      const x = origin + k * pitch + offset;
      if (x > start + 1e-4 && x < end - 1e-4) xs.push(x);
    }
  xs.push(end);
  return xs.map((x) => [x, corrugationOffsetAt(x - origin, pitch, depth, crestWidth, slopeWidth)]);
}

/** Flat fan-triangulated stadium (rounded rectangle) of `width` x `height` in the XY plane. */
export function stadiumGeometry(width: number, height: number, arcSegments = 5): BufferGeometry {
  const outline: number[][] = [];
  const radius = Math.min(width, height) / 2;
  const offsetX = width / 2 - radius;
  const offsetY = height / 2 - radius;
  for (let quadrant = 0; quadrant < 4; quadrant++)
    for (let i = 0; i <= arcSegments; i++) {
      const angle = ((quadrant + i / arcSegments) * Math.PI) / 2;
      outline.push([
        Math.cos(angle) * radius + (quadrant === 0 || quadrant === 3 ? offsetX : -offsetX),
        Math.sin(angle) * radius + (quadrant < 2 ? offsetY : -offsetY)
      ]);
    }
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    positions.push(0, 0, 0, a[0], a[1], 0, b[0], b[1], 0);
    uvs.push(
      0.5,
      0.5,
      a[0] / width + 0.5,
      a[1] / height + 0.5,
      b[0] / width + 0.5,
      b[1] / height + 0.5
    );
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.computeVertexNormals();
  return geometry;
}
export function simplePlaneGeometry(width: number, height: number): PlaneGeometry {
  return new PlaneGeometry(width, height);
}
/** Plane whose uvs are in metres (u spans `width`, v spans `height`). */
export function metricPlaneGeometry(width: number, height: number): PlaneGeometry {
  const geometry = new PlaneGeometry(width, height);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * width, uv.getY(i) * height);
  return geometry;
}
/** Non-indexed copy (if indexed) with recomputed, i.e. faceted, normals. */
export function flatShadedGeometry(geometry: BufferGeometry): BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  flat.computeVertexNormals();
  return flat;
}
export function sphereSegmentGeometry(
  radius: number,
  widthSegments = 10,
  heightSegments = 6,
  phiLength = Math.PI * 2,
  thetaStart = 0,
  thetaLength = Math.PI
): SphereGeometry {
  return new SphereGeometry(
    radius,
    widthSegments,
    heightSegments,
    0,
    phiLength,
    thetaStart,
    thetaLength
  );
}
/** Lathe from `[radius, y]` points. */
export function latheFromPoints(points: NumArray[], segments = 16): LatheGeometry {
  return new LatheGeometry(
    points.map((point) => new Vector2(point[0], point[1])),
    segments
  );
}
export const tmpEuler = new Euler();
export const tmpQuat = new Quaternion();
export const tmpMat4 = new Matrix4();
export const tmpPosition = new Vector3();
export const UNIT_SCALE = new Vector3(1, 1, 1);

/** Rotate (XYZ euler `rotation`, optional) then translate `geometry` in place; returns it. */
export function transformGeometry<T extends BufferGeometry>(
  geometry: T,
  x = 0,
  y = 0,
  z = 0,
  rotation: NumArray | null = null
): T {
  if (rotation) {
    tmpEuler.set(rotation[0], rotation[1], rotation[2]);
    tmpQuat.setFromEuler(tmpEuler);
  } else {
    tmpQuat.identity();
  }
  tmpPosition.set(x, y, z);
  tmpMat4.compose(tmpPosition, tmpQuat, UNIT_SCALE);
  geometry.applyMatrix4(tmpMat4);
  return geometry;
}
/** New matrix translating to (x, y, z) with optional XYZ euler `rotation`. */
export function makeTransformMatrix(
  x = 0,
  y = 0,
  z = 0,
  rotation: NumArray | null = null
): Matrix4 {
  if (rotation) {
    tmpEuler.set(rotation[0], rotation[1], rotation[2]);
    tmpQuat.setFromEuler(tmpEuler);
  } else {
    tmpQuat.identity();
  }
  tmpPosition.set(x, y, z);
  return new Matrix4().compose(tmpPosition, tmpQuat, UNIT_SCALE);
}
