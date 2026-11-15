// Ground surfaces: the wet concrete apron (puddles, paint, planar reflections patched into
// MeshStandardMaterial), the planar-reflection pre-pass, and the animated harbour sea.
import {
  BufferAttribute,
  BufferGeometry,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  MathUtils,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  RGBAFormat,
  Sphere,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget
} from 'three';
import type { Color, IUniform, Object3D, Texture, WebGLRenderer } from 'three';
import type { Game } from '../core/types';
import type { GroundTextures } from './rain';
import { SKY_COLORS, SUN, WORLD_BOUNDS } from '../core/config';
import { GROUND_MASK_RECT, ROAD_MARKINGS_RECT } from './textures';

const APRON_COMMON_FRAG = `
uniform float uTime, uRain, uWetG, uReflOn, uReflLod, uMarkRes, uMaskRes;
uniform sampler2D uMask, uMarks, uDetail, uDetailN, uRefl;
uniform vec3 uMaskRect; uniform vec4 uMarkRect; uniform mat4 uReflMatrix; uniform vec2 uReflScale;
varying vec3 vGWorld;
float gRough; vec2 gNxz; float gPuddle; float gWet; float gFilm; float gSoak;
vec3 gHash3(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xxy + q.yzz) * q.zyx); }
float gH1(vec2 p){ vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float gVN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gH1(i), gH1(i + vec2(1.0, 0.0)), f.x), mix(gH1(i + vec2(0.0, 1.0)), gH1(i + vec2(1.0, 1.0)), f.x), f.y); }
// 4-tap B-spline bicubic of the base level: no texel edge of a data map can ever show, however close the camera is
vec4 gBicubic(sampler2D t, vec2 uv, float res){
  vec2 p = uv * res - 0.5; vec2 i = floor(p); vec2 f = p - i; vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i + w1 / g0 - 0.5) / res, h1 = (i + w3 / g1 + 1.5) / res;
  return (textureLod(t, vec2(h0.x, h0.y), 0.0) * g0.x + textureLod(t, vec2(h1.x, h0.y), 0.0) * g1.x) * g0.y
       + (textureLod(t, vec2(h0.x, h1.y), 0.0) * g0.x + textureLod(t, vec2(h1.x, h1.y), 0.0) * g1.x) * g1.y;
}
// one sparse layer of rain rings: every cell gets a new drop (position, size, strength) each cycle, thin soft crest
// that fades as it expands. Returns a slope (xz) contribution.
vec2 gRipple(vec2 p, float t, float cell, float seed){
  vec2 q = p / cell + seed * 17.3; vec2 id = floor(q); vec2 f = fract(q);
  vec3 h0 = gHash3(id + seed);
  float tt = t * (0.5 + 0.55 * h0.x) + h0.y * 9.0;
  float cyc = floor(tt), life = fract(tt);
  vec3 h = gHash3(id + seed + cyc * 7.31);
  vec3 hc = gHash3(id.yx + cyc * 3.71 + seed * 5.0);
  float on = step(h.z, 0.16 + 0.5 * uRain);
  float rmax = mix(0.1, 0.36, h.x * h.x);
  vec2 c = mix(vec2(rmax + 0.05), vec2(0.95 - rmax), hc.xy);
  vec2 dv = (f - c) * cell; float d = length(dv);
  float r = life * rmax * cell;
  float w = 0.005 + 0.02 * life;
  float x = (d - r) / w;
  float ring = x * exp(-x * x) * 2.3;
  float amp = 1.0 - life; amp = amp * amp * on * mix(0.3, 1.0, h.y) * smoothstep(0.0, 0.06, life);
  return (dv / max(d, 1e-4)) * ring * amp;
}
`;
const APRON_MAP_FRAG = `
{
  vec2 gxz = vGWorld.xz;
  float gDist = length(cameraPosition - vGWorld);
  // ---- unique large-scale masks (puddle height, dampness, oil, wear) ----
  vec2 muv = (gxz - uMaskRect.xy) * uMaskRect.z;
  float mIn = smoothstep(0.0, 0.05, min(min(muv.x, 1.0 - muv.x), min(muv.y, 1.0 - muv.y)));
  vec4 mk = mix(vec4(0.66, 0.5, 0.0, 0.5), gBicubic(uMask, muv, uMaskRes), mIn);
  // ---- tiling detail ----
  vec4 d1 = texture2D(uDetail, gxz * 0.21);
  vec4 d2 = texture2D(uDetail, gxz * 1.37 + 0.37);
  vec4 n1 = texture2D(uDetailN, gxz * 1.37 + 0.37);
  vec4 n0 = texture2D(uDetailN, gxz * 0.21);
  float grain = d2.r;
  // ---- slabs: 6 m expansion joints with tar sealing ----
  vec2 sj = gxz / 6.0;
  vec2 sf = (0.5 - abs(fract(sj) - 0.5)) * 6.0;
  float jd = min(sf.x, sf.y) + (d1.a - 0.5) * 0.035;
  float jaa = fwidth(jd) + 1e-5;
  float tarW = 0.022 + 0.03 * d1.g;
  float tar = (1.0 - smoothstep(tarW - jaa, tarW + jaa, jd)) * clamp(tarW / jaa, 0.0, 1.0);
  float groove = (1.0 - smoothstep(0.004, 0.012 + jaa, jd)) * clamp(0.02 / jaa, 0.0, 1.0);
  vec2 sid = floor(sj);
  float sh = fract(sin(dot(sid, vec2(127.1, 311.7))) * 43758.5453);
  float sh2 = fract(sh * 7.31 + 0.13);
  // ---- cracks, some sealed with tar ----
  float crArea = smoothstep(0.6, 0.76, mk.a * 0.7 + sh * 0.45);
  float cfw = fwidth(d1.b) * 1.5 + 0.004;
  float crack = smoothstep(0.955 - cfw, 0.975, d1.b) * crArea;
  float seal = smoothstep(0.915 - cfw, 0.94, d1.b) * crArea * step(0.72, sh2);
  // ---- base albedo: worn asphalt in the yard, concrete slabs on the quay ----
  float conc = smoothstep(15.6, 16.6, gxz.x + (d1.g - 0.5) * 0.6);
  vec3 alb = mix(vec3(0.125, 0.125, 0.13), vec3(0.22, 0.215, 0.2), conc);
  alb *= (0.8 + 0.4 * sh2) * (0.8 + 0.4 * d1.g) * (0.62 + 0.76 * grain);
  alb += vec3(0.11, 0.105, 0.095) * smoothstep(0.58, 0.78, d2.a) * (1.0 - conc * 0.6);    // pale aggregate
  float polish = smoothstep(0.38, 0.72, mk.a);                                            // traffic-polished lanes
  alb *= mix(1.0, 0.78, polish);
  alb = mix(alb, vec3(0.018, 0.018, 0.02), max(max(tar, seal * 0.4) * 0.94, crack * 0.9));
  alb *= 1.0 - 0.62 * mk.b;                                                               // oil
  // ---- painted markings (worn, chipped) + tyre rubber ----
  vec2 kuv = (gxz - uMarkRect.xy) * uMarkRect.zw;
  float kIn = step(0.0, kuv.x) * step(kuv.x, 1.0) * step(0.0, kuv.y) * step(kuv.y, 1.0);
  vec3 mp = texture2D(uMarks, kuv).rgb;
  float kpx = max(fwidth(kuv.x), fwidth(kuv.y)) * uMarkRes;
  if (kpx < 1.0) mp = mix(gBicubic(uMarks, kuv, uMarkRes).rgb, mp, smoothstep(0.5, 1.0, kpx));   // magnified: no texel blocks
  mp *= kIn;
  float kw = clamp(kpx * 0.5, 0.16, 0.5);
  // chips: world-space procedural noise down to sub-centimetre (never the texels of a map)
  float chipN = 0.5;
  if (max(mp.r, mp.g) > 0.02) {
    float cf2 = 1.0 - smoothstep(6.0, 18.0, gDist), cf3 = 1.0 - smoothstep(2.5, 7.0, gDist);
    chipN = gVN(gxz * 17.0) * 0.45 + mix(0.5, gVN(gxz * 57.0 + 11.0), cf2) * 0.33 + mix(0.5, gVN(gxz * 181.0 + 5.0), cf3) * 0.22;
  }
  float chip = chipN * 0.62 + d1.a * 0.38;
  float wear = clamp(mk.a * 1.25 - 0.22 + mp.b * 0.6, 0.0, 1.0);
  float wt = mix(0.24, 0.55, wear);
  float keep = smoothstep(wt - 0.045, wt + 0.045, chip) * (1.0 - max(tar, crack));
  float eN = (chipN - 0.5) * 0.55 * (1.0 - kw * 2.0);
  float pY = smoothstep(0.5 - kw, 0.5 + kw, mp.r + eN) * keep;
  float pW = smoothstep(0.5 - kw, 0.5 + kw, mp.g + eN) * keep;
  alb *= 1.0 - 0.6 * mp.b * (1.0 - 0.5 * conc);
  float fade = 0.72 + 0.28 * d1.g;
  alb = mix(alb, vec3(0.52, 0.34, 0.035) * fade, pY * 0.94);
  alb = mix(alb, vec3(0.47, 0.47, 0.44) * fade, pW * 0.94);
  float paint = max(pY, pW);
  // ---- water: one continuous gradient  standing water -> soaked band -> damp -> drier patches ----
  // organic shoreline: world-space noise (40 / 15 / 5 cm) on the water-level comparison, independent of the mask res
  float sf2 = 1.0 - smoothstep(25.0, 60.0, gDist), sf3 = 1.0 - smoothstep(8.0, 22.0, gDist);
  float sn1 = gVN(gxz * 2.5 + 3.0), sn2 = mix(0.5, gVN(gxz * 6.7 + 17.0), sf2), sn3 = mix(0.5, gVN(gxz * 20.0 + 9.0), sf3);
  float sn = sn1 * 0.5 + sn2 * 0.3 + sn3 * 0.2;
  float depth = 0.5 - mk.r + (sn - 0.5) * 0.11 + (d1.g - 0.5) * 0.03 + (grain - 0.5) * 0.012 + groove * 0.04 + crack * 0.02 - paint * 0.01;
  float puddle = smoothstep(0.0, 0.035, depth) * uWetG;                 // mirror weight (~5 cm ramp)
  float deep = smoothstep(0.0, 0.22, depth);                           // 0 at the rim (bed shows) .. 1 a hand deep
  float bandW = 0.05 + 0.15 * sn1 * sn1 + 0.05 * d1.g;                  // soaked band, roughly 10-30 cm, varies along the shore
  float soak = smoothstep(-bandW, 0.0, depth) * uWetG;
  float fringe = smoothstep(-0.65, -0.02, depth);                      // damp halo, about a metre
  float dryP = 1.0 - smoothstep(0.2, 0.42, mk.g + fringe * 0.55 + (d1.g - 0.5) * 0.25 + (sn - 0.5) * 0.12);
  float damp = (1.0 - dryP) * uWetG;
  float wet = clamp(damp * 0.7 + soak * 0.3, 0.0, 1.0);
  float film = clamp(soak * (1.0 - smoothstep(0.35, 0.95, grain + (1.0 - soak) * 0.6)) + groove * 0.5, 0.0, 1.0) * (1.0 - paint * 0.4);
  alb *= mix(0.95, mix(0.7, 0.54, 1.0 - paint), damp);
  alb *= mix(1.0, 0.5, soak);
  // standing water: shallow rim shows the wet bed, deeper water goes murky and dark (never a black cut-out)
  alb = mix(alb, alb * mix(0.85, 0.4, deep) + vec3(0.004, 0.006, 0.0065) * deep, puddle);
  diffuseColor.rgb *= alb;
  // ---- roughness: dry ~0.72 -> damp 0.36..0.56 -> soaked 0.1..0.2 -> water 0.055, all smooth ramps ----
  float rough = mix(0.74, 0.42, damp) + (grain - 0.5) * 0.24 + (d1.g - 0.5) * 0.16 + conc * 0.03 - paint * 0.05;
  rough -= polish * 0.07 + mk.b * 0.16 + max(tar, seal) * 0.1;
  rough = mix(rough, 0.2 + (grain - 0.5) * 0.14, soak * 0.9);
  rough = mix(rough, 0.13, film * 0.8);
  rough += smoothstep(10.0, 80.0, gDist) * 0.04;
  rough = mix(clamp(rough, 0.1, 1.0), 0.055, puddle);
  // ---- normal (world xz slope): aggregate grain + lumps break up the mirror outside puddles ----
  vec2 nxz = (n1.rg - 0.5) * mix(2.1, 0.7, max(film, soak * 0.6)) + (n0.ba - 0.5) * 0.3;
  nxz *= 1.0 - puddle;
  float wsum = puddle + film * 0.2;
  vec2 wv = texture2D(uDetailN, gxz * 0.13 + uTime * vec2(0.031, 0.017)).ba - 0.5;
  vec2 wv2 = texture2D(uDetailN, gxz.yx * 0.31 - uTime * vec2(0.043, 0.027)).ba - 0.5;
  if (wsum > 0.004) {
    float rf = 1.0 - smoothstep(10.0, 34.0, gDist);
    vec2 rip = vec2(0.0);
    if (rf > 0.0) {
      vec2 gp2 = vec2(0.8 * gxz.x - 0.6 * gxz.y, 0.6 * gxz.x + 0.8 * gxz.y);
      vec2 r2 = gRipple(gp2, uTime * 0.87, 1.31, 2.0);
      rip = gRipple(gxz, uTime, 0.83, 1.0) + vec2(0.8 * r2.x + 0.6 * r2.y, -0.6 * r2.x + 0.8 * r2.y) * 0.9 + gRipple(gxz.yx, uTime * 1.13, 0.57, 3.0).yx * 0.6;
      rip *= rf * (0.3 + 0.7 * uRain) * 0.3 * smoothstep(0.0, 0.08, depth);
    }
    nxz += (rip + (wv * 0.03 + wv2 * 0.018) * (0.4 + 0.6 * deep)) * wsum;
    rough += (1.0 - rf) * 0.03 * puddle * uRain;
  }
  gSoak = soak;
  gRough = rough; gNxz = nxz; gPuddle = puddle; gWet = wet; gFilm = film;
}
`;
const APRON_REFLECTION_FRAG = `
{
  vec3 gV = normalize(cameraPosition - vGWorld);
  vec4 rc = uReflMatrix * vec4(vGWorld.x, 0.0, vGWorld.z, 1.0);
  vec2 ruv = rc.xy / max(rc.w, 1e-4);
  vec2 gf = normalize(-gV.xz + vec2(1e-5)); vec2 gs = vec2(-gf.y, gf.x);
  float sinE = clamp(gV.y, 0.03, 1.0);
  float dk = (gPuddle + gFilm * 0.15 + 0.03) / (1.0 + length(cameraPosition - vGWorld) * 0.07);
  vec2 tilt = vec2(dot(gNxz, gs) * sinE, dot(gNxz, gf)) * dk;
  tilt = clamp(tilt, vec2(-0.12), vec2(0.12));
  ruv += tilt * uReflScale;
  float r = material.roughness;
  // puddles: sharp mirror. Damp asphalt: only a heavily blurred, vertically stretched reflection that tightens a
  // little at grazing angles (so it reads as a sheen, not as a second mirror)
  float graz = pow(1.0 - clamp(gV.y, 0.0, 1.0), 5.0);
  float lodP = clamp(r * 9.5 - 0.45, 0.0, 6.5) + 0.9;      // puddles: a touch soft, never razor sharp
  float lodD = clamp(3.0 + r * 6.5 - 3.4 * graz, 2.0, 7.5);
  float lod = mix(mix(lodD, min(lodD, 2.6 + r * 5.0), gSoak), lodP, gPuddle) + uReflLod;
  vec2 st = vec2(0.0, r * 0.11 + (1.0 - gPuddle) * 0.05);
  vec2 lo = vec2(0.002), hi = vec2(0.998);
  vec3 pr = textureLod(uRefl, clamp(ruv, lo, hi), lod).rgb * 0.5
          + textureLod(uRefl, clamp(ruv + st, lo, hi), lod + 0.6).rgb * 0.25
          + textureLod(uRefl, clamp(ruv - st * 0.6, lo, hi), lod + 0.6).rgb * 0.25;
  pr = min(pr, vec3(48.0));
  float pw = mix(1.0 - smoothstep(0.55, 0.9, r), 1.0, max(gPuddle, gSoak)) * uReflOn;
  radiance = mix(radiance, pr, pw);
}
`;
/** Uniforms shared by the apron shader patch and the planar reflection pass. */
export interface ApronUniforms {
  [name: string]: IUniform;
  uTime: IUniform<number>;
  uRain: IUniform<number>;
  uWetG: IUniform<number>;
  uReflOn: IUniform<number>;
  uReflLod: IUniform<number>;
  uMarkRes: IUniform<number>;
  uMaskRes: IUniform<number>;
  uMask: IUniform<Texture>;
  uMarks: IUniform<Texture>;
  uDetail: IUniform<Texture>;
  uDetailN: IUniform<Texture>;
  uRefl: IUniform<Texture>;
  uMaskRect: IUniform<Vector3>;
  uMarkRect: IUniform<Vector4>;
  uReflMatrix: IUniform<Matrix4>;
  uReflScale: IUniform<Vector2>;
}

