import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PASSWORD_MAX, PASSWORD_MIN, USERNAME_PATTERN, hashPassword, loadUsers, saveUsers } from './auth.js';

/*
 * Tạo tài khoản quản trị hoặc đặt lại mật khẩu.
 *
 *   npm run cms:set-password -- admin          (hỏi mật khẩu, không hiện ký tự khi gõ)
 *   echo "mat-khau" | node server/set-password.js admin   (dùng trong script)
 *
 * Lưu vào CMS_PRIVATE_DIR (mặc định ~/.caycauhoi-cms/admins.json).
 */

const privateDir = path.resolve(process.env.CMS_PRIVATE_DIR || path.join(os.homedir(), '.caycauhoi-cms'));
const username = (process.argv[2] || '').trim();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (chunk) => {
      if (!muted) rl.output.write(chunk);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}

if (!USERNAME_PATTERN.test(username)) {
  fail('Cách dùng: npm run cms:set-password -- <tên-đăng-nhập>\nTên đăng nhập 3–32 ký tự: chữ, số, dấu chấm, gạch ngang, gạch dưới.');
}

let password;
if (process.stdin.isTTY) {
  password = await askHidden(`Mật khẩu cho "${username}": `);
  const confirm = await askHidden('Nhập lại mật khẩu: ');
  if (password !== confirm) fail('Hai lần nhập mật khẩu không khớp.');
} else {
  password = await readStdin();
}

if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
  fail(`Mật khẩu cần từ ${PASSWORD_MIN} đến ${PASSWORD_MAX} ký tự.`);
}

const users = await loadUsers(privateDir);
const record = { username, ...(await hashPassword(password)), updatedAt: new Date().toISOString() };
const index = users.findIndex((u) => u.username === username);
if (index >= 0) users[index] = { ...users[index], ...record };
else users.push({ ...record, createdAt: record.updatedAt });

const file = await saveUsers(privateDir, users);
console.log(`${index >= 0 ? 'Đã đổi mật khẩu' : 'Đã tạo tài khoản'} "${username}" → ${file}`);
