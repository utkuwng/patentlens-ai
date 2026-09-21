# PatentLens v24 — Tra cứu và đối chiếu sáng chế (mã nguồn, chưa deploy lên domain của bạn)

**Mục đích:** hỗ trợ tra cứu và đối chiếu sơ bộ yêu cầu bảo hộ sáng chế; không thay thế chuyên gia, thẩm định chính thức, tư vấn FTO hoặc kết luận pháp lý. Bước đầu **chỉ có hai lựa chọn thực sự được hỗ trợ**: (1) hồ sơ đang chuẩn bị đăng ký và (2) kiểm thử từ tài liệu công khai. Phần khảo sát công nghệ/FTO không xuất hiện ở đầu vào hoặc trong lựa chọn kết luận: chúng chỉ là **gợi ý công việc tiếp theo** (không có nút chạy chức năng tự động) sau khi báo cáo được tạo thành công.

## Dùng thử

1. Giải nén ZIP. `index_review.html` là bản tham chiếu để xem giao diện; bản **đã nhúng y hệt vào `worker.js`**, vì vậy chỉ mở HTML cục bộ **không** chạy được backend API.
2. Cập nhật các tệp `worker.js`, `package.json`, `wrangler.jsonc` vào **đúng dự án Cloudflare Worker** của bạn; kiểm tra cấu hình trước khi deploy. Tại thư mục có 3 file trên: `npm install` rồi `npm run deploy` (cần đăng nhập Wrangler và quyền trên tài khoản Cloudflare).
3. Nếu cần mở web cho người khác thử, nên cấu hình Cloudflare Access hoặc WAF/rate-limit và ngân sách từ nhà cung cấp API. Có thể bật thêm **secret** `PUBLIC_API_ACCESS_CODE` (>=12 ký tự) để yêu cầu mã cho `/api/*` (trừ `/api/health`). Mã này là mã chung đơn giản, **không thay đăng nhập/rate-limit**; không công khai mã khi muốn hạn chế API. Người thử nhập vào ô “Mã API” trong web.
4. Các secret tùy chọn: `SERPAPI_KEY` (Google Patents qua SerpApi), `EPO_CONSUMER_KEY` + `EPO_CONSUMER_SECRET` (EPO OPS), `GEMINI_API_KEY` (AI hỗ trợ), `DEEP_SEARCH_ACCESS_CODE` (>=12 ký tự, bắt buộc cho AI/tìm sâu khi có Gemini), `GEMINI_MODEL` (mặc định `gemini-2.5-flash`), `GOOGLE_VISION_API_KEY` nếu dùng OCR Vision. Cấu hình qua Cloudflare Secrets/Variables, **không nhúng khóa vào HTML/source public**.
5. Xem `/api/health` để xác định phiên bản code v24, **không** dùng endpoint này để suy ra API key/provider đã được bật. Thử chức năng thực tế bằng tài liệu công khai và ghi nhật ký provider, truy vấn, lỗi.

## Thay đổi riêng của v24 so với v23

- **Bước đầu:** bỏ hai lựa chọn chưa thực hiện được (khảo sát công nghệ và kiểm tra trước sản xuất/kinh doanh); thay dropdown mục đích và lựa chọn nguồn trùng nhau bằng **hai thẻ chọn đầu vào rõ ràng**. Việc chọn thẻ đồng bộ chế độ nghiệp vụ bên trong, không đổi hai luồng tra cứu đã có.
- **Bước cuối:** chỉ **sau khi tạo báo cáo đạt cổng đầu vào**, hiện hai thẻ có thể mở/thu gọn: “Khảo sát công nghệ” và “Chuẩn bị sản xuất/kinh doanh (FTO)”. Các thẻ giải thích yêu cầu dữ liệu và hướng trao đổi chuyên gia, **không chạy tìm kiếm mới, không suy diễn từ đánh giá tính mới thành FTO**. Trước khi tạo báo cáo, phần này bị ẩn.
- **Bước đánh giá:** bỏ form phân loại “4 kiểu mới” vì không phải tiêu chuẩn đánh giá tính mới pháp lý hoặc chức năng độc lập đã hoàn thành. Không xóa các bước xác minh claim, nguồn, ngày hoặc kiểm soát bằng chứng.
- **Tương thích dữ liệu:** vẫn nhập được case JSON của các phiên bản cũ trong nhánh hồ sơ/kiểm thử; các lựa chọn ngoài phạm vi ở bản cũ không được dùng làm đầu vào tự động trong v24. Trường phân loại đổi mới đã bỏ khỏi bản case JSON xuất mới.
- **Kiểm thử:** `node --test test_v24.mjs` có kiểm tra hai lựa chọn đầu vào và gợi ý xuất hiện sau báo cáo, bên cạnh bài thử backend mô phỏng của v23. Chưa có kiểm thử full UI thực tế hoặc API provider thật.

## Nền tảng v23 được giữ nguyên (v23 so với v22)

- **Bước 6:** giao diện tối giản nền xám/trắng, viền mỏng, ít đổ bóng/gradient; danh sách Claim dạng mở/đóng, Claim đang chọn mở sẵn; khu vực đối chiếu dạng hai cột trên desktop và một cột trên màn hình nhỏ; bảng tổng hợp giữ tiêu đề và cột đặc điểm khi cuộn. Màu trạng thái là chỉ dẫn thao tác, **không phải điểm tin cậy pháp lý**.
- **Bằng chứng AI:** chấp nhận 1 đoạn trích dài tối đa 2.000 ký tự hoặc tối đa 5 đoạn trích ngắn; **kiểm tra riêng từng đoạn** có khớp chữ trong văn bản client gửi. `literal_text_match=true` và `evidence_verified=false` là hai trạng thái khác nhau. Chưa có kiểm chứng độc lập server-side tài liệu gốc và ý nghĩa kỹ thuật.
- **Bước 7:** hiện cảnh báo vàng riêng khi D1–D3 thiếu ngày hoặc công bố vào/sau mốc. Đề nghị chuyên gia xem ngày nộp/ưu tiên, quan hệ đơn và pháp luật áp dụng; **không tự kết luận tài liệu đó có đủ điều kiện làm đối chứng hay không**. Báo cáo ghi danh sách ứng viên đang chờ xác minh ngày.
- **Tìm kiếm:** phân biệt API trả `NO_RESULTS` với `SEARCH_FAILED`, giữ nhật ký nguồn và thông báo nổi bật khi **một phần nguồn/truy vấn lỗi dù các nguồn khác vẫn tìm ra ứng viên**. Không suy ra tính mới từ 0 kết quả hoặc từ việc dịch vụ lỗi.
- **Kiểm thử:** `test_v24.mjs` chứa bài thử bằng mock, và `PILOT_EVALUATION.md` là biểu mẫu để người kiểm thử nhập kết quả **thật** từ các hồ sơ công khai; chưa có số liệu thực nghiệm nào được dựng sẵn.

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

`node --test test_v23.mjs` để chạy bộ thử **mock** (không gọi API thật). Thử nghiệm đó kiểm tra phản hồi backend và guardrails cơ bản; không chứng minh website chạy trọn quy trình hoặc dữ liệu API thật. Xem `TEST_PLAN.md` và `CHANGELOG.md`.
