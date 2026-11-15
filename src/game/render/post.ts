/**
 * The HDR post-processing chain: half-res depth, SSAO, ray-marched volumetric
 * sun fog, motion blur, bloom + anamorphic streak, eye adaptation, lens dirt and
 * flare, ACES/AgX tone mapping + colour grade, and a final FXAA/sharpen/grain pass.
 */
import {
  AlwaysDepth,
  BufferAttribute,
  BufferGeometry,
  Camera,
  DataUtils,
  DepthTexture,
  DirectionalLight,
  FloatType,
  HalfFloatType,
  IUniform,
  LinearFilter,
  Matrix4,
  Mesh,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  RGBAFormat,
  RedFormat,
  RenderTargetOptions,
  ShaderMaterial,
  ShaderMaterialParameters,
  Texture,
  TextureDataType,
  MagnificationTextureFilter,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer
} from 'three';
import type { Game } from '../core/types';
import { SKY_COLORS, SUN } from '../core/config';
import { NOISE_GLSL, SKY_HORIZON_GLSL } from './noise';

// ---- GLSL sources (`POST_SHADER_TAG <pass name>` is prepended to each fragment shader) ----

export const POST_SHADER_TAG = '// SALTLINE_POST';
export const NEAR_DEPTH_CUTOFF = '0.05';
export const NEAR_VIEWZ_CUTOFF = '0.05';
export const FULLSCREEN_VERT =
  'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
