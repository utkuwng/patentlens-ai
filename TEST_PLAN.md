# Acceptance plan — v18

| Case | Dữ liệu | Pass condition |
|---|---|---|
| P01 | Draft+description+claims; no PDF | Manual claims parse; claim list; no patent number requirement |
| P02 | Retrospective B2 | Claim note/source required; status granted is NOT output ground truth |
| P03 | A1+known B2 ID | Search cannot auto-select target publication matching known IDs |
| P04 | B2 title identical | Warning; no auto-pick; manual override needs reason |
| P05 | Missing priority verification | Step 1 and assessment/report block |
| P06 | Consent unchecked | API search blocked |
| P07 | Confidential mode checked | Gemini/Vision disabled; external search separately controlled |
| P08 | English claims | English retained for display, not processed with VN replacement |
| P09 | Upload another PDF | Old claims/prior/matrix/reviews cleared |
| P10 | JSON save/load | Provenance and verification status restored; PDF not stored |
| P11 | Missing prior art | Report limitations and review needed; no grantability verdict |

## Expert usability/HCI protocol (to be conducted; NOT results)
Task T1: prepare case; T2: correct claim; T3: search and verify prior; T4: verify matrix; T5: export draft and identify uncertainty.
Measure task completion, errors, corrections, time, usability feedback (SUS only if administered correctly), confidence calibration. At least 2 representative experts desirable for formative test; sample size limitations disclosed. Never invent results.
