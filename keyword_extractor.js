/* PatentLens keyword extractor v44.
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
  const VI_STOP=new Set(('và hoặc của cho với trong ngoài trên dưới từ đến tại theo sau trước do này đó kia một các những được bị là có không bởi để khi nếu thì mà như cũng đã sẽ đang rất hơn nhất cả mỗi mọi nhiều ít đều vẫn còn chỉ lại ra vào lên xuống qua giữa về bằng nên vì tuy song hay cùng nhau thế đây đấy ấy nào gì sao đâu ở gồm thứ hình ví dụ mô tả kèm yêu cầu bảo hộ sáng chế').split(' '));
  const GENERIC=new Set(('method methods system systems device devices apparatus process processes product products unit module member part invention claim claims phương pháp hệ thống thiết bị quy trình sản phẩm').split(' '));
  const TOKEN=/[\p{L}\p{N}]+(?:[-\/][\p{L}\p{N}]+)*/gu;
  const SEG=/[^\n\r.;:!?()\[\]{}"“”‘’•|]+/g;
  const VI_DIAC=/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi;
  const EN_HINT=new Set(('the and of to in for with from by is are was were as on into through using wherein comprising includes configured method system device process data input output control').split(' '));
  const VI_HINT=new Set(('và của trong được cho với là có từ bằng theo gồm một các những để khi quy trình phương pháp hệ thống thiết bị dữ liệu đầu vào đầu ra điều khiển').split(' '));

  const fold=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();
  const VI_STOP_FOLD=new Set([...VI_STOP].map(fold));
  const VI_HINT_FOLD=new Set([...VI_HINT].map(fold));

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
    t=t.replace(/\uFEFF|\u00AD/g,'').replace(/[\u200B-\u200D\u2060]/g,'').normalize('NFC');
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
    if(letters&&latin/letters>0.72)en+=3;
    const total=vi+en;
    let primary='unknown';
    if(total>=3){if(vi>en*1.35)primary='vi';else if(en>vi*1.35)primary='en';else primary='mixed';}
    return {primary,viScore:+vi.toFixed(1),enScore:+en.toFixed(1),confidence:total?+(Math.abs(vi-en)/total).toFixed(2):0};
  }

  function isStop(t){
    const raw=String(t||'').toLowerCase(),f=fold(raw);
    return EN_STOP.has(f)||VI_STOP.has(raw)||VI_STOP_FOLD.has(f)||GENERIC.has(raw)||GENERIC.has(f)||f.length<2||/^\d+(?:[.,]\d+)?$/.test(f);
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
      const positional=(m.index<headChars?1.35:1)*weight;
      const toks=m[0].match(TOKEN)||[];
      if(!toks.length)continue;
      for(let i=0;i<toks.length;i++){
        for(let n=1;n<=4&&i+n<=toks.length;n++){
          const g=toks.slice(i,i+n),content=g.filter(x=>!isStop(x));
          if(n===1){if(isStop(g[0])||g[0].length<6&&!/[A-Za-z]*\d|\d[A-Za-z]*/.test(g[0]))continue;}
          else{
            // Keep natural phrases; stopwords may occur inside but not dominate or sit at both ends.
            if(content.length<2)continue;
            if(isStop(g[0])||isStop(g[g.length-1]))continue;
            if(content.length/n<0.60)continue;
          }
          const term=g.join(' '),q=quality(term);if(!q)continue;
          const lengthBonus=n===1?0.65:n===2?1.32:n===3?1.58:1.68;
          const contentBonus=Math.pow(content.length/n,1.45);
          const old=counts.get(term)||{count:0,score:0,n};old.count++;old.score+=positional*lengthBonus*q*contentBonus;counts.set(term,old);
        }
      }
    }
  }

  function extract(text,opts={}){
    const max=Math.max(8,Math.min(Number(opts.max)||16,24));
    const source=cleanText(text),boost=cleanText(opts.boost||''),words=(source.match(TOKEN)||[]).length;
    const counts=new Map(); countPhrases(source,1,counts,2200); if(boost)countPhrases(boost,2.15,counts,0);
    const minCount=words>2500?2:1,candidates=[];
    for(const [term,v] of counts){if(v.count<minCount)continue;candidates.push({term,count:v.count,score:v.score,n:v.n});}
    candidates.sort((a,b)=>b.score-a.score||b.count-a.count||b.n-a.n||b.term.length-a.term.length);
    const picked=[];
    for(const c of candidates){
      if(picked.length>=max)break;
      const f=' '+fold(c.term)+' ';
      // Suppress phrases that are mostly contained in a stronger phrase, while keeping genuinely different combinations.
      if(picked.some(p=>{const pf=' '+fold(p.term)+' '; const contains=pf.includes(f)||f.includes(pf); if(!contains)return false; const shared=Math.min(f.length,pf.length)/Math.max(f.length,pf.length); return shared>0.72;}))continue;
      picked.push(c);
    }
    picked.forEach((k,i)=>{k.id='kw-'+(i+1);k.score=Math.round(k.score*10)/10;});
    return {keywords:picked,language:detectLanguage(source),stats:{chars:source.length,words}};
  }

  root.PATENTLENS_KEYWORDS=Object.freeze({PILLARS,extract,fold,cleanText,detectLanguage});
  if(typeof module!=='undefined'&&module.exports)module.exports=root.PATENTLENS_KEYWORDS;
})(typeof window!=='undefined'?window:globalThis);
