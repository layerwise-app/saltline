// Enemy subsystem: owns the pools of gull drones, hound walkers and human guards, their shared AI
// context (perception, alert propagation, attack tokens), the gull plasma bolts, the
// gull search-lamp light, and the `?show=enemies` showcase scene.
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  ShaderMaterial,
  Vector3
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRng } from '../core/rng';
import { GULL_TUNING, buildGullRigDef, buildHoundRigDef, createGull } from './gull';
import { HOUND_TUNING, createHound } from './hound';
import { GUARD_TUNING, buildGuardGunDef, buildGuardRigDef, createGuard, oldestGuardCorpse } from './guard';
import { preloadGuardAsset } from './guardAsset';
import type { BufferGeometry, Material, Mesh, PointLight, Texture } from 'three';
import type { Game } from '../core/types';
import type { Rng } from '../core/rng';
import type { RigDef, SkinnedRig } from './rig';
import type { GullEnemy } from './gull';
import type { HoundEnemy } from './hound';
import type { GuardEnemy } from './guard';

/** Alert state shared by every enemy type. */
export type EnemyMode = 'patrol' | 'investigate' | 'search' | 'engage';

/** Body part reported by enemy ray hits (`weak` = hound / guard head, extra damage). */
export type EnemyPart = 'body' | 'weak';

/** Looping positional sound attached to an enemy (rotor whine, servo hum). */
export interface EnemyAudioLoop {
  stop(): void;
  setPos(pos: Vector3): void;
  setPitch(pitch: number): void;
  setGain(gain: number): void;
}

/** The part of `game.audio` enemies use (absent on the silent audio stub). */
export interface EnemyAudioSource {
  loop?(name: string, opts: { pos: Vector3; gain: number }): EnemyAudioLoop;
}

/** Options accepted by {@link EnemySystem.spawn}. */
export interface EnemySpawnOptions {
  /** Passive enemies never perceive the player (showcase / set dressing). */
  passive?: boolean;
  yaw?: number;
  /** `'alert'` starts the enemy investigating instead of patrolling. */
  state?: string;
  /** Initial last-known player position. */
  target?: Vector3;
  /** Gull: fixed hover altitude (also disables ground/ceiling clamping). */
  hover?: number;
  /** Patrol radius around the spawn point. */
  patrolRadius?: number;
  /** Hound / guard: waypoints to walk between instead of random patrol points. */
  patrolLine?: Vector3[] | null;
  /** Guard showcase: stand still facing the player with this rifle raise / crouch. */
  hold?: { aim: number; crouch: number } | null;
}

/** Closest enemy hit found by {@link EnemySystem.raycast}. */
export interface EnemyRayHit {
  dist: number;
  point: Vector3;
  normal: Vector3;
  enemy: AnyEnemy | null;
  part: EnemyPart;
}

/** A confirmed enemy hit (as returned by {@link EnemySystem.raycast}). */
export interface EnemyRayResult extends EnemyRayHit {
  enemy: AnyEnemy;
}

/** Enemy type names. */
export type EnemyType = 'gull' | 'hound' | 'guard';

/** Members shared by every enemy type (used by combat, HUD, audio and game flow). */
export interface Enemy {
  /** Spawn serial number (0 while pooled). */
  id: number;
  type: EnemyType;
  /** World position (the rig group's position vector). */
  pos: Vector3;
  alive: boolean;
  /** True while spawned (alive or wreck); false while waiting in the pool. */
  active: boolean;
  hp: number;
  rig: SkinnedRig;
  lens: MeshBasicMaterial;
  yaw: number;
  home: Vector3;
  lastKnown: Vector3;
  /** Eye position used for line-of-sight checks. */
  sensor: Vector3;
  /** Horizontal facing direction. */
  fwd: Vector3;
  muzzle: Vector3;
  mode: EnemyMode;
  /** Whether the player is currently visible. */
  los: boolean;
  seeT: number;
  noSeeT: number;
  senseT: number;
  /** 0..1: how long the player has been exposed; tightens aim. */
  exposure: number;
  modeT: number;
  passive: boolean;
  /** Holds one of the shared attack tokens. */
  hasToken: boolean;
  flare: number;
  lensC: number[];
  smokeT: number;
  phase: number;
  dieT: number;
  loop: EnemyAudioLoop | null;
  /** Applies damage; returns true when this hit killed the enemy. */
  damage(amount: number, point: Vector3, dir?: Vector3 | null, part?: string): boolean;
  _activate(pos: Vector3, opts?: EnemySpawnOptions): void;
  _deactivate(): void;
  /** Narrow-phase ray test; updates `hit` when closer than `hit.dist`. */
  _raycast(origin: Vector3, dir: Vector3, maxDist: number, hit: EnemyRayHit): boolean;
  _update(dt: number): void;
}

/** Any concrete enemy (narrow with `enemy.type`). */
export type AnyEnemy = GullEnemy | HoundEnemy | GuardEnemy;

/** Shared materials for the enemy rigs. */
export interface EnemyMaterials {
  shell: Material;
  metal: Material;
  glow: MeshBasicMaterial;
  lensBase: MeshBasicMaterial;
  disc: MeshBasicMaterial;
  cone: ShaderMaterial;
  /** Guard uniform fabric, tactical gear and skin (vertex-colour tinted). */
  cloth: Material;
  gear: Material;
  skin: Material;
}

