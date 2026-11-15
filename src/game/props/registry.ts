// Prop registry: nominal sizes / materials of every placeable prop, the table of
// registered prop builders, and the factory (`game.props`) that builds props by name
// (falling back to a plain box when no builder exists or a builder throws).
import { Group } from 'three';
import type { Object3D } from 'three';
import type { Game } from '../core/types';
import { shadowedMesh, worldUvBox } from '../render/geometry';

/** `[width, height, depth, materialName, surfaceName]` of a prop's bounding box. */
export type PropSizeSpec = [number, number, number, string, string];

/** Options passed to a prop builder; keys besides `seed` are builder specific. */
export interface PropOptions {
  seed?: number;
  [key: string]: unknown;
}

/** A function that builds one prop; returning a falsy value falls back to the default box. */
export type PropBuilderFn<O extends object = PropOptions> = (
  game: Game,
  options: O
) => Object3D | null | undefined;

/** Signature of {@link registerProp} (handed to the `register*Props` modules). */
export type RegisterPropFn = typeof registerProp;

/** Nominal bounding box, material and surface of every prop. */
export const PROP_SIZES: Record<string, PropSizeSpec> = {
  container20: [6.06, 2.59, 2.44, 'paint_red', 'metal'],
  container40: [12.19, 2.59, 2.44, 'paint_blue', 'metal'],
  container40hc: [12.19, 2.9, 2.44, 'paint_green', 'metal'],
  jersey_barrier: [3, 0.81, 0.6, 'concrete', 'concrete'],
  light_mast: [0.5, 14, 0.5, 'steel_galv', 'metal'],
  fence_panel: [3, 2.4, 0.08, 'chainlink', 'metal'],
  guard_booth: [2.6, 2.7, 2.2, 'paint_white', 'metal'],
  gate_arm: [5, 1.1, 0.3, 'hazard_stripes', 'metal'],
  bollard_mooring: [0.7, 0.6, 0.7, 'steel_dark', 'metal'],
  bollard_post: [0.17, 1, 0.17, 'paint_yellow', 'metal'],
  relay_node: [1.2, 2.4, 0.8, 'paint_grey', 'metal'],
  shelf_rack: [2.7, 4.2, 1.1, 'paint_orange', 'metal'],
  stairs_metal: [3, 2.6, 1, 'diamond_plate', 'metal'],
  catwalk: [3, 1.1, 1.2, 'diamond_plate', 'metal'],
  reefer_unit: [0.5, 2.3, 2.3, 'paint_white', 'metal'],
  barrel: [0.6, 0.9, 0.6, 'paint_blue', 'metal'],
  pallet: [1.2, 0.144, 1, 'wood_pallet', 'wood'],
  pallet_stack: [1.2, 1.15, 1, 'wood_pallet', 'wood'],
  crate_wood: [1.1, 1, 0.9, 'wood_pallet', 'wood'],
  crate_stack: [1.2, 1.9, 1, 'wood_pallet', 'wood'],
  ibc_tote: [1.2, 1.16, 1, 'plastic_grey', 'metal'],
  forklift: [3.4, 2.2, 1.25, 'paint_yellow', 'metal'],
  cable_reel: [1.3, 1.3, 0.8, 'wood_dark', 'wood'],
  tire_stack: [0.8, 1, 0.8, 'tire', 'rubber'],
  dumpster: [1.9, 1.35, 1.1, 'paint_green', 'metal'],
  generator: [2.2, 1.4, 1, 'paint_yellow', 'metal'],
  jerry_can: [0.35, 0.47, 0.17, 'paint_green', 'metal'],
  traffic_cone: [0.36, 0.7, 0.36, 'plastic_red', 'rubber'],
  gas_cylinders: [0.9, 1.6, 0.5, 'steel_dark', 'metal'],
  tarp_cargo: [2.4, 1.5, 1.4, 'tarp', 'dirt'],
  sandbags: [2, 0.9, 0.6, 'tarp', 'dirt'],
  toolbox_cart: [0.9, 0.95, 0.5, 'plastic_red', 'metal'],
  floodlight_stand: [1, 2.2, 1, 'paint_yellow', 'metal'],
  cardboard_boxes: [1, 0.8, 0.8, 'cardboard', 'wood'],
  pipe_stack: [6, 0.9, 1.2, 'steel_rust', 'metal'],
  sign_post: [0.6, 2.4, 0.08, 'paint_white', 'metal']
};
const propBuilders: Record<string, PropBuilderFn> = {};

/** Register (or replace) the builder for a prop name. */
export function registerProp<O extends object = PropOptions>(
  name: string,
  builder: PropBuilderFn<O>
): void {
  // Builders declare their own option shapes; the factory passes whatever options it gets.
  propBuilders[name] = builder as unknown as PropBuilderFn;
}

/** The prop factory stored as `game.props`. */
export interface PropFactory {
  names(): string[];
  has(name: string): boolean;
  /** Build a prop by name; sets `userData.prop` (and size / colliders for fallback boxes). */
  build(name: string, options?: PropOptions): Object3D;
}

/** Create the prop factory for a game. */
export function createPropFactory(game: Game): PropFactory {
  return {
    names: () => Object.keys(PROP_SIZES),
    has: (name) => !!PROP_SIZES[name],
    build(name, options = {}) {
      if (propBuilders[name]) {
        try {
          const prop = propBuilders[name](game, options);
          if (prop) {
            prop.userData.prop = name;
            return prop;
          }
        } catch (error) {
          console.error(`[props] builder "${name}" threw`, error);
        }
      }
      const size = PROP_SIZES[name] || [1, 1, 1, 'concrete', 'concrete'];
      if (!PROP_SIZES[name]) console.warn(`[props] unknown prop "${name}"`);
      const group = new Group();
      group.add(
        shadowedMesh(worldUvBox(size[0], size[1], size[2], 'bottom'), game.mats.get(size[3]))
      );
      group.userData.colliders = [
        {
          min: [-size[0] / 2, 0, -size[2] / 2],
          max: [size[0] / 2, size[1], size[2] / 2],
          surface: size[4]
        }
      ];
      group.userData.size = [size[0], size[1], size[2]];
      group.userData.prop = name;
      return group;
    }
  };
}

/** Debug showcase: lays out every prop (or `?names=a,b`) in rows and returns a camera view. */
export function showcaseProps(game: Game): {
  cam: [number, number, number];
  target: [number, number, number];
} {
  const names = game.params.names ? game.params.names.split(',') : Object.keys(PROP_SIZES);
  let cursorX = 0;
  let cursorZ = 0;
  let rowDepth = 0;
  let maxX = 0;
  for (const name of names) {
    const prop = game.props.build(name, {
      seed: 7,
      doors: name.startsWith('container') ? 0.6 : 0
    });
    const size: ArrayLike<number> = prop.userData.size || PROP_SIZES[name] || [1, 1, 1];
    if (cursorX + size[0] > 26) {
      cursorX = 0;
      cursorZ += rowDepth + 1.5;
      rowDepth = 0;
    }
    prop.position.set(cursorX + size[0] / 2, 0, cursorZ);
    game.scene.add(prop);
    cursorX += size[0] + 1;
    rowDepth = Math.max(rowDepth, size[2]);
    maxX = Math.max(maxX, cursorX);
  }
  const centerX = Math.min(maxX, 26) / 2;
  return {
    cam: [centerX - 4, 2.2, cursorZ + rowDepth + 6],
    target: [centerX, 1, cursorZ / 2]
  };
}
export { createPropFactory as create, registerProp as register, showcaseProps as showcase };
