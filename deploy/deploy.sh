#!/usr/bin/env bash
# Cập nhật và xuất bản Cây Câu Hỏi trên VPS.
#
# Chạy bằng user riêng của dự án (không cần sudo):
#   bash ~/app/deploy/deploy.sh
#
# Có thể đổi đường dẫn bằng biến môi trường, ví dụ:
#   WEB_ROOT=/var/www/khac bash ~/app/deploy/deploy.sh
#
# Toàn bộ nằm trong hàm main(): bash đọc hết file trước khi chạy, nên việc `git pull`
# cập nhật chính script này giữa chừng không làm lệch các lệnh đang chạy.
set -euo pipefail

main() {
  local APP_DIR="${APP_DIR:-$HOME/app}"
  local WEB_ROOT="${WEB_ROOT:-/var/www/caycauhoi}"
  local BRANCH="${BRANCH:-main}"

  # nvm không tự nạp khi chạy script, nạp thủ công để có lệnh node / npm.
  export NVM_DIR="$HOME/.nvm"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "Chưa có Node.js. Cài bằng: nvm install 22" >&2
    exit 1
  fi

  cd "$APP_DIR"
  if [ -f .nvmrc ] && command -v nvm >/dev/null 2>&1; then
    nvm use --silent >/dev/null
  fi
  echo "==> Node $(node -v), npm $(npm -v)"

  echo "==> Kéo code mới nhất (nhánh $BRANCH)"
  git fetch --prune origin
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
  echo "    Commit: $(git log -1 --pretty='%h %s')"

  echo "==> Cài thư viện"
  npm ci --no-audit --no-fund

  echo "==> Build"
  npm run build

  echo "==> Xuất bản ra $WEB_ROOT"
  mkdir -p "$WEB_ROOT/data"
  # data/ (câu hỏi & quà) do CMS quản lý trên server: không ghi đè, chỉ tạo lần đầu.
  rsync -a --delete --exclude 'data/' dist/ "$WEB_ROOT/"
  local file
  for file in questions.json gifts.json; do
    if [ ! -f "$WEB_ROOT/data/$file" ]; then
      cp "dist/data/$file" "$WEB_ROOT/data/$file"
      echo "    Tạo dữ liệu ban đầu: data/$file"
    fi
  done

  echo "==> Khởi động lại CMS"
  if sudo -n systemctl restart caycauhoi-cms 2>/dev/null; then
    echo "    Đã khởi động lại caycauhoi-cms"
  else
    echo "    (Bỏ qua: chưa cài dịch vụ caycauhoi-cms hoặc chưa cấp quyền restart)"
  fi

  echo "==> Xong lúc $(date '+%H:%M:%S %d/%m/%Y')"
}

main "$@"
