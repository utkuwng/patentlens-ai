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

  // No languageHints: DOCUMENT_TEXT_DETECTION auto-detects Latin languages.
  const r=await fetch("https://vision.googleapis.com/v1/images:annotate?key="+encodeURIComponent(key),{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({
      requests:[{
        image:{content:imageBase64},
        features:[{type:"DOCUMENT_TEXT_DETECTION"}]
      }]
    })
  });

  const data=await r.json();
  if(!r.ok) throw new Error(data?.error?.message||`Google Vision HTTP ${r.status}`);
  const item=data?.responses?.[0]||{};
  if(item.error) throw new Error(item.error.message||"Google Vision OCR lỗi.");

  const text=item?.fullTextAnnotation?.text || item?.textAnnotations?.[0]?.description || "";
  const langMap=new Map();

  const addLangs=(prop)=>{
    for(const dl of prop?.detectedLanguages||[]){
      const code=dl.languageCode||"";
      if(!code) continue;
      const conf=Number(dl.confidence)||0;
      langMap.set(code,Math.max(langMap.get(code)||0,conf));
    }
  };
  for(const page of item?.fullTextAnnotation?.pages||[]){
    addLangs(page.property);
    for(const block of page.blocks||[]){
      addLangs(block.property);
      for(const para of block.paragraphs||[]){
        addLangs(para.property);
        for(const word of para.words||[]){
          addLangs(word.property);
          for(const sym of word.symbols||[]) addLangs(sym.property);
        }
      }
    }
  }
  const languages=[...langMap.entries()]
    .map(([languageCode,confidence])=>({languageCode,confidence}))
    .sort((a,b)=>b.confidence-a.confidence);

  return {text:String(text||"").normalize("NFC"),languages};
}

function parseJsonLoose(s){
  let t=String(s||"").trim();
  t=t.replace(/^```(?:json)?/i,"").replace(/```$/,"").trim();
  const a=t.indexOf("[");
  const b=t.lastIndexOf("]");
  if(a>=0&&b>a) t=t.slice(a,b+1);
  return JSON.parse(t);
}

async function analyzeMatrixWithGemini(features,documents,env){
  if(!env.GEMINI_API_KEY){
    const e=new Error("Gemini chưa được cấu hình.");
    e.code="GEMINI_NOT_CONFIGURED";
    throw e;
  }

  const model=env.GEMINI_MODEL||"gemini-2.5-flash";
  const cleanDocs={};
  for(const k of ["D1","D2","D3"]){
    cleanDocs[k]={
      no:documents?.[k]?.no||"",
      text:String(documents?.[k]?.text||"").slice(0,22000)
    };
  }

  const prompt=`Bạn là trợ lý phân tích prior art sáng chế.
Nhiệm vụ: với TỪNG feature, đối chiếu riêng với D1, D2, D3.

QUY TẮC BẮT BUỘC:
- status chỉ được là: "Có", "Một phần", "Chưa chắc chắn", "Không tìm thấy".
- "Có" chỉ khi đoạn tài liệu bộc lộ rõ dấu hiệu.
- "Một phần" nếu chỉ bộc lộ một phần feature.
- "Chưa chắc chắn" nếu bằng chứng không đủ rõ hoặc khác ngôn ngữ/thuật ngữ.
- "Không tìm thấy" chỉ khi đã đọc nội dung được cung cấp nhưng không thấy bằng chứng liên quan.
- evidence phải là đoạn trích NGẮN từ tài liệu được cung cấp, không bịa.
- Không kết luận novelty/inventive step ở bước này.

FEATURES:
${JSON.stringify(features)}

DOCUMENTS:
${JSON.stringify(cleanDocs)}

Trả về JSON array THUẦN, không markdown:
[
  {
    "feature_id":"F01",
    "D1":{"status":"...","evidence":"..."},
    "D2":{"status":"...","evidence":"..."},
    "D3":{"status":"...","evidence":"..."}
  }
]`;

  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{
    method:"POST",
    headers:{
      "content-type":"application/json",
      "x-goog-api-key":env.GEMINI_API_KEY
    },
    body:JSON.stringify({
      contents:[{parts:[{text:prompt}]}],
      generationConfig:{
        temperature:0.1,
        responseMimeType:"application/json"
      }
    })
  });

  const data=await r.json();
  if(!r.ok) throw new Error(data?.error?.message||`Gemini HTTP ${r.status}`);
  const text=data?.candidates?.[0]?.content?.parts?.map(x=>x.text||"").join("")||"";
  const rows=parseJsonLoose(text);
  if(!Array.isArray(rows)) throw new Error("Gemini không trả array.");
  return rows;
}

