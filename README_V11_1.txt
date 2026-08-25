PATENTLENS v11.1 — VIETNAMESE OCR HARDENING
=============================================

Bản này sửa theo đúng 4 nguyên nhân kỹ thuật của OCR tiếng Việt:

1) LANGUAGE PACK
- Tesseract.js 5.1.1 load rõ ràng: ["vie","eng"]
- Không dùng eng mặc định.
- Explicit:
  workerPath = Tesseract.js 5.1.1
  corePath   = tesseract.js-core 5.1.1
  langPath   = https://tessdata.projectnaptha.com/4.0.0
- OCR sẽ kiểm tra vie.traineddata.gz + eng.traineddata.gz.
- Nếu vie pack tải lỗi, UI báo lỗi rõ, KHÔNG âm thầm fallback sang eng.

2) PDF FONT / ENCODING
- Text layer được chấm điểm.
- Nếu phát hiện mojibake/legacy encoding, text layer bị đánh điểm thấp.
- Trang claim sẽ so sánh:
  PDF text layer
  Google Vision (nếu có)
  Tesseract vie+eng PSM 3
  Tesseract vie+eng PSM 6
- Chọn bản có chất lượng tiếng Việt tốt nhất.

3) UNICODE
- Mọi output OCR đều normalize("NFC").
- Chỉ sửa các lỗi OCR gần như chắc chắn:
  tỉnh dầu / tính dầu -> tinh dầu
  dung địch -> dung dịch
  hồn hợp -> hỗn hợp
  nảymầm -> nảy mầm

4) TRAINEDDATA / CORS
- Trước khi tạo worker, browser probe:
  vie.traineddata.gz
  eng.traineddata.gz
- UI có dòng diagnostic:
  ✓ vie.traineddata
  ✓ eng.traineddata
- Nếu CDN / CORS / network fail, hiển thị lỗi cụ thể.

EXTRA FIX
---------
- Claim bị kéo sang HÌNH 1 / sơ đồ: tự cắt tại HÌNH / FIGURE.
- Retry OCR xóa cache OCR cũ, không dùng lại kết quả lỗi.

DEPLOY
------
Upload đè:
- worker.js
- package.json
- wrangler.jsonc

Commit main -> Cloudflare auto deploy.

TEST VERSION
------------
/api/health
phải thấy:
"version":"11.1.0"

TEST OCR
--------
1. Cmd + Shift + R.
2. Upload lại PDF từ đầu.
3. Vào bước Claims.
4. Bấm OCR lại nếu cần.
5. Dòng diagnostic phải có:
   ✓ vie.traineddata
   ✓ eng.traineddata

Nếu một pack fail, DevTools > Network sẽ thấy request:
.../vie.traineddata.gz
.../eng.traineddata.gz

Không commit API key nào vào GitHub.
