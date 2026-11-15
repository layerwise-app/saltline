// Static collision world: a flat list of axis-aligned boxes used for bullet raycasts,
// line-of-sight checks, player capsule movement and ground queries, plus a coarse
// navigation grid (rebuilt lazily from the boxes) with A* path finding for enemies.
import { Vector3 } from 'three';
import type { Vector3Like } from 'three';
import { WORLD_BOUNDS } from '../core/config';
import type { Game } from '../core/types';

const STEP_HEIGHT = 0.42;
const NAV_CELL_SIZE = 0.5;
const NAV_MIN_X = -40;
const NAV_MAX_X = 31;
const NAV_MIN_Z = -32;
const NAV_MAX_Z = 30;
const NAV_COLS = Math.round((NAV_MAX_X - NAV_MIN_X) / NAV_CELL_SIZE);
const NAV_ROWS = Math.round((NAV_MAX_Z - NAV_MIN_Z) / NAV_CELL_SIZE);
const NAV_OBSTACLE_PADDING = 0.5;

/** A point given either as a `Vector3` or as an `[x, y, z]` array. */
export type BoxCorner = Vector3 | ArrayLike<number>;

/** Anything with horizontal `x` / `z` coordinates. */
export interface PointXZ {
  x: number;
  z: number;
}

/** Options for {@link CollisionWorld.addBox}. */
export interface CollisionBoxOptions {
  /** Surface name used for footsteps / impact effects (default `'concrete'`). */
  surface?: string;
  tag?: string;
  /** Don't block the navigation grid. */
  noNav?: boolean;
  /** Only stops bullets (ignored by movement, ground and nav). */
  bulletOnly?: boolean;
  /** Only stops the player (ignored by raycasts). */
  playerOnly?: boolean;
}

/** An axis-aligned collision box in world space. */
export interface CollisionBox {
  min: Vector3;
  max: Vector3;
  surface: string;
  tag: string;
  noNav: boolean;
  bulletOnly: boolean;
  playerOnly: boolean;
}

/** Result of {@link CollisionWorld.raycast}. `box` is null for ground / water hits. */
export interface RaycastHit {
  dist: number;
  point: Vector3;
  normal: Vector3;
  surface: string;
  box: CollisionBox | null;
}

/** Result of {@link CollisionWorld.moveCapsule}. */
export interface CapsuleMoveResult {
  onGround: boolean;
  hitWall: boolean;
  hitCeil: boolean;
  surface: string;
}

/** Raw navigation grid data (debug view). */
export interface NavGridInfo {
  /** 1 = blocked cell, row-major (`row * w + col`). */
  blocked: Uint8Array;
  w: number;
  h: number;
  minX: number;
  minZ: number;
  cell: number;
}

/** Navigation grid queries. */
export interface NavGrid {
  cell: number;
  isWalkable(x: number, z: number): boolean;
  /** Smoothed waypoint list (y = 0) from `from` to `to`, or null when unreachable. */
  findPath(from: PointXZ, to: PointXZ): Vector3[] | null;
  randomPoint(center: PointXZ, radius: number): Vector3;
  clearLine(from: PointXZ, to: PointXZ): boolean;
  _grid(): NavGridInfo;
}

/** The collision world stored as `game.physics`. */
export interface CollisionWorld {
  boxes: CollisionBox[];
  bounds: { min: Vector3; max: Vector3 };
  addBox(min: BoxCorner, max: BoxCorner, options?: CollisionBoxOptions): CollisionBox;
  removeBox(box: CollisionBox): void;
  /** Rebuild the navigation grid now. */
  build(): void;
  /** Cast a ray (`dir` must be normalised) against boxes, the quay ground and the sea. */
  raycast(origin: Vector3Like, dir: Vector3Like, maxDist?: number): RaycastHit | null;
  lineOfSight(from: Vector3Like, to: Vector3Like): boolean;
  /** Highest walkable surface at (x, z) that is not above `maxY`. */
  groundHeight(x: number, z: number, maxY?: number): number;
  /**
   * Move a vertical capsule (feet at `pos`) by `vel * dt`, sliding along walls,
   * stepping up small ledges and resolving ground / ceiling. Mutates `pos` and `vel`.
   */
  moveCapsule(
    pos: Vector3,
    vel: Vector3,
    dt: number,
    radius?: number,
    height?: number,
    canStep?: boolean
  ): CapsuleMoveResult;
  nav: NavGrid;
}

