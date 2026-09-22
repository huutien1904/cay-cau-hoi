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

## Sửa câu hỏi và quà

Cả hai file nằm trong `public/data/`, nên sửa xong chỉ cần tải lại trang, không phải build lại.

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
