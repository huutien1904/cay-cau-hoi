import * as THREE from 'three';
import gsap from 'gsap';
import { createRingTexture } from './utils/textures.js';

/*
 * LeafLayer — mỗi chiếc lá phát sáng trên cây là một câu hỏi.
 *
 *  - Lá chưa trả lời: xanh cyan, nhấp nháy theo nhịp năng lượng của cây.
 *  - Trả lời đúng: lá chuyển sang vàng kim, to và sáng rực hơn.
 *  - Trả lời sai: lá chuyển đỏ nhạt, thu nhỏ, mờ đi và bị khoá.
 *
 * Chọn lá bằng khoảng cách trên màn hình (dễ chạm trúng bằng ngón tay), hover hiện tooltip,
 * chọn lá thì camera bay tới lá đó.
 */

const STATE_STYLE = {
  correct: { color: new THREE.Color('#ffd27a'), emphasis: 1.45, ring: new THREE.Color('#ffd27a') },
  wrong: { color: new THREE.Color('#f87171'), emphasis: 0.32, ring: new THREE.Color('#f87171') },
};
const RING_COLOR = new THREE.Color('#7fe8ff');
const TAP_MAX_MOVE = 8;
const TAP_MAX_TIME = 450;

const _color = new THREE.Color();
const _outward = new THREE.Vector3();
const _viewDir = new THREE.Vector3();
const _screen = { x: 0, y: 0, depth: 0, visible: false };

export class LeafLayer {
  /**
   * @param {{ stage: import('./Scene3D.js').Scene3D, tree: import('./TreeLoader.js').TreeLoader, quiz: import('./data/QuizData.js').QuizData, progress: import('./data/QuizData.js').QuizProgress }} deps
   */
  constructor({ stage, tree, quiz, progress }) {
    this.stage = stage;
    this.tree = tree;
    this.quiz = quiz;
    this.progress = progress;
    this.height = tree.bounds.height;

    this.group = new THREE.Group();
    this.group.name = 'LeafLayer';
    tree.group.add(this.group);

    this.nodes = tree.nodes;
    this.uniforms = tree.nodes.material.uniforms;
    this.anchors = tree.nodes.userData.anchors;
    this.colorAttribute = tree.nodes.geometry.getAttribute('aColor');
    this.emphasisAttribute = tree.nodes.geometry.getAttribute('aEmphasis');
    this.emphasisTarget = new Float32Array(this.anchors.length);

    /** @type {Array<{ index: number, question: object, position: THREE.Vector3, radius: number, openColor: THREE.Color }>} */
    this.leaves = [];
    this.leafByQuestion = new Map();

    this.hovered = null;
    this.selected = null;
    /** Khoá chọn lá khác trong lúc đang hiện kết quả một câu trả lời. */
    this.locked = false;

    this._handlers = { hover: new Set(), select: new Set(), empty: new Set() };
    this._pointer = { x: 0, y: 0, inside: false, dirty: false };
    this._down = null;
    this._activePointers = new Set();
    this._frame = 0;
    this._ringTexture = createRingTexture();

    this._assignQuestions();
    this._createRings();
    this._bindPointer();
    this.syncStates({ animate: false });
  }

  /* ------------------------------------------------------------------------ */
  /*  Sự kiện                                                                  */
  /* ------------------------------------------------------------------------ */

  /** @param {'hover' | 'select' | 'empty'} event */
  on(event, handler) {
    this._handlers[event].add(handler);
    return () => this._handlers[event].delete(handler);
  }

  _emit(event, ...args) {
    for (const handler of this._handlers[event]) handler(...args);
  }

  /* ------------------------------------------------------------------------ */
  /*  Gán câu hỏi vào lá                                                       */
  /* ------------------------------------------------------------------------ */

  _assignQuestions() {
    const questions = this.quiz.questions;
    // Xếp lá từ gốc lên ngọn theo quãng đường năng lượng: câu 1 ở thấp, câu cuối ở ngọn.
    const anchors = [...this.anchors].sort((a, b) => a.path - b.path);
    const count = Math.min(anchors.length, questions.length);
    if (questions.length > anchors.length) {
      console.warn(`[QuestionTree] Cây chỉ có ${anchors.length} lá cho ${questions.length} câu hỏi.`);
    }

    for (let i = 0; i < count; i++) {
      const anchor = anchors[i];
      const question = questions[i];
      const openColor = new THREE.Color().fromArray(this.colorAttribute.array, anchor.index * 3);
      const leaf = {
        index: anchor.index,
        question,
        position: new THREE.Vector3(anchor.x, anchor.y, anchor.z),
        radius: anchor.size,
        openColor,
        state: 'open',
      };
      this.leaves.push(leaf);
      this.leafByQuestion.set(question.id, leaf);
    }
  }

