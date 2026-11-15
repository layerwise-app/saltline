/**
 * Explosive props (red barrels, gas cylinder racks): places the level's
 * explosives plus extra barrels next to cover, instances the barrel meshes,
 * registers their collision boxes, and runs the damage -> leaking fuse ->
 * blast cycle (chain reactions, fx, area damage, enemy alert).
 */
import { Box3, Group, InstancedMesh, Matrix4, Vector3 } from 'three';
import type { BufferGeometry, Material, Mesh, Object3D } from 'three';
import type { Game } from '../core/types';
import { mergeStaticMeshes } from '../render/geometry';
import type { CollisionBox } from '../world/physics';

/** Tuning of one explosive kind. */
export interface ExplosiveSpec {
  hp: number;
  /** Seconds between being lit and blowing up. */
  fuse: number;
  /** Visual explosion size. */
  size: number;
  /** Damage radius. */
  radius: number;
  damage: number;
  chain: number;
}

const EXPLOSIVE_TYPES: Record<string, ExplosiveSpec | undefined> & {
  barrel: ExplosiveSpec;
} = {
  barrel: {
    hp: 50,
    fuse: 1.6,
    size: 1.9,
    radius: 6.5,
    damage: 170,
    chain: 5.2
  },
  gas_cylinders: {
    hp: 70,
    fuse: 1.1,
    size: 2.3,
    radius: 7.5,
    damage: 210,
    chain: 6
  }
};
/** Approximate (x, z) spots near which extra barrels are placed against cover. */
const EXPLOSIVE_SPAWN_SPOTS: [number, number][] = [
  [-12, 6.5],
  [-5, 1.5],
  [9, 7],
  [13, 13],
  [-14, 13],
  [1, 20],
  [11, 21],
  [-20, 19],
  [19, 9],
  [21, -6],
  [24, 11],
  [-21, -5],
  [0, -14.5],
  [-11, -21],
  [9, -24.5]
];

/** An explosive placement (from the level or generated). */
export interface ExplosiveDef {
  /** Prop name (`'barrel'`, `'gas_cylinders'`). */
  name: string;
  x: number;
  y?: number;
  z: number;
  yaw?: number;
  opts?: Record<string, unknown>;
}

/** One instance slot of an instanced barrel part. */
interface InstanceSlot {
  im: InstancedMesh;
  i: number;
  m: Matrix4;
}

/** A live explosive prop. */
export interface ExplosiveItem {
  def: ExplosiveDef;
  obj: Object3D;
  /** Instance slots when the barrel is drawn through shared instanced meshes. */
  inst: InstanceSlot[] | null;
  kind: string;
  spec: ExplosiveSpec;
  min: Vector3;
  max: Vector3;
  pos: Vector3;
  hp: number;
  /** Seconds until it blows; negative when not lit. */
  fuse: number;
  alive: boolean;
  box: CollisionBox | null;
  /** Where the leak sparks / smoke come out while the fuse burns. */
  leak: Vector3;
  leakDir: Vector3;
  tick: number;
}

/**
 * The explosives system (`game.explosives`). Only `items`, `reset` and
 * `update` exist on the fallback used when building it fails.
 */
export interface Explosives {
  items: ExplosiveItem[];
  root?: Group;
  /** Number of explosives still intact. */
  count?(): number;
  reset(): void;
  /** Debug: blow up (or just light) the n-th intact explosive; returns its position. */
  debugBlast?(index?: number, instant?: boolean): Vector3 | null;
  update(dt: number): void;
}

/** Payload of the `impact` event, as far as explosives care. */
interface ImpactEvent {
  box?: CollisionBox | null;
  from?: string;
  point?: Vector3;
  dir?: Vector3;
}

/** Payload of the `explosion` event. */
interface ExplosionEvent {
  pos?: Vector3;
  size?: number;
}

interface InstanceBucket {
  geo: BufferGeometry;
  mat: Material;
  cast: boolean;
  recv: boolean;
  list: { it: ExplosiveItem; m: Matrix4 }[];
}

