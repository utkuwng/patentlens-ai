# PatentLens v22 — Pilot theo bằng chứng (mã nguồn, chưa triển khai lên domain của bạn)

**Mục đích:** hỗ trợ tra cứu và đối chiếu sơ bộ yêu cầu bảo hộ sáng chế; không thay thế chuyên gia, thẩm định chính thức, tư vấn FTO hoặc kết luận pháp lý. Những lựa chọn khảo sát thị trường / tự do khai thác chỉ giải thích rằng nằm ngoài phạm vi prototype; không dẫn tới một kết luận tính mới sai mục đích.

## Dùng thử

1. Giải nén ZIP. `index_review.html` là bản tham chiếu để xem giao diện; bản **đã nhúng y hệt vào `worker.js`**, vì vậy chỉ mở HTML cục bộ **không** chạy được backend API.
2. Cập nhật các tệp `worker.js`, `package.json`, `wrangler.jsonc` vào **đúng dự án Cloudflare Worker** của bạn; kiểm tra cấu hình trước khi deploy. Tại thư mục có 3 file trên: `npm install` rồi `npm run deploy` (cần đăng nhập Wrangler và quyền trên tài khoản Cloudflare).
3. Nếu cần mở web cho người khác thử, nên cấu hình Cloudflare Access hoặc WAF/rate-limit và ngân sách từ nhà cung cấp API. Có thể bật thêm **secret** `PUBLIC_API_ACCESS_CODE` (>=12 ký tự) để yêu cầu mã cho `/api/*` (trừ `/api/health`). Mã này là mã chung đơn giản, **không thay đăng nhập/rate-limit**; không công khai mã khi muốn hạn chế API. Người thử nhập vào ô “Mã API” trong web.
4. Các secret tùy chọn: `SERPAPI_KEY` (Google Patents qua SerpApi), `EPO_CONSUMER_KEY` + `EPO_CONSUMER_SECRET` (EPO OPS), `GEMINI_API_KEY` (AI hỗ trợ), `DEEP_SEARCH_ACCESS_CODE` (>=12 ký tự, bắt buộc cho AI/tìm sâu khi có Gemini), `GEMINI_MODEL` (mặc định `gemini-2.5-flash`), `GOOGLE_VISION_API_KEY` nếu dùng OCR Vision. Cấu hình qua Cloudflare Secrets/Variables, **không nhúng khóa vào HTML/source public**.
5. Xem `/api/health` để xác định phiên bản code v22, **không** dùng endpoint này để suy ra API key/provider đã được bật. Thử chức năng thực tế bằng tài liệu công khai và ghi nhật ký provider, truy vấn, lỗi.

## Những thay đổi chính

- Bước mở đầu hỏi mục đích trước; FTO và khảo sát công nghệ ngoài phạm vi bản đánh giá tính mới hiện tại. Giữ hai nhánh trong phạm vi: hồ sơ chuẩn bị đăng ký và hồi cứu tài liệu công khai. Chưa có claim chỉ khảo sát, **không được kết luận tính mới**.
- Xác nhận phiên bản claims/ngày tách thành giai đoạn: có thể nhập và xem bước đầu khi chưa xác nhận; trước khi đưa nhận định sơ bộ cần người có chuyên môn xác minh. Tách feature của claim phụ thuộc bao gồm nội dung claim cha, nhưng vẫn **là heuristic/regex, bắt buộc chuyên gia soát**.
- Tìm nhiều biến thể/nguồn (nếu cấu hình), tổng hợp theo mã công bố **chứ không giả danh gộp họ sáng chế**. Giữ A1/B2 riêng; ghi truy vấn/nguồn trả lời `OK`, `ZERO`, `ERROR`. Khi tìm được nhiều kết quả, vẫn **chưa chứng minh độ phủ toàn cầu**.
- Lấy thêm văn bản mô tả từ trang Google Patents khi trang trả nội dung phù hợp, phân biệt `snippet`, `abstract`, `claims`, `description_extract`, cờ cắt ngắn. **Không xác minh toàn văn, bản gốc, bản dịch, vị trí đoạn hay hình vẽ tự động**. WIPO/Espacenet/cơ sở dữ liệu Việt Nam là **link tra cứu thủ công**, không báo đã tìm tự động.
- Câu trích Gemini chỉ được kiểm tra khớp chữ với văn bản đã gửi, **không gắn nhãn nguồn đã xác minh**. Không có đủ toàn văn thì AI không được trả “Không tìm thấy” làm cơ sở khẳng định đặc điểm vắng mặt; nguồn, ngày, ngữ cảnh và ý nghĩa do chuyên gia kiểm tra. Mục review kiểm tra đoạn người dùng dán có xuất hiện trong văn bản đang lưu, yêu cầu ghi vị trí và xác nhận thủ công; điều này **chưa phải chứng thực server-side rằng bản gốc đúng**.
- Loại phần trăm so khớp khỏi thẻ đối chiếu người dùng; dùng nhãn “gợi ý đọc”, “chưa chắc chắn”, và hiển thị feature cạnh nguồn. Bỏ tự viết “vấn đề kỹ thuật khách quan” chứa giải pháp; để chuyên gia diễn đạt theo quy tắc pháp lý phù hợp.
- Khi “Bảo mật” bật, web chặn gọi Gemini tìm sâu; không tự dịch cả truy vấn bằng Google Translate phía backend. **Từ khóa gửi sang nhà cung cấp tìm kiếm bên ngoài vẫn có thể bộc lộ nội dung kỹ thuật** nếu chủ động bật tra cứu; chỉ dùng hồ sơ công khai hoặc được phép xử lý.

## Giới hạn bắt buộc nêu trong khóa luận

**Đây chưa phải phần mềm tra cứu sáng chế mọi quốc gia, mọi ngôn ngữ hoặc xác định tính mới chính xác.** Chưa có API chính thức cho dữ liệu VN, chưa có tự động WIPO PATENTSCOPE, chưa lấy hình vẽ và toàn văn đáng tin trên mọi nước, chưa xác minh họ sáng chế, ngày nộp/ưu tiên và dạng đơn nộp trước công bố sau theo chuẩn pháp lý; ngày cần xác nhận bởi chuyên gia. Chưa kiểm chứng được độ chính xác liên ngành/đa ngôn ngữ trên bộ mẫu, chưa có nền tảng FTO hoặc bộ máy tự động đánh giá trình độ sáng tạo theo luật Việt Nam. Nội dung trích dẫn có thể khớp văn bản do người dùng gửi nhưng không đúng tài liệu gốc; đánh giá vẫn cần người có chuyên môn.

**Vấn đề bảo mật và chi phí:** khóa API nằm server-side nhưng `/api/search` và `/api/detail` vẫn có nguy cơ lạm dụng nếu không cấu hình `PUBLIC_API_ACCESS_CODE`/Cloudflare Access + rate-limit. Mã chung không phải xác thực theo người dùng; chưa có log server riêng từng người hay kiểm toán an ninh. Cần thử và cấu hình lại trước khi đưa hồ sơ bí mật lên hệ thống hoặc public rộng rãi.

## Test

`node --test test_v22.mjs` để chạy bộ thử **mock** (không gọi API thật). Thử nghiệm đó kiểm tra phản hồi backend và guardrails cơ bản; không chứng minh website chạy trọn quy trình hoặc dữ liệu API thật. Xem `TEST_PLAN.md` và `CHANGELOG.md`.
