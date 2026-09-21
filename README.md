# PatentLens v21.0 — Evidence Research Pilot

## Cái gì đã được thêm (source code, chưa chứng minh độ chính xác thực tế)
- Tìm sâu tùy chọn bằng Gemini: chỉ đề xuất tối đa 8 từ tìm theo 4 dấu hiệu được người dùng xác nhận; người dùng bấm tìm từng từ qua provider patent hiện có *và EPO OPS song song nếu có credentials*. Không tự bịa tài liệu.
- Tìm thêm metadata bài báo Crossref theo một truy vấn; KHÔNG tự lấy full text và không đưa metadata vào kết luận.
- Kiểm tra trích dẫn AI trên server: nếu câu evidence không có trong phần văn bản D1/D2/D3 được gửi hoặc quá ngắn, trả trạng thái “Chưa chắc chắn”, bỏ quote. Exact-string match không xác nhận ngữ nghĩa, tài liệu nguồn, ngày hay tính mới.
- Phần “hướng đổi mới” tự khai báo: kỹ thuật/sản phẩm, cải tiến quy trình, mô hình kinh doanh, địa phương hóa. Các nhãn này KHÔNG phải cấp độ tính mới pháp lý; chúng không điều khiển quy tắc novelty.
- Kết quả phân tích sơ bộ vẫn cần chuyên gia xác minh từng claim / từng tài liệu; không có % novelty hay độ đảm bảo bao phủ toàn cầu.

## Cài Cloudflare (bắt buộc để bật tìm sâu)
1. Upload worker.js + package.json + wrangler.jsonc lên repository đang deploy; index_review.html chỉ để xem source HTML, đã nhúng trong worker.js.
2. Cloudflare Secrets (KHÔNG viết khóa vào code): GEMINI_API_KEY, DEEP_SEARCH_ACCESS_CODE (chuỗi riêng dài >=12 ký tự). Nhập access code khi mở phần “Tìm sâu hơn với AI”; không phát public mã.
3. Tùy chọn: GEMINI_MODEL=gemini-2.5-pro (mô hình nặng hơn, tốn phí hơn, **chưa benchmark**), SERPAPI_KEY, EPO_CONSUMER_KEY, EPO_CONSUMER_SECRET. Nếu không có provider tìm kiếm thực sự, AI chỉ gợi ý từ khóa, không lấy được prior art.
4. Kiểm tra /api/health thấy version 21.0.0 và cờ deep_search_enabled. Nếu thiếu secret, AI tìm sâu trả lỗi rõ ràng 503; nút tìm sáng chế cũ vẫn hoạt động theo provider cũ.

## Bảo mật và giới hạn
- Cùng mã truy cập bảo vệ cả /api/matrix dùng Gemini; chưa có mã thì app rơi về so khớp cục bộ. Mã truy cập đơn giản chỉ giảm rủi ro gọi API vô tình; KHÔNG thay Cloudflare Access, WAF, rate limit, ngân sách Gemini/SerpApi hoặc kiểm toán an ninh. /api/search và /api/ocr cũ vẫn chưa có đăng nhập/giới hạn thực thi ở backend. KHÔNG PUBLIC cho mọi người để nhập hồ sơ mật hay sử dụng miễn phí không giới hạn.
- Khi bấm tìm sâu, nội dung 1–4 dấu hiệu kỹ thuật được gửi qua backend tới Gemini, không chỉ từ khóa; chỉ dùng hồ sơ công khai hoặc được phép gửi cho AI. Crossref và provider tìm patent nhận truy vấn từ khóa.
- Chưa có benchmark thực tế; EPO OPS là fallback trong tra cứu thường và được gọi song song trong tìm sâu nếu có credentials; không có WIPO auto-search/PatentsView hay crawling nguồn quốc gia.
- Lần đầu chạy, cần kiểm thử độc lập trên domain Cloudflare thực tế và chuyên gia kiểm tra ngày, family, nghĩa kỹ thuật, full text/hình vẽ.
