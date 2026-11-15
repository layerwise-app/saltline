/**
 * PAC-4 pistol first-person viewmodel: builds the meshes, measures hand
 * colliders from the generated geometry, fits the hand grips (firing grip,
 * trigger finger, support hand, slide-stop thumb, magazine carry / slap) and
 * animates the slide, barrel, slide stop, magazine and support hand through
 * the reload timeline.
 */
import { Group, Quaternion, Vector3 } from 'three';
import type { BufferGeometry, Mesh, MeshStandardMaterial } from 'three';
import { lerp } from '../core/math';
import { createMarkingDecalMesh, createMuzzleFlashMesh } from './markings';
import {
  easeOutQuad,
  linearStep,
  quatFromEuler,
  sampleKeyframePose,
  smootherstep01,
  triangleCount
} from './meshKit';
import { PISTOL_RELOAD_TIMELINE, VIEWMODEL_MOTION } from './animConfig';
import {
  POSES,
  POSE_LENGTH,
  box,
  capsule,
  digitPenetration,
  lerpPose,
  makePose
} from './hand/skeleton';
import type { BoxCollider, Collider } from './hand/skeleton';
import { GRIPS, buildPistolGripShape } from './hand/grips';
import {
  fingerColliders,
  fingerPadPosition,
  fitGripPose,
  handPoseFromSocket,
  meshBoundsInBox,
  reachFingerTo,
  refitGripWithShapes,
  searchFingerPose,
  sliceMeshProfile
} from './gripSolver';
import type { GripFit } from './gripSolver';
import { PISTOL_SPEC, buildPistolGeometry } from './pistolMesh';
import type { PistolGeometries } from './pistolMesh';
import type {
  ActiveReload,
  RecoilReceiver,
  ViewOffset,
  ViewmodelContext,
  WeaponViewSet,
  WeaponViewmodel
} from './index';

/** A hand (or magazine) placement: position + orientation. */
interface Placement {
  p: Vector3;
  q: Quaternion;
}

/** Keyframes `[time, placement]` sampled by `sampleKeyframePose`. */
type PlacementKeys = [number, Placement][];

/** Hand colliders and landmarks measured from the pistol geometry. */
interface PistolColliders {
  /** Grip block: rake, half width / length / depth and centre. */
  gripDim: { rake: number; hw: number; hl: number; hd: number; c: number[] };
  /** Front-strap depth at height `y`. */
  frontAt: (y: number) => number;
  /** Beavertail tang point where the web of the hand sits. */
  tang: Vector3;
  triggerAt: number[];
  trigger: Collider[];
  /** Slide stop lever. */
  lever: BoxCollider[];
  /** Half width of the slide. */
  upperHw: number;
  grip: Collider[];
  mag: BoxCollider[];
  /** Centre of the magazine base pad (magazine space). */
  padBottom: Vector3;
}

/** All fitted pistol hand grips, plus the colliders they were fitted against. */
interface PistolGrips {
  shapes: PistolColliders;
  grip: GripFit;
  trigger: GripFit;
  support: GripFit;
  /** Support-hand pose partly opened (used while re-gripping after the reload). */
  supportOpen: Float32Array;
  /** Firing-hand thumb on the slide stop. */
  stop: GripFit;
  carry: GripFit;
  slap: GripFit;
}

/** The support hand's animated state while reloading. */
interface SupportHand extends Placement {
  pose: Float32Array;
  busy: boolean;
}

const PistolVec3 = Vector3;
const PistolQuat = Quaternion;
/** Distance the magazine travels along its axis when dropped clear / inserted. */
const PISTOL_MAG_TRAVEL = 0.118;
/** Depth of the first (hand) push of the magazine into the well. */
const PISTOL_MAG_PUSH_DEPTH = 0.062;
const pistolOffsetFromHip = (pose: ViewOffset, hip: ViewOffset): ViewOffset => ({
  p: pose.p.map((value, i) => value - hip.p[i]),
  r: pose.r.map((value, i) => value - hip.r[i])
});
const makePistolView = (
  name: string,
  hip: ViewOffset,
  adsDepth: number,
  sprint: ViewOffset,
  sprintArc: ViewOffset,
  reload: ViewOffset,
  rack: ViewOffset
): WeaponViewSet => ({
  name,
  HIP: hip,
  ADS: {
    p: [0, -PISTOL_SPEC.sightY, adsDepth],
    r: [0, 0, 0]
  },
  SPRINT: pistolOffsetFromHip(sprint, hip),
  SPRINT_ARC: sprintArc,
  RELOAD: pistolOffsetFromHip(reload, hip),
  RACK: rack
});
const PISTOL_RACK_POSE: ViewOffset = {
  p: [-0.03, 0.035, 0.04],
  r: [0.06, 0.04, -0.22]
};
const PISTOL_RELOAD_ROT = [0.58, 0.28, -0.99];
const PISTOL_VIEWS: WeaponViewSet[] = [
  makePistolView(
    'close',
    {
      p: [0.075, -0.071, -0.343],
      r: [0.01, 0.08, 0.1]
    },
    -0.44,
    {
      p: [0.07, -0.11, -0.33],
      r: [-0.55, 0.35, 0.12]
    },
    {
      p: [-0.006, -0.012, 0.02],
      r: [0.05, 0.03, 0.04]
    },
    {
      p: [0.065, 0.057, -0.4],
      r: PISTOL_RELOAD_ROT
    },
    PISTOL_RACK_POSE
  ),
  makePistolView(
    'threequarter',
    {
      p: [0.103, -0.101, -0.5],
      r: [0.05, 0.16, 0.05]
    },
    -0.47,
    {
      p: [0.09, -0.13, -0.42],
      r: [-0.45, 0.5, 0.1]
    },
    {
      p: [-0.006, -0.012, 0.025],
      r: [0.05, 0.03, 0.04]
    },
    {
      p: [0.07, 0.05, -0.44],
      r: PISTOL_RELOAD_ROT
    },
    PISTOL_RACK_POSE
  ),
  makePistolView(
    'compact',
    {
      p: [0.166, -0.123, -0.481],
      r: [0.04, 0.07, 0.02]
    },
    -0.47,
    {
      p: [0.14, -0.15, -0.42],
      r: [-0.6, 0.25, 0.05]
    },
    {
      p: [-0.004, -0.01, 0.02],
      r: [0.05, 0.02, 0.03]
    },
    {
      p: [0.08, 0.04, -0.42],
      r: PISTOL_RELOAD_ROT
    },
    PISTOL_RACK_POSE
  )
];
/** Smootherstep ramp from 0 at `start` to 1 at `end`, and 0 outside `[start, end)`. */
const pistolRampInWindow = (t: number, start: number, end: number): number =>
  t < start || t >= end ? 0 : smootherstep01((t - start) / (end - start));
