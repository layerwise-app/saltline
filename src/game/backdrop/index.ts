// Harbour backdrop subsystem: assembles the quay crane, the moored container ship, the
// small moored boat, the distant skyline and the gull flock, registers their colliders with
// physics and animates them (spreader sway, radar spin, boat bobbing, blinking lights).
import { Group, Object3D, Vector3 } from 'three';
import type { Mesh } from 'three';
import type { Game } from '../core/types';
import {
  MaterialBatcher,
  createBlinkLightBatch,
  polylineRods,
  sagCurvePoints,
  v3
} from './geometry';
import type { BackdropCollider } from './geometry';
import { buildQuayCrane } from './cranes';
import type { QuayCrane } from './cranes';
import { buildContainerShip, buildMooredBoat } from './ships';
import type { ContainerShip, MooredBoat } from './ships';
import { buildSkyline, createGulls } from './skyline';
import type { Skyline } from './skyline';

/** Backdrop pieces that `?show=backdrop&bshow=<part>` can isolate. */
type BackdropPart = 'crane' | 'ship' | 'boat' | 'sky';

const BACKDROP_PARTS = ['crane', 'ship', 'boat', 'sky'];

type PhysicsBox = ReturnType<Game['physics']['addBox']>;

/** The built backdrop, stored as `game.backdrop`. */
export interface Backdrop {
  /** Set on the no-op stand-in installed when the backdrop fails to boot. */
  stub?: boolean;
  /** Advances the backdrop animation by `dt` seconds. */
  update(dt: number): void;
  root: Group;
  /** The moored boat's root (an empty placeholder when the boat was not built). */
  boat: Object3D;
  crane: Group | null;
  ship: Group | null;
  skyline: Group | null;
  gulls: Mesh | null;
  lamps: Mesh | null;
  colliders: PhysicsBox[];
  spreader: Group | null;
  /** Rest position of the boat (it bobs around this). */
  boatBase: Vector3;
  extractionPoint: Vector3;
  shipName: string;
  craneId: string;
  stats: {
    tris: number;
    drawCalls: number;
  };
}

interface BuildBackdropOptions {
  /** Build only this part (showcase), or everything when null. */
  only?: string | null;
  /** Showcase mode: boat raised onto the quay, no mooring lines or boat collider, no bobbing. */
  showcase?: boolean;
}

