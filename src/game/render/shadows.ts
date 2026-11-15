/**
 * Sun shadow setup: fits the directional light's shadow frustum to the level, and
 * patches three's `getShadow()` GLSL with a PCSS-style soft shadow (blocker search +
 * variable penumbra, Vogel-disk taps) that can be reverted to the stock chunk.
 */
import { DirectionalLight, Matrix4, ShaderChunk, Vector3 } from 'three';
import { SUN } from '../core/config';

const SOFT_SHADOW_MARKER = '// SALTLINE_SHADOW';
/** The unpatched `shadowmap_pars_fragment` chunk, captured on first install. */
let stockShadowParsChunk: string | null = null;

/** World-space size of the fitted shadow frustum, in metres. */
export interface ShadowFrustumSize {
  width: number;
  height: number;
  depth: number;
}

/**
 * Aims `sun` along `SUN.dir` at the centre of the receiver box and fits its orthographic
 * shadow camera around that box, extending the near plane to include the caster box.
 */
export function fitSunShadowFrustum(
  sun: DirectionalLight,
  receiverMin: Vector3,
  receiverMax: Vector3,
  casterMin: Vector3,
  casterMax: Vector3
): ShadowFrustumSize {
  const toSun = SUN.dir.clone().normalize();
  const center = receiverMin.clone().add(receiverMax).multiplyScalar(0.5);
  sun.target.position.copy(center);
  sun.position.copy(center).addScaledVector(toSun, 200);
  sun.updateMatrixWorld(true);
  sun.target.updateMatrixWorld(true);
  const lightView = new Matrix4().lookAt(sun.position, center, new Vector3(0, 1, 0));
  lightView.setPosition(sun.position);
  lightView.invert();
  const corner = new Vector3();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  /** Calls `visit` with each of the 8 box corners in light view space. */
  const forEachCorner = (min: Vector3, max: Vector3, visit: (point: Vector3) => void) => {
    for (let i = 0; i < 8; i++) {
      corner
        .set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z)
        .applyMatrix4(lightView);
      visit(corner);
    }
  };
  forEachCorner(receiverMin, receiverMax, (point) => {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
    minDepth = Math.min(minDepth, -point.z);
    maxDepth = Math.max(maxDepth, -point.z);
  });
  forEachCorner(casterMin, casterMax, (point) => {
    minDepth = Math.min(minDepth, -point.z);
  });
  const shadowCamera = sun.shadow.camera;
  const margin = 1;
  shadowCamera.left = minX - margin;
  shadowCamera.right = maxX + margin;
  shadowCamera.bottom = minY - margin;
  shadowCamera.top = maxY + margin;
  shadowCamera.near = Math.max(1, minDepth - 4);
  shadowCamera.far = maxDepth + 4;
  shadowCamera.updateProjectionMatrix();
  return {
    width: shadowCamera.right - shadowCamera.left,
    height: shadowCamera.top - shadowCamera.bottom,
    depth: shadowCamera.far - shadowCamera.near
  };
}

/**
 * Replaces three's `getShadow()` with the soft-shadow version sized for `frustum`.
 * Returns false (keeping stock PCF) if the chunk layout is not as expected.
 */
