# PatentLens AI v55 — Technical Fingerprint Retrieval

Bản v55 sửa hai lỗi chính của v54:

1. **Keyword đúng nhưng search sai / quá rộng**: toàn bộ keyword vẫn được giữ làm *document fingerprint* để chấm độ liên quan, nhưng hệ thống không search từng từ/cụm chung riêng lẻ. Thay vào đó, hệ thống xác định **đối tượng chính (anchor)** và **đặc điểm kỹ thuật (features)**, sau đó tạo 2–6 truy vấn fingerprint như `object + feature 1 + feature 2` và `object + feature 1`. Đây là ghép có quy tắc từ chính key đã trích, không phải AI tự bịa query.
2. **Hàng chục lượt lỗi nguồn (ví dụ 48 lỗi)**: trước đây mỗi keyword có thể tạo 2 biến thể × nhiều provider. v55 dùng ít fingerprint hơn và **provider cascade**: thử một nguồn, nếu có kết quả thì dừng; nếu nguồn hạ tầng lỗi hai lần liên tiếp thì frontend dừng sớm thay vì bắn thêm hàng chục request.

## Retrieval flow v55

PDF/OCR → Title/Abstract/independent claim → technical fingerprint →
anchor + features → VI/EN faithful equivalents → 2–6 fingerprint queries →
Google Patents / configured provider → candidate pool → all-keyword coverage + semantic support → D1–D3.

Ví dụ hồ sơ về bình nóng lạnh có thể tạo fingerprint:

- `"electric water heater" "electric heating" "power control"`
- `"electric water heater" "power control"`
- bản VI tương ứng khi cần.

Các từ ngắn như `công suất`, `điều khiển`, `gia nhiệt` vẫn được dùng như **support signals** trong ranking nhưng không bị search độc lập.

## Search providers

- **Cloudflare Browser Run** (ưu tiên khi binding `BROWSER` hoạt động)
- Google Patents hidden XHR (best-effort, no key)
- Google Patents HTML fallback
- SerpApi nếu có `SERPAPI_KEY`
- EPO OPS nếu có credentials

`wrangler.jsonc` đã có `BROWSER` binding và `remote: true` để Quick Actions dùng được khi `wrangler dev` với remote binding. Khi deploy Worker, không cần Browser API token cho binding.

Google Patents no-key có thể rate-limit. Đây là vấn đề nguồn, không phải bằng chứng rằng query sai. Nhật ký truy vấn phân biệt `ZERO` (nguồn phản hồi 0 kết quả) và `ERROR` (nguồn bị chặn/lỗi).

## AI / semantic

Cloudflare Workers AI chỉ hỗ trợ dịch/chuẩn hóa song ngữ và semantic ranking/evidence. Kết quả D1–D3 vẫn được chọn bằng retrieval + fingerprint coverage; AI không kết luận tính mới.
