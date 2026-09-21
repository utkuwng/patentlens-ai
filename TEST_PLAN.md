# Test plan v21 – staging + cases công khai

1. Không có DEEP_SEARCH_ACCESS_CODE hoặc GEMINI_API_KEY: /api/health báo cờ disabled, POST /api/ai-queries không gọi Gemini và báo 503.
2. Có code nhưng sai: POST /api/ai-queries và /api/scholarly trả 403.
3. Đúng code + có key: /api/ai-queries tối đa 8 queries, không mã/URL patent tự bịa; nếu model lỗi hiển thị lỗi, không tạo chứng cứ giả.
4. Bấm mỗi gợi ý: /api/deep-patents thực sự chạy, EPO OPS được thử song song nếu có credentials; audit ghi provider, kết quả trùng target bị loại, không tự đánh dấu expert confirmed.
5. Tìm bài báo: Crossref chỉ trả metadata + DOI, không tự đưa vào matrix hoặc xác nhận tính mới.
6. /api/matrix: evidence AI bịa/không có nguyên văn trong text → downgrade Chưa chắc chắn và evidence rỗng; trích dẫn có thật → giữ status máy đề xuất nhưng expert vẫn duyệt.
7. Chọn mô hình kinh doanh / địa phương hóa: mục phân loại chỉ giải thích giới hạn, không sửa noveltyRisk; report ghi rõ tự khai báo.
8. PDF scan/English/Vietnamese, hồ sơ chưa có claim, B2 as-granted, lỗi provider, mobile, export/import JSON: chạy lại regression từ TEST_PLAN v20.2.
9. Benchmark ít nhất 5 case công khai: chuyên gia đánh giá nguồn trích, feature đúng sai, các điều kiện thiếu, thời gian thao tác, top-k recall trong tập đối chứng đã biết; KHÔNG suy rộng toàn cầu.
