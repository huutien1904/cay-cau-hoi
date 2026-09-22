import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LoginLimiter,
  PASSWORD_MAX,
  PASSWORD_MIN,
  Sessions,
  hashPassword,
  loadUsers,
  saveUsers,
  verifyAgainstDummy,
  verifyPassword,
} from './auth.js';
import { ConflictError, JsonStore } from './store.js';
import { validateGifts, validateQuestions } from './validate.js';

/*
 * Máy chủ CMS của Cây Câu Hỏi — Node.js thuần, không cần thư viện ngoài.
 *
 * Chỉ nghe ở 127.0.0.1; Nginx chuyển tiếp /cms-api/ tới đây.
 * Biến môi trường:
 *   CMS_PORT         cổng (mặc định 4310)
 *   CMS_CONTENT_DIR  thư mục chứa questions.json & gifts.json mà trò chơi đọc
 *                    (mặc định public/data của repo — dùng khi phát triển trên máy)
 *   CMS_PRIVATE_DIR  thư mục riêng: tài khoản quản trị + bản sao lưu (mặc định ~/.caycauhoi-cms)
 *   NODE_ENV=production  bật cookie Secure (bắt buộc HTTPS)
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const config = {
  host: process.env.CMS_HOST || '127.0.0.1',
  port: Number(process.env.CMS_PORT || 4310),
  contentDir: path.resolve(process.env.CMS_CONTENT_DIR || path.join(ROOT, 'public', 'data')),
  privateDir: path.resolve(process.env.CMS_PRIVATE_DIR || path.join(os.homedir(), '.caycauhoi-cms')),
  secureCookie: process.env.NODE_ENV === 'production',
  sessionTtlMs: 8 * 60 * 60 * 1000,
  bodyLimit: 1024 * 1024,
};

const COOKIE_NAME = 'cch_session';
const COOKIE_PATH = '/cms-api';

const store = new JsonStore({ contentDir: config.contentDir, privateDir: config.privateDir });
const sessions = new Sessions({ ttlMs: config.sessionTtlMs });
const limiter = new LoginLimiter();

const COLLECTIONS = {
  questions: validateQuestions,
  gifts: validateGifts,
};

/* ------------------------------------------------------------------------ */
/*  Tiện ích HTTP                                                            */
/* ------------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function sessionCookie(token, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.secureCookie) parts.push('Secure');
  return parts.join('; ');
}

function clientIp(req) {
  // Nginx đặt X-Real-IP; máy chủ chỉ nghe ở 127.0.0.1 nên header này đáng tin.
  return req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'Yêu cầu phải gửi dữ liệu JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.bodyLimit) throw new HttpError(413, 'Dữ liệu gửi lên quá lớn (tối đa 1 MB).');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Dữ liệu JSON không hợp lệ.');
  }
}

/** Chặn yêu cầu thay đổi dữ liệu đến từ trang web khác (CSRF). */
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Nguồn yêu cầu không hợp lệ.');
  }
  if (host !== req.headers.host) throw new HttpError(403, 'Nguồn yêu cầu không hợp lệ.');
}

function requireSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const session = sessions.get(token);
  if (!session) throw new HttpError(401, 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.');
  return { token, session };
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

/* ------------------------------------------------------------------------ */
/*  Xử lý từng API                                                           */
/* ------------------------------------------------------------------------ */

async function handleLogin(req, res) {
  assertSameOrigin(req);
  const ip = clientIp(req);
  const gate = limiter.check(ip);
  if (!gate.allowed) {
    const minutes = Math.ceil(gate.retryAfter / 60);
    throw new HttpError(429, `Đăng nhập sai quá nhiều lần. Thử lại sau khoảng ${minutes} phút.`, { retryAfter: gate.retryAfter });
  }

  const body = await readJson(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const users = await loadUsers(config.privateDir);
  if (users.length === 0) {
    throw new HttpError(503, 'Chưa có tài khoản quản trị. Tạo bằng lệnh: npm run cms:set-password -- <tên-đăng-nhập>');
  }

  const user = users.find((u) => u.username === username);
  const ok = user && password.length <= PASSWORD_MAX
    ? await verifyPassword(password, user)
    : await verifyAgainstDummy(password.slice(0, PASSWORD_MAX));

  if (!ok) {
    limiter.fail(ip);
    log(`Đăng nhập thất bại: "${username.slice(0, 40)}" từ ${ip}`);
    throw new HttpError(401, 'Sai tên đăng nhập hoặc mật khẩu.');
  }

  limiter.reset(ip);
  const token = sessions.create(user.username);
  log(`Đăng nhập: ${user.username} từ ${ip}`);
  send(res, 200, { user: user.username }, { 'Set-Cookie': sessionCookie(token, config.sessionTtlMs / 1000) });
}

async function handleLogout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) sessions.destroy(token);
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
}

