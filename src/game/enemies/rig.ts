// Procedural skinned rigs for the enemy robots: a builder that collects bones and rigidly
// skinned (one bone per vertex) geometry pieces into material slots, a helper that turns
// the result into a THREE.SkinnedMesh with a live skeleton, and a two-bone leg IK solver.
import { Bone, Box3, BufferAttribute, Group, Skeleton, SkinnedMesh, Sphere, Vector3 } from 'three';
import type { BufferGeometry, Material } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** RGB vertex tint (values may exceed 1 for emissive-ish highlights). */
export type Tint = [number, number, number] | number[];

/** One bone of a rig definition, positioned in bind pose. */
export interface RigBoneDef {
  name: string;
  /** Index of the parent bone, or -1 for a root. */
  parent: number;
  /** Offset from the parent bone. */
  local: [number, number, number];
  /** Accumulated bind-pose position. */
  world: [number, number, number];
  /** Index of this bone in `bones`. */
  i: number;
}

/** The merged result of {@link RigBuilder.build}: one geometry group per material slot. */
export interface RigDef {
  geometry: BufferGeometry;
  /** Material slot names, in geometry group order. */
  slots: string[];
  bones: RigBoneDef[];
  tris: number;
  /** Optional secondary rig (the gull's translucent rotor discs and lamp cone). */
  extra?: RigDef;
}

/** Options for {@link createSkinnedRig}. */
export interface SkinnedRigOptions {
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Radius of the fixed bounding sphere used for culling. */
  radius?: number;
  /** Centre of the fixed bounding sphere. */
  center?: [number, number, number];
  /** A second rig def bound to the same skeleton (unshadowed, drawn later). */
  extra?: { def: RigDef; radius?: number } | null;
}

/** A live skinned rig instance. */
export interface SkinnedRig {
  group: Group;
  mesh: SkinnedMesh;
  bones: Record<string, Bone>;
  skeleton: Skeleton;
  extraMesh: SkinnedMesh | null;
}

/** Collects bones and per-bone geometry pieces, then merges them into a {@link RigDef}. */
export class RigBuilder {
  bones: RigBoneDef[] = [];
  index: Record<string, number> = {};
  slots: Record<string, BufferGeometry[]> = {};
  order: string[] = [];

  /** Adds a bone at offset (x, y, z) from `parentName` (or a root when null). */
  bone(name: string, parentName: string | null, x = 0, y = 0, z = 0): RigBoneDef {
    const parent = parentName ? this.bones[this.index[parentName]] : null;
    if (parentName && !parent) {
      throw new Error('rig: unknown parent bone ' + parentName);
    }
    const boneDef: RigBoneDef = {
      name: name,
      parent: parent ? parent.i : -1,
      local: [x, y, z],
      world: [
        x + (parent ? parent.world[0] : 0),
        y + (parent ? parent.world[1] : 0),
        z + (parent ? parent.world[2] : 0)
      ],
      i: this.bones.length
    };
    this.index[name] = boneDef.i;
    this.bones.push(boneDef);
    return boneDef;
  }

  /**
   * Adds a geometry piece (modelled relative to the bone) to material slot `slot`, rigidly
   * skinned to `boneName`. Vertex colors carry `tint`, optionally with a baked top-light
   * shading term.
   */
  add(
    slot: string,
    boneName: string,
    geometry: BufferGeometry,
    tint: Tint = [1, 1, 1],
    shade = true
  ): this {
    const bone = this.bones[this.index[boneName]];
    if (!bone) {
      throw new Error('rig: unknown bone ' + boneName);
    }
    const geo = geometry;
    if (!geo.attributes.normal) {
      geo.computeVertexNormals();
    }
    for (const attributeName of Object.keys(geo.attributes)) {
      if (attributeName !== 'position' && attributeName !== 'normal' && attributeName !== 'uv') {
        geo.deleteAttribute(attributeName);
      }
    }
    const vertexCount = geo.attributes.position.count;
    if (!geo.attributes.uv) {
      geo.setAttribute('uv', new BufferAttribute(new Float32Array(vertexCount * 2), 2));
    }
    geo.translate(bone.world[0], bone.world[1], bone.world[2]);
    const colors = new Float32Array(vertexCount * 3);
    const skinIndices = new Uint16Array(vertexCount * 4);
    const skinWeights = new Float32Array(vertexCount * 4);
    const normals = geo.attributes.normal;
    for (let v = 0; v < vertexCount; v++) {
      const shadeFactor = shade ? 0.74 + 0.26 * (normals.getY(v) * 0.5 + 0.5) : 1;
      colors[v * 3] = tint[0] * shadeFactor;
      colors[v * 3 + 1] = tint[1] * shadeFactor;
      colors[v * 3 + 2] = tint[2] * shadeFactor;
      skinIndices[v * 4] = bone.i;
      skinWeights[v * 4] = 1;
    }
    geo.setAttribute('color', new BufferAttribute(colors, 3));
    geo.setAttribute('skinIndex', new BufferAttribute(skinIndices, 4));
    geo.setAttribute('skinWeight', new BufferAttribute(skinWeights, 4));
    if (!this.slots[slot]) {
      this.slots[slot] = [];
      this.order.push(slot);
    }
    this.slots[slot].push(geo);
    return this;
  }

