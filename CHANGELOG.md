# PatentLens v24 — Giảm lựa chọn gây hiểu nhầm (so với v23)

| Vấn đề người dùng gặp phải | Thay đổi v24 | Cách kiểm tra / giới hạn |
|---|---|---|
| Màn đầu có lựa chọn “khảo sát công nghệ” hoặc “sản xuất/kinh doanh” nhưng website chưa có luồng xử lý tương ứng | Xóa cả hai khỏi màn bắt đầu; chỉ còn hai thẻ đúng phạm vi: hồ sơ mới và kiểm thử tài liệu công khai. Hai thẻ tự thiết lập mục đích/loại hồ sơ bên trong, không bắt chọn hai lần. | Test `v24 intake` kiểm tra DOM HTML; cần kiểm thử thao tác trên trình duyệt thật sau deploy. |
| Người dùng có thể tưởng đánh giá tính mới cũng là một câu trả lời FTO | Sau **khi đã tạo được báo cáo**, đưa hai tùy chọn này vào mục “Gợi ý công việc tiếp theo”: khảo sát công nghệ / trao đổi chuyên gia về FTO, kèm lời giải thích không tự động thực hiện. | Test HTML xác nhận phần này ẩn lúc bắt đầu và mã chỉ mở sau khi tạo báo cáo thành công; không phải module FTO/landscape. |
| Menu “4 dạng khác biệt” dễ bị hiểu là bốn cấp tính mới pháp lý | Bỏ biểu mẫu phân loại khỏi bước 7 và nội dung liên quan khỏi báo cáo mới; kết quả vẫn dựa trên claims, prior art và xác nhận chuyên gia. | Không có bộ phân loại đó ở màn đánh giá hoặc báo cáo mới. |

**Phạm vi cập nhật:** v24 là thay đổi cách chọn nhánh và vị trí gợi ý HCI; giữ nguyên các giới hạn nghiệp vụ, độ phủ dữ liệu, kiểm chứng trích dẫn và bảo mật đã công khai trong v23. Các bài test vẫn chủ yếu dùng phản hồi giả lập, chưa chứng minh kết quả đánh giá tính mới thực tế.

---

# PatentLens v23 — Thay đổi theo rủi ro nghiệp vụ (so với v22)

| Vấn đề trong thực tế tra cứu sáng chế | Thay đổi đã có trong source | Kiểm tra có thể lặp lại | Giới hạn vẫn còn |
|---|---|---|---|
| Trích dẫn AI bịa hoặc tự ghép chữ | `literalEvidenceCheck` chấp nhận 16–2.000 ký tự; một feature có thể chứa 1–5 đoạn trích; **mỗi đoạn** phải có nguyên văn trong nội dung được chuyển tới backend, nếu một đoạn sai thì hạ gợi ý xuống “Chưa chắc chắn”. | `test_v23.mjs` có ca hai đoạn có thật và ca một đoạn thật + một đoạn giả. | Khớp chữ **không** chống ảo giác tuyệt đối; văn bản gửi lên có thể bị sai nguồn, lệch ngữ cảnh, dịch sai hay cắt ngắn. Không suy ra `evidence_verified=true`. |
| Người dùng không thấy điều kiện thời gian còn bỏ ngỏ | Thẻ cảnh báo vàng ở bước 7 và dòng chờ xác minh trong báo cáo khi tài liệu thiếu ngày hoặc công bố vào/sau mốc cần xét. | Test HTML có thẻ và hàm hiển thị; cần kiểm tra bằng trình duyệt trên case có ngày. | Không tự phân xử trường hợp đơn nộp trước/công bố sau hoặc ngoại lệ bộc lộ; chuyên gia quyết định theo pháp luật áp dụng. |
| Nguồn tìm kiếm lỗi bị hiểu nhầm thành “không có tài liệu” | Đường API phân biệt `NO_RESULTS` với `SEARCH_FAILED`; UI có cảnh báo riêng khi có ứng viên nhưng còn lượt nguồn/truy vấn lỗi; nhật ký có `OK/ZERO/ERROR`. | Test backend mock tìm kiếm nhiều biến thể; cần test lỗi quota/timeout thật trên nguồn đã cấu hình. | Không đo được độ phủ toàn cầu, VN hoặc đa ngôn ngữ; cảnh báo không tự phục hồi API. |
| Ma trận dài, nhiều claim làm người dùng khó đọc | Bảng tổng hợp trong mục mở/đóng; cặp feature–đoạn gợi ý hai cột trên desktop, xếp dọc trên mobile; claim chưa chọn được thu gọn; giảm gradient/đổ bóng, nhãn pastel. | Test HTML tĩnh; cần kiểm thử người dùng, desktop/mobile thực tế. | Chưa đo SUS/SEQ, thời gian thao tác hay tỷ lệ hoàn thành; chưa có PDF full-text viewer hai cột. |
| Nguy cơ đánh đồng AI gợi ý với bằng chứng đã xác thực | Nhãn đối chiếu nói rõ “gợi ý chưa xác minh nguồn”, chỉ cho chuyên gia duyệt khi có nguyên văn, vị trí, và xác nhận. | Test API yêu cầu `evidence_verified=false`. | Checkboxes chuyên gia vẫn là tự xác nhận; chưa xác thực nội dung gốc độc lập ở backend. |

**Điều v23 KHÔNG tuyên bố:** Không khẳng định hoàn hảo, chống ảo giác tuyệt đối, đạt độ chính xác tra cứu sáng chế, giảm thời gian chuyên gia hoặc nguồn dữ liệu toàn cầu. Các phép thử hiện có chủ yếu là mock/smoke; muốn ghi các con số hiệu quả trong khóa luận phải chạy case study có đối chứng và chuyên gia chấm độc lập.

V22 đã bổ sung lựa chọn nhu cầu, cảnh báo FTO, giữ claim phụ thuộc, nhiều biến thể tìm kiếm và trạng thái “chưa đủ cơ sở”; xem `README.md` và `TEST_PLAN.md` để biết các giới hạn còn lại.
