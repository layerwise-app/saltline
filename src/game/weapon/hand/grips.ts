/**
 * Grip library: collider shapes, part frames and curl-fit ranges for each way
 * a hand holds a weapon part (pistol grip, trigger, foregrip, handguard,
 * magazine, charging handle ...), plus the hand-socket transform and fitting
 * of the reference poses that are installed into `POSES`.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  DIGITS,
  POSES,
  box,
  capsule,
  computeHandFk,
  createHandFk,
  curlUntilContact,
  makePose
} from './skeleton';
import type { BoxCollider, Collider, Pose, Vec3Tuple } from './skeleton';
import { palmSdf } from './glove';

/** Position + orientation of a grip's part frame in hand space. */
export interface GripFrame {
  p: Vector3;
  q: Quaternion;
}

/** Curl range used to fit a grip's reference pose (see `curlUntilContact`). */
export interface GripFit {
  from: Pose;
  to: Pose;
  /** Digits to curl (default all). */
  digits?: number[];
  /** Pose of the digits that are not curled. */
  rest?: Pose;
}

/** Parameters of a pistol-grip shape (metres / radians, hand space). */
export interface PistolGripParams {
  /** Where the web of the thumb sits on the grip. */
  web: readonly number[];
  /** Grip tilt about the hand's Y axis. */
  tilt: number;
  /** Grip roll. */
  roll: number;
  drop?: number;
  /** Optional padding `[width, depth, start]` (support hand over the firing fingers). */
  pad?: readonly number[];
  /** Rake of the grip relative to the frame. */
  rake: number;
  len: number;
  width: number;
  depth: number;
  round: number;
  /** Frame above the grip: `[start, end, offset, height]`. */
  top: readonly number[];
  topW: number;
  /** Trigger guard bar: `[start, end, height]`. */
  guard: readonly number[];
  /** Trigger position: `[along, height]`. */
  trigger: readonly number[];
}

/** Result of `buildPistolGripShape`. */
export interface PistolGripShape {
  colliders: Collider[];
  frame: GripFrame;
  /** Trigger bar end points. */
  trigger: [Vec3Tuple, Vec3Tuple];
  /** Grip axis (along its length). */
  a: Vector3;
  /** Grip front direction. */
  f: Vector3;
  /** Grip side normal. */
  n: Vector3;
}

/** One entry of `GRIPS`. */
export interface GripDef {
  colliders: Collider[];
  frame: GripFrame;
  /** Human-readable description of the grip and its frame. */
  about: string;
  fit: GripFit;
  trigger?: [Vec3Tuple, Vec3Tuple];
  a?: Vector3;
  f?: Vector3;
  n?: Vector3;
}

const GripsVector3 = Vector3;
const GripsQuaternion = Quaternion;
const GripsMatrix4 = Matrix4;
const gripVec = (x?: number, y?: number, z?: number): Vector3 => new GripsVector3(x, y, z);

/** Frame at `origin` with +Y along `up` and -Z along `forward` (orthogonalised). */
function makeGripFrame(origin: Vector3, up: Vector3, forward: Vector3): GripFrame {
  const yAxis = up.clone().normalize();
  const zAxis = forward.clone().negate();
  zAxis.addScaledVector(yAxis, -zAxis.dot(yAxis)).normalize();
  const xAxis = new GripsVector3().crossVectors(yAxis, zAxis);
  return {
    p: origin.clone(),
    q: new GripsQuaternion().setFromRotationMatrix(
      new GripsMatrix4().makeBasis(xAxis, yAxis, zAxis)
    )
  };
}

/** Box collider from a centre, three basis axes, half extents and rounding. */
function basisBox(
  center: Vector3,
  xAxis: Vector3,
  yAxis: Vector3,
  zAxis: Vector3,
  halfX: number,
  halfY: number,
  halfZ: number,
  round: number
): BoxCollider {
  return box(
    center.toArray(),
    [halfX, halfY, halfZ],
    new GripsQuaternion().setFromRotationMatrix(new GripsMatrix4().makeBasis(xAxis, yAxis, zAxis)),
    round
  );
}

export const GRIP_UP = gripVec(0, 1, 0);
/** All grips by name. */
export const GRIPS: Record<string, GripDef> = {};

