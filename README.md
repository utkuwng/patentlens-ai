# PatentLens v31 — GitHub root, không có thư mục con

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


## v31: PDF dài / OCR
- Đọc lớp chữ trên mọi trang PDF trước, dò metadata từ lớp chữ, tách claims và mở Bước 2 ngay; không OCR 8 trang metadata hay toàn bộ trang scan trong lượt upload.
- Ở Bước 2: **Đọc bổ sung các trang cần OCR**, tiến độ từng trang, có **Dừng OCR**. Mọi trang chưa đọc còn được báo trong kiểm tra độ bao phủ; không gắn nhãn đã đọc hết hoặc đưa kết luận đáng tin cậy khi còn trang chưa kiểm tra.
- PDF chỉ có ảnh có thể chưa tách hết claims trong lượt nhanh; bấm **Quét thêm trang tìm claims** hoặc **Đọc bổ sung**. Mỗi trang OCR có thể tốn nhiều thời gian, đặc biệt ở máy yếu. Không bảo đảm hình vẽ/bảng OCR đúng: đối chiếu PDF gốc trước nhận định.
- Không đưa PDF chưa công bố/được bảo mật vào dịch vụ ngoài nếu chưa có quyền.

**Chạy thử PDF dài**: sau khi deploy, tải hồ sơ công khai khoảng 70 trang. Kiểm tra tiến độ `Đang đọc lớp chữ PDF: trang x/y`; web tự chuyển Bước 2 ngay sau khi đọc lớp chữ; nếu ảnh scan, OCR thử claims ở chế độ nền và phần còn thiếu có nhãn cảnh báo. Ở Bước 2, bấm `Đọc bổ sung ... trang cần OCR` để quét các trang còn thiếu nếu cần nhận định. Trường hợp CDN Tesseract lỗi, giữ ghi nhận trang thiếu thay vì ghi `đã đọc hết`.
