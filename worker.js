/**
 * PatentLens AI — Full-stack Cloudflare Worker
 * Static UI is served by Cloudflare Assets.
 * API routes under /api/* perform server-side patent discovery/details.
 */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function stripTags(s = "") {
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, "…")
    .replace(/\s+/g, " ")
    .trim();
}

function safePub(s = "") {
  return String(s).replace(/[^A-Za-z0-9]/g, "");
}

function sleepMs(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function googlePatentSearchDirect(q, num = 20) {
  const limited = Math.min(Math.max(Number(num) || 20, 1), 50);
  const inner = `q=${encodeURIComponent(q)}&num=${limited}&page=1`;
  const endpoint =
    "https://patents.google.com/xhr/query?url=" +
    encodeURIComponent(inner) +
    "&exp=";

  let lastErr=null;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const r = await fetch(endpoint, {
        headers: {
          accept: "application/json,text/plain,*/*",
          "accept-language":"en-US,en;q=0.9",
          referer:"https://patents.google.com/",
          "user-agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36"
        },
      });

      const txt = await r.text();
      if(r.status===429 || r.status===503){
        lastErr=new Error(`GOOGLE_BLOCKED: Google Patents HTTP ${r.status}`);
        await sleepMs(650*(attempt+1));
        continue;
      }
      if (!r.ok) throw new Error(`Google Patents HTTP ${r.status}`);

      const brace = txt.indexOf("{");
      if (brace < 0) throw new Error("Google Patents returned an unexpected response.");

      const envelope = JSON.parse(txt.slice(brace));
      let payload = envelope.content;
      if (typeof payload === "string") payload = JSON.parse(payload);
      if (!payload) payload = envelope;

      const clusters = payload?.results?.cluster || [];
      const rows = clusters.flatMap((c) => c.result || []);
      const results=rows.map((row) => {
        const p = row.patent || {};
        const pub = p.publication_number || p.id || row.id || "";
        return {
          publication_number: pub,
          title: stripTags(p.title || ""),
          snippet: stripTags(p.snippet || ""),
          priority_date: p.priority_date || "",
          filing_date: p.filing_date || "",
          publication_date: p.publication_date || "",
          grant_date: p.grant_date || "",
          inventor: stripTags(p.inventor || ""),
          assignee: stripTags(p.assignee || ""),
          language: p.language || "",
          url: pub ? `https://patents.google.com/patent/${encodeURIComponent(pub)}/en` : "",
        };
      }).filter((x) => x.publication_number);

      return {provider:"Google Patents direct",results};
    }catch(e){
      lastErr=e;
    }
  }
  throw lastErr||new Error("Google Patents direct search failed.");
}

async function serpApiPatentSearch(q, num, apiKey){
  const u=new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine","google_patents");
  u.searchParams.set("q",q);
  u.searchParams.set("num",String(Math.min(Math.max(Number(num)||20,10),100)));
  u.searchParams.set("api_key",apiKey);

  const r=await fetch(u.toString(),{headers:{accept:"application/json"}});
  const data=await r.json();

  if(data.error){
    if(/hasn't returned any results|no results|did not return/i.test(data.error)){
      return {provider:"Google Patents via SerpApi",results:[]};
    }
    throw new Error(data.error);
  }
  if(!r.ok) throw new Error(`SerpApi HTTP ${r.status}`);

  const rows=data.organic_results||[];
  const results=rows.map(x=>{
    const pub=(x.publication_number||x.patent_id||"")
      .replace(/^patent\//,"").replace(/\/en$/,"");
    return {
      publication_number:pub,
      title:stripTags(x.title||""),
      snippet:stripTags(x.snippet||x.abstract||""),
      priority_date:x.priority_date||"",
      filing_date:x.filing_date||"",
      publication_date:x.publication_date||"",
      grant_date:x.grant_date||"",
      inventor:Array.isArray(x.inventor)?x.inventor.join(", "):(x.inventor||""),
      assignee:Array.isArray(x.assignee)?x.assignee.join(", "):(x.assignee||""),
      language:x.language||"",
      url:x.patent_link || (pub?`https://patents.google.com/patent/${encodeURIComponent(pub)}/en`:"")
    };
  }).filter(x=>x.publication_number||x.url);

  return {provider:"Google Patents via SerpApi",results};
}

function foldSearch(s){
  return String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/đ/gi,"d").toLowerCase();
}
const SEARCH_STOP_SERVER=new Set([
  "va","hoac","cua","cho","voi","trong","ngoai","tren","duoi","tu","den","tai","theo","sau","truoc","do","nay","mot","cac","nhung",
  "duoc","thuc","hien","tao","hon","hop","dung","dich","phoi","tron","thu","on","dinh","dong","thoi","tiep","bao","gom","buoc",
  "quy","trinh","phuong","phap","san","pham","he","thong","thiet","bi","nhat","bang","cach","su","nham","de","khi","neu","co","the","la",
  "and","or","with","from","wherein","method","process","comprising","comprises","including","step","steps","using","used","use","the"
]);

function coreQueryWords(s){
  return String(s||"")
    .replace(/["'()]/g," ")
    .replace(/\b(?:AND|OR|NOT)\b/gi," ")
    .split(/[^\p{L}\p{N}\-\/\.]+/u)
    .map(x=>x.trim()).filter(Boolean)
    .filter(x=>{
      const f=foldSearch(x).replace(/[^a-z0-9\-\/\.]/g,"");
      return f.length>=4 && !SEARCH_STOP_SERVER.has(f) && !/^\d+(?:[.,]\d+)?%?$/.test(f);
    });
}


const VI_PATENT_PHRASES = [
  ["hạt thanh long","dragon fruit seeds"],
  ["thanh long","dragon fruit"],
  ["nảy mầm","germination"],
  ["nảy mầm","germination"],
  ["nay mam","germination"],
  ["naymam","germination"],
  ["hạt giống","seeds"],
  ["hạt","seed"],
  ["ngâm hạt","seed soaking"],
  ["ngâm","soaking"],
  ["xử lý hạt","seed treatment"],
  ["xử lý","treatment"],
  ["gieo trồng","cultivation"],
  ["nuôi cấy","culture"],
  ["tăng tỷ lệ nảy mầm","increase germination rate"],
  ["tỷ lệ nảy mầm","germination rate"],
  ["chất kích thích sinh trưởng","plant growth regulator"],
  ["axit gibberellic","gibberellic acid"],
  ["gibberellin","gibberellin"],
  ["khử trùng","disinfection"],
  ["tia cực tím","ultraviolet"],
  ["từ trường","magnetic field"],
  ["nước từ hóa","magnetized water"],
  ["nano oxit kẽm","nano zinc oxide"],
  ["oxit kẽm","zinc oxide"],
  ["chiết xuất","extract"],
  ["dịch chiết","extract"],
  ["nồng độ","concentration"],
  ["nhiệt độ","temperature"],
  ["độ ẩm","humidity"],
  ["phương pháp","method"],
  ["quy trình","process"],
  ["thiết bị","device"],
  ["hệ thống","system"],
  ["chế phẩm","composition"],
];

function builtinViToEn(s){
  let t=String(s||"").normalize("NFC");
  // Repair a few frequent OCR joins before mapping.
  t=t.replace(/nảy\s*mầm/gi,"nảy mầm")
     .replace(/nay\s*mam/gi,"nay mam")
     .replace(/nả[yý]\s*mầm/gi,"nảy mầm");
  let folded=foldSearch(t);
  const out=[];
  for(const [vi,en] of VI_PATENT_PHRASES){
    const f=foldSearch(vi);
    if(folded.includes(f) && !out.includes(en)) out.push(en);
  }
  return out.join(" ");
}

async function googleTranslateToEnglish(text,env){
  const key=env.GOOGLE_TRANSLATE_API_KEY||env.GOOGLE_CLOUD_API_KEY;
  if(!key) return "";
  const raw=String(text||"").trim();
  if(!raw) return "";
  const u="https://translation.googleapis.com/language/translate/v2?key="+encodeURIComponent(key);
  const r=await fetch(u,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({q:raw,target:"en",format:"text"})
  });
  const data=await r.json();
  if(!r.ok || data.error) throw new Error(data?.error?.message||`Google Translation HTTP ${r.status}`);
  return String(data?.data?.translations?.[0]?.translatedText||"")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,"&");
}

async function makePatentQueryVariantsPro(q,title,env){
  const base=makePatentQueryVariants(q,title);
  const out=[];
  const add=x=>{
    x=String(x||"").replace(/\s+/g," ").trim();
    if(!x) return;
    const k=foldSearch(x);
    if(!out.some(v=>foldSearch(v)===k)) out.push(x);
  };

  // English variants first because worldwide patent corpora are indexed far better in English.
  const joined=[title,q].filter(Boolean).join(" ");
  try{
    const tr=await googleTranslateToEnglish(joined,env);
    if(coreQueryWords(tr).length>=2) add(coreQueryWords(tr).slice(0,10).join(" "));
  }catch(e){}

  const builtin=builtinViToEn(joined);
  if(coreQueryWords(builtin).length>=2) add(coreQueryWords(builtin).slice(0,10).join(" "));

  for(const x of base) add(x);

  // Extra compact variants for recall.
  const enWords=coreQueryWords(out[0]||"");
  if(enWords.length>=4) add(enWords.slice(0,4).join(" "));
  if(enWords.length>=3) add(enWords.slice(0,3).join(" "));

  return out.slice(0,8);
}

