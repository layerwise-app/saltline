/**
 * Entry point: boots every subsystem into the shared `Game` context (with
 * progress on the boot screen and stub fallbacks for optional subsystems),
 * handles the `?show=` debug showcases and the `#bench` benchmark mode, and
 * runs the per-frame main loop. Also installs the `window.__*` QA hooks.
 */
import { t } from './i18n';
import { createDetailSystem } from './render/detail';
import type { DetailSystem } from './render/detail';
import * as THREE from 'three';
import { PlaneGeometry, Vector2, Vector3 } from 'three';
import * as materialsModule from './materials/index';
import * as levelModule from './level/index';
import * as backdropModule from './backdrop/index';
import * as groundModule from './ground/index';
import * as fxModule from './fx/index';
import * as weaponModule from './weapon/index';
import * as handsModule from './weapon/api';
import * as enemiesModule from './enemies/index';
import * as propsModule from './props/registry';
import * as renderModule from './render/index';
import { PLAYER_BODY, resolveQuality } from './core/config';
import { createEventBus } from './core/events';
import { createRng } from './core/rng';
import { SUBSYSTEM_STUBS } from './core/stubs';
import type { CameraShot, Game, GameParams } from './core/types';
import { shadowedMesh } from './render/geometry';
import { createRenderSystem } from './render/index';
import { createMaterialLibrary } from './materials/index';
import { createCollisionWorld } from './world/physics';
import { createPropFactory } from './props/registry';
// Registers every prop builder (side effect only).
import './props/index';
import { createLevel } from './level/index';
import type { Level } from './level/index';
import { createBackdrop } from './backdrop/index';
import { createGround } from './ground/index';
import { createFx } from './fx/index';
import { createAudioEngine } from './audio/engine';
import { createInput } from './input/index';
import type { InputState } from './input/index';
import { createPlayer } from './player/index';
import type { Player } from './player/index';
import { createCombatResolver } from './session/combat';
import { createExplosives } from './world/explosives';
import { createWeapon } from './weapon/index';
import { createEnemies } from './enemies/index';
import { preloadGuardAsset } from './enemies/guardAsset';
import { createHud } from './ui/hud';
import { createGameFlow } from './session/flow';

/** A module that can render a debug showcase scene (`?show=<name>`). */
interface ShowcaseModule {
  showcase(game: Game): unknown;
}

/** What a showcase returns: optional camera placement and per-frame update. */
interface ShowcaseInfo {
  cam?: number[];
  target?: number[];
  update?(dt: number): void;
}

/** `Game` plus the benchmark driver installed by `#bench`. */
interface BootGame extends Game {
  bench?: { frame(dt: number): void };
}

/** Subsystems booted through `bootSubsystem` (with optional stub fallback). */
type BootedSubsystem =
  | 'render'
  | 'mats'
  | 'level'
  | 'backdrop'
  | 'ground'
  | 'fx'
  | 'audio'
  | 'weapon'
  | 'enemies'
  | 'hud';

/** Subsystems ticked by the main loop. */
type TickedSubsystem =
  | 'input'
  | 'player'
  | 'weapon'
  | 'enemies'
  | 'explosives'
  | 'fx'
  | 'ground'
  | 'level'
  | 'backdrop'
  | 'mats'
  | 'audio'
  | 'hud';

const MODULES: Record<string, ShowcaseModule | undefined> = {
  mats: materialsModule,
  level: levelModule,
  backdrop: backdropModule,
  ground: groundModule,
  fx: fxModule,
  weapon: weaponModule,
  hands: handsModule,
  enemies: enemiesModule,
  props: propsModule,
  render: renderModule
};
let bootEl: HTMLElement | null;
let bootMsgEl: HTMLElement | null;
let bootFillEl: HTMLElement | null;

/** The stack of an error, else the thrown value itself. */
const errorText = (err: unknown): unknown => (err && (err as Error).stack) || err;

function showFatalError(message: unknown): void {
  window.__fatal = String(message);
  console.error('[fatal] ' + message);
  let el = document.getElementById('fatal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal';
    document.getElementById('app')!.appendChild(el);
  }
  el.textContent = t('boot.fatal', { msg: String(message) });
}

/**
 * Creates the stub of subsystem `key`. Stubs only implement what the rest of
 * the game reads from a stubbed subsystem, not its full interface.
 */
function makeStub<K extends keyof typeof SUBSYSTEM_STUBS & keyof Game>(key: K): Game[K] {
  return SUBSYSTEM_STUBS[key]() as unknown as Game[K];
}

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setBootProgress(message: string, progress: number): Promise<void> {
  if (bootMsgEl) bootMsgEl.textContent = message;
  if (bootFillEl) bootFillEl.style.width = Math.round(progress * 100) + '%';
  await yieldToBrowser();
}

