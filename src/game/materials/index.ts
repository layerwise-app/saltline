/**
 * Material library. Bakes tileable PBR texture sets (albedo / ORM / normal) on the GPU from the GLSL
 * surface generators, builds cached `MeshStandardMaterial`s from named material definitions, and
 * patches three's standard shader with macro variation, rain wetness, triplanar mapping and
 * alpha-cut wire mesh. Also exposes the canvas decal library and the `?show=materials` showcase.
 */
import {
  Color,
  DoubleSide,
  GLSL3,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  ShaderChunk,
  SphereGeometry,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget
} from 'three';
import type {
  BufferGeometry,
  ColorRepresentation,
  IUniform,
  Material,
  Texture,
  WebGLRenderer
} from 'three';
import type { Game } from '../core/types';
import { BAKE_MAIN_FRAG, BAKE_PRELUDE_FRAG, BAKE_SURFACE_GLSL, BAKE_VERT } from './surfaceShaders';
import { ALBEDO_COPY_FRAG, HEIGHT_TO_NORMAL_FRAG, createDecalLibrary } from './decalArt';
import type { DecalEntry, LabelOptions } from './decalArt';

export type { DecalEntry, LabelOptions } from './decalArt';

type Vec4Tuple = [number, number, number, number];
/** Tile size in metres: uniform, or [u, v]. */
type TileSize = number | [number, number];

/** A baked texture set: which GLSL generator to run and how it tiles. */
interface SurfaceSetDef {
  /** Key into `BAKE_SURFACE_GLSL`. */
  fn: string;
  /** Resolution relative to the quality texture size. */
  size: number;
  tile: TileSize;
  /** Normal-map strength. */
  bump: number;
  /** Allowed to bake at 2048 on high quality. */
  hero?: boolean;
  /** Generator parameters (`uP`). */
  p?: number[];
  seed?: number;
}

/** A named material: texture set plus tint, PBR scalars and wetness/macro-variation params. */
interface MaterialDef {
  set: string;
  /** SL_TINT mode: 0 multiply rgb, 1 add colour by alpha mask, 2 luminance-preserving tint, 3 rgba multiply. */
  tint: number;
  color: number;
  rough: number;
  metal: number;
  /** uSlWetP: darkening, wet roughness factor, streak strength, bead amount. */
  wet: Vec4Tuple;
  /** uSlMacro: colour variation, roughness variation, frequency, grime. */
  macro: Vec4Tuple;
  nrm: number;
  alphaCut?: boolean;
  /** 2 = double sided. */
  side?: number;
  transparent?: boolean;
}

const SURFACE_SETS: Record<string, SurfaceSetDef> = {
  asphalt: {
    fn: 'asphalt',
    size: 1,
    tile: 2,
    bump: 1.6,
    hero: true
  },
  concrete: {
    fn: 'concrete',
    size: 1,
    tile: 3,
    bump: 2.5
  },
  brick: {
    fn: 'brick',
    size: 0.5,
    tile: 1.8,
    bump: 6
  },
  epoxy: {
    fn: 'epoxy',
    size: 0.5,
    tile: 4,
    bump: 3
  },
  paint: {
    fn: 'paint',
    size: 1,
    tile: 2.5,
    bump: 2.5,
    p: [0.5]
  },
  hull: {
    fn: 'hull',
    size: 0.5,
    tile: 4,
    bump: 12
  },
  galv: {
    fn: 'galv',
    size: 0.5,
    tile: 1,
    bump: 0.8
  },
  metal: {
    fn: 'metal',
    size: 0.5,
    tile: 1,
    bump: 0.5,
    p: [1]
  },
  brushed: {
    fn: 'brushed',
    size: 0.5,
    tile: 0.5,
    bump: 0.4
  },
  rust: {
    fn: 'rust',
    size: 0.5,
    tile: 1.2,
    bump: 3
  },
  diamond: {
    fn: 'diamond',
    size: 0.5,
    tile: 0.5,
    bump: 2
  },
  corrugated: {
    fn: 'corrugated',
    size: 0.5,
    tile: [0.762, 2.286],
    bump: 19
  },
  chainlink: {
    fn: 'chainlink',
    size: 0.5,
    tile: 0.5,
    bump: 5
  },
  hazard: {
    fn: 'hazard',
    size: 0.5,
    tile: 1,
    bump: 2.5
  },
  gunmetal: {
    fn: 'gunmetal',
    size: 0.5,
    tile: 0.25,
    bump: 0.3,
    p: [0.6]
  },
  anodized: {
    fn: 'gunmetal',
    size: 0.5,
    tile: 0.25,
    bump: 0.25,
    p: [0.2],
    seed: 11
  },
  polymer: {
    fn: 'polymer',
    size: 0.25,
    tile: 0.1,
    bump: 0.4
  },
  carbon: {
    fn: 'carbon',
    size: 0.25,
    tile: 0.05,
    bump: 0.5
  },
  fabric: {
    fn: 'fabric',
    size: 0.25,
    tile: 0.05,
    bump: 0.4
  },
  armor: {
    fn: 'armor',
    size: 0.5,
    tile: 0.5,
    bump: 0.8
  },
  wood: {
    fn: 'wood',
    size: 0.5,
    tile: 1.2,
    bump: 2.6
  },
  plastic: {
    fn: 'plastic',
    size: 0.5,
    tile: 1,
    bump: 1
  },
  tarp: {
    fn: 'tarp',
    size: 0.5,
    tile: 1.5,
    bump: 20
  },
  cardboard: {
    fn: 'cardboard',
    size: 0.5,
    tile: 1,
    bump: 0.8
  },
  rope: {
    fn: 'rope',
    size: 0.25,
    tile: 0.1,
    bump: 4
  },
  tire: {
    fn: 'tire',
    size: 0.5,
    tile: [0.5, 0.3],
    bump: 7
  },
  glass: {
    fn: 'glass',
    size: 0.5,
    tile: 1.5,
    bump: 1.5,
    p: [0.3]
  },
  glass_dirty: {
    fn: 'glass',
    size: 0.5,
    tile: 1.5,
    bump: 1.5,
    p: [1],
    seed: 40
  },
  water: {
    fn: 'water',
    size: 0.25,
    tile: 4,
    bump: 30
  }
};