async function handleSession(req, res) {
  const { session } = requireSession(req);
  send(res, 200, { user: session.username });
}

async function handlePassword(req, res) {
  assertSameOrigin(req);
  const { token, session } = requireSession(req);
  const body = await readJson(req);
  const current = String(body.current || '');
  const next = String(body.next || '');

  if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX) {
    throw new HttpError(422, `Mật khẩu mới cần từ ${PASSWORD_MIN} đến ${PASSWORD_MAX} ký tự.`);
  }
  const users = await loadUsers(config.privateDir);
  const user = users.find((u) => u.username === session.username);
  if (!user || !(await verifyPassword(current, user))) throw new HttpError(403, 'Mật khẩu hiện tại không đúng.');

  Object.assign(user, await hashPassword(next), { updatedAt: new Date().toISOString() });
  await saveUsers(config.privateDir, users);
  sessions.destroyOthers(user.username, token);
  log(`Đổi mật khẩu: ${user.username}`);
  send(res, 200, { ok: true });
}

async function handleRead(req, res, name) {
  requireSession(req);
  const { data, version } = await store.read(name);
  send(res, 200, { items: data, version });
}

async function handleWrite(req, res, name) {
  assertSameOrigin(req);
  const { session } = requireSession(req);
  const body = await readJson(req);
  const { items, errors } = COLLECTIONS[name](body.items);
  if (errors.length > 0) throw new HttpError(422, 'Dữ liệu chưa hợp lệ.', { details: errors });

  try {
    const { version } = await store.write(name, items, body.version);
    log(`Lưu ${name}.json (${items.length} mục) bởi ${session.username}`);
    send(res, 200, { items, version });
  } catch (error) {
    if (error instanceof ConflictError) {
      throw new HttpError(409, 'Dữ liệu vừa được sửa ở nơi khác (tab hoặc người khác). Trang sẽ tải lại bản mới nhất.');
    }
    throw error;
  }
}

/* ------------------------------------------------------------------------ */
/*  Định tuyến                                                               */
/* ------------------------------------------------------------------------ */

const routes = {
  'POST /cms-api/login': handleLogin,
  'POST /cms-api/logout': handleLogout,
  'GET /cms-api/session': handleSession,
  'POST /cms-api/password': handlePassword,
  'GET /cms-api/questions': (req, res) => handleRead(req, res, 'questions'),
  'PUT /cms-api/questions': (req, res) => handleWrite(req, res, 'questions'),
  'GET /cms-api/gifts': (req, res) => handleRead(req, res, 'gifts'),
  'PUT /cms-api/gifts': (req, res) => handleWrite(req, res, 'gifts'),
};

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '');
  const handler = routes[`${req.method} ${pathname}`];
  try {
    if (!handler) throw new HttpError(404, 'Không tìm thấy API.');
    await handler(req, res);
  } catch (error) {
    if (error instanceof HttpError) {
      send(res, error.status, { error: error.message, ...error.extra });
    } else {
      console.error(error);
      send(res, 500, { error: 'Máy chủ gặp lỗi, vui lòng thử lại.' });
    }
  }
});

server.headersTimeout = 15000;
server.requestTimeout = 30000;

setInterval(() => {
  sessions.prune();
  limiter.prune();
}, 10 * 60 * 1000).unref();

server.listen(config.port, config.host, () => {
  log(`CMS chạy tại http://${config.host}:${config.port}`);
  log(`Nội dung: ${config.contentDir}`);
  log(`Dữ liệu riêng: ${config.privateDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