async function handleApi(request, env) {
  const u = new URL(request.url);

  if (u.pathname === "/api/health") {
    return json({
      ok: true,
      service: "PatentLens AI",
      backend: "Cloudflare Worker",
      version: "12.1.0",
      time: new Date().toISOString(),
      providers: {
        serpapi: !!env.SERPAPI_KEY,
        browser_run: !!env.BROWSER,
        epo_ops: !!(env.EPO_CONSUMER_KEY && env.EPO_CONSUMER_SECRET),
        google_vision: !!(env.GOOGLE_VISION_API_KEY || env.GOOGLE_CLOUD_API_KEY),
        google_translate: !!(env.GOOGLE_TRANSLATE_API_KEY || env.GOOGLE_CLOUD_API_KEY),
        gemini: !!env.GEMINI_API_KEY,
        google_direct: true
      }
    });
  }

  if (u.pathname === "/api/ocr" && request.method === "POST") {
    try{
      const body=await request.json();
      const out=await googleVisionOcr(body.image_base64||"",env);
      return json({
        ok:true,
        provider:"Google Cloud Vision DOCUMENT_TEXT_DETECTION",
        text:out.text,
        languages:out.languages||[]
      });
    }catch(e){
      const code=e.code||"OCR_FAILED";
      return json({ok:false,code,error:String(e.message||e)},code==="VISION_NOT_CONFIGURED"?501:502);
    }
  }

  if (u.pathname === "/api/matrix" && request.method === "POST") {
    try{
      const body=await request.json();
      const rows=await analyzeMatrixWithGemini(body.features||[],body.documents||{},env);
      return json({ok:true,provider:"Gemini evidence mapping",rows});
    }catch(e){
      const code=e.code||"MATRIX_AI_FAILED";
      return json({ok:false,code,error:String(e.message||e)},code==="GEMINI_NOT_CONFIGURED"?501:502);
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

const APP_HTML_B64 = "PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InZpIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ii8+CjxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xIi8+Cjx0aXRsZT5QYXRlbnRMZW5zIEFJIOKAlCBRdXkgdHLDrG5oIHBow6JuIHTDrWNoIHPDoW5nIGNo4bq/PC90aXRsZT4KPG1ldGEgbmFtZT0iZGVzY3JpcHRpb24iIGNvbnRlbnQ9IlByb3RvdHlwZSBuZ2hpw6puIGPhu6l1IGjhu5cgdHLhu6MgdHJhIGPhu6l1IHbDoCDEkcOhbmggZ2nDoSBzxqEgYuG7mSBzw6FuZyBjaOG6vyB0aGVvIGNodeG7l2kgQ2xhaW0g4oaSIEZlYXR1cmUg4oaSIFNlYXJjaCDihpIgUHJpb3IgQXJ0IOKGkiBOb3ZlbHR5IOKGkiBJbnZlbnRpdmUgU3RlcCDihpIgRXhwZXJ0IFJldmlldy4iLz4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuanMuY2xvdWRmbGFyZS5jb20vYWpheC9saWJzL3BkZi5qcy8zLjExLjE3NC9wZGYubWluLmpzIj48L3NjcmlwdD4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9ucG0vdGVzc2VyYWN0LmpzQDUuMS4xL2Rpc3QvdGVzc2VyYWN0Lm1pbi5qcyI+PC9zY3JpcHQ+CjxzdHlsZT4KOnJvb3R7CiAgLS1iZzojZjZmN2Y5Oy0tc3VyZmFjZTojZmZmOy0tc3VyZmFjZTI6I2Y5ZmFmYjstLXRleHQ6IzEwMTgyODstLW11dGVkOiM2NjcwODU7CiAgLS1saW5lOiNlNGU3ZWM7LS1kYXJrOiMxMDE4Mjg7LS1zb2Z0OiNmMmY0Zjc7LS1ncmVlbjojMDY3NjQ3Oy0tZ3JlZW5iZzojZWNmZGYzOwogIC0teWVsbG93OiNiNTQ3MDg7LS15ZWxsb3diZzojZmZmYWViOy0tcmVkOiNiNDIzMTg7LS1yZWRiZzojZmVmM2YyOy0tYmx1ZTojMTc1Y2QzOwogIC0tYmx1ZWJnOiNlZmY4ZmY7LS1zaGFkb3c6MCAxMnB4IDM2cHggcmdiYSgxNiwyNCw0MCwuMDYpOy0tcmFkaXVzOjE4cHgKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH1odG1se3Njcm9sbC1iZWhhdmlvcjpzbW9vdGh9CmJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDp2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7Zm9udC1mYW1pbHk6SW50ZXIsdWktc2Fucy1zZXJpZiwtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwiU2Vnb2UgVUkiLFJvYm90byxBcmlhbCxzYW5zLXNlcmlmfQpidXR0b24saW5wdXQsdGV4dGFyZWEsc2VsZWN0e2ZvbnQ6aW5oZXJpdH1idXR0b257Y3Vyc29yOnBvaW50ZXJ9Ci5hcHB7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczoyNzVweCAxZnI7bWluLWhlaWdodDoxMDB2aH0KYXNpZGV7cG9zaXRpb246c3RpY2t5O3RvcDowO2hlaWdodDoxMDB2aDtiYWNrZ3JvdW5kOiMwZjExMTU7Y29sb3I6I2ZmZjtwYWRkaW5nOjI0cHggMThweDtib3JkZXItcmlnaHQ6MXB4IHNvbGlkICMyMjI4MzF9Ci5icmFuZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O3BhZGRpbmc6MCA4cHg7bWFyZ2luLWJvdHRvbToyNnB4fQoubG9nb3t3aWR0aDozOXB4O2hlaWdodDozOXB4O2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6IzExMTtkaXNwbGF5OmdyaWQ7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtd2VpZ2h0OjkwMH0KLmJyYW5kIHN0cm9uZ3tmb250LXNpemU6MTZweH0uYnJhbmQgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojOThhMmIzO21hcmdpbi10b3A6M3B4fQoucHJvY2Vzc3tkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo3cHh9Ci5wcm9jZXNzLWl0ZW17cGFkZGluZzoxMXB4IDEycHg7Ym9yZGVyLXJhZGl1czoxMnB4O2NvbG9yOiM4Zjk4YTY7ZGlzcGxheTpmbGV4O2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtmb250LXNpemU6MTNweH0KLnByb2Nlc3MtaXRlbSAubnt3aWR0aDoyNXB4O2hlaWdodDoyNXB4O2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7Ym9yZGVyLXJhZGl1czo4cHg7YmFja2dyb3VuZDojMjYyYjMzO2ZvbnQtc2l6ZToxMnB4fQoucHJvY2Vzcy1pdGVtLmFjdGl2ZXtiYWNrZ3JvdW5kOiMxZDIxMjg7Y29sb3I6I2ZmZn0KLnByb2Nlc3MtaXRlbS5kb25le2NvbG9yOiNkMGQ1ZGR9LnByb2Nlc3MtaXRlbS5kb25lIC5ue2JhY2tncm91bmQ6IzM0NDA1NDtjb2xvcjojZmZmfQouc2lkZS1ub3Rle3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MThweDtyaWdodDoxOHB4O2JvdHRvbToyMHB4O3BhZGRpbmc6MTRweDtib3JkZXItcmFkaXVzOjE0cHg7YmFja2dyb3VuZDojMTcxYTIwO2JvcmRlcjoxcHggc29saWQgIzI3MmMzNDtjb2xvcjojOThhMmIzO2ZvbnQtc2l6ZToxMnB4O2xpbmUtaGVpZ2h0OjEuNTV9Cm1haW57cGFkZGluZzozNHB4IDM4cHggMTIwcHg7bWluLXdpZHRoOjB9Ci50b3B7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTZweDttYXJnaW4tYm90dG9tOjIwcHh9Cmgxe2ZvbnQtc2l6ZToyOHB4O2xldHRlci1zcGFjaW5nOi0uMDRlbTttYXJnaW46MH0udG9wIHB7bWFyZ2luOjZweCAwIDA7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxNHB4fQouY2FzZS1iYWRnZXtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nOjlweCAxMnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7Y29sb3I6IzQ3NTQ2Nztmb250LXNpemU6MTJweDt3aGl0ZS1zcGFjZTpub3dyYXB9Ci5sb2NhbC1iYW5uZXJ7cGFkZGluZzoxM3B4IDE1cHg7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbi1ib3R0b206MTZweDtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU7Ym9yZGVyOjFweCBzb2xpZCAjZmVkZjg5O2JhY2tncm91bmQ6dmFyKC0teWVsbG93YmcpO2NvbG9yOiM3YTJlMGV9Ci5zZWN0aW9ue2Rpc3BsYXk6bm9uZX0uc2VjdGlvbi5hY3RpdmV7ZGlzcGxheTpibG9ja30KLnBhbmVse2JhY2tncm91bmQ6dmFyKC0tc3VyZmFjZSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3gtc2hhZG93OnZhcigtLXNoYWRvdyk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjRweDttYXJnaW4tYm90dG9tOjE4cHh9Ci5wYW5lbCBoMnttYXJnaW46MCAwIDZweDtmb250LXNpemU6MjBweDtsZXR0ZXItc3BhY2luZzotLjAyZW19LnN1Yntjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjE0cHg7bGluZS1oZWlnaHQ6MS41NTttYXJnaW4tYm90dG9tOjIwcHh9Ci5ncmlke2Rpc3BsYXk6Z3JpZDtnYXA6MTRweH0uZzJ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfS5nM3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9CmxhYmVse2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NzUwO2NvbG9yOiM0NzU0Njc7bWFyZ2luLWJvdHRvbTo3cHh9CmlucHV0LHRleHRhcmVhLHNlbGVjdHt3aWR0aDoxMDAlO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojZmZmO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEycHggMTNweDtvdXRsaW5lOm5vbmU7Y29sb3I6IzExMTgyN30KaW5wdXQ6Zm9jdXMsdGV4dGFyZWE6Zm9jdXMsc2VsZWN0OmZvY3Vze2JvcmRlci1jb2xvcjojOThhMmIzO2JveC1zaGFkb3c6MCAwIDAgM3B4IHJnYmEoMTcsMjQsMzksLjA1KX0KdGV4dGFyZWF7cmVzaXplOnZlcnRpY2FsO21pbi1oZWlnaHQ6MTEwcHh9Ci5kcm9we2JvcmRlcjoxLjVweCBkYXNoZWQgI2NmZDRkYztib3JkZXItcmFkaXVzOjE2cHg7YmFja2dyb3VuZDojZmFmYmZjO3BhZGRpbmc6MzBweDt0ZXh0LWFsaWduOmNlbnRlcjt0cmFuc2l0aW9uOi4yc30KLmRyb3AuZHJhZ3tib3JkZXItY29sb3I6IzY2NzA4NTtiYWNrZ3JvdW5kOiNmMmY0Zjd9LmRyb3Agc3Ryb25ne2Rpc3BsYXk6YmxvY2s7bWFyZ2luLWJvdHRvbTo2cHh9LmRyb3Agc21hbGx7Y29sb3I6dmFyKC0tbXV0ZWQpfQouYWN0aW9uc3tkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7ZmxleC13cmFwOndyYXA7bWFyZ2luLXRvcDoxNnB4fQouYnRue2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojZmZmO2NvbG9yOiMxMTE4Mjc7Ym9yZGVyLXJhZGl1czoxMXB4O3BhZGRpbmc6MTBweCAxNHB4O2ZvbnQtc2l6ZToxM3B4O2ZvbnQtd2VpZ2h0Ojc1MH0KLmJ0bjpob3ZlcntiYWNrZ3JvdW5kOiNmOGZhZmN9LmJ0bi5wcmltYXJ5e2JhY2tncm91bmQ6IzExMTgyNztjb2xvcjojZmZmO2JvcmRlci1jb2xvcjojMTExODI3fS5idG4uc3VjY2Vzc3tiYWNrZ3JvdW5kOnZhcigtLWdyZWVuYmcpO2NvbG9yOnZhcigtLWdyZWVuKTtib3JkZXItY29sb3I6I2FiZWZjNn0uYnRuLmRhbmdlcntjb2xvcjp2YXIoLS1yZWQpfQoucHJvZ3Jlc3N7aGVpZ2h0OjhweDtiYWNrZ3JvdW5kOiNlZWYwZjM7Ym9yZGVyLXJhZGl1czo5OXB4O292ZXJmbG93OmhpZGRlbjttYXJnaW4tdG9wOjE0cHh9LnByb2dyZXNzPmRpdntoZWlnaHQ6MTAwJTtiYWNrZ3JvdW5kOiMxMTE4Mjc7d2lkdGg6MCU7dHJhbnNpdGlvbjouMjVzfQouc3RhdHVze2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjhweDtsaW5lLWhlaWdodDoxLjV9Ci5kZXRlY3R7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNCwxZnIpO2dhcDoxMHB4fQouZGV0ZWN0LWNhcmR7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7cGFkZGluZzoxNHB4O2JhY2tncm91bmQ6I2ZmZn0KLmRldGVjdC1jYXJkIGJ7Zm9udC1zaXplOjEzcHh9LmRldGVjdC1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLXRvcDo0cHh9Ci5kZXRlY3QtY2FyZC5va3tiYWNrZ3JvdW5kOnZhcigtLWdyZWVuYmcpO2JvcmRlci1jb2xvcjojYWJlZmM2fS5kZXRlY3QtY2FyZC53YXJue2JhY2tncm91bmQ6dmFyKC0teWVsbG93YmcpO2JvcmRlci1jb2xvcjojZmVkZjg5fQouc3VtbWFyeXtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjE2MHB4IDFmcjtnYXA6OHB4IDE2cHg7Zm9udC1zaXplOjEzcHh9LnN1bW1hcnkgZGl2Om50aC1jaGlsZChvZGQpe2NvbG9yOiM2NjcwODV9Ci5jYWxsb3V0e3BhZGRpbmc6MTVweDtib3JkZXI6MXB4IHNvbGlkICNkMGQ1ZGQ7YmFja2dyb3VuZDojZjhmYWZjO2JvcmRlci1yYWRpdXM6MTRweDtjb2xvcjojNDc1NDY3O2ZvbnQtc2l6ZToxM3B4O2xpbmUtaGVpZ2h0OjEuNTV9LmNhbGxvdXQgc3Ryb25ne2NvbG9yOiMxMTE4Mjd9Ci50YWJsZS13cmFwe292ZXJmbG93OmF1dG87Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHh9dGFibGV7d2lkdGg6MTAwJTtib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7Zm9udC1zaXplOjEzcHh9dGh7YmFja2dyb3VuZDojZjhmYWZjO2NvbG9yOiM0NzU0Njc7dGV4dC1hbGlnbjpsZWZ0O2ZvbnQtc2l6ZToxMnB4fXRoLHRke3BhZGRpbmc6MTJweCAxMHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpO3ZlcnRpY2FsLWFsaWduOnRvcH10cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLnBpbGx7ZGlzcGxheTppbmxpbmUtZmxleDtwYWRkaW5nOjVweCA4cHg7Ym9yZGVyLXJhZGl1czo5OTlweDtiYWNrZ3JvdW5kOiNmMmY0Zjc7Y29sb3I6IzM0NDA1NDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo4MDB9LmdyZWVue2JhY2tncm91bmQ6dmFyKC0tZ3JlZW5iZyk7Y29sb3I6dmFyKC0tZ3JlZW4pfS55ZWxsb3d7YmFja2dyb3VuZDp2YXIoLS15ZWxsb3diZyk7Y29sb3I6dmFyKC0teWVsbG93KX0ucmVke2JhY2tncm91bmQ6dmFyKC0tcmVkYmcpO2NvbG9yOnZhcigtLXJlZCl9LmJsdWV7YmFja2dyb3VuZDp2YXIoLS1ibHVlYmcpO2NvbG9yOnZhcigtLWJsdWUpfQouY2xhaW0sLmRvY3tib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjE1cHg7YmFja2dyb3VuZDojZmZmfS5jbGFpbSsuY2xhaW0sLmRvYysuZG9je21hcmdpbi10b3A6MTBweH0uY2xhaW0gaDQsLmRvYyBoNHttYXJnaW46MCAwIDdweDtmb250LXNpemU6MTRweH0uY2xhaW0gcCwuZG9jIHB7bWFyZ2luOjA7Y29sb3I6IzVmNmI3YTtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU1fQouc3BsaXR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczptaW5tYXgoMCwxLjE1ZnIpIG1pbm1heCgzMjBweCwuODVmcik7Z2FwOjE4cHh9Ci5yaXNre2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTRweDthbGlnbi1pdGVtczpjZW50ZXI7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4fS5yaXNrIGgze21hcmdpbjowIDAgNXB4O2ZvbnQtc2l6ZToxNnB4fS5yaXNrIHB7bWFyZ2luOjA7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxM3B4fS5yaXNrYm94e21pbi13aWR0aDoxNDVweDt0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjEycHg7Ym9yZGVyLXJhZGl1czoxNHB4O2ZvbnQtd2VpZ2h0OjkwMH0KLmRpdmlkZXJ7aGVpZ2h0OjFweDtiYWNrZ3JvdW5kOnZhcigtLWxpbmUpO21hcmdpbjoxOHB4IDB9LmVtcHR5e3BhZGRpbmc6MjZweDtib3JkZXI6MXB4IGRhc2hlZCAjZDBkNWRkO2JvcmRlci1yYWRpdXM6MTRweDt0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjojOThhMmIzfQpjb2Rle2ZvbnQtZmFtaWx5OnVpLW1vbm9zcGFjZSxTRk1vbm8tUmVndWxhcixNZW5sbyxtb25vc3BhY2U7Zm9udC1zaXplOjEycHh9LnJlcG9ydHtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHg7cGFkZGluZzoyNHB4O2xpbmUtaGVpZ2h0OjEuNjV9LnJlcG9ydCBoM3ttYXJnaW4tdG9wOjI0cHh9LnJlcG9ydCBoMzpmaXJzdC1jaGlsZHttYXJnaW4tdG9wOjB9Ci53aXphcmRiYXJ7cG9zaXRpb246Zml4ZWQ7bGVmdDoyNzVweDtyaWdodDowO2JvdHRvbTowO2JhY2tncm91bmQ6cmdiYSgyNDYsMjQ3LDI0OSwuOTQpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWxpbmUpO3BhZGRpbmc6MTNweCAzOHB4O3otaW5kZXg6MjB9Ci53aXphcmRpbm5lcnttYXgtd2lkdGg6MTQwMHB4O21hcmdpbjphdXRvO2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEycHh9Ci53aXphcmRtZXRhe2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKX0ud2l6YXJkbWV0YSBzdHJvbmd7ZGlzcGxheTpibG9jaztjb2xvcjojMzQ0MDU0O2ZvbnQtc2l6ZToxM3B4O21hcmdpbi1ib3R0b206MnB4fQoubmV4dGJ0bnttaW4td2lkdGg6MTUwcHh9LmJhY2tidG57bWluLXdpZHRoOjEwNXB4fQouaGlkZGVue2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9CkBtZWRpYShtYXgtd2lkdGg6OTgwcHgpey5hcHB7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn1hc2lkZXtwb3NpdGlvbjpyZWxhdGl2ZTtoZWlnaHQ6YXV0b30uc2lkZS1ub3Rle3Bvc2l0aW9uOnN0YXRpYzttYXJnaW4tdG9wOjE4cHh9LnByb2Nlc3N7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpfW1haW57cGFkZGluZzoyMnB4IDE2cHggMTIwcHh9LmcyLC5nMywuc3BsaXQsLmRldGVjdHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS53aXphcmRiYXJ7bGVmdDowO3BhZGRpbmc6MTJweCAxNnB4fS50b3B7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59fQpAbWVkaWEgcHJpbnR7YXNpZGUsLnRvcCwud2l6YXJkYmFyLC5uby1wcmludCwuYWN0aW9uc3tkaXNwbGF5Om5vbmUhaW1wb3J0YW50fS5hcHB7ZGlzcGxheTpibG9ja31tYWlue3BhZGRpbmc6MH0uc2VjdGlvbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fSNyZXBvcnQuc2VjdGlvbntkaXNwbGF5OmJsb2NrIWltcG9ydGFudH0ucGFuZWx7Ym9yZGVyOjA7Ym94LXNoYWRvdzpub25lO3BhZGRpbmc6MH1ib2R5e2JhY2tncm91bmQ6I2ZmZn19CgovKiA9PT09PSB2NiBVWCByZWZpbmVtZW50cyA9PT09PSAqLwouY2xhaW0tY2xlYW57CiAgZm9udC1mYW1pbHk6QXJpYWwsIkhlbHZldGljYSBOZXVlIiwiU2Vnb2UgVUkiLHNhbnMtc2VyaWY7CiAgZm9udC1zaXplOjE0cHg7bGluZS1oZWlnaHQ6MS43ODtjb2xvcjojMzQ0MDU0O3doaXRlLXNwYWNlOnByZS13cmFwOwp9Ci5jbGFpbS1yYXd7CiAgZm9udC1mYW1pbHk6dWktbW9ub3NwYWNlLFNGTW9uby1SZWd1bGFyLE1lbmxvLENvbnNvbGFzLG1vbm9zcGFjZSFpbXBvcnRhbnQ7CiAgZm9udC1zaXplOjEycHghaW1wb3J0YW50O2xpbmUtaGVpZ2h0OjEuNiFpbXBvcnRhbnQ7YmFja2dyb3VuZDojZjhmYWZjIWltcG9ydGFudDsKfQouY2xhaW0tc3RlcHsKICBkaXNwbGF5OmJsb2NrO21hcmdpbjo4cHggMDtwYWRkaW5nLWxlZnQ6MTRweDtib3JkZXItbGVmdDoycHggc29saWQgI2U0ZTdlYzsKfQouZmVhdHVyZS1yZXZpZXctYmFyewogIHBvc2l0aW9uOnN0aWNreTt0b3A6MTJweDt6LWluZGV4Ojg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICBnYXA6MTZweDtwYWRkaW5nOjE0cHggMTZweDttYXJnaW46MTZweCAwO2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuOTYpOwogIGJhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JvcmRlcjoxcHggc29saWQgI2QwZDVkZDtib3JkZXItcmFkaXVzOjE0cHg7CiAgYm94LXNoYWRvdzowIDEwcHggMjhweCByZ2JhKDE2LDI0LDQwLC4wOSkKfQouZmVhdHVyZS1yZXZpZXctYmFyIC5tZXRhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEwcHg7ZmxleC13cmFwOndyYXB9Ci5mZWF0dXJlLXJldmlldy1iYXIgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5mZWF0dXJlLXJldmlldy1iYXIgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojNjY3MDg1O21hcmdpbi10b3A6M3B4fQouZmVhdHVyZS1jb25maXJtZWR7Ym9yZGVyLWNvbG9yOiNhYmVmYzY7YmFja2dyb3VuZDpyZ2JhKDIzNiwyNTMsMjQzLC45Nyl9Ci5zZWFyY2gtaGVyb3sKICBwYWRkaW5nOjE3cHg7Ym9yZGVyOjFweCBzb2xpZCAjZDBkNWRkO2JvcmRlci1yYWRpdXM6MTZweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxODBkZWcsI2ZmZiwjZjhmYWZjKTsKICBtYXJnaW4tYm90dG9tOjE2cHgKfQouc291cmNlLXJvd3tkaXNwbGF5OmZsZXg7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5zb3VyY2UtY2hpcHsKICBkaXNwbGF5OmlubGluZS1mbGV4O2dhcDo2cHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgI2QwZDVkZDtiYWNrZ3JvdW5kOiNmZmY7CiAgY29sb3I6IzM0NDA1NDtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6N3B4IDEwcHg7Zm9udC1zaXplOjEycHg7dGV4dC1kZWNvcmF0aW9uOm5vbmU7Zm9udC13ZWlnaHQ6NzAwCn0KLnNvdXJjZS1jaGlwOmhvdmVye2JhY2tncm91bmQ6I2YyZjRmN30KLnNlYXJjaC10b29sYmFye2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjEwcHg7bWFyZ2luLXRvcDoxNHB4fQouc2VhcmNoLXN0YXRle2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM2NjcwODU7bWFyZ2luLXRvcDoxMHB4O2xpbmUtaGVpZ2h0OjEuNX0KLnNlYXJjaC1yZXN1bHQtdGl0bGV7Zm9udC13ZWlnaHQ6NzUwO2NvbG9yOiMxMDE4Mjg7dGV4dC1kZWNvcmF0aW9uOm5vbmV9LnNlYXJjaC1yZXN1bHQtdGl0bGU6aG92ZXJ7dGV4dC1kZWNvcmF0aW9uOnVuZGVybGluZX0KLnNjb3Jle2ZvbnQtd2VpZ2h0Ojg1MDtmb250LXNpemU6MTNweH0KLnNjb3JlLmhpZ2h7Y29sb3I6IzA2NzY0N30uc2NvcmUubWlke2NvbG9yOiNiNTQ3MDh9LnNjb3JlLmxvd3tjb2xvcjojNjY3MDg1fQouY2FuZGlkYXRlLWFjdGlvbnN7ZGlzcGxheTpmbGV4O2dhcDo2cHg7ZmxleC13cmFwOndyYXB9Ci5zbG90YnRue3BhZGRpbmc6NnB4IDlweDtib3JkZXItcmFkaXVzOjlweDtib3JkZXI6MXB4IHNvbGlkICNkMGQ1ZGQ7YmFja2dyb3VuZDojZmZmO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MH0KLnNsb3RidG46aG92ZXJ7YmFja2dyb3VuZDojZjJmNGY3fQoucHJpb3Itc2xvdHsKICBib3JkZXI6MXB4IHNvbGlkICNlNGU3ZWM7Ym9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MTRweDtiYWNrZ3JvdW5kOiNmZmYKfQoucHJpb3Itc2xvdC5zZWxlY3RlZHtib3JkZXItY29sb3I6Izg0YWRmZjtib3gtc2hhZG93OjAgMCAwIDNweCAjZWZmOGZmfQouc2V0dGluZ3MtZ3JpZHtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmVuZH0KLmJhY2tlbmQtb2t7Y29sb3I6IzA2NzY0N30uYmFja2VuZC1iYWR7Y29sb3I6I2I0MjMxOH0KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgLmZlYXR1cmUtcmV2aWV3LWJhcntwb3NpdGlvbjpzdGF0aWM7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59CiAgLnNlYXJjaC10b29sYmFyLC5zZXR0aW5ncy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9Cn0KCjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+CjxkaXYgY2xhc3M9ImFwcCI+Cjxhc2lkZT4KICA8ZGl2IGNsYXNzPSJicmFuZCI+PGRpdiBjbGFzcz0ibG9nbyI+UDwvZGl2PjxkaXY+PHN0cm9uZz5QYXRlbnRMZW5zIEFJPC9zdHJvbmc+PHNtYWxsPlByb3RvdHlwZSBuZ2hpw6puIGPhu6l1IMK3IEZ1bGwtc3RhY2sgdjEyLjEgT0NSIENETiBGaXg8L3NtYWxsPjwvZGl2PjwvZGl2PgogIDxkaXYgY2xhc3M9InByb2Nlc3MiIGlkPSJwcm9jZXNzIj48L2Rpdj4KICA8ZGl2IGNsYXNzPSJzaWRlLW5vdGUiPjxzdHJvbmcgc3R5bGU9ImNvbG9yOiNmZmYiPlBo4bqhbSB2aSBwcm90b3R5cGU8L3N0cm9uZz48YnIvPkjhu5cgdHLhu6MgY2h14buXaSB0cmEgY+G7qXUgdsOgIMSRw6FuaCBnacOhIHPGoSBi4buZIHPDoW5nIGNo4bq/LiBLaMO0bmcgdGhheSB0aOG6vyBjaHV5w6puIGdpYSB2w6Aga2jDtG5nIMSR4bqhaSBkaeG7h24gdG/DoG4gYuG7mSBxdXkgdHLDrG5oIHjDoWMgbOG6rXAgcXV54buBbiBj4bunYSBJUCBHUk9VUC48L2Rpdj4KPC9hc2lkZT4KCjxtYWluPgogIDxkaXYgY2xhc3M9InRvcCI+PGRpdj48aDEgaWQ9InBhZ2VUaXRsZSI+PC9oMT48cCBpZD0icGFnZVN1YiI+PC9wPjwvZGl2PjxkaXYgY2xhc3M9ImNhc2UtYmFkZ2UiIGlkPSJjYXNlQmFkZ2UiPkNoxrBhIGPDsyBjYXNlPC9kaXY+PC9kaXY+CiAgPGRpdiBjbGFzcz0ibG9jYWwtYmFubmVyIiBpZD0ibG9jYWxCYW5uZXIiIHN0eWxlPSJkaXNwbGF5Om5vbmUiPkLhuqFuIMSRYW5nIG3hu58gYuG6sW5nIDxzdHJvbmc+ZmlsZTovLzwvc3Ryb25nPi4gQ2hyb21lIGPDsyB0aOG7gyBjaOG6t24gV2ViIFdvcmtlciBkw7luZyBjaG8gT0NSLiBC4bqjbiBuw6B5IHbhuqtuIGPhu5EgxJHhu41jIFBERiBi4bqxbmcgdGV4dCBsYXllcjsgxJHhu4MgT0NSIOG7lW4gxJHhu4tuaCwgbsOqbiBjaOG6oXkgYuG6sW5nIDxzdHJvbmc+R2l0SHViIFBhZ2VzPC9zdHJvbmc+IGhv4bq3YyBsb2NhbCBzZXJ2ZXIgKHbDrSBk4bulIDxjb2RlPnB5dGhvbjMgLW0gaHR0cC5zZXJ2ZXI8L2NvZGU+KS48L2Rpdj4KCiAgPHNlY3Rpb24gaWQ9ImludGFrZSIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+MS4gVOG6o2kgdMOgaSBsaeG7h3Ugc8OhbmcgY2jhur88L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPkjhu4cgdGjhu5FuZyB04buxIMSR4buNYyBQREYuIE7hur91IGZpbGUgY8OzIHRleHQgbGF5ZXIgc+G6vSB0csOtY2ggdHLhu7FjIHRp4bq/cDsgbuG6v3UgbMOgIGLhuqNuIHNjYW4sIGjhu4cgdGjhu5FuZyB04buxIGNodXnhu4NuIHNhbmcgT0NSIMSR4buDIGPhu5EgZ+G6r25nIG5o4bqtbiBkaeG7h24gbWV0YWRhdGEgdsOgIHnDqnUgY+G6p3UgYuG6o28gaOG7mS48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZHJvcCIgaWQ9ImRyb3Bab25lIj4KICAgICAgICA8c3Ryb25nPlRo4bqjIFBERiB2w6BvIMSRw6J5IGhv4bq3YyBjaOG7jW4gZmlsZTwvc3Ryb25nPgogICAgICAgIDxzbWFsbD5I4buXIHRy4bujIFBERiBwYXRlbnQgdGnhur9uZyBWaeG7h3QvQW5oLiBPQ1IgY8OzIHRo4buDIG3huqV0IHbDoGkgcGjDunQgduG7m2kgYuG6o24gc2Nhbi48L3NtYWxsPjxici8+PGJyLz4KICAgICAgICA8aW5wdXQgaWQ9InBkZklucHV0IiB0eXBlPSJmaWxlIiBhY2NlcHQ9ImFwcGxpY2F0aW9uL3BkZiIgc3R5bGU9Im1heC13aWR0aDo0MjBweCIvPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0icHJvZ3Jlc3MiPjxkaXYgaWQ9InByb2dyZXNzQmFyIj48L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdHVzIiBpZD0icGRmU3RhdHVzIj5DaMawYSBjw7MgZmlsZS48L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPkvhur90IHF14bqjIG5o4bqtbiBkaeG7h24gdOG7sSDEkeG7mW5nPC9oMj4KICAgICAgPGRpdiBjbGFzcz0iZGV0ZWN0Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJkZXRlY3QtY2FyZCIgaWQ9ImRldE1ldGEiPjxiPk1ldGFkYXRhPC9iPjxzcGFuPkNoxrBhIHjhu60gbMO9PC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRldGVjdC1jYXJkIiBpZD0iZGV0QWJzdHJhY3QiPjxiPlTDs20gdOG6r3Q8L2I+PHNwYW4+Q2jGsGEgeOG7rSBsw708L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZGV0ZWN0LWNhcmQiIGlkPSJkZXRDbGFpbXMiPjxiPlnDqnUgY+G6p3UgYuG6o28gaOG7mTwvYj48c3Bhbj5DaMawYSB44butIGzDvTwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkZXRlY3QtY2FyZCIgaWQ9ImRldE9DUiI+PGI+T0NSPC9iPjxzcGFuPkNoxrBhIGPhuqduPC9zcGFuPjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgoKICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPlRow7RuZyB0aW4gc8OhbmcgY2jhur88L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPkPDoWMgdHLGsOG7nW5nIMSRxrDhu6NjIHThu7EgxJFp4buBbiB04burIFBERjsgbmfGsOG7nWkgZMO5bmcgY8OzIHRo4buDIHPhu61hIG7hur91IG5o4bqtbiBkaeG7h24gc2FpLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4KICAgICAgICA8ZGl2PjxsYWJlbD5Nw6MgY2FzZTwvbGFiZWw+PGlucHV0IGlkPSJjYXNlSWQiLz48L2Rpdj4KICAgICAgICA8ZGl2PjxsYWJlbD5T4buRIGLhurFuZyAvIHPhu5EgY8O0bmcgYuG7kTwvbGFiZWw+PGlucHV0IGlkPSJwYXRlbnRObyIvPjwvZGl2PgogICAgICAgIDxkaXY+PGxhYmVsPlF14buRYyBnaWEgLyBo4buHIHRo4buRbmc8L2xhYmVsPjxzZWxlY3QgaWQ9Imp1cmlzZGljdGlvbiI+PG9wdGlvbj5WTjwvb3B0aW9uPjxvcHRpb24+VVM8L29wdGlvbj48b3B0aW9uPldPL1BDVDwvb3B0aW9uPjxvcHRpb24+RVA8L29wdGlvbj48b3B0aW9uPktow6FjPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICA8ZGl2PjxsYWJlbD5Uw6puIHPDoW5nIGNo4bq/PC9sYWJlbD48aW5wdXQgaWQ9InRpdGxlIi8+PC9kaXY+CiAgICAgICAgPGRpdj48bGFiZWw+TmfDoHkgbuG7mXAgxJHGoW4gLyBuZ8OgeSDGsHUgdGnDqm48L2xhYmVsPjxpbnB1dCBpZD0iZmlsaW5nRGF0ZSIgdHlwZT0iZGF0ZSIvPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPGRpdj48bGFiZWw+Q2jhu6cgxJHGoW4gLyBjaOG7pyBi4bqxbmc8L2xhYmVsPjxpbnB1dCBpZD0iYXBwbGljYW50Ii8+PC9kaXY+CiAgICAgICAgPGRpdj48bGFiZWw+xJDhuqFpIGRp4buHbiBTSFRUPC9sYWJlbD48aW5wdXQgaWQ9InJlcHJlc2VudGF0aXZlIi8+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxsYWJlbD5JUEMgLyBDUEM8L2xhYmVsPjxpbnB1dCBpZD0iaXBjIi8+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+PGxhYmVsPlTDs20gdOG6r3Q8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iYWJzdHJhY3QiPjwvdGV4dGFyZWE+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMgbm8tcHJpbnQiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0icmV0cnlPQ1IiPlThu7EgcXXDqXQgT0NSIHnDqnUgY+G6p3UgYuG6o28gaOG7mTwvYnV0dG9uPjxidXR0b24gY2xhc3M9ImJ0biIgaWQ9ImxvYWREZW1vIj5O4bqhcCBkZW1vIFBILVZOLTAxPC9idXR0b24+PC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CgogIDxzZWN0aW9uIGlkPSJjbGFpbXMiIGNsYXNzPSJzZWN0aW9uIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPjIuIFjDoWMgxJHhu4tuaCB5w6p1IGPhuqd1IGLhuqNvIGjhu5k8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPkjhu4cgdGjhu5FuZyBsw6BtIHPhuqFjaCB2xINuIGLhuqNuIE9DUiB0csaw4bubYyBraGkgaGnhu4NuIHRo4buLLiBC4bqjbiBPQ1IgdGjDtCB24bqrbiDEkcaw4bujYyBnaeG7ryDEkeG7gyDEkeG7kWkgY2hp4bq/dSBraGkgY+G6p24uPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJzcGxpdCI+CiAgICAgICAgPGRpdj4KICAgICAgICAgIDxsYWJlbD5C4bqjbiB5w6p1IGPhuqd1IGLhuqNvIGjhu5kgxJHDoyBjaHXhuqluIGjDs2E8L2xhYmVsPgogICAgICAgICAgPHRleHRhcmVhIGlkPSJjbGFpbXNDbGVhbiIgY2xhc3M9ImNsYWltLWNsZWFuIiBzdHlsZT0ibWluLWhlaWdodDozOTBweCIgcGxhY2Vob2xkZXI9Ik7hu5lpIGR1bmcgY2xhaW1zIMSRw6MgbMOgbSBz4bqhY2ggc+G6vSBoaeG7g24gdGjhu4sgdOG6oWkgxJHDonkuIj48L3RleHRhcmVhPgogICAgICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0icGFyc2VDbGFpbXMiPkNodeG6qW4gaMOzYSAmIHTDoWNoIGzhuqFpIGNsYWltczwvYnV0dG9uPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJvY3JDbGFpbXNBZ2FpbiI+VOG7sSBxdcOpdCBPQ1IgY2xhaW1zPC9idXR0b24+CiAgICAgICAgICA8L2Rpdj4KCiAgICAgICAgICA8ZGV0YWlscyBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4KICAgICAgICAgICAgPHN1bW1hcnkgc3R5bGU9ImN1cnNvcjpwb2ludGVyO2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM2NjcwODUiPlhlbSBi4bqjbiBPQ1IgdGjDtCAvIGNo4buJbmggdGF5PC9zdW1tYXJ5PgogICAgICAgICAgICA8dGV4dGFyZWEgaWQ9ImNsYWltc1JhdyIgY2xhc3M9ImNsYWltLXJhdyIgc3R5bGU9Im1pbi1oZWlnaHQ6MjMwcHg7bWFyZ2luLXRvcDoxMHB4IiBwbGFjZWhvbGRlcj0iQuG6o24gT0NSIHRow7QuIj48L3RleHRhcmVhPgogICAgICAgICAgPC9kZXRhaWxzPgogICAgICAgIDwvZGl2PgoKICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsPkRhbmggc8OhY2ggY2xhaW1zPC9sYWJlbD4KICAgICAgICAgIDxkaXYgaWQ9ImNsYWltTGlzdCIgY2xhc3M9ImVtcHR5Ij5DaMawYSBjw7MgY2xhaW0uPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgoKICA8c2VjdGlvbiBpZD0iZmVhdHVyZXMiIGNsYXNzPSJzZWN0aW9uIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPjMuIFBow6JuIHTDrWNoIGThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQ8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPlTDoWNoIGNsYWltIMSRw6MgY2jhu41uIHRow6BuaCB04burbmcgZOG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdCDEkeG7gyBwaOG7pWMgduG7pSB0cmEgY+G7qXUgdsOgIGzhuq1wIGLhuqNuZyBzbyBzw6FuaC4gQuG7mSBk4bqldSBoaeG7h3UgxJHGsOG7o2MgcGjDqXAgY2jhu4luaCBz4butYSB0csaw4bubYyBraGkgeMOhYyBuaOG6rW4uPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiPjxkaXY+PGxhYmVsPkNsYWltIGPhuqduIHBow6JuIHTDrWNoPC9sYWJlbD48c2VsZWN0IGlkPSJjbGFpbVNlbGVjdCI+PC9zZWxlY3Q+PC9kaXY+PGRpdj48bGFiZWw+VHLhuqFuZyB0aMOhaTwvbGFiZWw+PGlucHV0IGlkPSJmZWF0dXJlU3RhdHVzIiB2YWx1ZT0iQ2jGsGEgdOG6oW8iIHJlYWRvbmx5Lz48L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmVhdHVyZS1yZXZpZXctYmFyIiBpZD0iZmVhdHVyZVJldmlld0JhciI+CiAgICAgICAgPGRpdiBjbGFzcz0ibWV0YSI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0icGlsbCB5ZWxsb3ciIGlkPSJmZWF0dXJlU3RhdHVzQmFkZ2UiPkNoxrBhIHjDoWMgbmjhuq1uPC9zcGFuPgogICAgICAgICAgPGRpdj48c3Ryb25nIGlkPSJmZWF0dXJlQ291bnRMYWJlbCI+Q2jGsGEgY8OzIGThuqV1IGhp4buHdTwvc3Ryb25nPjxzbWFsbD5LaeG7g20gdHJhIG7hu5lpIGR1bmcgdHLGsOG7m2Mga2hpIGtow7NhIGLhu5kgZOG6pXUgaGnhu4d1IMSR4buDIHRyYSBj4bupdS48L3NtYWxsPjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiIHN0eWxlPSJtYXJnaW4tdG9wOjAiPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0iYXV0b0ZlYXR1cmVzIj5U4bqhbyAvIHTDoWNoIGzhuqFpPC9idXR0b24+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9ImNvbmZpcm1GZWF0dXJlcyI+4pyTIFjDoWMgbmjhuq1uIGLhu5kgZOG6pXUgaGnhu4d1PC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIiBzdHlsZT0ibWFyZ2luLXRvcDoxOHB4Ij48dGFibGU+PHRoZWFkPjx0cj48dGg+TcOjPC90aD48dGg+ROG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdDwvdGg+PHRoPk5ow7NtPC90aD48dGg+xJDhu5kgdGluIGPhuq15PC90aD48dGg+PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5IGlkPSJmZWF0dXJlQm9keSI+PC90Ym9keT48L3RhYmxlPjwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgoKICA8c2VjdGlvbiBpZD0ic2VhcmNoIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj40LiBYw6J5IGThu7FuZyBjaGnhur9uIGzGsOG7o2MgdHJhIGPhu6l1PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5U4burIGLhu5kgZOG6pXUgaGnhu4d1IMSRw6MgeMOhYyBuaOG6rW4sIGjhu4cgdGjhu5FuZyBzaW5oIHThu6sga2jDs2EgdsOgIGPDonUgbOG7h25oIHPGoSBi4buZLiDEkMOieSBsw6AgYsaw4bubYyBo4buXIHRy4bujIGNodXnDqm4gZ2lhIHjDonkgZOG7sW5nIHbDoCBs4bq3cCBs4bqhaSBjaGnhur9uIGzGsOG7o2MgdHJhIGPhu6l1LjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIj48YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9ImdlblNlYXJjaCI+VOG6oW8gY2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdTwvYnV0dG9uPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIiBzdHlsZT0ibWFyZ2luLXRvcDoxOHB4Ij48dGFibGU+PHRoZWFkPjx0cj48dGg+RmVhdHVyZTwvdGg+PHRoPlThu6sga2jDs2EgY2jDrW5oPC90aD48dGg+Qmnhur9uIHRo4buDIC8gc3lub255bTwvdGg+PHRoPklQQy9DUEMgZ+G7o2kgw708L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9InNlYXJjaEJvZHkiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZGl2aWRlciI+PC9kaXY+PGxhYmVsPkPDonUgbOG7h25oIGfhu6NpIMO9PC9sYWJlbD48ZGl2IGlkPSJxdWVyeUxpc3QiIGNsYXNzPSJncmlkIj48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9InByaW9yIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj41LiBUw6xtICYgc8OgbmcgbOG7jWMgdMOgaSBsaeG7h3UgxJHhu5FpIGNo4bupbmc8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPgogICAgICAgIEjhu4cgdGjhu5FuZyB04bqhbyB0cnV5IHbhuqVuIHThu6sgYuG7mSBk4bqldSBoaeG7h3UsIHTDrG0gcGF0ZW50IHRo4bqtdCBxdWEgYmFja2VuZCBHb29nbGUgUGF0ZW50cywgeOG6v3AgaOG6oW5nIHRoZW8gxJHhu5kgbGnDqm4gcXVhbiB2w6AgxJFp4buBdSBraeG7h24gdGjhu51pIGdpYW4sCiAgICAgICAgc2F1IMSRw7MgY2hvIHBow6lwIGNo4buNbiB0cuG7sWMgdGnhur9wIEQx4oCTRDMuIFdJUE8gUEFURU5UU0NPUEUgdsOgIEVzcGFjZW5ldCDEkcaw4bujYyBkw7luZyBsw6BtIG5ndeG7k24ga2nhu4NtIGNo4bupbmcgYuG7lSBzdW5nLgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9InNlYXJjaC1oZXJvIj4KICAgICAgICA8ZGl2IGNsYXNzPSJzb3VyY2Utcm93Ij4KICAgICAgICAgIDxzdHJvbmcgc3R5bGU9ImZvbnQtc2l6ZToxM3B4Ij5OZ3Xhu5NuIHRyYSBj4bupdTo8L3N0cm9uZz4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaWQ9ImdwTGluayIgaHJlZj0iaHR0cHM6Ly9wYXRlbnRzLmdvb2dsZS5jb20vIiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciI+R29vZ2xlIFBhdGVudHMg4oaXPC9hPgogICAgICAgICAgPGEgY2xhc3M9InNvdXJjZS1jaGlwIiBpZD0id2lwb0xpbmsiIGhyZWY9Imh0dHBzOi8vcGF0ZW50c2NvcGUud2lwby5pbnQvIiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciI+V0lQTyBQQVRFTlRTQ09QRSDihpc8L2E+CiAgICAgICAgICA8YSBjbGFzcz0ic291cmNlLWNoaXAiIGlkPSJlcG9MaW5rIiBocmVmPSJodHRwczovL3dvcmxkd2lkZS5lc3BhY2VuZXQuY29tLyIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkVQTyBFc3BhY2VuZXQg4oaXPC9hPgogICAgICAgIDwvZGl2PgoKICAgICAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtdG9vbGJhciI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImxpdmVTZWFyY2hRdWVyeSIgcGxhY2Vob2xkZXI9J1bDrSBk4bulOiAiZHJhZ29uIGZydWl0IHNlZWQiIGNlbGx1bGFzZSBwZWN0aW5hc2UnPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJsaXZlU2VhcmNoQnRuIj7ijJUgVMOsbSB0w6BpIGxp4buHdSB0aOG6rXQ8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtc3RhdGUiIGlkPSJsaXZlU2VhcmNoU3RhdGUiPkNoxrBhIGNo4bqheSB0cmEgY+G7qXUuPC9kaXY+CgogICAgICAgIDxkaXYgY2xhc3M9ImNhbGxvdXQiIHN0eWxlPSJtYXJnaW4tdG9wOjEzcHgiPgogICAgICA8c3Ryb25nPkJhY2tlbmQgdMOtY2ggaOG7o3AgY8O5bmcgd2Vic2l0ZTwvc3Ryb25nPjxicj4KICAgICAgQuG6o24gZnVsbC1zdGFjayBz4butIGThu6VuZyBBUEkgY8O5bmcgZG9tYWluICg8Y29kZT4vYXBpLyo8L2NvZGU+KSwgbsOqbiBraMO0bmcgY+G6p24gbmjhuq1wIFdvcmtlciBVUkwgcmnDqm5nLgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJ0ZXN0QmFja2VuZCI+S2nhu4NtIHRyYSBiYWNrZW5kPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdGF0dXMiIGlkPSJiYWNrZW5kU3RhdHVzIj5DaMawYSBraeG7g20gdHJhIGvhur90IG7hu5FpLjwvZGl2PgogICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0idXNlQmVzdFF1ZXJ5Ij5Ew7luZyB0cnV5IHbhuqVuIHThu6sgYsaw4bubYyA0PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHN1Y2Nlc3MiIGlkPSJhdXRvUGlja1ByaW9yIj5U4buxIGfhu6NpIMO9IEQx4oCTRDM8L2J1dHRvbj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIiBzdHlsZT0ibWFyZ2luLXRvcDoxNnB4Ij4KICAgICAgICA8dGFibGU+CiAgICAgICAgICA8dGhlYWQ+CiAgICAgICAgICAgIDx0cj4KICAgICAgICAgICAgICA8dGg+IzwvdGg+PHRoPlTDoGkgbGnhu4d1IHRo4bqtdDwvdGg+PHRoPk5nw6B5PC90aD48dGg+xJDhu5kgcGjDuSBo4bujcDwvdGg+PHRoPsSQaeG7gXUga2nhu4duIHRo4budaSBnaWFuPC90aD48dGg+Q2jhu41uPC90aD4KICAgICAgICAgICAgPC90cj4KICAgICAgICAgIDwvdGhlYWQ+CiAgICAgICAgICA8dGJvZHkgaWQ9ImNhbmRpZGF0ZUJvZHkiPgogICAgICAgICAgICA8dHI+PHRkIGNvbHNwYW49IjYiIHN0eWxlPSJjb2xvcjojOThhMmIzO3RleHQtYWxpZ246Y2VudGVyIj5DaMawYSBjw7Mga+G6v3QgcXXhuqMgdHJhIGPhu6l1LjwvdGQ+PC90cj4KICAgICAgICAgIDwvdGJvZHk+CiAgICAgICAgPC90YWJsZT4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj5EMeKAk0QzIMSRxrDhu6NjIGNo4buNbjwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN1YiI+S2hpIGNo4buNbiBt4buZdCBr4bq/dCBxdeG6oywgaOG7hyB0aOG7kW5nIHThu7EgbOG6pXkgbWV0YWRhdGEgdsOgIG7hu5lpIGR1bmcgcGF0ZW50IMSR4buDIMSRaeG7gW4gdsOgbyBzbG90IHTGsMahbmcg4bupbmcuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzMiPgogICAgICAgIDxkaXYgY2xhc3M9InByaW9yLXNsb3QiIGlkPSJzbG90RDEiPgogICAgICAgICAgPGg0PkQxIMK3IOG7qG5nIHZpw6puIMSR4buRaSBjaOG7qW5nIGfhuqduIG5o4bqldDwvaDQ+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQxTm8iIHBsYWNlaG9sZGVyPSJT4buRIGPDtG5nIGLhu5EiPgogICAgICAgICAgPGlucHV0IGlkPSJkMURhdGUiIHR5cGU9ImRhdGUiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQxVXJsIiBwbGFjZWhvbGRlcj0iVVJMIG5ndeG7k24iIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgICA8dGV4dGFyZWEgaWQ9ImQxVGV4dCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4O21pbi1oZWlnaHQ6MTkwcHgiIHBsYWNlaG9sZGVyPSJBYnN0cmFjdCAvIGNsYWltcyAvIHNuaXBwZXQgc+G6vSDEkcaw4bujYyB04buxIMSRaeG7gW4uLi4iPjwvdGV4dGFyZWE+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icHJpb3Itc2xvdCIgaWQ9InNsb3REMiI+CiAgICAgICAgICA8aDQ+RDIgwrcgVMOgaSBsaeG7h3UgYuG7lSBzdW5nPC9oND4KICAgICAgICAgIDxpbnB1dCBpZD0iZDJObyIgcGxhY2Vob2xkZXI9IlPhu5EgY8O0bmcgYuG7kSI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQyRGF0ZSIgdHlwZT0iZGF0ZSIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICAgIDxpbnB1dCBpZD0iZDJVcmwiIHBsYWNlaG9sZGVyPSJVUkwgbmd14buTbiIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0iZDJUZXh0IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHg7bWluLWhlaWdodDoxOTBweCIgcGxhY2Vob2xkZXI9IkFic3RyYWN0IC8gY2xhaW1zIC8gc25pcHBldCBz4bq9IMSRxrDhu6NjIHThu7EgxJFp4buBbi4uLiI+PC90ZXh0YXJlYT4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJwcmlvci1zbG90IiBpZD0ic2xvdEQzIj4KICAgICAgICAgIDxoND5EMyDCtyBUw6BpIGxp4buHdSBi4buVIHN1bmc8L2g0PgogICAgICAgICAgPGlucHV0IGlkPSJkM05vIiBwbGFjZWhvbGRlcj0iU+G7kSBjw7RuZyBi4buRIj4KICAgICAgICAgIDxpbnB1dCBpZD0iZDNEYXRlIiB0eXBlPSJkYXRlIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgICAgPGlucHV0IGlkPSJkM1VybCIgcGxhY2Vob2xkZXI9IlVSTCBuZ3Xhu5NuIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgICAgPHRleHRhcmVhIGlkPSJkM1RleHQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweDttaW4taGVpZ2h0OjE5MHB4IiBwbGFjZWhvbGRlcj0iQWJzdHJhY3QgLyBjbGFpbXMgLyBzbmlwcGV0IHPhur0gxJHGsOG7o2MgdOG7sSDEkWnhu4FuLi4uIj48L3RleHRhcmVhPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0idmFsaWRhdGVQcmlvciI+S2nhu4NtIHRyYSDEkWnhu4F1IGtp4buHbiB0aOG7nWkgZ2lhbjwvYnV0dG9uPjwvZGl2PgogICAgICA8ZGl2IGlkPSJwcmlvckNoZWNrIiBjbGFzcz0iY2FsbG91dCIgc3R5bGU9Im1hcmdpbi10b3A6MTZweCI+PHN0cm9uZz5MxrB1IMO9Ojwvc3Ryb25nPiBuZ8OgeSB2w6AgbuG7mWkgZHVuZyB24bqrbiBj4bqnbiBjaHV5w6puIGdpYSBraeG7g20gY2jhu6luZyB0csOqbiB0w6BpIGxp4buHdSBn4buRYy48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9ImNvbXBhcmUiIGNsYXNzPSJzZWN0aW9uIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPjYuIEzhuq1wIGLhuqNuZyBzbyBzw6FuaCBk4bqldSBoaeG7h3U8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPsSQ4buRaSBjaGnhur91IHThu6tuZyBk4bqldSBoaeG7h3UgduG7m2kgdOG7q25nIHTDoGkgbGnhu4d1LiBO4bq/dSBjaMawYSBjw7MgYuG6sW5nIGNo4bupbmcgxJHhu6cgcsO1LCBo4buHIHRo4buRbmcgcGjhuqNpIHRy4bqjIHbhu4Eg4oCcQ2jGsGEgY2jhuq9jIGNo4bqvbuKAnS48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+PGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJidWlsZE1hdHJpeCI+VOG6oW8gbWEgdHLhuq1uIMSR4buRaSBjaGnhur91PC9idXR0b24+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXdyYXAiIHN0eWxlPSJtYXJnaW4tdG9wOjE4cHgiPjx0YWJsZT48dGhlYWQ+PHRyPjx0aD5GZWF0dXJlPC90aD48dGg+RDE8L3RoPjx0aD5EMjwvdGg+PHRoPkQzPC90aD48dGg+QuG6sW5nIGNo4bupbmcgLyBnaGkgY2jDujwvdGg+PC90cj48L3RoZWFkPjx0Ym9keSBpZD0ibWF0cml4Qm9keSI+PC90Ym9keT48L3RhYmxlPjwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgoKICA8c2VjdGlvbiBpZD0iYXNzZXNzIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj43LiDEkMOhbmggZ2nDoSBzxqEgYuG7mTwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN1YiI+xJDDoW5oIGdpw6EgdGhlbyB04burbmcgY2xhaW0gdsOgIHThuq1wIHTDoGkgbGnhu4d1IMSRYW5nIGto4bqjbyBzw6F0OyBraMO0bmcgcGjhuqNpIGvhur90IGx14bqtbiBj4bqlcCBi4bqxbmcuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJpc2siPjxkaXY+PGgzPlTDrW5oIG3hu5tpPC9oMz48cCBpZD0ibm92ZWx0eVRleHQiPkNoxrBhIMSRw6FuaCBnacOhLjwvcD48L2Rpdj48ZGl2IGNsYXNzPSJyaXNrYm94IHllbGxvdyIgaWQ9Im5vdmVsdHlSaXNrIj5DSOG7nCBE4buuIExJ4buGVTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJoZWlnaHQ6MTJweCI+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InJpc2siPjxkaXY+PGgzPlRyw6xuaCDEkeG7mSBzw6FuZyB04bqhbzwvaDM+PHAgaWQ9ImludmVudGl2ZVRleHQiPkNoxrBhIMSRw6FuaCBnacOhLjwvcD48L2Rpdj48ZGl2IGNsYXNzPSJyaXNrYm94IHllbGxvdyIgaWQ9ImludmVudGl2ZVJpc2siPkNI4bucIEThu64gTEnhu4ZVPC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImRpdmlkZXIiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj48ZGl2PjxsYWJlbD7EkOG7kWkgY2jhu6luZyBn4bqnbiBuaOG6pXQ8L2xhYmVsPjxzZWxlY3QgaWQ9ImNsb3Nlc3QiPjxvcHRpb24+RDE8L29wdGlvbj48b3B0aW9uPkQyPC9vcHRpb24+PG9wdGlvbj5EMzwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PjxkaXY+PGxhYmVsPkThuqV1IGhp4buHdSBraMOhYyBiaeG7h3Q8L2xhYmVsPjx0ZXh0YXJlYSBpZD0iZGlmZmVyZW5jZXMiPjwvdGV4dGFyZWE+PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+PGxhYmVsPlbhuqVuIMSR4buBIGvhu7kgdGh14bqtdCBraMOhY2ggcXVhbjwvbGFiZWw+PHRleHRhcmVhIGlkPSJwcm9ibGVtIj48L3RleHRhcmVhPjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxsYWJlbD5M4bqtcCBsdeG6rW4gc8ahIGLhu5kgduG7gSB0w61uaCBoaeG7g24gbmhpw6puPC9sYWJlbD48dGV4dGFyZWEgaWQ9InJlYXNvbmluZyI+PC90ZXh0YXJlYT48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+PGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJydW5Bc3Nlc3NtZW50Ij5DaOG6oXkgxJHDoW5oIGdpw6Egc8ahIGLhu5k8L2J1dHRvbj48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9ImV4cGVydCIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+OC4gQ2h1ecOqbiBnaWEgcsOgIHNvw6F0PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5DaHV5w6puIGdpYSB4w6FjIG5o4bqtbi9jaOG7iW5oIHPhu61hL2LDoWMgYuG7jyB04burbmcgxJHhuqd1IHJhLiDEkMOieSBsw6AgY2hlY2twb2ludCBi4bqvdCBideG7mWMgY+G7p2EgbcO0IGjDrG5oIEh1bWFuLWluLXRoZS1sb29wLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIj48dGFibGU+PHRoZWFkPjx0cj48dGg+SOG6oW5nIG3hu6VjPC90aD48dGg+S+G6v3QgcXXhuqMgaOG7hyB0aOG7kW5nPC90aD48dGg+UXV54bq/dCDEkeG7i25oIGNodXnDqm4gZ2lhPC90aD48dGg+Tmjhuq1uIHjDqXQ8L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9ImV4cGVydEJvZHkiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+PGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJzYXZlUmV2aWV3Ij5MxrB1IHLDoCBzb8OhdDwvYnV0dG9uPjwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgoKICA8c2VjdGlvbiBpZD0icmVwb3J0IiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj45LiBCw6FvIGPDoW8gcGjDom4gdMOtY2ggc8ahIGLhu5k8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIgbm8tcHJpbnQiPlThu5VuZyBo4bujcCBk4buvIGxp4buHdSB04burIHRvw6BuIGLhu5kgcGlwZWxpbmUuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMgbm8tcHJpbnQiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0iZ2VuUmVwb3J0Ij5U4bqhbyBiw6FvIGPDoW88L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJidG4iIG9uY2xpY2s9IndpbmRvdy5wcmludCgpIj5JbiAvIEzGsHUgUERGPC9idXR0b24+PC9kaXY+CiAgICAgIDxkaXYgaWQ9InJlcG9ydENvbnRlbnQiIGNsYXNzPSJyZXBvcnQiPjxkaXYgY2xhc3M9ImVtcHR5Ij5DaMawYSB04bqhbyBiw6FvIGPDoW8uPC9kaXY+PC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CjwvbWFpbj4KPC9kaXY+Cgo8ZGl2IGNsYXNzPSJ3aXphcmRiYXIgbm8tcHJpbnQiPgogIDxkaXYgY2xhc3M9IndpemFyZGlubmVyIj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBiYWNrYnRuIiBpZD0iYmFja0J0biI+4oaQIFF1YXkgbOG6oWk8L2J1dHRvbj4KICAgIDxkaXYgY2xhc3M9IndpemFyZG1ldGEiPjxzdHJvbmcgaWQ9IndpemFyZFRpdGxlIj48L3N0cm9uZz48c3BhbiBpZD0id2l6YXJkSGludCI+PC9zcGFuPjwvZGl2PgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkgbmV4dGJ0biIgaWQ9Im5leHRCdG4iPlRp4bq/cCB04bulYyDihpI8L2J1dHRvbj4KICA8L2Rpdj4KPC9kaXY+Cgo8c2NyaXB0Pgpjb25zdCBTVEVQUz1bCiAge2lkOiJpbnRha2UiLHRpdGxlOiJUaeG6v3Agbmjhuq1uIGjhu5Mgc8ahIixoaW50OiJU4bqjaSBQREYgdsOgIGtp4buDbSB0cmEgZOG7ryBsaeG7h3UgdOG7sSDEkeG7mW5nIHRyw61jaCB4deG6pXQuIn0sCiAge2lkOiJjbGFpbXMiLHRpdGxlOiJZw6p1IGPhuqd1IGLhuqNvIGjhu5kiLGhpbnQ6IkNo4buNbiBjbGFpbSBj4bqnbiBwaMOibiB0w61jaC4ifSwKICB7aWQ6ImZlYXR1cmVzIix0aXRsZToiROG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdCIsaGludDoiVMOhY2ggdsOgIHjDoWMgbmjhuq1uIGZlYXR1cmUgc2V0LiJ9LAogIHtpZDoic2VhcmNoIix0aXRsZToiQ2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdSIsaGludDoiU2luaCBrZXl3b3JkL0lQQy9xdWVyeS4ifSwKICB7aWQ6InByaW9yIix0aXRsZToiVMOgaSBsaeG7h3UgxJHhu5FpIGNo4bupbmciLGhpbnQ6Ik5o4bqtcC9raeG7g20gdHJhIHByaW9yIGFydC4ifSwKICB7aWQ6ImNvbXBhcmUiLHRpdGxlOiJC4bqjbmcgc28gc8OhbmgiLGhpbnQ6Ik1hcCBmZWF0dXJlIHbhu5tpIGV2aWRlbmNlLiJ9LAogIHtpZDoiYXNzZXNzIix0aXRsZToixJDDoW5oIGdpw6Egc8ahIGLhu5kiLGhpbnQ6Ik5vdmVsdHkgdsOgIGludmVudGl2ZSBzdGVwLiJ9LAogIHtpZDoiZXhwZXJ0Iix0aXRsZToiQ2h1ecOqbiBnaWEgcsOgIHNvw6F0IixoaW50OiJFeHBlcnQgdmFsaWRhdGlvbi4ifSwKICB7aWQ6InJlcG9ydCIsdGl0bGU6IkLDoW8gY8OhbyIsaGludDoiVOG7lW5nIGjhu6NwIGvhur90IHF14bqjLiJ9Cl07CmNvbnN0IHN0YXRlPXtzdGVwOjAscGRmOm51bGwscGFnZVRleHQ6W10scGFnZUNvbHVtblRleHQ6W10scGFnZVF1YWxpdHk6W10sYmFkVGV4dFBhZ2VzOltdLG9jclBhZ2VzOnt9LHJhd1RleHQ6IiIsY2xhaW1zVGV4dDoiIixjbGFpbXM6W10sc2VsZWN0ZWQ6MCxmZWF0dXJlczpbXSxjb25maXJtZWQ6ZmFsc2Usc2VhcmNoOltdLHF1ZXJpZXM6W10scHJpb3I6e30sbWF0cml4OltdLGFzc2Vzc21lbnQ6e30scmV2aWV3czowLGNhbmRpZGF0ZXM6W10sYmFja2VuZFVybDoiIixwcm92aWRlcnM6e30sY2xvdWRPY3I6bnVsbCx0ZXNzRGlhZzp7dmllOmZhbHNlLGVuZzpmYWxzZSxlcnJvcjoiIn0sY2xhaW1Tb3VyY2VCeVBhZ2U6e30sZG9jTGFuZzoidW5rbm93biIsZG9jTGFuZ0NvbmZpZGVuY2U6MCxsYW5ndWFnZUJ5UGFnZTp7fSx2aXNpb25MYW5ndWFnZXNCeVBhZ2U6e319Owpjb25zdCAkPWlkPT5kb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CmNvbnN0IGVzYz1zPT4oc3x8IiIpLnJlcGxhY2UoL1smPD4iJ10vZyxtPT4oeyImIjoiJmFtcDsiLCI8IjoiJmx0OyIsIj4iOiImZ3Q7IiwnIic6IiZxdW90OyIsIiciOiImIzAzOTsifVttXSkpOwpjb25zdCBjbGVhbj1zPT4oc3x8IiIpLnJlcGxhY2UoL1x1MDBhZC9nLCIiKS5yZXBsYWNlKC9bIFx0XSsvZywiICIpLnJlcGxhY2UoL1xuWyBcdF0rL2csIlxuIikudHJpbSgpOwpmdW5jdGlvbiBmb2xkVk4ocyl7CiAgcmV0dXJuIChzfHwiIikKICAgIC5ub3JtYWxpemUoIk5GRCIpCiAgICAucmVwbGFjZSgvW1x1MDMwMC1cdTAzNmZdL2csIiIpCiAgICAucmVwbGFjZSgvxJEvZywiZCIpLnJlcGxhY2UoL8SQL2csIkQiKQogICAgLnRvVXBwZXJDYXNlKCk7Cn0KCmNvbnN0IFZJX0hJTlRfV09SRFM9WwogICJzw6FuZyBjaOG6vyIsInnDqnUgY+G6p3UgYuG6o28gaOG7mSIsInF1eSB0csOsbmgiLCJwaMawxqFuZyBwaMOhcCIsImJhbyBn4buTbSIsInRyb25nIMSRw7MiLCJ0aW5oIGThuqd1IiwiZHVuZyBk4buLY2giLAogICJo4buXbiBo4bujcCIsIsSR4buTbmcgbmjhuqV0IiwidGhp4bq/dCBi4buLIiwia2h14bqleSIsInRo4budaSBnaWFuIiwidGh1IMSRxrDhu6NjIiwiY2jhur8gcGjhuqltIiwiYsaw4bubYyIsInBo4buRaSB0cuG7mW4iLCLhu5VuIMSR4buLbmgiLAogICJz4bqjbiB4deG6pXQiLCJ0aMOgbmggcGjhuqduIiwibuG7k25nIMSR4buZIiwibmhp4buHdCDEkeG7mSIsIsSR4buZIOG6qW0iLCJuZ8aw4budaSBu4buZcCDEkcahbiIsIsSR4bqhaSBkaeG7h24iLCJuZ8OgeSBu4buZcCDEkcahbiIKXTsKY29uc3QgRU5fSElOVF9XT1JEUz1bCiAgInBhdGVudCIsImNsYWltcyIsImNsYWltIiwibWV0aG9kIiwicHJvY2VzcyIsImNvbXByaXNpbmciLCJ3aGVyZWluIiwibWl4dHVyZSIsInNvbHV0aW9uIiwiZGV2aWNlIiwic3lzdGVtIiwKICAiY29tcG9zaXRpb24iLCJzdGVwIiwidGVtcGVyYXR1cmUiLCJ0aW1lIiwib2J0YWluZWQiLCJhcHBhcmF0dXMiLCJpbnZlbnRpb24iLCJhcHBsaWNhbnQiLCJhc3NpZ25lZSIsImZpbGVkIgpdOwoKZnVuY3Rpb24gZGV0ZWN0VGV4dExhbmd1YWdlKHRleHQpewogIGNvbnN0IHQ9bm9ybWFsaXplT2NyVGV4dCh0ZXh0fHwiIik7CiAgaWYoIXQudHJpbSgpKSByZXR1cm4ge2xhbmc6InVua25vd24iLGNvbmZpZGVuY2U6MCx2aTowLGVuOjB9OwoKICBjb25zdCBsb3c9dC50b0xvd2VyQ2FzZSgpOwogIGNvbnN0IGNoYXJzPU1hdGgubWF4KDEsdC5sZW5ndGgpOwogIGNvbnN0IHZpU3BlY2lmaWM9KHQubWF0Y2goL1vEg8OixJHDqsO0xqHGsMSCw4LEkMOKw5TGoMavw6DDoeG6o8Oj4bqh4bqx4bqv4bqz4bq14bq34bqn4bql4bqp4bqr4bqtw6jDqeG6u+G6veG6ueG7geG6v+G7g+G7heG7h8Osw63hu4nEqeG7i8Oyw7Phu4/DteG7jeG7k+G7keG7leG7l+G7meG7neG7m+G7n+G7oeG7o8O5w7rhu6fFqeG7peG7q+G7qeG7reG7r+G7seG7s8O94bu34bu54bu1XS9nKXx8W10pLmxlbmd0aDsKCiAgbGV0IHZpPXZpU3BlY2lmaWMqMi40OwogIGxldCBlbj0wOwogIGZvcihjb25zdCB3IG9mIFZJX0hJTlRfV09SRFMpIGlmKGxvdy5pbmNsdWRlcyh3KSkgdmkrPTc7CiAgZm9yKGNvbnN0IHcgb2YgRU5fSElOVF9XT1JEUykgaWYobmV3IFJlZ0V4cChgXFxiJHt3LnJlcGxhY2UoL1suKis/XiR7fSgpfFtcXVxcXS9nLCJcXCQmIil9XFxiYCwiaSIpLnRlc3QodCkpIGVuKz01OwoKICAvLyBWaWV0bmFtZXNlIExhdGluIHRleHQgdHlwaWNhbGx5IGhhcyBhIG1lYW5pbmdmdWwgZGVuc2l0eSBvZiBkaWFjcml0aWNzLgogIHZpKz1NYXRoLm1pbigzMCwodmlTcGVjaWZpYy9jaGFycykqNTAwKTsKCiAgY29uc3Qgd29yZHM9dC5zcGxpdCgvXHMrLykuZmlsdGVyKEJvb2xlYW4pOwogIGNvbnN0IGFzY2lpV29yZHM9d29yZHMuZmlsdGVyKHc9Pi9eW0EtWmEtel1bQS1aYS16XC1dKiQvLnRlc3QodykpLmxlbmd0aDsKICBpZih3b3Jkcy5sZW5ndGg+OCkgZW4rPU1hdGgubWluKDIwLChhc2NpaVdvcmRzL3dvcmRzLmxlbmd0aCkqMTgpOwoKICBjb25zdCB0b3RhbD12aStlbjsKICBpZih0b3RhbDw4KSByZXR1cm4ge2xhbmc6InVua25vd24iLGNvbmZpZGVuY2U6MC4yLHZpLGVufTsKCiAgaWYodmk+PWVuKjEuMzUpIHJldHVybiB7bGFuZzoidmkiLGNvbmZpZGVuY2U6TWF0aC5taW4oLjk5LHZpL01hdGgubWF4KDEsdG90YWwpKSx2aSxlbn07CiAgaWYoZW4+PXZpKjEuMzUpIHJldHVybiB7bGFuZzoiZW4iLGNvbmZpZGVuY2U6TWF0aC5taW4oLjk5LGVuL01hdGgubWF4KDEsdG90YWwpKSx2aSxlbn07CiAgcmV0dXJuIHtsYW5nOiJtaXhlZCIsY29uZmlkZW5jZTouNTUsdmksZW59Owp9CgpmdW5jdGlvbiBjaG9vc2VEb2N1bWVudExhbmd1YWdlKCl7CiAgbGV0IHZpPTAsZW49MCxtaXhlZD0wLHdlaWdodD0wOwogIGZvcihsZXQgaT0wO2k8c3RhdGUucGFnZVRleHQubGVuZ3RoO2krKyl7CiAgICBjb25zdCBxPXN0YXRlLnBhZ2VRdWFsaXR5W2ldfHwwOwogICAgaWYocTw0NSkgY29udGludWU7CiAgICBjb25zdCBkPWRldGVjdFRleHRMYW5ndWFnZShzdGF0ZS5wYWdlVGV4dFtpXSk7CiAgICBjb25zdCB3PU1hdGgubWF4KC4zLHEvMTAwKTsKICAgIGlmKGQubGFuZz09PSJ2aSIpIHZpKz1kLmNvbmZpZGVuY2UqdzsKICAgIGVsc2UgaWYoZC5sYW5nPT09ImVuIikgZW4rPWQuY29uZmlkZW5jZSp3OwogICAgZWxzZSBpZihkLmxhbmc9PT0ibWl4ZWQiKSBtaXhlZCs9ZC5jb25maWRlbmNlKnc7CiAgICB3ZWlnaHQrPXc7CiAgICBzdGF0ZS5sYW5ndWFnZUJ5UGFnZVtpKzFdPWQ7CiAgfQogIGlmKHZpPmVuKjEuMzUgJiYgdmk+bWl4ZWQqLjgpewogICAgc3RhdGUuZG9jTGFuZz0idmkiOyBzdGF0ZS5kb2NMYW5nQ29uZmlkZW5jZT1NYXRoLm1pbiguOTksdmkvTWF0aC5tYXgoMSx2aStlbittaXhlZCkpOwogIH1lbHNlIGlmKGVuPnZpKjEuMzUgJiYgZW4+bWl4ZWQqLjgpewogICAgc3RhdGUuZG9jTGFuZz0iZW4iOyBzdGF0ZS5kb2NMYW5nQ29uZmlkZW5jZT1NYXRoLm1pbiguOTksZW4vTWF0aC5tYXgoMSx2aStlbittaXhlZCkpOwogIH1lbHNlIGlmKHZpK2VuK21peGVkPjApewogICAgc3RhdGUuZG9jTGFuZz0ibWl4ZWQiOyBzdGF0ZS5kb2NMYW5nQ29uZmlkZW5jZT0uNTU7CiAgfWVsc2V7CiAgICBzdGF0ZS5kb2NMYW5nPSJ1bmtub3duIjsgc3RhdGUuZG9jTGFuZ0NvbmZpZGVuY2U9MDsKICB9CiAgcmV0dXJuIHtsYW5nOnN0YXRlLmRvY0xhbmcsY29uZmlkZW5jZTpzdGF0ZS5kb2NMYW5nQ29uZmlkZW5jZX07Cn0KCmZ1bmN0aW9uIGxhbmd1YWdlTGFiZWwobGFuZyl7CiAgcmV0dXJuIGxhbmc9PT0idmkiPyJUaeG6v25nIFZp4buHdCI6bGFuZz09PSJlbiI/IkVuZ2xpc2giOmxhbmc9PT0ibWl4ZWQiPyJWaeG7h3QgKyBBbmgiOiJDaMawYSB4w6FjIMSR4buLbmgiOwp9CgpmdW5jdGlvbiBsYW5ndWFnZUZpdFNjb3JlKHRleHQsdGFyZ2V0KXsKICBjb25zdCBkPWRldGVjdFRleHRMYW5ndWFnZSh0ZXh0KTsKICBpZih0YXJnZXQ9PT0idmkiKXsKICAgIGlmKGQubGFuZz09PSJ2aSIpIHJldHVybiAyOCpkLmNvbmZpZGVuY2U7CiAgICBpZihkLmxhbmc9PT0ibWl4ZWQiKSByZXR1cm4gMTA7CiAgICBpZihkLmxhbmc9PT0iZW4iKSByZXR1cm4gLTIwOwogIH0KICBpZih0YXJnZXQ9PT0iZW4iKXsKICAgIGlmKGQubGFuZz09PSJlbiIpIHJldHVybiAyNSpkLmNvbmZpZGVuY2U7CiAgICBpZihkLmxhbmc9PT0ibWl4ZWQiKSByZXR1cm4gODsKICAgIGlmKGQubGFuZz09PSJ2aSIpIHJldHVybiAtMTg7CiAgfQogIGlmKHRhcmdldD09PSJtaXhlZCIpIHJldHVybiBkLmxhbmc9PT0ibWl4ZWQiPzE2OjU7CiAgcmV0dXJuIDA7Cn0KCmZ1bmN0aW9uIGNsYWltTWFya2VySW5mbyh0ZXh0KXsKICBjb25zdCBmPWZvbGRWTih0ZXh0KTsKICBjb25zdCBwYXR0ZXJucz1bCiAgICAvWUVVXHMqQ0FVXHMqQkFPXHMqSE8vLAogICAgL05IVU5HXHMqRElFVVxzKllFVVxzKkNBVVxzKkJBT1xzKkhPLywKICAgIC9XSEFUXHMrSVNccytDTEFJTUVEXHMrSVNccyo6Ki8sCiAgICAvSVxzKlwvP1xzKldFXHMrQ0xBSU1ccyo6Ki8sCiAgICAvXGJDTEFJTVM/XHMqOiovCiAgXTsKICBmb3IoY29uc3QgcmUgb2YgcGF0dGVybnMpewogICAgY29uc3QgbT1mLm1hdGNoKHJlKTsKICAgIGlmKG0pIHJldHVybiB7aW5kZXg6bS5pbmRleCxlbmQ6bS5pbmRleCttWzBdLmxlbmd0aH07CiAgfQogIHJldHVybiBudWxsOwp9CmZ1bmN0aW9uIGxvb2tzTGlrZUNsYWltUGFnZSh0ZXh0KXsKICBjb25zdCBmPWZvbGRWTih0ZXh0KTsKICByZXR1cm4gLyg/Ol58XG58XHMpMVxzKltcLlwpXVxzKihRVVkgVFJJTkh8UEhVT05HIFBIQVB8U0FOIFBIQU18VEhJRVQgQkl8SEUgVEhPTkd8Q0hFIFBIQU18QVxzfEFOXHN8VEhFXHMpLy50ZXN0KGYpCiAgICAmJiAvKEJBTyBHT018Q09NUFJJU0lOR3xDT01QUklTRVN8R09NIENBQyBCVU9DfElOQ0xVRElORykvLnRlc3QoZik7Cn0KZnVuY3Rpb24gZXh0cmFjdENsYWltc1RhaWwodGV4dCl7CiAgaWYoIXRleHQpIHJldHVybiAiIjsKICBjb25zdCBtYXJrPWNsYWltTWFya2VySW5mbyh0ZXh0KTsKICBpZihtYXJrKSByZXR1cm4gdHJ1bmNhdGVDbGFpbUF0RmlndXJlKGNsZWFuKHRleHQuc2xpY2UobWFyay5lbmQpKSkuc2xpY2UoMCw4MDAwMCk7CiAgY29uc3QgZj1mb2xkVk4odGV4dCk7CiAgY29uc3QgcmU9Lyg/Ol58XG58XHMpMVxzKltcLlwpXVxzKihRVVkgVFJJTkh8UEhVT05HIFBIQVB8U0FOIFBIQU18VEhJRVQgQkl8SEUgVEhPTkd8Q0hFIFBIQU18QVxzfEFOXHN8VEhFXHMpLzsKICBjb25zdCBtbT1mLm1hdGNoKHJlKTsKICByZXR1cm4gbW0gPyB0cnVuY2F0ZUNsYWltQXRGaWd1cmUoY2xlYW4odGV4dC5zbGljZShtbS5pbmRleCkpKS5zbGljZSgwLDgwMDAwKSA6ICIiOwp9CmZ1bmN0aW9uIG5vcm1hbGl6ZU9jclRleHQocyl7CiAgLy8gdjEwOiBraMO0bmcgdOG7sSBu4buRaSBkw7JuZyB0w7l5IHRp4buHbiBu4buvYS4gQ2jhu4kgY2h14bqpbiBow7NhIFVuaWNvZGUva2hv4bqjbmcgdHLhuq9uZy4KICAvLyDEkGnhu4F1IG7DoHkgdHLDoW5oIGJp4bq/biB2xINuIGLhuqNuIFZp4buHdCDEkcO6bmcgdGjDoG5oIGNodeG7l2kgZMOtbmggbmjGsCAiTuG6ollN4bqmTSIgaG/hurdjIGvDqW8gZm9vdGVyIHbDoG8gdGl0bGUuCiAgcmV0dXJuIFN0cmluZyhzfHwiIikKICAgIC5yZXBsYWNlKC9cdUZFRkYvZywiIikKICAgIC5yZXBsYWNlKC9cdTAwYWQvZywiIikKICAgIC5yZXBsYWNlKC9bXHUyMDBCLVx1MjAwRFx1MjA2MF0vZywiIikKICAgIC5ub3JtYWxpemUoIk5GQyIpCiAgICAucmVwbGFjZSgvW+KAnOKAnV0vZywnIicpLnJlcGxhY2UoL1vigJjigJldL2csIiciKQogICAgLnJlcGxhY2UoL1vigJDigJHigJLigJPigJRdL2csIi0iKQogICAgLnJlcGxhY2UoL1x1MDBhMC9nLCIgIikKICAgIC5yZXBsYWNlKC9bIFx0XSsvZywiICIpCiAgICAucmVwbGFjZSgvWyBcdF0rXG4vZywiXG4iKQogICAgLnJlcGxhY2UoL1xuWyBcdF0rL2csIlxuIikKICAgIC5yZXBsYWNlKC9ccysoWywuOzolXCldKS9nLCIkMSIpCiAgICAucmVwbGFjZSgvKFwoKVxzKy9nLCIkMSIpCiAgICAucmVwbGFjZSgvKFxkKVxzKixccyooXGQpL2csIiQxLCQyIikKICAgIC5yZXBsYWNlKC9cbnszLH0vZywiXG5cbiIpCiAgICAudHJpbSgpOwp9CgpmdW5jdGlvbiBzdHJpcFBkZkFydGlmYWN0cyhzKXsKICBsZXQgdD1ub3JtYWxpemVPY3JUZXh0KHMpOwoKICAvLyBQYWdlIGNvdW50ZXJzIC8gZm9vdGVyIGFydGlmYWN0cyBjb21tb25seSBlbWl0dGVkIGJ5IFZpZXRuYW1lc2UgcGF0ZW50IFBERnMuCiAgdD10LnJlcGxhY2UoLyg/OlxiXGR7MywxMH1ccytcZHsxLDN9XHMqXC9ccypcZHsxLDN9XGJbXHMsOzpdKil7Mix9L2csIiAiKTsKICB0PXQucmVwbGFjZSgvXGJcZHszLDEwfVxzK1xkezEsM31ccypcL1xzKlxkezEsM31cYi9nLCIgIik7CiAgdD10LnJlcGxhY2UoLyg/OlxiXGR7MSwzfVxzKlwvXHMqXGR7MywxMH1cYltccyw7Ol0qKXsyLH0vZywiICIpOwogIHQ9dC5yZXBsYWNlKC9eXHMqXGR7MSwzfVxzKlwvXHMqXGR7MSwzfVxzKiQvZ20sIiIpOwogIHQ9dC5yZXBsYWNlKC9eXHMqKD86UGFnZXxUcmFuZylccytcZCsoPzpccypcL1xzKlxkKyk/XHMqJC9nbWksIiIpOwoKICAvLyBDb2xsYXBzZSBvbmx5IGhvcml6b250YWwgbm9pc2U7IGtlZXAgc2VtYW50aWMgbGluZSBicmVha3MuCiAgcmV0dXJuIHQucmVwbGFjZSgvWyBcdF17Mix9L2csIiAiKS5yZXBsYWNlKC9cbnszLH0vZywiXG5cbiIpLnRyaW0oKTsKfQoKZnVuY3Rpb24gdGV4dExheWVyUXVhbGl0eVNjb3JlKHRleHQpewogIGNvbnN0IHQ9c3RyaXBQZGZBcnRpZmFjdHModGV4dCk7IGlmKGxvb2tzTGlrZUxlZ2FjeUVuY29kaW5nKHQpKSByZXR1cm4gNTsKICBpZighdCkgcmV0dXJuIDA7CgogIGNvbnN0IGNoYXJzPXQubGVuZ3RoOwogIGNvbnN0IGxldHRlcnM9KHQubWF0Y2goL1xwe0x9L2d1KXx8W10pLmxlbmd0aDsKICBjb25zdCBkaWdpdHM9KHQubWF0Y2goL1xkL2cpfHxbXSkubGVuZ3RoOwogIGNvbnN0IHdlaXJkPSh0Lm1hdGNoKC9b77+94pah4page308Pnx+XmBdL2cpfHxbXSkubGVuZ3RoOwogIGNvbnN0IHNsYXNoU2VxPSh0Lm1hdGNoKC9cZCtccypcL1xzKlxkKy9nKXx8W10pLmxlbmd0aDsKICBjb25zdCB3b3Jkcz10LnNwbGl0KC9ccysvKS5maWx0ZXIoQm9vbGVhbik7CiAgY29uc3Qgc2hvcnRXb3Jkcz13b3Jkcy5maWx0ZXIodz0+dy5sZW5ndGg8PTEpLmxlbmd0aDsKCiAgbGV0IHNjb3JlPTA7CiAgc2NvcmUrPU1hdGgubWluKDQwLCBjaGFycy8zNSk7CiAgc2NvcmUrPU1hdGgubWluKDI1LCAobGV0dGVycy9NYXRoLm1heCgxLGNoYXJzKSkqNDUpOwogIGlmKC9bxIPDosSRw6rDtMahxrDEgsOCxJDDisOUxqDGr10vLnRlc3QodCkpIHNjb3JlKz04OwogIGlmKC9bw6DDoeG6o8Oj4bqh4bqx4bqv4bqz4bq14bq34bqn4bql4bqp4bqr4bqtw6jDqeG6u+G6veG6ueG7geG6v+G7g+G7heG7h8Osw63hu4nEqeG7i8Oyw7Phu4/DteG7jeG7k+G7keG7leG7l+G7meG7neG7m+G7n+G7oeG7o8O5w7rhu6fFqeG7peG7q+G7qeG7reG7r+G7seG7s8O94bu34bu54bu1XS9pLnRlc3QodCkpIHNjb3JlKz04OwogIGlmKC9cYig/OnPDoW5nIGNo4bq/fHnDqnUgY+G6p3UgYuG6o28gaOG7mXxxdXkgdHLDrG5ofHBoxrDGoW5nIHBow6FwfGJhbyBn4buTbXx0cm9uZyDEkcOzfHRoaeG6v3QgYuG7i3xo4buHIHRo4buRbmcpXGIvaS50ZXN0KHQpKSBzY29yZSs9MTI7CgogIHNjb3JlLT1NYXRoLm1pbigzNSx3ZWlyZCo1KTsKICBzY29yZS09TWF0aC5taW4oMzAsc2xhc2hTZXEqNSk7CiAgaWYoZGlnaXRzL01hdGgubWF4KDEsY2hhcnMpPi4yOCkgc2NvcmUtPTE4OwogIGlmKHNob3J0V29yZHMvTWF0aC5tYXgoMSx3b3Jkcy5sZW5ndGgpPi4yNSkgc2NvcmUtPTE1OwoKICByZXR1cm4gTWF0aC5tYXgoMCxNYXRoLm1pbigxMDAsTWF0aC5yb3VuZChzY29yZSkpKTsKfQoKCmZ1bmN0aW9uIHJlcGFpckNlcnRhaW5Wbk9jcih0ZXh0KXsKICAvLyBDaOG7iSBz4butYSBs4buXaSBPQ1IgcuG6pXQgxJFp4buDbiBow6xuaCB0aGVvIG5n4buvIGPhuqNuaCBr4bu5IHRodeG6rXQsIGtow7RuZyBzw6FuZyB0w6FjIGNsYWltLgogIHJldHVybiBub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKQogICAgLnJlcGxhY2UoL1xiKD86dOG7iW5ofHTDrW5ofHTDrG5oKVxzK2Thuqd1XGIvZ2ksInRpbmggZOG6p3UiKQogICAgLnJlcGxhY2UoL1xiZHVuZ1xzK8SR4buLY2hcYi9naSwiZHVuZyBk4buLY2giKQogICAgLnJlcGxhY2UoL1xiaCg/OuG7k258w7RuKVxzK2jhu6NwXGIvZ2ksImjhu5duIGjhu6NwIikKICAgIC5yZXBsYWNlKC9cYm7huqNbecO9XT9ccypt4bqnbVxiL2dpLCJu4bqjeSBt4bqnbSIpCiAgICAucmVwbGFjZSgvXGJraHVkW3nDvV1cYi9naSwia2h14bqleSIpCiAgICAucmVwbGFjZSgvXGJraHVb4bqp4bqjYV15XHMrYig/OsSDfGF8aSluZ1xzK3Thu6tcYi9naSwia2h14bqleSBi4bqxbmcgdOG7qyIpCiAgICAucmVwbGFjZSgvXGJraHVb4bqp4bqjYV15XHMrYmluZ1xzK3Thu6tcYi9naSwia2h14bqleSBi4bqxbmcgdOG7qyIpCiAgICAucmVwbGFjZSgvXGJ0aW5oIGThuqd1XHMrc2FccytqYXZhXGIvZ2ksInRpbmggZOG6p3Ugc+G6oyBqYXZhIikKICAgIC5yZXBsYWNlKC9cYnRpbmggZOG6p3VccytvYWlccytoxrDGoW5nXGIvZ2ksInRpbmggZOG6p3Ugb+G6o2kgaMawxqFuZyIpCiAgICAucmVwbGFjZSgvXGJr4bq/dFxzK3F1YVxiL2dpLCJr4bq/dCBxdeG6oyIpCiAgICAucmVwbGFjZSgvXGJob25ccyto4bujcFxiL2dpLCJo4buXbiBo4bujcCIpCiAgICAubm9ybWFsaXplKCJORkMiKTsKfQoKZnVuY3Rpb24gdHJpbURpYWdyYW1Ob2lzZSh0ZXh0KXsKICBjb25zdCBsaW5lcz1ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKS5zcGxpdCgvXG4rLykubWFwKHg9PngudHJpbSgpKS5maWx0ZXIoQm9vbGVhbik7CiAgaWYobGluZXMubGVuZ3RoPDgpIHJldHVybiBsaW5lcy5qb2luKCJcbiIpOwoKICBsZXQgY3V0PWxpbmVzLmxlbmd0aDsKICBsZXQgc2VlbkNsYWltU2VudGVuY2U9ZmFsc2U7CgogIGZvcihsZXQgaT0wO2k8bGluZXMubGVuZ3RoO2krKyl7CiAgICBjb25zdCBsaW5lPWxpbmVzW2ldOwogICAgaWYoL1suO10kLy50ZXN0KGxpbmUpICYmIC8oPzp0aHUgxJHGsOG7o2N8b2J0YWluZWR8Y29tcHJpc2luZ3x3aGVyZWlufGJhbyBn4buTbXx0cm9uZyDEkcOzKS9pLnRlc3QobGluZXMuc2xpY2UoTWF0aC5tYXgoMCxpLTQpLGkrMSkuam9pbigiICIpKSl7CiAgICAgIHNlZW5DbGFpbVNlbnRlbmNlPXRydWU7CiAgICB9CiAgICBpZighc2VlbkNsYWltU2VudGVuY2UpIGNvbnRpbnVlOwoKICAgIGNvbnN0IHdpbmRvdz1saW5lcy5zbGljZShpLE1hdGgubWluKGxpbmVzLmxlbmd0aCxpKzcpKTsKICAgIGlmKHdpbmRvdy5sZW5ndGg8NCkgY29udGludWU7CgogICAgbGV0IG5vaXN5PTA7CiAgICBmb3IoY29uc3QgdyBvZiB3aW5kb3cpewogICAgICBpZih3Lmxlbmd0aDwyOCkgbm9pc3krKzsKICAgICAgaWYoL15cZHsyLDR9W0EtWmEtel0/JC8udGVzdCh3KSkgbm9pc3krKzsKICAgICAgaWYoKHcubWF0Y2goL1t8XFwvXz48fl0vZyl8fFtdKS5sZW5ndGg+PTEpIG5vaXN5Kys7CiAgICB9CiAgICBpZihub2lzeT49Nil7CiAgICAgIGN1dD1pOwogICAgICBicmVhazsKICAgIH0KICB9CiAgcmV0dXJuIGxpbmVzLnNsaWNlKDAsY3V0KS5qb2luKCJcbiIpOwp9CgpmdW5jdGlvbiB0cnVuY2F0ZUNsYWltQXRGaWd1cmUodGV4dCl7CiAgbGV0IHQ9c3RyaXBQZGZBcnRpZmFjdHMocmVwYWlyQ2VydGFpblZuT2NyKHRleHR8fCIiKSk7CgogIC8vIEZsZXhpYmxlIGZpZ3VyZSBtYXJrZXJzLCBpbmNsdWRpbmcgT0NSIGZvcm1zIHN1Y2ggYXMgIkjDjE5cbkgxIiBvciAiSCBJIE4gSCAxIi4KICBjb25zdCBzdG9wcz1bCiAgICAvKD86XnxcbilccypIXHMqW8OMScON4buIxKjhu4pdP1xzKk5ccypIXHMqW1xzOi5fLV0qXGQrXGIvaW0sCiAgICAvKD86XnxcbilccypIw4xOXHMqSFxzKlxkK1xiL2ltLAogICAgLyg/Ol58XG4pXHMqSElOXHMqSFxzKlxkK1xiL2ltLAogICAgLyg/Ol58XG4pXHMqSMOMTkhccypcZCtcYi9pbSwKICAgIC8oPzpefFxuKVxzKkhJTkhccypcZCtcYi9pbSwKICAgIC8oPzpefFxuKVxzKkZJRyg/OlVSRSk/XC4/XHMqXGQrXGIvaW0sCiAgICAvKD86XnxcbilccyooPzpNw5QgVOG6oiBIw4xOSCBW4bq8fELhuqJOIFbhurx8RFJBV0lOR1M/KVxiL2ltCiAgXTsKCiAgbGV0IGN1dD10Lmxlbmd0aDsKICBmb3IoY29uc3QgcmUgb2Ygc3RvcHMpewogICAgY29uc3QgbW09dC5tYXRjaChyZSk7CiAgICBpZihtbSAmJiBtbS5pbmRleD44MCkgY3V0PU1hdGgubWluKGN1dCxtbS5pbmRleCk7CiAgfQogIHQ9dC5zbGljZSgwLGN1dCk7CgogIC8vIFNlY29uZGFyeSBkZWZlbnNlIHdoZW4gT0NSIG1pc3NlcyB0aGUgZmlndXJlIGhlYWRpbmcgZW50aXJlbHkuCiAgdD10cmltRGlhZ3JhbU5vaXNlKHQpOwoKICB0PXQucmVwbGFjZSgvXG5ccypcZHsyLDh9XHMrXGR7MSwzfVxzKlwvXHMqXGR7MSwzfVxzKiQvZywiIik7CiAgdD10LnJlcGxhY2UoL1xuXHMqXGR7MSw0fVxzKiQvZywiIik7CiAgcmV0dXJuIHQudHJpbSgpLm5vcm1hbGl6ZSgiTkZDIik7Cn0KCmZ1bmN0aW9uIGxvb2tzTGlrZUxlZ2FjeUVuY29kaW5nKHRleHQpewogIGNvbnN0IHQ9U3RyaW5nKHRleHR8fCIiKTsKICByZXR1cm4gLyg/OsOxYcOqbmd8a3nDuXzDsWllw6B1fHBow7bDtG5nfHRyw6xuaHx2YcOqbnxow7bDtMO5bmd8w7HDtsO0w69jfGJhw6huZ3xjYcO5Y2h8c2HDu258eHVhw6F0KS9pLnRlc3QodCkKICAgIHx8ICh0Lm1hdGNoKC9b77+94pah4pagXS9nKXx8W10pLmxlbmd0aD49MjsKfQoKZnVuY3Rpb24gdm5PY3JRdWFsaXR5KHRleHQpewogIGNvbnN0IHQ9dHJ1bmNhdGVDbGFpbUF0RmlndXJlKHRleHR8fCIiKTsKICBpZighdCkgcmV0dXJuIDA7CiAgbGV0IHNjb3JlPXRleHRMYXllclF1YWxpdHlTY29yZSh0KTsKCiAgY29uc3QgZj1mb2xkVk4odCkudG9Mb3dlckNhc2UoKTsKICBjb25zdCBwYXRlbnRXb3Jkcz1bCiAgICAicXV5IHRyaW5oIiwicGh1b25nIHBoYXAiLCJ5ZXUgY2F1IGJhbyBobyIsImJhbyBnb20iLCJ0cm9uZyBkbyIsCiAgICAidGluaCBkYXUiLCJkdW5nIGRpY2giLCJob24gaG9wIiwiZG9uZyBuaGF0IiwidGhpZXQgYmkiLCJraHVheSIKICBdOwogIGZvcihjb25zdCB3IG9mIHBhdGVudFdvcmRzKSBpZihmLmluY2x1ZGVzKHcpKSBzY29yZSs9NTsKCiAgc2NvcmUtPU1hdGgubWluKDMwLCh0Lm1hdGNoKC9cYig/OnThu4luaCBk4bqndXx0w61uaCBk4bqndXxkdW5nIMSR4buLY2h8aOG7k24gaOG7o3ApXGIvZ2kpfHxbXSkubGVuZ3RoKjYpOwogIHNjb3JlLT1NYXRoLm1pbigzMCwodC5tYXRjaCgvXGQrXHMqXC9ccypcZCsvZyl8fFtdKS5sZW5ndGgqNSk7CiAgaWYoLyg/Ol58XG4pXHMqKD86SMOMTkh8SElOSHxGSUdVUkV8RklHXC4pXHMqXGQrL2ltLnRlc3QodCkpIHNjb3JlLT00NTsKICBpZihsb29rc0xpa2VMZWdhY3lFbmNvZGluZyh0KSkgc2NvcmUtPTM1OwoKICByZXR1cm4gTWF0aC5tYXgoMCxNYXRoLm1pbigxMDAsTWF0aC5yb3VuZChzY29yZSkpKTsKfQoKZnVuY3Rpb24gcmVuZGVyVGVzc0RpYWcoKXsKICBjb25zdCBlbD0kKCJ0ZXNzRGlhZyIpOwogIGlmKCFlbCkgcmV0dXJuOwogIGNvbnN0IGQ9c3RhdGUudGVzc0RpYWd8fHt9OwogIGNvbnN0IGxhbmc9YE5nw7RuIG5n4buvIHTDoGkgbGnhu4d1OiA8c3Ryb25nPiR7bGFuZ3VhZ2VMYWJlbChzdGF0ZS5kb2NMYW5nKX08L3N0cm9uZz4ke3N0YXRlLmRvY0xhbmdDb25maWRlbmNlP2AgKCR7TWF0aC5yb3VuZChzdGF0ZS5kb2NMYW5nQ29uZmlkZW5jZSoxMDApfSUpYDoiIn1gOwoKICBpZihkLmVycm9yKXsKICAgIGVsLmlubmVySFRNTD1gJHtsYW5nfTxicj48c3BhbiBjbGFzcz0iYmFja2VuZC1iYWQiPk9DUiBsYW5ndWFnZSBwYWNrIGzhu5dpOjwvc3Bhbj4gJHtlc2MoZC5lcnJvcil9YDsKICAgIHJldHVybjsKICB9CiAgY29uc3QgdmllPWQudmllPyLinJMgdmllLnRyYWluZWRkYXRhIjoi4oCmIHZpZS50cmFpbmVkZGF0YSI7CiAgY29uc3QgZW5nPWQuZW5nPyLinJMgZW5nLnRyYWluZWRkYXRhIjoi4oCmIGVuZy50cmFpbmVkZGF0YSI7CiAgZWwuaW5uZXJIVE1MPWAke2xhbmd9PGJyPlRlc3NlcmFjdC5qcyA1LjEuMSDCtyBhZGFwdGl2ZSBsYW5ndWFnZSBtb2RlIMK3ICR7dmllfSDCtyAke2VuZ30gwrcgVW5pY29kZSBORkNgOwp9CgpmdW5jdGlvbiBjbGVhbk1ldGFWYWx1ZShzKXsKICBsZXQgdD1zdHJpcFBkZkFydGlmYWN0cyhzKQogICAgLnJlcGxhY2UoL15ccypbXChcW10/XGR7Mn1bXClcXV0/XHMqLywiIikKICAgIC5yZXBsYWNlKC9ccysvZywiICIpCiAgICAudHJpbSgpOwogIHJldHVybiB0Owp9CgpmdW5jdGlvbiBzYW5pdGl6ZVBhdGVudFRpdGxlKHMpewogIGxldCB0PWNsZWFuTWV0YVZhbHVlKHMpCiAgICAucmVwbGFjZSgvXGIoPzpQYWdlfFRyYW5nKVxzK1xkKyg/OlwvXGQrKT9cYi9naSwiIikKICAgIC5yZXBsYWNlKC8oPzpcYlxkezMsMTB9XHMrXGR7MSwzfVwvXGR7MSwzfVxiXHMqKSsvZywiIikKICAgIC5yZXBsYWNlKC9ccysvZywiICIpCiAgICAudHJpbSgpOwoKICAvLyBSZWplY3Qgb2J2aW91c2x5IHBvbGx1dGVkIHRpdGxlcyByYXRoZXIgdGhhbiBwb2lzb25pbmcgc2VhcmNoLgogIGNvbnN0IHNsYXNoPSh0Lm1hdGNoKC9cZCtccypcL1xzKlxkKy9nKXx8W10pLmxlbmd0aDsKICBjb25zdCBkaWdpdFJhdGlvPSh0Lm1hdGNoKC9cZC9nKXx8W10pLmxlbmd0aC9NYXRoLm1heCgxLHQubGVuZ3RoKTsKICBpZihzbGFzaD49MiB8fCBkaWdpdFJhdGlvPi4zMCkgcmV0dXJuICIiOwogIHJldHVybiB0LnNsaWNlKDAsMjYwKTsKfQoKZnVuY3Rpb24gY2FudmFzVG9CYXNlNjRKcGVnKGNhbnZhcyxxdWFsaXR5PS45KXsKICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUscmVqZWN0KT0+ewogICAgY2FudmFzLnRvQmxvYihhc3luYyBibG9iPT57CiAgICAgIGlmKCFibG9iKSByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcigiS2jDtG5nIHThuqFvIMSRxrDhu6NjIOG6o25oIE9DUi4iKSk7CiAgICAgIGNvbnN0IGJ1Zj1hd2FpdCBibG9iLmFycmF5QnVmZmVyKCk7CiAgICAgIGNvbnN0IGJ5dGVzPW5ldyBVaW50OEFycmF5KGJ1Zik7CiAgICAgIGxldCBiaW49IiI7CiAgICAgIGNvbnN0IGNodW5rPTB4ODAwMDsKICAgICAgZm9yKGxldCBpPTA7aTxieXRlcy5sZW5ndGg7aSs9Y2h1bmspewogICAgICAgIGJpbis9U3RyaW5nLmZyb21DaGFyQ29kZSguLi5ieXRlcy5zdWJhcnJheShpLE1hdGgubWluKGkrY2h1bmssYnl0ZXMubGVuZ3RoKSkpOwogICAgICB9CiAgICAgIHJlc29sdmUoYnRvYShiaW4pKTsKICAgIH0sImltYWdlL2pwZWciLHF1YWxpdHkpOwogIH0pOwp9Cgphc3luYyBmdW5jdGlvbiBjbG91ZFZpc2lvbk9jcihjYW52YXMpewogIGlmKHN0YXRlLmNsb3VkT2NyPT09ZmFsc2UpIHJldHVybiBudWxsOwogIHRyeXsKICAgIGNvbnN0IGltYWdlX2Jhc2U2ND1hd2FpdCBjYW52YXNUb0Jhc2U2NEpwZWcoY2FudmFzLC45Mik7CiAgICBjb25zdCByPWF3YWl0IGZldGNoKCIvYXBpL29jciIsewogICAgICBtZXRob2Q6IlBPU1QiLAogICAgICBoZWFkZXJzOnsiY29udGVudC10eXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LAogICAgICBib2R5OkpTT04uc3RyaW5naWZ5KHtpbWFnZV9iYXNlNjR9KQogICAgfSk7CiAgICBjb25zdCBkPWF3YWl0IHIuanNvbigpLmNhdGNoKCgpPT4oe30pKTsKICAgIGlmKHIuc3RhdHVzPT09NTAxIHx8IGQuY29kZT09PSJWSVNJT05fTk9UX0NPTkZJR1VSRUQiKXsKICAgICAgc3RhdGUuY2xvdWRPY3I9ZmFsc2U7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogICAgaWYoIXIub2sgfHwgIWQub2spIHRocm93IG5ldyBFcnJvcihkLmVycm9yfHwoIk9DUiBIVFRQICIrci5zdGF0dXMpKTsKICAgIHN0YXRlLmNsb3VkT2NyPXRydWU7CiAgICByZXR1cm4gewogICAgICB0ZXh0Om5vcm1hbGl6ZU9jclRleHQoZC50ZXh0fHwiIiksCiAgICAgIGxhbmd1YWdlczpBcnJheS5pc0FycmF5KGQubGFuZ3VhZ2VzKT9kLmxhbmd1YWdlczpbXQogICAgfTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLndhcm4oIkNsb3VkIE9DUiBmYWxsYmFjazoiLGUpOwogICAgcmV0dXJuIG51bGw7CiAgfQp9CgpmdW5jdGlvbiBmb3JtYXRDbGFpbUZvckRpc3BsYXkocyl7CiAgY29uc3QgdD10cnVuY2F0ZUNsYWltQXRGaWd1cmUocmVwYWlyQ2VydGFpblZuT2NyKHMpKQogICAgLnJlcGxhY2UoL1xzKihcKFtpdnhsY2RtXStcKSlccyovaWcsIlxuJDEgIikKICAgIC5yZXBsYWNlKC9ccysodsOgKVxzKyg/PVwoW2l2eGxjZG1dK1wpKS9pZywiXG4kMSAiKTsKICByZXR1cm4gdC50cmltKCk7Cn0KCgpmdW5jdGlvbiByZW5kZXJQcm9jZXNzKCl7CiAgJCgicHJvY2VzcyIpLmlubmVySFRNTD1TVEVQUy5tYXAoKHMsaSk9PmA8ZGl2IGNsYXNzPSJwcm9jZXNzLWl0ZW0gJHtpPT09c3RhdGUuc3RlcD8iYWN0aXZlIjppPHN0YXRlLnN0ZXA/ImRvbmUiOiIifSI+PHNwYW4gY2xhc3M9Im4iPiR7aTxzdGF0ZS5zdGVwPyLinJMiOmkrMX08L3NwYW4+PHNwYW4+JHtzLnRpdGxlfTwvc3Bhbj48L2Rpdj5gKS5qb2luKCIiKTsKfQpmdW5jdGlvbiBzaG93U3RlcChpKXsKICBzdGF0ZS5zdGVwPU1hdGgubWF4KDAsTWF0aC5taW4oU1RFUFMubGVuZ3RoLTEsaSkpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi5zZWN0aW9uIikuZm9yRWFjaCh4PT54LmNsYXNzTGlzdC5yZW1vdmUoImFjdGl2ZSIpKTsKICAkKFNURVBTW3N0YXRlLnN0ZXBdLmlkKS5jbGFzc0xpc3QuYWRkKCJhY3RpdmUiKTsKICAkKCJwYWdlVGl0bGUiKS50ZXh0Q29udGVudD1TVEVQU1tzdGF0ZS5zdGVwXS50aXRsZTsKICAkKCJwYWdlU3ViIikudGV4dENvbnRlbnQ9U1RFUFNbc3RhdGUuc3RlcF0uaGludDsKICAkKCJ3aXphcmRUaXRsZSIpLnRleHRDb250ZW50PWBCxrDhu5tjICR7c3RhdGUuc3RlcCsxfS8ke1NURVBTLmxlbmd0aH0gwrcgJHtTVEVQU1tzdGF0ZS5zdGVwXS50aXRsZX1gOwogICQoIndpemFyZEhpbnQiKS50ZXh0Q29udGVudD1TVEVQU1tzdGF0ZS5zdGVwXS5oaW50OwogICQoImJhY2tCdG4iKS5zdHlsZS52aXNpYmlsaXR5PXN0YXRlLnN0ZXA9PT0wPyJoaWRkZW4iOiJ2aXNpYmxlIjsKICAkKCJuZXh0QnRuIikudGV4dENvbnRlbnQ9c3RhdGUuc3RlcD09PVNURVBTLmxlbmd0aC0xPyJIb8OgbiB04bqldCI6IlRp4bq/cCB04bulYyDihpIiOwogIHJlbmRlclByb2Nlc3MoKTsKICBpZihTVEVQU1tzdGF0ZS5zdGVwXS5pZD09PSJwcmlvciIpewogICAgaWYoISQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlKSB1c2VHZW5lcmF0ZWRRdWVyeSgpOwogICAgdXBkYXRlT2ZmaWNpYWxTZWFyY2hMaW5rcygkKCJsaXZlU2VhcmNoUXVlcnkiKS52YWx1ZSk7CiAgfQogIHNjcm9sbFRvKHt0b3A6MCxiZWhhdmlvcjoic21vb3RoIn0pOwp9CmZ1bmN0aW9uIHZhbGlkYXRlQmVmb3JlTmV4dCgpewogIGlmKHN0YXRlLnN0ZXA9PT0wICYmICFzdGF0ZS5yYXdUZXh0ICYmICFzdGF0ZS5jbGFpbXMubGVuZ3RoKXthbGVydCgiSMOjeSB04bqjaSBt4buZdCBQREYgaG/hurdjIG7huqFwIGRlbW8gdHLGsOG7m2MuIik7cmV0dXJuIGZhbHNlfQogIGlmKHN0YXRlLnN0ZXA9PT0xICYmICFzdGF0ZS5jbGFpbXMubGVuZ3RoKXthbGVydCgiQ2jGsGEgY8OzIGNsYWltLiBIw6N5IE9DUiBs4bqhaSBob+G6t2MgcGFzdGUgcGjhuqduIFnDqnUgY+G6p3UgYuG6o28gaOG7mSBy4buTaSBi4bqlbSDigJxUw6FjaCBs4bqhaSBjbGFpbXPigJ0uIik7cmV0dXJuIGZhbHNlfQogIGlmKHN0YXRlLnN0ZXA9PT0yICYmICFzdGF0ZS5mZWF0dXJlcy5sZW5ndGgpe2FsZXJ0KCJIw6N5IHTDoWNoIGThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQgdHLGsOG7m2MuIik7cmV0dXJuIGZhbHNlfQogIGlmKHN0YXRlLnN0ZXA9PT0yICYmICFzdGF0ZS5jb25maXJtZWQpe3JldHVybiBjb25maXJtKCJC4buZIGThuqV1IGhp4buHdSBjaMawYSDEkcaw4bujYyB4w6FjIG5o4bqtbi4gQuG6oW4gduG6q24gbXXhu5FuIHRp4bq/cCB04bulYz8iKX0KICBpZihzdGF0ZS5zdGVwPT09NCl7cmVhZFByaW9yKCk7aWYoIU9iamVjdC52YWx1ZXMoc3RhdGUucHJpb3IpLnNvbWUoeD0+eC5ubykpe3JldHVybiBjb25maXJtKCJDaMawYSBjw7MgdMOgaSBsaeG7h3UgxJHhu5FpIGNo4bupbmcuIELhuqFuIHbhuqtuIG114buRbiB0aeG6v3AgdOG7pWM/Iil9fQogIHJldHVybiB0cnVlCn0KJCgiYmFja0J0biIpLm9uY2xpY2s9KCk9PnNob3dTdGVwKHN0YXRlLnN0ZXAtMSk7CiQoIm5leHRCdG4iKS5vbmNsaWNrPSgpPT57aWYoc3RhdGUuc3RlcD09PVNURVBTLmxlbmd0aC0xKXskKCJnZW5SZXBvcnQiKS5jbGljaygpO3JldHVybn1pZih2YWxpZGF0ZUJlZm9yZU5leHQoKSlzaG93U3RlcChzdGF0ZS5zdGVwKzEpfTsKc2hvd1N0ZXAoMCk7c2V0VGltZW91dCh1cGRhdGVGZWF0dXJlUmV2aWV3VUksMCk7CmlmKGxvY2F0aW9uLnByb3RvY29sPT09ImZpbGU6IikgJCgibG9jYWxCYW5uZXIiKS5zdHlsZS5kaXNwbGF5PSJibG9jayI7CgpmdW5jdGlvbiBzZXREZXRlY3QoaWQsb2ssdGV4dCl7bGV0IGVsPSQoaWQpO2VsLmNsYXNzTmFtZT0iZGV0ZWN0LWNhcmQgIisob2s/Im9rIjoid2FybiIpO2VsLnF1ZXJ5U2VsZWN0b3IoInNwYW4iKS50ZXh0Q29udGVudD10ZXh0fQpmdW5jdGlvbiBub3JtRGF0ZSh2KXtpZighdilyZXR1cm4iIjtsZXQgbT12Lm1hdGNoKC8oXGR7MSwyfSlbXC9cLS5dKFxkezEsMn0pW1wvXC0uXShcZHs0fSkvKTtpZihtKXJldHVybiBgJHttWzNdfS0ke1N0cmluZyhtWzJdKS5wYWRTdGFydCgyLCIwIil9LSR7U3RyaW5nKG1bMV0pLnBhZFN0YXJ0KDIsIjAiKX1gO2xldCBkPW5ldyBEYXRlKHYpO3JldHVybiBpc05hTihkKT8iIjpkLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwxMCl9CmZ1bmN0aW9uIGZpcnN0TWF0Y2godGV4dCxwYXR0ZXJucyl7Zm9yKGNvbnN0IHAgb2YgcGF0dGVybnMpe2NvbnN0IG09dGV4dC5tYXRjaChwKTtpZihtJiZtWzFdKXJldHVybiBjbGVhbihtWzFdKX1yZXR1cm4iIn0KCmFzeW5jIGZ1bmN0aW9uIGdldFBkZkxpYigpewogaWYoIXdpbmRvdy5wZGZqc0xpYikgdGhyb3cgbmV3IEVycm9yKCJQREYuanMgY2jGsGEgdOG6o2kgxJHGsOG7o2MgdOG7qyBDRE4uIik7CiBwZGZqc0xpYi5HbG9iYWxXb3JrZXJPcHRpb25zLndvcmtlclNyYz0iaHR0cHM6Ly9jZG5qcy5jbG91ZGZsYXJlLmNvbS9hamF4L2xpYnMvcGRmLmpzLzMuMTEuMTc0L3BkZi53b3JrZXIubWluLmpzIjsKIHJldHVybiB3aW5kb3cucGRmanNMaWI7Cn0KYXN5bmMgZnVuY3Rpb24gcmVhZFBkZihmaWxlKXsKICBjb25zdCBwZGZqcz1hd2FpdCBnZXRQZGZMaWIoKTsKICBjb25zdCBwZGY9YXdhaXQgcGRmanMuZ2V0RG9jdW1lbnQoe2RhdGE6YXdhaXQgZmlsZS5hcnJheUJ1ZmZlcigpfSkucHJvbWlzZTsKICBzdGF0ZS5wZGY9cGRmOwogIHN0YXRlLnBhZ2VUZXh0PVtdOwogIHN0YXRlLnBhZ2VDb2x1bW5UZXh0PVtdOwogIHN0YXRlLnBhZ2VRdWFsaXR5PVtdOwogIHN0YXRlLmJhZFRleHRQYWdlcz1bXTsKCiAgZnVuY3Rpb24gaXRlbXNUb0xpbmVzKGl0ZW1zKXsKICAgIGlmKCFpdGVtcy5sZW5ndGgpIHJldHVybiAiIjsKICAgIGNvbnN0IGhlaWdodHM9aXRlbXMubWFwKHg9Pk1hdGguYWJzKHguaHx8MTApKS5maWx0ZXIoQm9vbGVhbikuc29ydCgoYSxiKT0+YS1iKTsKICAgIGNvbnN0IG1lZGlhbkg9aGVpZ2h0c1tNYXRoLmZsb29yKGhlaWdodHMubGVuZ3RoLzIpXXx8MTA7CiAgICBjb25zdCB0b2w9TWF0aC5tYXgoMi4yLE1hdGgubWluKDUsbWVkaWFuSCouMzgpKTsKCiAgICBjb25zdCByb3dzPVtdOwogICAgY29uc3Qgc29ydGVkPWl0ZW1zLnNsaWNlKCkuc29ydCgoYSxiKT0+Yi55LWEueSB8fCBhLngtYi54KTsKICAgIGZvcihjb25zdCBpdCBvZiBzb3J0ZWQpewogICAgICBsZXQgcm93PXJvd3MuZmluZChyPT5NYXRoLmFicyhyLnktaXQueSk8PXRvbCk7CiAgICAgIGlmKCFyb3cpe3Jvdz17eTppdC55LGl0ZW1zOltdfTtyb3dzLnB1c2gocm93KX0KICAgICAgcm93Lml0ZW1zLnB1c2goaXQpOwogICAgfQogICAgcm93cy5zb3J0KChhLGIpPT5iLnktYS55KTsKCiAgICByZXR1cm4gcm93cy5tYXAocj0+ewogICAgICBjb25zdCB4cz1yLml0ZW1zLnNvcnQoKGEsYik9PmEueC1iLngpOwogICAgICBsZXQgb3V0PSIiOwogICAgICBsZXQgcHJldj1udWxsOwogICAgICBmb3IoY29uc3QgaXQgb2YgeHMpewogICAgICAgIGNvbnN0IHM9U3RyaW5nKGl0LnN8fCIiKTsKICAgICAgICBpZighcykgY29udGludWU7CiAgICAgICAgaWYocHJldil7CiAgICAgICAgICBjb25zdCBnYXA9aXQueC0ocHJldi54K3ByZXYudyk7CiAgICAgICAgICAvLyBBZGQgYSBzcGFjZSBvbmx5IHdoZW4gdmlzdWFsIGdhcCBzdWdnZXN0cyBvbmUgYW5kIHB1bmN0dWF0aW9uIGRvZXMgbm90LgogICAgICAgICAgaWYoZ2FwPk1hdGgubWF4KDEuNSwocHJldi5ofHwxMCkqLjEyKSAmJiAhL1tcc1wtXC9dJC8udGVzdChvdXQpICYmICEvXlssLjs6JVwpXS8udGVzdChzKSkgb3V0Kz0iICI7CiAgICAgICAgfQogICAgICAgIG91dCs9czsKICAgICAgICBwcmV2PWl0OwogICAgICB9CiAgICAgIHJldHVybiBvdXQudHJpbSgpOwogICAgfSkuZmlsdGVyKEJvb2xlYW4pLmpvaW4oIlxuIik7CiAgfQoKICBmb3IobGV0IHA9MTtwPD1wZGYubnVtUGFnZXM7cCsrKXsKICAgIGNvbnN0IHBhZ2U9YXdhaXQgcGRmLmdldFBhZ2UocCk7CiAgICBjb25zdCB2aWV3cG9ydD1wYWdlLmdldFZpZXdwb3J0KHtzY2FsZToxfSk7CiAgICBjb25zdCBjb250ZW50PWF3YWl0IHBhZ2UuZ2V0VGV4dENvbnRlbnQoe2Rpc2FibGVOb3JtYWxpemF0aW9uOmZhbHNlfSk7CgogICAgY29uc3QgaXRlbXM9Y29udGVudC5pdGVtcwogICAgICAuZmlsdGVyKHg9PnggJiYgdHlwZW9mIHguc3RyPT09InN0cmluZyIgJiYgeC5zdHIudHJpbSgpKQogICAgICAubWFwKHg9Pih7CiAgICAgICAgczp4LnN0ci5ub3JtYWxpemUoIk5GQyIpLAogICAgICAgIHg6eC50cmFuc2Zvcm1bNF0sCiAgICAgICAgeTp4LnRyYW5zZm9ybVs1XSwKICAgICAgICB3Ok51bWJlcih4LndpZHRoKXx8MCwKICAgICAgICBoOk51bWJlcih4LmhlaWdodCl8fE1hdGguYWJzKHgudHJhbnNmb3JtWzNdKXx8MTAKICAgICAgfSkpOwoKICAgIGxldCBzaW1wbGU9c3RyaXBQZGZBcnRpZmFjdHMoaXRlbXNUb0xpbmVzKGl0ZW1zKSk7CiAgICBjb25zdCBtaWQ9dmlld3BvcnQud2lkdGgvMjsKICAgIGxldCBsZWZ0PXN0cmlwUGRmQXJ0aWZhY3RzKGl0ZW1zVG9MaW5lcyhpdGVtcy5maWx0ZXIoeD0+eC54PG1pZCkpKTsKICAgIGxldCByaWdodD1zdHJpcFBkZkFydGlmYWN0cyhpdGVtc1RvTGluZXMoaXRlbXMuZmlsdGVyKHg9PngueD49bWlkKSkpOwoKICAgIGNvbnN0IHE9dGV4dExheWVyUXVhbGl0eVNjb3JlKHNpbXBsZSk7CiAgICBzdGF0ZS5wYWdlVGV4dC5wdXNoKHNpbXBsZSk7CiAgICBzdGF0ZS5wYWdlQ29sdW1uVGV4dC5wdXNoKGxlZnQrIlxuIityaWdodCk7CiAgICBzdGF0ZS5wYWdlUXVhbGl0eS5wdXNoKHEpOwogICAgaWYocTw0OCkgc3RhdGUuYmFkVGV4dFBhZ2VzLnB1c2gocCk7CgogICAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD1NYXRoLnJvdW5kKHAvcGRmLm51bVBhZ2VzKjM1KSsiJSI7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1gxJBhbmcgxJHhu41jIHRleHQgbGF5ZXI6ICR7cH0vJHtwZGYubnVtUGFnZXN9IMK3IGNo4bqldCBsxrDhu6NuZyAke3F9LzEwMGA7CiAgfQogIGNob29zZURvY3VtZW50TGFuZ3VhZ2UoKTsKICByZXR1cm4gcGRmOwp9CgpmdW5jdGlvbiB0ZXh0UXVhbGl0eSgpewogIGNvbnN0IGNoYXJzPXN0YXRlLnBhZ2VUZXh0LnJlZHVjZSgobixzKT0+bitzLmxlbmd0aCwwKTsKICBjb25zdCBnb29kPXN0YXRlLnBhZ2VRdWFsaXR5LmZpbHRlcih4PT54Pj00OCkubGVuZ3RoOwogIHJldHVybiB7Y2hhcnMsYXZnOmNoYXJzL01hdGgubWF4KDEsc3RhdGUucGFnZVRleHQubGVuZ3RoKSxnb29kUGFnZXM6Z29vZCxiYWRQYWdlczpzdGF0ZS5iYWRUZXh0UGFnZXMubGVuZ3RofTsKfQoKYXN5bmMgZnVuY3Rpb24gcmVuZGVyUGFnZUNhbnZhcyhwYWdlTm8sc2NhbGU9MS43NSl7CiAgY29uc3QgcGFnZT1hd2FpdCBzdGF0ZS5wZGYuZ2V0UGFnZShwYWdlTm8pLHZpZXdwb3J0PXBhZ2UuZ2V0Vmlld3BvcnQoe3NjYWxlfSk7CiAgY29uc3QgY2FudmFzPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImNhbnZhcyIpO2NhbnZhcy53aWR0aD1NYXRoLmNlaWwodmlld3BvcnQud2lkdGgpO2NhbnZhcy5oZWlnaHQ9TWF0aC5jZWlsKHZpZXdwb3J0LmhlaWdodCk7CiAgYXdhaXQgcGFnZS5yZW5kZXIoe2NhbnZhc0NvbnRleHQ6Y2FudmFzLmdldENvbnRleHQoIjJkIiksdmlld3BvcnR9KS5wcm9taXNlO3JldHVybiBjYW52YXM7Cn0KCmZ1bmN0aW9uIHByZXByb2Nlc3NPY3JDYW52YXMoc3JjKXsKICBjb25zdCBvdXQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgiY2FudmFzIik7CiAgb3V0LndpZHRoPXNyYy53aWR0aDsgb3V0LmhlaWdodD1zcmMuaGVpZ2h0OwogIGNvbnN0IGN0eD1vdXQuZ2V0Q29udGV4dCgiMmQiLHt3aWxsUmVhZEZyZXF1ZW50bHk6dHJ1ZX0pOwogIGN0eC5kcmF3SW1hZ2Uoc3JjLDAsMCk7CiAgY29uc3QgaW1nPWN0eC5nZXRJbWFnZURhdGEoMCwwLG91dC53aWR0aCxvdXQuaGVpZ2h0KTsKICBjb25zdCBkPWltZy5kYXRhOwoKICAvLyBIaXN0b2dyYW0gZ3JheXNjYWxlIGZvciByb2J1c3QgdGhyZXNob2xkLgogIGNvbnN0IGhpc3Q9bmV3IEFycmF5KDI1NikuZmlsbCgwKTsKICBmb3IobGV0IGk9MDtpPGQubGVuZ3RoO2krPTQpewogICAgY29uc3QgZz1NYXRoLm1heCgwLE1hdGgubWluKDI1NSxNYXRoLnJvdW5kKDAuMjk5KmRbaV0rMC41ODcqZFtpKzFdKzAuMTE0KmRbaSsyXSkpKTsKICAgIGhpc3RbZ10rKzsKICB9CiAgbGV0IHRvdGFsPW91dC53aWR0aCpvdXQuaGVpZ2h0LHN1bT0wOwogIGZvcihsZXQgaT0wO2k8MjU2O2krKykgc3VtKz1pKmhpc3RbaV07CiAgbGV0IHN1bUI9MCx3Qj0wLG1heFZhcj0wLHRocj0xNzg7CiAgZm9yKGxldCB0PTA7dDwyNTY7dCsrKXsKICAgIHdCKz1oaXN0W3RdOyBpZighd0IpIGNvbnRpbnVlOwogICAgY29uc3Qgd0Y9dG90YWwtd0I7IGlmKCF3RikgYnJlYWs7CiAgICBzdW1CKz10Kmhpc3RbdF07CiAgICBjb25zdCBtQj1zdW1CL3dCLG1GPShzdW0tc3VtQikvd0Y7CiAgICBjb25zdCB2PXdCKndGKihtQi1tRikqKG1CLW1GKTsKICAgIGlmKHY+bWF4VmFyKXttYXhWYXI9djt0aHI9dH0KICB9CiAgLy8gQXZvaWQgb3Zlcmx5IGFnZ3Jlc3NpdmUgdGhyZXNob2xkIGZvciBwYWxlIHNjYW5zLgogIHRocj1NYXRoLm1heCgxNDUsTWF0aC5taW4oMjA1LHRocisxMikpOwoKICBmb3IobGV0IGk9MDtpPGQubGVuZ3RoO2krPTQpewogICAgbGV0IGc9MC4yOTkqZFtpXSswLjU4NypkW2krMV0rMC4xMTQqZFtpKzJdOwogICAgLy8gY29udHJhc3Qgc3RyZXRjaCBiZWZvcmUgYmluYXJpemF0aW9uCiAgICBnPShnLTEyOCkqMS4yMisxMjg7CiAgICBjb25zdCB2PWc8dGhyPzA6MjU1OwogICAgZFtpXT1kW2krMV09ZFtpKzJdPXY7CiAgICBkW2krM109MjU1OwogIH0KICBjdHgucHV0SW1hZ2VEYXRhKGltZywwLDApOwogIHJldHVybiBvdXQ7Cn0KCmZ1bmN0aW9uIGNyb3BDYW52YXNUb3Aoc3JjLHJhdGlvKXsKICByYXRpbz1NYXRoLm1heCguNDUsTWF0aC5taW4oMSxOdW1iZXIocmF0aW8pfHwxKSk7CiAgY29uc3Qgb3V0PWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImNhbnZhcyIpOwogIG91dC53aWR0aD1zcmMud2lkdGg7CiAgb3V0LmhlaWdodD1NYXRoLm1heCgxLE1hdGgucm91bmQoc3JjLmhlaWdodCpyYXRpbykpOwogIG91dC5nZXRDb250ZXh0KCIyZCIpLmRyYXdJbWFnZShzcmMsMCwwLHNyYy53aWR0aCxvdXQuaGVpZ2h0LDAsMCxzcmMud2lkdGgsb3V0LmhlaWdodCk7CiAgcmV0dXJuIG91dDsKfQoKZnVuY3Rpb24gcHJlZmVycmVkT2NyTGFuZ3VhZ2VzKHBhZ2VObyl7CiAgY29uc3QgcGFnZT1zdGF0ZS5sYW5ndWFnZUJ5UGFnZVtwYWdlTm9dOwogIGNvbnN0IGxhbmc9KHBhZ2UmJnBhZ2UubGFuZyYmcGFnZS5sYW5nIT09InVua25vd24iKT9wYWdlLmxhbmc6c3RhdGUuZG9jTGFuZzsKICBpZihsYW5nPT09InZpIikgcmV0dXJuIFsidmllIixbInZpZSIsImVuZyJdXTsKICBpZihsYW5nPT09ImVuIikgcmV0dXJuIFsiZW5nIixbImVuZyIsInZpZSJdXTsKICByZXR1cm4gW1sidmllIiwiZW5nIl0sInZpZSIsImVuZyJdOwp9Cgphc3luYyBmdW5jdGlvbiByZWNvZ25pemVXaXRoTGFuZyh3b3JrZXIsY2FudmFzLGxhbmcscHNtKXsKICBjb25zdCBsYW5ncz1BcnJheS5pc0FycmF5KGxhbmcpP2xhbmc6W2xhbmddOwogIHRyeXsKICAgIGF3YWl0IHdvcmtlci5yZWluaXRpYWxpemUobGFuZ3MsMSk7CiAgfWNhdGNoKGUpewogICAgLy8gU29tZSBidWlsZHMgYWNjZXB0IHN0cmluZyBtb3JlIHJlbGlhYmx5IGZvciBhIHNpbmdsZSBsYW5ndWFnZS4KICAgIGlmKGxhbmdzLmxlbmd0aD09PTEpIGF3YWl0IHdvcmtlci5yZWluaXRpYWxpemUobGFuZ3NbMF0sMSk7CiAgICBlbHNlIHRocm93IGU7CiAgfQogIGF3YWl0IHdvcmtlci5zZXRQYXJhbWV0ZXJzKHsKICAgIHByZXNlcnZlX2ludGVyd29yZF9zcGFjZXM6IjEiLAogICAgdXNlcl9kZWZpbmVkX2RwaToiMzAwIiwKICAgIHRlc3NlZGl0X3BhZ2VzZWdfbW9kZTpTdHJpbmcocHNtKQogIH0pOwogIGNvbnN0IHJlcz1hd2FpdCB3aXRoVGltZW91dCgKICAgIHdvcmtlci5yZWNvZ25pemUoY2FudmFzKSwKICAgIDY1MDAwLAogICAgYE9DUiAke2xhbmdzLmpvaW4oIisiKX0gUFNNICR7cHNtfWAKICApOwogIHJldHVybiB7CiAgICB0ZXh0OihyZXMmJnJlcy5kYXRhJiZyZXMuZGF0YS50ZXh0KXx8IiIsCiAgICBjb25maWRlbmNlOk51bWJlcihyZXMmJnJlcy5kYXRhJiZyZXMuZGF0YS5jb25maWRlbmNlKXx8MCwKICAgIGxhbmc6bGFuZ3Muam9pbigiKyIpCiAgfTsKfQoKZnVuY3Rpb24gb2NyUXVhbGl0eVNjb3JlKHRleHQsY29uZmlkZW5jZT0wKXsKICBjb25zdCBmPWZvbGRWTih0ZXh0fHwiIik7CiAgbGV0IHNjb3JlPU51bWJlcihjb25maWRlbmNlKXx8MDsKICBjb25zdCBwYXRlbnRXb3Jkcz1bIllFVSBDQVUgQkFPIEhPIiwiUVVZIFRSSU5IIiwiUEhVT05HIFBIQVAiLCJCQU8gR09NIiwiVFJPTkcgRE8iLCJTQU5HIENIRSIsIlRISUVUIEJJIiwiSEUgVEhPTkciLCJUSEFOSCBQSEFOIl07CiAgZm9yKGNvbnN0IHcgb2YgcGF0ZW50V29yZHMpIGlmKGYuaW5jbHVkZXModykpIHNjb3JlKz04OwogIHNjb3JlKz1NYXRoLm1pbigyMCwodGV4dHx8IiIpLmxlbmd0aC8yNTApOwogIC8vIFBlbmFsaXplIG9idmlvdXMgT0NSIGdhcmJhZ2UuCiAgY29uc3Qgd2VpcmQ9KCh0ZXh0fHwiIikubWF0Y2goL1t8e308Pn5eYF0vZyl8fFtdKS5sZW5ndGg7CiAgc2NvcmUtPU1hdGgubWluKDIwLHdlaXJkKjIpOwogIHJldHVybiBzY29yZTsKfQoKCmNvbnN0IHNsZWVwID0gbXMgPT4gbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7CmZ1bmN0aW9uIHdpdGhUaW1lb3V0KHByb21pc2UsIG1zLCBsYWJlbCl7CiAgbGV0IHRpbWVyOwogIGNvbnN0IHRpbWVvdXQgPSBuZXcgUHJvbWlzZSgoXywgcmVqZWN0KSA9PiB7CiAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihsYWJlbCArICIgcXXDoSB0aOG7nWkgZ2lhbiIpKSwgbXMpOwogIH0pOwogIHJldHVybiBQcm9taXNlLnJhY2UoW3Byb21pc2UsIHRpbWVvdXRdKS5maW5hbGx5KCgpID0+IGNsZWFyVGltZW91dCh0aW1lcikpOwp9CgpsZXQgb2NyV29ya2VyUHJvbWlzZSA9IG51bGw7CmNvbnN0IFRFU1NfQ0ZHPXsKICB3b3JrZXJQYXRoOiJodHRwczovL2Nkbi5qc2RlbGl2ci5uZXQvbnBtL3Rlc3NlcmFjdC5qc0A1LjEuMS9kaXN0L3dvcmtlci5taW4uanMiLAogIGNvcmVQYXRoOiJodHRwczovL2Nkbi5qc2RlbGl2ci5uZXQvbnBtL3Rlc3NlcmFjdC5qcy1jb3JlQDUuMS4xIiwKICBsYW5nUGF0aDoiaHR0cHM6Ly9jZG4uanNkZWxpdnIubmV0L2doL25hcHRoYS90ZXNzZGF0YUBnaC1wYWdlcy80LjAuMCIKfTsKCmFzeW5jIGZ1bmN0aW9uIHByb2JlVGVzc1BhY2sobGFuZyl7CiAgY29uc3QgdXJsPWAke1RFU1NfQ0ZHLmxhbmdQYXRofS8ke2xhbmd9LnRyYWluZWRkYXRhLmd6YDsKICB0cnl7CiAgICAvLyBSYW5nZSBrZWVwcyB0aGlzIGRpYWdub3N0aWMgbGlnaHR3ZWlnaHQgd2hlbiB0aGUgQ0ROIHN1cHBvcnRzIGl0LgogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCh1cmwse2hlYWRlcnM6e1JhbmdlOiJieXRlcz0wLTMxIn0sY2FjaGU6ImZvcmNlLWNhY2hlIn0pOwogICAgaWYoIXIub2sgJiYgci5zdGF0dXMhPT0yMDYpIHRocm93IG5ldyBFcnJvcihgJHtsYW5nfS50cmFpbmVkZGF0YSBIVFRQICR7ci5zdGF0dXN9YCk7CiAgICBzdGF0ZS50ZXNzRGlhZ1tsYW5nXT10cnVlOwogICAgcmVuZGVyVGVzc0RpYWcoKTsKICAgIHJldHVybiB0cnVlOwogIH1jYXRjaChlKXsKICAgIHN0YXRlLnRlc3NEaWFnLmVycm9yPWBLaMO0bmcgdOG6o2kgxJHGsOG7o2MgJHtsYW5nfS50cmFpbmVkZGF0YTogJHtTdHJpbmcoZS5tZXNzYWdlfHxlKX1gOwogICAgcmVuZGVyVGVzc0RpYWcoKTsKICAgIHRocm93IGU7CiAgfQp9Cgphc3luYyBmdW5jdGlvbiBnZXRPY3JXb3JrZXIocmVhc29uPSJPQ1IiKXsKICBpZihvY3JXb3JrZXJQcm9taXNlKSByZXR1cm4gb2NyV29ya2VyUHJvbWlzZTsKICBpZighd2luZG93LlRlc3NlcmFjdCkgdGhyb3cgbmV3IEVycm9yKCJLaMO0bmcgdOG6o2kgxJHGsOG7o2MgVGVzc2VyYWN0LmpzLiIpOwoKICBzdGF0ZS50ZXNzRGlhZz17dmllOmZhbHNlLGVuZzpmYWxzZSxlcnJvcjoiIn07CiAgcmVuZGVyVGVzc0RpYWcoKTsKICBzZXREZXRlY3QoImRldE9DUiIsZmFsc2UsIsSQYW5nIHThuqNpIGLhu5kgT0NSIHZpZSArIGVuZy4uLiIpOwogICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PXJlYXNvbisiOiDEkWFuZyBraeG7g20gdHJhIGxhbmd1YWdlIHBhY2tzIHRp4bq/bmcgVmnhu4d0ICsgdGnhur9uZyBBbmguLi4iOwogIGF3YWl0IHNsZWVwKDYwKTsKCiAgLy8gRG8gbm90IHNpbGVudGx5IGNvbnRpbnVlIGlmIFZpZXRuYW1lc2UgdHJhaW5lZGRhdGEgaXMgdW5hdmFpbGFibGUuCiAgYXdhaXQgUHJvbWlzZS5hbGwoW3Byb2JlVGVzc1BhY2soInZpZSIpLHByb2JlVGVzc1BhY2soImVuZyIpXSk7CgogIGNvbnN0IGxhbmdzPVsidmllIiwiZW5nIl07IC8vIHByZWxvYWQgYm90aCBwYWNrczsgdjEyIHJlaW5pdGlhbGl6ZSB0aGVvIG5nw7RuIG5n4buvIHThu6tuZyB0cmFuZwogIGNvbnN0IE9FTT0oVGVzc2VyYWN0Lk9FTSAmJiBUZXNzZXJhY3QuT0VNLkxTVE1fT05MWSkgfHwgMTsKCiAgb2NyV29ya2VyUHJvbWlzZT13aXRoVGltZW91dCgKICAgIFRlc3NlcmFjdC5jcmVhdGVXb3JrZXIobGFuZ3MsT0VNLHsKICAgICAgd29ya2VyUGF0aDpURVNTX0NGRy53b3JrZXJQYXRoLAogICAgICBjb3JlUGF0aDpURVNTX0NGRy5jb3JlUGF0aCwKICAgICAgbGFuZ1BhdGg6VEVTU19DRkcubGFuZ1BhdGgsCiAgICAgIGd6aXA6dHJ1ZSwKICAgICAgY2FjaGVNZXRob2Q6IndyaXRlIiwKICAgICAgbG9nZ2VyOm09PnsKICAgICAgICBpZighbSkgcmV0dXJuOwogICAgICAgIGNvbnN0IHN0YXR1cz1TdHJpbmcobS5zdGF0dXN8fCIiKTsKICAgICAgICBjb25zdCBwY3Q9TWF0aC5yb3VuZCgobS5wcm9ncmVzc3x8MCkqMTAwKTsKCiAgICAgICAgaWYoL2xvYWRpbmcgbGFuZ3VhZ2UgdHJhaW5lZGRhdGEvaS50ZXN0KHN0YXR1cykpewogICAgICAgICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YCR7cmVhc29ufTogxJFhbmcgdOG6o2kgdmllICsgZW5nIHRyYWluZWRkYXRhICR7cGN0fSVgOwogICAgICAgIH1lbHNlIGlmKC9pbml0aWFsaXppbmcgYXBpL2kudGVzdChzdGF0dXMpKXsKICAgICAgICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PWAke3JlYXNvbn06IGto4bufaSB04bqhbyBPQ1IgdmllICsgZW5nICR7cGN0fSVgOwogICAgICAgIH1lbHNlIGlmKHN0YXR1cz09PSJyZWNvZ25pemluZyB0ZXh0Iil7CiAgICAgICAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1gJHtyZWFzb259OiBuaOG6rW4gZGnhu4duIHZpZSArIGVuZyAke3BjdH0lYDsKICAgICAgICB9CiAgICAgIH0sCiAgICAgIGVycm9ySGFuZGxlcjplcnI9PnsKICAgICAgICBzdGF0ZS50ZXNzRGlhZy5lcnJvcj1TdHJpbmcoZXJyJiZlcnIubWVzc2FnZT9lcnIubWVzc2FnZTplcnIpOwogICAgICAgIHJlbmRlclRlc3NEaWFnKCk7CiAgICAgICAgY29uc29sZS5lcnJvcigiVGVzc2VyYWN0IHdvcmtlcjoiLGVycik7CiAgICAgIH0KICAgIH0pLAogICAgNDUwMDAsCiAgICAiS2jhu59pIHThuqFvIE9DUiB2aWUgKyBlbmciCiAgKTsKCiAgdHJ5ewogICAgY29uc3Qgd29ya2VyPWF3YWl0IG9jcldvcmtlclByb21pc2U7CiAgICBhd2FpdCB3b3JrZXIuc2V0UGFyYW1ldGVycyh7CiAgICAgIHByZXNlcnZlX2ludGVyd29yZF9zcGFjZXM6IjEiLAogICAgICB1c2VyX2RlZmluZWRfZHBpOiIzMDAiCiAgICB9KTsKICAgIHN0YXRlLnRlc3NEaWFnLnZpZT10cnVlOwogICAgc3RhdGUudGVzc0RpYWcuZW5nPXRydWU7CiAgICByZW5kZXJUZXNzRGlhZygpOwogICAgcmV0dXJuIHdvcmtlcjsKICB9Y2F0Y2goZSl7CiAgICBvY3JXb3JrZXJQcm9taXNlPW51bGw7CiAgICBzdGF0ZS50ZXNzRGlhZy5lcnJvcj1TdHJpbmcoZS5tZXNzYWdlfHxlKTsKICAgIHJlbmRlclRlc3NEaWFnKCk7CiAgICB0aHJvdyBlOwogIH0KfQoKYXN5bmMgZnVuY3Rpb24gb2NyU2VsZWN0ZWRQYWdlcyhwYWdlTm9zLHJlYXNvbj0iT0NSIixmb3JjZT1mYWxzZSl7CiAgaWYoIXN0YXRlLnBkZikgcmV0dXJuIGZhbHNlOwogIHRyeXsKICAgIGxldCBsb2NhbFdvcmtlcj1udWxsOwogICAgbGV0IGRvbmU9MDsKCiAgICBmb3IoY29uc3QgcCBvZiBwYWdlTm9zKXsKICAgICAgaWYoc3RhdGUub2NyUGFnZXNbcF0mJiFmb3JjZSl7ZG9uZSsrO2NvbnRpbnVlO30KICAgICAgaWYoZm9yY2UpIGRlbGV0ZSBzdGF0ZS5vY3JQYWdlc1twXTsKCiAgICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PWAke3JlYXNvbn06IHRyYW5nICR7cH0uLi5gOwogICAgICBhd2FpdCBzbGVlcCgyMCk7CgogICAgICBjb25zdCBjYW5kaWRhdGVzPVtdOwogICAgICBjb25zdCBkaXJlY3Q9c3RhdGUucGFnZVRleHRbcC0xXXx8IiI7CiAgICAgIGNvbnN0IGRpcmVjdFE9c3RhdGUucGFnZVF1YWxpdHlbcC0xXXx8MDsKICAgICAgY29uc3QgZGlyZWN0TGFuZz1kZXRlY3RUZXh0TGFuZ3VhZ2UoZGlyZWN0KTsKCiAgICAgIC8vIEZvciBhIGNsZWFuIGRpZ2l0YWwgUERGLCBzdHJvbmdseSBwcmVmZXIgaXRzIGVtYmVkZGVkIFVuaWNvZGUgdGV4dC4KICAgICAgaWYoZGlyZWN0LnRyaW0oKSl7CiAgICAgICAgbGV0IGJvbnVzPShkaXJlY3RRPj02MiAmJiAhbG9va3NMaWtlTGVnYWN5RW5jb2RpbmcoZGlyZWN0KSk/Mzg6MDsKICAgICAgICBib251cys9bGFuZ3VhZ2VGaXRTY29yZShkaXJlY3QsZGlyZWN0TGFuZy5sYW5nKTsKICAgICAgICBjYW5kaWRhdGVzLnB1c2goewogICAgICAgICAgc291cmNlOmBQREYgdGV4dCBsYXllciDCtyAke2xhbmd1YWdlTGFiZWwoZGlyZWN0TGFuZy5sYW5nKX1gLAogICAgICAgICAgdGV4dDpkaXJlY3QsCiAgICAgICAgICBzY29yZU92ZXJyaWRlOnZuT2NyUXVhbGl0eShkaXJlY3QpK2JvbnVzCiAgICAgICAgfSk7CiAgICAgIH0KCiAgICAgIGNvbnN0IHJhd0NhbnZhcz1hd2FpdCByZW5kZXJQYWdlQ2FudmFzKHAsMi43NSk7CgogICAgICAvLyBHb29nbGUgVmlzaW9uIGF1dG8tZGV0ZWN0cyBMYXRpbiBsYW5ndWFnZXM7IHVzZSByZXR1cm5lZCBsYW5ndWFnZSBtZXRhZGF0YSBhcyBhIHNlY29uZCBzaWduYWwuCiAgICAgIHRyeXsKICAgICAgICBjb25zdCBjbG91ZD1hd2FpdCBjbG91ZFZpc2lvbk9jcihyYXdDYW52YXMpOwogICAgICAgIGlmKGNsb3VkJiZjbG91ZC50ZXh0JiZjbG91ZC50ZXh0Lmxlbmd0aD4yMCl7CiAgICAgICAgICBjb25zdCB0b3BMYW5nPWNsb3VkLmxhbmd1YWdlcyYmY2xvdWQubGFuZ3VhZ2VzWzBdOwogICAgICAgICAgaWYodG9wTGFuZyYmdG9wTGFuZy5sYW5ndWFnZUNvZGUpewogICAgICAgICAgICBzdGF0ZS52aXNpb25MYW5ndWFnZXNCeVBhZ2VbcF09Y2xvdWQubGFuZ3VhZ2VzOwogICAgICAgICAgICBjb25zdCBsYz1TdHJpbmcodG9wTGFuZy5sYW5ndWFnZUNvZGUpLnRvTG93ZXJDYXNlKCk7CiAgICAgICAgICAgIGlmKGxjLnN0YXJ0c1dpdGgoInZpIikpIHN0YXRlLmxhbmd1YWdlQnlQYWdlW3BdPXtsYW5nOiJ2aSIsY29uZmlkZW5jZTpOdW1iZXIodG9wTGFuZy5jb25maWRlbmNlKXx8Ljd9OwogICAgICAgICAgICBlbHNlIGlmKGxjLnN0YXJ0c1dpdGgoImVuIikpIHN0YXRlLmxhbmd1YWdlQnlQYWdlW3BdPXtsYW5nOiJlbiIsY29uZmlkZW5jZTpOdW1iZXIodG9wTGFuZy5jb25maWRlbmNlKXx8Ljd9OwogICAgICAgICAgfQogICAgICAgICAgY2FuZGlkYXRlcy5wdXNoKHsKICAgICAgICAgICAgc291cmNlOmBHb29nbGUgVmlzaW9uIGF1dG8ke3RvcExhbmc/YCDCtyAke3RvcExhbmcubGFuZ3VhZ2VDb2RlfWA6IiJ9YCwKICAgICAgICAgICAgdGV4dDpjbG91ZC50ZXh0CiAgICAgICAgICB9KTsKICAgICAgICB9CiAgICAgIH1jYXRjaChfZSl7fQoKICAgICAgLy8gVGVzc2VyYWN0OiBwaWNrIGxhbmd1YWdlIHBlciBwYWdlL2RvY3VtZW50LiBWaWV0bmFtZXNlIGFuZCBFbmdsaXNoIGFyZSBub3QgZm9yY2VkIHRvIGNvbXBldGUgb24gZXZlcnkgcGFnZS4KICAgICAgaWYoIWxvY2FsV29ya2VyKSBsb2NhbFdvcmtlcj1hd2FpdCBnZXRPY3JXb3JrZXIocmVhc29uKTsKICAgICAgY29uc3QgbGFuZ3NUb1RyeT1wcmVmZXJyZWRPY3JMYW5ndWFnZXMocCk7CgogICAgICAvLyBDbGFpbXMgb2Z0ZW4gb2NjdXB5IHVwcGVyIHBhcnQgb2YgYSBwYWdlIGZvbGxvd2VkIGJ5IGEgZmlndXJlLiBUcnkgY3JvcHBlZCB2YXJpYW50cy4KICAgICAgY29uc3QgY2FudmFzZXM9WwogICAgICAgIHtuYW1lOiJmdWxsIixjYW52YXM6cmF3Q2FudmFzfSwKICAgICAgICB7bmFtZToidG9wODIiLGNhbnZhczpjcm9wQ2FudmFzVG9wKHJhd0NhbnZhcywuODIpfSwKICAgICAgICB7bmFtZToidG9wNzIiLGNhbnZhczpjcm9wQ2FudmFzVG9wKHJhd0NhbnZhcywuNzIpfQogICAgICBdOwoKICAgICAgbGV0IHBhc3NDb3VudD0wOwogICAgICBmb3IoY29uc3QgbGFuZyBvZiBsYW5nc1RvVHJ5KXsKICAgICAgICBmb3IoY29uc3QgYyBvZiBjYW52YXNlcyl7CiAgICAgICAgICBpZihwYXNzQ291bnQ+PTYpIGJyZWFrOwogICAgICAgICAgLy8gVmlldG5hbWVzZSB1c2VzIFBTTSA2IGZvciBkZW5zZSBjbGFpbXM7IEVuZ2xpc2gvbWl4ZWQgc3RhcnRzIHdpdGggUFNNIDMuCiAgICAgICAgICBjb25zdCBwc209KEFycmF5LmlzQXJyYXkobGFuZyk/MzoobGFuZz09PSJ2aWUiPzY6MykpOwogICAgICAgICAgdHJ5ewogICAgICAgICAgICBjb25zdCBycj1hd2FpdCByZWNvZ25pemVXaXRoTGFuZyhsb2NhbFdvcmtlcixjLmNhbnZhcyxsYW5nLHBzbSk7CiAgICAgICAgICAgIGlmKHJyLnRleHQudHJpbSgpKXsKICAgICAgICAgICAgICBjb25zdCB0YXJnZXQ9QXJyYXkuaXNBcnJheShsYW5nKT8ibWl4ZWQiOihsYW5nPT09InZpZSI/InZpIjoiZW4iKTsKICAgICAgICAgICAgICBjb25zdCBjbGVhbj1yZXBhaXJDZXJ0YWluVm5PY3IocnIudGV4dCk7CiAgICAgICAgICAgICAgY29uc3Qgc2NvcmU9dm5PY3JRdWFsaXR5KGNsZWFuKQogICAgICAgICAgICAgICAgK2xhbmd1YWdlRml0U2NvcmUoY2xlYW4sdGFyZ2V0KQogICAgICAgICAgICAgICAgK01hdGgubWluKDEyLHJyLmNvbmZpZGVuY2UvOCkKICAgICAgICAgICAgICAgICsoYy5uYW1lPT09ImZ1bGwiPzA6Nik7CiAgICAgICAgICAgICAgY2FuZGlkYXRlcy5wdXNoKHsKICAgICAgICAgICAgICAgIHNvdXJjZTpgVGVzc2VyYWN0ICR7cnIubGFuZ30gwrcgJHtjLm5hbWV9IMK3IFBTTSAke3BzbX1gLAogICAgICAgICAgICAgICAgdGV4dDpjbGVhbiwKICAgICAgICAgICAgICAgIHNjb3JlT3ZlcnJpZGU6c2NvcmUKICAgICAgICAgICAgICB9KTsKICAgICAgICAgICAgfQogICAgICAgICAgfWNhdGNoKGUpe2NvbnNvbGUud2FybigiT0NSIHBhc3MiLGxhbmcsYy5uYW1lLGUpfQogICAgICAgICAgcGFzc0NvdW50Kys7CiAgICAgICAgfQogICAgICAgIGlmKHBhc3NDb3VudD49NikgYnJlYWs7CiAgICAgIH0KCiAgICAgIGNvbnN0IHJhbmtlZD1jYW5kaWRhdGVzCiAgICAgICAgLm1hcCh4PT4oewogICAgICAgICAgLi4ueCwKICAgICAgICAgIHRleHQ6dHJ1bmNhdGVDbGFpbUF0RmlndXJlKHJlcGFpckNlcnRhaW5Wbk9jcih4LnRleHQpKSwKICAgICAgICAgIHNjb3JlOk51bWJlci5pc0Zpbml0ZSh4LnNjb3JlT3ZlcnJpZGUpP3guc2NvcmVPdmVycmlkZTp2bk9jclF1YWxpdHkoeC50ZXh0KQogICAgICAgIH0pKQogICAgICAgIC5maWx0ZXIoeD0+eC50ZXh0Lmxlbmd0aD4xNSkKICAgICAgICAuc29ydCgoYSxiKT0+Yi5zY29yZS1hLnNjb3JlKTsKCiAgICAgIGNvbnN0IGJlc3Q9cmFua2VkWzBdOwogICAgICBpZihiZXN0KXsKICAgICAgICBzdGF0ZS5vY3JQYWdlc1twXT1iZXN0LnRleHQ7CiAgICAgICAgY29uc3QgZGV0PWRldGVjdFRleHRMYW5ndWFnZShiZXN0LnRleHQpOwogICAgICAgIHN0YXRlLmxhbmd1YWdlQnlQYWdlW3BdPWRldC5sYW5nPT09InVua25vd24iPyhzdGF0ZS5sYW5ndWFnZUJ5UGFnZVtwXXx8ZGV0KTpkZXQ7CiAgICAgICAgc3RhdGUuY2xhaW1Tb3VyY2VCeVBhZ2VbcF09e3NvdXJjZTpiZXN0LnNvdXJjZSxzY29yZTpNYXRoLnJvdW5kKGJlc3Quc2NvcmUpLGxhbmc6ZGV0Lmxhbmd9OwogICAgICAgIHNldERldGVjdCgiZGV0T0NSIix0cnVlLGAke2Jlc3Quc291cmNlfSDCtyAke2xhbmd1YWdlTGFiZWwoZGV0LmxhbmcpfSDCtyAke01hdGgucm91bmQoYmVzdC5zY29yZSl9LzEwMGApOwogICAgICAgIHJlbmRlclRlc3NEaWFnKCk7CiAgICAgIH1lbHNlewogICAgICAgIHN0YXRlLm9jclBhZ2VzW3BdPSIiOwogICAgICB9CgogICAgICBkb25lKys7CiAgICAgICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9KDQ1K01hdGgucm91bmQoZG9uZS9wYWdlTm9zLmxlbmd0aCo1MCkpKyIlIjsKICAgIH0KCiAgICAvLyBSZWNvbXB1dGUgZG9jdW1lbnQgbGFuZ3VhZ2UgYWZ0ZXIgT0NSIHNpZ25hbHMgYXJyaXZlLgogICAgY29uc3QgdmlQYWdlcz1PYmplY3QudmFsdWVzKHN0YXRlLmxhbmd1YWdlQnlQYWdlKS5maWx0ZXIoeD0+eCYmeC5sYW5nPT09InZpIikubGVuZ3RoOwogICAgY29uc3QgZW5QYWdlcz1PYmplY3QudmFsdWVzKHN0YXRlLmxhbmd1YWdlQnlQYWdlKS5maWx0ZXIoeD0+eCYmeC5sYW5nPT09ImVuIikubGVuZ3RoOwogICAgaWYodmlQYWdlcz5lblBhZ2VzKjEuNCl7c3RhdGUuZG9jTGFuZz0idmkiO3N0YXRlLmRvY0xhbmdDb25maWRlbmNlPS44OH0KICAgIGVsc2UgaWYoZW5QYWdlcz52aVBhZ2VzKjEuNCl7c3RhdGUuZG9jTGFuZz0iZW4iO3N0YXRlLmRvY0xhbmdDb25maWRlbmNlPS44OH0KICAgIGVsc2UgaWYodmlQYWdlcytlblBhZ2VzKXtzdGF0ZS5kb2NMYW5nPSJtaXhlZCI7c3RhdGUuZG9jTGFuZ0NvbmZpZGVuY2U9LjZ9CiAgICByZW5kZXJUZXNzRGlhZygpOwoKICAgIHJldHVybiB0cnVlOwogIH1jYXRjaChlKXsKICAgIGNvbnNvbGUuZXJyb3IoIk9DUiBlcnJvciIsZSk7CiAgICBzZXREZXRlY3QoImRldE9DUiIsZmFsc2UsIk9DUiBs4buXaSIpOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9Ik9DUiBraMO0bmcgY2jhuqF5IMSRxrDhu6NjOiAiK1N0cmluZyhlLm1lc3NhZ2V8fGUpOwogICAgcmV0dXJuIGZhbHNlOwogIH0KfQoKZnVuY3Rpb24gaGFzQ2xhaW1NYXJrZXIodCl7CiAgcmV0dXJuICEhY2xhaW1NYXJrZXJJbmZvKHQpOwp9Cgphc3luYyBmdW5jdGlvbiBzbWFydE9jckNsYWltcyhhdXRvPWZhbHNlKXsKICBpZighc3RhdGUucGRmKSByZXR1cm4gZmFsc2U7CgogIGNvbnN0IG49c3RhdGUucGRmLm51bVBhZ2VzOwogIC8vIENsYWltcyBj4bunYSBi4bqxbmcgVk4gdGjGsOG7nW5nIG7hurFtIG5nYXkgdHLGsOG7m2MgcGjhuqduIGjDrG5oIHbhur0uCiAgLy8gVuG7m2kgUERGIDE0IHRyYW5nIGPhu6dhIMSQaeG7gW4gVHLDumMsIHRo4bupIHThu7EgbsOgeSBPQ1IgdHJhbmcgMTIgxJDhuqZVIFRJw4pOLgogIGNvbnN0IHJhd09yZGVyPVtuLTIsbi0zLG4tMSxuLTQsbixuLTUsbi02LG4tN107CiAgY29uc3QgY2FuZGlkYXRlcz1bLi4ubmV3IFNldChyYXdPcmRlcildLmZpbHRlcihwPT5wPj0xICYmIHA8PW4pOwoKICBzZXREZXRlY3QoImRldE9DUiIsZmFsc2UsIsSQYW5nIE9DUiBjbGFpbXMuLi4iKTsKICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1hdXRvCiAgICA/ICJQREYgZOG6oW5nIHNjYW4g4oCUIMSRYW5nIHThu7EgcXXDqXQgY8OhYyB0cmFuZyBjdeG7kWkgxJHhu4MgdMOsbSBZw6p1IGPhuqd1IGLhuqNvIGjhu5kuLi4iCiAgICA6ICLEkGFuZyBxdcOpdCBjw6FjIHRyYW5nIGN14buRaSDEkeG7gyB0w6xtIFnDqnUgY+G6p3UgYuG6o28gaOG7mS4uLiI7CgogIGxldCBmb3VuZFBhZ2U9bnVsbDsKCiAgZm9yKGxldCBpPTA7aTxjYW5kaWRhdGVzLmxlbmd0aDtpKyspewogICAgY29uc3QgcD1jYW5kaWRhdGVzW2ldOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YE9DUiB5w6p1IGPhuqd1IGLhuqNvIGjhu5k6IHRyYW5nICR7cH0vJHtufSAoJHtpKzF9LyR7Y2FuZGlkYXRlcy5sZW5ndGh9KS4uLmA7CgogICAgY29uc3Qgb2s9YXdhaXQgb2NyU2VsZWN0ZWRQYWdlcyhbcF0sYE9DUiB0cmFuZyAke3B9YCk7CiAgICBpZighb2spewogICAgICAvLyBPQ1IgZmFpbCB0aMOsIHRob8OhdCBz4bqhY2gsIEtIw5RORyB0cmVvIFVJLgogICAgICAkKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPSIxMDAlIjsKICAgICAgcmV0dXJuIGZhbHNlOwogICAgfQoKICAgIGNvbnN0IHQ9c3RhdGUub2NyUGFnZXNbcF18fCIiOwogICAgaWYoaGFzQ2xhaW1NYXJrZXIodCkgfHwgbG9va3NMaWtlQ2xhaW1QYWdlKHQpKXsKICAgICAgZm91bmRQYWdlPXA7CiAgICAgIGJyZWFrOwogICAgfQogIH0KCiAgaWYoIWZvdW5kUGFnZSl7CiAgICBzdGF0ZS5yYXdUZXh0PW1lcmdlZFRleHQoKTsKICAgIGNvbnN0IGZhbGxiYWNrPWNhbmRpZGF0ZUNsYWltc1RleHQoKTsKICAgIHN0YXRlLmNsYWltc1RleHQ9ZmFsbGJhY2t8fCIiOwogICAgJCgiY2xhaW1zUmF3IikudmFsdWU9c3RhdGUuY2xhaW1zVGV4dDskKCJjbGFpbXNDbGVhbiIpLnZhbHVlPWZvcm1hdENsYWltRm9yRGlzcGxheShzdGF0ZS5jbGFpbXNUZXh0KTsKICAgIHN0YXRlLmNsYWltcz1wYXJzZUNsYWltcyhzdGF0ZS5jbGFpbXNUZXh0KTsKICAgIHN0YXRlLnNlbGVjdGVkPTA7CiAgICByZW5kZXJDbGFpbXMoKTsKICAgIHNldERldGVjdCgiZGV0Q2xhaW1zIixzdGF0ZS5jbGFpbXMubGVuZ3RoPjAsCiAgICAgIHN0YXRlLmNsYWltcy5sZW5ndGg/YMSQw6MgdMOhY2ggJHtzdGF0ZS5jbGFpbXMubGVuZ3RofSBjbGFpbWA6Ik9DUiB4b25nIG5oxrBuZyBjaMawYSB0w6xtIHRo4bqleSBjbGFpbSIpOwogICAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMTAwJSI7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1zdGF0ZS5jbGFpbXMubGVuZ3RoCiAgICAgID9gT0NSIGhvw6BuIHThuqV0LiDEkMOjIG5o4bqtbiBkaeG7h24gJHtzdGF0ZS5jbGFpbXMubGVuZ3RofSBjbGFpbS5gCiAgICAgIDoixJDDoyBxdcOpdCBjw6FjIHRyYW5nIGN14buRaSBuaMawbmcgY2jGsGEgbmjhuq1uIGRp4buHbiDEkcaw4bujYyBjbGFpbS4gQuG6oW4gduG6q24gY8OzIHRo4buDIHBhc3RlIGNsYWltcyDhu58gYsaw4bubYyAyLiI7CiAgICByZXR1cm4gc3RhdGUuY2xhaW1zLmxlbmd0aD4wOwogIH0KCiAgLy8gT0NSIHRow6ptIDEgdHJhbmcga+G6vyB0aeG6v3AgdsOsIGNsYWltcyBjw7MgdGjhu4Mga8OpbyBkw6BpIHNhbmcgdHJhbmcgc2F1LgogIGNvbnN0IGZvbGxvdz1mb3VuZFBhZ2UrMTsKICBpZihmb2xsb3c8PW4gJiYgIXN0YXRlLm9jclBhZ2VzW2ZvbGxvd10pewogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YMSQw6MgdMOsbSB0aOG6pXkgdHJhbmcgY2xhaW1zICR7Zm91bmRQYWdlfTsgxJFhbmcga2nhu4NtIHRyYSB0cmFuZyAke2ZvbGxvd30uLi5gOwogICAgYXdhaXQgb2NyU2VsZWN0ZWRQYWdlcyhbZm9sbG93XSxgT0NSIHRyYW5nICR7Zm9sbG93fWApOwogIH0KCiAgY29uc3QgY2xhaW1QYWdlcz1bZm91bmRQYWdlXTsKICBpZihmb2xsb3c8PW4gJiYgc3RhdGUub2NyUGFnZXNbZm9sbG93XSkgY2xhaW1QYWdlcy5wdXNoKGZvbGxvdyk7CiAgY29uc3Qgam9pbmVkPWNsYWltUGFnZXMubWFwKHA9PnN0YXRlLm9jclBhZ2VzW3BdfHwiIikuam9pbigiXG5cbiIpOwoKICBzdGF0ZS5yYXdUZXh0PW1lcmdlZFRleHQoKTsKICBsZXQgYz1leHRyYWN0Q2xhaW1zVGFpbChqb2luZWQpOwogIGlmKCFjKSBjPWNhbmRpZGF0ZUNsYWltc1RleHQoKTsKICBpZighYyAmJiBsb29rc0xpa2VDbGFpbVBhZ2Uoam9pbmVkKSkgYz1jbGVhbihqb2luZWQpOwoKICBzdGF0ZS5jbGFpbXNUZXh0PWN8fCIiOwogICQoImNsYWltc1JhdyIpLnZhbHVlPXN0YXRlLmNsYWltc1RleHQ7JCgiY2xhaW1zQ2xlYW4iKS52YWx1ZT1mb3JtYXRDbGFpbUZvckRpc3BsYXkoc3RhdGUuY2xhaW1zVGV4dCk7CiAgc3RhdGUuY2xhaW1zPXBhcnNlQ2xhaW1zKHN0YXRlLmNsYWltc1RleHQpOwogIHN0YXRlLnNlbGVjdGVkPTA7CiAgcmVuZGVyQ2xhaW1zKCk7CgogIHNldERldGVjdCgiZGV0Q2xhaW1zIixzdGF0ZS5jbGFpbXMubGVuZ3RoPjAsCiAgICBzdGF0ZS5jbGFpbXMubGVuZ3RoP2DEkMOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW1gOiLEkMOjIHRo4bqleSB0cmFuZyBjbGFpbXMgbmjGsG5nIHBhcnNlciBjaMawYSB0w6FjaCDEkcaw4bujYyIpOwogICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjEwMCUiOwogICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PXN0YXRlLmNsYWltcy5sZW5ndGgKICAgID9gSG/DoG4gdOG6pXQuIFTDrG0gdGjhuqV5IFnDqnUgY+G6p3UgYuG6o28gaOG7mSDhu58gdHJhbmcgJHtmb3VuZFBhZ2V9IHbDoCDEkcOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW0uYAogICAgOmDEkMOjIHTDrG0gdGjhuqV5IHRyYW5nIFnDqnUgY+G6p3UgYuG6o28gaOG7mSAke2ZvdW5kUGFnZX0sIG5oxrBuZyBj4bqnbiBraeG7g20gdHJhIG7hu5lpIGR1bmcg4bufIGLGsOG7m2MgMi5gOwoKICByZXR1cm4gc3RhdGUuY2xhaW1zLmxlbmd0aD4wOwp9CgpmdW5jdGlvbiBtZXJnZWRUZXh0KCl7CiAgY29uc3Qgb3V0PVtdOwogIGZvcihsZXQgaT0wO2k8c3RhdGUucGFnZVRleHQubGVuZ3RoO2krKyl7CiAgICBjb25zdCBkaXJlY3Q9c3RhdGUucGFnZVRleHRbaV18fCIiOwogICAgY29uc3QgcT1zdGF0ZS5wYWdlUXVhbGl0eVtpXXx8MDsKICAgIGNvbnN0IG9jcj1zdGF0ZS5vY3JQYWdlc1tpKzFdfHwiIjsKICAgIG91dC5wdXNoKHE+PTQ4ID8gZGlyZWN0IDogKG9jcnx8ZGlyZWN0KSk7CiAgfQogIHJldHVybiBvdXQuam9pbigiXG5cbiIpOwp9CgpmdW5jdGlvbiBjbGFpbUNhbmRpZGF0ZVNjb3JlKHRleHQpewogIGlmKCF0ZXh0KSByZXR1cm4gLTk5OTsKICBsZXQgc2NvcmU9dGV4dExheWVyUXVhbGl0eVNjb3JlKHRleHQpOwogIGlmKGhhc0NsYWltTWFya2VyKHRleHQpKSBzY29yZSs9NDU7CiAgaWYobG9va3NMaWtlQ2xhaW1QYWdlKHRleHQpKSBzY29yZSs9MzA7CiAgY29uc3QgcGFyc2VkPXBhcnNlQ2xhaW1zKGV4dHJhY3RDbGFpbXNUYWlsKHRleHQpfHx0ZXh0KTsKICBzY29yZSs9TWF0aC5taW4oNDAscGFyc2VkLmxlbmd0aCoxMCk7CiAgY29uc3QgZ2FyYmFnZT0odGV4dC5tYXRjaCgvXGQrXHMqXC9ccypcZCsvZyl8fFtdKS5sZW5ndGg7CiAgc2NvcmUtPWdhcmJhZ2UqODsKICByZXR1cm4gc2NvcmU7Cn0KCmZ1bmN0aW9uIGNhbmRpZGF0ZUNsYWltc1RleHQoKXsKICBjb25zdCBjYW5kaWRhdGVzPVtdOwoKICAvLyAxKSDGr3UgdGnDqm4gdGV4dCBsYXllciBz4bqhY2guIEtIw5RORyBkw7luZyBi4bqjbiBsZWZ0L3JpZ2h0IGdow6lwIMSRw7RpIG7hur91IGtow7RuZyBj4bqnbi4KICBmb3IobGV0IGk9MDtpPHN0YXRlLnBhZ2VUZXh0Lmxlbmd0aDtpKyspewogICAgY29uc3Qgc3JjPXN0YXRlLnBhZ2VUZXh0W2ldfHwiIjsKICAgIGNvbnN0IHE9c3RhdGUucGFnZVF1YWxpdHlbaV18fDA7CiAgICBpZihxPDQ4KSBjb250aW51ZTsKCiAgICBpZihoYXNDbGFpbU1hcmtlcihzcmMpfHxsb29rc0xpa2VDbGFpbVBhZ2Uoc3JjKSl7CiAgICAgIGNvbnN0IGpvaW5lZD1bc3JjXTsKICAgICAgZm9yKGxldCBqPWkrMTtqPE1hdGgubWluKHN0YXRlLnBhZ2VUZXh0Lmxlbmd0aCxpKzUpO2orKyl7CiAgICAgICAgaWYoKHN0YXRlLnBhZ2VRdWFsaXR5W2pdfHwwKT49NDgpIGpvaW5lZC5wdXNoKHN0YXRlLnBhZ2VUZXh0W2pdKTsKICAgICAgfQogICAgICBjb25zdCBibG9jaz1qb2luZWQuam9pbigiXG5cbiIpOwogICAgICBjb25zdCB0YWlsPWV4dHJhY3RDbGFpbXNUYWlsKGJsb2NrKXx8YmxvY2s7CiAgICAgIGNhbmRpZGF0ZXMucHVzaCh7dGV4dDp0YWlsLHNjb3JlOmNsYWltQ2FuZGlkYXRlU2NvcmUodGFpbCkrMjV9KTsKICAgIH0KICB9CgogIC8vIDIpIE9DUiBwYWdlcy4KICBmb3IoY29uc3Qgc3JjIG9mIE9iamVjdC52YWx1ZXMoc3RhdGUub2NyUGFnZXMpKXsKICAgIGlmKCFzcmMpIGNvbnRpbnVlOwogICAgY29uc3QgdGFpbD1leHRyYWN0Q2xhaW1zVGFpbChzcmMpfHxzcmM7CiAgICBjYW5kaWRhdGVzLnB1c2goe3RleHQ6dGFpbCxzY29yZTpjbGFpbUNhbmRpZGF0ZVNjb3JlKHRhaWwpfSk7CiAgfQoKICAvLyAzKSBDb2x1bW4gcmVjb25zdHJ1Y3Rpb24gb25seSBhcyBhIGxhc3QgcmVzb3J0LgogIGlmKCFjYW5kaWRhdGVzLmxlbmd0aCl7CiAgICBmb3IoY29uc3Qgc3JjIG9mIHN0YXRlLnBhZ2VDb2x1bW5UZXh0KXsKICAgICAgaWYoIXNyYykgY29udGludWU7CiAgICAgIGNvbnN0IHRhaWw9ZXh0cmFjdENsYWltc1RhaWwoc3JjKTsKICAgICAgaWYodGFpbCkgY2FuZGlkYXRlcy5wdXNoKHt0ZXh0OnRhaWwsc2NvcmU6Y2xhaW1DYW5kaWRhdGVTY29yZSh0YWlsKS0yMH0pOwogICAgfQogIH0KCiAgY2FuZGlkYXRlcy5zb3J0KChhLGIpPT5iLnNjb3JlLWEuc2NvcmUpOwogIGNvbnN0IGJlc3Q9Y2FuZGlkYXRlc1swXTsKICByZXR1cm4gYmVzdCYmYmVzdC5zY29yZT49NDUgPyBiZXN0LnRleHQuc2xpY2UoMCw4MDAwMCkgOiAiIjsKfQoKZnVuY3Rpb24gcGFyc2VDbGFpbXModGV4dCl7CiAgbGV0IHQ9dHJ1bmNhdGVDbGFpbUF0RmlndXJlKHJlcGFpckNlcnRhaW5Wbk9jcih0ZXh0fHwiIikpLnJlcGxhY2UoL1xyL2csIlxuIik7CgogIC8vIE9DUiB0aMaw4budbmcgY2hvOiAiMSAuIiwgIjEpIiwgIjEgKSIsIGhv4bq3YyB4deG7kW5nIGTDsm5nIHRyxrDhu5tjIHPhu5EuCiAgdD10LnJlcGxhY2UoLyg/Ol58XG4pXHMqKFxkezEsMn0pXHMqW1wuXCldXHMqL2csIlxuJDEuICIpOwoKICBsZXQgbWF0Y2hlcz1bLi4udC5tYXRjaEFsbCgvKD86XnxcbilccyooXGR7MSwyfSlcLlxzKihbXHNcU10qPykoPz0oPzpcblxzKlxkezEsMn1cLlxzKil8JCkvZyldOwogIGxldCBhcnI9bWF0Y2hlcwogICAgLm1hcChtPT4oe2lkOittWzFdLHRleHQ6Y2xlYW4obVsyXSl9KSkKICAgIC5maWx0ZXIoeD0+eC50ZXh0Lmxlbmd0aD4xNSk7CgogIC8vIEZhbGxiYWNrIGTDoG5oIGNobyBPQ1IgbMOgbSBt4bqldCBk4bqldSAiLiIgc2F1IHPhu5EgY2xhaW0uCiAgaWYoIWFyci5sZW5ndGgpewogICAgY29uc3QgZj1mb2xkVk4odCk7CiAgICBjb25zdCBmaXJzdD1mLnNlYXJjaCgvKD86XnxcbnxccykxXHMrKFFVWSBUUklOSHxQSFVPTkcgUEhBUHxTQU4gUEhBTXxUSElFVCBCSXxIRSBUSE9OR3xDSEUgUEhBTXxBXHN8QU5cc3xUSEVccykvKTsKICAgIGlmKGZpcnN0Pj0wKXsKICAgICAgY29uc3QgYm9keT1jbGVhbih0LnNsaWNlKGZpcnN0KSk7CiAgICAgIGFycj1be2lkOjEsdGV4dDpib2R5LnJlcGxhY2UoL15ccyoxXHMqLywiIil9XTsKICAgIH0KICB9CgogIGFycj1hcnIKICAgIC5maWx0ZXIoKHgsaSxhKT0+YS5maW5kSW5kZXgoeT0+eS5pZD09PXguaWQpPT09aSkKICAgIC5zb3J0KChhLGIpPT5hLmlkLWIuaWQpCiAgICAuc2xpY2UoMCw2MCk7CgogIHJldHVybiBhcnIubWFwKChjLGkpPT4oewogICAgLi4uYywKICAgIHR5cGU6L2FjY29yZGluZyB0byBjbGFpbVxzK1xkK3x0aGVvICg/OsSRaeG7g218ecOqdSBj4bqndSBi4bqjbyBo4buZfGNsYWltKVxzKlxkKy9pLnRlc3QoYy50ZXh0KQogICAgICA/IlBo4bulIHRodeG7mWMiCiAgICAgIDooaT09PTA/IsSQ4buZYyBs4bqtcCI6IkNoxrBhIHjDoWMgxJHhu4tuaCIpCiAgfSkpOwp9CmZ1bmN0aW9uIGd1ZXNzSnVyKHRleHQsbm8pewogaWYoL0Phu6RDIFPhu54gSOG7rlUgVFLDjSBUVeG7hnxD4buZbmcgaMOyYSB4w6MgaOG7mWkgY2jhu6cgbmdoxKlhIFZp4buHdCBOYW0vaS50ZXN0KHRleHQpfHwvXlsxMl0tXGR7NSx9Ly50ZXN0KG5vKSlyZXR1cm4iVk4iOwogaWYoL1VuaXRlZCBTdGF0ZXMgUGF0ZW50fFVcLlNcLiBQYXRlbnQvaS50ZXN0KHRleHQpfHwvXlVTL2kudGVzdChubykpcmV0dXJuIlVTIjsKIGlmKC9eV08vaS50ZXN0KG5vKSlyZXR1cm4iV08vUENUIjtpZigvXkVQL2kudGVzdChubykpcmV0dXJuIkVQIjtyZXR1cm4iS2jDoWMiOwp9CmZ1bmN0aW9uIHRhZ2dlZEZpZWxkKHRleHQsdGFnLG1heExlbj01MDApewogIGNvbnN0IHQ9c3RyaXBQZGZBcnRpZmFjdHModGV4dHx8IiIpOwogIGNvbnN0IHJlPW5ldyBSZWdFeHAoIlxcXFwoIit0YWcrIlxcXFwpXFxcXHMqKFtcXFxcc1xcXFxTXXsxLCIrbWF4TGVuKyJ9PykoPz1cXFxcKFxcXFxkezJ9XFxcXCl8JCkiLCJpIik7CiAgY29uc3QgbT10Lm1hdGNoKHJlKTsKICByZXR1cm4gbT9jbGVhbk1ldGFWYWx1ZShtWzFdKToiIjsKfQoKZnVuY3Rpb24gZXh0cmFjdE1ldGFkYXRhKHRleHQpewogIGNvbnN0IHQ9c3RyaXBQZGZBcnRpZmFjdHModGV4dHx8IiIpOwogIGNvbnN0IG5vPWZpcnN0TWF0Y2godCxbCiAgICAvXCgxMVwpXHMqKFsxMl0tXGR7NSw4fSkvaSwKICAgIC9cYihbMTJdLVxkezYsOH0pXGIvaSwKICAgIC9cYlBhdGVudFxzKk5vXC4/XHMqOj9ccyooVVNccypbXGQsXStccypbQUJdXGQpXGIvaSwKICAgIC9cYihVU1xzP1xkezcsMTF9XHM/W0FCXVxkKVxiL2ksCiAgICAvXGIoV09ccz9cZHs0fVwvXGR7NSw3fVxzP1tBLVpdXGQ/KVxiL2kKICBdKS5yZXBsYWNlKC9ccysvZywiICIpOwoKICBsZXQgdGl0bGU9dGFnZ2VkRmllbGQodCwiNTQiLDM1MCkgfHwgZmlyc3RNYXRjaCh0LFsvVGl0bGVccyo6P1xzKihbXlxuXXs1LDI1MH0pL2ldKTsKICB0aXRsZT1zYW5pdGl6ZVBhdGVudFRpdGxlKHRpdGxlKTsKCiAgbGV0IGZpbGluZz10YWdnZWRGaWVsZCh0LCIyMiIsODApIHx8IGZpcnN0TWF0Y2godCxbL0ZpbGVkXHMqOj9ccyooW0EtWmEtel17Myw5fVwuP1xzK1xkezEsMn0sXHMrXGR7NH0pL2ldKTsKICBmaWxpbmc9bm9ybURhdGUoZmlsaW5nKTsKCiAgY29uc3QgYXBwbGljYW50PWNsZWFuTWV0YVZhbHVlKAogICAgdGFnZ2VkRmllbGQodCwiNzMiLDUwMCkgfHwKICAgIHRhZ2dlZEZpZWxkKHQsIjcxIiw1MDApIHx8CiAgICBmaXJzdE1hdGNoKHQsWy9Bc3NpZ25lZVxzKjo/XHMqKFteXG5dezMsMjUwfSkvaSwvQXBwbGljYW50XHMqOj9ccyooW15cbl17MywyNTB9KS9pXSkKICApOwoKICBjb25zdCByZXA9Y2xlYW5NZXRhVmFsdWUoCiAgICB0YWdnZWRGaWVsZCh0LCI3NCIsNDAwKSB8fAogICAgZmlyc3RNYXRjaCh0LFsvUmVwcmVzZW50YXRpdmVccyo6P1xzKihbXlxuXXszLDI1MH0pL2ldKQogICk7CgogIGNvbnN0IGlwYz1jbGVhbk1ldGFWYWx1ZSgKICAgIHRhZ2dlZEZpZWxkKHQsIjUxIiwzNTApIHx8CiAgICBmaXJzdE1hdGNoKHQsWy9JbnRcLlxzKkNsXC4/XHMqOj9ccyooW15cbl17NSwyMjB9KS9pXSkKICApOwoKICBsZXQgYWJzPXRhZ2dlZEZpZWxkKHQsIjU3IiwxODAwKSB8fAogICAgZmlyc3RNYXRjaCh0LFsvQUJTVFJBQ1RccyooW1xzXFNdezQwLDE1MDB9PykoPz1GSUVMRCBPRnxCQUNLR1JPVU5EfENMQUlNUz8pL2ldKTsKICBhYnM9Y2xlYW5NZXRhVmFsdWUoYWJzKS5zbGljZSgwLDE4MDApOwoKICByZXR1cm57bm8sdGl0bGUsZmlsaW5nLGFwcGxpY2FudCxyZXAsaXBjLGFicyxqdXI6Z3Vlc3NKdXIodCxubyl9Cn0KCmZ1bmN0aW9uIGZpbGxNZXRhKG0pewogJCgicGF0ZW50Tm8iKS52YWx1ZT1tLm5vOyQoInRpdGxlIikudmFsdWU9bS50aXRsZTskKCJmaWxpbmdEYXRlIikudmFsdWU9bS5maWxpbmc7JCgiYXBwbGljYW50IikudmFsdWU9bS5hcHBsaWNhbnQ7JCgicmVwcmVzZW50YXRpdmUiKS52YWx1ZT1tLnJlcDskKCJpcGMiKS52YWx1ZT1tLmlwYzskKCJhYnN0cmFjdCIpLnZhbHVlPW0uYWJzOwogWy4uLiQoImp1cmlzZGljdGlvbiIpLm9wdGlvbnNdLmZvckVhY2goKG8saSk9PntpZihvLnZhbHVlPT09bS5qdXIpJCgianVyaXNkaWN0aW9uIikuc2VsZWN0ZWRJbmRleD1pfSk7CiBjb25zdCBiYXNlPShtLm5vfHwiUEFUIikucmVwbGFjZSgvXHMvZywiIikucmVwbGFjZSgvW15BLVphLXowLTktXS9nLCIiKTskKCJjYXNlSWQiKS52YWx1ZT0obS5qdXJ8fCJDQVNFIikrIi0iK2Jhc2U7JCgiY2FzZUJhZGdlIikudGV4dENvbnRlbnQ9JCgiY2FzZUlkIikudmFsdWU7CiBzZXREZXRlY3QoImRldE1ldGEiLCEhKG0ubm98fG0udGl0bGUpLG0ubm98fG0udGl0bGU/IsSQw6Mgbmjhuq1uIGRp4buHbiI6IkPhuqduIGtp4buDbSB0cmEiKTsKIHNldERldGVjdCgiZGV0QWJzdHJhY3QiLCEhbS5hYnMsbS5hYnM/IsSQw6Mgbmjhuq1uIGRp4buHbiI6IkNoxrBhIHTDrG0gdGjhuqV5Iik7Cn0KYXN5bmMgZnVuY3Rpb24gcHJvY2Vzc0ZpbGUoZmlsZSl7CiAgc3RhdGUub2NyUGFnZXM9e307CiAgc3RhdGUuY2xhaW1zPVtdOwogIHN0YXRlLmNsYWltc1RleHQ9IiI7CiAgc3RhdGUuZmVhdHVyZXM9W107CiAgc3RhdGUuc2VhcmNoPVtdOwogIHN0YXRlLnF1ZXJpZXM9W107CiAgc3RhdGUucHJpb3I9e307CiAgc3RhdGUubWF0cml4PVtdOwogICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjMlIjsKICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD0ixJBhbmcgbeG7nyBQREYuLi4iOwoKICB0cnl7CiAgICBhd2FpdCByZWFkUGRmKGZpbGUpOwogICAgcmVuZGVyVGVzc0RpYWcoKTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLmVycm9yKGUpOwogICAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMTAwJSI7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD0iS2jDtG5nIHRo4buDIG3hu58gUERGOiAiKyhlJiZlLm1lc3NhZ2U/ZS5tZXNzYWdlOmUpOwogICAgYWxlcnQoIktow7RuZyB0aOG7gyBt4bufIGZpbGUgUERGIG7DoHkuIik7CiAgICByZXR1cm47CiAgfQoKICBjb25zdCBxPXRleHRRdWFsaXR5KCk7CiAgbGV0IGNvbWJpbmVkPW1lcmdlZFRleHQoKTsKICBzdGF0ZS5yYXdUZXh0PWNvbWJpbmVkOwoKICAvLyBNZXRhZGF0YSBjaOG7iSBs4bqleSB04burIHRyYW5nIMSR4bqndSDEkeG7gyB0csOhbmggZm9vdGVyL3BhZ2UgY291bnRlciBj4bunYSB0b8OgbiB0w6BpIGxp4buHdSBjaHVpIHbDoG8gdGl0bGUuCiAgbGV0IGZpcnN0PXN0YXRlLnBhZ2VUZXh0WzBdfHwiIjsKICBsZXQgZmlyc3RRdWFsaXR5PXN0YXRlLnBhZ2VRdWFsaXR5WzBdfHwwOwogIGxldCBtZXRhPXt9OwoKICBpZihmaXJzdFF1YWxpdHk+PTQ4KXsKICAgIHRyeXsKICAgICAgbWV0YT1leHRyYWN0TWV0YWRhdGEoZmlyc3QpOwogICAgICBmaWxsTWV0YShtZXRhKTsKICAgICAgc2V0RGV0ZWN0KCJkZXRPQ1IiLHRydWUsIktow7RuZyBj4bqnbiBPQ1IgwrcgdGV4dCBsYXllciB04buRdCIpOwogICAgfWNhdGNoKGUpe2NvbnNvbGUud2FybigiTWV0YWRhdGEgdGV4dC1sYXllciBlcnJvciIsZSl9CiAgfQoKICAvLyBO4bq/dSB0ZXh0IGxheWVyIHRyYW5nIMSR4bqndSBrw6ltIGhv4bq3YyBtZXRhZGF0YSBjw7JuIHRoaeG6v3UsIE9DUiDEkcO6bmcgdHJhbmcgxJHhuqd1LgogIGlmKGZpcnN0UXVhbGl0eTw0OCB8fCAhbWV0YS5ubyB8fCAhbWV0YS50aXRsZSl7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD0iVGV4dCBsYXllciBjw7MgZOG6pXUgaGnhu4d1IGzhu5dpIG3Doy9mb250IOKAlCDEkWFuZyBPQ1IgdHJhbmcgxJHhuqd1Li4uIjsKICAgIGNvbnN0IG9rTWV0YT1hd2FpdCBvY3JTZWxlY3RlZFBhZ2VzKFsxXSwiT0NSIG1ldGFkYXRhIik7CiAgICBpZihva01ldGEgJiYgc3RhdGUub2NyUGFnZXNbMV0pewogICAgICB0cnl7CiAgICAgICAgY29uc3Qgb2NyTWV0YT1leHRyYWN0TWV0YWRhdGEoc3RhdGUub2NyUGFnZXNbMV0pOwogICAgICAgIC8vIENo4buJIHRoYXkgYuG6sW5nIE9DUiBu4bq/dSBPQ1IgdMOsbSDEkcaw4bujYyB0csaw4budbmcgdOG7kXQgaMahbi4KICAgICAgICBtZXRhPXsKICAgICAgICAgIC4uLm1ldGEsCiAgICAgICAgICBubzpvY3JNZXRhLm5vfHxtZXRhLm5vfHwiIiwKICAgICAgICAgIHRpdGxlOm9jck1ldGEudGl0bGV8fG1ldGEudGl0bGV8fCIiLAogICAgICAgICAgZmlsaW5nOm9jck1ldGEuZmlsaW5nfHxtZXRhLmZpbGluZ3x8IiIsCiAgICAgICAgICBhcHBsaWNhbnQ6b2NyTWV0YS5hcHBsaWNhbnR8fG1ldGEuYXBwbGljYW50fHwiIiwKICAgICAgICAgIHJlcDpvY3JNZXRhLnJlcHx8bWV0YS5yZXB8fCIiLAogICAgICAgICAgaXBjOm9jck1ldGEuaXBjfHxtZXRhLmlwY3x8IiIsCiAgICAgICAgICBhYnM6b2NyTWV0YS5hYnN8fG1ldGEuYWJzfHwiIiwKICAgICAgICAgIGp1cjpvY3JNZXRhLmp1cnx8bWV0YS5qdXJ8fCJWTiIKICAgICAgICB9OwogICAgICAgIGZpbGxNZXRhKG1ldGEpOwogICAgICB9Y2F0Y2goZSl7Y29uc29sZS53YXJuKCJPQ1IgbWV0YWRhdGEgcGFyc2UgZXJyb3IiLGUpfQogICAgfQogIH0KCiAgLy8gQ2xhaW1zOiBkaXJlY3QgdGV4dCBsYXllciBmaXJzdCBpZiBjbGVhbi4KICBsZXQgY2xhaW1zPSIiOwogIHRyeXtjbGFpbXM9Y2FuZGlkYXRlQ2xhaW1zVGV4dCgpfWNhdGNoKGUpe2NvbnNvbGUud2FybihlKX0KCiAgaWYoY2xhaW1zICYmIGNsYWltQ2FuZGlkYXRlU2NvcmUoY2xhaW1zKT49NDUpewogICAgc3RhdGUuY2xhaW1zVGV4dD1zdHJpcFBkZkFydGlmYWN0cyhjbGFpbXMpOwogICAgJCgiY2xhaW1zUmF3IikudmFsdWU9c3RhdGUuY2xhaW1zVGV4dDsKICAgICQoImNsYWltc0NsZWFuIikudmFsdWU9Zm9ybWF0Q2xhaW1Gb3JEaXNwbGF5KHN0YXRlLmNsYWltc1RleHQpOwogICAgc3RhdGUuY2xhaW1zPXBhcnNlQ2xhaW1zKHN0YXRlLmNsYWltc1RleHQpOwogICAgc3RhdGUuc2VsZWN0ZWQ9MDsKICAgIHJlbmRlckNsYWltcygpOwogIH0KCiAgLy8gTuG6v3UgY2xhaW0gduG6q24ga2jDtG5nIMSR4bunIHRpbiBj4bqteSwgT0NSIGNo4buJIGPDoWMgdHJhbmcgY3Xhu5FpLgogIGlmKCFzdGF0ZS5jbGFpbXMubGVuZ3RoKXsKICAgIGF3YWl0IHNtYXJ0T2NyQ2xhaW1zKHRydWUpOwogIH0KCiAgc3RhdGUucmF3VGV4dD1tZXJnZWRUZXh0KCk7CiAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMTAwJSI7CgogIGlmKHN0YXRlLmNsYWltcy5sZW5ndGgpewogICAgc2V0RGV0ZWN0KCJkZXRDbGFpbXMiLHRydWUsYMSQw6MgdMOhY2ggJHtzdGF0ZS5jbGFpbXMubGVuZ3RofSBjbGFpbWApOwogICAgY29uc3QgbW9kZT1zdGF0ZS5iYWRUZXh0UGFnZXMubGVuZ3RoCiAgICAgID9gQ8OzICR7c3RhdGUuYmFkVGV4dFBhZ2VzLmxlbmd0aH0gdHJhbmcgdGV4dCBsYXllciBrw6ltOyDEkcOjIHThu7EgZMO5bmcgT0NSIGtoaSBj4bqnbi5gCiAgICAgIDpgxJDhu41jIHRy4buxYyB0aeG6v3AgdGV4dCBsYXllciDCtyAke2xhbmd1YWdlTGFiZWwoc3RhdGUuZG9jTGFuZyl9IMK3IFVuaWNvZGUgTkZDLmA7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1gSG/DoG4gdOG6pXQuICR7bW9kZX1gOwogIH1lbHNlewogICAgc2V0RGV0ZWN0KCJkZXRDbGFpbXMiLGZhbHNlLCJDaMawYSB04buxIHTDoWNoIMSRxrDhu6NjIGNsYWltIik7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD0ixJDDoyB44butIGzDvSBQREYgbmjGsG5nIGNoxrBhIHTDoWNoIMSRxrDhu6NjIGNsYWltLiBLaeG7g20gdHJhIGLGsOG7m2MgMi4iOwogIH0KfQokKCJwZGZJbnB1dCIpLm9uY2hhbmdlPWU9PntpZihlLnRhcmdldC5maWxlc1swXSlwcm9jZXNzRmlsZShlLnRhcmdldC5maWxlc1swXSl9Owpjb25zdCBkej0kKCJkcm9wWm9uZSIpO1siZHJhZ2VudGVyIiwiZHJhZ292ZXIiXS5mb3JFYWNoKGV2PT5kei5hZGRFdmVudExpc3RlbmVyKGV2LGU9PntlLnByZXZlbnREZWZhdWx0KCk7ZHouY2xhc3NMaXN0LmFkZCgiZHJhZyIpfSkpO1siZHJhZ2xlYXZlIiwiZHJvcCJdLmZvckVhY2goZXY9PmR6LmFkZEV2ZW50TGlzdGVuZXIoZXYsZT0+e2UucHJldmVudERlZmF1bHQoKTtkei5jbGFzc0xpc3QucmVtb3ZlKCJkcmFnIil9KSk7ZHouYWRkRXZlbnRMaXN0ZW5lcigiZHJvcCIsZT0+e2xldCBmPWUuZGF0YVRyYW5zZmVyLmZpbGVzWzBdO2lmKGYpcHJvY2Vzc0ZpbGUoZil9KTsKJCgicmV0cnlPQ1IiKS5vbmNsaWNrPWFzeW5jKCk9PntpZighc3RhdGUucGRmKXJldHVybiBhbGVydCgiQ2jGsGEgY8OzIFBERi4iKTtzdGF0ZS5vY3JQYWdlcz17fTtzdGF0ZS5jbGFpbVNvdXJjZUJ5UGFnZT17fTtvY3JXb3JrZXJQcm9taXNlPW51bGw7YXdhaXQgc21hcnRPY3JDbGFpbXMoZmFsc2UpfTsKJCgib2NyQ2xhaW1zQWdhaW4iKS5vbmNsaWNrPWFzeW5jKCk9PntpZighc3RhdGUucGRmKXJldHVybiBhbGVydCgiQ2jGsGEgY8OzIFBERi4iKTtzdGF0ZS5vY3JQYWdlcz17fTtzdGF0ZS5jbGFpbVNvdXJjZUJ5UGFnZT17fTtvY3JXb3JrZXJQcm9taXNlPW51bGw7YXdhaXQgc21hcnRPY3JDbGFpbXMoZmFsc2UpfTsKCmZ1bmN0aW9uIHJlbmRlckNsYWltcygpewogJCgiY2xhaW1TZWxlY3QiKS5pbm5lckhUTUw9c3RhdGUuY2xhaW1zLm1hcCgoYyxpKT0+YDxvcHRpb24gdmFsdWU9IiR7aX0iPkNsYWltICR7Yy5pZH0gwrcgJHtjLnR5cGV9PC9vcHRpb24+YCkuam9pbigiIik7CiBpZighc3RhdGUuY2xhaW1zLmxlbmd0aCl7CiAgICQoImNsYWltTGlzdCIpLmNsYXNzTmFtZT0iZW1wdHkiOwogICAkKCJjbGFpbUxpc3QiKS5pbm5lckhUTUw9IkNoxrBhIGPDsyBjbGFpbS4iOwogICByZXR1cm47CiB9CiAkKCJjbGFpbUxpc3QiKS5jbGFzc05hbWU9IiI7CiAkKCJjbGFpbUxpc3QiKS5pbm5lckhUTUw9c3RhdGUuY2xhaW1zLm1hcCgoYyxpKT0+ewogICBjb25zdCBwcmV0dHk9ZXNjKGZvcm1hdENsYWltRm9yRGlzcGxheShjLnRleHQpKS5yZXBsYWNlKC9cbi9nLCI8YnI+Iik7CiAgIHJldHVybiBgPGRpdiBjbGFzcz0iY2xhaW0iPgogICAgICA8aDQ+Q2xhaW0gJHtjLmlkfSA8c3BhbiBjbGFzcz0icGlsbCAke2MudHlwZT09PSLEkOG7mWMgbOG6rXAiPyJibHVlIjoiIn0iPiR7Yy50eXBlfTwvc3Bhbj48L2g0PgogICAgICA8ZGl2IGNsYXNzPSJjbGFpbS1jbGVhbiI+JHtwcmV0dHl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biAke2k9PT1zdGF0ZS5zZWxlY3RlZD8ic3VjY2VzcyI6IiJ9IiBkYXRhLWNsYWltPSIke2l9Ij4ke2k9PT1zdGF0ZS5zZWxlY3RlZD8ixJBhbmcgY2jhu41uIjoiQ2jhu41uIGNsYWltIG7DoHkifTwvYnV0dG9uPjwvZGl2PgogICA8L2Rpdj5gOwogfSkuam9pbigiIik7CiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1jbGFpbV0iKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+ewogICBzdGF0ZS5zZWxlY3RlZD0rYi5kYXRhc2V0LmNsYWltOwogICAkKCJjbGFpbVNlbGVjdCIpLnZhbHVlPXN0YXRlLnNlbGVjdGVkOwogICByZW5kZXJDbGFpbXMoKTsKIH0pOwp9CiQoInBhcnNlQ2xhaW1zIikub25jbGljaz0oKT0+ewogICAgICBjb25zdCBzb3VyY2U9JCgiY2xhaW1zQ2xlYW4iKS52YWx1ZXx8JCgiY2xhaW1zUmF3IikudmFsdWU7CiAgICAgIHN0YXRlLmNsYWltc1RleHQ9bm9ybWFsaXplT2NyVGV4dChzb3VyY2UpOwogICAgICAkKCJjbGFpbXNDbGVhbiIpLnZhbHVlPWZvcm1hdENsYWltRm9yRGlzcGxheShzdGF0ZS5jbGFpbXNUZXh0KTsKICAgICAgJCgiY2xhaW1zUmF3IikudmFsdWU9c3RhdGUuY2xhaW1zVGV4dDsKICAgICAgc3RhdGUuY2xhaW1zPXBhcnNlQ2xhaW1zKHN0YXRlLmNsYWltc1RleHQpOwogICAgICBzdGF0ZS5zZWxlY3RlZD0wOwogICAgICByZW5kZXJDbGFpbXMoKTsKICAgICAgc2V0RGV0ZWN0KCJkZXRDbGFpbXMiLHN0YXRlLmNsYWltcy5sZW5ndGg+MCxzdGF0ZS5jbGFpbXMubGVuZ3RoP2DEkMOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW1gOiJDaMawYSB0w6xtIHRo4bqleSBjbGFpbSIpOwogICAgfTsKCmZ1bmN0aW9uIGZlYXR1cmVTcGxpdCh0ZXh0KXsKICBsZXQgdD1ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKQogICAgLnJlcGxhY2UoL15ccyooPzphfGFufHRoZSk/XHMqKD86cXV5IHRyw6xuaHxwaMawxqFuZyBwaMOhcHxtZXRob2R8cHJvY2Vzc3xjb21wb3NpdGlvbnxkZXZpY2V8c3lzdGVtKVteOl17MCwyMjB9KD86YmFvIGfhu5NtfGNvbXByaXNpbmd8Y29tcHJpc2VzKVxzKjo/XHMqL2ksIiIpOwoKICBjb25zdCBjb25uZWN0b3JzPS9cYig/OnNhdSDEkcOzfHRp4bq/cCB0aGVvfGvhur8gdGnhur9wfHRyb25nIMSRw7N8xJHhu5NuZyB0aOG7nWl8dGjhu7FjIGhp4buHbnzEkcaw4bujYyB0aOG7sWMgaGnhu4dufHdoZXJlaW58dGhlbnxzdWJzZXF1ZW50bHkpXGIvaWc7CiAgbGV0IHNlZz1bXTsKICBjb25zdCByb21hbj1bLi4udC5tYXRjaEFsbCgvXCgoaXsxLDN9fGl2fHZ8dml7MCwzfXxpeHx4fHhpezAsM318eGl2fHh2fHh2aXswLDN9KVwpXHMqL2lnKV07CgogIGlmKHJvbWFuLmxlbmd0aD49Mil7CiAgICBmb3IobGV0IGk9MDtpPHJvbWFuLmxlbmd0aDtpKyspewogICAgICBjb25zdCBhPXJvbWFuW2ldLmluZGV4K3JvbWFuW2ldWzBdLmxlbmd0aDsKICAgICAgY29uc3QgYj1pKzE8cm9tYW4ubGVuZ3RoP3JvbWFuW2krMV0uaW5kZXg6dC5sZW5ndGg7CiAgICAgIGNvbnN0IHM9Y2xlYW4odC5zbGljZShhLGIpKS5yZXBsYWNlKC9bOyxdKyQvLCIiKTsKICAgICAgaWYocy5sZW5ndGg+MTgpIHNlZy5wdXNoKHMpOwogICAgfQogIH1lbHNlewogICAgc2VnPXQKICAgICAgLnJlcGxhY2UoY29ubmVjdG9ycywiOyAiKQogICAgICAuc3BsaXQoLztccyt8XG4oPz1ccyooPzpcZCtbXC5cKV18XC18XOKAoikpLykKICAgICAgLm1hcChjbGVhbikKICAgICAgLmZpbHRlcih4PT54Lmxlbmd0aD4xOCk7CiAgfQoKICAvLyBH4buZcCBjw6FjIG3huqNuaCBxdcOhIG5n4bqvbiDEkeG7gyB0csOhbmggZmVhdHVyZSBraeG7g3UgIjUzLDIlIHRpbmgiLgogIGNvbnN0IG1lcmdlZD1bXTsKICBmb3IoY29uc3QgcyBvZiBzZWcpewogICAgaWYobWVyZ2VkLmxlbmd0aCAmJiAocy5zcGxpdCgvXHMrLykubGVuZ3RoPDQgfHwgcy5sZW5ndGg8MjgpKXsKICAgICAgbWVyZ2VkW21lcmdlZC5sZW5ndGgtMV0rPSI7ICIrczsKICAgIH1lbHNlIG1lcmdlZC5wdXNoKHMpOwogIH0KCiAgcmV0dXJuIG1lcmdlZC5zbGljZSgwLDMwKS5tYXAoKHgsaSk9PnsKICAgIGNvbnN0IGY9Zm9sZFZOKHgpOwogICAgbGV0IHR5cGU9IlF1eSB0csOsbmgiOwogICAgaWYoL1xiKEVOWllNRXxCT1R8VEhBTkggUEhBTnxUWSBMRXxOR1VZRU4gTElFVXxFWFRSQUNUfE9JTHxDT01QT1NJVElPTnxBQ0lEfFBPTFlNRVJ8SE9QIENIQVQpXGIvLnRlc3QoZikpIHR5cGU9IlRow6BuaCBwaOG6p24vTmd1ecOqbiBsaeG7h3UiOwogICAgZWxzZSBpZigvXGIoS0lFTSBUUkF8WEFDIERJTkh8RE8gTFVPTkd8Q0hFQ0t8REVURVJNSU58TUVBU1VSRXxQSHxETyBBTXxOSElFVCBETylcYi8udGVzdChmKSkgdHlwZT0iS2nhu4NtIHNvw6F0IjsKICAgIGVsc2UgaWYoL1xiKENIQU1CRVJ8UFVNUHxUVUJFfEFQUEFSQVRVU3xERVZJQ0V8U1lTVEVNfFRISUVUIEJJfEJPIFBIQU58Q0FVIFRSVUMpXGIvLnRlc3QoZikpIHR5cGU9IlRoaeG6v3QgYuG7iy9D4bqldSB0csO6YyI7CiAgICBjb25zdCB3b3Jkcz14LnNwbGl0KC9ccysvKS5sZW5ndGg7CiAgICBjb25zdCBjb25mPXdvcmRzPj03JiZ3b3Jkczw9NDA/IkNhbyI6d29yZHM+PTQ/IlRydW5nIGLDrG5oIjoiVGjhuqVwIjsKICAgIHJldHVybiB7aWQ6YEYke1N0cmluZyhpKzEpLnBhZFN0YXJ0KDIsIjAiKX1gLHRleHQ6eCx0eXBlLGNvbmZ9OwogIH0pOwp9Cgpjb25zdCBTRUFSQ0hfU1RPUD1uZXcgU2V0KFsKICAidmEiLCJob2FjIiwiY3VhIiwiY2hvIiwidm9pIiwidHJvbmciLCJuZ29haSIsInRyZW4iLCJkdW9pIiwidHUiLCJkZW4iLCJ0YWkiLCJ0aGVvIiwic2F1IiwidHJ1b2MiLCJkbyIsIm5heSIsIm1vdCIsImNhYyIsIm5odW5nIiwKICAiZHVvYyIsInRodWMiLCJoaWVuIiwidGFvIiwiaG9uIiwiaG9wIiwiZHVuZyIsImRpY2giLCJwaG9pIiwidHJvbiIsInRodSIsInR1Iiwib24iLCJkaW5oIiwiZG9uZyIsInRob2kiLCJ0aWVwIiwiYmFvIiwiZ29tIiwiYnVvYyIsCiAgInF1eSIsInRyaW5oIiwicGh1b25nIiwicGhhcCIsInNhbiIsInBoYW0iLCJoZSIsInRob25nIiwidGhpZXQiLCJiaSIsIm5oYXQiLCJiYW5nIiwiY2FjaCIsInN1IiwiZHVuZyIsIm5oYW0iLCJkZSIsImtoaSIsIm5ldSIsImNvIiwKICAidGhlIiwibGEiLCJsYW0iLCJwaGFuIiwidmFvIiwicmEiLCJnaXVhIiwibW90IiwiaGFpIiwiYmEiLCJib24iLCJuYW0iLCJzYXUiLCJiYXkiLCJ0YW0iLCJjaGluIiwidHVvbmciLCJ1bmciLCJsYW4iLCJxdWEiLCJkb2kiLCJ2b2kiLAogICJ0aGUiLCJhbmQiLCJvciIsIndpdGgiLCJmcm9tIiwid2hlcmVpbiIsIm1ldGhvZCIsInByb2Nlc3MiLCJjb21wcmlzaW5nIiwiY29tcHJpc2VzIiwiaW5jbHVkaW5nIiwic3RlcCIsInN0ZXBzIiwidXNpbmciLCJ1c2VkIiwidXNlIiwKICAiZmlyc3QiLCJzZWNvbmQiLCJ0aGlyZCIsInRoZW4iLCJ0aGVyZW9mIiwidGhlcmVpbiIsInRoZXJlYnkiLCJzdWNoIiwidGhhdCIsIndoaWNoIiwiaW50byIsIm9udG8iCl0pOwoKZnVuY3Rpb24gZmVhdHVyZUNvcmVUZXJtcyh0ZXh0KXsKICBjb25zdCBvcmlnaW5hbD1ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKTsKICBjb25zdCB0b2tlbnM9Wy4uLm9yaWdpbmFsLm1hdGNoQWxsKC9bXHB7TH1ccHtOfVwtXC9cLl0rL2d1KV0ubWFwKG09Pm1bMF0pOwogIGNvbnN0IG91dD1bXTsKICBmb3IoY29uc3QgdG9rIG9mIHRva2Vucyl7CiAgICBjb25zdCBmPWZvbGRWTih0b2spLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW15hLXowLTlcLVwvXC5dL2csIiIpOwogICAgaWYoIWYgfHwgU0VBUkNIX1NUT1AuaGFzKGYpIHx8IGYubGVuZ3RoPDQpIGNvbnRpbnVlOwogICAgaWYoL15cZCsoPzpbXC4sXVxkKyk/JT8kLy50ZXN0KGYpKSBjb250aW51ZTsKICAgIGlmKCFvdXQuc29tZSh4PT5mb2xkVk4oeCkudG9Mb3dlckNhc2UoKT09PWYpKSBvdXQucHVzaCh0b2spOwogIH0KICByZXR1cm4gb3V0LnNsaWNlKDAsOCk7Cn0KCmZ1bmN0aW9uIG1lYW5pbmdmdWxUb2tlbnModGV4dCl7CiAgcmV0dXJuIFsuLi5ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKS5tYXRjaEFsbCgvW1xwe0x9XHB7Tn1cLVwvXC5dKy9ndSldCiAgICAubWFwKG09Pm1bMF0pCiAgICAuZmlsdGVyKHRvaz0+ewogICAgICBjb25zdCBmPWZvbGRWTih0b2spLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW15hLXowLTlcLVwvXC5dL2csIiIpOwogICAgICByZXR1cm4gZi5sZW5ndGg+PTQgJiYgIVNFQVJDSF9TVE9QLmhhcyhmKSAmJiAhL15cZCsoPzpbXC4sXVxkKyk/JT8kLy50ZXN0KGYpOwogICAgfSk7Cn0KCmZ1bmN0aW9uIHRpdGxlVGVjaG5pY2FsUGhyYXNlKCl7CiAgbGV0IHJhdz1zYW5pdGl6ZVBhdGVudFRpdGxlKCQoInRpdGxlIikudmFsdWV8fCIiKTsKICBpZighcmF3KSByZXR1cm4gIiI7CgogIGxldCB0PW5vcm1hbGl6ZU9jclRleHQocmF3KQogICAgLnJlcGxhY2UoL14oPzpxdXkgdHLDrG5ofHBoxrDGoW5nIHBow6FwfGjhu4cgdGjhu5FuZ3x0aGnhur90IGLhu4t8c+G6o24gcGjhuqltfGNo4bq/IHBo4bqpbSlccysoPzpz4bqjbiB4deG6pXR8Y2jhur8gdOG6oW98xJFp4buBdSBjaOG6vyk/XHMqL2ksIiIpOwoKICAvLyBSZWplY3Qgc3RyaW5ncyBkb21pbmF0ZWQgYnkgcGFnZSBudW1iZXJzIC8gYXJ0aWZhY3RzLgogIGlmKCh0Lm1hdGNoKC9cZCtccypcL1xzKlxkKy9nKXx8W10pLmxlbmd0aD49MSkgcmV0dXJuICIiOwoKICBjb25zdCB0b2tzPW1lYW5pbmdmdWxUb2tlbnModCk7CiAgaWYodG9rcy5sZW5ndGg+PTIpIHJldHVybiB0b2tzLnNsaWNlKDAsNykuam9pbigiICIpOwogIHJldHVybiAiIjsKfQoKZnVuY3Rpb24gdGVjaG5pY2FsUGhyYXNlc0Zyb21UZXh0KHRleHQpewogIGNvbnN0IHJhdz1ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKTsKICBjb25zdCB0b2tzPW1lYW5pbmdmdWxUb2tlbnMocmF3KTsKICBjb25zdCBvdXQ9W107CgogIC8vIFByZWZlciBwaHJhc2VzIGV4cGxpY2l0bHkgcHJlc2VudCBpbiB0aGUgdGVjaG5pY2FsIGRpY3Rpb25hcnkuCiAgZm9yKGNvbnN0IFtrXSBvZiBPYmplY3QuZW50cmllcyhkaWN0KSl7CiAgICBpZihmb2xkVk4ocmF3KS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGZvbGRWTihrKS50b0xvd2VyQ2FzZSgpKSAmJiBrLnNwbGl0KC9ccysvKS5sZW5ndGg+PTIpewogICAgICBvdXQucHVzaChrKTsKICAgIH0KICB9CgogIC8vIEJ1aWxkIGNvbXBhY3QgMuKAkzMgd29yZCBwaHJhc2VzIGluc3RlYWQgb2YgaXNvbGF0ZWQgT0NSIHdvcmRzLgogIGZvcihsZXQgbj0zO24+PTI7bi0tKXsKICAgIGZvcihsZXQgaT0wO2krbjw9dG9rcy5sZW5ndGg7aSsrKXsKICAgICAgY29uc3QgcGhyYXNlPXRva3Muc2xpY2UoaSxpK24pLmpvaW4oIiAiKTsKICAgICAgY29uc3QgZj1mb2xkVk4ocGhyYXNlKS50b0xvd2VyQ2FzZSgpOwogICAgICBpZighb3V0LnNvbWUoeD0+Zm9sZFZOKHgpLnRvTG93ZXJDYXNlKCk9PT1mKSkgb3V0LnB1c2gocGhyYXNlKTsKICAgICAgaWYob3V0Lmxlbmd0aD49OCkgYnJlYWs7CiAgICB9CiAgICBpZihvdXQubGVuZ3RoPj04KSBicmVhazsKICB9CiAgcmV0dXJuIG91dC5zbGljZSgwLDgpOwp9CgpmdW5jdGlvbiBxdWVyeVF1YWxpdHkocSl7CiAgY29uc3Qgd29yZHM9bWVhbmluZ2Z1bFRva2VucyhTdHJpbmcocSkucmVwbGFjZSgvXGJBTkRcYnxcYk9SXGIvZ2ksIiAiKSk7CiAgY29uc3QgdW5pcT1bLi4ubmV3IFNldCh3b3Jkcy5tYXAoeD0+Zm9sZFZOKHgpLnRvTG93ZXJDYXNlKCkpKV07CiAgcmV0dXJuIHsKICAgIG9rOiB1bmlxLmxlbmd0aD49MiwKICAgIHRlcm1zOiB1bmlxLAogICAgc2NvcmU6IE1hdGgubWluKDEwMCx1bmlxLmxlbmd0aCoyMikKICB9Owp9CgoKZnVuY3Rpb24gYnVpbGRQcm9TZWFyY2hSb3dzKCl7CiAgcmV0dXJuIHN0YXRlLmZlYXR1cmVzLm1hcChmPT57CiAgICBjb25zdCBwaHJhc2VzPXRlY2huaWNhbFBocmFzZXNGcm9tVGV4dChmLnRleHQpOwogICAgY29uc3QgdGVybXM9ZmVhdHVyZUNvcmVUZXJtcyhmLnRleHQpOwogICAgY29uc3QgZm91bmQ9W107CiAgICBmb3IoY29uc3QgW2ssdl0gb2YgT2JqZWN0LmVudHJpZXMoZGljdCkpewogICAgICBpZihmb2xkVk4oZi50ZXh0KS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGZvbGRWTihrKS50b0xvd2VyQ2FzZSgpKSkgZm91bmQucHVzaChrLC4uLnYpOwogICAgfQogICAgY29uc3QgYWxsPVsuLi5waHJhc2VzLC4uLmZvdW5kLC4uLnRlcm1zXS5maWx0ZXIoKHgsaSxhKT0+eCYmYS5maW5kSW5kZXgoeT0+Zm9sZFZOKHkpPT09Zm9sZFZOKHgpKT09PWkpOwogICAgY29uc3QgcHJpbWFyeT1hbGxbMF18fCIiOwogICAgY29uc3Qgc3lub255bXM9YWxsLnNsaWNlKDEsNSk7CiAgICByZXR1cm4gW2YuaWQscHJpbWFyeSxzeW5vbnltcy5qb2luKCI7ICIpfHwi4oCUIiwkKCJpcGMiKS52YWx1ZXx8IkPhuqduIGNodXnDqm4gZ2lhIHjDoWMgxJHhu4tuaCJdOwogIH0pLmZpbHRlcihyPT5yWzFdKTsKfQoKZnVuY3Rpb24gYnVpbGRQcm9RdWVyaWVzKHJvd3MpewogIGNvbnN0IHBocmFzZXM9W107CiAgY29uc3QgdGl0bGVQaHJhc2U9dGl0bGVUZWNobmljYWxQaHJhc2UoKTsKICBpZih0aXRsZVBocmFzZSkgcGhyYXNlcy5wdXNoKHRpdGxlUGhyYXNlKTsKCiAgZm9yKGNvbnN0IHIgb2Ygcm93cyl7CiAgICBjb25zdCB2YWxzPVtyWzFdLC4uLihyWzJdPT09IuKAlCI/W106clsyXS5zcGxpdCgiOyIpLm1hcCh4PT54LnRyaW0oKSkpXTsKICAgIGZvcihjb25zdCB2IG9mIHZhbHMpewogICAgICBpZighdikgY29udGludWU7CiAgICAgIGNvbnN0IHE9cXVlcnlRdWFsaXR5KHYpOwogICAgICBpZihxLm9rICYmICFwaHJhc2VzLnNvbWUoeD0+Zm9sZFZOKHgpPT09Zm9sZFZOKHYpKSkgcGhyYXNlcy5wdXNoKHYpOwogICAgfQogIH0KCiAgY29uc3QgcXVlcmllcz1bXTsKICBjb25zdCBhZGQ9cT0+ewogICAgcT0ocXx8IiIpLnRyaW0oKTsKICAgIGlmKCFxIHx8ICFxdWVyeVF1YWxpdHkocSkub2spIHJldHVybjsKICAgIGlmKCFxdWVyaWVzLnNvbWUoeD0+Zm9sZFZOKHgpPT09Zm9sZFZOKHEpKSkgcXVlcmllcy5wdXNoKHEpOwogIH07CgogIC8vIEhpZ2hlc3QgcHJlY2lzaW9uOiB0aXRsZSBjb25jZXB0ICsgb25lIGZlYXR1cmUgY29uY2VwdC4KICBpZih0aXRsZVBocmFzZSAmJiBwaHJhc2VzWzFdKSBhZGQoYCIke3RpdGxlUGhyYXNlfSIgQU5EICIke3BocmFzZXNbMV19ImApOwogIGlmKHRpdGxlUGhyYXNlKSBhZGQoYCIke3RpdGxlUGhyYXNlfSJgKTsKCiAgLy8gQnJvYWRlciByZWNhbGwgcXVlcmllcy4KICBpZihwaHJhc2VzLmxlbmd0aD49MikgYWRkKHBocmFzZXMuc2xpY2UoMCwyKS5tYXAoeD0+YCIke3h9ImApLmpvaW4oIiBBTkQgIikpOwogIGlmKHBocmFzZXMubGVuZ3RoPj0zKSBhZGQocGhyYXNlcy5zbGljZSgxLDMpLm1hcCh4PT5gIiR7eH0iYCkuam9pbigiIEFORCAiKSk7CgogIC8vIExhc3QgZmFsbGJhY2s6IDMtNiBzaWduaWZpY2FudCB0ZWNobmljYWwgdG9rZW5zIGZyb20gdGl0bGUgKyBzZWxlY3RlZCBjbGFpbS4KICBjb25zdCBjPXN0YXRlLmNsYWltc1tzdGF0ZS5zZWxlY3RlZF18fHN0YXRlLmNsYWltc1swXTsKICBjb25zdCB0b2tlblBvb2w9Wy4uLm1lYW5pbmdmdWxUb2tlbnMoJCgidGl0bGUiKS52YWx1ZXx8IiIpLC4uLm1lYW5pbmdmdWxUb2tlbnMoYz9jLnRleHQ6IiIpXTsKICBjb25zdCB1bmlxPVtdOwogIGZvcihjb25zdCB4IG9mIHRva2VuUG9vbCl7CiAgICBjb25zdCBmPWZvbGRWTih4KS50b0xvd2VyQ2FzZSgpOwogICAgaWYoIXVuaXEuc29tZSh5PT5mb2xkVk4oeSkudG9Mb3dlckNhc2UoKT09PWYpKSB1bmlxLnB1c2goeCk7CiAgfQogIGlmKHVuaXEubGVuZ3RoPj0yKSBhZGQodW5pcS5zbGljZSgwLDYpLmpvaW4oIiAiKSk7CgogIHJldHVybiBxdWVyaWVzLnNsaWNlKDAsNik7Cn0KJCgiYXV0b0ZlYXR1cmVzIikub25jbGljaz0oKT0+e2xldCBjPXN0YXRlLmNsYWltc1srJCgiY2xhaW1TZWxlY3QiKS52YWx1ZXx8MF07aWYoIWMpcmV0dXJuIGFsZXJ0KCJDaMawYSBjw7MgY2xhaW0uIik7c3RhdGUuc2VsZWN0ZWQ9KyQoImNsYWltU2VsZWN0IikudmFsdWV8fDA7c3RhdGUuZmVhdHVyZXM9ZmVhdHVyZVNwbGl0KGMudGV4dCk7cmVuZGVyRmVhdHVyZXMoKTskKCJmZWF0dXJlU3RhdHVzIikudmFsdWU9IkLhuqNuIG5ow6FwIHThu7EgxJHhu5luZyI7c3RhdGUuY29uZmlybWVkPWZhbHNlO3VwZGF0ZUZlYXR1cmVSZXZpZXdVSSgpfTsKJCgiY29uZmlybUZlYXR1cmVzIikub25jbGljaz0oKT0+e2lmKCFzdGF0ZS5mZWF0dXJlcy5sZW5ndGgpcmV0dXJuIGFsZXJ0KCJDaMawYSBjw7MgZOG6pXUgaGnhu4d1LiIpO3N0YXRlLmNvbmZpcm1lZD10cnVlO3VwZGF0ZUZlYXR1cmVSZXZpZXdVSSgpO2FsZXJ0KCLEkMOjIHjDoWMgbmjhuq1uIGLhu5kgZOG6pXUgaGnhu4d1LiBC4bqhbiBjw7MgdGjhu4MgdGnhur9wIHThu6VjIHNhbmcgYsaw4bubYyB0cmEgY+G7qXUuIil9OwoKZnVuY3Rpb24gdXBkYXRlRmVhdHVyZVJldmlld1VJKCl7CiAgY29uc3Qgbj1zdGF0ZS5mZWF0dXJlcy5sZW5ndGg7CiAgY29uc3QgYmFyPSQoImZlYXR1cmVSZXZpZXdCYXIiKTsKICBjb25zdCBiYWRnZT0kKCJmZWF0dXJlU3RhdHVzQmFkZ2UiKTsKICBjb25zdCBsYWJlbD0kKCJmZWF0dXJlQ291bnRMYWJlbCIpOwogIGlmKCFiYXJ8fCFiYWRnZXx8IWxhYmVsKSByZXR1cm47CiAgbGFiZWwudGV4dENvbnRlbnQ9bj9gJHtufSBk4bqldSBoaeG7h3Uga+G7uSB0aHXhuq10YDoiQ2jGsGEgY8OzIGThuqV1IGhp4buHdSI7CiAgaWYoc3RhdGUuY29uZmlybWVkKXsKICAgIGJhci5jbGFzc0xpc3QuYWRkKCJmZWF0dXJlLWNvbmZpcm1lZCIpOwogICAgYmFkZ2UuY2xhc3NOYW1lPSJwaWxsIGdyZWVuIjsKICAgIGJhZGdlLnRleHRDb250ZW50PSLEkMOjIHjDoWMgbmjhuq1uIjsKICAgICQoImZlYXR1cmVTdGF0dXMiKS52YWx1ZT0ixJDDoyB4w6FjIG5o4bqtbiI7CiAgICAkKCJjb25maXJtRmVhdHVyZXMiKS50ZXh0Q29udGVudD0i4pyTIMSQw6MgeMOhYyBuaOG6rW4gYuG7mSBk4bqldSBoaeG7h3UiOwogIH1lbHNlewogICAgYmFyLmNsYXNzTGlzdC5yZW1vdmUoImZlYXR1cmUtY29uZmlybWVkIik7CiAgICBiYWRnZS5jbGFzc05hbWU9InBpbGwgeWVsbG93IjsKICAgIGJhZGdlLnRleHRDb250ZW50PSJDaMawYSB4w6FjIG5o4bqtbiI7CiAgICAkKCJmZWF0dXJlU3RhdHVzIikudmFsdWU9bj8iQuG6o24gbmjDoXAgdOG7sSDEkeG7mW5nIjoiQ2jGsGEgdOG6oW8iOwogICAgJCgiY29uZmlybUZlYXR1cmVzIikudGV4dENvbnRlbnQ9IuKckyBYw6FjIG5o4bqtbiBi4buZIGThuqV1IGhp4buHdSI7CiAgfQp9CmZ1bmN0aW9uIHJlbmRlckZlYXR1cmVzKCl7CiAkKCJmZWF0dXJlQm9keSIpLmlubmVySFRNTD1zdGF0ZS5mZWF0dXJlcy5tYXAoKGYsaSk9PmA8dHI+PHRkPjxzdHJvbmc+JHtmLmlkfTwvc3Ryb25nPjwvdGQ+PHRkPjx0ZXh0YXJlYSBkYXRhLWZ0PSIke2l9IiBzdHlsZT0ibWluLWhlaWdodDo3MnB4Ij4ke2VzYyhmLnRleHQpfTwvdGV4dGFyZWE+PC90ZD48dGQ+PHNlbGVjdCBkYXRhLXR5PSIke2l9Ij48b3B0aW9uICR7Zi50eXBlPT09IlF1eSB0csOsbmgiPyJzZWxlY3RlZCI6IiJ9PlF1eSB0csOsbmg8L29wdGlvbj48b3B0aW9uICR7Zi50eXBlPT09IlRow6BuaCBwaOG6p24vTmd1ecOqbiBsaeG7h3UiPyJzZWxlY3RlZCI6IiJ9PlRow6BuaCBwaOG6p24vTmd1ecOqbiBsaeG7h3U8L29wdGlvbj48b3B0aW9uICR7Zi50eXBlPT09Iktp4buDbSBzb8OhdCI/InNlbGVjdGVkIjoiIn0+S2nhu4NtIHNvw6F0PC9vcHRpb24+PG9wdGlvbiAke2YudHlwZT09PSJUaGnhur90IGLhu4svQ+G6pXUgdHLDumMiPyJzZWxlY3RlZCI6IiJ9PlRoaeG6v3QgYuG7iy9D4bqldSB0csO6Yzwvb3B0aW9uPjwvc2VsZWN0PjwvdGQ+PHRkPjxzcGFuIGNsYXNzPSJwaWxsIHllbGxvdyI+JHtmLmNvbmZ9PC9zcGFuPjwvdGQ+PHRkPjxidXR0b24gY2xhc3M9ImJ0biBkYW5nZXIiIGRhdGEtZGVsPSIke2l9Ij7DlzwvYnV0dG9uPjwvdGQ+PC90cj5gKS5qb2luKCIiKTsKIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWZ0XSIpLmZvckVhY2goeD0+eC5vbmNoYW5nZT0oKT0+c3RhdGUuZmVhdHVyZXNbK3guZGF0YXNldC5mdF0udGV4dD14LnZhbHVlKTtkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS10eV0iKS5mb3JFYWNoKHg9Pngub25jaGFuZ2U9KCk9PnN0YXRlLmZlYXR1cmVzWyt4LmRhdGFzZXQudHldLnR5cGU9eC52YWx1ZSk7ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtZGVsXSIpLmZvckVhY2goeD0+eC5vbmNsaWNrPSgpPT57c3RhdGUuZmVhdHVyZXMuc3BsaWNlKCt4LmRhdGFzZXQuZGVsLDEpO3N0YXRlLmNvbmZpcm1lZD1mYWxzZTtyZW5kZXJGZWF0dXJlcygpfSk7dXBkYXRlRmVhdHVyZVJldmlld1VJKCkKfQoKY29uc3QgZGljdD17ImjhuqF0IHRoYW5oIGxvbmciOlsiZHJhZ29uIGZydWl0IHNlZWQiLCJwaXRheWEgc2VlZCIsIkh5bG9jZXJldXMgc2VlZCJdLCJu4bqjeSBt4bqnbSI6WyJnZXJtaW5hdGlvbiIsImdlcm1pbmF0ZWQiLCJzcHJvdXRpbmciXSwiY2VsbHVsYXNlIjpbImNlbGx1bGFzZSIsImNlbGx1bGFzZSB0cmVhdG1lbnQiXSwicGVjdGluYXNlIjpbInBlY3RpbmFzZSIsInBlY3RpbmFzZSB0cmVhdG1lbnQiXSwic+G6pXkiOlsiZHJ5aW5nIiwiZGVoeWRyYXRpb24iXSwibmdoaeG7gW4iOlsiZ3JpbmRpbmciLCJtaWxsaW5nIl0sImLhu5l0IG5ow6B1IjpbIm5vbmkgcG93ZGVyIiwiTW9yaW5kYSBjaXRyaWZvbGlhIHBvd2RlciJdLCLEkeG7mSDhuqltIjpbIm1vaXN0dXJlIGNvbnRlbnQiLCJtb2lzdHVyZSBhZGp1c3RtZW50Il0sIsSRw7NuZyBnw7NpIjpbInBhY2thZ2luZyIsInBhY2tpbmciXSwiZnJlZXplIGRyeWluZyI6WyJseW9waGlsaXphdGlvbiIsImZyZWV6ZSBkcnllciJdLCJtb3NxdWl0byI6WyJtb3NxdWl0byByZXBlbGxlbnQiLCJpbnNlY3QgcmVwZWxsZW50Il0sImVzc2VudGlhbCBvaWwiOlsiZXh0cmFjdCIsImFyb21hdGljIG9pbCJdfTsKJCgiZ2VuU2VhcmNoIikub25jbGljaz0oKT0+ewogIHN0YXRlLnNlYXJjaD1idWlsZFByb1NlYXJjaFJvd3MoKTsKICBzdGF0ZS5xdWVyaWVzPWJ1aWxkUHJvUXVlcmllcyhzdGF0ZS5zZWFyY2gpOwogIHJlbmRlclNlYXJjaCgpOwp9OwpmdW5jdGlvbiByZW5kZXJTZWFyY2goKXskKCJzZWFyY2hCb2R5IikuaW5uZXJIVE1MPXN0YXRlLnNlYXJjaC5tYXAocj0+YDx0cj48dGQ+PHN0cm9uZz4ke3JbMF19PC9zdHJvbmc+PC90ZD48dGQ+JHtlc2MoclsxXSl9PC90ZD48dGQ+JHtlc2MoclsyXSl9PC90ZD48dGQ+JHtlc2MoclszXSl9PC90ZD48L3RyPmApLmpvaW4oIiIpOyQoInF1ZXJ5TGlzdCIpLmlubmVySFRNTD1zdGF0ZS5xdWVyaWVzLm1hcCgocSxpKT0+YDxkaXYgY2xhc3M9ImNhbGxvdXQiPjxzdHJvbmc+USR7aSsxfTwvc3Ryb25nPjxici8+PGNvZGU+JHtlc2MocSl9PC9jb2RlPjwvZGl2PmApLmpvaW4oIiIpfQoKCmZ1bmN0aW9uIGJhY2tlbmRCYXNlKCl7CiAgcmV0dXJuIGxvY2F0aW9uLm9yaWdpbjsKfQpmdW5jdGlvbiBzYXZlQmFja2VuZCgpewogIHN0YXRlLmJhY2tlbmRVcmw9bG9jYXRpb24ub3JpZ2luOwp9CmZ1bmN0aW9uIHVwZGF0ZU9mZmljaWFsU2VhcmNoTGlua3MocSl7CiAgY29uc3QgcXVlcnk9cXx8JCgibGl2ZVNlYXJjaFF1ZXJ5IikudmFsdWV8fHN0YXRlLnF1ZXJpZXNbMF18fCIiOwogICQoImdwTGluayIpLmhyZWY9Imh0dHBzOi8vcGF0ZW50cy5nb29nbGUuY29tLz9xPSIrZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KTsKICAkKCJ3aXBvTGluayIpLmhyZWY9Imh0dHBzOi8vcGF0ZW50c2NvcGUud2lwby5pbnQvc2VhcmNoL2VuL2FkdmFuY2VkU2VhcmNoLmpzZj9xdWVyeT0iK2VuY29kZVVSSUNvbXBvbmVudCgnRU5fQUxMVFhUOignK3F1ZXJ5KycpJyk7CiAgJCgiZXBvTGluayIpLmhyZWY9Imh0dHBzOi8vd29ybGR3aWRlLmVzcGFjZW5ldC5jb20vcGF0ZW50L3NlYXJjaD9xPSIrZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KTsKfQpmdW5jdGlvbiB1c2VHZW5lcmF0ZWRRdWVyeSgpewogIGxldCBxPSIiOwogIGlmKHN0YXRlLnF1ZXJpZXMubGVuZ3RoKXsKICAgIHE9c3RhdGUucXVlcmllc1swXTsKICB9ZWxzZSBpZihzdGF0ZS5mZWF0dXJlcy5sZW5ndGgpewogICAgY29uc3Qgcm93cz1idWlsZFByb1NlYXJjaFJvd3MoKTsKICAgIGNvbnN0IHFzPWJ1aWxkUHJvUXVlcmllcyhyb3dzKTsKICAgIHE9cXNbMF18fCIiOwogIH1lbHNlewogICAgcT0kKCJ0aXRsZSIpLnZhbHVlfHwiIjsKICB9CiAgJCgibGl2ZVNlYXJjaFF1ZXJ5IikudmFsdWU9cTsKICB1cGRhdGVPZmZpY2lhbFNlYXJjaExpbmtzKHEpOwogIHJldHVybiBxOwp9CmZ1bmN0aW9uIGNsZWFuUGF0ZW50SHRtbChzKXsKICBjb25zdCBkPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoInRleHRhcmVhIik7CiAgZC5pbm5lckhUTUw9KHN8fCIiKS5yZXBsYWNlKC88W14+XSo+L2csIiAiKTsKICByZXR1cm4gZC52YWx1ZS5yZXBsYWNlKC9ccysvZywiICIpLnRyaW0oKTsKfQpmdW5jdGlvbiB0YXJnZXREYXRlT2JqKCl7CiAgY29uc3Qgdj0kKCJmaWxpbmdEYXRlIikudmFsdWU7CiAgcmV0dXJuIHY/bmV3IERhdGUodisiVDAwOjAwOjAwIik6bnVsbDsKfQpmdW5jdGlvbiBjYW5kaWRhdGVEYXRlU3RhdHVzKGMpewogIGNvbnN0IHRkPXRhcmdldERhdGVPYmooKTsKICBjb25zdCBkPWMucHVibGljYXRpb25fZGF0ZXx8Yy5wcmlvcml0eV9kYXRlfHxjLmZpbGluZ19kYXRlfHwiIjsKICBpZighdGR8fCFkKSByZXR1cm4ge2xhYmVsOiJD4bqnbiB4w6FjIG1pbmgiLGNsczoieWVsbG93IixlbGlnaWJsZTpudWxsfTsKICBjb25zdCBjZD1uZXcgRGF0ZShkKTsKICBpZihpc05hTihjZCkpIHJldHVybiB7bGFiZWw6IkPhuqduIHjDoWMgbWluaCIsY2xzOiJ5ZWxsb3ciLGVsaWdpYmxlOm51bGx9OwogIGNvbnN0IG9rPWNkPHRkOwogIHJldHVybiB7bGFiZWw6b2s/IlRyxrDhu5tjIG3hu5FjIHRhcmdldCI6IlNhdSBt4buRYyB0YXJnZXQiLGNsczpvaz8iZ3JlZW4iOiJyZWQiLGVsaWdpYmxlOm9rfTsKfQpmdW5jdGlvbiBmZWF0dXJlVGVybXMoKXsKICBjb25zdCBzdG9wPW5ldyBTZXQoWyJiYW8iLCJn4buTbSIsInRyb25nIiwiY+G7p2EiLCLEkcaw4bujYyIsInbDoCIsInRoZSIsIndpdGgiLCJmcm9tIiwid2hlcmVpbiIsIm1ldGhvZCIsInByb2Nlc3MiXSk7CiAgY29uc3QgdGVybXM9W107CiAgZm9yKGNvbnN0IGYgb2Ygc3RhdGUuZmVhdHVyZXMpewogICAgZm9yKGNvbnN0IHcgb2YgZm9sZFZOKGYudGV4dCkudG9Mb3dlckNhc2UoKS5zcGxpdCgvW15hLXowLTldKy8pKXsKICAgICAgaWYody5sZW5ndGg+PTQmJiFzdG9wLmhhcyh3KSkgdGVybXMucHVzaCh3KTsKICAgIH0KICB9CiAgcmV0dXJuIFsuLi5uZXcgU2V0KHRlcm1zKV0uc2xpY2UoMCw4MCk7Cn0KZnVuY3Rpb24gc2NvcmVDYW5kaWRhdGUoYyl7CiAgY29uc3QgYmxvYj1mb2xkVk4oW2MudGl0bGUsYy5zbmlwcGV0LGMuYXNzaWduZWVdLmZpbHRlcihCb29sZWFuKS5qb2luKCIgIikpLnRvTG93ZXJDYXNlKCk7CiAgY29uc3QgdGVybXM9ZmVhdHVyZVRlcm1zKCk7CiAgaWYoIXRlcm1zLmxlbmd0aCkgcmV0dXJuIDUwOwogIGxldCBoaXQ9MDsKICBmb3IoY29uc3QgdCBvZiB0ZXJtcykgaWYoYmxvYi5pbmNsdWRlcyh0KSkgaGl0Kys7CiAgbGV0IHNjb3JlPU1hdGgucm91bmQoKGhpdC9NYXRoLm1pbih0ZXJtcy5sZW5ndGgsMjApKSoxMDApOwogIGNvbnN0IGRzPWNhbmRpZGF0ZURhdGVTdGF0dXMoYyk7CiAgaWYoZHMuZWxpZ2libGU9PT1mYWxzZSkgc2NvcmU9TWF0aC5tYXgoMCxzY29yZS0zNSk7CiAgcmV0dXJuIE1hdGgubWluKDk5LHNjb3JlKTsKfQpmdW5jdGlvbiByZW5kZXJDYW5kaWRhdGVzKCl7CiAgaWYoIXN0YXRlLmNhbmRpZGF0ZXMubGVuZ3RoKXsKICAgICQoImNhbmRpZGF0ZUJvZHkiKS5pbm5lckhUTUw9Jzx0cj48dGQgY29sc3Bhbj0iNiIgc3R5bGU9ImNvbG9yOiM5OGEyYjM7dGV4dC1hbGlnbjpjZW50ZXIiPktow7RuZyBjw7Mga+G6v3QgcXXhuqMgxJHhu4MgaGnhu4NuIHRo4buLLjwvdGQ+PC90cj4nOwogICAgcmV0dXJuOwogIH0KICAkKCJjYW5kaWRhdGVCb2R5IikuaW5uZXJIVE1MPXN0YXRlLmNhbmRpZGF0ZXMubWFwKChjLGkpPT57CiAgICBjLnNjb3JlPXNjb3JlQ2FuZGlkYXRlKGMpOwogICAgY29uc3QgZHM9Y2FuZGlkYXRlRGF0ZVN0YXR1cyhjKTsKICAgIGNvbnN0IHNjb3JlQ2xzPWMuc2NvcmU+PTY1PyJoaWdoIjpjLnNjb3JlPj0zNT8ibWlkIjoibG93IjsKICAgIGNvbnN0IGRhdGU9Yy5wdWJsaWNhdGlvbl9kYXRlfHxjLnByaW9yaXR5X2RhdGV8fGMuZmlsaW5nX2RhdGV8fCLigJQiOwogICAgcmV0dXJuIGA8dHI+CiAgICAgIDx0ZD4ke2krMX08L3RkPgogICAgICA8dGQgc3R5bGU9Im1pbi13aWR0aDozMzBweCI+CiAgICAgICAgPGEgY2xhc3M9InNlYXJjaC1yZXN1bHQtdGl0bGUiIGhyZWY9IiR7ZXNjKGMudXJsKX0iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj4ke2VzYyhjLnB1YmxpY2F0aW9uX251bWJlcnx8IlBhdGVudCIpfSDCtyAke2VzYyhjLnRpdGxlfHwiS2jDtG5nIGPDsyB0acOqdSDEkeG7gSIpfTwvYT4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0dXMiIHN0eWxlPSJtYXJnaW4tdG9wOjVweCI+JHtlc2MoYy5zbmlwcGV0fHwiIil9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ic291cmNlLXJvdyIgc3R5bGU9Im1hcmdpbi10b3A6N3B4Ij4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaHJlZj0iJHtlc2MoYy51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkdvb2dsZSBQYXRlbnRzIOKGlzwvYT4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaHJlZj0iaHR0cHM6Ly9wYXRlbnRzY29wZS53aXBvLmludC9zZWFyY2gvZW4vYWR2YW5jZWRTZWFyY2guanNmP3F1ZXJ5PSR7ZW5jb2RlVVJJQ29tcG9uZW50KCdBTExOVU06KCcrYy5wdWJsaWNhdGlvbl9udW1iZXIrJyknKX0iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj5XSVBPIOKGlzwvYT4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaHJlZj0iaHR0cHM6Ly93b3JsZHdpZGUuZXNwYWNlbmV0LmNvbS9wYXRlbnQvc2VhcmNoP3E9JHtlbmNvZGVVUklDb21wb25lbnQoJ3BuPScrYy5wdWJsaWNhdGlvbl9udW1iZXIpfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkVzcGFjZW5ldCDihpc8L2E+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvdGQ+CiAgICAgIDx0ZD4ke2VzYyhkYXRlKX08L3RkPgogICAgICA8dGQ+PHNwYW4gY2xhc3M9InNjb3JlICR7c2NvcmVDbHN9Ij4ke2Muc2NvcmV9JTwvc3Bhbj48L3RkPgogICAgICA8dGQ+PHNwYW4gY2xhc3M9InBpbGwgJHtkcy5jbHN9Ij4ke2RzLmxhYmVsfTwvc3Bhbj48L3RkPgogICAgICA8dGQ+PGRpdiBjbGFzcz0iY2FuZGlkYXRlLWFjdGlvbnMiPgogICAgICAgIDxidXR0b24gY2xhc3M9InNsb3RidG4iIGRhdGEtc2xvdD0iRDEiIGRhdGEtY2FuZGlkYXRlPSIke2l9Ij5EMTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9InNsb3RidG4iIGRhdGEtc2xvdD0iRDIiIGRhdGEtY2FuZGlkYXRlPSIke2l9Ij5EMjwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9InNsb3RidG4iIGRhdGEtc2xvdD0iRDMiIGRhdGEtY2FuZGlkYXRlPSIke2l9Ij5EMzwvYnV0dG9uPgogICAgICA8L2Rpdj48L3RkPgogICAgPC90cj5gOwogIH0pLmpvaW4oIiIpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWNhbmRpZGF0ZV0iKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+c2VsZWN0Q2FuZGlkYXRlVG9TbG90KCtiLmRhdGFzZXQuY2FuZGlkYXRlLGIuZGF0YXNldC5zbG90KSk7Cn0KYXN5bmMgZnVuY3Rpb24gc2VhcmNoUmVhbFBhdGVudHMoKXsKICBsZXQgcT0kKCJsaXZlU2VhcmNoUXVlcnkiKS52YWx1ZS50cmltKCl8fHVzZUdlbmVyYXRlZFF1ZXJ5KCk7CiAgaWYoIXF1ZXJ5UXVhbGl0eShxKS5vayl7CiAgICBjb25zdCByb3dzPWJ1aWxkUHJvU2VhcmNoUm93cygpOwogICAgY29uc3QgcXM9YnVpbGRQcm9RdWVyaWVzKHJvd3MpOwogICAgcT1xc1swXXx8dGl0bGVUZWNobmljYWxQaHJhc2UoKTsKICAgICQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlPXE7CiAgfQogIGlmKCFxdWVyeVF1YWxpdHkocSkub2spewogICAgJCgibGl2ZVNlYXJjaFN0YXRlIikuaW5uZXJIVE1MPSc8c3BhbiBjbGFzcz0iYmFja2VuZC1iYWQiPlRydXkgduG6pW4gaGnhu4duIHThuqFpIHF1w6EgY2h1bmcgaG/hurdjIGLhu4sgbOG7l2kgT0NSLjwvc3Bhbj4gSMOjeSBxdWF5IGzhuqFpIGtp4buDbSB0cmEgQ2xhaW0vROG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdCBob+G6t2Mgbmjhuq1wIMOtdCBuaOG6pXQgMiB0aHXhuq10IG5n4buvIGvhu7kgdGh14bqtdC4nOwogICAgcmV0dXJuOwogIH0KICB1cGRhdGVPZmZpY2lhbFNlYXJjaExpbmtzKHEpOwogIGlmKCFxKSByZXR1cm4gYWxlcnQoIkNoxrBhIGPDsyB0cnV5IHbhuqVuIHRyYSBj4bupdS4iKTsKICBjb25zdCBiYXNlPWJhY2tlbmRCYXNlKCk7CiAgc2F2ZUJhY2tlbmQoKTsKICAkKCJsaXZlU2VhcmNoU3RhdGUiKS50ZXh0Q29udGVudD0ixJBhbmcgdHJhIGPhu6l1IHBhdGVudCB0aOG6rXQgcXVhIGLhu5kgbcOheSB0w6xtIGtp4bq/bS4uLiI7CiAgJCgibGl2ZVNlYXJjaEJ0biIpLmRpc2FibGVkPXRydWU7CiAgdHJ5ewogICAgY29uc3QgdXJsPWJhc2UrIi9hcGkvc2VhcmNoP3E9IitlbmNvZGVVUklDb21wb25lbnQocSkrIiZ0aXRsZT0iK2VuY29kZVVSSUNvbXBvbmVudCgkKCJ0aXRsZSIpLnZhbHVlfHwiIikrIiZudW09MjAiOwogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCh1cmwpOwogICAgY29uc3QgZGF0YT1hd2FpdCByLmpzb24oKTsKICAgIGlmKCFyLm9rfHwhZGF0YS5vaykgdGhyb3cgbmV3IEVycm9yKGRhdGEuZXJyb3J8fCgiSFRUUCAiK3Iuc3RhdHVzKSk7CiAgICBpZihkYXRhLnF1ZXJ5X3VzZWQpeyQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlPWRhdGEucXVlcnlfdXNlZDt1cGRhdGVPZmZpY2lhbFNlYXJjaExpbmtzKGRhdGEucXVlcnlfdXNlZCl9CiAgICBzdGF0ZS5jYW5kaWRhdGVzPShkYXRhLnJlc3VsdHN8fFtdKS5tYXAoeD0+KHsuLi54LHNjb3JlOjB9KSk7CiAgICBzdGF0ZS5jYW5kaWRhdGVzLnNvcnQoKGEsYik9PnNjb3JlQ2FuZGlkYXRlKGIpLXNjb3JlQ2FuZGlkYXRlKGEpKTsKICAgIHJlbmRlckNhbmRpZGF0ZXMoKTsKICAgICQoImxpdmVTZWFyY2hTdGF0ZSIpLmlubmVySFRNTD1gxJDDoyBuaOG6rW4gPHN0cm9uZz4ke3N0YXRlLmNhbmRpZGF0ZXMubGVuZ3RofTwvc3Ryb25nPiBr4bq/dCBxdeG6oyB04burIDxzdHJvbmc+JHtlc2MoZGF0YS5wcm92aWRlcnx8ZGF0YS5zb3VyY2V8fCJuZ3Xhu5NuIHBhdGVudCIpfTwvc3Ryb25nPi4gVHJ1eSB24bqlbiB0aOG7sWMgZMO5bmc6IDxzdHJvbmc+JHtlc2MoZGF0YS5xdWVyeV91c2VkfHxxKX08L3N0cm9uZz4ke2RhdGEuYXR0ZW1wdF9jb3VudD9gIMK3IMSRw6MgdGjhu60gJHtkYXRhLmF0dGVtcHRfY291bnR9IG3hu6ljIHRydXkgduG6pW5gOiIifS5gOwogIH1jYXRjaChlKXsKICAgIGNvbnNvbGUuZXJyb3IoZSk7CiAgICBjb25zdCBtc2c9U3RyaW5nKGUubWVzc2FnZXx8ZSk7CiAgICBjb25zdCBoaW50PS81MDN8UkFURV9MSU1JVHxHT09HTEVfQkxPQ0tFRC9pLnRlc3QobXNnKQogICAgICA/ICI8YnI+PHN0cm9uZz5Hb29nbGUgUGF0ZW50cyDEkWFuZyBjaOG6t24gdHJ1eSB24bqlbiB04buxIMSR4buZbmcgdOG7qyBJUCBkYXRhY2VudGVyLjwvc3Ryb25nPiBI4buHIHRo4buRbmcgc+G6vSDGsHUgdGnDqm4gQnJvd3NlciBSdW4vU2VycEFwaSBu4bq/dSDEkcaw4bujYyBj4bqldSBow6xuaDsgR29vZ2xlIGRpcmVjdCBjaOG7iSBsw6AgZmFsbGJhY2s7IGPDoWMgbGluayBHb29nbGUvV0lQTy9FUE8gcGjDrWEgdHLDqm4gduG6q24gbMOgIG5ndeG7k24ga2nhu4NtIGNo4bupbmcuIgogICAgICA6ICIiOwogICAgJCgibGl2ZVNlYXJjaFN0YXRlIikuaW5uZXJIVE1MPWA8c3BhbiBjbGFzcz0iYmFja2VuZC1iYWQiPlRyYSBj4bupdSB04buxIMSR4buZbmcgY2jGsGEgdGjDoG5oIGPDtG5nOiAke2VzYyhtc2cpfTwvc3Bhbj4ke2hpbnR9PGJyPkLhuqFuIHbhuqtuIGPDsyB0aOG7gyBt4bufIHRy4buxYyB0aeG6v3AgY8OhYyBuZ3Xhu5NuIGNow61uaCB0aOG7qWMgcGjDrWEgdHLDqm4uYDsKICB9ZmluYWxseXsKICAgICQoImxpdmVTZWFyY2hCdG4iKS5kaXNhYmxlZD1mYWxzZTsKICB9Cn0KYXN5bmMgZnVuY3Rpb24gc2VsZWN0Q2FuZGlkYXRlVG9TbG90KGksc2xvdCl7CiAgY29uc3QgYz1zdGF0ZS5jYW5kaWRhdGVzW2ldOwogIGlmKCFjKSByZXR1cm47CiAgY29uc3Qgbj1zbG90LnNsaWNlKDEpOwogIGNvbnN0IGJhc2U9YmFja2VuZEJhc2UoKTsKICAkKGBkJHtufU5vYCkudmFsdWU9Yy5wdWJsaWNhdGlvbl9udW1iZXJ8fCIiOwogICQoYGQke259RGF0ZWApLnZhbHVlPShjLnB1YmxpY2F0aW9uX2RhdGV8fGMucHJpb3JpdHlfZGF0ZXx8Yy5maWxpbmdfZGF0ZXx8IiIpLnNsaWNlKDAsMTApOwogICQoYGQke259VXJsYCkudmFsdWU9Yy51cmx8fCIiOwogICQoYGQke259VGV4dGApLnZhbHVlPVtjLnRpdGxlLGMuc25pcHBldF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oIlxuXG4iKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIucHJpb3Itc2xvdCIpLmZvckVhY2goeD0+eC5jbGFzc0xpc3QucmVtb3ZlKCJzZWxlY3RlZCIpKTsKICAkKCJzbG90IitzbG90KS5jbGFzc0xpc3QuYWRkKCJzZWxlY3RlZCIpOwoKICBpZihiYXNlJiZjLnB1YmxpY2F0aW9uX251bWJlcil7CiAgICB0cnl7CiAgICAgICQoYGQke259VGV4dGApLnZhbHVlPSLEkGFuZyBs4bqleSBu4buZaSBkdW5nIHBhdGVudC4uLiI7CiAgICAgIGNvbnN0IHI9YXdhaXQgZmV0Y2goYmFzZSsiL2FwaS9kZXRhaWw/cHViPSIrZW5jb2RlVVJJQ29tcG9uZW50KGMucHVibGljYXRpb25fbnVtYmVyKSk7CiAgICAgIGNvbnN0IGQ9YXdhaXQgci5qc29uKCk7CiAgICAgIGlmKHIub2smJmQub2spewogICAgICAgIGNvbnN0IHBhcnRzPVtdOwogICAgICAgIGlmKGQudGl0bGUpIHBhcnRzLnB1c2goIlRJVExFXG4iK2QudGl0bGUpOwogICAgICAgIGlmKGQuYWJzdHJhY3QpIHBhcnRzLnB1c2goIkFCU1RSQUNUXG4iK2QuYWJzdHJhY3QpOwogICAgICAgIGlmKGQuY2xhaW1zKSBwYXJ0cy5wdXNoKCJDTEFJTVNcbiIrZC5jbGFpbXMuc2xpY2UoMCwxODAwMCkpOwogICAgICAgICQoYGQke259VGV4dGApLnZhbHVlPXBhcnRzLmpvaW4oIlxuXG4iKXx8W2MudGl0bGUsYy5zbmlwcGV0XS5qb2luKCJcblxuIik7CiAgICAgIH1lbHNlewogICAgICAgICQoYGQke259VGV4dGApLnZhbHVlPVtjLnRpdGxlLGMuc25pcHBldF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oIlxuXG4iKTsKICAgICAgfQogICAgfWNhdGNoKF9lKXsKICAgICAgJChgZCR7bn1UZXh0YCkudmFsdWU9W2MudGl0bGUsYy5zbmlwcGV0XS5maWx0ZXIoQm9vbGVhbikuam9pbigiXG5cbiIpOwogICAgfQogIH0KICByZWFkUHJpb3IoKTsKfQpmdW5jdGlvbiBhdXRvUGlja0QxMjMoKXsKICBpZighc3RhdGUuY2FuZGlkYXRlcy5sZW5ndGgpIHJldHVybiBhbGVydCgiQ2jGsGEgY8OzIGvhur90IHF14bqjIHRyYSBj4bupdS4iKTsKICBjb25zdCBzb3J0ZWQ9Wy4uLnN0YXRlLmNhbmRpZGF0ZXNdLnNvcnQoKGEsYik9PnsKICAgIGNvbnN0IGRhPWNhbmRpZGF0ZURhdGVTdGF0dXMoYSksZGI9Y2FuZGlkYXRlRGF0ZVN0YXR1cyhiKTsKICAgIGNvbnN0IHBhPWRhLmVsaWdpYmxlPT09ZmFsc2U/MTowLHBiPWRiLmVsaWdpYmxlPT09ZmFsc2U/MTowOwogICAgcmV0dXJuIHBhLXBiIHx8IHNjb3JlQ2FuZGlkYXRlKGIpLXNjb3JlQ2FuZGlkYXRlKGEpOwogIH0pOwogIGNvbnN0IHBpY2tlZD1zb3J0ZWQuc2xpY2UoMCwzKTsKICBwaWNrZWQuZm9yRWFjaCgoYyxpZHgpPT57CiAgICBjb25zdCBvcmlnaW5hbD1zdGF0ZS5jYW5kaWRhdGVzLmluZGV4T2YoYyk7CiAgICBzZWxlY3RDYW5kaWRhdGVUb1Nsb3Qob3JpZ2luYWwsIkQiKyhpZHgrMSkpOwogIH0pOwp9CiQoImxpdmVTZWFyY2hCdG4iKS5vbmNsaWNrPXNlYXJjaFJlYWxQYXRlbnRzOwokKCJ1c2VCZXN0UXVlcnkiKS5vbmNsaWNrPSgpPT57dXNlR2VuZXJhdGVkUXVlcnkoKTskKCJsaXZlU2VhcmNoU3RhdGUiKS50ZXh0Q29udGVudD0ixJDDoyBu4bqhcCB0cnV5IHbhuqVuIHThu6sgYsaw4bubYyBDaGnhur9uIGzGsOG7o2MgdHJhIGPhu6l1LiJ9OwokKCJhdXRvUGlja1ByaW9yIikub25jbGljaz1hdXRvUGlja0QxMjM7CiQoInRlc3RCYWNrZW5kIikub25jbGljaz1hc3luYygpPT57CiAgJCgiYmFja2VuZFN0YXR1cyIpLnRleHRDb250ZW50PSLEkGFuZyBraeG7g20gdHJhLi4uIjsKICB0cnl7CiAgICBjb25zdCByPWF3YWl0IGZldGNoKCIvYXBpL2hlYWx0aCIse2NhY2hlOiJuby1zdG9yZSJ9KTsKICAgIGNvbnN0IGQ9YXdhaXQgci5qc29uKCk7CiAgICBpZighci5va3x8IWQub2spIHRocm93IG5ldyBFcnJvcihkLmVycm9yfHwiS2jDtG5nIGvhur90IG7hu5FpIMSRxrDhu6NjIik7CiAgICBjb25zdCBwPWQucHJvdmlkZXJzfHx7fTsgY29uc3QgdmVyPWQudmVyc2lvbj9gIMK3IHYke2QudmVyc2lvbn1gOiIiOwogICAgc3RhdGUucHJvdmlkZXJzPXA7CiAgICBzdGF0ZS5jbG91ZE9jcj1wLmdvb2dsZV92aXNpb24/dHJ1ZTpudWxsOwogICAgY29uc3Qgc2VhcmNoT2s9cC5zZXJwYXBpfHxwLmJyb3dzZXJfcnVufHxwLmVwb19vcHM7CiAgICBjb25zdCBvY3JUZXh0PXAuZ29vZ2xlX3Zpc2lvbj8iIMK3IEdvb2dsZSBWaXNpb24gT0NSIHPhurVuIHPDoG5nIjoiIMK3IE9DUiBsb2NhbCBmYWxsYmFjayI7CiAgICAkKCJiYWNrZW5kU3RhdHVzIikuaW5uZXJIVE1MPXNlYXJjaE9rCiAgICAgID8gYDxzcGFuIGNsYXNzPSJiYWNrZW5kLW9rIj7inJMgQmFja2VuZCBob+G6oXQgxJHhu5luZy48L3NwYW4+JHtvY3JUZXh0fWAKICAgICAgOiBgPHNwYW4gY2xhc3M9ImJhY2tlbmQtb2siPuKckyBCYWNrZW5kIGhv4bqhdCDEkeG7mW5nLjwvc3Bhbj4gR29vZ2xlIGRpcmVjdCBjw7MgdGjhu4MgYuG7iyByYXRlLWxpbWl0JHtvY3JUZXh0fWA7CiAgfWNhdGNoKGUpewogICAgJCgiYmFja2VuZFN0YXR1cyIpLmlubmVySFRNTD1gPHNwYW4gY2xhc3M9ImJhY2tlbmQtYmFkIj7inJUgQmFja2VuZDogJHtlc2MoZS5tZXNzYWdlfHxlKX08L3NwYW4+YDsKICB9Cn07CmZ1bmN0aW9uIHJlYWRQcmlvcigpe3N0YXRlLnByaW9yPXtEMTp7bm86JCgiZDFObyIpLnZhbHVlLGRhdGU6JCgiZDFEYXRlIikudmFsdWUsdGV4dDokKCJkMVRleHQiKS52YWx1ZX0sRDI6e25vOiQoImQyTm8iKS52YWx1ZSxkYXRlOiQoImQyRGF0ZSIpLnZhbHVlLHRleHQ6JCgiZDJUZXh0IikudmFsdWV9LEQzOntubzokKCJkM05vIikudmFsdWUsZGF0ZTokKCJkM0RhdGUiKS52YWx1ZSx0ZXh0OiQoImQzVGV4dCIpLnZhbHVlfX19CiQoInZhbGlkYXRlUHJpb3IiKS5vbmNsaWNrPSgpPT57cmVhZFByaW9yKCk7bGV0IGZpbGluZz0kKCJmaWxpbmdEYXRlIikudmFsdWU/bmV3IERhdGUoJCgiZmlsaW5nRGF0ZSIpLnZhbHVlKTpudWxsLGh0bWw9IjxzdHJvbmc+S+G6v3QgcXXhuqMga2nhu4NtIHRyYSB0aOG7nWkgZ2lhbjwvc3Ryb25nPjxici8+Ijtmb3IoY29uc3Rbayx2XW9mIE9iamVjdC5lbnRyaWVzKHN0YXRlLnByaW9yKSl7aWYoIXYubm8pY29udGludWU7bGV0IG9rPXYuZGF0ZSYmZmlsaW5nJiZuZXcgRGF0ZSh2LmRhdGUpPGZpbGluZztodG1sKz1gJHtrfSDCtyAke2VzYyh2Lm5vKX0gwrcgJHtlc2Modi5kYXRlfHwiY2jGsGEgY8OzIG5nw6B5Iil9IOKAlCA8c3BhbiBjbGFzcz0icGlsbCAke29rPyJncmVlbiI6InllbGxvdyJ9Ij4ke29rPyJDw7MgdGjhu4MgcGjDuSBo4bujcCB24buBIHRo4budaSBnaWFuIjoiQ+G6p24ga2nhu4NtIHRyYSJ9PC9zcGFuPjxici8+YH0kKCJwcmlvckNoZWNrIikuaW5uZXJIVE1MPWh0bWx9OwoKZnVuY3Rpb24gbWF0cml4Q29uY2VwdHMoZmVhdHVyZVRleHQpewogIGNvbnN0IHJhdz1TdHJpbmcoZmVhdHVyZVRleHR8fCIiKTsKICBjb25zdCBjb25jZXB0cz1bXTsKICBjb25zdCBwdXNoPXg9PnsKICAgIHg9U3RyaW5nKHh8fCIiKS50cmltKCkudG9Mb3dlckNhc2UoKTsKICAgIGlmKHgubGVuZ3RoPDMpIHJldHVybjsKICAgIGlmKCFjb25jZXB0cy5pbmNsdWRlcyh4KSkgY29uY2VwdHMucHVzaCh4KTsKICB9OwoKICAvLyBPcmlnaW5hbCBzaWduaWZpY2FudCBWaWV0bmFtZXNlL0VuZ2xpc2ggd29yZHMuCiAgZm9yKGNvbnN0IHcgb2YgbWVhbmluZ2Z1bFRva2VucyhyYXcpKSBwdXNoKHcpOwoKICAvLyBQYXRlbnQgZGljdGlvbmFyeSBiaWxpbmd1YWwgZXhwYW5zaW9uLgogIGZvcihjb25zdCBbayx2YWxzXSBvZiBPYmplY3QuZW50cmllcyhkaWN0KSl7CiAgICBpZihmb2xkVk4ocmF3KS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGZvbGRWTihrKS50b0xvd2VyQ2FzZSgpKSl7CiAgICAgIHB1c2goayk7CiAgICAgIGZvcihjb25zdCB2IG9mIHZhbHMpIGZvcihjb25zdCB3IG9mIHYuc3BsaXQoL1xzKy8pKSBwdXNoKHcpOwogICAgfQogIH0KICByZXR1cm4gY29uY2VwdHMuc2xpY2UoMCwzMCk7Cn0KCmZ1bmN0aW9uIHNwbGl0RXZpZGVuY2VVbml0cyh0ZXh0KXsKICByZXR1cm4gbm9ybWFsaXplT2NyVGV4dCh0ZXh0fHwiIikKICAgIC5zcGxpdCgvXG4rfCg/PD1bLiE/OzpdKVxzKy8pCiAgICAubWFwKHg9PngudHJpbSgpKQogICAgLmZpbHRlcih4PT54Lmxlbmd0aD49MjApCiAgICAuc2xpY2UoMCw4MDApOwp9CgpmdW5jdGlvbiBsb2NhbEV2aWRlbmNlRm9yKGZlYXR1cmUsZG9jVGV4dCl7CiAgY29uc3QgdGV4dD1TdHJpbmcoZG9jVGV4dHx8IiIpLnRyaW0oKTsKICBpZighdGV4dCB8fCB0ZXh0PT09IsSQYW5nIGzhuqV5IG7hu5lpIGR1bmcgcGF0ZW50Li4uIil7CiAgICByZXR1cm4ge3N0YXR1czoiQ2jGsGEgY8OzIGThu68gbGnhu4d1IixldmlkZW5jZToiQ2jGsGEgY8OzIG7hu5lpIGR1bmcgRDEvRDIvRDMgxJHhu4MgxJHhu5FpIGNoaeG6v3UuIn07CiAgfQoKICBjb25zdCBjb25jZXB0cz1tYXRyaXhDb25jZXB0cyhmZWF0dXJlLnRleHQpOwogIGlmKCFjb25jZXB0cy5sZW5ndGgpewogICAgcmV0dXJuIHtzdGF0dXM6IkNoxrBhIGNo4bqvYyBjaOG6r24iLGV2aWRlbmNlOiJLaMO0bmcgdMOhY2ggxJHGsOG7o2MgxJHhu6cgdGh14bqtdCBuZ+G7ryBr4bu5IHRodeG6rXQgxJHhu4MgbWFwcGluZyB04buxIMSR4buZbmcuIn07CiAgfQoKICBjb25zdCB1bml0cz1zcGxpdEV2aWRlbmNlVW5pdHModGV4dCk7CiAgbGV0IGJlc3Q9e3Njb3JlOjAsdW5pdDoiIixoaXRzOltdfTsKCiAgZm9yKGNvbnN0IHUgb2YgdW5pdHMpewogICAgY29uc3QgZnU9Zm9sZFZOKHUpLnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCBoaXRzPWNvbmNlcHRzLmZpbHRlcihjPT5mdS5pbmNsdWRlcyhmb2xkVk4oYykudG9Mb3dlckNhc2UoKSkpOwogICAgY29uc3QgdW5pcXVlPVsuLi5uZXcgU2V0KGhpdHMpXTsKICAgIGxldCBzY29yZT11bmlxdWUubGVuZ3RoOwogICAgaWYodW5pcXVlLnNvbWUoeD0+eC5pbmNsdWRlcygiZHJhZ29uIil8fHguaW5jbHVkZXMoImdlcm1pbmF0aW9uIil8fHguaW5jbHVkZXMoImNlbGx1bGFzZSIpfHx4LmluY2x1ZGVzKCJwZWN0aW5hc2UiKSkpIHNjb3JlKz0xOwogICAgaWYoc2NvcmU+YmVzdC5zY29yZSkgYmVzdD17c2NvcmUsdW5pdDp1LGhpdHM6dW5pcXVlfTsKICB9CgogIGxldCBzdGF0dXM9IkNoxrBhIGNo4bqvYyBjaOG6r24iOwogIGlmKGJlc3Quc2NvcmU+PTUpIHN0YXR1cz0iQ8OzIjsKICBlbHNlIGlmKGJlc3Quc2NvcmU+PTMpIHN0YXR1cz0iTeG7mXQgcGjhuqduIjsKICBlbHNlIGlmKGJlc3Quc2NvcmU+PTEpIHN0YXR1cz0iQ2jGsGEgY2jhuq9jIGNo4bqvbiI7CiAgZWxzZSBzdGF0dXM9IkNoxrBhIGNo4bqvYyBjaOG6r24iOyAvLyB2MTA6IGtow7RuZyBr4bq/dCBsdeG6rW4gIktow7RuZyB0w6xtIHRo4bqleSIgY2jhu4kgdsOsIGhldXJpc3RpYyBraMO0bmcgbWF0Y2guCgogIGNvbnN0IGV2aWRlbmNlPWJlc3QudW5pdAogICAgPyBgJHtiZXN0LnVuaXQuc2xpY2UoMCw0MjApfSR7YmVzdC51bml0Lmxlbmd0aD40MjA/IuKApiI6IiJ9YAogICAgOiJDaMawYSB0w6xtIHRo4bqleSDEkW/huqFuIMSR4bunIHLDtSBi4bqxbmcgaGV1cmlzdGljOyBj4bqnbiBBSS9jaHV5w6puIGdpYSBraeG7g20gdHJhIG7hu5lpIGR1bmcgcGF0ZW50LiI7CgogIHJldHVybiB7c3RhdHVzLGV2aWRlbmNlfTsKfQoKZnVuY3Rpb24gYnVpbGRMb2NhbE1hdHJpeCgpewogIGNvbnN0IHJvd3M9W107CiAgZm9yKGNvbnN0IGYgb2Ygc3RhdGUuZmVhdHVyZXMpewogICAgY29uc3QgdmFscz1bXTsKICAgIGNvbnN0IG5vdGVzPVtdOwogICAgZm9yKGNvbnN0IGsgb2YgWyJEMSIsIkQyIiwiRDMiXSl7CiAgICAgIGNvbnN0IHI9bG9jYWxFdmlkZW5jZUZvcihmLHN0YXRlLnByaW9yW2tdPy50ZXh0fHwiIik7CiAgICAgIHZhbHMucHVzaChyLnN0YXR1cyk7CiAgICAgIG5vdGVzLnB1c2goYCR7a306ICR7ci5ldmlkZW5jZX1gKTsKICAgIH0KICAgIHJvd3MucHVzaChbZi5pZCwuLi52YWxzLG5vdGVzLmpvaW4oIiB8ICIpXSk7CiAgfQogIHJldHVybiByb3dzOwp9Cgphc3luYyBmdW5jdGlvbiBidWlsZE1hdHJpeFBybygpewogIHJlYWRQcmlvcigpOwogIGlmKCFzdGF0ZS5mZWF0dXJlcy5sZW5ndGgpIHJldHVybiBhbGVydCgiQ2jGsGEgY8OzIGZlYXR1cmUuIik7CgogIGNvbnN0IGRvY3M9T2JqZWN0LmVudHJpZXMoc3RhdGUucHJpb3IpLmZpbHRlcigoW2ssdl0pPT52JiZ2Lm5vJiZTdHJpbmcodi50ZXh0fHwiIikudHJpbSgpKTsKICBpZighZG9jcy5sZW5ndGgpewogICAgc3RhdGUubWF0cml4PXN0YXRlLmZlYXR1cmVzLm1hcChmPT5bCiAgICAgIGYuaWQsIkNoxrBhIGPDsyBk4buvIGxp4buHdSIsIkNoxrBhIGPDsyBk4buvIGxp4buHdSIsIkNoxrBhIGPDsyBk4buvIGxp4buHdSIsCiAgICAgICJDaMawYSBjaOG7jW4gaG/hurdjIGNoxrBhIHThuqNpIG7hu5lpIGR1bmcgRDHigJNEMy4gSMOjeSBxdWF5IGzhuqFpIGLGsOG7m2MgNSB2w6AgY2jhu41uIHTDoGkgbGnhu4d1IMSR4buRaSBjaOG7qW5nLiIKICAgIF0pOwogICAgcmVuZGVyTWF0cml4KCk7CiAgICByZXR1cm47CiAgfQoKICAkKCJtYXRyaXhCb2R5IikuaW5uZXJIVE1MPSc8dHI+PHRkIGNvbHNwYW49IjUiIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjojNjY3MDg1Ij7EkGFuZyB0csOtY2ggZXZpZGVuY2UgdGhlbyB04burbmcgZOG6pXUgaGnhu4d14oCmPC90ZD48L3RyPic7CgogIC8vIE7hur91IGPDsyBHRU1JTklfQVBJX0tFWSBiYWNrZW5kIHPhur0gZMO5bmcgR2VuQUk7IG7hur91IGNoxrBhIGPDsyB0aMOsIGZhbGxiYWNrIGxvY2FsLgogIHRyeXsKICAgIGNvbnN0IHBheWxvYWQ9ewogICAgICBmZWF0dXJlczpzdGF0ZS5mZWF0dXJlcy5tYXAoZj0+KHtpZDpmLmlkLHRleHQ6Zi50ZXh0fSkpLAogICAgICBkb2N1bWVudHM6T2JqZWN0LmZyb21FbnRyaWVzKFsiRDEiLCJEMiIsIkQzIl0ubWFwKGs9PlsKICAgICAgICBrLHsKICAgICAgICAgIG5vOnN0YXRlLnByaW9yW2tdPy5ub3x8IiIsCiAgICAgICAgICB0ZXh0OlN0cmluZyhzdGF0ZS5wcmlvcltrXT8udGV4dHx8IiIpLnNsaWNlKDAsMjIwMDApCiAgICAgICAgfQogICAgICBdKSkKICAgIH07CiAgICBjb25zdCByPWF3YWl0IGZldGNoKCIvYXBpL21hdHJpeCIsewogICAgICBtZXRob2Q6IlBPU1QiLAogICAgICBoZWFkZXJzOnsiY29udGVudC10eXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LAogICAgICBib2R5OkpTT04uc3RyaW5naWZ5KHBheWxvYWQpCiAgICB9KTsKICAgIGNvbnN0IGQ9YXdhaXQgci5qc29uKCkuY2F0Y2goKCk9Pih7fSkpOwogICAgaWYoci5vayYmZC5vayYmQXJyYXkuaXNBcnJheShkLnJvd3MpKXsKICAgICAgc3RhdGUubWF0cml4PWQucm93cy5tYXAoeD0+WwogICAgICAgIHguZmVhdHVyZV9pZCwKICAgICAgICB4LkQxPy5zdGF0dXN8fCJDaMawYSBjaOG6r2MgY2jhuq9uIiwKICAgICAgICB4LkQyPy5zdGF0dXN8fCJDaMawYSBjaOG6r2MgY2jhuq9uIiwKICAgICAgICB4LkQzPy5zdGF0dXN8fCJDaMawYSBjaOG6r2MgY2jhuq9uIiwKICAgICAgICBbeC5EMSYmYEQxOiAke3guRDEuZXZpZGVuY2V8fCIifWAseC5EMiYmYEQyOiAke3guRDIuZXZpZGVuY2V8fCIifWAseC5EMyYmYEQzOiAke3guRDMuZXZpZGVuY2V8fCIifWBdLmZpbHRlcihCb29sZWFuKS5qb2luKCIgfCAiKQogICAgICBdKTsKICAgICAgcmVuZGVyTWF0cml4KCk7CiAgICAgIHJldHVybjsKICAgIH0KICB9Y2F0Y2goZSl7Y29uc29sZS53YXJuKCJBSSBtYXRyaXggZmFsbGJhY2s6IixlKX0KCiAgc3RhdGUubWF0cml4PWJ1aWxkTG9jYWxNYXRyaXgoKTsKICByZW5kZXJNYXRyaXgoKTsKfQoKJCgiYnVpbGRNYXRyaXgiKS5vbmNsaWNrPWJ1aWxkTWF0cml4UHJvOwoKZnVuY3Rpb24gcGlsbCh2KXsKICBsZXQgYz12PT09IkPDsyI/ImdyZWVuIjp2PT09Ik3hu5l0IHBo4bqnbiI/InllbGxvdyI6dj09PSJLaMO0bmcgdMOsbSB0aOG6pXkiPyJyZWQiOnY9PT0iQ2jGsGEgY8OzIGThu68gbGnhu4d1Ij8iIjoiIjsKICByZXR1cm5gPHNwYW4gY2xhc3M9InBpbGwgJHtjfSI+JHt2fTwvc3Bhbj5gCn0KZnVuY3Rpb24gcmVuZGVyTWF0cml4KCl7CiAgJCgibWF0cml4Qm9keSIpLmlubmVySFRNTD1zdGF0ZS5tYXRyaXgubWFwKHI9PmA8dHI+CiAgICA8dGQ+PHN0cm9uZz4ke3JbMF19PC9zdHJvbmc+PC90ZD4KICAgIDx0ZD4ke3BpbGwoclsxXSl9PC90ZD4KICAgIDx0ZD4ke3BpbGwoclsyXSl9PC90ZD4KICAgIDx0ZD4ke3BpbGwoclszXSl9PC90ZD4KICAgIDx0ZCBzdHlsZT0ibWluLXdpZHRoOjQyMHB4Ij4ke2VzYyhyWzRdKX08L3RkPgogIDwvdHI+YCkuam9pbigiIikKfQoKJCgicnVuQXNzZXNzbWVudCIpLm9uY2xpY2s9KCk9PntpZighc3RhdGUubWF0cml4Lmxlbmd0aClyZXR1cm4gYWxlcnQoIkjDo3kgdOG6oW8gbWEgdHLhuq1uIHRyxrDhu5tjLiIpO2xldCBhbGw9WzEsMiwzXS5maWx0ZXIoYz0+c3RhdGUubWF0cml4LmV2ZXJ5KHI9PnJbY109PT0iQ8OzIikpO3N0YXRlLmFzc2Vzc21lbnQ9e25vdmVsdHlSaXNrOmFsbC5sZW5ndGg/IlLhu6ZJIFJPIENBTyI6IkNIxq9BIFBIw4FUIEhJ4buGTiBN4bqkVCBUw41OSCBN4buaSSIsbm92ZWx0eVRleHQ6YWxsLmxlbmd0aD9gQ8OzICR7YWxsLm1hcCh4PT4iRCIreCkuam9pbigiLCAiKX0gxJHGsOG7o2MgbWFwcGluZyBi4buZYyBs4buZIHRvw6BuIGLhu5kgZmVhdHVyZTsgY+G6p24ga2nhu4NtIHRyYSBldmlkZW5jZS5gOiJUcm9uZyB04bqtcCBEMeKAk0QzIGhp4buHbiB04bqhaSwgY2jGsGEgeMOhYyDEkeG7i25oIG3hu5l0IHTDoGkgbGnhu4d1IMSRxqFuIGzhursgYuG7mWMgbOG7mSB0b8OgbiBi4buZIGThuqV1IGhp4buHdS4gS+G6v3QgcXXhuqMgY2jhu4kgw6FwIGThu6VuZyBjaG8gdOG6rXAgdMOgaSBsaeG7h3UgxJFhbmcga2jhuqNvIHPDoXQuIixpbnZlbnRpdmVSaXNrOiJD4bqmTiBDSFVZw4pOIEdJQSIsaW52ZW50aXZlVGV4dDoiQ+G6p24gY2jhu41uIMSR4buRaSBjaOG7qW5nIGfhuqduIG5o4bqldCwgeMOhYyDEkeG7i25oIGThuqV1IGhp4buHdSBraMOhYyBiaeG7h3QgdsOgIHbhuqVuIMSR4buBIGvhu7kgdGh14bqtdCBraMOhY2ggcXVhbiwgc2F1IMSRw7MgeGVtIHjDqXQgbGnhu4d1IHByaW9yIGFydCBraMOhYyBjw7MgZ+G7o2kgw70gY8OhY2ggZ2nhuqNpIHF1eeG6v3QgaGF5IGtow7RuZy4ifTtyZW5kZXJBc3Nlc3NtZW50KCl9OwpmdW5jdGlvbiByZW5kZXJBc3Nlc3NtZW50KCl7JCgibm92ZWx0eVRleHQiKS50ZXh0Q29udGVudD1zdGF0ZS5hc3Nlc3NtZW50Lm5vdmVsdHlUZXh0fHwiIjskKCJpbnZlbnRpdmVUZXh0IikudGV4dENvbnRlbnQ9c3RhdGUuYXNzZXNzbWVudC5pbnZlbnRpdmVUZXh0fHwiIjskKCJub3ZlbHR5UmlzayIpLnRleHRDb250ZW50PXN0YXRlLmFzc2Vzc21lbnQubm92ZWx0eVJpc2t8fCJDSOG7nCBE4buuIExJ4buGVSI7JCgiaW52ZW50aXZlUmlzayIpLnRleHRDb250ZW50PXN0YXRlLmFzc2Vzc21lbnQuaW52ZW50aXZlUmlza3x8IkNI4bucIEThu64gTEnhu4ZVIjskKCJub3ZlbHR5UmlzayIpLmNsYXNzTmFtZT0icmlza2JveCAiKygoc3RhdGUuYXNzZXNzbWVudC5ub3ZlbHR5Umlza3x8IiIpLmluY2x1ZGVzKCJDQU8iKT8icmVkIjoiZ3JlZW4iKTskKCJpbnZlbnRpdmVSaXNrIikuY2xhc3NOYW1lPSJyaXNrYm94IHllbGxvdyI7cmVuZGVyRXhwZXJ0KCl9CmZ1bmN0aW9uIHJlbmRlckV4cGVydCgpe2xldCByb3dzPVtbIkThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQiLGAke3N0YXRlLmZlYXR1cmVzLmxlbmd0aH0gZmVhdHVyZWBdLFsiQ2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdSIsYCR7c3RhdGUucXVlcmllcy5sZW5ndGh9IHF1ZXJ5YF0sWyJQcmlvciBhcnQiLE9iamVjdC52YWx1ZXMoc3RhdGUucHJpb3IpLmZpbHRlcih4PT54JiZ4Lm5vKS5tYXAoeD0+eC5ubykuam9pbigiLCAiKXx8IkNoxrBhIGPDsyJdLFsiQuG6o25nIMSR4buRaSBjaGnhur91IixgJHtzdGF0ZS5tYXRyaXgubGVuZ3RofSBmZWF0dXJlYF0sWyJUw61uaCBt4bubaSIsc3RhdGUuYXNzZXNzbWVudC5ub3ZlbHR5Umlza3x8IkNoxrBhIMSRw6FuaCBnacOhIl0sWyJUcsOsbmggxJHhu5kgc8OhbmcgdOG6oW8iLHN0YXRlLmFzc2Vzc21lbnQuaW52ZW50aXZlUmlza3x8IkNoxrBhIMSRw6FuaCBnacOhIl1dOyQoImV4cGVydEJvZHkiKS5pbm5lckhUTUw9cm93cy5tYXAoKHIsaSk9PmA8dHI+PHRkPjxzdHJvbmc+JHtyWzBdfTwvc3Ryb25nPjwvdGQ+PHRkPiR7ZXNjKHJbMV0pfTwvdGQ+PHRkPjxzZWxlY3QgZGF0YS1yPSIke2l9Ij48b3B0aW9uPkNo4budIHLDoCBzb8OhdDwvb3B0aW9uPjxvcHRpb24+WMOhYyBuaOG6rW48L29wdGlvbj48b3B0aW9uPkNo4buJbmggc+G7rWE8L29wdGlvbj48b3B0aW9uPktow7RuZyDEkeG7k25nIMO9PC9vcHRpb24+PC9zZWxlY3Q+PC90ZD48dGQ+PGlucHV0IHBsYWNlaG9sZGVyPSJOaOG6rW4geMOpdCBjaHV5w6puIGdpYSIvPjwvdGQ+PC90cj5gKS5qb2luKCIiKX1yZW5kZXJFeHBlcnQoKTsKJCgic2F2ZVJldmlldyIpLm9uY2xpY2s9KCk9PntzdGF0ZS5yZXZpZXdzPVsuLi5kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1yXSIpXS5maWx0ZXIoeD0+eC52YWx1ZSE9PSJDaOG7nSByw6Agc2/DoXQiKS5sZW5ndGg7YWxlcnQoIsSQw6MgbMawdSByw6Agc2/DoXQgdHJvbmcgcGhpw6puIGhp4buHbiB04bqhaS4iKX07CgokKCJnZW5SZXBvcnQiKS5vbmNsaWNrPSgpPT57cmVhZFByaW9yKCk7bGV0IGM9c3RhdGUuY2xhaW1zW3N0YXRlLnNlbGVjdGVkXXx8c3RhdGUuY2xhaW1zWzBdOyQoInJlcG9ydENvbnRlbnQiKS5pbm5lckhUTUw9YAo8aDM+MS4gVGjDtG5nIHRpbiBzw6FuZyBjaOG6vzwvaDM+PGRpdiBjbGFzcz0ic3VtbWFyeSI+PGRpdj5Nw6MgY2FzZTwvZGl2PjxkaXY+JHtlc2MoJCgiY2FzZUlkIikudmFsdWUpfTwvZGl2PjxkaXY+U+G7kSBi4bqxbmcvY8O0bmcgYuG7kTwvZGl2PjxkaXY+JHtlc2MoJCgicGF0ZW50Tm8iKS52YWx1ZSl9PC9kaXY+PGRpdj5Uw6puIHPDoW5nIGNo4bq/PC9kaXY+PGRpdj4ke2VzYygkKCJ0aXRsZSIpLnZhbHVlKX08L2Rpdj48ZGl2Pk5nw6B5IG7hu5lwL8awdSB0acOqbjwvZGl2PjxkaXY+JHtlc2MoJCgiZmlsaW5nRGF0ZSIpLnZhbHVlKX08L2Rpdj48ZGl2PklQQy9DUEM8L2Rpdj48ZGl2PiR7ZXNjKCQoImlwYyIpLnZhbHVlKX08L2Rpdj48L2Rpdj4KPGgzPjIuIENsYWltIMSRxrDhu6NjIHBow6JuIHTDrWNoPC9oMz48cD4ke2VzYyhjPy50ZXh0fHwiQ2jGsGEgY2jhu41uIil9PC9wPgo8aDM+My4gROG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdDwvaDM+PG9sPiR7c3RhdGUuZmVhdHVyZXMubWFwKGY9PmA8bGk+PHN0cm9uZz4ke2YuaWR9PC9zdHJvbmc+IOKAlCAke2VzYyhmLnRleHQpfTwvbGk+YCkuam9pbigiIil8fCI8bGk+Q2jGsGEgY8OzPC9saT4ifTwvb2w+CjxoMz40LiBDaGnhur9uIGzGsOG7o2MgdHJhIGPhu6l1PC9oMz48dWw+JHtzdGF0ZS5xdWVyaWVzLm1hcChxPT5gPGxpPjxjb2RlPiR7ZXNjKHEpfTwvY29kZT48L2xpPmApLmpvaW4oIiIpfHwiPGxpPkNoxrBhIHThuqFvPC9saT4ifTwvdWw+CjxoMz41LiDEkMOhbmggZ2nDoSBzxqEgYuG7mSB0w61uaCBt4bubaTwvaDM+PHA+PHN0cm9uZz4ke2VzYyhzdGF0ZS5hc3Nlc3NtZW50Lm5vdmVsdHlSaXNrfHwiQ2jGsGEgxJHDoW5oIGdpw6EiKX08L3N0cm9uZz48L3A+PHA+JHtlc2Moc3RhdGUuYXNzZXNzbWVudC5ub3ZlbHR5VGV4dHx8IiIpfTwvcD4KPGgzPjYuIFBow6JuIHTDrWNoIHPGoSBi4buZIHRyw6xuaCDEkeG7mSBzw6FuZyB04bqhbzwvaDM+PHA+PHN0cm9uZz4ke2VzYyhzdGF0ZS5hc3Nlc3NtZW50LmludmVudGl2ZVJpc2t8fCJDaMawYSDEkcOhbmggZ2nDoSIpfTwvc3Ryb25nPjwvcD48cD4ke2VzYyhzdGF0ZS5hc3Nlc3NtZW50LmludmVudGl2ZVRleHR8fCIiKX08L3A+PHA+PHN0cm9uZz7EkOG7kWkgY2jhu6luZyBn4bqnbiBuaOG6pXQ6PC9zdHJvbmc+ICR7ZXNjKCQoImNsb3Nlc3QiKS52YWx1ZSl9PC9wPjxwPjxzdHJvbmc+ROG6pXUgaGnhu4d1IGtow6FjIGJp4buHdDo8L3N0cm9uZz4gJHtlc2MoJCgiZGlmZmVyZW5jZXMiKS52YWx1ZSl9PC9wPjxwPjxzdHJvbmc+VuG6pW4gxJHhu4Ega+G7uSB0aHXhuq10IGtow6FjaCBxdWFuOjwvc3Ryb25nPiAke2VzYygkKCJwcm9ibGVtIikudmFsdWUpfTwvcD48cD48c3Ryb25nPkzhuq1wIGx14bqtbjo8L3N0cm9uZz4gJHtlc2MoJCgicmVhc29uaW5nIikudmFsdWUpfTwvcD4KPGgzPjcuIEV4cGVydCByZXZpZXc8L2gzPjxwPlPhu5EgaOG6oW5nIG3hu6VjIMSRw6MgxJHGsOG7o2MgcsOgIHNvw6F0OiA8c3Ryb25nPiR7c3RhdGUucmV2aWV3c308L3N0cm9uZz4uPC9wPgo8ZGl2IGNsYXNzPSJjYWxsb3V0Ij48c3Ryb25nPkzGsHUgw706PC9zdHJvbmc+IMSQw6J5IGzDoCBiw6FvIGPDoW8gcGjDom4gdMOtY2ggc8ahIGLhu5kgcGjhu6VjIHbhu6UgbmdoacOqbiBj4bupdSwga2jDtG5nIHBo4bqjaSDDvSBraeG6v24gcGjDoXAgbMO9IGN14buRaSBjw7luZy48L2Rpdj5gfTsKCmNvbnN0IGRlbW89YCgxMikgQuG6ok4gTcOUIFThuqIgU8OBTkcgQ0jhur4gVEhV4buYQyBC4bqwTkcgxJDhu5hDIFFVWeG7gE4gU8OBTkcgQ0jhur4KKDExKSAxLTAwNDIxODAKKDUxKSBBNjFLIDM2LzMzOyBBNjFLIDM2Lzc0NjsgQTIzTCAxOS8wMDsgQTIzTCAzMy8xMAooMjIpIDMwLzA2LzIwMjEKKDczKSBDw5RORyBUWSBUTkhIIE7Gr+G7mkMgw4lQIFBIw5pDIEjDgCAoVk4pCig3NCkgQ8O0bmcgdHkgVE5ISCBUxrAgduG6pW4gY8O0bmcgbmdo4buHIHbDoCBT4bufIGjhu691IHRyw60gdHXhu4cgSVAgR1JPVVAKKDU0KSBRVVkgVFLDjE5IIFPhuqJOIFhV4bqkVCBC4buYVCBESU5IIETGr+G7oE5HIFThu6ogSOG6oFQgVEhBTkggTE9ORyBO4bqiWSBN4bqmTQooNTcpIFPDoW5nIGNo4bq/IMSR4buBIGPhuq1wIMSR4bq/biBi4buZdCBkaW5oIGTGsOG7oW5nIHThu6sgaOG6oXQgdGhhbmggbG9uZyBu4bqjeSBt4bqnbSB0aHUgxJHGsOG7o2MgdOG7qyBt4buZdCBxdXkgdHLDrG5oIHPhuqNuIHh14bqldC4KWcOKVSBD4bqmVSBC4bqiTyBI4buYCjEuIFF1eSB0csOsbmggc+G6o24geHXhuqV0IGLhu5l0IGRpbmggZMaw4buhbmcgdOG7qyBo4bqhdCB0aGFuaCBsb25nIG7huqN5IG3huqdtIGJhbyBn4buTbTogKGkpIGNodeG6qW4gYuG7iyBuZ3V5w6puIGxp4buHdSBo4bqhdCB0aGFuaCBsb25nOyAoaWkpIHjhu60gbMO9IGLhurFuZyBjaOG6vyBwaOG6qW0gZW56eW1lIGNlbGx1bGFzZSB2w6AgcGVjdGluYXNlOyAoaWlpKSBuZ8OibSB2w6Ag4bunIMSR4buDIGjhuqF0IG7huqN5IG3huqdtOyAoaXYpIHPhuqV5OyAodikgbmdoaeG7gW47ICh2aSkga2nhu4NtIHRyYSDEkeG7k25nIG5o4bqldDsgKHZpaSkgdGjDqm0gYuG7mXQgbmjDoHU7ICh2aWlpKSB0aMOqbSBi4buZdCB0aGFuaCBsb25nOyAoaXgpIHRow6ptIHRow6BuaCBwaOG6p24gcGjhu6U7ICh4KSBraeG7g20gdHJhIMSR4buTbmcgbmjhuqV0OyAoeGkpIG5naGnhu4FuIHbDoCDEkWnhu4F1IGNo4buJbmggxJHhu5kg4bqpbTsgKHhpaSkgxJHDs25nIGfDs2kuCjIuIFF1eSB0csOsbmggdGhlbyDEkWnhu4NtIDEsIHRyb25nIMSRw7MgdGjDoG5oIHBo4bqnbiBwaOG7pSBiYW8gZ+G7k20gY2jhuqV0IGLhuqNvIHF14bqjbiB2w6AgY2jhuqV0IGNo4buRbmcgdsOzbi4KMy4gUXV5IHRyw6xuaCB0aGVvIMSRaeG7g20gMSwgdHJvbmcgxJHDsyB0aMOgbmggcGjhuqduIGNo4bqldCB04bqhbyBuZ+G7jXQgdOG7sSBuaGnDqm4gYmFvIGfhu5NtIG5ow7NtIGdsdWNpdC5gOwokKCJsb2FkRGVtbyIpLm9uY2xpY2s9KCk9PntzdGF0ZS5yYXdUZXh0PWRlbW87bGV0IG09ZXh0cmFjdE1ldGFkYXRhKGRlbW8pO2ZpbGxNZXRhKG0pO2xldCBjdD1jbGVhbihkZW1vLnNsaWNlKGRlbW8uc2VhcmNoKC9Zw4pVIEPhuqZVIELhuqJPIEjhu5gvaSkrIlnDilUgQ+G6plUgQuG6ok8gSOG7mCIubGVuZ3RoKSk7c3RhdGUuY2xhaW1zVGV4dD1jdDskKCJjbGFpbXNSYXciKS52YWx1ZT1jdDskKCJjbGFpbXNDbGVhbiIpLnZhbHVlPWZvcm1hdENsYWltRm9yRGlzcGxheShjdCk7c3RhdGUuY2xhaW1zPXBhcnNlQ2xhaW1zKGN0KTtyZW5kZXJDbGFpbXMoKTtzZXREZXRlY3QoImRldENsYWltcyIsdHJ1ZSxgxJDDoyB0w6FjaCAke3N0YXRlLmNsYWltcy5sZW5ndGh9IGNsYWltYCk7JCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMTAwJSI7JCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9IsSQw6MgbuG6oXAgZGVtbyBQSC1WTi0wMS4ifTsKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPg==";
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
