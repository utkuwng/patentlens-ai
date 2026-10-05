/* PatentLens keyword extractor v59 (core-key lineage from v55).
 * Goal: produce a SMALL set of CORE SEARCH KEYS from the actual patent content.
 *
 * Design principles:
 * - Search keys come from Title / Abstract / independent claims first.
 * - Dependent claims are supporting context only.
 * - Description/body is a fallback, not the primary source.
 * - Relationship clauses and claim-reference wording are stripped before scoring.
 * - We prefer technical noun phrases / component names, not full drafting sentences.
 * - Search stage keeps all returned keys as a document fingerprint, but only anchor/feature keys build retrieval bundles.
 * - Short generic terms remain supporting signals; they are not searched alone.
 */
(function(root){
  'use strict';

  const PILLARS={
    process_product:{name:'Quy trình sản phẩm'},
    information_technology:{name:'Công nghệ thông tin'},
    system_device:{name:'Hệ thống/thiết bị'}
  };

  const TOKEN=/[\p{L}\p{N}]+(?:[-\/][\p{L}\p{N}]+)*/gu;
  const VI_DIAC=/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi;
  const VI_CHAR=/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

  const EN_STOP=new Set(('a an and are as at be been being but by can could did do does for from had has have having how if in into is it its may might more most not of on onto or other our over per should so some such than that the their them then there these they this those through thus to under up upon use used using was we were what when where which while who will with within without would also each any all both between during about after before said according wherein whereby thereof therein herein first second third one two three plurality least example examples preferably particular described provided thereby further another various several present invention embodiment embodiments claim claims fig figure figures').split(' '));
  const VI_STOP=new Set(('và hoặc của cho với trong ngoài trên dưới từ đến tại theo sau trước do này đó kia một các những được bị là có không bởi để khi nếu thì mà như cũng đã sẽ đang rất hơn nhất cả mỗi mọi nhiều ít đều vẫn còn chỉ lại ra vào lên xuống qua giữa về bằng nên vì tuy song hay cùng nhau thế đây đấy ấy nào gì sao đâu ở gồm thứ hình ví dụ mô tả kèm yêu cầu bảo hộ sáng chế người sử dụng điểm khoản').split(' '));

  // Generic patent words are useful for parsing but poor search anchors by themselves.
  const GENERIC=new Set(('method methods system systems device devices apparatus process processes unit module member part element invention claim claims phương pháp hệ thống thiết bị quy trình thành phần bộ phận phần tử chi tiết vật vật dụng đối tượng cấu kiện invention embodiment embodiments example examples').split(' '));

  // Spatial / relational / drafting language. A key made mostly from these words is low value.
  const LOW_INFO_VI=new Set(('làm thích ứng phù hợp nhằm sao cho nằm đặt bố trí cấu hình kéo dài kéo ra hướng phía bên đầu xa gần ngang dọc chéo cách tháo lắp nối thông trạng thái kết thúc bắt đầu tỳ đỡ tương ứng lần lượt có thể khoảng trống bên trong').split(' '));
  const LOW_INFO_EN=new Set(('adapted configured arranged extending extend distal proximal horizontal vertical aligned spaced removable removably connected state end side direction suitable located positioned retained holding support supporting first second plurality respectively inner space').split(' '));
  const EDGE_STOP=new Set([...EN_STOP,...VI_STOP,'hai','ba','bốn','nhiều','first','second','third'].map(x=>String(x).toLowerCase()));

  const EN_HINT=new Set(('the and of to in for with from by is are was were as on into through using wherein comprising includes configured method system device process data input output control assembly member housing connector circuit sensor').split(' '));
  const VI_HINT=new Set(('và của trong được cho với là có từ bằng theo gồm một các những để khi quy trình phương pháp hệ thống thiết bị dữ liệu đầu vào đầu ra điều khiển cụm kết cấu lắp ráp').split(' '));

  const fold=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();
  const VI_HINT_FOLD=new Set([...VI_HINT].map(fold));
  const VI_STOP_FOLD_SAFE=new Set('va cua cho voi trong ngoai tren duoi tu den tai theo truoc do mot cac nhung duoc bi la co khong boi de khi neu thi ma nhu cung da se dang rat hon nhat moi nhieu it deu van con chi lai ra vao len xuong qua giua ve bang nen vi tuy song hay dau o gom thu hinh vi du mo ta kem yeu cau bao ho sang che nguoi su dung diem khoan'.split(' '));

  function mojibakeScore(s){return (String(s||'').match(/(?:Ã.|Â.|â€|ï»¿|�)/g)||[]).length;}
  function repairMojibake(s){
    const t=String(s||''); if(!mojibakeScore(t))return t;
    try{
      const bytes=Uint8Array.from([...t].map(ch=>ch.charCodeAt(0)&255));
      const fixed=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      return mojibakeScore(fixed)<mojibakeScore(t)?fixed:t;
    }catch{return t;}
  }

  function likelyVietnamese(t){
    const s=String(t||''),tokens=(s.toLowerCase().match(/[\p{L}]+/gu)||[]).slice(0,5000);
    let score=(s.match(VI_DIAC)||[]).length*0.55;
    for(const tok of tokens){if(VI_HINT.has(tok)||VI_HINT_FOLD.has(fold(tok)))score+=1;}
    return score>=3;
  }

  function repairVietnameseOcrFunctionWords(text){
    if(!likelyVietnamese(text))return text;
    return String(text||'')
      .replace(/(^|\s)dé(?=\s|$)/giu,'$1để')
      .replace(/(^|\s)dể(?=\s|$)/giu,'$1để')
      .replace(/(^|\s)đ\s+ể(?=\s|$)/giu,'$1để')
      .replace(/(^|\s)đ\s+ược(?=\s|$)/giu,'$1được')
      .replace(/(^|\s)tr\s+ong(?=\s|$)/giu,'$1trong');
  }

  function cleanText(s){
    let t=repairMojibake(String(s||''));
    t=t.replace(/\uFEFF|\u00AD/g,'').replace(/[\u200B-\u200D\u2060]/g,'').replace(/ﬁ/g,'fi').replace(/ﬂ/g,'fl').normalize('NFKC').normalize('NFC');
    t=t.replace(/([\p{L}])-[ \t]*\n[ \t]*([\p{L}])/gu,'$1$2');
    t=t.replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').replace(/[ \t]{2,}/g,' ').replace(/\n{4,}/g,'\n\n\n');
    t=repairVietnameseOcrFunctionWords(t);
    return t.trim();
  }

  function detectLanguage(text){
    const t=cleanText(text),tokens=(t.toLowerCase().match(/[\p{L}]+/gu)||[]).slice(0,12000);
    let vi=0,en=0;vi+=Math.min(24,(t.match(VI_DIAC)||[]).length*0.8);
    for(const tok of tokens){const f=fold(tok);if(VI_HINT.has(tok)||VI_HINT_FOLD.has(f))vi+=1.7;if(EN_HINT.has(f))en+=1.25;}
    const latin=t.match(/[A-Za-z]/g)?.length||0,letters=t.match(/[\p{L}]/gu)?.length||0;if(tokens.length>12&&letters&&latin/letters>0.80)en+=2.4;
    const total=vi+en;let primary='unknown';if(total>=3){if(vi>en*1.35)primary='vi';else if(en>vi*1.35)primary='en';else primary='mixed';}
    return {primary,viScore:+vi.toFixed(1),enScore:+en.toFixed(1),confidence:total?+(Math.abs(vi-en)/total).toFixed(2):0};
  }

  function detectPhraseLanguage(text,documentLanguage='unknown'){
    const s=cleanText(text),tokens=(s.toLowerCase().match(/[\p{L}]+/gu)||[]);
    if(VI_CHAR.test(s))return {primary:'vi',confidence:.98};
    const viHints=tokens.filter(x=>VI_HINT_FOLD.has(fold(x))).length,enHints=tokens.filter(x=>EN_HINT.has(fold(x))).length;
    if(tokens.length<=6){if(documentLanguage==='vi'&&enHints<2)return {primary:'vi',confidence:.78};if(documentLanguage==='en'&&viHints<2)return {primary:'en',confidence:.78};}
    const d=detectLanguage(s);if(d.primary==='unknown'&&['vi','en'].includes(documentLanguage))return {primary:documentLanguage,confidence:.55};return d;
  }

  function isEdgeStop(tok){
    const raw=String(tok||'').toLowerCase(),f=fold(raw),hasVi=VI_CHAR.test(raw);
    return EDGE_STOP.has(raw)||EN_STOP.has(f)||VI_STOP.has(raw)||(!hasVi&&VI_STOP_FOLD_SAFE.has(f));
  }
  function isLowInfo(tok){const raw=String(tok||'').toLowerCase(),f=fold(raw);return LOW_INFO_VI.has(raw)||LOW_INFO_VI.has(f)||LOW_INFO_EN.has(f)||GENERIC.has(raw)||GENERIC.has(f);}
  function informationCount(tokens){return tokens.filter(t=>!isEdgeStop(t)&&!isLowInfo(t)&&!/^[0-9]+$/.test(t)).length;}

  function patentSections(text){
    const t=cleanText(text);let title='',abstract='';
    const titlePatterns=[/(?:^|\n)\s*\(\s*54\s*\)\s*([^\n]+(?:\n(?!\s*\(\s*\d{2}\s*\))[^\n]*){0,2})/iu,/(?:^|\n)\s*(?:title|tên\s+sáng\s+chế)\s*[:\-]?\s*([^\n]{8,300})/iu];
    for(const rx of titlePatterns){const m=t.match(rx);if(m){title=cleanText(m[1]).replace(/\s+/g,' ').slice(0,420);break;}}
    const absMarkers=[/\(\s*57\s*\)\s*(?:ABSTRACT\s*)?([\s\S]{30,2200}?)(?=\n\s*\f|\n\s*\(\s*\d{2}\s*\)|\n\s*(?:claims?|description|yêu cầu bảo hộ)\b)/iu,/(?:^|\n)\s*(?:abstract|tóm\s+tắt)\s*[:\-]?\s*([\s\S]{30,2200}?)(?=\n\s*(?:claims?|description|mô tả|yêu cầu bảo hộ)\b|$)/iu];
    for(const rx of absMarkers){const m=t.match(rx);if(m){abstract=cleanText(m[1]).replace(/\s+/g,' ').slice(0,2200);break;}}
    return {title,abstract};
  }

  function boilerplate(term){
    const f=fold(term);
    return /(?:cong ty|so huu tri tue|ban mo ta|bang doc quyen|cong hoa xa hoi|cuc so huu|tac gia|chu don|patent application|present invention|embodiment|claim\s*\d|nguoi su dung|thong so ky thuat|tom tat|abstract|ten sang che|title)/i.test(f);
  }

  function stripClaimReferences(s){
    return cleanText(s)
      .replace(/\b(?:theo\s+)?(?:yêu\s+cầu\s+bảo\s+hộ|claim|điểm|khoản)\s*\d+(?:\s*[-–,]\s*\d+)*(?:\s*(?:và|hoặc|and|or)\s*\d+)?\b/giu,' ')
      .replace(/\b(?:theo|according\s+to)\s+(?:điểm|claim|khoản)?\s*\d+\b/giu,' ')
      .replace(/\s+/g,' ').trim();
  }

  // Split full patent drafting clauses into technical noun chunks.
  // We deliberately split on RELATIONS, not on domain nouns.
  const RELATION_SPLIT=/\s+(?:trong\s+đó|wherein|whereby|đề\s+cập\s+đến|liên\s+quan\s+đến|relates?\s+to|dùng\s+(?:để|cho|trong)|used\s+(?:for|in)|bao\s+gồm|gồm|comprising|comprises|including|includes|còn\s+có|có\s+thể|có|xác\s+định|định\s+nghĩa|defines?|được\s+làm\s+thích\s+ứng\s+để|làm\s+thích\s+ứng\s+để|được\s+cấu\s+hình\s+để|được\s+bố\s+trí\s+để|configured\s+to|adapted\s+to|arranged\s+to|gắn\s+vào|gắn\s+trong|gắn\s+với|mounted\s+(?:to|in|on)|móc\s+vào|hooked\s+to|kéo\s+dài\s+(?:theo|từ|đến|về)|extends?\s+(?:along|from|to|toward)|nằm\s+(?:trong|trên|dưới|giữa)|located\s+(?:in|on|between)|để|nhằm|sao\s+cho|such\s+that|so\s+that)\s+/iu;

  function trimPhraseTokens(tokens){
    let arr=[...tokens];
    while(arr.length&&(isEdgeStop(arr[0])||isLowInfo(arr[0])))arr.shift();
    while(arr.length&&isEdgeStop(arr[arr.length-1]))arr.pop();
    // Remove demonstratives / claim drafting residue from inside short phrases.
    arr=arr.filter((t,i)=>!['này','đó','kia','said','this','that'].includes(String(t).toLowerCase()) || i===arr.length-1);
    while(arr.length&&(isEdgeStop(arr[0])||isLowInfo(arr[0])))arr.shift();
    while(arr.length&&isEdgeStop(arr[arr.length-1]))arr.pop();
    return arr;
  }

  function tooGenericPhrase(term,toks){
    const f=fold(term),info=informationCount(toks);
    if(info<1)return true;
    if(toks.length===1)return true;
    if(/^(?:vat|vat dung|doi tuong|chi tiet|bo phan|thanh phan|lien ket|khoang trong|phia|dau xa|trang thai)(?:\s|$)/.test(f) && info<2)return true;
    if(/^(?:gan|moc|nam|keo dai|xac dinh|thich ung|lam thich ung|de gan|de giu|de huong|configured|adapted|mounted|extends?|located)(?:\s|$)/.test(f))return true;
    if(/(?:\bmot\s+vat\b|\btheo\s+diem\b|\btheo\s+claim\b)/.test(f))return true;
    // Search keys should usually contain at least two informative lexical items unless they are from Title.
    return false;
  }

  function canonicalPreference(a,b){
    // Prefer the spelling with proper Vietnamese diacritics when fold() is identical (e.g. dui/đui).
    const av=(String(a||'').match(VI_DIAC)||[]).length,bv=(String(b||'').match(VI_DIAC)||[]).length;
    if(av!==bv)return av>bv?a:b;
    return String(a||'').length>=String(b||'').length?a:b;
  }

  function addCandidate(map,phrase,weight,source,core=true){
    phrase=stripClaimReferences(phrase);
    let toks=(cleanText(phrase).toLowerCase().match(TOKEN)||[]);toks=trimPhraseTokens(toks);
    if(toks.length<2||toks.length>12)return;
    const term=toks.join(' ');
    if(term.length<5||term.length>120||boilerplate(term)||tooGenericPhrase(term,toks))return;
    const info=informationCount(toks);
    if(info<2)return;
    const key=fold(term),old=map.get(key)||{term,count:0,score:0,n:toks.length,source,info,core};
    old.term=canonicalPreference(old.term,term);
    old.count+=1;
    old.score+=weight*(1+Math.min(.55,info*.16))*(1+Math.min(.28,(toks.length-2)*.05));
    const rank={title:5,core_claims:4,abstract:3,support_claims:2,body:1};
    if((rank[source]||0)>(rank[old.source]||0))old.source=source;
    old.n=Math.max(old.n,toks.length);old.info=Math.max(old.info,info);old.core=old.core||core;map.set(key,old);
  }

  function nounChunks(text,weight,source,map,core=true){
    const src=cleanText(text);
    const clauses=src.split(/[\n\r,;:.!?()\[\]{}“”"•|]+/u).map(x=>x.trim()).filter(Boolean);
    for(let clause of clauses){
      clause=stripClaimReferences(clause).replace(/^\s*(?:claim|yêu cầu bảo hộ)?\s*\d+[.)\-:]?\s*/iu,'').trim();
      if(!clause)continue;
      // Repeatedly split relational clauses. This converts
      // "đui cắm xác định hốc gắn" -> "đui cắm" + "hốc gắn".
      const parts=clause.split(RELATION_SPLIT);
      for(const part of parts){
        const chunks=part.split(/\s+(?:và|hoặc|and|or)\s+/iu);
        for(const chunk of chunks){
          let c=stripClaimReferences(chunk);
          // If a relation verb remains at the start, keep its technical object rather than the verb.
          // e.g. “gắn thanh vòm mái che vào một vật” -> “thanh vòm mái che”.
          c=c.replace(/^\s*(?:gắn|giữ|móc|lắp|nối|đỡ|mounted?|holding|connecting|coupling)\s+(?:(?:vào|trong|trên|với|to|in|on|with)\s+)?/iu,'')
             .replace(/\s+(?:vào|với|trên|to|with|on)\s+(?:một\s+)?(?:vật|vật dụng|đối tượng|object|article)\s*$/iu,'')
             .trim();
          let toks=trimPhraseTokens((c.toLowerCase().match(TOKEN)||[]));
          if(toks.length<2)continue;
          // v55: NEVER create sliding n-grams from a long claim clause. That produced fragments such as
          // “soát lượng”, “kiểm soát tổng đầu”, “suất đủ của thiết bị gia…”.
          // Relation splitting above must yield a coherent technical phrase; if it is still too long,
          // keep it only when it is a compact clause (<=10 tokens). Otherwise skip it rather than invent fragments.
          if(toks.length<=12){addCandidate(map,toks.join(' '),weight,source,core);continue;}
        }
      }
    }
  }

  function sourceOccurrence(term,source){
    const f=fold(source),q=fold(term);if(!f||!q)return 0;let n=0,pos=0;while((pos=f.indexOf(q,pos))>=0){n++;pos+=Math.max(1,q.length);}return n;
  }

  function overlapRatio(a,b){
    const A=new Set(fold(a).split(/\s+/).filter(Boolean)),B=new Set(fold(b).split(/\s+/).filter(Boolean));
    const inter=[...A].filter(x=>B.has(x)).length;return inter/Math.max(1,Math.min(A.size,B.size));
  }

  function extract(text,opts={}){
    // v54 intentionally returns fewer, stronger CORE keys. Every returned key is still passed to search.
    const max=Math.max(6,Math.min(Number(opts.max)||12,14));
    const source=cleanText(text),coreBoost=cleanText(opts.coreBoost||opts.boost||''),supportBoost=cleanText(opts.supportBoost||''),sec=patentSections(source),map=new Map();

    // Core information first.
    if(sec.title)nounChunks(sec.title,10.0,'title',map,true);
    if(coreBoost)nounChunks(coreBoost,8.0,'core_claims',map,true);
    if(sec.abstract)nounChunks(sec.abstract,5.2,'abstract',map,true);
    if(supportBoost)nounChunks(supportBoost,1.8,'support_claims',map,false);

    // Only fall back to body when Title/Abstract/claims yielded too little.
    if(map.size<6)nounChunks(source.slice(0,14000),0.45,'body',map,false);

    const candidates=[];
    for(const v of map.values()){
      const occurrence=Math.max(v.count,sourceOccurrence(v.term,source)+sourceOccurrence(v.term,coreBoost)+sourceOccurrence(v.term,supportBoost));
      let score=v.score*(1+Math.min(.45,Math.log2(1+occurrence)*.16));
      if(v.source==='title')score*=1.55;else if(v.source==='core_claims')score*=1.35;else if(v.source==='abstract')score*=1.15;else if(v.source==='support_claims')score*=.72;else score*=.5;
      score*=1+Math.min(.22,(v.n-2)*.04)+Math.min(.22,v.info*.05);
      // Prefer actual core sources over description-only phrases.
      if(v.core)score*=1.12;
      candidates.push({...v,count:occurrence,score});
    }
    candidates.sort((a,b)=>b.score-a.score||b.info-a.info||b.n-a.n||b.term.length-a.term.length);

    const picked=[];
    for(const c of candidates){
      if(picked.length>=max)break;
      const cf=fold(c.term);let merged=false;
      for(let i=0;i<picked.length;i++){
        const p=picked[i],pf=fold(p.term),ratio=overlapRatio(c.term,p.term),nested=pf.includes(cf)||cf.includes(pf);
        // Remove drafting variants that express the same concept. Keep a shorter component only
        // when it is a genuinely distinct 2+ informative-token component and occurs independently.
        if((ratio>=.90 && Math.abs(c.n-p.n)<=1) || (nested && Math.abs(c.n-p.n)<=1)){
          const cBetter=(c.source==='title'&&p.source!=='title')||(c.source==='core_claims'&&!['title','core_claims'].includes(p.source))||c.score>p.score*1.12;
          if(cBetter)picked[i]=c;
          merged=true;break;
        }
      }
      if(!merged)picked.push(c);
    }

    // Second pass: remove shorter fragments already contained in a stronger, more informative phrase.
    // Title phrases are preserved because they are often the object anchor (e.g. “bình nóng lạnh”).
    const final=[];
    const sourceRank={title:5,core_claims:4,abstract:3,support_claims:2,body:1};
    for(const c of picked.sort((a,b)=>b.score-a.score)){
      const toks=(c.term.match(TOKEN)||[]),info=informationCount(toks);
      if(info<1)continue;
      const cf=fold(c.term);
      const covered=final.some(p=>{
        const pf=fold(p.term), nested=pf.includes(cf)||cf.includes(pf);
        if(!nested)return false;
        if(c.source==='title'&&p.source!=='title')return false;
        const pBetter=(sourceRank[p.source]||0)>=(sourceRank[c.source]||0) && (p.info||0)>=info && (p.n||0)>=(c.n||0);
        return pBetter && p.score>=c.score*.62;
      });
      if(covered)continue;
      final.push(c);if(final.length>=max)break;
    }

    const language=detectLanguage(source);
    // Assign a retrieval role. ALL keys remain in the document fingerprint, but only anchor/feature
    // keys are used to build search queries. Short generic terms are supporting signals only.
    let anchorAssigned=false;
    final.forEach((k,i)=>{
      k.id='kw-'+(i+1);k.score=Math.round(k.score*10)/10;k.cohesion=1;
      k.language=detectPhraseLanguage(k.term,language.primary).primary;
      if(k.source==='title'&&!anchorAssigned){k.searchRole='anchor';anchorAssigned=true;}
      else if(k.source==='title' && (k.n||0)>=3)k.searchRole='feature';
      else if(['core_claims','abstract'].includes(k.source) && (k.n||0)>=3 && (k.info||0)>=2)k.searchRole='feature';
      else k.searchRole='support';
      k.why=k.source==='title'?'Tên sáng chế':k.source==='core_claims'?'Yêu cầu bảo hộ độc lập':k.source==='abstract'?'Tóm tắt':k.source==='support_claims'?'Yêu cầu bảo hộ phụ thuộc':'Mô tả (fallback)';
    });
    if(!anchorAssigned&&final.length){final[0].searchRole='anchor';anchorAssigned=true;}
    return {keywords:final,language,stats:{chars:source.length,words:(source.match(TOKEN)||[]).length,title:sec.title,abstractChars:sec.abstract.length,extractor:'core-key-separate-v59'}};
  }

  root.PATENTLENS_KEYWORDS=Object.freeze({PILLARS,extract,fold,cleanText,detectLanguage,detectPhraseLanguage});
  if(typeof module!=='undefined'&&module.exports)module.exports=root.PATENTLENS_KEYWORDS;
})(typeof window!=='undefined'?window:globalThis);