async function bootGame(): Promise<void> {
  const params: GameParams = Object.fromEntries(new URLSearchParams(location.search));
  const bench = !!params.bench || location.hash === '#bench';
  if (bench) {
    params.noaudio = '1';
    params.autostart = '1';
  }
  // Subsystems are filled in one by one below.
  const game = {
    THREE,
    params,
    events: createEventBus(),
    rng: createRng(+(params.seed || 4207)),
    time: {
      t: 0,
      dt: 0,
      frame: 0,
      real: 0
    },
    quality: resolveQuality(params.q || (params.shot ? 'test' : '')),
    // `?rain=0` forces clear weather (the menu setting applies otherwise).
    weather: { rain: params.rain !== undefined ? Math.min(1, Math.max(0, +params.rain || 0)) : 1 }
  } as BootGame;
  window.__G = game;
  const showcase = params.show && MODULES[params.show] ? params.show : null;
  game.showcase = showcase;

  /** Fixed debug camera set through `?cam=x,y,z,lx,ly,lz` / `__setShot`. */
  let camOverride: { pos: Vector3; look: Vector3 } | null = null;
  let detail: DetailSystem | null = null;
  function setShot(shot: CameraShot): void {
    if (shot.cam) {
      const values = String(shot.cam).split(',').map(Number);
      camOverride = {
        pos: new Vector3(values[0], values[1], values[2]),
        look: new Vector3(values[3] ?? 0, values[4] ?? 1, values[5] ?? 0)
      };
    }
    if (shot.cam === '') camOverride = null;
    if (shot.fov) {
      game.camera.fov = +shot.fov;
      game.camera.updateProjectionMatrix();
    }
    if (shot.exposure) game.render.exposure = +shot.exposure;
  }
  window.__setShot = setShot;

  /** Boots one subsystem; on failure installs its stub unless it is required. */
  async function bootSubsystem<K extends BootedSubsystem>(
    key: K,
    _label: string,
    factory: () => Game[K] | Promise<Game[K]>,
    required = false
  ): Promise<void> {
    const startedAt = performance.now();
    try {
      game[key] = await factory();
    } catch (err) {
      console.error(`[boot] module "${key}" failed: ${errorText(err)}`);
      const stub = (SUBSYSTEM_STUBS as Partial<Record<string, () => unknown>>)[key];
      if (required || !stub) throw err;
      // Stubs implement the subsystem's interface (see core/stubs.ts).
      game[key] = stub() as Game[K];
    }
    const elapsed = performance.now() - startedAt;
    if (elapsed > 150) console.log(`[boot] ${key} ${elapsed.toFixed(0)}ms`);
  }

  // Fetch the guard character in the background while the level builds.
  void preloadGuardAsset();
  await setBootProgress(t('boot.renderer'), 0.04);
  await bootSubsystem('render', 'render', () => createRenderSystem(game), true);
  game.renderer = game.render.renderer;
  game.scene = game.render.scene;
  game.camera = game.render.camera;
  game.viewCamera = game.render.viewCamera;
  await setBootProgress(t('boot.paint'), 0.12);
  await bootSubsystem('mats', 'materials', () => createMaterialLibrary(game));
  game.physics = createCollisionWorld(game);
  game.props = createPropFactory(game);
  game.input = showcase ? createStubInput() : createInput(game);
  if (showcase) {
    // Showcase mode: a bare floor and stubs for everything the showcase doesn't build.
    const floor = shadowedMesh(
      new PlaneGeometry(80, 80).rotateX(-Math.PI / 2),
      game.mats.get('concrete'),
      {
        cast: false
      }
    );
    game.scene.add(floor);
    game.level = {
      stub: true,
      playerStart: {
        pos: new Vector3(0, 0, 4),
        yaw: 0
      },
      objectives: [],
      enemySpawns: [],
      zones: [],
      interiorBoxes: [],
      cinematicPath: [],
      extraction: {
        pos: new Vector3(),
        radius: 2
      },
      groundSurfaceAt: () => 'concrete',
      update() {}
    } as unknown as Level; // placeholder: only the fields showcases and the loop read
    game.backdrop = makeStub('backdrop');
    game.ground = makeStub('ground');
    game.physics.build();
    if (showcase === 'fx') {
      await bootSubsystem('fx', 'fx', () => createFx(game));
    } else {
      try {
        game.fx = await createFx(game);
      } catch {
        game.fx = makeStub('fx');
      }
    }
    game.audio = SUBSYSTEM_STUBS.audio();
    game.hud = SUBSYSTEM_STUBS.hud();
    game.player = createStubPlayer(game);
    game.combat = createCombatResolver(game);
    game.weapon = makeStub('weapon');
    game.enemies = makeStub('enemies');
    game.game = {
      state: 'showcase',
      update: () => false,
      start() {}
    };
    let info: ShowcaseInfo | null = null;
    try {
      info = (await MODULES[showcase]!.showcase(game)) as ShowcaseInfo | null;
    } catch (err) {
      showFatalError(`showcase "${showcase}" threw: ${errorText(err)}`);
    }
    game.showcaseInfo = (info || {}) as Record<string, unknown>;
    if (info && info.cam) {
      setShot({
        cam: [...info.cam, ...(info.target || [0, 1, 0])].join(',')
      });
    }
  } else {
    await setBootProgress(t('boot.containers'), 0.34);
    await bootSubsystem('level', 'level', () => createLevel(game), true);
    await setBootProgress(t('boot.cranes'), 0.5);
    await bootSubsystem('backdrop', 'backdrop', () => createBackdrop(game));
    await setBootProgress(t('boot.apron'), 0.58);
    await bootSubsystem('ground', 'ground', () => createGround(game));
    if (game.ground.stub) {
      // No procedural ground: lay a plain asphalt plane instead.
      const floor = shadowedMesh(
        new PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
        game.mats.get('asphalt'),
        {
          cast: false
        }
      );
      game.scene.add(floor);
    }
    game.physics.build();
    await setBootProgress(t('boot.fx'), 0.66);
    await bootSubsystem('fx', 'fx', () => createFx(game));
    await bootSubsystem('audio', 'audio', () =>
      params.noaudio ? SUBSYSTEM_STUBS.audio() : createAudioEngine(game)
    );
    game.player = createPlayer(game);
    game.combat = createCombatResolver(game);
    try {
      game.explosives = createExplosives(game);
    } catch (err) {
      console.error('[boot] explosives failed: ' + errorText(err));
      game.explosives = {
        items: [],
        reset() {},
        update() {}
      };
    }
    await setBootProgress(t('boot.rifle'), 0.74);
    await bootSubsystem('weapon', 'weapon', () => createWeapon(game));
    await setBootProgress(t('boot.harbormaster'), 0.82);
    await bootSubsystem('enemies', 'enemies', () => createEnemies(game));
    await bootSubsystem('hud', 'hud', () => createHud(game));
    game.game = createGameFlow(game);
    try {
      // `?detail=0` keeps every object at full detail (for before/after comparisons).
      if (params.detail !== '0') detail = createDetailSystem(game);
    } catch (err) {
      console.error('[boot] detail failed: ' + errorText(err));
    }
  }
  await setBootProgress(t('boot.light'), 0.92);
  try {
    // Include the (hidden, pooled) guard character in the boot-time shader compile.
    const endPrewarm = game.enemies && game.enemies.prewarm ? game.enemies.prewarm() : null;
    try {
      await game.render.onLevelReady();
    } finally {
      if (endPrewarm) endPrewarm();
    }
  } catch (err) {
    console.error('[boot] render.onLevelReady failed: ' + errorText(err));
  }
  /** Smoothed frame time in seconds. */
  let avgFrameTime = 0;
  window.__stats = () => ({
    ...(game.render.stats ? game.render.stats() : {}),
    fps: avgFrameTime ? +(1 / avgFrameTime).toFixed(1) : 0,
    state: game.game && game.game.state,
    detail: detail ? detail.stats() : null
  });
  if (params.cam) setShot(params);
  if (params.fov) {
    setShot({
      fov: params.fov
    });
  }
  if (!showcase && (params.shot || params.autostart)) {
    try {
      game.game.start({
        skipIntro: true
      });
    } catch (err) {
      console.error('[boot] game.start failed', err);
    }
  }
  if (params.noweapon && game.weapon.setVisible) game.weapon.setVisible(false);
  if (bench) startBenchmark(game);
  await setBootProgress(t('boot.ready'), 1);
  bootEl!.classList.add('done');
  setTimeout(() => {
    bootEl!.hidden = true;
  }, 700);

  let lastFrameAt = performance.now();
  /** Viewmodel wetness: dries off indoors, gets wet again outside. */
  let wetness = 1;
  let viewFill = 1.1;
  const tmpDir = new Vector3();
  if (params.step) window.__step = 3;
  /** Subsystems whose update already threw (each is logged once). */
  const loopErrors: Record<string, number> = {};
  const tick = (key: TickedSubsystem, dt: number) => {
    const system = game[key] as { update?(dt: number): unknown } | undefined;
    if (system && system.update) {
      try {
        system.update(dt);
      } catch (err) {
        if (!loopErrors[key]) {
          loopErrors[key] = 1;
          console.error(`[loop] ${key}.update threw: ${errorText(err)}`);
        }
      }
    }
  };
  game.renderer.setAnimationLoop(() => {
    // `?step`: only advance while `window.__step` frames remain.
    if (params.step) {
      if (!(window.__step! > 0)) return;
      window.__step!--;
    }
    const now = performance.now();
    const frameTime = (now - lastFrameAt) / 1000;
    lastFrameAt = now;
    avgFrameTime = avgFrameTime ? avgFrameTime * 0.95 + frameTime * 0.05 : frameTime;
    let dt = Math.min(frameTime, 0.05);
    if (params.dt) dt = +params.dt;
    game.time.dt = dt;
    game.time.t += dt;
    game.time.real = now / 1000;
    game.time.frame++;
    tick('input', dt);
    let gameplayActive = false;
    try {
      gameplayActive =
        game.game.update(dt) !== false &&
        game.game.state !== 'title' &&
        game.game.state !== 'paused';
    } catch (err) {
      if (!loopErrors.game) {
        loopErrors.game = 1;
        console.error('[loop] game.update threw: ' + errorText(err));
      }
    }
    if (showcase) {
      const info = game.showcaseInfo as ShowcaseInfo;
      if (info.update) {
        try {
          info.update(dt);
        } catch (err) {
          if (!loopErrors.sc) {
            loopErrors.sc = 1;
            console.error('[loop] showcase update threw: ' + errorText(err));
          }
        }
      }
    } else if (gameplayActive) {
      tick('player', dt);
      tick('weapon', dt);
      tick('enemies', dt);
      tick('explosives', dt);
    }
    const weapon = game.weapon as typeof game.weapon & { setWetness?(wetness: number): void };
    if (
      weapon &&
      weapon.setWetness &&
      game.level &&
      game.level.interiorBoxes &&
      game.level.interiorBoxes[0]
    ) {
      const shed = game.level.interiorBoxes[0];
      const camPos = game.camera.position;
      const inside =
        camPos.x > shed.min.x &&
        camPos.x < shed.max.x &&
        camPos.z > shed.min.z &&
        camPos.z < shed.max.z &&
        camPos.y < shed.max.y;
      const rainLevel = (game.ground as { rainLevel?: number }).rainLevel;
      const rainy = typeof rainLevel === 'number' ? Math.min(1, rainLevel / 0.6) : game.weather.rain;
      wetness +=
        ((inside ? 0.3 : 1) * rainy - wetness) * Math.min(1, dt * (inside ? 0.25 : 0.6));
      try {
        weapon.setWetness(wetness);
      } catch {}
      // Outdoors, brighten the viewmodel fill when looking towards the sun.
      if (!params.wfill && game.render.sunDir) {
        const dir = game.camera.getWorldDirection(tmpDir);
        const facing = Math.max(0, dir.x * game.render.sunDir.x + dir.z * game.render.sunDir.z);
        viewFill +=
          ((inside ? 1.1 : 1.1 + 0.6 * facing * facing) - viewFill) * Math.min(1, dt * 2.5);
        game.render.viewFill = viewFill;
      }
    }
    if (game.game.state !== 'paused') {
      tick('fx', dt);
      tick('ground', dt);
      tick('level', dt);
      tick('backdrop', dt);
      tick('mats', dt);
    }
    tick('audio', dt);
    tick('hud', dt);
    if (camOverride) {
      game.camera.position.copy(camOverride.pos);
      game.camera.lookAt(camOverride.look);
    }
    if (game.bench) game.bench.frame(frameTime);
    if (detail) detail.update();
    try {
      game.render.frame(dt);
    } catch (err) {
      if (!loopErrors.render) {
        loopErrors.render = 1;
        console.error('[loop] render.frame threw: ' + errorText(err));
      }
    }
    if (game.input.endFrame) game.input.endFrame();
    window.__frames++;
    if (window.__frames === 2) window.__ready = true;
  });
}