/** A pooled gull plasma bolt. */
export interface EnemyBolt {
  on: boolean;
  life: number;
  /** Visible streak length. */
  len: number;
  pos: Vector3;
  dir: Vector3;
  /** Firing position (reported to the player as damage source). */
  from: Vector3;
}

/** Shared AI context handed to every enemy instance. */
export interface EnemyContext {
  G: Game;
  rng: Rng;
  list: AnyEnemy[];
  /** Enemy-simulation clock in seconds. */
  t: number;
  /** Smoothed horizontal player speed (widens enemy spread). */
  playerSpeed: number;
  /** Attack tokens currently held. */
  tokens: number;
  tokenT: number;
  /** Guard attack tokens (separate quota). */
  guardTokens: number;
  guardTokenT: number;
  lastType: string;
  wantT: Record<EnemyType, number>;
  mergeSimple(geometries: BufferGeometry[]): BufferGeometry;
  /** Asks for permission to attack; limits how many enemies shoot at once. */
  requestToken(enemy: AnyEnemy): boolean;
  releaseToken(enemy: AnyEnemy): void;
  /** Perception + alert-state update; `reactTime` is the sight time needed to engage. */
  think(enemy: AnyEnemy, dt: number, reactTime: number): void;
  /** Sends idle enemies within `radius` of `origin` to investigate `target`. */
  rally(origin: Vector3, radius: number, target: Vector3, source: AnyEnemy): void;
  /** Makes an enemy (and its neighbours) react to being shot. */
  provoke(enemy: AnyEnemy): void;
  fireBolt(from: Vector3, dir: Vector3, shooter: AnyEnemy): void;
  addWreck(enemy: HoundEnemy): void;
  /** Deactivates an enemy and removes it from the live and wreck lists. */
  retire(enemy: AnyEnemy): void;
}

/** Debug handles exposed as `game.enemies.debug`. */
export interface EnemyDebugInfo {
  ctx: EnemyContext;
  gulls: GullEnemy[];
  hounds: HoundEnemy[];
  guards: GuardEnemy[];
  wrecks: HoundEnemy[];
  bolts: EnemyBolt[];
  mats: EnemyMaterials;
  tris: { gull: number; hound: number; guard: number };
}

/** The enemy subsystem stored as `game.enemies`. */
export interface EnemySystem {
  /** Live (spawned) enemies, including hound wrecks. */
  list: AnyEnemy[];
  TUNE: typeof ENEMY_TUNING;
  /** Takes an inactive enemy of `type` from its pool and activates it at `pos`. */
  spawn(type: string, pos: Vector3, opts?: EnemySpawnOptions): AnyEnemy | null;
  /** Closest living enemy along the ray, or null. */
  raycast(origin: Vector3, dir: Vector3, maxDist?: number): EnemyRayResult | null;
  aliveCount(): number;
  /** Returns every enemy to its pool and clears bolts, wrecks and corpses. */
  clear(): void;
  /** Alerts idle enemies within `radius` to a noise at `pos`. */
  alert(pos: Vector3, radius?: number): void;
  update(dt: number): void;
  debug: EnemyDebugInfo;
  /**
   * Shows one pooled guard far below the level so the renderer's boot-time shader compile
   * covers the guard character's materials, and uploads its textures. Call the returned
   * function after compiling to hide it again.
   */
  prewarm?(): () => void;
}

/** Payload of the `impact` event emitted when a bolt hits the world. */
interface BoltImpactEvent {
  point: Vector3;
  normal: Vector3;
  dist: number;
  surface: string;
  enemy: null;
  part: null;
  dir: Vector3;
  from: 'enemy';
}

/** Lamp light borrowed from the render light pool. */
interface PooledLight {
  light?: PointLight | null;
}

/** Payload of the `weapon:fire` event, as far as enemies care. */
interface WeaponFireEvent {
  origin?: Vector3;
  muzzle?: Vector3;
}

/** True for a MeshBasicMaterial (the material library may return other kinds). */
function isBasicMaterial(material: unknown): material is MeshBasicMaterial {
  return !!material && !!(material as MeshBasicMaterial).isMeshBasicMaterial;
}

/** Tuning shared by the enemy AI (perception, attack tokens, pools). */
export const ENEMY_TUNING = {
  gull: GULL_TUNING,
  hound: HOUND_TUNING,
  guard: GUARD_TUNING,
  sightRange: 45,
  sightCone: 200,
  loseSight: 4,
  searchTime: 8,
  hearRadius: 45,
  maxTokens: 2,
  maxTokensCrowd: 3,
  tokenGap: 1.25,
  /** Guards shooting at once (their own quota, separate from the machines). */
  guardTokens: 3,
  /** Minimum gap between two guards starting to fire (s). */
  guardTokenGap: 0.6,
  exposureUp: 0.1,
  exposureDown: 0.45,
  // Guards are the bulk of the force; at most one hound and one gull are up at a time
  // (spares cover a wreck still falling or a showcase).
  poolGulls: 3,
  poolHounds: 3,
  poolGuards: 14,
  maxWrecks: 5,
  maxBolts: 32
};

