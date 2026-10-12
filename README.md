# PatentLens AI v66 — Semantic Location UI Fix

Bản v66 kế thừa toàn bộ flow demo và D1–D3 của v65, đồng thời sửa cách hiển thị vị trí cho evidence semantic để tránh lộ offset ký tự kỹ thuật gây khó hiểu.

## Các lỗi đã sửa

### 1. Không còn rò trạng thái DEMO sang hồ sơ mới
Khi người dùng đã nạp demo rồi tải PDF mới hoặc dán văn bản mới, hệ thống reset toàn bộ dữ liệu phụ thuộc của hồ sơ cũ:
- candidate/search log/search outcome;
- D1–D3;
- evidence matrix / semantic hints;
- report preview;
- cờ demo và các nút demo.

Nhờ đó thông báo kiểu “Đã tạm chọn 3/3...” của hồ sơ demo không còn xuất hiện trên hồ sơ vừa nạp.

### 2. Trạng thái chọn D1–D3 nhìn thấy ngay trên candidate
Khi một candidate được chọn:
- nút đổi thành `✓ Đã chọn D1/D2/D3`;
- nút chuyển sang màu xanh;
- candidate có viền xanh và badge `Đang dùng: D1/D2/D3`;
- cùng một publication không bị giữ đồng thời ở hai slot; nếu chuyển sang slot khác, slot cũ được bỏ.

### 3. Khi chỉ có candidate liên quan yếu
PatentLens vẫn giữ tối đa 60 candidate trên màn hình.
Nếu không có ứng viên mạnh, hệ thống vẫn tạm chọn 3 patent đứng đầu để người dùng không bị dead-end, nhưng ghi rõ:
- `Liên quan yếu`;
- `Tạm chọn từ nhóm liên quan yếu`;
- lý do: chưa có ứng viên mạnh hơn;
- cần mở nguồn và kiểm tra trước khi giữ.

Người dùng luôn có thể chọn **Không ghi nhận D1–D3 & tiếp tục**.

## Demo 59281

Nút **Nạp hồ sơ demo hoàn chỉnh** dùng file `demo_59281.pdf` (19 trang) và text companion cùng hồ sơ.

Từ Bước 3, demo tự nạp bộ reference cục bộ để không phụ thuộc mạng/provider:
- D1: `US20180195732A1` — Smokeless fire pit — 2018-07-12;
- D2: `US20180045417A1` — Double wall fire pit — 2018-02-15;
- D3: `WO2010111728A1` — Portable campfire — 2010-10-07.

Các tài liệu được chọn vì gần chủ đề và đều có ngày công bố trước ngày ưu tiên 26/12/2018 của hồ sơ demo. Đây vẫn chỉ là bộ **minh họa workflow**, không thay thế xác minh prior-art/legal status của chuyên viên.

Ở Bước 4, demo nạp một số passage gần nghĩa đã chuẩn bị sẵn để minh họa luồng:
`retrieval → D1–D3 → evidence candidate → expert confirmation → report`.
Các passage này được gắn `demo-curated-passage` và UI cảnh báo rõ là dữ liệu trình diễn, không phải kết luận AI/pháp lý.

## Search online

Retrieval online của v63/v64 vẫn được giữ: provider fallback, giữ candidate yếu, cho phép người dùng tự chấp nhận/thay/bỏ D1–D3.
Demo cục bộ không chặn nút **Tìm tài liệu online**; nó chỉ là happy path ổn định khi trình diễn.

## Deploy

Đặt các file ở root repo và chạy:

```bash
npx wrangler@4 deploy
```

Không bỏ hai file:
- `demo_59281.pdf`
- `demo_59281.txt`

`/api/health` của Worker trả version `66.0.0`.


## v66 — sửa nhãn vị trí semantic

- Bỏ hoàn toàn nhãn `Khoảng ký tự ?–154` / offset ký tự khỏi giao diện và báo cáo.
- Với evidence semantic chưa được chuyên gia xác nhận vị trí, hiển thị: **“Đoạn gần nghĩa do hệ thống định vị · chưa xác minh vị trí trong bản gốc”**.
- Nếu chuyên gia nhập vị trí thật (`Claim`, đoạn `[xxxx]`, trang, hình), báo cáo tiếp tục ưu tiên vị trí chuyên gia đã xác nhận.
