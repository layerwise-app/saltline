/**
 * The render system: WebGL renderer, scene, world + viewmodel cameras, the sun and
 * its soft shadows, sky and environment lighting, a pool of transient point lights,
 * the HDR post chain (with a plain forward fallback), dynamic resolution and an
 * interior reflection probe. Also builds the `?show=render` debug showcase.
 */
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Camera,
  Color,
  ColorRepresentation,
  CubeCamera,
  DepthTexture,
  DirectionalLight,
  Group,
  HalfFloatType,
  LinearFilter,
  Material,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  NoToneMapping,
  Object3D,
  PCFShadowMap,
  PCFSoftShadowMap,
  PMREMGenerator,
  PerspectiveCamera,
  PointLight,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  Texture,
  UnsignedIntType,
  Vector2,
  Vector3,
  WebGLCubeRenderTarget,
  WebGLRenderTarget,
  WebGLRenderer
} from 'three';
import type { Game } from '../core/types';
import type { QualityName, QualityPreset } from '../core/config';
import { PLAYER_BODY, QUALITY_PRESETS, SUN, VIEWMODEL_LAYER, WORLD_LAYER } from '../core/config';
import { roundedBox, shadowedMesh, worldUvBox } from './geometry';
import { createNoiseTexture } from './noise';
import { bakeSkyEnvironment, createSkyDome } from './sky';
import {
  SOFT_SHADOW_TAG,
  fitSunShadowFrustum,
  installSoftShadows,
  restoreStockShadows
} from './shadows';
import type { AdaptReadout, PostEffectState, PostPipeline, PostTune } from './post';
import { POST_SHADER_TAG, createPostPipeline } from './post';

/** Environment intensity of the baked sky outdoors. */
const SKY_ENV_INTENSITY = 2;
/** Environment intensity used with the interior probe. */
const INTERIOR_ENV_INTENSITY = 1;

/** A light borrowed from the pool until `release()` is called. */
export interface LeasedLight {
  light: PointLight;
  release(): void;
}

/** Fixed pool of point lights used for muzzle flashes, explosions and the like. */
export interface LightPool {
  /** Short flash at `position` that fades out linearly over `duration` seconds. */
  flash(
    position: Vector3,
    color?: ColorRepresentation,
    intensity?: number,
    distance?: number,
    duration?: number
  ): void;
  /** Takes a light out of the pool for persistent use, or null if none is free. */
  acquire(): LeasedLight | null;
  update(dt: number): void;
}

/** Callback run every frame before the scene is rendered (e.g. planar reflections). */
export type PrePass = (renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera) => void;

/** Per-frame renderer statistics (debug overlay / benchmarks). */
export interface RenderStats {
  calls: number;
  tris: number;
  geos: number;
  tex: number;
  programs: number;
  res: number[];
  scale: number;
  advanced: boolean;
  softShadows: boolean;
  adapt: AdaptReadout | null | undefined;
}

/** The render subsystem (`game.render`). */
export interface RenderSystem {
  renderer: WebGLRenderer;
  scene: Scene;
  /** World camera (layer WORLD_LAYER), driven by the player. */
  camera: PerspectiveCamera;
  /** Viewmodel camera; follows `camera` with its own FOV and near plane. */
  viewCamera: PerspectiveCamera;
  sun: DirectionalLight;
  sky: Mesh;
  sunDir: Vector3;
  lightPool: LightPool;
  /** Gameplay-driven screen effects read by the post chain. */
  post: PostEffectState;
  exposure: number;
  /** Baked sky environment texture. */
  env: Texture | null;
  /** Interior reflection probe, once captured. */
  interiorEnv: Texture | null;
  /** Current internal render resolution in pixels. */
  resolution: Vector2;
  depthTextureIsLive: boolean;
  tune: Partial<PostTune>;
  /** Viewmodel key-light intensity (set by gameplay; default 0.9). */
  viewKey?: number;
  /** Viewmodel environment fill multiplier (set by gameplay; default 1.1). */
  viewFill?: number;
  /** Whether the HDR post chain is active (false = forward fallback). */
  readonly advanced: boolean;
  autoExposure: boolean;
  /** Scene depth copy for soft particles etc.; requesting it enables the per-frame copy. */
  readonly depthTexture: DepthTexture | null;
  addPrePass(prePass: PrePass): void;
  /** Renders the world (no viewmodel, no tone mapping) from `camera` into `target`. */
  renderWorld(camera: Camera, target: WebGLRenderTarget | null): void;
  /** Captures the interior probe and precompiles shaders once the level is built. */
  onLevelReady(): Promise<void>;
  setQuality(quality: QualityPreset): void;
  resize(): void;
  frame(dt: number): void;
  stats(): RenderStats;
  /** Re-captures the interior reflection probe (assigned after creation). */
  captureInteriorProbe?: () => void;
}

