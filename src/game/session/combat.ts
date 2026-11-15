/**
 * Combat resolution: turns player shots, enemy shots and explosions into
 * damage on enemies / the player, emits `impact` events and keeps the
 * shots / hits / kills tally used by the debrief.
 */
import { Vector3 } from 'three';
import type { Game } from '../core/types';
import type { CollisionBox } from '../world/physics';

/** Running accuracy / kill tally for the current run. */
export interface CombatStats {
  shots: number;
  hits: number;
  kills: number;
  /** Number of explosive-prop blasts (created lazily on the first one). */
  blasts?: number;
}

/** Options for a hitscan shot. */
export interface ShotOptions {
  damage?: number;
  range?: number;
  impulse?: number;
}

/** Payload of the `impact` event (also returned by `playerShot`). */
export interface ImpactInfo {
  point: Vector3;
  normal: Vector3;
  dist: number;
  surface: string;
  enemy: unknown;
  part?: string;
  dir: Vector3;
  from: 'player' | 'enemy';
  killed?: boolean;
  box?: CollisionBox | null;
}

/** Resolves hitscan shots and blast damage between the player, enemies and the world. */
export interface CombatResolver {
  stats: CombatStats;
  reset(): void;
  /** Fires a player hitscan ray; returns the impact (enemy or world) or null on a miss. */
  playerShot(origin: Vector3, dir: Vector3, options?: ShotOptions): ImpactInfo | null;
  /** Fires an enemy hitscan ray; returns true when it hit the player. */
  enemyShot(origin: Vector3, dir: Vector3, options?: ShotOptions): boolean;
  /** Applies radial blast damage (with line of sight) to enemies and the player. */
  explode(center: Vector3, radius?: number, damage?: number, source?: string): void;
}

const tmpTargetPos = new Vector3();
const tmpRayClosestPoint = new Vector3();

/** Creates the combat resolver for `game`. */
export function createCombatResolver(game: Game): CombatResolver {
  const stats: CombatStats = {
    shots: 0,
    hits: 0,
    kills: 0
  };
  game.events.on('enemy:killed', () => {
    stats.kills++;
  });
  return {
    stats,
    reset() {
      stats.shots = stats.hits = stats.kills = 0;
    },
    playerShot(origin, dir, { damage = 28, range = 300, impulse = 1 } = {}) {
      stats.shots++;
      const wallHit = game.physics.raycast(origin, dir, range);
      const enemyHit = game.enemies.raycast(origin, dir, wallHit ? wallHit.dist : range);
      if (enemyHit) {
        stats.hits++;
        const multiplier = enemyHit.part === 'weak' ? 2.2 : 1;
        const killed =
          enemyHit.enemy.damage(damage * multiplier, enemyHit.point, dir, enemyHit.part) === true;
        const impact: ImpactInfo = {
          point: enemyHit.point,
          normal: enemyHit.normal || dir.clone().negate(),
          dist: enemyHit.dist,
          surface: 'enemy',
          enemy: enemyHit.enemy,
          part: enemyHit.part,
          dir,
          from: 'player',
          killed
        };
        game.events.emit('impact', impact);
        game.events.emit('player:hitEnemy', {
          enemy: enemyHit.enemy,
          part: enemyHit.part,
          killed,
          weak: enemyHit.part === 'weak'
        });
        return impact;
      }
      if (wallHit) {
        const impact: ImpactInfo = {
          point: wallHit.point,
          normal: wallHit.normal,
          dist: wallHit.dist,
          surface: wallHit.surface,
          enemy: null,
          dir,
          from: 'player',
          box: wallHit.box
        };
        game.events.emit('impact', impact);
        return impact;
      }
      return null;
    },
    enemyShot(origin, dir, { damage = 6, range = 200 } = {}) {
      const wallHit = game.physics.raycast(origin, dir, range);
      const maxDist = wallHit ? wallHit.dist : range;
      const player = game.player;
      if (player && player.alive) {
        const target = tmpTargetPos.copy(player.pos);
        target.y += 1;
        const along = target.sub(origin).dot(dir);
        if (along > 0 && along < maxDist) {
          tmpRayClosestPoint.copy(origin).addScaledVector(dir, along);
          const dy = Math.abs(tmpRayClosestPoint.y - (player.pos.y + 0.95));
          if (
            Math.hypot(tmpRayClosestPoint.x - player.pos.x, tmpRayClosestPoint.z - player.pos.z) <
              0.38 &&
            dy < 0.95
          ) {
            player.damage(damage, origin);
            return true;
          }
        }
      }
      if (wallHit) {
        game.events.emit('impact', {
          point: wallHit.point,
          normal: wallHit.normal,
          dist: wallHit.dist,
          surface: wallHit.surface,
          enemy: null,
          dir,
          from: 'enemy',
          box: wallHit.box
        });
      }
      return false;
    },
    explode(center, radius = 5, damage = 80, source = 'player') {
      for (const enemy of game.enemies.list) {
        if (!enemy.alive) continue;
        const dist = enemy.pos.distanceTo(center);
        if (
          dist < radius &&
          game.physics.lineOfSight(center, tmpTargetPos.copy(enemy.pos).setY(enemy.pos.y + 0.5))
        ) {
          enemy.damage(
            damage * (1 - dist / radius),
            enemy.pos,
            tmpRayClosestPoint.copy(enemy.pos).sub(center).normalize(),
            'body'
          );
        }
      }
      const player = game.player;
      if (player && player.alive) {
        const dist = tmpTargetPos
          .copy(player.pos)
          .setY(player.pos.y + 1)
          .distanceTo(center);
        if (
          dist < radius &&
          game.physics.lineOfSight(center, tmpTargetPos.copy(player.pos).setY(player.pos.y + 1))
        ) {
          player.damage(damage * 0.5 * (1 - dist / radius), center);
        }
      }
      if (source === 'explosive') stats.blasts = (stats.blasts || 0) + 1;
    }
  };
}
