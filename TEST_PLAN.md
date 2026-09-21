# PatentLens v25 — Kiểm thử và giới hạn xác nhận

## A. Kiểm thử mã nguồn có thể lặp lại

Chạy trong thư mục ZIP đã giải nén (cần Node 20+):

```bash
node --check worker.js
node --test test_v25.mjs
```

`test_v25.mjs` có 16 ca dùng **dữ liệu và phản hồi dịch vụ giả lập**: HTML nhúng, mã API, hợp nhất kết quả và phân biệt ZERO/ERROR, Gemini chỉ trích khớp chuỗi, không xác minh nguồn, không cho AI xác nhận “Không tìm thấy” ngay cả khi tự khai đọc toàn văn, kiểm tra quyền gửi dữ liệu tới `/api/motivation`, hai luồng en/vi riêng, chốt rà soát PDF và feature, lựa chọn tài liệu gần nhất thủ công, gợi ý công việc sau báo cáo. Không có API thật hay kiểm thử độ chính xác trong 16 ca này.

Để kiểm tra HTML riêng khớp HTML mà Worker phục vụ: giải mã `APP_HTML_B64` trong `worker.js` và so sánh byte với `index_review.html`.

## B. Thử nghiệm người dùng bằng trình duyệt sau deploy — CHƯA HOÀN THÀNH

1. Chọn **Kiểm thử tài liệu công khai**. Tải PDF A1; sửa thử một chữ OCR; chưa tick rà soát PDF, nút Tiếp tục phải không chuyển. Tick sau khi đối chiếu PDF gốc mới chuyển. Đọc OCR lại/parse lại claims phải cần xác nhận lại.
2. Sang bước tách feature. Chưa bấm xác nhận bộ dấu hiệu thì không được chuyển sang bước 4. Đối chiếu tỷ lệ, khoảng giá trị, thứ tự và claim phụ thuộc với nguyên văn, ghi số lỗi.
3. Bước 4–5: nhập truy vấn en/vi khác nhau, bật “Chỉ chạy”; xem log: **hai lượt riêng**, không có truy vấn tổng hợp bằng AND/OR. Ghi rõ tra VN chính thức vẫn chưa tự động. Tắt checkbox, xác nhận biến thể tự động có thể trộn thuật ngữ (hạn chế chưa giải quyết).
4. Tắt API hoặc giả lập hết quota: thấy `SEARCH_FAILED`/cảnh báo tìm chưa đầy đủ, không bị hiển thị như kết quả 0 tài liệu. Khi nguồn trả 0 đúng nghĩa, UI không suy ra sáng chế có tính mới.
5. Chỉ nhập snippet D1: không được xác nhận nguồn/đoạn vắng mặt như đã đọc toàn văn. AI bịa câu trích, sai ngữ cảnh, bỏ số liệu: chuyên gia từ chối được, nhật ký ghi lý do. Kiểm tra gợi ý `Một phần` chưa được duyệt không tự tạo một ô đối chứng đã xác nhận.
6. Bước 7: không chọn D1/D2/D3 hoặc không nhập lý do closest thì không thể tổng hợp. Bật bảo mật: bấm gợi ý D2/D3 **không** gọi API; khi tắt bảo mật và tích consent với case công khai mới cho gửi. Đoạn AI bịa không xuất hiện trong gợi ý. Không tự điền Could–Would.
7. Khả năng đọc/mobile: thử laptop, điện thoại, văn bản dài 20 trang, nhiều claim/feature; ghi thao tác lỗi và thời gian hoàn thành. Đường dẫn mở tài liệu gốc có thực sự truy cập được không.
8. Trên cùng bộ hồ sơ công khai, so sánh PatentLens với người dùng dùng AI phổ thông và người làm chuyên môn theo **cùng quyền truy cập dữ liệu**. Lưu log ngày, provider, phiên bản claims và báo cáo tra cứu làm đối chứng độc lập.

**Kết quả trình duyệt trong môi trường tạo v25:** chưa xác nhận. Chromium bị chính sách môi trường chặn mở cả file:// và localhost (`ERR_BLOCKED_BY_ADMINISTRATOR`), không phải lỗi đã được chứng minh của web sau deploy. Không nêu đã thử thành công UI desktop/mobile.

## C. Lấy số liệu nghiên cứu thật

Sử dụng `PILOT_EVALUATION.md`. Không điền tỷ lệ Feature đúng, Precision/Recall, số lần hallucination, thời gian tiết kiệm từ test giả lập. Lưu dữ liệu thô đã ẩn danh hoặc thuộc tài liệu công khai và nhận xét chuyên gia. So dữ liệu với báo cáo tra cứu có căn cứ về ngày và phiên bản claims; không dùng việc đã cấp bằng làm nhãn chuẩn.
