import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  createEnergyUniforms,
  createBarkUniforms,
  patchBarkMaterial,
  createNodeMaterial,
  createLeafMaterial,
  createGroundMaterial,
  createMoteMaterial,
} from './Shaders/EnergyShader.js';

/*
 * TreeLoader — load thân cây .glb (không có lá) rồi tự phủ hệ nốt sáng / lá / năng lượng.
 *
 * Quy trình:
 *  1. Load GLB (EXT_meshopt_compression + KHR_mesh_quantization → cần MeshoptDecoder).
 *  2. Đổi vị trí đỉnh từ Int16 lượng tử hoá sang Float32 rồi mới áp ma trận của node
 *     (áp trực tiếp lên attribute normalized sẽ bị kẹp về [-1, 1] làm méo cây).
 *  3. Chuẩn hoá: gốc tại y = 0, trục thân ở x = z = 0, cao `targetHeight`.
 *  4. Đo dáng cây theo từng dải độ cao: bán kính thân, chiều cao phân cành, vùng rễ.
 *  5. Tính `aEnergy` cho mỗi đỉnh: quãng đường xấp xỉ từ đầu rễ → thân → ngọn (0..1).
 *  6. Quét đỉnh phía trên, hướng ra ngoài của tán → chọn vị trí nốt sáng và cụm lá.
 */

const QUALITY = {
  high: { nodeCount: 360, maxNodes: 900, heroCount: 0, leafClusters: 1000, leavesPerCluster: 7, nodeSparkles: 5, moteCount: 320 },
  low: { nodeCount: 240, maxNodes: 600, heroCount: 0, leafClusters: 600, leavesPerCluster: 6, nodeSparkles: 3, moteCount: 160 },
};

const DEFAULTS = {
  targetHeight: 10,
  quality: 'high',
  seed: 20260922,
  palette: {
    bark: 0x3a4a63,
    energy: 0x22d3ee,
    energyHot: 0xc4f5ff,
    rim: 0x3b9dff,
    nodeA: 0x22d3ee,
    nodeB: 0x3b82f6,
    nodeHot: 0xe6fbff,
    leafA: 0x0ea5e9,
    leafB: 0x22d3ee,
    leafHot: 0xd9f7ff,
    ground: 0x22d3ee,
    groundB: 0x1d4ed8,
    mote: 0x7dd3fc,
    canopyLight: 0x38bdf8,
  },
};

const PROFILE_BANDS = 32;
const GRID_OFFSET = 512;
const GRID_SPAN = 1024;

export class TreeLoader {
  /**
   * @param {{ targetHeight?: number, quality?: 'high' | 'low', seed?: number, palette?: object }} options
   */
  constructor(options = {}) {
    this.options = {
      ...DEFAULTS,
      ...options,
      palette: { ...DEFAULTS.palette, ...(options.palette || {}) },
    };
    this.settings = { ...(QUALITY[this.options.quality] || QUALITY.high) };
    // Số nốt theo dữ liệu thật (mỗi sáng kiến đang sống = một nốt), giới hạn theo chất lượng máy.
    if (options.nodeCount) this.settings.nodeCount = Math.min(options.nodeCount, this.settings.maxNodes);
    this.random = mulberry32(this.options.seed);

    this.group = new THREE.Group();
    this.group.name = 'QuestionTree';

    this.shared = createEnergyUniforms();
    this.barkUniforms = createBarkUniforms({
      energyColor: this.options.palette.energy,
      energyHot: this.options.palette.energyHot,
      rimColor: this.options.palette.rim,
    });

    this.bounds = null;
    this.profile = null;
    this.canopy = null;
    this.bark = null;
    this.nodes = null;
    this.heroAnchors = [];
    this.leaves = null;
    this.ground = null;
    this.motes = null;
    this.canopyLight = null;
    this.reveal = null;
    this._lightAppear = { value: 0 };
    this._lightBaseIntensity = 0;
  }

