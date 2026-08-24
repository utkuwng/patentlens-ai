PATENTLENS AI — BẢN FLAT, KHÔNG CẦN FOLDER
================================================

Repo chỉ cần 3 file ở ngoài cùng:

patentlens-ai/
├── worker.js
├── wrangler.jsonc
└── package.json

Không có public/.
Không có src/.
Không có index.html riêng.

Giao diện HTML đã được đóng gói trực tiếp bên trong worker.js.
Worker cũng xử lý luôn backend /api/*.

Cách deploy:
1. Xóa các file/folder cũ trong repo.
2. Upload 3 file trên vào root repo.
3. Commit lên main.
4. Cloudflare:
   - Build command: None
   - Deploy command: npx wrangler deploy
   - Root directory: /
5. Retry build.

Test:
- https://<domain>.workers.dev/api/health
- https://<domain>.workers.dev/

Ưu điểm:
- Không còn lỗi assets directory quét node_modules.
- Không cần tạo public/src.
- Chỉ 3 file root.
