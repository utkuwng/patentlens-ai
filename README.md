# PatentLens AI v53 — Keyword/OCR quality fix

## Mục tiêu của v53

Bản này sửa trực tiếp lỗi keyword bị cắt vụn và gắn sai ngôn ngữ, ví dụ các cụm kiểu `làm thích ứng dé`, `hai tay đòn đàn`, `[EN] nằm ngang`.

## Thay đổi chính

- Keyword extractor không còn sinh toàn bộ n-gram 2–5 từ rồi chọn điểm cao. Thay vào đó, hệ thống ưu tiên **cụm kỹ thuật hoàn chỉnh** theo ranh giới câu/claim và tách tại các cụm drafting như `bao gồm`, `được`, `để`, `wherein`, `configured to`...
- Giữ các thành phần kỹ thuật hữu ích như `cụm lắp ráp thanh vòm mái`, `tay đòn đàn hồi`, `hốc gắn`, `đui cắm`, thay vì các mảnh câu bị cắt.
- Các cụm quan hệ/generic như `nằm ngang`, `đầu xa kéo dài`, `làm thích ứng để` không được dùng như keyword độc lập nếu không có neo kỹ thuật.
- Sửa một số lỗi OCR chức năng có độ chắc chắn cao (`dé` → `để`) mà không nạp từ điển thuật ngữ kỹ thuật theo ngành.
- OCR chạy `vie+eng` theo hai pass khi pass đầu có confidence thấp: PSM 3, sau đó thử PSM 6 và chọn kết quả có chất lượng tốt hơn.
- Keyword xuất hiện chỉ trên trang OCR confidence thấp được gắn cảnh báo trong UI.
- Nhận diện ngôn ngữ keyword ngắn bám theo ngôn ngữ tài liệu; không còn gắn `[EN]` cho cụm tiếng Việt có dấu.
- Bản dịch EN/VI chỉ được đưa vào search/ranking nếu vượt kiểm tra ngôn ngữ cơ bản. Keyword gốc luôn được giữ.
- Workers AI/Gemini ở `/api/route-plan` chỉ phân loại trụ cột và dịch/chuẩn hóa keyword; **không còn tự tạo query mới**.
- Search vẫn dùng toàn bộ keyword đã được extractor chấp nhận. Auto-pick D1–D3 yêu cầu nhiều keyword đồng thuận, hoặc một cụm dài trùng rõ; một keyword ngắn/generic đơn lẻ không đủ để chọn D.

## Flow v53

PDF → text layer/OCR hai pass → clean text → trích cụm kỹ thuật hoàn chỉnh → phân loại trụ cột → dịch VI/EN nếu hợp lệ → search trực tiếp từng keyword → gom candidate → multi-keyword coherence gate → đọc sâu → semantic hỗ trợ → D1–D3 → đối chiếu bằng chứng.

## Giới hạn

- OCR vẫn có thể sai với scan mờ, font lạ hoặc bản vẽ; UI sẽ cảnh báo confidence thấp thay vì che lỗi.
- Keyword extraction là heuristic giải trình được, chưa phải NER/KeyBERT benchmarked.
- D1–D3 là tài liệu ưu tiên đọc, không phải kết luận prior art hay novelty.

## Deploy

```bash
npx wrangler@4 deploy
```

Kiểm tra `/api/health`: `version: 53.0.0`.