  /**
   * @param {string} url
   * @param {{ onProgress?: (ratio: number) => void, onStatus?: (status: 'download' | 'build') => void }} callbacks
   */
  async load(url, { onProgress, onStatus } = {}) {
    onStatus?.('download');
    const gltf = await this._loadGLTF(url, onProgress);

    onStatus?.('build');
    await nextFrame();

    const geometry = this._extractGeometry(gltf.scene);
    this.bounds = this._normalize(geometry);
    this.profile = this._profileTrunk(geometry);
    this._computeEnergyPath(geometry);

    this.bark = this._createBark(geometry);
    const candidates = this._analyzeCanopy(geometry);
    this.heroAnchors = this._pickHeroAnchors(candidates);
    this.nodes = this._createNodes(candidates, this.heroAnchors);
    this.leaves = this._createLeaves(candidates, this.nodes.userData.anchors);
    this.ground = this._createGround();
    this.motes = this._createMotes();
    this.canopyLight = this._createCanopyLight();

    this.group.add(this.ground, this.bark, this.nodes, this.leaves, this.motes, this.canopyLight);

    // Các uniform điều khiển intro (GSAP tween thẳng vào `.value`).
    this.reveal = {
      bark: this.barkUniforms.uReveal,
      nodes: this.nodes.material.uniforms.uAppear,
      leaves: this.leaves.material.uniforms.uAppear,
      ground: this.ground.material.uniforms.uAppear,
      motes: this.motes.material.uniforms.uAppear,
      light: this._lightAppear,
    };

    disposeGLTF(gltf);
    return { group: this.group, bounds: this.bounds };
  }

  update(elapsed) {
    this.shared.uTime.value = elapsed;
    if (this.canopyLight) {
      const breathe = 0.85 + 0.15 * Math.sin(elapsed * 1.3);
      this.canopyLight.intensity = this._lightBaseIntensity * breathe * this._lightAppear.value;
    }
  }

  /** Số pixel ứng với 1 đơn vị thế giới ở khoảng cách 1 (do Scene3D tính khi resize). */
  setPointScale(pointScale) {
    if (this.leaves) this.leaves.material.uniforms.uPointScale.value = pointScale;
    if (this.motes) this.motes.material.uniforms.uPointScale.value = pointScale;
  }

