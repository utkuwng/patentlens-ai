# PatentLens AI v20.1 – Smooth UI

Giao diện tập trung vào hành động: chọn loại hồ sơ → chọn PDF hoặc dán văn bản → kiểm tra thông tin → tiếp tục qua 9 bước hiện có. Hướng dẫn dài được thu gọn, các trường nâng cao nằm trong mục mở rộng. Mã backend tìm tài liệu và logic đánh giá giữ từ v20; không tích hợp API dữ liệu mới trong bản này.

Triển khai: sử dụng worker.js, package.json và wrangler.jsonc ở thư mục gốc; index_review.html để xem mã giao diện, không cần deploy riêng vì đã nhúng trong worker.js. Sau deploy hard refresh, kiểm tra /api/health và chạy TEST_PLAN.md.

Bảo mật: chỉ thử dữ liệu công khai hoặc được phép xử lý; việc thu gọn cảnh báo không đồng nghĩa giảm giới hạn bảo mật. Từ khóa chỉ được gửi tới bên ngoài sau khi người dùng tick đồng ý trực tiếp ở màn hình Tìm tài liệu.

Tính năng: giữ nguyên core từ v20; làm mới giao diện, không hứa chức năng tra cứu đa nguồn đã hoàn thiện.
