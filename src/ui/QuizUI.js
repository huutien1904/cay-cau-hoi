import gsap from 'gsap';
import { escapeHtml } from '../data/QuizData.js';

/*
 * QuizUI — giao diện trò chơi "Cây Câu Hỏi":
 * số liệu, tooltip, panel câu hỏi 4 đáp án, phản hồi đúng / sai, hộp quà ngẫu nhiên,
 * túi quà, chơi lại, màn hoàn thành, thông báo nhỏ và onboarding lần đầu.
 */

const ONBOARD_KEY = 'question-tree:onboarded';
const KEYS = ['A', 'B', 'C', 'D'];
const WRONG_CLOSE_DELAY = 2.6;
const CORRECT_CLOSE_DELAY = 1.4;

const ONBOARD_ICONS = {
  rotate: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v4h-4" /></svg>',
  pinch: '<svg viewBox="0 0 24 24"><path d="M9 9 4 4M4 4v4M4 4h4M15 15l5 5M20 20v-4M20 20h-4" /></svg>',
  tap: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="7.5" opacity="0.5" /></svg>',
  gift: '<svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="10" rx="1.5" /><path d="M3 7h18v3H3zM12 7v13M12 7c-2-3-6-3-5 0M12 7c2-3 6-3 5 0" /></svg>',
};

export class QuizUI {
  /**
   * @param {{ quiz: import('../data/QuizData.js').QuizData, progress: import('../data/QuizData.js').QuizProgress, layer: import('../LeafLayer.js').LeafLayer, stage: import('../Scene3D.js').Scene3D }} deps
   */
  constructor({ quiz, progress, layer, stage }) {
    this.quiz = quiz;
    this.progress = progress;
    this.layer = layer;
    this.stage = stage;

    this.el = {
      stats: document.querySelector('[data-stats]'),
      statTotal: document.querySelector('[data-stat="total"]'),
      statCorrect: document.querySelector('[data-stat="correct"]'),
      track: document.querySelector('[data-progress-track]'),
      bagButton: document.querySelector('[data-bag-open]'),
      bagCount: document.querySelector('[data-bag-count]'),
      resetButton: document.querySelector('[data-reset]'),
      tooltip: document.querySelector('[data-tooltip]'),
      panel: document.querySelector('[data-panel]'),
      panelBody: document.querySelector('[data-panel-body]'),
      panelClose: document.querySelector('[data-panel-close]'),
      modal: document.querySelector('[data-modal]'),
      modalCard: document.querySelector('[data-modal-card]'),
      toast: document.querySelector('[data-toast]'),
      onboard: document.querySelector('[data-onboard]'),
    };

    this.panelOpen = false;
    this.modalOpen = false;
    this._active = null; // { leaf, order, answered }
    this._closeCall = null;
    this._toastCall = null;
    this._modalLocked = false;
    this._shownCorrect = 0;

    this._bindLayer();
    this._bindPanel();
    this._bindHud();
    this._bindModal();
    this._renderStats({ animate: false });
  }

  /* ------------------------------------------------------------------------ */
  /*  Số liệu                                                                  */
  /* ------------------------------------------------------------------------ */

  _renderStats({ animate = true } = {}) {
    const total = this.layer.leaves.length;
    const correct = this.progress.correctCount;
    const wrong = this.progress.answeredCount - correct;

    this.el.statTotal.textContent = String(total);
    if (animate && correct !== this._shownCorrect) {
      const counter = { value: this._shownCorrect };
      gsap.to(counter, {
        value: correct,
        duration: 0.8,
        ease: 'power2.out',
        onUpdate: () => {
          this.el.statCorrect.textContent = String(Math.round(counter.value));
        },
      });
      gsap.fromTo(this.el.statCorrect, { scale: 1.25, color: '#ffd27a' }, { scale: 1, color: '#e6f4ff', duration: 0.9, ease: 'power3.out' });
    } else {
      this.el.statCorrect.textContent = String(correct);
    }
    this._shownCorrect = correct;

    const toPercent = (value) => (total > 0 ? `${(value / total) * 100}%` : '0%');
    this.el.track.style.setProperty('--correct', toPercent(correct));
    this.el.track.style.setProperty('--wrong', toPercent(wrong));
    this.el.track.setAttribute('aria-label', `Đã trả lời ${correct + wrong}/${total} câu, đúng ${correct} câu`);

    this.el.bagCount.textContent = String(this.progress.gifts.length);
    this.el.bagCount.hidden = this.progress.gifts.length === 0;
  }

