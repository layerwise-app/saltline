// Procedural texture atlases for the effects system: volumetric smoke puffs (normal + alpha),
// additive glow sprites (soft dot, streak, starbursts, ring, fireball, flash cone) and
// surface decals (bullet holes, scorch, soot) with albedo / ORM / normal canvases.
import {
  CanvasTexture,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType
} from 'three';

interface SeededNoise {
  /** Tileable (64x64 lattice) smooth value noise. */
  noise: (x: number, y: number) => number;
  /** Fractal sum of `noise` with `octaves` octaves. */
  fbm: (x: number, y: number, octaves?: number) => number;
  /** Uniform random in [0, 1) from a mulberry32-style generator. */
  rnd: () => number;
}

function createSeededNoise(seed: number): SeededNoise {
  const lattice = new Float32Array(4096);
  let state = seed >>> 0;
  const rnd = (): number => {
    state |= 0;
    state = (state + 1831565813) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = 0; index < 4096; index++) lattice[index] = rnd();
  const noise = (x: number, y: number): number => {
    const cellX = Math.floor(x);
    const cellY = Math.floor(y);
    let fracX = x - cellX;
    let fracY = y - cellY;
    fracX = fracX * fracX * (3 - 2 * fracX);
    fracY = fracY * fracY * (3 - 2 * fracY);
    const col0 = cellX & 63;
    const col1 = (cellX + 1) & 63;
    const row0 = (cellY & 63) * 64;
    const row1 = ((cellY + 1) & 63) * 64;
    const v00 = lattice[row0 + col0];
    const v10 = lattice[row0 + col1];
    const v01 = lattice[row1 + col0];
    const v11 = lattice[row1 + col1];
    return v00 + (v10 - v00) * fracX + (v01 - v00 + (v00 - v10 - v01 + v11) * fracX) * fracY;
  };
  return {
    noise,
    fbm: (x, y, octaves = 4) => {
      let sum = 0;
      let amplitude = 0.5;
      let norm = 0;
      for (let octave = 0; octave < octaves; octave++) {
        sum += noise(x, y) * amplitude;
        norm += amplitude;
        x = x * 2.03 + 17.1;
        y = y * 2.03 + 9.7;
        amplitude *= 0.5;
      }
      return sum / norm;
    },
    rnd
  };
}