export const SIGHT_CONE_COS = Math.cos(((ENEMY_TUNING.sightCone / 2) * Math.PI) / 180);
export const tmpBoltEnd = new Vector3();
export const tmpEnemyVecUnused = new Vector3();
export const tmpLampRayDir = new Vector3();
export const tmpBoltQuat = new Quaternion();
export const tmpBoltMatrix = new Matrix4();
export const tmpBoltScale = new Vector3(1, 1, 1);
export const BOLT_FORWARD_AXIS = new Vector3(0, 0, 1);
export const ENEMY_DOWN_AXIS = new Vector3(0, -1, 0);
export const tmpPlayerCapsuleBottom = new Vector3();
export const tmpPlayerCapsuleTop = new Vector3();

/** Creates the enemy pools and AI; spawned enemies are driven by `update`. */
export async function createEnemies(game: Game): Promise<EnemySystem> {
  const rng = createRng(+((game.params && game.params.eseed) || 9001));
  const list: AnyEnemy[] = [];
  const wrecks: HoundEnemy[] = [];
  const root = new Group();
  root.name = 'enemies';
  game.scene.add(root);
  const emissiveWhite = game.mats.emissive(0xffffff, 1);
  const glowMat = isBasicMaterial(emissiveWhite) ? emissiveWhite.clone() : new MeshBasicMaterial();
  glowMat.color.setRGB(1, 1, 1);
  glowMat.vertexColors = true;
  glowMat.needsUpdate = true;
  const emissiveLens = game.mats.emissive(0xffa040, 6);
  const lensBase = isBasicMaterial(emissiveLens)
    ? emissiveLens
    : new MeshBasicMaterial({
        color: 0xffa040
      });
  const toneMapped: boolean =
    emissiveWhite && emissiveWhite.toneMapped !== undefined ? emissiveWhite.toneMapped : true;
  const mats: EnemyMaterials = {
    shell: game.mats.get('armor_white', {
      triplanar: true,
      vertexColors: true
    }),
    metal: game.mats.get('gunmetal', {
      triplanar: true,
      vertexColors: true
    }),
    glow: glowMat,
    lensBase: lensBase,
    disc: new MeshBasicMaterial({
      color: 0x0c0d0f,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: toneMapped
    }),
    cone: new ShaderMaterial({
      uniforms: {
        uColor: {
          value: new Color(1, 0.9, 0.74)
        },
        uGain: {
          value: 0.085
        }
      },
      vertexShader: `
        #include <common>
        #include <skinning_pars_vertex>
        varying float vT; varying vec3 vN; varying vec3 vV;
        void main() {
          #include <beginnormal_vertex>
          #include <skinbase_vertex>
          #include <skinnormal_vertex>
          #include <begin_vertex>
          #include <skinning_vertex>
          vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
          vN = normalMatrix * objectNormal; vV = -mv.xyz; vT = 1.0 - uv.y;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uGain;
        varying float vT; varying vec3 vN; varying vec3 vV;
        void main() {
          float f = abs(dot(normalize(vN), normalize(vV)));
          f = f * f * (3.0 - 2.0 * f);
          float t = clamp(vT, 0.0, 1.0);
          float k = pow(1.0 - t, 1.7) * (0.35 + 0.65 * smoothstep(0.0, 0.06, t));
          gl_FragColor = vec4(uColor * (uGain * f * k), 1.0);
        }`,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      fog: false
    }),
    cloth: game.mats.get('glove_fabric', {
      triplanar: true,
      vertexColors: true,
      color: 0xffffff
    }),
    gear: game.mats.get('polymer_black', {
      triplanar: true,
      vertexColors: true,
      color: 0xffffff
    }),
    skin: new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0
    })
  };
  const ctx: EnemyContext = {
    G: game,
    rng: rng,
    list: list,
    t: 0,
    playerSpeed: 0,
    tokens: 0,
    tokenT: -9,
    guardTokens: 0,
    guardTokenT: -9,
    lastType: '',
    wantT: {
      gull: -9,
      hound: -9,
      guard: -9
    },
    mergeSimple: (geometries) => mergeGeometries(geometries, false),
    requestToken(enemy) {
      if (enemy.hasToken) {
        return true;
      }
      if (enemy.type === 'guard') {
        if (
          ctx.guardTokens >= ENEMY_TUNING.guardTokens ||
          ctx.t - ctx.guardTokenT < ENEMY_TUNING.guardTokenGap
        ) {
          return false;
        }
        ctx.guardTokens++;
        ctx.guardTokenT = ctx.t;
        enemy.hasToken = true;
        return true;
      }
      let aliveCount = 0;
      for (const other of list) {
        if (other.alive) {
          aliveCount++;
        }
      }
      const maxTokens = aliveCount > 5 ? ENEMY_TUNING.maxTokensCrowd : ENEMY_TUNING.maxTokens;
      const sinceLast = ctx.t - ctx.tokenT;
      const otherType = enemy.type === 'gull' ? 'hound' : 'gull';
      const alternate =
        ctx.lastType === enemy.type &&
        ctx.t - ctx.wantT[otherType] < 0.5 &&
        sinceLast < ENEMY_TUNING.tokenGap * 2.2;
      if (ctx.tokens >= maxTokens || sinceLast < ENEMY_TUNING.tokenGap || alternate) {
        ctx.wantT[enemy.type] = ctx.t;
        return false;
      } else {
        ctx.tokens++;
        ctx.tokenT = ctx.t;
        ctx.lastType = enemy.type;
        enemy.hasToken = true;
        return true;
      }
    },
    releaseToken(enemy) {
      if (enemy.hasToken) {
        enemy.hasToken = false;
        if (enemy.type === 'guard') ctx.guardTokens = Math.max(0, ctx.guardTokens - 1);
        else ctx.tokens = Math.max(0, ctx.tokens - 1);
      }
    },
    think(enemy, dt, reactTime) {
      const player = game.player;
      if (enemy.passive || !player) {
        enemy.los = false;
        return;
      }
      enemy.senseT -= dt;
      if (enemy.senseT <= 0) {
        enemy.senseT = 0.11 + rng() * 0.08;
        let visible = false;
        if (player.alive !== false) {
          const eye = player.eye || player.pos;
          const dx = eye.x - enemy.sensor.x;
          const dy = eye.y - enemy.sensor.y;
          const dz = eye.z - enemy.sensor.z;
          const dist = Math.hypot(dx, dy, dz);
          if (dist < ENEMY_TUNING.sightRange) {
            const flatDist = Math.hypot(dx, dz) || 1e-4;
            const facing = (dx * enemy.fwd.x + dz * enemy.fwd.z) / flatDist;
            if (enemy.mode === 'engage' || facing > SIGHT_CONE_COS || dist < 3.5) {
              visible = game.physics.lineOfSight(enemy.sensor, eye);
            }
          }
        }
        enemy.los = visible;
      }
      if (enemy.los) {
        enemy.seeT += dt;
        enemy.noSeeT = 0;
        enemy.lastKnown.copy(player.pos);
        enemy.exposure = Math.min(1, enemy.exposure + dt * ENEMY_TUNING.exposureUp);
      } else {
        enemy.noSeeT += dt;
        enemy.seeT = Math.max(0, enemy.seeT - dt * 0.6);
        enemy.exposure = Math.max(0, enemy.exposure - dt * ENEMY_TUNING.exposureDown);
      }
      if (enemy.mode === 'engage') {
        if (enemy.noSeeT > ENEMY_TUNING.loseSight || player.alive === false) {
          enemy.mode = 'search';
          enemy.modeT = ENEMY_TUNING.searchTime + rng() * 3;
          ctx.releaseToken(enemy);
        }
      } else if (
        enemy.los &&
        enemy.seeT > (enemy.mode === 'patrol' ? reactTime : reactTime * 0.45)
      ) {
        enemy.mode = 'engage';
        enemy.noSeeT = 0;
        game.events.emit('enemy:alert', {
          enemy: enemy
        });
        ctx.rally(enemy.pos, 18, player.pos, enemy);
      } else if (enemy.mode !== 'patrol') {
        enemy.modeT -= dt;
        if (enemy.modeT <= 0) {
          enemy.mode = 'patrol';
          enemy.home.x = enemy.pos.x;
          enemy.home.z = enemy.pos.z;
        }
      }
    },
    rally(origin, radius, target, source) {
      for (const other of list) {
        if (
          other === source ||
          !other.alive ||
          other.passive ||
          other.mode === 'engage' ||
          other.pos.distanceToSquared(origin) > radius * radius
        ) {
          continue;
        }
        other.lastKnown.copy(target);
        other.mode = 'investigate';
        other.modeT = 9 + rng() * 4;
      }
    },
    provoke(enemy) {
      const player = game.player;
      if (!player || enemy.passive || !enemy.alive) {
        return;
      }
      if (enemy.mode !== 'engage') {
        enemy.lastKnown.copy(player.pos);
        enemy.mode = 'investigate';
        enemy.modeT = 10;
        enemy.seeT = 1;
        enemy.senseT = 0;
      }
      ctx.rally(enemy.pos, 20, player.pos, enemy);
    },
    fireBolt(from, dir, shooter) {
      let bolt: EnemyBolt | null = null;
      for (let i = 0; i < bolts.length; i++) {
        if (!bolts[i].on) {
          bolt = bolts[i];
          break;
        }
      }
      if (bolt) {
        bolt.on = true;
        bolt.life = 1.3;
        bolt.pos.copy(from);
        bolt.dir.copy(dir);
        bolt.from.copy(from);
        bolt.len = 0;
      }
    },
    addWreck(enemy) {
      wrecks.push(enemy);
      while (wrecks.length > ENEMY_TUNING.maxWrecks) {
        const oldest = wrecks.shift()!;
        if (oldest.active) {
          oldest.sink = 0.001;
        }
      }
    },
    retire(enemy) {
      enemy._deactivate();
      let index = list.indexOf(enemy);
      if (index >= 0) {
        list.splice(index, 1);
      }
      index = wrecks.indexOf(enemy as HoundEnemy);
      if (index >= 0) {
        wrecks.splice(index, 1);
      }
    }
  };
  const gullDef = buildGullRigDef();
  const houndDef = buildHoundRigDef();
  const guardDef = buildGuardRigDef();
  const guardAsset = await preloadGuardAsset();
  const guardGunDef = guardAsset ? buildGuardGunDef() : null;
  const gulls: GullEnemy[] = [];
  const hounds: HoundEnemy[] = [];
  const guards: GuardEnemy[] = [];
  for (let i = 0; i < ENEMY_TUNING.poolGulls; i++) {
    const gull = createGull(ctx, gullDef, mats, i);
    gulls.push(gull);
    root.add(gull.rig.group);
  }
  for (let i = 0; i < ENEMY_TUNING.poolHounds; i++) {
    const hound = createHound(ctx, houndDef, mats, i);
    hounds.push(hound);
    root.add(hound.rig.group);
  }
  for (let i = 0; i < ENEMY_TUNING.poolGuards; i++) {
    const guard = createGuard(ctx, guardDef, mats, i, guardAsset, guardGunDef);
    guards.push(guard);
    root.add(guard.rig.group);
  }
  const bolts: EnemyBolt[] = [];
  for (let i = 0; i < ENEMY_TUNING.maxBolts; i++) {
    bolts.push({
      on: false,
      life: 0,
      len: 0,
      pos: new Vector3(),
      dir: new Vector3(),
      from: new Vector3()
    });
  }
  const boltGeo = new CylinderGeometry(0.016, 0.03, 1, 6, 1);
  boltGeo.rotateX(Math.PI / 2);
  boltGeo.translate(0, 0, -0.5);
  const emissiveBolt = game.mats.emissive(0xff6a2a, 14);
  const boltMat = isBasicMaterial(emissiveBolt)
    ? emissiveBolt
    : new MeshBasicMaterial({
        color: new Color(0xff6a2a).multiplyScalar(14)
      });
  const boltMesh = new InstancedMesh(boltGeo, boltMat, ENEMY_TUNING.maxBolts);
  boltMesh.frustumCulled = false;
  boltMesh.castShadow = false;
  boltMesh.receiveShadow = false;
  boltMesh.count = 0;
  boltMesh.instanceMatrix.setUsage(DynamicDrawUsage);
  root.add(boltMesh);
  const impactEvent: BoltImpactEvent = {
    point: new Vector3(),
    normal: new Vector3(),
    dist: 0,
    surface: 'concrete',
    enemy: null,
    part: null,
    dir: new Vector3(),
    from: 'enemy'
  };
  function updateBolts(dt: number): void {
    const player = game.player;
    let drawn = 0;
    for (let i = 0; i < bolts.length; i++) {
      const bolt = bolts[i];
      if (!bolt.on) {
        continue;
      }
      const step = ENEMY_TUNING.gull.boltSpeed * dt;
      bolt.life -= dt;
      const hit = game.physics.raycast(bolt.pos, bolt.dir, step);
      const travel = hit ? hit.dist : step;
      let hitPlayer = false;
      if (player && player.alive !== false) {
        tmpBoltEnd.copy(bolt.pos).addScaledVector(bolt.dir, travel);
        tmpPlayerCapsuleBottom.set(player.pos.x, player.pos.y + 0.35, player.pos.z);
        tmpPlayerCapsuleTop.set(
          player.pos.x,
          player.pos.y + (player.crouching ? 1 : 1.5),
          player.pos.z
        );
        if (
          segmentSegmentDistSq(bolt.pos, tmpBoltEnd, tmpPlayerCapsuleBottom, tmpPlayerCapsuleTop) <
          0.36 * 0.36
        ) {
          hitPlayer = true;
        }
      }
      if (hitPlayer) {
        player.damage(ENEMY_TUNING.gull.boltDamage, bolt.from);
        bolt.on = false;
        continue;
      }
      if (hit) {
        impactEvent.point.copy(hit.point);
        impactEvent.normal.copy(hit.normal);
        impactEvent.dist = hit.dist;
        impactEvent.surface = hit.surface;
        impactEvent.dir.copy(bolt.dir);
        game.events.emit('impact', impactEvent);
        bolt.on = false;
        continue;
      }
      if (bolt.life <= 0) {
        bolt.on = false;
        continue;
      }
      bolt.pos.addScaledVector(bolt.dir, step);
      bolt.len = Math.min(1.5, bolt.len + step);
      tmpBoltQuat.setFromUnitVectors(BOLT_FORWARD_AXIS, bolt.dir);
      tmpBoltScale.set(1, 1, Math.max(0.2, bolt.len));
      tmpBoltMatrix.compose(bolt.pos, tmpBoltQuat, tmpBoltScale);
      boltMesh.setMatrixAt(drawn++, tmpBoltMatrix);
    }
    if (drawn || boltMesh.count) {
      boltMesh.count = drawn;
      boltMesh.instanceMatrix.needsUpdate = true;
    }
  }
  let lamp: PooledLight | null = null;
  let lampInit = false;
  let lampProbeT = 0;
  const lampTarget = new Vector3();
  let lampLevel = 0;
  function updateLamp(dt: number): void {
    if (!lampInit) {
      lampInit = true;
      try {
        lamp =
          game.render && game.render.lightPool && game.render.lightPool.acquire
            ? game.render.lightPool.acquire()
            : null;
      } catch {
        lamp = null;
      }
      if (lamp && lamp.light) {
        lamp.light.color.setRGB(1, 0.9, 0.75);
        lamp.light.distance = 9;
      }
    }
    if (!lamp || !lamp.light) {
      return;
    }
    let nearest: GullEnemy | null = null;
    let nearestDistSq = 3600;
    const camPos = game.camera ? game.camera.position : null;
    for (const enemy of list) {
      if (enemy.type !== 'gull' || !enemy.alive) {
        continue;
      }
      const distSq = camPos ? enemy.pos.distanceToSquared(camPos) : 0;
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearest = enemy;
      }
    }
    let targetIntensity = 0;
    if (nearest) {
      lampProbeT -= dt;
      if (lampProbeT <= 0) {
        lampProbeT = 0.1;
        const yaw = nearest.yaw + nearest.gy;
        const cosPitch = Math.cos(nearest.gp);
        tmpLampRayDir
          .set(Math.sin(yaw) * cosPitch, -Math.sin(nearest.gp), Math.cos(yaw) * cosPitch)
          .normalize();
        const hit = game.physics.raycast(nearest.sensor, tmpLampRayDir, 14);
        lampTarget.copy(nearest.sensor).addScaledVector(tmpLampRayDir, (hit ? hit.dist : 8) - 0.6);
        lampLevel = hit ? 1 : 0.3;
      }
      targetIntensity = 26 * lampLevel;
      lamp.light.position.lerp(lampTarget, 1 - Math.exp(-12 * dt));
    }
    lamp.light.intensity += (targetIntensity - lamp.light.intensity) * (1 - Math.exp(-8 * dt));
  }
  let nextId = 1;
  let hearCooldown = 0;
  const system: EnemySystem = {
    list: list,
    TUNE: ENEMY_TUNING,
    spawn(type, pos, opts = {}) {
      const pool: AnyEnemy[] | null =
        type === 'gull' ? gulls : type === 'hound' ? hounds : type === 'guard' ? guards : null;
      if (!pool) {
        return null;
      }
      let enemy: AnyEnemy | null = null;
      for (const candidate of pool) {
        if (!candidate.active) {
          enemy = candidate;
          break;
        }
      }
      if (!enemy && type === 'hound' && wrecks.length) {
        const wreck = wrecks[0];
        ctx.retire(wreck);
        enemy = wreck;
      }
      if (!enemy && type === 'guard') {
        const corpse = oldestGuardCorpse(guards);
        if (corpse) {
          ctx.retire(corpse);
          enemy = corpse;
        }
      }
      if (enemy) {
        enemy.id = nextId++;
        list.push(enemy);
        enemy._activate(pos, opts);
        game.events.emit('enemy:spawn', {
          enemy: enemy
        });
        return enemy;
      } else {
        return null;
      }
    },
    raycast(origin, dir, maxDist = 300) {
      let hit: EnemyRayHit | null = null;
      for (let i = 0; i < list.length; i++) {
        const enemy = list[i];
        if (!enemy.alive) {
          continue;
        }
        const dx = enemy.pos.x - origin.x;
        const dy =
          enemy.pos.y +
          (enemy.type === 'hound' ? 0.6 : enemy.type === 'guard' ? 0.95 : 0) -
          origin.y;
        const dz = enemy.pos.z - origin.z;
        const along = dx * dir.x + dy * dir.y + dz * dir.z;
        if (
          along < -1.5 ||
          along > maxDist + 1.5 ||
          dx * dx + dy * dy + dz * dz - along * along > 1.7
        ) {
          continue;
        }
        if (!hit) {
          hit = {
            dist: Infinity,
            point: new Vector3(),
            normal: new Vector3(),
            enemy: null,
            part: 'body'
          };
        }
        enemy._raycast(origin, dir, maxDist, hit);
      }
      return hit && hit.enemy ? (hit as EnemyRayResult) : null;
    },
    aliveCount() {
      let count = 0;
      for (const enemy of list) {
        if (enemy.alive) {
          count++;
        }
      }
      return count;
    },
    clear() {
      for (const gull of gulls) {
        if (gull.active) {
          gull._deactivate();
        }
      }
      for (const hound of hounds) {
        if (hound.active) {
          hound._deactivate();
        }
      }
      for (const guard of guards) {
        if (guard.active) {
          guard._deactivate();
        }
      }
      list.length = 0;
      wrecks.length = 0;
      ctx.tokens = 0;
      ctx.guardTokens = 0;
      for (const bolt of bolts) {
        bolt.on = false;
      }
      boltMesh.count = 0;
      if (lamp && lamp.light) {
        lamp.light.intensity = 0;
      }
    },
    alert(pos, radius = 40) {
      for (const enemy of list) {
        if (
          !enemy.alive ||
          enemy.passive ||
          enemy.mode === 'engage' ||
          enemy.pos.distanceToSquared(pos) > radius * radius
        ) {
          continue;
        }
        enemy.lastKnown.copy(pos);
        enemy.lastKnown.y = Math.max(0, pos.y - 1.6);
        if (enemy.mode === 'patrol') {
          game.events.emit('enemy:alert', {
            enemy: enemy,
            noise: true
          });
        }
        enemy.mode = 'investigate';
        enemy.modeT = 9 + rng() * 4;
      }
    },
    update(dt) {
      if (dt <= 0) {
        return;
      }
      if (dt > 0.05) {
        dt = 0.05;
      }
      ctx.t += dt;
      hearCooldown -= dt;
      const player = game.player;
      if (player) {
        const speed = player.vel ? Math.hypot(player.vel.x, player.vel.z) : player.speed || 0;
        ctx.playerSpeed += (speed - ctx.playerSpeed) * (1 - Math.exp(-6 * dt));
      }
      for (let i = list.length - 1; i >= 0; i--) {
        list[i]._update(dt);
      }
      updateBolts(dt);
      updateLamp(dt);
    },
    prewarm() {
      const guard = guardAsset ? guards.find((candidate) => !candidate.active) : undefined;
      if (!guard) {
        return () => {};
      }
      const group = guard.rig.group;
      const saved = group.position.clone();
      group.position.set(0, -500, 0);
      group.visible = true;
      group.updateMatrixWorld(true);
      group.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) {
          return;
        }
        for (const material of ([] as Material[]).concat(mesh.material)) {
          for (const value of Object.values(material)) {
            if (value && (value as Texture).isTexture) {
              game.renderer.initTexture(value as Texture);
            }
          }
        }
      });
      return () => {
        if (!guard.active) {
          group.visible = false;
          group.position.copy(saved);
        }
      };
    },
    debug: {
      ctx: ctx,
      gulls: gulls,
      hounds: hounds,
      guards: guards,
      wrecks: wrecks,
      bolts: bolts,
      mats: mats,
      tris: {
        gull: gullDef.tris + gullDef.extra.tris,
        hound: houndDef.tris,
        guard: guardAsset ? guardAsset.tris + (guardGunDef ? guardGunDef.tris : 0) : guardDef.tris
      }
    }
  };
  game.events.on<WeaponFireEvent | undefined>('weapon:fire', (event) => {
    if (hearCooldown > 0) {
      return;
    }
    hearCooldown = 0.3;
    const pos = (event && (event.origin || event.muzzle)) || (game.player && game.player.pos);
    if (pos) {
      system.alert(pos, ENEMY_TUNING.hearRadius);
    }
  });
  game.events.on<{ pos?: Vector3 } | undefined>('explosion', (event) => {
    if (event && event.pos) {
      system.alert(event.pos, 30);
    }
  });
  game.events.on<{ state?: string } | undefined>('game:state', (event) => {
    if (event && event.state === 'title') {
      system.clear();
    }
  });
  return system;
}

