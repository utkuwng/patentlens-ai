# PatentLens AI v54 — Core Search Key Fix

## Vì sao có v54

Bản v53 đã cải thiện OCR và cụm từ, nhưng vẫn có thể đưa cả các câu mô tả quan hệ / drafting language vào search, ví dụ:

- `kẹp cài theo điểm 1`
- `đui cắm xác định hốc gắn`
- `gắn vào chi tiết ống`
- `vật dụng này có chi tiết ống`
- `hốc gắn kéo dài theo hướng chéo với ống`

Các cụm này quá chung hoặc là cả câu mô tả quan hệ, nên khi dùng trực tiếp làm query sẽ làm retrieval bị lệch.

## Logic mới

v54 tách rõ hai việc:

1. **Keyword extraction chỉ tạo CORE SEARCH KEYS** từ ý chính của hồ sơ.
2. **Search dùng toàn bộ CORE SEARCH KEYS** được hiển thị — không cắt top-N ở bước retrieval.

Thứ tự ưu tiên nguồn:

`Tên sáng chế → Yêu cầu bảo hộ độc lập → Tóm tắt → Yêu cầu bảo hộ phụ thuộc → Description (chỉ fallback)`

Bộ trích xuất loại/giảm mạnh:

- tham chiếu claim: `theo điểm 1`, `claim 2`;
- câu quan hệ: `xác định`, `còn có`, `gắn vào`, `gắn trong`, `kéo dài theo`, `để`, `nhằm`;
- cụm quá chung: `vật`, `vật dụng`, `liên kết`, `khoảng trống...` khi không có đủ nội dung kỹ thuật;
- các mảnh câu chỉ mang ý nghĩa vị trí/trạng thái.

Ví dụ với hồ sơ kẹp mái, mục tiêu đầu ra là các key kiểu:

- `kẹp cài`
- `cụm lắp ráp thanh vòm mái`
- `thanh vòm mái`
- `đui cắm`
- `hốc gắn`
- `hốc giữ`
- `tay đòn đàn hồi`
- `gờ định vị thẳng hàng`

thay vì đưa cả câu drafting vào truy vấn.

## Lưu ý

- v54 **không dùng một kho keyword chuyên ngành hard-code** để quyết định key.
- Bộ từ quan hệ/generic trong code chỉ dùng để nhận ra ngôn ngữ drafting cần loại, không phải dữ liệu lĩnh vực.
- Bản dịch VI/EN nếu có vẫn chỉ là bản dịch của chính CORE SEARCH KEY; không tự tạo query mới.
- Mọi key được Bước 2 hiển thị sẽ được chuyển sang Bước 3 để tìm kiếm.

## Deploy

```bash
npx wrangler@4 deploy
```

Kiểm tra `/api/health` phải thấy `version: 54.0.0`.
