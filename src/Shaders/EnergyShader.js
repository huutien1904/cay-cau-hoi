import * as THREE from 'three';

/*
 * EnergyShader.js — toàn bộ GLSL của hệ năng lượng Cây Sáng Kiến.
 *
 *  - ENERGY_CHUNK         : hàm dùng chung (làn năng lượng theo góc, xung chạy gốc → ngọn)
 *  - patchBarkMaterial    : chèn vệt năng lượng + viền sáng vào MeshStandardMaterial
 *                           (giữ nguyên ánh sáng PBR, fog và tone mapping của Three.js)
 *  - createNodeMaterial   : nốt sáng InstancedMesh, nhấp nháy scale & opacity theo uTime
 *  - createLeafMaterial   : hạt lá phát sáng THREE.Points
 *  - createGroundMaterial : vòng năng lượng dưới gốc cây
 *  - createMoteMaterial   : bụi sáng bay lên quanh tán
 *
 * Màu xuất ra ở không gian tuyến tính HDR (render target HalfFloat). Chỉ phần có độ sáng
 * vượt ngưỡng UnrealBloomPass (~0.88) mới toả hào quang; thân cây được giữ dưới ngưỡng
 * nên không bị cháy sáng.
 */

export function createEnergyUniforms({ speed = 0.34, density = 1.6, lanes = 12 } = {}) {
  return {
    uTime: { value: 0 },
    uEnergySpeed: { value: speed },
    uEnergyDensity: { value: density },
    uEnergyLanes: { value: lanes },
  };
}

export const ENERGY_CHUNK = /* glsl */ `
uniform float uTime;
uniform float uEnergySpeed;
uniform float uEnergyDensity;
uniform float uEnergyLanes;

float energyHash( float n ) {
  return fract( sin( n * 127.1 + 311.7 ) * 43758.5453123 );
}

// Chia cây thành các "làn" theo góc quanh trục thân; mỗi làn có nhịp xung riêng.
float energyLaneCoord( float angle ) {
  return ( angle + PI ) / PI2 * uEnergyLanes;
}

float energyLaneSeed( float angle ) {
  return energyHash( floor( energyLaneCoord( angle ) ) + 1.0 );
}

// Xung răng cưa chạy dọc đường gốc (0) → ngọn (1): đầu xung sáng gắt, đuôi mờ dần.
float energyWave( float pathT, float seed ) {
  float f = fract( pathT * uEnergyDensity - uTime * uEnergySpeed + seed * 7.31 );
  return pow( f, 7.0 ) * ( 1.0 - smoothstep( 0.965, 1.0, f ) );
}
`;

// Fog cho vật liệu cộng sáng (additive): làm mờ bằng alpha thay vì trộn về màu fog,
// nếu trộn màu thì hạt ở xa sẽ sáng lên thay vì chìm vào sương.
const ADDITIVE_FOG_CHUNK = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.a *= 1.0 - fogFactor;
#endif
`;

/* -------------------------------------------------------------------------- */
/*  Thân cây: vệt năng lượng chạy từ rễ → thân → cành                          */
/* -------------------------------------------------------------------------- */

export function createBarkUniforms({
  energyColor = 0x22d3ee,
  energyHot = 0xc4f5ff,
  energyIntensity = 2.6,
  rimColor = 0x3b9dff,
  rimStrength = 0.2,
} = {}) {
  return {
    uEnergyColor: { value: new THREE.Color(energyColor) },
    uEnergyHot: { value: new THREE.Color(energyHot) },
    uEnergyIntensity: { value: energyIntensity },
    uRimColor: { value: new THREE.Color(rimColor) },
    uRimStrength: { value: rimStrength },
    uReveal: { value: 0 },
    uRevealWidth: { value: 0.06 },
    uRootT: { value: 0.1 },
    uForkT: { value: 0.35 },
    uVeinScale: { value: 1.3 },
  };
}

const BARK_VERTEX_PARS = /* glsl */ `
attribute float aEnergy;
varying float vEnergy;
varying vec3 vTreePos;
`;

const BARK_VERTEX_MAIN = /* glsl */ `
vEnergy = aEnergy;
vTreePos = position;
`;

// 3D simplex noise (Ashima Arts / Stefan Gustavson, MIT) — dùng để vẽ mạch vân năng lượng.
const SIMPLEX_NOISE_3D = /* glsl */ `
vec3 barkMod289( vec3 x ) { return x - floor( x * ( 1.0 / 289.0 ) ) * 289.0; }
vec4 barkMod289( vec4 x ) { return x - floor( x * ( 1.0 / 289.0 ) ) * 289.0; }
vec4 barkPermute( vec4 x ) { return barkMod289( ( ( x * 34.0 ) + 10.0 ) * x ); }
vec4 barkTaylorInvSqrt( vec4 r ) { return 1.79284291400159 - 0.85373472095314 * r; }

