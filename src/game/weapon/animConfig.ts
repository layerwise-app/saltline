/**
 * Weapon animation tuning data: holster/draw timing, per-weapon viewmodel
 * motion (ADS, idle, walk/run bob, inertia, sway, air, recoil springs, wall
 * push-back), reload timelines (seconds), and the arm rig dimensions.
 */
import { Euler, Quaternion, Vector3 } from 'three';
import { QuaternionClass } from './meshKit';

/** Holster / draw durations in seconds. */
export const HOLSTER_TIMING = {
  holster: 0.28,
  draw: 0.32
};

/** Per-weapon viewmodel motion parameters (`spr` entries are `[frequency, damping]` springs). */
export const VIEWMODEL_MOTION = {
  rifle: {
    pivot: [0, -0.035, 0.3],
    ads: {
      pos: 0.22,
      rot: 0.05,
      w: 23,
      z: 0.75,
      arc: {
        p: [0.004, 0.011, 0.01],
        r: [0.02, -0.03, -0.03]
      },
      out: 0.03
    },
    idle: {
      hz: 0.25,
      breathY: 5e-4,
      breathP: 9e-4,
      drift: 6e-4,
      driftR: 0.001,
      noise: 18e-5,
      noiseR: 4e-4
    },
    walk: {
      y: 0.0034,
      x: 0.0034,
      z: 0.0016,
      pitch: 0.007,
      yaw: 0.01,
      roll: 0.015,
      lag: 0.04
    },
    run: {
      y: 0.015,
      x: 0.011,
      z: 0.006,
      pitch: 0.028,
      yaw: 0.028,
      roll: 0.046,
      lag: 0.05
    },
    crouch: 0.72,
    inertia: {
      z: 0.0042,
      x: 0.0034,
      pitch: 0.0085,
      roll: 0.01,
      lean: 0.006,
      tau: 0.13,
      spr: [15, 0.48]
    },
    sway: {
      lag: 0.058,
      max: 0.07,
      roll: 0.55,
      shift: 0.02,
      spr: [13.5, 0.64],
      adsRot: 0.1,
      adsPos: 0.5
    },
    air: {
      jumpY: 0.26,
      jumpP: 0.95,
      fallY: 0.0019,
      fallP: 0.004,
      landY: 0.092,
      landP: 0.26,
      landR: 0.17,
      spr: [20.5, 0.56]
    },
    recoil: {
      back: 0.82,
      rise: 1.5,
      yaw: 0.95,
      roll: 1.7,
      up: 0.11,
      side: 0.09,
      first: 1.4,
      adsBack: 0.75,
      adsRot: 0.1,
      adsPos: 0.9,
      spr: {
        kZ: [44, 0.55],
        kP: [36, 0.5],
        kY: [30, 0.45],
        kR: [31, 0.42],
        kX: [40, 0.5],
        kU: [40, 0.5]
      }
    },
    sprint: {
      spr: [17, 1]
    },
    wall: {
      near: 0.42,
      far: 1.05,
      p: [-0.03, -0.035, 0.085],
      r: [0.34, 0.5, 0.16]
    },
    crouchDip: {
      y: 0.0075,
      pitch: 0.02,
      roll: 0.028,
      w: [16, 8]
    }
  },
  pistol: {
    pivot: [0, -0.085, 0.075],
    ads: {
      pos: 0.14,
      rot: 0.06,
      w: 29.5,
      z: 0.75,
      arc: {
        p: [0.003, 0.008, 0.012],
        r: [0.03, -0.02, -0.03]
      },
      out: 0.024
    },
    idle: {
      hz: 0.25,
      breathY: 6e-4,
      breathP: 0.0011,
      drift: 7e-4,
      driftR: 0.0014,
      noise: 25e-5,
      noiseR: 7e-4
    },
    walk: {
      y: 0.003,
      x: 0.0036,
      z: 0.0014,
      pitch: 0.009,
      yaw: 0.014,
      roll: 0.015,
      lag: 0.028
    },
    run: {
      y: 0.012,
      x: 0.009,
      z: 0.005,
      pitch: 0.034,
      yaw: 0.03,
      roll: 0.04,
      lag: 0.034
    },
    crouch: 0.72,
    inertia: {
      z: 0.0034,
      x: 0.0028,
      pitch: 0.011,
      roll: 0.012,
      lean: 0.0085,
      tau: 0.1,
      spr: [20, 0.5]
    },
    sway: {
      lag: 0.04,
      max: 0.085,
      roll: 0.45,
      shift: 0.012,
      spr: [19, 0.6],
      adsRot: 0.1,
      adsPos: 0.4
    },
    air: {
      jumpY: 0.22,
      jumpP: 1.2,
      fallY: 0.0017,
      fallP: 0.005,
      landY: 0.078,
      landP: 0.34,
      landR: 0.2,
      spr: [23, 0.54]
    },
    recoil: {
      back: 0.55,
      rise: 6.4,
      yaw: 1.3,
      roll: 2.3,
      up: 0.2,
      side: 0.1,
      first: 1,
      adsBack: 0.8,
      adsRot: 0.42,
      adsPos: 0.8,
      spr: {
        kZ: [56, 0.55],
        kP: [50, 0.5],
        kY: [38, 0.48],
        kR: [38, 0.45],
        kX: [46, 0.5],
        kU: [46, 0.5]
      }
    },
    sprint: {
      spr: [20, 1]
    },
    wall: {
      near: 0.32,
      far: 0.8,
      p: [-0.02, -0.02, 0.13],
      r: [0.42, 0.3, 0.1]
    },
    crouchDip: {
      y: 0.0065,
      pitch: 0.03,
      roll: 0.026,
      w: [18, 9]
    }
  }
};

