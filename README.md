
## v50 — Sửa retrieval bị lệch chủ đề

- Keyword gốc do extractor lấy từ tài liệu là **nguồn truy vấn chính**.
- Không còn dùng các query do LLM tự ghép 2–3 keyword thành cụm mới ở flow tra cứu.
- Mỗi keyword được tìm **riêng, nguyên cụm**; VI/EN chỉ là bản dịch tương ứng của chính keyword đó.
- Backend có `mode=keyword_exact`, không tự cắt query còn 2–4 từ hoặc nới thành từ chung.
- Xếp hạng D1–D3 ưu tiên keyword coverage và direct-query match; semantic chỉ hỗ trợ.
- Có relevance gate: nếu ứng viên không đạt tín hiệu tối thiểu, hệ thống không tự lấp D1–D3 bằng tài liệu yếu/lạc chủ đề.

# PatentLens AI v50 — Direct Keyword Retrieval + Explainable Hybrid Evidence

Bản v49 tập trung vào phần quan trọng nhất của prototype: **giải thích được vì sao keyword được chọn, vì sao D1–D3 được ưu tiên và vì sao một đoạn được xem là ứng viên bằng chứng**.

## Flow

PDF / văn bản
→ đọc text layer + OCR `vie+eng`
→ trích keyword từ chính hồ sơ
→ tự định tuyến 1 trong 3 trụ cột
→ chuẩn hóa VI/EN
→ tìm patent + paper/NPL online
→ xếp hạng hybrid: keyword coverage + query recurrence + semantic similarity
→ chọn D1–D3
→ đối chiếu 3 lớp: literal match → semantic retrieval → expert confirmation
→ báo cáo hỗ trợ rà soát.

## 1. Keyword có thể giải trình

Keyword vẫn được trích từ tài liệu hiện tại, không dùng kho keyword kỹ thuật theo ngành. UI hiển thị:
- cụm từ;
- nơi xuất hiện ưu tiên (`Title`, `Abstract`, `Claims`, `Description`);
- số lần xuất hiện;
- điểm trích xuất.

Title / Abstract / Claims được ưu tiên trọng số cao hơn phần mô tả chung.

## 2. Trụ cột

Ba nhãn làm việc:
- Quy trình sản phẩm;
- Công nghệ thông tin;
- Hệ thống/thiết bị.

Đây là **routing phục vụ tra cứu**, không phải phân loại IPC/CPC chính thức. Frontend có lựa chọn sơ bộ tức thời; `/api/route-plan` kiểm tra/làm giàu bằng Workers AI nếu binding `AI` khả dụng. Người dùng luôn có thể override.

## 3. D1–D3: hybrid retrieval ranking

Ứng viên được xếp ưu tiên bằng ba tín hiệu:
1. keyword coverage giữa hồ sơ và tài liệu;
2. số truy vấn khác nhau đã tìm thấy tài liệu;
3. semantic similarity của hồ sơ keyword với title/snippet/nội dung đọc được.

Endpoint mới:
- `POST /api/semantic-rank`

Nếu Cloudflare Workers AI hoạt động, hệ thống dùng multilingual embedding `@cf/baai/bge-m3`. Nếu không, backend hạ xuống deterministic token-overlap fallback. Điểm này chỉ dùng **ưu tiên thứ tự đọc**, không phải novelty score.

## 4. Đối chiếu bằng chứng 3 lớp

### Lớp 1 — Literal / phrase match
Chỉ đánh dấu cụm thực sự tồn tại trong văn bản D1–D3 đã tải về. Trùng chữ không đồng nghĩa bộc lộ đầy đủ ý nghĩa kỹ thuật.

### Lớp 2 — Semantic retrieval
Người dùng có thể bật “So khớp ngữ nghĩa”. Hệ thống chia văn bản thành các passage và dùng embedding để tìm đoạn gần nghĩa với từng feature, kể cả khi khác cách diễn đạt.

Endpoint mới:
- `POST /api/semantic-evidence`

UI hiển thị:
- passage gần nghĩa nhất;
- semantic score;
- engine;
- semantic coverage theo từng D1/D2/D3.

Semantic score là độ gần vector/heuristic, **không phải xác suất feature đã được bộc lộ**.

### Lớp 3 — Expert confirmation
Chuyên viên xác nhận `Có / Một phần / Chưa chắc chắn / Chưa có dữ liệu`, kèm:
- quote nguyên văn;
- vị trí trong bản gốc;
- nhận xét.

Kết luận sơ bộ về claim chỉ được nâng mức khi có xác nhận chuyên gia và các kiểm tra nguồn/ngày cần thiết. “Không tìm thấy” không được chuyển thành “không tồn tại”.

## 5. Đối chiếu bằng chứng

Bản v49 sử dụng ba lớp kiểm soát: khớp cụm từ cục bộ, so khớp ngữ nghĩa bằng embedding khi người dùng cho phép, và xác nhận của chuyên viên trên tài liệu gốc. Tính năng “Gemini xác minh sâu” đã được loại khỏi giao diện và luồng sử dụng để tránh yêu cầu người dùng nhập mã truy cập hoặc gửi thêm nội dung nhạy cảm.

## 6. OCR

Giữ cơ chế v47:
- tự OCR các trang không có text layer;
- tách rõ trang đã đọc, trang ảnh/bản vẽ không có text tin cậy và trang chưa xử lý;
- không coi trang hình là lỗi OCR;
- cảnh báo nếu số claims nhận diện thấp hơn số claims ghi trên hồ sơ.

## 7. Deploy

Các file ở root repo:
- `index.html`
- `app.js`
- `style.css`
- `keyword_extractor.js`
- `worker.js`
- `wrangler.jsonc`

Deploy:

```bash
npx wrangler@4 deploy
```

Kiểm tra `/api/health`:
- `version: 48.0.0`
- `providers.workers_ai: true` nếu AI binding hoạt động.

## 8. Giới hạn cần ghi trong báo cáo

- Keyword extraction là heuristic có trọng số, chưa phải mô hình NER/KeyBERT benchmarked.
- Pillar routing là nhóm làm việc nội bộ, không thay thế IPC/CPC.
- Retrieval ranking chỉ ưu tiên tài liệu cần đọc; D1–D3 không mặc định là prior art hợp lệ.
- Embedding similarity không chứng minh disclosure.
- Literal quote verification chỉ chứng minh quote tồn tại trong text đã lấy về, không chứng thực bản gốc/ngữ cảnh.
- Tính mới và trình độ sáng tạo cuối cùng vẫn cần chuyên viên đánh giá.

## v49 – Hoàn thiện bước Báo cáo

- Thanh tiến độ 5 bước cập nhật theo bước hiện tại; không còn cố định thanh đầu tiên.
- “Tạo bản xem trước” chỉ tổng hợp nội dung trên màn hình và tự mở phần báo cáo đầy đủ.
- “Xuất PDF” mở bản in riêng; chọn **Save as PDF / Lưu dưới dạng PDF** trong hộp thoại trình duyệt.
- Giữ xuất HTML và CSV cho mục đích kiểm tra dữ liệu.
- Đã bỏ giao diện và client flow “Gemini xác minh sâu”.
