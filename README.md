# PatentLens AI v40 — máy tự đọc ứng viên, xếp D1–D3, lập đối chiếu và báo cáo dự thảo

**Đây là prototype phục vụ nghiên cứu. Không phải công cụ tự kết luận pháp lý hoặc tra cứu hết nguồn sáng chế toàn cầu.** Mã nguồn và giao diện là các file độc lập **nằm cùng cấp ở root GitHub**, không nhúng HTML base64.

## Cấu trúc và triển khai

`worker.js` (API backend), `app.js` (luồng frontend/OCR/so sánh), `topic_lexicon.js` (kho khái niệm khởi tạo), `index.html` (giao diện), `style.css` (CSS), `wrangler.jsonc` (Cloudflare Worker + Static Assets), `.assetsignore` (chặn backend/config khỏi static assets), `README.md`.

Giải nén ZIP và đưa **toàn bộ 8 file** vào thư mục gốc repo. Nếu repo đã kết nối deploy Cloudflare thì kiểm tra job đã triển khai bằng cấu hình `wrangler.jsonc`; nếu chưa, từ thư mục chứa file cấu hình chạy `npx wrangler@4 deploy` trong tài khoản Cloudflare quản lý Worker. **Chỉ push GitHub không tự bảo đảm website đổi phiên bản.** Kiểm tra `https://patentlens-ai.lehuynhnhu0208.workers.dev/api/health` có `40.0.0`; `/`, `/app.js`, `/topic_lexicon.js`, `/style.css` phải trả 200. Nếu `/` lỗi 404/redirect, kiểm tra đã deploy Static Assets, không xóa API key hoặc cookie để sửa lỗi phân phối code.

Cấu hình `SERPAPI_KEY` (tìm qua SerpApi) nếu sử dụng, `GEMINI_API_KEY` + `DEEP_SEARCH_ACCESS_CODE` (ít nhất 12 ký tự) nếu chủ động bật Gemini, `EPO_CONSUMER_KEY` + `EPO_CONSUMER_SECRET` nếu dùng EPO OPS. Giá trị khóa **chỉ lưu Cloudflare Secrets, không đặt vào source/GitHub**. `PUBLIC_API_ACCESS_CODE` có thể bật cho API nhưng không thay thế Cloudflare Access, WAF/rate limit và ngân sách. Không dùng hồ sơ bí mật nếu chưa có chính sách và quyền được gửi ra bên ngoài.

## Flow 5 bước thay đổi ở v40

1. **Nhập tài liệu:** PDF, mô tả hay keyword; claims chỉ được tách khi phát hiện dạng claims, keyword-only không tự tạo claims giả. Đọc lớp chữ từng trang, OCR những trang thiếu theo lựa chọn. PDF 70+ trang scan có thể cần OCR lâu; nút OCR toàn bộ vẫn có tiến độ và báo trang lỗi. Bản scan/mô tả/hình vẽ chưa được OCR không được nói là đã đọc đủ.
2. **Định tuyến chủ đề:** gắn đồng thời Quy trình sản phẩm / Công nghệ thông tin / Hệ thống-thiết bị và khái niệm từ `topic_lexicon.js`; không sinh synonym từ các chuỗi OCR vô nghĩa. Ba nhóm không phải bộ lọc cứng làm bỏ sót nguồn.
3. **Tìm và tự xếp D1–D3:** sau khi người dùng đồng ý gửi truy vấn, máy tìm qua các nguồn đã cấu hình; tự thử lấy claims/mô tả của tối đa 10 ứng viên đầu theo từng đợt tối đa 3 lời gọi song song (timeout 18 giây/lượt), đếm số đặc điểm có cụm chữ xuất hiện trong **văn bản lấy được**, chọn D1→D3 theo số khớp giảm dần. Nếu chỉ có metadata/snippet hoặc nguồn bị lỗi, báo rõ; không gọi đó là tra cứu hay đọc toàn văn. WIPO/Espacenet/Cục SHTT là liên kết tra **thủ công** nếu không có API hợp lệ riêng.
4. **Máy tự đối chiếu:** tự tạo ma trận feature/concept × D1–D3; gợi ý câu trích **có thật trong văn bản nạp**, tô nổi bật cụm trùng ở đầu vào và tài liệu ứng viên khi tìm được. Tra cứu theo từ điển có thể kết nối thuật ngữ Việt–Anh nhưng đó là **gợi ý khái niệm**, không phải đoạn bộc lộ pháp lý. Không tự đánh dấu “Không tìm thấy” do thiếu kết quả. Chuyên gia chỉ cần mở mục tùy chọn nếu muốn ghi xác nhận/cải chính; không cần duyệt từng ô trước khi có báo cáo. Nếu được phép gửi nội dung ra AI, người dùng có thể bật Gemini ở Bước 4 để đọc sâu từng đoạn; Gemini **không tự động được gọi** khi chưa có consent và khóa. Nếu chưa bật, máy dùng bộ khớp cụm từ trong trình duyệt, không phải semantic AI.
5. **Nhận định + báo cáo:** trình bày D1, D2, D3 lần lượt những đoạn tìm được, rồi tự lập nhận định ban đầu riêng từng claim. Có ứng viên trùng nguyên văn mọi đặc điểm vẫn chỉ là **cảnh báo có nguy cơ ảnh hưởng tính mới**, vì còn phải kiểm tra cùng tổ hợp, hiệu lực ngày, ngữ nghĩa và toàn văn. Không tìm được đoạn khớp ≠ chứng minh “có tính mới”. Trình độ sáng tạo không thể được xác nhận chỉ vì D2/D3 bổ sung vài đặc điểm; báo cáo nêu gợi ý rủi ro và lý do chưa đủ cơ sở. Keyword-only chỉ báo cáo khảo sát concept, không giả làm đánh giá theo claim. Chuyên gia xem nhận định khi cần và có thể ghi nhận xét chung, không cần duyệt từng ô để máy tạo dự thảo.