/** Create the collision world for a game. */
export function createCollisionWorld(game: Game): CollisionWorld {
  const boxes: CollisionBox[] = [];
  let navDirty = true;
  let blocked = new Uint8Array(NAV_COLS * NAV_ROWS);
  const tmpDelta = new Vector3();
  const world: CollisionWorld = {
    boxes,
    bounds: {
      min: WORLD_BOUNDS.min.clone(),
      max: WORLD_BOUNDS.max.clone()
    },
    addBox(minCorner, maxCorner, options = {}) {
      const a = toVector3(minCorner);
      const b = toVector3(maxCorner);
      const box: CollisionBox = {
        min: new Vector3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)),
        max: new Vector3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)),
        surface: options.surface || 'concrete',
        tag: options.tag || '',
        noNav: !!options.noNav,
        bulletOnly: !!options.bulletOnly,
        playerOnly: !!options.playerOnly
      };
      boxes.push(box);
      navDirty = true;
      return box;
    },
    removeBox(box) {
      const index = boxes.indexOf(box);
      if (index >= 0) {
        boxes.splice(index, 1);
        navDirty = true;
      }
    },
    build() {
      rebuildNavGrid();
    },
    raycast(origin, dir, maxDist = 500) {
      let bestDist = maxDist;
      let hitBox: CollisionBox | null = null;
      let hitAxis = -1;
      let hitSign = 0;
      // 0 = box hit, 1 = ground, 2 = water
      let groundHit = 0;
      const ox = origin.x;
      const oy = origin.y;
      const oz = origin.z;
      const dx = dir.x;
      const dy = dir.y;
      const dz = dir.z;
      if (dy < -1e-6) {
        const groundT = (WORLD_BOUNDS.groundY - oy) / dy;
        if (groundT > 0 && groundT < bestDist) {
          if (ox + dx * groundT <= WORLD_BOUNDS.quayX) {
            bestDist = groundT;
            groundHit = 1;
          } else {
            const seaT = (WORLD_BOUNDS.seaY - oy) / dy;
            if (seaT > 0 && seaT < bestDist) {
              bestDist = seaT;
              groundHit = 2;
            }
          }
        }
      }
      const invX = dx === 0 ? Infinity : 1 / dx;
      const invY = dy === 0 ? Infinity : 1 / dy;
      const invZ = dz === 0 ? Infinity : 1 / dz;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.playerOnly) continue;
        let tEnter = 0;
        let tExit = bestDist;
        let enterAxis = -1;
        let enterSign = 0;
        let tNear: number;
        let tFar: number;
        if (dx !== 0) {
          tNear = (box.min.x - ox) * invX;
          tFar = (box.max.x - ox) * invX;
          let sign = -1;
          if (tNear > tFar) {
            const swap = tNear;
            tNear = tFar;
            tFar = swap;
            sign = 1;
          }
          if (tNear > tEnter) {
            tEnter = tNear;
            enterAxis = 0;
            enterSign = sign;
          }
          if (tFar < tExit) tExit = tFar;
          if (tEnter > tExit) continue;
        } else if (ox < box.min.x || ox > box.max.x) continue;
        if (dy !== 0) {
          tNear = (box.min.y - oy) * invY;
          tFar = (box.max.y - oy) * invY;
          let sign = -1;
          if (tNear > tFar) {
            const swap = tNear;
            tNear = tFar;
            tFar = swap;
            sign = 1;
          }
          if (tNear > tEnter) {
            tEnter = tNear;
            enterAxis = 1;
            enterSign = sign;
          }
          if (tFar < tExit) tExit = tFar;
          if (tEnter > tExit) continue;
        } else if (oy < box.min.y || oy > box.max.y) continue;
        if (dz !== 0) {
          tNear = (box.min.z - oz) * invZ;
          tFar = (box.max.z - oz) * invZ;
          let sign = -1;
          if (tNear > tFar) {
            const swap = tNear;
            tNear = tFar;
            tFar = swap;
            sign = 1;
          }
          if (tNear > tEnter) {
            tEnter = tNear;
            enterAxis = 2;
            enterSign = sign;
          }
          if (tFar < tExit) tExit = tFar;
          if (tEnter > tExit) continue;
        } else if (oz < box.min.z || oz > box.max.z) continue;
        if (enterAxis >= 0) {
          bestDist = tEnter;
          hitBox = box;
          hitAxis = enterAxis;
          hitSign = enterSign;
          groundHit = 0;
        }
      }
      if (!hitBox && !groundHit) return null;
      const point = new Vector3(ox + dx * bestDist, oy + dy * bestDist, oz + dz * bestDist);
      if (groundHit) {
        return {
          dist: bestDist,
          point,
          normal: new Vector3(0, 1, 0),
          surface:
            groundHit === 2
              ? 'water'
              : game.level && game.level.groundSurfaceAt
                ? game.level.groundSurfaceAt(point.x, point.z)
                : 'concrete',
          box: null
        };
      }
      const normal = new Vector3();
      normal.setComponent(hitAxis, hitSign);
      // hitBox is non-null here: groundHit is 0, so a box was hit.
      const box = hitBox as CollisionBox;
      return {
        dist: bestDist,
        point,
        normal,
        surface: box.surface,
        box
      };
    },
    lineOfSight(from, to) {
      tmpDelta.subVectors(to, from);
      const dist = tmpDelta.length();
      if (dist < 1e-4) return true;
      tmpDelta.multiplyScalar(1 / dist);
      return !world.raycast(from, tmpDelta, dist - 0.05);
    },
    groundHeight(x, z, maxY = 50) {
      let height = x <= WORLD_BOUNDS.quayX ? WORLD_BOUNDS.groundY : WORLD_BOUNDS.seaY;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.bulletOnly) continue;
        if (
          x >= box.min.x &&
          x <= box.max.x &&
          z >= box.min.z &&
          z <= box.max.z &&
          box.max.y <= maxY &&
          box.max.y > height
        ) {
          height = box.max.y;
        }
      }
      return height;
    },
    moveCapsule(pos, vel, dt, radius = 0.32, height = 1.8, canStep = true) {
      const result: CapsuleMoveResult = {
        onGround: false,
        hitWall: false,
        hitCeil: false,
        surface: 'concrete'
      };
      const moveX = vel.x * dt;
      const moveZ = vel.z * dt;
      const subSteps = Math.max(1, Math.ceil(Math.hypot(moveX, moveZ) / (radius * 0.6)));
      const startY = pos.y;
      for (let step = 0; step < subSteps; step++) {
        pos.x += moveX / subSteps;
        pos.z += moveZ / subSteps;
        for (let iteration = 0; iteration < 3; iteration++) {
          let pushed = false;
          for (let i = 0; i < boxes.length; i++) {
            const box = boxes[i];
            if (
              box.bulletOnly ||
              box.max.y <= pos.y + (canStep ? STEP_HEIGHT : 0.08) ||
              box.min.y >= pos.y + height
            )
              continue;
            const closestX = Math.max(box.min.x, Math.min(box.max.x, pos.x));
            const closestZ = Math.max(box.min.z, Math.min(box.max.z, pos.z));
            let offX = pos.x - closestX;
            let offZ = pos.z - closestZ;
            const distSq = offX * offX + offZ * offZ;
            if (!(distSq >= radius * radius)) {
              if (distSq > 1e-10) {
                const dist = Math.sqrt(distSq);
                const penetration = radius - dist;
                offX /= dist;
                offZ /= dist;
                pos.x += offX * penetration;
                pos.z += offZ * penetration;
                const into = vel.x * offX + vel.z * offZ;
                if (into < 0) {
                  vel.x -= offX * into;
                  vel.z -= offZ * into;
                }
              } else {
                // Centre is inside the box: push out through the nearest face.
                const toMinX = pos.x - box.min.x;
                const toMaxX = box.max.x - pos.x;
                const toMinZ = pos.z - box.min.z;
                const toMaxZ = box.max.z - pos.z;
                const nearest = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
                if (nearest === toMinX) {
                  pos.x = box.min.x - radius;
                  if (vel.x > 0) vel.x = 0;
                } else if (nearest === toMaxX) {
                  pos.x = box.max.x + radius;
                  if (vel.x < 0) vel.x = 0;
                } else if (nearest === toMinZ) {
                  pos.z = box.min.z - radius;
                  if (vel.z > 0) vel.z = 0;
                } else {
                  pos.z = box.max.z + radius;
                  if (vel.z < 0) vel.z = 0;
                }
              }
              pushed = true;
              result.hitWall = true;
            }
          }
          if (!pushed) break;
        }
      }
      const nextY = pos.y + vel.y * dt;
      const footRadius = radius * 0.7;
      let floorY = pos.x <= WORLD_BOUNDS.quayX + footRadius ? WORLD_BOUNDS.groundY : -50;
      let floorSurface: string | null = null;
      let ceilY = Infinity;
      const maxStepTop = startY + (canStep ? STEP_HEIGHT : 0.08) + 1e-4;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (
          box.bulletOnly ||
          pos.x + footRadius < box.min.x ||
          pos.x - footRadius > box.max.x ||
          pos.z + footRadius < box.min.z ||
          pos.z - footRadius > box.max.z
        )
          continue;
        if (box.max.y <= maxStepTop && box.max.y > floorY) {
          floorY = box.max.y;
          floorSurface = box.surface;
        }
        if (box.min.y >= startY + height - 0.05 && box.min.y < ceilY) ceilY = box.min.y;
      }
      if (vel.y > 0 && nextY + height > ceilY) {
        pos.y = ceilY - height;
        vel.y = 0;
        result.hitCeil = true;
      } else if (nextY <= floorY) {
        pos.y = floorY;
        if (vel.y < 0) vel.y = 0;
        result.onGround = true;
      } else if (canStep && vel.y <= 0 && nextY - floorY < STEP_HEIGHT) {
        pos.y = floorY;
        vel.y = 0;
        result.onGround = true;
      } else {
        pos.y = nextY;
      }
      if (result.onGround) {
        result.surface =
          floorSurface ||
          (game.level && game.level.groundSurfaceAt
            ? game.level.groundSurfaceAt(pos.x, pos.z)
            : 'concrete');
      }
      return result;
    },
    nav: {
      cell: NAV_CELL_SIZE,
      isWalkable(x, z) {
        ensureNavGrid();
        const cell = cellAt(x, z);
        return cell >= 0 && !blocked[cell];
      },
      findPath(from, to) {
        ensureNavGrid();
        const startCell = nearestOpenCell(from.x, from.z);
        const goalCell = nearestOpenCell(to.x, to.z);
        if (startCell < 0 || goalCell < 0) return null;
        if (startCell === goalCell) return [new Vector3(to.x, 0, to.z)];
        const cells = findCellPath(startCell, goalCell);
        if (!cells) return null;
        // String-pull: skip ahead to the farthest cell in a clear line.
        const waypoints: Vector3[] = [];
        let current = 0;
        while (current < cells.length - 1) {
          let next = current + 1;
          for (let far = cells.length - 1; far > current + 1; far--) {
            if (cellsHaveClearLine(cells[current], cells[far])) {
              next = far;
              break;
            }
          }
          waypoints.push(cellCenter(cells[next]));
          current = next;
        }
        if (cellAt(to.x, to.z) === goalCell && waypoints.length) {
          waypoints[waypoints.length - 1].set(to.x, 0, to.z);
        }
        return waypoints;
      },
      randomPoint(center, radius) {
        ensureNavGrid();
        for (let attempt = 0; attempt < 24; attempt++) {
          const angle = Math.random() * 6.2832;
          const dist = Math.sqrt(Math.random()) * radius;
          const x = center.x + Math.cos(angle) * dist;
          const z = center.z + Math.sin(angle) * dist;
          const cell = cellAt(x, z);
          if (cell >= 0 && !blocked[cell]) return new Vector3(x, 0, z);
        }
        const fallback = nearestOpenCell(center.x, center.z);
        return fallback >= 0 ? cellCenter(fallback) : new Vector3(center.x, 0, center.z);
      },
      clearLine(from, to) {
        ensureNavGrid();
        const fromCell = cellAt(from.x, from.z);
        const toCell = cellAt(to.x, to.z);
        return fromCell >= 0 && toCell >= 0 && cellsHaveClearLine(fromCell, toCell);
      },
      _grid: () => {
        ensureNavGrid();
        return {
          blocked,
          w: NAV_COLS,
          h: NAV_ROWS,
          minX: NAV_MIN_X,
          minZ: NAV_MIN_Z,
          cell: NAV_CELL_SIZE
        };
      }
    }
  };
  function ensureNavGrid(): void {
    if (navDirty) rebuildNavGrid();
  }
  function rebuildNavGrid(): void {
    blocked = new Uint8Array(NAV_COLS * NAV_ROWS);
    navDirty = false;
    for (const box of boxes) {
      if (box.noNav || box.bulletOnly || box.max.y < STEP_HEIGHT + 0.05 || box.min.y > 1.5)
        continue;
      const col0 = Math.max(
        0,
        Math.floor((box.min.x - NAV_OBSTACLE_PADDING - NAV_MIN_X) / NAV_CELL_SIZE)
      );
      const col1 = Math.min(
        NAV_COLS - 1,
        Math.floor((box.max.x + NAV_OBSTACLE_PADDING - NAV_MIN_X) / NAV_CELL_SIZE)
      );
      const row0 = Math.max(
        0,
        Math.floor((box.min.z - NAV_OBSTACLE_PADDING - NAV_MIN_Z) / NAV_CELL_SIZE)
      );
      const row1 = Math.min(
        NAV_ROWS - 1,
        Math.floor((box.max.z + NAV_OBSTACLE_PADDING - NAV_MIN_Z) / NAV_CELL_SIZE)
      );
      for (let row = row0; row <= row1; row++)
        for (let col = col0; col <= col1; col++) blocked[row * NAV_COLS + col] = 1;
    }
    // Block the grid border and everything past the quay edge.
    for (let row = 0; row < NAV_ROWS; row++)
      for (let col = 0; col < NAV_COLS; col++) {
        if (
          NAV_MIN_X + (col + 0.5) * NAV_CELL_SIZE > WORLD_BOUNDS.quayX - NAV_OBSTACLE_PADDING ||
          col === 0 ||
          row === 0 ||
          col === NAV_COLS - 1 ||
          row === NAV_ROWS - 1
        ) {
          blocked[row * NAV_COLS + col] = 1;
        }
      }
  }
  /** Cell index at a world position, or -1 when outside the grid. */
  function cellAt(x: number, z: number): number {
    const col = Math.floor((x - NAV_MIN_X) / NAV_CELL_SIZE);
    const row = Math.floor((z - NAV_MIN_Z) / NAV_CELL_SIZE);
    return col < 0 || row < 0 || col >= NAV_COLS || row >= NAV_ROWS ? -1 : row * NAV_COLS + col;
  }
  function cellCenter(cell: number): Vector3 {
    return new Vector3(
      NAV_MIN_X + ((cell % NAV_COLS) + 0.5) * NAV_CELL_SIZE,
      0,
      NAV_MIN_Z + (Math.floor(cell / NAV_COLS) + 0.5) * NAV_CELL_SIZE
    );
  }
  /** Nearest unblocked cell to a world position (searching rings up to 12 cells), or -1. */
  function nearestOpenCell(x: number, z: number): number {
    let col = Math.floor((x - NAV_MIN_X) / NAV_CELL_SIZE);
    let row = Math.floor((z - NAV_MIN_Z) / NAV_CELL_SIZE);
    col = Math.max(0, Math.min(NAV_COLS - 1, col));
    row = Math.max(0, Math.min(NAV_ROWS - 1, row));
    if (!blocked[row * NAV_COLS + col]) return row * NAV_COLS + col;
    for (let ring = 1; ring <= 12; ring++) {
      let bestCell = -1;
      let bestDistSq = 1e9;
      for (let dRow = -ring; dRow <= ring; dRow++)
        for (let dCol = -ring; dCol <= ring; dCol++) {
          if (Math.max(Math.abs(dCol), Math.abs(dRow)) !== ring) continue;
          const c = col + dCol;
          const r = row + dRow;
          if (!(c < 0 || r < 0 || c >= NAV_COLS || r >= NAV_ROWS) && !blocked[r * NAV_COLS + c]) {
            const distSq = dCol * dCol + dRow * dRow;
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              bestCell = r * NAV_COLS + c;
            }
          }
        }
      if (bestCell >= 0) return bestCell;
    }
    return -1;
  }
  /** Bresenham walk between two cells; false if any cell (or diagonal corner) is blocked. */
  function cellsHaveClearLine(fromCell: number, toCell: number): boolean {
    let col = fromCell % NAV_COLS;
    let row = Math.floor(fromCell / NAV_COLS);
    const endCol = toCell % NAV_COLS;
    const endRow = Math.floor(toCell / NAV_COLS);
    const spanCols = Math.abs(endCol - col);
    const spanRows = Math.abs(endRow - row);
    const stepCol = col < endCol ? 1 : -1;
    const stepRow = row < endRow ? 1 : -1;
    let err = spanCols - spanRows;
    for (let i = 0; i < 600; i++) {
      if (blocked[row * NAV_COLS + col]) return false;
      if (col === endCol && row === endRow) return true;
      const err2 = 2 * err;
      if (err2 > -spanRows && err2 < spanCols) {
        if (blocked[row * NAV_COLS + col + stepCol] || blocked[(row + stepRow) * NAV_COLS + col])
          return false;
        err += spanCols - spanRows;
        col += stepCol;
        row += stepRow;
      } else if (err2 > -spanRows) {
        err -= spanRows;
        col += stepCol;
      } else {
        err += spanCols;
        row += stepRow;
      }
    }
    return false;
  }
  // A* scratch state, reused across searches (entries are valid when stamped with `searchId`).
  const costSoFar = new Float32Array(NAV_COLS * NAV_ROWS);
  const cameFrom = new Int32Array(NAV_COLS * NAV_ROWS);
  const seenStamp = new Uint32Array(NAV_COLS * NAV_ROWS);
  const closedStamp = new Uint32Array(NAV_COLS * NAV_ROWS);
  let searchId = 0;
  const heapCells: number[] = [];
  const heapPriorities: number[] = [];
  function heapPush(cell: number, priority: number): void {
    let index = heapCells.length;
    heapCells.push(cell);
    heapPriorities.push(priority);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heapPriorities[parent] <= priority) break;
      heapCells[index] = heapCells[parent];
      heapPriorities[index] = heapPriorities[parent];
      index = parent;
    }
    heapCells[index] = cell;
    heapPriorities[index] = priority;
  }
  function heapPop(): number {
    const top = heapCells[0];
    // Only called while the heap is non-empty.
    const lastCell = heapCells.pop()!;
    const lastPriority = heapPriorities.pop()!;
    const size = heapCells.length;
    if (size) {
      let index = 0;
      for (;;) {
        let child = 2 * index + 1;
        if (child >= size) break;
        if (child + 1 < size && heapPriorities[child + 1] < heapPriorities[child]) child++;
        if (heapPriorities[child] >= lastPriority) break;
        heapCells[index] = heapCells[child];
        heapPriorities[index] = heapPriorities[child];
        index = child;
      }
      heapCells[index] = lastCell;
      heapPriorities[index] = lastPriority;
    }
    return top;
  }
  /** 8-connected A* over the grid; returns the cell list from start to goal or null. */
  function findCellPath(startCell: number, goalCell: number): number[] | null {
    searchId++;
    heapCells.length = 0;
    heapPriorities.length = 0;
    const goalCol = goalCell % NAV_COLS;
    const goalRow = Math.floor(goalCell / NAV_COLS);
    const heuristic = (cell: number): number => {
      const dCol = Math.abs((cell % NAV_COLS) - goalCol);
      const dRow = Math.abs(Math.floor(cell / NAV_COLS) - goalRow);
      return dCol + dRow + (1.4142 - 2) * Math.min(dCol, dRow);
    };
    costSoFar[startCell] = 0;
    seenStamp[startCell] = searchId;
    cameFrom[startCell] = -1;
    heapPush(startCell, heuristic(startCell));
    let expanded = 0;
    while (heapCells.length) {
      const cell = heapPop();
      if (cell === goalCell) break;
      if (closedStamp[cell] === searchId) continue;
      closedStamp[cell] = searchId;
      if (++expanded > 9000) return null;
      const col = cell % NAV_COLS;
      const row = Math.floor(cell / NAV_COLS);
      for (let dRow = -1; dRow <= 1; dRow++)
        for (let dCol = -1; dCol <= 1; dCol++) {
          if (!dCol && !dRow) continue;
          const nCol = col + dCol;
          const nRow = row + dRow;
          if (nCol < 0 || nRow < 0 || nCol >= NAV_COLS || nRow >= NAV_ROWS) continue;
          const neighbor = nRow * NAV_COLS + nCol;
          if (
            blocked[neighbor] ||
            closedStamp[neighbor] === searchId ||
            (dCol && dRow && (blocked[row * NAV_COLS + nCol] || blocked[nRow * NAV_COLS + col]))
          )
            continue;
          const cost = costSoFar[cell] + (dCol && dRow ? 1.4142 : 1);
          if (seenStamp[neighbor] !== searchId || cost < costSoFar[neighbor]) {
            costSoFar[neighbor] = cost;
            seenStamp[neighbor] = searchId;
            cameFrom[neighbor] = cell;
            heapPush(neighbor, cost + heuristic(neighbor));
          }
        }
    }
    if (seenStamp[goalCell] !== searchId) return null;
    const path: number[] = [];
    for (let cell = goalCell; cell !== -1; cell = cameFrom[cell]) path.push(cell);
    path.reverse();
    return path;
  }
  return world;
}

function toVector3(point: BoxCorner): Vector3 {
  if ('isVector3' in point && point.isVector3) return point.clone();
  const array = point as ArrayLike<number>;
  return new Vector3(array[0], array[1], array[2]);
}
