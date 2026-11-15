// Distant harbour skyline, batched into one unlit-ish mesh: container yard stacks, yard
// gantries, light towers, radio masts, warehouses, a second quay crane plus distant crane
// silhouettes, moored ships, breakwater, lighthouse and the far industrial shore. Also the
// GPU-animated gull flock.
import type { Group, IUniform } from 'three';
import type { Game } from '../core/types';
import type { BatchGeometry, BlinkLightBatch, Rgb } from './geometry';
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial
} from 'three';
import { setVertexColors } from '../render/geometry';
import {
  MaterialBatcher,
  beamBetween,
  boxBetween,
  createLcgRng,
  cylinderAt,
  railingAlong,
  rodBetween,
  valueNoise3,
  weatheredMaterial
} from './geometry';
import { addDistantCraneSilhouette, beaconGeometry, buildQuayCrane } from './cranes';
import {
  CONTAINER_TINTS,
  DISTANT_CONTAINER_COLORS,
  containerTint,
  skylineDistanceShade,
  smoothstepRange
} from './ships';
/** The batched skyline mesh. */
export interface Skyline {
  root: Group;
  tris: number;
}

/** Options for a run of yard container rows. */
interface ContainerRowOptions {
  /** Restrict open ends to one z direction (+1/-1), or 0 for both. */
  faceZ?: number;
  /** Add corrugation ribs on visible end walls near the play area. */
  ribs?: boolean;
  /** Number of slots (from the start) whose east doors get door detail. */
  doorRows?: number;
  /** Skip west faces (row is backed by another). */
  west?: boolean;
}

interface ContainerSlot {
  z: number;
  blk: number;
  first: boolean;
}

