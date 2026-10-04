# PatentLens AI v45 — Auto Pillar + Better Keywords + Search Recovery

## 1. Flow chính

PDF / văn bản đầu vào
→ đọc lớp chữ / OCR `vie+eng`
→ làm sạch Unicode và lỗi OCR cơ bản
→ trích keyword từ chính tài liệu (ưu tiên title / abstract / claims)
→ tự phân loại vào 1 trong 3 trụ cột
→ chuẩn hóa keyword và tạo truy vấn VI/EN
→ tra cứu tài liệu sáng chế + tài liệu khoa học liên quan online
→ xếp hạng theo mức khớp keyword
→ chọn D1–D3
→ đối chiếu feature / evidence
→ nhận định sơ bộ và báo cáo.

Không dùng kho keyword kỹ thuật theo ngành để tra cứu. `keyword_extractor.js` chỉ chứa stopword/nguyên tắc làm sạch ngôn ngữ và ba nhãn trụ cột.

## 2. Tự phân loại trụ cột không cần Gemini API key

`wrangler.jsonc` đã thêm Workers AI binding:

```json
"ai": { "binding": "AI" }
```

Sau deploy, Worker có thể dùng `env.AI` để tự phân loại và chuẩn hóa keyword mà không cần nhập API key ở trình duyệt.

Thứ tự fallback của `/api/route-plan`:
1. Gemini nếu có `GEMINI_API_KEY`.
2. Cloudflare Workers AI (`env.AI`).
3. Bộ phân loại cấu trúc cục bộ nếu không có AI binding.

Bộ phân loại cục bộ chỉ dùng tín hiệu cấu trúc/ngôn ngữ rất rộng để chọn ba trụ cột; không dùng làm kho từ khóa tra cứu.

## 3. Vì sao v44 có thể không search được

V44 có hai điểm dễ gây lỗi:
- Nếu `PUBLIC_API_ACCESS_CODE` được đặt nhưng giao diện không nhập đúng mã, toàn bộ `/api/search`, `/api/route-plan`, `/api/detail` có thể trả 403.
- Google Patents direct/HTML là đường không chính thức và có thể bị rate-limit/block; nếu EPO/SerpApi chưa cấu hình thì không còn nguồn patent ổn định.

V45 bỏ gate `PUBLIC_API_ACCESS_CODE` khỏi các endpoint nghiên cứu thông thường. Nếu cần bảo vệ site public, dùng Cloudflare Access/WAF. Các endpoint AI sâu vẫn dùng `DEEP_SEARCH_ACCESS_CODE`.

## 4. Search recovery

V45 thử các nguồn patent khi khả dụng:
- SerpApi / Google Patents nếu có `SERPAPI_KEY`.
- Google Patents direct no-key.
- Google Patents HTML fallback.
- Cloudflare Browser Rendering nếu binding `BROWSER` hoạt động.
- EPO OPS nếu có `EPO_CONSUMER_KEY` + `EPO_CONSUMER_SECRET`.

Ngoài ra, để tránh tình trạng “không ra gì” khi nguồn patent bị chặn, hệ thống luôn thử thêm:
- OpenAlex (paper / NPL, không cần API key).
- Crossref (paper / NPL, không cần API key).

Kết quả được gắn nhãn `Patent` hoặc `Paper/NPL`. Paper/NPL chỉ là ứng viên tài liệu có trước; cần kiểm tra ngày công khai và toàn văn trước khi dùng.

## 5. Keyword v45

Keyword extractor đã sửa để:
- không nhầm từ tiếng Việt có dấu khi fold dấu (`nảy` không còn bị xem như `này`);
- nhận diện tốt hơn tiếng Việt không dấu;
- ưu tiên title, abstract và claims thay vì metadata/boilerplate;
- ưu tiên cụm kỹ thuật hoàn chỉnh 2–5 từ;
- giảm các cụm n-gram bị cắt giữa câu;
- giữ `source_term` từ tài liệu và tách `normalized_term` để AI chỉ sửa lỗi OCR nhỏ khi có đủ ngữ cảnh.

Ví dụ với hồ sơ “QUY TRÌNH SẢN XUẤT BỘT DINH DƯỠNG TỪ HẠT THANH LONG NẢY MẦM”, extractor ưu tiên các cụm như:
- `sản xuất bột dinh dưỡng`
- `hạt thanh long nảy mầm`
- `bột thanh long`
- `bột nhàu`
- `đóng gói`

## 6. OCR

Tesseract vẫn chạy `vie+eng`. V45 tăng độ phân giải render và áp dụng grayscale/contrast nhẹ trước OCR. Kết quả confidence thấp vẫn được đánh dấu để kiểm tra lại, không tự coi là chính xác.

## 7. Deploy

Giữ các file ở root repo:
- `index.html`
- `app.js`
- `style.css`
- `keyword_extractor.js`
- `worker.js`
- `wrangler.jsonc`

Deploy:

```bash
npx wrangler@4 deploy
```

Sau deploy kiểm tra:
- `/api/health` trả `version: 45.0.0`.
- `providers.workers_ai` nên là `true` nếu binding AI hoạt động.
- `providers.browser` cho biết Browser Rendering binding có hoạt động hay không.
- Search log phải hiển thị cụ thể provider nào OK / ZERO / ERROR.

## 8. Secrets tùy chọn

Không bắt buộc để chạy flow cơ bản:
- `GEMINI_API_KEY` — model ngoài Cloudflare, tùy chọn.
- `GOOGLE_TRANSLATE_API_KEY` hoặc `GOOGLE_CLOUD_API_KEY` — dịch VI/EN nếu không dùng Workers AI.
- `SERPAPI_KEY` — tăng độ ổn định Google Patents.
- `EPO_CONSUMER_KEY`, `EPO_CONSUMER_SECRET` — EPO OPS.
- `DEEP_SEARCH_ACCESS_CODE` — chỉ cho tính năng AI đọc sâu có phí.

`PUBLIC_API_ACCESS_CODE` không còn được dùng để khóa flow thông thường ở v45.
