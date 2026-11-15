// Procedural ground textures: baked puddle/dirt mask, tiling detail maps and the
// painted road-markings canvas (R = white paint, G = yellow paint, B = tyre marks).
import {
  CanvasTexture,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType
} from 'three';

/** Integer lattice hash -> [0, 1). */
function hashLattice3(x: number, y: number, seed: number): number {
  let hash =
    Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

/** Smooth 2D value noise; `period` (if non-zero) makes it tile. */
function valueNoise2D(x: number, y: number, seed: number, period?: number): number {
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  const fracX = x - cellX;
  const fracY = y - cellY;
  const easeX = fracX * fracX * (3 - 2 * fracX);
  const easeY = fracY * fracY * (3 - 2 * fracY);
  let x0 = cellX;
  let x1 = cellX + 1;
  let y0 = cellY;
  let y1 = cellY + 1;
  if (period) {
    x0 = ((x0 % period) + period) % period;
    x1 = ((x1 % period) + period) % period;
    y0 = ((y0 % period) + period) % period;
    y1 = ((y1 % period) + period) % period;
  }
  const v00 = hashLattice3(x0, y0, seed);
  const v10 = hashLattice3(x1, y0, seed);
  const v01 = hashLattice3(x0, y1, seed);
  const v11 = hashLattice3(x1, y1, seed);
  return v00 + (v10 - v00) * easeX + (v01 - v00) * easeY + (v00 - v10 - v01 + v11) * easeX * easeY;
}

/** Fractal (fBm) sum of value-noise octaves, normalised to [0, 1]. */
function fbmNoise2D(x: number, y: number, seed: number, octaves = 4, period = 0): number {
  let sum = 0;
  let amplitude = 0.5;
  let totalAmplitude = 0;
  for (let octave = 0; octave < octaves; octave++) {
    sum += amplitude * valueNoise2D(x, y, seed + octave * 17, period);
    totalAmplitude += amplitude;
    x *= 2;
    y *= 2;
    period *= 2;
    amplitude *= 0.5;
  }
  return sum / totalAmplitude;
}

/** Clamp to [0, 1]. */
export const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** GLSL-style smoothstep(edge0, edge1, x). */
export const smoothstepRange = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Height-field level below which the ground holds standing water. */
export const PUDDLE_WATER_LEVEL = 0.385;

/** World-space XZ square covered by the baked ground mask. */
export const GROUND_MASK_RECT = {
  x0: -44,
  z0: -40,
  size: 80
};

/** Hand-placed puddle basins: [x, z, radiusX, radiusZ, depth]. */
export const PUDDLE_BASINS: readonly (readonly [number, number, number, number, number])[] = [
  [-30.5, 6.6, 2.6, 1.7, 0.24],
  [-19.5, 5.2, 7.5, 1.5, 0.27],
  [-11.5, 7, 5, 1.2, 0.24],
  [-7.6, 5.6, 2.3, 1.7, 0.2],
  [5.6, 4.7, 3.3, 1.35, 0.26],
  [13, 6.6, 2.6, 1.2, 0.2],
  [-13, -1.3, 4.6, 1.5, 0.2],
  [1, -1.6, 3.4, 1.4, 0.18],
  [12.5, -1.4, 2.4, 1.3, 0.18],
  [-3.5, -8.2, 4.4, 1.6, 0.2],
  [-20, -8.6, 3.6, 1.6, 0.18],
  [14.6, -19.5, 2, 3.6, 0.2],
  [23.5, 6.9, 3.2, 2, 0.22],
  [23.2, -7.6, 3.4, 1.8, 0.2],
  [20.8, 1.5, 1.4, 3.6, 0.16],
  [23.5, 22.5, 3, 2, 0.2],
  [24, -25, 2.8, 2.6, 0.2],
  [-1, 16.5, 7, 1.7, 0.2],
  [11.5, 16.9, 3.6, 1.4, 0.18],
  [-17, 15.8, 3.2, 1.5, 0.18],
  [8.6, 12.3, 1.5, 3.4, 0.17],
  [-7.8, 19.5, 1.7, 3.6, 0.17],
  [-8, 25.8, 6, 1.3, 0.18],
  [9, 25.9, 4, 1.2, 0.18],
  [-32, -4, 2.6, 3.4, 0.18],
  [-31, 18, 3, 4, 0.18]
];

export const PUDDLE_RADIUS_SCALE = 1;
export const PUDDLE_DEPTH_BIAS = 0.02;

/** Ground height field (0.5 = nominal); basins, wheel ruts and the quay edge lift. */
function sampleGroundHeightField(x: number, z: number): number {
  let height =
    0.5 +
    (fbmNoise2D(x / 8.5, z / 8.5, 11, 4) - 0.47) * 0.3 +
    (fbmNoise2D(x / 2.4, z / 2.4, 23, 3) - 0.5) * 0.14;
  for (let i = 0; i < PUDDLE_BASINS.length; i++) {
    const basin = PUDDLE_BASINS[i];
    const dx = (x - basin[0]) / (basin[2] * PUDDLE_RADIUS_SCALE);
    const dz = (z - basin[1]) / (basin[3] * PUDDLE_RADIUS_SCALE);
    const distSq = dx * dx + dz * dz;
    if (distSq < 9) height -= (basin[4] + PUDDLE_DEPTH_BIAS) * Math.exp(-distSq * distSq);
  }
  if (x > -37 && x < 29) {
    const rutDepth = 0.5 + 0.5 * valueNoise2D(x / 6, 3.1, 5);
    const rutA = (z - 4.9) / 0.5;
    const rutB = (z - 7.1) / 0.5;
    const rutC = (z - 15.4) / 0.5;
    const rutD = (z - 17.2) / 0.5;
    const laneMask =
      smoothstepRange(0.14, 0.34, fbmNoise2D(x / 9, 7.7, 19, 2)) *
      smoothstepRange(-27, -24, x) *
      (1 - smoothstepRange(14, 17, x));
    height -=
      0.22 *
        (0.55 + 0.45 * rutDepth) *
        laneMask *
        (Math.exp(-rutA * rutA) + Math.exp(-rutB * rutB)) +
      0.09 *
        rutDepth *
        (1 - smoothstepRange(0.3, 0.6, fbmNoise2D(x / 9, 7.7, 19, 2))) *
        (Math.exp(-rutC * rutC) + Math.exp(-rutD * rutD));
  }
  height += 0.25 * smoothstepRange(28.6, 29.8, x);
  return height;
}

/**
 * Bakes the RGBA ground mask over GROUND_MASK_RECT:
 * R = puddle depth (0.5 = waterline), G = dirt/soak, B = cracks, A = streaky grime.
 */
export function bakeGroundMaskPixels(resolution: number): Uint8Array {
  const pixels = new Uint8Array(resolution * resolution * 4);
  const { x0, z0, size } = GROUND_MASK_RECT;
  const texel = size / resolution;
  for (let row = 0; row < resolution; row++) {
    const worldZ = z0 + (row + 0.5) * texel;
    for (let col = 0; col < resolution; col++) {
      const worldX = x0 + (col + 0.5) * texel;
      const offset = (row * resolution + col) * 4;
      const height = sampleGroundHeightField(worldX, worldZ);
      pixels[offset] = Math.round(clamp01(0.5 + (height - PUDDLE_WATER_LEVEL) * 2.5) * 255);
      pixels[offset + 1] = Math.round(
        clamp01(
          0.5 + (fbmNoise2D(worldX / 5.5, worldZ / 5.5, 41, 3) - 0.5) * 1.5 + (0.5 - height) * 0.9
        ) * 255
      );
      const cracks =
        smoothstepRange(0.6, 0.78, fbmNoise2D(worldX / 1.4, worldZ / 1.4, 77, 4)) *
        smoothstepRange(0.47, 0.62, fbmNoise2D(worldX / 9, worldZ / 9, 91, 2));
      pixels[offset + 2] = Math.round(clamp01(cracks) * 255);
      pixels[offset + 3] = Math.round(
        clamp01(
          fbmNoise2D(worldX / 22, worldZ / 0.9, 57, 3) * 0.6 +
            fbmNoise2D(worldX / 13, worldZ / 13, 63, 3) * 0.4
        ) * 255
      );
    }
  }
  return pixels;
}

/** Bilinearly samples one channel (0..3) of the baked mask at world (x, z); returns [0, 1]. */
export function sampleGroundMaskChannel(
  pixels: Uint8Array,
  resolution: number,
  worldX: number,
  worldZ: number,
  channel: number
): number {
  let texX = ((worldX - GROUND_MASK_RECT.x0) / GROUND_MASK_RECT.size) * resolution - 0.5;
  let texY = ((worldZ - GROUND_MASK_RECT.z0) / GROUND_MASK_RECT.size) * resolution - 0.5;
  texX = texX < 0 ? 0 : texX > resolution - 1.001 ? resolution - 1.001 : texX;
  texY = texY < 0 ? 0 : texY > resolution - 1.001 ? resolution - 1.001 : texY;
  const col = texX | 0;
  const row = texY | 0;
  const fracX = texX - col;
  const fracY = texY - row;
  const index = (row * resolution + col) * 4 + channel;
  const rowStride = resolution * 4;
  return (
    ((pixels[index] * (1 - fracX) + pixels[index + 4] * fracX) * (1 - fracY) +
      (pixels[index + rowStride] * (1 - fracX) + pixels[index + rowStride + 4] * fracX) * fracY) /
    255
  );
}

/** Tiling ground detail maps: `det` (four noise layers) and `nrm` (two packed XY normal sets). */
export interface GroundDetailPixels {
  det: Uint8Array;
  nrm: Uint8Array;
}

/** Bakes the tiling detail and detail-normal textures at `resolution`². */
export function bakeGroundDetailPixels(resolution: number): GroundDetailPixels {
  const detail = new Uint8Array(resolution * resolution * 4);
  const normals = new Uint8Array(resolution * resolution * 4);
  const fineHeight = new Float32Array(resolution * resolution);
  const coarseHeight = new Float32Array(resolution * resolution);
  for (let row = 0; row < resolution; row++)
    for (let col = 0; col < resolution; col++) {
      const u = col / resolution;
      const v = row / resolution;
      const index = row * resolution + col;
      const grain =
        fbmNoise2D(u * 96, v * 96, 3, 2, 96) * 0.6 + fbmNoise2D(u * 40, v * 40, 9, 2, 40) * 0.4;
      const blotches = fbmNoise2D(u * 6, v * 6, 21, 4, 6);
      const warpU = (fbmNoise2D(u * 8, v * 8, 31, 2, 8) - 0.5) * 0.25;
      const warpV = (fbmNoise2D(u * 8, v * 8, 37, 2, 8) - 0.5) * 0.25;
      const veins = 1 - Math.abs(2 * fbmNoise2D((u + warpU) * 5, (v + warpV) * 5, 43, 3, 5) - 1);
      const speckle = fbmNoise2D(u * 28, v * 28, 51, 3, 28);
      detail[index * 4] = Math.round(clamp01(grain) * 255);
      detail[index * 4 + 1] = Math.round(clamp01(blotches) * 255);
      detail[index * 4 + 2] = Math.round(clamp01(veins) * 255);
      detail[index * 4 + 3] = Math.round(clamp01(speckle) * 255);
      fineHeight[index] = grain;
      coarseHeight[index] = fbmNoise2D(u * 9, v * 9, 71, 4, 9);
    }
  const wrap = (i: number): number => (i + resolution) % resolution;
  for (let row = 0; row < resolution; row++)
    for (let col = 0; col < resolution; col++) {
      const index = row * resolution + col;
      const fineDx =
        (fineHeight[row * resolution + wrap(col + 1)] -
          fineHeight[row * resolution + wrap(col - 1)]) *
        2.2;
      const fineDy =
        (fineHeight[wrap(row + 1) * resolution + col] -
          fineHeight[wrap(row - 1) * resolution + col]) *
        2.2;
      const coarseDx =
        (coarseHeight[row * resolution + wrap(col + 2)] -
          coarseHeight[row * resolution + wrap(col - 2)]) *
        9;
      const coarseDy =
        (coarseHeight[wrap(row + 2) * resolution + col] -
          coarseHeight[wrap(row - 2) * resolution + col]) *
        9;
      normals[index * 4] = Math.round(clamp01(0.5 - fineDx) * 255);
      normals[index * 4 + 1] = Math.round(clamp01(0.5 - fineDy) * 255);
      normals[index * 4 + 2] = Math.round(clamp01(0.5 - coarseDx) * 255);
      normals[index * 4 + 3] = Math.round(clamp01(0.5 - coarseDy) * 255);
    }
  return {
    det: detail,
    nrm: normals
  };
}

/** Options for {@link createGroundDataTexture}. */
export interface GroundTextureOptions {
  /** Repeat-wrap (default) or clamp to edge. */
  repeat?: boolean;
  aniso?: number;
}

/** Wraps square RGBA8 pixels in a mipmapped, linear (non-colour) DataTexture. */
export function createGroundDataTexture(
  pixels: Uint8Array,
  resolution: number,
  { repeat = true, aniso = 1 }: GroundTextureOptions = {}
): DataTexture {
  const texture = new DataTexture(pixels, resolution, resolution, RGBAFormat, UnsignedByteType);
  texture.wrapS = texture.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = aniso;
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** World-space XZ rectangle covered by the road-markings texture. */
export const ROAD_MARKINGS_RECT = {
  x0: -40,
  z0: -30,
  w: 70,
  h: 60
};
/**
 * Paints the yard's road markings into a `size`² canvas texture covering ROAD_MARKINGS_RECT.
 * Channels are additive masks: R = white paint, G = yellow paint, B = tyre marks.
 */
export function paintRoadMarkingsTexture(size: number, anisotropy = 1): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  // Non-null: a fresh canvas always provides a 2D context.
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const scaleX = size / ROAD_MARKINGS_RECT.w;
  const scaleZ = size / ROAD_MARKINGS_RECT.h;
  ctx.setTransform(
    scaleX,
    0,
    0,
    scaleZ,
    -ROAD_MARKINGS_RECT.x0 * scaleX,
    -ROAD_MARKINGS_RECT.z0 * scaleZ
  );
  ctx.globalCompositeOperation = 'lighter';
  const WHITE = '#ff0000';
  const YELLOW = '#00ff00';
  const FONT = '"Big Shoulders Display", "Barlow Condensed", Impact, "Arial Narrow", sans-serif';
  let seed = 90210;
  /** Local mulberry32-style PRNG so the tyre marks are deterministic. */
  const random = (): number => {
    seed |= 0;
    seed = (seed + 1831565813) | 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const line = (
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    width: number,
    color: string,
    dash?: number[]
  ): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'butt';
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    ctx.moveTo(x1, z1);
    ctx.lineTo(x2, z2);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const outlineRect = (
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    width: number,
    color: string
  ): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash([]);
    ctx.strokeRect(x1, z1, x2 - x1, z2 - z1);
  };
  const fillRect = (x1: number, z1: number, x2: number, z2: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.fillRect(x1, z1, x2 - x1, z2 - z1);
  };
  /** Stencil-style text: each glyph gets a vertical gap cut through it. */
  const stencilText = (
    text: string,
    x: number,
    z: number,
    height: number,
    rotation: number,
    color: string
  ): void => {
    ctx.save();
    ctx.translate(x, z);
    ctx.rotate(rotation);
    ctx.scale(height / 100, height / 100);
    ctx.font = `900 100px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    let cursor = -ctx.measureText(text).width / 2;
    ctx.fillText(text, cursor, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    for (const char of text) {
      const charWidth = ctx.measureText(char).width;
      if (!' I1'.includes(char)) ctx.fillRect(cursor + charWidth * 0.36, -60, 4.5, 120);
      cursor += charWidth;
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.restore();
  };
  /** Diagonally hatched box with an outline. */
  const hatchedBox = (
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    color: string,
    spacing = 1.1,
    width = 0.14
  ): void => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x1, z1, x2 - x1, z2 - z1);
    ctx.clip();
    const span = x2 - x1 + (z2 - z1);
    for (let offset = 0; offset < span; offset += spacing)
      line(x1 + offset, z1, x1 + offset - (z2 - z1), z2, width, color);
    ctx.restore();
    outlineRect(x1, z1, x2, z2, 0.15, color);
  };
  /** Lane arrow; `direction` is +1/-1 along X. */
  const arrow = (x: number, z: number, direction: number, color: string): void => {
    ctx.save();
    ctx.translate(x, z);
    ctx.scale(direction, 1);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-1.6, -0.14);
    ctx.lineTo(0.5, -0.14);
    ctx.lineTo(0.5, -0.5);
    ctx.lineTo(1.7, 0);
    ctx.lineTo(0.5, 0.5);
    ctx.lineTo(0.5, 0.14);
    ctx.lineTo(-1.6, 0.14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  line(-25.6, 3.6, 16.2, 3.6, 0.15, WHITE);
  line(-25.6, 8.4, -5.6, 8.4, 0.15, WHITE);
  line(10.4, 8.4, 16.2, 8.4, 0.15, WHITE);
  line(-24, 6, -3, 6, 0.12, YELLOW, [3, 4.5]);
  line(6, 6, 15.5, 6, 0.12, YELLOW, [3, 4.5]);
  line(-23, 14, 16.2, 14, 0.15, WHITE);
  line(-23, 18.6, 16.2, 18.6, 0.15, WHITE);
  line(-23, 16.3, 15.5, 16.3, 0.1, YELLOW, [2, 6]);
  line(-23, -3.6, 16.2, -3.6, 0.12, WHITE);
  line(-23, 0.56, 16.2, 0.56, 0.12, WHITE);
  line(-23, 24.2, 16.2, 24.2, 0.12, WHITE);
  line(-37.5, 2.6, -26.4, 2.6, 0.15, YELLOW);
  line(-37.5, 9.2, -26.4, 9.2, 0.15, YELLOW);
  arrow(-14, 4.7, 1, YELLOW);
  arrow(13, 7.3, -1, YELLOW);
  arrow(-16, 15.2, 1, YELLOW);
  arrow(2, 17.5, -1, YELLOW);
  fillRect(-26.2, 3.6, -25.75, 8.4, YELLOW);
  for (let z = 2.75; z < 9; z += 1) fillRect(-31.2, z, -28.2, z + 0.5, YELLOW);
  stencilText('SLOW', -21.4, 6, 1.7, Math.PI / 2, YELLOW);
  stencilText('10', -19, 6, 1.8, Math.PI / 2, YELLOW);
  ctx.strokeStyle = YELLOW;
  ctx.lineWidth = 0.14;
  ctx.beginPath();
  ctx.ellipse(-19, 6, 1.35, 1.8, 0, 0, Math.PI * 2);
  ctx.stroke();
  line(-30.4, 2.6, -30.4, -10.2, 0.12, YELLOW);
  line(-29, 2.6, -29, -8.8, 0.12, YELLOW);
  line(-30.4, -10.2, -7, -10.2, 0.12, YELLOW);
  line(-29, -8.8, -7, -8.8, 0.12, YELLOW);
  for (let x = -28; x < -7.5; x += 2.2) line(x, -10.2, x + 0.9, -8.8, 0.1, YELLOW);
  for (let z = -7.5; z < 2; z += 2.2) line(-30.4, z, -29, z + 0.9, 0.1, YELLOW);
  const containerColumns: [number, number][] = [
    [-22.5, -10.3],
    [-5.3, 6.9],
    [10.5, 16.6]
  ];
  /** One row of container bays across all columns, labelled `prefix + n`. */
  const bayRow = (
    z1: number,
    z2: number,
    prefix: string,
    labelZ: number,
    labelRotation: number,
    skipMiddle: boolean
  ): void => {
    containerColumns.forEach((column, columnIndex) => {
      if (skipMiddle && columnIndex === 1) return;
      const slotsX = columnIndex === 2 ? 1 : 2;
      const slotsZ = z2 - z1 > 4 ? 2 : 1;
      for (let sx = 0; sx < slotsX; sx++)
        for (let sz = 0; sz < slotsZ; sz++) {
          const bayX1 = column[0] + ((column[1] - column[0]) * sx) / slotsX;
          const bayX2 = column[0] + ((column[1] - column[0]) * (sx + 1)) / slotsX;
          const bayZ1 = z1 + ((z2 - z1) * sz) / slotsZ;
          const bayZ2 = z1 + ((z2 - z1) * (sz + 1)) / slotsZ;
          outlineRect(bayX1 - 0.12, bayZ1 - 0.12, bayX2 + 0.12, bayZ2 + 0.12, 0.1, YELLOW);
        }
      stencilText(
        prefix + (columnIndex + 1),
        (column[0] + column[1]) / 2,
        labelZ,
        0.85,
        labelRotation,
        WHITE
      );
    });
  };
  bayRow(-6.34, -3.9, 'D0', -2.9, Math.PI, false);
  bayRow(0.86, 3.3, 'C0', -0.15, 0, false);
  bayRow(8.7, 13.64, 'B0', 14.75, Math.PI, true);
  bayRow(18.9, 23.84, 'A0', 17.85, 0, false);
  for (const x of [-10.3, -5.3, 6.9, 10.5])
    line(
      x + (x === -10.3 || x === 6.9 ? 0.35 : -0.35),
      -6.3,
      x + (x === -10.3 || x === 6.9 ? 0.35 : -0.35),
      23.8,
      0.1,
      WHITE,
      [1.5, 1.5]
    );
  hatchedBox(-6.6, -10.9, -0.4, -8.9, WHITE, 0.9, 0.12);
  hatchedBox(12.2, -22.6, 16.2, -16.4, WHITE);
  hatchedBox(-0.9, 5.4, 3.9, 9.9, WHITE, 0.95, 0.13);
  stencilText('KEEP CLEAR', 1.5, 10.6, 0.62, 0, WHITE);
  hatchedBox(19.8, -4.2, 27.2, 4.2, WHITE, 1.2, 0.16);
  stencilText('KEEP CLEAR', 17.4, -19.5, 0.8, Math.PI / 2, WHITE);
  line(16.9, -29.5, 16.9, 27.5, 0.15, WHITE);
  line(17.7, -29.5, 17.7, 27.5, 0.1, WHITE, [1, 1]);
  line(19.3, -29.5, 19.3, 27.5, 0.1, WHITE, [1, 1]);
  line(27.7, -29.5, 27.7, 27.5, 0.1, WHITE, [1, 1]);
  stencilText('BERTH 4', 23.5, 21.6, 1.9, 0, YELLOW);
  stencilText('BERTH 4', 23.5, -7.7, 1.7, Math.PI, YELLOW);
  for (let z = -27; z < 27; z += 9)
    stencilText(String(400 + Math.round((z + 27) / 9) * 5), 26.9, z + 2, 0.5, Math.PI / 2, YELLOW);
  ctx.lineCap = 'round';
  /** A pair of dual-wheel tyre tracks along a gentle curve. */
  const tyreTrack = (
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    bend: number,
    alpha: number
  ): void => {
    for (const axleOffset of [-0.95, 0.95])
      for (const wheelOffset of [-0.16, 0.16]) {
        ctx.strokeStyle = `rgba(0,0,255,${alpha})`;
        ctx.lineWidth = 0.26;
        ctx.beginPath();
        ctx.moveTo(x1, z1 + axleOffset + wheelOffset);
        ctx.quadraticCurveTo(
          (x1 + x2) / 2,
          (z1 + z2) / 2 + bend + axleOffset + wheelOffset,
          x2,
          z2 + axleOffset + wheelOffset
        );
        ctx.stroke();
      }
  };
  for (let i = 0; i < 46; i++) {
    const laneZ = random() < 0.68 ? 6 : 16.3;
    const startZ = laneZ + (random() - 0.5) * 2.6;
    const startX = -36 + random() * 40;
    const length = 8 + random() * 26;
    tyreTrack(
      startX,
      startZ,
      Math.min(startX + length, 28),
      startZ + (random() - 0.5) * 1.6,
      (random() - 0.5) * 1.4,
      0.1 + random() * 0.22
    );
  }
  for (let i = 0; i < 12; i++) {
    const laneZ = random() < 0.5 ? 6 : 16.3;
    const turnSign = random() < 0.5 ? -1 : 1;
    const alpha = 0.12 + random() * 0.2;
    ctx.strokeStyle = `rgba(0,0,255,${alpha})`;
    ctx.lineWidth = 0.3;
    ctx.beginPath();
    ctx.moveTo(10 + random() * 4, laneZ + (random() - 0.5) * 2);
    ctx.quadraticCurveTo(
      21 + random() * 3,
      laneZ,
      22 + random() * 4,
      laneZ + turnSign * (8 + random() * 10)
    );
    ctx.stroke();
  }
  for (let i = 0; i < 60; i++) {
    const x = -34 + random() * 62;
    const z = -8 + random() * 34;
    const length = 0.6 + random() * 2.5;
    const angle = (random() - 0.5) * 0.5;
    ctx.strokeStyle = `rgba(0,0,255,${0.15 + random() * 0.3})`;
    ctx.lineWidth = 0.12 + random() * 0.2;
    ctx.beginPath();
    ctx.moveTo(x, z);
    ctx.lineTo(x + Math.cos(angle) * length, z + Math.sin(angle) * length);
    ctx.stroke();
  }
  const texture = new CanvasTexture(canvas);
  texture.flipY = false;
  texture.colorSpace = NoColorSpace;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}