export const POST_COMMON_GLSL = `
varying vec2 vUv;
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;
export const EXPOSURE_GLSL = `
uniform sampler2D tAdapt; uniform float uExposure, uKey, uMinE, uMaxE, uAuto;
float slExposure(){ float a = texture2D(tAdapt, vec2(0.5)).r; return uExposure * mix(1.0, clamp(pow(uKey / max(a, 1e-4), 0.85), uMinE, uMaxE), uAuto); }
`;
export const DEPTH_COPY_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tDepth;
void main(){ gl_FragDepth = texture2D(tDepth, vUv).r; gl_FragColor = vec4(0.0); }`;
export const DEPTH_HALF_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tDepth; uniform float uNear, uFar;
void main(){
  // exact texel fetch: sampling at a texel corner would pick rows unpredictably and band the AO on grazing floors
  ivec2 p = min(ivec2(gl_FragCoord.xy) * 2, textureSize(tDepth, 0) - 1);
  float d = texelFetch(tDepth, p, 0).r;
  float z = d < ${NEAR_DEPTH_CUTOFF} ? 0.01 : (uNear * uFar) / (uFar - d * (uFar - uNear));
  gl_FragColor = vec4(z, 0.0, 0.0, 1.0);
}`;
export const SSAO_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tDepthHalf; uniform vec2 uTanHalf, uTexel; uniform float uRadius, uIntensity, uAspect;
vec3 vpos(vec2 uv, float z){ return vec3((uv * 2.0 - 1.0) * uTanHalf * z, -z); }
void main(){
  float z0 = texture2D(tDepthHalf, vUv).r;
  if (z0 < ${NEAR_VIEWZ_CUTOFF} || z0 > 140.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = vpos(vUv, z0);
  vec2 ox = vec2(uTexel.x, 0.0), oy = vec2(0.0, uTexel.y);
  float zl = texture2D(tDepthHalf, vUv - ox).r, zr = texture2D(tDepthHalf, vUv + ox).r;
  float zd = texture2D(tDepthHalf, vUv - oy).r, zu = texture2D(tDepthHalf, vUv + oy).r;
  vec3 dx = abs(zl - z0) < abs(zr - z0) ? P - vpos(vUv - ox, zl) : vpos(vUv + ox, zr) - P;
  vec3 dy = abs(zd - z0) < abs(zu - z0) ? P - vpos(vUv - oy, zd) : vpos(vUv + oy, zu) - P;
  vec3 n = normalize(cross(dx, dy));
  float R = uRadius * (0.6 + 0.4 * clamp(z0 / 12.0, 0.0, 1.0));
  float rUv = clamp(R / (2.0 * z0 * uTanHalf.y), 3.0 * uTexel.y, 0.14);
  float R2 = R * R;
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  float sum = 0.0;
  for (int i = 0; i < AO_TAPS; i++) {
    float a = (float(i) + 0.5) / float(AO_TAPS);
    float th = a * 6.2831853 * 3.0 + rot;
    vec2 o = vec2(cos(th), sin(th)) * a * rUv; o.x /= uAspect;
    vec2 uv2 = vUv + o;
    float z2 = texture2D(tDepthHalf, uv2).r;
    vec3 v = vpos(uv2, z2) - P;
    float vv = dot(v, v), vn = dot(v, n);
    float f = max(R2 - vv, 0.0);
    sum += f * f * f * max((vn - (0.015 + 0.004 * z0)) / (vv + 0.004), 0.0);
  }
  float ao = max(0.0, 1.0 - uIntensity * sum * 5.0 / (R2 * R2 * R2 * float(AO_TAPS)));
  ao = mix(ao, 1.0, smoothstep(70.0, 140.0, z0));
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`;
export const VOLUMETRIC_FOG_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tDepthHalf, tShadow;
uniform mat4 uShadowMatrix, uCamWorld;
uniform vec3 uCamPos, uSunRad, uAmb;
uniform vec2 uTanHalf;
uniform float uHasShadow, uMaxDist, uSigma, uFarZ, uFarHaze, uFlicker, uBoxDust;
uniform vec3 uBoxMin, uBoxMax;
${SKY_HORIZON_GLSL}
float shape(float h){ return 0.30 + 0.70 * exp(-max(h, 0.0) / 5.5); }
float hg(float mu, float g){ float g2 = g * g; return (1.0 - g2) / (12.566371 * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5)); }
float sunVis(vec3 p){
  vec4 sc = uShadowMatrix * vec4(p, 1.0);
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0 || sc.z < 0.0) return 1.0;
  float d = dot(texture2D(tShadow, sc.xy), vec4(0.99609375, 0.99609375 / 256.0, 0.99609375 / 65536.0, 1.0 / 16777216.0));
  return step(sc.z - 0.0006, d);
}
void main(){
  float z = texture2D(tDepthHalf, vUv).r;
  if (z < ${NEAR_VIEWZ_CUTOFF}) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 vd = vec3((vUv * 2.0 - 1.0) * uTanHalf, -1.0);
  float rl = length(vd);
  vec3 rd = normalize(mat3(uCamWorld) * vd);
  float dist = z * rl;
  bool isSky = z > uFarZ * 0.97;
  float maxD = min(dist, isSky ? uMaxDist * 0.55 : uMaxDist);
  float mu = dot(rd, uSunDir);
  // two-lobe phase: tight forward lobe for the gold glow toward the sun + a broad lobe so side-lit shafts stay visible
  float ph = min(hg(mu, 0.78) * 0.55 + hg(mu, 0.25) * 0.45, 1.15);
  float j = ign(gl_FragCoord.xy);
  vec3 acc = vec3(0.0); float T = 1.0; float tPrev = 0.0;
  for (int i = 0; i < VOL_STEPS; i++) {
    float f = (float(i) + 1.0) / float(VOL_STEPS);
    float t1 = maxD * f * (0.35 + 0.65 * f);              // denser sampling near the eye
    float ds = t1 - tPrev;
    vec3 p = uCamPos + rd * (tPrev + ds * j);
    float sh = uHasShadow > 0.5 ? sunVis(p) : 1.0;
    // dusty interior (the shed): thicker air so sun shafts through doors, louvres and roof holes read; less sky ambient
    vec3 bq = step(uBoxMin, p) * step(p, uBoxMax); float inb = bq.x * bq.y * bq.z;
    float ext = uSigma * shape(p.y) * (1.0 + uBoxDust * inb);
    float Ti = exp(-ext * ds);
    // art direction: beams near the eye read strongly (shafts between stacks), the far field stays a restrained veil
    float nearW = mix(2.3, 0.55, smoothstep(4.0, 85.0, tPrev + ds * j));
    vec3 src = uSunRad * (ph * sh * mix(nearW, 1.6, inb)) + uAmb * (0.40 + 0.60 * sh) * mix(1.0, 0.22, inb);
    acc += T * src * (1.0 - Ti);
    T *= Ti; tPrev = t1;
  }
  // analytic continuation for far geometry (ship, cranes, skyline): fades into the horizon colour of that direction
  if (!isSky && dist > uMaxDist) {
    float h1 = uCamPos.y + rd.y * uMaxDist, h2 = uCamPos.y + rd.y * dist;
    float tau = uSigma * uFarHaze * (dist - uMaxDist) * 0.5 * (shape(h1) + shape(h2));
    float Tf = exp(-tau);
    vec3 hc = horizonColor(rd) * 0.50 + uAmb * 0.6;
    acc += T * hc * (1.0 - Tf);
    T *= Tf;
  }
  gl_FragColor = vec4(acc, T);
}`;
export const DEPTH_AWARE_BLUR_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tSrc, tDepthHalf; uniform vec2 uDir;
void main(){
  float z0 = texture2D(tDepthHalf, vUv).r;
  float zc = min(z0, 300.0);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = -3; i <= 3; i++) {
    vec2 uv = vUv + uDir * float(i);
    float z = min(texture2D(tDepthHalf, uv).r, 300.0);
    float w = (1.0 - abs(float(i)) * 0.22) * max(0.0, 1.0 - abs(z - zc) / (BLUR_TOL * zc + 0.02));
    acc += texture2D(tSrc, uv) * w; ws += w;
  }
  gl_FragColor = ws > 1e-4 ? acc / ws : texture2D(tSrc, vUv);
}`;
export const AO_VOL_COMPOSITE_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tColor, tDepth, tDepthHalf, tAO, tVol;
uniform vec2 uHalfRes; uniform float uNear, uFar, uAoOn, uVolOn, uAoStrength;
${EXPOSURE_GLSL}
void main(){
  vec3 col = max(texture2D(tColor, vUv).rgb, vec3(0.0));
  float d = texture2D(tDepth, vUv).r;
  if (d >= ${NEAR_DEPTH_CUTOFF}) {
    float z = (uNear * uFar) / (uFar - d * (uFar - uNear));
    // joint bilateral upsample of the half-res buffers
    vec2 hp = vUv * uHalfRes - 0.5; vec2 f = fract(hp); vec2 base = (floor(hp) + 0.5) / uHalfRes; vec2 tx = 1.0 / uHalfRes;
    float ao = 0.0; vec4 vol = vec4(0.0); float ws = 0.0;
    float zc = min(z, 300.0);
    for (int k = 0; k < 4; k++) {
      vec2 o = vec2(float(k & 1), float(k >> 1));
      vec2 uv = base + o * tx;
      float zh = min(texture2D(tDepthHalf, uv).r, 300.0);
      float w = (o.x > 0.5 ? f.x : 1.0 - f.x) * (o.y > 0.5 ? f.y : 1.0 - f.y);
      w *= 1.0 / (0.015 + abs(zh - zc) / zc) ;
      w = max(w, 1e-5);
      ao += texture2D(tAO, uv).r * w; vol += texture2D(tVol, uv) * w; ws += w;
    }
    ao /= ws; vol /= ws;
    if (uAoOn > 0.5 && d < 0.99999) {
      // occlusion belongs to ambient light: fade it out on brightly lit pixels so sunlit surfaces never get dirty halos
      float lit = smoothstep(0.16, 0.85, luma(col) * slExposure());
      float a = mix(1.0, ao, uAoStrength * (1.0 - 0.8 * lit));
      col *= mix(vec3(a), vec3(1.0), vec3(0.0, 0.03, 0.07));      // faintly cool occlusion
    }
    if (uVolOn > 0.5) col = col * vol.a + vol.rgb;
  }
  gl_FragColor = vec4(col, 1.0);
}`;
export const MOTION_BLUR_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tColor, tDepth; uniform mat4 uInvViewProj, uPrevViewProj; uniform float uShutter; uniform vec2 uRes;
void main(){
  vec4 c0 = texture2D(tColor, vUv);
  float d = texture2D(tDepth, vUv).r;
  if (d < ${NEAR_DEPTH_CUTOFF}) { gl_FragColor = c0; return; }
  vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); wp /= wp.w;
  vec4 pc = uPrevViewProj * wp;
  vec2 puv = pc.xy / max(pc.w, 1e-4) * 0.5 + 0.5;
  vec2 vel = (vUv - puv) * uShutter;
  float len = length(vel);
  if (pc.w <= 0.0 || len * uRes.y < 0.75) { gl_FragColor = c0; return; }
  vel *= min(1.0, 0.018 / len);
  float j = ign(gl_FragCoord.xy) - 0.5;
  vec3 acc = c0.rgb; float ws = 1.0;
  for (int i = 0; i < 9; i++) {
    vec2 uv = vUv + vel * ((float(i) + 0.5 + j) / 9.0 - 0.5);
    float w = texture2D(tDepth, uv).r < ${NEAR_DEPTH_CUTOFF} ? 0.0 : 1.0;
    acc += texture2D(tColor, uv).rgb * w; ws += w;
  }
  gl_FragColor = vec4(acc / ws, 1.0);
}`;
export const BLOOM_DOWNSAMPLE_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFirst;
vec3 s(vec2 o){ return min(max(texture2D(tSrc, vUv + o * uTexel).rgb, vec3(0.0)), vec3(400.0)); }
float kw(vec3 c){ return 1.0 / (1.0 + luma(c) * 0.08); }
void main(){
  vec3 a = s(vec2(-2.0, 2.0)), b = s(vec2(0.0, 2.0)), c = s(vec2(2.0, 2.0));
  vec3 d = s(vec2(-2.0, 0.0)), e = s(vec2(0.0, 0.0)), f = s(vec2(2.0, 0.0));
  vec3 g = s(vec2(-2.0, -2.0)), h = s(vec2(0.0, -2.0)), i = s(vec2(2.0, -2.0));
  vec3 j = s(vec2(-1.0, 1.0)), k = s(vec2(1.0, 1.0)), l = s(vec2(-1.0, -1.0)), m = s(vec2(1.0, -1.0));
  vec3 col;
  if (uFirst > 0.5) {
    // partial Karis average on the first downsample: tames fireflies without killing the sun
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = kw(g0) * 0.125, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.5;
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  gl_FragColor = vec4(col, 1.0);
}`;
export const BLOOM_UPSAMPLE_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tLow, tHigh; uniform vec2 uTexel; uniform float uMix;
void main(){
  vec2 o = uTexel;
  vec3 t = texture2D(tLow, vUv).rgb * 4.0;
  t += (texture2D(tLow, vUv + vec2(o.x, 0.0)).rgb + texture2D(tLow, vUv - vec2(o.x, 0.0)).rgb + texture2D(tLow, vUv + vec2(0.0, o.y)).rgb + texture2D(tLow, vUv - vec2(0.0, o.y)).rgb) * 2.0;
  t += texture2D(tLow, vUv + o).rgb + texture2D(tLow, vUv - o).rgb + texture2D(tLow, vUv + vec2(o.x, -o.y)).rgb + texture2D(tLow, vUv + vec2(-o.x, o.y)).rgb;
  t *= 1.0 / 16.0;
  gl_FragColor = vec4(mix(texture2D(tHigh, vUv).rgb, t, uMix), 1.0);
}`;
export const LENS_STREAK_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tSrc; uniform vec2 uDir; uniform float uThreshold;
${EXPOSURE_GLSL}
void main(){
  float thr = uThreshold / max(slExposure(), 0.2);
  vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = -7; i <= 7; i++) {
    float x = float(i); float w = exp(-x * x / 18.0);
    vec3 c = texture2D(tSrc, vUv + uDir * x).rgb;
    c = max(c - vec3(thr), vec3(0.0));
    acc += c * w; ws += w;
  }
  gl_FragColor = vec4(acc / ws, 1.0);
}`;
export const EXPOSURE_ADAPT_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tPrev, tLum, tDepth; uniform vec2 uSunUv; uniform float uSunOn, uRate, uVisRate, uAspect;
void main(){
  float ls = 0.0, ws = 0.0;
  for (int y = 0; y < 5; y++) for (int x = 0; x < 7; x++) {
    vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(7.0, 5.0);
    vec2 c = uv - 0.5;
    float w = 1.0 - 0.75 * smoothstep(0.1, 0.55, length(c));       // centre-weighted metering
    float l = luma(texture2D(tLum, uv).rgb);
    ls += log(max(l, 1e-4)) * w; ws += w;
  }
  float avg = clamp(exp(ls / ws), 0.002, 40.0);
  float vis = 0.0;
  for (int i = 0; i < 12; i++) {
    float r = sqrt((float(i) + 0.5) / 12.0) * 0.011; float th = float(i) * 2.39996323;
    vec2 uv = uSunUv + vec2(cos(th) / uAspect, sin(th)) * r;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) vis += 1.0;
    else vis += step(0.99999, texture2D(tDepth, uv).r);
  }
  vis = vis / 12.0 * uSunOn;
  vec4 prev = texture2D(tPrev, vec2(0.5));
  float a = mix(prev.r, avg, uRate);
  if (!(a > 0.0) || a > 1e4) a = avg;                                 // NaN / first-frame guard
  float v = mix(prev.g, vis, uVisRate);
  if (!(v >= 0.0)) v = vis;
  gl_FragColor = vec4(a, v, 0.0, 1.0);
}`;
export const LENS_DIRT_FRAG = `${POST_COMMON_GLSL}
${NOISE_GLSL}
uniform float uAspect;
void main(){
  vec2 p = vUv * vec2(uAspect, 1.0);
  float acc = 0.0;
  for (int i = 0; i < 70; i++) {
    float fi = float(i);
    vec2 c = vec2(hash12(vec2(fi, 1.7)), hash12(vec2(fi, 9.2))) * vec2(uAspect, 1.0);
    float sz = mix(0.012, 0.085, pow(hash12(vec2(fi, 4.4)), 3.0));
    float r = length(p - c) / sz;
    float disc = smoothstep(1.0, 0.86, r) * (0.35 + 0.65 * smoothstep(0.35, 0.98, r));
    acc += disc * mix(0.15, 0.7, hash12(vec2(fi, 6.1)));
  }
  float smudge = fbm5(vUv * vec2(5.0, 9.0) + 3.0) * fbm3(vUv * 2.3 + 9.0);
  float streaks = pow(n2(vec2(vUv.x * 90.0, vUv.y * 2.0)), 4.0) * 0.25;
  float v = acc * 0.55 + smudge * 0.9 + streaks;
  v *= 0.45 + 0.9 * smoothstep(0.15, 0.75, length(vUv - 0.5));
  gl_FragColor = vec4(vec3(v) * vec3(1.0, 0.96, 0.9), 1.0);
}`;
export const GRADE_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tScene, tBloom, tBlur, tStreak, tDirt;
${EXPOSURE_GLSL}
uniform vec3 uSunCol;
uniform vec2 uSunUv;
uniform float uTime, uAspect, uBloom, uDirt, uStreak, uFlare, uCA, uVignette;
uniform float uDamage, uLowHealth, uAds, uFlash, uFade, uSaturation, uSunOn, uThunder, uAgxMix;

