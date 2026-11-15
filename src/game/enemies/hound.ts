// Hound walker: tuning and the instance factory for the quadruped gun-turret robot,
// with nav-mesh path following, fire-position selection, a lunge attack, a procedural
// two-pair gait with leg IK, spring-driven body sway and a collapsing wreck state.
import { Mesh, PlaneGeometry, Vector3 } from 'three';
import type { Bone } from 'three';
import type { Player } from '../player/index';
import { createSkinnedRig, solveLegIk } from './rig';
import type { LegIkResult, RigDef } from './rig';
import { HOUND_DIMENSIONS } from './gull';
import type {
  Enemy,
  EnemyAudioSource,
  EnemyContext,
  EnemyMaterials,
  EnemyRayHit,
  EnemySpawnOptions
} from './index';

/** Hound combat / locomotion tuning. */
export const HOUND_TUNING = {
  hp: 140,
  shotDamage: 5,
  burst: 4,
  burstGap: 0.11,
  telegraph: 0.5,
  cooldown: [1.8, 3],
  runSpeed: 4.5,
  stalkSpeed: 2,
  patrolSpeed: 1.5,
  accel: 7,
  turnRate: 2.5,
  rangeMin: 8,
  rangeMax: 18,
  spreadFar: 0.12,
  spreadNear: 0.045,
  lungeRange: 3,
  lungeDamage: 15,
  lungeCooldown: 3.5,
  lungeSpeed: 9.5,
  replan: 0.6,
  smokeBelow: 0.4
};

export const HOUND_CFG = HOUND_TUNING;
export const HOUND_DIMS = HOUND_DIMENSIONS;
export const tmpHullCapsuleA = new Vector3();
export const tmpHullCapsuleB = new Vector3();
export const tmpHoundProbeDir = new Vector3();
export const tmpHoundProbeOrigin = new Vector3();
export const tmpTracerEnd = new Vector3();
export const tmpSightTarget = new Vector3();
export const HOUND_UP = new Vector3(0, 1, 0);
export const tmpLegIk: LegIkResult = {
  abd: 0,
  hip: 0,
  knee: 0,
  reach: 0
};

export const HOUND_LENS_IDLE_COLOR: number[] = [8, 4, 0.7];
export const HOUND_LENS_ALERT_COLOR: number[] = [14, 1, 0.35];

/** Signed angle a - b wrapped to [-PI, PI]. */
export const houndAngleDelta = (a: number, b: number): number => {
  let delta = (a - b) % (Math.PI * 2);
  if (delta > Math.PI) {
    delta -= Math.PI * 2;
  } else if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return delta;
};

export const houndClamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/** Diagonal leg pairs that step together (FL+RR, FR+RL). */
export const GAIT_LEG_PAIRS = [
  [0, 3],
  [1, 2]
];

/** 1D spring state: value and velocity. */
export interface Spring {
  x: number;
  v: number;
}

/** Advances a spring toward `target` by one semi-implicit Euler step; returns the new value. */
function stepSpring(
  spring: Spring,
  target: number,
  stiffness: number,
  damping: number,
  dt: number
): number {
  spring.v += ((target - spring.x) * stiffness - spring.v * damping) * dt;
  spring.x += spring.v * dt;
  return spring.x;
}

/** Planted / swinging foot state (world space). */
export interface HoundFoot {
  /** Current foot position. */
  p: Vector3;
  /** Swing start and target. */
  from: Vector3;
  to: Vector3;
  /** Death slide offset. */
  slide: Vector3;
}

/**
 * Hound engage sub-state: move to a fire position, aim, telegraph, burst, cool down; or
 * wind up, lunge and recover for the melee attack.
 */
export type HoundEngageState =
  'move' | 'aim' | 'cool' | 'tele' | 'burst' | 'wind' | 'lunge' | 'recover';

/** A hound walker instance. */
export interface HoundEnemy extends Enemy {
  type: 'hound';
  feet: HoundFoot[];
  speed: number;
  yawRate: number;
  /** Desired yaw this frame. */
  wantYaw?: number;
  goal: Vector3;
  /** Chosen firing position and the player position it was chosen for. */
  firePos: Vector3;
  firePlayer: Vector3;
  /** Head position (weak spot), refreshed every pose update. */
  headPos: Vector3;
  /** Separation push velocity. */
  push: Vector3;
  /** Mode seen on the previous frame (to react to mode changes). */
  modeSeen?: string;
  es: HoundEngageState;
  esT: number;
  cool: number;
  shots: number;
  bursts: number;
  lungeCd: number;
  path: Vector3[] | null;
  /** Current waypoint index in `path`. */
  wp: number;
  planT: number;
  hasGoal: boolean;
  waitT: number;
  moveT: number;
  stuckT: number;
  patrolR?: number;
  patrolLine?: Vector3[] | null;
  patrolI?: number;
  feelT?: number;
  blocked?: boolean;
  /** Swinging leg pair (-1 when all feet are planted). */
  sw: number;
  swT: number;
  swDur: number;
  lastPair: number;
  idleT: number;
  /** Foot lift height of the current step. */
  lift: number;
  /** Body springs: height, pitch, roll, lateral; antenna pitch / roll. */
  sY: Spring;
  sP: Spring;
  sR: Spring;
  sL: Spring;
  sA: Spring;
  sA2: Spring;
  crouch: number;
  /** Turret yaw / gun pitch, head yaw / pitch (relative to the body). */
  tyaw: number;
  tpitch: number;
  hyaw: number;
  hpitch: number;
  scan: number;
  /** Vertical velocity of the collapsing body. */
  vy: number;
  dieRoll: number;
  diePitch: number;
  /** Wreck smoke finished (rotor sound stopped). */
  wreck: boolean;
  /** Seconds sinking into the ground (0 = not sinking). */
  sink: number;
  prevSpeed: number;
  maxSpeed: number;
}

