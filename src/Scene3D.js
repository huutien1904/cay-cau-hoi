import * as THREE from 'three';
import gsap from 'gsap';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/*
 * Scene3D — quản lý Renderer, Scene, Camera, ánh sáng, OrbitControls và hậu kỳ Bloom.
 *
 * Pipeline màu: RenderPass → render target HalfFloat (HDR tuyến tính) → UnrealBloomPass
 * (chỉ lấy phần sáng hơn `threshold`) → OutputPass (ACES tone mapping + sRGB).
 * Vật liệu thân cây giữ độ sáng dưới ngưỡng nên chỉ nốt sáng / vệt năng lượng toả hào quang.
 */

const DEFAULTS = {
  background: 0x0a0d14,
  // Độ đậm sương tính theo khoảng cách camera nghỉ: exp(-(d·density)²) ≈ 0.8 tại tâm cây.
  fogVisibility: 0.46,
  fov: 42,
  exposure: 1.0,
  bloom: { strength: 0.8, radius: 0.5, threshold: 0.88 },
  autoRotateSpeed: 0.5,
  idleDelay: 3.5,
};

const _spherical = new THREE.Spherical();
const _endSpherical = new THREE.Spherical();
const _offset = new THREE.Vector3();

export class Scene3D {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Partial<typeof DEFAULTS>} options
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = {
      ...DEFAULTS,
      ...options,
      bloom: { ...DEFAULTS.bloom, ...(options.bloom || {}) },
    };
    this.device = detectDevice();
    this.maxPixelRatio = this.device.isMobile ? 1.75 : 2;
    // Chất lượng thích ứng: hạ dần khi máy không giữ nổi ~42 FPS (xem _monitorPerformance).
    this.resolutionScale = 1;
    this.qualityLevel = 0;
    this._perf = { elapsed: 0, frames: 0, cooldown: 1.5 };
    this.sizes = { width: 0, height: 0, pixelRatio: 0, pointScale: 1 };

    this.focus = {
      target: new THREE.Vector3(0, 5, 0),
      height: 10,
      radius: 6,
    };
    this.restDistance = 20;
    this.interactive = false;
    this.paused = false;
    this.focused = false;
    this._inset = { x: 0, y: 0 };
    this._insetTween = null;
    this._rotateLocked = false;
    this._viewTween = null;

    this._tickHandlers = new Set();
    this._resizeHandlers = new Set();
    this._resumeRotate = null;

    this.timer = new THREE.Timer();
    this.timer.connect(document);

    this._createRenderer();
    this._createScene();
    this._createCamera();
    this._createLights();
    this._createControls();
    this._createComposer();
    this._observeResize();

    this._tick = this._tick.bind(this);
  }

  /* ------------------------------------------------------------------------ */
  /*  Khởi tạo                                                                 */
  /* ------------------------------------------------------------------------ */

  _createRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false, // khử răng cưa bằng MSAA trên render target của composer
      alpha: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.options.exposure;
    this.renderer.setClearColor(this.options.background, 1);
  }

  _createScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.options.background);
    this.scene.fog = new THREE.FogExp2(this.options.background, 0.025);
  }

  _createCamera() {
    this.camera = new THREE.PerspectiveCamera(this.options.fov, 1, 0.1, 400);
    this.camera.position.set(0, 6, 24);
    this.scene.add(this.camera);
  }

  _createLights() {
    // Ánh sáng nền xanh lạnh, đủ để phần khuất không chìm hẳn vào nền.
    this.ambientLight = new THREE.AmbientLight(0x5b6f96, 1.1);

    // Đèn chính trắng xanh từ trước – phải – trên: tạo khối và góc cạnh cho vỏ cây.
    this.keyLight = new THREE.DirectionalLight(0xd6e6ff, 3.2);
    this.keyLight.position.set(8, 14, 10);

    // Đèn viền cyan từ phía sau – trái: tách silhouette cành khỏi nền tối.
    this.rimLight = new THREE.DirectionalLight(0x3fc3ff, 4.2);
    this.rimLight.position.set(-10, 8, -12);

    this.keyLight.target.position.copy(this.focus.target);
    this.rimLight.target.position.copy(this.focus.target);

    this.scene.add(this.ambientLight, this.keyLight, this.keyLight.target, this.rimLight, this.rimLight.target);
  }

  _createControls() {
    const controls = new OrbitControls(this.camera, this.canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.zoomSpeed = 0.9;
    controls.rotateSpeed = this.device.isTouch ? 0.85 : 0.65;

    // 1 ngón = xoay, 2 ngón = pinch-zoom (DOLLY_PAN với enablePan = false chỉ còn zoom).
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

    controls.minPolarAngle = 0.12;
    controls.maxPolarAngle = Math.PI * 0.52; // không cho camera chui xuống dưới mặt đất
    controls.autoRotate = false;
    controls.autoRotateSpeed = this.options.autoRotateSpeed;
    controls.target.copy(this.focus.target);
    controls.enabled = false;

    controls.addEventListener('start', () => {
      controls.autoRotate = false;
      this._resumeRotate?.kill();
      this._resumeRotate = null;
    });
    controls.addEventListener('end', () => this._scheduleAutoRotate(this.options.idleDelay));

    this.controls = controls;
  }

  _createComposer() {
    // MSAA chỉ đáng giá ở màn DPR thấp; màn Retina/HiDPI vốn đã mịn và MSAA trên HalfFloat rất tốn
    // (đo trên GPU tích hợp 1080p: 45 ms/khung có MSAA 4x so với 17 ms không MSAA).
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: this.device.isMobile || pixelRatio >= 1.5 ? 0 : 4,
    });
    renderTarget.texture.name = 'InnovationTree.hdr';

    this.composer = new EffectComposer(this.renderer, renderTarget);
    this.renderPass = new RenderPass(this.scene, this.camera);

    const { strength, radius, threshold } = this.options.bloom;
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), strength, radius, threshold);

    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.outputPass);
  }

  _observeResize() {
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(this.canvas);
    this.resize();
  }

  /* ------------------------------------------------------------------------ */
  /*  Resize & khung hình                                                      */
  /* ------------------------------------------------------------------------ */

  resize() {
    const width = Math.max(1, Math.round(this.canvas.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.round(this.canvas.clientHeight || window.innerHeight));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio) * this.resolutionScale;
    const { sizes } = this;
    if (sizes.width === width && sizes.height === height && sizes.pixelRatio === pixelRatio) return;

    sizes.width = width;
    sizes.height = height;
    sizes.pixelRatio = pixelRatio;

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this._inset) this._applyViewOffset();

    // Số pixel (trên drawing buffer) ứng với 1 đơn vị thế giới ở khoảng cách 1 — cho THREE.Points.
    sizes.pointScale = (height * pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));

    this._updateFraming();
    for (const handler of this._resizeHandlers) handler(sizes);
    // Đổi kích thước canvas sẽ xoá nội dung: vẽ lại một khung nếu đang tạm dừng.
    if (this.paused) this.composer.render(0);
  }

  /**
   * Căn camera theo kích thước cây đã chuẩn hoá.
   * @param {{ height: number, radius: number }} bounds
   */
  frameTree(bounds) {
    this.focus.height = bounds.height;
    this.focus.radius = bounds.radius;
    this.focus.target.set(0, bounds.height * 0.5, 0);
    this.controls.target.copy(this.focus.target);
    this.keyLight.target.position.copy(this.focus.target);
    this.rimLight.target.position.copy(this.focus.target);
    this._updateFraming();
    this._applyPose(this.getIntroPose());
  }

  _fitDistance() {
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const portrait = this.camera.aspect < 1;
    const halfHeight = this.focus.height * 0.56;
    // Màn dọc: cho phép ngọn cành ngoài cùng hơi tràn mép để cây không bị bé.
    const halfWidth = this.focus.radius * (portrait ? 0.88 : 1.02);
    const byHeight = halfHeight / Math.tan(vFov / 2);
    const byWidth = halfWidth / Math.tan(hFov / 2);
    return Math.max(byHeight, byWidth) + this.focus.radius * 0.55;
  }

  _updateFraming() {
    this.restDistance = this._fitDistance();
    this.controls.minDistance = this.focus.height * 0.42;
    this.controls.maxDistance = this.restDistance * 1.7;
    this.scene.fog.density = this.options.fogVisibility / this.restDistance;
  }

  getRestPose() {
    return { radius: this.restDistance, phi: 1.46, theta: 0.35 };
  }

  getIntroPose() {
    return { radius: this.restDistance * 1.9, phi: 1.52, theta: 0.35 - 1.7 };
  }

  _applyPose({ radius, phi, theta }) {
    _spherical.set(radius, phi, theta);
    this.camera.position.setFromSpherical(_spherical).add(this.controls.target);
    this.camera.lookAt(this.controls.target);
  }

  /**
   * Camera bay vòng từ xa vào vị trí nghỉ (trả về tween GSAP để main.js ghép vào timeline).
   */
  flyIn({ duration = 4.6, ease = 'power3.inOut' } = {}) {
    const from = this.getIntroPose();
    const to = this.getRestPose();
    const pose = { ...from };
    this._applyPose(pose);
    return gsap.to(pose, {
      radius: to.radius,
      phi: to.phi,
      theta: to.theta,
      duration,
      ease,
      onUpdate: () => this._applyPose(pose),
    });
  }

  /* ------------------------------------------------------------------------ */
  /*  Tương tác                                                                */
  /* ------------------------------------------------------------------------ */

  enableInteraction() {
    this.interactive = true;
    this.controls.enabled = true;
    this._scheduleAutoRotate(1.2);
  }

  _scheduleAutoRotate(delay) {
    if (this.device.reducedMotion || this._rotateLocked) return;
    this._resumeRotate?.kill();
    this._resumeRotate = gsap.delayedCall(delay, () => {
      this.controls.autoRotate = true;
      this._resumeRotate = null;
    });
  }

  _lockAutoRotate(locked) {
    this._rotateLocked = locked;
    if (locked) {
      this.controls.autoRotate = false;
      this._resumeRotate?.kill();
      this._resumeRotate = null;
    }
  }

  /**
   * Camera bay tới một điểm (nốt sáng): điểm đó thành tâm xoay, giữ gần hướng nhìn hiện tại.
   * @param {THREE.Vector3} point
   */
  focusOn(point, { distance = this.focus.height * 0.5, duration = 1.5, direction = null } = {}) {
    this.focused = true;
    this._lockAutoRotate(true);
    // direction: hướng từ điểm tới camera mong muốn (ví dụ hướng ra ngoài tán để không bị thân cây che).
    const offset = direction ? _offset.copy(direction) : _offset.copy(this.camera.position).sub(this.controls.target);
    _endSpherical.setFromVector3(offset);
    _endSpherical.radius = Math.max(distance, this.controls.minDistance);
    // Đang nhìn quá dốc thì kéo về gần phương ngang để thấy rõ nốt trên cành.
    _endSpherical.phi = THREE.MathUtils.clamp(_endSpherical.phi, 0.95, 1.4);
    return this._tweenView(point, _endSpherical, duration);
  }

  /** Quay về toàn cảnh cây. */
  resetFocus({ duration = 1.5 } = {}) {
    this.focused = false;
    const offset = _offset.copy(this.camera.position).sub(this.controls.target);
    _endSpherical.setFromVector3(offset);
    _endSpherical.radius = this.restDistance;
    _endSpherical.phi = THREE.MathUtils.clamp(_endSpherical.phi, 1.1, 1.5);
    const tween = this._tweenView(this.focus.target, _endSpherical, duration);
    tween.eventCallback('onComplete', () => {
      this.controls.enabled = this.interactive && !this.paused;
      if (this.focused || this.paused) return;
      this._lockAutoRotate(false);
      this._scheduleAutoRotate(this.options.idleDelay);
    });
    return tween;
  }

  _tweenView(target, endSpherical, duration) {
    this._viewTween?.kill();
    this.controls.enabled = false;

    const startTarget = this.controls.target.clone();
    const endTarget = target.clone();
    const start = new THREE.Spherical().setFromVector3(_offset.copy(this.camera.position).sub(startTarget));
    const end = endSpherical.clone();
    // Đi đường vòng ngắn nhất quanh trục đứng.
    let deltaTheta = end.theta - start.theta;
    deltaTheta = Math.atan2(Math.sin(deltaTheta), Math.cos(deltaTheta));

    const progress = { t: 0 };
    const current = new THREE.Spherical();
    const duration_ = this.device.reducedMotion ? Math.min(duration, 0.4) : duration;

    this._viewTween = gsap.to(progress, {
      t: 1,
      duration: duration_,
      ease: 'power3.inOut',
      onUpdate: () => {
        const t = progress.t;
        this.controls.target.lerpVectors(startTarget, endTarget, t);
        current.set(
          THREE.MathUtils.lerp(start.radius, end.radius, t),
          THREE.MathUtils.lerp(start.phi, end.phi, t),
          start.theta + deltaTheta * t,
        );
        this.camera.position.setFromSpherical(current).add(this.controls.target);
        this.camera.lookAt(this.controls.target);
      },
      onComplete: () => {
        this.controls.enabled = this.interactive && !this.paused;
      },
    });
    return this._viewTween;
  }

  /**
   * Dịch tâm khung hình khi một phần màn hình bị panel che (camera.setViewOffset).
   * @param {{ right?: number, bottom?: number }} inset kích thước vùng bị che, tính bằng CSS pixel
   */
  setViewInset({ right = 0, bottom = 0 } = {}) {
    this._insetTween?.kill();
    this._insetTween = gsap.to(this._inset, {
      x: right / 2,
      y: bottom / 2,
      duration: this.device.reducedMotion ? 0 : 0.9,
      ease: 'power3.inOut',
      onUpdate: () => this._applyViewOffset(),
    });
  }

  _applyViewOffset() {
    const { width, height } = this.sizes;
    const { x, y } = this._inset;
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(width, height, x, y, width, height);
  }

  /** Dừng render khi tán cây bị che hoàn toàn (đang xem section khác) để tiết kiệm pin. */
  setPaused(paused) {
    this.paused = paused;
    this.controls.enabled = !paused && this.interactive && !this._viewTween?.isActive();
    if (paused) this._lockAutoRotate(true);
    else if (!this.focused) {
      this._lockAutoRotate(false);
      this._scheduleAutoRotate(this.options.idleDelay);
    }
  }

  /**
   * Chiếu một điểm 3D ra toạ độ CSS pixel của canvas.
   * @returns {{ x: number, y: number, depth: number, visible: boolean }}
   */
  project(point, target = { x: 0, y: 0, depth: 0, visible: false }) {
    _offset.copy(point).applyMatrix4(this.camera.matrixWorldInverse);
    target.depth = -_offset.z;
    _offset.applyMatrix4(this.camera.projectionMatrix);
    target.x = (_offset.x * 0.5 + 0.5) * this.sizes.width;
    target.y = (-_offset.y * 0.5 + 0.5) * this.sizes.height;
    target.visible = target.depth > this.camera.near && Math.abs(_offset.x) <= 1.1 && Math.abs(_offset.y) <= 1.1;
    return target;
  }

  /* ------------------------------------------------------------------------ */
  /*  Vòng lặp render                                                          */
  /* ------------------------------------------------------------------------ */

  /** @param {(elapsed: number, delta: number) => void} handler */
  onTick(handler) {
    this._tickHandlers.add(handler);
    return () => this._tickHandlers.delete(handler);
  }

  /** @param {(sizes: { width: number, height: number, pixelRatio: number, pointScale: number }) => void} handler */
  onResize(handler) {
    this._resizeHandlers.add(handler);
    if (this.sizes.width > 0) handler(this.sizes);
    return () => this._resizeHandlers.delete(handler);
  }

  start() {
    this.renderer.setAnimationLoop(this._tick);
  }

  stop() {
    this.renderer.setAnimationLoop(null);
  }

  _tick(timestamp) {
    this.timer.update(timestamp);
    const rawDelta = this.timer.getDelta();
    const delta = Math.min(rawDelta, 1 / 20);
    const elapsed = this.timer.getElapsed();

    if (this.paused) return;
    this._monitorPerformance(rawDelta);

    this.controls.update(delta);
    for (const handler of this._tickHandlers) handler(elapsed, delta);
    this.composer.render(delta);
  }

  /* ------------------------------------------------------------------------ */
  /*  Chất lượng thích ứng                                                     */
  /* ------------------------------------------------------------------------ */

  _monitorPerformance(delta) {
    // Chỉ đo khi đã tương tác được (intro có biên dịch shader, không đại diện).
    if (!this.interactive || delta > 0.25) return;
    const perf = this._perf;
    if (perf.cooldown > 0) {
      perf.cooldown -= delta;
      return;
    }
    perf.elapsed += delta;
    perf.frames++;
    if (perf.frames < 90) return;
    const average = perf.elapsed / perf.frames;
    perf.elapsed = 0;
    perf.frames = 0;
    if (average > 1 / 42) this._degradeQuality();
  }

  _degradeQuality() {
    const steps = [
      { applies: () => this.composer.renderTarget1.samples > 0, apply: () => this._setSamples(0) },
      { applies: () => this.resolutionScale > 0.85, apply: () => this._setResolutionScale(0.85) },
      { applies: () => this.resolutionScale > 0.7, apply: () => this._setResolutionScale(0.7) },
    ];
    const step = steps.find((candidate) => candidate.applies());
    if (!step) return;
    step.apply();
    this.qualityLevel++;
    this._perf.cooldown = 1.5;
  }

  _setSamples(samples) {
    for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      target.samples = samples;
      target.dispose(); // three.js tạo lại bộ đệm với số mẫu mới ở lần render kế tiếp
    }
  }

  _setResolutionScale(scale) {
    this.resolutionScale = scale;
    this.sizes.pixelRatio = 0; // ép resize() áp dụng lại
    this.resize();
  }

  dispose() {
    this.stop();
    this._resumeRotate?.kill();
    this._viewTween?.kill();
    this._resizeObserver.disconnect();
    this.timer.dispose();
    this.controls.dispose();
    this.bloomPass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}

function detectDevice() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const isTouch = coarse || navigator.maxTouchPoints > 0;
  const smallScreen = Math.min(window.screen.width, window.screen.height) <= 820;
  return {
    isTouch,
    isMobile: coarse && smallScreen,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}
