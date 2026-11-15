/**
 * Visual effects system (`game.fx`): muzzle flashes, tracers, bullet impacts per surface,
 * sparks, smoke, dust, debris, shell casings, decals, splashes, explosions and persistent
 * emitters (steam / smolder / embers / fire / drip). Particles are drawn by two instanced
 * batches (lit smoke and additive glow) fed from CPU particle pools.
 */
import { Color, Group, Mesh, Vector3 } from 'three';
import type { BufferGeometry, ColorRepresentation, PointLight } from 'three';
import { SKY_COLORS, SUN } from '../core/config';
import type { Game } from '../core/types';
import { roundedBox } from '../render/geometry';
import {
  GLOW_ATLAS_COLS,
  GLOW_ATLAS_ROWS,
  GLOW_FRAME_DOT,
  GLOW_FRAME_FIREBALL,
  GLOW_FRAME_FLASH_CONE,
  GLOW_FRAME_RING,
  GLOW_FRAME_SOFT,
  GLOW_FRAME_STARBURST_A,
  GLOW_FRAME_STREAK,
  SMOKE_ATLAS_COLS,
  SMOKE_ATLAS_ROWS,
  createGlowAtlas,
  createSmokeAtlas
} from './atlases';
import {
  DebrisPool,
  DecalPool,
  PARTICLE_FLAG_BOUNCE,
  PARTICLE_FLAG_DIE_ON_GROUND,
  ParticlePool,
  ShellCasingPool,
  TracerPool,
  createParticleBatch
} from './particles';
import type { Vec3Like } from './particles';

const LIT_PARTICLE_CAPACITY = 1400;
const GLOW_PARTICLE_CAPACITY = 3200;
const fxRandom = Math.random;
const fxRandRange = (min: number, max: number): number => min + (max - min) * Math.random();
const tmpSurfaceNormal = new Vector3();
const tmpEmitDir = new Vector3();
const tmpIncomingDir = new Vector3();
const tmpSprayDir = new Vector3();
const tmpRayOrigin = new Vector3();
const tmpGroundPoint = new Vector3();
const WORLD_UP = new Vector3(0, 1, 0);
const WORLD_DOWN = new Vector3(0, -1, 0);
const scratchFxColor = new Color();
const scratchRgb: [number, number, number] = [1, 1, 1];

/** Colour accepted by fx options: anything `Color.set` takes, or an `[r, g, b]` triple. */
export type FxColor = ColorRepresentation | number[];

/** Persistent emitter kinds for {@link FxSystem.addEmitter}. */
export type FxEmitterKind = 'steam' | 'smolder' | 'embers' | 'fire' | 'drip';

/** Options for {@link FxSystem.smoke}. */
export interface SmokeOptions {
  size?: number;
  life?: number;
  rise?: number;
  color?: FxColor | null;
  vel?: Vec3Like | null;
  count?: number;
  alpha?: number;
}

/** Options for {@link FxSystem.debris}. `mat` is a material name or a material with a colour. */
export interface DebrisOptions {
  color?: FxColor | null;
  mat?: string | { color?: Color } | null;
  size?: number;
  speed?: number;
  normal?: Vector3 | null;
  count?: number;
  spread?: number;
}

/** Options for {@link FxSystem.tracer}. */
export interface TracerOptions {
  color?: FxColor | null;
  intensity?: number;
  speed?: number;
  width?: number;
  /** Set to false to skip the faint smoke trail. */
  trail?: boolean;
}

/** Options for {@link FxSystem.muzzleFlash}. */
export interface MuzzleFlashOptions {
  scale?: number;
  color?: FxColor | null;
}

/** Options for {@link FxSystem.addEmitter}. */
export interface EmitterOptions {
  ttl?: number;
  scale?: number;
}

/** Handle of a persistent emitter (a dead handle is returned when the pool is full). */
export interface FxEmitterHandle {
  active: boolean;
  pos: Vector3;
  stop(): void;
  setPos(pos: Vec3Like): void;
}

/** Counters returned by {@link FxSystem.stats}. */
export interface FxStats {
  lit: number;
  add: number;
  tracers: number;
  debris: number;
  drawCalls: number;
}

/** Payload of the `explosion` event emitted by {@link FxSystem.explosion} (reused object). */
export interface ExplosionEvent {
  pos: Vector3;
  size: number;
}

/** The effects system stored as `game.fx`. */
export interface FxSystem {
  update(dt: number): void;
  /** Kills every particle, debris piece, shell, decal and emitter. */
  clear(): void;
  muzzleFlash(pos: Vector3, dir: Vector3 | null | undefined, options?: MuzzleFlashOptions): void;
  tracer(from: Vector3, to: Vector3, options?: TracerOptions): void;
  /** Bullet impact; `enemy` (any truthy value) forces the 'enemy' surface. */
  impact(
    point: Vector3,
    normal: Vector3 | null | undefined,
    surface: string | undefined,
    dir?: Vector3 | null,
    enemy?: unknown
  ): void;
  sparks(point: Vector3, normal?: Vector3 | null, count?: number): void;
  smoke(point: Vector3, options?: SmokeOptions): void;
  /** Puff of dust; returns the sun-shadow shade factor used. */
  dust(
    point: Vector3,
    normal?: Vector3 | null,
    scale?: number,
    r?: number,
    g?: number,
    b?: number
  ): number;
  explosion(point: Vector3, size?: number): void;
  shell(pos: Vec3Like, vel: Vec3Like): void;
  splash(point: Vector3, scale?: number): void;
  addEmitter(pos: Vec3Like, kind?: FxEmitterKind, options?: EmitterOptions): FxEmitterHandle;
  debris(point: Vector3, options?: DebrisOptions): void;
  decal(point: Vec3Like, normal: Vector3 | null | undefined, kind?: string, size?: number): void;
  /** Wind velocity applied to particles (mutable). */
  wind: Vector3;
  root: Group;
  stats(): FxStats;
}

/** Point light handle handed out by the render light pool for long-lived lights. */
interface FxLightHandle {
  light: PointLight;
  release(): void;
}

/** The part of `game.render.lightPool` that fx uses. */
interface FxLightPool {
  flash(pos: Vector3, color?: number, intensity?: number, distance?: number, ttl?: number): void;
  acquire?: () => FxLightHandle | null;
}

/** A pooled persistent emitter. */
interface FxEmitter extends FxEmitterHandle {
  kind: FxEmitterKind;
  acc: number;
  acc2: number;
  ttl: number;
  scale: number;
  shade: number;
  t: number;
  light: FxLightHandle | null;
  drop: number;
}

/** Payload of the `impact` event. */
interface ImpactEvent {
  point?: Vector3;
  normal?: Vector3 | null;
  surface?: string;
  dir?: Vector3 | null;
  enemy?: unknown;
}

/** Writes `color` (or the fallback r/g/b when null) into the shared scratch triple. */
function toRgbTriple(
  color: FxColor | null | undefined,
  r: number,
  g: number,
  b: number
): [number, number, number] {
  if (color == null) {
    scratchRgb[0] = r;
    scratchRgb[1] = g;
    scratchRgb[2] = b;
  } else if (Array.isArray(color)) {
    scratchRgb[0] = color[0];
    scratchRgb[1] = color[1];
    scratchRgb[2] = color[2];
  } else if (typeof color === 'object' && color.isColor) {
    scratchRgb[0] = color.r;
    scratchRgb[1] = color.g;
    scratchRgb[2] = color.b;
  } else {
    scratchFxColor.set(color);
    scratchRgb[0] = scratchFxColor.r;
    scratchRgb[1] = scratchFxColor.g;
    scratchRgb[2] = scratchFxColor.b;
  }
  return scratchRgb;
}

/** Random unit direction within `spread` of `base`, written to `out`. */
function jitterDirection(base: Vector3, spread: number, out: Vector3): Vector3 {
  const rx = fxRandom() * 2 - 1;
  const ry = fxRandom() * 2 - 1;
  const rz = fxRandom() * 2 - 1;
  const len = Math.hypot(rx, ry, rz) || 1;
  const scale = (spread * Math.cbrt(fxRandom())) / len;
  out.set(base.x + rx * scale, base.y + ry * scale, base.z + rz * scale);
  const outLen = out.length();
  if (outLen < 1e-4) out.copy(base);
  else out.multiplyScalar(1 / outLen);
  return out;
}

