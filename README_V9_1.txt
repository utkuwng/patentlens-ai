PATENTLENS v9.1 SEARCH FIX
==========================

Mục tiêu:
- Xác nhận chắc chắn version đang chạy.
- Không còn rơi xuống Google direct 503 khi SERPAPI_KEY đã có.
- Tự chuyển truy vấn tiếng Việt sang truy vấn tiếng Anh cho patent search.
- Thử 3 lớp SerpApi:
  1) engine=google_patents
  2) engine=google + tbm=pts
  3) Google web site:patents.google.com
- Built-in technical dictionary vẫn hoạt động nếu chưa bật Google Translation.

SAU DEPLOY:
Mở /api/health
PHẢI thấy:
"version":"9.1.0"

Nếu không thấy 9.1.0 => Cloudflare vẫn đang chạy deployment cũ.

GOOGLE TRANSLATION (TÙY CHỌN NHƯNG KHUYẾN NGHỊ):
Có thể dùng cùng Google Cloud API key nếu project đã bật Cloud Translation API.

Cloudflare Secret:
GOOGLE_TRANSLATE_API_KEY
hoặc GOOGLE_CLOUD_API_KEY

Nếu chưa có Translation API, built-in dictionary vẫn xử lý các cụm phổ biến,
bao gồm: thanh long → dragon fruit; nảy mầm → germination; hạt → seed.

TEST CASE HIỆN TẠI:
"DƯỠNG THANH LONG NẢYMẦM" + "hạt thanh long"
sẽ sinh biến thể tiếng Anh chứa:
dragon fruit seed germination

Đây là query có prior art thật, ví dụ CN106508173B trên Google Patents.