/** Builds the colliders, part frame and trigger bar of a pistol-style grip. */
export function buildPistolGripShape(params: PistolGripParams): PistolGripShape {
  const axis = gripVec(Math.cos(params.tilt), 0, Math.sin(params.tilt));
  const across = gripVec(Math.sin(params.tilt), 0, -Math.cos(params.tilt));
  const web = gripVec(params.web[0], params.web[1], params.web[2]);
  const rollCos = Math.cos(params.roll);
  const rollSin = Math.sin(params.roll);
  const front = across.clone().multiplyScalar(rollCos).addScaledVector(GRIP_UP, -rollSin);
  const side = across.clone().multiplyScalar(-rollSin).addScaledVector(GRIP_UP, -rollCos);
  const corner =
    params.roll >= 0
      ? web.clone()
      : web.clone().addScaledVector(across, params.depth).addScaledVector(front, -params.depth);
  const pad = params.pad || [0, 0, 0];
  corner.addScaledVector(axis, -(params.drop || 0)).addScaledVector(side, pad[0]);
  const gripCenter = corner
    .clone()
    .addScaledVector(axis, params.len / 2 - 0.004)
    .addScaledVector(front, params.depth / 2)
    .addScaledVector(side, params.width / 2);
  const outward = side.clone().negate();
  const colliders: Collider[] = [
    basisBox(
      gripCenter,
      axis,
      outward,
      front.clone().negate(),
      params.len / 2,
      params.width / 2,
      params.depth / 2,
      params.round
    )
  ];
  if (params.pad) {
    const padStart = params.pad[2];
    const padLength = params.len - 0.004 - padStart;
    colliders.push(
      basisBox(
        corner
          .clone()
          .addScaledVector(axis, padStart + padLength / 2)
          .addScaledVector(front, (params.depth + pad[1]) / 2)
          .addScaledVector(side, (params.width - pad[0]) / 2),
        axis,
        outward,
        front.clone().negate(),
        padLength / 2,
        (params.width + pad[0]) / 2,
        (params.depth + pad[1]) / 2,
        params.round + 0.003
      )
    );
  }
  const frameUp = axis
    .clone()
    .multiplyScalar(-Math.cos(params.rake))
    .addScaledVector(front, -Math.sin(params.rake));
  const frameForward = front
    .clone()
    .multiplyScalar(Math.cos(params.rake))
    .addScaledVector(axis, -Math.sin(params.rake));
  const frameOrigin = corner
    .clone()
    .addScaledVector(side, params.width / 2)
    .addScaledVector(axis, -0.004);
  const framePoint = (forward: number, up: number): Vector3 =>
    frameOrigin.clone().addScaledVector(frameForward, forward).addScaledVector(frameUp, up);
  colliders.push(
    basisBox(
      framePoint((params.top[0] + params.top[1]) / 2, params.top[2] + params.top[3] / 2),
      frameUp.clone().negate(),
      outward,
      frameForward.clone().negate(),
      params.top[3] / 2,
      params.topW / 2,
      (params.top[1] - params.top[0]) / 2,
      0.004
    )
  );
  colliders.push(
    capsule(
      framePoint(params.guard[0], params.guard[2]).toArray(),
      framePoint(params.guard[1], params.guard[2]).toArray(),
      0.0035
    )
  );
  const triggerPoint = framePoint(params.trigger[0], params.trigger[1]);
  return {
    colliders,
    frame: makeGripFrame(frameOrigin, frameUp, frameForward),
    trigger: [
      triggerPoint.clone().addScaledVector(side, -0.004).toArray(),
      triggerPoint.clone().addScaledVector(side, 0.004).toArray()
    ],
    a: axis,
    f: front,
    n: side
  };
}

