// GPU particle rendering and CPU-side effect pools: instanced sprite batches (lit smoke /
// additive glow with soft-particle depth fade), the particle simulation pool, bullet tracers,
// debris chunks, ejected shell casings and surface decals.
import {
  AddEquation,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Quaternion,
  ShaderMaterial,
  Vector2,
  Vector3,
  ZeroFactor
} from 'three';
import type { IUniform, Material, PerspectiveCamera, Texture } from 'three';
import type { Game } from '../core/types';
import { DECAL_ATLAS_TILES, createDecalAtlas } from './atlases';
import type { AtlasUvRect, DecalAtlas, DecalKind } from './atlases';

const PARTICLE_VERT = `
attribute vec4 aPos;    // xyz centre, w size (m)
attribute vec4 aAxis;   // mode 1: stretch axis (length = streak length); mode 2: plane normal; w = roll (rad)
attribute vec4 aCol;    // rgb (HDR), a
attribute vec4 aMisc;   // x atlas frame, y mode (0 billboard, 1 velocity-stretched, 2 surface-aligned), z age 0..1, w sun visibility
uniform vec2 uAtlas;
uniform float uPx;      // world size of one pixel at distance 1
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vOff;
varying vec3 vToCam;
varying vec3 vInfo;     // view z, age, shade
varying float vSoftD;
varying vec3 vT;
varying vec3 vB;
void main() {
  vec2 c = position.xy;
  vec3 center = aPos.xyz; float size = aPos.w; float mode = aMisc.y;
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 toCam = cameraPosition - center; float dist = length(toCam); toCam /= max(dist, 1e-4);
  float sn = sin(aAxis.w), cs = cos(aAxis.w);
  vec2 rc = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
  vec3 off; float comp = 1.0;
  if (mode < 0.5) {
    off = (camR * rc.x + camU * rc.y) * size;
    vT = camR * cs + camU * sn; vB = camU * cs - camR * sn;
  } else if (mode < 1.5) {
    float len = length(aAxis.xyz); vec3 d = aAxis.xyz / max(len, 1e-5);
    vec3 side = cross(d, toCam); float sl = length(side); side = sl > 1e-3 ? side / sl : camR;
    float w = max(size, dist * uPx * 1.4); comp = size / w;
    if (aMisc.w > 1.5) w = min(w, dist * uPx * aMisc.w);       // additive only: cap on-screen width (tracers near the lens)
    off = d * (c.x * max(len, w)) + side * (c.y * w);
    vT = d; vB = side;
  } else {
    vec3 n = normalize(aAxis.xyz);
    vec3 t = normalize(abs(n.y) > 0.9 ? cross(n, vec3(1.0, 0.0, 0.0)) : cross(vec3(0.0, 1.0, 0.0), n));
    vec3 b = cross(n, t);
    off = (t * rc.x + b * rc.y) * size;
    vT = t * cs + b * sn; vB = b * cs - t * sn;
  }
  vec4 mv = viewMatrix * vec4(center + off, 1.0);
  gl_Position = projectionMatrix * mv;
  float f = floor(aMisc.x + 0.5);
  float col = mod(f, uAtlas.x), row = floor(f / uAtlas.x);
  vUv = (vec2(col, row) + c + 0.5) / uAtlas;
  vCol = vec4(aCol.rgb * comp, aCol.a);
  vOff = off / max(size, 1e-4);
  vToCam = toCam;
  vInfo = vec3(mv.z, aMisc.z, aMisc.w);
  vSoftD = clamp(size * 0.4, 0.04, 0.7);
}`;
const particleFragCommonGlsl = `
uniform sampler2D uTex;
uniform sampler2D uDepth;
uniform vec2 uRes;
uniform vec2 uNearFar;
uniform float uSoft;
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vOff;
varying vec3 vToCam;
varying vec3 vInfo;
varying float vSoftD;
varying vec3 vT;
varying vec3 vB;
float softFade() {
  float s = 1.0;
  if (uSoft > 0.5) {
    float d = texture2D(uDepth, gl_FragCoord.xy / uRes).x;
    float zs = (uNearFar.x * uNearFar.y) / ((uNearFar.y - uNearFar.x) * d - uNearFar.y);
    s = clamp((vInfo.x - zs) / vSoftD, 0.0, 1.0);
  }
  return s;
}`;
const LIT_PARTICLE_FRAG =
  particleFragCommonGlsl +
  `
uniform vec3 uSun, uSunDir, uAmbLo, uAmbHi;
void main() {
  vec4 t = texture2D(uTex, vUv);
  float er = vInfo.y * 0.45;                                  // wisps erode as the puff ages
  float a = smoothstep(er, er + (vInfo.z > 1.5 ? 0.38 : 0.6), t.a) * vCol.a;   // fire lobes: denser body, crisper edge
  a *= softFade() * smoothstep(0.2, 0.9, -vInfo.x);           // soft intersection + fade right at the lens
  if (a < 0.004) discard;
  vec3 V = normalize(vToCam);
  vec3 q = vOff * 2.0; float r2 = min(dot(q, q), 1.0);
  vec3 Ns = q + V * (sqrt(1.0 - r2) * 0.9 + 0.05);            // overall sphere normal
  vec2 tn = t.rg * 2.0 - 1.0;                                 // billow normal from the flipbook
  vec3 Nb = vT * tn.x + vB * tn.y + V * sqrt(max(1.0 - dot(tn, tn), 0.0));
  vec3 N = normalize(Ns * 0.55 + Nb);
  float wrap = clamp((dot(N, uSunDir) + 0.45) / 1.45, 0.0, 1.0);
  float back = pow(clamp(dot(-V, uSunDir), 0.0, 1.0), 5.0);   // looking into the sun: forward scatter through thin edges
  float thin = 1.0 - t.b * smoothstep(0.0, 0.5, a);
  float hot = step(1.5, vInfo.z), shade = vInfo.z - 2.0 * hot;      // aMisc.w >= 2: emissive fire lobe (colour = emission)
  vec3 sun = uSun * (wrap * wrap * 0.85 + back * (0.15 + 1.3 * thin)) * shade;
  vec3 amb = mix(uAmbLo, uAmbHi, N.y * 0.5 + 0.5) * (1.0 - 0.35 * t.b);
  vec3 col = vCol.rgb * (amb + sun);
  if (hot > 0.5) {
    // alpha-blended fire: hot dense cores, dim orange skin, soot underneath. Because it is NOT additive, overlapping lobes
    // keep their shape and smoke in front can occlude them.
    float lump = clamp(dot(tn, vec2(0.6, 0.8)) * 0.6 + 0.5, 0.0, 1.0);
    float core = t.b * t.b * smoothstep(0.15, 0.9, t.a);
    vec3 fire = vCol.rgb * (0.10 + 1.7 * core) * (0.45 + 1.1 * lump);
    col = vec3(0.045, 0.042, 0.04) * (amb + sun) + fire;
  }
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;                         // premultiply after the (possibly no-op) output transform
}`;
const ADDITIVE_PARTICLE_FRAG =
  particleFragCommonGlsl +
  `
void main() {
  float t = texture2D(uTex, vUv).r;
  float k = t * vCol.a * softFade();
  if (k < 0.002) discard;
  gl_FragColor = vec4(vCol.rgb * k, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const tmpDrawingBufferSize = new Vector2();

/** Per-batch construction options. The sun/ambient vectors are only used when `lit` is true. */
export interface ParticleBatchOptions {
  lit: boolean;
  tex: Texture;
  cols: number;
  rows: number;
  renderOrder: number;
  sun?: Vector3;
  sunDir?: Vector3;
  ambLo?: Vector3;
  ambHi?: Vector3;
}

type ParticleUniforms = Record<string, IUniform> & {
  uTex: IUniform<Texture>;
  uAtlas: IUniform<Vector2>;
  uPx: IUniform<number>;
  uDepth: IUniform<Texture | null>;
  uRes: IUniform<Vector2>;
  uNearFar: IUniform<Vector2>;
  uSoft: IUniform<number>;
};

/**
 * One instanced draw call of camera-facing sprites. Fill it each frame with
 * `begin()`, `push(...)` per sprite, then `end()` to upload.
 */
export interface ParticleBatch {
  mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  /** Maximum instance count. */
  cap: number;
  /** Instances pushed since `begin()`. */
  n: number;
  /** Raw `aPos` / `aAxis` / `aCol` / `aMisc` instance arrays (4 floats per instance). */
  P: Float32Array;
  A: Float32Array;
  C: Float32Array;
  M: Float32Array;
  begin(): void;
  /**
   * Appends one sprite: centre + size, stretch axis / plane normal + roll, HDR rgb + alpha,
   * atlas frame, mode (0 billboard, 1 velocity-stretched, 2 surface-aligned), age 0..1, sun visibility.
   * Returns false when the batch is full.
   */
  push(
    x: number,
    y: number,
    z: number,
    size: number,
    axisX: number,
    axisY: number,
    axisZ: number,
    roll: number,
    r: number,
    g: number,
    b: number,
    a: number,
    frame: number,
    mode: number,
    age: number,
    shade: number
  ): boolean;
  end: () => void;
}

/** Creates a particle sprite batch (lit smoke or additive glow) with soft-particle depth fade. */
export function createParticleBatch(
  game: Game,
  capacity: number,
  { lit, tex, cols, rows, renderOrder, sun, sunDir, ambLo, ambHi }: ParticleBatchOptions
): ParticleBatch {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3
    )
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const addInstanceAttribute = (name: string): InstancedBufferAttribute => {
    const attribute = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    attribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute(name, attribute);
    return attribute;
  };
  const posAttr = addInstanceAttribute('aPos');
  const axisAttr = addInstanceAttribute('aAxis');
  const colorAttr = addInstanceAttribute('aCol');
  const miscAttr = addInstanceAttribute('aMisc');
  geometry.instanceCount = 0;
  const uniforms: ParticleUniforms = {
    uTex: {
      value: tex
    },
    uAtlas: {
      value: new Vector2(cols, rows)
    },
    uPx: {
      value: 0.001
    },
    uDepth: {
      value: null
    },
    uRes: {
      value: new Vector2(1, 1)
    },
    uNearFar: {
      value: new Vector2(0.08, 900)
    },
    uSoft: {
      value: 0
    }
  };
  if (lit) {
    Object.assign(uniforms, {
      uSun: {
        value: sun
      },
      uSunDir: {
        value: sunDir
      },
      uAmbLo: {
        value: ambLo
      },
      uAmbHi: {
        value: ambHi
      }
    });
  }
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: PARTICLE_VERT,
    fragmentShader: lit ? LIT_PARTICLE_FRAG : ADDITIVE_PARTICLE_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: DoubleSide,
    fog: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: lit ? OneMinusSrcAlphaFactor : OneFactor,
    blendSrcAlpha: ZeroFactor,
    blendDstAlpha: OneFactor
  });
  material.name = lit ? 'fx_lit' : 'fx_add';
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.name = material.name;
  mesh.onBeforeRender = (renderer, _scene, camera) => {
    const target = renderer.getRenderTarget();
    let targetHeight: number;
    if (target) {
      targetHeight = target.height;
    } else {
      renderer.getDrawingBufferSize(tmpDrawingBufferSize);
      targetHeight = tmpDrawingBufferSize.y;
    }
    const projection = camera.projectionMatrix.elements;
    uniforms.uPx.value = 2 / (Math.max(projection[5], 0.001) * Math.max(targetHeight, 1));
    const render = game.render;
    const depthTexture = render && render.depthTexture;
    if (
      depthTexture &&
      depthTexture.image &&
      camera === game.camera &&
      render.depthTextureIsLive !== true &&
      game.params.fxsoft !== '0'
    ) {
      uniforms.uDepth.value = depthTexture;
      uniforms.uSoft.value = 1;
      if (render.resolution && render.resolution.x > 0) {
        uniforms.uRes.value.set(render.resolution.x, render.resolution.y);
      } else {
        const image = depthTexture.image as { width?: number; height?: number };
        uniforms.uRes.value.set(image.width || 1, image.height || 1);
      }
      const perspective = camera as PerspectiveCamera;
      uniforms.uNearFar.value.set(perspective.near, perspective.far);
    } else {
      uniforms.uDepth.value = null;
      uniforms.uSoft.value = 0;
    }
  };
  const posArray = posAttr.array as Float32Array;
  const axisArray = axisAttr.array as Float32Array;
  const colorArray = colorAttr.array as Float32Array;
  const miscArray = miscAttr.array as Float32Array;
  const instanceAttributes = [posAttr, axisAttr, colorAttr, miscAttr];
  const batch: ParticleBatch = {
    mesh,
    cap: capacity,
    n: 0,
    P: posArray,
    A: axisArray,
    C: colorArray,
    M: miscArray,
    begin() {
      batch.n = 0;
    },
    push(x, y, z, size, axisX, axisY, axisZ, roll, r, g, b, a, frame, mode, age, shade) {
      const index = batch.n;
      if (index >= capacity) return false;
      const offset = index * 4;
      posArray[offset] = x;
      posArray[offset + 1] = y;
      posArray[offset + 2] = z;
      posArray[offset + 3] = size;
      axisArray[offset] = axisX;
      axisArray[offset + 1] = axisY;
      axisArray[offset + 2] = axisZ;
      axisArray[offset + 3] = roll;
      colorArray[offset] = r;
      colorArray[offset + 1] = g;
      colorArray[offset + 2] = b;
      colorArray[offset + 3] = a;
      miscArray[offset] = frame;
      miscArray[offset + 1] = mode;
      miscArray[offset + 2] = age;
      miscArray[offset + 3] = shade;
      batch.n = index + 1;
      return true;
    },
    end: () => {
      const count = batch.n;
      geometry.instanceCount = count;
      mesh.visible = count > 0;
      if (count) {
        for (let index = 0; index < 4; index++) {
          const attribute = instanceAttributes[index];
          attribute.clearUpdateRanges();
          attribute.addUpdateRange(0, count * 4);
          attribute.needsUpdate = true;
        }
      }
    }
  };
  return batch;
}

/** Particle bounces off its ground height. */
export const PARTICLE_FLAG_BOUNCE = 1;
/** Particle is killed when it reaches its ground height. */
export const PARTICLE_FLAG_DIE_ON_GROUND = 2;
/** Particle stops dead on its ground height. */
export const PARTICLE_FLAG_STICK = 4;

/** Minimal xyz vector shape accepted by the pools. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/**
 * Structure-of-arrays particle simulation. `emit` returns a slot index whose per-particle
 * fields (`drag`, `grav`, `r`, `frame`, `flags` ...) the caller then fills in directly.
 */
export class ParticlePool {
  cap: number;
  /** Sort back-to-front each update (needed for alpha-blended smoke). */
  sorted: boolean;
  /** Live particle count (length of the `order` prefix). */
  n: number;
  freeTop: number;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  age: Float32Array;
  life: Float32Array;
  /** Start / end size and size-curve exponent. */
  s0: Float32Array;
  s1: Float32Array;
  sk: Float32Array;
  rot: Float32Array;
  rotv: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
  drag: Float32Array;
  grav: Float32Array;
  wind: Float32Array;
  turb: Float32Array;
  seed: Float32Array;
  /** Fade-in end / fade-out start, as fractions of life. */
  fin: Float32Array;
  fout: Float32Array;
  stretch: Float32Array;
  shade: Float32Array;
  /** Sort key (squared camera distance). */
  key: Float32Array;
  /** Ground height for the bounce / stick / die flags. */
  gy: Float32Array;
  frame: Uint8Array;
  mode: Uint8Array;
  flags: Uint8Array;
  /** Color ramp: 0 none, 1 cooling ember, 2 fire, 3 flicker. */
  ramp: Uint8Array;
  order: Uint16Array;
  free: Uint16Array;

  constructor(capacity: number, sorted: boolean) {
    this.cap = capacity;
    this.sorted = sorted;
    this.n = 0;
    this.freeTop = capacity;
    const floats = (): Float32Array => new Float32Array(capacity);
    this.px = floats();
    this.py = floats();
    this.pz = floats();
    this.vx = floats();
    this.vy = floats();
    this.vz = floats();
    this.age = floats();
    this.life = floats();
    this.s0 = floats();
    this.s1 = floats();
    this.sk = floats();
    this.rot = floats();
    this.rotv = floats();
    this.r = floats();
    this.g = floats();
    this.b = floats();
    this.a = floats();
    this.drag = floats();
    this.grav = floats();
    this.wind = floats();
    this.turb = floats();
    this.seed = floats();
    this.fin = floats();
    this.fout = floats();
    this.stretch = floats();
    this.shade = floats();
    this.key = floats();
    this.gy = floats();
    this.frame = new Uint8Array(capacity);
    this.mode = new Uint8Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.ramp = new Uint8Array(capacity);
    this.order = new Uint16Array(capacity);
    this.free = new Uint16Array(capacity);
    for (let index = 0; index < capacity; index++) this.free[index] = capacity - 1 - index;
  }

  clear(): void {
    this.n = 0;
    this.freeTop = this.cap;
    for (let index = 0; index < this.cap; index++) this.free[index] = this.cap - 1 - index;
  }

  /** Spawns a particle with default fields; returns its slot or -1 when full. */
  emit(
    x: number,
    y: number,
    z: number,
    velX: number,
    velY: number,
    velZ: number,
    life: number,
    startSize: number,
    endSize: number
  ): number {
    if (this.freeTop === 0) return -1;
    const slot = this.free[--this.freeTop];
    this.order[this.n++] = slot;
    this.px[slot] = x;
    this.py[slot] = y;
    this.pz[slot] = z;
    this.vx[slot] = velX;
    this.vy[slot] = velY;
    this.vz[slot] = velZ;
    this.age[slot] = -1;
    this.life[slot] = life;
    this.s0[slot] = startSize;
    this.s1[slot] = endSize;
    this.sk[slot] = 2;
    this.rot[slot] = 0;
    this.rotv[slot] = 0;
    this.r[slot] = 1;
    this.g[slot] = 1;
    this.b[slot] = 1;
    this.a[slot] = 1;
    this.drag[slot] = 0;
    this.grav[slot] = 0;
    this.wind[slot] = 0;
    this.turb[slot] = 0;
    this.seed[slot] = Math.random() * 100;
    this.fin[slot] = 0;
    this.fout[slot] = 0.5;
    this.stretch[slot] = 0.02;
    this.shade[slot] = 1;
    this.key[slot] = 0;
    this.gy[slot] = 0;
    this.frame[slot] = 0;
    this.mode[slot] = 0;
    this.flags[slot] = 0;
    this.ramp[slot] = 0;
    return slot;
  }

  /** Integrates, culls dead particles, optionally depth-sorts, and pushes sprites into `batch`. */
  update(
    dt: number,
    batch: ParticleBatch,
    camPos: Vec3Like,
    windVel: Vec3Like,
    time: number
  ): void {
    const { px, py, pz, vx, vy, vz, age, life, order, flags } = this;
    const camX = camPos.x;
    const camY = camPos.y;
    const camZ = camPos.z;
    let alive = 0;
    const count = this.n;
    for (let index = 0; index < count; index++) {
      const slot = order[index];
      if (age[slot] < 0) age[slot] = 0;
      else {
        age[slot] += dt;
        if (age[slot] >= life[slot]) {
          this.free[this.freeTop++] = slot;
          continue;
        }
        const dragBlend = 1 - Math.exp(-this.drag[slot] * dt);
        const windAmount = this.wind[slot];
        vx[slot] += (windVel.x * windAmount - vx[slot]) * dragBlend;
        vy[slot] += (windVel.y * windAmount - vy[slot]) * dragBlend;
        vz[slot] += (windVel.z * windAmount - vz[slot]) * dragBlend;
        vy[slot] -= this.grav[slot] * dt;
        const turbulence = this.turb[slot];
        if (turbulence > 0) {
          const seed = this.seed[slot];
          vx[slot] += Math.sin(py[slot] * 2.3 + seed + time * 1.7) * turbulence * dt;
          vz[slot] += Math.cos(px[slot] * 1.9 + seed * 1.3 + time * 1.3) * turbulence * dt;
          vy[slot] += Math.sin(pz[slot] * 2.1 + seed * 0.7 + time * 2.1) * turbulence * 0.4 * dt;
        }
        px[slot] += vx[slot] * dt;
        py[slot] += vy[slot] * dt;
        pz[slot] += vz[slot] * dt;
        this.rot[slot] += this.rotv[slot] * dt;
        const particleFlags = flags[slot];
        const groundY = this.gy[slot] + 0.012;
        if (particleFlags && py[slot] < groundY) {
          if (particleFlags & PARTICLE_FLAG_DIE_ON_GROUND) {
            this.free[this.freeTop++] = slot;
            continue;
          }
          if (particleFlags & PARTICLE_FLAG_BOUNCE) {
            py[slot] = groundY;
            if (vy[slot] < 0) {
              vy[slot] = -vy[slot] * (0.25 + (this.seed[slot] % 1) * 0.3);
              vx[slot] *= 0.65;
              vz[slot] *= 0.65;
            }
          } else if (particleFlags & PARTICLE_FLAG_STICK) {
            py[slot] = groundY;
            vx[slot] = vy[slot] = vz[slot] = 0;
          }
        }
      }
      if (this.sorted) {
        const dx = px[slot] - camX;
        const dy = py[slot] - camY;
        const dz = pz[slot] - camZ;
        this.key[slot] = dx * dx + dy * dy + dz * dz;
      }
      order[alive++] = slot;
    }
    this.n = alive;
    if (this.sorted && alive > 1) {
      // Insertion sort, farthest first (order is nearly sorted frame to frame).
      const keys = this.key;
      for (let index = 1; index < alive; index++) {
        const slot = order[index];
        const slotKey = keys[slot];
        let back = index - 1;
        while (back >= 0 && keys[order[back]] < slotKey) {
          order[back + 1] = order[back];
          back--;
        }
        order[back + 1] = slot;
      }
    }
    for (let index = 0; index < alive; index++) {
      const slot = order[index];
      const t = age[slot] / life[slot];
      const remaining = 1 - t;
      const sizeCurve = 1 - Math.pow(remaining, this.sk[slot]);
      const size = this.s0[slot] + (this.s1[slot] - this.s0[slot]) * sizeCurve;
      let alpha = this.a[slot];
      const fadeIn = this.fin[slot];
      const fadeOut = this.fout[slot];
      if (fadeIn > 0 && t < fadeIn) alpha *= t / fadeIn;
      if (t > fadeOut) {
        const k = 1 - (t - fadeOut) / (1 - fadeOut);
        alpha *= k * k * (3 - 2 * k);
      }
      let red = this.r[slot];
      let green = this.g[slot];
      let blue = this.b[slot];
      const ramp = this.ramp[slot];
      if (ramp === 1) {
        red *= Math.pow(remaining, 0.5);
        green *= Math.pow(remaining, 1.4);
        blue *= Math.pow(remaining, 3);
      } else if (ramp === 2) {
        const heat = 1 - Math.pow(t, 1.6);
        const intensity = heat * Math.sqrt(heat);
        red *= intensity;
        green *= (0.22 + 0.78 * Math.pow(heat, 1.3)) * intensity;
        blue *= (0.04 + 0.96 * Math.pow(heat, 3.5)) * intensity;
      } else if (ramp === 3) {
        const flicker = 0.55 + 0.45 * Math.sin(time * 17 + this.seed[slot] * 9);
        red *= flicker;
        green *= flicker * (0.6 + 0.4 * remaining);
        blue *= flicker * remaining;
      }
      const mode = this.mode[slot];
      let axisX = 0;
      let axisY = 1;
      let axisZ = 0;
      if (mode === 1) {
        const stretch = this.stretch[slot];
        axisX = vx[slot] * stretch;
        axisY = vy[slot] * stretch;
        axisZ = vz[slot] * stretch;
      }
      if (
        !batch.push(
          px[slot],
          py[slot],
          pz[slot],
          size,
          axisX,
          axisY,
          axisZ,
          this.rot[slot],
          red,
          green,
          blue,
          alpha,
          this.frame[slot],
          mode,
          t,
          this.shade[slot]
        )
      )
        break;
    }
  }
}

type TracerFloatField =
  | 'fx'
  | 'fy'
  | 'fz'
  | 'dx'
  | 'dy'
  | 'dz'
  | 'dist'
  | 'speed'
  | 'trav'
  | 'len'
  | 'width'
  | 'r'
  | 'g'
  | 'b';

/** Bullet tracers: a travelling streak (core + halo) plus a head glow, drawn into a glow batch. */
export class TracerPool {
  cap: number;
  n: number;
  /** Start point. */
  fx: Float32Array;
  fy: Float32Array;
  fz: Float32Array;
  /** Unit direction. */
  dx: Float32Array;
  dy: Float32Array;
  dz: Float32Array;
  dist: Float32Array;
  speed: Float32Array;
  /** Distance travelled so far. */
  trav: Float32Array;
  len: Float32Array;
  width: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  frames: Uint8Array;

  constructor(capacity = 48) {
    this.cap = capacity;
    this.n = 0;
    const floats = (): Float32Array => new Float32Array(capacity);
    this.fx = floats();
    this.fy = floats();
    this.fz = floats();
    this.dx = floats();
    this.dy = floats();
    this.dz = floats();
    this.dist = floats();
    this.speed = floats();
    this.trav = floats();
    this.len = floats();
    this.width = floats();
    this.r = floats();
    this.g = floats();
    this.b = floats();
    this.frames = new Uint8Array(capacity);
  }

  clear(): void {
    this.n = 0;
  }

  add(
    from: Vec3Like,
    to: Vec3Like,
    r: number,
    g: number,
    b: number,
    speed: number,
    width: number
  ): void {
    let slot = this.n;
    if (slot >= this.cap) slot = 0;
    else this.n++;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.001) {
      if (slot === this.n - 1) this.n--;
      return;
    }
    this.fx[slot] = from.x;
    this.fy[slot] = from.y;
    this.fz[slot] = from.z;
    this.dx[slot] = dx / dist;
    this.dy[slot] = dy / dist;
    this.dz[slot] = dz / dist;
    this.dist[slot] = dist;
    this.speed[slot] = speed;
    this.trav[slot] = 0;
    this.len[slot] = Math.min(Math.max(speed * 0.022, 2), 7);
    this.width[slot] = width;
    this.r[slot] = r;
    this.g[slot] = g;
    this.b[slot] = b;
    this.frames[slot] = 0;
  }

  /** Advances tracers and pushes their sprites; `streakFrame` / `headFrame` are glow atlas frames. */
  update(dt: number, batch: ParticleBatch, streakFrame: number, headFrame: number): void {
    let count = this.n;
    for (let index = 0; index < count; index++) {
      const speed = this.speed[index];
      const dist = this.dist[index];
      const length = this.len[index];
      if (this.frames[index] === 0) {
        this.trav[index] = Math.min(
          dist,
          speed * Math.max(dt, 0.008) * (0.35 + Math.random() * 0.4)
        );
      } else {
        this.trav[index] += speed * dt;
      }
      let head = Math.min(this.trav[index], dist);
      let tail = Math.max(0, this.trav[index] - length);
      if (tail >= dist) {
        if (this.frames[index] >= 2) {
          count--;
          if (index !== count) {
            for (const field of TRACER_FIELDS) this[field][index] = this[field][count];
            this.frames[index] = this.frames[count];
          }
          index--;
          continue;
        }
        tail = Math.max(0, dist - length * 0.5);
        head = dist;
      }
      this.frames[index] = Math.min(250, this.frames[index] + 1);
      const mid = (head + tail) * 0.5;
      const span = Math.max(head - tail, 0.05);
      const dirX = this.dx[index];
      const dirY = this.dy[index];
      const dirZ = this.dz[index];
      const width = this.width[index];
      const midX = this.fx[index] + dirX * mid;
      const midY = this.fy[index] + dirY * mid;
      const midZ = this.fz[index] + dirZ * mid;
      const red = this.r[index];
      const green = this.g[index];
      const blue = this.b[index];
      batch.push(
        midX,
        midY,
        midZ,
        width,
        dirX * span,
        dirY * span,
        dirZ * span,
        0,
        red,
        green,
        blue,
        1,
        streakFrame,
        1,
        0,
        5
      );
      batch.push(
        midX,
        midY,
        midZ,
        width * 6,
        dirX * span * 1.05,
        dirY * span * 1.05,
        dirZ * span * 1.05,
        0,
        red * 0.04,
        green * 0.032,
        blue * 0.028,
        1,
        streakFrame,
        1,
        0,
        28
      );
      batch.push(
        this.fx[index] + dirX * head,
        this.fy[index] + dirY * head,
        this.fz[index] + dirZ * head,
        width * 5,
        0,
        1,
        0,
        0,
        red * 0.2,
        green * 0.16,
        blue * 0.12,
        1,
        headFrame,
        0,
        0,
        1
      );
    }
    this.n = count;
  }
}

const TRACER_FIELDS: TracerFloatField[] = [
  'fx',
  'fy',
  'fz',
  'dx',
  'dy',
  'dz',
  'dist',
  'speed',
  'trav',
  'len',
  'width',
  'r',
  'g',
  'b'
];
const tmpInstanceMatrix = new Matrix4();
const tmpInstanceQuat = new Quaternion();
const tmpInstancePos = new Vector3();
const tmpInstanceScale = new Vector3();
const tmpSpinAxis = new Vector3();

/** Unit box with jittered (deterministic) vertices, flat-shaded: a rough chunk of rubble. */
function createDebrisChunkGeometry(): BufferGeometry {
  let geometry: BufferGeometry = new BoxGeometry(1, 1, 1, 2, 1, 2);
  const position = geometry.attributes.position;
  let hashState = 1234.5;
  const hashRandom = (): number => {
    hashState = Math.sin(hashState * 12.9898 + 78.233) * 43758.5453;
    hashState -= Math.floor(hashState);
    return hashState;
  };
  const moved = new Map<string, [number, number, number]>();
  for (let index = 0; index < position.count; index++) {
    const key =
      position.getX(index).toFixed(3) +
      ',' +
      position.getY(index).toFixed(3) +
      ',' +
      position.getZ(index).toFixed(3);
    let vertex = moved.get(key);
    if (!vertex) {
      let x = position.getX(index);
      let y = position.getY(index);
      let z = position.getZ(index);
      const cornerPull = Math.abs(x) > 0.49 && Math.abs(z) > 0.49 ? 0.72 + hashRandom() * 0.2 : 1;
      x = x * cornerPull + (hashRandom() - 0.5) * 0.14;
      z = z * cornerPull + (hashRandom() - 0.5) * 0.14;
      y = y * (0.8 + hashRandom() * 0.3) + (hashRandom() - 0.5) * 0.1;
      vertex = [x, y, z];
      moved.set(key, vertex);
    }
    position.setXYZ(index, vertex[0], vertex[1], vertex[2]);
  }
  geometry = geometry.toNonIndexed();
  geometry.computeVertexNormals();
  return geometry;
}

/** Ring buffer of tumbling rubble chunks (one InstancedMesh) that bounce and settle. */
export class DebrisPool {
  G: Game;
  cap: number;
  next: number;
  /** Live chunk count after the last update. */
  live: number;
  mesh: InstancedMesh<BufferGeometry, MeshStandardMaterial>;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  /** Spin axis. */
  ax: Float32Array;
  ay: Float32Array;
  az: Float32Array;
  ang: Float32Array;
  spin: Float32Array;
  /** Scale. */
  sx: Float32Array;
  sy: Float32Array;
  sz: Float32Array;
  age: Float32Array;
  life: Float32Array;
  floor: Float32Array;
  /** 0 free, 1 flying, 2 resting. */
  state: Uint8Array;

  constructor(game: Game, capacity = 256) {
    this.G = game;
    this.cap = capacity;
    this.next = 0;
    this.live = 0;
    const material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.82,
      metalness: 0.05
    });
    material.name = 'fx_debris';
    const mesh = (this.mesh = new InstancedMesh(createDebrisChunkGeometry(), material, capacity));
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'fx_debris';
    const floats = (): Float32Array => new Float32Array(capacity);
    this.px = floats();
    this.py = floats();
    this.pz = floats();
    this.vx = floats();
    this.vy = floats();
    this.vz = floats();
    this.ax = floats();
    this.ay = floats();
    this.az = floats();
    this.ang = floats();
    this.spin = floats();
    this.sx = floats();
    this.sy = floats();
    this.sz = floats();
    this.age = floats();
    this.life = floats();
    this.floor = floats();
    this.state = new Uint8Array(capacity);
    tmpInstanceMatrix.makeScale(0, 0, 0);
    for (let index = 0; index < capacity; index++)
      tmpInstanceMatrix.toArray(mesh.instanceMatrix.array, index * 16);
    mesh.visible = false;
  }

  clear(): void {
    this.state.fill(0);
    tmpInstanceMatrix.makeScale(0, 0, 0);
    for (let index = 0; index < this.cap; index++)
      tmpInstanceMatrix.toArray(this.mesh.instanceMatrix.array, index * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.live = 0;
    this.mesh.visible = false;
  }

  add(
    x: number,
    y: number,
    z: number,
    velX: number,
    velY: number,
    velZ: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    r: number,
    g: number,
    b: number,
    life: number,
    floorY: number
  ): void {
    const slot = this.next;
    this.next = (slot + 1) % this.cap;
    this.px[slot] = x;
    this.py[slot] = y;
    this.pz[slot] = z;
    this.vx[slot] = velX;
    this.vy[slot] = velY;
    this.vz[slot] = velZ;
    const axisX = Math.random() - 0.5;
    const axisY = Math.random() - 0.5;
    const axisZ = Math.random() - 0.5;
    const axisLen = Math.hypot(axisX, axisY, axisZ) || 1;
    this.ax[slot] = axisX / axisLen;
    this.ay[slot] = axisY / axisLen;
    this.az[slot] = axisZ / axisLen;
    this.ang[slot] = Math.random() * 6.28;
    this.spin[slot] = (Math.random() - 0.5) * 50;
    this.sx[slot] = scaleX;
    this.sy[slot] = scaleY;
    this.sz[slot] = scaleZ;
    this.age[slot] = 0;
    this.life[slot] = life;
    this.floor[slot] = floorY;
    this.state[slot] = 1;
    const instanceColor = this.mesh.instanceColor!;
    const colors = instanceColor.array;
    colors[slot * 3] = r;
    colors[slot * 3 + 1] = g;
    colors[slot * 3 + 2] = b;
    instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    const state = this.state;
    const matrices = this.mesh.instanceMatrix.array;
    let live = 0;
    let dirty = false;
    for (let index = 0; index < this.cap; index++) {
      const chunkState = state[index];
      if (!chunkState) continue;
      this.age[index] += dt;
      const remaining = this.life[index] - this.age[index];
      if (remaining <= 0) {
        state[index] = 0;
        tmpInstanceMatrix.makeScale(0, 0, 0);
        tmpInstanceMatrix.toArray(matrices, index * 16);
        dirty = true;
        continue;
      }
      live++;
      if (chunkState === 2 && remaining > 0.5) continue;
      if (chunkState === 1) {
        this.vy[index] -= 9.81 * dt;
        this.px[index] += this.vx[index] * dt;
        this.py[index] += this.vy[index] * dt;
        this.pz[index] += this.vz[index] * dt;
        this.ang[index] += this.spin[index] * dt;
        const restY =
          this.floor[index] + Math.min(this.sx[index], this.sy[index], this.sz[index]) * 0.5;
        if (this.py[index] < restY && this.vy[index] < 0) {
          this.py[index] = restY;
          if (this.vy[index] > -1.2) {
            state[index] = 2;
            this.vx[index] = this.vy[index] = this.vz[index] = 0;
          } else {
            this.vy[index] = -this.vy[index] * 0.32;
            this.vx[index] *= 0.55;
            this.vz[index] *= 0.55;
            this.spin[index] *= 0.5;
          }
        }
      }
      const shrink = remaining < 0.5 ? remaining / 0.5 : 1;
      tmpSpinAxis.set(this.ax[index], this.ay[index], this.az[index]);
      tmpInstanceQuat.setFromAxisAngle(tmpSpinAxis, this.ang[index]);
      tmpInstancePos.set(this.px[index], this.py[index], this.pz[index]);
      tmpInstanceScale.set(
        this.sx[index] * shrink,
        this.sy[index] * shrink,
        this.sz[index] * shrink
      );
      tmpInstanceMatrix.compose(tmpInstancePos, tmpInstanceQuat, tmpInstanceScale);
      tmpInstanceMatrix.toArray(matrices, index * 16);
      dirty = true;
    }
    this.live = live;
    this.mesh.visible = live > 0;
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Payload of the `shell:bounce` event (a shared, reused object). */
export interface ShellBounceEvent {
  pos: Vector3;
  surface: string;
}

const shellBounceEvent: ShellBounceEvent = {
  pos: new Vector3(),
  surface: 'concrete'
};
const SHELL_GROUND_RAY_DIR = new Vector3(0, -1, 0);
const tmpShellRayOrigin = new Vector3();
const tmpShellQuat = new Quaternion();
const tmpShellEuler = new Euler();

/** Lathed 9 mm-ish brass casing profile, centered on its length. */
function createShellCasingGeometry(): LatheGeometry {
  const profile = [
    [0, 0],
    [0.006076, 0],
    [0.0062, 0.0012],
    [0.005083999999999999, 0.0022],
    [0.005083999999999999, 0.0034],
    [0.006013999999999999, 0.0046],
    [0.005889999999999999, 0.036399999999999995],
    [0.004092, 0.0416],
    [0.003968, 0.052],
    [0.003224, 0.052],
    [0.0031, 0.044719999999999996]
  ];
  const geometry = new LatheGeometry(
    profile.map((point) => new Vector2(point[0], point[1] - 0.052 / 2)),
    10
  );
  geometry.computeVertexNormals();
  return geometry;
}

/** Ejected brass casings: rigid-body tumble, a few bounces (emitting `shell:bounce`), then fade out. */
export class ShellCasingPool {
  G: Game;
  cap: number;
  next: number;
  mesh: InstancedMesh<LatheGeometry, Material>;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  /** Orientation quaternion. */
  qx: Float32Array;
  qy: Float32Array;
  qz: Float32Array;
  qw: Float32Array;
  /** Angular velocity. */
  wx: Float32Array;
  wy: Float32Array;
  wz: Float32Array;
  age: Float32Array;
  /** Seconds spent at rest. */
  rest: Float32Array;
  floor: Float32Array;
  /** 0 free, 1 flying, 2 resting. */
  state: Uint8Array;
  bounces: Uint8Array;
  /** Surface name under each casing (for bounce sounds). */
  surface: string[];

  constructor(game: Game, capacity = 60) {
    this.G = game;
    this.cap = capacity;
    this.next = 0;
    let material: Material | null | undefined;
    try {
      material = game.mats.get('brass');
    } catch {
      material = null;
    }
    if (!material || !material.isMaterial) {
      material = new MeshStandardMaterial({
        color: 0xb08d3c,
        roughness: 0.3,
        metalness: 1
      });
    }
    const mesh = (this.mesh = new InstancedMesh(createShellCasingGeometry(), material, capacity));
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'fx_shells';
    const floats = (): Float32Array => new Float32Array(capacity);
    this.px = floats();
    this.py = floats();
    this.pz = floats();
    this.vx = floats();
    this.vy = floats();
    this.vz = floats();
    this.qx = floats();
    this.qy = floats();
    this.qz = floats();
    this.qw = floats().fill(1);
    this.wx = floats();
    this.wy = floats();
    this.wz = floats();
    this.age = floats();
    this.rest = floats();
    this.floor = floats();
    this.state = new Uint8Array(capacity);
    this.bounces = new Uint8Array(capacity);
    tmpInstanceMatrix.makeScale(0, 0, 0);
    for (let index = 0; index < capacity; index++)
      tmpInstanceMatrix.toArray(mesh.instanceMatrix.array, index * 16);
    mesh.visible = false;
    this.surface = new Array<string>(capacity).fill('concrete');
  }

  clear(): void {
    this.state.fill(0);
    tmpInstanceMatrix.makeScale(0, 0, 0);
    for (let index = 0; index < this.cap; index++)
      tmpInstanceMatrix.toArray(this.mesh.instanceMatrix.array, index * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = false;
  }

  /** Raycasts down from the casing to find its floor height and surface. */
  _floorAt(slot: number): void {
    const physics = this.G.physics;
    this.floor[slot] = 0;
    this.surface[slot] = 'concrete';
    if (physics && physics.raycast) {
      tmpShellRayOrigin.set(this.px[slot], this.py[slot] + 0.25, this.pz[slot]);
      const hit = physics.raycast(tmpShellRayOrigin, SHELL_GROUND_RAY_DIR, 6);
      if (hit) {
        this.floor[slot] = hit.point.y;
        this.surface[slot] = hit.surface || 'concrete';
      } else {
        this.floor[slot] = -50;
      }
    }
  }

  add(pos: Vec3Like, vel: Vec3Like): void {
    const slot = this.next;
    this.next = (slot + 1) % this.cap;
    this.px[slot] = pos.x;
    this.py[slot] = pos.y;
    this.pz[slot] = pos.z;
    this.vx[slot] = vel.x;
    this.vy[slot] = vel.y;
    this.vz[slot] = vel.z;
    tmpShellEuler.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    tmpInstanceQuat.setFromEuler(tmpShellEuler);
    this.qx[slot] = tmpInstanceQuat.x;
    this.qy[slot] = tmpInstanceQuat.y;
    this.qz[slot] = tmpInstanceQuat.z;
    this.qw[slot] = tmpInstanceQuat.w;
    this.wx[slot] = (Math.random() - 0.5) * 40;
    this.wy[slot] = (Math.random() - 0.5) * 20;
    this.wz[slot] = (Math.random() - 0.5) * 40;
    this.age[slot] = 0;
    this.rest[slot] = 0;
    this.state[slot] = 1;
    this.bounces[slot] = 0;
    this._floorAt(slot);
  }

  update(dt: number): void {
    const state = this.state;
    const matrices = this.mesh.instanceMatrix.array;
    let live = 0;
    let dirty = false;
    for (let index = 0; index < this.cap; index++) {
      const shellState = state[index];
      if (!shellState) continue;
      live++;
      this.age[index] += dt;
      let scale = 1;
      if (shellState === 1) {
        this.vy[index] -= 9.81 * dt;
        this.px[index] += this.vx[index] * dt;
        this.py[index] += this.vy[index] * dt;
        this.pz[index] += this.vz[index] * dt;
        // Integrate orientation: q += 0.5 * dt * (w x q), then renormalize.
        const wx = this.wx[index];
        const wy = this.wy[index];
        const wz = this.wz[index];
        const qx = this.qx[index];
        const qy = this.qy[index];
        const qz = this.qz[index];
        const qw = this.qw[index];
        const halfDt = 0.5 * dt;
        const nx = qx + halfDt * (wx * qw + wy * qz - wz * qy);
        const ny = qy + halfDt * (wy * qw + wz * qx - wx * qz);
        const nz = qz + halfDt * (wz * qw + wx * qy - wy * qx);
        const nw = qw - halfDt * (wx * qx + wy * qy + wz * qz);
        const invLen = 1 / (Math.hypot(nx, ny, nz, nw) || 1);
        this.qx[index] = nx * invLen;
        this.qy[index] = ny * invLen;
        this.qz[index] = nz * invLen;
        this.qw[index] = nw * invLen;
        const restY = this.floor[index] + 0.0065;
        if (this.py[index] < restY && this.vy[index] < 0) {
          this.py[index] = restY;
          const bounce = this.bounces[index]++;
          if (bounce < 2) {
            shellBounceEvent.pos.set(this.px[index], this.py[index], this.pz[index]);
            shellBounceEvent.surface = this.surface[index];
            this.G.events.emit('shell:bounce', shellBounceEvent);
          }
          if (this.vy[index] > -0.9 || bounce >= 4) {
            state[index] = 2;
            this.vx[index] = this.vy[index] = this.vz[index] = 0;
            tmpShellEuler.set(Math.PI / 2, 0, Math.random() * 6.28, 'ZXY');
            tmpInstanceQuat.setFromEuler(tmpShellEuler);
            this.qx[index] = tmpInstanceQuat.x;
            this.qy[index] = tmpInstanceQuat.y;
            this.qz[index] = tmpInstanceQuat.z;
            this.qw[index] = tmpInstanceQuat.w;
          } else {
            this.vy[index] = -this.vy[index] * (0.32 + Math.random() * 0.16);
            this.vx[index] = this.vx[index] * 0.6 + (Math.random() - 0.5) * 0.6;
            this.vz[index] = this.vz[index] * 0.6 + (Math.random() - 0.5) * 0.6;
            this.wx[index] = (Math.random() - 0.5) * 50;
            this.wy[index] = (Math.random() - 0.5) * 30;
            this.wz[index] = (Math.random() - 0.5) * 50;
            if (bounce === 0) this._floorAt(index);
          }
        }
        if (this.age[index] > 8) state[index] = 2;
      } else {
        this.rest[index] += dt;
        // Resting casings only need their matrix written once, then again while fading.
        if (this.rest[index] < 4 && this.rest[index] > dt * 1.5) continue;
        if (this.rest[index] >= 4.7) {
          state[index] = 0;
          tmpInstanceMatrix.makeScale(0, 0, 0);
          tmpInstanceMatrix.toArray(matrices, index * 16);
          dirty = true;
          continue;
        }
        if (this.rest[index] >= 4) scale = 1 - (this.rest[index] - 4) / 0.7;
      }
      tmpShellQuat.set(this.qx[index], this.qy[index], this.qz[index], this.qw[index]);
      tmpInstancePos.set(this.px[index], this.py[index], this.pz[index]);
      tmpInstanceScale.set(scale, scale, scale);
      tmpInstanceMatrix.compose(tmpInstancePos, tmpShellQuat, tmpInstanceScale);
      tmpInstanceMatrix.toArray(matrices, index * 16);
      dirty = true;
    }
    this.mesh.visible = live > 0;
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Default decal diameter (m) per kind. */
export const DECAL_SIZES: Record<string, number> = {
  bullet_metal: 0.25,
  bullet_concrete: 0.34,
  bullet_wood: 0.24,
  scorch: 2.4,
  soot: 0.3,
  bullet_glass: 0.3
};
/** Once the ring buffer is full, the oldest this-many decals fade out progressively. */
export const DECAL_FADE_TAIL = 14;

/** Ring buffer of surface-aligned decal quads (bullet holes, scorch marks) in one mesh. */
export class DecalPool {
  cap: number;
  next: number;
  count: number;
  atlas: DecalAtlas;
  pos: BufferAttribute;
  nor: BufferAttribute;
  uv: BufferAttribute;
  col: BufferAttribute;
  /** Base alpha per decal, used for the fade tail. */
  baseA: Float32Array;
  mesh: Mesh<BufferGeometry, MeshStandardMaterial>;
  /** Decal kind -> UV rects of its tile variants. */
  uvs: Record<string, AtlasUvRect[]>;

  constructor(_game: Game, capacity = 160) {
    this.cap = capacity;
    this.next = 0;
    this.count = 0;
    const atlas = (this.atlas = createDecalAtlas(256));
    const geometry = new BufferGeometry();
    this.pos = new BufferAttribute(new Float32Array(capacity * 12), 3);
    this.pos.setUsage(DynamicDrawUsage);
    this.nor = new BufferAttribute(new Float32Array(capacity * 12), 3);
    this.nor.setUsage(DynamicDrawUsage);
    this.uv = new BufferAttribute(new Float32Array(capacity * 8), 2);
    this.uv.setUsage(DynamicDrawUsage);
    this.col = new BufferAttribute(new Float32Array(capacity * 16), 4);
    this.col.setUsage(DynamicDrawUsage);
    this.baseA = new Float32Array(capacity);
    geometry.setAttribute('position', this.pos);
    geometry.setAttribute('normal', this.nor);
    geometry.setAttribute('uv', this.uv);
    geometry.setAttribute('color', this.col);
    const indices = new Uint16Array(capacity * 6);
    for (let quad = 0; quad < capacity; quad++) {
      const vertex = quad * 4;
      const offset = quad * 6;
      indices[offset] = vertex;
      indices[offset + 1] = vertex + 1;
      indices[offset + 2] = vertex + 2;
      indices[offset + 3] = vertex;
      indices[offset + 4] = vertex + 2;
      indices[offset + 5] = vertex + 3;
    }
    geometry.setIndex(new BufferAttribute(indices, 1));
    const material = new MeshStandardMaterial({
      map: atlas.map,
      roughnessMap: atlas.orm,
      metalnessMap: atlas.orm,
      roughness: 1,
      metalness: 1,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4
    });
    if (atlas.nrm) {
      material.normalMap = atlas.nrm;
      material.normalScale = new Vector2(1, 1);
    }
    material.name = 'fx_decals';
    const mesh = (this.mesh = new Mesh(geometry, material));
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = -5;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'fx_decals';
    mesh.visible = false;
    this.uvs = {};
    for (const kind in DECAL_ATLAS_TILES)
      this.uvs[kind] = DECAL_ATLAS_TILES[kind as DecalKind].map((tile) => atlas.uv(tile));
  }

  clear(): void {
    this.col.array.fill(0);
    this.pos.array.fill(0);
    this.col.needsUpdate = this.pos.needsUpdate = true;
    this.next = 0;
    this.count = 0;
    this.mesh.visible = false;
  }

  /**
   * Stamps a decal of `kind` at `point` facing `normal`. `size` overrides the default diameter,
   * `shade` multiplies its color and `alpha` sets its opacity.
   */
  add(point: Vec3Like, normal: Vec3Like, kind: string, size?: number, shade = 1, alpha = 1): void {
    const variants = this.uvs[kind] || this.uvs.bullet_concrete;
    const uvRect = variants[(Math.random() * variants.length) | 0];
    const halfSize = (size || DECAL_SIZES[kind] || 0.25) * (0.85 + Math.random() * 0.3) * 0.5;
    const slot = this.next;
    this.next = (slot + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    let nx = normal.x;
    let ny = normal.y;
    let nz = normal.z;
    const normalLen = Math.hypot(nx, ny, nz) || 1;
    nx /= normalLen;
    ny /= normalLen;
    nz /= normalLen;
    // Tangent: any vector perpendicular to the normal (Gram-Schmidt).
    let tx: number;
    let ty: number;
    let tz: number;
    if (Math.abs(ny) > 0.9) {
      tx = 1;
      ty = 0;
      tz = 0;
    } else {
      tx = -nz;
      ty = 0;
      tz = nx;
    }
    const along = tx * nx + ty * ny + tz * nz;
    tx -= nx * along;
    ty -= ny * along;
    tz -= nz * along;
    const tangentLen = Math.hypot(tx, ty, tz) || 1;
    tx /= tangentLen;
    ty /= tangentLen;
    tz /= tangentLen;
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;
    const angle = kind === 'bullet_wood' ? (Math.random() - 0.5) * 0.3 : Math.random() * 6.283;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const ux = (tx * cos + bx * sin) * halfSize;
    const uy = (ty * cos + by * sin) * halfSize;
    const uz = (tz * cos + bz * sin) * halfSize;
    const vx = (bx * cos - tx * sin) * halfSize;
    const vy = (by * cos - ty * sin) * halfSize;
    const vz = (bz * cos - tz * sin) * halfSize;
    // Small per-slot offset along the normal to reduce z-fighting between overlapping decals.
    const lift = 0.004 + (slot % 7) * 0.0003;
    const cx = point.x + nx * lift;
    const cy = point.y + ny * lift;
    const cz = point.z + nz * lift;
    const positions = this.pos.array;
    const normals = this.nor.array;
    const uvs = this.uv.array;
    const colors = this.col.array;
    let offset = slot * 12;
    positions[offset] = cx - ux - vx;
    positions[offset + 1] = cy - uy - vy;
    positions[offset + 2] = cz - uz - vz;
    positions[offset + 3] = cx + ux - vx;
    positions[offset + 4] = cy + uy - vy;
    positions[offset + 5] = cz + uz - vz;
    positions[offset + 6] = cx + ux + vx;
    positions[offset + 7] = cy + uy + vy;
    positions[offset + 8] = cz + uz + vz;
    positions[offset + 9] = cx - ux + vx;
    positions[offset + 10] = cy - uy + vy;
    positions[offset + 11] = cz - uz + vz;
    for (let corner = 0; corner < 4; corner++) {
      normals[offset + corner * 3] = nx;
      normals[offset + corner * 3 + 1] = ny;
      normals[offset + corner * 3 + 2] = nz;
    }
    offset = slot * 8;
    uvs[offset] = uvRect[0];
    uvs[offset + 1] = uvRect[1];
    uvs[offset + 2] = uvRect[2];
    uvs[offset + 3] = uvRect[1];
    uvs[offset + 4] = uvRect[2];
    uvs[offset + 5] = uvRect[3];
    uvs[offset + 6] = uvRect[0];
    uvs[offset + 7] = uvRect[3];
    offset = slot * 16;
    this.baseA[slot] = alpha;
    for (let corner = 0; corner < 4; corner++) {
      colors[offset + corner * 4] = shade;
      colors[offset + corner * 4 + 1] = shade;
      colors[offset + corner * 4 + 2] = shade;
      colors[offset + corner * 4 + 3] = alpha;
    }
    if (this.count >= this.cap) {
      for (let step = 0; step < DECAL_FADE_TAIL; step++) {
        const oldSlot = (this.next + step) % this.cap;
        const fadedAlpha = (this.baseA[oldSlot] * (step + 1)) / (DECAL_FADE_TAIL + 1);
        const colorOffset = oldSlot * 16;
        colors[colorOffset + 3] =
          colors[colorOffset + 7] =
          colors[colorOffset + 11] =
          colors[colorOffset + 15] =
            fadedAlpha;
      }
    }
    this.pos.needsUpdate = this.nor.needsUpdate = this.uv.needsUpdate = this.col.needsUpdate = true;
    this.mesh.visible = true;
  }
}