const WET_DEFAULT: Vec4Tuple = [0.42, 0.38, 0.5, 0];
const WET_PAINT: Vec4Tuple = [0.05, 0.62, 0.65, 0.7];
const WET_STEEL: Vec4Tuple = [0, 0.7, 0.55, 0.5];
const WET_RUST: Vec4Tuple = [0.3, 0.6, 0.55, 0];
const WET_PLASTIC: Vec4Tuple = [0.08, 0.62, 0.6, 0.5];
const WET_WOOD: Vec4Tuple = [0.4, 0.5, 0.6, 0];
const WET_NONE: Vec4Tuple = [0, 1, 0, 0];
const MACRO_GROUND: Vec4Tuple = [0.22, 0.12, 0.35, 0.35];
const MACRO_DEFAULT: Vec4Tuple = [0.14, 0.1, 0.8, 0.2];
const MACRO_BRUSHED: Vec4Tuple = [0.07, 0.06, 3, 0];
const MACRO_NONE: Vec4Tuple = [0, 0, 1, 0];

const materialDef = (set: string, overrides: Partial<MaterialDef> = {}): MaterialDef => ({
  set,
  tint: 0,
  color: 0xffffff,
  rough: 1,
  metal: 1,
  wet: WET_DEFAULT,
  macro: MACRO_DEFAULT,
  nrm: 1,
  ...overrides
});

const paintDef = (color: number): MaterialDef =>
  materialDef('paint', {
    tint: 1,
    color,
    wet: WET_PAINT,
    macro: [0.2, 0.16, 0.4, 0.45]
  });

const MATERIAL_DEFS: Record<string, MaterialDef> = {
  asphalt: materialDef('asphalt', {
    wet: [0.45, 0.3, 0.5, 0],
    macro: MACRO_GROUND
  }),
  concrete: materialDef('concrete', {
    macro: MACRO_GROUND
  }),
  concrete_dirty: materialDef('concrete', {
    color: 0xcfc6b6,
    macro: [0.3, 0.15, 0.35, 0.9]
  }),
  concrete_painted: materialDef('concrete', {
    tint: 2,
    color: 0x8e9296,
    rough: 0.9,
    wet: [0.15, 0.55, 0.6, 0.3],
    macro: [0.14, 0.1, 0.5, 0.3]
  }),
  brick: materialDef('brick'),
  floor_epoxy: materialDef('epoxy', {
    wet: [0.04, 0.75, 0.4, 0],
    macro: [0.12, 0.2, 0.45, 0.25]
  }),
  paint_red: paintDef(0x7d2219),
  paint_blue: paintDef(0x1f3f66),
  paint_green: paintDef(0x2c5a44),
  paint_yellow: paintDef(0xb98a1c),
  paint_orange: paintDef(0xb3521a),
  paint_white: paintDef(0xb9bbb6),
  paint_grey: paintDef(0x5a6068),
  paint_teal: paintDef(0x1f5d63),
  steel_galv: materialDef('galv', {
    wet: WET_STEEL
  }),
  steel_dark: materialDef('metal', {
    tint: 1,
    color: 0x3d4146,
    rough: 1.15,
    wet: WET_STEEL
  }),
  steel_worn: materialDef('metal', {
    tint: 1,
    color: 0x8a8e92,
    rough: 0.9,
    wet: WET_STEEL
  }),
  steel_bare: materialDef('brushed', {
    tint: 1,
    color: 0xb4b8bb,
    wet: WET_STEEL,
    macro: MACRO_BRUSHED
  }),
  steel_rust: materialDef('rust', {
    wet: WET_RUST
  }),
  diamond_plate: materialDef('diamond', {
    wet: WET_STEEL
  }),
  corrugated_roof: materialDef('corrugated', {
    wet: WET_STEEL
  }),
  chainlink: materialDef('chainlink', {
    tint: 3,
    alphaCut: true,
    side: 2,
    wet: WET_NONE,
    macro: MACRO_NONE
  }),
  aluminium: materialDef('brushed', {
    tint: 1,
    color: 0xc4c8cb,
    rough: 1.15,
    wet: WET_STEEL,
    macro: MACRO_BRUSHED
  }),
  brass: materialDef('brushed', {
    tint: 1,
    color: 0xc29a45,
    rough: 0.9,
    wet: WET_STEEL,
    macro: [0.1, 0.08, 20, 0]
  }),
  hazard_stripes: materialDef('hazard', {
    wet: WET_PAINT
  }),
  gunmetal: materialDef('gunmetal', {
    tint: 1,
    color: 0x2a2d31,
    wet: [0, 0.75, 0.6, 0.5],
    macro: [0.08, 0.06, 6, 0]
  }),
  anodized_black: materialDef('anodized', {
    tint: 1,
    color: 0x121416,
    rough: 0.72,
    metal: 0.9,
    wet: [0, 0.75, 0.6, 0.5],
    macro: [0.06, 0.05, 6, 0]
  }),
  polymer_black: materialDef('polymer', {
    tint: 1,
    color: 0x17181a,
    wet: [0, 0.7, 0.6, 0.5],
    macro: [0.06, 0.06, 6, 0]
  }),
  polymer_tan: materialDef('polymer', {
    tint: 1,
    color: 0x6f6048,
    wet: [0, 0.7, 0.6, 0.5],
    macro: [0.06, 0.06, 6, 0]
  }),
  rubber: materialDef('polymer', {
    tint: 1,
    color: 0x101010,
    rough: 1.4,
    wet: [0.05, 0.6, 0.6, 0.4],
    macro: [0.06, 0.06, 6, 0]
  }),
  carbon: materialDef('carbon', {
    wet: [0, 0.8, 0.6, 0.5],
    macro: [0.05, 0.05, 6, 0]
  }),
  glove_fabric: materialDef('fabric', {
    tint: 1,
    color: 0x23262a,
    wet: [0.3, 0.7, 0.6, 0],
    macro: [0.08, 0.04, 8, 0]
  }),
  armor_white: materialDef('armor', {
    tint: 1,
    color: 0xaeb4b8,
    wet: WET_PAINT,
    macro: [0.08, 0.08, 2.5, 0.15]
  }),
  armor_orange: materialDef('armor', {
    tint: 1,
    color: 0xc1551a,
    wet: WET_PAINT,
    macro: [0.08, 0.08, 2.5, 0.15]
  }),
  wood_pallet: materialDef('wood', {
    wet: WET_WOOD,
    macro: [0.2, 0.1, 0.9, 0.4]
  }),
  wood_dark: materialDef('wood', {
    color: 0x8a786a,
    wet: WET_WOOD,
    macro: [0.2, 0.1, 0.9, 0.4]
  }),
  plastic_blue: materialDef('plastic', {
    tint: 1,
    color: 0x1d4c86,
    wet: WET_PLASTIC
  }),
  plastic_red: materialDef('plastic', {
    tint: 1,
    color: 0x8e1f1a,
    wet: WET_PLASTIC
  }),
  plastic_grey: materialDef('plastic', {
    tint: 1,
    color: 0x4b4f54,
    wet: WET_PLASTIC
  }),
  tarp: materialDef('tarp', {
    tint: 1,
    color: 0x3b4a3a,
    wet: WET_PLASTIC,
    macro: [0.1, 0.1, 1.2, 0.2]
  }),
  cardboard: materialDef('cardboard', {
    wet: [0.4, 0.75, 0.6, 0]
  }),
  rope: materialDef('rope', {
    macro: MACRO_BRUSHED
  }),
  tire: materialDef('tire', {
    wet: [0.1, 0.6, 0.6, 0.3],
    macro: MACRO_BRUSHED
  }),
  glass: materialDef('glass', {
    tint: 3,
    transparent: true,
    wet: WET_NONE,
    macro: MACRO_NONE
  }),
  glass_dirty: materialDef('glass_dirty', {
    tint: 3,
    transparent: true,
    wet: WET_NONE,
    macro: MACRO_NONE
  }),
  hull_paint: materialDef('hull', {
    tint: 1,
    color: 0x1b222b,
    wet: WET_PAINT,
    macro: MACRO_GROUND
  }),
  hull_red: materialDef('hull', {
    tint: 1,
    color: 0x5f1f18,
    wet: WET_PAINT,
    macro: MACRO_GROUND
  }),
  water_dark: materialDef('water', {
    wet: WET_NONE,
    macro: MACRO_NONE
  })
};

