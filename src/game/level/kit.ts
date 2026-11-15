/**
 * Level construction kit: a bag of helpers (boxes, slabs, cylinders, tubes,
 * decals, labels, colliders, prop placement, container stacks) shared by all
 * level-building modules, plus the label texture atlas packer that merges
 * the many small label materials into one draw-call-friendly material.
 */
import * as THREE from 'three';
import {
  Box3,
  CanvasTexture,
  Group,
  LinearMipmapLinearFilter,
  MathUtils,
  Mesh,
  PlaneGeometry,
  Vector3
} from 'three';
import type { Game } from '../core/types';
import {
  roundedBox,
  shadowedMesh,
  tubeThroughPoints,
  worldUvBox,
  worldUvCylinder
} from '../render/geometry';

/** A material instance, or the name of a material in the game's material library. */
export type MaterialRef = string | THREE.Material;

/** A 3-component point, given as a plain array. */
export type Vec3Tuple = [number, number, number];

/** Rectangle `[x0, z0, x1, z1]` on the ground plane. */
export type Rect2 = [number, number, number, number];

/** Which way a flat quad faces. */
export type QuadFacing = 'z+' | 'z-' | 'x+' | 'x-' | 'y+';

export type Axis = 'x' | 'y' | 'z';

/** Options accepted by every mesh-adding helper. */
export interface MeshOpts {
  cast?: boolean;
  recv?: boolean;
  /** Position. */
  p?: number[];
  /** Euler rotation (missing components default to 0). */
  r?: number[];
  /** Parent object (defaults to the static root). */
  parent?: THREE.Object3D;
}

export interface BoxOpts extends MeshOpts {
  /** Corner bevel radius; uses a rounded box when set. */
  bevel?: number;
}

export interface CylOpts extends MeshOpts {
  rTop?: number;
  seg?: number;
  open?: boolean;
  /** Lay the cylinder along this axis (overrides `r`). */
  axis?: Axis;
}

export interface TubeOpts extends MeshOpts {
  radial?: number;
  tension?: number;
}

export interface RodOpts extends MeshOpts {
  seg?: number;
}

export interface IBeamOpts {
  depth?: number;
  width?: number;
  /** Flange thickness. */
  tf?: number;
  /** Web thickness. */
  tw?: number;
  depthAxis?: Axis | null;
  r?: number[] | null;
}

/** Options passed to `physics.addBox` (surface type, player-only, no-nav ...). */
export type ColliderOpts = Record<string, unknown>;

/** Prop build options handed to the prop factory (`seed`, `color`, ...). */
export type PropOpts = Record<string, unknown>;

/** Options controlling how a prop is placed in the level. */
export interface PlaceOpts {
  /** Never turn this prop into an explosive. */
  inert?: boolean;
  /** Attach to the dynamic (non-merged) root. */
  dynamic?: boolean;
  /** Skip collider generation. */
  noCol?: boolean;
  colOpts?: ColliderOpts;
}

/** Axis-aligned collider in a prop's local space (`userData.colliders`). */
export interface PropCollider {
  min: number[];
  max: number[];
  surface?: string;
}

