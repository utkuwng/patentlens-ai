PATENTLENS v16.0 — PROFESSIONAL PILOT

Mục tiêu: chuyển prototype thành công cụ pilot có thể dùng trong quy trình chuyên gia, nhưng KHÔNG giả định là công cụ thẩm định pháp lý tự động.

Nâng cấp chính:
- Relevant date tách riêng filing date.
- Lọc prior art bằng PUBLICATION DATE; không dùng priority/filing date như ngày công khai.
- Confidential mode mặc định ON: tắt Cloud Vision/Gemini cho hồ sơ; search chỉ gửi search concepts.
- Search audit / coverage panel.
- Hỗ trợ manual NPL/other public disclosure trong D1-D3.
- Professional readiness gates.
- X/Y/A provisional categories theo logic WIPO, nhưng luôn gắn nhãn sơ bộ.
- Novelty: chỉ một tài liệu pre-date đơn lẻ map toàn bộ feature mới trở thành novelty-destroyer candidate.
- Inventive step: pair coverage chỉ là Y-candidate; cần Could-Would checklist, motivation và reasonable expectation of success.
- Closest prior art ưu tiên pre-date + coverage + similarity.
- Báo cáo có search audit, relevant date, categories, readiness, could-would.

DEPLOY
1. Upload đè worker.js, package.json, wrangler.jsonc
2. Commit main
3. /api/health phải thấy version 16.0.0
4. Hard refresh

LƯU Ý BẢO MẬT
Confidential mode ON không gửi page image/evidence sang Cloud Vision/Gemini. Tuy vậy search terms vẫn phải đi ra dịch vụ tra cứu ngoài; app chỉ gửi các technical concepts đã rút gọn. Với hồ sơ bí mật cực cao, chuyên gia cần phê duyệt search terms trước khi gửi.
