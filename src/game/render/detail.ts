/**
 * Quality-driven scene detail: lowers the cost of what the player cannot reach or barely sees.
 *
 * - Distance culling: small level objects are hidden beyond a distance that grows with their
 *   size and with the quality preset (ultra keeps everything).
 * - Shadows: objects outside the playable area (and the container ship out in the water) stop
 *   casting sun shadows on low and medium.
 * - Low quality hides small out-of-bounds clutter and the backdrop's minor detail meshes
 *   (`userData.detail === 'minor'`, see `MaterialBatcher.minorSize`).
 *
 * Only visibility and `castShadow` change, so switching presets never recompiles shaders.
 * Units that contain lights are left alone (hiding a light would change every shader).
 */
import { Box3, Sphere, Vector3 } from 'three';
import type { Light, Mesh, Object3D } from 'three';
import { WORLD_BOUNDS } from '../core/config';
import type { Game } from '../core/types';

interface DetailProfile {
  /** Cull distance = base + radius * perRadius (Infinity: never cull). */
  base: number;
  perRadius: number;
  /** Out-of-bounds objects and the ship keep casting shadows. */
  farShadows: boolean;
  /** Hide minor backdrop meshes and small out-of-bounds objects. */
  reduce: boolean;
}

const PROFILES: Record<string, DetailProfile> = {
  low: { base: 18, perRadius: 10, farShadows: false, reduce: true },
  medium: { base: 30, perRadius: 16, farShadows: false, reduce: false },
  high: { base: 55, perRadius: 26, farShadows: true, reduce: false },
  ultra: { base: Infinity, perRadius: 0, farShadows: true, reduce: false }
};

/** Objects at least this big (bounding radius, m) are never distance-culled. */
const CULL_MAX_RADIUS = 6;
/** Out-of-bounds objects smaller than this are removed on low. */
const REDUCE_MAX_RADIUS = 3;
/** Groups larger than this are split into their children. */
const SPLIT_RADIUS = 6;
/** Frames between culling passes. */
const CULL_INTERVAL = 6;

interface Unit {
  object: Object3D;
  center: Vector3;
  radius: number;
  outside: boolean;
  /** Distance-culled right now. */
  culled: boolean;
  /** Removed by the low preset. */
  reduced: boolean;
  /** Hidden by this system; `prevVisible` is restored when it shows the unit again. */
  hidden: boolean;
  prevVisible: boolean;
  /** Meshes with their original `castShadow`. */
  casters: { mesh: Mesh; cast: boolean }[];
}

export interface DetailSystem {
  /** Applies the profile of the active quality preset. */
  apply(): void;
  /** Distance culling against the camera; call once per frame. */
  update(): void;
  stats(): { units: number; culled: number; reduced: number };
}

const hasLight = (object: Object3D): boolean => {
  let found = false;
  object.traverse((child) => {
    if ((child as Light).isLight) found = true;
  });
  return found;
};

function isOutside(center: Vector3): boolean {
  const margin = 1;
  return (
    center.x < WORLD_BOUNDS.min.x - margin ||
    center.x > WORLD_BOUNDS.max.x + margin ||
    center.z < WORLD_BOUNDS.min.z - margin ||
    center.z > WORLD_BOUNDS.max.z + margin
  );
}

/** Creates the detail manager for the built level and backdrop. */
export function createDetailSystem(game: Game): DetailSystem {
  const units: Unit[] = [];
  const minorMeshes: Mesh[] = [];
  const farCasters: { mesh: Mesh; cast: boolean }[] = [];
  const box = new Box3();
  const sphere = new Sphere();

  function collectCasters(object: Object3D): { mesh: Mesh; cast: boolean }[] {
    const casters: { mesh: Mesh; cast: boolean }[] = [];
    object.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh) casters.push({ mesh, cast: mesh.castShadow });
    });
    return casters;
  }

  function addUnits(object: Object3D): void {
    if (!object.visible || hasLight(object)) {
      // Keep the object as is, but still look for cullable pieces next to its lights.
      if (object.visible) for (const child of object.children) if (!(child as Light).isLight) addUnits(child);
      return;
    }
    box.setFromObject(object);
    if (box.isEmpty()) return;
    box.getBoundingSphere(sphere);
    if (sphere.radius > SPLIT_RADIUS && object.children.length > 1) {
      for (const child of object.children) addUnits(child);
      return;
    }
    units.push({
      object,
      center: sphere.center.clone(),
      radius: sphere.radius,
      outside: isOutside(sphere.center),
      culled: false,
      reduced: false,
      hidden: false,
      prevVisible: true,
      casters: collectCasters(object)
    });
  }

  const levelRoot = game.scene.getObjectByName('level');
  if (levelRoot) {
    levelRoot.updateMatrixWorld(true);
    for (const child of levelRoot.children) addUnits(child);
  }
  const backdrop = game.backdrop && !game.backdrop.stub ? game.backdrop : null;
  if (backdrop) {
    backdrop.root.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh && mesh.userData.detail === 'minor') minorMeshes.push(mesh);
    });
    if (backdrop.ship) farCasters.push(...collectCasters(backdrop.ship));
  }

  let profile: DetailProfile = PROFILES.high;
  let frame = 0;
  const camPos = new Vector3();

  function refreshVisibility(unit: Unit): void {
    const hide = unit.culled || unit.reduced;
    if (hide === unit.hidden) return;
    if (hide) {
      unit.prevVisible = unit.object.visible;
      unit.object.visible = false;
    } else {
      unit.object.visible = unit.prevVisible;
    }
    unit.hidden = hide;
  }

  const system: DetailSystem = {
    apply() {
      profile = PROFILES[game.quality && game.quality.name] || PROFILES.high;
      for (const unit of units) {
        unit.reduced = profile.reduce && unit.outside && unit.radius < REDUCE_MAX_RADIUS;
        if (profile.base === Infinity) unit.culled = false;
        for (const caster of unit.casters) {
          caster.mesh.castShadow = caster.cast && (profile.farShadows || !unit.outside);
        }
        refreshVisibility(unit);
      }
      for (const caster of farCasters) caster.mesh.castShadow = caster.cast && profile.farShadows;
      for (const mesh of minorMeshes) mesh.visible = !profile.reduce;
      frame = 0;
      system.update();
    },
    update() {
      if (frame++ % CULL_INTERVAL !== 0 || profile.base === Infinity) return;
      const camera = game.camera;
      if (!camera) return;
      camera.getWorldPosition(camPos);
      for (const unit of units) {
        if (unit.reduced || unit.radius >= CULL_MAX_RADIUS) continue;
        const limit = profile.base + unit.radius * profile.perRadius;
        const culled = camPos.distanceTo(unit.center) - unit.radius > limit;
        if (culled !== unit.culled) {
          unit.culled = culled;
          refreshVisibility(unit);
        }
      }
    },
    stats() {
      let culled = 0;
      let reduced = 0;
      for (const unit of units) {
        if (unit.culled) culled++;
        if (unit.reduced) reduced++;
      }
      return { units: units.length, culled, reduced };
    }
  };
  game.events.on('quality:changed', () => system.apply());
  system.apply();
  return system;
}
