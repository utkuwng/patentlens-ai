# PatentLens v20 — Easy Evidence / Research Pilot

## Chức năng đã lập trình
- Màn hướng dẫn bằng ngôn ngữ đơn giản, mô phỏng 2 tình huống: dự thảo của khách hàng và đơn sáng chế đã công bố; 7 bước mỗi tình huống, có ví dụ chuyên gia bác bỏ rồi tìm tiếp.
- Hai ví dụ trong hướng dẫn chỉ là **mô phỏng để hiểu workflow**, không tạo dữ liệu tìm kiếm hoặc bằng chứng giả.
- 9 bước thực hiện được đổi nhãn gần ngôn ngữ người dùng; mỗi bước có mục tiêu và cảnh báo.
- Bảng so sánh nhiều cột được đưa vào phần mở rộng, mặc định hiển thị thẻ: đặc điểm ↔ đoạn nguồn + URL + % khớp chỉ để ưu tiên đọc + quyết định chuyên gia.
- Chấp nhận bằng chứng chỉ khi: có nguồn URL, ba mục nguồn xác minh, chuyên gia ghi nhận xét, tự dán đoạn gốc >=15 ký tự và vị trí >=3 ký tự.
- Khi bác bỏ bắt buộc chọn lý do và việc tiếp theo; các nút dẫn về tra cứu, sửa thuật ngữ, xem nguồn hoặc claim; KHÔNG tìm kiếm tự động.
- Có lọc đã xác nhận/chưa kiểm tra/bác bỏ, trạng thái và tiến độ. Phần đánh giá tính mới không biến % từ khóa thành % pháp lý.
- Giữ backend tìm kiếm từ v19 (Google Patents/SerpApi tùy cấu hình), không tuyên bố EPO/WIPO API đã tích hợp.

## CHƯA thực hiện, không khẳng định
- Chưa có kiểm thử production trên Cloudflare account của bạn; chưa benchmark độ bao phủ dữ liệu; chưa có EPO OPS, USPTO, WIPO API tự động; chưa có đầy đủ tìm kiếm đa ngôn ngữ và bài báo; chưa audit bảo mật.
- Nội dung chi tiết nguồn đôi khi chỉ có abstract/claims; chuyên gia bắt buộc kiểm tra bản gốc.
- Không nhập hồ sơ mật của khách hàng khi chưa có phê duyệt bảo mật và điều kiện sử dụng dịch vụ.

## Deploy
Chỉ upload đè 3 file vào GitHub root: `worker.js`, `package.json`, `wrangler.jsonc`. Kiểm tra `/api/health` phiên bản `20.0.0`, refresh trình duyệt và tải lại PDF hoặc JSON. `index_review.html` chỉ để xem/test cục bộ, không cần deploy.