  /* ------------------------------------------------------------------------ */
  /*  Kết nối với lớp 3D                                                       */
  /* ------------------------------------------------------------------------ */

  _bindLayer() {
    this.layer.on('hover', (leaf, pointer) => this._updateTooltip(leaf, pointer));
    this.layer.on('select', (leaf) => (leaf ? this.openQuestion(leaf) : this._hidePanel()));
    this.layer.on('empty', () => {
      if (this.panelOpen) this.closeQuestion();
    });
  }

  _updateTooltip(leaf, pointer) {
    const tooltip = this.el.tooltip;
    if (!leaf || (this.panelOpen && this.layer.selected === leaf)) {
      tooltip.classList.remove('is-visible');
      return;
    }
    const state = leaf.state;
    const key = `${leaf.question.id}:${state}`;
    if (tooltip.dataset.key !== key) {
      tooltip.dataset.key = key;
      tooltip.dataset.state = state;
      const status = state === 'correct' ? 'Đã trả lời đúng' : state === 'wrong' ? 'Đã khoá — trả lời sai' : 'Chưa trả lời · bấm để mở';
      tooltip.innerHTML = `
        <span class="tooltip__meta">Câu ${leaf.question.number} · ${escapeHtml(leaf.question.category || '')}</span>
        <span class="tooltip__title">${escapeHtml(status)}</span>`;
    }
    const x = Math.min(pointer.x + 16, window.innerWidth - tooltip.offsetWidth - 12);
    const y = Math.min(pointer.y + 18, window.innerHeight - tooltip.offsetHeight - 12);
    tooltip.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    tooltip.classList.add('is-visible');
  }

  /* ------------------------------------------------------------------------ */
  /*  Panel câu hỏi                                                            */
  /* ------------------------------------------------------------------------ */

  _bindPanel() {
    this.el.panelClose.addEventListener('click', () => this.closeQuestion());
    this.el.panelBody.addEventListener('click', (event) => {
      const answer = event.target.closest('[data-choice]');
      if (answer) {
        this._answer(Number(answer.dataset.choice));
        return;
      }
      if (event.target.closest('[data-close-question]')) this.closeQuestion();
    });

    window.addEventListener('keydown', (event) => {
      if (this.modalOpen) return;
      if (event.key === 'Escape' && this.panelOpen) {
        this.closeQuestion();
        return;
      }
      if (!this.panelOpen || !this._active || this._active.answered) return;
      const typed = event.key.toUpperCase();
      const position = /^[1-4]$/.test(typed) ? Number(typed) - 1 : KEYS.indexOf(typed);
      if (position >= 0) {
        event.preventDefault();
        this._answer(this._active.order[position]);
      }
    });
  }

  openQuestion(leaf) {
    this._closeCall?.kill();
    this._closeCall = null;
    const question = leaf.question;
    const result = this.progress.result(question.id);
    // Câu mới: đảo thứ tự đáp án; câu đã trả lời: hiện đúng thứ tự gốc để xem lại.
    const order = result ? [0, 1, 2, 3] : shuffle([0, 1, 2, 3]);
    this._active = { leaf, order, answered: Boolean(result) };

    this.el.panelBody.innerHTML = this._questionHTML(question, order, result);
    this.el.panelBody.scrollTop = 0;
    this.el.tooltip.classList.remove('is-visible');
    this._showPanel();

    if (!result) {
      gsap.fromTo(
        this.el.panelBody.querySelectorAll('.answer'),
        { autoAlpha: 0, y: 12 },
        { autoAlpha: 1, y: 0, duration: 0.45, stagger: 0.06, ease: 'power3.out', delay: 0.15 },
      );
      this.el.panelBody.querySelector('.answer')?.focus({ preventScroll: true });
    }
  }

