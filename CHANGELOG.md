# Thay đổi v22 (so với v21)

| Nhóm | Đã sửa trong source | Vẫn còn giới hạn |
|---|---|---|
| Workflow | Thêm chọn mục đích, cảnh báo FTO; đầu vào cho phép đánh dấu chưa xác minh và rà soát muộn hơn; claim phụ thuộc gộp nội dung claim cha | Chưa có FTO/landscape; tách feature còn heuristic; người dùng phải xác nhận tính đúng luật, ngày và phiên bản |
| Retrieval | Nhiều biến thể/nguồn; ghi log status; giữ A1/B2; lấy thêm mô tả khi trang cho phép | Chưa kiểm chứng toàn văn/hình, family, Việt Nam và phủ toàn cầu; scraping có thể lỗi |
| Evidence/AI | Chỉ giữ quote khớp chữ trong văn bản gửi; không gắn xác minh nguồn; thiếu toàn văn không cho “Không tìm thấy”; quote chuyên gia phải có trong văn bản lưu | Không xác thực server-side mã công bố, vị trí/nguồn gốc hay ngữ nghĩa; AI vẫn có thể hiểu sai |
| Dates | Sau mốc công bố là “chờ kiểm tra ngày nộp/ưu tiên”, không tự loại toàn bộ | Không tự phân xử E-type/ngoại lệ theo luật hiện hành |
| Inventive step | Bỏ sinh vấn đề kỹ thuật chứa lời giải; để chuyên gia diễn đạt | Chưa tự đánh giá đáng tin cậy theo quy trình được IP GROUP phê duyệt |
| HCI | Chọn nhu cầu trước, báo status nguồn, bớt trường và % gây hiểu nhầm, cặp feature/evidence | Cần usability test thực tế, không thể khẳng định đã tối ưu HCI |
| Privacy | Bật chế độ bảo mật → khóa tính năng Gemini tìm sâu ở web; mã API chung tùy chọn khi public | Không bảo đảm hồ sơ kín trước mọi dịch vụ ngoài; cần Access, WAF/rate limits, kiểm thử, chính sách của IP GROUP |

**Đọc `README.md` trước khi deploy.** Chưa tự động cập nhật domain Cloudflare của người dùng.