const FALLBACK_MATERIAL_DEF = materialDef('metal', {
  tint: 1,
  color: 0x7a7d80,
  wet: WET_STEEL
});

const SURFACE_VARYINGS_GLSL = `
varying vec3 vSlPos;
#ifdef SL_TRIPLANAR
varying vec3 vSlONrm; varying vec3 vSlAx; varying vec3 vSlAy;
#endif
`;

const SURFACE_VERTEX_GLSL = `
#ifdef SL_TRIPLANAR
  vSlPos = position; vSlONrm = normal;
  vec3 slAx = vec3(1.0, 0.0, 0.0), slAy = vec3(0.0, 1.0, 0.0);
  #ifdef USE_SKINNING
    slAx = (skinMatrix * vec4(slAx, 0.0)).xyz; slAy = (skinMatrix * vec4(slAy, 0.0)).xyz;
  #endif
  #ifdef USE_INSTANCING
    slAx = mat3(instanceMatrix) * slAx; slAy = mat3(instanceMatrix) * slAy;
  #endif
  vSlAx = normalize(mat3(modelViewMatrix) * slAx); vSlAy = normalize(mat3(modelViewMatrix) * slAy);
#else
  vec4 slWP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    slWP = instanceMatrix * slWP;
  #endif
  vSlPos = (modelMatrix * slWP).xyz;
#endif
`;

const SURFACE_FRAG_PARS_GLSL = `
uniform float uSlWet; uniform vec4 uSlWetP; uniform vec4 uSlMacro; uniform vec3 uSlUv; uniform vec2 uSlX;
varying vec3 vSlPos;
#ifdef SL_TRIPLANAR
varying vec3 vSlONrm; varying vec3 vSlAx; varying vec3 vSlAy;
vec3 slTw; vec2 slUx; vec2 slUy; vec2 slUz;
vec4 slTri(sampler2D t){ return texture2D(t, slUx) * slTw.x + texture2D(t, slUy) * slTw.y + texture2D(t, slUz) * slTw.z; }
#endif
vec4 slORM; vec2 slUv; float slWetK = 0.0; float slUp = 0.0; float slMac = 0.5; float slMac2 = 0.5; float slBead = 0.0;
float slH(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float slN3(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(slH(i), slH(i + vec3(1.0, 0.0, 0.0)), f.x), mix(slH(i + vec3(0.0, 1.0, 0.0)), slH(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(slH(i + vec3(0.0, 0.0, 1.0)), slH(i + vec3(1.0, 0.0, 1.0)), f.x), mix(slH(i + vec3(0.0, 1.0, 1.0)), slH(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
`;

