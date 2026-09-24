# PatentLens v30 — GitHub root, không có thư mục con

**Đặt tất cả các file ngang hàng ở gốc repository GitHub** (không tạo `public/`):

- `worker.js`: backend/API, KHÔNG chứa HTML base64.
- `index.html`: bố cục giao diện.
- `app.js`: logic phía trình duyệt.
- `style.css`: giao diện/CSS.
- `wrangler.jsonc`: cấu hình Cloudflare Worker, static assets từ thư mục gốc `.`.
- `.assetsignore`: không upload `worker.js`, `wrangler.jsonc` như tài nguyên tĩnh. Đừng bỏ file này.

## Deploy

GitHub chỉ lưu mã nguồn; **đẩy code lên GitHub chưa chắc đã cập nhật Worker**. Nếu đã kết nối repo tới Cloudflare Workers Builds, kiểm tra pipeline deploy đúng Worker `patentlens-ai` và build/deploy command `npx wrangler@4 deploy` tại root. Nếu chưa có pipeline, clone/download repo rồi chạy lệnh này trong thư mục có `wrangler.jsonc` sau khi đăng nhập Cloudflare (`npx wrangler@4 login`). Không chỉ dán `worker.js` trong Dashboard → Edit code: như vậy sẽ thiếu `index.html`, `app.js`, `style.css`.

Nếu trước đây dùng `public/`, **xóa thư mục public cũ** khỏi repo để không nhầm khi deploy. Worker chỉ cho phục vụ /, /index.html, /app.js, /style.css; /api/* do backend xử lý.

Cloudflare Secrets (`SERPAPI_KEY`, `GEMINI_API_KEY`, `DEEP_SEARCH_ACCESS_CODE`...) cấu hình trên Worker, KHÔNG đưa giá trị bí mật vào GitHub hay file mã nguồn.

## Kiểm tra sau deploy

1. Mở URL Worker, giao diện phải hiển thị; DevTools → Network: `/index.html`, `/app.js`, `/style.css` không trả 404.
2. Mở `/api/health`, xác nhận backend phản hồi.
3. Mở `/worker.js` và `/wrangler.jsonc`: phải trả 404, không tải được code backend/cấu hình dưới dạng static asset.
4. Chạy thử một case **tài liệu công khai**. Kiểm tra thông báo lỗi/API nếu chưa cấu hình secrets. Chưa coi kết quả test này là bằng chứng độ chính xác nghiệp vụ.

Bản này thay đổi cấu trúc thư mục và bảo vệ đường dẫn static; không tuyên bố nâng chất lượng AI, data, hay độ chính xác OCR.
