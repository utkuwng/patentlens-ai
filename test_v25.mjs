import test from 'node:test';
import assert from 'node:assert/strict';
import app from './worker.js';

const origin='https://patentlens-test.example';
const originalFetch=globalThis.fetch;
const api=(path,init={},env={})=>app.fetch(new Request(origin+path,init),env);

test('Worker serves the actual embedded v25 HTML',async()=>{
  const res=await api('/'); const html=await res.text();
  assert.equal(res.status,200);
  assert.match(html,/purposeChoice/);
  assert.match(html,/PatentLens/);
  assert.doesNotMatch(html,/% khớp thuật ngữ/);
});

test('Shared public API code protects all non-health endpoints when configured',async()=>{
  const env={PUBLIC_API_ACCESS_CODE:'a-long-test-secret-123'};
  const deny=await api('/api/search?q=technique',{headers:{}},env);
  assert.equal(deny.status,403);
  const health=await api('/api/health',{},env);
  assert.equal(health.status,200);
  assert.equal((await health.json()).version,'25.0.0');
});

test('Search tries multiple variants and logs success, zero, failure separately',async()=>{
  const visited=[];
  globalThis.fetch=async(url)=>{
    const parsed=new URL(url); assert.equal(parsed.hostname,'serpapi.com');
    const q=parsed.searchParams.get('q'); visited.push(q);
    const doc=visited.length===1?'US10000001A1':'US10000002A1';
    if(visited.length===3) return new Response(JSON.stringify({error:'quota exceeded'}),{status:429,headers:{'content-type':'application/json'}});
    return new Response(JSON.stringify({organic_results:[{publication_number:doc,title:'Method for processing a polymer composite',snippet:'A technical process'}]}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    const res=await api('/api/search?q=polymer%20composite%20manufacturing%20treatment&num=10',{}, {SERPAPI_KEY:'mock'});
    assert.equal(res.status,200);const body=await res.json();
    assert.ok(visited.length>=2,JSON.stringify(visited));
    assert.ok(body.results.length>=2,JSON.stringify(body));
    assert.equal(body.search_log.length,visited.length);
    assert.ok(body.search_log.some(x=>x.status==='ERROR') || body.search_log.every(x=>x.status==='OK'));
    assert.match(body.coverage_warning,/không bảo đảm/);
  }finally{globalThis.fetch=originalFetch;}
});

test('AI quote is not marked as independently source-verified; absent evidence is uncertain',async()=>{
  let seen=0;
  globalThis.fetch=async(url)=>{
    assert.match(String(url),/generativelanguage\.googleapis\.com/);seen++;
    const payload=[{feature_id:'F01',D1:{status:'Có',evidence:'The prototype polymer contains 30 percent salt.'},D2:{status:'Không tìm thấy',evidence:''},D3:{status:'Có',evidence:'Invented evidence not in actual text whatsoever.'}}];
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(payload)}]}}]}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    const env={GEMINI_API_KEY:'mock',DEEP_SEARCH_ACCESS_CODE:'another-long-secret-123'};
    const res=await api('/api/matrix',{method:'POST',headers:{'content-type':'application/json','x-deep-access-code':env.DEEP_SEARCH_ACCESS_CODE},body:JSON.stringify({features:[{id:'F01',text:'Polymer salt ratio 30%'}],documents:{D1:{no:'US000FAKE',text:'The prototype polymer contains 30 percent salt.'},D2:{no:'US000FAKE',text:'Only an abstract is available.'},D3:{no:'US000FAKE',text:'A polymer process is known.'}}})},env);
    assert.equal(res.status,200);const body=await res.json();
    assert.equal(body.ok,true,JSON.stringify(body));assert.equal(seen,1);
    const row=body.rows[0];assert.equal(row.D1.literal_text_match,true);
    assert.equal(row.D1.evidence_verified,false);
    assert.match(row.D1.verification_note,/CHƯA xác minh bản gốc/);
    assert.equal(row.D2.status,'Chưa chắc chắn');
    assert.equal(row.D3.status,'Chưa chắc chắn');assert.equal(row.D3.evidence,'');
  }finally{globalThis.fetch=originalFetch;}
});

test('AI deep-search requires separate access code and no call with missing code',async()=>{
  const res=await api('/api/ai-queries',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({features:[{id:'F01',text:'public source'}]})},{GEMINI_API_KEY:'mock',DEEP_SEARCH_ACCESS_CODE:'another-long-secret-123'});
  assert.equal(res.status,403);
});