const SURFACE_MAP_FRAG = `
#ifdef SL_TRIPLANAR
  { vec3 slOn = normalize(vSlONrm); vec3 slW3 = pow(abs(slOn), vec3(6.0)); slTw = slW3 / (slW3.x + slW3.y + slW3.z);
    vec3 slQ = vSlPos * uSlUv.z; slUx = slQ.zy; slUy = slQ.xz; slUz = slQ.xy; }
  vec4 sampledDiffuseColor = slTri(map);
  slORM = slTri(roughnessMap);
#else
  slUv = vMapUv * uSlUv.xy;
  vec4 sampledDiffuseColor = texture2D(map, slUv);
  slORM = texture2D(roughnessMap, slUv);
#endif
#ifdef SL_FX
  {
    #ifdef FLAT_SHADED
      vec3 slVN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    #else
      vec3 slVN = normalize(vNormal);
      #ifdef DOUBLE_SIDED
        slVN *= gl_FrontFacing ? 1.0 : -1.0;
      #endif
    #endif
    vec3 slWN = inverseTransformDirection(slVN, viewMatrix);
    vec3 slMp = vSlPos * uSlMacro.z;
    slMac = slN3(slMp); slMac2 = slN3(slMp * 3.7 + 11.3);
    float slM = slMac * 0.65 + slMac2 * 0.35 - 0.5;
    sampledDiffuseColor.rgb *= 1.0 + uSlMacro.x * slM * 2.0;
    float slGr = smoothstep(0.5, 0.85, slMac * 0.6 + slMac2 * 0.4 + (1.0 - slORM.r) * 0.3) * uSlMacro.w;
    sampledDiffuseColor.rgb *= 1.0 - slGr * 0.35;
    #if SL_TINT == 1
      sampledDiffuseColor.a *= 1.0 - slGr * 0.2;
    #endif
    // rain wetness: strongest on up-facing faces, streaky on verticals, none underneath
    slUp = smoothstep(0.15, 0.85, slWN.y);
    float slExpo = smoothstep(-0.4, -0.05, slWN.y);
    float slStreak = 0.0;
    #ifndef SL_TRIPLANAR
      float slSc = vSlPos.x + vSlPos.z;
      slStreak = slN3(vec3(slSc * 9.0, vSlPos.y * 0.55, slSc * 0.7 + 3.0)) * slN3(vec3(slSc * 29.0, vSlPos.y * 1.1, 7.0));
      slStreak = smoothstep(0.12, 0.42, slStreak) * smoothstep(0.3, 0.7, slN3(vec3(slSc * 1.1, vSlPos.y * 0.25, 1.7)));
    #endif
    float slW = uSlWet * uSlX.x * slExpo;
    slWetK = slW * mix(uSlWetP.z * (0.55 + 0.9 * slStreak), 0.75 + 0.5 * slMac, slUp);
    #ifndef SL_TRIPLANAR
      { float slLow = smoothstep(0.5, 0.0, vSlPos.y) * (1.0 - slUp) * slExpo;        // damp, splashed band where things meet the ground
        slWetK += slW * slLow * 0.6;
        float slLg = 1.0 - slLow * min(uSlMacro.w, 0.5) * 0.45;
        sampledDiffuseColor.rgb *= slLg;
        #if SL_TINT == 1
          sampledDiffuseColor.a *= slLg;
        #endif
      }
    #endif
    slWetK = clamp(slWetK, 0.0, 1.0);
    float slBf = clamp(1.0 - length(fwidth(vSlPos)) * 120.0, 0.0, 1.0);
    if (uSlWetP.w > 0.0 && slBf > 0.0) {
      float slB = slN3(vSlPos * 170.0) * 0.6 + slN3(vSlPos * 410.0 + 5.0) * 0.4;
      slBead = smoothstep(0.6, 0.68, slB) * uSlWetP.w * slW * slBf * (0.4 + 0.6 * slUp + 0.5 * slStreak);
    }
  }
#endif
#if SL_TINT == 1
  diffuseColor.rgb = sampledDiffuseColor.rgb + diffuse * sampledDiffuseColor.a;
#elif SL_TINT == 2
  { float slL = clamp(dot(sampledDiffuseColor.rgb, vec3(0.3333)) / 0.19, 0.55, 1.35);
    diffuseColor.rgb = mix(sampledDiffuseColor.rgb, diffuse * slL, sampledDiffuseColor.a * 0.96); }
#elif SL_TINT == 3
  diffuseColor *= sampledDiffuseColor;
#else
  diffuseColor.rgb *= sampledDiffuseColor.rgb;
#endif
#ifdef SL_FX
  { float slLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = mix(vec3(slLum), diffuseColor.rgb, 1.0 + 0.25 * slWetK * uSlWetP.x * 2.0);
    diffuseColor.rgb *= 1.0 - uSlWetP.x * slWetK; }
#endif
#ifdef SL_ACUT
  // alpha-tested wire mesh that survives distance: wires stay ~1 px wide through the mips (lowered threshold),
  // then dissolve into a stable ~1/3-coverage dither veil once the diamonds themselves are sub-pixel.
  { vec2 slFw = fwidth(slUv) * 512.0; float slLod = log2(max(max(slFw.x, slFw.y), 1e-4));
    float slThC = 0.5 * exp2(-clamp(slLod - 1.0, 0.0, 4.0));
    float slIgn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float slTh = mix(slThC, 0.05 + slIgn * 0.80, smoothstep(3.5, 5.5, slLod));
    diffuseColor.a = sampledDiffuseColor.a > slTh ? 1.0 : 0.0;
    // sub-pixel wires: the surviving fragments stand in for a much thinner wire, so dim them (no white sheets in the sun)
    diffuseColor.rgb *= mix(1.0, 0.45, smoothstep(1.5, 4.5, slLod)); }
#endif
`;

const SURFACE_ROUGHNESS_FRAG = `
float roughnessFactor = roughness * slORM.g;
#ifdef SL_FX
  roughnessFactor += uSlMacro.y * ((slMac2 - 0.5) * 1.4 + (slMac - 0.5) * 0.8);
  roughnessFactor = mix(roughnessFactor, roughnessFactor * uSlWetP.y, slWetK);
  roughnessFactor = mix(roughnessFactor, 0.05, slBead);
#endif
#if defined( USE_NORMALMAP_TANGENTSPACE ) && !defined( SL_TRIPLANAR )
  { float slNl = length(texture2D(normalMap, slUv).xyz * 2.0 - 1.0);
    roughnessFactor = sqrt(roughnessFactor * roughnessFactor + clamp(1.0 - slNl, 0.0, 1.0) * 0.6); }
#endif
roughnessFactor = clamp(roughnessFactor, 0.045, 1.0);
`;