const tmpSegDirA = new Vector3();
const tmpSegDirB = new Vector3();
const tmpSegOffset = new Vector3();

/** Squared distance between segments p1-q1 and p2-q2. */
function segmentSegmentDistSq(p1: Vector3, q1: Vector3, p2: Vector3, q2: Vector3): number {
  tmpSegDirA.copy(q1).sub(p1);
  tmpSegDirB.copy(q2).sub(p2);
  tmpSegOffset.copy(p1).sub(p2);
  const lenSqA = tmpSegDirA.dot(tmpSegDirA);
  const lenSqB = tmpSegDirB.dot(tmpSegDirB);
  const dotBOffset = tmpSegDirB.dot(tmpSegOffset);
  let paramA: number;
  let paramB: number;
  if (lenSqA <= 1e-9 && lenSqB <= 1e-9) {
    return tmpSegOffset.dot(tmpSegOffset);
  }
  if (lenSqA <= 1e-9) {
    paramA = 0;
    paramB = Math.min(1, Math.max(0, dotBOffset / lenSqB));
  } else {
    const dotAOffset = tmpSegDirA.dot(tmpSegOffset);
    if (lenSqB <= 1e-9) {
      paramB = 0;
      paramA = Math.min(1, Math.max(0, -dotAOffset / lenSqA));
    } else {
      const dotAB = tmpSegDirA.dot(tmpSegDirB);
      const denom = lenSqA * lenSqB - dotAB * dotAB;
      paramA =
        denom > 1e-9
          ? Math.min(1, Math.max(0, (dotAB * dotBOffset - dotAOffset * lenSqB) / denom))
          : 0;
      paramB = (dotAB * paramA + dotBOffset) / lenSqB;
      if (paramB < 0) {
        paramB = 0;
        paramA = Math.min(1, Math.max(0, -dotAOffset / lenSqA));
      } else if (paramB > 1) {
        paramB = 1;
        paramA = Math.min(1, Math.max(0, (dotAB - dotAOffset) / lenSqA));
      }
    }
  }
  const dx = tmpSegOffset.x + tmpSegDirA.x * paramA - tmpSegDirB.x * paramB;
  const dy = tmpSegOffset.y + tmpSegDirA.y * paramA - tmpSegDirB.y * paramB;
  const dz = tmpSegOffset.z + tmpSegDirA.z * paramA - tmpSegDirB.z * paramB;
  return dx * dx + dy * dy + dz * dz;
}