  /** Merges every non-empty slot (in `slotOrder`, or insertion order) into one grouped geometry. */
  build(slotOrder?: string[] | null): RigDef {
    const slotNames = (slotOrder || this.order).filter(
      (slot) => this.slots[slot] && this.slots[slot].length
    );
    const slotGeometries = slotNames.map((slot) => {
      const pieces = this.slots[slot];
      const sameIndexing = pieces.some((piece) => !piece.index)
        ? pieces.map((piece) => (piece.index ? piece.toNonIndexed() : piece))
        : pieces;
      const merged = mergeGeometries(sameIndexing, false);
      return merged.index ? merged.toNonIndexed() : merged;
    });
    const geometry = mergeGeometries(slotGeometries, true);
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return {
      geometry: geometry,
      slots: slotNames,
      bones: this.bones,
      tris: geometry.attributes.position.count / 3
    };
  }
}

/** Instantiates a rig def as a skinned mesh, using `materials[slot]` for each slot. */
export function createSkinnedRig(
  def: RigDef,
  materials: Record<string, Material>,
  {
    castShadow = true,
    receiveShadow = true,
    radius = 1.5,
    center = [0, 0.5, 0],
    extra = null
  }: SkinnedRigOptions = {}
): SkinnedRig {
  const bones = def.bones.map((boneDef) => {
    const bone = new Bone();
    bone.name = boneDef.name;
    bone.position.set(boneDef.local[0], boneDef.local[1], boneDef.local[2]);
    return bone;
  });
  def.bones.forEach((boneDef, i) => {
    if (boneDef.parent >= 0) {
      bones[boneDef.parent].add(bones[i]);
    }
  });
  const group = new Group();
  const mesh = new SkinnedMesh(
    def.geometry,
    def.slots.map((slot) => materials[slot])
  );
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  group.add(mesh);
  def.bones.forEach((boneDef, i) => {
    if (boneDef.parent < 0) {
      mesh.add(bones[i]);
    }
  });
  group.updateMatrixWorld(true);
  const skeleton = new Skeleton(bones);
  mesh.bind(skeleton);
  mesh.boundingSphere = new Sphere(new Vector3(center[0], center[1], center[2]), radius);
  mesh.boundingBox = new Box3(
    new Vector3(center[0] - radius, center[1] - radius, center[2] - radius),
    new Vector3(center[0] + radius, center[1] + radius, center[2] + radius)
  );
  const bonesByName: Record<string, Bone> = {};
  bones.forEach((bone) => {
    bonesByName[bone.name] = bone;
  });
  const rig: SkinnedRig = {
    group: group,
    mesh: mesh,
    bones: bonesByName,
    skeleton: skeleton,
    extraMesh: null
  };
  if (extra) {
    const extraMesh = new SkinnedMesh(
      extra.def.geometry,
      extra.def.slots.map((slot) => materials[slot])
    );
    extraMesh.castShadow = false;
    extraMesh.receiveShadow = false;
    extraMesh.renderOrder = 5;
    group.add(extraMesh);
    extraMesh.updateMatrixWorld(true);
    extraMesh.bind(skeleton, mesh.bindMatrix);
    extraMesh.boundingSphere = new Sphere(
      new Vector3(center[0], center[1], center[2]),
      extra.radius || radius
    );
    extraMesh.boundingBox = new Box3().setFromCenterAndSize(
      extraMesh.boundingSphere.center,
      new Vector3(1, 1, 1).multiplyScalar(2 * (extra.radius || radius))
    );
    rig.extraMesh = extraMesh;
  }
  return rig;
}

/** Output of {@link solveLegIk} (written in place). */
export interface LegIkResult {
  /** Hip abduction (roll about the body's long axis). */
  abd: number;
  /** Hip pitch. */
  hip: number;
  /** Knee pitch (always <= 0). */
  knee: number;
  /** Requested reach as a fraction of full leg length (may exceed 1). */
  reach: number;
}

/**
 * Solves a three-joint leg (abduction, hip, knee) so the foot reaches the target offset
 * (dx, dy, dz) from the abduction joint. `side` is +1/-1, `hipOffset` the abduction-to-hip
 * length, `upperLen`/`lowerLen` the thigh and shin lengths. Writes into and returns `out`.
 */
export function solveLegIk(
  out: LegIkResult,
  dx: number,
  dy: number,
  dz: number,
  side: number,
  hipOffset: number,
  upperLen: number,
  lowerLen: number
): LegIkResult {
  const distSqXY = dx * dx + dy * dy;
  const planeDist = Math.sqrt(Math.max(distSqXY - hipOffset * hipOffset, 1e-6));
  out.abd = Math.atan2(dy, dx) - Math.atan2(-planeDist, side * hipOffset);
  if (out.abd > Math.PI) {
    out.abd -= 2 * Math.PI;
  } else if (out.abd < -Math.PI) {
    out.abd += 2 * Math.PI;
  }
  let reach = Math.hypot(planeDist, dz);
  const maxReach = (upperLen + lowerLen) * 0.995;
  const minReach = Math.abs(upperLen - lowerLen) + 0.03;
  out.reach = reach / (upperLen + lowerLen);
  if (reach > maxReach) {
    reach = maxReach;
  } else if (reach < minReach) {
    reach = minReach;
  }
  const reachAngle = Math.atan2(dz, planeDist);
  const hipCos =
    (upperLen * upperLen + reach * reach - lowerLen * lowerLen) / (2 * upperLen * reach);
  const kneeCos =
    (upperLen * upperLen + lowerLen * lowerLen - reach * reach) / (2 * upperLen * lowerLen);
  const hipAngle = Math.acos(hipCos < -1 ? -1 : hipCos > 1 ? 1 : hipCos);
  const kneeAngle = Math.acos(kneeCos < -1 ? -1 : kneeCos > 1 ? 1 : kneeCos);
  out.hip = hipAngle - reachAngle;
  out.knee = -(Math.PI - kneeAngle);
  return out;
}