/** Creates pooled hound number `index` (inactive until spawned). */
export function createHound(
  ctx: EnemyContext,
  def: RigDef,
  mats: EnemyMaterials,
  index: number
): HoundEnemy {
  const game = ctx.G;
  const rng = ctx.rng;
  const lensMat = mats.lensBase.clone();
  const rig = createSkinnedRig(
    def,
    {
      shell: mats.shell,
      metal: mats.metal,
      glow: mats.glow,
      lens: lensMat
    },
    {
      radius: 1.5,
      center: [0, 0.6, 0]
    }
  );
  const bones = rig.bones;
  rig.group.visible = false;
  const abdBones: Bone[] = [];
  const thighBones: Bone[] = [];
  const shinBones: Bone[] = [];
  for (let i = 0; i < 4; i++) {
    abdBones.push(bones['abd' + HOUND_DIMS.legs[i]]);
    thighBones.push(bones['thigh' + HOUND_DIMS.legs[i]]);
    shinBones.push(bones['shin' + HOUND_DIMS.legs[i]]);
  }
  const label = game.mats.label('H-' + String(index + 3).padStart(2, '0'), {
    color: 'black',
    font: 'stencil',
    distress: 0.3
  });
  const labelWidth = 0.2;
  const labelHeight = Math.min(0.085, labelWidth / (label.aspect || 3));
  const labelGeoRight = new PlaneGeometry(labelWidth, labelHeight);
  labelGeoRight.rotateY(Math.PI / 2);
  labelGeoRight.translate(0.1675, 0.03, -0.085);
  const labelGeoLeft = new PlaneGeometry(labelWidth, labelHeight);
  labelGeoLeft.rotateY(-Math.PI / 2);
  labelGeoLeft.translate(-0.1675, 0.03, -0.085);
  const labelGeo = ctx.mergeSimple([labelGeoRight, labelGeoLeft]);
  const labelMesh = new Mesh(labelGeo, label.material);
  labelMesh.castShadow = false;
  labelMesh.receiveShadow = true;
  bones.body.add(labelMesh);
  const feet: HoundFoot[] = [0, 1, 2, 3].map(() => ({
    p: new Vector3(),
    from: new Vector3(),
    to: new Vector3(),
    slide: new Vector3()
  }));
  const hound: HoundEnemy = {
    id: 0,
    type: 'hound',
    pos: rig.group.position,
    alive: false,
    hp: HOUND_CFG.hp,
    active: false,
    rig: rig,
    lens: lensMat,
    feet: feet,
    yaw: 0,
    speed: 0,
    yawRate: 0,
    home: new Vector3(),
    lastKnown: new Vector3(),
    goal: new Vector3(),
    firePos: new Vector3(),
    firePlayer: new Vector3(),
    sensor: new Vector3(),
    fwd: new Vector3(0, 0, 1),
    muzzle: new Vector3(),
    headPos: new Vector3(),
    push: new Vector3(),
    mode: 'patrol',
    los: false,
    seeT: 0,
    noSeeT: 0,
    senseT: 0,
    exposure: 0,
    modeT: 0,
    passive: false,
    hasToken: false,
    es: 'move',
    esT: 0,
    cool: 1,
    shots: 0,
    bursts: 0,
    lungeCd: 0,
    path: null,
    wp: 0,
    planT: 0,
    hasGoal: false,
    waitT: 0,
    moveT: 0,
    stuckT: 0,
    sw: -1,
    swT: 0,
    swDur: 0.2,
    lastPair: 1,
    idleT: 0,
    lift: 0.08,
    sY: {
      x: 0,
      v: 0
    },
    sP: {
      x: 0,
      v: 0
    },
    sR: {
      x: 0,
      v: 0
    },
    sL: {
      x: 0,
      v: 0
    },
    sA: {
      x: 0,
      v: 0
    },
    sA2: {
      x: 0,
      v: 0
    },
    crouch: 0,
    tyaw: 0,
    tpitch: 0,
    hyaw: 0,
    hpitch: 0,
    flare: 0,
    lensC: [HOUND_LENS_IDLE_COLOR[0], HOUND_LENS_IDLE_COLOR[1], HOUND_LENS_IDLE_COLOR[2]],
    smokeT: 0,
    phase: 0,
    scan: 0,
    dieT: 0,
    vy: 0,
    dieRoll: 0,
    diePitch: 0,
    wreck: false,
    sink: 0,
    loop: null,
    prevSpeed: 0,
    maxSpeed: HOUND_CFG.patrolSpeed,
    damage(amount, point, dir, part) {
      if (!hound.alive) {
        return false;
      }
      hound.hp -= amount;
      game.events.emit('enemy:hit', {
        enemy: hound,
        point: point,
        part: part || 'body'
      });
      if (dir) {
        const cosYaw = Math.cos(hound.yaw);
        const sinYaw = Math.sin(hound.yaw);
        const strength = Math.min(1.6, amount / 28);
        const hitFwd = dir.x * sinYaw + dir.z * cosYaw;
        const hitSide = dir.x * cosYaw - dir.z * sinYaw;
        hound.sL.v += hitSide * 1.4 * strength;
        hound.sR.v += -hitSide * 3.2 * strength;
        hound.sP.v += hitFwd * 2.4 * strength * (part === 'weak' ? 1.6 : 1);
        hound.sY.v -= 0.5 * strength;
      }
      ctx.provoke(hound);
      if (hound.hp <= 0) {
        die(dir);
        return true;
      } else {
        return false;
      }
    },
    _activate(pos, opts = {}) {
      hound.active = true;
      hound.alive = true;
      hound.wreck = false;
      hound.hp = HOUND_CFG.hp;
      hound.passive = !!opts.passive;
      hound.sink = 0;
      hound.pos.copy(pos);
      hound.pos.y = game.physics.groundHeight(pos.x, pos.z, pos.y + 1);
      hound.home.copy(hound.pos);
      hound.yaw = opts.yaw ?? rng() * 6.283;
      hound.speed = 0;
      hound.yawRate = 0;
      hound.push.set(0, 0, 0);
      hound.mode = opts.state === 'alert' ? 'investigate' : 'patrol';
      hound.modeT = 10;
      hound.modeSeen = hound.mode;
      hound.lastKnown.copy(opts.target || (game.player ? game.player.pos : pos));
      hound.los = false;
      hound.seeT = hound.noSeeT = 0;
      hound.exposure = 0;
      hound.senseT = rng() * 0.2;
      hound.hasToken = false;
      hound.patrolR = opts.patrolRadius ?? 7;
      hound.patrolLine = opts.patrolLine || null;
      hound.patrolI = 0;
      hound.es = 'move';
      hound.cool = 0.6 + rng();
      hound.lungeCd = 0.3;
      hound.path = null;
      hound.hasGoal = false;
      hound.waitT = rng() * 1.5;
      hound.planT = 0;
      hound.sw = -1;
      hound.idleT = 0;
      hound.crouch = 0;
      hound.feelT = 0;
      hound.blocked = false;
      hound.flare = 0;
      hound.phase = rng() * 6.283;
      hound.dieT = 0;
      hound.tyaw = hound.hyaw = 0;
      hound.tpitch = hound.hpitch = 0;
      for (const spring of [hound.sY, hound.sP, hound.sR, hound.sL, hound.sA, hound.sA2]) {
        spring.x = 0;
        spring.v = 0;
      }
      for (let i = 0; i < 4; i++) {
        restFootPos(feet[i].p, i, hound.pos.x, hound.pos.z, hound.yaw);
      }
      bones.neck.rotation.set(0, 0, 0);
      bones.gun.rotation.set(0, 0, 0);
      rig.group.visible = true;
      pose(0.016);
      const audio = game.audio as EnemyAudioSource | undefined;
      if (audio && audio.loop && !hound.loop) {
        try {
          hound.loop = audio.loop('hound_servo', {
            pos: hound.pos,
            gain: 0
          });
        } catch {
          hound.loop = null;
        }
      }
    },
    _deactivate() {
      hound.active = false;
      hound.alive = false;
      hound.wreck = false;
      rig.group.visible = false;
      ctx.releaseToken(hound);
      if (hound.loop) {
        try {
          hound.loop.stop();
        } catch {}
        hound.loop = null;
      }
    },
    _raycast(origin, dir, maxDist, hit) {
      let didHit = false;
      if (raySphereHit(origin, dir, hound.headPos, 0.155, maxDist, hit)) {
        hit.part = 'weak';
        hit.enemy = hound;
        didHit = true;
      }
      const cosYaw = Math.cos(hound.yaw);
      const sinYaw = Math.sin(hound.yaw);
      const bodyY = hound.pos.y + HOUND_DIMS.stand + hound.sY.x - hound.crouch;
      tmpHullCapsuleA.set(hound.pos.x - sinYaw * 0.45, bodyY + 0.03, hound.pos.z - cosYaw * 0.45);
      tmpHullCapsuleB.set(hound.pos.x + sinYaw * 0.47, bodyY + 0.03, hound.pos.z + cosYaw * 0.47);
      if (rayCapsuleHit(origin, dir, tmpHullCapsuleA, tmpHullCapsuleB, 0.27, maxDist, hit)) {
        hit.part = 'body';
        hit.enemy = hound;
        didHit = true;
      }
      tmpHullCapsuleA.y = tmpHullCapsuleB.y = hound.pos.y + (bodyY - hound.pos.y) * 0.45;
      if (rayCapsuleHit(origin, dir, tmpHullCapsuleA, tmpHullCapsuleB, 0.25, maxDist, hit)) {
        hit.part = 'body';
        hit.enemy = hound;
        didHit = true;
      }
      return didHit;
    },
    _update(dt) {
      if (hound.alive) {
        updateAlive(dt);
      } else {
        updateWreck(dt);
      }
    }
  };
  /** Writes the neutral standing position of foot `leg` for a body at (x, z, yaw). */
  function restFootPos(out: Vector3, leg: number, x: number, z: number, yaw: number): Vector3 {
    const footSide = HOUND_DIMS.side[leg] * HOUND_DIMS.footX;
    const footFwd = HOUND_DIMS.footZ[leg];
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    out.set(x + footSide * cosYaw + footFwd * sinYaw, 0, z - footSide * sinYaw + footFwd * cosYaw);
    return out;
  }
  function setGoal(target: Vector3, force?: boolean): void {
    if (!force && hound.hasGoal && hound.goal.distanceToSquared(target) < 0.25) {
      return;
    }
    hound.goal.copy(target);
    hound.hasGoal = true;
    hound.planT = 0;
    hound.stuckT = 0;
  }
  function replan(): void {
    hound.planT = HOUND_CFG.replan + rng() * 0.15;
    let path: Vector3[] | null = null;
    try {
      path = game.physics.nav.findPath(hound.pos, hound.goal);
    } catch {
      path = null;
    }
    hound.path = path && path.length ? path : null;
    hound.wp = 0;
    if (hound.path && hound.path.length > 1 && hound.path[0].distanceToSquared(hound.pos) < 0.36) {
      hound.wp = 1;
    }
  }
  /** Steers along the current path; returns true when there is no goal or it was reached. */
  function followPath(dt: number, speed: number): boolean {
    if (!hound.hasGoal) {
      hound.maxSpeed = 0;
      return true;
    }
    hound.planT -= dt;
    if (hound.planT <= 0) {
      replan();
    }
    let waypoint = hound.goal;
    if (hound.path) {
      for (
        ;
        hound.wp < hound.path.length - 1 &&
        Math.hypot(hound.path[hound.wp].x - hound.pos.x, hound.path[hound.wp].z - hound.pos.z) <
          0.55;
      ) {
        hound.wp++;
      }
      waypoint = hound.path[Math.min(hound.wp, hound.path.length - 1)];
    }
    const goalDx = hound.goal.x - hound.pos.x;
    const goalDz = hound.goal.z - hound.pos.z;
    const goalDist = Math.hypot(goalDx, goalDz);
    if (goalDist < 0.45) {
      hound.hasGoal = false;
      hound.maxSpeed = 0;
      return true;
    }
    const wpDx = waypoint.x - hound.pos.x;
    const wpDz = waypoint.z - hound.pos.z;
    hound.wantYaw = Math.atan2(wpDx, wpDz);
    const turnNeeded = Math.abs(houndAngleDelta(hound.wantYaw, hound.yaw));
    hound.maxSpeed =
      turnNeeded > 1.1 ? 0 : Math.min(speed * (1 - turnNeeded * 0.5), 0.4 + goalDist * 2.6);
    return false;
  }
  /** Scores cover points and random spots around the player and moves to the best one. */
  function pickFirePos(): void {
    const player = game.player;
    if (!player) {
      return;
    }
    let bestScore = Infinity;
    const playerEye = player.eye || player.pos;
    const consider = (candidate: Vector3, bias: number) => {
      const distToPlayer = Math.hypot(candidate.x - player.pos.x, candidate.z - player.pos.z);
      if (
        distToPlayer < HOUND_CFG.rangeMin ||
        distToPlayer > HOUND_CFG.rangeMax ||
        (game.physics.nav.isWalkable && !game.physics.nav.isWalkable(candidate.x, candidate.z))
      ) {
        return;
      }
      let score =
        Math.hypot(candidate.x - hound.pos.x, candidate.z - hound.pos.z) * 0.9 + bias + rng() * 3;
      const offX = candidate.x - player.pos.x;
      const offZ = candidate.z - player.pos.z;
      for (const other of ctx.list) {
        if (other === hound || !other.alive || other.type !== 'hound' || other.mode !== 'engage') {
          continue;
        }
        const otherSpot = other.es === 'move' ? other.firePos : other.pos;
        const otherOffX = otherSpot.x - player.pos.x;
        const otherOffZ = otherSpot.z - player.pos.z;
        const alignment =
          (offX * otherOffX + offZ * otherOffZ) /
          (Math.hypot(offX, offZ) * Math.hypot(otherOffX, otherOffZ) + 1e-4);
        if (alignment > 0.86) {
          score += (14 * (alignment - 0.86)) / 0.14;
        }
        if (Math.hypot(candidate.x - otherSpot.x, candidate.z - otherSpot.z) < 3) {
          score += 16;
        }
      }
      if (score >= bestScore) {
        return;
      }
      tmpSightTarget.set(candidate.x, candidate.y + 0.95, candidate.z);
      if (!game.physics.lineOfSight(tmpSightTarget, playerEye)) {
        score += 22;
      }
      if (score < bestScore) {
        bestScore = score;
        hound.firePos.set(candidate.x, candidate.y, candidate.z);
      }
    };
    const coverPoints = game.level && game.level.coverPoints;
    if (coverPoints) {
      for (let i = 0; i < coverPoints.length; i++) {
        consider(coverPoints[i], -2);
      }
    }
    for (let i = 0; i < 7; i++) {
      const point = game.physics.nav.randomPoint(player.pos, HOUND_CFG.rangeMax);
      if (point) {
        consider(point, 0);
      }
    }
    const awayAngle = Math.atan2(hound.pos.z - player.pos.z, hound.pos.x - player.pos.x);
    for (let i = 0; i < 5; i++) {
      const angle = awayAngle + (rng() - 0.5) * 2.6;
      const radius = HOUND_CFG.rangeMin + 1 + rng() * (HOUND_CFG.rangeMax - HOUND_CFG.rangeMin - 2);
      tmpHoundProbeOrigin.set(
        player.pos.x + Math.cos(angle) * radius,
        player.pos.y,
        player.pos.z + Math.sin(angle) * radius
      );
      tmpHoundProbeOrigin.y = game.physics.groundHeight(
        tmpHoundProbeOrigin.x,
        tmpHoundProbeOrigin.z,
        player.pos.y + 1
      );
      consider(tmpHoundProbeOrigin, 1);
    }
    if (bestScore === Infinity) {
      hound.firePos.copy(hound.pos);
    }
    hound.firePlayer.copy(player.pos);
    setGoal(hound.firePos, true);
    hound.es = 'move';
    hound.esT = 0;
    hound.moveT = 0;
    hound.bursts = 0;
  }
  function updateAlive(dt: number): void {
    const player = game.player;
    const time = ctx.t;
    hound.fwd.set(Math.sin(hound.yaw), 0, Math.cos(hound.yaw));
    hound.sensor.copy(hound.headPos);
    ctx.think(hound, dt, 0.55);
    if (hound.mode !== hound.modeSeen) {
      hound.modeSeen = hound.mode;
      hound.hasGoal = false;
      hound.path = null;
      hound.waitT = 0;
      if (hound.mode === 'engage') {
        pickFirePos();
      } else if (hound.es === 'tele' || hound.es === 'burst') {
        ctx.releaseToken(hound);
        hound.es = 'move';
      }
    }
    hound.wantYaw = hound.yaw;
    hound.maxSpeed = 0;
    hound.cool -= dt;
    hound.lungeCd -= dt;
    let aimTarget = null;
    let lookTarget = null;
    let crouchTarget = 0;
    let lunging = false;
    const playerDist = player
      ? Math.hypot(player.pos.x - hound.pos.x, player.pos.z - hound.pos.z)
      : 1e9;
    if (hound.mode === 'patrol') {
      if (hound.hasGoal) {
        if (followPath(dt, HOUND_CFG.patrolSpeed)) {
          hound.waitT = 1.5 + rng() * 3;
        }
      } else {
        hound.waitT -= dt;
        if (hound.waitT <= 0) {
          if (hound.patrolLine) {
            hound.patrolI = (hound.patrolI! + 1) % hound.patrolLine.length;
            setGoal(hound.patrolLine[hound.patrolI], true);
          } else {
            const point = game.physics.nav.randomPoint(hound.home, hound.patrolR!);
            if (point) {
              setGoal(point, true);
            } else {
              hound.waitT = 1;
            }
          }
        }
      }
    } else if (hound.mode === 'investigate' || hound.mode === 'search') {
      lookTarget = hound.lastKnown;
      const dist = Math.hypot(hound.lastKnown.x - hound.pos.x, hound.lastKnown.z - hound.pos.z);
      if (dist > 2.2) {
        setGoal(hound.lastKnown);
        followPath(dt, dist < 8 ? HOUND_CFG.stalkSpeed : HOUND_CFG.runSpeed);
      } else {
        hound.hasGoal = false;
        hound.scan += dt;
        hound.wantYaw = hound.yaw + Math.sin(hound.scan * 0.8) * 0.9;
        lookTarget = null;
      }
    } else if (player) {
      aimTarget = player.pos;
      lookTarget = player.pos;
      const playerYaw = Math.atan2(player.pos.x - hound.pos.x, player.pos.z - hound.pos.z);
      if (
        (hound.es === 'move' || hound.es === 'aim' || hound.es === 'cool') &&
        playerDist < HOUND_CFG.lungeRange &&
        hound.lungeCd <= 0 &&
        player.alive
      ) {
        hound.es = 'wind';
        hound.esT = 0.28;
        ctx.releaseToken(hound);
        game.events.emit('enemy:telegraph', {
          enemy: hound,
          type: 'hound',
          time: 0.28,
          pos: hound.pos,
          melee: true
        });
      }
      switch (hound.es) {
        case 'move': {
          hound.moveT += dt;
          const arrived = followPath(dt, HOUND_CFG.runSpeed);
          const inRange =
            playerDist > HOUND_CFG.rangeMin - 1 && playerDist < HOUND_CFG.rangeMax + 2;
          if (
            arrived ||
            (hound.moveT > 1.4 && hound.los && inRange && rng() < dt * 0.7) ||
            hound.moveT > 7
          ) {
            hound.es = 'aim';
            hound.esT = 0;
            hound.hasGoal = false;
          } else if (player.pos.distanceToSquared(hound.firePlayer) > 49) {
            pickFirePos();
          }
          break;
        }
        case 'aim':
        case 'cool': {
          hound.wantYaw = playerYaw;
          hound.esT += dt;
          if (hound.los) {
            if (playerDist < HOUND_CFG.rangeMin - 3 && hound.esT > 0.8) {
              pickFirePos();
            } else if (
              hound.cool <= 0 &&
              player.alive &&
              Math.abs(houndAngleDelta(playerYaw - hound.yaw, hound.tyaw)) < 0.14 &&
              ctx.requestToken(hound)
            ) {
              hound.es = 'tele';
              hound.esT = HOUND_CFG.telegraph;
              game.events.emit('enemy:telegraph', {
                enemy: hound,
                type: 'hound',
                time: HOUND_CFG.telegraph,
                pos: hound.pos
              });
            }
          } else if (hound.noSeeT > 1.1 || hound.esT > 3) {
            pickFirePos();
          }
          break;
        }
        case 'tele': {
          hound.wantYaw = playerYaw;
          hound.esT -= dt;
          hound.flare = Math.min(1, hound.flare + dt * 5);
          crouchTarget = 0.05;
          if (hound.esT <= 0) {
            hound.es = 'burst';
            hound.shots = HOUND_CFG.burst;
            hound.esT = 0;
          }
          break;
        }
        case 'burst': {
          hound.wantYaw = playerYaw;
          hound.esT -= dt;
          hound.flare = 1;
          crouchTarget = 0.05;
          if (hound.esT <= 0) {
            hound.esT = HOUND_CFG.burstGap;
            hound.shots--;
            fireShot(player);
          }
          if (hound.shots <= 0) {
            ctx.releaseToken(hound);
            hound.cool =
              HOUND_CFG.cooldown[0] + rng() * (HOUND_CFG.cooldown[1] - HOUND_CFG.cooldown[0]);
            hound.bursts++;
            if (hound.bursts >= 1 + (rng() < 0.4 ? 1 : 0)) {
              pickFirePos();
            } else {
              hound.es = 'cool';
              hound.esT = 0;
            }
          }
          break;
        }
        case 'wind': {
          hound.wantYaw = playerYaw;
          hound.esT -= dt;
          crouchTarget = 0.16;
          hound.sP.v += 3 * dt;
          if (hound.esT <= 0) {
            hound.es = 'lunge';
            hound.esT = 0.36;
            hound.speed = HOUND_CFG.lungeSpeed;
            hound.yaw = playerYaw;
          }
          break;
        }
        case 'lunge': {
          lunging = true;
          hound.esT -= dt;
          hound.wantYaw = playerYaw;
          hound.maxSpeed = HOUND_CFG.lungeSpeed;
          hound.speed = HOUND_CFG.lungeSpeed;
          if (playerDist < 1.35 && player.alive) {
            player.damage(HOUND_CFG.lungeDamage, hound.pos);
            game.events.emit('enemy:melee', {
              enemy: hound,
              pos: hound.pos
            });
            hound.esT = 0;
            hound.sP.v -= 4;
          }
          if (hound.esT <= 0) {
            hound.es = 'recover';
            hound.esT = 0.55;
            hound.lungeCd = HOUND_CFG.lungeCooldown;
            hound.speed *= 0.3;
          }
          break;
        }
        case 'recover': {
          hound.esT -= dt;
          hound.wantYaw = playerYaw;
          if (hound.esT <= 0) {
            pickFirePos();
          }
          break;
        }
      }
    }
    const yawError = houndAngleDelta(hound.wantYaw, hound.yaw);
    const targetYawRate =
      houndClamp(yawError * 6, -HOUND_CFG.turnRate, HOUND_CFG.turnRate) * (lunging ? 2 : 1);
    hound.yawRate += (targetYawRate - hound.yawRate) * (1 - Math.exp(-10 * dt));
    hound.yaw += hound.yawRate * dt;
    const accel = hound.maxSpeed > hound.speed ? HOUND_CFG.accel : -HOUND_CFG.accel * 1.4;
    hound.prevSpeed = hound.speed;
    hound.speed = lunging
      ? hound.speed
      : houndClamp(hound.speed + accel * dt, 0, Math.max(hound.maxSpeed, 0));
    if (!lunging && accel < 0 && hound.speed < hound.maxSpeed) {
      hound.speed = hound.maxSpeed;
    }
    const moveSin = Math.sin(hound.yaw);
    const moveCos = Math.cos(hound.yaw);
    for (const other of ctx.list) {
      if (other === hound || other.type !== 'hound' || !other.active) {
        continue;
      }
      const dx = hound.pos.x - other.pos.x;
      const dz = hound.pos.z - other.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 1.7 && dist > 0.001) {
        const pushStrength = ((1.7 - dist) * 2.2) / dist;
        hound.push.x += dx * pushStrength * dt * 6;
        hound.push.z += dz * pushStrength * dt * 6;
      }
    }
    if (player && !lunging && playerDist < 1.25 && playerDist > 0.001) {
      const pushStrength = ((1.25 - playerDist) * 3) / playerDist;
      hound.push.x += (hound.pos.x - player.pos.x) * pushStrength * dt * 6;
      hound.push.z += (hound.pos.z - player.pos.z) * pushStrength * dt * 6;
    }
    hound.push.multiplyScalar(Math.exp(-5 * dt));
    let nextX = hound.pos.x + (moveSin * hound.speed + hound.push.x) * dt;
    let nextZ = hound.pos.z + (moveCos * hound.speed + hound.push.z) * dt;
    const nav = game.physics.nav;
    hound.feelT! -= dt;
    if (hound.feelT! <= 0 && hound.speed > 0.3) {
      hound.feelT = 0.12;
      tmpHoundProbeOrigin.set(hound.pos.x, hound.pos.y + 0.55, hound.pos.z);
      tmpHoundProbeDir.set(moveSin, 0, moveCos);
      const hit = game.physics.raycast(
        tmpHoundProbeOrigin,
        tmpHoundProbeDir,
        0.75 + hound.speed * 0.12
      );
      hound.blocked = !!hit;
    } else if (hound.speed <= 0.3) {
      hound.blocked = false;
    }
    if (
      (nav.isWalkable && !nav.isWalkable(nextX, nextZ)) ||
      (hound.blocked && !lunging) ||
      (hound.blocked && lunging && hound.esT < 0.3)
    ) {
      if (hound.blocked) {
        nextX = hound.pos.x + hound.push.x * dt;
        nextZ = hound.pos.z + hound.push.z * dt;
        hound.yawRate += (hound.phase > 3.14 ? 1 : -1) * 4 * dt;
      } else if (nav.isWalkable(nextX, hound.pos.z)) {
        nextZ = hound.pos.z;
      } else if (nav.isWalkable(hound.pos.x, nextZ)) {
        nextX = hound.pos.x;
      } else {
        nextX = hound.pos.x;
        nextZ = hound.pos.z;
      }
      hound.speed *= 0.6;
      hound.stuckT += dt;
      if (hound.stuckT > 0.5) {
        hound.stuckT = 0;
        hound.planT = 0;
        if (hound.mode === 'engage' && hound.es === 'move') {
          pickFirePos();
        } else if (hound.mode === 'patrol') {
          hound.hasGoal = false;
        }
      }
    }
    hound.pos.x = nextX;
    hound.pos.z = nextZ;
    hound.pos.y +=
      (game.physics.groundHeight(nextX, nextZ, hound.pos.y + 0.6) - hound.pos.y) *
      (1 - Math.exp(-12 * dt));
    updateGait(dt);
    hound.crouch += (crouchTarget - hound.crouch) * (1 - Math.exp(-12 * dt));
    const cosYaw = Math.cos(hound.yaw);
    const sinYaw = Math.sin(hound.yaw);
    let turretYaw = 0;
    let turretPitch = 0;
    let headYaw = 0;
    let headPitch = 0.05;
    const bodyY = hound.pos.y + HOUND_DIMS.stand + hound.sY.x - hound.crouch;
    if (aimTarget) {
      const dx = aimTarget.x - hound.pos.x;
      const dz = aimTarget.z - hound.pos.z;
      const dy = aimTarget.y + 1 - (bodyY + 0.25);
      turretYaw = Math.atan2(dx * cosYaw - dz * sinYaw, dx * sinYaw + dz * cosYaw);
      turretPitch = houndClamp(Math.atan2(-dy, Math.hypot(dx, dz)), -0.9, 0.35);
    } else {
      hound.scan += dt * 0.5;
      turretYaw = Math.sin(hound.scan * 0.9 + hound.phase) * 1.1;
    }
    if (lookTarget) {
      const dx = lookTarget.x - hound.pos.x;
      const dz = lookTarget.z - hound.pos.z;
      const dy = lookTarget.y + 1.2 - (bodyY + 0.2);
      headYaw = houndClamp(
        Math.atan2(dx * cosYaw - dz * sinYaw, dx * sinYaw + dz * cosYaw),
        -1.2,
        1.2
      );
      headPitch = houndClamp(Math.atan2(-dy, Math.hypot(dx, dz)), -0.6, 0.5);
    } else {
      headYaw =
        Math.sin(ctx.t * 0.7 + hound.phase) * 0.5 + houndClamp(hound.yawRate * 0.25, -0.6, 0.6);
    }
    const maxTurretStep = houndClamp(4.5 * dt, 0, 1);
    hound.tyaw += houndClamp(houndAngleDelta(turretYaw, hound.tyaw), -maxTurretStep, maxTurretStep);
    hound.tpitch += (turretPitch - hound.tpitch) * (1 - Math.exp(-10 * dt));
    const headBlend = 1 - Math.exp(-7 * dt);
    hound.hyaw += (headYaw - hound.hyaw) * headBlend;
    hound.hpitch += (headPitch - hound.hpitch) * headBlend;
    pose(dt);
    const beaconPhase = (ctx.t * (hound.mode === 'patrol' ? 0.8 : 2.2) + hound.phase) % 1;
    bones.beacon.scale.setScalar(
      beaconPhase < 0.12 || (beaconPhase > 0.22 && beaconPhase < 0.3) ? 1 : 1e-4
    );
    const lensTarget = hound.mode === 'engage' ? HOUND_LENS_ALERT_COLOR : HOUND_LENS_IDLE_COLOR;
    const lensGain = 1 + hound.flare * 3.5;
    for (let i = 0; i < 3; i++) {
      hound.lensC[i] += (lensTarget[i] - hound.lensC[i]) * (1 - Math.exp(-8 * dt));
    }
    lensMat.color.setRGB(
      hound.lensC[0] * lensGain,
      hound.lensC[1] * lensGain,
      hound.lensC[2] * lensGain
    );
    hound.flare = Math.max(0, hound.flare - dt * 2);
    if (hound.hp < HOUND_CFG.hp * HOUND_CFG.smokeBelow) {
      hound.smokeT -= dt;
      if (hound.smokeT <= 0) {
        hound.smokeT = 0.2;
        tmpHullCapsuleA.set(hound.pos.x - moveSin * 0.3, bodyY + 0.2, hound.pos.z - moveCos * 0.3);
        game.fx.smoke(tmpHullCapsuleA, {
          size: 0.35,
          life: 1.3,
          color: 0x232528,
          rise: 0.9
        });
        if (rng() < 0.2) {
          game.fx.sparks(tmpHullCapsuleA, HOUND_UP, 3);
        }
      }
    }
    if (hound.loop) {
      hound.loop.setPos(hound.pos);
      hound.loop.setGain(
        houndClamp(0.12 + hound.speed * 0.12 + Math.abs(hound.yawRate) * 0.1, 0, 0.8)
      );
      hound.loop.setPitch(0.8 + hound.speed * 0.08);
    }
  }
  function fireShot(player: Player): void {
    const cosAim = Math.cos(hound.yaw + hound.tyaw);
    const sinAim = Math.sin(hound.yaw + hound.tyaw);
    tmpHoundProbeOrigin.setFromMatrixPosition(bones.gun.matrixWorld);
    if (
      tmpHoundProbeOrigin.lengthSq() < 1e-6 ||
      Math.abs(tmpHoundProbeOrigin.x - hound.pos.x) > 2
    ) {
      tmpHoundProbeOrigin.set(hound.pos.x, hound.pos.y + HOUND_DIMS.stand + 0.25, hound.pos.z);
    }
    tmpSightTarget.set(player.pos.x, player.pos.y + 1, player.pos.z);
    tmpHoundProbeDir.copy(tmpSightTarget).sub(tmpHoundProbeOrigin).normalize();
    hound.muzzle.copy(tmpHoundProbeOrigin).addScaledVector(tmpHoundProbeDir, 0.43);
    const spread =
      (HOUND_CFG.spreadFar + (HOUND_CFG.spreadNear - HOUND_CFG.spreadFar) * hound.exposure) *
      (1 + ctx.playerSpeed * 0.3);
    tmpHoundProbeDir.x += (rng() - 0.5) * 2 * spread;
    tmpHoundProbeDir.y += (rng() - 0.5) * 2 * spread;
    tmpHoundProbeDir.z += (rng() - 0.5) * 2 * spread;
    tmpHoundProbeDir.normalize();
    const hit = game.physics.raycast(hound.muzzle, tmpHoundProbeDir, 200);
    const tracerLen = game.combat.enemyShot(hound.muzzle, tmpHoundProbeDir, {
      damage: HOUND_CFG.shotDamage,
      range: 200
    })
      ? hound.muzzle.distanceTo(tmpSightTarget)
      : hit
        ? hit.dist
        : 90;
    tmpTracerEnd.copy(hound.muzzle).addScaledVector(tmpHoundProbeDir, tracerLen);
    game.fx.tracer(hound.muzzle, tmpTracerEnd, {
      color: 0xffc070,
      speed: 260,
      width: 0.035
    });
    game.fx.muzzleFlash(hound.muzzle, tmpHoundProbeDir, {
      scale: 0.9
    });
    if (game.render && game.render.lightPool) {
      game.render.lightPool.flash(hound.muzzle, 0xffb060, 22, 7, 0.05);
    }
    game.events.emit('enemy:fire', {
      enemy: hound,
      pos: hound.muzzle,
      dir: tmpHoundProbeDir,
      type: 'hound'
    });
    hound.sP.v += 1.1;
    hound.sY.v -= 0.25;
  }
  function updateGait(dt: number): void {
    const velX = Math.sin(hound.yaw) * hound.speed + hound.push.x;
    const velZ = Math.cos(hound.yaw) * hound.speed + hound.push.z;
    const moving = hound.speed > 0.15 || Math.abs(hound.yawRate) > 0.25;
    if (hound.sw < 0) {
      hound.idleT = moving ? 0 : hound.idleT + dt;
      const gaitSpeed = hound.speed + Math.abs(hound.yawRate) * 0.5;
      const stepTime = houndClamp(0.27 - gaitSpeed * 0.026, 0.14, 0.27);
      let bestPair = -1;
      let bestError = 0;
      for (let pair = 0; pair < 2; pair++) {
        let pairError = 0;
        for (const leg of GAIT_LEG_PAIRS[pair]) {
          restFootPos(
            tmpHullCapsuleA,
            leg,
            hound.pos.x + velX * stepTime,
            hound.pos.z + velZ * stepTime,
            hound.yaw + hound.yawRate * stepTime
          );
          const error = Math.hypot(
            tmpHullCapsuleA.x - feet[leg].p.x,
            tmpHullCapsuleA.z - feet[leg].p.z
          );
          if (error > pairError) {
            pairError = error;
          }
        }
        if (pair !== hound.lastPair) {
          pairError *= 1.25;
        }
        if (pairError > bestError) {
          bestError = pairError;
          bestPair = pair;
        }
      }
      const threshold = moving ? 0.09 : hound.idleT > 0.25 ? 0.035 : 1e9;
      if (bestPair >= 0 && bestError > threshold) {
        hound.sw = bestPair;
        hound.swT = 0;
        hound.swDur = stepTime;
        hound.lift = 0.065 + Math.min(0.09, gaitSpeed * 0.02);
        for (const leg of GAIT_LEG_PAIRS[bestPair]) {
          const foot = feet[leg];
          foot.from.copy(foot.p);
          restFootPos(
            foot.to,
            leg,
            hound.pos.x + velX * stepTime * 1.5,
            hound.pos.z + velZ * stepTime * 1.5,
            hound.yaw + hound.yawRate * stepTime * 1.5
          );
          foot.to.y = game.physics.groundHeight(foot.to.x, foot.to.z, hound.pos.y + 0.6);
        }
      }
    } else {
      hound.swT += dt / hound.swDur;
      const progress = hound.swT >= 1 ? 1 : hound.swT;
      const eased = progress * progress * (3 - 2 * progress);
      for (const leg of GAIT_LEG_PAIRS[hound.sw]) {
        const foot = feet[leg];
        foot.p.lerpVectors(foot.from, foot.to, eased);
        foot.p.y += Math.sin(Math.PI * progress) * hound.lift;
      }
      if (hound.swT >= 1) {
        const leadFoot = feet[GAIT_LEG_PAIRS[hound.sw][0]];
        game.events.emit('enemy:step', {
          pos: leadFoot.p,
          type: 'hound',
          enemy: hound,
          speed: hound.speed
        });
        hound.sY.v -= 0.12 + hound.speed * 0.03;
        hound.lastPair = hound.sw;
        hound.sw = -1;
      }
    }
  }
  /** Applies body springs, turret / head aim and leg IK to the rig. */
  function pose(dt: number): void {
    const cosYaw = Math.cos(hound.yaw);
    const sinYaw = Math.sin(hound.yaw);
    const frontY = (feet[0].p.y + feet[1].p.y) * 0.5;
    const rearY = (feet[2].p.y + feet[3].p.y) * 0.5;
    const leftY = (feet[0].p.y + feet[2].p.y) * 0.5;
    const rightY = (feet[1].p.y + feet[3].p.y) * 0.5;
    const footLift = (frontY + rearY) * 0.5 - hound.pos.y;
    const accel = dt > 0 ? (hound.speed - hound.prevSpeed) / dt : 0;
    let bodyPitch = Math.atan2(rearY - frontY, 0.8) * 0.6 + houndClamp(accel * 0.006, -0.07, 0.07);
    let bodyRoll =
      Math.atan2(leftY - rightY, 0.55) * 0.6 +
      houndClamp(hound.yawRate * hound.speed * 0.02, -0.12, 0.12);
    let bodyDrop = footLift * 0.45 - Math.min(0.05, hound.speed * 0.011);
    if (!hound.alive) {
      bodyPitch = hound.diePitch;
      bodyRoll = hound.dieRoll;
      bodyDrop = 0;
    }
    if (hound.alive) {
      stepSpring(hound.sY, bodyDrop, 160, 17, dt);
      stepSpring(hound.sP, bodyPitch, 130, 15, dt);
      stepSpring(hound.sR, bodyRoll, 130, 15, dt);
      stepSpring(hound.sL, 0, 110, 13, dt);
    }
    const breathe = hound.alive ? Math.sin(ctx.t * 1.7 + hound.phase) * 0.004 : 0;
    const bodyX = hound.sL.x;
    const bodyY = HOUND_DIMS.stand + hound.sY.x - hound.crouch + breathe;
    const pitch = hound.sP.x;
    const roll = hound.sR.x;
    rig.group.rotation.y = hound.yaw;
    bones.body.position.set(bodyX, bodyY, 0);
    bones.body.rotation.set(pitch, 0, roll);
    bones.turret.rotation.y = hound.tyaw;
    bones.gun.rotation.x = hound.tpitch - pitch * 0.5;
    bones.head.rotation.set(hound.hpitch, hound.hyaw, 0);
    stepSpring(hound.sA, houndClamp(-accel * 0.03 - pitch, -0.6, 0.6), 60, 5, dt);
    stepSpring(hound.sA2, houndClamp(hound.yawRate * 0.12 - roll, -0.6, 0.6), 60, 5, dt);
    bones.antenna.rotation.set(hound.sA.x, 0, hound.sA2.x);
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const cosRoll = Math.cos(roll);
    const sinRoll = Math.sin(roll);
    for (let leg = 0; leg < 4; leg++) {
      const foot = feet[leg].p;
      const worldX = foot.x - hound.pos.x;
      const worldY = foot.y + HOUND_DIMS.footR * 0.6 - hound.pos.y;
      const worldZ = foot.z - hound.pos.z;
      const yawX = worldX * cosYaw - worldZ * sinYaw - bodyX;
      const yawY = worldY - bodyY;
      const yawZ = worldX * sinYaw + worldZ * cosYaw;
      const pitchedY = yawY * cosPitch + yawZ * sinPitch;
      const pitchedZ = -yawY * sinPitch + yawZ * cosPitch;
      const localX = yawX * cosRoll + pitchedY * sinRoll;
      const localY = -yawX * sinRoll + pitchedY * cosRoll;
      solveLegIk(
        tmpLegIk,
        localX - HOUND_DIMS.side[leg] * HOUND_DIMS.hipX,
        localY - HOUND_DIMS.hipY,
        pitchedZ - HOUND_DIMS.fore[leg] * HOUND_DIMS.hipZ,
        HOUND_DIMS.side[leg],
        HOUND_DIMS.l0,
        HOUND_DIMS.L1,
        HOUND_DIMS.L2 - HOUND_DIMS.footR * 0.6
      );
      abdBones[leg].rotation.z = tmpLegIk.abd;
      thighBones[leg].rotation.x = tmpLegIk.hip;
      shinBones[leg].rotation.x = tmpLegIk.knee;
    }
    rig.group.updateMatrixWorld(true);
    hound.headPos.setFromMatrixPosition(bones.head.matrixWorld);
  }
  function die(dir: Vector3 | null | undefined): void {
    hound.alive = false;
    ctx.releaseToken(hound);
    hound.dieT = 0;
    hound.vy = 0;
    hound.es = 'move';
    bones.beacon.scale.setScalar(1e-4);
    hound.dieRoll = (rng() < 0.5 ? -1 : 1) * (0.25 + rng() * 0.3);
    hound.diePitch = (rng() - 0.5) * 0.25;
    hound.sR.v += hound.dieRoll * 3;
    hound.sP.v += (rng() - 0.5) * 2;
    for (let i = 0; i < 4; i++) {
      const foot = feet[i];
      if (hound.sw >= 0) {
        foot.p.y = hound.pos.y;
      }
      const yaw = hound.yaw;
      const slideSide = HOUND_DIMS.side[i] * (0.16 + rng() * 0.2);
      const slideFwd = HOUND_DIMS.fore[i] * (0.05 + rng() * 0.22) + (rng() - 0.5) * 0.1;
      foot.slide.set(
        slideSide * Math.cos(yaw) + slideFwd * Math.sin(yaw),
        0,
        -slideSide * Math.sin(yaw) + slideFwd * Math.cos(yaw)
      );
    }
    hound.sw = -1;
    hound.speed *= 0.3;
    tmpHullCapsuleA.copy(hound.headPos);
    game.fx.sparks(tmpHullCapsuleA, HOUND_UP, 16);
    game.fx.debris(tmpHullCapsuleA, {
      count: 4
    });
    game.events.emit('enemy:killed', {
      enemy: hound,
      pos: hound.pos,
      type: 'hound'
    });
    ctx.addWreck(hound);
  }
  function updateWreck(dt: number): void {
    if (hound.sink > 0) {
      hound.sink += dt;
      hound.pos.y -= 0.22 * dt;
      if (hound.sink > 3.2) {
        ctx.retire(hound);
      }
      return;
    }
    hound.dieT += dt;
    const deadTime = hound.dieT;
    if (deadTime < 2.2) {
      const floorOffset = 0.215 - HOUND_DIMS.stand;
      hound.vy -= 9.8 * dt * (deadTime < 0.12 ? 0.3 : 1);
      hound.sY.x += hound.vy * dt;
      if (hound.sY.x < floorOffset) {
        hound.sY.x = floorOffset;
        if (hound.vy < -1.2) {
          game.events.emit('enemy:step', {
            pos: hound.pos,
            type: 'hound',
            enemy: hound,
            speed: 5,
            crash: true
          });
          game.fx.dust(hound.pos, HOUND_UP);
        }
        hound.vy = -hound.vy * 0.22;
      }
      stepSpring(hound.sP, hound.diePitch, 60, 9, dt);
      stepSpring(hound.sR, hound.dieRoll, 60, 9, dt);
      stepSpring(hound.sL, 0, 40, 8, dt);
      const slideDecay = Math.exp(-3.2 * dt);
      for (let i = 0; i < 4; i++) {
        const foot = feet[i];
        foot.p.x += foot.slide.x * (1 - slideDecay);
        foot.p.z += foot.slide.z * (1 - slideDecay);
        foot.slide.multiplyScalar(slideDecay);
      }
      hound.pos.x += Math.sin(hound.yaw) * hound.speed * dt;
      hound.pos.z += Math.cos(hound.yaw) * hound.speed * dt;
      hound.speed *= Math.exp(-5 * dt);
      hound.hpitch += (0.55 - hound.hpitch) * (1 - Math.exp(-5 * dt));
      hound.hyaw += (hound.dieRoll - hound.hyaw) * (1 - Math.exp(-3 * dt));
      hound.tpitch += (0.3 - hound.tpitch) * (1 - Math.exp(-4 * dt));
      const glow =
        deadTime < 1.2 ? (Math.sin(deadTime * 60) > 0.2 ? 1 - deadTime / 1.2 : 0.05) : 0.02;
      lensMat.color.setRGB(6 * glow + 0.05, 0.6 * glow + 0.01, 0.2 * glow);
      pose(dt);
    }
    if (deadTime < 6.5) {
      hound.smokeT -= dt;
      if (hound.smokeT <= 0) {
        hound.smokeT = deadTime < 2 ? 0.09 : 0.2;
        tmpHullCapsuleA.set(
          hound.pos.x + (rng() - 0.5) * 0.4,
          hound.pos.y + 0.42,
          hound.pos.z + (rng() - 0.5) * 0.4
        );
        game.fx.smoke(tmpHullCapsuleA, {
          size: 0.5 + rng() * 0.3,
          life: 1.8,
          color: 0x17181b,
          rise: 1.1
        });
        if (deadTime < 4 && rng() < 0.55) {
          tmpHullCapsuleB.set(rng() - 0.5, 1, rng() - 0.5).normalize();
          game.fx.sparks(tmpHullCapsuleA, tmpHullCapsuleB, deadTime < 1 ? 8 : 3);
        }
        if (deadTime < 3.5 && rng() < 0.4) {
          game.fx.smoke(tmpHullCapsuleA, {
            size: 0.22,
            life: 0.45,
            color: 0xff7a22,
            rise: 1.6
          });
        }
      }
    } else if (!hound.wreck) {
      hound.wreck = true;
      if (hound.loop) {
        try {
          hound.loop.stop();
        } catch {}
        hound.loop = null;
      }
    }
    if (hound.loop) {
      hound.loop.setGain(Math.max(0, 0.4 - deadTime * 0.3));
    }
  }
  return hound;
}