const SURFACE_METALNESS_FRAG = `
float metalnessFactor = metalness * slORM.b;
`;

const SURFACE_NORMAL_FRAG = `
#ifdef SL_TRIPLANAR
  { vec3 slOn = normalize(vSlONrm);
    vec3 slTx = texture2D(normalMap, slUx).xyz * 2.0 - 1.0, slTy = texture2D(normalMap, slUy).xyz * 2.0 - 1.0, slTz = texture2D(normalMap, slUz).xyz * 2.0 - 1.0;
    slTx.xy *= normalScale; slTy.xy *= normalScale; slTz.xy *= normalScale;
    slTx = vec3(slTx.xy + slOn.zy, abs(slTx.z) * slOn.x); slTy = vec3(slTy.xy + slOn.xz, abs(slTy.z) * slOn.y); slTz = vec3(slTz.xy + slOn.xy, abs(slTz.z) * slOn.z);
    vec3 slNo = normalize(slTx.zyx * slTw.x + slTy.xzy * slTw.y + slTz.xyz * slTw.z);
    vec3 slA = normalize(vSlAx), slB = normalize(vSlAy); vec3 slC = cross(slA, slB);
    normal = normalize(slA * slNo.x + slB * slNo.y + slC * slNo.z);
    #ifdef DOUBLE_SIDED
      normal *= faceDirection;
    #endif
  }
#elif defined( USE_NORMALMAP_TANGENTSPACE )
  { vec3 mapN = texture2D(normalMap, slUv).xyz * 2.0 - 1.0;
    mapN.xy *= normalScale * (1.0 - 0.45 * slWetK * slUp);
    normal = normalize(tbn * mapN); }
#endif
`;

/** AO chunk reading occlusion from the ORM texture's red channel. */
const SURFACE_AO_FRAG = ShaderChunk.aomap_fragment.replace(
  'texture2D( aoMap, vAoMapUv ).r',
  'slORM.r'
);

/** The parts of a three shader (e.g. the `onBeforeCompile` argument) that the patch touches. */
export interface PatchableShader {
  uniforms: Record<string, IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

/** Injects the Saltline surface chunks into a MeshStandardMaterial shader and adds `uniforms`. */
export function patchSurfaceShader(
  shader: PatchableShader,
  uniforms: Record<string, IUniform>
): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
` + SURFACE_VARYINGS_GLSL
    )
    .replace(
      '#include <project_vertex>',
      `#include <project_vertex>
` + SURFACE_VERTEX_GLSL
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
` + SURFACE_FRAG_PARS_GLSL
    )
    .replace('#include <map_fragment>', SURFACE_MAP_FRAG)
    .replace('#include <roughnessmap_fragment>', SURFACE_ROUGHNESS_FRAG)
    .replace('#include <metalnessmap_fragment>', SURFACE_METALNESS_FRAG)
    .replace('#include <normal_fragment_maps>', SURFACE_NORMAL_FRAG)
    .replace('#include <aomap_fragment>', SURFACE_AO_FRAG);
}

/** Options for `MaterialLibrary.get`. Each distinct combination is a separate cached material. */
export interface MaterialOptions {
  vertexColors?: boolean;
  /** Object-space triplanar mapping instead of UVs. */
  triplanar?: boolean;
  /** Triplanar tile scale multiplier. */
  scale?: number;
  doubleSide?: boolean;
  /** Indoors: rain wetness is mostly suppressed. */
  interior?: boolean;
  color?: ColorRepresentation;
}

/** Uniforms shared by every library material. */
export interface MaterialUniforms {
  /** Global rain wetness 0..1. */
  wet: { value: number };
}

export interface MaterialStats {
  sets: number;
  textureMB: number;
  genMs: number;
  decalMB: number;
}

/** A baked, mipmapped texture set. */
interface BakedSet {
  key: string;
  albedo: Texture;
  orm: Texture;
  normal: Texture;
  tile: [number, number];
  size: number;
  targets: WebGLRenderTarget[];
}

/** The material library (`game.mats`). */
export interface MaterialLibrary {
  /** Cached standard material for a named definition (unknown names use a fallback). */
  get(name: string, options?: MaterialOptions): MeshStandardMaterial;
  /** Unlit, tone-mapped material of `color * intensity`. */
  emissive(color?: ColorRepresentation, intensity?: number): MeshBasicMaterial;
  decal(name: string): DecalEntry;
  label(text?: string | number, options?: LabelOptions): DecalEntry;
  number(n: number): DecalEntry;
  /** All material definition names. */
  names: string[];
  decalNames: string[];
  uniforms: MaterialUniforms;
  /** Frees bake scratch targets once baking has been idle for a while. */
  update(dt?: number): void;
  /** Builds materials ahead of time (all definitions by default). */
  prewarm(names?: string[]): void;
  stats(): MaterialStats;
  /** Tile size of a material's texture set (1 for unknown names). */
  tileOf(name: string): TileSize;
}

