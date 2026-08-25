PATENTLENS v14.3 — ASSESSMENT AUTO-FILL
========================================

LỖI BẢN CŨ
-----------
Bước 7 có select D1/D2/D3 nhưng 3 ô:
- Dấu hiệu khác biệt
- Vấn đề kỹ thuật khách quan
- Lập luận sơ bộ về tính hiển nhiên

là textarea trống hoàn toàn. Việc chọn D1 không trigger bất kỳ logic nào.

v14.3 SỬA:
-----------
1. Select "Đối chứng gần nhất" hiển thị:
   D1/D2/D3 + số công bố + tiêu đề (nếu lấy được).

2. Khi vào Bước 7:
   - hệ thống tự chọn D gần nhất dựa trên độ phủ ma trận;
   - tự điền Dấu hiệu khác biệt;
   - tự xây dựng Vấn đề kỹ thuật khách quan sơ bộ;
   - tự phân tích D2/D3 có gợi ý các khác biệt đó hay không.

3. Khi đổi D1 -> D2 -> D3:
   toàn bộ 3 ô cập nhật theo tài liệu vừa chọn.

4. Dấu hiệu khác biệt lấy trực tiếp từ matrix:
   - Có -> không xem là khác biệt
   - Một phần -> khác biệt một phần
   - Chưa chắc chắn / Không tìm thấy / Chưa có dữ liệu -> nêu rõ

5. Lập luận hiển nhiên:
   kiểm tra từng feature khác biệt của closest prior với hai D còn lại.
   Không tự kết luận "hiển nhiên" chỉ vì feature nằm rải rác trong nhiều patent.
   Vẫn yêu cầu chuyên gia đánh giá động cơ kết hợp.

6. Có nút:
   ↻ Điền lại từ D1–D3

7. Có summary card:
   số công bố, ngày, độ phủ Có/Một phần/Chưa rõ.

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
"version":"14.3.0"

Sau đó:
Bước 5 chọn D1-D3
→ Bước 6 Tạo ma trận
→ Bước 7

Bước 7 phải tự có nội dung ngay.
Đổi select D1/D2/D3 thì nội dung phải đổi theo.
