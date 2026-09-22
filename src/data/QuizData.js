/*
 * QuizData — nạp câu hỏi & danh sách quà, lưu tiến độ người chơi.
 *
 * public/data/questions.json : [{ id, category, question, answers: [4 đáp án], correct: 0..3, note? }]
 * public/data/gifts.json     : [{ id, name, icon, weight, description? }]
 *
 * Tiến độ (câu đã trả lời, quà đã nhận) lưu trong localStorage của trình duyệt.
 * Đây là bản demo phía client: muốn trao quà thật cần kiểm tra đáp án và bốc quà ở máy chủ.
 */

const PROGRESS_KEY = 'question-tree:progress:v1';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

export class QuizData {
  constructor() {
    this.questions = [];
    this.byId = new Map();
    this.gifts = [];
  }

  /** @param {{ questionsUrl: string, giftsUrl: string }} urls */
  async load({ questionsUrl, giftsUrl }) {
    const [questions, gifts] = await Promise.all([fetchJSON(questionsUrl), fetchJSON(giftsUrl)]);
    if (!Array.isArray(questions)) throw new Error('questions.json phải là một mảng.');

    this.questions = questions.filter((q, index) => {
      const valid = q && q.id && q.question && Array.isArray(q.answers) && q.answers.length === 4
        && Number.isInteger(q.correct) && q.correct >= 0 && q.correct < 4;
      if (!valid) console.warn(`[QuestionTree] Bỏ qua câu hỏi #${index + 1} vì sai định dạng`, q);
      return valid;
    }).map((q, index) => ({ ...q, id: String(q.id), number: index + 1 }));

    this.byId = new Map(this.questions.map((q) => [q.id, q]));
    this.gifts = (Array.isArray(gifts) ? gifts : []).filter((gift) => gift && gift.id && gift.name && gift.weight > 0);
    return this;
  }

  /** Bốc một món quà ngẫu nhiên theo trọng số (weight càng lớn càng dễ trúng). */
  randomGift() {
    const total = this.gifts.reduce((sum, gift) => sum + gift.weight, 0);
    if (total <= 0) return null;
    let roll = Math.random() * total;
    for (const gift of this.gifts) {
      roll -= gift.weight;
      if (roll <= 0) return gift;
    }
    return this.gifts[this.gifts.length - 1];
  }

  gift(id) {
    return this.gifts.find((gift) => gift.id === id) || null;
  }
}

export class QuizProgress {
  constructor(key = PROGRESS_KEY) {
    this.key = key;
    /** @type {Map<string, { result: 'correct' | 'wrong', choice: number, at: number }>} */
    this.answers = new Map();
    /** @type {Array<{ giftId: string, questionId: string, at: number }>} */
    this.gifts = [];
    this._load();
  }

  _load() {
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return;
      const saved = JSON.parse(raw);
      this.answers = new Map(Object.entries(saved.answers || {}));
      this.gifts = Array.isArray(saved.gifts) ? saved.gifts : [];
    } catch {
      this.answers = new Map();
      this.gifts = [];
    }
  }

  _save() {
    try {
      window.localStorage.setItem(this.key, JSON.stringify({ answers: Object.fromEntries(this.answers), gifts: this.gifts }));
    } catch {
      /* chế độ ẩn danh / bộ nhớ bị chặn: vẫn chơi được, chỉ không lưu tiến độ */
    }
  }

  result(questionId) {
    return this.answers.get(questionId) || null;
  }

  record(questionId, result, choice) {
    this.answers.set(questionId, { result, choice, at: Date.now() });
    this._save();
  }

  addGift(giftId, questionId) {
    this.gifts.push({ giftId, questionId, at: Date.now() });
    this._save();
  }

  get correctCount() {
    let count = 0;
    for (const entry of this.answers.values()) if (entry.result === 'correct') count++;
    return count;
  }

  get answeredCount() {
    return this.answers.size;
  }

  reset() {
    this.answers.clear();
    this.gifts = [];
    this._save();
  }
}

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Không tải được ${url} (${response.status})`);
  return response.json();
}
