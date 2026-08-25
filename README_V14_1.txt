PATENTLENS v14.1 — METADATA FIX
================================

LỖI ĐÃ SỬA
----------
Bản v14 chỉ dò metadata ở trang 1 và chủ yếu theo:
- INID (11), (22), (51), (54), (57), (71), (73), (74)
- nhãn tiếng Anh Title / Filed / Applicant / Assignee...

Vì vậy nhiều PDF bằng sáng chế Việt Nam có text rõ nhưng các ô:
Số bằng, Tên sáng chế, Ngày nộp đơn, Chủ đơn, Đại diện, IPC, Tóm tắt
vẫn bị trống.

v14.1:
1. Dò tối đa 4 trang đầu, không chỉ page 1.
2. Hỗ trợ nhãn tiếng Việt:
   - Tên sáng chế
   - Số bằng / Số công bố / Số đơn
   - Ngày nộp đơn / Ngày ưu tiên
   - Chủ đơn / Người nộp đơn / Chủ bằng / Chủ sở hữu
   - Đại diện SHTT / Đại diện SHCN
   - Phân loại quốc tế / IPC / CPC
   - Tóm tắt / Tóm tắt sáng chế
3. Dò từng trang + gộp 4 trang đầu.
4. Nếu metadata còn thiếu, OCR các trang đầu rồi merge kết quả.
5. Không ghi đè metadata tốt bằng chuỗi rỗng.
6. Có nút "Dò lại thông tin từ PDF".
7. UI báo rõ đã nhận được bao nhiêu / 7 trường.

DEPLOY
------
Upload đè:
- worker.js
- package.json
- wrangler.jsonc

Commit main -> Cloudflare auto deploy.

TEST:
/api/health
phải thấy:
"version":"14.1.0"

Sau đó hard refresh, upload lại PDF từ đầu.
