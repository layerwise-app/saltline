/**
 * Canvas-painted decals (hazard signs, shipping-line logos, grime, rust, bullet holes, cracks,
 * graffiti, stencilled labels and digits) turned into transparent `MeshStandardMaterial`s, plus the
 * two small post-process shaders used by the surface baker (height -> normal, albedo copy).
 */
import {
  CanvasTexture,
  DoubleSide,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  SRGBColorSpace
} from 'three';
import type { Game } from '../core/types';

/** Bake pass: converts a 16-bit packed height texture (`tH`) into a tangent-space normal map. */
export const HEIGHT_TO_NORMAL_FRAG = `
precision highp float;
uniform sampler2D tH; uniform vec2 uK; uniform float uTexel; in vec2 vUv; out vec4 o;
float H(vec2 uv){ vec4 t = texture(tH, uv); return t.r + t.g / 255.0; }
void main(){
  vec2 e = vec2(uTexel, 0.0);
  float l = H(vUv - e.xy), r = H(vUv + e.xy), d = H(vUv - e.yx), u = H(vUv + e.yx);
  float ld = H(vUv - e.xx), rd = H(vUv + vec2(e.x, -e.x)), lu = H(vUv + vec2(-e.x, e.x)), ru = H(vUv + e.xx);
  float gx = (r - l) * 0.5 + (ru + rd - lu - ld) * 0.25, gy = (u - d) * 0.5 + (ru + lu - rd - ld) * 0.25;
  vec3 n = normalize(vec3(-gx * uK.x, -gy * uK.y, 1.0));
  o = vec4(n * 0.5 + 0.5, 1.0);
}`;

/** Bake pass: copies an MRT attachment into a mipmapped target, optionally squaring rgb (`uSq`). */
export const ALBEDO_COPY_FRAG = `
precision highp float;
uniform sampler2D tA; uniform float uSq; in vec2 vUv; out vec4 o;
void main(){ vec4 t = texture(tA, vUv); o = uSq > 0.5 ? vec4(t.rgb * t.rgb, t.a) : t; }`;

/** An 8-bit RGB triple. */
type RgbColor = readonly number[];
type Ctx2D = CanvasRenderingContext2D;
type RandomFn = () => number;

const DISPLAY_FONT_STACK =
  '"Big Shoulders Display", "Barlow Condensed", "Arial Narrow", Impact, "Helvetica Neue", Arial, sans-serif';