/** The apron (yard ground plane) mesh and its material. */
export interface ApronSurface {
  mesh: Mesh;
  material: MeshStandardMaterial;
  uniforms: ApronUniforms;
}

/** Builds the large wet-concrete ground plane with puddles, paint and reflections. */
export function createApronSurface(game: Game, textures: GroundTextures): ApronSurface {
  const wetUniform: IUniform<number> = (game.mats &&
    game.mats.uniforms &&
    game.mats.uniforms.wet) || {
    value: 1
  };
  const uniforms: ApronUniforms = {
    uTime: {
      value: 0
    },
    uRain: {
      value: 0.6
    },
    uWetG: wetUniform,
    uReflOn: {
      value: 0
    },
    uReflLod: {
      value: 0
    },
    uMarkRes: {
      value: textures.marks.image.width
    },
    uMaskRes: {
      value: textures.mask.image.width
    },
    uMask: {
      value: textures.mask
    },
    uMarks: {
      value: textures.marks
    },
    uDetail: {
      value: textures.detail
    },
    uDetailN: {
      value: textures.detailN
    },
    uRefl: {
      value: textures.black
    },
    uMaskRect: {
      value: new Vector3(GROUND_MASK_RECT.x0, GROUND_MASK_RECT.z0, 1 / GROUND_MASK_RECT.size)
    },
    uMarkRect: {
      value: new Vector4(
        ROAD_MARKINGS_RECT.x0,
        ROAD_MARKINGS_RECT.z0,
        1 / ROAD_MARKINGS_RECT.w,
        1 / ROAD_MARKINGS_RECT.h
      )
    },
    uReflMatrix: {
      value: new Matrix4()
    },
    uReflScale: {
      value: new Vector2(0.5, 0.5)
    }
  };
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0
  });
  material.name = 'apron_wet';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      `varying vec3 vGWorld;
` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  vGWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
` + APRON_COMMON_FRAG
      )
      .replace('#include <map_fragment>', APRON_MAP_FRAG)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  normal = normalize(mat3(viewMatrix) * normalize(vec3(-gNxz.x, 1.0, -gNxz.y)));`
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
  material.specularColor = mix(material.specularColor, vec3(0.075), max(gPuddle, gSoak * 0.5));`
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
` + APRON_REFLECTION_FRAG
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
  reflectedLight.directSpecular = min(reflectedLight.directSpecular, vec3(40.0));`
      );
  };
  material.customProgramCacheKey = () => 'saltline-apron-3';
  const geometry = new PlaneGeometry(190, 320, 1, 1).rotateX(-Math.PI / 2).translate(-65, 0, 0);
  const mesh = new Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'apron';
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return {
    mesh,
    material,
    uniforms
  };
}

/** Planar reflection state; `pass` is registered as a render pre-pass. */
export interface PlanarReflection {
  target: WebGLRenderTarget;
  camera: PerspectiveCamera;
  /** User toggle (see `Ground.setReflections`). */
  enabled: boolean;
  /** Whether the last pass actually rendered a reflection. */
  active: boolean;
  pass: (renderer: WebGLRenderer, scene: unknown, viewCamera: PerspectiveCamera) => void;
}

/**
 * Creates a mirrored camera + render target that renders the world reflected in the y = 0
 * ground plane (with an oblique near plane), feeding `uniforms.uRefl`. `hidden` objects are
 * hidden during the reflection render.
 */
export function createPlanarReflection(
  game: Game,
  uniforms: ApronUniforms,
  hidden: Object3D[]
): PlanarReflection {
  const camera = new PerspectiveCamera();
  camera.layers.set(0);
  camera.matrixAutoUpdate = true;
  const target = new WebGLRenderTarget(16, 16, {
    type: HalfFloatType,
    format: RGBAFormat,
    colorSpace: LinearSRGBColorSpace,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: true,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 0
  });
  target.texture.name = 'planarReflection';
  const eye = new Vector3();
  const lookTarget = new Vector3();
  const rotation = new Matrix4();
  const bufferSize = new Vector2();
  const clipPlane = new Plane();
  const clipVector = new Vector4();
  const corner = new Vector4();
  // Maps clip space [-1, 1] to texture space [0, 1].
  const biasMatrix = new Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  const savedVisibility: boolean[] = [];
  const state: PlanarReflection = {
    target,
    camera,
    enabled: true,
    active: false,
    pass
  };
  function pass(renderer: WebGLRenderer, _scene: unknown, viewCamera: PerspectiveCamera): void {
    const scale = game.quality.planar || 0;
    if (!state.enabled || scale <= 0) {
      uniforms.uReflOn.value = 0;
      state.active = false;
      return;
    }
    eye.setFromMatrixPosition(viewCamera.matrixWorld);
    if (eye.y < 0.03) {
      uniforms.uReflOn.value = 0;
      state.active = false;
      return;
    }
    const resolution = game.render && game.render.resolution;
    if (resolution && resolution.x > 8) bufferSize.copy(resolution);
    else renderer.getDrawingBufferSize(bufferSize);
    const width = Math.max(64, Math.round((bufferSize.x * scale) / 16) * 16);
    const height = Math.max(32, Math.round((bufferSize.y * scale) / 8) * 8);
    if (target.width !== width || target.height !== height) target.setSize(width, height);
    rotation.extractRotation(viewCamera.matrixWorld);
    lookTarget.set(0, 0, -1).applyMatrix4(rotation).add(eye);
    camera.position.set(eye.x, -eye.y, eye.z);
    camera.up.set(0, 1, 0).applyMatrix4(rotation);
    camera.up.y = -camera.up.y;
    lookTarget.y = -lookTarget.y;
    camera.lookAt(lookTarget);
    camera.near = viewCamera.near;
    camera.far = viewCamera.far;
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    camera.projectionMatrix.copy(viewCamera.projectionMatrix);
    uniforms.uReflMatrix.value
      .copy(biasMatrix)
      .multiply(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse);
    clipPlane.normal.set(0, 1, 0);
    clipPlane.constant = 0.01;
    clipPlane.applyMatrix4(camera.matrixWorldInverse);
    clipVector.set(clipPlane.normal.x, clipPlane.normal.y, clipPlane.normal.z, clipPlane.constant);
    // Oblique near-plane clipping (Lengyel): replace the third row of the projection matrix.
    const proj = camera.projectionMatrix.elements;
    corner.x = (Math.sign(clipVector.x) + proj[8]) / proj[0];
    corner.y = (Math.sign(clipVector.y) + proj[9]) / proj[5];
    corner.z = -1;
    corner.w = (1 + proj[10]) / proj[14];
    clipVector.multiplyScalar(2 / clipVector.dot(corner));
    proj[2] = clipVector.x;
    proj[6] = clipVector.y;
    proj[10] = clipVector.z + 1;
    proj[14] = clipVector.w;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    const viewProj = viewCamera.projectionMatrix.elements;
    uniforms.uReflScale.value.set(viewProj[0] * 0.5, viewProj[5] * 0.5);
    uniforms.uReflLod.value = Math.log2(Math.max(height, 1) / 270);
    for (let i = 0; i < hidden.length; i++) {
      savedVisibility[i] = hidden[i].visible;
      hidden[i].visible = false;
    }
    try {
      game.render.renderWorld(camera, target);
    } finally {
      for (let i = 0; i < hidden.length; i++) hidden[i].visible = savedVisibility[i];
    }
    uniforms.uRefl.value = target.texture;
    uniforms.uReflOn.value = 1;
    state.active = true;
  }
  return state;
}
/**
 * Gerstner-ish wave tables: [dirX, dirZ, wavelength, amplitude]; the loop below normalises the
 * direction and appends [4] = wavenumber and [5] = angular speed (deep-water dispersion).
 */
const SEA_SWELL_WAVES: number[][] = [
  [-0.92, 0.39, 9.5, 0.06],
  [-0.75, -0.66, 5.7, 0.04],
  [-0.99, 0.12, 3.3, 0.026],
  [-0.5, 0.87, 2, 0.016]
];
const SEA_CHOP_WAVES: number[][] = [
  [-0.8, 0.6, 1.31, 0.02],
  [-0.95, -0.31, 0.83, 0.014],
  [-0.35, -0.94, 0.57, 0.01],
  [-0.6, 0.8, 0.39, 0.007],
  [-1, 0.05, 0.27, 0.005],
  [0.3, 0.95, 0.47, 0.006],
  [-0.86, -0.51, 0.21, 0.0035]
];
for (const wave of SEA_SWELL_WAVES.concat(SEA_CHOP_WAVES)) {
  const length = Math.hypot(wave[0], wave[1]);
  wave[0] /= length;
  wave[1] /= length;
  wave[4] = (2 * Math.PI) / wave[2];
  wave[5] = Math.sqrt(9.81 * wave[4]);
}

/** Formats a number as a GLSL float literal. */
const formatGlslFloat = (value: number): string =>
  Number.isInteger(value) ? value.toFixed(1) : value.toFixed(5);

/** CPU copy of the sea's swell displacement: water surface height at (x, z) and time. */
export function seaHeightAt(x: number, z: number, time: number): number {
  const falloff = 1 - MathUtils.smoothstep(Math.hypot(x - 30, z), 50, 220);
  let offset = 0;
  for (const wave of SEA_SWELL_WAVES)
    offset += wave[3] * Math.sin(wave[4] * (wave[0] * x + wave[1] * z) - wave[5] * time);
  return WORLD_BOUNDS.seaY + offset * falloff;
}

const seaDisplacementGlsl = SEA_SWELL_WAVES.map(
  (wave: number[]) =>
    `  { float ph = ${formatGlslFloat(wave[4])} * dot(vec2(${formatGlslFloat(wave[0])}, ${formatGlslFloat(wave[1])}), swp.xz) - ${formatGlslFloat(wave[5])} * uTime; sdisp.y += ${formatGlslFloat(wave[3])} * sin(ph); sdisp.xz += vec2(${formatGlslFloat(wave[0])}, ${formatGlslFloat(wave[1])}) * (${formatGlslFloat(wave[3] * 0.6)} * cos(ph)); }`
).join(`
`);
const seaSwellSlopeGlsl = SEA_SWELL_WAVES.map(
  (wave: number[]) =>
    `  slopeA += vec2(${formatGlslFloat(wave[0])}, ${formatGlslFloat(wave[1])}) * (${formatGlslFloat(wave[3] * wave[4])} * cos(${formatGlslFloat(wave[4])} * dot(vec2(${formatGlslFloat(wave[0])}, ${formatGlslFloat(wave[1])}), sxz) - ${formatGlslFloat(wave[5])} * uTime));`
).join(`
`);
const seaChopSlopeGlsl = SEA_CHOP_WAVES.map(
  (wave: number[]) =>
    `  slopeB += vec2(${formatGlslFloat(wave[0])}, ${formatGlslFloat(wave[1])}) * (${formatGlslFloat(wave[3] * wave[4])} * cos(${formatGlslFloat(wave[4])} * dot(vec2(${formatGlslFloat(wave[0])}, ${formatGlslFloat(wave[1])}), sxz) - ${formatGlslFloat(wave[5])} * uTime));`
).join(`
`);
const SEA_COMMON_FRAG = `
uniform float uTime; uniform sampler2D uDetail, uDetailN; uniform vec3 uHazeA, uHazeB, uSunDirW;
varying vec3 vGWorld; varying float vSAmp;
float gRough; vec2 gNxz; float gOcc; float gSDist; float gSpark;
`;
const SEA_MAP_FRAG = `
{
  vec2 sxz = vGWorld.xz;
  float sd = length(cameraPosition - vGWorld); gSDist = sd;
  vec2 slopeA = vec2(0.0), slopeB = vec2(0.0);
${seaSwellSlopeGlsl}
${seaChopSlopeGlsl}
  float nearB = 1.0 - smoothstep(25.0, 110.0, sd);
  vec2 t1 = texture2D(uDetailN, sxz * 0.113 + uTime * vec2(-0.021, 0.009)).ba - 0.5;
  vec2 t2 = texture2D(uDetailN, sxz * 0.031 + uTime * vec2(-0.007, -0.004)).ba - 0.5;
  vec2 t3 = texture2D(uDetailN, sxz.yx * 0.39 + uTime * vec2(0.031, -0.027)).ba - 0.5;
  gNxz = slopeA * vSAmp + slopeB * nearB + t1 * 0.2 + t2 * 0.24 + t3 * 0.1 * nearB;
  // foam / scum along the quay wall (x = 30) and around the moored hull x[33,49] z[-60,-9]
  float dq = sxz.x - 30.0;
  vec2 hq = abs(sxz - vec2(41.0, -34.5)) - vec2(4.0, 21.5);
  float dh = length(max(hq, 0.0)) + min(max(hq.x, hq.y), 0.0) - 4.0;
  float de = min(dq, dh);
  vec4 fn = texture2D(uDetail, sxz * 0.41 + uTime * vec2(-0.012, 0.007));
  vec4 fn2 = texture2D(uDetail, sxz * 0.093 + uTime * vec2(0.004, 0.003));
  float band = 1.0 - smoothstep(0.0, 0.2 + fn2.g * fn2.g * 2.2, de);
  float foam = clamp(band * smoothstep(0.5, 0.68, fn.a * 0.55 + fn.r * 0.25 + fn2.g * 0.3 + band * 0.2), 0.0, 1.0) * step(-0.3, de);
  float scum = (1.0 - smoothstep(0.0, 5.0, de)) * smoothstep(0.4, 0.7, fn2.g);
  vec3 alb = vec3(0.0045, 0.013, 0.017);
  alb = mix(alb, vec3(0.03, 0.04, 0.034), scum * 0.6);
  alb = mix(alb, vec3(0.3, 0.32, 0.3), foam * 0.7);
  diffuseColor.rgb *= alb;
  // wind structure: broad cat's-paw patches (ruffled, darker, duller) between calmer slicks, plus long swell shading
  vec4 fn3 = texture2D(uDetail, sxz * 0.0123 + uTime * vec2(0.0016, 0.0011));
  float gust = smoothstep(0.38, 0.62, fn2.g * 0.45 + fn3.g * 0.75 - 0.1);
  float swell = sin(dot(sxz, vec2(-0.118, 0.05)) - uTime * 0.55 + fn3.a * 5.0) * 0.5 + 0.5;
  gNxz = gNxz * mix(0.4, 1.35, gust) + vec2(-0.92, 0.39) * (swell - 0.5) * 0.07;
  gSpark = mix(0.55, 1.0, swell) * mix(1.0, 0.6, gust);
  diffuseColor.rgb *= mix(1.0, 0.6, gust);
  gRough = mix(mix(0.1, 0.32, smoothstep(12.0, 380.0, sd)) * mix(0.62, 1.5, gust), 0.65, max(foam, scum * 0.3));
  gNxz *= 1.0 - foam * 0.6;
  gOcc = mix(0.3, 1.0, smoothstep(0.0, 8.0, de)) * mix(0.8, 1.05, swell);
}
`;
const SEA_HAZE_FRAG = `
{
  vec3 sdir = normalize(vGWorld - cameraPosition);
  float toSun = pow(max(dot(normalize(sdir.xz + vec2(1e-5)), normalize(uSunDirW.xz)), 0.0), 3.0);
  vec3 hz = mix(uHazeA, uHazeB, toSun);
  outgoingLight = mix(outgoingLight, hz, smoothstep(220.0, 860.0, gSDist) * 0.8);
}
`;
/** Coordinates from `start` to `end`, stepping by `step` that grows by `growth` up to `maxStep`. */
function buildGrowingSpacing(
  start: number,
  end: number,
  step: number,
  growth: number,
  maxStep: number
): number[] {
  const coords = [start];
  let position = start;
  let currentStep = step;
  while (position < end - 0.001) {
    position = Math.min(end, position + currentStep);
    coords.push(position);
    currentStep = Math.min(maxStep, currentStep * growth);
  }
  return coords;
}

/** Uniforms injected into the sea material. */
export interface SeaUniforms {
  [name: string]: IUniform;
  uTime: IUniform<number>;
  uDetail: IUniform<Texture>;
  uDetailN: IUniform<Texture>;
  uHazeA: IUniform<Color>;
  uHazeB: IUniform<Color>;
  uSunDirW: IUniform<Vector3>;
}

/** The sea mesh, the quay-wall skirt below the apron edge, and the sea material. */
export interface SeaSurface {
  mesh: Mesh;
  skirt: Mesh;
  uniforms: SeaUniforms;
  material: MeshStandardMaterial;
}

/** Builds the sea: a grid dense near the quay that grows coarser outward, plus far filler quads. */
export function createSeaSurface(_game: Game, textures: GroundTextures): SeaSurface {
  const seaY = WORLD_BOUNDS.seaY;
  const xs = buildGrowingSpacing(27.5, 880, 0.75, 1.075, 120);
  const zOuter = buildGrowingSpacing(48, 880, 0.9, 1.085, 120);
  const zs = zOuter
    .map((z) => -z)
    .reverse()
    .concat(buildGrowingSpacing(-48 + 0.9, 48 - 0.9, 0.9, 1, 0.9), zOuter.slice(0));
  const columns = xs.length;
  const rows = zs.length;
  const extraVertices = 12;
  const positions = new Float32Array((columns * rows + extraVertices) * 3);
  const indices: number[] = [];
  let cursor = 0;
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < columns; col++) {
      positions[cursor++] = xs[col];
      positions[cursor++] = seaY;
      positions[cursor++] = zs[row];
    }
  for (let row = 0; row < rows - 1; row++)
    for (let col = 0; col < columns - 1; col++) {
      const i00 = row * columns + col;
      const i10 = i00 + 1;
      const i01 = i00 + columns;
      const i11 = i01 + 1;
      indices.push(i00, i01, i10, i10, i01, i11);
    }
  const addQuad = (x1: number, z1: number, x2: number, z2: number): void => {
    const base = cursor / 3;
    for (const [x, z] of [
      [x1, z1],
      [x2, z1],
      [x1, z2],
      [x2, z2]
    ]) {
      positions[cursor++] = x;
      positions[cursor++] = seaY;
      positions[cursor++] = z;
    }
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  };
  addQuad(-880, -880, 27.5, -158);
  addQuad(-880, 158, 27.5, 880);
  addQuad(-880, -158, -158, 158);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const normals = new Float32Array(positions.length);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.boundingSphere = new Sphere(new Vector3(0, seaY, 0), 1300);
  const hazeAway = SKY_COLORS.horizonAway.clone().multiplyScalar(0.85);
  const hazeSun = SKY_COLORS.horizon.clone().multiplyScalar(0.8);
  const uniforms: SeaUniforms = {
    uTime: {
      value: 0
    },
    uDetail: {
      value: textures.detail
    },
    uDetailN: {
      value: textures.detailN
    },
    uHazeA: {
      value: hazeAway
    },
    uHazeB: {
      value: hazeSun
    },
    uSunDirW: {
      value: SUN.dir.clone()
    }
  };
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.1,
    metalness: 0
  });
  material.name = 'sea';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      `uniform float uTime; varying vec3 vGWorld; varying float vSAmp;
` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  vec3 swp = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vSAmp = 1.0 - smoothstep(50.0, 220.0, distance(swp.xz, vec2(30.0, 0.0)));
  vec3 sdisp = vec3(0.0);
${seaDisplacementGlsl}
  transformed += sdisp * vSAmp;
  vGWorld = swp;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
` + SEA_COMMON_FRAG
      )
      .replace('#include <map_fragment>', SEA_MAP_FRAG)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  normal = normalize(mat3(viewMatrix) * normalize(vec3(-gNxz.x, 1.0, -gNxz.y)));`
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
  radiance *= gOcc; iblIrradiance *= gOcc;`
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
  { // sun glitter: strongest along the sun's azimuth, calmer to the sides; broken by swell and cat's paws
    vec3 sv = normalize(vGWorld - cameraPosition);
    float az = max(dot(normalize(sv.xz + vec2(1e-5)), normalize(uSunDirW.xz)), 0.0);
    reflectedLight.directSpecular = min(reflectedLight.directSpecular, vec3(40.0)) * gSpark * mix(0.3, 1.0, az * az * az);
  }`
      )
      .replace(
        '#include <opaque_fragment>',
        SEA_HAZE_FRAG +
          `
#include <opaque_fragment>`
      );
  };
  material.customProgramCacheKey = () => 'saltline-sea-1';
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sea';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  const skirtMaterial = new MeshStandardMaterial({
    color: 0x0b0d0e,
    roughness: 0.55,
    metalness: 0
  });
  const skirt = new Mesh(
    new PlaneGeometry(320, 4.4).rotateY(Math.PI / 2).translate(29.88, -2.18, 0),
    skirtMaterial
  );
  skirt.name = 'quaySkirt';
  skirt.receiveShadow = true;
  skirt.matrixAutoUpdate = false;
  return {
    mesh,
    skirt,
    uniforms,
    material
  };
}
