/* PatentLens v56 — technical-fingerprint retrieval + corrected provider transport + hybrid evidence. */
'use strict';
const $=id=>document.getElementById(id);
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
const fold=s=>norm(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();
const esc=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const STAGES=[['intake','Nhập liệu','Tải PDF hoặc dán mô tả/yêu cầu bảo hộ.'],['route','Phân tích tài liệu','Trích từ khóa trực tiếp từ hồ sơ và phân loại online vào 1 trong 3 trụ cột.'],['search','Tra cứu trực tuyến','Tạo truy vấn từ chính từ khóa của hồ sơ và tìm tài liệu liên quan trên các nguồn online.'],['compare','Đối chiếu bằng chứng','Đối chiếu từng claim-feature hoặc từng keyword với D1–D3.'],['report','Nhận định và báo cáo','Tổng hợp bằng chứng và nhận định sơ bộ để chuyên viên rà soát.']];
const S={stage:0,mode:'prospective',source:'',filename:'',fileMeta:null,pdf:null,pages:[],unread:[],pdfBusy:false,pdfAbort:false,uploadId:0,ocrToken:0,noText:[],claims:[],keywordOnly:true,route:null,routeAudit:null,concepts:[],claimDates:{},queries:[],queryLog:[],candidates:[],prior:{D1:null,D2:null,D3:null},features:[],matrix:{},ai:{},aiCoverage:{},semantic:{},semanticCoverage:{},semanticBusy:false,semanticEngine:'',searching:false,searchAbort:null,aiBusy:false,aiStop:false,expertNote:'',signed:false,reportHtml:'',revision:0,expectedClaims:0,autoReadBusy:false,claimFeatureIds:{},pillarOverride:'',pillar:null,keywordPairs:[],documentLanguage:{primary:'unknown',confidence:0},routingBusy:false,routingError:'',routeRequestId:0,routeAbort:null,routeEnriched:false};
function notify(message,error=false){const el=$('alert');el.textContent=message;el.className='alert '+(error?'error':'success');el.hidden=false;}
function clearNotice(){$('alert').hidden=true;}
function safeUrl(url){try{const u=new URL(url);return u.protocol==='https:'?u.href:'';}catch{return '';}}
function titleText(){return norm(S.source.split(/[\n.!?]/)[0]).slice(0,200);}
async function loadHealth(){
 const el=$('serviceHealth');if(!el)return;
 try{const r=await fetch('/api/health',{cache:'no-store',signal:AbortSignal.timeout(10000)});const d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||('HTTP '+r.status));const p=d.providers||{};const chips=[['Tự phân loại',p.auto_classifier||p.gemini||p.workers_ai],['VI/EN',p.translation||p.workers_ai||p.gemini],['Patent API ổn định',p.epo||p.serpapi],['Google no-key fallback',p.google_patents_no_key],['EPO OPS',p.epo]];el.innerHTML=chips.map(([n,on])=>`<span class="health-chip ${on?'on':'off'}">${on?'●':'○'} ${esc(n)}</span>`).join('');}
 catch(e){el.textContent='Không đọc được trạng thái backend: '+String(e.message||e).slice(0,80);}
}
function stepShow(n){S.stage=Math.max(0,Math.min(STAGES.length-1,n));clearNotice();document.querySelectorAll('.stage').forEach((p,i)=>p.classList.toggle('active',i===S.stage));document.querySelectorAll('#flowStrip [data-flow-step]').forEach((bar,i)=>{bar.classList.toggle('done',i<S.stage);bar.classList.toggle('active',i===S.stage);});const st=STAGES[S.stage];$('stepCount').textContent=`BƯỚC ${String(S.stage+1).padStart(2,'0')} / 05`;$('stepTitle').textContent=st[1];$('stepIntro').textContent=st[2];$('wizardInfo').textContent=`Bước ${S.stage+1}/5`;$('back').disabled=S.stage===0;$('next').textContent=S.stage===4?'Tạo bản xem trước':'Tiếp tục →';$('steps').innerHTML=STAGES.map((s,i)=>`<button type="button" class="stepbtn ${i===S.stage?'active':''}" data-step="${i}" ${i>S.stage?'disabled title="Đi theo luồng từ bước trước"':''}><i>${i+1}</i><span>${esc(s[1])}</span></button>`).join('');$('steps').querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{if(+b.dataset.step<=S.stage)stepShow(+b.dataset.step);});if(S.stage===1)renderRoute();if(S.stage===2)renderSearchStage();if(S.stage===3){if(!S.autoComputed)autoCompare(true);renderMatrix();}if(S.stage===4)renderReport();window.scrollTo({top:0,behavior:'instant'});}
function invalidate(from){S.autoComputed=false;S.revision++;if(from<=1){S.route=null;S.concepts=[];S.queries=[];}if(from<=2){S.queryLog=[];S.candidates=[];S.prior={D1:null,D2:null,D3:null};}if(from<=3){S.features=[];S.claimFeatureIds={};S.matrix={};S.ai={};S.aiCoverage={};S.semantic={};S.semanticCoverage={};S.semanticEngine='';S.claimDates={};if($('claimInputVerified'))$('claimInputVerified').checked=false;}S.reportHtml='';}
function setInput(text,filename=''){
 const api=window.PATENTLENS_KEYWORDS;
 const t=api?.cleanText?api.cleanText(text):String(text||'').normalize('NFC');
 if(!t.trim())return notify('Chưa có nội dung để phân tích.',true);
 invalidate(1);try{S.routeAbort?.abort();}catch(_e){}S.pillarOverride='';S.pillar=null;S.keywordPairs=[];S.routingError='';S.routeEnriched=false;S.routeRequestId++;
 S.documentLanguage=api?.detectLanguage?api.detectLanguage(t):{primary:'unknown',confidence:0};
 S.source=t;S.filename=filename;S.claims=parseStructuredClaims(t);S.keywordOnly=!S.claims.length;S.expectedClaims=expectedClaimCount(t);
 const incomplete=(S.pdf?.numPages||0)>0&&(S.unread.length>0||(S.expectedClaims>0&&S.claims.length<S.expectedClaims));
 const mode=S.keywordOnly?(incomplete?'CHƯA XÁC ĐỊNH ĐỦ CLAIMS: PDF còn trang chưa đọc hoặc thiếu claim; cần OCR tiếp. Tạm thời chỉ khảo sát nội dung.':'không phát hiện claims có cấu trúc'):'đã nhận diện '+S.claims.length+' claims'+(incomplete?' · CHƯA XÁC NHẬN ĐỦ CLAIMS':'');
 const langLabel={vi:'Tiếng Việt',en:'Tiếng Anh',mixed:'Việt–Anh hỗn hợp',unknown:'Chưa xác định'}[S.documentLanguage.primary]||'Chưa xác định';
 $('ingestState').textContent=`Đã nạp ${t.length.toLocaleString('vi-VN')} ký tự · ${langLabel} · ${mode}.`;
 $('claimsPreview').innerHTML=S.claims.length?S.claims.map(c=>`<article><strong>Claim ${c.id}${c.dependsOn.length?' · phụ thuộc '+c.dependsOn.join(', '):''}${c.dependencyIssue?' · phụ thuộc nhiều nhánh/chưa rõ; chờ chuyên gia':''}${c.needsReview?' · nghi OCR dính claim, cần đối chiếu PDF gốc':''}</strong><p>${esc(c.text)}</p></article>`).join(''):'<p>Chưa nhận diện được bộ claims có cấu trúc. Hệ thống vẫn có thể trích keyword và tra cứu từ phần nội dung đã đọc; không tự tạo claim.</p>';
 try{routeAllText();ensureImmediatePillar();queueMicrotask(()=>classifyRouteOnline(false));}catch(_e){}
}
function expectedClaimCount(text){
  const cover=fold(String(text||'').slice(0,22000));
  const patterns=[/so\s*(?:diem\s*)?yeu\s*cau\s*bao\s*ho\s*[:\-]?\s*(\d{1,3})/i,/number\s+of\s+claims\s*[:\-]?\s*(\d{1,3})/i];
  for(const rx of patterns){const m=cover.match(rx);if(m){const n=Number(m[1]);if(n>0&&n<=500)return n;}}
  return 0;
}
function parseStructuredClaims(full){
  const lines=String(full||'').replace(/\r/g,'').split('\n');
  const heading=/^\s*(?:(?:phan\s+)?yeu\s+cau\s+bao\s+ho|claims?\b|what\s+is\s+claimed)\s*[:：.\-]?\s*$/i;
  let start=lines.findIndex(l=>heading.test(fold(l)));
  const marker=/^\s*(\d{1,3})\s*[.)](?!\d)\s+(?=\S)/u;
  const form=/^(?:m[ộo]t\s+|a\s+|an\s+|the\s+|ph[ưươ]ơng\s+ph[aá]p\b|quy\s+tr[ìi]nh\b|thi[eế]t\s+b[ịi]\b|h[ệe]\s+th[ốo]ng\b)/iu;
  // A numbered description alone is not a claim. Require a claim heading or
  // a genuine consecutive set of claim-like numbered lines.
  if(start<0){const cand=lines.map((l,i)=>({i,m:l.match(marker)})).filter(x=>x.m&&form.test(lines[x.i].slice(x.m[0].length)));if(cand.length<2||cand[0].m[1]!=='1'||Number(cand[1].m[1])!==2)return [];start=cand[0].i-1;}
  const out=[];let current=null;
  const endHeading=/^\s*(?:description|detailed\s+description|abstract|summary|m[ôo]\s+t[aả]\s+chi\s+ti[eế]t|h[ìi]nh\s+v[ẽe]|drawings?|technical\s+field|l[ĩi]nh\s+v[ựu]c\s+k[ỹy]\s+thu[ậa]t)\s*[:：]?\s*$/iu;
  const finish=()=>{if(current){const body=norm(current.buffer.join(' ')).replace(new RegExp('^'+current.id+'\\s*[.)]\\s*'),'');if(body.length>=15)out.push({id:current.id,text:body,needsReview:!!current.needsReview});current=null;}};
  // OCR sometimes joins "8. ... 9. Hệ thống theo điểm 8..." on one line.
  // Only split a candidate when its number is exactly the *next* claim,
  // the following phrase is claim-like, and we're inside a claims section.
  const inline=/\s+(\d{1,3})\s*[.)](?!\d)\s+(?=(?:h[ệe]\s+th[ốo]ng|thi[eế]t\s+b[ịi]|ph[ưươ]ơng\s+ph[aá]p|quy\s+tr[ìi]nh|m[ộo]t\s+|a\s+|an\s+|the\s+|system\b|device\b|apparatus\b|method\b))/giu;
  for(let i=start+1;i<lines.length;i++){
    const line=lines[i].trim();if(!line||/^\[TRANG \d+\]$/i.test(line))continue;
    if(endHeading.test(line)&&out.length){finish();break;}
    const m=line.match(marker),next=current?current.id+1:out.length+1;
    if(m&&Number(m[1])===next){finish();current={id:Number(m[1]),buffer:[line.slice(m[0].length)]};}
    else if(current)current.buffer.push(line);
    else continue;
    if(!current)continue;
    let joined=current.buffer.join(' '),guard=0;
    while(guard++<100){
      inline.lastIndex=0;let found=null,hit;
      while((hit=inline.exec(joined))){
        if(Number(hit[1])!==current.id+1)continue;
        // Require a meaningful preceding claim portion. A decimal / step
        // mention inside a claim is not itself evidence of a new claim.
        if(joined.slice(0,hit.index).trim().length<20)continue;
        found=hit;break;
      }
      if(!found)break;
      const old=joined.slice(0,found.index).trim(),remainder=joined.slice(found.index+found[0].length);
      current.buffer=[old];current.needsReview=true;finish();
      current={id:Number(found[1]),buffer:[remainder],needsReview:true};joined=remainder;
    }
  }
  finish();
  if(!out.length||out[0].id!==1)return [];
  for(let i=0;i<out.length;i++)if(out[i].id!==i+1)out[i].needsReview=true;
  return out.map(c=>{const multi=/(?:claims?|yêu\s+cầu\s+bảo\s+hộ|điểm)\s*\d{1,3}\s*(?:[-–]|to|đến|or|hoặc|and|và)\s*\d{1,3}/iu.test(c.text);const m=c.text.match(/(?:the\s+\w+\s+of\s+claim|the\s+\w+\s+according\s+to\s+claim|(?:theo|của)\s+(?:yêu\s+cầu\s+bảo\s+hộ|điểm|claim))\s*(\d{1,3})/iu);const parent=m?Number(m[1]):0;return {...c,dependsOn:!multi&&parent>0&&parent<c.id?[parent]:[],dependencyIssue:multi||parent>=c.id};});
}
function inputDataRequired(){if(S.pdfBusy){notify('PDF đang đọc/OCR trang hiện tại. Vui lòng chờ hoặc bấm Dừng; phần chưa đọc sẽ được ghi rõ.',true);return false;}if(!S.source.trim()){notify('Hãy tải PDF hoặc dán nội dung và bấm “Sử dụng văn bản”.',true);return false;}return true;}
function routeAllText(){
 const api=window.PATENTLENS_KEYWORDS;if(!api)throw Error('Chưa tải được keyword_extractor.js.');
 const text=S.source;
 // v54: keyword tra cứu chỉ lấy từ Ý CHÍNH của hồ sơ: Title/Abstract + claim độc lập.
 // Claim phụ thuộc chỉ đóng vai trò bổ sung nhẹ. Bước search sẽ dùng TOÀN BỘ key được trả về ở đây.
 const independent=S.claims.filter(c=>!c.dependsOn?.length);
 const coreClaims=(independent.length?independent:S.claims.slice(0,1)).slice(0,3).map(c=>c.text).join('\n');
 const supportClaims=S.claims.filter(c=>c.dependsOn?.length).slice(0,8).map(c=>c.text).join('\n');
 const r=api.extract(text,{coreBoost:coreClaims,supportBoost:supportClaims,max:12});
 S.documentLanguage=r.language||api.detectLanguage?.(text)||{primary:'unknown',confidence:0};
 // Audit where each keyword actually came from. OCR-risk keywords stay visible but are clearly marked.
 for(const k of (r.keywords||[])){
   const needle=fold(k.term),hits=(S.pages||[]).filter(p=>p?.text&&fold(p.text).includes(needle));
   k.pages=hits.map(p=>p.page);
   k.ocrRisk=!!hits.length&&hits.every(p=>p.status==='ocr'&&Number(p.ocrConfidence||0)<65);
   k.ocrConfidence=hits.length?Math.round(Math.min(...hits.filter(p=>p.status==='ocr').map(p=>Number(p.ocrConfidence||100)))):null;
 }
 S.route={scannedChars:text.length,totalChars:text.length,complete:true,keywords:r.keywords,language:S.documentLanguage,stats:r.stats};
 S.routeAudit={scannedChars:text.length,totalChars:text.length};
 S.keywordPairs=[];
 S.concepts=r.keywords.map(k=>({id:'document::'+k.id,topic:S.pillar?.name||'Từ khóa tài liệu',name:k.term,source:[k.term],alternatives:[],count:k.count,weight:k.score}));
 return S.route;
}
function rebuildConceptsFromOnlineKeywords(rows){
 if(!Array.isArray(rows)||!rows.length)return;
 S.keywordPairs=rows.map((x,i)=>({source:norm(x.source_term||''),normalized:norm(x.normalized_term||x.source_term||''),vi:norm(x.vi||''),en:norm(x.en||''),importance:Number(x.importance)||0.5})).filter(x=>x.source);
 const weightBy=new Map((S.route?.keywords||[]).map(k=>[fold(k.term),k]));
 S.concepts=S.keywordPairs.map((x,i)=>{const raw=weightBy.get(fold(x.source)),alts=[];const add=v=>{v=norm(v);if(v&&fold(v)!==fold(x.source)&&!alts.some(a=>fold(a)===fold(v)))alts.push(v);};
   if(x.normalized){const a=new Set(fold(x.source).split(/\s+/)),b=new Set(fold(x.normalized).split(/\s+/));const inter=[...a].filter(t=>b.has(t)).length;if(inter/Math.max(1,Math.min(a.size,b.size))>=.45)add(x.normalized);}
   if(x.en&&!/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(x.en))add(x.en);
   if(x.vi&&(/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(x.vi)||window.PATENTLENS_KEYWORDS?.detectPhraseLanguage?.(x.vi,'vi')?.viScore>2))add(x.vi);
   return {id:'document::online-'+(i+1),topic:S.pillar?.name||'Từ khóa tài liệu',name:x.source,source:[x.source],alternatives:alts,count:raw?.count||1,weight:(raw?.score||1)*(0.7+x.importance)};});
}
function localPillarGuess(){
 const api=window.PATENTLENS_KEYWORDS,pillars=api?.PILLARS||{};
 if(S.pillarOverride&&pillars[S.pillarOverride])return {id:S.pillarOverride,name:pillars[S.pillarOverride].name,source:'manual',confidence:1,reason:'Người dùng đã chọn trụ cột.'};
 const text=fold((S.claims?.length?S.claims.map(c=>c.text).join(' '):S.source.slice(0,12000))+' '+(S.route?.keywords||[]).slice(0,12).map(k=>k.term).join(' '));
 const score={process_product:0,information_technology:0,system_device:0};
 const count=(rx)=>{const m=text.match(rx);return m?m.length:0;};
 // Chỉ dùng tín hiệu cấu trúc rất rộng để chọn nhanh trụ cột, không dùng kho keyword tra cứu chuyên ngành.
 score.process_product+=count(/\b(?:process|method|step|stage|prepare|prepar|mix|treat|heat|dry|extract|manufactur|produc|quy trinh|phuong phap|buoc|cong doan|chuan bi|phoi tron|xu ly|gia nhiet|say|chiet|san xuat)\w*\b/g);
 score.information_technology+=count(/\b(?:data|algorithm|software|database|server|network|computer|processor|memory|machine learning|neural|digital|signal processing|du lieu|thuat toan|phan mem|co so du lieu|may chu|mang|hoc may|bo xu ly|bo nho|xu ly tin hieu)\b/g);
 score.system_device+=count(/\b(?:system|device|apparatus|assembly|sensor|circuit|housing|shaft|valve|pump|component|he thong|thiet bi|co cau|cam bien|mach|vo|truc|van|bom|bo phan)\b/g);
 const raw=String(S.claims?.[0]?.text||S.source.slice(0,800));
 if(/^\s*(?:a\s+)?(?:method|process)|^\s*(?:phương pháp|quy trình)/iu.test(raw))score.process_product+=4;
 if(/^\s*(?:a\s+)?(?:system|device|apparatus)|^\s*(?:hệ thống|thiết bị)/iu.test(raw))score.system_device+=4;
 const ordered=Object.entries(score).sort((a,b)=>b[1]-a[1]);
 const [top,second]=ordered;let id=top[0];
 if(top[1]===0){
   const k=(S.route?.keywords||[]).slice(0,10).map(x=>fold(x.term)).join(' ');
   id=/\b(?:data|algorithm|software|computer|du lieu|thuat toan|phan mem)\b/.test(k)?'information_technology':/\b(?:process|method|quy trinh|phuong phap)\b/.test(k)?'process_product':'system_device';
 }
 const confidence=top[1]===0?0.42:Math.min(.88,.56+(top[1]-second[1])/Math.max(5,top[1]+second[1]));
 return {id,name:pillars[id]?.name||id,source:'local-fast',confidence,reason:`Chọn nhanh từ cấu trúc nội dung đã đọc; điểm quy trình ${score.process_product}, CNTT ${score.information_technology}, hệ thống/thiết bị ${score.system_device}.`};
}
function ensureImmediatePillar(){
 if(!S.route?.keywords)routeAllText();
 if(S.pillarOverride){S.pillar=localPillarGuess();return S.pillar;}
 if(!S.pillar||S.pillar.source==='local-fast'){S.pillar=localPillarGuess();for(const c of S.concepts)c.topic=S.pillar.name;}
 return S.pillar;
}
async function classifyRouteOnline(force=false){
 if(!S.route?.keywords)routeAllText();
 const api=window.PATENTLENS_KEYWORDS,pillars=api?.PILLARS||{};
 ensureImmediatePillar();
 if(S.routingBusy&&!force)return;
 // Hủy lượt nền cũ; thao tác thủ công của người dùng luôn thắng.
 try{S.routeAbort?.abort();}catch(_e){}
 const controller=new AbortController();S.routeAbort=controller;
 const req=++S.routeRequestId;S.routingBusy=true;S.routingError='';renderRoute();
 try{
  const body={keywords:S.route.keywords.map(k=>({term:k.term,count:k.count,score:k.score})),excerpt:S.source.slice(0,2600),source_language:S.documentLanguage?.primary||'unknown',forced_pillar:S.pillarOverride||''};
  const r=await fetch('/api/route-plan',{method:'POST',headers:{'content-type':'application/json',...($('apiCode')?.value.trim()?{'x-public-api-access-code':$('apiCode').value.trim()}: {})},body:JSON.stringify(body),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(12000)])});
  const d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||('HTTP '+r.status));if(req!==S.routeRequestId)return;
  const id=S.pillarOverride||d.pillar_id;
  if(pillars[id]&&!S.pillarOverride){S.pillar={id,name:pillars[id].name,source:/cloudflare|workers/i.test(String(d.provider||''))?'workers-ai':/gemini/i.test(String(d.provider||''))?'gemini':/local/i.test(String(d.provider||''))?'local':'online',provider:norm(d.provider||''),confidence:Number(d.confidence)||S.pillar?.confidence||0,reason:norm(d.reason||'')};}
  else if(S.pillarOverride&&pillars[S.pillarOverride])S.pillar={id:S.pillarOverride,name:pillars[S.pillarOverride].name,source:'manual',confidence:1,reason:'Người dùng đã chọn trụ cột.',provider:norm(d.provider||'')};
  if(d.source_language)S.documentLanguage={...S.documentLanguage,primary:d.source_language};
  rebuildConceptsFromOnlineKeywords(d.keywords||[]);for(const c of S.concepts)c.topic=S.pillar.name;
  // v50: KHÔNG dùng truy vấn do model tự tổng hợp. Search plan được dựng trực tiếp từ keyword đã trích từ hồ sơ; VI/EN chỉ là bản dịch song song của chính keyword đó.
  S.queries=buildRetrievalSearchPlan();
  S.routeEnriched=true;
 }catch(e){if(req===S.routeRequestId&&!controller.signal.aborted){S.routingError=String(e.message||e);}}
 finally{if(req===S.routeRequestId){S.routingBusy=false;renderRoute();}}
}
function languageLabel(code){return {vi:'Tiếng Việt',en:'Tiếng Anh',mixed:'Việt–Anh',unknown:'Chưa xác định'}[code]||'Chưa xác định';}
function renderRoute(){
 if(!S.route?.keywords)routeAllText();
 ensureImmediatePillar();
 const api=window.PATENTLENS_KEYWORDS,pillars=api.PILLARS,p=S.pillar;
 $('modeBadge').textContent=`Ngôn ngữ: ${languageLabel(S.documentLanguage?.primary)} · ${S.keywordOnly?'Khảo sát nội dung':'Đã nhận diện '+S.claims.length+' claims'}`;
 $('originalPreview').value=S.source.length>20000?S.source.slice(0,20000):S.source;
 $('routeScope').textContent=`Đã quét ${S.route.totalChars.toLocaleString('vi-VN')} ký tự. Trụ cột được chọn sơ bộ ngay trên trình duyệt; chuẩn hóa keyword VI/EN chạy nền khi dịch vụ online sẵn sàng.`;
 const pillarCards=Object.entries(pillars).map(([id,v])=>`<button type="button" class="pillar-card ${p?.id===id?'active':''}" data-pillar="${id}"><span class="pillar-icon">${id==='process_product'?'↻':id==='information_technology'?'⌘':'◇'}</span><span><strong>${esc(v.name)}</strong><small>${p?.id===id?(p.source==='manual'?'Bạn đã chọn trụ cột này':p.source==='local-fast'?'Hệ thống chọn sơ bộ — có thể đổi ngay':'Hệ thống đã kiểm tra lại online'):'Chọn lại nếu phân loại chưa phù hợp'}</small></span></button>`).join('');
 let status='';
 if(p?.source==='manual')status=`<div class="route-state-ok"><span class="state-dot"></span><div><strong>${esc(p.name)}</strong><small>Đã khóa theo lựa chọn của người dùng. Bạn có thể bấm Tiếp tục ngay.${S.routingBusy?' Hệ thống vẫn đang tối ưu keyword VI/EN ở nền.':''}</small></div></div>`;
 else if(p)status=`<div class="route-state-ok"><span class="state-dot"></span><div><strong>${esc(p.name)}</strong><small>${p.source==='local-fast'?'Đã tự chọn sơ bộ ngay từ cấu trúc nội dung hồ sơ.':'Đã kiểm tra lại bằng dịch vụ '+esc(p.provider||'online')+'.'}${p.confidence?` Độ tin cậy tham khảo ${Math.round(p.confidence*100)}%.`:''}</small>${p.reason?`<small class="route-reason"><b>Vì sao?</b> ${esc(p.reason)}</small>`:''}</div></div>${S.routingBusy?'<div class="route-background"><span class="live-dot"></span> Đang tối ưu keyword VI/EN ở nền — không chặn bước tiếp theo.</div>':''}`;
 else status='<div class="route-state-warn"><strong>Chưa xác định được trụ cột</strong><small>Hãy chọn một trong ba trụ cột bên dưới.</small></div>';
 if(S.routingError)status+=`<div class="route-background warning">Online chưa hoàn tất: ${esc(S.routingError)}. Trụ cột hiện tại vẫn dùng được; có thể tiếp tục hoặc thử lại sau.</div>`;
 const pairs=S.keywordPairs.length?S.keywordPairs:null;
 const rawKw=new Map((S.route.keywords||[]).map(k=>[fold(k.term),k]));
 const keywordHtml=pairs?pairs.map(x=>{const k=rawKw.get(fold(x.source))||{};const src={title:'Title',abstract:'Abstract',core_claims:'Claim độc lập',support_claims:'Claim phụ thuộc',claims:'Claims',body:'Description'}[k.source]||'Hồ sơ';const normNote=x.normalized&&fold(x.normalized)!==fold(x.source)?` · chuẩn hóa tham khảo: ${esc(x.normalized)}`:'';const risk=k.ocrRisk?` · ⚠ OCR thấp${k.ocrConfidence?` (${k.ocrConfidence}%)`:''}`:'';return `<div class="keyword-pair ${k.ocrRisk?'keyword-risk':''}"><div><strong>${esc(x.source)}</strong><small>Nguồn: ${esc(src)}${k.why?' · '+esc(k.why):''}${k.pages?.length?' · trang '+k.pages.join(', '):''} · xuất hiện ${k.count||1}× · điểm trích ${Number(k.score||0).toFixed(1)}${risk}${normNote}</small></div><div><span class="lang-pill vi">VI</span>${esc(x.vi||'—')}</div><div><span class="lang-pill en">EN</span>${esc(x.en||'—')}</div></div>`;}).join(''):(S.route.keywords||[]).map(k=>{const src={title:'Title',abstract:'Abstract',core_claims:'Claim độc lập',support_claims:'Claim phụ thuộc',claims:'Claims',body:'Description'}[k.source]||'Hồ sơ';return `<div class="keyword-chip keyword-explain ${k.ocrRisk?'keyword-risk':''}" style="--strength:${Math.max(18,Math.min(100,Math.round((k.score||1)*12)))}%"><span>${esc(k.term)}</span><b>${k.count}×</b><small>${esc(src)}${k.why?' · '+esc(k.why):''}${k.pages?.length?' · trang '+k.pages.join(', '):''} · score ${Number(k.score||0).toFixed(1)}${k.ocrRisk?' · ⚠ OCR thấp':''}</small></div>`;}).join('');
 $('routeResult').innerHTML=`<div class="route-grid"><section class="insight-card route-primary"><div class="card-kicker">TRỤ CỘT ĐỀ XUẤT</div><div class="route-status">${status}</div><div class="pillar-grid">${pillarCards}</div><div class="inline"><button type="button" class="btn ghost" id="routeRefresh">Kiểm tra lại online</button>${S.routingBusy?'<span class="muted small">Bạn vẫn có thể bấm Tiếp tục.</span>':''}</div></section><section class="insight-card keyword-panel"><div class="card-kicker">CORE SEARCH KEYS · VI / EN</div><h3>${pairs?'Từ khóa lõi đã chuẩn hóa để tra cứu':'Từ khóa lõi từ ý chính của tài liệu'}</h3><div class="${pairs?'keyword-pair-list':'keyword-cloud'}">${keywordHtml||'<div class="empty-state">Chưa trích được từ khóa lõi đủ rõ từ Title/Abstract/claim độc lập. Hãy kiểm tra OCR hoặc nội dung đầu vào.</div>'}</div><p class="muted small">Đây là các từ khóa lõi dùng để tra cứu, ưu tiên Tên sáng chế, Tóm tắt và yêu cầu bảo hộ độc lập. Các câu mô tả quan hệ như “gắn vào…”, “xác định…”, “theo điểm 1…” và từ quá chung sẽ không được dùng làm search key. Toàn bộ key hiển thị ở đây sẽ được chuyển nguyên sang bước tra cứu.</p></section></div>`;
 document.querySelectorAll('[data-pillar]').forEach(b=>b.onclick=()=>{
   try{S.routeAbort?.abort();}catch(_e){}
   S.routeRequestId++;S.routingBusy=false;S.routingError='';
   S.pillarOverride=b.dataset.pillar;S.pillar={id:b.dataset.pillar,name:pillars[b.dataset.pillar].name,source:'manual',confidence:1,reason:'Người dùng đã chọn trụ cột.'};
   for(const c of S.concepts)c.topic=S.pillar.name;S.queries=[];renderRoute();
   // Tối ưu keyword VI/EN ở nền với trụ cột đã khóa; không chặn nút Tiếp tục.
   queueMicrotask(()=>classifyRouteOnline(true));
 });
 const refresh=$('routeRefresh');if(refresh)refresh.onclick=()=>{S.pillarOverride='';S.pillar=localPillarGuess();S.keywordPairs=[];S.queries=[];S.routingError='';S.routeEnriched=false;renderRoute();queueMicrotask(()=>classifyRouteOnline(true));};
 if(!S.routeEnriched&&!S.routingBusy&&!S.routingError)queueMicrotask(()=>classifyRouteOnline(false));
}
function keywordTokenSet(term){return new Set(fold(term).replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(x=>x.length>=3&&!RANK_STOP.has(x)));}
function keyOverlap(a,b){const A=keywordTokenSet(a),B=keywordTokenSet(b);if(!A.size||!B.size)return 0;const inter=[...A].filter(x=>B.has(x)).length;return inter/Math.max(1,Math.min(A.size,B.size));}
function searchRole(row){if(row?.searchRole)return row.searchRole;const n=norm(row?.term||'').split(/\s+/).filter(Boolean).length;if(row?.source==='title')return 'anchor';if(['core_claims','abstract'].includes(row?.source)&&n>=3)return 'feature';return 'support';}
function phraseForLanguage(row,language){
 const source=norm(row?.term||''),pair=(S.keywordPairs||[]).find(x=>fold(x.source)===fold(source));
 const srcLang=row?.language==='vi'||row?.language==='en'?row.language:(window.PATENTLENS_KEYWORDS?.detectPhraseLanguage?.(source,S.documentLanguage?.primary||'unknown')?.primary||S.documentLanguage?.primary);
 if(language==='en'){
   if(srcLang==='en')return source;
   const en=norm(pair?.en||'');if(en&&!/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(en))return en;
   return '';
 }
 if(language==='vi'){
   if(srcLang==='vi')return source;
   const vi=norm(pair?.vi||'');return vi||'';
 }
 return source;
}
function quoteBundlePhrase(v){v=norm(v).replace(/["<>`]/g,'');if(!v)return '';return v.split(/\s+/).length>=2?'"'+v+'"':v;}
function buildRetrievalSearchPlan(){
 const all=selectSearchKeywords();if(!all.length)return [];
 const sorted=[...all].sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0));
 let anchor=sorted.find(k=>searchRole(k)==='anchor'&&!k.ocrRisk)||sorted.find(k=>searchRole(k)==='anchor')||sorted[0];
 const featurePool=sorted.filter(k=>k!==anchor&&searchRole(k)==='feature'&&!k.ocrRisk);
 // If extraction produced few explicit features, allow longer support phrases, never short generic signals.
 for(const k of sorted){const n=norm(k.term).split(/\s+/).length;if(k!==anchor&&!featurePool.includes(k)&&n>=3&&!k.ocrRisk&&searchRole(k)==='support')featurePool.push(k);}
 const features=[];
 for(const k of featurePool){if(keyOverlap(anchor.term,k.term)>=.82)continue;if(features.some(x=>keyOverlap(x.term,k.term)>=.82))continue;features.push(k);if(features.length>=4)break;}
 const out=[],seen=new Set();
 const add=(parts,language,level,reason)=>{
   const clean=parts.map(norm).filter(Boolean);if(!clean.length)return;
   const q=clean.map(quoteBundlePhrase).join(' ').replace(/\s+/g,' ').trim();if(q.length<4||q.length>170)return;
   const key=language+'|'+fold(q);if(seen.has(key))return;seen.add(key);
   out.push({q,language,level,label:'Technical fingerprint',concept:'fingerprint_bundle',sourceTerm:clean.join(' + '),translated:language!==S.documentLanguage?.primary,rank:out.length,reason});
 };
 // English first because worldwide patent corpora are indexed most consistently in English; the EN text must be a faithful translation of the source keys.
 for(const lang of ['en','vi']){
   const a=phraseForLanguage(anchor,lang);if(!a)continue;
   const fs=features.map(k=>phraseForLanguage(k,lang)).filter(Boolean);
   if(fs.length>=2)add([a,fs[0],fs[1]],lang,'precise','Đối tượng chính + hai đặc điểm kỹ thuật khác biệt');
   if(fs.length>=1)add([a,fs[0]],lang,'balanced','Đối tượng chính + đặc điểm kỹ thuật mạnh nhất');
   if(fs.length>=2)add([a,fs[1]],lang,'balanced','Đối tượng chính + đặc điểm kỹ thuật độc lập thứ hai');
   if(!fs.length)add([a],lang,'fallback','Chỉ dùng đối tượng chính vì chưa có feature đủ cụ thể');
 }
 // Last-resort query: a distinctive feature alone, never a short generic support keyword.
 if(out.length<2&&features.length){for(const lang of ['en','vi']){const f=phraseForLanguage(features[0],lang);if(f)add([f],lang,'fallback','Feature kỹ thuật mạnh nhất');}}
 return out.slice(0,6);
}
function directKeywordSearchTerms(){return buildRetrievalSearchPlan();}
function fallbackSearchTerms(){return buildRetrievalSearchPlan();}
function formatSearchLine(x){return `[${x.language==='vi'?'VI':x.language==='en'?'EN':'AUTO'}] ${x.q}`;}
function parseSearchLines(){
 const api=window.PATENTLENS_KEYWORDS;return $('searchQueries').value.split('\n').map(norm).filter(Boolean).map(line=>{const m=line.match(/^\[(VI|EN|AUTO)\]\s*(.+)$/i),q=norm(m?m[2]:line);let language=m?m[1].toLowerCase():'auto';if(language==='auto'){const d=api?.detectPhraseLanguage?.(q,S.documentLanguage?.primary)||api?.detectLanguage?.(q);if(d?.primary==='vi'||d?.primary==='en')language=d.primary;}return {q,language,level:'bundle'};}).filter(x=>x.q.length>=3);
}
function renderSearchStage(){
 if(!S.queries.length)S.queries=buildRetrievalSearchPlan();
 if(!$('searchQueries').value.trim())$('searchQueries').value=S.queries.map(formatSearchLine).join('\n');
 if($('searchPillarHint'))$('searchPillarHint').textContent=(S.pillar?.name||'Chưa phân loại')+' · tìm VI + EN';
 renderSourceLinks();renderCandidates();renderPrior();renderSearchLog();
}
function renderSourceLinks(){let queries=$('searchQueries').value.split('\n').map(norm).filter(Boolean).map(x=>x.replace(/^\[(?:VI|EN|AUTO)\]\s*/i,''));const q=(queries[0]||S.queries[0]?.q||'patent').slice(0,160);const list=[['Google Patents','https://patents.google.com/?q='+encodeURIComponent(q)],['WIPO · thủ công','https://patentscope.wipo.int/search/en/advancedSearch.jsf?query='+encodeURIComponent('EN_ALLTXT:('+q+')')],['Espacenet · thủ công','https://worldwide.espacenet.com/patent/search?q='+encodeURIComponent(q)],['Cục SHTT VN · thủ công','https://ipvietnam.gov.vn/']];$('sourceLinks').innerHTML=list.map(([n,u])=>`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(n)} ↗</a>`).join('');}
function renderSearchLog(){const lines=S.queryLog.map(r=>`[${r.status}]${r.language?' ['+String(r.language).toUpperCase()+']':''} ${r.provider||'Không rõ nguồn'} · ${r.query} · ${r.count??0} kết quả${r.error?' · '+r.error:''}`);$('searchLog').textContent=lines.join('\n')||'Chưa có lượt tìm.';}
/* Local phrase locator: only copy characters which genuinely exist in the retrieved text.
   It is a discovery hint, NOT a semantic determination of a patent limitation. */
const EVIDENCE_STOP=new Set('một các những trong ngoài bằng được của theo với hoặc cùng bao gồm gồm trong đó thiết bị hệ thống phương pháp quy trình phương tiện and with from wherein comprising comprises method system device apparatus having using respectively claim claims the said this that thereof thereon said having same which said'.split(' '));
function visibleTerms(feature){
 const raw=String(feature.text||feature.name||'').normalize('NFC');
 const toks=raw.match(/[\p{L}\p{N}]+(?:[-/][\p{L}\p{N}]+)*/gu)||[];
 const terms=[];
 const add=x=>{const t=norm(x);const w=t.split(/\s+/);if(t.length>=9&&t.length<=175&&w.length>=2&&w.some(v=>v.length>=4&&!EVIDENCE_STOP.has(fold(v)))&&!terms.includes(t))terms.push(t);};
 if(feature.kind==='concept'){
   for(const s of [feature.name,...(feature.source||[]),...(S.concepts.find(c=>('T-'+c.id)===feature.id)?.alternatives||[])])add(s);
 }else{
   if(raw.length>=22&&raw.length<=260)add(raw);
   for(const n of [5,4,3,2])for(let j=0;j+n<=toks.length&&terms.length<72;j++){
     const fragment=toks.slice(j,j+n);
     if(fragment.every(w=>EVIDENCE_STOP.has(fold(w))))continue;
     add(fragment.join(' '));
   }
 }
 return terms;
}
function localEvidence(feature,doc){
 if(!doc||['snippet_only','abstract_only','metadata_only','metadata'].includes(doc.content_level)||!doc.text||doc.text.length<65)return null;
 const t=String(doc.text).normalize('NFC'), lower=t.toLocaleLowerCase(), terms=visibleTerms(feature);
 let best=null;
 for(const phrase of terms){const idx=lower.indexOf(phrase.toLocaleLowerCase());if(idx<0)continue;
   const contextStart=Math.max(0,idx-100),contextEnd=Math.min(t.length,idx+phrase.length+180);
   const match=t.slice(idx,idx+phrase.length),whole=norm(feature.text||feature.name).toLocaleLowerCase()===norm(match).toLocaleLowerCase();
   const points=phrase.length+(whole?300:0);
   if(!best||points>best.points)best={status:whole?'Có':'Một phần',evidence:t.slice(contextStart,contextEnd),match,originalIndex:idx,originalEnd:idx+phrase.length,points,engine:'phrase',literalTextMatch:true,sourceVerified:false,interpretationVerified:false};
 }
 return best;
}
function highlightSource(text,phrase){const t=String(text||'');if(t.toLocaleLowerCase().includes(String(phrase||'').toLocaleLowerCase()))return highlightLiteral(t,phrase);return '<mark title="Cụm liên quan từ nội dung đầu vào, không phải trùng nguyên văn">'+esc(t)+'</mark>'; }
function highlightLiteral(text,phrase){
 const s=String(text||''),q=String(phrase||'');if(!q)return esc(s);
 const i=s.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());
 if(i<0)return esc(s);return esc(s.slice(0,i))+'<mark>'+esc(s.slice(i,i+q.length))+'</mark>'+esc(s.slice(i+q.length));
}
function featureRankForDocument(doc,features){
 if(!doc?._detail)return {hits:0,total:features.length,ratio:0};
 const d={text:[doc._detail.claims&&'CLAIMS\n'+doc._detail.claims,doc._detail.description&&'DESCRIPTION\n'+doc._detail.description].filter(Boolean).join('\n\n'),content_level:doc._detail.content_level};
 let hits=0,exact=0;for(const f of features){const m=localEvidence(f,d);if(m){hits++;if(m.status==='Có')exact++;}}
 return {hits,total:features.length,exact,ratio:features.length?hits/features.length:0,source:d.content_level||'không rõ',textChars:d.text.length};
}
function machineStats(slot){let yes=0,partial=0,reviewed=0;const d=S.prior[slot];
 for(const f of S.features){const a=S.ai[matrixKey(f.id,slot)],r=S.matrix[matrixKey(f.id,slot)];
  if(r?.checked&&r.sourceNo===d?.no){reviewed++;if(r.status==='Có')yes++;else if(r.status==='Một phần')partial++;}
  else if(a?.literalTextMatch&&a.evidence&&d?.text&&quotedInDocument(a.evidence,d.text)){
   if(a.status==='Có')yes++;else if(a.status==='Một phần')partial++;
  }
 }
 return {yes,partial,reviewed,total:S.features.length};
}
function sortPriorByMachine(quiet=false){
 const slots=['D1','D2','D3'].filter(k=>S.prior[k]?.no);
 if(slots.length<2)return;
 const oldP={...S.prior},oldM={...S.matrix},oldA={...S.ai},oldC={...S.aiCoverage};
 const entries=slots.map(slot=>({slot,doc:oldP[slot],stat:machineStats(slot)}));
 entries.sort((a,b)=>(b.stat.yes+b.stat.partial)-(a.stat.yes+a.stat.partial)||b.stat.yes-a.stat.yes||(b.doc.overlap?.hits||0)-(a.doc.overlap?.hits||0));
 if(entries.every((e,i)=>e.slot===slots[i]))return;
 S.prior={D1:null,D2:null,D3:null};S.matrix={};S.ai={};S.aiCoverage={};
 for(let i=0;i<entries.length;i++){const e=entries[i],slot=['D1','D2','D3'][i];S.prior[slot]=e.doc;
  if(oldC[e.slot])S.aiCoverage[slot]=oldC[e.slot];
  for(const f of S.features){const ok=matrixKey(f.id,e.slot),nk=matrixKey(f.id,slot);if(oldM[ok])S.matrix[nk]=oldM[ok];if(oldA[ok])S.ai[nk]=oldA[ok];}
 }
 S.reportHtml='';if(!quiet){renderPrior();renderMatrix();notify('Đã tự xếp D1–D3 theo số đặc điểm có đoạn khớp trong dữ liệu đã nạp. Không phải kết luận pháp lý.');}
}
function autoCompare(quiet=false){
 if(!S.features.length)S.features=featuresFromClaims();
 let compared=0;for(const slot of ['D1','D2','D3']){const doc=S.prior[slot];if(!doc?.no)continue;
  for(const f of S.features){const key=matrixKey(f.id,slot);if(S.matrix[key]?.checked||S.ai[key]?.engine==='gemini')continue;
   const m=localEvidence(f,doc);if(m)S.ai[key]={...m,sourceNo:doc.no};else delete S.ai[key];compared++;
  }
 }
 S.autoComputed=true;S.reportHtml='';
 if(!quiet){renderPrior();renderMatrix();notify('Đã tự rà '+compared+' cặp đặc điểm × tài liệu; thứ tự D1–D3 được giữ theo kết quả tra cứu keyword; phần bôi sáng chỉ là trùng cụm từ. Chuyên gia xem lại bản gốc nếu dùng cho kết luận.');}
}

