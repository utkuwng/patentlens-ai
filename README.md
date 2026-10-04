# PatentLens AI v43 — Dynamic Keywords + Online Routing/Search

## Flow
PDF / text input → đọc PDF/OCR → trích keyword trực tiếp từ tài liệu → phân loại online vào 1/3 trụ cột → tạo search plan online → tìm patent online → xếp ứng viên theo mức khớp keyword → chọn D1–D3 → đối chiếu evidence → nhận định sơ bộ / báo cáo.

### 3 trụ cột
- Quy trình sản phẩm
- Công nghệ thông tin
- Hệ thống/thiết bị

## Điểm thay đổi quan trọng so với file người dùng gửi
- `keyword_extractor.js` **không còn chứa lexicon kỹ thuật / synonym / cue để phân loại ngành**. File này chỉ trích n-gram/tần suất từ chính hồ sơ và loại stopword chung.
- Trụ cột được chọn qua `/api/route-plan` bằng Gemini từ keyword + đoạn trích của chính hồ sơ. Nếu Gemini chưa cấu hình, người dùng chọn thủ công 1 trong 3 trụ cột.
- `/api/route-plan` đồng thời tạo search queries tiếng Anh từ chính keyword/hồ sơ; không bịa patent ID/IPC/CPC.
- `worker.js` đã bỏ `VI_PATENT_PHRASES` và `builtinViToEn`; không còn từ điển kỹ thuật Việt–Anh hard-code.
- Nếu cần dịch keyword/truy vấn tiếng Việt, hệ thống gọi Google Cloud Translation **online** (nếu cấu hình), không dùng dictionary ngành cục bộ.
- `/api/search` thực sự tra cứu online qua Google Patents (direct hoặc SerpApi) và EPO OPS nếu được cấu hình.
- D1–D3 được ưu tiên theo mức khớp keyword của hồ sơ; bước đối chiếu claim/evidence không tự đổi lại thứ tự D1–D3.

## Secrets / cấu hình tùy chọn
- `GEMINI_API_KEY`: cần cho phân loại trụ cột + search plan online và AI evidence mapping.
- `GEMINI_MODEL`: mặc định `gemini-2.5-flash`.
- `GOOGLE_TRANSLATE_API_KEY` hoặc `GOOGLE_CLOUD_API_KEY`: dịch keyword/truy vấn Việt → Anh online.
- `SERPAPI_KEY`: tùy chọn cho Google Patents qua SerpApi. Nếu không có, backend thử Google Patents direct.
- `EPO_CONSUMER_KEY`, `EPO_CONSUMER_SECRET`: tùy chọn cho EPO OPS.
- `PUBLIC_API_ACCESS_CODE`: tùy chọn để giới hạn các API public.
- `DEEP_SEARCH_ACCESS_CODE`: bảo vệ các tính năng AI đọc sâu.

## Deploy
Đặt các file sau ngang hàng ở root repo và deploy bằng Wrangler:
- `index.html`
- `style.css`
- `app.js`
- `keyword_extractor.js`
- `worker.js`
- `wrangler.jsonc`

`npx wrangler@4 deploy`

Kiểm tra `/api/health` phải trả version `43.0.0`.

## Lưu ý nghiên cứu
Mức khớp keyword chỉ dùng để ưu tiên đọc tài liệu. Highlight chuỗi chữ không chứng minh một dấu hiệu kỹ thuật đã được bộc lộ đầy đủ. D1–D3, ngày công bố, tư cách prior art, tính mới và trình độ sáng tạo vẫn cần chuyên viên kiểm tra trên nguồn gốc.