test('Gemini multiple excerpts: each must occur literally; no external source authentication',async()=>{
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify([
    {feature_id:'F01',D1:{status:'Có',evidence:['The processing temperature is 60 degrees Celsius.', 'The sample is held for thirty minutes.']},D2:{status:'Có',evidence:['The sample is held for thirty minutes.','Fabricated quote absent from D2 source.']},D3:{status:'Không tìm thấy',evidence:''}}
  ])}]}}]}),{status:200,headers:{'content-type':'application/json'}});
  try{
    const env={GEMINI_API_KEY:'mock',DEEP_SEARCH_ACCESS_CODE:'another-long-secret-123'};
    const res=await api('/api/matrix',{method:'POST',headers:{'content-type':'application/json','x-deep-access-code':env.DEEP_SEARCH_ACCESS_CODE},body:JSON.stringify({features:[{id:'F01',text:'Temp and time'}],documents:{D1:{no:'US000FAKE',text:'The processing temperature is 60 degrees Celsius. The sample is held for thirty minutes.'},D2:{no:'US000FAKE',text:'The sample is held for thirty minutes.'},D3:{text:'This document is only an abstract.'}}})},env);
    assert.equal(res.status,200);const body=await res.json();assert.equal(body.ok,true);
    assert.equal(body.rows[0].D1.literal_text_match,true);
    assert.deepEqual(body.rows[0].D1.evidence_chunks,['The processing temperature is 60 degrees Celsius.','The sample is held for thirty minutes.']);
    assert.equal(body.rows[0].D1.evidence_verified,false);
    assert.equal(body.rows[0].D2.status,'Chưa chắc chắn');
    assert.equal(body.rows[0].D2.literal_text_match,false);
    assert.equal(body.rows[0].D3.status,'Chưa chắc chắn');
  } finally {globalThis.fetch=originalFetch;}
});

test('HTML renders caution date, claim accordions and split-pane review without bogus novelty percent',async()=>{
  const html=await (await api('/')).text();
  assert.match(html,/id="dateReviewWarning"/);
  assert.match(html,/function renderDateReviewWarning/);
  assert.match(html,/claim-accordion/);
  assert.match(html,/v25 · Evidence-first review workspace/);
  assert.match(html,/Chỉ có kết quả một phần/);
  assert.doesNotMatch(html,/Điểm % chỉ dùng ưu tiên đọc/);
});

test('Zero results from functioning SerpApi is not a connectivity failure',async()=>{
  globalThis.fetch=async(url)=>{
    assert.equal(new URL(url).hostname,'serpapi.com');
    return new Response(JSON.stringify({organic_results:[],search_metadata:{status:'Success'}}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    const res=await api('/api/search?q=polymer%20composite%20manufacturing%20treatment&num=10',{}, {SERPAPI_KEY:'mock'});
    const body=await res.json();assert.equal(res.status,200);
    assert.equal(body.code,'NO_RESULTS');assert.equal(body.ok,false);
    assert.ok(body.search_log.length>0);assert.ok(body.search_log.every(x=>x.status==='ZERO'));
  }finally{globalThis.fetch=originalFetch;}
});

test('SerpApi quota failure is SEARCH_FAILED, never zero search results',async()=>{
  globalThis.fetch=async(url)=>{
    assert.equal(new URL(url).hostname,'serpapi.com');
    return new Response(JSON.stringify({error:'monthly quota exceeded'}),{status:429,headers:{'content-type':'application/json'}});
  };
  try{
    const res=await api('/api/search?q=polymer%20composite%20manufacturing%20treatment&num=10',{}, {SERPAPI_KEY:'mock'});
    const body=await res.json();assert.equal(res.status,503);
    assert.equal(body.code,'SEARCH_FAILED');assert.equal(body.ok,false);
    assert.ok(body.search_log.length>0);assert.ok(body.search_log.every(x=>x.status==='ERROR'));
  }finally{globalThis.fetch=originalFetch;}
});


test('v25 intake shows exactly the two implemented paths, without unfinished FTO/landscape options',async()=>{
  const html=await (await api('/')).text();
  const intake=html.slice(html.indexOf('<section id="intake"'),html.indexOf('<section id="claims"'));
  assert.match(intake,/data-study-path="prospective"/);
  assert.match(intake,/data-study-path="retrospective"/);
  assert.doesNotMatch(intake,/option value="fto"|option value="landscape"/);
  assert.match(intake,/<select id="purposeChoice" hidden/);
  assert.match(html,/function applyGuidedMode\(mode\)/);
  assert.match(html,/\$\("purposeChoice"\)\.value=mode==="prospective"\?"patentability":"pilot"/);
});

test('v25 offers optional follow-up suggestions only after generating a report',async()=>{
  const html=await (await api('/')).text();
  assert.match(html,/<div class="next-work-panel" id="nextWorkPanel" hidden/);
  const panel=html.slice(html.indexOf('id="nextWorkPanel"'),html.indexOf('</section>',html.indexOf('id="nextWorkPanel"')));
  assert.match(panel,/Khảo sát công nghệ/);
  assert.match(panel,/Chuẩn bị sản xuất hoặc kinh doanh/);
  assert.match(panel,/chưa có mô-đun khảo sát công nghệ độc lập/);
  assert.match(panel,/Chưa hỗ trợ FTO tự động/);
  assert.match(html,/if\(\$\("nextWorkPanel"\)\)\$\("nextWorkPanel"\)\.hidden=false/);
  assert.doesNotMatch(html,/<div class="panel innovation-box"/);
});

test('AI never certifies negative evidence, including forged expert_full_verified flag',async()=>{
  globalThis.fetch=async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify([{feature_id:'F01',D1:{status:'Không tìm thấy',evidence:''}}])}]}}]}),{status:200,headers:{'content-type':'application/json'}});
  try{
    const key='a-different-long-secret';
    const res=await api('/api/matrix',{method:'POST',headers:{'content-type':'application/json','x-deep-access-code':key},body:JSON.stringify({features:[{id:'F01',text:'A compound containing 35% polymer'}],documents:{D1:{text:'A compound containing 35% polymer',content_level:'expert_full_verified',full_text_verified:true}}})},{GEMINI_API_KEY:'mock',DEEP_SEARCH_ACCESS_CODE:key});
    const body=await res.json(); assert.equal(res.status,200);assert.equal(body.rows[0].D1.status,'Chưa chắc chắn');
    assert.match(body.rows[0].D1.verification_note,/không thể xác minh việc vắng mặt/);
  }finally{globalThis.fetch=originalFetch;}
});