/** `#bench`: flies the camera along the cinematic path and shows frame-time stats. */
function startBenchmark(game: BootGame): void {
  const panel = document.createElement('pre');
  panel.id = 'bench';
  panel.style.cssText =
    'position:absolute;left:12px;top:12px;z-index:90;margin:0;padding:10px 12px;font:12px/1.45 "IBM Plex Mono",ui-monospace,monospace;color:#d8f0d0;background:rgba(0,0,0,.72);white-space:pre-wrap;max-width:min(560px,90vw);pointer-events:none';
  document.getElementById('app')!.appendChild(panel);
  let gpu = 'unknown';
  try {
    const gl = game.renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = debugInfo
      ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
  } catch {}
  const path: { pos: ArrayLike<number>; look: ArrayLike<number> }[] =
    game.level.cinematicPath && game.level.cinematicPath.length >= 2
      ? game.level.cinematicPath
      : [
          {
            pos: [-32, 1.7, 6],
            look: [0, 2, 5]
          },
          {
            pos: [10, 1.7, 6],
            look: [30, 6, 0]
          }
        ];
  const frameTimesMs: number[] = [];
  let elapsed = 0;
  let lastReportAt = 0;
  const loopSeconds = 30;
  const fromPos = new Vector3();
  const toPos = new Vector3();
  const fromLook = new Vector3();
  const toLook = new Vector3();
  if (game.player) game.player.enabled = false;
  game.bench = {
    frame(dt) {
      elapsed += dt;
      const f = ((elapsed / loopSeconds) % 1) * (path.length - 1);
      const i = Math.min(path.length - 2, Math.floor(f));
      const u = f - i;
      const s = u * u * (3 - 2 * u);
      fromPos.fromArray(path[i].pos);
      toPos.fromArray(path[i + 1].pos);
      fromLook.fromArray(path[i].look);
      toLook.fromArray(path[i + 1].look);
      game.camera.position.lerpVectors(fromPos, toPos, s);
      game.camera.lookAt(fromLook.lerp(toLook, s));
      // Skip the first two seconds (shader warm-up).
      if (elapsed > 2) frameTimesMs.push(dt * 1000);
      if (frameTimesMs.length > 3000) frameTimesMs.shift();
      if (elapsed - lastReportAt > 1 && frameTimesMs.length > 10) {
        lastReportAt = elapsed;
        const sorted = frameTimesMs.slice().sort((a, b) => a - b);
        const avg = sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length;
        const p99 = sorted[Math.floor(sorted.length * 0.99)];
        const median = sorted[sorted.length >> 1];
        const stats = game.render.stats ? game.render.stats() : {};
        const size = game.renderer.getDrawingBufferSize(new Vector2());
        panel.textContent = `Saltline bench  t=${elapsed.toFixed(0)}s
GPU: ${gpu}
buffer ${size.x}x${size.y}  quality ${game.quality.name}  dpr ${window.devicePixelRatio}
frame ms avg ${avg.toFixed(1)}  median ${median.toFixed(1)}  p99 ${p99.toFixed(1)}  => ${(1000 / avg).toFixed(0)} fps
stats ${JSON.stringify(stats)}
errors ${window.__errors.length}${
          window.__errors.length
            ? `
 - ` +
              window.__errors.slice(0, 6).join(`
 - `)
            : ''
        }`;
      }
    }
  };
}

