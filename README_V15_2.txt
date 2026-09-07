PATENTLENS v15.2 — VISUAL COMPARE + D1/D2/D3 SELECTION STATE
================================================================

SỬA THEO YÊU CẦU GIAO DIỆN

1. NÚT D1 / D2 / D3 CÓ TRẠNG THÁI ĐÃ CHỌN
- D1: xanh dương
- D2: tím
- D3: cam
- Khi click, nút đổi màu NGAY và hiện dấu ✓.
- Tài liệu được chọn hiện badge:
  ✓ Đã chọn D1 / D2 / D3
- Card D1/D2/D3 phía dưới cũng có viền + badge màu tương ứng.
- Khi chọn tài liệu mới cho cùng slot, trạng thái nút được cập nhật.

2. BẢNG SO SÁNH TRỰC QUAN HƠN
Trước bảng có 3 summary card:
- D1 / D2 / D3 + số công bố
- Coverage %
- Progress bar
- Số feature: Có / Một phần / Chưa chắc / Không thấy

3. STATUS CELL KHÔNG CÒN CHỈ LÀ CHỮ
- ✓ Có: xanh
- ◐ Một phần: vàng
- ? Chưa chắc chắn: xám
- × Không thấy: đỏ
- — Chưa dữ liệu: xám nhạt

4. EVIDENCE GỌN HƠN
- Mỗi dòng chỉ hiện "Xem evidence / ghi chú"
- Click mới bung nội dung.
- Bảng không còn bị kéo ngang/dài vì evidence quá nhiều.

5. HEADER D1/D2/D3 HIỆN SỐ TÀI LIỆU
Ví dụ:
D1 · US1234567A1
D2 · WO2024...
D3 · EP...

6. FILTER
Có nút:
"Chỉ xem điểm khác biệt"
→ ẩn các feature mà cả D1/D2/D3 đều đã bộc lộ.
Bấm lại:
"Hiện tất cả feature"

DEPLOY
------
Upload đè:
- worker.js
- package.json
- wrangler.jsonc

Commit main -> Cloudflare auto deploy.

TEST
----
/api/health phải thấy:
"version":"15.2.0"

Sau đó hard refresh.

Test:
1. Bước 5: click D1 trên một patent
   -> nút D1 phải xanh + ✓
2. Click D2 trên patent khác
   -> D2 tím + ✓
3. Click D3
   -> D3 cam + ✓
4. Sang Bước 6
   -> tạo matrix
   -> thấy 3 summary cards + status boxes + evidence collapse.
