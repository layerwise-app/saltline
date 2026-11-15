import type { CameraShot, Game } from './core/types';

/** Debug and test hooks the game exposes on `window` (used by automated QA and the benchmark mode). */
declare global {
  interface Window {
    __G?: Game;
    __frames: number;
    __ready: boolean;
    __fatal: string | null;
    __errors: string[];
    __hands?: unknown;
    __setShot?: (shot: CameraShot) => void;
    __stats?: () => Record<string, unknown>;
    __step?: number;
  }
}

export {};
