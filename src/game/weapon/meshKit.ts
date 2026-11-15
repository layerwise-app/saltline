// Weapon mesh kit: procedural geometry helpers (rounded boxes, extrusions, lathes, lofts) that bake
// per-vertex tint and a wear/cavity/bare/zone `aSurf` attribute, the shared weapon finish shader
// (`applyWeaponFinish`), voxel ambient-occlusion baking, the full PAC-9 rifle geometry build, and
// small easing / spring / keyframe utilities used by the viewmodel animation code.
import {
  BufferAttribute,
  BufferGeometry,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Matrix4,
  Path,
  Quaternion,
  Shape,
  ShapeUtils,
  Vector2
} from 'three';
import type {
  EulerOrder,
  TypedArray,
  IUniform,
  MeshStandardMaterial,
  Vector3,
  WebGLProgramParametersWithUniforms
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { roundedBox, tubeThroughPoints } from '../render/geometry';
import { derivativeBumpGlsl } from './markings';

/** RGB multiplier baked into a part's vertex colours (`[r, g, b]`). */
export type Tint = readonly number[];
/** A 2D outline point `[x, y]`. */
export type Point2 = readonly number[];
/** A 3D point `[x, y, z]`. */
export type Point3 = readonly number[];
/** A closed 2D outline. */
export type Outline = readonly Point2[];
/** Optional Euler rotation `[x, y, z]` applied before placement. */
export type Rotation3 = readonly number[] | null;

/**
 * Options shared by the kit's geometry builders. Wear-related fields end up in the `aSurf`
 * attribute (x: edge wear, y: cavity/AO, z: bare metal, w: grip zone).
 */
export interface KitPartOptions {
  /** Edge-wear multiplier (default 1). */
  wear?: number;
  /** Bare-metal amount (0..1). */
  bare?: number;
  /** Grip/handling zone amount (0..1). */
  zone?: number;
  /** Base cavity/occlusion amount. */
  ao?: number;
  /** Extra per-vertex occlusion, sampled at the vertex position. */
  aoFn?: (x: number, y: number, z: number) => number;
  /** Keep the source normals instead of recomputing crease normals. */
  keepN?: boolean;
  /** Crease angle in degrees for normal smoothing (default 50). */
  crease?: number;
  /** Extrusions: hole outlines. */
  holes?: readonly Outline[];
  /** Extrusions: bevel segments. */
  bs?: number;
  /** Lathes: axis offset in x / y. */
  ox?: number;
  oy?: number;
  /** Lofts: whether to cap the first / last section. */
  caps?: readonly boolean[];
}

/** Options for `outlineToRing`: scale / offset / rake applied to the 2D outline. */
export interface RingOptions {
  sx?: number;
  sy?: number;
  dx?: number;
  dy?: number;
  cy?: number;
  rake?: number;
}

/** A named finish preset applied by `applyWeaponFinish` when the material name matches. */
export interface WeaponFinishPreset {
  kind: number;
  color: readonly number[];
  roughness: number;
  metalness: number;
}

/** Global rain-wetness uniform shared by every weapon finish material. */
export const weaponRainUniform: IUniform<number> = {
    value: 1
  },
  WEAPON_FINISH_PRESETS: Record<string, WeaponFinishPreset> = {
    pac9_anodised: {
      kind: 0,
      color: [0.038, 0.039, 0.043],
      roughness: 0.54,
      metalness: 0.1
    },
    pac9_phosphate: {
      kind: 1,
      color: [0.042, 0.042, 0.043],
      roughness: 0.66,
      metalness: 0.2
    },
    pac9_polymer: {
      kind: 2,
      color: [0.034, 0.035, 0.038],
      roughness: 0.6,
      metalness: 0
    },
    pac9_polymer_tan: {
      kind: 2,
      color: [0.15, 0.112, 0.068],
      roughness: 0.6,
      metalness: 0
    },
    pac4_nitride: {
      kind: 3,
      color: [0.034, 0.035, 0.039],
      roughness: 0.47,
      metalness: 0.35
    },
    pac9_matte: {
      kind: 4,
      color: [1, 1, 1],
      roughness: 0.86,
      metalness: 0
    }
  },
  finishDetailCommonGlsl =
    `
varying vec3 vObjP; varying vec3 vWNrm; varying vec3 vONrm; varying vec4 vSurf; uniform float uRain;
float dh3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float dn3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dh3(i), dh3(i + vec3(1,0,0)), f.x), mix(dh3(i + vec3(0,1,0)), dh3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(dh3(i + vec3(0,0,1)), dh3(i + vec3(1,0,1)), f.x), mix(dh3(i + vec3(0,1,1)), dh3(i + vec3(1,1,1)), f.x), f.y), f.z); }
vec2 dh2(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
vec2 dDrops(vec2 uv, float cell, float seed, float thr){ vec2 g = uv / cell, i = floor(g), f = fract(g); float best = 0.0;
  for (int a = -1; a <= 1; a++) for (int b = -1; b <= 1; b++) { vec2 o = vec2(float(a), float(b)); vec2 r = dh2(i + o + seed);
    float keep = step(thr, fract(r.x * 7.31 + r.y * 3.17)); vec2 c = o + 0.2 + 0.6 * r; float rad = (0.14 + 0.20 * fract(r.x * 13.7)) * keep;
    float d = length(f - c); best = max(best, sqrt(max(rad * rad - d * d, 0.0))); }
  return vec2(best * cell, step(1e-6, best)); }
` + derivativeBumpGlsl,
  finishDetailSurfaceGlsl = `
vec3 dP = vObjP; vec3 dAn = abs(vONrm);
vec2 dUV = (dAn.y > dAn.x && dAn.y > dAn.z) ? dP.xz : (dAn.x > dAn.z ? dP.zy : dP.xy);
float dEdge = vSurf.x, dCav = vSurf.y, dBare = vSurf.z, dZone = vSurf.w;
float dPx = length(fwidth(dP));                                         // metres of surface per pixel
float dNear = 1.0 - smoothstep(0.00020, 0.00075, dPx);                  // micro detail fades out before it can alias
vec3 dQ = mat3(0.36, 0.48, -0.80, -0.80, 0.60, 0.0, 0.48, 0.64, 0.60) * dP;       // turned domain: the noise lattice never lines up with the gun
float dLo = dn3(dQ * 34.0), dMid = dn3(dQ * 180.0 + 7.0);
float dGr = (dh3(floor(dP * 2900.0)) - 0.5) * dNear;                    // finest grain: one hash
float dScr = dn3(dP * vec3(640.0, 640.0, 21.0) + 3.0);                  // long fine scratches along the bore
float dHt = 0.0, dR = 0.0; vec3 dAlb = diffuseColor.rgb;
float dBreak = dMid * 0.65 + dLo * 0.35;
float dPolish = smoothstep(0.15, 0.85, dEdge) * (0.35 + 0.65 * dLo);     // exposed edges are a little burnished, unevenly
float dWorn = smoothstep(0.60, 0.72, dBreak) * smoothstep(0.55, 0.95, dEdge);   // and worn through in a few patches (high-wear parts only)
float dScratch = smoothstep(0.80, 0.94, dScr) * (0.10 + 0.90 * dZone) * smoothstep(0.30, 0.62, dMid * 0.5 + dLo * 0.5) * (1.0 - smoothstep(0.0007, 0.0020, dPx));
#if D_KIND == 0
  float smear = smoothstep(0.52, 0.82, dn3(dQ * vec3(52.0, 30.0, 15.0) + 11.0));      // palm and finger oil on the flats
  dR = (dLo - 0.5) * 0.14 + (dMid - 0.5) * 0.08 + dGr * 0.10 - smear * 0.12;
  dHt = dGr * 0.000012;
  dAlb *= (0.90 + 0.20 * dLo) * (1.0 - 0.10 * smear);
  dAlb = mix(dAlb, dAlb * 1.7 + 0.005, dPolish * 0.55); dR -= dPolish * 0.06;
  dAlb = mix(dAlb, vec3(0.30, 0.31, 0.33), dScratch * 0.55); dR -= dScratch * 0.10; dHt -= dScratch * 0.000012;
  metalnessFactor = mix(metalnessFactor, 1.0, max(dWorn, dScratch * 0.5));
  dAlb = mix(dAlb, vec3(0.50, 0.51, 0.53), dWorn); dR = mix(dR, -0.10 + 0.12 * dMid, dWorn);
#elif D_KIND == 3
  float lay = dn3(vec3(dP.xy * 2600.0, dP.z * 36.0));                                  // surface-ground lay along the bore
  float smear = smoothstep(0.50, 0.80, dn3(dQ * vec3(60.0, 34.0, 20.0) + 11.0));
  dR = (dLo - 0.5) * 0.10 + (lay - 0.5) * 0.14 * dNear + dGr * 0.04 - smear * 0.11;
  dHt = lay * 0.000007 * dNear;
  dAlb *= (0.92 + 0.16 * dLo) * (1.0 - 0.12 * smear);
  dAlb = mix(dAlb, dAlb * 1.9 + 0.006, dPolish * 0.6); dR -= dPolish * 0.06;
  dAlb = mix(dAlb, vec3(0.16, 0.16, 0.17), dScratch * 0.35); dR -= dScratch * 0.06;
  float through = dWorn * 0.8;                                                         // holster wear: grey steel, not silver
  metalnessFactor = mix(metalnessFactor, 1.0, through); dAlb = mix(dAlb, vec3(0.36, 0.36, 0.37), through); dR = mix(dR, -0.06, through);
#elif D_KIND == 1
  float oil = smoothstep(0.30, 0.72, dn3(dQ * vec3(46.0, 46.0, 30.0) + 5.0));
  float lay = dn3(vec3(dP.xy * 1400.0, dP.z * 60.0));
  // phosphate: crystalline, porous, drinks oil
  float cR = (dLo - 0.5) * 0.14 + dGr * 0.14 - oil * 0.20, cH = dGr * 0.000022 + dMid * 0.000004;
  vec3 cA = dAlb * mix(1.22, 0.72, oil) * (0.94 + 0.12 * dMid);
  cA = mix(cA, cA * 1.8 + 0.006, dPolish * 0.6); cR -= dPolish * 0.10;
  float cM = metalnessFactor; float through = max(dWorn, dScratch * 0.6);
  cM = mix(cM, 1.0, through); cA = mix(cA, vec3(0.40, 0.40, 0.41), through); cR = mix(cR, -0.26 + 0.10 * dMid, through);
  // bare: turned or ground steel, faint lay, a little staining
  float bR = -0.30 + (lay - 0.5) * 0.20 + (dLo - 0.5) * 0.14, bH = lay * 0.000008 * dNear;
  vec3 bA = min(dAlb, vec3(0.78)) * (0.86 + 0.20 * dMid); bA = mix(bA, bA * vec3(0.72, 0.62, 0.50), smoothstep(0.62, 0.9, dLo) * 0.35);
  dAlb = mix(cA, bA, dBare); dR = mix(cR, bR, dBare); dHt = mix(cH, bH, dBare); metalnessFactor = mix(cM, 1.0, dBare);
#elif D_KIND == 4
  // rubber and matte liners (the 'plain' group, absolute vertex albedo): fine moulded grain, chalky bloom, shiny where rubbed
  float bloom = smoothstep(0.45, 0.80, dMid * 0.6 + dLo * 0.4);
  dR = (dLo - 0.5) * 0.10 + dGr * 0.08 - dPolish * 0.22; dHt = dGr * 0.000018;
  dAlb = mix(dAlb, dAlb * 1.5 + 0.012, bloom * 0.35) * (1.0 + 0.35 * dPolish);
#else
  float st = dn3(dP * 1500.0) * 0.6 + dh3(floor(dP * 3300.0)) * 0.4;                    // mould texture (VDI-ish spark finish)
  dR = (dLo - 0.5) * 0.14 + (st - 0.5) * 0.12 * dNear - smoothstep(0.55, 0.90, dMid) * 0.035;
  dHt = st * 0.000045 * dNear;
  dAlb *= 0.92 + 0.16 * dLo;
  // studded grip zones: 1.15 mm pyramids on a diagonal grid; past the range where they resolve they fold into roughness
  float zk = smoothstep(0.35, 0.60, dZone); vec2 q = vec2(dUV.x + dUV.y, dUV.x - dUV.y) / 0.00115, qc = abs(fract(q) - 0.5);
  float stud = 1.0 - smoothstep(0.10, 0.46, max(qc.x, qc.y)), studK = 1.0 - smoothstep(0.00024, 0.00056, dPx);   // gone before a stud is under two pixels: no moire
  dHt += zk * stud * 0.00028 * studK; dR += zk * (0.10 - stud * 0.16 * studK);
  dAlb *= 1.0 - zk * 0.14 * (1.0 - stud * studK);
  // moulding parting line on the centre plane, flash trimmed
  float pl = (1.0 - smoothstep(0.00012, 0.00034, abs(dP.x))) * step(dAn.x, 0.55) * dNear; dHt += pl * 0.00005; dR -= pl * 0.10;
  // handling shine on edges, a few pale scuffs (polymer whitens where it is scraped)
  float scuff = smoothstep(0.86, 0.96, dScr) * smoothstep(0.45, 0.70, dLo) * (1.0 - smoothstep(0.0007, 0.0020, dPx));
  dAlb = mix(dAlb, dAlb * 1.5 + 0.006, dPolish * 0.5); dR -= dPolish * 0.12;
  dAlb = mix(dAlb, dAlb * 2.0 + 0.015, scuff * 0.35 + dWorn * 0.25); dR += scuff * 0.06;
#endif
// recesses: darker, rougher, a little pale dust settled in them
float dGrime = dCav * (0.55 + 0.45 * dMid);
dAlb *= 1.0 - 0.50 * dGrime;
dAlb = mix(dAlb, vec3(0.115, 0.100, 0.082), dCav * smoothstep(0.50, 0.85, dLo * 0.5 + dMid * 0.5) * 0.30);
dR += dGrime * 0.22; metalnessFactor *= 1.0 - 0.5 * dGrime;
// rain
float dUpN = vWNrm.y, dUp = smoothstep(0.30, 0.75, dUpN) * uRain, dSide = (1.0 - smoothstep(0.10, 0.60, abs(dUpN))) * uRain;
float dDrop = 0.0, dDropH = 0.0, dRun = 0.0;
if (dUp > 0.002) { vec2 dD1 = dDrops(dUV, 0.0050, 3.0, 0.80), dD2 = dDrops(dUV + 0.31, 0.0024, 9.0, 0.90); dDrop = max(dD1.y, dD2.y) * dUp; dDropH = max(dD1.x, dD2.x) * dUp; }
if (dSide > 0.002) dRun = smoothstep(0.80, 0.90, dn3(vec3(dP.x * 420.0 + dP.z * 610.0, dP.y * 9.0, dP.z * 37.0))) * smoothstep(0.42, 0.62, dLo) * dSide * (1.0 - smoothstep(0.0008, 0.0024, dPx));   // run-off: thin, sparse, broken trickles
float dWet = max(dUp * (0.5 + 0.5 * smoothstep(0.3, 0.7, dLo)), dRun * 0.55);
diffuseColor.rgb = dAlb * (1.0 - 0.20 * dWet);
roughnessFactor = clamp(roughnessFactor + dR, 0.12, 1.0);
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.52, dWet);
roughnessFactor = mix(roughnessFactor, 0.20, dDrop * 0.8);
float dOcc = 1.0 - 0.80 * dCav;
`,
  finishDetailNormalGlsl = `
normal = dBump(normal, dHt + dDropH * 0.17);
`,
  finishDetailOcclusionGlsl = `
reflectedLight.indirectDiffuse *= dOcc; reflectedLight.indirectSpecular *= dOcc * dOcc;
reflectedLight.directDiffuse *= mix(1.0, dOcc, 0.35); reflectedLight.directSpecular *= mix(1.0, dOcc, 0.6);
`;
/**
 * Patch a standard material with the procedural weapon finish (micro detail, wear, grime, rain).
 * If the material's name matches a preset, its colour/roughness/metalness and kind come from it.
 */
export function applyWeaponFinish(
  material: MeshStandardMaterial,
  kind: number
): MeshStandardMaterial {
  let preset = WEAPON_FINISH_PRESETS[material.name];
  if (preset) {
    kind = preset.kind;
    material.color.setRGB(preset.color[0], preset.color[1], preset.color[2]);
    material.roughness = preset.roughness;
    material.metalness = preset.metalness;
  }
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uRain = weaponRainUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aSurf; varying vec3 vObjP; varying vec3 vWNrm; varying vec3 vONrm; varying vec4 vSurf;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vObjP = position; vONrm = normal; vWNrm = normalize(mat3(modelMatrix) * normal); vSurf = aSurf;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
#define D_KIND ` +
          (kind | 0) +
          `
` +
          finishDetailCommonGlsl
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
` + finishDetailSurfaceGlsl
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
` + finishDetailNormalGlsl
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
` + finishDetailOcclusionGlsl
      );
  };
  material.customProgramCacheKey = () => 'pac-detail-3-' + kind;
  return material;
}
const kitSmoothstep = (edge0: number, edge1: number, x: number): number => {
  let k = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return k * k * (3 - 2 * k);
};
/** Recompute flat-shaded vertex normals of a non-indexed geometry, smoothing across faces within the crease angle. */
function computeCreaseNormals(geometry: BufferGeometry, creaseAngleDeg: number): void {
  let positions = geometry.attributes.position.array,
    vertexCount = positions.length / 3,
    faceCount = vertexCount / 3,
    faceNormals = new Float32Array(faceCount * 3),
    faceAreas = new Float32Array(faceCount);
  for (let face = 0; face < faceCount; face++) {
    let base = face * 9,
      e1x = positions[base + 3] - positions[base],
      e1y = positions[base + 4] - positions[base + 1],
      e1z = positions[base + 5] - positions[base + 2],
      e2x = positions[base + 6] - positions[base],
      e2y = positions[base + 7] - positions[base + 1],
      e2z = positions[base + 8] - positions[base + 2],
      nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x,
      len = Math.hypot(nx, ny, nz) || 1;
    faceNormals[face * 3] = nx / len;
    faceNormals[face * 3 + 1] = ny / len;
    faceNormals[face * 3 + 2] = nz / len;
    faceAreas[face] = len;
  }
  let cosCrease = Math.cos((creaseAngleDeg * Math.PI) / 180),
    buckets = new Map<number, number[]>(),
    quantize = 5e4;
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    let key =
        (Math.round(positions[vertex * 3] * quantize) + 65536) * 17179869184 +
        (Math.round(positions[vertex * 3 + 1] * quantize) + 65536) * 131072 +
        (Math.round(positions[vertex * 3 + 2] * quantize) + 65536),
      bucket = buckets.get(key);
    if (bucket) {
      bucket.push(vertex);
    } else {
      buckets.set(key, [vertex]);
    }
  }
  let normals = new Float32Array(vertexCount * 3);
  for (let bucket of buckets.values())
    for (let vertex of bucket) {
      let face = (vertex / 3) | 0,
        fnx = faceNormals[face * 3],
        fny = faceNormals[face * 3 + 1],
        fnz = faceNormals[face * 3 + 2],
        sumX = 0,
        sumY = 0,
        sumZ = 0;
      for (let other of bucket) {
        let otherFace = (other / 3) | 0;
        if (
          fnx * faceNormals[otherFace * 3] +
            fny * faceNormals[otherFace * 3 + 1] +
            fnz * faceNormals[otherFace * 3 + 2] >=
          cosCrease
        ) {
          let weight = faceAreas[otherFace];
          sumX += faceNormals[otherFace * 3] * weight;
          sumY += faceNormals[otherFace * 3 + 1] * weight;
          sumZ += faceNormals[otherFace * 3 + 2] * weight;
        }
      }
      let len = Math.hypot(sumX, sumY, sumZ);
      if (len > 1e-20) {
        normals[vertex * 3] = sumX / len;
        normals[vertex * 3 + 1] = sumY / len;
        normals[vertex * 3 + 2] = sumZ / len;
      } else {
        normals[vertex * 3] = fnx;
        normals[vertex * 3 + 1] = fny;
        normals[vertex * 3 + 2] = fnz;
      }
    }
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
}
/**
 * De-index and clean a geometry (drops degenerate triangles), set its normals, then bake the
 * `color` (tint) and `aSurf` (wear, cavity, bare, zone) attributes from curvature and options.
 */
function bakeSurfaceWearAttributes(
  source: BufferGeometry,
  tint: Tint,
  options: KitPartOptions = {}
): BufferGeometry {
  let geometry = source.index ? source.toNonIndexed() : source,
    positions = geometry.attributes.position.array,
    normals = geometry.attributes.normal ? geometry.attributes.normal.array : null,
    keptPositions: number[] = [],
    keptNormals: number[] = [];
  for (let tri = 0; tri < positions.length; tri += 9) {
    let e1x = positions[tri + 3] - positions[tri],
      e1y = positions[tri + 4] - positions[tri + 1],
      e1z = positions[tri + 5] - positions[tri + 2],
      e2x = positions[tri + 6] - positions[tri],
      e2y = positions[tri + 7] - positions[tri + 1],
      e2z = positions[tri + 8] - positions[tri + 2];
    if (!(Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x) < 1e-11))
      for (let k = 0; k < 9; k++) {
        keptPositions.push(positions[tri + k]);
        if (normals) {
          keptNormals.push(normals[tri + k]);
        }
      }
  }
  let baked = new BufferGeometry();
  baked.setAttribute('position', new BufferAttribute(new Float32Array(keptPositions), 3));
  if (options.keepN && normals) {
    baked.setAttribute('normal', new BufferAttribute(new Float32Array(keptNormals), 3));
  } else {
    computeCreaseNormals(baked, options.crease || 50);
  }
  let vertexCount = keptPositions.length / 3,
    bakedNormals = baked.attributes.normal.array,
    colors = new Float32Array(vertexCount * 3),
    surf = new Float32Array(vertexCount * 4),
    maxCurvature = new Float32Array(vertexCount),
    minCurvature = new Float32Array(vertexCount),
    wear = options.wear == null ? 1 : options.wear,
    bare = options.bare || 0,
    zone = options.zone || 0,
    ao = options.ao || 0;
  for (let tri = 0; tri < vertexCount; tri += 3) {
    let maxCurv = 0,
      minCurv = 0;
    for (let corner = 0; corner < 3; corner++) {
      let va = tri + corner,
        vb = tri + ((corner + 1) % 3),
        dx = keptPositions[vb * 3] - keptPositions[va * 3],
        dy = keptPositions[vb * 3 + 1] - keptPositions[va * 3 + 1],
        dz = keptPositions[vb * 3 + 2] - keptPositions[va * 3 + 2],
        lenSq = dx * dx + dy * dy + dz * dz,
        curvature =
          ((bakedNormals[vb * 3] - bakedNormals[va * 3]) * dx +
            (bakedNormals[vb * 3 + 1] - bakedNormals[va * 3 + 1]) * dy +
            (bakedNormals[vb * 3 + 2] - bakedNormals[va * 3 + 2]) * dz) /
          lenSq;
      if (curvature > maxCurv) {
        maxCurv = curvature;
      }
      if (curvature < minCurv) {
        minCurv = curvature;
      }
    }
    maxCurvature[tri] = maxCurvature[tri + 1] = maxCurvature[tri + 2] = maxCurv;
    minCurvature[tri] = minCurvature[tri + 1] = minCurvature[tri + 2] = minCurv;
  }
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    colors[vertex * 3] = tint[0];
    colors[vertex * 3 + 1] = tint[1];
    colors[vertex * 3 + 2] = tint[2];
    surf[vertex * 4] = Math.min(1, kitSmoothstep(110, 520, maxCurvature[vertex]) * wear);
    surf[vertex * 4 + 1] = Math.min(
      1,
      (options.aoFn
        ? Math.max(
            ao,
            options.aoFn(
              keptPositions[vertex * 3],
              keptPositions[vertex * 3 + 1],
              keptPositions[vertex * 3 + 2]
            )
          )
        : ao) +
        0.7 * kitSmoothstep(110, 520, -minCurvature[vertex])
    );
    surf[vertex * 4 + 2] = bare;
    surf[vertex * 4 + 3] = zone;
  }
  baked.setAttribute('color', new BufferAttribute(colors, 3));
  baked.setAttribute('aSurf', new BufferAttribute(surf, 4));
  return baked;
}
const tmpPlaceEuler = new Euler(),
  tmpPlaceMatrix = new Matrix4(),
  placeGeometry = (
    geometry: BufferGeometry,
    x: number,
    y: number,
    z: number,
    rotation: Rotation3 | undefined
  ): BufferGeometry => {
    if (rotation) {
      tmpPlaceEuler.set(rotation[0], rotation[1], rotation[2]);
      geometry.applyMatrix4(tmpPlaceMatrix.makeRotationFromEuler(tmpPlaceEuler));
    }
    geometry.translate(x, y, -z);
    return geometry;
  };
/** A baked rounded box of the given size, rotated (Euler) and placed at `(x, y, -z)`. */
export function kitRoundedBox(
  width: number,
  height: number,
  depth: number,
  radius: number,
  x: number,
  y: number,
  z: number,
  tint: Tint,
  options: KitPartOptions = {},
  rotation: Rotation3 = null
): BufferGeometry {
  return placeGeometry(
    bakeSurfaceWearAttributes(roundedBox(width, height, depth, radius), tint, {
      keepN: true,
      ...options
    }),
    x,
    y,
    z,
    rotation
  );
}
/** Round every corner of a polygon; `radius` is one value or one per corner (0 = sharp). */
export function filletPolygon(
  points: Outline,
  radius: number | readonly number[],
  segments = 2
): [number, number][] {
  let count = points.length,
    out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    let corner = points[i],
      prev = points[(i + count - 1) % count],
      next = points[(i + 1) % count],
      cornerRadius = typeof radius == 'number' ? radius : radius[i] || 0,
      toPrevX = prev[0] - corner[0],
      toPrevY = prev[1] - corner[1],
      toNextX = next[0] - corner[0],
      toNextY = next[1] - corner[1],
      prevLen = Math.hypot(toPrevX, toPrevY),
      nextLen = Math.hypot(toNextX, toNextY),
      angle =
        prevLen > 1e-9 && nextLen > 1e-9
          ? Math.acos(
              Math.max(
                -1,
                Math.min(1, (toPrevX * toNextX + toPrevY * toNextY) / (prevLen * nextLen))
              )
            )
          : Math.PI;
    if (cornerRadius <= 0 || angle > 3.05) {
      for (let k = 0; k <= segments; k++) out.push([corner[0], corner[1]]);
      continue;
    }
    let tangentDist = cornerRadius / Math.tan(angle / 2),
      maxTangent = 0.45 * Math.min(prevLen, nextLen);
    if (tangentDist > maxTangent) {
      tangentDist = maxTangent;
      cornerRadius = tangentDist * Math.tan(angle / 2);
    }
    let bisectorX = toPrevX / prevLen + toNextX / nextLen,
      bisectorY = toPrevY / prevLen + toNextY / nextLen,
      bisectorLen = Math.hypot(bisectorX, bisectorY),
      centerDist = cornerRadius / Math.sin(angle / 2),
      centerX = corner[0] + (bisectorX / bisectorLen) * centerDist,
      centerY = corner[1] + (bisectorY / bisectorLen) * centerDist,
      startAngle = Math.atan2(
        corner[1] + (toPrevY / prevLen) * tangentDist - centerY,
        corner[0] + (toPrevX / prevLen) * tangentDist - centerX
      ),
      sweep =
        Math.atan2(
          corner[1] + (toNextY / nextLen) * tangentDist - centerY,
          corner[0] + (toNextX / nextLen) * tangentDist - centerX
        ) - startAngle;
    for (; sweep > Math.PI;) sweep -= 2 * Math.PI;
    for (; sweep < -Math.PI;) sweep += 2 * Math.PI;
    for (let k = 0; k <= segments; k++) {
      let arcAngle = startAngle + (sweep * k) / segments;
      out.push([
        centerX + Math.cos(arcAngle) * cornerRadius,
        centerY + Math.sin(arcAngle) * cornerRadius
      ]);
    }
  }
  return out;
}
const dropDuplicateOutlinePoints = (points: Outline): Point2[] =>
  points.filter((point, index) => {
    let prev = points[(index + points.length - 1) % points.length];
    return Math.hypot(point[0] - prev[0], point[1] - prev[1]) > 1e-7;
  });
function outlineToShape(outline: Outline, holes: readonly Outline[] | undefined): Shape {
  let shape = new Shape();
  dropDuplicateOutlinePoints(outline).forEach((point, index) =>
    index ? shape.lineTo(point[0], point[1]) : shape.moveTo(point[0], point[1])
  );
  shape.closePath();
  if (holes)
    for (let hole of holes)
      shape.holes.push(
        new Path(dropDuplicateOutlinePoints(hole).map((point) => new Vector2(point[0], point[1])))
      );
  return shape;
}
function extrudeBeveledOutline(
  outline: Outline,
  depth: number,
  bevel: number,
  holes: readonly Outline[] | undefined,
  bevelSegments: number | undefined
): ExtrudeGeometry {
  return new ExtrudeGeometry(outlineToShape(outline, holes), {
    depth: Math.max(1e-4, depth - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: bevelSegments || 1,
    steps: 1,
    curveSegments: 6
  });
}
/** Extrude a side-profile outline (bore along -Z) across the gun, from `x0` to `x1`. */
export function extrudeAcrossBore(
  outline: Outline,
  x0: number,
  x1: number,
  bevel: number,
  tint: Tint,
  options: KitPartOptions = {}
): BufferGeometry {
  let geometry = bakeSurfaceWearAttributes(
    extrudeBeveledOutline(outline, x1 - x0, bevel, options.holes, options.bs),
    tint,
    options
  );
  geometry.translate(0, 0, x0 + bevel);
  geometry.rotateY(Math.PI / 2);
  return geometry;
}
/** Extrude a cross-section outline along the bore, from `z0` to `z1` (towards the muzzle). */
export function extrudeAlongBore(
  outline: Outline,
  z0: number,
  z1: number,
  bevel: number,
  tint: Tint,
  options: KitPartOptions = {}
): BufferGeometry {
  let geometry = bakeSurfaceWearAttributes(
    extrudeBeveledOutline(outline, z1 - z0, bevel, options.holes, options.bs),
    tint,
    options
  );
  geometry.translate(0, 0, -z1 + bevel);
  return geometry;
}
/** Lathe a `[radius, z]` profile around the bore axis (optionally offset by `ox`/`oy`). */
export function latheProfile(
  profile: Outline,
  segments: number,
  tint: Tint,
  options: KitPartOptions = {}
): BufferGeometry {
  let spans: ({ nr: number; nf: number; len: number } | null)[] = [],
    positions: number[] = [],
    normals: number[] = [],
    indices: number[] = [],
    vertexBase = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    let dr = profile[i + 1][0] - profile[i][0],
      dz = profile[i + 1][1] - profile[i][1],
      len = Math.hypot(dr, dz);
    spans.push(
      len < 1e-8
        ? null
        : {
            nr: dz / len,
            nf: -dr / len,
            len: len
          }
    );
  }
  let cosCrease = Math.cos(((options.crease || 50) * Math.PI) / 180),
    offsetX = options.ox || 0,
    offsetY = options.oy || 0,
    vertexNormal = (spanIndex: number, neighbourIndex: number): [number, number] => {
      // Only called for non-null spans.
      let span = spans[spanIndex]!,
        neighbour =
          neighbourIndex >= 0 && neighbourIndex < spans.length ? spans[neighbourIndex] : null,
        nr = span.nr * span.len,
        nf = span.nf * span.len;
      if (neighbour && span.nr * neighbour.nr + span.nf * neighbour.nf >= cosCrease) {
        nr += neighbour.nr * neighbour.len;
        nf += neighbour.nf * neighbour.len;
      }
      let len = Math.hypot(nr, nf);
      return [nr / len, nf / len];
    };
  for (let i = 0; i < spans.length; i++) {
    if (!spans[i]) continue;
    let prev = i - 1,
      next = i + 1;
    for (; prev >= 0 && !spans[prev];) prev--;
    for (; next < spans.length && !spans[next];) next++;
    let normal0 = vertexNormal(i, prev),
      normal1 = vertexNormal(i, next),
      [r0, z0] = profile[i],
      [r1, z1] = profile[i + 1];
    for (let k = 0; k <= segments; k++) {
      let angle = (k / segments) * Math.PI * 2,
        cos = Math.cos(angle),
        sin = Math.sin(angle);
      positions.push(
        offsetX + r0 * cos,
        offsetY + r0 * sin,
        -z0,
        offsetX + r1 * cos,
        offsetY + r1 * sin,
        -z1
      );
      normals.push(
        normal0[0] * cos,
        normal0[0] * sin,
        -normal0[1],
        normal1[0] * cos,
        normal1[0] * sin,
        -normal1[1]
      );
    }
    for (let k = 0; k < segments; k++) {
      let v0 = vertexBase + k * 2,
        v2 = v0 + 2,
        v1 = v0 + 1,
        v3 = v0 + 3;
      indices.push(v0, v1, v2, v2, v1, v3);
    }
    vertexBase += (segments + 1) * 2;
  }
  let geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  return bakeSurfaceWearAttributes(geometry, tint, {
    keepN: true,
    ...options
  });
}
/** A chamfered cylinder lying across the gun (along X), centred at `(x, y, -z)`. */
export function latheCrossPin(
  radius: number,
  length: number,
  x: number,
  y: number,
  z: number,
  tint: Tint,
  segments = 12,
  options: KitPartOptions = {}
): BufferGeometry {
  let chamfer = Math.min(radius * 0.25, length * 0.25),
    halfLength = length / 2,
    geometry = latheProfile(
      [
        [0, -halfLength],
        [radius - chamfer, -halfLength],
        [radius, -halfLength + chamfer],
        [radius, halfLength - chamfer],
        [radius - chamfer, halfLength],
        [0, halfLength]
      ],
      segments,
      tint,
      options
    );
  geometry.rotateY(Math.PI / 2);
  geometry.translate(x, y, -z);
  return geometry;
}
/** Skin a series of equal-length 3D rings into a closed (optionally capped) solid. */
export function loftSections(
  sections: readonly (readonly Point3[])[],
  tint: Tint,
  options: KitPartOptions = {}
): BufferGeometry {
  let ringSize = sections[0].length,
    positions: number[] = [],
    sectionCount = sections.length,
    caps = options.caps || [true, true],
    centroidOf = (ring: readonly Point3[]): number[] => {
      let sumX = 0,
        sumY = 0,
        sumZ = 0;
      for (let point of ring) {
        sumX += point[0];
        sumY += point[1];
        sumZ += point[2];
      }
      return [sumX / ringSize, sumY / ringSize, sumZ / ringSize];
    },
    signedVolume = 0,
    centroids = sections.map(centroidOf);
  for (let i = 0; i < sectionCount - 1; i++)
    for (let j = 0; j < ringSize; j++) {
      let p0 = sections[i][j],
        p1 = sections[i][(j + 1) % ringSize],
        p2 = sections[i + 1][j],
        ax = p1[0] - p0[0],
        ay = p1[1] - p0[1],
        az = p1[2] - p0[2],
        bx = p2[0] - p0[0],
        by = p2[1] - p0[1],
        bz = p2[2] - p0[2];
      signedVolume +=
        (ay * bz - az * by) * (p0[0] - centroids[i][0]) +
        (az * bx - ax * bz) * (p0[1] - centroids[i][1]) +
        (ax * by - ay * bx) * (p0[2] - centroids[i][2]);
    }
  for (let i = 0; i < sectionCount - 1; i++)
    for (let j = 0; j < ringSize; j++) {
      let p00 = sections[i][j],
        p01 = sections[i][(j + 1) % ringSize],
        p11 = sections[i + 1][(j + 1) % ringSize],
        p10 = sections[i + 1][j];
      if (signedVolume >= 0) {
        positions.push(...p00, ...p01, ...p11, ...p00, ...p11, ...p10);
      } else {
        positions.push(...p00, ...p11, ...p01, ...p00, ...p10, ...p11);
      }
    }
  for (let end of [0, 1]) {
    if (!caps[end]) continue;
    let ring = sections[end ? sectionCount - 1 : 0],
      center = centroids[end ? sectionCount - 1 : 0],
      inner = centroids[end ? sectionCount - 2 : 1],
      axis = [center[0] - inner[0], center[1] - inner[1], center[2] - inner[2]],
      absX = Math.abs(axis[0]),
      absY = Math.abs(axis[1]),
      absZ = Math.abs(axis[2]),
      uAxis = absX > absY && absX > absZ ? 1 : 0,
      vAxis = (absY > absX && absY > absZ) || uAxis === 1 ? 2 : 1,
      kept: number[] = [],
      flat: Vector2[] = [];
    ring.forEach((point, index) => {
      let prev = ring[(index + ringSize - 1) % ringSize];
      if (Math.hypot(point[0] - prev[0], point[1] - prev[1], point[2] - prev[2]) > 1e-7) {
        kept.push(index);
        flat.push(new Vector2(point[uAxis], point[vAxis]));
      }
    });
    for (let tri of ShapeUtils.triangulateShape(flat, [])) {
      let triA = ring[kept[tri[0]]],
        triB = ring[kept[tri[1]]],
        triC = ring[kept[tri[2]]],
        abx = triB[0] - triA[0],
        aby = triB[1] - triA[1],
        abz = triB[2] - triA[2],
        acx = triC[0] - triA[0],
        acy = triC[1] - triA[1],
        acz = triC[2] - triA[2];
      if (
        (aby * acz - abz * acy) * axis[0] +
          (abz * acx - abx * acz) * axis[1] +
          (abx * acy - aby * acx) * axis[2] >=
        0
      ) {
        positions.push(...triA, ...triB, ...triC);
      } else {
        positions.push(...triA, ...triC, ...triB);
      }
    }
  }
  let geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return bakeSurfaceWearAttributes(geometry, tint, options);
}
/** A symmetric rectangle outline with separate corner radii at the bottom and top. */
export function dualRadiusRectOutline(
  halfWidth: number,
  bottom: number,
  top: number,
  topRadius: number,
  bottomRadius: number,
  segments = 3
): [number, number][] {
  let points: [number, number][] = [],
    addArc = (cx: number, cy: number, arcRadius: number, startAngle: number): void => {
      for (let k = 0; k <= segments; k++) {
        let angle = startAngle + ((k / segments) * Math.PI) / 2;
        points.push([cx + Math.cos(angle) * arcRadius, cy + Math.sin(angle) * arcRadius]);
      }
    };
  addArc(-halfWidth + bottomRadius, bottom + bottomRadius, bottomRadius, Math.PI);
  addArc(halfWidth - bottomRadius, bottom + bottomRadius, bottomRadius, Math.PI * 1.5);
  addArc(halfWidth - topRadius, top - topRadius, topRadius, 0);
  addArc(-halfWidth + topRadius, top - topRadius, topRadius, Math.PI / 2);
  return points;
}
/** Lift a 2D outline into a 3D ring at depth `z` (for `loftSections`). */
export const outlineToRing = (outline: Outline, z: number, options: RingOptions = {}): number[][] =>
  outline.map((point) => [
    point[0] * (options.sx || 1) + (options.dx || 0),
    (point[1] - (options.cy || 0)) * (options.sy || 1) + (options.cy || 0) + (options.dy || 0),
    -z + (options.rake || 0) * point[1]
  ]);
/** A stadium (rounded slot) outline centred at `(cx, cy)`, long along X. */
function slotOutline(
  cx: number,
  cy: number,
  length: number,
  width: number,
  segments = 4
): [number, number][] {
  let points: [number, number][] = [],
    radius = width / 2,
    halfStraight = length / 2 - radius;
  for (let k = 0; k <= segments; k++) {
    let angle = -Math.PI / 2 + (k / segments) * Math.PI;
    points.push([cx + halfStraight + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  for (let k = 0; k <= segments; k++) {
    let angle = Math.PI / 2 + (k / segments) * Math.PI;
    points.push([cx - halfStraight + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  return points;
}
/** An axis-aligned rectangle outline with filleted corners. */
export const filletedRectOutline = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    radius: number,
    segments = 2
  ): [number, number][] =>
    filletPolygon(
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1]
      ],
      radius,
      segments
    ),
  circleOutline = (cx: number, cy: number, radius: number, segments = 10): [number, number][] => {
    let points: [number, number][] = [];
    for (let k = 0; k < segments; k++) {
      let angle = (k / segments) * Math.PI * 2;
      points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
    }
    return points;
  };
/** Merge kit parts (skipping empty slots), keeping only position/normal/color/aSurf. */
export function mergeKitGeometries(
  geometries: readonly (BufferGeometry | null | undefined | false)[]
): BufferGeometry {
  let present = geometries.filter((geometry): geometry is BufferGeometry => Boolean(geometry));
  if (!present.length) return new BufferGeometry();
  for (let geometry of present)
    for (let name of Object.keys(geometry.attributes))
      if (!['position', 'normal', 'color', 'aSurf'].includes(name)) {
        geometry.deleteAttribute(name);
      }
  // mergeGeometries returns null on attribute mismatch; kit parts always share the same set.
  return mergeGeometries(present, false)!;
}
/**
 * Bake ambient occlusion into `aSurf.y` by voxelising all parts together and probing a few short
 * rays per vertex; optionally raise `aSurf.w` (grip zone) with `zoneFn`.
 */
export function bakeVoxelOcclusion(
  parts: readonly OcclusionPart[],
  zoneFn: OcclusionZoneFn | null = null,
  voxelSize = 0.002
): void {
  let boundsMin = [1e9, 1e9, 1e9],
    boundsMax = [-1e9, -1e9, -1e9],
    transformed: { w: Float32Array; wn: Float32Array }[] = [];
  for (let part of parts) {
    let positions = part.g.attributes.position.array,
      normals = part.g.attributes.normal.array,
      worldPos = new Float32Array(positions.length),
      worldNrm = new Float32Array(positions.length),
      cosX = Math.cos(part.rx || 0),
      sinX = Math.sin(part.rx || 0),
      offset = part.off || [0, 0, 0];
    for (let k = 0; k < positions.length; k += 3) {
      worldPos[k] = positions[k] + offset[0];
      worldPos[k + 1] = positions[k + 1] * cosX - positions[k + 2] * sinX + offset[1];
      worldPos[k + 2] = positions[k + 1] * sinX + positions[k + 2] * cosX + offset[2];
      worldNrm[k] = normals[k];
      worldNrm[k + 1] = normals[k + 1] * cosX - normals[k + 2] * sinX;
      worldNrm[k + 2] = normals[k + 1] * sinX + normals[k + 2] * cosX;
      for (let axis = 0; axis < 3; axis++) {
        if (worldPos[k + axis] < boundsMin[axis]) {
          boundsMin[axis] = worldPos[k + axis];
        }
        if (worldPos[k + axis] > boundsMax[axis]) {
          boundsMax[axis] = worldPos[k + axis];
        }
      }
    }
    transformed.push({
      w: worldPos,
      wn: worldNrm
    });
  }
  let pad = 8,
    sizeX = Math.ceil((boundsMax[0] - boundsMin[0]) / voxelSize) + 2 * pad,
    sizeY = Math.ceil((boundsMax[1] - boundsMin[1]) / voxelSize) + 2 * pad,
    sizeZ = Math.ceil((boundsMax[2] - boundsMin[2]) / voxelSize) + 2 * pad,
    grid = new Uint8Array(sizeX * sizeY * sizeZ),
    originX = boundsMin[0] - pad * voxelSize,
    originY = boundsMin[1] - pad * voxelSize,
    originZ = boundsMin[2] - pad * voxelSize,
    invVoxel = 1 / voxelSize,
    step = voxelSize * 0.9;
  for (let { w: pos } of transformed)
    for (let k = 0; k < pos.length; k += 9) {
      let ax = pos[k],
        ay = pos[k + 1],
        az = pos[k + 2],
        e1x = pos[k + 3] - ax,
        e1y = pos[k + 4] - ay,
        e1z = pos[k + 5] - az,
        e2x = pos[k + 6] - ax,
        e2y = pos[k + 7] - ay,
        e2z = pos[k + 8] - az,
        stepsU = Math.max(1, Math.ceil(Math.hypot(e1x, e1y, e1z) / step)),
        stepsV = Math.max(1, Math.ceil(Math.hypot(e2x, e2y, e2z) / step));
      for (let iu = 0; iu <= stepsU; iu++) {
        let u = iu / stepsU,
          rowSteps = Math.max(1, Math.ceil(stepsV * (1 - u)));
        for (let iv = 0; iv <= rowSteps; iv++) {
          let v = (iv / rowSteps) * (1 - u);
          grid[
            ((((az + e1z * u + e2z * v - originZ) * invVoxel) | 0) * sizeY +
              (((ay + e1y * u + e2y * v - originY) * invVoxel) | 0)) *
              sizeX +
              (((ax + e1x * u + e2x * v - originX) * invVoxel) | 0)
          ] = 1;
        }
      }
    }
  let occupied = (px: number, py: number, pz: number): number | undefined =>
      grid[
        ((((pz - originZ) * invVoxel) | 0) * sizeY + (((py - originY) * invVoxel) | 0)) * sizeX +
          (((px - originX) * invVoxel) | 0)
      ],
    probeDist = [0.0032, 0.007],
    probeWeight = [1, 0.6],
    ringCos = [1, -0.5, -0.5],
    ringSin = [0, 0.866, -0.866];
  parts.forEach((part, partIndex) => {
    let { w: pos, wn: nrm } = transformed[partIndex],
      surf = part.g.attributes.aSurf.array;
    for (let k = 0; k < pos.length; k += 9) {
      let maxEdge = Math.max(
          Math.hypot(pos[k + 3] - pos[k], pos[k + 4] - pos[k + 1], pos[k + 5] - pos[k + 2]),
          Math.hypot(pos[k + 6] - pos[k + 3], pos[k + 7] - pos[k + 4], pos[k + 8] - pos[k + 5]),
          Math.hypot(pos[k] - pos[k + 6], pos[k + 1] - pos[k + 7], pos[k + 2] - pos[k + 8])
        ),
        smallFade = 1 - kitSmoothstep(0.012, 0.045, maxEdge);
      for (let corner = 0; corner < 3; corner++) {
        let idx = k + corner * 3,
          vertex = idx / 3,
          px = pos[idx],
          py = pos[idx + 1],
          pz = pos[idx + 2],
          nx = nrm[idx],
          ny = nrm[idx + 1],
          nz = nrm[idx + 2];
        if (zoneFn) {
          let zone = zoneFn(px, py, pz, part.key);
          if (zone > surf[vertex * 4 + 3]) {
            surf[vertex * 4 + 3] = zone;
          }
        }
        if (smallFade <= 0) continue;
        let tx, ty, tz;
        if (Math.abs(nx) < 0.8) {
          tx = 0;
          ty = -nz;
          tz = ny;
        } else {
          tx = nz;
          ty = 0;
          tz = -nx;
        }
        let tLen = Math.hypot(tx, ty, tz) || 1;
        tx /= tLen;
        ty /= tLen;
        tz /= tLen;
        let bx = ny * tz - nz * ty,
          by = nz * tx - nx * tz,
          bz = nx * ty - ny * tx,
          hits = 0,
          total = 0,
          ox = px + nx * voxelSize * 1.3,
          oy = py + ny * voxelSize * 1.3,
          oz = pz + nz * voxelSize * 1.3;
        for (let ray = 0; ray < 4; ray++) {
          let dx = nx,
            dy = ny,
            dz = nz;
          if (ray) {
            let spreadT = ringCos[ray - 1] * 0.78,
              spreadB = ringSin[ray - 1] * 0.78;
            dx = nx * 0.62 + tx * spreadT + bx * spreadB;
            dy = ny * 0.62 + ty * spreadT + by * spreadB;
            dz = nz * 0.62 + tz * spreadT + bz * spreadB;
          }
          total += 1.6;
          if (occupied(ox + dx * probeDist[0], oy + dy * probeDist[0], oz + dz * probeDist[0])) {
            hits += 1.6;
          } else if (
            occupied(ox + dx * probeDist[1], oy + dy * probeDist[1], oz + dz * probeDist[1])
          ) {
            hits += 0.6;
          }
        }
        let occlusion = Math.min(1, (hits / total) * 1.4) * smallFade;
        if (occlusion > surf[vertex * 4 + 1]) {
          surf[vertex * 4 + 1] = Math.min(1, occlusion + surf[vertex * 4 + 1] * 0.4);
        }
      }
    }
  });
}
/**
 * 1 inside the box (Z given as positive depth, i.e. the box spans `-maxZ..-minZ` in Z), fading to 0
 * over `fade` metres outside it.
 */
export const boxZoneFalloff = (
    x: number,
    y: number,
    z: number,
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number,
    fade = 0.012
  ): number => {
    let dx = Math.max(minX - x, 0, x - maxX),
      dy = Math.max(minY - y, 0, y - maxY),
      dz = Math.max(minZ + z, 0, -z - maxZ);
    return 1 - kitSmoothstep(0, fade, Math.hypot(dx, dy, dz));
  },
  /** Rifle dimensions and attachment points shared with the rifle viewmodel. */
  RIFLE_SPEC = {
    name: 'PAC-9 Longshore',
    muzzle: [0, 0, -0.531],
    eject: [0.023, 0.004, -0.028],
    sightY: 0.069,
    lensF: 0.0285,
    window: [
      [-0.016, 0.057],
      [0.016, 0.057],
      [0.016, 0.0772],
      [0.0122, 0.081],
      [-0.0122, 0.081],
      [-0.016, 0.0772]
    ],
    magPos: [0, -0.02, -0.0665],
    boltTravel: 0.062,
    railTop: 0.0435,
    grip: [0, -0.1, 0.073],
    handguard: [0, 0, -0.255],
    handguardR: 0.021,
    handlePos: [-0.026, 0.007, -0.078],
    squeeze: 0.86
  };

/** One part fed to `bakeVoxelOcclusion`. */
export interface OcclusionPart {
  key: string;
  g: BufferGeometry;
  /** Offset applied (after `rx`) when voxelising. */
  off?: readonly number[] | null;
  /** Rotation about X applied when voxelising. */
  rx?: number;
}

/** Grip-zone function for `bakeVoxelOcclusion`: returns a zone amount at a point of a part. */
export type OcclusionZoneFn = (x: number, y: number, z: number, key: string) => number;

/** The rifle's merged geometries, one per material group. */
export interface RifleGeometries {
  ano: BufferGeometry;
  gun: BufferGeometry;
  poly: BufferGeometry;
  plain: BufferGeometry;
  bolt: BufferGeometry;
  mag: BufferGeometry;
  round: BufferGeometry;
}
/** Build every part of the PAC-9 rifle and merge them into one geometry per material group. */
export function buildRifleGeometries(): RifleGeometries {
  let receiverTint = [1, 1, 1],
    lowerTint = [1.16, 1.05, 0.98],
    handguardTint = [0.86, 0.93, 1.04],
    sightTint = [0.8, 0.8, 0.84],
    lightTint = [0.94, 0.92, 0.88],
    bufferTubeTint = [1.25, 1.2, 1.15],
    steelTint = [1, 1, 1],
    pinTint = [2.6, 2.6, 2.7],
    gasTubeTint = [11, 11, 11.4],
    darkTint = [0.3, 0.3, 0.31],
    polymerTint = [1, 1, 1],
    rubberTint = [0.03, 0.03, 0.031],
    lensFrameTint = [0.016, 0.016, 0.017],
    baseWear = {
      wear: 0.8
    },
    controlWear = {
      wear: 1,
      zone: 0.5
    },
    innerWear = {
      wear: 0.5,
      ao: 0.28
    },
    skinWear = {
      wear: 0.55
    },
    steelWear = {
      wear: 0.9
    },
    pinWear = {
      bare: 0.45,
      wear: 1.2
    },
    polymerWear = {
      wear: 0.8
    },
    recessWear = {
      wear: 0,
      ao: 0.75
    },
    noWear = {
      wear: 0
    },
    // Parts, grouped by the material they will be drawn with.
    ano: BufferGeometry[] = [],
    gun: BufferGeometry[] = [],
    poly: BufferGeometry[] = [],
    bolt: BufferGeometry[] = [],
    mag: BufferGeometry[] = [],
    round: BufferGeometry[] = [],
    plain: BufferGeometry[] = [],
    upperHalfWidth = 0.0176,
    lowerHalfWidth = 0.0163,
    skin = 0.0012,
    roundedRect = (rx0: number, ry0: number, rx1: number, ry1: number, rr = 0.0022) =>
      filletedRectOutline(rx0, ry0, rx1, ry1, rr, 2),
    boreCylinder = (
      radius: number,
      z0: number,
      z1: number,
      ox: number,
      oy: number,
      tint: Tint,
      segments: number,
      options: KitPartOptions
    ): BufferGeometry => {
      let chamfer = Math.min(radius * 0.25, (z1 - z0) * 0.25);
      return latheProfile(
        [
          [0, z0],
          [radius - chamfer, z0],
          [radius, z0 + chamfer],
          [radius, z1 - chamfer],
          [radius - chamfer, z1],
          [0, z1]
        ],
        segments,
        tint,
        {
          ...options,
          ox: ox,
          oy: oy
        }
      );
    },
    verticalCylinder = (
      radius: number,
      length: number,
      x: number,
      y: number,
      z: number,
      tint: Tint,
      segments: number,
      options: KitPartOptions
    ): BufferGeometry => {
      let geometry = boreCylinder(radius, -length / 2, length / 2, 0, 0, tint, segments, options);
      geometry.rotateX(Math.PI / 2);
      geometry.translate(x, y, -z);
      return geometry;
    },
    upperOutline = filletPolygon(
      [
        [-0.1, -0.02],
        [0.1, -0.02],
        [0.1, 0.0245],
        [-0.1, 0.0245]
      ],
      8e-4,
      1
    ),
    leftSlot = slotOutline(0.032, 0.007, 0.112, 0.0075, 4),
    ejectionPort = filletedRectOutline(-0.012, -0.01, 0.06, 0.012, 0.003, 2);
  ano.push(
    extrudeAcrossBore(upperOutline, 0, upperHalfWidth - skin + 1e-4, 5e-4, receiverTint, {
      ...innerWear,
      holes: [ejectionPort]
    })
  );
  ano.push(
    extrudeAcrossBore(upperOutline, -(upperHalfWidth - skin + 1e-4), 0, 5e-4, receiverTint, {
      ...innerWear,
      holes: [leftSlot]
    })
  );
  ano.push(
    extrudeAcrossBore(
      upperOutline,
      -upperHalfWidth,
      -(upperHalfWidth - skin),
      45e-5,
      receiverTint,
      {
        ...skinWear,
        holes: [
          leftSlot,
          roundedRect(-0.094, -0.015, -0.033, 0.017),
          roundedRect(-0.0225, -0.0155, 0.093, -8e-4)
        ]
      }
    )
  );
  ano.push(
    extrudeAcrossBore(upperOutline, upperHalfWidth - skin, upperHalfWidth, 45e-5, receiverTint, {
      ...skinWear,
      holes: [
        ejectionPort,
        roundedRect(0.0675, -0.015, 0.094, 0.017),
        roundedRect(-0.094, -0.0155, -0.04, -0.004)
      ]
    })
  );
  {
    let halfWidth = upperHalfWidth + 4e-4,
      topSection = (top: number, topHalfWidth: number, shoulderY: number) =>
        filletPolygon(
          [
            [-halfWidth, 0.0226],
            [halfWidth, 0.0226],
            [halfWidth, shoulderY],
            [topHalfWidth, top],
            [-topHalfWidth, top],
            [-halfWidth, shoulderY]
          ],
          7e-4,
          1
        );
    ano.push(
      loftSections(
        [
          outlineToRing(topSection(0.0252, 0.015, 0.024), -0.1004),
          outlineToRing(topSection(0.0335, 0.011, 0.0262), -0.0885),
          outlineToRing(topSection(0.0335, 0.011, 0.0262), 0.0935),
          outlineToRing(topSection(0.0276, 0.0142, 0.025), 0.1004)
        ],
        receiverTint,
        baseWear
      )
    );
  }
  gun.push(kitRoundedBox(0.0034, 0.036, 0.19, 4e-4, -0.0116, 0.006, 0, darkTint, recessWear));
  gun.push(kitRoundedBox(0.0034, 0.012, 0.19, 4e-4, 0.0125, 0.022, 0, darkTint, recessWear));
  gun.push(kitRoundedBox(0.0034, 0.008, 0.19, 4e-4, 0.0125, -0.014, 0, darkTint, recessWear));
  gun.push(kitRoundedBox(0.02, 0.001, 0.196, 2e-4, 0, -0.0203, 0, darkTint, recessWear));
  gun.push(
    latheProfile(
      [
        [0, 0.058],
        [0.0118, 0.058],
        [0.0118, 0.099],
        [0, 0.099]
      ],
      16,
      [0.8, 0.8, 0.82],
      noWear
    )
  );
  ano.push(
    extrudeAcrossBore(
      filletPolygon(
        [
          [-0.04, -0.008],
          [-0.0165, -0.011],
          [-0.0145, 0.013],
          [-0.034, 0.016]
        ],
        0.002,
        2
      ),
      upperHalfWidth - 0.001,
      upperHalfWidth + 0.0052,
      0.0022,
      receiverTint,
      {
        ...controlWear,
        bs: 2
      }
    )
  );
  ano.push(
    latheProfile(
      [
        [0, -0.086],
        [0.0058, -0.086],
        [0.0066, -0.0845],
        [0.0066, -0.06],
        [0.004, -0.0565],
        [0, -0.0565]
      ],
      14,
      receiverTint,
      {
        ...baseWear,
        ox: 0.0182,
        oy: 0.012
      }
    )
  );
  gun.push(
    latheProfile(
      [
        [0, -0.0945],
        [0.004, -0.0945],
        [0.0048, -0.0935],
        [0.0048, -0.0905],
        [0.0042, -0.09],
        [0.0042, -0.0885],
        [0.0048, -0.088],
        [0.0048, -0.086],
        [0, -0.086]
      ],
      12,
      steelTint,
      {
        ...steelWear,
        ox: 0.0182,
        oy: 0.012
      }
    )
  );
  gun.push(
    kitRoundedBox(
      0.0016,
      0.02,
      0.07,
      5e-4,
      upperHalfWidth + 0.0042,
      -0.0212,
      0.024,
      steelTint,
      steelWear,
      [0, 0, 0.3]
    )
  );
  gun.push(
    kitRoundedBox(
      0.0012,
      0.013,
      0.056,
      4e-4,
      upperHalfWidth + 0.0056,
      -0.0208,
      0.024,
      steelTint,
      steelWear,
      [0, 0, 0.3]
    )
  );
  gun.push(
    boreCylinder(0.0015, -0.014, 0.062, upperHalfWidth + 0.0012, -0.0116, pinTint, 8, pinWear)
  );
  for (let z of [-0.0115, 0.0245, 0.0595])
    gun.push(
      boreCylinder(
        0.0023,
        z - 0.0035,
        z + 0.0035,
        upperHalfWidth + 0.0012,
        -0.0116,
        steelTint,
        8,
        steelWear
      )
    );
  gun.push(
    latheCrossPin(0.0016, 0.0016, upperHalfWidth + 0.0068, -0.0285, 0.024, pinTint, 8, pinWear)
  );
  for (let z of [-0.06, -0.072])
    gun.push(
      latheCrossPin(0.0019, 8e-4, -upperHalfWidth + skin - 2e-4, 0.011, z, darkTint, 8, recessWear)
    );
  {
    let ring = latheProfile(
      [
        [0.0042, -0.0016],
        [0.0064, -0.0016],
        [0.0068, -0.0012],
        [0.0068, 6e-4],
        [0.0062, 0.0012],
        [0.0046, 0.0012],
        [0.0042, 4e-4]
      ],
      14,
      steelTint,
      steelWear
    );
    ring.rotateY(-Math.PI / 2);
    ring.translate(-(upperHalfWidth - skin) - 4e-4, 0.0035, 0.064);
    gun.push(ring);
    gun.push(
      latheCrossPin(
        0.0044,
        6e-4,
        -(upperHalfWidth - skin) + 2e-4,
        0.0035,
        -0.064,
        darkTint,
        10,
        recessWear
      )
    );
  }
  let railBaseOutline = [
    [-0.0078, 0.0333],
    [0.0078, 0.0333],
    [0.0106, 0.0402],
    [-0.0106, 0.0402]
  ];
  ano.push(
    extrudeAlongBore(railBaseOutline, -0.096, 0.1003, 4e-4, receiverTint, {
      wear: 1,
      ao: 0.42
    })
  );
  ano.push(
    extrudeAlongBore(railBaseOutline, 0.1008, 0.397, 4e-4, handguardTint, {
      wear: 1,
      ao: 0.42
    })
  );
  let railToothOutline = filletPolygon(
    [
      [-0.0102, 0.0398],
      [0.0102, 0.0398],
      [0.0106, 0.0408],
      [0.008, 0.0435],
      [-0.008, 0.0435],
      [-0.0106, 0.0408]
    ],
    [0, 0, 3e-4, 5e-4, 5e-4, 3e-4],
    1
  );
  {
    let toothFront = extrudeAlongBore(railToothOutline, 0, 0.00478, 6e-4, receiverTint, {
        wear: 1,
        zone: 0.45
      }),
      toothRear = extrudeAlongBore(railToothOutline, 0, 0.00478, 6e-4, handguardTint, {
        wear: 1,
        zone: 0.45
      });
    for (let i = 0; i < 49; i++) {
      let z = -0.0945 + i * 0.01001;
      ano.push((z < 0.1 ? toothFront : toothRear).clone().translate(0, 0, -z));
    }
  }
  let lowerOutline = filletPolygon(
    [
      [-0.1, -0.0203],
      [0.099, -0.0203],
      [0.101, -0.03],
      [0.098, -0.088],
      [0.036, -0.082],
      [0.031, -0.058],
      [-0.03, -0.058],
      [-0.04, -0.066],
      [-0.078, -0.055],
      [-0.1, -0.044]
    ],
    [8e-4, 8e-4, 0.004, 0.003, 0.003, 0.004, 0.004, 0.004, 0.006, 0.003],
    2
  );
  ano.push(
    extrudeAcrossBore(
      lowerOutline,
      -(lowerHalfWidth - skin + 1e-4),
      lowerHalfWidth - skin + 1e-4,
      5e-4,
      lowerTint,
      innerWear
    )
  );
  for (let side of [-1, 1]) {
    let holes = [
        roundedRect(0.0405, -0.077, 0.0945, -0.0265, 0.003),
        circleOutline(-0.048, -0.036, 0.0074, 14)
      ],
      panel = extrudeAcrossBore(
        lowerOutline,
        lowerHalfWidth - skin,
        lowerHalfWidth,
        45e-5,
        lowerTint,
        {
          ...skinWear,
          holes: holes
        }
      );
    if (side < 0) {
      panel.scale(-1, 1, 1);
      flipTriangleWinding(panel);
    }
    ano.push(panel);
  }
  ano.push(
    kitRoundedBox(
      0.0372,
      0.0095,
      0.0665,
      0.0022,
      0,
      -0.0838,
      0.0668,
      lowerTint,
      {
        wear: 0.82,
        zone: 1
      },
      [-0.095, 0, 0]
    )
  );
  ano.push(kitRoundedBox(0.0348, 0.05, 0.0044, 0.001, 0, -0.053, 0.099, lowerTint, baseWear));
  for (let i = 0; i < 7; i++)
    ano.push(
      kitRoundedBox(
        0.024,
        0.003,
        0.0016,
        6e-4,
        0,
        -0.0345 - i * 0.006,
        0.1012 - i * 3e-4,
        lowerTint,
        {
          wear: 1.4
        }
      )
    );
  ano.push(kitRoundedBox(0.0348, 0.038, 0.0044, 0.001, 0, -0.048, 0.0345, lowerTint, baseWear));
  for (let [z, y] of [
    [0.087, -0.029],
    [-0.086, -0.031]
  ]) {
    gun.push(latheCrossPin(0.0036, 0.0336, 0, y, z, pinTint, 12, pinWear));
    gun.push(latheCrossPin(0.005, 0.0016, lowerHalfWidth + 0.0012, y, z, steelTint, 14, steelWear));
    gun.push(latheCrossPin(0.0011, 0.001, -lowerHalfWidth - 8e-4, y, z, darkTint, 8, recessWear));
  }
  gun.push(latheCrossPin(0.0021, 0.0334, 0, -0.04, 0.012, pinTint, 10, pinWear));
  gun.push(latheCrossPin(0.0021, 0.0334, 0, -0.032, 0.032, pinTint, 10, pinWear));
  for (let side of [-1, 1]) {
    gun.push(
      latheCrossPin(
        0.0062,
        0.003,
        side * (lowerHalfWidth + 2e-4),
        -0.036,
        -0.048,
        steelTint,
        16,
        steelWear
      )
    );
    gun.push(
      kitRoundedBox(
        0.0036,
        0.0058,
        0.022,
        0.0014,
        side * (lowerHalfWidth + 0.0026),
        -0.036,
        -0.037,
        steelTint,
        {
          wear: 1.2
        },
        [0.5, 0, 0]
      )
    );
    gun.push(
      latheCrossPin(
        0.0016,
        0.001,
        side * (lowerHalfWidth + 0.002),
        -0.036,
        -0.048,
        pinTint,
        8,
        pinWear
      )
    );
  }
  gun.push(
    extrudeAcrossBore(
      filletPolygon(
        [
          [0.0155, -0.019],
          [0.0285, -0.019],
          [0.029, -0.033],
          [0.025, -0.0415],
          [0.019, -0.0415],
          [0.015, -0.033]
        ],
        0.0015,
        1
      ),
      -lowerHalfWidth - 0.0032,
      -lowerHalfWidth + 2e-4,
      9e-4,
      steelTint,
      steelWear
    )
  );
  for (let i = 0; i < 4; i++)
    gun.push(
      kitRoundedBox(
        0.0012,
        0.0016,
        0.0105,
        5e-4,
        -lowerHalfWidth - 0.0036,
        -0.0215 - i * 0.0036,
        0.022,
        steelTint,
        {
          wear: 1.3
        }
      )
    );
  gun.push(latheCrossPin(0.0015, 0.034, 0, -0.0375, 0.022, pinTint, 8, pinWear));
  gun.push(
    latheCrossPin(0.0054, 0.0044, lowerHalfWidth + 0.0014, -0.042, 0.016, steelTint, 14, {
      wear: 1.2
    })
  );
  for (let i = 0; i < 3; i++)
    gun.push(
      kitRoundedBox(
        6e-4,
        0.0076 - Math.abs(i - 1) * 0.0018,
        0.001,
        2e-4,
        lowerHalfWidth + 0.0037,
        -0.042,
        0.0138 + i * 0.0022,
        steelTint,
        noWear
      )
    );
  ano.push(
    extrudeAcrossBore(
      filletPolygon(
        [
          [0.004, -0.0325],
          [0.029, -0.0335],
          [0.029, -0.053],
          [0.004, -0.053],
          [0.004, -0.05],
          [0.0245, -0.05],
          [0.0245, -0.0365],
          [0.004, -0.036]
        ],
        8e-4,
        1
      ),
      lowerHalfWidth - 4e-4,
      lowerHalfWidth + 0.003,
      0.001,
      lowerTint,
      baseWear
    )
  );
  ano.push(
    extrudeAcrossBore(
      filletPolygon(
        [
          [0.033, -0.056],
          [0.033, -0.093],
          [0.024, -0.1005],
          [-0.031, -0.1005],
          [-0.041, -0.09],
          [-0.041, -0.06]
        ],
        0.003,
        2
      ),
      -0.007,
      0.007,
      0.0014,
      lowerTint,
      {
        ...baseWear,
        bs: 2,
        holes: [
          filletPolygon(
            [
              [0.029, -0.059],
              [0.029, -0.0915],
              [0.0225, -0.0968],
              [-0.0295, -0.0968],
              [-0.0372, -0.0885],
              [-0.0372, -0.061]
            ],
            0.004,
            3
          )
        ]
      }
    )
  );
  gun.push(
    extrudeAcrossBore(
      filletPolygon(
        [
          [-0.006, -0.057],
          [0.004, -0.057],
          [0.003, -0.069],
          [0.0065, -0.079],
          [0.01, -0.086],
          [0.0065, -0.088],
          [0.001, -0.081],
          [-0.004, -0.07]
        ],
        [0, 0, 0.004, 0.006, 8e-4, 8e-4, 0.006, 0.004],
        2
      ),
      -0.0031,
      0.0031,
      0.0011,
      steelTint,
      {
        wear: 0.6,
        bs: 2
      }
    )
  );
  let gripOutline = filletPolygon(
    [
      [-0.038, -0.05],
      [-0.045, -0.074],
      [-0.049, -0.086],
      [-0.049, -0.1],
      [-0.054, -0.112],
      [-0.057, -0.13],
      [-0.064, -0.158],
      [-0.11, -0.152],
      [-0.102, -0.112],
      [-0.096, -0.082],
      [-0.095, -0.064],
      [-0.103, -0.046],
      [-0.08, -0.044]
    ],
    [0.002, 0.006, 0.004, 0.004, 0.006, 0.008, 0.003, 0.004, 0.02, 0.02, 0.006, 0.003, 0.004],
    2
  );
  poly.push(
    extrudeAcrossBore(gripOutline, -0.0142, 0.0142, 0.005, polymerTint, {
      ...polymerWear,
      bs: 3
    })
  );
  {
    let gripPanel = filletPolygon(
      [
        [-0.0565, -0.085],
        [-0.061, -0.109],
        [-0.068, -0.149],
        [-0.101, -0.145],
        [-0.095, -0.112],
        [-0.09, -0.085]
      ],
      0.004,
      2
    );
    for (let side of [-1, 1])
      poly.push(
        extrudeAcrossBore(
          gripPanel,
          side > 0 ? 0.0138 : -0.0146,
          side > 0 ? 0.0146 : -0.0138,
          4e-4,
          polymerTint,
          {
            wear: 0.8,
            zone: 1
          }
        )
      );
  }
  for (let i = 0; i < 7; i++) {
    let y = -0.084 - i * 0.0098,
      z = -0.0527 + (y + 0.084) * 0.21;
    poly.push(
      kitRoundedBox(0.015, 0.0034, 0.003, 0.0012, 0, y, z, polymerTint, polymerWear, [-0.21, 0, 0])
    );
  }
  for (let i = 0; i < 7; i++) {
    let y = -0.078 - i * 0.01,
      z = -0.0962 + (y + 0.078) * 0.16;
    poly.push(
      kitRoundedBox(0.016, 0.004, 0.0034, 0.0014, 0, y, z, polymerTint, polymerWear, [-0.16, 0, 0])
    );
  }
  poly.push(
    kitRoundedBox(
      0.03,
      0.0056,
      0.049,
      0.002,
      0,
      -0.1568,
      -0.087,
      polymerTint,
      polymerWear,
      [0.13, 0, 0]
    )
  );
  gun.push(latheCrossPin(0.0028, 0.0296, 0, -0.15, -0.085, pinTint, 8, pinWear));
  let handguardRadius = RIFLE_SPEC.handguardR,
    flatHalfWidth = 0.00885,
    wallThickness = 0.0028,
    handguardStart = 0.101,
    handguardEnd = 0.398,
    handguardPanel = filletPolygon(
      [
        [handguardStart, -flatHalfWidth],
        [handguardEnd, -flatHalfWidth],
        [handguardEnd, flatHalfWidth],
        [handguardStart, flatHalfWidth]
      ],
      0.001,
      1
    );
  for (let face = 0; face < 8; face++) {
    let holes = [];
    if (face === 0 || face === 4 || face === 6)
      for (let k = 0; k < 7; k++) holes.push(slotOutline(0.13 + k * 0.04, 0, 0.032, 0.007, 4));
    else if (face !== 2)
      for (let k = 0; k < 10; k++) {
        let z = 0.124 + k * 0.027;
        if (!(face === 3 && z > 0.3)) {
          holes.push(slotOutline(z, 0, 0.013, 0.0052, 3));
        }
      }
    let panel = extrudeAcrossBore(
      handguardPanel,
      handguardRadius - wallThickness,
      handguardRadius,
      8e-4,
      handguardTint,
      {
        ...baseWear,
        holes: holes
      }
    );
    panel.rotateZ((face * Math.PI) / 4);
    ano.push(panel);
    let angle = ((face + 0.5) * Math.PI) / 4;
    ano.push(
      boreCylinder(
        0.003,
        handguardStart,
        handguardEnd,
        Math.cos(angle) * 0.0197,
        Math.sin(angle) * 0.0197,
        handguardTint,
        8,
        {
          wear: 1.2
        }
      )
    );
  }
  ano.push(
    extrudeAlongBore(
      filletPolygon(
        [
          [-0.0088, 0.02],
          [0.0088, 0.02],
          [0.0106, 0.029],
          [0.0082, 0.0336],
          [-0.0082, 0.0336],
          [-0.0106, 0.029]
        ],
        8e-4,
        1
      ),
      0.1012,
      0.3978,
      0.001,
      handguardTint,
      baseWear
    )
  );
  ano.push(
    latheProfile(
      [
        [0.016, 0.096],
        [0.0236, 0.096],
        [0.0243, 0.0967],
        [0.0243, 0.101],
        [0.0236, 0.1016],
        [0.0236, 0.1062],
        [0.0228, 0.1075],
        [0.016, 0.1075]
      ],
      16,
      handguardTint,
      {
        wear: 1.3
      }
    )
  );
  for (let side of [-1, 1]) {
    ano.push(
      kitRoundedBox(
        0.005,
        0.015,
        0.03,
        0.0014,
        side * 0.0222,
        -0.003,
        0.119,
        handguardTint,
        baseWear
      )
    );
    for (let z of [0.112, 0.126]) {
      gun.push(latheCrossPin(0.0027, 0.0016, side * 0.0252, -0.003, z, pinTint, 6, pinWear));
      gun.push(latheCrossPin(0.0012, 6e-4, side * 0.026, -0.003, z, darkTint, 6, recessWear));
    }
    ano.push(
      kitRoundedBox(0.003, 0.006, 0.008, 0.001, side * 0.015, -0.019, 0.1, handguardTint, baseWear)
    );
  }
  ano.push(
    latheProfile(
      [
        [0.018, 0.3985],
        [0.0222, 0.3985],
        [0.0226, 0.399],
        [0.0226, 0.4004],
        [0.022, 0.4012],
        [0.018, 0.4012],
        [0.018, 0.3985]
      ],
      8,
      handguardTint,
      {
        wear: 1.4
      }
    )
  );
  for (let z of [0.115, 0.215, 0.3, 0.385])
    for (let side of [-1, 1]) {
      gun.push(verticalCylinder(0.0019, 0.0012, side * 0.0098, 0.0314, z, pinTint, 6, pinWear));
      gun.push(verticalCylinder(9e-4, 4e-4, side * 0.0098, 0.0321, z, darkTint, 6, recessWear));
    }
  {
    let shortTooth = railToothOutline.map((Re) => [Re[0], Re[1] - 0.016]),
      shortBase = railBaseOutline.map((Re) => [Re[0], Re[1] - 0.0128]),
      diagonalRail = [extrudeAlongBore(shortBase, 0.318, 0.396, 4e-4, handguardTint, baseWear)];
    for (let i = 0; i < 8; i++) {
      let z = 0.319 + i * 0.01001;
      diagonalRail.push(
        extrudeAlongBore(shortTooth, z, z + 0.00478, 6e-4, handguardTint, {
          wear: 1.3
        })
      );
    }
    for (let part of diagonalRail) {
      part.rotateZ(Math.PI / 4);
      ano.push(part);
    }
    let bottomRail = [extrudeAlongBore(shortBase, 0.35, 0.392, 4e-4, handguardTint, baseWear)];
    for (let i = 0; i < 4; i++) {
      let z = 0.352 + i * 0.01001;
      bottomRail.push(
        extrudeAlongBore(shortTooth, z, z + 0.00478, 6e-4, handguardTint, {
          wear: 1.3
        })
      );
    }
    for (let part of bottomRail) {
      part.rotateZ(Math.PI);
      ano.push(part);
    }
  }
  poly.push(
    extrudeAcrossBore(
      filletPolygon(
        [
          [0.35, -0.026],
          [0.392, -0.026],
          [0.388, -0.036],
          [0.372, -0.05],
          [0.362, -0.05],
          [0.354, -0.036]
        ],
        0.003,
        2
      ),
      -0.011,
      0.011,
      0.0032,
      polymerTint,
      {
        ...polymerWear,
        bs: 2,
        zone: 0.6
      }
    )
  );
  poly.push(
    extrudeAcrossBore(
      filletPolygon(
        [
          [0.2395, -0.0215],
          [0.2725, -0.0215],
          [0.2725, -0.03],
          [0.27, -0.092],
          [0.2665, -0.0965],
          [0.2455, -0.0975],
          [0.242, -0.093],
          [0.2395, -0.03]
        ],
        0.0025,
        2
      ),
      -0.014,
      0.014,
      0.0045,
      polymerTint,
      {
        ...polymerWear,
        bs: 3,
        zone: 0.7
      }
    )
  );
  for (let i = 0; i < 6; i++)
    poly.push(
      kitRoundedBox(
        0.0288,
        0.0024,
        0.0312,
        0.001,
        0,
        -0.04 - i * 0.0085,
        0.256 - i * 3e-4,
        polymerTint,
        polymerWear
      )
    );
  poly.push(kitRoundedBox(0.03, 0.005, 0.04, 0.0016, 0, -0.024, 0.256, polymerTint, polymerWear));
  gun.push(latheCrossPin(0.003, 0.031, 0, -0.025, 0.256, pinTint, 8, pinWear));
  gun.push(
    latheProfile(
      [
        [0.0115, 0.095],
        [0.0115, 0.15],
        [0.0095, 0.153],
        [0.0095, 0.285],
        [0.009, 0.288],
        [0.009, 0.322],
        [0.0086, 0.326],
        [0.0086, 0.435],
        [0.0092, 0.437],
        [0.0092, 0.453],
        [0.0075, 0.455],
        [0.0075, 0.461]
      ],
      20,
      steelTint,
      steelWear
    )
  );
  gun.push(
    latheProfile(
      [
        [0.0092, 0.286],
        [0.0135, 0.286],
        [0.0142, 0.2875],
        [0.0142, 0.3165],
        [0.0135, 0.318],
        [0.0092, 0.318]
      ],
      16,
      steelTint,
      steelWear
    )
  );
  gun.push(kitRoundedBox(0.014, 0.009, 0.03, 0.002, 0, 0.0145, 0.302, steelTint, steelWear));
  gun.push(
    boreCylinder(0.0026, 0.1, 0.3, 0, 0.0172, gasTubeTint, 8, {
      bare: 0.8,
      wear: 0.4
    })
  );
  gun.push(latheCrossPin(0.002, 0.0145, 0, 0.012, 0.308, pinTint, 6, pinWear));
  for (let z of [0.2925, 0.3115])
    gun.push(verticalCylinder(0.0017, 0.001, 0, -0.0143, z, darkTint, 6, recessWear));
  gun.push(
    latheProfile(
      [
        [0.0075, 0.459],
        [0.0104, 0.459],
        [0.0112, 0.4598],
        [0.0112, 0.4628],
        [0.0104, 0.4636],
        [0.0104, 0.4644],
        [0.011, 0.465],
        [0.0116, 0.4656],
        [0.0116, 0.477],
        [0.011, 0.478],
        [0.0052, 0.478]
      ],
      20,
      steelTint,
      {
        wear: 1.1,
        zone: 0.6
      }
    )
  );
  gun.push(
    latheProfile(
      [
        [0.0052, 0.477],
        [0.0052, 0.517]
      ],
      12,
      darkTint,
      recessWear
    )
  );
  for (let z of [0.4865, 0.4965, 0.5065])
    gun.push(
      latheProfile(
        [
          [0.0052, z - 0.0019],
          [0.011, z - 0.0019],
          [0.0116, z - 0.0012],
          [0.0116, z + 0.0012],
          [0.011, z + 0.0019],
          [0.0052, z + 0.0019]
        ],
        20,
        steelTint,
        {
          wear: 1.1,
          zone: 0.9
        }
      )
    );
  gun.push(
    latheProfile(
      [
        [0.0052, 0.5145],
        [0.011, 0.5145],
        [0.0116, 0.5155],
        [0.0116, 0.527],
        [0.0102, 0.5305],
        [0.0062, 0.5305],
        [0.0048, 0.5285]
      ],
      20,
      steelTint,
      {
        wear: 1.1,
        zone: 0.9
      }
    )
  );
  gun.push(
    latheProfile(
      [
        [0.0048, 0.5285],
        [0.0036, 0.526],
        [0.0036, 0.495]
      ],
      14,
      darkTint,
      recessWear
    )
  );
  for (let side of [-1, 1])
    gun.push(
      kitRoundedBox(0.0125, 0.0042, 0.042, 0.0012, 0, side * 0.0096, 0.496, steelTint, {
        wear: 1.1,
        zone: 0.9
      })
    );
  for (let i = 0; i < 3; i++)
    gun.push(latheCrossPin(0.0016, 0.0236, 0, 0, 0.4675 + i * 0.0035, darkTint, 6, recessWear));
  ano.push(
    latheProfile(
      [
        [0, -0.292],
        [0.0138, -0.292],
        [0.0146, -0.291],
        [0.0146, -0.1]
      ],
      20,
      bufferTubeTint,
      baseWear
    )
  );
  {
    let profile = [[0.0146, -0.122]];
    for (let i = 0; i < 1; i++)
      profile.push(
        [0.0183, -0.122],
        [0.019, -0.1212],
        [0.019, -0.112],
        [0.0183, -0.111],
        [0.0146, -0.111]
      );
    gun.push(
      latheProfile(profile, 12, steelTint, {
        wear: 1.4,
        crease: 20
      })
    );
    for (let i = 0; i < 6; i++) {
      let angle = (i * Math.PI) / 3 + 0.3;
      gun.push(
        kitRoundedBox(
          0.004,
          0.0022,
          0.005,
          4e-4,
          Math.cos(angle) * 0.0186,
          Math.sin(angle) * 0.0186,
          -0.1192,
          darkTint,
          recessWear,
          [0, 0, angle + Math.PI / 2]
        )
      );
    }
  }
  {
    let outline = [
        [-0.0163, -0.024],
        [0.0163, -0.024],
        [0.018, -0.018],
        [0.018, 0.018],
        [0.0138, 0.024],
        [-0.0138, 0.024],
        [-0.018, 0.018],
        [-0.018, 0.006],
        [-0.031, 0.004],
        [-0.0344, -0.002],
        [-0.0344, -0.014],
        [-0.0292, -0.02],
        [-0.018, -0.02]
      ],
      hole = [
        [-0.0215, -0.014],
        [-0.0215, -0.002],
        [-0.0284, -5e-4],
        [-0.031, -0.004],
        [-0.031, -0.012],
        [-0.0275, -0.016]
      ];
    gun.push(
      extrudeAlongBore(filletPolygon(outline, 0.0015, 1), -0.1095, -0.1045, 8e-4, steelTint, {
        ...steelWear,
        holes: [filletPolygon(hole, 0.0012, 1)]
      })
    );
  }
  plain.push(
    kitRoundedBox(
      0.003,
      8e-4,
      0.015,
      3e-4,
      0.0062,
      0.0182,
      -0.115,
      [0.5, 0.36, 0.03],
      noWear,
      [0, 0, -0.33]
    )
  );
  plain.push(
    kitRoundedBox(0.0022, 6e-4, 0.0022, 2e-4, 0, -0.0146, 0.2925, [0.42, 0.05, 0.03], noWear)
  );
  let stockHalfWidth = 0.0163;
  poly.push(
    extrudeAcrossBore(
      filletPolygon(
        [
          [-0.146, 0.024],
          [-0.3, 0.024],
          [-0.331, 0.014],
          [-0.334, -0.086],
          [-0.318, -0.101],
          [-0.29, -0.096],
          [-0.232, -0.04],
          [-0.146, -0.024]
        ],
        [0.004, 0.02, 0.006, 0.006, 0.006, 0.02, 0.03, 0.006],
        3
      ),
      -stockHalfWidth,
      stockHalfWidth,
      0.0042,
      polymerTint,
      {
        ...polymerWear,
        bs: 3,
        holes: [
          filletPolygon(
            [
              [-0.262, -0.036],
              [-0.306, -0.036],
              [-0.306, -0.074],
              [-0.292, -0.074]
            ],
            0.005,
            2
          ),
          slotOutline(0.004, -0.3185, 0.022, 0.0055, 3).map((p) => [p[1], p[0]])
        ]
      }
    )
  );
  for (let side of [-1, 1]) {
    poly.push(
      extrudeAcrossBore(
        filletPolygon(
          [
            [-0.156, 0.017],
            [-0.25, 0.017],
            [-0.25, -0.022],
            [-0.228, -0.026],
            [-0.156, -0.016]
          ],
          0.004,
          2
        ),
        side > 0 ? stockHalfWidth - 3e-4 : -stockHalfWidth - 6e-4,
        side > 0 ? stockHalfWidth + 6e-4 : -stockHalfWidth + 3e-4,
        5e-4,
        polymerTint,
        {
          wear: 0.8,
          zone: 0.55
        }
      )
    );
    gun.push(
      latheCrossPin(0.0064, 0.002, side * (stockHalfWidth + 2e-4), -0.06, -0.318, steelTint, 14, {
        wear: 1.3
      })
    );
    gun.push(
      latheCrossPin(
        0.0044,
        0.001,
        side * (stockHalfWidth + 0.001),
        -0.06,
        -0.318,
        darkTint,
        12,
        recessWear
      )
    );
  }
  poly.push(
    loftSections(
      [
        outlineToRing(dualRadiusRectOutline(0.012, 0.0215, 0.033, 0.005, 0.001, 3), -0.158, {
          sy: 0.25,
          cy: 0.0215
        }),
        outlineToRing(dualRadiusRectOutline(0.0132, 0.0215, 0.0352, 0.0058, 0.001, 3), -0.166, {
          sy: 0.7,
          cy: 0.0215
        }),
        outlineToRing(dualRadiusRectOutline(0.0138, 0.0215, 0.0372, 0.0062, 0.001, 3), -0.184),
        outlineToRing(dualRadiusRectOutline(0.0142, 0.0215, 0.038, 0.0064, 0.001, 3), -0.288),
        outlineToRing(dualRadiusRectOutline(0.0138, 0.0215, 0.0372, 0.0062, 0.001, 3), -0.298, {
          sy: 0.7,
          cy: 0.0215
        }),
        outlineToRing(dualRadiusRectOutline(0.0128, 0.0215, 0.034, 0.005, 0.001, 3), -0.304, {
          sy: 0.25,
          cy: 0.0215
        })
      ],
      polymerTint,
      polymerWear
    )
  );
  for (let z of [-0.196, -0.268])
    gun.push(latheCrossPin(0.0028, 0.029, 0, 0.0295, z, pinTint, 8, pinWear));
  poly.push(
    kitRoundedBox(
      0.0105,
      0.011,
      0.04,
      0.003,
      0,
      -0.033,
      -0.19,
      polymerTint,
      polymerWear,
      [0.2, 0, 0]
    )
  );
  gun.push(latheCrossPin(0.0022, 0.02, 0, -0.029, -0.174, pinTint, 8, pinWear));
  plain.push(kitRoundedBox(0.0322, 0.12, 0.011, 0.0042, 0, -0.04, -0.3395, rubberTint, noWear));
  for (let i = 0; i < 9; i++)
    plain.push(
      kitRoundedBox(0.027, 0.004, 0.003, 0.001, 0, 0.004 - i * 0.011, -0.3455, rubberTint, noWear)
    );
  let sightY = RIFLE_SPEC.sightY,
    sightWindow = RIFLE_SPEC.window;
  ano.push(
    extrudeAlongBore(
      filletPolygon(
        [
          [-0.015, 0.0436],
          [0.015, 0.0436],
          [0.015, 0.05],
          [0.0176, 0.053],
          [-0.0176, 0.053],
          [-0.015, 0.05]
        ],
        8e-4,
        1
      ),
      0.001,
      0.041,
      0.001,
      sightTint,
      baseWear
    )
  );
  ano.push(kitRoundedBox(0.0044, 0.0086, 0.034, 0.001, -0.0164, 0.045, 0.021, sightTint, baseWear));
  for (let z of [0.009, 0.033]) {
    gun.push(
      latheCrossPin(0.004, 0.004, -0.0204, 0.045, z, steelTint, 6, {
        wear: 1.3
      })
    );
    gun.push(latheCrossPin(0.0019, 0.0012, -0.0228, 0.045, z, pinTint, 8, pinWear));
    gun.push(latheCrossPin(0.003, 0.002, 0.016, 0.045, z, pinTint, 10, pinWear));
  }
  let sightHood = filletPolygon(
    [
      [-0.0192, 0.0525],
      [0.0192, 0.0525],
      [0.0192, 0.0788],
      [0.0138, 0.0842],
      [-0.0138, 0.0842],
      [-0.0192, 0.0788]
    ],
    [0.001, 0.001, 0.0022, 0.0022, 0.0022, 0.0022],
    2
  );
  ano.push(
    extrudeAlongBore(sightHood, 0.008, 0.034, 0.0012, sightTint, {
      ...baseWear,
      bs: 2,
      holes: [sightWindow]
    })
  );
  ano.push(kitRoundedBox(0.042, 0.0052, 0.03, 0.0012, 0, 0.0546, 0.021, sightTint, baseWear));
  plain.push(
    extrudeAlongBore(
      sightWindow.map((p) => [p[0] * 1.004, (p[1] - sightY) * 1.004 + sightY]),
      0.0078,
      0.0342,
      0,
      lensFrameTint,
      {
        wear: 0,
        holes: [sightWindow.map((p) => [p[0] * 0.982, (p[1] - sightY) * 0.982 + sightY])]
      }
    )
  );
  let sightRearBezel = [
    [-0.0204, 0.06],
    [-0.0204, 0.0792],
    [-0.0143, 0.0854],
    [0.0143, 0.0854],
    [0.0204, 0.0792],
    [0.0204, 0.06],
    [0.0193, 0.06],
    [0.0193, 0.0788],
    [0.0138, 0.0843],
    [-0.0138, 0.0843],
    [-0.0193, 0.0788],
    [-0.0193, 0.06]
  ];
  ano.push(
    extrudeAlongBore(sightRearBezel, 0.0285, 0.0385, 3e-4, sightTint, {
      wear: 1.3
    })
  );
  {
    let knob = latheProfile(
      [
        [0, -0.0058],
        [0.005, -0.0058],
        [0.0057, -0.0052],
        [0.0057, -0.003],
        [0.0052, -0.0026],
        [0.0052, -0.0018],
        [0.0057, -0.0014],
        [0.0057, 0.0034],
        [0.005, 0.0042],
        [0, 0.0042]
      ],
      16,
      steelTint,
      {
        wear: 1.3
      }
    );
    knob.rotateY(Math.PI / 2);
    knob.translate(0.0222, 0.0625, -0.021);
    gun.push(knob);
    gun.push(
      kitRoundedBox(6e-4, 0.0012, 0.0074, 2e-4, 0.0281, 0.0625, 0.021, darkTint, recessWear)
    );
  }
  for (let z of [0.0165, 0.0245])
    plain.push(kitRoundedBox(0.0022, 0.0055, 0.0055, 0.001, -0.0197, 0.064, z, rubberTint, noWear));
  for (let z of [0.012, 0.03])
    for (let side of [-1, 1])
      gun.push(latheCrossPin(0.0016, 0.0012, side * 0.0212, 0.0546, z, pinTint, 6, pinWear));
  plain.push(kitRoundedBox(0.009, 0.0026, 0.006, 6e-4, 0, 0.058, 0.0115, lensFrameTint, noWear));
  for (let x of [0.0128, -0.0128]) {
    let screw = latheProfile(
      [
        [0, -6e-4],
        [0.0019, -6e-4],
        [0.0022, -2e-4],
        [0.0022, 7e-4],
        [0, 7e-4]
      ],
      10,
      pinTint,
      {
        ...pinWear,
        ox: x,
        oy: 0.0546
      }
    );
    screw.translate(0, 0, -0.006);
    gun.push(screw);
  }
  gun.push(verticalCylinder(0.003, 0.0022, 0.009, 0.0846, 0.014, pinTint, 12, pinWear));
  plain.push(kitRoundedBox(0.0044, 3e-4, 9e-4, 1e-4, 0.009, 0.0858, 0.014, lensFrameTint, noWear));
  plain.push(
    kitRoundedBox(0.016, 5e-4, 0.01, 1e-4, -0.003, 0.08435, 0.025, [0.012, 0.016, 0.03], noWear)
  );
  {
    let knob = latheProfile(
      [
        [0, -0.0012],
        [0.0034, -0.0012],
        [0.004, -6e-4],
        [0.004, 0.0026],
        [0.0034, 0.0032],
        [0, 0.0032]
      ],
      12,
      steelTint,
      {
        wear: 1.3
      }
    );
    knob.rotateY(-Math.PI / 2);
    knob.translate(0.0196, 0.0755, -0.0125);
    gun.push(knob);
    gun.push(
      kitRoundedBox(5e-4, 0.001, 0.0052, 2e-4, 0.0228, 0.0755, 0.0125, darkTint, recessWear)
    );
  }
  plain.push(
    extrudeAlongBore(sightWindow, 0.0304, 0.0318, 0, lensFrameTint, {
      wear: 0,
      holes: [sightWindow.map((p) => [p[0] * 0.955, (p[1] - sightY) * 0.955 + sightY])]
    })
  );
  for (let [z, dir] of [
    [-0.03, 1],
    [0.372, -1]
  ]) {
    gun.push(
      extrudeAlongBore(
        filletPolygon(
          [
            [-0.0106, 0.0437],
            [0.0106, 0.0437],
            [0.0112, 0.0462],
            [0.009, 0.0508],
            [-0.009, 0.0508],
            [-0.0112, 0.0462]
          ],
          8e-4,
          1
        ),
        z - 0.015,
        z + 0.015,
        8e-4,
        steelTint,
        steelWear
      )
    );
    gun.push(
      extrudeAcrossBore(
        filletPolygon(
          [
            [z - dir * 0.0165, 0.0506],
            [z + dir * 0.0215, 0.0506],
            [z + dir * 0.0215, 0.053],
            [z + dir * 0.018, 0.0549],
            [z - dir * 0.01, 0.0549],
            [z - dir * 0.0165, 0.0532]
          ],
          8e-4,
          1
        ),
        -0.006,
        0.006,
        9e-4,
        steelTint,
        {
          wear: 1.1
        }
      )
    );
    for (let side of [-1, 1])
      gun.push(
        kitRoundedBox(
          0.0022,
          0.0034,
          0.02,
          8e-4,
          side * 0.0071,
          0.0524,
          z + dir * 0.009,
          steelTint,
          steelWear
        )
      );
    gun.push(
      latheCrossPin(0.0029, 0.0236, 0, 0.052, z - dir * 0.0125, steelTint, 10, {
        wear: 1.2
      })
    );
    gun.push(
      kitRoundedBox(0.004, 0.006, 0.006, 0.001, dir * 0.0128, 0.0472, z, steelTint, steelWear)
    );
    gun.push(latheCrossPin(0.004, 0.0044, -0.0128, 0.0472, z + 0.006, pinTint, 6, pinWear));
    gun.push(latheCrossPin(0.0016, 0.0014, 0.0122, 0.0478, z - 0.007, pinTint, 8, pinWear));
  }
  {
    let ring = latheProfile(
      [
        [0.0016, -0.0012],
        [0.0034, -0.0012],
        [0.0038, -8e-4],
        [0.0038, 8e-4],
        [0.0034, 0.0012],
        [0.0016, 0.0012],
        [0.0016, -0.0012]
      ],
      12,
      steelTint,
      steelWear
    );
    ring.rotateX(Math.PI / 2);
    ring.translate(0, 0.0553, 0.016);
    gun.push(ring);
  }
  gun.push(
    latheCrossPin(0.0048, 0.005, 0.015, 0.049, -0.036, steelTint, 12, {
      wear: 1.4
    })
  );
  for (let i = 0; i < 6; i++)
    gun.push(
      kitRoundedBox(
        0.0044,
        0.001,
        0.001,
        3e-4,
        0.015,
        0.049 + Math.sin(i * 1.047) * 0.0046,
        -0.036 + Math.cos(i * 1.047) * 0.0046,
        steelTint,
        steelWear
      )
    );
  ano.push(kitRoundedBox(0.016, 0.005, 0.02, 0.0014, 0, 0.0352, -0.0975, receiverTint, baseWear));
  gun.push(verticalCylinder(0.003, 0.0012, 0, 0.038, -0.0985, pinTint, 6, pinWear));
  let lightX = -0.0267,
    lightY = 0.0267;
  ano.push(
    latheProfile(
      [
        [0, 0.308],
        [0.0095, 0.308],
        [0.0108, 0.3095],
        [0.0108, 0.322],
        [0.0118, 0.323],
        [0.0118, 0.378],
        [0.0128, 0.38],
        [0.0142, 0.382],
        [0.0142, 0.404],
        [0.0136, 0.406],
        [0.0142, 0.408],
        [0.0142, 0.412],
        [0.0128, 0.4135],
        [0.0118, 0.4135],
        [0.0112, 0.409]
      ],
      18,
      lightTint,
      {
        wear: 1.2,
        ox: lightX,
        oy: lightY
      }
    )
  );
  plain.push(
    latheProfile(
      [
        [0.0112, 0.409],
        [0, 0.409]
      ],
      18,
      [0.1, 0.12, 0.14],
      {
        wear: 0,
        ox: lightX,
        oy: lightY
      }
    )
  );
  for (let i = 0; i < 5; i++)
    ano.push(
      latheProfile(
        [
          [0.0118, 0.33 + i * 0.008],
          [0.0124, 0.3305 + i * 0.008],
          [0.0124, 0.3335 + i * 0.008],
          [0.0118, 0.334 + i * 0.008]
        ],
        18,
        lightTint,
        {
          wear: 1.4,
          ox: lightX,
          oy: lightY
        }
      )
    );
  {
    let mount = kitRoundedBox(0.02, 0.008, 0.04, 0.0012, 0, 0.028, 0.352, lightTint, baseWear);
    mount.rotateZ(Math.PI / 4);
    ano.push(mount);
  }
  {
    let pin = latheCrossPin(0.004, 0.006, 0.0135, 0.028, 0.352, pinTint, 6, pinWear);
    pin.rotateZ(Math.PI / 4);
    gun.push(pin);
  }
  plain.push(kitRoundedBox(0.0185, 0.0065, 0.07, 0.0025, 0, 0.0468, 0.214, rubberTint, noWear));
  for (let i = 0; i < 6; i++)
    plain.push(
      kitRoundedBox(0.014, 0.0012, 0.004, 5e-4, 0, 0.0503, 0.192 + i * 0.009, rubberTint, noWear)
    );
  plain.push(
    bakeSurfaceWearAttributes(
      tubeThroughPoints(
        [
          [lightX, lightY, -0.308],
          [lightX - 0.001, lightY + 0.002, -0.296],
          [-0.0265, 0.0235, -0.284],
          [-0.0255, 0.0215, -0.272],
          [-0.0235, 0.027, -0.262],
          [-0.016, 0.04, -0.256],
          [-0.007, 0.0465, -0.252],
          [-0.002, 0.047, -0.247]
        ],
        0.0018,
        6
      ),
      rubberTint,
      {
        keepN: true,
        wear: 0
      }
    )
  );
  for (let clip of [
    [-0.0262, 0.0228, 0.28],
    [-0.0242, 0.0255, 0.265]
  ]) {
    let part = kitRoundedBox(0.0065, 0.0026, 0.0035, 8e-4, 0, 0, 0, [0.04, 0.04, 0.04], noWear);
    part.rotateZ(Math.PI / 4);
    part.translate(clip[0], clip[1], -clip[2]);
    plain.push(part);
  }
  let boltTint = [9.5, 9.5, 9.9];
  bolt.push(
    latheProfile(
      [
        [0, -0.058],
        [0.0108, -0.058],
        [0.0114, -0.057],
        [0.0114, -0.01],
        [0.0106, -0.008],
        [0.0106, -0.002],
        [0.0114, 0],
        [0.0114, 0.046],
        [0.0098, 0.048],
        [0.0098, 0.056],
        [0.0058, 0.056],
        [0.0058, 0.06],
        [0, 0.06]
      ],
      16,
      boltTint,
      {
        bare: 1,
        wear: 0.5,
        oy: 0.001
      }
    )
  );
  for (let i = 0; i < 6; i++)
    bolt.push(
      kitRoundedBox(
        0.0014,
        0.008,
        0.0026,
        5e-4,
        0.0112,
        0.001,
        0.008 + i * 0.0062,
        [2.2, 2.2, 2.3],
        {
          bare: 0.6,
          wear: 0
        }
      )
    );
  bolt.push(
    kitRoundedBox(0.01, 0.0054, 0.014, 0.0015, -0.0142, 0.007, 0.078, steelTint, steelWear)
  );
  {
    let knob = latheProfile(
      [
        [0, -0.0078],
        [0.0042, -0.0078],
        [0.0056, -0.0066],
        [0.0056, -0.0046],
        [0.005, -0.004],
        [0.005, -0.0026],
        [0.0056, -0.002],
        [0.0056, 0],
        [0.005, 6e-4],
        [0.005, 0.002],
        [0.0056, 0.0026],
        [0.0056, 0.0062],
        [0.0046, 0.0078],
        [0, 0.0078]
      ],
      14,
      steelTint,
      {
        wear: 1.5,
        zone: 1
      }
    );
    knob.rotateY(Math.PI / 2);
    knob.translate(-0.0267, 0.007, -0.078);
    bolt.push(knob);
  }
  let magCurve = (depth: number) => 1.5 * Math.pow(Math.max(0, depth - 0.07), 2),
    magSlope = (depth: number) => 3 * Math.max(0, depth - 0.07),
    magTint = [1, 1, 1],
    magOutline: [number, number][] = [],
    magLength = 0.212,
    magSteps = 12,
    magWear = {
      wear: 0.8,
      zone: 0.25
    };
  for (let i = 0; i <= magSteps; i++) {
    let depth = -0.004 + ((magLength + 0.004) * i) / magSteps;
    magOutline.push([magCurve(depth) + 0.0298, -depth]);
  }
  for (let i = magSteps; i >= 0; i--) {
    let depth = -0.004 + ((magLength + 0.004) * i) / magSteps;
    magOutline.push([magCurve(depth) - 0.0298, -depth]);
  }
  mag.push(
    extrudeAcrossBore(magOutline, -0.0113, 0.0113, 0.0022, magTint, {
      ...magWear,
      bs: 2,
      crease: 40
    })
  );
  for (let i = 0; i < 8; i++) {
    let depth = 0.082 + i * 0.0155;
    mag.push(
      kitRoundedBox(0.0244, 0.0056, 0.05, 0.0018, 0, -depth, magCurve(depth), magTint, magWear, [
        Math.atan(magSlope(depth)),
        0,
        0
      ])
    );
  }
  for (let i = 0; i < 10; i++) {
    let depth = 0.078 + i * 0.013;
    mag.push(
      kitRoundedBox(
        0.012,
        0.011,
        0.004,
        0.0012,
        0,
        -depth,
        magCurve(depth) + 0.0302,
        magTint,
        magWear,
        [Math.atan(magSlope(depth)), 0, 0]
      )
    );
  }
  mag.push(
    kitRoundedBox(
      0.027,
      0.009,
      0.068,
      0.003,
      0,
      -magLength - 0.003,
      magCurve(magLength) + 0.001,
      magTint,
      {
        wear: 1,
        zone: 0.6
      },
      [Math.atan(magSlope(magLength)), 0, 0]
    )
  );
  mag.push(
    kitRoundedBox(
      0.01,
      0.004,
      0.012,
      0.001,
      0,
      -magLength - 0.008,
      magCurve(magLength) - 0.01,
      [0.6, 0.6, 0.6],
      polymerWear,
      [Math.atan(magSlope(magLength)), 0, 0]
    )
  );
  mag.push(kitRoundedBox(0.003, 0.006, 0.04, 0.001, -0.0085, 0.0045, 0.004, magTint, magWear));
  mag.push(kitRoundedBox(0.003, 0.006, 0.04, 0.001, 0.0085, 0.0045, 0.004, magTint, magWear));
  let bulletTint = [1.25, 0.72, 0.5];
  round.push(
    latheProfile(
      [
        [0, -0.02],
        [0.004, -0.02],
        [0.0047, -0.019],
        [0.0047, 0.01],
        [0.0034, 0.014],
        [0.0034, 0.018]
      ],
      12,
      [1, 1, 1],
      {
        wear: 0,
        ox: 0.002,
        oy: 0.0062
      }
    )
  );
  round.push(
    latheProfile(
      [
        [0.003, 0.018],
        [0.0029, 0.024],
        [0.0022, 0.03],
        [0.001, 0.0345],
        [0, 0.0352]
      ],
      12,
      bulletTint,
      {
        wear: 0,
        ox: 0.002,
        oy: 0.0062
      }
    )
  );
  round.push(
    latheProfile(
      [
        [0, -0.02],
        [0.004, -0.02],
        [0.0047, -0.019],
        [0.0047, 0.01]
      ],
      10,
      [0.8, 0.8, 0.8],
      {
        wear: 0,
        ox: -0.003,
        oy: 5e-4
      }
    )
  );
  let geometries: RifleGeometries = {
      ano: mergeKitGeometries(ano),
      gun: mergeKitGeometries(gun),
      poly: mergeKitGeometries(poly),
      plain: mergeKitGeometries(plain),
      bolt: mergeKitGeometries(bolt),
      mag: mergeKitGeometries(mag),
      round: mergeKitGeometries(round)
    },
    gripZone: OcclusionZoneFn = (x, y, z, key) =>
      key === 'poly' || key === 'plain' || key === 'round' || key === 'mag'
        ? 0
        : Math.max(
            boxZoneFalloff(x, y, z, -0.03, 0.03, -0.095, -0.074, 0.03, 0.104, 0.014),
            0.85 * boxZoneFalloff(x, y, z, 0.012, 0.03, -0.014, 0.016, -0.016, 0.066, 0.012),
            0.85 * boxZoneFalloff(x, y, z, -0.03, -0.012, 5e-4, 0.0135, -0.028, 0.092, 0.01),
            0.5 * boxZoneFalloff(x, y, z, -0.03, 0.03, -0.026, -0.016, -0.1, 0.1, 0.004)
          );
  bakeVoxelOcclusion(
    (Object.keys(geometries) as (keyof RifleGeometries)[]).map((key) => ({
      key: key,
      g: geometries[key],
      off: key === 'mag' || key === 'round' ? RIFLE_SPEC.magPos : null
    })),
    gripZone
  );
  for (let key in geometries) geometries[key as keyof RifleGeometries].computeBoundingSphere();
  return geometries;
}
/** Mirror fix-up: reverse every triangle's winding (positions, normals, colours and aSurf). */
function flipTriangleWinding(geometry: BufferGeometry): void {
  let positions = geometry.attributes.position.array,
    normals = geometry.attributes.normal.array,
    colors = geometry.attributes.color.array,
    surf = geometry.attributes.aSurf.array,
    swap = (array: TypedArray, from: number, to: number, itemSize: number): void => {
      for (let k = 0; k < itemSize; k++) {
        let tmp = array[from * itemSize + k];
        array[from * itemSize + k] = array[to * itemSize + k];
        array[to * itemSize + k] = tmp;
      }
    };
  for (let v = 0; v < positions.length / 3; v += 3) {
    swap(positions, v + 1, v + 2, 3);
    swap(normals, v + 1, v + 2, 3);
    swap(colors, v + 1, v + 2, 3);
    swap(surf, v + 1, v + 2, 4);
  }
}
/** Number of triangles in a (possibly indexed) geometry. */
export const triangleCount = (geometry: BufferGeometry): number =>
  (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;

/** Damped spring state (x: value, v: velocity, w: angular frequency, z: damping ratio). */
export interface KitSpring {
  x: number;
  v: number;
  w: number;
  z: number;
}

/** A keyframe for `sampleKeyframePose`: `[time, { p: position, q: rotation }]`. */
export type PoseKeyframe = readonly [number, { readonly p: Vector3; readonly q: Quaternion }];

export const QuaternionClass = Quaternion,
  /** Clamp to [0, 1]. */
  clampUnit = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x),
  /** Quintic smootherstep of a clamped [0, 1] input. */
  smootherstep01 = (x: number): number => {
    x = clampUnit(x);
    return x * x * x * (x * (6 * x - 15) + 10);
  },
  easeInQuad = (x: number): number => {
    x = clampUnit(x);
    return x * x;
  },
  easeOutQuad = (x: number): number => {
    x = clampUnit(x);
    return 1 - (1 - x) * (1 - x);
  };
/** Clamped linear ramp from 0 at `edge0` to 1 at `edge1`. */
export const linearStep = (x: number, edge0: number, edge1: number): number =>
    clampUnit((x - edge0) / (edge1 - edge0)),
  easeOutBack = (x: number, overshoot: number): number => {
    x = clampUnit(x);
    let u = x - 1;
    return 1 + (overshoot + 1) * u * u * u + overshoot * u * u;
  },
  /** A spring at rest at 0 with angular frequency `omega` and damping ratio `zeta`. */
  createSpring = (omega: number, zeta = 1): KitSpring => ({
    x: 0,
    v: 0,
    w: omega,
    z: zeta
  });
/** Advance a spring towards `target` by `dt` seconds (exact analytic step); returns the new value. */
export function advanceSpring(
  spring: KitSpring,
  target: number,
  dt: number,
  omega: number = spring.w,
  zeta: number = spring.z
): number {
  let offset = spring.x - target,
    velocity = spring.v;
  if (zeta >= 0.999) {
    let decay = Math.exp(-omega * dt),
      coef = velocity + omega * offset;
    spring.x = target + (offset + coef * dt) * decay;
    spring.v = (velocity - omega * coef * dt) * decay;
  } else {
    let omegaD = omega * Math.sqrt(1 - zeta * zeta),
      decay = Math.exp(-zeta * omega * dt),
      cos = Math.cos(omegaD * dt),
      sin = Math.sin(omegaD * dt),
      coef = (velocity + zeta * omega * offset) / omegaD;
    spring.x = target + decay * (offset * cos + coef * sin);
    spring.v =
      decay * (omegaD * (coef * cos - offset * sin) - zeta * omega * (offset * cos + coef * sin));
  }
  return spring.x;
}
/** Snap a spring to `value` with zero velocity. */
export const resetSpring = (spring: KitSpring, value = 0): void => {
    spring.x = value;
    spring.v = 0;
  },
  hashSigned1D = (x: number): number => {
    let h = Math.sin(x * 127.1 + 311.7) * 43758.5453;
    return (h - Math.floor(h)) * 2 - 1;
  };
/** Smooth 1D gradient noise in roughly [-1, 1]; `seed` selects an independent channel. */
export function gradientNoise1D(x: number, seed = 0): number {
  let cell = Math.floor(x),
    frac = x - cell,
    fade = frac * frac * frac * (frac * (6 * frac - 15) + 10);
  return (
    2 *
    ((1 - fade) * hashSigned1D(cell + seed * 57.31) * frac +
      fade * hashSigned1D(cell + 1 + seed * 57.31) * (frac - 1))
  );
}
/** Smoothly limit `x` to (-limit, limit). */
export const softClampTanh = (x: number, limit: number): number => limit * Math.tanh(x / limit),
  /** A new quaternion from Euler angles. */
  quatFromEuler = (x: number, y: number, z: number, order: EulerOrder = 'XYZ'): Quaternion =>
    new QuaternionClass().setFromEuler(new Euler(x, y, z, order));
/** Sample a smootherstep-interpolated pose track at `time` into `outPos` / `outQuat`. */
export function sampleKeyframePose(
  keys: readonly PoseKeyframe[],
  time: number,
  outPos: Vector3,
  outQuat: Quaternion
): void {
  let k = 0;
  for (; k < keys.length - 2 && time > keys[k + 1][0];) k++;
  let from = keys[k],
    to = keys[k + 1],
    t = smootherstep01((time - from[0]) / Math.max(1e-4, to[0] - from[0]));
  outPos.copy(from[1].p).lerp(to[1].p, t);
  outQuat.copy(from[1].q).slerp(to[1].q, t);
}
