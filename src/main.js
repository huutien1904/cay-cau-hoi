// Font tự lưu trữ (Inter + Space Grotesk, giấy phép OFL) — không phụ thuộc Google Fonts.
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import gsap from 'gsap';
import { Scene3D } from './Scene3D.js';
import { CityBackdrop } from './CityBackdrop.js';
import { TreeLoader } from './TreeLoader.js';
import { QuizData, QuizProgress } from './data/QuizData.js';
import { LeafLayer } from './LeafLayer.js';
import { QuizUI } from './ui/QuizUI.js';

const BASE = import.meta.env.BASE_URL;
const MODEL_URL = `${BASE}models/cay-sang-kien-no-leaves.glb`;
const DATA_URLS = {
  questionsUrl: `${BASE}data/questions.json`,
  giftsUrl: `${BASE}data/gifts.json`,
};

const STATUS_TEXT = {
  download: 'Đang tải trải nghiệm…',
  build: 'Đang gieo những chiếc lá câu hỏi…',
  error: 'Không tải được trải nghiệm 3D. Vui lòng tải lại trang.',
};

const HINT_TEXT = {
  touch: 'Chạm vào lá để trả lời · Vuốt để xoay · Chụm để phóng to',
  pointer: 'Bấm vào lá để trả lời · Kéo để xoay · Cuộn để phóng to',
};

const dom = {
  root: document.documentElement,
  canvas: document.querySelector('#webgl'),
  loader: document.querySelector('[data-loader]'),
  loaderStatus: document.querySelector('[data-loader-status]'),
  progressBar: document.querySelector('[data-progress-bar]'),
  progressValue: document.querySelector('[data-progress-value]'),
  hint: document.querySelector('[data-hint]'),
  hintText: document.querySelector('[data-hint-text]'),
  revealItems: document.querySelectorAll('[data-reveal]'),
};

function createProgress() {
  const state = { value: 0 };
  const render = () => {
    dom.progressBar.style.transform = `scaleX(${state.value})`;
    dom.progressValue.textContent = `${Math.round(state.value * 100)}%`;
  };
  return {
    set(ratio, duration = 0.4) {
      return gsap.to(state, { value: Math.max(state.value, ratio), duration, ease: 'power2.out', overwrite: true, onUpdate: render });
    },
  };
}

function playIntro(stage, tree) {
  const motion = stage.device.reducedMotion ? 0.35 : 1;
  const flight = 4.6 * motion;
  const timeline = gsap.timeline();

  timeline
    .to(dom.loader, { autoAlpha: 0, duration: 0.9, ease: 'power2.out' }, 0)
    .add(stage.flyIn({ duration: flight }), 0)
    .to(tree.reveal.ground, { value: 1, duration: 2.2 * motion, ease: 'power2.out' }, 0.1)
    .to(tree.reveal.bark, { value: 1.08, duration: 3.8 * motion, ease: 'power1.inOut' }, 0.25 * motion)
    .to(tree.reveal.light, { value: 1, duration: 2.4 * motion, ease: 'power2.inOut' }, 1.2 * motion)
    .to(tree.reveal.leaves, { value: 1.25, duration: 3.2 * motion, ease: 'power1.out' }, 1.5 * motion)
    .to(tree.reveal.nodes, { value: 1.2, duration: 2.8 * motion, ease: 'power1.out' }, 1.9 * motion)
    .to(tree.reveal.motes, { value: 1, duration: 2.5 * motion, ease: 'power1.out' }, 2.0 * motion)
    .to(dom.revealItems, { autoAlpha: 1, y: 0, duration: 1.1, stagger: 0.08, ease: 'power3.out' }, 2.8 * motion)
    .call(() => stage.enableInteraction(), null, flight);

  return timeline;
}

async function init() {
  const stage = new Scene3D(dom.canvas);
  const quiz = new QuizData();
  const progress = new QuizProgress();

  // Phông nền thành phố đêm tím neon 360°; sương dùng cùng tông để cây hoà vào khung cảnh.
  const backdrop = new CityBackdrop();
  stage.scene.add(backdrop.mesh);
  stage.scene.background = backdrop.fogColor.clone();
  stage.scene.fog.color.copy(backdrop.fogColor);
  stage.onTick((elapsed) => backdrop.update(elapsed));
  stage.start();

  dom.hintText.textContent = stage.device.isTouch ? HINT_TEXT.touch : HINT_TEXT.pointer;
  gsap.set(dom.revealItems, { autoAlpha: 0, y: 18 });

  const loading = createProgress();
  dom.root.dataset.state = 'loading';

  try {
    // Số câu hỏi quyết định số lá trên cây: mỗi câu hỏi = một chiếc lá phát sáng.
    await quiz.load(DATA_URLS);
    const tree = new TreeLoader({
      quality: stage.device.isMobile ? 'low' : 'high',
      nodeCount: Math.max(1, quiz.questions.length),
    });
    stage.scene.add(tree.group);
    stage.onResize(({ pointScale }) => tree.setPointScale(pointScale));
    stage.onTick((elapsed) => tree.update(elapsed));

    await tree.load(MODEL_URL, {
      onProgress: (ratio) => loading.set(ratio * 0.9),
      onStatus: (status) => {
        dom.loaderStatus.textContent = STATUS_TEXT[status];
      },
    });
    await loading.set(1, 0.35);

    stage.frameTree(tree.bounds);
    tree.setPointScale(stage.sizes.pointScale);

    const layer = new LeafLayer({ stage, tree, quiz, progress });
    stage.onTick((elapsed, delta) => layer.update(elapsed, delta));
    const ui = new QuizUI({ quiz, progress, layer, stage });

    // Chỉ ở chế độ dev: handle để debug / kiểm thử tự động (bị loại khỏi bản build).
    if (import.meta.env.DEV) window.__questionTree = { stage, tree, quiz, progress, layer, ui };

    await playIntro(stage, tree).then();

    dom.root.dataset.state = 'ready';
    await ui.showOnboardingIfNeeded();

    // Trên điện thoại gợi ý thao tác tự ẩn sau vài giây để nhường chỗ cho cây.
    if (stage.device.isMobile) gsap.to(dom.hint, { autoAlpha: 0, duration: 0.6, delay: 6 });

    window.dispatchEvent(new CustomEvent('question-tree:ready'));
  } catch (error) {
    console.error('[QuestionTree]', error);
    dom.root.dataset.state = 'error';
    dom.loaderStatus.textContent = STATUS_TEXT.error;
  }
}

init();
