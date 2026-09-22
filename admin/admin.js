// Font tự lưu trữ (Inter + Space Grotesk, giấy phép OFL) — không phụ thuộc Google Fonts.
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import { LIMITS, validateGifts, validateQuestions } from '../server/validate.js';

/*
 * Trang quản trị Cây Câu Hỏi: đăng nhập, sửa câu hỏi, cấu hình quà.
 * Mỗi thay đổi được lưu ngay lên máy chủ; người chơi thấy khi tải lại trò chơi.
 */

const API = '/cms-api';
const KEYS = ['A', 'B', 'C', 'D'];
const EMOJIS = ['🎁', '🎟️', '☕', '🍃', '📒', '🧢', '👕', '🥤', '🎧', '🍫', '💎', '🏆', '📚', '🎒', '🧸', '⭐'];

const state = {
  user: null,
  tab: 'questions',
  search: '',
  category: '',
  questions: { items: [], version: null },
  gifts: { items: [], version: null },
};

const $ = (selector, root = document) => root.querySelector(selector);
const views = {
  boot: $('[data-view="boot"]'),
  login: $('[data-view="login"]'),
  app: $('[data-view="app"]'),
};
const dialog = $('[data-dialog]');
const confirmDialog = $('[data-confirm]');

/* -------------------------------------------------------------------------- */
/*  Tiện ích                                                                    */
/* -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function fold(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Không kết nối được máy chủ CMS. Kiểm tra mạng hoặc dịch vụ caycauhoi-cms.');
  }
  let data = {};
  try {
    data = await response.json();
  } catch {
    /* phản hồi không phải JSON */
  }
  if (!response.ok) throw new ApiError(response.status, data.error || `Lỗi máy chủ (${response.status})`, data.details);
  return data;
}

let toastTimer = 0;
function toast(message, tone = 'success') {
  const el = $('[data-toast]');
  el.textContent = message;
  el.dataset.tone = tone;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), tone === 'error' ? 6000 : 3200);
}

function show(viewName) {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== viewName;
}

function errorsHtml(errors) {
  return `<p class="form-errors__title">Chưa lưu được:</p><ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`;
}

function download(filename, data) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/*  Đăng nhập                                                                   */
/* -------------------------------------------------------------------------- */

function showLogin(message = '') {
  closeDialogs();
  state.user = null;
  show('login');
  const note = $('[data-login-message]');
  note.textContent = message;
  note.hidden = !message;
  $('[data-login-form] [name="password"]').value = '';
  $('[data-login-form] [name="username"]').focus();
}

$('[data-login-form]').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const note = $('[data-login-message]');
  const username = form.username.value.trim();
  const password = form.password.value;
  if (!username || !password) {
    note.textContent = 'Nhập tên đăng nhập và mật khẩu.';
    note.hidden = false;
    return;
  }
  button.disabled = true;
  button.textContent = 'Đang đăng nhập…';
  try {
    const { user } = await api('/login', { method: 'POST', body: { username, password } });
    state.user = user;
    note.hidden = true;
    await enterApp();
  } catch (error) {
    note.textContent = error.message;
    note.hidden = false;
    form.password.select();
  } finally {
    button.disabled = false;
    button.textContent = 'Đăng nhập';
  }
});

$('[data-logout]').addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST' });
  } catch {
    /* vẫn đưa về màn đăng nhập */
  }
  showLogin('Bạn đã đăng xuất.');
});

