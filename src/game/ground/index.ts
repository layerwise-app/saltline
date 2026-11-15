// Ground subsystem: bakes the ground textures, builds the apron, sea, rain and planar
// reflection, and answers wetness/puddle/sea-height queries for gameplay and audio.
import { BoxGeometry, CylinderGeometry, DataTexture, Group, MathUtils, Mesh } from 'three';
import type {
  BufferGeometry,
  Material,
  Object3D,
  PerspectiveCamera,
  WebGLRenderTarget
} from 'three';
import { WORLD_BOUNDS } from '../core/config';
import type { Game } from '../core/types';
import {
  GROUND_MASK_RECT,
  bakeGroundDetailPixels,
  bakeGroundMaskPixels,
  createGroundDataTexture,
  paintRoadMarkingsTexture,
  sampleGroundMaskChannel
} from './textures';
import {
  createApronSurface,
  createPlanarReflection,
  createSeaSurface,
  seaHeightAt
} from './surfaces';
import type { ApronUniforms, PlanarReflection } from './surfaces';
import { createRainSystem } from './rain';
import type { GroundTextures } from './rain';

/** Rain intensity of the default (rainy) weather. */
const RAIN_LEVEL = 0.6;

/** Interior volume (shed etc.) where the ground is dry. */
interface InteriorBoxLike {
  min?: { x: number; z: number };
  max: { x: number; z: number };
}

/** The ground subsystem (`game.ground`). */
export interface Ground {
  /** Set on the fallback stub from `core/stubs.ts`. */
  stub?: boolean;
  root: Group;
  apron: Mesh;
  sea: Mesh;
  rain: Mesh;
  planar: PlanarReflection;
  reflectionTarget: WebGLRenderTarget;
  reflectionCamera: PerspectiveCamera;
  maskTexture: DataTexture;
  uniforms: ApronUniforms;
  /** Water depth above the waterline at (x, z); negative when dry. */
  puddleDepth(x: number, z: number): number;
  isPuddle(x: number, z: number): boolean;
  /** Surface wetness 0..1 at (x, z). */
  wetnessAt(x: number, z: number): number;
  /** Sea surface height at (x, z) for the current time. */
  seaHeight(x: number, z: number): number;
  /** Target rain intensity 0..1. */
  setRain(level: number): void;
  readonly rainLevel: number;
  setReflections(enabled: unknown): void;
  update(dt: number): void;
}

/** Creates the ground subsystem and adds it to the scene. */
export async function createGround(game: Game): Promise<Ground> {
  const highRes = (game.quality.tex || 512) >= 1024;
  const capabilities = game.renderer.capabilities;
  const anisotropy = Math.min(
    8,
    capabilities.getMaxAnisotropy ? capabilities.getMaxAnisotropy() : 1
  );
  const maskResolution = highRes ? 1024 : 512;
  const maskPixels = bakeGroundMaskPixels(maskResolution);
  const maskTexture = createGroundDataTexture(maskPixels, maskResolution, {
    repeat: false,
    aniso: 2
  });
  const detailResolution = highRes ? 512 : 256;
  const { det: detailPixels, nrm: detailNormalPixels } = bakeGroundDetailPixels(detailResolution);
  const detailTexture = createGroundDataTexture(detailPixels, detailResolution, {
    aniso: anisotropy
  });
  const detailNormalTexture = createGroundDataTexture(detailNormalPixels, detailResolution, {
    aniso: anisotropy
  });
  // Give the stencil font a moment to load before painting the road markings.
  try {
    if (document.fonts && document.fonts.load) {
      await Promise.race([
        document.fonts.load('900 40px "Big Shoulders Display"'),
        new Promise((resolve) => setTimeout(resolve, 350))
      ]);
    }
  } catch {}
  const marksTexture = paintRoadMarkingsTexture(highRes ? 2048 : 1024, anisotropy);
  const blackTexture = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blackTexture.needsUpdate = true;
  const textures: GroundTextures = {
    mask: maskTexture,
    detail: detailTexture,
    detailN: detailNormalTexture,
    marks: marksTexture,
    black: blackTexture
  };
  const root = new Group();
  root.name = 'ground';
  const apron = createApronSurface(game, textures);
  const sea = createSeaSurface(game, textures);
  const rain = createRainSystem(game, textures);
  root.add(apron.mesh, sea.mesh, sea.skirt, rain.rain, rain.splash);
  game.scene.add(root);
  const planar = createPlanarReflection(game, apron.uniforms, [
    apron.mesh,
    sea.mesh,
    rain.rain,
    rain.splash
  ]);
  if (game.render && game.render.addPrePass) game.render.addPrePass(planar.pass);
  const isIndoors = (x: number, z: number): boolean => {
    const boxes: readonly (InteriorBoxLike | undefined)[] | undefined =
      game.level && game.level.interiorBoxes;
    if (!boxes) return false;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box && box.min && x > box.min.x && x < box.max.x && z > box.min.z && z < box.max.z)
        return true;
    }
    return false;
  };
  const insideMask = (x: number, z: number): boolean =>
    x > GROUND_MASK_RECT.x0 &&
    x < GROUND_MASK_RECT.x0 + GROUND_MASK_RECT.size &&
    z > GROUND_MASK_RECT.z0 &&
    z < GROUND_MASK_RECT.z0 + GROUND_MASK_RECT.size;
  let time = 0;
  const ground: Ground = {
    root,
    apron: apron.mesh,
    sea: sea.mesh,
    rain: rain.rain,
    planar,
    reflectionTarget: planar.target,
    reflectionCamera: planar.camera,
    maskTexture,
    uniforms: apron.uniforms,
    puddleDepth(x: number, z: number) {
      return x > WORLD_BOUNDS.quayX || !insideMask(x, z) || isIndoors(x, z)
        ? -0.2
        : 0.5 - sampleGroundMaskChannel(maskPixels, maskResolution, x, z, 0);
    },
    isPuddle(x: number, z: number) {
      return ground.puddleDepth(x, z) > 0.015;
    },
    wetnessAt(x: number, z: number) {
      if (x > WORLD_BOUNDS.quayX) return 1;
      if (isIndoors(x, z)) return 0.12;
      if (!insideMask(x, z)) return 0.6;
      const depth = 0.5 - sampleGroundMaskChannel(maskPixels, maskResolution, x, z, 0);
      if (depth > 0.015) return 1;
      const smoothstep = MathUtils.smoothstep;
      const nearPuddle = smoothstep(depth, -0.11, 0);
      const lowGround = smoothstep(depth, -0.65, -0.02);
      const dryness =
        1 -
        smoothstep(
          sampleGroundMaskChannel(maskPixels, maskResolution, x, z, 1) + lowGround * 0.55,
          0.2,
          0.42
        );
      return Math.min(0.95, 0.25 + (1 - dryness) * 0.4 + nearPuddle * 0.3);
    },
    seaHeight(x: number, z: number) {
      return seaHeightAt(x, z, time);
    },
    setRain(level: number) {
      rain.setRain(level);
    },
    get rainLevel() {
      return rain.rainLevel;
    },
    setReflections(enabled: unknown) {
      planar.enabled = !!enabled;
    },
    update(dt: number) {
      time += dt;
      rain.setRain(RAIN_LEVEL * (game.weather ? game.weather.rain : 1));
      rain.update(dt);
      apron.uniforms.uTime.value = time;
      apron.uniforms.uRain.value = rain.rainLevel;
      // Surfaces dry off in clear weather (unless `?wet=` pins the wetness for QA).
      if (game.params.wet === undefined && game.mats && game.mats.uniforms) {
        game.mats.uniforms.wet.value = Math.min(1, rain.rainLevel / RAIN_LEVEL);
      }
      sea.uniforms.uTime.value = time;
    }
  };
  return ground;
}

