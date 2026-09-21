# Giao diện v20.1 – Kịch bản nghiệm thu
1. Mở trang lần đầu: hướng dẫn dài đóng; có 2 thẻ hồ sơ; form PDF/text và metadata không hiện trước khi chọn nhánh.
2. Chọn Hồ sơ mới → Có claims: tab nhập PDF và Dán văn bản hiện; chuyển tab hai chiều, giữ nội dung đã nhập.
3. Chọn hồ sơ công khai → chọn A1/B2: trường URL nguồn hiện, tab nhập dùng được. Chuyển B2 hiện chú thích đúng version.
4. PDF: chọn file chạy OCR/metadata như v20; Tùy chọn cho thấy cài đặt ngôn ngữ, bảo mật; checkbox đồng ý gửi từ khóa nằm tại bước Tìm tài liệu, kể cả khi nhập bằng văn bản.
5. Manual: dán claims rồi chọn Sử dụng văn bản, qua Bước 2 nếu đầy đủ metadata/xác nhận.
6. Kiểm tra thông tin: bấm nút khi thiếu fields mở phần xác minh hoặc cuộn tới thông tin hồ sơ; không tự tick xác nhận thay người dùng.
7. Chuyển qua 9 bước, nút Quay lại/Tiếp tục, helper hướng dẫn mở khi người dùng yêu cầu, report vẫn xuất được.
8. Test nhập case JSON v20: hiển thị mode, version, nguồn và nội dung đã khôi phục; PDF gốc không lưu trong JSON.
9. Desktop/mobile: viewport 1440, 1024, 768, 390 px; không bị tràn ở form và wizard; sidebar cuộn ngang trên mobile.
10. Regression: search API permission, render evidence, expert approve/reject, report, error PDF/OCR/API.

Chỉ kiểm tra cú pháp HTML/JS không thay thế các bước UI/runtime này.