/** Places the explosives and returns the system that ticks their fuses. */
export function createExplosives(game: Game): Explosives {
  const root = new Group();
  root.name = 'explosives';
  game.scene.add(root);
  const items: ExplosiveItem[] = [];
  const itemByBox = new Map<CollisionBox, ExplosiveItem>();
  const random: () => number = game.rng && game.rng.fork ? game.rng.fork() : Math.random;
  const bounds = new Box3();
  const colliderBox = new Box3();
  const tmpVel = new Vector3();
  const blastPos = new Vector3();
  const up = new Vector3(0, 1, 0);

  function addExplosive(def: ExplosiveDef): ExplosiveItem | null {
    let obj: Object3D | null = null;
    try {
      obj = game.props.build(def.name, {
        ...(def.opts || {}),
        ...(def.name === 'barrel'
          ? {
              color: 'red'
            }
          : {})
      });
    } catch (err) {
      console.warn('[explosives] build failed: ' + err);
      return null;
    }
    obj.position.set(def.x, def.y || 0, def.z);
    obj.rotation.y = def.yaw || 0;
    root.add(obj);
    obj.updateMatrixWorld(true);
    bounds.makeEmpty();
    const colliders: { min: number[]; max: number[] }[] = obj.userData.colliders || [];
    for (const collider of colliders) {
      colliderBox.min.fromArray(collider.min);
      colliderBox.max.fromArray(collider.max);
      colliderBox.applyMatrix4(obj.matrixWorld);
      bounds.union(colliderBox);
    }
    if (bounds.isEmpty()) {
      const size: number[] = obj.userData.size || [0.6, 0.9, 0.6];
      bounds.min.set(def.x - size[0] / 2, def.y || 0, def.z - size[2] / 2);
      bounds.max.set(def.x + size[0] / 2, (def.y || 0) + size[1], def.z + size[2] / 2);
    }
    const spec = EXPLOSIVE_TYPES[def.name] || EXPLOSIVE_TYPES.barrel;
    const item: ExplosiveItem = {
      def,
      obj,
      inst: null,
      kind: def.name,
      spec,
      min: bounds.min.clone(),
      max: bounds.max.clone(),
      pos: bounds.getCenter(new Vector3()),
      hp: spec.hp,
      fuse: -1,
      alive: true,
      box: null,
      leak: new Vector3(),
      leakDir: new Vector3(0, 1, 0),
      tick: 0
    };
    items.push(item);
    addCollider(item);
    return item;
  }

  function addCollider(item: ExplosiveItem): void {
    if (item.box) return;
    item.box = game.physics.addBox(item.min, item.max, {
      surface: 'metal',
      tag: 'explosive'
    });
    itemByBox.set(item.box, item);
  }

  const levelExplosives: ExplosiveDef[] = (game.level && game.level.explosives) || [];
  for (const def of levelExplosives) addExplosive(def);

  // Extra barrels: for each spot, the nearest open cell that sits right against cover.
  try {
    const nav = game.physics.nav;
    const playerStart = game.level && game.level.playerStart && game.level.playerStart.pos;
    const isOpen = (x: number, z: number) =>
      nav.isWalkable(x, z) &&
      nav.isWalkable(x + 0.3, z) &&
      nav.isWalkable(x - 0.3, z) &&
      nav.isWalkable(x, z + 0.3) &&
      nav.isWalkable(x, z - 0.3);
    const isAgainstCover = (x: number, z: number) =>
      x < 28 &&
      x > -37 &&
      Math.abs(z) < 27 &&
      (!nav.isWalkable(x + 0.6, z) ||
        !nav.isWalkable(x - 0.6, z) ||
        !nav.isWalkable(x, z + 0.6) ||
        !nav.isWalkable(x, z - 0.6));
    let placed = 0;
    for (const [spotX, spotZ] of EXPLOSIVE_SPAWN_SPOTS) {
      let best: [number, number] | null = null;
      let bestDistSq = 1e9;
      for (let dz = -3; dz <= 3; dz += 0.5)
        for (let dx = -3; dx <= 3; dx += 0.5) {
          const x = spotX + dx;
          const z = spotZ + dz;
          const distSq = dx * dx + dz * dz;
          if (
            distSq >= bestDistSq ||
            !isOpen(x, z) ||
            !isAgainstCover(x, z) ||
            (playerStart && Math.hypot(x - playerStart.x, z - playerStart.z) < 7)
          )
            continue;
          let blocked = false;
          for (const other of items)
            if (Math.hypot(other.pos.x - x, other.pos.z - z) < 1.1) {
              blocked = true;
              break;
            }
          const objectives: { pos?: Vector3 }[] = (game.level && game.level.objectives) || [];
          for (const objective of objectives) {
            if (objective.pos && Math.hypot(objective.pos.x - x, objective.pos.z - z) < 2.2) {
              blocked = true;
            }
          }
          if (!blocked) {
            best = [x, z];
            bestDistSq = distSq;
          }
        }
      if (!best) continue;
      let [x, z] = best;
      // Nudge towards the cover it leans on.
      if (!nav.isWalkable(x + 0.6, z)) x += 0.2;
      else if (!nav.isWalkable(x - 0.6, z)) x -= 0.2;
      else if (!nav.isWalkable(x, z + 0.6)) z += 0.2;
      else z -= 0.2;
      const shed = game.level && game.level.interiorBoxes && game.level.interiorBoxes[0];
      const y =
        shed && x > shed.min.x && x < shed.max.x && z > shed.min.z && z < shed.max.z ? 0.03 : 0;
      addExplosive({
        name: 'barrel',
        x,
        y,
        z,
        yaw: random() * 6.28,
        opts: {
          seed: 100 + (placed % 2)
        }
      });
      placed++;
    }
  } catch (err) {
    console.warn('[explosives] extra barrels skipped: ' + ((err && (err as Error).message) || err));
  }

  // Barrels share instanced meshes (one per geometry + material); other kinds get merged.
  const hiddenMatrix = new Matrix4().makeScale(0, 0, 0);
  try {
    const buckets = new Map<string, InstanceBucket>();
    for (const item of items) {
      item.obj.updateMatrixWorld(true);
      if (item.kind !== 'barrel') {
        const merged = mergeStaticMeshes(item.obj);
        root.remove(item.obj);
        root.add(merged);
        item.obj = merged;
        continue;
      }
      const slots: InstanceSlot[] = [];
      item.inst = slots;
      item.obj.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material)) return;
        const key = mesh.geometry.uuid + '|' + mesh.material.uuid;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            geo: mesh.geometry,
            mat: mesh.material,
            cast: mesh.castShadow,
            recv: mesh.receiveShadow,
            list: []
          };
          buckets.set(key, bucket);
        }
        bucket.list.push({
          it: item,
          m: mesh.matrixWorld.clone()
        });
      });
      root.remove(item.obj);
    }
    for (const bucket of buckets.values()) {
      const instanced = new InstancedMesh(bucket.geo, bucket.mat, bucket.list.length);
      instanced.castShadow = bucket.cast;
      instanced.receiveShadow = bucket.recv;
      instanced.frustumCulled = false;
      bucket.list.forEach((entry, index) => {
        instanced.setMatrixAt(index, entry.m);
        entry.it.inst!.push({
          im: instanced,
          i: index,
          m: entry.m
        });
      });
      instanced.instanceMatrix.needsUpdate = true;
      root.add(instanced);
    }
  } catch (err) {
    console.error(
      '[explosives] instancing failed, barrels stay as plain meshes: ' +
        ((err && (err as Error).stack) || err)
    );
    for (const item of items) {
      if (item.inst) {
        item.inst = null;
        if (!item.obj.parent) root.add(item.obj);
      }
    }
  }

  function setVisible(item: ExplosiveItem, visible: boolean): void {
    if (!item.inst) {
      item.obj.visible = visible;
      return;
    }
    for (const slot of item.inst) {
      slot.im.setMatrixAt(slot.i, visible ? slot.m : hiddenMatrix);
      slot.im.instanceMatrix.needsUpdate = true;
    }
  }

  /** Applies damage: lights the fuse (leaking from the hit point) or, at 0 hp, blows almost at once. */
  function damageItem(
    item: ExplosiveItem,
    amount: number,
    hitPoint: Vector3 | null | undefined,
    _dir: Vector3 | null | undefined
  ): void {
    if (!item.alive) return;
    item.hp -= amount;
    if (item.hp <= 0) {
      item.fuse = item.fuse < 0 ? 0.06 : Math.min(item.fuse, 0.06);
      return;
    }
    if (item.fuse < 0) {
      item.fuse = item.spec.fuse;
      if (hitPoint) {
        item.leak.copy(hitPoint);
        item.leakDir.set(hitPoint.x - item.pos.x, 0.35, hitPoint.z - item.pos.z).normalize();
      } else {
        item.leak.copy(item.pos);
        item.leak.y = item.max.y;
        item.leakDir.copy(up);
      }
      game.events.emit('explosive:lit', {
        pos: item.pos,
        kind: item.kind
      });
    }
  }

  game.events.on('impact', (event: ImpactEvent | null) => {
    const item = event && event.box && itemByBox.get(event.box);
    if (item && event) {
      // The weapon may expose the current gun's per-shot damage.
      const weapon = game.weapon as typeof game.weapon & { damage?: number };
      damageItem(
        item,
        event.from === 'player' ? (weapon && weapon.damage) || 26 : 9,
        event.point,
        event.dir
      );
    }
  });
  // Chain reactions: nearby explosives get a short random fuse.
  game.events.on('explosion', (event: ExplosionEvent | null) => {
    if (!event || !event.pos) return;
    const reach = 2.2 + (event.size || 1) * 1.6;
    for (const item of items) {
      if (!item.alive) continue;
      const dist = item.pos.distanceTo(event.pos);
      if (dist > reach || dist < 0.05) continue;
      const fuse = 0.14 + random() * 0.3 + dist * 0.03;
      item.fuse = item.fuse < 0 ? fuse : Math.min(item.fuse, fuse);
    }
  });

  function blowUp(item: ExplosiveItem): void {
    item.alive = false;
    item.fuse = -1;
    setVisible(item, false);
    if (item.box) {
      game.physics.removeBox(item.box);
      itemByBox.delete(item.box);
      item.box = null;
    }
    const spec = item.spec;
    blastPos.copy(item.pos);
    try {
      game.fx.explosion(blastPos, spec.size);
    } catch (err) {
      console.error('[explosives] fx.explosion threw', err);
    }
    try {
      game.fx.debris(blastPos, {
        count: 14,
        color: item.kind === 'barrel' ? 0x3a0f0a : 0x30343a,
        size: 0.09,
        speed: 9,
        spread: 1.4
      });
    } catch {}
    try {
      game.combat.explode(blastPos, spec.radius, spec.damage, 'explosive');
    } catch (err) {
      console.error('[explosives] combat.explode threw', err);
    }
    const player = game.player;
    if (player && player.addShake) {
      const closeness = Math.max(0, 1 - player.pos.distanceTo(blastPos) / 28);
      if (closeness > 0) player.addShake(0.15 + 0.9 * closeness * closeness);
    }
    try {
      if (game.enemies.alert) game.enemies.alert(blastPos, 60);
    } catch {}
    game.events.emit('explosive:blast', {
      pos: blastPos,
      kind: item.kind
    });
  }

  const explosives: Required<Explosives> = {
    items,
    root,
    count() {
      let alive = 0;
      for (const item of items) if (item.alive) alive++;
      return alive;
    },
    reset() {
      for (const item of items) {
        item.alive = true;
        item.hp = item.spec.hp;
        item.fuse = -1;
        setVisible(item, true);
        addCollider(item);
      }
    },
    debugBlast(index = 0, instant = true) {
      const alive = items.filter((item) => item.alive);
      const item = alive[index % Math.max(1, alive.length)];
      if (item) {
        if (instant) blowUp(item);
        else damageItem(item, 1, null, null);
      }
      return item ? item.pos.clone() : null;
    },
    update(dt) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.alive || item.fuse < 0) continue;
        item.fuse -= dt;
        if (item.fuse <= 0) {
          blowUp(item);
          continue;
        }
        item.tick -= dt;
        if (item.tick <= 0) {
          item.tick = 0.07;
          try {
            game.fx.sparks(item.leak, item.leakDir, 3);
            game.fx.smoke(item.leak, {
              size: 0.3,
              life: 0.9,
              rise: 1.4,
              count: 1,
              color: 0x151515,
              vel: tmpVel.copy(item.leakDir).multiplyScalar(1.5)
            });
            if (game.render && game.render.lightPool) {
              game.render.lightPool.flash(item.leak, 0xff7a20, 5, 4, 0.09);
            }
          } catch {}
        }
      }
    }
  };
  return explosives;
}
