/**
 * PAC-9 rifle first-person viewmodel: builds the meshes, measures hand
 * colliders from the generated geometry, fits the hand grips (pistol grip,
 * trigger, foregrip, magazine pinch / carry / cup, charging handle) and
 * animates the bolt, magazine and support hand through the reload timeline.
 */
import { Group, Matrix4, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Mesh, MeshStandardMaterial } from 'three';
import { lerp } from '../core/math';
import { createMarkingDecalMesh, createMuzzleFlashMesh, createReflexSightGlass } from './markings';
import {
  RIFLE_SPEC,
  buildRifleGeometries,
  easeOutQuad,
  linearStep,
  quatFromEuler,
  sampleKeyframePose,
  smootherstep01,
  triangleCount
} from './meshKit';
import { RIFLE_RELOAD_TIMELINE, VIEWMODEL_MOTION } from './animConfig';
import {
  POSES,
  POSE_LENGTH,
  box,
  capsule,
  computeHandFk,
  createHandFk,
  lerpPose,
  makePose
} from './hand/skeleton';
import { GRIPS, buildPistolGripShape } from './hand/grips';
import {
  fitGripPose,
  fitGripProfile,
  handPoseFromSocket,
  meshBoundsInBox,
  originFromLocalOffset,
  quatFromForwardUp,
  reachFingerTo,
  sliceMeshProfile
} from './gripSolver';
import type { GripFit } from './gripSolver';
import type {
  ActiveReload,
  RecoilReceiver,
  ViewOffset,
  ViewmodelContext,
  WeaponViewSet,
  WeaponViewmodel
} from './index';

/** Geometries produced by `buildRifleGeometries` (ano, gun, poly, plain, bolt, mag, round). */
type RifleGeometries = ReturnType<typeof buildRifleGeometries>;
type BoxCollider = ReturnType<typeof box>;
type CapsuleCollider = ReturnType<typeof capsule>;
type Collider = BoxCollider | CapsuleCollider;
type MeshSlice = ReturnType<typeof sliceMeshProfile>[number];

/** A hand (or magazine) placement: position + orientation. */
interface Placement {
  p: Vector3;
  q: Quaternion;
}

/** Keyframes `[time, placement]` sampled by `sampleKeyframePose`. */
type PlacementKeys = [number, Placement][];

/** Magazine centre-line sample at a given depth below the magwell. */
interface MagAxisSample {
  z: number;
  tilt: number;
  hw: number;
  hd: number;
}

/** Hand colliders and landmarks measured from the rifle geometry. */
interface RifleColliders {
  gripDim: { rake: number; hw: number; hl: number; hd: number; c: number[] };
  tang: Vector3;
  triggerAt: number[];
  grip: Collider[];
  trigger: Collider[];
  foreTop: Vector3;
  foreDim: { hw: number; hd: number; len: number };
  fore: Collider[];
  magAxis: (depth: number) => MagAxisSample;
  magTilt: number;
  magLen: number;
  plate: Vector3;
  mag: Collider[];
  knob: CapsuleCollider;
  knobTip: number;
  handle: Collider[];
}

/** All fitted rifle hand grips, plus the colliders they were fitted against. */
interface RifleGrips {
  shapes: RifleColliders;
  grip: GripFit;
  trigger: GripFit;
  fore: GripFit;
  pinch: GripFit;
  carry: GripFit;
  cup: GripFit;
  handle: GripFit;
}

const RifleVec3 = Vector3;
const RifleQuat = Quaternion;
/** How far the magazine drops when it leaves / enters the magwell. */
const RIFLE_MAG_INSERT_DROP = 0.076;
/** Bolt lock-back fraction on an empty magazine (0: the rifle has no hold-open). */
const RIFLE_BOLT_LOCKBACK = 0;

const rifleOffsetFromHip = (pose: ViewOffset, hip: ViewOffset): ViewOffset => ({
  p: pose.p.map((value, i) => value - hip.p[i]),
  r: pose.r.map((value, i) => value - hip.r[i])
});

const makeRifleView = (
  name: string,
  hip: ViewOffset,
  adsZ: number,
  sprint: ViewOffset,
  sprintArc: ViewOffset,
  reload: ViewOffset,
  rack: ViewOffset
): WeaponViewSet => ({
  name,
  HIP: hip,
  ADS: {
    p: [0, -RIFLE_SPEC.sightY, adsZ],
    r: [0, 0, 0]
  },
  SPRINT: rifleOffsetFromHip(sprint, hip),
  SPRINT_ARC: sprintArc,
  RELOAD: rifleOffsetFromHip(reload, hip),
  RACK: rack
});

const RIFLE_RACK_POSE: ViewOffset = {
  p: [0, 0, 0],
  r: [-0.16, 0, 0.62]
};
const RIFLE_RELOAD_ROT = [0.494, 0.305, -0.83];
const RIFLE_VIEWS: WeaponViewSet[] = [
  makeRifleView(
    'close',
    {
      p: [0.1, -0.109, -0.219],
      r: [-0.045, 0.035, 0.09]
    },
    -0.1065,
    {
      p: [0.07, -0.205, -0.27],
      r: [0.25, 0.8, 0.32]
    },
    {
      p: [-0.01, -0.022, 0.02],
      r: [-0.06, 0.02, 0.07]
    },
    {
      p: [0.088, -0.022, -0.295],
      r: RIFLE_RELOAD_ROT
    },
    RIFLE_RACK_POSE
  ),
  makeRifleView(
    'threequarter',
    {
      p: [0.143, -0.173, -0.397],
      r: [0.065, 0.14, 0.04]
    },
    -0.1115,
    {
      p: [0.07, -0.16, -0.3],
      r: [-0.2, 0.85, 0.35]
    },
    {
      p: [-0.008, -0.02, 0.03],
      r: [0.05, 0.02, 0.06]
    },
    {
      p: [0.09, -0.035, -0.34],
      r: RIFLE_RELOAD_ROT
    },
    RIFLE_RACK_POSE
  ),
  makeRifleView(
    'compact',
    {
      p: [0.165, -0.172, -0.345],
      r: [0.045, 0.075, 0.03]
    },
    -0.1115,
    {
      p: [0.13, -0.185, -0.3],
      r: [-0.28, 0.55, 0.15]
    },
    {
      p: [-0.006, -0.016, 0.02],
      r: [0.04, 0.02, 0.05]
    },
    {
      p: [0.1, -0.04, -0.31],
      r: RIFLE_RELOAD_ROT
    },
    RIFLE_RACK_POSE
  )
];