  /** Áp trạng thái của mọi lá theo tiến độ đã lưu. */
  syncStates({ animate = false } = {}) {
    this.emphasisTarget.fill(0); // lá không có câu hỏi (nếu có) chỉ là mầm trang trí, mờ
    for (const leaf of this.leaves) {
      const result = this.progress.result(leaf.question.id);
      this.setLeafState(leaf, result ? result.result : 'open', { animate });
    }
    if (!animate) {
      for (let i = 0; i < this.emphasisTarget.length; i++) this.emphasisAttribute.setX(i, this.emphasisTarget[i]);
      this.emphasisAttribute.needsUpdate = true;
    }
  }

  /**
   * @param {object} leaf
   * @param {'open' | 'correct' | 'wrong'} state
   */
  setLeafState(leaf, state, { animate = true } = {}) {
    leaf.state = state;
    const style = STATE_STYLE[state];
    const targetColor = style ? style.color : leaf.openColor;
    this.emphasisTarget[leaf.index] = style ? style.emphasis : 1;

    const colors = this.colorAttribute;
    if (!animate) {
      colors.setXYZ(leaf.index, targetColor.r, targetColor.g, targetColor.b);
      colors.needsUpdate = true;
      return;
    }

    const from = new THREE.Color().fromArray(colors.array, leaf.index * 3);
    const proxy = { t: 0 };
    gsap.to(proxy, {
      t: 1,
      duration: 0.9,
      ease: 'power2.out',
      onUpdate: () => {
        _color.copy(from).lerp(targetColor, proxy.t);
        colors.setXYZ(leaf.index, _color.r, _color.g, _color.b);
        colors.needsUpdate = true;
      },
    });

    if (style) {
      // Lá loé sáng rồi dịu về độ sáng của trạng thái mới, kèm sóng vòng toả ra.
      this.emphasisAttribute.setX(leaf.index, state === 'correct' ? 3 : 1.6);
      this.emphasisAttribute.needsUpdate = true;
      this._burst(leaf, style.ring, state === 'correct' ? 9 : 5);
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Vòng chọn & sóng                                                         */
  /* ------------------------------------------------------------------------ */

  _sprite(color, { depthTest = true } = {}) {
    const material = new THREE.SpriteMaterial({
      map: this._ringTexture,
      color: color.clone(),
      transparent: true,
      depthWrite: false,
      depthTest,
      blending: THREE.AdditiveBlending,
    });
    return new THREE.Sprite(material);
  }

  _createRings() {
    this.selectionRing = this._sprite(_color.copy(RING_COLOR).multiplyScalar(2.2), { depthTest: false });
    this.selectionRing.renderOrder = 20;
    this.selectionRing.visible = false;
    this.group.add(this.selectionRing);

    this.burstPool = Array.from({ length: 4 }, () => {
      const ring = this._sprite(RING_COLOR);
      ring.visible = false;
      this.group.add(ring);
      return ring;
    });
  }

  _burst(leaf, color, spread) {
    const ring = this.burstPool.find((r) => !r.visible) || this.burstPool[0];
    const start = Math.max(leaf.radius * 3, this.height * 0.02);
    ring.material.color.copy(color).multiplyScalar(2.2);
    ring.position.copy(leaf.position);
    ring.visible = true;
    ring.material.opacity = 1;
    ring.scale.setScalar(start);
    gsap.killTweensOf([ring.scale, ring.material]);
    gsap.to(ring.scale, { x: start * spread, y: start * spread, duration: 1.6, ease: 'power2.out' });
    gsap.to(ring.material, {
      opacity: 0,
      duration: 1.6,
      ease: 'power1.in',
      onComplete: () => {
        ring.visible = false;
      },
    });
  }

  /* ------------------------------------------------------------------------ */
  /*  Chọn lá                                                                  */
  /* ------------------------------------------------------------------------ */

  select(leaf, { fly = true } = {}) {
    this.selected = leaf;
    this.uniforms.uSelected.value = leaf ? leaf.index : -1;
    this.selectionRing.visible = Boolean(leaf);
    if (leaf) {
      this.selectionRing.position.copy(leaf.position);
      if (fly) this.stage.focusOn(leaf.position, { distance: this.height * 0.85, direction: this._approachDirection(leaf) });
    }
    this._emit('select', leaf);
  }

  /** Hướng camera tiếp cận lá: từ trục thân ra phía lá (nhìn từ ngoài tán), pha chút hướng nhìn hiện tại. */
  _approachDirection(leaf) {
    _viewDir.copy(this.stage.camera.position).sub(this.stage.controls.target).normalize();
    _outward.set(leaf.position.x, 0, leaf.position.z);
    if (_outward.lengthSq() < 0.04) return _viewDir.clone();
    _outward.normalize();
    _outward.y = 0.35;
    return _outward.normalize().multiplyScalar(0.75).addScaledVector(_viewDir, 0.25).normalize();
  }

  deselect({ fly = true } = {}) {
    this.selected = null;
    this.uniforms.uSelected.value = -1;
    this.selectionRing.visible = false;
    if (fly && this.stage.focused) this.stage.resetFocus();
    this._emit('select', null);
  }

  /* ------------------------------------------------------------------------ */
  /*  Pointer: hover & chạm                                                    */
  /* ------------------------------------------------------------------------ */

  _bindPointer() {
    const canvas = this.stage.canvas;

    this._onPointerMove = (event) => {
      if (event.pointerType !== 'mouse') return;
      this._pointer.x = event.clientX;
      this._pointer.y = event.clientY;
      this._pointer.inside = true;
      this._pointer.dirty = true;
    };
    this._onPointerLeave = () => {
      this._pointer.inside = false;
      this._setHover(null);
    };
    this._onPointerDown = (event) => {
      this._activePointers.add(event.pointerId);
      // Chạm 2 ngón (pinch) không bao giờ được tính là "bấm chọn".
      this._down = this._activePointers.size > 1
        ? null
        : { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() };
    };
    this._onPointerUp = (event) => {
      this._activePointers.delete(event.pointerId);
      const down = this._down;
      if (!down || down.id !== event.pointerId) return;
      this._down = null;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      if (moved > TAP_MAX_MOVE || performance.now() - down.time > TAP_MAX_TIME) return;
      this._handleTap(event.clientX, event.clientY, event.pointerType !== 'mouse');
    };
    this._onPointerCancel = (event) => {
      this._activePointers.delete(event.pointerId);
      this._down = null;
    };

    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerleave', this._onPointerLeave);
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointercancel', this._onPointerCancel);
  }

  _handleTap(x, y, isTouch) {
    if (!this.stage.interactive || this.stage.paused || this.locked) return;
    const hit = this.pick(x, y, isTouch);
    if (hit) this.select(hit);
    else this._emit('empty');
  }

  /** Lá gần điểm chạm nhất trên màn hình (hoặc null). */
  pick(clientX, clientY, isTouch = false) {
    const rect = this.stage.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const { pointScale, pixelRatio } = this.stage.sizes;
    const cssScale = pointScale / pixelRatio;
    const minRadius = isTouch ? 26 : 14;

    this.stage.camera.updateMatrixWorld();
    let best = null;
    let bestScore = Infinity;

    for (const leaf of this.leaves) {
      const screen = this.stage.project(leaf.position, _screen);
      if (!screen.visible) continue;
      const radius = Math.max(minRadius, ((leaf.radius * cssScale) / screen.depth) * 1.4);
      const distance = Math.hypot(screen.x - x, screen.y - y);
      if (distance > radius) continue;
      // Ưu tiên lá gần tâm điểm chạm, hoà với ưu tiên lá gần camera.
      const score = distance / radius + screen.depth * 0.004;
      if (score < bestScore) {
        bestScore = score;
        best = leaf;
      }
    }
    return best;
  }

  _setHover(leaf) {
    if (leaf !== this.hovered) {
      this.hovered = leaf;
      this.uniforms.uHovered.value = leaf ? leaf.index : -1;
      this.stage.canvas.style.cursor = leaf ? 'pointer' : '';
    }
    this._emit('hover', leaf, this._pointer);
  }

  /* ------------------------------------------------------------------------ */
  /*  Vòng lặp                                                                 */
  /* ------------------------------------------------------------------------ */

  update(elapsed, delta) {
    this._frame++;

    // Hover: dò lại khi chuột di chuyển, hoặc định kỳ khi cây đang tự xoay.
    if (this._pointer.inside && this.stage.interactive && (this._pointer.dirty || this._frame % 10 === 0)) {
      this._pointer.dirty = false;
      this._setHover(this.pick(this._pointer.x, this._pointer.y, false));
    }

    // Làm mượt độ sáng / kích thước của lá khi đổi trạng thái.
    const k = 1 - Math.exp(-delta * 4);
    const array = this.emphasisAttribute.array;
    let changed = false;
    for (let i = 0; i < array.length; i++) {
      const diff = this.emphasisTarget[i] - array[i];
      if (Math.abs(diff) > 0.002) {
        array[i] += diff * k;
        changed = true;
      } else if (diff !== 0) {
        array[i] = this.emphasisTarget[i];
        changed = true;
      }
    }
    if (changed) this.emphasisAttribute.needsUpdate = true;

    // Vòng chọn quay chậm và thở theo nhịp.
    if (this.selected) {
      const base = Math.max(this.selected.radius * 4.5, this.height * 0.03);
      this.selectionRing.scale.setScalar(base * (1 + 0.08 * Math.sin(elapsed * 3)));
      this.selectionRing.material.rotation += delta * 0.6;
    }
  }

  dispose() {
    const canvas = this.stage.canvas;
    canvas.removeEventListener('pointermove', this._onPointerMove);
    canvas.removeEventListener('pointerleave', this._onPointerLeave);
    canvas.removeEventListener('pointerdown', this._onPointerDown);
    canvas.removeEventListener('pointerup', this._onPointerUp);
    canvas.removeEventListener('pointercancel', this._onPointerCancel);
    this._ringTexture.dispose();
    this.group.traverse((object) => object.material?.dispose());
    this.group.removeFromParent();
  }
}
