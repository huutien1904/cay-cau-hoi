import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/*
 * Đọc / ghi file JSON nội dung (questions.json, gifts.json) một cách an toàn:
 *  - Ghi nguyên tử: ghi ra file tạm rồi đổi tên, người chơi không bao giờ đọc phải file dở dang.
 *  - Chống ghi đè: mỗi lần đọc trả về "version" (hash nội dung); lưu với version cũ sẽ bị từ chối.
 *  - Sao lưu: trước mỗi lần ghi, bản cũ được lưu vào <privateDir>/backups/<tên>/ (giữ 30 bản gần nhất).
 */

const KEEP_BACKUPS = 30;

export class ConflictError extends Error {
  constructor() {
    super('Dữ liệu vừa được thay đổi ở nơi khác.');
    this.name = 'ConflictError';
  }
}

function versionOf(raw) {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export class JsonStore {
  /**
   * @param {{ contentDir: string, privateDir: string }} dirs
   */
  constructor({ contentDir, privateDir }) {
    this.contentDir = contentDir;
    this.backupDir = path.join(privateDir, 'backups');
    this._queue = Promise.resolve();
  }

  _file(name) {
    return path.join(this.contentDir, `${name}.json`);
  }

  async read(name) {
    const raw = await fs.readFile(this._file(name), 'utf8');
    return { data: JSON.parse(raw), version: versionOf(raw) };
  }

  /** Các lần ghi được xếp hàng tuần tự để hai yêu cầu cùng lúc không giẫm lên nhau. */
  write(name, data, expectedVersion) {
    const task = this._queue.then(() => this._write(name, data, expectedVersion));
    this._queue = task.catch(() => {});
    return task;
  }

  async _write(name, data, expectedVersion) {
    const file = this._file(name);
    let currentRaw = null;
    try {
      currentRaw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (currentRaw !== null && expectedVersion && versionOf(currentRaw) !== expectedVersion) {
      throw new ConflictError();
    }

    if (currentRaw !== null) await this._backup(name, currentRaw);

    const raw = `${JSON.stringify(data, null, 2)}\n`;
    await fs.mkdir(this.contentDir, { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, raw, { mode: 0o644 });
    await fs.rename(temp, file);
    return { version: versionOf(raw) };
  }

  async _backup(name, raw) {
    const dir = path.join(this.backupDir, name);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.writeFile(path.join(dir, `${stamp}.json`), raw, { mode: 0o600 });

    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) {
      await fs.rm(path.join(dir, old), { force: true });
    }
  }
}