const WRAP_FINGER_OPEN = [0.1, 1.62, 1.02, 0];
const WRAP_FINGER_CLOSED = [1.55, 1.78, 1.08, 0];
const WRAP_MIDDLE_OPEN = [0.1, 1.62, 1.02, -0.1];
const WRAP_MIDDLE_CLOSED = [1.55, 1.78, 1.08, -0.1];
const GRIP_FIT_START_POSE = makePose({
  thumb: [1.3, 0, 0, 1],
  index: [-0.45, 0.1, 0.06, 0.36],
  middle: WRAP_MIDDLE_OPEN,
  ring: WRAP_FINGER_OPEN,
  little: WRAP_FINGER_OPEN
});
const RIFLE_GRIP_SHAPE = buildPistolGripShape({
  web: [-0.0335, -0.012, -0.045],
  tilt: 0.22,
  roll: -0.3,
  drop: 0.012,
  rake: 0.3,
  len: 0.094,
  width: 0.028,
  depth: 0.045,
  round: 0.009,
  top: [0.012, 0.2, 0.005, 0.04],
  topW: 0.034,
  guard: [0.036, 0.1, -0.024],
  trigger: [0.084, -0.01]
});
const RIFLE_GRIP_THUMB = [1.3, 0.55, 0.6, -0.1];
const INDEX_ALONG_FRAME = [0.8, 0.1, 0.06, 0.36];
GRIPS.rifle_grip = {
  ...RIFLE_GRIP_SHAPE,
  about:
    'firing hand on an AR-style pistol grip, index straight along the receiver. Frame: origin at the top rear of the grip (where the web of the thumb sits), +Y up, -Z muzzle.',
  fit: {
    from: GRIP_FIT_START_POSE,
    to: makePose({
      thumb: RIFLE_GRIP_THUMB,
      index: INDEX_ALONG_FRAME,
      middle: WRAP_MIDDLE_CLOSED,
      ring: WRAP_FINGER_CLOSED,
      little: WRAP_FINGER_CLOSED
    })
  }
};
GRIPS.trigger = {
  ...RIFLE_GRIP_SHAPE,
  about:
    'same grip with the index pad on the trigger (colliders include the trigger as a thin bar). setTrigger(0..1) pulls.',
  colliders: RIFLE_GRIP_SHAPE.colliders.concat([
    capsule(RIFLE_GRIP_SHAPE.trigger[0], RIFLE_GRIP_SHAPE.trigger[1], 0.0032)
  ]),
  fit: {
    from: makePose(
      {
        index: [-0.25, 0.2, 0.1, 0.16]
      },
      GRIP_FIT_START_POSE
    ),
    to: makePose({
      thumb: RIFLE_GRIP_THUMB,
      index: [0.34, 1.6, 0.95, 0.2],
      middle: WRAP_MIDDLE_CLOSED,
      ring: WRAP_FINGER_CLOSED,
      little: WRAP_FINGER_CLOSED
    })
  }
};
const PISTOL_GRIP_SHAPE = buildPistolGripShape({
  web: [-0.0335, -0.012, -0.045],
  tilt: 0.16,
  roll: -0.2,
  drop: 0.008,
  rake: 0.31,
  len: 0.1,
  width: 0.03,
  depth: 0.05,
  round: 0.011,
  top: [0.012, 0.15, 0.004, 0.032],
  topW: 0.027,
  guard: [0.04, 0.096, -0.03],
  trigger: [0.082, -0.013]
});
GRIPS.pistol_grip = {
  ...PISTOL_GRIP_SHAPE,
  about:
    'high firing grip on a service pistol, index straight along the frame. Frame: origin at the top of the backstrap under the beavertail, +Y up, -Z muzzle.',
  fit: {
    from: GRIP_FIT_START_POSE,
    to: makePose({
      thumb: [0.95, 0.18, 0.22, 0.3],
      index: INDEX_ALONG_FRAME,
      middle: WRAP_MIDDLE_CLOSED,
      ring: WRAP_FINGER_CLOSED,
      little: WRAP_FINGER_CLOSED
    })
  }
};
GRIPS.slide_stop = {
  ...PISTOL_GRIP_SHAPE,
  about:
    'pistol_grip with the thumb pressing the slide stop down (the lever sits on the left of the frame above the trigger).',
  fit: {
    from: GRIP_FIT_START_POSE,
    to: makePose({
      thumb: [1.15, 0.52, 0.66, 0.34],
      index: INDEX_ALONG_FRAME,
      middle: WRAP_MIDDLE_CLOSED,
      ring: WRAP_FINGER_CLOSED,
      little: WRAP_FINGER_CLOSED
    })
  }
};
{
  const supportShape = buildPistolGripShape({
    web: [-0.0335, -0.012, -0.029],
    tilt: -0.45,
    roll: 0,
    drop: 0.016,
    pad: [0.014, 0.017, 0.03],
    rake: 0.31,
    len: 0.1,
    width: 0.03,
    depth: 0.05,
    round: 0.014,
    top: [0.012, 0.15, 0.004, 0.032],
    topW: 0.027,
    guard: [0.04, 0.096, -0.03],
    trigger: [0.082, -0.013]
  });
  GRIPS.pistol_support = {
    ...supportShape,
    about:
      "support hand wrapped over the firing hand's fingers (the grip shape is padded by those fingers), thumb forward along the frame. Frame: the SAME part frame as pistol_grip (the pistol's tang), so both hands take one frame.",
    fit: {
      from: makePose({
        thumb: [0, -0.1, -0.1, 0.7],
        fingers: [-0.2, 1.1, 0.6, 0]
      }),
      to: makePose({
        thumb: [0.6, 0.2, 0.2, 0.7],
        fingers: WRAP_FINGER_CLOSED
      })
    }
  };
}
{
  const top = gripVec(-0.05, -0.0315, -0.078);
  const bottom = gripVec(0.042, -0.0315, -0.066);
  const along = top.clone().sub(bottom).normalize();
  const forward = gripVec(0.1, -0.5, -0.86);
  forward.addScaledVector(along, -forward.dot(along)).normalize();
  const sideways = new GripsVector3().crossVectors(forward, along);
  GRIPS.foregrip = {
    colliders: [
      capsule(top.toArray(), bottom.toArray(), 0.0165),
      basisBox(
        top.clone().addScaledVector(along, 0.03),
        along,
        sideways,
        forward,
        0.021,
        0.022,
        0.1,
        0.006
      )
    ],
    frame: makeGripFrame(top.clone().addScaledVector(along, 0.009), along, forward),
    about:
      'fist round a vertical foregrip. Frame: origin at the top of the grip where it meets the handguard, +Y up along the grip, -Z muzzle (the hand may be turned about +Y freely).',
    fit: {
      from: makePose({
        thumb: [1.25, 0, 0, 0.85],
        fingers: [-0.05, 0.04, 0.02, 0]
      }),
      to: makePose({
        thumb: [1.25, 0.55, 0.7, -0.12],
        fingers: [1.5, 1.8, 1.1, -0.02]
      })
    }
  };
}
{
  const center = gripVec(0, -0.0375, -0.082);
  GRIPS.handguard = {
    colliders: [box(center.toArray(), [0.09, 0.0225, 0.0225], null, 0.012)],
    frame: makeGripFrame(center, gripVec(0, -1, 0), gripVec(-1, 0, 0)),
    about:
      "support hand cupped under a ~45 mm handguard, fingers up the far side, thumb along the near side pointing at the muzzle. Frame: origin on the handguard's centre line under the middle of the palm, +Y up, -Z muzzle.",
    fit: {
      from: makePose({
        thumb: [0.25, -0.1, -0.2, 1],
        fingers: [-0.05, 0.04, 0.02, 0.04]
      }),
      to: makePose({
        thumb: [1.2, 0.3, 0.35, 1],
        fingers: [1.5, 1.6, 1, 0]
      })
    }
  };
}
{
  const center = gripVec(0.004, -0.1035, -0.059);
  GRIPS.mag_cup = {
    colliders: [box(center.toArray(), [0.012, 0.09, 0.031], null, 0.003)],
    frame: makeGripFrame(gripVec(0.004, -0.0135, -0.059), gripVec(0, -1, 0), gripVec(0, 0, -1)),
    about:
      "palm up under a magazine base plate, fingers up its front face, thumb up its side. Frame: origin at the centre of the base plate, +Y along the magazine toward the gun, -Z the magazine's front (bullet noses).",
    fit: {
      from: makePose({
        thumb: [0.9, 0, 0, 0.9],
        fingers: [0.2, 0.05, 0.02, 0]
      }),
      to: makePose({
        thumb: [1.3, 0.3, 0.3, -0.1],
        index: [1.42, 0.3, 0.2, 0],
        middle: [1.6, 0.3, 0.2, 0],
        ring: [1.6, 0.3, 0.2, 0],
        little: [1.36, 0.34, 0.22, 0]
      })
    }
  };
}
{
  const magUp = gripVec(0, Math.cos(0.95), Math.sin(0.95));
  const magFront = gripVec(0, -Math.sin(0.95), Math.cos(0.95));
  const center = gripVec(-0.006, -0.05, -0.088);
  GRIPS.mag_pinch = {
    colliders: [basisBox(center, gripVec(1, 0, 0), magUp, magFront, 0.09, 0.012, 0.031, 0.003)],
    frame: makeGripFrame(center, gripVec(-1, 0, 0), magFront.clone().negate()),
    about:
      'a magazine held by its flat sides between the thumb and the fingers. Frame: origin at the middle of the magazine body, +Y toward its feed lips, -Z its front.',
    fit: {
      from: makePose({
        thumb: [0.55, -0.1, -0.2, 1],
        fingers: [0.35, 0.1, 0.05, 0]
      }),
      to: makePose({
        thumb: [1.25, 0.5, 0.5, 0.1],
        fingers: [1.3, 1.1, 0.6, 0]
      })
    }
  };
}
{
  // The charging handle is placed where hooked index/middle fingers end up.
  const hookPose = makePose({
    fingers: [0.3, 1.25, 0.85, 0]
  });
  const fk = computeHandFk(hookPose, createHandFk());
  const indexPoint = fk.j[5].clone().lerp(fk.j[6], 0.62);
  const middlePoint = fk.j[9].clone().lerp(fk.j[10], 0.62);
  const indexPalmar = gripVec(0, -1, 0).applyQuaternion(fk.q[4]);
  const handleStart = indexPoint.clone().addScaledVector(indexPalmar, DIGITS[1].rad[1] + 0.006);
  const handleEnd = middlePoint
    .clone()
    .addScaledVector(gripVec(0, -1, 0).applyQuaternion(fk.q[7]), DIGITS[2].rad[1] + 0.006);
  const handleAxis = handleEnd.clone().sub(handleStart).normalize();
  handleStart.addScaledVector(handleAxis, -0.016);
  handleEnd.addScaledVector(handleAxis, 0.014);
  const handleCenter = handleStart.clone().add(handleEnd).multiplyScalar(0.5);
  const handleForward = gripVec(0, 0, 1).applyQuaternion(fk.q[4]).negate();
  GRIPS.charging_handle = {
    colliders: [capsule(handleStart.toArray(), handleEnd.toArray(), 0.005)],
    frame: makeGripFrame(
      handleCenter,
      new GripsVector3().crossVectors(handleAxis, handleForward),
      handleForward.clone()
    ),
    about:
      'index and middle fingers hooked over an AR charging handle, the others folded. Frame: origin at the middle of the handle, +Y up, -Z muzzle (rack by moving the hand along +Z of the part).',
    fit: {
      digits: [1, 2],
      rest: makePose({
        thumb: [0.25, 0.2, 0.3, 0.45],
        ring: [1.3, 1.55, 0.9, 0],
        little: [1.3, 1.5, 0.85, -0.04]
      }),
      from: makePose({
        fingers: [0.3, 0.35, 0.2, 0]
      }),
      to: makePose({
        fingers: [0.3, 1.8, 1.25, 0]
      })
    }
  };
}