/** Lỗi 401 ở bất kỳ đâu → quay về màn đăng nhập. */
function handleAuthError(error) {
  if (error.status === 401) {
    showLogin(error.message);
    return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/*  Nạp & lưu dữ liệu                                                           */
/* -------------------------------------------------------------------------- */

async function load(name) {
  const data = await api(`/${name}`);
  state[name] = { items: data.items, version: data.version };
}

async function enterApp() {
  show('boot');
  await Promise.all([load('questions'), load('gifts')]);
  $('[data-user]').textContent = `(${state.user})`;
  show('app');
  render();
}

/**
 * Lưu toàn bộ danh sách lên máy chủ.
 * @returns {Promise<{ ok: boolean, errors?: string[] }>}
 */
async function save(name, items, message) {
  const { items: clean, errors } = name === 'questions' ? validateQuestions(items) : validateGifts(items);
  if (errors.length > 0) return { ok: false, errors };
  try {
    const data = await api(`/${name}`, { method: 'PUT', body: { items: clean, version: state[name].version } });
    state[name] = { items: data.items, version: data.version };
    render();
    toast(message);
    return { ok: true };
  } catch (error) {
    if (handleAuthError(error)) return { ok: false, errors: [] };
    if (error.status === 409) {
      await load(name);
      render();
      closeDialogs();
      toast(error.message, 'warn');
      return { ok: false, errors: [] };
    }
    return { ok: false, errors: error.details?.length ? error.details : [error.message] };
  }
}

/* -------------------------------------------------------------------------- */
/*  Giao diện chung                                                             */
/* -------------------------------------------------------------------------- */

function render() {
  for (const tab of document.querySelectorAll('[data-tab]')) {
    if (tab.dataset.tab === state.tab) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== state.tab;
  $('[data-count="questions"]').textContent = state.questions.items.length;
  $('[data-count="gifts"]').textContent = state.gifts.items.length;
  renderQuestions();
  renderGifts();
}

document.querySelector('.tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (!tab) return;
  state.tab = tab.dataset.tab;
  render();
});

function closeDialogs() {
  if (dialog.open) dialog.close();
  if (confirmDialog.open) confirmDialog.close();
}

function openDialog(html) {
  dialog.innerHTML = html;
  dialog.showModal();
  dialog.querySelector('input:not([type="radio"]), textarea')?.focus();
}

// Bấm ra ngoài hộp thoại (vùng mờ) để đóng.
for (const el of [dialog, confirmDialog]) {
  el.addEventListener('click', (event) => {
    if (event.target === el) el.close();
    if (event.target.closest('[data-close]')) el.close();
  });
}

/** Hộp xác nhận, trả về true nếu người dùng đồng ý. */
function confirmAction({ title, message, confirmLabel = 'Đồng ý', danger = false }) {
  confirmDialog.innerHTML = `
    <form class="editor" method="dialog">
      <header class="dialog__head"><h2>${escapeHtml(title)}</h2></header>
      <div class="dialog__body"><p class="dialog__text">${escapeHtml(message)}</p></div>
      <footer class="dialog__foot">
        <span class="spacer"></span>
        <button class="btn btn--ghost" value="cancel">Huỷ</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" value="ok">${escapeHtml(confirmLabel)}</button>
      </footer>
    </form>`;
  // dialog.close() không tự xoá returnValue cũ: đặt lại để đóng bằng Esc / bấm ra ngoài luôn là "Huỷ".
  confirmDialog.returnValue = '';
  confirmDialog.showModal();
  confirmDialog.querySelector('[value="cancel"]').focus();
  return new Promise((resolve) => {
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true });
  });
}

/** Gắn xử lý submit cho form trong hộp thoại, tự khoá nút và hiện lỗi. */
function bindEditor(onSubmit) {
  const form = $('form', dialog);
  const errorBox = $('[data-errors]', form);
  const submit = $('button[type="submit"]', form);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    const label = submit.textContent;
    submit.textContent = 'Đang lưu…';
    const result = await onSubmit(form);
    submit.disabled = false;
    submit.textContent = label;
    if (result.ok) {
      if (dialog.open) dialog.close();
    } else if (result.errors?.length) {
      errorBox.innerHTML = errorsHtml(result.errors);
      errorBox.hidden = false;
      errorBox.scrollIntoView({ block: 'nearest' });
    }
  });
  return form;
}

/* -------------------------------------------------------------------------- */
/*  Câu hỏi                                                                     */
/* -------------------------------------------------------------------------- */