/** Book-keeping stored in each pooled light's `userData`. */
interface PooledLightState {
  busy: boolean;
  ttl: number;
  dur: number;
  peak: number;
  persistent: boolean;
}

/** Dynamic-resolution controller state. */
interface DynamicResolution {
  scale: number;
  enabled: boolean;
  /** Accumulated frame time (ms) and frame count of the current measuring window. */
  acc: number;
  n: number;
  /** Seconds to wait before measuring again. */
  settle: number;
  /** Seconds until the scale may go up again. */
  upWait: number;
  upDelay: number;
  /** Consecutive slow windows at the minimum scale. */
  floorHits?: number;
}

interface InteriorProbe {
  cubeRT: WebGLCubeRenderTarget;
  cam: CubeCamera;
  pmrem: PMREMGenerator;
  out: WebGLRenderTarget | null;
}

const errorText = (error: unknown) => (error && (error as Error).stack) || error;

/** Creates the renderer on the `#view` canvas and everything the frame needs. */
export async function createRenderSystem(game: Game): Promise<RenderSystem> {
  const params = game.params || {};
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    alpha: false,
    depth: true,
    stencil: false
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;
  renderer.info.autoReset = false;
  renderer.setClearColor(0, 1);
  const gl = renderer.getContext();
  /** Which of our custom shaders failed to compile. */
  const shaderFailures = {
    post: false,
    shadow: false,
    sky: false,
    other: 0
  };
  renderer.debug.onShaderError = (glContext, program, vertexShader, fragmentShader) => {
    let source = '';
    let log = '';
    try {
      source = glContext.getShaderSource(fragmentShader) || '';
      log =
        (glContext.getShaderInfoLog(fragmentShader) || '') +
        ' ' +
        (glContext.getShaderInfoLog(vertexShader) || '') +
        ' ' +
        (glContext.getProgramInfoLog(program) || '');
    } catch {}
    let culprit = 'material';
    if (source.includes(POST_SHADER_TAG)) {
      shaderFailures.post = true;
      culprit = 'post pass ' + (source.match(/SALTLINE_POST (\S+)/) || [])[1];
    } else if (source.includes('SALTLINE_SKY')) {
      shaderFailures.sky = true;
      culprit = 'sky';
    } else if (source.includes(SOFT_SHADOW_TAG)) {
      shaderFailures.shadow = true;
      culprit = 'material (soft shadow chunk active)';
    } else shaderFailures.other++;
    console.error(`[render] shader error in ${culprit}: ${log.trim().slice(0, 700)}`);
  };
  const scene = new Scene();
  const camera = new PerspectiveCamera(PLAYER_BODY.fov, 16 / 9, 0.08, 900);
  camera.layers.set(WORLD_LAYER);
  camera.rotation.order = 'YXZ';
  scene.add(camera);
  const viewCamera = new PerspectiveCamera(PLAYER_BODY.viewFov, 16 / 9, 0.01, 10);
  viewCamera.layers.set(VIEWMODEL_LAYER);
  const noiseTex = createNoiseTexture();
  const sky = createSkyDome(noiseTex);
  scene.add(sky.mesh);
  const sun = new DirectionalLight(SUN.color, SUN.intensity);
  sun.name = 'sun';
  sun.castShadow = true;
  const shadowFrustum = fitSunShadowFrustum(
    sun,
    new Vector3(-41, -0.2, -33),
    new Vector3(37, 32, 31),
    new Vector3(-41, -3, -64),
    new Vector3(72, 36, 34)
  );
  const shadowMapSize = () =>
    Math.min(game.quality.shadow || 2048, renderer.capabilities.maxTextureSize);
  sun.shadow.mapSize.set(shadowMapSize(), shadowMapSize());
  sun.shadow.bias = -12e-5;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 1;
  sun.shadow.autoUpdate = true;
  scene.add(sun, sun.target);
  sun.layers.enable(VIEWMODEL_LAYER);
  let softShadows = false;
  try {
    softShadows = installSoftShadows(shadowFrustum, {
      taps: game.quality.name === 'low' ? 10 : 16,
      searchTaps: 8
    });
  } catch (error) {
    console.warn('[render] soft shadows unavailable: ' + error);
  }

  // ---- transient light pool ----
  const LIGHT_POOL_SIZE = 6;
  const pooledLights: PointLight[] = [];
  const lightState = (light: PointLight) => light.userData as PooledLightState;
  for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
    const light = new PointLight(0xffffff, 0, 12, 2);
    const state: PooledLightState = {
      busy: false,
      ttl: 0,
      dur: 0,
      peak: 0,
      persistent: false
    };
    light.userData = state;
    light.layers.enable(VIEWMODEL_LAYER);
    scene.add(light);
    pooledLights.push(light);
  }
  const lightPool: LightPool = {
    flash(position, color = 0xffc880, intensity = 30, distance = 10, duration = 0.06) {
      // a free light, else steal the non-persistent one closest to finishing
      const light =
        pooledLights.find((candidate) => !lightState(candidate).busy) ||
        pooledLights
          .filter((candidate) => !lightState(candidate).persistent)
          .sort((a, b) => lightState(a).ttl - lightState(b).ttl)[0];
      if (light) {
        light.position.copy(position);
        light.color.set(color);
        light.distance = distance;
        light.intensity = intensity;
        Object.assign(light.userData, {
          busy: true,
          ttl: duration,
          dur: duration,
          peak: intensity,
          persistent: false
        });
      }
    },
    acquire() {
      const light = pooledLights.find((candidate) => !lightState(candidate).busy);
      if (!light) return null;
      lightState(light).busy = true;
      lightState(light).persistent = true;
      light.intensity = 0;
      return {
        light,
        release() {
          lightState(light).busy = false;
          lightState(light).persistent = false;
          light.intensity = 0;
        }
      };
    },
    update(dt) {
      for (const light of pooledLights) {
        const state = lightState(light);
        if (state.busy && !state.persistent) {
          state.ttl -= dt;
          if (state.ttl <= 0) {
            state.busy = false;
            light.intensity = 0;
          } else light.intensity = state.peak * (state.ttl / state.dur);
        }
      }
    }
  };

  let skyEnv: WebGLRenderTarget | null = null;
  try {
    skyEnv = bakeSkyEnvironment(renderer, sky);
    scene.environment = skyEnv.texture;
    scene.environmentIntensity = SKY_ENV_INTENSITY;
  } catch (error) {
    console.error('[render] environment capture failed: ' + errorText(error));
  }

  // ---- HDR target + post chain ----
  const hdrDepth = new DepthTexture(4, 4);
  hdrDepth.type = UnsignedIntType;
  hdrDepth.minFilter = hdrDepth.magFilter = NearestFilter;
  const hdrTarget = new WebGLRenderTarget(4, 4, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    depthTexture: hdrDepth,
    samples: game.quality.msaa | 0,
    generateMipmaps: false
  });
  let postPipeline: PostPipeline | null = null;
  /** True while the HDR post chain is in use (false = forward fallback). */
  let advanced = params.post !== '0';
  if (params.ao === '0') game.quality.ao = false;
  if (params.vol === '0') game.quality.volSteps = 0;
  if (params.bloom === '0') game.quality.bloom = false;
  if (params.mb === '1') game.quality.motionBlur = true;
  if (advanced)
    try {
      postPipeline = createPostPipeline(renderer, game, {
        noiseTex
      });
    } catch (error) {
      advanced = false;
      console.error(
        '[render] post chain failed to initialise, using forward fallback: ' + errorText(error)
      );
    }
  /** Screenshot / showcase mode: snap eye adaptation. */
  const fastAdapt = !!(params.shot || params.show);
  let depthCopyRequested = false;
  const thunder = {
    t: 99,
    power: 0,
    value: 0
  };
  if (game.events && game.events.on)
    game.events.on('thunder', (payload: { intensity?: number } | undefined) => {
      thunder.t = 0;
      thunder.power = Math.min(1, (payload && payload.intensity) || 0.6);
      const angle = Math.PI * (0.55 + Math.random() * 0.9);
      sky.material.uniforms.uFlashDir.value
        .set(
          Math.cos(angle),
          0.35 + Math.random() * 0.3,
          Math.sin(angle) * (Math.random() < 0.5 ? -1 : 1)
        )
        .normalize();
    });

  // ---- dynamic resolution ----
  const dynRes: DynamicResolution = {
    scale: 1,
    enabled: !(params.shot || params.show || params.dynres === '0'),
    acc: 0,
    n: 0,
    settle: 3.5,
    upWait: 4,
    upDelay: 4
  };
  /** Adjusts the render scale from measured frame times; drops a quality level if still too slow. */
  function updateDynamicResolution(frameMs: number): void {
    if (!dynRes.enabled || !advanced || frameMs > 1500) return;
    dynRes.settle -= frameMs / 1000;
    dynRes.upWait -= frameMs / 1000;
    if (dynRes.settle > 0) {
      dynRes.acc = 0;
      dynRes.n = 0;
      return;
    }
    dynRes.acc += frameMs;
    dynRes.n++;
    if (dynRes.n < 45 && dynRes.acc < 900) return;
    const avgMs = dynRes.acc / dynRes.n;
    dynRes.acc = 0;
    dynRes.n = 0;
    let scale = dynRes.scale;
    if (avgMs > 21.5 && scale > 0.6) {
      scale = avgMs > 45 ? 0.6 : Math.max(0.6, scale - (avgMs > 30 ? 0.2 : 0.1));
      dynRes.upDelay = Math.min(60, dynRes.upDelay * 2);
      dynRes.upWait = dynRes.upDelay;
    } else if (avgMs < 17.4 && scale < 1 && dynRes.upWait <= 0) {
      scale = Math.min(1, scale + 0.1);
      dynRes.upWait = 2;
    } else if (avgMs < 17.4 && scale >= 1) dynRes.upDelay = 4;
    scale = Math.round(scale * 10) / 10;
    if (scale <= 0.6 && avgMs > 26) {
      dynRes.floorHits = (dynRes.floorHits || 0) + 1;
      const lowerQuality = (
        {
          ultra: 'high',
          high: 'medium',
          medium: 'low'
        } as Record<string, QualityName | undefined>
      )[game.quality.name];
      if (dynRes.floorHits >= 2 && lowerQuality && QUALITY_PRESETS[lowerQuality]) {
        dynRes.floorHits = 0;
        dynRes.scale = 0.8;
        dynRes.settle = 2;
        dynRes.upDelay = 4;
        console.log(
          '[render] frame time ' +
            avgMs.toFixed(0) +
            ' ms at minimum scale: dropping quality to ' +
            lowerQuality
        );
        try {
          system.setQuality({
            ...QUALITY_PRESETS[lowerQuality]
          });
          game.events.emit('quality:auto', {
            name: lowerQuality
          });
        } catch {}
        return;
      }
    } else dynRes.floorHits = 0;
    if (scale !== dynRes.scale) {
      dynRes.scale = scale;
      dynRes.settle = 1;
      system.resize();
    }
  }

  const prePasses: PrePass[] = [];
  const loggedOnce: Record<string, number> = {};
  const logOnce = (key: string, message: string) => {
    if (!loggedOnce[key]) {
      loggedOnce[key] = 1;
      console.error(message);
    }
  };
  let lastStats = {
    calls: 0,
    tris: 0
  };
  let frameCount = 0;
  let lastFrameAt = 0;
  /** Makes the viewmodel camera share the world camera's transform. */
  function syncViewCamera(): void {
    camera.updateMatrixWorld(true);
    viewCamera.matrixAutoUpdate = false;
    viewCamera.matrixWorldAutoUpdate = false;
    viewCamera.matrixWorld.copy(camera.matrixWorld);
    viewCamera.matrixWorldInverse.copy(viewCamera.matrixWorld).invert();
  }
  /** Fallback path: render straight to the canvas with three's ACES tone mapping. */
  function renderForward(): void {
    if (renderer.toneMapping !== ACESFilmicToneMapping)
      renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure =
      0.6 * system.exposure * (1 - Math.min(1, Math.max(0, system.post.fade)));
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    renderer.clearDepth();
    renderer.render(scene, viewCamera);
  }
  const viewKeyLight = new DirectionalLight(new Color(0.78, 0.86, 1), 0.9);
  viewKeyLight.name = 'viewmodel-key';
  viewKeyLight.castShadow = false;
  viewKeyLight.layers.set(VIEWMODEL_LAYER);
  viewKeyLight.position.set(-0.55, 0.75, 0.6);
  viewKeyLight.target.position.set(0.1, -0.1, -0.4);
  camera.add(viewKeyLight, viewKeyLight.target);
  /** True when the camera is inside the first interior box and an interior probe exists. */
  const cameraInInterior = () => {
    const box =
      system.interiorEnv && game.level && game.level.interiorBoxes && game.level.interiorBoxes[0];
    return !!(
      box &&
      box.min &&
      camera.position.x > box.min.x &&
      camera.position.x < box.max.x &&
      camera.position.z > box.min.z &&
      camera.position.z < box.max.z &&
      camera.position.y < box.max.y
    );
  };
  /** HDR path: scene + viewmodel into the HDR target, then the post chain to the canvas. */
  function renderAdvanced(dt: number): void {
    // only called while `advanced`, which implies the post chain was created
    const post = postPipeline!;
    if (renderer.toneMapping !== NoToneMapping) renderer.toneMapping = NoToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setRenderTarget(hdrTarget);
    renderer.clear(true, true, false);
    // Sun shadows refresh every frame on ultra, every 2nd frame on high/medium, every 3rd on low.
    const shadowEvery = game.quality.name === 'ultra' ? 1 : game.quality.name === 'low' ? 3 : 2;
    if (params.shot || frameCount % shadowEvery === 0 || !sun.shadow.map)
      renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    if (depthCopyRequested) {
      post.copyDepth(hdrDepth);
      renderer.setRenderTarget(hdrTarget);
    }
    // viewmodel goes into a squeezed depth range so it never clips into walls
    gl.depthRange(0, 0.05);
    const envIntensity = scene.environmentIntensity;
    const environment = scene.environment;
    viewKeyLight.intensity =
      (system.viewKey == null ? 0.9 : system.viewKey) * (cameraInInterior() ? 0.55 : 1);
    const box =
      system.interiorEnv && game.level && game.level.interiorBoxes && game.level.interiorBoxes[0];
    const inside = !!(
      box &&
      box.min &&
      camera.position.x > box.min.x &&
      camera.position.x < box.max.x &&
      camera.position.z > box.min.z &&
      camera.position.z < box.max.z &&
      camera.position.y < box.max.y
    );
    if (inside) scene.environment = system.interiorEnv;
    scene.environmentIntensity =
      envIntensity *
      (inside ? INTERIOR_ENV_INTENSITY / SKY_ENV_INTENSITY : 1) *
      (system.viewFill || 1.1);
    try {
      renderer.render(scene, viewCamera);
    } finally {
      gl.depthRange(0, 1);
      scene.environmentIntensity = envIntensity;
      scene.environment = environment;
    }
    post.run({
      hdr: hdrTarget,
      camera,
      sun,
      dt,
      post: system.post,
      exposure: system.exposure,
      time: game.time ? game.time.t : frameCount / 60,
      fast: fastAdapt,
      thunder: thunder.value
    });
    renderer.setRenderTarget(null);
    if (shaderFailures.post) throw new Error('a post shader failed to compile');
  }
  const system: RenderSystem = {
    renderer,
    scene,
    camera,
    viewCamera,
    sun,
    sky: sky.mesh,
    sunDir: SUN.dir.clone(),
    lightPool,
    post: {
      damage: 0,
      lowHealth: 0,
      ads: 0,
      flash: 0,
      fade: 0,
      saturation: 1,
      focusDist: 0,
      shake: 0,
      wet: 1
    },
    exposure: 1,
    env: skyEnv ? skyEnv.texture : null,
    interiorEnv: null,
    resolution: new Vector2(4, 4),
    depthTextureIsLive: false,
    tune: postPipeline ? postPipeline.TUNE : {},
    get advanced() {
      return advanced;
    },
    get autoExposure() {
      return postPipeline ? postPipeline.autoExposure : false;
    },
    set autoExposure(enabled) {
      if (postPipeline) postPipeline.autoExposure = !!enabled;
    },
    get depthTexture() {
      if (!postPipeline) return null;
      depthCopyRequested = true;
      try {
        return postPipeline.ensureDepthCopy();
      } catch {
        return null;
      }
    },
    addPrePass(prePass) {
      prePasses.push(prePass);
    },
    renderWorld(worldCamera, target) {
      const previousTarget = renderer.getRenderTarget();
      const previousShadowUpdate = renderer.shadowMap.needsUpdate;
      const previousToneMapping = renderer.toneMapping;
      const previousExposure = renderer.toneMappingExposure;
      const previousLayers = worldCamera.layers.mask;
      worldCamera.layers.disable(VIEWMODEL_LAYER);
      renderer.shadowMap.needsUpdate = false;
      renderer.toneMapping = NoToneMapping;
      renderer.toneMappingExposure = 1;
      try {
        renderer.setRenderTarget(target);
        renderer.clear();
        renderer.render(scene, worldCamera);
      } finally {
        worldCamera.layers.mask = previousLayers;
        renderer.setRenderTarget(previousTarget);
        renderer.shadowMap.needsUpdate = previousShadowUpdate;
        renderer.toneMapping = previousToneMapping;
        renderer.toneMappingExposure = previousExposure;
      }
    },
    async onLevelReady() {
      renderer.shadowMap.needsUpdate = true;
      try {
        captureInteriorProbe();
      } catch (error) {
        console.error('[render] interior probe failed: ' + errorText(error));
      }
      try {
        if (advanced) renderer.setRenderTarget(hdrTarget);
        await renderer.compileAsync(scene, camera);
        if (system.interiorEnv) {
          const environment = scene.environment;
          scene.environment = system.interiorEnv;
          try {
            renderer.compile(scene, viewCamera);
          } finally {
            scene.environment = environment;
          }
        }
      } catch {}
      renderer.setRenderTarget(null);
      dynRes.settle = 3.5;
      dynRes.acc = 0;
      dynRes.n = 0;
    },
    setQuality(quality) {
      game.quality = quality;
      const mapSize = shadowMapSize();
      if (sun.shadow.mapSize.x !== mapSize) {
        sun.shadow.mapSize.set(mapSize, mapSize);
        if (sun.shadow.map) {
          sun.shadow.map.dispose();
          sun.shadow.map = null;
        }
      }
      const samples = quality.msaa | 0;
      if (hdrTarget.samples !== samples) {
        hdrTarget.samples = samples;
        hdrTarget.dispose();
      }
      if (postPipeline) postPipeline.applyQuality();
      system.resize();
      game.events.emit('quality:changed', { name: quality.name });
    },
    resize() {
      const width = Math.max(2, canvas.clientWidth || window.innerWidth);
      const height = Math.max(2, canvas.clientHeight || window.innerHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const qualityScale = game.quality.scale || 1;
      if (advanced) {
        renderer.setPixelRatio(dpr);
        renderer.setSize(width, height, false);
        let scale = qualityScale * dynRes.scale;
        // cap the internal pixel count per quality level
        const pixelBudget =
          (
            {
              low: 1e6,
              medium: 15e5,
              high: 23e5,
              ultra: 37e5
            } as Record<string, number | undefined>
          )[game.quality.name] || 23e5;
        const pixels = width * dpr * height * dpr * scale * scale;
        if (pixels > pixelBudget) scale *= Math.sqrt(pixelBudget / pixels);
        const targetW = Math.max(16, Math.round(width * dpr * scale));
        const targetH = Math.max(16, Math.round(height * dpr * scale));
        hdrTarget.setSize(targetW, targetH);
        if (hdrDepth.image.width !== targetW || hdrDepth.image.height !== targetH) {
          hdrDepth.image.width = targetW;
          hdrDepth.image.height = targetH;
          hdrDepth.needsUpdate = true;
        }
        if (postPipeline) postPipeline.resize(targetW, targetH);
        system.resolution.set(targetW, targetH);
      } else {
        renderer.setPixelRatio(dpr * qualityScale);
        renderer.setSize(width, height, false);
        system.resolution.set(
          Math.round(width * dpr * qualityScale),
          Math.round(height * dpr * qualityScale)
        );
      }
      camera.aspect = viewCamera.aspect = width / height;
      camera.updateProjectionMatrix();
      viewCamera.updateProjectionMatrix();
    },
    frame(dt) {
      const now = performance.now();
      if (lastFrameAt) updateDynamicResolution(now - lastFrameAt);
      lastFrameAt = now;
      frameCount++;
      renderer.info.reset();
      lightPool.update(dt);
      const time = game.time ? game.time.t : frameCount / 60;
      sky.material.uniforms.uTime.value = time;
      thunder.t += dt;
      // flickering, decaying lightning flash
      thunder.value =
        thunder.t < 0.9
          ? thunder.power *
            Math.exp(-thunder.t * 5) *
            (0.55 + 0.45 * Math.sin(thunder.t * 47) * Math.sin(thunder.t * 13 + 1)) *
            0.35
          : 0;
      sky.material.uniforms.uFlash.value = Math.max(0, thunder.value);
      syncViewCamera();
      for (const prePass of prePasses)
        try {
          prePass(renderer, scene, camera);
        } catch (error) {
          logOnce('pre', '[render] pre-pass threw: ' + errorText(error));
        }
      if (advanced)
        try {
          renderAdvanced(dt);
        } catch (error) {
          advanced = false;
          try {
            gl.depthRange(0, 1);
            renderer.setRenderTarget(null);
          } catch {}
          console.error(
            '[render] advanced pipeline disabled, falling back to forward rendering: ' +
              errorText(error)
          );
          system.resize();
        }
      if (!advanced) renderForward();
      lastStats = {
        calls: renderer.info.render.calls,
        tris: renderer.info.render.triangles
      };
    },
    stats() {
      const info = renderer.info;
      return {
        calls: lastStats.calls,
        tris: lastStats.tris,
        geos: info.memory.geometries,
        tex: info.memory.textures,
        programs: info.programs ? info.programs.length : 0,
        res: [system.resolution.x, system.resolution.y],
        scale: dynRes.scale,
        advanced,
        softShadows,
        adapt: postPipeline && params.shot ? postPipeline.readAdapt() : undefined
      };
    }
  };
  let interiorProbe: InteriorProbe | null = null;
  /** Renders a cube map from the middle of the first interior box and assigns it to interior materials. */
  function captureInteriorProbe(): void {
    const boxes = game.level && game.level.interiorBoxes;
    if (!boxes || !boxes.length) return;
    const box = boxes[0];
    const centerX = (box.min.x + box.max.x) / 2;
    const centerZ = (box.min.z + box.max.z) / 2;
    const probeY = box.min.y + Math.min(2.4, (box.max.y - box.min.y) * 0.4);
    if (!interiorProbe) {
      const cubeRT = new WebGLCubeRenderTarget(128, {
        type: HalfFloatType,
        generateMipmaps: false
      });
      interiorProbe = {
        cubeRT,
        cam: new CubeCamera(0.15, 300, cubeRT),
        pmrem: new PMREMGenerator(renderer),
        out: null
      };
      interiorProbe.cam.layers.set(WORLD_LAYER);
    }
    const probe = interiorProbe;
    probe.cam.position.set(centerX, probeY, centerZ);
    probe.cam.updateMatrixWorld(true);
    const previousToneMapping = renderer.toneMapping;
    renderer.toneMapping = NoToneMapping;
    sky.material.uniforms.uEnv.value = 1;
    renderer.shadowMap.needsUpdate = true;
    try {
      probe.cam.update(renderer, scene);
    } finally {
      sky.material.uniforms.uEnv.value = 0;
      renderer.toneMapping = previousToneMapping;
      renderer.setRenderTarget(null);
    }
    if (probe.out) probe.out.dispose();
    probe.out = probe.pmrem.fromCubemap(probe.cubeRT.texture);
    system.interiorEnv = probe.out.texture;
    let assigned = 0;
    const seen = new Set<Material>();
    scene.traverse((object: Object3D) => {
      const objectMaterial = (object as Partial<Mesh>).material;
      const list = objectMaterial
        ? Array.isArray(objectMaterial)
          ? objectMaterial
          : [objectMaterial]
        : null;
      if (list)
        for (const material of list) {
          if (
            !material ||
            seen.has(material) ||
            !material.userData ||
            material.userData.interior !== true ||
            !('envMap' in material)
          )
            continue;
          seen.add(material);
          const envMaterial = material as MeshStandardMaterial;
          envMaterial.envMap = system.interiorEnv;
          if (!material.userData.keepEnvIntensity)
            envMaterial.envMapIntensity = INTERIOR_ENV_INTENSITY;
          material.needsUpdate = true;
          assigned++;
        }
    });
    if (assigned) console.log(`[render] interior probe assigned to ${assigned} material(s)`);
  }
  system.captureInteriorProbe = captureInteriorProbe;
  system.resize();
  window.addEventListener('resize', () => system.resize());

  // ---- self test: render a probe cube once to catch driver shader failures early ----
  try {
    const testMaterial = new MeshStandardMaterial({
      color: 0x808080
    });
    const testCube = new Mesh(new BoxGeometry(1, 1, 1), testMaterial);
    testCube.castShadow = testCube.receiveShadow = true;
    testCube.position.set(0, 0.5, -3);
    scene.add(testCube);
    const renderOnce = () => {
      syncViewCamera();
      if (advanced) renderAdvanced(0.016);
      else renderForward();
    };
    try {
      renderOnce();
    } catch (error) {
      if (advanced) {
        advanced = false;
        console.error(
          '[render] advanced pipeline failed its self test, using forward fallback: ' +
            ((error && (error as Error).message) || error)
        );
      }
    }
    if (shaderFailures.shadow && softShadows) {
      restoreStockShadows();
      softShadows = false;
      shaderFailures.shadow = false;
      renderer.shadowMap.type = PCFSoftShadowMap;
      sun.shadow.radius = 2;
      testMaterial.dispose();
      // a new material (different colour) forces a fresh program with the stock chunk
      testCube.material = new MeshStandardMaterial({
        color: 0x808081
      });
      console.warn('[render] soft shadow chunk rejected by the driver, using stock PCF');
      try {
        renderOnce();
      } catch {
        advanced = false;
      }
    }
    if (shaderFailures.sky) console.error('[render] sky shader failed to compile');
    scene.remove(testCube);
    testCube.geometry.dispose();
    testMaterial.dispose();
    testCube.material.dispose();
    if (!advanced) {
      try {
        gl.depthRange(0, 1);
        renderer.setRenderTarget(null);
      } catch {}
      system.resize();
    }
    frameCount = 0;
  } catch (error) {
    console.error('[render] self test threw: ' + errorText(error));
  }
  return system;
}

