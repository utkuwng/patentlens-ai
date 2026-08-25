PATENTLENS v13.0 — PRIOR ART PRO
================================

SỬA TOÀN BỘ LUỒNG TÀI LIỆU ĐỐI CHỨNG + FONT/TEXT

1. Chuẩn hóa toàn bộ text prior-art về Unicode NFC.
2. Decode HTML entities + numeric entities.
3. Tự phát hiện/sửa mojibake UTF-8 phổ biến khi có thể.
4. Xóa zero-width / soft-hyphen / ký tự rác.
5. Google Patents detail không còn join newline giữa từng text chunk.
   Đây là một nguyên nhân làm câu/claim bị bể chữ.
6. D1-D3 hiển thị font Arial/Segoe UI cố định, ligature tắt, line-height rõ.
7. Có nút "Làm sạch nội dung D1–D3".
8. Candidate ranking dùng concept song ngữ thay vì so từ tiếng Việt trực tiếp với title tiếng Anh.
9. Auto D1-D3 bỏ ứng viên score quá thấp và tránh title trùng/biến thể cùng tài liệu.
10. Ma trận đối chứng dùng nhóm concept song ngữ + phrase/numeric/duration coverage.
    Không còn hard-code dragon/germination/cellulase/pectinase trong scoring.
11. Evidence hiển thị theo section [Claims]/[Abstract], độ phủ concept và publication no.
12. Nếu có GEMINI_API_KEY: AI đối chiếu semantic Việt ↔ Anh, nhưng evidence phải trích nguyên văn.

DEPLOY
------
Upload đè 3 file:
- worker.js
- package.json
- wrangler.jsonc

Commit main -> Cloudflare auto deploy.

TEST
----
/api/health phải thấy "version":"13.0.0"
Sau đó Cmd+Shift+R và test lại từ đầu.

Ở bước D1-D3:
- mỗi slot phải hiện ✓ Nội dung đã chuẩn hóa Unicode NFC nếu text sạch.
- nếu paste tài liệu thủ công, bấm "Làm sạch nội dung D1–D3".

Ở ma trận:
- cột evidence phải có D1/D2/D3 + publication number + [Claims]/[Abstract] + độ phủ concept.
- khác ngôn ngữ không được tự động coi là "Không tìm thấy".