function categories() {
  return [...new Set(state.questions.items.map((q) => q.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
}

function renderQuestions() {
  const { items } = state.questions;
  const select = $('[data-category-filter]');
  const cats = categories();
  if (state.category && !cats.includes(state.category)) state.category = '';
  select.innerHTML = `<option value="">Mọi chủ đề</option>${cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}`;
  select.value = state.category;

  const query = fold(state.search).trim();
  const rows = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !state.category || item.category === state.category)
    .filter(({ item }) => !query || fold(`${item.id} ${item.question} ${item.answers.join(' ')}`).includes(query));

  $('[data-question-summary]').textContent = rows.length === items.length
    ? `${items.length} câu hỏi · thứ tự trong danh sách = vị trí lá trên cây, từ gốc lên ngọn (tối đa ${LIMITS.maxQuestions} câu).`
    : `Hiển thị ${rows.length} / ${items.length} câu hỏi.`;

  $('[data-question-rows]').innerHTML = rows.length
    ? rows
        .map(({ item, index }) => `
        <tr data-index="${index}">
          <td class="col-num">${index + 1}</td>
          <td class="col-question">
            <span class="q-text">${escapeHtml(item.question)}</span>
            <span class="q-meta">${escapeHtml(item.id)}</span>
          </td>
          <td class="col-cat">${item.category ? `<span class="chip">${escapeHtml(item.category)}</span>` : '<span class="muted">—</span>'}</td>
          <td class="col-answer"><span class="key">${KEYS[item.correct]}</span>${escapeHtml(item.answers[item.correct])}</td>
          <td class="col-actions">
            <button class="btn btn--ghost btn--small" type="button" data-edit-question="${index}">Sửa</button>
            <button class="btn btn--danger-ghost btn--small" type="button" data-delete-question="${index}" aria-label="Xoá câu ${index + 1}">Xoá</button>
          </td>
        </tr>`)
        .join('')
    : '<tr><td colspan="5" class="empty">Không có câu hỏi nào khớp bộ lọc.</td></tr>';
}

$('[data-search]').addEventListener('input', (event) => {
  state.search = event.target.value;
  renderQuestions();
});

$('[data-category-filter]').addEventListener('change', (event) => {
  state.category = event.target.value;
  renderQuestions();
});

$('[data-question-rows]').addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit-question]');
  const remove = event.target.closest('[data-delete-question]');
  if (edit) openQuestionEditor(Number(edit.dataset.editQuestion));
  else if (remove) deleteQuestion(Number(remove.dataset.deleteQuestion));
  else {
    const row = event.target.closest('tr[data-index]');
    if (row) openQuestionEditor(Number(row.dataset.index));
  }
});

$('[data-add-question]').addEventListener('click', () => openQuestionEditor(-1));

