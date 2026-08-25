PATENTLENS v14.2 — METADATA UPLOAD HOTFIX
==========================================

ROOT CAUSE CỦA LỖI "KHÔNG ADD FILE ĐƯỢC"
----------------------------------------
v14.1 có dòng JavaScript:
  $("rescanMeta").onclick = ...

nhưng HTML lại KHÔNG có element id="rescanMeta".

Khi trang load, browser ném lỗi:
  Cannot set properties of null (setting 'onclick')

Script dừng ngay tại đó, nên các dòng phía sau như:
  pdfInput.onchange = ...
không bao giờ được đăng ký.

KẾT QUẢ:
- bấm chọn PDF không chạy;
- kéo thả PDF cũng có thể không chạy.

v14.2 đã sửa:
1. Thêm thật nút:
   ↻ Dò lại thông tin từ PDF
2. Thêm metaStatus.
3. Event rescanMeta có guard null.
4. pdfInput onchange có guard + try/catch.
5. drag/drop có guard + try/catch.
6. Thêm startup diagnostic nếu thiếu UI ID.
7. Giữ nguyên metadata parser v14.1 và prior-art v14.

DEPLOY
------
Upload đè:
- worker.js
- package.json
- wrangler.jsonc

Commit main -> Cloudflare auto deploy.

TEST
----
1. /api/health phải thấy:
   "version":"14.2.0"

2. Cmd + Shift + R.

3. Bấm "Choose File" -> chọn PDF.
   Ngay lập tức status phải đổi từ:
   "Chưa có file."
   sang:
   "Đang mở PDF..."

Nếu vẫn lỗi, mở DevTools > Console; v14.2 sẽ log lỗi cụ thể thay vì làm UI im luôn.