  /** Đóng câu hỏi; nếu vừa trả lời thì chạy tiếp bước sau đó (mở quà / kiểm tra hoàn thành). */
  closeQuestion() {
    const after = this._active?.after;
    this._closeCall?.kill();
    this._closeCall = null;
    this.layer.locked = false;
    this.layer.deselect();
    after?.();
  }

  _questionHTML(question, order, result) {
    const answers = order
      .map((choice, position) => {
        let state = '';
        if (result) {
          if (choice === question.correct) state = ' is-correct';
          else if (choice === result.choice) state = ' is-wrong';
        }
        return `
        <li>
          <button type="button" class="answer${state}" data-choice="${choice}" ${result ? 'disabled' : ''}>
            <span class="answer__key">${KEYS[position]}</span>
            <span class="answer__text">${escapeHtml(question.answers[choice])}</span>
          </button>
        </li>`;
      })
      .join('');

    const badge = result
      ? `<p class="quiz__badge quiz__badge--${result.result}">${result.result === 'correct' ? 'Bạn đã trả lời đúng câu này' : 'Lá đã khoá — bạn trả lời sai câu này'}</p>`
      : '';

    return `
      <p class="quiz__meta"><span class="quiz__number">Câu ${question.number}</span> · ${escapeHtml(question.category || 'Câu hỏi')}</p>
      ${badge}
      <h2 class="quiz__question" id="panel-title">${escapeHtml(question.question)}</h2>
      <ol class="quiz__answers">${answers}</ol>
      <div class="quiz__feedback" data-feedback aria-live="assertive">
        ${result && question.note ? `<p class="quiz__note">${escapeHtml(question.note)}</p>` : ''}
      </div>
      ${result ? '<button type="button" class="button-ghost quiz__close" data-close-question>Đóng</button>' : ''}
    `;
  }

