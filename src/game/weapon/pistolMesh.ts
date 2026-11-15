// PAC-4 pistol geometry: dimensions/attachment points (`PISTOL_SPEC`) and the procedural build of
// every pistol part with the weapon mesh kit, merged into one geometry per material group.
import { BufferGeometry, CircleGeometry, Float32BufferAttribute } from 'three';
import {
  bakeVoxelOcclusion,
  boxZoneFalloff,
  dualRadiusRectOutline,
  extrudeAcrossBore,
  extrudeAlongBore,
  filletPolygon,
  filletedRectOutline,
  kitRoundedBox,
  latheCrossPin,
  latheProfile,
  loftSections,
  mergeKitGeometries,
  outlineToRing
} from './meshKit';
import type { KitPartOptions, Tint } from './meshKit';

/** Pistol dimensions and attachment points shared with the pistol viewmodel (metres, bore along -Z). */
export interface PistolSpec {
  name: string;
  muzzle: number[];
  eject: number[];
  sightY: number;
  /** Rear / front sight distance along the bore. */
  rearF: number;
  frontF: number;
  slideTravel: number;
  /** Slide travel when locked back on an empty magazine. */
  slideLock: number;
  /** Grip rake angle (radians). */
  rake: number;
  magPos: number[];
  magLen: number;
  magAxis: number[];
  stopPivot: number[];
  barrelPivot: number[];
  gripFront: number[];
  gripBack: number[];
}

/** The pistol's merged geometries, one per material group. */
export interface PistolGeometries {
  slide: BufferGeometry;
  barrel: BufferGeometry;
  frame: BufferGeometry;
  steel: BufferGeometry;
  stop: BufferGeometry;
  plain: BufferGeometry;
  mag: BufferGeometry;
  round: BufferGeometry;
  /** Tritium sight dots (unbaked, position/normal/uv only). */
  dots: BufferGeometry;
}

type PistolBakedPart = Exclude<keyof PistolGeometries, 'dots'>;

export const PISTOL_SLIDE_HALF_WIDTH = 0.0128,
  PISTOL_SLIDE_BOTTOM_Y = -0.012,
  PISTOL_SLIDE_TOP_Y = 0.011,
  PISTOL_SIGHT_Y = 0.0165,
  PISTOL_SLIDE_TOP_HALF_WIDTH = 0.0074,
  PISTOL_SLIDE_SHOULDER_Y = 0.0046,
  PISTOL_GRIP_RAKE = 0.314,
  PISTOL_MAG_AXIS_SINCOS = [-0.309, -0.951],
  PISTOL_MAG_LENGTH = 0.1185,
  PISTOL_SPEC: PistolSpec = {
    name: 'PAC-4 Bosun',
    muzzle: [0, 0, -0.1075],
    eject: [0.017, 0.007, -0.01],
    sightY: PISTOL_SIGHT_Y,
    rearF: -0.0705,
    frontF: 0.0885,
    slideTravel: 0.04,
    slideLock: 0.036,
    rake: PISTOL_GRIP_RAKE,
    magPos: [0, -0.013, 0.0387],
    magLen: PISTOL_MAG_LENGTH,
    magAxis: [0, PISTOL_MAG_AXIS_SINCOS[1], -PISTOL_MAG_AXIS_SINCOS[0]],
    stopPivot: [0, -0.0165, -0.004],
    barrelPivot: [0, -0.01, 0],
    gripFront: [-0.0335, -0.06],
    gripBack: [-0.0925, -0.06]
  },
  translatedDisc = (
    radius: number,
    x: number,
    y: number,
    z: number,
    segments = 12
  ): CircleGeometry => {
    const disc = new CircleGeometry(radius, segments);
    disc.translate(x, y, z);
    return disc;
  };

/** Slide cross-section outline (closed, symmetric); `inset` narrows the flanks (serration cuts). */
function pistolSlideProfile(inset = 0, halfWidth = PISTOL_SLIDE_HALF_WIDTH): number[][] {
  const rightSide = [
    [halfWidth - 8e-4, PISTOL_SLIDE_BOTTOM_Y],
    [halfWidth, PISTOL_SLIDE_BOTTOM_Y + 8e-4],
    [halfWidth, PISTOL_SLIDE_BOTTOM_Y + 0.0022],
    [halfWidth - 55e-5, PISTOL_SLIDE_BOTTOM_Y + 0.0027],
    [halfWidth - 55e-5, PISTOL_SLIDE_BOTTOM_Y + 0.0041],
    [halfWidth, PISTOL_SLIDE_BOTTOM_Y + 0.0046],
    [halfWidth - inset, PISTOL_SLIDE_BOTTOM_Y + 0.0056],
    [halfWidth - inset, PISTOL_SLIDE_SHOULDER_Y - 0.001],
    [halfWidth, PISTOL_SLIDE_SHOULDER_Y],
    [PISTOL_SLIDE_TOP_HALF_WIDTH + 7e-4, PISTOL_SLIDE_TOP_Y - 8e-4],
    [PISTOL_SLIDE_TOP_HALF_WIDTH, PISTOL_SLIDE_TOP_Y]
  ];
  return rightSide.concat(rightSide.map((point) => [-point[0], point[1]]).reverse());
}

