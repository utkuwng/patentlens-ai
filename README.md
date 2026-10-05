# PatentLens AI v59 — Separate Core-Key Search

Bản này sửa trực tiếp lỗi truy vấn dạng `[VI] "A" "B"`: PatentLens không còn ghép nhiều keyword trong cùng một dòng tìm kiếm.

## Luồng tra cứu

PDF/OCR → Core Search Keys → **mỗi key một truy vấn riêng** → bản VI/EN của cùng key cũng là truy vấn riêng → provider discovery → gom candidate → ranking bằng toàn bộ keyword → D1–D3.

Ví dụ:

```text
[VI] hồ đốt lửa
[VI] cấp nhiên liệu cho sự đốt cháy sơ cấp
[VI] lỗ hở trên đế
[EN] fire pit
[EN] fuel supply for primary combustion
```

Không còn tạo:

```text
[VI] "hồ đốt lửa" "cấp nhiên liệu..."
```

Ngay cả khi người dùng dán một dòng legacy có nhiều cụm trong dấu ngoặc kép, frontend sẽ tự tách từng cụm thành các request riêng. Backend chạy `keyword_exact` cho từng key và vẫn có thể dịch VI → EN bằng Workers AI; sau khi lấy candidate, toàn bộ fingerprint của hồ sơ mới được dùng để lọc/rank.
