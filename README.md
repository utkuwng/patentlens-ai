# PatentLens AI v61 — Grounded Search Fingerprint + Relevance-first D1–D3

Bản v61 tiếp tục dùng **tầng provider/search ổn định của v49** (Google Patents direct/HTML, SerpApi nếu có, Browser Run nếu cấu hình, EPO nếu có). Phần sửa tập trung vào đúng lỗi đang gặp: keyword/OCR sai ngôn ngữ, query rác và shortlist quá rộng.

## 1. Search Fingerprint thay cho việc đẩy toàn bộ n-gram sang search

Workers AI/Gemini (nếu có) chỉ được phép chọn **4–7 khái niệm kỹ thuật cốt lõi có `source_span` tồn tại nguyên văn trong hồ sơ**:

- `anchor`: đối tượng/giải pháp chính;
- `feature`: đặc điểm kỹ thuật phân biệt;
- `support`: tín hiệu phụ.

AI không được ghép A+B+C thành một query. Mỗi khái niệm được tìm **riêng từng dòng**.

Nếu AI không sẵn sàng, frontend dùng fallback bảo thủ: ưu tiên Title/Abstract/Claims, loại body OCR yếu và các cụm bị cắt/generic rõ ràng.

## 2. Sửa nhãn VI/EN và OCR rác

- Chuỗi có dấu tiếng Việt không được gắn `[EN]`.
- Không dùng `AUTO` cho search plan tự sinh khi đã xác định được ngôn ngữ.
- Các chuỗi OCR kiểu `csi whose seh cha wl`, `uộid fug xông iq om`, `wl wl evel tl tự` bị chặn trước search.
- Keyword thô vẫn có thể được hiển thị để giải trình, nhưng chỉ **Search Fingerprint** mới được phép đi sang bước tra cứu.

## 3. Search vẫn giữ provider v49

Các khối sau được giữ nguyên so với nền v60/v49:

- `googlePatentSearchDirect`
- `googlePatentSearchHtml`
- `patentSearch` provider orchestration
- `googlePatentDetail`

Tức là v61 không đổi transport đã từng tìm được tài liệu; chỉ thay cách tạo search plan và cách lọc/rank.

## 4. Lọc candidate trước khi chọn D1–D3

Kết quả thô không còn được trình bày như “tài liệu liên quan”. Hệ thống:

1. gom kết quả từ từng search concept;
2. pre-rank bằng Title/Snippet;
3. đọc sâu tối đa 20 patent;
4. tính `topic-fit` dựa trên **anchor + nhiều feature cùng khớp**;
5. dùng semantic similarity như tín hiệu phụ, không được tự cứu một tài liệu lệch chủ đề;
6. chỉ giữ tối đa 15 ứng viên sau lọc;
7. **tự chọn lại D1–D3 từ nhóm patent vượt ngưỡng**.

Nếu chỉ có 1–2 patent đủ tín hiệu thì chỉ điền D1 hoặc D1–D2; không lấp đủ 3 bằng tài liệu yếu.

## 5. Deploy

```bash
npx wrangler@4 deploy
```

`/api/health` trả `version: 61.0.0`.

## 6. Giới hạn

Search Fingerprint và topic-fit vẫn là heuristic/prototype và cần hiệu chỉnh trên bộ test có nhãn chuyên gia. D1–D3 là shortlist ưu tiên đọc, không phải kết luận pháp lý về prior art, tính mới hay trình độ sáng tạo.