/** Smooth 0..1 ramp while `t` is inside [start, end), 0 outside. */
const rifleRampInWindow = (t: number, start: number, end: number): number =>
  t < start || t >= end ? 0 : smootherstep01((t - start) / (end - start));
const rifleQuatX = (angle: number): Quaternion =>
  new RifleQuat().setFromAxisAngle(new RifleVec3(1, 0, 0), angle);
const rifleQuatY = (angle: number): Quaternion =>
  new RifleQuat().setFromAxisAngle(new RifleVec3(0, 1, 0), angle);

const RIFLE_GRIP_THUMB_FROM = [1, 0, 0, 1];
const RIFLE_GRIP_THUMB_TO = [1.6, 1.1, 0.8, 1];
const RIFLE_MAG_CARRY_POSE = makePose({
  thumb: [1.35, 0.7, 0.6, 0.3],
  fingers: [1.6, 1.1, 0.7, 0]
});
/** Height of the grip tang (web of the hand) above the trigger guard bottom. */
const RIFLE_TANG_OFFSET = 0.0275;
/** Hand placement tuning; also the cache key of the fitted grips. */
const rifleGripTuning = {
  grip: {
    web: [-0.0335, -0.012, -0.045],
    tilt: 0.22,
    roll: -0.3,
    drop: 0.012,
    lift: 0.0025
  },
  foreYaw: -0.8,
  foreTip: 0.08,
  foreDrop: 0.008,
  pinchAt: 0.15,
  pinchYaw: 0,
  cupYaw: 0,
  handle: {
    fingers: [0.85, 0.4, -0.34],
    back: [-0.36, 0.1, -1]
  },
  shR: [0.2, -0.18, 0.4],
  shL: [-0.17, -0.24, 0.05],
  poleR: [0.3, -0.95, 0],
  poleL: [-0.5, -0.85, 0],
  sprintShR: [0.19, -0.24, 0.1],
  sprintPoleR: [0.9, -0.4, 0]
};

