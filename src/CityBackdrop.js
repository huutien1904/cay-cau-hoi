import * as THREE from 'three';

/*
 * CityBackdrop — phông nền thành phố đêm tím neon 360° phía sau cây (vẽ hoàn toàn bằng code).
 *
 *  - Canvas 2D vẽ một dải đường chân trời liền mạch: 3 lớp nhà cao tầng (xa → gần),
 *    cửa sổ sáng tím / hồng tím, lác đác ánh cam, đèn đỏ trên đỉnh tháp.
 *  - Shader trên mái vòm bao quanh camera ghép dải đó với bầu trời, sao lấp lánh,
 *    vệt sáng rơi và mặt nước phản chiếu gợn sóng.
 *  - Mái vòm luôn đi theo camera nên thành phố như ở rất xa, không bị sương che.
 */

const PALETTE = {
  skyTop: '#06030e',
  skyMid: '#170a36',
  haze: '#5a2bb0',
  waterTop: '#120828',
  waterDeep: '#040209',
  streak: '#9f7aff',
  fog: '#0e0820',
  // Màu thân nhà và lớp sương phủ cho từng lớp (xa → gần).
  layers: [
    { body: '#2a1760', haze: 'rgba(120, 70, 220, 0.35)' },
    { body: '#170c3a', haze: 'rgba(90, 50, 190, 0.18)' },
    { body: '#0b0620', haze: null },
  ],
  windows: ['#a78bfa', '#a78bfa', '#c084fc', '#8b5cf6', '#7c3aed', '#e9d5ff', '#f0abfc'],
  warm: ['#fb923c', '#fdba74', '#f97316'],
};

// Mức "xoá phông" để cây nổi bật: tăng BLUR / FADE hoặc giảm INTENSITY để nền lùi xa hơn.
const DEFAULT_LOOK = {
  blur: 3.2, // độ nhoè thành phố (1 = nét, 3–5 = mờ như ống kính xoá phông)
  fade: 0.4, // phủ sương tím lên toà nhà (0 = rõ, 1 = chìm hẳn vào sương)
  intensity: 0.72, // độ sáng tổng thể của nền (1 = gốc)
  sparkle: 0.45, // độ sáng sao & vệt sáng rơi (1 = gốc)
};

const TEXTURE_WIDTH = 4096;
const TEXTURE_HEIGHT = 440;
// Dải chân trời lặp 2 lần quanh 360° để chữ nhật cửa sổ đủ nét trên màn hình lớn.
const REPEAT = 2;
// Chiều cao (radian) mà dải texture phủ lên bầu trời, giữ tỉ lệ điểm ảnh vuông.
const BAND = (TEXTURE_HEIGHT / TEXTURE_WIDTH) * ((Math.PI * 2) / REPEAT);