/** Creates the material library; texture sets are baked lazily on first use. */
export async function createMaterialLibrary(game: Game): Promise<MaterialLibrary> {
  const renderer: WebGLRenderer = game.renderer || (game.render && game.render.renderer);
  const params = game.params || {};
  const texSize = +(params.tex || 0) || (game.quality && game.quality.tex) || 1024;
  const baseSize = Math.min(texSize, 1024);
  const anisotropy = Math.min(
    8,
    renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1
  );
  const sharedUniforms: MaterialUniforms = {
    wet: {
      value: params.wet !== undefined ? +params.wet : 1
    }
  };
  const bakeStats = {
    sets: 0,
    bytes: 0,
    ms: 0
  };
  const bakeCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const bakeScene = new Scene();
  const bakeQuad = new Mesh(new PlaneGeometry(2, 2));
  bakeQuad.frustumCulled = false;
  bakeScene.add(bakeQuad);
  /** MRT scratch targets, keyed by resolution. */
  const scratchTargets = new Map<number, WebGLRenderTarget>();
  /** Generator shaders, keyed by `fn`. */
  const bakeMaterials = new Map<string, RawShaderMaterial>();
  const bakedSets = new Map<string, BakedSet>();
  let lastBakeTime = 0;
  let postMaterials: { normal: RawShaderMaterial; copy: RawShaderMaterial } | null = null;
  const createBakeMaterial = (
    fragmentShader: string,
    uniforms: Record<string, IUniform>
  ): RawShaderMaterial =>
    new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: BAKE_VERT,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false
    });

  function getPostMaterials(): { normal: RawShaderMaterial; copy: RawShaderMaterial } {
    if (!postMaterials) {
      postMaterials = {
        normal: createBakeMaterial(HEIGHT_TO_NORMAL_FRAG, {
          tH: {
            value: null
          },
          uK: {
            value: new Vector2()
          },
          uTexel: {
            value: 0
          }
        }),
        copy: createBakeMaterial(ALBEDO_COPY_FRAG, {
          tA: {
            value: null
          },
          uSq: {
            value: 0
          }
        })
      };
    }
    return postMaterials;
  }

  function renderPass(target: WebGLRenderTarget, material: Material): void {
    bakeQuad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(bakeScene, bakeCamera);
  }

  function createOutputTarget(size: number, srgb: boolean): WebGLRenderTarget {
    const target = new WebGLRenderTarget(size, size, {
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      wrapS: RepeatWrapping,
      wrapT: RepeatWrapping,
      anisotropy,
      colorSpace: srgb ? SRGBColorSpace : NoColorSpace
    });
    bakeStats.bytes += size * size * 4 * 1.34;
    return target;
  }

  function setResolution(def: SurfaceSetDef): number {
    let size = Math.round(baseSize * def.size);
    if (def.hero && texSize >= 2048) size = 2048;
    return Math.max(32, size);
  }

  /** Bakes (or returns the cached) texture set `key`. Throws for unknown sets. */
  function bakeSet(key: string): BakedSet {
    let baked = bakedSets.get(key);
    if (baked) return baked;
    const def = SURFACE_SETS[key];
    const startTime = performance.now();
    const size = setResolution(def);
    const tile: [number, number] = Array.isArray(def.tile) ? def.tile : [def.tile, def.tile];
    let mrt = scratchTargets.get(size);
    if (!mrt) {
      mrt = new WebGLRenderTarget(size, size, {
        count: 3,
        depthBuffer: false,
        generateMipmaps: false,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        wrapS: RepeatWrapping,
        wrapT: RepeatWrapping
      });
      scratchTargets.set(size, mrt);
    }
    let generator = bakeMaterials.get(def.fn);
    if (!generator) {
      generator = createBakeMaterial(
        BAKE_PRELUDE_FRAG + BAKE_SURFACE_GLSL[def.fn] + BAKE_MAIN_FRAG,
        {
          uP: {
            value: new Vector4()
          },
          uSeed: {
            value: 0
          },
          uTexel: {
            value: 0
          }
        }
      );
      bakeMaterials.set(def.fn, generator);
    }
    const p = def.p || [];
    generator.uniforms.uP.value.set(p[0] || 0, p[1] || 0, p[2] || 0, p[3] || 0);
    generator.uniforms.uSeed.value = def.seed || 0;
    generator.uniforms.uTexel.value = 1 / size;
    const post = getPostMaterials();
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevXrEnabled = renderer.xr.enabled;
    const prevShadowAutoUpdate = renderer.shadowMap.autoUpdate;
    renderer.autoClear = true;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderPass(mrt, generator);
    const albedoTarget = createOutputTarget(size, true);
    const ormTarget = createOutputTarget(size, false);
    const normalTarget = createOutputTarget(size, false);
    post.copy.uniforms.tA.value = mrt.textures[0];
    post.copy.uniforms.uSq.value = 1;
    renderPass(albedoTarget, post.copy);
    post.copy.uniforms.tA.value = mrt.textures[1];
    post.copy.uniforms.uSq.value = 0;
    renderPass(ormTarget, post.copy);
    post.normal.uniforms.tH.value = mrt.textures[2];
    post.normal.uniforms.uTexel.value = 1 / size;
    post.normal.uniforms.uK.value.set(
      (def.bump * 0.001 * size) / tile[0],
      (def.bump * 0.001 * size) / tile[1]
    );
    renderPass(normalTarget, post.normal);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.xr.enabled = prevXrEnabled;
    renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
    for (const target of [albedoTarget, ormTarget, normalTarget]) {
      target.texture.repeat.set(1 / tile[0], 1 / tile[1]);
      target.texture.name = 'sl_' + key;
    }
    baked = {
      key,
      albedo: albedoTarget.texture,
      orm: ormTarget.texture,
      normal: normalTarget.texture,
      tile,
      size,
      targets: [albedoTarget, ormTarget, normalTarget]
    };
    bakedSets.set(key, baked);
    bakeStats.sets++;
    bakeStats.ms += performance.now() - startTime;
    lastBakeTime = performance.now();
    return baked;
  }

  function disposeBakeScratch(): void {
    for (const target of scratchTargets.values()) target.dispose();
    scratchTargets.clear();
    for (const material of bakeMaterials.values()) material.dispose();
    bakeMaterials.clear();
  }

  /** Holds both standard (`get`) and emissive materials; their keys never collide in practice. */
  const materialCache = new Map<string, MeshStandardMaterial | MeshBasicMaterial>();
  const warned = new Set<string>();

  function get(name: string, options: MaterialOptions = {}): MeshStandardMaterial {
    const cacheKey =
      name +
      '|' +
      (options.vertexColors ? 'v' : '') +
      (options.triplanar ? 't' + (options.scale || 1) : '') +
      (options.doubleSide ? 'd' : '') +
      (options.interior ? 'i' : '') +
      (options.color !== undefined ? 'c' + options.color : '');
    const cached = materialCache.get(cacheKey);
    // Entries under a `get` key are always standard materials.
    if (cached) return cached as MeshStandardMaterial;
    let def = MATERIAL_DEFS[name];
    if (!def) {
      if (!warned.has(name)) {
        warned.add(name);
        console.warn(`[mats] unknown material "${name}" — using fallback`);
      }
      def = FALLBACK_MATERIAL_DEF;
    }
    let baked: BakedSet;
    try {
      baked = bakeSet(def.set);
    } catch (error) {
      if (!warned.has('gen:' + def.set)) {
        warned.add('gen:' + def.set);
        console.error(
          `[mats] texture set "${def.set}" failed: ${(error && (error as Error).message) || error}`
        );
      }
      const fallback = new MeshStandardMaterial({
        color: options.color !== undefined ? options.color : def.tint ? def.color : 0x808080,
        roughness: 0.6,
        metalness: 0,
        vertexColors: !!options.vertexColors
      });
      fallback.name = name;
      materialCache.set(cacheKey, fallback);
      return fallback;
    }
    const triplanar = !!options.triplanar;
    const surfaceFx = !def.transparent && !def.alphaCut;
    const material = new MeshStandardMaterial({
      map: baked.albedo,
      normalMap: baked.normal,
      roughnessMap: baked.orm,
      metalnessMap: baked.orm,
      aoMap: baked.orm,
      color: options.color !== undefined ? options.color : def.color,
      roughness: def.rough,
      metalness: def.metal,
      vertexColors: !!options.vertexColors
    });
    material.normalScale.set(def.nrm, def.nrm);
    material.name = name;
    if (options.doubleSide || def.side === 2) material.side = DoubleSide;
    if (def.transparent) {
      material.transparent = true;
      material.depthWrite = false;
      material.envMapIntensity = 1.4;
    }
    if (def.alphaCut) material.alphaTest = 0.5;
    // MeshStandardMaterial has `defines` at runtime ({ STANDARD: '' }) but three's types omit it.
    const withDefines = material as MeshStandardMaterial & {
      defines?: Record<string, string | number>;
    };
    const defines: Record<string, string | number> = {
      ...withDefines.defines,
      SL_TINT: def.tint
    };
    withDefines.defines = defines;
    if (triplanar) defines.SL_TRIPLANAR = '';
    if (surfaceFx) defines.SL_FX = '';
    if (def.alphaCut && !triplanar) defines.SL_ACUT = '';
    const uniforms: Record<string, IUniform> = {
      uSlWet: sharedUniforms.wet,
      uSlWetP: {
        value: new Vector4(...def.wet)
      },
      uSlMacro: {
        value: new Vector4(...def.macro)
      },
      uSlUv: {
        value: new Vector3(1, 1, triplanar ? (options.scale || 1) / baked.tile[0] : baked.size)
      },
      uSlX: {
        value: new Vector2(options.interior ? 0.12 : 1, 0)
      }
    };
    material.userData.sl = uniforms;
    material.userData.set = baked.key;
    material.userData.tile = baked.tile;
    if (options.interior) material.userData.interior = true;
    material.onBeforeCompile = (shader) => patchSurfaceShader(shader, uniforms);
    const programKey =
      'sl2|' +
      def.tint +
      (triplanar ? 't' : '') +
      (surfaceFx ? 'f' : '') +
      (def.alphaCut ? 'a' : '');
    material.customProgramCacheKey = () => programKey;
    materialCache.set(cacheKey, material);
    return material;
  }

  function emissive(color: ColorRepresentation = 0xffffff, intensity = 4): MeshBasicMaterial {
    const cacheKey = 'em|' + color + '|' + intensity;
    // Entries under an `em|` key are always basic materials.
    if (materialCache.has(cacheKey)) return materialCache.get(cacheKey) as MeshBasicMaterial;
    const material = new MeshBasicMaterial({
      color: new Color(color).multiplyScalar(intensity),
      toneMapped: true
    });
    material.name = 'emissive';
    materialCache.set(cacheKey, material);
    return material;
  }

  const decals = createDecalLibrary(game, anisotropy);
  return {
    get,
    emissive,
    decal: decals.decal,
    label: decals.label,
    number: decals.number,
    names: Object.keys(MATERIAL_DEFS),
    decalNames: decals.names,
    uniforms: sharedUniforms,
    update(_dt?: number) {
      if (scratchTargets.size && performance.now() - lastBakeTime > 4000) disposeBakeScratch();
    },
    prewarm(names?: string[]) {
      for (const name of names || Object.keys(MATERIAL_DEFS)) get(name);
    },
    stats() {
      return {
        sets: bakeStats.sets,
        textureMB: +(bakeStats.bytes / 1048576).toFixed(1),
        genMs: +bakeStats.ms.toFixed(0),
        decalMB: +(decals.bytes() / 1048576).toFixed(1)
      };
    },
    tileOf(name: string) {
      const def = MATERIAL_DEFS[name];
      return def ? SURFACE_SETS[def.set].tile : 1;
    }
  };
}