/** Builds the skyline; its beacons go into `blinkLights`. Uses a fixed seed. */
export function buildSkyline(game: Game, blinkLights: BlinkLightBatch): Skyline {
  const batcher = new MaterialBatcher();
  // Small distant clutter (antennas, rails, roof boxes): hidden on low quality (see render/detail.ts).
  batcher.minorSize = 3;
  const whitePaint = weatheredMaterial(game, 'paint_white');
  const rng = createLcgRng(90417);
  const warmLight = [5.5, 4.3, 2.9];
  const redLight = [8, 0.45, 0.25];
  const scratchColor: number[] = [0, 0, 0];
  function skylineColor(tint: Rgb, x: number, y: number, z: number, shade = 1): number[] {
    const grime = valueNoise3(x * 0.23 + 1.3, y * 0.31, z * 0.23 + 7.7);
    const rustMask = valueNoise3(x * 1.9 + 4.1, 2.2, z * 1.9 + 9.3);
    const brightness = shade * (0.56 + 0.52 * grime) * (0.62 + 0.38 * smoothstepRange(0, 5, y));
    let red = tint[0] * brightness;
    let green = tint[1] * brightness;
    let blue = tint[2] * brightness;
    if (rustMask > 0.62) {
      const rust = Math.min(1, (rustMask - 0.62) / 0.3) * 0.55;
      red = red * (1 - rust) + 0.3 * rust * brightness;
      green = green * (1 - rust) + 0.15 * rust * brightness;
      blue = blue * (1 - rust) + 0.08 * rust * brightness;
    }
    scratchColor[0] = red;
    scratchColor[1] = green;
    scratchColor[2] = blue;
    return scratchColor;
  }
  const addShaded = (geometry: BatchGeometry, tint: Rgb): void => {
    if (!geometry) return;
    if (Array.isArray(geometry)) {
      for (const part of geometry) addShaded(part, tint);
      return;
    }
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    const centerX = (box.min.x + box.max.x) / 2;
    const centerZ = (box.min.z + box.max.z) / 2;
    if (centerX < 31) {
      const shade = skylineDistanceShade(centerX, centerZ);
      setVertexColors(geometry, (px: number, py: number, pz: number) =>
        skylineColor(tint, px, py, pz, shade)
      );
      batcher.add(whitePaint, geometry);
    } else batcher.add(whitePaint, geometry, tint);
  };
  const quadPositions: number[] = [];
  const quadNormals: number[] = [];
  const quadUvs: number[] = [];
  const quadColors: number[] = [];
  function pushQuad(corners: number[][], normal: Rgb, cornerColors: Rgb[]): void {
    const e1x = corners[1][0] - corners[0][0];
    const e1y = corners[1][1] - corners[0][1];
    const e1z = corners[1][2] - corners[0][2];
    const e2x = corners[3][0] - corners[0][0];
    const e2y = corners[3][1] - corners[0][1];
    const e2z = corners[3][2] - corners[0][2];
    const flipped =
      (e1y * e2z - e1z * e2y) * normal[0] +
        (e1z * e2x - e1x * e2z) * normal[1] +
        (e1x * e2y - e1y * e2x) * normal[2] <
      0;
    for (const idx of flipped ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) {
      const corner = corners[idx];
      quadPositions.push(corner[0], corner[1], corner[2]);
      quadNormals.push(normal[0], normal[1], normal[2]);
      quadColors.push(cornerColors[idx][0], cornerColors[idx][1], cornerColors[idx][2]);
      if (Math.abs(normal[0]) > 0.5) {
        quadUvs.push(corner[2], corner[1]);
      } else if (Math.abs(normal[1]) > 0.5) {
        quadUvs.push(corner[0], corner[2]);
      } else {
        quadUvs.push(corner[0], corner[1]);
      }
    }
  }
  const eastNormal = [0.866, -0.5, 0];
  const shadeCorners = (color: Rgb, corners: number[][], shade: number): number[][] =>
    corners.map((corner) => skylineColor(color, corner[0], corner[1], corner[2], shade).slice());
  /** Adds the box faces listed in `faces` ('E', 'W', 'S', 'N', 'T'op) as shaded quads. */
  function addBoxFaces(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    color: Rgb,
    faces: string,
    shade: number
  ): void {
    for (const face of faces) {
      let corners: number[][];
      let normal: Rgb;
      if (face === 'E') {
        corners = [
          [x1, y0, z1],
          [x1, y0, z0],
          [x1, y1, z0],
          [x1, y1, z1]
        ];
        normal = eastNormal;
      } else if (face === 'W') {
        corners = [
          [x0, y0, z0],
          [x0, y0, z1],
          [x0, y1, z1],
          [x0, y1, z0]
        ];
        normal = [-1, 0, 0];
      } else if (face === 'S') {
        corners = [
          [x0, y0, z1],
          [x1, y0, z1],
          [x1, y1, z1],
          [x0, y1, z1]
        ];
        normal = [0, 0, 1];
      } else if (face === 'N') {
        corners = [
          [x1, y0, z0],
          [x0, y0, z0],
          [x0, y1, z0],
          [x1, y1, z0]
        ];
        normal = [0, 0, -1];
      } else {
        corners = [
          [x0, y1, z1],
          [x1, y1, z1],
          [x1, y1, z0],
          [x0, y1, z0]
        ];
        normal = [0, 1, 0];
      }
      const colors = shadeCorners(
        color,
        corners,
        face === 'T' ? shade * 0.8 : face === 'E' ? shade * 0.92 : shade
      );
      if (y0 < 0.1 && face !== 'T')
        for (const k of [0, 1]) {
          colors[k][0] *= 0.62;
          colors[k][1] *= 0.62;
          colors[k][2] *= 0.62;
        }
      pushQuad(corners, normal, colors);
    }
  }
  /** Adds rows (at x = `rowXs`) of randomly stacked containers from `zStart` to `zEnd`. */
  function addContainerRows(
    rowXs: number[],
    zStart: number,
    zEnd: number,
    { faceZ = 0, ribs = false, doorRows = 0, west = false }: ContainerRowOptions = {}
  ): void {
    const dir = Math.sign(zEnd - zStart);
    const slots: ContainerSlot[] = [];
    for (let z = zStart, n = 1; dir > 0 ? z < zEnd : z > zEnd; z += dir * 2.62, n++)
      if (n % 8 >= 1 && n % 8 <= 5) {
        slots.push({
          z,
          blk: Math.floor(n / 8),
          first: n === 1
        });
      }
    const stackHeights = slots.map((slot, slotIdx) =>
      rowXs.map((rowX, rowIdx) => {
        const noise = valueNoise3(rowX * 0.04 + 3, 0.5, slot.z * 0.05 + 7);
        let height = Math.round(0.2 + noise * 5.4 + (rng() - 0.5) * 2.4);
        if (!slot.first && rng() < 0.07) {
          height = 0;
        }
        return Math.max(slot.first ? 2 : 0, Math.min(5, height));
      })
    );
    const heightAt = (slotIdx: number, rowIdx: number): number =>
      slotIdx >= 0 && slotIdx < slots.length && rowIdx >= 0 && rowIdx < rowXs.length
        ? stackHeights[slotIdx][rowIdx]
        : 0;
    slots.forEach((slot, slotIdx) =>
      rowXs.forEach((rowX, rowIdx) => {
        const stackHeight = stackHeights[slotIdx][rowIdx];
        const slotZ = slot.z;
        const shade = skylineDistanceShade(rowX, slotZ);
        const nearPlay = Math.max(Math.abs(rowX + 5) - 40, Math.abs(slotZ) - 30) < 55;
        const rowsAdjacent = (rowA: number, rowB: number): boolean =>
          rowA >= 0 &&
          rowB >= 0 &&
          rowA < rowXs.length &&
          rowB < rowXs.length &&
          Math.abs(rowXs[rowA] - rowXs[rowB]) < 12.8;
        for (let tier = 0; tier < stackHeight; tier++) {
          const tint = CONTAINER_TINTS[Math.floor(rng() * CONTAINER_TINTS.length)];
          const brightness = 0.6 + rng() * 0.4;
          const color = [tint[0] * brightness, tint[1] * brightness, tint[2] * brightness];
          const jitter = (rng() - 0.5) * 0.22;
          const tierY = tier * 2.6;
          const x0 = rowX - 6.095 + jitter;
          const x1 = rowX + 6.095 + jitter;
          const z0 = slotZ - 1.22;
          const z1 = slotZ + 1.22;
          let faces = tier === stackHeight - 1 ? 'T' : '';
          for (const side of faceZ ? [faceZ] : [-1, 1]) {
            const neighbourIdx = slotIdx + side * dir;
            if (
              !(
                neighbourIdx >= 0 &&
                neighbourIdx < slots.length &&
                slots[neighbourIdx].blk === slot.blk &&
                Math.abs(slots[neighbourIdx].z - slotZ) < 2.7
              ) ||
              heightAt(neighbourIdx, rowIdx) <= tier
            ) {
              faces += side > 0 ? 'S' : 'N';
            }
          }
          const openEast = !(
            rowsAdjacent(rowIdx - 1, rowIdx) && heightAt(slotIdx, rowIdx - 1) > tier
          );
          const openWest =
            !west && !(rowsAdjacent(rowIdx + 1, rowIdx) && heightAt(slotIdx, rowIdx + 1) > tier);
          if (openEast) {
            faces += 'E';
          }
          if (openWest) {
            faces += 'W';
          }
          addBoxFaces(x0, tierY, z0, x1, tierY + 2.59, z1, color, faces, shade);
          const darkColor = [color[0] * 0.45, color[1] * 0.45, color[2] * 0.45];
          const doorSides = slot.first
            ? faceZ
              ? [faceZ]
              : [-dir]
            : rowIdx === 0 && west && Math.abs(slotZ) < 42
              ? [-1, 1].filter((side) => faces.includes(side > 0 ? 'S' : 'N'))
              : [];
          if (ribs && nearPlay && doorSides.length) {
            const ribSides = doorSides;
            for (const face of ribSides) {
              const wallZ = face > 0 ? z1 : z0;
              const ribZ = wallZ + face * 0.04;
              const ribY0 = tierY + 0.15;
              const ribY1 = tierY + 2.45;
              const ribShade = [color[0] * 0.7, color[1] * 0.7, color[2] * 0.7];
              for (let ribX = x0 + 0.24; ribX < x1 - 0.3; ribX += 0.575) {
                let quad = [
                  [ribX, ribY0, wallZ],
                  [ribX + 0.07, ribY0, ribZ],
                  [ribX + 0.07, ribY1, ribZ],
                  [ribX, ribY1, wallZ]
                ];
                pushQuad(quad, [-0.5, 0, face * 0.87], shadeCorners(ribShade, quad, shade));
                quad = [
                  [ribX + 0.07, ribY0, ribZ],
                  [ribX + 0.2, ribY0, ribZ],
                  [ribX + 0.2, ribY1, ribZ],
                  [ribX + 0.07, ribY1, ribZ]
                ];
                pushQuad(quad, [0, 0, face], shadeCorners(color, quad, shade));
                quad = [
                  [ribX + 0.2, ribY0, ribZ],
                  [ribX + 0.27, ribY0, wallZ],
                  [ribX + 0.27, ribY1, wallZ],
                  [ribX + 0.2, ribY1, ribZ]
                ];
                pushQuad(quad, [0.42, -0.52, face * 0.74], shadeCorners(ribShade, quad, shade));
              }
              for (const [railY0, railY1] of [
                [tierY, ribY0],
                [ribY1, tierY + 2.59]
              ]) {
                const railZ = wallZ + face * 0.05;
                let railQuad = [
                  [x0, railY0, railZ],
                  [x1, railY0, railZ],
                  [x1, railY1, railZ],
                  [x0, railY1, railZ]
                ];
                pushQuad(railQuad, [0, 0, face], shadeCorners(darkColor, railQuad, shade));
                railQuad = [
                  [x0, railY1, wallZ],
                  [x1, railY1, wallZ],
                  [x1, railY1, railZ],
                  [x0, railY1, railZ]
                ];
                pushQuad(
                  railQuad,
                  [0, railY0 === tierY ? 1 : -1, 0],
                  shadeCorners(darkColor, railQuad, shade)
                );
              }
            }
          }
          if (openEast && rowIdx === 0 && slotIdx < doorRows) {
            const doorX = x1 + 0.03;
            const fittingX = x1 + 0.055;
            const doorY0 = tierY + 0.02;
            const doorY1 = tierY + 2.57;
            const frameColor = [color[0] * 0.55, color[1] * 0.55, color[2] * 0.55];
            const barColor = [0.34, 0.35, 0.36];
            const gapColor = [0.05, 0.05, 0.055];
            const addDoorPanel = (
              px: number,
              pz0: number,
              pz1: number,
              py0: number,
              py1: number,
              panelColor: Rgb
            ) => {
              const panelCorners = [
                [px, py0, pz1],
                [px, py0, pz0],
                [px, py1, pz0],
                [px, py1, pz1]
              ];
              const panelColors = shadeCorners(panelColor, panelCorners, shade);
              if (tierY < 0.1 && py0 < 0.3)
                for (const k of [0, 1]) {
                  panelColors[k][0] *= 0.62;
                  panelColors[k][1] *= 0.62;
                  panelColors[k][2] *= 0.62;
                }
              pushQuad(panelCorners, eastNormal, panelColors);
            };
            addDoorPanel(doorX, z0, z0 + 0.13, doorY0, doorY1, frameColor);
            addDoorPanel(doorX, z1 - 0.13, z1, doorY0, doorY1, frameColor);
            addDoorPanel(doorX, z0 + 0.13, z1 - 0.13, tierY, tierY + 0.15, frameColor);
            addDoorPanel(doorX, z0 + 0.13, z1 - 0.13, tierY + 2.44, tierY + 2.59, frameColor);
            addDoorPanel(doorX, slotZ - 0.018, slotZ + 0.018, tierY + 0.15, tierY + 2.44, gapColor);
            for (const barOffset of [-0.8, -0.32, 0.32, 0.8]) {
              addDoorPanel(
                fittingX,
                slotZ + barOffset - 0.024,
                slotZ + barOffset + 0.024,
                tierY + 0.1,
                tierY + 2.5,
                barColor
              );
              if (slotIdx < 8)
                for (const fittingY of [0.32, 2.2])
                  addDoorPanel(
                    fittingX + 0.01,
                    slotZ + barOffset - 0.07,
                    slotZ + barOffset + 0.07,
                    tierY + fittingY,
                    tierY + fittingY + 0.09,
                    barColor
                  );
            }
            if (slotIdx < 8)
              for (const hingeOffset of [-0.56, 0.56])
                addDoorPanel(
                  fittingX + 0.01,
                  slotZ + hingeOffset - 0.1,
                  slotZ + hingeOffset + 0.1,
                  tierY + 1.02,
                  tierY + 1.1,
                  barColor
                );
          }
        }
      })
    );
  }
  const yardRowsWest = [-48.6, -61.2, -73.8, -90.5, -103.1, -115.7, -132, -144.6];
  const yardRowsSouth = [6.3, -6.3, -18.9, -31.5];
  addContainerRows(yardRowsWest, -4.9, -112, {
    ribs: true,
    doorRows: 15,
    west: true
  });
  addContainerRows(yardRowsWest, 14.9, 112, {
    ribs: true,
    doorRows: 15,
    west: true
  });
  addContainerRows(yardRowsSouth, -36.4, -110, {
    faceZ: 1,
    ribs: true,
    doorRows: 12
  });
  addContainerRows(yardRowsSouth, 33.9, 110, {
    faceZ: -1,
    ribs: true,
    doorRows: 12
  });
  {
    const quadGeometry = new BufferGeometry();
    quadGeometry.setAttribute('position', new Float32BufferAttribute(quadPositions, 3));
    quadGeometry.setAttribute('normal', new Float32BufferAttribute(quadNormals, 3));
    quadGeometry.setAttribute('uv', new Float32BufferAttribute(quadUvs, 2));
    quadGeometry.setAttribute('color', new Float32BufferAttribute(quadColors, 3));
    batcher.add(whitePaint, quadGeometry);
  }
  const slateTint = containerTint(0x5a6068, 0.85);
  const darkSteel = [0.1, 0.1, 0.11];
  const greySteel = [0.36, 0.38, 0.4];
  const cabTint = containerTint(0xb98a1c, 0.5);
  const machineryGrey = [0.5, 0.5, 0.48];
  /** Rail-mounted yard gantry crane centred at (x, z). */
  function addYardGantry(
    x: number,
    z: number,
    color: Rgb,
    trolleyOffset: number,
    hoistDrop: number
  ): void {
    const frameColor = color;
    const trimColor = [frameColor[0] * 0.7, frameColor[1] * 0.7, frameColor[2] * 0.7];
    for (const side of [-1, 1]) {
      const railZ = z + side * 9.5;
      for (const sideX of [-1, 1]) {
        const legX = x + sideX * 7.5;
        addShaded(
          boxBetween(legX - 1.5, 0.05, railZ - 0.28, legX + 1.5, 0.8, railZ + 0.28),
          darkSteel
        );
        addShaded(
          boxBetween(legX - 0.36, 0.8, railZ - 0.36, legX + 0.36, 19.1, railZ + 0.36),
          frameColor
        );
        addShaded(boxBetween(legX - 0.4, 6.9, railZ - 0.4, legX + 0.4, 7, railZ + 0.4), trimColor);
        addShaded(
          boxBetween(legX - 0.4, 13, railZ - 0.4, legX + 0.4, 13.1, railZ + 0.4),
          trimColor
        );
        addShaded(
          beamBetween([legX, 14.6, railZ], [legX - sideX * 3.2, 19.1, railZ], 0.3, 0.3),
          frameColor
        );
      }
      addShaded(boxBetween(x - 9.3, 0.8, railZ - 0.4, x + 9.3, 1.7, railZ + 0.4), frameColor);
      addShaded(boxBetween(x - 8, 19.1, railZ - 0.45, x + 8, 20.2, railZ + 0.45), frameColor);
      addShaded(boxBetween(x - 2.4, 1.7, railZ - 0.5, x + 0.8, 3.9, railZ + 0.5), machineryGrey);
    }
    for (const side of [-1, 1]) {
      const girderX = x + side * 3.3;
      const girderZ0 = z - 9.5 - 5.6;
      const girderZ1 = z + 9.5 + 5.6;
      addShaded(
        boxBetween(girderX - 0.45, 20.2, girderZ0, girderX + 0.45, 21.9, girderZ1),
        frameColor
      );
      for (let ribZ = girderZ0 + 4.4; ribZ < girderZ1; ribZ += 4.4)
        addShaded(
          boxBetween(girderX - 0.48, 20.15, ribZ - 0.03, girderX + 0.48, 21.95, ribZ + 0.03),
          trimColor
        );
      addShaded(
        boxBetween(girderX + side * 0.45, 21, girderZ0, girderX + side * 1.3, 21.05, girderZ1),
        greySteel
      );
      railingAlong(
        shadedAdder,
        null,
        [
          [girderX + side * 1.27, 21.05, girderZ0],
          [girderX + side * 1.27, 21.05, girderZ1]
        ],
        {
          post: 3.3,
          r: 0.035,
          mid: false,
          tint: cabTint
        }
      );
      addShaded(
        rodBetween([girderX, 20.2, z - 9.5 + 0.5], [girderX, 20.2, z + 9.5 - 0.5], 0.05, 4),
        darkSteel
      );
    }
    for (const endZ of [z - 9.5 - 5.4, z + 9.5 + 5.4])
      addShaded(boxBetween(x - 3.3, 20.4, endZ - 0.25, x + 3.3, 21.7, endZ + 0.25), frameColor);
    const trolleyZ = z + trolleyOffset;
    addShaded(boxBetween(x - 4, 21.9, trolleyZ - 2.3, x + 4, 22.5, trolleyZ + 2.3), cabTint);
    addShaded(
      boxBetween(x - 2.6, 22.5, trolleyZ - 1.7, x + 1.4, 24.5, trolleyZ + 1.7),
      machineryGrey
    );
    addShaded(boxBetween(x + 1.8, 22.5, trolleyZ - 0.9, x + 3.4, 23.3, trolleyZ + 0.9), darkSteel);
    addShaded(boxBetween(x + 4.3, 17.2, trolleyZ - 1, x + 6.1, 19.5, trolleyZ + 1), machineryGrey);
    addShaded(
      boxBetween(x + 4.4, 18.2, trolleyZ - 1.02, x + 6.12, 19.2, trolleyZ + 1.02),
      [0.08, 0.1, 0.12]
    );
    for (const offset of [-0.9, 0.9])
      addShaded(
        boxBetween(
          x + 4.9,
          19.5,
          trolleyZ + offset - 0.06,
          x + 5.05,
          21.9,
          trolleyZ + offset + 0.06
        ),
        cabTint
      );
    const spreaderY = 21.9 - hoistDrop;
    for (const dx of [-2.2, 2.2])
      for (const dz of [-0.8, 0.8])
        addShaded(
          rodBetween([x + dx, 21.9, trolleyZ + dz], [x + dx, spreaderY, trolleyZ + dz], 0.03, 4),
          darkSteel
        );
    addShaded(
      boxBetween(x - 6.1, spreaderY - 0.4, trolleyZ - 1.22, x + 6.1, spreaderY, trolleyZ + 1.22),
      cabTint
    );
    addShaded(
      boxBetween(x - 2.4, spreaderY, trolleyZ - 0.9, x + 2.4, spreaderY + 0.5, trolleyZ + 0.9),
      cabTint
    );
    {
      const stairX = x - 7.5 - 0.5;
      const stairZ = z - 9.5;
      let flightY = 1.7;
      for (let flight = 0; flight < 6; flight++) {
        const fromZ = stairZ + (flight % 2 ? 1.9 : -1.9);
        const toZ = stairZ + (flight % 2 ? -1.9 : 1.9);
        const nextY = Math.min(20.2, flightY + 3.1);
        addShaded(
          beamBetween([stairX, flightY, fromZ], [stairX, nextY, toZ], 0.6, 0.07),
          greySteel
        );
        addShaded(
          rodBetween([stairX - 0.3, flightY + 1, fromZ], [stairX - 0.3, nextY + 1, toZ], 0.03, 4),
          cabTint
        );
        addShaded(
          boxBetween(stairX - 0.35, nextY - 0.04, toZ - 0.5, stairX + 0.35, nextY, toZ + 0.5),
          greySteel
        );
        flightY = nextY;
      }
      for (const offset of [-2.4, 2.4])
        addShaded(
          boxBetween(
            stairX - 0.3,
            1.7,
            stairZ + offset - 0.05,
            stairX - 0.2,
            20.2,
            stairZ + offset + 0.05
          ),
          trimColor
        );
      addShaded(cylinderAt(1.25, 1.25, 0.5, 'z', x + 7.5 + 1, 3.3, z + 9.5 + 0.9, 12), cabTint);
      addShaded(cylinderAt(0.5, 0.5, 0.6, 'z', x + 7.5 + 1, 3.3, z + 9.5 + 0.9, 8), darkSteel);
      for (const offset of [-0.2, 0.2])
        addShaded(
          rodBetween(
            [x + 7.5 + 0.45, 1.7, z - 9.5 + offset],
            [x + 7.5 + 0.45, 20.2, z - 9.5 + offset],
            0.022,
            4
          ),
          greySteel
        );
    }
    blinkLights.add(beaconGeometry(x, 24.9, trolleyZ, 0.3), redLight, 3.1, rng(), 0.4);
    blinkLights.add(beaconGeometry(x - 3.3, 20, z - 4, 0.24), warmLight, 0);
    blinkLights.add(beaconGeometry(x + 3.3, 20, z + 4, 0.24), warmLight, 0);
  }
  const shadedAdder = {
    // railingAlong always passes the tint given to it (cabTint) here.
    add: (material: null, geometry: BufferGeometry | null, tint?: Rgb) =>
      addShaded(geometry, tint as Rgb)
  };
  const rustTint = containerTint(0x5e2f1c, 0.7);
  addYardGantry(-61, -52.06, slateTint, -3, 4.5);
  addYardGantry(-61, 41.1, rustTint, 5, 9);
  addYardGantry(-103, -10.14, rustTint, 2, 3);
  addYardGantry(-6, -62.6, slateTint, -6, 7);
  addYardGantry(-12, 60.1, slateTint, 4, 5);
  for (const [x, z, height] of [
    [-67.5, -22, 32],
    [-67.5, 31, 32],
    [-122, 4, 34],
    [-12.6, -53, 30],
    [-12.6, 51, 30],
    [-140, -84, 34],
    [-96, 96, 34],
    [0.2, -100, 30],
    [-52, -70, 28],
    [-55, 72, 28],
    [-84, -45, 34],
    [-84, 24, 34],
    [-25, -84, 30],
    [-28, 90, 30],
    [-120, 60, 34],
    [10.5, 49, 26]
  ]) {
    addShaded(cylinderAt(0.14, 0.3, height, 'y', x, height / 2, z, 6), greySteel);
    addShaded(cylinderAt(1.5, 1.5, 0.18, 'y', x, height - 0.5, z, 8), darkSteel);
    for (const [dx, dz] of [
      [-1.4, 0],
      [1.4, 0],
      [0, -1.4],
      [0, 1.4]
    ]) {
      addShaded(
        boxBetween(
          x + dx - 0.25,
          height - 0.95,
          z + dz - 0.25,
          x + dx + 0.25,
          height - 0.6,
          z + dz + 0.25
        ),
        darkSteel
      );
      blinkLights.add(beaconGeometry(x + dx, height - 1.05, z + dz, 0.2), warmLight, 0);
    }
  }
  for (const [x, z, height] of [
    [-158, -30, 62],
    [-76, -128, 48],
    [-150, 104, 54]
  ]) {
    const legs = [
      [-1.1, -0.638],
      [1.1, -0.638],
      [0, 1.265]
    ];
    for (const [lx, lz] of legs)
      addShaded(
        rodBetween([x + lx, 0, z + lz], [x + lx * 0.3, height, z + lz * 0.3], 0.07, 4),
        [0.42, 0.14, 0.1]
      );
    for (let y = 3, level = 0; y < height; y += 6, level++)
      for (let leg = 0; leg < 3; leg++) {
        const legA = legs[leg];
        const legB = legs[(leg + 1) % 3];
        const scaleA = 1 - (0.7 * y) / height;
        const scaleB = 1 - (0.7 * Math.min(height, y + 6)) / height;
        addShaded(
          rodBetween(
            [x + legA[0] * scaleA, y, z + legA[1] * scaleA],
            [x + legB[0] * scaleB, Math.min(height, y + 6), z + legB[1] * scaleB],
            0.04,
            3
          ),
          level % 2 ? machineryGrey : [0.42, 0.14, 0.1]
        );
      }
    for (const guyAngle of [0.5, 2.6, 4.7])
      addShaded(
        rodBetween(
          [x, height * 0.72, z],
          [x + Math.cos(guyAngle) * height * 0.5, 0, z + Math.sin(guyAngle) * height * 0.5],
          0.025,
          3
        ),
        darkSteel
      );
    addShaded(rodBetween([x, height, z], [x, height + 5, z], 0.04, 3), darkSteel);
    addShaded(
      boxBetween(x - 0.9, height * 0.8, z - 0.25, x + 0.9, height * 0.8 + 1.6, z + 0.25),
      machineryGrey
    );
    blinkLights.add(beaconGeometry(x, height + 0.4, z, 0.35), redLight, 2.4, rng(), 0.45);
    blinkLights.add(beaconGeometry(x, height * 0.55, z, 0.28), redLight, 0);
  }
  for (const [x, z, length] of [
    [-178, -70, 90],
    [-182, 40, 110],
    [-60, -150, 70],
    [-70, 150, 80]
  ]) {
    const alongX = Math.abs(z) > 120;
    const addShedBox = (
      a0: number,
      y0: number,
      b0: number,
      a1: number,
      y1: number,
      b1: number,
      tint: Rgb
    ) =>
      addShaded(
        alongX
          ? boxBetween(x + a0, y0, z + b0, x + a1, y1, z + b1)
          : boxBetween(x + b0, y0, z + a0, x + b1, y1, z + a1),
        tint
      );
    addShedBox(-length / 2, 0, -16, length / 2, 9.5, 16, [0.2, 0.22, 0.24]);
    addShedBox(-length / 2, 9.5, -16.4, length / 2, 9.9, 16.4, [0.12, 0.12, 0.13]);
    addShedBox(-length / 2, 9.9, -10, length / 2, 12.2, 10, [0.17, 0.18, 0.2]);
    addShedBox(-length / 2 + 4, 12.2, -1.2, length / 2 - 4, 13.3, 1.2, [0.13, 0.13, 0.14]);
    for (let bayA = -length / 2 + 6; bayA < length / 2 - 5; bayA += 12) {
      addShedBox(bayA - 0.25, 0, -16.2, bayA + 0.25, 9.5, 16.2, [0.13, 0.14, 0.15]);
      if ((bayA | 0) % 3 === 0) {
        addShedBox(bayA + 2, 0, -16.1, bayA + 8, 6.2, 16.1, [0.06, 0.06, 0.07]);
      }
    }
  }
  buildQuayCrane(game, blinkLights, {
    into: batcher,
    mat: whitePaint,
    dz: 66
  });
  (
    [
      [-132, 1.15, true, [0.14, 0.17, 0.21]],
      [-186, 1.25, false, [0.14, 0.17, 0.21]],
      [-252, 1.35, true, [0.26, 0.12, 0.06]],
      [-336, 1.4, false, [0.26, 0.12, 0.06]],
      [128, 1.2, false, [0.14, 0.17, 0.21]],
      [182, 1.3, true, [0.24, 0.25, 0.27]],
      [250, 1.4, false, [0.24, 0.25, 0.27]],
      [330, 1.45, true, [0.26, 0.12, 0.06]]
    ] as [number, number, boolean, Rgb][]
  ).forEach(([z, scale, boomUp, tint], idx) => {
    const tip = addDistantCraneSilhouette(batcher, whitePaint, 23.5, z, {
      s: scale,
      up: boomUp,
      tint
    });
    blinkLights.add(
      beaconGeometry(tip[0], tip[1], tip[2], 0.45 * scale),
      redLight,
      2.6 + (idx % 3) * 0.35,
      idx * 0.37,
      0.45
    );
  });
  addShaded(boxBetween(-230, -1.6, -384, 30, -0.12, 425), [0.24, 0.24, 0.25]);
  /** Moored ship silhouette between x0..x1 / z0..z1 with container stacks and a bridge. */
  function addDistantShip(
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    deckY: number,
    hullColor: Rgb,
    bridgeT: number
  ): void {
    addShaded(boxBetween(x0, -1.6, z0, x1, deckY, z1), hullColor);
    addShaded(boxBetween(x0, -1.6, z0, x1, 0.8, z1 + 0.2), [0.42, 0.14, 0.1]);
    const length = z1 - z0;
    const bridgeZ = z0 + length * bridgeT;
    addShaded(
      boxBetween(x0 + 2, deckY, bridgeZ - 7, x1 - 2, deckY + 17, bridgeZ + 7),
      [0.72, 0.73, 0.7]
    );
    addShaded(
      boxBetween(
        (x0 + x1) / 2 - 3,
        deckY + 17,
        bridgeZ - 5,
        (x0 + x1) / 2 + 3,
        deckY + 24,
        bridgeZ + 1
      ),
      [0.2, 0.3, 0.45]
    );
    for (let bayZ = z0 + 12; bayZ < z1 - 12; bayZ += 13.2) {
      if (Math.abs(bayZ + 6 - bridgeZ) < 14) continue;
      const stackHeight = 2.6 * (2 + Math.floor(rng() * 4));
      const portColor =
        DISTANT_CONTAINER_COLORS[Math.floor(rng() * DISTANT_CONTAINER_COLORS.length)];
      addShaded(
        boxBetween(x0 + 1, deckY, bayZ, (x0 + x1) / 2 - 0.2, deckY + stackHeight, bayZ + 12.2),
        portColor
      );
      const starboardColor =
        DISTANT_CONTAINER_COLORS[Math.floor(rng() * DISTANT_CONTAINER_COLORS.length)];
      addShaded(
        boxBetween(
          (x0 + x1) / 2 + 0.2,
          deckY,
          bayZ,
          x1 - 1,
          deckY + stackHeight - 2.6 * Math.floor(rng() * 2),
          bayZ + 12.2
        ),
        starboardColor
      );
    }
    blinkLights.add(beaconGeometry((x0 + x1) / 2, deckY + 26, bridgeZ, 0.4), [5, 4.6, 3.8], 0);
  }
  addDistantShip(34, 62, 140, 345, 11, [0.1, 0.13, 0.2], 0.78);
  addDistantShip(34, 58, -360, -205, 10, [0.2, 0.08, 0.07], 0.2);
  addDistantShip(470, 500, -190, -40, 9, [0.12, 0.14, 0.17], 0.8);
  addDistantShip(600, 626, 160, 300, 9, [0.16, 0.12, 0.1], 0.2);
  for (let z = 340; z > -66; z -= 12.5) {
    const x = 398 + Math.sin(z * 0.013) * 14 + (rng() - 0.5) * 3;
    const rock = boxBetween(-6 - rng() * 2, -1.6, -7, 6 + rng() * 2, 2.2 + rng() * 1.2, 7);
    rock.rotateY((rng() - 0.5) * 0.5);
    rock.translate(x, 0, z);
    addShaded(rock, [0.2, 0.21, 0.22]);
  }
  {
    addShaded(cylinderAt(5, 6, 3.6, 'y', 399, 0.2, -72, 10), [0.3, 0.3, 0.3]);
    addShaded(cylinderAt(1.7, 2.3, 6, 'y', 399, 5, -72, 10), [0.85, 0.85, 0.82]);
    addShaded(cylinderAt(1.5, 1.7, 4, 'y', 399, 10, -72, 10), [0.62, 0.14, 0.1]);
    addShaded(cylinderAt(1.3, 1.5, 4, 'y', 399, 14, -72, 10), [0.85, 0.85, 0.82]);
    addShaded(cylinderAt(2, 2, 0.3, 'y', 399, 16.1, -72, 10), [0.3, 0.3, 0.32]);
    addShaded(cylinderAt(0.2, 1.3, 1.2, 'y', 399, 18.9, -72, 8), [0.25, 0.25, 0.27]);
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * 6.283;
      addShaded(
        boxBetween(
          399 + Math.cos(angle) * 1.1 - 0.06,
          16.2,
          -72 + Math.sin(angle) * 1.1 - 0.06,
          399 + Math.cos(angle) * 1.1 + 0.06,
          18.3,
          -72 + Math.sin(angle) * 1.1 + 0.06
        ),
        [0.25, 0.25, 0.27]
      );
    }
    blinkLights.add(beaconGeometry(399, 17.25, -72, 0.85), [16, 15, 11], 6, 0, 0.09);
  }
  const farShoreX = 300;
  addShaded(
    boxBetween(farShoreX - 330, -1.6, -520, farShoreX + 330, 2.2, -430),
    [0.16, 0.17, 0.18]
  );
  for (const [dx, z, radius, height] of [
    [-150, -452, 17, 15],
    [-112, -458, 17, 15],
    [-76, -450, 13, 18],
    [20, -455, 20, 14],
    [64, -462, 20, 14],
    [104, -452, 14, 19],
    [136, -462, 14, 19],
    [210, -456, 22, 12]
  ]) {
    addShaded(
      cylinderAt(radius, radius, height, 'y', farShoreX + dx, 2.2 + height / 2, z, 14),
      [0.62, 0.63, 0.62]
    );
    addShaded(
      cylinderAt(
        radius * 0.2,
        radius,
        height * 0.12,
        'y',
        farShoreX + dx,
        2.2 + height * 1.06,
        z,
        14
      ),
      [0.52, 0.53, 0.53]
    );
  }
  for (const [dx, z, height, radius] of [
    [-32, -470, 96, 3.2],
    [168, -475, 70, 2.6]
  ]) {
    addShaded(
      cylinderAt(radius * 0.62, radius, height, 'y', farShoreX + dx, 2.2 + height / 2, z, 10),
      [0.5, 0.5, 0.5]
    );
    for (const bandT of [0.82, 0.94])
      addShaded(
        cylinderAt(
          radius * 0.66,
          radius * 0.7,
          height * 0.05,
          'y',
          farShoreX + dx,
          2.2 + height * bandT,
          z,
          10
        ),
        [0.6, 0.15, 0.1]
      );
    blinkLights.add(
      beaconGeometry(farShoreX + dx, 3.2 + height, z, 0.9),
      redLight,
      2.2,
      rng(),
      0.5
    );
    blinkLights.add(
      beaconGeometry(farShoreX + dx + radius, 2.2 + height * 0.55, z, 0.7),
      redLight,
      2.2,
      rng(),
      0.5
    );
  }
  for (const [dx, z, width, height, depth] of [
    [-230, -455, 70, 16, 30],
    [-10, -445, 30, 22, 18],
    [0, -452, 8, 44, 8],
    [-18, -450, 5, 36, 5],
    [270, -450, 60, 12, 30],
    [150, -448, 26, 28, 14]
  ])
    addShaded(
      boxBetween(
        farShoreX + dx - width / 2,
        2.2,
        z - depth / 2,
        farShoreX + dx + width / 2,
        2.2 + height,
        z + depth / 2
      ),
      [0.34, 0.36, 0.38]
    );
  for (let i = 0; i < 26; i++)
    blinkLights.add(
      beaconGeometry(farShoreX - 300 + rng() * 600, 6 + rng() * 26, -436 + rng() * 6, 0.55),
      rng() > 0.3 ? warmLight : [3, 3.4, 3.8],
      0
    );
  const root = batcher.build({
    cast: false,
    recv: false
  });
  root.name = 'skyline';
  return {
    root,
    tris: batcher.tris
  };
}
/**
 * Flock of `count` gulls circling the harbour, animated entirely in the vertex shader from
 * the shared `uTime` uniform.
 */