## OCR tiếng Việt và giới hạn

Bản này tăng mức render mặc định cho lượt OCR trang thiếu từ 1.4 lên 1.85 (có giới hạn pixel để tránh tràn bộ nhớ), cấu hình giữ khoảng trắng và phân đoạn văn bản. **Không tự đổi `hồ đốt lửa` thành `hố đốt lửa` hoặc tự điền dấu thanh hàng loạt** vì có thể sửa sai nghĩa tài liệu kỹ thuật. Khi OCR không thể đọc phần claims, web hiển thị số trang chưa đọc, không tự biến mô tả thành bộ claim hợp lệ. Bản v40 chưa tích hợp và chưa kiểm thử Google Vision cho file PDF scan thực tế của người dùng; gọi Gemini khác với OCR và cấu hình `GEMINI_API_KEY` không làm Tesseract đọc tiếng Việt chính xác hơn.

## Kiểm thử tối thiểu sau khi deploy

- Nhập keyword/đoạn mô tả: không có claims nhưng định tuyến chủ đề, tìm tài liệu, lập bảng concept, báo cáo **không** kết luận tính mới/trình độ sáng tạo.
- Nhập claims độc lập và phụ thuộc: giữ lại từng nhánh kế thừa; sau khi tìm, D1–D3 được chọn tự động và so sánh mà không cần tích từng ô. Bản PDF gốc phải được kiểm tra khi máy nhận sai claims.
- Thử tài liệu ứng viên chỉ có snippet hoặc API detail trả lỗi: ô tương ứng hiện chưa có bằng chứng và báo cáo có cảnh báo; không đánh dấu “không tìm thấy đặc điểm”.
- Thử bản PDF dài có trang ảnh: trang chưa trích xuất vẫn phải được ghi nhận; không dùng số ký tự nạp làm chứng minh đã đọc toàn bộ file/hình vẽ.
- Thử Gemini khi có consent, key, quyền truy cập: câu trích chỉ được ghi nhận nếu khớp trong văn bản đã chuyển; chấp nhận sai/ngữ cảnh chưa xác minh được gắn chú thích phù hợp.

**Kiểm thử nội bộ trước bàn giao:** kiểm tra cú pháp, API/trang chủ/asset bằng mock, UI bằng Playwright với kết quả API dựng, phân biệt keyword-only và claim-based. Chưa chạy PDF 59245/59281 gốc, SerpApi/Gemini/EPO thật hay website Cloudflare đã deploy. Không dùng kết quả mock làm số liệu khóa luận.