/** Clamped Hermite smoothstep of `value` between `edge0` and `edge1`. */
export const smoothstepEdge = (edge0: number, edge1: number, value: number): number => {
  let t = (value - edge0) / (edge1 - edge0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};
export const SMOKE_ATLAS_COLS = 4;
export const SMOKE_ATLAS_ROWS = 2;

/**
 * Bakes the 4x2 smoke atlas. RG = tangent-space normal, B = density/shade, A = alpha.
 * Frame 6 is a rising plume, frame 7 a denser puff, the rest are generic puffs.
 */
export function createSmokeAtlas(tileSize = 128): DataTexture {
  const width = tileSize * SMOKE_ATLAS_COLS;
  const height = tileSize * SMOKE_ATLAS_ROWS;
  const pixels = new Uint8Array(width * height * 4);
  const noiseGen = createSeededNoise(9173);
  const heightField = new Float32Array(tileSize * tileSize);
  const alphaField = new Float32Array(tileSize * tileSize);
  const shadeField = new Float32Array(tileSize * tileSize);
  for (let frame = 0; frame < SMOKE_ATLAS_COLS * SMOKE_ATLAS_ROWS; frame++) {
    const tileCol = frame % SMOKE_ATLAS_COLS;
    const tileRow = Math.floor(frame / SMOKE_ATLAS_COLS);
    const offsetA = frame * 13.37 + 3.1;
    const offsetB = frame * 7.77 + 1.3;
    for (let py = 0; py < tileSize; py++)
      for (let px = 0; px < tileSize; px++) {
        const x = ((px + 0.5) / tileSize) * 2 - 1;
        const y = ((py + 0.5) / tileSize) * 2 - 1;
        const edgeFade = 1 - smoothstepEdge(0.78, 0.98, Math.max(Math.abs(x), Math.abs(y)));
        let alpha: number;
        let shade: number;
        let bump: number;
        if (frame === 6) {
          const v = y * 0.5 + 0.5;
          const halfWidth = 0.16 + 0.5 * v * v;
          const sway = (noiseGen.fbm(x * 2 + offsetA, v * 2 + offsetB, 3) - 0.5) * 0.25;
          const column = 1 - smoothstepEdge(halfWidth * 0.3, halfWidth, Math.abs(x + sway * v));
          const detail = noiseGen.fbm(x * 9 + offsetA, v * 2.2 + offsetB, 4);
          const topFade =
            1 - smoothstepEdge(0.55, 0.95, v - (noiseGen.noise(x * 6 + offsetA, 3.3) - 0.5) * 0.35);
          const bottomFade = smoothstepEdge(0, 0.12, v);
          alpha =
            column * topFade * bottomFade * smoothstepEdge(0.22, 0.7, detail + 0.25 * (1 - v));
          shade = column * topFade;
          bump = alpha * 0.5;
        } else {
          const dense = frame === 7;
          const warpAmount = dense ? 0.3 : 0.6;
          const warpX = (noiseGen.fbm(x * 1.4 + offsetA, y * 1.4 + offsetB, 3) - 0.5) * warpAmount;
          const warpY =
            (noiseGen.fbm(x * 1.4 + offsetB + 5.2, y * 1.4 + offsetA + 1.7, 3) - 0.5) * warpAmount;
          const wx = x + warpX;
          const wy = y + warpY;
          const radius = Math.sqrt(wx * wx + wy * wy);
          const edgeNoise = (noiseGen.fbm(wx * 2.2 + offsetA, wy * 2.2 + offsetB, 3) - 0.5) * 0.6;
          const body = 1 - smoothstepEdge(0, dense ? 0.84 : 0.8, radius + edgeNoise);
          const detail = noiseGen.fbm(wx * 4.2 + offsetA * 2, wy * 4.2 + offsetB * 2, 5);
          const density = body * (dense ? 0.8 + 0.7 * detail : 0.25 + 1.5 * detail);
          alpha = smoothstepEdge(dense ? 0.02 : 0.06, dense ? 0.7 : 0.95, density);
          shade = body;
          bump =
            body * 0.55 +
            body * noiseGen.fbm(wx * 3.1 + offsetA * 3, wy * 3.1 + offsetB * 3, 3) * 0.9;
        }
        const index = py * tileSize + px;
        alphaField[index] = alpha * edgeFade;
        shadeField[index] = shade;
        heightField[index] = bump * edgeFade;
      }
    for (let py = 0; py < tileSize; py++)
      for (let px = 0; px < tileSize; px++) {
        const left = Math.max(0, px - 2);
        const right = Math.min(tileSize - 1, px + 2);
        const up = Math.max(0, py - 2);
        const down = Math.min(tileSize - 1, py + 2);
        const slopeX =
          ((heightField[py * tileSize + right] - heightField[py * tileSize + left]) * tileSize) / 8;
        const slopeY =
          ((heightField[down * tileSize + px] - heightField[up * tileSize + px]) * tileSize) / 8;
        const strength = 0.55;
        let nx = -slopeX * strength;
        let ny = -slopeY * strength;
        const invLen = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nx *= invLen;
        ny *= invLen;
        const out = ((tileRow * tileSize + py) * width + tileCol * tileSize + px) * 4;
        const index = py * tileSize + px;
        pixels[out] = Math.round((nx * 0.5 + 0.5) * 255);
        pixels[out + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        pixels[out + 2] = Math.min(255, shadeField[index] * 255);
        pixels[out + 3] = Math.min(255, alphaField[index] * 255);
      }
  }
  const texture = new DataTexture(pixels, width, height, RGBAFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export const GLOW_ATLAS_COLS = 4;
export const GLOW_ATLAS_ROWS = 2;
export const GLOW_FRAME_SOFT = 0;
export const GLOW_FRAME_STREAK = 1;
export const GLOW_FRAME_STARBURST_A = 2;
export const GLOW_FRAME_STARBURST_B = 3;
export const GLOW_FRAME_RING = 4;
export const GLOW_FRAME_FIREBALL = 5;
export const GLOW_FRAME_DOT = 6;
export const GLOW_FRAME_FLASH_CONE = 7;

interface StarburstRay {
  /** Angle (radians). */
  a: number;
  /** Length (fraction of tile radius). */
  l: number;
  /** Width. */
  w: number;
  /** Gain. */
  g: number;
}

/** Bakes the 4x2 grayscale additive glow atlas (frames are the `GLOW_FRAME_*` constants). */
export function createGlowAtlas(tileSize = 128): DataTexture {
  const width = tileSize * GLOW_ATLAS_COLS;
  const height = tileSize * GLOW_ATLAS_ROWS;
  const pixels = new Uint8Array(width * height * 4);
  const noiseGen = createSeededNoise(4441);
  const starbursts = [0, 1].map(() => {
    const rayCount = 7 + Math.floor(noiseGen.rnd() * 4);
    const rays: StarburstRay[] = [];
    for (let ray = 0; ray < rayCount; ray++)
      rays.push({
        a: (ray / rayCount + (noiseGen.rnd() - 0.5) * 0.12) * Math.PI * 2,
        l: 0.35 + noiseGen.rnd() * 0.6,
        w: 0.018 + noiseGen.rnd() * 0.05,
        g: 0.5 + noiseGen.rnd() * 0.5
      });
    return rays;
  });
  for (let frame = 0; frame < 8; frame++) {
    const tileCol = frame % GLOW_ATLAS_COLS;
    const tileRow = Math.floor(frame / GLOW_ATLAS_COLS);
    for (let py = 0; py < tileSize; py++)
      for (let px = 0; px < tileSize; px++) {
        const x = ((px + 0.5) / tileSize) * 2 - 1;
        const y = ((py + 0.5) / tileSize) * 2 - 1;
        const dist = Math.sqrt(x * x + y * y);
        const edgeFade = 1 - smoothstepEdge(0.86, 0.99, Math.max(Math.abs(x), Math.abs(y)));
        let value = 0;
        if (frame === GLOW_FRAME_SOFT) {
          const falloff = Math.max(0, 1 - dist);
          value = falloff * falloff * falloff * 0.75 + Math.exp(-dist * dist * 22) * 0.5;
        } else if (frame === GLOW_FRAME_STREAK) {
          const along = Math.pow(Math.max(0, 1 - x * x), 1.5);
          value = Math.exp(-(y * y) / (0.42 * 0.42)) * along;
        } else if (frame === GLOW_FRAME_STARBURST_A || frame === GLOW_FRAME_STARBURST_B) {
          const rays = starbursts[frame - GLOW_FRAME_STARBURST_A];
          const angle = Math.atan2(y, x);
          for (const ray of rays) {
            let delta = Math.abs(angle - ray.a) % (Math.PI * 2);
            if (delta > Math.PI) delta = Math.PI * 2 - delta;
            const across = Math.sin(Math.min(delta, 1.5)) * dist;
            if (delta < 1.5) {
              value +=
                ray.g *
                Math.exp(-(across * across) / (ray.w * ray.w * (0.4 + dist))) *
                Math.pow(Math.max(0, 1 - dist / ray.l), 1.4);
            }
          }
          value =
            value * (0.7 + 0.6 * noiseGen.fbm(x * 5 + frame * 9, y * 5, 3)) +
            Math.exp(-dist * dist * 70) * 1.2 +
            Math.max(0, 1 - dist * 2.2) * 0.06;
        } else if (frame === GLOW_FRAME_RING) {
          const angle = Math.atan2(y, x);
          const ringRadius =
            0.78 + (noiseGen.noise(Math.cos(angle) * 2 + 5, Math.sin(angle) * 2 + 5) - 0.5) * 0.04;
          value =
            Math.exp(-((dist - ringRadius) * (dist - ringRadius)) / (0.03 * 0.03)) *
              (0.6 + 0.4 * noiseGen.noise(Math.cos(angle) * 5 + 9, Math.sin(angle) * 5 + 9)) +
            0.05 * smoothstepEdge(0.2, 0.78, dist) * (1 - smoothstepEdge(0.78, 0.8, dist));
        } else if (frame === GLOW_FRAME_FIREBALL) {
          const warpX = (noiseGen.fbm(x * 1.6 + 3.3, y * 1.6 + 8.1, 3) - 0.5) * 0.5;
          const warpY = (noiseGen.fbm(x * 1.6 + 7.7, y * 1.6 + 2.2, 3) - 0.5) * 0.5;
          const wx = x + warpX;
          const wy = y + warpY;
          const radius = Math.sqrt(wx * wx + wy * wy);
          const body = 1 - smoothstepEdge(0, 0.84, radius);
          const detail = noiseGen.fbm(wx * 4 + 1.1, wy * 4 + 6.6, 5);
          value = smoothstepEdge(0.04, 0.9, body * (0.3 + 1.4 * detail)) * (0.45 + 0.75 * body);
        } else if (frame === GLOW_FRAME_DOT) {
          value = 1 - smoothstepEdge(0.3, 0.62, dist);
        } else if (frame === GLOW_FRAME_FLASH_CONE) {
          const along = x * 0.5 + 0.5;
          const spread = 0.22 + 0.3 * along;
          let cone = Math.exp(-(y * y) / (spread * spread)) * Math.pow(along, 1.8);
          const tip = (x - 0.8) / 0.16;
          if (x > 0.8) cone *= Math.max(0, 1 - tip * tip);
          value = cone * 1.15;
        }
        value *= edgeFade;
        const byte = Math.max(0, Math.min(255, value * 255));
        const out = ((tileRow * tileSize + py) * width + tileCol * tileSize + px) * 4;
        pixels[out] = pixels[out + 1] = pixels[out + 2] = byte;
        pixels[out + 3] = 255;
      }
  }
  const texture = new DataTexture(pixels, width, height, RGBAFormat, UnsignedByteType);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export const DECAL_ATLAS_COLS = 4;
export const DECAL_ATLAS_ROWS = 2;
/** Decal kind -> atlas tile indices (variants). */
export const DECAL_ATLAS_TILES = {
  bullet_metal: [0, 1],
  bullet_concrete: [2, 3],
  bullet_wood: [4],
  scorch: [5],
  soot: [6],
  bullet_glass: [7]
};
export type DecalKind = keyof typeof DECAL_ATLAS_TILES;

/** UV rectangle `[u0, v0, u1, v1]` of an atlas tile. */
export type AtlasUvRect = [number, number, number, number];

/** Decal atlas textures plus a tile -> UV rect lookup. */
export interface DecalAtlas {
  /** sRGB albedo with alpha. */
  map: CanvasTexture;
  /** Occlusion / roughness / metalness. */
  orm: CanvasTexture;
  /** Tangent-space normal map, or null when the canvas could not be read back. */
  nrm: CanvasTexture | null;
  uv: (tile: number) => AtlasUvRect;
}

type GradientStops = Array<[number, string]>;

/** Paints the 4x2 decal atlas onto canvases (color, ORM, height -> normal). */
export function createDecalAtlas(tileSize = 256): DecalAtlas {
  const width = tileSize * DECAL_ATLAS_COLS;
  const height = tileSize * DECAL_ATLAS_ROWS;
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = width;
  colorCanvas.height = height;
  const ormCanvas = document.createElement('canvas');
  ormCanvas.width = width;
  ormCanvas.height = height;
  const heightCanvas = document.createElement('canvas');
  heightCanvas.width = width;
  heightCanvas.height = height;
  const color = colorCanvas.getContext('2d')!;
  const orm = ormCanvas.getContext('2d')!;
  const heightCtx = heightCanvas.getContext('2d', {
    willReadFrequently: true
  })!;
  heightCtx.fillStyle = 'rgb(128,128,128)';
  heightCtx.fillRect(0, 0, width, height);
  /** Paints a radial gray height profile centered on the tile origin. */
  const paintHeightProfile = (stops: Array<[number, number]>, radius: number): void => {
    const gradient = heightCtx.createRadialGradient(0, 0, 0, 0, 0, radius);
    for (const [offset, level] of stops)
      gradient.addColorStop(offset, `rgb(${level},${level},${level})`);
    heightCtx.fillStyle = gradient;
    heightCtx.beginPath();
    heightCtx.arc(0, 0, radius, 0, Math.PI * 2);
    heightCtx.fill();
  };
  const rnd = createSeededNoise(77123).rnd;
  orm.fillStyle = 'rgb(0,235,0)';
  orm.fillRect(0, 0, width, height);
  const TAU = Math.PI * 2;
  /** Builds a jagged closed blob path. */
  const blobPath = (
    ctx: CanvasRenderingContext2D,
    radius: number,
    jitter: number,
    points = 22,
    squashY = 1
  ): void => {
    ctx.beginPath();
    for (let index = 0; index < points; index++) {
      const angle = (index / points) * TAU;
      const r = radius * (1 + (rnd() - 0.5) * jitter);
      const px = Math.cos(angle) * r;
      const py = Math.sin(angle) * r * squashY;
      if (index) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    }
    ctx.closePath();
  };
  /** Strokes a wandering radial crack. */
  const crack = (
    ctx: CanvasRenderingContext2D,
    startAngle: number,
    innerRadius: number,
    outerRadius: number,
    wander: number,
    lineWidth: number,
    strokeStyle: string
  ): void => {
    ctx.beginPath();
    let radius = innerRadius;
    let angle = startAngle;
    ctx.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    const segments = 5 + Math.floor(rnd() * 4);
    for (let segment = 1; segment <= segments; segment++) {
      radius = innerRadius + ((outerRadius - innerRadius) * segment) / segments;
      angle += (rnd() - 0.5) * wander;
      ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  };
  /** Runs `paint(halfSize)` with all three canvases clipped and translated to tile center. */
  const withTile = (tile: number, paint: (halfSize: number) => void): void => {
    const centerX = ((tile % DECAL_ATLAS_COLS) + 0.5) * tileSize;
    const centerY = (Math.floor(tile / DECAL_ATLAS_COLS) + 0.5) * tileSize;
    const half = tileSize / 2;
    for (const ctx of [color, orm, heightCtx]) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(centerX - half, centerY - half, tileSize, tileSize);
      ctx.clip();
      ctx.translate(centerX, centerY);
    }
    paint(half);
    color.restore();
    orm.restore();
    heightCtx.restore();
  };
  const radialGradient = (
    ctx: CanvasRenderingContext2D,
    innerRadius: number,
    outerRadius: number,
    stops: GradientStops
  ): CanvasGradient => {
    const gradient = ctx.createRadialGradient(0, 0, innerRadius, 0, 0, outerRadius);
    for (const [offset, stopColor] of stops) gradient.addColorStop(offset, stopColor);
    return gradient;
  };
  for (const tile of DECAL_ATLAS_TILES.bullet_metal)
    withTile(tile, (half) => {
      color.fillStyle = radialGradient(color, half * 0.1, half * 0.6, [
        [0, 'rgba(14,13,12,0.4)'],
        [0.5, 'rgba(18,17,16,0.14)'],
        [1, 'rgba(20,20,20,0)']
      ]);
      color.fillRect(-half, -half, 2 * half, 2 * half);
      const crackCount = 6 + Math.floor(rnd() * 5);
      for (let index = 0; index < crackCount; index++) {
        const angle = rnd() * TAU;
        crack(
          color,
          angle,
          half * 0.2,
          half * (0.38 + rnd() * 0.45),
          0.3,
          0.8 + rnd() * 1,
          'rgba(8,8,8,0.55)'
        );
      }
      const flakeRadius = half * (0.24 + rnd() * 0.08);
      const squash = 0.7 + rnd() * 0.5;
      const flakeAngle = rnd() * TAU;
      /** Paints one chipped paint flake (exposed bare metal). */
      const paintFlake = (
        offsetX: number,
        offsetY: number,
        radius: number,
        rotation: number,
        jitter: number,
        points: number
      ): void => {
        for (const ctx of [color, orm]) {
          ctx.save();
          ctx.translate(offsetX, offsetY);
          ctx.rotate(rotation);
        }
        const radii: number[] = [];
        for (let index = 0; index < points; index++) radii.push(1 + (rnd() - 0.5) * jitter);
        const flakePath = (ctx: CanvasRenderingContext2D, scale: number): void => {
          ctx.beginPath();
          for (let index = 0; index < points; index++) {
            const angle = (index / points) * TAU;
            const r = radius * radii[index] * scale;
            const px = Math.cos(angle) * r;
            const py = Math.sin(angle) * r * squash;
            if (index) ctx.lineTo(px, py);
            else ctx.moveTo(px, py);
          }
          ctx.closePath();
        };
        flakePath(color, 1);
        color.lineJoin = 'miter';
        color.strokeStyle = 'rgba(92,54,36,0.95)';
        color.lineWidth = Math.max(1.5, radius * 0.14);
        color.stroke();
        const metal = 150 + Math.floor(rnd() * 50);
        flakePath(color, 1);
        color.fillStyle = radialGradient(color, 0, radius * 1.2, [
          [0, `rgb(${metal - 30},${metal - 26},${metal - 20})`],
          [0.7, `rgb(${metal + 30},${metal + 33},${metal + 36})`],
          [1, `rgb(${metal},${metal + 3},${metal + 6})`]
        ]);
        color.fill();
        flakePath(orm, 1);
        orm.fillStyle = 'rgb(0,85,255)';
        orm.fill();
        color.restore();
        orm.restore();
      };
      paintFlake(0, 0, flakeRadius, flakeAngle, 0.75, 11);
      const chipCount = 2 + Math.floor(rnd() * 4);
      for (let index = 0; index < chipCount; index++) {
        const angle = rnd() * TAU;
        const distance = flakeRadius * (1 + rnd() * 0.7);
        paintFlake(
          Math.cos(angle) * distance,
          Math.sin(angle) * distance,
          flakeRadius * (0.15 + rnd() * 0.3),
          rnd() * TAU,
          0.8,
          7
        );
      }
      for (let index = 0; index < 9; index++) {
        const angle = rnd() * TAU;
        const inner = flakeRadius * 0.3;
        const outer = flakeRadius * (0.6 + rnd() * 0.3);
        color.beginPath();
        color.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
        color.lineTo(Math.cos(angle + 0.1) * outer, Math.sin(angle + 0.1) * outer);
        color.strokeStyle = rnd() < 0.5 ? 'rgba(245,246,248,0.7)' : 'rgba(70,72,76,0.5)';
        color.lineWidth = 0.8;
        color.stroke();
      }
      const holeRadius = half * (0.1 + rnd() * 0.025);
      const petalCount = 8 + Math.floor(rnd() * 5);
      for (let index = 0; index < petalCount; index++) {
        if (rnd() < 0.15) continue;
        const angle = ((index + (rnd() - 0.5) * 0.6) / petalCount) * TAU;
        const reach = holeRadius * (1.25 + rnd() * 0.9);
        const spread = 0.16 + rnd() * 0.16;
        const shine = 205 + Math.floor(rnd() * 50);
        color.beginPath();
        color.moveTo(
          Math.cos(angle - spread) * holeRadius * 0.9,
          Math.sin(angle - spread) * holeRadius * 0.9
        );
        color.lineTo(Math.cos(angle) * reach, Math.sin(angle) * reach);
        color.lineTo(
          Math.cos(angle + spread) * holeRadius * 0.9,
          Math.sin(angle + spread) * holeRadius * 0.9
        );
        color.closePath();
        color.fillStyle = `rgb(${shine},${shine},${Math.min(255, shine + 4)})`;
        color.fill();
        color.strokeStyle = 'rgba(40,40,42,0.6)';
        color.lineWidth = 0.7;
        color.stroke();
      }
      orm.beginPath();
      orm.arc(0, 0, holeRadius * 1.8, 0, TAU);
      orm.fillStyle = 'rgb(0,60,255)';
      orm.fill();
      blobPath(color, holeRadius, 0.3, 11);
      color.fillStyle = radialGradient(color, 0, holeRadius, [
        [0, '#000000'],
        [0.8, '#040404'],
        [1, '#141414']
      ]);
      color.fill();
      paintHeightProfile(
        [
          [0, 0],
          [0.26, 10],
          [0.36, 240],
          [0.5, 200],
          [0.62, 100],
          [1, 128]
        ],
        holeRadius * 3.4
      );
      blobPath(orm, holeRadius, 0.1, 11);
      orm.fillStyle = 'rgb(0,250,0)';
      orm.fill();
    });
  for (const tile of DECAL_ATLAS_TILES.bullet_concrete)
    withTile(tile, (half) => {
      color.fillStyle = radialGradient(color, half * 0.2, half * 0.9, [
        [0, 'rgba(186,180,168,0.22)'],
        [0.6, 'rgba(180,175,165,0.07)'],
        [1, 'rgba(170,165,155,0)']
      ]);
      color.fillRect(-half, -half, 2 * half, 2 * half);
      const crackCount = 4 + Math.floor(rnd() * 4);
      for (let index = 0; index < crackCount; index++) {
        const angle = rnd() * TAU;
        const outer = half * (0.5 + rnd() * 0.42);
        crack(color, angle, half * 0.25, outer, 0.35, 1.3 + rnd() * 1.3, 'rgba(20,19,18,0.75)');
        if (rnd() < 0.5) {
          crack(
            color,
            angle + (rnd() - 0.5) * 0.6,
            outer * 0.7,
            outer * 1.05,
            0.6,
            0.9,
            'rgba(20,19,18,0.5)'
          );
        }
      }
      const craterRadius = half * (0.33 + rnd() * 0.09);
      const points = 12;
      const radii: number[] = [];
      for (let index = 0; index < points; index++) radii.push(1 + (rnd() - 0.5) * 0.6);
      const craterPath = (
        ctx: CanvasRenderingContext2D,
        scale: number,
        offsetX: number,
        offsetY: number
      ): void => {
        ctx.beginPath();
        for (let index = 0; index < points; index++) {
          const angle = (index / points) * TAU;
          const r = craterRadius * radii[index] * scale;
          if (index) ctx.lineTo(Math.cos(angle) * r + offsetX, Math.sin(angle) * r + offsetY);
          else ctx.moveTo(Math.cos(angle) * r + offsetX, Math.sin(angle) * r + offsetY);
        }
        ctx.closePath();
      };
      craterPath(color, 1.05, 1.5, 1.5);
      color.fillStyle = 'rgba(22,21,20,0.8)';
      color.fill();
      craterPath(color, 1, 0, 0);
      color.fillStyle = radialGradient(color, craterRadius * 0.1, craterRadius * 1.1, [
        [0, '#35332f'],
        [0.4, '#6f6b63'],
        [0.8, '#8f8b82'],
        [1, '#9a968c']
      ]);
      color.fill();
      craterPath(color, 0.97, -1, -1);
      color.strokeStyle = 'rgba(206,201,190,0.55)';
      color.lineWidth = 1.2;
      color.stroke();
      for (let index = 0; index < 6; index++) {
        const angle = rnd() * TAU;
        crack(color, angle, craterRadius * 0.2, craterRadius * 0.9, 0.5, 1, 'rgba(28,27,25,0.5)');
      }
      for (let index = 0; index < 60; index++) {
        const angle = rnd() * TAU;
        const distance = Math.sqrt(rnd()) * craterRadius * 0.85;
        color.fillStyle = rnd() < 0.55 ? 'rgba(36,34,32,0.6)' : 'rgba(196,191,180,0.6)';
        color.beginPath();
        color.arc(Math.cos(angle) * distance, Math.sin(angle) * distance, 0.7 + rnd() * 2, 0, TAU);
        color.fill();
      }
      blobPath(color, craterRadius * 0.3, 0.45, 9);
      color.fillStyle = radialGradient(color, 0, craterRadius * 0.33, [
        [0, '#060606'],
        [0.7, '#161514'],
        [1, '#2c2a27']
      ]);
      color.fill();
      paintHeightProfile(
        [
          [0, 0],
          [0.24, 20],
          [0.3, 70],
          [0.8, 112],
          [0.88, 150],
          [1, 128]
        ],
        craterRadius * 1.15
      );
      for (let index = 0; index < 22; index++) {
        const angle = rnd() * TAU;
        const distance = craterRadius * (1.15 + rnd() * 1.3);
        color.fillStyle = rnd() < 0.5 ? 'rgba(190,185,175,0.45)' : 'rgba(30,29,27,0.45)';
        color.beginPath();
        color.arc(
          Math.cos(angle) * distance,
          Math.sin(angle) * distance,
          0.6 + rnd() * 1.6,
          0,
          TAU
        );
        color.fill();
      }
    });
  for (const tile of DECAL_ATLAS_TILES.bullet_wood)
    withTile(tile, (half) => {
      blobPath(color, half * 0.27, 0.7, 11, 1.45);
      color.fillStyle = 'rgba(206,182,140,0.85)';
      color.fill();
      for (let index = 0; index < 46; index++) {
        const x = (rnd() - 0.5) * half * 0.62;
        const length = half * (0.25 + rnd() * 0.6) * (1 - Math.abs(x) / (half * 0.4));
        const y = (rnd() - 0.5) * half * 0.2;
        color.beginPath();
        color.moveTo(x, y - length);
        color.lineTo(x + (rnd() - 0.5) * 5, y + length);
        color.strokeStyle = rnd() < 0.5 ? 'rgba(236,216,172,0.85)' : 'rgba(88,62,38,0.7)';
        color.lineWidth = 0.8 + rnd() * 2.2;
        color.stroke();
      }
      blobPath(color, half * 0.1, 0.5, 9, 1.1);
      color.fillStyle = radialGradient(color, 0, half * 0.12, [
        [0, '#050403'],
        [0.8, '#140f0a'],
        [1, '#3a2a1a']
      ]);
      color.fill();
      paintHeightProfile(
        [
          [0, 0],
          [0.5, 30],
          [0.8, 140],
          [1, 128]
        ],
        half * 0.17
      );
    });
  for (const tile of DECAL_ATLAS_TILES.scorch)
    withTile(tile, (half) => {
      color.fillStyle = radialGradient(color, 0, half * 0.98, [
        [0, 'rgba(6,5,5,0.92)'],
        [0.3, 'rgba(10,9,8,0.85)'],
        [0.55, 'rgba(22,18,15,0.5)'],
        [0.8, 'rgba(30,24,20,0.16)'],
        [1, 'rgba(30,24,20,0)']
      ]);
      color.fillRect(-half, -half, 2 * half, 2 * half);
      for (let index = 0; index < 90; index++) {
        const angle = rnd() * TAU;
        const inner = half * (0.1 + rnd() * 0.3);
        const outer = half * (0.5 + rnd() * 0.46);
        color.beginPath();
        color.moveTo(Math.cos(angle - 0.03) * inner, Math.sin(angle - 0.03) * inner);
        color.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
        color.lineTo(Math.cos(angle + 0.03) * inner, Math.sin(angle + 0.03) * inner);
        color.closePath();
        color.fillStyle = `rgba(8,7,6,${0.12 + rnd() * 0.3})`;
        color.fill();
      }
      for (let index = 0; index < 60; index++) {
        const angle = rnd() * TAU;
        const distance = half * (0.15 + rnd() * 0.6);
        color.fillStyle = rnd() < 0.3 ? 'rgba(150,140,128,0.25)' : 'rgba(0,0,0,0.4)';
        color.beginPath();
        color.arc(Math.cos(angle) * distance, Math.sin(angle) * distance, 1 + rnd() * 4, 0, TAU);
        color.fill();
      }
    });
  for (const tile of DECAL_ATLAS_TILES.soot)
    withTile(tile, (half) => {
      for (let index = 0; index < 14; index++) {
        const angle = rnd() * TAU;
        const distance = rnd() * half * 0.3;
        const radius = half * (0.15 + rnd() * 0.3);
        const cx = Math.cos(angle) * distance;
        const cy = Math.sin(angle) * distance;
        const gradient = color.createRadialGradient(cx, cy, 0, cx, cy, radius);
        gradient.addColorStop(0, 'rgba(8,8,8,0.4)');
        gradient.addColorStop(1, 'rgba(8,8,8,0)');
        color.fillStyle = gradient;
        color.fillRect(-half, -half, 2 * half, 2 * half);
      }
      blobPath(color, half * 0.1, 0.4, 12);
      color.fillStyle = 'rgba(0,0,0,0.9)';
      color.fill();
    });
  for (const tile of DECAL_ATLAS_TILES.bullet_glass)
    withTile(tile, (half) => {
      color.fillStyle = radialGradient(color, 0, half * 0.5, [
        [0, 'rgba(235,240,242,0.55)'],
        [1, 'rgba(235,240,242,0)']
      ]);
      color.fillRect(-half, -half, 2 * half, 2 * half);
      for (let index = 0; index < 13; index++) {
        const angle = ((index + rnd() * 0.6) / 13) * TAU;
        crack(
          color,
          angle,
          half * 0.07,
          half * (0.5 + rnd() * 0.45),
          0.12,
          0.9 + rnd(),
          'rgba(240,246,248,0.85)'
        );
      }
      for (let ring = 0; ring < 3; ring++) {
        const radius = half * (0.2 + ring * 0.17 + rnd() * 0.05);
        for (let segment = 0; segment < 9; segment++) {
          if (rnd() < 0.45) continue;
          const start = (segment / 9) * TAU;
          color.beginPath();
          color.arc(0, 0, radius, start, start + 0.5);
          color.strokeStyle = 'rgba(240,246,248,0.6)';
          color.lineWidth = 1;
          color.stroke();
        }
      }
      blobPath(color, half * 0.07, 0.3, 10);
      color.fillStyle = '#060606';
      color.fill();
    });
  const mapTexture = new CanvasTexture(colorCanvas);
  mapTexture.colorSpace = SRGBColorSpace;
  mapTexture.anisotropy = 4;
  const ormTexture = new CanvasTexture(ormCanvas);
  ormTexture.colorSpace = NoColorSpace;
  const inset = 2 / tileSize;
  const tileUv = (tile: number): AtlasUvRect => {
    const col = tile % DECAL_ATLAS_COLS;
    const row = Math.floor(tile / DECAL_ATLAS_COLS);
    return [
      (col + inset) / DECAL_ATLAS_COLS,
      1 - (row + 1 - inset) / DECAL_ATLAS_ROWS,
      (col + 1 - inset) / DECAL_ATLAS_COLS,
      1 - (row + inset) / DECAL_ATLAS_ROWS
    ];
  };
  let normalTexture: CanvasTexture | null = null;
  try {
    const source = heightCtx.getImageData(0, 0, width, height);
    const heights = source.data;
    if (heights && heights.length === width * height * 4) {
      const normals = heightCtx.createImageData(width, height);
      const out = normals.data;
      const strength = 5 / 255;
      for (let row = 0; row < height; row++) {
        const rowAbove = Math.max(0, row - 1) * width;
        const rowBelow = Math.min(height - 1, row + 1) * width;
        for (let col = 0; col < width; col++) {
          const colLeft = Math.max(0, col - 1);
          const colRight = Math.min(width - 1, col + 1);
          const dx =
            (heights[(row * width + colRight) * 4] - heights[(row * width + colLeft) * 4]) *
            strength;
          const dy = (heights[(rowBelow + col) * 4] - heights[(rowAbove + col) * 4]) * strength;
          const invLen = 1 / Math.sqrt(dx * dx + dy * dy + 1);
          const index = (row * width + col) * 4;
          out[index] = (-dx * invLen * 0.5 + 0.5) * 255;
          out[index + 1] = (dy * invLen * 0.5 + 0.5) * 255;
          out[index + 2] = (invLen * 0.5 + 0.5) * 255;
          out[index + 3] = 255;
        }
      }
      heightCtx.putImageData(normals, 0, 0);
      normalTexture = new CanvasTexture(heightCanvas);
      normalTexture.colorSpace = NoColorSpace;
    }
  } catch {
    normalTexture = null;
  }
  return {
    map: mapTexture,
    orm: ormTexture,
    nrm: normalTexture,
    uv: tileUv
  };
}
