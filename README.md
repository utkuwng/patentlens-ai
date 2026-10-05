# PatentLens AI v56 — Provider Transport Fix

v56 giữ nguyên hướng **technical fingerprint retrieval** của v55 nhưng sửa phần kết nối nguồn patent — nguyên nhân khiến giao diện báo cả Google Patents Browser Run, XHR và HTML đều lỗi.

## Sửa chính ở v56

1. **Sửa lỗi double-encoding ở Google Patents XHR.**
   - v55 encode từng query rồi encode cả `url=` lần nữa, có thể biến khoảng trắng thành `%2520` và làm query sai.
   - v56 chỉ encode inner query **một lần** đúng cấu trúc của Google Patents XHR.

2. **Thêm Google Patents CSV fallback** (`download=true`).
   - Nếu JSON XHR không dùng được, Worker thử tải kết quả CSV rồi parse publication number/title/date.

3. **Browser Run đổi sang content-first.**
   - Trước đây chỉ dùng `/scrape`; v56 thử `/content` trước, tự parse HTML render, rồi mới fallback sang `/scrape`.
   - Nhật ký trả lỗi chi tiết hơn (HTTP/challenge/no patent links) thay vì chỉ “Browser Run thất bại”.

4. **Provider cascade ưu tiên nguồn ổn định đã cấu hình.**
   - EPO OPS (official automated API) → SerpApi → Google XHR → Google CSV → Browser Run → Google HTML.
   - Google no-key vẫn chỉ là best-effort vì Google có thể chặn datacenter/bot traffic.

5. **Cải thiện EPO OPS query.**
   - Không còn ép toàn bộ fingerprint thành một exact phrase dài.
   - Tách thành các thuật ngữ kỹ thuật và dùng Boolean AND trong title/abstract để tăng khả năng tìm được tài liệu diễn đạt khác câu chữ.

## Cấu hình ổn định khuyến nghị

Không cần người dùng nhập key trên giao diện. Nếu muốn retrieval ổn định khi Google chặn Cloudflare egress, cấu hình **server-side secrets** một lần cho Worker.

### EPO OPS (khuyến nghị vì là nguồn patent chính thức)

Đăng ký app tại EPO Developer Portal rồi chạy tại thư mục dự án:

```bash
npx wrangler secret put EPO_CONSUMER_KEY
npx wrangler secret put EPO_CONSUMER_SECRET
npx wrangler deploy
```

Không gửi các secret này qua chat/GitHub và không đặt chúng trong `wrangler.jsonc`.

### SerpApi (tùy chọn)

```bash
npx wrangler secret put SERPAPI_KEY
npx wrangler deploy
```

## Retrieval flow

PDF/OCR → core keyword → technical fingerprint → VI/EN fingerprint queries → provider cascade → candidate pool → toàn bộ keyword chấm coverage/ranking → D1–D3 → evidence review.

AI/embedding chỉ hỗ trợ dịch và semantic ranking; không tự quyết định tính mới hay tư cách đối chứng.