const pistolQuatX = (angle: number): Quaternion =>
  new PistolQuat().setFromAxisAngle(new PistolVec3(1, 0, 0), angle);
const pistolQuatY = (angle: number): Quaternion =>
  new PistolQuat().setFromAxisAngle(new PistolVec3(0, 1, 0), angle);
/** Height of the grip tang above the trigger guard bottom. */
const PISTOL_TANG_OFFSET = 0.026;
/** Hand grip tuning (also the grip cache key). */
const pistolGripTuning = {
  grip: {
    web: [-0.0335, -0.012, -0.045],
    tilt: 0.3,
    roll: 0.3,
    drop: 0.008,
    lift: 0.0025,
    nudge: [-0.008, 0, -0.002],
    thumb: [0, 0],
    wrap: {
      back: [-0.006, 0.024],
      out: [0, 0.0015, 0.003],
      dip: [0.3, 0.6, 0.9],
      clear: 3e-4,
      skin: 0
    }
  },
  support: {
    web: [-0.0335, -0.012, -0.029],
    tilt: 0.3,
    roll: 0.2,
    drop: 0.016,
    pad: [0.008, 0.017, 0.03],
    nudge: [0, -0.014, 0],
    thumb: [0, 0],
    sweep: [0.5, 0.15, 0.1, 1.5, 1.3, -0.25]
  },
  carryYaw: 0,
  slapShift: 0.028,
  shR: [0.2, -0.2, 0.32],
  shL: [-0.2, -0.2, 0.32],
  poleR: [0.8, -0.6, 0],
  poleL: [-0.8, -0.6, 0],
  sprintShR: [0.26, -0.1, 0.32],
  sprintPoleR: [1, -0.2, 0],
  ads: {
    shR: [0.22, -0.3, 0.15],
    shL: [-0.22, -0.3, 0.15],
    poleR: [0.87, -0.5, 0],
    poleL: [-0.87, -0.5, 0]
  }
};