/** Inert input used by showcases. */
function createStubInput(): InputState {
  const noop = () => {};
  return {
    move: {
      x: 0,
      y: 0
    },
    look: {
      dx: 0,
      dy: 0
    },
    fire: false,
    ads: false,
    sprint: false,
    crouch: false,
    locked: false,
    touch: false,
    sensitivity: 1,
    down: () => false,
    pressed: () => false,
    update: noop,
    endFrame: noop,
    requestLock: noop,
    exitLock: noop
  };
}

/** Static, disabled player used by showcases. */
function createStubPlayer(_game: Game): Player {
  return {
    pos: new Vector3(0, 0, 4),
    vel: new Vector3(),
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
    eye: new Vector3(0, PLAYER_BODY.eye, 4),
    forward: new Vector3(0, 0, -1),
    enabled: false,
    reset() {},
    damage() {},
    heal() {},
    addRecoil() {},
    addShake() {},
    update() {}
  };
}

/** Boots the game into the #app / #view / #ui / #boot elements of the current document. */
export function startSaltline(): void {
  window.__frames = 0;
  window.__ready = false;
  window.__fatal = null;
  window.__errors = [];
  bootEl = document.getElementById('boot');
  bootMsgEl = document.getElementById('boot-msg');
  bootFillEl = document.getElementById('boot-fill');
  window.addEventListener('error', (event) => {
    window.__errors.push(String(event.message));
  });
  {
    // Mirror console errors into window.__errors for automated QA.
    const originalError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      try {
        window.__errors.push(
          args
            .map((arg) => (arg && (arg as Error).stack) || String(arg))
            .join(' ')
            .slice(0, 400)
        );
      } catch {}
      originalError(...args);
    };
  }
  bootGame().catch((err) => showFatalError(errorText(err)));
}