function nextQuestionId(items) {
  const max = items.reduce((acc, q) => {
    const match = /^Q(\d+)$/.exec(q.id);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return `Q${String(max + 1).padStart(3, '0')}`;
}

function openQuestionEditor(index) {
  const isNew = index < 0;
  const items = state.questions.items;
  const item = isNew
    ? { id: nextQuestionId(items), category: state.category || '', question: '', answers: ['', '', '', ''], correct: -1, note: '' }
    : items[index];

  openDialog(`
    <form class="editor" novalidate>
      <header class="dialog__head">
        <h2>${isNew ? 'Thêm câu hỏi' : `Sửa câu ${index + 1}`} <span class="dialog__id">${escapeHtml(item.id)}</span></h2>
        <button class="icon-btn" type="button" data-close aria-label="Đóng">×</button>
      </header>
      <div class="dialog__body">
        <label class="field">
          <span class="field__label">Chủ đề</span>
          <input name="category" list="category-list" maxlength="${LIMITS.category}" value="${escapeHtml(item.category)}" placeholder="Ví dụ: Địa lý" />
          <datalist id="category-list">${categories().map((c) => `<option value="${escapeHtml(c)}"></option>`).join('')}</datalist>
        </label>
        <label class="field">
          <span class="field__label">Câu hỏi <em>*</em></span>
          <textarea name="question" rows="3" maxlength="${LIMITS.question}" required>${escapeHtml(item.question)}</textarea>
        </label>
        <fieldset class="field answers">
          <legend class="field__label">Đáp án <em>*</em> <small>— bấm vào chữ cái để chọn đáp án đúng</small></legend>
          ${KEYS.map((key, i) => `
            <div class="answer-row">
              <input type="radio" name="correct" value="${i}" id="correct-${i}" ${item.correct === i ? 'checked' : ''} />
              <label class="answer-row__key" for="correct-${i}" title="Chọn ${key} là đáp án đúng">${key}</label>
              <input name="answer-${i}" maxlength="${LIMITS.answer}" value="${escapeHtml(item.answers[i] || '')}" placeholder="Đáp án ${key}" aria-label="Đáp án ${key}" />
            </div>`).join('')}
        </fieldset>
        <label class="field">
          <span class="field__label">Giải thích <small>(không bắt buộc — hiện cho người chơi sau khi trả lời)</small></span>
          <textarea name="note" rows="2" maxlength="${LIMITS.note}">${escapeHtml(item.note || '')}</textarea>
        </label>
        <div class="form-errors" data-errors hidden></div>
      </div>
      <footer class="dialog__foot">
        ${isNew ? '' : '<button class="btn btn--danger-ghost" type="button" data-delete>Xoá câu hỏi</button>'}
        <span class="spacer"></span>
        <button class="btn btn--ghost" type="button" data-close>Huỷ</button>
        <button class="btn btn--primary" type="submit">${isNew ? 'Thêm câu hỏi' : 'Lưu thay đổi'}</button>
      </footer>
    </form>`);

  const form = bindEditor((f) => {
    const checked = f.querySelector('[name="correct"]:checked');
    const updated = {
      id: item.id,
      category: f.category.value,
      question: f.question.value,
      answers: KEYS.map((_, i) => f[`answer-${i}`].value),
      correct: checked ? Number(checked.value) : -1,
      note: f.note.value,
    };
    // Kiểm tra riêng câu đang sửa để báo lỗi dễ hiểu, không kèm "Câu 1:".
    const own = validateQuestions([updated]).errors.map((e) => e.replace(/^Câu 1: /, ''));
    if (own.length > 0) return { ok: false, errors: own };
    const next = [...items];
    if (isNew) next.push(updated);
    else next[index] = updated;
    return save('questions', next, isNew ? `Đã thêm câu hỏi ${updated.id}.` : `Đã lưu câu ${index + 1}.`);
  });

  form.querySelector('[data-delete]')?.addEventListener('click', () => deleteQuestion(index));
}

async function deleteQuestion(index) {
  const item = state.questions.items[index];
  if (!item) return;
  const ok = await confirmAction({
    title: `Xoá câu ${index + 1}?`,
    message: `"${item.question}" — chiếc lá của câu này sẽ biến mất khỏi cây.`,
    confirmLabel: 'Xoá câu hỏi',
    danger: true,
  });
  if (!ok) return;
  const result = await save('questions', state.questions.items.filter((_, i) => i !== index), `Đã xoá câu ${index + 1}.`);
  if (result.ok) {
    if (dialog.open) dialog.close();
  } else if (result.errors?.length) {
    toast(result.errors[0], 'error');
  }
}

/* Nhập / xuất file */

$('[data-import]').addEventListener('click', () => $('[data-import-file]').click());

$('[data-import-file]').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    toast('File không phải JSON hợp lệ.', 'error');
    return;
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(list)) {
    toast('File cần chứa một danh sách câu hỏi.', 'error');
    return;
  }
  // Câu hỏi thiếu mã thì tự cấp mã mới.
  const withIds = [];
  for (const raw of list) {
    withIds.push({ ...raw, id: raw?.id ? String(raw.id) : nextQuestionId(withIds.concat(state.questions.items)) });
  }
  const { errors } = validateQuestions(withIds);
  if (errors.length > 0) {
    toast(`File chưa hợp lệ — ${errors[0]}`, 'error');
    return;
  }
  const ok = await confirmAction({
    title: 'Thay toàn bộ câu hỏi?',
    message: `${state.questions.items.length} câu hỏi hiện tại sẽ được thay bằng ${withIds.length} câu trong file "${file.name}". Bản cũ vẫn được máy chủ tự sao lưu.`,
    confirmLabel: 'Thay thế',
    danger: true,
  });
  if (!ok) return;
  const result = await save('questions', withIds, `Đã nhập ${withIds.length} câu hỏi.`);
  if (!result.ok && result.errors?.length) toast(result.errors[0], 'error');
});

for (const button of document.querySelectorAll('[data-export]')) {
  button.addEventListener('click', () => {
    const name = button.dataset.export;
    download(`${name}-${today()}.json`, state[name].items);
  });
}

/* -------------------------------------------------------------------------- */
/*  Quà tặng                                                                    */
/* -------------------------------------------------------------------------- */

function totalWeight(items) {
  return items.reduce((sum, gift) => sum + (Number(gift.weight) || 0), 0);
}

function percent(weight, total) {
  if (!total) return '0%';
  const value = (weight / total) * 100;
  return `${value < 1 ? value.toFixed(2) : value.toFixed(1)}%`.replace('.', ',');
}

