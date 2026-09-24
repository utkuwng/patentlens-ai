# PatentLens AI v41 — giảm lặp, giữ đánh giá theo từng claim

Triển khai: giải nén toàn bộ 8 file **nằm ngang hàng ở root repo**; deploy bằng cấu hình `wrangler.jsonc` từ đúng thư mục dự án (`npx wrangler@4 deploy`). Không chỉ dán `worker.js` vào Cloudflare Editor. Kiểm tra `/api/health` trả `41.0.0` và trang `/` trả HTML. Secrets lưu trên Cloudflare, không commit GitHub.

Sửa từ v40:
- Mỗi feature có **một ID gốc** trong ma trận/báo cáo, thêm `affectedClaims` và `claimFeatureIds` để claim phụ thuộc vẫn được đánh giá trên **toàn bộ** giới hạn kế thừa. Không xóa feature cha khỏi tính mới claim con.
- Parser chỉ thử tách claim OCR dính **khi gặp số claim liên tiếp và ngôn ngữ mở đầu giống claim** trong phần claims; đánh dấu `needsReview` để kiểm tra PDF gốc. Không tự khẳng định đã khôi phục đủ số claims khi OCR mất chữ/số hoặc cấu trúc đa nhánh.
- Báo cáo HTML không lặp thêm bảng feature×D1/D2/D3 sau bảng bằng chứng theo từng nguồn; hiển thị ID và các claims chịu ảnh hưởng. CSS xử lý xuống dòng cho văn bản OCR dài.

Giới hạn: Chưa kiểm thử PDF 59281 gốc; không thể cam kết sửa OCR/dấu tiếng Việt hay phát hiện mọi claim bị gộp. Đoạn trích nguyên văn và điểm khớp cụm từ không chứng minh ngữ nghĩa kỹ thuật, nguồn gốc, ngày pháp lý, tính mới hoặc trình độ sáng tạo. Cần xác minh từ bản gốc, đặc biệt khi cảnh báo `needsReview`. Chỉ tài liệu được phép xử lý.

Kiểm thử nhanh: PDF/tài liệu có claim 1→claim 2 phụ thuộc→claim 3 phụ thuộc; ma trận chỉ xuất mỗi feature cha một lần, trong khi phần nhận định riêng Claim 3 vẫn xét đủ feature từ claim 1,2,3. Tài liệu OCR có `8. ... 9. Hệ thống theo điểm 8 ...` cần tách 9 ra và đánh dấu cần kiểm tra. Kiểm tra `/api/health`, `/`, `/app.js`, `/style.css` sau khi deploy.