// ---- AgX (Filament/Blender fit, as in three.js) ----
const mat3 SL_REC2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 SL_SRGB_TO_REC2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
vec3 slAgxContrast(vec3 x){ vec3 x2 = x * x; vec3 x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
vec3 slAgx(vec3 color){
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float minEv = -12.47393, maxEv = 4.026069;
  color = inset * (SL_SRGB_TO_REC2020 * color);
  color = clamp((log2(max(color, 1e-10)) - minEv) / (maxEv - minEv), 0.0, 1.0);
  color = slAgxContrast(color);
  // "punchy"-style look: a little more contrast and chroma than the base AgX rendering
  float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = pow(max(color, vec3(0.0)), vec3(LOOK_POWER));
  color = l + (color - l) * LOOK_SAT;
  color = outset * color;
  color = pow(max(color, vec3(0.0)), vec3(2.2));
  return clamp(SL_REC2020_TO_SRGB * color, 0.0, 1.0);
}
vec3 slRRTODT(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 slAces(vec3 c){
  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  return clamp(outM * slRRTODT(inM * (c * 1.3)), 0.0, 1.0);
}
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }

vec3 flare(vec2 uv, vec2 sun, float vis){
  vec2 asp = vec2(uAspect, 1.0);
  vec2 p = (uv - 0.5) * asp, s = (sun - 0.5) * asp;
  vec2 dv = p - s; float r = length(dv);
  vec3 c = vec3(0.0);
  // veiling glare + a few soft diffraction spikes
  float ang = atan(dv.y, dv.x);
  float spikes = pow(abs(cos(ang * 3.0 + 0.4)), 24.0) + 0.6 * pow(abs(cos(ang * 4.0 - 1.1)), 40.0);
  c += uSunCol * (0.020 / (r * r * 9.0 + 0.010) + 0.10 * exp(-r * 3.2));
  c += uSunCol * spikes * 0.30 * exp(-r * 5.5);
  // ghosts along the sun -> centre axis
  vec3 g = vec3(0.0);
  float k0 = length(p + s * 0.38);  g += vec3(0.30, 0.75, 0.55) * smoothstep(0.085, 0.06, k0) * 0.050;
  float k1 = length(p + s * 0.82);  g += vec3(0.85, 0.45, 0.25) * smoothstep(0.045, 0.030, k1) * 0.075;
  float k2 = length(p + s * 1.35);  g += vec3(0.35, 0.50, 0.95) * smoothstep(0.17, 0.12, k2) * (0.4 + 0.6 * smoothstep(0.05, 0.16, k2)) * 0.040;
  float k3 = length(p - s * 0.45);  g += vec3(0.80, 0.70, 0.35) * smoothstep(0.030, 0.018, k3) * 0.060;
  // halo ring opposite the sun
  float hr = length(p + s * 0.15);
  g += vec3(0.45, 0.55, 0.85) * exp(-pow((hr - 0.52) * 16.0, 2.0)) * 0.035 * smoothstep(0.1, 0.5, length(s));
  c += g * uSunCol * 2.4;
  return c * vis;
}

void main(){
  vec2 c = vUv - 0.5;
  float r2 = dot(c * vec2(uAspect, 1.0), c * vec2(uAspect, 1.0)) / (0.25 * (uAspect * uAspect + 1.0));   // 0 centre .. 1 corner
  vec4 ad = texture2D(tAdapt, vec2(0.5));
  // radial chromatic aberration (tiny; grows a little when hurt)
  vec2 off = c * r2 * (uCA + uDamage * 0.006);
  vec3 col = vec3(texture2D(tScene, vUv + off).r, texture2D(tScene, vUv).g, texture2D(tScene, vUv - off).b);
  // ADS: soften the periphery
  vec3 soft = texture2D(tBlur, vUv).rgb;
  col = mix(col, soft, uAds * 0.75 * smoothstep(0.22, 0.85, r2));
  // bloom (energy conserving mix), lens dirt, anamorphic streak
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  vec3 dirt = texture2D(tDirt, vUv).rgb;
  col = mix(col, bloom, uBloom);
  col += bloom * dirt * uDirt;
  col += texture2D(tStreak, vUv).rgb * vec3(0.45, 0.62, 1.0) * uStreak;
  // sun glare + flare (occlusion-tested)
  float vis = ad.g * uSunOn;
  if (vis > 0.002) { vec3 fl = flare(vUv, uSunUv, vis) * uFlare; col += fl * (1.0 + dirt * 1.5); }
  // exposure: manual * eye adaptation
  col *= slExposure();
  col += vec3(1.0, 0.97, 0.9) * uFlash * 2.5;
  // filmic curve: ACES (Hill fit) for punch and burning oranges, pulled toward AgX so highlights roll off to white
  col = mix(slAces(col), slAgx(col), uAgxMix);

  // ---- grade (display-linear) ----
  float l = luma(col);
  // split tone: teal shadows, warm highlights
  vec3 sh = vec3(0.80, 1.01, 1.13), hi = vec3(1.07, 1.0, 0.90);
  col *= mix(sh, hi, smoothstep(0.03, 0.55, l));
  // gentle S-curve
  col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);
  // lifted, slightly teal blacks
  col = col * 0.988 + vec3(0.006, 0.0085, 0.011);
  // saturation (gameplay driven)
  float sat = uSaturation * (1.0 - 0.65 * uLowHealth) * (1.0 - 0.5 * uDamage);
  l = luma(col);
  col = mix(vec3(l), col, sat);
  // vignette: base + low health + ADS tightening
  float vig = uVignette + uLowHealth * 0.55 + uAds * 0.22;
  float vr = smoothstep(0.15 - uAds * 0.08, 1.05, r2);
  col *= 1.0 - vig * vr * vr * (3.0 - 2.0 * vr) ;
  // damage: red-edged pulse
  float edge = smoothstep(0.18, 1.0, r2);
  col = mix(col, vec3(0.55, 0.02, 0.01) * (0.35 + l), clamp(uDamage * edge * 0.85 + uLowHealth * edge * edge * 0.25 * (0.75 + 0.25 * sin(uTime * 5.0)), 0.0, 1.0));
  col *= 1.0 - uFade;
  col = toSRGB(clamp(col, 0.0, 1.0));
  gl_FragColor = vec4(col, dot(col, vec3(0.299, 0.587, 0.114)));
}`;
export const FINAL_FXAA_FRAG = `${POST_COMMON_GLSL}
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uTime, uGrain, uSharpen, uFxaa;
void main(){
  vec4 M = texture2D(tSrc, vUv);
  vec3 col = M.rgb;
  vec4 NW = texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel), NE = texture2D(tSrc, vUv + vec2(1.0, -1.0) * uTexel);
  vec4 SW = texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel), SE = texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel);
  float lMin = min(M.a, min(min(NW.a, NE.a), min(SW.a, SE.a)));
  float lMax = max(M.a, max(max(NW.a, NE.a), max(SW.a, SE.a)));
  float contrast = lMax - lMin;
  if (uFxaa > 0.5 && contrast > max(0.0312, lMax * 0.10)) {
    vec2 dir = vec2(-((NW.a + NE.a) - (SW.a + SE.a)), (NW.a + SW.a) - (NE.a + SE.a));
    float dirReduce = max((NW.a + NE.a + SW.a + SE.a) * 0.03125, 0.0078125);
    float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
    vec4 A = 0.5 * (texture2D(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)) + texture2D(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)));
    vec4 B = A * 0.5 + 0.25 * (texture2D(tSrc, vUv - dir * 0.5) + texture2D(tSrc, vUv + dir * 0.5));
    col = (B.a < lMin || B.a > lMax) ? A.rgb : B.rgb;
  }
  // light unsharp mask, backed off on strong edges (those belong to FXAA)
  vec3 blur = (NW.rgb + NE.rgb + SW.rgb + SE.rgb) * 0.25;
  col += (M.rgb - blur) * uSharpen * (1.0 - smoothstep(0.04, 0.22, contrast));
  // animated, luminance-weighted film grain
  vec2 seed = gl_FragCoord.xy + fract(uTime * vec2(7.31, 3.17)) * vec2(311.7, 173.3);
  float g = hash12(seed) + hash12(seed + 57.3) - 1.0;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col += g * uGrain * mix(1.0, 0.30, smoothstep(0.25, 0.9, l)) * (0.35 + 0.65 * smoothstep(0.0, 0.08, l));
  // dither against banding in the sky gradients
  col += (hash12(gl_FragCoord.xy * 1.37 + 11.0) + hash12(gl_FragCoord.xy * 0.71 + 3.0) - 1.0) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

