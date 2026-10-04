/* PatentLens keyword extractor v43.
 * Extracts frequent/representative phrases FROM THE CURRENT DOCUMENT only.
 * No domain keyword lexicon, no hard-coded technical synonyms, no local pillar classifier.
 * The only built-in vocabulary is generic stopword/noise filtering.
 */
(function(root){
  'use strict';
  const PILLARS={
    process_product:{name:'Quy trình sản phẩm'},
    information_technology:{name:'Công nghệ thông tin'},
    system_device:{name:'Hệ thống/thiết bị'}
  };
  const EN_STOP=new Set('a an and are as at be been being but by can could did do does for from had has have having he her his how if in into is it its may might more most not of on onto or other our over per she should so some such than that the their them then there these they this those through thus to under up upon use used using was we were what when where which while who will with within without would you your also each any all both between during about after before said claim claims comprising comprises comprise comprised wherein whereby thereof therein herein invention embodiment embodiments present according fig figure figures first second third one two three plurality least example examples preferably particular described provided configured adapted based includes including include thereby further another various several'.split(' '));
  const VI_STOP=new Set('và hoặc của cho với trong ngoài trên dưới từ đến tại theo sau trước do này đó kia một các những được bị là có không bởi để khi nếu thì mà như cũng đã sẽ đang rất hơn nhất cả mỗi mọi nhiều ít đều vẫn còn chỉ lại ra vào lên xuống qua giữa về bằng nên vì tuy song hay cùng nhau thế đây đấy ấy nào gì sao đâu ở gồm điểm trưng hai ba bốn năm sáu bảy tám chín mười thứ vẽ dụ tả kèm yêu cầu bảo hộ sáng chế'.split(' '));
  const GENERIC=new Set('method methods system systems device devices apparatus process processes product products unit module member part invention claim claims phương pháp hệ thống thiết bị quy trình sản phẩm'.split(' '));
  const TOKEN=/[\p{L}\p{N}]+(?:[-\/][\p{L}\p{N}]+)*/gu;
  const SEG=/[^\n\r.;:,!?()\[\]{}"“”‘’•|]+/g;
  const fold=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();
  const isStop=t=>{const f=fold(t);return EN_STOP.has(f)||VI_STOP.has(t.toLowerCase())||VI_STOP.has(f)||GENERIC.has(f)||f.length<2||/^\d+([.,]\d+)?$/.test(f);};

  function countPhrases(text,weight,counts,headChars){
    for(const m of String(text||'').toLowerCase().matchAll(SEG)){
      const positional=(m.index<headChars?1.45:1)*weight;
      const toks=m[0].match(TOKEN)||[];
      let run=[];
      const flush=()=>{
        for(let i=0;i<run.length;i++){
          for(let n=1;n<=4&&i+n<=run.length;n++){
            const g=run.slice(i,i+n);
            if(n===1&&g[0].length<5&&!/\d/.test(g[0]))continue;
            const term=g.join(' '),base=1+0.55*(n-1);
            const old=counts.get(term)||{count:0,score:0,n};
            old.count+=1;old.score+=positional*base;counts.set(term,old);
          }
        }
        run=[];
      };
      for(const t of toks){if(isStop(t)){flush();continue;}run.push(t);}flush();
    }
  }

  function extract(text,opts={}){
    const max=Math.max(6,Math.min(Number(opts.max)||14,24));
    const source=String(text||''),boost=String(opts.boost||'');
    const words=(source.match(TOKEN)||[]).length;
    if(source.trim().length<400&&!boost){
      const items=[...new Set(source.split(/[\n,;]+/).map(x=>x.replace(/\s+/g,' ').trim()).filter(x=>x.length>=3&&x.length<=110))];
      return {keywords:items.slice(0,max).map((term,i)=>({id:'kw-'+(i+1),term,count:1,score:1})),stats:{chars:source.length,words}};
    }
    const counts=new Map();countPhrases(source,1,counts,1800);if(boost)countPhrases(boost,1.8,counts,0);
    const minCount=words>1800?2:1,candidates=[];
    for(const [term,v] of counts){if(v.count<minCount)continue;candidates.push({term,count:v.count,score:v.score,n:v.n});}
    candidates.sort((a,b)=>b.score-a.score||b.count-a.count||b.n-a.n);
    const picked=[];
    for(const c of candidates){
      if(picked.length>=max)break;
      const f=' '+fold(c.term)+' ';
      if(picked.some(p=>{const pf=' '+fold(p.term)+' ';return pf.includes(f)||f.includes(pf);} ))continue;
      picked.push(c);
    }
    picked.forEach((k,i)=>{k.id='kw-'+(i+1);k.score=Math.round(k.score*10)/10;});
    return {keywords:picked,stats:{chars:source.length,words}};
  }

  root.PATENTLENS_KEYWORDS=Object.freeze({PILLARS,extract,fold});
  if(typeof module!=='undefined'&&module.exports)module.exports=root.PATENTLENS_KEYWORDS;
})(typeof window!=='undefined'?window:globalThis);