/** Creates the effects system and subscribes it to impact / footstep events. */
export async function createFx(game: Game): Promise<FxSystem> {
  const scene = game.scene || (game.render && game.render.scene);
  const wind = new Vector3(-0.8, 0, 0.3);
  const sunColor = new Vector3(SUN.color.r, SUN.color.g, SUN.color.b).multiplyScalar(
    (SUN.intensity / Math.PI) * 0.9
  );
  const ambientHigh = new Vector3(
    SKY_COLORS.zenith.r * 0.6 + SKY_COLORS.horizonAway.r * 0.5 + SKY_COLORS.fog.r * 0.25,
    SKY_COLORS.zenith.g * 0.6 + SKY_COLORS.horizonAway.g * 0.5 + SKY_COLORS.fog.g * 0.25,
    SKY_COLORS.zenith.b * 0.6 + SKY_COLORS.horizonAway.b * 0.5 + SKY_COLORS.fog.b * 0.25
  );
  const ambientLow = new Vector3(
    SKY_COLORS.horizonAway.r * 0.3 + SKY_COLORS.fog.r * 0.14,
    SKY_COLORS.horizonAway.g * 0.3 + SKY_COLORS.fog.g * 0.14,
    SKY_COLORS.horizonAway.b * 0.3 + SKY_COLORS.fog.b * 0.14
  );
  const litBatch = createParticleBatch(game, LIT_PARTICLE_CAPACITY, {
    lit: true,
    tex: createSmokeAtlas(128),
    cols: SMOKE_ATLAS_COLS,
    rows: SMOKE_ATLAS_ROWS,
    renderOrder: 10,
    sun: sunColor,
    sunDir: SUN.dir.clone().normalize(),
    ambLo: ambientLow,
    ambHi: ambientHigh
  });
  const glowBatch = createParticleBatch(game, GLOW_PARTICLE_CAPACITY, {
    lit: false,
    tex: createGlowAtlas(128),
    cols: GLOW_ATLAS_COLS,
    rows: GLOW_ATLAS_ROWS,
    renderOrder: 20
  });
  const litPool = new ParticlePool(LIT_PARTICLE_CAPACITY, true);
  const glowPool = new ParticlePool(GLOW_PARTICLE_CAPACITY - 160, false);
  const tracers = new TracerPool(48);
  const debrisPool = new DebrisPool(game, 256);
  const shellPool = new ShellCasingPool(game, 60);
  const decalPool = new DecalPool(game, 160);
  const root = new Group();
  root.name = 'fx';
  root.add(decalPool.mesh, debrisPool.mesh, shellPool.mesh, litBatch.mesh, glowBatch.mesh);
  scene.add(root);

  let time = 0;
  let lastImpactLightTime = -1;
  let lastTrailTime = -1;
  const getLightPool = (): FxLightPool | null | undefined => game.render && game.render.lightPool;
  const flashLight = (
    pos: Vector3,
    color: number,
    intensity: number,
    distance: number,
    ttl: number
  ): void => {
    const lightPool = getLightPool();
    if (lightPool) lightPool.flash(pos, color, intensity, distance, ttl);
  };

  /** 0.2 when the sun is blocked from `point` (nudged along `normal`), else 1. */
  function sunShadeAt(point: Vector3, normal: Vector3 | null): number {
    const physics = game.physics;
    if (!physics || !physics.raycast) return 1;
    tmpRayOrigin.copy(point);
    if (normal) tmpRayOrigin.addScaledVector(normal, 0.08);
    tmpRayOrigin.y += 0.03;
    let hit = null;
    try {
      hit = physics.raycast(tmpRayOrigin, SUN.dir, 90);
    } catch {
      hit = null;
    }
    return hit ? 0.2 : 1;
  }

  /** Height of the first collider below `point` (0 without physics, -50 when nothing is hit). */
  function groundHeightBelow(point: Vector3): number {
    const physics = game.physics;
    if (!physics || !physics.raycast) return 0;
    tmpRayOrigin.copy(point);
    tmpRayOrigin.y += 0.1;
    let hit = null;
    try {
      hit = physics.raycast(tmpRayOrigin, WORLD_DOWN, 12);
    } catch {
      hit = null;
    }
    return hit ? hit.point.y : -50;
  }

  /** Emits a lit smoke particle; `frame < 0` picks a random smoke tile. Returns the index or -1. */
  function emitSmoke(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size0: number,
    size1: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
    shade: number,
    drag: number,
    rise: number,
    windFactor: number,
    frame: number
  ): number {
    const index = litPool.emit(x, y, z, vx, vy, vz, life, size0, size1);
    if (index < 0) return -1;
    litPool.r[index] = r;
    litPool.g[index] = g;
    litPool.b[index] = b;
    litPool.a[index] = alpha;
    litPool.shade[index] = shade;
    litPool.drag[index] = drag;
    litPool.grav[index] = -rise;
    litPool.wind[index] = windFactor;
    litPool.turb[index] = 0.5;
    litPool.rot[index] = fxRandom() * 6.283;
    litPool.rotv[index] = (fxRandom() - 0.5) * 1.2;
    litPool.frame[index] = frame < 0 ? (fxRandom() * 6) | 0 : frame;
    litPool.fin[index] = 0.06;
    litPool.fout[index] = 0.3;
    litPool.sk[index] = 2.5;
    return index;
  }

  /** Emits a velocity-stretched glowing spark streak. Returns the index or -1. */
  function emitSpark(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    r: number,
    g: number,
    b: number,
    flags: number
  ): number {
    const index = glowPool.emit(x, y, z, vx, vy, vz, life, size, size * 0.5);
    if (index < 0) return -1;
    glowPool.mode[index] = 1;
    glowPool.frame[index] = GLOW_FRAME_STREAK;
    glowPool.stretch[index] = 0.03;
    glowPool.grav[index] = 9.81;
    glowPool.drag[index] = 0.9;
    glowPool.ramp[index] = 1;
    glowPool.r[index] = r * 0.6;
    glowPool.g[index] = g * 0.6;
    glowPool.b[index] = b * 0.6;
    glowPool.fout[index] = 0.55;
    glowPool.flags[index] = flags;
    glowPool.sk[index] = 1;
    return index;
  }

  /** Sprays `count` sparks from `origin` around `dir`. */
  function spraySparks(
    origin: Vector3,
    dir: Vector3,
    count: number,
    speedMin: number,
    speedMax: number,
    spread: number,
    lifeMin: number,
    lifeMax: number,
    r: number,
    g: number,
    b: number,
    flags: number
  ): void {
    for (let i = 0; i < count; i++) {
      jitterDirection(dir, spread, tmpSprayDir);
      const speed = fxRandRange(speedMin, speedMax) * (0.35 + 0.65 * fxRandom());
      emitSpark(
        origin.x,
        origin.y,
        origin.z,
        tmpSprayDir.x * speed,
        tmpSprayDir.y * speed,
        tmpSprayDir.z * speed,
        fxRandRange(lifeMin, lifeMax),
        fxRandRange(0.01, 0.02),
        r * fxRandRange(0.6, 1.2),
        g * fxRandRange(0.6, 1.2),
        b,
        flags
      );
    }
  }

  /** Emits a static glow sprite (flash / starburst). Returns the index or -1. */
  function emitGlow(
    x: number,
    y: number,
    z: number,
    life: number,
    size0: number,
    size1: number,
    r: number,
    g: number,
    b: number,
    frame: number
  ): number {
    const index = glowPool.emit(x, y, z, 0, 0, 0, life, size0, size1);
    if (index < 0) return -1;
    glowPool.frame[index] = frame;
    glowPool.r[index] = r;
    glowPool.g[index] = g;
    glowPool.b[index] = b;
    glowPool.fout[index] = 0.2;
    glowPool.rot[index] = fxRandom() * 6.283;
    glowPool.sk[index] = 1.5;
    return index;
  }

  /** Emits an expanding ground-aligned ring. Returns the index or -1. */
  function emitRing(
    x: number,
    y: number,
    z: number,
    life: number,
    size0: number,
    size1: number,
    r: number,
    g: number,
    b: number
  ): number {
    const index = glowPool.emit(x, y, z, 0, 0, 0, life, size0, size1);
    if (index < 0) return -1;
    glowPool.mode[index] = 2;
    glowPool.frame[index] = GLOW_FRAME_RING;
    glowPool.r[index] = r;
    glowPool.g[index] = g;
    glowPool.b[index] = b;
    glowPool.fout[index] = 0.15;
    glowPool.fin[index] = 0.08;
    glowPool.sk[index] = 2.2;
    glowPool.rot[index] = fxRandom() * 6.283;
    return index;
  }

  /** Throws `count` physical debris chunks from `origin` around `dir`. */
  function sprayDebris(
    origin: Vector3,
    dir: Vector3,
    count: number,
    speedMin: number,
    speedMax: number,
    sizeXMin: number,
    sizeXMax: number,
    sizeYMin: number,
    sizeYMax: number,
    sizeZMin: number,
    sizeZMax: number,
    r: number,
    g: number,
    b: number,
    spread: number,
    floorY: number
  ): void {
    for (let i = 0; i < count; i++) {
      jitterDirection(dir, spread, tmpSprayDir);
      const speed = fxRandRange(speedMin, speedMax);
      const tint = fxRandRange(0.8, 1.15);
      debrisPool.add(
        origin.x + tmpSprayDir.x * 0.02,
        origin.y + tmpSprayDir.y * 0.02,
        origin.z + tmpSprayDir.z * 0.02,
        tmpSprayDir.x * speed,
        tmpSprayDir.y * speed + 0.8,
        tmpSprayDir.z * speed,
        fxRandRange(sizeXMin, sizeXMax),
        fxRandRange(sizeYMin, sizeYMax),
        fxRandRange(sizeZMin, sizeZMax),
        r * tint,
        g * tint,
        b * tint,
        fxRandRange(3.5, 6),
        floorY
      );
    }
  }

  function sparks(point: Vector3, normal?: Vector3 | null, count = 12): void {
    tmpEmitDir.copy(normal || WORLD_UP);
    if (tmpEmitDir.lengthSq() < 1e-6) tmpEmitDir.copy(WORLD_UP);
    tmpEmitDir.normalize();
    spraySparks(point, tmpEmitDir, count, 5, 18, 0.6, 0.15, 0.5, 36, 22, 9, PARTICLE_FLAG_BOUNCE);
    emitGlow(point.x, point.y, point.z, 0.05, 0.2, 0.35, 10, 6.5, 3, GLOW_FRAME_SOFT);
  }

  function smoke(point: Vector3, options: SmokeOptions = {}): void {
    const size = options.size || 1;
    const life = options.life || 2.5;
    const rise = options.rise === undefined ? 0.6 : options.rise;
    const rgb = toRgbTriple(options.color, 0.32, 0.32, 0.33);
    const vel = options.vel;
    const shade = sunShadeAt(point, null);
    const count = options.count || 3;
    for (let i = 0; i < count; i++)
      emitSmoke(
        point.x + (fxRandom() - 0.5) * 0.2 * size,
        point.y + (fxRandom() - 0.5) * 0.2 * size,
        point.z + (fxRandom() - 0.5) * 0.2 * size,
        (vel ? vel.x : 0) + (fxRandom() - 0.5) * 0.4,
        (vel ? vel.y : 0) + fxRandom() * 0.3,
        (vel ? vel.z : 0) + (fxRandom() - 0.5) * 0.4,
        life * fxRandRange(0.75, 1.2),
        size * 0.3,
        size * fxRandRange(1, 1.5),
        rgb[0],
        rgb[1],
        rgb[2],
        options.alpha || 0.4,
        shade,
        1.2,
        rise,
        1,
        -1
      );
  }

  function dust(
    point: Vector3,
    normal?: Vector3 | null,
    scale = 1,
    r = 0.5,
    g = 0.48,
    b = 0.45
  ): number {
    tmpSurfaceNormal.copy(normal || WORLD_UP);
    if (tmpSurfaceNormal.lengthSq() < 1e-6) tmpSurfaceNormal.copy(WORLD_UP);
    tmpSurfaceNormal.normalize();
    const shade = sunShadeAt(point, tmpSurfaceNormal);
    for (let i = 0; i < 8; i++) {
      jitterDirection(tmpSurfaceNormal, 0.5, tmpSprayDir);
      const speed = fxRandRange(1, 4.5) * scale;
      const tint = fxRandRange(0.85, 1.1);
      emitSmoke(
        point.x + tmpSurfaceNormal.x * 0.03,
        point.y + tmpSurfaceNormal.y * 0.03,
        point.z + tmpSurfaceNormal.z * 0.03,
        tmpSprayDir.x * speed,
        tmpSprayDir.y * speed,
        tmpSprayDir.z * speed,
        fxRandRange(0.5, 1.1),
        0.08 * scale,
        fxRandRange(0.35, 0.7) * scale,
        r * tint,
        g * tint,
        b * tint,
        0.9,
        shade,
        3.5,
        0.15,
        0.6,
        i < 3 ? 7 : -1
      );
    }
    for (let i = 0; i < 2; i++)
      emitSmoke(
        point.x + tmpSurfaceNormal.x * 0.15,
        point.y + tmpSurfaceNormal.y * 0.15,
        point.z + tmpSurfaceNormal.z * 0.15,
        tmpSurfaceNormal.x * 0.5 + (fxRandom() - 0.5) * 0.3,
        tmpSurfaceNormal.y * 0.5 + 0.1,
        tmpSurfaceNormal.z * 0.5 + (fxRandom() - 0.5) * 0.3,
        fxRandRange(2.2, 3.6),
        0.25 * scale,
        fxRandRange(0.9, 1.5) * scale,
        r,
        g,
        b,
        0.28,
        shade,
        1.5,
        0.1,
        1,
        -1
      );
    return shade;
  }

  function debris(point: Vector3, options: DebrisOptions = {}): void {
    let rgb: [number, number, number];
    if (options.color !== undefined) rgb = toRgbTriple(options.color, 0.4, 0.4, 0.4);
    else if (options.mat) {
      let material: { color?: Color } | null = null;
      try {
        material = typeof options.mat == 'string' ? game.mats.get(options.mat) : options.mat;
      } catch {
        material = null;
      }
      rgb = toRgbTriple(material && material.color ? material.color : null, 0.4, 0.4, 0.4);
    } else rgb = toRgbTriple(null, 0.4, 0.39, 0.37);
    const r = rgb[0];
    const g = rgb[1];
    const b = rgb[2];
    const size = options.size || 0.06;
    const speed = options.speed || 5;
    tmpSurfaceNormal.copy(options.normal || WORLD_UP).normalize();
    sprayDebris(
      point,
      tmpSurfaceNormal,
      Math.min(options.count || 6, 40),
      speed * 0.4,
      speed * 1.3,
      size * 0.4,
      size * 1.2,
      size * 0.3,
      size * 0.9,
      size * 0.4,
      size * 1.2,
      r,
      g,
      b,
      options.spread || 1,
      groundHeightBelow(point)
    );
  }

  function splash(point: Vector3, scale = 1): void {
    const shade = sunShadeAt(point, WORLD_UP);
    const baseY = point.y;
    for (let i = 0; i < 5; i++) {
      const size = fxRandRange(0.35, 0.6) * scale;
      const index = emitSmoke(
        point.x + (fxRandom() - 0.5) * 0.08 * scale,
        baseY + 0.1 * scale,
        point.z + (fxRandom() - 0.5) * 0.08 * scale,
        (fxRandom() - 0.5) * 0.5,
        fxRandRange(1.6, 2.8) * Math.sqrt(scale),
        (fxRandom() - 0.5) * 0.5,
        fxRandRange(0.4, 0.65),
        size * 0.3,
        size,
        0.72,
        0.78,
        0.84,
        0.95,
        shade,
        0.5,
        -7,
        0,
        6
      );
      if (index >= 0) {
        litPool.rot[index] = (fxRandom() - 0.5) * 0.3;
        litPool.rotv[index] = 0;
        litPool.turb[index] = 0;
        litPool.sk[index] = 3;
        litPool.fout[index] = 0.4;
      }
    }
    for (let i = 0; i < 2; i++)
      emitSmoke(
        point.x,
        baseY + 0.15 * scale,
        point.z,
        (fxRandom() - 0.5) * 0.6,
        0.5,
        (fxRandom() - 0.5) * 0.6,
        fxRandRange(0.7, 1.1),
        0.2 * scale,
        0.7 * scale,
        0.7,
        0.75,
        0.8,
        0.14,
        shade,
        2,
        0,
        0.8,
        -1
      );
    const dropR = 1.9 * shade + 0.35;
    const dropG = 1.5 * shade + 0.45;
    const dropB = 1.05 * shade + 0.55;
    const dropCount = Math.round(14 * Math.min(scale, 1.6));
    for (let i = 0; i < dropCount; i++) {
      jitterDirection(WORLD_UP, 0.75, tmpSprayDir);
      const speed = fxRandRange(1.5, 4.8) * Math.sqrt(scale);
      const index = glowPool.emit(
        point.x,
        baseY + 0.03,
        point.z,
        tmpSprayDir.x * speed,
        Math.abs(tmpSprayDir.y) * speed,
        tmpSprayDir.z * speed,
        fxRandRange(0.5, 1),
        fxRandRange(0.012, 0.024),
        0.01
      );
      if (index >= 0) {
        glowPool.mode[index] = 1;
        glowPool.frame[index] = GLOW_FRAME_DOT;
        glowPool.stretch[index] = 0.012;
        glowPool.grav[index] = 9.81;
        glowPool.drag[index] = 0.4;
        glowPool.r[index] = dropR;
        glowPool.g[index] = dropG;
        glowPool.b[index] = dropB;
        glowPool.fout[index] = 0.7;
        glowPool.flags[index] = PARTICLE_FLAG_DIE_ON_GROUND;
        glowPool.sk[index] = 1;
        glowPool.gy[index] = baseY;
      }
    }
    emitRing(
      point.x,
      baseY + 0.012,
      point.z,
      0.9,
      0.12 * scale,
      1.5 * scale,
      0.3 * shade + 0.08,
      0.27 * shade + 0.09,
      0.22 * shade + 0.1
    );
    const innerRing = emitRing(
      point.x,
      baseY + 0.012,
      point.z,
      1.3,
      0.05 * scale,
      1 * scale,
      0.2 * shade + 0.05,
      0.18 * shade + 0.06,
      0.15 * shade + 0.07
    );
    if (innerRing >= 0) glowPool.fin[innerRing] = 0.35;
  }

  const impactScratch = {
    p: new Vector3()
  };
  function impact(
    point: Vector3,
    normal: Vector3 | null | undefined,
    surface: string | undefined,
    dir?: Vector3 | null,
    enemy?: unknown
  ): void {
    tmpSurfaceNormal.copy(normal || WORLD_UP);
    if (tmpSurfaceNormal.lengthSq() < 1e-6) tmpSurfaceNormal.copy(WORLD_UP);
    tmpSurfaceNormal.normalize();
    if (dir && dir.lengthSq() > 1e-6) tmpEmitDir.copy(dir).normalize();
    else tmpEmitDir.copy(tmpSurfaceNormal).negate();
    // Reflected bullet direction.
    tmpIncomingDir
      .copy(tmpEmitDir)
      .addScaledVector(tmpSurfaceNormal, -2 * tmpEmitDir.dot(tmpSurfaceNormal))
      .normalize();
    const pos = impactScratch.p.copy(point);
    if (enemy) surface = (enemy as { type?: string }).type === 'guard' ? 'flesh' : 'enemy';
    if (
      surface !== 'enemy' &&
      surface !== 'water' &&
      tmpSurfaceNormal.y > 0.7 &&
      game.ground &&
      game.ground.isPuddle
    )
      try {
        if (game.ground.isPuddle(pos.x, pos.z) && pos.y < 0.08) surface = 'water';
      } catch {}
    const far =
      (game.camera ? game.camera.position : tmpRayOrigin.set(0, 0, 0)).distanceToSquared(pos) >
      3025;
    const detail = far ? 0.5 : 1;
    const nx = tmpSurfaceNormal.x;
    const ny = tmpSurfaceNormal.y;
    const nz = tmpSurfaceNormal.z;
    switch (surface) {
      case 'metal': {
        tmpSprayDir.copy(tmpIncomingDir).addScaledVector(tmpSurfaceNormal, 0.6).normalize();
        tmpEmitDir.copy(tmpSprayDir);
        spraySparks(
          pos,
          tmpEmitDir,
          Math.round(18 * detail),
          6,
          24,
          0.55,
          0.1,
          0.38,
          40,
          25,
          10.5,
          0
        );
        spraySparks(
          pos,
          tmpEmitDir,
          2 + ((fxRandom() * 2) | 0),
          9,
          18,
          0.9,
          0.7,
          1.3,
          32,
          18,
          7,
          PARTICLE_FLAG_BOUNCE
        );
        emitGlow(
          pos.x + nx * 0.03,
          pos.y + ny * 0.03,
          pos.z + nz * 0.03,
          0.05,
          0.25,
          0.45,
          16,
          11,
          5.5,
          GLOW_FRAME_SOFT
        );
        emitGlow(
          pos.x + nx * 0.04,
          pos.y + ny * 0.04,
          pos.z + nz * 0.04,
          0.04,
          0.35,
          0.5,
          9,
          6,
          2.6,
          GLOW_FRAME_STARBURST_A + ((fxRandom() * 2) | 0)
        );
        if (time - lastImpactLightTime > 0.09) {
          lastImpactLightTime = time;
          tmpRayOrigin.copy(pos).addScaledVector(tmpSurfaceNormal, 0.12);
          flashLight(tmpRayOrigin, 0xffc070, 10, 5, 0.05);
        }
        const shade = sunShadeAt(pos, tmpSurfaceNormal);
        for (let i = 0; i < 2; i++)
          emitSmoke(
            pos.x + nx * 0.04,
            pos.y + ny * 0.04,
            pos.z + nz * 0.04,
            nx * 0.8 + (fxRandom() - 0.5) * 0.5,
            ny * 0.8 + 0.2,
            nz * 0.8 + (fxRandom() - 0.5) * 0.5,
            fxRandRange(0.5, 0.9),
            0.06,
            fxRandRange(0.3, 0.5),
            0.4,
            0.4,
            0.41,
            0.4,
            shade,
            2.5,
            0.3,
            0.8,
            -1
          );
        if (!far)
          sprayDebris(
            pos,
            tmpSurfaceNormal,
            2,
            1.5,
            4,
            0.012,
            0.03,
            0.003,
            0.005,
            0.01,
            0.025,
            0.2,
            0.21,
            0.23,
            0.8,
            groundHeightBelow(pos)
          );
        decalPool.add(pos, tmpSurfaceNormal, 'bullet_metal');
        break;
      }
      case 'wood': {
        const shade = dust(pos, tmpSurfaceNormal, 0.75, 0.5, 0.42, 0.32);
        sprayDebris(
          pos,
          tmpSurfaceNormal,
          far ? 3 : 7,
          2,
          6,
          0.004,
          0.009,
          0.03,
          0.1,
          0.004,
          0.012,
          0.62,
          0.5,
          0.33,
          0.7,
          groundHeightBelow(pos)
        );
        if (shade > 0.5 && fxRandom() < 0.3)
          emitGlow(pos.x, pos.y, pos.z, 0.04, 0.1, 0.2, 3, 2, 1, GLOW_FRAME_SOFT);
        decalPool.add(pos, tmpSurfaceNormal, 'bullet_wood');
        break;
      }
      case 'water': {
        splash(pos, 1);
        break;
      }
      case 'rubber':
      case 'dirt': {
        const shade = sunShadeAt(pos, tmpSurfaceNormal);
        const isDirt = surface === 'dirt';
        const r = isDirt ? 0.3 : 0.14;
        const g = isDirt ? 0.25 : 0.14;
        const b = isDirt ? 0.19 : 0.14;
        for (let i = 0; i < 5; i++) {
          jitterDirection(tmpSurfaceNormal, 0.6, tmpSprayDir);
          const speed = fxRandRange(0.6, 2.6);
          emitSmoke(
            pos.x + nx * 0.03,
            pos.y + ny * 0.03,
            pos.z + nz * 0.03,
            tmpSprayDir.x * speed,
            tmpSprayDir.y * speed,
            tmpSprayDir.z * speed,
            fxRandRange(0.5, 1),
            0.07,
            fxRandRange(0.3, 0.55),
            r,
            g,
            b,
            0.85,
            shade,
            3.5,
            0.1,
            0.6,
            i < 2 ? 7 : -1
          );
        }
        sprayDebris(
          pos,
          tmpSurfaceNormal,
          3,
          1.5,
          4,
          0.01,
          0.03,
          0.008,
          0.02,
          0.01,
          0.03,
          r * 0.8,
          g * 0.8,
          b * 0.8,
          0.7,
          groundHeightBelow(pos)
        );
        decalPool.add(pos, tmpSurfaceNormal, 'soot', 0.2, 1, 0.8);
        break;
      }
      case 'glass': {
        for (let i = 0; i < 12; i++) {
          jitterDirection(tmpSurfaceNormal, 0.9, tmpSprayDir);
          const speed = fxRandRange(1.5, 6);
          const index = glowPool.emit(
            pos.x,
            pos.y,
            pos.z,
            tmpSprayDir.x * speed,
            tmpSprayDir.y * speed,
            tmpSprayDir.z * speed,
            fxRandRange(0.4, 0.9),
            fxRandRange(0.012, 0.02),
            0.008
          );
          if (index >= 0) {
            glowPool.mode[index] = 1;
            glowPool.frame[index] = GLOW_FRAME_DOT;
            glowPool.stretch[index] = 0.01;
            glowPool.grav[index] = 9.81;
            glowPool.r[index] = 2.6;
            glowPool.g[index] = 2.7;
            glowPool.b[index] = 2.8;
            glowPool.flags[index] = PARTICLE_FLAG_DIE_ON_GROUND;
            glowPool.ramp[index] = 3;
          }
        }
        sprayDebris(
          pos,
          tmpSurfaceNormal,
          4,
          1.5,
          5,
          0.01,
          0.03,
          0.002,
          0.004,
          0.01,
          0.03,
          0.62,
          0.72,
          0.74,
          0.8,
          groundHeightBelow(pos)
        );
        emitSmoke(
          pos.x,
          pos.y,
          pos.z,
          nx * 0.6,
          ny * 0.6 + 0.2,
          nz * 0.6,
          0.6,
          0.08,
          0.4,
          0.75,
          0.8,
          0.82,
          0.2,
          sunShadeAt(pos, tmpSurfaceNormal),
          2.5,
          0.2,
          0.8,
          -1
        );
        decalPool.add(pos, tmpSurfaceNormal, 'bullet_glass');
        break;
      }
      case 'flesh': {
        // Human target: dark blood mist and a puff of torn fabric, no sparks.
        tmpSprayDir.copy(tmpIncomingDir).addScaledVector(tmpSurfaceNormal, 0.5).normalize();
        dust(pos, tmpSprayDir, 0.32 * (far ? 0.7 : 1), 0.26, 0.025, 0.03);
        dust(pos, tmpSurfaceNormal, 0.16, 0.2, 0.21, 0.24);
        break;
      }
      case 'enemy': {
        tmpSprayDir.copy(tmpIncomingDir).addScaledVector(tmpSurfaceNormal, 0.8).normalize();
        tmpEmitDir.copy(tmpSprayDir);
        spraySparks(
          pos,
          tmpEmitDir,
          Math.round(13 * detail),
          5,
          20,
          0.9,
          0.12,
          0.45,
          42,
          29,
          14,
          0
        );
        spraySparks(pos, tmpEmitDir, 2, 6, 12, 1, 0.6, 1.1, 32, 18, 7, PARTICLE_FLAG_BOUNCE);
        emitGlow(pos.x, pos.y, pos.z, 0.06, 0.3, 0.55, 18, 12, 6, GLOW_FRAME_SOFT);
        emitGlow(
          pos.x,
          pos.y,
          pos.z,
          0.04,
          0.3,
          0.45,
          8,
          5,
          2.4,
          GLOW_FRAME_STARBURST_A + ((fxRandom() * 2) | 0)
        );
        if (time - lastImpactLightTime > 0.09) {
          lastImpactLightTime = time;
          flashLight(pos, 0xffb060, 8, 4.5, 0.05);
        }
        const shade = sunShadeAt(pos, tmpSurfaceNormal);
        for (let i = 0; i < 2; i++)
          emitSmoke(
            pos.x,
            pos.y,
            pos.z,
            nx * 0.5 + (fxRandom() - 0.5) * 0.4,
            ny * 0.5 + 0.3,
            nz * 0.5 + (fxRandom() - 0.5) * 0.4,
            fxRandRange(0.6, 1.1),
            0.06,
            fxRandRange(0.3, 0.5),
            0.13,
            0.13,
            0.14,
            0.65,
            shade,
            2.2,
            0.5,
            0.9,
            -1
          );
        if (!far) {
          const reddish = fxRandom() < 0.35;
          sprayDebris(
            pos,
            tmpSurfaceNormal,
            3,
            2,
            6,
            0.012,
            0.035,
            0.004,
            0.008,
            0.012,
            0.03,
            0.6,
            reddish ? 0.2 : 0.62,
            reddish ? 0.05 : 0.64,
            0.8,
            groundHeightBelow(pos)
          );
        }
        break;
      }
      default: {
        dust(pos, tmpSurfaceNormal, 1, 0.52, 0.5, 0.47);
        sprayDebris(
          pos,
          tmpSurfaceNormal,
          far ? 2 : 4,
          1.5,
          5.5,
          0.012,
          0.035,
          0.008,
          0.02,
          0.012,
          0.035,
          0.42,
          0.41,
          0.39,
          0.7,
          groundHeightBelow(pos)
        );
        tmpSprayDir.copy(tmpIncomingDir).addScaledVector(tmpSurfaceNormal, 0.7).normalize();
        tmpEmitDir.copy(tmpSprayDir);
        for (let i = 0; i < 4; i++) {
          jitterDirection(tmpEmitDir, 0.5, tmpSprayDir);
          const speed = fxRandRange(3, 9);
          const index = emitSmoke(
            pos.x,
            pos.y,
            pos.z,
            tmpSprayDir.x * speed,
            tmpSprayDir.y * speed,
            tmpSprayDir.z * speed,
            fxRandRange(0.25, 0.45),
            0.03,
            0.09,
            0.6,
            0.58,
            0.54,
            0.7,
            1,
            2,
            -6,
            0.2,
            7
          );
          if (index >= 0) litPool.turb[index] = 0;
        }
        if (fxRandom() < 0.3) spraySparks(pos, tmpEmitDir, 3, 4, 10, 0.6, 0.08, 0.2, 26, 15, 6, 0);
        decalPool.add(pos, tmpSurfaceNormal, 'bullet_concrete');
      }
    }
  }

  function tracer(from: Vector3, to: Vector3, options: TracerOptions = {}): void {
    const rgb = toRgbTriple(options.color, 1, 0.8, 0.46);
    const intensity = options.intensity || 16;
    tracers.add(
      from,
      to,
      rgb[0] * intensity,
      rgb[1] * intensity,
      rgb[2] * intensity,
      options.speed || 260,
      options.width || 0.024
    );
    if (time - lastTrailTime > 0.07 && options.trail !== false) {
      lastTrailTime = time;
      tmpSprayDir.subVectors(to, from);
      const length = tmpSprayDir.length();
      if (length > 2) {
        tmpSprayDir.multiplyScalar(1 / length);
        const puffCount = 5;
        const trailLength = Math.min(length, 7);
        const shade = sunShadeAt(from, null);
        for (let i = 0; i < puffCount; i++) {
          const along = 0.6 + ((i + fxRandom()) / puffCount) * (trailLength - 0.6);
          const index = emitSmoke(
            from.x + tmpSprayDir.x * along,
            from.y + tmpSprayDir.y * along,
            from.z + tmpSprayDir.z * along,
            tmpSprayDir.x * 0.6,
            0.05,
            tmpSprayDir.z * 0.6,
            fxRandRange(0.45, 0.8),
            0.04,
            fxRandRange(0.12, 0.2),
            0.6,
            0.6,
            0.62,
            0.1,
            shade,
            2,
            0.1,
            0.7,
            -1
          );
          if (index >= 0) litPool.fin[index] = 0.25;
        }
      }
    }
  }

  function muzzleFlash(
    pos: Vector3,
    dir: Vector3 | null | undefined,
    options: MuzzleFlashOptions = {}
  ): void {
    const scale = options.scale || 1;
    tmpEmitDir.copy(dir || WORLD_UP);
    if (tmpEmitDir.lengthSq() < 1e-6) tmpEmitDir.set(0, 0, -1);
    tmpEmitDir.normalize();
    const rgb = toRgbTriple(options.color, 1, 0.68, 0.32);
    const x = pos.x;
    const y = pos.y;
    const z = pos.z;
    const r = rgb[0];
    const g = rgb[1];
    const b = rgb[2];
    emitGlow(
      x + tmpEmitDir.x * 0.1 * scale,
      y + tmpEmitDir.y * 0.1 * scale,
      z + tmpEmitDir.z * 0.1 * scale,
      0.045,
      0.75 * scale,
      1.15 * scale,
      34 * r,
      34 * g,
      34 * b,
      GLOW_FRAME_STARBURST_A
    );
    emitGlow(
      x + tmpEmitDir.x * 0.14 * scale,
      y + tmpEmitDir.y * 0.14 * scale,
      z + tmpEmitDir.z * 0.14 * scale,
      0.035,
      0.5 * scale,
      0.85 * scale,
      22 * r,
      22 * g,
      22 * b,
      GLOW_FRAME_STARBURST_A + 1
    );
    emitGlow(
      x + tmpEmitDir.x * 0.05 * scale,
      y + tmpEmitDir.y * 0.05 * scale,
      z + tmpEmitDir.z * 0.05 * scale,
      0.045,
      0.13 * scale,
      0.2 * scale,
      22,
      22 * (g + 0.25),
      22 * (b + 0.3),
      GLOW_FRAME_SOFT
    );
    emitGlow(x, y, z, 0.05, 0.8 * scale, 1.1 * scale, 0.4 * r, 0.4 * g, 0.4 * b, GLOW_FRAME_SOFT);
    const cone = glowPool.emit(
      x + tmpEmitDir.x * 0.4 * scale,
      y + tmpEmitDir.y * 0.4 * scale,
      z + tmpEmitDir.z * 0.4 * scale,
      -tmpEmitDir.x,
      -tmpEmitDir.y,
      -tmpEmitDir.z,
      0.04,
      0.11 * scale,
      0.14 * scale
    );
    if (cone >= 0) {
      glowPool.mode[cone] = 1;
      glowPool.frame[cone] = GLOW_FRAME_FLASH_CONE;
      glowPool.stretch[cone] = 0.9 * scale;
      glowPool.r[cone] = 18 * r;
      glowPool.g[cone] = 18 * g;
      glowPool.b[cone] = 18 * b;
      glowPool.fout[cone] = 0.3;
    }
    for (let i = 0; i < 3; i++) {
      jitterDirection(tmpEmitDir, 0.25, tmpSprayDir);
      const speed = fxRandRange(8, 22);
      emitSpark(
        x,
        y,
        z,
        tmpSprayDir.x * speed,
        tmpSprayDir.y * speed,
        tmpSprayDir.z * speed,
        fxRandRange(0.08, 0.22),
        0.012,
        30,
        18,
        7,
        0
      );
    }
    emitSmoke(
      x + tmpEmitDir.x * 0.2,
      y + tmpEmitDir.y * 0.2,
      z + tmpEmitDir.z * 0.2,
      tmpEmitDir.x * 1.5,
      tmpEmitDir.y * 1.5 + 0.2,
      tmpEmitDir.z * 1.5,
      fxRandRange(0.5, 0.9),
      0.08 * scale,
      0.45 * scale,
      0.5,
      0.5,
      0.52,
      0.16,
      1,
      3,
      0.3,
      0.8,
      -1
    );
    tmpRayOrigin.copy(pos).addScaledVector(tmpEmitDir, 0.25);
    flashLight(tmpRayOrigin, 0xffb060, 16 * scale, 7 * scale, 0.05);
  }

  function shell(pos: Vec3Like, vel: Vec3Like): void {
    shellPool.add(pos, vel);
  }

  const explosionEvent: ExplosionEvent = {
    pos: new Vector3(),
    size: 1
  };
  function explosion(point: Vector3, size = 1): void {
    const s = Math.max(0.4, Math.min(size, 4));
    const x = point.x;
    const y = point.y;
    const z = point.z;
    const sqrtS = Math.sqrt(s);
    const groundY = groundHeightBelow(point);
    const nearGround = y - groundY < 1.4 * s;
    const shade = sunShadeAt(point, WORLD_UP);
    tmpRayOrigin.set(x, y + 0.4, z);
    flashLight(tmpRayOrigin, 0xffe2b0, 320 * s, 10 + 9 * s, 0.08);
    flashLight(tmpRayOrigin, 0xff8a30, 55 * s, 8 + 6 * s, 0.45);
    const centerY = y + 0.35 * s;
    emitGlow(x, centerY, z, 0.055, 1.5 * s, 2.3 * s, 16, 13.5, 9.5, GLOW_FRAME_SOFT);
    emitGlow(
      x,
      centerY,
      z,
      0.05,
      2.6 * s,
      4.2 * s,
      7,
      5,
      2.4,
      GLOW_FRAME_STARBURST_A + ((fxRandom() * 2) | 0)
    );
    emitGlow(x, centerY, z, 0.3, 3.5 * s, 5.5 * s, 0.35, 0.2, 0.08, GLOW_FRAME_SOFT);

    // Fireball puffs (lit, hot colour ramp).
    const fireballCount = Math.round(13 + 5 * s);
    for (let i = 0; i < fireballCount; i++) {
      jitterDirection(WORLD_UP, 1.6, tmpSprayDir);
      if (nearGround && tmpSprayDir.y < -0.1) tmpSprayDir.y = -tmpSprayDir.y * 0.5;
      const speed = fxRandRange(2.2, 7.5) * sqrtS;
      const tint = fxRandRange(0.7, 1.15);
      const index = litPool.emit(
        x + tmpSprayDir.x * 0.3 * s,
        centerY + tmpSprayDir.y * 0.3 * s,
        z + tmpSprayDir.z * 0.3 * s,
        tmpSprayDir.x * speed,
        tmpSprayDir.y * speed + 1.4,
        tmpSprayDir.z * speed,
        fxRandRange(0.55, 1.05),
        0.85 * s,
        fxRandRange(1.8, 2.7) * s
      );
      if (index >= 0) {
        litPool.frame[index] = i % 4 === 0 ? 7 : (fxRandom() * 6) | 0;
        litPool.ramp[index] = 2;
        litPool.r[index] = 5.8 * tint;
        litPool.g[index] = 2.4 * tint;
        litPool.b[index] = 0.5 * tint;
        litPool.a[index] = 0.96;
        litPool.shade[index] = 2 + shade;
        litPool.drag[index] = 4;
        litPool.grav[index] = -2.6;
        litPool.wind[index] = 0.6;
        litPool.turb[index] = 1.5;
        litPool.rot[index] = fxRandom() * 6.283;
        litPool.rotv[index] = (fxRandom() - 0.5) * 2.5;
        litPool.sk[index] = 3;
        litPool.fin[index] = 0;
        litPool.fout[index] = 0.6;
      }
    }

    // Additive fireball glow.
    for (let i = 0; i < 5; i++) {
      jitterDirection(WORLD_UP, 1.4, tmpSprayDir);
      const speed = fxRandRange(2, 5) * sqrtS;
      const index = glowPool.emit(
        x + tmpSprayDir.x * 0.3 * s,
        centerY + tmpSprayDir.y * 0.3 * s,
        z + tmpSprayDir.z * 0.3 * s,
        tmpSprayDir.x * speed,
        Math.abs(tmpSprayDir.y) * speed + 1.2,
        tmpSprayDir.z * speed,
        fxRandRange(0.3, 0.55),
        0.6 * s,
        fxRandRange(1.2, 1.8) * s
      );
      if (index >= 0) {
        glowPool.frame[index] = GLOW_FRAME_FIREBALL;
        glowPool.ramp[index] = 2;
        glowPool.r[index] = 2.4;
        glowPool.g[index] = 1.1;
        glowPool.b[index] = 0.3;
        glowPool.drag[index] = 4;
        glowPool.grav[index] = -2.5;
        glowPool.rot[index] = fxRandom() * 6.283;
        glowPool.sk[index] = 3;
        glowPool.fout[index] = 0.4;
      }
    }

    // Dark smoke, alternating fast outer and slow inner puffs.
    const smokeCount = Math.round(11 + 5 * s);
    for (let i = 0; i < smokeCount; i++) {
      const outer = i % 2 === 0;
      jitterDirection(WORLD_UP, 1.4, tmpSprayDir);
      if (nearGround && tmpSprayDir.y < 0) tmpSprayDir.y = -tmpSprayDir.y * 0.4;
      const speed = (outer ? fxRandRange(4.5, 9) : fxRandRange(1.5, 5)) * sqrtS;
      const gray = fxRandRange(0.04, 0.1);
      const offset = outer ? 0.75 : 0.3;
      const index = emitSmoke(
        x + tmpSprayDir.x * offset * s,
        centerY + tmpSprayDir.y * offset * s,
        z + tmpSprayDir.z * offset * s,
        tmpSprayDir.x * speed,
        tmpSprayDir.y * speed + 0.8,
        tmpSprayDir.z * speed,
        fxRandRange(2.8, 4.8),
        (outer ? 0.8 : 1.2) * s,
        fxRandRange(2.6, 4.2) * s,
        gray,
        gray * 0.95,
        gray * 0.9,
        outer ? 0.7 : 0.8,
        shade,
        3.4,
        fxRandRange(0.8, 1.7),
        1,
        i % 3 === 0 ? 7 : -1
      );
      if (index >= 0) {
        litPool.fin[index] = outer ? 0.025 : 0.16;
        litPool.fout[index] = 0.35;
        litPool.turb[index] = 1.2;
      }
    }
    startEmitter(x, y + 0.3 * s, z, 'smolder', 1.3 + 0.3 * s, s, shade);

    // Sparks.
    const sparkCount = Math.min(90, Math.round(34 * s));
    for (let i = 0; i < sparkCount; i++) {
      jitterDirection(WORLD_UP, 1.5, tmpSprayDir);
      if (nearGround && tmpSprayDir.y < 0) tmpSprayDir.y = -tmpSprayDir.y;
      const speed = fxRandRange(6, 26) * sqrtS;
      const index = emitSpark(
        x,
        y + 0.05,
        z,
        tmpSprayDir.x * speed,
        tmpSprayDir.y * speed,
        tmpSprayDir.z * speed,
        fxRandRange(0.5, 1.5),
        fxRandRange(0.014, 0.028),
        40,
        23,
        8,
        PARTICLE_FLAG_BOUNCE
      );
      if (index >= 0) {
        glowPool.drag[index] = 1.4;
        glowPool.stretch[index] = 0.035;
      }
    }

    // Slow rising embers.
    for (let i = 0; i < 10 * s; i++) {
      jitterDirection(WORLD_UP, 1.2, tmpSprayDir);
      const speed = fxRandRange(1, 5);
      const index = glowPool.emit(
        x,
        y + 0.3,
        z,
        tmpSprayDir.x * speed,
        Math.abs(tmpSprayDir.y) * speed + 1,
        tmpSprayDir.z * speed,
        fxRandRange(1.4, 3),
        0.035,
        0.02
      );
      if (index >= 0) {
        glowPool.frame[index] = GLOW_FRAME_SOFT;
        glowPool.ramp[index] = 3;
        glowPool.r[index] = 9;
        glowPool.g[index] = 4;
        glowPool.b[index] = 1;
        glowPool.drag[index] = 1.2;
        glowPool.grav[index] = 0.6;
        glowPool.turb[index] = 3;
        glowPool.wind[index] = 1;
        glowPool.fout[index] = 0.5;
      }
    }

    // Ground shock ring, dust skirt and scorch decal.
    if (nearGround) {
      const ringY = groundY + 0.015;
      emitRing(x, ringY, z, 0.32, 0.6 * s, 9 * s, 1.6, 1.2, 0.75);
      const skirtCount = Math.round(12 + 3 * s);
      for (let i = 0; i < skirtCount; i++) {
        const angle = ((i + fxRandom()) / skirtCount) * 6.283;
        const speed = fxRandRange(5, 10) * sqrtS;
        const gray = fxRandRange(0.42, 0.55);
        const index = emitSmoke(
          x + Math.cos(angle) * 0.4 * s,
          ringY + 0.2,
          z + Math.sin(angle) * 0.4 * s,
          Math.cos(angle) * speed,
          fxRandRange(0.2, 0.9),
          Math.sin(angle) * speed,
          fxRandRange(1.2, 2.2),
          0.4 * s,
          fxRandRange(1.2, 1.9) * s,
          gray,
          gray * 0.96,
          gray * 0.9,
          0.26,
          shade,
          3,
          0.15,
          0.7,
          -1
        );
        if (index >= 0) litPool.fin[index] = 0.1;
      }
      tmpGroundPoint.set(x, groundY, z);
      decalPool.add(tmpGroundPoint, WORLD_UP, 'scorch', 2.3 * s, 1, 0.92);
    }
    tmpGroundPoint.set(x, Math.max(y, groundY + 0.1), z);
    sprayDebris(
      tmpGroundPoint,
      WORLD_UP,
      Math.round(13 + 6 * s),
      4,
      13 * sqrtS,
      0.04,
      0.13,
      0.025,
      0.08,
      0.04,
      0.13,
      0.07,
      0.066,
      0.062,
      1.1,
      groundY
    );
    explosionEvent.pos.copy(point);
    explosionEvent.size = size;
    game.events.emit('explosion', explosionEvent);
  }

  // Persistent emitter pool.
  const emitters: FxEmitter[] = [];
  for (let i = 0; i < 24; i++) {
    const emitter: FxEmitter = {
      active: false,
      kind: 'steam',
      pos: new Vector3(),
      acc: 0,
      acc2: 0,
      ttl: Infinity,
      scale: 1,
      shade: 1,
      t: 0,
      light: null,
      drop: -1,
      stop: () => {
        emitter.active = false;
        if (emitter.light) {
          emitter.light.release();
          emitter.light = null;
        }
      },
      setPos: (pos) => {
        emitter.pos.copy(pos);
      }
    };
    emitters.push(emitter);
  }
  const deadEmitter: FxEmitterHandle = {
    active: false,
    pos: new Vector3(),
    stop() {},
    setPos() {}
  };
  function startEmitter(
    x: number,
    y: number,
    z: number,
    kind: FxEmitterKind,
    ttl: number,
    scale: number,
    shade: number | undefined
  ): FxEmitterHandle {
    let emitter: FxEmitter | null = null;
    for (let i = 0; i < emitters.length; i++)
      if (!emitters[i].active) {
        emitter = emitters[i];
        break;
      }
    if (!emitter) return deadEmitter;
    emitter.active = true;
    emitter.kind = kind;
    emitter.pos.set(x, y, z);
    emitter.acc = 0;
    emitter.acc2 = 0;
    emitter.ttl = ttl;
    emitter.scale = scale;
    emitter.t = 0;
    emitter.drop = -1;
    emitter.shade = shade === undefined ? sunShadeAt(emitter.pos, null) : shade;
    if (kind === 'fire') {
      const lightPool = getLightPool();
      emitter.light = lightPool && lightPool.acquire ? lightPool.acquire() : null;
      if (emitter.light) {
        emitter.light.light.color.set(0xff8a3a);
        emitter.light.light.distance = 9;
        emitter.light.light.position.set(x, y + 0.5, z);
      }
    }
    return emitter;
  }
  function addEmitter(
    pos: Vec3Like,
    kind: FxEmitterKind = 'steam',
    options: EmitterOptions = {}
  ): FxEmitterHandle {
    return startEmitter(
      pos.x,
      pos.y,
      pos.z,
      kind,
      options.ttl || Infinity,
      options.scale || 1,
      undefined
    );
  }
  function updateEmitters(dt: number): void {
    for (let i = 0; i < emitters.length; i++) {
      const emitter = emitters[i];
      if (!emitter.active) continue;
      emitter.t += dt;
      if (emitter.t > emitter.ttl) {
        emitter.stop();
        continue;
      }
      const x = emitter.pos.x;
      const y = emitter.pos.y;
      const z = emitter.pos.z;
      const scale = emitter.scale;
      if (emitter.kind === 'steam') {
        emitter.acc += dt * 13;
        while (emitter.acc > 1) {
          emitter.acc -= 1;
          const index = emitSmoke(
            x + (fxRandom() - 0.5) * 0.08,
            y,
            z + (fxRandom() - 0.5) * 0.08,
            (fxRandom() - 0.5) * 0.4,
            fxRandRange(1.4, 2.4),
            (fxRandom() - 0.5) * 0.4,
            fxRandRange(1.8, 3),
            0.12 * scale,
            fxRandRange(0.8, 1.3) * scale,
            0.8,
            0.82,
            0.85,
            0.2,
            emitter.shade,
            1.3,
            0.5,
            1,
            -1
          );
          if (index >= 0) {
            litPool.fin[index] = 0.12;
            litPool.turb[index] = 0.9;
          }
        }
      } else if (emitter.kind === 'smolder') {
        emitter.acc += dt * 9 * (1 - emitter.t / emitter.ttl);
        while (emitter.acc > 1) {
          emitter.acc -= 1;
          const gray = fxRandRange(0.05, 0.11);
          const index = emitSmoke(
            x + (fxRandom() - 0.5) * 0.5 * scale,
            y,
            z + (fxRandom() - 0.5) * 0.5 * scale,
            (fxRandom() - 0.5) * 0.6,
            fxRandRange(1.2, 2.4),
            (fxRandom() - 0.5) * 0.6,
            fxRandRange(2.4, 3.8),
            0.5 * scale,
            fxRandRange(1.6, 2.6) * scale,
            gray,
            gray,
            gray,
            0.6,
            emitter.shade,
            1,
            0.9,
            1,
            -1
          );
          if (index >= 0) {
            litPool.fin[index] = 0.12;
            litPool.turb[index] = 1;
          }
        }
      } else if (emitter.kind === 'embers') {
        emitter.acc += dt * 8;
        while (emitter.acc > 1) {
          emitter.acc -= 1;
          const index = glowPool.emit(
            x + (fxRandom() - 0.5) * 0.4 * scale,
            y,
            z + (fxRandom() - 0.5) * 0.4 * scale,
            (fxRandom() - 0.5) * 0.6,
            fxRandRange(0.6, 1.8),
            (fxRandom() - 0.5) * 0.6,
            fxRandRange(1.5, 3.2),
            fxRandRange(0.02, 0.04),
            0.012
          );
          if (index >= 0) {
            glowPool.frame[index] = GLOW_FRAME_SOFT;
            glowPool.ramp[index] = 3;
            glowPool.r[index] = 10;
            glowPool.g[index] = 4.2;
            glowPool.b[index] = 1;
            glowPool.drag[index] = 0.8;
            glowPool.grav[index] = -0.5;
            glowPool.turb[index] = 3.5;
            glowPool.wind[index] = 1;
            glowPool.fout[index] = 0.5;
          }
        }
      } else if (emitter.kind === 'fire') {
        emitter.acc += dt * 24;
        while (emitter.acc > 1) {
          emitter.acc -= 1;
          const index = glowPool.emit(
            x + (fxRandom() - 0.5) * 0.3 * scale,
            y + 0.1 * scale,
            z + (fxRandom() - 0.5) * 0.3 * scale,
            (fxRandom() - 0.5) * 0.5,
            fxRandRange(1.2, 2.6) * scale,
            (fxRandom() - 0.5) * 0.5,
            fxRandRange(0.35, 0.65),
            0.45 * scale,
            fxRandRange(0.2, 0.35) * scale
          );
          if (index >= 0) {
            glowPool.frame[index] = GLOW_FRAME_FIREBALL;
            glowPool.ramp[index] = 2;
            glowPool.r[index] = 9;
            glowPool.g[index] = 5.5;
            glowPool.b[index] = 2.2;
            glowPool.drag[index] = 1;
            glowPool.rot[index] = fxRandom() * 6.283;
            glowPool.rotv[index] = (fxRandom() - 0.5) * 4;
            glowPool.fin[index] = 0.12;
            glowPool.fout[index] = 0.4;
            glowPool.wind[index] = 1;
            glowPool.turb[index] = 2;
          }
        }
        emitter.acc2 += dt * 4;
        while (emitter.acc2 > 1) {
          emitter.acc2 -= 1;
          const gray = fxRandRange(0.05, 0.1);
          const smokeIndex = emitSmoke(
            x,
            y + 0.8 * scale,
            z,
            (fxRandom() - 0.5) * 0.4,
            fxRandRange(1.2, 2),
            (fxRandom() - 0.5) * 0.4,
            fxRandRange(2.2, 3.4),
            0.3 * scale,
            fxRandRange(1.1, 1.8) * scale,
            gray,
            gray,
            gray,
            0.5,
            emitter.shade,
            0.9,
            0.8,
            1,
            -1
          );
          if (smokeIndex >= 0) {
            litPool.fin[smokeIndex] = 0.2;
            litPool.turb[smokeIndex] = 1;
          }
          const emberIndex = glowPool.emit(
            x + (fxRandom() - 0.5) * 0.3,
            y + 0.3,
            z + (fxRandom() - 0.5) * 0.3,
            fxRandom() - 0.5,
            fxRandRange(1.5, 3),
            fxRandom() - 0.5,
            fxRandRange(1, 2.2),
            0.03,
            0.012
          );
          if (emberIndex >= 0) {
            glowPool.frame[emberIndex] = GLOW_FRAME_SOFT;
            glowPool.ramp[emberIndex] = 3;
            glowPool.r[emberIndex] = 10;
            glowPool.g[emberIndex] = 4.2;
            glowPool.b[emberIndex] = 1;
            glowPool.drag[emberIndex] = 0.8;
            glowPool.grav[emberIndex] = -0.6;
            glowPool.turb[emberIndex] = 4;
            glowPool.wind[emberIndex] = 1;
          }
        }
        if (emitter.light)
          emitter.light.light.intensity =
            (14 + 6 * Math.sin(emitter.t * 23) + 4 * Math.sin(emitter.t * 37.7)) * scale;
      } else if (emitter.kind === 'drip') {
        emitter.acc += dt * 1.6;
        if (emitter.drop >= 0) {
          emitter.drop -= dt;
          if (emitter.drop < 0) {
            // The falling drop just hit the ground: ripple ring and a few droplets.
            const shade = emitter.shade;
            emitRing(
              x,
              0.014,
              z,
              0.8,
              0.05,
              0.55,
              0.4 * shade + 0.14,
              0.36 * shade + 0.16,
              0.3 * shade + 0.18
            );
            for (let j = 0; j < 3; j++) {
              jitterDirection(WORLD_UP, 0.7, tmpSprayDir);
              const index = glowPool.emit(
                x,
                0.03,
                z,
                tmpSprayDir.x * 1.2,
                Math.abs(tmpSprayDir.y) * 1.6,
                tmpSprayDir.z * 1.2,
                0.35,
                0.012,
                0.008
              );
              if (index >= 0) {
                glowPool.mode[index] = 1;
                glowPool.frame[index] = GLOW_FRAME_DOT;
                glowPool.stretch[index] = 0.012;
                glowPool.grav[index] = 9.81;
                glowPool.r[index] = 1.6 * shade + 0.3;
                glowPool.g[index] = 1.3 * shade + 0.4;
                glowPool.b[index] = 0.9 * shade + 0.5;
                glowPool.flags[index] = PARTICLE_FLAG_DIE_ON_GROUND;
              }
            }
          }
        }
        while (emitter.acc > 1) {
          emitter.acc -= 1 + fxRandom() * 0.6;
          const fallTime = Math.sqrt((2 * Math.max(y, 0.05)) / 9.81);
          const index = glowPool.emit(x, y, z, 0, -0.2, 0, fallTime + 0.05, 0.014, 0.014);
          if (index >= 0) {
            glowPool.mode[index] = 1;
            glowPool.frame[index] = GLOW_FRAME_DOT;
            glowPool.stretch[index] = 0.02;
            glowPool.grav[index] = 9.81;
            glowPool.r[index] = 1.4 * emitter.shade + 0.4;
            glowPool.g[index] = 1.2 * emitter.shade + 0.5;
            glowPool.b[index] = 0.9 * emitter.shade + 0.6;
            glowPool.flags[index] = PARTICLE_FLAG_DIE_ON_GROUND;
            glowPool.fout[index] = 0.98;
          }
          emitter.drop = fallTime;
        }
      }
    }
  }

  game.events.on<ImpactEvent | null | undefined>('impact', (event) => {
    if (!event || !event.point) return;
    impact(event.point, event.normal, event.surface, event.dir, event.enemy);
  });
  const isPuddleAt = (x: number, z: number): boolean => {
    try {
      return !!(game.ground && game.ground.isPuddle && game.ground.isPuddle(x, z));
    } catch {
      return false;
    }
  };
  game.events.on<{ pos?: Vector3; surface?: string; sprint?: boolean } | null | undefined>(
    'player:step',
    (event) => {
      const pos = (event && event.pos) || (game.player && game.player.pos);
      if (pos && ((event && event.surface === 'water') || isPuddleAt(pos.x, pos.z))) {
        tmpGroundPoint.set(pos.x, Math.max(0, pos.y), pos.z);
        splash(tmpGroundPoint, event && event.sprint ? 0.55 : 0.4);
      }
    }
  );
  game.events.on<{ surface?: string; speed?: number } | null | undefined>(
    'player:land',
    (event) => {
      const pos = game.player && game.player.pos;
      if (pos) {
        tmpGroundPoint.set(pos.x, Math.max(0, pos.y), pos.z);
        if ((event && event.surface === 'water') || isPuddleAt(pos.x, pos.z))
          splash(tmpGroundPoint, 0.9);
        else if (event && event.speed !== undefined && event.speed > 5) {
          const shade = sunShadeAt(tmpGroundPoint, WORLD_UP);
          for (let i = 0; i < 6; i++) {
            const angle = fxRandom() * 6.283;
            emitSmoke(
              tmpGroundPoint.x + Math.cos(angle) * 0.2,
              tmpGroundPoint.y + 0.08,
              tmpGroundPoint.z + Math.sin(angle) * 0.2,
              Math.cos(angle) * 1.6,
              0.3,
              Math.sin(angle) * 1.6,
              fxRandRange(0.7, 1.2),
              0.15,
              fxRandRange(0.5, 0.8),
              0.45,
              0.44,
              0.42,
              0.22,
              shade,
              3,
              0.1,
              0.8,
              -1
            );
          }
        }
      }
    }
  );

  function update(dt: number): void {
    if (!(dt > 0)) dt = 0;
    time += dt;
    updateEmitters(dt);
    const cameraPos = game.camera ? game.camera.position : tmpRayOrigin.set(0, 0, 0);
    litBatch.begin();
    litPool.update(dt, litBatch, cameraPos, wind, time);
    litBatch.end();
    glowBatch.begin();
    glowPool.update(dt, glowBatch, cameraPos, wind, time);
    tracers.update(dt, glowBatch, GLOW_FRAME_FLASH_CONE, GLOW_FRAME_SOFT);
    glowBatch.end();
    debrisPool.update(dt);
    shellPool.update(dt);
  }
  function clear(): void {
    litPool.clear();
    glowPool.clear();
    tracers.clear();
    debrisPool.clear();
    shellPool.clear();
    decalPool.clear();
    for (const emitter of emitters) if (emitter.active) emitter.stop();
    litBatch.begin();
    litBatch.end();
    glowBatch.begin();
    glowBatch.end();
  }
  return {
    update,
    clear,
    muzzleFlash,
    tracer,
    impact,
    sparks,
    smoke,
    dust,
    explosion,
    shell,
    splash,
    addEmitter,
    debris,
    decal(point, normal, kind = 'bullet_concrete', size) {
      tmpSurfaceNormal.copy(normal || WORLD_UP);
      decalPool.add(point, tmpSurfaceNormal, kind, size);
    },
    wind,
    root,
    stats() {
      return {
        lit: litPool.n,
        add: glowPool.n,
        tracers: tracers.n,
        debris: debrisPool.live,
        drawCalls: 5
      };
    }
  };
}