/** Showcase scene description returned to `main.ts`. */
export interface EnemyShowcase {
  cam: number[];
  target: number[];
  update(dt: number): void;
}

/**
 * `?show=enemies` debug scene (`&eshow=gull|hound|guard|guardaim|guardkneel|guarddead|fight|dead`, `&epre=`,
 * `&efreeze`).
 */
export async function setupEnemyShowcase(game: Game): Promise<EnemyShowcase> {
  const enemies = await createEnemies(game);
  game.enemies = enemies;
  const vec = (x: number, y: number, z: number) => new Vector3(x, y, z);
  const mode = game.params.eshow || 'both';
  let cam = [3, 1.45, 3.9];
  let target = [0.5, 0.95, 0];
  let preroll = 2.6;
  if (mode === 'gull') {
    enemies.spawn('gull', vec(0, 1.6, 0), {
      passive: true,
      hover: 1.6,
      patrolRadius: 0.02,
      yaw: 0.7
    });
    cam = [1.25, 1.95, 1.45];
    target = [0, 1.52, 0];
    preroll = 1.2;
  } else if (mode === 'hound') {
    enemies.spawn('hound', vec(0, 0, 0), {
      passive: true,
      yaw: 0.9,
      patrolLine: [vec(1.6, 0, 1.3), vec(-1.6, 0, -1.3)]
    });
    cam = [2.1, 1, 2.3];
    target = [0.5, 0.62, 0.4];
    preroll = 1.25;
  } else if (mode === 'guard') {
    enemies.spawn('guard', vec(0, 0, 0), {
      passive: true,
      yaw: 0.9,
      patrolLine: [vec(1.8, 0, 1.4), vec(-1.8, 0, -1.4)]
    });
    cam = [2.4, 1.5, 2.8];
    target = [0.3, 0.95, 0.3];
    preroll = 1.4;
  } else if (mode === 'guardaim' || mode === 'guardkneel') {
    // Guard holding an aim at the showcase player (stub at z = 4).
    enemies.spawn('guard', vec(0, 0, -2), {
      passive: true,
      yaw: 0,
      patrolLine: [vec(0, 0, -2)],
      hold: { aim: 1, crouch: mode === 'guardkneel' ? 1 : 0 }
    });
    cam = [1.3, 1.5, 0.4];
    target = [0, 1.1, -2];
    preroll = 2;
  } else if (mode === 'guarddead') {
    const guard = enemies.spawn('guard', vec(0, 0, 0), {
      passive: true,
      yaw: 0.6
    });
    for (let i = 0; i < 30; i++) {
      enemies.update(1 / 60);
    }
    guard!.damage(999, guard!.pos, vec(0.4, 0, -0.9), 'body');
    cam = [2.4, 1.3, 2.8];
    target = [0, 0.4, 0];
    preroll = 1.5;
  } else if (mode === 'fight') {
    enemies.spawn('hound', vec(-7, 0, -9), {
      state: 'alert'
    });
    enemies.spawn('hound', vec(8, 0, -7), {
      state: 'alert'
    });
    enemies.spawn('hound', vec(0, 0, -14), {
      state: 'alert'
    });
    enemies.spawn('gull', vec(-5, 6, -13), {
      state: 'alert'
    });
    enemies.spawn('gull', vec(9, 6, -11), {
      state: 'alert'
    });
    cam = [5, 2.6, 10];
    target = [0, 2.2, -5];
    preroll = 7;
  } else if (mode === 'dead') {
    const hound = enemies.spawn('hound', vec(0, 0, 0), {
      passive: true,
      yaw: 0.8
    });
    const gull = enemies.spawn('gull', vec(-1.6, 3.4, -0.5), {
      passive: true,
      hover: 3.4,
      patrolRadius: 0.02
    });
    enemies.spawn('hound', vec(2.2, 0, -1.6), {
      passive: true,
      yaw: -0.6,
      patrolLine: [vec(2.2, 0, -1.6), vec(3.4, 0, -3)]
    });
    for (let i = 0; i < 30; i++) {
      enemies.update(1 / 60);
    }
    hound!.damage(999, hound!.pos, vec(0.6, 0, -0.8), 'body');
    for (let i = 0; i < 110; i++) {
      enemies.update(1 / 60);
    }
    gull!.damage(999, gull!.pos, vec(0, 0, 1), 'body');
    cam = [2.6, 1.3, 3.2];
    target = [0, 0.5, 0];
    preroll = 0.42;
  } else {
    enemies.spawn('gull', vec(-0.9, 2.2, -0.2), {
      passive: true,
      hover: 2.2,
      patrolRadius: 0.25,
      yaw: 0.5
    });
    enemies.spawn('hound', vec(0.2, 0, 0.6), {
      passive: true,
      yaw: 1.2,
      patrolLine: [vec(2.6, 0, 1.2), vec(-1.8, 0, 0.2)]
    });
  }
  if (game.params.epre != null) {
    preroll = +game.params.epre;
  }
  for (let i = 0, frames = Math.round(preroll * 60); i < frames; i++) {
    enemies.update(1 / 60);
  }
  const frozen = !!game.params.efreeze;
  return {
    cam: cam,
    target: target,
    update(dt) {
      if (!frozen) {
        enemies.update(dt);
      }
    }
  };
}

export { ENEMY_TUNING as TUNE, createEnemies as create, setupEnemyShowcase as showcase };
