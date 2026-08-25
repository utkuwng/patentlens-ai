PATENTLENS v12.1 — OCR CDN FIX
================================

FIX CHÍNH
---------
Đổi nguồn tải Tesseract traineddata:

CŨ:
https://tessdata.projectnaptha.com/4.0.0

MỚI:
https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0

Vì app dùng:
- vie.traineddata.gz
- eng.traineddata.gz

nên URL runtime sẽ tương ứng:
https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0/vie.traineddata.gz
https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0/eng.traineddata.gz

KHÔNG thay đổi logic v12:
- detect language
- Vietnamese -> vie
- English -> eng
- mixed/unknown -> adaptive comparison
- Unicode NFC
- text-layer-first
- diagram / HÌNH 1 cutoff
- prior-art search + matrix

DEPLOY
------
Upload đè 3 file:
- worker.js
- package.json
- wrangler.jsonc

Commit main -> Cloudflare auto deploy.

TEST
----
1) /api/health
Phải thấy:
"version":"12.1.0"

2) Cmd + Shift + R

3) Upload lại PDF từ đầu.

4) Khi OCR chạy, DevTools > Network có thể kiểm tra:
vie.traineddata.gz
eng.traineddata.gz

Host phải là:
cdn.jsdelivr.net

Không còn request tới tessdata.projectnaptha.com.