const tmpInverseFrameQuat = new GripsQuaternion();
const tmpFrameOffset = new GripsVector3();

/**
 * Hand (wrist) transform that puts grip `name`'s part frame at
 * `partPosition` / `partRotation`. Writes `outPosition` / `outRotation`.
 */
export function handSocket(
  name: string,
  partPosition: Vector3,
  partRotation: Quaternion,
  outPosition: Vector3,
  outRotation: Quaternion
): Vector3 {
  const grip = GRIPS[name];
  if (!grip) throw new Error('weapon_hands: unknown grip "' + name + '"');
  tmpInverseFrameQuat.copy(grip.frame.q).invert();
  outRotation.copy(partRotation).multiply(tmpInverseFrameQuat);
  outPosition
    .copy(tmpFrameOffset.copy(grip.frame.p).negate().applyQuaternion(outRotation))
    .add(partPosition);
  return outPosition;
}

const FIST_FIT: GripFit = {
  from: makePose(
    {
      thumb: [1.3, 0, 0, 0.95]
    },
    POSES.open
  ),
  to: makePose({
    thumb: [1.15, 0.75, 0.95, 0.1],
    index: [1.5, 1.9, 1.3, -0.04],
    middle: [1.52, 1.9, 1.3, 0],
    ring: [1.54, 1.9, 1.3, -0.03],
    little: [1.56, 1.9, 1.3, -0.08]
  })
};

/** Fits the reference pose of every grip (and a fist) by curling until contact. */
export function fitReferencePoses(): Record<string, Pose> {
  const poses: Record<string, Pose> = {
    fist: curlUntilContact([], {
      ...FIST_FIT,
      palm: palmSdf
    })
  };
  for (const name in GRIPS)
    poses[name] = curlUntilContact(GRIPS[name].colliders, {
      ...GRIPS[name].fit,
      palm: palmSdf
    });
  return poses;
}

/** Adds fitted reference poses to `POSES` (fitting them if not given). */
export function installReferencePoses(
  poses: Record<string, Pose> = fitReferencePoses()
): Record<string, Pose> {
  for (const name in poses) POSES[name] = poses[name];
  return POSES;
}