/** Measures grip, trigger, foregrip, magazine and charging-handle colliders from the meshes. */
function measureRifleColliders(geometries: RifleGeometries): RifleColliders {
  const gripPos = RIFLE_SPEC.grip;
  const handguardPos = RIFLE_SPEC.handguard;
  const handguardRadius = RIFLE_SPEC.handguardR;
  const magPos = RIFLE_SPEC.magPos;
  const handlePos = RIFLE_SPEC.handlePos;

  // Pistol grip.
  const gripBounds = meshBoundsInBox(
    geometries.poly,
    [-0.02, gripPos[1] - 0.065, gripPos[2] - 0.045],
    [0.02, gripPos[1] + 0.058, gripPos[2] + 0.05]
  );
  const gripProfile = fitGripProfile(
    sliceMeshProfile(
      geometries.poly,
      [-0.02, gripPos[1] - 0.06, gripPos[2] - 0.045],
      [0.02, gripPos[1] + 0.03, gripPos[2] + 0.05]
    )
  );
  const rake = gripProfile.rake;
  const gripTop = gripBounds.max[1];
  const gripBottom = gripProfile.bottom - 0.005;
  const gripMidY = (gripTop + gripBottom) / 2;
  const gripHalfLen = (gripTop - gripBottom) / 2 / Math.cos(rake);
  const gripHalfDepth = (gripProfile.depth(gripMidY) / 2) * Math.cos(rake);
  const gripDim = {
    rake,
    hw: gripProfile.hw,
    hl: gripHalfLen,
    hd: gripHalfDepth + 0.0008,
    c: [0, gripMidY, gripProfile.centre(gripMidY) - 0.0008]
  };
  const gripBox = box(
    gripDim.c,
    [gripProfile.hw, gripHalfLen, gripDim.hd],
    rifleQuatX(-rake),
    gripProfile.hw * 0.9
  );

  // Receiver, magwell and buffer tube.
  const receiverBounds = meshBoundsInBox(
    geometries.ano,
    [-0.03, gripPos[1] + 0.045, gripPos[2] - 0.17],
    [0.03, gripPos[1] + 0.125, gripPos[2] + 0.028]
  );
  const receiverHalfWidth = -meshBoundsInBox(
    geometries.ano,
    [-0.03, -0.018, gripPos[2] - 0.12],
    [0, -0.008, gripPos[2] - 0.02]
  ).min[0];
  const receiverBox = box(
    [
      0,
      (receiverBounds.min[1] + receiverBounds.max[1]) / 2,
      (receiverBounds.min[2] + receiverBounds.max[2]) / 2
    ],
    [
      receiverHalfWidth,
      (receiverBounds.max[1] - receiverBounds.min[1]) / 2,
      (receiverBounds.max[2] - receiverBounds.min[2]) / 2
    ],
    null,
    0.003
  );
  const magwellBox = box(
    [0, magPos[1] - 0.0345, magPos[2]],
    [receiverHalfWidth + 0.001, 0.0345, 0.0355],
    null,
    0.003
  );
  const bufferBox = box([0, 0.002, receiverBounds.max[2] + 0.09], [0.014, 0.016, 0.09], null, 0.01);

  // Trigger guard and trigger blade.
  const guardBounds = meshBoundsInBox(
    geometries.ano,
    [-0.009, gripPos[1] - 0.004, gripPos[2] - 0.115],
    [0.009, gripPos[1] + 0.006, gripPos[2] - 0.03]
  );
  const tang = new RifleVec3(
    0,
    guardBounds.min[1] + RIFLE_TANG_OFFSET,
    gripProfile.back(guardBounds.min[1] + RIFLE_TANG_OFFSET)
  );
  const guardBox = box(
    [
      0,
      (guardBounds.min[1] + guardBounds.max[1]) / 2,
      (guardBounds.min[2] + guardBounds.max[2]) / 2
    ],
    [
      (guardBounds.max[0] - guardBounds.min[0]) / 2,
      (guardBounds.max[1] - guardBounds.min[1]) / 2,
      (guardBounds.max[2] - guardBounds.min[2]) / 2
    ],
    null,
    0.0018
  );
  const triggerSlices = sliceMeshProfile(
    geometries.gun,
    [-0.0034, gripPos[1] + 0.012, gripPos[2] - 0.092],
    [0.0034, gripPos[1] + 0.043, gripPos[2] - 0.058],
    0.006
  );
  const triggerSlice = triggerSlices[Math.floor(triggerSlices.length / 2)];
  const triggerAt = [0, triggerSlice.y, triggerSlice.z0];
  const triggerCapsule = capsule(
    [-0.0031, triggerSlice.y + 0.006, triggerSlice.z0 + 0.0028],
    [0.0031, triggerSlice.y - 0.01, triggerSlice.z0 + 0.0028 - 0.003],
    0.003
  );
  const grip = [gripBox, receiverBox, magwellBox, bufferBox, guardBox];
  const trigger = [triggerCapsule];

  // Handguard (support hand).
  const foreSlices = sliceMeshProfile(
    geometries.poly,
    [-0.03, -handguardRadius - 0.085, handguardPos[2] - 0.03],
    [0.03, -handguardRadius + 0.002, handguardPos[2] + 0.03]
  );
  const foreBody = foreSlices.slice(1);
  const foreZ0 = Math.min(...foreBody.map((slice) => slice.z0));
  const foreZ1 = Math.max(...foreBody.map((slice) => slice.z1));
  const foreHalfWidth = Math.max(...foreBody.map((slice) => slice.x1));
  const foreBounds = meshBoundsInBox(
    geometries.poly,
    [-0.03, -handguardRadius - 0.085, handguardPos[2] - 0.03],
    [0.03, -handguardRadius + 0.002, handguardPos[2] + 0.03]
  );
  const foreTop = new RifleVec3(0, foreBounds.max[1], (foreZ0 + foreZ1) / 2);
  const foreDim = {
    hw: foreHalfWidth,
    hd: (foreZ1 - foreZ0) / 2,
    len: foreBounds.max[1] - foreBounds.min[1]
  };
  const fore = [
    box(
      [0, (foreBounds.max[1] + foreBounds.min[1]) / 2, (foreZ0 + foreZ1) / 2],
      [foreHalfWidth, (foreBounds.max[1] - foreBounds.min[1]) / 2, (foreZ1 - foreZ0) / 2],
      null,
      0.01
    ),
    box(
      [handguardPos[0], handguardPos[1], handguardPos[2]],
      [handguardRadius, handguardRadius, 0.146],
      null,
      0.008
    )
  ];

  // Magazine: one tilted box per 2 cm slice.
  const magSlices = sliceMeshProfile(geometries.mag, [-1, -1, -1], [1, 0, 1], 0.02);
  const sliceCentreZ = (slice: MeshSlice): number => (slice.z0 + slice.z1) / 2;
  const magBoxes: Collider[] = [];
  for (let i = 0; i < magSlices.length - 1; i++) {
    const slice = magSlices[i];
    const next = magSlices[Math.min(magSlices.length - 2, i + 1)];
    const prev = magSlices[Math.max(0, i - 1)];
    const tilt = Math.atan2(sliceCentreZ(prev) - sliceCentreZ(next), prev.y - next.y || 1);
    magBoxes.push(
      box(
        [0, slice.y, sliceCentreZ(slice)],
        [Math.max(-slice.x0, slice.x1), 0.0125, ((slice.z1 - slice.z0) / 2) * Math.cos(tilt)],
        rifleQuatX(tilt),
        0.003
      )
    );
  }
  const magBounds = meshBoundsInBox(geometries.mag, [-1, -1, -1], [1, 1, 1]);
  const magBaseBounds = meshBoundsInBox(
    geometries.mag,
    [-1, magBounds.min[1], -1],
    [1, magBounds.min[1] + 0.012, 1]
  );
  const secondLastSlice = magSlices[magSlices.length - 2];
  const thirdLastSlice = magSlices[magSlices.length - 3];
  const magTilt =
    Math.atan2(
      sliceCentreZ(thirdLastSlice) - sliceCentreZ(secondLastSlice),
      thirdLastSlice.y - secondLastSlice.y
    ) * 1.25;
  const magAxis = (depth: number): MagAxisSample => {
    let index = 0;
    while (index < magSlices.length - 2 && -magSlices[index + 1].y < depth) index++;
    const upper = magSlices[index];
    const lower = magSlices[index + 1];
    const f = Math.min(1, Math.max(0, (-depth - upper.y) / (lower.y - upper.y)));
    return {
      z: sliceCentreZ(upper) + (sliceCentreZ(lower) - sliceCentreZ(upper)) * f,
      tilt: Math.atan2(sliceCentreZ(upper) - sliceCentreZ(lower), upper.y - lower.y),
      hw: Math.max(-upper.x0, upper.x1),
      hd: (upper.z1 - upper.z0) / 2
    };
  };
  const magLen = -magBounds.min[1];
  const lastSlice = magSlices[magSlices.length - 1];
  const plateZ =
    sliceCentreZ(secondLastSlice) +
    (sliceCentreZ(secondLastSlice) - sliceCentreZ(thirdLastSlice)) * 0.9;
  const plate = new RifleVec3(0, (magBaseBounds.min[1] + lastSlice.y + 0.01) / 2 - 0.004, plateZ);
  magBoxes.push(
    box(
      [0, plate.y + 0.0045 * Math.cos(magTilt), plate.z + 0.0045 * Math.sin(magTilt)],
      [magBounds.max[0], 0.0045, 0.034],
      rifleQuatX(magTilt),
      0.003
    )
  );

  // Charging handle knob.
  const boltBounds = meshBoundsInBox(
    geometries.bolt,
    [-1, -1, -1],
    [-receiverHalfWidth - 0.0015, 1, 1]
  );
  const knob = capsule(
    [boltBounds.min[0] + 0.003, handlePos[1], handlePos[2]],
    [boltBounds.max[0], handlePos[1], handlePos[2]],
    (boltBounds.max[1] - boltBounds.min[1]) / 2
  );
  return {
    gripDim,
    tang,
    triggerAt,
    grip,
    trigger,
    foreTop,
    foreDim,
    fore,
    magAxis,
    magTilt,
    magLen,
    plate,
    mag: magBoxes,
    knob,
    knobTip: boltBounds.min[0],
    handle: [
      knob,
      receiverBox,
      box([0, RIFLE_SPEC.railTop - 0.004, handlePos[2]], [0.011, 0.006, 0.1], null, 0.002)
    ]
  };
}

let rifleGripCache: RifleGrips | null = null;
let rifleGripCacheKey = '';

