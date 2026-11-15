/**
 * World-wide constants (bounds, sun, sky palette, player body, render layers)
 * and the graphics quality presets, plus auto-detection of a sensible preset.
 */
import { Color, Vector3 } from 'three';

/** Names of the built-in graphics quality presets. */
export type QualityName = 'test' | 'low' | 'medium' | 'high' | 'ultra';

/** A graphics quality preset. The active one lives on `game.quality` and may be tweaked at runtime. */
export interface QualityPreset {
  name: string;
  /** Internal render-resolution scale. */
  scale: number;
  /** MSAA sample count of the HDR target (0 = off). */
  msaa: number;
  /** Sun shadow map size. */
  shadow: number;
  /** Procedural texture size. */
  tex: number;
  /** Volumetric fog ray-march steps (0 = off). */
  volSteps: number;
  ao: boolean;
  /** Planar reflection resolution scale (0 = off). */
  planar: number;
  bloom: boolean;
  motionBlur: boolean;
  /** Rain particle density multiplier. */
  rain: number;
}

/** Playable world extents and key heights. */
export const WORLD_BOUNDS = {
  min: new Vector3(-40, 0, -30),
  max: new Vector3(40, 30, 30),
  groundY: 0,
  seaY: -1.6,
  quayX: 30
};

/**
 * The sun: direction (towards the sun), colour and intensity. High in the sky (about 58 degrees)
 * so enemies are lit from above rather than silhouetted against a low sun.
 */
export const SUN = {
  dir: new Vector3(0.42, 0.85, 0.32).normalize(),
  color: new Color(1, 0.86, 0.68),
  intensity: 9
};

/** Sky / fog palette shared by the sky dome, fog and post effects. */
export const SKY_COLORS = {
  zenith: new Color(0.055, 0.085, 0.13),
  horizon: new Color(0.95, 0.55, 0.28),
  horizonAway: new Color(0.16, 0.22, 0.3),
  fog: new Color(0.42, 0.47, 0.52)
};

/** Player body dimensions and camera field-of-view settings. */
export const PLAYER_BODY = {
  eye: 1.68,
  crouchEye: 1.05,
  radius: 0.32,
  height: 1.8,
  fov: 74,
  viewFov: 54
};

/** Render layer of the world. */
export const WORLD_LAYER = 0;
/** Render layer of the first-person viewmodel (weapon and arms). */
export const VIEWMODEL_LAYER = 1;

/** Built-in graphics quality presets, keyed by name. */
export const QUALITY_PRESETS: Record<QualityName, QualityPreset> = {
  test: {
    name: 'test',
    scale: 1,
    msaa: 0,
    shadow: 1024,
    tex: 256,
    volSteps: 10,
    ao: true,
    planar: 0.5,
    bloom: true,
    motionBlur: false,
    rain: 0.4
  },
  low: {
    name: 'low',
    scale: 0.7,
    msaa: 0,
    shadow: 2048,
    tex: 512,
    volSteps: 12,
    ao: false,
    planar: 0,
    bloom: true,
    motionBlur: false,
    rain: 0.5
  },
  medium: {
    name: 'medium',
    scale: 0.85,
    msaa: 2,
    shadow: 2048,
    tex: 1024,
    volSteps: 16,
    ao: true,
    planar: 0.5,
    bloom: true,
    motionBlur: false,
    rain: 0.8
  },
  high: {
    name: 'high',
    scale: 1,
    msaa: 4,
    shadow: 4096,
    tex: 1024,
    volSteps: 24,
    ao: true,
    planar: 0.5,
    bloom: true,
    motionBlur: true,
    rain: 1
  },
  ultra: {
    name: 'ultra',
    scale: 1,
    msaa: 4,
    shadow: 4096,
    tex: 2048,
    volSteps: 40,
    ao: true,
    planar: 1,
    bloom: true,
    motionBlur: true,
    rain: 1
  }
};

/**
 * Returns a fresh copy of the named preset, or (for an unknown/empty name) picks one
 * from the device: `low` on mobile, `medium` on software / mobile / Intel iGPUs, else `high`.
 */
export function resolveQuality(name?: string): QualityPreset {
  const named = name
    ? (QUALITY_PRESETS as Record<string, QualityPreset | undefined>)[name]
    : undefined;
  if (name && named)
    return {
      ...named
    };
  if (
    /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 900)
  )
    return {
      ...QUALITY_PRESETS.low
    };
  let gpuName = '';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      gpuName = String(
        debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER)
      );
      const loseContext = gl.getExtension('WEBGL_lose_context');
      if (loseContext) loseContext.loseContext();
    }
  } catch {}
  return {
    ...(/SwiftShader|llvmpipe|Software|Mali|Adreno|PowerVR/i.test(gpuName) ||
    (/Intel/i.test(gpuName) && !/Arc/i.test(gpuName))
      ? QUALITY_PRESETS.medium
      : QUALITY_PRESETS.high)
  };
}