  dispose() {
    this.group.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) object.material.dispose();
    });
    this.group.clear();
  }

  /* ------------------------------------------------------------------------ */
  /*  1. Load                                                                  */
  /* ------------------------------------------------------------------------ */

  _loadGLTF(url, onProgress) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    return new Promise((resolve, reject) => {
      loader.load(
        url,
        resolve,
        (event) => {
          if (onProgress && event.lengthComputable && event.total > 0) {
            onProgress(event.loaded / event.total);
          }
        },
        (error) => reject(error instanceof Error ? error : new Error(`Không tải được mô hình: ${url}`)),
      );
    });
  }

  /* ------------------------------------------------------------------------ */
  /*  2. Gộp mesh + chuyển sang Float32                                        */
  /* ------------------------------------------------------------------------ */

  _extractGeometry(root) {
    root.updateMatrixWorld(true);
    const parts = [];

    root.traverse((child) => {
      if (!child.isMesh || !child.geometry || !child.geometry.getAttribute('position')) return;
      const source = child.geometry;
      const part = new THREE.BufferGeometry();
      part.setAttribute('position', toFloat32Attribute(source.getAttribute('position')));
      if (source.getAttribute('normal')) {
        part.setAttribute('normal', toFloat32Attribute(source.getAttribute('normal')));
      }
      if (source.index) part.setIndex(source.index.clone());
      part.applyMatrix4(child.matrixWorld);
      if (!part.getAttribute('normal')) part.computeVertexNormals();
      parts.push(part);
    });

    if (parts.length === 0) throw new Error('File .glb không chứa mesh nào.');
    if (parts.length === 1) return parts[0];

    const allIndexed = parts.every((part) => part.index !== null);
    const mergeable = allIndexed ? parts : parts.map((part) => (part.index ? part.toNonIndexed() : part));
    const merged = mergeGeometries(mergeable, false);
    if (!merged) throw new Error('Không gộp được các mesh của cây.');
    return merged;
  }

  /* ------------------------------------------------------------------------ */
  /*  3. Chuẩn hoá kích thước & vị trí                                         */
  /* ------------------------------------------------------------------------ */

  _normalize(geometry) {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const rawHeight = box.max.y - box.min.y;
    if (!(rawHeight > 1e-5)) throw new Error('Mô hình cây bị phẳng (chiều cao bằng 0).');

    // Trục thân = trọng tâm các đỉnh ở dải 8%–25% chiều cao (trên phần rễ loe, dưới tán).
    const position = geometry.getAttribute('position');
    const y0 = box.min.y + rawHeight * 0.08;
    const y1 = box.min.y + rawHeight * 0.25;
    let sumX = 0;
    let sumZ = 0;
    let samples = 0;
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      if (y < y0 || y > y1) continue;
      sumX += position.getX(i);
      sumZ += position.getZ(i);
      samples++;
    }
    const axisX = samples > 0 ? sumX / samples : (box.min.x + box.max.x) / 2;
    const axisZ = samples > 0 ? sumZ / samples : (box.min.z + box.max.z) / 2;

    const scale = this.options.targetHeight / rawHeight;
    geometry.translate(-axisX, -box.min.y, -axisZ);
    geometry.scale(scale, scale, scale);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    let radius = 0;
    for (let i = 0; i < position.count; i++) {
      radius = Math.max(radius, Math.hypot(position.getX(i), position.getZ(i)));
    }

    return {
      height: this.options.targetHeight,
      radius,
      box: geometry.boundingBox.clone(),
      sphere: geometry.boundingSphere.clone(),
    };
  }

  /* ------------------------------------------------------------------------ */
  /*  4. Đo dáng cây                                                           */
  /* ------------------------------------------------------------------------ */

  _profileTrunk(geometry) {
    const position = geometry.getAttribute('position');
    const { height } = this.bounds;
    const count = new Uint32Array(PROFILE_BANDS);
    const sumR = new Float64Array(PROFILE_BANDS);
    const maxR = new Float64Array(PROFILE_BANDS);

    for (let i = 0; i < position.count; i++) {
      const band = Math.min(PROFILE_BANDS - 1, Math.max(0, Math.floor((position.getY(i) / height) * PROFILE_BANDS)));
      const r = Math.hypot(position.getX(i), position.getZ(i));
      count[band]++;
      sumR[band] += r;
      if (r > maxR[band]) maxR[band] = r;
    }

    // Bán kính thân = dải hẹp nhất ở nửa dưới cây.
    let trunkRadius = Infinity;
    let narrowBand = 0;
    const lowerLimit = Math.floor(PROFILE_BANDS * 0.55);
    for (let b = Math.floor(PROFILE_BANDS * 0.04); b < lowerLimit; b++) {
      if (count[b] === 0) continue;
      const avg = sumR[b] / count[b];
      if (avg < trunkRadius) {
        trunkRadius = avg;
        narrowBand = b;
      }
    }
    if (!Number.isFinite(trunkRadius)) trunkRadius = this.bounds.radius * 0.08;

    // Điểm phân cành = dải đầu tiên phía trên thân mà cành vươn xa gấp ~3 lần bán kính thân.
    let forkBand = Math.floor(PROFILE_BANDS * 0.35);
    for (let b = narrowBand; b < PROFILE_BANDS; b++) {
      if (maxR[b] > trunkRadius * 3.2) {
        forkBand = b;
        break;
      }
    }

    // Đỉnh vùng rễ = dải đầu tiên (từ dưới lên) mà bề rộng đã thu về gần bằng thân.
    let rootBand = Math.max(1, Math.floor(PROFILE_BANDS * 0.1));
    for (let b = 0; b <= narrowBand; b++) {
      if (count[b] > 0 && sumR[b] / count[b] < trunkRadius * 1.35) {
        rootBand = Math.max(1, b);
        break;
      }
    }

    return {
      trunkRadius,
      forkY: (forkBand / PROFILE_BANDS) * height,
      rootTop: (rootBand / PROFILE_BANDS) * height,
    };
  }

  /* ------------------------------------------------------------------------ */
  /*  5. Đường năng lượng gốc → ngọn                                           */
  /* ------------------------------------------------------------------------ */

  /**
   * Quãng đường xấp xỉ từ đầu rễ tới một điểm trên cây.
   * - Rễ: điểm càng xa trục thân thì càng "sớm" (xung bắt đầu từ đầu rễ, dồn vào thân).
   * - Thân: đi thẳng theo độ cao.
   * - Tán: toả ra từ điểm phân cành theo khoảng cách 3D.
   */
  _rawPath(x, y, z) {
    const { trunkRadius, forkY, rootTop } = this.profile;
    const trunkEdge = trunkRadius * 1.15;
    const r = Math.hypot(x, z);
    if (y < forkY) {
      const rootWeight = 1 - smoothstep(0, rootTop, y);
      return y - Math.max(0, r - trunkEdge) * rootWeight;
    }
    const dy = y - forkY;
    return forkY + Math.max(0, Math.sqrt(dy * dy + r * r) - trunkEdge);
  }

  _pathAt(x, y, z) {
    const { min, max } = this.profile.path;
    return THREE.MathUtils.clamp((this._rawPath(x, y, z) - min) / (max - min), 0, 1);
  }

  _computeEnergyPath(geometry) {
    const position = geometry.getAttribute('position');
    const raw = new Float32Array(position.count);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < position.count; i++) {
      const value = this._rawPath(position.getX(i), position.getY(i), position.getZ(i));
      raw[i] = value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const range = Math.max(max - min, 1e-5);
    for (let i = 0; i < raw.length; i++) raw[i] = (raw[i] - min) / range;

    this.profile.path = { min, max: min + range };
    geometry.setAttribute('aEnergy', new THREE.BufferAttribute(raw, 1));

    const { forkY, rootTop } = this.profile;
    this.barkUniforms.uRootT.value = (rootTop - min) / range;
    this.barkUniforms.uForkT.value = (forkY - min) / range;
  }

  /* ------------------------------------------------------------------------ */
  /*  Thân cây                                                                 */
  /* ------------------------------------------------------------------------ */

  _createBark(geometry) {
    const material = new THREE.MeshStandardMaterial({
      name: 'InnovationBarkMaterial',
      color: this.options.palette.bark,
      roughness: 0.55,
      metalness: 0.25,
    });
    patchBarkMaterial(material, { ...this.shared, ...this.barkUniforms });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'TreeBark';
    return mesh;
  }

  /* ------------------------------------------------------------------------ */
  /*  6. Phân tích tán cây                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Quét các đỉnh ở phần trên cành (trên điểm phân cành, pháp tuyến không chúi xuống,
   * hướng ra ngoài tán), gom theo lưới không gian và giữ đỉnh "ngoài cùng" của mỗi ô.
   * @returns {Array<{x:number,y:number,z:number,nx:number,ny:number,nz:number,ox:number,oy:number,oz:number,score:number,path:number,angle:number}>}
   */
  _analyzeCanopy(geometry) {
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const minY = this.profile.forkY;

    // Khung bao của tán → tâm & bán kính elip.
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      if (y < minY) continue;
      const x = position.getX(i);
      const z = position.getZ(i);
      lo.set(Math.min(lo.x, x), Math.min(lo.y, y), Math.min(lo.z, z));
      hi.set(Math.max(hi.x, x), Math.max(hi.y, y), Math.max(hi.z, z));
    }
    const center = lo.clone().add(hi).multiplyScalar(0.5);
    const radii = hi.clone().sub(lo).multiplyScalar(0.5).max(new THREE.Vector3(1e-3, 1e-3, 1e-3));
    const canopyRadius = Math.max(radii.x, radii.z);
    this.canopy = { center, radii, radius: canopyRadius };

    const cell = canopyRadius / 30;
    const best = new Map();

    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      if (y < minY) continue;
      const x = position.getX(i);
      const z = position.getZ(i);
      const ny = normal.getY(i);
      if (ny < -0.35) continue; // bỏ mặt dưới của cành

      const dx = (x - center.x) / radii.x;
      const dy = (y - center.y) / radii.y;
      const dz = (z - center.z) / radii.z;
      const shell = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const ox = x - center.x;
      const oy = y - center.y;
      const oz = z - center.z;
      const oLength = Math.hypot(ox, oy, oz) || 1;
      const outward = (normal.getX(i) * ox + ny * oy + normal.getZ(i) * oz) / oLength;
      if (outward < -0.15) continue; // mặt quay vào trong tán

      const score = shell + ny * 0.12 + outward * 0.08;
      const key = gridKey(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
      const current = best.get(key);
      if (current === undefined || score > current.score) best.set(key, { index: i, score });
    }

    const candidates = [];
    for (const { index, score } of best.values()) {
      const x = position.getX(index);
      const y = position.getY(index);
      const z = position.getZ(index);
      const ox = x - center.x;
      const oy = y - center.y;
      const oz = z - center.z;
      const oLength = Math.hypot(ox, oy, oz) || 1;
      candidates.push({
        x,
        y,
        z,
        nx: normal.getX(index),
        ny: normal.getY(index),
        nz: normal.getZ(index),
        ox: ox / oLength,
        oy: oy / oLength,
        oz: oz / oLength,
        score,
        path: this._pathAt(x, y, z),
        angle: Math.atan2(z, x),
      });
    }
    return candidates;
  }

  /* ------------------------------------------------------------------------ */
  /*  Nốt sáng — InstancedMesh                                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * 5 đầu cành nổi bật nhất ở nửa trên tán, cách xa nhau — chỗ treo bóng đèn sáng kiến tiêu biểu.
   */
  _pickHeroAnchors(candidates) {
    if (!this.settings.heroCount) return [];
    const { forkY } = this.profile;
    const H = this.bounds.height;
    const minY = forkY + (H - forkY) * 0.3;
    const pool = candidates.filter((c) => c.y > minY && c.score > 0.8);
    const picked = selectSpaced(
      pool.length >= this.settings.heroCount ? pool : candidates,
      this.settings.heroCount,
      this.canopy.radius * 0.55,
      this.random,
      (c) => c.score + c.ny * 0.25,
    );
    const lift = H * 0.03;
    return picked.map((c) => {
      const x = c.x + c.nx * lift * 0.4 + c.ox * lift;
      const y = c.y + c.ny * lift * 0.4 + c.oy * lift + lift * 0.6;
      const z = c.z + c.nz * lift * 0.4 + c.oz * lift;
      return { x, y, z, path: this._pathAt(x, y, z), angle: Math.atan2(z, x), order: this._pathAt(x, y, z) };
    });
  }

  _createNodes(candidates, heroAnchors) {
    const random = this.random;
    const radius = this.canopy.radius;
    const heroClearanceSq = (radius * 0.12) ** 2;
    const free = candidates.filter((c) => heroAnchors.every((h) => (h.x - c.x) ** 2 + (h.y - c.y) ** 2 + (h.z - c.z) ** 2 > heroClearanceSq));
    const pool = free.filter((c) => c.score > 0.68);
    const wanted = this.settings.nodeCount;
    // Cần nhiều nốt hơn chỗ trống thì co dần khoảng cách tối thiểu giữa các nốt.
    let spacing = radius * 0.07;
    let anchors = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      anchors = selectSpaced(pool.length >= wanted ? pool : free, wanted, spacing, random, (c) => c.score);
      if (anchors.length >= wanted) break;
      spacing *= 0.8;
    }

    const count = anchors.length;
    const geometry = new THREE.IcosahedronGeometry(1, 2);
    const material = createNodeMaterial(this.shared, { hot: this.options.palette.nodeHot });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.name = 'InnovationNodes';
    mesh.frustumCulled = false;

    const phase = new Float32Array(count);
    const speed = new Float32Array(count);
    const path = new Float32Array(count);
    const angle = new Float32Array(count);
    const order = new Float32Array(count);
    const index = new Float32Array(count);
    const emphasis = new Float32Array(count).fill(1);
    const colors = new Float32Array(count * 3);

    // Ít nốt (ví dụ 100 lá câu hỏi) thì mỗi nốt to hơn cho dễ nhìn, dễ chạm.
    const baseSize = this.bounds.height * (count > 500 ? 0.0072 : count > 150 ? 0.0085 : 0.0125);
    const colorA = new THREE.Color(this.options.palette.nodeA);
    const colorB = new THREE.Color(this.options.palette.nodeB);
    const tint = new THREE.Color();
    const dummy = new THREE.Object3D();
    const placed = [];

    for (let i = 0; i < count; i++) {
      const c = anchors[i];
      const size = baseSize * lerp(0.75, 1.15, random());
      const lift = size * 0.8;
      const x = c.x + c.nx * lift;
      const y = c.y + c.ny * lift;
      const z = c.z + c.nz * lift;

      dummy.position.set(x, y, z);
      dummy.scale.setScalar(size);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      phase[i] = random() * Math.PI * 2;
      speed[i] = lerp(1.1, 2.6, random());
      path[i] = this._pathAt(x, y, z);
      angle[i] = Math.atan2(z, x);
      order[i] = path[i] * 0.85 + random() * 0.15;
      index[i] = i;
      tint.copy(colorA).lerp(colorB, random()).toArray(colors, i * 3);
      placed.push({ index: i, x, y, z, ox: c.ox, oy: c.oy, oz: c.oz, size, path: path[i], angle: angle[i], order: order[i] });
    }
    mesh.instanceMatrix.needsUpdate = true;

    geometry.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    geometry.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(speed, 1));
    geometry.setAttribute('aPath', new THREE.InstancedBufferAttribute(path, 1));
    geometry.setAttribute('aAngle', new THREE.InstancedBufferAttribute(angle, 1));
    geometry.setAttribute('aOrder', new THREE.InstancedBufferAttribute(order, 1));
    geometry.setAttribute('aIndex', new THREE.InstancedBufferAttribute(index, 1));
    geometry.setAttribute('aEmphasis', new THREE.InstancedBufferAttribute(emphasis, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(colors, 3));

    mesh.userData.anchors = placed;
    return mesh;
  }

  /* ------------------------------------------------------------------------ */
  /*  Hạt lá — THREE.Points                                                    */
  /* ------------------------------------------------------------------------ */

  _createLeaves(candidates, nodeAnchors) {
    const random = this.random;
    const { leafClusters, leavesPerCluster, nodeSparkles } = this.settings;
    const radius = this.canopy.radius;
    const H = this.bounds.height;

    const pool = candidates.filter((c) => c.score > 0.45);
    const clusters = selectSpaced(pool, leafClusters, radius * 0.035, random, (c) => c.score + c.ny * 0.2);

    const total = clusters.length * leavesPerCluster + nodeAnchors.length * nodeSparkles;
    const positions = new Float32Array(total * 3);
    const drift = new Float32Array(total * 3);
    const sizes = new Float32Array(total);
    const phases = new Float32Array(total);
    const speeds = new Float32Array(total);
    const tints = new Float32Array(total);
    const orders = new Float32Array(total);
    const paths = new Float32Array(total);
    const angles = new Float32Array(total);

    const direction = new THREE.Vector3();
    let n = 0;

    const writeParticle = (x, y, z, size, driftAmount, orderValue) => {
      positions[n * 3] = x;
      positions[n * 3 + 1] = y;
      positions[n * 3 + 2] = z;
      randomUnitVector(direction, random).multiplyScalar(driftAmount);
      drift[n * 3] = direction.x;
      drift[n * 3 + 1] = direction.y;
      drift[n * 3 + 2] = direction.z;
      sizes[n] = size;
      phases[n] = random() * Math.PI * 2;
      speeds[n] = lerp(0.8, 2.6, random());
      tints[n] = random();
      paths[n] = this._pathAt(x, y, z);
      angles[n] = Math.atan2(z, x);
      orders[n] = orderValue ?? paths[n] * 0.9 + random() * 0.1;
      n++;
    };

    // Cụm lá bám trên mặt cành, hơi hướng ra ngoài tán.
    const clusterRadius = H * 0.028;
    for (const c of clusters) {
      for (let k = 0; k < leavesPerCluster; k++) {
        randomUnitVector(direction, random).multiplyScalar(clusterRadius * Math.cbrt(random()));
        const normalLift = lerp(0.004, 0.02, random()) * H;
        const outwardLift = lerp(0, 0.018, random()) * H;
        const x = c.x + c.nx * normalLift + c.ox * outwardLift + direction.x;
        const y = c.y + c.ny * normalLift + c.oy * outwardLift + direction.y;
        const z = c.z + c.nz * normalLift + c.oz * outwardLift + direction.z;
        const sparkle = random() < 0.07;
        const size = H * (sparkle ? lerp(0.018, 0.024, random()) : lerp(0.006, 0.013, random()));
        writeParticle(x, y, z, size, H * 0.004, undefined);
      }
    }

    // Vài hạt li ti bao quanh mỗi nốt sáng tạo quầng lấp lánh.
    for (const a of nodeAnchors) {
      for (let k = 0; k < nodeSparkles; k++) {
        randomUnitVector(direction, random).multiplyScalar(a.size * lerp(1.6, 3.2, random()));
        writeParticle(a.x + direction.x, a.y + direction.y, a.z + direction.z, H * lerp(0.005, 0.01, random()), H * 0.003, a.order);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aDrift', new THREE.BufferAttribute(drift, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 1));
    geometry.setAttribute('aOrder', new THREE.BufferAttribute(orders, 1));
    geometry.setAttribute('aPath', new THREE.BufferAttribute(paths, 1));
    geometry.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1));
    geometry.computeBoundingSphere();

    const material = createLeafMaterial(this.shared, {
      colorA: this.options.palette.leafA,
      colorB: this.options.palette.leafB,
      hot: this.options.palette.leafHot,
    });
    const points = new THREE.Points(geometry, material);
    points.name = 'InnovationLeaves';
    points.frustumCulled = false;
    return points;
  }

  /* ------------------------------------------------------------------------ */
  /*  Vòng năng lượng dưới gốc                                                 */
  /* ------------------------------------------------------------------------ */

  _createGround() {
    const size = Math.max(this.canopy.radius, this.bounds.radius) * 3.2;
    const geometry = new THREE.PlaneGeometry(size, size, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = createGroundMaterial(this.shared, {
      color: this.options.palette.ground,
      colorB: this.options.palette.groundB,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'EnergyGround';
    mesh.position.y = this.bounds.height * 0.001;
    mesh.renderOrder = -1;
    return mesh;
  }

  /* ------------------------------------------------------------------------ */
  /*  Bụi sáng bay lên                                                         */
  /* ------------------------------------------------------------------------ */

  _createMotes() {
    const random = this.random;
    const count = this.settings.moteCount;
    const H = this.bounds.height;
    const spread = Math.max(this.canopy.radius, this.bounds.radius) * 1.35;
    const height = H * 1.25;

    const positions = new Float32Array(count * 3);
    const speeds = new Float32Array(count);
    const phases = new Float32Array(count);
    const sizes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const r = spread * Math.sqrt(random());
      const theta = random() * Math.PI * 2;
      positions[i * 3] = Math.cos(theta) * r;
      positions[i * 3 + 1] = random() * height;
      positions[i * 3 + 2] = Math.sin(theta) * r;
      speeds[i] = H * lerp(0.012, 0.045, random());
      phases[i] = random() * Math.PI * 2;
      sizes[i] = H * lerp(0.004, 0.011, random());
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    const material = createMoteMaterial(this.shared, { color: this.options.palette.mote, height });
    const points = new THREE.Points(geometry, material);
    points.name = 'EnergyMotes';
    points.frustumCulled = false;
    return points;
  }

  /* ------------------------------------------------------------------------ */
  /*  Đèn trong tán — nốt sáng "rọi" lên cành                                  */
  /* ------------------------------------------------------------------------ */

  _createCanopyLight() {
    const { center, radius } = this.canopy;
    // decay = 1 (falloff mềm hơn vật lý) để cành nằm sát đèn không bị cháy sáng khi zoom cận.
    const light = new THREE.PointLight(this.options.palette.canopyLight, 0, radius * 2.6, 1);
    light.name = 'CanopyGlow';
    light.position.set(center.x, center.y, center.z);
    this._lightBaseIntensity = radius * 0.9;
    return light;
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function toFloat32Attribute(attribute) {
  const { count, itemSize } = attribute;
  const array = new Float32Array(count * itemSize);
  for (let i = 0; i < count; i++) {
    const offset = i * itemSize;
    array[offset] = attribute.getX(i);
    if (itemSize > 1) array[offset + 1] = attribute.getY(i);
    if (itemSize > 2) array[offset + 2] = attribute.getZ(i);
    if (itemSize > 3) array[offset + 3] = attribute.getW(i);
  }
  return new THREE.BufferAttribute(array, itemSize);
}

/**
 * Chọn tối đa `count` điểm, ưu tiên điểm có trọng số cao, và giữ khoảng cách tối thiểu
 * giữa chúng (Poisson-disk kiểu tham lam trên lưới băm).
 */
function selectSpaced(candidates, count, minDistance, random, weight) {
  const ranked = candidates
    .map((candidate) => ({ candidate, rank: weight(candidate) * (0.7 + 0.3 * random()) }))
    .sort((a, b) => b.rank - a.rank);

  const cell = minDistance;
  const minDistanceSq = minDistance * minDistance;
  const grid = new Map();
  const picked = [];

  for (const { candidate: c } of ranked) {
    if (picked.length >= count) break;
    const ix = Math.floor(c.x / cell);
    const iy = Math.floor(c.y / cell);
    const iz = Math.floor(c.z / cell);

    let free = true;
    search: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(gridKey(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (const p of bucket) {
            const ddx = p.x - c.x;
            const ddy = p.y - c.y;
            const ddz = p.z - c.z;
            if (ddx * ddx + ddy * ddy + ddz * ddz < minDistanceSq) {
              free = false;
              break search;
            }
          }
        }
      }
    }
    if (!free) continue;

    const key = gridKey(ix, iy, iz);
    const bucket = grid.get(key);
    if (bucket) bucket.push(c);
    else grid.set(key, [c]);
    picked.push(c);
  }
  return picked;
}

function gridKey(ix, iy, iz) {
  return (ix + GRID_OFFSET) + (iy + GRID_OFFSET) * GRID_SPAN + (iz + GRID_OFFSET) * GRID_SPAN * GRID_SPAN;
}

function randomUnitVector(target, random) {
  const u = random() * 2 - 1;
  const theta = random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return target.set(s * Math.cos(theta), u, s * Math.sin(theta));
}

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

function smoothstep(edge0, edge1, x) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function disposeGLTF(gltf) {
  gltf.scene.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
  });
}