/** Camera placement and per-frame hook returned by {@link fxShowcase}. */
export interface FxShowcase {
  cam: [number, number, number];
  target: [number, number, number];
  update(dt: number): void;
}

/**
 * Debug showcase (`?show=fx`): three target surfaces with looping impacts, tracers, shells,
 * emitters and explosions. `?fxshow=impact|explosion|tracer`, `?fxhold=muzzle`, `?fxsize=`,
 * `?fxt=` (pre-roll seconds) tune it.
 */
export function fxShowcase(game: Game): FxShowcase {
  const fx = game.fx;
  const mode = game.params.fxshow || 'all';
  const group = new Group();
  const addMesh = (
    geometry: BufferGeometry,
    material: string,
    x: number,
    y: number,
    z: number
  ): Mesh => {
    const mesh = new Mesh(geometry, game.mats.get(material));
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  addMesh(roundedBox(2.6, 2.2, 0.3, 0.02), 'concrete', -3.2, 1.1, 0);
  addMesh(roundedBox(2.2, 2, 0.08, 0.01), 'paint_blue', 0, 1, 0);
  addMesh(roundedBox(1.2, 1.2, 1.2, 0.015), 'wood_pallet', 3.2, 0.6, 0);
  game.scene.add(group);
  game.physics.addBox([-4.5, 0, -0.15], [-1.9, 2.2, 0.15], {
    surface: 'concrete'
  });
  game.physics.addBox([-1.1, 0, -0.04], [1.1, 2, 0.04], {
    surface: 'metal'
  });
  game.physics.addBox([2.6, 0, -0.6], [3.8, 1.2, 0.6], {
    surface: 'wood'
  });
  const vec = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
  const gunLeft = vec(-6.5, 1.5, 7);
  const gunRight = vec(6.5, 1.4, 7);
  const tracerGun = vec(5.2, 1.3, 3.2);
  const shellPort = vec(-4.6, 1.35, 4.2);
  const aimPoint = vec(0, 0, 0);
  const shotDir = vec(0, 0, 0);
  const scratchPoint = vec(0, 0, 0);
  // Unused, kept from the original.
  vec(0, 1, 0);
  const impactEvent: {
    point: Vector3;
    normal: Vector3;
    surface: string;
    dir: Vector3;
    enemy: object | null;
    from: string;
  } = {
    point: vec(0, 0, 0),
    normal: vec(0, 1, 0),
    surface: 'concrete',
    dir: vec(0, 0, 0),
    enemy: null,
    from: 'player'
  };
  const random = Math.random;
  let elapsed = 0;
  let shotIndex = 0;
  let gunIndex = 0;
  let explosionIndex = 0;
  let impactTimer = 0;
  let tracerTimer = 0.2;
  let shellTimer = 0;
  let explosionTimer = 3.4;
  let prerolled = false;
  const showImpacts = mode === 'all' || mode === 'impact';
  const showExplosions = mode === 'all' || mode === 'explosion';
  const showTracers = mode === 'all' || mode === 'tracer';
  const explosionInterval = mode === 'explosion' ? 2.4 : 3.5;
  if (mode === 'explosion') explosionTimer = 0.6;
  if (mode === 'all' || mode === 'impact') {
    fx.addEmitter(vec(-6.2, 0.05, -1.5), 'steam');
    fx.addEmitter(vec(5.6, 0, 1.6), 'fire');
    fx.addEmitter(vec(0.4, 2.6, 1.6), 'drip');
  }

  /** Fires one showcase shot; `kind` picks the target (5 = enemy hit, 4 = water, 6 = dirt). */
  function fireShot(kind: number): void {
    const gun = gunIndex++ % 2 ? gunRight : gunLeft;
    impactEvent.enemy = null;
    impactEvent.from = 'player';
    if (kind === 5) {
      impactEvent.point.set(-1.5 + random() * 0.3, 2.5 + random() * 0.3, 0.8);
      impactEvent.normal.copy(gun).sub(impactEvent.point).normalize();
      impactEvent.surface = 'enemy';
      impactEvent.enemy = {};
      impactEvent.dir.copy(impactEvent.point).sub(gun).normalize();
      fx.tracer(gun, impactEvent.point);
      game.events.emit('impact', impactEvent);
      return;
    }
    if (kind === 0) aimPoint.set(-3.2 + (random() - 0.5) * 2, 0.4 + random() * 1.5, 0);
    else if (kind === 1 || kind === 7)
      aimPoint.set((random() - 0.5) * 1.8, 0.3 + random() * 1.5, 0);
    else if (kind === 2) aimPoint.set(3.2 + (random() - 0.5) * 0.9, 0.2 + random() * 0.9, 0.6);
    else if (kind === 3) aimPoint.set(-1.6 + (random() - 0.5) * 1.2, 0, 2.2 + random());
    else if (kind === 4) aimPoint.set(1.5 + (random() - 0.5) * 0.8, 0, 2.6 + random() * 0.8);
    else aimPoint.set(3.4 + (random() - 0.5), 0, 2.4 + random() * 0.6);
    shotDir.copy(aimPoint).sub(gun).normalize();
    const hit = game.physics.raycast(gun, shotDir, 100);
    if (hit) {
      impactEvent.point.copy(hit.point);
      impactEvent.normal.copy(hit.normal);
      impactEvent.dir.copy(shotDir);
      impactEvent.surface = kind === 4 ? 'water' : kind === 6 ? 'dirt' : hit.surface;
      fx.tracer(gun, impactEvent.point);
      game.events.emit('impact', impactEvent);
    }
  }

  const hold = game.params.fxhold;
  const muzzlePos = vec(0, 1.3, 3);
  const muzzleDir = vec(1, 0, 0);
  function step(dt: number): void {
    elapsed += dt;
    if (hold === 'muzzle') {
      fx.muzzleFlash(muzzlePos, muzzleDir, {
        scale: 1
      });
      muzzlePos.x = 2.5;
      muzzleDir.set(-0.5, 0, 0.86);
      fx.muzzleFlash(muzzlePos, muzzleDir, {
        scale: 1.6
      });
      muzzlePos.x = 0;
      muzzleDir.set(1, 0, 0);
    }
    if (showImpacts)
      for (impactTimer -= dt; impactTimer <= 0;) {
        impactTimer += mode === 'impact' ? 0.09 : 0.13;
        fireShot(shotIndex++ % 8);
      }
    if (showTracers) {
      tracerTimer -= dt;
      if (tracerTimer <= 0) {
        tracerTimer += mode === 'tracer' ? 0.16 : 0.45;
        scratchPoint.set(-5 + random() * 3, 1.2 + random() * 0.8, 6 + random() * 2);
        shotDir.copy(scratchPoint).sub(tracerGun).normalize();
        fx.muzzleFlash(tracerGun, shotDir, {
          scale: 1
        });
        fx.tracer(tracerGun, scratchPoint, {
          color: 0xff4a22,
          speed: 120
        });
        if (mode === 'tracer') {
          scratchPoint.set(6, 1 + random() * 1.5, -6 - random() * 6);
          aimPoint.set(-7, 1.6, 6.5);
          fx.tracer(aimPoint, scratchPoint, {
            speed: 200
          });
        }
      }
      shellTimer -= dt;
      if (shellTimer <= 0) {
        shellTimer += 0.22;
        scratchPoint.set(1.6 + random() * 0.8, 1.6 + random() * 0.8, 0.4 + (random() - 0.5) * 0.8);
        fx.shell(shellPort, scratchPoint);
      }
    }
    if (showExplosions) {
      explosionTimer -= dt;
      if (explosionTimer <= 0) {
        explosionTimer += explosionInterval;
        const size = +(game.params.fxsize || 0) || 1 + (explosionIndex++ % 3);
        scratchPoint.set(mode === 'explosion' ? 0 : 7, 0.25, mode === 'explosion' ? 3.5 : -3.5);
        fx.explosion(scratchPoint, size);
      }
    }
  }

  // Wrap fx.update so a `__setShot` frame can freeze the simulation at a given explosion age.
  let frozen = false;
  const originalUpdate = fx.update;
  fx.update = (dt) => {
    if (!frozen) originalUpdate(dt);
  };
  const previousSetShot = window.__setShot;
  if (previousSetShot)
    window.__setShot = (shot) => {
      if (shot && shot.fxage !== undefined) {
        fx.clear();
        scratchPoint.set(0, 0.25, 3.5);
        fx.explosion(scratchPoint, +(shot.fxsize || 1.2));
        const age = +shot.fxage;
        for (let t = 0; t < age - 1e-6; t += 1 / 60) originalUpdate(1 / 60);
        originalUpdate(0);
        frozen = true;
      }
      previousSetShot(shot);
    };
  return {
    cam: mode === 'explosion' ? [0, 2, 12.5] : [0.3, 1.6, 7.2],
    target: mode === 'explosion' ? [0, 2.2, 3.5] : [0.2, 1, 0],
    update(dt) {
      if (!prerolled) {
        prerolled = true;
        const prerollSeconds = +(game.params.fxt || 0);
        for (let t = 0; t < prerollSeconds; t += 1 / 30) {
          step(1 / 30);
          fx.update(1 / 30);
        }
      }
      if (!frozen) step(dt);
    }
  };
}

export { createFx as create, fxShowcase as showcase };
