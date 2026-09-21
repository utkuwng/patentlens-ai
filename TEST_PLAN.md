# Kế hoạch kiểm thử PatentLens v24

## 1. Bài kiểm thử đã viết (backend và cấu trúc UI)

Chạy: `node --test test_v24.mjs`. Mục tiêu: kiểm tra backend bằng provider **mô phỏng**, endpoint/phiên bản mới, và giao diện HTML có hai thẻ bắt đầu; không còn lựa chọn khảo sát công nghệ/FTO ở form đầu; phần gợi ý tiếp theo được ẩn ban đầu và chỉ hiển thị khi tạo báo cáo thành công. Bài kiểm thử **không** chứng minh đã chạy website bằng trình duyệt hoặc trên Cloudflare.

## 2. Bài kiểm thử giao diện thật cần làm sau deploy

1. Mở website trong cửa sổ ẩn danh. Màn đầu chỉ có hai thẻ bắt đầu. Chọn “Chuẩn bị đăng ký”, sau đó chọn có/không có claims; kiểm tra hướng dẫn đúng và phần nhập liệu hiện ra. Quay lại, chọn “Kiểm thử tài liệu công khai”, kiểm tra các nút chọn phiên bản A1/B2.
2. Nhập claims và dữ liệu công khai đủ điều kiện, đi tới cuối, bấm tạo báo cáo. **Chỉ lúc này** hai thẻ “Khảo sát công nghệ” / “Chuẩn bị sản xuất, kinh doanh” mới hiện. Mở cả hai: chỉ có giải thích/hướng chuyên gia, **không có hành động giả chạy chức năng**.
3. Không điền đủ dữ liệu hoặc chưa xác minh ngày/nguồn: bấm tạo báo cáo phải bị chặn; các thẻ gợi ý cuối vẫn bị ẩn.
4. Nhập lại case JSON từ v23 (hồ sơ mới và tài liệu công khai), xác minh chế độ và claims được khôi phục; hai chức năng ngoài phạm vi không được kích hoạt.
5. Kiểm thử desktop/mobile: không tràn khung, nút chọn nổi bật, nội dung báo cáo và phần gợi ý dễ đọc. Kiểm thử một case cùng chuyên gia IP GROUP và ghi vấn đề thực tế.

## 3. Giới hạn công bố

Bản v24 **không thêm nguồn patent toàn cầu, không có FTO/landscape tự động, không nâng độ chính xác của AI**. Không dùng bài test mock làm số liệu khóa luận; kết quả thực nghiệm cần có hồ sơ công khai, nguồn gốc, phiên bản claims, chuyên gia xác nhận và tiêu chí đo từ trước.
