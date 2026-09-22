import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

/*
 * Tài khoản quản trị, phiên đăng nhập và chống dò mật khẩu.
 *
 * Mật khẩu được băm bằng scrypt (có muối riêng), lưu trong <privateDir>/admins.json (quyền 600).
 * Phiên đăng nhập giữ trong bộ nhớ: khởi động lại máy chủ CMS thì cần đăng nhập lại.
 */

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const USERS_FILE = 'admins.json';

export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return { algo: 'scrypt', salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export async function verifyPassword(password, record) {
  try {
    const expected = Buffer.from(record.hash, 'base64');
    const actual = await scrypt(password, Buffer.from(record.salt, 'base64'), expected.length, SCRYPT_PARAMS);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Bản ghi giả để so mật khẩu khi tên đăng nhập không tồn tại (thời gian phản hồi như nhau).
let dummyRecord = null;
export async function verifyAgainstDummy(password) {
  dummyRecord ??= await hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, dummyRecord);
  return false;
}

export async function loadUsers(privateDir) {
  try {
    const raw = await fs.readFile(path.join(privateDir, USERS_FILE), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.users) ? data.users : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function saveUsers(privateDir, users) {
  await fs.mkdir(privateDir, { recursive: true, mode: 0o700 });
  const file = path.join(privateDir, USERS_FILE);
  const temp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temp, `${JSON.stringify({ users }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  return file;
}

export class Sessions {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    /** @type {Map<string, { username: string, expires: number }>} */
    this.map = new Map();
  }

  create(username) {
    const token = randomBytes(32).toString('base64url');
    this.map.set(token, { username, expires: Date.now() + this.ttlMs });
    return token;
  }

  /** Lấy phiên còn hạn và gia hạn thêm (phiên trượt). */
  get(token) {
    if (!token) return null;
    const session = this.map.get(token);
    if (!session) return null;
    if (session.expires < Date.now()) {
      this.map.delete(token);
      return null;
    }
    session.expires = Date.now() + this.ttlMs;
    return session;
  }

  destroy(token) {
    this.map.delete(token);
  }

  /** Đăng xuất mọi phiên khác của một tài khoản (dùng khi đổi mật khẩu). */
  destroyOthers(username, keepToken) {
    for (const [token, session] of this.map) {
      if (session.username === username && token !== keepToken) this.map.delete(token);
    }
  }

  prune() {
    const now = Date.now();
    for (const [token, session] of this.map) if (session.expires < now) this.map.delete(token);
  }
}

/** Khoá tạm một địa chỉ IP sau nhiều lần đăng nhập sai. */
export class LoginLimiter {
  constructor({ maxAttempts = 8, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.map = new Map();
  }

  check(ip) {
    const entry = this.map.get(ip);
    if (!entry) return { allowed: true };
    if (entry.resetAt < Date.now()) {
      this.map.delete(ip);
      return { allowed: true };
    }
    if (entry.count >= this.maxAttempts) {
      return { allowed: false, retryAfter: Math.ceil((entry.resetAt - Date.now()) / 1000) };
    }
    return { allowed: true };
  }

  fail(ip) {
    const entry = this.map.get(ip);
    if (!entry || entry.resetAt < Date.now()) this.map.set(ip, { count: 1, resetAt: Date.now() + this.windowMs });
    else entry.count++;
  }

  reset(ip) {
    this.map.delete(ip);
  }

  prune() {
    const now = Date.now();
    for (const [ip, entry] of this.map) if (entry.resetAt < now) this.map.delete(ip);
  }
}
