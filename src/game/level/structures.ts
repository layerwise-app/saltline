/**
 * Built structures of the level: the steel-framed shed (walls, louvres,
 * skylit roof, portal frames, roller and side doors, lights, fan, props)
 * with its raised site office (furnished interior with baked vertex
 * lighting), plus small reusable yard props (scrap cages and skips, rebar,
 * wheel chocks, lane signs, hatch-cover stacks, ground cables, power
 * pedestals).
 */
import type * as THREE from 'three';
import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  ExtrudeGeometry,
  Group,
  Mesh,
  Path,
  PlaneGeometry,
  PointLight,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector3
} from 'three';
import {
  roundedBox,
  setVertexColors,
  shadowedMesh,
  worldUvBox,
  worldUvCylinder
} from '../render/geometry';
import type { LevelKit, MaterialRef, PlaceOpts, PropOpts, QuadFacing } from './kit';

/** Per-vertex colour function used to bake fake lighting into vertex colours. */
type ShadeFn = (x: number, y: number, z: number) => number[];

/** Options for the site office's own box helpers (`fn` bakes vertex colours). */
interface OfficeSlabOpts {
  cast?: boolean;
  recv?: boolean;
  bevel?: number;
  fn?: ShadeFn;
}

/** Slab builder in a wall's local frame: u along the wall, v up, d through it. */
type WallSlabFn = (
  material: THREE.Material,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  d0: number,
  d1: number,
  opts?: OfficeSlabOpts
) => THREE.Mesh;

/** Shared shed materials handed to the site office builder. */
interface ShedMaterials {
  mFrame: THREE.Material;
  mGalv: THREE.Material;
  mDark: THREE.Material;
}