/** Fits every rifle hand grip against the measured colliders (cached per tuning). */
function buildRifleGrips(geometries: RifleGeometries): RifleGrips {
  const cacheKey = JSON.stringify(rifleGripTuning);
  if (rifleGripCache && cacheKey === rifleGripCacheKey) return rifleGripCache;
  const shapes = measureRifleColliders(geometries);
  const tuning = rifleGripTuning;
  // The cache entry is published before fitting (as in the original); the grips are filled in below.
  const grips = { shapes } as RifleGrips;
  const identity = new RifleQuat();
  rifleGripCache = grips;
  rifleGripCacheKey = cacheKey;

  // Right hand: pistol grip and trigger finger.
  const gripShape = buildPistolGripShape({
    ...tuning.grip,
    rake: shapes.gripDim.rake,
    len:
      (shapes.tang.y - (shapes.gripDim.c[1] - shapes.gripDim.hl * Math.cos(shapes.gripDim.rake))) /
      Math.cos(shapes.gripDim.rake),
    width: 2 * shapes.gripDim.hw,
    depth: 2 * shapes.gripDim.hd,
    round: 0.009,
    top: [0.012, 0.2, 0.005, 0.04],
    topW: 0.034,
    guard: [0.036, 0.1, -0.024],
    trigger: [0.084, -0.01]
  });
  const gripSocket = handPoseFromSocket('right', gripShape.frame, shapes.tang, identity);
  gripSocket.p.add(new RifleVec3(0, tuning.grip.lift, 0).applyQuaternion(gripSocket.q));
  const grip = fitGripPose('grip', 'right', gripSocket.p, gripSocket.q, shapes.grip, {
    from: makePose({ thumb: RIFLE_GRIP_THUMB_FROM }, GRIPS.rifle_grip.fit.from),
    to: makePose({ thumb: RIFLE_GRIP_THUMB_TO }, GRIPS.rifle_grip.fit.to)
  });
  const trigger = reachFingerTo(
    grip,
    'trigger',
    1,
    [shapes.triggerAt[0] + 0.002, shapes.triggerAt[1], shapes.triggerAt[2] - 0.0015],
    grip.pose,
    {
      start: [0.2, 1, 0.6, 0.1],
      at: 0.7
    }
  );

  // Left hand: handguard.
  const foreSocket = handPoseFromSocket(
    'left',
    'foregrip',
    shapes.foreTop.clone().add(new RifleVec3(0, -tuning.foreDrop, 0)),
    rifleQuatY(tuning.foreYaw).multiply(rifleQuatX(tuning.foreTip))
  );
  const fore = fitGripPose(
    'fore',
    'left',
    foreSocket.p,
    foreSocket.q,
    shapes.fore,
    GRIPS.foregrip.fit
  );

  // Left hand: magazine pinch (pulling it out) and cup / carry (inserting it).
  const pinchAxis = shapes.magAxis(tuning.pinchAt);
  const pinchSocket = handPoseFromSocket(
    'left',
    'mag_pinch',
    new RifleVec3(0, -tuning.pinchAt, pinchAxis.z),
    rifleQuatX(pinchAxis.tilt).multiply(rifleQuatY(tuning.pinchYaw))
  );
  const pinch = fitGripPose(
    'pinch',
    'left',
    pinchSocket.p,
    pinchSocket.q,
    shapes.mag,
    GRIPS.mag_pinch.fit
  );
  const cupSocket = handPoseFromSocket(
    'left',
    'mag_cup',
    shapes.plate,
    rifleQuatX(shapes.magTilt).multiply(rifleQuatY(tuning.cupYaw))
  );
  cupSocket.p.add(new RifleVec3(0, 0.003, 0).applyQuaternion(cupSocket.q));
  const carry = fitGripPose('carry', 'left', cupSocket.p, cupSocket.q, shapes.mag, {
    from: GRIPS.mag_cup.fit.from,
    to: RIFLE_MAG_CARRY_POSE
  });
  const cup: GripFit = {
    ...carry,
    name: 'cup',
    pose: lerpPose(new Float32Array(POSE_LENGTH), GRIPS.mag_cup.fit.from, carry.pose, 0.72)
  };

  // Left hand: charging handle, pinched between index and middle finger pads.
  const handleQuat = quatFromForwardUp(tuning.handle.fingers, tuning.handle.back);
  const handlePose = makePose({
    thumb: [0.9, 0.2, 0.3, 0.6],
    index: [0.45, 0.55, 0.33, 0],
    middle: [0.45, 0.55, 0.33, 0],
    ring: [1.2, 1.45, 0.9, 0],
    little: [1.25, 1.45, 0.85, -0.04]
  });
  const handleFk = computeHandFk(handlePose, createHandFk());
  const padMidpoint = handleFk.j[6]
    .clone()
    .lerp(handleFk.j[7], 0.5)
    .lerp(handleFk.j[10].clone().lerp(handleFk.j[11], 0.5), 0.5);
  padMidpoint.y -= 0.009;
  const handleX = shapes.knobTip + 0.0035;
  const handleZ = shapes.knob.a[2] - shapes.knob.r - 0.0005;
  const handleOrigin = originFromLocalOffset(
    'left',
    handleQuat,
    [handleX, shapes.knob.a[1], handleZ],
    padMidpoint.toArray()
  );
  const handleBase = {
    name: 'handle',
    side: 'left' as const,
    p: handleOrigin,
    q: handleQuat,
    pose: handlePose,
    shapes: fitGripPose('handle', 'left', handleOrigin, handleQuat, shapes.handle, {
      from: handlePose,
      to: handlePose
    }).shapes
  };
  const handle = reachFingerTo(
    reachFingerTo(handleBase, 'handle', 1, [handleX, shapes.knob.a[1] + 0.0075, handleZ], null, {
      at: 0.8
    }),
    'handle',
    2,
    [handleX, shapes.knob.a[1] - 0.0075, handleZ],
    null,
    {
      at: 0.8
    }
  );

  Object.assign(grips, { grip, trigger, fore, pinch, carry, cup, handle });
  return grips;
}