export function installSoftShadows(
  frustum: ShadowFrustumSize,
  { taps = 16, searchTaps = 8 }: { taps?: number; searchTaps?: number } = {}
): boolean {
  const currentChunk = ShaderChunk.shadowmap_pars_fragment;
  if (stockShadowParsChunk === null) stockShadowParsChunk = currentChunk;
  const stock = stockShadowParsChunk;
  const getShadowStart = stock.indexOf('float getShadow(');
  const cubeToUvStart = stock.indexOf('vec2 cubeToUV');
  let replaceEnd = stock.lastIndexOf('// cubeToUV()', cubeToUvStart);
  if (replaceEnd < getShadowStart) replaceEnd = cubeToUvStart;
  if (getShadowStart < 0 || cubeToUvStart < 0 || cubeToUvStart < getShadowStart) {
    console.warn('[render] soft shadows: unexpected Three shader chunk layout, keeping stock PCF');
    return false;
  }
  const softShadowGlsl = `
	${SOFT_SHADOW_MARKER}
	const vec2 SL_FRUSTUM = vec2( ${frustum.width.toFixed(3)}, ${frustum.height.toFixed(3)} );   // metres across the shadow map
	const float SL_DEPTH = ${frustum.depth.toFixed(3)};                                       // metres across the depth range
	float slIGN( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
	vec2 slVogel( int i, int n, float phi ) {
		float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
		float th = float( i ) * 2.39996323 + phi;
		return r * vec2( cos( th ), sin( th ) );
	}
	float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
		shadowCoord.xyz /= shadowCoord.w;
		vec3 sc = shadowCoord.xyz;
		vec3 dx = dFdx( sc ), dy = dFdy( sc );
		bool inFrustum = sc.x >= 0.0 && sc.x <= 1.0 && sc.y >= 0.0 && sc.y <= 1.0;
		if ( ! ( inFrustum && sc.z <= 1.0 ) ) return 1.0;
		// receiver plane depth bias: depth gradient of the receiver in shadow-map uv space
		float det = dx.x * dy.y - dx.y * dy.x;
		vec2 dz = vec2( 0.0 );
		if ( abs( det ) > 1e-12 ) dz = vec2( dy.y * dx.z - dx.y * dy.z, dx.x * dy.z - dy.x * dx.z ) / det;
		vec2 texel = 1.0 / shadowMapSize;
		float maxSlope = 0.0030 / max( texel.x, texel.y );      // never bias more than ~0.6 m per kernel
		dz = clamp( dz, vec2( - maxSlope ), vec2( maxSlope ) );
		float zr = sc.z + shadowBias - ( abs( dz.x ) * texel.x + abs( dz.y ) * texel.y ) * 0.35;
		float phi = slIGN( gl_FragCoord.xy ) * 6.2831853;
		// --- blocker search ---
		vec2 searchR = ( 0.55 * shadowRadius ) / SL_FRUSTUM;     // metres -> uv
		float blk = 0.0, nb = 0.0;
		for ( int i = 0; i < ${searchTaps}; i ++ ) {
			vec2 o = slVogel( i, ${searchTaps}, phi ) * searchR;
			float d = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + o ) );
			float z = zr + dot( o, dz );
			if ( d < z ) { blk += d; nb += 1.0; }
		}
		if ( nb < 0.5 ) return 1.0;
		float avg = blk / nb;
		// --- penumbra: grows with blocker distance (sun half-angle scaled up for look) ---
		float distM = max( zr - avg, 0.0 ) * SL_DEPTH;
		float penM = clamp( distM * 0.022 * shadowRadius, 0.012 * shadowRadius, 0.60 * shadowRadius );
		vec2 filtR = max( vec2( penM ) / SL_FRUSTUM, texel * 1.25 );
		float lit = 0.0;
		for ( int i = 0; i < ${taps}; i ++ ) {
			vec2 o = slVogel( i, ${taps}, phi + 1.7 ) * filtR;
			float d = unpackRGBAToDepth( texture2D( shadowMap, sc.xy + o ) );
			lit += step( zr + dot( o, dz ), d );
		}
		lit /= float( ${taps} );
		// fade to lit at the very edge of the map so the frustum border never shows
		vec2 e = min( sc.xy, 1.0 - sc.xy );
		lit = mix( 1.0, lit, smoothstep( 0.0, 0.02, min( e.x, e.y ) ) );
		return mix( 1.0, lit, shadowIntensity );
	}

	`;
  ShaderChunk.shadowmap_pars_fragment =
    stock.slice(0, getShadowStart) + softShadowGlsl + stock.slice(replaceEnd);
  return true;
}

/** Puts back the stock shadow chunk (if soft shadows were ever installed). */
export function restoreStockShadows(): void {
  if (stockShadowParsChunk !== null) ShaderChunk.shadowmap_pars_fragment = stockShadowParsChunk;
}

/** Marker comment present in shader sources compiled with the soft shadow chunk. */
export const SOFT_SHADOW_TAG = SOFT_SHADOW_MARKER;