/** Ray vs sphere; on a nearer hit updates `hit.dist/point/normal` and returns true. */
export function raySphereHit(
  origin: Vector3,
  dir: Vector3,
  center: Vector3,
  radius: number,
  maxDist: number,
  hit: EnemyRayHit
): boolean {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const proj = ox * dir.x + oy * dir.y + oz * dir.z;
  const offsetTerm = ox * ox + oy * oy + oz * oz - radius * radius;
  const discriminant = proj * proj - offsetTerm;
  if (discriminant < 0) {
    return false;
  }
  const dist = -proj - Math.sqrt(discriminant);
  if (dist < 0 || dist > maxDist || dist >= hit.dist) {
    return false;
  } else {
    hit.dist = dist;
    hit.point.copy(origin).addScaledVector(dir, dist);
    hit.normal.copy(hit.point).sub(center).normalize();
    return true;
  }
}

const tmpCapsuleAxis = new Vector3();
const tmpCapsuleToRay = new Vector3();
const tmpCapsuleClosest = new Vector3();

/** Ray vs capsule (sphere at the axis point closest to the ray origin's projection). */
export function rayCapsuleHit(
  origin: Vector3,
  dir: Vector3,
  capA: Vector3,
  capB: Vector3,
  radius: number,
  maxDist: number,
  hit: EnemyRayHit
): boolean {
  tmpCapsuleAxis.copy(capB).sub(capA);
  tmpCapsuleToRay.copy(origin).sub(capA);
  const axisLenSq = tmpCapsuleAxis.dot(tmpCapsuleAxis);
  const axisDotDir = tmpCapsuleAxis.dot(dir);
  const axisDotOffset = tmpCapsuleAxis.dot(tmpCapsuleToRay);
  const dirDotOffset = dir.dot(tmpCapsuleToRay);
  const denom = axisLenSq - axisDotDir * axisDotDir;
  let along = denom > 1e-8 ? (axisDotOffset - axisDotDir * dirDotOffset) / denom : 0;
  along = along < 0 ? 0 : along > 1 ? 1 : along;
  tmpCapsuleClosest.copy(capA).addScaledVector(tmpCapsuleAxis, along);
  return raySphereHit(origin, dir, tmpCapsuleClosest, radius, maxDist, hit);
}
