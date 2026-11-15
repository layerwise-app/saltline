/**
 * Weapon surface markings and small effect meshes: a procedurally drawn
 * canvas atlas of roll marks / stamps / labels, decal quads that place atlas
 * entries on the rifle and pistol, the reflex-sight glass shader and the
 * muzzle-flash card mesh.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Float32BufferAttribute,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  ShaderMaterial,
  Shape,
  ShapeGeometry
} from 'three';
import type { IUniform } from 'three';
import { SKY_COLORS, SUN } from '../core/config';

/** Pixel rectangle `[x, y, width, height]` of an entry in the marking atlas. */
type AtlasRect = [number, number, number, number];

/** Which face a decal lies on: left (-X), right (+X) or top (+Y). */
export type MarkingSide = 'L' | 'R' | 'T';

/**
 * One decal placement: `[atlasKey, x, y, z, height, side, angle?]`.
 * The quad is centred on `(x, y, -z)`; its width follows the atlas entry's aspect
 * ratio, and the optional `angle` rotates it about the X axis.
 */
export type MarkingDecal =
  | [string, number, number, number, number, MarkingSide]
  | [string, number, number, number, number, MarkingSide, number];

/** A 2D outline point `[x, y]`. */
export type OutlinePoint = [number, number] | number[];

const MARKING_ATLAS_RECTS: Record<string, AtlasRect> = {
  model: [8, 8, 440, 112],
  p_model: [456, 8, 300, 112],
  rack: [764, 8, 420, 150],
  p_rack: [1192, 8, 340, 120],
  qr: [1540, 8, 150, 150],
  cart: [1698, 8, 230, 150],
  warn: [8, 166, 640, 170],
  optic: [656, 166, 420, 84],
  light: [1084, 166, 420, 84],
  p_name: [1512, 166, 340, 78],
  p_cal: [656, 258, 340, 50],
  p_sn: [1004, 258, 340, 50],
  sn: [1352, 258, 400, 50],
  proof: [1760, 258, 200, 60],
  maker: [8, 344, 880, 56],
  cal: [896, 344, 880, 56],
  prop: [8, 408, 1100, 56],
  p_maker: [1116, 408, 880, 56],
  p_prop: [8, 472, 900, 56],
  safe: [916, 472, 96, 60],
  semi: [1020, 472, 96, 60],
  auto: [1124, 472, 96, 60],
  dots: [1228, 472, 96, 60],
  nm: [1332, 472, 660, 50],
  tag: [8, 610, 560, 200],
  arrow: [580, 610, 120, 60],
  index: [710, 610, 60, 60]
};
for (let slot = 0; slot < 20; slot++) {
  MARKING_ATLAS_RECTS['r' + (2 + slot * 2)] = [8 + slot * 100, 540, 92, 60];
}
const MARKING_ATLAS_WIDTH = 2048;
const MARKING_ATLAS_HEIGHT = 1024;