/** Materials whose showcase sphere uses triplanar mapping. */
const TRIPLANAR_SHOWCASE_MATS = new Set([
  'gunmetal',
  'anodized_black',
  'polymer_black',
  'polymer_tan',
  'rubber',
  'carbon',
  'glove_fabric',
  'armor_white',
  'armor_orange'
]);

/** Sphere whose UVs are scaled to metres so tiling matches world size. */
function worldUvSphere(radius: number): SphereGeometry {
  const geometry = new SphereGeometry(radius, 48, 32);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * 2 * Math.PI * radius, uv.getY(i) * Math.PI * radius);
  }
  return geometry;
}

/** Plane whose UVs are scaled to metres. */
function worldUvPlane(width: number, height: number): PlaneGeometry {
  const geometry = new PlaneGeometry(width, height);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * width, uv.getY(i) * height);
  return geometry;
}

/** Result of the materials showcase: camera position/target for the debug view. */
export interface MaterialShowcase {
  cam: number[];
  target: number[];
  update(): void;
}

/**
 * `?show=materials` debug scene: a grid of swatches (wall, floor, sphere) per material, plus a wall
 * of every decal and some labels. `?only=a,b,decals` restricts what is shown.
 */
export function buildMaterialShowcase(game: Game): MaterialShowcase {
  const mats = game.mats;
  const root = new Group();
  game.scene.add(root);
  const only = game.params.only ? String(game.params.only).split(',').filter(Boolean) : null;
  const showDecals = !only || only.includes('decals');
  const materialNames = only ? only.filter((name) => name !== 'decals') : mats.names;
  const perRow = only ? Math.max(1, materialNames.length) : 10;
  const spacingX = 1.9;
  const spacingZ = 3.6;
  const sphere = worldUvSphere(0.42);
  const wallPlane = worldUvPlane(1.5, 1.5);
  const floorPlane = worldUvPlane(1.5, 1.5).rotateX(-Math.PI / 2);
  const addMesh = (
    geometry: BufferGeometry,
    material: Material,
    x: number,
    y: number,
    z: number
  ): Mesh => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };
  materialNames.forEach((name, index) => {
    const x = ((index % perRow) - (perRow - 1) / 2) * spacingX;
    const z = -Math.floor(index / perRow) * spacingZ;
    const material = mats.get(
      name,
      name.startsWith('glass') || name === 'chainlink'
        ? {
            doubleSide: true
          }
        : {}
    );
    addMesh(wallPlane, material, x, 0.76, z);
    addMesh(floorPlane, material, x, 0.012, z + 1.1);
    addMesh(
      sphere,
      TRIPLANAR_SHOWCASE_MATS.has(name)
        ? mats.get(name, {
            triplanar: true
          })
        : material,
      x,
      0.46,
      z + 1.25
    );
  });
  let cam: number[];
  let target: number[];
  const rowWidth = perRow * spacingX;
  if (only && materialNames.length) {
    cam = [0.25 * rowWidth, 1.5, 2.6 + rowWidth * 0.42];
    target = [0, 0.62, 0.5];
  } else {
    cam = [0, 9.5, 12];
    target = [0, 0, -7];
  }
  if (showDecals) {
    const wallX = only && !materialNames.length ? 0 : rowWidth / 2 + 5.5;
    const wallWidth = 8.4;
    const wallHeight = 3.3;
    addMesh(worldUvPlane(wallWidth, wallHeight), mats.get('paint_blue'), wallX, wallHeight / 2, -1);
    const concreteWall = addMesh(
      worldUvPlane(wallWidth, wallHeight),
      mats.get('concrete'),
      wallX,
      wallHeight / 2,
      -1.01
    );
    concreteWall.position.x += wallWidth;
    const decalNames = mats.decalNames;
    let cursorX = -wallWidth / 2 + 0.25;
    let cursorY = wallHeight - 0.75;
    const decalHeight = 0.62;
    /** Places a decal at the cursor, skipping the seam between the two walls. */
    const placeDecal = (entry: DecalEntry, height: number) => {
      const width = height * entry.aspect;
      if (cursorX + width > wallWidth * 1.5 - 0.2) return;
      if (cursorX < wallWidth / 2 && cursorX + width > wallWidth / 2 - 0.15) {
        cursorX = wallWidth / 2 + 0.25;
      }
      const mesh = new Mesh(new PlaneGeometry(width, height), entry.material);
      mesh.position.set(wallX + cursorX + width / 2, cursorY + height / 2, -0.996);
      mesh.renderOrder = 2;
      root.add(mesh);
      cursorX += width + 0.14;
    };
    [decalNames.slice(0, 9), decalNames.slice(9, 17), decalNames.slice(17)].forEach(
      (row, rowIndex) => {
        cursorX = -wallWidth / 2 + 0.25;
        cursorY = wallHeight - 0.75 - rowIndex * 0.78;
        row.forEach((decalName) => placeDecal(mats.decal(decalName), decalHeight));
      }
    );
    cursorX = -wallWidth / 2 + 0.25;
    cursorY = wallHeight - 0.75 - 3 * 0.78 - 0.05;
    placeDecal(
      mats.label('SALTLINE TERMINAL  B4-0271', {
        color: 'white'
      }),
      0.3
    );
    placeDecal(
      mats.label('MAX GROSS 30480 KG', {
        color: 'yellow',
        distress: 0.6
      }),
      0.22
    );
    placeDecal(
      mats.label('DANGER', {
        color: 'red',
        distress: 0.2
      }),
      0.3
    );
    placeDecal(
      mats.label('KEEP CLEAR', {
        color: 'black',
        font: 'sans'
      }),
      0.25
    );
    placeDecal(mats.number(4), 0.3);
    placeDecal(mats.number(7), 0.3);
    if (only && !materialNames.length) {
      cam = [wallWidth / 2, 1.7, 7.2];
      target = [wallWidth / 2, 1.6, -1];
    }
  }
  if (game.params.wet !== undefined) mats.uniforms.wet.value = +game.params.wet;
  console.log('[mats] ' + JSON.stringify(mats.stats()));
  return {
    cam,
    target,
    update() {}
  };
}

export {
  patchSurfaceShader as applyPatch,
  createMaterialLibrary as create,
  buildMaterialShowcase as showcase
};