/** Site office dimensions (absolute world coordinates, metres). */
const SITE_OFFICE = {
  FY: 2.6,
  CY: 4.95,
  RY: 5.08,
  TW: 0.08,
  X0: -15.7,
  X1: -10.3,
  Z0: -27.24,
  Z1: -23.8,
  DX0: -11.6,
  DX1: -10.58,
  DH: 2.1,
  SW0: -15.25,
  SW1: -12.45,
  EW0: -26.95,
  EW1: -24.1,
  SILL: 0.9,
  HEAD: 1.95,
  DESK: {
    x0: -14.95,
    x1: -12.25,
    d: 0.76,
    h: 0.74
  }
};
/** Builds the raised site office in the shed's south-west corner, with its interior. */
function buildSiteOffice(kit: LevelKit, shed: typeof SHED, shedMats: ShedMaterials): void {
  const { M: mat, MI: matI, add, box, slab, cyl, rod, tube, col, G: game } = kit;
  const { mFrame: matFrame, mGalv: matGalv, mDark: matDark } = shedMats;
  const inset = 0.25;
  const office = SITE_OFFICE;
  const floorY = office.FY;
  const ceilY = office.CY;
  const roofY = office.RY;
  const wallT = office.TW;
  const deckY = floorY;
  const deckX0 = shed.X0 + inset + 0.02;
  const deckX1 = -10.25;
  const deckZ0 = shed.Z0 + inset + 0.02;
  const deckZ1 = -23.75;
  const x0 = office.X0;
  const x1 = office.X1;
  const z0 = office.Z0;
  const z1 = office.Z1;
  const innerX0 = x0 + wallT;
  const innerX1 = x1 - wallT;
  const innerZ0 = z0 + wallT;
  const innerZ1 = z1 - wallT;
  const sillY = floorY + office.SILL;
  const headY = floorY + office.HEAD;
  const doorX0 = office.DX0;
  const doorX1 = office.DX1;
  const doorTopY = floorY + office.DH;
  const frameW = 0.05;
  const frontWinX0 = office.SW0;
  const frontWinX1 = office.SW1;
  const sideWinZ0 = office.EW0;
  const sideWinZ1 = office.EW1;
  const vcOpts = {
    vertexColors: true
  };
  const mPanel = matI('armor_white', {
    color: 0xc8cbc7,
    vertexColors: true
  });
  const mFloor = matI('plastic_grey', vcOpts);
  const mAlu = matI('aluminium');
  const mRubber = matI('rubber');
  const mGlass = matI('glass');
  const mWood = matI('wood_dark');
  const mPlate = matI('diamond_plate');
  const mTeal = matI('paint_teal');
  const mRed = matI('paint_red');
  const mYellow = matI('paint_yellow');
  const mGreen = matI('paint_green');
  const mCardboard = matI('cardboard');
  const mYellowExt = mat('paint_yellow');
  const emPanel = game.mats.emissive(0xdfe9f4, 1.9);
  const emBulb = game.mats.emissive(0xfff0d0, 3);
  const emScreenDark = game.mats.emissive(0x08131c, 1);
  const emScreen = game.mats.emissive(0x58a8b8, 0.8);
  const emAmber = game.mats.emissive(0xd08a30, 0.9);
  const emGrey = game.mats.emissive(0x8f9aa2, 0.55);
  const smoothstep = (x: number): number => {
    x = Math.max(0, Math.min(1, x));
    return x * x * (3 - 2 * x);
  };
  const lampPos = [-13, ceilY, -25.5];
  const doorLampPos = [(doorX0 + doorX1) / 2, doorTopY + 0.14, z1 + 0.06];
  const interiorShade: ShadeFn = (x, y, z) => {
    const dx = x - lampPos[0];
    const dy = (y - lampPos[1]) * 1.15;
    const dz = z - lampPos[2];
    let light = 1.15 + 1.5 / (1 + 0.35 * (dx * dx + dy * dy + dz * dz));
    light *= 0.8 + 0.2 * smoothstep((y - floorY) / 0.4);
    const edgeX = Math.min(x - innerX0, innerX1 - x);
    const edgeZ = Math.min(z - innerZ0, innerZ1 - z);
    light *= 0.86 + 0.14 * smoothstep(Math.max(edgeX, edgeZ) / 0.45);
    return [light * 0.97, light, light * 1.035];
  };
  const exteriorShade: ShadeFn = (x, y, z) => {
    const base =
      (0.86 + 0.14 * smoothstep((y - floorY) / 0.6)) *
      (1 - 0.08 * smoothstep((y - (ceilY - 0.3)) / 0.4));
    const dx = x - doorLampPos[0];
    const dy = y - doorLampPos[1];
    const dz = z - doorLampPos[2];
    const glow = 0.6 / (1 + 6 * (dx * dx + dy * dy + dz * dz));
    return [base * (1 + glow), base * 0.99 * (1 + glow * 0.85), base * 0.965 * (1 + glow * 0.6)];
  };
  const roofShade: ShadeFn = () => [0.7, 0.69, 0.66];
  /** Planar UVs projected along each face's dominant normal axis. */
  function planarUvs(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    const uv = geometry.attributes.uv;
    const position = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    for (let i = 0; i < uv.count; i++) {
      const nx = Math.abs(normal.getX(i));
      const ny = Math.abs(normal.getY(i));
      const px = position.getX(i);
      const py = position.getY(i);
      const pz = position.getZ(i);
      if (nx > 0.5) uv.setXY(i, pz, py);
      else if (ny > 0.5) uv.setXY(i, px, pz);
      else uv.setXY(i, px, py);
    }
    return geometry;
  }
  /** Subdivided box between two corners with vertex colours from `shade`. */
  function shadedBox(
    material: MaterialRef,
    bx0: number,
    by0: number,
    bz0: number,
    bx1: number,
    by1: number,
    bz1: number,
    shade: ShadeFn,
    cell = 0.45,
    opts: OfficeSlabOpts = {}
  ): THREE.Mesh {
    const sizeX = Math.abs(bx1 - bx0);
    const sizeY = Math.abs(by1 - by0);
    const sizeZ = Math.abs(bz1 - bz0);
    const segments = (size: number): number => Math.max(1, Math.min(14, Math.round(size / cell)));
    const geometry = new BoxGeometry(
      sizeX,
      sizeY,
      sizeZ,
      segments(sizeX),
      segments(sizeY),
      segments(sizeZ)
    );
    geometry.translate((bx0 + bx1) / 2, (by0 + by1) / 2, (bz0 + bz1) / 2);
    return add(setVertexColors(planarUvs(geometry), shade), material, opts);
  }
  function shadedRoundedBox(
    material: MaterialRef,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    shade: ShadeFn,
    bevel = 0.012,
    opts: OfficeSlabOpts = {}
  ): THREE.Mesh {
    const geometry = roundedBox(w, h, d, bevel);
    geometry.translate(x, y, z);
    return add(setVertexColors(geometry, shade), material, opts);
  }
  function shadedCyl(
    material: MaterialRef,
    radius: number,
    height: number,
    x: number,
    y: number,
    z: number,
    axis: 'x' | 'y' | 'z',
    shade: ShadeFn,
    seg = 16
  ): THREE.Mesh {
    const geometry = worldUvCylinder(radius, radius, height, seg);
    if (axis === 'x') geometry.rotateZ(Math.PI / 2);
    else if (axis === 'z') geometry.rotateX(Math.PI / 2);
    geometry.translate(x, y, z);
    return add(setVertexColors(geometry, shade), material);
  }
  /** Empty group at a position/yaw, parented to the static root. */
  function pivot(x: number, y: number, z: number, yaw = 0): THREE.Group {
    const group = new Group();
    group.position.set(x, y, z);
    group.rotation.y = yaw;
    kit.staticRoot.add(group);
    return group;
  }
  function plane(
    parent: THREE.Object3D,
    material: THREE.Material,
    w: number,
    h: number,
    x: number,
    y: number,
    z: number
  ): THREE.Mesh {
    const mesh = new Mesh(new PlaneGeometry(w, h), material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }
  /** Places a text label starting at `x` (along the wall), shrunk to fit `maxW`; returns its width. */
  function fitLabel(
    text: string,
    height: number,
    x: number,
    y: number,
    z: number,
    facing: QuadFacing,
    opts?: Record<string, unknown>,
    maxW?: number
  ): number {
    try {
      const info = game.mats.label(text, opts || {});
      if (!info || !info.material) return 0;
      let width = height * (info.aspect || 4);
      if (maxW && width > maxW) {
        height *= maxW / width;
        width = maxW;
      }
      if (facing === 'z+') kit.quad(info.material, width, height, x + width / 2, y, z, facing);
      else if (facing === 'z-') kit.quad(info.material, width, height, x - width / 2, y, z, facing);
      else if (facing === 'x+') kit.quad(info.material, width, height, z, y, x - width / 2, facing);
      else kit.quad(info.material, width, height, z, y, x + width / 2, facing);
      return width;
    } catch {
      return 0;
    }
  }
  /** Places a decal hanging down from `y`, scaled to fit within maxW x maxH. */
  function fitDecal(
    name: string,
    maxW: number,
    maxH: number,
    x: number,
    y: number,
    z: number,
    facing: QuadFacing
  ): void {
    try {
      const info = game.mats.decal(name);
      if (!info || !info.material) return;
      const aspect = info.aspect || 1;
      let w = maxW;
      let h = w / aspect;
      if (h > maxH) {
        h = maxH;
        w = h * aspect;
      }
      kit.quad(info.material, w, h, x, y - h / 2, z, facing);
    } catch {}
  }
  const firstChild = kit.staticRoot.children.length;
  slab(mPlate, deckX0, deckY - 0.1, deckZ0, deckX1, deckY, deckZ1);
  slab(
    matGalv,
    deckX0 + 0.2,
    deckY - 0.112,
    deckZ0 + 0.1,
    deckX1 - 0.16,
    deckY - 0.1,
    deckZ1 - 0.16,
    {
      cast: false
    }
  );
  const beamXs = [deckX0 + 0.1, -13, deckX1 - 0.08];
  for (const beamX of beamXs)
    kit.ibeam(matFrame, 'z', deckZ1 - deckZ0, beamX, deckY - 0.2, (deckZ0 + deckZ1) / 2, {
      depth: 0.2,
      width: 0.14,
      tf: 0.014,
      tw: 0.01
    });
  kit.ibeam(matFrame, 'x', deckX1 - deckX0, (deckX0 + deckX1) / 2, deckY - 0.2, deckZ1 - 0.08, {
    depth: 0.2,
    width: 0.14,
    tf: 0.014,
    tw: 0.01
  });
  for (let z = deckZ0 + 0.35; z < deckZ1 - 0.4; z += 0.56)
    slab(matGalv, deckX0 + 0.17, deckY - 0.22, z - 0.025, deckX1 - 0.15, deckY - 0.11, z + 0.025);
  slab(matFrame, deckX1 - 0.012, deckY - 0.3, deckZ0, deckX1 + 0.012, deckY + 0.004, deckZ1, {
    bevel: 0.004
  });
  for (let z = deckZ0 + 0.3; z < deckZ1; z += 0.62)
    cyl(matGalv, 0.014, 0.012, deckX1 + 0.016, deckY - 0.15, z, {
      axis: 'x',
      seg: 6
    });
  const posts = [
    [deckX1 - 0.08, deckZ1 - 0.08],
    [deckX1 - 0.08, deckZ0 + 0.3],
    [-13, deckZ1 - 0.08]
  ];
  for (const [px, pz] of posts) {
    box(matFrame, 0.14, deckY - 0.3, 0.14, px, (deckY - 0.3) / 2, pz, {
      bevel: 0.01
    });
    col(px - 0.08, 0, pz - 0.08, px + 0.08, deckY, pz + 0.08, 'metal', {
      noNav: true
    });
    box(matDark, 0.3, 0.02, 0.3, px, shed.FLOOR + 0.01, pz, {
      bevel: 0.004
    });
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        cyl(matGalv, 0.013, 0.02, px + sx * 0.11, shed.FLOOR + 0.03, pz + sz * 0.11, {
          seg: 6
        });
    box(matFrame, 0.22, 0.014, 0.22, px, deckY - 0.307, pz);
  }
  const brace = (px: number, pz: number, dirX: number, dirZ: number): THREE.Mesh =>
    rod(
      matFrame,
      [px + dirX * 0.05, deckY - 1, pz + dirZ * 0.05],
      [px + dirX * 0.68, deckY - 0.31, pz + dirZ * 0.68],
      0.028,
      {
        seg: 6
      }
    );
  brace(posts[0][0], posts[0][1], -1, 0);
  brace(posts[0][0], posts[0][1], 0, -1);
  brace(posts[1][0], posts[1][1], 0, 1);
  brace(posts[2][0], posts[2][1], -1, 0);
  brace(posts[2][0], posts[2][1], 1, 0);
  brace(posts[2][0], posts[2][1], 0, -1);
  col(deckX0, deckY - 0.12, deckZ0, deckX1, deckY, deckZ1, 'metal', {
    noNav: true
  });
  const mSeam = matDark;
  const seamStep = 0.9;
  /** Office wall panel in the XY plane: outer skin (exterior shading) + inner skin + seam strips. */
  function wallAlongX(wallZ: number, side: number, xa: number, xb: number, ya: number, yb: number) {
    const midZ = wallZ - (side * wallT) / 2;
    const innerZ = wallZ - side * wallT;
    shadedBox(mPanel, xa, ya, Math.min(wallZ, midZ), xb, yb, Math.max(wallZ, midZ), exteriorShade);
    shadedBox(
      mPanel,
      xa,
      ya,
      Math.min(midZ, innerZ),
      xb,
      yb,
      Math.max(midZ, innerZ),
      interiorShade
    );
    for (let x = x0 + seamStep; x < xb - 0.1; x += seamStep)
      if (x > xa + 0.1) {
        slab(mSeam, x - 0.009, ya, wallZ, x + 0.009, yb, wallZ + side * 0.0015, {
          cast: false
        });
        slab(mSeam, x - 0.006, ya, innerZ - side * 0.0015, x + 0.006, yb, innerZ, {
          cast: false
        });
      }
  }
  /** Office wall panel in the ZY plane. */
  function wallAlongZ(wallX: number, side: number, za: number, zb: number, ya: number, yb: number) {
    const midX = wallX - (side * wallT) / 2;
    const innerX = wallX - side * wallT;
    shadedBox(mPanel, Math.min(wallX, midX), ya, za, Math.max(wallX, midX), yb, zb, exteriorShade);
    shadedBox(
      mPanel,
      Math.min(midX, innerX),
      ya,
      za,
      Math.max(midX, innerX),
      yb,
      zb,
      interiorShade
    );
    for (let z = z0 + seamStep; z < zb - 0.1; z += seamStep)
      if (z > za + 0.1) {
        slab(mSeam, wallX, ya, z - 0.009, wallX + side * 0.0015, yb, z + 0.009, {
          cast: false
        });
        slab(mSeam, innerX - side * 0.0015, ya, z - 0.006, innerX, yb, z + 0.006, {
          cast: false
        });
      }
  }
  wallAlongX(z1, 1, x0, frontWinX0, floorY, ceilY);
  wallAlongX(z1, 1, frontWinX0, frontWinX1, floorY, sillY);
  wallAlongX(z1, 1, frontWinX0, frontWinX1, headY, ceilY);
  wallAlongX(z1, 1, frontWinX1, doorX0 - frameW, floorY, ceilY);
  wallAlongX(z1, 1, doorX0 - frameW, doorX1 + frameW, doorTopY + frameW, ceilY);
  wallAlongX(z1, 1, doorX1 + frameW, x1, floorY, ceilY);
  wallAlongZ(x1, 1, z0, sideWinZ0, floorY, ceilY);
  wallAlongZ(x1, 1, sideWinZ0, sideWinZ1, floorY, sillY);
  wallAlongZ(x1, 1, sideWinZ0, sideWinZ1, headY, ceilY);
  wallAlongZ(x1, 1, sideWinZ1, z1, floorY, ceilY);
  wallAlongX(z0, -1, x0, x1, floorY, ceilY);
  wallAlongZ(x0, -1, z0, z1, floorY, ceilY);
  shadedBox(
    mFloor,
    innerX0,
    floorY - 0.004,
    innerZ0,
    innerX1,
    floorY + 0.006,
    innerZ1,
    (x: number, y: number, z: number) => {
      const c = interiorShade(x, floorY + 0.4, z);
      return [c[0] * 1.25, c[1] * 1.25, c[2] * 1.25];
    },
    0.5,
    {
      cast: false
    }
  );
  shadedBox(mPanel, innerX0, ceilY - 0.02, innerZ0, innerX1, ceilY, innerZ1, interiorShade, 0.4, {
    cast: false
  });
  for (let x = innerX0 + 0.62; x < innerX1 - 0.1; x += 0.6)
    slab(mAlu, x - 0.012, ceilY - 0.024, innerZ0, x + 0.012, ceilY - 0.02, innerZ1, {
      cast: false
    });
  for (let z = innerZ0 + 0.58; z < innerZ1 - 0.1; z += 0.6)
    slab(mAlu, innerX0, ceilY - 0.0245, z - 0.012, innerX1, ceilY - 0.0205, z + 0.012, {
      cast: false
    });
  shadedBox(mPanel, x0 - 0.03, ceilY, z0 - 0.02, x1 + 0.05, roofY, z1 + 0.05, roofShade, 0.7);
  slab(matGalv, x0 - 0.035, roofY - 0.05, z1 + 0.05, x1 + 0.062, roofY + 0.012, z1 + 0.062);
  slab(matGalv, x1 + 0.05, roofY - 0.05, z0 - 0.02, x1 + 0.062, roofY + 0.012, z1 + 0.05);
  slab(matGalv, x0 - 0.035, ceilY - 0.012, z1, x1 + 0.05, ceilY, z1 + 0.05, {
    cast: false
  });
  slab(matGalv, x1, ceilY - 0.012, z0, x1 + 0.05, ceilY, z1, {
    cast: false
  });
  slab(matGalv, x0, floorY, z1, doorX0 - frameW, floorY + 0.07, z1 + 0.012, {
    bevel: 0.003
  });
  slab(matGalv, doorX1 + frameW, floorY, z1, x1, floorY + 0.07, z1 + 0.012, {
    bevel: 0.003
  });
  slab(matGalv, x1, floorY, z0, x1 + 0.012, floorY + 0.07, z1 + 0.012, {
    bevel: 0.003
  });
  slab(matGalv, x1 - 0.07, floorY + 0.07, z1 - 0.07, x1 + 0.006, ceilY - 0.012, z1 + 0.006);
  slab(matGalv, x0 - 0.006, floorY + 0.07, z1 - 0.07, x0 + 0.07, ceilY - 0.012, z1 + 0.006);
  slab(matGalv, x1 - 0.07, floorY, z0 - 0.006, x1 + 0.006, ceilY - 0.012, z0 + 0.07);
  const onFrontWall =
    (wallZ: number, dir: number): WallSlabFn =>
    (material, u0, u1, v0, v1, d0, d1, opts = {}) =>
      opts.fn
        ? shadedBox(
            material,
            u0,
            v0,
            wallZ + dir * Math.min(d0, d1),
            u1,
            v1,
            wallZ + dir * Math.max(d0, d1),
            opts.fn,
            0.4
          )
        : slab(material, u0, v0, wallZ + dir * d0, u1, v1, wallZ + dir * d1, opts);
  const onSideWall =
    (wallX: number, dir: number): WallSlabFn =>
    (material, u0, u1, v0, v1, d0, d1, opts = {}) =>
      opts.fn
        ? shadedBox(
            material,
            wallX + dir * Math.min(d0, d1),
            v0,
            u0,
            wallX + dir * Math.max(d0, d1),
            v1,
            u1,
            opts.fn,
            0.4
          )
        : slab(material, wallX + dir * d0, v0, u0, wallX + dir * d1, v1, u1, opts);
  /** Framed window with `paneCount` glazed panes and a sill; returns the pane spans. */
  function buildWindow(
    wallSlab: WallSlabFn,
    u0: number,
    u1: number,
    paneCount: number
  ): number[][] {
    const halfT = wallT / 2;
    const bar = 0.05;
    const bevelOpts = {
      bevel: 0.006
    };
    const paneStep = (u1 - u0 - bar) / paneCount;
    const gasket = 0.012;
    const panes = [];
    wallSlab(mAlu, u0, u1, headY - bar, headY, -halfT - 0.012, halfT + 0.014, bevelOpts);
    wallSlab(mAlu, u0, u1, sillY, sillY + bar, -halfT - 0.012, halfT + 0.014, bevelOpts);
    for (let i = 0; i <= paneCount; i++) {
      const u = u0 + i * paneStep;
      wallSlab(
        mAlu,
        u,
        u + bar,
        sillY + bar,
        headY - bar,
        -halfT - 0.012,
        halfT + 0.014,
        bevelOpts
      );
    }
    for (let i = 0; i < paneCount; i++) {
      const pa = u0 + i * paneStep + bar;
      const pb = u0 + (i + 1) * paneStep;
      panes.push([pa, pb]);
      wallSlab(mGlass, pa, pb, sillY + bar, headY - bar, -0.004, 0.004, {
        cast: false
      });
      wallSlab(mRubber, pa, pa + gasket, sillY + bar, headY - bar, -0.013, 0.013, {
        cast: false
      });
      wallSlab(mRubber, pb - gasket, pb, sillY + bar, headY - bar, -0.013, 0.013, {
        cast: false
      });
      wallSlab(mRubber, pa, pb, sillY + bar, sillY + bar + gasket, -0.013, 0.013, {
        cast: false
      });
      wallSlab(mRubber, pa, pb, headY - bar - gasket, headY - bar, -0.013, 0.013, {
        cast: false
      });
    }
    wallSlab(mAlu, u0 - 0.03, u1 + 0.03, sillY - 0.02, sillY, halfT, halfT + 0.07, {
      bevel: 0.005
    });
    wallSlab(mAlu, u0 - 0.03, u1 + 0.03, sillY - 0.05, sillY - 0.02, halfT, halfT + 0.012);
    wallSlab(mPanel, u0 - 0.03, u1 + 0.03, sillY - 0.03, sillY, -halfT - 0.11, -halfT, {
      fn: interiorShade
    });
    return panes;
  }
  buildWindow(onFrontWall(z1 - wallT / 2, 1), frontWinX0, frontWinX1, 3);
  buildWindow(onSideWall(x1 - wallT / 2, 1), sideWinZ0, sideWinZ1, 3);
  box(mAlu, 0.03, 0.06, 0.02, frontWinX0 + 0.95, sillY + 0.5, innerZ1 - 0.02);
  box(mAlu, 0.02, 0.06, 0.03, innerX1 - 0.02, sillY + 0.5, sideWinZ0 + 0.96);
  slab(matFrame, doorX0 - frameW, floorY, innerZ1 - 0.015, doorX0, doorTopY + frameW, z1 + 0.015, {
    bevel: 0.006
  });
  slab(matFrame, doorX1, floorY, innerZ1 - 0.015, doorX1 + frameW, doorTopY + frameW, z1 + 0.015, {
    bevel: 0.006
  });
  slab(
    matFrame,
    doorX0 - frameW,
    doorTopY,
    innerZ1 - 0.015,
    doorX1 + frameW,
    doorTopY + frameW,
    z1 + 0.015,
    {
      bevel: 0.006
    }
  );
  slab(mRubber, doorX0, floorY, innerZ1 + 0.004, doorX0 + 0.012, doorTopY, innerZ1 + 0.02, {
    cast: false
  });
  slab(mRubber, doorX1 - 0.012, floorY, innerZ1 + 0.004, doorX1, doorTopY, innerZ1 + 0.02, {
    cast: false
  });
  slab(mRubber, doorX0, doorTopY - 0.012, innerZ1 + 0.004, doorX1, doorTopY, innerZ1 + 0.02, {
    cast: false
  });
  slab(mAlu, doorX0, floorY - 0.002, innerZ1 - 0.03, doorX1, floorY + 0.008, z1 + 0.04, {
    bevel: 0.003
  });
  const doorAngle = (98 * Math.PI) / 180;
  const doorW = 0.985;
  const doorT = 0.044;
  const doorBottom = 0.012;
  const doorH = 2.085;
  const door = pivot(doorX0 - 0.012, floorY, innerZ1 - 0.03, doorAngle);
  const doorSlab = (
    material: MaterialRef,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    opts: OfficeSlabOpts = {}
  ): THREE.Mesh =>
    box(
      material,
      Math.abs(bx - ax),
      Math.abs(by - ay),
      Math.abs(bz - az),
      (ax + bx) / 2,
      (ay + by) / 2,
      (az + bz) / 2,
      {
        ...opts,
        parent: door
      }
    );
  const doorWin = {
    x0: 0.6,
    x1: 0.84,
    y0: 1.15,
    y1: 1.8
  };
  doorSlab(mTeal, 0, doorBottom, -doorT / 2, doorW, doorWin.y0, doorT / 2);
  doorSlab(mTeal, 0, doorWin.y1, -doorT / 2, doorW, doorH, doorT / 2);
  doorSlab(mTeal, 0, doorWin.y0, -doorT / 2, doorWin.x0, doorWin.y1, doorT / 2);
  doorSlab(mTeal, doorWin.x1, doorWin.y0, -doorT / 2, doorW, doorWin.y1, doorT / 2);
  doorSlab(mGlass, doorWin.x0, doorWin.y0, -0.004, doorWin.x1, doorWin.y1, 0.004, {
    cast: false
  });
  for (const side of [-1, 1]) {
    const innerFace = side * (doorT / 2 - 0.004);
    const outerFace = side * (doorT / 2 + 0.006);
    const lip = 0.018;
    doorSlab(
      mAlu,
      doorWin.x0 - lip,
      doorWin.y0 - lip,
      innerFace,
      doorWin.x1 + lip,
      doorWin.y0,
      outerFace
    );
    doorSlab(
      mAlu,
      doorWin.x0 - lip,
      doorWin.y1,
      innerFace,
      doorWin.x1 + lip,
      doorWin.y1 + lip,
      outerFace
    );
    doorSlab(mAlu, doorWin.x0 - lip, doorWin.y0, innerFace, doorWin.x0, doorWin.y1, outerFace);
    doorSlab(mAlu, doorWin.x1, doorWin.y0, innerFace, doorWin.x1 + lip, doorWin.y1, outerFace);
    doorSlab(mAlu, 0.04, 0.05, (side * doorT) / 2, doorW - 0.04, 0.27, side * (doorT / 2 + 0.002));
    doorSlab(
      mAlu,
      doorW - 0.115,
      0.95,
      (side * doorT) / 2,
      doorW - 0.065,
      1.13,
      side * (doorT / 2 + 0.003)
    );
    cyl(mAlu, 0.011, 0.05, doorW - 0.09, 1.07, side * (doorT / 2 + 0.027), {
      axis: 'z',
      seg: 8,
      parent: door
    });
    doorSlab(
      mAlu,
      doorW - 0.22,
      1.06,
      side * (doorT / 2 + 0.042),
      doorW - 0.078,
      1.08,
      side * (doorT / 2 + 0.06),
      {
        bevel: 0.006
      }
    );
    cyl(matDark, 0.011, 0.016, doorW - 0.09, 0.985, side * (doorT / 2 + 0.005), {
      axis: 'z',
      seg: 8,
      parent: door
    });
  }
  for (const y of [0.25, 1.05, 1.85])
    cyl(mAlu, 0.009, 0.1, -0.004, y, -doorT / 2 - 0.004, {
      seg: 8,
      parent: door
    });
  doorSlab(mAlu, 0.07, 1.975, -doorT / 2 - 0.048, 0.31, 2.035, -doorT / 2, {
    bevel: 0.006
  });
  doorSlab(mAlu, 0.08, 1.5, doorT / 2, 0.54, 1.74, doorT / 2 + 0.003);
  const doorLabels: [string, number, number][] = [
    ['SITE OFFICE', 0.075, 1.665],
    ['BERTH 4', 0.055, 1.565]
  ];
  for (const [text, h, y] of doorLabels)
    try {
      const info = game.mats.label(text, {
        color: 'black',
        font: 'sans',
        distress: 0.12
      });
      if (info && info.material) {
        let lh = h;
        let lw = lh * (info.aspect || 4);
        if (lw > 0.42) {
          lh *= 0.42 / lw;
          lw = 0.42;
        }
        plane(door, info.material, lw, lh, 0.1 + lw / 2, y, doorT / 2 + 0.0055).receiveShadow =
          true;
      }
    } catch {}
  door.updateMatrixWorld(true);
  const closerArm = new Vector3(0.12, 2.045, -doorT / 2 - 0.03).applyMatrix4(door.matrixWorld);
  const closerShoe = [doorX0 + 0.24, doorTopY + 0.022, innerZ1 - 0.022];
  const closerElbow = [doorX0 + 0.2, closerArm.y + 0.008, innerZ1 - 0.2];
  rod(mAlu, [closerArm.x, closerArm.y, closerArm.z], closerElbow, 0.007);
  rod(mAlu, closerElbow, closerShoe, 0.007);
  box(mAlu, 0.07, 0.02, 0.03, closerShoe[0], closerShoe[1], closerShoe[2] + 0.004);
  cyl(mRubber, 0.02, 0.035, doorX0 - 0.26, floorY + 0.022, innerZ1 - 0.93, {
    seg: 8
  });
  slab(
    mRubber,
    doorX0 + 0.08,
    floorY + 0.006,
    innerZ1 - 0.78,
    doorX1 - 0.06,
    floorY + 0.016,
    innerZ1 - 0.1,
    {
      bevel: 0.004,
      cast: false
    }
  );
  {
    const lampX = (doorX0 + doorX1) / 2;
    const lampY = doorTopY + 0.135;
    const lampZ = z1;
    box(matDark, 0.3, 0.13, 0.05, lampX, lampY, lampZ + 0.025, {
      bevel: 0.012
    });
    box(emBulb, 0.23, 0.08, 0.04, lampX, lampY, lampZ + 0.055, {
      cast: false,
      recv: false
    });
    for (const dy of [-0.028, 0, 0.028])
      box(matGalv, 0.27, 0.006, 0.006, lampX, lampY + dy, lampZ + 0.082, {
        cast: false
      });
    for (const dx of [-0.135, 0.135])
      box(matGalv, 0.006, 0.09, 0.05, lampX + dx, lampY, lampZ + 0.06, {
        cast: false
      });
  }
  slab(mAlu, -12.34, floorY + 1.42, z1, -11.76, floorY + 1.76, z1 + 0.004);
  fitLabel(
    'SITE OFFICE',
    0.095,
    -12.31,
    floorY + 1.655,
    z1 + 0.007,
    'z+',
    {
      color: 'black',
      font: 'sans',
      distress: 0.15
    },
    0.52
  );
  fitLabel(
    'BERTH 4 CONTROL',
    0.06,
    -12.31,
    floorY + 1.515,
    z1 + 0.007,
    'z+',
    {
      color: 'black',
      font: 'sans',
      distress: 0.15
    },
    0.52
  );
  kit.decal('hazard_general', 0.2, -12.2, floorY + 1.2, z1 + 0.003, 'z+');
  fitLabel(
    'AUTHORISED STAFF ONLY',
    0.04,
    -12.05,
    floorY + 1.2,
    z1 + 0.003,
    'z+',
    {
      color: 'red',
      font: 'sans',
      distress: 0.25
    },
    0.34
  );
  {
    const extZ = z1 + 0.085;
    const extY = floorY + 0.62;
    cyl(mRed, 0.065, 0.4, -10.425, extY + 0.2, extZ, {
      seg: 14
    });
    cyl(mRed, 0.065, 0.05, -10.425, extY + 0.425, extZ, {
      rTop: 0.03,
      seg: 14
    });
    cyl(matDark, 0.02, 0.05, -10.425, extY + 0.475, extZ, {
      seg: 8
    });
    box(matDark, 0.11, 0.016, 0.022, -10.425 + 0.03, extY + 0.505, extZ);
    box(matDark, 0.09, 0.014, 0.02, -10.425 + 0.035, extY + 0.535, extZ, {
      r: [0, 0, 0.25]
    });
    tube(
      mRubber,
      [
        [-10.425 - 0.02, extY + 0.47, extZ + 0.01],
        [-10.425 - 0.085, extY + 0.4, extZ + 0.01],
        [-10.425 - 0.082, extY + 0.2, extZ + 0.02],
        [-10.425 - 0.075, extY + 0.1, extZ + 0.02]
      ],
      0.008,
      {
        cast: false
      }
    );
    box(matGalv, 0.15, 0.03, 0.006, -10.425, extY + 0.3, extZ - 0.07);
    box(matGalv, 0.02, 0.5, 0.008, -10.425, extY + 0.25, z1 + 0.006);
    slab(
      mAlu,
      -10.425 - 0.045,
      extY + 0.13,
      extZ + 0.062,
      -10.425 + 0.045,
      extY + 0.27,
      extZ + 0.066,
      {
        cast: false
      }
    );
    slab(mRed, -10.425 - 0.085, floorY + 1.42, z1, -10.425 + 0.085, floorY + 1.62, z1 + 0.004);
    fitLabel(
      'FIRE',
      0.055,
      -10.425 - 0.07,
      floorY + 1.52,
      z1 + 0.007,
      'z+',
      {
        color: 'white',
        font: 'sans',
        distress: 0.1
      },
      0.14
    );
  }
  {
    const wallX = x1;
    const conduitX = wallX + 0.016;
    box(matFrame, 0.11, 0.45, 0.38, wallX + 0.055, floorY + 0.575, -24.11, {
      bevel: 0.012
    });
    slab(matDark, wallX + 0.11, floorY + 0.38, -24.275, wallX + 0.1115, floorY + 0.77, -24.268, {
      cast: false
    });
    box(mAlu, 0.012, 0.05, 0.02, wallX + 0.114, floorY + 0.575, -24.25);
    kit.decal('hazard_voltage', 0.16, wallX + 0.113, floorY + 0.6, -24.09, 'x+');
    rod(matGalv, [conduitX, floorY + 0.8, -23.96], [conduitX, doorTopY + 0.135, -23.96], 0.011);
    rod(
      matGalv,
      [conduitX, doorTopY + 0.135, -23.96],
      [conduitX, doorTopY + 0.135, z1 + 0.016],
      0.011
    );
    box(matGalv, 0.04, 0.04, 0.04, conduitX, doorTopY + 0.135, z1 + 0.016);
    rod(
      matGalv,
      [conduitX, doorTopY + 0.135, z1 + 0.016],
      [(doorX0 + doorX1) / 2 + 0.15, doorTopY + 0.135, z1 + 0.016],
      0.011
    );
    for (const y of [floorY + 1.1, floorY + 1.6, floorY + 2.05])
      box(matGalv, 0.012, 0.022, 0.05, wallX + 0.006, y, -23.96);
    rod(matGalv, [conduitX, floorY + 0.68, -24.3], [conduitX, floorY + 0.68, -25.84], 0.011);
    for (const z of [-24.7, -25.3])
      box(matGalv, 0.012, 0.05, 0.022, wallX + 0.006, floorY + 0.68, z);
    box(matFrame, 0.07, 0.14, 0.1, wallX + 0.035, floorY + 0.68, -25.89, {
      bevel: 0.008
    });
    cyl(mRed, 0.022, 0.02, wallX + 0.078, floorY + 0.68, -25.89, {
      axis: 'x',
      seg: 10
    });
    rod(matGalv, [conduitX, floorY + 0.35, -24.02], [conduitX, floorY + 0.06, -24.02], 0.011);
    rod(matGalv, [conduitX, floorY + 0.35, -24.12], [conduitX, floorY + 0.06, -24.12], 0.011);
    const trayX = deckX1 + 0.05;
    const trayZ = -24.12;
    const trayTop = deckY + 0.06;
    const trayBottom = 0.16;
    for (const side of [-1, 1])
      slab(
        matGalv,
        trayX - 0.022,
        trayBottom,
        trayZ + side * 0.15 - 0.008,
        trayX + 0.03,
        trayTop,
        trayZ + side * 0.15 + 0.008
      );
    for (let y = trayBottom + 0.14; y < trayTop - 0.05; y += 0.3)
      slab(matGalv, trayX - 0.016, y - 0.01, trayZ - 0.15, trayX + 0.004, y + 0.01, trayZ + 0.15);
    for (const y of [0.9, deckY - 0.5])
      slab(matGalv, deckX1 - 0.02, y - 0.02, trayZ - 0.19, trayX + 0.03, y + 0.02, trayZ - 0.158);
    box(matGalv, 0.14, 0.012, 0.4, trayX + 0.02, shed.FLOOR + 0.006, trayZ);
    const cableZs = [trayZ - 0.09, trayZ - 0.01, trayZ + 0.085];
    for (let i = 0; i < 3; i++)
      rod(
        mRubber,
        [trayX + 0.018, trayTop, cableZs[i]],
        [trayX + 0.018, 0.34, cableZs[i]],
        i ? 0.019 : 0.011,
        {
          cast: false
        }
      );
    tube(
      mRubber,
      [
        [trayX + 0.018, 0.36, cableZs[1]],
        [trayX + 0.03, 0.14, cableZs[1] - 0.05],
        [trayX + 0.16, 0.05, cableZs[1] - 0.5],
        [trayX + 0.1, 0.048, -25.6],
        [trayX + 0.32, 0.048, -26.7],
        [trayX + 0.22, 0.048, -27.45]
      ],
      0.022,
      {
        cast: false,
        radial: 5
      }
    );
    tube(
      mRubber,
      [
        [trayX + 0.018, 0.36, cableZs[2]],
        [trayX + 0.06, 0.1, cableZs[2] + 0.1],
        [trayX + 0.5, 0.05, cableZs[2] + 0.5],
        [trayX + 1.3, 0.05, cableZs[2] + 0.6]
      ],
      0.02,
      {
        cast: false,
        radial: 5
      }
    );
  }
  {
    const acX0 = x1 + 0.07;
    const acX1 = x1 + 0.37;
    const acZ = -26.4;
    const acY = floorY + 0.48;
    const acD = 0.8;
    const acH = 0.55;
    shadedRoundedBox(
      mPanel,
      acX1 - acX0,
      acH,
      acD,
      (acX0 + acX1) / 2,
      acY,
      acZ,
      exteriorShade,
      0.018
    );
    cyl(matDark, 0.215, 0.006, acX1 + 0.002, acY, acZ - 0.08, {
      axis: 'x',
      seg: 20,
      cast: false
    });
    for (const radius of [0.21, 0.14, 0.07]) {
      const ring = new TorusGeometry(radius, 0.006, 4, 20);
      ring.rotateY(Math.PI / 2);
      add(ring, matGalv, {
        p: [acX1 + 0.016, acY, acZ - 0.08],
        cast: false
      });
    }
    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 4;
      const dz = Math.cos(angle) * 0.21;
      const dy = Math.sin(angle) * 0.21;
      rod(
        matGalv,
        [acX1 + 0.016, acY - dy, acZ - 0.08 - dz],
        [acX1 + 0.016, acY + dy, acZ - 0.08 + dz],
        0.004,
        {
          cast: false,
          seg: 4
        }
      );
    }
    cyl(matDark, 0.045, 0.02, acX1 + 0.014, acY, acZ - 0.08, {
      axis: 'x',
      seg: 10
    });
    for (let i = 0; i < 6; i++)
      slab(
        matDark,
        acX0 + 0.03,
        acY - 0.2 + i * 0.07,
        acZ + acD / 2,
        acX1 - 0.03,
        acY - 0.185 + i * 0.07,
        acZ + acD / 2 + 0.0015,
        {
          cast: false
        }
      );
    for (const z of [acZ - 0.3, acZ + 0.3]) {
      slab(
        matGalv,
        x1 + 0.012,
        acY - acH / 2 - 0.035,
        z - 0.02,
        acX1 + 0.03,
        acY - acH / 2 - 0.005,
        z + 0.02
      );
      rod(matGalv, [acX1, acY - acH / 2 - 0.02, z], [x1 + 0.02, floorY - 0.22, z], 0.012, {
        seg: 5
      });
    }
    tube(
      mRubber,
      [
        [acX0 + 0.12, acY - 0.12, acZ + acD / 2],
        [acX0 + 0.12, acY - 0.1, acZ + acD / 2 + 0.07],
        [acX0 + 0.03, acY + 0.12, acZ + acD / 2 + 0.1],
        [x1 - 0.01, acY + 0.2, acZ + acD / 2 + 0.1]
      ],
      0.014,
      {
        cast: false
      }
    );
    tube(
      mRubber,
      [
        [x1 + 0.035, floorY + 0.63, -25.93],
        [x1 + 0.1, floorY + 0.5, -25.96],
        [acX0 + 0.2, acY - 0.05, acZ + acD / 2 - 0.002]
      ],
      0.008,
      {
        cast: false
      }
    );
    col(acX0, acY - acH / 2, acZ - acD / 2, acX1, acY + acH / 2, acZ + acD / 2, 'metal', {
      bulletOnly: true
    });
  }
  fitDecal('grime_streak', 0.26, 0.4, -14.5, sillY - 0.05, z1 + 0.003, 'z+');
  fitDecal('grime_streak', 0.22, 0.34, x1 + 0.003, sillY - 0.05, -25.3, 'x+');
  fitDecal('rust_run', 0.18, 0.3, x1 + 0.003, floorY + 0.2, -26.72, 'x+');
  fitDecal('rust_run', 0.16, 0.3, -15.42, ceilY - 0.02, z1 + 0.003, 'z+');
  fitDecal('leak_stain', 0.3, 0.26, x1 + 0.003, ceilY - 0.02, -26.9, 'x+');
  kit.place(
    'cardboard_boxes',
    -14.5,
    -26.3,
    0.35,
    {
      seed: 41
    },
    roofY,
    {
      colOpts: {
        noNav: true
      }
    }
  );
  box(matI('wood_pallet'), 2.4, 0.045, 0.095, -12.4, roofY + 0.024, -26.6, {
    r: [0, 0.12, 0]
  });
  box(matI('wood_pallet'), 2.1, 0.045, 0.095, -12.5, roofY + 0.024, -26.42, {
    r: [0, 0.07, 0]
  });
  box(matI('wood_pallet'), 1.8, 0.045, 0.095, -12.45, roofY + 0.069, -26.52, {
    r: [0, 0.2, 0]
  });
  for (const [y, radius] of [
    [0.022, 0.2],
    [0.06, 0.19]
  ]) {
    const ring = new TorusGeometry(radius, 0.02, 5, 16);
    ring.rotateX(Math.PI / 2);
    add(ring, mRubber, {
      p: [-11.2, roofY + y, -25.2]
    });
  }
  const deskTopY = floorY + office.DESK.h;
  const desk = office.DESK;
  const deskZ1 = innerZ0 + desk.d;
  box(emPanel, 1.16, 0.006, 0.56, lampPos[0], ceilY - 0.026, lampPos[2], {
    cast: false,
    recv: false
  });
  for (const side of [-1, 1]) {
    slab(
      mAlu,
      lampPos[0] - 0.6,
      ceilY - 0.034,
      lampPos[2] + side * 0.3 - 0.02,
      lampPos[0] + 0.6,
      ceilY - 0.02,
      lampPos[2] + side * 0.3 + 0.02,
      {
        cast: false
      }
    );
    slab(
      mAlu,
      lampPos[0] + side * 0.6 - 0.02,
      ceilY - 0.034,
      lampPos[2] - 0.3,
      lampPos[0] + side * 0.6 + 0.02,
      ceilY - 0.02,
      lampPos[2] + 0.3,
      {
        cast: false
      }
    );
  }
  shadedRoundedBox(mPanel, 0.2, 0.27, 0.8, innerX1 - 0.1, headY + 0.2, -26.4, interiorShade, 0.03);
  slab(matDark, innerX1 - 0.19, headY + 0.075, -26.75, innerX1 - 0.06, headY + 0.085, -26.05, {
    cast: false
  });
  shadedRoundedBox(
    mPanel,
    0.07,
    0.5,
    0.95,
    innerX1 - 0.045,
    floorY + 0.42,
    -25.5,
    interiorShade,
    0.012
  );
  for (let i = 0; i < 8; i++)
    slab(
      matDark,
      innerX1 - 0.07,
      floorY + 0.672,
      -25.92 + i * 0.11,
      innerX1 - 0.02,
      floorY + 0.674,
      -25.84 + i * 0.11,
      {
        cast: false
      }
    );
  shadedBox(
    mPanel,
    -15.1,
    floorY + 0.98,
    innerZ0,
    -11,
    floorY + 1.045,
    innerZ0 + 0.035,
    interiorShade,
    0.5,
    {
      cast: false
    }
  );
  shadedBox(
    mPanel,
    -11.19,
    floorY + 1.045,
    innerZ0,
    -11.13,
    ceilY - 0.02,
    innerZ0 + 0.03,
    interiorShade,
    0.5,
    {
      cast: false
    }
  );
  for (const x of [-14.45, -12.9, -11.6]) {
    shadedBox(
      mPanel,
      x - 0.075,
      floorY + 0.878,
      innerZ0,
      x + 0.075,
      floorY + 0.962,
      innerZ0 + 0.012,
      interiorShade
    );
    for (const dx of [-0.035, 0.035])
      box(matDark, 0.012, 0.02, 0.004, x + dx, floorY + 0.935, innerZ0 + 0.013, {
        cast: false
      });
  }
  shadedBox(
    mPanel,
    -10.512,
    floorY + 1.208,
    innerZ1 - 0.012,
    -10.428,
    floorY + 1.292,
    innerZ1,
    interiorShade
  );
  box(matDark, 0.012, 0.03, 0.004, -10.47, floorY + 1.25, innerZ1 - 0.013, {
    cast: false
  });
  slab(mWood, desk.x0, deskTopY - 0.032, innerZ0 + 0.01, desk.x1, deskTopY, deskZ1, {
    bevel: 0.008
  });
  for (const x of [desk.x0 + 0.04, desk.x1 - 0.04]) {
    slab(matDark, x - 0.02, floorY, innerZ0 + 0.06, x + 0.02, deskTopY - 0.032, deskZ1 - 0.06);
    slab(matDark, x - 0.03, floorY, innerZ0 + 0.04, x + 0.03, floorY + 0.02, deskZ1 - 0.02);
  }
  slab(
    matDark,
    desk.x0 + 0.06,
    floorY + 0.3,
    innerZ0 + 0.07,
    desk.x1 - 0.06,
    deskTopY - 0.05,
    innerZ0 + 0.085
  );
  box(matFrame, 0.42, 0.56, 0.58, desk.x1 - 0.3, floorY + 0.32, innerZ0 + 0.4, {
    bevel: 0.01
  });
  for (const y of [floorY + 0.23, floorY + 0.42])
    slab(matDark, desk.x1 - 0.5, y, deskZ1 - 0.071, desk.x1 - 0.1, y + 0.006, deskZ1 - 0.0695, {
      cast: false
    });
  for (const y of [floorY + 0.14, floorY + 0.33, floorY + 0.5])
    box(mAlu, 0.14, 0.014, 0.016, desk.x1 - 0.3, y, deskZ1 - 0.062);
  box(matDark, 0.19, 0.44, 0.42, desk.x0 + 0.3, floorY + 0.24, innerZ0 + 0.35, {
    bevel: 0.01
  });
  box(emAmber, 0.006, 0.006, 0.002, desk.x0 + 0.3, floorY + 0.4, innerZ0 + 0.561, {
    cast: false,
    recv: false
  });
  cyl(matDark, 0.13, 0.3, desk.x1 + 0.22, floorY + 0.15, innerZ0 + 0.22, {
    rTop: 0.15,
    seg: 12
  });
  tube(
    mRubber,
    [
      [desk.x0 + 0.3, floorY + 0.3, innerZ0 + 0.13],
      [desk.x0 + 0.5, floorY + 0.05, innerZ0 + 0.12],
      [desk.x0 + 1.2, floorY + 0.03, innerZ0 + 0.1],
      [desk.x0 + 1.25, floorY + 0.5, innerZ0 + 0.05],
      [desk.x0 + 1.25, floorY + 0.98, innerZ0 + 0.04]
    ],
    0.008,
    {
      cast: false
    }
  );
  /** Desk monitor; when `on`, its screen shows a fake dashboard of emissive rectangles. */
  function monitor(x: number, z: number, yaw: number, on: boolean): void {
    const group = pivot(x, deskTopY, z, yaw);
    const inGroup = {
      parent: group
    };
    box(matDark, 0.25, 0.012, 0.18, 0, 0.006, 0, {
      ...inGroup,
      bevel: 0.004
    });
    box(matDark, 0.05, 0.17, 0.03, 0, 0.09, -0.025, inGroup);
    box(matDark, 0.56, 0.335, 0.03, 0, 0.3, 0, {
      ...inGroup,
      bevel: 0.006
    });
    const screenZ = 0.0156;
    if (!on) {
      plane(group, mRubber, 0.53, 0.305, 0, 0.3, screenZ).receiveShadow = true;
      return;
    }
    const rect = (
      material: THREE.Material,
      rx0: number,
      ry0: number,
      rx1: number,
      ry1: number,
      layer = 1
    ): THREE.Mesh =>
      plane(
        group,
        material,
        Math.abs(rx1 - rx0),
        Math.abs(ry1 - ry0),
        (rx0 + rx1) / 2,
        0.3 + (ry0 + ry1) / 2,
        screenZ + layer * 0.0012
      );
    rect(emScreenDark, -0.265, -0.1525, 0.265, 0.1525, 0);
    rect(emScreen, -0.25, 0.128, -0.12, 0.14);
    rect(emGrey, -0.105, 0.13, -0.02, 0.138);
    rect(emAmber, 0.205, 0.128, 0.25, 0.14);
    rect(emGrey, -0.25, 0.1175, 0.25, 0.119);
    rect(emGrey, 0.082, -0.14, 0.0832, 0.11);
    rect(emScreen, -0.25, -0.0215, 0.07, -0.019);
    for (let i = 0; i < 5; i++)
      rect(emGrey, -0.25 + i * 0.08 - 8e-4, -0.032, -0.25 + i * 0.08 + 8e-4, -0.0215);
    rect(emGrey, -0.236, -0.012, -0.106, 0.014);
    rect(emGrey, -0.106, -0.006, -0.094, 0.008);
    rect(emAmber, -0.074, -0.012, 0.05, 0.017);
    rect(emAmber, 0.05, -0.006, 0.062, 0.011);
    rect(emScreenDark, -0.225, -0.004, -0.12, 0.006, 2);
    rect(emScreenDark, -0.066, -0.004, 0.04, 0.009, 2);
    for (const x of [-0.19, -0.035, 0.022]) {
      rect(emScreen, x - 0.002, -0.046, x + 0.002, 0.034, 3);
      rect(emScreen, x - 0.012, 0.031, x + 0.012, 0.034, 3);
    }
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 5; col++) {
        const rx = -0.245 + col * 0.063;
        const ry = -0.068 - row * 0.027;
        rect(
          (row * 5 + col) % 7 === 3 ? emAmber : (row + col) % 4 === 0 ? emScreen : emGrey,
          rx,
          ry - 0.018,
          rx + 0.05,
          ry
        );
      }
    rect(emGrey, -0.25, 0.09, -0.16, 0.097);
    rect(emGrey, -0.25, 0.074, -0.19, 0.08);
    rect(emGrey, -0.04, 0.09, 0.03, 0.097);
    const lineLengths = [0.11, 0.075, 0.125, 0.09, 0.06, 0.115, 0.082, 0.1];
    for (let i = 0; i < 8; i++) {
      const ry = 0.098 - i * 0.029;
      rect(
        i === 2 || i === 5 ? emAmber : i === 6 ? emGrey : emScreen,
        0.096,
        ry - 0.011,
        0.108,
        ry
      );
      rect(emGrey, 0.116, ry - 0.009, 0.116 + lineLengths[i], ry - 0.002);
    }
  }
  monitor(-13.86, innerZ0 + 0.24, 0.17, true);
  monitor(-13.22, innerZ0 + 0.22, -0.15, false);
  box(matDark, 0.44, 0.02, 0.14, -13.56, deskTopY + 0.012, innerZ0 + 0.56, {
    bevel: 0.005,
    r: [0.03, 0.04, 0]
  });
  box(mRubber, 0.4, 0.004, 0.1, -13.56, deskTopY + 0.024, innerZ0 + 0.555, {
    r: [0.03, 0.04, 0],
    cast: false
  });
  box(matDark, 0.06, 0.03, 0.1, -13.22, deskTopY + 0.015, innerZ0 + 0.58, {
    bevel: 0.012,
    r: [0, -0.2, 0]
  });
  const mug = (x: number, y: number, z: number, material: THREE.Material): void => {
    cyl(material, 0.04, 0.09, x, y + 0.045, z, {
      seg: 12
    });
    cyl(matDark, 0.034, 0.004, x, y + 0.089, z, {
      seg: 12,
      cast: false
    });
    box(material, 0.012, 0.05, 0.03, x + 0.03, y + 0.048, z + 0.035);
  };
  mug(-12.98, deskTopY, innerZ0 + 0.52, mTeal);
  box(matDark, 0.27, 0.085, 0.2, -14.55, deskTopY + 0.043, innerZ0 + 0.2, {
    bevel: 0.008
  });
  box(mRubber, 0.11, 0.05, 0.004, -14.6, deskTopY + 0.045, innerZ0 + 0.302, {
    cast: false
  });
  box(emAmber, 0.02, 0.008, 0.002, -14.49, deskTopY + 0.06, innerZ0 + 0.301, {
    cast: false,
    recv: false
  });
  cyl(matDark, 0.012, 0.012, -14.46, deskTopY + 0.035, innerZ0 + 0.303, {
    axis: 'z',
    seg: 8
  });
  rod(
    mRubber,
    [-14.44, deskTopY + 0.085, innerZ0 + 0.13],
    [-14.44, deskTopY + 0.33, innerZ0 + 0.13],
    0.005,
    {
      cast: false
    }
  );
  box(matDark, 0.06, 0.035, 0.09, -14.3, deskTopY + 0.018, innerZ0 + 0.36, {
    bevel: 0.01,
    r: [0, 0.4, 0]
  });
  tube(
    mRubber,
    [
      [-14.42, deskTopY + 0.03, innerZ0 + 0.3],
      [-14.38, deskTopY + 0.012, innerZ0 + 0.4],
      [-14.31, deskTopY + 0.02, innerZ0 + 0.41]
    ],
    0.004,
    {
      cast: false
    }
  );
  {
    const clipboard = pivot(-14.4, deskTopY, innerZ0 + 0.56, 0.3);
    box(mWood, 0.23, 0.006, 0.32, 0, 0.003, 0, {
      parent: clipboard
    });
    box(mPanel, 0.21, 0.003, 0.29, 0, 0.0075, 0.008, {
      parent: clipboard,
      cast: false
    });
    box(mAlu, 0.1, 0.012, 0.03, 0, 0.014, -0.14, {
      parent: clipboard
    });
  }
  box(matDark, 0.25, 0.05, 0.33, -12.72, deskTopY + 0.025, innerZ0 + 0.22, {
    bevel: 0.006
  });
  box(mPanel, 0.22, 0.012, 0.3, -12.72, deskTopY + 0.054, innerZ0 + 0.22, {
    r: [0, 0.06, 0],
    cast: false
  });
  {
    const hatZ = innerZ0 + 0.5;
    const shell = new SphereGeometry(0.115, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    shell.scale(1, 0.95, 1.18);
    add(shell, mYellow, {
      p: [-12.47, deskTopY + 0.03, hatZ],
      r: [0, 0.5, 0]
    });
    cyl(mYellow, 0.125, 0.03, -12.47, deskTopY + 0.016, hatZ, {
      seg: 14,
      r: [0, 0.5, 0]
    });
    box(mYellow, 0.2, 0.01, 0.1, -12.47 + 0.09, deskTopY + 0.012, hatZ + 0.05, {
      bevel: 0.004,
      r: [0, 0.5, 0]
    });
    box(mYellow, 0.02, 0.022, 0.25, -12.47, deskTopY + 0.128, hatZ, {
      bevel: 0.008,
      r: [0, 0.5, 0]
    });
  }
  {
    const chair = pivot(-13.52, floorY, -25.93, 0.5);
    const inChair = {
      parent: chair
    };
    for (let i = 0; i < 5; i++) {
      const angle = (i * Math.PI * 2) / 5 + 0.3;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      rod(matDark, [0, 0.1, 0], [cos * 0.29, 0.065, sin * 0.29], 0.017, {
        ...inChair,
        seg: 5
      });
      cyl(mRubber, 0.027, 0.04, cos * 0.29, 0.027, sin * 0.29, {
        ...inChair,
        axis: 'x',
        seg: 8
      });
    }
    cyl(mAlu, 0.024, 0.32, 0, 0.26, 0, {
      ...inChair,
      seg: 8
    });
    box(matDark, 0.2, 0.03, 0.2, 0, 0.425, 0, inChair);
    box(mRubber, 0.47, 0.075, 0.45, 0, 0.475, 0, {
      ...inChair,
      bevel: 0.025
    });
    box(mRubber, 0.43, 0.5, 0.06, 0, 0.86, 0.225, {
      ...inChair,
      bevel: 0.025,
      r: [0.14, 0, 0]
    });
    box(matDark, 0.05, 0.3, 0.02, 0, 0.62, 0.245, {
      ...inChair,
      r: [0.1, 0, 0]
    });
    for (const side of [-1, 1]) {
      box(matDark, 0.02, 0.2, 0.03, side * 0.255, 0.56, 0.05, inChair);
      box(mRubber, 0.05, 0.03, 0.26, side * 0.255, 0.67, 0.02, inChair);
    }
  }
  {
    const cx0 = innerX0 + 0.02;
    const cx1 = innerX0 + 0.49;
    const cz0 = innerZ0 + 0.02;
    const cz1 = innerZ0 + 0.64;
    const cabinetH = 1.32;
    box(
      matFrame,
      cx1 - cx0,
      cabinetH,
      cz1 - cz0,
      (cx0 + cx1) / 2,
      floorY + cabinetH / 2,
      (cz0 + cz1) / 2,
      {
        bevel: 0.012
      }
    );
    for (let i = 0; i < 4; i++) {
      const drawerY = floorY + 0.04 + i * 0.315;
      if (i)
        slab(
          matDark,
          cx0 + 0.015,
          drawerY - 0.004,
          cz1,
          cx1 - 0.015,
          drawerY + 0.004,
          cz1 + 0.0015,
          {
            cast: false
          }
        );
      box(mAlu, 0.15, 0.016, 0.018, (cx0 + cx1) / 2, drawerY + 0.23, cz1 + 0.012);
      slab(
        mPanel,
        (cx0 + cx1) / 2 - 0.04,
        drawerY + 0.13,
        cz1,
        (cx0 + cx1) / 2 + 0.04,
        drawerY + 0.17,
        cz1 + 0.002,
        {
          cast: false
        }
      );
    }
    const topY = floorY + cabinetH;
    const trayCx = (cx0 + cx1) / 2;
    const trayCz = cz0 + 0.46;
    box(matDark, 0.42, 0.05, 0.2, trayCx, topY + 0.025, trayCz, {
      bevel: 0.008
    });
    for (let i = 0; i < 4; i++) {
      const slotX = trayCx - 0.15 + i * 0.1;
      if (i !== 2) {
        box(matDark, 0.058, 0.13, 0.036, slotX, topY + 0.105, trayCz - 0.01, {
          r: [-0.12, 0, 0]
        });
        rod(
          mRubber,
          [slotX + 0.018, topY + 0.16, trayCz - 0.02],
          [slotX + 0.018, topY + 0.26, trayCz - 0.035],
          0.005,
          {
            cast: false
          }
        );
        cyl(matDark, 0.008, 0.014, slotX - 0.015, topY + 0.175, trayCz - 0.022, {
          seg: 6
        });
      }
      box(i === 2 ? emGrey : emAmber, 0.008, 0.004, 0.002, slotX, topY + 0.03, trayCz + 0.101, {
        cast: false,
        recv: false
      });
    }
    const binders: [number, THREE.Material, number][] = [
      [-0.1, mTeal, 0.3],
      [-0.03, mRed, 0.29],
      [0.04, matFrame, 0.31],
      [0.11, mTeal, 0.3]
    ];
    for (const [dx, material, h] of binders)
      box(material, 0.062, h, 0.24, trayCx + dx, topY + h / 2, cz0 + 0.16, {
        r: [0, 0, dx > 0.1 ? 0.08 : 0]
      });
    col(innerX0, floorY, innerZ0, cx1 + 0.01, floorY + cabinetH, cz1 + 0.01, 'metal');
  }
  {
    const lockerX = innerX0 + 0.46;
    const lz0 = -26.36;
    const lz1 = -25.14;
    const lockerH = 1.8;
    box(
      mTeal,
      lockerX - innerX0 - 0.01,
      lockerH,
      lz1 - lz0,
      (innerX0 + 0.01 + lockerX) / 2,
      floorY + 0.03 + lockerH / 2,
      (lz0 + lz1) / 2,
      {
        bevel: 0.01
      }
    );
    slab(matDark, innerX0 + 0.04, floorY, lz0 + 0.03, lockerX - 0.03, floorY + 0.03, lz1 - 0.03);
    slab(
      matDark,
      lockerX,
      floorY + 0.05,
      (lz0 + lz1) / 2 - 0.004,
      lockerX + 0.0015,
      floorY + lockerH + 0.01,
      (lz0 + lz1) / 2 + 0.004,
      {
        cast: false
      }
    );
    for (const side of [-1, 1]) {
      const doorZ = (lz0 + lz1) / 2 + side * 0.305;
      for (const ventY of [floorY + 0.2, floorY + 1.6])
        for (let i = 0; i < 3; i++)
          slab(
            matDark,
            lockerX,
            ventY + i * 0.035,
            doorZ - 0.11,
            lockerX + 0.0015,
            ventY + i * 0.035 + 0.012,
            doorZ + 0.11,
            {
              cast: false
            }
          );
      box(mAlu, 0.02, 0.11, 0.022, lockerX + 0.01, floorY + 1, (lz0 + lz1) / 2 + side * 0.06);
      fitLabel(side < 0 ? '08' : '07', 0.05, doorZ + 0.04, floorY + 1.45, lockerX + 0.003, 'x+', {
        color: 'white',
        font: 'stencil',
        distress: 0.3
      });
    }
    col(innerX0, floorY, lz0, lockerX, floorY + lockerH + 0.03, lz1, 'metal');
  }
  {
    const counterX = innerX0 + 0.5;
    const counterZ0 = innerZ1 - 0.92;
    const counterZ1 = innerZ1 - 0.01;
    const counterH = 0.84;
    box(
      matFrame,
      counterX - innerX0 - 0.03,
      counterH - 0.03,
      counterZ1 - counterZ0 - 0.02,
      (innerX0 + 0.01 + counterX - 0.02) / 2,
      floorY + (counterH - 0.03) / 2,
      (counterZ0 + counterZ1) / 2,
      {
        bevel: 0.008
      }
    );
    slab(
      mWood,
      innerX0 + 0.005,
      floorY + counterH - 0.03,
      counterZ0 - 0.01,
      counterX + 0.01,
      floorY + counterH,
      counterZ1,
      {
        bevel: 0.008
      }
    );
    slab(
      matDark,
      counterX - 0.02,
      floorY + 0.06,
      (counterZ0 + counterZ1) / 2 - 0.003,
      counterX - 0.0185,
      floorY + counterH - 0.05,
      (counterZ0 + counterZ1) / 2 + 0.003,
      {
        cast: false
      }
    );
    for (const side of [-1, 1])
      box(
        mAlu,
        0.016,
        0.1,
        0.014,
        counterX - 0.012,
        floorY + 0.62,
        (counterZ0 + counterZ1) / 2 + side * 0.05
      );
    const topY = floorY + counterH;
    const kettleX = innerX0 + 0.24;
    const kettleZ = counterZ0 + 0.25;
    cyl(mAlu, 0.075, 0.17, kettleX, topY + 0.085, kettleZ, {
      rTop: 0.062,
      seg: 14
    });
    cyl(matDark, 0.064, 0.02, kettleX, topY + 0.18, kettleZ, {
      seg: 14
    });
    cyl(matDark, 0.085, 0.02, kettleX, topY + 0.01, kettleZ, {
      seg: 14
    });
    box(matDark, 0.02, 0.13, 0.03, kettleX + 0.01, topY + 0.1, kettleZ + 0.095);
    box(mAlu, 0.03, 0.03, 0.05, kettleX - 0.01, topY + 0.15, kettleZ - 0.085);
    mug(innerX0 + 0.3, topY, counterZ0 + 0.52, mPanel);
    mug(innerX0 + 0.18, topY, counterZ0 + 0.62, mRed);
    box(mCardboard, 0.14, 0.2, 0.09, innerX0 + 0.12, topY + 0.1, counterZ0 + 0.8, {
      r: [0, 0.2, 0]
    });
    col(innerX0, floorY, counterZ0 - 0.01, counterX + 0.01, floorY + counterH, innerZ1, 'wood');
  }
  {
    const boardX = innerX0;
    const boardZ0 = -24.74;
    const boardZ1 = -24;
    const boardY0 = floorY + 1.12;
    const boardY1 = floorY + 1.74;
    slab(
      mAlu,
      boardX,
      boardY0 - 0.02,
      boardZ0 - 0.02,
      boardX + 0.012,
      boardY1 + 0.02,
      boardZ1 + 0.02
    );
    slab(mCardboard, boardX + 0.012, boardY0, boardZ0, boardX + 0.016, boardY1, boardZ1, {
      cast: false
    });
    const pinPaper = (z: number, y: number, w: number, h: number, tilt: number): THREE.Mesh =>
      box(mPanel, 0.002, h, w, boardX + 0.018, y, z, {
        r: [tilt, 0, 0],
        cast: false
      });
    pinPaper(boardZ0 + 0.16, boardY1 - 0.2, 0.21, 0.297, 0.03);
    pinPaper(boardZ0 + 0.42, boardY1 - 0.2, 0.21, 0.297, -0.02);
    pinPaper(boardZ0 + 0.63, boardY1 - 0.15, 0.18, 0.15, 0.04);
    pinPaper(boardZ0 + 0.6, boardY0 + 0.14, 0.16, 0.2, -0.05);
    pinPaper(boardZ0 + 0.3, boardY0 + 0.08, 0.3, 0.1, 0.01);
    fitLabel(
      'SAFETY NOTICE',
      0.035,
      boardZ0 + 0.71,
      boardY1 - 0.11,
      boardX + 0.021,
      'x+',
      {
        color: 'red',
        font: 'sans',
        distress: 0.1
      },
      0.16
    );
    fitLabel(
      'TIDE TABLE',
      0.03,
      boardZ0 + 0.515,
      boardY1 - 0.09,
      boardX + 0.021,
      'x+',
      {
        color: 'black',
        font: 'sans',
        distress: 0.1
      },
      0.18
    );
    fitLabel(
      'MUSTER  GATE 1',
      0.03,
      boardZ0 + 0.44,
      boardY0 + 0.085,
      boardX + 0.021,
      'x+',
      {
        color: 'black',
        font: 'sans',
        distress: 0.1
      },
      0.27
    );
    kit.decal('hazard_general', 0.1, boardX + 0.021, boardY0 + 0.16, boardZ0 + 0.6, 'x+');
    for (let i = 0; i < 6; i++) {
      slab(
        matDark,
        boardX + 0.019,
        boardY1 - 0.15 - i * 0.03,
        boardZ0 + 0.37 - (i % 2) * 0.03,
        boardX + 0.0195,
        boardY1 - 0.147 - i * 0.03,
        boardZ0 + 0.51,
        {
          cast: false
        }
      );
      slab(
        matDark,
        boardX + 0.019,
        boardY1 - 0.1 - i * 0.035,
        boardZ0 + 0.08 + (i % 3) * 0.02,
        boardX + 0.0195,
        boardY1 - 0.097 - i * 0.035,
        boardZ0 + 0.25,
        {
          cast: false
        }
      );
    }
    box(mGreen, 0.09, 0.26, 0.3, boardX + 0.045, floorY + 1.45, -24.96, {
      bevel: 0.01
    });
    slab(mPanel, boardX + 0.09, floorY + 1.43, -25.025, boardX + 0.092, floorY + 1.47, -24.895, {
      cast: false
    });
    slab(mPanel, boardX + 0.09, floorY + 1.385, -24.98, boardX + 0.092, floorY + 1.515, -24.94, {
      cast: false
    });
  }
  {
    const planY0 = floorY + 1.3;
    const planY1 = floorY + 2;
    const planZ = innerZ0;
    slab(mAlu, -14.8 - 0.02, planY0 - 0.02, planZ, -13.62 + 0.02, planY1 + 0.02, planZ + 0.014);
    shadedBox(
      mPanel,
      -14.8,
      planY0,
      planZ + 0.014,
      -13.62,
      planY1,
      planZ + 0.018,
      interiorShade,
      0.3,
      {
        cast: false
      }
    );
    const planRect = (
      material: THREE.Material,
      u0: number,
      v0: number,
      u1: number,
      v1: number,
      layer = 1
    ): THREE.Mesh =>
      slab(
        material,
        -14.8 + u0,
        planY1 - v1,
        planZ + 0.018,
        -14.8 + u1,
        planY1 - v0,
        planZ + 0.018 + 0.0012 * layer,
        {
          cast: false
        }
      );
    fitLabel(
      'BERTH 4  YARD PLAN',
      0.045,
      -14.8 + 0.04,
      planY1 - 0.05,
      planZ + 0.021,
      'z+',
      {
        color: 'black',
        font: 'sans',
        distress: 0.1
      },
      0.6
    );
    planRect(mTeal, 0.03, 0.1, 1.15, 0.27);
    planRect(matDark, 0.03, 0.27, 1.15, 0.278, 2);
    planRect(matFrame, 0.1, 0.15, 0.5, 0.225, 2);
    planRect(mRed, 0.6, 0.15, 1, 0.225, 2);
    for (const u of [0.2, 0.68, 0.86]) planRect(mYellow, u, 0.24, u + 0.03, 0.31, 3);
    const boxColors = [mTeal, matFrame, mYellow, mRed, matFrame, mTeal, matFrame];
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 7; col++)
        if ((row * 7 + col) % 5 !== 4)
          planRect(
            boxColors[(col + row * 3) % 7],
            0.05 + col * 0.155,
            0.33 + row * 0.075,
            0.05 + col * 0.155 + 0.13,
            0.385 + row * 0.075,
            2
          );
    planRect(matDark, 0.05, 0.57, 0.5, 0.66, 2);
    fitLabel('SHED', 0.035, -14.8 + 0.08, planY1 - 0.615, planZ + 0.0215, 'z+', {
      color: 'white',
      font: 'stencil',
      distress: 0.2
    });
    planRect(matDark, 0.6, 0.6, 1.12, 0.606, 2);
    planRect(matDark, 0.6, 0.63, 0.98, 0.636, 2);
    for (const [u, v] of [
      [0.02, 0.02],
      [1.16, 0.02],
      [0.02, 0.68],
      [1.16, 0.68]
    ])
      cyl(mRed, 0.008, 0.008, -14.8 + u, planY1 - v, planZ + 0.022, {
        axis: 'z',
        seg: 6,
        cast: false
      });
    const wbX0 = -13.42;
    const wbX1 = -11.92;
    const wbY0 = floorY + 1.25;
    const wbY1 = floorY + 2;
    slab(mAlu, wbX0 - 0.02, wbY0 - 0.02, planZ, wbX1 + 0.02, wbY1 + 0.02, planZ + 0.014);
    shadedBox(
      mPanel,
      wbX0,
      wbY0,
      planZ + 0.014,
      wbX1,
      wbY1,
      planZ + 0.018,
      (x: number, y: number, z: number) => {
        const c = interiorShade(x, y, z);
        return [c[0] * 1.12, c[1] * 1.12, c[2] * 1.12];
      },
      0.3,
      {
        cast: false
      }
    );
    slab(mAlu, wbX0 + 0.3, wbY0 - 0.04, planZ, wbX1 - 0.3, wbY0 - 0.02, planZ + 0.06);
    cyl(mRed, 0.008, 0.12, wbX0 + 0.5, wbY0 - 0.012, planZ + 0.04, {
      axis: 'x',
      seg: 6
    });
    cyl(matDark, 0.008, 0.12, wbX0 + 0.66, wbY0 - 0.012, planZ + 0.035, {
      axis: 'x',
      seg: 6
    });
    box(mRubber, 0.11, 0.03, 0.045, wbX1 - 0.45, wbY0 - 0.005, planZ + 0.035);
    const wbLine = (u0: number, v0: number, u1: number, v1: number): THREE.Mesh =>
      slab(matDark, wbX0 + u0, wbY1 - v1, planZ + 0.018, wbX0 + u1, wbY1 - v0, planZ + 0.0188, {
        cast: false
      });
    for (const v of [0.14, 0.28, 0.42, 0.56]) wbLine(0.04, v, 1.46, v + 0.004);
    wbLine(0.52, 0.14, 0.524, 0.7);
    wbLine(1.02, 0.14, 1.024, 0.7);
    const inkBlack = {
      color: 'black',
      font: 'sans',
      distress: 0.2
    };
    const inkRed = {
      color: 'red',
      font: 'sans',
      distress: 0.2
    };
    fitLabel(
      'BERTH 4  NIGHT SHIFT',
      0.06,
      wbX0 + 0.06,
      wbY1 - 0.075,
      planZ + 0.021,
      'z+',
      inkBlack,
      0.7
    );
    [
      ['MV TESSALY', 'ETA 0540', 'PILOT 0500'],
      ['CRANE 2', 'SPREADER FAULT', 'TAG OUT'],
      ['RELAY B', 'SHED MEZZ', 'CHECK 0300'],
      ['GATE 1', 'CLOSED 2200', '']
    ].forEach((row, index) => {
      const rowY = wbY1 - 0.21 - index * 0.14;
      fitLabel(row[0], 0.05, wbX0 + 0.06, rowY, planZ + 0.021, 'z+', inkBlack, 0.42);
      fitLabel(
        row[1],
        0.05,
        wbX0 + 0.56,
        rowY,
        planZ + 0.021,
        'z+',
        index === 1 ? inkRed : inkBlack,
        0.42
      );
      if (row[2])
        fitLabel(
          row[2],
          0.05,
          wbX0 + 1.06,
          rowY,
          planZ + 0.021,
          'z+',
          index === 1 ? inkRed : inkBlack,
          0.38
        );
    });
    const clockX = -11.5;
    const clockY = floorY + 1.88;
    cyl(mAlu, 0.15, 0.035, clockX, clockY, planZ + 0.0175, {
      axis: 'z',
      seg: 20
    });
    shadedCyl(mPanel, 0.135, 0.004, clockX, clockY, planZ + 0.037, 'z', interiorShade, 20);
    box(matDark, 0.009, 0.085, 0.003, clockX - 0.03, clockY + 0.028, planZ + 0.041, {
      r: [0, 0, 0.8],
      cast: false
    });
    box(matDark, 0.007, 0.115, 0.003, clockX + 0.012, clockY + 0.052, planZ + 0.042, {
      r: [0, 0, -0.22],
      cast: false
    });
    for (let i = 0; i < 12; i++) {
      const angle = (i * Math.PI) / 6;
      box(
        matDark,
        0.006,
        0.018,
        0.002,
        clockX + Math.sin(angle) * 0.118,
        clockY + Math.cos(angle) * 0.118,
        planZ + 0.04,
        {
          r: [0, 0, -angle],
          cast: false
        }
      );
    }
  }
  {
    const heaterX = innerX1 - 0.06;
    const heaterY = sillY;
    const heaterZ = -25.1;
    for (const dz of [-0.035, 0.035]) {
      cyl(matDark, 0.028, 0.13, heaterX + dz * 0.3, heaterY + 0.03, heaterZ + dz, {
        axis: 'x',
        seg: 10
      });
      cyl(matDark, 0.034, 0.04, heaterX + 0.05 + dz * 0.3, heaterY + 0.035, heaterZ + dz, {
        axis: 'x',
        seg: 10
      });
    }
    box(matDark, 0.05, 0.02, 0.05, heaterX, heaterY + 0.04, heaterZ);
    mug(heaterX - 0.01, heaterY, -26.2, matFrame);
  }
  // Bake the interior lighting into vertex colours of every opaque standard-material
  // mesh added by the office whose centre lies inside the office.
  {
    const tmpVec = new Vector3();
    const bounds = new Box3();
    const center = new Vector3();
    for (let i = firstChild; i < kit.staticRoot.children.length; i++)
      kit.staticRoot.children[i].traverse((child) => {
        const object = child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
        if (
          !object.isMesh ||
          !object.material ||
          !object.material.isMeshStandardMaterial ||
          object.material.transparent ||
          object.geometry.attributes.color
        )
          return;
        object.updateWorldMatrix(true, false);
        bounds
          .setFromBufferAttribute(object.geometry.attributes.position as THREE.BufferAttribute)
          .applyMatrix4(object.matrixWorld)
          .getCenter(center);
        if (
          center.x < innerX0 ||
          center.x > innerX1 ||
          center.z < innerZ0 ||
          center.z > innerZ1 ||
          center.y < floorY - 0.01 ||
          center.y > ceilY
        )
          return;
        if (!object.material.vertexColors) {
          let variant: THREE.Material | null = null;
          try {
            variant = game.mats.get(object.material.name, {
              ...(object.material.userData && object.material.userData.interior
                ? {
                    interior: true
                  }
                : {}),
              vertexColors: true
            });
          } catch {
            variant = null;
          }
          if (!variant || !variant.vertexColors) return;
          (object as THREE.Mesh).material = variant;
        }
        const position = object.geometry.attributes.position;
        const colors = new Float32Array(position.count * 3);
        for (let i = 0; i < position.count; i++) {
          tmpVec.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
          const c = interiorShade(tmpVec.x, tmpVec.y, tmpVec.z);
          colors[i * 3] = c[0];
          colors[i * 3 + 1] = c[1];
          colors[i * 3 + 2] = c[2];
        }
        object.geometry.setAttribute('color', new BufferAttribute(colors, 3));
      });
  }
  const wallCol = (
    cx0: number,
    cy0: number,
    cz0: number,
    cx1: number,
    cy1: number,
    cz1: number,
    opts?: Record<string, unknown>
  ): unknown =>
    col(cx0, cy0, cz0, cx1, cy1, cz1, 'metal', {
      noNav: true,
      ...(opts || {})
    });
  wallCol(x0, floorY, z0, innerX0, roofY, z1);
  wallCol(x0, floorY, z0, x1, roofY, innerZ0);
  wallCol(innerX1, floorY, z0, x1, roofY, sideWinZ0);
  wallCol(innerX1, floorY, sideWinZ1, x1, roofY, z1);
  wallCol(innerX1, floorY, sideWinZ0, x1, sillY + 0.05, sideWinZ1);
  wallCol(innerX1, headY - 0.05, sideWinZ0, x1, roofY, sideWinZ1);
  wallCol(x0, floorY, innerZ1, frontWinX0, roofY, z1);
  wallCol(frontWinX0, floorY, innerZ1, frontWinX1, sillY + 0.05, z1);
  wallCol(frontWinX0, headY - 0.05, innerZ1, frontWinX1, roofY, z1);
  wallCol(frontWinX1, floorY, innerZ1, doorX0, roofY, z1);
  wallCol(doorX0, doorTopY, innerZ1, doorX1, roofY, z1);
  wallCol(doorX1, floorY, innerZ1, x1, roofY, z1);
  wallCol(x0 - 0.03, ceilY, z0 - 0.02, x1 + 0.05, roofY, z1 + 0.05);
  col(innerX1 + 0.02, sillY + 0.05, sideWinZ0, x1 - 0.02, headY - 0.05, sideWinZ1, 'glass', {
    noNav: true,
    playerOnly: true
  });
  col(frontWinX0, sillY + 0.05, innerZ1 + 0.02, frontWinX1, headY - 0.05, z1 - 0.02, 'glass', {
    noNav: true,
    playerOnly: true
  });
  wallCol(doorX0 - 0.18, floorY, innerZ1 - 1, doorX0 + 0.01, floorY + 2.085, innerZ1);
  col(desk.x0, floorY, innerZ0, desk.x1, deskTopY, deskZ1, 'wood', {
    noNav: true
  });
  col(-13.76, floorY, -26.17, -13.28, floorY + 0.5, -25.69, 'rubber', {
    noNav: true
  });
  const walkZ = deckZ1 + 0.6;
  kit.catwalk(
    -14.25,
    walkZ,
    0,
    deckY - 0.05,
    {
      seed: 2
    },
    [false, true]
  );
  kit.catwalk(
    -11.25,
    walkZ,
    0,
    deckY - 0.05,
    {
      seed: 3
    },
    [false, true]
  );
  for (const x of [-15.6, -12.75, -9.85]) {
    box(matFrame, 0.1, deckY - 0.12, 0.1, x, (deckY - 0.12) / 2, walkZ + 0.5, {
      bevel: 0.01
    });
    box(matDark, 0.24, 0.016, 0.24, x, shed.FLOOR + 0.008, walkZ + 0.5);
  }
  slab(matFrame, -15.75, deckY - 0.26, walkZ + 0.44, -9.75, deckY - 0.12, walkZ + 0.56);
  for (const x of [-12.75, -9.85])
    for (const side of [-1, 1])
      if (!(x + side * 0.6 > -9.75))
        rod(
          matFrame,
          [x + side * 0.04, deckY - 0.9, walkZ + 0.5],
          [x + side * 0.6, deckY - 0.27, walkZ + 0.5],
          0.024,
          {
            seg: 6
          }
        );
  kit.stairs(-8.25, walkZ, Math.PI, 0, {
    seed: 4
  });
  kit.metalRects.push([deckX0, deckZ0, -6.7, walkZ + 0.6]);
  {
    const railZ = deckZ1 + 0.02;
    const railX0 = x1 + 0.04;
    const railX1 = -9.77;
    for (const x of [railX0 + 0.03, railX1 - 0.03])
      box(mYellowExt, 0.045, 1.07, 0.045, x, deckY + 0.535, railZ, {
        bevel: 0.006
      });
    rod(mYellowExt, [railX0, deckY + 1.05, railZ], [railX1, deckY + 1.05, railZ], 0.021, {
      seg: 7
    });
    rod(mYellowExt, [railX0, deckY + 0.55, railZ], [railX1, deckY + 0.55, railZ], 0.016, {
      seg: 6
    });
    slab(matDark, railX0, deckY, railZ - 0.004, railX1, deckY + 0.1, railZ + 0.004);
    col(x1, deckY, railZ - 0.035, -9.75, deckY + 1.05, railZ + 0.035, 'metal', {
      noNav: true
    });
  }
}
/** Shed footprint and heights (world metres). */
export const SHED = {
  X0: -16,
  X1: 12,
  Z0: -28,
  Z1: -11,
  EAVE: 7,
  RIDGE: 9.5,
  ZR: -19.5,
  FLOOR: 0.03
};
/** X positions of the portal frames (bay boundaries) along the shed. */
export const SHED_BAY_X = [-16, -11.1, -6.2, -0.8, 5.6, 12];
/** Roller door opening in the north (Z1) wall. */
export const SHED_ROLLER_DOOR = {
  x0: -6,
  x1: -1,
  h: 5
};
/** Side door opening in the east (X1) wall. */
export const SHED_SIDE_DOOR = {
  z0: -22,
  z1: -17,
  h: 4.5
};
/** Skylight panels: [slope 'S'|'N', row index, column index]. */
export const SHED_ROOF_SKYLIGHTS: [string, number, number][] = [
  ['S', 1, 4],
  ['S', 2, 5],
  ['S', 1, 11],
  ['S', 2, 15],
  ['S', 3, 8],
  ['N', 2, 7],
  ['N', 1, 13],
  ['N', 3, 17]
];
/** Fractions of the half-span (eave = 0 .. ridge = 1) where roof sheet rows start/end. */
export const SHED_ROOF_ROW_BREAKS = [-0.04, 0.25, 0.5, 0.75, 1];
export const SHED_ROOF_COLUMNS = 20;
/** A roof skylight opening (centre, width along X, depth along the slope). */
export interface ShedSkylight {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
}

