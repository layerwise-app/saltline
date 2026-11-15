/**
 * Level assembly: builds the Berth 4 container terminal (yard, shed, quay),
 * places the three relay objectives, merges the static geometry into a few
 * draw calls, and exposes gameplay data (spawns, zones, cover, extraction,
 * cinematic path, ground surface lookup) as the `Level` subsystem.
 */
import type * as THREE from 'three';
import { Group } from 'three';
import type { Game } from '../core/types';
import { mergeStaticMeshes } from '../render/geometry';
import { buildLabelAtlas, createLevelKit } from './kit';
import type { ExplosiveSpawn, LabelAtlas, PlacedProp, Vec3Tuple } from './kit';
import { SHED, buildShed, layGroundCable, placePowerPedestal } from './structures';
import type { ShedSkylight } from './structures';
import { buildQuayEdge } from './quayEdge';
import { HALF_PI, buildPerimeterFence, placeYardProps, vec3 } from './layout';

/** Where and facing which way the player starts. */
export interface PlayerStart {
  pos: THREE.Vector3;
  yaw: number;
}

/** A relay node the player must disable. */
export interface LevelObjective {
  id: string;
  label: string;
  zone: string;
  pos: THREE.Vector3;
  object: THREE.Object3D;
}

/** An enemy spawn point (ground units are snapped to walkable ground). */
export interface EnemySpawn {
  pos: THREE.Vector3;
  zone: string;
  type: 'ground' | 'air';
}

/** A named rectangular area of the map on the XZ plane. */
export interface LevelZone {
  name: string;
  min: [number, number];
  max: [number, number];
}

