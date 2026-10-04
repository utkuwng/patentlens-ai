# PatentLens AI v42 — UI refresh — keyword động từ tài liệu + tra cứu online

## Thay đổi chính

Phiên bản v42 bỏ cơ chế định tuyến dựa trên kho keyword chuyên ngành cố định. Luồng mới:

1. Tải PDF hoặc dán nội dung.
2. Đọc lớp chữ; OCR các trang scan/chữ yếu khi cần.
3. Trích xuất keyword/cụm từ nổi bật trực tiếp từ chính tài liệu đầu vào bằng tần suất có trọng số và n-gram; chỉ dùng stopword ngôn ngữ/patent boilerplate chung, không dùng danh sách thuật ngữ chuyên ngành cố định.
4. Định tuyến hồ sơ vào đúng 1 trong 3 nhóm: **Quy trình sản phẩm / Công nghệ thông tin / Hệ thống-thiết bị**. Nếu `GEMINI_API_KEY` được cấu hình, Worker phân loại online chỉ từ danh sách keyword đã trích; nếu không, người dùng chọn thủ công.
5. Tạo truy vấn từ chính các keyword/cụm từ của tài liệu và tìm online qua các nguồn patent đã cấu hình.
6. Xếp hạng ứng viên theo mức độ trùng keyword với tiêu đề/snippet, sau đó đọc sâu tối đa 10 ứng viên và xếp D1-D3 theo phần văn bản thực sự lấy được.
7. Đối chiếu bằng chứng và tạo báo cáo như v41.

## Không còn dùng `topic_lexicon.js`

`topic_lexicon.js` của v41 không còn cần thiết. Nên xóa file cũ khỏi repo để tránh nhầm với cơ chế mới. `index.html` cũng không tải file này và Worker không public route này nữa.

## Các file cần deploy

Đặt cùng root repo:

- `index.html`
- `app.js`
- `style.css`
- `worker.js`
- `wrangler.jsonc`
- `README.md`

Deploy bằng:

```bash
npx wrangler@4 deploy
```

Kiểm tra `/api/health` phải trả version `42.0.0`.

## Secrets / cấu hình

- `GEMINI_API_KEY`: dùng cho định tuyến online 3 nhóm và các chức năng AI tùy chọn.
- `SERPAPI_KEY`: tùy chọn; nếu không có, Worker thử Google Patents direct.
- `EPO_CONSUMER_KEY` + `EPO_CONSUMER_SECRET`: tùy chọn để bổ sung EPO OPS.
- `PUBLIC_API_ACCESS_CODE`: khuyến nghị đặt khi site public để hạn chế lạm dụng API.
- `DEEP_SEARCH_ACCESS_CODE`: chỉ dùng cho các chức năng AI/search chuyên sâu đã có từ trước.

Không commit secrets lên GitHub.

## Lưu ý

Keyword động chỉ là tín hiệu truy hồi. Tần suất xuất hiện không chứng minh tầm quan trọng pháp lý của một dấu hiệu. Xếp hạng D1-D3 là thứ tự ưu tiên đọc dựa trên mức khớp văn bản, không phải kết luận về tính mới hoặc trình độ sáng tạo. Các đoạn highlight và nội dung OCR vẫn cần kiểm tra trên tài liệu gốc.


## UI refresh
- Giữ nguyên logic v42; làm mới giao diện theo phong cách research workspace: sidebar rõ tiến trình, panel phân cấp tốt hơn, upload/search/evidence/report tách lớp trực quan.
- Không thay đổi ID DOM quan trọng, API route hay luồng xử lý dữ liệu.