/** Measures the grip, frame, trigger, slide stop and magazine colliders from the pistol geometry. */
function measurePistolColliders(geometries: PistolGeometries): PistolColliders {
  const frontZ = -PISTOL_SPEC.gripFront[0],
    backZ = -PISTOL_SPEC.gripBack[0],
    gripTopY = PISTOL_SPEC.gripFront[1],
    rake = PISTOL_SPEC.rake,
    rakeTan = Math.tan(rake),
    gripHalfWidth = (() => {
      const bounds = meshBoundsInBox(
        geometries.frame,
        [-0.03, gripTopY - 0.02, frontZ],
        [0.03, gripTopY + 0.01, backZ]
      );
      return Math.min(-bounds.min[0], bounds.max[0]);
    })(),
    tangY = meshBoundsInBox(
      geometries.frame,
      [-0.02, gripTopY + 0.015, backZ - 0.004],
      [0.02, gripTopY + 0.048, backZ + 0.003]
    ).min[1],
    gripBottomY = meshBoundsInBox(
      geometries.frame,
      [-0.03, gripTopY - 0.14, frontZ],
      [0.03, gripTopY, backZ + 0.03]
    ).min[1],
    gripCentreY = (tangY + gripBottomY) / 2,
    gripCentreZ = (frontZ + backZ) / 2 + (gripTopY - gripCentreY) * rakeTan,
    gripHalfLength = (tangY - gripBottomY) / 2 / Math.cos(rake),
    gripHalfDepth = ((backZ - frontZ) / 2) * Math.cos(rake);
  const gripDim = {
    rake,
    hw: gripHalfWidth,
    hl: gripHalfLength,
    hd: gripHalfDepth,
    c: [0, gripCentreY, gripCentreZ]
  };
  const frontAt = (y: number): number => frontZ + (gripTopY - y) * rakeTan;
  const gripBlock = box(
      gripDim.c,
      [gripHalfWidth, gripHalfLength, gripHalfDepth],
      pistolQuatX(-rake),
      gripHalfWidth * 0.62
    ),
    slideBounds = meshBoundsInBox(geometries.slide, [-1, -1, -1], [1, 1, 1]),
    upperFrame = meshBoundsInBox(geometries.frame, [-1, gripTopY + 0.026, -1], [1, 0, backZ]),
    upperBlock = box(
      [
        0,
        (upperFrame.min[1] + slideBounds.max[1] - 0.005) / 2,
        (slideBounds.min[2] + upperFrame.max[2]) / 2
      ],
      [
        (slideBounds.max[0] - slideBounds.min[0]) / 2,
        (slideBounds.max[1] - 0.005 - upperFrame.min[1]) / 2,
        (upperFrame.max[2] - slideBounds.min[2]) / 2
      ],
      null,
      0.003
    ),
    guardBar = meshBoundsInBox(
      geometries.frame,
      [-0.009, gripTopY - 0.008, frontZ - 0.064],
      [0.009, gripTopY - 0.003, frontZ - 0.004]
    ),
    guardBlock = box(
      [0, (guardBar.min[1] + guardBar.max[1]) / 2, (guardBar.min[2] + guardBar.max[2]) / 2],
      [
        (guardBar.max[0] - guardBar.min[0]) / 2,
        (guardBar.max[1] - guardBar.min[1]) / 2,
        (guardBar.max[2] - guardBar.min[2]) / 2
      ],
      null,
      0.0015
    );
  const tang = new PistolVec3(
    0,
    guardBar.min[1] + PISTOL_TANG_OFFSET,
    backZ + (gripTopY - guardBar.min[1] - PISTOL_TANG_OFFSET) * rakeTan
  );
  const guardFront = box(
      [0, (guardBar.max[1] + upperFrame.min[1]) / 2, guardBar.min[2] + 0.002],
      [(guardBar.max[0] - guardBar.min[0]) / 2, (upperFrame.min[1] - guardBar.max[1]) / 2, 0.002],
      null,
      0.0015
    ),
    triggerSlices = sliceMeshProfile(
      geometries.steel,
      [-0.0034, gripTopY + 0.0015, -0.008],
      [0.0034, gripTopY + 0.026, 0.008],
      0.005
    ),
    triggerSlice = triggerSlices[Math.floor(triggerSlices.length / 2)];
  const triggerAt = [0, triggerSlice.y, triggerSlice.z0];
  const trigger = [
    capsule(
      [-0.0033, triggerSlice.y + 0.005, triggerSlice.z0 + 0.003],
      [0.0033, triggerSlice.y - 0.008, triggerSlice.z0 + 0.001],
      0.003
    )
  ];
  const stopBounds = meshBoundsInBox(geometries.stop, [-1, -1, -1], [1, 1, 1]),
    stopPivot = PISTOL_SPEC.stopPivot;
  const lever = [
    box(
      [
        stopPivot[0] + (stopBounds.min[0] + stopBounds.max[0]) / 2,
        stopPivot[1],
        stopPivot[2] + stopBounds.max[2] - 0.008
      ],
      [(stopBounds.max[0] - stopBounds.min[0]) / 2, 0.004, 0.008],
      null,
      0.001
    )
  ];
  const beavertail = meshBoundsInBox(
      geometries.frame,
      [-1, gripTopY + 0.026, backZ - 0.012],
      [1, 0, 1]
    ),
    beavertailBlock = box(
      [0, (beavertail.min[1] + beavertail.max[1]) / 2, (beavertail.min[2] + beavertail.max[2]) / 2],
      [
        (beavertail.max[0] - beavertail.min[0]) / 2,
        (beavertail.max[1] - beavertail.min[1]) / 2,
        (beavertail.max[2] - beavertail.min[2]) / 2
      ],
      null,
      0.004
    );
  const upperHw = (slideBounds.max[0] - slideBounds.min[0]) / 2,
    grip: Collider[] = [gripBlock, upperBlock, guardBlock, guardFront, beavertailBlock];
  const magBounds = meshBoundsInBox(geometries.mag, [-1, -1, -1], [1, 1, 1]),
    magBody = meshBoundsInBox(geometries.mag, [-1, magBounds.min[1] + 0.012, -1], [1, -0.012, 1]),
    magPad = meshBoundsInBox(
      geometries.mag,
      [-1, magBounds.min[1], -1],
      [1, magBounds.min[1] + 0.0085, 1]
    );
  const mag = [
    box(
      [0, (magBounds.min[1] + 0.008) / 2, (magBody.min[2] + magBody.max[2]) / 2],
      [
        Math.max(-magBody.min[0], magBody.max[0]),
        -(magBounds.min[1] + 0.008) / 2,
        (magBody.max[2] - magBody.min[2]) / 2
      ],
      null,
      0.003
    ),
    box(
      [0, (magPad.min[1] + magPad.max[1]) / 2, (magPad.min[2] + magPad.max[2]) / 2],
      [magPad.max[0], (magPad.max[1] - magPad.min[1]) / 2, (magPad.max[2] - magPad.min[2]) / 2],
      null,
      0.0025
    )
  ];
  const padBottom = new PistolVec3(0, magBounds.min[1], (magPad.min[2] + magPad.max[2]) / 2);
  // The seated magazine's base pad also blocks the grip (in weapon space).
  {
    const pad = mag[1];
    grip.push(
      box(
        new PistolVec3()
          .fromArray(pad.c)
          .applyQuaternion(pistolQuatX(-rake))
          .add(new PistolVec3().fromArray(PISTOL_SPEC.magPos))
          .toArray(),
        pad.h,
        pistolQuatX(-rake),
        pad.r
      )
    );
  }
  return {
    gripDim,
    frontAt,
    tang,
    triggerAt,
    trigger,
    lever,
    upperHw,
    grip,
    mag,
    padBottom
  };
}

let pistolGripCache: PistolGrips | null = null;
let pistolGripCacheKey = '';