function ranking(candidate,queries){
  // Metadata-only discovery order. This is NOT claim coverage or a novelty score.
  const text=fold((candidate.title||'')+' '+(candidate.snippet||''));let hits=0;
  for(const q of queries){const words=fold(q).replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w.length>3);if(words.length&&words.some(w=>text.includes(w)))hits++;}
  return hits;
}
const RANK_STOP=new Set('trong những được một nhiều thành thân của các này đó với theo việc phần rằng thiết bị hệ thống phương pháp quy trình said claim comprises comprising wherein including from each having such which into for the and with this that said production produce producing manufacture manufacturing apparatus invention patent document company corporation ltd limited cong ty tnhh co phan'.split(' '));
function importantTerms(text){
  return [...new Set(fold(text).match(/[a-z0-9]{4,}/g)||[])].filter(x=>!RANK_STOP.has(x)&&!/^[0-9]+$/.test(x)).slice(0,28);
}
function selectSearchKeywords(){
  // v55: toàn bộ keyword (anchor + feature + support) là fingerprint để ranking.
  // Chỉ anchor/feature được ghép thành query search; support không bị mất mà vẫn tham gia độ phủ.
  return [...(S.route?.keywords||[])].filter(k=>norm(k.term).length>=3)
    .sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0));
}
function keywordVariantsFor(row){
  const out=[row.term],pair=(S.keywordPairs||[]).find(x=>fold(x.source)===fold(row.term)),api=window.PATENTLENS_KEYWORDS;
  const add=v=>{v=norm(v);if(v&&!out.some(x=>fold(x)===fold(v)))out.push(v);};
  if(pair){
    if(pair.normalized){const a=new Set(fold(row.term).split(/\s+/)),b=new Set(fold(pair.normalized).split(/\s+/));const inter=[...a].filter(x=>b.has(x)).length;if(inter/Math.max(1,Math.min(a.size,b.size))>=.45)add(pair.normalized);}
    if(pair.en&&!/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(pair.en))add(pair.en);
    if(pair.vi&&(/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(pair.vi)||api?.detectPhraseLanguage?.(pair.vi,'vi')?.viScore>2))add(pair.vi);
  }
  return out.filter(Boolean);
}
function phraseMatchScore(text,phrase){
  const f=fold(text||''),p=fold(phrase||'').trim();if(!f||!p)return {score:0,exact:false};
  if(f.includes(p))return {score:1,exact:true};
  const terms=importantTerms(phrase);if(terms.length<2)return {score:0,exact:false};
  const matched=terms.filter(w=>new RegExp('(?:^|[^a-z0-9])'+w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:$|[^a-z0-9])').test(f)).length;
  return {score:matched/terms.length,exact:false};
}
function keywordSignal(text,titleOnly=''){
  const rows=selectSearchKeywords();if(!rows.length)return {weightedCoverage:0,strongHits:0,exactHits:0,longExactHits:0,titleStrongHits:0,total:0,matched:[]};
  const maxW=Math.max(1,...rows.map(x=>Number(x.score)||1));let weighted=0,totalW=0,strong=0,exact=0,longExact=0,titleStrong=0;const matched=[];
  for(const row of rows){
    const w=Math.max(.18,Math.min(1,(Number(row.score)||1)/maxW));let best={score:0,exact:false,variant:''},bestTitle=0;
    for(const v of keywordVariantsFor(row)){
      const m=phraseMatchScore(text,v);if(m.score>best.score)best={...m,variant:v};
      if(titleOnly)bestTitle=Math.max(bestTitle,phraseMatchScore(titleOnly,v).score);
    }
    totalW+=w;weighted+=w*best.score;if(best.score>=.67){strong++;matched.push({term:row.term,score:best.score,exact:best.exact,variant:best.variant});}if(best.exact){exact++;if(norm(row.term).split(/\s+/).length>=3)longExact++;}if(bestTitle>=.67)titleStrong++;
  }
  return {weightedCoverage:totalW?weighted/totalW:0,strongHits:strong,exactHits:exact,longExactHits:longExact,titleStrongHits:titleStrong,total:rows.length,matched};
}
function documentOverlap(candidate){
  const body=fold(String(candidate._detail?.claims||'')+' '+String(candidate._detail?.description||''));
  if(body.length<60)return {hits:0,total:0,ratio:0,source:'metadata/snippet'};
  const sig=keywordSignal(body,candidate.title||'');
  return {hits:sig.strongHits,total:sig.total,ratio:sig.weightedCoverage,source:'văn bản chi tiết trích xuất chưa xác thực'};
}
function reviewedOverlap(slot){
  let yes=0,partial=0,reviewed=0;const d=S.prior[slot];
  if(!d?.no)return {yes,partial,reviewed};
  for(const f of S.features){const r=S.matrix[matrixKey(f.id,slot)];if(!r?.checked||r.sourceNo!==d.no)continue;reviewed++;if(r.status==='Có')yes++;else if(r.status==='Một phần')partial++;}
  return {yes,partial,reviewed};
}
async function autoReadAndRank(){
 if(S.autoReadBusy)return;
 if(!S.candidates.length)return notify('Chưa có ứng viên. Kiểm tra nhật ký tra cứu.',true);
 S.autoReadBusy=true;$('autoPick').disabled=true;
 if(!S.features.length)S.features=featuresFromClaims();
 // Bounded concurrent detail retrieval: do not block the interface for 10 sequential 20s requests.
 const shortlist=S.candidates.slice(0,Math.min(10,S.candidates.length)),errors=[];
 let completed=0;
 async function inspect(c){
   try{
    if(!c._detail){
     if(c.document_type==='paper'){c._detail={claims:'',description:c.snippet||'',content_level:c.content_level||'abstract_only',description_truncated:false,url:c.url};}
     else{
      const response=await fetch('/api/detail?pub='+encodeURIComponent(c.publication_number),{signal:AbortSignal.timeout(18000),headers:$('apiCode').value.trim()?{'x-public-api-access-code':$('apiCode').value.trim()}: {}});
      const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'Không đọc được nội dung chi tiết');
      c._detail={claims:result.claims||'',description:result.description||'',content_level:result.content_level||'metadata_only',description_truncated:result.description_truncated??null,url:result.url||c.url};
     }
    }
    const fullText=(c._detail.claims||'')+' '+String(c._detail.description||'');c.keywordSignal=keywordSignal(fullText,c.title||'');c.kwCover=c.keywordSignal.weightedCoverage;c.keywordChars=fullText.length;c.queryMatch=directQueryMatchMetrics(fullText,c.foundQueries||[]);c.directHits=c.keywordSignal.strongHits;c.overlap=documentOverlap(c);
   }catch(e){c.kwCover=c.kwCover||0;errors.push(c.publication_number+': '+String(e.message||e).slice(0,95));}
   finally{completed++;$('searchProgress').textContent=`Đã thử đọc ${completed}/${shortlist.length} ứng viên · ${errors.length} lỗi. Chỉ so khớp trên phần nội dung thực sự lấy được.`;}
 }
 try{
   for(let i=0;i<shortlist.length;i+=3)await Promise.allSettled(shortlist.slice(i,i+3).map(inspect));
   const semEligible=shortlist.filter(c=>(c.keywordSignal?.strongHits||0)>=1||(c.keywordSignal?.weightedCoverage||0)>=.18);
   const semInfo=await semanticRankCandidates(semEligible);
   for(const c of shortlist)if(!semEligible.includes(c)){c.semanticScore=0;c.semanticEngine='skipped-topic-drift';}
   for(const c of S.candidates)c.retrievalScore=retrievalScore(c);
   const ordered=[...shortlist].sort((a,b)=>(b.retrievalScore||0)-(a.retrievalScore||0)||(b.kwCover||0)-(a.kwCover||0)||(b.directHits||0)-(a.directHits||0));
   const qualified=ordered.filter(candidateQualified);
   const chosen=qualified.slice(0,3);
   for(let i=0;i<3;i++){const slot=['D1','D2','D3'][i],c=chosen[i];if(!c){S.prior[slot]=null;continue;}
     selectPrior(slot,c,{quiet:true});const d=S.prior[slot];
     if(c._detail){d.text=[c._detail.claims&&'CLAIMS\n'+c._detail.claims,c._detail.description&&'DESCRIPTION\n'+c._detail.description].filter(Boolean).join('\n\n')||c.snippet||'';d.content_level=c._detail.content_level||'metadata_only';d.url=c._detail.url||d.url;
      d.extractionWarning=c._detail.description_truncated!==false?'Mô tả chưa xác minh trọn vẹn.':'Chưa xác thực sự đầy đủ/đúng nghĩa của bản web và hình vẽ.';d.keywordCoverage=c.kwCover||0;
     }else{d.extractionWarning='Không đọc được tài liệu chi tiết: chỉ có snippet/metadata.';}
   }
   S.candidates.sort((a,b)=>(b.retrievalScore||0)-(a.retrievalScore||0)||(b.kwCover||0)-(a.kwCover||0)||(b.foundQueries?.length||0)-(a.foundQueries?.length||0));
   autoCompare(true);renderPrior();renderCandidates();
   $('searchProgress').textContent=`Đã thử lấy chi tiết ${shortlist.length} ứng viên; ${qualified.length} tài liệu vượt ngưỡng liên quan theo keyword trực tiếp${semInfo.engine&&semInfo.engine!=='unavailable'?' + semantic hỗ trợ':''}. ${chosen.length<3?'Không tự lấp đủ D1–D3 bằng tài liệu yếu. ':''}${errors.length} ứng viên lỗi/không đọc được; mở nguồn gốc để kiểm tra.`;
   notify(chosen.length?`Đã chọn ${chosen.length} tài liệu đủ tín hiệu liên quan vào D1–D${chosen.length}. ${chosen.length<3?'Các ô còn lại được để trống thay vì chọn tài liệu lạc chủ đề. ':''}Bảng so sánh chỉ là hỗ trợ rà soát.`:'Chưa có tài liệu nào vượt ngưỡng liên quan đủ để tự chọn D1–D3. Hãy kiểm tra keyword hoặc kết quả nguồn thay vì dùng tài liệu lạc chủ đề.',!chosen.length);
 }finally{S.autoReadBusy=false;$('autoPick').disabled=false;}
}
function sortPriorByReview(){autoCompare();}
function kwCoverage(text){return keywordSignal(text).weightedCoverage;}