/** Record of a placed prop. */
export interface PlacedProp {
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** An explosive prop deferred to the explosives system. */
export interface ExplosiveSpawn extends PlacedProp {
  opts: PropOpts;
}

export type ContainerSize = 20 | 40 | 'hc';

export interface ContainerOpts {
  dx?: number;
  dz?: number;
  flip?: boolean;
  wear?: number;
  doors?: number;
  reefer?: boolean;
}

/** One container in a stack: `[size, color, opts?]`. */
export type ContainerSpec = [ContainerSize, string, ContainerOpts?];

export interface ContainerStack {
  /** Height of the top of the stack. */
  top: number;
  objs: THREE.Object3D[];
}

/** The level construction kit returned by {@link createLevelKit}. */
export interface LevelKit {
  G: Game;
  THREE: typeof THREE;
  staticRoot: THREE.Group;
  dynRoot: THREE.Group;
  /** Ground rectangles that sound like metal underfoot (container roofs, stairs, catwalks). */
  metalRects: Rect2[];
  updaters: Array<(dt: number) => void>;
  placed: PlacedProp[];
  explosives: ExplosiveSpawn[];
  rng: () => number;
  rnd(min: number, max: number): number;
  M(name: string, opts?: Record<string, unknown>): THREE.Material;
  MI(name: string, opts?: Record<string, unknown>): THREE.Material;
  add(geometry: THREE.BufferGeometry, material: MaterialRef, opts?: MeshOpts): THREE.Mesh;
  box(
    material: MaterialRef,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    opts?: BoxOpts
  ): THREE.Mesh;
  slab(
    material: MaterialRef,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    opts?: BoxOpts
  ): THREE.Mesh;
  cyl(
    material: MaterialRef,
    radius: number,
    height: number,
    x: number,
    y: number,
    z: number,
    opts?: CylOpts
  ): THREE.Mesh;
  tube(material: MaterialRef, points: number[][], radius?: number, opts?: TubeOpts): THREE.Mesh;
  rod(
    material: MaterialRef,
    from: number[],
    to: number[],
    radius?: number,
    opts?: RodOpts
  ): THREE.Mesh;
  ibeam(
    material: MaterialRef,
    axis: Axis,
    length: number,
    x: number,
    y: number,
    z: number,
    opts?: IBeamOpts
  ): THREE.Group;
  quad(
    material: THREE.Material,
    w: number,
    h: number,
    x: number,
    y: number,
    z: number,
    facing?: QuadFacing,
    spin?: number
  ): THREE.Mesh;
  decal(
    name: string,
    width: number,
    x: number,
    y: number,
    z: number,
    facing?: QuadFacing,
    spin?: number
  ): THREE.Mesh | null;
  label(
    text: string,
    height: number,
    x: number,
    y: number,
    z: number,
    facing?: QuadFacing,
    opts?: Record<string, unknown>
  ): THREE.Mesh | null;
  col(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    surface?: string,
    opts?: ColliderOpts
  ): unknown;
  place(
    name: string,
    x: number,
    z: number,
    yaw?: number,
    propOpts?: PropOpts,
    y?: number,
    placeOpts?: PlaceOpts
  ): THREE.Object3D;
  stairs(x: number, z: number, yaw?: number, y?: number, opts?: PropOpts): THREE.Object3D;
  catwalk(
    x: number,
    z: number,
    yaw?: number,
    y?: number,
    opts?: PropOpts,
    rails?: [boolean, boolean]
  ): THREE.Object3D;
  stack(
    x: number,
    z: number,
    specs: ContainerSpec[],
    yaw?: number,
    jitter?: number
  ): ContainerStack;
  isMetal(x: number, z: number): boolean;
}

const NO_COLLIDER_PROPS = new Set(['traffic_cone', 'jerry_can']);

type ContainerKind = 'container20' | 'container40' | 'container40hc';

const CONTAINER_KIND: Record<ContainerSize, ContainerKind> = {
  20: 'container20',
  40: 'container40',
  hc: 'container40hc'
};
const CONTAINER_HEIGHT: Record<ContainerKind, number> = {
  container20: 2.59,
  container40: 2.59,
  container40hc: 2.9
};
const CONTAINER_LENGTH: Record<ContainerKind, number> = {
  container20: 6.06,
  container40: 12.19,
  container40hc: 12.19
};

/** Creates the construction kit used by every level-building function. */
export function createLevelKit(game: Game): LevelKit {
  const staticRoot = new Group();
  staticRoot.name = 'level-static';
  const dynRoot = new Group();
  dynRoot.name = 'level-dynamic';
  const metalRects: Rect2[] = [];
  const updaters: Array<(dt: number) => void> = [];
  const placed: PlacedProp[] = [];
  const explosives: ExplosiveSpawn[] = [];
  const rng: () => number = game.rng && game.rng.fork ? game.rng.fork() : Math.random;
  const rnd = (min: number, max: number): number => min + (max - min) * rng();
  const mat = (name: string, opts?: Record<string, unknown>): THREE.Material =>
    game.mats.get(name, opts);
  const matInterior = (name: string, opts?: Record<string, unknown>): THREE.Material =>
    game.mats.get(name, {
      interior: true,
      ...(opts || {})
    });
  const resolveMat = (material: MaterialRef): THREE.Material =>
    typeof material == 'string' ? mat(material) : material;

  function add(
    geometry: THREE.BufferGeometry,
    material: MaterialRef,
    opts: MeshOpts = {}
  ): THREE.Mesh {
    const mesh: THREE.Mesh = shadowedMesh(geometry, resolveMat(material), {
      cast: opts.cast !== false,
      recv: opts.recv !== false
    });
    if (opts.p) mesh.position.set(opts.p[0], opts.p[1], opts.p[2]);
    if (opts.r) mesh.rotation.set(opts.r[0] || 0, opts.r[1] || 0, opts.r[2] || 0);
    (opts.parent || staticRoot).add(mesh);
    return mesh;
  }

  function box(
    material: MaterialRef,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    opts: BoxOpts = {}
  ): THREE.Mesh {
    const geometry: THREE.BufferGeometry = opts.bevel
      ? roundedBox(w, h, d, opts.bevel)
      : worldUvBox(w, h, d);
    return add(geometry, material, {
      ...opts,
      p: [x, y, z]
    });
  }

  function slab(
    material: MaterialRef,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    opts: BoxOpts = {}
  ): THREE.Mesh {
    return box(
      material,
      Math.abs(x1 - x0),
      Math.abs(y1 - y0),
      Math.abs(z1 - z0),
      (x0 + x1) / 2,
      (y0 + y1) / 2,
      (z0 + z1) / 2,
      opts
    );
  }

  function cyl(
    material: MaterialRef,
    radius: number,
    height: number,
    x: number,
    y: number,
    z: number,
    opts: CylOpts = {}
  ): THREE.Mesh {
    const geometry: THREE.BufferGeometry = worldUvCylinder(
      opts.rTop ?? radius,
      radius,
      height,
      opts.seg || 12,
      !!opts.open
    );
    let rotation: number[];
    if (opts.axis === 'x') rotation = [0, 0, Math.PI / 2];
    else if (opts.axis === 'z') rotation = [Math.PI / 2, 0, 0];
    else rotation = opts.r || [0, 0, 0];
    return add(geometry, material, {
      ...opts,
      p: [x, y, z],
      r: rotation
    });
  }

  function tube(
    material: MaterialRef,
    points: number[][],
    radius = 0.03,
    opts: TubeOpts = {}
  ): THREE.Mesh {
    return add(
      tubeThroughPoints(points, radius, opts.radial || 6, false, opts.tension ?? 0.5),
      material,
      opts
    );
  }

  function rod(
    material: MaterialRef,
    from: number[],
    to: number[],
    radius = 0.015,
    opts: RodOpts = {}
  ): THREE.Mesh {
    const start = new Vector3(...from);
    const end = new Vector3(...to);
    const length = start.distanceTo(end);
    const geometry: THREE.BufferGeometry = worldUvCylinder(radius, radius, length, opts.seg || 6);
    const mesh = add(geometry, material, opts);
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), end.sub(start).normalize());
    return mesh;
  }

  function ibeam(
    material: MaterialRef,
    axis: Axis,
    length: number,
    x: number,
    y: number,
    z: number,
    {
      depth = 0.4,
      width = 0.2,
      tf: flangeThickness = 0.02,
      tw: webThickness = 0.012,
      depthAxis = null,
      r: rotation = null
    }: IBeamOpts = {}
  ): THREE.Group {
    const group = new Group();
    group.position.set(x, y, z);
    if (rotation) group.rotation.set(rotation[0] || 0, rotation[1] || 0, rotation[2] || 0);
    const heightAxis: Axis = depthAxis || (axis === 'y' ? 'z' : 'y');
    const widthAxis = (['x', 'y', 'z'] as Axis[]).find(
      (candidate) => candidate !== axis && candidate !== heightAxis
    )!;
    /** Box size with the given extent along the beam, depth and width axes. */
    const dims = (along: number, alongDepth: number, alongWidth: number): Vec3Tuple => {
      const size: Partial<Record<Axis, number>> = {};
      size[axis] = along;
      size[heightAxis] = alongDepth;
      size[widthAxis] = alongWidth;
      return [size.x!, size.y!, size.z!];
    };
    /** Offset along the depth axis only. */
    const depthOffset = (offset: number): number[] => {
      const position = {
        x: 0,
        y: 0,
        z: 0
      };
      position[heightAxis] = offset;
      return [position.x, position.y, position.z];
    };
    const resolved = resolveMat(material);
    for (const side of [-1, 1])
      add(worldUvBox(...dims(length, flangeThickness, width)), resolved, {
        parent: group,
        p: depthOffset(side * (depth / 2 - flangeThickness / 2))
      });
    add(worldUvBox(...dims(length, depth - 2 * flangeThickness, webThickness)), resolved, {
      parent: group
    });
    staticRoot.add(group);
    return group;
  }

  function quad(
    material: THREE.Material,
    w: number,
    h: number,
    x: number,
    y: number,
    z: number,
    facing: QuadFacing = 'z+',
    spin = 0
  ): THREE.Mesh {
    const geometry = new PlaneGeometry(w, h);
    const mesh = new Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.position.set(x, y, z);
    if (facing === 'z-') mesh.rotation.y = Math.PI;
    else if (facing === 'x+') mesh.rotation.y = Math.PI / 2;
    else if (facing === 'x-') mesh.rotation.y = -Math.PI / 2;
    else if (facing === 'y+') {
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = spin;
    }
    staticRoot.add(mesh);
    return mesh;
  }

  function decal(
    name: string,
    width: number,
    x: number,
    y: number,
    z: number,
    facing?: QuadFacing,
    spin?: number
  ): THREE.Mesh | null {
    try {
      const decalInfo: { material?: THREE.Material; aspect?: number } | null | undefined =
        game.mats.decal(name);
      return !decalInfo || !decalInfo.material
        ? null
        : quad(decalInfo.material, width, width / (decalInfo.aspect || 1), x, y, z, facing, spin);
    } catch {
      return null;
    }
  }

  function label(
    text: string,
    height: number,
    x: number,
    y: number,
    z: number,
    facing?: QuadFacing,
    opts?: Record<string, unknown>
  ): THREE.Mesh | null {
    try {
      const labelInfo: { material?: THREE.Material; aspect?: number } | null | undefined =
        game.mats.label(text, opts || {});
      return !labelInfo || !labelInfo.material
        ? null
        : quad(labelInfo.material, height * (labelInfo.aspect || 4), height, x, y, z, facing);
    } catch {
      return null;
    }
  }

  function col(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    surface = 'concrete',
    opts: ColliderOpts = {}
  ): unknown {
    return game.physics.addBox([x0, y0, z0], [x1, y1, z1], {
      surface,
      ...opts
    });
  }

  const scratchBox = new Box3();

  /**
   * Registers a placed prop's local colliders with physics. Rotated props
   * (not axis-aligned) get their long colliders split into chunks and
   * shrunk slightly so the world-space AABBs hug the rotated shape.
   */
  function addPropColliders(object: THREE.Object3D, yaw: number, opts: PlaceOpts = {}): void {
    const colliders: PropCollider[] = object.userData.colliders || [];
    const rotated = Math.abs(Math.sin(2 * yaw)) > 0.2;
    for (const collider of colliders) {
      let pieces: PropCollider[] = [collider];
      if (rotated) {
        const sizeX = collider.max[0] - collider.min[0];
        const sizeZ = collider.max[2] - collider.min[2];
        const longAxis = sizeX >= sizeZ ? 0 : 2;
        const longSize = Math.max(sizeX, sizeZ);
        const shortSize = Math.max(0.25, Math.min(sizeX, sizeZ));
        const chunks = Math.min(10, Math.max(1, Math.round(longSize / shortSize)));
        if (chunks > 1) {
          pieces = [];
          for (let chunk = 0; chunk < chunks; chunk++) {
            const min = collider.min.slice();
            const max = collider.max.slice();
            min[longAxis] = collider.min[longAxis] + (longSize * chunk) / chunks;
            max[longAxis] = collider.min[longAxis] + (longSize * (chunk + 1)) / chunks;
            pieces.push({
              min,
              max,
              surface: collider.surface
            });
          }
        }
      }
      for (const piece of pieces) {
        scratchBox.min.set(piece.min[0], piece.min[1], piece.min[2]);
        scratchBox.max.set(piece.max[0], piece.max[1], piece.max[2]);
        scratchBox.applyMatrix4(object.matrixWorld);
        if (scratchBox.max.y - scratchBox.min.y < 0.2 && scratchBox.max.y < 0.3) continue;
        if (rotated) {
          const insetX = (scratchBox.max.x - scratchBox.min.x) * 0.07;
          const insetZ = (scratchBox.max.z - scratchBox.min.z) * 0.07;
          scratchBox.min.x += insetX;
          scratchBox.max.x -= insetX;
          scratchBox.min.z += insetZ;
          scratchBox.max.z -= insetZ;
        }
        game.physics.addBox(scratchBox.min, scratchBox.max, {
          surface: piece.surface || collider.surface || 'metal',
          ...(opts.colOpts || {})
        });
      }
    }
  }

  function place(
    name: string,
    x: number,
    z: number,
    yaw = 0,
    propOpts: PropOpts = {},
    y = 0,
    placeOpts: PlaceOpts = {}
  ): THREE.Object3D {
    if (
      !placeOpts.inert &&
      ((name === 'barrel' && propOpts.color === 'red' && !propOpts.lying && !propOpts.open) ||
        name === 'gas_cylinders')
    ) {
      explosives.push({
        name,
        x,
        y,
        z,
        yaw,
        opts: {
          ...propOpts
        }
      });
      placed.push({
        name,
        x,
        y,
        z,
        yaw
      });
      return new Group();
    }
    const object: THREE.Object3D = game.props.build(name, propOpts);
    object.position.set(x, y, z);
    object.rotation.y = yaw;
    (placeOpts.dynamic ? dynRoot : staticRoot).add(object);
    object.updateMatrixWorld(true);
    if (!placeOpts.noCol && !NO_COLLIDER_PROPS.has(name)) addPropColliders(object, yaw, placeOpts);
    if (typeof object.userData.update == 'function')
      updaters.push((dt) => object.userData.update(dt));
    placed.push({
      name,
      x,
      y,
      z,
      yaw
    });
    return object;
  }

  function stairs(x: number, z: number, yaw = 0, y = 0, opts: PropOpts = {}): THREE.Object3D {
    const object = place('stairs_metal', x, z, yaw, opts, y);
    const alongX = Math.abs(Math.cos(yaw)) > 0.5;
    metalRects.push(
      alongX ? [x - 1.5, z - 0.5, x + 1.5, z + 0.5] : [x - 0.5, z - 1.5, x + 0.5, z + 1.5]
    );
    return object;
  }

  function catwalk(
    x: number,
    z: number,
    yaw = 0,
    y = 0,
    opts: PropOpts = {},
    rails: [boolean, boolean] = [true, true]
  ): THREE.Object3D {
    const railMode =
      rails[0] && rails[1] ? 'both' : rails[0] ? 'left' : rails[1] ? 'right' : 'none';
    const object = place(
      'catwalk',
      x,
      z,
      yaw,
      {
        ...opts,
        rails: railMode
      },
      y
    );
    const alongX = Math.abs(Math.cos(yaw)) > 0.5;
    const halfX = alongX ? 1.5 : 0.6;
    const halfZ = alongX ? 0.6 : 1.5;
    metalRects.push([x - halfX, z - halfZ, x + halfX, z + halfZ]);
    return object;
  }

  /** Stacks shipping containers bottom-up at (x, z), with slight random jitter. */
  function stack(
    x: number,
    z: number,
    specs: ContainerSpec[],
    yaw = 0,
    jitter = 1
  ): ContainerStack {
    let height = 0;
    const objs: THREE.Object3D[] = [];
    for (let index = 0; index < specs.length; index++) {
      const [size, color, opts = {}] = specs[index];
      const kind = CONTAINER_KIND[size];
      const dx = (opts.dx || 0) + (index ? rnd(-0.05, 0.05) * jitter : 0);
      const dz = (opts.dz || 0) + (index ? rnd(-0.04, 0.04) * jitter : 0);
      const containerYaw =
        yaw + rnd(-1, 1) * 0.022 * jitter * (index ? 0.6 : 1) + (opts.flip ? Math.PI : 0);
      const object = place(
        kind,
        x + dx,
        z + dz,
        containerYaw,
        {
          color,
          seed: Math.floor(rnd(1, 99999)),
          wear: opts.wear ?? rnd(0.2, 0.85),
          doors: opts.doors || 0
        },
        height
      );
      const length = CONTAINER_LENGTH[kind];
      const containerHeight = CONTAINER_HEIGHT[kind];
      const alongX = Math.abs(Math.cos(yaw)) > 0.5;
      const halfX = (alongX ? length : 2.44) / 2;
      const halfZ = (alongX ? 2.44 : length) / 2;
      metalRects.push([x + dx - halfX, z + dz - halfZ, x + dx + halfX, z + dz + halfZ]);
      if (opts.reefer) {
        const offset = -(length / 2 + 0.2);
        const cos = Math.cos(containerYaw);
        const sin = Math.sin(containerYaw);
        place(
          'reefer_unit',
          x + dx + offset * cos,
          z + dz - offset * sin,
          containerYaw,
          {
            seed: index + 3
          },
          height + 0.14
        );
      }
      objs.push(object);
      height += containerHeight;
    }
    return {
      top: height,
      objs
    };
  }

  function isMetal(x: number, z: number): boolean {
    for (const rect of metalRects)
      if (x >= rect[0] && x <= rect[2] && z >= rect[1] && z <= rect[3]) return true;
    return false;
  }

  return {
    G: game,
    THREE,
    staticRoot,
    dynRoot,
    metalRects,
    updaters,
    placed,
    explosives,
    rng,
    rnd,
    M: mat,
    MI: matInterior,
    add,
    box,
    slab,
    cyl,
    tube,
    rod,
    ibeam,
    quad,
    decal,
    label,
    col,
    place,
    stairs,
    catwalk,
    stack,
    isMetal
  };
}