export class CityBackdrop {
  /**
   * @param {{ horizon?: number, intensity?: number, seed?: number }} options
   *   horizon: dịch đường chân trời (radian). Để 0 thì chân trời nằm đúng tầm mắt như mặt nước thật
   *   và luôn là đường thẳng; khác 0 thì đường chân trời bị cong khi camera nhìn chếch.
   */
  constructor({ horizon = 0, seed = 7, ...look } = {}) {
    const { blur, fade, intensity, sparkle } = { ...DEFAULT_LOOK, ...look };
    this.random = mulberry32(seed);
    this.texture = this._drawSkyline();
    this.fogColor = new THREE.Color(PALETTE.fog);

    this.uniforms = {
      uSkyline: { value: this.texture },
      uTime: { value: 0 },
      uBand: { value: BAND },
      uRepeat: { value: REPEAT },
      uHorizon: { value: horizon },
      uIntensity: { value: intensity },
      uBlur: { value: blur },
      uFade: { value: fade },
      uSparkle: { value: sparkle },
      uSkyTop: { value: new THREE.Color(PALETTE.skyTop) },
      uSkyMid: { value: new THREE.Color(PALETTE.skyMid) },
      uHaze: { value: new THREE.Color(PALETTE.haze) },
      uWaterTop: { value: new THREE.Color(PALETTE.waterTop) },
      uWaterDeep: { value: new THREE.Color(PALETTE.waterDeep) },
      uStreak: { value: new THREE.Color(PALETTE.streak) },
    };

    const material = new THREE.ShaderMaterial({
      name: 'CityBackdropMaterial',
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), material);
    this.mesh.name = 'CityBackdrop';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    // Luôn đặt tâm mái vòm tại camera → hoạt động như bầu trời ở xa vô tận.
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      this.mesh.position.copy(camera.position);
      this.mesh.updateMatrixWorld();
    };
  }

  update(elapsed) {
    this.uniforms.uTime.value = elapsed;
  }

  dispose() {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  /* ------------------------------------------------------------------------ */
  /*  Vẽ đường chân trời                                                       */
  /* ------------------------------------------------------------------------ */

  _drawSkyline() {
    const W = TEXTURE_WIDTH;
    const H = TEXTURE_HEIGHT;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const random = this.random;

    const layerSpecs = [
      // lớp xa: thấp, dày đặc, mờ trong sương tím
      { count: 300, minW: 8, maxW: 24, minH: 0.07, maxH: 0.26, cell: 3, lit: 0.2, light: 0.42 },
      // lớp giữa
      { count: 190, minW: 12, maxW: 34, minH: 0.12, maxH: 0.42, cell: 3.5, lit: 0.24, light: 0.7 },
      // lớp gần: ít nhưng cao, cửa sổ sáng rõ
      { count: 80, minW: 16, maxW: 44, minH: 0.22, maxH: 0.64, cell: 4, lit: 0.3, light: 1 },
    ];

    layerSpecs.forEach((spec, layerIndex) => {
      const palette = PALETTE.layers[layerIndex];
      for (let i = 0; i < spec.count; i++) {
        const w = lerp(spec.minW, spec.maxW, random());
        // Phân bố chiều cao lệch về thấp, thỉnh thoảng có toà rất cao.
        const h = lerp(spec.minH, spec.maxH, Math.pow(random(), 1.6)) * H;
        const x = random() * W;
        const seed = random();
        // Vẽ lặp ở mép để dải texture nối liền khi quấn quanh 360°.
        for (const offset of [0, -W, W]) {
          if (x + offset + w < 0 || x + offset > W) continue;
          this._building(ctx, x + offset, w, h, H, spec, palette, seed);
        }
      }
      // Phủ sương tím lên riêng lớp vừa vẽ (source-atop) để tạo chiều sâu.
      if (palette.haze) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        const gradient = ctx.createLinearGradient(0, 0, 0, H);
        gradient.addColorStop(0, 'rgba(0,0,0,0)');
        gradient.addColorStop(1, palette.haze);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 8;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    return texture;
  }

  _building(ctx, x, w, h, H, spec, palette, seed) {
    // Dùng bộ sinh số riêng cho từng toà nhà để bản vẽ lặp ở mép giống hệt bản gốc.
    const random = mulberry32(Math.floor(seed * 1e9));
    const top = H - h;
    ctx.fillStyle = palette.body;
    ctx.fillRect(x, top, w, h);

    // Mái: bậc thang hoặc chóp ăng-ten.
    const roof = random();
    let beaconY = null;
    if (roof < 0.28 && h > H * 0.3) {
      const w2 = w * lerp(0.35, 0.7, random());
      const h2 = h * lerp(0.05, 0.12, random());
      ctx.fillRect(x + (w - w2) / 2, top - h2, w2, h2);
      if (random() < 0.5) {
        ctx.fillRect(x + w / 2 - 0.75, top - h2 - h * 0.12, 1.5, h * 0.12);
        beaconY = top - h2 - h * 0.12;
      }
    } else if (roof < 0.45 && h > H * 0.45) {
      ctx.fillRect(x + w / 2 - 1, top - h * 0.16, 2, h * 0.16);
      beaconY = top - h * 0.16;
    }

    // Cửa sổ.
    const cw = spec.cell;
    const ch = spec.cell * 1.55;
    const litChance = spec.lit * lerp(0.5, 1.6, random());
    const warmTower = random() < 0.12;
    for (let wy = top + ch * 0.8; wy < H - ch * 0.6; wy += ch) {
      // Cả tầng tắt đèn đôi khi, trông tự nhiên hơn.
      if (random() < 0.12) continue;
      for (let wx = x + cw * 0.6; wx < x + w - cw * 0.8; wx += cw) {
        if (random() > litChance) continue;
        const warm = warmTower ? random() < 0.5 : random() < 0.04;
        const colors = warm ? PALETTE.warm : PALETTE.windows;
        ctx.globalAlpha = spec.light * lerp(0.55, 1, random());
        ctx.fillStyle = colors[Math.floor(random() * colors.length)];
        ctx.fillRect(wx, wy, cw * 0.5, ch * 0.42);
      }
    }
    ctx.globalAlpha = 1;

    // Dải đèn viền dọc cạnh toà nhà (neon).
    if (random() < 0.14 && h > H * 0.25) {
      ctx.globalAlpha = spec.light * 0.8;
      ctx.fillStyle = random() < 0.5 ? '#c084fc' : '#8b5cf6';
      ctx.fillRect(random() < 0.5 ? x : x + w - 1.5, top + h * 0.05, 1.5, h * 0.9);
      ctx.globalAlpha = 1;
    }

    // Đèn đỏ / cam trên đỉnh tháp.
    if (beaconY !== null && spec.light > 0.5) {
      ctx.save();
      ctx.shadowColor = '#ff7a3d';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#ffb38a';
      ctx.beginPath();
      ctx.arc(x + w / 2, beaconY, 1.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

const VERTEX = /* glsl */ `
varying vec3 vWorldDir;

void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vWorldDir = world.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
#include <common>

uniform sampler2D uSkyline;
uniform float uTime;
uniform float uBand;
uniform float uRepeat;
uniform float uHorizon;
uniform float uIntensity;
uniform float uBlur;
uniform float uFade;
uniform float uSparkle;
uniform vec3 uSkyTop;
uniform vec3 uSkyMid;
uniform vec3 uHaze;
uniform vec3 uWaterTop;
uniform vec3 uWaterDeep;
uniform vec3 uStreak;

varying vec3 vWorldDir;

float hash21( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
}

// Lấy mẫu dải thành phố; chọn đạo hàm liên tục ở đường nối 0/1 để không lộ vệt khâu do mipmap.
vec4 sampleCity( float u, float v, vec2 blur ) {
  vec2 uv = vec2( u, v );
  vec2 uvAlt = vec2( fract( u + 0.5 ), v );
  vec2 dx = dFdx( uv );
  vec2 dy = dFdy( uv );
  vec2 dxAlt = dFdx( uvAlt );
  vec2 dyAlt = dFdy( uvAlt );
  if ( abs( dx.x ) > abs( dxAlt.x ) ) dx.x = dxAlt.x;
  if ( abs( dy.x ) > abs( dyAlt.x ) ) dy.x = dyAlt.x;
  dx *= blur;
  dy *= blur;
  return textureGrad( uSkyline, uv, dx, dy );
}

void main() {
  vec3 dir = normalize( vWorldDir );
  float azimuth = atan( dir.z, dir.x ) / PI2 + 0.5;
  float elevation = asin( clamp( dir.y, -1.0, 1.0 ) ) - uHorizon;
  float u = azimuth * uRepeat;
  vec3 color;

  if ( elevation >= 0.0 ) {
    // Bầu trời: tím đậm ở trên, sáng dần về chân trời (ánh đèn thành phố hắt lên).
    vec3 sky = mix( uSkyMid, uSkyTop, smoothstep( 0.0, 1.1, elevation ) );
    sky += uHaze * exp( -elevation * 7.0 ) * 0.55;

    // Sao lấp lánh.
    vec2 starGrid = vec2( azimuth * 1200.0, elevation * 191.0 );
    vec2 cell = floor( starGrid );
    float h = hash21( cell );
    vec2 offset = vec2( hash21( cell + 1.7 ), hash21( cell + 9.3 ) ) - 0.5;
    float star = step( 0.972, h ) * ( 1.0 - smoothstep( 0.0, 0.16, length( fract( starGrid ) - 0.5 - offset * 0.6 ) ) );
    star *= 0.45 + 0.55 * sin( uTime * ( 0.8 + h * 2.5 ) + h * 50.0 );
    sky += vec3( 0.8, 0.75, 1.0 ) * star * smoothstep( 0.05, 0.3, elevation ) * 0.7 * uSparkle;

    // Vệt sáng mảnh rơi chậm từ trên cao.
    float lane = floor( azimuth * 180.0 );
    float laneHash = hash21( vec2( lane, 4.1 ) );
    if ( laneHash > 0.86 ) {
      float across = abs( fract( azimuth * 180.0 ) - 0.5 );
      float line = 1.0 - smoothstep( 0.0, 0.03, across );
      float head = 1.0 - fract( uTime * ( 0.025 + laneHash * 0.05 ) + laneHash * 13.0 );
      float y = ( elevation - 0.15 ) / 1.0;
      float along = y - head;
      float trail = step( 0.0, along ) * ( 1.0 - smoothstep( 0.0, 0.35, along ) );
      sky += uStreak * line * trail * 0.45 * uSparkle;
    }

    vec4 city = elevation < uBand ? sampleCity( u, elevation / uBand, vec2( uBlur ) ) : vec4( 0.0 );
    // Sương phối cảnh: toà nhà chìm dần vào màu trời gần chân trời.
    vec3 building = mix( city.rgb, uSkyMid + uHaze * 0.25, uFade );
    color = mix( sky, building, city.a );
  } else {
    // Mặt nước: phản chiếu thành phố, gợn sóng và tối dần về phía gần.
    float depth = -elevation;
    float wobble = ( sin( depth * 140.0 + uTime * 1.1 ) * 0.6 + sin( depth * 70.0 - uTime * 0.7 + azimuth * 40.0 ) * 0.4 ) * 0.0005;
    vec4 city = sampleCity( u + wobble * uRepeat, min( depth / uBand, 0.999 ), vec2( uBlur, uBlur * 4.0 ) );
    vec3 skyReflect = uSkyMid * 0.7 + uHaze * exp( -depth * 7.0 ) * 0.35;
    vec3 reflection = mix( skyReflect, mix( city.rgb, uSkyMid, uFade ), city.a ) * 0.5 * exp( -depth * 2.6 );
    vec3 water = mix( uWaterTop, uWaterDeep, smoothstep( 0.0, 0.5, depth ) );
    color = water + reflection;
    color += uHaze * exp( -depth * 70.0 ) * 0.4;
  }

  gl_FragColor = vec4( color * uIntensity, 1.0 );

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