/** Build every part of the PAC-4 pistol and merge them into one geometry per material group. */
export function buildPistolGeometry(): PistolGeometries {
  const slideTint = [1, 1, 1],
    leverTint = [1, 1, 1],
    pinTint = [2.6, 2.6, 2.7],
    darkTint = [0.3, 0.3, 0.31],
    frameTint = [1, 1, 1],
    plateTint = [0.014, 0.014, 0.015],
    slideFinish: KitPartOptions = {
      wear: 1
    },
    triggerBarFinish: KitPartOptions = {
      wear: 0.9
    },
    pinFinish: KitPartOptions = {
      bare: 0.45,
      wear: 1.2
    },
    frameFinish: KitPartOptions = {
      wear: 0.8
    },
    darkFinish: KitPartOptions = {
      wear: 0,
      ao: 0.75
    },
    noWear: KitPartOptions = {
      wear: 0
    },
    slideParts: BufferGeometry[] = [],
    barrelParts: BufferGeometry[] = [],
    frameParts: BufferGeometry[] = [],
    steelParts: BufferGeometry[] = [],
    stopParts: BufferGeometry[] = [],
    plainParts: BufferGeometry[] = [],
    magParts: BufferGeometry[] = [],
    roundParts: BufferGeometry[] = [],
    sightDots: BufferGeometry[] = [],
    /** A chamfered disc lathed between `z0` and `z1`, its axis offset to `(ox, oy)`. */
    chamferedDisc = (
      radius: number,
      z0: number,
      z1: number,
      ox: number,
      oy: number,
      tint: Tint,
      segments: number,
      options: KitPartOptions
    ): BufferGeometry => {
      const chamfer = Math.min(radius * 0.25, (z1 - z0) * 0.25);
      return latheProfile(
        [
          [0, z0],
          [radius - chamfer, z0],
          [radius, z0 + chamfer],
          [radius, z1 - chamfer],
          [radius - chamfer, z1],
          [0, z1]
        ],
        segments,
        tint,
        {
          ...options,
          ox,
          oy
        }
      );
    },
    serrationRake = 0.245,
    serrationDepth = 65e-5,
    slideOutline = pistolSlideProfile(0),
    serrationOutline = pistolSlideProfile(serrationDepth),
    slideFlankOcclusion = (x: number, y: number): number =>
      Math.abs(x) < PISTOL_SLIDE_HALF_WIDTH - 3e-4 &&
      y > PISTOL_SLIDE_BOTTOM_Y + 0.005 &&
      y < PISTOL_SLIDE_SHOULDER_Y - 5e-4
        ? 0.8
        : 0,
    /** Append `count` raked serration grooves (4 rings each) starting at depth `start`. */
    addSerrations = (
      rings: number[][][],
      start: number,
      count: number,
      pitch = 0.0032,
      width = 0.0015
    ): void => {
      for (let k = 0; k < count; k++) {
        const z = start + k * pitch;
        rings.push(
          outlineToRing(slideOutline, z - width / 2 - 35e-5, {
            rake: -serrationRake
          }),
          outlineToRing(serrationOutline, z - width / 2, {
            rake: -serrationRake
          }),
          outlineToRing(serrationOutline, z + width / 2, {
            rake: -serrationRake
          }),
          outlineToRing(slideOutline, z + width / 2 + 35e-5, {
            rake: -serrationRake
          })
        );
      }
    };
  // Slide: rear section with rear serrations.
  {
    const rings = [
      outlineToRing(slideOutline, -0.082, {
        sx: 0.945,
        sy: 0.94,
        cy: -5e-4
      }),
      outlineToRing(slideOutline, -0.0811)
    ];
    addSerrations(rings, -0.0735, 10);
    rings.push(outlineToRing(slideOutline, -0.038), outlineToRing(slideOutline, -0.0118));
    slideParts.push(
      loftSections(rings, slideTint, {
        ...slideFinish,
        crease: 38,
        aoFn: slideFlankOcclusion
      })
    );
  }
  // Slide: ejection port section (left half only, port cut on the right).
  {
    const bottomRight = slideOutline.slice(0, 6),
      leftSide = slideOutline.slice(11),
      portOutline = [
        ...bottomRight,
        [PISTOL_SLIDE_HALF_WIDTH, -0.0011],
        [PISTOL_SLIDE_HALF_WIDTH - 6e-4, -5e-4],
        [-0.0042, -5e-4],
        [-0.0042, PISTOL_SLIDE_TOP_Y - 6e-4],
        [-0.0048, PISTOL_SLIDE_TOP_Y],
        ...leftSide.filter((point) => point[0] < -0.005)
      ];
    slideParts.push(
      extrudeAlongBore(portOutline, -0.012, 0.03, 4e-4, slideTint, {
        wear: 1,
        zone: 0.5,
        crease: 38
      })
    );
  }
  // Slide: front section with front serrations and the muzzle taper.
  {
    const rings = [outlineToRing(slideOutline, 0.0298), outlineToRing(slideOutline, 0.056)];
    addSerrations(rings, 0.064, 6);
    rings.push(
      outlineToRing(slideOutline, 0.088),
      outlineToRing(slideOutline, 0.0975),
      outlineToRing(slideOutline, 0.1018, {
        sx: 0.965,
        sy: 0.97,
        cy: 0.002
      }),
      outlineToRing(slideOutline, 0.104, {
        sx: 0.9,
        sy: 0.92,
        cy: 0.002
      })
    );
    slideParts.push(
      loftSections(rings, slideTint, {
        ...slideFinish,
        crease: 38,
        aoFn: slideFlankOcclusion
      })
    );
  }
  // Anti-glare ribs on the slide top.
  for (let k = 0; k < 5; k++) {
    const x = (k - 2) * 0.0026;
    slideParts.push(
      kitRoundedBox(9e-4, 5e-4, 0.044, 2e-4, x, PISTOL_SLIDE_TOP_Y + 1e-4, -0.04, slideTint, {
        wear: 0.45
      })
    );
    slideParts.push(
      kitRoundedBox(9e-4, 5e-4, 0.05, 2e-4, x, PISTOL_SLIDE_TOP_Y + 1e-4, 0.059, slideTint, {
        wear: 0.45
      })
    );
  }
  const sightTint = [0.8, 0.8, 0.83];
  // Rear sight blade (with notch) and its base.
  slideParts.push(
    extrudeAlongBore(
      filletPolygon(
        [
          [-0.0092, PISTOL_SLIDE_TOP_Y - 4e-4],
          [0.0092, PISTOL_SLIDE_TOP_Y - 4e-4],
          [0.0092, PISTOL_SIGHT_Y - 0.0016],
          [0.0078, PISTOL_SIGHT_Y],
          [0.0019, PISTOL_SIGHT_Y],
          [0.0019, PISTOL_SIGHT_Y - 0.003],
          [-0.0019, PISTOL_SIGHT_Y - 0.003],
          [-0.0019, PISTOL_SIGHT_Y],
          [-0.0078, PISTOL_SIGHT_Y],
          [-0.0092, PISTOL_SIGHT_Y - 0.0016]
        ],
        [0, 0, 6e-4, 6e-4, 0, 0, 0, 0, 6e-4, 6e-4],
        1
      ),
      -0.0755,
      -0.0655,
      4e-4,
      sightTint,
      slideFinish
    )
  );
  slideParts.push(
    extrudeAlongBore(
      [
        [-0.0074, PISTOL_SLIDE_TOP_Y - 2e-4],
        [0.0074, PISTOL_SLIDE_TOP_Y - 2e-4],
        [0.0066, PISTOL_SLIDE_TOP_Y + 0.0011],
        [-0.0066, PISTOL_SLIDE_TOP_Y + 0.0011]
      ],
      -0.078,
      -0.063,
      3e-4,
      sightTint,
      slideFinish
    )
  );
  // Loaded-chamber / striker indicator pin.
  slideParts.push(
    latheProfile(
      [
        [0, -6e-4],
        [0.0011, -6e-4],
        [0.0013, -3e-4],
        [0.0013, 4e-4],
        [0, 4e-4]
      ],
      6,
      pinTint,
      pinFinish
    )
      .rotateX(Math.PI / 2)
      .translate(0, PISTOL_SLIDE_TOP_Y + 0.0011, 0.0642)
  );
  // Front sight post and its base.
  slideParts.push(
    extrudeAcrossBore(
      [
        [0.0885, PISTOL_SLIDE_TOP_Y - 4e-4],
        [0.0975, PISTOL_SLIDE_TOP_Y - 4e-4],
        [0.0935, PISTOL_SIGHT_Y],
        [0.0885, PISTOL_SIGHT_Y]
      ],
      -0.0017,
      0.0017,
      3e-4,
      sightTint,
      slideFinish
    )
  );
  slideParts.push(
    extrudeAlongBore(
      [
        [-0.005, PISTOL_SLIDE_TOP_Y - 2e-4],
        [0.005, PISTOL_SLIDE_TOP_Y - 2e-4],
        [0.0044, PISTOL_SLIDE_TOP_Y + 0.001],
        [-0.0044, PISTOL_SLIDE_TOP_Y + 0.001]
      ],
      0.087,
      0.0985,
      3e-4,
      sightTint,
      slideFinish
    )
  );
  // Extractor and its pin.
  slideParts.push(
    kitRoundedBox(
      0.0013,
      0.003,
      0.019,
      5e-4,
      PISTOL_SLIDE_HALF_WIDTH,
      0.0012,
      -0.0225,
      [2.2, 2.2, 2.3],
      {
        bare: 0.5,
        wear: 1
      }
    )
  );
  slideParts.push(
    latheCrossPin(0.001, 6e-4, PISTOL_SLIDE_HALF_WIDTH + 2e-4, 0.0012, -0.03, pinTint, 6, pinFinish)
  );
  // Rear cover plate and striker cap.
  slideParts.push(
    extrudeAlongBore(
      filletedRectOutline(-0.008, -0.0092, 0.008, 0.0052, 0.0016, 2),
      -0.0826,
      -0.0816,
      3e-4,
      [0.62, 0.62, 0.64],
      {
        wear: 0.6
      }
    )
  );
  slideParts.push(chamferedDisc(0.0016, -0.0829, -0.082, 0, -0.0052, pinTint, 8, pinFinish));
  slideParts.push(
    kitRoundedBox(
      0.0012,
      0.0032,
      0.0052,
      3e-4,
      -PISTOL_SLIDE_HALF_WIDTH,
      PISTOL_SLIDE_BOTTOM_Y + 0.0015,
      0.008,
      darkTint,
      darkFinish
    )
  );
  // Dark annuli at the muzzle (slide face and recoil-spring guide hole).
  slideParts.push(
    latheProfile(
      [
        [0.0082, 0.10405],
        [0.0067, 0.10405]
      ],
      16,
      [0.1, 0.1, 0.11],
      darkFinish
    )
  );
  slideParts.push(
    latheProfile(
      [
        [0.0036, 0.10405],
        [0.0029, 0.10405]
      ],
      10,
      [0.1, 0.1, 0.11],
      {
        ...darkFinish,
        oy: -0.0088
      }
    )
  );
  // Tritium dots: two rear, one front.
  for (const side of [-1, 1])
    sightDots.push(translatedDisc(0.00105, side * 0.0052, PISTOL_SIGHT_Y - 0.0024, 0.0755 + 1e-4));
  sightDots.push(translatedDisc(0.00115, 0, PISTOL_SIGHT_Y - 0.0019, -0.0885 + 1e-4));
  // Barrel: tube with crowned muzzle, bore, and chamber hood with its lug.
  barrelParts.push(
    latheProfile(
      [
        [0.0066, 0.026],
        [0.0066, 0.105],
        [0.0061, 0.1066],
        [0.0055, 0.1075],
        [0.0049, 0.1075],
        [0.0045, 0.1062]
      ],
      16,
      [5.5, 5.5, 5.7],
      {
        bare: 0.8,
        wear: 0.6
      }
    )
  );
  barrelParts.push(
    latheProfile(
      [
        [0.0045, 0.1062],
        [0.0045, 0.09],
        [0, 0.09]
      ],
      12,
      [0.25, 0.25, 0.25],
      darkFinish
    )
  );
  barrelParts.push(
    extrudeAlongBore(
      filletPolygon(
        [
          [-0.0038, -4e-4],
          [0.009, -4e-4],
          [0.009, 0.0096],
          [0.008, 0.0106],
          [-0.003, 0.0106],
          [-0.0038, 0.0098]
        ],
        5e-4,
        1
      ),
      -0.0115,
      0.0295,
      5e-4,
      [7.5, 7.5, 7.8],
      {
        bare: 1,
        wear: 0.5,
        zone: 0.8
      }
    )
  );
  barrelParts.push(
    kitRoundedBox(0.0022, 6e-4, 0.0034, 2e-4, 0.0026, 0.0106, -0.0085, darkTint, darkFinish)
  );
  barrelParts.push(
    kitRoundedBox(6e-4, 0.004, 0.006, 2e-4, 0.0091, 0.004, -0.008, darkTint, darkFinish)
  );
  // Frame: dust cover / trigger guard side profile.
  const frameOutline = filletPolygon(
    [
      [0.098, -0.0126],
      [0.1, -0.015],
      [0.1, -0.027],
      [0.097, -0.03],
      [0.024, -0.03],
      [0.02, -0.033],
      [-0.026, -0.033],
      [-0.031, -0.04],
      [-0.084, -0.04],
      [-0.0875, -0.03],
      [-0.0885, -0.0126]
    ],
    [6e-4, 0.0015, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.004, 8e-4],
    2
  );
  frameParts.push(
    extrudeAcrossBore(frameOutline, -0.0127, 0.0127, 0.0016, frameTint, {
      ...frameFinish,
      bs: 2
    })
  );
  // Frame: beavertail.
  frameParts.push(
    loftSections(
      [
        [-0.084, 0.0126, -0.033, -0.0126, 0.0016, 0.003],
        [-0.0872, 0.0125, -0.0292, -0.0126, 0.0018, 0.004],
        [-0.0902, 0.012, -0.0258, -0.0128, 0.0022, 0.0046],
        [-0.093, 0.011, -0.0232, -0.0132, 0.0026, 0.0044],
        [-0.0954, 0.0096, -0.0214, -0.0139, 0.0028, 0.0036],
        [-0.0972, 0.008, -0.0203, -0.0147, 0.0026, 0.0028],
        [-0.0984, 0.006, -0.0196, -0.0156, 0.0019, 0.0019]
      ].map(([z, halfWidth, bottom, top, topRadius, bottomRadius]) =>
        outlineToRing(dualRadiusRectOutline(halfWidth, bottom, top, topRadius, bottomRadius, 4), z)
      ),
      frameTint,
      {
        ...frameFinish,
        crease: 62
      }
    )
  );
  // Frame: grip, lofted between front-strap and back-strap profiles, with side panels and pins.
  {
    const frontStrap = [
        [-0.0262, -0.015],
        [-0.0275, -0.033],
        [-0.03, -0.037],
        [-0.0335, -0.06],
        [-0.0545, -0.125],
        [-0.056, -0.13]
      ],
      backStrap = [
        [-0.0895, -0.015],
        [-0.0915, -0.0222],
        [-0.0878, -0.03],
        [-0.085, -0.035],
        [-0.0885, -0.042],
        [-0.093, -0.062],
        [-0.101, -0.09],
        [-0.1085, -0.115]
      ],
      /** Strap X at height `y` (piecewise linear; extrapolates past the last segment). */
      strapAt = (strap: number[][], y: number): number => {
        let k = 0;
        for (; k < strap.length - 2 && y < strap[k + 1][1];) k++;
        return (
          strap[k][0] +
          ((strap[k + 1][0] - strap[k][0]) * (y - strap[k][1])) / (strap[k + 1][1] - strap[k][1])
        );
      },
      gripSections: number[][][] = [];
    for (const [frontY, backY, halfWidth, topRadius, bottomRadius] of [
      [-0.015, -0.015, 0.0124, 0.004, 0.004],
      [-0.0185, -0.0185, 0.013, 0.0055, 0.005],
      [-0.024, -0.024, 0.0137, 0.0068, 0.0062],
      [-0.031, -0.031, 0.0146, 0.0078, 0.008],
      [-0.04, -0.039, 0.015, 0.0082, 0.0096],
      [-0.06, -0.058, 0.015, 0.0084, 0.0102],
      [-0.08, -0.076, 0.015, 0.0084, 0.0104],
      [-0.1, -0.093, 0.015, 0.0084, 0.0104],
      [-0.118, -0.106, 0.015, 0.0082, 0.01],
      [-0.124, -0.1105, 0.0158, 0.008, 0.0096],
      [-0.13, -0.115, 0.0162, 0.0078, 0.0092],
      [-0.1308, -0.1158, 0.015, 0.007, 0.0084]
    ]) {
      const frontX = strapAt(frontStrap, frontY),
        backX = strapAt(backStrap, backY),
        section = dualRadiusRectOutline(halfWidth, backX, frontX, topRadius, bottomRadius, 4);
      gripSections.push(
        section.map((point) => [
          point[0],
          backY + ((frontY - backY) * (point[1] - backX)) / (frontX - backX),
          -point[1]
        ])
      );
    }
    frameParts.push(
      loftSections(gripSections, frameTint, {
        ...frameFinish,
        crease: 40
      })
    );
    const panelOutline = filletPolygon(
        [
          [-0.044, -0.05],
          [-0.06, -0.115],
          [-0.099, -0.104],
          [-0.0935, -0.085],
          [-0.0865, -0.06],
          [-0.083, -0.045],
          [-0.056, -0.041]
        ],
        0.004,
        2
      ),
      panelHole: number[][] = [];
    for (let k = 0; k < 16; k++) {
      const angle = (k / 16) * Math.PI * 2;
      panelHole.push([-0.0685 + Math.cos(angle) * 0.0064, -0.072 + Math.sin(angle) * 0.0064]);
    }
    for (const side of [-1, 1]) {
      frameParts.push(
        extrudeAcrossBore(
          panelOutline,
          side > 0 ? 0.0146 : -0.0155,
          side > 0 ? 0.0155 : -0.0146,
          4e-4,
          frameTint,
          {
            wear: 0.8,
            zone: 1,
            holes: [panelHole]
          }
        )
      );
      steelParts.push(
        latheCrossPin(0.0058, 0.0012, side * 0.015, -0.072, -0.0685, [3.2, 3.2, 3.3], 16, {
          bare: 0.7,
          wear: 1
        })
      );
      frameParts.push(
        extrudeAcrossBore(
          filletedRectOutline(0, -0.027, 0.019, -0.018, 0.002, 2),
          side > 0 ? 0.0124 : -0.0131,
          side > 0 ? 0.0131 : -0.0124,
          3e-4,
          frameTint,
          {
            wear: 0.8,
            zone: 1
          }
        )
      );
    }
  }
  // Frame: accessory rail with slots.
  frameParts.push(
    extrudeAlongBore(
      [
        [-0.0086, -0.0296],
        [0.0086, -0.0296],
        [0.01, -0.032],
        [-0.01, -0.032]
      ],
      0.038,
      0.095,
      4e-4,
      frameTint,
      frameFinish
    )
  );
  {
    const railLug = filletPolygon(
      [
        [-0.01, -0.0316],
        [0.01, -0.0316],
        [0.0106, -0.0326],
        [0.009, -0.0346],
        [-0.009, -0.0346],
        [-0.0106, -0.0326]
      ],
      4e-4,
      1
    );
    for (let k = 0; k < 5; k++) {
      const z = 0.042 + k * 0.01001;
      frameParts.push(extrudeAlongBore(railLug, z, z + 0.00478, 6e-4, frameTint, frameFinish));
    }
  }
  // Frame: trigger guard ring.
  frameParts.push(
    extrudeAcrossBore(
      filletPolygon(
        [
          [0.024, -0.029],
          [0.025, -0.056],
          [0.016, -0.0665],
          [-0.029, -0.0665],
          [-0.0345, -0.06],
          [-0.03, -0.032]
        ],
        [0.001, 0.004, 0.004, 0.004, 0.003, 0.001],
        2
      ),
      -0.0075,
      0.0075,
      0.002,
      frameTint,
      {
        ...frameFinish,
        bs: 2,
        holes: [
          filletPolygon(
            [
              [0.0195, -0.0335],
              [0.02, -0.055],
              [0.014, -0.062],
              [-0.027, -0.062],
              [-0.03, -0.057],
              [-0.026, -0.0335]
            ],
            0.004,
            3
          )
        ]
      }
    )
  );
  for (let k = 0; k < 5; k++)
    frameParts.push(
      kitRoundedBox(
        0.011,
        0.0016,
        0.0014,
        5e-4,
        0,
        -0.037 - k * 0.0042,
        0.0252,
        frameTint,
        frameFinish
      )
    );
  // Backstrap plate, lanyard loop with its pin, and magazine release button.
  plainParts.push(
    kitRoundedBox(
      0.0222,
      0.001,
      0.0345,
      2e-4,
      0,
      -0.12585,
      -0.07526,
      plateTint,
      noWear,
      [-0.278, 0, 0]
    )
  );
  frameParts.push(
    extrudeAcrossBore(
      filletPolygon(
        [
          [-0.101, -0.1085],
          [-0.1094, -0.1112],
          [-0.1072, -0.1188],
          [-0.099, -0.116]
        ],
        0.0015,
        2
      ),
      -0.003,
      0.003,
      8e-4,
      frameTint,
      {
        ...frameFinish,
        holes: [filletedRectOutline(-0.1064, -0.1158, -0.1026, -0.1116, 0.0012, 2)]
      }
    )
  );
  steelParts.push(latheCrossPin(0.0013, 0.0304, 0, -0.103, -0.0985, pinTint, 8, pinFinish));
  frameParts.push(
    kitRoundedBox(
      0.0034,
      0.0082,
      0.0072,
      0.0014,
      -0.015,
      -0.0455,
      -0.0375,
      frameTint,
      {
        wear: 1.2
      },
      [-PISTOL_GRIP_RAKE, 0, 0]
    )
  );
  for (let k = 0; k < 3; k++)
    frameParts.push(
      kitRoundedBox(
        8e-4,
        0.001,
        0.006,
        3e-4,
        -0.0169,
        -0.0432 - k * 0.0022,
        -0.0375 - k * 7e-4,
        frameTint,
        frameFinish
      )
    );
  // Frame pins.
  for (const [z, y, radius] of [
    [0.004, -0.0225, 0.0019],
    [-0.008, -0.0178, 0.0016],
    [-0.076, -0.026, 0.0019]
  ])
    steelParts.push(latheCrossPin(radius, 0.0262, 0, y, z, pinTint, 10, pinFinish));
  // Trigger and trigger bar.
  steelParts.push(
    extrudeAcrossBore(
      filletPolygon(
        [
          [-0.0065, -0.0325],
          [0.0012, -0.0325],
          [6e-4, -0.042],
          [0.003, -0.05],
          [0.0056, -0.0565],
          [0.0022, -0.0588],
          [-0.003, -0.052],
          [-0.0055, -0.043]
        ],
        [0, 0, 0.004, 0.005, 8e-4, 8e-4, 0.005, 0.004],
        2
      ),
      -0.0033,
      0.0033,
      0.0011,
      [1.2, 1.2, 1.25],
      {
        wear: 0.6,
        bs: 2
      }
    )
  );
  steelParts.push(
    kitRoundedBox(
      0.0012,
      0.011,
      0.0014,
      4e-4,
      0,
      -0.049,
      0.0048,
      [0.6, 0.6, 0.62],
      triggerBarFinish,
      [0.36, 0, 0]
    )
  );
  // Takedown levers with grooves.
  for (const side of [-1, 1]) {
    steelParts.push(
      kitRoundedBox(0.0018, 0.0044, 0.0125, 7e-4, side * 0.0131, -0.0188, 0.0215, leverTint, {
        wear: 1.3
      })
    );
    for (let k = 0; k < 4; k++)
      steelParts.push(
        kitRoundedBox(
          8e-4,
          0.0034,
          0.001,
          3e-4,
          side * 0.0142,
          -0.0188,
          0.0178 + k * 0.0025,
          leverTint,
          {
            wear: 1.3
          }
        )
      );
  }
  // Recoil spring guide rod.
  steelParts.push(
    latheProfile(
      [
        [0.0028, 0.03],
        [0.0028, 0.1036],
        [0.0023, 0.1046],
        [0, 0.1046]
      ],
      10,
      [8, 8, 8.3],
      {
        bare: 0.9,
        wear: 0.4,
        oy: -0.0088
      }
    )
  );
  // Slide rails.
  for (const side of [-1, 1])
    steelParts.push(
      kitRoundedBox(0.002, 0.001, 0.15, 3e-4, side * 0.0112, -0.01225, 0.01, darkTint, darkFinish)
    );
  // Slide stop lever (pivots at PISTOL_SPEC.stopPivot).
  {
    stopParts.push(
      extrudeAcrossBore(
        filletPolygon(
          [
            [0.0045, 0.0024],
            [0.0045, -0.0024],
            [-0.019, -0.0022],
            [-0.029, -0.004],
            [-0.0335, -0.0016],
            [-0.0335, 0.003],
            [-0.0255, 0.004],
            [-0.019, 0.0022]
          ],
          8e-4,
          1
        ),
        -0.0149,
        -0.0128,
        5e-4,
        [1.3, 1.3, 1.35],
        {
          wear: 1.3
        }
      )
    );
    for (let k = 0; k < 4; k++)
      stopParts.push(
        kitRoundedBox(
          8e-4,
          0.005,
          0.0011,
          3e-4,
          -0.0152,
          2e-4,
          -0.0222 - k * 0.0026,
          [1.3, 1.3, 1.35],
          {
            wear: 1.3
          }
        )
      );
    stopParts.push(latheCrossPin(0.0026, 0.001, -0.0153, 0, 0.001, pinTint, 10, pinFinish));
  }
  // Magazine (local to PISTOL_SPEC.magPos, before the grip rake).
  const magTint = [2.3, 2.3, 2.4],
    magLength = PISTOL_MAG_LENGTH,
    magFinish: KitPartOptions = {
      bare: 0.45,
      wear: 1,
      zone: 0.6
    };
  magParts.push(
    extrudeAcrossBore(
      filletedRectOutline(-0.0155, -magLength, 0.0155, 0, 0.003, 2).map((point) => [
        -point[0],
        point[1]
      ]),
      -0.01025,
      0.01025,
      0.0018,
      magTint,
      {
        ...magFinish,
        bs: 2
      }
    )
  );
  magParts.push(
    kitRoundedBox(
      0.005,
      magLength - 0.02,
      0.001,
      4e-4,
      0,
      -magLength / 2 - 0.004,
      0.0157,
      magTint,
      magFinish
    )
  );
  for (let k = 0; k < 6; k++)
    magParts.push(
      latheCrossPin(0.0015, 6e-4, 0.01025, -0.03 - k * 0.014, -0.01, darkTint, 8, darkFinish)
    );
  for (const side of [-1, 1])
    magParts.push(
      kitRoundedBox(0.0024, 0.0052, 0.023, 8e-4, side * 0.0074, 0.0016, -0.003, magTint, magFinish)
    );
  magParts.push(
    kitRoundedBox(0.0262, 0.008, 0.04, 0.0026, 0, -magLength - 0.0036, 0.0025, [0.85, 0.85, 0.87], {
      wear: 0.7
    })
  );
  magParts.push(
    kitRoundedBox(
      0.018,
      0.0012,
      0.008,
      4e-4,
      0,
      -magLength - 0.0078,
      0.01,
      [0.55, 0.55, 0.56],
      noWear
    )
  );
  magParts.push(
    kitRoundedBox(0.015, 0.004, 0.019, 0.001, 0, -0.001, -0.004, [6, 2.6, 0.9], noWear)
  );
  // Top round in the magazine: case and bullet.
  const bulletTint = [1.25, 0.72, 0.5];
  {
    const caseGeometry = latheProfile(
        [
          [0, -0.0105],
          [0.0046, -0.0105],
          [0.0049, -0.0098],
          [0.0049, 0.007],
          [0.0046, 0.0085]
        ],
        12,
        [1, 1, 1],
        noWear
      ),
      bulletGeometry = latheProfile(
        [
          [0.0045, 0.0085],
          [0.0043, 0.0125],
          [0.0034, 0.016],
          [0.0018, 0.0182],
          [0, 0.0188]
        ],
        12,
        bulletTint,
        noWear
      );
    for (const geometry of [caseGeometry, bulletGeometry]) {
      geometry.rotateX(0.09);
      geometry.translate(0, 0.0046, -0.001);
      roundParts.push(geometry);
    }
  }
  const merged: Record<PistolBakedPart, BufferGeometry> = {
      slide: mergeKitGeometries(slideParts),
      barrel: mergeKitGeometries(barrelParts),
      frame: mergeKitGeometries(frameParts),
      steel: mergeKitGeometries(steelParts),
      stop: mergeKitGeometries(stopParts),
      plain: mergeKitGeometries(plainParts),
      mag: mergeKitGeometries(magParts),
      round: mergeKitGeometries(roundParts)
    },
    /** Grip-texture zones: the grip panels on the frame, cocking serration areas on the slide. */
    gripZone = (x: number, y: number, z: number, key: string): number =>
      key === 'frame'
        ? Math.abs(x) < 0.0155 && y < -0.048 && y > -0.124 && -z < -0.03
          ? (1 - Math.min(1, Math.max(0, (Math.abs(x) - 0.0075) / 0.003))) *
            Math.max(
              1 - Math.min(1, Math.max(0, (-0.0335 + (y + 0.06) * 0.323 + z - 0.004) / 0.003)),
              1 - Math.min(1, Math.max(0, (-z - (-0.093 + (y + 0.062) * 0.2857) - 0.004) / 0.003))
            )
          : 0
        : key === 'slide'
          ? Math.max(
              0.8 * boxZoneFalloff(x, y, z, -0.006, 0.02, -0.002, 0.009, -0.014, 0.032, 0.004),
              0.6 * boxZoneFalloff(x, y, z, -0.02, 0.02, -0.02, 0.02, 0.094, 0.11, 0.008),
              0.5 * boxZoneFalloff(x, y, z, -0.02, 0.02, -0.014, -0.0105, -0.09, 0.11, 0.002)
            )
          : 0;
  bakeVoxelOcclusion(
    (Object.keys(merged) as PistolBakedPart[]).map((key) => ({
      key,
      g: merged[key],
      off:
        key === 'mag' || key === 'round'
          ? PISTOL_SPEC.magPos
          : key === 'stop'
            ? PISTOL_SPEC.stopPivot
            : null,
      rx: key === 'mag' || key === 'round' ? -PISTOL_GRIP_RAKE : 0
    })),
    gripZone,
    0.0013
  );
  const geometries: PistolGeometries = Object.assign(merged, { dots: mergeSightDots(sightDots) });
  for (const key of Object.keys(geometries) as (keyof PistolGeometries)[])
    geometries[key].computeBoundingSphere();
  return geometries;
}

/** Merge the (indexed, uv-mapped) sight dot discs into one geometry. */
function mergeSightDots(discs: readonly BufferGeometry[]): BufferGeometry {
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  let vertexBase = 0;
  for (const disc of discs) {
    const position = disc.attributes.position.array,
      normal = disc.attributes.normal.array,
      uv = disc.attributes.uv.array;
    for (let k = 0; k < position.length; k++) {
      positions.push(position[k]);
      normals.push(normal[k]);
    }
    for (let k = 0; k < uv.length; k++) uvs.push(uv[k]);
    // CircleGeometry is always indexed.
    for (const index of disc.index!.array) indices.push(index + vertexBase);
    vertexBase += position.length / 3;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}