/** Builds the PAC-9 rifle viewmodel (meshes, fitted grips, reload animation). */
export function createRifleViewmodel(context: ViewmodelContext): WeaponViewmodel {
  const { mats, mk: makeMesh, S: state, rng } = context;
  const root = new Group();
  root.name = 'viewmodel-pac9';
  const geometries = buildRifleGeometries();
  root.add(
    makeMesh(geometries.ano, mats.ano),
    makeMesh(geometries.gun, mats.steel),
    makeMesh(geometries.poly, mats.poly),
    makeMesh(geometries.plain, mats.plain)
  );
  const boltMesh = makeMesh(geometries.bolt, mats.steel);
  root.add(boltMesh);
  const magGroup = new Group();
  const magHome = new RifleVec3().fromArray(RIFLE_SPEC.magPos);
  magGroup.position.copy(magHome);
  const roundMesh = makeMesh(geometries.round, mats.brass);
  magGroup.add(makeMesh(geometries.mag, mats.tan), roundMesh);
  root.add(magGroup);

  let markings: Mesh<BufferGeometry, MeshStandardMaterial> | null = null;
  try {
    markings = createMarkingDecalMesh([
      ['model', -0.0168, -0.0315, 0.064, 0.0095, 'L'],
      ['maker', -0.0168, -0.042, 0.064, 0.003, 'L'],
      ['cal', -0.0168, -0.0465, 0.064, 0.0028, 'L'],
      ['prop', -0.0168, -0.071, 0.066, 0.0026, 'L'],
      ['auto', -0.0168, -0.027, -0.0335, 0.0036, 'L'],
      ['semi', -0.0168, -0.0262, -0.049, 0.0036, 'L'],
      ['safe', -0.0168, -0.0362, -0.062, 0.0036, 'L'],
      ['rack', -0.0168, -0.004, -0.205, 0.02, 'L'],
      ['warn', -0.0181, -0.01, 0.03, 0.0062, 'L'],
      ['optic', -0.0195, 0.0735, 0.021, 0.0024, 'L'],
      ['model', 0.0168, -0.0315, 0.068, 0.0095, 'R'],
      ['warn', 0.0168, -0.066, 0.066, 0.0075, 'R'],
      ['rack', 0.0168, -0.004, -0.205, 0.02, 'R'],
      ['auto', 0.0168, -0.027, -0.0335, 0.0036, 'R'],
      ['safe', 0.0168, -0.0362, -0.062, 0.0036, 'R'],
      ['optic', 0.0195, 0.0735, 0.021, 0.0024, 'R'],
      ['cal', 0.0181, 0.0245, -0.055, 0.0026, 'R'],
      ['r2', 0, 0.04365, -0.0816, 0.003, 'T'],
      ['r4', 0, 0.04365, -0.0616, 0.003, 'T'],
      ['r6', 0, 0.04365, 0.0584, 0.003, 'T'],
      ['r8', 0, 0.04365, 0.0784, 0.003, 'T'],
      ['r10', 0, 0.04365, 0.0984, 0.003, 'T'],
      ['r12', 0, 0.04365, 0.1184, 0.003, 'T']
    ]);
    markings.castShadow = false;
    markings.receiveShadow = true;
    markings.frustumCulled = false;
    root.add(markings);
  } catch (error) {
    console.warn('[weapon] markings skipped: ' + error);
  }
  const sightGlass = createReflexSightGlass(
    RIFLE_SPEC.window.map((point) => [
      point[0] * 1.01,
      (point[1] - RIFLE_SPEC.sightY) * 1.01 + RIFLE_SPEC.sightY
    ]),
    RIFLE_SPEC.lensF + 0.0025
  );
  sightGlass.frustumCulled = false;
  root.add(sightGlass);
  const flash = createMuzzleFlashMesh();
  flash.position.fromArray(RIFLE_SPEC.muzzle);
  flash.visible = false;
  root.add(flash);

  const grips = buildRifleGrips(geometries);
  const arms = context.arms || null;
  const tmpMatrix = new Matrix4();
  const unitScale = new RifleVec3(1, 1, 1);
  const identity = new RifleQuat();
  /** Places `hold` (defined in magazine space) into a frame at `origin` rotated by `rotation`. */
  const placeHold = (
    hold: Placement,
    origin: Vector3,
    rotation: Quaternion,
    outPos: Vector3,
    outQuat: Quaternion
  ): void => {
    outQuat.copy(rotation).multiply(hold.q);
    outPos.copy(hold.p).applyQuaternion(rotation).add(origin);
  };

  // Support-hand placements along the reload.
  const foreHold: Placement = {
    p: grips.fore.p,
    q: grips.fore.q
  };
  const pinchHold: Placement = {
    p: new RifleVec3(),
    q: new RifleQuat()
  };
  placeHold(grips.pinch, magHome, identity, pinchHold.p, pinchHold.q);
  const pinchReach: Placement = {
    p: pinchHold.p.clone().add(new RifleVec3(-0.045, -0.035, 0.015)),
    q: pinchHold.q.clone()
  };
  const pinchDropped: Placement = {
    p: pinchHold.p.clone().add(new RifleVec3(0, -(RIFLE_MAG_INSERT_DROP + 0.006), 0)),
    q: pinchHold.q.clone()
  };
  const awayTilt = quatFromEuler(-0.5, 0, 0.25);
  const pinchAway: Placement = {
    p: pinchHold.p.clone().add(new RifleVec3(-0.06, -0.36, 0.13)),
    q: awayTilt.clone().multiply(pinchHold.q)
  };
  // Magazine offsets (relative to its seated position) while inserting.
  const magRaised: Placement = {
    p: new RifleVec3(-0.05, -0.38, 0.14),
    q: awayTilt.clone()
  };
  const magAligned: Placement = {
    p: new RifleVec3(-0.005, -(RIFLE_MAG_INSERT_DROP + 0.014), 0.006),
    q: quatFromEuler(-0.11, 0, 0.07)
  };
  const magAtWell: Placement = {
    p: new RifleVec3(0, -RIFLE_MAG_INSERT_DROP, 0),
    q: new RifleQuat()
  };
  const magInsertKeys: PlacementKeys = [
    [RIFLE_RELOAD_TIMELINE.rise, magRaised],
    [RIFLE_RELOAD_TIMELINE.align, magAligned],
    [RIFLE_RELOAD_TIMELINE.insert, magAtWell],
    [9, magAtWell]
  ];
  const carryRaised: Placement = {
    p: new RifleVec3(),
    q: new RifleQuat()
  };
  placeHold(
    grips.carry,
    magHome.clone().add(magRaised.p),
    magRaised.q,
    carryRaised.p,
    carryRaised.q
  );
  const carrySeated: Placement = {
    p: new RifleVec3(),
    q: new RifleQuat()
  };
  placeHold(grips.carry, magHome, identity, carrySeated.p, carrySeated.q);
  const handleHold: Placement = {
    p: grips.handle.p,
    q: grips.handle.q
  };
  const handleRelease: Placement = {
    p: new RifleVec3(),
    q: new RifleQuat()
  };
  const partialPull = {
    partial: true
  };
  const pinchKeys: PlacementKeys = [
    [0, foreHold],
    [0.07, foreHold],
    [0.27, pinchReach],
    [RIFLE_RELOAD_TIMELINE.atMag, pinchHold],
    [9, pinchHold]
  ];
  const returnKeys: { tac: PlacementKeys; empty: PlacementKeys } = {
    tac: [
      [RIFLE_RELOAD_TIMELINE.tacRelease + 0.03, handleRelease],
      [RIFLE_RELOAD_TIMELINE.tac - 0.04, foreHold],
      [9, foreHold]
    ],
    empty: [
      [RIFLE_RELOAD_TIMELINE.release + 0.03, handleRelease],
      [RIFLE_RELOAD_TIMELINE.empty - 0.1, foreHold],
      [9, foreHold]
    ]
  };
  const looseHandPose = lerpPose(new Float32Array(POSE_LENGTH), POSES.relaxed, POSES.open, 0.25);
  const pinchApproachPose = lerpPose(
    new Float32Array(POSE_LENGTH),
    GRIPS.mag_pinch.fit.from,
    grips.pinch.pose,
    0.25
  );
  const handPos = new RifleVec3();
  const handQuat = new RifleQuat();
  const unusedQuat = new RifleQuat(); // allocated but never used (kept from the original)
  const tmpVec = new RifleVec3();
  const magOffset = new RifleVec3();
  const magQuat = new RifleQuat();
  const pinchInverse = new Matrix4().compose(grips.pinch.p, grips.pinch.q, unitScale).invert();
  const carryInverse = new Matrix4().compose(grips.carry.p, grips.carry.q, unitScale).invert();
  const scratchScale = new RifleVec3();
  /** Current support (left) hand target. */
  const leftHand = {
    p: new RifleVec3().copy(foreHold.p),
    q: new RifleQuat().copy(foreHold.q),
    pose: new Float32Array(POSE_LENGTH),
    busy: false
  };
  /** Blends `from -> via` over t in [0, 0.5) and `via -> to` over [0.5, 1]. */
  const lerpPoseVia = (
    out: Float32Array,
    from: Float32Array,
    via: Float32Array,
    to: Float32Array,
    t: number
  ): Float32Array =>
    t < 0.5
      ? lerpPose(out, from, via, smootherstep01(t * 2))
      : lerpPose(out, via, to, smootherstep01(t * 2 - 1));
  /** Moves the magazine so it stays in the left hand (`gripInverse` = hand-from-mag offset). */
  const attachMagToHand = (gripInverse: Matrix4): void => {
    tmpMatrix.compose(handPos, handQuat, unitScale).multiply(gripInverse);
    tmpMatrix.decompose(magGroup.position, magGroup.quaternion, scratchScale);
  };
  let sinceShot = 9;
  let boltLocked = false;
  let boltPull = 0;
  let gripBlend = 1;
  let triggerFinger = 0;

  function resetSupportHand(): void {
    leftHand.busy = false;
    leftHand.p.copy(foreHold.p);
    leftHand.q.copy(foreHold.q);
    leftHand.pose.set(grips.fore.pose);
    magGroup.visible = true;
    magGroup.position.copy(magHome);
    magGroup.quaternion.identity();
    boltPull = 0;
  }
  resetSupportHand();

  const triCount =
    Object.values(geometries).reduce(
      (sum: number, geometry: BufferGeometry) => sum + triangleCount(geometry),
      0
    ) +
    (markings ? triangleCount(markings.geometry) : 0) +
    2;
  let meshCount = 0;
  root.traverse((child) => {
    if ('isMesh' in child && child.isMesh) meshCount++;
  });

  const viewmodel: WeaponViewmodel = {
    id: 'rifle',
    name: RIFLE_SPEC.name,
    root,
    flash,
    muzzle: RIFLE_SPEC.muzzle,
    eject: RIFLE_SPEC.eject,
    sight: [0, RIFLE_SPEC.sightY, -RIFLE_SPEC.lensF],
    info: {
      tris: Math.round(triCount),
      meshes: meshCount
    },
    slot: {
      id: 'rifle',
      name: RIFLE_SPEC.name,
      ammo: 30,
      magSize: 30,
      reserve: 150
    },
    def: {
      magSize: 30,
      reserve: 150,
      rpm: 720,
      damage: 26,
      range: 300,
      auto: true,
      adsTime: 0.18,
      inspect: true,
      flashLight: 45,
      flashScale: 1,
      smoke: true,
      spread: {
        hip: 0.0125,
        ads: 0.0012,
        moveHip: 0.013,
        moveAds: 0.004,
        bloomHip: 0.0065,
        bloomAds: 0.0022,
        air: 0.022,
        crouch: 0.002,
        shot: 0.17,
        decay: 1.5
      }
    },
    views: RIFLE_VIEWS,
    view: 0,
    get pose() {
      return RIFLE_VIEWS[viewmodel.view];
    },
    setView(index) {
      viewmodel.view = Math.max(0, Math.min(RIFLE_VIEWS.length - 1, index | 0));
    },
    motion: VIEWMODEL_MOTION.rifle,
    reloadTime: (empty) => (empty ? RIFLE_RELOAD_TIMELINE.empty : RIFLE_RELOAD_TIMELINE.tac),
    reset() {
      sinceShot = 9;
      boltLocked = false;
      roundMesh.visible = true;
      resetSupportHand();
      boltMesh.position.z = 0;
      gripBlend = 1;
      triggerFinger = 0;
    },
    cancelReload(seated) {
      resetSupportHand();
      if (seated) boltLocked = false;
      roundMesh.visible = viewmodel.slot.ammo > 0;
    },
    shot(emptied) {
      sinceShot = 0;
      if (arms) {
        arms.right.impulse(0.55);
        arms.left.impulse(0.35);
      }
      if (emptied) {
        boltLocked = true;
        roundMesh.visible = false;
      }
    },
    recoil(burst, scale, player: RecoilReceiver) {
      const sustain = burst <= 9 ? 1 : 0.38;
      const yawKick =
        (burst < 4
          ? (rng() - 0.5) * 0.0022
          : Math.sin(burst * 0.57 + state.recPhase) * 0.0042 + (rng() - 0.5) * 0.002) * scale;
      if (player.addRecoil)
        player.addRecoil(0.0068 * sustain * scale * (0.85 + rng() * 0.3), yawKick);
      if (player.addShake) player.addShake(0.12 * scale);
      const recoil = VIEWMODEL_MOTION.rifle.recoil;
      const ads = state.adsE;
      const kick =
        (burst === 1 ? recoil.first : burst === 2 ? 0.5 + 0.5 * recoil.first : 1) *
        (0.88 + rng() * 0.24) *
        (player.crouching ? 0.88 : 1);
      const rotKick = kick * lerp(1, recoil.adsRot, ads);
      const posKick = kick * lerp(1, recoil.adsPos, ads);
      state.kZ.v += recoil.back * kick * lerp(1, recoil.adsBack, ads);
      state.kP.v += recoil.rise * rotKick;
      state.kY.v += (rng() - 0.5) * recoil.yaw * rotKick;
      state.kR.v += (rng() - 0.5) * recoil.roll * rotKick;
      state.kU.v += recoil.up * posKick * (0.7 + 0.6 * rng());
      state.kX.v += (rng() - 0.5) * 2 * recoil.side * posKick;
    },
    reload(reload: ActiveReload, t: number) {
      const fireEvent = context.ev;
      const empty = reload.empty;
      const TL = RIFLE_RELOAD_TIMELINE;

      // One-shot events.
      if (fireEvent(reload, 'magout', TL.magout)) state.bump.v -= 0.25;
      if (t >= TL.swap && !reload.f.fresh) {
        reload.f.fresh = 1;
        roundMesh.visible = true;
      }
      if (fireEvent(reload, 'maginsert', TL.insert)) {
        state.bump.v += 0.1;
        state.kR.v += 0.4;
      }
      if (fireEvent(reload, 'magin', TL.magin)) {
        state.bump.v += 0.8;
        state.kR.v -= 0.55;
        if (!empty) boltLocked = false;
        if (arms) arms.left.impulse(1);
      }
      if (t >= TL.regrip + 0.025 && !reload.f.tug) {
        reload.f.tug = 1;
        state.bump.v -= 0.3;
      }

      // Charging handle travel.
      const boltBackAt = empty ? TL.back : TL.tacBack;
      const releaseAt = empty ? TL.release : TL.tacRelease;
      const boltHomeAt = empty ? TL.bolt : TL.tacBolt;
      const pullFraction = empty ? 1 : TL.partial;
      const lockFraction = empty ? RIFLE_BOLT_LOCKBACK : 0;
      if (t < TL.atHandle) {
        boltPull = lockFraction;
      } else if (t < boltBackAt) {
        boltPull =
          lockFraction +
          (pullFraction - lockFraction) * smootherstep01(linearStep(t, TL.atHandle, boltBackAt));
      } else if (t < releaseAt) {
        boltPull = pullFraction;
      } else {
        boltPull = pullFraction * Math.max(0, 1 - (t - releaseAt) / (boltHomeAt - releaseAt));
      }
      if (fireEvent(reload, 'boltback', boltBackAt, empty ? null : partialPull)) {
        boltLocked = false;
        state.kZ.v += empty ? 0.55 : 0.3;
        state.bump.v -= empty ? 0.12 : 0.06;
      }
      if (fireEvent(reload, 'bolt', boltHomeAt)) {
        boltLocked = false;
        state.kZ.v -= empty ? 0.85 : 0.45;
        state.kP.v -= empty ? 0.9 : 0.4;
        state.bump.v -= empty ? 0.14 : 0.05;
        boltPull = 0;
      }
      // Anticipation (head/arm motion leading the big beats).
      state.antYT =
        0.0045 * rifleRampInWindow(t, TL.magout - 0.14, TL.magout) -
        0.002 * rifleRampInWindow(t, TL.insert - 0.1, TL.insert) -
        0.006 * rifleRampInWindow(t, TL.short, TL.magin);
      state.antRT =
        0.022 * rifleRampInWindow(t, TL.magout - 0.14, TL.magout) +
        0.05 * rifleRampInWindow(t, TL.atHandle - 0.04, releaseAt);

      // Support hand and magazine.
      const handPose = leftHand.pose;
      leftHand.busy = true;
      if (t < TL.magout) {
        // Reach down to the seated magazine.
        sampleKeyframePose(pinchKeys, t, handPos, handQuat);
        lerpPoseVia(
          handPose,
          grips.fore.pose,
          looseHandPose,
          pinchApproachPose,
          linearStep(t, 0.03, 0.3)
        );
        if (t > 0.3) {
          lerpPose(
            handPose,
            pinchApproachPose,
            grips.pinch.pose,
            smootherstep01(linearStep(t, 0.3, TL.atMag + 0.02))
          );
        }
        magGroup.quaternion.identity();
        magGroup.position.copy(magHome);
      } else if (t < TL.away) {
        // Pull the magazine out and drop it away.
        const pull = easeOutQuad(linearStep(t, TL.magout, TL.clear));
        const away = smootherstep01(linearStep(t, TL.clear - 0.03, TL.away));
        handPos.copy(pinchHold.p).lerp(pinchDropped.p, pull).lerp(pinchAway.p, away);
        handQuat.copy(pinchHold.q).slerp(pinchAway.q, away);
        handPose.set(grips.pinch.pose);
        attachMagToHand(pinchInverse);
      } else if (t < TL.rise) {
        // Fresh magazine comes up from the pouch.
        const rise = smootherstep01(linearStep(t, TL.away, TL.rise));
        handPos.copy(pinchAway.p).lerp(carryRaised.p, rise);
        handQuat.copy(pinchAway.q).slerp(carryRaised.q, rise);
        lerpPose(handPose, grips.pinch.pose, grips.carry.pose, rise);
        attachMagToHand(t < TL.swap ? pinchInverse : carryInverse);
      } else {
        let magShort = 0;
        let handDip = 0;
        let cupBlend = 0;
        if (t < TL.insert) {
          sampleKeyframePose(magInsertKeys, t, magOffset, magQuat);
        } else {
          magOffset.set(0, 0, 0);
          magQuat.identity();
          if (t < TL.short) {
            magShort =
              TL.shortBy +
              (RIFLE_MAG_INSERT_DROP - TL.shortBy) *
                Math.pow(1 - linearStep(t, TL.insert, TL.short), 2.2);
          } else if (t < TL.windup) {
            magShort = TL.shortBy;
            cupBlend = smootherstep01(linearStep(t, TL.short, TL.windup));
            handDip = TL.backOff * cupBlend;
          } else if (t < TL.magin) {
            const slap = linearStep(t, TL.windup, TL.magin);
            const travel = (TL.shortBy + TL.backOff) * (1 - slap * slap);
            magShort = Math.min(TL.shortBy, travel);
            handDip = travel - magShort;
            cupBlend = 1;
          } else if (t < TL.rebound) {
            handDip = TL.reboundBy * easeOutQuad(linearStep(t, TL.magin, TL.rebound));
            cupBlend = 1;
          } else if (t < TL.regrip) {
            handDip = TL.reboundBy * (1 - smootherstep01(linearStep(t, TL.rebound, TL.regrip)));
            cupBlend = 1 - smootherstep01(linearStep(t, TL.rebound, TL.regrip));
          } else if (t < TL.tugDown) {
            handDip = TL.tugBy * smootherstep01(linearStep(t, TL.regrip, TL.tugDown));
          } else if (t < TL.tugUp) {
            handDip = TL.tugBy * (1 - smootherstep01(linearStep(t, TL.tugDown, TL.tugUp)));
          }
          magOffset.y = -magShort;
        }
        magGroup.quaternion.copy(magQuat);
        magGroup.position.copy(magHome).add(magOffset);
        if (t < TL.tugUp) {
          // Hand cups the magazine through insertion and the tug test.
          placeHold(grips.carry, magGroup.position, magQuat, handPos, handQuat);
          handPos.y -= handDip;
          lerpPose(handPose, grips.carry.pose, grips.cup.pose, cupBlend);
        } else if (t < TL.atHandle) {
          // Move up to the charging handle.
          const reach = linearStep(t, TL.tugUp, TL.atHandle);
          const reachEased = smootherstep01(reach);
          tmpVec.copy(handleHold.p);
          tmpVec.z += RIFLE_SPEC.boltTravel * lockFraction;
          handPos.copy(carrySeated.p).lerp(tmpVec, reachEased);
          handPos.x -= 0.03 * Math.sin(Math.PI * reachEased);
          handQuat.copy(carrySeated.q).slerp(handleHold.q, reachEased);
          lerpPoseVia(handPose, grips.carry.pose, looseHandPose, grips.handle.pose, reach);
        } else if (t < releaseAt + 0.03) {
          // Rack the charging handle.
          handPos.copy(handleHold.p);
          handPos.z += RIFLE_SPEC.boltTravel * (t < releaseAt ? boltPull : pullFraction);
          handQuat.copy(handleHold.q);
          handleRelease.p.copy(handPos);
          handleRelease.q.copy(handQuat);
          lerpPose(
            handPose,
            grips.handle.pose,
            looseHandPose,
            0.5 * smootherstep01(linearStep(t, releaseAt, releaseAt + 0.03))
          );
        } else {
          // Return to the handguard.
          const keys = empty ? returnKeys.empty : returnKeys.tac;
          sampleKeyframePose(keys, t, handPos, handQuat);
          const back = linearStep(t, keys[0][0], keys[1][0]);
          handPos.y -= 0.035 * Math.sin(Math.PI * smootherstep01(back));
          if (back < 0.6) {
            lerpPose(
              handPose,
              grips.handle.pose,
              looseHandPose,
              0.5 + 0.5 * smootherstep01(back / 0.6)
            );
          } else {
            lerpPose(handPose, looseHandPose, grips.fore.pose, smootherstep01((back - 0.6) / 0.4));
          }
        }
      }
      leftHand.p.copy(handPos);
      leftHand.q.copy(handQuat);
      const fadeIn = smootherstep01(t / 0.3);
      const fadeOut = 1 - smootherstep01((t - (reload.T - 0.46)) / 0.4);
      state.reloadW = Math.min(fadeIn, fadeOut);
      state.rackW = smootherstep01((t - (TL.magin + 0.08)) / 0.28) * fadeOut;
    },
    endReload() {
      resetSupportHand();
    },
    parts(dt, finger) {
      sinceShot += dt;
      const cycle = 0.072;
      let travel = sinceShot < cycle ? Math.sin((Math.PI * sinceShot) / cycle) : 0;
      if (boltLocked && sinceShot > cycle * 0.5) {
        travel = Math.max(travel, RIFLE_BOLT_LOCKBACK / 0.95);
      }
      boltMesh.position.z = RIFLE_SPEC.boltTravel * Math.max(travel * 0.95, boltPull);
      triggerFinger = finger;
    },
    armTargets(targets, dt) {
      const onGrip = state.spV.x > 0.3 || state.reload || state.hol > 0.12 ? 0 : 1;
      gripBlend += (onGrip - gripBlend) * (1 - Math.exp(-16 * dt));
      targets.r.p.copy(grips.grip.p);
      targets.r.q.copy(grips.grip.q);
      lerpPose(targets.r.pose, grips.grip.pose, grips.trigger.pose, smootherstep01(gripBlend));
      targets.r.trig = triggerFinger * gripBlend;
      const sprint = Math.min(1, Math.max(0, state.spV.x));
      targets.r.pole
        .fromArray(rifleGripTuning.poleR)
        .lerp(tmpVec.fromArray(rifleGripTuning.sprintPoleR), sprint);
      targets.r.sh
        .fromArray(rifleGripTuning.shR)
        .lerp(tmpVec.fromArray(rifleGripTuning.sprintShR), sprint);
      targets.l.p.copy(leftHand.p);
      targets.l.q.copy(leftHand.q);
      targets.l.pose.set(leftHand.busy ? leftHand.pose : grips.fore.pose);
      targets.l.trig = 0;
      targets.l.pole.fromArray(rifleGripTuning.poleL);
      targets.l.sh.fromArray(rifleGripTuning.shL);
    },
    snapArms() {
      gripBlend = state.spV.x > 0.3 || state.reload || state.hol > 0.12 ? 0 : 1;
    },
    setLocked(locked) {
      boltLocked = !!locked;
      roundMesh.visible = !locked;
    },
    get locked() {
      return boltLocked;
    },
    holds: grips
  };
  return viewmodel;
}