function renderGifts() {
  const { items } = state.gifts;
  const total = totalWeight(items);
  $('[data-gift-rows]').innerHTML = items.length
    ? items
        .map((gift, index) => `
        <tr data-index="${index}">
          <td class="col-icon"><span class="gift-icon">${escapeHtml(gift.icon || '🎁')}</span></td>
          <td class="col-name">
            <span class="q-text">${escapeHtml(gift.name)}</span>
            ${gift.description ? `<span class="q-meta">${escapeHtml(gift.description)}</span>` : ''}
          </td>
          <td class="col-weight">${gift.weight}</td>
          <td class="col-chance">
            <span class="chance"><span class="chance__bar" style="--w:${total ? (gift.weight / total) * 100 : 0}%"></span><span class="chance__value">${percent(gift.weight, total)}</span></span>
          </td>
          <td class="col-actions">
            <button class="btn btn--ghost btn--small" type="button" data-edit-gift="${index}">Sửa</button>
            <button class="btn btn--danger-ghost btn--small" type="button" data-delete-gift="${index}" aria-label="Xoá ${escapeHtml(gift.name)}">Xoá</button>
          </td>
        </tr>`)
        .join('')
    : '<tr><td colspan="5" class="empty">Chưa có quà nào.</td></tr>';
}

$('[data-gift-rows]').addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit-gift]');
  const remove = event.target.closest('[data-delete-gift]');
  if (edit) openGiftEditor(Number(edit.dataset.editGift));
  else if (remove) deleteGift(Number(remove.dataset.deleteGift));
  else {
    const row = event.target.closest('tr[data-index]');
    if (row) openGiftEditor(Number(row.dataset.index));
  }
});

$('[data-add-gift]').addEventListener('click', () => openGiftEditor(-1));