/** Paints every marking into a 2048x1024 canvas and wraps it as a mipmapped texture. */
function drawMarkingAtlasTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = MARKING_ATLAS_WIDTH;
  canvas.height = MARKING_ATLAS_HEIGHT;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, MARKING_ATLAS_WIDTH, MARKING_ATLAS_HEIGHT);
  ctx.textBaseline = 'middle';
  const drawText = (
    key: string,
    text: string,
    font: string,
    color: string,
    align: CanvasTextAlign = 'left'
  ): void => {
    const [x, y, w, h] = MARKING_ATLAS_RECTS[key];
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(text, align === 'left' ? x + 4 : x + w / 2, y + h / 2 + 2, w - 8);
  };
  const condensedFont = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif';
  const monoFont = '"IBM Plex Mono", "Courier New", monospace';
  const displayFont = '"Big Shoulders Display", "Barlow Condensed", Impact, sans-serif';
  const steelInk = 'rgba(158,160,158,0.92)';
  const paintInk = 'rgba(206,198,160,0.92)';
  const redInk = 'rgba(196,52,36,0.95)';
  drawText('model', 'PAC-9', `700 104px ${displayFont}`, steelInk);
  drawText('maker', 'LONGSHORE ARMS WORKS  \xB7  SALTLINE', `600 44px ${condensedFont}`, steelInk);
  drawText('cal', 'CAL 5.8\xD740   SN PA-004217', `500 38px ${monoFont}`, steelInk);
  drawText(
    'prop',
    'PROPERTY OF PORT AUTHORITY — BERTH 4 ARMOURY',
    `600 40px ${condensedFont}`,
    steelInk
  );
  drawText('sn', 'PA-004217', `500 40px ${monoFont}`, steelInk, 'center');
  drawText(
    'nm',
    'BARREL NUT 54 N\xB7m  \xB7  DO NOT OIL THREADS',
    `600 34px ${condensedFont}`,
    steelInk
  );
  drawText('safe', 'S', `700 46px ${condensedFont}`, steelInk, 'center');
  drawText('semi', '1', `700 46px ${condensedFont}`, steelInk, 'center');
  drawText('auto', 'A', `700 46px ${condensedFont}`, redInk, 'center');
  drawText('rack', 'B4-07', `800 142px ${displayFont}`, paintInk, 'center');
  for (let slot = 0; slot < 20; slot++) {
    drawText(
      'r' + (2 + slot * 2),
      'T' + (2 + slot * 2),
      `600 40px ${monoFont}`,
      'rgba(150,152,150,0.88)',
      'center'
    );
  }
  drawText('optic', 'HX-2 REFLEX', `700 62px ${condensedFont}`, steelInk, 'center');
  drawText('light', '900 LM  IPX8', `600 56px ${condensedFont}`, steelInk, 'center');
  drawText('p_model', 'PAC-4', `700 104px ${displayFont}`, steelInk);
  drawText('p_name', 'BOSUN', `600 70px ${condensedFont}`, steelInk);
  drawText('p_cal', '9\xD719  PA-SVC', `500 38px ${monoFont}`, steelInk);
  drawText('p_sn', 'SN PB-011902', `500 38px ${monoFont}`, steelInk);
  drawText('p_rack', 'B4-11', `800 112px ${displayFont}`, paintInk, 'center');
  drawText(
    'p_maker',
    'LONGSHORE ARMS WORKS  \xB7  SALTLINE',
    `600 44px ${condensedFont}`,
    steelInk
  );
  drawText('p_prop', 'PROPERTY OF PORT AUTHORITY — BERTH 4', `600 40px ${condensedFont}`, steelInk);
  {
    const [x, y] = MARKING_ATLAS_RECTS.warn;
    ctx.fillStyle = steelInk;
    ctx.textAlign = 'left';
    ctx.font = `600 38px ${condensedFont}`;
    [
      'WARNING — CLEAR CHAMBER BEFORE',
      'STOWAGE. AUTHORISED BREACH',
      'PERSONNEL ONLY. PA-REG 44/7'
    ].forEach((line, row) => ctx.fillText(line, x + 4, y + 32 + row * 52, 630));
  }
  {
    const [x, y, , h] = MARKING_ATLAS_RECTS.dots;
    ctx.fillStyle = steelInk;
    ctx.beginPath();
    ctx.arc(x + 24, y + h / 2, 11, 0, 7);
    ctx.fill();
    ctx.fillStyle = redInk;
    ctx.beginPath();
    ctx.arc(x + 68, y + h / 2, 11, 0, 7);
    ctx.fill();
  }
  // Park-Miller minimal standard generator, fixed seed: the atlas is identical every boot.
  let seed = 7;
  const random = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  {
    const [x, y, w] = MARKING_ATLAS_RECTS.qr;
    const cells = 16;
    const cellSize = (w - 12) / cells;
    ctx.fillStyle = steelInk;
    for (let row = 0; row < cells; row++) {
      for (let col = 0; col < cells; col++) {
        if (
          col === 0 ||
          row === cells - 1 ||
          (row === 0 && col % 2 === 0) ||
          (col === cells - 1 && row % 2 === 1) ||
          (col > 0 && row > 0 && col < cells - 1 && row < cells - 1 && random() > 0.52)
        ) {
          ctx.fillRect(
            x + 6 + col * cellSize,
            y + 6 + row * cellSize,
            cellSize + 0.5,
            cellSize + 0.5
          );
        }
      }
    }
  }
  {
    const [x, y, w, h] = MARKING_ATLAS_RECTS.cart;
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.strokeStyle = steelInk;
    ctx.fillStyle = steelInk;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w / 2 - 8, h / 2 - 8, 0, 0, 7);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(cx, cy, w / 2 - 20, h / 2 - 20, 0, 0, 7);
    ctx.stroke();
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 36);
    ctx.lineTo(cx, cy + 30);
    ctx.moveTo(cx - 16, cy - 20);
    ctx.lineTo(cx + 16, cy - 20);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy + 2, 30, 0.25, Math.PI - 0.25);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy - 42, 7, 0, 7);
    ctx.stroke();
    ctx.font = `700 30px ${condensedFont}`;
    ctx.textAlign = 'center';
    ctx.fillText('L', cx - 62, cy + 2);
    ctx.fillText('W', cx + 62, cy + 2);
  }
  {
    const [x, y, , h] = MARKING_ATLAS_RECTS.proof;
    const cy = y + h / 2;
    ctx.strokeStyle = steelInk;
    ctx.fillStyle = steelInk;
    ctx.lineWidth = 4;
    ctx.font = `700 30px ${condensedFont}`;
    ctx.textAlign = 'center';
    ctx.beginPath();
    ctx.arc(x + 34, cy, 24, 0, 7);
    ctx.stroke();
    ctx.fillText('P', x + 34, cy + 2);
    ctx.beginPath();
    ctx.moveTo(x + 100, cy - 26);
    ctx.lineTo(x + 126, cy);
    ctx.lineTo(x + 100, cy + 26);
    ctx.lineTo(x + 74, cy);
    ctx.closePath();
    ctx.stroke();
    ctx.fillText('4', x + 100, cy + 2);
    ctx.strokeRect(x + 144, cy - 22, 44, 44);
    ctx.fillText('N', x + 166, cy + 2);
  }
  {
    const [x, y, w, h] = MARKING_ATLAS_RECTS.tag;
    ctx.fillStyle = 'rgba(186,184,174,0.97)';
    ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
    ctx.fillStyle = 'rgba(24,24,26,0.96)';
    ctx.textAlign = 'left';
    ctx.font = `700 40px ${condensedFont}`;
    ctx.fillText('PORT AUTHORITY  \xB7  BERTH 4', x + 22, y + 38, w - 44);
    ctx.font = `500 30px ${monoFont}`;
    ctx.fillText('ASSET 0407-A   INSP 11/26', x + 22, y + 172, w - 44);
    // Barcode: random bar widths and gaps.
    let barX = x + 22;
    while (barX < x + w - 30) {
      const barWidth = 2 + Math.floor(random() * 4) * 2;
      ctx.fillRect(barX, y + 66, barWidth, 78);
      barX += barWidth + 2 + Math.floor(random() * 3) * 2;
    }
  }
  {
    const [x, y, w, h] = MARKING_ATLAS_RECTS.arrow;
    ctx.fillStyle = steelInk;
    ctx.beginPath();
    ctx.moveTo(x + 8, y + h / 2 - 7);
    ctx.lineTo(x + w - 40, y + h / 2 - 7);
    ctx.lineTo(x + w - 40, y + 8);
    ctx.lineTo(x + w - 8, y + h / 2);
    ctx.lineTo(x + w - 40, y + h - 8);
    ctx.lineTo(x + w - 40, y + h / 2 + 7);
    ctx.lineTo(x + 8, y + h / 2 + 7);
    ctx.fill();
  }
  {
    const [x, y, w, h] = MARKING_ATLAS_RECTS.index;
    ctx.fillStyle = 'rgba(214,214,208,0.95)';
    ctx.fillRect(x + w / 2 - 5, y + 6, 10, h - 12);
  }
  // Wear: punch random specks out of everything drawn so far.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 5200; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.2 + random() * 0.55})`;
    const size = random() < 0.92 ? 1 + random() * 2 : 3 + random() * 7;
    ctx.fillRect(
      random() * MARKING_ATLAS_WIDTH,
      random() * MARKING_ATLAS_HEIGHT,
      size,
      size * (0.4 + random())
    );
  }
  {
    // The painted rack number chips harder.
    const [x, y, w, h] = MARKING_ATLAS_RECTS.rack;
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.3 + random() * 0.6})`;
      const size = 2 + random() * 9;
      ctx.fillRect(x + random() * w, y + random() * h, size * (0.5 + random() * 2), size * 0.6);
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  return texture;
}

/** Rail slot numbers (`T2`..`T32`) on the top rail, placed by slot index. */
export const RAIL_SLOT_NUMBER_DECALS: MarkingDecal[] = [
  [2, 1],
  [4, 3],
  [6, 15],
  [8, 17],
  [10, 19],
  [12, 21],
  [14, 23],
  [26, 35],
  [28, 37],
  [30, 39],
  [32, 41]
].map(([slot, railIndex]): MarkingDecal => [
  'r' + slot,
  0,
  0.04362,
  -0.09211 + railIndex * 0.01001,
  0.003,
  'T'
]);

/** Built-in layouts, selected when a caller's first decal key matches the layout's first entry. */
const MARKING_DECAL_LAYOUTS: Record<'rifle' | 'pistolSlide' | 'pistolFrame', MarkingDecal[]> = {
  rifle: [
    ['model', -0.01522, -0.035, 0.066, 0.0092, 'L'],
    ['maker', -0.01522, -0.0452, 0.0672, 0.003, 'L'],
    ['cal', -0.01522, -0.05, 0.0672, 0.0027, 'L'],
    ['prop', -0.01522, -0.0712, 0.0675, 0.0024, 'L'],
    ['cart', -0.01522, -0.061, 0.054, 0.008, 'L'],
    ['proof', -0.01522, -0.0612, 0.08, 0.0034, 'L'],
    ['auto', -0.01642, -0.0262, -0.0335, 0.0038, 'L'],
    ['semi', -0.01642, -0.0252, -0.049, 0.0038, 'L'],
    ['safe', -0.01642, -0.0362, -0.0605, 0.0038, 'L'],
    ['warn', -0.01652, -0.0082, 0.033, 0.0058, 'L'],
    ['qr', -0.01652, -0.007, -0.044, 0.0078, 'L'],
    ['sn', -0.01652, -0.0098, -0.079, 0.0026, 'L'],
    ['cal', -0.01812, 0.0244, 0, 0.0022, 'L'],
    ['rack', -0.01702, -0.003, -0.203, 0.019, 'L'],
    ['optic', -0.01935, 0.0735, 0.021, 0.0024, 'L'],
    ['model', 0.01522, -0.035, 0.069, 0.0092, 'R'],
    ['maker', 0.01522, -0.0452, 0.0672, 0.003, 'R'],
    ['prop', 0.01522, -0.0712, 0.0675, 0.0024, 'R'],
    ['tag', 0.01522, -0.06, 0.067, 0.0094, 'R'],
    ['auto', 0.01642, -0.0262, -0.0335, 0.0038, 'R'],
    ['semi', 0.01642, -0.0252, -0.049, 0.0038, 'R'],
    ['safe', 0.01642, -0.0362, -0.0605, 0.0038, 'R'],
    ['sn', 0.01652, -0.0098, -0.067, 0.003, 'R'],
    ['proof', 0.01652, 0.001, 0.0808, 0.0036, 'R'],
    ['nm', 0.01812, 0.0244, 0.05, 0.002, 'R'],
    ['rack', 0.01702, -0.003, -0.203, 0.019, 'R'],
    ['optic', 0.01935, 0.0725, 0.025, 0.0022, 'R'],
    ...RAIL_SLOT_NUMBER_DECALS
  ],
  pistolSlide: [
    ['p_model', -0.01292, -6e-4, 0.047, 0.0066, 'L'],
    ['p_name', -0.01292, -6e-4, 0.0225, 0.004, 'L'],
    ['p_maker', -0.01292, -0.0038, -0.024, 0.0017, 'L'],
    ['cart', -0.01292, 6e-4, -0.03, 0.0048, 'L'],
    ['p_cal', 0.01292, -6e-4, 0.047, 0.0036, 'R'],
    ['proof', 0.01292, -0.001, -0.035, 0.0026, 'R']
  ],
  pistolFrame: [
    ['p_prop', -0.01282, -0.0196, 0.061, 0.002, 'L'],
    ['qr', -0.01282, -0.025, 0.086, 0.0048, 'L'],
    ['p_sn', 0.01282, -0.0196, 0.064, 0.0024, 'R'],
    ['p_rack', 0.01282, -0.025, 0.08, 0.0036, 'R']
  ]
};

/** GLSL helper `dBump(N, h)`: perturbs a normal by screen-space derivatives of a height. */
export const derivativeBumpGlsl = `vec3 dBump(vec3 N, float h){ vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition); float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx); float det = dot(dpdx, r1); vec3 g = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * N - g); }
`;

let cachedMarkingMaterial: MeshStandardMaterial | null = null;

/** Shared decal material (atlas map with alpha-derived bump), built on first use. */
function getMarkingMaterial(): MeshStandardMaterial {
  if (cachedMarkingMaterial) return cachedMarkingMaterial;
  const material = new MeshStandardMaterial({
    map: drawMarkingAtlasTexture(),
    transparent: true,
    roughness: 0.78,
    metalness: 0,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    side: DoubleSide
  });
  material.name = 'weapon_markings';
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
` + derivativeBumpGlsl
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
normal = dBump(normal, -diffuseColor.a * 0.00005);`
      );
  };
  material.customProgramCacheKey = () => 'pac-markings-2';
  cachedMarkingMaterial = material;
  return material;
}

/**
 * Builds one mesh of decal quads textured from the marking atlas. If the first decal's key is
 * `model`, `p_model` or `p_prop`, the matching built-in layout (rifle, pistol slide, pistol frame)
 * replaces the given list.
 */
export function createMarkingDecalMesh(
  decals: MarkingDecal[]
): Mesh<BufferGeometry, MeshStandardMaterial> {
  const firstKey = decals && decals[0] && decals[0][0];
  if (firstKey === 'model') {
    decals = MARKING_DECAL_LAYOUTS.rifle;
  } else if (firstKey === 'p_model') {
    decals = MARKING_DECAL_LAYOUTS.pistolSlide;
  } else if (firstKey === 'p_prop') {
    decals = MARKING_DECAL_LAYOUTS.pistolFrame;
  }
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const [key, x, y, z, height, side, angle = 0] of decals) {
    const [rectX, rectY, rectW, rectH] = MARKING_ATLAS_RECTS[key];
    const width = (height * rectW) / rectH;
    const u0 = rectX / MARKING_ATLAS_WIDTH;
    const u1 = (rectX + rectW) / MARKING_ATLAS_WIDTH;
    const v1 = 1 - rectY / MARKING_ATLAS_HEIGHT;
    const v0 = 1 - (rectY + rectH) / MARKING_ATLAS_HEIGHT;
    const baseIndex = positions.length / 3;
    let corners: number[][];
    if (side === 'L') {
      corners = [
        [x, y - height / 2, -(z + width / 2)],
        [x, y - height / 2, -(z - width / 2)],
        [x, y + height / 2, -(z - width / 2)],
        [x, y + height / 2, -(z + width / 2)]
      ];
    } else if (side === 'R') {
      corners = [
        [x, y - height / 2, -(z - width / 2)],
        [x, y - height / 2, -(z + width / 2)],
        [x, y + height / 2, -(z + width / 2)],
        [x, y + height / 2, -(z - width / 2)]
      ];
    } else {
      corners = [
        [x - width / 2, y, -(z - height / 2)],
        [x + width / 2, y, -(z - height / 2)],
        [x + width / 2, y, -(z + height / 2)],
        [x - width / 2, y, -(z + height / 2)]
      ];
    }
    if (angle) {
      // Rotate the quad about the X axis through its centre.
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const centerY = y;
      const centerZ = -z;
      for (const corner of corners) {
        const dy = corner[1] - centerY;
        const dz = corner[2] - centerZ;
        corner[1] = centerY + dy * cos - dz * sin;
        corner[2] = centerZ + dy * sin + dz * cos;
      }
    }
    for (const corner of corners) positions.push(corner[0], corner[1], corner[2]);
    uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
    const normal = side === 'L' ? [-1, 0, 0] : side === 'R' ? [1, 0, 0] : [0, 1, 0];
    for (let i = 0; i < 4; i++) normals.push(normal[0], normal[1], normal[2]);
    indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  const mesh = new Mesh(geometry, getMarkingMaterial());
  mesh.renderOrder = 2;
  return mesh;
}

/** Uniforms of the reflex-sight glass shader. */
export interface ReflexGlassUniforms {
  [name: string]: IUniform;
  uBright: IUniform<number>;
  uSun: IUniform<typeof SUN.dir>;
  uSunCol: IUniform<typeof SUN.color>;
  uZen: IUniform<typeof SKY_COLORS.zenith>;
  uHor: IUniform<typeof SKY_COLORS.horizonAway>;
  uTilt: IUniform<number>;
  uEnv: IUniform<number>;
}

/**
 * Builds the reflex sight's coated glass pane from its 2D window `outline`, set back `depth`
 * along -Z: a projected red-dot reticle plus a sky / sun reflection through a dichroic coating.
 * The reflection fades out when the scene's environment intensity drops (indoors).
 */
export function createReflexSightGlass(
  outline: OutlinePoint[],
  depth: number
): Mesh<ShapeGeometry, ShaderMaterial> {
  const shape = new Shape();
  outline.forEach((point, i) =>
    i ? shape.lineTo(point[0], point[1]) : shape.moveTo(point[0], point[1])
  );
  shape.closePath();
  const geometry = new ShapeGeometry(shape);
  geometry.translate(0, 0, -depth);
  {
    // Remap UVs to the outline's bounding box.
    let minX = 1e9;
    let maxX = -1e9;
    let minY = 1e9;
    let maxY = -1e9;
    for (const point of outline) {
      minX = Math.min(minX, point[0]);
      maxX = Math.max(maxX, point[0]);
      minY = Math.min(minY, point[1]);
      maxY = Math.max(maxY, point[1]);
    }
    const position = geometry.attributes.position;
    const uv = geometry.attributes.uv;
    for (let i = 0; i < position.count; i++) {
      uv.setXY(
        i,
        (position.getX(i) - minX) / (maxX - minX),
        (position.getY(i) - minY) / (maxY - minY)
      );
    }
  }
  const uniforms: ReflexGlassUniforms = {
    uBright: {
      value: 7
    },
    uSun: {
      value: SUN.dir.clone()
    },
    uSunCol: {
      value: SUN.color.clone()
    },
    uZen: {
      value: SKY_COLORS.zenith.clone()
    },
    uHor: {
      value: SKY_COLORS.horizonAway.clone()
    },
    uTilt: {
      value: 0.1
    },
    uEnv: {
      value: 1
    }
  };
  const material = new ShaderMaterial({
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms,
    vertexShader: `
      varying vec3 vView, vFwd, vRight, vUp, vWPos, vWN; varying vec2 vUv;
      uniform float uTilt;
      void main(){
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz;
        vFwd = (modelViewMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz; vRight = (modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz; vUp = (modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vWN = normalize(mat3(modelMatrix) * normalize(vec3(0.0, -uTilt, 1.0)));   // real sights tilt the glass a few degrees
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vView, vFwd, vRight, vUp, vWPos, vWN; varying vec2 vUv;
      uniform float uBright, uEnv; uniform vec3 uSun, uSunCol, uZen, uHor;
      void main(){
        vec3 d = normalize(vView), fw = normalize(vFwd);
        float k = max(dot(d, fw), 1e-3);
        vec2 a = vec2(dot(d, normalize(vRight)), dot(d, normalize(vUp))) / k;      // tangent of the angle off the bore axis
        float r = length(a), px = max(fwidth(r), 1e-5);
        float dotR = max(0.0011, px * 0.9), ringW = max(0.00045, px * 0.6);
        float dotI = 1.0 - smoothstep(dotR - px, dotR + px, r);
        float ring = 1.0 - smoothstep(ringW - px * 0.5, ringW + px, abs(r - 0.0128));
        float ang = atan(a.y, a.x);
        float tick = (1.0 - smoothstep(0.0, px * 1.2 + 0.0004, min(abs(a.x), abs(a.y)))) * step(0.0128, r) * (1.0 - smoothstep(0.0165, 0.0175, r));
        float ret = clamp(dotI + ring * 0.8 + tick * 0.8, 0.0, 1.0);
        // faint halo so the bloom has something to hold on to
        ret += 0.05 * exp(-r * r / 0.00002);
        vec3 retCol = vec3(1.0, 0.11, 0.045) * ret * uBright;
        // coated glass: sky/sun reflection through a ruby-teal dichroic coating, stronger at grazing angles
        vec3 wv = normalize(vWPos - cameraPosition); vec3 n = normalize(vWN); if (dot(n, wv) > 0.0) n = -n;
        vec3 rf = reflect(wv, n);
        float fres = pow(1.0 - abs(dot(wv, n)), 3.0);
        vec3 sky = mix(uHor, uZen, clamp(rf.y * 1.4 + 0.2, 0.0, 1.0));
        float sd = max(dot(rf, uSun), 0.0);
        sky += uSunCol * (pow(sd, 6.0) * 0.6 + pow(sd, 90.0) * 6.0);
        sky = mix(vec3(0.050, 0.047, 0.043), sky, uEnv); sd *= uEnv;               // under a roof the glass mirrors the room, not the sky
        // multi-layer dichroic coating: the reflected tint walks teal -> violet -> amber as the glass turns away from the
        // eye (thin-film path length grows with the angle), a soft diagonal sheen band, and a thin dark edge
        float band = smoothstep(0.25, 0.5, vUv.x * 0.6 + vUv.y) * (1.0 - smoothstep(0.62, 0.95, vUv.x * 0.6 + vUv.y));
        float ndv = abs(dot(wv, n)), ph = (1.0 - ndv) * 2.6 + vUv.y * 0.35 + vUv.x * 0.12;
        vec3 film = 0.5 + 0.5 * cos(6.2832 * (ph + vec3(0.62, 0.30, 0.12)));
        vec3 coat = mix(mix(vec3(0.30, 0.52, 0.95), vec3(1.0, 0.62, 0.28), clamp(fres * 2.2 + vUv.y * 0.75 - 0.15, 0.0, 1.0)), film * vec3(0.85, 1.0, 0.95), 0.28);
        vec2 e = abs(vUv - 0.5) * 2.0; float edge = smoothstep(0.90, 1.0, max(e.x, e.y));
        float refl = 0.12 + 0.60 * fres + 0.07 * band;
        // dust and a thumb smear on the outer surface: only where light rakes it
        vec2 dc = vUv * vec2(150.0, 100.0), di = floor(dc); float dh = fract(sin(dot(di, vec2(127.1, 311.7))) * 43758.5453);
        float speck = step(0.988, dh) * (1.0 - smoothstep(0.10, 0.36, length(fract(dc) - 0.5 - (fract(dh * 57.3) - 0.5) * 0.5)));
        vec2 sq = (vUv - vec2(0.70, 0.30)) * vec2(1.0, 1.7); float smudge = exp(-dot(sq, sq) * 9.0) * (0.6 + 0.4 * sin(vUv.x * 90.0 + vUv.y * 60.0));
        float lit = 0.06 + 1.6 * pow(sd, 3.0) + fres;
        // faint emitter glow that stays visible off-axis (what you see of a powered sight from the hip)
        vec2 eg = (vUv - vec2(0.5, 0.16)) * vec2(1.0, 1.6); retCol += vec3(1.0, 0.10, 0.04) * 0.20 * exp(-dot(eg, eg) * 60.0) * (1.0 - smoothstep(0.985, 0.9995, k));
        vec3 col = (sky * 1.5 + vec3(0.03, 0.035, 0.045)) * coat * refl * (1.0 - edge) + retCol;
        col += (uHor * 0.5 + uSunCol * 0.25) * lit * (speck * 0.45 + smudge * 0.03);
        float alpha = clamp(0.20 + 0.32 * fres + 0.05 * band + 0.6 * edge + speck * 0.2 * lit + smudge * 0.02, 0.0, 0.94);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = 5;
  let peakEnvIntensity = 0;
  mesh.onBeforeRender = (_renderer, scene) => {
    const envIntensity = scene.environmentIntensity || 1;
    if (envIntensity > peakEnvIntensity) peakEnvIntensity = envIntensity;
    const target = Math.min(1, Math.max(0, (envIntensity / peakEnvIntensity - 0.55) / 0.4));
    uniforms.uEnv.value += (target - uniforms.uEnv.value) * 0.12;
  };
  return mesh;
}

/** Uniforms of the muzzle-flash shader (driven by the weapon each shot). */
export interface MuzzleFlashUniforms {
  [name: string]: IUniform;
  uSeed: IUniform<number>;
  uInt: IUniform<number>;
  uHeat: IUniform<number>;
  uJet: IUniform<number>;
}

/**
 * Builds the muzzle-flash mesh: crossed additive cards (front petals, side jets, core glow,
 * glowing muzzle heat), each tagged by an `aType` attribute that selects its shader branch.
 */
export function createMuzzleFlashMesh(): Mesh<BufferGeometry, ShaderMaterial> {
  const positions: number[] = [];
  const uvs: number[] = [];
  const types: number[] = [];
  const indices: number[] = [];
  type Vec3Tuple = [number, number, number];
  const addQuad = (a: Vec3Tuple, b: Vec3Tuple, c: Vec3Tuple, d: Vec3Tuple, type: number): void => {
    const baseIndex = positions.length / 3;
    for (const corner of [a, b, c, d]) positions.push(corner[0], corner[1], corner[2]);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let i = 0; i < 4; i++) types.push(type);
    indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3);
  };
  // Type 0: two facing star cards.
  addQuad(
    [-0.13, -0.13, -0.03],
    [0.13, -0.13, -0.03],
    [0.13, 0.13, -0.03],
    [-0.13, 0.13, -0.03],
    0
  );
  addQuad(
    [-0.13 * 0.7, -0.13 * 0.7, -0.09],
    [0.13 * 0.7, -0.13 * 0.7, -0.09],
    [0.13 * 0.7, 0.13 * 0.7, -0.09],
    [-0.13 * 0.7, 0.13 * 0.7, -0.09],
    0
  );
  // Type 1: crossed forward plume cards.
  const plumeHalfWidth = 0.065;
  const plumeLength = 0.34;
  addQuad(
    [-plumeHalfWidth, 0, 0.01],
    [plumeHalfWidth, 0, 0.01],
    [plumeHalfWidth, 0, -plumeLength],
    [-plumeHalfWidth, 0, -plumeLength],
    1
  );
  addQuad(
    [0, -plumeHalfWidth, 0.01],
    [0, plumeHalfWidth, 0.01],
    [0, plumeHalfWidth, -plumeLength],
    [0, -plumeHalfWidth, -plumeLength],
    1
  );
  // Type 2: sideways brake jets; type 3: core glow; type 4: muzzle heat.
  const jetHalfLength = 0.17;
  const jetHalfWidth = 0.05;
  const jetZ = 0.035;
  addQuad(
    [-jetHalfLength, -jetHalfWidth, jetZ],
    [jetHalfLength, -jetHalfWidth, jetZ],
    [jetHalfLength, jetHalfWidth, jetZ],
    [-jetHalfLength, jetHalfWidth, jetZ],
    2
  );
  addQuad(
    [-jetHalfLength, 0, jetZ + jetHalfWidth],
    [jetHalfLength, 0, jetZ + jetHalfWidth],
    [jetHalfLength, 0, jetZ - jetHalfWidth],
    [-jetHalfLength, 0, jetZ - jetHalfWidth],
    2
  );
  addQuad(
    [-0.05, -0.05, -0.01],
    [0.05, -0.05, -0.01],
    [0.05, 0.05, -0.01],
    [-0.05, 0.05, -0.01],
    3
  );
  addQuad([-0.03, -0.03, 0.02], [0.03, -0.03, 0.02], [0.03, 0.03, 0.02], [-0.03, 0.03, 0.02], 4);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aType', new Float32BufferAttribute(types, 1));
  geometry.setIndex(indices);
  const uniforms: MuzzleFlashUniforms = {
    uSeed: {
      value: 0
    },
    uInt: {
      value: 0
    },
    uHeat: {
      value: 0
    },
    uJet: {
      value: 1
    }
  };
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms,
    vertexShader: `attribute float aType; varying vec2 vUv; varying float vType;
      void main(){ vUv = uv; vType = aType; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec2 vUv; varying float vType; uniform float uSeed, uInt, uHeat, uJet;
      float h1(float n){ return fract(sin(n * 127.1 + uSeed * 311.7) * 43758.5453); }
      void main(){
        vec2 p = vUv * 2.0 - 1.0; float r = length(p), a = atan(p.y, p.x); float I = 0.0; vec3 tintc = vec3(1.0, 0.50, 0.16);
        if (vType < 0.5) {
          float n1 = 3.0 + floor(h1(1.0) * 3.0), n2 = 5.0 + floor(h1(2.0) * 4.0);
          float pet = pow(abs(cos(a * n1 * 0.5 + h1(3.0) * 6.283)), 5.0) * (0.55 + 0.45 * h1(4.0));
          pet += pow(abs(cos(a * n2 * 0.5 + h1(5.0) * 6.283)), 14.0) * 0.55;
          float reach = 0.35 + 0.65 * pet;
          I = (0.25 + pet) * smoothstep(reach, reach * 0.15, r) * (0.75 + 0.25 * sin(r * 26.0 + h1(6.0) * 20.0));
        } else if (vType < 1.5) {
          float y = vUv.y, x = p.x * (1.0 + 0.5 * sin(y * 17.0 + h1(7.0) * 30.0) * y);
          float wdt = mix(0.20, 0.75, smoothstep(0.0, 0.35, y)) * (1.0 - y * 0.75);
          I = exp(-x * x / (wdt * wdt * 0.35)) * pow(1.0 - y, 1.4) * (0.7 + 0.3 * sin(y * 31.0 + h1(8.0) * 9.0)) * 0.9;
        } else if (vType < 2.5) {
          float u = abs(p.x), len = 0.55 + 0.45 * h1(9.0 + step(0.0, p.x));
          float wv = p.y * (1.0 + u * 3.0) + 0.12 * sin(u * 14.0 + h1(10.0) * 20.0) * u;
          I = exp(-wv * wv * 22.0) * smoothstep(len, 0.06, u) * smoothstep(0.02, 0.10, u) * 0.85 * uJet;
        } else if (vType < 3.5) {
          I = exp(-r * r * 5.0) * 2.4 * smoothstep(1.0, 0.6, r); tintc = vec3(1.0, 0.82, 0.58);
        } else {
          gl_FragColor = vec4(vec3(1.0, 0.28, 0.06) * exp(-r * r * 4.0) * smoothstep(1.0, 0.5, r) * uHeat, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          return;
        }
        vec3 col = mix(tintc, vec3(1.0, 0.90, 0.70), clamp(I * I * 0.7, 0.0, 1.0)) * I * uInt;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  return mesh;
}
