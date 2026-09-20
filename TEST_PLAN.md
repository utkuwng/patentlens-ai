# Kiểm thử cần thực hiện

1. JS Worker và JS browser parse được; kiểm tra các ID DOM tham chiếu và tránh duplicate.
2. Tình huống ①: nhấn tab khách hàng; đọc 7 bước; bấm “Bắt đầu” -> nhánh trước nộp, đã có claim. Nhánh chưa có claim phải bị chặn đánh giá đầy đủ.
3. Tình huống ②: nhấn tab đơn công bố; “Bắt đầu” -> mode retrospective + published. Khi chỉ có B2 phải chọn granted.
4. Nhập claim có thật hoặc dùng tài liệu công khai đã xác minh; duyệt features -> sửa thuật ngữ -> đồng ý search -> xem nhật ký.
5. Chọn D1/D2 có nguồn URL, ngày công bố, full text; build matrix; thẻ so sánh phải cạnh nhau ở desktop và xếp dọc trên mobile.
6. Chuyên gia chọn Agree mà không có trích đoạn+vị trí phải KHÔNG lưu. Agree mà chưa verify source cũng KHÔNG lưu. Có đủ thì lưu, được tính trong đánh giá.
7. Reject mà thiếu lý do/việc tiếp theo phải KHÔNG lưu; đủ thì lưu và dẫn về đúng bước; hệ thống KHÔNG tự gọi API search.
8. Đổi nguồn -> hủy xác minh cũ. Chạy lọc pending/agree/reject. Export/import case JSON kiểm tra quote, location, reason.
9. End-to-end live và API credentials chưa được kiểm thử trong sandbox; người dùng phải test sau deploy.
