# Biểu mẫu đánh giá thực nghiệm PatentLens — CHƯA CÓ KẾT QUẢ

Tài liệu này là **biểu mẫu chưa điền**, không phải báo cáo kiểm thử thực tế. Không dùng việc bằng sáng chế đã cấp làm nhãn “có tính mới”. Chọn case từ **đơn công bố công khai** và ghi rõ claim/bản công bố, ngày pháp lý đã được chuyên gia xem xét; tránh đưa target hoặc thông tin xuất hiện sau mốc vào dữ liệu hướng dẫn tìm kiếm.

## Thiết kế tối thiểu

- Case: chọn 5–10 hồ sơ công khai từ 2 lĩnh vực kỹ thuật, có một số claim phụ thuộc và thuật ngữ số/định lượng; ít nhất 2 case không dùng tiếng Anh nếu dữ liệu và người kiểm tra cho phép. Quy mô này chỉ là pilot, không chứng minh độ phủ toàn cầu.
- Phương án A: AI hỏi đáp phổ thông với tài liệu và thời hạn cố định. Phương án B: PatentLens v23. Phương án C: chuyên gia sử dụng quy trình hiện có nếu được cho phép. Ghi rõ nguồn dữ liệu và công cụ mỗi phương án được tiếp cận, số lần chạy, chi phí/giới hạn.
- Đáp án nền: danh sách đặc điểm và cặp đặc điểm–đoạn nguồn do chuyên gia xác nhận từ bản gốc; các tài liệu đối chứng đã biết trước từ báo cáo tra cứu có thể dùng làm mốc kiểm tra khả năng tìm lại, không coi báo cáo hay trạng thái cấp bằng là kết luận tự động.

## Nhật ký từng case (nhập số liệu đo được, không điền giả định)

| Mã case | Publication + claim/version | Ngôn ngữ | Mốc ngày & căn cứ | Nguồn được phép tìm | Thời gian bắt đầu/kết thúc | Người đánh giá | Trạng thái |
|---|---|---|---|---|---|---|---|
| CHƯA THỰC HIỆN | — | — | — | — | — | — | Chưa đo |

| Mã case/phương án | Feature đúng / tổng feature chuẩn | Feature bị bỏ sót (loại: số, tỷ lệ, quan hệ...) | Tài liệu nền tìm lại / tổng tài liệu nền | Câu trích đúng nguyên văn bản gốc / tổng câu trích | Câu trích sai nguồn/ngữ cảnh | Số gợi ý AI bị backend từ chối | Lỗi API/nguồn | Phút thao tác | Phút chuyên gia kiểm tra |
|---|---|---|---|---|---|---|---|---|---|
| CHƯA THỰC HIỆN | — | — | — | — | — | — | — | — | — |

**Cách diễn giải:** Tỷ lệ feature đúng cần định nghĩa quy tắc matching và người chấm trước khi chạy. “Bằng chứng AI bị chặn” chỉ đo được nếu lưu nhận định thô *trong môi trường thử có quyền truy cập*, đối chiếu với nhận định sau kiểm tra; không dùng số lần fallback làm số lần ảo giác nếu chưa xác định lỗi thật. Thời gian tiết kiệm = chênh lệch cùng tác vụ có kiểm soát; không kết luận tiết kiệm trước khi đo.

## Ghi chú sau mỗi ca

Ghi mã nguồn/phiên bản đang deploy, ngày chạy, danh sách query/provider thực tế, URL tài liệu gốc và vị trí đoạn, lý do chuyên gia sửa đánh giá, giới hạn ngôn ngữ và điều khoản chia sẻ hồ sơ. Nếu tài liệu chưa công bố hoặc bảo mật thì không đưa vào bản demo public và không gửi AI bên ngoài khi chưa có sự cho phép phù hợp.
