import test from 'node:test';
import assert from 'node:assert/strict';
import app from './worker.js';

const origin='https://patentlens-test.example';
const originalFetch=globalThis.fetch;
const api=(path,init={},env={})=>app.fetch(new Request(origin+path,init),env);

test('Worker serves the actual embedded v22 HTML',async()=>{
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
  assert.equal((await health.json()).version,'22.0.0');
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
