# PatentLens AI v44 — Bilingual Keywords + Auto Pillar + Resilient Search

## Flow v44
PDF / text → đọc PDF/OCR → làm sạch Unicode & nhận diện VI/EN → trích keyword trực tiếp từ tài liệu → tối ưu keyword song ngữ VI/EN online → **tự phân loại đúng 1/3 trụ cột** → tạo search plan VI + EN → tìm patent online → xếp ứng viên theo keyword overlap → chọn D1–D3 → đối chiếu evidence → nhận định sơ bộ / báo cáo.

### 3 trụ cột
- Quy trình sản phẩm
- Công nghệ thông tin
- Hệ thống/thiết bị

Người dùng có thể chọn lại trụ cột. Khi chọn lại, hệ thống giữ lựa chọn đó và tạo lại keyword/search plan phù hợp.

## Keyword — không dùng kho từ kỹ thuật hard-code
`keyword_extractor.js` chỉ có:
- stopword/noise chung VI + EN;
- thống kê cụm từ/n-gram từ **chính tài liệu hiện tại**;
- làm sạch Unicode/mojibake/OCR line-break;
- nhận diện ngôn ngữ Việt / Anh / hỗn hợp.

Không có lexicon kỹ thuật kiểu sensor/pump/fermentation/AI/... và không có dictionary ngành cài sẵn.

Sau bước trích thô, `/api/route-plan` dùng Gemini để:
1. chọn 1 trụ cột;
2. chọn 8–12 keyword kỹ thuật tốt hơn nhưng bắt buộc bám vào các keyword đã trích;
3. tạo cặp keyword VI/EN;
4. tạo 3–5 truy vấn EN và 2–4 truy vấn VI, từ rộng đến hẹp.

Nếu chưa có Gemini nhưng người dùng tự chọn trụ cột, backend có thể dùng Google Cloud Translation (nếu cấu hình) để tạo keyword/search plan VI/EN mà không dùng dictionary cục bộ.

## Cải thiện nhận diện Việt / Anh
- Text layer PDF và OCR đều được chuẩn hóa NFC.
- Thử sửa mojibake phổ biến.
- Ghép lại từ bị ngắt bằng dấu gạch ngang ở cuối dòng PDF/OCR.
- Bộ nhận diện ngôn ngữ dùng dấu tiếng Việt + function words có dấu và không dấu, giúp nhận diện cả OCR tiếng Việt bị mất dấu.
- Tesseract chạy `vie+eng`; trang OCR có confidence thấp được giữ ở trạng thái cần kiểm tra, không coi là dữ liệu chắc chắn.

## Tra cứu online VI + EN
Search plan hiển thị rõ `[VI]` và `[EN]`. Hệ thống cố gắng chạy cả hai hướng.

Backend tìm qua:
- SerpApi / Google Patents nếu có `SERPAPI_KEY`;
- nếu không có SerpApi: Google Patents direct + Google Patents HTML fallback;
- Cloudflare Browser Run nếu binding `BROWSER` hoạt động;
- EPO OPS nếu có key/secret.

Các truy vấn còn được nới tự động (2–4 từ) để giảm trường hợp query quá hẹp không có kết quả.

## Vì sao trước đây search có thể không ra?
1. Google Patents direct bị 429/503 hoặc thay cấu trúc response.
2. Chưa cấu hình SerpApi/EPO và Browser Run không khả dụng.
3. Query quá dài hoặc keyword OCR sai.
4. Keyword tiếng Việt chưa có truy vấn tiếng Anh tương ứng.
5. `PUBLIC_API_ACCESS_CODE` được bật nhưng giao diện chưa nhập đúng mã.

v44 bổ sung nhiều đường fallback và UI có **trạng thái dịch vụ** ở sidebar để thấy nhanh Gemini / dịch VI-EN / Google Patents / EPO có sẵn hay không. Nhật ký tìm kiếm vẫn là nơi xác nhận nguồn nào thực sự chạy thành công.

## Secrets / cấu hình
### Nên có
- `GEMINI_API_KEY`: tự phân loại trụ cột + tối ưu keyword VI/EN + search plan + AI evidence.
- `GEMINI_MODEL`: mặc định `gemini-2.5-flash`.

### Khuyến nghị để search ổn định hơn
- `SERPAPI_KEY`: Google Patents qua SerpApi.
- `GOOGLE_TRANSLATE_API_KEY` hoặc `GOOGLE_CLOUD_API_KEY`: fallback dịch VI ↔ EN khi cần.
- `EPO_CONSUMER_KEY`, `EPO_CONSUMER_SECRET`: EPO OPS.

### Bảo vệ API
- `PUBLIC_API_ACCESS_CODE`: tùy chọn.
- `DEEP_SEARCH_ACCESS_CODE`: bảo vệ AI đọc sâu.

## Deploy
Đặt ngang hàng ở root repo:
- `index.html`
- `style.css`
- `app.js`
- `keyword_extractor.js`
- `worker.js`
- `wrangler.jsonc`

Deploy:

```bash
npx wrangler@4 deploy
```

Kiểm tra `/api/health` phải trả version `44.0.0` và trạng thái provider.

## Lưu ý nghiên cứu
Keyword overlap chỉ dùng để ưu tiên tài liệu cần đọc. Trùng chữ/highlight không chứng minh bộc lộ đầy đủ một dấu hiệu kỹ thuật. D1–D3, ngày công bố, tư cách prior art, tính mới và trình độ sáng tạo vẫn cần chuyên viên kiểm tra trên nguồn gốc.