float barkNoise( vec3 v ) {
  const vec2 C = vec2( 1.0 / 6.0, 1.0 / 3.0 );
  const vec4 D = vec4( 0.0, 0.5, 1.0, 2.0 );

  vec3 i = floor( v + dot( v, C.yyy ) );
  vec3 x0 = v - i + dot( i, C.xxx );

  vec3 g = step( x0.yzx, x0.xyz );
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = barkMod289( i );
  vec4 p = barkPermute( barkPermute( barkPermute(
    i.z + vec4( 0.0, i1.z, i2.z, 1.0 ) ) +
    i.y + vec4( 0.0, i1.y, i2.y, 1.0 ) ) +
    i.x + vec4( 0.0, i1.x, i2.x, 1.0 ) );

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor( p * ns.z * ns.z );
  vec4 x_ = floor( j * ns.z );
  vec4 y_ = floor( j - 7.0 * x_ );

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs( x ) - abs( y );

  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );
  vec4 s0 = floor( b0 ) * 2.0 + 1.0;
  vec4 s1 = floor( b1 ) * 2.0 + 1.0;
  vec4 sh = -step( h, vec4( 0.0 ) );

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3( a0.xy, h.x );
  vec3 p1 = vec3( a0.zw, h.y );
  vec3 p2 = vec3( a1.xy, h.z );
  vec3 p3 = vec3( a1.zw, h.w );

  vec4 norm = barkTaylorInvSqrt( vec4( dot( p0, p0 ), dot( p1, p1 ), dot( p2, p2 ), dot( p3, p3 ) ) );
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

  vec4 m = max( 0.5 - vec4( dot( x0, x0 ), dot( x1, x1 ), dot( x2, x2 ), dot( x3, x3 ) ), 0.0 );
  m = m * m;
  return 105.0 * dot( m * m, vec4( dot( p0, x0 ), dot( p1, x1 ), dot( p2, x2 ), dot( p3, x3 ) ) );
}
`;

const BARK_FRAGMENT_PARS = /* glsl */ `
${ENERGY_CHUNK}
${SIMPLEX_NOISE_3D}
uniform float uVeinScale;
uniform vec3 uEnergyColor;
uniform vec3 uEnergyHot;
uniform float uEnergyIntensity;
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform float uReveal;
uniform float uRevealWidth;
uniform float uRootT;
uniform float uForkT;
varying float vEnergy;
varying vec3 vTreePos;
`;

// Cây mọc dần từ gốc lên theo uReveal (dùng cho intro GSAP).
const BARK_FRAGMENT_REVEAL = /* glsl */ `
if ( vEnergy > uReveal ) discard;
`;

// Chèn sau <emissivemap_fragment>: lúc này đã có `normal` (view space) và `vViewPosition`.
const BARK_FRAGMENT_EMISSIVE = /* glsl */ `
{
  float energyAngle = atan( vTreePos.z, vTreePos.x );
  float laneCoord = energyLaneCoord( energyAngle );
  float laneSeed = energyHash( floor( laneCoord ) + 1.0 );

  // Thân chính: vệt năng lượng là các sợi mảnh uốn lượn, mỗi làn một sợi.
  float wobble = sin( vEnergy * 22.0 + laneSeed * PI2 ) * 0.12;
  float laneOffset = fract( laneCoord ) - 0.5 - wobble;
  float stripe = 1.0 - smoothstep( 0.06, 0.2, abs( laneOffset ) );

  // Rễ & tán: năng lượng chảy theo mạch vân (ridged noise) để cành to không bị phủ phẳng,
  // còn ngọn cành mảnh ở ngoài cùng thì sáng trọn tiết diện.
  float veinNoise = barkNoise( vTreePos * uVeinScale );
  float vein = 1.0 - smoothstep( 0.0, max( 0.09, fwidth( veinNoise ) * 2.0 ), abs( veinNoise ) );
  float veinMask = mix( 0.16, 1.0, vein );
  veinMask = mix( veinMask, 1.0, smoothstep( 0.88, 1.0, vEnergy ) );

  float trunkZone = smoothstep( uRootT, uRootT + 0.04, vEnergy ) * ( 1.0 - smoothstep( uForkT, uForkT + 0.1, vEnergy ) );
  float streamMask = mix( veinMask, stripe, trunkZone );

  float wave = energyWave( vEnergy, laneSeed );
  float trail = wave * streamMask;
  vec3 energyColor = mix( uEnergyColor, uEnergyHot, smoothstep( 0.5, 1.0, wave ) );

  // Nhịp thở nền rất nhẹ để vân năng lượng không tắt hẳn giữa hai xung (dưới ngưỡng bloom).
  float residue = streamMask * ( 0.035 + 0.025 * sin( uTime * 1.4 + vEnergy * 9.0 + laneSeed * PI2 ) );

  // Viền sáng Fresnel làm nổi khối và góc cạnh của thân cây.
  float fresnel = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 3.0 );

  // Dải sáng ở mép đang mọc trong lúc intro, tắt dần khi uReveal vượt 1.
  float growthFront = smoothstep( uReveal - uRevealWidth, uReveal, vEnergy ) * ( 1.0 - smoothstep( 0.98, 1.06, uReveal ) );

  totalEmissiveRadiance += energyColor * trail * uEnergyIntensity;
  totalEmissiveRadiance += uEnergyColor * residue;
  totalEmissiveRadiance += uRimColor * fresnel * uRimStrength;
  totalEmissiveRadiance += uEnergyHot * growthFront * uEnergyIntensity * 1.4;
}
`;

/**
 * Gắn shader năng lượng vào một MeshStandardMaterial có sẵn.
 * Geometry cần có attribute `aEnergy` (0 = đầu rễ, 1 = ngọn cành).
 * @param {THREE.MeshStandardMaterial} material
 * @param {Record<string, { value: unknown }>} uniforms energy uniforms dùng chung + bark uniforms
 */
export function patchBarkMaterial(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BARK_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${BARK_VERTEX_MAIN}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${BARK_FRAGMENT_PARS}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${BARK_FRAGMENT_REVEAL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${BARK_FRAGMENT_EMISSIVE}`);
  };
  material.customProgramCacheKey = () => 'question-tree-energy-bark';
  material.needsUpdate = true;
  return material;
}