function sourceSemanticProfile(){
 const parts=[];
 const title=norm(S.route?.stats?.title||'');if(title)parts.push('TITLE: '+title);
 for(const k of selectSearchKeywords()){parts.push('KEYWORD: '+k.term);const pair=(S.keywordPairs||[]).find(x=>fold(x.source)===fold(k.term));if(pair?.en&&fold(pair.en)!==fold(k.term))parts.push('EN: '+pair.en);}
 if(S.claims?.length)parts.push('CLAIM: '+String(S.claims[0].text||'').slice(0,1200));
 else if(S.source)parts.push('SOURCE: '+String(S.source).slice(0,1200));
 return parts.join(' ; ').slice(0,6500);
}
async function semanticRankCandidates(list){
 const rows=(list||[]).slice(0,12).map((c,i)=>({id:String(i),text:[c.title,c.snippet,c._detail?.claims?.slice(0,1800),c._detail?.description?.slice(0,1800)].filter(Boolean).join(' | ')})).filter(x=>x.text);
 const profile=sourceSemanticProfile();if(!profile||!rows.length)return {engine:'none'};
 try{
  const res=await fetch('/api/semantic-rank',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({profile,candidates:rows}),signal:AbortSignal.timeout(22000)});
  const j=await res.json();if(!res.ok||!j.ok)throw Error(j.error||'semantic rank lỗi');
  for(const r of j.rows||[]){const c=list[Number(r.id)];if(c){c.semanticScore=Number(r.score)||0;c.semanticEngine=j.engine||'';}}
  return {engine:j.engine||'',warning:j.warning||''};
 }catch(e){return {engine:'unavailable',warning:String(e.message||e)};}
}
function directQueryMatchMetrics(text,queries){
 const f=fold(text||'');let hits=0,maxScore=0,totalScore=0,considered=0;
 for(const q of (queries||[])){
   const raw=norm(q);if(!raw)continue;const fq=fold(raw),terms=importantTerms(raw);if(!terms.length)continue;considered++;
   let score=0;if(f.includes(fq))score=1;else{const matched=terms.filter(w=>new RegExp('(?:^|[^a-z0-9])'+w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:$|[^a-z0-9])').test(f)).length;score=matched/terms.length;}
   if(score>=0.67)hits++;maxScore=Math.max(maxScore,score);totalScore+=score;
 }
 return {hits,maxScore,avgScore:considered?totalScore/considered:0,considered};
}
function candidateQualified(c){
 if((c.document_type||'patent')!=='patent')return false;
 const sig=c.keywordSignal||keywordSignal([c.title,c.snippet,c._detail?.claims,c._detail?.description].filter(Boolean).join(' '),c.title||'');
 const qm=c.queryMatch||{maxScore:0,hits:0};
 const found=Number(c.foundQueries?.length)||0;
 // v54: all CORE search keys are searched, but one short/generic hit is never enough for D1–D3.
 // A candidate needs coherence across multiple source keywords OR one long exact phrase with a clear title/query anchor.
 if((sig.longExactHits||0)>=1 && (sig.titleStrongHits>=1 || found>=1))return true;
 if(sig.strongHits>=2 && sig.weightedCoverage>=.07)return true;
 if(sig.strongHits>=3)return true;
 if(qm.maxScore>=.82 && sig.strongHits>=2)return true;
 return sig.weightedCoverage>=.14 && found>=2 && sig.strongHits>=2;
}
function retrievalScore(c){
 const sig=c.keywordSignal||keywordSignal([c.title,c.snippet].filter(Boolean).join(' '),c.title||'');
 const sem=Math.max(0,Math.min(1,Number(c.semanticScore)||0));
 const found=Math.min(1,(Number(c.foundQueries?.length)||0)/4);
 const exact=Math.min(1,(Number(sig.exactHits)||0)/3),longExact=Math.min(1,(Number(sig.longExactHits)||0)/2),strong=Math.min(1,(Number(sig.strongHits)||0)/5),title=Math.min(1,(Number(sig.titleStrongHits)||0)/3);
 const qm=Math.max(0,Math.min(1,Number(c.queryMatch?.maxScore)||0));
 // Tất cả keyword đều tham gia coverage; score extractor chỉ là trọng số. Không keyword nào bị bỏ khỏi search.
 // Semantic chỉ hỗ trợ sau khi đã có tín hiệu lexical/query.
 const lexical=0.38*sig.weightedCoverage+0.18*strong+0.12*exact+0.12*longExact+0.10*title+0.07*found+0.03*qm;
 return lexical+((sig.strongHits>0||sig.exactHits>0)?0.02*sem:0);
}
async function runSearch(){
 if(!$('searchConsent').checked)return notify('Hãy xác nhận gửi các truy vấn kỹ thuật ngắn ra nguồn tìm kiếm bên ngoài.',true);
 // If the input is Vietnamese and the background translation has not finished, try once to obtain faithful EN equivalents.
 if(S.documentLanguage?.primary==='vi'&&!S.keywordPairs.some(x=>norm(x.en))&&!S.routingBusy){
   $('searchProgress').textContent='Đang chuẩn hóa một số feature sang tiếng Anh để tra cứu song ngữ…';
   try{await classifyRouteOnline(true);}catch(_e){}
 }
 const autoPlan=buildRetrievalSearchPlan();
 if(autoPlan.length){S.queries=autoPlan;$('searchQueries').value=autoPlan.map(formatSearchLine).join('\n');}
 let plan=parseSearchLines();if(!plan.length)return notify('Chưa có truy vấn fingerprint hợp lệ.',true);
 // v55 normally produces only 2–6 coherent query bundles, not dozens of one-key requests.
 S.searching=true;S.searchAbort=new AbortController();$('runSearch').disabled=true;$('stopSearch').hidden=false;S.queryLog=[];S.candidates=[];renderCandidates();renderSearchLog();
 const byNo=new Map();let infraFailStreak=0,executed=0;
 for(let i=0;i<plan.length;i++){
  if(S.searchAbort.signal.aborted)break;const item=plan[i],q=item.q.slice(0,180),lang=['vi','en'].includes(item.language)?item.language:'';executed++;
  $('searchProgress').textContent=`Đang tìm fingerprint ${i+1}/${plan.length} · ${lang?lang.toUpperCase():'AUTO'}: ${q}`;
  try{
   const url='/api/search?q='+encodeURIComponent(q)+'&num=20&mode=bundle'+(lang?'&language_track='+encodeURIComponent(lang):'');
   const response=await fetch(url,{cache:'no-store',signal:AbortSignal.any([S.searchAbort.signal,AbortSignal.timeout(55000)]),headers:$('apiCode').value.trim()?{'x-public-api-access-code':$('apiCode').value.trim()}: {}});
   const result=await response.json();
   for(const l of result.search_log||[])S.queryLog.push({...l,language:lang||'auto'});
   if(!response.ok||!result.ok){
     if(!result.search_log?.length)S.queryLog.push({status:result.code||'ERROR',query:q,provider:'Backend',language:lang||'auto',error:result.error||`HTTP ${response.status}`,count:0});
     infraFailStreak=result.code==='SEARCH_FAILED'?infraFailStreak+1:0;
     // Repeating 10 more queries cannot repair a provider outage. Stop after two infrastructure failures.
     if(infraFailStreak>=2)break;
     continue;
   }
   infraFailStreak=0;
   for(const c of result.results||[]){const no=String(c.publication_number||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase();if(!no)continue;if(S.filename&&norm(S.filename).toUpperCase().includes(no))continue;const known=byNo.get(no);if(known){known.foundQueries.add(q);for(const src of [c.discovery_provider||result.provider||'không rõ'])known.sources.add(src);continue;}byNo.set(no,{...c,publication_number:no,foundQueries:new Set([q]),sources:new Set([c.discovery_provider||result.provider||'không rõ'])});}
   if(!result.search_log?.length)S.queryLog.push({query:q,provider:result.provider,language:lang||'auto',status:(result.results||[]).length?'OK':'ZERO',count:(result.results||[]).length});
  }catch(e){if(S.searchAbort.signal.aborted)break;infraFailStreak++;S.queryLog.push({query:q,provider:'Kết nối',language:lang||'auto',status:'ERROR',error:String(e.message||e).slice(0,180),count:0});if(infraFailStreak>=2)break;}
  const qStrings=plan.map(x=>x.q);S.candidates=[...byNo.values()].filter(c=>(c.document_type||'patent')==='patent').map(c=>{const base={...c,document_type:'patent',foundQueries:[...c.foundQueries],sources:[...c.sources],relevance:ranking(c,qStrings)};const metaText=(base.title||'')+' '+(base.snippet||'');base.keywordSignal=keywordSignal(metaText,base.title||'');base.kwCover=base.keywordSignal.weightedCoverage;base.queryMatch=directQueryMatchMetrics(metaText,base.foundQueries);base.directHits=base.keywordSignal.strongHits;base.retrievalScore=retrievalScore(base);return base;}).sort((a,b)=>(b.retrievalScore-a.retrievalScore)||(b.kwCover-a.kwCover)||(b.directHits-a.directHits));renderCandidates();renderSearchLog();await new Promise(r=>setTimeout(r,0));
  // Stop early once a useful candidate pool exists; this also protects Google Patents from rate-limit bursts.
  if(byNo.size>=24&&i>=1)break;
 }
 if(S.candidates.length&&!S.searchAbort.signal.aborted){try{await autoReadAndRank();}catch(e){notify('Đã tìm được ứng viên nhưng chưa đọc sâu hết: '+String(e.message||e),true);}}
 S.searching=false;$('runSearch').disabled=false;$('stopSearch').hidden=true;
 const failures=S.queryLog.filter(x=>x.status==='ERROR').length,ok=S.queryLog.filter(x=>x.status==='OK').length;
 const uniqueProviders=[...new Set(S.queryLog.filter(x=>x.status==='ERROR').map(x=>x.provider))];
 $('searchProgress').textContent=S.candidates.length?`Tìm được ${S.candidates.length} ứng viên từ ${executed} truy vấn fingerprint · ${ok} lượt nguồn có kết quả · ${failures} lỗi.`:infraFailStreak>=2?`Nguồn tự động chưa phản hồi (${uniqueProviders.join(', ')||'provider'}). v56 đã thử XHR sửa encoding + CSV + Browser Run. Nếu Nhật ký vẫn cho thấy Google bị chặn, cần cấu hình EPO OPS/SerpApi ở server-side; không nhập API key trong giao diện.`:`Chưa tìm được ứng viên từ ${executed} truy vấn fingerprint. Có ${failures} lượt lỗi; xem Nhật ký để phân biệt “0 kết quả” và “nguồn bị chặn”.`;
}
function renderCandidates(){const root=$('candidates');root.innerHTML=S.candidates.length?S.candidates.slice(0,80).map((c,i)=>{const sem=c.semanticScore!=null?Math.round(c.semanticScore*100):null,kw=Math.round((c.kwCover||0)*100),sig=c.keywordSignal||keywordSignal((c.title||'')+' '+(c.snippet||''),c.title||''),qualified=candidateQualified(c),why=[`Độ phủ fingerprint ${kw}%`,`${sig.strongHits}/${sig.total||0} keyword mạnh khớp`,`${sig.exactHits} cụm khớp nguyên văn`,`${sig.titleStrongHits} keyword khớp Title`,`${c.foundQueries?.length||0} truy vấn độc lập tìm thấy`,sem!=null&&c.semanticEngine!=='skipped-topic-drift'?`Ngữ nghĩa hỗ trợ ${sem}%`:null].filter(Boolean).join(' · ');return `<article class="candidate ${qualified?'candidate-qualified':'candidate-weak'}"><div class="candidate-head"><h3>${i+1}. ${esc(c.title||c.publication_number)}</h3><span><span class="tag ${qualified?'green':'yellow'}">${qualified?'Qua cổng liên quan':'Loại khỏi D1–D3'}</span> <span class="tag soft">Patent</span> <span class="tag soft">${esc(S.pillar?.name||'Trụ cột chưa chọn')}</span></span></div><p><strong>${esc(c.identifier||c.publication_number)}</strong> · Công bố: ${esc(c.publication_date||'chưa rõ')} · Nguồn tìm: ${esc(c.sources?.join(', ')||c.discovery_provider||'chưa rõ')}</p><div class="why-result"><strong>Vì sao được ưu tiên?</strong><span>${esc(why)}</span><small>v56 dùng truy vấn fingerprint gồm đối tượng chính + 1–2 đặc điểm kỹ thuật. Toàn bộ keyword vẫn được dùng để chấm độ phủ/ranking; từ chung không bị search riêng lẻ.</small></div><p class="muted small">${esc((c.snippet||'Không có snippet.').slice(0,420))}</p><p class="muted small">Mức nội dung hiện có: ${esc(c._detail?.content_level||c.content_level||'metadata/snippet')} · chưa mặc định coi là toàn văn hay tư cách đối chứng.</p><div class="inline"><a target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(c.url)||'https://patents.google.com/patent/'+encodeURIComponent(c.publication_number)+'/en')}">Mở nguồn ↗</a>${['D1','D2','D3'].map(s=>`<button class="btn" data-pick="${i}" data-slot="${s}">Chọn ${s}</button>`).join('')}</div></article>`;}).join(''):'<p class="muted">Chưa có ứng viên patent đủ liên quan. Hệ thống đã tìm bằng các tổ hợp fingerprint kỹ thuật; hãy mở Nhật ký để xem nguồn patent có bị chặn hoặc truy vấn nào trả 0 kết quả.</p>';root.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>selectPrior(b.dataset.slot,S.candidates[+b.dataset.pick]));}
function selectPrior(slot,c,options={}){if(!c)return;S.prior[slot]={no:c.identifier||c.publication_number,title:c.title||'',date:c.publication_date||'',url:c.url||'',text:c.snippet||'',document_type:c.document_type||'patent',content_level:c.document_type==='paper'?(c.content_level||'abstract_only'):(c.snippet?'snippet_only':'metadata_only'),sourceChecked:false,dateChecked:false,docIdentityChecked:false,combinationClaims:{},loadedFrom:'search'};clearSlot(slot);if(!options.quiet){renderPrior();notify(`${slot} đã chọn. Hãy mở bản gốc/đọc thêm toàn văn rồi kiểm tra từng đoạn tại Bước 4.`);}}
function clearSlot(slot){S.autoComputed=false;for(const key of Object.keys(S.matrix))if(key.endsWith('::'+slot))delete S.matrix[key];for(const key of Object.keys(S.ai))if(key.endsWith('::'+slot))delete S.ai[key];for(const key of Object.keys(S.semantic))if(key.endsWith('::'+slot))delete S.semantic[key];delete S.aiCoverage[slot];delete S.semanticCoverage[slot];S.reportHtml='';}
function renderPrior(){const root=$('priorSlots');root.innerHTML=['D1','D2','D3'].map(slot=>{const d=S.prior[slot]||{};return `<article class="prior-slot" data-prior="${slot}"><div class="slot-head"><h3>${slot} · ${esc(d.no||'Chưa chọn')}</h3>${d.url?`<a target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(d.url))}">Mở nguồn gốc ↗</a>`:''}</div><p class="muted small">${Number.isFinite(d.keywordCoverage)?`Mức trùng keyword với hồ sơ đầu vào: ${Math.round((d.keywordCoverage||0)*100)}%. Đây chỉ là tín hiệu ưu tiên đọc, không phải kết luận pháp lý.`: d.no?`Chưa tính độ liên quan trên nội dung chi tiết; cần mở và kiểm tra tài liệu gốc.`:``}</p><label>Mã/định danh tài liệu<input data-field="no" value="${esc(d.no||'')}" placeholder="Ví dụ: US2020123456A1"></label><label>Ngày công bố theo nguồn (chưa xác minh)<input data-field="date" type="date" value="${/^\d{4}-\d{2}-\d{2}$/.test(d.date||'')?d.date:''}"></label><label>Link tài liệu gốc<input data-field="url" value="${esc(d.url||'')}" placeholder="https://..."></label><label>Văn bản đang dùng để tìm chứng cứ <span class="tag ${d.content_level==='snippet_only'?'yellow':''}">${esc(d.content_level||'Chưa nạp')}</span><textarea rows="5" data-field="text" placeholder="Đọc bản gốc hoặc dán nguyên văn những phần được phép sử dụng">${esc(d.text||'')}</textarea></label><div class="inline"><button class="btn" data-detail="${slot}">Thử đọc thêm tài liệu gốc</button><button class="btn" data-remove="${slot}">Bỏ ${slot}</button></div><label class="check"><input type="checkbox" data-verify="sourceChecked" ${d.sourceChecked?'checked':''}> Tôi đã mở và đối chiếu các đoạn nguồn với đúng bản tài liệu công khai.</label><label class="check"><input type="checkbox" data-verify="docIdentityChecked" ${d.docIdentityChecked?'checked':''}> Tôi đã kiểm tra mã công bố/phiên bản nguồn.</label><label class="check"><input type="checkbox" data-verify="dateChecked" ${d.dateChecked?'checked':''}> Tôi đã kiểm tra ngày công bố và tư cách đối chứng cho trường hợp đang xét.</label><p class="muted small">Không được coi snippet/tóm tắt là đã đọc toàn văn; ngày ưu tiên của từng claim cần kiểm tra riêng.</p></article>`}).join('');root.querySelectorAll('[data-prior]').forEach(el=>{const slot=el.dataset.prior;el.querySelectorAll('[data-field]').forEach(input=>input.onchange=()=>{if(!S.prior[slot])S.prior[slot]={combinationClaims:{},loadedFrom:'manual'};const d=S.prior[slot],k=input.dataset.field;d[k]=input.value;if(k==='text'){d.content_level='user_supplied';d.sourceChecked=false;}else if(k==='no'||k==='url'){d.sourceChecked=false;d.docIdentityChecked=false;}else if(k==='date')d.dateChecked=false;clearSlot(slot);renderPrior();});el.querySelectorAll('[data-verify]').forEach(input=>input.onchange=()=>{if(!S.prior[slot])return;S.prior[slot][input.dataset.verify]=input.checked;S.reportHtml='';});el.querySelector('[data-detail]').onclick=()=>loadDetail(slot);el.querySelector('[data-remove]').onclick=()=>{S.prior[slot]=null;clearSlot(slot);renderPrior();};});}
async function loadDetail(slot){const d=S.prior[slot];if(!d?.no)return notify(`Hãy nhập mã/định danh cho ${slot} trước.`,true);if(d.document_type==='paper')return notify(`${slot} là tài liệu khoa học; hệ thống hiện dùng metadata/abstract từ nguồn và mở liên kết gốc để kiểm tra toàn văn.`);const btn=document.querySelector(`[data-detail="${slot}"]`);btn.disabled=true;try{const r=await fetch('/api/detail?pub='+encodeURIComponent(d.no),{signal:AbortSignal.timeout(30000),headers:$('apiCode').value.trim()?{'x-public-api-access-code':$('apiCode').value.trim()}: {}});const x=await r.json();if(!r.ok||!x.ok)throw Error(x.error||`HTTP ${r.status}`);const pieces=[x.claims&&'CLAIMS\n'+x.claims,x.description&&'DESCRIPTION\n'+x.description].filter(Boolean);d.text=pieces.length?pieces.join('\n\n'):x.abstract||d.text;d.content_level=x.content_level||'metadata_only';d.url=x.url||d.url;d.sourceChecked=false;d.docIdentityChecked=false;clearSlot(slot);renderPrior();notify(`${slot}: đã tải ${d.content_level}. Chưa xác thực toàn văn, hình vẽ, ngữ cảnh và bản gốc.`);}catch(e){notify(`Không tải được ${slot}: ${String(e.message||e)}. Bạn vẫn có thể mở nguồn gốc và bổ sung văn bản thủ công.`,true);}finally{if(btn?.isConnected)btn.disabled=false;}}
function featuresFromClaims(){
  if(S.keywordOnly){S.claimFeatureIds={};return S.concepts.map(c=>({id:'T-'+c.id,text:c.name,claimId:0,affectedClaims:[],kind:'concept',source:c.source,topic:c.topic}));}
  const byId=new Map(S.claims.map(c=>[c.id,c]));const own=new Map();
  for(const c of S.claims){
    const parts=c.text.split(/\s*;\s*|\s+(?=(?:trong\s+đó|wherein|whereby)\b)/iu).map(norm).filter(Boolean);
    const chosen=parts.length>1?parts:[c.text];
    const unique=[...new Map(chosen.map(t=>[fold(t),t])).values()];
    own.set(c.id,unique.map((text,i)=>({id:`C${c.id}-F${String(i+1).padStart(2,'0')}`,text,claimId:c.id,sourceClaimId:c.id,kind:'feature',affectedClaims:[c.id]})));
  }
  const all=[...own.values()].flat();const claimMap={};
  for(const c of S.claims){
    const ids=[],seen=new Set(),visited=new Set();
    const collect=id=>{
      if(visited.has(id)||!byId.has(id))return;visited.add(id);
      const source=byId.get(id);
      for(const parent of source.dependsOn||[])collect(parent);
      for(const f of own.get(id)||[]){if(!seen.has(f.id)){ids.push(f.id);seen.add(f.id);}if(!f.affectedClaims.includes(c.id))f.affectedClaims.push(c.id);}
    };
    collect(c.id);claimMap[c.id]=ids;
  }
  S.claimFeatureIds=claimMap;
  return all;
}
function matrixKey(id,slot){return id+'::'+slot;}
function matrixRowStatus(id,slot){return S.matrix[matrixKey(id,slot)]?.status||'Chưa có dữ liệu';}
function quotedInDocument(quote,doc){const q=norm(quote).toLocaleLowerCase(),t=norm(doc||'').toLocaleLowerCase();return q.length>=16&&t.includes(q);}
function lexicalHint(feature,d){if(!d?.text||d.text.length<35)return '';const terms=feature.kind==='concept'?(feature.source||[]):[...new Set(feature.text.match(/[\p{L}]{5,}/gu)||[])].slice(0,10);const body=fold(d.text);for(const term of terms){const needle=fold(term);if(needle.length<5)continue;const index=body.indexOf(needle);if(index>=0){const snippet=d.text.slice(Math.max(0,index-65),Math.min(d.text.length,index+needle.length+180));return snippet;}}return '';}

function semanticPassages(text,max=1050,overlap=140,limit=96){
 const t=String(text||''),out=[];let start=0;
 while(start<t.length&&out.length<limit){
  let end=Math.min(t.length,start+max);
  if(end<t.length){const cut=t.lastIndexOf('\n',end);if(cut>start+Math.floor(max*.55))end=cut;}
  const raw=t.slice(start,end),clean=norm(raw);if(clean.length>=45)out.push({id:'p'+(out.length+1),start,end,text:raw});
  if(end>=t.length)break;start=Math.max(start+1,end-overlap);
 }
 const covered=out.length?Math.max(...out.map(x=>x.end)):0;
 return {passages:out,covered,total:t.length,ratio:t.length?Math.min(1,covered/t.length):0};
}
function semanticStats(slot){
 let high=0,mid=0;for(const f of S.features){const x=S.semantic[matrixKey(f.id,slot)];if(!x)continue;if(x.score>=.72)high++;else if(x.score>=.58)mid++;}
 const cov=S.semanticCoverage[slot];return {high,mid,ratio:cov?.ratio||0,engine:cov?.engine||''};
}
async function runSemanticEvidence(){
 if(S.semanticBusy)return;
 if(!$('semanticConsent')?.checked)return notify('Để so khớp ngữ nghĩa, hãy xác nhận cho phép gửi đặc điểm kỹ thuật và các đoạn D1–D3 đến dịch vụ AI/embedding của hệ thống. Nếu không đồng ý, PatentLens vẫn giữ lớp khớp cụm từ cục bộ.',true);
 if(!S.features.length)S.features=featuresFromClaims();
 const slots=['D1','D2','D3'].filter(slot=>S.prior[slot]?.text?.length>80&&!['snippet_only','metadata_only','metadata'].includes(S.prior[slot].content_level));
 if(!slots.length)return notify('Chưa có D1–D3 với nội dung claims/mô tả đủ để chạy so khớp ngữ nghĩa.',true);
 S.semanticBusy=true;const btn=$('semanticAssist');if(btn)btn.disabled=true;const status=$('semanticProgress');let calls=0,failed=0;
 try{
  for(const slot of slots){const doc=S.prior[slot],pack=semanticPassages(doc.text);S.semanticCoverage[slot]={ratio:pack.ratio,covered:pack.covered,total:pack.total,passages:pack.passages.length,engine:''};
   for(let fi=0;fi<S.features.length;fi+=6){const feats=S.features.slice(fi,fi+6).map(f=>({id:f.id,text:f.text}));
    for(let pi=0;pi<pack.passages.length;pi+=24){const passages=pack.passages.slice(pi,pi+24);calls++;if(status)status.textContent=`${slot}: đối chiếu ngữ nghĩa đoạn ${pi+1}–${Math.min(pi+24,pack.passages.length)}/${pack.passages.length} · lượt ${calls}`;
     try{const res=await fetch('/api/semantic-evidence',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({features:feats,passages}),signal:AbortSignal.timeout(30000)});const j=await res.json();if(!res.ok||!j.ok)throw Error(j.error||'semantic evidence lỗi');S.semanticEngine=j.engine||S.semanticEngine;S.semanticCoverage[slot].engine=j.engine||'';
      for(const row of j.rows||[]){const best=(row.matches||[])[0];if(!best)continue;const key=matrixKey(row.feature_id,slot),old=S.semantic[key];if(!old||Number(best.score)>Number(old.score)){S.semantic[key]={score:Number(best.score)||0,text:String(best.text||''),start:Number(best.start)||0,end:Number(best.end)||0,engine:j.engine||'',sourceNo:doc.no,passageId:best.passage_id||''};}}
     }catch(e){failed++;S.semanticCoverage[slot].issues=[...(S.semanticCoverage[slot].issues||[]),String(e.message||e).slice(0,120)];}
    }
   }
  }
  S.reportHtml='';renderMatrix();renderPrior();if(status)status.textContent=`Đã hoàn tất so khớp ngữ nghĩa: ${calls-failed}/${calls} lượt thành công. Điểm similarity chỉ dùng để tìm đoạn cần đọc; không phải xác suất đúng hay kết luận bộc lộ đặc điểm.`;
 }finally{S.semanticBusy=false;if(btn)btn.disabled=false;}
}
function renderMatrix(){
 if(!S.features.length)S.features=featuresFromClaims();
 const slots=['D1','D2','D3'].filter(slot=>S.prior[slot]?.no);
 $('reviewRankSummary').innerHTML=slots.map(slot=>{const m=machineStats(slot),sm=semanticStats(slot),cov=Math.round((sm.ratio||0)*100);return `<span class="tag">${slot}: ${m.yes} trùng nguyên văn · ${sm.high} ứng viên semantic cao · ${m.reviewed} ô chuyên gia · semantic cover ${cov}%</span>`;}).join(' ')||'Chưa có D1–D3';
 $('compareMode').innerHTML=S.keywordOnly?'Đang khảo sát concept. PatentLens dùng ba lớp: <strong>khớp cụm từ → semantic similarity → xác nhận chuyên gia</strong>. Không đánh giá tính mới khi chưa có claim.':'Đối chiếu theo ba lớp: <strong>(1) khớp cụm từ nguyên văn, (2) semantic similarity để tìm đoạn diễn đạt khác chữ, (3) chuyên gia xác nhận trên bản gốc.</strong> “Chưa xác định được bằng chứng” không đồng nghĩa đặc điểm vắng mặt.';
 const root=$('matrix');if(!S.features.length){root.innerHTML='<p>Chưa có concept/feature. Kiểm tra lại nội dung đầu vào.</p>';return;}
 root.innerHTML=S.features.map((f,i)=>`<article class="matrix-row" data-feature="${i}"><header><div><span class="tag">${esc(f.id)}</span>${f.affectedClaims?.length>1?` <span class="tag yellow">Từ Claim ${f.sourceClaimId} · áp dụng: ${f.affectedClaims.map(id=>'C'+id).join(', ')}</span>`:''}<p>${esc(f.text)}</p></div></header><div class="matrix-cols">${['D1','D2','D3'].map(slot=>{
 const d=S.prior[slot],key=matrixKey(f.id,slot),r=S.matrix[key]||{},a=S.ai[key],sem=S.semantic[key];
 const literal=a&&a.evidence&&d&&quotedInDocument(a.evidence,d.text),semanticOk=sem&&d&&sem.sourceNo===d.no;
 const semPct=semanticOk?Math.round((sem.score||0)*100):0;
 const label=r.checked?`Chuyên gia: ${r.status}`:literal?(a.status==='Có'?'Khớp nguyên văn mạnh':'Có cụm từ liên quan'):semanticOk?(sem.score>=.72?`Ứng viên ngữ nghĩa cao · ${semPct}%`:sem.score>=.58?`Ứng viên ngữ nghĩa · ${semPct}%`:`Độ gần ngữ nghĩa thấp · ${semPct}%`):(d?.no?'Chưa xác định được bằng chứng':'Chưa có dữ liệu');
 const literalHtml=literal?`<div class="evidence-layer literal"><div class="evidence-layer-head"><strong>Lớp 1 · Khớp cụm từ</strong><span class="tag yellow">literal</span></div><p class="evidence-text">${highlightLiteral(a.evidence,a.match||a.evidence)}</p><p class="muted small">Đoạn này tồn tại trong phần văn bản đã tải về, nhưng trùng chữ chưa đủ để xác nhận ý nghĩa kỹ thuật.</p></div>`:'';
 const semanticHtml=semanticOk?`<div class="evidence-layer semantic"><div class="evidence-layer-head"><strong>Lớp 2 · Đoạn gần nghĩa nhất</strong><span class="tag soft">${semPct}%</span></div><p class="evidence-text">${esc(sem.text)}</p><p class="muted small">Engine: ${esc(sem.engine||'semantic')} · Điểm cosine/heuristic chỉ dùng xếp đoạn cần đọc, không phải xác suất “Có”. ${sem.score<.58?'Tín hiệu thấp; ưu tiên kiểm tra cách diễn đạt khác hoặc bản gốc.':''}</p></div>`:'';
 const emptyHtml=!literal&&!semanticOk?'<div class="evidence-empty"><strong>Chưa xác định được bằng chứng</strong><p class="muted small">Hiện chưa có câu trích trực tiếp hoặc kết quả semantic cho ô này. Điều này có thể do cách diễn đạt khác, dữ liệu trích chưa đủ, hình vẽ hoặc OCR; không được suy ra rằng đặc điểm không tồn tại.</p></div>':'';
 return `<div class="cell" data-cell="${esc(key)}" data-slot="${slot}"><strong>${slot}</strong> <span class="tag ${literal?'yellow':semanticOk&&sem.score>=.72?'green':''}">${esc(label)}</span><p class="muted small">${esc(d?.no||'Chưa chọn nguồn')}</p>${literalHtml}${semanticHtml}${emptyHtml}<details><summary>Lớp 3 · Chuyên gia xác nhận / sửa</summary><label>Trạng thái<select data-review="status"><option>Chưa có dữ liệu</option><option>Chưa chắc chắn</option><option>Có</option><option>Một phần</option></select></label><label>Đoạn trích nguyên văn<textarea rows="3" data-review="quote"></textarea></label><label>Vị trí tài liệu gốc<input data-review="location" placeholder="Claim 2 / [0024] / trang / hình"></label><label>Nhận xét chuyên gia<input data-review="note" placeholder="Giải thích vì sao đoạn này bộc lộ hoặc chưa bộc lộ đặc điểm"></label><button class="btn" data-save-cell="${i}" ${d?.no?'':'disabled'}>Lưu xác nhận</button><p class="cell-note muted" data-review-message>${r.checked?'Đã lưu xác nhận chuyên gia.':'Chưa có xác nhận chuyên gia; các lớp máy chỉ là gợi ý.'}</p></details></div>`;
 }).join('')}</div></article>`).join('');
 root.querySelectorAll('[data-cell]').forEach(cell=>{const key=cell.dataset.cell,r=S.matrix[key]||{};for(const field of ['status','quote','location','note'])cell.querySelector(`[data-review="${field}"]`).value=r[field]||(field==='status'?'Chưa có dữ liệu':'');cell.querySelector('[data-save-cell]').onclick=()=>saveCell(cell);});
}
function saveCell(cell){const key=cell.dataset.cell,slot=cell.dataset.slot,d=S.prior[slot],status=cell.querySelector('[data-review="status"]').value,quote=norm(cell.querySelector('[data-review="quote"]').value),location=norm(cell.querySelector('[data-review="location"]').value),note=norm(cell.querySelector('[data-review="note"]').value);const feedback=cell.querySelector('[data-review-message]');if(!d?.no){feedback.textContent='Chưa có tài liệu '+slot;return;}if(['Có','Một phần'].includes(status)&&(!d.sourceChecked||!d.docIdentityChecked||!location||note.length<8||!quotedInDocument(quote,d.text))){feedback.textContent='Chưa lưu: phải kiểm tra đúng mã/bản gốc, nhập đoạn trích khớp chữ trong văn bản đã nạp (≥16 ký tự), vị trí và nhận xét ít nhất 8 ký tự.';return;}S.matrix[key]={status,quote,location,note,checked:true,at:new Date().toISOString(),sourceNo:d.no,sourceUrl:d.url||'',sourceRevision:S.revision};S.reportHtml='';feedback.textContent='Đã lưu quyết định của chuyên gia; không phải chứng thực pháp lý tự động.';cell.querySelector('.tag').textContent=status;}
function textChunks(text,max=5800,overlap=300){const t=String(text||''),out=[];let start=0;while(start<t.length){const end=Math.min(start+max,t.length);out.push({start,end,text:t.slice(start,end)});if(end===t.length)break;start=Math.max(start+1,end-Math.min(overlap,Math.floor(max/3)));}let covered=0;for(const c of out){if(c.start>covered)throw Error('CHUNK_GAP: đoạn đầu vào bị bỏ sót');covered=Math.max(covered,c.end);}if(covered!==t.length)throw Error('CHUNK_GAP: không bao phủ cuối văn bản');return out;}
function chunkFingerprint(text){const x=String(text||'');let h=2166136261;for(let i=0;i<x.length;i++)h=Math.imul(h^x.charCodeAt(i),16777619);return x.length+':'+(h>>>0).toString(16);}
function cellSummary(){const counts={checked:0,proposed:Object.keys(S.ai).length,total:S.features.length*3};for(const x of Object.values(S.matrix))if(x.checked)counts.checked++;return counts;}
function evidenceByDocumentHtml(){
 const slots=['D1','D2','D3'].filter(slot=>S.prior[slot]?.no);if(!slots.length)return '<p>Chưa có D1–D3.</p>';
 if(!S.features.length)S.features=featuresFromClaims();
 return slots.map(slot=>{const d=S.prior[slot],stats=machineStats(slot),semStats=semanticStats(slot);
 const hits=S.features.map(f=>{const key=matrixKey(f.id,slot),r=S.matrix[key]||{},a=S.ai[key]||{},sem=S.semantic[key],checked=r.checked&&r.sourceNo===d.no;
 const quote=checked?r.quote:a.evidence||'',literal=quote&&quotedInDocument(quote,d.text);const semantic=sem&&sem.sourceNo===d.no&&sem.score>=.58;
 if(!literal&&!semantic)return '';
 const state=checked?'Chuyên gia: '+r.status:literal?(a.status==='Có'?'Máy: khớp nguyên văn':'Máy: có cụm liên quan'):`Semantic candidate ${Math.round(sem.score*100)}%`;
 const evidence=literal?`<div class="evidence-text">${highlightLiteral(quote,checked?r.quote:a.match||quote)}</div>`:`<div class="evidence-text">${esc(sem.text)}</div><small>Chỉ là đoạn gần nghĩa theo ${esc(sem.engine||'semantic engine')}; chưa được xác nhận bộc lộ đặc điểm.</small>`;
 const loc=checked?r.location||'chưa rõ':literal?(a.location||'Vị trí theo bản web chưa xác minh'):`Khoảng ký tự ${sem.start||'?'}–${sem.end||'?'}`;
 return `<tr><td>${esc(f.id)}${f.affectedClaims?.length>1?`<br><small>Áp dụng: ${esc(f.affectedClaims.map(id=>'C'+id).join(', '))}</small>`:''}</td><td>${esc(f.text)}</td><td>${esc(state)}</td><td>${evidence}</td><td>${esc(String(loc))}</td></tr>`;}).filter(Boolean);
 return `<section class="dossier-source"><h3>${slot} · ${esc(d.no)}</h3><p class="muted small">Literal: ${stats.yes+stats.partial} đặc điểm · Semantic cao: ${semStats.high} · Semantic coverage: ${Math.round((semStats.ratio||0)*100)}% · ${stats.reviewed} ô chuyên gia đã rà. ${esc(d.extractionWarning||'Chưa xác nhận toàn văn, ngày và hình vẽ')}</p><div class="table-scroll"><table><thead><tr><th>Đặc điểm</th><th>Nội dung đầu vào</th><th>Trạng thái</th><th>Đoạn nguồn</th><th>Vị trí</th></tr></thead><tbody>${hits.join('')||'<tr><td colspan="5">Chưa xác định được bằng chứng trong phần dữ liệu đã xử lý. Không suy ra là đặc điểm không tồn tại.</td></tr>'}</tbody></table></div><p>${d.url?`<a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">Kiểm tra bản gốc ${slot} ↗</a>`:'Chưa có liên kết gốc'}</p></section>`;
 }).join('');
}
function claimFeatureGroup(){const byId=new Map(S.features.map(f=>[f.id,f])),groups=new Map();if(S.keywordOnly){groups.set(0,S.features);return groups;}for(const c of S.claims)groups.set(c.id,(S.claimFeatureIds?.[c.id]||[]).map(id=>byId.get(id)).filter(Boolean));return groups;}
function assessClaim(claim){const group=claimFeatureGroup().get(claim.id)||[],slotResults=[];for(const slot of ['D1','D2','D3']){const d=S.prior[slot];if(!d?.no)continue;const statuses=group.map(f=>S.matrix[matrixKey(f.id,slot)]);const complete=statuses.length===group.length&&statuses.every(r=>r?.checked&&r.status==='Có'&&r.sourceNo===d.no);const dateKnown=!!(d.date&&d.dateChecked);const sameCombination=!!d.combinationClaims?.[claim.id];if(complete)slotResults.push({slot,no:d.no,dateKnown,sourceChecked:!!(d.sourceChecked&&d.docIdentityChecked),sameCombination});}const meta=S.claimDates[claim.id]||{};const targetVerified=!!(meta.date&&meta.verified&&$('claimInputVerified')?.checked)&&(!S.filename||!!S.pdf)&&!S.unread.length&&!(S.noText?.length||0)&&(!S.expectedClaims||S.claims.length>=S.expectedClaims)&&!claim.dependencyIssue&&!claim.needsReview;const candidate=targetVerified?slotResults.find(r=>r.dateKnown&&r.sourceChecked&&r.sameCombination&&S.prior[r.slot].date<meta.date):null;return {claimId:claim.id,group:group.length,slotResults,candidate,targetVerified};}
function assessmentHtml(){
 const slots=['D1','D2','D3'].filter(s=>S.prior[s]?.no);
 const gaps=[];if(S.pdf&&S.unread.length)gaps.push(`${S.unread.length} trang PDF chưa xử lý xong`);if(S.pdf&&S.noText?.length)gaps.push(`${S.noText.length} trang đã thử OCR nhưng không có văn bản đủ tin cậy (có thể là hình/bản vẽ hoặc scan chất lượng thấp)`);
 if(S.claims.some(c=>c.needsReview||c.dependencyIssue))gaps.push('có claim bị nghi OCR dính hoặc quan hệ phụ thuộc chưa rõ; cần đối chiếu bản gốc');if(S.expectedClaims&&S.claims.length<S.expectedClaims)gaps.push(`chỉ phát hiện ${S.claims.length}/${S.expectedClaims} claims ghi trên bìa`);
 if(S.queryLog.some(x=>x.status==='ERROR'))gaps.push('một số lượt tìm kiếm bị lỗi');
 if(slots.some(slot=>['metadata_only','snippet_only','abstract_only','metadata'].includes(S.prior[slot].content_level)))gaps.push('có nguồn mới chứa metadata/snippet');
 if(slots.some(slot=>S.prior[slot].extractionWarning))gaps.push('một số bản mô tả chưa xác minh toàn văn');
 let findings='';
 if(S.keywordOnly){findings='<p><strong>Khảo sát ý tưởng / keyword:</strong> chỉ tìm và so sánh những concept đã nhận diện. Không có claims hợp lệ để xác định tính mới hoặc trình độ sáng tạo theo yêu cầu bảo hộ.</p>';}
 else {
   const groups=claimFeatureGroup();findings=S.claims.map(claim=>{
    const fs=groups.get(claim.id)||[],parserUncertain=!!(claim.needsReview||claim.dependencyIssue||(S.expectedClaims&&S.claims.length<S.expectedClaims)||(S.pdf&&(S.unread.length||(S.noText?.length||0))));
    const review=assessClaim(claim);
    const perSlot=slots.map(slot=>{const d=S.prior[slot],confirmed=fs.filter(f=>{const r=S.matrix[matrixKey(f.id,slot)];return r?.checked&&r.sourceNo===d.no&&r.status==='Có';}).length,literal=fs.filter(f=>{const a=S.ai[matrixKey(f.id,slot)];return a?.evidence&&quotedInDocument(a.evidence,d.text);}).length,semantic=fs.filter(f=>{const sm=S.semantic[matrixKey(f.id,slot)];return sm?.sourceNo===d.no&&sm.score>=.72;}).length;return {slot,d,confirmed,literal,semantic};}).sort((a,b)=>b.confirmed-a.confirmed||b.literal-a.literal||b.semantic-a.semantic);
    const best=perSlot[0],total=fs.length;
    let novelty='';
    if(parserUncertain)novelty='Claims hoặc dữ liệu đầu vào chưa được xác minh đầy đủ, nên hệ thống chỉ hiển thị bằng chứng gợi ý và <strong>không tạo cảnh báo tính mới theo claim này.</strong>';
    else if(review.candidate)novelty=`Sau khi chuyên gia xác nhận từng đặc điểm, cùng tổ hợp trong ${esc(review.candidate.slot)} và mốc ngày của tài liệu, hệ thống gắn cờ ${esc(review.candidate.slot)} (${esc(review.candidate.no)}) để <strong>tiếp tục thẩm định tính mới</strong>. Đây vẫn không phải kết luận pháp lý tự động.`;
    else if(best?.confirmed)novelty=`Chuyên gia hiện mới xác nhận ${best.confirmed}/${total} đặc điểm trong ${esc(best.slot)}. <strong>Chưa đủ cơ sở đánh giá tính mới.</strong>`;
    else if(best&&(best.literal||best.semantic))novelty=`Máy tìm được ${best.literal} tín hiệu khớp cụm từ và ${best.semantic} ứng viên semantic mức cao trong ${esc(best.slot)} trên tổng ${total} đặc điểm. Các tín hiệu này chỉ giúp định vị đoạn cần đọc; <strong>chưa đủ cơ sở đánh giá tính mới nếu chưa có xác nhận chuyên gia.</strong>`;
    else novelty='<strong>Chưa xác định được bằng chứng trong D1–D3 đã xử lý.</strong> Điều này không chứng minh đặc điểm vắng mặt hoặc claim có tính mới.';
    const inventive='PatentLens chỉ hỗ trợ tập hợp D1–D3 và các đoạn liên quan. Việc xác định khác biệt kỹ thuật, tác dụng kỹ thuật và lý do kết hợp tài liệu vẫn cần chuyên viên thực hiện; <strong>hệ thống không tự kết luận trình độ sáng tạo.</strong>';
    return `<section class="notice"><strong>Claim ${claim.id} · tổng hợp hỗ trợ (chưa phải kết luận)</strong><p><b>Tính mới:</b> ${novelty}</p><p><b>Trình độ sáng tạo:</b> ${inventive}</p></section>`;
   }).join('');
 }
 const semCov=slots.map(s=>`${s} ${Math.round((S.semanticCoverage[s]?.ratio||0)*100)}%`).join(' · ');
 return `${findings}<p class="muted small">Đã so sánh ${S.features.length} đặc điểm/concept; ${slots.length} tài liệu được chọn.${semCov?` Semantic coverage: ${esc(semCov)}.`:''} ${gaps.length?'<strong>Giới hạn: '+esc(gaps.join(' · '))+'.</strong>':'Chưa có bằng chứng hệ thống đã tra cứu hết các nguồn và xác minh hình vẽ.'} Đây là bản hỗ trợ rà soát, không phải quyết định cấp bằng hoặc ý kiến pháp lý.</p>`;
}
function renderCombinationChecks(){if(S.keywordOnly)return '';return S.claims.map(c=>`<details><summary>Claim ${c.id} · kiểm tra quan hệ trong cùng một tài liệu (tùy khi có bằng chứng)</summary>${['D1','D2','D3'].map(slot=>{const d=S.prior[slot];if(!d?.no)return '';return `<label class="check"><input type="checkbox" data-combine="${esc(slot)}" data-claim="${c.id}" ${d.combinationClaims?.[c.id]?'checked':''}> Tôi đã đối chiếu bản gốc: ${slot} bộc lộ các giới hạn Claim ${c.id} trong <strong>cùng tổ hợp</strong>, không ghép từ tài liệu khác.</label>`}).join('')}</details>`).join('');}
function renderReport(){
 if(!S.features.length)S.features=featuresFromClaims();
 $('claimDatesReview').innerHTML='';
 $('conclusion').innerHTML=assessmentHtml()+'<h3>D1 → D3: bằng chứng và ứng viên bằng chứng</h3><p class="muted small">Bảng phân biệt rõ khớp nguyên văn, đoạn gần nghĩa và xác nhận chuyên gia. Chỉ xác nhận chuyên gia trên bản gốc mới được dùng cho nhận định tiếp theo.</p>'+evidenceByDocumentHtml();
 $('expertNote').value=S.expertNote;$('expertSignoff').checked=S.signed;$('reportPreview').innerHTML=S.reportHtml;
}
function reportCreate(){
 S.expertNote=$('expertNote').value.trim();S.signed=$('expertSignoff').checked;
 if(!S.features.length)S.features=featuresFromClaims();
 const slots=['D1','D2','D3'].filter(s=>S.prior[s]?.no),sourceRows=slots.map(slot=>{const d=S.prior[slot];return `<tr><td>${slot}</td><td>${esc(d.no)}</td><td>${esc(d.date||'chưa xác minh')}</td><td>${esc(d.content_level||'chưa rõ')}</td><td>${d.url?`<a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">Mở nguồn ↗</a>`:'Chưa có'}</td></tr>`;}).join('');
 S.reportHtml=`<h2>PatentLens AI · Báo cáo ${S.signed?'(đã ghi nhận chuyên gia xem)':'(DỰ THẢO MÁY — CHƯA DUYỆT)'}</h2><p>Đầu vào: ${esc(S.filename||'văn bản được cung cấp')} · ${S.keywordOnly?'Chế độ keyword-only':'Claims: '+S.claims.length} · Ngày tạo: ${esc(new Date().toLocaleString('vi-VN'))}</p><h3>Nhận định ban đầu</h3>${assessmentHtml()}<h3>Ba nguồn ưu tiên</h3><table><thead><tr><th>Thứ tự</th><th>Mã công bố</th><th>Ngày công bố</th><th>Độ phủ nội dung lấy được</th><th>Nguồn</th></tr></thead><tbody>${sourceRows}</tbody></table><h3>D1 → D3: bằng chứng và ứng viên bằng chứng</h3>${evidenceByDocumentHtml()}<p><small>Đặc điểm kế thừa chỉ hiển thị một lần theo nguồn gốc. Phân tích từng claim vẫn tính đầy đủ các giới hạn kế thừa. Bảng D1–D3 phía trên phân biệt trạng thái máy/chuyên gia ở từng đoạn.</small></p><h3>Nhận xét chuyên gia (tùy chọn)</h3><p>${esc(S.expertNote||'Chưa có.')}</p><p>${S.signed?'Người dùng đã đánh dấu đã xem; không có xác thực danh tính/chữ ký số.':'Chưa có xác nhận chuyên gia.'}</p><p><strong>Phạm vi:</strong> Các trang OCR lỗi, bản vẽ, trích xuất thiếu toàn văn, ngày ưu tiên và mức bao phủ tìm kiếm phải kiểm tra bằng bản gốc. Trùng thuật ngữ không đồng nghĩa bộc lộ đầy đủ một claim. Kết quả không thay thế ý kiến pháp lý hoặc đánh giá trình độ sáng tạo của chuyên gia.</p>`;
 $('reportPreview').innerHTML=S.reportHtml;if($('reportDetails'))$('reportDetails').open=true;if($('makeReport'))$('makeReport').textContent='Cập nhật bản xem trước';notify('Đã tạo bản xem trước báo cáo dự thảo tự động; chuyên gia chỉ cần đọc và ghi nhận xét nếu muốn.');
}
function fileDownload(name,content,type){const blob=new Blob([content],{type}),href=URL.createObjectURL(blob),a=document.createElement('a');a.href=href;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),1000);}
function exportHtml(){if(!S.reportHtml)reportCreate();fileDownload('PatentLens_report.html','<!doctype html><html lang="vi"><meta charset="utf-8"><title>PatentLens Research</title><style>body{font:13px/1.6 Arial;margin:32px;color:#222}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:6px;vertical-align:top}h2{border-bottom:1px solid #555}@media print{body{margin:12mm}}</style>'+S.reportHtml,'text/html;charset=utf-8');}
function exportPdf(){if(!S.reportHtml)reportCreate();const w=window.open('','_blank');if(!w)return notify('Trình duyệt đang chặn cửa sổ in. Hãy cho phép pop-up cho PatentLens rồi thử lại.',true);const css=`@page{size:A4;margin:14mm}body{font:12px/1.55 Arial,sans-serif;color:#1f2937;margin:0}h1,h2,h3{color:#18223b;page-break-after:avoid}h2{font-size:20px;border-bottom:2px solid #6559e8;padding-bottom:7px}h3{font-size:14px;margin-top:18px}table{border-collapse:collapse;width:100%;font-size:10px;page-break-inside:auto}tr{page-break-inside:avoid}th,td{border:1px solid #cfd5df;padding:6px;vertical-align:top}.notice,.conclusion{border:1px solid #d8dce8;border-radius:8px;padding:10px;margin:10px 0;background:#fafbff}.muted,small{color:#667085}a{color:#3347aa;text-decoration:none}.evidence-text{white-space:pre-wrap}`;w.document.open();w.document.write('<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>PatentLens AI - Báo cáo</title><style>'+css+'</style></head><body>'+S.reportHtml+'<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),250));<\/script></body></html>');w.document.close();notify('Đã mở bản in. Chọn “Save as PDF / Lưu dưới dạng PDF” trong hộp thoại để lưu file.');}
function exportCsv(){const rows=[['ID','Feature/concept','Claim','Nguồn','Literal status','Semantic score','Semantic engine','Semantic passage','Chuyên gia xác nhận','Trích dẫn chuyên gia','Vị trí','Nhận xét']];for(const f of S.features)for(const slot of ['D1','D2','D3']){const key=matrixKey(f.id,slot),r=S.matrix[key]||{},a=S.ai[key]||{},sm=S.semantic[key]||{};rows.push([f.id,f.text,f.claimId||'',slot,a.status||'',sm.score!=null?sm.score:'',sm.engine||'',sm.text||'',r.checked?r.status:'CHƯA DUYỆT',r.quote||'',r.location||'',r.note||'']);}const csv='\ufeff'+rows.map(cols=>cols.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');fileDownload('PatentLens_matrix.csv',csv,'text/csv;charset=utf-8');}
function saveDraft(){const data={schema:'patentlens-v39',mode:S.mode,source:S.source,filename:S.filename,fileMeta:S.fileMeta,pagesAudit:S.pages.map(p=>({page:p.page,length:p.text.length,status:p.status})),unread:S.unread,claims:S.claims,keywordOnly:S.keywordOnly,route:S.route,concepts:S.concepts,queries:S.queries,queryLog:S.queryLog,candidates:S.candidates,prior:S.prior,features:S.features,matrix:S.matrix,ai:S.ai,aiCoverage:S.aiCoverage,expertNote:S.expertNote,signed:S.signed,when:new Date().toISOString()};fileDownload('PatentLens_nhap_v39.json',JSON.stringify(data,null,2),'application/json;charset=utf-8');notify('Đã lưu JSON nháp vào máy, KHÔNG gồm PDF gốc và chưa mã hóa. Không gửi nháp chứa hồ sơ mật.');}
async function openDraft(file){if(!file)return;try{const data=JSON.parse(await file.text());if(data.schema!=='patentlens-v39')throw Error('Chỉ hỗ trợ nháp v39; không tự tin vào dữ liệu quyết định cũ từ phiên bản khác.');S.mode=data.mode||'prospective';S.source=String(data.source||'');S.filename=data.filename||'';S.fileMeta=data.fileMeta||null;S.pages=[];S.unread=[...(data.unread||[])];S.pdf=null;S.claims=parseStructuredClaims(S.source);S.keywordOnly=!S.claims.length;S.claimDates={};S.route=null;S.concepts=[];S.queries=data.queries||[];S.queryLog=data.queryLog||[];S.candidates=data.candidates||[];S.prior=data.prior||{D1:null,D2:null,D3:null};for(const d of Object.values(S.prior))if(d){d.sourceChecked=false;d.dateChecked=false;d.docIdentityChecked=false;d.combinationClaims={};}S.features=[];S.claimFeatureIds={};S.matrix={};S.ai={};S.aiCoverage={};S.expertNote=data.expertNote||'';S.signed=false;S.reportHtml='';$('sourceText').value=S.source;$('fileName').textContent=S.filename?'Nháp tham chiếu PDF: '+S.filename+' (cần nạp lại để kiểm tra)':'Đã mở văn bản trong nháp';$('ingestState').textContent='Đã mở nháp; mọi bằng chứng và ngày từ JSON phải được kiểm tra lại. Các xác nhận cũ đã xóa khỏi ma trận.';document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('selected',b.dataset.mode===S.mode));if(S.filename)S.unread=S.unread.length?S.unread:['Cần nạp lại PDF gốc'];stepShow(0);notify('Đã mở nháp. Tải lại PDF bản gốc và xác nhận nguồn trước khi dùng kết quả nghiên cứu.');}catch(e){notify('Không mở được nháp: '+String(e.message||e),true);}}
/* PDF input: read every available text layer with page-level exceptions and yield to UI.
   OCR scanned/weak pages explicitly, never declare them complete prematurely. */
const PDFJS_URL='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
let pdfLibPromise=null;
function loadScript(url){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=url;s.onload=resolve;s.onerror=()=>reject(Error('Không tải được thư viện từ '+url));document.head.appendChild(s);});}
async function pdfLibrary(){if(!pdfLibPromise)pdfLibPromise=(async()=>{if(!window.pdfjsLib)await loadScript(PDFJS_URL);if(!window.pdfjsLib)throw Error('Không có PDF.js');pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';return window.pdfjsLib;})();return pdfLibPromise;}
function readPageText(content){let text='';for(const it of content.items||[]){const piece=String(it.str||'');if(!piece)continue;text+=piece;if(it.hasEOL)text+='\n';else if(!/\s$/.test(piece))text+=' ';}const api=window.PATENTLENS_KEYWORDS;return api?.cleanText?api.cleanText(text):text.replace(/[ \t]+\n/g,'\n').normalize('NFC');}
function refreshInputPageState(){
 S.unread=S.pages.filter(p=>!['text','ocr','no_text'].includes(p.status)).map(p=>p.page);
 S.noText=S.pages.filter(p=>p.status==='no_text').map(p=>p.page);
 const total=S.pdf?.numPages||S.pages.length;
 const textPages=S.pages.filter(p=>p.status==='text'||p.status==='ocr').length;
 const noText=S.noText.length;
 const unresolved=S.unread.length;
 const checked=Math.min(total,textPages+noText);
 const card=$('ocrStatusCard'),title=$('ocrStatusTitle'),count=$('ocrStatusCount'),mini=$('ocrMiniProgress'),icon=$('ocrStatusIcon');
 if(!S.pdf){if(card)card.hidden=true;return;}
 if(card)card.hidden=false;
 const pct=total?Math.round(checked/total*100):0;
 if(mini)mini.style.width=pct+'%';
 if(count)count.textContent=`${checked}/${total} trang đã kiểm tra · ${pct}%`;
 if(S.pdfBusy){
   card.className='ocr-status-card busy';if(icon)icon.textContent='…';if(title)title.textContent='Đang đọc và OCR tự động';
   $('pageAudit').textContent=`Đang xử lý theo từng trang. Hiện có ${textPages}/${total} trang có văn bản dùng được${noText?`; ${noText} trang đã thử OCR nhưng chưa phát hiện đủ chữ`:''}${unresolved?`; ${unresolved} trang đang chờ xử lý`:''}.`;
 }else if(unresolved){
   card.className='ocr-status-card warning';if(icon)icon.textContent='!';if(title)title.textContent=`Còn ${unresolved} trang chưa xử lý xong`;
   const pages=unresolved<=12?` Các trang đang chờ: ${S.unread.join(', ')}.`:'';
   $('pageAudit').textContent=`Hệ thống đã kiểm tra ${checked}/${total} trang. ${unresolved} trang vẫn chưa hoàn tất OCR.${pages}${noText?` Ngoài ra có ${noText} trang đã thử OCR nhưng không phát hiện đủ chữ.`:''}${S.expectedClaims?' Hồ sơ nêu '+S.expectedClaims+' claims; hiện nhận diện '+S.claims.length+'.':''}`;
 }else if(noText){
   card.className='ocr-status-card visual';if(icon)icon.textContent='▧';if(title)title.textContent=`Đã kiểm tra đủ ${total}/${total} trang · ${noText} trang không có văn bản OCR đủ tin cậy`;
   const pages=noText<=14?` Các trang: ${S.noText.join(', ')}.`:'';
   $('pageAudit').textContent=`OCR đã được thử trên toàn bộ phần không có lớp chữ. ${noText} trang không tạo được văn bản đủ tin cậy — thường là trang hình/bản vẽ hoặc ảnh scan chất lượng thấp; hệ thống không đưa các trang này vào keyword/claims.${pages}${S.expectedClaims&&S.claims.length<S.expectedClaims?' Hồ sơ nêu '+S.expectedClaims+' claims nhưng hiện nhận diện '+S.claims.length+'; nếu claim còn lại nằm trong các trang ảnh, cần đối chiếu PDF gốc hoặc bản scan rõ hơn.':''}`;
 }else{
   card.className='ocr-status-card success';if(icon)icon.textContent='✓';if(title)title.textContent='Đã nhận diện văn bản trên toàn bộ tài liệu';
   $('pageAudit').textContent=`Đã có nội dung chữ ở ${textPages}/${total} trang. Hình vẽ, công thức, bố cục bảng và ngữ nghĩa kỹ thuật vẫn cần đối chiếu PDF gốc khi dùng làm bằng chứng.`;
 }
 $('ocrMissing').hidden=!S.pdf||!unresolved||S.pdfBusy;
 $('ocrClaims').hidden=!S.pdf||(!unresolved&&!noText)||S.pdfBusy||!(S.expectedClaims>S.claims.length||!S.claims.length);
 $('ocrAll').hidden=!S.pdf||S.pdfBusy||(!unresolved&&!noText)||(unresolved<=8&&!noText);
 $('stopPdf').hidden=!S.pdfBusy;
 if(!S.pdfBusy&&unresolved){$('ocrMissing').textContent=unresolved<=8?`OCR ${unresolved} trang còn lại`:'OCR 8 trang tiếp';}
 if(!S.pdfBusy&&(unresolved||noText)){$('ocrAll').textContent=noText&&!unresolved?`Thử OCR lại ${noText} trang hình/scan`:`OCR lại toàn bộ ${unresolved+noText} trang chưa có chữ chắc chắn`;}
 if(S.stage===0&&$('next')){
   if(S.pdfBusy)$('next').textContent='Đang đọc PDF…';
   else if(unresolved)$('next').textContent='Tiếp tục với phần đã đọc →';
   else if(noText)$('next').textContent='Tiếp tục với dữ liệu chữ đã nhận diện →';
   else $('next').textContent='Tiếp tục →';
 }
}
async function readPdfFile(file){
 if(!file)return;
 if(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf')return notify('Hiện tại trang này chỉ hỗ trợ PDF hoặc dán văn bản. Không tự coi DOCX/ảnh là đã đọc.',true);
 S.pdfAbort=false;S.pdfBusy=true;S.pdf=null;S.pages=[];S.unread=[];S.noText=[];S.uploadId++;S.ocrToken++;invalidate(1);S.source='';S.claims=[];S.keywordOnly=true;
 $('claimsPreview').innerHTML='';$('searchQueries').value='';S.fileMeta={name:file.name,size:file.size};S.filename=file.name;$('fileName').textContent=`${file.name} · ${(file.size/1024/1024).toFixed(1)} MB`;$('sourceText').value='';$('ingestState').textContent='Đang mở PDF và đọc lớp chữ theo từng trang...';$('ingestProgress').style.width='1%';refreshInputPageState();
 const generation=S.revision,uploadId=S.uploadId;
 try{
   const lib=await pdfLibrary();const buffer=await file.arrayBuffer();if(S.pdfAbort)return;
   const pdf=await lib.getDocument({data:new Uint8Array(buffer)}).promise;S.pdf=pdf;S.pages=Array.from({length:pdf.numPages},(_,i)=>({page:i+1,text:'',status:'pending',ocrTried:false}));refreshInputPageState();
   for(let i=0;i<pdf.numPages;i++){
     if(S.pdfAbort||generation!==S.revision||uploadId!==S.uploadId)break;
     const record=S.pages[i];
     try{
       const page=await Promise.race([pdf.getPage(i+1),new Promise((_,reject)=>setTimeout(()=>reject(Error('Trang tải quá 25 giây')),25000))]);
       const content=await Promise.race([page.getTextContent(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Lớp chữ trang quá 25 giây')),25000))]);
       const text=readPageText(content);record.text=text;record.status=text.replace(/\s/g,'').length>=45?'text':'weak';record.reason=record.status==='weak'?'Không có đủ lớp chữ; sẽ tự chuyển sang OCR.':'';page.cleanup();
     }catch(e){record.status='error';record.error=String(e.message||e);}
     const finished=i+1;$('ingestProgress').style.width=Math.round(finished/pdf.numPages*100)+'%';$('ingestState').textContent=`Đọc lớp chữ PDF: trang ${finished}/${pdf.numPages} · ${S.pages.filter(p=>p.status==='text').length} trang có chữ.`;
     if(finished%3===0||finished===pdf.numPages){refreshInputPageState();await new Promise(requestAnimationFrame);}
   }
   if(S.pdfAbort||uploadId!==S.uploadId||generation!==S.revision){if(uploadId===S.uploadId)$('ingestState').textContent='Đã dừng đọc PDF; cần mở lại để kiểm tra các trang còn thiếu.';return;}
   const text=S.pages.map(p=>p.text?'[TRANG '+p.page+']\n'+p.text:'').filter(Boolean).join('\n\n');
   if(text.trim())setInput(text,file.name);
   S.pdfBusy=false;refreshInputPageState();
   const autoTargets=S.pages.filter(p=>!['text','ocr','no_text'].includes(p.status)).length;
   if(autoTargets){
     $('ingestState').textContent=`Phát hiện ${autoTargets} trang không có lớp chữ đầy đủ. Hệ thống đang tự động OCR các trang này…`;
     notify(`Đã đọc lớp chữ. ${autoTargets} trang dạng scan/ảnh/chữ yếu sẽ được OCR tự động; bạn không cần bấm thêm.`,false);
     await ocrMissingPages('auto');
   }else{
     $('ingestState').textContent=`Đã đọc lớp chữ trên ${pdf.numPages}/${pdf.numPages} trang.`;
   }
 }catch(e){
   notify('Không mở/đọc được PDF: '+String(e.message||e)+'. Có thể thử dán văn bản hoặc dùng PDF gốc rõ hơn.',true);$('ingestState').textContent='Đọc PDF thất bại; không đánh dấu đã hoàn tất.';
 }finally{
   if(uploadId===S.uploadId&&S.pdfBusy){S.pdfBusy=false;refreshInputPageState();}
 }
}
let ocrLibPromise=null;
async function tesseractLibrary(){if(!ocrLibPromise)ocrLibPromise=(async()=>{if(!window.Tesseract)await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');if(!window.Tesseract)throw Error('Không tải được OCR engine');return window.Tesseract;})();return ocrLibPromise;}
function candidateClaimsOcrOrder(items){
  // If the available text says the last textual pages contain descriptions,
  // start at the first unread pages after them; don't assume claims are on pages 10–19.
  // Visit *all* remaining pages when full OCR is explicitly requested.
  const textual=S.pages.filter(p=>p.status==='text'&&p.text.length>70);
  const maxEarlier=textual.length?Math.max(...textual.map(p=>p.page)):0;
  const firstGap=items.find(p=>p.page>=Math.min(maxEarlier+1,S.pdf?.numPages||Infinity))?.page||0;
  return [...items].sort((a,b)=>{
    const pa=firstGap?Math.abs(a.page-firstGap):a.page,pb=firstGap?Math.abs(b.page-firstGap):b.page;
    return pa-pb||a.page-b.page;
  });
}

function enhanceCanvasForOcr(canvas){
  try{const ctx=canvas.getContext('2d',{willReadFrequently:true}),img=ctx.getImageData(0,0,canvas.width,canvas.height),d=img.data;let min=255,max=0;
    for(let i=0;i<d.length;i+=4){const y=Math.round(.299*d[i]+.587*d[i+1]+.114*d[i+2]);if(y<min)min=y;if(y>max)max=y;d[i]=d[i+1]=d[i+2]=y;}
    const span=Math.max(30,max-min),gain=Math.min(1.45,255/span*0.92);for(let i=0;i<d.length;i+=4){let y=(d[i]-128)*gain+128;y=Math.max(0,Math.min(255,y));d[i]=d[i+1]=d[i+2]=y;}ctx.putImageData(img,0,0);
  }catch(_e){}
  return canvas;
}

function ocrResultQuality(raw,confidence=0){
 const api=window.PATENTLENS_KEYWORDS,text=api?.cleanText?api.cleanText(raw):String(raw||'').normalize('NFC');
 const letters=text.match(/[\p{L}]/gu)?.length||0,chars=text.replace(/\s/g,'').length||1;
 const bad=(text.match(/[�□■¤¦]/g)||[]).length+(text.match(/(?:Ã.|Â.|â€|ï»¿)/g)||[]).length*2;
 const tokens=text.match(/[\p{L}]{2,}/gu)||[];
 const tiny=tokens.filter(x=>x.length<=2).length;
 const score=Math.max(0,Number(confidence)||0)+Math.min(18,letters/chars*18)-Math.min(22,bad*4)-Math.min(10,tokens.length?tiny/tokens.length*10:10);
 return {text,score,confidence:Number(confidence)||0};
}
async function recognizeBestOcr(worker,canvas){
 await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:'3',user_defined_dpi:'300'});
 const first=await worker.recognize(canvas),a=ocrResultQuality(first.data?.text||'',first.data?.confidence||0);
 // Retry only when the first pass is genuinely uncertain. PSM 6 often recovers dense patent claim pages.
 if(a.confidence>=72&&a.score>=78&&a.text.replace(/\s/g,'').length>=80)return {...a,pass:'PSM 3'};
 await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:'6',user_defined_dpi:'300'});
 const second=await worker.recognize(canvas),b=ocrResultQuality(second.data?.text||'',second.data?.confidence||0);
 return b.score>a.score+1?{...b,pass:'PSM 6'}:{...a,pass:'PSM 3'};
}

async function ocrMissingPages(all=false){
  if(!S.pdf||S.pdfBusy)return;
  const sourcePdf=S.pdf,uploadId=S.uploadId,token=++S.ocrToken;
  S.pdfAbort=false;S.pdfBusy=true;refreshInputPageState();let worker=null,processed=0,noTextCount=0,errors=0;
  const unresolved=S.pages.filter(p=>!['text','ocr','no_text'].includes(p.status));
  const retryable=S.pages.filter(p=>!['text','ocr'].includes(p.status));
  const candidates=(all===true||all==='retry'||all==='claims')?retryable:unresolved;
  const work=all==='auto'?unresolved:all===true||all==='retry'?candidates:all==='claims'?candidateClaimsOcrOrder(candidates).slice(0,18):candidates.slice(0,8);
  const cancelled=()=>S.pdfAbort||S.pdf!==sourcePdf||S.uploadId!==uploadId||S.ocrToken!==token;
  try{
    if(!work.length)return;
    $('ingestState').textContent=`Chuẩn bị OCR ${work.length} trang có chữ yếu hoặc ảnh…`;
    const t=await tesseractLibrary();
    worker=await t.createWorker('vie+eng',1,{});
    for(let i=0;i<work.length;i++){
      if(cancelled())break;
      const item=work[i];item.ocrTried=true;let page=null,canvas=null;
      $('ingestState').textContent=`Đang OCR trang ${item.page}/${sourcePdf.numPages} · lượt ${i+1}/${work.length} · ${processed} trang có kết quả. Có thể dừng sau trang hiện tại.`;
      try{
        page=await sourcePdf.getPage(item.page);
        const vp=page.getViewport({scale:2.10});
        // On huge pages lower resolution instead of crashing the whole PDF job.
        const pixelScale=Math.min(1,Math.sqrt(5500000/Math.max(1,vp.width*vp.height)));
        const final=page.getViewport({scale:2.10*pixelScale});
        canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.floor(final.width));canvas.height=Math.max(1,Math.floor(final.height));
        await page.render({canvasContext:canvas.getContext('2d'),viewport:final}).promise;
        enhanceCanvasForOcr(canvas);
        const best=await recognizeBestOcr(worker,canvas);const text=best.text,conf=best.confidence;item.ocrPass=best.pass;
        if(text.replace(/\s/g,'').length>=35){
          item.text=text;item.status='ocr';item.ocrConfidence=conf;
          item.error=conf<62?'OCR đã nhận được chữ nhưng độ tin cậy '+Math.round(conf)+'% ('+best.pass+'); keyword từ trang này sẽ được gắn cảnh báo để kiểm tra lại.':'';processed++;
        }else{
          item.text='';item.status='no_text';item.ocrConfidence=conf;
          item.error='Đã thử OCR nhưng không phát hiện đủ chữ. Trang này có thể là hình/bản vẽ hoặc ảnh scan chất lượng thấp; không được dùng làm dữ liệu văn bản.';noTextCount++;
        }
      }catch(e){item.status='error';item.error=String(e.message||e);errors++;}
      finally{if(canvas){canvas.width=canvas.height=0;}try{page?.cleanup();}catch{}}
      refreshInputPageState();
      if(all==='claims'&&processed){
        const sample=S.pages.filter(p=>p.text).map(p=>'[TRANG '+p.page+']\n'+p.text).join('\n\n');
        const parsed=parseStructuredClaims(sample),expect=expectedClaimCount(sample);
        if(parsed.length && (!expect||parsed.length>=expect))break;
      }
      await new Promise(requestAnimationFrame);
    }
    // Preserve processed pages even when user presses Stop. No silent reset.
    if(S.pdf!==sourcePdf||S.uploadId!==uploadId||S.ocrToken!==token)return;
    const merged=S.pages.filter(p=>p.text).map(p=>'[TRANG '+p.page+']\n'+p.text).join('\n\n');
    if(merged.trim())setInput(merged,S.filename);
    refreshInputPageState();
    $('ingestState').textContent=`OCR hoàn tất lượt này: ${processed} trang nhận được chữ · ${noTextCount} trang không phát hiện đủ chữ · ${errors} trang lỗi. ${S.unread.length?'Còn '+S.unread.length+' trang chưa xử lý xong.':'Đã thử OCR trên toàn bộ trang không có lớp chữ.'} ${S.claims.length} claim có cấu trúc${S.expectedClaims?' / '+S.expectedClaims+' claim ghi trên bìa':''}.`;
  }catch(e){notify('OCR không thực hiện được: '+String(e.message||e)+'. Vẫn giữ trang chưa đọc, không đánh dấu hoàn tất.',true);}
  finally{try{await worker?.terminate();}catch{}if(S.pdf===sourcePdf&&S.uploadId===uploadId){S.pdfBusy=false;refreshInputPageState();}}
}

function validateNext(){if(S.stage===0)return inputDataRequired();if(S.stage===1){if(!S.route)renderRoute();ensureImmediatePillar();if(!S.pillar){notify('Chưa xác định trụ cột. Hãy chọn 1 trong 3 trụ cột.',true);return false;}return !!S.source.trim();}if(S.stage===2){if(!['D1','D2','D3'].some(slot=>S.prior[slot]?.no)){notify('Chưa có D1–D3 để so sánh. Hãy tìm hoặc nhập ít nhất một tài liệu công khai.',true);return false;}return true;}return true;}
function bind(){stepShow(0);loadHealth();document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{S.mode=b.dataset.mode;document.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('selected',x===b));});$('claimInputVerified').onchange=()=>{S.reportHtml='';renderReport();};$('useText').onclick=()=>{S.pdfAbort=true;S.uploadId++;S.ocrToken++;S.pdf=null;S.pages=[];S.unread=[];S.noText=[];S.pdfBusy=false;S.fileMeta=null;if($('ocrStatusCard'))$('ocrStatusCard').hidden=true;setInput($('sourceText').value);};$('pdfFile').onchange=e=>readPdfFile(e.target.files?.[0]);$('stopPdf').onclick=()=>{S.pdfAbort=true;$('ingestState').textContent='Đang dừng sau trang hiện tại...';};$('ocrMissing').onclick=()=>ocrMissingPages(false);$('ocrClaims').onclick=()=>ocrMissingPages('claims');$('ocrAll').onclick=()=>{const n=S.unread.length+(S.noText?.length||0);if(confirm('Thử OCR lại '+n+' trang chưa có văn bản chắc chắn. Trang hình/bản vẽ có thể vẫn không sinh được chữ; hệ thống sẽ ghi rõ thay vì coi là lỗi. Tiếp tục?'))ocrMissingPages('retry');};$('back').onclick=()=>stepShow(S.stage-1);$('next').onclick=()=>{if(S.stage===4){reportCreate();return;}if(!validateNext())return;stepShow(S.stage+1);};$('searchQueries').addEventListener('input',renderSourceLinks);$('runSearch').onclick=runSearch;$('stopSearch').onclick=()=>S.searchAbort?.abort();$('autoPick').onclick=autoReadAndRank;$('semanticAssist').onclick=runSemanticEvidence;$('makeReport').onclick=reportCreate;$('exportPdf').onclick=exportPdf;$('exportHtml').onclick=exportHtml;$('exportCsv').onclick=exportCsv;$('saveDraft').onclick=saveDraft;$('openDraft').onchange=e=>openDraft(e.target.files?.[0]);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
