PATENTLENS v15.3 — SELECTED BUTTONS

Fix chính:
- Nút D1/D2/D3 khi chọn đổi màu rất rõ
- Hiện chữ “Đã chọn D1/D2/D3” ngay trên nút
- Row của patent được chọn có highlight nhẹ
- Badge “Đã chọn D1/D2/D3” vẫn giữ nguyên

Deploy:
1. Upload đè 3 file: worker.js, package.json, wrangler.jsonc
2. Cloudflare tự build lại
3. Mở /api/health kiểm tra phải ra version 15.3.0
4. Hard refresh (Ctrl+Shift+R / Cmd+Shift+R)

Lưu ý: Nếu web vẫn hiện “v15.0 Language Preserve” ở sidebar thì nghĩa là bạn CHƯA deploy đúng file mới.