/** Gameplay-driven screen effects, all 0..1 except `saturation` (1 = neutral). Lives on `render.post`. */
export interface PostEffectState {
  damage: number;
  lowHealth: number;
  ads: number;
  flash: number;
  fade: number;
  saturation: number;
  focusDist: number;
  shake: number;
  wet: number;
}

/** Art-direction constants of the post chain (exposed as `render.tune`). */
export interface PostTune {
  volSunScale: number;
  volAmbient: number;
  volSigma: number;
  volMaxDist: number;
  volFarHaze: number;
  volInteriorDust: number;
  aoRadius: number;
  aoIntensity: number;
  aoStrength: number;
  bloom: number;
  bloomMix: number;
  dirt: number;
  streak: number;
  streakThreshold: number;
  flare: number;
  key: number;
  minExposure: number;
  maxExposure: number;
  adaptTau: number;
  agxMix: number;
  ca: number;
  vignette: number;
  grain: number;
  sharpen: number;
  lookPower: number;
  lookSat: number;
}

/** All render targets owned by the post chain. */
export interface PostTargets {
  scene: WebGLRenderTarget;
  motion: WebGLRenderTarget;
  ldr: WebGLRenderTarget;
  depthHalf: WebGLRenderTarget;
  aoA: WebGLRenderTarget;
  aoB: WebGLRenderTarget;
  volA: WebGLRenderTarget;
  volB: WebGLRenderTarget;
  down: WebGLRenderTarget[];
  up: WebGLRenderTarget[];
  streakA: WebGLRenderTarget;
  streakB: WebGLRenderTarget;
  /** Ping-pong 1x1 targets: r = adapted luminance, g = sun visibility. */
  adapt: WebGLRenderTarget[];
  dirt: WebGLRenderTarget;
  /** Lazily created copy of the scene depth (see `ensureDepthCopy`). */
  depthCopy: WebGLRenderTarget | null;
}

