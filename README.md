# PatentLens AI v62 — Persistent Retrieval + Demo Walkthrough

Bản v62 giữ lõi provider/search của nhánh v49/v61 nhưng sửa trải nghiệm sau vòng lọc để kết quả không biến mất và không khóa flow khi chưa tìm được D1–D3 đủ mạnh.

## Thay đổi chính

- Giữ danh sách ứng viên sau đọc sâu theo 3 mức: `Ưu tiên`, `Cần kiểm tra thêm`, `Liên quan yếu`.
- Không xóa toàn bộ candidate chỉ vì không vượt ngưỡng D1–D3.
- D1–D3 tự chọn từ nhóm `Ưu tiên` trước, sau đó có thể dùng nhóm `Cần kiểm tra thêm` dưới trạng thái **Tạm chọn**.
- Người dùng luôn có thể chọn D1/D2/D3 thủ công từ shortlist.
- Nếu đã tra cứu nhưng chưa có D1–D3 đủ tin cậy, có nút **Ghi nhận chưa có D1–D3 & tiếp tục** để không làm flow chết; báo cáo sẽ ghi rõ giới hạn này.
- Search fingerprint local được neo thêm bằng **tên sáng chế đầy đủ** và **cụm đối tượng ở đầu Claim 1**, tránh phụ thuộc hoàn toàn vào các n-gram nhỏ.

## Demo 59281

Folder deploy chứa sẵn:

- `demo_59281.pdf` — PDF mẫu người dùng cung cấp.
- `demo_59281.txt` — phần text demo đã chuẩn bị từ chính hồ sơ để walkthrough ổn định, không phụ thuộc OCR tại thời điểm trình bày.

Bước 1 có nút **Nạp hồ sơ demo**. Khi dùng demo, Search Fingerprint được khóa vào các khái niệm kỹ thuật rõ ràng như:

- hố đốt lửa / fire pit
- đế hố đốt lửa / fire pit stand
- thành thân trong và thành thân ngoài / inner wall + outer wall
- luồng không khí đi lên / upward airflow
- lỗ hở hướng vào trong / inward-facing openings
- đốt cháy sơ cấp / primary combustion

Bước 3 có nút **Nạp D1–D3 demo** để giảng viên có thể đi hết flow ngay cả khi provider ngoài đang rate-limit. Bộ demo dùng 3 tài liệu tham khảo thật có ngày công bố trước ngày ưu tiên của hồ sơ mẫu:

- US20140238378A1 — Pellet burning fire pit
- US20160245529A1 — Portable collapsible biomass stove and lantern
- WO2018160767A1 — Fire pit apparatus

Các mục này chỉ là **demo reference set để kiểm thử luồng**. Không mặc định là kết luận prior art/tính mới và vẫn cần mở bản gốc, kiểm tra ngày, phiên bản và bằng chứng.

## Deploy

Các file để ở root repo. Deploy như trước:

```bash
npx wrangler@4 deploy
```

Kiểm tra `/api/health` phải trả `version: 62.0.0`.

## Kiểm thử đã chạy

Xem `TEST_RESULTS.txt`.