/** Fits every pistol hand grip against the measured colliders (cached per tuning). */
function buildPistolGrips(geometries: PistolGeometries): PistolGrips {
  const cacheKey = JSON.stringify(pistolGripTuning);
  if (pistolGripCache && cacheKey === pistolGripCacheKey) return pistolGripCache;
  const shapes = measurePistolColliders(geometries),
    tuning = pistolGripTuning,
    // Filled in below; cached (by identity) before the grips are fitted, like the original.
    grips = {
      shapes
    } as PistolGrips,
    identity = new PistolQuat(),
    gripDim = shapes.gripDim;
  pistolGripCache = grips;
  pistolGripCacheKey = cacheKey;
  const gripShapeParams = {
      rake: gripDim.rake,
      len:
        (shapes.tang.y - (gripDim.c[1] - gripDim.hl * Math.cos(gripDim.rake))) /
        Math.cos(gripDim.rake),
      width: 2 * gripDim.hw,
      depth: 2 * gripDim.hd,
      top: [0.012, 0.15, 0.004, 0.032],
      topW: 0.027,
      guard: [0.04, 0.096, -0.03],
      trigger: [0.082, -0.013]
    },
    // Right hand: firing grip.
    gripHand = handPoseFromSocket(
      'right',
      buildPistolGripShape({
        ...tuning.grip,
        ...gripShapeParams,
        round: 0.011
      }).frame,
      shapes.tang,
      identity
    );
  gripHand.p.add(new PistolVec3(0, tuning.grip.lift, 0).applyQuaternion(gripHand.q));
  if (tuning.grip.nudge) gripHand.p.add(new PistolVec3().fromArray(tuning.grip.nudge));
  const lever = shapes.lever[0],
    thumbX = -shapes.upperHw - 5e-4;
  grips.grip = fitGripPose(
    'grip',
    'right',
    gripHand.p,
    gripHand.q,
    shapes.grip,
    GRIPS.pistol_grip.fit
  );
  // Wrap the middle, ring and little fingers around the front strap (search over pad offsets).
  if (tuning.grip.wrap) {
    const wrap = tuning.grip.wrap,
      reachWrap = (
        digit: number,
        back: number,
        out: number,
        dip: number,
        pad: Vector3,
        front: number
      ): GripFit =>
        reachFingerTo(
          grips.grip,
          'grip',
          digit,
          [-(gripDim.hw + out), pad.y, front + back],
          grips.grip.pose,
          {
            start: [1.35, 1.45, 0.4, grips.grip.pose[digit * 4 + 3]],
            at: 0.5,
            couple: dip
          }
        );
    for (let digit = 2; digit < 5; digit++) {
      const pad = fingerPadPosition(grips.grip, digit),
        front = shapes.frontAt(pad.y);
      let best: GripFit | null = null,
        bestCost = 1e9;
      for (let back = wrap.back[0]; back <= wrap.back[1] + 1e-9; back += 0.003)
        for (const out of wrap.out)
          for (const dip of wrap.dip) {
            const candidate = reachWrap(digit, back, out, dip, pad, front),
              depth = digitPenetration(candidate.pose, digit, grips.grip.shapes),
              cost =
                5 * Math.max(0, Math.max(depth[0], depth[1]) + wrap.clear) +
                Math.abs(depth[2] + wrap.skin) +
                3 * (candidate.miss as number) -
                0.02 * back;
            if (cost < bestCost) {
              bestCost = cost;
              best = candidate;
            }
          }
      // The search always evaluates at least one candidate.
      grips.grip = best as GripFit;
    }
  }
  grips.grip = searchFingerPose(
    grips.grip,
    'grip',
    0,
    [thumbX, lever.c[1] - 0.006 + tuning.grip.thumb[0], lever.c[2] + 0.022 + tuning.grip.thumb[1]],
    {
      root: 0.85
    }
  );
  grips.trigger = reachFingerTo(
    grips.grip,
    'trigger',
    1,
    [shapes.triggerAt[0] + 0.002, shapes.triggerAt[1] + 0.007, shapes.triggerAt[2] - 0.0015],
    grips.grip.pose,
    {
      start: [0.2, 1, 0.6, 0.1],
      at: 0.4,
      couple: 0.3
    }
  );
  // Left hand: support grip wrapped over the firing fingers.
  const supportHand = handPoseFromSocket(
    'left',
    buildPistolGripShape({
      ...tuning.support,
      ...gripShapeParams,
      round: 0.014
    }).frame,
    shapes.tang,
    identity
  );
  if (tuning.support.nudge) supportHand.p.add(new PistolVec3().fromArray(tuning.support.nudge));
  const sweep = tuning.support.sweep,
    supportFrom = makePose({
      thumb: [0, -0.1, -0.1, 0.7],
      fingers: [sweep[0], sweep[1], sweep[2], 0],
      index: [sweep[0], sweep[1], sweep[2], sweep[5]]
    }),
    supportTo = makePose({
      thumb: [0, -0.1, -0.1, 0.7],
      fingers: [1.6, sweep[1], sweep[2], 0],
      index: [1.6, sweep[1], sweep[2], sweep[5]]
    });
  grips.support = fitGripPose(
    'support',
    'left',
    supportHand.p,
    supportHand.q,
    shapes.grip.concat(fingerColliders(grips.grip, grips.grip.pose, [0, 1, 2, 3, 4])),
    {
      from: supportFrom,
      to: supportTo,
      digits: [1, 2, 3, 4]
    }
  );
  const supportCurled = Float32Array.from(grips.support.pose);
  for (let digit = 1; digit < 5; digit++) {
    supportCurled[digit * 4 + 1] = sweep[3];
    supportCurled[digit * 4 + 2] = sweep[4];
  }
  grips.support = refitGripWithShapes(grips.support, 'support', {
    from: grips.support.pose,
    to: supportCurled,
    digits: [1, 2, 3, 4]
  });
  grips.support = searchFingerPose(grips.support, 'support', 0, [
    thumbX,
    lever.c[1] - 0.002 + tuning.support.thumb[0],
    lever.c[2] - 0.03 + tuning.support.thumb[1]
  ]);
  grips.supportOpen = lerpPose(new Float32Array(POSE_LENGTH), supportFrom, grips.support.pose, 0.2);
  // Firing-hand thumb reaching the slide stop.
  grips.stop = searchFingerPose(
    grips.grip,
    'stop',
    0,
    [lever.c[0] - lever.h[0], lever.c[1] + 0.002, lever.c[2] + 0.002],
    {
      skin: -0.003,
      root: 0.85
    }
  );
  // Left hand cupping the magazine base (carry), and the slap that seats it.
  const carryHand = handPoseFromSocket(
    'left',
    'mag_cup',
    shapes.padBottom,
    pistolQuatY(tuning.carryYaw)
  );
  grips.carry = fitGripPose('carry', 'left', carryHand.p, carryHand.q, shapes.mag, {
    from: GRIPS.mag_cup.fit.from,
    to: makePose({
      thumb: [1.35, 0.7, 0.6, 0.3],
      fingers: [1.6, 1.1, 0.7, 0]
    })
  });
  const slapPos = carryHand.p
    .clone()
    .add(new PistolVec3(0, 0, -tuning.slapShift).applyQuaternion(carryHand.q));
  grips.slap = {
    ...grips.carry,
    name: 'slap',
    p: slapPos,
    pose: lerpPose(new Float32Array(POSE_LENGTH), grips.carry.pose, POSES.relaxed, 0.55)
  };
  return grips;
}

