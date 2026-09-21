# PatentLens v25 — Workflow / Evidence Review (mã nguồn prototype)

**Mục đích:** hỗ trợ nghiên cứu, tra cứu tài liệu sáng chế, lập bảng đối chiếu có truy vết và nhận định sơ bộ để chuyên gia xem xét. Hai nhánh đầu vào: hồ sơ chuẩn bị đăng ký có claims dự thảo và hồ sơ công khai dùng để kiểm thử. Nếu chưa có claims, phải có chuyên gia xác định đối tượng/viết dự thảo claims rồi mới đánh giá theo từng claim. Khảo sát công nghệ và FTO **chưa được triển khai**; chỉ là gợi ý bước kế tiếp sau báo cáo. Không dùng kết quả tính mới để suy ra được tự do sản xuất/kinh doanh.

## Cài đặt và deploy

1. Giải nén ZIP. Mở terminal trong thư mục chứa `worker.js`, `package.json`, `wrangler.jsonc`.
2. `npm install` (Node 20+), đăng nhập Cloudflare (`npx wrangler login`) trong tài khoản có quyền. Kiểm tra `wrangler.jsonc` trỏ **đúng tên Worker** bạn muốn cập nhật. `npm run deploy` để đưa bản mới lên Worker. ZIP này **không tự thay đổi** domain người dùng.
3. Có thể xem `index_review.html` để xem cấu trúc giao diện; phải deploy Worker mới có backend search/AI. Nếu chạy HTML trực tiếp, một số chức năng sẽ không chạy vì cần API.
4. Secret tùy chọn theo công cụ bạn thực sự dùng: `SERPAPI_KEY`, `EPO_CONSUMER_KEY` + `EPO_CONSUMER_SECRET`, `GEMINI_API_KEY`, `GEMINI_MODEL` (mặc định `gemini-2.5-flash`), `GOOGLE_VISION_API_KEY`. `DEEP_SEARCH_ACCESS_CODE` là secret **bắt buộc dài từ 12 ký tự** để bật những API AI/tìm sâu ở server. Không đặt khóa dịch vụ vào HTML/JavaScript gửi tới trình duyệt. Có thể cấu hình `PUBLIC_API_ACCESS_CODE` (secret từ 12 ký tự) để khóa chung các route API (trừ health), nhưng **mã chung không thay thế đăng nhập, giới hạn lượt gọi, giám sát chi phí hoặc Cloudflare Access/WAF**.
5. Chỉ cho người ngoài kiểm thử bằng **tài liệu được công bố và được phép xử lý**. Tính năng AI ngoài trong UI mặc định bị khóa khi bật bảo mật; tắt chế độ này và tích xác nhận gửi dữ liệu **chỉ khi thật sự được quyền**. Cloudflare Secrets và chính sách truyền/lưu nội dung nhà cung cấp cần được rà soát trước khi đưa hồ sơ mật vào.

## Luồng ngắn cho người dùng

- Bước 1: chọn một trong hai nhánh, tải PDF hoặc dán văn bản. **Với PDF:** kiểm tra tên, ngày, claims từ bản PDF gốc rồi tích ô rà soát trước khi đi tiếp. Nếu chưa chắc mốc ngày hoặc phiên bản, cứ ghi chưa xác minh; không tích đại.
- Bước 2–3: chọn một claim, so danh sách đặc điểm với claim gốc; **bắt buộc xác nhận features** trước khi tra cứu. Công cụ tách dựa chủ yếu trên quy tắc, có thể sai về số liệu và claim phụ thuộc.
- Bước 4–5: tạo và sửa truy vấn. Nếu cần tìm từng ngôn ngữ riêng, mở **Tra cứu đa ngôn ngữ**, nhập truy vấn en và/hoặc vi và tích **Chỉ chạy các truy vấn riêng**. Hệ thống không dịch hoặc trộn hai truy vấn thủ công trong chế độ đó. Tìm tiếng Việt qua Google Patents không phải tra cứu chính thức Cục SHTT Việt Nam; ghi kết quả tra VN thủ công vào nhật ký nghiên cứu ngoài ứng dụng. Đọc tài liệu thật trước khi dùng làm chứng cứ.
- Bước 6: xem một đặc điểm cạnh văn bản nguồn, đối chiếu nguyên văn/điều kiện/vị trí. AI chỉ **gợi ý** Có/Một phần; chỉ sau khi chuyên gia lưu duyệt kèm bằng chứng mới được tính vào ma trận. Kết quả AI “Không tìm thấy” luôn được chuyển về **Chưa chắc chắn**. Nếu chuyên gia đã khảo sát nhưng chưa phát hiện, ghi rõ phạm vi và cách kiểm tra; đừng xác nhận “không tồn tại” chỉ bằng Ctrl+F.
- Bước 7–9: chuyên gia **tự chọn** tài liệu gần nhất, ghi rõ lý do rồi mới tổng hợp nhận định; tùy chọn AI gợi ý câu trích từ D2/D3 (bật có kiểm soát), **không** đưa ra kết luận Could–Would. Duyệt và xuất báo cáo; sau đó mới xuất hiện gợi ý khảo sát công nghệ/FTO, không có mô-đun tự động.

## AI dùng ở đâu? Giới hạn bằng chứng

Gemini (nếu cấu hình) gợi ý truy vấn, gợi ý đối chiếu và **tùy chọn** tìm các câu trích liên quan trong D2/D3. Backend kiểm tra nguyên văn AI trích có nằm trong **văn bản do client gửi lên**; không xác thực độc lập mã công bố, toàn văn PDF, trang/đoạn hay cách hiểu kỹ thuật. Nếu Gemini lỗi, không suy ra tài liệu không có đặc điểm. Cơ chế kiểm trích không chống ảo giác tuyệt đối. Đọc PDF/OCR dùng thư viện khác, không phải Gemini tự đọc tất cả tài liệu; tìm qua các nguồn được cấu hình và còn giới hạn.

**Nguồn thực tế:** Google Patents/SerpApi nếu API có thể chạy, EPO OPS khi cấu hình key, Crossref metadata bài báo. WIPO/Espacenet/Cục SHTT Việt Nam là nguồn tra cứu thủ công/đối chiếu, **không được tự trình bày là API đang tích hợp đầy đủ**. Google Patents direct và HTML detail phụ thuộc endpoint/HTML bên ngoài và có thể bị chặn. Nội dung mô tả có thể bị cắt, claims khác nhau giữa A1/B2, ngày ưu tiên cần chuyên gia xác minh. Tài liệu đơn mục tiêu/cùng họ, đơn nộp trước công bố sau và tư cách đối chứng phụ thuộc luật áp dụng **chưa được xử lý tự động đầy đủ**.

## Kiểm thử

`node --test test_v25.mjs` — 16 ca dùng backend **giả lập và kiểm tra cấu trúc**; không thay thế kiểm thử trên Cloudflare, đo khả năng tìm lại tài liệu liên quan hay benchmark HCI. `TEST_PLAN.md` ghi kế hoạch thử với dữ liệu thật; `PILOT_EVALUATION.md` để trống dành cho số liệu thực tế do người dùng/chuyên gia xác nhận; `CHANGELOG.md` nêu rõ đã sửa và chưa sửa.