  _answer(choice) {
    const active = this._active;
    if (!active || active.answered) return;
    active.answered = true;

    const { leaf } = active;
    const question = leaf.question;
    const correct = choice === question.correct;
    this.progress.record(question.id, correct ? 'correct' : 'wrong', choice);
    this.layer.setLeafState(leaf, correct ? 'correct' : 'wrong');
    this._renderStats();

    const buttons = [...this.el.panelBody.querySelectorAll('[data-choice]')];
    for (const button of buttons) {
      const value = Number(button.dataset.choice);
      button.disabled = true;
      if (value === question.correct) button.classList.add('is-correct');
      else if (value === choice) button.classList.add('is-wrong');
      else button.classList.add('is-dimmed');
    }

    const feedback = this.el.panelBody.querySelector('[data-feedback]');
    const note = question.note ? `<p class="quiz__note">${escapeHtml(question.note)}</p>` : '';

    if (correct) {
      feedback.innerHTML = `
        <p class="quiz__verdict quiz__verdict--correct"><strong>Chính xác!</strong> Chiếc lá đã được thắp sáng.</p>
        ${note}
        <p class="quiz__next">Đang mở quà cho bạn…</p>`;
      gsap.fromTo(feedback, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.4 });
      // Quà được bốc và lưu ngay khi trả lời đúng, nên tải lại trang giữa chừng cũng không mất quà.
      const gift = this.quiz.randomGift();
      if (gift) this.progress.addGift(gift.id, question.id);
      active.after = () => gsap.delayedCall(0.45, () => (gift ? this.showGift(gift) : this._checkFinished()));
      this.layer.locked = true;
      this._closeCall = gsap.delayedCall(CORRECT_CLOSE_DELAY, () => this.closeQuestion());
    } else {
      feedback.innerHTML = `
        <p class="quiz__verdict quiz__verdict--wrong"><strong>Sai rồi!</strong> Đáp án đúng là: ${escapeHtml(question.answers[question.correct])}.</p>
        ${note}
        <div class="quiz__countdown" aria-hidden="true"><span></span></div>
        <button type="button" class="button-ghost quiz__close" data-close-question>Đóng ngay</button>`;
      gsap.fromTo(feedback, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.4 });
      gsap.fromTo(feedback.querySelector('.quiz__countdown span'), { scaleX: 1 }, { scaleX: 0, duration: WRONG_CLOSE_DELAY, ease: 'none' });
      gsap.fromTo(this.el.panel, { x: -8 }, { x: 0, duration: 0.5, ease: 'elastic.out(1, 0.3)' });
      active.after = () => gsap.delayedCall(0.4, () => this._checkFinished());
      this.layer.locked = true;
      this._closeCall = gsap.delayedCall(WRONG_CLOSE_DELAY, () => this.closeQuestion());
    }
  }

  _showPanel() {
    if (this.panelOpen) {
      gsap.fromTo(this.el.panelBody, { autoAlpha: 0.2 }, { autoAlpha: 1, duration: 0.35 });
      return;
    }
    this.panelOpen = true;
    this.el.panel.hidden = false;
    document.documentElement.classList.add('has-panel');
    const desktop = window.innerWidth > 720;
    gsap.fromTo(this.el.panel, { autoAlpha: 0, x: desktop ? 40 : 0, y: desktop ? 0 : 60 }, { autoAlpha: 1, x: 0, y: 0, duration: 0.55, ease: 'power3.out' });
    const rect = this.el.panel.getBoundingClientRect();
    if (desktop) this.stage.setViewInset({ right: window.innerWidth - rect.left });
    else this.stage.setViewInset({ bottom: window.innerHeight - rect.top });
  }

  _hidePanel() {
    this._closeCall?.kill();
    this._closeCall = null;
    this._active = null;
    if (!this.panelOpen) return;
    this.panelOpen = false;
    document.documentElement.classList.remove('has-panel');
    this.stage.setViewInset({});
    const desktop = window.innerWidth > 720;
    gsap.to(this.el.panel, {
      autoAlpha: 0,
      x: desktop ? 40 : 0,
      y: desktop ? 0 : 60,
      duration: 0.35,
      ease: 'power2.in',
      onComplete: () => {
        if (!this.panelOpen) this.el.panel.hidden = true;
      },
    });
  }

  /* ------------------------------------------------------------------------ */
  /*  Modal: quà, túi quà, chơi lại, hoàn thành                                */
  /* ------------------------------------------------------------------------ */

  _bindModal() {
    this.el.modal.addEventListener('click', (event) => {
      if (this._modalLocked) return;
      if (event.target === this.el.modal || event.target.closest('[data-modal-close]')) this.closeModal();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.modalOpen && !this._modalLocked) this.closeModal();
    });
  }

  _openModal(html, { variant = '' } = {}) {
    this._modalOnClose = null;
    this.el.modalCard.className = `modal__card${variant ? ` modal__card--${variant}` : ''}`;
    this.el.modalCard.innerHTML = html;
    this.modalOpen = true;
    this.el.modal.hidden = false;
    this.el.tooltip.classList.remove('is-visible');
    gsap.fromTo(this.el.modal, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.35 });
    gsap.fromTo(this.el.modalCard, { y: 24, scale: 0.96 }, { y: 0, scale: 1, duration: 0.55, ease: 'power3.out' });
  }

  closeModal() {
    if (!this.modalOpen) return;
    this.modalOpen = false;
    const onClose = this._modalOnClose;
    this._modalOnClose = null;
    gsap.to(this.el.modal, {
      autoAlpha: 0,
      duration: 0.3,
      onComplete: () => {
        if (!this.modalOpen) this.el.modal.hidden = true;
        onClose?.();
      },
    });
  }

  /** Hộp quà rung lên, bật nắp, quà bay ra. */
  showGift(gift) {
    this._openModal(
      `
      <div class="gift">
        <div class="gift__stage" aria-hidden="true">
          <div class="gift__burst">${Array.from({ length: 14 }, (_, i) => `<span style="--i:${i}"></span>`).join('')}</div>
          <div class="gift__box" data-gift-box>
            <div class="gift__lid" data-gift-lid></div>
            <div class="gift__base"></div>
          </div>
          <div class="gift__prize" data-gift-prize>${escapeHtml(gift.icon || '🎁')}</div>
        </div>
        <p class="eyebrow">Quà của bạn</p>
        <h2 class="gift__name" id="modal-title">${escapeHtml(gift.name)}</h2>
        ${gift.description ? `<p class="gift__desc">${escapeHtml(gift.description)}</p>` : ''}
        <button type="button" class="button-primary" data-modal-close>Nhận quà</button>
      </div>`,
      { variant: 'gift' },
    );
    this._modalOnClose = () => this._checkFinished();
    this._renderStats({ animate: false });

    const card = this.el.modalCard;
    const box = card.querySelector('[data-gift-box]');
    const lid = card.querySelector('[data-gift-lid]');
    const prize = card.querySelector('[data-gift-prize]');
    const burst = card.querySelectorAll('.gift__burst span');
    const texts = card.querySelectorAll('.eyebrow, .gift__name, .gift__desc, .button-primary');

    this._modalLocked = true;
    const motion = this.stage.device.reducedMotion ? 0.3 : 1;
    gsap
      .timeline({ onComplete: () => { this._modalLocked = false; } })
      .set(texts, { autoAlpha: 0, y: 12 })
      .set(prize, { autoAlpha: 0, scale: 0.2, y: 30 })
      .fromTo(box, { y: -120, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.6 * motion, ease: 'bounce.out' })
      .to(box, { rotation: 7, duration: 0.08, repeat: 7, yoyo: true, ease: 'sine.inOut' })
      .set(box, { rotation: 0 })
      .to(lid, { y: -70, rotation: -28, autoAlpha: 0, duration: 0.5 * motion, ease: 'power2.out' })
      .fromTo(burst, { scale: 0, autoAlpha: 1 }, { scale: 1, autoAlpha: 0, duration: 0.9 * motion, ease: 'power2.out', stagger: 0.01 }, '<')
      .to(box, { autoAlpha: 0, y: 20, duration: 0.35 }, '<0.1')
      .to(prize, { autoAlpha: 1, scale: 1, y: 0, duration: 0.7 * motion, ease: 'back.out(2.2)' }, '<')
      .to(texts, { autoAlpha: 1, y: 0, duration: 0.5, stagger: 0.08, ease: 'power3.out' }, '<0.2');
  }

  _bindHud() {
    this.el.bagButton.addEventListener('click', () => this.showBag());
    this.el.resetButton.addEventListener('click', () => this.confirmReset());
  }

  showBag() {
    const entries = [...this.progress.gifts].reverse();
    const list = entries.length
      ? `<ul class="bag__list">${entries
          .map((entry) => {
            const gift = this.quiz.gift(entry.giftId);
            const question = this.quiz.byId.get(entry.questionId);
            return `
            <li class="bag__item">
              <span class="bag__icon" aria-hidden="true">${escapeHtml(gift?.icon || '🎁')}</span>
              <span class="bag__body">
                <span class="bag__name">${escapeHtml(gift?.name || 'Quà')}</span>
                <span class="bag__meta">Từ câu ${question ? question.number : '?'}</span>
              </span>
            </li>`;
          })
          .join('')}</ul>`
      : '<p class="bag__empty">Chưa có quà nào. Trả lời đúng một câu hỏi để nhận quà đầu tiên!</p>';

    this._openModal(`
      <p class="eyebrow">Túi quà</p>
      <h2 class="modal__title" id="modal-title">Quà bạn đã nhận (${entries.length})</h2>
      ${list}
      <button type="button" class="button-ghost modal__action" data-modal-close>Đóng</button>`);
  }

  confirmReset() {
    this._openModal(`
      <p class="eyebrow">Chơi lại</p>
      <h2 class="modal__title" id="modal-title">Bắt đầu lại từ đầu?</h2>
      <p class="modal__text">Toàn bộ câu trả lời và quà đã nhận sẽ bị xoá, mọi chiếc lá trở về trạng thái chưa trả lời.</p>
      <div class="modal__buttons">
        <button type="button" class="button-ghost" data-modal-close>Huỷ</button>
        <button type="button" class="button-primary" data-confirm-reset>Chơi lại</button>
      </div>`);
    this.el.modalCard.querySelector('[data-confirm-reset]').addEventListener('click', () => {
      this.progress.reset();
      this.layer.deselect();
      this.layer.syncStates({ animate: true });
      this._renderStats();
      this.closeModal();
      this.toast('Đã làm mới cây — chúc bạn may mắn!');
    }, { once: true });
  }

  _checkFinished() {
    const total = this.layer.leaves.length;
    if (total === 0 || this.progress.answeredCount < total || this._finishedShown) return;
    this._finishedShown = true;
    const correct = this.progress.correctCount;
    this._openModal(`
      <p class="eyebrow">Hoàn thành</p>
      <h2 class="modal__title" id="modal-title">Bạn đã trả lời hết ${total} câu hỏi!</h2>
      <p class="modal__text">Đúng <strong>${correct}/${total}</strong> câu và nhận được <strong>${this.progress.gifts.length}</strong> món quà.</p>
      <div class="modal__buttons">
        <button type="button" class="button-ghost" data-show-bag>Xem túi quà</button>
        <button type="button" class="button-primary" data-play-again>Chơi lại</button>
      </div>`);
    this.el.modalCard.querySelector('[data-show-bag]').addEventListener('click', () => this.showBag(), { once: true });
    this.el.modalCard.querySelector('[data-play-again]').addEventListener('click', () => {
      this._finishedShown = false;
      this.confirmReset();
    }, { once: true });
  }

  toast(message) {
    const toast = this.el.toast;
    toast.textContent = message;
    this._toastCall?.kill();
    gsap.fromTo(toast, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.35, ease: 'power3.out' });
    this._toastCall = gsap.delayedCall(2.6, () => gsap.to(toast, { autoAlpha: 0, y: 12, duration: 0.3 }));
  }

  /* ------------------------------------------------------------------------ */
  /*  Onboarding lần đầu                                                       */
  /* ------------------------------------------------------------------------ */

  showOnboardingIfNeeded() {
    let seen = false;
    try {
      seen = window.localStorage.getItem(ONBOARD_KEY) === '1';
    } catch {
      seen = false;
    }
    if (seen) return Promise.resolve();

    const touch = this.stage.device.isTouch;
    const tips = [
      ['tap', touch ? 'Chạm vào một chiếc lá sáng' : 'Bấm vào một chiếc lá sáng', 'để mở câu hỏi'],
      ['gift', 'Trả lời đúng', 'để thắp sáng lá và nhận quà ngẫu nhiên'],
      ['rotate', touch ? 'Vuốt 1 ngón' : 'Kéo chuột', 'để xoay quanh cây'],
      ['pinch', touch ? 'Chụm 2 ngón' : 'Lăn chuột', 'để phóng to, thu nhỏ'],
    ];

    const onboard = this.el.onboard;
    onboard.querySelector('[data-onboard-tips]').innerHTML = tips
      .map(
        ([icon, title, text]) => `
        <li class="onboard__tip">
          <span class="onboard__icon" aria-hidden="true">${ONBOARD_ICONS[icon]}</span>
          <span><strong>${escapeHtml(title)}</strong> ${escapeHtml(text)}</span>
        </li>`,
      )
      .join('');

    onboard.hidden = false;
    gsap.fromTo(onboard, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5 });
    gsap.fromTo(onboard.querySelector('.onboard__card'), { y: 24 }, { y: 0, duration: 0.7, ease: 'power3.out' });
    const start = onboard.querySelector('[data-onboard-start]');
    start.focus({ preventScroll: true });

    return new Promise((resolve) => {
      start.addEventListener('click', () => {
        try {
          window.localStorage.setItem(ONBOARD_KEY, '1');
        } catch {
          /* chế độ ẩn danh: bỏ qua */
        }
        gsap.to(onboard, {
          autoAlpha: 0,
          duration: 0.4,
          onComplete: () => {
            onboard.hidden = true;
            resolve();
          },
        });
      }, { once: true });
    });
  }
}

function shuffle(list) {
  const result = [...list];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