/** Camera placement and per-frame hook of the render showcase. */
export interface RenderShowcase {
  cam: number[];
  target: number[];
  update: () => void;
}

/**
 * Debug scene (`?show=render`): PBR spheres, material blocks, a wall with gaps for
 * light shafts and a dark shed. The camera's y (in mm) selects a post effect to preview.
 */
export function buildRenderShowcase(game: Game): RenderShowcase {
  const group = new Group();
  group.name = 'render-showcase';
  const add = <T extends Object3D>(object: T) => {
    group.add(object);
    return object;
  };
  const sphereGeometry = new SphereGeometry(0.42, 48, 24);
  // roughness ramp: dielectric row in front, metal row behind
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 7; col++) {
      const material = new MeshStandardMaterial({
        color: row ? 0xb9b4a8 : 0x7a2a1c,
        roughness: 0.06 + col * 0.15,
        metalness: row ? 1 : 0
      });
      const sphere = new Mesh(sphereGeometry, material);
      sphere.position.set(-3.6 + col * 1.2, 0.42 + row * 1.05, row * -1.1);
      sphere.castShadow = sphere.receiveShadow = true;
      add(sphere);
    }
  const blocks: Array<[string, number, number, number, number, number]> = [
    ['paint_orange', -5.2, 1.4, 1.3, 1.2, 2.2],
    ['steel_worn', 4.6, 1, 0.9, 1, 1.6],
    ['paint_teal', 5.6, 0.6, 2.4, 0.9, 3.6],
    ['concrete', -2.2, 0.5, 0.5, 2.6, 3.2]
  ];
  for (const [materialName, x, width, height, depth, z] of blocks) {
    const block = shadowedMesh(
      roundedBox(width, height, depth, 0.03, 'bottom'),
      game.mats.get(materialName)
    );
    block.position.set(x, 0, z);
    block.rotation.y = x * 0.2;
    add(block);
  }
  for (let i = 0; i < 5; i++) {
    const crate = shadowedMesh(
      roundedBox(0.5, 0.5, 0.5, 0.02, 'bottom'),
      game.mats.get('wood_pallet')
    );
    crate.position.set(0.5 + i * 0.52, 0, 3.4 + (i % 2) * 0.04);
    add(crate);
  }
  {
    const crate = shadowedMesh(
      roundedBox(0.5, 0.5, 0.5, 0.02, 'bottom'),
      game.mats.get('wood_pallet')
    );
    crate.position.set(1.3, 0.5, 3.42);
    crate.rotation.y = 0.3;
    add(crate);
  }
  // wall segments along x = 9 with gaps between them
  const wallMaterial = game.mats.get('concrete_dirty');
  const wallX = 9;
  const wallHeight = 7.5;
  const wallSpans = [
    [-14, -5.2],
    [-4.7, -1.6],
    [-1.1, 1.9],
    [2.4, 5.6],
    [6.3, 14]
  ];
  for (const [zStart, zEnd] of wallSpans) {
    const segment = shadowedMesh(
      worldUvBox(0.4, wallHeight, zEnd - zStart, 'bottom'),
      wallMaterial
    );
    segment.position.set(wallX, 0, (zStart + zEnd) / 2);
    add(segment);
  }
  {
    const lintel = shadowedMesh(worldUvBox(0.4, 1.2, 28, 'bottom'), wallMaterial);
    lintel.position.set(wallX, wallHeight, 0);
    add(lintel);
  }
  // dark steel shed
  const shedPanels = [
    [-12, 0, -9, 6, 4, 0.3],
    [-12, 0, -3, 6, 4, 0.3],
    [-15, 0, -6, 0.3, 4, 6.3],
    [-12, 4, -6, 6.6, 0.3, 6.6]
  ];
  for (const [x, y, z, width, height, depth] of shedPanels) {
    const panel = shadowedMesh(
      worldUvBox(width, height, depth, 'bottom'),
      game.mats.get('steel_dark')
    );
    panel.position.set(x, y, z);
    add(panel);
  }
  {
    const lamp = new Mesh(worldUvBox(2.4, 0.06, 0.06), game.mats.emissive(0xffb060, 14));
    lamp.position.set(-12, 3.6, -6);
    add(lamp);
  }
  {
    const bulb = new Mesh(new SphereGeometry(0.06, 12, 8), game.mats.emissive(0xff3a20, 30));
    bulb.position.set(4.6, 1.02, 1.6);
    add(bulb);
  }
  game.scene.add(group);
  return {
    cam: [-8.5, 1.7, 4.2],
    target: [3, 1.5, 0.4],
    update: () => {
      const post = game.render.post;
      const mode = Math.round(game.camera.position.y * 1000) % 10;
      post.damage = mode === 1 ? 0.8 : 0;
      post.lowHealth = mode === 2 ? 0.85 : 0;
      post.ads = mode === 3 ? 1 : 0;
      post.flash = mode === 4 ? 0.35 : 0;
      post.fade = mode === 5 ? 0.5 : 0;
    }
  };
}

export { createRenderSystem as create, buildRenderShowcase as showcase };
