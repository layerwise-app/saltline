/**
 * First-person player controller: look, walk / sprint / crouch / jump
 * movement on the collision world, head bob, recoil and camera shake, fall
 * damage, health regeneration and the hurt / low-health / ADS post-effect
 * parameters. Drives `game.camera` every frame.
 */
import { Euler, Vector3 } from 'three';
import { PLAYER_BODY, WORLD_BOUNDS } from '../core/config';
import { clamp, clamp01, damp, lerp, smoothstep } from '../core/math';
import type { Game } from '../core/types';

/** Movement / feel tuning (difficulty presets overwrite `regenDelay` and `regenRate`). */
const MOVE_TUNING = {
  walk: 3.8,
  sprint: 6.4,
  crouch: 1.9,
  ads: 2.4,
  accelGround: 34,
  decelGround: 26,
  accelAir: 9,
  gravity: 21,
  jumpApex: 1,
  coyote: 0.12,
  jumpBuffer: 0.13,
  standHeight: PLAYER_BODY.height,
  crouchHeight: 1.15,
  eyeRate: 11,
  stride: {
    walk: 1.55,
    sprint: 2.1,
    crouch: 1.05
  },
  bobY: 0.024,
  bobX: 0.013,
  bobSprint: 1.9,
  bobAds: 0.22,
  rollStrafe: 0.02,
  landDip: 0.36,
  landDipMax: 0.2,
  fovSprint: 6,
  fovAds: 52,
  adsLook: 0.6,
  regenDelay: 4,
  regenRate: 25,
  recoilKeep: 0.35,
  recoilApply: 34,
  recoilRecover: 6.5,
  recoilHold: 0.09,
  shakeDecay: 1.7,
  shakePitch: 0.03,
  shakeYaw: 0.03,
  shakeRoll: 0.045,
  pitchLimit: 1.5
};
const JUMP_VELOCITY = Math.sqrt(2 * MOVE_TUNING.gravity * MOVE_TUNING.jumpApex);

/** The player movement tuning table. */
export type PlayerTuning = typeof MOVE_TUNING;

/** Where (and facing which way) the player spawns. */
export interface PlayerSpawn {
  pos: Vector3;
  yaw?: number;
}

/**
 * The player as stored on `game.player`. Optional members are absent on the
 * showcase stub player created by `main.ts`.
 */
export interface Player {
  /** Feet position. */
  pos: Vector3;
  /** Camera (eye) position, including bob / landing dip. */
  eye: Vector3;
  vel: Vector3;
  /** Unit view direction (including recoil offset). */
  forward: Vector3;
  yaw: number;
  pitch: number;
  health: number;
  maxHealth: number;
  alive: boolean;
  onGround: boolean;
  sprinting: boolean;
  crouching: boolean;
  /** Aim-down-sights blend, 0..1. */
  ads: number;
  /** Horizontal speed (m/s). */
  speed: number;
  /** When false, input is ignored (menus, cinematics, benchmark). */
  enabled: boolean;
  invulnerable?: boolean;
  baseFov?: number;
  hurtPulse?: number;
  lookScale?: number;
  /** Last safe ground position, used to rescue the player from the sea. */
  lastSafe?: Vector3;
  tuning?: PlayerTuning;
  reset(spawn?: PlayerSpawn | null): void;
  damage(amount: number, fromPos?: Vector3 | null): void;
  heal(amount: number): void;
  addRecoil(pitch?: number, yaw?: number): void;
  addShake(amount?: number): void;
  setFov?(fov: number | string): void;
  update(dt: number): void;
}

/** Post-processing parameters the player writes every frame. */
interface PlayerPostParams {
  damage?: number;
  lowHealth?: number;
  ads?: number;
}

/** Weapon fields the player reads to follow the weapon's ADS blend. */
interface WeaponAdsView {
  stub?: boolean;
  ads?: unknown;
}

/** Payload of the `explosion` event, as far as the player cares. */
interface ExplosionEvent {
  pos?: Vector3;
  size?: number;
}

