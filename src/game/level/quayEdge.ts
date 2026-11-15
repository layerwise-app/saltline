/**
 * The quay edge along the water (east side): concrete coping, the boat-station
 * ladder (extraction point), fenders and tyres, mooring bollards, curb runs,
 * crane rails, and the props scattered over the quay apron.
 */
import { TorusGeometry, Vector3 } from 'three';
import type { LevelKit } from './kit';
import {
  layGroundCable,
  placeHatchCoverStack,
  placeRebarBundle,
  placeScrapCage,
  placeScrapSkip,
  placeWheelChock
} from './structures';

const QUAY_EDGE = {
  /** X of the quay edge (water beyond). */
  X: 30,
  /** Z of the boat-station ladder. */
  LADDER_Z: 20,
  /** X positions of the two crane rails. */
  RAILS: [18.5, 28.5],
  Z0: -30,
  Z1: 28
};

/** Positions produced by {@link buildQuayEdge}. */
export interface QuayEdgeBuild {
  relayPos: Vector3;
  /** Extraction point at the top of the boat-station ladder. */
  extraction: Vector3;
}

/** Builds the quay edge and its props. */
export function buildQuayEdge(kit: LevelKit): QuayEdgeBuild {
  const { M: mat, box, slab, cyl, rod, tube, col, add, place } = kit;
  const { X: edgeX, LADDER_Z: ladderZ, Z0: z0, Z1: z1 } = QUAY_EDGE;
  const concrete = mat('concrete');
  const concreteDirty = mat('concrete_dirty');
  const steelWorn = mat('steel_worn');
  const steelDark = mat('steel_dark');
  const steelGalv = mat('steel_galv');
  const paintYellow = mat('paint_yellow');
  // Gap in the coping where the ladder comes up.
  const gapZ0 = ladderZ - 0.42;
  const gapZ1 = ladderZ + 0.42;
  // Coping (top slab, steel nosing, yellow edge line, quay wall face) either side of the gap.
  for (const [from, to] of [
    [z0 - 1, gapZ0],
    [gapZ1, z1 + 1]
  ]) {
    slab(concrete, edgeX - 0.65, -0.7, from, edgeX, 0.028, to, {
      bevel: 0.03
    });
    slab(steelWorn, edgeX - 0.07, -0.16, from, edgeX + 0.022, 0.036, to, {
      bevel: 0.012
    });
    slab(paintYellow, edgeX - 0.66, 0, from, edgeX - 0.5, 0.032, to);
    slab(concreteDirty, edgeX - 0.55, -4.2, from, edgeX - 0.02, -0.7, to);
  }
  slab(concrete, edgeX - 0.65, -0.7, gapZ0, edgeX - 0.38, 0.028, gapZ1);
  slab(concreteDirty, edgeX - 0.55, -4.2, gapZ0, edgeX - 0.38, -0.7, gapZ1);
  for (const z of [gapZ0, gapZ1])
    slab(steelWorn, edgeX - 0.38, -0.16, z - 0.02, edgeX + 0.02, 0.034, z + 0.02);
  // Vertical steel strips with rust streaks down the quay wall.
  for (let z = z0 + 4; z < z1; z += 6) {
    if (Math.abs(z - ladderZ) < 1) continue;
    slab(steelDark, edgeX - 0.03, -4.2, z - 0.02, edgeX - 0.012, -0.2, z + 0.02, {
      cast: false
    });
    kit.decal('rust_run', 0.7, edgeX - 0.015, -1.3, z + 1.4, 'x+');
  }
  col(edgeX - 0.65, -4.2, z0 - 1, edgeX, 0.028, z1 + 1, 'concrete', {
    noNav: true
  });
  col(edgeX + 0.03, -5, z0 - 2, edgeX + 0.7, 8, z1 + 2, 'concrete', {
    playerOnly: true
  });
  // Boat-station ladder with grab rails, rungs and a short chain barrier.
  {
    const ladderX = edgeX - 0.12;
    for (const side of [-1, 1]) {
      const railZ = ladderZ + side * 0.26;
      tube(
        mat('paint_yellow'),
        [
          [ladderX, -3.9, railZ],
          [ladderX, 0.2, railZ],
          [ladderX, 0.95, railZ],
          [ladderX - 0.12, 1.12, railZ],
          [ladderX - 0.5, 1.12, railZ],
          [ladderX - 0.62, 0.95, railZ],
          [ladderX - 0.62, 0.03, railZ]
        ],
        0.024,
        {
          radial: 7,
          tension: 0.2
        }
      );
      box(steelDark, 0.12, 0.012, 0.12, ladderX - 0.62, 0.034, railZ);
    }
    for (let y = -3.7; y < 0; y += 0.3)
      rod(steelGalv, [ladderX, y, ladderZ - 0.26], [ladderX, y, ladderZ + 0.26], 0.014, {
        seg: 6
      });
    for (const y of [-3, -1.6, -0.3])
      for (const side of [-1, 1])
        rod(
          steelGalv,
          [ladderX, y, ladderZ + side * 0.26],
          [edgeX - 0.38, y, ladderZ + side * 0.26],
          0.012
        );
    const postZs = [[ladderZ - 2.6], [ladderZ - 0.9], [ladderZ + 0.9], [ladderZ + 2.6]];
    for (const [postZ] of postZs) {
      cyl(paintYellow, 0.032, 1.05, edgeX - 0.82, 0.525, postZ, {
        seg: 8
      });
      cyl(steelDark, 0.09, 0.02, edgeX - 0.82, 0.01, postZ, {
        seg: 10
      });
      cyl(steelDark, 0.045, 0.03, edgeX - 0.82, 1.06, postZ, {
        seg: 8
      });
    }
    for (const [fromZ, toZ] of [
      [ladderZ - 2.6, ladderZ - 0.9],
      [ladderZ + 0.9, ladderZ + 2.6]
    ])
      for (const y of [0.98, 0.55])
        tube(
          steelGalv,
          [
            [edgeX - 0.82, y, fromZ],
            [edgeX - 0.82, y - 0.1, (fromZ + toZ) / 2 - 0.3],
            [edgeX - 0.82, y - 0.12, (fromZ + toZ) / 2 + 0.3],
            [edgeX - 0.82, y, toZ]
          ],
          0.012,
          {
            radial: 5
          }
        );
    kit.label('BOAT STN 4', 0.2, edgeX - 1.3, 0.006, ladderZ - 1.4, 'y+', {
      color: 'yellow',
      font: 'stencil',
      distress: 0.4
    });
  }
  // Timber fenders with steel straps, and hanging tyres between them.
  const tyreGeometry = new TorusGeometry(0.4, 0.16, 8, 16);
  tyreGeometry.rotateY(Math.PI / 2);
  for (let z = z0 + 2.5, index = 0; z < z1; z += 5, index++) {
    if (Math.abs(z - ladderZ) < 2) continue;
    slab(mat('wood_dark'), edgeX + 0, -3.9, z - 0.16, edgeX + 0.2, -0.25, z + 0.16, {
      bevel: 0.02
    });
    slab(steelDark, edgeX - 0.01, -0.5, z - 0.2, edgeX + 0.215, -0.42, z + 0.2);
    slab(steelDark, edgeX - 0.01, -2.4, z - 0.2, edgeX + 0.215, -2.32, z + 0.2);
    const tyreZ = z + 2.4;
    if (Math.abs(tyreZ - ladderZ) < 1.6 || tyreZ > z1 - 0.5) continue;
    const tyreY = -0.85 - (index % 3) * 0.18;
    add(tyreGeometry.clone(), mat('tire'), {
      p: [edgeX + 0.17, tyreY, tyreZ]
    });
    if (index % 2)
      add(tyreGeometry.clone(), mat('tire'), {
        p: [edgeX + 0.17, tyreY - 0.86, tyreZ + 0.05]
      });
    for (const side of [-1, 1])
      rod(
        steelGalv,
        [edgeX - 0.02, 0.02, tyreZ + side * 0.3],
        [edgeX + 0.17, tyreY + 0.36, tyreZ + side * 0.16],
        0.011,
        {
          seg: 5
        }
      );
    box(steelDark, 0.1, 0.03, 0.8, edgeX - 0.06, 0.04, tyreZ);
  }
  const bollardZs = [-22, -12, -2, 9, 16.4, 25.6];
  for (const z of bollardZs)
    place('bollard_mooring', 29.2, z, 0, {
      seed: Math.round(z + 40)
    });
  // Yellow curb along the edge, interrupted at the bollards and the ladder.
  {
    const gaps = [...bollardZs.map((z) => [z - 1.1, z + 1.1]), [ladderZ - 3, ladderZ + 3]].sort(
      (a, b) => a[0] - b[0]
    );
    let runStart = z0 + 0.3;
    for (const [gapStart, gapEnd] of [...gaps, [z1 - 0.3, z1]]) {
      if (gapStart - runStart > 1) {
        slab(paintYellow, edgeX - 0.4, 0.12, runStart, edgeX - 0.2, 0.3, gapStart, {
          bevel: 0.02
        });
        for (let z = runStart + 0.3; z < gapStart; z += 1.6)
          slab(steelDark, edgeX - 0.42, 0.028, z - 0.12, edgeX - 0.18, 0.12, z + 0.12);
      }
      runStart = Math.max(runStart, gapEnd);
    }
  }
  // Crane rails with clips and end stops.
  for (const railX of QUAY_EDGE.RAILS) {
    slab(steelDark, railX - 0.19, 0, z0 + 0.4, railX + 0.19, 0.007, z1 - 0.4, {
      cast: false
    });
    slab(mat('steel_rust'), railX - 0.075, 0, z0 + 0.4, railX + 0.075, 0.018, z1 - 0.4, {
      cast: false
    });
    slab(steelWorn, railX - 0.037, 0, z0 + 0.4, railX + 0.037, 0.034, z1 - 0.4, {
      bevel: 0.008,
      cast: false
    });
    for (let z = z0 + 0.8; z < z1 - 0.5; z += 0.9)
      for (const side of [-1, 1])
        box(steelDark, 0.07, 0.022, 0.1, railX + side * 0.115, 0.012, z, {
          cast: false
        });
    for (const [stopZ, facing] of [
      [z0 + 0.75, 1],
      [z1 - 0.75, -1]
    ]) {
      slab(paintYellow, railX - 0.28, 0, stopZ - 0.3, railX + 0.28, 0.75, stopZ + 0.3, {
        bevel: 0.03
      });
      slab(
        mat('rubber'),
        railX - 0.16,
        0.3,
        stopZ + facing * 0.3,
        railX + 0.16,
        0.62,
        stopZ + facing * 0.42,
        {
          bevel: 0.03
        }
      );
      slab(steelDark, railX - 0.34, 0, stopZ - 0.38, railX + 0.34, 0.04, stopZ + 0.38);
      col(railX - 0.28, 0, stopZ - 0.36, railX + 0.28, 0.75, stopZ + 0.36, 'metal');
    }
  }
  // Props on the quay apron.
  placeHatchCoverStack(kit, 23.3, -15.4, 2, true, 0.02);
  placeHatchCoverStack(kit, 23.7, 14.4, 2, true, -0.025);
  place('jersey_barrier', 20.5, -4.7, Math.PI / 2 + 0.12, {
    seed: 31
  });
  place('jersey_barrier', 25.3, 3.1, -0.2, {
    seed: 32
  });
  placeScrapCage(kit, 25.7, -3.3, 0.08, 'paint_blue', 2);
  place('sandbags', 20.6, 3, 1.25, {
    seed: 33
  });
  place('barrel', 26.5, -1.7, 0, {
    seed: 34,
    color: 'red'
  });
  place('barrel', 26.9, -1.05, 0.5, {
    seed: 35
  });
  placeScrapSkip(kit, 20.55, 1.35, 0.12);
  place('traffic_cone', 22, -1.9, 0, {
    seed: 36
  });
  place('traffic_cone', 24.2, 1.7, 0, {
    seed: 37
  });
  kit.stack(23.2, -28.6, [
    [
      20,
      'white',
      {
        reefer: true
      }
    ],
    [
      20,
      'white',
      {
        reefer: true
      }
    ]
  ]);
  kit.stack(23, -25.95, [
    [
      20,
      'grey',
      {
        reefer: true
      }
    ]
  ]);
  place('generator', 15, -26.6, 0.06, {
    seed: 41
  });
  place('floodlight_stand', 16.4, -23.6, 0.3, {
    seed: 42
  });
  layGroundCable(
    kit,
    [
      [16.1, -26.6],
      [18, -27.6],
      [19.2, -27.2],
      [19.6, -26.4]
    ],
    0.028
  );
  layGroundCable(
    kit,
    [
      [15.6, -26],
      [16.2, -24.6],
      [16.4, -23.9]
    ],
    0.018
  );
  placeScrapCage(kit, 27, -18.1, Math.PI / 2 + 0.05, 'paint_orange', 5);
  place('tire_stack', 24.1, -9.5, 0, {
    seed: 43
  });
  place('tire_stack', 25.05, -9.6, 0.5, {
    seed: 44
  });
  place('cable_reel', 14.3, -12.9, 0.4, {
    seed: 45
  });
  place('cable_reel', 15.6, -14.3, 1.9, {
    seed: 46
  });
  place('pallet_stack', 20.3, -9.3, 0.1, {
    seed: 47
  });
  place('crate_wood', 19.9, -22.6, 0.3, {
    seed: 48
  });
  place('barrel', 12.75, -23.3, 0, {
    seed: 49,
    color: 'blue'
  });
  place('barrel', 12.9, -24.1, 0, {
    seed: 50,
    color: 'blue'
  });
  place('light_mast', 26.6, -28.7, 0, {
    seed: 51
  });
  place('light_mast', 26.6, 26.7, 0, {
    seed: 52
  });
  placeScrapCage(kit, 20.6, 22.4, 0.04, 'paint_blue', 7);
  placeScrapCage(kit, 20.7, 24.2, -0.06, 'paint_orange', 9);
  placeScrapSkip(kit, 26.6, 5.5, 0.1);
  placeScrapSkip(kit, 26.7, 6.45, -0.15, 'paint_blue');
  place('crate_stack', 26.4, 23.6, 0.2, {
    seed: 53
  });
  place('ibc_tote', 22.6, 26.3, 0.05, {
    seed: 54
  });
  place('pallet_stack', 24, 26.2, 0.2, {
    seed: 55
  });
  place('barrel', 22.6, 20.3, 0, {
    seed: 56,
    color: 'yellow'
  });
  place('barrel', 23.4, 20.4, 0, {
    seed: 57
  });
  place('tarp_cargo', 20.3, 12.6, Math.PI / 2, {
    seed: 59
  });
  placeRebarBundle(kit, 19.6, 17.5, Math.PI / 2 + 0.05);
  placeWheelChock(kit, 19.6, 10.4, 0.4);
  placeWheelChock(kit, 20.5, 16.1, -2.6);
  place('traffic_cone', 28.2, 18.2, 0, {
    seed: 60
  });
  place('traffic_cone', 28.3, 21.8, 0, {
    seed: 61
  });
  layGroundCable(
    kit,
    [
      [28.9, 6.2],
      [28.6, 9.5],
      [28.95, 13],
      [28.7, 16.6],
      [28.3, 17.4],
      [28.6, 17.9],
      [28.9, 17.3]
    ],
    0.022
  );
  return {
    relayPos: new Vector3(23, 0, 0),
    extraction: new Vector3(29, 0, ladderZ)
  };
}
