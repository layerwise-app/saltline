/**
 * Layout of the open container yard: container stacks, light masts, the
 * forklift corner, scattered props, lane signs and the perimeter fence/gate.
 */
import { Vector3 } from 'three';
import type { LevelKit } from './kit';
import {
  SHED,
  layGroundCable,
  placeLaneSign,
  placePowerPedestal,
  placeRebarBundle,
  placeScrapCage,
  placeScrapSkip,
  placeWheelChock
} from './structures';

// Minified name kept: this is simply Math.PI.
export const renderRiserSaws = Math.PI;
export const HALF_PI = renderRiserSaws / 2;
/** Height of the pallet resting on the forklift's raised forks. */
export const FORKLIFT_PALLET_Y = 0.535;
/** Shorthand for `new Vector3(x, y, z)`. */
export const vec3 = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

/** Places the container stacks and props of the main yard. */
export function placeYardProps(kit: LevelKit): void {
  const place = kit.place;
  const stack = kit.stack;
  stack(-19.45, -5.12, [
    [20, 'green'],
    [20, 'grey'],
    [20, 'orange']
  ]);
  stack(-13.3, -5.12, [
    [
      20,
      'white',
      {
        reefer: true,
        flip: true
      }
    ]
  ]);
  stack(3.7, -5.12, [
    [
      20,
      'blue',
      {
        doors: 0.8,
        flip: true
      }
    ],
    [20, 'white']
  ]);
  stack(13.53, -5.12, [
    [20, 'teal'],
    [20, 'grey']
  ]);
  stack(-19.45, 2.08, [[20, 'blue']]);
  stack(-13.35, 2.08, [[20, 'red']]);
  stack(0.8, 2.08, [
    [40, 'orange'],
    [40, 'teal'],
    [
      20,
      'blue',
      {
        dx: 3
      }
    ]
  ]);
  stack(12.3, 2.08, [
    [20, 'red'],
    [20, 'yellow']
  ]);
  stack(-21.1, 9.92, [[20, 'yellow']], 0, 0.3);
  stack(
    -13.6,
    9.92,
    [
      [20, 'green'],
      [20, 'blue'],
      [20, 'orange']
    ],
    0,
    0.3
  );
  stack(
    -21.6,
    12.42,
    [
      [20, 'red'],
      [20, 'white'],
      [20, 'teal']
    ],
    0,
    0.3
  );
  stack(
    -15.4,
    12.42,
    [
      [
        20,
        'grey',
        {
          doors: 0.6
        }
      ]
    ],
    0,
    0.3
  );
  stack(4.43, 12.42, [[20, 'blue']], 0, 0);
  stack(13.53, 12.42, [[20, 'green']], 0, 0);
  kit.stairs(-0.1, 12.42, 0, 0, {
    seed: 9
  });
  kit.catwalk(8.98, 12.42, 0, 2.54, {
    seed: 10
  });
  for (const x of [7.6, 10.36])
    for (const z of [11.86, 12.98]) kit.rod('steel_galv', [x, 0, z], [x, 2.5, z], 0.035);
  place(
    'sandbags',
    15.95,
    12.42,
    HALF_PI,
    {
      seed: 61
    },
    2.59
  );
  place(
    'crate_wood',
    14.3,
    11.75,
    0.1,
    {
      seed: 62
    },
    2.59
  );
  place(
    'sandbags',
    2.3,
    11.75,
    0,
    {
      seed: 63
    },
    2.59
  );
  stack(-16.4, 20.12, [
    [40, 'grey'],
    [40, 'green']
  ]);
  stack(-2.25, 20.12, [[20, 'red']]);
  stack(3.85, 20.12, [
    [20, 'white'],
    [20, 'blue']
  ]);
  stack(13.53, 20.12, [
    [20, 'orange'],
    [20, 'teal'],
    [20, 'red']
  ]);
  stack(-16.4, 22.62, [
    ['hc', 'teal'],
    [40, 'yellow'],
    [40, 'blue']
  ]);
  stack(0.8, 22.62, [
    [40, 'green'],
    ['hc', 'orange']
  ]);
  stack(13.53, 22.62, [
    [
      20,
      'grey',
      {
        doors: 0.4
      }
    ]
  ]);
  stack(
    -22.6,
    -19.2,
    [
      [40, 'red'],
      [40, 'white']
    ],
    HALF_PI
  );
  stack(
    -30.2,
    -18.4,
    [
      [
        20,
        'yellow',
        {
          doors: 0.5
        }
      ]
    ],
    0.35,
    0
  );
  stack(-31.2, 24.7, [
    [40, 'teal'],
    [40, 'orange']
  ]);
  for (const [x, z] of [
    [-23.4, 0.5],
    [-23.4, 21.4],
    [17, -8.7],
    [17, 18.6],
    [-20.6, -11.6]
  ])
    place('light_mast', x, z, 0, {
      seed: Math.round(x * 3 + z)
    });
  /** Overhead cable sagging (parabolically) by `sag` between two points. */
  const hangCable = (from: number[], to: number[], sag: number, radius = 0.018): void => {
    const points: number[][] = [];
    for (let step = 0; step <= 8; step++) {
      const t = step / 8;
      points.push([
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t - sag * 4 * t * (1 - t),
        from[2] + (to[2] - from[2]) * t
      ]);
    }
    kit.tube('rubber', points, radius, {
      radial: 5,
      tension: 0.5
    });
  };
  hangCable([-23.4, 12.4, 0.5], [-20.6, 12.4, -11.6], 1.3);
  hangCable([-20.6, 11.8, -11.6], [-16.2, 7.25, -11.4], 0.9);
  hangCable([-23.4, 12, 0.5], [-27.6, 12.2, -0.9], 0.5);
  hangCable([17, 12.4, -8.7], [12.3, 7.3, -11.3], 1);
  placeRebarBundle(kit, -20.9, 8.3, 0.02);
  placeWheelChock(kit, -18.6, 3.75, 1.7);
  placeWheelChock(kit, 0.4, 13.3, 0.3);
  place('barrel', -19.6, 3.85, 0, {
    seed: 1,
    color: 'blue'
  });
  place('barrel', -18.9, 3.95, 0.7, {
    seed: 2,
    color: 'blue'
  });
  place('pallet_stack', -17.4, 4, 0.08, {
    seed: 3
  });
  place('crate_stack', -14.3, 8.05, 0.04, {
    seed: 4
  });
  place('ibc_tote', -12.95, 7.95, -0.05, {
    seed: 5
  });
  // Forklift carrying a pallet with a crate on its raised forks.
  {
    const forwardX = Math.cos(-0.22);
    const forwardZ = -Math.sin(-0.22);
    place('forklift', -8.6, 4.5, -0.22, {
      seed: 6,
      forksUp: 0.3
    });
    const palletX = -8.6 + forwardX * 1.42;
    const palletZ = 4.5 + forwardZ * 1.42;
    place(
      'pallet',
      palletX,
      palletZ,
      -0.22,
      {
        seed: 7
      },
      FORKLIFT_PALLET_Y,
      {
        noCol: true
      }
    );
    place(
      'crate_wood',
      palletX,
      palletZ,
      -0.22 + 0.05,
      {
        seed: 8
      },
      FORKLIFT_PALLET_Y + 0.144,
      {
        noCol: true
      }
    );
    kit.col(
      palletX - 0.62,
      FORKLIFT_PALLET_Y - 0.1,
      palletZ - 0.62,
      palletX + 0.62,
      FORKLIFT_PALLET_Y + 1.15,
      palletZ + 0.62,
      'wood'
    );
    placeWheelChock(kit, -8.6 - 1, 4.5 + 0.78, 0.2);
    placeWheelChock(kit, -11.9, 3.6, 2.4);
  }
  place('jersey_barrier', -2.9, 5.3, 0.12, {
    seed: 11
  });
  place('jersey_barrier', 5.6, 5, -0.1, {
    seed: 12
  });
  place('sandbags', -1.7, 9.7, 0.5, {
    seed: 13
  });
  place('ibc_tote', 5.9, 8.9, 0.1, {
    seed: 14
  });
  place('ibc_tote', 5.95, 10.05, -0.05, {
    seed: 15
  });
  place('barrel', 4.9, 9.7, 0, {
    seed: 16,
    color: 'red'
  });
  place('crate_stack', -3.9, 10.5, 0.1, {
    seed: 17
  });
  place('crate_wood', -3.8, 9.35, -0.2, {
    seed: 18
  });
  place('pallet_stack', -4.4, 11.8, 0.02, {
    seed: 19
  });
  place('cable_reel', 4.2, 10.5, 0.3, {
    seed: 20
  });
  place('tarp_cargo', 12.9, 10, 0.04, {
    seed: 21
  });
  place('jersey_barrier', 11.6, 3.95, 0.03, {
    seed: 81
  });
  place('ibc_tote', 15.2, 10.2, 0.1, {
    seed: 82
  });
  for (const [x, z] of [
    [0.2, 6.3],
    [2.9, 6.4],
    [2.9, 8.8],
    [0.1, 8.7]
  ])
    place('traffic_cone', x, z, 0, {
      seed: Math.round(x * 9 + z * 5)
    });
  placeScrapSkip(kit, -9.55, 9.3, 0.04);
  placeRebarBundle(kit, -7.6, 11.9, HALF_PI + 0.06);
  placeScrapSkip(kit, 9.9, 12.9, HALF_PI, 'paint_blue');
  place('sign_post', -4.8, 3.72, HALF_PI, {
    seed: 22,
    sign: 'hazard_voltage'
  });
  placePowerPedestal(kit, 0.9, 3.62, 0);
  layGroundCable(
    kit,
    [
      [0.9, 3.9],
      [1.2, 5.2],
      [0.8, 6.2],
      [1.5, 7.1]
    ],
    0.03
  );
  place('tarp_cargo', -13.5, -3.1, 0.05, {
    seed: 23
  });
  place('pallet_stack', -20.6, -0.1, 0.2, {
    seed: 24
  });
  place('tire_stack', -9.6, 0.2, 0, {
    seed: 25
  });
  place('barrel', 4.5, 0.35, 0, {
    seed: 26,
    color: 'yellow'
  });
  place('barrel', 5.2, 0.3, 0.4, {
    seed: 27
  });
  place('jersey_barrier', 12.2, 0.4, 0.03, {
    seed: 28
  });
  place('crate_wood', 11.2, -3.3, 0.3, {
    seed: 29
  });
  place('cardboard_boxes', -2, 0.3, 0.2, {
    seed: 30
  });
  placeScrapCage(kit, -4.2, -3.2, 0.03, 'paint_orange', 3);
  place('jersey_barrier', -0.9, -7.5, 0.1, {
    seed: 31
  });
  place('sandbags', -6.7, -7.8, -0.1, {
    seed: 32
  });
  place('dumpster', -12.3, -7.05, 0, {
    seed: 33
  });
  place('gas_cylinders', 9.6, -10.45, 0, {
    seed: 34
  });
  place('pallet_stack', 1.2, -9.9, 0.1, {
    seed: 35
  });
  place('barrel', 2.2, -10.3, 0, {
    seed: 36,
    color: 'green'
  });
  place('cable_reel', -18.2, -8, 0.2, {
    seed: 37
  });
  place('traffic_cone', -6.5, -9.9, 0, {
    seed: 38
  });
  place('traffic_cone', -0.5, -9.9, 0, {
    seed: 39
  });
  layGroundCable(
    kit,
    [
      [4.6, -10.9, 0.5],
      [4.7, -10.6, 0.05],
      [4.2, -9.2],
      [1, -8.4],
      [-2.6, -9.1],
      [-4.6, -6.4],
      [-5.9, -5.9]
    ],
    0.024
  );
  place('pipe_stack', -16, 14.4, 0, {
    seed: 41
  });
  place('crate_stack', -10.95, 18.25, 0.06, {
    seed: 42
  });
  place('barrel', -3, 18.35, 0, {
    seed: 43,
    color: 'blue'
  });
  place('dumpster', 4.2, 14.55, 0.02, {
    seed: 44
  });
  place('tire_stack', 10.95, 18.3, 0, {
    seed: 45
  });
  place('ibc_tote', 12, 18.25, 0, {
    seed: 46
  });
  place('pallet_stack', -12.3, 18.2, 0.1, {
    seed: 47
  });
  place('tarp_cargo', -20.5, 18.05, 0.03, {
    seed: 48
  });
  place('jersey_barrier', 0.6, 15.5, 0.12, {
    seed: 49
  });
  place('tire_stack', -8, 26.9, 0, {
    seed: 51
  });
  place('pallet_stack', 8.7, 27, 0.3, {
    seed: 52
  });
  place('crate_wood', -2, 27, 0.2, {
    seed: 53
  });
  place('barrel', 11.2, 27.1, 0, {
    seed: 54
  });
  place('cardboard_boxes', -21, 26.9, 0.4, {
    seed: 55
  });
  placeScrapSkip(kit, 16, 26.9, 0.1);
  place('pipe_stack', -30.5, -27, 0.03, {
    seed: 56
  });
  place('pipe_stack', -30.2, -25.4, -0.02, {
    seed: 57
  });
  place('dumpster', -17, -14, HALF_PI, {
    seed: 58
  });
  place('tarp_cargo', -27.5, -11.6, 0.3, {
    seed: 59
  });
  place('tarp_cargo', -29.9, -11, -0.2, {
    seed: 60
  });
  place('cable_reel', -34.6, -22.5, 1, {
    seed: 64
  });
  place('tire_stack', -25.4, -26.9, 0, {
    seed: 65
  });
  place('gas_cylinders', -16.9, -20.4, HALF_PI, {
    seed: 66
  });
  place('crate_stack', -34.8, -13.5, 0.2, {
    seed: 67
  });
  place('barrel', -33.6, -13, 0, {
    seed: 68
  });
  placeScrapCage(kit, -36.6, -26, HALF_PI, 'paint_blue', 4);
  place('generator', -34.2, 14.2, 0.15, {
    seed: 71
  });
  place('floodlight_stand', -31.4, 12.7, 0.55, {
    seed: 72
  });
  layGroundCable(
    kit,
    [
      [-33.2, 14],
      [-32.4, 13.2],
      [-31.6, 12.9]
    ],
    0.02
  );
  place('tire_stack', -36.6, 17.2, 0, {
    seed: 73
  });
  place('tire_stack', -36.5, 18.3, 0.6, {
    seed: 74
  });
  place('dumpster', -36.4, 21, HALF_PI, {
    seed: 75
  });
  place('pallet_stack', -27.8, 16.6, 0.4, {
    seed: 76
  });
  place('jerry_can', -33, 15.2, 0.4, {
    seed: 77
  });
  place('jerry_can', -33.3, 15.35, 1.9, {
    seed: 78
  });
  place('crate_wood', -28.6, 20.6, 0.1, {
    seed: 79
  });
  place('ibc_tote', -26.6, 21.2, 0, {
    seed: 80
  });
  placeLaneSign(kit, -22.9, -3.62, 'LANE 1', 'x-');
  placeLaneSign(kit, -22.95, 3.62, 'LANE 2', 'x-');
  placeLaneSign(kit, -25, 14, 'LANE 3', 'x-');
  placeLaneSign(kit, 16.9, 9.5, 'LANE 2', 'x+');
  kit.label('BERTH 4 WORKSHOP', 0.55, 4.2, 4.3, SHED.Z1 + 0.064, 'z+', {
    color: 'white',
    font: 'stencil',
    distress: 0.45
  });
  kit.decal('berth4', 3.2, -12, 3.4, SHED.Z1 + 0.064, 'z+');
  kit.decal('rust_run', 1, 9, 3.2, SHED.Z1 + 0.064, 'z+');
  kit.decal('grime_streak', 1.2, -14, 3.9, SHED.Z1 + 0.064, 'z+');
}
/** Builds the yard's perimeter fence, the entrance gate and the gatehouse area props. */
export function buildPerimeterFence(kit: LevelKit): void {
  const place = kit.place;
  const xMin = -38;
  const xMax = 30;
  const zMin = -30;
  const zMax = 28;
  const gateZ0 = 2;
  const gateZ1 = 8;
  /** One straight fence run of panels from (x0, z0) to (x1, z1), plus its colliders. */
  function fenceRun(x0: number, z0: number, x1: number, z1: number, seed: number): void {
    const length = Math.hypot(x1 - x0, z1 - z0);
    const panels = Math.max(1, Math.round(length / 3.35));
    const panelScale = length / (panels * 3);
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    for (let index = 0; index < panels; index++) {
      const t = (index + 0.5) / panels;
      const panel = place(
        'fence_panel',
        x0 + (x1 - x0) * t,
        z0 + (z1 - z0) * t,
        alongX ? 0 : HALF_PI,
        {
          seed: seed + index,
          posts: index === panels - 1 ? 'both' : 'left'
        },
        0,
        {
          noCol: true
        }
      );
      panel.scale.x = panelScale;
    }
    kit.col(
      Math.min(x0, x1) - 0.05,
      0,
      Math.min(z0, z1) - 0.05,
      Math.max(x0, x1) + 0.05,
      2.4,
      Math.max(z0, z1) + 0.05,
      'metal'
    );
    kit.col(
      Math.min(x0, x1) - 0.3,
      0,
      Math.min(z0, z1) - 0.3,
      Math.max(x0, x1) + 0.3,
      7,
      Math.max(z0, z1) + 0.3,
      'metal',
      {
        playerOnly: true
      }
    );
  }
  fenceRun(xMin, zMin, xMax, zMin, 100);
  fenceRun(xMin, zMax, xMax, zMax, 200);
  fenceRun(xMin, zMin, xMin, gateZ0, 300);
  fenceRun(xMin, gateZ1, xMin, zMax, 400);
  // Gate posts.
  for (const postZ of [gateZ0 - 0.1, gateZ1 + 0.1]) {
    kit.box('steel_dark', 0.22, 3.4, 0.22, xMin, 1.7, postZ, {
      bevel: 0.02
    });
    kit.box('hazard_stripes', 0.26, 1.2, 0.26, xMin, 0.6, postZ, {
      bevel: 0.02
    });
    kit.col(xMin - 0.13, 0, postZ - 0.13, xMin + 0.13, 3.4, postZ + 0.13, 'metal');
  }
  // Pedestrian side gate.
  {
    const gateZ = gateZ1 + 3.3;
    const gateX = xMin + 0.28;
    kit.box('chainlink', 0.012, 2.1, 6, gateX, 1.25, gateZ);
    for (const z of [gateZ - 3, gateZ, gateZ + 3])
      kit.box('steel_galv', 0.06, 2.2, 0.06, gateX, 1.25, z);
    for (const y of [0.18, 2.32, 1.25]) kit.box('steel_galv', 0.06, 0.06, 6.06, gateX, y, gateZ);
    kit.rod('steel_galv', [gateX, 0.2, gateZ - 3], [gateX, 2.3, gateZ], 0.018);
    kit.rod('steel_galv', [gateX, 0.2, gateZ + 3], [gateX, 2.3, gateZ], 0.018);
    kit.slab('steel_dark', gateX - 0.05, 0, gateZ0 - 0.3, gateX + 0.05, 0.03, gateZ + 3.2, {
      cast: false
    });
    for (const z of [gateZ - 2.4, gateZ + 2.4])
      kit.cyl('rubber', 0.09, 0.05, gateX, 0.1, z, {
        axis: 'x',
        seg: 10
      });
  }
  kit.col(xMin - 0.4, 0, gateZ0, xMin - 0.1, 7, gateZ1, 'metal', {
    playerOnly: true
  });
  place('guard_booth', -35.2, 0.35, 0, {
    seed: 1
  });
  place('gate_arm', -36.3, 5, HALF_PI, {
    seed: 2
  });
  for (const [x, z] of [
    [-37, 1.75],
    [-34.4, 2.3],
    [-37, 8.3],
    [-35.6, 8.9],
    [-34.4, 9.9],
    [-33.5, -1.1]
  ])
    place('bollard_post', x, z, 0, {
      seed: Math.round(x * 11 + z * 7)
    });
  place('jersey_barrier', -34.7, 3.75, HALF_PI + 0.08, {
    seed: 3
  });
  place('jersey_barrier', -33.3, 8.3, HALF_PI - 0.06, {
    seed: 4
  });
  place('jersey_barrier', -30.6, 10.4, 0.03, {
    seed: 5
  });
  place('jersey_barrier', -27.3, 1.45, 0.05, {
    seed: 6
  });
  place('jersey_barrier', -32.2, 1.45, -0.04, {
    seed: 7
  });
  place('sign_post', -33.2, 9.6, HALF_PI, {
    seed: 8,
    sign: 'no_entry'
  });
  place('sign_post', -25.3, 1.1, HALF_PI, {
    seed: 9,
    sign: 'berth4'
  });
  place('sign_post', -36.6, -1.6, HALF_PI, {
    seed: 10,
    sign: 'hazard_general'
  });
  for (const [x, z] of [
    [-34.6, 5.6],
    [-28.3, 2],
    [-33.2, 6.5],
    [-26.6, 9.8],
    [-31.8, 9.9]
  ])
    place('traffic_cone', x, z, 0, {
      seed: Math.round(x * 5 + z * 3)
    });
  place('light_mast', -27.6, -0.9, 0, {
    seed: 11
  });
  place('light_mast', -36.3, 12.4, 0, {
    seed: 12
  });
  place('barrel', -33.9, 2, 0, {
    seed: 13,
    color: 'yellow'
  });
  place('pallet_stack', -36.4, 10.3, 0.2, {
    seed: 14
  });
  kit.decal('no_entry', 0.7, xMin + 0.34, 1.5, gateZ1 + 3.3, 'x+');
  kit.decal('arrow', 2.2, -30.5, 0.006, 6, 'y+', 0);
}