/** Debug showcase (`?show=ground`): replaces the placeholder floor and adds reference props. */
export async function groundShowcase(game: Game): Promise<{ cam: number[]; target: number[] }> {
  const placeholderFloor = game.scene.children.find((child: Object3D) => {
    const mesh = child as Partial<Mesh>;
    const geometry = mesh.geometry as
      (BufferGeometry & { parameters?: { width?: number } }) | undefined;
    return (
      mesh.isMesh &&
      geometry &&
      geometry.type === 'PlaneGeometry' &&
      geometry.parameters &&
      geometry.parameters.width === 80
    );
  });
  if (placeholderFloor) game.scene.remove(placeholderFloor);
  game.ground = await createGround(game);
  const group = new Group();
  const place = (
    geometry: BufferGeometry,
    material: Material,
    x: number,
    y: number,
    z: number,
    rotationY = 0
  ): Mesh => {
    const mesh = new Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotationY;
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const mat = (name: string): Material => game.mats.get(name);
  place(new BoxGeometry(6.06, 2.59, 2.44), mat('paint_red'), 3, 1.295, -0.2);
  place(new BoxGeometry(6.06, 2.59, 2.44), mat('paint_blue'), 9.4, 1.295, -0.2);
  place(new BoxGeometry(6.06, 2.59, 2.44), mat('paint_teal'), 9.4, 3.885, -0.2);
  place(new BoxGeometry(12.19, 2.59, 2.44), mat('paint_yellow'), 3, 1.295, 11.2);
  place(new BoxGeometry(6.06, 2.59, 2.44), mat('paint_white'), 12.4, 1.295, 11.2);
  place(new BoxGeometry(1.1, 1.1, 1.1), mat('paint_orange'), 5.6, 0.55, 4.7, 0.4);
  place(new CylinderGeometry(0.29, 0.29, 0.88, 20), mat('plastic_blue'), 3.9, 0.44, 6.3);
  place(new CylinderGeometry(0.29, 0.29, 0.88, 20), mat('steel_rust'), 4.6, 0.44, 6.6);
  place(new CylinderGeometry(0.06, 0.06, 5, 10), mat('steel_galv'), 12.5, 2.5, 6.2);
  place(new BoxGeometry(0.08, 1.6, 0.08), game.mats.emissive(0xff3a1c, 6), 6.6, 0.82, 2.6);
  place(new BoxGeometry(0.08, 1.6, 0.08), game.mats.emissive(0x35c8ff, 5), 2.2, 0.82, 3.2);
  place(new BoxGeometry(2.4, 0.08, 0.06), game.mats.emissive(0xfff0d0, 6), 9.4, 2.2, 1.06);
  place(new BoxGeometry(0.3, 0.12, 0.3), game.mats.emissive(0xffc070, 12), 12.5, 5, 6.2);
  place(new BoxGeometry(0.06, 1.2, 0.06), game.mats.emissive(0x58ff7a, 5), 23, 0.62, 8.2);
  place(new BoxGeometry(1.2, 1.2, 1.2), mat('steel_dark'), 22.4, 0.6, 9.6, 0.3);
  game.scene.add(group);
  return {
    cam: [-9, 1.65, 5.6],
    target: [14, 0.4, 5]
  };
}

export { createGround as create, groundShowcase as showcase };
