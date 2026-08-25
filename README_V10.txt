PATENTLENS v10.0 — TEXT LAYER + MATRIX FIX
===========================================

SỬA ĐÚNG 2 LỖI ĐANG GẶP

A. VĂN BẢN TIẾNG VIỆT BỊ HỎNG / QUERY RÁC
-----------------------------------------
v10 KHÔNG còn mặc định coi file đánh máy là OCR.

Pipeline mới:
1) PDF.js đọc text layer trực tiếp.
2) Chấm điểm chất lượng text từng trang.
3) Nếu text layer tốt -> giữ nguyên Unicode tiếng Việt.
4) Nếu text layer lỗi font/mã -> chỉ OCR đúng trang lỗi.
5) Không dùng bản left/right ghép đôi để lấy claims nếu text layer sạch.
6) Metadata/title chỉ đọc từ trang đầu, tránh footer/page counter chui vào title.
7) Xóa artifact kiểu:
   3976 1/12 3976 2/12 ...
8) Không tự nối dòng tùy tiện nữa.

Google Vision:
- DOCUMENT_TEXT_DETECTION
- v10 bỏ languageHints ép "vi,en"; để Vision tự detect.
  Google Cloud khuyến nghị auto-detect thường tốt hơn với Latin text.

B. BẢNG SO SÁNH TOÀN "KHÔNG TÌM THẤY"
--------------------------------------
v10 bỏ heuristic cũ:
  exact keyword hits -> Không tìm thấy

Thay bằng:
- Chưa có D1/D2/D3 -> "Chưa có dữ liệu"
- Có đoạn liên quan nhưng chưa đủ -> "Chưa chắc chắn"
- Có một phần -> "Một phần"
- Có evidence rõ -> "Có"
- Không kết luận "Không tìm thấy" chỉ vì khác ngôn ngữ.

Có thêm optional GenAI evidence mapping:
Cloudflare Secret:
GEMINI_API_KEY

Nếu có key:
- /api/matrix dùng Gemini để map từng feature với D1-D3
- evidence phải lấy từ text tài liệu
- expert vẫn là người review cuối.

Nếu KHÔNG có GEMINI_API_KEY:
- app vẫn chạy bằng local evidence fallback tốt hơn bản cũ.

DEPLOY
------
Upload đè 3 file:
- worker.js
- package.json
- wrangler.jsonc

Commit main -> Cloudflare auto deploy.

TEST VERSION
------------
Mở:
/api/health

Phải thấy:
"version":"10.0.0"

TEST PDF
--------
1) Hard refresh.
2) Upload lại file từ đầu.
3) Bước 1: status nên nói:
   - "Đọc trực tiếp text layer, giữ nguyên Unicode tiếng Việt"
   hoặc
   - "text layer kém; đã tự dùng OCR khi cần"
4) Kiểm tra Tên sáng chế + Claims trước khi sang bước 3.
5) Tạo lại feature/search.
6) Chọn D1-D3.
7) Tạo ma trận.

Nếu muốn bật Gemini:
Cloudflare -> Settings -> Variables and Secrets -> Add Secret
Name: GEMINI_API_KEY
Value: key Google AI Studio
