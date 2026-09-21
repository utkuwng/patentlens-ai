# Kế hoạch kiểm thử PatentLens v22

## A. Đã có thể chạy tự động (mock)

Dùng `node --test test_v22.mjs`. Các bài test chỉ dùng response mô phỏng của provider, **không chứng minh Cloudflare/Gemini/Google Patents thật hoạt động**.

## B. Cần kiểm thử sau khi deploy trên Cloudflare

1. **Mục đích:** mở trang trên desktop/mobile; chọn chuẩn bị đăng ký / công khai → nhập được. Chọn FTO hoặc khảo sát công nghệ → web giải thích ngoài phạm vi, không tự đưa kết luận mới/xâm phạm. Thử hồ sơ chỉ có mô tả chưa có claims → không ghi kết luận sơ bộ.
2. **Bảo mật:** bật chế độ bảo mật rồi bấm AI tìm sâu → không phát request `/api/ai-queries` hoặc `/api/matrix`. Tắt bảo mật trên **hồ sơ công khai** và cho phép gửi mới thử; kiểm tra truy vấn/URL và chi phí.
3. **Đầu vào:** claim phụ thuộc 1→2→3, có tỷ lệ, khoảng nhiệt độ, pH và quan hệ bước A trước B; so feature với bản PDF; chuyên gia phát hiện lỗi OCR/tách câu. Ngày và phiên bản chưa xác minh không buộc người dùng tick bừa để đọc bước đầu.
4. **Tìm:** kiểm tra các provider được cấu hình, truy vấn thành công/0 kết quả/lỗi/hết quota có nhãn riêng; so tài liệu tìm thấy theo các cách viết VI/EN/ZH/JP/DE đã chuẩn bị. **Không suy 0 kết quả là tính mới**; ghi nguồn không chạy. Google Patents direct là nguồn không chính thức, có thể bị chặn.
5. **Toàn văn:** tạo ca có feature chỉ nằm trong mô tả hoặc hình; khi chỉ có abstract/snippet/trích mô tả không đủ không cho kết luận “không tìm thấy”. Kiểm tra nguồn, trang/đoạn và ngày độc lập trên tài liệu gốc; A1 và B2 phải giữ hai bản riêng.
6. **Ngày:** có tài liệu công bố sau nhưng nộp trước: giữ là đối chứng **chờ chuyên gia kiểm tra ngày nộp/ưu tiên và luật áp dụng**, không tự kết luận đủ hay không đủ điều kiện.
7. **Ảo giác:** Gemini trả trích dẫn không tồn tại, câu đúng chữ nhưng phủ định, số nằm ngoài khoảng, prompt injection trong tài liệu; kết quả chưa chắc chắn và cần chuyên gia kiểm tra, không tự chấm “Có” khi chỉ khớp chuỗi.
8. **UX:** 5–8 người chưa biết nghiệp vụ thử chọn mục đích → nhập claim → so feature → tìm → mở D → duyệt → xuất; ghi tỷ lệ hoàn thành, số lỗi, thời gian, điểm khó hiểu và phản hồi chuyên gia.
9. **Bảo vệ public:** thử dùng API không có mã khi bật `PUBLIC_API_ACCESS_CODE`, giới hạn request Cloudflare WAF, ngân sách Gemini/SerpApi, chính sách hồ sơ mật; mã chung không thay quyền truy cập theo từng người.

## C. Đánh giá khoa học trước khi bảo vệ

Chọn bộ hồ sơ công khai, nhiều ngành và ngôn ngữ, xác định trước tài liệu đối chứng **độc lập với PatentLens** bởi chuyên gia. Tính recall@k, tỷ lệ quote đúng nguyên văn trong **bản gốc**, feature bỏ sót/nhầm quan hệ số liệu, thời gian/số lần thao tác và tỷ lệ chuyên gia bác bỏ. So cùng dữ liệu và thời lượng với AI phổ thông. **Không lấy việc đã cấp bằng làm nhãn tự động chứng minh tính mới/trình độ sáng tạo**. Công khai giới hạn quốc gia/ngôn ngữ/kho dữ liệu/nguồn đã chạy.
