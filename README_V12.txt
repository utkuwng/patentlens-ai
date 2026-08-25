PATENTLENS v12.0 — LANGUAGE-AWARE OCR
=====================================

MỤC TIÊU
--------
Sửa triệt để case PDF patent Việt/Anh bị OCR lẫn ngôn ngữ và kéo chữ trong hình vẽ vào claim.

PIPELINE MỚI
------------
1. Đọc PDF text layer trước.
2. Chấm chất lượng text layer từng trang.
3. Phát hiện ngôn ngữ từng trang + toàn tài liệu:
   - vi
   - en
   - mixed
   - unknown
4. Nếu PDF đánh máy + text layer sạch:
   -> ưu tiên trực tiếp text layer, giữ nguyên Unicode NFC.
5. Nếu cần OCR:
   -> Google Vision DOCUMENT_TEXT_DETECTION auto-language (nếu có key)
   -> Tesseract adaptive:
      * tài liệu Việt: vie trước, vie+eng fallback
      * tài liệu Anh: eng trước, eng+vie fallback
      * không rõ/mixed: vie+eng, vie, eng
6. Tesseract dùng worker.reinitialize(...) để đổi ngôn ngữ theo trang.
7. Claims có hình ở nửa dưới:
   -> OCR thử full page + top 82% + top 72%
   -> ưu tiên bản có claim sạch, ít diagram noise.
8. Cắt claim tại marker linh hoạt:
   HÌNH 1 / HINH 1 / HÌN\nH1 / FIGURE 1
   và có thêm detector diagram-noise.
9. Normalize NFC sau OCR.
10. Diagnostic UI hiển thị:
   Ngôn ngữ tài liệu
   vie.traineddata
   eng.traineddata
   nguồn OCR được chọn.

KHÔNG CẦN THÊM API KEY MỚI
--------------------------
- Nếu đã có GOOGLE_VISION_API_KEY: Vision auto-detect ngôn ngữ.
- Nếu không có: Tesseract adaptive vẫn chạy.

DEPLOY
------
Upload đè 3 file:
- worker.js
- package.json
- wrangler.jsonc

Commit main -> Cloudflare auto deploy.

TEST
----
Mở:
/api/health

Phải thấy:
"version":"12.0.0"

Sau đó:
1. Cmd + Shift + R
2. Upload lại PDF từ đầu
3. Vào bước Claims
4. Kiểm tra diagnostic:
   "Ngôn ngữ tài liệu: Tiếng Việt"
   hoặc "English"
5. Nếu OCR chạy:
   ✓ vie.traineddata
   ✓ eng.traineddata

Case đang lỗi:
- claim phải dừng trước phần HÌNH 1
- không còn kéo các label 101, 102, 103... của sơ đồ vào claim
- không còn bắt buộc dùng vie+eng cho mọi trang.