/** An axis-aligned interior volume (the shed), used for lighting, rain and audio. */
export interface InteriorBox {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

/** One keyframe of the benchmark/attract-mode camera path. */
export interface CinematicShot {
  pos: Vec3Tuple;
  look: Vec3Tuple;
}

export interface Extraction {
  pos: THREE.Vector3;
  radius: number;
}

export type GroundSurface = 'metal' | 'concrete';

export interface LevelStats {
  labelsAtlased: number;
  containers: number;
  props: number;
  tris: number;
  meshes: number;
}

/** The level subsystem (`game.level`), as returned by {@link createLevel}. */
export interface Level {
  /** Only set on the placeholder level `main.ts` builds for showcase mode. */
  stub?: boolean;
  root: THREE.Group;
  playerStart: PlayerStart;
  objectives: LevelObjective[];
  extraction: Extraction;
  enemySpawns: EnemySpawn[];
  zones: LevelZone[];
  interiorBoxes: InteriorBox[];
  cinematicPath: CinematicShot[];
  /** Spots enemies can take cover at (snapped to walkable ground). */
  coverPoints: THREE.Vector3[];
  skylights: ShedSkylight[];
  shedLights: THREE.PointLight[];
  vantage: {
    stairsFoot: THREE.Vector3;
    roof: THREE.Vector3;
  };
  stats: LevelStats;
  placed: PlacedProp[];
  explosives: ExplosiveSpawn[];
  /** Footstep surface at a ground position. */
  groundSurfaceAt(x: number, z: number): GroundSurface;
  update(dt: number): void;
}

/** Builds the whole level and adds it to the scene. */
export async function createLevel(game: Game): Promise<Level> {
  const root = new Group();
  root.name = 'level';
  game.scene.add(root);
  const kit = createLevelKit(game);
  placeYardProps(kit);
  buildPerimeterFence(kit);
  const shed = buildShed(kit);
  const quay = buildQuayEdge(kit);
  const relayA = kit.place(
    'relay_node',
    1.5,
    7.5,
    0.35,
    {
      seed: 1
    },
    0
  );
  const relayB = kit.place(
    'relay_node',
    shed.relayPos.x,
    shed.relayPos.z,
    HALF_PI * 0.9,
    {
      seed: 2
    },
    SHED.FLOOR
  );
  const relayC = kit.place(
    'relay_node',
    quay.relayPos.x,
    quay.relayPos.z,
    -0.2,
    {
      seed: 3
    },
    0
  );
  layGroundCable(
    kit,
    [
      [-2, -27.5, 1.2],
      [-2, -27.55, 0.08],
      [-1.4, -25.6],
      [-2.4, -23],
      [-1.9, -20.3]
    ],
    0.03,
    kit.MI('rubber'),
    SHED.FLOOR + 0.028
  );
  placePowerPedestal(kit, 20.4, -7.3, 0.2);
  layGroundCable(
    kit,
    [
      [20.5, -7],
      [21.4, -4.9],
      [22.4, -2.6],
      [22.9, -0.7]
    ],
    0.03
  );
  kit.staticRoot.updateMatrixWorld(true);

  // Move `noMerge` subtrees (outermost only) to the dynamic root so they survive merging.
  const noMergeObjects: THREE.Object3D[] = [];
  kit.staticRoot.traverse((object) => {
    if (
      object.userData &&
      object.userData.noMerge &&
      !(object.parent && hasNoMergeAncestor(object.parent, kit.staticRoot))
    )
      noMergeObjects.push(object);
  });
  for (const object of noMergeObjects) kit.dynRoot.attach(object);

  // Swap library materials for their vertex-colour variants where one exists,
  // so geometry with baked vertex colours merges into the same batch.
  const staticMaterials = new Set<THREE.Material>();
  kit.staticRoot.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material)) staticMaterials.add(mesh.material);
  });
  const vertexColorVariant = new Map<THREE.Material, THREE.Material>();
  for (const material of staticMaterials) {
    if (
      !(material as THREE.MeshStandardMaterial).isMeshStandardMaterial ||
      material.vertexColors ||
      material.transparent ||
      !material.name ||
      !((game.mats.names || []) as string[]).includes(material.name)
    )
      continue;
    try {
      const variantOpts: { interior?: boolean } =
        material.userData && material.userData.interior
          ? {
              interior: true
            }
          : {};
      if (game.mats.get(material.name, variantOpts) !== material) continue;
      const variant: THREE.Material = game.mats.get(material.name, {
        ...variantOpts,
        vertexColors: true
      });
      if (variant !== material && staticMaterials.has(variant))
        vertexColorVariant.set(material, variant);
    } catch {}
  }
  kit.staticRoot.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const variant = vertexColorVariant.get(mesh.material);
    if (variant) mesh.material = variant;
    const material = mesh.material as THREE.Material;
    const castsShadow =
      !material.transparent && !(material as THREE.MeshBasicMaterial).isMeshBasicMaterial;
    mesh.castShadow = castsShadow;
    mesh.receiveShadow = !(material as THREE.MeshBasicMaterial).isMeshBasicMaterial;
  });

  let labelAtlas: Pick<LabelAtlas, 'count' | 'update'> = {
    count: 0,
    update() {}
  };
  try {
    labelAtlas = buildLabelAtlas(kit.staticRoot);
  } catch (error) {
    console.error('[level] label atlas failed', error);
  }
  const merged: THREE.Object3D = mergeStaticMeshes(kit.staticRoot);
  merged.name = 'level-merged';
  root.add(merged);
  root.add(kit.dynRoot);
  // Relay nodes are re-attached empty to the dynamic root: their visible parts
  // were merged above, the objects remain as interaction anchors.
  for (const relay of [relayA, relayB, relayC]) {
    for (let index = relay.children.length - 1; index >= 0; index--)
      relay.remove(relay.children[index]);
    kit.dynRoot.add(relay);
  }
  let triangleCount = 0;
  merged.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      const geometry = mesh.geometry;
      triangleCount +=
        (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
    }
  });

  const playerStart: PlayerStart = {
    pos: vec3(-32, 0, 6),
    yaw: -HALF_PI
  };
  const objectives: LevelObjective[] = [
    {
      id: 'relay_a',
      label: 'Relay A — Yard',
      zone: 'yard',
      pos: vec3(1.5, 0, 7.5),
      object: relayA
    },
    {
      id: 'relay_b',
      label: 'Relay B — Shed',
      zone: 'shed',
      pos: vec3(shed.relayPos.x, SHED.FLOOR, shed.relayPos.z),
      object: relayB
    },
    {
      id: 'relay_c',
      label: 'Relay C — Quay',
      zone: 'quay',
      pos: vec3(quay.relayPos.x, 0, quay.relayPos.z),
      object: relayC
    }
  ];
  const groundSpawn = (x: number, z: number, zone: string): EnemySpawn => ({
    pos: vec3(x, 0, z),
    zone,
    type: 'ground'
  });
  const airSpawn = (x: number, y: number, z: number, zone: string): EnemySpawn => ({
    pos: vec3(x, y, z),
    zone,
    type: 'air'
  });
  const enemySpawns: EnemySpawn[] = [
    groundSpawn(-19, -1.4, 'yard'),
    groundSpawn(3.5, -1.6, 'yard'),
    groundSpawn(14.2, 16.4, 'yard'),
    groundSpawn(-3.2, 16.6, 'yard'),
    groundSpawn(-16, 26, 'yard'),
    groundSpawn(6, 26, 'yard'),
    groundSpawn(4.2, -5.12, 'yard'),
    groundSpawn(-7.8, 21.4, 'yard'),
    groundSpawn(-11.3, 12.5, 'yard'),
    groundSpawn(17.5, 22.2, 'yard'),
    airSpawn(10, 11, 23.5, 'yard'),
    airSpawn(2, 11, 21.5, 'yard'),
    airSpawn(13, 9, 11, 'yard'),
    airSpawn(-4, 12.5, -4.5, 'yard'),
    airSpawn(9, 10, 1.5, 'yard'),
    airSpawn(-10, 12, 24.5, 'yard'),
    groundSpawn(-12.4, -24.8, 'shed'),
    groundSpawn(9.6, -25.3, 'shed'),
    groundSpawn(-13.4, -19.6, 'shed'),
    groundSpawn(4.6, -13.8, 'shed'),
    groundSpawn(-21, -27.2, 'shed'),
    groundSpawn(-18.6, -22, 'shed'),
    groundSpawn(13.6, -24, 'shed'),
    groundSpawn(-26.6, -15, 'shed'),
    airSpawn(-8, 5.4, -20.5, 'shed'),
    airSpawn(5, 5.2, -18, 'shed'),
    airSpawn(-20, 10.5, -20, 'shed'),
    airSpawn(14.5, 10, -22, 'shed'),
    airSpawn(-2, 12.5, -8.5, 'shed'),
    groundSpawn(27.7, -24.2, 'quay'),
    groundSpawn(18.3, -25.4, 'quay'),
    groundSpawn(27.2, -12.6, 'quay'),
    groundSpawn(20.2, 14, 'quay'),
    groundSpawn(23.4, 23.2, 'quay'),
    groundSpawn(18, 24.4, 'quay'),
    groundSpawn(27.4, 11.6, 'quay'),
    airSpawn(36, 9, 4, 'quay'),
    airSpawn(38, 11, -6, 'quay'),
    airSpawn(35, 8.5, 16, 'quay'),
    airSpawn(24, 12.5, 10.5, 'quay'),
    airSpawn(33.5, 10, 24.5, 'quay'),
    airSpawn(22, 13, -14, 'quay')
  ];
  const zones: LevelZone[] = [
    {
      name: 'gate',
      min: [-40, -30],
      max: [-24, 30]
    },
    {
      name: 'yard',
      min: [-24, -10],
      max: [16, 30]
    },
    {
      name: 'shed',
      min: [-24, -30],
      max: [16, -10]
    },
    {
      name: 'quay',
      min: [16, -30],
      max: [40, 30]
    }
  ];
  const interiorBoxes: InteriorBox[] = [
    {
      min: vec3(SHED.X0, 0, SHED.Z0),
      max: vec3(SHED.X1, SHED.RIDGE, SHED.Z1)
    }
  ];
  const cinematicPath: CinematicShot[] = [
    {
      pos: [-34, 1.6, 6.2],
      look: [-12, 2.6, 6.6]
    },
    {
      pos: [-20, 1.3, 5.6],
      look: [0, 2.2, 7]
    },
    {
      pos: [-6.2, 2.1, 7.9],
      look: [2, 1.6, 7.6]
    },
    {
      pos: [-6.6, 2.5, 0.4],
      look: [-4, 2.6, -12]
    },
    {
      pos: [-4.4, 1.9, -8.6],
      look: [-2.4, 2.8, -19.5]
    },
    {
      pos: [-3.2, 2.2, -15],
      look: [-2, 2.2, -20.5]
    },
    {
      pos: [4.2, 2.6, -19.6],
      look: [12, 3.2, -19.5]
    },
    {
      pos: [15, 2, -19.5],
      look: [24, 3.5, -6]
    },
    {
      pos: [20.2, 1.7, -9],
      look: [23, 1.6, 0]
    },
    {
      pos: [25.9, 1.8, 1.5],
      look: [27.5, 1.2, 12]
    },
    {
      pos: [27.3, 1.8, 12],
      look: [29.6, 0.4, 20]
    },
    {
      pos: [28.4, 1.9, 17.2],
      look: [31.5, -0.8, 21]
    }
  ];
  const coverPoints: THREE.Vector3[] = [
    vec3(-33.9, 0, 3.8),
    vec3(-27.3, 0, 2.3),
    vec3(-19.2, 0, 4.7),
    vec3(-17.4, 0, 4.9),
    vec3(-12.5, 0, 7.2),
    vec3(-9.3, 0, 6.4),
    vec3(-6.3, 0, 7.3),
    vec3(-2.9, 0, 6.1),
    vec3(-2.9, 0, 4.5),
    vec3(5.6, 0, 5.8),
    vec3(5.6, 0, 4.2),
    vec3(-2.2, 0, 10.4),
    vec3(5, 0, 8.9),
    vec3(-4.8, 0, 10.6),
    vec3(7.5, 0, 7.7),
    vec3(9.2, 0, 4.4),
    vec3(-1, 0, 13.6),
    vec3(-13.5, 0, -1.5),
    vec3(-9.6, 0, -0.7),
    vec3(7.8, 0, -1.5),
    vec3(-4.2, 0, -2.2),
    vec3(-0.9, 0, -6.7),
    vec3(-6.7, 0, -7),
    vec3(1.2, 0, -8.9),
    vec3(-8.1, 0, 15.4),
    vec3(0.6, 0, 16.9),
    vec3(4.2, 0, 15.7),
    vec3(-16, 0, 15.6),
    vec3(12, 0, 17.2),
    vec3(2.9, 0, -17),
    vec3(4.2, 0, -15.3),
    vec3(6.9, 0, -20.6),
    vec3(-7.6, 0, -17.4),
    vec3(-8.3, 0, -14.3),
    vec3(9.6, 0, -21.9),
    vec3(-13.2, 0, -14.4),
    vec3(-11.6, 0, -18.6),
    vec3(0, 0, -25.8),
    vec3(-12.4, 0, -25.8),
    vec3(21.4, 0, -4.7),
    vec3(25.3, 0, 3.9),
    vec3(25.7, 0, -4.4),
    vec3(20.2, 0, -15.4),
    vec3(26.4, 0, -15.4),
    vec3(20.6, 0, 14.4),
    vec3(26.8, 0, 14.4),
    vec3(20.6, 0, 21.2),
    vec3(27.4, 0, 22.4),
    vec3(19.6, 0, -21.4),
    vec3(27, 0, -16.2),
    vec3(25.6, 0, 6),
    vec3(13.5, 2.59, 12.4),
    vec3(4.4, 2.59, 12.4),
    vec3(12.9, 0, 8.8),
    vec3(11.6, 0, 4.9)
  ];
  const nav = game.physics.nav;
  /** Nudges a ground-level point onto the nearest walkable cell (rings of 0.5..2 m). */
  const snapToWalkable = (point: THREE.Vector3): void => {
    if (!nav || !nav.isWalkable || point.y > 0.2 || nav.isWalkable(point.x, point.z)) return;
    for (const radius of [0.5, 1, 1.5, 2])
      for (let step = 0; step < 8; step++) {
        const x = point.x + Math.cos(step * 0.7854) * radius;
        const z = point.z + Math.sin(step * 0.7854) * radius;
        if (nav.isWalkable(x, z)) {
          point.x = x;
          point.z = z;
          return;
        }
      }
  };
  coverPoints.forEach(snapToWalkable);
  enemySpawns.forEach((spawn) => {
    if (spawn.type === 'ground') snapToWalkable(spawn.pos);
  });
  let updateErrorLogged = false;
  return {
    root,
    playerStart,
    objectives,
    extraction: {
      pos: quay.extraction.clone(),
      radius: 2.5
    },
    enemySpawns,
    zones,
    interiorBoxes,
    cinematicPath,
    coverPoints,
    skylights: shed.skylights,
    shedLights: shed.lights,
    vantage: {
      stairsFoot: vec3(-2.2, 0, 12.4),
      roof: vec3(13.5, 2.59, 12.4)
    },
    stats: {
      labelsAtlased: labelAtlas.count,
      containers: kit.placed.filter((prop) => prop.name.startsWith('container')).length,
      props: kit.placed.length,
      tris: Math.round(triangleCount),
      meshes: merged.children.length + countMeshes(kit.dynRoot)
    },
    placed: kit.placed,
    explosives: kit.explosives,
    groundSurfaceAt(x, z) {
      return kit.isMetal(x, z) ? 'metal' : 'concrete';
    },
    update(dt) {
      shed.update(dt);
      labelAtlas.update(dt);
      for (let index = 0; index < kit.updaters.length; index++)
        try {
          kit.updaters[index](dt);
        } catch (error) {
          if (!updateErrorLogged) {
            updateErrorLogged = true;
            console.error('[level] prop update threw', error);
          }
        }
    }
  };
}

/** True if `object` or an ancestor below `stopAt` is flagged `noMerge`. */
function hasNoMergeAncestor(object: THREE.Object3D | null, stopAt: THREE.Object3D): boolean {
  while (object && object !== stopAt) {
    if (object.userData && object.userData.noMerge) return true;
    object = object.parent;
  }
  return false;
}

function countMeshes(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) count++;
  });
  return count;
}

/** Debug showcase (`?show=level`): camera placement plus a per-frame update. */
export interface LevelShowcase {
  cam: Vec3Tuple;
  target: Vec3Tuple;
  update(dt: number): void;
}

export async function levelShowcase(game: Game): Promise<LevelShowcase> {
  const level = await createLevel(game);
  return {
    cam: [-32, 1.7, 6],
    target: [0, 2.4, 6.4],
    update: (dt) => level.update(dt)
  };
}

export { createLevel as create, levelShowcase as showcase };