/** Creates the player controller and hooks it to `game.camera`. */
export function createPlayer(game: Game): Player {
  const camera = game.camera;
  const fallbackPost: PlayerPostParams = {};
  const postParams = (): PlayerPostParams => (game.render && game.render.post) || fallbackPost;
  let eyeHeight: number = PLAYER_BODY.eye;
  let bodyHeight: number = MOVE_TUNING.standHeight;
  let coyoteTimer = 0;
  let jumpBufferTimer = 0;
  let wasOnGround = true;
  let airTime = 0;
  let maxFallSpeed = 0;
  let stridePhase = 0;
  let bobAmount = 0;
  let bobX = 0;
  let bobY = 0;
  let strafeRoll = 0;
  const landDip = {
    x: 0,
    v: 0
  };
  let recoilPitchTarget = 0;
  let recoilYawTarget = 0;
  let recoilPitch = 0;
  let recoilYaw = 0;
  let recoilHoldTimer = 0;
  let shake = 0;
  let shakeTime = 0;
  let sinceHurt = 99;
  let hurtPulse = 0;
  let lowHealth = 0;
  let deadTime = 0;
  let currentFov: number = PLAYER_BODY.fov;
  let fallbackAds = 0;
  let lastSurface = 'concrete';
  const wishVel = new Vector3();
  const viewEuler = new Euler(0, 0, 0, 'YXZ');
  const lastSafe = new Vector3();
  const player: Required<Player> = {
    pos: new Vector3(),
    eye: new Vector3(),
    vel: new Vector3(),
    forward: new Vector3(0, 0, -1),
    yaw: 0,
    pitch: 0,
    health: 100,
    maxHealth: 100,
    alive: true,
    onGround: true,
    sprinting: false,
    crouching: false,
    ads: 0,
    speed: 0,
    enabled: true,
    invulnerable: false,
    baseFov: PLAYER_BODY.fov,
    hurtPulse: 0,
    lookScale: 1,
    lastSafe,
    tuning: MOVE_TUNING,
    reset(spawn) {
      const start = spawn ||
        (game.level && game.level.playerStart) || {
          pos: new Vector3(),
          yaw: 0
        };
      player.pos.copy(start.pos);
      player.yaw = start.yaw || 0;
      player.pitch = 0;
      player.vel.set(0, 0, 0);
      player.health = player.maxHealth;
      player.alive = true;
      player.onGround = true;
      player.sprinting = false;
      player.crouching = false;
      player.invulnerable = false;
      player.speed = 0;
      eyeHeight = PLAYER_BODY.eye;
      bodyHeight = MOVE_TUNING.standHeight;
      coyoteTimer = 0;
      jumpBufferTimer = 0;
      wasOnGround = true;
      airTime = 0;
      maxFallSpeed = 0;
      stridePhase = 0;
      bobAmount = 0;
      bobX = bobY = 0;
      strafeRoll = 0;
      landDip.x = landDip.v = 0;
      recoilPitchTarget = recoilYawTarget = recoilPitch = recoilYaw = 0;
      recoilHoldTimer = 0;
      shake = 0;
      sinceHurt = 99;
      hurtPulse = 0;
      lowHealth = 0;
      deadTime = 0;
      player.hurtPulse = 0;
      lastSafe.copy(player.pos);
      const post = postParams();
      post.damage = 0;
      post.lowHealth = 0;
      post.ads = 0;
      updateCamera(0);
    },
    damage(amount, fromPos) {
      if (!player.alive || player.invulnerable || !(amount > 0)) return;
      player.health = Math.max(0, player.health - amount);
      sinceHurt = 0;
      hurtPulse = Math.min(1, hurtPulse + 0.35 + amount / 40);
      player.addShake(0.22 + amount / 70);
      game.events.emit('player:hit', {
        amount,
        fromPos
      });
      if (player.health <= 0) {
        player.alive = false;
        deadTime = 0;
        player.sprinting = false;
        game.events.emit('player:dead', {});
      }
    },
    heal(amount) {
      if (player.alive) player.health = Math.min(player.maxHealth, player.health + amount);
    },
    addRecoil(pitch = 0, yaw = 0) {
      const keep = MOVE_TUNING.recoilKeep;
      player.pitch = clamp(
        player.pitch + pitch * keep,
        -MOVE_TUNING.pitchLimit,
        MOVE_TUNING.pitchLimit
      );
      player.yaw += yaw * keep;
      recoilPitchTarget += pitch * (1 - keep);
      recoilYawTarget += yaw * (1 - keep);
      recoilPitchTarget = clamp(recoilPitchTarget, -0.3, 0.3);
      recoilYawTarget = clamp(recoilYawTarget, -0.2, 0.2);
      recoilHoldTimer = MOVE_TUNING.recoilHold;
    },
    addShake(amount = 0.3) {
      shake = Math.min(1, shake + amount);
    },
    setFov(fov) {
      player.baseFov = clamp(+fov || PLAYER_BODY.fov, 55, 100);
    },
    update
  };
  game.events.on('explosion', (event: ExplosionEvent | null) => {
    if (!event || !event.pos) return;
    const dist = player.eye.distanceTo(event.pos);
    const size = event.size || 1;
    const amount = clamp01(1 - dist / (14 + size * 10)) * (0.35 + 0.35 * size);
    if (amount > 0.01) player.addShake(amount);
  });

  /** True when there is head room to stand up at the current position. */
  function canStand(): boolean {
    const boxes = game.physics && game.physics.boxes;
    if (!boxes) return true;
    const radius = PLAYER_BODY.radius * 0.9;
    const bottom = player.pos.y + MOVE_TUNING.crouchHeight - 0.05;
    const top = player.pos.y + MOVE_TUNING.standHeight;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (
        !box.bulletOnly &&
        !(
          player.pos.x + radius < box.min.x ||
          player.pos.x - radius > box.max.x ||
          player.pos.z + radius < box.min.z ||
          player.pos.z - radius > box.max.z
        ) &&
        box.min.y < top &&
        box.max.y > bottom
      )
        return false;
    }
    return true;
  }

  /** Surface name under the player's feet (for footstep / landing sounds). */
  function footSurface(): string {
    const x = player.pos.x;
    const z = player.pos.z;
    try {
      if (game.ground && game.ground.isPuddle && player.pos.y < 0.05 && game.ground.isPuddle(x, z))
        return 'water';
    } catch {}
    if (lastSurface && lastSurface !== 'concrete') return lastSurface;
    try {
      return (
        (game.level && game.level.groundSurfaceAt && game.level.groundSurfaceAt(x, z)) ||
        lastSurface ||
        'concrete'
      );
    } catch {
      return lastSurface || 'concrete';
    }
  }

  function update(dt: number): void {
    const input = game.input;
    const weapon: WeaponAdsView = game.weapon || {};
    if (weapon.stub || typeof weapon.ads != 'number') {
      fallbackAds = damp(fallbackAds, player.enabled && input.ads ? 1 : 0, 14, dt);
      player.ads = fallbackAds;
    } else {
      player.ads = clamp01(weapon.ads);
    }
    if (!player.alive) {
      deadTime += dt;
      updateDead(dt);
      updateCamera(dt);
      updatePost(dt);
      return;
    }
    const enabled = player.enabled;
    player.lookScale = lerp(1, MOVE_TUNING.adsLook, player.ads);
    if (enabled) {
      player.yaw -= input.look.dx * player.lookScale;
      player.pitch = clamp(
        player.pitch - input.look.dy * player.lookScale,
        -MOVE_TUNING.pitchLimit,
        MOVE_TUNING.pitchLimit
      );
      if (player.yaw > Math.PI * 4 || player.yaw < -Math.PI * 4) {
        player.yaw = player.yaw % (Math.PI * 2);
      }
    }
    if (enabled && input.crouch) player.crouching = true;
    else if (player.crouching && canStand()) player.crouching = false;
    bodyHeight = player.crouching ? MOVE_TUNING.crouchHeight : MOVE_TUNING.standHeight;
    const moveX = enabled ? input.move.x : 0;
    const moveY = enabled ? input.move.y : 0;
    const hasMoveInput = moveX * moveX + moveY * moveY > 0.01;
    const wantsSprint =
      enabled &&
      input.sprint &&
      moveY > 0.55 &&
      Math.abs(moveX) < 0.6 &&
      !player.crouching &&
      player.ads < 0.35 &&
      !input.fire;
    player.sprinting =
      (wantsSprint && player.onGround && player.speed > MOVE_TUNING.walk * 0.6) ||
      (wantsSprint && !player.onGround && player.sprinting);
    let targetSpeed = MOVE_TUNING.walk;
    if (player.crouching) targetSpeed = MOVE_TUNING.crouch;
    else if (wantsSprint) targetSpeed = MOVE_TUNING.sprint;
    targetSpeed = lerp(targetSpeed, Math.min(targetSpeed, MOVE_TUNING.ads), player.ads);
    if (moveY < 0) targetSpeed *= lerp(1, 0.82, -moveY);
    const sinYaw = Math.sin(player.yaw);
    const cosYaw = Math.cos(player.yaw);
    wishVel
      .set(moveX * cosYaw - moveY * sinYaw, 0, -moveX * sinYaw - moveY * cosYaw)
      .multiplyScalar(targetSpeed);
    const accel = player.onGround
      ? hasMoveInput
        ? MOVE_TUNING.accelGround
        : MOVE_TUNING.decelGround
      : hasMoveInput
        ? MOVE_TUNING.accelAir
        : 0.6;
    let deltaX = wishVel.x - player.vel.x;
    let deltaZ = wishVel.z - player.vel.z;
    if (!player.onGround && !hasMoveInput) {
      deltaX = -player.vel.x;
      deltaZ = -player.vel.z;
    }
    const deltaLen = Math.hypot(deltaX, deltaZ);
    const maxStep = accel * dt;
    if (deltaLen <= maxStep || deltaLen < 1e-6) {
      if (player.onGround || hasMoveInput) {
        player.vel.x = wishVel.x;
        player.vel.z = wishVel.z;
      }
    } else {
      player.vel.x += (deltaX / deltaLen) * maxStep;
      player.vel.z += (deltaZ / deltaLen) * maxStep;
    }
    coyoteTimer = player.onGround ? MOVE_TUNING.coyote : Math.max(0, coyoteTimer - dt);
    jumpBufferTimer =
      enabled && input.pressed('jump') ? MOVE_TUNING.jumpBuffer : Math.max(0, jumpBufferTimer - dt);
    if (jumpBufferTimer > 0 && coyoteTimer > 0 && (!player.crouching || canStand())) {
      player.vel.y = JUMP_VELOCITY;
      jumpBufferTimer = 0;
      coyoteTimer = 0;
      player.onGround = false;
      player.crouching = false;
      bodyHeight = MOVE_TUNING.standHeight;
      game.events.emit('player:jump', {
        pos: player.pos
      });
    }
    player.vel.y -= MOVE_TUNING.gravity * dt * 0.5;
    if (player.vel.y < -40) player.vel.y = -40;
    const preMoveVelY = player.vel.y;
    const moveResult: { onGround?: boolean; surface?: string } =
      game.physics.moveCapsule(
        player.pos,
        player.vel,
        dt,
        PLAYER_BODY.radius,
        bodyHeight,
        wasOnGround
      ) || {};
    if (!moveResult.onGround) player.vel.y -= MOVE_TUNING.gravity * dt * 0.5;
    const bounds = game.physics.bounds;
    if (bounds) {
      player.pos.x = clamp(player.pos.x, bounds.min.x + 0.4, bounds.max.x - 0.4);
      player.pos.z = clamp(player.pos.z, bounds.min.z + 0.4, bounds.max.z - 0.4);
    }
    player.onGround = !!moveResult.onGround;
    if (moveResult.surface) lastSurface = moveResult.surface;
    if (player.onGround) {
      if (!wasOnGround && airTime > 0.12) {
        const impactSpeed = Math.max(0, -preMoveVelY, maxFallSpeed);
        landDip.v -= Math.min(impactSpeed * MOVE_TUNING.landDip, 3.2);
        if (impactSpeed > 7.5) player.addShake(Math.min(0.5, (impactSpeed - 7.5) * 0.06));
        game.events.emit('player:land', {
          speed: impactSpeed,
          surface: footSurface(),
          pos: player.pos
        });
        if (impactSpeed > 13) player.damage((impactSpeed - 13) * 7, null);
        stridePhase = 0.35;
      }
      airTime = 0;
      maxFallSpeed = 0;
      if (player.pos.x <= WORLD_BOUNDS.quayX - 1.2 && player.pos.y > -0.5) {
        lastSafe.copy(player.pos);
      }
    } else {
      airTime += dt;
      maxFallSpeed = Math.max(maxFallSpeed, -player.vel.y);
    }
    wasOnGround = player.onGround;
    if (player.pos.y < WORLD_BOUNDS.seaY - 2.2) {
      player.pos.copy(lastSafe);
      player.vel.set(0, 0, 0);
      player.onGround = true;
      wasOnGround = true;
      shake = 0.6;
      player.yaw += Math.PI;
      player.damage(12, null);
      game.events.emit('player:rescued', {});
    }
    player.speed = Math.hypot(player.vel.x, player.vel.z);
    const strideLength = player.crouching
      ? MOVE_TUNING.stride.crouch
      : player.sprinting
        ? MOVE_TUNING.stride.sprint
        : MOVE_TUNING.stride.walk;
    if (player.onGround && player.speed > 0.5) {
      const prevPhase = stridePhase;
      stridePhase += (player.speed * dt) / strideLength;
      if (Math.floor(stridePhase) > Math.floor(prevPhase)) {
        game.events.emit('player:step', {
          surface: footSurface(),
          sprint: player.sprinting,
          pos: player.pos
        });
      }
    } else if (player.onGround) {
      stridePhase = damp(stridePhase, Math.round(stridePhase), 8, dt);
    }
    const targetBob = player.onGround
      ? clamp01(player.speed / MOVE_TUNING.walk) *
        (player.sprinting ? MOVE_TUNING.bobSprint : 1) *
        lerp(1, MOVE_TUNING.bobAds, player.ads) *
        (player.crouching ? 0.7 : 1)
      : 0;
    bobAmount = damp(bobAmount, targetBob, 9, dt);
    bobY = -Math.cos(stridePhase * Math.PI * 2) * MOVE_TUNING.bobY * bobAmount;
    bobX = Math.sin(stridePhase * Math.PI) * MOVE_TUNING.bobX * bobAmount;
    const strafeSpeed = player.vel.x * cosYaw - player.vel.z * sinYaw;
    strafeRoll = damp(
      strafeRoll,
      (-strafeSpeed / MOVE_TUNING.sprint) * MOVE_TUNING.rollStrafe * lerp(1, 0.4, player.ads),
      8,
      dt
    );
    sinceHurt += dt;
    if (sinceHurt > MOVE_TUNING.regenDelay && player.health < player.maxHealth) {
      player.health = Math.min(player.maxHealth, player.health + MOVE_TUNING.regenRate * dt);
    }
    updateCamera(dt);
    updatePost(dt);
  }

  /** Lets the body settle after death. */
  function updateDead(dt: number): void {
    player.vel.x = damp(player.vel.x, 0, 5, dt);
    player.vel.z = damp(player.vel.z, 0, 5, dt);
    player.vel.y -= MOVE_TUNING.gravity * dt;
    try {
      const result = game.physics.moveCapsule(
        player.pos,
        player.vel,
        dt,
        PLAYER_BODY.radius,
        0.6,
        wasOnGround
      );
      wasOnGround = !!(result && result.onGround);
    } catch {}
    if (player.pos.y < WORLD_BOUNDS.seaY - 1) {
      player.pos.y = WORLD_BOUNDS.seaY - 1;
      player.vel.y = 0;
    }
    player.speed = 0;
    player.sprinting = false;
    bobAmount = damp(bobAmount, 0, 10, dt);
    bobX *= 0.9;
    bobY *= 0.9;
  }

  /** Places the camera: eye height, bob, landing dip, recoil, shake, death fall and FOV. */
  function updateCamera(dt: number): void {
    let targetEye: number = player.crouching ? PLAYER_BODY.crouchEye : PLAYER_BODY.eye;
    let deathRoll = 0;
    let deathPitch = 0;
    if (player.alive) {
      if (dt > 0) eyeHeight = damp(eyeHeight, targetEye, MOVE_TUNING.eyeRate, dt);
      else eyeHeight = targetEye;
    } else {
      const fall = smoothstep(0, 0.85, deadTime);
      const fallSq = fall * fall;
      targetEye = lerp(PLAYER_BODY.eye, 0.22, fallSq);
      eyeHeight = damp(eyeHeight, targetEye, 18, dt);
      deathRoll = 1.15 * fallSq;
      deathPitch = -0.25 * fall + 0.12 * Math.sin(fall * Math.PI);
    }
    if (dt > 0) {
      const springForce = -landDip.x * 150 - landDip.v * 17;
      landDip.v += springForce * dt;
      landDip.x += landDip.v * dt;
      landDip.x = clamp(landDip.x, -MOVE_TUNING.landDipMax, 0.05);
      recoilHoldTimer -= dt;
      if (recoilHoldTimer <= 0) {
        recoilPitchTarget = damp(recoilPitchTarget, 0, MOVE_TUNING.recoilRecover, dt);
        recoilYawTarget = damp(recoilYawTarget, 0, MOVE_TUNING.recoilRecover, dt);
      }
      recoilPitch = damp(recoilPitch, recoilPitchTarget, MOVE_TUNING.recoilApply, dt);
      recoilYaw = damp(recoilYaw, recoilYawTarget, MOVE_TUNING.recoilApply, dt);
      shake = Math.max(0, shake - MOVE_TUNING.shakeDecay * dt);
      shakeTime += dt;
    }
    const sinYaw = Math.sin(player.yaw);
    const cosYaw = Math.cos(player.yaw);
    player.eye.set(
      player.pos.x + bobX * cosYaw,
      player.pos.y + eyeHeight + bobY + landDip.x,
      player.pos.z - bobX * sinYaw
    );
    const viewPitch = clamp(player.pitch + recoilPitch, -1.55, 1.55);
    const viewYaw = player.yaw + recoilYaw;
    viewEuler.set(viewPitch, viewYaw, 0, 'YXZ');
    player.forward.set(0, 0, -1).applyEuler(viewEuler);
    const shakeSq = shake * shake;
    const t = shakeTime;
    const shakePitch =
      shakeSq * MOVE_TUNING.shakePitch * (Math.sin(t * 43.1) + 0.6 * Math.sin(t * 71.7 + 1.3));
    const shakeYaw =
      shakeSq * MOVE_TUNING.shakeYaw * (Math.sin(t * 37.3 + 2.1) + 0.6 * Math.sin(t * 83.9));
    const shakeRoll =
      shakeSq * MOVE_TUNING.shakeRoll * (Math.sin(t * 29.7 + 0.7) + 0.5 * Math.sin(t * 61.3 + 4));
    camera.position.copy(player.eye);
    camera.rotation.set(
      viewPitch + shakePitch + deathPitch + landDip.x * 0.12,
      viewYaw + shakeYaw,
      strafeRoll + shakeRoll + deathRoll + bobX * 0.35,
      'YXZ'
    );
    if (!game.params || !game.params.fov) {
      const targetFov = lerp(
        player.baseFov + (player.sprinting ? MOVE_TUNING.fovSprint : 0),
        MOVE_TUNING.fovAds,
        player.ads
      );
      currentFov =
        dt > 0
          ? damp(currentFov, targetFov, player.ads > 0.02 && player.ads < 0.98 ? 30 : 7, dt)
          : targetFov;
      if (Math.abs(camera.fov - currentFov) > 0.01) {
        camera.fov = currentFov;
        camera.updateProjectionMatrix();
      }
    }
  }

  /** Feeds hurt flash, low-health vignette and ADS blend to the post chain. */
  function updatePost(dt: number): void {
    hurtPulse = Math.max(0, hurtPulse - dt * 1.9);
    player.hurtPulse = hurtPulse;
    const target = player.alive ? smoothstep(0.55, 0.12, player.health / player.maxHealth) : 1;
    lowHealth = damp(lowHealth, target, 4, dt);
    const post = postParams();
    post.damage = hurtPulse;
    post.lowHealth = lowHealth;
    post.ads = player.ads;
  }
  return player;
}
