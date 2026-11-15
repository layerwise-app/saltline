// Guard character asset: the skinned port-security operator (Mixamo "Swat Guy" with the Pro
// Rifle Pack clips, converted to a meshopt-compressed GLB in public/models/guard.glb). Loads it
// once, calibrates where the carbine sits in the right hand from the aiming clip, and builds
// per-guard instances (cloned skeleton + animation mixer sharing geometry and textures).
import {
  AnimationMixer,
  Group,
  LoopOnce,
  LoopRepeat,
  Matrix4,
  Object3D,
  Quaternion,
  Sphere,
  Vector3
} from 'three';
import type {
  AnimationAction,
  AnimationClip,
  Bone,
  Material,
  Mesh,
  MeshStandardMaterial,
  SkinnedMesh
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

/** Looping stance / locomotion clips blended every frame. */
export const GUARD_LOOP_CLIPS = ['idle', 'aim', 'walk', 'run', 'crouch', 'crouchAim'] as const;
export type GuardLoopClip = (typeof GUARD_LOOP_CLIPS)[number];
/** One-shot death clips. */
export type GuardDeathClip =
  | 'deathHeadFront'
  | 'deathFront'
  | 'deathHeadBack'
  | 'deathBack'
  | 'deathSide'
  | 'deathCrouch';

/** Distance covered by one cycle of the walk / run clips (metres), for foot-locked playback. */
export const GUARD_STRIDE = { walk: 1.92, run: 2.4 };

/** Albedo multiplier for the (dark) source textures. */
const ALBEDO_LIFT = 1.5;

/** The model is authored in centimetres. */
const MODEL_SCALE = 0.01;

/** Loaded, shared guard character data. */
export interface GuardAsset {
  scene: Group;
  clips: Record<string, AnimationClip>;
  /** Rifle mount relative to the right-hand bone (includes the cm->m scale). */
  gunMount: Matrix4;
  tris: number;
}

/** A per-guard instance of the character. */
export interface GuardModel {
  /** Unscaled container (positioned / rotated by the AI). */
  group: Group;
  mesh: SkinnedMesh;
  /** Bones by name without the "mixamorig" prefix (Hips, Spine2, Head, RightHand, ...). */
  bones: Record<string, Bone>;
  /** Child of the right hand in rifle space (metres): parent the carbine here. */
  gunMount: Object3D;
  mixer: AnimationMixer;
  loops: Record<GuardLoopClip, AnimationAction>;
  clips: Record<string, AnimationClip>;
}

/** Bump when public/models/guard.glb is rebuilt so browsers don't keep a stale copy. */
const ASSET_VERSION = 4;
const ASSET_URL = `${import.meta.env.BASE_URL || '/'}models/guard.glb?v=${ASSET_VERSION}`;

let pending: Promise<GuardAsset | null> | null = null;

/**
 * Starts (or joins) loading the guard asset. Resolves to null when it can't be loaded, in which
 * case the guards fall back to the procedural rig.
 */
export function preloadGuardAsset(): Promise<GuardAsset | null> {
  if (!pending) {
    pending = loadGuardAsset().catch((err: unknown) => {
      console.warn('[guard] character model unavailable, using the procedural rig:', err);
      return null;
    });
  }
  return pending;
}

async function loadGuardAsset(): Promise<GuardAsset> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(ASSET_URL);
  const scene = gltf.scene;
  const clips: Record<string, AnimationClip> = {};
  for (const clip of gltf.animations) clips[clip.name] = clip;
  for (const name of GUARD_LOOP_CLIPS) {
    if (!clips[name]) throw new Error('guard model is missing clip ' + name);
  }
  let tris = 0;
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const geometry = mesh.geometry;
    tris += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
    for (const material of ([] as Material[]).concat(mesh.material)) {
      const standard = material as MeshStandardMaterial;
      for (const texture of [standard.map, standard.normalMap]) {
        if (texture) texture.anisotropy = 4;
      }
      // The source albedo is very dark (black gear, grey camo): lift it so guards stay
      // readable against the overcast port instead of turning into silhouettes.
      if (standard.color) standard.color.setScalar(ALBEDO_LIFT);
    }
  });
  return { scene, clips, gunMount: calibrateGunMount(scene, clips.aim), tris };
}

/** Rifle-space point at the middle of the pistol grip (held in the right palm). */
const RIFLE_GRIP = new Vector3(0, -0.045, -0.035);
/** Height of the handguard's underside in rifle space (rests on the left palm). */
const RIFLE_HANDGUARD_Y = 0.004;
/** Palm-centre to grip-centre distance (the fingers wrap a ~3 cm grip). */
const GRIP_INSET = 0.02;
/** Palm-centre to handguard-underside distance (the palm cups the handguard). */
const HANDGUARD_INSET = 0.025;

/**
 * Palm centre and normal (pointing out of the palm) of one hand, from the hand and finger
 * base bones. Mixamo hands are mirrored, so the right hand's cross product is flipped.
 */
function palmOf(model: Object3D, side: 'Left' | 'Right'): { center: Vector3; normal: Vector3 } {
  const at = (bone: string) => {
    const object = model.getObjectByName('mixamorig' + side + bone);
    if (!object) throw new Error('guard model has no ' + side + bone + ' bone');
    return new Vector3().setFromMatrixPosition(object.matrixWorld);
  };
  const wrist = at('Hand');
  const knuckle = at('HandMiddle1');
  const fingers = knuckle.clone().sub(wrist);
  const across = at('HandIndex1').sub(at('HandPinky1'));
  const normal = fingers.clone().cross(across).normalize();
  if (side === 'Right') normal.negate();
  return { center: wrist.lerp(knuckle, 0.55), normal };
}

