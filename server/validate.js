/*
 * Kiểm tra dữ liệu câu hỏi & quà — dùng chung cho máy chủ CMS và trang quản trị.
 * Không import module Node nào để chạy được cả trên trình duyệt.
 */

export const LIMITS = {
  // Trên điện thoại cây hiển thị tối đa 600 lá, nên giới hạn 600 câu để mọi thiết bị đều thấy đủ.
  maxQuestions: 600,
  question: 300,
  answer: 150,
  note: 500,
  category: 40,
  maxGifts: 50,
  giftName: 80,
  giftIcon: 16,
  giftDescription: 200,
  weightMax: 10000,
};

const MAX_ERRORS = 20;
const KEYS = ['A', 'B', 'C', 'D'];

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pushError(errors, message) {
  if (errors.length < MAX_ERRORS) errors.push(message);
}

/**
 * @returns {{ items: Array<object>, errors: string[] }} items đã được làm sạch (trim, bỏ trường thừa)
 */
export function validateQuestions(input) {
  const errors = [];
  const items = [];
  if (!Array.isArray(input)) return { items, errors: ['Dữ liệu câu hỏi phải là một danh sách.'] };
  if (input.length === 0) pushError(errors, 'Cần ít nhất 1 câu hỏi.');
  if (input.length > LIMITS.maxQuestions) {
    pushError(errors, `Tối đa ${LIMITS.maxQuestions} câu hỏi (giới hạn số lá hiển thị trên điện thoại).`);
  }

  const ids = new Set();
  input.forEach((raw, index) => {
    const label = `Câu ${index + 1}`;
    const id = text(raw?.id);
    const category = text(raw?.category);
    const question = text(raw?.question);
    const note = text(raw?.note);
    const answers = Array.isArray(raw?.answers) ? raw.answers.map(text) : [];
    const correct = Number(raw?.correct);

    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) pushError(errors, `${label}: mã câu hỏi không hợp lệ.`);
    else if (ids.has(id)) pushError(errors, `${label}: mã "${id}" bị trùng.`);
    ids.add(id);

    if (!question) pushError(errors, `${label}: chưa nhập nội dung câu hỏi.`);
    else if (question.length > LIMITS.question) pushError(errors, `${label}: câu hỏi dài quá ${LIMITS.question} ký tự.`);
    if (category.length > LIMITS.category) pushError(errors, `${label}: chủ đề dài quá ${LIMITS.category} ký tự.`);

    if (answers.length !== 4) {
      pushError(errors, `${label}: cần đúng 4 đáp án.`);
    } else {
      answers.forEach((answer, i) => {
        if (!answer) pushError(errors, `${label}: đáp án ${KEYS[i]} đang trống.`);
        else if (answer.length > LIMITS.answer) pushError(errors, `${label}: đáp án ${KEYS[i]} dài quá ${LIMITS.answer} ký tự.`);
      });
      if (answers.every(Boolean) && new Set(answers.map((a) => a.toLowerCase())).size !== 4) {
        pushError(errors, `${label}: có đáp án bị trùng nhau.`);
      }
    }

    if (!Number.isInteger(correct) || correct < 0 || correct > 3) pushError(errors, `${label}: chưa chọn đáp án đúng.`);
    if (note.length > LIMITS.note) pushError(errors, `${label}: phần giải thích dài quá ${LIMITS.note} ký tự.`);

    const item = { id, category, question, answers, correct };
    if (note) item.note = note;
    items.push(item);
  });

  return { items, errors };
}

/**
 * @returns {{ items: Array<object>, errors: string[] }}
 */
export function validateGifts(input) {
  const errors = [];
  const items = [];
  if (!Array.isArray(input)) return { items, errors: ['Dữ liệu quà phải là một danh sách.'] };
  if (input.length === 0) pushError(errors, 'Cần ít nhất 1 món quà.');
  if (input.length > LIMITS.maxGifts) pushError(errors, `Tối đa ${LIMITS.maxGifts} món quà.`);

  const ids = new Set();
  input.forEach((raw, index) => {
    const label = `Quà ${index + 1}`;
    const id = text(raw?.id);
    const name = text(raw?.name);
    const icon = text(raw?.icon);
    const description = text(raw?.description);
    const weight = Number(raw?.weight);

    if (!/^[a-z0-9-]{1,40}$/.test(id)) pushError(errors, `${label}: mã quà không hợp lệ.`);
    else if (ids.has(id)) pushError(errors, `${label}: mã "${id}" bị trùng.`);
    ids.add(id);

    if (!name) pushError(errors, `${label}: chưa nhập tên quà.`);
    else if (name.length > LIMITS.giftName) pushError(errors, `${label}: tên quà dài quá ${LIMITS.giftName} ký tự.`);
    if (icon.length > LIMITS.giftIcon) pushError(errors, `${label}: biểu tượng quá dài.`);
    if (description.length > LIMITS.giftDescription) pushError(errors, `${label}: mô tả dài quá ${LIMITS.giftDescription} ký tự.`);
    if (!Number.isInteger(weight) || weight < 1 || weight > LIMITS.weightMax) {
      pushError(errors, `${label}: tỉ lệ trúng phải là số nguyên từ 1 đến ${LIMITS.weightMax}.`);
    }

    const item = { id, name, icon: icon || '🎁', weight };
    if (description) item.description = description;
    items.push(item);
  });

  return { items, errors };
}