/** Full-res and half-res sizes of the chain. */
export interface PostSize {
  w: number;
  h: number;
  hw: number;
  hh: number;
}

/** Per-frame inputs of `PostPipeline.run`. */
export interface PostRunParams {
  /** The HDR scene target (with depth texture) just rendered. */
  hdr: WebGLRenderTarget;
  camera: Camera & { near: number; far: number };
  sun: DirectionalLight;
  dt: number;
  post: PostEffectState;
  exposure: number;
  time: number;
  /** Snap adaptation (screenshots / showcases). */
  fast: boolean;
  /** Current lightning flash strength. */
  thunder: number;
}

/** Debug readback of the eye-adaptation state. */
export interface AdaptReadout {
  lum: number;
  auto: number;
  sunVis: number;
}

/** The post-processing pipeline returned by `createPostPipeline`. */
export interface PostPipeline {
  readAdapt(): AdaptReadout | null;
  run(params: PostRunParams): void;
  resize(width: number, height: number): void;
  copyDepth(depth: Texture | null): void;
  ensureDepthCopy(): DepthTexture;
  applyQuality(): void;
  dispose(): void;
  materials: ShaderMaterial[];
  rt: PostTargets;
  size: PostSize;
  TUNE: PostTune;
  autoExposure: boolean;
  /** Draws `material` as a fullscreen triangle into `target` (null = screen). */
  pass(material: ShaderMaterial, target: WebGLRenderTarget | null): void;
  quad: Mesh;
  fsCam: OrthographicCamera;
}

/** Number of bloom mip levels. */
const BLOOM_LEVELS = 6;

