/* PatentLens v41 — Five-stage research prototype. Frontend does not carry API keys. */
'use strict';
const $=id=>document.getElementById(id);
const norm=s=>String(s??'').normalize('NFC').replace(/\s+/g,' ').trim();
const fold=s=>norm(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();
const esc=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const STAGES=[['intake','Nhập liệu','Tải PDF hoặc dán keyword, mô tả hay yêu cầu bảo hộ.'],['route','Định tuyến chủ đề','Nhận diện nhóm chính, concept và biến thể tìm kiếm từ kho thuật ngữ.'],['search','Tìm tài liệu theo nhóm','Chạy các truy vấn, xem nguồn và lựa chọn D1–D3.'],['compare','So sánh bằng chứng','Đối chiếu từng claim-feature hoặc từng concept với từng tài liệu.'],['report','Nhận định và báo cáo','Tổng hợp mức độ bằng chứng; chuyên gia rà soát lần cuối.']];
const S={stage:0,mode:'prospective',source:'',filename:'',fileMeta:null,pdf:null,pages:[],unread:[],pdfBusy:false,pdfAbort:false,uploadId:0,ocrToken:0,claims:[],keywordOnly:true,route:null,routeAudit:null,concepts:[],claimDates:{},queries:[],queryLog:[],candidates:[],prior:{D1:null,D2:null,D3:null},features:[],matrix:{},ai:{},aiCoverage:{},searching:false,searchAbort:null,aiBusy:false,aiStop:false,expertNote:'',signed:false,reportHtml:'',revision:0,expectedClaims:0,autoReadBusy:false,claimFeatureIds:{}};
function notify(message,error=false){const el=$('alert');el.textContent=message;el.className='alert '+(error?'error':'success');el.hidden=false;}
function clearNotice(){$('alert').hidden=true;}
function safeUrl(url){try{const u=new URL(url);return u.protocol==='https:'?u.href:'';}catch{return '';}}
function titleText(){return norm(S.source.split(/[\n.!?]/)[0]).slice(0,200);}
function stepShow(n){S.stage=Math.max(0,Math.min(STAGES.length-1,n));clearNotice();document.querySelectorAll('.stage').forEach((p,i)=>p.classList.toggle('active',i===S.stage));const st=STAGES[S.stage];$('stepCount').textContent=`BƯỚC ${String(S.stage+1).padStart(2,'0')} / 05`;$('stepTitle').textContent=st[1];$('stepIntro').textContent=st[2];$('wizardInfo').textContent=`Bước ${S.stage+1}/5`;$('back').disabled=S.stage===0;$('next').textContent=S.stage===4?'Tạo báo cáo':'Tiếp tục →';$('steps').innerHTML=STAGES.map((s,i)=>`<button type="button" class="stepbtn ${i===S.stage?'active':''}" data-step="${i}" ${i>S.stage?'disabled title="Đi theo luồng từ bước trước"':''}><i>${i+1}</i><span>${esc(s[1])}</span></button>`).join('');$('steps').querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{if(+b.dataset.step<=S.stage)stepShow(+b.dataset.step);});if(S.stage===1)renderRoute();if(S.stage===2)renderSearchStage();if(S.stage===3){if(!S.autoComputed)autoCompare(true);renderMatrix();}if(S.stage===4)renderReport();window.scrollTo({top:0,behavior:'instant'});}
function invalidate(from){S.autoComputed=false;S.revision++;if(from<=1){S.route=null;S.concepts=[];S.queries=[];}if(from<=2){S.queryLog=[];S.candidates=[];S.prior={D1:null,D2:null,D3:null};}if(from<=3){S.features=[];S.claimFeatureIds={};S.matrix={};S.ai={};S.aiCoverage={};S.claimDates={};if($('claimInputVerified'))$('claimInputVerified').checked=false;}S.reportHtml='';}
function setInput(text,filename=''){const t=String(text||'').normalize('NFC');if(!t.trim())return notify('Chưa có nội dung để phân tích.',true);invalidate(1);S.source=t;S.filename=filename;S.claims=parseStructuredClaims(t);S.keywordOnly=!S.claims.length;S.expectedClaims=expectedClaimCount(t);const incomplete=(S.pdf?.numPages||0)>0&&(S.unread.length>0||(S.expectedClaims>0&&S.claims.length<S.expectedClaims));const mode=S.keywordOnly?(incomplete?'CHƯA XÁC ĐỊNH ĐỦ CLAIMS: PDF còn trang chưa đọc hoặc thiếu các claim được ghi trên bìa; cần OCR tiếp. Tạm thời chỉ khảo sát keyword.':'keyword-only: không phát hiện claims có cấu trúc'):'claim-based: đã nhận diện '+S.claims.length+' claims'+(incomplete?' · CHƯA XÁC NHẬN ĐỦ CLAIMS':'');$('ingestState').textContent=`Đã nạp ${t.length.toLocaleString('vi-VN')} ký tự · ${mode}.`;$('claimsPreview').innerHTML=S.claims.length?S.claims.map(c=>`<article><strong>Claim ${c.id}${c.dependsOn.length?' · phụ thuộc '+c.dependsOn.join(', '):''}${c.dependencyIssue?' · phụ thuộc nhiều nhánh/chưa rõ; chờ chuyên gia':''}${c.needsReview?' · nghi OCR dính claim, cần đối chiếu PDF gốc':''}</strong><p>${esc(c.text)}</p></article>`).join(''):'<p>Không có bộ claims được xác nhận từ cấu trúc. Máy giữ nguyên keyword/mô tả để tra cứu; không bịa claim.</p>';}
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
function routeAllText(){const api=window.PATENTLENS_TOPIC_ROUTER;if(!api)throw Error('Chưa tải được kho thuật ngữ topic_lexicon.js.');const text=S.source;const chunks=[];for(let p=0;p<text.length;p+=180000)chunks.push(text.slice(p,p+180000));const byTopic=new Map();let chars=0;for(const chunk of chunks.length?chunks:['']){const scan=api.scan(chunk,{maxChars:200000});chars+=scan.scannedChars;for(const topic of scan.topics){let t=byTopic.get(topic.id);if(!t){t={id:topic.id,name:topic.name,matchedConcepts:[],conceptCount:0};byTopic.set(t.id,t);}for(const c of topic.matchedConcepts){let old=t.matchedConcepts.find(v=>v.id===c.id);if(!old){old={...c,matched:[],alternatives:[...c.alternatives]};t.matchedConcepts.push(old);}for(const m of c.matched)if(!old.matched.includes(m))old.matched.push(m);}}}const topics=[...byTopic.values()].map(t=>({...t,conceptCount:t.matchedConcepts.length})).sort((a,b)=>b.conceptCount-a.conceptCount);S.route={topics,scannedChars:chars,totalChars:text.length,complete:chars===text.length};S.routeAudit={scannedChars:chars,totalChars:text.length};S.concepts=topics.flatMap(t=>t.matchedConcepts.map(c=>({id:t.id+'::'+c.id,topic:t.name,name:c.name,source:c.matched,alternatives:c.alternatives})));if(!S.concepts.length&&S.keywordOnly&&text.length<=160){S.concepts=[{id:'unclassified::raw',topic:'Chưa xác định',name:norm(text),source:[norm(text)],alternatives:[]}];}}
function renderRoute(){if(!S.route)routeAllText();$('modeBadge').textContent=S.keywordOnly?(S.pdf&&S.unread.length?'ĐẦU VÀO CHƯA ĐỌC ĐỦ CLAIMS · tạm khảo sát keyword':'Chế độ keyword-only · chưa có claims'):'Chế độ claims · '+S.claims.length+' claims có cấu trúc'+(S.expectedClaims&&S.claims.length<S.expectedClaims?' · CẦN OCR BỔ SUNG':'');$('originalPreview').value=S.source.length>20000?S.source.slice(0,20000):S.source;$('routeScope').textContent=`Đã rà thuật ngữ trên ${S.route.scannedChars.toLocaleString('vi-VN')} / ${S.route.totalChars.toLocaleString('vi-VN')} ký tự đã nạp. Ô xem trước chỉ hiển thị tối đa 20.000 ký tự.`;
 $('routeResult').innerHTML=S.route.topics.length?S.route.topics.map(t=>`<div class="topic-card"><h3>${esc(t.name)} <span class="tag">${t.conceptCount} concept</span></h3>${t.matchedConcepts.map(c=>`<div class="topic-concept"><strong>${esc(c.name)}</strong><br><small>Thuật ngữ gốc khớp: ${esc(c.matched.join(' · '))}</small><br><small>Biến thể tìm kiếm (cần kiểm tra): ${esc(c.alternatives.join(' · ')||'—')}</small></div>`).join('')}</div>`).join(''):'<div class="notice">Kho thuật ngữ hiện chưa khớp. Bạn vẫn có thể dùng keyword gốc để tìm; không được tự thêm synonym hoặc ép hồ sơ vào một nhóm.</div>';
}
function searchTerms(){const seen=new Set(),out=[];const add=(query,label,concept)=>{const q=norm(query).replace(/[<>`]/g,'').slice(0,110);if(q.length<3)return;const k=fold(q);if(seen.has(k))return;seen.add(k);out.push({q,label,concept});};for(const c of S.concepts.slice(0,7)){const source=c.source.find(x=>x.length>=5)||c.source[0];if(source)add(source,c.topic+' · '+c.name,c.id);const english=c.alternatives.find(x=>/^[a-z][a-z -]{4,}$/i.test(x));if(english)add(english,c.topic+' · '+c.name+' (EN)',c.id);}if(!out.length){const lines=S.source.split(/[\n,;]+/).map(norm).filter(x=>x.length>=4&&x.length<=110);lines.slice(0,6).forEach(t=>add(t,'Từ khóa gốc','raw'));if(!out.length&&S.source.length<180)add(S.source,'Từ khóa gốc','raw');}return out.slice(0,7);}
function renderSearchStage(){if(!S.queries.length)S.queries=searchTerms();if(!$('searchQueries').value.trim())$('searchQueries').value=S.queries.map(x=>x.q).join('\n');renderSourceLinks();renderCandidates();renderPrior();renderSearchLog();}
function renderSourceLinks(){let queries=$('searchQueries').value.split('\n').map(norm).filter(Boolean);const q=(queries[0]||S.queries[0]?.q||'patent').slice(0,160);const list=[['Google Patents','https://patents.google.com/?q='+encodeURIComponent(q)],['WIPO · thủ công','https://patentscope.wipo.int/search/en/advancedSearch.jsf?query='+encodeURIComponent('EN_ALLTXT:('+q+')')],['Espacenet · thủ công','https://worldwide.espacenet.com/patent/search?q='+encodeURIComponent(q)],['Cục SHTT VN · thủ công','https://ipvietnam.gov.vn/']];$('sourceLinks').innerHTML=list.map(([n,u])=>`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(n)} ↗</a>`).join('');}
function renderSearchLog(){const lines=S.queryLog.map(r=>`[${r.status}] ${r.provider||'Không rõ nguồn'} · ${r.query} · ${r.count??0} kết quả${r.error?' · '+r.error:''}`);$('searchLog').textContent=lines.join('\n')||'Chưa có lượt tìm.';}
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
function highlightSource(text,phrase){const t=String(text||'');if(t.toLocaleLowerCase().includes(String(phrase||'').toLocaleLowerCase()))return highlightLiteral(t,phrase);return '<mark title="Khái niệm liên quan từ kho thuật ngữ, không phải trùng nguyên văn">'+esc(t)+'</mark>'; }
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
 S.autoComputed=true;sortPriorByMachine(true);S.reportHtml='';
 if(!quiet){renderPrior();renderMatrix();notify('Đã tự rà '+compared+' cặp đặc điểm × tài liệu và xếp D1–D3; phần bôi sáng chỉ là trùng cụm từ. Chuyên gia xem lại bản gốc nếu dùng cho kết luận.');}
}

function ranking(candidate,queries){
  // Metadata-only discovery order. This is NOT claim coverage or a novelty score.
  const text=fold((candidate.title||'')+' '+(candidate.snippet||''));let hits=0;
  for(const q of queries){const words=fold(q).replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w.length>3);if(words.length&&words.some(w=>text.includes(w)))hits++;}
  return hits;
}
const RANK_STOP=new Set('trong những được một nhiều thành thân của các này đó với theo việc phần rằng thiết bị hệ thống phương pháp quy trình said claim comprises comprising wherein including from each having such which into for the and with this that said'.split(' '));
function importantTerms(text){
  return [...new Set(fold(text).match(/[a-z0-9]{4,}/g)||[])].filter(x=>!RANK_STOP.has(x)&&!/^\d+$/.test(x)).slice(0,28);
}
function documentOverlap(candidate){
  // Readable technical-term overlap heuristic ONLY: do not treat as validated disclosure.
  const body=fold(String(candidate._detail?.claims||'')+' '+String(candidate._detail?.description||''));
  if(body.length<60)return {hits:0,total:0,ratio:0,source:'metadata/snippet'};
  const items=(S.keywordOnly?S.concepts:S.claims).slice(0,120);
  let hits=0,total=0;
  for(const item of items){const terms=importantTerms(S.keywordOnly?[item.name,...(item.source||[])].join(' '):item.text);if(!terms.length)continue;total++;const found=terms.filter(w=>new RegExp('(?:^|[^a-z0-9])'+w+'(?:$|[^a-z0-9])').test(body)).length;if(found>=Math.min(2,terms.length)&&found/terms.length>=0.32)hits++;}
  return {hits,total,ratio:total?hits/total:0,source:'văn bản chi tiết trích xuất chưa xác thực'};
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
     const response=await fetch('/api/detail?pub='+encodeURIComponent(c.publication_number),{
      signal:AbortSignal.timeout(18000),headers:$('apiCode').value.trim()?{'x-public-api-access-code':$('apiCode').value.trim()}: {}});
     const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'Không đọc được nội dung chi tiết');
     c._detail={claims:result.claims||'',description:result.description||'',content_level:result.content_level||'metadata_only',description_truncated:result.description_truncated??null,url:result.url||c.url};
    }
    c.overlap=featureRankForDocument(c,S.features);
   }catch(e){c.overlap={hits:0,total:S.features.length,ratio:0,source:'chưa lấy được nội dung chi tiết'};errors.push(c.publication_number+': '+String(e.message||e).slice(0,95));}
   finally{completed++;$('searchProgress').textContent=`Đã thử đọc ${completed}/${shortlist.length} ứng viên · ${errors.length} lỗi. Chỉ so khớp trên phần nội dung thực sự lấy được.`;}
 }
 try{
   for(let i=0;i<shortlist.length;i+=3)await Promise.allSettled(shortlist.slice(i,i+3).map(inspect));
   const ordered=[...shortlist].sort((a,b)=>(b.overlap?.hits||0)-(a.overlap?.hits||0)||(b.overlap?.exact||0)-(a.overlap?.exact||0)||(b.relevance||0)-(a.relevance||0));
   const chosen=ordered.slice(0,3);
   for(let i=0;i<3;i++){const slot=['D1','D2','D3'][i],c=chosen[i];if(!c){S.prior[slot]=null;continue;}
     selectPrior(slot,c,{quiet:true});const d=S.prior[slot];
     if(c._detail){d.text=[c._detail.claims&&'CLAIMS\n'+c._detail.claims,c._detail.description&&'DESCRIPTION\n'+c._detail.description].filter(Boolean).join('\n\n')||c.snippet||'';d.content_level=c._detail.content_level||'metadata_only';d.url=c._detail.url||d.url;
      d.extractionWarning=c._detail.description_truncated!==false?'Mô tả chưa xác minh trọn vẹn.':'Chưa xác thực sự đầy đủ/đúng nghĩa của bản web và hình vẽ.';d.overlap=c.overlap;
     }else{d.extractionWarning='Không đọc được tài liệu chi tiết: chỉ có snippet/metadata.';}
   }
   S.candidates.sort((a,b)=>(b.overlap?.hits||0)-(a.overlap?.hits||0)||(b.relevance||0)-(a.relevance||0));
   autoCompare(true);renderPrior();renderCandidates();
   $('searchProgress').textContent=`Đã thử lấy chi tiết ${shortlist.length} ứng viên; tự chọn D1–D3 theo số đặc điểm có đoạn khớp. ${errors.length} ứng viên lỗi/không đọc được; mở nguồn gốc để kiểm tra.`;
   notify('Đã tự chọn D1–D3 và dựng bảng so sánh sơ bộ. Chỉ các câu trích trong văn bản đã nạp được tô nổi bật; không thay thế kiểm tra tài liệu gốc.');
 }finally{S.autoReadBusy=false;$('autoPick').disabled=false;}
}
function sortPriorByReview(){autoCompare();}
async function runSearch(){if(!$('searchConsent').checked)return notify('Hãy xác nhận quyền gửi truy vấn kỹ thuật trước khi gọi dịch vụ tìm kiếm.',true);const queries=$('searchQueries').value.split('\n').map(norm).filter(Boolean).slice(0,8);if(!queries.length)return notify('Chưa có truy vấn hợp lệ.',true);S.searching=true;S.searchAbort=new AbortController();$('runSearch').disabled=true;$('stopSearch').hidden=false;S.queryLog=[];S.candidates=[];renderCandidates();renderSearchLog();const byNo=new Map();for(let i=0;i<queries.length;i++){
 if(S.searchAbort.signal.aborted)break;const q=queries[i].slice(0,160);$('searchProgress').textContent=`Đang chạy ${i+1}/${queries.length}: ${q}`;
 try{const url='/api/search?q='+encodeURIComponent(q)+'&num=12&mode=precise';const response=await fetch(url,{cache:'no-store',signal:AbortSignal.any([S.searchAbort.signal,AbortSignal.timeout(45000)]),headers:$('apiCode').value.trim()?{'x-public-api-access-code':$('apiCode').value.trim()}: {}});const result=await response.json();for(const l of result.search_log||[])S.queryLog.push({...l});if(!response.ok||!result.ok){if(!result.search_log?.length)S.queryLog.push({status:result.code||'ERROR',query:q,provider:'Backend',error:result.error||`HTTP ${response.status}`,count:0});continue;}for(const c of result.results||[]){const no=String(c.publication_number||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase();if(!no)continue;if(S.filename&&norm(S.filename).toUpperCase().includes(no))continue;const known=byNo.get(no);if(known){known.foundQueries.add(q);continue;}byNo.set(no,{...c,publication_number:no,foundQueries:new Set([q]),sources:new Set([c.discovery_provider||result.provider||'không rõ'])});}if(!result.search_log?.length)S.queryLog.push({query:q,provider:result.provider,status:(result.results||[]).length?'OK':'ZERO',count:(result.results||[]).length});}
 catch(e){if(S.searchAbort.signal.aborted)break;S.queryLog.push({query:q,provider:'Kết nối',status:'ERROR',error:String(e.message||e).slice(0,180),count:0});}
 S.candidates=[...byNo.values()].map(c=>({...c,foundQueries:[...c.foundQueries],sources:[...c.sources],relevance:ranking(c,queries)})).sort((a,b)=>b.relevance-a.relevance||b.foundQueries.length-a.foundQueries.length);renderCandidates();renderSearchLog();await new Promise(r=>setTimeout(r,0));}
 if(S.candidates.length&&!S.searchAbort.signal.aborted){try{await autoReadAndRank();}catch(e){notify('Đã tìm được ứng viên nhưng lượt đọc chi tiết chưa hoàn tất: '+String(e.message||e),true);}}S.searching=false;$('runSearch').disabled=false;$('stopSearch').hidden=true;const failures=S.queryLog.filter(x=>x.status==='ERROR').length;$('searchProgress').textContent=`Đã chạy ${S.queryLog.length} lượt có log · ${S.candidates.length} mã công bố khác nhau · ${failures} lượt lỗi. ${failures?'Cần kiểm tra nguồn chưa chạy thành công.':'Không bảo đảm tra cứu đầy đủ.'}`;}
function renderCandidates(){const root=$('candidates');root.innerHTML=S.candidates.length?S.candidates.slice(0,80).map((c,i)=>`<article class="candidate"><div class="candidate-head"><h3>${i+1}. ${esc(c.title||c.publication_number)}</h3><span class="tag">Ưu tiên đọc: ${c.relevance?'có thuật ngữ khớp':'cần xem thêm'}</span></div><p><strong>${esc(c.publication_number)}</strong> · Công bố: ${esc(c.publication_date||'chưa rõ')} · Nguồn tìm: ${esc(c.sources?.join(', ')||c.discovery_provider||'chưa rõ')}</p><p class="muted small">${esc((c.snippet||'Không có snippet.').slice(0,420))}</p><p class="muted small">Chỉ dựa metadata/snippet · chưa kiểm tra toàn văn, hình vẽ hoặc tư cách đối chứng.</p><div class="inline"><a target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(c.url)||'https://patents.google.com/patent/'+encodeURIComponent(c.publication_number)+'/en')}">Mở nguồn ↗</a>${['D1','D2','D3'].map(s=>`<button class="btn" data-pick="${i}" data-slot="${s}">Chọn ${s}</button>`).join('')}</div></article>`).join(''):'<p class="muted">Chưa có ứng viên. Nếu nguồn lỗi hoặc chưa cấu hình, dùng liên kết tra thủ công và nhập tài liệu công khai vào D1–D3.</p>';root.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>selectPrior(b.dataset.slot,S.candidates[+b.dataset.pick]));}
function selectPrior(slot,c,options={}){if(!c)return;S.prior[slot]={no:c.publication_number,title:c.title||'',date:c.publication_date||'',url:c.url||'',text:c.snippet||'',content_level:c.snippet?'snippet_only':'metadata_only',sourceChecked:false,dateChecked:false,docIdentityChecked:false,combinationClaims:{},loadedFrom:'search'};clearSlot(slot);if(!options.quiet){renderPrior();notify(`${slot} đã chọn. Hãy mở bản gốc/đọc thêm toàn văn rồi kiểm tra từng đoạn tại Bước 4.`);}}
function clearSlot(slot){S.autoComputed=false;for(const key of Object.keys(S.matrix))if(key.endsWith('::'+slot))delete S.matrix[key];for(const key of Object.keys(S.ai))if(key.endsWith('::'+slot))delete S.ai[key];delete S.aiCoverage[slot];S.reportHtml='';}
function renderPrior(){const root=$('priorSlots');root.innerHTML=['D1','D2','D3'].map(slot=>{const d=S.prior[slot]||{};return `<article class="prior-slot" data-prior="${slot}"><div class="slot-head"><h3>${slot} · ${esc(d.no||'Chưa chọn')}</h3>${d.url?`<a target="_blank" rel="noopener noreferrer" href="${esc(safeUrl(d.url))}">Mở nguồn gốc ↗</a>`:''}</div><p class="muted small">${d.overlap?`Gợi ý thứ tự: ${d.overlap.hits}/${d.overlap.total} nhóm thuật ngữ khớp trong phần văn bản chi tiết đã lấy; KHÔNG phải tỷ lệ bộc lộ claim hay kết luận pháp lý.`: d.no?`Chưa tính độ liên quan trên nội dung chi tiết; cần mở và kiểm tra tài liệu gốc.`:``}</p><label>Mã công bố<input data-field="no" value="${esc(d.no||'')}" placeholder="Ví dụ: US2020123456A1"></label><label>Ngày công bố theo nguồn (chưa xác minh)<input data-field="date" type="date" value="${/^\d{4}-\d{2}-\d{2}$/.test(d.date||'')?d.date:''}"></label><label>Link tài liệu gốc<input data-field="url" value="${esc(d.url||'')}" placeholder="https://..."></label><label>Văn bản đang dùng để tìm chứng cứ <span class="tag ${d.content_level==='snippet_only'?'yellow':''}">${esc(d.content_level||'Chưa nạp')}</span><textarea rows="5" data-field="text" placeholder="Đọc bản gốc hoặc dán nguyên văn những phần được phép sử dụng">${esc(d.text||'')}</textarea></label><div class="inline"><button class="btn" data-detail="${slot}">Thử đọc thêm tài liệu gốc</button><button class="btn" data-remove="${slot}">Bỏ ${slot}</button></div><label class="check"><input type="checkbox" data-verify="sourceChecked" ${d.sourceChecked?'checked':''}> Tôi đã mở và đối chiếu các đoạn nguồn với đúng bản tài liệu công khai.</label><label class="check"><input type="checkbox" data-verify="docIdentityChecked" ${d.docIdentityChecked?'checked':''}> Tôi đã kiểm tra mã công bố/phiên bản nguồn.</label><label class="check"><input type="checkbox" data-verify="dateChecked" ${d.dateChecked?'checked':''}> Tôi đã kiểm tra ngày công bố và tư cách đối chứng cho trường hợp đang xét.</label><p class="muted small">Không được coi snippet/tóm tắt là đã đọc toàn văn; ngày ưu tiên của từng claim cần kiểm tra riêng.</p></article>`}).join('');root.querySelectorAll('[data-prior]').forEach(el=>{const slot=el.dataset.prior;el.querySelectorAll('[data-field]').forEach(input=>input.onchange=()=>{if(!S.prior[slot])S.prior[slot]={combinationClaims:{},loadedFrom:'manual'};const d=S.prior[slot],k=input.dataset.field;d[k]=input.value;if(k==='text'){d.content_level='user_supplied';d.sourceChecked=false;}else if(k==='no'||k==='url'){d.sourceChecked=false;d.docIdentityChecked=false;}else if(k==='date')d.dateChecked=false;clearSlot(slot);renderPrior();});el.querySelectorAll('[data-verify]').forEach(input=>input.onchange=()=>{if(!S.prior[slot])return;S.prior[slot][input.dataset.verify]=input.checked;S.reportHtml='';});el.querySelector('[data-detail]').onclick=()=>loadDetail(slot);el.querySelector('[data-remove]').onclick=()=>{S.prior[slot]=null;clearSlot(slot);renderPrior();};});}
async function loadDetail(slot){const d=S.prior[slot];if(!d?.no)return notify(`Hãy nhập mã công bố cho ${slot} trước.`,true);const btn=document.querySelector(`[data-detail="${slot}"]`);btn.disabled=true;try{const r=await fetch('/api/detail?pub='+encodeURIComponent(d.no),{signal:AbortSignal.timeout(30000),headers:$('apiCode').value.trim()?{'x-public-api-access-code':$('apiCode').value.trim()}: {}});const x=await r.json();if(!r.ok||!x.ok)throw Error(x.error||`HTTP ${r.status}`);const pieces=[x.claims&&'CLAIMS\n'+x.claims,x.description&&'DESCRIPTION\n'+x.description].filter(Boolean);d.text=pieces.length?pieces.join('\n\n'):x.abstract||d.text;d.content_level=x.content_level||'metadata_only';d.url=x.url||d.url;d.sourceChecked=false;d.docIdentityChecked=false;clearSlot(slot);renderPrior();notify(`${slot}: đã tải ${d.content_level}. Chưa xác thực toàn văn, hình vẽ, ngữ cảnh và bản gốc.`);}catch(e){notify(`Không tải được ${slot}: ${String(e.message||e)}. Bạn vẫn có thể mở nguồn gốc và bổ sung văn bản thủ công.`,true);}finally{if(btn?.isConnected)btn.disabled=false;}}
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
function renderMatrix(){
 if(!S.features.length)S.features=featuresFromClaims();
 const slots=['D1','D2','D3'].filter(slot=>S.prior[slot]?.no);
 $('reviewRankSummary').innerHTML=slots.map(slot=>{const m=machineStats(slot);return `<span class="tag">${slot}: ${m.yes} trùng cụm đầy đủ · ${m.partial} đoạn liên quan · ${m.reviewed} ô được chuyên gia rà</span>`;}).join(' ')||'Chưa có D1–D3';
 $('compareMode').textContent=S.keywordOnly?'Đang khảo sát concept: chỉ so khớp thuật ngữ trong nguồn đã nạp, KHÔNG đánh giá tính mới của claim chưa tồn tại.':'Máy đã tự so sánh; những đoạn tô màu là cụm từ khớp trong văn bản đã nạp, chưa chứng minh toàn bộ đặc điểm được bộc lộ cùng tổ hợp.';
 const root=$('matrix');if(!S.features.length){root.innerHTML='<p>Chưa có concept/feature. Kiểm tra lại nội dung đầu vào.</p>';return;}
 root.innerHTML=S.features.map((f,i)=>`<article class="matrix-row" data-feature="${i}"><header><div><span class="tag">${esc(f.id)}</span>${f.affectedClaims?.length>1?` <span class="tag yellow">Từ Claim ${f.sourceClaimId} · áp dụng: ${f.affectedClaims.map(id=>'C'+id).join(', ')}</span>`:''}<p>${esc(f.text)}</p></div></header><div class="matrix-cols">${['D1','D2','D3'].map(slot=>{
 const d=S.prior[slot],key=matrixKey(f.id,slot),r=S.matrix[key]||{},a=S.ai[key];
 const suitable=a&&a.evidence&&d&&quotedInDocument(a.evidence,d.text);
 const label=r.checked?`Chuyên gia: ${r.status}`:suitable?(a.status==='Có'?'Máy: trùng nguyên văn đặc điểm':'Máy: có cụm liên quan'):(d?.no?'Chưa phát hiện đoạn khớp':'Chưa có dữ liệu');
 return `<div class="cell" data-cell="${esc(key)}" data-slot="${slot}"><strong>${slot}</strong> <span class="tag ${suitable?'yellow':''}">${esc(label)}</span><p class="muted small">${esc(d?.no||'Chưa chọn nguồn')}</p>${suitable?`<p class="evidence-text"><b>Đoạn tài liệu tìm được:</b><br>${highlightLiteral(a.evidence,a.match||a.evidence)}</p><p class="muted small">Tô màu chỉ cho biết vị trí chuỗi khớp, không phải chứng thực ý nghĩa kỹ thuật.</p>`:'<p class="muted small">Chưa tìm được câu trích trực tiếp trong phần văn bản hiện có; không có nghĩa đặc điểm vắng mặt.</p>'}<details><summary>Chuyên gia muốn sửa / xác nhận ô này (tùy chọn)</summary><label>Trạng thái<select data-review="status"><option>Chưa có dữ liệu</option><option>Chưa chắc chắn</option><option>Có</option><option>Một phần</option></select></label><label>Đoạn trích nguyên văn<textarea rows="3" data-review="quote"></textarea></label><label>Vị trí tài liệu gốc<input data-review="location" placeholder="Claim 2 / [0024] / trang / hình"></label><label>Nhận xét chuyên gia<input data-review="note" placeholder="Giải thích nội dung trùng hoặc khác"></label><button class="btn" data-save-cell="${i}" ${d?.no?'':'disabled'}>Lưu nhận xét chuyên gia</button><p class="cell-note muted" data-review-message>${r.checked?'Đã lưu nhận xét chuyên gia.':'Chưa có nhận xét chuyên gia; máy vẫn hiển thị kết quả sơ bộ.'}</p></details></div>`;
 }).join('')}</div></article>`).join('');
 root.querySelectorAll('[data-cell]').forEach(cell=>{const key=cell.dataset.cell,r=S.matrix[key]||{};for(const field of ['status','quote','location','note'])cell.querySelector(`[data-review="${field}"]`).value=r[field]||(field==='status'?'Chưa có dữ liệu':'');cell.querySelector('[data-save-cell]').onclick=()=>saveCell(cell);});
}
function saveCell(cell){const key=cell.dataset.cell,slot=cell.dataset.slot,d=S.prior[slot],status=cell.querySelector('[data-review="status"]').value,quote=norm(cell.querySelector('[data-review="quote"]').value),location=norm(cell.querySelector('[data-review="location"]').value),note=norm(cell.querySelector('[data-review="note"]').value);const feedback=cell.querySelector('[data-review-message]');if(!d?.no){feedback.textContent='Chưa có tài liệu '+slot;return;}if(['Có','Một phần'].includes(status)&&(!d.sourceChecked||!d.docIdentityChecked||!location||note.length<8||!quotedInDocument(quote,d.text))){feedback.textContent='Chưa lưu: phải kiểm tra đúng mã/bản gốc, nhập đoạn trích khớp chữ trong văn bản đã nạp (≥16 ký tự), vị trí và nhận xét ít nhất 8 ký tự.';return;}S.matrix[key]={status,quote,location,note,checked:true,at:new Date().toISOString(),sourceNo:d.no,sourceUrl:d.url||'',sourceRevision:S.revision};S.reportHtml='';feedback.textContent='Đã lưu quyết định của chuyên gia; không phải chứng thực pháp lý tự động.';cell.querySelector('.tag').textContent=status;}
function textChunks(text,max=5800,overlap=300){const t=String(text||''),out=[];let start=0;while(start<t.length){const end=Math.min(start+max,t.length);out.push({start,end,text:t.slice(start,end)});if(end===t.length)break;start=Math.max(start+1,end-Math.min(overlap,Math.floor(max/3)));}let covered=0;for(const c of out){if(c.start>covered)throw Error('CHUNK_GAP: đoạn đầu vào bị bỏ sót');covered=Math.max(covered,c.end);}if(covered!==t.length)throw Error('CHUNK_GAP: không bao phủ cuối văn bản');return out;}
function chunkFingerprint(text){const x=String(text||'');let h=2166136261;for(let i=0;i<x.length;i++)h=Math.imul(h^x.charCodeAt(i),16777619);return x.length+':'+(h>>>0).toString(16);}
async function runAi(){if($('privateMode').checked||!$('aiConsent').checked)return notify('Chỉ chạy Gemini khi tài liệu được phép gửi ra ngoài: bỏ chế độ bảo mật và tích đồng ý tại phần Quyền gửi dữ liệu.',true);const pwd=$('deepCode').value.trim();if(pwd.length<12)return notify('Hãy nhập mã truy cập AI chuyên sâu đã đặt trong Cloudflare; không nhập khóa Gemini thật vào website.',true);if(!S.features.length)S.features=featuresFromClaims();const docs=['D1','D2','D3'].filter(slot=>S.prior[slot]?.text?.length>40 && !['snippet_only','metadata_only','abstract_only'].includes(S.prior[slot].content_level));if(!docs.length)return notify('Chưa có D1–D3 có nội dung claims/mô tả đủ để tìm trích dẫn. Snippet không được dùng làm toàn văn.',true);if(S.aiBusy)return;S.aiBusy=true;S.aiStop=false;$('aiAssist').disabled=true;$('aiProgress').textContent='Đang kiểm toán độ phủ văn bản...';let done=0,failed=0,total=0;const slots=[];try{for(const slot of docs){const chunks=textChunks(S.prior[slot].text);slots.push({slot,chunks,features:S.features.filter(f=>f.text.length<=2000)});total+=chunks.length*Math.ceil(S.features.filter(f=>f.text.length<=2000).length/3);}if(total>240){S.aiCoverage={};return notify(`Có ${total} lượt Gemini cần chạy. Để tránh vô tình phát sinh chi phí lớn, hãy chia hồ sơ thành các đợt được chuyên gia cho phép. Không đánh dấu các phần chưa chạy là đã được đọc.`,true);}for(const item of slots){const {slot,chunks,features}=item,doc=S.prior[slot],pending=new Set();for(let k=0;k<chunks.length;k++)for(let p=0;p<features.length;p+=3){if(S.aiStop){failed++;break;}const c=chunks[k],batch=features.slice(p,p+3);$('aiProgress').textContent=`${slot}: đoạn ${k+1}/${chunks.length} · ${done+failed+1}/${total} lượt`;try{const res=await fetch('/api/matrix',{method:'POST',signal:AbortSignal.timeout(68000),headers:{'content-type':'application/json','x-deep-access-code':pwd,...($('apiCode').value.trim()?{'x-public-api-access-code':$('apiCode').value.trim()}:{})},body:JSON.stringify({features:batch.map(f=>({id:f.id,text:f.text})),documents:{[slot]:{no:doc.no,text:c.text}},external_ai_consent:true,confidential_mode:false})});const j=await res.json();if(!res.ok||!j.ok)throw Error(j.error||'Lượt Gemini lỗi');if(j.scan_echo?.chunk_fingerprint!==chunkFingerprint(c.text)||j.scan_echo?.received_chars!==c.text.length)throw Error('Worker nhận khác đoạn đã gửi, không đánh dấu hoàn tất');for(const f of batch){const row=j.rows?.find(r=>r.feature_id===f.id),suggest=row?.[slot];if(!suggest)throw Error('MODEL_INCOMPLETE');const evidence=norm(suggest.evidence||'');if(!['Có','Một phần'].includes(suggest.status)||!evidence||!quotedInDocument(evidence,doc.text))continue;const key=matrixKey(f.id,slot);if(S.ai[key]?.engine==='gemini'&&S.ai[key].evidence.length>=evidence.length)continue;S.ai[key]={status:suggest.status,evidence,match:evidence,engine:'gemini',literalTextMatch:!!suggest.literal_text_match,sourceVerified:false,interpretationVerified:false,sourceNo:doc.no};}done++;}catch(e){failed++;pending.add(`${k+1}: ${String(e.message||e).slice(0,110)}`);}}S.aiCoverage[slot]={done,failed,planned:chunks.length*Math.ceil(features.length/3),complete:!S.aiStop&&!pending.size,issues:[...pending],textChars:doc.text.length};if(S.aiStop)break;}$('aiProgress').textContent=`AI hoàn tất ${done}/${total} lượt, lỗi/chưa chạy ${failed}. Gợi ý vẫn cần chuyên gia đối chiếu với bản gốc. ${failed?'Không được coi phần chưa chạy là vắng mặt.':''}`;sortPriorByMachine(true);renderPrior();renderMatrix();}catch(e){notify('Không thực hiện được đối chiếu AI: '+String(e.message||e),true);}finally{S.aiBusy=false;$('aiAssist').disabled=false;}}
function cellSummary(){const counts={checked:0,proposed:Object.keys(S.ai).length,total:S.features.length*3};for(const x of Object.values(S.matrix))if(x.checked)counts.checked++;return counts;}
function evidenceByDocumentHtml(){
 const slots=['D1','D2','D3'].filter(slot=>S.prior[slot]?.no);if(!slots.length)return '<p>Chưa có D1–D3.</p>';
 if(!S.features.length)S.features=featuresFromClaims();
 return slots.map(slot=>{const d=S.prior[slot],stats=machineStats(slot);
 const hits=S.features.map(f=>{const r=S.matrix[matrixKey(f.id,slot)]||{},a=S.ai[matrixKey(f.id,slot)]||{};const checked=r.checked&&r.sourceNo===d.no;
 const quote=checked?r.quote:a.evidence||'',ok=quote&&quotedInDocument(quote,d.text);
 if(!ok)return '';const match=checked?r.quote:a.match||quote;
 return `<tr><td>${esc(f.id)}${f.affectedClaims?.length>1?`<br><small>Áp dụng: ${esc(f.affectedClaims.map(id=>'C'+id).join(', '))}</small>`:''}</td><td>${highlightSource(f.text,match)}</td><td>${esc(checked?'Chuyên gia: '+r.status:a.status==='Có'?'Máy: khớp nguyên văn':'Máy: có đoạn liên quan')}</td><td><div class="evidence-text">${highlightLiteral(quote,match)}</div></td><td>${esc(checked?r.location||'chưa rõ':a.location||'Vị trí theo bản web chưa xác minh')}</td></tr>`;}).filter(Boolean);
 return `<section class="dossier-source"><h3>${slot} · ${esc(d.no)} — ${stats.yes+stats.partial} đặc điểm có đoạn khớp/gợi ý</h3><p class="muted small">${esc(d.content_level||'Chưa rõ loại văn bản')} · ${esc(d.extractionWarning||'Chưa xác nhận toàn văn, ngày và hình vẽ')} · ${stats.reviewed} ô đã được chuyên gia rà soát.</p><div class="table-scroll"><table><thead><tr><th>Đặc điểm</th><th>Nội dung đầu vào</th><th>Phân loại tạm</th><th>Đoạn nguồn được tô nổi bật</th><th>Vị trí</th></tr></thead><tbody>${hits.join('')||'<tr><td colspan="5">Chưa phát hiện đoạn khớp trong phần văn bản hiện có. Không suy ra là không bộc lộ.</td></tr>'}</tbody></table></div><p>${d.url?`<a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">Kiểm tra bản gốc ${slot} ↗</a>`:'Chưa có liên kết gốc'}</p></section>`;
 }).join('');
}
function claimFeatureGroup(){const byId=new Map(S.features.map(f=>[f.id,f])),groups=new Map();if(S.keywordOnly){groups.set(0,S.features);return groups;}for(const c of S.claims)groups.set(c.id,(S.claimFeatureIds?.[c.id]||[]).map(id=>byId.get(id)).filter(Boolean));return groups;}
function assessClaim(claim){const group=claimFeatureGroup().get(claim.id)||[],slotResults=[];for(const slot of ['D1','D2','D3']){const d=S.prior[slot];if(!d?.no)continue;const statuses=group.map(f=>S.matrix[matrixKey(f.id,slot)]);const complete=statuses.length===group.length&&statuses.every(r=>r?.checked&&r.status==='Có'&&r.sourceNo===d.no);const dateKnown=!!(d.date&&d.dateChecked);const sameCombination=!!d.combinationClaims?.[claim.id];if(complete)slotResults.push({slot,no:d.no,dateKnown,sourceChecked:!!(d.sourceChecked&&d.docIdentityChecked),sameCombination});}const meta=S.claimDates[claim.id]||{};const targetVerified=!!(meta.date&&meta.verified&&$('claimInputVerified')?.checked)&&(!S.filename||!!S.pdf)&&!S.unread.length&&(!S.expectedClaims||S.claims.length>=S.expectedClaims)&&!claim.dependencyIssue&&!claim.needsReview;const candidate=targetVerified?slotResults.find(r=>r.dateKnown&&r.sourceChecked&&r.sameCombination&&S.prior[r.slot].date<meta.date):null;return {claimId:claim.id,group:group.length,slotResults,candidate,targetVerified};}
function assessmentHtml(){
 const slots=['D1','D2','D3'].filter(s=>S.prior[s]?.no);
 const gaps=[];if(S.pdf&&S.unread.length)gaps.push(`${S.unread.length} trang PDF chưa đọc đủ`);
 if(S.claims.some(c=>c.needsReview||c.dependencyIssue))gaps.push('có claim bị nghi OCR dính hoặc quan hệ phụ thuộc chưa rõ; cần đối chiếu bản gốc');if(S.expectedClaims&&S.claims.length<S.expectedClaims)gaps.push(`chỉ phát hiện ${S.claims.length}/${S.expectedClaims} claims ghi trên bìa`);
 if(S.queryLog.some(x=>x.status==='ERROR'))gaps.push('một số lượt tìm kiếm bị lỗi');
 if(slots.some(slot=>['metadata_only','snippet_only','abstract_only','metadata'].includes(S.prior[slot].content_level)))gaps.push('có nguồn mới chứa metadata/snippet');
 if(slots.some(slot=>S.prior[slot].extractionWarning))gaps.push('một số bản mô tả chưa xác minh toàn văn');
 let findings='';
 if(S.keywordOnly){findings='<p><strong>Khảo sát ý tưởng / keyword:</strong> chỉ tìm và so sánh những concept đã nhận diện. Không có claims hợp lệ để xác định tính mới hoặc trình độ sáng tạo theo yêu cầu bảo hộ.</p>';}
 else {
   const groups=claimFeatureGroup();findings=S.claims.map(claim=>{
    const fs=groups.get(claim.id)||[];
    const ranked=slots.map(slot=>({slot,d:S.prior[slot],n:fs.filter(f=>{const a=S.ai[matrixKey(f.id,slot)],r=S.matrix[matrixKey(f.id,slot)];return r?.checked&&r.sourceNo===S.prior[slot].no&&r.status==='Có'||a?.status==='Có'&&a.evidence&&quotedInDocument(a.evidence,S.prior[slot].text);}).length,
    related:fs.filter(f=>{const a=S.ai[matrixKey(f.id,slot)];return a?.evidence&&quotedInDocument(a.evidence,S.prior[slot].text);}).length})).sort((a,b)=>b.n-a.n||b.related-a.related);
    const best=ranked[0],parserUncertain=!!(claim.needsReview||claim.dependencyIssue||(S.expectedClaims&&S.claims.length<S.expectedClaims)||(S.pdf&&S.unread.length)),allExact=!!(!parserUncertain&&best&&fs.length&&best.n===fs.length),first=best?.d?.no||'chưa có', missing=fs.length-(best?.related||0);
    const novelty=parserUncertain?`Nội dung/ranh giới claims chưa được xác minh đủ từ PDF gốc, chỉ hiển thị đoạn gợi ý để kiểm tra; <strong>chưa đủ cơ sở đưa ra cảnh báo mất tính mới theo claim này.</strong>`:allExact?`Tài liệu ${esc(best.slot)} (${esc(first)}) có đoạn trùng chữ cho toàn bộ ${fs.length} đặc điểm tách được. <strong>Cảnh báo sơ bộ nguy cơ thiếu tính mới</strong>; CHƯA kiểm tra cùng tổ hợp, ngày hiệu lực, ngữ nghĩa và phần OCR chưa đọc.`:`Chưa tìm thấy trong D1–D3 đã nạp một tài liệu có câu trích trực tiếp cho toàn bộ ${fs.length} đặc điểm (${missing} đặc điểm chưa có đoạn liên quan ở nguồn ưu tiên). <strong>Chưa đủ cơ sở khẳng định có tính mới</strong>, cũng không được suy ra đặc điểm vắng mặt.`;
    const inventive=ranked.length>1&&ranked.slice(1).some(x=>x.related>0)?'Các D2/D3 có đoạn liên quan bổ sung; cần kiểm tra tác dụng kỹ thuật và lý do kết hợp theo quy định áp dụng. <strong>Chưa đủ cơ sở kết luận trình độ sáng tạo.</strong>':'Chưa có căn cứ về khả năng kết hợp tài liệu hay hiệu quả kỹ thuật; <strong>chưa đủ cơ sở kết luận trình độ sáng tạo.</strong>';
    return `<section class="notice"><strong>Claim ${claim.id} · nhận định máy (chưa duyệt)</strong><p><b>Tính mới:</b> ${novelty}</p><p><b>Trình độ sáng tạo:</b> ${inventive}</p></section>`;
   }).join('');
 }
 return `${findings}<p class="muted small">Đã so sánh ${S.features.length} đặc điểm/concept; ${slots.length} tài liệu được chọn. ${gaps.length?'<strong>Giới hạn: '+esc(gaps.join(' · '))+'.</strong>':'Chưa có bằng chứng hệ thống đã tra cứu hết các nguồn và xác minh hình vẽ.'} Đây là bản nháp của máy, không phải quyết định cấp bằng hoặc ý kiến pháp lý.</p>`;
}
function renderCombinationChecks(){if(S.keywordOnly)return '';return S.claims.map(c=>`<details><summary>Claim ${c.id} · kiểm tra quan hệ trong cùng một tài liệu (tùy khi có bằng chứng)</summary>${['D1','D2','D3'].map(slot=>{const d=S.prior[slot];if(!d?.no)return '';return `<label class="check"><input type="checkbox" data-combine="${esc(slot)}" data-claim="${c.id}" ${d.combinationClaims?.[c.id]?'checked':''}> Tôi đã đối chiếu bản gốc: ${slot} bộc lộ các giới hạn Claim ${c.id} trong <strong>cùng tổ hợp</strong>, không ghép từ tài liệu khác.</label>`}).join('')}</details>`).join('');}
function renderReport(){
 if(!S.features.length)S.features=featuresFromClaims();
 $('claimDatesReview').innerHTML='';
 $('conclusion').innerHTML=assessmentHtml()+'<h3>D1 → D3: các điểm trùng tìm được</h3><p class="muted small">Máy tự lập bảng từ văn bản đã nạp, không cần chuyên gia duyệt từng ô để tạo báo cáo. Màu đánh dấu là chuỗi trùng, không phải xác nhận bộc lộ toàn bộ giới hạn kỹ thuật.</p>'+evidenceByDocumentHtml();
 $('expertNote').value=S.expertNote;$('expertSignoff').checked=S.signed;$('reportPreview').innerHTML=S.reportHtml;
}
function reportCreate(){
 S.expertNote=$('expertNote').value.trim();S.signed=$('expertSignoff').checked;
 if(!S.features.length)S.features=featuresFromClaims();
 const slots=['D1','D2','D3'].filter(s=>S.prior[s]?.no),sourceRows=slots.map(slot=>{const d=S.prior[slot];return `<tr><td>${slot}</td><td>${esc(d.no)}</td><td>${esc(d.date||'chưa xác minh')}</td><td>${esc(d.content_level||'chưa rõ')}</td><td>${d.url?`<a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">Mở nguồn ↗</a>`:'Chưa có'}</td></tr>`;}).join('');
 S.reportHtml=`<h2>PatentLens AI · Báo cáo ${S.signed?'(đã ghi nhận chuyên gia xem)':'(DỰ THẢO MÁY — CHƯA DUYỆT)'}</h2><p>Đầu vào: ${esc(S.filename||'văn bản được cung cấp')} · ${S.keywordOnly?'Chế độ keyword-only':'Claims: '+S.claims.length} · Ngày tạo: ${esc(new Date().toLocaleString('vi-VN'))}</p><h3>Nhận định ban đầu</h3>${assessmentHtml()}<h3>Ba nguồn ưu tiên</h3><table><thead><tr><th>Thứ tự</th><th>Mã công bố</th><th>Ngày công bố</th><th>Độ phủ nội dung lấy được</th><th>Nguồn</th></tr></thead><tbody>${sourceRows}</tbody></table><h3>D1 → D3: đoạn trùng được đánh dấu</h3>${evidenceByDocumentHtml()}<p><small>Đặc điểm kế thừa chỉ hiển thị một lần theo nguồn gốc. Phân tích từng claim vẫn tính đầy đủ các giới hạn kế thừa. Bảng D1–D3 phía trên phân biệt trạng thái máy/chuyên gia ở từng đoạn.</small></p><h3>Nhận xét chuyên gia (tùy chọn)</h3><p>${esc(S.expertNote||'Chưa có.')}</p><p>${S.signed?'Người dùng đã đánh dấu đã xem; không có xác thực danh tính/chữ ký số.':'Chưa có xác nhận chuyên gia.'}</p><p><strong>Phạm vi:</strong> Các trang OCR lỗi, bản vẽ, trích xuất thiếu toàn văn, ngày ưu tiên và mức bao phủ tìm kiếm phải kiểm tra bằng bản gốc. Trùng thuật ngữ không đồng nghĩa bộc lộ đầy đủ một claim. Kết quả không thay thế ý kiến pháp lý hoặc đánh giá trình độ sáng tạo của chuyên gia.</p>`;
 $('reportPreview').innerHTML=S.reportHtml;notify('Đã tạo báo cáo dự thảo tự động; chuyên gia chỉ cần đọc và ghi nhận xét nếu muốn.');
}
function fileDownload(name,content,type){const blob=new Blob([content],{type}),href=URL.createObjectURL(blob),a=document.createElement('a');a.href=href;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),1000);}
function exportHtml(){if(!S.reportHtml)reportCreate();fileDownload('PatentLens_report.html','<!doctype html><html lang="vi"><meta charset="utf-8"><title>PatentLens Research</title><style>body{font:13px/1.6 Arial;margin:32px;color:#222}table{border-collapse:collapse;width:100%}td,th{border:1px solid #aaa;padding:6px;vertical-align:top}h2{border-bottom:1px solid #555}@media print{body{margin:12mm}}</style>'+S.reportHtml,'text/html;charset=utf-8');}
function exportCsv(){const rows=[['ID','Feature/concept','Claim','Nguồn','AI gợi ý','Chuyên gia xác nhận','Trích dẫn','Vị trí','Nhận xét']];for(const f of S.features)for(const slot of ['D1','D2','D3']){const r=S.matrix[matrixKey(f.id,slot)]||{},a=S.ai[matrixKey(f.id,slot)]||{};rows.push([f.id,f.text,f.claimId||'',slot,a.status||'',r.checked?r.status:'CHƯA DUYỆT',r.quote||'',r.location||'',r.note||'']);}const csv='\ufeff'+rows.map(cols=>cols.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');fileDownload('PatentLens_matrix.csv',csv,'text/csv;charset=utf-8');}
function saveDraft(){const data={schema:'patentlens-v39',mode:S.mode,source:S.source,filename:S.filename,fileMeta:S.fileMeta,pagesAudit:S.pages.map(p=>({page:p.page,length:p.text.length,status:p.status})),unread:S.unread,claims:S.claims,keywordOnly:S.keywordOnly,route:S.route,concepts:S.concepts,queries:S.queries,queryLog:S.queryLog,candidates:S.candidates,prior:S.prior,features:S.features,matrix:S.matrix,ai:S.ai,aiCoverage:S.aiCoverage,expertNote:S.expertNote,signed:S.signed,when:new Date().toISOString()};fileDownload('PatentLens_nhap_v39.json',JSON.stringify(data,null,2),'application/json;charset=utf-8');notify('Đã lưu JSON nháp vào máy, KHÔNG gồm PDF gốc và chưa mã hóa. Không gửi nháp chứa hồ sơ mật.');}
async function openDraft(file){if(!file)return;try{const data=JSON.parse(await file.text());if(data.schema!=='patentlens-v39')throw Error('Chỉ hỗ trợ nháp v39; không tự tin vào dữ liệu quyết định cũ từ phiên bản khác.');S.mode=data.mode||'prospective';S.source=String(data.source||'');S.filename=data.filename||'';S.fileMeta=data.fileMeta||null;S.pages=[];S.unread=[...(data.unread||[])];S.pdf=null;S.claims=parseStructuredClaims(S.source);S.keywordOnly=!S.claims.length;S.claimDates={};S.route=null;S.concepts=[];S.queries=data.queries||[];S.queryLog=data.queryLog||[];S.candidates=data.candidates||[];S.prior=data.prior||{D1:null,D2:null,D3:null};for(const d of Object.values(S.prior))if(d){d.sourceChecked=false;d.dateChecked=false;d.docIdentityChecked=false;d.combinationClaims={};}S.features=[];S.claimFeatureIds={};S.matrix={};S.ai={};S.aiCoverage={};S.expertNote=data.expertNote||'';S.signed=false;S.reportHtml='';$('sourceText').value=S.source;$('fileName').textContent=S.filename?'Nháp tham chiếu PDF: '+S.filename+' (cần nạp lại để kiểm tra)':'Đã mở văn bản trong nháp';$('ingestState').textContent='Đã mở nháp; mọi bằng chứng và ngày từ JSON phải được kiểm tra lại. Các xác nhận cũ đã xóa khỏi ma trận.';document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('selected',b.dataset.mode===S.mode));if(S.filename)S.unread=S.unread.length?S.unread:['Cần nạp lại PDF gốc'];stepShow(0);notify('Đã mở nháp. Tải lại PDF bản gốc và xác nhận nguồn trước khi dùng kết quả nghiên cứu.');}catch(e){notify('Không mở được nháp: '+String(e.message||e),true);}}
/* PDF input: read every available text layer with page-level exceptions and yield to UI.
   OCR scanned/weak pages explicitly, never declare them complete prematurely. */
const PDFJS_URL='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
let pdfLibPromise=null;
function loadScript(url){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=url;s.onload=resolve;s.onerror=()=>reject(Error('Không tải được thư viện từ '+url));document.head.appendChild(s);});}
async function pdfLibrary(){if(!pdfLibPromise)pdfLibPromise=(async()=>{if(!window.pdfjsLib)await loadScript(PDFJS_URL);if(!window.pdfjsLib)throw Error('Không có PDF.js');pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';return window.pdfjsLib;})();return pdfLibPromise;}
function readPageText(content){let text='';for(const it of content.items||[]){const piece=String(it.str||'');if(!piece)continue;text+=piece;if(it.hasEOL)text+='\n';else if(!/\s$/.test(piece))text+=' ';}return text.replace(/[ \t]+\n/g,'\n').normalize('NFC');}
function refreshInputPageState(){S.unread=S.pages.filter(p=>p.status!=='text'&&p.status!=='ocr').map(p=>p.page);const total=S.pdf?.numPages||S.pages.length,done=S.pages.filter(p=>p.status==='text'||p.status==='ocr').length;$('pageAudit').textContent=S.pdf?`${done}/${total} trang có nội dung chữ · ${S.unread.length} trang chưa đọc đủ / bị lỗi.${S.expectedClaims?' Văn bản đầu vào nêu '+S.expectedClaims+' claims; máy mới nhận '+S.claims.length+'.':''} Phần hình vẽ, công thức và bảng vẫn cần đối chiếu bản PDF gốc.`:'';$('ocrMissing').hidden=!S.pdf||!S.unread.length||S.pdfBusy;$('ocrClaims').hidden=!S.pdf||!S.unread.length||S.pdfBusy||!(S.expectedClaims>S.claims.length||!S.claims.length);$('ocrAll').hidden=!S.pdf||S.unread.length<=8||S.pdfBusy;$('stopPdf').hidden=!S.pdfBusy;}
async function readPdfFile(file){if(!file)return;if(!/\.pdf$/i.test(file.name)&&file.type!=='application/pdf')return notify('Hiện tại trang này chỉ hỗ trợ PDF hoặc dán văn bản. Không tự coi DOCX/ảnh là đã đọc.',true);S.pdfAbort=false;S.pdfBusy=true;S.pdf=null;S.pages=[];S.unread=[];S.uploadId++;S.ocrToken++;invalidate(1);S.source='';S.claims=[];S.keywordOnly=true;$('claimsPreview').innerHTML='';$('searchQueries').value='';S.fileMeta={name:file.name,size:file.size};S.filename=file.name;$('fileName').textContent=`${file.name} · ${(file.size/1024/1024).toFixed(1)} MB`;$('sourceText').value='';$('ingestState').textContent='Đang mở PDF và đọc lớp chữ theo trang...';$('ingestProgress').style.width='1%';refreshInputPageState();const generation=S.revision,uploadId=S.uploadId;
 try{const lib=await pdfLibrary();const buffer=await file.arrayBuffer();if(S.pdfAbort)return;const pdf=await lib.getDocument({data:new Uint8Array(buffer)}).promise;S.pdf=pdf;S.pages=Array.from({length:pdf.numPages},(_,i)=>({page:i+1,text:'',status:'pending'}));refreshInputPageState();for(let i=0;i<pdf.numPages;i++){
  if(S.pdfAbort||generation!==S.revision||uploadId!==S.uploadId)break;const record=S.pages[i];try{const page=await Promise.race([pdf.getPage(i+1),new Promise((_,reject)=>setTimeout(()=>reject(Error('Trang tải quá 25 giây')),25000))]);const content=await Promise.race([page.getTextContent(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Lớp chữ trang quá 25 giây')),25000))]);const text=readPageText(content);record.text=text;record.status=text.replace(/\s/g,'').length>=45?'text':'weak';page.cleanup();}catch(e){record.status='error';record.error=String(e.message||e);}
  const finished=i+1;$('ingestProgress').style.width=Math.round(finished/pdf.numPages*100)+'%';$('ingestState').textContent=`Đọc lớp chữ PDF: trang ${finished}/${pdf.numPages} · ${S.pages.filter(p=>p.status==='text').length} trang có chữ, chưa OCR trang scan.`;if(finished%3===0||finished===pdf.numPages){refreshInputPageState();await new Promise(requestAnimationFrame);}
 }
 if(S.pdfAbort||uploadId!==S.uploadId||generation!==S.revision){if(uploadId===S.uploadId)$('ingestState').textContent='Đã dừng đọc PDF; cần mở lại để kiểm tra các trang còn thiếu.';return;}const text=S.pages.map(p=>p.text?'[TRANG '+p.page+']\n'+p.text:'').filter(Boolean).join('\n\n');if(text.trim())setInput(text,file.name);else notify('Không trích được chữ từ PDF. Hãy dùng OCR bổ sung ở các trang cần đọc.',true);$('ingestState').textContent=S.pdfAbort?`Đã dừng ở ${S.pages.filter(p=>p.status!=='pending').length}/${pdf.numPages} trang. Chưa đọc đủ; mở lại PDF hoặc OCR phần còn thiếu.`:`Đã kiểm tra lớp chữ ${pdf.numPages} trang · ${S.unread.length} trang cần OCR/kiểm tra. ${S.claims.length?'Nhận diện '+S.claims.length+' claims.':S.unread.length?'Chưa thể xác định đủ claims: còn trang cần OCR.':'Không nhận diện được claims có cấu trúc trong văn bản đã đọc.'}`;
 }catch(e){notify('Không mở/đọc được PDF: '+String(e.message||e)+'. Có thể thử dán văn bản hoặc gửi file PDF gốc để kiểm tra.',true);$('ingestState').textContent='Đọc PDF thất bại; không đánh dấu đã hoàn tất.';}finally{if(uploadId===S.uploadId){S.pdfBusy=false;refreshInputPageState();}}}
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
async function ocrMissingPages(all=false){
  if(!S.pdf||S.pdfBusy)return;
  const sourcePdf=S.pdf,uploadId=S.uploadId,token=++S.ocrToken;
  S.pdfAbort=false;S.pdfBusy=true;refreshInputPageState();let worker=null,processed=0,errors=0;
  const candidates=S.pages.filter(p=>p.status!=='text'&&p.status!=='ocr');
  const work=all===true?candidates:all==='claims'?candidateClaimsOcrOrder(candidates).slice(0,18):candidates.slice(0,8);
  const cancelled=()=>S.pdfAbort||S.pdf!==sourcePdf||S.uploadId!==uploadId||S.ocrToken!==token;
  try{
    if(!work.length)return;
    $('ingestState').textContent=`Chuẩn bị OCR ${work.length} trang có chữ yếu hoặc ảnh…`;
    const t=await tesseractLibrary();
    worker=await t.createWorker('vie+eng',1,{});await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:'3'});
    for(let i=0;i<work.length;i++){
      if(cancelled())break;
      const item=work[i];let page=null,canvas=null;
      $('ingestState').textContent=`Đang OCR trang ${item.page}/${sourcePdf.numPages} · lượt ${i+1}/${work.length} · ${processed} trang có kết quả. Có thể dừng sau trang hiện tại.`;
      try{
        page=await sourcePdf.getPage(item.page);
        const vp=page.getViewport({scale:1.85});
        // On huge pages lower resolution instead of crashing the whole PDF job.
        const pixelScale=Math.min(1,Math.sqrt(5500000/Math.max(1,vp.width*vp.height)));
        const final=page.getViewport({scale:1.85*pixelScale});
        canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.floor(final.width));canvas.height=Math.max(1,Math.floor(final.height));
        await page.render({canvasContext:canvas.getContext('2d'),viewport:final}).promise;
        const response=await worker.recognize(canvas);const text=String(response.data?.text||'').normalize('NFC');
        if(text.replace(/\s/g,'').length>=35){item.text=text;item.status='ocr';item.error='';processed++;}
        else{item.status='weak';item.error='OCR không đọc được đủ chữ; kiểm tra trang PDF gốc.';errors++;}
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
    $('ingestState').textContent=`OCR xong ${processed}/${work.length} trang chọn quét; ${errors} trang lỗi/chữ yếu. Còn ${S.unread.length} trang chưa đọc đủ; ${S.claims.length} claim có cấu trúc${S.expectedClaims?' / '+S.expectedClaims+' claim ghi trên bìa':''}. ${S.unread.length?'Không coi PDF đã đọc đủ; có thể quét tiếp.':'Hình vẽ và ngữ nghĩa vẫn cần kiểm tra bản gốc.'}`;
  }catch(e){notify('OCR không thực hiện được: '+String(e.message||e)+'. Vẫn giữ trang chưa đọc, không đánh dấu hoàn tất.',true);}
  finally{try{await worker?.terminate();}catch{}if(S.pdf===sourcePdf&&S.uploadId===uploadId){S.pdfBusy=false;refreshInputPageState();}}
}

function validateNext(){if(S.stage===0)return inputDataRequired();if(S.stage===1){if(!S.route)renderRoute();return !!S.source.trim();}if(S.stage===2){if(!['D1','D2','D3'].some(slot=>S.prior[slot]?.no)){notify('Chưa có D1–D3 để so sánh. Hãy tìm hoặc nhập ít nhất một tài liệu công khai.',true);return false;}return true;}return true;}
function bind(){stepShow(0);document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{S.mode=b.dataset.mode;document.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('selected',x===b));});$('claimInputVerified').onchange=()=>{S.reportHtml='';renderReport();};$('useText').onclick=()=>{S.pdfAbort=true;S.uploadId++;S.ocrToken++;S.pdf=null;S.pages=[];S.unread=[];S.pdfBusy=false;S.fileMeta=null;setInput($('sourceText').value);$('pageAudit').textContent='Đầu vào là văn bản dán, không có PDF gốc để xác minh.';};$('pdfFile').onchange=e=>readPdfFile(e.target.files?.[0]);$('stopPdf').onclick=()=>{S.pdfAbort=true;$('ingestState').textContent='Đang dừng sau trang hiện tại...';};$('ocrMissing').onclick=()=>ocrMissingPages(false);$('ocrClaims').onclick=()=>ocrMissingPages('claims');$('ocrAll').onclick=()=>{if(confirm('OCR toàn bộ '+S.unread.length+' trang còn thiếu có thể rất chậm, nhất là PDF 70+ trang. Có tiến độ trang và có thể bấm Dừng; chưa đọc hết thì không thể kết luận theo claims. Tiếp tục?'))ocrMissingPages(true);};$('back').onclick=()=>stepShow(S.stage-1);$('next').onclick=()=>{if(S.stage===4){reportCreate();return;}if(!validateNext())return;stepShow(S.stage+1);};$('searchQueries').addEventListener('input',renderSourceLinks);$('runSearch').onclick=runSearch;$('stopSearch').onclick=()=>S.searchAbort?.abort();$('autoPick').onclick=autoReadAndRank;$('aiAssist').onclick=runAi;$('makeReport').onclick=reportCreate;$('exportHtml').onclick=exportHtml;$('exportCsv').onclick=exportCsv;$('saveDraft').onclick=saveDraft;$('openDraft').onchange=e=>openDraft(e.target.files?.[0]);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