/* -------------------------------------------------------------------------- */
/*  Nốt sáng (InstancedMesh)                                                   */
/* -------------------------------------------------------------------------- */

const NODE_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
${ENERGY_CHUNK}

uniform float uAppear;
uniform float uHovered;
uniform float uSelected;

attribute float aPhase;
attribute float aSpeed;
attribute float aPath;
attribute float aAngle;
attribute float aOrder;
attribute float aIndex;
attribute float aEmphasis;
attribute vec3 aColor;

varying vec3 vNormalView;
varying vec3 vViewDir;
varying vec3 vColor;
varying float vPulse;
varying float vWave;
varying float vAlpha;
varying float vFocus;
varying float vEmphasis;

void main() {
  float appear = smoothstep( aOrder, aOrder + 0.18, uAppear );
  float pulse = 0.5 + 0.5 * sin( uTime * aSpeed + aPhase );
  float wave = energyWave( aPath, energyLaneSeed( aAngle ) );

  // Nốt đang được hover / chọn phóng to và sáng hơn; nốt bị lọc bỏ thu nhỏ và mờ đi.
  float hovered = 1.0 - step( 0.5, abs( aIndex - uHovered ) );
  float selected = 1.0 - step( 0.5, abs( aIndex - uSelected ) );
  float focus = max( hovered, selected );

  // Nhấp nháy scale + bật nảy nhẹ lúc xuất hiện + phồng lên khi xung năng lượng chạy tới.
  float pop = 1.0 + 0.45 * sin( appear * PI );
  float scale = appear * pop * ( 0.72 + 0.38 * pulse + 0.55 * wave );
  scale *= mix( 0.5, 1.0, aEmphasis ) * ( 1.0 + focus * 0.9 );

  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( position * scale, 1.0 );
  gl_Position = projectionMatrix * mvPosition;

  vNormalView = normalize( normalMatrix * mat3( instanceMatrix ) * normal );
  vViewDir = normalize( -mvPosition.xyz );
  vColor = aColor;
  vPulse = pulse;
  vWave = wave;
  vAlpha = appear * ( 0.5 + 0.5 * pulse ) * mix( 0.08, 1.0, aEmphasis );
  vFocus = focus;
  vEmphasis = aEmphasis;

  #include <fog_vertex>
}
`;

const NODE_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>

uniform vec3 uHot;
uniform float uIntensity;

varying vec3 vNormalView;
varying vec3 vViewDir;
varying vec3 vColor;
varying float vPulse;
varying float vWave;
varying float vAlpha;
varying float vFocus;
varying float vEmphasis;

void main() {
  float facing = saturate( dot( normalize( vNormalView ), normalize( vViewDir ) ) );
  float core = pow( facing, 2.2 );
  float rim = pow( 1.0 - facing, 2.0 );

  // Chuẩn hoá độ sáng theo màu khối (xanh dương vốn tối hơn cyan) để khối nào cũng toả sáng như nhau,
  // lõi trắng chỉ là một điểm nhỏ — phần quầng giữ được màu khối sau tone mapping.
  float luma = dot( vColor, vec3( 0.2126, 0.7152, 0.0722 ) );
  vec3 base = vColor * ( 0.5 / max( luma, 0.12 ) );
  float energy = uIntensity * ( 0.6 + 0.45 * vPulse + 1.5 * vWave ) * ( 1.0 + vFocus * 1.1 );
  // Emphasis < 1: lá bị khoá tối đi; > 1: lá đã thắp sáng rực hơn.
  energy *= 0.55 + 0.45 * min( vEmphasis, 1.0 ) + max( vEmphasis - 1.0, 0.0 ) * 1.4;
  vec3 color = base * energy + uHot * pow( core, 6.0 ) * uIntensity * ( 0.5 + vWave + vFocus );

  gl_FragColor = vec4( color, saturate( vAlpha + vFocus ) * ( core + rim * 0.35 ) );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  ${ADDITIVE_FOG_CHUNK}
}
`;