/** What {@link buildShed} returns. */
export interface ShedBuild {
  /** Spinning wall-fan group (dynamic, not merged). */
  fan: THREE.Group;
  lights: THREE.PointLight[];
  skylights: ShedSkylight[];
  relayPos: THREE.Vector3;
  update(dt: number): void;
}

/** Builds the shed (structure, doors, roof, lights, interior props) and the site office. */
export function buildShed(kit: LevelKit): ShedBuild {
  const { M: mat, MI: matI, box, slab, cyl, rod, ibeam, col, add, G: game } = kit;
  const {
    X0: x0,
    X1: x1,
    Z0: z0,
    Z1: z1,
    EAVE: eave,
    RIDGE: ridge,
    ZR: ridgeZ,
    FLOOR: floorY
  } = SHED;
  const halfSpan = (z1 - z0) / 2;
  const rise = ridge - eave;
  const pitch = Math.atan2(rise, halfSpan);
  const rafterLen = Math.hypot(halfSpan, rise);
  const roofY = (z: number): number => eave + rise * (1 - Math.abs(z - ridgeZ) / halfSpan);
  const mRoof = mat('corrugated_roof');
  const mRoofIn = matI('corrugated_roof');
  const mConcrete = mat('concrete');
  const mWall = matI('concrete_painted');
  const mPaint = matI('paint_grey');
  const mGalvIn = matI('steel_galv');
  const mGalv = mat('steel_galv');
  const mDark = matI('steel_dark');
  const wallT = 0.25;
  slab(matI('floor_epoxy'), x0, -0.25, z0, x1, floorY, z1, {
    cast: false
  });
  col(x0, -0.5, z0, x1, floorY, z1, 'concrete');
  slab(mConcrete, SHED_ROLLER_DOOR.x0 - 0.4, -0.2, z1, SHED_ROLLER_DOOR.x1 + 0.4, 0.02, z1 + 1.4, {
    cast: false
  });
  slab(mConcrete, x1, -0.2, SHED_SIDE_DOOR.z0 - 0.4, x1 + 1.4, 0.02, SHED_SIDE_DOOR.z1 + 0.4, {
    cast: false
  });
  /** Shed wall section in the XY plane: concrete plinth below 1.2 m, cladding above. */
  function wallAlongX(
    wallZ: number,
    side: number,
    xa: number,
    xb: number,
    ya: number,
    yb: number
  ): void {
    if (xb - xa < 0.02 || yb - ya < 0.02) return;
    const outer = wallZ;
    const inner = wallZ - side * wallT;
    if (ya < 1.2) {
      const mid = wallZ - side * wallT * 0.5;
      slab(
        mConcrete,
        xa,
        floorY - 0.2,
        Math.min(outer, mid),
        xb,
        Math.min(1.2, yb),
        Math.max(outer, mid),
        {
          bevel: 0.015
        }
      );
      slab(
        mWall,
        xa,
        floorY - 0.2,
        Math.min(mid, inner),
        xb,
        Math.min(1.2, yb),
        Math.max(mid, inner),
        {
          bevel: 0.015
        }
      );
    }
    const cladY = Math.max(ya, 1.2);
    if (!(yb <= cladY)) {
      slab(
        mRoof,
        xa,
        cladY - 0.03,
        Math.min(outer + side * 0.02, outer + side * 0.06),
        xb,
        yb,
        Math.max(outer + side * 0.02, outer + side * 0.06)
      );
      slab(
        mRoofIn,
        xa,
        cladY,
        Math.min(outer - side * 0.1, outer - side * 0.13),
        xb,
        yb,
        Math.max(outer - side * 0.1, outer - side * 0.13)
      );
    }
  }
  /** Shed wall section in the ZY plane. */
  function wallAlongZ(
    wallX: number,
    side: number,
    za: number,
    zb: number,
    ya: number,
    yb: number
  ): void {
    if (zb - za < 0.02 || yb - ya < 0.02) return;
    const outer = wallX;
    const inner = wallX - side * wallT;
    if (ya < 1.2) {
      const mid = wallX - side * wallT * 0.5;
      slab(
        mConcrete,
        Math.min(outer, mid),
        floorY - 0.2,
        za,
        Math.max(outer, mid),
        Math.min(1.2, yb),
        zb,
        {
          bevel: 0.015
        }
      );
      slab(
        mWall,
        Math.min(mid, inner),
        floorY - 0.2,
        za,
        Math.max(mid, inner),
        Math.min(1.2, yb),
        zb,
        {
          bevel: 0.015
        }
      );
    }
    const cladY = Math.max(ya, 1.2);
    if (!(yb <= cladY)) {
      slab(
        mRoof,
        Math.min(outer + side * 0.02, outer + side * 0.06),
        cladY - 0.03,
        za,
        Math.max(outer + side * 0.02, outer + side * 0.06),
        yb,
        zb
      );
      slab(
        mRoofIn,
        Math.min(outer - side * 0.1, outer - side * 0.13),
        cladY,
        za,
        Math.max(outer - side * 0.1, outer - side * 0.13),
        yb,
        zb
      );
    }
  }
  /** Band of tilted ventilation louvre blades in the XY plane. */
  function louvreAlongX(
    wallZ: number,
    side: number,
    xa: number,
    xb: number,
    ya: number,
    yb: number,
    tilt = 0.25,
    spacing = 0.45,
    depth = 0.26
  ): void {
    const count = Math.max(1, Math.floor((yb - ya - 0.1) / spacing));
    for (let i = 0; i <= count; i++) {
      const bladeY = ya + 0.08 + ((yb - ya - 0.16) * i) / count;
      box(mGalv, xb - xa, 0.018, depth, (xa + xb) / 2, bladeY, wallZ - side * 0.06, {
        r: [side * tilt, 0, 0]
      });
    }
    for (const x of [xa + 0.03, xb - 0.03, (xa + xb) / 2])
      slab(mGalv, x - 0.03, ya, wallZ - side * 0.2, x + 0.03, yb, wallZ + side * 0.06);
    slab(mGalv, xa, ya - 0.05, wallZ - side * 0.2, xb, ya, wallZ + side * 0.07);
    slab(mGalv, xa, yb, wallZ - side * 0.2, xb, yb + 0.05, wallZ + side * 0.07);
  }
  /** Band of tilted ventilation louvre blades in the ZY plane. */
  function louvreAlongZ(
    wallX: number,
    side: number,
    za: number,
    zb: number,
    ya: number,
    yb: number,
    tilt = 0.5,
    spacing = 0.45,
    depth = 0.26
  ): void {
    const count = Math.max(1, Math.floor((yb - ya - 0.1) / spacing));
    for (let i = 0; i <= count; i++) {
      const bladeY = ya + 0.08 + ((yb - ya - 0.16) * i) / count;
      box(mGalv, depth, 0.018, zb - za, wallX - side * 0.06, bladeY, (za + zb) / 2, {
        r: [0, 0, -side * tilt]
      });
    }
    for (const z of [za + 0.03, zb - 0.03, (za + zb) / 2])
      slab(mGalv, wallX - side * 0.2, ya, z - 0.03, wallX + side * 0.06, yb, z + 0.03);
    slab(mGalv, wallX - side * 0.2, ya - 0.05, za, wallX + side * 0.07, ya, zb);
    slab(mGalv, wallX - side * 0.2, yb, za, wallX + side * 0.07, yb + 0.05, zb);
  }
  const louvreY0 = 5.45;
  const louvreY1 = 6.8;
  for (let bay = 0; bay < SHED_BAY_X.length - 1; bay++) {
    const bx0 = SHED_BAY_X[bay];
    const bx1 = SHED_BAY_X[bay + 1];
    if (bay === 2) {
      wallAlongX(z1, 1, bx0, SHED_ROLLER_DOOR.x0, 0, eave);
      wallAlongX(z1, 1, SHED_ROLLER_DOOR.x1, bx1, 0, eave);
      wallAlongX(z1, 1, SHED_ROLLER_DOOR.x0, SHED_ROLLER_DOOR.x1, SHED_ROLLER_DOOR.h, eave);
    } else {
      wallAlongX(z1, 1, bx0, bx1, 0, louvreY0 - 0.05);
      wallAlongX(z1, 1, bx0, bx1, louvreY1 + 0.05, eave);
      louvreAlongX(z1, 1, bx0 + 0.15, bx1 - 0.15, louvreY0, louvreY1);
    }
  }
  wallAlongX(z0, -1, x0, x1, 0, eave);
  slab(matI('paint_grey'), 6.2, floorY, z0 + wallT, 7.2, 2.1, z0 + wallT + 0.04);
  slab(mat('paint_grey'), 6.2, 0, z0 - 0.09, 7.2, 2.1, z0 - 0.05);
  wallAlongZ(x0, -1, z0, z1, 0, eave);
  wallAlongZ(x1, 1, z0, SHED_SIDE_DOOR.z0, 0, louvreY0 - 0.05);
  const breach = {
    z0: -15.55,
    z1: -13.35,
    y0: 3.3
  };
  wallAlongZ(x1, 1, SHED_SIDE_DOOR.z1, breach.z0, 0, louvreY0 - 0.05);
  wallAlongZ(x1, 1, breach.z1, z1, 0, louvreY0 - 0.05);
  wallAlongZ(x1, 1, breach.z0, breach.z1, 0, breach.y0);
  box(mRoof, 0.03, 1.5, 1.05, x1 + 0.2, breach.y0 - 0.55, breach.z0 + 0.5, {
    r: [0.25, 0.1, -0.22]
  });
  box(mRoof, 1, 0.03, 2, x1 + 1.3, 0.05, breach.z0 + 1.6, {
    r: [0.02, 0.5, 0.03]
  });
  for (const z of [breach.z0, breach.z1])
    slab(mGalvIn, x1 - 0.16, breach.y0, z - 0.03, x1 - 0.1, louvreY0 - 0.05, z + 0.03);
  wallAlongZ(x1, 1, SHED_SIDE_DOOR.z0, SHED_SIDE_DOOR.z1, SHED_SIDE_DOOR.h, louvreY0 - 0.05);
  wallAlongZ(x1, 1, z0, z1, louvreY1 + 0.05, eave);
  for (const [za, zb] of [
    [z0 + 0.3, -22.45],
    [-22.15, -16.85],
    [-16.55, z1 - 0.3]
  ])
    louvreAlongZ(x1, 1, za, zb, louvreY0, louvreY1);
  const oculus = {
    y: 8.02,
    r: 0.56
  };
  /** Triangular gable end (outer + inner skins), optionally with the round fan opening. */
  function gable(gx: number, side: number, withOculus: boolean): void {
    const layer = (depth: number, material: THREE.Material, offset: number): void => {
      const shape = new Shape();
      shape.moveTo(-(z1 + 0.05), eave - 0.02);
      shape.lineTo(-ridgeZ, ridge);
      shape.lineTo(-(z0 - 0.05), eave - 0.02);
      shape.closePath();
      if (withOculus) {
        const hole = new Path();
        hole.absarc(-ridgeZ, oculus.y, oculus.r, 0, Math.PI * 2, true);
        shape.holes.push(hole);
      }
      const geometry = new ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: false,
        curveSegments: 20
      });
      geometry.rotateY(Math.PI / 2);
      geometry.translate(gx + offset, 0, 0);
      add(geometry, material);
    };
    layer(0.04, mRoof, side > 0 ? 0.02 : -0.06);
    layer(0.03, mRoofIn, side > 0 ? -0.13 : 0.1);
  }
  gable(x1, 1, true);
  gable(x0, -1, false);
  col(x0, 0, z1 - wallT, SHED_ROLLER_DOOR.x0, eave, z1 + 0.06, 'metal');
  col(SHED_ROLLER_DOOR.x1, 0, z1 - wallT, x1, eave, z1 + 0.06, 'metal');
  col(
    SHED_ROLLER_DOOR.x0,
    SHED_ROLLER_DOOR.h - 0.5,
    z1 - 0.6,
    SHED_ROLLER_DOOR.x1,
    eave,
    z1 + 0.06,
    'metal'
  );
  col(x0, 0, z0 - 0.06, x1, eave, z0 + wallT, 'metal');
  col(x0 - 0.06, 0, z0, x0 + wallT, ridge, z1, 'metal');
  col(x1 - wallT, 0, z0, x1 + 0.06, ridge, SHED_SIDE_DOOR.z0, 'metal');
  col(x1 - wallT, 0, SHED_SIDE_DOOR.z1, x1 + 0.06, ridge, -15.55, 'metal');
  col(x1 - wallT, 0, -13.35, x1 + 0.06, ridge, z1, 'metal');
  col(x1 - wallT, 0, -15.55, x1 + 0.06, 3.3, -13.35, 'metal');
  col(x1 - wallT, 5.4, -15.55, x1 + 0.06, ridge, -13.35, 'metal');
  col(
    x1 - wallT,
    SHED_SIDE_DOOR.h,
    SHED_SIDE_DOOR.z0,
    x1 + 0.06,
    ridge,
    SHED_SIDE_DOOR.z1,
    'metal'
  );
  const skylights = [];
  const colW = (x1 - x0 + 0.6) / SHED_ROOF_COLUMNS;
  const colX0 = x0 - 0.3;
  for (const slope of ['S', 'N']) {
    const side = slope === 'S' ? 1 : -1;
    const rot = [side * pitch, 0, 0];
    const cosP = Math.cos(pitch);
    const sinP = side * Math.sin(pitch);
    for (let row = 0; row < 4; row++) {
      const r0 = SHED_ROOF_ROW_BREAKS[row];
      const r1 = SHED_ROOF_ROW_BREAKS[row + 1];
      const rMid = (r0 + r1) / 2;
      const rowLen = (r1 - r0) * rafterLen;
      const rowZ = ridgeZ + side * halfSpan * (1 - rMid);
      const rowY = eave + rise * rMid;
      let colIdx = 0;
      // Lay roof sheets in runs of columns between skylights.
      while (colIdx < SHED_ROOF_COLUMNS) {
        if (
          SHED_ROOF_SKYLIGHTS.some((sky) => sky[0] === slope && sky[1] === row && sky[2] === colIdx)
        ) {
          colIdx++;
          continue;
        }
        let runEnd = colIdx;
        while (
          runEnd + 1 < SHED_ROOF_COLUMNS &&
          !SHED_ROOF_SKYLIGHTS.some(
            (sky) => sky[0] === slope && sky[1] === row && sky[2] === runEnd + 1
          )
        )
          runEnd++;
        const sx0 = colX0 + colIdx * colW;
        const sx1 = colX0 + (runEnd + 1) * colW;
        const sxMid = (sx0 + sx1) / 2;
        box(mRoof, sx1 - sx0, 0.04, rowLen + 0.02, sxMid, rowY + cosP * 0.03, rowZ + sinP * 0.03, {
          r: rot
        });
        box(
          mRoofIn,
          sx1 - sx0,
          0.02,
          rowLen + 0.02,
          sxMid,
          rowY - cosP * 0.02,
          rowZ - sinP * 0.02,
          {
            r: rot
          }
        );
        const za = ridgeZ + side * halfSpan * (1 - r0);
        const zb = ridgeZ + side * halfSpan * (1 - r1);
        col(
          Math.max(sx0, x0 - 0.3),
          eave + rise * Math.max(0, r0) - 0.05,
          Math.min(za, zb),
          sx1,
          eave + rise * r1 + 0.08,
          Math.max(za, zb),
          'metal',
          {
            noNav: true
          }
        );
        colIdx = runEnd + 1;
      }
    }
    for (const sky of SHED_ROOF_SKYLIGHTS)
      if (sky[0] === slope) {
        const r0 = SHED_ROOF_ROW_BREAKS[sky[1]];
        const r1 = SHED_ROOF_ROW_BREAKS[sky[1] + 1];
        const skyX = colX0 + sky[2] * colW;
        const rMid = (r0 + r1) / 2;
        const skyZ = ridgeZ + side * halfSpan * (1 - rMid);
        const skyY = eave + rise * rMid;
        skylights.push({
          x: skyX + colW / 2,
          y: skyY,
          z: skyZ,
          w: colW,
          d: (r1 - r0) * halfSpan
        });
        kit.decal(
          'leak_stain',
          1.9,
          skyX + colW / 2 + 0.2,
          floorY + 0.004,
          skyZ,
          'y+',
          sky[2] * 1.7
        );
        box(
          mGalvIn,
          0.05,
          0.05,
          (r1 - r0) * rafterLen,
          skyX + 0.02,
          skyY - cosP * 0.06,
          skyZ - sinP * 0.06,
          {
            r: rot
          }
        );
        box(
          mGalvIn,
          0.05,
          0.05,
          (r1 - r0) * rafterLen,
          skyX + colW - 0.02,
          skyY - cosP * 0.06,
          skyZ - sinP * 0.06,
          {
            r: rot
          }
        );
      }
    for (const t of [0.03, 0.2, 0.37, 0.54, 0.71, 0.88, 0.985]) {
      const purlinZ = ridgeZ + side * halfSpan * (1 - t);
      const purlinY = eave + rise * t;
      box(
        mGalvIn,
        x1 - x0 - 0.3,
        0.17,
        0.06,
        (x0 + x1) / 2,
        purlinY - cosP * 0.13,
        purlinZ - sinP * 0.13,
        {
          r: rot
        }
      );
    }
    const gutterZ = ridgeZ + side * (halfSpan + 0.38);
    slab(
      mGalv,
      x0 - 0.3,
      eave - 0.22,
      Math.min(gutterZ, gutterZ + side * 0.16),
      x1 + 0.3,
      eave - 0.08,
      Math.max(gutterZ, gutterZ + side * 0.16)
    );
    slab(
      mGalv,
      x0 - 0.3,
      eave - 0.22,
      Math.min(gutterZ - side * 0.05, gutterZ + side * 0.21),
      x1 + 0.3,
      eave - 0.19,
      Math.max(gutterZ - side * 0.05, gutterZ + side * 0.21)
    );
    for (let i = 0; i < SHED_BAY_X.length; i++) {
      if (slope === 'S' && (i === 2 || i === 3)) continue;
      const pipeX = Math.min(x1 - 0.5, Math.max(x0 + 0.5, SHED_BAY_X[i])) + 0.42;
      const pipeZ = ridgeZ + side * (halfSpan + 0.13);
      cyl(mGalv, 0.055, eave - 0.4, pipeX, (eave - 0.4) / 2 + 0.2, pipeZ, {
        seg: 8
      });
      rod(mGalv, [pipeX, eave - 0.2, pipeZ], [pipeX, eave - 0.12, gutterZ + side * 0.08], 0.05);
      for (const y of [1.6, 3.6, 5.6]) box(mGalv, 0.16, 0.04, 0.14, pipeX, y, pipeZ - side * 0.02);
      rod(mGalv, [pipeX, 0.2, pipeZ], [pipeX + 0.02, 0.06, pipeZ + side * 0.22], 0.055);
    }
  }
  for (const side of [-1, 1])
    box(mGalv, x1 - x0 + 0.7, 0.03, 0.34, (x0 + x1) / 2, ridge + 0.03, ridgeZ + side * 0.15, {
      r: [side * pitch, 0, 0]
    });
  for (const gx of [x0 - 0.31, x1 + 0.31])
    for (const side of [-1, 1])
      box(
        mGalv,
        0.04,
        0.22,
        rafterLen + 0.4,
        gx,
        (eave + ridge) / 2 - 0.05,
        ridgeZ + side * (halfSpan / 2 + 0.1),
        {
          r: [side * pitch, 0, 0]
        }
      );
  const frameZs = [z1 - wallT - 0.24, z0 + wallT + 0.24];
  for (let i = 0; i < SHED_BAY_X.length; i++) {
    const colX =
      i === 0 ? x0 + wallT + 0.12 : i === SHED_BAY_X.length - 1 ? x1 - wallT - 0.12 : SHED_BAY_X[i];
    for (const fz of frameZs) {
      ibeam(mPaint, 'y', eave - 0.35, colX, floorY + (eave - 0.35) / 2, fz, {
        depth: 0.46,
        width: 0.22,
        depthAxis: 'z'
      });
      box(mDark, 0.36, 0.03, 0.62, colX, floorY + 0.015, fz);
      col(colX - 0.12, 0, fz - 0.24, colX + 0.12, eave, fz + 0.24, 'metal');
    }
    for (const side of [1, -1]) {
      const rz = ridgeZ + (side * halfSpan) / 2 - side * 0.14;
      const ry = eave + rise / 2 - 0.42;
      ibeam(mPaint, 'z', rafterLen - 0.5, colX, ry, rz, {
        depth: 0.4,
        width: 0.2,
        depthAxis: 'y',
        r: [side * pitch, 0, 0]
      });
      box(mPaint, 0.014, 0.5, 1.5, colX, eave - 0.55, ridgeZ + side * (halfSpan - wallT - 0.9), {
        r: [side * (pitch + 0.22), 0, 0]
      });
      box(mPaint, 0.2, 0.02, 1.55, colX, eave - 0.82, ridgeZ + side * (halfSpan - wallT - 0.95), {
        r: [side * (pitch + 0.42), 0, 0]
      });
    }
    box(mPaint, 0.22, 0.5, 0.03, colX, ridge - 0.55, ridgeZ);
  }
  for (const colX of [x0 + wallT + 0.12, x1 - wallT - 0.12])
    for (const colZ of [-22.3, -16.7]) {
      const colH = roofY(colZ) - 0.55;
      ibeam(mPaint, 'y', colH, colX, floorY + colH / 2, colZ, {
        depth: 0.3,
        width: 0.18,
        depthAxis: 'x'
      });
      col(colX - 0.16, 0, colZ - 0.1, colX + 0.16, colH, colZ + 0.1, 'metal');
    }
  for (const fz of frameZs) {
    const side = fz > ridgeZ ? 1 : -1;
    for (const railY of [2.3, 3.7, 5.15])
      if (side > 0) {
        slab(
          mGalvIn,
          x0 + 0.3,
          railY - 0.08,
          z1 - 0.2,
          SHED_ROLLER_DOOR.x0 - 0.2,
          railY + 0.08,
          z1 - 0.14
        );
        slab(
          mGalvIn,
          SHED_ROLLER_DOOR.x1 + 0.2,
          railY - 0.08,
          z1 - 0.2,
          x1 - 0.3,
          railY + 0.08,
          z1 - 0.14
        );
      } else slab(mGalvIn, x0 + 0.3, railY - 0.08, z0 + 0.14, x1 - 0.3, railY + 0.08, z0 + 0.2);
    box(mPaint, x1 - x0 - 0.6, 0.14, 0.14, (x0 + x1) / 2, eave - 0.25, fz);
  }
  for (const wx of [x0 + 0.17, x1 - 0.17])
    for (const railY of [2.3, 3.7, 5.15])
      if (wx > 0) {
        slab(
          mGalvIn,
          wx - 0.03,
          railY - 0.08,
          z0 + 0.3,
          wx + 0.03,
          railY + 0.08,
          SHED_SIDE_DOOR.z0 - 0.2
        );
        slab(
          mGalvIn,
          wx - 0.03,
          railY - 0.08,
          SHED_SIDE_DOOR.z1 + 0.2,
          wx + 0.03,
          railY + 0.08,
          z1 - 0.3
        );
      } else slab(mGalvIn, wx - 0.03, railY - 0.08, z0 + 0.3, wx + 0.03, railY + 0.08, z1 - 0.3);
  for (const [bx0, bx1] of [
    [SHED_BAY_X[0] + 0.4, SHED_BAY_X[1]],
    [SHED_BAY_X[4], SHED_BAY_X[5] - 0.4]
  ]) {
    for (const fz of frameZs) {
      rod(mGalvIn, [bx0, 1.35, fz], [bx1, 5.3, fz], 0.016);
      rod(mGalvIn, [bx1, 1.35, fz + 0.04], [bx0, 5.3, fz + 0.04], 0.016);
    }
    for (const side of [1, -1]) {
      const rz = ridgeZ + side * (halfSpan - 0.6);
      const drop = -0.3;
      rod(
        mGalvIn,
        [bx0, eave + drop + 0.1, rz],
        [bx1, ridge + drop - 0.1, ridgeZ + side * 0.3],
        0.014
      );
      rod(
        mGalvIn,
        [bx1, eave + drop + 0.1, rz],
        [bx0, ridge + drop - 0.1, ridgeZ + side * 0.3],
        0.014
      );
    }
  }
  {
    const doorZ = z1 - wallT;
    for (const x of [SHED_ROLLER_DOOR.x0 - 0.07, SHED_ROLLER_DOOR.x1 + 0.07]) {
      slab(mDark, x - 0.07, floorY, doorZ - 0.16, x + 0.07, SHED_ROLLER_DOOR.h + 0.75, z1 + 0.07);
      slab(mat('hazard_stripes'), x - 0.11, floorY, doorZ - 0.2, x + 0.11, 1.3, z1 + 0.1, {
        bevel: 0.01
      });
    }
    slab(
      mDark,
      SHED_ROLLER_DOOR.x0 - 0.2,
      SHED_ROLLER_DOOR.h,
      doorZ - 0.1,
      SHED_ROLLER_DOOR.x1 + 0.2,
      SHED_ROLLER_DOOR.h + 0.14,
      z1 + 0.08
    );
    slab(
      mGalvIn,
      SHED_ROLLER_DOOR.x0 - 0.25,
      SHED_ROLLER_DOOR.h + 0.78,
      doorZ - 0.72,
      SHED_ROLLER_DOOR.x1 + 0.25,
      SHED_ROLLER_DOOR.h + 0.81,
      doorZ
    );
    slab(
      mGalvIn,
      SHED_ROLLER_DOOR.x0 - 0.25,
      SHED_ROLLER_DOOR.h + 0.3,
      doorZ - 0.72,
      SHED_ROLLER_DOOR.x1 + 0.25,
      SHED_ROLLER_DOOR.h + 0.81,
      doorZ - 0.69
    );
    for (const x of [SHED_ROLLER_DOOR.x0 - 0.24, SHED_ROLLER_DOOR.x1 + 0.24])
      slab(
        mGalvIn,
        x - 0.012,
        SHED_ROLLER_DOOR.h + 0.05,
        doorZ - 0.72,
        x + 0.012,
        SHED_ROLLER_DOOR.h + 0.81,
        doorZ
      );
    cyl(
      mRoofIn,
      0.3,
      SHED_ROLLER_DOOR.x1 - SHED_ROLLER_DOOR.x0 + 0.3,
      (SHED_ROLLER_DOOR.x0 + SHED_ROLLER_DOOR.x1) / 2,
      SHED_ROLLER_DOOR.h + 0.44,
      doorZ - 0.36,
      {
        axis: 'x',
        seg: 18
      }
    );
    cyl(
      mDark,
      0.05,
      SHED_ROLLER_DOOR.x1 - SHED_ROLLER_DOOR.x0 + 0.46,
      (SHED_ROLLER_DOOR.x0 + SHED_ROLLER_DOOR.x1) / 2,
      SHED_ROLLER_DOOR.h + 0.44,
      doorZ - 0.36,
      {
        axis: 'x',
        seg: 8
      }
    );
    slab(
      mRoofIn,
      SHED_ROLLER_DOOR.x0 + 0.02,
      SHED_ROLLER_DOOR.h - 0.42,
      doorZ - 0.09,
      SHED_ROLLER_DOOR.x1 - 0.02,
      SHED_ROLLER_DOOR.h + 0.42,
      doorZ - 0.06
    );
    slab(
      mat('hazard_stripes'),
      SHED_ROLLER_DOOR.x0 + 0.02,
      SHED_ROLLER_DOOR.h - 0.52,
      doorZ - 0.12,
      SHED_ROLLER_DOOR.x1 - 0.02,
      SHED_ROLLER_DOOR.h - 0.42,
      doorZ - 0.03
    );
    slab(
      mDark,
      SHED_ROLLER_DOOR.x1 + 0.28,
      SHED_ROLLER_DOOR.h + 0.2,
      doorZ - 0.6,
      SHED_ROLLER_DOOR.x1 + 0.7,
      SHED_ROLLER_DOOR.h + 0.7,
      doorZ - 0.15,
      {
        bevel: 0.02
      }
    );
    rod(
      mDark,
      [SHED_ROLLER_DOOR.x1 + 0.5, SHED_ROLLER_DOOR.h + 0.2, doorZ - 0.3],
      [SHED_ROLLER_DOOR.x1 + 0.5, 1.2, doorZ - 0.3],
      0.008
    );
    for (const x of [SHED_ROLLER_DOOR.x0 - 0.45, SHED_ROLLER_DOOR.x1 + 0.45])
      kit.place('bollard_post', x, z1 + 0.55, 0, {
        seed: 5
      });
  }
  {
    const canopyX = x1 + 0.12;
    const canopyZ1 = SHED_SIDE_DOOR.z0 - 0.25;
    const canopyZ0 = canopyZ1 - 5.1;
    slab(mRoof, canopyX, 0.12, canopyZ0, canopyX + 0.05, SHED_SIDE_DOOR.h + 0.1, canopyZ1);
    for (const z of [canopyZ0, canopyZ1, (canopyZ0 + canopyZ1) / 2])
      slab(mGalv, canopyX - 0.02, 0.1, z - 0.05, canopyX + 0.09, SHED_SIDE_DOOR.h + 0.12, z + 0.05);
    for (const y of [0.14, SHED_SIDE_DOOR.h + 0.08, SHED_SIDE_DOOR.h * 0.5])
      slab(mGalv, canopyX - 0.02, y - 0.05, canopyZ0, canopyX + 0.09, y + 0.05, canopyZ1);
    rod(
      mGalv,
      [canopyX + 0.02, 0.2, canopyZ0 + 0.1],
      [canopyX + 0.02, SHED_SIDE_DOOR.h, (canopyZ0 + canopyZ1) / 2],
      0.02
    );
    rod(
      mGalv,
      [canopyX + 0.02, 0.2, canopyZ1 - 0.1],
      [canopyX + 0.02, SHED_SIDE_DOOR.h, (canopyZ0 + canopyZ1) / 2],
      0.02
    );
    slab(
      mDark,
      canopyX - 0.04,
      SHED_SIDE_DOOR.h + 0.16,
      canopyZ0 - 0.2,
      canopyX + 0.12,
      SHED_SIDE_DOOR.h + 0.3,
      SHED_SIDE_DOOR.z1 + 0.3
    );
    slab(
      mDark,
      x1 - wallT - 0.02,
      floorY,
      SHED_SIDE_DOOR.z0 - 0.12,
      x1 + 0.08,
      SHED_SIDE_DOOR.h + 0.1,
      SHED_SIDE_DOOR.z0
    );
    slab(
      mDark,
      x1 - wallT - 0.02,
      floorY,
      SHED_SIDE_DOOR.z1,
      x1 + 0.08,
      SHED_SIDE_DOOR.h + 0.1,
      SHED_SIDE_DOOR.z1 + 0.12
    );
    slab(
      mDark,
      x1 - wallT - 0.02,
      SHED_SIDE_DOOR.h,
      SHED_SIDE_DOOR.z0 - 0.12,
      x1 + 0.08,
      SHED_SIDE_DOOR.h + 0.12,
      SHED_SIDE_DOOR.z1 + 0.12
    );
    for (const z of [SHED_SIDE_DOOR.z0 - 0.06, SHED_SIDE_DOOR.z1 + 0.06])
      slab(mat('hazard_stripes'), x1 - wallT - 0.05, floorY, z - 0.1, x1 + 0.1, 1.3, z + 0.1, {
        bevel: 0.01
      });
    col(canopyX - 0.05, 0, canopyZ0, canopyX + 0.12, SHED_SIDE_DOOR.h + 0.3, canopyZ1, 'metal');
    kit.place('bollard_post', x1 + 0.6, SHED_SIDE_DOOR.z0 - 0.4, 0, {
      seed: 6
    });
  }
  const fan = new Group();
  fan.position.set(x1 - 0.05, oculus.y, ridgeZ);
  fan.userData.noMerge = true;
  {
    const rim = new TorusGeometry(oculus.r + 0.02, 0.05, 8, 28);
    rim.rotateY(Math.PI / 2);
    add(rim, mGalv, {
      p: [x1 + 0.04, oculus.y, ridgeZ]
    });
    const innerRim = new TorusGeometry(oculus.r + 0.02, 0.035, 6, 28);
    innerRim.rotateY(Math.PI / 2);
    add(innerRim, mGalvIn, {
      p: [x1 - 0.16, oculus.y, ridgeZ]
    });
    for (const angle of [0.4, 0.4 + Math.PI / 2])
      rod(
        mGalv,
        [x1 + 0.1, oculus.y - Math.sin(angle) * oculus.r, ridgeZ - Math.cos(angle) * oculus.r],
        [x1 + 0.1, oculus.y + Math.sin(angle) * oculus.r, ridgeZ + Math.cos(angle) * oculus.r],
        0.012
      );
    for (const angle of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3])
      rod(
        mGalvIn,
        [x1 - 0.18, oculus.y + Math.sin(angle) * oculus.r, ridgeZ + Math.cos(angle) * oculus.r],
        [x1 - 0.18, oculus.y, ridgeZ],
        0.014
      );
    cyl(mDark, 0.13, 0.26, x1 - 0.22, oculus.y, ridgeZ, {
      axis: 'x',
      seg: 12
    });
    const mBlade = matI('steel_worn');
    for (let i = 0; i < 5; i++) {
      const bladeGeometry = worldUvBox(0.012, 0.42, 0.2);
      bladeGeometry.rotateY(0.5);
      bladeGeometry.translate(0, 0.3, 0);
      bladeGeometry.rotateX((i / 5) * Math.PI * 2);
      const blade = new Mesh(bladeGeometry, mBlade);
      blade.castShadow = true;
      blade.receiveShadow = true;
      fan.add(blade);
    }
    const hub = new Mesh(worldUvCylinder(0.1, 0.1, 0.1, 12).rotateZ(Math.PI / 2), mDark);
    hub.castShadow = true;
    fan.add(hub);
    kit.dynRoot.add(fan);
  }
  const emLamp = game.mats.emissive(0xffb468, 7);
  const mAlu = matI('aluminium');
  const lampSpots = [];
  for (const lz of [-15.4, -23.6])
    for (const lx of [-13.6, -8.5, -3.5, 2.6, 8.6])
      if (!(lz < -20 && lx < -10)) lampSpots.push([lx, lz]);
  for (const [lx, lz] of lampSpots) {
    const hangY = roofY(lz) - 0.3;
    const lampY = 6.05;
    rod(mDark, [lx, hangY, lz], [lx, lampY + 0.3, lz], 0.012, {
      cast: false
    });
    cyl(mAlu, 0.33, 0.3, lx, lampY + 0.15, lz, {
      rTop: 0.09,
      seg: 14
    });
    cyl(mDark, 0.09, 0.14, lx, lampY + 0.37, lz, {
      seg: 10
    });
    cyl(emLamp, 0.24, 0.02, lx, lampY + 0.02, lz, {
      seg: 14,
      cast: false,
      recv: false
    });
  }
  const lights = [];
  for (const [lx, lz] of [
    [-8.5, -15.4],
    [2.6, -15.4],
    [-3.5, -23.6],
    [8.6, -23.6]
  ]) {
    const light = new PointLight(0xffc48a, 34, 13, 2);
    light.position.set(lx, 5.75, lz);
    light.castShadow = false;
    light.layers.enable(1);
    kit.dynRoot.add(light);
    lights.push(light);
  }
  buildSiteOffice(kit, SHED, {
    mFrame: mPaint,
    mGalv: mGalvIn,
    mDark
  });
  {
    const benchZ1 = z1 - wallT - 0.05;
    const benchZ0 = benchZ1 - 0.75;
    slab(matI('wood_dark'), 1.6, 0.88, benchZ0, 5, 0.94, benchZ1, {
      bevel: 0.012
    });
    for (const legX of [1.6 + 0.06, 5 - 0.06, (1.6 + 5) / 2])
      for (const legZ of [benchZ0 + 0.06, benchZ1 - 0.06])
        box(mDark, 0.05, 0.86, 0.05, legX, floorY + 0.43, legZ);
    slab(mDark, 1.6 + 0.04, 0.2, benchZ0 + 0.06, 5 - 0.04, 0.23, benchZ1 - 0.04);
    slab(matI('paint_grey'), 1.6 + 0.1, 0.55, benchZ0 + 0.04, 1.6 + 1.3, 0.86, benchZ1 - 0.05, {
      bevel: 0.01
    });
    slab(matI('wood_pallet'), 1.6, 1.25, benchZ1 - 0.02, 5, 2.3, benchZ1 + 0.01);
    for (let i = 0; i < 7; i++)
      rod(
        mGalvIn,
        [1.6 + 0.3 + i * 0.42, 1.5 + (i % 3) * 0.12, benchZ1 - 0.04],
        [1.6 + 0.3 + i * 0.42, 2.05 + (i % 2) * 0.1, benchZ1 - 0.04],
        0.012 + (i % 2) * 0.006,
        {
          cast: false
        }
      );
    box(mDark, 0.16, 0.14, 0.3, 5 - 0.5, 1.01, benchZ0 + 0.2, {
      bevel: 0.015
    });
    box(mGalvIn, 0.03, 0.03, 0.34, 5 - 0.5, 1.1, benchZ0 + 0.12);
    box(matI('paint_red'), 0.45, 0.22, 0.24, 1.6 + 1.9, 1.05, benchZ0 + 0.35, {
      bevel: 0.02,
      r: [0, 0.3, 0]
    });
    slab(mDark, 1.6, 2.5, benchZ1 - 0.3, 5, 2.53, benchZ1);
    box(
      game.mats.emissive(0xfff0d0, 3),
      5 - 1.6 - 0.4,
      0.03,
      0.1,
      (1.6 + 5) / 2,
      2.48,
      benchZ1 - 0.18,
      {
        cast: false,
        recv: false
      }
    );
    col(1.6, 0, benchZ0, 5, 0.94, benchZ1, 'wood');
  }
  {
    for (const side of [-1, 1]) {
      const legX = -11.6 + (side * 2.6) / 2;
      rod(matI('paint_yellow'), [legX, floorY, -17.6 - 0.9], [legX, 3.3, -17.6], 0.045);
      rod(matI('paint_yellow'), [legX, floorY, -17.6 + 0.9], [legX, 3.3, -17.6], 0.045);
      rod(matI('paint_yellow'), [legX, 1, -17.6 - 0.62], [legX, 1, -17.6 + 0.62], 0.03);
      for (const footZ of [-17.6 - 0.9, -17.6 + 0.9])
        cyl(mDark, 0.07, 0.1, legX, floorY + 0.05, footZ, {
          axis: 'x',
          seg: 8
        });
    }
    ibeam(matI('paint_yellow'), 'x', 2.6 + 0.5, -11.6, 3.3 + 0.1, -17.6, {
      depth: 0.22,
      width: 0.14
    });
    box(mDark, 0.3, 0.26, 0.24, -11.6 + 0.2, 3.3 - 0.14, -17.6, {
      bevel: 0.02
    });
    rod(mGalvIn, [-11.6 + 0.2, 3.3 - 0.26, -17.6], [-11.6 + 0.2, 1.75, -17.6], 0.012);
    rod(mGalvIn, [-11.6 + 0.32, 3.3 - 0.26, -17.6], [-11.6 + 0.34, 2.2, -17.6 + 0.02], 0.008);
    box(mDark, 0.85, 0.5, 0.55, -11.6 + 0.2, 1.42, -17.6, {
      bevel: 0.03,
      r: [0, 0.2, 0.05]
    });
    box(matI('steel_worn'), 0.7, 0.16, 0.42, -11.6 + 0.2, 1.74, -17.6, {
      bevel: 0.02,
      r: [0, 0.2, 0.05]
    });
    cyl(matI('steel_bare'), 0.16, 0.12, -11.6 - 0.28, 1.4, -17.6 - 0.08, {
      axis: 'x',
      seg: 12
    });
    col(-11.6 - 2.6 / 2 - 0.1, 0, -17.6 - 0.35, -11.6 + 2.6 / 2 + 0.1, 1.9, -17.6 + 0.35, 'metal');
  }
  const quarterTurn = Math.PI / 2;
  const placeOnFloor = (
    name: string,
    x: number,
    z: number,
    yaw: number,
    propOpts: PropOpts,
    y = floorY,
    placeOpts?: PlaceOpts
  ): THREE.Object3D => kit.place(name, x, z, yaw, propOpts, y, placeOpts);
  for (const x of [-8.4, -5.6, -2.8, 2.8, 5.6, 8.4])
    placeOnFloor('shelf_rack', x, z0 + wallT + 0.62, 0, {
      seed: Math.round(x * 7 + 90)
    });
  for (const x of [2.8, 5.6, 8.4])
    placeOnFloor('shelf_rack', x, -23.45, 0, {
      seed: Math.round(x * 5 + 40)
    });
  placeOnFloor('pallet_stack', 0, -26.9, 0.1, {
    seed: 3
  });
  placeOnFloor(
    'cardboard_boxes',
    -0.05,
    -26.9,
    0.5,
    {
      seed: 4
    },
    floorY + 1.15,
    {
      noCol: true
    }
  );
  placeOnFloor('crate_stack', 2.9, -15.9, 0.12, {
    seed: 11
  });
  placeOnFloor('crate_wood', 4.15, -16.3, -0.25, {
    seed: 12
  });
  placeOnFloor('pallet_stack', 2, -17.3, 1.45, {
    seed: 13
  });
  placeOnFloor('ibc_tote', 6.9, -19.6, 0.1, {
    seed: 14
  });
  placeOnFloor('barrel', 7.9, -18.5, 0, {
    seed: 15,
    color: 'blue'
  });
  placeOnFloor('barrel', 6, -18.4, 0.6, {
    seed: 16,
    color: 'red'
  });
  placeOnFloor('ibc_tote', -7.6, -16.4, -0.08, {
    seed: 17
  });
  placeOnFloor('barrel', -8.6, -15.3, 0, {
    seed: 18
  });
  placeOnFloor('barrel', -7.9, -15, 0.9, {
    seed: 19,
    color: 'yellow'
  });
  placeOnFloor('sandbags', 10.2, -16.4, quarterTurn + 0.05, {
    seed: 20
  });
  placeOnFloor('forklift', 8.3, -13.9, 2.75, {
    seed: 21
  });
  placeOnFloor('toolbox_cart', 6, -12.2, 0.15, {
    seed: 22
  });
  placeOnFloor('gas_cylinders', 10.9, -11.9, 0, {
    seed: 23
  });
  placeOnFloor('tarp_cargo', -13.2, -13.2, 0.12, {
    seed: 24
  });
  placeOnFloor('tire_stack', -15, -15.6, 0, {
    seed: 25
  });
  placeOnFloor('tire_stack', -14.9, -16.6, 0.4, {
    seed: 26
  });
  placeOnFloor('cardboard_boxes', -14.6, -26.6, 0.2, {
    seed: 27
  });
  placeOnFloor('crate_wood', -12.4, -26.9, -0.1, {
    seed: 28
  });
  placeOnFloor('barrel', -10.9, -27, 0, {
    seed: 29,
    color: 'green'
  });
  placeOnFloor('crate_wood', -14.7, -24.6, 0.3, {
    seed: 30
  });
  placeOnFloor('jerry_can', -9.3, -12, 0.4, {
    seed: 31
  });
  placeOnFloor('jerry_can', -9.7, -12.1, 1.2, {
    seed: 32
  });
  placeOnFloor('pallet', 10.6, -13.6, 0.2, {
    seed: 33
  });
  placeOnFloor(
    'cardboard_boxes',
    10.6,
    -13.6,
    0.3,
    {
      seed: 34
    },
    0.17
  );
  placeOnFloor('traffic_cone', -6.6, -12.2, 0, {
    seed: 35
  });
  placeOnFloor('traffic_cone', -0.4, -12.3, 0, {
    seed: 36
  });
  kit.tube(
    matI('rubber'),
    [
      [1.7, 0.9, -11.9],
      [1.4, 0.4, -12.3],
      [1.2, 0.06, -13.2],
      [2.4, 0.055, -14],
      [1, 0.055, -14.9],
      [-0.8, 0.055, -14.4],
      [-1.6, 0.055, -15.6]
    ],
    0.018,
    {
      cast: false
    }
  );
  slab(mDark, 7.2, floorY, -14.6, 8.4, floorY + 0.04, -13.6);
  kit.decal('oil_stain', 2.2, 7.6, floorY + 0.004, -15.2, 'y+', 0.6);
  kit.decal('oil_stain', 1.6, -3.8, floorY + 0.004, -13.6, 'y+', 2.1);
  kit.decal('hazard_voltage', 0.5, -1.25, 1.9, z1 - wallT - 0.142, 'z-');
  kit.decal('caution_stripes', 2.4, -3.5, floorY + 0.004, -11.9, 'y+', 0);
  return {
    fan,
    lights,
    skylights,
    relayPos: new Vector3(-2, floorY, -19.5),
    update(dt) {
      fan.rotation.x += dt * 1.7;
    }
  };
}
/** Empty group placed at (x, y, z) with a yaw, parented to the static root. */
function propRoot(kit: LevelKit, x: number, z: number, yaw: number, y = 0): THREE.Group {
  const root = new Group();
  root.position.set(x, y, z);
  root.rotation.y = yaw;
  kit.staticRoot.add(root);
  return root;
}
function propBox(
  kit: LevelKit,
  parent: THREE.Object3D,
  material: MaterialRef,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  bevel = 0,
  rot: number[] | null = null
): THREE.Mesh {
  const mesh = shadowedMesh(
    bevel ? roundedBox(w, h, d, bevel) : worldUvBox(w, h, d),
    typeof material == 'string' ? kit.M(material) : material
  );
  mesh.position.set(x, y, z);
  if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
  parent.add(mesh);
  return mesh;
}
function propRod(
  kit: LevelKit,
  parent: THREE.Object3D,
  material: MaterialRef,
  radius: number,
  length: number,
  x: number,
  y: number,
  z: number,
  rot: number[] | null = null,
  seg = 8
): THREE.Mesh {
  const mesh = shadowedMesh(
    worldUvCylinder(radius, radius, length, seg),
    typeof material == 'string' ? kit.M(material) : material
  );
  mesh.position.set(x, y, z);
  if (rot) mesh.rotation.set(rot[0], rot[1], rot[2]);
  parent.add(mesh);
  return mesh;
}
/** Axis-aligned collider covering a rotated w x d footprint (slightly shrunk when diagonal). */
function propFootprintCollider(
  kit: LevelKit,
  x: number,
  z: number,
  yaw: number,
  w: number,
  d: number,
  h: number,
  surface = 'metal',
  y = 0
): void {
  const cos = Math.abs(Math.cos(yaw));
  const sin = Math.abs(Math.sin(yaw));
  const shrink = Math.abs(Math.sin(2 * yaw)) > 0.2 ? 0.9 : 1;
  const halfX = ((w * cos + d * sin) / 2) * shrink;
  const halfZ = ((w * sin + d * cos) / 2) * shrink;
  kit.col(x - halfX, y, z - halfZ, x + halfX, y + h, z + halfZ, surface);
}
/** Mesh-sided scrap cage filled with leaning pipes; `seed` varies the contents. */
export function placeScrapCage(
  kit: LevelKit,
  x: number,
  z: number,
  yaw = 0,
  paint = 'paint_blue',
  seed = 1
): THREE.Group {
  const root = propRoot(kit, x, z, yaw);
  const w = 2.2;
  const d = 1.2;
  const h = 1.25;
  const mFrame = kit.M(paint);
  const mBase = kit.M('steel_dark');
  propBox(kit, root, mBase, w, 0.05, d, 0, 0.13, 0);
  for (const side of [-1, 1])
    propBox(kit, root, mFrame, 0.1, 0.1, d, side * (w / 2 - 0.25), 0.05, 0);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      propBox(
        kit,
        root,
        mFrame,
        0.07,
        h - 0.1,
        0.07,
        sx * (w / 2 - 0.035),
        0.1 + (h - 0.1) / 2,
        sz * (d / 2 - 0.035),
        0.008
      );
  for (const side of [-1, 1]) {
    propBox(kit, root, mFrame, w, 0.06, 0.06, 0, h - 0.03, side * (d / 2 - 0.03), 0.008);
    propBox(kit, root, mFrame, w, 0.05, 0.05, 0, 0.62, side * (d / 2 - 0.03));
    propBox(
      kit,
      root,
      kit.M('chainlink'),
      w - 0.14,
      h - 0.25,
      0.012,
      0,
      0.15 + (h - 0.25) / 2,
      side * (d / 2 - 0.035)
    );
  }
  for (const side of [-1, 1]) {
    propBox(kit, root, mFrame, 0.06, 0.06, d, side * (w / 2 - 0.03), h - 0.03, 0, 0.008);
    propBox(
      kit,
      root,
      kit.M('chainlink'),
      0.012,
      h - 0.25,
      d - 0.14,
      side * (w / 2 - 0.035),
      0.15 + (h - 0.25) / 2,
      0
    );
  }
  const mWorn = kit.M('steel_worn');
  const mRust = kit.M('steel_rust');
  for (let i = 0; i < 14; i++) {
    const u = (i * 0.618 + seed * 0.37) % 1;
    const v = (i * 0.414 + seed * 0.11) % 1;
    const len = 1.5 + v * 0.9;
    propRod(
      kit,
      root,
      i % 3 ? mWorn : mRust,
      0.014,
      len,
      -w / 2 + 0.25 + u * (w - 0.9),
      0.16 + (len / 2) * 0.96,
      -d / 2 + 0.2 + v * (d - 0.4),
      [0.1 * (v - 0.5), 0, 0.28 * (u - 0.3)],
      5
    );
  }
  for (let i = 0; i < 6; i++) {
    const u = (i * 0.37 + seed * 0.2) % 1;
    propRod(
      kit,
      root,
      mRust,
      0.035,
      0.42,
      w / 2 - 0.45 + (u - 0.5) * 0.3,
      0.22 + i * 0.05,
      (u - 0.5) * 0.7,
      [Math.PI / 2 + u, u * 3, 0.2],
      6
    );
  }
  propFootprintCollider(kit, x, z, yaw, w, d, h, 'metal');
  return root;
}
/** Small open skip with scrap blocks inside. */
export function placeScrapSkip(
  kit: LevelKit,
  x: number,
  z: number,
  yaw = 0,
  paint = 'paint_red'
): THREE.Group {
  const root = propRoot(kit, x, z, yaw);
  const w = 1.1;
  const d = 0.8;
  const h = 0.75;
  const mBody = kit.M(paint);
  for (const side of [-1, 1]) propBox(kit, root, mBody, 0.09, 0.1, d, side * 0.36, 0.05, 0);
  propBox(kit, root, mBody, w, 0.04, d, 0, 0.12, 0);
  for (const side of [-1, 1])
    propBox(
      kit,
      root,
      mBody,
      w,
      h - 0.1,
      0.03,
      0,
      0.1 + (h - 0.1) / 2,
      side * (d / 2 - 0.015),
      0.006
    );
  for (const side of [-1, 1])
    propBox(
      kit,
      root,
      mBody,
      0.03,
      h - 0.1,
      d,
      side * (w / 2 - 0.015),
      0.1 + (h - 0.1) / 2,
      0,
      0.006
    );
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      propBox(
        kit,
        root,
        mBody,
        0.06,
        h,
        0.06,
        sx * (w / 2 - 0.02),
        h / 2,
        sz * (d / 2 - 0.02),
        0.01
      );
  propBox(kit, root, kit.M('steel_dark'), w - 0.08, 0.04, d - 0.08, 0, h - 0.22, 0);
  const mScrap = kit.M('steel_worn');
  for (let i = 0; i < 12; i++) {
    const u = (i * 0.618) % 1;
    const v = (i * 0.37) % 1;
    propBox(
      kit,
      root,
      mScrap,
      0.16,
      0.11,
      0.1,
      (u - 0.5) * (w - 0.3),
      h - 0.16 + (i % 3) * 0.03,
      (v - 0.5) * (d - 0.25),
      0.012,
      [v, u * 3, u]
    );
  }
  propFootprintCollider(kit, x, z, yaw, w, d, h, 'metal');
  return root;
}
/** Bundle of rebar rods lying on two timber bearers. */
export function placeRebarBundle(
  kit: LevelKit,
  x: number,
  z: number,
  yaw = 0,
  count = 9
): THREE.Group {
  const root = propRoot(kit, x, z, yaw);
  const mWorn = kit.M('steel_worn');
  const mRust = kit.M('steel_rust');
  for (const bx of [-1.1, 1.1]) propBox(kit, root, 'wood_dark', 0.1, 0.08, 0.7, bx, 0.04, 0, 0.008);
  for (let i = 0; i < count; i++) {
    const layer = i < 5 ? 0 : 1;
    const slot = layer ? i - 5 : i;
    propRod(
      kit,
      root,
      i % 2 ? mWorn : mRust,
      0.016,
      3.4 + (i % 3) * 0.12,
      ((i % 3) - 1) * 0.06,
      0.1 + layer * 0.03,
      (slot - (layer ? 1.5 : 2)) * 0.045 + layer * 0.02,
      [0, 0.01 * (i - 4), Math.PI / 2],
      5
    );
  }
  for (let i = 0; i < count; i += 3)
    propBox(kit, root, mRust, 0.07, 0.05, 0.03, 1.72, 0.11, (i - 4) * 0.02);
  return root;
}
/** Rubber wheel chock. */
export function placeWheelChock(kit: LevelKit, x: number, z: number, yaw = 0): THREE.Group {
  const root = propRoot(kit, x, z, yaw);
  const profile = new Shape();
  profile.moveTo(-0.16, 0);
  profile.lineTo(0.16, 0);
  profile.lineTo(0.16, 0.05);
  profile.lineTo(-0.1, 0.19);
  profile.lineTo(-0.16, 0.19);
  profile.closePath();
  const geometry = new ExtrudeGeometry(profile, {
    depth: 0.2,
    bevelEnabled: false
  });
  geometry.translate(0, 0, -0.1);
  root.add(shadowedMesh(geometry, kit.M('rubber')));
  propBox(kit, root, 'paint_yellow', 0.012, 0.16, 0.18, -0.166, 0.1, 0);
  return root;
}
/** Yellow lane sign on a pole. */
export function placeLaneSign(
  kit: LevelKit,
  x: number,
  z: number,
  text: string,
  facing: QuadFacing = 'x-',
  height = 3.2
): void {
  const alongX = facing[0] === 'x';
  kit.cyl('steel_galv', 0.045, height, x, height / 2, z, {
    seg: 8
  });
  kit.box('steel_dark', 0.3, 0.02, 0.3, x, 0.01, z);
  const boardW = 1.1;
  const boardH = 0.62;
  const boardT = 0.03;
  kit.box(
    'paint_yellow',
    alongX ? boardT : boardW,
    boardH,
    alongX ? boardW : boardT,
    x,
    height - boardH / 2 - 0.05,
    z,
    {
      bevel: 0.01
    }
  );
  const dir = facing[1] === '+' ? 1 : -1;
  const labelX = alongX ? x + dir * (boardT / 2 + 0.003) : x;
  const labelZ = alongX ? z : z + dir * (boardT / 2 + 0.003);
  kit.label(text, 0.4, labelX, height - boardH / 2 - 0.05, labelZ, facing, {
    color: 'black',
    font: 'stencil',
    distress: 0.35
  });
  kit.col(x - 0.06, 0, z - 0.06, x + 0.06, height, z + 0.06, 'metal', {
    noNav: true
  });
}
/** Stack of ship hatch covers; returns the stack height. */
export function placeHatchCoverStack(
  kit: LevelKit,
  x: number,
  z: number,
  count = 2,
  rotated = true,
  skew = 0.02
): number {
  const paints = ['paint_grey', 'paint_teal', 'paint_grey', 'steel_rust'];
  for (let i = 0; i < count; i++) {
    const root = propRoot(
      kit,
      x + (i ? 0.12 * Math.sin(i * 2.1) : 0),
      z + (i ? 0.18 * Math.cos(i * 1.7) : 0),
      (rotated ? Math.PI / 2 : 0) + skew * (i % 2 ? -1 : 1.3),
      0
    );
    const baseY = 0.1 + i * (0.5 + 0.1);
    for (const bx of [-3.6, 0, 3.6])
      propBox(kit, root, 'wood_dark', 0.14, 0.1, 4.2 - 0.2, bx, baseY - 0.1 / 2, 0, 0.01);
    const mCover = kit.M(paints[i % paints.length]);
    propBox(kit, root, mCover, 10.4, 0.5 - 0.08, 4.2, 0, baseY + (0.5 - 0.08) / 2, 0, 0.03);
    propBox(kit, root, mCover, 10.4 - 0.5, 0.08, 4.2 - 0.5, 0, baseY + 0.5 - 0.04, 0, 0.02);
    for (const rz of [-1.4, -0.7, 0, 0.7, 1.4])
      propBox(kit, root, mCover, 10.4 - 0.9, 0.05, 0.09, 0, baseY + 0.5 + 0.02, rz, 0.01);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        propBox(
          kit,
          root,
          'steel_dark',
          0.32,
          0.12,
          0.32,
          sx * (10.4 / 2 - 0.35),
          baseY + 0.5 - 0.02,
          sz * (4.2 / 2 - 0.35),
          0.02
        );
        propBox(
          kit,
          root,
          'paint_yellow',
          0.5,
          0.5 - 0.1,
          0.02,
          sx * (10.4 / 2 - 0.5),
          baseY + (0.5 - 0.08) / 2,
          sz * (4.2 / 2 + 0.006)
        );
      }
    for (const side of [-1, 1])
      propBox(kit, root, 'rubber', 0.04, 0.12, 4.2 - 0.4, side * (10.4 / 2 + 0.01), baseY + 0.1, 0);
  }
  const top = 0.1 + count * (0.5 + 0.1);
  const halfX = (rotated ? 4.2 : 10.4) / 2 + 0.05;
  const halfZ = (rotated ? 10.4 : 4.2) / 2 + 0.05;
  kit.col(x - halfX, 0, z - halfZ, x + halfX, top, z + halfZ, 'metal');
  kit.metalRects.push([x - halfX, z - halfZ, x + halfX, z + halfZ]);
  return top;
}
/**
 * Lays a cable along the ground through `[x, z]` points (or `[x, z, y]` to
 * lift a point), adding gentle wiggles on long flat stretches.
 */
