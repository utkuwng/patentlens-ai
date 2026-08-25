PATENTLENS v15.0 — STRICT LANGUAGE PRESERVATION
=================================================

LỖI ĐÃ SỬA
-----------
File English nhưng pipeline có thể:
- OCR lại dù PDF text layer đã sạch;
- cho vie/eng cạnh tranh trên cùng trang;
- áp Vietnamese cleanup vào mọi OCR candidate;
- phần Assessment luôn sinh câu tiếng Việt;
- prior-art detail backend luôn ép URL /en;
- tài liệu mixed có thể bị gộp các trang khác ngôn ngữ.

v15:
1. DIGITAL PDF = KHÔNG OCR LẠI
Nếu text layer sạch (quality >= 70 + language confidence):
- giữ nguyên source text;
- bỏ qua Vision/Tesseract cho trang đó.

2. LANGUAGE MODE CÓ THỂ KHÓA
UI mới:
- Auto
- Tiếng Việt — chỉ vie
- English — eng only
- Mixed — tách theo từng trang

3. TESSERACT KHÔNG CÒN vie+eng MODEL CHO TRANG MONOLINGUAL
- vi page -> vie
- en page -> eng
- unknown mixed page -> chạy vie và eng RIÊNG rồi chọn;
không merge model.

4. VIETNAMESE CLEANUP CHỈ ÁP DỤNG CHO VIETNAMESE
English text tuyệt đối không chạy:
repairCertainVnOcr(...)

5. LOW-SANITY OCR BỊ LOẠI
English OCR có token soup / ALL CAPS / ký tự rác sẽ bị hạ điểm.
Không feed claim OCR bét nhè vào Feature extraction nữa.

6. MIXED DOCUMENT
- detect theo từng page;
- claim pages khác ngôn ngữ không bị nối chung;
- evidence được tag [VI] / [EN];
- assessment tách [VI] và [EN].

7. ASSESSMENT GIỮ NGÔN NGỮ HỒ SƠ
- English application -> Objective technical problem + obviousness reasoning bằng English.
- Vietnamese -> tiếng Việt.
- Mixed -> 2 block [VI] / [EN].
Không dịch chéo.

8. PRIOR-ART DETAIL KHÔNG ÉP /en
Backend nhận ?lang= từ candidate/source.
Không gọi Google Translation cho nội dung patent.
Translation trong hệ thống chỉ còn dùng để tạo SEARCH QUERY, không thay đổi evidence.

DEPLOY
------
Upload đè:
- worker.js
- package.json
- wrangler.jsonc

Commit main -> Cloudflare.

TEST:
/api/health
phải thấy:
"version":"15.0.0"

TEST ENGLISH PDF:
1. Chọn Language = English — eng only (hoặc Auto nếu detect đúng).
2. Upload PDF.
3. Status phải báo giữ PDF text layer nếu file digital.
4. Claims phải English.
5. Bước 7 phải sinh English narrative.

TEST VIETNAMESE PDF:
Language = Tiếng Việt — chỉ OCR vie.
Bước 7 sinh tiếng Việt.

TEST MIXED:
Language = Mixed.
Evidence / differences sẽ có block [VI] và [EN].