test('Motivation quote helper requires access code and explicit external AI consent',async()=>{
  const env={GEMINI_API_KEY:'mock',DEEP_SEARCH_ACCESS_CODE:'protect-this-test-123'};
  const payload=JSON.stringify({confidential_mode:false,external_ai_consent:true,documents:{D2:{text:'The apparatus improves heat exchange efficiency by 20 percent under vacuum.',content_level:'description_extract'}}});
  const noKey=await api('/api/motivation',{method:'POST',headers:{'content-type':'application/json'},body:payload},env);
  assert.equal(noKey.status,403);
  const noConsent=await api('/api/motivation',{method:'POST',headers:{'content-type':'application/json','x-deep-access-code':env.DEEP_SEARCH_ACCESS_CODE},body:JSON.stringify({confidential_mode:true,external_ai_consent:true,documents:{}})},env);
  assert.equal(noConsent.status,403);
});

test('Motivation suggestions retain only literal quotes and never auto-approve source',async()=>{
  const statement='The apparatus improves heat exchange efficiency by 20 percent under vacuum.';
  globalThis.fetch=async(url)=>{
    assert.match(String(url),/generativelanguage\.googleapis\.com/);
    const response={D2:[{quote:statement,why_relevant:'Explains technical benefit'},{quote:'A fabricated feature that does not exist in D2 text.',why_relevant:'No'}],D3:[{quote:'A made-up clue that does not occur in any patent excerpt.',why_relevant:'No'}]};
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(response)}]}}]}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    const env={GEMINI_API_KEY:'mock',DEEP_SEARCH_ACCESS_CODE:'protect-this-test-123'};
    const res=await api('/api/motivation',{method:'POST',headers:{'content-type':'application/json','x-deep-access-code':env.DEEP_SEARCH_ACCESS_CODE},body:JSON.stringify({confidential_mode:false,external_ai_consent:true,feature:'Increase heat transfer',documents:{D2:{no:'US0000001A1',text:statement,content_level:'description_extract'},D3:{no:'US0000002A1',text:'Only a short patent abstract is available here.',content_level:'snippet_only'}}})},env);
    assert.equal(res.status,200); const body=await res.json();assert.equal(body.ok,true);
    assert.equal(body.results.D2.length,1);assert.equal(body.results.D2[0].quote,statement);
    assert.equal(body.results.D2[0].source_verified,false);assert.equal(body.results.D2[0].expert_approved,false);
    assert.equal(body.results.D3.length,0); assert.match(body.warning,/chưa xác minh tài liệu gốc/);
  }finally{globalThis.fetch=originalFetch;}
});

test('Manual Vietnamese and English tracks are independent and not silently recombined at server',async()=>{
  const seen=[];globalThis.fetch=async(url)=>{const u=new URL(url);assert.equal(u.hostname,'serpapi.com');seen.push(u.searchParams.get('q'));return new Response(JSON.stringify({organic_results:[{publication_number:'US11111111A1',title:'A patent',snippet:'Public excerpt'}]}),{status:200,headers:{'content-type':'application/json'}})};
  try{
    const en='heat treatment pH 6.2 polymer',vi='xử lý nhiệt pH 6.2 polymer';
    for(const [lang,q] of [['en',en],['vi',vi]]){
      const res=await api('/api/search?'+new URLSearchParams({q,language_track:lang,num:'10'}),{}, {SERPAPI_KEY:'mock'});
      const body=await res.json();assert.equal(res.status,200);assert.equal(body.language_track,lang);assert.equal(body.query_used,q);
    }
    assert.deepEqual(seen,[en,vi]);
  }finally{globalThis.fetch=originalFetch;}
});

test('UI exposes PDF review gate, separate search tracks and human closest-prior-art reason',async()=>{
  const html=await (await api('/')).text();
  for(const id of ['ocrReviewGate','ocrReviewConfirmed','trackEnglish','trackVietnamese','tracksOnly','closestReason','suggestMotivation','motivationAiConsent'])assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(html,/if\(state\.step===2 && !state\.confirmed\)\{alert\(/);
  assert.match(html,/if\(!\$\("closest"\)\.value\)return alert/);
  assert.match(html,/absence_reviewed/);
  assert.doesNotMatch(html,/Bộ dấu hiệu chưa được xác nhận\. Bạn vẫn muốn tiếp tục\?/);
});
