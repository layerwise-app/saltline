/**
 * No-op stand-ins for optional subsystems. `main.ts` installs these when a
 * subsystem fails to boot (or is disabled) so the rest of the game keeps running.
 * Every stub carries `stub: true`.
 */
import { Color, MeshBasicMaterial, MeshStandardMaterial } from 'three';

/** Does nothing; used for every stubbed method. */
export const noop = (..._args: unknown[]): void => {};

/** Factories for the stub of each optional subsystem, keyed by its `game` property name. */
export const SUBSYSTEM_STUBS = {
  ground: () => ({
    stub: true as const,
    update: noop,
    wetnessAt: (..._args: unknown[]) => 0.5,
    isPuddle: (..._args: unknown[]) => false
  }),
  backdrop: () => ({
    stub: true as const,
    update: noop
  }),
  fx: () => ({
    stub: true as const,
    update: noop,
    muzzleFlash: noop,
    tracer: noop,
    impact: noop,
    sparks: noop,
    smoke: noop,
    explosion: noop,
    debris: noop,
    shell: noop,
    decal: noop,
    dust: noop,
    clear: noop,
    splash: noop,
    addEmitter: (..._args: unknown[]) => ({
      stop: noop,
      setPos: noop
    })
  }),
  audio: () => {
    const loopHandle = {
      setPos: noop,
      setGain: noop,
      setPitch: noop,
      stop: noop
    };
    return {
      stub: true as const,
      update: noop,
      resume: noop,
      play: noop,
      loop: (..._args: unknown[]) => loopHandle,
      setIntensity: noop,
      setInterior: noop,
      setVolume: noop,
      setPaused: noop
    };
  },
  weapon: () => ({
    stub: true as const,
    update: noop,
    reset: noop,
    setVisible: noop,
    ammo: 30,
    magSize: 30,
    reserve: 120,
    state: 'idle',
    name: 'KR-7',
    ads: 0,
    spread: 0.01
  }),
  enemies: () => ({
    stub: true as const,
    list: [] as unknown[],
    update: noop,
    spawn: (..._args: unknown[]) => null,
    raycast: (..._args: unknown[]) => null,
    aliveCount: () => 0,
    clear: noop,
    alert: noop
  }),
  hud: () => ({
    stub: true as const,
    update: noop,
    show: noop,
    setObjective: noop,
    message: noop,
    hitmarker: noop
  }),
  mats: () => {
    const cache = new Map<string, MeshStandardMaterial>();
    return {
      stub: true as const,
      get: (name: string): MeshStandardMaterial => {
        if (!cache.has(name))
          cache.set(
            name,
            new MeshStandardMaterial({
              color: 0x777777,
              roughness: 0.7
            })
          );
        return cache.get(name)!;
      },
      emissive: (color: number | string | Color = 0xffffff, intensity = 4) =>
        new MeshBasicMaterial({
          color: new Color(color).multiplyScalar(intensity)
        }),
      names: [] as string[],
      decal: (..._args: unknown[]) => ({
        material: new MeshBasicMaterial({
          transparent: true,
          opacity: 0
        }),
        aspect: 1
      }),
      label: (..._args: unknown[]) => ({
        material: new MeshBasicMaterial({
          transparent: true,
          opacity: 0
        }),
        aspect: 4
      }),
      uniforms: {
        wet: {
          value: 1
        }
      },
      update: noop
    };
  }
};

/** Name of a subsystem that has a stub. */
export type StubbedSubsystem = keyof typeof SUBSYSTEM_STUBS;