export function layGroundCable(
  kit: LevelKit,
  points: number[][],
  radius = 0.025,
  material: MaterialRef = 'rubber',
  lift: number | null = null
): THREE.Mesh {
  const path = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    path.push([p[0], p.length > 2 ? p[2] : (lift ?? radius * 0.9), p[1]]);
    if (i < points.length - 1) {
      const next = points[i + 1];
      const dx = next[0] - p[0];
      const dz = next[1] - p[1];
      const dist = Math.hypot(dx, dz);
      if (dist > 2.2 && p.length < 3 && next.length < 3) {
        const steps = Math.floor(dist / 1.6);
        for (let step = 1; step < steps; step++) {
          const t = step / steps;
          const wiggle = Math.sin((i * 3.1 + step) * 2.3) * Math.min(0.28, dist * 0.04);
          path.push([
            p[0] + dx * t - (dz / dist) * wiggle,
            lift ?? radius * 0.9,
            p[1] + dz * t + (dx / dist) * wiggle
          ]);
        }
      }
    }
  }
  return kit.tube(material, path, radius, {
    radial: 6,
    cast: false
  });
}
/** Grey electrical power pedestal on a concrete pad. */
export function placePowerPedestal(kit: LevelKit, x: number, z: number, yaw = 0): THREE.Group {
  const root = propRoot(kit, x, z, yaw);
  propBox(kit, root, 'concrete', 0.7, 0.12, 0.5, 0, 0.06, 0, 0.015);
  propBox(kit, root, 'paint_grey', 0.55, 0.9, 0.3, 0, 0.57, 0, 0.015);
  propBox(kit, root, 'steel_dark', 0.5, 0.03, 0.34, 0, 1.03, 0);
  propBox(kit, root, 'hazard_stripes', 0.3, 0.12, 0.01, 0, 0.8, 0.156);
  propFootprintCollider(kit, x, z, yaw, 0.7, 0.5, 1.05, 'metal');
  return root;
}
