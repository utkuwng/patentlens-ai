/* PatentLens keyword extractor v53.
 * Goal: extract COMPLETE technical phrases from the current document.
 * - No domain keyword lexicon or preloaded technical synonyms.
 * - Avoids RAKE-like fragmenting at every stopword (the main cause of broken queries).
 * - Generic patent drafting / relational language is treated as low-information.
 * - Title, Abstract and parsed Claims are weighted above body text.
 * - Online bilingual translation is optional and happens later in worker.js.
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
  const VI_STOP=new Set(('và hoặc của cho với trong ngoài trên dưới từ đến tại theo sau trước do này đó kia một các những được bị là có không bởi để khi nếu thì mà như cũng đã sẽ đang rất hơn nhất cả mỗi mọi nhiều ít đều vẫn còn chỉ lại ra vào lên xuống qua giữa về bằng nên vì tuy song hay cùng nhau thế đây đấy ấy nào gì sao đâu ở gồm thứ hình ví dụ mô tả kèm yêu cầu bảo hộ sáng chế người sử dụng').split(' '));
  const GENERIC=new Set(('method methods system systems device devices apparatus process processes unit module member part invention claim claims phương pháp hệ thống thiết bị quy trình thành phần bộ phận phần tử chi tiết invention embodiment embodiments example examples').split(' '));

  // Low-information relationship / drafting words. These are NOT domain terms.
  // They are used only to prevent phrases such as "nằm ngang", "đầu xa kéo dài",
  // "làm thích ứng để" from becoming standalone search queries.
  const LOW_INFO_VI=new Set(('làm thích ứng để phù hợp nhằm sao cho nằm đặt bố trí cấu hình kéo dài kéo ra hướng về phía bên đầu xa gần ngang dọc thẳng hàng cách tháo lắp nối thông trạng thái kết thúc bắt đầu giữ tỳ đỡ hai ba nhiều tương ứng lần lượt có thể').split(' '));
  const LOW_INFO_EN=new Set(('adapted configured arranged extending extend distal proximal horizontal vertical aligned spaced removable removably connected state end side direction configured suitable located positioned retained holding support supporting first second plurality respectively').split(' '));
  const EDGE_STOP=new Set([...EN_STOP,...VI_STOP,'hai','ba','bốn','nhiều','first','second','third'].map(x=>String(x).toLowerCase()));

  const EN_HINT=new Set(('the and of to in for with from by is are was were as on into through using wherein comprising includes configured method system device process data input output control assembly member housing connector circuit sensor').split(' '));
  const VI_HINT=new Set(('và của trong được cho với là có từ bằng theo gồm một các những để khi quy trình phương pháp hệ thống thiết bị dữ liệu đầu vào đầu ra điều khiển cụm kết cấu lắp ráp').split(' '));

  const fold=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();
  const VI_HINT_FOLD=new Set([...VI_HINT].map(fold));
  const VI_STOP_FOLD_SAFE=new Set('va cua cho voi trong ngoai tren duoi tu den tai theo truoc do mot cac nhung duoc bi la co khong boi de khi neu thi ma nhu cung da se dang rat hon nhat moi nhieu it deu van con chi lai ra vao len xuong qua giua ve bang nen vi tuy song hay dau o gom thu hinh vi du mo ta kem yeu cau bao ho sang che nguoi su dung'.split(' '));

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
    // Only high-confidence, language-general OCR repairs. No technical vocabulary is injected.
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
    let vi=0,en=0;
    vi+=Math.min(24,(t.match(VI_DIAC)||[]).length*0.8);
    for(const tok of tokens){const f=fold(tok);if(VI_HINT.has(tok)||VI_HINT_FOLD.has(f))vi+=1.7;if(EN_HINT.has(f))en+=1.25;}
    const latin=t.match(/[A-Za-z]/g)?.length||0,letters=t.match(/[\p{L}]/gu)?.length||0;
    // ASCII alone must not make a short Vietnamese phrase "English".
    if(tokens.length>12&&letters&&latin/letters>0.80)en+=2.4;
    const total=vi+en;let primary='unknown';
    if(total>=3){if(vi>en*1.35)primary='vi';else if(en>vi*1.35)primary='en';else primary='mixed';}
    return {primary,viScore:+vi.toFixed(1),enScore:+en.toFixed(1),confidence:total?+(Math.abs(vi-en)/total).toFixed(2):0};
  }

  function detectPhraseLanguage(text,documentLanguage='unknown'){
    const s=cleanText(text),tokens=(s.toLowerCase().match(/[\p{L}]+/gu)||[]);
    if(VI_CHAR.test(s))return {primary:'vi',confidence:.98};
    const viHints=tokens.filter(x=>VI_HINT_FOLD.has(fold(x))).length;
    const enHints=tokens.filter(x=>EN_HINT.has(fold(x))).length;
    if(tokens.length<=6){
      if(documentLanguage==='vi'&&enHints<2)return {primary:'vi',confidence:.78};
      if(documentLanguage==='en'&&viHints<2)return {primary:'en',confidence:.78};
    }
    const d=detectLanguage(s);
    if(d.primary==='unknown'&&['vi','en'].includes(documentLanguage))return {primary:documentLanguage,confidence:.55};
    return d;
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

  function relationalOnly(term){
    const toks=cleanText(term).toLowerCase().match(TOKEN)||[];
    if(!toks.length)return true;
    const info=informationCount(toks);
    if(info===0)return true;
    const f=fold(term);
    if(/^(?:lam\s+thich\s+ung|thich\s+ung|duoc\s+(?:bo\s+tri|cau\s+hinh|lam\s+thich\s+ung)|phu\s+hop)(?:\s+de)?\b/.test(f)&&info<2)return true;
    return false;
  }

  function trimPhraseTokens(tokens){
    let arr=[...tokens];
    while(arr.length&&(isEdgeStop(arr[0])||isLowInfo(arr[0])))arr.shift();
    while(arr.length&&isEdgeStop(arr[arr.length-1]))arr.pop();
    // Strip common patent drafting prefixes while preserving the actual technical noun phrase.
    const joined=fold(arr.join(' '));
    const prefixes=['duoc lam thich ung de ','lam thich ung de ','duoc cau hinh de ','duoc bo tri de ','phu hop de ','configured to ','adapted to ','arranged to ','wherein '];
    for(const p of prefixes){if(joined.startsWith(p)){const n=p.trim().split(/\s+/).length;arr=arr.slice(n);break;}}
    while(arr.length&&(isEdgeStop(arr[0])||isLowInfo(arr[0])))arr.shift();
    while(arr.length&&isEdgeStop(arr[arr.length-1]))arr.pop();
    return arr;
  }

  function addCandidate(map,phrase,weight,source){
    let toks=(cleanText(phrase).toLowerCase().match(TOKEN)||[]);toks=trimPhraseTokens(toks);
    if(toks.length<2||toks.length>9)return;
    const term=toks.join(' ');
    if(term.length<5||term.length>140||boilerplate(term)||relationalOnly(term))return;
    const info=informationCount(toks);
    if(info<1||(toks.length>=4&&info<2))return;
    // A two-word phrase with only one informative token is accepted only from high-value sections.
    if(toks.length===2&&info===1&&!['title','abstract','claims'].includes(source))return;
    const key=fold(term);const old=map.get(key)||{term,count:0,score:0,n:toks.length,source,info};
    old.count+=1;old.score+=weight*(1+Math.min(.55,info*.14))*(1+Math.min(.30,(toks.length-2)*.055));
    if(({title:4,claims:3,abstract:2,body:1}[source]||0)>({title:4,claims:3,abstract:2,body:1}[old.source]||0))old.source=source;
    old.n=Math.max(old.n,toks.length);old.info=Math.max(old.info,info);map.set(key,old);
  }

  function clauseCandidates(text,weight,source,map){
    const src=cleanText(text);
    // Sentence / punctuation boundaries first. Stopwords remain INSIDE a phrase, so we do not create broken n-grams.
    const clauses=src.split(/[\n\r,;:.!?()\[\]{}“”"•|]+/u).map(x=>x.trim()).filter(Boolean);
    for(let clause of clauses){
      clause=clause.replace(/^\s*(?:claim|yêu cầu bảo hộ)?\s*\d+[.)\-:]?\s*/iu,'').trim();
      if(!clause)continue;
      // Split at drafting relations that normally separate a technical noun phrase from its function.
      // This avoids fragments such as "làm thích ứng để", "đầu xa kéo dài" becoming search keys.
      const parts=clause.split(/\s+(?:trong\s+đó|bao\s+gồm|gồm|có\s+thể|được\s+làm\s+thích\s+ứng\s+để|làm\s+thích\s+ứng\s+để|được\s+cấu\s+hình\s+để|được\s+bố\s+trí\s+để|được|để|phù\s+hợp\s+để|nhằm|sao\s+cho|wherein|comprising|comprises|including|includes|configured\s+to|adapted\s+to|arranged\s+to|such\s+that|so\s+that)\s+/iu);
      for(const part of parts){
        // Conjunctions also separate sibling components: "hốc giữ và tay đòn đàn hồi" -> two keys.
        const chunks=part.split(/\s+(?:và|hoặc|and|or)\s+/iu);
        for(const ch of chunks){
          let toks=trimPhraseTokens((ch.toLowerCase().match(TOKEN)||[]));
          if(toks.length<2)continue;
          if(toks.length<=9){addCandidate(map,toks.join(' '),weight,source);continue;}
          // Last-resort windows for very long noun groups; keep only dense, informative spans.
          for(let i=0;i<toks.length;i+=4){const w=toks.slice(i,i+8);if(w.length<4)break;if(informationCount(w)>=4)addCandidate(map,w.join(' '),weight*.55,source);}
        }
      }
    }
  }

  function repeatedPhrases(text,map){
    const src=cleanText(text).toLowerCase();const counts=new Map();
    const segments=src.split(/[\n\r,;:.!?()\[\]{}“”"•|]+/u);
    for(const seg of segments){const toks=(seg.match(TOKEN)||[]);for(const n of [2,3,4])for(let i=0;i+n<=toks.length;i++){
      const w=trimPhraseTokens(toks.slice(i,i+n));if(w.length!==n||informationCount(w)<Math.min(2,n))continue;
      const term=w.join(' ');if(boilerplate(term)||relationalOnly(term))continue;const k=fold(term);counts.set(k,{term,count:(counts.get(k)?.count||0)+1});
    }}
    for(const x of counts.values())if(x.count>=2)addCandidate(map,x.term,Math.min(2.2,0.7+x.count*.22),'body');
  }

  function sourceOccurrence(term,source){
    const f=fold(source),q=fold(term);if(!f||!q)return 0;let n=0,pos=0;while((pos=f.indexOf(q,pos))>=0){n++;pos+=Math.max(1,q.length);}return n;
  }

  function extract(text,opts={}){
    const max=Math.max(8,Math.min(Number(opts.max)||18,28));
    const source=cleanText(text),boost=cleanText(opts.boost||''),sec=patentSections(source),map=new Map();
    clauseCandidates(source,0.35,'body',map);
    if(sec.abstract)clauseCandidates(sec.abstract,4.2,'abstract',map);
    if(sec.title)clauseCandidates(sec.title,7.0,'title',map);
    if(boost)clauseCandidates(boost,5.1,'claims',map);

    const candidates=[];
    for(const v of map.values()){
      const occurrence=Math.max(v.count,sourceOccurrence(v.term,source)+sourceOccurrence(v.term,boost));
      let score=v.score*(1+Math.min(.55,Math.log2(1+occurrence)*.18));
      if(v.source==='title')score*=1.45;else if(v.source==='claims')score*=1.28;else if(v.source==='abstract')score*=1.15;
      // More complete technical phrases beat their truncated prefixes/suffixes.
      score*=1+Math.min(.32,(v.n-2)*.05)+Math.min(.25,v.info*.055);
      candidates.push({...v,count:occurrence,score});
    }
    candidates.sort((a,b)=>b.score-a.score||b.n-a.n||b.info-a.info||b.term.length-a.term.length);

    const picked=[];
    for(const c of candidates){
      if(picked.length>=max)break;const cf=fold(c.term),ct=new Set(cf.split(/\s+/));let duplicate=false;
      for(let i=0;i<picked.length;i++){
        const p=picked[i],pf=fold(p.term),pt=new Set(pf.split(/\s+/));const inter=[...ct].filter(x=>pt.has(x)).length,union=new Set([...ct,...pt]).size,j=union?inter/union:0;
        const nested=(pf.includes(cf)||cf.includes(pf))&&Math.abs((c.n||0)-(p.n||0))<=1;
        if(nested||j>.86){
          // Deduplicate near-identical phrases only. Keep meaningful nested components such as
          // "cụm lắp ráp thanh vòm mái" alongside the full title phrase.
          if((c.n>p.n&&c.info>=p.info&&c.score>=p.score*.55)||(c.source==='title'&&p.source!=='title'&&c.score>=p.score*.45))picked[i]=c;
          duplicate=true;break;
        }
      }
      if(!duplicate)picked.push(c);
    }
    picked.sort((a,b)=>b.score-a.score).splice(max);
    picked.forEach((k,i)=>{k.id='kw-'+(i+1);k.score=Math.round(k.score*10)/10;k.cohesion=1;k.language=detectPhraseLanguage(k.term,detectLanguage(source).primary).primary;});
    const language=detectLanguage(source);
    return {keywords:picked,language,stats:{chars:source.length,words:(source.match(TOKEN)||[]).length,title:sec.title,abstractChars:sec.abstract.length,extractor:'complete-phrase-v53'}};
  }

  root.PATENTLENS_KEYWORDS=Object.freeze({PILLARS,extract,fold,cleanText,detectLanguage,detectPhraseLanguage});
  if(typeof module!=='undefined'&&module.exports)module.exports=root.PATENTLENS_KEYWORDS;
})(typeof window!=='undefined'?window:globalThis);
