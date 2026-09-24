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

## v32 — SỬA LỖI ERR_TOO_MANY_REDIRECTS TRANG CHỦ

Trong v30/v31, `worker.js` biến request `/` thành `/index.html`, trong khi Cloudflare Static Assets có thể chuẩn hóa `/index.html` thành `/`. Hai bước đối nghịch gây vòng lặp redirect. v32 bỏ rewrite đó, thử đường `/` trước, fallback nội bộ tới `/index.html` nếu asset root trả 404; từ chối chuyển tiếp redirect đối nghịch. `wrangler.jsonc` thiết lập `assets.html_handling: "none"` để tắt canonical redirect HTML. Các file `app.js`, `index.html`, `style.css`, `.assetsignore` KHÔNG thay đổi so với v31: sửa v32 không sửa logic OCR hoặc AI.

### Cập nhật bản sửa trên GitHub
1. Giải nén ZIP; đưa TẤT CẢ file trong gói lên cấp gốc repo (không giữ thư mục chứa ZIP). Khi GitHub hỏi, chọn thay thế `worker.js`, `wrangler.jsonc`, `README.md` và giữ nguyên những file khác.
2. Nếu deploy tự động qua Cloudflare Workers Builds, kiểm tra lần build mới đã hoàn thành và đúng Worker `patentlens-ai`. Nếu chưa tự triển khai, trong thư mục mã chạy `npx wrangler@4 deploy` bằng tài khoản Cloudflare đang quản lý Worker. Không dán riêng `worker.js` trong Cloudflare Edit code: cần deploy cả static assets và cấu hình.
3. Sau deploy, vào trang chủ: phải HTTP 200, không có chuyển hướng qua lại. Mở Developer Tools → Network → Disable cache rồi tải lại (Mac: Cmd+Shift+R). `/app.js` và `/style.css` phải HTTP 200; `/api/health` phải JSON; `/worker.js` và `/wrangler.jsonc` phải 404.
4. Nếu vẫn bị redirect: kiểm tra Cloudflare Rules → Redirect Rules / Bulk Redirects / Page Rules / Access / _redirects trong repo nếu có; ghi nhận các URL và mã 301/302/307/308 trong Network. Bản này chỉ sửa vòng lặp trong source, không thể tự kiểm soát quy tắc redirect ngoài Worker.

**Cứu web nhanh nếu chưa deploy được v32:** vào Cloudflare Worker → Deployments → chọn deployment cũ hoạt động → Rollback (nếu có). Các Secret API không cần đổi. Không đưa API key lên GitHub.
