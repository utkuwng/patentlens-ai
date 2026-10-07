# PatentLens AI v60 — v49 Stable Search + Deep Topic-Fit Retrieval

Bản này được dựng trực tiếp từ source v49 người dùng gửi. Tầng provider/search của v49 được giữ nguyên; thay đổi tập trung vào cách lập query và xếp hạng để giảm tài liệu lệch chủ đề.

## Thay đổi chính

- Không thay transport Google Patents/EPO/SerpApi/Browser Run của v49.
- Workers AI chỉ chuẩn hóa/dịch keyword; không còn tự ghép nhiều keyword thành query.
- Mỗi keyword kỹ thuật được tìm bằng một query riêng, không có dạng `"A" "B"`.
- Kết quả từ các query được gom theo publication number; tài liệu xuất hiện qua nhiều keyword có recurrence cao hơn.
- Toàn bộ candidate được rerank trên title/snippet trước khi chọn nhóm đọc sâu.
- Đọc sâu tối đa 15 patent + 2 NPL, sau đó tính lại **topic-fit đa-keyword** trên title + snippet + claims + description.
- Ranking cuối ưu tiên: multi-keyword coverage + anchor technical concept + số ý kỹ thuật cùng khớp + query recurrence. Semantic similarity chỉ là tie-breaker nhỏ.
- Paper/NPL vẫn hiển thị nhưng không được auto chọn làm D1–D3.
- Nếu chỉ 1–2 patent đủ tín hiệu, chỉ điền 1–2 ô; không ép đủ 3 bằng tài liệu yếu.

## Deploy

```bash
npx wrangler@4 deploy
```

`/api/health` trả `version: 60.0.0`.

## Lưu ý

Topic-fit là heuristic phục vụ prototype và cần được hiệu chỉnh bằng bộ test/nhãn chuyên gia. D1–D3 vẫn chỉ là shortlist ưu tiên đọc, không phải kết luận prior art hợp lệ hay tính mới.
