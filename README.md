# PatentLens AI v64 — Provider Fallback + User-Controlled D1–D3

Bản v63 phát triển trực tiếp từ v62/v49, tập trung vào hai vấn đề khi kiểm thử thực tế: Google Patents trả HTTP 503 từ Cloudflare và ứng viên “liên quan yếu” bị mất/không được đưa vào D1–D3.

## 1. Fix nguồn tra cứu khi Google Patents 503

Luồng no-key hiện thử theo thứ tự:

1. EPO OPS nếu đã cấu hình credentials;
2. SerpApi nếu đã cấu hình;
3. Cloudflare Browser Run (`content` rồi `scrape`);
4. DuckDuckGo site-search để tìm link `patents.google.com/patent/...`;
5. Google Patents direct và HTML chỉ là fallback cuối.

Khi một provider trả 429/503, worker mở circuit breaker trong 2 phút để không lặp cùng lỗi hàng chục lần. Nếu Browser Run/DuckDuckGo đã có patent, direct/HTML Google không bị gọi thêm cho query đó.

Với query tiếng Việt, nếu Workers AI binding khả dụng, backend tạo thêm **một bản dịch EN ngắn, trung thành với đúng cụm đầu vào** rồi thử EN trước. Keyword gốc VI vẫn được giữ; model không được thêm feature, IPC/CPC, mã patent hay synonym mới.

## 2. Không xóa ứng viên yếu sau vòng lọc

- Giữ tối đa 60 ứng viên trên màn hình.
- Ứng viên chưa đọc sâu vẫn hiển thị và được ghi rõ “Chưa đọc sâu; xếp tạm từ title/snippet”.
- Ba mức: `Ưu tiên`, `Cần kiểm tra thêm`, `Liên quan yếu`.
- Sau khi đọc/rank, hệ thống **tạm chọn 3 patent tốt nhất hiện có vào D1–D3 kể cả khi mức liên quan còn yếu**. Đây chỉ là lựa chọn để tiếp tục flow, không phải xác nhận prior art.
- Người dùng có thể thay/bỏ từng D.
- Nút **“Không ghi nhận D1–D3 & tiếp tục”** luôn xuất hiện sau khi search hoàn tất; nếu bấm, hệ thống xóa D1–D3 đã tạm chọn nhưng giữ nguyên danh sách ứng viên để tham khảo.

## 3. Demo

Giữ nguyên chế độ demo 59281 và bộ D1–D3 demo cục bộ để thầy/cô có thể đi hết flow ngay cả khi provider ngoài bị chặn.

## 4. Giới hạn

Google Patents no-key là best-effort và có thể chặn IP datacenter. v63 giảm phụ thuộc bằng Browser Run + DuckDuckGo fallback và circuit breaker, nhưng để chạy ổn định lâu dài vẫn nên cấu hình EPO OPS hoặc SerpApi ở server-side secrets.

D1–D3 tự chọn chỉ là **thứ tự ưu tiên/tạm chọn**, không phải kết luận tính mới hay tư cách tài liệu có trước.

## Deploy

```bash
npx wrangler@4 deploy
```

Kiểm tra `/api/health` phải trả `version: 63.0.0`.


## v64 - Fix nạp PDF demo

- Cho phép Worker phục vụ trực tiếp `demo_59281.pdf` và `demo_59281.txt`; v63 chặn hai asset này bởi allowlist nên nút demo nhận HTTP 404.
- Thay PDF demo bằng đúng hồ sơ 59281 gồm 19 trang.
- `Nạp hồ sơ demo` giờ thực sự tải PDF qua PDF.js, xác nhận số trang, đồng thời dùng companion text của cùng hồ sơ để chạy demo ổn định mà không phải OCR lại 18 trang scan.
- UI hiển thị số trang/dung lượng PDF đã nạp và trạng thái nguồn demo rõ ràng; các nút OCR được ẩn trong chế độ demo chuẩn bị sẵn.