const SANS_FONT_STACK = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const MONO_FONT_STACK = '"IBM Plex Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace';
const SIGN_COLORS: Record<string, RgbColor> = {
  white: [226, 223, 213],
  black: [24, 24, 26],
  yellow: [222, 172, 30],
  red: [168, 36, 28],
  navy: [24, 38, 58],
  orange: [206, 100, 30]
};
const rgbaCss = (rgb: RgbColor, alpha = 1): string =>
  `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
/** Glyphs that get no stencil bridge (cut-out gap) through their middle. */
const STENCIL_UNBRIDGED_CHARS = new Set(['I', '1', ' ', '-', '.', '/', ':', ',', "'", '!', '\xB7']);

/** Small seeded PRNG (mulberry32-style) so each decal paints identically every time. */
function createDecalRng(seed: number): RandomFn {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 1831565813) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1aHash(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** Traces a closed, randomly wobbling circle-ish path (caller fills/strokes it). */
function wobblyBlobPath(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  radius: number,
  rand: RandomFn,
  wobble = 0.35,
  points = 9
): void {
  ctx.beginPath();
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const r = radius * (1 - wobble + rand() * wobble * 2);
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

/** Erodes painted art: chips, scratches, speckle and soft fade patches (`amount` 0..1). */
function weatherDecal(ctx: Ctx2D, width: number, height: number, amount: number, rand: RandomFn) {
  if (amount <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  const chipCount = Math.floor((amount * width * height) / 700);
  for (let i = 0; i < chipCount; i++) {
    const radius = Math.pow(rand(), 3) * height * 0.09 + 0.6;
    ctx.globalAlpha = 0.45 + rand() * 0.55;
    wobblyBlobPath(ctx, rand() * width, rand() * height, radius, rand, 0.5, 7);
    ctx.fill();
  }
  ctx.lineCap = 'round';
  for (let i = 0; i < amount * 16; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const angle = (rand() - 0.5) * 0.7;
    const length = (0.1 + rand() * 0.5) * width;
    ctx.globalAlpha = 0.5 + rand() * 0.5;
    ctx.lineWidth = 0.5 + rand() * rand() * 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.8;
  for (let i = 0; i < (amount * width * height) / 60; i++) {
    ctx.fillRect(rand() * width, rand() * height, 1 + rand(), 1 + rand());
  }
  for (let i = 0; i < amount * 6; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const radius = (0.1 + rand() * 0.25) * height;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, 'rgba(0,0,0,' + (0.25 + rand() * 0.4) + ')');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  ctx.restore();
}

function measureSpacedText(
  ctx: Ctx2D,
  text: string,
  size: number,
  fontStack: string,
  weight: number,
  spacing: number
): number {
  ctx.font = `${weight} ${size}px ${fontStack}`;
  let width = 0;
  for (const ch of text) width += ctx.measureText(ch).width + spacing;
  return width - spacing;
}

interface StencilTextOptions {
  /** 'sans' | 'mono'; anything else uses the display (stencil) face. */
  font?: string;
  weight?: number;
  spacing?: number;
  /** Cut stencil bridges through glyphs (display face only, default true). */
  bridges?: boolean;
  maxW?: number;
  fitW?: number;
  align?: 'left' | 'center' | 'right';
}

/** Draws letter-spaced (optionally stencil-bridged) text; returns the drawn width. */
function drawStencilText(
  ctx: Ctx2D,
  text: string,
  x: number,
  baselineY: number,
  size: number,
  fillStyle: string,
  options: StencilTextOptions = {}
): number {
  const fontStack =
    options.font === 'sans'
      ? SANS_FONT_STACK
      : options.font === 'mono'
        ? MONO_FONT_STACK
        : DISPLAY_FONT_STACK;
  const weight = options.weight || 700;
  const spacing = options.spacing !== undefined ? options.spacing : size * 0.06;
  const bridged = options.font !== 'sans' && options.font !== 'mono' && options.bridges !== false;
  const width = measureSpacedText(ctx, text, size, fontStack, weight, spacing);
  const squeeze =
    options.maxW && width > options.maxW
      ? options.maxW / width
      : options.fitW
        ? options.fitW / width
        : 1;
  const scratch = createCanvas(Math.ceil(width * squeeze) + 8, Math.ceil(size * 1.4));
  const sctx = scratch.getContext('2d')!;
  sctx.font = `${weight} ${size}px ${fontStack}`;
  sctx.textBaseline = 'alphabetic';
  sctx.fillStyle = fillStyle;
  sctx.scale(squeeze, 1);
  let penX = 4 / squeeze;
  const penY = size * 1.08;
  for (const ch of text) {
    const glyphWidth = sctx.measureText(ch).width;
    sctx.fillText(ch, penX, penY);
    if (bridged && !STENCIL_UNBRIDGED_CHARS.has(ch)) {
      sctx.save();
      sctx.globalCompositeOperation = 'destination-out';
      sctx.fillRect(penX + glyphWidth * 0.5 - size * 0.032, 0, size * 0.064, size * 1.4);
      sctx.restore();
    }
    penX += glyphWidth + spacing;
  }
  const left =
    options.align === 'center'
      ? x - (width * squeeze) / 2
      : options.align === 'right'
        ? x - width * squeeze
        : x;
  ctx.drawImage(scratch, left - 4, baselineY - penY);
  return width * squeeze;
}

/** A decal material and its width/height aspect ratio. */
export interface DecalEntry {
  material: MeshStandardMaterial;
  aspect: number;
}

/** Options for `label()`. */
export interface LabelOptions {
  /** Key of the sign palette (white, black, yellow, red, navy, orange); default white. */
  color?: string;
  /** 'sans' for the condensed sans face, otherwise stencil. */
  font?: string;
  /** Weathering amount 0..1 (default 0.35). */
  distress?: number | string;
}

/** Decal factory returned by `createDecalLibrary`. */
export interface DecalLibrary {
  /** Named decal (falls back to `grime_streak` for unknown names). */
  decal(name: string): DecalEntry;
  /** Stencilled text label, cached per text/colour/font/distress. */
  label(text?: string | number, options?: LabelOptions): DecalEntry;
  /** A single stencilled digit (`n mod 10`). */
  number(n: number): DecalEntry;
  names: string[];
  /** Approximate GPU bytes used by decal textures. */
  bytes(): number;
}

interface DecalPaintOptions {
  rough?: number;
  metal?: number;
  opacity?: number;
  doubleSide?: boolean;
  /** Colour painted at near-zero alpha everywhere so mip filtering doesn't bleed black edges. */
  bleed?: RgbColor;
  /** Contains text: repaint once web fonts finish loading. */
  text?: boolean;
}

interface PaintedDecal extends DecalEntry {
  texture: CanvasTexture;
}

type DecalPainter = (ctx: Ctx2D, width: number, height: number, rand: RandomFn) => void;
type EmblemPainter = (ctx: Ctx2D, size: number, accentCss: string) => void;

/**
 * Creates the canvas decal library. Decals are painted lazily on first use and cached; decals with
 * text are repainted once the web fonts load.
 */
export function createDecalLibrary(game: Game, anisotropy = 4): DecalLibrary {
  const cache = new Map<string, DecalEntry>();
  const textRepainters: Array<() => void> = [];
  let decalBytes = 0;

  function createDecalMaterial(
    canvas: HTMLCanvasElement,
    options: DecalPaintOptions = {}
  ): PaintedDecal {
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = anisotropy;
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    decalBytes += canvas.width * canvas.height * 4 * 1.34;
    const material = new MeshStandardMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      roughness: options.rough !== undefined ? options.rough : 0.7,
      metalness: options.metal || 0,
      opacity: options.opacity !== undefined ? options.opacity : 1
    });
    material.name = 'decal';
    if (options.doubleSide) material.side = DoubleSide;
    return {
      material,
      aspect: canvas.width / canvas.height,
      texture
    };
  }

  function paintDecal(
    key: string,
    width: number,
    height: number,
    painter: DecalPainter,
    options: DecalPaintOptions = {}
  ): PaintedDecal {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    const repaint = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (options.bleed) {
        ctx.fillStyle = rgbaCss(options.bleed, 0.012);
        ctx.fillRect(0, 0, width, height);
      }
      painter(ctx, width, height, createDecalRng(fnv1aHash(key) + 17));
    };
    repaint();
    const decal = createDecalMaterial(canvas, options);
    if (options.text) {
      textRepainters.push(() => {
        repaint();
        decal.texture.needsUpdate = true;
      });
    }
    return decal;
  }

  function drawWarningTriangle(ctx: Ctx2D, width: number, height: number, fill: string) {
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(width / 2, height * 0.12);
    ctx.lineTo(width * 0.9, height * 0.84);
    ctx.lineTo(width * 0.1, height * 0.84);
    ctx.closePath();
    ctx.lineWidth = width * 0.11;
    ctx.strokeStyle = rgbaCss(SIGN_COLORS.black);
    ctx.stroke();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = width * 0.035;
    ctx.strokeStyle = rgbaCss(SIGN_COLORS.black);
    ctx.stroke();
  }

  /** Shipping-line logo: emblem on the left, big name, rule, small subtitle. */
  function drawCompanyLogo(
    ctx: Ctx2D,
    width: number,
    height: number,
    color: RgbColor,
    drawEmblem: EmblemPainter,
    title: string,
    subtitle: string,
    accent?: RgbColor
  ) {
    ctx.fillStyle = ctx.strokeStyle = rgbaCss(color);
    const unit = height;
    ctx.save();
    ctx.translate(unit * 0.5, unit * 0.5);
    drawEmblem(ctx, unit * 0.38, rgbaCss(accent || color));
    ctx.restore();
    drawStencilText(ctx, title, unit * 1, height * 0.6, height * 0.42, rgbaCss(color), {
      weight: 900,
      bridges: false,
      maxW: width - unit * 1.05,
      spacing: height * 0.012
    });
    ctx.fillStyle = rgbaCss(accent || color);
    ctx.fillRect(unit * 1, height * 0.67, width - unit * 1.12, height * 0.022);
    drawStencilText(ctx, subtitle, unit * 1, height * 0.84, height * 0.115, rgbaCss(color), {
      font: 'sans',
      weight: 600,
      spacing: height * 0.035,
      maxW: width - unit * 1.1
    });
  }

  const painters: Record<string, () => PaintedDecal> = {
    hazard_flammable: () =>
      paintDecal(
        'hazard_flammable',
        256,
        256,
        (ctx, w, h, rand) => {
          ctx.save();
          ctx.translate(w / 2, h / 2);
          ctx.rotate(Math.PI / 4);
          ctx.fillStyle = rgbaCss(SIGN_COLORS.red);
          ctx.fillRect(-86, -86, 172, 172);
          ctx.strokeStyle = rgbaCss(SIGN_COLORS.white);
          ctx.lineWidth = 5;
          ctx.strokeRect(-76, -76, 152, 152);
          ctx.restore();
          ctx.save();
          ctx.translate(w / 2, h / 2 - 8);
          ctx.fillStyle = rgbaCss(SIGN_COLORS.white);
          ctx.beginPath();
          ctx.moveTo(2, -64);
          ctx.bezierCurveTo(34, -28, 40, 6, 24, 28);
          ctx.bezierCurveTo(12, 44, -12, 44, -24, 28);
          ctx.bezierCurveTo(-40, 6, -20, -12, -15, -34);
          ctx.bezierCurveTo(-6, -28, 0, -44, 2, -64);
          ctx.fill();
          ctx.fillStyle = rgbaCss(SIGN_COLORS.red);
          ctx.beginPath();
          ctx.moveTo(1, -10);
          ctx.bezierCurveTo(15, 6, 15, 24, 0, 31);
          ctx.bezierCurveTo(-15, 24, -13, 8, 1, -10);
          ctx.fill();
          ctx.fillStyle = rgbaCss(SIGN_COLORS.white);
          ctx.fillRect(-34, 50, 68, 6);
          ctx.restore();
          drawStencilText(ctx, '3', w / 2, h * 0.9, 34, rgbaCss(SIGN_COLORS.white), {
            align: 'center',
            weight: 900,
            bridges: false
          });
          weatherDecal(ctx, w, h, 0.3, rand);
        },
        {
          bleed: SIGN_COLORS.red,
          text: true
        }
      ),
    hazard_voltage: () =>
      paintDecal(
        'hazard_voltage',
        256,
        256,
        (ctx, w, h, rand) => {
          drawWarningTriangle(ctx, w, h, rgbaCss(SIGN_COLORS.yellow));
          ctx.fillStyle = rgbaCss(SIGN_COLORS.black);
          ctx.save();
          ctx.translate(w / 2, h * 0.56);
          ctx.beginPath();
          [
            [12, -58],
            [-24, 4],
            [-3, 4],
            [-16, 50],
            [26, -14],
            [5, -14],
            [22, -58]
          ].forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          weatherDecal(ctx, w, h, 0.3, rand);
        },
        {
          bleed: SIGN_COLORS.yellow
        }
      ),
    hazard_general: () =>
      paintDecal(
        'hazard_general',
        256,
        256,
        (ctx, w, h, rand) => {
          drawWarningTriangle(ctx, w, h, rgbaCss(SIGN_COLORS.yellow));
          ctx.fillStyle = rgbaCss(SIGN_COLORS.black);
          ctx.beginPath();
          ctx.moveTo(w / 2 - 13, h * 0.34);
          ctx.lineTo(w / 2 + 13, h * 0.34);
          ctx.lineTo(w / 2 + 7, h * 0.62);
          ctx.lineTo(w / 2 - 7, h * 0.62);
          ctx.closePath();
          ctx.fill();
          ctx.beginPath();
          ctx.arc(w / 2, h * 0.715, 11, 0, 7);
          ctx.fill();
          weatherDecal(ctx, w, h, 0.3, rand);
        },
        {
          bleed: SIGN_COLORS.yellow
        }
      ),
    arrow: () =>
      paintDecal(
        'arrow',
        384,
        192,
        (ctx, w, h, rand) => {
          ctx.fillStyle = rgbaCss(SIGN_COLORS.white);
          ctx.beginPath();
          [
            [20, 68],
            [226, 68],
            [226, 22],
            [364, 96],
            [226, 170],
            [226, 124],
            [20, 124]
          ].forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
          ctx.closePath();
          ctx.fill();
          ctx.globalCompositeOperation = 'destination-out';
          ctx.fillRect(118, 0, 9, h);
          ctx.fillRect(232, 0, 7, h);
          ctx.globalCompositeOperation = 'source-over';
          weatherDecal(ctx, w, h, 0.5, rand);
        },
        {
          bleed: SIGN_COLORS.white
        }
      ),
    no_entry: () =>
      paintDecal(
        'no_entry',
        256,
        256,
        (ctx, w, h, rand) => {
          ctx.fillStyle = rgbaCss(SIGN_COLORS.white);
          ctx.beginPath();
          ctx.arc(128, 128, 112, 0, 7);
          ctx.fill();
          ctx.fillStyle = rgbaCss(SIGN_COLORS.red);
          ctx.beginPath();
          ctx.arc(128, 128, 102, 0, 7);
          ctx.fill();
          ctx.fillStyle = rgbaCss(SIGN_COLORS.white);
          ctx.fillRect(52, 106, 152, 44);
          weatherDecal(ctx, w, h, 0.3, rand);
        },
        {
          bleed: SIGN_COLORS.red
        }
      ),
    logo_a: () =>
      paintDecal(
        'logo_a',
        640,
        192,
        (ctx, w, h, rand) => {
          drawCompanyLogo(
            ctx,
            w,
            h,
            SIGN_COLORS.white,
            (e, s) => {
              e.lineWidth = s * 0.13;
              e.beginPath();
              e.arc(0, 0, s * 0.92, 0.25 * Math.PI, 1.75 * Math.PI);
              e.stroke();
              e.beginPath();
              e.moveTo(0, -s * 1.08);
              e.lineTo(s * 0.26, 0);
              e.lineTo(0, s * 0.62);
              e.lineTo(-s * 0.26, 0);
              e.closePath();
              e.fill();
              e.beginPath();
              e.moveTo(s * 0.5, 0);
              e.lineTo(s * 1.12, -s * 0.1);
              e.lineTo(s * 1.12, s * 0.1);
              e.closePath();
              e.fill();
            },
            'NORDKAP LINE',
            'ARCTIC  \xB7  ATLANTIC  \xB7  FEEDER'
          );
          weatherDecal(ctx, w, h, 0.35, rand);
        },
        {
          bleed: SIGN_COLORS.white,
          text: true
        }
      ),
    logo_b: () =>
      paintDecal(
        'logo_b',
        640,
        192,
        (ctx, w, h, rand) => {
          drawCompanyLogo(
            ctx,
            w,
            h,
            SIGN_COLORS.white,
            (e, s, accent) => {
              e.fillStyle = accent;
              for (let i = 0; i < 2; i++) {
                const y = -s * 0.35 + i * s * 0.55;
                const thick = s * (0.3 - i * 0.06);
                e.beginPath();
                e.moveTo(-s * 1.05, y - s * 0.25);
                e.quadraticCurveTo(-s * 0.3, y - s * 0.2, 0, y + s * 0.35);
                e.quadraticCurveTo(s * 0.3, y - s * 0.2, s * 1.05, y - s * 0.25);
                e.quadraticCurveTo(s * 0.35, y + thick * 0.2, 0, y + s * 0.35 + thick);
                e.quadraticCurveTo(-s * 0.35, y + thick * 0.2, -s * 1.05, y - s * 0.25);
                e.fill();
              }
            },
            'TERN OCEANIC',
            'CONTAINER SERVICES',
            SIGN_COLORS.orange
          );
          weatherDecal(ctx, w, h, 0.35, rand);
        },
        {
          bleed: SIGN_COLORS.white,
          text: true
        }
      ),
    logo_c: () =>
      paintDecal(
        'logo_c',
        640,
        192,
        (ctx, w, h, rand) => {
          drawCompanyLogo(
            ctx,
            w,
            h,
            SIGN_COLORS.navy,
            (e, s) => {
              e.beginPath();
              e.arc(0, s * 0.25, s * 0.55, Math.PI, 0);
              e.closePath();
              e.fill();
              e.lineWidth = s * 0.1;
              e.lineCap = 'butt';
              for (let i = 0; i < 7; i++) {
                const angle = Math.PI + ((i + 0.5) / 7) * Math.PI;
                e.beginPath();
                e.moveTo(Math.cos(angle) * s * 0.7, s * 0.25 + Math.sin(angle) * s * 0.7);
                e.lineTo(Math.cos(angle) * s * 1.05, s * 0.25 + Math.sin(angle) * s * 1.05);
                e.stroke();
              }
              e.fillRect(-s * 1.05, s * 0.42, s * 2.1, s * 0.13);
              e.fillRect(-s * 0.8, s * 0.68, s * 1.6, s * 0.1);
            },
            'AUREL PACIFIC',
            'DEEP SEA  \xB7  REEFER  \xB7  BULK'
          );
          weatherDecal(ctx, w, h, 0.35, rand);
        },
        {
          bleed: SIGN_COLORS.navy,
          text: true
        }
      ),
    logo_d: () =>
      paintDecal(
        'logo_d',
        640,
        192,
        (ctx, w, h, rand) => {
          drawCompanyLogo(
            ctx,
            w,
            h,
            SIGN_COLORS.white,
            (e, s, accent) => {
              e.fillRect(-s, -s, s * 0.5, s * 2);
              e.fillRect(s * 0.5, -s, s * 0.5, s * 2);
              e.fillRect(-s, -s * 0.2, s * 2, s * 0.4);
              e.fillStyle = accent;
              e.fillRect(-s * 0.32, -s, s * 0.64, s * 0.5);
              e.fillRect(-s * 0.32, s * 0.5, s * 0.64, s * 0.5);
            },
            'HOLMGARD',
            'INTERMODAL  FREIGHT',
            SIGN_COLORS.yellow
          );
          weatherDecal(ctx, w, h, 0.35, rand);
        },
        {
          bleed: SIGN_COLORS.white,
          text: true
        }
      ),
    berth4: () =>
      paintDecal(
        'berth4',
        640,
        224,
        (ctx, w, h, rand) => {
          ctx.strokeStyle = rgbaCss(SIGN_COLORS.yellow);
          ctx.lineWidth = 12;
          ctx.strokeRect(14, 14, w - 28, h - 28);
          ctx.globalCompositeOperation = 'destination-out';
          for (const x of [w * 0.25, w * 0.75]) ctx.fillRect(x - 6, 0, 12, h);
          ctx.globalCompositeOperation = 'source-over';
          drawStencilText(ctx, 'BERTH 4', w / 2, h * 0.76, h * 0.66, rgbaCss(SIGN_COLORS.yellow), {
            align: 'center',
            weight: 900,
            maxW: w - 80
          });
          weatherDecal(ctx, w, h, 0.55, rand);
        },
        {
          bleed: SIGN_COLORS.yellow,
          text: true
        }
      ),
    caution_stripes: () =>
      paintDecal(
        'caution_stripes',
        512,
        128,
        (ctx, w, h, rand) => {
          ctx.fillStyle = rgbaCss(SIGN_COLORS.black);
          ctx.fillRect(0, 8, w, h - 16);
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 8, w, h - 16);
          ctx.clip();
          ctx.fillStyle = rgbaCss(SIGN_COLORS.yellow);
          for (let x = -h; x < w + h; x += 64) {
            ctx.beginPath();
            ctx.moveTo(x, h);
            ctx.lineTo(x + 32, h);
            ctx.lineTo(x + 32 + h, 0);
            ctx.lineTo(x + h, 0);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
          weatherDecal(ctx, w, h, 0.5, rand);
        },
        {
          bleed: SIGN_COLORS.black
        }
      ),
    grime_streak: () =>
      paintDecal(
        'grime_streak',
        128,
        256,
        (ctx, w, h, rand) => {
          for (let i = 0; i < 46; i++) {
            const x = w * (0.12 + 0.76 * (rand() * 0.5 + rand() * 0.5));
            const length = h * (0.25 + rand() * 0.7);
            const width = 1.5 + rand() * rand() * 12;
            const alpha = 0.05 + rand() * 0.16;
            const gradient = ctx.createLinearGradient(0, 0, 0, length);
            gradient.addColorStop(0, `rgba(26,23,19,${alpha})`);
            gradient.addColorStop(0.15, `rgba(26,23,19,${alpha * 1.3})`);
            gradient.addColorStop(1, 'rgba(26,23,19,0)');
            ctx.fillStyle = gradient;
            ctx.fillRect(x - width / 2 + (rand() - 0.5) * 2, 0, width, length);
          }
        },
        {
          rough: 0.85,
          bleed: [26, 23, 19]
        }
      ),
    rust_run: () =>
      paintDecal(
        'rust_run',
        128,
        256,
        (ctx, w, h, rand) => {
          for (let i = 0; i < 40; i++) {
            const x = w * (0.2 + 0.6 * (rand() * 0.5 + rand() * 0.5));
            const length = h * (0.2 + rand() * 0.75);
            const width = 1.2 + rand() * rand() * 9;
            const alpha = 0.08 + rand() * 0.22;
            const rgb = rand() < 0.5 ? '118,52,18' : '150,78,26';
            const gradient = ctx.createLinearGradient(0, 8, 0, length);
            gradient.addColorStop(0, `rgba(${rgb},${alpha * 1.4})`);
            gradient.addColorStop(0.3, `rgba(${rgb},${alpha})`);
            gradient.addColorStop(1, `rgba(${rgb},0)`);
            ctx.fillStyle = gradient;
            ctx.fillRect(x - width / 2, 8, width, length);
          }
          for (let i = 0; i < 9; i++) {
            ctx.fillStyle = `rgba(${rand() < 0.5 ? '70,30,14' : '104,44,16'},${0.5 + rand() * 0.4})`;
            wobblyBlobPath(
              ctx,
              w * (0.3 + rand() * 0.4),
              6 + rand() * 12,
              3 + rand() * 8,
              rand,
              0.5,
              7
            );
            ctx.fill();
          }
        },
        {
          rough: 0.9,
          bleed: [118, 52, 18]
        }
      ),
    oil_stain: () =>
      paintDecal(
        'oil_stain',
        256,
        256,
        (ctx, w, h, rand) => {
          for (let i = 0; i < 26; i++) {
            const angle = rand() * 7;
            const dist = Math.pow(rand(), 1.5) * w * 0.26;
            const x = w / 2 + Math.cos(angle) * dist;
            const y = h / 2 + Math.sin(angle) * dist * 0.8;
            const radius = w * (0.06 + rand() * 0.16);
            const gradient = ctx.createRadialGradient(x, y, radius * 0.2, x, y, radius);
            gradient.addColorStop(0, `rgba(10,10,11,${0.35 + rand() * 0.3})`);
            gradient.addColorStop(0.75, 'rgba(12,11,10,0.22)');
            gradient.addColorStop(1, 'rgba(12,11,10,0)');
            ctx.fillStyle = gradient;
            ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
          }
          for (let i = 0; i < 30; i++) {
            ctx.fillStyle = `rgba(10,10,11,${0.3 + rand() * 0.4})`;
            const angle = rand() * 7;
            const dist = w * (0.25 + rand() * 0.2);
            ctx.beginPath();
            ctx.arc(
              w / 2 + Math.cos(angle) * dist,
              h / 2 + Math.sin(angle) * dist,
              1 + rand() * 4,
              0,
              7
            );
            ctx.fill();
          }
        },
        {
          rough: 0.12,
          bleed: [10, 10, 11]
        }
      ),
    leak_stain: () =>
      paintDecal(
        'leak_stain',
        192,
        256,
        (ctx, w, h, rand) => {
          for (let i = 0; i < 18; i++) {
            const x = w * (0.3 + rand() * 0.4);
            const y = h * (0.12 + rand() * 0.2);
            const radius = w * (0.1 + rand() * 0.2);
            const gradient = ctx.createRadialGradient(x, y, radius * 0.5, x, y, radius);
            gradient.addColorStop(0, 'rgba(150,146,130,0.0)');
            gradient.addColorStop(0.8, `rgba(168,162,140,${0.18 + rand() * 0.2})`);
            gradient.addColorStop(1, 'rgba(168,162,140,0)');
            ctx.fillStyle = gradient;
            ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
          }
          for (let i = 0; i < 22; i++) {
            const x = w * (0.25 + 0.5 * rand());
            const length = h * (0.3 + rand() * 0.6);
            const width = 2 + rand() * 9;
            const alpha = 0.08 + rand() * 0.16;
            const rgb = rand() < 0.6 ? '160,154,132' : '60,66,52';
            const gradient = ctx.createLinearGradient(0, h * 0.2, 0, h * 0.2 + length);
            gradient.addColorStop(0, `rgba(${rgb},${alpha})`);
            gradient.addColorStop(1, `rgba(${rgb},0)`);
            ctx.fillStyle = gradient;
            ctx.fillRect(x, h * 0.2, width, length);
          }
        },
        {
          rough: 0.8,
          bleed: [160, 154, 132]
        }
      ),
    bullet_metal: () =>
      paintDecal(
        'bullet_metal',
        128,
        128,
        (ctx, w, h, rand) => {
          ctx.fillStyle = 'rgba(96,52,40,0.9)';
          wobblyBlobPath(ctx, 64, 64, 30, rand, 0.4, 11);
          ctx.fill();
          ctx.fillStyle = 'rgba(150,152,156,0.95)';
          wobblyBlobPath(ctx, 64, 64, 22, rand, 0.3, 12);
          ctx.fill();
          ctx.strokeStyle = 'rgba(205,207,210,0.9)';
          ctx.lineWidth = 1;
          for (let i = 0; i < 14; i++) {
            const angle = rand() * 7;
            ctx.beginPath();
            ctx.moveTo(64 + Math.cos(angle) * 9, 64 + Math.sin(angle) * 9);
            ctx.lineTo(
              64 + Math.cos(angle) * (16 + rand() * 10),
              64 + Math.sin(angle) * (16 + rand() * 10)
            );
            ctx.stroke();
          }
          const hole = ctx.createRadialGradient(64, 64, 2, 64, 64, 12);
          hole.addColorStop(0, 'rgba(4,4,5,1)');
          hole.addColorStop(0.75, 'rgba(10,10,12,1)');
          hole.addColorStop(1, 'rgba(70,72,76,0.9)');
          ctx.fillStyle = hole;
          wobblyBlobPath(ctx, 64, 64, 12, rand, 0.15, 12);
          ctx.fill();
          ctx.strokeStyle = 'rgba(230,232,235,0.85)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(64, 64, 12.5, 3.6, 5.6);
          ctx.stroke();
        },
        {
          rough: 0.4,
          metal: 0.8,
          bleed: [96, 52, 40]
        }
      ),
    bullet_concrete: () =>
      paintDecal(
        'bullet_concrete',
        128,
        128,
        (ctx, w, h, rand) => {
          const dust = ctx.createRadialGradient(64, 64, 20, 64, 64, 60);
          dust.addColorStop(0, 'rgba(176,172,162,0.5)');
          dust.addColorStop(1, 'rgba(176,172,162,0)');
          ctx.fillStyle = dust;
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = 'rgba(168,164,154,0.95)';
          wobblyBlobPath(ctx, 64, 64, 32, rand, 0.35, 13);
          ctx.fill();
          ctx.fillStyle = 'rgba(120,116,108,0.95)';
          wobblyBlobPath(ctx, 65, 66, 20, rand, 0.35, 11);
          ctx.fill();
          ctx.strokeStyle = 'rgba(40,38,36,0.8)';
          ctx.lineWidth = 1;
          for (let i = 0; i < 6; i++) {
            let angle = rand() * 7;
            let x = 64 + Math.cos(angle) * 14;
            let y = 64 + Math.sin(angle) * 14;
            ctx.beginPath();
            ctx.moveTo(x, y);
            for (let j = 0; j < 5; j++) {
              angle += (rand() - 0.5) * 0.9;
              x += Math.cos(angle) * 8;
              y += Math.sin(angle) * 8;
              ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
          const hole = ctx.createRadialGradient(64, 64, 1, 64, 64, 11);
          hole.addColorStop(0, 'rgba(18,17,16,1)');
          hole.addColorStop(1, 'rgba(60,58,54,0.95)');
          ctx.fillStyle = hole;
          wobblyBlobPath(ctx, 64, 64, 10, rand, 0.3, 9);
          ctx.fill();
          for (let i = 0; i < 40; i++) {
            ctx.fillStyle = `rgba(${rand() < 0.5 ? '90,86,80' : '190,186,176'},0.8)`;
            const angle = rand() * 7;
            const dist = 10 + rand() * 24;
            ctx.fillRect(
              64 + Math.cos(angle) * dist,
              64 + Math.sin(angle) * dist,
              1 + rand() * 2,
              1 + rand() * 2
            );
          }
        },
        {
          rough: 0.95,
          bleed: [168, 164, 154]
        }
      ),
    scorch: () =>
      paintDecal(
        'scorch',
        256,
        256,
        (ctx, w, h, rand) => {
          for (let i = 0; i < 40; i++) {
            const angle = rand() * 7;
            const dist = Math.pow(rand(), 1.2) * w * 0.3;
            const x = w / 2 + Math.cos(angle) * dist;
            const y = h / 2 + Math.sin(angle) * dist;
            const radius = w * (0.07 + rand() * 0.15) * (1.2 - dist / (w * 0.4));
            const gradient = ctx.createRadialGradient(x, y, 0, x, y, Math.max(4, radius));
            gradient.addColorStop(0, `rgba(8,7,6,${0.3 + rand() * 0.3})`);
            gradient.addColorStop(1, 'rgba(8,7,6,0)');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, w, h);
          }
          ctx.strokeStyle = 'rgba(8,7,6,0.25)';
          for (let i = 0; i < 50; i++) {
            const angle = rand() * 7;
            const inner = w * 0.1;
            const outer = w * (0.25 + rand() * 0.22);
            ctx.lineWidth = 1 + rand() * 3;
            ctx.beginPath();
            ctx.moveTo(w / 2 + Math.cos(angle) * inner, h / 2 + Math.sin(angle) * inner);
            ctx.lineTo(w / 2 + Math.cos(angle) * outer, h / 2 + Math.sin(angle) * outer);
            ctx.stroke();
          }
        },
        {
          rough: 0.95,
          bleed: [8, 7, 6]
        }
      ),
    crack: () =>
      paintDecal(
        'crack',
        256,
        256,
        (ctx, w, h, rand) => {
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          /** Random-walk crack that occasionally forks into thinner branches. */
          const drawCrack = (
            x: number,
            y: number,
            angle: number,
            length: number,
            width: number,
            depth: number
          ): void => {
            ctx.strokeStyle = `rgba(20,19,18,${0.6 + 0.35 * Math.min(1, width / 2.5)})`;
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(x, y);
            const steps = Math.floor(length / 9);
            for (let i = 0; i < steps; i++) {
              angle += (rand() - 0.5) * 0.8;
              x += Math.cos(angle) * 9;
              y += Math.sin(angle) * 9;
              ctx.lineTo(x, y);
              if (depth > 0 && rand() < 0.22) {
                ctx.stroke();
                drawCrack(
                  x,
                  y,
                  angle + (rand() < 0.5 ? 1 : -1) * (0.5 + rand() * 0.7),
                  length * (0.3 + rand() * 0.3),
                  width * 0.6,
                  depth - 1
                );
                ctx.strokeStyle = `rgba(20,19,18,${0.6 + 0.35 * Math.min(1, width / 2.5)})`;
                ctx.lineWidth = width;
                ctx.beginPath();
                ctx.moveTo(x, y);
              }
            }
            ctx.stroke();
          };
          drawCrack(w * 0.5, h * 0.5, rand() * 7, w * 0.42, 2.6, 3);
          drawCrack(w * 0.5, h * 0.5, rand() * 7 + 2, w * 0.4, 2.2, 3);
          drawCrack(w * 0.5, h * 0.5, rand() * 7 + 4, w * 0.36, 1.8, 2);
        },
        {
          rough: 0.95,
          bleed: [20, 19, 18]
        }
      ),
    graffiti_tag: () =>
      paintDecal(
        'graffiti_tag',
        384,
        256,
        (ctx, w, h, rand) => {
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          /** Strokes a chain of quadratic curves: p0, (ctrl, end), (ctrl, end) ... */
          const strokeCurve = (points: number[][], width: number, style: string) => {
            ctx.strokeStyle = style;
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(points[0][0], points[0][1]);
            for (let i = 1; i < points.length - 1; i += 2) {
              ctx.quadraticCurveTo(points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
            }
            ctx.stroke();
          };
          const paint = 'rgba(206,214,208,0.92)';
          const letters = [
            [
              [40, 60],
              [36, 130],
              [48, 200],
              [70, 150],
              [44, 128],
              [80, 110],
              [104, 70]
            ],
            [
              [104, 70],
              [76, 140],
              [108, 190],
              [150, 200],
              [150, 110],
              [140, 60],
              [112, 84]
            ],
            [
              [168, 196],
              [172, 120],
              [186, 62],
              [200, 110],
              [226, 92],
              [214, 150],
              [236, 196]
            ],
            [
              [250, 76],
              [300, 60],
              [318, 66],
              [282, 110],
              [262, 178],
              [300, 200],
              [334, 176]
            ]
          ];
          for (const letter of letters) {
            strokeCurve(letter, 12, 'rgba(206,214,208,0.25)');
            strokeCurve(letter, 7, paint);
          }
          strokeCurve(
            [
              [30, 222],
              [180, 236],
              [352, 206]
            ],
            5,
            paint
          );
          strokeCurve(
            [
              [330, 40],
              [344, 30],
              [356, 44]
            ],
            5,
            paint
          );
          for (let i = 0; i < 7; i++) {
            const x = 50 + rand() * 290;
            const y = 150 + rand() * 50;
            const length = 12 + rand() * 46;
            const drip = ctx.createLinearGradient(0, y, 0, y + length);
            drip.addColorStop(0, paint);
            drip.addColorStop(1, 'rgba(206,214,208,0)');
            ctx.fillStyle = drip;
            ctx.fillRect(x, y, 2 + rand() * 2, length);
          }
          for (let i = 0; i < 260; i++) {
            ctx.fillStyle = `rgba(206,214,208,${rand() * 0.5})`;
            ctx.fillRect(30 + rand() * 330, 40 + rand() * 190, 1.2, 1.2);
          }
          weatherDecal(ctx, w, h, 0.25, rand);
        },
        {
          rough: 0.6,
          bleed: [206, 214, 208]
        }
      ),
    csc_plate: () =>
      paintDecal(
        'csc_plate',
        288,
        200,
        (ctx, w, h, rand) => {
          const metal = ctx.createLinearGradient(0, 0, w, h);
          metal.addColorStop(0, 'rgb(150,152,150)');
          metal.addColorStop(0.5, 'rgb(176,178,176)');
          metal.addColorStop(1, 'rgb(138,140,138)');
          ctx.fillStyle = metal;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(3, 3, w - 6, h - 6, 8);
          else ctx.rect(3, 3, w - 6, h - 6);
          ctx.fill();
          ctx.strokeStyle = 'rgba(40,42,44,0.8)';
          ctx.lineWidth = 2;
          ctx.strokeRect(11, 11, w - 22, h - 22);
          for (const [rx, ry] of [
            [20, 20],
            [w - 20, 20],
            [20, h - 20],
            [w - 20, h - 20]
          ]) {
            ctx.fillStyle = 'rgb(96,98,98)';
            ctx.beginPath();
            ctx.arc(rx, ry, 5, 0, 7);
            ctx.fill();
            ctx.fillStyle = 'rgba(230,232,232,0.7)';
            ctx.beginPath();
            ctx.arc(rx - 1.2, ry - 1.2, 2, 0, 7);
            ctx.fill();
          }
          const ink = 'rgba(28,30,32,0.92)';
          drawStencilText(ctx, 'SAFETY APPROVAL PLATE', w / 2, 46, 19, ink, {
            font: 'sans',
            weight: 600,
            align: 'center',
            spacing: 1.5,
            maxW: w - 60
          });
          [
            'APPROVAL REF   SL/PA-4207/19',
            'DATE MANUFACTURED   03/2019',
            'IDENT NO   SLTU 402719 6',
            'MAX GROSS   30 480 KG',
            'STACKING LOAD   192 000 KG',
            'RACKING TEST   150 KN',
            'NEXT EXAM   09/2027'
          ].forEach((line, i) => {
            drawStencilText(ctx, line, 30, 70 + i * 16.5, 11, ink, {
              font: 'mono',
              weight: 500,
              spacing: 0,
              maxW: w - 60
            });
            ctx.fillStyle = 'rgba(28,30,32,0.35)';
            ctx.fillRect(30, 73 + i * 16.5, w - 60, 1);
          });
          ctx.fillStyle = 'rgba(60,40,24,0.25)';
          for (let i = 0; i < 30; i++) {
            wobblyBlobPath(ctx, rand() * w, rand() * h, 2 + rand() * 9, rand, 0.5, 7);
            ctx.fill();
          }
        },
        {
          rough: 0.45,
          metal: 0.75,
          text: true
        }
      ),
    numbers_0_9: () =>
      paintDecal(
        'numbers_0_9',
        640,
        128,
        (ctx, w, h, rand) => {
          for (let digit = 0; digit < 10; digit++) {
            drawStencilText(
              ctx,
              String(digit),
              digit * 64 + 32,
              h * 0.86,
              h * 0.92,
              rgbaCss(SIGN_COLORS.white),
              {
                align: 'center',
                weight: 900,
                maxW: 54
              }
            );
          }
          weatherDecal(ctx, w, h, 0.3, rand);
        },
        {
          bleed: SIGN_COLORS.white,
          text: true
        }
      )
  };
  const decalNames = Object.keys(painters);
  const warnedUnknown = new Set<string>();

  function decal(name: string): DecalEntry {
    let entry = cache.get('d:' + name);
    if (entry) return entry;
    const painter = painters[name];
    if (!painter) {
      if (!warnedUnknown.has(name)) {
        warnedUnknown.add(name);
        console.warn(`[mats] unknown decal "${name}"`);
      }
      entry = decal('grime_streak');
    } else {
      const painted = painter();
      entry = {
        material: painted.material,
        aspect: painted.aspect
      };
      entry.material.name = 'decal_' + name;
    }
    cache.set('d:' + name, entry);
    return entry;
  }

  function number(n: number): DecalEntry {
    const key = 'n:' + n;
    let entry = cache.get(key);
    if (entry) return entry;
    const sheet = decal('numbers_0_9').material;
    // The digit sheet is always painted with a canvas map.
    const map = sheet.map!.clone();
    map.repeat.set(0.1, 1);
    map.offset.set((Math.abs(n | 0) % 10) / 10, 0);
    map.needsUpdate = true;
    const material = sheet.clone();
    material.map = map;
    textRepainters.push(() => {
      map.needsUpdate = true;
    });
    entry = {
      material,
      aspect: 0.5
    };
    cache.set(key, entry);
    return entry;
  }

  function label(rawText?: string | number, options: LabelOptions = {}): DecalEntry {
    const text = String(rawText === undefined ? '' : rawText).toUpperCase() || ' ';
    const colorName =
      options.color !== undefined && SIGN_COLORS[options.color] ? options.color : 'white';
    const face = options.font === 'sans' ? 'sans' : 'stencil';
    const distress = options.distress !== undefined ? +options.distress : 0.35;
    const key = `l:${text}|${colorName}|${face}|${distress}`;
    let entry = cache.get(key);
    if (entry) return entry;
    const lineHeight = 128;
    const fontSize = 100;
    const measureCtx = createCanvas(4, 4).getContext('2d')!;
    const fontStack = face === 'sans' ? SANS_FONT_STACK : DISPLAY_FONT_STACK;
    const weight = face === 'sans' ? 600 : 700;
    const spacing = fontSize * 0.06;
    const textWidth = measureSpacedText(measureCtx, text, fontSize, fontStack, weight, spacing);
    // Keep the canvas at most ~2000 px wide.
    const scale = Math.min(1, 2000 / (textWidth + 32));
    const canvasWidth = Math.max(48, Math.ceil((textWidth + 32) * scale));
    const canvasHeight = Math.ceil(lineHeight * scale);
    const painted = paintDecal(
      key,
      canvasWidth,
      canvasHeight,
      (ctx, w, h, rand) => {
        ctx.save();
        ctx.scale(scale, scale);
        drawStencilText(
          ctx,
          text,
          16,
          lineHeight * 0.84,
          fontSize,
          rgbaCss(SIGN_COLORS[colorName]),
          {
            font: face,
            weight,
            spacing,
            fitW: textWidth
          }
        );
        ctx.restore();
        weatherDecal(ctx, w, h, distress, rand);
      },
      {
        bleed: SIGN_COLORS[colorName],
        text: true,
        rough: 0.65
      }
    );
    entry = {
      material: painted.material,
      aspect: painted.aspect
    };
    entry.material.name = 'label';
    cache.set(key, entry);
    return entry;
  }

  // Repaint text decals (debounced) once the web fonts have loaded.
  try {
    if (typeof document !== 'undefined' && document.fonts && document.fonts.load) {
      let pendingTimer: ReturnType<typeof setTimeout> | 0 = 0;
      const repaintAll = () => {
        pendingTimer = 0;
        for (const repaint of textRepainters) {
          try {
            repaint();
          } catch {}
        }
      };
      for (const font of [
        '700 20px "Big Shoulders Display"',
        '900 20px "Big Shoulders Display"',
        '600 20px "Barlow Condensed"',
        '500 20px "IBM Plex Mono"'
      ]) {
        document.fonts.load(font).then(
          (faces) => {
            if (faces && faces.length && !pendingTimer) pendingTimer = setTimeout(repaintAll, 120);
          },
          () => {}
        );
      }
    }
  } catch {}

  return {
    decal,
    label,
    number,
    names: decalNames,
    bytes: () => decalBytes
  };
}
