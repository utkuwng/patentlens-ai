/* PatentLens keyword extractor v45.
 * Document-driven only: no domain lexicon, no preloaded technical synonyms.
 * Extracts representative phrases from the current document and detects VI/EN language.
 * Online bilingual normalization/classification happens in worker.js.
 */
(function(root){
  'use strict';
  const PILLARS={
    process_product:{name:'Quy trình sản phẩm'},
    information_technology:{name:'Công nghệ thông tin'},
    system_device:{name:'Hệ thống/thiết bị'}
  };

  const EN_STOP=new Set(('a an and are as at be been being but by can could did do does for from had has have having how if in into is it its may might more most not of on onto or other our over per should so some such than that the their them then there these they this those through thus to under up upon use used using was we were what when where which while who will with within without would also each any all both between during about after before said according wherein whereby thereof therein herein first second third one two three plurality least example examples preferably particular described provided configured adapted based includes including include thereby further another various several present invention embodiment embodiments claim claims fig figure figures').split(' '));
  const VI_STOP=new Set(('và hoặc của cho với trong ngoài trên dưới từ đến tại theo sau trước do này đó kia một các những được bị là có không bởi để khi nếu thì mà như cũng đã sẽ đang rất hơn nhất cả mỗi mọi nhiều ít đều vẫn còn chỉ lại ra vào lên xuống qua giữa về bằng nên vì tuy song hay cùng nhau thế đây đấy ấy nào gì sao đâu ở gồm thứ hình ví dụ mô tả kèm yêu cầu bảo hộ sáng chế người sử dụng mang trực tiếp thuận tiện kỹ thuật thêm').split(' '));
  const GENERIC=new Set(('method methods system systems device devices apparatus process processes unit module member part invention claim claims phương pháp hệ thống thiết bị quy trình thành phần công ty sở hữu trí tuệ bản mô tả sáng chế embodiment embodiments example examples').split(' '));
  const TOKEN=/[\p{L}\p{N}]+(?:[-\/][\p{L}\p{N}]+)*/gu;
  const SEG=/[^\n\r.;:!?()\[\]{}"“”‘’•|]+/g;
  const VI_DIAC=/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi;
  const VI_CHAR=/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
  const EN_HINT=new Set(('the and of to in for with from by is are was were as on into through using wherein comprising includes configured method system device process data input output control').split(' '));
  const VI_HINT=new Set(('và của trong được cho với là có từ bằng theo gồm một các những để khi quy trình phương pháp hệ thống thiết bị dữ liệu đầu vào đầu ra điều khiển').split(' '));

  const fold=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();
  const VI_STOP_FOLD=new Set([...VI_STOP].map(fold));
  const VI_STOP_FOLD_SAFE=new Set('va cua cho voi trong ngoai tren duoi tu den tai theo truoc do mot cac nhung duoc bi la co khong boi de khi neu thi ma nhu cung da se dang rat hon nhat moi nhieu it deu van con chi lai ra vao len xuong qua giua ve bang nen vi tuy song hay dau o gom thu hinh vi du mo ta kem yeu cau bao ho sang che nguoi su dung mang truc tiep thuan tien ky thuat them'.split(' '));
  const VI_HINT_FOLD=new Set([...VI_HINT].map(fold));
  const PHRASE_CONNECTOR=new Set(('bằng cho với theo của trong trên dưới vào ra để từ đến giữa by for with of in on to from between via using').split(' ').map(fold));

  function mojibakeScore(s){return (String(s||'').match(/(?:Ã.|Â.|â€|ï»¿|�)/g)||[]).length;}
  function repairMojibake(s){
    const t=String(s||''); if(!mojibakeScore(t))return t;
    try{
      const bytes=Uint8Array.from([...t].map(ch=>ch.charCodeAt(0)&255));
      const fixed=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      return mojibakeScore(fixed)<mojibakeScore(t)?fixed:t;
    }catch{return t;}
  }
  function cleanText(s){
    let t=repairMojibake(String(s||''));
    t=t.replace(/\uFEFF|\u00AD/g,'').replace(/[\u200B-\u200D\u2060]/g,'').replace(/ﬁ/g,'fi').replace(/ﬂ/g,'fl').normalize('NFKC').normalize('NFC');
    // Join likely line-break hyphenation from PDF/OCR, but preserve ordinary inline hyphens.
    t=t.replace(/([\p{L}])-[ \t]*\n[ \t]*([\p{L}])/gu,'$1$2');
    return t.replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').replace(/[ \t]{2,}/g,' ').replace(/\n{4,}/g,'\n\n\n').trim();
  }

  function detectLanguage(text){
    const t=cleanText(text), tokens=(t.toLowerCase().match(/[\p{L}]+/gu)||[]).slice(0,12000);
    let vi=0,en=0;
    const di=(t.match(VI_DIAC)||[]).length; vi+=Math.min(24,di*0.8);
    for(const tok of tokens){const f=fold(tok); if(VI_HINT.has(tok)||VI_HINT_FOLD.has(f))vi+=1.7; if(EN_HINT.has(f))en+=1.25;}
    const latin=t.match(/[A-Za-z]/g)?.length||0, letters=t.match(/[\p{L}]/gu)?.length||0;
    // Latin letters alone do not prove English: OCR noise such as "csi seh cha wl" is also ASCII.
    // Only give a small script hint; function-word/context signals must carry the classification.
    if(letters&&latin/letters>0.82&&tokens.length>18)en+=0.8;
    const total=vi+en;
    let primary='unknown';
    if(total>=3){if(vi>en*1.35)primary='vi';else if(en>vi*1.35)primary='en';else primary='mixed';}
    if(tokens.length<=10&&!VI_CHAR.test(t)&&en<2.5)primary='unknown';
    return {primary,viScore:+vi.toFixed(1),enScore:+en.toFixed(1),confidence:total?+(Math.abs(vi-en)/total).toFixed(2):0};
  }

  function isStop(t){
    const raw=String(t||'').toLowerCase(),f=fold(raw),hasVi=VI_CHAR.test(raw);
    // Never fold an accented Vietnamese content word into an unrelated stopword (e.g. "nảy" ≠ "này").
    return EN_STOP.has(f)||VI_STOP.has(raw)||(!hasVi&&VI_STOP_FOLD_SAFE.has(f))||GENERIC.has(raw)||(!hasVi&&GENERIC.has(f))||f.length<2||/^\d+(?:[.,]\d+)?$/.test(f);
  }
  function quality(term){
    const s=String(term||'').trim(); if(s.length<3||s.length>115)return 0;
    const letters=s.match(/[\p{L}]/gu)?.length||0, digits=s.match(/\d/g)?.length||0;
    if(!letters||digits>s.length*0.55||/(.)\1{4,}/u.test(s))return 0;
    const toks=s.match(TOKEN)||[]; if(!toks.length||toks.length>5)return 0;
    return Math.min(1,0.55+letters/Math.max(letters+digits,1)*0.45);
  }

  function countPhrases(text,weight,counts,headChars){
    const src=cleanText(text).toLowerCase();
    for(const m of src.matchAll(SEG)){
      const positional=(m.index<headChars?1.25:1)*weight;const toks=m[0].match(TOKEN)||[];if(!toks.length)continue;
      const runs=[];let run=[];
      const flush=()=>{if(run.length)runs.push(run);run=[];};
      for(const tok of toks){const f=fold(tok);const structural=/^(?:i{1,4}|v|vi{0,3}|ix|x|xi{0,3}|xv|xvi{0,3}|\d{1,3})$/i.test(f);const connector=PHRASE_CONNECTOR.has(f);if((isStop(tok)&&!connector)||structural){flush();continue;}run.push(tok);}flush();
      for(const words of runs){
        if(!words.length)continue;const maxN=Math.min(5,words.length),minN=words.length===1?1:2;
        for(let n=minN;n<=maxN;n++)for(let i=0;i+n<=words.length;i++){
          const g=words.slice(i,i+n);if(PHRASE_CONNECTOR.has(fold(g[0]))||PHRASE_CONNECTOR.has(fold(g[g.length-1])))continue;const term=g.join(' '),q=quality(term);if(!q)continue;
          if(n===1&&g[0].length<6&&!/[A-Za-z]*\d|\d[A-Za-z]*/.test(g[0]))continue;
          const fullRun=n===Math.min(5,words.length)&&i===0&&words.length<=5;
          const lengthBonus=n===1?0.38:n===2?1.0:n===3?1.35:n===4?1.60:1.82;
          const old=counts.get(term)||{count:0,score:0,n};old.count++;old.score+=positional*lengthBonus*q*(fullRun?1.28:1);counts.set(term,old);
        }
      }
    }
  }

  function patentSections(text){
    const t=cleanText(text), low=fold(t);let title='',abstract='';
    const titlePatterns=[/(?:^|\n)\s*\(\s*54\s*\)\s*([^\n]+(?:\n(?!\s*\(\s*\d{2}\s*\))[^^\n]*){0,3})/iu,/(?:^|\n)\s*(?:title|tên\s+sáng\s+chế)\s*[:\-]?\s*([^\n]{8,300})/iu];
    for(const rx of titlePatterns){const m=t.match(rx);if(m){title=cleanText(m[1]).replace(/\s+/g,' ').slice(0,420);break;}}
    const absMarkers=[/\(\s*57\s*\)\s*(?:ABSTRACT\s*)?([\s\S]{30,2200}?)(?=\n\s*\f|\n\s*\(\s*\d{2}\s*\)|\n\s*(?:claims?|description|yêu cầu bảo hộ)\b)/iu,/(?:^|\n)\s*(?:abstract|tóm\s+tắt)\s*[:\-]?\s*([\s\S]{30,2200}?)(?=\n\s*(?:claims?|description|mô tả|yêu cầu bảo hộ)\b|$)/iu];
    for(const rx of absMarkers){const m=t.match(rx);if(m){abstract=cleanText(m[1]).replace(/\s+/g,' ').slice(0,2200);break;}}
    return {title,abstract};
  }

  function tokenFrequency(text){const m=new Map();for(const x of (cleanText(text).toLowerCase().match(TOKEN)||[])){const f=fold(x);if(!f)continue;m.set(f,(m.get(f)||0)+1);}return m;}

  function boilerplate(term){const f=fold(term);return /(?:cong ty|so huu tri tue|ban mo ta|bang doc quyen|cong hoa xa hoi|cuc so huu|tac gia|chu don|patent application|present invention|embodiment|claim\s*\d|nguoi su dung|thuan tien|truc tiep|co khong|xac dinh|kiem tra|thong so ky thuat)/i.test(f);}

  function ocrNoise(term){
    const toks=String(term||'').match(TOKEN)||[];if(!toks.length)return true;
    const alpha=toks.filter(x=>/[\p{L}]/u.test(x));if(!alpha.length)return true;
    const short=alpha.filter(x=>x.length<=2).length;
    const shortOk=new Set('of to in on by ai ml vr ar dc ac mm cm nm mg kg ph uv'.split(' '));
    const badShort=alpha.filter(x=>x.length<=2&&!shortOk.has(fold(x))).length;
    const noVowel=alpha.filter(x=>!/[aeiouyàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹ]/i.test(x)).length;
    if(alpha.length>=4&&badShort>=1)return true;
    if(alpha.length>=4&&short/alpha.length>.36)return true;
    if(alpha.length>=4&&noVowel/alpha.length>.48)return true;
    const uniq=new Set(alpha.map(fold));if(alpha.length>=4&&uniq.size<=Math.ceil(alpha.length/2))return true;
    if((String(term).match(/\d/g)||[]).length>=3&&alpha.length>=3)return true;
    if(toks.some(x=>/^(?:\d+[\p{L}]{2,}|[\p{L}]+\d+[\p{L}]+)/u.test(x)))return true;
    return false;
  }

  function extract(text,opts={}){
    const max=Math.max(8,Math.min(Number(opts.max)||16,24));
    const source=cleanText(text),boost=cleanText(opts.boost||''),words=(source.match(TOKEN)||[]).length;
    const sec=patentSections(source),counts=new Map();
    // Whole description is background only; title/abstract/claims receive much more weight.
    countPhrases(source,0.16,counts,1200);
    if(sec.abstract)countPhrases(sec.abstract,3.0,counts,2400);
    if(sec.title)countPhrases(sec.title,5.2,counts,600);
    if(boost)countPhrases(boost,3.4,counts,0);
    const tf=tokenFrequency(source+' '+boost),minCount=words>4500?2:1,candidates=[];
    for(const [term,v] of counts){
      if(v.count<minCount||boilerplate(term)||ocrNoise(term))continue;
      const toks=(term.match(TOKEN)||[]).map(fold).filter(Boolean);if(!toks.length)continue;
      const minTf=Math.min(...toks.map(x=>tf.get(x)||1));const cohesion=Math.min(1,v.count/Math.max(1,minTf));
      const n=v.n||toks.length;const phrasePref=n===1?0.38:n===2?1.0:n===3?1.38:n===4?1.62:1.82;
      const inTitle=sec.title&&fold(sec.title).includes(fold(term));const inAbs=sec.abstract&&fold(sec.abstract).includes(fold(term));
      let score=v.score*phrasePref*(0.58+0.42*cohesion)*(inTitle?1.55:inAbs?1.18:1);
      // Strongly downweight single generic words; preserve acronyms/chemical-like tokens as fallback.
      if(n===1&&!/[A-Za-z]+\d|\d+[A-Za-z]|^[A-Z]{2,8}$/i.test(term))score*=0.72;
      candidates.push({term,count:v.count,score,n,cohesion,source:inTitle?'title':inAbs?'abstract':boost&&fold(boost).includes(fold(term))?'claims':'body'});
    }
    // Preserve complete technical chunks from the title; frequency alone tends to over-rank partial n-grams.
    if(sec.title){
      const toks=sec.title.toLowerCase().match(TOKEN)||[];let run=[];const runs=[];const flush=()=>{if(run.length>=2)runs.push(run);run=[];};
      for(const tok of toks){if(isStop(tok)){flush();continue;}run.push(tok);}flush();
      for(const r of runs){const term=r.slice(0,6).join(' ');if(quality(term)&&!boilerplate(term)&&!ocrNoise(term))candidates.push({term,count:1,score:115+r.length*8,n:r.length,cohesion:1,source:'title'});}
    }
    candidates.sort((a,b)=>b.score-a.score||b.n-a.n||b.count-a.count||b.term.length-a.term.length);
    const picked=[];
    for(const c of candidates){
      if(picked.length>=max)break;const cf=fold(c.term),ct=new Set(cf.split(/\s+/));let skip=false;
      for(let i=0;i<picked.length;i++){
        const p=picked[i],pf=fold(p.term),pt=new Set(pf.split(/\s+/));const inter=[...ct].filter(x=>pt.has(x)).length,union=new Set([...ct,...pt]).size,j=union?inter/union:0;
        const nested=pf.includes(cf)||cf.includes(pf);
        if((nested||j>0.82)){
          // Prefer the more complete phrase when its score is reasonably close.
          if(c.n>p.n && (c.score>=p.score*0.62 || (c.source==='title'&&c.score>=p.score*0.38))){picked[i]=c;}skip=true;break;
        }
      }
      if(!skip)picked.push(c);
    }
    picked.sort((a,b)=>b.score-a.score).splice(max);
    picked.forEach((k,i)=>{k.id='kw-'+(i+1);k.score=Math.round(k.score*10)/10;k.cohesion=+k.cohesion.toFixed(2);});
    return {keywords:picked,language:detectLanguage(source),stats:{chars:source.length,words,title:sec.title,abstractChars:sec.abstract.length}};
  }

  root.PATENTLENS_KEYWORDS=Object.freeze({PILLARS,extract,fold,cleanText,detectLanguage});
  if(typeof module!=='undefined'&&module.exports)module.exports=root.PATENTLENS_KEYWORDS;
})(typeof window!=='undefined'?window:globalThis);
