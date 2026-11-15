/**
 * Shared GLSL snippets (value noise / fBm over a noise texture, sky horizon colour)
 * and the 256x256 RGBA noise texture they sample.
 */
import {
  DataTexture,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType
} from 'three';

/** GLSL: `tNoise` uniform plus `n2` value noise and `fbm5` / `fbm3` fractal noise. */
export const NOISE_GLSL = `
uniform sampler2D tNoise;
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return texture2D(tNoise, (i + f + 0.5) / 256.0).r; }
float fbm5(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a * n2(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3; a *= 0.5; } return s / 0.96875; }
float fbm3(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 3; i++){ s += a * n2(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 17.3; a *= 0.5; } return s / 0.875; }
`;
/** GLSL: sky uniforms plus `skyToSun()` and `horizonColor()` used by the sky and the fog. */
export const SKY_HORIZON_GLSL = `
uniform vec3 uSunDir, uZen, uHor, uHorAway, uSunCol;
float skyToSun(vec3 d){ return clamp(dot(normalize(d.xz + vec2(1e-5)), normalize(uSunDir.xz)) * 0.5 + 0.5, 0.0, 1.0); }
vec3 horizonColor(vec3 d){
  float ts = skyToSun(d);
  vec3 c = mix(uHorAway, uHorAway * 1.25 + vec3(0.05, 0.03, 0.02), smoothstep(0.2, 0.75, ts));
  c = mix(c, uHor * vec3(1.9, 1.55, 1.2), pow(ts, 6.0));
  c = mix(c, vec3(1.0, 0.60, 0.24) * 3.4, pow(ts, 34.0));
  return c;
}
`;
/** Builds the tiling 256x256 RGBA noise texture (deterministic xorshift32 values). */
export function createNoiseTexture(): DataTexture {
  const data = new Uint8Array(262144);
  let state = 2654435769;
  const next = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  for (let i = 0; i < 256 * 256; i++) {
    data[i * 4] = next() * 256;
    data[i * 4 + 1] = next() * 256;
    data[i * 4 + 2] = next() * 256;
    data[i * 4 + 3] = 255;
  }
  const texture = new DataTexture(data, 256, 256, RGBAFormat, UnsignedByteType);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