const LABEL_ATLAS_PAD = 4;

/** Result of {@link buildLabelAtlas}. */
export interface LabelAtlas {
  /** Number of label materials packed into the atlas. */
  count: number;
  material: THREE.Material | null;
  size?: [number, number];
  /** Re-packs the atlas when a source label texture changed (only during the first ~8 s). */
  update(dt: number): void;
}

/** A material carrying a texture map (labels). */
type MappedMaterial = THREE.Material & { map: THREE.Texture | null };

type LabelImage = CanvasImageSource & { width: number; height: number };

interface AtlasEntry {
  m: MappedMaterial;
  img: LabelImage;
  w: number;
  h: number;
  x: number;
  y: number;
  version?: number;
}

/**
 * Packs every label material under `root` (outside `noMerge` subtrees) into
 * one canvas texture, remapping the meshes' UVs onto their atlas cells.
 */
export function buildLabelAtlas(
  root: THREE.Object3D,
  { scale = 0.5, maxW = 2048 }: { scale?: number; maxW?: number } = {}
): LabelAtlas {
  const empty: LabelAtlas = {
    count: 0,
    material: null,
    update() {}
  };
  if (typeof document > 'u') return empty;
  const meshesByMaterial = new Map<MappedMaterial, THREE.Mesh[]>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const material = mesh.material as MappedMaterial;
    if (
      !material ||
      material.name !== 'label' ||
      !material.map ||
      !material.map.image ||
      !material.map.image.width
    )
      return;
    let ancestor: THREE.Object3D | null = mesh;
    let excluded = false;
    while (ancestor) {
      if (ancestor.userData && ancestor.userData.noMerge) {
        excluded = true;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (!excluded) {
      if (!meshesByMaterial.has(material)) meshesByMaterial.set(material, []);
      meshesByMaterial.get(material)!.push(mesh);
    }
  });
  if (meshesByMaterial.size < 2) return empty;
  const entries: AtlasEntry[] = [...meshesByMaterial.keys()].map((material) => {
    const image: LabelImage = material.map!.image;
    return {
      m: material,
      img: image,
      w: Math.max(4, Math.ceil(image.width * scale)),
      h: Math.max(4, Math.ceil(image.height * scale)),
      x: 0,
      y: 0
    };
  });
  entries.sort((a, b) => b.h - a.h || b.w - a.w);
  // Simple shelf packer: fill rows left to right, tallest entries first.
  let cursorX = 0;
  let shelfY = 0;
  let shelfHeight = 0;
  for (const entry of entries) {
    const width = Math.min(entry.w, maxW - 2 * LABEL_ATLAS_PAD);
    if (width < entry.w) {
      entry.h = Math.max(4, Math.round((entry.h * width) / entry.w));
      entry.w = width;
    }
    if (cursorX + entry.w + 2 * LABEL_ATLAS_PAD > maxW) {
      cursorX = 0;
      shelfY += shelfHeight;
      shelfHeight = 0;
    }
    entry.x = cursorX + LABEL_ATLAS_PAD;
    entry.y = shelfY + LABEL_ATLAS_PAD;
    cursorX += entry.w + 2 * LABEL_ATLAS_PAD;
    shelfHeight = Math.max(shelfHeight, entry.h + 2 * LABEL_ATLAS_PAD);
  }
  const atlasW = maxW;
  const atlasH = MathUtils.ceilPowerOfTwo(Math.max(16, shelfY + shelfHeight));
  if (atlasH > 4096) return empty;
  const canvas = document.createElement('canvas');
  canvas.width = atlasW;
  canvas.height = atlasH;
  const ctx = canvas.getContext('2d')!;
  const draw = (): void => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, atlasW, atlasH);
    for (const entry of entries) {
      // Stretched copy into the padding (avoids bleeding), then the exact image on top.
      ctx.drawImage(
        entry.img,
        entry.x - LABEL_ATLAS_PAD,
        entry.y - LABEL_ATLAS_PAD,
        entry.w + 2 * LABEL_ATLAS_PAD,
        entry.h + 2 * LABEL_ATLAS_PAD
      );
      ctx.clearRect(entry.x, entry.y, entry.w, entry.h);
      ctx.drawImage(entry.img, entry.x, entry.y, entry.w, entry.h);
      entry.version = entry.m.map!.version;
    }
  };
  draw();
  const template = entries[0].m;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = template.map!.colorSpace;
  texture.anisotropy = template.map!.anisotropy;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  const atlasMaterial = template.clone();
  atlasMaterial.map = texture;
  atlasMaterial.name = 'label_atlas';
  const remappedGeometry = new Map<string, THREE.BufferGeometry>();
  for (const entry of entries) {
    const u0 = entry.x / atlasW;
    const u1 = (entry.x + entry.w) / atlasW;
    const v1 = 1 - entry.y / atlasH;
    const v0 = 1 - (entry.y + entry.h) / atlasH;
    for (const mesh of meshesByMaterial.get(entry.m)!) {
      const key = mesh.geometry.uuid + '|' + entry.m.uuid;
      let geometry = remappedGeometry.get(key);
      if (!geometry) {
        geometry = mesh.geometry.clone();
        const uv = geometry.attributes.uv;
        if (uv) {
          for (let i = 0; i < uv.count; i++)
            uv.setXY(
              i,
              u0 + MathUtils.clamp(uv.getX(i), 0, 1) * (u1 - u0),
              v0 + MathUtils.clamp(uv.getY(i), 0, 1) * (v1 - v0)
            );
          uv.needsUpdate = true;
        }
        remappedGeometry.set(key, geometry);
      }
      mesh.geometry = geometry;
      mesh.material = atlasMaterial;
    }
  }
  let elapsed = 0;
  return {
    count: entries.length,
    material: atlasMaterial,
    size: [atlasW, atlasH],
    update(dt) {
      if (!(elapsed > 8)) {
        elapsed += dt;
        for (const entry of entries)
          if (entry.m.map!.version !== entry.version) {
            draw();
            texture.needsUpdate = true;
            break;
          }
      }
    }
  };
}