/** Builds the pistol viewmodel (meshes, fitted grips, reload animation) for the weapon system. */
export function createPistolViewmodel(context: ViewmodelContext): WeaponViewmodel {
  const { mats, mk: makeMesh, S: state, rng } = context,
    root = new Group();
  root.name = 'viewmodel-pac4';
  const geometries = buildPistolGeometry();
  root.add(
    makeMesh(geometries.frame, mats.poly),
    makeMesh(geometries.steel, mats.steel),
    makeMesh(geometries.plain, mats.plain)
  );
  // Barrel tilts about its pivot as the slide unlocks.
  const barrel = new Group();
  barrel.position.fromArray(PISTOL_SPEC.barrelPivot);
  geometries.barrel.translate(
    -PISTOL_SPEC.barrelPivot[0],
    -PISTOL_SPEC.barrelPivot[1],
    -PISTOL_SPEC.barrelPivot[2]
  );
  barrel.add(makeMesh(geometries.barrel, mats.steel));
  root.add(barrel);
  const slide = new Group();
  slide.add(makeMesh(geometries.slide, mats.slide), makeMesh(geometries.dots, mats.dots));
  root.add(slide);
  const slideStop = makeMesh(geometries.stop, mats.steel);
  slideStop.position.fromArray(PISTOL_SPEC.stopPivot);
  root.add(slideStop);
  const magazine = new Group(),
    magHome = new PistolVec3().fromArray(PISTOL_SPEC.magPos),
    magTilt = quatFromEuler(-PISTOL_SPEC.rake, 0, 0),
    magAxis = new PistolVec3().fromArray(PISTOL_SPEC.magAxis),
    topRound = makeMesh(geometries.round, mats.brass);
  magazine.add(makeMesh(geometries.mag, mats.steel), topRound);
  root.add(magazine);
  let slideMarkings: Mesh<BufferGeometry, MeshStandardMaterial> | null = null,
    frameMarkings: Mesh<BufferGeometry, MeshStandardMaterial> | null = null;
  try {
    slideMarkings = createMarkingDecalMesh([
      ['p_model', -0.01295, 2e-4, 0.0465, 0.0072, 'L'],
      ['p_name', -0.01295, 2e-4, 0.0215, 0.0044, 'L'],
      ['p_maker', -0.01295, -0.0052, -0.013, 0.0019, 'L'],
      ['p_cal', 0.01295, 2e-4, 0.047, 0.004, 'R']
    ]);
    frameMarkings = createMarkingDecalMesh([
      ['p_prop', -0.01285, -0.0212, 0.059, 0.0022, 'L'],
      ['p_sn', 0.01285, -0.0212, 0.062, 0.0026, 'R'],
      ['p_rack', -0.01285, -0.03, -0.06, 0.0034, 'L']
    ]);
    for (const decal of [slideMarkings, frameMarkings]) {
      decal.castShadow = false;
      decal.receiveShadow = true;
      decal.frustumCulled = false;
    }
    slide.add(slideMarkings);
    root.add(frameMarkings);
  } catch (error) {
    console.warn('[weapon] pistol markings skipped: ' + error);
  }
  const flash = createMuzzleFlashMesh();
  flash.position.fromArray(PISTOL_SPEC.muzzle);
  flash.visible = false;
  root.add(flash);
  const grips = buildPistolGrips(geometries),
    arms = context.arms || null,
    // Unused scratch quaternion kept from the original bundle.
    _spareQuat = new PistolQuat(),
    /** Places `grip` (given in part space) on a part at `origin` / `rotation`. */
    placeGrip = (
      grip: Placement,
      origin: Vector3,
      rotation: Quaternion,
      outPos: Vector3,
      outQuat: Quaternion
    ): void => {
      outQuat.copy(rotation).multiply(grip.q);
      outPos.copy(grip.p).applyQuaternion(rotation).add(origin);
    },
    supportHold: Placement = {
      p: grips.support.p,
      q: grips.support.q
    },
    // Magazine keyframes (relative to the seated position): raised by the hand, aligned, inserted.
    magRaised: Placement = {
      p: new PistolVec3(0.1, -0.38, 0.12),
      q: quatFromEuler(-0.3, 0, 0.45)
    },
    magAligned: Placement = {
      p: magAxis
        .clone()
        .multiplyScalar(PISTOL_MAG_TRAVEL + 0.016)
        .add(new PistolVec3(-0.004, 0, 0.005)),
      q: quatFromEuler(-0.1, 0, 0.08)
    },
    magAtWell: Placement = {
      p: magAxis.clone().multiplyScalar(PISTOL_MAG_TRAVEL),
      q: new PistolQuat()
    },
    magKeys: PlacementKeys = [
      [PISTOL_RELOAD_TIMELINE.rise, magRaised],
      [PISTOL_RELOAD_TIMELINE.align, magAligned],
      [PISTOL_RELOAD_TIMELINE.insert, magAtWell],
      [9, magAtWell]
    ],
    tmpQuat = new PistolQuat(),
    carryAtRise: Placement = {
      p: new PistolVec3(),
      q: new PistolQuat()
    };
  placeGrip(
    grips.carry,
    magHome.clone().add(magRaised.p),
    tmpQuat.copy(magRaised.q).multiply(magTilt),
    carryAtRise.p,
    carryAtRise.q
  );
  const slapDone: Placement = {
    p: new PistolVec3(),
    q: new PistolQuat()
  };
  placeGrip(
    grips.slap,
    magHome.clone().addScaledVector(magAxis, PISTOL_RELOAD_TIMELINE.reboundBy),
    magTilt,
    slapDone.p,
    slapDone.q
  );
  const supportToMagKeys: PlacementKeys = [
      [0, supportHold],
      [0.05, supportHold],
      [0.42, carryAtRise],
      [9, carryAtRise]
    ],
    regripVia = slapDone.p
      .clone()
      .lerp(supportHold.p, 0.5)
      .add(new PistolVec3(0.035, -0.07, 0.045)),
    openPose = lerpPose(new Float32Array(POSE_LENGTH), POSES.relaxed, POSES.open, 0.25),
    supportOpen = grips.supportOpen,
    handPos = new PistolVec3(),
    handQuat = new PistolQuat(),
    magOffset = new PistolVec3(),
    magQuat = new PistolQuat(),
    tmpAxis = new PistolVec3(),
    downDir = new PistolVec3(),
    slapPos = new PistolVec3(),
    slapQuat = new PistolQuat(),
    support: SupportHand = {
      p: new PistolVec3().copy(supportHold.p),
      q: new PistolQuat().copy(supportHold.q),
      pose: new Float32Array(POSE_LENGTH),
      busy: false
    },
    /** Two-segment pose blend `a -> b -> c` over `t` in [0, 1]. */
    blendPose3 = (
      out: Float32Array,
      a: ArrayLike<number>,
      b: ArrayLike<number>,
      c: ArrayLike<number>,
      t: number
    ): Float32Array =>
      t < 0.5
        ? lerpPose(out, a, b, smootherstep01(t * 2))
        : lerpPose(out, b, c, smootherstep01(t * 2 - 1)),
    /** Time for the dropped magazine to slide clear of the well. */
    MAG_CLEAR_TIME = 0.1366,
    /** Speed of the dropped magazine once clear. */
    MAG_DROP_SPEED = 1.53;
  let sinceShot = 9,
    locked = false,
    stopRaise = 0,
    triggerBlend = 1,
    finger = 0,
    stopThumb = 0;
  function resetSupportHand(): void {
    support.busy = false;
    support.p.copy(supportHold.p);
    support.q.copy(supportHold.q);
    support.pose.set(grips.support.pose);
    stopThumb = 0;
    magazine.visible = true;
    magazine.position.copy(magHome);
    magazine.quaternion.copy(magTilt);
  }
  resetSupportHand();
  const setSlide = (travel: number): void => {
    slide.position.z = travel;
    const unlock = Math.min(1, travel / 0.006);
    barrel.rotation.x = 0.02 * unlock;
    barrel.position.z = PISTOL_SPEC.barrelPivot[2] + 0.0025 * unlock;
  };
  const triangles =
    Object.values(geometries).reduce(
      (sum: number, geometry: BufferGeometry) => sum + triangleCount(geometry),
      0
    ) +
    // When the slide markings exist the frame markings do too (both are created in one try block).
    (slideMarkings
      ? triangleCount(slideMarkings.geometry) + triangleCount(frameMarkings!.geometry)
      : 0) +
    2;
  let meshCount = 0;
  root.traverse((object) => {
    if ((object as Mesh).isMesh) meshCount++;
  });
  const viewmodel: WeaponViewmodel = {
    id: 'pistol',
    name: PISTOL_SPEC.name,
    root,
    flash,
    muzzle: PISTOL_SPEC.muzzle,
    eject: PISTOL_SPEC.eject,
    sight: [0, PISTOL_SPEC.sightY, -PISTOL_SPEC.rearF],
    info: {
      tris: Math.round(triangles),
      meshes: meshCount
    },
    slot: {
      id: 'pistol',
      name: PISTOL_SPEC.name,
      ammo: 15,
      magSize: 15,
      reserve: Infinity
    },
    def: {
      magSize: 15,
      reserve: Infinity,
      rpm: 420,
      damage: 34,
      range: 120,
      auto: false,
      adsTime: 0.14,
      inspect: false,
      flashLight: 30,
      flashScale: 0.55,
      smoke: false,
      spread: {
        hip: 0.0105,
        ads: 0.0017,
        moveHip: 0.0065,
        moveAds: 0.003,
        bloomHip: 0.0085,
        bloomAds: 0.003,
        air: 0.018,
        crouch: 0.002,
        shot: 0.3,
        decay: 2.8
      }
    },
    views: PISTOL_VIEWS,
    view: 0,
    get pose() {
      return PISTOL_VIEWS[viewmodel.view];
    },
    setView(index: number) {
      viewmodel.view = Math.max(0, Math.min(PISTOL_VIEWS.length - 1, index | 0));
    },
    motion: VIEWMODEL_MOTION.pistol,
    reloadTime: (empty: boolean) =>
      empty ? PISTOL_RELOAD_TIMELINE.empty : PISTOL_RELOAD_TIMELINE.tac,
    reset() {
      sinceShot = 9;
      locked = false;
      stopRaise = 0;
      topRound.visible = true;
      resetSupportHand();
      setSlide(0);
      slideStop.rotation.x = 0;
      triggerBlend = 1;
      finger = 0;
    },
    cancelReload(seated: boolean) {
      resetSupportHand();
      if (seated) locked = false;
      topRound.visible = viewmodel.slot.ammo > 0;
    },
    shot(emptied: boolean) {
      sinceShot = 0;
      if (arms) {
        arms.right.impulse(0.8);
        arms.left.impulse(0.6);
      }
      if (emptied) {
        locked = true;
        topRound.visible = false;
      }
    },
    recoil(burst: number, scale: number, player: RecoilReceiver) {
      if (player.addRecoil)
        player.addRecoil(0.0092 * scale * (0.9 + rng() * 0.2), (rng() - 0.5) * 0.005 * scale);
      if (player.addShake) player.addShake(0.14 * scale);
      const recoil = VIEWMODEL_MOTION.pistol.recoil,
        ads = state.adsE,
        kick = (0.9 + rng() * 0.2) * (player.crouching ? 0.9 : 1),
        rotKick = kick * lerp(1, recoil.adsRot, ads),
        posKick = kick * lerp(1, recoil.adsPos, ads);
      state.kZ.v += recoil.back * kick * lerp(1, recoil.adsBack, ads);
      state.kP.v += recoil.rise * rotKick;
      state.kY.v += (rng() - 0.5) * recoil.yaw * rotKick;
      state.kR.v += (rng() - 0.5) * recoil.roll * rotKick;
      state.kU.v += recoil.up * posKick;
      state.kX.v += (rng() - 0.5) * 2 * recoil.side * posKick;
    },
    reload(reload: ActiveReload, t: number) {
      const fireEvent = context.ev,
        empty = reload.empty;
      if (fireEvent(reload, 'magout', PISTOL_RELOAD_TIMELINE.magout)) state.bump.v += 0.1;
      if (t >= PISTOL_RELOAD_TIMELINE.swap && !reload.f.fresh) {
        reload.f.fresh = 1;
        topRound.visible = true;
      }
      if (fireEvent(reload, 'maginsert', PISTOL_RELOAD_TIMELINE.insert)) {
        state.bump.v += 0.1;
        state.kR.v += 0.5;
      }
      if (fireEvent(reload, 'magin', PISTOL_RELOAD_TIMELINE.magin)) {
        state.bump.v += 0.85;
        state.kP.v += 0.85;
        if (arms) arms.left.impulse(1);
      }
      if (empty && fireEvent(reload, 'slide', PISTOL_RELOAD_TIMELINE.slide)) {
        locked = false;
        state.kZ.v -= 0.9;
        state.kP.v -= 2.6;
        state.bump.v -= 0.12;
      }
      state.antRT =
        0.035 * pistolRampInWindow(t, 0.03, PISTOL_RELOAD_TIMELINE.magout) -
        0.03 *
          pistolRampInWindow(
            t,
            PISTOL_RELOAD_TIMELINE.thumb - 0.08,
            PISTOL_RELOAD_TIMELINE.slideRelease
          ) *
          (empty ? 1 : 0);
      state.antYT =
        -0.002 *
          pistolRampInWindow(
            t,
            PISTOL_RELOAD_TIMELINE.insert - 0.1,
            PISTOL_RELOAD_TIMELINE.insert
          ) -
        0.0065 *
          pistolRampInWindow(t, PISTOL_RELOAD_TIMELINE.fingers, PISTOL_RELOAD_TIMELINE.magin) +
        0.003 *
          pistolRampInWindow(
            t,
            PISTOL_RELOAD_TIMELINE.thumb - 0.08,
            PISTOL_RELOAD_TIMELINE.slideRelease
          ) *
          (empty ? 1 : 0);
      // Magazine: drop out of the well, then come back in with the support hand.
      let backOff = 0,
        slapBlend = 0;
      if (t < PISTOL_RELOAD_TIMELINE.swap) {
        if (t < PISTOL_RELOAD_TIMELINE.magout) {
          magazine.position.copy(magHome);
          magazine.quaternion.copy(magTilt);
        } else {
          const sinceRelease = t - PISTOL_RELOAD_TIMELINE.magout;
          if (sinceRelease < MAG_CLEAR_TIME) {
            magazine.position
              .copy(magHome)
              .addScaledVector(magAxis, 4.5 * sinceRelease * sinceRelease + 0.3 * sinceRelease);
            magazine.quaternion.copy(magTilt);
          } else {
            const falling = sinceRelease - MAG_CLEAR_TIME;
            downDir.set(0, -1, 0).applyQuaternion(magQuat.copy(root.quaternion).invert());
            magazine.position
              .copy(magHome)
              .addScaledVector(magAxis, 0.125 + MAG_DROP_SPEED * falling)
              .addScaledVector(downDir, 4.9 * falling * falling);
            magQuat.setFromAxisAngle(tmpAxis.set(1, 0, 0), -2.6 * falling);
            magazine.quaternion.copy(magTilt).multiply(magQuat);
          }
        }
      } else {
        let depth = 0;
        if (t < PISTOL_RELOAD_TIMELINE.insert)
          sampleKeyframePose(magKeys, Math.max(t, PISTOL_RELOAD_TIMELINE.rise), magOffset, magQuat);
        else {
          magQuat.identity();
          if (t < PISTOL_RELOAD_TIMELINE.fingers)
            depth =
              PISTOL_MAG_TRAVEL -
              PISTOL_MAG_PUSH_DEPTH *
                easeOutQuad(
                  linearStep(t, PISTOL_RELOAD_TIMELINE.insert, PISTOL_RELOAD_TIMELINE.fingers)
                );
          else if (t < PISTOL_RELOAD_TIMELINE.windup) {
            depth = PISTOL_MAG_TRAVEL - PISTOL_MAG_PUSH_DEPTH;
            slapBlend = smootherstep01(
              linearStep(t, PISTOL_RELOAD_TIMELINE.fingers, PISTOL_RELOAD_TIMELINE.windup)
            );
            backOff = PISTOL_RELOAD_TIMELINE.backOff * slapBlend;
          } else if (t < PISTOL_RELOAD_TIMELINE.magin) {
            const slapT = linearStep(
                t,
                PISTOL_RELOAD_TIMELINE.windup,
                PISTOL_RELOAD_TIMELINE.magin
              ),
              travel =
                (PISTOL_MAG_TRAVEL - PISTOL_MAG_PUSH_DEPTH + PISTOL_RELOAD_TIMELINE.backOff) *
                (1 - slapT * slapT);
            depth = Math.min(PISTOL_MAG_TRAVEL - PISTOL_MAG_PUSH_DEPTH, travel);
            backOff = travel - depth;
            slapBlend = 1;
          } else {
            slapBlend = 1;
            backOff =
              PISTOL_RELOAD_TIMELINE.reboundBy *
              easeOutQuad(
                linearStep(t, PISTOL_RELOAD_TIMELINE.magin, PISTOL_RELOAD_TIMELINE.rebound)
              );
          }
          magOffset.copy(magAxis).multiplyScalar(depth);
        }
        magazine.position.copy(magHome).add(magOffset);
        magazine.quaternion.copy(magQuat).multiply(magTilt);
      }
      // Support hand: to the pouch, carry the magazine in, slap it home, re-grip.
      const pose = support.pose;
      support.busy = true;
      if (t < PISTOL_RELOAD_TIMELINE.swap) {
        sampleKeyframePose(supportToMagKeys, t, handPos, handQuat);
        blendPose3(
          pose,
          grips.support.pose,
          openPose,
          grips.carry.pose,
          linearStep(t, 0.03, PISTOL_RELOAD_TIMELINE.swap - 0.02)
        );
      } else if (t < PISTOL_RELOAD_TIMELINE.rebound) {
        placeGrip(grips.carry, magazine.position, magazine.quaternion, handPos, handQuat);
        placeGrip(grips.slap, magazine.position, magazine.quaternion, slapPos, slapQuat);
        handPos.lerp(slapPos, slapBlend).addScaledVector(magAxis, backOff);
        handQuat.slerp(slapQuat, slapBlend);
        lerpPose(pose, grips.carry.pose, grips.slap.pose, slapBlend);
      } else {
        const regripT = linearStep(
            t,
            PISTOL_RELOAD_TIMELINE.rebound,
            PISTOL_RELOAD_TIMELINE.regrip
          ),
          eased = smootherstep01(regripT),
          remain = 1 - eased;
        // Quadratic Bezier from the slap position through `regripVia` back to the support grip.
        handPos
          .copy(slapDone.p)
          .multiplyScalar(remain * remain)
          .addScaledVector(regripVia, 2 * remain * eased)
          .addScaledVector(supportHold.p, eased * eased);
        handQuat
          .copy(slapDone.q)
          .slerp(
            supportHold.q,
            smootherstep01(
              linearStep(
                t,
                PISTOL_RELOAD_TIMELINE.rebound + 0.02,
                PISTOL_RELOAD_TIMELINE.regrip - 0.02
              )
            )
          );
        if (regripT < 0.55)
          lerpPose(pose, grips.slap.pose, supportOpen, smootherstep01(regripT / 0.55));
        else
          lerpPose(pose, supportOpen, grips.support.pose, smootherstep01((regripT - 0.55) / 0.45));
      }
      support.p.copy(handPos);
      support.q.copy(handQuat);
      // Empty reload: slide stays locked until the thumb drops the slide stop.
      if (empty) {
        stopRaise =
          t < PISTOL_RELOAD_TIMELINE.thumb
            ? 1
            : 1 -
              smootherstep01(
                linearStep(t, PISTOL_RELOAD_TIMELINE.thumb, PISTOL_RELOAD_TIMELINE.slideRelease)
              );
        setSlide(
          t < PISTOL_RELOAD_TIMELINE.slideRelease
            ? PISTOL_SPEC.slideLock
            : PISTOL_SPEC.slideLock *
                Math.max(
                  0,
                  1 -
                    (t - PISTOL_RELOAD_TIMELINE.slideRelease) /
                      (PISTOL_RELOAD_TIMELINE.slide - PISTOL_RELOAD_TIMELINE.slideRelease)
                )
        );
        stopThumb =
          smootherstep01(
            linearStep(t, PISTOL_RELOAD_TIMELINE.thumb - 0.16, PISTOL_RELOAD_TIMELINE.thumb - 0.01)
          ) *
          (1 -
            smootherstep01(
              linearStep(
                t,
                PISTOL_RELOAD_TIMELINE.slide + 0.02,
                PISTOL_RELOAD_TIMELINE.slide + 0.16
              )
            ));
      } else stopThumb = 0;
      state.reloadW = Math.min(
        smootherstep01(t / 0.22),
        1 - smootherstep01((t - (PISTOL_RELOAD_TIMELINE.magin + 0.03)) / 0.32)
      );
      state.rackW = empty
        ? smootherstep01((t - (PISTOL_RELOAD_TIMELINE.magin + 0.05)) / 0.28) *
          (1 - smootherstep01((t - (PISTOL_RELOAD_TIMELINE.slide + 0.04)) / 0.24))
        : 0;
    },
    endReload() {
      resetSupportHand();
    },
    parts(dt: number, fingerPull: number, reloading: boolean) {
      sinceShot += dt;
      const cycleTime = 0.066;
      if (!(reloading && locked)) {
        // Slide cycle: back in 24 ms, forward by 66 ms (stays at the lock when empty).
        let travel =
          sinceShot < cycleTime
            ? sinceShot < 0.024
              ? sinceShot / 0.024
              : 1 - (sinceShot - 0.024) / (cycleTime - 0.024)
            : 0;
        if (locked && sinceShot > 0.024)
          travel = Math.max(travel, PISTOL_SPEC.slideLock / PISTOL_SPEC.slideTravel);
        setSlide(PISTOL_SPEC.slideTravel * travel);
        stopRaise = locked && sinceShot > 0.03 ? 1 : 0;
      }
      slideStop.rotation.x = -0.06 * stopRaise;
      finger = fingerPull;
    },
    armTargets(targets, dt) {
      const wantTrigger = state.spV.x > 0.3 || state.reload || state.hol > 0.12 ? 0 : 1;
      triggerBlend += (wantTrigger - triggerBlend) * (1 - Math.exp(-16 * dt));
      targets.r.p.copy(grips.grip.p);
      targets.r.q.copy(grips.grip.q);
      lerpPose(targets.r.pose, grips.grip.pose, grips.trigger.pose, smootherstep01(triggerBlend));
      targets.r.trig = finger * triggerBlend;
      const sprint = Math.min(1, Math.max(0, state.spV.x)),
        ads = smootherstep01(Math.min(1, Math.max(0, state.adsV.x))),
        adsTuning = pistolGripTuning.ads;
      targets.r.pole
        .fromArray(pistolGripTuning.poleR)
        .lerp(tmpAxis.fromArray(pistolGripTuning.sprintPoleR), sprint)
        .lerp(tmpAxis.fromArray(adsTuning.poleR), ads);
      targets.r.sh
        .fromArray(pistolGripTuning.shR)
        .lerp(tmpAxis.fromArray(pistolGripTuning.sprintShR), sprint)
        .lerp(tmpAxis.fromArray(adsTuning.shR), ads);
      targets.l.p.copy(support.p);
      targets.l.q.copy(support.q);
      targets.l.pose.set(support.busy ? support.pose : grips.support.pose);
      targets.l.trig = 0;
      targets.l.pole
        .fromArray(pistolGripTuning.poleL)
        .lerp(tmpAxis.fromArray(adsTuning.poleL), ads);
      targets.l.sh.fromArray(pistolGripTuning.shL).lerp(tmpAxis.fromArray(adsTuning.shL), ads);
      // Thumb onto the slide stop during an empty reload.
      if (stopThumb > 0)
        for (let slot = 0; slot < 4; slot++)
          targets.r.pose[slot] += (grips.stop.pose[slot] - targets.r.pose[slot]) * stopThumb;
    },
    snapArms() {
      triggerBlend = state.spV.x > 0.3 || state.reload || state.hol > 0.12 ? 0 : 1;
    },
    setLocked(value: boolean) {
      locked = !!value;
      topRound.visible = !value;
      if (value) sinceShot = 9;
    },
    get locked() {
      return locked;
    },
    holds: grips
  };
  return viewmodel;
}