function buildBackdrop(
  game: Game,
  { only = null, showcase = false }: BuildBackdropOptions = {}
): Backdrop {
  const wants = (part: BackdropPart) => !only || only === part;
  const root = new Group();
  root.name = 'backdrop';
  const blinkLights = createBlinkLightBatch();
  const boatBase = new Vector3(31.5, -1.6, 21);
  if (showcase) {
    boatBase.set(24, 0.34, 15);
  }
  let boat: MooredBoat | null = null;
  let crane: QuayCrane | null = null;
  let ship: ContainerShip | null = null;
  let skyline: Skyline | null = null;
  let gulls: Mesh | null = null;
  if (wants('boat')) {
    boat = buildMooredBoat(game, blinkLights);
    boat.root.position.copy(boatBase);
    boat.root.rotation.y = -Math.PI / 2;
    root.add(boat.root);
  }
  if (boat && !showcase) {
    // Mooring lines from the boat up to the quay bollards.
    const lineBatcher = new MaterialBatcher();
    const rope = game.mats.get('rope');
    lineBatcher.add(
      rope,
      polylineRods(sagCurvePoints(v3(3.2, 0.95, 0.05), v3(4.6, 2.12, 2.3), 0.22, 7), 0.016, 5)
    );
    lineBatcher.add(
      rope,
      polylineRods(sagCurvePoints(v3(-3.25, 0.82, 0.95), v3(-4.6, 2.12, 2.3), 0.2, 7), 0.016, 5)
    );
    boat.root.add(
      lineBatcher.build({
        cast: false,
        recv: false
      })
    );
  }
  if (wants('crane')) {
    crane = buildQuayCrane(game, blinkLights);
    root.add(crane.root);
  }
  if (wants('ship')) {
    ship = buildContainerShip(game, blinkLights);
    root.add(ship.root);
  }
  if (wants('sky')) {
    skyline = buildSkyline(game, blinkLights);
    root.add(skyline.root);
  }
  if (wants('sky') || wants('crane')) {
    gulls = createGulls(game, blinkLights.uTime, 12);
    root.add(gulls);
  }
  const lamps = blinkLights.build();
  if (lamps) {
    lamps.name = 'backdrop-lamps';
    lamps.frustumCulled = false;
    root.add(lamps);
  }
  game.scene.add(root);

  const colliders: PhysicsBox[] = [];
  const addCollider = (box: BackdropCollider, surface: string) => {
    if (game.physics && game.physics.addBox) {
      colliders.push(
        game.physics.addBox(box.min, box.max, {
          surface,
          tag: 'backdrop',
          noNav: !!box.noNav
        })
      );
    }
  };
  if (crane) for (const box of crane.colliders) addCollider(box, 'metal');
  if (ship) for (const box of ship.colliders) addCollider(box, 'metal');
  if (boat && !showcase) {
    addCollider(
      {
        min: [30.25, -1.7, 17.4],
        max: [32.8, -0.7, 24.6]
      },
      'rubber'
    );
  }

  let tris = 0;
  let drawCalls = 0;
  root.traverse((object) => {
    if ((object as Mesh).isMesh) {
      drawCalls++;
      const geometry = (object as Mesh).geometry;
      tris += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
    }
  });

  let time = 0;
  function update(dt: number): void {
    time += dt;
    blinkLights.uTime.value = time;
    if (crane) {
      const spreader = crane.spreader;
      spreader.rotation.x = 0.012 * Math.sin(time * 0.52) + 0.004 * Math.sin(time * 1.31 + 1);
      spreader.rotation.z = 0.009 * Math.sin(time * 0.41 + 1.1);
    }
    if (ship) {
      ship.radar.rotation.y = time * 1.9;
    }
    if (boat) {
      boat.root.position.y =
        boatBase.y +
        (showcase ? 0 : 0.05 * Math.sin(time * 1.15) + 0.025 * Math.sin(time * 2.3 + 1.3));
      boat.hullGrp.rotation.x = 0.05 * Math.sin(time * 0.9 + 0.4) + 0.016 * Math.sin(time * 2.1);
      boat.hullGrp.rotation.z = 0.02 * Math.sin(time * 1.3 + 2);
    }
  }
  update(0);
  return {
    update,
    root,
    boat: boat ? boat.root : new Object3D(),
    crane: crane ? crane.root : null,
    ship: ship ? ship.root : null,
    skyline: skyline ? skyline.root : null,
    gulls,
    lamps,
    colliders,
    spreader: crane ? crane.spreader : null,
    boatBase,
    extractionPoint: new Vector3(30, 0, 20),
    shipName: 'KITTIWAKE',
    craneId: 'SALTLINE 04',
    stats: {
      tris: Math.round(tris),
      drawCalls
    }
  };
}

/** Subsystem factory: builds the full backdrop into `game.scene`. */
export async function createBackdrop(game: Game): Promise<Backdrop> {
  return buildBackdrop(game, {});
}

/** Camera placement and per-frame update returned by a showcase. */
export interface BackdropShowcase {
  cam: number[];
  target: number[];
  update: (dt: number) => void;
}

/** Debug showcase (`?show=backdrop`, optionally `&bshow=crane|ship|boat|sky`). */
export function backdropShowcase(game: Game): BackdropShowcase {
  const part =
    game.params && BACKDROP_PARTS.includes(game.params.bshow as string)
      ? (game.params.bshow as string)
      : null;
  const backdrop = buildBackdrop(game, {
    only: part,
    showcase: true
  });
  console.log('[backdrop] ' + JSON.stringify(backdrop.stats));
  const views: Record<string, { cam: number[]; target: number[] }> = {
    crane: {
      cam: [0, 1.7, 27],
      target: [33, 13, 0]
    },
    ship: {
      cam: [24, 1.7, -2],
      target: [38, 9, -24]
    },
    boat: {
      cam: [19.5, 1.7, 11.5],
      target: [24, 0.9, 15]
    },
    sky: {
      cam: [-32, 1.7, 6],
      target: [30, 9, 0]
    }
  };
  return {
    ...(views[part as string] || views.crane),
    update: (dt) => backdrop.update(dt)
  };
}
export { createBackdrop as create, backdropShowcase as showcase };