function slugify(text, taken) {
  const base = fold(text).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'qua';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

function openGiftEditor(index) {
  const isNew = index < 0;
  const items = state.gifts.items;
  const gift = isNew ? { id: '', name: '', icon: '🎁', weight: 10, description: '' } : items[index];
  const othersTotal = totalWeight(items) - (isNew ? 0 : Number(gift.weight) || 0);

  openDialog(`
    <form class="editor" novalidate>
      <header class="dialog__head">
        <h2>${isNew ? 'Thêm quà' : 'Sửa quà'}</h2>
        <button class="icon-btn" type="button" data-close aria-label="Đóng">×</button>
      </header>
      <div class="dialog__body">
        <div class="field">
          <span class="field__label">Biểu tượng</span>
          <div class="icon-picker">
            <input name="icon" class="icon-picker__input" maxlength="${LIMITS.giftIcon}" value="${escapeHtml(gift.icon || '🎁')}" aria-label="Biểu tượng (emoji)" />
            <div class="icon-picker__list">
              ${EMOJIS.map((emoji) => `<button type="button" class="icon-picker__option" data-emoji="${emoji}" aria-label="Chọn ${emoji}">${emoji}</button>`).join('')}
            </div>
          </div>
        </div>
        <label class="field">
          <span class="field__label">Tên quà <em>*</em></span>
          <input name="name" maxlength="${LIMITS.giftName}" value="${escapeHtml(gift.name)}" placeholder="Ví dụ: Voucher cà phê" required />
        </label>
        <label class="field">
          <span class="field__label">Mô tả <small>(không bắt buộc)</small></span>
          <input name="description" maxlength="${LIMITS.giftDescription}" value="${escapeHtml(gift.description || '')}" />
        </label>
        <label class="field">
          <span class="field__label">Trọng số <em>*</em> <small>— số càng lớn càng dễ trúng</small></span>
          <input name="weight" type="number" min="1" max="${LIMITS.weightMax}" step="1" value="${escapeHtml(gift.weight)}" required />
          <span class="field__hint" data-chance></span>
        </label>
        <div class="form-errors" data-errors hidden></div>
      </div>
      <footer class="dialog__foot">
        ${isNew ? '' : '<button class="btn btn--danger-ghost" type="button" data-delete>Xoá quà</button>'}
        <span class="spacer"></span>
        <button class="btn btn--ghost" type="button" data-close>Huỷ</button>
        <button class="btn btn--primary" type="submit">${isNew ? 'Thêm quà' : 'Lưu thay đổi'}</button>
      </footer>
    </form>`);

  const form = bindEditor((f) => {
    const taken = new Set(items.filter((_, i) => i !== index).map((g) => g.id));
    const updated = {
      id: isNew ? slugify(f.name.value, taken) : gift.id,
      name: f.name.value,
      icon: f.icon.value,
      weight: Number(f.weight.value),
      description: f.description.value,
    };
    const own = validateGifts([updated]).errors.map((e) => e.replace(/^Quà 1: /, ''));
    if (own.length > 0) return { ok: false, errors: own };
    const next = [...items];
    if (isNew) next.push(updated);
    else next[index] = updated;
    return save('gifts', next, isNew ? `Đã thêm "${updated.name}".` : `Đã lưu "${updated.name}".`);
  });

  const chance = $('[data-chance]', form);
  const updateChance = () => {
    const weight = Number(form.weight.value) || 0;
    chance.textContent = weight > 0
      ? `Tỉ lệ trúng ≈ ${percent(weight, othersTotal + weight)} (tổng trọng số ${othersTotal + weight})`
      : '';
  };
  form.weight.addEventListener('input', updateChance);
  updateChance();

  form.querySelector('.icon-picker__list').addEventListener('click', (event) => {
    const option = event.target.closest('[data-emoji]');
    if (option) form.icon.value = option.dataset.emoji;
  });
  form.querySelector('[data-delete]')?.addEventListener('click', () => deleteGift(index));
}

async function deleteGift(index) {
  const gift = state.gifts.items[index];
  if (!gift) return;
  const ok = await confirmAction({
    title: `Xoá "${gift.name}"?`,
    message: 'Người chơi sẽ không bốc được món quà này nữa. Quà đã trao trước đó vẫn nằm trong túi quà của họ.',
    confirmLabel: 'Xoá quà',
    danger: true,
  });
  if (!ok) return;
  const result = await save('gifts', state.gifts.items.filter((_, i) => i !== index), `Đã xoá "${gift.name}".`);
  if (result.ok) {
    if (dialog.open) dialog.close();
  } else if (result.errors?.length) {
    toast(result.errors[0], 'error');
  }
}

/* -------------------------------------------------------------------------- */
/*  Đổi mật khẩu                                                                */
/* -------------------------------------------------------------------------- */

$('[data-change-password]').addEventListener('click', () => {
  openDialog(`
    <form class="editor" novalidate>
      <header class="dialog__head">
        <h2>Đổi mật khẩu</h2>
        <button class="icon-btn" type="button" data-close aria-label="Đóng">×</button>
      </header>
      <div class="dialog__body">
        <label class="field"><span class="field__label">Mật khẩu hiện tại</span><input name="current" type="password" autocomplete="current-password" required /></label>
        <label class="field"><span class="field__label">Mật khẩu mới <small>(ít nhất 8 ký tự)</small></span><input name="next" type="password" autocomplete="new-password" minlength="8" required /></label>
        <label class="field"><span class="field__label">Nhập lại mật khẩu mới</span><input name="confirm" type="password" autocomplete="new-password" required /></label>
        <div class="form-errors" data-errors hidden></div>
      </div>
      <footer class="dialog__foot">
        <span class="spacer"></span>
        <button class="btn btn--ghost" type="button" data-close>Huỷ</button>
        <button class="btn btn--primary" type="submit">Đổi mật khẩu</button>
      </footer>
    </form>`);

  bindEditor(async (f) => {
    if (f.next.value.length < 8) return { ok: false, errors: ['Mật khẩu mới cần ít nhất 8 ký tự.'] };
    if (f.next.value !== f.confirm.value) return { ok: false, errors: ['Hai lần nhập mật khẩu mới không khớp.'] };
    try {
      await api('/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
      toast('Đã đổi mật khẩu. Các phiên đăng nhập khác đã bị đăng xuất.');
      return { ok: true };
    } catch (error) {
      if (handleAuthError(error)) return { ok: false, errors: [] };
      return { ok: false, errors: [error.message] };
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Khởi động                                                                   */
/* -------------------------------------------------------------------------- */

async function boot() {
  try {
    const { user } = await api('/session');
    state.user = user;
    await enterApp();
  } catch (error) {
    if (error.status === 401) showLogin();
    else {
      showLogin(error.message);
    }
  }
}

boot();
