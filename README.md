# PatentLens AI v37 — mã nguồn GitHub dạng phẳng

## 1. Các file cùng cấp tại root

`worker.js` = backend Cloudflare Worker (không chứa secret); `app.js` = xử lý giao diện và trình duyệt; `topic_lexicon.js` = bộ thuật ngữ khởi tạo ba nhóm; `index.html` = giao diện; `style.css` = kiểu dáng; `wrangler.jsonc` = cấu hình Worker/Static Assets; `.assetsignore` = ngăn đưa backend và config vào public assets.

**Không tải nguyên ZIP vào GitHub và không deploy riêng `worker.js` bằng Edit Code.** Giải nén, tải toàn bộ file vào root repo; xác nhận file ẩn `.assetsignore` đã được commit. Tại root repo chạy `npx wrangler@4 deploy` bằng đúng tài khoản Cloudflare. Nếu dùng CI, CI phải deploy bằng `wrangler.jsonc` ở root và cả Static Assets, không phải chỉ deploy Worker. Không đưa secret vào GitHub. Nếu đang dùng Cloudflare Pages hoặc deploy khác, kiểm tra thiết lập dự án trước khi đè vào Worker đang chạy. Sau deploy, mở `/`, `/app.js`, `/topic_lexicon.js` và `/api/health`. `/api/health` trả `37.0.0` nhưng KHÔNG kiểm tra hiệu lực API bên ngoài.

## 2. Flow nghiệp vụ mới dựa trên tài liệu người dùng gửi

Các **8 lớp xử lý** được triển khai trong **9 màn hình cũ** để không làm mất hồ sơ/đường đi quen thuộc: (1) nhập PDF/text, đọc lớp chữ; (2) tách claims và rà soát khi cần; (3) tách feature + định tuyến đa nhãn ba nhóm, gợi ý IPC/CPC từ metadata **chưa tự xác minh**; (4) sinh danh mục truy vấn theo feature/kho từ; (5) tìm qua nguồn thực tế đã cấu hình, ghi log lỗi và kết quả; (6) sàng lọc ứng viên theo tiêu đề/snippet, chọn tối đa D1–D3 để đọc sâu; (7) lập bảng feature × đoạn chứng cứ và xác nhận từng ô; (8) nhận định sơ bộ, chuyên gia rà soát rồi tạo báo cáo. Màn hình 5 có phần **Kiểm toán quy trình** có thể mở khi cần, không thêm checkbox bắt buộc ở màn hình nhập.

Bản này thêm thông tin định danh tệp PDF (tên/dung lượng/số trang; SHA-256 được tính cục bộ khi tệp không quá 32 MiB và thiết bị hỗ trợ), trạng thái từng lớp khi chạy, và cảnh báo **xếp thứ tự ứng viên CHỈ dựa trên metadata/title/snippet, không phải mô hình hybrid embedding + reranking toàn văn hoặc độ phủ các đặc điểm được chứng minh**. Trường hợp mở JSON nháp, mã tệp cũ chỉ là thông tin tham chiếu, phải nạp lại bản gốc.

## 3. Đã có / CHƯA có

- **Đã có mã nguồn:** nhập PDF / văn bản, OCR bổ sung theo trang, phân tích claims theo từng claim/quan hệ kế thừa đơn, từ điển 3 nhóm đa nhãn, truy vấn đa lượt, tích hợp nguồn tìm theo cấu hình, lựa chọn D1–D3, so sánh AI khi có Gemini và được phép, gate xác nhận nguồn/ngày/chứng cứ, xuất bản nháp báo cáo. Chế độ bảo mật vẫn cần sự cho phép của người vận hành khi gửi dữ liệu ra ngoài.
- **Chưa được triển khai hoặc kiểm định trong bản này:** upload DOCX/Excel/ảnh như một đầu vào chung; virus scan file và kho lưu trữ mã hóa đa người dùng; dịch chuyên ngành xác thực; embedding/vector search, vector DB/PostgreSQL, queue/rate limit tập trung, IPC/CPC classifier có danh mục chuẩn xác thực, tải đủ toàn văn/hình của mọi quốc gia; thu thập WIPO/IP Việt Nam tự động diện rộng; quyền truy cập phù hợp cho hồ sơ khách hàng mật; đo độ chính xác, recall hay tiết kiệm thời gian bằng case thực. Những nội dung này trong tài liệu nhận xét là **kiến trúc gợi ý/roadmap**, không phải tính năng đã chạy.

Không dùng A1/B2 của chính hồ sơ mục tiêu, dữ liệu sai mốc, snippet hay bản dịch máy làm bằng chứng kết luận thiếu tính mới. Bất kỳ câu trích khớp chữ nào cũng phải được chuyên gia xác minh trực tiếp với bản gốc. Không gộp D1+D2+D3 để suy ra một claim mất tính mới. Đầu ra chỉ là bản nháp nghiên cứu cho chuyên gia xác nhận, không tự quyết định cấp bằng hoặc FTO.

## 4. Cấu hình thử nghiệm (chỉ qua Cloudflare Secret)

`SERPAPI_KEY` cho SerpApi; `GEMINI_API_KEY` cùng `DEEP_SEARCH_ACCESS_CODE` (ít nhất 12 ký tự) khi muốn dùng các tính năng Gemini có kiểm soát; tùy chọn `PUBLIC_API_ACCESS_CODE`, `EPO_CONSUMER_KEY`, `EPO_CONSUMER_SECRET`. Không đặt khóa thật trong code, GitHub hoặc JSON nháp. Khi mở thử public, bảo vệ bằng Cloudflare Access/WAF/rate limit, theo dõi quota và chỉ dùng hồ sơ đã công bố hoặc được phép gửi đi.

## 5. Kiểm tra sau triển khai

Thử file PDF công khai có claims độc lập/phụ thuộc và nhiều trang scan; xác nhận không bị chặn ở bước tải, trạng thái trang chưa đọc vẫn hiện; không trộn claims/B2 với A1; kiểm tra nhật ký từng nguồn khi SerpApi/EPO lỗi; không nhầm 0 kết quả với tính mới; thử AI bịa trích dẫn; xuất báo cáo để đối chiếu với bản gốc. `npx wrangler@4 deploy` có thể yêu cầu cài Wrangler nếu máy chưa có.
