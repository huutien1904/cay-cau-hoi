# Cây Câu Hỏi — trò chơi đố vui 3D

Một cây 3D phát sáng, mỗi chiếc lá là một câu hỏi. Người chơi bấm (hoặc chạm) vào lá để mở câu hỏi có 4 đáp án:

- **Trả lời đúng:** lá chuyển sang vàng kim, sáng rực lên và người chơi được mở một hộp quà ngẫu nhiên.
- **Trả lời sai:** hiện đáp án đúng, câu hỏi tự đóng và lá bị khoá (chuyển đỏ mờ). Mỗi câu chỉ có một lượt.
- **Xem lại:** bấm vào lá đã trả lời để xem lại câu hỏi và đáp án.

Công nghệ: Vite · Three.js r186 · GSAP · OrbitControls · EffectComposer + UnrealBloomPass.

## Chạy dự án

```bash
npm install
npm run dev       # http://localhost:5173 (có --host để mở từ điện thoại cùng mạng Wi-Fi)
npm run build     # xuất ra dist/
npm run preview   # chạy thử bản build
```

## Trang quản trị (CMS)

Địa chỉ: **`/admin/`**, ví dụ `https://caycauhoi.huutiendigital.com/admin/`. Đăng nhập xong có thể:

- **Câu hỏi:** tìm kiếm không dấu, lọc theo chủ đề, thêm / sửa / xoá, chọn đáp án đúng, nhập hoặc xuất cả bộ câu hỏi bằng file JSON.
- **Quà tặng:** sửa biểu tượng, tên, mô tả, trọng số. Tỉ lệ trúng (%) được tính sẵn cho từng món.
- **Tài khoản:** đổi mật khẩu, đăng xuất.

Mỗi thay đổi được lưu ngay. Người chơi thấy nội dung mới khi tải lại trò chơi. Trước mỗi lần lưu, máy chủ tự sao lưu bản cũ (giữ 30 bản gần nhất) vào `~/.caycauhoi-cms/backups/`.

**Tạo tài khoản quản trị** (hoặc đặt lại mật khẩu khi quên), chạy trên máy chủ bằng user `caycauhoi`:

```bash
cd ~/app && npm run cms:set-password -- admin
```

**Cách hoạt động:**

- Máy chủ CMS là `server/index.js`, viết bằng Node thuần, không cần thư viện ngoài. Nó chỉ nghe ở `127.0.0.1:4310`, Nginx chuyển tiếp `/cms-api/` tới đó.
- Máy chủ ghi thẳng vào `data/questions.json` và `data/gifts.json` của trang web. Script deploy **không ghi đè** thư mục `data/` này, nên câu hỏi đã sửa trên CMS không bị mất khi cập nhật code. File trong `public/data/` của repo chỉ là dữ liệu ban đầu.
- **Bảo mật:**
  - mật khẩu băm bằng scrypt;
  - cookie phiên có HttpOnly, Secure, SameSite=Strict, hết hạn sau 8 giờ không dùng;
  - chặn yêu cầu từ trang web khác;
  - khoá 15 phút sau 8 lần đăng nhập sai;
  - khi hai người cùng sửa, người lưu sau được báo và tải lại bản mới nhất.
- **Chạy thử trên máy:** chạy `npm run cms:set-password -- admin`, rồi `npm run cms` và `npm run dev`, sau đó mở `http://localhost:5173/admin/`. Khi chạy trên máy, CMS ghi vào `public/data/` của repo.

## Sửa câu hỏi và quà bằng tay

Nên sửa qua trang quản trị. Hai file `public/data/*.json` trong repo chỉ là dữ liệu ban đầu: khi đã có trên máy chủ, sửa chúng rồi deploy sẽ **không** ghi đè dữ liệu đang chạy. Muốn thay cả bộ câu hỏi, dùng nút **Nhập file** trong CMS. Định dạng file như sau.

**`questions.json`**: mỗi câu hỏi là một chiếc lá, và số lá trên cây tự khớp theo số câu hỏi.

```json
{
  "id": "Q001",
  "category": "Địa lý",
  "question": "Thủ đô của Việt Nam là thành phố nào?",
  "answers": ["TP. Hồ Chí Minh", "Hà Nội", "Huế", "Đà Nẵng"],
  "correct": 1,
  "note": "Giải thích ngắn, hiện sau khi trả lời (không bắt buộc)."
}
```

- `answers` phải có đúng 4 đáp án. `correct` là vị trí của đáp án đúng, đếm từ 0.
- Mỗi lần mở câu hỏi, thứ tự 4 đáp án được đảo ngẫu nhiên.
- Câu sai định dạng sẽ bị bỏ qua và có cảnh báo trong console.
- `id` phải cố định và không trùng nhau, vì tiến độ người chơi được lưu theo `id`.

**`gifts.json`**: danh sách quà. `weight` càng lớn thì càng dễ trúng; tổng trọng số không cần bằng 100.

```json
{ "id": "coffee", "name": "Voucher cà phê", "icon": "☕", "weight": 20, "description": "…" }
```

## Cấu trúc

```
index.html                  HUD, panel câu hỏi, modal (quà / túi quà / chơi lại / hoàn thành), onboarding
style.css                   Giao diện (desktop + mobile ≤ 720px: panel câu hỏi thành bottom sheet)
public/models/…glb          Thân cây (không lá)
public/data/questions.json  100 câu hỏi demo (kiến thức chung Việt Nam)
public/data/gifts.json      8 loại quà demo
src/
  main.js                   Khởi tạo, nạp câu hỏi + model, intro
  Scene3D.js                Renderer, camera, OrbitControls cảm ứng, bloom, bay camera, chất lượng thích ứng
  TreeLoader.js             Load .glb, phân tích đỉnh → vị trí lá, hạt sáng, vệt năng lượng
  LeafLayer.js              Gán câu hỏi vào lá, trạng thái lá (chưa trả lời / đúng / sai), chọn lá
  CityBackdrop.js           Phông nền thành phố đêm tím 360° + mặt nước phản chiếu (vẽ bằng code)
  ui/QuizUI.js              Số liệu, câu hỏi, đúng/sai, hộp quà, túi quà, chơi lại, hoàn thành
  data/QuizData.js          Nạp dữ liệu, bốc quà theo trọng số, lưu tiến độ (localStorage)
  Shaders/EnergyShader.js   Toàn bộ GLSL
  utils/textures.js         Texture vòng sáng
```

## Lưu ý

- **Chỉ là bản demo phía trình duyệt.**
  - Đáp án nằm sẵn trong `questions.json`, nên người rành kỹ thuật có thể xem trước.
  - Quà được bốc ngẫu nhiên ngay trên máy người chơi.
  - Muốn trao quà thật, cần một máy chủ giữ đáp án, kiểm tra câu trả lời, bốc quà, giới hạn số lượng quà và xác thực người chơi.
- **Tiến độ** (câu đã trả lời, quà đã nhận) lưu trong `localStorage` của từng trình duyệt. Nút **Chơi lại** ở góc phải xoá toàn bộ tiến độ.
- **Phím tắt trên máy tính:**
  - `1`–`4` hoặc `A`–`D` để chọn đáp án;
  - `Esc` để đóng.
- **Hiệu năng:** MSAA chỉ bật trên màn DPR thấp. Sau intro, app tự hạ chất lượng khi dưới ~42 FPS.
- **Chế độ dev:** `window.__questionTree` là handle để debug và chỉ tồn tại khi chạy dev.
