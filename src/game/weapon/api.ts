/** Public hand-rig API (exposed as `hands` on the debug/global game object): skeleton, poses, colliders, arms and grips. */
export { ARM, SHOULDER } from './animConfig';
export {
  BONE,
  BONE_NAMES,
  DIGITS,
  DIGIT_NAMES,
  LIMITS,
  POSES,
  REST,
  box,
  capsule,
  clampPose,
  lerpPose,
  limitViolation,
  makePose,
  penetration,
  transformColliders
} from './hand/skeleton';
export {
  GLOVE_COLORS as COLORS,
  DEFAULT_POLE,
  TRIGGER_PULL,
  TWIST_SHARE,
  armWetUniform as WETNESS,
  WRIST_LIMITS,
  armGeometry,
  armMaterial,
  createArm,
  fitGrip,
  mirrorColliders,
  selfPenetration,
  handsShowcase as showcase
} from './arms';
export { GRIPS, fitReferencePoses, handSocket } from './hand/grips';