/** Builds the post chain for `renderer`; render targets start at 4x4 until `resize`. */
export function createPostPipeline(
  renderer: WebGLRenderer,
  game: Game,
  { noiseTex }: { noiseTex: Texture }
): PostPipeline {
  const quadGeometry = new BufferGeometry();
  quadGeometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
  );
  quadGeometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  // the material is assigned per pass
  const quad = new Mesh(quadGeometry, null as unknown as ShaderMaterial);
  quad.frustumCulled = false;
  const fsCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const materials: ShaderMaterial[] = [];
  const makePass = (
    name: string,
    fragment: string,
    uniforms: Record<string, IUniform>,
    extra: ShaderMaterialParameters = {}
  ): ShaderMaterial => {
    const material = new ShaderMaterial({
      name: 'post-' + name,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: `${POST_SHADER_TAG} ${name}
${fragment}`,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      toneMapped: false,
      ...extra
    });
    materials.push(material);
    return material;
  };
  function pass(material: ShaderMaterial, target: WebGLRenderTarget | null): void {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quad, fsCam);
  }
  const hdrType = HalfFloatType;
  const ldrType = UnsignedByteType;
  const linear = LinearFilter;
  const nearest = NearestFilter;
  const makeTarget = (
    type: TextureDataType = hdrType,
    filter: MagnificationTextureFilter = linear,
    extra: RenderTargetOptions = {}
  ) => {
    const target = new WebGLRenderTarget(4, 4, {
      type,
      format: RGBAFormat,
      minFilter: filter,
      magFilter: filter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      ...extra
    });
    target.texture.generateMipmaps = false;
    return target;
  };
  const quality = () => game.quality;
  const skyUniforms = () => ({
    uSunDir: {
      value: SUN.dir.clone()
    },
    uZen: {
      value: SKY_COLORS.zenith.clone()
    },
    uHor: {
      value: SKY_COLORS.horizon.clone()
    },
    uHorAway: {
      value: SKY_COLORS.horizonAway.clone()
    },
    uSunCol: {
      value: SUN.color.clone()
    }
  });
  const tune: PostTune = {
    volSunScale: 0.85,
    volAmbient: 0.2,
    volSigma: 0.0034,
    volMaxDist: 170,
    volFarHaze: 0.42,
    volInteriorDust: 6,
    aoRadius: 0.9,
    aoIntensity: 1.6,
    aoStrength: 0.95,
    bloom: 0.065,
    bloomMix: 0.62,
    dirt: 0.1,
    streak: 0.03,
    streakThreshold: 2.2,
    flare: 0.16,
    key: 0.12,
    minExposure: 0.6,
    maxExposure: 2,
    adaptTau: 1.5,
    agxMix: 0.25,
    ca: 0.0013,
    vignette: 0.3,
    grain: 0.02,
    sharpen: 0.3,
    lookPower: 1.18,
    lookSat: 1.22
  };
  let floatBuffers = false;
  try {
    floatBuffers = !!renderer.extensions.has('EXT_color_buffer_float');
  } catch {
    floatBuffers = false;
  }
  const rt: PostTargets = {
    scene: makeTarget(hdrType, linear),
    motion: makeTarget(hdrType, linear),
    ldr: makeTarget(ldrType, linear),
    depthHalf: floatBuffers
      ? makeTarget(FloatType, nearest, {
          format: RedFormat
        })
      : makeTarget(hdrType, nearest),
    aoA: makeTarget(ldrType, nearest),
    aoB: makeTarget(ldrType, nearest),
    volA: makeTarget(hdrType, nearest),
    volB: makeTarget(hdrType, nearest),
    down: [],
    up: [],
    streakA: makeTarget(hdrType, linear),
    streakB: makeTarget(hdrType, linear),
    adapt: [makeTarget(hdrType, nearest), makeTarget(hdrType, nearest)],
    dirt: makeTarget(ldrType, linear),
    depthCopy: null
  };
  for (let i = 0; i < BLOOM_LEVELS; i++) rt.down.push(makeTarget(hdrType, linear));
  for (let i = 0; i < BLOOM_LEVELS - 1; i++) rt.up.push(makeTarget(hdrType, linear));
  rt.adapt[0].setSize(1, 1);
  rt.adapt[1].setSize(1, 1);
  rt.dirt.setSize(512, 288);
  /** Which `rt.adapt` target holds the current adaptation state. */
  let adaptIndex = 0;
  let adaptFrames = 0;
  let dirtBaked = false;
  const size: PostSize = {
    w: 4,
    h: 4,
    hw: 2,
    hh: 2
  };
  /** Exposure uniforms, shared by reference between the passes that include EXPOSURE_GLSL. */
  const exposureUniforms: {
    tAdapt: IUniform<Texture | null>;
    uExposure: IUniform<number>;
    uKey: IUniform<number>;
    uMinE: IUniform<number>;
    uMaxE: IUniform<number>;
    uAuto: IUniform<number>;
  } = {
    tAdapt: {
      value: null
    },
    uExposure: {
      value: 1
    },
    uKey: {
      value: tune.key
    },
    uMinE: {
      value: tune.minExposure
    },
    uMaxE: {
      value: tune.maxExposure
    },
    uAuto: {
      value: 1
    }
  };
  const depthCopyMat = makePass(
    'depthcopy',
    DEPTH_COPY_FRAG,
    {
      tDepth: {
        value: null
      }
    },
    {
      depthTest: true,
      depthWrite: true,
      depthFunc: AlwaysDepth,
      colorWrite: false
    }
  );
  const depthHalfMat = makePass('depthhalf', DEPTH_HALF_FRAG, {
    tDepth: {
      value: null
    },
    uNear: {
      value: 0.08
    },
    uFar: {
      value: 900
    }
  });
  const aoMat = makePass(
    'ao',
    SSAO_FRAG,
    {
      tDepthHalf: {
        value: rt.depthHalf.texture
      },
      uTanHalf: {
        value: new Vector2()
      },
      uTexel: {
        value: new Vector2()
      },
      uRadius: {
        value: tune.aoRadius
      },
      uIntensity: {
        value: tune.aoIntensity
      },
      uAspect: {
        value: 1
      }
    },
    {
      defines: {
        AO_TAPS: 12
      }
    }
  );
  const volMat = makePass(
    'vol',
    VOLUMETRIC_FOG_FRAG,
    {
      tDepthHalf: {
        value: rt.depthHalf.texture
      },
      tShadow: {
        value: null
      },
      uShadowMatrix: {
        value: new Matrix4()
      },
      uCamWorld: {
        value: new Matrix4()
      },
      uCamPos: {
        value: new Vector3()
      },
      uSunRad: {
        value: new Vector3()
      },
      uAmb: {
        value: new Vector3()
      },
      uTanHalf: {
        value: new Vector2()
      },
      uHasShadow: {
        value: 0
      },
      uMaxDist: {
        value: tune.volMaxDist
      },
      uSigma: {
        value: tune.volSigma
      },
      uFarZ: {
        value: 900
      },
      uFarHaze: {
        value: tune.volFarHaze
      },
      uFlicker: {
        value: 0
      },
      uBoxDust: {
        value: 0
      },
      uBoxMin: {
        value: new Vector3(1e6, 1e6, 1e6)
      },
      uBoxMax: {
        value: new Vector3(-1e6, -1e6, -1e6)
      },
      ...skyUniforms()
    },
    {
      defines: {
        VOL_STEPS: 16
      }
    }
  );
  const aoBlurMat = makePass(
    'blur-ao',
    DEPTH_AWARE_BLUR_FRAG,
    {
      tSrc: {
        value: null
      },
      tDepthHalf: {
        value: rt.depthHalf.texture
      },
      uDir: {
        value: new Vector2()
      }
    },
    {
      defines: {
        BLUR_TOL: '0.04'
      }
    }
  );
  const volBlurMat = makePass(
    'blur-vol',
    DEPTH_AWARE_BLUR_FRAG,
    {
      tSrc: {
        value: null
      },
      tDepthHalf: {
        value: rt.depthHalf.texture
      },
      uDir: {
        value: new Vector2()
      }
    },
    {
      defines: {
        BLUR_TOL: '0.30'
      }
    }
  );
  const compositeMat = makePass('composite', AO_VOL_COMPOSITE_FRAG, {
    tColor: {
      value: null
    },
    tDepth: {
      value: null
    },
    tDepthHalf: {
      value: rt.depthHalf.texture
    },
    tAO: {
      value: rt.aoA.texture
    },
    tVol: {
      value: rt.volA.texture
    },
    uHalfRes: {
      value: new Vector2()
    },
    uNear: {
      value: 0.08
    },
    uFar: {
      value: 900
    },
    uAoOn: {
      value: 1
    },
    uVolOn: {
      value: 1
    },
    uAoStrength: {
      value: tune.aoStrength
    },
    ...exposureUniforms
  });
  const motionMat = makePass('motion', MOTION_BLUR_FRAG, {
    tColor: {
      value: rt.scene.texture
    },
    tDepth: {
      value: null
    },
    uInvViewProj: {
      value: new Matrix4()
    },
    uPrevViewProj: {
      value: new Matrix4()
    },
    uShutter: {
      value: 0.5
    },
    uRes: {
      value: new Vector2()
    }
  });
  const downMat = makePass('down', BLOOM_DOWNSAMPLE_FRAG, {
    tSrc: {
      value: null
    },
    uTexel: {
      value: new Vector2()
    },
    uFirst: {
      value: 0
    }
  });
  const upMat = makePass('up', BLOOM_UPSAMPLE_FRAG, {
    tLow: {
      value: null
    },
    tHigh: {
      value: null
    },
    uTexel: {
      value: new Vector2()
    },
    uMix: {
      value: tune.bloomMix
    }
  });
  const streakMat = makePass('streak', LENS_STREAK_FRAG, {
    tSrc: {
      value: null
    },
    uDir: {
      value: new Vector2()
    },
    uThreshold: {
      value: 0
    },
    ...exposureUniforms
  });
  const adaptMat = makePass('adapt', EXPOSURE_ADAPT_FRAG, {
    tPrev: {
      value: null
    },
    tLum: {
      value: null
    },
    tDepth: {
      value: null
    },
    uSunUv: {
      value: new Vector2(0.5, 0.5)
    },
    uSunOn: {
      value: 0
    },
    uRate: {
      value: 1
    },
    uVisRate: {
      value: 1
    },
    uAspect: {
      value: 1
    }
  });
  const dirtMat = makePass('dirt', LENS_DIRT_FRAG, {
    tNoise: {
      value: noiseTex
    },
    uAspect: {
      value: 16 / 9
    }
  });
  const gradeMat = makePass(
    'grade',
    GRADE_FRAG,
    {
      tScene: {
        value: null
      },
      tBloom: {
        value: rt.up[0].texture
      },
      tBlur: {
        value: rt.down[1].texture
      },
      tStreak: {
        value: rt.streakB.texture
      },
      tDirt: {
        value: rt.dirt.texture
      },
      ...exposureUniforms,
      uSunCol: {
        value: SUN.color.clone()
      },
      uSunUv: {
        value: new Vector2(0.5, 0.5)
      },
      uTime: {
        value: 0
      },
      uAspect: {
        value: 1
      },
      uBloom: {
        value: tune.bloom
      },
      uDirt: {
        value: tune.dirt
      },
      uStreak: {
        value: tune.streak
      },
      uFlare: {
        value: tune.flare
      },
      uCA: {
        value: tune.ca
      },
      uVignette: {
        value: tune.vignette
      },
      uDamage: {
        value: 0
      },
      uLowHealth: {
        value: 0
      },
      uAds: {
        value: 0
      },
      uFlash: {
        value: 0
      },
      uFade: {
        value: 0
      },
      uSaturation: {
        value: 1
      },
      uSunOn: {
        value: 0
      },
      uThunder: {
        value: 0
      },
      uAgxMix: {
        value: tune.agxMix
      }
    },
    {
      defines: {
        LOOK_POWER: tune.lookPower.toFixed(3),
        LOOK_SAT: tune.lookSat.toFixed(3)
      }
    }
  );
  const finalMat = makePass('final', FINAL_FXAA_FRAG, {
    tSrc: {
      value: rt.ldr.texture
    },
    uTexel: {
      value: new Vector2()
    },
    uTime: {
      value: 0
    },
    uGrain: {
      value: tune.grain
    },
    uSharpen: {
      value: tune.sharpen
    },
    uFxaa: {
      value: 1
    }
  });
  const viewProj = new Matrix4();
  const prevViewProj = new Matrix4();
  const invViewProj = new Matrix4();
  const sunNdc = new Vector3();
  const tmpVec = new Vector3();
  let hasPrevViewProj = false;

  /** Re-derives shader defines (fog steps, AO taps) from the current quality preset. */
  function applyQuality(): void {
    const volSteps = Math.max(6, quality().volSteps | 0);
    const aoTaps =
      quality().name === 'test' || quality().name === 'low'
        ? 8
        : quality().name === 'ultra'
          ? 16
          : 12;
    if (volMat.defines.VOL_STEPS !== volSteps) {
      volMat.defines.VOL_STEPS = volSteps;
      volMat.needsUpdate = true;
    }
    if (aoMat.defines.AO_TAPS !== aoTaps) {
      aoMat.defines.AO_TAPS = aoTaps;
      aoMat.needsUpdate = true;
    }
  }

  /** Resizes every target for a full-res buffer of `width` x `height` pixels. */
  function resize(width: number, height: number): void {
    width = Math.max(8, width | 0);
    height = Math.max(8, height | 0);
    size.w = width;
    size.h = height;
    size.hw = Math.max(4, Math.ceil(width / 2));
    size.hh = Math.max(4, Math.ceil(height / 2));
    rt.scene.setSize(width, height);
    rt.motion.setSize(width, height);
    rt.ldr.setSize(width, height);
    if (rt.depthCopy) {
      rt.depthCopy.setSize(width, height);
      const image = rt.depthCopy.depthTexture!.image;
      if (image.width !== width || image.height !== height) {
        image.width = width;
        image.height = height;
        rt.depthCopy.depthTexture!.needsUpdate = true;
      }
    }
    for (const target of [rt.depthHalf, rt.aoA, rt.aoB, rt.volA, rt.volB])
      target.setSize(size.hw, size.hh);
    let levelW = size.hw;
    let levelH = size.hh;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      rt.down[i].setSize(levelW, levelH);
      if (i < BLOOM_LEVELS - 1) rt.up[i].setSize(levelW, levelH);
      levelW = Math.max(2, levelW >> 1);
      levelH = Math.max(2, levelH >> 1);
    }
    rt.streakA.setSize(rt.down[2].width, rt.down[2].height);
    rt.streakB.setSize(rt.down[2].width, rt.down[2].height);
    hasPrevViewProj = false;
    applyQuality();
  }

  /** Creates (once) the depth-copy target and returns its depth texture. */
  function ensureDepthCopy(): DepthTexture {
    if (!rt.depthCopy) {
      const depthTexture = new DepthTexture(size.w, size.h);
      depthTexture.type = UnsignedIntType;
      depthTexture.minFilter = depthTexture.magFilter = nearest;
      rt.depthCopy = new WebGLRenderTarget(size.w, size.h, {
        type: ldrType,
        format: RGBAFormat,
        minFilter: nearest,
        magFilter: nearest,
        depthBuffer: true,
        stencilBuffer: false,
        depthTexture,
        generateMipmaps: false
      });
      renderer.setRenderTarget(rt.depthCopy);
      renderer.setClearColor(0, 1);
      renderer.clear(true, true, false);
      renderer.setRenderTarget(null);
    }
    return rt.depthCopy.depthTexture!;
  }

  /** Copies `depth` into the depth-copy target (if one was requested). */
  function copyDepth(depth: Texture | null): void {
    if (rt.depthCopy) {
      depthCopyMat.uniforms.tDepth.value = depth;
      pass(depthCopyMat, rt.depthCopy);
    }
  }

  /** Runs the whole chain from `hdr` to the screen. */
  function run({ hdr, camera, sun, dt, post, exposure, time, fast, thunder }: PostRunParams): void {
    const q = quality();
    const proj = camera.projectionMatrix.elements;
    const tanHalfX = 1 / proj[0];
    const tanHalfY = 1 / proj[5];
    const aspect = tanHalfX / tanHalfY;
    const sceneDepth = hdr.depthTexture;
    exposureUniforms.tAdapt.value = rt.adapt[adaptIndex].texture;
    exposureUniforms.uExposure.value = exposure;
    exposureUniforms.uAuto.value = pipeline.autoExposure ? 1 : 0;
    exposureUniforms.uKey.value = tune.key;
    exposureUniforms.uMinE.value = tune.minExposure;
    exposureUniforms.uMaxE.value = tune.maxExposure;
    if (!dirtBaked) {
      dirtMat.uniforms.uAspect.value = 16 / 9;
      pass(dirtMat, rt.dirt);
      dirtBaked = true;
    }
    depthHalfMat.uniforms.tDepth.value = sceneDepth;
    depthHalfMat.uniforms.uNear.value = camera.near;
    depthHalfMat.uniforms.uFar.value = camera.far;
    pass(depthHalfMat, rt.depthHalf);
    const halfTexelX = 1 / size.hw;
    const halfTexelY = 1 / size.hh;
    const aoOn = !!q.ao;
    if (aoOn) {
      aoMat.uniforms.uTanHalf.value.set(tanHalfX, tanHalfY);
      aoMat.uniforms.uTexel.value.set(halfTexelX, halfTexelY);
      aoMat.uniforms.uAspect.value = aspect;
      pass(aoMat, rt.aoA);
      aoBlurMat.uniforms.tSrc.value = rt.aoA.texture;
      aoBlurMat.uniforms.uDir.value.set(halfTexelX, 0);
      pass(aoBlurMat, rt.aoB);
      aoBlurMat.uniforms.tSrc.value = rt.aoB.texture;
      aoBlurMat.uniforms.uDir.value.set(0, halfTexelY);
      pass(aoBlurMat, rt.aoA);
    }
    const volOn = (q.volSteps | 0) > 0;
    if (volOn) {
      const u = volMat.uniforms;
      const box = game.level && game.level.interiorBoxes && game.level.interiorBoxes[0];
      if (box) {
        u.uBoxMin.value.copy(box.min);
        u.uBoxMax.value.copy(box.max);
        u.uBoxDust.value = tune.volInteriorDust;
      } else u.uBoxDust.value = 0;
      const shadowTexture = sun.shadow && sun.shadow.map ? sun.shadow.map.texture : null;
      u.tShadow.value = shadowTexture;
      u.uHasShadow.value = shadowTexture ? 1 : 0;
      if (shadowTexture) u.uShadowMatrix.value.copy(sun.shadow.matrix);
      u.uCamWorld.value.copy(camera.matrixWorld);
      u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      u.uTanHalf.value.set(tanHalfX, tanHalfY);
      u.uFarZ.value = camera.far;
      const sunScale = sun.intensity * tune.volSunScale;
      u.uSunRad.value.set(sun.color.r * sunScale, sun.color.g * sunScale, sun.color.b * sunScale);
      const ambient = tune.volAmbient * (1 + thunder * 1.5);
      u.uAmb.value.set(
        SKY_COLORS.fog.r * ambient,
        SKY_COLORS.fog.g * ambient,
        SKY_COLORS.fog.b * ambient
      );
      pass(volMat, rt.volA);
      volBlurMat.uniforms.tSrc.value = rt.volA.texture;
      volBlurMat.uniforms.uDir.value.set(halfTexelX, 0);
      pass(volBlurMat, rt.volB);
      volBlurMat.uniforms.tSrc.value = rt.volB.texture;
      volBlurMat.uniforms.uDir.value.set(0, halfTexelY);
      pass(volBlurMat, rt.volA);
    }
    {
      const u = compositeMat.uniforms;
      u.tColor.value = hdr.texture;
      u.tDepth.value = sceneDepth;
      u.uHalfRes.value.set(size.hw, size.hh);
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      u.uAoOn.value = aoOn ? 1 : 0;
      u.uVolOn.value = volOn ? 1 : 0;
      pass(compositeMat, rt.scene);
    }
    let sceneColor = rt.scene.texture;
    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (q.motionBlur && hasPrevViewProj && dt > 0) {
      const u = motionMat.uniforms;
      u.tDepth.value = sceneDepth;
      u.uInvViewProj.value.copy(invViewProj.copy(viewProj).invert());
      u.uPrevViewProj.value.copy(prevViewProj);
      u.uShutter.value = Math.min(0.5, 1 / 190 / Math.max(dt, 0.001));
      u.uRes.value.set(size.w, size.h);
      pass(motionMat, rt.motion);
      sceneColor = rt.motion.texture;
    }
    prevViewProj.copy(viewProj);
    hasPrevViewProj = true;
    if (q.bloom) {
      let source = sceneColor;
      let sourceW = size.w;
      let sourceH = size.h;
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        downMat.uniforms.tSrc.value = source;
        downMat.uniforms.uTexel.value.set(1 / sourceW, 1 / sourceH);
        downMat.uniforms.uFirst.value = i === 0 ? 1 : 0;
        pass(downMat, rt.down[i]);
        source = rt.down[i].texture;
        sourceW = rt.down[i].width;
        sourceH = rt.down[i].height;
      }
      let low = rt.down[BLOOM_LEVELS - 1];
      for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
        upMat.uniforms.tLow.value = low.texture;
        upMat.uniforms.tHigh.value = rt.down[i].texture;
        upMat.uniforms.uTexel.value.set(1 / low.width, 1 / low.height);
        pass(upMat, rt.up[i]);
        low = rt.up[i];
      }
      const streakTexel = 1 / rt.streakA.width;
      streakMat.uniforms.tSrc.value = rt.down[2].texture;
      streakMat.uniforms.uDir.value.set(streakTexel * 1.5, 0);
      streakMat.uniforms.uThreshold.value = tune.streakThreshold;
      pass(streakMat, rt.streakA);
      streakMat.uniforms.tSrc.value = rt.streakA.texture;
      streakMat.uniforms.uDir.value.set(streakTexel * 5, 0);
      streakMat.uniforms.uThreshold.value = 0;
      pass(streakMat, rt.streakB);
    }
    // project a point far along the sun direction to find the sun on screen
    sunNdc
      .copy(SUN.dir)
      .multiplyScalar(500)
      .add(tmpVec.setFromMatrixPosition(camera.matrixWorld))
      .project(camera);
    camera.getWorldDirection(tmpVec);
    const facingSun = tmpVec.dot(SUN.dir) > 0.05;
    const sunEdge = Math.max(Math.abs(sunNdc.x), Math.abs(sunNdc.y));
    const sunOn = facingSun ? 1 - Math.min(1, Math.max(0, (sunEdge - 1) / 0.3)) : 0;
    const sunU = sunNdc.x * 0.5 + 0.5;
    const sunV = sunNdc.y * 0.5 + 0.5;
    {
      const u = adaptMat.uniforms;
      const current = rt.adapt[adaptIndex];
      const next = rt.adapt[1 - adaptIndex];
      u.tPrev.value = current.texture;
      u.tLum.value = q.bloom ? rt.down[BLOOM_LEVELS - 1].texture : sceneColor;
      u.tDepth.value = sceneDepth;
      u.uSunUv.value.set(sunU, sunV);
      u.uSunOn.value = sunOn;
      u.uAspect.value = aspect;
      const snap = adaptFrames < 2 || fast;
      u.uRate.value = snap ? (adaptFrames < 2 ? 1 : 0.6) : 1 - Math.exp(-dt / tune.adaptTau);
      u.uVisRate.value = snap ? 1 : 1 - Math.exp(-dt / 0.12);
      pass(adaptMat, next);
      adaptIndex = 1 - adaptIndex;
      adaptFrames++;
    }
    {
      const u = gradeMat.uniforms;
      u.tScene.value = sceneColor;
      exposureUniforms.tAdapt.value = rt.adapt[adaptIndex].texture;
      u.uSunUv.value.set(sunU, sunV);
      u.uSunOn.value = sunOn;
      u.uAspect.value = aspect;
      u.uTime.value = time;
      u.uBloom.value = q.bloom ? tune.bloom : 0;
      u.uDirt.value = q.bloom ? tune.dirt : 0;
      u.uStreak.value = q.bloom ? tune.streak : 0;
      u.uFlare.value = tune.flare;
      u.uAgxMix.value = tune.agxMix;
      u.uCA.value = tune.ca;
      u.uVignette.value = tune.vignette;
      u.uDamage.value = saturate01(post.damage);
      u.uLowHealth.value = saturate01(post.lowHealth);
      u.uAds.value = saturate01(post.ads);
      u.uFlash.value = saturate01(post.flash);
      u.uFade.value = saturate01(post.fade);
      u.uSaturation.value = Number.isFinite(post.saturation) ? post.saturation : 1;
      pass(gradeMat, rt.ldr);
    }
    {
      const u = finalMat.uniforms;
      u.uTexel.value.set(1 / size.w, 1 / size.h);
      u.uTime.value = time;
      u.uGrain.value = tune.grain;
      u.uSharpen.value = tune.sharpen;
      pass(finalMat, null);
    }
  }
  /** Clamps to [0, 1]; NaN becomes 0. */
  const saturate01 = (value: number) => (value > 0 ? (value < 1 ? value : 1) : 0);

  function dispose(): void {
    for (const material of materials) material.dispose();
    const targets = [
      rt.scene,
      rt.motion,
      rt.ldr,
      rt.depthHalf,
      rt.aoA,
      rt.aoB,
      rt.volA,
      rt.volB,
      rt.streakA,
      rt.streakB,
      rt.dirt,
      ...rt.down,
      ...rt.up,
      ...rt.adapt
    ];
    if (rt.depthCopy) targets.push(rt.depthCopy);
    for (const target of targets) target.dispose();
  }

  const adaptPixel = new Uint16Array(4);
  /** Reads back the adapted luminance / auto exposure / sun visibility (debug; stalls the GPU). */
  function readAdapt(): AdaptReadout | null {
    try {
      renderer.readRenderTargetPixels(rt.adapt[adaptIndex], 0, 0, 1, 1, adaptPixel);
      const luminance = DataUtils.fromHalfFloat(adaptPixel[0]);
      const autoExposure = Math.min(
        tune.maxExposure,
        Math.max(tune.minExposure, Math.pow(tune.key / Math.max(luminance, 1e-4), 0.85))
      );
      return {
        lum: +luminance.toFixed(4),
        auto: +autoExposure.toFixed(3),
        sunVis: +DataUtils.fromHalfFloat(adaptPixel[1]).toFixed(2)
      };
    } catch {
      return null;
    }
  }

  const pipeline: PostPipeline = {
    readAdapt,
    run,
    resize,
    copyDepth,
    ensureDepthCopy,
    applyQuality,
    dispose,
    materials,
    rt,
    size,
    TUNE: tune,
    autoExposure: true,
    pass,
    quad,
    fsCam
  };
  return pipeline;
}