async function serpApiGooglePatentsTbm(q,num,apiKey){
  const u=new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine","google");
  u.searchParams.set("tbm","pts");
  u.searchParams.set("q",q);
  u.searchParams.set("num",String(Math.min(Math.max(Number(num)||20,10),50)));
  u.searchParams.set("api_key",apiKey);

  const r=await fetch(u.toString(),{headers:{accept:"application/json"}});
  const data=await r.json();
  if(data.error){
    if(/no results|hasn't returned|did not return/i.test(data.error))
      return {provider:"Google Patents (tbm=pts) via SerpApi",results:[]};
    throw new Error(data.error);
  }
  if(!r.ok) throw new Error(`SerpApi Google Patents tbm HTTP ${r.status}`);

  const rows=data.organic_results||data.patents_results||[];
  const results=rows.map(x=>{
    const link=x.link||x.patent_link||"";
    const mm=link.match(/patents\.google\.com\/patent\/([^/?#]+)/i);
    const pub=(x.publication_number||x.patent_id||(mm&&mm[1])||"")
      .replace(/^patent\//,"").replace(/\/en$/,"");
    if(!pub && !link) return null;
    return {
      publication_number:pub,
      title:stripTags(x.title||""),
      snippet:stripTags(x.snippet||x.abstract||""),
      priority_date:x.priority_date||"",
      filing_date:x.filing_date||"",
      publication_date:x.publication_date||x.date||"",
      grant_date:x.grant_date||"",
      inventor:Array.isArray(x.inventor)?x.inventor.join(", "):(x.inventor||""),
      assignee:Array.isArray(x.assignee)?x.assignee.join(", "):(x.assignee||""),
      language:x.language||"",
      url:link || (pub?`https://patents.google.com/patent/${encodeURIComponent(pub)}/en`:"")
    };
  }).filter(Boolean);
  return {provider:"Google Patents (tbm=pts) via SerpApi",results};
}

function makePatentQueryVariants(q,title=""){
  const out=[];
  const add=(x)=>{
    x=String(x||"").replace(/\s+/g," ").trim();
    if(!x) return;
    const key=foldSearch(x);
    if(!out.some(v=>foldSearch(v)===key)) out.push(x);
  };

  const qt=coreQueryWords(q);
  const tt=coreQueryWords(title);

  if(tt.length>=2) add(tt.slice(0,6).join(" "));
  if(qt.length>=2) add(qt.slice(0,7).join(" "));
  if(qt.length>=4) add(qt.slice(0,4).join(" "));
  if(qt.length>=3) add(qt.slice(0,3).join(" "));
  if(tt.length>=2 && qt.length>=2) add([...tt.slice(0,3),...qt.slice(0,3)].join(" "));

  const raw=String(q||"").replace(/["']/g," ").replace(/\bAND\b/gi," ").replace(/\s+/g," ").trim();
  if(coreQueryWords(raw).length>=2) add(raw);

  return out.slice(0,6);
}

async function serpApiGoogleSiteSearch(q,num,apiKey){
  const u=new URL("https://serpapi.com/search.json");
  u.searchParams.set("engine","google");
  u.searchParams.set("q",`site:patents.google.com/patent ${q}`);
  u.searchParams.set("num",String(Math.min(Math.max(Number(num)||20,10),50)));
  u.searchParams.set("api_key",apiKey);

  const r=await fetch(u.toString(),{headers:{accept:"application/json"}});
  const data=await r.json();
  if(data.error){
    if(/no results|hasn't returned/i.test(data.error)) return {provider:"Google web via SerpApi",results:[]};
    throw new Error(data.error);
  }
  if(!r.ok) throw new Error(`SerpApi Google HTTP ${r.status}`);

  const rows=data.organic_results||[];
  const results=rows.map(x=>{
    const link=x.link||"";
    const mm=link.match(/patents\.google\.com\/patent\/([^/?#]+)/i);
    if(!mm) return null;
    const pub=mm[1];
    return {
      publication_number:pub,
      title:stripTags(x.title||""),
      snippet:stripTags(x.snippet||""),
      priority_date:"",
      filing_date:"",
      publication_date:x.date||"",
      grant_date:"",
      inventor:"",
      assignee:"",
      language:"",
      url:link
    };
  }).filter(Boolean);

  return {provider:"Google web → Patents via SerpApi",results};
}

async function epoToken(key,secret){
  const basic=btoa(`${key}:${secret}`);
  const r=await fetch("https://ops.epo.org/3.2/auth/accesstoken",{
    method:"POST",
    headers:{
      "Authorization":`Basic ${basic}`,
      "Content-Type":"application/x-www-form-urlencoded"
    },
    body:"grant_type=client_credentials"
  });
  const txt=await r.text();
  if(!r.ok) throw new Error(`EPO OPS auth HTTP ${r.status}`);
  try{
    const j=JSON.parse(txt);
    if(!j.access_token) throw new Error("EPO OPS token missing");
    return j.access_token;
  }catch(_e){
    const mm=txt.match(/<access_token>([^<]+)<\/access_token>/);
    if(mm) return mm[1];
    throw new Error("Không đọc được access token EPO OPS.");
  }
}

function epoXmlResults(xml){
  const blocks=[...xml.matchAll(/<exchange-document\b[\s\S]*?<\/exchange-document>/g)].map(m=>m[0]);
  const get=(b,re)=>{const m=b.match(re);return m?stripTags(m[1]):""};
  return blocks.map(b=>{
    const country=get(b,/<country>([^<]+)<\/country>/);
    const doc=get(b,/<doc-number>([^<]+)<\/doc-number>/);
    const kind=get(b,/<kind>([^<]+)<\/kind>/);
    const pub=[country,doc,kind].join("");
    const title=get(b,/<invention-title[^>]*lang="en"[^>]*>([\s\S]*?)<\/invention-title>/i) ||
                get(b,/<invention-title[^>]*>([\s\S]*?)<\/invention-title>/i);
    const date=get(b,/<publication-reference>[\s\S]*?<date>(\d{8})<\/date>/i);
    const formatted=date?`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`:"";
    return {
      publication_number:pub,
      title,
      snippet:"",
      priority_date:"",
      filing_date:"",
      publication_date:formatted,
      grant_date:"",
      inventor:"",
      assignee:"",
      language:"en",
      url:pub?`https://worldwide.espacenet.com/patent/search?q=pn%3D${encodeURIComponent(pub)}`:""
    };
  }).filter(x=>x.publication_number);
}

async function epoOpsSearch(q,num,key,secret){
  const token=await epoToken(key,secret);
  const words=String(q).replace(/["()]/g," ").replace(/\b(?:AND|OR|NOT)\b/gi," ")
    .split(/\s+/).filter(x=>x.length>=3).slice(0,8);
  if(!words.length) throw new Error("EPO OPS: truy vấn quá ngắn.");
  const phrase=words.join(" ");
  const cql=`ta="${phrase.replace(/"/g,'')}"`;
  const url="https://ops.epo.org/3.2/rest-services/published-data/search/biblio?q="+encodeURIComponent(cql);
  const r=await fetch(url,{
    headers:{
      "Authorization":`Bearer ${token}`,
      "Accept":"application/exchange+xml",
      "Range":`1-${Math.min(Math.max(Number(num)||20,1),100)}`
    }
  });
  const xml=await r.text();
  if(!r.ok) throw new Error(`EPO OPS HTTP ${r.status}`);
  return {provider:"EPO Open Patent Services",results:epoXmlResults(xml)};
}


function attrValue(attrs,name){
  const a=(attrs||[]).find(x=>x && x.name===name);
  return a?a.value:"";
}

async function browserRunPatentSearch(q,num,env){
  if(!env.BROWSER) throw new Error("Browser Run binding chưa được cấu hình.");

  const searchUrl="https://patents.google.com/?q="+encodeURIComponent(q)+"&num="+Math.min(Math.max(Number(num)||20,1),50);
  const resp=await env.BROWSER.quickAction("scrape",{
    url:searchUrl,
    elements:[
      {selector:"search-result-item"},
      {selector:'a[href*="/patent/"]'}
    ],
    gotoOptions:{waitUntil:"networkidle2"}
  });

  const data=await resp.json();
  if(!resp.ok || data.success===false) throw new Error("Browser Run scrape thất bại.");

  const groups=data.result||data.results||[];
  const groupItems=(sel)=>{
    const g=groups.find(x=>x.selector===sel);
    return g?.results||[];
  };

  let results=[];
  const items=groupItems("search-result-item");

  for(const it of items){
    const h=String(it.html||"");
    const t=stripTags(it.text||h);
    const mm=h.match(/href="(?:https:\/\/patents\.google\.com)?\/patent\/([^"?#/]+)(?:\/[^"?#]*)?"/i);
    if(!mm) continue;
    const pub=mm[1].replace(/[^A-Za-z0-9]/g,"");
    const titleMatch=h.match(/<a[^>]+href="[^"]*\/patent\/[^"]+"[^>]*>([\s\S]*?)<\/a>/i);
    const dates=[...t.matchAll(/\b(19|20)\d{2}-\d{2}-\d{2}\b/g)].map(x=>x[0]);
    results.push({
      publication_number:pub,
      title:stripTags(titleMatch?.[1]||t.slice(0,220)),
      snippet:t.slice(0,700),
      priority_date:dates[0]||"",
      filing_date:"",
      publication_date:dates[1]||dates[0]||"",
      grant_date:"",
      inventor:"",
      assignee:"",
      language:"",
      url:`https://patents.google.com/patent/${encodeURIComponent(pub)}/en`
    });
  }

  if(!results.length){
    const links=groupItems('a[href*="/patent/"]');
    for(const a of links){
      const href=attrValue(a.attributes,"href");
      const mm=href.match(/\/patent\/([^/?#]+)(?:\/[^?#]*)?/i);
      if(!mm) continue;
      const pub=mm[1].replace(/[^A-Za-z0-9]/g,"");
      results.push({
        publication_number:pub,
        title:stripTags(a.text||a.html||pub),
        snippet:"",
        priority_date:"",
        filing_date:"",
        publication_date:"",
        grant_date:"",
        inventor:"",
        assignee:"",
        language:"",
        url:href.startsWith("http")?href:`https://patents.google.com${href}`
      });
    }
  }

  const seen=new Set();
  results=results.filter(x=>{
    const k=x.publication_number;
    if(!k||seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0,Math.min(Number(num)||20,50));

  if(!results.length) throw new Error("Browser Run không trích được kết quả Google Patents.");
  return {provider:"Google Patents via Cloudflare Browser Run",results};
}

async function patentSearch(q,num,env,title=""){
  const errors=[];
  const variants=await makePatentQueryVariantsPro(q,title,env);
  let attempts=0;

  if(!variants.length){
    const err=new Error("NO_RESULTS: Truy vấn không có đủ thuật ngữ kỹ thuật.");
    err.code="NO_RESULTS"; err.attempt_count=0; throw err;
  }

  if(env.SERPAPI_KEY){
    // 1) Dedicated Google Patents engine
    for(const v of variants.slice(0,5)){
      attempts++;
      try{
        const x=await serpApiPatentSearch(v,num,env.SERPAPI_KEY);
        if(x.results.length) return {...x,query_used:v,attempt_count:attempts};
      }catch(e){errors.push("SerpApi Patents: "+String(e.message||e))}
    }

    // 2) Google Search patents tab (tbm=pts) via the same SerpApi key
    for(const v of variants.slice(0,4)){
      attempts++;
      try{
        const x=await serpApiGooglePatentsTbm(v,num,env.SERPAPI_KEY);
        if(x.results.length) return {...x,query_used:v,attempt_count:attempts};
      }catch(e){errors.push("SerpApi Patents tab: "+String(e.message||e))}
    }

    // 3) Normal Google web search restricted to patents.google.com
    for(const v of variants.slice(0,3)){
      attempts++;
      try{
        const x=await serpApiGoogleSiteSearch(v,num,env.SERPAPI_KEY);
        if(x.results.length) return {...x,query_used:v,attempt_count:attempts};
      }catch(e){errors.push("SerpApi Web: "+String(e.message||e))}
    }
  }

  if(env.BROWSER){
    for(const v of variants.slice(0,2)){
      attempts++;
      try{
        const x=await browserRunPatentSearch(v,num,env);
        if(x.results.length) return {...x,query_used:v,attempt_count:attempts};
      }catch(e){errors.push("Browser Run: "+String(e.message||e))}
    }
  }

  // Only use Google direct when SerpApi is NOT configured.
  // This avoids confusing 503 noise when a stable provider is already available.
  if(!env.SERPAPI_KEY){
    for(const v of variants.slice(0,2)){
      attempts++;
      try{
        const x=await googlePatentSearchDirect(v,num);
        if(x.results.length) return {...x,query_used:v,attempt_count:attempts};
      }catch(e){errors.push("Google direct: "+String(e.message||e))}
    }
  }

  if(env.EPO_CONSUMER_KEY && env.EPO_CONSUMER_SECRET){
    for(const v of variants.slice(0,2)){
      attempts++;
      try{
        const x=await epoOpsSearch(v,num,env.EPO_CONSUMER_KEY,env.EPO_CONSUMER_SECRET);
        if(x.results.length) return {...x,query_used:v,attempt_count:attempts};
      }catch(e){errors.push("EPO OPS: "+String(e.message||e))}
    }
  }

  const err=new Error(
    "NO_RESULTS: Đã thử "+attempts+" truy vấn mở rộng nhưng chưa tìm thấy tài liệu phù hợp."
    +(errors.length?" | "+errors.slice(-2).join(" | "):"")
  );
  err.code="NO_RESULTS";
  err.attempt_count=attempts;
  err.variants=variants;
  throw err;
}

async function googlePatentDetail(pub) {
  const id = safePub(pub);
  if (!id) throw new Error("Invalid publication number.");

  const url = `https://patents.google.com/patent/${id}/en`;
  const r = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 PatentLensResearch/1.0" },
  });

  if (!r.ok) throw new Error(`Patent detail HTTP ${r.status}`);

  const result = { title: "", abstract: "", claims: "", url };
  const abstractParts = [];
  const claimParts = [];

  const transformed = new HTMLRewriter()
    .on('meta[name="DC.title"]', {
      element(el) {
        const v = el.getAttribute("content");
        if (v && !result.title) result.title = v;
      },
    })
    .on("div.abstract", {
      text(t) {
        abstractParts.push(t.text);
      },
    })
    .on("div.claim", {
      text(t) {
        claimParts.push(t.text);
      },
    })
    .transform(r);

  await transformed.text();

  result.abstract = abstractParts.join(" ").replace(/\s+/g, " ").trim();
  result.claims = claimParts.join("\n").replace(/[ \t]+/g, " ").trim();
  return result;
}

async function googleVisionOcr(imageBase64,env){
  const key=env.GOOGLE_VISION_API_KEY||env.GOOGLE_CLOUD_API_KEY;
  if(!key){
    const e=new Error("Google Vision OCR chưa được cấu hình.");
    e.code="VISION_NOT_CONFIGURED";
    throw e;
  }
  if(!imageBase64 || imageBase64.length<100){
    throw new Error("Ảnh OCR không hợp lệ.");
  }

  const r=await fetch("https://vision.googleapis.com/v1/images:annotate?key="+encodeURIComponent(key),{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({
      requests:[{
        image:{content:imageBase64},
        features:[{type:"DOCUMENT_TEXT_DETECTION"}],
        imageContext:{languageHints:["vi","en"]}
      }]
    })
  });

  const data=await r.json();
  if(!r.ok) throw new Error(data?.error?.message||`Google Vision HTTP ${r.status}`);
  const item=data?.responses?.[0]||{};
  if(item.error) throw new Error(item.error.message||"Google Vision OCR lỗi.");
  const text=item?.fullTextAnnotation?.text || item?.textAnnotations?.[0]?.description || "";
  return String(text||"").normalize("NFC");
}

async function handleApi(request, env) {
  const u = new URL(request.url);

  if (u.pathname === "/api/health") {
    return json({
      ok: true,
      service: "PatentLens AI",
      backend: "Cloudflare Worker",
      version: "9.1.0",
      time: new Date().toISOString(),
      providers: {
        serpapi: !!env.SERPAPI_KEY,
        browser_run: !!env.BROWSER,
        epo_ops: !!(env.EPO_CONSUMER_KEY && env.EPO_CONSUMER_SECRET),
        google_vision: !!(env.GOOGLE_VISION_API_KEY || env.GOOGLE_CLOUD_API_KEY),
        google_translate: !!(env.GOOGLE_TRANSLATE_API_KEY || env.GOOGLE_CLOUD_API_KEY),
        google_direct: true
      }
    });
  }

  if (u.pathname === "/api/ocr" && request.method === "POST") {
    try{
      const body=await request.json();
      const text=await googleVisionOcr(body.image_base64||"",env);
      return json({ok:true,provider:"Google Cloud Vision DOCUMENT_TEXT_DETECTION",text});
    }catch(e){
      const code=e.code||"OCR_FAILED";
      return json({ok:false,code,error:String(e.message||e)},code==="VISION_NOT_CONFIGURED"?501:502);
    }
  }

  if (u.pathname === "/api/search") {
    const q = (u.searchParams.get("q") || "").trim();
    const title = (u.searchParams.get("title") || "").trim();
    if (!q) return json({ ok: false, error: "Thiếu truy vấn q." }, 400);

    try{
      const out = await patentSearch(q, u.searchParams.get("num") || 20, env, title);
      return json({
        ok: true,
        provider: out.provider,
        query: q,
        query_used: out.query_used || q,
        attempt_count: out.attempt_count || 1,
        count: out.results.length,
        results: out.results,
        verification_sources: ["Google Patents", "WIPO PATENTSCOPE", "EPO Espacenet"],
      });
    }catch(e){
      return json({
        ok:false,
        code:e.code||"SEARCH_FAILED",
        error:String(e.message||e),
        attempt_count:e.attempt_count||0,
        query_variants:e.variants||[],
        hint:e.code==="NO_RESULTS"
          ?"Hệ thống đã tự nới truy vấn. Kiểm tra lại title/claim hoặc thử thêm thuật ngữ tiếng Anh kỹ thuật."
          :"Kiểm tra provider và API key trong Cloudflare Worker secrets."
      },503);
    }
  }

  if (u.pathname === "/api/detail") {
    const pub = (u.searchParams.get("pub") || "").trim();
    if (!pub) return json({ ok: false, error: "Thiếu publication number." }, 400);

    const detail = await googlePatentDetail(pub);
    return json({ ok: true, publication_number: pub, ...detail });
  }

  return json({ ok: false, error: "API route không tồn tại." }, 404);
}

const APP_HTML_B64 = "PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InZpIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ii8+CjxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xIi8+Cjx0aXRsZT5QYXRlbnRMZW5zIEFJIOKAlCBRdXkgdHLDrG5oIHBow6JuIHTDrWNoIHPDoW5nIGNo4bq/PC90aXRsZT4KPG1ldGEgbmFtZT0iZGVzY3JpcHRpb24iIGNvbnRlbnQ9IlByb3RvdHlwZSBuZ2hpw6puIGPhu6l1IGjhu5cgdHLhu6MgdHJhIGPhu6l1IHbDoCDEkcOhbmggZ2nDoSBzxqEgYuG7mSBzw6FuZyBjaOG6vyB0aGVvIGNodeG7l2kgQ2xhaW0g4oaSIEZlYXR1cmUg4oaSIFNlYXJjaCDihpIgUHJpb3IgQXJ0IOKGkiBOb3ZlbHR5IOKGkiBJbnZlbnRpdmUgU3RlcCDihpIgRXhwZXJ0IFJldmlldy4iLz4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuanMuY2xvdWRmbGFyZS5jb20vYWpheC9saWJzL3BkZi5qcy8zLjExLjE3NC9wZGYubWluLmpzIj48L3NjcmlwdD4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9ucG0vdGVzc2VyYWN0LmpzQDUuMS4xL2Rpc3QvdGVzc2VyYWN0Lm1pbi5qcyI+PC9zY3JpcHQ+CjxzdHlsZT4KOnJvb3R7CiAgLS1iZzojZjZmN2Y5Oy0tc3VyZmFjZTojZmZmOy0tc3VyZmFjZTI6I2Y5ZmFmYjstLXRleHQ6IzEwMTgyODstLW11dGVkOiM2NjcwODU7CiAgLS1saW5lOiNlNGU3ZWM7LS1kYXJrOiMxMDE4Mjg7LS1zb2Z0OiNmMmY0Zjc7LS1ncmVlbjojMDY3NjQ3Oy0tZ3JlZW5iZzojZWNmZGYzOwogIC0teWVsbG93OiNiNTQ3MDg7LS15ZWxsb3diZzojZmZmYWViOy0tcmVkOiNiNDIzMTg7LS1yZWRiZzojZmVmM2YyOy0tYmx1ZTojMTc1Y2QzOwogIC0tYmx1ZWJnOiNlZmY4ZmY7LS1zaGFkb3c6MCAxMnB4IDM2cHggcmdiYSgxNiwyNCw0MCwuMDYpOy0tcmFkaXVzOjE4cHgKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH1odG1se3Njcm9sbC1iZWhhdmlvcjpzbW9vdGh9CmJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDp2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7Zm9udC1mYW1pbHk6SW50ZXIsdWktc2Fucy1zZXJpZiwtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwiU2Vnb2UgVUkiLFJvYm90byxBcmlhbCxzYW5zLXNlcmlmfQpidXR0b24saW5wdXQsdGV4dGFyZWEsc2VsZWN0e2ZvbnQ6aW5oZXJpdH1idXR0b257Y3Vyc29yOnBvaW50ZXJ9Ci5hcHB7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczoyNzVweCAxZnI7bWluLWhlaWdodDoxMDB2aH0KYXNpZGV7cG9zaXRpb246c3RpY2t5O3RvcDowO2hlaWdodDoxMDB2aDtiYWNrZ3JvdW5kOiMwZjExMTU7Y29sb3I6I2ZmZjtwYWRkaW5nOjI0cHggMThweDtib3JkZXItcmlnaHQ6MXB4IHNvbGlkICMyMjI4MzF9Ci5icmFuZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O3BhZGRpbmc6MCA4cHg7bWFyZ2luLWJvdHRvbToyNnB4fQoubG9nb3t3aWR0aDozOXB4O2hlaWdodDozOXB4O2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6IzExMTtkaXNwbGF5OmdyaWQ7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtd2VpZ2h0OjkwMH0KLmJyYW5kIHN0cm9uZ3tmb250LXNpemU6MTZweH0uYnJhbmQgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojOThhMmIzO21hcmdpbi10b3A6M3B4fQoucHJvY2Vzc3tkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo3cHh9Ci5wcm9jZXNzLWl0ZW17cGFkZGluZzoxMXB4IDEycHg7Ym9yZGVyLXJhZGl1czoxMnB4O2NvbG9yOiM4Zjk4YTY7ZGlzcGxheTpmbGV4O2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtmb250LXNpemU6MTNweH0KLnByb2Nlc3MtaXRlbSAubnt3aWR0aDoyNXB4O2hlaWdodDoyNXB4O2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7Ym9yZGVyLXJhZGl1czo4cHg7YmFja2dyb3VuZDojMjYyYjMzO2ZvbnQtc2l6ZToxMnB4fQoucHJvY2Vzcy1pdGVtLmFjdGl2ZXtiYWNrZ3JvdW5kOiMxZDIxMjg7Y29sb3I6I2ZmZn0KLnByb2Nlc3MtaXRlbS5kb25le2NvbG9yOiNkMGQ1ZGR9LnByb2Nlc3MtaXRlbS5kb25lIC5ue2JhY2tncm91bmQ6IzM0NDA1NDtjb2xvcjojZmZmfQouc2lkZS1ub3Rle3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MThweDtyaWdodDoxOHB4O2JvdHRvbToyMHB4O3BhZGRpbmc6MTRweDtib3JkZXItcmFkaXVzOjE0cHg7YmFja2dyb3VuZDojMTcxYTIwO2JvcmRlcjoxcHggc29saWQgIzI3MmMzNDtjb2xvcjojOThhMmIzO2ZvbnQtc2l6ZToxMnB4O2xpbmUtaGVpZ2h0OjEuNTV9Cm1haW57cGFkZGluZzozNHB4IDM4cHggMTIwcHg7bWluLXdpZHRoOjB9Ci50b3B7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTZweDttYXJnaW4tYm90dG9tOjIwcHh9Cmgxe2ZvbnQtc2l6ZToyOHB4O2xldHRlci1zcGFjaW5nOi0uMDRlbTttYXJnaW46MH0udG9wIHB7bWFyZ2luOjZweCAwIDA7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxNHB4fQouY2FzZS1iYWRnZXtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nOjlweCAxMnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7Y29sb3I6IzQ3NTQ2Nztmb250LXNpemU6MTJweDt3aGl0ZS1zcGFjZTpub3dyYXB9Ci5sb2NhbC1iYW5uZXJ7cGFkZGluZzoxM3B4IDE1cHg7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbi1ib3R0b206MTZweDtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU7Ym9yZGVyOjFweCBzb2xpZCAjZmVkZjg5O2JhY2tncm91bmQ6dmFyKC0teWVsbG93YmcpO2NvbG9yOiM3YTJlMGV9Ci5zZWN0aW9ue2Rpc3BsYXk6bm9uZX0uc2VjdGlvbi5hY3RpdmV7ZGlzcGxheTpibG9ja30KLnBhbmVse2JhY2tncm91bmQ6dmFyKC0tc3VyZmFjZSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3gtc2hhZG93OnZhcigtLXNoYWRvdyk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjRweDttYXJnaW4tYm90dG9tOjE4cHh9Ci5wYW5lbCBoMnttYXJnaW46MCAwIDZweDtmb250LXNpemU6MjBweDtsZXR0ZXItc3BhY2luZzotLjAyZW19LnN1Yntjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjE0cHg7bGluZS1oZWlnaHQ6MS41NTttYXJnaW4tYm90dG9tOjIwcHh9Ci5ncmlke2Rpc3BsYXk6Z3JpZDtnYXA6MTRweH0uZzJ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfS5nM3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9CmxhYmVse2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NzUwO2NvbG9yOiM0NzU0Njc7bWFyZ2luLWJvdHRvbTo3cHh9CmlucHV0LHRleHRhcmVhLHNlbGVjdHt3aWR0aDoxMDAlO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojZmZmO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEycHggMTNweDtvdXRsaW5lOm5vbmU7Y29sb3I6IzExMTgyN30KaW5wdXQ6Zm9jdXMsdGV4dGFyZWE6Zm9jdXMsc2VsZWN0OmZvY3Vze2JvcmRlci1jb2xvcjojOThhMmIzO2JveC1zaGFkb3c6MCAwIDAgM3B4IHJnYmEoMTcsMjQsMzksLjA1KX0KdGV4dGFyZWF7cmVzaXplOnZlcnRpY2FsO21pbi1oZWlnaHQ6MTEwcHh9Ci5kcm9we2JvcmRlcjoxLjVweCBkYXNoZWQgI2NmZDRkYztib3JkZXItcmFkaXVzOjE2cHg7YmFja2dyb3VuZDojZmFmYmZjO3BhZGRpbmc6MzBweDt0ZXh0LWFsaWduOmNlbnRlcjt0cmFuc2l0aW9uOi4yc30KLmRyb3AuZHJhZ3tib3JkZXItY29sb3I6IzY2NzA4NTtiYWNrZ3JvdW5kOiNmMmY0Zjd9LmRyb3Agc3Ryb25ne2Rpc3BsYXk6YmxvY2s7bWFyZ2luLWJvdHRvbTo2cHh9LmRyb3Agc21hbGx7Y29sb3I6dmFyKC0tbXV0ZWQpfQouYWN0aW9uc3tkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7ZmxleC13cmFwOndyYXA7bWFyZ2luLXRvcDoxNnB4fQouYnRue2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojZmZmO2NvbG9yOiMxMTE4Mjc7Ym9yZGVyLXJhZGl1czoxMXB4O3BhZGRpbmc6MTBweCAxNHB4O2ZvbnQtc2l6ZToxM3B4O2ZvbnQtd2VpZ2h0Ojc1MH0KLmJ0bjpob3ZlcntiYWNrZ3JvdW5kOiNmOGZhZmN9LmJ0bi5wcmltYXJ5e2JhY2tncm91bmQ6IzExMTgyNztjb2xvcjojZmZmO2JvcmRlci1jb2xvcjojMTExODI3fS5idG4uc3VjY2Vzc3tiYWNrZ3JvdW5kOnZhcigtLWdyZWVuYmcpO2NvbG9yOnZhcigtLWdyZWVuKTtib3JkZXItY29sb3I6I2FiZWZjNn0uYnRuLmRhbmdlcntjb2xvcjp2YXIoLS1yZWQpfQoucHJvZ3Jlc3N7aGVpZ2h0OjhweDtiYWNrZ3JvdW5kOiNlZWYwZjM7Ym9yZGVyLXJhZGl1czo5OXB4O292ZXJmbG93OmhpZGRlbjttYXJnaW4tdG9wOjE0cHh9LnByb2dyZXNzPmRpdntoZWlnaHQ6MTAwJTtiYWNrZ3JvdW5kOiMxMTE4Mjc7d2lkdGg6MCU7dHJhbnNpdGlvbjouMjVzfQouc3RhdHVze2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjhweDtsaW5lLWhlaWdodDoxLjV9Ci5kZXRlY3R7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNCwxZnIpO2dhcDoxMHB4fQouZGV0ZWN0LWNhcmR7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7cGFkZGluZzoxNHB4O2JhY2tncm91bmQ6I2ZmZn0KLmRldGVjdC1jYXJkIGJ7Zm9udC1zaXplOjEzcHh9LmRldGVjdC1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLXRvcDo0cHh9Ci5kZXRlY3QtY2FyZC5va3tiYWNrZ3JvdW5kOnZhcigtLWdyZWVuYmcpO2JvcmRlci1jb2xvcjojYWJlZmM2fS5kZXRlY3QtY2FyZC53YXJue2JhY2tncm91bmQ6dmFyKC0teWVsbG93YmcpO2JvcmRlci1jb2xvcjojZmVkZjg5fQouc3VtbWFyeXtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjE2MHB4IDFmcjtnYXA6OHB4IDE2cHg7Zm9udC1zaXplOjEzcHh9LnN1bW1hcnkgZGl2Om50aC1jaGlsZChvZGQpe2NvbG9yOiM2NjcwODV9Ci5jYWxsb3V0e3BhZGRpbmc6MTVweDtib3JkZXI6MXB4IHNvbGlkICNkMGQ1ZGQ7YmFja2dyb3VuZDojZjhmYWZjO2JvcmRlci1yYWRpdXM6MTRweDtjb2xvcjojNDc1NDY3O2ZvbnQtc2l6ZToxM3B4O2xpbmUtaGVpZ2h0OjEuNTV9LmNhbGxvdXQgc3Ryb25ne2NvbG9yOiMxMTE4Mjd9Ci50YWJsZS13cmFwe292ZXJmbG93OmF1dG87Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHh9dGFibGV7d2lkdGg6MTAwJTtib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7Zm9udC1zaXplOjEzcHh9dGh7YmFja2dyb3VuZDojZjhmYWZjO2NvbG9yOiM0NzU0Njc7dGV4dC1hbGlnbjpsZWZ0O2ZvbnQtc2l6ZToxMnB4fXRoLHRke3BhZGRpbmc6MTJweCAxMHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpO3ZlcnRpY2FsLWFsaWduOnRvcH10cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLnBpbGx7ZGlzcGxheTppbmxpbmUtZmxleDtwYWRkaW5nOjVweCA4cHg7Ym9yZGVyLXJhZGl1czo5OTlweDtiYWNrZ3JvdW5kOiNmMmY0Zjc7Y29sb3I6IzM0NDA1NDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo4MDB9LmdyZWVue2JhY2tncm91bmQ6dmFyKC0tZ3JlZW5iZyk7Y29sb3I6dmFyKC0tZ3JlZW4pfS55ZWxsb3d7YmFja2dyb3VuZDp2YXIoLS15ZWxsb3diZyk7Y29sb3I6dmFyKC0teWVsbG93KX0ucmVke2JhY2tncm91bmQ6dmFyKC0tcmVkYmcpO2NvbG9yOnZhcigtLXJlZCl9LmJsdWV7YmFja2dyb3VuZDp2YXIoLS1ibHVlYmcpO2NvbG9yOnZhcigtLWJsdWUpfQouY2xhaW0sLmRvY3tib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjE1cHg7YmFja2dyb3VuZDojZmZmfS5jbGFpbSsuY2xhaW0sLmRvYysuZG9je21hcmdpbi10b3A6MTBweH0uY2xhaW0gaDQsLmRvYyBoNHttYXJnaW46MCAwIDdweDtmb250LXNpemU6MTRweH0uY2xhaW0gcCwuZG9jIHB7bWFyZ2luOjA7Y29sb3I6IzVmNmI3YTtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU1fQouc3BsaXR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczptaW5tYXgoMCwxLjE1ZnIpIG1pbm1heCgzMjBweCwuODVmcik7Z2FwOjE4cHh9Ci5yaXNre2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTRweDthbGlnbi1pdGVtczpjZW50ZXI7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4fS5yaXNrIGgze21hcmdpbjowIDAgNXB4O2ZvbnQtc2l6ZToxNnB4fS5yaXNrIHB7bWFyZ2luOjA7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxM3B4fS5yaXNrYm94e21pbi13aWR0aDoxNDVweDt0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjEycHg7Ym9yZGVyLXJhZGl1czoxNHB4O2ZvbnQtd2VpZ2h0OjkwMH0KLmRpdmlkZXJ7aGVpZ2h0OjFweDtiYWNrZ3JvdW5kOnZhcigtLWxpbmUpO21hcmdpbjoxOHB4IDB9LmVtcHR5e3BhZGRpbmc6MjZweDtib3JkZXI6MXB4IGRhc2hlZCAjZDBkNWRkO2JvcmRlci1yYWRpdXM6MTRweDt0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjojOThhMmIzfQpjb2Rle2ZvbnQtZmFtaWx5OnVpLW1vbm9zcGFjZSxTRk1vbm8tUmVndWxhcixNZW5sbyxtb25vc3BhY2U7Zm9udC1zaXplOjEycHh9LnJlcG9ydHtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHg7cGFkZGluZzoyNHB4O2xpbmUtaGVpZ2h0OjEuNjV9LnJlcG9ydCBoM3ttYXJnaW4tdG9wOjI0cHh9LnJlcG9ydCBoMzpmaXJzdC1jaGlsZHttYXJnaW4tdG9wOjB9Ci53aXphcmRiYXJ7cG9zaXRpb246Zml4ZWQ7bGVmdDoyNzVweDtyaWdodDowO2JvdHRvbTowO2JhY2tncm91bmQ6cmdiYSgyNDYsMjQ3LDI0OSwuOTQpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWxpbmUpO3BhZGRpbmc6MTNweCAzOHB4O3otaW5kZXg6MjB9Ci53aXphcmRpbm5lcnttYXgtd2lkdGg6MTQwMHB4O21hcmdpbjphdXRvO2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEycHh9Ci53aXphcmRtZXRhe2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKX0ud2l6YXJkbWV0YSBzdHJvbmd7ZGlzcGxheTpibG9jaztjb2xvcjojMzQ0MDU0O2ZvbnQtc2l6ZToxM3B4O21hcmdpbi1ib3R0b206MnB4fQoubmV4dGJ0bnttaW4td2lkdGg6MTUwcHh9LmJhY2tidG57bWluLXdpZHRoOjEwNXB4fQouaGlkZGVue2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9CkBtZWRpYShtYXgtd2lkdGg6OTgwcHgpey5hcHB7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn1hc2lkZXtwb3NpdGlvbjpyZWxhdGl2ZTtoZWlnaHQ6YXV0b30uc2lkZS1ub3Rle3Bvc2l0aW9uOnN0YXRpYzttYXJnaW4tdG9wOjE4cHh9LnByb2Nlc3N7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpfW1haW57cGFkZGluZzoyMnB4IDE2cHggMTIwcHh9LmcyLC5nMywuc3BsaXQsLmRldGVjdHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS53aXphcmRiYXJ7bGVmdDowO3BhZGRpbmc6MTJweCAxNnB4fS50b3B7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59fQpAbWVkaWEgcHJpbnR7YXNpZGUsLnRvcCwud2l6YXJkYmFyLC5uby1wcmludCwuYWN0aW9uc3tkaXNwbGF5Om5vbmUhaW1wb3J0YW50fS5hcHB7ZGlzcGxheTpibG9ja31tYWlue3BhZGRpbmc6MH0uc2VjdGlvbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fSNyZXBvcnQuc2VjdGlvbntkaXNwbGF5OmJsb2NrIWltcG9ydGFudH0ucGFuZWx7Ym9yZGVyOjA7Ym94LXNoYWRvdzpub25lO3BhZGRpbmc6MH1ib2R5e2JhY2tncm91bmQ6I2ZmZn19CgovKiA9PT09PSB2NiBVWCByZWZpbmVtZW50cyA9PT09PSAqLwouY2xhaW0tY2xlYW57CiAgZm9udC1mYW1pbHk6QXJpYWwsIkhlbHZldGljYSBOZXVlIiwiU2Vnb2UgVUkiLHNhbnMtc2VyaWY7CiAgZm9udC1zaXplOjE0cHg7bGluZS1oZWlnaHQ6MS43ODtjb2xvcjojMzQ0MDU0O3doaXRlLXNwYWNlOnByZS13cmFwOwp9Ci5jbGFpbS1yYXd7CiAgZm9udC1mYW1pbHk6dWktbW9ub3NwYWNlLFNGTW9uby1SZWd1bGFyLE1lbmxvLENvbnNvbGFzLG1vbm9zcGFjZSFpbXBvcnRhbnQ7CiAgZm9udC1zaXplOjEycHghaW1wb3J0YW50O2xpbmUtaGVpZ2h0OjEuNiFpbXBvcnRhbnQ7YmFja2dyb3VuZDojZjhmYWZjIWltcG9ydGFudDsKfQouY2xhaW0tc3RlcHsKICBkaXNwbGF5OmJsb2NrO21hcmdpbjo4cHggMDtwYWRkaW5nLWxlZnQ6MTRweDtib3JkZXItbGVmdDoycHggc29saWQgI2U0ZTdlYzsKfQouZmVhdHVyZS1yZXZpZXctYmFyewogIHBvc2l0aW9uOnN0aWNreTt0b3A6MTJweDt6LWluZGV4Ojg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICBnYXA6MTZweDtwYWRkaW5nOjE0cHggMTZweDttYXJnaW46MTZweCAwO2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuOTYpOwogIGJhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JvcmRlcjoxcHggc29saWQgI2QwZDVkZDtib3JkZXItcmFkaXVzOjE0cHg7CiAgYm94LXNoYWRvdzowIDEwcHggMjhweCByZ2JhKDE2LDI0LDQwLC4wOSkKfQouZmVhdHVyZS1yZXZpZXctYmFyIC5tZXRhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEwcHg7ZmxleC13cmFwOndyYXB9Ci5mZWF0dXJlLXJldmlldy1iYXIgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5mZWF0dXJlLXJldmlldy1iYXIgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojNjY3MDg1O21hcmdpbi10b3A6M3B4fQouZmVhdHVyZS1jb25maXJtZWR7Ym9yZGVyLWNvbG9yOiNhYmVmYzY7YmFja2dyb3VuZDpyZ2JhKDIzNiwyNTMsMjQzLC45Nyl9Ci5zZWFyY2gtaGVyb3sKICBwYWRkaW5nOjE3cHg7Ym9yZGVyOjFweCBzb2xpZCAjZDBkNWRkO2JvcmRlci1yYWRpdXM6MTZweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxODBkZWcsI2ZmZiwjZjhmYWZjKTsKICBtYXJnaW4tYm90dG9tOjE2cHgKfQouc291cmNlLXJvd3tkaXNwbGF5OmZsZXg7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5zb3VyY2UtY2hpcHsKICBkaXNwbGF5OmlubGluZS1mbGV4O2dhcDo2cHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgI2QwZDVkZDtiYWNrZ3JvdW5kOiNmZmY7CiAgY29sb3I6IzM0NDA1NDtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6N3B4IDEwcHg7Zm9udC1zaXplOjEycHg7dGV4dC1kZWNvcmF0aW9uOm5vbmU7Zm9udC13ZWlnaHQ6NzAwCn0KLnNvdXJjZS1jaGlwOmhvdmVye2JhY2tncm91bmQ6I2YyZjRmN30KLnNlYXJjaC10b29sYmFye2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjEwcHg7bWFyZ2luLXRvcDoxNHB4fQouc2VhcmNoLXN0YXRle2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM2NjcwODU7bWFyZ2luLXRvcDoxMHB4O2xpbmUtaGVpZ2h0OjEuNX0KLnNlYXJjaC1yZXN1bHQtdGl0bGV7Zm9udC13ZWlnaHQ6NzUwO2NvbG9yOiMxMDE4Mjg7dGV4dC1kZWNvcmF0aW9uOm5vbmV9LnNlYXJjaC1yZXN1bHQtdGl0bGU6aG92ZXJ7dGV4dC1kZWNvcmF0aW9uOnVuZGVybGluZX0KLnNjb3Jle2ZvbnQtd2VpZ2h0Ojg1MDtmb250LXNpemU6MTNweH0KLnNjb3JlLmhpZ2h7Y29sb3I6IzA2NzY0N30uc2NvcmUubWlke2NvbG9yOiNiNTQ3MDh9LnNjb3JlLmxvd3tjb2xvcjojNjY3MDg1fQouY2FuZGlkYXRlLWFjdGlvbnN7ZGlzcGxheTpmbGV4O2dhcDo2cHg7ZmxleC13cmFwOndyYXB9Ci5zbG90YnRue3BhZGRpbmc6NnB4IDlweDtib3JkZXItcmFkaXVzOjlweDtib3JkZXI6MXB4IHNvbGlkICNkMGQ1ZGQ7YmFja2dyb3VuZDojZmZmO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MH0KLnNsb3RidG46aG92ZXJ7YmFja2dyb3VuZDojZjJmNGY3fQoucHJpb3Itc2xvdHsKICBib3JkZXI6MXB4IHNvbGlkICNlNGU3ZWM7Ym9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MTRweDtiYWNrZ3JvdW5kOiNmZmYKfQoucHJpb3Itc2xvdC5zZWxlY3RlZHtib3JkZXItY29sb3I6Izg0YWRmZjtib3gtc2hhZG93OjAgMCAwIDNweCAjZWZmOGZmfQouc2V0dGluZ3MtZ3JpZHtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmVuZH0KLmJhY2tlbmQtb2t7Y29sb3I6IzA2NzY0N30uYmFja2VuZC1iYWR7Y29sb3I6I2I0MjMxOH0KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgLmZlYXR1cmUtcmV2aWV3LWJhcntwb3NpdGlvbjpzdGF0aWM7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59CiAgLnNlYXJjaC10b29sYmFyLC5zZXR0aW5ncy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9Cn0KCjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+CjxkaXYgY2xhc3M9ImFwcCI+Cjxhc2lkZT4KICA8ZGl2IGNsYXNzPSJicmFuZCI+PGRpdiBjbGFzcz0ibG9nbyI+UDwvZGl2PjxkaXY+PHN0cm9uZz5QYXRlbnRMZW5zIEFJPC9zdHJvbmc+PHNtYWxsPlByb3RvdHlwZSBuZ2hpw6puIGPhu6l1IMK3IEZ1bGwtc3RhY2sgdjkuMSBQcm8uMiBQcm88L3NtYWxsPjwvZGl2PjwvZGl2PgogIDxkaXYgY2xhc3M9InByb2Nlc3MiIGlkPSJwcm9jZXNzIj48L2Rpdj4KICA8ZGl2IGNsYXNzPSJzaWRlLW5vdGUiPjxzdHJvbmcgc3R5bGU9ImNvbG9yOiNmZmYiPlBo4bqhbSB2aSBwcm90b3R5cGU8L3N0cm9uZz48YnIvPkjhu5cgdHLhu6MgY2h14buXaSB0cmEgY+G7qXUgdsOgIMSRw6FuaCBnacOhIHPGoSBi4buZIHPDoW5nIGNo4bq/LiBLaMO0bmcgdGhheSB0aOG6vyBjaHV5w6puIGdpYSB2w6Aga2jDtG5nIMSR4bqhaSBkaeG7h24gdG/DoG4gYuG7mSBxdXkgdHLDrG5oIHjDoWMgbOG6rXAgcXV54buBbiBj4bunYSBJUCBHUk9VUC48L2Rpdj4KPC9hc2lkZT4KCjxtYWluPgogIDxkaXYgY2xhc3M9InRvcCI+PGRpdj48aDEgaWQ9InBhZ2VUaXRsZSI+PC9oMT48cCBpZD0icGFnZVN1YiI+PC9wPjwvZGl2PjxkaXYgY2xhc3M9ImNhc2UtYmFkZ2UiIGlkPSJjYXNlQmFkZ2UiPkNoxrBhIGPDsyBjYXNlPC9kaXY+PC9kaXY+CiAgPGRpdiBjbGFzcz0ibG9jYWwtYmFubmVyIiBpZD0ibG9jYWxCYW5uZXIiIHN0eWxlPSJkaXNwbGF5Om5vbmUiPkLhuqFuIMSRYW5nIG3hu58gYuG6sW5nIDxzdHJvbmc+ZmlsZTovLzwvc3Ryb25nPi4gQ2hyb21lIGPDsyB0aOG7gyBjaOG6t24gV2ViIFdvcmtlciBkw7luZyBjaG8gT0NSLiBC4bqjbiBuw6B5IHbhuqtuIGPhu5EgxJHhu41jIFBERiBi4bqxbmcgdGV4dCBsYXllcjsgxJHhu4MgT0NSIOG7lW4gxJHhu4tuaCwgbsOqbiBjaOG6oXkgYuG6sW5nIDxzdHJvbmc+R2l0SHViIFBhZ2VzPC9zdHJvbmc+IGhv4bq3YyBsb2NhbCBzZXJ2ZXIgKHbDrSBk4bulIDxjb2RlPnB5dGhvbjMgLW0gaHR0cC5zZXJ2ZXI8L2NvZGU+KS48L2Rpdj4KCiAgPHNlY3Rpb24gaWQ9ImludGFrZSIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+MS4gVOG6o2kgdMOgaSBsaeG7h3Ugc8OhbmcgY2jhur88L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPkjhu4cgdGjhu5FuZyB04buxIMSR4buNYyBQREYuIE7hur91IGZpbGUgY8OzIHRleHQgbGF5ZXIgc+G6vSB0csOtY2ggdHLhu7FjIHRp4bq/cDsgbuG6v3UgbMOgIGLhuqNuIHNjYW4sIGjhu4cgdGjhu5FuZyB04buxIGNodXnhu4NuIHNhbmcgT0NSIMSR4buDIGPhu5EgZ+G6r25nIG5o4bqtbiBkaeG7h24gbWV0YWRhdGEgdsOgIHnDqnUgY+G6p3UgYuG6o28gaOG7mS48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZHJvcCIgaWQ9ImRyb3Bab25lIj4KICAgICAgICA8c3Ryb25nPlRo4bqjIFBERiB2w6BvIMSRw6J5IGhv4bq3YyBjaOG7jW4gZmlsZTwvc3Ryb25nPgogICAgICAgIDxzbWFsbD5I4buXIHRy4bujIFBERiBwYXRlbnQgdGnhur9uZyBWaeG7h3QvQW5oLiBPQ1IgY8OzIHRo4buDIG3huqV0IHbDoGkgcGjDunQgduG7m2kgYuG6o24gc2Nhbi48L3NtYWxsPjxici8+PGJyLz4KICAgICAgICA8aW5wdXQgaWQ9InBkZklucHV0IiB0eXBlPSJmaWxlIiBhY2NlcHQ9ImFwcGxpY2F0aW9uL3BkZiIgc3R5bGU9Im1heC13aWR0aDo0MjBweCIvPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icHJvZ3Jlc3MiPjxkaXYgaWQ9InByb2dyZXNzQmFyIj48L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdHVzIiBpZD0icGRmU3RhdHVzIj5DaMawYSBjw7MgZmlsZS48L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPkvhur90IHF14bqjIG5o4bqtbiBkaeG7h24gdOG7sSDEkeG7mW5nPC9oMj4KICAgICAgPGRpdiBjbGFzcz0iZGV0ZWN0Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJkZXRlY3QtY2FyZCIgaWQ9ImRldE1ldGEiPjxiPk1ldGFkYXRhPC9iPjxzcGFuPkNoxrBhIHjhu60gbMO9PC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRldGVjdC1jYXJkIiBpZD0iZGV0QWJzdHJhY3QiPjxiPlTDs20gdOG6r3Q8L2I+PHNwYW4+Q2jGsGEgeOG7rSBsw708L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZGV0ZWN0LWNhcmQiIGlkPSJkZXRDbGFpbXMiPjxiPlnDqnUgY+G6p3UgYuG6o28gaOG7mTwvYj48c3Bhbj5DaMawYSB44butIGzDvTwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkZXRlY3QtY2FyZCIgaWQ9ImRldE9DUiI+PGI+T0NSPC9iPjxzcGFuPkNoxrBhIGPhuqduPC9zcGFuPjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPlRow7RuZyB0aW4gc8OhbmcgY2jhur88L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPkPDoWMgdHLGsOG7nW5nIMSRxrDhu6NjIHThu7EgxJFp4buBbiB04burIFBERjsgbmfGsOG7nWkgZMO5bmcgY8OzIHRo4buDIHPhu61hIG7hur91IG5o4bqtbiBkaeG7h24gc2FpLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4KICAgICAgICA8ZGl2PjxsYWJlbD5Nw6MgY2FzZTwvbGFiZWw+PGlucHV0IGlkPSJjYXNlSWQiLz48L2Rpdj4KICAgICAgICA8ZGl2PjxsYWJlbD5T4buRIGLhurFuZyAvIHPhu5EgY8O0bmcgYuG7kTwvbGFiZWw+PGlucHV0IGlkPSJwYXRlbnRObyIvPjwvZGl2PgogICAgICAgIDxkaXY+PGxhYmVsPlF14buRYyBnaWEgLyBo4buHIHRo4buRbmc8L2xhYmVsPjxzZWxlY3QgaWQ9Imp1cmlzZGljdGlvbiI+PG9wdGlvbj5WTjwvb3B0aW9uPjxvcHRpb24+VVM8L29wdGlvbj48b3B0aW9uPldPL1BDVDwvb3B0aW9uPjxvcHRpb24+RVA8L29wdGlvbj48b3B0aW9uPktow6FjPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICA8ZGl2PjxsYWJlbD5Uw6puIHPDoW5nIGNo4bq/PC9sYWJlbD48aW5wdXQgaWQ9InRpdGxlIi8+PC9kaXY+CiAgICAgICAgPGRpdj48bGFiZWw+TmfDoHkgbuG7mXAgxJHGoW4gLyBuZ8OgeSDGsHUgdGnDqm48L2xhYmVsPjxpbnB1dCBpZD0iZmlsaW5nRGF0ZSIgdHlwZT0iZGF0ZSIvPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPGRpdj48bGFiZWw+Q2jhu6cgxJHGoW4gLyBjaOG7pyBi4bqxbmc8L2xhYmVsPjxpbnB1dCBpZD0iYXBwbGljYW50Ii8+PC9kaXY+CiAgICAgICAgPGRpdj48bGFiZWw+xJDhuqFpIGRp4buHbiBTSFRUPC9sYWJlbD48aW5wdXQgaWQ9InJlcHJlc2VudGF0aXZlIi8+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxsYWJlbD5JUEMgLyBDUEM8L2xhYmVsPjxpbnB1dCBpZD0iaXBjIi8+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+PGxhYmVsPlTDs20gdOG6r3Q8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iYWJzdHJhY3QiPjwvdGV4dGFyZWE+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMgbm8tcHJpbnQiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0icmV0cnlPQ1IiPlThu7EgcXXDqXQgT0NSIHnDqnUgY+G6p3UgYuG6o28gaOG7mTwvYnV0dG9uPjxidXR0b24gY2xhc3M9ImJ0biIgaWQ9ImxvYWREZW1vIj5O4bqhcCBkZW1vIFBILVZOLTAxPC9idXR0b24+PC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CgogIDxzZWN0aW9uIGlkPSJjbGFpbXMiIGNsYXNzPSJzZWN0aW9uIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPjIuIFjDoWMgxJHhu4tuaCB5w6p1IGPhuqd1IGLhuqNvIGjhu5k8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPkjhu4cgdGjhu5FuZyBsw6BtIHPhuqFjaCB2xINuIGLhuqNuIE9DUiB0csaw4bubYyBraGkgaGnhu4NuIHRo4buLLiBC4bqjbiBPQ1IgdGjDtCB24bqrbiDEkcaw4bujYyBnaeG7ryDEkeG7gyDEkeG7kWkgY2hp4bq/dSBraGkgY+G6p24uPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJzcGxpdCI+CiAgICAgICAgPGRpdj4KICAgICAgICAgIDxsYWJlbD5C4bqjbiB5w6p1IGPhuqd1IGLhuqNvIGjhu5kgxJHDoyBjaHXhuqluIGjDs2E8L2xhYmVsPgogICAgICAgICAgPHRleHRhcmVhIGlkPSJjbGFpbXNDbGVhbiIgY2xhc3M9ImNsYWltLWNsZWFuIiBzdHlsZT0ibWluLWhlaWdodDozOTBweCIgcGxhY2Vob2xkZXI9Ik7hu5lpIGR1bmcgY2xhaW1zIMSRw6MgbMOgbSBz4bqhY2ggc+G6vSBoaeG7g24gdGjhu4sgdOG6oWkgxJHDonkuIj48L3RleHRhcmVhPgogICAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0icGFyc2VDbGFpbXMiPkNodeG6qW4gaMOzYSAmIHTDoWNoIGzhuqFpIGNsYWltczwvYnV0dG9uPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJvY3JDbGFpbXNBZ2FpbiI+VOG7sSBxdcOpdCBPQ1IgY2xhaW1zPC9idXR0b24+CiAgICAgICAgICA8L2Rpdj4KCiAgICAgICAgICA8ZGV0YWlscyBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICAgICAgPHN1bW1hcnkgc3R5bGU9ImN1cnNvcjpwb2ludGVyO2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM2NjcwODUiPlhlbSBi4bqjbiBPQ1IgdGjDtCAvIGNo4buJbmggdGF5PC9zdW1tYXJ5PgogICAgICAgICAgICA8dGV4dGFyZWEgaWQ9ImNsYWltc1JhdyIgY2xhc3M9ImNsYWltLXJhdyIgc3R5bGU9Im1pbi1oZWlnaHQ6MjMwcHg7bWFyZ2luLXRvcDoxMHB4IiBwbGFjZWhvbGRlcj0iQuG6o24gT0NSIHRow7QuIj48L3RleHRhcmVhPgogICAgICAgICAgPC9kZXRhaWxzPgogICAgICAgIDwvZGl2PgoKICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsPkRhbmggc8OhY2ggY2xhaW1zPC9sYWJlbD4KICAgICAgICAgIDxkaXYgaWQ9ImNsYWltTGlzdCIgY2xhc3M9ImVtcHR5Ij5DaMawYSBjw7MgY2xhaW0uPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgoKICA8c2VjdGlvbiBpZD0iZmVhdHVyZXMiIGNsYXNzPSJzZWN0aW9uIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPjMuIFBow6JuIHTDrWNoIGThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQ8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPlTDoWNoIGNsYWltIMSRw6MgY2jhu41uIHRow6BuaCB04burbmcgZOG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdCDEkeG7gyBwaOG7pWMgduG7pSB0cmEgY+G7qXUgdsOgIGzhuq1wIGLhuqNuZyBzbyBzw6FuaC4gQuG7mSBk4bqldSBoaeG7h3UgxJHGsOG7o2MgcGjDqXAgY2jhu4luaCBz4butYSB0csaw4bubYyBraGkgeMOhYyBuaOG6rW4uPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPjxkaXY+PGxhYmVsPkNsYWltIGPhuqduIHBow6JuIHTDrWNoPC9sYWJlbD48c2VsZWN0IGlkPSJjbGFpbVNlbGVjdCI+PC9zZWxlY3Q+PC9kaXY+PGRpdj48bGFiZWw+VHLhuqFuZyB0aMOhaTwvbGFiZWw+PGlucHV0IGlkPSJmZWF0dXJlU3RhdHVzIiB2YWx1ZT0iQ2jGsGEgdOG6oW8iIHJlYWRvbmx5Lz48L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmVhdHVyZS1yZXZpZXctYmFyIiBpZD0iZmVhdHVyZVJldmlld0JhciI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWV0YSI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0icGlsbCB5ZWxsb3ciIGlkPSJmZWF0dXJlU3RhdHVzQmFkZ2UiPkNoxrBhIHjDoWMgbmjhuq1uPC9zcGFuPgogICAgICAgICAgPGRpdj48c3Ryb25nIGlkPSJmZWF0dXJlQ291bnRMYWJlbCI+Q2jGsGEgY8OzIGThuqV1IGhp4buHdTwvc3Ryb25nPjxzbWFsbD5LaeG7g20gdHJhIG7hu5lpIGR1bmcgdHLGsOG7m2Mga2hpIGtow7NhIGLhu5kgZOG6pXUgaGnhu4d1IMSR4buDIHRyYSBj4bupdS48L3NtYWxsPjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiIHN0eWxlPSJtYXJnaW4tdG9wOjAiPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0iYXV0b0ZlYXR1cmVzIj5U4bqhbyAvIHTDoWNoIGzhuqFpPC9idXR0b24+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9ImNvbmZpcm1GZWF0dXJlcyI+4pyTIFjDoWMgbmjhuq1uIGLhu5kgZOG6pXUgaGnhu4d1PC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIiBzdHlsZT0ibWFyZ2luLXRvcDoxOHB4Ij48dGFibGU+PHRoZWFkPjx0cj48dGg+TcOjPC90aD48dGg+ROG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdDwvdGg+PHRoPk5ow7NtPC90aD48dGg+xJDhu5kgdGluIGPhuq15PC90aD48dGg+PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5IGlkPSJmZWF0dXJlQm9keSI+PC90Ym9keT48L3RhYmxlPjwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgoKICA8c2VjdGlvbiBpZD0ic2VhcmNoIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj40LiBYw6J5IGThu7FuZyBjaGnhur9uIGzGsOG7o2MgdHJhIGPhu6l1PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5U4burIGLhu5kgZOG6pXUgaGnhu4d1IMSRw6MgeMOhYyBuaOG6rW4sIGjhu4cgdGjhu5FuZyBzaW5oIHThu6sga2jDs2EgdsOgIGPDonUgbOG7h25oIHPGoSBi4buZLiDEkMOieSBsw6AgYsaw4bubYyBo4buXIHRy4bujIGNodXnDqm4gZ2lhIHjDonkgZOG7sW5nIHbDoCBs4bq3cCBs4bqhaSBjaGnhur9uIGzGsOG7o2MgdHJhIGPhu6l1LjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIj48YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9ImdlblNlYXJjaCI+VOG6oW8gY2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdTwvYnV0dG9uPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIiBzdHlsZT0ibWFyZ2luLXRvcDoxOHB4Ij48dGFibGU+PHRoZWFkPjx0cj48dGg+RmVhdHVyZTwvdGg+PHRoPlThu6sga2jDs2EgY2jDrW5oPC90aD48dGg+Qmnhur9uIHRo4buDIC8gc3lub255bTwvdGg+PHRoPklQQy9DUEMgZ+G7o2kgw708L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9InNlYXJjaEJvZHkiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZGl2aWRlciI+PC9kaXY+PGxhYmVsPkPDonUgbOG7h25oIGfhu6NpIMO9PC9sYWJlbD48ZGl2IGlkPSJxdWVyeUxpc3QiIGNsYXNzPSJncmlkIj48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9InByaW9yIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj41LiBUw6xtICYgc8OgbmcgbOG7jWMgdMOgaSBsaeG7h3UgxJHhu5FpIGNo4bupbmc8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPgogICAgICAgIEjhu4cgdGjhu5FuZyB04bqhbyB0cnV5IHbhuqVuIHThu6sgYuG7mSBk4bqldSBoaeG7h3UsIHTDrG0gcGF0ZW50IHRo4bqtdCBxdWEgYmFja2VuZCBHb29nbGUgUGF0ZW50cywgeOG6v3AgaOG6oW5nIHRoZW8gxJHhu5kgbGnDqm4gcXVhbiB2w6AgxJFp4buBdSBraeG7h24gdGjhu51pIGdpYW4sCiAgICAgICAgc2F1IMSRw7MgY2hvIHBow6lwIGNo4buNbiB0cuG7sWMgdGnhur9wIEQx4oCTRDMuIFdJUE8gUEFURU5UU0NPUEUgdsOgIEVzcGFjZW5ldCDEkcaw4bujYyBkw7luZyBsw6BtIG5ndeG7k24ga2nhu4NtIGNo4bupbmcgYuG7lSBzdW5nLgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9InNlYXJjaC1oZXJvIj4KICAgICAgICA8ZGl2IGNsYXNzPSJzb3VyY2Utcm93Ij4KICAgICAgICAgIDxzdHJvbmcgc3R5bGU9ImZvbnQtc2l6ZToxM3B4Ij5OZ3Xhu5NuIHRyYSBj4bupdTo8L3N0cm9uZz4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaWQ9ImdwTGluayIgaHJlZj0iaHR0cHM6Ly9wYXRlbnRzLmdvb2dsZS5jb20vIiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciI+R29vZ2xlIFBhdGVudHMg4oaXPC9hPgogICAgICAgICAgPGEgY2xhc3M9InNvdXJjZS1jaGlwIiBpZD0id2lwb0xpbmsiIGhyZWY9Imh0dHBzOi8vcGF0ZW50c2NvcGUud2lwby5pbnQvIiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciI+V0lQTyBQQVRFTlRTQ09QRSDihpc8L2E+CiAgICAgICAgICA8YSBjbGFzcz0ic291cmNlLWNoaXAiIGlkPSJlcG9MaW5rIiBocmVmPSJodHRwczovL3dvcmxkd2lkZS5lc3BhY2VuZXQuY29tLyIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkVQTyBFc3BhY2VuZXQg4oaXPC9hPgogICAgICAgIDwvZGl2PgoKICAgICAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtdG9vbGJhciI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImxpdmVTZWFyY2hRdWVyeSIgcGxhY2Vob2xkZXI9J1bDrSBk4bulOiAiZHJhZ29uIGZydWl0IHNlZWQiIGNlbGx1bGFzZSBwZWN0aW5hc2UnPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJsaXZlU2VhcmNoQnRuIj7ijJUgVMOsbSB0w6BpIGxp4buHdSB0aOG6rXQ8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtc3RhdGUiIGlkPSJsaXZlU2VhcmNoU3RhdGUiPkNoxrBhIGNo4bqheSB0cmEgY+G7qXUuPC9kaXY+CgogICAgICAgIDxkaXYgY2xhc3M9ImNhbGxvdXQiIHN0eWxlPSJtYXJnaW4tdG9wOjEzcHgiPgogICAgICA8c3Ryb25nPkJhY2tlbmQgdMOtY2ggaOG7o3AgY8O5bmcgd2Vic2l0ZTwvc3Ryb25nPjxicj4KICAgICAgQuG6o24gZnVsbC1zdGFjayBz4butIGThu6VuZyBBUEkgY8O5bmcgZG9tYWluICg8Y29kZT4vYXBpLyo8L2NvZGU+KSwgbsOqbiBraMO0bmcgY+G6p24gbmjhuq1wIFdvcmtlciBVUkwgcmnDqm5nLgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJ0ZXN0QmFja2VuZCI+S2nhu4NtIHRyYSBiYWNrZW5kPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0dXMiIGlkPSJiYWNrZW5kU3RhdHVzIj5DaMawYSBraeG7g20gdHJhIGvhur90IG7hu5FpLjwvZGl2PgogICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0idXNlQmVzdFF1ZXJ5Ij5Ew7luZyB0cnV5IHbhuqVuIHThu6sgYsaw4bubYyA0PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHN1Y2Nlc3MiIGlkPSJhdXRvUGlja1ByaW9yIj5U4buxIGfhu6NpIMO9IEQx4oCTRDM8L2J1dHRvbj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIiBzdHlsZT0ibWFyZ2luLXRvcDoxNnB4Ij4KICAgICAgICA8dGFibGU+CiAgICAgICAgICA8dGhlYWQ+CiAgICAgICAgICAgIDx0cj4KICAgICAgICAgICAgICA8dGg+IzwvdGg+PHRoPlTDoGkgbGnhu4d1IHRo4bqtdDwvdGg+PHRoPk5nw6B5PC90aD48dGg+xJDhu5kgcGjDuSBo4bujcDwvdGg+PHRoPsSQaeG7gXUga2nhu4duIHRo4budaSBnaWFuPC90aD48dGg+Q2jhu41uPC90aD4KICAgICAgICAgICAgPC90cj4KICAgICAgICAgIDwvdGhlYWQ+CiAgICAgICAgICA8dGJvZHkgaWQ9ImNhbmRpZGF0ZUJvZHkiPgogICAgICAgICAgICA8dHI+PHRkIGNvbHNwYW49IjYiIHN0eWxlPSJjb2xvcjojOThhMmIzO3RleHQtYWxpZ246Y2VudGVyIj5DaMawYSBjw7Mga+G6v3QgcXXhuqMgdHJhIGPhu6l1LjwvdGQ+PC90cj4KICAgICAgICAgIDwvdGJvZHk+CiAgICAgICAgPC90YWJsZT4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj5EMeKAk0QzIMSRxrDhu6NjIGNo4buNbjwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN1YiI+S2hpIGNo4buNbiBt4buZdCBr4bq/dCBxdeG6oywgaOG7hyB0aOG7kW5nIHThu7EgbOG6pXkgbWV0YWRhdGEgdsOgIG7hu5lpIGR1bmcgcGF0ZW50IMSR4buDIMSRaeG7gW4gdsOgbyBzbG90IHTGsMahbmcg4bupbmcuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiPgogICAgICAgIDxkaXYgY2xhc3M9InByaW9yLXNsb3QiIGlkPSJzbG90RDEiPgogICAgICAgICAgPGg0PkQxIMK3IOG7qG5nIHZpw6puIMSR4buRaSBjaOG7qW5nIGfhuqduIG5o4bqldDwvaDQ+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQxTm8iIHBsYWNlaG9sZGVyPSJT4buRIGPDtG5nIGLhu5EiPgogICAgICAgICAgPGlucHV0IGlkPSJkMURhdGUiIHR5cGU9ImRhdGUiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQxVXJsIiBwbGFjZWhvbGRlcj0iVVJMIG5ndeG7k24iIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgICA8dGV4dGFyZWEgaWQ9ImQxVGV4dCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4O21pbi1oZWlnaHQ6MTkwcHgiIHBsYWNlaG9sZGVyPSJBYnN0cmFjdCAvIGNsYWltcyAvIHNuaXBwZXQgc+G6vSDEkcaw4bujYyB04buxIMSRaeG7gW4uLi4iPjwvdGV4dGFyZWE+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icHJpb3Itc2xvdCIgaWQ9InNsb3REMiI+CiAgICAgICAgICA8aDQ+RDIgwrcgVMOgaSBsaeG7h3UgYuG7lSBzdW5nPC9oND4KICAgICAgICAgIDxpbnB1dCBpZD0iZDJObyIgcGxhY2Vob2xkZXI9IlPhu5EgY8O0bmcgYuG7kSI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQyRGF0ZSIgdHlwZT0iZGF0ZSIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICAgIDxpbnB1dCBpZD0iZDJVcmwiIHBsYWNlaG9sZGVyPSJVUkwgbmd14buTbiIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0iZDJUZXh0IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHg7bWluLWhlaWdodDoxOTBweCIgcGxhY2Vob2xkZXI9IkFic3RyYWN0IC8gY2xhaW1zIC8gc25pcHBldCBz4bq9IMSRxrDhu6NjIHThu7EgxJFp4buBbi4uLiI+PC90ZXh0YXJlYT4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJwcmlvci1zbG90IiBpZD0ic2xvdEQzIj4KICAgICAgICAgIDxoND5EMyDCtyBUw6BpIGxp4buHdSBi4buVIHN1bmc8L2g0PgogICAgICAgICAgPGlucHV0IGlkPSJkM05vIiBwbGFjZWhvbGRlcj0iU+G7kSBjw7RuZyBi4buRIj4KICAgICAgICAgIDxpbnB1dCBpZD0iZDNEYXRlIiB0eXBlPSJkYXRlIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgICAgPGlucHV0IGlkPSJkM1VybCIgcGxhY2Vob2xkZXI9IlVSTCBuZ3Xhu5NuIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgICAgPHRleHRhcmVhIGlkPSJkM1RleHQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweDttaW4taGVpZ2h0OjE5MHB4IiBwbGFjZWhvbGRlcj0iQWJzdHJhY3QgLyBjbGFpbXMgLyBzbmlwcGV0IHPhur0gxJHGsOG7o2MgdOG7sSDEkWnhu4FuLi4uIj48L3RleHRhcmVhPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0idmFsaWRhdGVQcmlvciI+S2nhu4NtIHRyYSDEkWnhu4F1IGtp4buHbiB0aOG7nWkgZ2lhbjwvYnV0dG9uPjwvZGl2PgogICAgICA8ZGl2IGlkPSJwcmlvckNoZWNrIiBjbGFzcz0iY2FsbG91dCIgc3R5bGU9Im1hcmdpbi10b3A6MTZweCI+PHN0cm9uZz5MxrB1IMO9Ojwvc3Ryb25nPiBuZ8OgeSB2w6AgbuG7mWkgZHVuZyB24bqrbiBj4bqnbiBjaHV5w6puIGdpYSBraeG7g20gY2jhu6luZyB0csOqbiB0w6BpIGxp4buHdSBn4buRYy48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9ImNvbXBhcmUiIGNsYXNzPSJzZWN0aW9uIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPjYuIEzhuq1wIGLhuqNuZyBzbyBzw6FuaCBk4bqldSBoaeG7h3U8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPsSQ4buRaSBjaGnhur91IHThu6tuZyBk4bqldSBoaeG7h3UgduG7m2kgdOG7q25nIHTDoGkgbGnhu4d1LiBO4bq/dSBjaMawYSBjw7MgYuG6sW5nIGNo4bupbmcgxJHhu6cgcsO1LCBo4buHIHRo4buRbmcgcGjhuqNpIHRy4bqjIHbhu4Eg4oCcQ2jGsGEgY2jhuq9jIGNo4bqvbuKAnS48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+PGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJidWlsZE1hdHJpeCI+VOG6oW8gbWEgdHLhuq1uIMSR4buRaSBjaGnhur91PC9idXR0b24+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXdyYXAiIHN0eWxlPSJtYXJnaW4tdG9wOjE4cHgiPjx0YWJsZT48dGhlYWQ+PHRyPjx0aD5GZWF0dXJlPC90aD48dGg+RDE8L3RoPjx0aD5EMjwvdGg+PHRoPkQzPC90aD48dGg+QuG6sW5nIGNo4bupbmcgLyBnaGkgY2jDujwvdGg+PC90cj48L3RoZWFkPjx0Ym9keSBpZD0ibWF0cml4Qm9keSI+PC90Ym9keT48L3RhYmxlPjwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgoKICA8c2VjdGlvbiBpZD0iYXNzZXNzIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj43LiDEkMOhbmggZ2nDoSBzxqEgYuG7mTwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN1YiI+xJDDoW5oIGdpw6EgdGhlbyB04burbmcgY2xhaW0gdsOgIHThuq1wIHTDoGkgbGnhu4d1IMSRYW5nIGto4bqjbyBzw6F0OyBraMO0bmcgcGjhuqNpIGvhur90IGx14bqtbiBj4bqlcCBi4bqxbmcuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJpc2siPjxkaXY+PGgzPlTDrW5oIG3hu5tpPC9oMz48cCBpZD0ibm92ZWx0eVRleHQiPkNoxrBhIMSRw6FuaCBnacOhLjwvcD48L2Rpdj48ZGl2IGNsYXNzPSJyaXNrYm94IHllbGxvdyIgaWQ9Im5vdmVsdHlSaXNrIj5DSOG7nCBE4buuIExJ4buGVTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJoZWlnaHQ6MTJweCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJpc2siPjxkaXY+PGgzPlRyw6xuaCDEkeG7mSBzw6FuZyB04bqhbzwvaDM+PHAgaWQ9ImludmVudGl2ZVRleHQiPkNoxrBhIMSRw6FuaCBnacOhLjwvcD48L2Rpdj48ZGl2IGNsYXNzPSJyaXNrYm94IHllbGxvdyIgaWQ9ImludmVudGl2ZVJpc2siPkNI4bucIEThu64gTEnhu4ZVPC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImRpdmlkZXIiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj48ZGl2PjxsYWJlbD7EkOG7kWkgY2jhu6luZyBn4bqnbiBuaOG6pXQ8L2xhYmVsPjxzZWxlY3QgaWQ9ImNsb3Nlc3QiPjxvcHRpb24+RDE8L29wdGlvbj48b3B0aW9uPkQyPC9vcHRpb24+PG9wdGlvbj5EMzwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PjxkaXY+PGxhYmVsPkThuqV1IGhp4buHdSBraMOhYyBiaeG7h3Q8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iZGlmZmVyZW5jZXMiPjwvdGV4dGFyZWE+PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+PGxhYmVsPlbhuqVuIMSR4buBIGvhu7kgdGh14bqtdCBraMOhY2ggcXVhbjwvbGFiZWw+PHRleHRhcmVhIGlkPSJwcm9ibGVtIj48L3RleHRhcmVhPjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxsYWJlbD5M4bqtcCBsdeG6rW4gc8ahIGLhu5kgduG7gSB0w61uaCBoaeG7g24gbmhpw6puPC9sYWJlbD48dGV4dGFyZWEgaWQ9InJlYXNvbmluZyI+PC90ZXh0YXJlYT48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+PGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJydW5Bc3Nlc3NtZW50Ij5DaOG6oXkgxJHDoW5oIGdpw6Egc8ahIGLhu5k8L2J1dHRvbj48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9ImV4cGVydCIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+OC4gQ2h1ecOqbiBnaWEgcsOgIHNvw6F0PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5DaHV5w6puIGdpYSB4w6FjIG5o4bqtbi9jaOG7iW5oIHPhu61hL2LDoWMgYuG7jyB04burbmcgxJHhuqd1IHJhLiDEkMOieSBsw6AgY2hlY2twb2ludCBi4bqvdCBideG7mWMgY+G7p2EgbcO0IGjDrG5oIEh1bWFuLWluLXRoZS1sb29wLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIj48dGFibGU+PHRoZWFkPjx0cj48dGg+SOG6oW5nIG3hu6VjPC90aD48dGg+S+G6v3QgcXXhuqMgaOG7hyB0aOG7kW5nPC90aD48dGg+UXV54bq/dCDEkeG7i25oIGNodXnDqm4gZ2lhPC90aD48dGg+Tmjhuq1uIHjDqXQ8L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9ImV4cGVydEJvZHkiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+PGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJzYXZlUmV2aWV3Ij5MxrB1IHLDoCBzb8OhdDwvYnV0dG9uPjwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgoKICA8c2VjdGlvbiBpZD0icmVwb3J0IiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj45LiBCw6FvIGPDoW8gcGjDom4gdMOtY2ggc8ahIGLhu5k8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIgbm8tcHJpbnQiPlThu5VuZyBo4bujcCBk4buvIGxp4buHdSB04burIHRvw6BuIGLhu5kgcGlwZWxpbmUuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMgbm8tcHJpbnQiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0iZ2VuUmVwb3J0Ij5U4bqhbyBiw6FvIGPDoW88L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJidG4iIG9uY2xpY2s9IndpbmRvdy5wcmludCgpIj5JbiAvIEzGsHUgUERGPC9idXR0b24+PC9kaXY+CiAgICAgIDxkaXYgaWQ9InJlcG9ydENvbnRlbnQiIGNsYXNzPSJyZXBvcnQiPjxkaXYgY2xhc3M9ImVtcHR5Ij5DaMawYSB04bqhbyBiw6FvIGPDoW8uPC9kaXY+PC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CjwvbWFpbj4KPC9kaXY+Cgo8ZGl2IGNsYXNzPSJ3aXphcmRiYXIgbm8tcHJpbnQiPgogIDxkaXYgY2xhc3M9IndpemFyZGlubmVyIj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBiYWNrYnRuIiBpZD0iYmFja0J0biI+4oaQIFF1YXkgbOG6oWk8L2J1dHRvbj4KICAgIDxkaXYgY2xhc3M9IndpemFyZG1ldGEiPjxzdHJvbmcgaWQ9IndpemFyZFRpdGxlIj48L3N0cm9uZz48c3BhbiBpZD0id2l6YXJkSGludCI+PC9zcGFuPjwvZGl2PgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkgbmV4dGJ0biIgaWQ9Im5leHRCdG4iPlRp4bq/cCB04bulYyDihpI8L2J1dHRvbj4KICA8L2Rpdj4KPC9kaXY+Cgo8c2NyaXB0Pgpjb25zdCBTVEVQUz1bCiAge2lkOiJpbnRha2UiLHRpdGxlOiJUaeG6v3Agbmjhuq1uIGjhu5Mgc8ahIixoaW50OiJU4bqjaSBQREYgdsOgIGtp4buDbSB0cmEgZOG7ryBsaeG7h3UgdOG7sSDEkeG7mW5nIHRyw61jaCB4deG6pXQuIn0sCiAge2lkOiJjbGFpbXMiLHRpdGxlOiJZw6p1IGPhuqd1IGLhuqNvIGjhu5kiLGhpbnQ6IkNo4buNbiBjbGFpbSBj4bqnbiBwaMOibiB0w61jaC4ifSwKICB7aWQ6ImZlYXR1cmVzIix0aXRsZToiROG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdCIsaGludDoiVMOhY2ggdsOgIHjDoWMgbmjhuq1uIGZlYXR1cmUgc2V0LiJ9LAogIHtpZDoic2VhcmNoIix0aXRsZToiQ2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdSIsaGludDoiU2luaCBrZXl3b3JkL0lQQy9xdWVyeS4ifSwKICB7aWQ6InByaW9yIix0aXRsZToiVMOgaSBsaeG7h3UgxJHhu5FpIGNo4bupbmciLGhpbnQ6Ik5o4bqtcC9raeG7g20gdHJhIHByaW9yIGFydC4ifSwKICB7aWQ6ImNvbXBhcmUiLHRpdGxlOiJC4bqjbmcgc28gc8OhbmgiLGhpbnQ6Ik1hcCBmZWF0dXJlIHbhu5tpIGV2aWRlbmNlLiJ9LAogIHtpZDoiYXNzZXNzIix0aXRsZToixJDDoW5oIGdpw6Egc8ahIGLhu5kiLGhpbnQ6Ik5vdmVsdHkgdsOgIGludmVudGl2ZSBzdGVwLiJ9LAogIHtpZDoiZXhwZXJ0Iix0aXRsZToiQ2h1ecOqbiBnaWEgcsOgIHNvw6F0IixoaW50OiJFeHBlcnQgdmFsaWRhdGlvbi4ifSwKICB7aWQ6InJlcG9ydCIsdGl0bGU6IkLDoW8gY8OhbyIsaGludDoiVOG7lW5nIGjhu6NwIGvhur90IHF14bqjLiJ9Cl07CmNvbnN0IHN0YXRlPXtzdGVwOjAscGRmOm51bGwscGFnZVRleHQ6W10scGFnZUNvbHVtblRleHQ6W10sb2NyUGFnZXM6e30scmF3VGV4dDoiIixjbGFpbXNUZXh0OiIiLGNsYWltczpbXSxzZWxlY3RlZDowLGZlYXR1cmVzOltdLGNvbmZpcm1lZDpmYWxzZSxzZWFyY2g6W10scXVlcmllczpbXSxwcmlvcjp7fSxtYXRyaXg6W10sYXNzZXNzbWVudDp7fSxyZXZpZXdzOjAsY2FuZGlkYXRlczpbXSxiYWNrZW5kVXJsOiIiLHByb3ZpZGVyczp7fSxjbG91ZE9jcjpudWxsfTsKY29uc3QgJD1pZD0+ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwpjb25zdCBlc2M9cz0+KHN8fCIiKS5yZXBsYWNlKC9bJjw+IiddL2csbT0+KHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsJyInOiImcXVvdDsiLCInIjoiJiMwMzk7In1bbV0pKTsKY29uc3QgY2xlYW49cz0+KHN8fCIiKS5yZXBsYWNlKC9cdTAwYWQvZywiIikucmVwbGFjZSgvWyBcdF0rL2csIiAiKS5yZXBsYWNlKC9cblsgXHRdKy9nLCJcbiIpLnRyaW0oKTsKZnVuY3Rpb24gZm9sZFZOKHMpewogIHJldHVybiAoc3x8IiIpCiAgICAubm9ybWFsaXplKCJORkQiKQogICAgLnJlcGxhY2UoL1tcdTAzMDAtXHUwMzZmXS9nLCIiKQogICAgLnJlcGxhY2UoL8SRL2csImQiKS5yZXBsYWNlKC/EkC9nLCJEIikKICAgIC50b1VwcGVyQ2FzZSgpOwp9CmZ1bmN0aW9uIGNsYWltTWFya2VySW5mbyh0ZXh0KXsKICBjb25zdCBmPWZvbGRWTih0ZXh0KTsKICBjb25zdCBwYXR0ZXJucz1bCiAgICAvWUVVXHMqQ0FVXHMqQkFPXHMqSE8vLAogICAgL05IVU5HXHMqRElFVVxzKllFVVxzKkNBVVxzKkJBT1xzKkhPLywKICAgIC9XSEFUXHMrSVNccytDTEFJTUVEXHMrSVNccyo6Ki8sCiAgICAvSVxzKlwvP1xzKldFXHMrQ0xBSU1ccyo6Ki8sCiAgICAvXGJDTEFJTVM/XHMqOiovCiAgXTsKICBmb3IoY29uc3QgcmUgb2YgcGF0dGVybnMpewogICAgY29uc3QgbT1mLm1hdGNoKHJlKTsKICAgIGlmKG0pIHJldHVybiB7aW5kZXg6bS5pbmRleCxlbmQ6bS5pbmRleCttWzBdLmxlbmd0aH07CiAgfQogIHJldHVybiBudWxsOwp9CmZ1bmN0aW9uIGxvb2tzTGlrZUNsYWltUGFnZSh0ZXh0KXsKICBjb25zdCBmPWZvbGRWTih0ZXh0KTsKICByZXR1cm4gLyg/Ol58XG58XHMpMVxzKltcLlwpXVxzKihRVVkgVFJJTkh8UEhVT05HIFBIQVB8U0FOIFBIQU18VEhJRVQgQkl8SEUgVEhPTkd8Q0hFIFBIQU18QVxzfEFOXHN8VEhFXHMpLy50ZXN0KGYpCiAgICAmJiAvKEJBTyBHT018Q09NUFJJU0lOR3xDT01QUklTRVN8R09NIENBQyBCVU9DfElOQ0xVRElORykvLnRlc3QoZik7Cn0KZnVuY3Rpb24gZXh0cmFjdENsYWltc1RhaWwodGV4dCl7CiAgaWYoIXRleHQpIHJldHVybiAiIjsKICBjb25zdCBtYXJrPWNsYWltTWFya2VySW5mbyh0ZXh0KTsKICBpZihtYXJrKSByZXR1cm4gY2xlYW4odGV4dC5zbGljZShtYXJrLmVuZCkpLnNsaWNlKDAsODAwMDApOwoKICBjb25zdCBmPWZvbGRWTih0ZXh0KTsKICBjb25zdCByZT0vKD86XnxcbnxccykxXHMqW1wuXCldXHMqKFFVWSBUUklOSHxQSFVPTkcgUEhBUHxTQU4gUEhBTXxUSElFVCBCSXxIRSBUSE9OR3xDSEUgUEhBTXxBXHN8QU5cc3xUSEVccykvOwogIGNvbnN0IG09Zi5tYXRjaChyZSk7CiAgcmV0dXJuIG0gPyBjbGVhbih0ZXh0LnNsaWNlKG0uaW5kZXgpKS5zbGljZSgwLDgwMDAwKSA6ICIiOwp9CmZ1bmN0aW9uIG5vcm1hbGl6ZU9jclRleHQocyl7CiAgbGV0IHQ9KHN8fCIiKQogICAgLnJlcGxhY2UoL1x1RkVGRi9nLCIiKQogICAgLnJlcGxhY2UoL1x1MDBhZC9nLCIiKQogICAgLm5vcm1hbGl6ZSgiTkZDIikKICAgIC5yZXBsYWNlKC9b4oCc4oCdXS9nLCciJykucmVwbGFjZSgvW+KAmOKAmV0vZywiJyIpCiAgICAucmVwbGFjZSgvW+KAkOKAkeKAkuKAk+KAlF0vZywiLSIpCiAgICAucmVwbGFjZSgvXHUwMGEwL2csIiAiKQogICAgLnJlcGxhY2UoL1sgXHRdKy9nLCIgIikKICAgIC5yZXBsYWNlKC9ccysoWywuOzolXCldKS9nLCIkMSIpCiAgICAucmVwbGFjZSgvKFwoKVxzKy9nLCIkMSIpCiAgICAucmVwbGFjZSgvKFxkKVxzKixccyooXGQpL2csIiQxLCQyIikKICAgIC5yZXBsYWNlKC8oXGQpXHMqJVxiL2csIiQxJSIpCiAgICAucmVwbGFjZSgvXG57Myx9L2csIlxuXG4iKTsKCiAgY29uc3QgbGluZXM9dC5zcGxpdCgvXG4rLykubWFwKHg9PngudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7CiAgY29uc3Qgb3V0PVtdOwogIGZvcihjb25zdCBsaW5lIG9mIGxpbmVzKXsKICAgIGNvbnN0IGlzTmV3PS9eKD86XGR7MSwyfVxzKltcLlwpXXxcKFtpdnhsY2RtXStcKXxb4oCiXC3igJPigJRdXHMrfFnDilUgQ+G6plUgQuG6ok8gSOG7mHxDTEFJTVM/XGJ8V0hBVCBJUyBDTEFJTUVEKS9pLnRlc3QobGluZSk7CiAgICBpZighb3V0Lmxlbmd0aCB8fCBpc05ldyB8fCAvWy4hPzo7XSQvLnRlc3Qob3V0W291dC5sZW5ndGgtMV0pKXsKICAgICAgb3V0LnB1c2gobGluZSk7CiAgICB9ZWxzZXsKICAgICAgb3V0W291dC5sZW5ndGgtMV0rPSIgIitsaW5lOwogICAgfQogIH0KICByZXR1cm4gb3V0LmpvaW4oIlxuIikubm9ybWFsaXplKCJORkMiKS50cmltKCk7Cn0KCmZ1bmN0aW9uIGNhbnZhc1RvQmFzZTY0SnBlZyhjYW52YXMscXVhbGl0eT0uOSl7CiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLHJlamVjdCk9PnsKICAgIGNhbnZhcy50b0Jsb2IoYXN5bmMgYmxvYj0+ewogICAgICBpZighYmxvYikgcmV0dXJuIHJlamVjdChuZXcgRXJyb3IoIktow7RuZyB04bqhbyDEkcaw4bujYyDhuqNuaCBPQ1IuIikpOwogICAgICBjb25zdCBidWY9YXdhaXQgYmxvYi5hcnJheUJ1ZmZlcigpOwogICAgICBjb25zdCBieXRlcz1uZXcgVWludDhBcnJheShidWYpOwogICAgICBsZXQgYmluPSIiOwogICAgICBjb25zdCBjaHVuaz0weDgwMDA7CiAgICAgIGZvcihsZXQgaT0wO2k8Ynl0ZXMubGVuZ3RoO2krPWNodW5rKXsKICAgICAgICBiaW4rPVN0cmluZy5mcm9tQ2hhckNvZGUoLi4uYnl0ZXMuc3ViYXJyYXkoaSxNYXRoLm1pbihpK2NodW5rLGJ5dGVzLmxlbmd0aCkpKTsKICAgICAgfQogICAgICByZXNvbHZlKGJ0b2EoYmluKSk7CiAgICB9LCJpbWFnZS9qcGVnIixxdWFsaXR5KTsKICB9KTsKfQoKYXN5bmMgZnVuY3Rpb24gY2xvdWRWaXNpb25PY3IoY2FudmFzKXsKICBpZihzdGF0ZS5jbG91ZE9jcj09PWZhbHNlKSByZXR1cm4gbnVsbDsKICB0cnl7CiAgICBjb25zdCBpbWFnZV9iYXNlNjQ9YXdhaXQgY2FudmFzVG9CYXNlNjRKcGVnKGNhbnZhcywuOTIpOwogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCgiL2FwaS9vY3IiLHsKICAgICAgbWV0aG9kOiJQT1NUIiwKICAgICAgaGVhZGVyczp7ImNvbnRlbnQtdHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7aW1hZ2VfYmFzZTY0fSkKICAgIH0pOwogICAgY29uc3QgZD1hd2FpdCByLmpzb24oKS5jYXRjaCgoKT0+KHt9KSk7CiAgICBpZihyLnN0YXR1cz09PTUwMSB8fCBkLmNvZGU9PT0iVklTSU9OX05PVF9DT05GSUdVUkVEIil7CiAgICAgIHN0YXRlLmNsb3VkT2NyPWZhbHNlOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIGlmKCFyLm9rIHx8ICFkLm9rKSB0aHJvdyBuZXcgRXJyb3IoZC5lcnJvcnx8KCJPQ1IgSFRUUCAiK3Iuc3RhdHVzKSk7CiAgICBzdGF0ZS5jbG91ZE9jcj10cnVlOwogICAgcmV0dXJuIG5vcm1hbGl6ZU9jclRleHQoZC50ZXh0fHwiIik7CiAgfWNhdGNoKGUpewogICAgY29uc29sZS53YXJuKCJDbG91ZCBPQ1IgZmFsbGJhY2s6IixlKTsKICAgIHJldHVybiBudWxsOwogIH0KfQoKZnVuY3Rpb24gZm9ybWF0Q2xhaW1Gb3JEaXNwbGF5KHMpewogIGNvbnN0IHQ9bm9ybWFsaXplT2NyVGV4dChzKQogICAgLnJlcGxhY2UoL1xzKihcKFtpdnhsY2RtXStcKSlccyovaWcsIlxuJDEgIikKICAgIC5yZXBsYWNlKC9ccysodsOgKVxzKyg/PVwoW2l2eGxjZG1dK1wpKS9pZywiXG4kMSAiKTsKICByZXR1cm4gdC50cmltKCk7Cn0KCgpmdW5jdGlvbiByZW5kZXJQcm9jZXNzKCl7CiAgJCgicHJvY2VzcyIpLmlubmVySFRNTD1TVEVQUy5tYXAoKHMsaSk9PmA8ZGl2IGNsYXNzPSJwcm9jZXNzLWl0ZW0gJHtpPT09c3RhdGUuc3RlcD8iYWN0aXZlIjppPHN0YXRlLnN0ZXA/ImRvbmUiOiIifSI+PHNwYW4gY2xhc3M9Im4iPiR7aTxzdGF0ZS5zdGVwPyLinJMiOmkrMX08L3NwYW4+PHNwYW4+JHtzLnRpdGxlfTwvc3Bhbj48L2Rpdj5gKS5qb2luKCIiKTsKfQpmdW5jdGlvbiBzaG93U3RlcChpKXsKICBzdGF0ZS5zdGVwPU1hdGgubWF4KDAsTWF0aC5taW4oU1RFUFMubGVuZ3RoLTEsaSkpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi5zZWN0aW9uIikuZm9yRWFjaCh4PT54LmNsYXNzTGlzdC5yZW1vdmUoImFjdGl2ZSIpKTsKICAkKFNURVBTW3N0YXRlLnN0ZXBdLmlkKS5jbGFzc0xpc3QuYWRkKCJhY3RpdmUiKTsKICAkKCJwYWdlVGl0bGUiKS50ZXh0Q29udGVudD1TVEVQU1tzdGF0ZS5zdGVwXS50aXRsZTsKICAkKCJwYWdlU3ViIikudGV4dENvbnRlbnQ9U1RFUFNbc3RhdGUuc3RlcF0uaGludDsKICAkKCJ3aXphcmRUaXRsZSIpLnRleHRDb250ZW50PWBCxrDhu5tjICR7c3RhdGUuc3RlcCsxfS8ke1NURVBTLmxlbmd0aH0gwrcgJHtTVEVQU1tzdGF0ZS5zdGVwXS50aXRsZX1gOwogICQoIndpemFyZEhpbnQiKS50ZXh0Q29udGVudD1TVEVQU1tzdGF0ZS5zdGVwXS5oaW50OwogICQoImJhY2tCdG4iKS5zdHlsZS52aXNpYmlsaXR5PXN0YXRlLnN0ZXA9PT0wPyJoaWRkZW4iOiJ2aXNpYmxlIjsKICAkKCJuZXh0QnRuIikudGV4dENvbnRlbnQ9c3RhdGUuc3RlcD09PVNURVBTLmxlbmd0aC0xPyJIb8OgbiB04bqldCI6IlRp4bq/cCB04bulYyDihpIiOwogIHJlbmRlclByb2Nlc3MoKTsKICBpZihTVEVQU1tzdGF0ZS5zdGVwXS5pZD09PSJwcmlvciIpewogICAgaWYoISQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlKSB1c2VHZW5lcmF0ZWRRdWVyeSgpOwogICAgdXBkYXRlT2ZmaWNpYWxTZWFyY2hMaW5rcygkKCJsaXZlU2VhcmNoUXVlcnkiKS52YWx1ZSk7CiAgfQogIHNjcm9sbFRvKHt0b3A6MCxiZWhhdmlvcjoic21vb3RoIn0pOwp9CmZ1bmN0aW9uIHZhbGlkYXRlQmVmb3JlTmV4dCgpewogIGlmKHN0YXRlLnN0ZXA9PT0wICYmICFzdGF0ZS5yYXdUZXh0ICYmICFzdGF0ZS5jbGFpbXMubGVuZ3RoKXthbGVydCgiSMOjeSB04bqjaSBt4buZdCBQREYgaG/hurdjIG7huqFwIGRlbW8gdHLGsOG7m2MuIik7cmV0dXJuIGZhbHNlfQogIGlmKHN0YXRlLnN0ZXA9PT0xICYmICFzdGF0ZS5jbGFpbXMubGVuZ3RoKXthbGVydCgiQ2jGsGEgY8OzIGNsYWltLiBIw6N5IE9DUiBs4bqhaSBob+G6t2MgcGFzdGUgcGjhuqduIFnDqnUgY+G6p3UgYuG6o28gaOG7mSBy4buTaSBi4bqlbSDigJxUw6FjaCBs4bqhaSBjbGFpbXPigJ0uIik7cmV0dXJuIGZhbHNlfQogIGlmKHN0YXRlLnN0ZXA9PT0yICYmICFzdGF0ZS5mZWF0dXJlcy5sZW5ndGgpe2FsZXJ0KCJIw6N5IHTDoWNoIGThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQgdHLGsOG7m2MuIik7cmV0dXJuIGZhbHNlfQogIGlmKHN0YXRlLnN0ZXA9PT0yICYmICFzdGF0ZS5jb25maXJtZWQpe3JldHVybiBjb25maXJtKCJC4buZIGThuqV1IGhp4buHdSBjaMawYSDEkcaw4bujYyB4w6FjIG5o4bqtbi4gQuG6oW4gduG6q24gbXXhu5FuIHRp4bq/cCB04bulYz8iKX0KICBpZihzdGF0ZS5zdGVwPT09NCl7cmVhZFByaW9yKCk7aWYoIU9iamVjdC52YWx1ZXMoc3RhdGUucHJpb3IpLnNvbWUoeD0+eC5ubykpe3JldHVybiBjb25maXJtKCJDaMawYSBjw7MgdMOgaSBsaeG7h3UgxJHhu5FpIGNo4bupbmcuIELhuqFuIHbhuqtuIG114buRbiB0aeG6v3AgdOG7pWM/Iil9fQogIHJldHVybiB0cnVlCn0KJCgiYmFja0J0biIpLm9uY2xpY2s9KCk9PnNob3dTdGVwKHN0YXRlLnN0ZXAtMSk7CiQoIm5leHRCdG4iKS5vbmNsaWNrPSgpPT57aWYoc3RhdGUuc3RlcD09PVNURVBTLmxlbmd0aC0xKXskKCJnZW5SZXBvcnQiKS5jbGljaygpO3JldHVybn1pZih2YWxpZGF0ZUJlZm9yZU5leHQoKSlzaG93U3RlcChzdGF0ZS5zdGVwKzEpfTsKc2hvd1N0ZXAoMCk7c2V0VGltZW91dCh1cGRhdGVGZWF0dXJlUmV2aWV3VUksMCk7CmlmKGxvY2F0aW9uLnByb3RvY29sPT09ImZpbGU6IikgJCgibG9jYWxCYW5uZXIiKS5zdHlsZS5kaXNwbGF5PSJibG9jayI7CgpmdW5jdGlvbiBzZXREZXRlY3QoaWQsb2ssdGV4dCl7bGV0IGVsPSQoaWQpO2VsLmNsYXNzTmFtZT0iZGV0ZWN0LWNhcmQgIisob2s/Im9rIjoid2FybiIpO2VsLnF1ZXJ5U2VsZWN0b3IoInNwYW4iKS50ZXh0Q29udGVudD10ZXh0fQpmdW5jdGlvbiBub3JtRGF0ZSh2KXtpZighdilyZXR1cm4iIjtsZXQgbT12Lm1hdGNoKC8oXGR7MSwyfSlbXC9cLS5dKFxkezEsMn0pW1wvXC0uXShcZHs0fSkvKTtpZihtKXJldHVybiBgJHttWzNdfS0ke1N0cmluZyhtWzJdKS5wYWRTdGFydCgyLCIwIil9LSR7U3RyaW5nKG1bMV0pLnBhZFN0YXJ0KDIsIjAiKX1gO2xldCBkPW5ldyBEYXRlKHYpO3JldHVybiBpc05hTihkKT8iIjpkLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwxMCl9CmZ1bmN0aW9uIGZpcnN0TWF0Y2godGV4dCxwYXR0ZXJucyl7Zm9yKGNvbnN0IHAgb2YgcGF0dGVybnMpe2NvbnN0IG09dGV4dC5tYXRjaChwKTtpZihtJiZtWzFdKXJldHVybiBjbGVhbihtWzFdKX1yZXR1cm4iIn0KCmFzeW5jIGZ1bmN0aW9uIGdldFBkZkxpYigpewogaWYoIXdpbmRvdy5wZGZqc0xpYikgdGhyb3cgbmV3IEVycm9yKCJQREYuanMgY2jGsGEgdOG6o2kgxJHGsOG7o2MgdOG7qyBDRE4uIik7CiBwZGZqc0xpYi5HbG9iYWxXb3JrZXJPcHRpb25zLndvcmtlclNyYz0iaHR0cHM6Ly9jZG5qcy5jbG91ZGZsYXJlLmNvbS9hamF4L2xpYnMvcGRmLmpzLzMuMTEuMTc0L3BkZi53b3JrZXIubWluLmpzIjsKIHJldHVybiB3aW5kb3cucGRmanNMaWI7Cn0KYXN5bmMgZnVuY3Rpb24gcmVhZFBkZihmaWxlKXsKICBjb25zdCBwZGZqcz1hd2FpdCBnZXRQZGZMaWIoKTsKICBjb25zdCBwZGY9YXdhaXQgcGRmanMuZ2V0RG9jdW1lbnQoe2RhdGE6YXdhaXQgZmlsZS5hcnJheUJ1ZmZlcigpfSkucHJvbWlzZTsKICBzdGF0ZS5wZGY9cGRmO3N0YXRlLnBhZ2VUZXh0PVtdO3N0YXRlLnBhZ2VDb2x1bW5UZXh0PVtdOwoKICBmdW5jdGlvbiBpdGVtc1RvTGluZXMoaXRlbXMpewogICAgY29uc3Qgcm93cz1bXTsKICAgIGNvbnN0IHNvcnRlZD1pdGVtcy5zbGljZSgpLnNvcnQoKGEsYik9PmIueS1hLnkgfHwgYS54LWIueCk7CiAgICBmb3IoY29uc3QgaXQgb2Ygc29ydGVkKXsKICAgICAgbGV0IHJvdz1yb3dzLmZpbmQocj0+TWF0aC5hYnMoci55LWl0LnkpPD0zKTsKICAgICAgaWYoIXJvdyl7cm93PXt5Oml0LnksaXRlbXM6W119O3Jvd3MucHVzaChyb3cpfQogICAgICByb3cuaXRlbXMucHVzaChpdCk7CiAgICB9CiAgICByb3dzLnNvcnQoKGEsYik9PmIueS1hLnkpOwogICAgcmV0dXJuIHJvd3MubWFwKHI9PnIuaXRlbXMuc29ydCgoYSxiKT0+YS54LWIueCkubWFwKHg9Pngucykuam9pbigiICIpKS5qb2luKCJcbiIpOwogIH0KCiAgZm9yKGxldCBwPTE7cDw9cGRmLm51bVBhZ2VzO3ArKyl7CiAgICBjb25zdCBwYWdlPWF3YWl0IHBkZi5nZXRQYWdlKHApLHZpZXdwb3J0PXBhZ2UuZ2V0Vmlld3BvcnQoe3NjYWxlOjF9KSxjb250ZW50PWF3YWl0IHBhZ2UuZ2V0VGV4dENvbnRlbnQoKTsKICAgIGNvbnN0IGl0ZW1zPWNvbnRlbnQuaXRlbXMuZmlsdGVyKHg9Pnguc3RyJiZ4LnN0ci50cmltKCkpLm1hcCh4PT4oe3M6eC5zdHIseDp4LnRyYW5zZm9ybVs0XSx5OngudHJhbnNmb3JtWzVdfSkpOwogICAgY29uc3Qgc2ltcGxlPWl0ZW1zVG9MaW5lcyhpdGVtcyk7CiAgICBjb25zdCBtaWQ9dmlld3BvcnQud2lkdGgvMjsKICAgIGNvbnN0IGxlZnQ9aXRlbXNUb0xpbmVzKGl0ZW1zLmZpbHRlcih4PT54Lng8bWlkKSk7CiAgICBjb25zdCByaWdodD1pdGVtc1RvTGluZXMoaXRlbXMuZmlsdGVyKHg9PngueD49bWlkKSk7CiAgICBzdGF0ZS5wYWdlVGV4dC5wdXNoKHNpbXBsZSk7CiAgICBzdGF0ZS5wYWdlQ29sdW1uVGV4dC5wdXNoKGxlZnQrIlxuIityaWdodCk7CiAgICAkKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPU1hdGgucm91bmQocC9wZGYubnVtUGFnZXMqMzUpKyIlIjsKICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PWDEkGFuZyDEkeG7jWMgbOG7m3AgdGV4dDogJHtwfS8ke3BkZi5udW1QYWdlc31gOwogIH0KICByZXR1cm4gcGRmOwp9CgpmdW5jdGlvbiB0ZXh0UXVhbGl0eSgpewogIGNvbnN0IGNoYXJzPXN0YXRlLnBhZ2VUZXh0LnJlZHVjZSgobixzKT0+bitzLmxlbmd0aCwwKTsKICByZXR1cm4ge2NoYXJzLGF2ZzpjaGFycy9NYXRoLm1heCgxLHN0YXRlLnBhZ2VUZXh0Lmxlbmd0aCl9Owp9Cgphc3luYyBmdW5jdGlvbiByZW5kZXJQYWdlQ2FudmFzKHBhZ2VObyxzY2FsZT0xLjc1KXsKICBjb25zdCBwYWdlPWF3YWl0IHN0YXRlLnBkZi5nZXRQYWdlKHBhZ2VObyksdmlld3BvcnQ9cGFnZS5nZXRWaWV3cG9ydCh7c2NhbGV9KTsKICBjb25zdCBjYW52YXM9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgiY2FudmFzIik7Y2FudmFzLndpZHRoPU1hdGguY2VpbCh2aWV3cG9ydC53aWR0aCk7Y2FudmFzLmhlaWdodD1NYXRoLmNlaWwodmlld3BvcnQuaGVpZ2h0KTsKICBhd2FpdCBwYWdlLnJlbmRlcih7Y2FudmFzQ29udGV4dDpjYW52YXMuZ2V0Q29udGV4dCgiMmQiKSx2aWV3cG9ydH0pLnByb21pc2U7cmV0dXJuIGNhbnZhczsKfQoKZnVuY3Rpb24gcHJlcHJvY2Vzc09jckNhbnZhcyhzcmMpewogIGNvbnN0IG91dD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJjYW52YXMiKTsKICBvdXQud2lkdGg9c3JjLndpZHRoOyBvdXQuaGVpZ2h0PXNyYy5oZWlnaHQ7CiAgY29uc3QgY3R4PW91dC5nZXRDb250ZXh0KCIyZCIse3dpbGxSZWFkRnJlcXVlbnRseTp0cnVlfSk7CiAgY3R4LmRyYXdJbWFnZShzcmMsMCwwKTsKICBjb25zdCBpbWc9Y3R4LmdldEltYWdlRGF0YSgwLDAsb3V0LndpZHRoLG91dC5oZWlnaHQpOwogIGNvbnN0IGQ9aW1nLmRhdGE7CgogIC8vIEhpc3RvZ3JhbSBncmF5c2NhbGUgZm9yIHJvYnVzdCB0aHJlc2hvbGQuCiAgY29uc3QgaGlzdD1uZXcgQXJyYXkoMjU2KS5maWxsKDApOwogIGZvcihsZXQgaT0wO2k8ZC5sZW5ndGg7aSs9NCl7CiAgICBjb25zdCBnPU1hdGgubWF4KDAsTWF0aC5taW4oMjU1LE1hdGgucm91bmQoMC4yOTkqZFtpXSswLjU4NypkW2krMV0rMC4xMTQqZFtpKzJdKSkpOwogICAgaGlzdFtnXSsrOwogIH0KICBsZXQgdG90YWw9b3V0LndpZHRoKm91dC5oZWlnaHQsc3VtPTA7CiAgZm9yKGxldCBpPTA7aTwyNTY7aSsrKSBzdW0rPWkqaGlzdFtpXTsKICBsZXQgc3VtQj0wLHdCPTAsbWF4VmFyPTAsdGhyPTE3ODsKICBmb3IobGV0IHQ9MDt0PDI1Njt0KyspewogICAgd0IrPWhpc3RbdF07IGlmKCF3QikgY29udGludWU7CiAgICBjb25zdCB3Rj10b3RhbC13QjsgaWYoIXdGKSBicmVhazsKICAgIHN1bUIrPXQqaGlzdFt0XTsKICAgIGNvbnN0IG1CPXN1bUIvd0IsbUY9KHN1bS1zdW1CKS93RjsKICAgIGNvbnN0IHY9d0Iqd0YqKG1CLW1GKSoobUItbUYpOwogICAgaWYodj5tYXhWYXIpe21heFZhcj12O3Rocj10fQogIH0KICAvLyBBdm9pZCBvdmVybHkgYWdncmVzc2l2ZSB0aHJlc2hvbGQgZm9yIHBhbGUgc2NhbnMuCiAgdGhyPU1hdGgubWF4KDE0NSxNYXRoLm1pbigyMDUsdGhyKzEyKSk7CgogIGZvcihsZXQgaT0wO2k8ZC5sZW5ndGg7aSs9NCl7CiAgICBsZXQgZz0wLjI5OSpkW2ldKzAuNTg3KmRbaSsxXSswLjExNCpkW2krMl07CiAgICAvLyBjb250cmFzdCBzdHJldGNoIGJlZm9yZSBiaW5hcml6YXRpb24KICAgIGc9KGctMTI4KSoxLjIyKzEyODsKICAgIGNvbnN0IHY9Zzx0aHI/MDoyNTU7CiAgICBkW2ldPWRbaSsxXT1kW2krMl09djsKICAgIGRbaSszXT0yNTU7CiAgfQogIGN0eC5wdXRJbWFnZURhdGEoaW1nLDAsMCk7CiAgcmV0dXJuIG91dDsKfQoKZnVuY3Rpb24gb2NyUXVhbGl0eVNjb3JlKHRleHQsY29uZmlkZW5jZT0wKXsKICBjb25zdCBmPWZvbGRWTih0ZXh0fHwiIik7CiAgbGV0IHNjb3JlPU51bWJlcihjb25maWRlbmNlKXx8MDsKICBjb25zdCBwYXRlbnRXb3Jkcz1bIllFVSBDQVUgQkFPIEhPIiwiUVVZIFRSSU5IIiwiUEhVT05HIFBIQVAiLCJCQU8gR09NIiwiVFJPTkcgRE8iLCJTQU5HIENIRSIsIlRISUVUIEJJIiwiSEUgVEhPTkciLCJUSEFOSCBQSEFOIl07CiAgZm9yKGNvbnN0IHcgb2YgcGF0ZW50V29yZHMpIGlmKGYuaW5jbHVkZXModykpIHNjb3JlKz04OwogIHNjb3JlKz1NYXRoLm1pbigyMCwodGV4dHx8IiIpLmxlbmd0aC8yNTApOwogIC8vIFBlbmFsaXplIG9idmlvdXMgT0NSIGdhcmJhZ2UuCiAgY29uc3Qgd2VpcmQ9KCh0ZXh0fHwiIikubWF0Y2goL1t8e308Pn5eYF0vZyl8fFtdKS5sZW5ndGg7CiAgc2NvcmUtPU1hdGgubWluKDIwLHdlaXJkKjIpOwogIHJldHVybiBzY29yZTsKfQoKCmNvbnN0IHNsZWVwID0gbXMgPT4gbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7CmZ1bmN0aW9uIHdpdGhUaW1lb3V0KHByb21pc2UsIG1zLCBsYWJlbCl7CiAgbGV0IHRpbWVyOwogIGNvbnN0IHRpbWVvdXQgPSBuZXcgUHJvbWlzZSgoXywgcmVqZWN0KSA9PiB7CiAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihsYWJlbCArICIgcXXDoSB0aOG7nWkgZ2lhbiIpKSwgbXMpOwogIH0pOwogIHJldHVybiBQcm9taXNlLnJhY2UoW3Byb21pc2UsIHRpbWVvdXRdKS5maW5hbGx5KCgpID0+IGNsZWFyVGltZW91dCh0aW1lcikpOwp9CgpsZXQgb2NyV29ya2VyUHJvbWlzZSA9IG51bGw7CmFzeW5jIGZ1bmN0aW9uIGdldE9jcldvcmtlcihyZWFzb249Ik9DUiIpewogIGlmKG9jcldvcmtlclByb21pc2UpIHJldHVybiBvY3JXb3JrZXJQcm9taXNlOwogIGlmKCF3aW5kb3cuVGVzc2VyYWN0KSB0aHJvdyBuZXcgRXJyb3IoIktow7RuZyB04bqjaSDEkcaw4bujYyBUZXNzZXJhY3QuanMuIik7CgogIHNldERldGVjdCgiZGV0T0NSIixmYWxzZSwixJBhbmcga2jhu59pIHThuqFvIE9DUi4uLiIpOwogICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50ID0gcmVhc29uICsgIjogxJFhbmcgdOG6o2kgYuG7mSBuaOG6rW4gZGnhu4duLi4uIjsKICBhd2FpdCBzbGVlcCg4MCk7IC8vIG5oxrDhu51uZyBicm93c2VyIHJlcGFpbnQgdHLGsOG7m2Mga2hpIGto4bufaSB04bqhbyBXZWIgV29ya2VyCgogIGNvbnN0IGxhbmcgPSAkKCJqdXJpc2RpY3Rpb24iKS52YWx1ZSA9PT0gIlVTIiA/ICJlbmciIDogWyJ2aWUiLCJlbmciXTsKICBvY3JXb3JrZXJQcm9taXNlID0gd2l0aFRpbWVvdXQoCiAgICBUZXNzZXJhY3QuY3JlYXRlV29ya2VyKGxhbmcsIDEsIHsKICAgICAgbG9nZ2VyOiBtID0+IHsKICAgICAgICBpZihtICYmIG0uc3RhdHVzID09PSAicmVjb2duaXppbmcgdGV4dCIpewogICAgICAgICAgY29uc3QgcGN0ID0gTWF0aC5yb3VuZCgobS5wcm9ncmVzcyB8fCAwKSAqIDEwMCk7CiAgICAgICAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudCA9IGAke3JlYXNvbn06IG5o4bqtbiBkaeG7h24gJHtwY3R9JWA7CiAgICAgICAgfQogICAgICB9CiAgICB9KSwKICAgIDI1MDAwLAogICAgIkto4bufaSB04bqhbyBPQ1IiCiAgKTsKCiAgdHJ5ewogICAgcmV0dXJuIGF3YWl0IG9jcldvcmtlclByb21pc2U7CiAgfWNhdGNoKGUpewogICAgb2NyV29ya2VyUHJvbWlzZSA9IG51bGw7CiAgICB0aHJvdyBlOwogIH0KfQoKYXN5bmMgZnVuY3Rpb24gb2NyU2VsZWN0ZWRQYWdlcyhwYWdlTm9zLHJlYXNvbj0iT0NSIil7CiAgaWYoIXN0YXRlLnBkZikgcmV0dXJuIGZhbHNlOwogIHRyeXsKICAgIGxldCBsb2NhbFdvcmtlcj1udWxsOwogICAgbGV0IGRvbmU9MDsKCiAgICBmb3IoY29uc3QgcCBvZiBwYWdlTm9zKXsKICAgICAgaWYoc3RhdGUub2NyUGFnZXNbcF0pe2RvbmUrKztjb250aW51ZTt9CgogICAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1gJHtyZWFzb259OiDEkWFuZyDEkeG7jWMgdHJhbmcgJHtwfS4uLmA7CiAgICAgIGF3YWl0IHNsZWVwKDI1KTsKCiAgICAgIC8vIMavdSB0acOqbiBHb29nbGUgVmlzaW9uIE9DUiBu4bq/dSBiYWNrZW5kIMSRw6MgY+G6pXUgaMOsbmgga2V5LgogICAgICBjb25zdCBjbG91ZENhbnZhcz1hd2FpdCByZW5kZXJQYWdlQ2FudmFzKHAsMi4xNSk7CiAgICAgIGxldCBiZXN0VGV4dD1hd2FpdCBjbG91ZFZpc2lvbk9jcihjbG91ZENhbnZhcyk7CgogICAgICBpZihiZXN0VGV4dCAmJiBiZXN0VGV4dC5sZW5ndGg+MjApewogICAgICAgIHN0YXRlLm9jclBhZ2VzW3BdPW5vcm1hbGl6ZU9jclRleHQoYmVzdFRleHQpOwogICAgICAgIHNldERldGVjdCgiZGV0T0NSIix0cnVlLGBHb29nbGUgVmlzaW9uIE9DUiDCtyB0cmFuZyAke3B9YCk7CiAgICAgIH1lbHNlewogICAgICAgIC8vIFRlc3NlcmFjdCBjaOG7iSBsw6AgZmFsbGJhY2sgbG9jYWwuCiAgICAgICAgaWYoIWxvY2FsV29ya2VyKSBsb2NhbFdvcmtlcj1hd2FpdCBnZXRPY3JXb3JrZXIocmVhc29uKyIgKGxvY2FsKSIpOwogICAgICAgIHRyeXsKICAgICAgICAgIGF3YWl0IGxvY2FsV29ya2VyLnNldFBhcmFtZXRlcnMoewogICAgICAgICAgICBwcmVzZXJ2ZV9pbnRlcndvcmRfc3BhY2VzOiIxIiwKICAgICAgICAgICAgdXNlcl9kZWZpbmVkX2RwaToiMzAwIiwKICAgICAgICAgICAgdGVzc2VkaXRfcGFnZXNlZ19tb2RlOiI2IgogICAgICAgICAgfSk7CiAgICAgICAgfWNhdGNoKF9lKXt9CgogICAgICAgIGNvbnN0IHJhd0NhbnZhcz1hd2FpdCByZW5kZXJQYWdlQ2FudmFzKHAsMi41KTsKICAgICAgICBjb25zdCBjbGVhbkNhbnZhcz1wcmVwcm9jZXNzT2NyQ2FudmFzKHJhd0NhbnZhcyk7CgogICAgICAgIGxldCByZXN1bHQxPWF3YWl0IHdpdGhUaW1lb3V0KAogICAgICAgICAgbG9jYWxXb3JrZXIucmVjb2duaXplKGNsZWFuQ2FudmFzKSwKICAgICAgICAgIDYwMDAwLAogICAgICAgICAgIk9DUiB0cmFuZyAiK3AKICAgICAgICApOwogICAgICAgIGJlc3RUZXh0PShyZXN1bHQxJiZyZXN1bHQxLmRhdGEmJnJlc3VsdDEuZGF0YS50ZXh0KXx8IiI7CiAgICAgICAgbGV0IGJlc3RTY29yZT1vY3JRdWFsaXR5U2NvcmUoYmVzdFRleHQscmVzdWx0MSYmcmVzdWx0MS5kYXRhJiZyZXN1bHQxLmRhdGEuY29uZmlkZW5jZSk7CgogICAgICAgIGlmKGJlc3RTY29yZTw3Nil7CiAgICAgICAgICB0cnl7CiAgICAgICAgICAgIGNvbnN0IHJlc3VsdDI9YXdhaXQgd2l0aFRpbWVvdXQoCiAgICAgICAgICAgICAgbG9jYWxXb3JrZXIucmVjb2duaXplKHJhd0NhbnZhcyksCiAgICAgICAgICAgICAgNjAwMDAsCiAgICAgICAgICAgICAgIk9DUiBraeG7g20gdHJhIHRyYW5nICIrcAogICAgICAgICAgICApOwogICAgICAgICAgICBjb25zdCB0Mj0ocmVzdWx0MiYmcmVzdWx0Mi5kYXRhJiZyZXN1bHQyLmRhdGEudGV4dCl8fCIiOwogICAgICAgICAgICBjb25zdCBzMj1vY3JRdWFsaXR5U2NvcmUodDIscmVzdWx0MiYmcmVzdWx0Mi5kYXRhJiZyZXN1bHQyLmRhdGEuY29uZmlkZW5jZSk7CiAgICAgICAgICAgIGlmKHMyPmJlc3RTY29yZSl7YmVzdFRleHQ9dDI7YmVzdFNjb3JlPXMyfQogICAgICAgICAgfWNhdGNoKF9lKXt9CiAgICAgICAgfQogICAgICAgIHN0YXRlLm9jclBhZ2VzW3BdPW5vcm1hbGl6ZU9jclRleHQoYmVzdFRleHQpOwogICAgICAgIHNldERldGVjdCgiZGV0T0NSIix0cnVlLGBPQ1IgbG9jYWwgwrcgdHJhbmcgJHtwfWApOwogICAgICB9CgogICAgICBkb25lKys7CiAgICAgICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9KDQ1K01hdGgucm91bmQoZG9uZS9wYWdlTm9zLmxlbmd0aCo1MCkpKyIlIjsKICAgIH0KCiAgICBzZXREZXRlY3QoImRldE9DUiIsdHJ1ZSxzdGF0ZS5jbG91ZE9jcj09PXRydWU/YEdvb2dsZSBWaXNpb24gT0NSIMK3ICR7cGFnZU5vcy5sZW5ndGh9IHRyYW5nYDpgT0NSIGhvw6BuIHThuqV0IMK3ICR7cGFnZU5vcy5sZW5ndGh9IHRyYW5nYCk7CiAgICByZXR1cm4gdHJ1ZTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLmVycm9yKCJPQ1IgZXJyb3IiLGUpOwogICAgc2V0RGV0ZWN0KCJkZXRPQ1IiLGZhbHNlLCJPQ1Iga2jDtG5nIGto4bqjIGThu6VuZyIpOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9Ik9DUiBraMO0bmcgY2jhuqF5IMSRxrDhu6NjOiAiK1N0cmluZyhlLm1lc3NhZ2V8fGUpOwogICAgcmV0dXJuIGZhbHNlOwogIH0KfQoKZnVuY3Rpb24gaGFzQ2xhaW1NYXJrZXIodCl7CiAgcmV0dXJuICEhY2xhaW1NYXJrZXJJbmZvKHQpOwp9Cgphc3luYyBmdW5jdGlvbiBzbWFydE9jckNsYWltcyhhdXRvPWZhbHNlKXsKICBpZighc3RhdGUucGRmKSByZXR1cm4gZmFsc2U7CgogIGNvbnN0IG49c3RhdGUucGRmLm51bVBhZ2VzOwogIC8vIENsYWltcyBj4bunYSBi4bqxbmcgVk4gdGjGsOG7nW5nIG7hurFtIG5nYXkgdHLGsOG7m2MgcGjhuqduIGjDrG5oIHbhur0uCiAgLy8gVuG7m2kgUERGIDE0IHRyYW5nIGPhu6dhIMSQaeG7gW4gVHLDumMsIHRo4bupIHThu7EgbsOgeSBPQ1IgdHJhbmcgMTIgxJDhuqZVIFRJw4pOLgogIGNvbnN0IHJhd09yZGVyPVtuLTIsbi0zLG4tMSxuLTQsbixuLTUsbi02LG4tN107CiAgY29uc3QgY2FuZGlkYXRlcz1bLi4ubmV3IFNldChyYXdPcmRlcildLmZpbHRlcihwPT5wPj0xICYmIHA8PW4pOwoKICBzZXREZXRlY3QoImRldE9DUiIsZmFsc2UsIsSQYW5nIE9DUiBjbGFpbXMuLi4iKTsKICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1hdXRvCiAgICA/ICJQREYgZOG6oW5nIHNjYW4g4oCUIMSRYW5nIHThu7EgcXXDqXQgY8OhYyB0cmFuZyBjdeG7kWkgxJHhu4MgdMOsbSBZw6p1IGPhuqd1IGLhuqNvIGjhu5kuLi4iCiAgICA6ICLEkGFuZyBxdcOpdCBjw6FjIHRyYW5nIGN14buRaSDEkeG7gyB0w6xtIFnDqnUgY+G6p3UgYuG6o28gaOG7mS4uLiI7CgogIGxldCBmb3VuZFBhZ2U9bnVsbDsKCiAgZm9yKGxldCBpPTA7aTxjYW5kaWRhdGVzLmxlbmd0aDtpKyspewogICAgY29uc3QgcD1jYW5kaWRhdGVzW2ldOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YE9DUiB5w6p1IGPhuqd1IGLhuqNvIGjhu5k6IHRyYW5nICR7cH0vJHtufSAoJHtpKzF9LyR7Y2FuZGlkYXRlcy5sZW5ndGh9KS4uLmA7CgogICAgY29uc3Qgb2s9YXdhaXQgb2NyU2VsZWN0ZWRQYWdlcyhbcF0sYE9DUiB0cmFuZyAke3B9YCk7CiAgICBpZighb2spewogICAgICAvLyBPQ1IgZmFpbCB0aMOsIHRob8OhdCBz4bqhY2gsIEtIw5RORyB0cmVvIFVJLgogICAgICAkKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPSIxMDAlIjsKICAgICAgcmV0dXJuIGZhbHNlOwogICAgfQoKICAgIGNvbnN0IHQ9c3RhdGUub2NyUGFnZXNbcF18fCIiOwogICAgaWYoaGFzQ2xhaW1NYXJrZXIodCkgfHwgbG9va3NMaWtlQ2xhaW1QYWdlKHQpKXsKICAgICAgZm91bmRQYWdlPXA7CiAgICAgIGJyZWFrOwogICAgfQogIH0KCiAgaWYoIWZvdW5kUGFnZSl7CiAgICBzdGF0ZS5yYXdUZXh0PW1lcmdlZFRleHQoKTsKICAgIGNvbnN0IGZhbGxiYWNrPWNhbmRpZGF0ZUNsYWltc1RleHQoKTsKICAgIHN0YXRlLmNsYWltc1RleHQ9ZmFsbGJhY2t8fCIiOwogICAgJCgiY2xhaW1zUmF3IikudmFsdWU9c3RhdGUuY2xhaW1zVGV4dDskKCJjbGFpbXNDbGVhbiIpLnZhbHVlPWZvcm1hdENsYWltRm9yRGlzcGxheShzdGF0ZS5jbGFpbXNUZXh0KTsKICAgIHN0YXRlLmNsYWltcz1wYXJzZUNsYWltcyhzdGF0ZS5jbGFpbXNUZXh0KTsKICAgIHN0YXRlLnNlbGVjdGVkPTA7CiAgICByZW5kZXJDbGFpbXMoKTsKICAgIHNldERldGVjdCgiZGV0Q2xhaW1zIixzdGF0ZS5jbGFpbXMubGVuZ3RoPjAsCiAgICAgIHN0YXRlLmNsYWltcy5sZW5ndGg/YMSQw6MgdMOhY2ggJHtzdGF0ZS5jbGFpbXMubGVuZ3RofSBjbGFpbWA6Ik9DUiB4b25nIG5oxrBuZyBjaMawYSB0w6xtIHRo4bqleSBjbGFpbSIpOwogICAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMTAwJSI7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1zdGF0ZS5jbGFpbXMubGVuZ3RoCiAgICAgID9gT0NSIGhvw6BuIHThuqV0LiDEkMOjIG5o4bqtbiBkaeG7h24gJHtzdGF0ZS5jbGFpbXMubGVuZ3RofSBjbGFpbS5gCiAgICAgIDoixJDDoyBxdcOpdCBjw6FjIHRyYW5nIGN14buRaSBuaMawbmcgY2jGsGEgbmjhuq1uIGRp4buHbiDEkcaw4bujYyBjbGFpbS4gQuG6oW4gduG6q24gY8OzIHRo4buDIHBhc3RlIGNsYWltcyDhu58gYsaw4bubYyAyLiI7CiAgICByZXR1cm4gc3RhdGUuY2xhaW1zLmxlbmd0aD4wOwogIH0KCiAgLy8gT0NSIHRow6ptIDEgdHJhbmcga+G6vyB0aeG6v3AgdsOsIGNsYWltcyBjw7MgdGjhu4Mga8OpbyBkw6BpIHNhbmcgdHJhbmcgc2F1LgogIGNvbnN0IGZvbGxvdz1mb3VuZFBhZ2UrMTsKICBpZihmb2xsb3c8PW4gJiYgIXN0YXRlLm9jclBhZ2VzW2ZvbGxvd10pewogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YMSQw6MgdMOsbSB0aOG6pXkgdHJhbmcgY2xhaW1zICR7Zm91bmRQYWdlfTsgxJFhbmcga2nhu4NtIHRyYSB0cmFuZyAke2ZvbGxvd30uLi5gOwogICAgYXdhaXQgb2NyU2VsZWN0ZWRQYWdlcyhbZm9sbG93XSxgT0NSIHRyYW5nICR7Zm9sbG93fWApOwogIH0KCiAgY29uc3QgY2xhaW1QYWdlcz1bZm91bmRQYWdlXTsKICBpZihmb2xsb3c8PW4gJiYgc3RhdGUub2NyUGFnZXNbZm9sbG93XSkgY2xhaW1QYWdlcy5wdXNoKGZvbGxvdyk7CiAgY29uc3Qgam9pbmVkPWNsYWltUGFnZXMubWFwKHA9PnN0YXRlLm9jclBhZ2VzW3BdfHwiIikuam9pbigiXG5cbiIpOwoKICBzdGF0ZS5yYXdUZXh0PW1lcmdlZFRleHQoKTsKICBsZXQgYz1leHRyYWN0Q2xhaW1zVGFpbChqb2luZWQpOwogIGlmKCFjKSBjPWNhbmRpZGF0ZUNsYWltc1RleHQoKTsKICBpZighYyAmJiBsb29rc0xpa2VDbGFpbVBhZ2Uoam9pbmVkKSkgYz1jbGVhbihqb2luZWQpOwoKICBzdGF0ZS5jbGFpbXNUZXh0PWN8fCIiOwogICQoImNsYWltc1JhdyIpLnZhbHVlPXN0YXRlLmNsYWltc1RleHQ7JCgiY2xhaW1zQ2xlYW4iKS52YWx1ZT1mb3JtYXRDbGFpbUZvckRpc3BsYXkoc3RhdGUuY2xhaW1zVGV4dCk7CiAgc3RhdGUuY2xhaW1zPXBhcnNlQ2xhaW1zKHN0YXRlLmNsYWltc1RleHQpOwogIHN0YXRlLnNlbGVjdGVkPTA7CiAgcmVuZGVyQ2xhaW1zKCk7CgogIHNldERldGVjdCgiZGV0Q2xhaW1zIixzdGF0ZS5jbGFpbXMubGVuZ3RoPjAsCiAgICBzdGF0ZS5jbGFpbXMubGVuZ3RoP2DEkMOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW1gOiLEkMOjIHRo4bqleSB0cmFuZyBjbGFpbXMgbmjGsG5nIHBhcnNlciBjaMawYSB0w6FjaCDEkcaw4bujYyIpOwogICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjEwMCUiOwogICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PXN0YXRlLmNsYWltcy5sZW5ndGgKICAgID9gSG/DoG4gdOG6pXQuIFTDrG0gdGjhuqV5IFnDqnUgY+G6p3UgYuG6o28gaOG7mSDhu58gdHJhbmcgJHtmb3VuZFBhZ2V9IHbDoCDEkcOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW0uYAogICAgOmDEkMOjIHTDrG0gdGjhuqV5IHRyYW5nIFnDqnUgY+G6p3UgYuG6o28gaOG7mSAke2ZvdW5kUGFnZX0sIG5oxrBuZyBj4bqnbiBraeG7g20gdHJhIG7hu5lpIGR1bmcg4bufIGLGsOG7m2MgMi5gOwoKICByZXR1cm4gc3RhdGUuY2xhaW1zLmxlbmd0aD4wOwp9CgpmdW5jdGlvbiBtZXJnZWRUZXh0KCl7CiAgY29uc3Qgb3V0PVtdOwogIGZvcihsZXQgaT0wO2k8c3RhdGUucGFnZVRleHQubGVuZ3RoO2krKylvdXQucHVzaCgoc3RhdGUucGFnZVRleHRbaV18fCIiKS5sZW5ndGg+ODA/c3RhdGUucGFnZVRleHRbaV06KHN0YXRlLm9jclBhZ2VzW2krMV18fHN0YXRlLnBhZ2VUZXh0W2ldfHwiIikpOwogIHJldHVybiBvdXQuam9pbigiXG5cbiIpOwp9CmZ1bmN0aW9uIGNhbmRpZGF0ZUNsYWltc1RleHQoKXsKICBjb25zdCBzb3VyY2VzPVsuLi5zdGF0ZS5wYWdlQ29sdW1uVGV4dCwuLi5zdGF0ZS5wYWdlVGV4dCxPYmplY3QudmFsdWVzKHN0YXRlLm9jclBhZ2VzKV07CgogIGxldCBiZXN0PSIiOwogIGZvcihjb25zdCBzcmMgb2Ygc291cmNlcyl7CiAgICBpZighc3JjKSBjb250aW51ZTsKICAgIGNvbnN0IHRhaWw9ZXh0cmFjdENsYWltc1RhaWwoc3JjKTsKICAgIGlmKHRhaWwgJiYgdGFpbC5sZW5ndGg+YmVzdC5sZW5ndGgpIGJlc3Q9dGFpbDsKICB9CiAgaWYoYmVzdC5sZW5ndGg+NDApIHJldHVybiBiZXN0LnNsaWNlKDAsODAwMDApOwoKICBjb25zdCB0YWlsPVsuLi5zdGF0ZS5wYWdlQ29sdW1uVGV4dC5zbGljZSgtOCksLi4uT2JqZWN0LnZhbHVlcyhzdGF0ZS5vY3JQYWdlcyldLmpvaW4oIlxuIik7CiAgcmV0dXJuIGV4dHJhY3RDbGFpbXNUYWlsKHRhaWwpOwp9CmZ1bmN0aW9uIHBhcnNlQ2xhaW1zKHRleHQpewogIGxldCB0PW5vcm1hbGl6ZU9jclRleHQodGV4dHx8IiIpLnJlcGxhY2UoL1xyL2csIlxuIik7CgogIC8vIE9DUiB0aMaw4budbmcgY2hvOiAiMSAuIiwgIjEpIiwgIjEgKSIsIGhv4bq3YyB4deG7kW5nIGTDsm5nIHRyxrDhu5tjIHPhu5EuCiAgdD10LnJlcGxhY2UoLyg/Ol58XG4pXHMqKFxkezEsMn0pXHMqW1wuXCldXHMqL2csIlxuJDEuICIpOwoKICBsZXQgbWF0Y2hlcz1bLi4udC5tYXRjaEFsbCgvKD86XnxcbilccyooXGR7MSwyfSlcLlxzKihbXHNcU10qPykoPz0oPzpcblxzKlxkezEsMn1cLlxzKil8JCkvZyldOwogIGxldCBhcnI9bWF0Y2hlcwogICAgLm1hcChtPT4oe2lkOittWzFdLHRleHQ6Y2xlYW4obVsyXSl9KSkKICAgIC5maWx0ZXIoeD0+eC50ZXh0Lmxlbmd0aD4xNSk7CgogIC8vIEZhbGxiYWNrIGTDoG5oIGNobyBPQ1IgbMOgbSBt4bqldCBk4bqldSAiLiIgc2F1IHPhu5EgY2xhaW0uCiAgaWYoIWFyci5sZW5ndGgpewogICAgY29uc3QgZj1mb2xkVk4odCk7CiAgICBjb25zdCBmaXJzdD1mLnNlYXJjaCgvKD86XnxcbnxccykxXHMrKFFVWSBUUklOSHxQSFVPTkcgUEhBUHxTQU4gUEhBTXxUSElFVCBCSXxIRSBUSE9OR3xDSEUgUEhBTXxBXHN8QU5cc3xUSEVccykvKTsKICAgIGlmKGZpcnN0Pj0wKXsKICAgICAgY29uc3QgYm9keT1jbGVhbih0LnNsaWNlKGZpcnN0KSk7CiAgICAgIGFycj1be2lkOjEsdGV4dDpib2R5LnJlcGxhY2UoL15ccyoxXHMqLywiIil9XTsKICAgIH0KICB9CgogIGFycj1hcnIKICAgIC5maWx0ZXIoKHgsaSxhKT0+YS5maW5kSW5kZXgoeT0+eS5pZD09PXguaWQpPT09aSkKICAgIC5zb3J0KChhLGIpPT5hLmlkLWIuaWQpCiAgICAuc2xpY2UoMCw2MCk7CgogIHJldHVybiBhcnIubWFwKChjLGkpPT4oewogICAgLi4uYywKICAgIHR5cGU6L2FjY29yZGluZyB0byBjbGFpbVxzK1xkK3x0aGVvICg/OsSRaeG7g218ecOqdSBj4bqndSBi4bqjbyBo4buZfGNsYWltKVxzKlxkKy9pLnRlc3QoYy50ZXh0KQogICAgICA/IlBo4bulIHRodeG7mWMiCiAgICAgIDooaT09PTA/IsSQ4buZYyBs4bqtcCI6IkNoxrBhIHjDoWMgxJHhu4tuaCIpCiAgfSkpOwp9CmZ1bmN0aW9uIGd1ZXNzSnVyKHRleHQsbm8pewogaWYoL0Phu6RDIFPhu54gSOG7rlUgVFLDjSBUVeG7hnxD4buZbmcgaMOyYSB4w6MgaOG7mWkgY2jhu6cgbmdoxKlhIFZp4buHdCBOYW0vaS50ZXN0KHRleHQpfHwvXlsxMl0tXGR7NSx9Ly50ZXN0KG5vKSlyZXR1cm4iVk4iOwogaWYoL1VuaXRlZCBTdGF0ZXMgUGF0ZW50fFVcLlNcLiBQYXRlbnQvaS50ZXN0KHRleHQpfHwvXlVTL2kudGVzdChubykpcmV0dXJuIlVTIjsKIGlmKC9eV08vaS50ZXN0KG5vKSlyZXR1cm4iV08vUENUIjtpZigvXkVQL2kudGVzdChubykpcmV0dXJuIkVQIjtyZXR1cm4iS2jDoWMiOwp9CmZ1bmN0aW9uIGV4dHJhY3RNZXRhZGF0YSh0ZXh0KXsKIGNvbnN0IG5vPWZpcnN0TWF0Y2godGV4dCxbCiAgL1woMTFcKVxzKihbMTJdLVxkezUsOH0pL2ksL1xiKFsxMl0tXGR7Niw4fSlcYi9pLC9cYlBhdGVudFxzKk5vXC4/XHMqOj9ccyooVVNccypbXGQsXStccypbQUJdXGQpXGIvaSwvXGIoVVNccz9cZHs3LDExfVxzP1tBQl1cZClcYi9pLC9cYihXT1xzP1xkezR9XC9cZHs1LDd9XHM/W0EtWl1cZD8pXGIvaQogXSkucmVwbGFjZSgvXHMrL2csIiAiKTsKIGNvbnN0IHRpdGxlPWZpcnN0TWF0Y2godGV4dCxbL1woNTRcKVxzKihbXHNcU117NSwyNTB9PykoPz1cKDU3XCl8XCg1NlwpfFwoNzNcKXxcKDcyXCl8JCkvaSwvVGl0bGVccyo6P1xzKihbXlxuXXs1LDI1MH0pL2ldKTsKIGxldCBmaWxpbmc9Zmlyc3RNYXRjaCh0ZXh0LFsvXCgyMlwpXHMqKFswLTlcL1wtLl17OCwxMH0pL2ksL0ZpbGVkXHMqOj9ccyooW0EtWmEtel17Myw5fVwuP1xzK1xkezEsMn0sXHMrXGR7NH0pL2ldKTtmaWxpbmc9bm9ybURhdGUoZmlsaW5nKTsKIGNvbnN0IGFwcGxpY2FudD1maXJzdE1hdGNoKHRleHQsWy9cKDczXClccyooW1xzXFNdezMsMjUwfT8pKD89XCg3MlwpfFwoNzRcKXxcKDU0XCl8JCkvaSwvXCg3MVwpXHMqKFtcc1xTXXszLDI1MH0/KSg/PVwoNzJcKXxcKDc0XCl8XCg1NFwpfCQpL2ksL0Fzc2lnbmVlXHMqOj9ccyooW15cbl17MywyNTB9KS9pLC9BcHBsaWNhbnRccyo6P1xzKihbXlxuXXszLDI1MH0pL2ldKTsKIGNvbnN0IHJlcD1maXJzdE1hdGNoKHRleHQsWy9cKDc0XClccyooW1xzXFNdezMsMjUwfT8pKD89XCg1NFwpfFwoNTdcKXwkKS9pLC9SZXByZXNlbnRhdGl2ZVxzKjo/XHMqKFteXG5dezMsMjUwfSkvaV0pOwogY29uc3QgaXBjPWZpcnN0TWF0Y2godGV4dCxbL1woNTFcKVxzKig/OlxkezR9XC5cZHsyfVxzKik/KFtBLUhdXGR7Mn1bQS1aXVxzKlxkK1wvXGQrKD86XHMqO1xzKltBLUhdXGR7Mn1bQS1aXVxzKlxkK1wvXGQrKSopL2ksL0ludFwuXHMqQ2xcLj9ccyo6P1xzKihbXlxuXXs1LDIyMH0pL2ldKTsKIGxldCBhYnM9Zmlyc3RNYXRjaCh0ZXh0LFsvXCg1N1wpXHMqKFtcc1xTXXs0MCwxNTAwfT8pKD89XChcZHsyfVwpfEZJRUxEIE9GfEzEqE5IIFbhu7BDfExJTkggVlVDfEJBQ0tHUk9VTkR8VMOMTkggVFLhuqBOR3xUSU5IIFRSQU5HKS9pLC9BQlNUUkFDVFxzKihbXHNcU117NDAsMTUwMH0/KSg/PUZJRUxEIE9GfEJBQ0tHUk9VTkR8Q0xBSU1TPykvaV0pOwogcmV0dXJue25vLHRpdGxlLGZpbGluZyxhcHBsaWNhbnQscmVwLGlwYyxhYnMsanVyOmd1ZXNzSnVyKHRleHQsbm8pfQp9CmZ1bmN0aW9uIGZpbGxNZXRhKG0pewogJCgicGF0ZW50Tm8iKS52YWx1ZT1tLm5vOyQoInRpdGxlIikudmFsdWU9bS50aXRsZTskKCJmaWxpbmdEYXRlIikudmFsdWU9bS5maWxpbmc7JCgiYXBwbGljYW50IikudmFsdWU9bS5hcHBsaWNhbnQ7JCgicmVwcmVzZW50YXRpdmUiKS52YWx1ZT1tLnJlcDskKCJpcGMiKS52YWx1ZT1tLmlwYzskKCJhYnN0cmFjdCIpLnZhbHVlPW0uYWJzOwogWy4uLiQoImp1cmlzZGljdGlvbiIpLm9wdGlvbnNdLmZvckVhY2goKG8saSk9PntpZihvLnZhbHVlPT09bS5qdXIpJCgianVyaXNkaWN0aW9uIikuc2VsZWN0ZWRJbmRleD1pfSk7CiBjb25zdCBiYXNlPShtLm5vfHwiUEFUIikucmVwbGFjZSgvXHMvZywiIikucmVwbGFjZSgvW15BLVphLXowLTktXS9nLCIiKTskKCJjYXNlSWQiKS52YWx1ZT0obS5qdXJ8fCJDQVNFIikrIi0iK2Jhc2U7JCgiY2FzZUJhZGdlIikudGV4dENvbnRlbnQ9JCgiY2FzZUlkIikudmFsdWU7CiBzZXREZXRlY3QoImRldE1ldGEiLCEhKG0ubm98fG0udGl0bGUpLG0ubm98fG0udGl0bGU/IsSQw6Mgbmjhuq1uIGRp4buHbiI6IkPhuqduIGtp4buDbSB0cmEiKTsKIHNldERldGVjdCgiZGV0QWJzdHJhY3QiLCEhbS5hYnMsbS5hYnM/IsSQw6Mgbmjhuq1uIGRp4buHbiI6IkNoxrBhIHTDrG0gdGjhuqV5Iik7Cn0KYXN5bmMgZnVuY3Rpb24gcHJvY2Vzc0ZpbGUoZmlsZSl7CiAgc3RhdGUub2NyUGFnZXM9e307CiAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMyUiOwogICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PSLEkGFuZyBt4bufIFBERi4uLiI7CgogIHRyeXsKICAgIGF3YWl0IHJlYWRQZGYoZmlsZSk7CiAgfWNhdGNoKGUpewogICAgY29uc29sZS5lcnJvcihlKTsKICAgICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjEwMCUiOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9Iktow7RuZyB0aOG7gyBt4bufIFBERjogIisoZSYmZS5tZXNzYWdlP2UubWVzc2FnZTplKTsKICAgIGFsZXJ0KCJLaMO0bmcgdGjhu4MgbeG7nyBmaWxlIFBERiBuw6B5LiIpOwogICAgcmV0dXJuOwogIH0KCiAgbGV0IGNvbWJpbmVkPXN0YXRlLnBhZ2VUZXh0LmpvaW4oIlxuIik7CiAgc3RhdGUucmF3VGV4dD1jb21iaW5lZDsKCiAgLy8gMSkgTWV0YWRhdGEgdOG7qyB0ZXh0IGxheWVyIHRyxrDhu5tjLgogIGxldCBtZXRhPXt9OwogIHRyeXsKICAgIG1ldGE9ZXh0cmFjdE1ldGFkYXRhKGNvbWJpbmVkKTsKICAgIGZpbGxNZXRhKG1ldGEpOwogIH1jYXRjaChlKXsgY29uc29sZS53YXJuKCJNZXRhZGF0YSBwYXJzZSBlcnJvciIsZSk7IH0KCiAgLy8gMikgTuG6v3UgbWV0YWRhdGEgY2jDrW5oIGPDsm4gdGhp4bq/dSwgT0NSIHRyYW5nIMSR4bqndS4KICBpZighbWV0YS5ubyB8fCAhbWV0YS50aXRsZSl7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD0iUERGIGThuqFuZyBzY2FuIOKAlCDEkWFuZyBPQ1IgdHJhbmcgxJHhuqd1IMSR4buDIGzhuqV5IHRow7RuZyB0aW4gc8OhbmcgY2jhur8uLi4iOwogICAgY29uc3Qgb2tNZXRhPWF3YWl0IG9jclNlbGVjdGVkUGFnZXMoWzFdLCJPQ1IgbWV0YWRhdGEiKTsKICAgIGlmKG9rTWV0YSl7CiAgICAgIGNvbWJpbmVkPW1lcmdlZFRleHQoKTsKICAgICAgc3RhdGUucmF3VGV4dD1jb21iaW5lZDsKICAgICAgdHJ5ewogICAgICAgIG1ldGE9ZXh0cmFjdE1ldGFkYXRhKGNvbWJpbmVkKTsKICAgICAgICBmaWxsTWV0YShtZXRhKTsKICAgICAgfWNhdGNoKGUpeyBjb25zb2xlLndhcm4oIk9DUiBtZXRhZGF0YSBwYXJzZSBlcnJvciIsZSk7IH0KICAgIH0KICB9CgogIC8vIDMpIFTDrG0gY2xhaW1zIHRyb25nIHRleHQgbGF5ZXIvT0NSIGhp4buHbiBjw7MuCiAgbGV0IGNsYWltcz0iIjsKICB0cnl7IGNsYWltcz1jYW5kaWRhdGVDbGFpbXNUZXh0KCk7IH1jYXRjaChlKXsgY29uc29sZS53YXJuKGUpOyB9CgogIGlmKGNsYWltcyl7CiAgICBzdGF0ZS5jbGFpbXNUZXh0PWNsYWltczsKICAgICQoImNsYWltc1JhdyIpLnZhbHVlPWNsYWltczsKICAgIHN0YXRlLmNsYWltcz1wYXJzZUNsYWltcyhjbGFpbXMpOwogICAgc3RhdGUuc2VsZWN0ZWQ9MDsKICAgIHJlbmRlckNsYWltcygpOwogIH0KCiAgLy8gNCkgTuG6v3UgY2jGsGEgY8OzIGNsYWltcywgT0NSIHRoZW8gdGjhu6kgdOG7sSDGsHUgdGnDqm4gdHJhbmcgbi0yLCBuLTMuLi4KICBpZighc3RhdGUuY2xhaW1zLmxlbmd0aCl7CiAgICBhd2FpdCBzbWFydE9jckNsYWltcyh0cnVlKTsKICB9CgogIC8vIDUpIEhvw6BuIHThuqV0IGx1w7RuIOKAlCBraMO0bmcgY8OybiB0cuG6oW5nIHRow6FpICLEkWFuZyB4w6FjIMSR4buLbmggdHJhbmcuLi4iIHbDtCBo4bqhbi4KICAkKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPSIxMDAlIjsKICBpZihzdGF0ZS5jbGFpbXMubGVuZ3RoKXsKICAgIHNldERldGVjdCgiZGV0Q2xhaW1zIix0cnVlLGDEkMOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW1gKTsKICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PWBIb8OgbiB04bqldC4gxJDDoyBuaOG6rW4gZGnhu4duICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW0uIEtp4buDbSB0cmEgdGjDtG5nIHRpbiBy4buTaSBi4bqlbSDigJxUaeG6v3AgdOG7pWPigJ0uYDsKICB9ZWxzZXsKICAgIHNldERldGVjdCgiZGV0Q2xhaW1zIixmYWxzZSwiQ2jGsGEgdOG7sSB0w6FjaCDEkcaw4bujYyBjbGFpbSIpOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9IsSQw6MgeOG7rSBsw70geG9uZyBQREYuIE7hur91IGNsYWltIGNoxrBhIMSRxrDhu6NjIHTDoWNoLCBi4bqlbSDigJxUaeG6v3AgdOG7pWPigJ0gxJHhu4MgeGVtL3Bhc3RlIG7hu5lpIGR1bmcgT0NSIHRo4bunIGPDtG5nLiI7CiAgfQp9CiQoInBkZklucHV0Iikub25jaGFuZ2U9ZT0+e2lmKGUudGFyZ2V0LmZpbGVzWzBdKXByb2Nlc3NGaWxlKGUudGFyZ2V0LmZpbGVzWzBdKX07CmNvbnN0IGR6PSQoImRyb3Bab25lIik7WyJkcmFnZW50ZXIiLCJkcmFnb3ZlciJdLmZvckVhY2goZXY9PmR6LmFkZEV2ZW50TGlzdGVuZXIoZXYsZT0+e2UucHJldmVudERlZmF1bHQoKTtkei5jbGFzc0xpc3QuYWRkKCJkcmFnIil9KSk7WyJkcmFnbGVhdmUiLCJkcm9wIl0uZm9yRWFjaChldj0+ZHouYWRkRXZlbnRMaXN0ZW5lcihldixlPT57ZS5wcmV2ZW50RGVmYXVsdCgpO2R6LmNsYXNzTGlzdC5yZW1vdmUoImRyYWciKX0pKTtkei5hZGRFdmVudExpc3RlbmVyKCJkcm9wIixlPT57bGV0IGY9ZS5kYXRhVHJhbnNmZXIuZmlsZXNbMF07aWYoZilwcm9jZXNzRmlsZShmKX0pOwokKCJyZXRyeU9DUiIpLm9uY2xpY2s9YXN5bmMoKT0+e2lmKCFzdGF0ZS5wZGYpcmV0dXJuIGFsZXJ0KCJDaMawYSBjw7MgUERGLiIpO2F3YWl0IHNtYXJ0T2NyQ2xhaW1zKGZhbHNlKX07CiQoIm9jckNsYWltc0FnYWluIikub25jbGljaz1hc3luYygpPT57aWYoIXN0YXRlLnBkZilyZXR1cm4gYWxlcnQoIkNoxrBhIGPDsyBQREYuIik7YXdhaXQgc21hcnRPY3JDbGFpbXMoZmFsc2UpfTsKCmZ1bmN0aW9uIHJlbmRlckNsYWltcygpewogJCgiY2xhaW1TZWxlY3QiKS5pbm5lckhUTUw9c3RhdGUuY2xhaW1zLm1hcCgoYyxpKT0+YDxvcHRpb24gdmFsdWU9IiR7aX0iPkNsYWltICR7Yy5pZH0gwrcgJHtjLnR5cGV9PC9vcHRpb24+YCkuam9pbigiIik7CiBpZighc3RhdGUuY2xhaW1zLmxlbmd0aCl7CiAgICQoImNsYWltTGlzdCIpLmNsYXNzTmFtZT0iZW1wdHkiOwogICAkKCJjbGFpbUxpc3QiKS5pbm5lckhUTUw9IkNoxrBhIGPDsyBjbGFpbS4iOwogICByZXR1cm47CiB9CiAkKCJjbGFpbUxpc3QiKS5jbGFzc05hbWU9IiI7CiAkKCJjbGFpbUxpc3QiKS5pbm5lckhUTUw9c3RhdGUuY2xhaW1zLm1hcCgoYyxpKT0+ewogICBjb25zdCBwcmV0dHk9ZXNjKGZvcm1hdENsYWltRm9yRGlzcGxheShjLnRleHQpKS5yZXBsYWNlKC9cbi9nLCI8YnI+Iik7CiAgIHJldHVybiBgPGRpdiBjbGFzcz0iY2xhaW0iPgogICAgICA8aDQ+Q2xhaW0gJHtjLmlkfSA8c3BhbiBjbGFzcz0icGlsbCAke2MudHlwZT09PSLEkOG7mWMgbOG6rXAiPyJibHVlIjoiIn0iPiR7Yy50eXBlfTwvc3Bhbj48L2g0PgogICAgICA8ZGl2IGNsYXNzPSJjbGFpbS1jbGVhbiI+JHtwcmV0dHl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biAke2k9PT1zdGF0ZS5zZWxlY3RlZD8ic3VjY2VzcyI6IiJ9IiBkYXRhLWNsYWltPSIke2l9Ij4ke2k9PT1zdGF0ZS5zZWxlY3RlZD8ixJBhbmcgY2jhu41uIjoiQ2jhu41uIGNsYWltIG7DoHkifTwvYnV0dG9uPjwvZGl2PgogICA8L2Rpdj5gOwogfSkuam9pbigiIik7CiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1jbGFpbV0iKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+ewogICBzdGF0ZS5zZWxlY3RlZD0rYi5kYXRhc2V0LmNsYWltOwogICAkKCJjbGFpbVNlbGVjdCIpLnZhbHVlPXN0YXRlLnNlbGVjdGVkOwogICByZW5kZXJDbGFpbXMoKTsKIH0pOwp9CiQoInBhcnNlQ2xhaW1zIikub25jbGljaz0oKT0+ewogICAgICBjb25zdCBzb3VyY2U9JCgiY2xhaW1zQ2xlYW4iKS52YWx1ZXx8JCgiY2xhaW1zUmF3IikudmFsdWU7CiAgICAgIHN0YXRlLmNsYWltc1RleHQ9bm9ybWFsaXplT2NyVGV4dChzb3VyY2UpOwogICAgICAkKCJjbGFpbXNDbGVhbiIpLnZhbHVlPWZvcm1hdENsYWltRm9yRGlzcGxheShzdGF0ZS5jbGFpbXNUZXh0KTsKICAgICAgJCgiY2xhaW1zUmF3IikudmFsdWU9c3RhdGUuY2xhaW1zVGV4dDsKICAgICAgc3RhdGUuY2xhaW1zPXBhcnNlQ2xhaW1zKHN0YXRlLmNsYWltc1RleHQpOwogICAgICBzdGF0ZS5zZWxlY3RlZD0wOwogICAgICByZW5kZXJDbGFpbXMoKTsKICAgICAgc2V0RGV0ZWN0KCJkZXRDbGFpbXMiLHN0YXRlLmNsYWltcy5sZW5ndGg+MCxzdGF0ZS5jbGFpbXMubGVuZ3RoP2DEkMOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW1gOiJDaMawYSB0w6xtIHRo4bqleSBjbGFpbSIpOwogICAgfTsKCmZ1bmN0aW9uIGZlYXR1cmVTcGxpdCh0ZXh0KXsKICBsZXQgdD1ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKQogICAgLnJlcGxhY2UoL15ccyooPzphfGFufHRoZSk/XHMqKD86cXV5IHRyw6xuaHxwaMawxqFuZyBwaMOhcHxtZXRob2R8cHJvY2Vzc3xjb21wb3NpdGlvbnxkZXZpY2V8c3lzdGVtKVteOl17MCwyMjB9KD86YmFvIGfhu5NtfGNvbXByaXNpbmd8Y29tcHJpc2VzKVxzKjo/XHMqL2ksIiIpOwoKICBjb25zdCBjb25uZWN0b3JzPS9cYig/OnNhdSDEkcOzfHRp4bq/cCB0aGVvfGvhur8gdGnhur9wfHRyb25nIMSRw7N8xJHhu5NuZyB0aOG7nWl8dGjhu7FjIGhp4buHbnzEkcaw4bujYyB0aOG7sWMgaGnhu4dufHdoZXJlaW58dGhlbnxzdWJzZXF1ZW50bHkpXGIvaWc7CiAgbGV0IHNlZz1bXTsKICBjb25zdCByb21hbj1bLi4udC5tYXRjaEFsbCgvXCgoaXsxLDN9fGl2fHZ8dml7MCwzfXxpeHx4fHhpezAsM318eGl2fHh2fHh2aXswLDN9KVwpXHMqL2lnKV07CgogIGlmKHJvbWFuLmxlbmd0aD49Mil7CiAgICBmb3IobGV0IGk9MDtpPHJvbWFuLmxlbmd0aDtpKyspewogICAgICBjb25zdCBhPXJvbWFuW2ldLmluZGV4K3JvbWFuW2ldWzBdLmxlbmd0aDsKICAgICAgY29uc3QgYj1pKzE8cm9tYW4ubGVuZ3RoP3JvbWFuW2krMV0uaW5kZXg6dC5sZW5ndGg7CiAgICAgIGNvbnN0IHM9Y2xlYW4odC5zbGljZShhLGIpKS5yZXBsYWNlKC9bOyxdKyQvLCIiKTsKICAgICAgaWYocy5sZW5ndGg+MTgpIHNlZy5wdXNoKHMpOwogICAgfQogIH1lbHNlewogICAgc2VnPXQKICAgICAgLnJlcGxhY2UoY29ubmVjdG9ycywiOyAiKQogICAgICAuc3BsaXQoLztccyt8XG4oPz1ccyooPzpcZCtbXC5cKV18XC18XOKAoikpLykKICAgICAgLm1hcChjbGVhbikKICAgICAgLmZpbHRlcih4PT54Lmxlbmd0aD4xOCk7CiAgfQoKICAvLyBH4buZcCBjw6FjIG3huqNuaCBxdcOhIG5n4bqvbiDEkeG7gyB0csOhbmggZmVhdHVyZSBraeG7g3UgIjUzLDIlIHRpbmgiLgogIGNvbnN0IG1lcmdlZD1bXTsKICBmb3IoY29uc3QgcyBvZiBzZWcpewogICAgaWYobWVyZ2VkLmxlbmd0aCAmJiAocy5zcGxpdCgvXHMrLykubGVuZ3RoPDQgfHwgcy5sZW5ndGg8MjgpKXsKICAgICAgbWVyZ2VkW21lcmdlZC5sZW5ndGgtMV0rPSI7ICIrczsKICAgIH1lbHNlIG1lcmdlZC5wdXNoKHMpOwogIH0KCiAgcmV0dXJuIG1lcmdlZC5zbGljZSgwLDMwKS5tYXAoKHgsaSk9PnsKICAgIGNvbnN0IGY9Zm9sZFZOKHgpOwogICAgbGV0IHR5cGU9IlF1eSB0csOsbmgiOwogICAgaWYoL1xiKEVOWllNRXxCT1R8VEhBTkggUEhBTnxUWSBMRXxOR1VZRU4gTElFVXxFWFRSQUNUfE9JTHxDT01QT1NJVElPTnxBQ0lEfFBPTFlNRVJ8SE9QIENIQVQpXGIvLnRlc3QoZikpIHR5cGU9IlRow6BuaCBwaOG6p24vTmd1ecOqbiBsaeG7h3UiOwogICAgZWxzZSBpZigvXGIoS0lFTSBUUkF8WEFDIERJTkh8RE8gTFVPTkd8Q0hFQ0t8REVURVJNSU58TUVBU1VSRXxQSHxETyBBTXxOSElFVCBETylcYi8udGVzdChmKSkgdHlwZT0iS2nhu4NtIHNvw6F0IjsKICAgIGVsc2UgaWYoL1xiKENIQU1CRVJ8UFVNUHxUVUJFfEFQUEFSQVRVU3xERVZJQ0V8U1lTVEVNfFRISUVUIEJJfEJPIFBIQU58Q0FVIFRSVUMpXGIvLnRlc3QoZikpIHR5cGU9IlRoaeG6v3QgYuG7iy9D4bqldSB0csO6YyI7CiAgICBjb25zdCB3b3Jkcz14LnNwbGl0KC9ccysvKS5sZW5ndGg7CiAgICBjb25zdCBjb25mPXdvcmRzPj03JiZ3b3Jkczw9NDA/IkNhbyI6d29yZHM+PTQ/IlRydW5nIGLDrG5oIjoiVGjhuqVwIjsKICAgIHJldHVybiB7aWQ6YEYke1N0cmluZyhpKzEpLnBhZFN0YXJ0KDIsIjAiKX1gLHRleHQ6eCx0eXBlLGNvbmZ9OwogIH0pOwp9Cgpjb25zdCBTRUFSQ0hfU1RPUD1uZXcgU2V0KFsKICAidmEiLCJob2FjIiwiY3VhIiwiY2hvIiwidm9pIiwidHJvbmciLCJuZ29haSIsInRyZW4iLCJkdW9pIiwidHUiLCJkZW4iLCJ0YWkiLCJ0aGVvIiwic2F1IiwidHJ1b2MiLCJkbyIsIm5heSIsIm1vdCIsImNhYyIsIm5odW5nIiwKICAiZHVvYyIsInRodWMiLCJoaWVuIiwidGFvIiwiaG9uIiwiaG9wIiwiZHVuZyIsImRpY2giLCJwaG9pIiwidHJvbiIsInRodSIsInR1Iiwib24iLCJkaW5oIiwiZG9uZyIsInRob2kiLCJ0aWVwIiwiYmFvIiwiZ29tIiwiYnVvYyIsCiAgInF1eSIsInRyaW5oIiwicGh1b25nIiwicGhhcCIsInNhbiIsInBoYW0iLCJoZSIsInRob25nIiwidGhpZXQiLCJiaSIsIm5oYXQiLCJiYW5nIiwiY2FjaCIsInN1IiwiZHVuZyIsIm5oYW0iLCJkZSIsImtoaSIsIm5ldSIsImNvIiwKICAidGhlIiwibGEiLCJsYW0iLCJwaGFuIiwidmFvIiwicmEiLCJnaXVhIiwibW90IiwiaGFpIiwiYmEiLCJib24iLCJuYW0iLCJzYXUiLCJiYXkiLCJ0YW0iLCJjaGluIiwidHVvbmciLCJ1bmciLCJsYW4iLCJxdWEiLCJkb2kiLCJ2b2kiLAogICJ0aGUiLCJhbmQiLCJvciIsIndpdGgiLCJmcm9tIiwid2hlcmVpbiIsIm1ldGhvZCIsInByb2Nlc3MiLCJjb21wcmlzaW5nIiwiY29tcHJpc2VzIiwiaW5jbHVkaW5nIiwic3RlcCIsInN0ZXBzIiwidXNpbmciLCJ1c2VkIiwidXNlIiwKICAiZmlyc3QiLCJzZWNvbmQiLCJ0aGlyZCIsInRoZW4iLCJ0aGVyZW9mIiwidGhlcmVpbiIsInRoZXJlYnkiLCJzdWNoIiwidGhhdCIsIndoaWNoIiwiaW50byIsIm9udG8iCl0pOwoKZnVuY3Rpb24gZmVhdHVyZUNvcmVUZXJtcyh0ZXh0KXsKICBjb25zdCBvcmlnaW5hbD1ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKTsKICBjb25zdCB0b2tlbnM9Wy4uLm9yaWdpbmFsLm1hdGNoQWxsKC9bXHB7TH1ccHtOfVwtXC9cLl0rL2d1KV0ubWFwKG09Pm1bMF0pOwogIGNvbnN0IG91dD1bXTsKICBmb3IoY29uc3QgdG9rIG9mIHRva2Vucyl7CiAgICBjb25zdCBmPWZvbGRWTih0b2spLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW15hLXowLTlcLVwvXC5dL2csIiIpOwogICAgaWYoIWYgfHwgU0VBUkNIX1NUT1AuaGFzKGYpIHx8IGYubGVuZ3RoPDQpIGNvbnRpbnVlOwogICAgaWYoL15cZCsoPzpbXC4sXVxkKyk/JT8kLy50ZXN0KGYpKSBjb250aW51ZTsKICAgIGlmKCFvdXQuc29tZSh4PT5mb2xkVk4oeCkudG9Mb3dlckNhc2UoKT09PWYpKSBvdXQucHVzaCh0b2spOwogIH0KICByZXR1cm4gb3V0LnNsaWNlKDAsOCk7Cn0KCmZ1bmN0aW9uIG1lYW5pbmdmdWxUb2tlbnModGV4dCl7CiAgcmV0dXJuIFsuLi5ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKS5tYXRjaEFsbCgvW1xwe0x9XHB7Tn1cLVwvXC5dKy9ndSldCiAgICAubWFwKG09Pm1bMF0pCiAgICAuZmlsdGVyKHRvaz0+ewogICAgICBjb25zdCBmPWZvbGRWTih0b2spLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW15hLXowLTlcLVwvXC5dL2csIiIpOwogICAgICByZXR1cm4gZi5sZW5ndGg+PTQgJiYgIVNFQVJDSF9TVE9QLmhhcyhmKSAmJiAhL15cZCsoPzpbXC4sXVxkKyk/JT8kLy50ZXN0KGYpOwogICAgfSk7Cn0KCmZ1bmN0aW9uIHRpdGxlVGVjaG5pY2FsUGhyYXNlKCl7CiAgbGV0IHQ9bm9ybWFsaXplT2NyVGV4dCgkKCJ0aXRsZSIpLnZhbHVlfHwiIikKICAgIC5yZXBsYWNlKC9eKD86cXV5IHRyw6xuaHxwaMawxqFuZyBwaMOhcHxo4buHIHRo4buRbmd8dGhp4bq/dCBi4buLfHPhuqNuIHBo4bqpbXxjaOG6vyBwaOG6qW0pXHMrKD86c+G6o24geHXhuqV0fGNo4bq/IHThuqFvfMSRaeG7gXUgY2jhur8pP1xzKi9pLCIiKTsKICBjb25zdCB0b2tzPW1lYW5pbmdmdWxUb2tlbnModCk7CiAgaWYodG9rcy5sZW5ndGg+PTIpIHJldHVybiB0b2tzLnNsaWNlKDAsNykuam9pbigiICIpOwogIHJldHVybiAiIjsKfQoKZnVuY3Rpb24gdGVjaG5pY2FsUGhyYXNlc0Zyb21UZXh0KHRleHQpewogIGNvbnN0IHJhdz1ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKTsKICBjb25zdCB0b2tzPW1lYW5pbmdmdWxUb2tlbnMocmF3KTsKICBjb25zdCBvdXQ9W107CgogIC8vIFByZWZlciBwaHJhc2VzIGV4cGxpY2l0bHkgcHJlc2VudCBpbiB0aGUgdGVjaG5pY2FsIGRpY3Rpb25hcnkuCiAgZm9yKGNvbnN0IFtrXSBvZiBPYmplY3QuZW50cmllcyhkaWN0KSl7CiAgICBpZihmb2xkVk4ocmF3KS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGZvbGRWTihrKS50b0xvd2VyQ2FzZSgpKSAmJiBrLnNwbGl0KC9ccysvKS5sZW5ndGg+PTIpewogICAgICBvdXQucHVzaChrKTsKICAgIH0KICB9CgogIC8vIEJ1aWxkIGNvbXBhY3QgMuKAkzMgd29yZCBwaHJhc2VzIGluc3RlYWQgb2YgaXNvbGF0ZWQgT0NSIHdvcmRzLgogIGZvcihsZXQgbj0zO24+PTI7bi0tKXsKICAgIGZvcihsZXQgaT0wO2krbjw9dG9rcy5sZW5ndGg7aSsrKXsKICAgICAgY29uc3QgcGhyYXNlPXRva3Muc2xpY2UoaSxpK24pLmpvaW4oIiAiKTsKICAgICAgY29uc3QgZj1mb2xkVk4ocGhyYXNlKS50b0xvd2VyQ2FzZSgpOwogICAgICBpZighb3V0LnNvbWUoeD0+Zm9sZFZOKHgpLnRvTG93ZXJDYXNlKCk9PT1mKSkgb3V0LnB1c2gocGhyYXNlKTsKICAgICAgaWYob3V0Lmxlbmd0aD49OCkgYnJlYWs7CiAgICB9CiAgICBpZihvdXQubGVuZ3RoPj04KSBicmVhazsKICB9CiAgcmV0dXJuIG91dC5zbGljZSgwLDgpOwp9CgpmdW5jdGlvbiBxdWVyeVF1YWxpdHkocSl7CiAgY29uc3Qgd29yZHM9bWVhbmluZ2Z1bFRva2VucyhTdHJpbmcocSkucmVwbGFjZSgvXGJBTkRcYnxcYk9SXGIvZ2ksIiAiKSk7CiAgY29uc3QgdW5pcT1bLi4ubmV3IFNldCh3b3Jkcy5tYXAoeD0+Zm9sZFZOKHgpLnRvTG93ZXJDYXNlKCkpKV07CiAgcmV0dXJuIHsKICAgIG9rOiB1bmlxLmxlbmd0aD49MiwKICAgIHRlcm1zOiB1bmlxLAogICAgc2NvcmU6IE1hdGgubWluKDEwMCx1bmlxLmxlbmd0aCoyMikKICB9Owp9CgoKZnVuY3Rpb24gYnVpbGRQcm9TZWFyY2hSb3dzKCl7CiAgcmV0dXJuIHN0YXRlLmZlYXR1cmVzLm1hcChmPT57CiAgICBjb25zdCBwaHJhc2VzPXRlY2huaWNhbFBocmFzZXNGcm9tVGV4dChmLnRleHQpOwogICAgY29uc3QgdGVybXM9ZmVhdHVyZUNvcmVUZXJtcyhmLnRleHQpOwogICAgY29uc3QgZm91bmQ9W107CiAgICBmb3IoY29uc3QgW2ssdl0gb2YgT2JqZWN0LmVudHJpZXMoZGljdCkpewogICAgICBpZihmb2xkVk4oZi50ZXh0KS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGZvbGRWTihrKS50b0xvd2VyQ2FzZSgpKSkgZm91bmQucHVzaChrLC4uLnYpOwogICAgfQogICAgY29uc3QgYWxsPVsuLi5waHJhc2VzLC4uLmZvdW5kLC4uLnRlcm1zXS5maWx0ZXIoKHgsaSxhKT0+eCYmYS5maW5kSW5kZXgoeT0+Zm9sZFZOKHkpPT09Zm9sZFZOKHgpKT09PWkpOwogICAgY29uc3QgcHJpbWFyeT1hbGxbMF18fCIiOwogICAgY29uc3Qgc3lub255bXM9YWxsLnNsaWNlKDEsNSk7CiAgICByZXR1cm4gW2YuaWQscHJpbWFyeSxzeW5vbnltcy5qb2luKCI7ICIpfHwi4oCUIiwkKCJpcGMiKS52YWx1ZXx8IkPhuqduIGNodXnDqm4gZ2lhIHjDoWMgxJHhu4tuaCJdOwogIH0pLmZpbHRlcihyPT5yWzFdKTsKfQoKZnVuY3Rpb24gYnVpbGRQcm9RdWVyaWVzKHJvd3MpewogIGNvbnN0IHBocmFzZXM9W107CiAgY29uc3QgdGl0bGVQaHJhc2U9dGl0bGVUZWNobmljYWxQaHJhc2UoKTsKICBpZih0aXRsZVBocmFzZSkgcGhyYXNlcy5wdXNoKHRpdGxlUGhyYXNlKTsKCiAgZm9yKGNvbnN0IHIgb2Ygcm93cyl7CiAgICBjb25zdCB2YWxzPVtyWzFdLC4uLihyWzJdPT09IuKAlCI/W106clsyXS5zcGxpdCgiOyIpLm1hcCh4PT54LnRyaW0oKSkpXTsKICAgIGZvcihjb25zdCB2IG9mIHZhbHMpewogICAgICBpZighdikgY29udGludWU7CiAgICAgIGNvbnN0IHE9cXVlcnlRdWFsaXR5KHYpOwogICAgICBpZihxLm9rICYmICFwaHJhc2VzLnNvbWUoeD0+Zm9sZFZOKHgpPT09Zm9sZFZOKHYpKSkgcGhyYXNlcy5wdXNoKHYpOwogICAgfQogIH0KCiAgY29uc3QgcXVlcmllcz1bXTsKICBjb25zdCBhZGQ9cT0+ewogICAgcT0ocXx8IiIpLnRyaW0oKTsKICAgIGlmKCFxIHx8ICFxdWVyeVF1YWxpdHkocSkub2spIHJldHVybjsKICAgIGlmKCFxdWVyaWVzLnNvbWUoeD0+Zm9sZFZOKHgpPT09Zm9sZFZOKHEpKSkgcXVlcmllcy5wdXNoKHEpOwogIH07CgogIC8vIEhpZ2hlc3QgcHJlY2lzaW9uOiB0aXRsZSBjb25jZXB0ICsgb25lIGZlYXR1cmUgY29uY2VwdC4KICBpZih0aXRsZVBocmFzZSAmJiBwaHJhc2VzWzFdKSBhZGQoYCIke3RpdGxlUGhyYXNlfSIgQU5EICIke3BocmFzZXNbMV19ImApOwogIGlmKHRpdGxlUGhyYXNlKSBhZGQoYCIke3RpdGxlUGhyYXNlfSJgKTsKCiAgLy8gQnJvYWRlciByZWNhbGwgcXVlcmllcy4KICBpZihwaHJhc2VzLmxlbmd0aD49MikgYWRkKHBocmFzZXMuc2xpY2UoMCwyKS5tYXAoeD0+YCIke3h9ImApLmpvaW4oIiBBTkQgIikpOwogIGlmKHBocmFzZXMubGVuZ3RoPj0zKSBhZGQocGhyYXNlcy5zbGljZSgxLDMpLm1hcCh4PT5gIiR7eH0iYCkuam9pbigiIEFORCAiKSk7CgogIC8vIExhc3QgZmFsbGJhY2s6IDMtNiBzaWduaWZpY2FudCB0ZWNobmljYWwgdG9rZW5zIGZyb20gdGl0bGUgKyBzZWxlY3RlZCBjbGFpbS4KICBjb25zdCBjPXN0YXRlLmNsYWltc1tzdGF0ZS5zZWxlY3RlZF18fHN0YXRlLmNsYWltc1swXTsKICBjb25zdCB0b2tlblBvb2w9Wy4uLm1lYW5pbmdmdWxUb2tlbnMoJCgidGl0bGUiKS52YWx1ZXx8IiIpLC4uLm1lYW5pbmdmdWxUb2tlbnMoYz9jLnRleHQ6IiIpXTsKICBjb25zdCB1bmlxPVtdOwogIGZvcihjb25zdCB4IG9mIHRva2VuUG9vbCl7CiAgICBjb25zdCBmPWZvbGRWTih4KS50b0xvd2VyQ2FzZSgpOwogICAgaWYoIXVuaXEuc29tZSh5PT5mb2xkVk4oeSkudG9Mb3dlckNhc2UoKT09PWYpKSB1bmlxLnB1c2goeCk7CiAgfQogIGlmKHVuaXEubGVuZ3RoPj0yKSBhZGQodW5pcS5zbGljZSgwLDYpLmpvaW4oIiAiKSk7CgogIHJldHVybiBxdWVyaWVzLnNsaWNlKDAsNik7Cn0KJCgiYXV0b0ZlYXR1cmVzIikub25jbGljaz0oKT0+e2xldCBjPXN0YXRlLmNsYWltc1srJCgiY2xhaW1TZWxlY3QiKS52YWx1ZXx8MF07aWYoIWMpcmV0dXJuIGFsZXJ0KCJDaMawYSBjw7MgY2xhaW0uIik7c3RhdGUuc2VsZWN0ZWQ9KyQoImNsYWltU2VsZWN0IikudmFsdWV8fDA7c3RhdGUuZmVhdHVyZXM9ZmVhdHVyZVNwbGl0KGMudGV4dCk7cmVuZGVyRmVhdHVyZXMoKTskKCJmZWF0dXJlU3RhdHVzIikudmFsdWU9IkLhuqNuIG5ow6FwIHThu7EgxJHhu5luZyI7c3RhdGUuY29uZmlybWVkPWZhbHNlO3VwZGF0ZUZlYXR1cmVSZXZpZXdVSSgpfTsKJCgiY29uZmlybUZlYXR1cmVzIikub25jbGljaz0oKT0+e2lmKCFzdGF0ZS5mZWF0dXJlcy5sZW5ndGgpcmV0dXJuIGFsZXJ0KCJDaMawYSBjw7MgZOG6pXUgaGnhu4d1LiIpO3N0YXRlLmNvbmZpcm1lZD10cnVlO3VwZGF0ZUZlYXR1cmVSZXZpZXdVSSgpO2FsZXJ0KCLEkMOjIHjDoWMgbmjhuq1uIGLhu5kgZOG6pXUgaGnhu4d1LiBC4bqhbiBjw7MgdGjhu4MgdGnhur9wIHThu6VjIHNhbmcgYsaw4bubYyB0cmEgY+G7qXUuIil9OwoKZnVuY3Rpb24gdXBkYXRlRmVhdHVyZVJldmlld1VJKCl7CiAgY29uc3Qgbj1zdGF0ZS5mZWF0dXJlcy5sZW5ndGg7CiAgY29uc3QgYmFyPSQoImZlYXR1cmVSZXZpZXdCYXIiKTsKICBjb25zdCBiYWRnZT0kKCJmZWF0dXJlU3RhdHVzQmFkZ2UiKTsKICBjb25zdCBsYWJlbD0kKCJmZWF0dXJlQ291bnRMYWJlbCIpOwogIGlmKCFiYXJ8fCFiYWRnZXx8IWxhYmVsKSByZXR1cm47CiAgbGFiZWwudGV4dENvbnRlbnQ9bj9gJHtufSBk4bqldSBoaeG7h3Uga+G7uSB0aHXhuq10YDoiQ2jGsGEgY8OzIGThuqV1IGhp4buHdSI7CiAgaWYoc3RhdGUuY29uZmlybWVkKXsKICAgIGJhci5jbGFzc0xpc3QuYWRkKCJmZWF0dXJlLWNvbmZpcm1lZCIpOwogICAgYmFkZ2UuY2xhc3NOYW1lPSJwaWxsIGdyZWVuIjsKICAgIGJhZGdlLnRleHRDb250ZW50PSLEkMOjIHjDoWMgbmjhuq1uIjsKICAgICQoImZlYXR1cmVTdGF0dXMiKS52YWx1ZT0ixJDDoyB4w6FjIG5o4bqtbiI7CiAgICAkKCJjb25maXJtRmVhdHVyZXMiKS50ZXh0Q29udGVudD0i4pyTIMSQw6MgeMOhYyBuaOG6rW4gYuG7mSBk4bqldSBoaeG7h3UiOwogIH1lbHNlewogICAgYmFyLmNsYXNzTGlzdC5yZW1vdmUoImZlYXR1cmUtY29uZmlybWVkIik7CiAgICBiYWRnZS5jbGFzc05hbWU9InBpbGwgeWVsbG93IjsKICAgIGJhZGdlLnRleHRDb250ZW50PSJDaMawYSB4w6FjIG5o4bqtbiI7CiAgICAkKCJmZWF0dXJlU3RhdHVzIikudmFsdWU9bj8iQuG6o24gbmjDoXAgdOG7sSDEkeG7mW5nIjoiQ2jGsGEgdOG6oW8iOwogICAgJCgiY29uZmlybUZlYXR1cmVzIikudGV4dENvbnRlbnQ9IuKckyBYw6FjIG5o4bqtbiBi4buZIGThuqV1IGhp4buHdSI7CiAgfQp9CmZ1bmN0aW9uIHJlbmRlckZlYXR1cmVzKCl7CiAkKCJmZWF0dXJlQm9keSIpLmlubmVySFRNTD1zdGF0ZS5mZWF0dXJlcy5tYXAoKGYsaSk9PmA8dHI+PHRkPjxzdHJvbmc+JHtmLmlkfTwvc3Ryb25nPjwvdGQ+PHRkPjx0ZXh0YXJlYSBkYXRhLWZ0PSIke2l9IiBzdHlsZT0ibWluLWhlaWdodDo3MnB4Ij4ke2VzYyhmLnRleHQpfTwvdGV4dGFyZWE+PC90ZD48dGQ+PHNlbGVjdCBkYXRhLXR5PSIke2l9Ij48b3B0aW9uICR7Zi50eXBlPT09IlF1eSB0csOsbmgiPyJzZWxlY3RlZCI6IiJ9PlF1eSB0csOsbmg8L29wdGlvbj48b3B0aW9uICR7Zi50eXBlPT09IlRow6BuaCBwaOG6p24vTmd1ecOqbiBsaeG7h3UiPyJzZWxlY3RlZCI6IiJ9PlRow6BuaCBwaOG6p24vTmd1ecOqbiBsaeG7h3U8L29wdGlvbj48b3B0aW9uICR7Zi50eXBlPT09Iktp4buDbSBzb8OhdCI/InNlbGVjdGVkIjoiIn0+S2nhu4NtIHNvw6F0PC9vcHRpb24+PG9wdGlvbiAke2YudHlwZT09PSJUaGnhur90IGLhu4svQ+G6pXUgdHLDumMiPyJzZWxlY3RlZCI6IiJ9PlRoaeG6v3QgYuG7iy9D4bqldSB0csO6Yzwvb3B0aW9uPjwvc2VsZWN0PjwvdGQ+PHRkPjxzcGFuIGNsYXNzPSJwaWxsIHllbGxvdyI+JHtmLmNvbmZ9PC9zcGFuPjwvdGQ+PHRkPjxidXR0b24gY2xhc3M9ImJ0biBkYW5nZXIiIGRhdGEtZGVsPSIke2l9Ij7DlzwvYnV0dG9uPjwvdGQ+PC90cj5gKS5qb2luKCIiKTsKIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWZ0XSIpLmZvckVhY2goeD0+eC5vbmNoYW5nZT0oKT0+c3RhdGUuZmVhdHVyZXNbK3guZGF0YXNldC5mdF0udGV4dD14LnZhbHVlKTtkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS10eV0iKS5mb3JFYWNoKHg9Pngub25jaGFuZ2U9KCk9PnN0YXRlLmZlYXR1cmVzWyt4LmRhdGFzZXQudHldLnR5cGU9eC52YWx1ZSk7ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtZGVsXSIpLmZvckVhY2goeD0+eC5vbmNsaWNrPSgpPT57c3RhdGUuZmVhdHVyZXMuc3BsaWNlKCt4LmRhdGFzZXQuZGVsLDEpO3N0YXRlLmNvbmZpcm1lZD1mYWxzZTtyZW5kZXJGZWF0dXJlcygpfSk7dXBkYXRlRmVhdHVyZVJldmlld1VJKCkKfQoKY29uc3QgZGljdD17ImjhuqF0IHRoYW5oIGxvbmciOlsiZHJhZ29uIGZydWl0IHNlZWQiLCJwaXRheWEgc2VlZCIsIkh5bG9jZXJldXMgc2VlZCJdLCJu4bqjeSBt4bqnbSI6WyJnZXJtaW5hdGlvbiIsImdlcm1pbmF0ZWQiLCJzcHJvdXRpbmciXSwiY2VsbHVsYXNlIjpbImNlbGx1bGFzZSIsImNlbGx1bGFzZSB0cmVhdG1lbnQiXSwicGVjdGluYXNlIjpbInBlY3RpbmFzZSIsInBlY3RpbmFzZSB0cmVhdG1lbnQiXSwic+G6pXkiOlsiZHJ5aW5nIiwiZGVoeWRyYXRpb24iXSwibmdoaeG7gW4iOlsiZ3JpbmRpbmciLCJtaWxsaW5nIl0sImLhu5l0IG5ow6B1IjpbIm5vbmkgcG93ZGVyIiwiTW9yaW5kYSBjaXRyaWZvbGlhIHBvd2RlciJdLCLEkeG7mSDhuqltIjpbIm1vaXN0dXJlIGNvbnRlbnQiLCJtb2lzdHVyZSBhZGp1c3RtZW50Il0sIsSRw7NuZyBnw7NpIjpbInBhY2thZ2luZyIsInBhY2tpbmciXSwiZnJlZXplIGRyeWluZyI6WyJseW9waGlsaXphdGlvbiIsImZyZWV6ZSBkcnllciJdLCJtb3NxdWl0byI6WyJtb3NxdWl0byByZXBlbGxlbnQiLCJpbnNlY3QgcmVwZWxsZW50Il0sImVzc2VudGlhbCBvaWwiOlsiZXh0cmFjdCIsImFyb21hdGljIG9pbCJdfTsKJCgiZ2VuU2VhcmNoIikub25jbGljaz0oKT0+ewogIHN0YXRlLnNlYXJjaD1idWlsZFByb1NlYXJjaFJvd3MoKTsKICBzdGF0ZS5xdWVyaWVzPWJ1aWxkUHJvUXVlcmllcyhzdGF0ZS5zZWFyY2gpOwogIHJlbmRlclNlYXJjaCgpOwp9OwpmdW5jdGlvbiByZW5kZXJTZWFyY2goKXskKCJzZWFyY2hCb2R5IikuaW5uZXJIVE1MPXN0YXRlLnNlYXJjaC5tYXAocj0+YDx0cj48dGQ+PHN0cm9uZz4ke3JbMF19PC9zdHJvbmc+PC90ZD48dGQ+JHtlc2MoclsxXSl9PC90ZD48dGQ+JHtlc2MoclsyXSl9PC90ZD48dGQ+JHtlc2MoclszXSl9PC90ZD48L3RyPmApLmpvaW4oIiIpOyQoInF1ZXJ5TGlzdCIpLmlubmVySFRNTD1zdGF0ZS5xdWVyaWVzLm1hcCgocSxpKT0+YDxkaXYgY2xhc3M9ImNhbGxvdXQiPjxzdHJvbmc+USR7aSsxfTwvc3Ryb25nPjxici8+PGNvZGU+JHtlc2MocSl9PC9jb2RlPjwvZGl2PmApLmpvaW4oIiIpfQoKCmZ1bmN0aW9uIGJhY2tlbmRCYXNlKCl7CiAgcmV0dXJuIGxvY2F0aW9uLm9yaWdpbjsKfQpmdW5jdGlvbiBzYXZlQmFja2VuZCgpewogIHN0YXRlLmJhY2tlbmRVcmw9bG9jYXRpb24ub3JpZ2luOwp9CmZ1bmN0aW9uIHVwZGF0ZU9mZmljaWFsU2VhcmNoTGlua3MocSl7CiAgY29uc3QgcXVlcnk9cXx8JCgibGl2ZVNlYXJjaFF1ZXJ5IikudmFsdWV8fHN0YXRlLnF1ZXJpZXNbMF18fCIiOwogICQoImdwTGluayIpLmhyZWY9Imh0dHBzOi8vcGF0ZW50cy5nb29nbGUuY29tLz9xPSIrZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KTsKICAkKCJ3aXBvTGluayIpLmhyZWY9Imh0dHBzOi8vcGF0ZW50c2NvcGUud2lwby5pbnQvc2VhcmNoL2VuL2FkdmFuY2VkU2VhcmNoLmpzZj9xdWVyeT0iK2VuY29kZVVSSUNvbXBvbmVudCgnRU5fQUxMVFhUOignK3F1ZXJ5KycpJyk7CiAgJCgiZXBvTGluayIpLmhyZWY9Imh0dHBzOi8vd29ybGR3aWRlLmVzcGFjZW5ldC5jb20vcGF0ZW50L3NlYXJjaD9xPSIrZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KTsKfQpmdW5jdGlvbiB1c2VHZW5lcmF0ZWRRdWVyeSgpewogIGxldCBxPSIiOwogIGlmKHN0YXRlLnF1ZXJpZXMubGVuZ3RoKXsKICAgIHE9c3RhdGUucXVlcmllc1swXTsKICB9ZWxzZSBpZihzdGF0ZS5mZWF0dXJlcy5sZW5ndGgpewogICAgY29uc3Qgcm93cz1idWlsZFByb1NlYXJjaFJvd3MoKTsKICAgIGNvbnN0IHFzPWJ1aWxkUHJvUXVlcmllcyhyb3dzKTsKICAgIHE9cXNbMF18fCIiOwogIH1lbHNlewogICAgcT0kKCJ0aXRsZSIpLnZhbHVlfHwiIjsKICB9CiAgJCgibGl2ZVNlYXJjaFF1ZXJ5IikudmFsdWU9cTsKICB1cGRhdGVPZmZpY2lhbFNlYXJjaExpbmtzKHEpOwogIHJldHVybiBxOwp9CmZ1bmN0aW9uIGNsZWFuUGF0ZW50SHRtbChzKXsKICBjb25zdCBkPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoInRleHRhcmVhIik7CiAgZC5pbm5lckhUTUw9KHN8fCIiKS5yZXBsYWNlKC88W14+XSo+L2csIiAiKTsKICByZXR1cm4gZC52YWx1ZS5yZXBsYWNlKC9ccysvZywiICIpLnRyaW0oKTsKfQpmdW5jdGlvbiB0YXJnZXREYXRlT2JqKCl7CiAgY29uc3Qgdj0kKCJmaWxpbmdEYXRlIikudmFsdWU7CiAgcmV0dXJuIHY/bmV3IERhdGUodisiVDAwOjAwOjAwIik6bnVsbDsKfQpmdW5jdGlvbiBjYW5kaWRhdGVEYXRlU3RhdHVzKGMpewogIGNvbnN0IHRkPXRhcmdldERhdGVPYmooKTsKICBjb25zdCBkPWMucHVibGljYXRpb25fZGF0ZXx8Yy5wcmlvcml0eV9kYXRlfHxjLmZpbGluZ19kYXRlfHwiIjsKICBpZighdGR8fCFkKSByZXR1cm4ge2xhYmVsOiJD4bqnbiB4w6FjIG1pbmgiLGNsczoieWVsbG93IixlbGlnaWJsZTpudWxsfTsKICBjb25zdCBjZD1uZXcgRGF0ZShkKTsKICBpZihpc05hTihjZCkpIHJldHVybiB7bGFiZWw6IkPhuqduIHjDoWMgbWluaCIsY2xzOiJ5ZWxsb3ciLGVsaWdpYmxlOm51bGx9OwogIGNvbnN0IG9rPWNkPHRkOwogIHJldHVybiB7bGFiZWw6b2s/IlRyxrDhu5tjIG3hu5FjIHRhcmdldCI6IlNhdSBt4buRYyB0YXJnZXQiLGNsczpvaz8iZ3JlZW4iOiJyZWQiLGVsaWdpYmxlOm9rfTsKfQpmdW5jdGlvbiBmZWF0dXJlVGVybXMoKXsKICBjb25zdCBzdG9wPW5ldyBTZXQoWyJiYW8iLCJn4buTbSIsInRyb25nIiwiY+G7p2EiLCLEkcaw4bujYyIsInbDoCIsInRoZSIsIndpdGgiLCJmcm9tIiwid2hlcmVpbiIsIm1ldGhvZCIsInByb2Nlc3MiXSk7CiAgY29uc3QgdGVybXM9W107CiAgZm9yKGNvbnN0IGYgb2Ygc3RhdGUuZmVhdHVyZXMpewogICAgZm9yKGNvbnN0IHcgb2YgZm9sZFZOKGYudGV4dCkudG9Mb3dlckNhc2UoKS5zcGxpdCgvW15hLXowLTldKy8pKXsKICAgICAgaWYody5sZW5ndGg+PTQmJiFzdG9wLmhhcyh3KSkgdGVybXMucHVzaCh3KTsKICAgIH0KICB9CiAgcmV0dXJuIFsuLi5uZXcgU2V0KHRlcm1zKV0uc2xpY2UoMCw4MCk7Cn0KZnVuY3Rpb24gc2NvcmVDYW5kaWRhdGUoYyl7CiAgY29uc3QgYmxvYj1mb2xkVk4oW2MudGl0bGUsYy5zbmlwcGV0LGMuYXNzaWduZWVdLmZpbHRlcihCb29sZWFuKS5qb2luKCIgIikpLnRvTG93ZXJDYXNlKCk7CiAgY29uc3QgdGVybXM9ZmVhdHVyZVRlcm1zKCk7CiAgaWYoIXRlcm1zLmxlbmd0aCkgcmV0dXJuIDUwOwogIGxldCBoaXQ9MDsKICBmb3IoY29uc3QgdCBvZiB0ZXJtcykgaWYoYmxvYi5pbmNsdWRlcyh0KSkgaGl0Kys7CiAgbGV0IHNjb3JlPU1hdGgucm91bmQoKGhpdC9NYXRoLm1pbih0ZXJtcy5sZW5ndGgsMjApKSoxMDApOwogIGNvbnN0IGRzPWNhbmRpZGF0ZURhdGVTdGF0dXMoYyk7CiAgaWYoZHMuZWxpZ2libGU9PT1mYWxzZSkgc2NvcmU9TWF0aC5tYXgoMCxzY29yZS0zNSk7CiAgcmV0dXJuIE1hdGgubWluKDk5LHNjb3JlKTsKfQpmdW5jdGlvbiByZW5kZXJDYW5kaWRhdGVzKCl7CiAgaWYoIXN0YXRlLmNhbmRpZGF0ZXMubGVuZ3RoKXsKICAgICQoImNhbmRpZGF0ZUJvZHkiKS5pbm5lckhUTUw9Jzx0cj48dGQgY29sc3Bhbj0iNiIgc3R5bGU9ImNvbG9yOiM5OGEyYjM7dGV4dC1hbGlnbjpjZW50ZXIiPktow7RuZyBjw7Mga+G6v3QgcXXhuqMgxJHhu4MgaGnhu4NuIHRo4buLLjwvdGQ+PC90cj4nOwogICAgcmV0dXJuOwogIH0KICAkKCJjYW5kaWRhdGVCb2R5IikuaW5uZXJIVE1MPXN0YXRlLmNhbmRpZGF0ZXMubWFwKChjLGkpPT57CiAgICBjLnNjb3JlPXNjb3JlQ2FuZGlkYXRlKGMpOwogICAgY29uc3QgZHM9Y2FuZGlkYXRlRGF0ZVN0YXR1cyhjKTsKICAgIGNvbnN0IHNjb3JlQ2xzPWMuc2NvcmU+PTY1PyJoaWdoIjpjLnNjb3JlPj0zNT8ibWlkIjoibG93IjsKICAgIGNvbnN0IGRhdGU9Yy5wdWJsaWNhdGlvbl9kYXRlfHxjLnByaW9yaXR5X2RhdGV8fGMuZmlsaW5nX2RhdGV8fCLigJQiOwogICAgcmV0dXJuIGA8dHI+CiAgICAgIDx0ZD4ke2krMX08L3RkPgogICAgICA8dGQgc3R5bGU9Im1pbi13aWR0aDozMzBweCI+CiAgICAgICAgPGEgY2xhc3M9InNlYXJjaC1yZXN1bHQtdGl0bGUiIGhyZWY9IiR7ZXNjKGMudXJsKX0iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj4ke2VzYyhjLnB1YmxpY2F0aW9uX251bWJlcnx8IlBhdGVudCIpfSDCtyAke2VzYyhjLnRpdGxlfHwiS2jDtG5nIGPDsyB0acOqdSDEkeG7gSIpfTwvYT4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0dXMiIHN0eWxlPSJtYXJnaW4tdG9wOjVweCI+JHtlc2MoYy5zbmlwcGV0fHwiIil9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ic291cmNlLXJvdyIgc3R5bGU9Im1hcmdpbi10b3A6N3B4Ij4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaHJlZj0iJHtlc2MoYy51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkdvb2dsZSBQYXRlbnRzIOKGlzwvYT4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaHJlZj0iaHR0cHM6Ly9wYXRlbnRzY29wZS53aXBvLmludC9zZWFyY2gvZW4vYWR2YW5jZWRTZWFyY2guanNmP3F1ZXJ5PSR7ZW5jb2RlVVJJQ29tcG9uZW50KCdBTExOVU06KCcrYy5wdWJsaWNhdGlvbl9udW1iZXIrJyknKX0iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj5XSVBPIOKGlzwvYT4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaHJlZj0iaHR0cHM6Ly93b3JsZHdpZGUuZXNwYWNlbmV0LmNvbS9wYXRlbnQvc2VhcmNoP3E9JHtlbmNvZGVVUklDb21wb25lbnQoJ3BuPScrYy5wdWJsaWNhdGlvbl9udW1iZXIpfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkVzcGFjZW5ldCDihpc8L2E+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvdGQ+CiAgICAgIDx0ZD4ke2VzYyhkYXRlKX08L3RkPgogICAgICA8dGQ+PHNwYW4gY2xhc3M9InNjb3JlICR7c2NvcmVDbHN9Ij4ke2Muc2NvcmV9JTwvc3Bhbj48L3RkPgogICAgICA8dGQ+PHNwYW4gY2xhc3M9InBpbGwgJHtkcy5jbHN9Ij4ke2RzLmxhYmVsfTwvc3Bhbj48L3RkPgogICAgICA8dGQ+PGRpdiBjbGFzcz0iY2FuZGlkYXRlLWFjdGlvbnMiPgogICAgICAgIDxidXR0b24gY2xhc3M9InNsb3RidG4iIGRhdGEtc2xvdD0iRDEiIGRhdGEtY2FuZGlkYXRlPSIke2l9Ij5EMTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9InNsb3RidG4iIGRhdGEtc2xvdD0iRDIiIGRhdGEtY2FuZGlkYXRlPSIke2l9Ij5EMjwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9InNsb3RidG4iIGRhdGEtc2xvdD0iRDMiIGRhdGEtY2FuZGlkYXRlPSIke2l9Ij5EMzwvYnV0dG9uPgogICAgICA8L2Rpdj48L3RkPgogICAgPC90cj5gOwogIH0pLmpvaW4oIiIpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWNhbmRpZGF0ZV0iKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+c2VsZWN0Q2FuZGlkYXRlVG9TbG90KCtiLmRhdGFzZXQuY2FuZGlkYXRlLGIuZGF0YXNldC5zbG90KSk7Cn0KYXN5bmMgZnVuY3Rpb24gc2VhcmNoUmVhbFBhdGVudHMoKXsKICBsZXQgcT0kKCJsaXZlU2VhcmNoUXVlcnkiKS52YWx1ZS50cmltKCl8fHVzZUdlbmVyYXRlZFF1ZXJ5KCk7CiAgaWYoIXF1ZXJ5UXVhbGl0eShxKS5vayl7CiAgICBjb25zdCByb3dzPWJ1aWxkUHJvU2VhcmNoUm93cygpOwogICAgY29uc3QgcXM9YnVpbGRQcm9RdWVyaWVzKHJvd3MpOwogICAgcT1xc1swXXx8dGl0bGVUZWNobmljYWxQaHJhc2UoKTsKICAgICQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlPXE7CiAgfQogIGlmKCFxdWVyeVF1YWxpdHkocSkub2spewogICAgJCgibGl2ZVNlYXJjaFN0YXRlIikuaW5uZXJIVE1MPSc8c3BhbiBjbGFzcz0iYmFja2VuZC1iYWQiPlRydXkgduG6pW4gaGnhu4duIHThuqFpIHF1w6EgY2h1bmcgaG/hurdjIGLhu4sgbOG7l2kgT0NSLjwvc3Bhbj4gSMOjeSBxdWF5IGzhuqFpIGtp4buDbSB0cmEgQ2xhaW0vROG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdCBob+G6t2Mgbmjhuq1wIMOtdCBuaOG6pXQgMiB0aHXhuq10IG5n4buvIGvhu7kgdGh14bqtdC4nOwogICAgcmV0dXJuOwogIH0KICB1cGRhdGVPZmZpY2lhbFNlYXJjaExpbmtzKHEpOwogIGlmKCFxKSByZXR1cm4gYWxlcnQoIkNoxrBhIGPDsyB0cnV5IHbhuqVuIHRyYSBj4bupdS4iKTsKICBjb25zdCBiYXNlPWJhY2tlbmRCYXNlKCk7CiAgc2F2ZUJhY2tlbmQoKTsKICAkKCJsaXZlU2VhcmNoU3RhdGUiKS50ZXh0Q29udGVudD0ixJBhbmcgdHJhIGPhu6l1IHBhdGVudCB0aOG6rXQgcXVhIGLhu5kgbcOheSB0w6xtIGtp4bq/bS4uLiI7CiAgJCgibGl2ZVNlYXJjaEJ0biIpLmRpc2FibGVkPXRydWU7CiAgdHJ5ewogICAgY29uc3QgdXJsPWJhc2UrIi9hcGkvc2VhcmNoP3E9IitlbmNvZGVVUklDb21wb25lbnQocSkrIiZ0aXRsZT0iK2VuY29kZVVSSUNvbXBvbmVudCgkKCJ0aXRsZSIpLnZhbHVlfHwiIikrIiZudW09MjAiOwogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCh1cmwpOwogICAgY29uc3QgZGF0YT1hd2FpdCByLmpzb24oKTsKICAgIGlmKCFyLm9rfHwhZGF0YS5vaykgdGhyb3cgbmV3IEVycm9yKGRhdGEuZXJyb3J8fCgiSFRUUCAiK3Iuc3RhdHVzKSk7CiAgICBpZihkYXRhLnF1ZXJ5X3VzZWQpeyQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlPWRhdGEucXVlcnlfdXNlZDt1cGRhdGVPZmZpY2lhbFNlYXJjaExpbmtzKGRhdGEucXVlcnlfdXNlZCl9CiAgICBzdGF0ZS5jYW5kaWRhdGVzPShkYXRhLnJlc3VsdHN8fFtdKS5tYXAoeD0+KHsuLi54LHNjb3JlOjB9KSk7CiAgICBzdGF0ZS5jYW5kaWRhdGVzLnNvcnQoKGEsYik9PnNjb3JlQ2FuZGlkYXRlKGIpLXNjb3JlQ2FuZGlkYXRlKGEpKTsKICAgIHJlbmRlckNhbmRpZGF0ZXMoKTsKICAgICQoImxpdmVTZWFyY2hTdGF0ZSIpLmlubmVySFRNTD1gxJDDoyBuaOG6rW4gPHN0cm9uZz4ke3N0YXRlLmNhbmRpZGF0ZXMubGVuZ3RofTwvc3Ryb25nPiBr4bq/dCBxdeG6oyB04burIDxzdHJvbmc+JHtlc2MoZGF0YS5wcm92aWRlcnx8ZGF0YS5zb3VyY2V8fCJuZ3Xhu5NuIHBhdGVudCIpfTwvc3Ryb25nPi4gVHJ1eSB24bqlbiB0aOG7sWMgZMO5bmc6IDxzdHJvbmc+JHtlc2MoZGF0YS5xdWVyeV91c2VkfHxxKX08L3N0cm9uZz4ke2RhdGEuYXR0ZW1wdF9jb3VudD9gIMK3IMSRw6MgdGjhu60gJHtkYXRhLmF0dGVtcHRfY291bnR9IG3hu6ljIHRydXkgduG6pW5gOiIifS5gOwogIH1jYXRjaChlKXsKICAgIGNvbnNvbGUuZXJyb3IoZSk7CiAgICBjb25zdCBtc2c9U3RyaW5nKGUubWVzc2FnZXx8ZSk7CiAgICBjb25zdCBoaW50PS81MDN8UkFURV9MSU1JVHxHT09HTEVfQkxPQ0tFRC9pLnRlc3QobXNnKQogICAgICA/ICI8YnI+PHN0cm9uZz5Hb29nbGUgUGF0ZW50cyDEkWFuZyBjaOG6t24gdHJ1eSB24bqlbiB04buxIMSR4buZbmcgdOG7qyBJUCBkYXRhY2VudGVyLjwvc3Ryb25nPiBI4buHIHRo4buRbmcgc+G6vSDGsHUgdGnDqm4gQnJvd3NlciBSdW4vU2VycEFwaSBu4bq/dSDEkcaw4bujYyBj4bqldSBow6xuaDsgR29vZ2xlIGRpcmVjdCBjaOG7iSBsw6AgZmFsbGJhY2s7IGPDoWMgbGluayBHb29nbGUvV0lQTy9FUE8gcGjDrWEgdHLDqm4gduG6q24gbMOgIG5ndeG7k24ga2nhu4NtIGNo4bupbmcuIgogICAgICA6ICIiOwogICAgJCgibGl2ZVNlYXJjaFN0YXRlIikuaW5uZXJIVE1MPWA8c3BhbiBjbGFzcz0iYmFja2VuZC1iYWQiPlRyYSBj4bupdSB04buxIMSR4buZbmcgY2jGsGEgdGjDoG5oIGPDtG5nOiAke2VzYyhtc2cpfTwvc3Bhbj4ke2hpbnR9PGJyPkLhuqFuIHbhuqtuIGPDsyB0aOG7gyBt4bufIHRy4buxYyB0aeG6v3AgY8OhYyBuZ3Xhu5NuIGNow61uaCB0aOG7qWMgcGjDrWEgdHLDqm4uYDsKICB9ZmluYWxseXsKICAgICQoImxpdmVTZWFyY2hCdG4iKS5kaXNhYmxlZD1mYWxzZTsKICB9Cn0KYXN5bmMgZnVuY3Rpb24gc2VsZWN0Q2FuZGlkYXRlVG9TbG90KGksc2xvdCl7CiAgY29uc3QgYz1zdGF0ZS5jYW5kaWRhdGVzW2ldOwogIGlmKCFjKSByZXR1cm47CiAgY29uc3Qgbj1zbG90LnNsaWNlKDEpOwogIGNvbnN0IGJhc2U9YmFja2VuZEJhc2UoKTsKICAkKGBkJHtufU5vYCkudmFsdWU9Yy5wdWJsaWNhdGlvbl9udW1iZXJ8fCIiOwogICQoYGQke259RGF0ZWApLnZhbHVlPShjLnB1YmxpY2F0aW9uX2RhdGV8fGMucHJpb3JpdHlfZGF0ZXx8Yy5maWxpbmdfZGF0ZXx8IiIpLnNsaWNlKDAsMTApOwogICQoYGQke259VXJsYCkudmFsdWU9Yy51cmx8fCIiOwogICQoYGQke259VGV4dGApLnZhbHVlPVtjLnRpdGxlLGMuc25pcHBldF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oIlxuXG4iKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIucHJpb3Itc2xvdCIpLmZvckVhY2goeD0+eC5jbGFzc0xpc3QucmVtb3ZlKCJzZWxlY3RlZCIpKTsKICAkKCJzbG90IitzbG90KS5jbGFzc0xpc3QuYWRkKCJzZWxlY3RlZCIpOwoKICBpZihiYXNlJiZjLnB1YmxpY2F0aW9uX251bWJlcil7CiAgICB0cnl7CiAgICAgICQoYGQke259VGV4dGApLnZhbHVlPSLEkGFuZyBs4bqleSBu4buZaSBkdW5nIHBhdGVudC4uLiI7CiAgICAgIGNvbnN0IHI9YXdhaXQgZmV0Y2goYmFzZSsiL2FwaS9kZXRhaWw/cHViPSIrZW5jb2RlVVJJQ29tcG9uZW50KGMucHVibGljYXRpb25fbnVtYmVyKSk7CiAgICAgIGNvbnN0IGQ9YXdhaXQgci5qc29uKCk7CiAgICAgIGlmKHIub2smJmQub2spewogICAgICAgIGNvbnN0IHBhcnRzPVtdOwogICAgICAgIGlmKGQudGl0bGUpIHBhcnRzLnB1c2goIlRJVExFXG4iK2QudGl0bGUpOwogICAgICAgIGlmKGQuYWJzdHJhY3QpIHBhcnRzLnB1c2goIkFCU1RSQUNUXG4iK2QuYWJzdHJhY3QpOwogICAgICAgIGlmKGQuY2xhaW1zKSBwYXJ0cy5wdXNoKCJDTEFJTVNcbiIrZC5jbGFpbXMuc2xpY2UoMCwxODAwMCkpOwogICAgICAgICQoYGQke259VGV4dGApLnZhbHVlPXBhcnRzLmpvaW4oIlxuXG4iKXx8W2MudGl0bGUsYy5zbmlwcGV0XS5qb2luKCJcblxuIik7CiAgICAgIH1lbHNlewogICAgICAgICQoYGQke259VGV4dGApLnZhbHVlPVtjLnRpdGxlLGMuc25pcHBldF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oIlxuXG4iKTsKICAgICAgfQogICAgfWNhdGNoKF9lKXsKICAgICAgJChgZCR7bn1UZXh0YCkudmFsdWU9W2MudGl0bGUsYy5zbmlwcGV0XS5maWx0ZXIoQm9vbGVhbikuam9pbigiXG5cbiIpOwogICAgfQogIH0KICByZWFkUHJpb3IoKTsKfQpmdW5jdGlvbiBhdXRvUGlja0QxMjMoKXsKICBpZighc3RhdGUuY2FuZGlkYXRlcy5sZW5ndGgpIHJldHVybiBhbGVydCgiQ2jGsGEgY8OzIGvhur90IHF14bqjIHRyYSBj4bupdS4iKTsKICBjb25zdCBzb3J0ZWQ9Wy4uLnN0YXRlLmNhbmRpZGF0ZXNdLnNvcnQoKGEsYik9PnsKICAgIGNvbnN0IGRhPWNhbmRpZGF0ZURhdGVTdGF0dXMoYSksZGI9Y2FuZGlkYXRlRGF0ZVN0YXR1cyhiKTsKICAgIGNvbnN0IHBhPWRhLmVsaWdpYmxlPT09ZmFsc2U/MTowLHBiPWRiLmVsaWdpYmxlPT09ZmFsc2U/MTowOwogICAgcmV0dXJuIHBhLXBiIHx8IHNjb3JlQ2FuZGlkYXRlKGIpLXNjb3JlQ2FuZGlkYXRlKGEpOwogIH0pOwogIGNvbnN0IHBpY2tlZD1zb3J0ZWQuc2xpY2UoMCwzKTsKICBwaWNrZWQuZm9yRWFjaCgoYyxpZHgpPT57CiAgICBjb25zdCBvcmlnaW5hbD1zdGF0ZS5jYW5kaWRhdGVzLmluZGV4T2YoYyk7CiAgICBzZWxlY3RDYW5kaWRhdGVUb1Nsb3Qob3JpZ2luYWwsIkQiKyhpZHgrMSkpOwogIH0pOwp9CiQoImxpdmVTZWFyY2hCdG4iKS5vbmNsaWNrPXNlYXJjaFJlYWxQYXRlbnRzOwokKCJ1c2VCZXN0UXVlcnkiKS5vbmNsaWNrPSgpPT57dXNlR2VuZXJhdGVkUXVlcnkoKTskKCJsaXZlU2VhcmNoU3RhdGUiKS50ZXh0Q29udGVudD0ixJDDoyBu4bqhcCB0cnV5IHbhuqVuIHThu6sgYsaw4bubYyBDaGnhur9uIGzGsOG7o2MgdHJhIGPhu6l1LiJ9OwokKCJhdXRvUGlja1ByaW9yIikub25jbGljaz1hdXRvUGlja0QxMjM7CiQoInRlc3RCYWNrZW5kIikub25jbGljaz1hc3luYygpPT57CiAgJCgiYmFja2VuZFN0YXR1cyIpLnRleHRDb250ZW50PSLEkGFuZyBraeG7g20gdHJhLi4uIjsKICB0cnl7CiAgICBjb25zdCByPWF3YWl0IGZldGNoKCIvYXBpL2hlYWx0aCIse2NhY2hlOiJuby1zdG9yZSJ9KTsKICAgIGNvbnN0IGQ9YXdhaXQgci5qc29uKCk7CiAgICBpZighci5va3x8IWQub2spIHRocm93IG5ldyBFcnJvcihkLmVycm9yfHwiS2jDtG5nIGvhur90IG7hu5FpIMSRxrDhu6NjIik7CiAgICBjb25zdCBwPWQucHJvdmlkZXJzfHx7fTsgY29uc3QgdmVyPWQudmVyc2lvbj9gIMK3IHYke2QudmVyc2lvbn1gOiIiOwogICAgc3RhdGUucHJvdmlkZXJzPXA7CiAgICBzdGF0ZS5jbG91ZE9jcj1wLmdvb2dsZV92aXNpb24/dHJ1ZTpudWxsOwogICAgY29uc3Qgc2VhcmNoT2s9cC5zZXJwYXBpfHxwLmJyb3dzZXJfcnVufHxwLmVwb19vcHM7CiAgICBjb25zdCBvY3JUZXh0PXAuZ29vZ2xlX3Zpc2lvbj8iIMK3IEdvb2dsZSBWaXNpb24gT0NSIHPhurVuIHPDoG5nIjoiIMK3IE9DUiBsb2NhbCBmYWxsYmFjayI7CiAgICAkKCJiYWNrZW5kU3RhdHVzIikuaW5uZXJIVE1MPXNlYXJjaE9rCiAgICAgID8gYDxzcGFuIGNsYXNzPSJiYWNrZW5kLW9rIj7inJMgQmFja2VuZCBob+G6oXQgxJHhu5luZy48L3NwYW4+JHtvY3JUZXh0fWAKICAgICAgOiBgPHNwYW4gY2xhc3M9ImJhY2tlbmQtb2siPuKckyBCYWNrZW5kIGhv4bqhdCDEkeG7mW5nLjwvc3Bhbj4gR29vZ2xlIGRpcmVjdCBjw7MgdGjhu4MgYuG7iyByYXRlLWxpbWl0JHtvY3JUZXh0fWA7CiAgfWNhdGNoKGUpewogICAgJCgiYmFja2VuZFN0YXR1cyIpLmlubmVySFRNTD1gPHNwYW4gY2xhc3M9ImJhY2tlbmQtYmFkIj7inJUgQmFja2VuZDogJHtlc2MoZS5tZXNzYWdlfHxlKX08L3NwYW4+YDsKICB9Cn07CmZ1bmN0aW9uIHJlYWRQcmlvcigpe3N0YXRlLnByaW9yPXtEMTp7bm86JCgiZDFObyIpLnZhbHVlLGRhdGU6JCgiZDFEYXRlIikudmFsdWUsdGV4dDokKCJkMVRleHQiKS52YWx1ZX0sRDI6e25vOiQoImQyTm8iKS52YWx1ZSxkYXRlOiQoImQyRGF0ZSIpLnZhbHVlLHRleHQ6JCgiZDJUZXh0IikudmFsdWV9LEQzOntubzokKCJkM05vIikudmFsdWUsZGF0ZTokKCJkM0RhdGUiKS52YWx1ZSx0ZXh0OiQoImQzVGV4dCIpLnZhbHVlfX19CiQoInZhbGlkYXRlUHJpb3IiKS5vbmNsaWNrPSgpPT57cmVhZFByaW9yKCk7bGV0IGZpbGluZz0kKCJmaWxpbmdEYXRlIikudmFsdWU/bmV3IERhdGUoJCgiZmlsaW5nRGF0ZSIpLnZhbHVlKTpudWxsLGh0bWw9IjxzdHJvbmc+S+G6v3QgcXXhuqMga2nhu4NtIHRyYSB0aOG7nWkgZ2lhbjwvc3Ryb25nPjxici8+Ijtmb3IoY29uc3Rbayx2XW9mIE9iamVjdC5lbnRyaWVzKHN0YXRlLnByaW9yKSl7aWYoIXYubm8pY29udGludWU7bGV0IG9rPXYuZGF0ZSYmZmlsaW5nJiZuZXcgRGF0ZSh2LmRhdGUpPGZpbGluZztodG1sKz1gJHtrfSDCtyAke2VzYyh2Lm5vKX0gwrcgJHtlc2Modi5kYXRlfHwiY2jGsGEgY8OzIG5nw6B5Iil9IOKAlCA8c3BhbiBjbGFzcz0icGlsbCAke29rPyJncmVlbiI6InllbGxvdyJ9Ij4ke29rPyJDw7MgdGjhu4MgcGjDuSBo4bujcCB24buBIHRo4budaSBnaWFuIjoiQ+G6p24ga2nhu4NtIHRyYSJ9PC9zcGFuPjxici8+YH0kKCJwcmlvckNoZWNrIikuaW5uZXJIVE1MPWh0bWx9OwoKJCgiYnVpbGRNYXRyaXgiKS5vbmNsaWNrPSgpPT57cmVhZFByaW9yKCk7aWYoIXN0YXRlLmZlYXR1cmVzLmxlbmd0aClyZXR1cm4gYWxlcnQoIkNoxrBhIGPDsyBmZWF0dXJlLiIpO3N0YXRlLm1hdHJpeD1zdGF0ZS5mZWF0dXJlcy5tYXAoZj0+e2xldCB2YWxzPVsiRDEiLCJEMiIsIkQzIl0ubWFwKGs9PntsZXQgZD0oc3RhdGUucHJpb3Jba10/LnRleHR8fCIiKS50b0xvd2VyQ2FzZSgpLHRva2Vucz1mLnRleHQudG9Mb3dlckNhc2UoKS5zcGxpdCgvXHMrLykuZmlsdGVyKHg9PngubGVuZ3RoPjUpLnNsaWNlKDAsOCksaGl0cz10b2tlbnMuZmlsdGVyKHQ9PmQuaW5jbHVkZXModCkpLmxlbmd0aDtyZXR1cm4gaGl0cz49ND8iTeG7mXQgcGjhuqduIjpoaXRzPj0xPyJDaMawYSBjaOG6r2MgY2jhuq9uIjoiS2jDtG5nIHTDrG0gdGjhuqV5In0pO3JldHVybltmLmlkLC4uLnZhbHMsIkLhuqNuIHTEqW5oIG3hu5tpIGTDuW5nIGhldXJpc3RpYzsgY+G6p24gQUkvYmFja2VuZCDEkeG7gyB0csOtY2ggZXZpZGVuY2UgdGhlbyBjbGFpbS/EkW/huqFuL2jDrG5oLiJdfSk7cmVuZGVyTWF0cml4KCl9OwpmdW5jdGlvbiBwaWxsKHYpe2xldCBjPXY9PT0iQ8OzIj8iZ3JlZW4iOnY9PT0iTeG7mXQgcGjhuqduIj8ieWVsbG93Ijp2PT09Iktow7RuZyB0w6xtIHRo4bqleSI/InJlZCI6IiI7cmV0dXJuYDxzcGFuIGNsYXNzPSJwaWxsICR7Y30iPiR7dn08L3NwYW4+YH0KZnVuY3Rpb24gcmVuZGVyTWF0cml4KCl7JCgibWF0cml4Qm9keSIpLmlubmVySFRNTD1zdGF0ZS5tYXRyaXgubWFwKHI9PmA8dHI+PHRkPjxzdHJvbmc+JHtyWzBdfTwvc3Ryb25nPjwvdGQ+PHRkPiR7cGlsbChyWzFdKX08L3RkPjx0ZD4ke3BpbGwoclsyXSl9PC90ZD48dGQ+JHtwaWxsKHJbM10pfTwvdGQ+PHRkPiR7ZXNjKHJbNF0pfTwvdGQ+PC90cj5gKS5qb2luKCIiKX0KCiQoInJ1bkFzc2Vzc21lbnQiKS5vbmNsaWNrPSgpPT57aWYoIXN0YXRlLm1hdHJpeC5sZW5ndGgpcmV0dXJuIGFsZXJ0KCJIw6N5IHThuqFvIG1hIHRy4bqtbiB0csaw4bubYy4iKTtsZXQgYWxsPVsxLDIsM10uZmlsdGVyKGM9PnN0YXRlLm1hdHJpeC5ldmVyeShyPT5yW2NdPT09IkPDsyIpKTtzdGF0ZS5hc3Nlc3NtZW50PXtub3ZlbHR5UmlzazphbGwubGVuZ3RoPyJS4bumSSBSTyBDQU8iOiJDSMavQSBQSMOBVCBISeG7hk4gTeG6pFQgVMONTkggTeG7mkkiLG5vdmVsdHlUZXh0OmFsbC5sZW5ndGg/YEPDsyAke2FsbC5tYXAoeD0+IkQiK3gpLmpvaW4oIiwgIil9IMSRxrDhu6NjIG1hcHBpbmcgYuG7mWMgbOG7mSB0b8OgbiBi4buZIGZlYXR1cmU7IGPhuqduIGtp4buDbSB0cmEgZXZpZGVuY2UuYDoiVHJvbmcgdOG6rXAgRDHigJNEMyBoaeG7h24gdOG6oWksIGNoxrBhIHjDoWMgxJHhu4tuaCBt4buZdCB0w6BpIGxp4buHdSDEkcahbiBs4bq7IGLhu5ljIGzhu5kgdG/DoG4gYuG7mSBk4bqldSBoaeG7h3UuIEvhur90IHF14bqjIGNo4buJIMOhcCBk4bulbmcgY2hvIHThuq1wIHTDoGkgbGnhu4d1IMSRYW5nIGto4bqjbyBzw6F0LiIsaW52ZW50aXZlUmlzazoiQ+G6pk4gQ0hVWcOKTiBHSUEiLGludmVudGl2ZVRleHQ6IkPhuqduIGNo4buNbiDEkeG7kWkgY2jhu6luZyBn4bqnbiBuaOG6pXQsIHjDoWMgxJHhu4tuaCBk4bqldSBoaeG7h3Uga2jDoWMgYmnhu4d0IHbDoCB24bqlbiDEkeG7gSBr4bu5IHRodeG6rXQga2jDoWNoIHF1YW4sIHNhdSDEkcOzIHhlbSB4w6l0IGxp4buHdSBwcmlvciBhcnQga2jDoWMgY8OzIGfhu6NpIMO9IGPDoWNoIGdp4bqjaSBxdXnhur90IGhheSBraMO0bmcuIn07cmVuZGVyQXNzZXNzbWVudCgpfTsKZnVuY3Rpb24gcmVuZGVyQXNzZXNzbWVudCgpeyQoIm5vdmVsdHlUZXh0IikudGV4dENvbnRlbnQ9c3RhdGUuYXNzZXNzbWVudC5ub3ZlbHR5VGV4dHx8IiI7JCgiaW52ZW50aXZlVGV4dCIpLnRleHRDb250ZW50PXN0YXRlLmFzc2Vzc21lbnQuaW52ZW50aXZlVGV4dHx8IiI7JCgibm92ZWx0eVJpc2siKS50ZXh0Q29udGVudD1zdGF0ZS5hc3Nlc3NtZW50Lm5vdmVsdHlSaXNrfHwiQ0jhu5wgROG7riBMSeG7hlUiOyQoImludmVudGl2ZVJpc2siKS50ZXh0Q29udGVudD1zdGF0ZS5hc3Nlc3NtZW50LmludmVudGl2ZVJpc2t8fCJDSOG7nCBE4buuIExJ4buGVSI7JCgibm92ZWx0eVJpc2siKS5jbGFzc05hbWU9InJpc2tib3ggIisoKHN0YXRlLmFzc2Vzc21lbnQubm92ZWx0eVJpc2t8fCIiKS5pbmNsdWRlcygiQ0FPIik/InJlZCI6ImdyZWVuIik7JCgiaW52ZW50aXZlUmlzayIpLmNsYXNzTmFtZT0icmlza2JveCB5ZWxsb3ciO3JlbmRlckV4cGVydCgpfQpmdW5jdGlvbiByZW5kZXJFeHBlcnQoKXtsZXQgcm93cz1bWyJE4bqldSBoaeG7h3Uga+G7uSB0aHXhuq10IixgJHtzdGF0ZS5mZWF0dXJlcy5sZW5ndGh9IGZlYXR1cmVgXSxbIkNoaeG6v24gbMaw4bujYyB0cmEgY+G7qXUiLGAke3N0YXRlLnF1ZXJpZXMubGVuZ3RofSBxdWVyeWBdLFsiUHJpb3IgYXJ0IixPYmplY3QudmFsdWVzKHN0YXRlLnByaW9yKS5maWx0ZXIoeD0+eCYmeC5ubykubWFwKHg9Pngubm8pLmpvaW4oIiwgIil8fCJDaMawYSBjw7MiXSxbIkLhuqNuZyDEkeG7kWkgY2hp4bq/dSIsYCR7c3RhdGUubWF0cml4Lmxlbmd0aH0gZmVhdHVyZWBdLFsiVMOtbmggbeG7m2kiLHN0YXRlLmFzc2Vzc21lbnQubm92ZWx0eVJpc2t8fCJDaMawYSDEkcOhbmggZ2nDoSJdLFsiVHLDrG5oIMSR4buZIHPDoW5nIHThuqFvIixzdGF0ZS5hc3Nlc3NtZW50LmludmVudGl2ZVJpc2t8fCJDaMawYSDEkcOhbmggZ2nDoSJdXTskKCJleHBlcnRCb2R5IikuaW5uZXJIVE1MPXJvd3MubWFwKChyLGkpPT5gPHRyPjx0ZD48c3Ryb25nPiR7clswXX08L3N0cm9uZz48L3RkPjx0ZD4ke2VzYyhyWzFdKX08L3RkPjx0ZD48c2VsZWN0IGRhdGEtcj0iJHtpfSI+PG9wdGlvbj5DaOG7nSByw6Agc2/DoXQ8L29wdGlvbj48b3B0aW9uPljDoWMgbmjhuq1uPC9vcHRpb24+PG9wdGlvbj5DaOG7iW5oIHPhu61hPC9vcHRpb24+PG9wdGlvbj5LaMO0bmcgxJHhu5NuZyDDvTwvb3B0aW9uPjwvc2VsZWN0PjwvdGQ+PHRkPjxpbnB1dCBwbGFjZWhvbGRlcj0iTmjhuq1uIHjDqXQgY2h1ecOqbiBnaWEiLz48L3RkPjwvdHI+YCkuam9pbigiIil9cmVuZGVyRXhwZXJ0KCk7CiQoInNhdmVSZXZpZXciKS5vbmNsaWNrPSgpPT57c3RhdGUucmV2aWV3cz1bLi4uZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtcl0iKV0uZmlsdGVyKHg9PngudmFsdWUhPT0iQ2jhu50gcsOgIHNvw6F0IikubGVuZ3RoO2FsZXJ0KCLEkMOjIGzGsHUgcsOgIHNvw6F0IHRyb25nIHBoacOqbiBoaeG7h24gdOG6oWkuIil9OwoKJCgiZ2VuUmVwb3J0Iikub25jbGljaz0oKT0+e3JlYWRQcmlvcigpO2xldCBjPXN0YXRlLmNsYWltc1tzdGF0ZS5zZWxlY3RlZF18fHN0YXRlLmNsYWltc1swXTskKCJyZXBvcnRDb250ZW50IikuaW5uZXJIVE1MPWAKPGgzPjEuIFRow7RuZyB0aW4gc8OhbmcgY2jhur88L2gzPjxkaXYgY2xhc3M9InN1bW1hcnkiPjxkaXY+TcOjIGNhc2U8L2Rpdj48ZGl2PiR7ZXNjKCQoImNhc2VJZCIpLnZhbHVlKX08L2Rpdj48ZGl2PlPhu5EgYuG6sW5nL2PDtG5nIGLhu5E8L2Rpdj48ZGl2PiR7ZXNjKCQoInBhdGVudE5vIikudmFsdWUpfTwvZGl2PjxkaXY+VMOqbiBzw6FuZyBjaOG6vzwvZGl2PjxkaXY+JHtlc2MoJCgidGl0bGUiKS52YWx1ZSl9PC9kaXY+PGRpdj5OZ8OgeSBu4buZcC/GsHUgdGnDqm48L2Rpdj48ZGl2PiR7ZXNjKCQoImZpbGluZ0RhdGUiKS52YWx1ZSl9PC9kaXY+PGRpdj5JUEMvQ1BDPC9kaXY+PGRpdj4ke2VzYygkKCJpcGMiKS52YWx1ZSl9PC9kaXY+PC9kaXY+CjxoMz4yLiBDbGFpbSDEkcaw4bujYyBwaMOibiB0w61jaDwvaDM+PHA+JHtlc2MoYz8udGV4dHx8IkNoxrBhIGNo4buNbiIpfTwvcD4KPGgzPjMuIEThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQ8L2gzPjxvbD4ke3N0YXRlLmZlYXR1cmVzLm1hcChmPT5gPGxpPjxzdHJvbmc+JHtmLmlkfTwvc3Ryb25nPiDigJQgJHtlc2MoZi50ZXh0KX08L2xpPmApLmpvaW4oIiIpfHwiPGxpPkNoxrBhIGPDszwvbGk+In08L29sPgo8aDM+NC4gQ2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdTwvaDM+PHVsPiR7c3RhdGUucXVlcmllcy5tYXAocT0+YDxsaT48Y29kZT4ke2VzYyhxKX08L2NvZGU+PC9saT5gKS5qb2luKCIiKXx8IjxsaT5DaMawYSB04bqhbzwvbGk+In08L3VsPgo8aDM+NS4gxJDDoW5oIGdpw6Egc8ahIGLhu5kgdMOtbmggbeG7m2k8L2gzPjxwPjxzdHJvbmc+JHtlc2Moc3RhdGUuYXNzZXNzbWVudC5ub3ZlbHR5Umlza3x8IkNoxrBhIMSRw6FuaCBnacOhIil9PC9zdHJvbmc+PC9wPjxwPiR7ZXNjKHN0YXRlLmFzc2Vzc21lbnQubm92ZWx0eVRleHR8fCIiKX08L3A+CjxoMz42LiBQaMOibiB0w61jaCBzxqEgYuG7mSB0csOsbmggxJHhu5kgc8OhbmcgdOG6oW88L2gzPjxwPjxzdHJvbmc+JHtlc2Moc3RhdGUuYXNzZXNzbWVudC5pbnZlbnRpdmVSaXNrfHwiQ2jGsGEgxJHDoW5oIGdpw6EiKX08L3N0cm9uZz48L3A+PHA+JHtlc2Moc3RhdGUuYXNzZXNzbWVudC5pbnZlbnRpdmVUZXh0fHwiIil9PC9wPjxwPjxzdHJvbmc+xJDhu5FpIGNo4bupbmcgZ+G6p24gbmjhuqV0Ojwvc3Ryb25nPiAke2VzYygkKCJjbG9zZXN0IikudmFsdWUpfTwvcD48cD48c3Ryb25nPkThuqV1IGhp4buHdSBraMOhYyBiaeG7h3Q6PC9zdHJvbmc+ICR7ZXNjKCQoImRpZmZlcmVuY2VzIikudmFsdWUpfTwvcD48cD48c3Ryb25nPlbhuqVuIMSR4buBIGvhu7kgdGh14bqtdCBraMOhY2ggcXVhbjo8L3N0cm9uZz4gJHtlc2MoJCgicHJvYmxlbSIpLnZhbHVlKX08L3A+PHA+PHN0cm9uZz5M4bqtcCBsdeG6rW46PC9zdHJvbmc+ICR7ZXNjKCQoInJlYXNvbmluZyIpLnZhbHVlKX08L3A+CjxoMz43LiBFeHBlcnQgcmV2aWV3PC9oMz48cD5T4buRIGjhuqFuZyBt4bulYyDEkcOjIMSRxrDhu6NjIHLDoCBzb8OhdDogPHN0cm9uZz4ke3N0YXRlLnJldmlld3N9PC9zdHJvbmc+LjwvcD4KPGRpdiBjbGFzcz0iY2FsbG91dCI+PHN0cm9uZz5MxrB1IMO9Ojwvc3Ryb25nPiDEkMOieSBsw6AgYsOhbyBjw6FvIHBow6JuIHTDrWNoIHPGoSBi4buZIHBo4bulYyB24bulIG5naGnDqm4gY+G7qXUsIGtow7RuZyBwaOG6o2kgw70ga2nhur9uIHBow6FwIGzDvSBjdeG7kWkgY8O5bmcuPC9kaXY+YH07Cgpjb25zdCBkZW1vPWAoMTIpIELhuqJOIE3DlCBU4bqiIFPDgU5HIENI4bq+IFRIVeG7mEMgQuG6sE5HIMSQ4buYQyBRVVnhu4BOIFPDgU5HIENI4bq+CigxMSkgMS0wMDQyMTgwCig1MSkgQTYxSyAzNi8zMzsgQTYxSyAzNi83NDY7IEEyM0wgMTkvMDA7IEEyM0wgMzMvMTAKKDIyKSAzMC8wNi8yMDIxCig3MykgQ8OUTkcgVFkgVE5ISCBOxq/hu5pDIMOJUCBQSMOaQyBIw4AgKFZOKQooNzQpIEPDtG5nIHR5IFROSEggVMawIHbhuqVuIGPDtG5nIG5naOG7hyB2w6AgU+G7nyBo4buvdSB0csOtIHR14buHIElQIEdST1VQCig1NCkgUVVZIFRSw4xOSCBT4bqiTiBYVeG6pFQgQuG7mFQgRElOSCBExq/hu6BORyBU4buqIEjhuqBUIFRIQU5IIExPTkcgTuG6olkgTeG6pk0KKDU3KSBTw6FuZyBjaOG6vyDEkeG7gSBj4bqtcCDEkeG6v24gYuG7mXQgZGluaCBkxrDhu6FuZyB04burIGjhuqF0IHRoYW5oIGxvbmcgbuG6o3kgbeG6p20gdGh1IMSRxrDhu6NjIHThu6sgbeG7mXQgcXV5IHRyw6xuaCBz4bqjbiB4deG6pXQuClnDilUgQ+G6plUgQuG6ok8gSOG7mAoxLiBRdXkgdHLDrG5oIHPhuqNuIHh14bqldCBi4buZdCBkaW5oIGTGsOG7oW5nIHThu6sgaOG6oXQgdGhhbmggbG9uZyBu4bqjeSBt4bqnbSBiYW8gZ+G7k206IChpKSBjaHXhuqluIGLhu4sgbmd1ecOqbiBsaeG7h3UgaOG6oXQgdGhhbmggbG9uZzsgKGlpKSB44butIGzDvSBi4bqxbmcgY2jhur8gcGjhuqltIGVuenltZSBjZWxsdWxhc2UgdsOgIHBlY3RpbmFzZTsgKGlpaSkgbmfDom0gdsOgIOG7pyDEkeG7gyBo4bqhdCBu4bqjeSBt4bqnbTsgKGl2KSBz4bqleTsgKHYpIG5naGnhu4FuOyAodmkpIGtp4buDbSB0cmEgxJHhu5NuZyBuaOG6pXQ7ICh2aWkpIHRow6ptIGLhu5l0IG5ow6B1OyAodmlpaSkgdGjDqm0gYuG7mXQgdGhhbmggbG9uZzsgKGl4KSB0aMOqbSB0aMOgbmggcGjhuqduIHBo4bulOyAoeCkga2nhu4NtIHRyYSDEkeG7k25nIG5o4bqldDsgKHhpKSBuZ2hp4buBbiB2w6AgxJFp4buBdSBjaOG7iW5oIMSR4buZIOG6qW07ICh4aWkpIMSRw7NuZyBnw7NpLgoyLiBRdXkgdHLDrG5oIHRoZW8gxJFp4buDbSAxLCB0cm9uZyDEkcOzIHRow6BuaCBwaOG6p24gcGjhu6UgYmFvIGfhu5NtIGNo4bqldCBi4bqjbyBxdeG6o24gdsOgIGNo4bqldCBjaOG7kW5nIHbDs24uCjMuIFF1eSB0csOsbmggdGhlbyDEkWnhu4NtIDEsIHRyb25nIMSRw7MgdGjDoG5oIHBo4bqnbiBjaOG6pXQgdOG6oW8gbmfhu410IHThu7Egbmhpw6puIGJhbyBn4buTbSBuaMOzbSBnbHVjaXQuYDsKJCgibG9hZERlbW8iKS5vbmNsaWNrPSgpPT57c3RhdGUucmF3VGV4dD1kZW1vO2xldCBtPWV4dHJhY3RNZXRhZGF0YShkZW1vKTtmaWxsTWV0YShtKTtsZXQgY3Q9Y2xlYW4oZGVtby5zbGljZShkZW1vLnNlYXJjaCgvWcOKVSBD4bqmVSBC4bqiTyBI4buYL2kpKyJZw4pVIEPhuqZVIELhuqJPIEjhu5giLmxlbmd0aCkpO3N0YXRlLmNsYWltc1RleHQ9Y3Q7JCgiY2xhaW1zUmF3IikudmFsdWU9Y3Q7JCgiY2xhaW1zQ2xlYW4iKS52YWx1ZT1mb3JtYXRDbGFpbUZvckRpc3BsYXkoY3QpO3N0YXRlLmNsYWltcz1wYXJzZUNsYWltcyhjdCk7cmVuZGVyQ2xhaW1zKCk7c2V0RGV0ZWN0KCJkZXRDbGFpbXMiLHRydWUsYMSQw6MgdMOhY2ggJHtzdGF0ZS5jbGFpbXMubGVuZ3RofSBjbGFpbWApOyQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjEwMCUiOyQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PSLEkMOjIG7huqFwIGRlbW8gUEgtVk4tMDEuIn07Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4=";
let APP_HTML_CACHE = null;

function appHtml() {
  if (APP_HTML_CACHE) return APP_HTML_CACHE;
  const bytes = Uint8Array.from(atob(APP_HTML_B64), c => c.charCodeAt(0));
  APP_HTML_CACHE = new TextDecoder("utf-8").decode(bytes);
  return APP_HTML_CACHE;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env);
      }

      if (
        url.pathname === "/" ||
        url.pathname === "/index.html" ||
        url.pathname === ""
      ) {
        return new Response(appHtml(), {
          headers: {
            "Content-Type": "text/html; charset=UTF-8",
            "Cache-Control": "no-cache"
          }
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      console.error(e);
      if (url.pathname.startsWith("/api/")) {
        return json({ ok: false, error: String(e?.message || e) }, 502);
      }
      return new Response("Internal error", { status: 500 });
    }
  }
};
