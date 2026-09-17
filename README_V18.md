# PatentLens v18 — Research-aligned workflow (prototype, not production)

## Đầu vào chính xác
- **Prospective:** Bản mô tả giải pháp + bản **claims dự thảo** được cung cấp với sự đồng ý. Không yêu cầu số bằng.
- **Retrospective:** Sử dụng as-filed/as-published/granted **được gắn nhãn đúng phiên bản** làm nguồn lấy claims để kiểm thử. B2 không phải claims ban đầu, grant không phải ground truth.
- Với **mọi chế độ**: đối tượng thực sự được phân tích là phiên bản claims đã chọn trong ngữ cảnh mô tả kỹ thuật, relevant date và thẩm quyền tương ứng.

## Thay đổi chính v18
1. Bước 0: mode, version, source, related publications đã biết, ghi chú provenance, tách reference evidence khỏi input.
2. Nhập claims + mô tả kỹ thuật bằng tay không cần PDF, tái sử dụng pipeline 9 bước.
3. Chặn bước tiếp và đánh giá khi chưa xác nhận phiên bản claims, ngày liên quan, hoặc thiếu nguồn cho retrospective.
4. Search requires explicit third-party keyword sharing consent; confidential mode chưa đồng nghĩa bảo mật tuyệt đối.
5. Loại kết quả trùng đúng số công bố mục tiêu đã khai báo, cảnh báo trùng tiêu đề, chặn auto-pick những ứng viên nghi trùng.
6. Ghi research provenance, excluded target count vào JSON và báo cáo; JSON không bao gồm PDF gốc.
7. Xử lý tốt hơn English claims trong renderer; sửa reset trạng thái khi đổi PDF/case.
8. Không dùng granted status làm gold label, không tự tuyên bố search completeness, không kết luận bảo hộ.

## Deploy
Chỉ upload 3 file root: worker.js, package.json, wrangler.jsonc.
`/api/health` -> `version: 18.0.0`. Hard refresh và tải PDF lại (case JS in-memory).
`index_review.html` chỉ dùng kiểm tra nguồn HTML, KHÔNG upload (đã embedded trong worker.js).

## Bắt buộc kiểm thử thủ công sau deploy
A. Retrospective B2: chọn granted, điền source URL + version note, nhập related A1/B2; xác minh date; upload PDF; kiểm tra claims source.
B. Prospective: chọn prospective + draft, dán claims đánh số, mô tả; không cần số bằng; nạp claims thủ công; kiểm tra qua bước 2.
C. Từ chối consent: search không gọi API; sau consent mới search được.
D. Search target ID: chính số A1/B2 đã khai báo không được xuất hiện dưới dạng D1–D3 auto; chưa khai báo đúng family vẫn phải chuyên gia kiểm tra.
E. Report unverified: thấy thông báo chưa đạt điều kiện; không sinh assessment report hoàn chỉnh.
F. English OCR/text: soát lại trực tiếp claim và không tự sửa bằng các quy tắc tiếng Việt.

## Giới hạn chưa giải quyết
- Chưa benchmark OCR, recall/precision retrieval, evidence mapping với expert labels.
- Heuristic mapping không thay thế literal evidence, paragraph/page citations hoặc kiểm tra family chính thức.
- Legal analysis country-specific (priority, E/P, exceptions) do chuyên gia chịu trách nhiệm.
- Chưa được kiểm thử UI end-to-end trên domain Cloudflare của bạn; syntax/build chỉ là kiểm thử tĩnh.
- Cloudflare external search, JS CDN, browser storage và secrets vẫn phải được security review trước hồ sơ mật.