/**
 * Poses a scratch copy in the first frame of the aiming clip and solves the rifle transform
 * that seats the pistol grip in the right palm and rests the handguard on the left palm,
 * expressed in the right-hand bone's space (the hands keep the same spacing, within about
 * 2 cm, across all of the rifle clips).
 */
function calibrateGunMount(scene: Group, aim: AnimationClip): Matrix4 {
  const holder = new Group();
  const model = cloneSkinned(scene);
  model.scale.setScalar(MODEL_SCALE);
  holder.add(model);
  const mixer = new AnimationMixer(model);
  mixer.clipAction(aim).play();
  mixer.update(0);
  holder.updateMatrixWorld(true);
  const right = model.getObjectByName('mixamorigRightHand');
  if (!right) throw new Error('guard model has no hand bones');
  const palmR = palmOf(model, 'Right');
  const palmL = palmOf(model, 'Left');
  const gripWorld = palmR.center.addScaledVector(palmR.normal, GRIP_INSET);
  const guardWorld = palmL.center.addScaledVector(palmL.normal, HANDGUARD_INSET);
  // Rifle-space handguard contact: same spacing as the hands, on the handguard's underside.
  const span = gripWorld.distanceTo(guardWorld);
  const rise = RIFLE_HANDGUARD_Y - RIFLE_GRIP.y;
  const rifleGuard = new Vector3(
    0,
    RIFLE_HANDGUARD_Y,
    RIFLE_GRIP.z + Math.sqrt(Math.max(span * span - rise * rise, 0.01))
  );
  // World basis with +Z from grip to handguard contact (rifle kept upright), then tilt so the
  // rifle's own grip-to-handguard vector lands on that line.
  const zAxis = guardWorld.clone().sub(gripWorld).normalize();
  const xAxis = new Vector3(0, 1, 0).cross(zAxis).normalize();
  const yAxis = zAxis.clone().cross(xAxis);
  const basis = new Matrix4().makeBasis(xAxis, yAxis, zAxis);
  const gripDir = rifleGuard.clone().sub(RIFLE_GRIP);
  const tilt = Math.atan2(-gripDir.y, gripDir.z);
  const rotation = basis.multiply(new Matrix4().makeRotationX(-tilt));
  const origin = gripWorld.clone().sub(RIFLE_GRIP.clone().applyMatrix4(rotation));
  const gunWorld = rotation.clone().setPosition(origin);
  mixer.stopAllAction();
  return right.matrixWorld.clone().invert().multiply(gunWorld);
}

const tmpPos = new Vector3();
const tmpQuat = new Quaternion();
const tmpScale = new Vector3();

/** Builds one guard's character instance (shares geometry / materials with the asset). */
export function createGuardModel(asset: GuardAsset): GuardModel {
  const group = new Group();
  const model = cloneSkinned(asset.scene);
  model.scale.setScalar(MODEL_SCALE);
  group.add(model);
  let mesh: SkinnedMesh | null = null;
  const bones: Record<string, Bone> = {};
  model.traverse((object) => {
    if ((object as SkinnedMesh).isSkinnedMesh) mesh = object as SkinnedMesh;
    if ((object as Bone).isBone) bones[object.name.replace(/^mixamorig/, '')] = object as Bone;
  });
  if (!mesh) throw new Error('guard model has no skinned mesh');
  const skinned: SkinnedMesh = mesh;
  // Fixed generous bounds (model space, cm) so death clips that travel never get culled.
  skinned.boundingSphere = new Sphere(new Vector3(0, 80, 0), 190);
  const gunMount = new Object3D();
  asset.gunMount.decompose(tmpPos, tmpQuat, tmpScale);
  gunMount.position.copy(tmpPos);
  gunMount.quaternion.copy(tmpQuat);
  gunMount.scale.copy(tmpScale);
  bones.RightHand.add(gunMount);
  const mixer = new AnimationMixer(model);
  const loops = {} as Record<GuardLoopClip, AnimationAction>;
  for (const name of GUARD_LOOP_CLIPS) {
    const action = mixer.clipAction(asset.clips[name]);
    action.setLoop(LoopRepeat, Infinity);
    loops[name] = action;
  }
  return { group, mesh: skinned, bones, gunMount, mixer, loops, clips: asset.clips };
}

/** Restarts the looping clips (random phase) with the idle stance fully weighted. */
export function resetGuardModel(model: GuardModel, phase: number): void {
  model.mixer.stopAllAction();
  for (const name of GUARD_LOOP_CLIPS) {
    const action = model.loops[name];
    action.reset();
    action.setEffectiveTimeScale(name === 'walk' || name === 'run' ? 0 : 1);
    action.setEffectiveWeight(name === 'idle' ? 1 : 0);
    action.time = (phase % 1) * action.getClip().duration;
    action.play();
  }
}

/** Starts a one-shot death clip; returns the action so the caller can fade it in. */
export function playGuardDeath(model: GuardModel, name: GuardDeathClip): AnimationAction | null {
  const clip = model.clips[name];
  if (!clip) return null;
  const action = model.mixer.clipAction(clip);
  action.reset();
  action.setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.setEffectiveWeight(0);
  action.play();
  return action;
}
