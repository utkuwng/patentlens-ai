// Cosmetic user preference only. Never write claim text, patent data or evidence to localStorage.
(function setupDossierTheme(){
  const button=document.getElementById('themeToggle');
  if(!button)return;
  let pref='dossier';
  try {const saved=localStorage.getItem('patentlens-appearance-v26');if(saved==='dossier'||saved==='classic')pref=saved;} catch(_) {}
  function apply(mode){
    document.body.dataset.theme=mode;
    button.textContent=mode==='dossier'?'Giao diện: Hồ sơ':'Giao diện: Gọn';
    button.setAttribute('aria-pressed',String(mode==='dossier'));
  }
  apply(pref);
  button.addEventListener('click',()=>{
    const next=document.body.dataset.theme==='dossier'?'classic':'dossier';
    apply(next);
    try {localStorage.setItem('patentlens-appearance-v26',next);} catch(_) {}
  });
})();

const STEPS=[
  {id:"intake",title:"Nhập hồ sơ",hint:"Chọn loại hồ sơ rồi tải PDF hoặc dán văn bản. Máy tự đọc và điền thông tin; bạn xem claims ở bước kế tiếp."},
  {id:"claims",title:"Máy nhận diện tất cả yêu cầu bảo hộ",hint:"Máy tự đưa mọi claim đọc được vào phân tích. Chỉ cần sửa nếu bản PDF/OCR có lỗi."},
  {id:"features",title:"Máy tự tách đặc điểm",hint:"Tạo bộ đặc điểm dự thảo cho tất cả claims và nhận diện giới hạn kế thừa."},
  {id:"search",title:"Chuẩn bị từ để tìm",hint:"Xem và sửa những cách diễn đạt tương đương trước khi tìm ra ngoài."},
  {id:"prior",title:"Tìm tài liệu liên quan",hint:"Tìm nhiều lượt, xem nguồn gốc và chọn D1–D3 để so sánh sâu."},
  {id:"compare",title:"So sánh từng bằng chứng",hint:"Xem từng đặc điểm cạnh đoạn trích và ghi nhận xác minh của chuyên gia."},
  {id:"assess",title:"Xem nhận định sơ bộ",hint:"Chỉ tổng hợp khi nguồn, ngày và bằng chứng đã được kiểm tra."},
  {id:"expert",title:"Chuyên gia rà soát",hint:"Ghi lại những điểm đồng ý, không đồng ý và công việc phải làm tiếp."},
  {id:"report",title:"Xuất báo cáo",hint:"Tổng hợp nguồn, phương pháp đã tìm, bằng chứng, giới hạn và nhận xét."}
];
const state={step:0,pdf:null,pageText:[],pageColumnText:[],pageQuality:[],badTextPages:[],ocrPages:{},rawText:"",claimsText:"",claims:[],selected:0,features:[],confirmed:false,search:[],queries:[],prior:{},matrix:[],assessment:{},reviews:0,candidates:[],backendUrl:"",providers:{},cloudOcr:null,tessDiag:{vie:false,eng:false,error:""},claimSourceByPage:{},docLang:"unknown",docLangConfidence:0,languageByPage:{},visionLanguagesByPage:{},searchPlan:[],searchClusters:{},selectedCandidates:{D1:null,D2:null,D3:null},matrixOnlyDifferences:false,confidentialMode:true,searchAudit:[],priorMeta:{},reviewData:{},assessmentChecks:{},citationCategories:{},claimDates:{},matrixOverrides:{},reviewLog:[],technicalEffects:{},sourceVerification:{},inputScanAudit:null,matrixScanAudit:{},searchGap:{},studyMode:"retrospective",documentVersion:"published",targetExcluded:[],inputProvenance:{},searchFacetEdits:{},searchFailures:[],searchPlanSkipped:[],evidenceReviews:{},topicRouting:null,keywordOnly:false,pdfTextScanBusy:false,pageTextScanDone:[],pdfTextErrors:{},pdfFileName:"",documentAudit:null,flowAuditVersion:"v37"};
const $=id=>document.getElementById(id);
const apiHeaders=(headers={})=>{const v=$('apiAccessCode')?.value?.trim()||'';return v?{...headers,'x-public-api-access-code':v}:headers;};
const esc=s=>(s||"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
const clean=s=>(s||"").replace(/\u00ad/g,"").replace(/[ \t]+/g," ").replace(/\n[ \t]+/g,"\n").trim();

// Topic routing is local lexicon matching, never a legal classification or a claim limitation.
function topicInputText(){
 const title=$('title')?.value||'',abstract=$('abstract')?.value||'';
 const pasted=state.pdf?'':($('manualDescriptionInput')?.value||'');
 const keyword=state.pdf?'':($('manualClaimsInput')?.value||'');
 const claims=state.claimsText||'';
 const raw=state.rawText||'';
 // Large PDFs: prioritize the claims/title/abstract and sample the description. Mark sample scope.
 const rawSample=raw.length<=150000?raw:(raw.slice(0,50000)+'\n'+raw.slice(Math.floor(raw.length/2)-25000,Math.floor(raw.length/2)+25000)+'\n'+raw.slice(-50000));
 return {text:[title,abstract,pasted,claims,keyword,rawSample].filter(Boolean).join('\n'),sourceChars:raw.length,
   sourceSampled:raw.length>150000};
}
function refreshTopicRouting(){
 const api=window.PATENTLENS_TOPIC_ROUTER;
 if(!api)return;
 const input=topicInputText();
 state.topicRouting={...api.scan(input.text),sourceSampled:input.sourceSampled,sourceChars:input.sourceChars};
 renderTopicRouting();
}
function topicQueryCandidates(){
 const topics=state.topicRouting?.topics||[];
 const q=[];
 const add=term=>{
   const norm=window.PATENTLENS_TOPIC_ROUTER.normalize(term);
   if(norm&&!q.some(x=>window.PATENTLENS_TOPIC_ROUTER.normalize(x)===norm))q.push(term);
 };
 // Round-robin: every matching topic can contribute before one topic takes all slots.
 for(let pass=0;pass<3;pass++)for(const t of topics){
   const concept=t.matchedConcepts[pass];if(!concept)continue;
   add(concept.matched.slice().sort((x,y)=>y.length-x.length)[0]);
   // VI/EN variants are separate queries, not one mixed-language AND.
   const alt=concept.alternatives.find(x=>/^[a-z][a-z\s-]{3,}$/i.test(x));
   if(alt)add(alt);
 }
 return q.slice(0,9);
}
function topicNameForTerm(term){
 const norm=window.PATENTLENS_TOPIC_ROUTER.normalize(term);
 for(const t of state.topicRouting?.topics||[])for(const c of t.matchedConcepts){
   if([...c.matched,...c.alternatives].some(x=>window.PATENTLENS_TOPIC_ROUTER.normalize(x)===norm))return t.name;
 }
 return 'Chưa xác định';
}
function renderTopicRouting(){
 const t=state.topicRouting, ui=$('topicRoutingResult'),preview=$('topicRoutingSearch');
 if(!t||!ui)return;
 const panel=$('topicRoutingPanel');if(panel)panel.classList.toggle('conditional-hidden',!t.totalChars);
 const topicList=t.topics||[];
 const warn=(t.sourceSampled?'Với PDF dài, phân loại dùng mẫu nội dung, không phải bằng chứng đã đọc toàn văn. ':'')+
   (!t.complete?'Đầu vào phân loại vượt giới hạn ký tự, cần xem lại phần chưa xét. ':'');
 ui.innerHTML=topicList.length?
   `<strong>Máy gợi ý ${topicList.length} nhóm chủ đề · từ kho thuật ngữ ban đầu</strong>`+
   (t.ambiguous?'<p class="status">Nhiều nhóm khớp tương đương — giữ tất cả hướng tìm, không ép chọn một.</p>':'')+
   topicList.map(c=>`<details class="topic-result" ${c===topicList[0]?'open':''}><summary>${esc(c.name)} · ${c.conceptCount} cụm thuật ngữ</summary>`+
     c.matchedConcepts.map(k=>`<div class="topic-concept"><strong>${esc(k.name)}</strong><br><small>Khớp trong đầu vào: ${esc(k.matched.join(' · '))}</small><br><small>Biến thể gợi ý để tìm (cần rà lại): ${esc(k.alternatives.join(' · ')||'—')}</small></div>`).join('')+`</details>`).join('')+
   `<p class="status">${esc(warn)}Đây là định tuyến tìm kiếm bằng từ điển trên máy bạn; không phải đã huấn luyện mô hình, không xác nhận IPC/CPC và không kết luận tính mới.</p>`:
   '<strong>Chưa nhận diện được nhóm chuyên ngành từ kho hiện có.</strong><p class="status">Giữ nguyên văn bản nguồn; không tự bịa từ đồng nghĩa hoặc ép tài liệu vào một nhóm.</p>';
 if(preview)preview.innerHTML=topicList.length?`<div class="status">Đã tìm thấy: ${topicList.map(x=>esc(x.name)).join(' · ')}. Thuật ngữ chỉ tạo hướng tra cứu; đối chiếu vẫn theo từng claim khi có yêu cầu bảo hộ.</div>`:
   '<div class="status">Chưa có nhóm phù hợp: bổ sung thuật ngữ được kiểm chứng hoặc chỉnh OCR trước khi tra cứu.</div>';
}
function pipelineStageFacts(){
  const pdf=state.documentAudit, audit=state.inputScanAudit, unread=audit?.unread||[],pending=audit?.pending||[];
  const claimCount=(state.claims||[]).length,featureCount=(state.features||[]).length;
  const topicCount=(state.topicRouting?.topics||[]).length;
  const selected=["D1","D2","D3"].filter(s=>!!($(`d${s.slice(1)}No`)?.value||state.prior?.[s]?.no));
  const quotes=Object.values(state.evidenceReviews||{}).filter(r=>r?.decision==='agree').length;
  const stages=[
   ['1. Tiếp nhận và đọc chữ',pdf?`${pdf.pages} trang · ${audit?pending.length+' trang cần xem/OCR':'đang kiểm tra'}${unread.length?' · '+unread.length+' trang chưa đọc được':''} · ${pdf.sha256?'đã tính SHA-256 của tệp':'chưa có SHA-256'}`:state.importedDocumentIdentity?'Tệp nháp có tham chiếu đến PDF trước đó, nhưng PDF gốc chưa được nạp lại':(state.rawText||$('manualClaimsInput')?.value||$('manualDescriptionInput')?.value)?'Văn bản do người dùng nhập; chưa xác minh bản gốc':'Chưa nhận tài liệu'],
   ['2. Trích xuất và rà soát claims',claimCount?`${claimCount} claims nhận diện; ${state.claimCoverage?.completeSequence?'số thứ tự liên tục':'chưa chắc đủ số claim'}; ${state.confirmed?'đã xác nhận bộ đặc điểm':'cần so với nguồn gốc khi dùng để nhận định'}`:state.keywordOnly?'Đầu vào từ khóa/mô tả: chưa có claim để đánh giá pháp lý':'Chưa nhận diện được claims'],
   ['3. Định tuyến ba nhóm + IPC/CPC',`${topicCount} nhóm từ kho thuật ngữ · ${featureCount} đặc điểm dự thảo; IPC/CPC ${$('ipc')?.value?.trim()?'được khai báo, cần kiểm tra':'chưa xác định'}`],
   ['4. Lập chiến lược tra cứu',`${(state.searchPlan||[]).length} truy vấn trong đợt hiện tại · ${(state.searchPlanSkipped||[]).length} vị trí feature chưa có query trong đợt`],
   ['5. Tìm qua nguồn được phép',`${(state.searchAudit||[]).length} lượt có log · ${(state.searchFailures||[]).length} lỗi; link tra thủ công không tính đã tra`],
   ['6. Sàng lọc ứng viên D1–D3',`${(state.candidates||[]).length} ứng viên đã liệt kê · ${selected.length}/3 tài liệu đã chọn để đọc; điểm xếp hạng chỉ dựa metadata/snippet`],
   ['7. Lập bảng feature ↔ đoạn nguồn',`${(state.matrix||[]).length} hàng · ${quotes} ô có quyết định đồng ý của người rà soát; câu trích chưa tự xác minh bản gốc`],
   ['8. Nhận định dự thảo → chuyên gia duyệt',`${state.assessment?.noveltyRisk?'có bản nháp nhận định':'chưa có bản nháp'} · ${state.reviews||0} hạng mục chuyên gia đã ghi nhận; không phải quyết định cấp bằng`]
  ];
  return stages;
}
function renderPipelineAudit(){
 const el=$('flowAuditContent');if(!el)return;
 const entries=pipelineStageFacts();
 el.innerHTML=entries.map(([name,value])=>`<div class="flow-audit-row"><strong>${esc(name)}</strong><span>${esc(value)}</span></div>`).join('')+
  '<p class="status" style="margin-top:8px">Phạm vi: chỉ các trang đã trích xuất, các nguồn thật sự được gọi và các ô được xác nhận. Không suy ra đã đọc hiểu mọi hình vẽ, đã bao phủ mọi quốc gia hoặc đã hoàn tất thẩm định.</p>';
}
function refreshTopicRoutingAndQueries(){refreshTopicRouting();state.search=[];state.queries=[];state.searchPlan=[];state.searchFacetEdits={};}
function researchMode(){return $("studyMode")?.value||"retrospective"}
function versionType(){return $("documentVersion")?.value||"published"}
function normalizedPublication(n){return String(n||"").toUpperCase().replace(/[^A-Z0-9]/g,"")}
function exactTargetIdentifierSet(){
  return new Set([$("patentNo")?.value||"",...String($("targetRelatedPublications")?.value||"").split(/[,;\n]+/)].map(normalizedPublication).filter(Boolean));
}
function targetOverlapReason(c){
  const pub=normalizedPublication(c?.publication_number);
  if(pub&&exactTargetIdentifierSet().has(pub))return "Đúng số công bố mục tiêu hoặc cùng hồ sơ đã khai báo";
  const target=foldVN($("title")?.value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  const title=foldVN(c?.title||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  if(target.length>=24&&target===title)return "Trùng chính xác tiêu đề mục tiêu: cần xác minh có phải cùng hồ sơ/family";
  return "";
}
function inputProvenance(){return {
  mode:researchMode(),version:versionType(),source:$("inputSourceUrl")?.value?.trim()||"",
  related:$("targetRelatedPublications")?.value?.trim()||"",
  claimNote:$("claimVersionNote")?.value?.trim()||"",reference:$("caseReference")?.value?.trim()||"",
  versionConfirmed:!!$("inputVersionConfirmed")?.checked,dateVerified:!!$("relevantDateVerified")?.checked,
  manualDescription:$("manualDescriptionInput")?.value||""
}}
function inputGate(strict=true){
  const p=inputProvenance(),claims=state.claims||[],relevant=relevantDateValue();
  const issues=[];
  const purpose=$('purposeChoice')?.value||'';
  if(!['patentability','pilot'].includes(purpose))issues.push('Mục đích chưa phù hợp với luồng đánh giá sáng chế. Hãy chọn chuẩn bị đăng ký hoặc kiểm thử công khai.');
  if((purpose==='pilot'&&p.mode!=='retrospective')||(purpose==='patentability'&&p.mode!=='prospective'))issues.push('Mục đích và loại đầu vào chưa khớp.');
  if(p.mode==="prospective"&&["published","granted"].includes(p.version))issues.push("Chế độ trước nộp đơn không nhận A1/B2 như hồ sơ dự thảo; đổi phiên bản hoặc dùng kiểm thử hồi cứu.");
  if(p.mode==="retrospective"&&p.version==="draft")issues.push("Dự thảo không phải bộ dữ liệu công khai; chọn hỗ trợ trước nộp đơn hoặc xác minh nguồn khác.");
  if(strict&&state.pdf&&!$("ocrReviewConfirmed")?.checked)issues.push("Chưa rà soát claims máy đọc với PDF gốc ở Bước 6.");
  if(strict&&!state.pdf&&state.claimsText&&!checkManualInputReview())issues.push("Chưa rà soát bản claims nhập tay ở Bước 6.");
  if(strict&&!p.versionConfirmed)issues.push("Chưa xác nhận phiên bản claims với tài liệu nguồn.");
  if(!claims.length)issues.push("Chưa có claims được tách để phân tích.");
  if(p.mode==="prospective"&&!$("manualDescriptionInput")?.value?.trim()&&!state.pdf&&!$("manualClaimsInput")?.value?.trim())issues.push("Chưa có mô tả hay claims để phân tích.");
  // Tên giải pháp là metadata tham khảo, không phải điều kiện buộc người dùng khai để nhận định. 
  if(strict&&!relevant)issues.push("Chưa có ngày liên quan dự kiến của claim.");
  if(strict&&!p.dateVerified)issues.push("Chưa xác minh ngày liên quan và căn cứ ưu tiên.");
  if(strict&&p.mode==="retrospective"&&!p.source)issues.push("Chưa ghi URL/mã nguồn của tài liệu công khai để truy vết.");
  if(strict&&p.version==="granted"&&!p.claimNote)issues.push("Văn bằng đã cấp: hãy ghi rõ chỉ phân tích phiên bản claims đã cấp, không mặc định là bản lúc nộp.");
  return {ok:issues.length===0,issues,provenance:p};
}
function inputReviewFingerprint(){
 return JSON.stringify({claims:state.claimsText||'',manual:$('manualClaimsInput')?.value||'',title:$('title')?.value||'',filing:$('filingDate')?.value||'',cutoff:$('relevantDate')?.value||'',source:$('inputSourceUrl')?.value||''});
}
let manualReviewStamp='';
function resetInputReview(source){
 if(source==='pdf'||!source){if($('ocrReviewConfirmed'))$('ocrReviewConfirmed').checked=false;}
 if(source==='manual'||!source){if($('manualReviewConfirmed'))$('manualReviewConfirmed').checked=false;manualReviewStamp='';}
}
function checkManualInputReview(){
 const gate=$('manualReviewGate'),box=$('manualReviewConfirmed');if(!gate||!box)return true;
 const manual=(!state.pdf && !!state.claimsText.trim());gate.hidden=!manual;
 if(!manual)return true;
 const ok=box.checked&&manualReviewStamp===inputReviewFingerprint();
 const el=$('manualReviewStatus');if(el)el.textContent=ok?'✓ Đã rà soát văn bản nhập tay ở phiên bản hiện tại.':'Chưa xác nhận hoặc văn bản/thông tin đã thay đổi sau lần xác nhận.';
 return ok;
}
if($('manualReviewConfirmed'))$('manualReviewConfirmed').onchange=()=>{manualReviewStamp=$('manualReviewConfirmed').checked?inputReviewFingerprint():'';checkManualInputReview();};
for(const id of ['manualClaimsInput','claimsClean','title','filingDate','relevantDate','inputSourceUrl']){const el=$(id);if(el)el.addEventListener('input',()=>{if(!state.pdf){if($('manualReviewConfirmed'))$('manualReviewConfirmed').checked=false;manualReviewStamp='';checkManualInputReview();}});}
function renderInputMode(){
  state.studyMode=researchMode();state.documentVersion=versionType();
  const mode=researchMode(),v=versionType(),hint=$("inputModeHint");
  const invalid=(mode==="prospective"&&["granted","published"].includes(v))||(mode==="retrospective"&&v==="draft");
  if(hint){hint.className="mode-hint"+(invalid?" err":" ok");hint.innerHTML=invalid
    ? "⚠ Phiên bản tài liệu chưa phù hợp với loại hồ sơ đang xét."
    : mode==="prospective"?"Máy sẽ đọc bản dự thảo. Bạn kiểm tra claims ở bước tiếp theo."
    : "Máy sẽ đọc bản công khai; phiên bản và ngày được xác minh trước khi nhận định.";}
  renderInputGate();
}
function renderInputGate(){
 const el=$("studyGate");if(!el)return;const g=inputGate(false);
 el.className="mode-hint"+(g.ok?" ok":" err");
 const ready=document.querySelector('[data-study-path].active:not(:disabled)');
 if(!ready){el.textContent="Chọn loại hồ sơ để bắt đầu.";el.className="mode-hint";return;}
 const filled=state.claims.length>0||!!$("manualClaimsInput")?.value?.trim()||!!$("manualDescriptionInput")?.value?.trim()||!!$("pdfInput")?.files?.length;
 if(!filled){el.textContent="Tiếp theo: chọn PDF hoặc dán văn bản.";el.className="mode-hint";}
 else if(state.claims.length){el.textContent=`✓ Máy đã nhận diện ${state.claims.length} yêu cầu bảo hộ. Xem kết quả ở bước 2.`;el.className="mode-hint ok";}
 else if(state.keywordOnly){el.textContent="Đã nhận từ khóa/mô tả. Máy đã chuyển sang định tuyến chủ đề tại Bước 4; chưa có claims để đánh giá tính mới.";el.className="mode-hint ok";}
 else {el.textContent="Đã nhận tài liệu. Sang bước 2 để kiểm tra và sửa phần yêu cầu bảo hộ máy chưa tách được.";}
 const b=$("reviewInputBtn");if(b)b.classList.add("conditional-hidden");
}
function useManualClaims(){
 const src=$("manualClaimsInput")?.value?.trim()||"";
 const description=$("manualDescriptionInput")?.value?.trim()||"";
 if(!src&&!description)return alert("Hãy nhập từ khóa, một đoạn mô tả hoặc claims để máy nhận diện chủ đề.");
 if(src.length+description.length<3)return alert("Đầu vào quá ngắn để dò thuật ngữ kỹ thuật.");
 if(researchMode()==="prospective"&&["published","granted"].includes(versionType()))return alert("Đang ở chế độ trước nộp đơn: chọn Draft/As-filed/Other cho đầu vào nhập tay.");
 const detected=detectTextLanguage(src);if(["vi","en"].includes(detected.lang))state.analysisLang=detected.lang;
 const claims=parseClaims(src);
 const keywordOnly=!claims.length;
 state.keywordOnly=keywordOnly;
 state.pdf=null;state.pageText=[];state.pageColumnText=[];state.ocrPages={};resetInputReview();if($("manualReviewGate"))$("manualReviewGate").hidden=false;
 state.claimsText=keywordOnly?'':src;state.rawText=[description,src].join("\n\n");
 state.claims=claims;state.selected=0;state.claimDates={};
 state.features=[];state.confirmed=false;state.search=[];state.queries=[];state.candidates=[];
 state.matrix=[];state.matrixOverrides={};state.assessment={};state.prior={};state.priorMeta={};state.selectedCandidates={D1:null,D2:null,D3:null};
 state.searchAudit=[];state.searchPlan=[];state.searchFacetEdits={};state.searchFailures=[];state.evidenceReviews={};state.targetExcluded=[];state.sourceVerification={};state.technicalEffects={};state.reviewData={};state.reviews=0;
 for(const slot of ["D1","D2","D3"]){const n=slot.slice(1);for(const k of ["No","Date","Url","Text"]){const el=$(`d${n}${k}`);if(el)el.value="";}}
 $("claimsRaw").value=keywordOnly?'':src;$("claimsClean").value=keywordOnly?'':formatClaimForDisplay(src);
 if(keywordOnly){state.claims=[];state.features=[];state.claimGroups=[];state.claimIssues=[];}
 refreshTopicRoutingAndQueries();
 if(!keywordOnly)renderClaims();renderFeatures();renderSearch();renderCandidates();renderMatrix();
 syncRelevantDate();state.reviewLog.push({time:new Date().toISOString(),action:"manual_claim_input",version:versionType()});
 if($("pdfStatus"))$("pdfStatus").textContent=keywordOnly?'Đã nhận từ khóa/mô tả; chưa có PDF hoặc claims.':'Đã nhập claims thủ công; không sử dụng PDF.';
 if($("manualInputStatus"))$("manualInputStatus").textContent=keywordOnly?
   'Đã nhận từ khóa/mô tả. Máy định tuyến chủ đề để tìm tài liệu; chưa có claims nên chưa đánh giá tính mới.':
   `✓ Đã tách ${claims.length} claims. Kiểm tra nguyên văn tại Bước 2.`;
 setDetect("detClaims",!keywordOnly,keywordOnly?'Chưa có claims; chỉ định tuyến chủ đề':`Đã nạp ${claims.length} claims nhập tay`);renderInputGate();
 if(state.step===0)showStep(keywordOnly?3:1);
}

function setActiveButton(groupSelector,attr,value){
  document.querySelectorAll(groupSelector).forEach(b=>b.classList.toggle("active",b.getAttribute(attr)===value));
}
function renderIntakeWorkflow(){
  const box=$("intakeWorkflowPreview");if(!box)return;
  const mode=researchMode(),v=versionType();
  const steps=mode==="prospective"
    ? ["Hồ sơ dự thảo","Claims","Feature","Tra cứu","D1–D3","Matrix","Đánh giá sơ bộ","Expert","Báo cáo"]
    : [v==="granted"?"B2 as-granted":v==="published"?"A1 published":v==="as_filed"?"As-filed":"Tài liệu công khai","Claims","Feature","Tra cứu hồi cứu","D1–D3","Matrix","Đánh giá","Đối chiếu","Báo cáo"];
  box.innerHTML=steps.map((s,i)=>`${i?'<span class="wf-arrow">→</span>':''}<span class="wf-step ${i===0?'current':''} ${mode==='retrospective'&&i===0&&v==='granted'?'limit':''}">${esc(s)}</span>`).join("");
}
function applyGuidedMode(mode){
  if(!["prospective","retrospective"].includes(mode))return;
  $("studyMode").value=mode;
  if($("purposeChoice"))$("purposeChoice").value=mode==="prospective"?"patentability":"pilot";
  setActiveButton("[data-study-path]","data-study-path",mode);
  // Extra version/claim controls are moved to the claims review, not part of starting a case.
  $("prospectiveSetup")?.classList.add("conditional-hidden");
  $("retrospectiveSetup")?.classList.add("conditional-hidden");
  $("sourceFields")?.classList.toggle("conditional-hidden",mode!=="retrospective");
  if(mode==="prospective"){
    $("documentVersion").value="draft";
    if($("inputVersionConfirmed"))$("inputVersionConfirmed").checked=false;
    $("inputSourceUrl").value="";
  }else{
    $("documentVersion").value="other"; // Unknown until the PDF is identified or user selects a version at step 2.
  }
  if($("claimVersionReview"))$("claimVersionReview").classList.toggle("conditional-hidden",mode!=="retrospective");
  renderInputMode();renderIntakeWorkflow();revealDataWorkspace();
}
function applyDocumentVersion(v){
  $("documentVersion").value=v;
  setActiveButton("[data-doc-version]","data-doc-version",v);
  const n=$("retrospectiveNext");if(n){n.classList.remove("conditional-hidden","warn","err");
    if(v==="granted"){n.classList.add("warn");n.innerHTML="App sẽ kiểm tra <strong>nội dung trong bằng đã cấp</strong>, không phải bản lúc mới nộp.";}
    else if(v==="published"){n.innerHTML="Chọn PDF hoặc dán nội dung trong đơn đã công bố.";}
    else if(v==="as_filed"){n.innerHTML="Hãy chắc chắn đây đúng là bản lúc nộp.";}
    else {n.classList.add("warn");n.innerHTML="Hãy kiểm tra nguồn để xác định đúng loại tài liệu.";}}
  renderInputMode();renderIntakeWorkflow();revealDataWorkspace();
}
function applyProspectiveClaimState(hasClaims){
  setActiveButton("[data-has-claims]","data-has-claims",hasClaims);
  const n=$("prospectiveNext");if(!n)return;n.classList.remove("conditional-hidden","warn","err");
  if(hasClaims==="yes"){
    n.innerHTML="Bạn có thể tải PDF hoặc dán nội dung bên dưới.";
    $("documentVersion").value="draft";
  }else{
    n.classList.add("warn");
    n.innerHTML="Bạn mới có bản mô tả. Cần chuyên gia soạn nội dung yêu cầu bảo hộ trước khi dùng luồng đánh giá tính mới; app chưa có chức năng khảo sát độc lập.";
    $("documentVersion").value="other";
  }
  renderInputMode();renderIntakeWorkflow();revealDataWorkspace();
}
function updatePurposeChoice(){
  // Only two implemented intake modes. Preserve the hidden purpose value for older imported cases.
  const mode=$('studyMode')?.value||'retrospective';
  const v=$('purposeChoice')?.value||'';
  if($('studyPathCards'))$('studyPathCards').classList.remove('conditional-hidden');
  document.querySelectorAll('[data-study-path]').forEach(b=>{
    b.disabled=false;
    b.classList.remove('conditional-hidden');
    b.classList.toggle('active',v!==''&&b.dataset.studyPath===mode);
  });
}
function setupGuidedIntake(){
  // A click on either card is the sole user-facing choice; there is no unfinished service at intake.
  updatePurposeChoice();
  document.querySelectorAll("[data-study-path]").forEach(b=>b.onclick=()=>applyGuidedMode(b.dataset.studyPath));
  document.querySelectorAll("[data-doc-version]").forEach(b=>b.onclick=()=>applyDocumentVersion(b.dataset.docVersion));
  document.querySelectorAll("[data-has-claims]").forEach(b=>b.onclick=()=>applyProspectiveClaimState(b.dataset.hasClaims));
  // Default UX: no branch preselected. State remains retrospective internally until user chooses.
  renderIntakeWorkflow();
}

function chooseInputSource(kind){
 const isPdf=kind!=="text";
 $("pdfPane")?.classList.toggle("conditional-hidden",!isPdf);
 $("manualPane")?.classList.toggle("conditional-hidden",isPdf);
 for(const [id,active] of [["pickPdf",isPdf],["pickText",!isPdf]]){
   const b=$(id);if(!b)continue;b.classList.toggle("active",active);b.setAttribute("aria-pressed",String(active));
 }
}
function revealDataWorkspace(){
 const mode=document.querySelector('[data-study-path].active')?.dataset.studyPath;
 const ready=mode==="prospective"||mode==="retrospective";
 for(const id of ["dataWorkspace","intakeMetadata","recognitionPanel"]){const e=$(id);if(e)e.classList.toggle("conditional-hidden",!ready);}
 const source=$("sourceFields");if(source)source.classList.toggle("conditional-hidden",mode!=="retrospective");
 const chooser=$("researchAdvanced");if(chooser)chooser.classList.toggle("conditional-hidden",!ready);
 const gate=$("studyGate");if(gate)gate.parentElement?.classList.toggle("conditional-hidden",!ready);
 if(ready){if(mode==="retrospective"&&versionType()==="granted"&&!$("claimVersionNote").value){$("claimVersionNote").value="Chỉ phân tích yêu cầu bảo hộ trong bản đã cấp; không xem đây là bản ban đầu.";}}
 renderInputGate();
}
function revealInputIssues(){
 const g=inputGate(false);if(g.ok)return;
 const missing=g.issues.join("\n");
 if(g.issues.some(s=>/ngày liên quan|ưu tiên|tên giải pháp/i.test(s))){
   $("intakeMetadata")?.scrollIntoView({behavior:"smooth",block:"center"});
 }else{
   $("researchAdvanced").open=true;
   $("researchAdvanced").scrollIntoView({behavior:"smooth",block:"center"});
 }
 alert("Cần kiểm tra trước khi tiếp tục:\n"+missing);
}
function installVisualUX(){
 $("pickPdf").onclick=()=>chooseInputSource("pdf");
 $("pickText").onclick=()=>chooseInputSource("text");
 $("reviewInputBtn").onclick=revealInputIssues;
 const help=$("toggleQuickHelp");
 if(help)help.onclick=()=>{$("walkthrough").open=!$("walkthrough").open;help.setAttribute("aria-expanded",String($("walkthrough").open));if($("walkthrough").open)$("walkthrough").scrollIntoView({behavior:"smooth",block:"start"});};
 if($("walkthrough"))$("walkthrough").addEventListener("toggle",()=>{if(help)help.setAttribute("aria-expanded",String($("walkthrough").open));});
 const vp=$("claimVersionPlace"),dc=$("documentVersionChoices");if(vp&&dc)vp.appendChild(dc);
 if($("claimVersionReview"))$("claimVersionReview").classList.toggle("conditional-hidden",researchMode()!=="retrospective");
 chooseInputSource("pdf");revealDataWorkspace();
}

function setupResearchInput(){
 setupGuidedIntake();
 installVisualUX();
 for(const id of ["studyMode","documentVersion","inputSourceUrl","targetRelatedPublications","claimVersionNote","caseReference","inputVersionConfirmed","relevantDateVerified"]){
   const el=$(id);if(el){el.addEventListener("change",()=>{renderInputMode();if(id==="targetRelatedPublications")renderCandidates()});el.addEventListener("input",renderInputGate)}
 }
 if($("useManualInput"))$("useManualInput").onclick=useManualClaims;
 for(const id of ['manualClaimsInput','manualDescriptionInput'])$(id)?.addEventListener('input',()=>{
    // Recompute only after user presses Use text to avoid stale PDF claims entering the same route.
    if(!state.pdf&&!state.claims.length)refreshTopicRouting();
 });
 renderInputMode();
}

function foldVN(s){
  return (s||"")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/đ/g,"d").replace(/Đ/g,"D")
    .toUpperCase();
}

const VI_HINT_WORDS=[
  "sáng chế","yêu cầu bảo hộ","quy trình","phương pháp","bao gồm","trong đó","tinh dầu","dung dịch",
  "hỗn hợp","đồng nhất","thiết bị","khuấy","thời gian","thu được","chế phẩm","bước","phối trộn","ổn định",
  "sản xuất","thành phần","nồng độ","nhiệt độ","độ ẩm","người nộp đơn","đại diện","ngày nộp đơn"
];
const EN_HINT_WORDS=[
  "patent","claims","claim","method","process","comprising","wherein","mixture","solution","device","system",
  "composition","step","temperature","time","obtained","apparatus","invention","applicant","assignee","filed"
];

function detectTextLanguage(text){
  const t=normalizeOcrText(text||"");
  if(!t.trim()) return {lang:"unknown",confidence:0,vi:0,en:0};

  const low=t.toLowerCase();
  const chars=Math.max(1,t.length);
  const viSpecific=(t.match(/[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/g)||[]).length;

  let vi=viSpecific*2.4;
  let en=0;
  for(const w of VI_HINT_WORDS) if(low.includes(w)) vi+=7;
  for(const w of EN_HINT_WORDS) if(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\b`,"i").test(t)) en+=5;

  // Vietnamese Latin text typically has a meaningful density of diacritics.
  vi+=Math.min(30,(viSpecific/chars)*500);

  const words=t.split(/\s+/).filter(Boolean);
  const asciiWords=words.filter(w=>/^[A-Za-z][A-Za-z\-]*$/.test(w)).length;
  if(words.length>8) en+=Math.min(20,(asciiWords/words.length)*18);

  const total=vi+en;
  if(total<8) return {lang:"unknown",confidence:0.2,vi,en};

  if(vi>=en*1.35) return {lang:"vi",confidence:Math.min(.99,vi/Math.max(1,total)),vi,en};
  if(en>=vi*1.35) return {lang:"en",confidence:Math.min(.99,en/Math.max(1,total)),vi,en};
  return {lang:"mixed",confidence:.55,vi,en};
}

function chooseDocumentLanguage(){
  let vi=0,en=0,mixed=0,weight=0;
  for(let i=0;i<state.pageText.length;i++){
    const q=state.pageQuality[i]||0;
    if(q<45) continue;
    const d=detectTextLanguage(state.pageText[i]);
    const w=Math.max(.3,q/100);
    if(d.lang==="vi") vi+=d.confidence*w;
    else if(d.lang==="en") en+=d.confidence*w;
    else if(d.lang==="mixed") mixed+=d.confidence*w;
    weight+=w;
    state.languageByPage[i+1]=d;
  }
  if(vi>en*1.35 && vi>mixed*.8){
    state.docLang="vi"; state.docLangConfidence=Math.min(.99,vi/Math.max(1,vi+en+mixed));
  }else if(en>vi*1.35 && en>mixed*.8){
    state.docLang="en"; state.docLangConfidence=Math.min(.99,en/Math.max(1,vi+en+mixed));
  }else if(vi+en+mixed>0){
    state.docLang="mixed"; state.docLangConfidence=.55;
  }else{
    state.docLang="unknown"; state.docLangConfidence=0;
  }
  return {lang:state.docLang,confidence:state.docLangConfidence};
}

function languageLabel(lang){
  return lang==="vi"?"Tiếng Việt":lang==="en"?"English":lang==="mixed"?"Việt + Anh":"Chưa xác định";
}

function effectiveLanguageMode(){
  const ui=$("languageMode");
  const mode=(ui&&ui.value)||state.languageMode||"auto";
  state.languageMode=mode;
  return mode;
}

function detectedPageLanguage(pageNo){
  const x=state.languageByPage[pageNo];
  return x&&x.lang?x.lang:"unknown";
}

function resolveAnalysisLanguage(){
  const mode=effectiveLanguageMode();
  if(mode==="vi"||mode==="en"||mode==="mixed"){
    state.analysisLang=mode;
    return mode;
  }

  const claim=state.claims[state.selected]||state.claims[0];
  const sample=[
    $("title")?.value||"",
    claim?.text||"",
    $("abstract")?.value||""
  ].join("\n");
  const d=detectTextLanguage(sample);
  state.analysisLang=d.lang==="unknown"?(state.docLang||"unknown"):d.lang;
  return state.analysisLang;
}

function languageStatusText(){
  const mode=effectiveLanguageMode();
  const detected=languageLabel(state.docLang);
  if(mode==="auto") return `Auto · tài liệu: ${detected} · confidence ${Math.round((state.docLangConfidence||0)*100)}%`;
  if(mode==="vi") return `Đã khóa Tiếng Việt · Tesseract chỉ dùng vie`;
  if(mode==="en") return `Locked English · Tesseract uses eng only`;
  return `Mixed mode · mỗi trang được tách Việt/Anh riêng`;
}

function updateLanguageStatus(){
  if($("languageStatus")) $("languageStatus").textContent=languageStatusText();
}

function updateMetadataLabels(){
  const lang=resolveAnalysisLanguage();
  const set=(id,text)=>{const el=$(id);if(el)el.textContent=text};

  if(lang==="en"){
    set("applicantLabel","Applicant");
    set("assigneeLabel","Assignee / Owner");
    set("representativeLabel","Representative / Agent / Attorney");
  }else if(lang==="vi"){
    set("applicantLabel","Người nộp đơn");
    set("assigneeLabel","Chủ bằng / Chủ sở hữu");
    set("representativeLabel","Đại diện SHTT / Đại diện SHCN");
  }else{
    set("applicantLabel","Người nộp đơn / Applicant");
    set("assigneeLabel","Chủ bằng / Assignee / Owner");
    set("representativeLabel","Đại diện / Representative / Agent");
  }
}


function applyLanguageSpecificCleanup(text,lang){
  const t=normalizeOcrText(text||"");
  if(lang==="vi") return repairCertainVnOcr(t);
  if(lang==="mixed"){
    // Mixed: only repair fragments confidently detected as Vietnamese line by line.
    return t.split(/\n+/).map(line=>{
      const d=detectTextLanguage(line);
      return d.lang==="vi"?repairCertainVnOcr(line):normalizeOcrText(line);
    }).join("\n").normalize("NFC");
  }
  // English/unknown: NEVER run Vietnamese substitutions.
  return t.normalize("NFC");
}

function englishSanityScore(text){
  const t=normalizeOcrText(text||"");
  const words=t.match(/[A-Za-z][A-Za-z'-]*/g)||[];
  if(words.length<6) return 20;

  const common=new Set([
    "the","a","an","of","to","and","or","in","for","with","is","are","by","from",
    "comprising","comprises","wherein","method","process","system","device","material",
    "claim","claims","invention","said","one","plurality","having","configured","using"
  ]);
  const commonHits=words.filter(w=>common.has(w.toLowerCase())).length;
  const allCaps=words.filter(w=>w.length>=3&&w===w.toUpperCase()).length;
  const short=words.filter(w=>w.length<=2).length;
  const weird=(t.match(/[�□■{}<>|~^`\\]/g)||[]).length;

  let score=45;
  score+=Math.min(32,commonHits*3);
  score-=Math.min(30,(allCaps/Math.max(1,words.length))*45);
  score-=Math.min(20,(short/Math.max(1,words.length))*25);
  score-=Math.min(30,weird*4);
  return Math.max(0,Math.min(100,Math.round(score)));
}

function vietnameseSanityScore(text){
  const t=normalizeOcrText(text||"");
  const d=detectTextLanguage(t);
  let score=textLayerQualityScore(t);
  if(d.lang==="vi") score+=20*d.confidence;
  if(d.lang==="en") score-=20;
  score-=Math.min(35,(t.match(/\b(?:tỉnh dầu|tính dầu|dung địch|hồn hợp)\b/gi)||[]).length*6);
  return Math.max(0,Math.min(100,Math.round(score)));
}

function languageSanityScore(text,lang){
  if(lang==="en") return englishSanityScore(text);
  if(lang==="vi") return vietnameseSanityScore(text);
  if(lang==="mixed"){
    const lines=normalizeOcrText(text||"").split(/\n+/).filter(x=>x.trim());
    if(!lines.length) return 0;
    const scores=lines.map(line=>{
      const d=detectTextLanguage(line);
      return d.lang==="vi"?vietnameseSanityScore(line):
             d.lang==="en"?englishSanityScore(line):
             textLayerQualityScore(line);
    });
    return Math.round(scores.reduce((a,b)=>a+b,0)/scores.length);
  }
  return textLayerQualityScore(text);
}

function languageCompatible(detected,target){
  if(target==="unknown"||!target) return true;
  if(target==="mixed") return true;
  if(detected==="unknown") return true;
  if(detected==="mixed") return false;
  return detected===target;
}

function splitByDetectedLanguage(text){
  const buckets={vi:[],en:[],unknown:[]};
  for(const line of normalizeOcrText(text||"").split(/\n+/)){
    const x=line.trim();
    if(!x) continue;
    const d=detectTextLanguage(x);
    if(d.lang==="vi") buckets.vi.push(x);
    else if(d.lang==="en") buckets.en.push(x);
    else buckets.unknown.push(x);
  }
  return buckets;
}


function languageFitScore(text,target){
  const d=detectTextLanguage(text);
  if(target==="vi"){
    if(d.lang==="vi") return 28*d.confidence;
    if(d.lang==="mixed") return 10;
    if(d.lang==="en") return -20;
  }
  if(target==="en"){
    if(d.lang==="en") return 25*d.confidence;
    if(d.lang==="mixed") return 8;
    if(d.lang==="vi") return -18;
  }
  if(target==="mixed") return d.lang==="mixed"?16:5;
  return 0;
}

function claimMarkerInfo(text){
  const f=foldVN(text);
  const patterns=[
    /YEU\s*CAU\s*BAO\s*HO/,
    /NHUNG\s*DIEU\s*YEU\s*CAU\s*BAO\s*HO/,
    /WHAT\s+IS\s+CLAIMED\s+IS\s*:*/,
    /I\s*\/?\s*WE\s+CLAIM\s*:*/,
    /\bCLAIMS?\s*:*/
  ];
  for(const re of patterns){
    const m=f.match(re);
    if(m) return {index:m.index,end:m.index+m[0].length};
  }
  return null;
}
function looksLikeClaimPage(text){
  const f=foldVN(text);
  return /(?:^|\n|\s)1\s*[\.\)]\s*(QUY TRINH|PHUONG PHAP|SAN PHAM|THIET BI|HE THONG|CHE PHAM|A\s|AN\s|THE\s)/.test(f)
    && /(BAO GOM|COMPRISING|COMPRISES|GOM CAC BUOC|INCLUDING)/.test(f);
}
function extractClaimsTail(text){
  if(!text) return "";
  const mark=claimMarkerInfo(text);
  if(mark) return truncateClaimAtFigure(clean(text.slice(mark.end)));
  const f=foldVN(text);
  const re=/(?:^|\n|\s)1\s*[\.\)]\s*(QUY TRINH|PHUONG PHAP|SAN PHAM|THIET BI|HE THONG|CHE PHAM|A\s|AN\s|THE\s)/;
  const mm=f.match(re);
  return mm ? truncateClaimAtFigure(clean(text.slice(mm.index))) : "";
}
function normalizeOcrText(s){
  // v10: không tự nối dòng tùy tiện nữa. Chỉ chuẩn hóa Unicode/khoảng trắng.
  // Điều này tránh biến văn bản Việt đúng thành chuỗi dính như "NẢYMẦM" hoặc kéo footer vào title.
  return String(s||"")
    .replace(/\uFEFF/g,"")
    .replace(/\u00ad/g,"")
    .replace(/[\u200B-\u200D\u2060]/g,"")
    .normalize("NFC")
    .replace(/[“”]/g,'"').replace(/[‘’]/g,"'")
    .replace(/[‐‑‒–—]/g,"-")
    .replace(/\u00a0/g," ")
    .replace(/[ \t]+/g," ")
    .replace(/[ \t]+\n/g,"\n")
    .replace(/\n[ \t]+/g,"\n")
    .replace(/\s+([,.;:%\)])/g,"$1")
    .replace(/(\()\s+/g,"$1")
    .replace(/(\d)\s*,\s*(\d)/g,"$1,$2")
    .replace(/\n{3,}/g,"\n\n")
    .trim();
}

function stripPdfArtifacts(s){
  let t=normalizeOcrText(s);

  // Page counters / footer artifacts commonly emitted by Vietnamese patent PDFs.
  t=t.replace(/(?:\b\d{3,10}\s+\d{1,3}\s*\/\s*\d{1,3}\b[\s,;:]*){2,}/g," ");
  t=t.replace(/\b\d{3,10}\s+\d{1,3}\s*\/\s*\d{1,3}\b/g," ");
  t=t.replace(/(?:\b\d{1,3}\s*\/\s*\d{3,10}\b[\s,;:]*){2,}/g," ");
  t=t.replace(/^\s*\d{1,3}\s*\/\s*\d{1,3}\s*$/gm,"");
  t=t.replace(/^\s*(?:Page|Trang)\s+\d+(?:\s*\/\s*\d+)?\s*$/gmi,"");

  // Collapse only horizontal noise; keep semantic line breaks.
  return t.replace(/[ \t]{2,}/g," ").replace(/\n{3,}/g,"\n\n").trim();
}

function textLayerQualityScore(text){
  const t=stripPdfArtifacts(text); if(looksLikeLegacyEncoding(t)) return 5;
  if(!t) return 0;

  const chars=t.length;
  const letters=(t.match(/\p{L}/gu)||[]).length;
  const digits=(t.match(/\d/g)||[]).length;
  const weird=(t.match(/[�□■{}<>|~^`]/g)||[]).length;
  const slashSeq=(t.match(/\d+\s*\/\s*\d+/g)||[]).length;
  const words=t.split(/\s+/).filter(Boolean);
  const shortWords=words.filter(w=>w.length<=1).length;

  let score=0;
  score+=Math.min(40, chars/35);
  score+=Math.min(25, (letters/Math.max(1,chars))*45);
  if(/[ăâđêôơưĂÂĐÊÔƠƯ]/.test(t)) score+=8;
  if(/[àáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i.test(t)) score+=8;
  if(/\b(?:sáng chế|yêu cầu bảo hộ|quy trình|phương pháp|bao gồm|trong đó|thiết bị|hệ thống)\b/i.test(t)) score+=12;

  score-=Math.min(35,weird*5);
  score-=Math.min(30,slashSeq*5);
  if(digits/Math.max(1,chars)>.28) score-=18;
  if(shortWords/Math.max(1,words.length)>.25) score-=15;

  return Math.max(0,Math.min(100,Math.round(score)));
}


function repairCertainVnOcr(text){
  // Chỉ sửa lỗi OCR rất điển hình theo ngữ cảnh kỹ thuật, không sáng tác claim.
  return normalizeOcrText(text||"")
    .replace(/\b(?:tỉnh|tính|tình)\s+dầu\b/gi,"tinh dầu")
    .replace(/\bdung\s+địch\b/gi,"dung dịch")
    .replace(/\bh(?:ồn|ôn)\s+hợp\b/gi,"hỗn hợp")
    .replace(/\bnả[yý]?\s*mầm\b/gi,"nảy mầm")
    .replace(/\bkhud[yý]\b/gi,"khuấy")
    .replace(/\bkhu[ẩảa]y\s+b(?:ă|a|i)ng\s+từ\b/gi,"khuấy bằng từ")
    .replace(/\bkhu[ẩảa]y\s+bing\s+từ\b/gi,"khuấy bằng từ")
    .replace(/\btinh dầu\s+sa\s+java\b/gi,"tinh dầu sả java")
    .replace(/\btinh dầu\s+oai\s+hương\b/gi,"tinh dầu oải hương")
    .replace(/\bkết\s+qua\b/gi,"kết quả")
    .replace(/\bhon\s+hợp\b/gi,"hỗn hợp")
    .normalize("NFC");
}

function trimDiagramNoise(text){
  const lines=normalizeOcrText(text||"").split(/\n+/).map(x=>x.trim()).filter(Boolean);
  if(lines.length<8) return lines.join("\n");

  let cut=lines.length;
  let seenClaimSentence=false;

  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/[.;]$/.test(line) && /(?:thu được|obtained|comprising|wherein|bao gồm|trong đó)/i.test(lines.slice(Math.max(0,i-4),i+1).join(" "))){
      seenClaimSentence=true;
    }
    if(!seenClaimSentence) continue;

    const window=lines.slice(i,Math.min(lines.length,i+7));
    if(window.length<4) continue;

    let noisy=0;
    for(const w of window){
      if(w.length<28) noisy++;
      if(/^\d{2,4}[A-Za-z]?$/.test(w)) noisy++;
      if((w.match(/[|\\/_><~]/g)||[]).length>=1) noisy++;
    }
    if(noisy>=6){
      cut=i;
      break;
    }
  }
  return lines.slice(0,cut).join("\n");
}

function truncateClaimAtFigure(text,lang){
  const detected=lang||detectTextLanguage(text||"").lang;
  let t=stripPdfArtifacts(applyLanguageSpecificCleanup(text||"",detected));

  // Flexible figure markers, including OCR forms such as "HÌN\nH1" or "H I N H 1".
  const stops=[
    /(?:^|\n)\s*H\s*[ÌIÍỈĨỊ]?\s*N\s*H\s*[\s:._-]*\d+\b/im,
    /(?:^|\n)\s*HÌN\s*H\s*\d+\b/im,
    /(?:^|\n)\s*HIN\s*H\s*\d+\b/im,
    /(?:^|\n)\s*HÌNH\s*\d+\b/im,
    /(?:^|\n)\s*HINH\s*\d+\b/im,
    /(?:^|\n)\s*FIG(?:URE)?\.?\s*\d+\b/im,
    /(?:^|\n)\s*(?:MÔ TẢ HÌNH VẼ|BẢN VẼ|DRAWINGS?)\b/im
  ];

  let cut=t.length;
  for(const re of stops){
    const mm=t.match(re);
    if(mm && mm.index>80) cut=Math.min(cut,mm.index);
  }
  t=t.slice(0,cut);

  // Secondary defense when OCR misses the figure heading entirely.
  t=trimDiagramNoise(t);

  t=t.replace(/\n\s*\d{2,8}\s+\d{1,3}\s*\/\s*\d{1,3}\s*$/g,"");
  t=t.replace(/\n\s*\d{1,4}\s*$/g,"");
  return t.trim().normalize("NFC");
}

function looksLikeLegacyEncoding(text){
  const t=String(text||"");
  return /(?:ñaêng|kyù|ñieàu|phöông|vaên|höôùng|ñöôïc|baèng|caùch|saûn|xuaát)/i.test(t)
    || (t.match(/[�□■]/g)||[]).length>=2;
}

function vnOcrQuality(text){
  const t=truncateClaimAtFigure(text||"");
  if(!t) return 0;
  let score=textLayerQualityScore(t);

  const f=foldVN(t).toLowerCase();
  const patentWords=[
    "quy trinh","phuong phap","yeu cau bao ho","bao gom","trong do",
    "tinh dau","dung dich","hon hop","dong nhat","thiet bi","khuay"
  ];
  for(const w of patentWords) if(f.includes(w)) score+=5;

  score-=Math.min(30,(t.match(/\b(?:tỉnh dầu|tính dầu|dung địch|hồn hợp)\b/gi)||[]).length*6);
  score-=Math.min(30,(t.match(/\d+\s*\/\s*\d+/g)||[]).length*5);
  if(/(?:^|\n)\s*(?:HÌNH|HINH|FIGURE|FIG\.)\s*\d+/im.test(t)) score-=45;
  if(looksLikeLegacyEncoding(t)) score-=35;

  return Math.max(0,Math.min(100,Math.round(score)));
}

function renderTessDiag(){
  const el=$("tessDiag");
  if(!el) return;
  const d=state.tessDiag||{};
  const lang=`Ngôn ngữ tài liệu: <strong>${languageLabel(state.docLang)}</strong>${state.docLangConfidence?` (${Math.round(state.docLangConfidence*100)}%)`:""}`;

  if(d.error){
    el.innerHTML=`${lang}<br><span class="backend-bad">OCR language pack lỗi:</span> ${esc(d.error)}`;
    return;
  }
  const vie=d.vie?"✓ vie.traineddata":"… vie.traineddata";
  const eng=d.eng?"✓ eng.traineddata":"… eng.traineddata";
  el.innerHTML=`${lang}<br>Tesseract.js 5.1.1 · adaptive language mode · ${vie} · ${eng} · Unicode NFC`;
}

function cleanMetaValue(s){
  let t=stripPdfArtifacts(s)
    .replace(/^\s*[\(\[]?\d{2}[\)\]]?\s*/,"")
    .replace(/\s+/g," ")
    .trim();
  return t;
}

function sanitizePatentTitle(s){
  let t=cleanMetaValue(s)
    .replace(/\b(?:Page|Trang)\s+\d+(?:\/\d+)?\b/gi,"")
    .replace(/(?:\b\d{3,10}\s+\d{1,3}\/\d{1,3}\b\s*)+/g,"")
    .replace(/\s+/g," ")
    .trim();

  // Reject obviously polluted titles rather than poisoning search.
  const slash=(t.match(/\d+\s*\/\s*\d+/g)||[]).length;
  const digitRatio=(t.match(/\d/g)||[]).length/Math.max(1,t.length);
  if(slash>=2 || digitRatio>.30) return "";
  return t.slice(0,260);
}

function canvasToBase64Jpeg(canvas,quality=.9){
  return new Promise((resolve,reject)=>{
    canvas.toBlob(async blob=>{
      if(!blob) return reject(new Error("Không tạo được ảnh OCR."));
      const buf=await blob.arrayBuffer();
      const bytes=new Uint8Array(buf);
      let bin="";
      const chunk=0x8000;
      for(let i=0;i<bytes.length;i+=chunk){
        bin+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));
      }
      resolve(btoa(bin));
    },"image/jpeg",quality);
  });
}

async function cloudVisionOcr(canvas){
  if(isConfidentialMode()) return null;

  if(state.cloudOcr===false) return null;
  try{
    const image_base64=await canvasToBase64Jpeg(canvas,.92);
    const r=await fetch("/api/ocr",{
      method:"POST",
      headers:apiHeaders({"content-type":"application/json"}),
      body:JSON.stringify({image_base64})
    });
    const d=await r.json().catch(()=>({}));
    if(r.status===501 || d.code==="VISION_NOT_CONFIGURED"){
      state.cloudOcr=false;
      return null;
    }
    if(!r.ok || !d.ok) throw new Error(d.error||("OCR HTTP "+r.status));
    state.cloudOcr=true;
    return {
      text:normalizeOcrText(d.text||""),
      languages:Array.isArray(d.languages)?d.languages:[]
    };
  }catch(e){
    console.warn("Cloud OCR fallback:",e);
    return null;
  }
}

function formatClaimForDisplay(s){
  const lang=detectTextLanguage(s||"").lang;
  const t=truncateClaimAtFigure(applyLanguageSpecificCleanup(s,lang),lang)
    .replace(/\s*(\([ivxlcdm]+\))\s*/ig,"\n$1 ")
    .replace(/\s+(và)\s+(?=\([ivxlcdm]+\))/ig,"\n$1 ");
  return t.trim();
}


function renderProcess(){
  $("process").innerHTML=STEPS.map((s,i)=>`<div class="process-item ${i===state.step?"active":i<state.step?"done":""}"><span class="n">${i<state.step?"✓":i+1}</span><span>${s.title}</span></div>`).join("");
}

const STEP_COACH=[
  ["Đang làm gì?", "Chọn loại hồ sơ rồi tải PDF; hệ thống tự đọc và điền thông tin nhận diện được.", "Không có claim? Có thể chuẩn bị ý tưởng tìm kiếm, nhưng chưa chạy đánh giá đầy đủ. Đơn công bố và bằng đã cấp là hai phiên bản khác nhau."],
  ["Đang làm gì?", "Kiểm tra chữ lấy từ PDF và chọn đúng câu cần phân tích.", "Nếu scan sai chữ, dừng và sửa. Không đem chữ OCR bị lỗi đi tìm kiếm."],
  ["Đang làm gì?", "Chẻ câu đã chọn thành các đặc điểm nhỏ, không bỏ sót số liệu hay thứ tự.", "Đặc điểm do máy gợi ý phải được người làm hồ sơ xác nhận."],
  ["Đang làm gì?", "Thêm những cách nói khác của mỗi đặc điểm; giữ từ đúng nghĩa kỹ thuật.", "Tách quá nhỏ sẽ sinh kết quả nhiễu. Từ tiếng nước ngoài chưa xác minh phải được đánh dấu là gợi ý."],
  ["Đang làm gì?", "Tìm tài liệu, đọc kết quả và chọn những tài liệu đáng kiểm tra sâu.", "Đường dẫn WIPO/EPO là liên kết kiểm tra, không có nghĩa app đã kết nối API. Chưa tìm thấy không đồng nghĩa với chắc chắn mới."],
  ["Đang làm gì?", "Đặt một đặc điểm cạnh đúng đoạn trong MỘT tài liệu, rồi cho chuyên gia xác nhận.", "Ưu tiên đọc không phải kết luận tính mới; phải có nguyên văn, trang/đoạn và nguồn gốc để xác nhận."],
  ["Đang làm gì?", "Tổng hợp bằng chứng đã xác minh theo từng yêu cầu bảo hộ.", "Đánh giá tính mới không được cộng D1 và D2 thành một tài liệu; phân tích trình độ sáng tạo cần lý do kỹ thuật, không chỉ ghép đặc điểm."],
  ["Đang làm gì?", "Chuyên gia kiểm tra và ghi ý kiến, sửa hoặc đề xuất tìm tiếp.", "Không có chữ ký/xác nhận chuyên gia thì kết quả chỉ là dự thảo của hệ thống."],
  ["Đang làm gì?", "Xuất báo cáo có nguồn, câu đã phân tích và những chỗ chưa đủ chứng cứ.", "Báo cáo không phải ý kiến pháp lý cuối cùng hoặc xác suất được cấp bằng."]
];
function renderStepCoach(){
  const root=$("stepCoach");if(!root)return;
  const [heading,doNow,caution]=STEP_COACH[state.step];
  root.innerHTML=`<span class="step-coach-number">${String(state.step+1).padStart(2,"0")}</span><div class="coach-content"><strong>${esc(doNow)}</strong><details class="coach-extra"><summary>Lưu ý</summary><small>${esc(caution)}</small></details></div>`;
}
const WALKTHROUGH={
 draft:{
  title:"Tình huống ① — IP GROUP nhận dự thảo của khách hàng",
  intro:"Ví dụ giả lập: khách hàng mô tả ‘tách sợi trúc → xoáy → đưa vào dung dịch’. Chưa có văn bằng và không cần tạo số bằng giả.",
  steps:[
   ["Nhận hồ sơ", "Nhập mô tả và yêu cầu bảo hộ khách hàng đã soạn. Nếu chỉ có mô tả: dừng ở chuẩn bị tra cứu, nhờ người có chuyên môn soạn claim trước khi đánh giá chính thức."],
   ["Chẻ nhỏ", "F01: sợi trúc; F02: tách sợi; F03: xoáy; F04: đưa vào dung dịch; F05: thứ tự F02 → F03 → F04. Kiểm tra điều kiện thời gian, tỷ lệ nếu có."],
   ["Tìm nhiều cách", "‘bamboo fibre’, ‘separated bamboo strips’, ‘mechanically twisted’, ‘immersed in solution’… Chỉ gửi từ khóa đã được người dùng cho phép."],
   ["Chọn tài liệu", "Tìm và mở tài liệu công khai, kiểm tra ngày công bố. ‘D1’ chỉ là tên đặt cho tài liệu được chọn — chưa khẳng định là đối chứng gần nhất."],
   ["Đặt bằng chứng cạnh nhau", "Claim: ‘sợi trúc được xoáy SAU KHI tách’; đoạn nguồn giả định: ‘bamboo strips are twisted’. Cùng chủ đề nhưng thiếu điều kiện ‘sau khi tách’ → không xác nhận đủ dấu hiệu."],
   ["Chuyên gia phản hồi", "Nếu bác bỏ nhận định: chọn lý do ‘thiếu thứ tự thao tác’, ghi chỗ thiếu, chọn ‘Mở rộng từ khóa’ và tra cứu vòng tiếp theo. Không tự huấn luyện lại model."],
   ["Đầu ra", "Báo cáo: đã tìm những gì, thấy những đoạn nào, còn thiếu gì, và chuyên gia đề xuất bước tiếp. Không cấp chứng nhận ‘có tính mới’."],
  ],
  warning:"Với hồ sơ chưa nộp, phải có quyền xử lý và chỉ gửi truy vấn kỹ thuật ra ngoài khi được cho phép. Không đưa hồ sơ mật vào bản nghiên cứu chưa kiểm toán bảo mật."
 },
 published:{
  title:"Tình huống ② — Kiểm thử với đơn đã công bố",
  intro:"Ví dụ giả lập: bạn tải một đơn sáng chế đã công bố, chưa rõ đã được cấp bằng hay chưa. Có thể dùng phần yêu cầu bảo hộ công khai để thử hệ thống mà không cần hồ sơ khách hàng thật.",
  steps:[
   ["Nạp tài liệu", "Chọn Kiểm thử tài liệu công khai rồi tải PDF. Máy thử điền số công bố và tách claims; kiểm tra phiên bản ở Bước 2, nguồn/ngày trước khi tổng hợp nhận định."],
   ["Chọn câu", "Đọc nguyên văn yêu cầu bảo hộ trong bản công bố; chọn một claim, kiểm tra ngày nộp/ưu tiên với chuyên gia. Không nhìn trước kết quả cấp bằng để định hướng tra cứu."],
   ["Tách và mở rộng", "Giữ đủ vật liệu, cấu trúc, số liệu, trình tự; tìm thuật ngữ rộng/hẹp và các ngôn ngữ được xác minh."],
   ["Tìm đối chứng", "Lưu lịch sử truy vấn thành công/thất bại; loại chính tài liệu mục tiêu ra khỏi đối chứng thông thường; đọc nguồn và kiểm tra ngày công bố."],
   ["So sánh", "Ghi từng đặc điểm ↔ đúng đoạn, trang, tài liệu; phân biệt ‘chưa thấy’ và ‘đã xác minh không được bộc lộ’."],
   ["Chuyên gia phản hồi", "Chuyên gia đồng ý/bác bỏ từng hàng, ghi lý do và chọn tìm tiếp. Không để việc đơn đã được cấp bằng trở thành nhãn ‘đúng’ của AI."],
   ["Kiểm thử", "Đối chiếu với hồ sơ tra cứu/thẩm định công khai nếu có và nhận xét chuyên gia; ghi rõ những phần chưa thể kiểm chứng."],
  ],
  warning:"‘Đơn đã công bố’ không có nghĩa là ‘chưa được cấp’ ở thời điểm hiện tại. Kiểm tra trạng thái thật khi cần; đừng sử dụng kết quả cấp bằng làm bằng chứng duy nhất về tính mới."
 }
};
let walkthroughMode="draft";
function renderWalkthrough(){
 const w=WALKTHROUGH[walkthroughMode],root=$("walkthroughContent");if(!root)return;
 root.innerHTML=`<h3>${esc(w.title)}</h3><p class="walkthrough-intro">${esc(w.intro)}</p><ol class="walkthrough-steps">${w.steps.map(([title,body])=>`<li><strong>${esc(title)}</strong><span>${esc(body)}</span></li>`).join("")}</ol><div class="walkthrough-warning">⚠ ${esc(w.warning)}</div>`;
 document.querySelectorAll('[data-walkthrough]').forEach(b=>{const active=b.dataset.walkthrough===walkthroughMode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
}
if($("walkthrough")){
 document.querySelectorAll('[data-walkthrough]').forEach(b=>b.onclick=()=>{walkthroughMode=b.dataset.walkthrough;renderWalkthrough();});
 $("startWalkthrough").onclick=()=>{
   if(walkthroughMode==="draft"){
     applyGuidedMode("prospective");applyProspectiveClaimState("yes");
   }else{applyGuidedMode("retrospective");applyDocumentVersion("published");}
   $("walkthrough").open=false;showStep(0);
   $("dataWorkspace")?.scrollIntoView({block:"start",behavior:"smooth"});
 };
 $("closeWalkthrough").onclick=()=>{$("walkthrough").open=false;};
 renderWalkthrough();
}

function showStep(i){
  state.step=Math.max(0,Math.min(STEPS.length-1,i));
  document.querySelectorAll(".section").forEach(x=>x.classList.remove("active"));
  $(STEPS[state.step].id).classList.add("active");
  $("pageTitle").textContent=STEPS[state.step].title;
  if($("stepEyebrow"))$("stepEyebrow").textContent=`BƯỚC ${String(state.step+1).padStart(2,"0")} / ${String(STEPS.length).padStart(2,"0")}`;
  $("pageSub").textContent=STEPS[state.step].hint;
  $("wizardTitle").textContent=`Bước ${state.step+1}/${STEPS.length} · ${STEPS[state.step].title}`;
  $("wizardHint").textContent=STEPS[state.step].hint;
  $("backBtn").style.visibility=state.step===0?"hidden":"visible";
  $("nextBtn").textContent=state.step===STEPS.length-1?"Hoàn tất":"Tiếp tục →";
  renderProcess();
  renderStepCoach();
  renderPipelineAudit();
  if(STEPS[state.step].id==="search"){
    refreshTopicRouting();
    if((state.features.length||state.topicRouting?.topics?.length)&&!state.queries.length){state.search=buildProSearchRows();state.queries=buildProQueries(state.search);renderSearch();}
    if($('autoFeatureOverview'))$('autoFeatureOverview').setAttribute('data-feature-count',String(state.features.length));
    renderFacetEditor();
  }
  if(STEPS[state.step].id==="compare")renderPerClaimResults();
  if(STEPS[state.step].id==="prior"){
    renderPlanPreview();
    if(!$("liveSearchQuery").value) useGeneratedQuery();
    updateOfficialSearchLinks($("liveSearchQuery").value);
  }
  if(STEPS[state.step].id==="assess"){
    if($('assessmentClaim')){
      const selector=$('assessmentClaim'),old=selector.value;
      selector.innerHTML='<option value="">— Chuyên gia chọn khi cần phân tích sâu —</option>'+(state.claims||[]).map(c=>`<option value="${c.id}">Claim ${c.id} · ${esc(c.type)}</option>`).join('');
      selector.value=state.claims.some(c=>String(c.id)===String(old))?old:'';
    }
    if($("assessmentInputDoc"))$("assessmentInputDoc").value=$("patentNo")?.value||$("title")?.value||"";
    if($("assessmentRelevantDate"))$("assessmentRelevantDate").value=selectedClaimRelevantDate();
    renderReadiness();
    readPrior();
    if(state.matrix.length){
      refreshClosestOptions();
      if($("assessmentClaim")?.value&&$("closest")?.value)syncAssessmentFields({slot:$("closest").value});
      else if($("assessmentSource"))$("assessmentSource").textContent="Chuyên gia chọn tài liệu đối chứng gần nhất và ghi lý do trước khi phân tích trình độ sáng tạo.";
    }else{
      refreshClosestOptions();
      if($("assessmentSource")) $("assessmentSource").textContent="Chưa có ma trận. Hãy quay lại bước 6 và tạo ma trận đối chiếu.";
    }
  }
  scrollTo({top:0,behavior:"smooth"});
}
function cleanClaimsAreCurrent(){
 const box=$('claimsClean');return !box || !state.claimsText || box.value===formatClaimForDisplay(state.claimsText);
}
function validateBeforeNext(){
  if(state.step===0){
    if(state.pdfLoading){alert('Máy đang xử lý PDF/OCR. Vui lòng đợi quá trình đọc hoàn tất.');return false;}
    if(!['patentability','pilot'].includes($('purposeChoice')?.value||'')){alert('Hãy chọn Chuẩn bị đăng ký hoặc Kiểm thử tài liệu công khai.');return false;}
    if(!state.pdf && !(state.claimsText||'').trim()){alert('Hãy tải PDF hoặc dán nội dung rồi bấm Sử dụng văn bản.');return false;}
  }
  if(state.step===1 && !cleanClaimsAreCurrent()){alert("Đã sửa claims nhưng chưa tách lại; hãy bấm Tách lại claims trước khi tiếp tục.");return false;}
  if(state.step===1 && !state.claims.length){alert("Máy chưa tách được claims. Hãy kiểm tra văn bản, sửa và bấm Tách lại claims; nếu chỉ có mô tả, cần chuyên gia chuẩn bị bản yêu cầu bảo hộ trước khi phân tích từng claim.");return false}
  // Người dùng không phải tích xác nhận ở bước 2. Trước khi chốt nhận định, chuyên gia rà soát đầu vào ở bước 6.
  if(state.step===2 && !state.features.length){alert("Máy chưa tách được đặc điểm nào; cần kiểm tra chất lượng bản claims ở bước trước.");return false}
  if(state.step===4 && state.keywordOnly){alert('Đây mới là khảo sát theo keyword. Để lập ma trận và đánh giá từng claim, hãy tải hồ sơ có claims hoặc nhờ chuyên gia chuẩn bị claims.');return false;}
  // Máy tự tách tất cả claims để lập kế hoạch tìm; chuyên gia chỉ khóa bộ đặc điểm trước nhận định ở bước so sánh.
  if(state.step===4){readPrior();if(!Object.values(state.prior).some(x=>x.no)){return confirm("Chưa có tài liệu đối chứng. Bạn vẫn muốn tiếp tục?")}}
  return true
}
$("backBtn").onclick=()=>showStep(state.step-1);
$("nextBtn").onclick=()=>{if(state.step===STEPS.length-1){$("genReport").click();return}if(validateBeforeNext())showStep(state.step+1)};
if($("rescanMeta")) $("rescanMeta").onclick=async()=>{try{await rescanMetadataFromLoadedPdf(false)}catch(e){if($('metaStatus'))$('metaStatus').textContent='Dò metadata gặp lỗi: '+String(e.message||e)}};
if($('ocrAuditBtn'))$('ocrAuditBtn').onclick=()=>auditAllInputPages();
if($('ocrAuditStop'))$('ocrAuditStop').onclick=()=>{state.auditStop=true;$('pdfStatus').textContent='Đang dừng OCR sau trang hiện tại; các trang chưa đọc vẫn được ghi nhận.';};
const REQUIRED_UI_IDS=["pdfInput","dropZone","pdfStatus","progressBar","patentNo","title","filingDate","applicant","representative","ipc","abstract","claimsRaw","claimsClean"];
const missingUI=REQUIRED_UI_IDS.filter(id=>!$(id));
if(missingUI.length) console.error("PatentLens UI missing IDs:",missingUI);
updateMetadataLabels();
setupResearchInput();
if($("assessmentRelevantDate"))$("assessmentRelevantDate").addEventListener("change",()=>{if($("relevantDate"))$("relevantDate").value=$("assessmentRelevantDate").value;syncRelevantDate();renderReadiness();});
if($("relevantDate"))$("relevantDate").addEventListener("change",renderInputGate);
if($("filingDate"))$("filingDate").addEventListener("change",renderInputGate);
if($("claimsClean"))$("claimsClean").addEventListener("input",()=>{if($("ocrReviewConfirmed"))$("ocrReviewConfirmed").checked=false;if($("manualReviewConfirmed"))$("manualReviewConfirmed").checked=false;});
if($("patentNo"))$("patentNo").addEventListener("input",()=>{renderCandidates();renderInputGate()});

if($("confidentialMode")){state.confidentialMode=true;$("confidentialMode").onchange=()=>{updatePrivacyStatus();};updatePrivacyStatus()}
if($("filingDate"))$("filingDate").addEventListener("change",()=>{syncRelevantDate();renderReadiness()});
if($("relevantDate"))$("relevantDate").addEventListener("change",()=>{renderCandidates();renderReadiness()});
showStep(0);setTimeout(updateFeatureReviewUI,0);
if(location.protocol==="file:") $("localBanner").style.display="block";

function setDetect(id,ok,text){let el=$(id);el.className="detect-card "+(ok?"ok":"warn");el.querySelector("span").textContent=text}
function normDate(v){if(!v)return"";let m=v.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);if(m)return `${m[3]}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`;let d=new Date(v);return isNaN(d)?"":d.toISOString().slice(0,10)}
function firstMatch(text,patterns){for(const p of patterns){const m=text.match(p);if(m&&m[1])return clean(m[1])}return""}

async function getPdfLib(){
 if(!window.pdfjsLib) throw new Error("PDF.js chưa tải được từ CDN.");
 pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
 return window.pdfjsLib;
}
// PDF extraction: prioritize preview pages. For long documents, release the UI after
// the first/last pages and continue every other page in a cancellable background pass.
// This is a PREVIEW, not a claim that the full PDF has been read.
async function readPdf(file){
  const pdfjs=await getPdfLib();
  if(file.size > 120*1024*1024) throw new Error("PDF vượt 120 MB; hãy chia PDF bằng công cụ tin cậy hoặc dùng máy có nhiều bộ nhớ. Không tải dữ liệu lên dịch vụ ngoài tự động.");
  const input=await file.arrayBuffer();
  // Hash is optional for large files to avoid an extra full-buffer operation on memory-limited browsers.
  // A hash proves file identity only; it does NOT prove OCR completeness or claim correctness.
  let sha256="";
  if(input.byteLength <= 32*1024*1024 && globalThis.crypto?.subtle){
    try{const digest=await globalThis.crypto.subtle.digest("SHA-256",input);
      sha256=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
    }catch(e){console.warn("Document SHA-256 unavailable",e)}
  }
  const pdf=await withTimeout(pdfjs.getDocument({data:input}).promise,45000,"Mở PDF");
  state.documentAudit={name:file.name||"PDF",size:file.size,pages:pdf.numPages,sha256,
    hashStatus:sha256?"SHA-256 cục bộ":"Chưa có SHA-256: file lớn hoặc thiết bị không hỗ trợ; không dùng mã này để khẳng định nguồn gốc",sourceVerified:false};
  state.pdf=pdf;
  state.pdfFileName=file.name||"PDF";
  state.pageText=Array(pdf.numPages).fill("");
  state.pageColumnText=Array(pdf.numPages).fill("");
  state.pageQuality=Array(pdf.numPages).fill(0);
  state.pageTextScanDone=Array(pdf.numPages).fill(false);
  state.pdfTextErrors={};
  state.badTextPages=[];
  state.inputScanAudit=null;
  // Each item belongs to the nearest Y row. The earlier rows.find(...) scanned
  // every prior row for every token: pathological on dense PDF text layers.
  function itemsToLines(items){
    if(!items.length)return "";
    const heights=items.map(x=>Math.abs(x.h||10)).filter(Boolean).sort((a,b)=>a-b);
    const medianH=heights[Math.floor(heights.length/2)]||10;
    const tol=Math.max(2.2,Math.min(5,medianH*.38));
    const rows=[];
    const sorted=items.slice().sort((a,b)=>b.y-a.y||a.x-b.x);
    for(const it of sorted){
      let row=rows.length?rows[rows.length-1]:null;
      if(!row||Math.abs(row.y-it.y)>tol){row={y:it.y,items:[]};rows.push(row);}
      row.items.push(it);
    }
    return rows.map(r=>{
      const xs=r.items.sort((a,b)=>a.x-b.x);
      let out="",prev=null;
      for(const it of xs){
        const t=String(it.s||"");if(!t)continue;
        if(prev){
          const gap=it.x-(prev.x+prev.w);
          if(gap>Math.max(1.5,(prev.h||10)*.12)&&!/[\s\-\/]$/.test(out)&&!/^[,.;:%\)]/.test(t))out+=" ";
        }
        out+=t;prev=it;
      }
      return out.trim();
    }).filter(Boolean).join("\n");
  }
  async function scanPage(pageNo){
    if(state.pdf!==pdf)return false;
    let page;
    try{
      page=await withTimeout(pdf.getPage(pageNo),20000,`Mở trang ${pageNo}`);
      const viewport=page.getViewport({scale:1});
      const content=await withTimeout(page.getTextContent({disableNormalization:false}),25000,`Đọc chữ trang ${pageNo}`);
      if(state.pdf!==pdf)return false;
      const items=content.items.filter(x=>x&&typeof x.str==="string"&&x.str.trim()).map(x=>({
        s:x.str.normalize("NFC"),x:x.transform[4],y:x.transform[5],
        w:Number(x.width)||0,h:Number(x.height)||Math.abs(x.transform[3])||10
      }));
      const direct=stripPdfArtifacts(itemsToLines(items));
      const mid=viewport.width/2;
      state.pageText[pageNo-1]=direct;
      state.pageColumnText[pageNo-1]=stripPdfArtifacts(itemsToLines(items.filter(x=>x.x<mid)))+"\n"+
        stripPdfArtifacts(itemsToLines(items.filter(x=>x.x>=mid)));
      const q=textLayerQualityScore(direct);
      state.pageQuality[pageNo-1]=q;
      if(q<48&&!state.badTextPages.includes(pageNo))state.badTextPages.push(pageNo);
      state.pageTextScanDone[pageNo-1]=true;
      delete state.pdfTextErrors[pageNo];
      return true;
    }catch(e){
      if(state.pdf!==pdf)return false;
      state.pageText[pageNo-1]="";state.pageColumnText[pageNo-1]="";
      state.pageQuality[pageNo-1]=0;
      state.pageTextScanDone[pageNo-1]=true; // attempted and failed; remains pending for OCR/expert.
      state.pdfTextErrors[pageNo]=String(e&&e.message||e);
      if(!state.badTextPages.includes(pageNo))state.badTextPages.push(pageNo);
      console.warn("PDF text layer page",pageNo,e);
      return false;
    }finally{try{page&&page.cleanup()}catch(_e){}}
  }
  const initial=pdf.numPages>24
    ?[...new Set([1,2,3,4,...Array.from({length:Math.min(9,pdf.numPages)},(_,i)=>pdf.numPages-i)])].sort((a,b)=>a-b)
    :Array.from({length:pdf.numPages},(_,i)=>i+1);
  for(let i=0;i<initial.length;i++){
    const p=initial[i];
    $("pdfStatus").textContent=`Đang đọc xem trước PDF: trang ${p}/${pdf.numPages} (${i+1}/${initial.length})`;
    await scanPage(p);
    $("progressBar").style.width=Math.round((i+1)/initial.length*68)+"%";
    await sleep(0);
  }
  state.pdfPendingTextPages=Array.from({length:pdf.numPages},(_,i)=>i+1).filter(p=>!state.pageTextScanDone[p-1]);
  state.pdfScanPage=scanPage;
  chooseDocumentLanguage();
  return pdf;
}

// Read all remaining text-layer pages without blocking navigation. A page failure
// is recorded, not silently skipped. Do not overwrite claims the user has edited.
async function scanRemainingPdfText(pdf,generation){
  const pending=[...(state.pdfPendingTextPages||[])];
  if(!pending.length)return;
  state.pdfTextScanBusy=true;
  const status=$("pdfStatus"), bar=$("progressBar");
  let processed=0;
  try{
    for(const p of pending){
      if(state.pdf!==pdf||generation!==state.uploadGeneration)return;
      await state.pdfScanPage(p);
      processed++;
      if(processed===1||processed%2===0||processed===pending.length){
        status.textContent=`Đang đọc tiếp PDF ${state.pdfFileName}: ${state.pageTextScanDone.filter(Boolean).length}/${pdf.numPages} trang lớp chữ; bạn có thể xem claims ở Bước 2.`;
        bar.style.width=Math.min(98,68+Math.round(processed/pending.length*30))+"%";
        makeInputScanAudit();
      }
      await sleep(0);
    }
    if(state.pdf!==pdf||generation!==state.uploadGeneration)return;
    state.rawText=mergedText();
    // Do not clobber edited claims with background extraction.
    if(!state.claims.length&&!String($("claimsClean")?.value||"").trim()){
      let c="";try{c=candidateClaimsText()}catch(e){console.warn("Background claims",e)}
      if(c&&claimCandidateScore(c)>=45){
        state.claimsText=truncateClaimAtFigure(stripPdfArtifacts(c));
        $("claimsRaw").value=state.claimsText;
        $("claimsClean").value=formatClaimForDisplay(state.claimsText);
        state.claims=parseClaims(state.claimsText);
        state.claimCoverage=claimNumberingAudit(state.claims,state.claimsText);
        state.selected=0;renderClaims();renderInputGate();
        setDetect("detClaims",state.claims.length>0,`Đã nhận diện ${state.claims.length} claim từ chữ trong PDF`);
      }
    }
    makeInputScanAudit();
    const audit=state.inputScanAudit;
    status.textContent=audit.pending.length
      ?`Đã thử đọc lớp chữ ${pdf.numPages} trang; ${audit.pending.length} trang còn thiếu/khó đọc, cần OCR bổ sung. Không được dùng kết quả như đã đọc đủ.`
      :`Đã thử đọc chữ ${pdf.numPages} trang; cần kiểm tra hình vẽ và bản gốc.`;
    bar.style.width="100%";
    renderInputGate();renderReadiness();refreshTopicRouting();
  }catch(e){
    console.error("Background PDF scan",e);
    status.textContent="Quét PDF chưa hoàn tất: "+String(e.message||e);
  }finally{
    if(state.pdf===pdf&&generation===state.uploadGeneration){
      state.pdfTextScanBusy=false;
      makeInputScanAudit();renderInputGate();renderReadiness();
    }
  }
}

// Phase 1 is fast and non-destructive: every page's embedded text is read first.
// Image-only/weak pages remain PENDING until the user runs optional, page-by-page OCR.
function makeInputScanAudit(){
  if(!state.pdf)return null;
  const pending=[],total=state.pdf.numPages;
  for(let p=1;p<=total;p++){
    const direct=String(state.pageText[p-1]||'');
    const q=Number(state.pageQuality[p-1]||0);
    const ocr=String(state.ocrPages[p]||'');
    if((direct.trim().length<25||q<48)&&ocr.trim().length<25)pending.push(p);
  }
  const unscanned=Array.from({length:total},(_,i)=>i+1).filter(p=>!state.pageTextScanDone?.[p-1]);
  const existing=state.inputScanAudit||{};
  state.inputScanAudit={pages:total,ocrNeeded:pending.length+Object.values(state.ocrPages).filter(x=>String(x||'').trim().length>=25).length,
    ocrCompleted:Object.values(state.ocrPages).filter(x=>String(x||'').trim().length>=25).length,
    pending,unscanned,unread:(existing.unread||[]).filter(x=>pending.includes(x)),
    visualsReviewed:false,checkedAt:new Date().toISOString(),
    complete:pending.length===0&&unscanned.length===0&&!existing.cancelled,cancelled:false};
  renderPdfAuditStatus();return state.inputScanAudit;
}
function renderPdfAuditStatus(){
  const audit=state.inputScanAudit;if(!audit)return;
  const left=audit.pending?.length||0;
  const b=$('ocrAuditBtn'),stop=$('ocrAuditStop'),status=$('ocrAuditStatus');
  if(b){b.hidden=left===0;b.disabled=!!state.inputAuditBusy||!!state.claimOcrBusy||!!state.pdfTextScanBusy;b.textContent=left?(state.pdfTextScanBusy?`Đang quét chữ, còn ${audit.unscanned?.length||0} trang`: `Đọc bổ sung ${left} trang cần OCR`): 'Đã xử lý xong chữ';}
  if(stop)stop.hidden=!state.inputAuditBusy;
  if(status)status.textContent=left
    ?`PDF ${audit.pages} trang: ${audit.unscanned?.length||0} trang đang/chưa quét lớp chữ; ${left-(audit.unscanned?.length||0)} trang thiếu/khó đọc cần OCR. Có thể xem claims nhưng chưa thể đưa ra nhận định đầy đủ.`
    :`Đã thử đọc chữ trên ${audit.pages} trang. Hình vẽ, bảng và công thức vẫn cần kiểm tra trên PDF gốc.`;
}
async function auditAllInputPages(){
  if(!state.pdf||state.inputAuditBusy)return;
  if(state.pdfTextScanBusy){$("pdfStatus").textContent="Vẫn đang đọc lớp chữ các trang còn lại. Đợi xong rồi chạy OCR bổ sung để tránh hai tác vụ nặng cùng lúc.";return;}
  if(state.claimOcrBusy){$('pdfStatus').textContent='Đang thử OCR claims. Đợi lượt này xong rồi bấm Đọc bổ sung để tránh chạy hai OCR đồng thời.';return;}
  let audit=makeInputScanAudit();if(!audit?.pending?.length)return;
  state.inputAuditBusy=true;state.auditStop=false;
  const currentPdf=state.pdf;
  renderPdfAuditStatus();let scanned=0;
  try{
    for(const p of [...audit.pending]){
      if(state.auditStop||state.pdf!==currentPdf)break;
      $('pdfStatus').textContent=`OCR bổ sung: trang ${p}/${audit.pages} · lượt ${scanned+1}/${audit.pending.length}. Có thể bấm Dừng.`;
      const ok=await ocrSelectedPages([p],'OCR toàn tài liệu');
      scanned++;
      const content=String(state.ocrPages[p]||'');
      if(!ok||content.trim().length<25){
        if(!audit.unread.includes(p))audit.unread.push(p);
        // Network/model error: don't repeatedly call a broken OCR provider across all pages.
        if(!ok){$('pdfStatus').textContent=`OCR bị lỗi tại trang ${p}. Đã dừng; trang chưa đọc vẫn được ghi nhận.`;break;}
      }else audit.unread=audit.unread.filter(x=>x!==p);
      audit.pending=audit.pending.filter(x=>x!==p || content.trim().length<25);
      state.rawText=mergedText();renderPdfAuditStatus();await sleep(0);
    }
  }finally{
    state.inputAuditBusy=false;
    if(state.pdf===currentPdf){
      makeInputScanAudit();const left=state.inputScanAudit.pending.length;
      $('pdfStatus').textContent=left
        ?`Đã thử OCR ${scanned} trang; còn ${left} trang chưa đọc chắc chắn. Xem ở Bước 2 hoặc bấm Đọc bổ sung để thử tiếp.`
        :`Đã kiểm tra chữ trên ${currentPdf.numPages} trang. Hình vẽ/bảng chưa được tự xác minh.`;
      if(!state.claims?.length){
        try{const c=candidateClaimsText();if(c){state.claimsText=c;$('claimsRaw').value=c;$('claimsClean').value=formatClaimForDisplay(c);state.claims=parseClaims(c);state.claimCoverage=claimNumberingAudit(state.claims,c);renderClaims();renderInputGate();}}
        catch(e){console.warn('Claims after OCR',e);}
      }
      renderPdfAuditStatus();renderReadiness();
    }
  }
}
function pdfCoverageReady(){
  if(!state.pdf)return true;
  const a=state.inputScanAudit;
  return !!(a&&a.pages===state.pdf.numPages&&a.complete===true&&!a.pending?.length&&!a.unread?.length);
}
function matrixCoverageReady(){
  return ['D1','D2','D3'].filter(k=>state.prior?.[k]?.text?.trim()).every(k=>{
    const rec=state.matrixScanAudit?.[k];return !!(rec?.complete&&rec.fingerprint===contentFingerprint(cleanPatentContent(state.prior[k].text)));
  });
}
function textQuality(){
  const chars=state.pageText.reduce((n,s)=>n+s.length,0);
  const good=state.pageQuality.filter(x=>x>=48).length;
  return {chars,avg:chars/Math.max(1,state.pageText.length),goodPages:good,badPages:state.badTextPages.length};
}

async function renderPageCanvas(pageNo,scale=1.75){
  const page=await state.pdf.getPage(pageNo),viewport=page.getViewport({scale});
  const canvas=document.createElement("canvas");canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  await page.render({canvasContext:canvas.getContext("2d"),viewport}).promise;return canvas;
}

function preprocessOcrCanvas(src){
  const out=document.createElement("canvas");
  out.width=src.width; out.height=src.height;
  const ctx=out.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(src,0,0);
  const img=ctx.getImageData(0,0,out.width,out.height);
  const d=img.data;

  // Histogram grayscale for robust threshold.
  const hist=new Array(256).fill(0);
  for(let i=0;i<d.length;i+=4){
    const g=Math.max(0,Math.min(255,Math.round(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])));
    hist[g]++;
  }
  let total=out.width*out.height,sum=0;
  for(let i=0;i<256;i++) sum+=i*hist[i];
  let sumB=0,wB=0,maxVar=0,thr=178;
  for(let t=0;t<256;t++){
    wB+=hist[t]; if(!wB) continue;
    const wF=total-wB; if(!wF) break;
    sumB+=t*hist[t];
    const mB=sumB/wB,mF=(sum-sumB)/wF;
    const v=wB*wF*(mB-mF)*(mB-mF);
    if(v>maxVar){maxVar=v;thr=t}
  }
  // Avoid overly aggressive threshold for pale scans.
  thr=Math.max(145,Math.min(205,thr+12));

  for(let i=0;i<d.length;i+=4){
    let g=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
    // contrast stretch before binarization
    g=(g-128)*1.22+128;
    const v=g<thr?0:255;
    d[i]=d[i+1]=d[i+2]=v;
    d[i+3]=255;
  }
  ctx.putImageData(img,0,0);
  return out;
}

function cropCanvasTop(src,ratio){
  ratio=Math.max(.45,Math.min(1,Number(ratio)||1));
  const out=document.createElement("canvas");
  out.width=src.width;
  out.height=Math.max(1,Math.round(src.height*ratio));
  out.getContext("2d").drawImage(src,0,0,src.width,out.height,0,0,src.width,out.height);
  return out;
}

function preferredOcrLanguages(pageNo){
  const mode=effectiveLanguageMode();

  if(mode==="vi") return ["vie"];
  if(mode==="en") return ["eng"];

  const page=state.languageByPage[pageNo];
  const pageLang=page&&page.lang?page.lang:"unknown";

  if(mode==="mixed"){
    if(pageLang==="vi") return ["vie"];
    if(pageLang==="en") return ["eng"];
    // Unknown page in mixed document: run separate models, never vie+eng together.
    return ["vie","eng"];
  }

  // Auto mode: page language first, then document language.
  if(pageLang==="vi") return ["vie"];
  if(pageLang==="en") return ["eng"];

  if(state.docLang==="vi") return ["vie"];
  if(state.docLang==="en") return ["eng"];

  // Unknown/mixed: compare separate OCR outputs; do not merge language models.
  return ["vie","eng"];
}

async function recognizeWithLang(worker,canvas,lang,psm){
  const langs=Array.isArray(lang)?lang:[lang];
  if(worker.__patentlensLang!==langs[0]){
    await withTimeout(worker.reinitialize(langs[0],1),12000,'Chuyển ngôn ngữ OCR');
    worker.__patentlensLang=langs[0];
  }
  await withTimeout(worker.setParameters({
    preserve_interword_spaces:"1",
    user_defined_dpi:"300",
    tessedit_pageseg_mode:String(psm)
  }),8000,'Cấu hình nhận diện OCR');
  const res=await withTimeout(
    worker.recognize(canvas),
    45000,
    `OCR ${langs.join("+")} PSM ${psm}`
  );
  return {
    text:(res&&res.data&&res.data.text)||"",
    confidence:Number(res&&res.data&&res.data.confidence)||0,
    lang:langs.join("+")
  };
}

function ocrQualityScore(text,confidence=0){
  const f=foldVN(text||"");
  let score=Number(confidence)||0;
  const patentWords=["YEU CAU BAO HO","QUY TRINH","PHUONG PHAP","BAO GOM","TRONG DO","SANG CHE","THIET BI","HE THONG","THANH PHAN"];
  for(const w of patentWords) if(f.includes(w)) score+=8;
  score+=Math.min(20,(text||"").length/250);
  // Penalize obvious OCR garbage.
  const weird=((text||"").match(/[|{}<>~^`]/g)||[]).length;
  score-=Math.min(20,weird*2);
  return score;
}


const sleep = ms => new Promise(r => setTimeout(r, ms));
function withTimeout(promise, ms, label){
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " quá thời gian")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let ocrWorkerPromise = null;
const ocrWorkers=new Map();
const TESS_CFG={
  workerPath:"https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js",
  corePath:"https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1",
  langPath:"https://cdn.jsdelivr.net/gh/naptha/tessdata@gh-pages/4.0.0"
};
// Initialize ONE language when required; no eager download of both language packs.
let tesseractLoadTask=null;
async function loadTesseractOnDemand(){
  if(window.Tesseract)return window.Tesseract;
  if(!tesseractLoadTask)tesseractLoadTask=withTimeout(new Promise((resolve,reject)=>{
    const script=document.createElement("script");
    script.src="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
    script.onload=()=>window.Tesseract?resolve(window.Tesseract):reject(new Error("Tesseract.js chưa khởi tạo"));
    script.onerror=()=>reject(new Error("Không tải được Tesseract.js từ CDN"));
    document.head.appendChild(script);
  }),25000,"Tải thư viện OCR").catch(e=>{tesseractLoadTask=null;throw e});
  return tesseractLoadTask;
}
async function getOcrWorker(reason='OCR',lang='vie'){
  await loadTesseractOnDemand();
  lang=lang==='eng'?'eng':'vie';
  if(ocrWorkers.has(lang))return ocrWorkers.get(lang);
  const OEM=(Tesseract.OEM&&Tesseract.OEM.LSTM_ONLY)||1;
  $('pdfStatus').textContent=`${reason}: khởi tạo OCR ${lang} (chỉ khi cần)...`;
  const task=withTimeout(Tesseract.createWorker(lang,OEM,{
    workerPath:TESS_CFG.workerPath,corePath:TESS_CFG.corePath,langPath:TESS_CFG.langPath,
    gzip:true,cacheMethod:'write',logger:m=>{
      if(!m)return;
      const phase=String(m.status||''),pct=Math.round((m.progress||0)*100);
      if(/loading language traineddata|initializing api/i.test(phase))$('pdfStatus').textContent=`${reason}: OCR ${lang} ${phase} ${pct}% · có giới hạn thời gian`;
      else if(phase==='recognizing text')$('pdfStatus').textContent=`${reason}: OCR ${lang} nhận diện chữ ${pct}%`;
    }
  }),30000,`Khởi tạo OCR ${lang}`)
    .then(async worker=>{
      worker.__patentlensLang=lang;
      await withTimeout(worker.setParameters({preserve_interword_spaces:'1',user_defined_dpi:'300'}),8000,`Cấu hình OCR ${lang}`);
      state.tessDiag[lang]=true;renderTessDiag();return worker;
    }).catch(err=>{ocrWorkers.delete(lang);state.tessDiag.error=String(err?.message||err);renderTessDiag();throw err;});
  ocrWorkers.set(lang,task);return task;
}
async function ocrSelectedPages(pageNos,reason="OCR",force=false){
  if(!state.pdf) return false;
  const originalPdf=state.pdf;
  try{
    let localWorker=null;
    let done=0;

    for(const p of pageNos){
      if(state.pdf!==originalPdf)return false;
      if(state.ocrPages[p]&&!force){done++;continue;}
      if(force) delete state.ocrPages[p];

      $("pdfStatus").textContent=`${reason}: trang ${p}...`;
      await sleep(20);

      const direct=state.pageText[p-1]||"";
      const directQ=state.pageQuality[p-1]||0;
      const directLang=detectTextLanguage(direct);
      const mode=effectiveLanguageMode();
      const target=
        mode==="vi"?"vi":
        mode==="en"?"en":
        (directLang.lang==="vi"||directLang.lang==="en"?directLang.lang:
          (state.docLang==="vi"||state.docLang==="en"?state.docLang:"unknown"));

      // Critical v15 rule:
      // Clean digital text layer is source-of-truth. Do NOT OCR/translate it again.
      if(
        direct.trim() &&
        directQ>=70 &&
        !looksLikeLegacyEncoding(direct) &&
        directLang.confidence>=.55 &&
        languageCompatible(directLang.lang,target)
      ){
        const kept=applyLanguageSpecificCleanup(direct,directLang.lang);
        if(state.pdf!==originalPdf)return false;
        state.ocrPages[p]=kept;
        state.languageByPage[p]=directLang;
        state.claimSourceByPage[p]={
          source:`PDF text layer · ${languageLabel(directLang.lang)} · OCR skipped`,
          score:languageSanityScore(kept,directLang.lang)
        };
        setDetect("detOCR",true,`Không OCR trang ${p} · giữ nguyên ${languageLabel(directLang.lang)}`);
        done++;
        $("progressBar").style.width=(45+Math.round(done/pageNos.length*50))+"%";
        continue;
      }

      const candidates=[];
      if(direct.trim()){
        const dl=directLang.lang;
        const normalized=applyLanguageSpecificCleanup(direct,dl);
        candidates.push({
          source:`PDF text layer · ${languageLabel(dl)}`,
          lang:dl,
          text:normalized,
          score:languageSanityScore(normalized,dl)+(directQ>=55?12:0)
        });
      }

      const fastScan=state.pdf.numPages>24 || reason==='OCR toàn tài liệu';
      const rawCanvas=await renderPageCanvas(p,fastScan?1.75:2.35);

      // Vision does OCR only; we NEVER translate its returned text.
      try{
        const cloud=await cloudVisionOcr(rawCanvas);
        if(cloud&&cloud.text&&cloud.text.length>20){
          let cloudLang="unknown";
          const top=cloud.languages&&cloud.languages[0];
          if(top?.languageCode){
            const lc=String(top.languageCode).toLowerCase();
            if(lc.startsWith("vi")) cloudLang="vi";
            else if(lc.startsWith("en")) cloudLang="en";
            state.visionLanguagesByPage[p]=cloud.languages;
          }
          if(cloudLang==="unknown") cloudLang=detectTextLanguage(cloud.text).lang;

          if(languageCompatible(cloudLang,target)){
            const ct=applyLanguageSpecificCleanup(cloud.text,cloudLang);
            candidates.push({
              source:`Google Vision OCR · ${languageLabel(cloudLang)}`,
              lang:cloudLang,
              text:ct,
              score:languageSanityScore(ct,cloudLang)+5
            });
          }
        }
      }catch(_e){}

      const preferred=preferredOcrLanguages(p);
      const langsToTry=fastScan?preferred.slice(0,1):preferred;
      // Never crop a page when auditing document-wide coverage.
      const canvases=fastScan?[{name:'full',canvas:rawCanvas}]:[
        {name:"full",canvas:rawCanvas},
        {name:"top82",canvas:cropCanvasTop(rawCanvas,.82)},
        {name:"top72",canvas:cropCanvasTop(rawCanvas,.72)}
      ];

      for(const lang of langsToTry){
        localWorker=await getOcrWorker(reason,lang);
        const targetLang=lang==="vie"?"vi":"en";
        for(const c of canvases){
          try{
            const psm=targetLang==="vi"?6:3;
            const rr=await recognizeWithLang(localWorker,c.canvas,lang,psm);
            if(!rr.text.trim()) continue;

            const detected=detectTextLanguage(rr.text);
            // A forced English scan must not accept a Vietnamese/mixed candidate, and vice versa.
            if(!languageCompatible(detected.lang,targetLang) && detected.confidence>.5) continue;
            if(!languageCompatible(targetLang,target) && target!=="unknown") continue;

            const cleanText=applyLanguageSpecificCleanup(rr.text,targetLang);
            let score=languageSanityScore(cleanText,targetLang);
            score+=Math.min(12,rr.confidence/8);
            if(c.name!=="full") score-=12; // Trang bị cắt là ứng viên dự phòng, không được ưu tiên khi đọc toàn tài liệu.
            if(detected.lang===targetLang) score+=12*detected.confidence;

            candidates.push({
              source:`Tesseract ${lang} · ${c.name} · PSM ${psm}`,
              lang:targetLang,
              text:cleanText,
              score
            });
          }catch(e){
            console.warn("OCR pass",lang,c.name,e);
          }
        }
      }

      const ranked=candidates
        .map(x=>({
          ...x,
          text:reason==='OCR toàn tài liệu'?x.text:truncateClaimAtFigure(x.text,x.lang),
          score:Number(x.score)||0
        }))
        .filter(x=>x.text.length>15)
        .sort((a,b)=>b.score-a.score);

      const best=ranked[0];
      if(state.pdf!==originalPdf)return false;
      if(best){
        state.ocrPages[p]=best.text;
        const det=detectTextLanguage(best.text);
        state.languageByPage[p]=det.lang==="unknown"?{lang:best.lang,confidence:.6}:det;
        state.claimSourceByPage[p]={source:best.source,score:best.score};
        setDetect("detOCR",true,`${best.source} · ${Math.round(best.score)}/100`);
      }else{
        state.ocrPages[p]="";
        setDetect("detOCR",false,`Trang ${p}: không có OCR đủ tin cậy`);
      }

      done++;
      $("progressBar").style.width=(45+Math.round(done/pageNos.length*50))+"%";
    }

    updateLanguageStatus();
    return true;
  }catch(e){
    console.error("OCR error",e);
    setDetect("detOCR",false,"OCR lỗi");
    $("pdfStatus").textContent="OCR không chạy được: "+String(e.message||e);
    return false;
  }
}

function hasClaimMarker(t){
  return !!claimMarkerInfo(t);
}

async function smartOcrClaims(auto=false){
  if(!state.pdf) return false;
  if(state.claimOcrBusy||state.inputAuditBusy)return false;
  state.claimOcrBusy=true;
  const originalPdf=state.pdf;
  const originalClaimsText=state.claimsText;
  try{return await smartOcrClaimsCore(auto,originalPdf,originalClaimsText)}
  finally{state.claimOcrBusy=false;}
}
async function smartOcrClaimsCore(auto,originalPdf,originalClaimsText){
  if(!state.pdf)return false;
  const obsolete=()=>state.pdf!==originalPdf || state.claimsText!==originalClaimsText;
  const n=state.pdf.numPages;
  // Claims của bằng VN thường nằm ngay trước phần hình vẽ.
  // Với PDF 14 trang của Điền Trúc, thứ tự này OCR trang 12 ĐẦU TIÊN.
  const rawOrder=[n-2,n-3,n-1,n-4,n,n-5,n-6,n-7];
  const candidates=[...new Set(rawOrder)].filter(p=>p>=1 && p<=n).slice(0,auto&&n>24?2:8);

  setDetect("detOCR",false,"Đang OCR claims...");
  $("pdfStatus").textContent=auto
    ? "PDF dạng scan — đang tự quét các trang cuối để tìm Yêu cầu bảo hộ..."
    : "Đang quét các trang cuối để tìm Yêu cầu bảo hộ...";

  let foundPage=null;

  for(let i=0;i<candidates.length;i++){
    const p=candidates[i];
    $("pdfStatus").textContent=`OCR yêu cầu bảo hộ: trang ${p}/${n} (${i+1}/${candidates.length})...`;

    const ok=await ocrSelectedPages([p],`OCR trang ${p}`);
    if(obsolete())return false;
    if(!ok){
      // OCR fail thì thoát sạch, KHÔNG treo UI.
      $("progressBar").style.width="100%";
      return false;
    }

    const t=state.ocrPages[p]||"";
    if(hasClaimMarker(t) || looksLikeClaimPage(t)){
      foundPage=p;
      break;
    }
  }

  if(!foundPage){
    if(obsolete())return false;
    state.rawText=mergedText();
    const fallback=candidateClaimsText();
    state.claimsText=fallback||"";
    $("claimsRaw").value=state.claimsText;$("claimsClean").value=formatClaimForDisplay(state.claimsText);
    state.claims=parseClaims(state.claimsText);
    state.selected=0;
    renderClaims();
    setDetect("detClaims",state.claims.length>0,
      state.claims.length?`Đã tách ${state.claims.length} claim`:"OCR xong nhưng chưa tìm thấy claim");
    $("progressBar").style.width="100%";
    $("pdfStatus").textContent=state.claims.length
      ?`OCR hoàn tất. Đã nhận diện ${state.claims.length} claim.`
      :"Đã quét các trang cuối nhưng chưa nhận diện được claim. Bạn vẫn có thể paste claims ở bước 2.";
    return state.claims.length>0;
  }

  // OCR thêm 1 trang kế tiếp vì claims có thể kéo dài sang trang sau.
  const follow=foundPage+1;
  if(follow<=n && !state.ocrPages[follow]){
    $("pdfStatus").textContent=`Đã tìm thấy trang claims ${foundPage}; đang kiểm tra trang ${follow}...`;
    await ocrSelectedPages([follow],`OCR trang ${follow}`);
  }
  if(obsolete())return false;

  const claimPages=[foundPage];
  if(follow<=n && state.ocrPages[follow]) claimPages.push(follow);
  const joined=claimPages.map(p=>state.ocrPages[p]||"").join("\n\n");

  state.rawText=mergedText();
  let c=extractClaimsTail(joined);
  if(!c) c=candidateClaimsText();
  if(!c && looksLikeClaimPage(joined)) c=clean(joined);

  state.claimsText=c||"";
  $("claimsRaw").value=state.claimsText;$("claimsClean").value=formatClaimForDisplay(state.claimsText);
  state.claims=parseClaims(state.claimsText);
  state.selected=0;
  renderClaims();

  setDetect("detClaims",state.claims.length>0,
    state.claims.length?`Đã tách ${state.claims.length} claim`:"Đã thấy trang claims nhưng parser chưa tách được");
  $("progressBar").style.width="100%";
  $("pdfStatus").textContent=state.claims.length
    ?`Hoàn tất. Tìm thấy Yêu cầu bảo hộ ở trang ${foundPage} và đã tách ${state.claims.length} claim.`
    :`Đã tìm thấy trang Yêu cầu bảo hộ ${foundPage}, nhưng cần kiểm tra nội dung ở bước 2.`;

  return state.claims.length>0;
}

function mergedText(){
  const out=[];
  for(let i=0;i<state.pageText.length;i++){
    const direct=state.pageText[i]||"";
    const q=state.pageQuality[i]||0;
    const ocr=state.ocrPages[i+1]||"";
    out.push(q>=70 ? direct : (ocr||direct));
  }
  return out.join("\n\n");
}

function claimCandidateScore(text){
  if(!text) return -999;
  let score=textLayerQualityScore(text);
  if(hasClaimMarker(text)) score+=45;
  if(looksLikeClaimPage(text)) score+=30;
  const parsed=parseClaims(extractClaimsTail(text)||text);
  score+=Math.min(40,parsed.length*10);
  const garbage=(text.match(/\d+\s*\/\s*\d+/g)||[]).length;
  score-=garbage*8;
  return score;
}

function candidateClaimsText(){
  const candidates=[];
  const mode=effectiveLanguageMode();

  for(let i=0;i<state.pageText.length;i++){
    const src=state.pageText[i]||"";
    const q=state.pageQuality[i]||0;
    if(q<48) continue;

    const baseLang=detectTextLanguage(src).lang;
    if(mode==="vi" && baseLang==="en") continue;
    if(mode==="en" && baseLang==="vi") continue;

    if(hasClaimMarker(src)||looksLikeClaimPage(src)){
      const joined=[src];

      for(let j=i+1;j<Math.min(state.pageText.length,i+5);j++){
        if((state.pageQuality[j]||0)<48) continue;
        const next=state.pageText[j]||"";
        const nextLang=detectTextLanguage(next).lang;

        // Mixed document: keep contiguous claim pages in the same language bucket.
        if(baseLang!=="unknown" && nextLang!=="unknown" && baseLang!==nextLang) break;
        joined.push(next);
      }

      const block=joined.join("\n\n");
      const tail=extractClaimsTail(block)||block;
      const cleanTail=applyLanguageSpecificCleanup(tail,baseLang);
      candidates.push({
        text:cleanTail,
        lang:baseLang,
        score:claimCandidateScore(cleanTail)+25+languageSanityScore(cleanTail,baseLang)/5
      });
    }
  }

  for(const [p,src] of Object.entries(state.ocrPages)){
    if(!src) continue;
    const lang=detectedPageLanguage(+p)||detectTextLanguage(src).lang;
    if(mode==="vi" && lang==="en") continue;
    if(mode==="en" && lang==="vi") continue;

    const tail=extractClaimsTail(src)||src;
    candidates.push({
      text:applyLanguageSpecificCleanup(tail,lang),
      lang,
      score:claimCandidateScore(tail)+languageSanityScore(tail,lang)/5
    });
  }

  // Include the full merged PDF once: do not silently stop after four subsequent pages.
  // Page OCR may be split across many claims pages in long or image-only documents.
  const allPages=mergedText();
  if(allPages){
    const fromAll=extractClaimsTail(allPages);
    if(fromAll){
      const lang=detectTextLanguage(fromAll).lang;
      candidates.push({text:fromAll,lang,score:claimCandidateScore(fromAll)+Math.min(80,parseClaims(fromAll).length*3)});
    }
  }
  if(!candidates.length){
    for(const src of state.pageColumnText){
      if(!src) continue;
      const lang=detectTextLanguage(src).lang;
      const tail=extractClaimsTail(src);
      if(tail) candidates.push({text:tail,lang,score:claimCandidateScore(tail)-20});
    }
  }

  candidates.sort((a,b)=>b.score-a.score);
  const best=candidates[0];
  if(!best||best.score<45) return "";

  // Reject obvious language-garbage instead of feeding it into feature extraction.
  const sanity=languageSanityScore(best.text,best.lang);
  if(sanity<35){
    console.warn("Rejected low-sanity claim OCR",best.lang,sanity,best.text.slice(0,250));
    return "";
  }
  state.analysisLang=best.lang==="unknown"?resolveAnalysisLanguage():best.lang;
  return best.text;
}


function expandClaimNumberExpression(expr){
  const out=[];
  String(expr||"").replace(/[–—]/g,"-").split(/\s*(?:,|;|and|or|và|hoặc)\s*/i).forEach(part=>{
    const m=part.match(/(\d+)\s*-\s*(\d+)/);
    if(m){const a=+m[1],b=+m[2];for(let n=Math.min(a,b);n<=Math.max(a,b)&&n<=300;n++)out.push(n)}
    else{const mm=part.match(/\d+/);if(mm)out.push(+mm[0])}
  });
  return [...new Set(out)];
}
function parseClaimDependencies(text,id){
  const t=normalizeOcrText(text||"");const refs=[];
  const pats=[/according to (?:any one of )?claims?\s+([\d\s,;–—\-andor]+)/ig,/(?:the )?claim\s+([\d\s,;–—\-andor]+)/ig,/theo (?:một trong các )?(?:yêu cầu bảo hộ|điểm|claim)\s+([\d\s,;–—\-vàhoặc]+)/ig];
  for(const re of pats){let m;while((m=re.exec(t)))for(const n of expandClaimNumberExpression(m[1]))if(n<id)refs.push(n)}
  return [...new Set(refs)].sort((a,b)=>a-b);
}
function claimRelevantDate(claimId){return state.claimDates?.[claimId]||$("relevantDate")?.value||$("filingDate")?.value||""}
function selectedClaimRelevantDate(){const c=state.claims[state.selected]||state.claims[0];return c?claimRelevantDate(c.id):($("relevantDate")?.value||$("filingDate")?.value||"")}
function renderClaimMap(){
  const body=$("claimMapBody");if(!body)return;
  if(!state.claims.length){body.innerHTML='<tr><td colspan="5" class="status">Chưa có claim.</td></tr>';return}
  const global=$("relevantDate")?.value||$("filingDate")?.value||"";for(const c of state.claims)if(!state.claimDates[c.id]&&global)state.claimDates[c.id]=global;
  body.innerHTML=state.claims.map(c=>{const deps=c.dependsOn||[],ind=!deps.length;return `<tr><td><strong>Claim ${c.id}</strong></td><td><span class="claim-dep ${ind?'claim-independent':'claim-dependent'}">${ind?'Independent / Độc lập':'Dependent / Phụ thuộc'}</span></td><td>${deps.length?deps.map(x=>'Claim '+x).join(', '):'—'}</td><td><input type="date" data-claim-date="${c.id}" value="${esc(claimRelevantDate(c.id))}"></td><td class="status">${deps.length>1?'Nhiều nhánh phụ thuộc: chuyên gia xác định nhánh cụ thể.':ind?'Máy phân tích phần chữ của claim độc lập.':'Máy đã ghép phần chữ claim cha theo chuỗi đơn; cần so lại quan hệ và giới hạn.'}</td></tr>`}).join('');
  document.querySelectorAll('[data-claim-date]').forEach(el=>el.onchange=()=>{state.claimDates[+el.dataset.claimDate]=el.value;renderCandidates();renderReadiness()});
}
// OCR can repeat the same claim label twice: "1. 1. A composition ...".
// Never delete labels of another claim or technical numeric values (e.g. 1.5 mg).
function stripRepeatedClaimHeading(body, claimId){
  const sameLabel=new RegExp('^\\s*'+claimId+'\\s*[.)]\\s+(?=[\\p{L}\\(])','u');
  let text=clean(body||'');
  for(let i=0;i<3 && sameLabel.test(text);i++) text=clean(text.replace(sameLabel,''));
  return text;
}

function parseClaims(text){
  const lang=resolveAnalysisLanguage();
  let t=truncateClaimAtFigure(
    applyLanguageSpecificCleanup(text||"",lang==="mixed"?detectTextLanguage(text||"").lang:lang),
    lang
  ).replace(/\r/g,"\n");

  t=t.replace(/(?:^|\n)\s*(\d{1,3})\s*[\.\)](?!\d)\s*/g,"\n$1. ");

  let matches=[...t.matchAll(/(?:^|\n)\s*(\d{1,3})\.(?!\d)\s*([\s\S]*?)(?=(?:\n\s*\d{1,3}\.(?!\d)\s*)|$)/g)];
  let arr=matches
    .map(m=>({id:+m[1],text:stripRepeatedClaimHeading(m[2],+m[1])}))
    .filter(x=>x.text.length>15);

  if(!arr.length){
    const f=foldVN(t);
    const first=f.search(/(?:^|\n|\s)1\s+(QUY TRINH|PHUONG PHAP|SAN PHAM|THIET BI|HE THONG|CHE PHAM|A\s|AN\s|THE\s)/);
    if(first>=0){
      const body=clean(t.slice(first));
      arr=[{id:1,text:body.replace(/^\s*1\s*/,"")}];
    }
  }

  arr=arr
    .filter((x,i,a)=>a.findIndex(y=>y.id===x.id)===i)
    .sort((a,b)=>a.id-b.id);

  return arr.map((c,i)=>{const dependsOn=parseClaimDependencies(c.text,c.id);return {...c,dependsOn,lang:detectTextLanguage(c.text).lang,type:dependsOn.length?(lang==="en"?"Dependent":"Phụ thuộc"):(lang==="en"?"Independent":"Độc lập")};});
}
function guessJur(text,no){
 if(/CỤC SỞ HỮU TRÍ TUỆ|Cộng hòa xã hội chủ nghĩa Việt Nam/i.test(text)||/^[12]-\d{5,}/.test(no))return"VN";
 if(/United States Patent|U\.S\. Patent/i.test(text)||/^US/i.test(no))return"US";
 if(/^WO/i.test(no))return"WO/PCT";if(/^EP/i.test(no))return"EP";return"Khác";
}
function taggedField(text,tag,maxLen=500){
  const t=stripPdfArtifacts(text||"");
  const re=new RegExp("\\\\("+tag+"\\\\)\\\\s*([\\\\s\\\\S]{1,"+maxLen+"}?)(?=\\\\(\\\\d{2}\\\\)|$)","i");
  const m=t.match(re);
  return m?cleanMetaValue(m[1]):"";
}


function firstNonEmpty(...vals){
  for(const v of vals){
    const s=cleanMetaValue(v||"");
    if(s) return s;
  }
  return "";
}

function labelField(text,labels,maxLen=600){
  const t=stripPdfArtifacts(text||"");
  for(const label of labels){
    const re=new RegExp(
      "(?:^|\\n)\\s*(?:"+label+")\\s*[:\\-]?\\s*([\\s\\S]{1,"+maxLen+"}?)(?=\\n\\s*(?:\\(?\\d{2}\\)?|Tên sáng chế|Số (?:đơn|bằng|công bố)|Ngày (?:nộp đơn|ưu tiên)|Chủ (?:đơn|bằng)|Người nộp đơn|Đại diện|Phân loại|IPC|CPC|Tóm tắt|Yêu cầu bảo hộ|CLAIMS?|ABSTRACT|Title|Applicant|Assignee|Representative|Filed|Int\\.\\s*Cl\\.)\\b|$)",
      "i"
    );
    const m=t.match(re);
    if(m&&m[1]){
      const v=cleanMetaValue(m[1]).split(/\n{2,}/)[0].trim();
      if(v) return v;
    }
  }
  return "";
}

function vnDateField(text,labels){
  const raw=labelField(text,labels,120);
  if(raw){
    const d=normDate(raw);
    if(d) return d;
  }
  const t=stripPdfArtifacts(text||"");
  const m=t.match(/(?:ngày\s*)?(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/i);
  return m?`${m[3]}-${String(m[2]).padStart(2,"0")}-${String(m[1]).padStart(2,"0")}`:"";
}

function mergeMeta(primary,secondary){
  return {
    no:firstNonEmpty(primary?.no,secondary?.no),
    title:firstNonEmpty(primary?.title,secondary?.title),
    filing:firstNonEmpty(primary?.filing,secondary?.filing),
    applicant:firstNonEmpty(primary?.applicant,secondary?.applicant),
    assignee:firstNonEmpty(primary?.assignee,secondary?.assignee),
    rep:firstNonEmpty(primary?.rep,secondary?.rep),
    ipc:firstNonEmpty(primary?.ipc,secondary?.ipc),
    abs:firstNonEmpty(primary?.abs,secondary?.abs),
    jur:firstNonEmpty(primary?.jur,secondary?.jur,"VN")
  };
}

function metaFieldCount(m){
  return ["no","title","filing","applicant","assignee","rep","ipc","abs"].filter(k=>String(m?.[k]||"").trim()).length;
}

function clearMetaFields(){
  ["caseId","patentNo","title","filingDate","applicant","assignee","representative","ipc","abstract"].forEach(id=>{
    if($(id)) $(id).value="";
  });
  $("caseBadge").textContent="Chưa có case";
  if($("metaStatus")) $("metaStatus").textContent="Đang dò metadata...";
}
function extractMetadata(text){
  const t=stripPdfArtifacts(text||"");

  const no=firstNonEmpty(
    firstMatch(t,[
      /\(11\)\s*([12]-\d{5,8})/i,
      /\(21\)\s*([12]-\d{5,10})/i,
      /\b([12]-\d{6,8})\b/i,
      /\bPatent\s*No\.?\s*:?\s*(US\s*[\d,]+\s*[AB]\d)\b/i,
      /\b(US\s?\d{7,11}\s?[AB]\d)\b/i,
      /\b(WO\s?\d{4}\/\d{5,7}\s?[A-Z]\d?)\b/i,
      /\b(EP\s?\d{6,10}\s?[AB]\d?)\b/i
    ]).replace(/\s+/g," "),
    labelField(t,[
      "Số\\s+bằng(?:\\s+độc\\s+quyền\\s+sáng\\s+chế)?",
      "Số\\s+công\\s+bố",
      "Số\\s+đơn",
      "Mã\\s+đơn"
    ],120)
  );

  let title=firstNonEmpty(
    taggedField(t,"54",500),
    labelField(t,["Tên\\s+sáng\\s+chế","Tên\\s+giải\\s+pháp\\s+hữu\\s+ích","Tên\\s+đề\\s+tài"],500),
    firstMatch(t,[/Title\s*:?\s*([^\n]{5,300})/i])
  );
  title=sanitizePatentTitle(title);

  let filing=firstNonEmpty(
    taggedField(t,"22",100),
    vnDateField(t,["Ngày\\s+nộp\\s+đơn","Ngày\\s+ưu\\s+tiên"]),
    firstMatch(t,[/Filed\s*:?\s*([A-Za-z]{3,9}\.?\s+\d{1,2},\s+\d{4})/i])
  );
  filing=normDate(filing)||filing;

  // INID 71 = Applicant(s). Do NOT mix this with the patent owner/assignee.
  const applicant=firstNonEmpty(
    taggedField(t,"71",700),
    labelField(t,[
      "Người\\s+nộp\\s+đơn",
      "Chủ\\s+đơn",
      "Applicant(?:\\(s\\))?"
    ],700),
    firstMatch(t,[
      /(?:^|\n)\s*Applicant(?:\(s\))?\s*:?\s*([^\n]{3,350})/i
    ])
  );

  // INID 73 = Grantee / holder / assignee / owner.
  // Keep it in a SEPARATE field from Applicant.
  const assignee=firstNonEmpty(
    taggedField(t,"73",700),
    labelField(t,[
      "Chủ\\s+bằng",
      "Chủ\\s+sở\\s+hữu",
      "Người\\s+được\\s+cấp\\s+bằng",
      "Assignee(?:\\(s\\))?",
      "Owner(?:\\(s\\))?",
      "Proprietor(?:\\(s\\))?",
      "Grantee(?:\\(s\\))?"
    ],700),
    firstMatch(t,[
      /(?:^|\n)\s*Assignee(?:\(s\))?\s*:?\s*([^\n]{3,350})/i,
      /(?:^|\n)\s*Owner(?:\(s\))?\s*:?\s*([^\n]{3,350})/i,
      /(?:^|\n)\s*Proprietor(?:\(s\))?\s*:?\s*([^\n]{3,350})/i
    ])
  );

  // INID 74 = Agent / attorney / representative.
  // Leave blank when the source does not state one; never infer it from Applicant/Assignee.
  const rep=firstNonEmpty(
    taggedField(t,"74",600),
    labelField(t,[
      "Đại\\s+diện\\s+sở\\s+hữu\\s+công\\s+nghiệp",
      "Đại\\s+diện\\s+SHCN",
      "Đại\\s+diện\\s+SHTT",
      "Đại\\s+diện",
      "Representative",
      "Patent\\s+Attorney",
      "Attorney(?:,?\\s+Agent\\s+or\\s+Firm)?",
      "Agent(?:\\(s\\))?"
    ],600),
    firstMatch(t,[
      /(?:^|\n)\s*Representative\s*:?\s*([^\n]{3,350})/i,
      /(?:^|\n)\s*Attorney(?:,?\s+Agent\s+or\s+Firm)?\s*:?\s*([^\n]{3,350})/i,
      /(?:^|\n)\s*Patent\s+Attorney\s*:?\s*([^\n]{3,350})/i
    ])
  );

  const ipc=firstNonEmpty(
    taggedField(t,"51",500),
    labelField(t,[
      "Phân\\s+loại\\s+quốc\\s+tế(?:\\s+sáng\\s+chế)?",
      "Phân\\s+loại\\s+IPC",
      "IPC",
      "CPC"
    ],500),
    firstMatch(t,[/Int\.\s*Cl\.?\s*:?\s*([^\n]{5,300})/i])
  );

  let abs=firstNonEmpty(
    taggedField(t,"57",2600),
    labelField(t,["Tóm\\s+tắt","Tóm\\s+tắt\\s+sáng\\s+chế"],2600),
    firstMatch(t,[/ABSTRACT\s*([\s\S]{40,2200}?)(?=FIELD OF|BACKGROUND|CLAIMS?)/i])
  );
  abs=cleanMetaValue(abs).slice(0,2400);

  return{no,title,filing,applicant,assignee,rep,ipc,abs,jur:guessJur(t,no)}
}

function fillMeta(m){
  $("patentNo").value=m.no||"";
  if(researchMode()==="retrospective"&&m.no&&!$("inputSourceUrl").value.trim())$("inputSourceUrl").value=m.no;
  if(researchMode()==="retrospective"&&m.no){const n=String(m.no).toUpperCase();if(/[A-Z]\d?$/.test(n)&&/B\d?$/.test(n))$("documentVersion").value="granted";else if(/A\d?$/.test(n))$("documentVersion").value="published";}
  $("title").value=m.title||"";
  $("filingDate").value=m.filing||"";
  syncRelevantDate();
  $("applicant").value=m.applicant||"";
  $("assignee").value=m.assignee||"";
  $("representative").value=m.rep||"";
  $("ipc").value=m.ipc||"";
  updateMetadataLabels();
  $("abstract").value=m.abs||"";

  [...$("jurisdiction").options].forEach((o,i)=>{
    if(o.value===m.jur)$("jurisdiction").selectedIndex=i
  });

  const base=(m.no||m.title||"PAT")
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/\s/g,"").replace(/[^A-Za-z0-9-]/g,"")
    .slice(0,30);
  $("caseId").value=(m.jur||"CASE")+"-"+(base||"PAT");
  $("caseBadge").textContent=$("caseId").value;

  const count=metaFieldCount(m);
  setDetect("detMeta",count>0,count?`Đã nhận diện ${count}/8 trường`:"Chưa tìm thấy metadata");
  setDetect("detAbstract",!!m.abs,m.abs?"Đã nhận diện":"Chưa tìm thấy");

  if($("metaStatus")){
    $("metaStatus").innerHTML=count
      ? `Đã lấy được <strong>${count}/8</strong> trường metadata. Applicant, Assignee/Owner và Representative được tách riêng; trường không có trong tài liệu sẽ để trống, không suy đoán.`
      : `Chưa tìm được metadata có cấu trúc. Hệ thống vẫn giữ phần claims nếu đọc được.`;
  }
}

async function rescanMetadataFromLoadedPdf(quick=false){
  if(!state.pdf) return alert("Chưa có PDF.");

  let meta={};
  const maxPages=Math.min(8,state.pageText.length);

  // 1) Parse từng trang đầu.
  for(let i=0;i<maxPages;i++){
    const text=state.pageText[i]||"";
    if(!text.trim()) continue;
    meta=mergeMeta(meta,extractMetadata(text));
  }

  // 2) Parse gộp tối đa tám trang; đây chỉ là thử nhận diện metadata, không phải xác minh tính đúng pháp lý.
  const headText=state.pageText.slice(0,maxPages).join("\n\n");
  meta=mergeMeta(meta,extractMetadata(headText));

  // 3) Nếu còn thiếu title/no/applicant/abstract, OCR các trang đầu chưa OCR.
  if(!quick && (metaFieldCount(meta)<5 || !meta.title || !meta.no)){
    const pages=[];
    for(let p=1;p<=maxPages;p++){
      if(((state.pageQuality[p-1]||0)<48 || !(state.pageText[p-1]||'').trim()) && !state.ocrPages[p])pages.push(p);
      if(pages.length>=2)break; // on-demand metadata retry must not OCR eight pages at once
    }
    if(pages.length){
      $("pdfStatus").textContent=`Đang OCR ${pages.length} trang đầu để dò metadata...`;
      await ocrSelectedPages(pages,"OCR metadata");
      const ocrHead=pages.map(p=>state.ocrPages[p]||"").join("\n\n");
      meta=mergeMeta(meta,extractMetadata(ocrHead));
    }
  }

  fillMeta(meta);
  return meta;
}

async function processFile(file){
  state.uploadGeneration=(state.uploadGeneration||0)+1;
  const generation=state.uploadGeneration;
  state.pdf=null;state.documentAudit=null;state.importedDocumentIdentity=null;state.pdfLoading=true;state.auditStop=true;state.inputAuditBusy=false;state.pdfTextScanBusy=false;state.keywordOnly=false;
  if($("ocrReviewGate"))$("ocrReviewGate").hidden=false; if($("manualReviewGate"))$("manualReviewGate").hidden=true;resetInputReview();
  state.reviewLog=[];state.claimDates={};state.matrixOverrides={};state.technicalEffects={};state.sourceVerification={};
  state.reviewData={};state.reviews=0;state.targetExcluded=[];state.searchPlan=[];
  if($("inputVersionConfirmed"))$("inputVersionConfirmed").checked=false;
  if($("relevantDateVerified"))$("relevantDateVerified").checked=false;
  state.priorMeta={};state.searchAudit=[];state.candidates=[];state.selectedCandidates={D1:null,D2:null,D3:null};
  for(const slot of ["D1","D2","D3"]){const n=slot.slice(1);for(const k of ["No","Date","Url","Text"]){const el=$(`d${n}${k}`);if(el)el.value="";}}
  state.ocrPages={};state.inputScanAudit=null;state.pdfTextErrors={};state.pageTextScanDone=[];state.pdfPendingTextPages=[];
  state.claims=[];
  state.claimsText="";
  state.features=[];
  state.search=[];
  state.queries=[];
  state.prior={};
  state.matrix=[];
  clearMetaFields();
  $("claimsRaw").value="";
  $("claimsClean").value="";
  $("progressBar").style.width="3%";
  $("pdfStatus").textContent="Đang mở PDF...";

  try{
    await readPdf(file);
    renderTessDiag();
    chooseDocumentLanguage();
    state.analysisLang=state.docLang;
    updateLanguageStatus();
    updateMetadataLabels();
  }catch(e){
    console.error(e);
    $("progressBar").style.width="100%";
    $("pdfStatus").textContent="Không thể mở PDF: "+(e&&e.message?e.message:e);
    alert("Không thể mở file PDF này.");
    state.pdfLoading=false;
    return;
  }

  state.rawText=mergedText();

  // v14.1: metadata không còn chỉ đọc page 1.
  // Dò tối đa 4 trang đầu + OCR bổ sung nếu còn thiếu trường.
  try{
    await rescanMetadataFromLoadedPdf(true);
  }catch(e){
    console.warn("Metadata rescan:",e);
    if($("metaStatus")) $("metaStatus").textContent="Dò metadata gặp lỗi: "+String(e.message||e);
  }

  // Reading all text layers is fast. OCR weak/scan pages is explicit and resumable,
  // never silently marked complete and never blocks the initial claims preview.
  makeInputScanAudit();
  // Claims: ưu tiên text layer sạch.
  let claims="";
  try{claims=candidateClaimsText()}catch(e){console.warn(e)}

  if(claims && claimCandidateScore(claims)>=45){
    state.claimsText=truncateClaimAtFigure(stripPdfArtifacts(claims));
    $("claimsRaw").value=state.claimsText;
    $("claimsClean").value=formatClaimForDisplay(state.claimsText);
    state.claims=parseClaims(state.claimsText);
    state.claimCoverage=claimNumberingAudit(state.claims,state.claimsText);
    state.selected=0;
    renderClaims();renderInputGate();
  }

  // Nếu claim vẫn không đủ tin cậy, OCR các trang cuối.
  if(!state.claims.length && state.pdf.numPages<=24){
    await smartOcrClaims(true);
  }
  // For long scanned PDFs, release the upload UI immediately and OCR two likely
  // claims pages asynchronously; the claims editor stays usable while OCR runs.
  const queuedLongClaims=!state.claims.length&&state.pdf.numPages>24;
  const queuedTextScan=(state.pdfPendingTextPages||[]).length>0;
  state.rawText=mergedText();
  makeInputScanAudit();
  renderInputGate();
  $("progressBar").style.width="100%";

  if(state.claims.length){
    setDetect("detClaims",true,`Đã tách ${state.claims.length} claim`);
    const mode=state.badTextPages.length
      ?`Có ${state.badTextPages.length} trang text layer kém; OCR bổ sung khi cần.`
      :`Đọc trực tiếp text layer · ${languageLabel(state.docLang)} · Unicode NFC.`;
    const missed=(state.inputScanAudit?.unread||[]);
    const pending=state.inputScanAudit?.pending||[];
    $("pdfStatus").textContent=`Đã nhận diện ${state.claims.length} claim từ trang xem trước · PDF ${state.pdf.numPages} trang. ${pending.length?'⚠ Còn '+pending.length+' trang chưa đọc đủ chữ. Chuyển sang Bước 2 để xem claims; có thể chạy OCR bổ sung tại đó.':'Đã thử đọc chữ mọi trang; vẫn cần xem hình vẽ trong bản gốc.'}`;
  }else{
    setDetect("detClaims",false,"Chưa tự tách được claim");
    $("pdfStatus").textContent=`Đã đọc các trang xem trước của PDF ${state.pdf.numPages} trang nhưng chưa tìm rõ claims. Có thể xem Bước 2; máy tiếp tục kiểm tra các trang khác.`;
  }
  state.pdfLoading=false;
  refreshTopicRoutingAndQueries();
  renderPdfAuditStatus();
  if(state.step===0&&['patentability','pilot'].includes($("purposeChoice")?.value||''))showStep(1);
  // Read the remaining text layers BEFORE falling back to OCR. A large scanned
  // PDF must not download Tesseract models while the remaining pages are parsing.
  if(queuedTextScan){
    const currentPdf=state.pdf;
    setTimeout(async()=>{
      if(state.pdf!==currentPdf||state.uploadGeneration!==generation)return;
      await scanRemainingPdfText(currentPdf,generation);
      if(state.pdf!==currentPdf||state.uploadGeneration!==generation||state.claims.length)return;
      if(queuedLongClaims&&!state.claimOcrBusy){
        $("pdfStatus").textContent="Chưa nhận diện rõ claims từ lớp chữ. Thử OCR tối đa 2 trang có khả năng chứa claims; có thể theo dõi ở Bước 2.";
        try{await smartOcrClaims(true)}catch(e){console.warn("Quick claims OCR",e);$("pdfStatus").textContent="OCR thử claims gặp lỗi: "+String(e.message||e)+". Bạn có thể thử trang khác hoặc dán nội dung claims.";}
      }
    },0);
  }else if(queuedLongClaims){
    setTimeout(async()=>{
      if(state.uploadGeneration!==generation)return;
      try{await smartOcrClaims(true)}catch(e){$("pdfStatus").textContent="OCR thử claims gặp lỗi: "+String(e.message||e);}
    },0);
  }
}


if($("languageMode")){
  $("languageMode").onchange=()=>{
    state.languageMode=$("languageMode").value;
    state.analysisLang=resolveAnalysisLanguage();
    updateLanguageStatus();
    updateMetadataLabels();
    // Clear OCR cache so a new explicit language choice is honored.
    state.ocrPages={};
    state.claimSourceByPage={};
    ocrWorkerPromise=null;
  };
}
if($("pdfInput")){
  $("pdfInput").onchange=async e=>{
    const f=e.target.files&&e.target.files[0];
    if(!f) return;
    try{
      await processFile(f);
    }catch(err){
      state.pdfLoading=false;
      console.error("PDF upload fatal:",err);
      $("pdfStatus").textContent="Lỗi xử lý PDF: "+String(err&&err.message?err.message:err);
      alert("Không xử lý được PDF: "+String(err&&err.message?err.message:err));
    }
  };
}
const dz=$("dropZone");
if(dz){
  ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add("drag")}));
  ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove("drag")}));
  dz.addEventListener("drop",async e=>{
    const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
    if(!f) return;
    try{await processFile(f)}
    catch(err){
      state.pdfLoading=false;
      console.error("PDF drop fatal:",err);
      $("pdfStatus").textContent="Lỗi xử lý PDF: "+String(err&&err.message?err.message:err);
    }
  });
}
$("retryOCR").onclick=async()=>{if(!state.pdf)return alert("Chưa có PDF.");if($("ocrReviewConfirmed"))$("ocrReviewConfirmed").checked=false;state.ocrPages={};state.claimSourceByPage={};ocrWorkerPromise=null;await smartOcrClaims(false)};
$("ocrClaimsAgain").onclick=async()=>{if(!state.pdf)return alert("Chưa có PDF.");if($("ocrReviewConfirmed"))$("ocrReviewConfirmed").checked=false;state.ocrPages={};state.claimSourceByPage={};ocrWorkerPromise=null;await smartOcrClaims(false)};

let autoClaimsFingerprint='';
function ensureAllClaimsProcessed(){
  const signature=JSON.stringify((state.claims||[]).map(c=>[c.id,c.text,c.dependsOn]));
  const alreadyMapped=state.claimGroups?.length===state.claims.length&&(state.claims.length===0||state.features?.length>0)&&state.features?.every(f=>f.claimId!==undefined);
  if(alreadyMapped){autoClaimsFingerprint=signature;return;}
  autoClaimsFingerprint=signature;
  autoProcessAllClaims();
}
function claimNumberingAudit(claims,text){
  const ids=(claims||[]).map(c=>Number(c.id)).filter(Number.isFinite).sort((a,b)=>a-b);
  const max=ids.length?ids.at(-1):0;
  const missing=[];for(let i=1;i<=max;i++)if(!ids.includes(i))missing.push(i);
  return {recognized:ids.length,maxId:max,missing,completeSequence:!!ids.length&&ids[0]===1&&missing.length===0,
    note:'Kiểm tra thứ tự claim chỉ phát hiện một số lỗi OCR, không chứng minh PDF đã chứa mọi claim hoặc đã đọc đúng hình vẽ.'};
}
function renderClaims(){state.claimCoverage=claimNumberingAudit(state.claims,state.claimsText);
  ensureAllClaimsProcessed();
 $("claimSelect").innerHTML=state.claims.map((c,i)=>`<option value="${i}">Claim ${c.id} · ${c.type}</option>`).join("");
 if(!state.claims.length){
   $("claimList").className="empty";
   $("claimList").innerHTML="Chưa có claim.";
   return;
 }
 $("claimList").className="";
 $("claimList").innerHTML=state.claims.map((c,i)=>{
   const pretty=esc(formatClaimForDisplay(c.text)).replace(/\n/g,"<br>");
   return `<details class="claim claim-accordion" ${i===state.selected?'open':''}>
      <summary>Claim ${c.id} <span class="pill ${c.type==="Độc lập"?"blue":""}">${c.type}</span> <span class="current-claim-tag">Đã nhận diện · máy sẽ phân tích</span><span aria-hidden="true" class="claim-chevron">⌄</span></summary>
      <div class="claim-clean">${pretty}</div>
   </details>`;
 }).join("");
 // Không bắt người dùng chọn từng claim: toàn bộ danh sách được đưa vào phân tích.
 renderClaimMap();
}
$("parseClaims").onclick=()=>{
      if($("ocrReviewConfirmed")&&state.pdf)$("ocrReviewConfirmed").checked=false;
      if($("inputVersionConfirmed"))$("inputVersionConfirmed").checked=false;
      state.confirmed=false; state.features=[]; state.matrix=[]; state.evidenceReviews={}; state.matrixOverrides={}; state.assessment={};state.reviewData={};state.reviews=0;
      const source=$("claimsClean").value||$("claimsRaw").value;
      state.claimsText=applyLanguageSpecificCleanup(source,resolveAnalysisLanguage());
      $("claimsClean").value=formatClaimForDisplay(state.claimsText);
      $("claimsRaw").value=state.claimsText;
      state.claims=parseClaims(state.claimsText);
      state.selected=0;
      renderClaims();renderInputGate();
      setDetect("detClaims",state.claims.length>0,state.claims.length?`Đã tách ${state.claims.length} claim`:"Chưa tìm thấy claim");
    };

function claimTextWithAncestors(c){
  const byId=new Map((state.claims||[]).map(x=>[String(x.id||x.no||x.number||''),x]));
  const visited=new Set(),anc=[];
  function walk(x,depth){
    if(!x||depth>12)return;
    const id=String(x.id||x.no||x.number||'');if(visited.has(id))return;visited.add(id);
    for(const dep of x.dependsOn||[]){const parent=byId.get(String(dep));if(parent)walk(parent,depth+1)}
    anc.push(x);
  }
  walk(c,0);
  if(anc.length<2)return String(c.text||'');
  return anc.map((x,i)=>`[Claim ${x.id||x.no||x.number||i+1}${x===c?'':' – kế thừa'}] ${x.text||''}`).join('; ');
}
function featureSplit(text){
  let t=normalizeOcrText(text||"")
    .replace(/^\s*(?:a|an|the)?\s*(?:quy trình|phương pháp|method|process|composition|device|system)[^:]{0,220}(?:bao gồm|comprising|comprises)\s*:?\s*/i,"");

  const connectors=/\b(?:sau đó|tiếp theo|kế tiếp|then|subsequently)\b/ig; // Keep wherein/trong đó and explicit relationships intact.
  let seg=[];
  const roman=[...t.matchAll(/\((i{1,3}|iv|v|vi{0,3}|ix|x|xi{0,3}|xiv|xv|xvi{0,3})\)\s*/ig)];

  if(roman.length>=2){
    for(let i=0;i<roman.length;i++){
      const a=roman[i].index+roman[i][0].length;
      const b=i+1<roman.length?roman[i+1].index:t.length;
      const s=clean(t.slice(a,b)).replace(/[;,]+$/,"");
      if(s.length>18) seg.push(s);
    }
  }else{
    seg=t
      .replace(connectors,"; ")
      .split(/;\s+|\n(?=\s*(?:\d+[\.\)]|\-|\•))/)
      .map(clean)
      .filter(x=>x.length>18);
  }

  // Gộp các mảnh quá ngắn để tránh feature kiểu "53,2% tinh".
  const merged=[];
  for(const s of seg){
    if(merged.length && (s.split(/\s+/).length<4 || s.length<28)){
      merged[merged.length-1]+="; "+s;
    }else merged.push(s);
  }

  return merged.map((x,i)=>{
    const f=foldVN(x);
    let type="Quy trình";
    if(/\b(ENZYME|BOT|THANH PHAN|TY LE|NGUYEN LIEU|EXTRACT|OIL|COMPOSITION|ACID|POLYMER|HOP CHAT)\b/.test(f)) type="Thành phần/Nguyên liệu";
    else if(/\b(KIEM TRA|XAC DINH|DO LUONG|CHECK|DETERMIN|MEASURE|PH|DO AM|NHIET DO)\b/.test(f)) type="Kiểm soát";
    else if(/\b(CHAMBER|PUMP|TUBE|APPARATUS|DEVICE|SYSTEM|THIET BI|BO PHAN|CAU TRUC)\b/.test(f)) type="Thiết bị/Cấu trúc";
    const words=x.split(/\s+/).length;
    const conf="Chờ kiểm tra với claim gốc";
    return {id:`F${String(i+1).padStart(2,"0")}`,text:x,type,conf};
  });
}

const SEARCH_STOP=new Set([
  "va","hoac","cua","cho","voi","trong","ngoai","tren","duoi","tu","den","tai","theo","sau","truoc","do","nay","mot","cac","nhung",
  "duoc","thuc","hien","tao","hon","hop","dung","dich","phoi","tron","thu","tu","on","dinh","dong","thoi","tiep","bao","gom","buoc",
  "quy","trinh","phuong","phap","san","pham","he","thong","thiet","bi","nhat","bang","cach","su","dung","nham","de","khi","neu","co",
  "the","la","lam","phan","vao","ra","giua","mot","hai","ba","bon","nam","sau","bay","tam","chin","tuong","ung","lan","qua","doi","voi",
  "the","and","or","with","from","wherein","method","process","comprising","comprises","including","step","steps","using","used","use",
  "first","second","third","then","thereof","therein","thereby","such","that","which","into","onto"
]);

function featureCoreTerms(text){
  const original=normalizeOcrText(text||"");
  const tokens=[...original.matchAll(/[\p{L}\p{N}\-\/\.]+/gu)].map(m=>m[0]);
  const out=[];
  for(const tok of tokens){
    const f=foldVN(tok).toLowerCase().replace(/[^a-z0-9\-\/\.]/g,"");
    if(!f || SEARCH_STOP.has(f) || f.length<4) continue;
    if(/^\d+(?:[\.,]\d+)?%?$/.test(f)) continue;
    if(!out.some(x=>foldVN(x).toLowerCase()===f)) out.push(tok);
  }
  return out.slice(0,8);
}

function meaningfulTokens(text){
  return [...normalizeOcrText(text||"").matchAll(/[\p{L}\p{N}\-\/\.]+/gu)]
    .map(m=>m[0])
    .filter(tok=>{
      const f=foldVN(tok).toLowerCase().replace(/[^a-z0-9\-\/\.]/g,"");
      return f.length>=4 && !SEARCH_STOP.has(f) && !/^\d+(?:[\.,]\d+)?%?$/.test(f);
    });
}

function titleTechnicalPhrase(){
  let raw=sanitizePatentTitle($("title").value||"");
  if(!raw) return "";

  let t=normalizeOcrText(raw)
    .replace(/^(?:quy trình|phương pháp|hệ thống|thiết bị|sản phẩm|chế phẩm)\s+(?:sản xuất|chế tạo|điều chế)?\s*/i,"");

  // Reject strings dominated by page numbers / artifacts.
  if((t.match(/\d+\s*\/\s*\d+/g)||[]).length>=1) return "";

  const toks=meaningfulTokens(t);
  if(toks.length>=2) return toks.slice(0,7).join(" ");
  return "";
}

// v33: The claim chart retains inherited limitations for EACH claim. Search queries need
// only one copy of the exact same source feature, with all affected claim IDs recorded.
function featureTextKey(text){
  return normalizeOcrText(String(text||'')).normalize('NFC').toLocaleLowerCase()
    .replace(/\s+/g,' ').replace(/^[;,.\s]+|[;,.\s]+$/g,'').trim();
}
function featureOriginKey(f){
  return String(f?.sourceClaimId??f?.claimId??'?')+'|'+featureTextKey(f?.text);
}
function sharedSearchFeatures(){
  const byOrigin=new Map();
  for(const f of state.features||[]){
    const key=featureOriginKey(f);
    if(!byOrigin.has(key))byOrigin.set(key,{...f,relatedFeatureIds:[]});
    byOrigin.get(key).relatedFeatureIds.push(f.id);
  }
  const byExactText=new Map();
  for(const f of byOrigin.values()){
    // Two different source claims can repeat the same wording; keep their chart rows
    // separate, but a literal duplicate requires only one search concept.
    const key=featureTextKey(f.text);
    if(!byExactText.has(key))byExactText.set(key,{...f});
    else byExactText.get(key).relatedFeatureIds.push(...f.relatedFeatureIds);
  }
  return [...byExactText.values()];
}
// Different source limitations can share a SEARCH TERM; grouping here never
// merges their claim-chart cells or their legal meaning.
function sharedSearchConcepts(){
  const byQuery=new Map();
  for(const f of sharedSearchFeatures()){
    const concept=searchConceptForFeature(f);
    if(!concept)continue;
    const facet=state.searchFacetEdits?.[f.id];
    const key=featureTextKey(concept.primary)+'|'+(facet===undefined?'':featureTextKey(facet));
    if(!byQuery.has(key))byQuery.set(key,{...f,relatedFeatureIds:[...f.relatedFeatureIds]});
    else byQuery.get(key).relatedFeatureIds.push(...f.relatedFeatureIds);
  }
  return [...byQuery.values()];
}
function sourcePhraseIsSafe(text){
  const raw=normalizeOcrText(text||'').trim();
  const tokens=meaningfulTokens(raw);
  const unique=new Set(tokens.map(x=>foldVN(x).toLowerCase()));
  if(raw.length<30||raw.length>175||tokens.length<4||unique.size<3)return false;
  if(unique.size/Math.max(tokens.length,1)<0.60)return false;
  // Reject generic OCR fragments that are mechanically repeated in many source claims.
  // The expert can correct the source claims rather than searching invented 3-grams.
  const norm=featureTextKey(raw);
  const owners=new Set((state.features||[]).filter(f=>featureTextKey(f.text)===norm)
    .map(f=>String(f.sourceClaimId??f.claimId)));
  if(owners.size>=3)return false;
  if(repeatedOcrPhraseRisk(raw))return false;
  return true;
}
// OCR can produce near-identical nonsense across many distinct claims, even when
// each feature has slightly different wording. Detect repeated bigrams ONLY in
// original source claims (not copies inherited by child claims).
function sourceClaimPhraseFrequencies(){
  // Cache is invalidated when any feature text or source-claim relation changes.
  const sig=(state.features||[]).map(f=>`${f.sourceClaimId??f.claimId}|${featureTextKey(f.text)}`).join('\u001f');
  if(state._ocrPairStats?.signature===sig)return state._ocrPairStats;
  const sources=new Map();
  for(const f of state.features||[]){
    const source=String(f.sourceClaimId??f.claimId??'');
    if(!sources.has(source))sources.set(source,new Set());
    const toks=meaningfulTokens(f.text||'').map(t=>foldVN(t).toLowerCase());
    for(let i=1;i<toks.length;i++)if(toks[i]!==toks[i-1])sources.get(source).add(toks[i-1]+' '+toks[i]);
  }
  const count=new Map();
  for(const set of sources.values())for(const pair of set)count.set(pair,(count.get(pair)||0)+1);
  state._ocrPairStats={signature:sig,claims:sources.size,count};
  return state._ocrPairStats;
}
function repeatedOcrPhraseRisk(text){
  const stat=sourceClaimPhraseFrequencies();
  if(stat.claims<6)return false;
  const target=meaningfulTokens(text).map(t=>foldVN(t).toLowerCase());
  const pairs=[];
  for(let i=1;i<target.length;i++)if(target[i]!==target[i-1])pairs.push(target[i-1]+' '+target[i]);
  if(pairs.length<3)return false;
  const threshold=Math.max(4,Math.ceil(stat.claims*0.55));
  const repeated=pairs.filter(pair=>(stat.count.get(pair)||0)>=threshold).length;
  // A warning, NOT proof that the original disclosure is wrong.
  return repeated>=3 && repeated/pairs.length>=0.65;
}
function dictionaryMatches(text){
  const folded=foldVN(normalizeOcrText(text||'')).toLowerCase();
  const found=Object.keys(dict).filter(k=>{
    const term=foldVN(k).toLowerCase();
    return new RegExp('(?:^|[^a-z0-9])'+term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[^a-z0-9])','i').test(folded);
  });
  return found.filter(k=>!found.some(other=>other!==k &&
    foldVN(other).toLowerCase().includes(foldVN(k).toLowerCase()) &&
    foldVN(other).length>foldVN(k).length));
}
function searchConceptForFeature(f){
  const source=normalizeOcrText(f?.text||'').trim();
  const matches=dictionaryMatches(source);
  if(matches.length){
    const vals=matches.flatMap(k=>[k,...(dict[k]||[])]);
    return {primary:matches[0],alternatives:uniqueTerms(vals.slice(1)).slice(0,4),verified:false};
  }
  const fromTopic=window.PATENTLENS_TOPIC_ROUTER?.scan(source,{maxChars:2000})?.topics||[];
  if(fromTopic.length){
    const specific=fromTopic.flatMap(t=>t.matchedConcepts).sort((x,y)=>
      Math.max(...y.matched.map(v=>v.length))-Math.max(...x.matched.map(v=>v.length)))[0];
    if(specific){
      const primary=specific.matched.slice().sort((x,y)=>y.length-x.length)[0];
      return {primary,alternatives:specific.alternatives.slice(0,4),verified:false,topicSource:'starter_lexicon'};
    }
  }
  if(!sourcePhraseIsSafe(source))return null;
  // Only reuse a continuous source span, never fabricate a synonym or splice n-grams.
  return {primary:source,alternatives:[],verified:false};
}

function technicalPhrasesFromText(text){
  // v33: Sliding 2/3-grams created meaningless, repeated phrases from noisy OCR.
  // Return only terms actually found in the curated dictionary; the original
  // uninterrupted feature text is handled separately and is NOT a synonym.
  return dictionaryMatches(text);
}
function queryQuality(q){
  const words=meaningfulTokens(String(q).replace(/\bAND\b|\bOR\b/gi," "));
  const uniq=[...new Set(words.map(x=>foldVN(x).toLowerCase()))];
  return {
    ok: uniq.length>=2,
    terms: uniq,
    score: Math.min(100,uniq.length*22)
  };
}


function buildProSearchRows(){
  const rows=[];let withheld=0;
  for(const f of sharedSearchConcepts()){
    const concept=searchConceptForFeature(f);
    if(!concept)continue;
    const label=f.relatedFeatureIds.length>1
      ?f.id+' (dùng chung ở '+f.relatedFeatureIds.length+' ô)'
      :f.id;
    rows.push([label,concept.primary,concept.alternatives.join('; ')||'—',
      $('ipc').value||'Chưa xác minh',f.relatedFeatureIds]);
  }
  if(state.keywordOnly){
    for(const topic of state.topicRouting?.topics||[])for(const c of topic.matchedConcepts){
      const main=c.matched.slice().sort((x,y)=>y.length-x.length)[0];
      rows.push([topic.name+' · '+c.name,main,c.alternatives.join('; ')||'—','Chưa xác minh',[]]);
    }
  }
  const included=new Set(rows.flatMap(r=>r[4]||[]));
  withheld=(state.features||[]).filter(f=>!included.has(f.id)).length;
  state.searchQualityWarnings=withheld
    ?[withheld+' vị trí đặc điểm chưa có truy vấn: nội dung OCR quá ngắn, trùng bất thường hoặc chưa đủ thuật ngữ có căn cứ; kiểm tra lại claim gốc ở Bước 2–3.']
    :[];
  return rows;
}
function buildProQueries(rows){
  if(state.keywordOnly){
    return topicQueryCandidates().filter(term=>term&&term.length>=3)
      .map(term=>'"'+term.replace(/["\\]/g,'')+'"').slice(0,9);
  }
  const phrases=[];
  const titlePhrase=titleTechnicalPhrase();
  if(titlePhrase) phrases.push(titlePhrase);

  for(const r of rows){
    const vals=[r[1],...(r[2]==="—"?[]:r[2].split(";").map(x=>x.trim()))];
    for(const v of vals){
      if(!v) continue;
      const q=queryQuality(v);
      if(q.ok && !phrases.some(x=>foldVN(x)===foldVN(v))) phrases.push(v);
    }
  }

  const queries=[];
  const add=q=>{
    q=(q||"").trim();
    const curated=topicQueryCandidates().some(term=>window.PATENTLENS_TOPIC_ROUTER.normalize(q)===window.PATENTLENS_TOPIC_ROUTER.normalize(term));
    if(!q || (!queryQuality(q).ok&&!curated)) return;
    if(!queries.some(x=>foldVN(x)===foldVN(q))) queries.push(q);
  };

  // Highest precision: title concept + one feature concept.
  if(!titlePhrase && phrases[0]) add(`"${phrases[0].replace(/["\\]/g,'')}"`);
  if(titlePhrase && phrases[1]) add(`"${titlePhrase}" AND "${phrases[1]}"`);
  if(titlePhrase) add(`"${titlePhrase}"`);

  // Broader recall queries.
  if(phrases.length>=2) add(phrases.slice(0,2).map(x=>`"${x}"`).join(" AND "));
  if(phrases.length>=3) add(phrases.slice(1,3).map(x=>`"${x}"`).join(" AND "));

  // No automatic fallback from arbitrary OCR tokens. If a source has no
  // defensible technical phrase, show the gap instead of inventing search terms.

  for(const term of topicQueryCandidates())add(`"${term.replace(/["\\]/g,'')}"`);
  return queries.slice(0,8);
}
$("claimSelect").onchange=()=>{}; // Giữ ID để tương thích dữ liệu cũ; không chuyển claim thủ công ở đầu luồng.
function invalidateSelectedClaim(){
 state.confirmed=false;state.features=[];state.search=[];state.queries=[];state.searchAudit=[];state.matrix=[];state.evidenceReviews={};state.matrixOverrides={};state.technicalEffects={};state.assessment={};state.reviewData={};state.reviews=0;state.reviewLog.push({time:new Date().toISOString(),action:'claim_changed_revalidation_required'});
}
$("autoFeatures").onclick=()=>{if(!state.claims.length)return alert("Chưa đọc được claims.");autoProcessAllClaims();renderClaims();renderReadiness();};
$("confirmFeatures").onclick=()=>{if(!state.features.length)return alert("Chưa có dấu hiệu.");state.confirmed=true;updateFeatureReviewUI();renderReadiness();renderPerClaimResults();alert((state.claimIssues||[]).length?"Đã xác nhận các dấu hiệu máy tách; còn claim có phụ thuộc nhiều nhánh / thiếu cha phải được kiểm tra riêng, chưa được kết luận: "+state.claimIssues.join(" | "):"Đã xác nhận bộ đặc điểm của tất cả claims có chuỗi phụ thuộc rõ ràng.")};

function updateFeatureReviewUI(){
  const n=state.features.length;
  const bar=$("featureReviewBar");
  const badge=$("featureStatusBadge");
  const label=$("featureCountLabel");
  if(!bar||!badge||!label) return;
  label.textContent=n?`${n} dấu hiệu / ${(state.claims||[]).length} claims`:"Chưa có dấu hiệu";
  if(state.confirmed){
    bar.classList.add("feature-confirmed");
    badge.className="pill green";
    badge.textContent="Đã xác nhận";
    $("featureStatus").value="Đã xác nhận";
    $("confirmFeatures").textContent="✓ Đã xác nhận bộ dấu hiệu";
  }else{
    bar.classList.remove("feature-confirmed");
    badge.className="pill yellow";
    badge.textContent="Chưa xác nhận";
    $("featureStatus").value=n?"Bản nháp tự động":"Chưa tạo";
    $("confirmFeatures").textContent="✓ Xác nhận bộ dấu hiệu";
  }
}
function renderFeatures(){
 $("featureBody").innerHTML=state.features.map((f,i)=>`<tr><td><strong>${f.id}</strong></td><td><textarea data-ft="${i}" style="min-height:72px">${esc(f.text)}</textarea></td><td><select data-ty="${i}"><option ${f.type==="Quy trình"?"selected":""}>Quy trình</option><option ${f.type==="Thành phần/Nguyên liệu"?"selected":""}>Thành phần/Nguyên liệu</option><option ${f.type==="Kiểm soát"?"selected":""}>Kiểm soát</option><option ${f.type==="Thiết bị/Cấu trúc"?"selected":""}>Thiết bị/Cấu trúc</option></select></td><td><span class="pill yellow">${f.conf}</span></td><td><button class="btn danger" data-del="${i}">×</button></td></tr>`).join("");
 document.querySelectorAll("[data-ft]").forEach(x=>x.onchange=()=>{state.features[+x.dataset.ft].text=x.value;state.confirmed=false;state.search=[];state.queries=[];state.searchAudit=[];state.matrix=[];state.matrixOverrides={};state.evidenceReviews={};state.technicalEffects={};state.assessment={};state.reviewData={};state.reviews=0;updateFeatureReviewUI()});document.querySelectorAll("[data-ty]").forEach(x=>x.onchange=()=>state.features[+x.dataset.ty].type=x.value);document.querySelectorAll("[data-del]").forEach(x=>x.onclick=()=>{state.features.splice(+x.dataset.del,1);state.confirmed=false;state.search=[];state.queries=[];state.searchAudit=[];state.matrix=[];state.evidenceReviews={};state.technicalEffects={};state.assessment={};state.reviewData={};state.reviews=0;renderFeatures()});updateFeatureReviewUI()
}

// AUTO-ALL-CLAIMS: mỗi claim giữ một nhóm feature riêng; không cộng toàn bộ claims thành một claim.
function automaticClaimFeatureGroups(){
  const byId=new Map((state.claims||[]).map(c=>[Number(c.id),c]));
  const issues=[],groups=[];let features=[];
  const identicalBodies=new Map();
  for(const claim of state.claims||[]){
    const ownKey=featureTextKey(claim.text);
    if(ownKey.length>50 && identicalBodies.has(ownKey)){
      issues.push(`Claim ${claim.id}: nội dung trùng nguyên văn với Claim ${identicalBodies.get(ownKey)}; có thể OCR/nhận diện sai. Kiểm tra bản gốc, máy chưa tự loại claim nào.`);
    }else if(ownKey.length>50)identicalBodies.set(ownKey,claim.id);
    const lineage=[],seen=new Set();let current=claim;
    while(current){
      if(seen.has(current.id)){issues.push(`Claim ${claim.id}: vòng phụ thuộc không hợp lệ.`);break;}
      seen.add(current.id);lineage.unshift(current);
      const deps=current.dependsOn||[];
      if(deps.length>1){issues.push(`Claim ${claim.id}: phụ thuộc nhiều claim theo nhánh thay thế; cần chuyên gia xác định từng nhánh, máy không tự gộp các nhánh.`);break;}
      if(!deps.length)break;
      if(!byId.has(Number(deps[0]))){issues.push(`Claim ${claim.id}: thiếu claim cha ${deps[0]} trong dữ liệu OCR; cần kiểm tra bản gốc.`);break;}
      current=byId.get(Number(deps[0]));
    }
    const items=[];
    // A parent can be inherited across claims, but only once within each child's claim chart.
    // Keep distinct source claim IDs and non-identical technical limits intact.
    const seenFeatureText=new Map();
    for(const part of lineage){
      const base=featureSplit(part.text||'');
      if(base.length>=200)issues.push(`Claim ${claim.id}: nhận diện ${base.length} đặc điểm từ Claim ${part.id}; cần kiểm tra trùng và quan hệ kỹ thuật trước khi dùng trong nhận định.`);
      const extracted=base.length?base:[{text:String(part.text||''),type:'Chưa phân loại',conf:'Chờ kiểm tra với claim gốc'}];
      for(const f of extracted){
        if(!String(f.text||'').trim())continue;
        const key=normalizeOcrText(f.text).replace(/\s+/g,' ').trim().toLocaleLowerCase();
        if(seenFeatureText.has(key)){
          // Preserve provenance of a literal duplicate rather than multiplying the row.
          const existing=items[seenFeatureText.get(key)];
          if(!existing.alsoFoundInClaims) existing.alsoFoundInClaims=[];
          if(!existing.alsoFoundInClaims.includes(part.id))existing.alsoFoundInClaims.push(part.id);
          continue;
        }
        const out={...f,id:`C${claim.id}-F${String(items.length+1).padStart(2,'0')}`,claimId:claim.id,sourceClaimId:part.id,conf:'Máy tách · cần chuyên gia soát'};
        seenFeatureText.set(key,items.length);
        items.push(out);
      }
    }
    features.push(...items);groups.push({claimId:claim.id,featureIds:items.map(f=>f.id),needsBranchReview:issues.some(x=>x.startsWith(`Claim ${claim.id}:`))});
  }
  return {features,groups,issues};
}
function autoProcessAllClaims(){
  refreshTopicRouting();
  const result=automaticClaimFeatureGroups();
  state.features=result.features;state.claimGroups=result.groups;state.claimIssues=result.issues;
  state.confirmed=false;state.search=[];state.queries=[];state.searchPlan=[];state.searchAudit=[];
  state.searchFacetEdits={};state.searchQualityWarnings=[]; // OCR/claim changes invalidate old generated terms.
  state.matrix=[];state.evidenceReviews={};state.matrixOverrides={};state.assessment={};
  const x=$('autoFeatureOverview');if(x){
    x.innerHTML=`<strong>Đã tự phân tích ${state.claims.length} claim nhận diện được · ${state.features.length} đặc điểm dự thảo.</strong>`+
      `<p>Claim phụ thuộc kế thừa dấu hiệu của claim cha theo nhánh nhận diện. Không cần chọn từng claim.</p>`+
      (result.issues.length?`<p class="status" style="color:#9a3412">${result.issues.map(esc).join('<br>')}</p>`:'')+
      `<small>Máy tách chưa phải xác nhận của chuyên gia. Bước so sánh sẽ có nơi kiểm tra, sửa và xác nhận trước khi dùng kết quả làm căn cứ.</small>`;
  }
  if($('allClaimsInputSummary'))$('allClaimsInputSummary').textContent=`Đã nhận diện ${state.claims.length} claim; máy tự phân tích tất cả các claim đọc được. Không cần chọn từng claim.`;
  if($('claimSelect'))$('claimSelect').innerHTML=state.claims.map((c,i)=>`<option value="${i}">Claim ${c.id}</option>`).join('');
  state.selected=0;
  renderFeatures();
}
function claimFeatures(claimId){return (state.features||[]).filter(f=>Number(f.claimId)===Number(claimId));}
function matrixAllYesForClaim(slot,claimId){
  const feats=claimFeatures(claimId),col={D1:1,D2:2,D3:3}[slot];
  if(!feats.length||!(state.claims||[]).some(c=>Number(c.id)===Number(claimId)))return false;
  return feats.every(f=>{const row=state.matrix.find(r=>r[0]===f.id);return row&&effectiveMatrixStatus(f.id,slot,row[col])==='Có';});
}
function claimNoveltyRows(){
  const blocked=!inputGate().ok||!state.confirmed||!pdfCoverageReady()||!!(state.pdf&&!state.claimCoverage?.completeSequence);
  return (state.claims||[]).map(c=>{
    const group=(state.claimGroups||[]).find(g=>Number(g.claimId)===Number(c.id));
    const date=claimRelevantDate(c.id);
    const gap=(state.claimIssues||[]).some(x=>x.startsWith(`Claim ${c.id}:`));
    if(blocked||gap||!date||!claimFeatures(c.id).length)return {claimId:c.id,date,status:'CHƯA ĐỦ CƠ SỞ',docs:[],note:gap?'Chưa làm rõ nhánh phụ thuộc hoặc thiếu claim cha.':'Chưa đủ xác minh đầu vào, ngày hoặc bộ đặc điểm.'};
    const docs=['D1','D2','D3'].filter(slot=>priorEligible(slot,c.id)===true&&sourceVerified(slot)&&state.priorMeta?.[slot]?.content_level!=='snippet_only'&&!state.priorMeta?.[slot]?.description_truncated&&(!state.matrixScanAudit?.[slot]||state.matrixScanAudit[slot].complete)&&matrixAllYesForClaim(slot,c.id));
    const incomplete=['D1','D2','D3'].filter(slot=>(state.prior?.[slot]?.no||state.prior?.[slot]?.text)&&(priorEligible(slot,c.id)!==true||state.priorMeta?.[slot]?.content_level==='snippet_only'||state.priorMeta?.[slot]?.description_truncated));
    if(docs.length)return {claimId:c.id,date,status:'ỨNG VIÊN CẦN KIỂM TRA TÍNH MỚI',docs,note:'Một tài liệu riêng lẻ có dấu hiệu bộc lộ toàn bộ đặc điểm của claim này; chuyên gia cần kiểm tra bản gốc và căn cứ pháp lý.'};
    return {claimId:c.id,date,status:'CHƯA ĐỦ CƠ SỞ KHẲNG ĐỊNH TÍNH MỚI',docs:[],note:incomplete.length?`Các tài liệu ${incomplete.join(', ')} còn cần kiểm tra ngày/toàn văn.`:'Chưa thấy tài liệu đơn lẻ đủ bằng chứng trong tập đã tra; không chứng minh tính mới.'};
  });
}
function renderPerClaimResults(){
 const root=$('perClaimResults');if(!root)return;
 const rows=claimNoveltyRows();
 root.innerHTML=`<h3>Nhận định theo từng claim · ${rows.length} claim</h3><p class="status">Kết quả là gợi ý theo tập tài liệu đã tìm, không phải kết luận thẩm định. Mỗi claim được xét cùng các giới hạn kế thừa của nhánh phụ thuộc.</p><div class="table-wrap"><table><thead><tr><th>Claim</th><th>Đặc điểm dự thảo</th><th>Mốc ngày khai báo</th><th>Nhận định sơ bộ</th><th>Ứng viên</th></tr></thead><tbody>${rows.map(r=>`<tr><td>Claim ${r.claimId}</td><td>${claimFeatures(r.claimId).length}</td><td>${esc(r.date||'Chưa xác minh')}</td><td><strong>${esc(r.status)}</strong><div class="status">${esc(r.note)}</div></td><td>${esc(r.docs.join(', ')||'—')}</td></tr>`).join('')}</tbody></table></div>`;
}
const dict={
"hạt thanh long":["dragon fruit seed","pitaya seed","Hylocereus seed"],
"nảy mầm":["germination","germinated","sprouting"],
"cellulase":["cellulase","cellulase treatment"],
"pectinase":["pectinase","pectinase treatment"],
"sấy":["drying","dehydration"],"nghiền":["grinding","milling"],
"bột nhàu":["noni powder","Morinda citrifolia powder"],
"độ ẩm":["moisture content","moisture adjustment"],
"đóng gói":["packaging","packing"],
"freeze drying":["lyophilization","freeze dryer"],
"xua muỗi":["mosquito repellent","mosquito repellency","insect repellent"],
"tinh dầu":["essential oil","volatile oil","aromatic oil"],
"tinh dầu vani":["vanilla essential oil","vanilla oil"],
"tinh dầu sả chanh":["lemongrass essential oil","Cymbopogon citratus oil"],
"tinh dầu sả java":["Java citronella oil","Cymbopogon winterianus oil","citronella oil"],
"tinh dầu ôliu":["olive oil"],
"tinh dầu hương thảo":["rosemary oil","Rosmarinus officinalis oil"],
"tinh dầu bạc hà":["peppermint oil","Mentha piperita oil"],
"tinh dầu gỗ hồng":["rosewood oil"],
"tinh dầu gừng":["ginger oil","Zingiber officinale oil"],
"tinh dầu cam":["orange oil","citrus oil"],
"tinh dầu hương nhu":["basil essential oil","Ocimum oil"],
"ylang":["ylang-ylang oil","Cananga odorata oil"],
"phong lữ":["geranium oil","Pelargonium oil"],
"oải hương":["lavender oil","Lavandula oil"],
"đinh hương":["clove oil","Syzygium aromaticum oil"],
"khuấy bằng từ":["magnetic stirring","magnetic stirrer"],
"đồng nhất":["homogenization","homogeneous mixture"],
"ổn định":["stabilization","aging"],
"mosquito":["mosquito repellent","insect repellent"],
"essential oil":["volatile oil","aromatic oil"]
};
$("genSearch").onclick=()=>{
  state.search=buildProSearchRows();
  state.queries=buildProQueries(state.search);
  renderSearch();renderFacetEditor();
};
function renderSearch(){$("searchBody").innerHTML=state.search.map(r=>`<tr><td><strong>${r[0]}</strong></td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join("");$("queryList").innerHTML=(state.searchQualityWarnings||[]).map(w=>`<div class="method-card"><strong>Cần kiểm tra OCR:</strong> ${esc(w)}</div>`).join('')+
    state.queries.map((q,i)=>`<div class="callout"><strong>Q${i+1}</strong><br/><code>${esc(q)}</code></div>`).join("")+
    (!state.queries.length?'<div class="method-card">Chưa tạo được truy vấn có căn cứ. Mở Bước 2 kiểm tra lại PDF/OCR và nội dung claims, sau đó chạy lại.</div>':'')}



function isConfidentialMode(){return !!$("confidentialMode")?.checked}
function updatePrivacyStatus(){
  state.confidentialMode=isConfidentialMode();
  const el=$("privacyStatus"); if(!el)return;
  el.innerHTML=state.confidentialMode
    ? '<span class="pro-badge ok">✓ Local-first</span> Cloud OCR/GenAI tắt. Search chỉ gửi search concepts.'
    : '<span class="pro-badge warn">Cloud assist ON</span> Nội dung trang/evidence có thể được gửi tới API đã cấu hình.';
}
function relevantDateValue(){return selectedClaimRelevantDate()}
function syncRelevantDate(){if($("relevantDate")&&!$("relevantDate").value&&$("filingDate")?.value)$("relevantDate").value=$("filingDate").value;const d=$("relevantDate")?.value||$("filingDate")?.value||"";for(const c of state.claims||[])if(!state.claimDates[c.id]&&d)state.claimDates[c.id]=d;renderClaimMap()}
function publicationDateStatus(c){
  const target=relevantDateValue();
  if(!target)return {label:"Thiếu ngày liên quan",cls:"yellow",eligible:null,reason:"No relevant date"};
  const pub=String(c?.publication_date||"").slice(0,10);
  if(!pub){
    const earlier=(c?.priority_date||c?.filing_date||"").slice(0,10);
    return {label:earlier?"Thiếu ngày công bố · cần xét E/P":"Thiếu ngày công bố",cls:"yellow",eligible:null,reason:"Publication date not verified"};
  }
  const pd=new Date(pub+"T00:00:00"),td=new Date(target+"T00:00:00");
  if(isNaN(pd)||isNaN(td))return {label:"Ngày không hợp lệ",cls:"yellow",eligible:null,reason:"Invalid date"};
  return pd<td
    ?{label:"Công bố trước ngày liên quan",cls:"green",eligible:true,reason:"Published before relevant date"}
    :{label:"Công bố sau mốc · cần xét đơn nộp trước/công bố sau",cls:"yellow",eligible:null,reason:"Not ordinary earlier-publication prior art; filing and priority dates require expert review"};
}

function renderSearchGap(){
  const el=$("searchGapPanel");if(!el)return;
  const audit=state.searchAudit||[],axes=new Set(audit.map(a=>a.axis||a.label||""));
  const checks=[
    {k:'title',label:'Tên sáng chế / concept tổng quát',ok:[...axes].some(x=>/title|tên sáng chế/i.test(x))},
    {k:'function',label:'Công dụng / purpose / effect',ok:[...axes].some(x=>/function|công dụng/i.test(x))},
    {k:'composition',label:'Thành phần / cấu trúc',ok:[...axes].some(x=>/composition|thành phần/i.test(x))},
    {k:'process',label:'Quy trình / cách thực hiện',ok:[...axes].some(x=>/process|quy trình/i.test(x))},
    {k:'feature',label:'Ít nhất 2 feature-specific query',ok:audit.filter(a=>/feature|dấu hiệu/i.test(a.axis||a.label||'')).length>=2},
    {k:'english',label:'English technical concepts',ok:[...axes].some(x=>/english/i.test(x))||resolveAnalysisLanguage()==='en'},
    {k:'class',label:'IPC/CPC đã được chuyên gia xem xét',ok:!!$("ipc")?.value.trim()}
  ];
  state.searchGap=Object.fromEntries(checks.map(x=>[x.k,x.ok]));const ok=checks.filter(x=>x.ok).length;
  el.innerHTML=`<strong>Search gap analysis · ${ok}/${checks.length} hướng đạt</strong><div class="workbench-grid" style="margin-top:10px">${checks.map(x=>`<div class="workbench-card ${x.ok?'gap-ok':'gap-warn'}"><strong>${x.ok?'✓':'!'} ${esc(x.label)}</strong><div class="status">${x.ok?'Đã có trong search audit.':'Còn thiếu / cần chuyên gia cân nhắc bổ sung.'}</div></div>`).join('')}</div><div class="status" style="margin-top:9px">Coverage gate, không phải cam kết search completeness.</div>`;
}
function renderSearchAudit(rawCount=0){
  const el=$("searchAuditPanel"); if(!el)return;
  const audit=state.searchAudit||[];
  const axes=[...new Set(audit.map(x=>x.axis).filter(Boolean))];
  const providers=[...new Set(audit.map(x=>x.provider).filter(Boolean))];
  const pre=(state.candidates||[]).filter(c=>publicationDateStatus(c).eligible===true).length;
  const unknown=(state.candidates||[]).filter(c=>publicationDateStatus(c).eligible===null).length;
  const fail=state.searchFailures||[];
  const tracks=['en','vi','zh','ja','ko','de','fr'].map(lang=>{
    const rows=audit.filter(x=>x.axis==='language_'+lang);
    return rows.length?`${lang.toUpperCase()}: ${rows.length} lượt · ${rows.reduce((n,x)=>n+(Number(x.count)||0),0)} kết quả thô · ${rows.filter(x=>x.status==='ERROR').length} lỗi`:'';
  }).filter(Boolean);
  el.innerHTML=`<strong>Độ phủ tra cứu · ${fail.length} truy vấn lỗi</strong>${fail.length?`<details style="margin:8px 0"><summary>Xem các truy vấn thất bại (chưa được bao phủ)</summary>${fail.map(x=>`<div class="status">${esc(x.label)} · ${esc(x.query)} · ${esc(x.error)}</div>`).join("")}</details>`:""}<div class="professional-grid" style="margin-top:10px">
    <div class="professional-card"><b>Hướng tìm đã chạy</b><strong>${axes.length}</strong></div>
    <div class="professional-card"><b>Lượt tìm có ghi log (gồm cả 0 kết quả và lỗi)</b><strong>${audit.length}</strong></div>
    <div class="professional-card"><b>Kết quả thô</b><strong>${rawCount||audit.reduce((n,x)=>n+(x.count||0),0)}</strong></div>
    <div class="professional-card"><b>Ứng viên công bố trước mốc</b><strong>${pre}</strong></div>
  </div>${tracks.length?`<details style="margin-top:8px"><summary>Lượt tìm đã chạy theo ngôn ngữ (không phải độ phủ quốc gia)</summary><p class="status">${tracks.map(esc).join('<br>')}</p></details>`:''}<div class="status" style="margin-top:8px">Provider: ${esc(providers.join(", ")||"chưa có")} · ${unknown} ứng viên thiếu ngày công bố cần xác minh. Đây là chỉ số <em>coverage</em>, không phải cam kết search completeness.</div>`;
}
function priorEligible(slot,claimId){
  const p=state.prior?.[slot]||{}; const meta=state.priorMeta?.[slot]||{};
  if(!p.no&&!p.text)return null;
  const date=meta.publication_date||p.date;
  if(!date)return null;
  const target=claimId!==undefined?claimRelevantDate(claimId):relevantDateValue(); if(!target)return null;
  const d=new Date(date+"T00:00:00"),t=new Date(target+"T00:00:00");
    return isNaN(d)||isNaN(t)?null:d<t?true:null; // Later publications require separate earlier-filing assessment, not automatic exclusion.
}

function overrideKey(fid,slot){return `${fid}:${slot}`}
function expertConfirmedStatus(fid,slot){
 const review=state.evidenceReviews?.[evidenceReviewKey(fid,slot)];
 return verifiedExpertMatch(fid,slot)&&['Có','Một phần'].includes(review?.expertStatus)?review.expertStatus:null;
}
function effectiveMatrixStatus(fid,slot,autoStatus){
 // A model suggestion never becomes an expert finding without an explicit saved decision.
 return expertConfirmedStatus(fid,slot) || (autoStatus==='Chưa có dữ liệu'?'Chưa có dữ liệu':'Chưa chắc chắn');
}
function matrixAllYes(slot){return (state.claims||[]).some(c=>matrixAllYesForClaim(slot,c.id))}
function matrixPairCovers(a,b){
  const ca={D1:1,D2:2,D3:3}[a],cb={D1:1,D2:2,D3:3}[b];
  return (state.claims||[]).some(c=>{const feats=claimFeatures(c.id);return feats.length&&feats.every(f=>{const r=state.matrix.find(row=>row[0]===f.id);return r&&[effectiveMatrixStatus(r[0],a,r[ca]),effectiveMatrixStatus(r[0],b,r[cb])].some(v=>v==="Có"||v==="Một phần");});});
}
function proposeCitationCategories(){
  const out={};
  for(const slot of ["D1","D2","D3"]){
    const p=state.prior?.[slot]||{};
    if(!p.no&&!p.text){out[slot]={cat:"—",note:"Chưa có tài liệu"};continue}
    const elig=priorEligible(slot);
    if(elig===false){out[slot]={cat:"?",note:"Không dùng như tài liệu công bố trước mốc; cần chuyên gia kiểm tra các ngoại lệ có thể áp dụng."};continue}
    if(elig===null){out[slot]={cat:"?",note:"Ngày/quan hệ đơn nộp trước – công bố sau chưa được chuyên gia xác minh."};continue}
    if(matrixAllYes(slot)){out[slot]={cat:"X",note:"Ứng viên X cho ít nhất một claim; xem kết quả riêng từng claim. Cần kiểm tra evidence trực tiếp."};continue}
    const others=["D1","D2","D3"].filter(x=>x!==slot&&priorEligible(x)===true);
    if(others.some(o=>matrixPairCovers(slot,o)))out[slot]={cat:"Y",note:"Ứng viên Y: kết hợp với tài liệu khác có thể bao phủ feature; chưa chứng minh động cơ kết hợp."};
    else out[slot]={cat:"?",note:"Chưa có đủ căn cứ xếp loại chung cho tất cả claims; xem bảng đối chiếu theo từng claim."};
  }
  state.citationCategories=out; return out;
}
function citationChip(slot){
  const c=(state.citationCategories||{})[slot]; if(!c)return "";
  const cls=String(c.cat||"").toLowerCase().replace(/[^xya]/g,"")||"p";
  return `<span class="citation-chip ${cls}" title="${esc(c.note||"")}">${esc(c.cat||"?")} sơ bộ</span>`;
}
function readinessChecks(){
  readPrior();
  const audit=state.searchAudit||[];
  const selected=Object.values(state.prior||{}).filter(x=>x&&(x.no||x.text)).length;
  const eligible=["D1","D2","D3"].filter(s=>priorEligible(s)===true).length;
  const unknownDates=["D1","D2","D3"].filter(s=>{const p=state.prior?.[s];return p&&(p.no||p.text)&&priorEligible(s)===null}).length;
  const uncertain=state.matrix.reduce((n,r)=>n+r.slice(1,4).filter(v=>v==="Chưa chắc chắn"||v==="Chưa có dữ liệu").length,0);
  readSourceVerification();const selectedSlots=["D1","D2","D3"].filter(s=>state.prior?.[s]?.no||state.prior?.[s]?.text);const verifiedSources=selectedSlots.length>0&&selectedSlots.every(sourceVerified);const closest=$("closest")?.value||"";const effectsOk=!!closest&&state.matrix.length?technicalEffectsReady(closest):false;
  return [
    {label:"Mọi claim máy nhận diện đã có nhóm đặc điểm",ok:!!state.claims.length&&state.claims.every(c=>claimFeatures(c.id).length>0),hard:true},
    {label:"PDF đầu vào: mọi trang đọc chữ đã kiểm tra, không bỏ qua trang OCR lỗi",ok:pdfCoverageReady(),hard:true},
    {label:"Số thứ tự các claim nhận diện liên tục (vẫn cần so PDF gốc)",ok:!!state.claimCoverage?.completeSequence,hard:!!state.pdf},
    {label:"Các lượt so sánh AI đã chạy hết VĂN BẢN NHẬP cho từng D (nếu đã bật AI)",ok:matrixCoverageReady(),hard:Object.keys(state.matrixScanAudit||{}).length>0},
    {label:"Bộ dấu hiệu kỹ thuật đã được xác nhận",ok:state.confirmed&&state.features.length>0,hard:true},
    {label:"Đã xác minh phiên bản claims, nguồn dữ liệu và ngày liên quan",ok:inputGate().ok,hard:true},
    {label:"Đã chạy chiến lược tra cứu đa hướng",ok:audit.length>=3,hard:false},
    {label:"Đã chọn ít nhất một tài liệu công bố trước ngày liên quan",ok:eligible>=1,hard:true},
    {label:"Đã chọn D1–D3 / tài liệu bổ sung",ok:selected>=2,hard:false},
    {label:"Ma trận evidence đã được tạo",ok:state.matrix.length===state.features.length&&state.matrix.length>0,hard:true},
    {label:"Nguồn D1–D3 đã xác minh identity + publication date + evidence",ok:verifiedSources,hard:true},
    {label:"Tất cả ô máy đề xuất Có/Một phần đã được chuyên gia xem xét",ok:state.matrix.every(r=>["D1","D2","D3"].every(s=>!(["Có","Một phần"].includes(r[{D1:1,D2:2,D3:3}[s]]))||verifiedExpertMatch(r[0],s))),hard:false},
    {label:"Tác dụng kỹ thuật của các dấu hiệu khác biệt đã được xác minh",ok:effectsOk,hard:false},
    {label:"Không còn ô 'Chưa có dữ liệu' quan trọng",ok:uncertain===0,hard:false},
    {label:"Ngày công bố của tài liệu đã được xác minh",ok:unknownDates===0,hard:true}
  ];
}
function renderReadiness(){
  const el=$("readinessPanel"); if(!el)return;
  const checks=readinessChecks(); const ok=checks.filter(x=>x.ok).length;
  const hardFail=checks.filter(x=>x.hard&&!x.ok).length;
  const pct=Math.round(ok/checks.length*100);
  const cls=hardFail?"warn":"ok";
  el.innerHTML=`<strong>Điều kiện cần kiểm tra</strong> <span class="pro-badge ${cls}">${ok}/${checks.length} mục · ${hardFail?hardFail+" điều kiện bắt buộc chưa đạt":"đủ điều kiện cơ bản"}</span>
    <div class="readiness-list">${checks.map(x=>`<div class="readiness-item ${x.ok?"ok":x.hard?"bad":"warn"}"><span class="readiness-icon">${x.ok?"✓":x.hard?"!":"?"}</span><div>${esc(x.label)}${x.hard&&!x.ok?'<div class="status">Bắt buộc trước khi dùng kết quả như đánh giá sơ bộ đáng tin cậy.</div>':''}</div></div>`).join("")}</div>`;
  state.assessmentChecks={pct,hardFail,checks};
}
function collectCouldWould(){
  const o={}; document.querySelectorAll('[data-cw]').forEach(el=>{const k=el.dataset.cw;o[k]={status:el.value,note:document.querySelector(`[data-cw-note="${k}"]`)?.value||""}});return o;
}

function deepSearchPrerequisites(){
 if(!$('externalSearchConsent')?.checked)return 'Bạn cần đồng ý gửi từ khóa ra dịch vụ bên ngoài ở bước này.';
 if(!state.confirmed||!state.features?.length)return 'Hãy tạo và xác nhận đặc điểm kỹ thuật ở bước 3 trước.';
 if(!inputGate(false).ok)return 'Cần chọn mục đích, nhập claim và xác định loại hồ sơ trước khi tìm.';
 if(!$('deepAccessCode')?.value?.trim())return 'Hãy nhập mã truy cập do quản trị viên cấp để dùng tính năng AI có phí.';
 return '';
}
async function guardedResearchRequest(path,payload){
 const r=await fetch(path,{method:'POST',headers:apiHeaders({'content-type':'application/json','x-deep-access-code':$('deepAccessCode').value.trim()}),body:JSON.stringify(payload),cache:'no-store'});
 const d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw new Error(d.error||'Không kết nối được nguồn dữ liệu.');return d;
}
function mergeDeepCandidates(raw,query,provider){
 const seen=new Set((state.candidates||[]).map(c=>normalizedPublication(c.publication_number)));
 let added=0,skipped=0;
 for(const x of raw){
  const n=normalizedPublication(x.publication_number);
  if(!n||seen.has(n)||exactTargetIdentifierSet().has(n)||targetOverlapReason(x)){skipped++;continue}
  const c={...x,score:0,search_axis:'deep',search_label:'Tìm thêm theo đặc điểm',search_query:query,provider};
  c.score=scoreCandidate(c);state.candidates.push(c);seen.add(n);added++;
 }
 renderCandidates();renderSearchAudit();renderSearchGap();return {added,skipped};
}
async function runDeepQuery(q,btn){
 if(!$('externalSearchConsent')?.checked)return alert('Cần đồng ý gửi từ khóa để tìm kiếm.');
 const g=inputGate(false);if(!g.ok)return alert('Cần chọn loại hồ sơ và có claims trước khi tìm kiếm.');
 btn.disabled=true;$('deepFeedback').textContent='Đang tìm song song trên những nguồn sáng chế đã cấu hình…';
 try{
  const d=await guardedResearchRequest('/api/deep-patents',{query:q});
  const m=mergeDeepCandidates(d.results||[],q,d.provider||'');
  state.searchAudit.push({axis:'deep',label:'AI gợi ý – đã tra cứu thật',query:q,provider:d.provider||'',count:(d.results||[]).length,time:new Date().toISOString()});
  state.reviewLog.push({time:new Date().toISOString(),action:'deep_query',query:q,provider:d.provider||'',added:m.added});
  renderSearchAudit();renderSearchGap();
  $('deepFeedback').textContent=`Đã bổ sung ${m.added} tài liệu ứng viên; bỏ ${m.skipped} tài liệu trùng mục tiêu hoặc đã có. Chưa xác minh bằng chứng.`;
 }catch(e){$('deepFeedback').textContent='Tìm chưa thành công: '+String(e.message||e)}finally{btn.disabled=false}
}
$('suggestDeep').onclick=async()=>{
 if(isConfidentialMode()){ $('deepFeedback').textContent='Đang bật bảo mật: không gửi đặc điểm kỹ thuật sang AI ngoài. Hãy chỉ tắt sau khi được phép xử lý dữ liệu này.'; return; }
 const issue=deepSearchPrerequisites();if(issue)return alert(issue);
 const button=$('suggestDeep');button.disabled=true;$('deepFeedback').textContent='AI đang gợi ý cách tìm; chưa thực hiện tìm kiếm.';
 try{
  const features=state.features.slice(0,4).map(f=>({id:f.id,text:f.text}));
  const d=await guardedResearchRequest('/api/ai-queries',{features,title:$('title').value||''});
  const box=$('deepQueries');box.replaceChildren();
  for(const item of d.queries||[]){
    const row=document.createElement('div');row.className='deep-item';
    const head=document.createElement('b');head.textContent=item.feature_id+' · '+item.query;
    const note=document.createElement('p');note.textContent=item.reason||'Từ khóa AI gợi ý, cần kiểm tra trước khi dùng.';
    const go=document.createElement('button');go.className='btn';go.type='button';go.textContent='Tìm bằng cụm này →';go.onclick=()=>runDeepQuery(item.query,go);
    row.append(head,note,go);box.append(row);
  }
  $('deepFeedback').textContent=`AI đề xuất ${(d.queries||[]).length} cách tìm. Đã gửi các đặc điểm kỹ thuật được chọn tới Gemini; mỗi truy vấn tiếp theo chỉ gửi khi bạn bấm Tìm.`;
 }catch(e){$('deepFeedback').textContent='Không thể dùng AI tìm sâu: '+String(e.message||e)}finally{button.disabled=false}
};
$('searchScholarly').onclick=async()=>{
 const issue=deepSearchPrerequisites();if(issue)return alert(issue);
 const q=String($('liveSearchQuery').value||state.queries[0]||'').trim();if(q.length<6)return alert('Nhập một cụm từ kỹ thuật cần tìm.');
 const btn=$('searchScholarly');btn.disabled=true;$('deepFeedback').textContent='Đang tìm metadata bài báo khoa học…';
 try{
  const d=await guardedResearchRequest('/api/scholarly',{query:q});
  const box=$('scholarlyResults');box.replaceChildren();
  for(const x of d.results||[]){
    const row=document.createElement('div');row.className='deep-item';const name=document.createElement('b');name.textContent=x.title;
    const meta=document.createElement('p');meta.textContent=`${x.year||'Chưa rõ năm'} · DOI: ${x.doi} · Chỉ có thư mục, chưa đọc toàn văn`;
    const a=document.createElement('a');a.textContent='Mở tài liệu gốc để đọc ↗';a.href=x.url;a.target='_blank';a.rel='noopener noreferrer';
    row.append(name,meta,a);box.append(row);
  }
  state.reviewLog.push({time:new Date().toISOString(),action:'scholarly_discovery',query:q,count:(d.results||[]).length,source:'Crossref metadata only'});
  $('deepFeedback').textContent=`Tìm được ${(d.results||[]).length} thông tin bài báo; chưa có toàn văn và chưa tự đưa vào kết luận tính mới.`;
 }catch(e){$('deepFeedback').textContent='Không thể tìm bài báo: '+String(e.message||e)}finally{btn.disabled=false}
};

function backendBase(){
  return location.origin;
}
function saveBackend(){
  state.backendUrl=location.origin;
}
function updateOfficialSearchLinks(q){
  const query=q||$("liveSearchQuery").value||state.queries[0]||"";
  $("gpLink").href="https://patents.google.com/?q="+encodeURIComponent(query);
  $("wipoLink").href="https://patentscope.wipo.int/search/en/advancedSearch.jsf?query="+encodeURIComponent('EN_ALLTXT:('+query+')');
  $("epoLink").href="https://worldwide.espacenet.com/patent/search?q="+encodeURIComponent(query);
}
function useGeneratedQuery(){
  let q="";
  if(state.queries.length){
    q=state.queries[0];
  }else if(state.features.length){
    const rows=buildProSearchRows();
    const qs=buildProQueries(rows);
    q=qs[0]||"";
  }else{
    q=$("title").value||"";
  }
  $("liveSearchQuery").value=q;
  updateOfficialSearchLinks(q);
  return q;
}
function cleanPatentHtml(s){
  const d=document.createElement("textarea");
  d.innerHTML=(s||"").replace(/<[^>]*>/g," ");
  return d.value.replace(/\s+/g," ").trim();
}
function targetDateObj(){const v=relevantDateValue();return v?new Date(v+"T00:00:00"):null;}

function decodeHtmlEntitiesClient(s){
  const ta=document.createElement("textarea");
  ta.innerHTML=String(s||"");
  return ta.value;
}
function mojibakePenalty(s){
  return (String(s||"").match(/(?:Ã.|Â.|â€|�|ðŸ)/g)||[]).length;
}
function tryFixUtf8MojibakeClient(s){
  let t=String(s||"");
  if(mojibakePenalty(t)===0) return t;
  try{
    const bytes=Uint8Array.from([...t].map(ch=>ch.charCodeAt(0)&255));
    const d=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
    if(mojibakePenalty(d)<mojibakePenalty(t)) return d;
  }catch(_e){}
  return t;
}
function cleanPatentContent(s){
  let t=decodeHtmlEntitiesClient(s||"");
  t=tryFixUtf8MojibakeClient(t)
    .replace(/\uFEFF|\u00AD/g,"")
    .replace(/[\u200B-\u200D\u2060]/g,"")
    .normalize("NFC")
    .replace(/[“”]/g,'"').replace(/[‘’]/g,"'")
    .replace(/[‐‑‒–—]/g,"-")
    .replace(/\u00a0/g," ")
    .replace(/[ \t]+/g," ")
    .replace(/ +\n/g,"\n")
    .replace(/\n +/g,"\n")
    .replace(/\n{3,}/g,"\n\n")
    .replace(/\s+([,.;:%\)])/g,"$1")
    .trim();
  return t;
}
function formatPriorDocument(d,c){
  const parts=[];
  const title=cleanPatentContent(d?.title||c?.title||"");
  const abstract=cleanPatentContent(d?.abstract||"");
  const snippet=cleanPatentContent(c?.snippet||"");
  const description=cleanPatentContent(d?.description||"");
  let claims=cleanPatentContent(d?.claims||"");
  claims=claims.replace(/\s+(?=(?:\d{1,3})[\.)]\s+)/g,"\n");

  let lang=(d?.language||c?.language||"").toLowerCase();
  if(lang.startsWith("vi")) lang="vi";
  else if(lang.startsWith("en")) lang="en";
  else{
    const det=detectTextLanguage([title,abstract,claims.slice(0,2000)].join("\n"));
    lang=det.lang;
  }

  if(lang==="vi"){
    if(title) parts.push("TIÊU ĐỀ\n"+title);
    if(abstract) parts.push("TÓM TẮT (TRÍCH XUẤT)\n"+abstract);
    else if(snippet)parts.push("ĐOẠN GIỚI THIỆU TÌM KIẾM — KHÔNG PHẢI TOÀN VĂN\n"+snippet);
    if(description)parts.push("MÔ TẢ TRÍCH XUẤT — CẦN KIỂM TRA BẢN GỐC/HÌNH VẼ\n"+description);
    if(claims) parts.push("YÊU CẦU BẢO HỘ\n"+claims);
  }else if(lang==="en"){
    if(title) parts.push("TITLE\n"+title);
    if(abstract) parts.push("ABSTRACT (EXTRACTED)\n"+abstract);
    else if(snippet)parts.push("SEARCH SNIPPET — NOT VERIFIED AS ABSTRACT / FULL TEXT\n"+snippet);
    if(description)parts.push("DESCRIPTION EXTRACT — CHECK ORIGINAL, FIGURES AND COMPLETENESS"+(d?.description_truncated?" (TRUNCATED)":"")+"\n"+description);
    if(claims) parts.push("CLAIMS\n"+claims);
  }else{
    if(title) parts.push(`[${String(lang||"SOURCE").toUpperCase()}] TITLE\n`+title);
    if(abstract) parts.push(`[${String(lang||"SOURCE").toUpperCase()}] ABSTRACT EXTRACT\n`+abstract);
    else if(snippet)parts.push(`SEARCH SNIPPET — NOT VERIFIED FULL TEXT\n`+snippet);
    if(description)parts.push(`[${String(lang||"SOURCE").toUpperCase()}] DESCRIPTION EXTRACT — CHECK ORIGINAL\n`+description);
    if(claims) parts.push(`[${String(lang||"SOURCE").toUpperCase()}] CLAIMS\n`+claims);
  }
  return parts.join("\n\n");
}
function priorTextQuality(s){
  const t=cleanPatentContent(s||"");
  if(!t) return {ok:false,label:"Chưa có nội dung"};
  const bad=mojibakePenalty(t)+(t.match(/[�□■]/g)||[]).length;
  const letters=(t.match(/\p{L}/gu)||[]).length;
  const ratio=letters/Math.max(1,t.length);
  return bad===0&&ratio>.35
    ?{ok:true,label:"Unicode sạch"}
    :{ok:false,label:"Cần kiểm tra encoding"};
}
function updatePriorQuality(slot){
  const n=slot.slice(1), el=$("priorQuality"+slot);
  if(!el) return;
  const q=priorTextQuality($(`d${n}Text`).value);
  el.className=q.ok?"prior-meta prior-clean-ok":"prior-meta prior-clean-warn";
  el.textContent=q.ok?"✓ Nội dung đã chuẩn hóa Unicode NFC":"⚠ "+q.label;
}
function cleanAllPriorSlots(){
  for(const slot of ["D1","D2","D3"]){
    const n=slot.slice(1);
    $(`d${n}Text`).value=cleanPatentContent($(`d${n}Text`).value);
    updatePriorQuality(slot);
  }
  readPrior();
}
function candidateDateStatus(c){return publicationDateStatus(c)}

function candidateConceptGroups(){
  const groups=[];
  const add=(label,terms,weight=1)=>{
    const vals=[...new Set((terms||[]).map(x=>foldVN(cleanPatentContent(x)).toLowerCase()).filter(x=>x.length>=3))];
    if(vals.length&&!groups.some(g=>g.label===label)) groups.push({label,terms:vals,weight});
  };

  for(const f of state.features){
    const ft=foldVN(f.text).toLowerCase();
    for(const [k,vals] of Object.entries(dict)){
      if(ft.includes(foldVN(k).toLowerCase())) add(k,[k,...vals],k.split(/\s+/).length>1?2:1.3);
    }
    for(const phrase of technicalPhrasesFromText(f.text).slice(0,4)) add(phrase,[phrase],phrase.split(/\s+/).length>1?1.5:1);
  }
  return groups.slice(0,28);
}
function scoreCandidate(c){
  const title=foldVN(cleanPatentContent(c.title||"")).toLowerCase();
  const snippet=foldVN(cleanPatentContent(c.snippet||"")).toLowerCase();
  const blob=title+" "+snippet;
  const groups=candidateConceptGroups();
  if(!groups.length) return 40;

  let got=0,total=0,titleBonus=0;
  for(const g of groups){
    total+=g.weight;
    const hit=g.terms.some(t=>blob.includes(t));
    if(hit){
      got+=g.weight;
      if(g.terms.some(t=>title.includes(t))) titleBonus+=Math.min(2,g.weight)*4;
    }
  }
  let score=Math.round((got/Math.max(1,total))*82+titleBonus);
  const ds=candidateDateStatus(c);
  if(ds.eligible===false) score-=30;
  if(ds.eligible===true) score+=4;
  return Math.max(0,Math.min(99,score));
}
function candidateReadingScope(c){
  const title=cleanPatentContent(c?.title||'').trim(),snippet=cleanPatentContent(c?.snippet||'').trim();
  const terms=candidateConceptGroups();const titleText=foldVN(title).toLowerCase(),abstractText=foldVN(snippet).toLowerCase();
  const titleTerms=terms.filter(g=>g.terms.some(t=>titleText.includes(t))).map(g=>g.text||g.name||g.terms[0]);
  const snippetTerms=terms.filter(g=>g.terms.some(t=>abstractText.includes(t))).map(g=>g.text||g.name||g.terms[0]);
  return {scope:snippet?'Tiêu đề + snippet':'Chỉ metadata/tiêu đề',titleHits:titleTerms.length,snippetHits:snippetTerms.length,
    note:'Chưa đọc toàn văn; những từ khớp không chứng minh tài liệu bộc lộ đặc điểm kỹ thuật.'};
}
function selectedSlotsForCandidate(i){
  const out=[];
  for(const slot of ["D1","D2","D3"]){
    if(state.selectedCandidates?.[slot]===i) out.push(slot);
  }
  return out;
}

function syncSelectedCandidatesFromInputs(){
  if(!state.selectedCandidates) state.selectedCandidates={D1:null,D2:null,D3:null};
  for(const slot of ["D1","D2","D3"]){
    const n=slot.slice(1);
    const no=cleanPatentContent($(`d${n}No`)?.value||"");
    if(!no){state.selectedCandidates[slot]=null;continue}
    const idx=state.candidates.findIndex(c=>
      cleanPatentContent(c.publication_number||"").toLowerCase()===no.toLowerCase()
    );
    state.selectedCandidates[slot]=idx>=0?idx:state.selectedCandidates[slot];
  }
}

function updatePriorSlotVisuals(){
  for(const slot of ["D1","D2","D3"]){
    const n=slot.slice(1);
    const has=!!cleanPatentContent($(`d${n}No`)?.value||"");
    const el=$("slot"+slot);
    if(el) el.classList.toggle("has-doc",has);
  }
}

function renderCandidates(){
  if(!state.candidates.length){
    $("candidateBody").innerHTML='<tr><td colspan="6" style="color:#98a2b3;text-align:center">Không có kết quả để hiển thị.</td></tr>';
    updatePriorSlotVisuals();
    return;
  }

  syncSelectedCandidatesFromInputs();

  $("candidateBody").innerHTML=state.candidates.map((c,i)=>{
    c.score=scoreCandidate(c);
    const ds=candidateDateStatus(c);
    const scope=candidateReadingScope(c);
    const scoreCls=c.score>=65?"high":c.score>=35?"mid":"low";
    const date=c.publication_date||"—";
    const selected=selectedSlotsForCandidate(i);

    const selectedTags=selected.length
      ? `<div class="selected-slots">${selected.map(s=>`<span class="selected-tag ${s.toLowerCase()}">✓ Đã chọn ${s}</span>`).join("")}</div>`
      : "";

    const buttons=["D1","D2","D3"].map(slot=>{
      const isSelected=selected.includes(slot);
      return `<button class="slotbtn slot-${slot.toLowerCase()}${isSelected?" is-selected":""}" data-slot="${slot}" data-candidate="${i}">
        ${isSelected?"Đã chọn ":""}${slot}
      </button>`;
    }).join("");

    return `<tr class="${selected.length?"candidate-selected-row":""}">
      <td>${i+1}</td>
      <td style="min-width:350px">
        <a class="search-result-title" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.publication_number||"Patent")} · ${esc(cleanPatentContent(c.title||"Không có tiêu đề"))}</a>
        ${selectedTags}
        ${targetOverlapReason(c)?`<div class="target-warning">⚠ ${esc(targetOverlapReason(c))} — không tự động chọn làm D1–D3</div>`:""}
        <div class="status" style="margin-top:5px">${esc(cleanPatentContent(c.snippet||""))}</div>
        <div class="status" style="margin-top:5px"><strong>Đã xem để xếp đọc:</strong> ${esc(scope.scope)} · ${scope.titleHits} nhóm thuật ngữ khớp tiêu đề, ${scope.snippetHits} nhóm khớp snippet. <em>${esc(scope.note)}</em></div>
        ${c.search_label?`<div class="status" style="margin-top:5px"><strong>Hướng tìm:</strong> ${esc(c.search_label)} · <span title="${esc(c.search_query||"")}">${esc(c.search_query||"")}</span></div>`:""}
        <div class="source-row" style="margin-top:7px">
          <a class="source-chip" href="${esc(/^https?:\/\//i.test(String(c.url||''))?c.url:'https://patents.google.com/')}" target="_blank" rel="noopener">Mở tài liệu ↗</a>
          <a class="source-chip" href="https://patentscope.wipo.int/search/en/advancedSearch.jsf?query=${encodeURIComponent('ALLNUM:('+c.publication_number+')')}" target="_blank" rel="noopener">WIPO ↗</a>
          <a class="source-chip" href="https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent('pn='+c.publication_number)}" target="_blank" rel="noopener">Espacenet ↗</a>
        </div>
      </td>
      <td>${esc(date)}</td>
      <td><span class="score ${scoreCls}">Đề xuất đọc: ${c.score>=65?"Sớm":c.score>=35?"Tiếp theo":"Khi cần"}</span><div class="status">Chỉ dựa metadata/snippet, không phải xác suất thiếu tính mới.</div></td>
      <td><span class="pill ${ds.cls}">${ds.label}</span></td>
      <td><div class="candidate-actions">${buttons}</div></td>
    </tr>`;
  }).join("");

  document.querySelectorAll("[data-candidate]").forEach(
    b=>b.onclick=()=>selectCandidateToSlot(+b.dataset.candidate,b.dataset.slot)
  );
  updatePriorSlotVisuals();
}

const PRIOR_ART_AXES={
  function:["xua muỗi","repellent","mosquito","insect repellent","insecticidal","pest control"],
  composition:["tinh dầu","essential oil","volatile oil","aromatic oil","composition","formulation","blend","mixture"],
  process:["quy trình","phương pháp","process","method","mixing","stirring","magnetic stirring","homogenization"],
  material:["vani","vanilla","sả chanh","lemongrass","sả java","citronella","bạc hà","peppermint","hương thảo","rosemary","phong lữ","geranium","oải hương","lavender","ylang","clove","gừng","ginger"],
  condition:["30 phút","24 giờ","36 giờ","concentration","duration","temperature","time"]
};

function clientCoreWords(s){
  return String(s||"")
    .replace(/["'()]/g," ")
    .replace(/\b(?:AND|OR|NOT)\b/gi," ")
    .split(/[^\p{L}\p{N}\-\/\.]+/u)
    .map(x=>x.trim())
    .filter(Boolean)
    .filter(x=>{
      const f=foldVN(x).toLowerCase();
      return f.length>=3 && !SEARCH_STOP.has(f);
    });
}

function uniqueTerms(arr){
  const out=[];
  for(const x of arr){
    const v=String(x||"").trim();
    if(!v) continue;
    if(!out.some(y=>foldVN(y).toLowerCase()===foldVN(v).toLowerCase())) out.push(v);
  }
  return out;
}

function searchAxisMatches(){
  const corpus=[
    $("title").value||"",
    ...sharedSearchFeatures().filter(f=>!!searchConceptForFeature(f)).map(f=>f.text||"")
  ].join(" ");
  const folded=foldVN(corpus).toLowerCase();
  const axes={};
  for(const [axis,terms] of Object.entries(PRIOR_ART_AXES)){
    axes[axis]=terms.filter(t=>folded.includes(foldVN(t).toLowerCase()));
  }
  return axes;
}

function featureQueryPhrases(){
  return uniqueTerms(sharedSearchConcepts().map(f=>searchConceptForFeature(f)?.primary).filter(Boolean)).slice(0,6);
}
// v19: editable per-feature query facets. No machine translation is treated as a validated synonym.
function facetSuggestions(f){
  return searchConceptForFeature(f)?.alternatives||[];
}
function defaultFacetTerms(f){
  const concept=searchConceptForFeature(f);
  if(!concept)return [];
  return uniqueTerms([concept.primary,...concept.alternatives]);
}
function facetTerms(f){
 if(!searchConceptForFeature(f))return [];
 const user=state.searchFacetEdits?.[f.id];
 const lines=user===undefined?defaultFacetTerms(f):user.split(/[\n;]+/).map(s=>s.trim()).filter(Boolean);
 return uniqueTerms(lines.map(s=>s.replace(/[<>`]/g," ").trim()).filter(s=>s.length>=4)).slice(0,8);
}
function renderFacetEditor(){
 const root=$("facetEditor");if(!root)return;
 root.innerHTML=sharedSearchConcepts().map(f=>{
   const terms=state.searchFacetEdits?.[f.id]??defaultFacetTerms(f).join("\n");
   return `<div class="facet-card"><strong>${esc(f.id)} · ${esc(f.type||"Đặc điểm")}</strong>${f.relatedFeatureIds.length>1?`<div class="status">Một bộ từ tìm dùng cho ${f.relatedFeatureIds.length} vị trí; KHÔNG đồng nghĩa các giới hạn kỹ thuật giống nhau. Bảng đối chiếu vẫn giữ riêng từng claim.</div>`:''}<p>${esc(f.text||"")}</p><label for="facet-${esc(f.id)}">Biến thể tra cứu đã kiểm tra · mỗi dòng 1 cụm</label><textarea id="facet-${esc(f.id)}" data-facet="${esc(f.id)}" placeholder="Thêm thuật ngữ có căn cứ...">${esc(terms)}</textarea><div class="status">Gợi ý chưa xác minh. Sửa hoặc xóa từ không tương đương trước khi tìm.</div></div>`;
 }).join("")||(state.keywordOnly?'<div class="status">Chưa có claims. Đây là giai đoạn tìm hiểu bằng từ khóa/chủ đề; ma trận và nhận định tính mới chỉ thực hiện khi có claims.</div>':'<div class="status">Chưa có đặc điểm kỹ thuật. Kiểm tra lại claims ở Bước 2–3.</div>');
 root.querySelectorAll('[data-facet]').forEach(el=>el.onchange=()=>{
   state.searchFacetEdits[el.dataset.facet]=el.value;
   renderPlanPreview();
 });
 renderPlanPreview();
}
function renderPlanPreview(){
 const el=$("planPreviewContent");if(!el)return;
 const plan=buildDiverseSearchPlan();
 el.innerHTML=(state.searchPlanSkipped?.length?`<div class="method-card" style="margin-bottom:8px"><strong>CẢNH BÁO:</strong> các dấu hiệu ${state.searchPlanSkipped.length} vị trí (${esc(state.searchPlanSkipped.slice(0,12).join(", "))}${state.searchPlanSkipped.length>12?'…':''}) chưa có truy vấn trong đợt này do chưa có thuật ngữ hợp lệ hoặc giới hạn 16 query. Nếu PDF/OCR sai, sửa nội dung ở Bước 2 trước khi tìm tiếp.</div>`:"")+(plan.length?plan.map((p,i)=>`<div class="evidence-block"><strong>Q${i+1} · ${esc(p.label)}</strong><br><code>${esc(p.query)}</code> · ${esc(p.axis)}</div>`).join(""):'Chưa tạo được query: kiểm tra lại features.');
}
if($("refreshFacets"))$("refreshFacets").onclick=()=>{state.searchFacetEdits={};renderFacetEditor();};

function buildDiverseSearchPlan(){
 const plan=[];
 const add=(label,query,axis,mode="balanced")=>{
   query=String(query||"").replace(/\s+/g," ").trim().slice(0,180);
   const core=clientCoreWords(query);
   if(core.length<2 && !(core.length===1 && core[0].length>=6 && (axis==="feature"||axis==="topic")))return;
   if(plan.some(x=>foldVN(x.query).toLowerCase()===foldVN(query).toLowerCase()))return;
   plan.push({label,query,axis,mode});
 };
 const title=titleTechnicalPhrase(),axes=searchAxisMatches();
 for(const term of topicQueryCandidates().slice(0,state.keywordOnly?9:3))add('Định tuyến · '+topicNameForTerm(term),`"${term.replace(/["\\]/g,'')}"`,'topic','broad');
 if(title)add("Khái niệm tổng quát",title,"title","broad");
 if(axes.function.length)add("Công dụng / mục đích",axes.function.slice(0,3).join(" "),"function","broad");
 const comp=uniqueTerms([...axes.composition,...axes.material]);
 if(comp.length>=2)add("Thành phần / cấu trúc",comp.slice(0,4).join(" "),"composition","balanced");
 if(axes.process.length>=2)add("Quy trình / phương pháp",axes.process.slice(0,4).join(" "),"process","balanced");
 const feats=sharedSearchConcepts();
 // Round robin over UNIQUE search concepts. Inherited features still appear
 // independently in each claim chart/matrix, never combined for novelty.
 // Round robin: first cover as many different features as possible.
 for(let pass=0;pass<3;pass++)for(const f of feats){
   const terms=facetTerms(f);
   if(pass===0&&terms.length)add(`${f.id} · đơn lẻ`,terms[0],"feature","broad");
   if(pass===1&&terms.length>1)add(`${f.id} · từ thay thế`,terms[1],"feature","broad");
   if(pass===2&&title&&terms.length)add(`${f.id} · cùng chủ đề`,`${terms[0]} ${title.split(" ").slice(0,3).join(" ")}`,"feature","balanced");
 }
 // Provider budget applies PER RUN, not completeness of the case.
 state.searchPlan=plan.slice(0,16);
 const covered=new Set(feats.filter(f=>state.searchPlan.some(p=>p.label.startsWith(f.id+" ·")))
   .flatMap(f=>f.relatedFeatureIds));
 state.searchPlanSkipped=(state.features||[]).filter(f=>!covered.has(f.id)).map(f=>f.id);
 return state.searchPlan;
}
function patentFamilyKey(c){
  // This is a publication identifier ONLY, not an INPADOC/simple-family grouping.
  // A1 and B2 remain separate records because claims and dates may differ.
  return normalizedPublication(c.publication_number)||String(c.url||'');
}

function candidateFingerprint(c){
  return foldVN([c.title||"",c.snippet||"",c.assignee||""].join(" "))
    .toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}

function jaccardText(a,b){
  const A=new Set(String(a||"").split(/\s+/).filter(x=>x.length>3));
  const B=new Set(String(b||"").split(/\s+/).filter(x=>x.length>3));
  if(!A.size||!B.size) return 0;
  let i=0;
  for(const x of A) if(B.has(x)) i++;
  return i/(A.size+B.size-i);
}

function diversifyPriorArt(rows,target=24){
  const sorted=rows.slice().sort((a,b)=>(b.score||0)-(a.score||0));
  const out=[];
  const fam=new Set();
  const perAxis={};

  // First pass: quota by axis = true diversity.
  for(const c of sorted){
    const family=patentFamilyKey(c)||c.url;
    if(fam.has(family)) continue;
    const axis=c.search_axis||"other";
    perAxis[axis]=perAxis[axis]||0;
    if(perAxis[axis]>=2) continue;

    // Do not collapse distinct publications based only on a similar title/snippet.

    out.push(c); fam.add(family); perAxis[axis]++;
    if(out.length>=target) return out;
  }

  // Second pass: fill, still remove same family / near duplicate.
  for(const c of sorted){
    const family=patentFamilyKey(c)||c.url;
    if(fam.has(family)) continue;
    // Keep A1/B2 and cross-country publications separate until an actual family ID exists.
    out.push(c); fam.add(family);
    if(out.length>=target) break;
  }
  return out;
}

async function searchRealPatents(){
  if(!(state.features||[]).length&&!state.keywordOnly){alert("Chưa tách được đặc điểm từ các claims. Hãy kiểm tra PDF ở Bước 2.");return;}
  const g=inputGate(false);if(!g.ok&&!state.keywordOnly){renderInputGate();alert("Cần chọn mục đích và có phần claims trước khi tra cứu.\n"+g.issues.join("\n"));return}
  if(state.keywordOnly&&!state.topicRouting?.topics?.length){alert("Từ khóa hiện chưa khớp kho thuật ngữ. Hãy sửa đầu vào hoặc nhập truy vấn kỹ thuật đã kiểm chứng.");return;}
  if(!$("externalSearchConsent")?.checked){alert("Trước khi tìm, hãy tick đồng ý gửi từ khóa tại màn hình này nếu bạn được phép.");return}
  const autoPlan=buildDiverseSearchPlan();
  const manualTracks=[{id:'trackEnglish',lang:'en',label:'Tiếng Anh (thủ công)'},{id:'trackVietnamese',lang:'vi',label:'Tiếng Việt (thủ công)'},{id:'trackChinese',lang:'zh',label:'Tiếng Trung (thủ công)'},{id:'trackJapanese',lang:'ja',label:'Tiếng Nhật (thủ công)'},{id:'trackKorean',lang:'ko',label:'Tiếng Hàn (thủ công)'},{id:'trackGerman',lang:'de',label:'Tiếng Đức (thủ công)'},{id:'trackFrench',lang:'fr',label:'Tiếng Pháp (thủ công)'}]
    .map(t=>({...t,query:String($(t.id)?.value||'').trim()})).filter(t=>t.query.length>=4)
    .map(t=>({label:t.label,axis:'language_'+t.lang,query:t.query,mode:'precise',lang:t.lang}));
  const plan=$('tracksOnly')?.checked?manualTracks:[...manualTracks,...autoPlan];
  state.searchAudit=[];state.searchFailures=[];
  if(!plan.length){
    $("liveSearchState").innerHTML='<span class="backend-bad">Chưa có truy vấn. Kiểm tra lại đặc điểm hoặc nhập ít nhất một truy vấn riêng trong phần đa ngôn ngữ.</span>';
    return;
  }

  const base=backendBase();
  saveBackend();
  $("liveSearchBtn").disabled=true;
  $("liveSearchState").innerHTML=`Đang chạy <strong>${plan.length}</strong> hướng tra cứu khác nhau...`;

  const all=[];
  const errors=[];

  try{
    for(let i=0;i<plan.length;i++){
      const item=plan[i];
      $("liveSearchState").innerHTML=`Đang tra cứu ${i+1}/${plan.length}: <strong>${esc(item.label)}</strong> · ${esc(item.query)}`;

      try{
        const url=base+"/api/search?q="+encodeURIComponent(item.query)
          +"&title="+encodeURIComponent(item.lang?"":isConfidentialMode()?"":($("title").value||""))
          +"&num=12"
          +"&mode="+encodeURIComponent(item.mode||"balanced")
          +(item.lang?"&language_track="+encodeURIComponent(item.lang):"");
        const r=await fetch(url,{cache:"no-store",headers:apiHeaders()});
        const data=await r.json().catch(()=>({}));
        if(!r.ok||!data.ok){
          for(const entry of data.search_log||[]){
            const row={axis:item.axis,label:item.label,query:entry.query,provider:entry.provider,count:entry.count||0,status:entry.status,time:new Date().toISOString()};
            state.searchAudit.push(row);
            if(entry.status==='ERROR')state.searchFailures.push({...row,error:entry.error||'Nguồn tìm kiếm không phản hồi'});
          }
          // No hits from functioning providers is not an outage. Keep any individual provider failures visible.
          if(data.code==='NO_RESULTS') continue;
          const err=new Error((data.code==='SEARCH_FAILED'?'Nguồn tìm kiếm bị lỗi: ':'Không kết nối được nguồn tìm kiếm: ')+(data.error||('HTTP '+r.status)));
          err.alreadyLogged=!!(data.search_log||[]).some(x=>x.status==='ERROR');
          throw err;
        }
        if(Array.isArray(data.search_log)&&data.search_log.length){
          for(const entry of data.search_log){const row={axis:item.axis,label:item.label,query:entry.query,provider:entry.provider,count:entry.count||0,status:entry.status,time:new Date().toISOString()};state.searchAudit.push(row);if(entry.status==='ERROR')state.searchFailures.push({...row,error:entry.error||'Provider failed'});}
        }else state.searchAudit.push({axis:item.axis,label:item.label,query:item.query,provider:data.provider||"",count:(data.results||[]).length,status:'UNKNOWN',time:new Date().toISOString()});

        for(const x of data.results||[]){
          all.push({
            ...x,
            score:0,
            search_axis:item.axis,
            search_label:item.label,
            search_query:data.query_used||item.query,
            provider:data.provider||""
          });
        }
      }catch(e){
        errors.push(`${item.label}: ${String(e.message||e)}`);
        if(!e.alreadyLogged)state.searchFailures.push({axis:item.axis,label:item.label,query:item.query,error:String(e.message||e),time:new Date().toISOString()});
      }
    }

    if(!all.length){
      state.candidates=[];
      renderCandidates();
      renderSearchAudit(0);renderSearchGap();
      $("liveSearchState").innerHTML=errors.length
        ? `<span class="backend-bad">⚠ Lỗi kết nối/nguồn tìm kiếm (${state.searchFailures.length} lượt lỗi). Chưa thể xác định độ phủ; đây KHÔNG phải kết quả 0 tài liệu đối chứng.</span><br>${esc(errors.slice(0,3).join(" | "))}`
        : `<span class="backend-warn">Đã thử các truy vấn và chưa nhận kết quả. Điều này KHÔNG chứng minh giải pháp có tính mới.</span>`;
      return;
    }

    for(const c of all){
      c.score=scoreCandidate(c);
      // Mild bonus only; relevance stays primary.
      if(c.search_axis==="function") c.score=Math.min(99,c.score+3);
      if(c.search_axis==="process") c.score=Math.min(99,c.score+2);
      if(c.search_axis==="composition") c.score=Math.min(99,c.score+2);
    }

    state.targetExcluded=all.filter(c=>{
      const pub=normalizedPublication(c.publication_number);return pub&&exactTargetIdentifierSet().has(pub)
    }).map(c=>({publication_number:c.publication_number,reason:"Trùng identifier mục tiêu được khai báo"}));
    state.candidates=diversifyPriorArt(all.filter(c=>{
      const pub=normalizedPublication(c.publication_number);return !(pub&&exactTargetIdentifierSet().has(pub));
    }),24);
    state.searchClusters={};
    for(const c of state.candidates){
      const key=c.search_label||"Khác";
      state.searchClusters[key]=(state.searchClusters[key]||0)+1;
    }

    if(state.candidates[0]?.search_query){
      $("liveSearchQuery").value=state.candidates[0].search_query;
      updateOfficialSearchLinks(state.candidates[0].search_query);
    }

    renderCandidates();
    renderSearchAudit(all.length);renderSearchGap();

    const dist=Object.entries(state.searchClusters)
      .map(([k,v])=>`${k}: ${v}`)
      .join(" · ");

    $("liveSearchState").innerHTML=
      `Đã lấy <strong>${all.length}</strong> kết quả thô, giữ <strong>${state.candidates.length}</strong> ứng viên sau lọc trùng lặp. Đã loại <strong>${state.targetExcluded.length}</strong> kết quả trùng số công bố mục tiêu đã khai báo. Những trường hợp cùng patent family chưa khai báo vẫn phải kiểm tra thủ công.`
      + (state.searchFailures.length?`<div class="partial-search-warning" role="status"><strong>⚠ Chỉ có kết quả một phần:</strong> ${state.searchFailures.length} lượt truy vấn hoặc nguồn lỗi. Danh sách dưới đây không chứng minh đã tra cứu đủ. Xem nhật ký nguồn để tìm lại các lượt lỗi.</div>`:``)
      + `<br><span style="color:#667085">${esc(dist)}</span>`;
  }finally{
    $("liveSearchBtn").disabled=false;
  }
}

function invalidateSourceEvidence(slot,reason="source_changed"){
 const n=slot.slice(1);
 for(const suffix of ["VerifyDate","VerifyText","VerifyIdentity"]){const el=$(`d${n}${suffix}`);if(el)el.checked=false;}
 for(const key of Object.keys(state.evidenceReviews||{}))if(key.endsWith("::"+slot))delete state.evidenceReviews[key];
 for(const key of Object.keys(state.matrixOverrides||{}))if(key.endsWith(":"+slot))delete state.matrixOverrides[key];
 state.assessment={};state.sourceVerification[slot]={date:false,text:false,identity:false};
 state.reviewLog.push({time:new Date().toISOString(),action:"evidence_invalidated",target:slot,reason});
}
async function selectCandidateToSlot(i,slot){
  const c=state.candidates[i];
  if(!c) return;
  const old=$(`d${slot.slice(1)}No`)?.value||"";
  if(normalizedPublication(old)!==normalizedPublication(c.publication_number))invalidateSourceEvidence(slot,"candidate_replaced");
  const overlap=targetOverlapReason(c);
  if(overlap){
    const accept=confirm("CẢNH BÁO RÒ RỈ DỮ LIỆU KIỂM THỬ: "+overlap+".\nKhông sử dụng chính target/cùng hồ sơ làm prior art thông thường. Chỉ tiếp tục nếu đã xác minh đây là tài liệu khác và ghi lý do trong audit.");
    if(!accept)return;
    const why=prompt("Nêu nguồn xác minh và lý do cho phép chọn tài liệu này:","");
    if(!why?.trim())return;
    state.reviewLog.push({time:new Date().toISOString(),action:"target_overlap_manual_override",document:c.publication_number,reason:why});
  }

  if(!state.selectedCandidates) state.selectedCandidates={D1:null,D2:null,D3:null};
  state.selectedCandidates[slot]=i;

  const n=slot.slice(1);
  const base=backendBase();

  $(`d${n}No`).value=cleanPatentContent(c.publication_number||"");
  $(`d${n}Date`).value=(c.publication_date||"").slice(0,10);
  state.priorMeta[slot]={...c,content_level:"snippet_only",source_authenticated:false};
  $(`d${n}Url`).value=c.url||"";
  $(`d${n}Text`).value=formatPriorDocument(null,c);

  updatePriorQuality(slot);
  document.querySelectorAll(".prior-slot").forEach(x=>x.classList.remove("selected"));
  $("slot"+slot).classList.add("selected");

  // Immediate visual feedback: button turns to the D1/D2/D3 color.
  renderCandidates();
  updatePriorSlotVisuals();

  if(base&&c.publication_number){
    try{
      $(`d${n}Text`).value="Đang lấy và chuẩn hóa nội dung patent...";
      const r=await fetch(base+"/api/detail?pub="+encodeURIComponent(c.publication_number)+"&lang="+encodeURIComponent(c.language||""),{headers:apiHeaders()});
      const d=await r.json();
      if(normalizedPublication($(`d${n}No`).value)!==normalizedPublication(c.publication_number))return; // another candidate was selected meanwhile
      if(r.ok&&d.ok){
        $(`d${n}Text`).value=formatPriorDocument(d,c)||formatPriorDocument(null,c);
        state.priorMeta[slot]={...state.priorMeta[slot],content_level:d.content_level||'unknown',description_truncated:!!d.description_truncated,source_authenticated:false};
        const quality=$(`priorQuality${slot}`);
        if(quality) quality.textContent='Bản trích tự động: '+(d.content_level||'chưa biết')+(d.description_truncated?' · MÔ TẢ BỊ CẮT':'')+'. Chuyên gia cần mở bản gốc kiểm tra vị trí và hình vẽ.';
      }else{
        $(`d${n}Text`).value=formatPriorDocument(null,c);
      }
    }catch(_e){
      $(`d${n}Text`).value=formatPriorDocument(null,c);
    }
  }

  $(`d${n}Text`).value=cleanPatentContent($(`d${n}Text`).value);
  updatePriorQuality(slot);
  readPrior();
  updatePriorSlotVisuals();
  renderCandidates();
}

function normalizedTitleKey(c){
  return foldVN(cleanPatentContent(c.title||""))
    .toLowerCase().replace(/[^a-z0-9]+/g," ").trim().split(/\s+/).slice(0,9).join(" ");
}
function autoPickD123(){
  if(!state.candidates.length) return alert("Chưa có kết quả tra cứu.");
  const sorted=[...state.candidates].sort((a,b)=>{
    const da=candidateDateStatus(a),db=candidateDateStatus(b);
    const pa=da.eligible===false?1:0,pb=db.eligible===false?1:0;
    return pa-pb || scoreCandidate(b)-scoreCandidate(a);
  });

  const picked=[],seen=new Set();
  for(const c of sorted){
    const score=scoreCandidate(c);
    if(score<12||targetOverlapReason(c)) continue; // không auto chọn target/trùng tiêu đề hoặc không liên quan
    const key=normalizedTitleKey(c);
    if(key&&seen.has(key)) continue;
    if(key) seen.add(key);
    picked.push(c);
    if(picked.length===3) break;
  }
  if(!picked.length) return alert("Chưa có ứng viên đủ liên quan để tự chọn D1–D3. Hãy xem kết quả và chọn thủ công.");
  picked.forEach((c,idx)=>{
    const original=state.candidates.indexOf(c);
    selectCandidateToSlot(original,"D"+(idx+1));
  });
}
$("liveSearchBtn").onclick=searchRealPatents;
$("useBestQuery").onclick=()=>{useGeneratedQuery();$("liveSearchState").textContent="Đã nạp truy vấn từ bước Chiến lược tra cứu."};
$("autoPickPrior").onclick=async()=>{
  if(!state.candidates.length)return alert("Hãy tìm tài liệu trước.");
  const chosen=[];
  const usedAxes=new Set();
  for(const c of state.candidates){
    if(chosen.length>=3) break;
    const axis=c.search_axis||"other";
    if(!targetOverlapReason(c)&&!usedAxes.has(axis)){chosen.push(c);usedAxes.add(axis)}
  }
  for(const c of state.candidates){
    if(chosen.length>=3) break;
    if(!chosen.includes(c)&&!targetOverlapReason(c)) chosen.push(c);
  }
  for(let i=0;i<chosen.length;i++){
    const idx=state.candidates.indexOf(chosen[i]);
    if(idx>=0) await selectCandidateToSlot(idx,`D${i+1}`);
  }
};
$("testBackend").onclick=async()=>{
  $("backendStatus").textContent="Đang kiểm tra...";
  try{
    const r=await fetch("/api/health",{cache:"no-store"});
    const d=await r.json();
    if(!r.ok||!d.ok) throw new Error(d.error||"Không kết nối được");
    const p=d.providers||{}; const ver=d.version?` · v${d.version}`:"";
    state.providers=p;
    state.cloudOcr=p.google_vision?true:null;
    const searchOk=p.serpapi||p.browser_run||p.epo_ops;
    const ocrText=isConfidentialMode()?" · Confidential mode: cloud OCR/AI disabled":(p.google_vision?" · Google Vision OCR sẵn sàng":" · OCR local fallback");
    $("backendStatus").innerHTML=searchOk
      ? `<span class="backend-ok">✓ Backend hoạt động.</span>${ocrText}`
      : `<span class="backend-ok">✓ Backend hoạt động.</span> Google direct có thể bị rate-limit${ocrText}`;
  }catch(e){
    $("backendStatus").innerHTML=`<span class="backend-bad">✕ Backend: ${esc(e.message||e)}</span>`;
  }
};

function readSourceVerification(){const out={};for(const slot of ['D1','D2','D3']){const n=slot.slice(1);out[slot]={date:!!$(`d${n}VerifyDate`)?.checked,text:!!$(`d${n}VerifyText`)?.checked,identity:!!$(`d${n}VerifyIdentity`)?.checked}}state.sourceVerification=out;return out}
function sourceVerified(slot){
  const v=(readSourceVerification()[slot]||{}),meta=state.priorMeta?.[slot]||{};
  // Source checkbox is human self-attestation only. A snippet must never count as verified full text.
  return !!(v.date&&v.text&&v.identity&&String(state.prior?.[slot]?.text||'').trim().length>=40&& !['snippet_only','abstract_only','metadata','unknown'].includes(meta.content_level)&&!meta.description_truncated);
}
function readPrior(){readSourceVerification();state.prior={
  D1:{no:cleanPatentContent($("d1No").value),date:$("d1Date").value,type:$("d1Type")?.value||"patent",text:cleanPatentContent($("d1Text").value)},
  D2:{no:cleanPatentContent($("d2No").value),date:$("d2Date").value,type:$("d2Type")?.value||"patent",text:cleanPatentContent($("d2Text").value)},
  D3:{no:cleanPatentContent($("d3No").value),date:$("d3Date").value,type:$("d3Type")?.value||"patent",text:cleanPatentContent($("d3Text").value)}
}}

[1,2,3].forEach(n=>['VerifyDate','VerifyText','VerifyIdentity'].forEach(sfx=>{const el=$(`d${n}${sfx}`);if(el)el.onchange=()=>{readSourceVerification();state.reviewLog.push({time:new Date().toISOString(),action:'source_verification',target:`D${n}:${sfx}`,value:el.checked});renderMatrix();renderReadiness()}}));
["D1","D2","D3"].forEach(slot=>{
  const n=slot.slice(1);
  for(const field of ["No","Date","Url","Text"]){
    const input=$(`d${n}${field}`);
    if(input)input.addEventListener("change",()=>{
      invalidateSourceEvidence(slot,"manual_"+field);
      if(field==='Text' && state.priorMeta?.[slot])state.priorMeta[slot].content_level='user_supplied_text_unverified';state.matrixScanAudit={};
      readPrior();renderMatrix();
    });
  }
  const noEl=$(`d${n}No`);
  if(noEl) noEl.addEventListener("input",()=>{
    syncSelectedCandidatesFromInputs();
    updatePriorSlotVisuals();
    renderCandidates();
  });
});
$("cleanPriorText").onclick=cleanAllPriorSlots;
$("validatePrior").onclick=()=>{
  readPrior();
  const target=relevantDateValue();
  let out=`<strong>Kiểm tra ngày công bố so với ngày liên quan ${esc(target||"chưa có")}</strong><br/>`;
  for(const slot of ["D1","D2","D3"]){
    const p=state.prior[slot]; if(!p.no&&!p.text)continue;
    const meta=state.priorMeta?.[slot]||{};
    const ds=meta.publication_date?publicationDateStatus(meta):p.date&&target?{eligible:new Date(p.date)<new Date(target)?true:null,label:new Date(p.date)<new Date(target)?"Công bố trước ngày liên quan":"Công bố sau mốc · cần kiểm tra ngày nộp/ưu tiên",cls:new Date(p.date)<new Date(target)?"green":"yellow"}:{eligible:null,label:"Chưa xác minh ngày công bố",cls:"yellow"};
    out+=`${slot} · ${esc(p.no||"tài liệu thủ công")} · ${esc(p.date||meta.publication_date||"chưa có ngày công bố")} — <span class="pill ${ds.cls}">${esc(ds.label)}</span><br/>`;
  }
  $("priorCheck").innerHTML=out+`<div class="status" style="margin-top:7px">Không dùng priority/filing date thay cho ngày công bố để chứng minh tài liệu đã công khai. Trường hợp đơn nộp sớm nhưng công bố sau mốc cần chuyên gia xem quy tắc E/P theo hệ thống pháp luật áp dụng.</div>`;
  renderReadiness();
};


function compareNorm(s){
  return foldVN(cleanPatentContent(s||""))
    .toLowerCase().replace(/[–—]/g,"-").replace(/\s+/g," ").trim();
}
function matrixConceptGroups(featureText){
  const raw=cleanPatentContent(featureText||"");
  const f=compareNorm(raw);
  const groups=[];
  const add=(label,terms,weight=1)=>{
    const vals=[...new Set((terms||[]).map(compareNorm).filter(x=>x.length>=3))];
    if(vals.length&&!groups.some(g=>g.label===label)) groups.push({label,terms:vals,weight});
  };

  for(const [k,vals] of Object.entries(dict)){
    if(f.includes(compareNorm(k))) add(k,[k,...vals],k.split(/\s+/).length>1?2.2:1.4);
  }

  // Numeric/process constraints matter in patent claims.
  for(const mm of raw.matchAll(/\b\d+(?:[,.]\d+)?\s*%/g)) add(mm[0],[mm[0].replace(/\s+/g,"")],1.4);
  for(const mm of raw.matchAll(/\b\d+(?:\s*[-–]\s*\d+)?\s*(?:phút|giờ|minutes?|hours?)\b/gi)) add(mm[0],[mm[0]],1.3);

  // Technical phrases not already captured.
  for(const p of technicalPhrasesFromText(raw).slice(0,5)) add(p,[p],p.split(/\s+/).length>1?1.3:1);
  return groups.slice(0,24);
}
function splitEvidenceUnits(text){
  const t=cleanPatentContent(text||"");
  const tagged=t
    .replace(/\n(?=TIÊU ĐỀ|TITLE|TÓM TẮT|ABSTRACT|YÊU CẦU BẢO HỘ|CLAIMS)/g,"\n§")
    .split(/\n+/);

  const units=[];
  let section="Content";

  for(const line of tagged){
    const x=line.replace(/^§/,"").trim();
    if(!x) continue;

    if(/^(TIÊU ĐỀ|TITLE)$/i.test(x)){section="Title";continue}
    if(/^(TÓM TẮT\s*\/\s*ABSTRACT|ABSTRACT|TÓM TẮT)$/i.test(x)){section="Abstract";continue}
    if(/^(YÊU CẦU BẢO HỘ\s*\/\s*CLAIMS|CLAIMS|YÊU CẦU BẢO HỘ)$/i.test(x)){section="Claims";continue}

    for(const sentence of x.split(/(?<=[.!?;:])\s+/)){
      const s=sentence.trim();
      if(s.length<18) continue;
      const lang=detectTextLanguage(s).lang;
      units.push({section,lang,text:s}); // original text is preserved
    }
  }
  return units.slice(0,1200);
}
function localEvidenceFor(feature,docText){
  const text=cleanPatentContent(docText||"");
  if(!text || text==="Đang lấy và chuẩn hóa nội dung patent..."){
    return {status:"Chưa có dữ liệu",coverage:0,evidence:"Chưa có nội dung D1/D2/D3 để đối chiếu."};
  }
  const groups=matrixConceptGroups(feature.text);
  if(!groups.length){
    return {status:"Chưa chắc chắn",coverage:0,evidence:"Chưa tách được đủ concept kỹ thuật để đối chiếu tự động."};
  }

  const units=splitEvidenceUnits(text);
  let best={score:-1,coverage:0,unit:null,hits:[]};
  const totalWeight=groups.reduce((n,g)=>n+g.weight,0)||1;

  // Evaluate each evidence unit and a two-sentence window.
  for(let i=0;i<units.length;i++){
    const candidates=[units[i]];
    if(i+1<units.length && units[i+1].section===units[i].section){
      candidates.push({section:units[i].section,text:units[i].text+" "+units[i+1].text});
    }
    for(const u of candidates){
      const fu=compareNorm(u.text);
      const hits=[];let weight=0;let phraseBonus=0;
      for(const g of groups){
        const term=g.terms.find(t=>fu.includes(t));
        if(term){hits.push({label:g.label,term});weight+=g.weight;if(term.includes(" ")) phraseBonus+=.25*g.weight}
      }
      const coverage=Math.min(1,weight/totalWeight);
      const sectionBonus=u.section==="Claims"?.12:u.section==="Abstract"?.06:0;
      const score=coverage+Math.min(.15,phraseBonus/Math.max(1,totalWeight))+sectionBonus;
      if(score>best.score) best={score,coverage,unit:u,hits};
    }
  }

  let status="Chưa chắc chắn";
  if(best.coverage>=.32 && best.hits.length>=1) status="Chưa chắc chắn"; // Lexical cues only, never state actual disclosure.

  const pct=Math.round(best.coverage*100); // Internal lexical ranking ONLY, never a novelty percentage.
  const hitNames=best.hits.slice(0,6).map(x=>x.label).join(", ");
  const evidence=best.unit
    ? `[${best.unit.section}][${String(best.unit.lang||"unknown").toUpperCase()}] ${best.unit.text.slice(0,520)}${best.unit.text.length>520?"…":""}\nGợi ý từ khóa liên quan${hitNames?` · ${hitNames}`:""} (không kết luận đặc điểm đã được bộc lộ)`
    : "Chưa tìm được đoạn evidence đủ rõ trong nội dung đã tải; cần chuyên gia mở tài liệu gốc.";
  return {status,coverage:pct,evidence};
}
function buildLocalMatrix(){
  const rows=[];
  for(const f of state.features){
    const vals=[],notes=[];
    for(const k of ["D1","D2","D3"]){
      const r=localEvidenceFor(f,state.prior[k]?.text||"");
      vals.push(r.status);
      notes.push(`${k}${state.prior[k]?.no?` (${state.prior[k].no})`:""}: ${r.evidence}`);
    }
    rows.push([f.id,...vals,notes.join("\n\n")]);
  }
  return rows;
}

// Chunk each entire supplied D text with overlap; every feature is checked against every chunk.
// A failed/missing chunk means INCOMPLETE, never an inferred negative result.
function auditChunkCoverage(value,chunks){
  const text=String(value||''); const spans=Array.isArray(chunks)?chunks:[];
  let pos=0,overlapChars=0,firstHole=-1,holes=0,bad=[];
  for(const [i,c] of spans.entries()){
    if(!c||!Number.isInteger(c.start)||!Number.isInteger(c.end)||c.start<0||c.end>text.length||c.start>=c.end||text.slice(c.start,c.end)!==c.text){bad.push(i+1);continue;}
    if(c.start>pos){holes+=c.start-pos;if(firstHole<0)firstHole=pos;}
    if(c.start<pos)overlapChars+=Math.max(0,Math.min(c.end,pos)-c.start);
    pos=Math.max(pos,c.end);
  }
  if(pos<text.length){holes+=text.length-pos;if(firstHole<0)firstHole=pos;}
  return {totalChars:text.length,coveredChars:text.length-holes,holes,firstHole,overlapChars,chunkCount:spans.length,invalidChunks:bad,complete:holes===0&&!bad.length&&(!!text.length===!!spans.length)};
}
function patentTextChunks(value,max=7000,overlap=450){
  const text=String(value||''),out=[];
  if(!Number.isInteger(max)||max<256||max>9000||!Number.isInteger(overlap)||overlap<0||overlap>=max)throw new Error('CHUNK_CONFIG_INVALID: sai kích thước đoạn/chồng lấn');
  for(let start=0;start<text.length;){
    let end=Math.min(start+max,text.length);
    if(end<text.length){
      // Search only the current chunk suffix; whole-document lastIndexOf becomes quadratic on long PDFs.
      const from=start+Math.floor(max*.70);
      const suffix=text.slice(from,end);
      const boundary=Math.max(suffix.lastIndexOf('\n'),suffix.lastIndexOf('. '));
      if(boundary>=0)end=from+boundary+1;
    }
    if(end<=start||end-start>max)throw new Error('CHUNK_BOUNDS_INVALID');
    out.push({start,end,text:text.slice(start,end)});
    if(end===text.length)break;
    const next=end-overlap;
    // A true stalled cursor must stop, not invent start+1 and hide a bug.
    if(next<=start)throw new Error('CHUNK_STALLED');
    start=next;
  }
  const check=auditChunkCoverage(text,out);
  if(!check.complete)throw new Error('CHUNK_GAP_DETECTED: '+check.holes+' ký tự không được gán đoạn (vị trí '+check.firstHole+')');
  return out;
}
async function buildMatrixPro(){
  readPrior();
  const slots=['D1','D2','D3'].filter(k=>String(state.prior?.[k]?.text||'').trim() && state.priorMeta?.[k]?.content_level!=='snippet_only');
  if(!state.features.length)return alert('Chưa có dấu hiệu kỹ thuật.');
  if(!slots.length)return alert('Chưa có đoạn nội dung D1–D3 đủ để AI đối chiếu. Chỉ có snippet/kết quả tìm kiếm không phải bằng chứng toàn văn; hãy bổ sung bản mô tả hoặc claims từ nguồn gốc.');
  if(isConfidentialMode()){
    state.matrix=buildLocalMatrix();state.matrixOverrides={};state.evidenceReviews={};state.assessment={};state.matrixScanAudit={};
    if($('matrixAIStatus'))$('matrixAIStatus').textContent='BẢO MẬT: chỉ dùng dò thuật ngữ cục bộ; AI CHƯA đọc tài liệu. Không được suy ra rằng đặc điểm vắng mặt.';
    renderMatrix();renderReadiness();return;
  }
  const groups=[];for(let i=0;i<state.features.length;i+=6)groups.push(state.features.slice(i,i+6));
  const byKey=new Map(),audit={},allChunks={};
  try{
    for(const slot of slots){
      const text=cleanPatentContent(state.prior[slot].text),chunks=patentTextChunks(text),check=auditChunkCoverage(text,chunks);
      if(!check.complete)throw new Error(slot+': CHUNK_GAP_DETECTED');
      allChunks[slot]=chunks;
      audit[slot]={totalChars:check.totalChars,coveredChars:check.coveredChars,holes:check.holes,overlapChars:check.overlapChars,totalChunks:chunks.length,completedChunks:[],failedChunks:[],requestedCells:chunks.length*state.features.length,completedCells:0,doubleCheckRequests:0,doubleCheckPassed:0,transportChecked:true,complete:false,sourceLevel:state.priorMeta?.[slot]?.content_level||'user supplied',fingerprint:contentFingerprint(text),note:'100% vị trí ký tự của VĂN BẢN ĐÃ NẠP được phân vào các đoạn; KHÔNG chứng minh PDF/hình vẽ/nguồn gốc đã đọc đủ hoặc AI hiểu đúng.'};
    }
  }catch(e){state.matrixScanAudit={};if($('matrixPreflight'))$('matrixPreflight').textContent='DỪNG: '+String(e.message||e);return alert('Lỗi kiểm toán chia đoạn: '+String(e.message||e));}
  const jobs=slots.flatMap(slot=>allChunks[slot].flatMap((part,i)=>groups.map(feat=>({slot,part,index:i,features:feat}))));
  if($('matrixPreflight'))$('matrixPreflight').textContent=slots.map(slot=>`${slot}: ${audit[slot].totalChars} ký tự đã nạp · ${audit[slot].totalChunks} đoạn · không hổng vị trí · ${audit[slot].overlapChars} ký tự lặp`).join(' | ')+'; không bao gồm trang/hình vẽ chưa được trích xuất.';
  // No per-document token cap or invisible truncation. Work may be costly; disclose estimated calls first.
  const second=!!$('doubleCheckEvidence')?.checked;
  if(!confirm(`Cần ${jobs.length} lượt AI cho ${slots.length} tài liệu và ${state.features.length} đặc điểm${second?'; kiểm tra lần hai có thể thêm tối đa '+jobs.length+' lượt':''}. Đây là kiểm toán VĂN BẢN ĐÃ NẠP, không phải AI hiểu đúng toàn bộ PDF. Có thể mất thời gian/phát sinh chi phí. Tiếp tục?`))return;
  state.matrixScanAudit=audit;state.matrixOverrides={};state.evidenceReviews={};state.assessment={};
  const el=$('matrixAIStatus');
  for(let j=0;j<jobs.length;j++){
    const job=jobs[j],a=audit[job.slot];
    if(el)el.textContent=`AI đang đọc từng đoạn: ${j+1}/${jobs.length} lượt; ${job.slot}, đoạn ${job.index+1}/${a.totalChunks}. Nếu lỗi, kết quả sẽ ghi chưa hoàn tất.`;
    try{
      const r=await fetch('/api/matrix',{method:'POST',headers:apiHeaders({'content-type':'application/json','x-deep-access-code':$('deepAccessCode')?.value?.trim()||''}),body:JSON.stringify({confidential_mode:false,external_ai_consent:true,features:job.features.map(f=>({id:f.id,text:f.text})),documents:{[job.slot]:{no:state.prior[job.slot]?.no||'',text:job.part.text}}})});
      const data=await r.json().catch(()=>({}));
      if(!r.ok||!data.ok||!Array.isArray(data.rows))throw new Error(String(data.error||'API/AI không trả đủ kết quả'));
      const echo=data.scan_echo||{};
      if(echo.slot!==job.slot||echo.received_chars!==job.part.text.length||echo.chunk_fingerprint!==contentFingerprint(job.part.text)||!job.features.every(f=>(echo.returned_features||[]).includes(String(f.id))))throw new Error('CHUNK_TRANSPORT_MISMATCH: Worker không xác nhận nhận đủ đoạn và trả đủ feature');
      const map=new Map(data.rows.map(row=>[String(row.feature_id),row]));
      for(const f of job.features){
        const cell=map.get(String(f.id))?.[job.slot];
        if(!cell)throw new Error('Mô hình bỏ sót feature '+f.id);
        const key=f.id+'::'+job.slot;const arr=byKey.get(key)||[];
        if(['Có','Một phần'].includes(cell.status)&&cell.literal_text_match&&cell.evidence){
          let accepted=true,secondNote='';
          if(second){
            a.doubleCheckRequests++;
            const verifyRequest=await fetch('/api/matrix',{method:'POST',headers:apiHeaders({'content-type':'application/json','x-deep-access-code':$('deepAccessCode')?.value?.trim()||''}),body:JSON.stringify({confidential_mode:false,external_ai_consent:true,features:[{id:f.id,text:f.text}],documents:{[job.slot]:{no:state.prior[job.slot]?.no||'',text:job.part.text}}})});
            const verifyData=await verifyRequest.json().catch(()=>({}));
            const cross=verifyData?.rows?.find(x=>String(x.feature_id)===String(f.id))?.[job.slot];
            if(!verifyRequest.ok||!verifyData.ok||!cross)throw new Error('Kiểm tra lại không hoàn tất: '+String(verifyData.error||'lượt AI thiếu dữ liệu'));
            if(verifyData.scan_echo?.slot!==job.slot||verifyData.scan_echo?.received_chars!==job.part.text.length||verifyData.scan_echo?.chunk_fingerprint!==contentFingerprint(job.part.text))throw new Error('CHUNK_TRANSPORT_MISMATCH: lượt kiểm tra lại thiếu checksum đoạn');
            accepted=['Có','Một phần'].includes(cross.status)&&cross.literal_text_match&&!!cross.evidence;
            if(accepted)a.doubleCheckPassed++;
            else secondNote=' · Lượt kiểm tra lại không đồng thuận; chuyển Chưa chắc chắn.';
          }
          if(accepted)arr.push({status:cell.status,evidence:String(cell.evidence),start:job.part.start,end:job.part.end});
          else a.doubleCheckMismatch=(a.doubleCheckMismatch||0)+1;
          if(secondNote)a.secondPassNote=secondNote;
        }
        byKey.set(key,arr);
      }
      a.completedCells+=job.features.length;
      if(!a.completedChunks.includes(job.index)&&a.completedCells>=(job.index+1)*state.features.length)a.completedChunks.push(job.index);
    }catch(e){
      a.failedChunks.push({chunk:job.index+1,features:job.features.map(f=>f.id),error:String(e.message||e).slice(0,200)});
      // Access/key/provider errors usually repeat: fail visibly; do not claim that later chunks were read.
      if(/401|403|429|503|quota|access|key|not configured|chưa được cấu hình/i.test(String(e.message||e))){
        for(let k=j+1;k<jobs.length;k++)audit[jobs[k].slot].failedChunks.push({chunk:jobs[k].index+1,features:jobs[k].features.map(f=>f.id),error:'Không gọi tiếp sau lỗi cấu hình/quota ở lượt trước'});
        break;
      }
    }
    if(j%4===0)await sleep(0);
  }
  for(const slot of slots){const a=audit[slot];a.complete=!a.failedChunks.length&&a.completedCells===a.requestedCells;}
  state.matrix=state.features.map(f=>{
    const statuses=['D1','D2','D3'].map(slot=>{
      if(!slots.includes(slot))return 'Chưa có dữ liệu';
      if(!audit[slot].complete)return 'Chưa chắc chắn';
      const items=byKey.get(f.id+'::'+slot)||[];
      return items.some(i=>i.status==='Có')?'Có':items.some(i=>i.status==='Một phần')?'Một phần':'Chưa chắc chắn';
    });
    const evidence=slots.map(slot=>{
      const items=(byKey.get(f.id+'::'+slot)||[]).slice(0,4);
      return slot+': '+(items.length?items.map(i=>`[Ký tự ${i.start+1}–${i.end} của văn bản đã nhập] ${i.evidence}`).join(' | '):'Chưa có đoạn trích khẳng định trong các lượt đã chạy')+(audit[slot].complete?'':' · QUÉT CHƯA HOÀN TẤT');
    }).join('\n\n');
    return [f.id,...statuses,evidence];
  });
  if(el)el.textContent=slots.map(slot=>`${slot}: ${audit[slot].completedCells}/${audit[slot].requestedCells} lượt đặc điểm × đoạn · ${audit[slot].coveredChars}/${audit[slot].totalChars} vị trí ký tự đã phân đoạn${audit[slot].complete?' · lượt AI đã phản hồi đủ':' · LƯỢT AI CÒN THIẾU'}${second?` · lượt kiểm tra lại ${audit[slot].doubleCheckPassed}/${audit[slot].doubleCheckRequests}`:''}`).join(' | ')+'. CHỈ kiểm toán văn bản đã nạp và lượt API; không chứng minh AI đã hiểu chính xác, tài liệu gốc/hình vẽ đã đủ hay truy cứu toàn cầu. Chuyên gia xác nhận bằng chứng.';
  state.reviewLog.push({time:new Date().toISOString(),action:'chunked_matrix',audit});
  renderMatrix();renderReadiness();
}

$("buildMatrix").onclick=buildMatrixPro;

function statusMeta(v){
  if(v==="Có") return {cls:"yes",icon:"✓",label:"Có"};
  if(v==="Một phần") return {cls:"partial",icon:"◐",label:"Một phần"};
  if(v==="Không tìm thấy") return {cls:"no",icon:"×",label:"Chưa thấy trong nguồn"};
  if(v==="Chưa có dữ liệu") return {cls:"empty",icon:"—",label:"Chưa dữ liệu"};
  return {cls:"uncertain",icon:"?",label:"Chưa chắc chắn"};
}

function statusBox(v){
  const m=statusMeta(v);
  return `<div class="matrix-status-box ${m.cls}">
    <span class="icon">${m.icon}</span>
    <span class="txt">${esc(m.label)}</span>
  </div>`;
}

function matrixStats(slot){
  const col={D1:1,D2:2,D3:3}[slot];
  const stats={yes:0,partial:0,uncertain:0,no:0,empty:0,total:state.matrix.length};
  for(const r of state.matrix){
    const s=statusMeta(effectiveMatrixStatus(r[0],slot,r[col]));
    stats[s.cls]=(stats[s.cls]||0)+1;
  }
  const weighted=stats.yes + stats.partial*.5;
  stats.coverage=stats.total?Math.round(weighted/stats.total*100):0;
  return stats;
}

function priorShortTitle(slot){
  const txt=cleanPatentContent(state.prior?.[slot]?.text||"");
  const m=txt.match(/(?:^|\n)(?:TIÊU ĐỀ|TITLE)\s*\n([^\n]+)/i);
  return cleanPatentContent(m?.[1]||"");
}

function renderMatrixSummary(){
  readPrior();
  proposeCitationCategories();

  for(const slot of ["D1","D2","D3"]){
    const s=matrixStats(slot);
    const p=state.prior?.[slot]||{};
    const title=priorShortTitle(slot);
    const root=$("matrixSummary");
    if(!root) continue;

    const card=root.querySelector("."+slot.toLowerCase());
    if(!card) continue;

    card.innerHTML=`
      <div class="matrix-summary-top">
        <div style="min-width:0">
          <div class="matrix-doc-title">${esc(slot)}${title?` · ${esc(title)}`:""} ${citationChip(slot)}</div>
          <div class="matrix-doc-no">${esc(p.no||"Chưa chọn tài liệu")}${p.date?` · ${esc(p.date)}`:""}</div>
        </div>
        <div class="matrix-percent" title="Số đặc điểm được chuyên gia đánh dấu; không phải xác suất tính mới">${s.yes}/${s.total} <small style="font-size:9px;display:block">đặc điểm đã xác nhận có</small></div>
      </div>
      <div class="status">Các ô chưa xác nhận hoặc thiếu toàn văn vẫn cần chuyên gia xem nguồn.</div>
      <div class="matrix-counts">
        <span><strong>${s.yes}</strong> Có</span>
        <span><strong>${s.partial}</strong> Một phần</span>
        <span><strong>${s.uncertain}</strong> Chưa chắc</span>
        <span><strong>${s.no}</strong> Không thấy</span>
      </div>`;
  }

  const head=(slot)=>{
    const p=state.prior?.[slot]||{};
    return `${slot}${p.no?` · ${p.no}`:""}`;
  };
  if($("matrixD1Head")) $("matrixD1Head").textContent=head("D1");
  if($("matrixD2Head")) $("matrixD2Head").textContent=head("D2");
  if($("matrixD3Head")) $("matrixD3Head").textContent=head("D3");
}

function evidenceHtml(text){
  const cleaned=cleanPatentContent(text||"");
  if(!cleaned) return '<span class="status">Chưa có evidence.</span>';

  const blocks=cleaned.split(/\n{2,}/).filter(Boolean);
  return blocks.map(b=>`<div class="evidence-block">${esc(b)}</div>`).join("");
}


function evidenceReviewKey(fid,slot){return `${fid}::${slot}`}
function contentFingerprint(t){let h=2166136261;const x=String(t||'');for(let i=0;i<x.length;i++){h=Math.imul(h^x.charCodeAt(i),16777619);}return x.length+':'+(h>>>0).toString(16);}
function verifiedExpertMatch(fid,slot){
 const r=state.evidenceReviews?.[evidenceReviewKey(fid,slot)];
 return !!(r?.decision==="agree" && ['Có','Một phần'].includes(r?.expertStatus) && r?.note?.trim() && r?.quote?.trim().length>=15 && r?.location?.trim().length>=3 && sourceVerified(slot) && r?.sourceFingerprint===contentFingerprint(state.prior?.[slot]?.text||'') && r?.sourceNo===(state.prior?.[slot]?.no||'') && r?.sourceDate===(state.prior?.[slot]?.date||'') && r?.sourceUrl===($(`d${slot.slice(1)}Url`)?.value||state.priorMeta?.[slot]?.url||'') && cleanPatentContent(state.prior?.[slot]?.text||"").replace(/\s+/g," ").toLowerCase().includes(cleanPatentContent(r.quote).replace(/\s+/g," ").toLowerCase()));
}
function suggestedEvidenceFor(fid,slot){
 const f=state.features.find(x=>x.id===fid);
 const p=state.prior?.[slot]||{};
 const local=localEvidenceFor(f||{text:""},p.text||"");
 const s=local.evidence||"";
 const body=s.split("\nĐộ phủ concept:")[0].replace(/^\[[^\]]+\](?:\[[^\]]+\])?\s*/,"");
 return {text:body,score:local.coverage||0,source:$(`d${slot.slice(1)}Url`)?.value||state.priorMeta?.[slot]?.url||""};
}
function saveEvidenceReview(fid,slot){
 const key=evidenceReviewKey(fid,slot),cell=Array.from(document.querySelectorAll('[data-review-key]')).find(x=>x.dataset.reviewKey===key);
 if(!cell)return;
 const decision=cell.querySelector('[data-review-decision]')?.value||"pending";
 const expertStatus=cell.querySelector('[data-expert-status]')?.value||"";
 const note=cell.querySelector('[data-review-note]')?.value.trim()||"";
 const quote=cell.querySelector('[data-review-quote]')?.value.trim()||"";
 const location=cell.querySelector('[data-review-location]')?.value.trim()||"";
 const reason=cell.querySelector('[data-review-reason]')?.value||"";
 const next=cell.querySelector('[data-review-next]')?.value||"";
 const absenceCheck=!!cell.querySelector('[data-absence-reviewed]')?.checked;
 const absenceScope=cell.querySelector('[data-absence-scope]')?.value.trim()||"";
 const feedback=cell.querySelector('[data-review-feedback]');
 const invalid=(msg)=>{if(feedback){feedback.textContent=msg;feedback.classList.add('invalid');}else alert(msg);};
 if(decision!=="pending"&&note.length<8)return invalid("Ghi nhận xét ít nhất 8 ký tự để giải thích quyết định.");
 if(decision==="absence_reviewed" && (!absenceCheck||absenceScope.length<20))return invalid("Cần xác nhận đã rà soát bản gốc và ghi phạm vi đã kiểm tra (mô tả, claim, hình vẽ, từ đồng nghĩa...). Trạng thái này không chứng minh đặc điểm vắng mặt.");
 if(decision==='agree'&&(!state.prior?.[slot]?.text||!state.features.some(f=>f.id===fid)))return invalid('Chưa có đặc điểm kỹ thuật hoặc văn bản đối chứng để chuyên gia xác nhận.');
 if(decision==="agree"){
   if(!['Có','Một phần'].includes(expertStatus))return invalid("Chuyên gia cần tự chọn Có hoặc Một phần, không sao chép nhãn máy.");
   if(!suggestedEvidenceFor(fid,slot).source)return invalid("Thiếu link gốc. Bổ sung URL ở bước Tìm tài liệu.");
   if(!sourceVerified(slot))return invalid(`Chưa kiểm tra đủ: đúng tài liệu, ngày, nội dung và bản mô tả của ${slot}. Nếu chỉ có snippet hãy mở bản gốc; nếu bản trích bị cắt, bổ sung nội dung và kiểm tra trước khi duyệt.`);
   if(quote.length<15||location.length<3)return invalid("Cần dán nguyên văn đoạn nguồn (≥15 ký tự) và trang/đoạn/hình (≥3 ký tự).");
   if(!cleanPatentContent(state.prior?.[slot]?.text||"").replace(/\s+/g," ").toLowerCase().includes(cleanPatentContent(quote).replace(/\s+/g," ").toLowerCase()))return invalid("Đoạn trích chưa khớp nội dung D đã tải. Nếu nguồn gốc có đoạn này, hãy bổ sung đầy đủ nội dung gốc và xác minh lại.");
 }
 if(decision==="reject"&&(!reason||!next))return invalid("Khi không đồng ý, hãy chọn lý do và một hướng xử lý tiếp theo.");
 state.evidenceReviews[key]={decision,expertStatus:decision==='agree'?expertStatus:'',note,quote,location,reason,next,absenceCheck,absenceScope,sourceFingerprint:contentFingerprint(state.prior?.[slot]?.text||''),sourceNo:state.prior?.[slot]?.no||'',sourceDate:state.prior?.[slot]?.date||'',sourceUrl:$(`d${slot.slice(1)}Url`)?.value||state.priorMeta?.[slot]?.url||'',time:new Date().toISOString()};
 state.reviewLog.push({time:new Date().toISOString(),action:"evidence_review",target:key,decision,note,quote,location,reason,next});
 if(decision!=="agree")delete state.matrixOverrides[overrideKey(fid,slot)];
 renderMatrix();renderReadiness();
 if(state.assessment&&Object.keys(state.assessment).length){state.assessment={};renderAssessment();}
}
function renderEvidenceReview(){
 const root=$("evidenceReviewBody");if(!root)return;
 readPrior();
 const cards=[];
 const filter=$("evidenceFilter")?.value||"all";
 let total=0,approved=0,rejected=0;
 for(const r of state.matrix){
   const f=state.features.find(x=>x.id===r[0]);if(!f)continue;
   for(const slot of ["D1","D2","D3"]){
     const doc=state.prior?.[slot]||{};
     if(!doc.no&&!doc.text)continue;
     const e=suggestedEvidenceFor(f.id,slot);
     const key=evidenceReviewKey(f.id,slot),review=state.evidenceReviews?.[key]||{};
     const original=r[{D1:1,D2:2,D3:3}[slot]]||"Chưa có dữ liệu";
     const effective=effectiveMatrixStatus(f.id,slot,original);
     total++;
     if(expertConfirmedStatus(f.id,slot))approved++;
     if(review.decision==="reject")rejected++;
     if(filter==="pending"&&(expertConfirmedStatus(f.id,slot)||review.decision==="reject"))continue;
     if(filter==="reject"&&review.decision!=="reject")continue;
     if(filter==="agree"&&!expertConfirmedStatus(f.id,slot))continue;
     const options=[['pending','Chưa kiểm tra'],['agree','✓ Xác nhận đoạn chứng cứ'],['reject','✕ Không đồng ý'],['uncertain','? Cần xem thêm'],['absence_reviewed','Đã khảo sát nhưng chưa phát hiện (không kết luận vắng mặt)']].map(([v,t])=>`<option value="${v}" ${review.decision===v?'selected':''}>${t}</option>`).join("");
     const reasons=[['','Chọn lý do nếu không đồng ý'],['missing','Đoạn nguồn thiếu điều kiện / số liệu / thứ tự'],['translation','Bản dịch / thuật ngữ chưa đúng'],['feature','Tách đặc điểm chưa đúng'],['source','Sai tài liệu / ngày / phiên bản'],['other','Lý do khác']].map(([v,t])=>`<option value="${v}" ${review.reason===v?'selected':''}>${t}</option>`).join("");
     const actions=[['','Chọn việc tiếp theo'],['requery','Bổ sung từ khóa của đặc điểm'],['source','Đọc toàn văn và hình vẽ gốc'],['translate','Kiểm tra lại cách dịch'],['alternative','Tìm tài liệu khác'],['claim','Sửa lại đặc điểm/claim']].map(([v,t])=>`<option value="${v}" ${review.next===v?'selected':''}>${t}</option>`).join("");
     const stateLabel=expertConfirmedStatus(f.id,slot)?'Đã xác nhận đoạn nguồn':review.decision==="reject"?'Đã bác bỏ':review.decision==="absence_reviewed"?'Đã ghi phạm vi tra (chưa kết luận)':'Chờ chuyên gia';
     cards.push(`<article data-review-key="${esc(key)}" class="evidence-workcard ${expertConfirmedStatus(f.id,slot)?'is-approved':review.decision==='reject'?'is-rejected':''}">
       <header><span class="feature-id-badge">${esc(f.id)} × ${esc(slot)}</span><strong class="review-state-tag">${esc(stateLabel)}</strong><small>${esc(doc.no||'Tài liệu tự nhập')}</small></header>
       <div class="review-pair">
         <div class="review-side"><span class="review-eyebrow">① NỘI DUNG CẦN BẢO HỘ</span><p>${esc(f.text)}</p><small>Nguyên văn đặc điểm đã tách — soát lại claim nếu sai.</small></div>
         <div class="review-side evidence-side"><span class="review-eyebrow">② VĂN BẢN HỆ THỐNG GỢI Ý · CHƯA XÁC MINH NGUỒN</span><p>${esc(e.text.slice(0,750)||'Chưa tìm thấy đoạn đủ rõ.')}</p>
           ${/^https:\/\//i.test(e.source||'')?`<a href="${esc(e.source)}" target="_blank" rel="noopener noreferrer">Mở tài liệu gốc ↗</a>`:'<strong class="alert-inline">Chưa có URL nguồn; không thể xác nhận.</strong>'}
           <button class="btn" type="button" data-view-source="${esc(key)}">Đọc văn bản đã nạp cạnh đặc điểm ↗</button>
           <small>Gợi ý tự động, không phải trích dẫn đã xác minh. Đối chiếu nguyên văn, ngữ cảnh, số liệu và vị trí trong bản gốc trước khi duyệt.</small></div>
       </div>
       <div class="review-assertions"><div><span>MÁY ĐỀ XUẤT · CHƯA ĐƯỢC DUYỆT</span><strong>${esc(original)}</strong></div><div><span>CHUYÊN GIA XÁC NHẬN · DÙNG CHO NHẬN ĐỊNH</span><strong>${esc(effective)}</strong></div></div>
       <div class="review-form">
         <label>③ Chuyên gia kiểm tra rồi đưa quyết định<select data-review-decision aria-label="Quyết định ${esc(key)}">${options}</select></label>
         <label>Mức độ bộc lộ do CHUYÊN GIA tự chọn (chỉ khi xác nhận bằng chứng)<select data-expert-status aria-label="Mức độ bộc lộ được duyệt ${esc(key)}"><option value="">Chưa xác định</option><option value="Có" ${review.expertStatus==='Có'?'selected':''}>Có — đủ dấu hiệu này trong ngữ cảnh</option><option value="Một phần" ${review.expertStatus==='Một phần'?'selected':''}>Một phần — chưa bộc lộ đủ dấu hiệu</option></select></label>
         <label>Nguyên văn bằng chứng đã kiểm tra trong bản gốc<textarea data-review-quote rows="2" placeholder="Dán đoạn chính xác từ tài liệu gốc; để trống nếu chưa xác minh.">${esc(review.quote||'')}</textarea></label>
         <label>Vị trí trong tài liệu<input data-review-location value="${esc(review.location||'')}" placeholder="Ví dụ: trang 5, đoạn [0048], hình 2"/></label>
         <details class="absence-review"><summary>Nếu đã rà soát mà chưa phát hiện đặc điểm · ghi phạm vi kiểm tra</summary><label><input type="checkbox" data-absence-reviewed ${review.absenceCheck?'checked':''}/> Tôi đã trực tiếp xem bản gốc, tra nhiều cách diễn đạt và xem các phần tài liệu có liên quan. Tôi hiểu Ctrl+F đơn lẻ không thể chứng minh dấu hiệu vắng mặt.</label><label>Đã kiểm tra những phần nào, từ khóa nào, hình vẽ nào?<textarea data-absence-scope rows="2" placeholder="Ví dụ: claim 1–10, mô tả trang 2–8, hình 1–4, thuật ngữ thay thế...">${esc(review.absenceScope||'')}</textarea></label><small>Ghi nhật ký kiểm tra; trạng thái pháp lý vẫn là CHƯA ĐỦ CƠ SỞ nếu thiếu chứng cứ.</small></details><label>Lý do/nhận xét của chuyên gia<textarea data-review-note rows="2" placeholder="Vì sao giống, thiếu điều kiện nào hoặc cần đọc thêm?">${esc(review.note||'')}</textarea></label>
         <div class="review-duo"><label>Nếu không đồng ý: thiếu/sai ở đâu?<select data-review-reason>${reasons}</select></label>
         <label>Tiếp theo phải làm gì?<select data-review-next>${actions}</select></label></div>
         <div class="review-controls"><button class="btn primary" data-review-save="${esc(key)}" type="button">Lưu nhận định</button><button class="btn" data-review-go="${esc(key)}" type="button">Đi tới bước xử lý →</button><span class="review-feedback" data-review-feedback role="status">${review.time?`Đã lưu lúc ${esc(review.time)}.`:'Chưa xác nhận — không được tính là bằng chứng đã duyệt.'}</span></div>
       </div>
     </article>`);
   }
 }
 root.innerHTML=cards.join("")||'<div class="empty">Chưa có mục phù hợp. Chọn tài liệu ở bước 5 rồi tạo ma trận; hoặc đổi bộ lọc.</div>';
 if($("evidenceProgress"))$("evidenceProgress").textContent=`Đã đồng ý ${approved}/${total} · Bác bỏ ${rejected} · Còn ${Math.max(0,total-approved-rejected)} cần xem`;
 root.querySelectorAll('[data-review-save]').forEach(btn=>btn.onclick=()=>{const parts=btn.dataset.reviewSave.split('::');saveEvidenceReview(parts[0],parts[1]);});
 root.querySelectorAll('[data-view-source]').forEach(btn=>btn.onclick=()=>{
  const [fid,slot]=btn.dataset.viewSource.split('::'),p=state.prior?.[slot]||{},panel=$('sourceReadPanel');if(!panel)return;
  $('sourceReadHeading').textContent=`${slot} · ${p.no||'Chưa khai báo mã'} · Phần văn bản đã nạp`;
  $('sourceReadFeature').textContent=state.features.find(f=>f.id===fid)?.text||'';
  $('sourceReadText').value=p.text||'Chưa có văn bản được nạp; mở tài liệu gốc tại Bước 5 để tự kiểm tra.';
  const link=$('sourceReadLink'),url=$(`d${slot.slice(1)}Url`)?.value||state.priorMeta?.[slot]?.url||'';
  link.hidden=!/^https:\/\//i.test(url);if(!link.hidden)link.href=url;else link.removeAttribute('href');
  panel.hidden=false;panel.scrollIntoView({block:'nearest',behavior:'smooth'});
 });
 root.querySelectorAll('[data-review-go]').forEach(btn=>btn.onclick=()=>{
   const key=btn.dataset.reviewGo,card=Array.from(root.querySelectorAll('[data-review-key]')).find(x=>x.dataset.reviewKey===key);
   const next=card?.querySelector('[data-review-next]')?.value||state.evidenceReviews?.[key]?.next||'';
   const [fid,slot]=key.split('::');
   if(!next){const feedback=card?.querySelector('[data-review-feedback]');if(feedback)feedback.textContent='Hãy chọn việc tiếp theo, rồi bấm Lưu nhận định.';return;}
   if(next==='source'){
     const url=suggestedEvidenceFor(fid,slot).source;
     if(url&&/^https:\/\//i.test(url))window.open(url,'_blank','noopener,noreferrer');
     else alert('Bổ sung đường dẫn HTTPS của tài liệu gốc tại bước 5.');
   }else if(next==='claim')showStep(1);
   else if(next==='alternative')showStep(4);
   else if(next==='requery'||next==='translate'){
     showStep(3);const field=document.querySelector(`[data-facet="${fid}"]`);
     if(field){field.focus();field.scrollIntoView({block:'center',behavior:'smooth'});}
   }
 });
}
if($("evidenceFilter"))$("evidenceFilter").onchange=()=>renderEvidenceReview();
if($("sourceReadClose"))$("sourceReadClose").onclick=()=>{$("sourceReadPanel").hidden=true;};
function renderMatrix(){
  readPrior();
  renderMatrixSummary();
  renderReadiness();

  const featureMap=Object.fromEntries(state.features.map(f=>[f.id,f.text]));
  let rows=state.matrix;

  if(state.matrixOnlyDifferences){
    rows=rows.filter(r=>!["D1","D2","D3"].every((s,i)=>effectiveMatrixStatus(r[0],s,r[i+1])==="Có"));
  }

  if(!rows.length){
    $("matrixBody").innerHTML='<tr><td colspan="5" style="text-align:center;color:#667085;padding:24px">Không có dòng nào trong chế độ lọc hiện tại.</td></tr>';
    renderEvidenceReview();
    return;
  }

  $("matrixBody").innerHTML=rows.map(r=>`<tr>
    <td class="matrix-feature">
      <span class="feature-id-badge">${esc(r[0])}</span>
      <div style="font-size:12px;line-height:1.55;color:#344054">${esc(featureMap[r[0]]||"")}</div>
    </td>
    <td class="matrix-status-cell">${statusBox(effectiveMatrixStatus(r[0],"D1",r[1]))}</td>
    <td class="matrix-status-cell">${statusBox(effectiveMatrixStatus(r[0],"D2",r[2]))}</td>
    <td class="matrix-status-cell">${statusBox(effectiveMatrixStatus(r[0],"D3",r[3]))}</td>
    <td>
      <details class="evidence-details">
        <summary>Xem đoạn nguồn / ghi chú</summary>
        ${evidenceHtml(r[4]||"")}
      </details>
    </td>
  </tr>`).join("");
  // v26: no machine-to-expert override dropdown; reviewer chooses in each evidence card.
  renderEvidenceReview();
}

// Save audit-friendly rows. Two distinct columns prevent an AI proposal from masquerading as expert approval.
function csvField(value){
  let t=String(value??'');
  // Spreadsheet formula injection defense; applies also after leading whitespace.
  if(/^[\s\uFEFF]*[=+@-]/.test(t))t="'"+t;
  return '"'+t.replace(/"/g,'""')+'"';
}
function exportMatrixCSV(){
  if(!state.matrix.length)return alert('Chưa có bảng đối chiếu để xuất.');
  const headers=['Feature ID','Claim ID','Dấu hiệu kỹ thuật','Tài liệu','Số công bố (người dùng cung cấp)','Gợi ý AI / máy (CHƯA DUYỆT)','Chuyên gia xác nhận (nếu có)','Đoạn trích do chuyên gia xác nhận','Vị trí trong bản gốc','Nhận xét chuyên gia','Tình trạng quét văn bản đã nạp'];
  const rows=[headers];
  for(const row of state.matrix){
    const f=state.features.find(x=>x.id===row[0])||{};
    for(const [i,slot] of ['D1','D2','D3'].entries()){
      const review=state.evidenceReviews?.[evidenceReviewKey(row[0],slot)]||{};
      rows.push([row[0],f.claimId||f.claim_id||'',f.text||'',slot,state.prior?.[slot]?.no||'',row[i+1]||'Chưa có dữ liệu',expertConfirmedStatus(row[0],slot)||'CHƯA DUYỆT',expertConfirmedStatus(row[0],slot)?(review.quote||''):'',expertConfirmedStatus(row[0],slot)?(review.location||''):'',expertConfirmedStatus(row[0],slot)?(review.note||''):'',state.matrixScanAudit?.[slot]?(state.matrixScanAudit[slot].complete?'Đã chạy đủ lượt trên VĂN BẢN ĐÃ NẠP':'CHƯA CHẠY ĐỦ'):'Chưa có kiểm toán AI']);
    }
  }
  const blob=new Blob(['\uFEFF'+rows.map(row=>row.map(csvField).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='PatentLens_claim_chart_v30.csv';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(link.href),60000);
}
if($('exportMatrixCSV'))$('exportMatrixCSV').onclick=exportMatrixCSV;
// v26: manual overrides removed from UI; prior v25 overrides are not a source of expert confirmation.
if($("toggleMatrixDifferences")){
  $("toggleMatrixDifferences").onclick=()=>{
    state.matrixOnlyDifferences=!state.matrixOnlyDifferences;
    $("toggleMatrixDifferences").classList.toggle("matrix-filter-active",state.matrixOnlyDifferences);
    $("toggleMatrixDifferences").textContent=state.matrixOnlyDifferences?"Hiện tất cả feature":"Chỉ xem điểm khác biệt";
    renderMatrix();
  };
}

function priorSlotLabel(slot){
  const p=state.prior?.[slot]||{};
  const n=p.no||"chưa có số";
  const txt=cleanPatentContent(p.text||"");
  const title=(txt.match(/(?:^|\n)TIÊU ĐỀ\s*\n([^\n]+)/i)||txt.match(/(?:^|\n)TITLE\s*\n([^\n]+)/i)||[])[1]||"";
  return `${slot} · ${n}${title?` · ${title.slice(0,70)}`:""}`;
}

function refreshClosestOptions(preferred){
  readPrior();
  const sel=$("closest");
  if(!sel) return;
  const prev=preferred!==undefined?preferred:(sel.value||"");
  sel.innerHTML='<option value="">— Chuyên gia chọn tài liệu để bắt đầu —</option>'+["D1","D2","D3"].map(k=>{
    const p=state.prior[k]||{};
    const disabled=(!p.no&&!String(p.text||"").trim())?" disabled":"";
    return `<option value="${k}"${disabled}>${esc(priorSlotLabel(k))}</option>`;
  }).join("");
  const available=["D1","D2","D3"].filter(k=>{
    const p=state.prior[k]||{};
    return p.no||String(p.text||"").trim();
  });
  sel.value=available.includes(prev)?prev:"";
}

function matrixColForSlot(slot){
  return {D1:1,D2:2,D3:3}[slot]||1;
}

function matrixStatusForFeature(featureId,slot){
  const row=state.matrix.find(r=>r[0]===featureId);
  if(!row) return "Chưa có dữ liệu";
  const auto=row[matrixColForSlot(slot)]||"Chưa có dữ liệu";return effectiveMatrixStatus(featureId,slot,auto);
}

function differenceFeaturesFor(slot){
  const chosen=$('assessmentClaim')?.value;
  if(!chosen)return [];
  return claimFeatures(Number(chosen)).map(f=>({
    id:f.id,
    text:f.text,
    status:matrixStatusForFeature(f.id,slot)
  })).filter(x=>x.status!=="Có");
}

function clearlyDifferentFeaturesFor(slot){
  // "Một phần" vẫn là khác biệt một phần; "Chưa chắc chắn" phải nêu rõ độ bất định.
  return differenceFeaturesFor(slot).filter(x=>
    ["Một phần","Chưa chắc chắn","Không tìm thấy","Chưa có dữ liệu"].includes(x.status)
  );
}

function featureLanguage(feature){
  const d=detectTextLanguage(feature?.text||"");
  return d.lang;
}

function formatDifferencesOneLanguage(slot,lang,diffs){
  if(!diffs.length){
    return lang==="en"
      ? `According to the current matrix, ${slot} is mapped as disclosing all confirmed features. Evidence must be re-checked before any novelty conclusion.`
      : `Theo ma trận hiện tại, ${slot} đang được mapping là bộc lộ toàn bộ các dấu hiệu đã xác nhận. Cần kiểm tra lại evidence trước khi kết luận mất tính mới.`;
  }

  return diffs.map(x=>{
    const status=x.status;
    return `• ${x.id} [${status}]: ${x.text}`;
  }).join("\n");
}

function formatDifferences(slot){
  const diffs=clearlyDifferentFeaturesFor(slot);
  const lang=resolveAnalysisLanguage();

  if(lang==="mixed"){
    const vi=diffs.filter(x=>featureLanguage(x)==="vi");
    const en=diffs.filter(x=>featureLanguage(x)==="en");
    const other=diffs.filter(x=>!["vi","en"].includes(featureLanguage(x)));
    const blocks=[];
    if(vi.length) blocks.push("[VI]\n"+formatDifferencesOneLanguage(slot,"vi",vi));
    if(en.length) blocks.push("[EN]\n"+formatDifferencesOneLanguage(slot,"en",en));
    if(other.length) blocks.push("[UNRESOLVED]\n"+other.map(x=>`• ${x.id}: ${x.text}`).join("\n"));
    return blocks.join("\n\n") || "Chưa có dấu hiệu khác biệt rõ.";
  }

  return formatDifferencesOneLanguage(slot,lang==="en"?"en":"vi",diffs);
}


function syncTechnicalEffects(slot){const body=$("effectBody");if(!body)return;const diffs=clearlyDifferentFeaturesFor(slot);if(!diffs.length){body.innerHTML='<tr><td colspan="5" class="status">Không có dấu hiệu khác biệt rõ để lập effect table.</td></tr>';return}for(const d of diffs)if(!state.technicalEffects[d.id])state.technicalEffects[d.id]={effect:'',evidence:'',verified:false};body.innerHTML=diffs.map(d=>{const x=state.technicalEffects[d.id]||{};return `<tr><td><strong>${esc(d.id)}</strong><div class="status">${esc(d.text)}</div></td><td>${statusBox(d.status)}</td><td><textarea data-effect="${esc(d.id)}" placeholder="Tác dụng kỹ thuật do hồ sơ hỗ trợ...">${esc(x.effect||'')}</textarea></td><td><textarea data-effect-evidence="${esc(d.id)}" placeholder="Đoạn mô tả / thử nghiệm hỗ trợ...">${esc(x.evidence||'')}</textarea></td><td style="text-align:center"><input type="checkbox" data-effect-verified="${esc(d.id)}" ${x.verified?'checked':''}></td></tr>`}).join('');document.querySelectorAll('[data-effect]').forEach(el=>el.oninput=()=>{state.technicalEffects[el.dataset.effect].effect=el.value;renderReadiness()});document.querySelectorAll('[data-effect-evidence]').forEach(el=>el.oninput=()=>{state.technicalEffects[el.dataset.effectEvidence].evidence=el.value;renderReadiness()});document.querySelectorAll('[data-effect-verified]').forEach(el=>el.onchange=()=>{state.technicalEffects[el.dataset.effectVerified].verified=el.checked;state.reviewLog.push({time:new Date().toISOString(),action:'technical_effect_verify',target:el.dataset.effectVerified,value:el.checked});renderReadiness()})}
function technicalEffectsReady(slot){const diffs=clearlyDifferentFeaturesFor(slot);return !!diffs.length&&diffs.every(d=>{const x=state.technicalEffects[d.id];return !!(x?.verified&&x.effect.trim()&&x.evidence.trim())})}
function verifiedEffectSummary(slot){const diffs=clearlyDifferentFeaturesFor(slot);return diffs.map(d=>({id:d.id,...(state.technicalEffects[d.id]||{})})).filter(x=>x.verified&&x.effect).map(x=>`${x.id}: ${x.effect}`).join('; ')}
function objectiveProblemFromDifferences(slot){
  return 'Chưa chốt: chuyên gia cần xác minh tác dụng kỹ thuật và tự diễn đạt vấn đề cần giải quyết, không chứa đặc điểm của giải pháp.';
}

function selectedPriorSummary(slot){
  const p=state.prior?.[slot]||{};
  const meta=state.priorMeta?.[slot]||{};
  const date=p.date?esc(p.date):"Chưa ghi / chưa kiểm tra";
  const identity=p.no?esc(p.no):"Chưa ghi mã tài liệu";
  const level=meta.content_level?esc(meta.content_level):"Chưa rõ phạm vi văn bản đã đọc";
  const checked=sourceVerified(slot)
    ?"Người dùng đã ghi nhận bước xác minh nguồn; chuyên gia vẫn cần kiểm tra bản gốc và ngữ cảnh kỹ thuật."
    :"Chưa có đủ xác minh về danh tính tài liệu, ngày hoặc nội dung nguồn.";
  return `<strong>${esc(slot)} · ${identity}</strong><div class="status">Ngày công bố/bộc lộ: ${date} · Phần văn bản đang có: ${level}</div><div class="status">${checked}</div><div class="status">Đây là tài liệu chuyên gia <em>chọn để bắt đầu phân tích</em>, không phải tài liệu gần nhất do AI hay thuật toán khẳng định. Hãy ghi lý do lựa chọn ở ô bên dưới.</div>`;
}

function syncAssessmentFields(options={}){
  readPrior();
  refreshClosestOptions(options.slot);
  const slot=$("closest").value;
  if(!$('assessmentClaim')?.value){if($("assessmentSource"))$("assessmentSource").textContent="Chọn claim tại Bước 7 nếu cần phân tích trình độ sáng tạo chuyên sâu.";return;}
  if(!slot){if($("assessmentSource"))$("assessmentSource").textContent="Hãy chọn tài liệu gần nhất; hệ thống không tự chọn thay chuyên gia.";return;}

  if($("closestSummary")) $("closestSummary").innerHTML=selectedPriorSummary(slot);

  $("differences").value=formatDifferences(slot);
  syncTechnicalEffects(slot);
  if(!$("problem").value.trim())$("problem").placeholder=objectiveProblemFromDifferences(slot);
  if(!$("reasoning").value.trim())$("reasoning").placeholder="Chuyên gia xem xét động cơ kết hợp và căn cứ trong nguồn; không suy diễn tự động từ số dấu hiệu giống nhau.";

  const p=state.prior?.[slot]||{};
  if($("assessmentSource")){
    const al=resolveAnalysisLanguage();
    $("assessmentSource").innerHTML=al==="en"
      ? `Auto-filled from <strong>${esc(slot)}${p.no?` · ${esc(p.no)}`:""}</strong> + the D1–D3 matrix. Source-language text is preserved; you may edit before expert review.`
      : al==="mixed"
        ? `Đã tự điền từ <strong>${esc(slot)}${p.no?` · ${esc(p.no)}`:""}</strong>. Nội dung Việt/Anh được giữ tách riêng, không dịch chéo.`
        : `Đã tự điền từ <strong>${esc(slot)}${p.no?` · ${esc(p.no)}`:""}</strong> + ma trận D1–D3. Bạn có thể chỉnh tay trước khi chuyên gia rà soát.`;
  }
}

function chooseClosestAutomatically(){
  // This is only an initial display slot, NOT closest-prior-art determination.
  const selected=['D1','D2','D3'].find(k=>state.prior?.[k]?.no||state.prior?.[k]?.text);
  return selected||'D1';
}

if($('suggestMotivation'))$('suggestMotivation').onclick=async()=>{
  const btn=$('suggestMotivation'),feedback=$('motivationFeedback'),result=$('motivationResult');
  if(isConfidentialMode()){feedback.textContent='Bảo mật đang bật: không gửi dữ liệu tài liệu ra AI ngoài.';return;}
  if(!$('motivationAiConsent')?.checked){feedback.textContent='Cần đồng ý rõ ràng trước khi gửi nội dung tài liệu ra AI ngoài.';return;}
  const issue=deepSearchPrerequisites();if(issue){feedback.textContent=issue;return;}
  readPrior();
  const chunks=[];
  for(const slot of ['D2','D3']){
    const p=state.prior?.[slot]||{},m=state.priorMeta?.[slot]||{};
    if(p.text?.trim().length>=40&&m.content_level!=='snippet_only')
      for(const [i,part] of patentTextChunks(cleanPatentContent(p.text),7000,450).entries())chunks.push({slot,i,part});
  }
  if(!chunks.length){feedback.textContent='Chưa có văn bản D2/D3 đủ để gợi ý; thêm tài liệu gốc trước.';return;}
  if(!confirm(`Tìm câu trích liên quan sẽ gọi AI ${chunks.length} lượt cho TOÀN BỘ văn bản D2/D3 đã nhập. Có thể phát sinh chi phí. Đồng ý?`))return;
  btn.disabled=true;result.replaceChildren();let done=0,failed=0,count=0;
  const diffs=clearlyDifferentFeaturesFor($('closest').value).map(x=>x.text).join(' · ');
  for(const job of chunks){
    feedback.textContent=`Đang đọc đoạn D2/D3: ${done+failed+1}/${chunks.length}…`;
    try{
      const data=await guardedResearchRequest('/api/motivation',{documents:{[job.slot]:{no:state.prior[job.slot]?.no||'',text:job.part.text,content_level:'chunk_only'}},feature:diffs,confidential_mode:false,external_ai_consent:true});
      done++;
      for(const row of data.results?.[job.slot]||[]){
        count++;
        const article=document.createElement('article');article.className='evidence-workcard';
        const head=document.createElement('strong');head.textContent=`${job.slot} · đoạn ${job.i+1} · ký tự ${job.part.start+1}–${job.part.end} (văn bản đã nhập; chưa xác minh nguồn)`;
        const passage=document.createElement('blockquote');passage.textContent=row.quote;
        const explain=document.createElement('p');explain.className='status';explain.textContent=row.why_relevant||'Chuyên gia kiểm tra ngữ cảnh trước khi sử dụng.';
        article.append(head,passage,explain);result.append(article);
      }
    }catch(e){failed++;state.reviewLog.push({time:new Date().toISOString(),action:'motivation_chunk_failed',slot:job.slot,chunk:job.i+1,error:String(e.message||e)});
      if(/401|403|429|503|quota|access|key/i.test(String(e.message||e))){failed+=chunks.length-done-failed;break;}
    }
    if((done+failed)%4===0)await sleep(0);
  }
  feedback.textContent=`Đã thử ${done}/${chunks.length} đoạn; ${failed?'CHƯA ĐỌC HẾT ('+failed+' đoạn lỗi).':'đã chạy toàn bộ VĂN BẢN NHẬP (không bao gồm hình vẽ).'} ${count} câu trích GỢI Ý; không chứng minh động cơ kết hợp, tính sáng tạo hoặc tài liệu gốc.`;
  state.reviewLog.push({time:new Date().toISOString(),action:'motivation_chunks',done,failed,total:chunks.length,count,source_verified:false});
  btn.disabled=false;
};

$("runAssessment").onclick=()=>{
  if(!state.matrix.length)return alert("Hãy tạo ma trận trước.");
  if(!inputGate().ok){$("assessmentSourceReview").open=true;$("researchAdvanced").open=true;$("assessmentSourceReview").scrollIntoView({block:"start",behavior:"smooth"});alert("Để tổng hợp nhận định có căn cứ, hãy kiểm tra nguồn, phiên bản claims và ngày tại mục ở đầu Bước 7. Nếu chưa đủ căn cứ, giữ trạng thái chưa đủ cơ sở.");return}
  readPrior(); renderReadiness();
  const readiness=state.assessmentChecks||{};
  if(!$('assessmentClaim')?.value)return alert("Bảng tính mới đã được chia theo từng claim phía trên. Chỉ khi muốn phân tích sâu trình độ sáng tạo, hãy chọn một claim tại Bước 7.");
  if(!$("closest").value)return alert("Chuyên gia cần chủ động chọn tài liệu đối chứng gần nhất cho claim đã chọn.");
  if(($("closestReason")?.value||"").trim().length<12)return alert("Ghi lý do chọn tài liệu gần nhất dựa trên mục đích, tác dụng kỹ thuật và nguồn gốc (ít nhất 12 ký tự).");
  if(!$("differences").value.trim())syncAssessmentFields({slot:$("closest").value});
  const eligibleSlots=["D1","D2","D3"].filter(s=>priorEligible(s)===true);
  const noveltyDestroyers=eligibleSlots.filter(s=>matrixAllYes(s) && sourceVerified(s) && state.priorMeta?.[s]?.content_level!=='snippet_only' && (!state.matrixScanAudit?.[s]||state.matrixScanAudit[s].complete));
  const closest=$("closest").value; // Human-picked and justified; no automated closest prior art.
  const diffs=clearlyDifferentFeaturesFor(closest);
  const cw=collectCouldWould();
  state.reviewData.couldWould=cw;
  state.reviewData.closestJustification={claimId:Number($('assessmentClaim').value),slot:closest,reason:$("closestReason").value.trim(),time:new Date().toISOString()};
  const unresolvedDates=["D1","D2","D3"].filter(s=>{const p=state.prior?.[s];return p&&(p.no||p.text)&&priorEligible(s)===null});
  const sourceGaps=['D1','D2','D3'].filter(s=>(state.prior?.[s]?.no||state.prior?.[s]?.text) && (state.priorMeta?.[s]?.content_level==='snippet_only'||state.priorMeta?.[s]?.description_truncated));
  const scanGaps=[];
  if(!pdfCoverageReady())scanGaps.push('Tài liệu đầu vào còn trang OCR chưa đọc được');
  if(state.pdf&&!state.claimCoverage?.completeSequence)scanGaps.push('Số thứ tự claims chưa liên tục / chưa nhận diện đủ');
  for(const s of ['D1','D2','D3'])if(state.matrixScanAudit?.[s]&&!state.matrixScanAudit[s].complete)scanGaps.push(s+' phân tích AI chưa chạy hết các đoạn');
  const hardFail=(readiness.hardFail || 0) + (sourceGaps.length ? 1 : 0) + (scanGaps.length ? 1 : 0);
  let noveltyRisk,noveltyText;
  if(hardFail){
    noveltyRisk="CHƯA ĐỦ DỮ LIỆU";
    noveltyText=`Có ${hardFail} điều kiện cần kiểm tra: claim, ngày, nguồn, nội dung mô tả/hình vẽ hoặc bằng chứng. ${sourceGaps.length?'Tài liệu '+sourceGaps.join(', ')+' mới có snippet hoặc bị cắt mô tả. ':''}Không có bằng chứng không đồng nghĩa với chứng minh có tính mới.`;
  }else if(noveltyDestroyers.length){
    noveltyRisk="ỨNG VIÊN MẤT TÍNH MỚI";
    noveltyText=`${noveltyDestroyers.join(", ")} là tài liệu công bố trước ngày liên quan và hiện được mapping là bộc lộ toàn bộ dấu hiệu của claim. Đây mới là ứng viên novelty-destroying reference; cần đọc trực tiếp từng evidence trước khi kết luận.`;
  }else{
    noveltyRisk="CHƯA ĐỦ CƠ SỞ KHẲNG ĐỊNH TÍNH MỚI";
    noveltyText=`Trong các tài liệu có ngày công bố đã xác minh trước mốc (${eligibleSlots.join(", ")||"chưa có"}), chưa có một tài liệu đơn lẻ được mapping là bộc lộ toàn bộ dấu hiệu. ${unresolvedDates.length?`Còn ${unresolvedDates.join(", ")} chưa xác minh ngày công bố.`:""}`;
  }
  const motivation=cw.motivation?.status||"Chưa đánh giá";
  const success=cw.success?.status||"Chưa đánh giá";
  const effectsReady=technicalEffectsReady(closest);
  const inventiveRisk="CHỜ CHUYÊN GIA ĐÁNH GIÁ TRÌNH ĐỘ SÁNG TẠO"; // Cannot auto-determine obviousness from keyword coverage.
  const inventiveText=diffs.length
    ?`Chọn ${closest}${state.prior?.[closest]?.no?` (${state.prior[closest].no})`:""} làm closest-prior-art candidate và xác định ${diffs.length} dấu hiệu khác biệt/chưa rõ. Việc D2/D3 cùng nhau bao phủ feature chỉ tạo Y-candidate; không đủ để kết luận hiển nhiên nếu chưa chứng minh người có hiểu biết trung bình <em>would</em> kết hợp các tài liệu với động cơ và kỳ vọng thành công hợp lý.`
    :`Chưa xác định dấu hiệu khác biệt rõ so với ${closest}; cần kiểm tra lại evidence hoặc việc lựa chọn closest prior art.`;
  const perClaim=claimNoveltyRows();
  state.assessment={noveltyRisk:state.claims.length>1?'XEM NHẬN ĐỊNH RIÊNG TỪNG CLAIM':noveltyRisk,
    noveltyText:state.claims.length>1?'Không gộp toàn bộ claims thành một yêu cầu bảo hộ: xem bảng trạng thái theo từng claim bên dưới. Một nhận định cho claim 1 không áp dụng tự động cho claim 2, 3...':noveltyText,
    inventiveRisk,inventiveText,perClaim};
  renderAssessment();renderPerClaimResults();
};
function renderDateReviewWarning(){
  const box=$("dateReviewWarning");if(!box)return;
  const unresolved=["D1","D2","D3"].filter(slot=>{
    const p=state.prior?.[slot]||{};
    return !!(p.no||p.text)&&priorEligible(slot)!==true;
  });
  if(!unresolved.length){box.hidden=true;box.textContent="";return;}
  box.hidden=false;
  box.innerHTML=`<strong>⚠ Cần chuyên gia kiểm tra mốc thời gian: ${esc(unresolved.join(", "))}</strong><p>Tài liệu có thể thiếu ngày hoặc được công bố vào/sau mốc đang xét. Không tự loại và cũng không tự tính là tài liệu đối chứng đủ điều kiện. Hãy kiểm tra ngày nộp, ngày ưu tiên, ngày công bố, quan hệ giữa các đơn và quy định hiện hành áp dụng (bao gồm trường hợp đơn nộp trước, công bố sau nếu phù hợp).</p>`;
}
function renderAssessment(){
  renderDateReviewWarning();renderPerClaimResults();
  $("noveltyText").innerHTML=state.assessment.noveltyText||"";
  $("inventiveText").innerHTML=state.assessment.inventiveText||"";
  const nr=state.assessment.noveltyRisk||"CHỜ DỮ LIỆU",ir=state.assessment.inventiveRisk||"CHỜ DỮ LIỆU";
  $("noveltyRisk").textContent=nr; $("inventiveRisk").textContent=ir;
  $("noveltyRisk").className="riskbox "+(nr.includes("MẤT")?"red":"yellow"); // no evidence found is never a green legal clearance
  $("inventiveRisk").className="riskbox yellow";
  renderReadiness(); renderExpert();
}
function expertReviewRows(){return [["Dấu hiệu kỹ thuật",`${state.features.length} feature`],["Chiến lược tra cứu",`${state.queries.length} query`],["Prior art",Object.values(state.prior).filter(x=>x&&x.no).map(x=>x.no).join(", ")||"Chưa có"],["Bảng đối chiếu",`${state.matrix.length} feature`],["Tính mới",state.assessment.noveltyRisk||"Chưa đánh giá"],["Trình độ sáng tạo",state.assessment.inventiveRisk||"Chưa đánh giá"]]}
function renderExpert(){
 const rows=expertReviewRows(),saved=state.reviewData?.expertItems||[];
 $("expertBody").innerHTML=rows.map((r,i)=>{const v=saved[i]||{};return `<tr data-expert-row="${i}"><td><strong>${esc(r[0])}</strong></td><td>${esc(r[1])}</td><td><select data-r="${i}">${["Chờ rà soát","Xác nhận","Chỉnh sửa","Không đồng ý"].map(o=>`<option ${v.decision===o?'selected':''}>${o}</option>`).join('')}</select></td><td><input data-expert-note="${i}" value="${esc(v.note||'')}" placeholder="Ghi rõ nguồn và lý do"></td></tr>`}).join('');
 const filter=$('expertFilter')?.value||'all';applyExpertReviewFilter(filter);
}
function applyExpertReviewFilter(value){document.querySelectorAll('[data-expert-row]').forEach(tr=>{const status=tr.querySelector('[data-r]')?.value||'Chờ rà soát';tr.hidden=value==='pending'?status!=='Chờ rà soát':value==='reviewed'?status==='Chờ rà soát':false;});}
if($('expertFilter'))$('expertFilter').onchange=()=>applyExpertReviewFilter($('expertFilter').value);
if($('assessmentClaim'))$('assessmentClaim').onchange=()=>{
 const c=state.claims.find(x=>String(x.id)===$('assessmentClaim').value);
 if(!c)return;
 state.selected=state.claims.findIndex(x=>x.id===c.id);
 if($('assessmentRelevantDate'))$('assessmentRelevantDate').value=claimRelevantDate(c.id);
 if($('closestReason'))$('closestReason').value='';
 if($('problem'))$('problem').value='';
 if($('reasoning'))$('reasoning').value='';
 if($('closest'))$('closest').value='';
 state.assessment={};renderAssessment();renderReadiness();
 if($('assessmentSource'))$('assessmentSource').textContent=`Đang phân tích chuyên sâu Claim ${c.id}. Chọn tài liệu đối chứng gần nhất và ghi căn cứ.`;
};
if($("closest")) $("closest").onchange=()=>{if($("closestReason"))$("closestReason").value="";syncAssessmentFields();};
if($("refreshAssessmentFields")) $("refreshAssessmentFields").onclick=()=>syncAssessmentFields({slot:$("closest").value});
$("saveReview").onclick=()=>{
 const items=[...document.querySelectorAll('[data-expert-row]')].map(tr=>({decision:tr.querySelector('[data-r]').value,note:tr.querySelector('[data-expert-note]').value.trim()}));
 if(items.some(x=>x.decision!=='Chờ rà soát'&&x.note.length<8))return alert('Mỗi hạng mục đã rà soát cần ghi nhận xét ít nhất 8 ký tự.');
 state.reviewData.expertItems=items;state.reviews=items.filter(x=>x.decision!=='Chờ rà soát').length;
 state.reviewLog.push({time:new Date().toISOString(),action:'expert_review_save',reviewed:state.reviews});alert('Đã lưu quyết định và lý do của chuyên gia vào phiên hiện tại. Hãy Lưu nháp để mang kết quả sang phiên khác.');
};



function caseSnapshot(){readPrior();readSourceVerification();return {schema:'patentlens-case-v29',version:'37.0.0',purpose:$('purposeChoice')?.value||'',searchFacetEdits:state.searchFacetEdits,searchFailures:state.searchFailures,searchPlanSkipped:state.searchPlanSkipped,inputScanAudit:state.inputScanAudit,documentAudit:state.documentAudit,matrixScanAudit:state.matrixScanAudit,evidenceReviews:state.evidenceReviews,provenance:inputProvenance(),manualClaims:$("manualClaimsInput")?.value||"",targetExcluded:state.targetExcluded,saved_at:new Date().toISOString(),metadata:{caseId:$("caseId").value,patentNo:$("patentNo").value,jurisdiction:$("jurisdiction").value,title:$("title").value,filingDate:$("filingDate").value,relevantDate:$("relevantDate").value,applicant:$("applicant").value,assignee:$("assignee").value,representative:$("representative").value,ipc:$("ipc").value,abstract:$("abstract").value},claims:state.claims,claimsText:state.claimsText,selected:state.selected,claimDates:state.claimDates,claimGroups:state.claimGroups||[],claimIssues:state.claimIssues||[],features:state.features,confirmed:state.confirmed,search:state.search,queries:state.queries,searchAudit:state.searchAudit,prior:state.prior,priorMeta:state.priorMeta,sourceVerification:state.sourceVerification,matrix:state.matrix,matrixOverrides:state.matrixOverrides,technicalEffects:state.technicalEffects,assessment:state.assessment,reviewData:state.reviewData,reviewLog:state.reviewLog,citationCategories:state.citationCategories}}
function downloadJson(obj,name){const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
function exportCaseJson(){const id=($('caseId').value||'PatentLens-case').replace(/[^A-Za-z0-9_-]/g,'_');state.reviewLog.push({time:new Date().toISOString(),action:'case_export'});downloadJson(caseSnapshot(),`${id}_v30.json`)}
function saveDraftNow(){
 const fb=$('draftFeedback');
 if(!confirm('Lưu nháp dạng JSON CHƯA MÃ HÓA xuống thiết bị này? Tệp có thể chứa claims chưa công bố và đoạn đối chứng. Chỉ dùng thiết bị an toàn; bản PDF gốc và khóa API không nằm trong tệp.'))return;
 exportCaseJson();if(fb)fb.textContent='✓ Đã tạo tệp nháp JSON trên thiết bị. Tệp không bao gồm PDF gốc.';
}
if($('saveDraftGlobal'))$('saveDraftGlobal').onclick=saveDraftNow;
if($('loadDraftGlobal'))$('loadDraftGlobal').onclick=()=>$('importCaseFile')?.click();
function restoreCaseSnapshot(s){if(!s||!String(s.schema||'').startsWith('patentlens-case'))throw new Error('Không đúng định dạng PatentLens case JSON.');if($("nextWorkPanel"))$("nextWorkPanel").hidden=true;state.pdf=null;state.documentAudit=null;state.pageText=[];state.pageColumnText=[];state.ocrPages={};state.rawText='';state.candidates=[];if($('ocrReviewGate'))$('ocrReviewGate').hidden=true;if($('manualReviewGate'))$('manualReviewGate').hidden=false;resetInputReview();const pr=s.provenance||{};for(const [id,v] of Object.entries({studyMode:pr.mode||'retrospective',documentVersion:pr.version||'published',inputSourceUrl:pr.source||'',targetRelatedPublications:pr.related||'',claimVersionNote:pr.claimNote||'',caseReference:pr.reference||'',manualDescriptionInput:pr.manualDescription||'',manualClaimsInput:s.manualClaims||s.claimsText||''}))if($(id))$(id).value=v;
  if($("inputVersionConfirmed"))$("inputVersionConfirmed").checked=false; // Reverify source after importing an editable local JSON snapshot.
  if($("relevantDateVerified"))$("relevantDateVerified").checked=false; // Priority/date evidence not bundled in JSON.
  state.targetExcluded=s.targetExcluded||[];state.importedDocumentIdentity=s.documentAudit||null;
  setActiveButton("[data-study-path]","data-study-path",pr.mode||"retrospective");
  setActiveButton("[data-doc-version]","data-doc-version",pr.version||"published");
  $("prospectiveSetup")?.classList.toggle("conditional-hidden",pr.mode!=="prospective");
  $("retrospectiveSetup")?.classList.toggle("conditional-hidden",pr.mode==="prospective");
  if($("purposeChoice")){ $("purposeChoice").value=(pr.mode||s.studyMode)==="prospective"?"patentability":"pilot"; updatePurposeChoice(); }
  revealDataWorkspace();renderInputMode();const md=s.metadata||{};for(const [id,v] of Object.entries({caseId:md.caseId,patentNo:md.patentNo,title:md.title,filingDate:md.filingDate,relevantDate:md.relevantDate,applicant:md.applicant,assignee:md.assignee,representative:md.representative,ipc:md.ipc,abstract:md.abstract}))if($(id))$(id).value=v||'';if($("jurisdiction"))$("jurisdiction").value=md.jurisdiction||'VN';state.claims=s.claims||[];state.claimsText=s.claimsText||'';checkManualInputReview();state.selected=s.selected||0;state.claimDates=s.claimDates||{};state.features=s.features||[];state.claimGroups=s.claimGroups||[];state.claimIssues=s.claimIssues||[];state.confirmed=!!s.confirmed;state.keywordOnly=!state.claims.length&&!!(s.manualClaims||s.provenance?.manualDescription);state.search=[];state.queries=[];state.searchAudit=s.searchAudit||[];state.searchFacetEdits={}; // v33: old draft facets may contain auto-generated OCR n-grams; rebuild from corrected claim text.
state.searchFailures=s.searchFailures||[];state.searchPlanSkipped=s.searchPlanSkipped||[];state.evidenceReviews=s.evidenceReviews||{};state.inputScanAudit=null;state.matrixScanAudit={};state.prior=s.prior||{};state.priorMeta=s.priorMeta||{};state.sourceVerification={};state.matrix=s.matrix||[];state.matrixOverrides=s.matrixOverrides||{}; // Imported evidence is reverified before reuse.
refreshTopicRouting();state.search=buildProSearchRows();state.queries=buildProQueries(state.search); // Rebuild old draft queries from current lexicon and corrected source.
state.technicalEffects=s.technicalEffects||{};state.assessment=s.assessment||{};state.reviewData=s.reviewData||{};state.reviews=(state.reviewData.expertItems||[]).filter(x=>x.decision!=='Chờ rà soát').length;state.reviewLog=s.reviewLog||[];state.citationCategories=s.citationCategories||{};$("claimsRaw").value=state.claimsText;$("claimsClean").value=formatClaimForDisplay(state.claimsText);renderClaims();renderFeatures();renderSearch();for(const slot of ['D1','D2','D3']){const n=slot.slice(1),p=state.prior[slot]||{},v=state.sourceVerification[slot]||{};$(`d${n}No`).value=p.no||'';$(`d${n}Date`).value=p.date||'';$(`d${n}Type`).value=p.type||'patent';$(`d${n}Text`).value=p.text||'';$(`d${n}Url`).value=state.priorMeta?.[slot]?.url||'';$(`d${n}VerifyDate`).checked=!!v.date;$(`d${n}VerifyText`).checked=!!v.text;$(`d${n}VerifyIdentity`).checked=!!v.identity;updatePriorQuality(slot)}renderSearchAudit();renderSearchGap();renderMatrix();renderAssessment();renderReadiness();renderExpert();updatePriorSlotVisuals();state.reviewLog.push({time:new Date().toISOString(),action:'case_import'});alert('Đã mở nháp. Tệp không chứa PDF gốc; mọi xác nhận nguồn, ngày và nội dung đầu vào cần kiểm tra lại. Kết quả chuyên gia cũ vẫn được lưu làm nhật ký nhưng chưa dùng làm kết luận đến khi tái xác minh.')}
if($("exportCase"))$("exportCase").onclick=exportCaseJson;if($("importCaseBtn"))$("importCaseBtn").onclick=()=>$("importCaseFile").click();if($("importCaseFile"))$("importCaseFile").onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{restoreCaseSnapshot(JSON.parse(await f.text()))}catch(err){alert('Không nhập được case: '+String(err.message||err))}e.target.value=''};
$("genReport").onclick=()=>{
  readPrior(); proposeCitationCategories(); renderReadiness();
  if(!inputGate().ok){if($("nextWorkPanel"))$("nextWorkPanel").hidden=true;$("reportContent").innerHTML='<div class="mode-hint err"><strong>CHƯA ĐỦ CƠ SỞ XUẤT NHẬN ĐỊNH:</strong> thiếu xác minh nguồn, phiên bản claim hoặc ngày. Kiểm tra tại mục đầu Bước 7; không tự tích xác nhận để qua bước.</div>';return}
  const c=state.claims[state.selected]||state.claims[0];
  const audit=state.searchAudit||[]; const cats=state.citationCategories||{};
  const cw=collectCouldWould();
  if($("nextWorkPanel"))$("nextWorkPanel").hidden=false;
  $("reportContent").innerHTML=`
<h3>0. Phương pháp và nguồn của case</h3><div class="method-card"><strong>Mục tiêu nghiệp vụ:</strong> hỗ trợ chuyên gia phân tích giải pháp và bản claims được cung cấp trước quyết định nộp đơn; khi dùng tài liệu công khai chỉ là thử nghiệm hồi cứu, không phải case khách hàng thật.<br><strong>Chế độ:</strong> ${esc(researchMode())} · <strong>Phiên bản claims:</strong> ${esc(versionType())} · <strong>Nguồn:</strong> ${esc($("inputSourceUrl").value||"Chưa ghi")}<br><strong>Giới hạn phiên bản:</strong> ${esc($("claimVersionNote").value||"Chưa ghi")}<br><strong>Dữ liệu kiểm chứng tách biệt:</strong> ${esc($("caseReference").value||"Chưa có")}; không đưa thông tin grant vào kết luận tự động.<br><strong>Đã kiểm tra claims:</strong> ${$("inputVersionConfirmed").checked?"Có":"Chưa"} · <strong>Đã kiểm tra ngày liên quan:</strong> ${$("relevantDateVerified").checked?"Có":"Chưa"}<br><strong>Target trùng số công bố đã loại:</strong> ${(state.targetExcluded||[]).length} (chỉ dựa số đã khai báo, không bảo đảm toàn bộ family).</div>
<h3>0. Kiểm toán 8 lớp xử lý (thực hiện trong 9 màn hình)</h3><table class="audit-table"><thead><tr><th>Lớp</th><th>Đã thực hiện / còn thiếu</th></tr></thead><tbody>${pipelineStageFacts().map(([stage,status])=>`<tr><td>${esc(stage)}</td><td>${esc(status)}</td></tr>`).join('')}</tbody></table><p><strong>Danh tính tệp đầu vào:</strong> ${esc((state.documentAudit||state.importedDocumentIdentity)?.name||'Không có PDF gốc trong phiên này')} · ${(state.documentAudit||state.importedDocumentIdentity)?.size||0} byte · SHA-256 ${esc((state.documentAudit||state.importedDocumentIdentity)?.sha256||'chưa tính / chưa lưu')}. ${state.importedDocumentIdentity&&!state.pdf?'Mã tệp nhập từ JSON nháp, CHƯA nạp lại PDF gốc. ':''}Mã hash không xác nhận OCR hoặc tính pháp lý của tài liệu.</p>
<h3>1. Thông tin sáng chế & mốc đánh giá</h3><div class="summary"><div>Mã case</div><div>${esc($("caseId").value)}</div><div>Số bằng/công bố</div><div>${esc($("patentNo").value)}</div><div>Tên sáng chế</div><div>${esc($("title").value)}</div><div>Ngày nộp đơn</div><div>${esc($("filingDate").value)}</div><div>Ngày liên quan</div><div>${esc(relevantDateValue())}</div><div>IPC/CPC</div><div>${esc($("ipc").value)}</div></div>
<h3>2. Toàn bộ claims đã được đưa vào phân tích</h3><p>Hệ thống ghi riêng mỗi claim và giới hạn kế thừa; quan hệ phụ thuộc nhiều nhánh cần chuyên gia xác nhận. Mốc ngày hiển thị là dữ liệu khai báo, không phải ngày ưu tiên có hiệu lực đã tự chứng minh.</p><table class="audit-table"><thead><tr><th>Claim</th><th>Phụ thuộc</th><th>Ngày khai báo</th><th>Nhận định tạm thời</th></tr></thead><tbody>${claimNoveltyRows().map(r=>{const x=state.claims.find(c=>c.id===r.claimId)||{};return `<tr><td>Claim ${r.claimId}<div class="status">${esc(x.text||'')}</div></td><td>${esc((x.dependsOn||[]).join(', ')||'—')}</td><td>${esc(r.date||'Chưa xác minh')}</td><td>${esc(r.status)}<div class="status">${esc(r.note)}</div></td></tr>`}).join('')}</tbody></table>
<h3>3. Dấu hiệu kỹ thuật</h3><ol>${state.features.map(f=>`<li><strong>${f.id}</strong> — ${esc(f.text)}</li>`).join("")||"<li>Chưa có</li>"}</ol>
<h3>3b. Phạm vi văn bản thực sự được máy xử lý</h3><p>PDF đầu vào: ${state.pdf?esc(`${state.inputScanAudit?.pages||0} trang; ${state.inputScanAudit?.ocrNeeded||0} trang thử OCR; trang chưa đọc: ${(state.inputScanAudit?.unread||[]).join(', ')||'không ghi nhận'}`):'Chỉ có văn bản nhập tay / PDF không được lưu trong JSON nháp'}. Thứ tự claim liên tục: ${state.claimCoverage?.completeSequence?'có, chưa chứng minh không bỏ sót claim':'CHƯA XÁC MINH'}.</p><ul>${['D1','D2','D3'].map(k=>`<li>${k}: ${state.matrixScanAudit?.[k]?`${state.matrixScanAudit[k].completedCells}/${state.matrixScanAudit[k].requestedCells} lượt feature × đoạn · ${state.matrixScanAudit[k].complete?'đã nhận đủ phản hồi AI cho VĂN BẢN ĐÃ NHẬP':'CHƯA CHẠY HẾT'} · ${state.matrixScanAudit[k].coveredChars||0}/${state.matrixScanAudit[k].totalChars||0} vị trí ký tự đã phân đoạn`:'chưa chạy AI toàn văn hoặc chỉ so thuật ngữ local'}</li>`).join('')}</ul><p>Việc máy chạy hết văn bản đã nhập KHÔNG chứng minh tài liệu gốc, phần hình vẽ, bản dịch hay tất cả kho dữ liệu toàn cầu đã được kiểm tra. Phương pháp dựa trên tài liệu đào tạo Phạm Văn Kiện (2020): tính mới xét từng claim với MỘT đối chứng riêng; trình độ sáng tạo có thể xét nhiều đối chứng cùng hiểu biết thông thường; truy vấn nên lặp/điều chỉnh và đối chiếu với mô tả/hình vẽ. Ba tài liệu 2020 không phải SOP IP GROUP hoặc căn cứ đầy đủ về pháp luật hiện hành.</p>
<h3>4. Search audit</h3><p>Đã ghi nhận <strong>${audit.length}</strong> lượt tra cứu (kể cả 0 kết quả và lỗi). Có <strong>${(state.searchFailures||[]).length}</strong> lượt nguồn/truy vấn lỗi; độ phủ có thể chưa đầy đủ. Chế độ bảo mật: <strong>${isConfidentialMode()?"ON":"OFF"}</strong>.</p>${audit.length?`<table class="audit-table"><thead><tr><th>Hướng</th><th>Query</th><th>Provider</th><th>Trạng thái</th><th>Kết quả</th></tr></thead><tbody>${audit.map(a=>`<tr><td>${esc(a.label||a.axis||"")}</td><td><code>${esc(a.query||"")}</code></td><td>${esc(a.provider||"")}</td><td>${esc(a.status||"UNKNOWN")}</td><td>${a.count||0}</td></tr>`).join("")}</tbody></table>`:"<p>Chưa có audit.</p>"}
<h3>5. Tài liệu đối chứng & category sơ bộ</h3><ul>${["D1","D2","D3"].map(s=>{const p=state.prior[s]||{},cat=cats[s]||{};return `<li><strong>${s}</strong> · ${esc(p.no||"chưa có")} · ngày công bố ${esc(p.date||"chưa xác minh")} · <strong>${esc(cat.cat||"?")}</strong> — ${esc(cat.note||"")}</li>`}).join("")}</ul>
<p><strong>Mốc thời gian cần chuyên gia kiểm tra:</strong> ${esc(["D1","D2","D3"].filter(s=>{const d=state.prior[s]||{};return (d.no||d.text)&&priorEligible(s)!==true}).join(", ")||"Không có ứng viên đang chờ theo kiểm tra ngày sơ bộ")}.</p><h3>6. Đánh giá sơ bộ tính mới</h3><p><strong>${esc(state.assessment.noveltyRisk||"Chưa đánh giá")}</strong></p><p>${state.assessment.noveltyText||""}</p>
<h3>7. Phân tích sơ bộ trình độ sáng tạo</h3><p>Phần phân tích chi tiết này là khung làm việc do chuyên gia chọn đối với một nhóm đặc điểm; KHÔNG tự áp dụng như kết luận cho tất cả claims. Các claim khác đang chờ chuyên gia đánh giá riêng.</p><p><strong>${esc(state.assessment.inventiveRisk||"Chưa đánh giá")}</strong></p><p>${state.assessment.inventiveText||""}</p><p><strong>Closest prior art candidate:</strong> ${esc($("closest").value)}</p><p><strong>Dấu hiệu khác biệt:</strong> ${esc($("differences").value)}</p><p><strong>Vấn đề kỹ thuật khách quan:</strong> ${esc($("problem").value)}</p><p><strong>Lập luận:</strong> ${esc($("reasoning").value)}</p>
<h3>8. Technical effects đã xác minh</h3><ul>${Object.entries(state.technicalEffects||{}).filter(([k,v])=>v.verified).map(([k,v])=>`<li><strong>${esc(k)}</strong>: ${esc(v.effect||"")} — evidence: ${esc(v.evidence||"")}</li>`).join("")||"<li>Chưa có tác dụng kỹ thuật được xác minh.</li>"}</ul><h3>9. Could–Would checklist</h3><ul>${Object.entries(cw).map(([k,v])=>`<li><strong>${esc(k)}</strong>: ${esc(v.status)}${v.note?` — ${esc(v.note)}`:""}</li>`).join("")}</ul>
<h3>10. Readiness & expert review</h3><p>Readiness: <strong>${state.assessmentChecks?.pct||0}%</strong>; gate bắt buộc chưa đạt: <strong>${state.assessmentChecks?.hardFail||0}</strong>. Số hạng mục đã được chuyên gia rà soát: <strong>${state.reviews}</strong>.</p>
<h3>10b. Kiểm chứng bằng chứng theo từng ô</h3><table class="audit-table"><thead><tr><th>Ô</th><th>Quyết định</th><th>Nhận xét</th><th>Hướng tiếp</th></tr></thead><tbody>${Object.entries(state.evidenceReviews||{}).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(v.decision)}</td><td>${esc(v.note)}</td><td>${esc(v.next)}</td></tr>`).join("")||'<tr><td colspan="4">Chưa có quyết định chuyên gia.</td></tr>'}</tbody></table>
<h3>10c. Giới hạn nguồn và truy vấn thất bại</h3><p>Feature chưa có truy vấn trong đợt này: ${esc((state.searchPlanSkipped||[]).join(", ")||"không xác định / không ghi nhận")}</p><p>Truy vấn thất bại: ${(state.searchFailures||[]).length}. ${esc((state.searchFailures||[]).map(x=>x.label+": "+x.error).join(" | "))}</p>
<h3>11. Audit trail</h3><ul>${(state.reviewLog||[]).slice(-30).map(x=>`<li>${esc(x.time||"")} · ${esc(x.action||"")} · ${esc(x.target||"")} ${x.status?`→ ${esc(x.status)}`:""}</li>`).join("")||"<li>Chưa có thao tác review được ghi nhận.</li>"}</ul><div class="method-card"><strong>Phạm vi:</strong> Đầu vào cốt lõi là giải pháp kỹ thuật + phiên bản claims đã khai báo, không phải trạng thái đã cấp bằng. Kết quả trên claims as-granted không được suy diễn thành kết quả trên claims ban đầu. Search hiện chủ yếu là patent literature và không chứng minh đã bao phủ toàn bộ prior art công khai. Nhãn X/Y/A là đề xuất nội bộ; ngày công bố, evidence và lập luận pháp lý phải được chuyên gia xác minh trên nguồn gốc.</div>`;
};