/** Viewmodel motion parameters of one weapon. */
export type ViewmodelMotion = (typeof VIEWMODEL_MOTION)['rifle'];

/** Rifle reload keyframe times in seconds (plus a few small offsets). */
export const RIFLE_RELOAD_TIMELINE = {
  tac: 2.24,
  empty: 2.72,
  atMag: 0.36,
  magout: 0.4,
  clear: 0.52,
  away: 0.74,
  swap: 0.8,
  rise: 0.86,
  align: 1.1,
  insert: 1.15,
  short: 1.31,
  windup: 1.385,
  magin: 1.44,
  rebound: 1.5,
  regrip: 1.54,
  tugDown: 1.6,
  tugUp: 1.66,
  swapBack: 1.75,
  atHandle: 1.84,
  tacBack: 1.89,
  tacRelease: 1.905,
  tacBolt: 1.93,
  back: 1.96,
  release: 2.12,
  bolt: 2.155,
  shortBy: 0.009,
  backOff: 0.032,
  reboundBy: 0.008,
  tugBy: 0.005,
  partial: 0.32
};

/** Pistol reload keyframe times in seconds (plus a few small offsets). */
export const PISTOL_RELOAD_TIMELINE = {
  tac: 1.5,
  empty: 1.9,
  release: 0.12,
  magout: 0.18,
  swap: 0.48,
  rise: 0.52,
  align: 0.84,
  insert: 0.9,
  fingers: 1.02,
  windup: 1.075,
  magin: 1.13,
  rebound: 1.19,
  swapBack: 1.3,
  regrip: 1.44,
  thumb: 1.53,
  slideRelease: 1.575,
  slide: 1.61,
  backOff: 0.026,
  reboundBy: 0.01
};

// Unused scratch objects kept from the original bundle.
const tmpConfigEuler = new Euler();
const tmpConfigQuat = new QuaternionClass();

/** Vector class used by the hand rig. */
export const HandVec3 = Vector3;
/** Quaternion class used by the hand rig. */
export const HandQuat = Quaternion;
/** Arm segment lengths in metres. */
export const ARM = {
  upper: 0.3,
  fore: 0.27
};
/** Shoulder positions in camera space, metres. */
export const SHOULDER: { right: [number, number, number]; left: [number, number, number] } = {
  right: [0.19, -0.24, 0.1],
  left: [-0.19, -0.24, 0.1]
};
