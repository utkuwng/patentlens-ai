# PatentLens v35 — nhận diện chủ đề & kho thuật ngữ ban đầu

Tất cả file ở **root GitHub**. Giữ `topic_lexicon.js` cạnh `index.html` và `app.js` (không tạo thư mục con). Deploy Worker bằng `npx wrangler@4 deploy` khi repo đã kết nối đúng Cloudflare.

## Bước đầu mới
- Chọn loại hồ sơ → tải PDF / dán đoạn bất kỳ, từ khóa hoặc claims. Bộ định tuyến **chạy local** khi đã đọc được chữ, hiển thị ba nhóm: Quy trình sản phẩm / Công nghệ thông tin / Hệ thống/thiết bị, nhiều nhóm nếu cùng khớp. Có kho VI/EN ban đầu do nhóm phát triển khởi tạo trong `topic_lexicon.js`, **không phải AI đã học từ dữ liệu thực tế**, không phải IPC/CPC đã kiểm chứng.
- Với từ khóa không có claims, vào thẳng Bước 4 chuẩn bị truy vấn chủ đề để khảo sát; không cho sang ma trận/nhận định tính mới khi không có claims. Có thể quay lại tải PDF có claims sau.
- Từ đồng nghĩa là các biến thể *gợi ý để tra cứu*, **không mặc định các giới hạn kỹ thuật tương đương**. Gợi ý thuộc từng concept được khớp với từ gốc; không ghép chuỗi n-gram vô nghĩa. Nếu không khớp kho hiện có, máy nói rõ chưa phân loại, không tự bịa.
- Với PDF dài, ưu tiên claim/title/abstract và lấy mẫu text layer để định tuyến; kiểm toán đọc PDF và bằng chứng ở các bước sau vẫn riêng. Chỉ đưa dữ liệu ra nguồn tìm kiếm khi người dùng đồng ý.

## Giới hạn
Kho từ ban đầu chưa được chuyên gia IP GROUP duyệt, chưa phải tập dữ liệu học có nhãn hay bằng chứng độ chính xác. Phân loại chủ đề không thay tách claim, chứng minh ngày, tra cứu toàn cầu, xác minh toàn văn/hình vẽ, hoặc kết luận nghiệp vụ. Những sửa đổi này chỉ là **giai đoạn 1 của lõi tra cứu**. Không đưa API key vào repo.

## Cách tự kiểm thử định tuyến trước khi gọi SerpApi
1. Chọn **Chuẩn bị đăng ký** → **Dán văn bản** → nhập `thuật toán học máy nhận dạng hình ảnh` → **Đọc và nhận diện chủ đề**. Máy đưa đến Bước 4, gợi ý **Công nghệ thông tin**, hiển thị thuật ngữ nguồn và biến thể; chưa có claims nên không được đánh giá tính mới.
2. Làm lại với `quy trình sấy khô và phối trộn chế phẩm` và `thiết bị cảm biến áp suất điều khiển máy bơm`. Kiểm tra nhóm tương ứng. Với trường hợp chứa cả `học máy` và `cảm biến`, giữ cả hai nhóm.
3. Thử `thành nhiều thân thích đường kính`: bộ từ điển phải nói **chưa tìm thấy chủ đề có căn cứ**, không sinh n-gram giả.
4. Với PDF có claims, máy tự nhận diện chủ đề khi có văn bản trích xuất; vào Bước 4 xem truy vấn riêng. Vẫn cần kiểm tra OCR, claims, D1–D3 và kết luận theo từng claim. Đừng coi chữ `Đã khớp từ điển` là đã tìm tài liệu đối chứng.

Muốn tăng khả năng "học", hãy xây dựng tập ví dụ có nhãn **đoạn nguồn → chủ đề/subtopic đúng → từ nguồn → biến thể đã được chuyên gia xác minh → link tài liệu nguồn**, tách tập train/dev/test. Bản này chưa thu thập tự động hoặc tự cập nhật từ điển từ internet, cũng chưa có số đo recall/precision.
