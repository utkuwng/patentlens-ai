PATENTLENS v14.0 — DIVERSE PRIOR ART
=====================================

VẤN ĐỀ BẢN CŨ
-------------
Bản cũ gần như dùng 1 query/1 nhóm feature nên các patent trả về dễ cùng family,
cùng loại tài liệu, cùng hướng kỹ thuật. Kết quả nhìn "nhiều" nhưng thực chất
không đa dạng.

BẢN v14
-------
1. Search plan đa hướng (tối đa 12):
- Tên sáng chế
- Công dụng/chức năng
- Thành phần/nguyên liệu
- Quy trình/cách thực hiện
- Từng feature kỹ thuật khác nhau
- English technical concepts
- Query từ bước 4

2. Search mode:
- broad
- balanced
- precise

3. Dedupe:
- loại publication cùng patent family
- loại near-duplicate theo title/abstract/assignee

4. Diversity quota:
- vòng đầu tối đa 2 tài liệu mỗi search axis
- không để 10 tài liệu cùng một hướng chiếm top list

5. Search provenance:
Mỗi patent hiện:
Hướng tìm + query đã dùng

6. Auto D1-D3:
Ưu tiên lấy 3 tài liệu từ 3 hướng khác nhau nếu có thể.

GỢI Ý CHUYÊN MÔN
----------------
D1: gần nhất về cấu trúc/thành phần
D2: gần nhất về quy trình
D3: gần nhất về công dụng/chức năng

Như vậy matrix novelty/inventive step có chiều sâu hơn so với chọn 3 patent
cùng một kiểu.

DEPLOY
------
Upload đè:
- worker.js
- package.json
- wrangler.jsonc

Commit main -> Cloudflare auto deploy.

TEST:
/api/health
phải thấy:
"version":"14.0.0"