export function createGulls(game: Game, uTime: IUniform<number>, count = 12): Mesh {
  const rng = createLcgRng(5521);
  const positions: number[] = [];
  const orbits: number[] = [];
  const params: number[] = [];
  for (let gull = 0; gull < count; gull++) {
    const center =
      gull % 3 === 0
        ? [54 + rng() * 30, 9 + rng() * 14, -4 + rng() * 56]
        : [16 + rng() * 26, 33 + rng() * 12, -14 + rng() * 28];
    const radius = 9 + rng() * 16;
    const speed = (0.16 + rng() * 0.16) * (rng() > 0.5 ? 1 : -1);
    const phase = rng() * 6.283;
    const flapRate = 5 + rng() * 3;
    const wingVerts = [
      [0.15, 0, 0, 0],
      [-0.13, 0, 0, 0],
      [-0.24, 0, 0.8, 1],
      [0.15, 0, 0, 0],
      [-0.24, 0, -0.8, 1],
      [-0.13, 0, 0, 0]
    ];
    for (const vert of wingVerts) {
      positions.push(vert[0], vert[1] - 60, vert[2]);
      orbits.push(center[0], center[1], center[2], radius);
      params.push(speed, phase, flapRate, vert[3]);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aOrbit', new Float32BufferAttribute(orbits, 4));
  geometry.setAttribute('aPar', new Float32BufferAttribute(params, 4));
  const material = new MeshBasicMaterial({
    color: new Color(0.2, 0.21, 0.23),
    side: DoubleSide,
    fog: false
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader =
      `attribute vec4 aOrbit;
attribute vec4 aPar;
uniform float uTime;
` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
      float ga = aPar.y + uTime * aPar.x;
      float gdir = sign(aPar.x);
      vec3 gfw = vec3(-sin(ga), 0.0, cos(ga)) * gdir;
      vec3 grt = vec3(gfw.z, 0.0, -gfw.x);
      vec3 gl = position + vec3(0.0, 60.0, 0.0);
      float glide = smoothstep(-0.2, 0.5, sin(uTime * 0.31 + aPar.y * 3.0));
      float gflap = sin(uTime * aPar.z + aPar.y * 7.0) * mix(0.12, 0.55, glide) + 0.18;
      gl.y += aPar.w * gflap * abs(gl.z);
      gl.z *= mix(1.0, 0.86, aPar.w * abs(gflap));
      vec3 gc = aOrbit.xyz + vec3(cos(ga), 0.0, sin(ga)) * aOrbit.w + vec3(0.0, sin(ga * 0.7 + aPar.y) * 2.2 + sin(uTime * 0.23 + aPar.y) * 1.5, 0.0);
      vec3 transformed = gc + gfw * gl.x + grt * gl.z + vec3(0.0, gl.y - 0.3 * gdir * gl.z, 0.0);`
      );
  };
  material.customProgramCacheKey = () => 'saltline-gulls';
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = 'gulls';
  return mesh;
}