export function createNodeMaterial(shared, {
  hot = 0xe6fbff,
  intensity = 1.8,
} = {}) {
  return new THREE.ShaderMaterial({
    name: 'InnovationNodeMaterial',
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...shared,
      uHot: { value: new THREE.Color(hot) },
      uIntensity: { value: intensity },
      uAppear: { value: 0 },
      uHovered: { value: -1 },
      uSelected: { value: -1 },
    },
    vertexShader: NODE_VERTEX,
    fragmentShader: NODE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
}

/* -------------------------------------------------------------------------- */
/*  Hạt lá (THREE.Points)                                                      */
/* -------------------------------------------------------------------------- */

const LEAF_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
${ENERGY_CHUNK}

uniform float uAppear;
uniform float uPointScale;
uniform float uSize;
uniform float uMaxPointSize;

attribute float aSize;
attribute float aPhase;
attribute float aSpeed;
attribute float aTint;
attribute float aOrder;
attribute float aPath;
attribute float aAngle;
attribute vec3 aDrift;

varying float vAlpha;
varying float vWave;
varying float vTint;
varying float vTwinkle;

void main() {
  float appear = smoothstep( aOrder, aOrder + 0.2, uAppear );
  float twinkle = 0.5 + 0.5 * sin( uTime * aSpeed + aPhase );
  float wave = energyWave( aPath, energyLaneSeed( aAngle ) );

  // Lá đung đưa nhẹ như có gió.
  vec3 transformed = position + aDrift * sin( uTime * 0.6 + aPhase );

  vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
  gl_Position = projectionMatrix * mvPosition;

  float size = aSize * uSize * appear * ( 0.65 + 0.55 * twinkle + 0.8 * wave );
  gl_PointSize = min( size * uPointScale / max( -mvPosition.z, 0.001 ), uMaxPointSize );

  vAlpha = appear * ( 0.3 + 0.7 * twinkle );
  vWave = wave;
  vTint = aTint;
  vTwinkle = twinkle;

  #include <fog_vertex>
}
`;

const LEAF_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>

uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uHot;
uniform float uIntensity;

varying float vAlpha;
varying float vWave;
varying float vTint;
varying float vTwinkle;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length( uv );
  if ( d > 0.5 ) discard;

  float halo = pow( 1.0 - d * 2.0, 2.4 );
  float core = 1.0 - smoothstep( 0.0, 0.16, d );

  vec3 base = mix( uColorA, uColorB, vTint );
  vec3 color = mix( base, uHot, saturate( core * 0.6 + vWave * 0.5 ) );
  float energy = uIntensity * ( 0.55 + 0.45 * vTwinkle + 1.5 * vWave );

  gl_FragColor = vec4( color * energy, ( halo * 0.6 + core * 0.45 ) * vAlpha );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  ${ADDITIVE_FOG_CHUNK}
}
`;

export function createLeafMaterial(shared, {
  colorA = 0x0ea5e9,
  colorB = 0x22d3ee,
  hot = 0xd9f7ff,
  intensity = 0.5,
  size = 1,
} = {}) {
  return new THREE.ShaderMaterial({
    name: 'InnovationLeafMaterial',
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...shared,
      uColorA: { value: new THREE.Color(colorA) },
      uColorB: { value: new THREE.Color(colorB) },
      uHot: { value: new THREE.Color(hot) },
      uIntensity: { value: intensity },
      uSize: { value: size },
      uPointScale: { value: 800 },
      uMaxPointSize: { value: 96 },
      uAppear: { value: 0 },
    },
    vertexShader: LEAF_VERTEX,
    fragmentShader: LEAF_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
}

/* -------------------------------------------------------------------------- */
/*  Vòng năng lượng dưới gốc                                                    */
/* -------------------------------------------------------------------------- */

const GROUND_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>

varying vec2 vUv;

void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const GROUND_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>

uniform float uTime;
uniform vec3 uColor;
uniform vec3 uColorB;
uniform float uIntensity;
uniform float uAppear;

varying vec2 vUv;

void main() {
  vec2 p = ( vUv - 0.5 ) * 2.0;
  float r = length( p );
  if ( r > 1.0 ) discard;

  // Quầng sáng mềm ngay dưới gốc.
  float halo = exp( -r * 4.5 );

  // Sóng tròn chạy dần vào tâm: năng lượng từ mặt đất dồn về rễ cây.
  float ripple = pow( 0.5 + 0.5 * sin( r * 42.0 + uTime * 2.4 ), 24.0 );
  ripple *= ( 1.0 - smoothstep( 0.25, 1.0, r ) ) * smoothstep( 0.06, 0.18, r );

  // Các tia mảnh toả ra như mạch điện.
  float angle = atan( p.y, p.x );
  float spokeLane = fract( angle / PI2 * 36.0 ) - 0.5;
  float arc = abs( spokeLane ) * ( PI2 / 36.0 ) * r;
  float spoke = 1.0 - smoothstep( 0.0, fwidth( arc ) * 1.5 + 0.002, arc );
  spoke *= ( 1.0 - smoothstep( 0.3, 0.95, r ) ) * smoothstep( 0.1, 0.25, r ) * 0.25;

  // Lưới vòng tròn đồng tâm rất mờ.
  float ringLine = abs( fract( r * 10.0 ) - 0.5 );
  float grid = smoothstep( 0.5 - fwidth( r * 10.0 ) * 1.5, 0.5, ringLine );

  float fade = 1.0 - smoothstep( 0.55, 1.0, r );
  vec3 color = mix( uColor, uColorB, saturate( r * 1.4 ) );
  float intensity = ( halo * 1.2 + ripple * 0.7 + spoke + grid * 0.06 ) * fade * uAppear * uIntensity;

  gl_FragColor = vec4( color * intensity, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  ${ADDITIVE_FOG_CHUNK}
}
`;

export function createGroundMaterial(shared, {
  color = 0x22d3ee,
  colorB = 0x1d4ed8,
  intensity = 0.3,
} = {}) {
  return new THREE.ShaderMaterial({
    name: 'InnovationGroundMaterial',
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: shared.uTime,
      uColor: { value: new THREE.Color(color) },
      uColorB: { value: new THREE.Color(colorB) },
      uIntensity: { value: intensity },
      uAppear: { value: 0 },
    },
    vertexShader: GROUND_VERTEX,
    fragmentShader: GROUND_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
}

/* -------------------------------------------------------------------------- */
/*  Bụi sáng bay lên                                                            */
/* -------------------------------------------------------------------------- */

const MOTE_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>

uniform float uTime;
uniform float uHeight;
uniform float uAppear;
uniform float uPointScale;
uniform float uSize;
uniform float uMaxPointSize;

attribute float aSpeed;
attribute float aPhase;
attribute float aSize;

varying float vAlpha;

void main() {
  vec3 transformed = position;
  float y = mod( position.y + uTime * aSpeed, uHeight );
  float yn = y / uHeight;
  transformed.y = y;
  transformed.x += sin( uTime * 0.35 + aPhase ) * 0.35;
  transformed.z += cos( uTime * 0.3 + aPhase * 1.3 ) * 0.35;

  vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = min( aSize * uSize * uPointScale / max( -mvPosition.z, 0.001 ), uMaxPointSize );

  float flicker = 0.4 + 0.6 * ( 0.5 + 0.5 * sin( uTime * 1.7 + aPhase ) );
  vAlpha = smoothstep( 0.0, 0.12, yn ) * ( 1.0 - smoothstep( 0.75, 1.0, yn ) ) * uAppear * flicker;

  #include <fog_vertex>
}
`;

const MOTE_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>

uniform vec3 uColor;
uniform float uIntensity;

varying float vAlpha;

void main() {
  float d = length( gl_PointCoord - 0.5 );
  if ( d > 0.5 ) discard;
  float glow = pow( 1.0 - d * 2.0, 2.0 );

  gl_FragColor = vec4( uColor * uIntensity, glow * vAlpha );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  ${ADDITIVE_FOG_CHUNK}
}
`;

export function createMoteMaterial(shared, {
  color = 0x7dd3fc,
  intensity = 1.2,
  height = 12,
  size = 1,
} = {}) {
  return new THREE.ShaderMaterial({
    name: 'InnovationMoteMaterial',
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: shared.uTime,
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
      uHeight: { value: height },
      uSize: { value: size },
      uPointScale: { value: 800 },
      uMaxPointSize: { value: 48 },
      uAppear: { value: 0 },
    },
    vertexShader: MOTE_VERTEX,
    fragmentShader: MOTE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
}
