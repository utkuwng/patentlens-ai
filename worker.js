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
      version: "12.0.0",
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

const APP_HTML_B64 = "PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InZpIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ii8+CjxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xIi8+Cjx0aXRsZT5QYXRlbnRMZW5zIEFJIOKAlCBRdXkgdHLDrG5oIHBow6JuIHTDrWNoIHPDoW5nIGNo4bq/PC90aXRsZT4KPG1ldGEgbmFtZT0iZGVzY3JpcHRpb24iIGNvbnRlbnQ9IlByb3RvdHlwZSBuZ2hpw6puIGPhu6l1IGjhu5cgdHLhu6MgdHJhIGPhu6l1IHbDoCDEkcOhbmggZ2nDoSBzxqEgYuG7mSBzw6FuZyBjaOG6vyB0aGVvIGNodeG7l2kgQ2xhaW0g4oaSIEZlYXR1cmUg4oaSIFNlYXJjaCDihpIgUHJpb3IgQXJ0IOKGkiBOb3ZlbHR5IOKGkiBJbnZlbnRpdmUgU3RlcCDihpIgRXhwZXJ0IFJldmlldy4iLz4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuanMuY2xvdWRmbGFyZS5jb20vYWpheC9saWJzL3BkZi5qcy8zLjExLjE3NC9wZGYubWluLmpzIj48L3NjcmlwdD4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9ucG0vdGVzc2VyYWN0LmpzQDUuMS4xL2Rpc3QvdGVzc2VyYWN0Lm1pbi5qcyI+PC9zY3JpcHQ+CjxzdHlsZT4KOnJvb3R7CiAgLS1iZzojZjZmN2Y5Oy0tc3VyZmFjZTojZmZmOy0tc3VyZmFjZTI6I2Y5ZmFmYjstLXRleHQ6IzEwMTgyODstLW11dGVkOiM2NjcwODU7CiAgLS1saW5lOiNlNGU3ZWM7LS1kYXJrOiMxMDE4Mjg7LS1zb2Z0OiNmMmY0Zjc7LS1ncmVlbjojMDY3NjQ3Oy0tZ3JlZW5iZzojZWNmZGYzOwogIC0teWVsbG93OiNiNTQ3MDg7LS15ZWxsb3diZzojZmZmYWViOy0tcmVkOiNiNDIzMTg7LS1yZWRiZzojZmVmM2YyOy0tYmx1ZTojMTc1Y2QzOwogIC0tYmx1ZWJnOiNlZmY4ZmY7LS1zaGFkb3c6MCAxMnB4IDM2cHggcmdiYSgxNiwyNCw0MCwuMDYpOy0tcmFkaXVzOjE4cHgKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH1odG1se3Njcm9sbC1iZWhhdmlvcjpzbW9vdGh9CmJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDp2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7Zm9udC1mYW1pbHk6SW50ZXIsdWktc2Fucy1zZXJpZiwtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwiU2Vnb2UgVUkiLFJvYm90byxBcmlhbCxzYW5zLXNlcmlmfQpidXR0b24saW5wdXQsdGV4dGFyZWEsc2VsZWN0e2ZvbnQ6aW5oZXJpdH1idXR0b257Y3Vyc29yOnBvaW50ZXJ9Ci5hcHB7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczoyNzVweCAxZnI7bWluLWhlaWdodDoxMDB2aH0KYXNpZGV7cG9zaXRpb246c3RpY2t5O3RvcDowO2hlaWdodDoxMDB2aDtiYWNrZ3JvdW5kOiMwZjExMTU7Y29sb3I6I2ZmZjtwYWRkaW5nOjI0cHggMThweDtib3JkZXItcmlnaHQ6MXB4IHNvbGlkICMyMjI4MzF9Ci5icmFuZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O3BhZGRpbmc6MCA4cHg7bWFyZ2luLWJvdHRvbToyNnB4fQoubG9nb3t3aWR0aDozOXB4O2hlaWdodDozOXB4O2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6IzExMTtkaXNwbGF5OmdyaWQ7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtd2VpZ2h0OjkwMH0KLmJyYW5kIHN0cm9uZ3tmb250LXNpemU6MTZweH0uYnJhbmQgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojOThhMmIzO21hcmdpbi10b3A6M3B4fQoucHJvY2Vzc3tkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo3cHh9Ci5wcm9jZXNzLWl0ZW17cGFkZGluZzoxMXB4IDEycHg7Ym9yZGVyLXJhZGl1czoxMnB4O2NvbG9yOiM4Zjk4YTY7ZGlzcGxheTpmbGV4O2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtmb250LXNpemU6MTNweH0KLnByb2Nlc3MtaXRlbSAubnt3aWR0aDoyNXB4O2hlaWdodDoyNXB4O2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7Ym9yZGVyLXJhZGl1czo4cHg7YmFja2dyb3VuZDojMjYyYjMzO2ZvbnQtc2l6ZToxMnB4fQoucHJvY2Vzcy1pdGVtLmFjdGl2ZXtiYWNrZ3JvdW5kOiMxZDIxMjg7Y29sb3I6I2ZmZn0KLnByb2Nlc3MtaXRlbS5kb25le2NvbG9yOiNkMGQ1ZGR9LnByb2Nlc3MtaXRlbS5kb25lIC5ue2JhY2tncm91bmQ6IzM0NDA1NDtjb2xvcjojZmZmfQouc2lkZS1ub3Rle3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MThweDtyaWdodDoxOHB4O2JvdHRvbToyMHB4O3BhZGRpbmc6MTRweDtib3JkZXItcmFkaXVzOjE0cHg7YmFja2dyb3VuZDojMTcxYTIwO2JvcmRlcjoxcHggc29saWQgIzI3MmMzNDtjb2xvcjojOThhMmIzO2ZvbnQtc2l6ZToxMnB4O2xpbmUtaGVpZ2h0OjEuNTV9Cm1haW57cGFkZGluZzozNHB4IDM4cHggMTIwcHg7bWluLXdpZHRoOjB9Ci50b3B7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTZweDttYXJnaW4tYm90dG9tOjIwcHh9Cmgxe2ZvbnQtc2l6ZToyOHB4O2xldHRlci1zcGFjaW5nOi0uMDRlbTttYXJnaW46MH0udG9wIHB7bWFyZ2luOjZweCAwIDA7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxNHB4fQouY2FzZS1iYWRnZXtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nOjlweCAxMnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7Y29sb3I6IzQ3NTQ2Nztmb250LXNpemU6MTJweDt3aGl0ZS1zcGFjZTpub3dyYXB9Ci5sb2NhbC1iYW5uZXJ7cGFkZGluZzoxM3B4IDE1cHg7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbi1ib3R0b206MTZweDtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU7Ym9yZGVyOjFweCBzb2xpZCAjZmVkZjg5O2JhY2tncm91bmQ6dmFyKC0teWVsbG93YmcpO2NvbG9yOiM3YTJlMGV9Ci5zZWN0aW9ue2Rpc3BsYXk6bm9uZX0uc2VjdGlvbi5hY3RpdmV7ZGlzcGxheTpibG9ja30KLnBhbmVse2JhY2tncm91bmQ6dmFyKC0tc3VyZmFjZSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3gtc2hhZG93OnZhcigtLXNoYWRvdyk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjRweDttYXJnaW4tYm90dG9tOjE4cHh9Ci5wYW5lbCBoMnttYXJnaW46MCAwIDZweDtmb250LXNpemU6MjBweDtsZXR0ZXItc3BhY2luZzotLjAyZW19LnN1Yntjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjE0cHg7bGluZS1oZWlnaHQ6MS41NTttYXJnaW4tYm90dG9tOjIwcHh9Ci5ncmlke2Rpc3BsYXk6Z3JpZDtnYXA6MTRweH0uZzJ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfS5nM3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9CmxhYmVse2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NzUwO2NvbG9yOiM0NzU0Njc7bWFyZ2luLWJvdHRvbTo3cHh9CmlucHV0LHRleHRhcmVhLHNlbGVjdHt3aWR0aDoxMDAlO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojZmZmO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEycHggMTNweDtvdXRsaW5lOm5vbmU7Y29sb3I6IzExMTgyN30KaW5wdXQ6Zm9jdXMsdGV4dGFyZWE6Zm9jdXMsc2VsZWN0OmZvY3Vze2JvcmRlci1jb2xvcjojOThhMmIzO2JveC1zaGFkb3c6MCAwIDAgM3B4IHJnYmEoMTcsMjQsMzksLjA1KX0KdGV4dGFyZWF7cmVzaXplOnZlcnRpY2FsO21pbi1oZWlnaHQ6MTEwcHh9Ci5kcm9we2JvcmRlcjoxLjVweCBkYXNoZWQgI2NmZDRkYztib3JkZXItcmFkaXVzOjE2cHg7YmFja2dyb3VuZDojZmFmYmZjO3BhZGRpbmc6MzBweDt0ZXh0LWFsaWduOmNlbnRlcjt0cmFuc2l0aW9uOi4yc30KLmRyb3AuZHJhZ3tib3JkZXItY29sb3I6IzY2NzA4NTtiYWNrZ3JvdW5kOiNmMmY0Zjd9LmRyb3Agc3Ryb25ne2Rpc3BsYXk6YmxvY2s7bWFyZ2luLWJvdHRvbTo2cHh9LmRyb3Agc21hbGx7Y29sb3I6dmFyKC0tbXV0ZWQpfQouYWN0aW9uc3tkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7ZmxleC13cmFwOndyYXA7bWFyZ2luLXRvcDoxNnB4fQouYnRue2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojZmZmO2NvbG9yOiMxMTE4Mjc7Ym9yZGVyLXJhZGl1czoxMXB4O3BhZGRpbmc6MTBweCAxNHB4O2ZvbnQtc2l6ZToxM3B4O2ZvbnQtd2VpZ2h0Ojc1MH0KLmJ0bjpob3ZlcntiYWNrZ3JvdW5kOiNmOGZhZmN9LmJ0bi5wcmltYXJ5e2JhY2tncm91bmQ6IzExMTgyNztjb2xvcjojZmZmO2JvcmRlci1jb2xvcjojMTExODI3fS5idG4uc3VjY2Vzc3tiYWNrZ3JvdW5kOnZhcigtLWdyZWVuYmcpO2NvbG9yOnZhcigtLWdyZWVuKTtib3JkZXItY29sb3I6I2FiZWZjNn0uYnRuLmRhbmdlcntjb2xvcjp2YXIoLS1yZWQpfQoucHJvZ3Jlc3N7aGVpZ2h0OjhweDtiYWNrZ3JvdW5kOiNlZWYwZjM7Ym9yZGVyLXJhZGl1czo5OXB4O292ZXJmbG93OmhpZGRlbjttYXJnaW4tdG9wOjE0cHh9LnByb2dyZXNzPmRpdntoZWlnaHQ6MTAwJTtiYWNrZ3JvdW5kOiMxMTE4Mjc7d2lkdGg6MCU7dHJhbnNpdGlvbjouMjVzfQouc3RhdHVze2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjhweDtsaW5lLWhlaWdodDoxLjV9Ci5kZXRlY3R7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNCwxZnIpO2dhcDoxMHB4fQouZGV0ZWN0LWNhcmR7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7cGFkZGluZzoxNHB4O2JhY2tncm91bmQ6I2ZmZn0KLmRldGVjdC1jYXJkIGJ7Zm9udC1zaXplOjEzcHh9LmRldGVjdC1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLXRvcDo0cHh9Ci5kZXRlY3QtY2FyZC5va3tiYWNrZ3JvdW5kOnZhcigtLWdyZWVuYmcpO2JvcmRlci1jb2xvcjojYWJlZmM2fS5kZXRlY3QtY2FyZC53YXJue2JhY2tncm91bmQ6dmFyKC0teWVsbG93YmcpO2JvcmRlci1jb2xvcjojZmVkZjg5fQouc3VtbWFyeXtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjE2MHB4IDFmcjtnYXA6OHB4IDE2cHg7Zm9udC1zaXplOjEzcHh9LnN1bW1hcnkgZGl2Om50aC1jaGlsZChvZGQpe2NvbG9yOiM2NjcwODV9Ci5jYWxsb3V0e3BhZGRpbmc6MTVweDtib3JkZXI6MXB4IHNvbGlkICNkMGQ1ZGQ7YmFja2dyb3VuZDojZjhmYWZjO2JvcmRlci1yYWRpdXM6MTRweDtjb2xvcjojNDc1NDY3O2ZvbnQtc2l6ZToxM3B4O2xpbmUtaGVpZ2h0OjEuNTV9LmNhbGxvdXQgc3Ryb25ne2NvbG9yOiMxMTE4Mjd9Ci50YWJsZS13cmFwe292ZXJmbG93OmF1dG87Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHh9dGFibGV7d2lkdGg6MTAwJTtib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7Zm9udC1zaXplOjEzcHh9dGh7YmFja2dyb3VuZDojZjhmYWZjO2NvbG9yOiM0NzU0Njc7dGV4dC1hbGlnbjpsZWZ0O2ZvbnQtc2l6ZToxMnB4fXRoLHRke3BhZGRpbmc6MTJweCAxMHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpO3ZlcnRpY2FsLWFsaWduOnRvcH10cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLnBpbGx7ZGlzcGxheTppbmxpbmUtZmxleDtwYWRkaW5nOjVweCA4cHg7Ym9yZGVyLXJhZGl1czo5OTlweDtiYWNrZ3JvdW5kOiNmMmY0Zjc7Y29sb3I6IzM0NDA1NDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo4MDB9LmdyZWVue2JhY2tncm91bmQ6dmFyKC0tZ3JlZW5iZyk7Y29sb3I6dmFyKC0tZ3JlZW4pfS55ZWxsb3d7YmFja2dyb3VuZDp2YXIoLS15ZWxsb3diZyk7Y29sb3I6dmFyKC0teWVsbG93KX0ucmVke2JhY2tncm91bmQ6dmFyKC0tcmVkYmcpO2NvbG9yOnZhcigtLXJlZCl9LmJsdWV7YmFja2dyb3VuZDp2YXIoLS1ibHVlYmcpO2NvbG9yOnZhcigtLWJsdWUpfQouY2xhaW0sLmRvY3tib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjE1cHg7YmFja2dyb3VuZDojZmZmfS5jbGFpbSsuY2xhaW0sLmRvYysuZG9je21hcmdpbi10b3A6MTBweH0uY2xhaW0gaDQsLmRvYyBoNHttYXJnaW46MCAwIDdweDtmb250LXNpemU6MTRweH0uY2xhaW0gcCwuZG9jIHB7bWFyZ2luOjA7Y29sb3I6IzVmNmI3YTtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU1fQouc3BsaXR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczptaW5tYXgoMCwxLjE1ZnIpIG1pbm1heCgzMjBweCwuODVmcik7Z2FwOjE4cHh9Ci5yaXNre2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTRweDthbGlnbi1pdGVtczpjZW50ZXI7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4fS5yaXNrIGgze21hcmdpbjowIDAgNXB4O2ZvbnQtc2l6ZToxNnB4fS5yaXNrIHB7bWFyZ2luOjA7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxM3B4fS5yaXNrYm94e21pbi13aWR0aDoxNDVweDt0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjEycHg7Ym9yZGVyLXJhZGl1czoxNHB4O2ZvbnQtd2VpZ2h0OjkwMH0KLmRpdmlkZXJ7aGVpZ2h0OjFweDtiYWNrZ3JvdW5kOnZhcigtLWxpbmUpO21hcmdpbjoxOHB4IDB9LmVtcHR5e3BhZGRpbmc6MjZweDtib3JkZXI6MXB4IGRhc2hlZCAjZDBkNWRkO2JvcmRlci1yYWRpdXM6MTRweDt0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjojOThhMmIzfQpjb2Rle2ZvbnQtZmFtaWx5OnVpLW1vbm9zcGFjZSxTRk1vbm8tUmVndWxhcixNZW5sbyxtb25vc3BhY2U7Zm9udC1zaXplOjEycHh9LnJlcG9ydHtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHg7cGFkZGluZzoyNHB4O2xpbmUtaGVpZ2h0OjEuNjV9LnJlcG9ydCBoM3ttYXJnaW4tdG9wOjI0cHh9LnJlcG9ydCBoMzpmaXJzdC1jaGlsZHttYXJnaW4tdG9wOjB9Ci53aXphcmRiYXJ7cG9zaXRpb246Zml4ZWQ7bGVmdDoyNzVweDtyaWdodDowO2JvdHRvbTowO2JhY2tncm91bmQ6cmdiYSgyNDYsMjQ3LDI0OSwuOTQpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWxpbmUpO3BhZGRpbmc6MTNweCAzOHB4O3otaW5kZXg6MjB9Ci53aXphcmRpbm5lcnttYXgtd2lkdGg6MTQwMHB4O21hcmdpbjphdXRvO2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEycHh9Ci53aXphcmRtZXRhe2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKX0ud2l6YXJkbWV0YSBzdHJvbmd7ZGlzcGxheTpibG9jaztjb2xvcjojMzQ0MDU0O2ZvbnQtc2l6ZToxM3B4O21hcmdpbi1ib3R0b206MnB4fQoubmV4dGJ0bnttaW4td2lkdGg6MTUwcHh9LmJhY2tidG57bWluLXdpZHRoOjEwNXB4fQouaGlkZGVue2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9CkBtZWRpYShtYXgtd2lkdGg6OTgwcHgpey5hcHB7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn1hc2lkZXtwb3NpdGlvbjpyZWxhdGl2ZTtoZWlnaHQ6YXV0b30uc2lkZS1ub3Rle3Bvc2l0aW9uOnN0YXRpYzttYXJnaW4tdG9wOjE4cHh9LnByb2Nlc3N7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpfW1haW57cGFkZGluZzoyMnB4IDE2cHggMTIwcHh9LmcyLC5nMywuc3BsaXQsLmRldGVjdHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS53aXphcmRiYXJ7bGVmdDowO3BhZGRpbmc6MTJweCAxNnB4fS50b3B7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59fQpAbWVkaWEgcHJpbnR7YXNpZGUsLnRvcCwud2l6YXJkYmFyLC5uby1wcmludCwuYWN0aW9uc3tkaXNwbGF5Om5vbmUhaW1wb3J0YW50fS5hcHB7ZGlzcGxheTpibG9ja31tYWlue3BhZGRpbmc6MH0uc2VjdGlvbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fSNyZXBvcnQuc2VjdGlvbntkaXNwbGF5OmJsb2NrIWltcG9ydGFudH0ucGFuZWx7Ym9yZGVyOjA7Ym94LXNoYWRvdzpub25lO3BhZGRpbmc6MH1ib2R5e2JhY2tncm91bmQ6I2ZmZn19CgovKiA9PT09PSB2NiBVWCByZWZpbmVtZW50cyA9PT09PSAqLwouY2xhaW0tY2xlYW57CiAgZm9udC1mYW1pbHk6QXJpYWwsIkhlbHZldGljYSBOZXVlIiwiU2Vnb2UgVUkiLHNhbnMtc2VyaWY7CiAgZm9udC1zaXplOjE0cHg7bGluZS1oZWlnaHQ6MS43ODtjb2xvcjojMzQ0MDU0O3doaXRlLXNwYWNlOnByZS13cmFwOwp9Ci5jbGFpbS1yYXd7CiAgZm9udC1mYW1pbHk6dWktbW9ub3NwYWNlLFNGTW9uby1SZWd1bGFyLE1lbmxvLENvbnNvbGFzLG1vbm9zcGFjZSFpbXBvcnRhbnQ7CiAgZm9udC1zaXplOjEycHghaW1wb3J0YW50O2xpbmUtaGVpZ2h0OjEuNiFpbXBvcnRhbnQ7YmFja2dyb3VuZDojZjhmYWZjIWltcG9ydGFudDsKfQouY2xhaW0tc3RlcHsKICBkaXNwbGF5OmJsb2NrO21hcmdpbjo4cHggMDtwYWRkaW5nLWxlZnQ6MTRweDtib3JkZXItbGVmdDoycHggc29saWQgI2U0ZTdlYzsKfQouZmVhdHVyZS1yZXZpZXctYmFyewogIHBvc2l0aW9uOnN0aWNreTt0b3A6MTJweDt6LWluZGV4Ojg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICBnYXA6MTZweDtwYWRkaW5nOjE0cHggMTZweDttYXJnaW46MTZweCAwO2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuOTYpOwogIGJhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JvcmRlcjoxcHggc29saWQgI2QwZDVkZDtib3JkZXItcmFkaXVzOjE0cHg7CiAgYm94LXNoYWRvdzowIDEwcHggMjhweCByZ2JhKDE2LDI0LDQwLC4wOSkKfQouZmVhdHVyZS1yZXZpZXctYmFyIC5tZXRhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEwcHg7ZmxleC13cmFwOndyYXB9Ci5mZWF0dXJlLXJldmlldy1iYXIgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5mZWF0dXJlLXJldmlldy1iYXIgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojNjY3MDg1O21hcmdpbi10b3A6M3B4fQouZmVhdHVyZS1jb25maXJtZWR7Ym9yZGVyLWNvbG9yOiNhYmVmYzY7YmFja2dyb3VuZDpyZ2JhKDIzNiwyNTMsMjQzLC45Nyl9Ci5zZWFyY2gtaGVyb3sKICBwYWRkaW5nOjE3cHg7Ym9yZGVyOjFweCBzb2xpZCAjZDBkNWRkO2JvcmRlci1yYWRpdXM6MTZweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxODBkZWcsI2ZmZiwjZjhmYWZjKTsKICBtYXJnaW4tYm90dG9tOjE2cHgKfQouc291cmNlLXJvd3tkaXNwbGF5OmZsZXg7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5zb3VyY2UtY2hpcHsKICBkaXNwbGF5OmlubGluZS1mbGV4O2dhcDo2cHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgI2QwZDVkZDtiYWNrZ3JvdW5kOiNmZmY7CiAgY29sb3I6IzM0NDA1NDtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6N3B4IDEwcHg7Zm9udC1zaXplOjEycHg7dGV4dC1kZWNvcmF0aW9uOm5vbmU7Zm9udC13ZWlnaHQ6NzAwCn0KLnNvdXJjZS1jaGlwOmhvdmVye2JhY2tncm91bmQ6I2YyZjRmN30KLnNlYXJjaC10b29sYmFye2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjEwcHg7bWFyZ2luLXRvcDoxNHB4fQouc2VhcmNoLXN0YXRle2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM2NjcwODU7bWFyZ2luLXRvcDoxMHB4O2xpbmUtaGVpZ2h0OjEuNX0KLnNlYXJjaC1yZXN1bHQtdGl0bGV7Zm9udC13ZWlnaHQ6NzUwO2NvbG9yOiMxMDE4Mjg7dGV4dC1kZWNvcmF0aW9uOm5vbmV9LnNlYXJjaC1yZXN1bHQtdGl0bGU6aG92ZXJ7dGV4dC1kZWNvcmF0aW9uOnVuZGVybGluZX0KLnNjb3Jle2ZvbnQtd2VpZ2h0Ojg1MDtmb250LXNpemU6MTNweH0KLnNjb3JlLmhpZ2h7Y29sb3I6IzA2NzY0N30uc2NvcmUubWlke2NvbG9yOiNiNTQ3MDh9LnNjb3JlLmxvd3tjb2xvcjojNjY3MDg1fQouY2FuZGlkYXRlLWFjdGlvbnN7ZGlzcGxheTpmbGV4O2dhcDo2cHg7ZmxleC13cmFwOndyYXB9Ci5zbG90YnRue3BhZGRpbmc6NnB4IDlweDtib3JkZXItcmFkaXVzOjlweDtib3JkZXI6MXB4IHNvbGlkICNkMGQ1ZGQ7YmFja2dyb3VuZDojZmZmO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MH0KLnNsb3RidG46aG92ZXJ7YmFja2dyb3VuZDojZjJmNGY3fQoucHJpb3Itc2xvdHsKICBib3JkZXI6MXB4IHNvbGlkICNlNGU3ZWM7Ym9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MTRweDtiYWNrZ3JvdW5kOiNmZmYKfQoucHJpb3Itc2xvdC5zZWxlY3RlZHtib3JkZXItY29sb3I6Izg0YWRmZjtib3gtc2hhZG93OjAgMCAwIDNweCAjZWZmOGZmfQouc2V0dGluZ3MtZ3JpZHtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmVuZH0KLmJhY2tlbmQtb2t7Y29sb3I6IzA2NzY0N30uYmFja2VuZC1iYWR7Y29sb3I6I2I0MjMxOH0KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgLmZlYXR1cmUtcmV2aWV3LWJhcntwb3NpdGlvbjpzdGF0aWM7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59CiAgLnNlYXJjaC10b29sYmFyLC5zZXR0aW5ncy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9Cn0KCjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+CjxkaXYgY2xhc3M9ImFwcCI+Cjxhc2lkZT4KICA8ZGl2IGNsYXNzPSJicmFuZCI+PGRpdiBjbGFzcz0ibG9nbyI+UDwvZGl2PjxkaXY+PHN0cm9uZz5QYXRlbnRMZW5zIEFJPC9zdHJvbmc+PHNtYWxsPlByb3RvdHlwZSBuZ2hpw6puIGPhu6l1IMK3IEZ1bGwtc3RhY2sgdjEyLjAgTGFuZ3VhZ2UtQXdhcmUgT0NSPC9zbWFsbD48L2Rpdj48L2Rpdj4KICA8ZGl2IGNsYXNzPSJwcm9jZXNzIiBpZD0icHJvY2VzcyI+PC9kaXY+CiAgPGRpdiBjbGFzcz0ic2lkZS1ub3RlIj48c3Ryb25nIHN0eWxlPSJjb2xvcjojZmZmIj5QaOG6oW0gdmkgcHJvdG90eXBlPC9zdHJvbmc+PGJyLz5I4buXIHRy4bujIGNodeG7l2kgdHJhIGPhu6l1IHbDoCDEkcOhbmggZ2nDoSBzxqEgYuG7mSBzw6FuZyBjaOG6vy4gS2jDtG5nIHRoYXkgdGjhur8gY2h1ecOqbiBnaWEgdsOgIGtow7RuZyDEkeG6oWkgZGnhu4duIHRvw6BuIGLhu5kgcXV5IHRyw6xuaCB4w6FjIGzhuq1wIHF1eeG7gW4gY+G7p2EgSVAgR1JPVVAuPC9kaXY+CjwvYXNpZGU+Cgo8bWFpbj4KICA8ZGl2IGNsYXNzPSJ0b3AiPjxkaXY+PGgxIGlkPSJwYWdlVGl0bGUiPjwvaDE+PHAgaWQ9InBhZ2VTdWIiPjwvcD48L2Rpdj48ZGl2IGNsYXNzPSJjYXNlLWJhZGdlIiBpZD0iY2FzZUJhZGdlIj5DaMawYSBjw7MgY2FzZTwvZGl2PjwvZGl2PgogIDxkaXYgY2xhc3M9ImxvY2FsLWJhbm5lciIgaWQ9ImxvY2FsQmFubmVyIiBzdHlsZT0iZGlzcGxheTpub25lIj5C4bqhbiDEkWFuZyBt4bufIGLhurFuZyA8c3Ryb25nPmZpbGU6Ly88L3N0cm9uZz4uIENocm9tZSBjw7MgdGjhu4MgY2jhurduIFdlYiBXb3JrZXIgZMO5bmcgY2hvIE9DUi4gQuG6o24gbsOgeSB24bqrbiBj4buRIMSR4buNYyBQREYgYuG6sW5nIHRleHQgbGF5ZXI7IMSR4buDIE9DUiDhu5VuIMSR4buLbmgsIG7Dqm4gY2jhuqF5IGLhurFuZyA8c3Ryb25nPkdpdEh1YiBQYWdlczwvc3Ryb25nPiBob+G6t2MgbG9jYWwgc2VydmVyICh2w60gZOG7pSA8Y29kZT5weXRob24zIC1tIGh0dHAuc2VydmVyPC9jb2RlPikuPC9kaXY+CgogIDxzZWN0aW9uIGlkPSJpbnRha2UiIGNsYXNzPSJzZWN0aW9uIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPjEuIFThuqNpIHTDoGkgbGnhu4d1IHPDoW5nIGNo4bq/PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5I4buHIHRo4buRbmcgdOG7sSDEkeG7jWMgUERGLiBO4bq/dSBmaWxlIGPDsyB0ZXh0IGxheWVyIHPhur0gdHLDrWNoIHRy4buxYyB0aeG6v3A7IG7hur91IGzDoCBi4bqjbiBzY2FuLCBo4buHIHRo4buRbmcgdOG7sSBjaHV54buDbiBzYW5nIE9DUiDEkeG7gyBj4buRIGfhuq9uZyBuaOG6rW4gZGnhu4duIG1ldGFkYXRhIHbDoCB5w6p1IGPhuqd1IGLhuqNvIGjhu5kuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImRyb3AiIGlkPSJkcm9wWm9uZSI+CiAgICAgICAgPHN0cm9uZz5UaOG6oyBQREYgdsOgbyDEkcOieSBob+G6t2MgY2jhu41uIGZpbGU8L3N0cm9uZz4KICAgICAgICA8c21hbGw+SOG7lyB0cuG7oyBQREYgcGF0ZW50IHRp4bq/bmcgVmnhu4d0L0FuaC4gT0NSIGPDsyB0aOG7gyBt4bqldCB2w6BpIHBow7p0IHbhu5tpIGLhuqNuIHNjYW4uPC9zbWFsbD48YnIvPjxici8+CiAgICAgICAgPGlucHV0IGlkPSJwZGZJbnB1dCIgdHlwZT0iZmlsZSIgYWNjZXB0PSJhcHBsaWNhdGlvbi9wZGYiIHN0eWxlPSJtYXgtd2lkdGg6NDIwcHgiLz4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InByb2dyZXNzIj48ZGl2IGlkPSJwcm9ncmVzc0JhciI+PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXR1cyIgaWQ9InBkZlN0YXR1cyI+Q2jGsGEgY8OzIGZpbGUuPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj5L4bq/dCBxdeG6oyBuaOG6rW4gZGnhu4duIHThu7EgxJHhu5luZzwvaDI+CiAgICAgIDxkaXYgY2xhc3M9ImRldGVjdCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZGV0ZWN0LWNhcmQiIGlkPSJkZXRNZXRhIj48Yj5NZXRhZGF0YTwvYj48c3Bhbj5DaMawYSB44butIGzDvTwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkZXRlY3QtY2FyZCIgaWQ9ImRldEFic3RyYWN0Ij48Yj5Uw7NtIHThuq90PC9iPjxzcGFuPkNoxrBhIHjhu60gbMO9PC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRldGVjdC1jYXJkIiBpZD0iZGV0Q2xhaW1zIj48Yj5Zw6p1IGPhuqd1IGLhuqNvIGjhu5k8L2I+PHNwYW4+Q2jGsGEgeOG7rSBsw708L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZGV0ZWN0LWNhcmQiIGlkPSJkZXRPQ1IiPjxiPk9DUjwvYj48c3Bhbj5DaMawYSBj4bqnbjwvc3Bhbj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj5UaMO0bmcgdGluIHPDoW5nIGNo4bq/PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5Dw6FjIHRyxrDhu51uZyDEkcaw4bujYyB04buxIMSRaeG7gW4gdOG7qyBQREY7IG5nxrDhu51pIGTDuW5nIGPDsyB0aOG7gyBz4butYSBu4bq/dSBuaOG6rW4gZGnhu4duIHNhaS48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMyI+CiAgICAgICAgPGRpdj48bGFiZWw+TcOjIGNhc2U8L2xhYmVsPjxpbnB1dCBpZD0iY2FzZUlkIi8+PC9kaXY+CiAgICAgICAgPGRpdj48bGFiZWw+U+G7kSBi4bqxbmcgLyBz4buRIGPDtG5nIGLhu5E8L2xhYmVsPjxpbnB1dCBpZD0icGF0ZW50Tm8iLz48L2Rpdj4KICAgICAgICA8ZGl2PjxsYWJlbD5RdeG7kWMgZ2lhIC8gaOG7hyB0aOG7kW5nPC9sYWJlbD48c2VsZWN0IGlkPSJqdXJpc2RpY3Rpb24iPjxvcHRpb24+Vk48L29wdGlvbj48b3B0aW9uPlVTPC9vcHRpb24+PG9wdGlvbj5XTy9QQ1Q8L29wdGlvbj48b3B0aW9uPkVQPC9vcHRpb24+PG9wdGlvbj5LaMOhYzwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPGRpdj48bGFiZWw+VMOqbiBzw6FuZyBjaOG6vzwvbGFiZWw+PGlucHV0IGlkPSJ0aXRsZSIvPjwvZGl2PgogICAgICAgIDxkaXY+PGxhYmVsPk5nw6B5IG7hu5lwIMSRxqFuIC8gbmfDoHkgxrB1IHRpw6puPC9sYWJlbD48aW5wdXQgaWQ9ImZpbGluZ0RhdGUiIHR5cGU9ImRhdGUiLz48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIDxkaXY+PGxhYmVsPkNo4bunIMSRxqFuIC8gY2jhu6cgYuG6sW5nPC9sYWJlbD48aW5wdXQgaWQ9ImFwcGxpY2FudCIvPjwvZGl2PgogICAgICAgIDxkaXY+PGxhYmVsPsSQ4bqhaSBkaeG7h24gU0hUVDwvbGFiZWw+PGlucHV0IGlkPSJyZXByZXNlbnRhdGl2ZSIvPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij48bGFiZWw+SVBDIC8gQ1BDPC9sYWJlbD48aW5wdXQgaWQ9ImlwYyIvPjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxsYWJlbD5Uw7NtIHThuq90PC9sYWJlbD48dGV4dGFyZWEgaWQ9ImFic3RyYWN0Ij48L3RleHRhcmVhPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIG5vLXByaW50Ij48YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9InJldHJ5T0NSIj5U4buxIHF1w6l0IE9DUiB5w6p1IGPhuqd1IGLhuqNvIGjhu5k8L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJsb2FkRGVtbyI+TuG6oXAgZGVtbyBQSC1WTi0wMTwvYnV0dG9uPjwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgoKICA8c2VjdGlvbiBpZD0iY2xhaW1zIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj4yLiBYw6FjIMSR4buLbmggecOqdSBj4bqndSBi4bqjbyBo4buZPC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5I4buHIHRo4buRbmcgbMOgbSBz4bqhY2ggdsSDbiBi4bqjbiBPQ1IgdHLGsOG7m2Mga2hpIGhp4buDbiB0aOG7iy4gQuG6o24gT0NSIHRow7QgduG6q24gxJHGsOG7o2MgZ2nhu68gxJHhu4MgxJHhu5FpIGNoaeG6v3Uga2hpIGPhuqduLjwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic3BsaXQiPgogICAgICAgIDxkaXY+CiAgICAgICAgICA8bGFiZWw+QuG6o24gecOqdSBj4bqndSBi4bqjbyBo4buZIMSRw6MgY2h14bqpbiBow7NhPC9sYWJlbD4KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0iY2xhaW1zQ2xlYW4iIGNsYXNzPSJjbGFpbS1jbGVhbiIgc3R5bGU9Im1pbi1oZWlnaHQ6MzkwcHgiIHBsYWNlaG9sZGVyPSJO4buZaSBkdW5nIGNsYWltcyDEkcOjIGzDoG0gc+G6oWNoIHPhur0gaGnhu4NuIHRo4buLIHThuqFpIMSRw6J5LiI+PC90ZXh0YXJlYT4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9InBhcnNlQ2xhaW1zIj5DaHXhuqluIGjDs2EgJiB0w6FjaCBs4bqhaSBjbGFpbXM8L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ib2NyQ2xhaW1zQWdhaW4iPlThu7EgcXXDqXQgT0NSIGNsYWltczwvYnV0dG9uPgogICAgICAgICAgPC9kaXY+CgogICAgICAgICAgPGRldGFpbHMgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgICAgIDxzdW1tYXJ5IHN0eWxlPSJjdXJzb3I6cG9pbnRlcjtmb250LXNpemU6MTJweDtjb2xvcjojNjY3MDg1Ij5YZW0gYuG6o24gT0NSIHRow7QgLyBjaOG7iW5oIHRheTwvc3VtbWFyeT4KICAgICAgICAgICAgPHRleHRhcmVhIGlkPSJjbGFpbXNSYXciIGNsYXNzPSJjbGFpbS1yYXciIHN0eWxlPSJtaW4taGVpZ2h0OjIzMHB4O21hcmdpbi10b3A6MTBweCIgcGxhY2Vob2xkZXI9IkLhuqNuIE9DUiB0aMO0LiI+PC90ZXh0YXJlYT4KICAgICAgICAgIDwvZGV0YWlscz4KICAgICAgICA8L2Rpdj4KCiAgICAgICAgPGRpdj4KICAgICAgICAgIDxsYWJlbD5EYW5oIHPDoWNoIGNsYWltczwvbGFiZWw+CiAgICAgICAgICA8ZGl2IGlkPSJjbGFpbUxpc3QiIGNsYXNzPSJlbXB0eSI+Q2jGsGEgY8OzIGNsYWltLjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9ImZlYXR1cmVzIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj4zLiBQaMOibiB0w61jaCBk4bqldSBoaeG7h3Uga+G7uSB0aHXhuq10PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5Uw6FjaCBjbGFpbSDEkcOjIGNo4buNbiB0aMOgbmggdOG7q25nIGThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQgxJHhu4MgcGjhu6VjIHbhu6UgdHJhIGPhu6l1IHbDoCBs4bqtcCBi4bqjbmcgc28gc8OhbmguIELhu5kgZOG6pXUgaGnhu4d1IMSRxrDhu6NjIHBow6lwIGNo4buJbmggc+G7rWEgdHLGsOG7m2Mga2hpIHjDoWMgbmjhuq1uLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj48ZGl2PjxsYWJlbD5DbGFpbSBj4bqnbiBwaMOibiB0w61jaDwvbGFiZWw+PHNlbGVjdCBpZD0iY2xhaW1TZWxlY3QiPjwvc2VsZWN0PjwvZGl2PjxkaXY+PGxhYmVsPlRy4bqhbmcgdGjDoWk8L2xhYmVsPjxpbnB1dCBpZD0iZmVhdHVyZVN0YXR1cyIgdmFsdWU9IkNoxrBhIHThuqFvIiByZWFkb25seS8+PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZlYXR1cmUtcmV2aWV3LWJhciIgaWQ9ImZlYXR1cmVSZXZpZXdCYXIiPgogICAgICAgIDxkaXYgY2xhc3M9Im1ldGEiPgogICAgICAgICAgPHNwYW4gY2xhc3M9InBpbGwgeWVsbG93IiBpZD0iZmVhdHVyZVN0YXR1c0JhZGdlIj5DaMawYSB4w6FjIG5o4bqtbjwvc3Bhbj4KICAgICAgICAgIDxkaXY+PHN0cm9uZyBpZD0iZmVhdHVyZUNvdW50TGFiZWwiPkNoxrBhIGPDsyBk4bqldSBoaeG7h3U8L3N0cm9uZz48c21hbGw+S2nhu4NtIHRyYSBu4buZaSBkdW5nIHRyxrDhu5tjIGtoaSBraMOzYSBi4buZIGThuqV1IGhp4buHdSDEkeG7gyB0cmEgY+G7qXUuPC9zbWFsbD48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIiBzdHlsZT0ibWFyZ2luLXRvcDowIj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9ImF1dG9GZWF0dXJlcyI+VOG6oW8gLyB0w6FjaCBs4bqhaTwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJjb25maXJtRmVhdHVyZXMiPuKckyBYw6FjIG5o4bqtbiBi4buZIGThuqV1IGhp4buHdTwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCIgc3R5bGU9Im1hcmdpbi10b3A6MThweCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPk3DozwvdGg+PHRoPkThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQ8L3RoPjx0aD5OaMOzbTwvdGg+PHRoPsSQ4buZIHRpbiBj4bqteTwvdGg+PHRoPjwvdGg+PC90cj48L3RoZWFkPjx0Ym9keSBpZD0iZmVhdHVyZUJvZHkiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9InNlYXJjaCIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+NC4gWMOieSBk4buxbmcgY2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdTwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN1YiI+VOG7qyBi4buZIGThuqV1IGhp4buHdSDEkcOjIHjDoWMgbmjhuq1uLCBo4buHIHRo4buRbmcgc2luaCB04burIGtow7NhIHbDoCBjw6J1IGzhu4duaCBzxqEgYuG7mS4gxJDDonkgbMOgIGLGsOG7m2MgaOG7lyB0cuG7oyBjaHV5w6puIGdpYSB4w6J5IGThu7FuZyB2w6AgbOG6t3AgbOG6oWkgY2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdS48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+PGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJnZW5TZWFyY2giPlThuqFvIGNoaeG6v24gbMaw4bujYyB0cmEgY+G7qXU8L2J1dHRvbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCIgc3R5bGU9Im1hcmdpbi10b3A6MThweCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPkZlYXR1cmU8L3RoPjx0aD5U4burIGtow7NhIGNow61uaDwvdGg+PHRoPkJp4bq/biB0aOG7gyAvIHN5bm9ueW08L3RoPjx0aD5JUEMvQ1BDIGfhu6NpIMO9PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5IGlkPSJzZWFyY2hCb2R5Ij48L3Rib2R5PjwvdGFibGU+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImRpdmlkZXIiPjwvZGl2PjxsYWJlbD5Dw6J1IGzhu4duaCBn4bujaSDDvTwvbGFiZWw+PGRpdiBpZD0icXVlcnlMaXN0IiBjbGFzcz0iZ3JpZCI+PC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CgogIDxzZWN0aW9uIGlkPSJwcmlvciIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+NS4gVMOsbSAmIHPDoG5nIGzhu41jIHTDoGkgbGnhu4d1IMSR4buRaSBjaOG7qW5nPC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj4KICAgICAgICBI4buHIHRo4buRbmcgdOG6oW8gdHJ1eSB24bqlbiB04burIGLhu5kgZOG6pXUgaGnhu4d1LCB0w6xtIHBhdGVudCB0aOG6rXQgcXVhIGJhY2tlbmQgR29vZ2xlIFBhdGVudHMsIHjhur9wIGjhuqFuZyB0aGVvIMSR4buZIGxpw6puIHF1YW4gdsOgIMSRaeG7gXUga2nhu4duIHRo4budaSBnaWFuLAogICAgICAgIHNhdSDEkcOzIGNobyBwaMOpcCBjaOG7jW4gdHLhu7FjIHRp4bq/cCBEMeKAk0QzLiBXSVBPIFBBVEVOVFNDT1BFIHbDoCBFc3BhY2VuZXQgxJHGsOG7o2MgZMO5bmcgbMOgbSBuZ3Xhu5NuIGtp4buDbSBjaOG7qW5nIGLhu5Ugc3VuZy4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtaGVybyI+CiAgICAgICAgPGRpdiBjbGFzcz0ic291cmNlLXJvdyI+CiAgICAgICAgICA8c3Ryb25nIHN0eWxlPSJmb250LXNpemU6MTNweCI+Tmd14buTbiB0cmEgY+G7qXU6PC9zdHJvbmc+CiAgICAgICAgICA8YSBjbGFzcz0ic291cmNlLWNoaXAiIGlkPSJncExpbmsiIGhyZWY9Imh0dHBzOi8vcGF0ZW50cy5nb29nbGUuY29tLyIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkdvb2dsZSBQYXRlbnRzIOKGlzwvYT4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaWQ9IndpcG9MaW5rIiBocmVmPSJodHRwczovL3BhdGVudHNjb3BlLndpcG8uaW50LyIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPldJUE8gUEFURU5UU0NPUEUg4oaXPC9hPgogICAgICAgICAgPGEgY2xhc3M9InNvdXJjZS1jaGlwIiBpZD0iZXBvTGluayIgaHJlZj0iaHR0cHM6Ly93b3JsZHdpZGUuZXNwYWNlbmV0LmNvbS8iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj5FUE8gRXNwYWNlbmV0IOKGlzwvYT4KICAgICAgICA8L2Rpdj4KCiAgICAgICAgPGRpdiBjbGFzcz0ic2VhcmNoLXRvb2xiYXIiPgogICAgICAgICAgPGlucHV0IGlkPSJsaXZlU2VhcmNoUXVlcnkiIHBsYWNlaG9sZGVyPSdWw60gZOG7pTogImRyYWdvbiBmcnVpdCBzZWVkIiBjZWxsdWxhc2UgcGVjdGluYXNlJz4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0ibGl2ZVNlYXJjaEJ0biI+4oyVIFTDrG0gdMOgaSBsaeG7h3UgdGjhuq10PC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ic2VhcmNoLXN0YXRlIiBpZD0ibGl2ZVNlYXJjaFN0YXRlIj5DaMawYSBjaOG6oXkgdHJhIGPhu6l1LjwvZGl2PgoKICAgICAgICA8ZGl2IGNsYXNzPSJjYWxsb3V0IiBzdHlsZT0ibWFyZ2luLXRvcDoxM3B4Ij4KICAgICAgPHN0cm9uZz5CYWNrZW5kIHTDrWNoIGjhu6NwIGPDuW5nIHdlYnNpdGU8L3N0cm9uZz48YnI+CiAgICAgIELhuqNuIGZ1bGwtc3RhY2sgc+G7rSBk4bulbmcgQVBJIGPDuW5nIGRvbWFpbiAoPGNvZGU+L2FwaS8qPC9jb2RlPiksIG7Dqm4ga2jDtG5nIGPhuqduIG5o4bqtcCBXb3JrZXIgVVJMIHJpw6puZy4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0idGVzdEJhY2tlbmQiPktp4buDbSB0cmEgYmFja2VuZDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdHVzIiBpZD0iYmFja2VuZFN0YXR1cyI+Q2jGsGEga2nhu4NtIHRyYSBr4bq/dCBu4buRaS48L2Rpdj4KICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InVzZUJlc3RRdWVyeSI+RMO5bmcgdHJ1eSB24bqlbiB04burIGLGsOG7m2MgNDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzdWNjZXNzIiBpZD0iYXV0b1BpY2tQcmlvciI+VOG7sSBn4bujaSDDvSBEMeKAk0QzPC9idXR0b24+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCIgc3R5bGU9Im1hcmdpbi10b3A6MTZweCI+CiAgICAgICAgPHRhYmxlPgogICAgICAgICAgPHRoZWFkPgogICAgICAgICAgICA8dHI+CiAgICAgICAgICAgICAgPHRoPiM8L3RoPjx0aD5Uw6BpIGxp4buHdSB0aOG6rXQ8L3RoPjx0aD5OZ8OgeTwvdGg+PHRoPsSQ4buZIHBow7kgaOG7o3A8L3RoPjx0aD7EkGnhu4F1IGtp4buHbiB0aOG7nWkgZ2lhbjwvdGg+PHRoPkNo4buNbjwvdGg+CiAgICAgICAgICAgIDwvdHI+CiAgICAgICAgICA8L3RoZWFkPgogICAgICAgICAgPHRib2R5IGlkPSJjYW5kaWRhdGVCb2R5Ij4KICAgICAgICAgICAgPHRyPjx0ZCBjb2xzcGFuPSI2IiBzdHlsZT0iY29sb3I6Izk4YTJiMzt0ZXh0LWFsaWduOmNlbnRlciI+Q2jGsGEgY8OzIGvhur90IHF14bqjIHRyYSBj4bupdS48L3RkPjwvdHI+CiAgICAgICAgICA8L3Rib2R5PgogICAgICAgIDwvdGFibGU+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+RDHigJNEMyDEkcaw4bujYyBjaOG7jW48L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPktoaSBjaOG7jW4gbeG7mXQga+G6v3QgcXXhuqMsIGjhu4cgdGjhu5FuZyB04buxIGzhuqV5IG1ldGFkYXRhIHbDoCBu4buZaSBkdW5nIHBhdGVudCDEkeG7gyDEkWnhu4FuIHbDoG8gc2xvdCB0xrDGoW5nIOG7qW5nLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwcmlvci1zbG90IiBpZD0ic2xvdEQxIj4KICAgICAgICAgIDxoND5EMSDCtyDhu6huZyB2acOqbiDEkeG7kWkgY2jhu6luZyBn4bqnbiBuaOG6pXQ8L2g0PgogICAgICAgICAgPGlucHV0IGlkPSJkMU5vIiBwbGFjZWhvbGRlcj0iU+G7kSBjw7RuZyBi4buRIj4KICAgICAgICAgIDxpbnB1dCBpZD0iZDFEYXRlIiB0eXBlPSJkYXRlIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgICAgPGlucHV0IGlkPSJkMVVybCIgcGxhY2Vob2xkZXI9IlVSTCBuZ3Xhu5NuIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgICAgPHRleHRhcmVhIGlkPSJkMVRleHQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweDttaW4taGVpZ2h0OjE5MHB4IiBwbGFjZWhvbGRlcj0iQWJzdHJhY3QgLyBjbGFpbXMgLyBzbmlwcGV0IHPhur0gxJHGsOG7o2MgdOG7sSDEkWnhu4FuLi4uIj48L3RleHRhcmVhPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InByaW9yLXNsb3QiIGlkPSJzbG90RDIiPgogICAgICAgICAgPGg0PkQyIMK3IFTDoGkgbGnhu4d1IGLhu5Ugc3VuZzwvaDQ+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQyTm8iIHBsYWNlaG9sZGVyPSJT4buRIGPDtG5nIGLhu5EiPgogICAgICAgICAgPGlucHV0IGlkPSJkMkRhdGUiIHR5cGU9ImRhdGUiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQyVXJsIiBwbGFjZWhvbGRlcj0iVVJMIG5ndeG7k24iIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgICA8dGV4dGFyZWEgaWQ9ImQyVGV4dCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4O21pbi1oZWlnaHQ6MTkwcHgiIHBsYWNlaG9sZGVyPSJBYnN0cmFjdCAvIGNsYWltcyAvIHNuaXBwZXQgc+G6vSDEkcaw4bujYyB04buxIMSRaeG7gW4uLi4iPjwvdGV4dGFyZWE+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icHJpb3Itc2xvdCIgaWQ9InNsb3REMyI+CiAgICAgICAgICA8aDQ+RDMgwrcgVMOgaSBsaeG7h3UgYuG7lSBzdW5nPC9oND4KICAgICAgICAgIDxpbnB1dCBpZD0iZDNObyIgcGxhY2Vob2xkZXI9IlPhu5EgY8O0bmcgYuG7kSI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQzRGF0ZSIgdHlwZT0iZGF0ZSIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICAgIDxpbnB1dCBpZD0iZDNVcmwiIHBsYWNlaG9sZGVyPSJVUkwgbmd14buTbiIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0iZDNUZXh0IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHg7bWluLWhlaWdodDoxOTBweCIgcGxhY2Vob2xkZXI9IkFic3RyYWN0IC8gY2xhaW1zIC8gc25pcHBldCBz4bq9IMSRxrDhu6NjIHThu7EgxJFp4buBbi4uLiI+PC90ZXh0YXJlYT4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIj48YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9InZhbGlkYXRlUHJpb3IiPktp4buDbSB0cmEgxJFp4buBdSBraeG7h24gdGjhu51pIGdpYW48L2J1dHRvbj48L2Rpdj4KICAgICAgPGRpdiBpZD0icHJpb3JDaGVjayIgY2xhc3M9ImNhbGxvdXQiIHN0eWxlPSJtYXJnaW4tdG9wOjE2cHgiPjxzdHJvbmc+TMawdSDDvTo8L3N0cm9uZz4gbmfDoHkgdsOgIG7hu5lpIGR1bmcgduG6q24gY+G6p24gY2h1ecOqbiBnaWEga2nhu4NtIGNo4bupbmcgdHLDqm4gdMOgaSBsaeG7h3UgZ+G7kWMuPC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CgogIDxzZWN0aW9uIGlkPSJjb21wYXJlIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj42LiBM4bqtcCBi4bqjbmcgc28gc8OhbmggZOG6pXUgaGnhu4d1PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj7EkOG7kWkgY2hp4bq/dSB04burbmcgZOG6pXUgaGnhu4d1IHbhu5tpIHThu6tuZyB0w6BpIGxp4buHdS4gTuG6v3UgY2jGsGEgY8OzIGLhurFuZyBjaOG7qW5nIMSR4bunIHLDtSwgaOG7hyB0aOG7kW5nIHBo4bqjaSB0cuG6oyB24buBIOKAnENoxrBhIGNo4bqvYyBjaOG6r27igJ0uPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0iYnVpbGRNYXRyaXgiPlThuqFvIG1hIHRy4bqtbiDEkeG7kWkgY2hp4bq/dTwvYnV0dG9uPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIiBzdHlsZT0ibWFyZ2luLXRvcDoxOHB4Ij48dGFibGU+PHRoZWFkPjx0cj48dGg+RmVhdHVyZTwvdGg+PHRoPkQxPC90aD48dGg+RDI8L3RoPjx0aD5EMzwvdGg+PHRoPkLhurFuZyBjaOG7qW5nIC8gZ2hpIGNow7o8L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9Im1hdHJpeEJvZHkiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9ImFzc2VzcyIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+Ny4gxJDDoW5oIGdpw6Egc8ahIGLhu5k8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPsSQw6FuaCBnacOhIHRoZW8gdOG7q25nIGNsYWltIHbDoCB04bqtcCB0w6BpIGxp4buHdSDEkWFuZyBraOG6o28gc8OhdDsga2jDtG5nIHBo4bqjaSBr4bq/dCBsdeG6rW4gY+G6pXAgYuG6sW5nLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyaXNrIj48ZGl2PjxoMz5Uw61uaCBt4bubaTwvaDM+PHAgaWQ9Im5vdmVsdHlUZXh0Ij5DaMawYSDEkcOhbmggZ2nDoS48L3A+PC9kaXY+PGRpdiBjbGFzcz0icmlza2JveCB5ZWxsb3ciIGlkPSJub3ZlbHR5UmlzayI+Q0jhu5wgROG7riBMSeG7hlU8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0iaGVpZ2h0OjEycHgiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyaXNrIj48ZGl2PjxoMz5UcsOsbmggxJHhu5kgc8OhbmcgdOG6oW88L2gzPjxwIGlkPSJpbnZlbnRpdmVUZXh0Ij5DaMawYSDEkcOhbmggZ2nDoS48L3A+PC9kaXY+PGRpdiBjbGFzcz0icmlza2JveCB5ZWxsb3ciIGlkPSJpbnZlbnRpdmVSaXNrIj5DSOG7nCBE4buuIExJ4buGVTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJkaXZpZGVyIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+PGRpdj48bGFiZWw+xJDhu5FpIGNo4bupbmcgZ+G6p24gbmjhuqV0PC9sYWJlbD48c2VsZWN0IGlkPSJjbG9zZXN0Ij48b3B0aW9uPkQxPC9vcHRpb24+PG9wdGlvbj5EMjwvb3B0aW9uPjxvcHRpb24+RDM8L29wdGlvbj48L3NlbGVjdD48L2Rpdj48ZGl2PjxsYWJlbD5E4bqldSBoaeG7h3Uga2jDoWMgYmnhu4d0PC9sYWJlbD48dGV4dGFyZWEgaWQ9ImRpZmZlcmVuY2VzIj48L3RleHRhcmVhPjwvZGl2PjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxsYWJlbD5W4bqlbiDEkeG7gSBr4bu5IHRodeG6rXQga2jDoWNoIHF1YW48L2xhYmVsPjx0ZXh0YXJlYSBpZD0icHJvYmxlbSI+PC90ZXh0YXJlYT48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij48bGFiZWw+TOG6rXAgbHXhuq1uIHPGoSBi4buZIHbhu4EgdMOtbmggaGnhu4NuIG5oacOqbjwvbGFiZWw+PHRleHRhcmVhIGlkPSJyZWFzb25pbmciPjwvdGV4dGFyZWE+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0icnVuQXNzZXNzbWVudCI+Q2jhuqF5IMSRw6FuaCBnacOhIHPGoSBi4buZPC9idXR0b24+PC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CgogIDxzZWN0aW9uIGlkPSJleHBlcnQiIGNsYXNzPSJzZWN0aW9uIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPjguIENodXnDqm4gZ2lhIHLDoCBzb8OhdDwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN1YiI+Q2h1ecOqbiBnaWEgeMOhYyBuaOG6rW4vY2jhu4luaCBz4butYS9iw6FjIGLhu48gdOG7q25nIMSR4bqndSByYS4gxJDDonkgbMOgIGNoZWNrcG9pbnQgYuG6r3QgYnXhu5ljIGPhu6dhIG3DtCBow6xuaCBIdW1hbi1pbi10aGUtbG9vcC48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPkjhuqFuZyBt4bulYzwvdGg+PHRoPkvhur90IHF14bqjIGjhu4cgdGjhu5FuZzwvdGg+PHRoPlF1eeG6v3QgxJHhu4tuaCBjaHV5w6puIGdpYTwvdGg+PHRoPk5o4bqtbiB4w6l0PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5IGlkPSJleHBlcnRCb2R5Ij48L3Rib2R5PjwvdGFibGU+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0ic2F2ZVJldmlldyI+TMawdSByw6Agc2/DoXQ8L2J1dHRvbj48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9InJlcG9ydCIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+OS4gQsOhbyBjw6FvIHBow6JuIHTDrWNoIHPGoSBi4buZPC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIG5vLXByaW50Ij5U4buVbmcgaOG7o3AgZOG7ryBsaeG7h3UgdOG7qyB0b8OgbiBi4buZIHBpcGVsaW5lLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIG5vLXByaW50Ij48YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9ImdlblJlcG9ydCI+VOG6oW8gYsOhbyBjw6FvPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0iYnRuIiBvbmNsaWNrPSJ3aW5kb3cucHJpbnQoKSI+SW4gLyBMxrB1IFBERjwvYnV0dG9uPjwvZGl2PgogICAgICA8ZGl2IGlkPSJyZXBvcnRDb250ZW50IiBjbGFzcz0icmVwb3J0Ij48ZGl2IGNsYXNzPSJlbXB0eSI+Q2jGsGEgdOG6oW8gYsOhbyBjw6FvLjwvZGl2PjwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgo8L21haW4+CjwvZGl2PgoKPGRpdiBjbGFzcz0id2l6YXJkYmFyIG5vLXByaW50Ij4KICA8ZGl2IGNsYXNzPSJ3aXphcmRpbm5lciI+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYmFja2J0biIgaWQ9ImJhY2tCdG4iPuKGkCBRdWF5IGzhuqFpPC9idXR0b24+CiAgICA8ZGl2IGNsYXNzPSJ3aXphcmRtZXRhIj48c3Ryb25nIGlkPSJ3aXphcmRUaXRsZSI+PC9zdHJvbmc+PHNwYW4gaWQ9IndpemFyZEhpbnQiPjwvc3Bhbj48L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IG5leHRidG4iIGlkPSJuZXh0QnRuIj5UaeG6v3AgdOG7pWMg4oaSPC9idXR0b24+CiAgPC9kaXY+CjwvZGl2PgoKPHNjcmlwdD4KY29uc3QgU1RFUFM9WwogIHtpZDoiaW50YWtlIix0aXRsZToiVGnhur9wIG5o4bqtbiBo4buTIHPGoSIsaGludDoiVOG6o2kgUERGIHbDoCBraeG7g20gdHJhIGThu68gbGnhu4d1IHThu7EgxJHhu5luZyB0csOtY2ggeHXhuqV0LiJ9LAogIHtpZDoiY2xhaW1zIix0aXRsZToiWcOqdSBj4bqndSBi4bqjbyBo4buZIixoaW50OiJDaOG7jW4gY2xhaW0gY+G6p24gcGjDom4gdMOtY2guIn0sCiAge2lkOiJmZWF0dXJlcyIsdGl0bGU6IkThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQiLGhpbnQ6IlTDoWNoIHbDoCB4w6FjIG5o4bqtbiBmZWF0dXJlIHNldC4ifSwKICB7aWQ6InNlYXJjaCIsdGl0bGU6IkNoaeG6v24gbMaw4bujYyB0cmEgY+G7qXUiLGhpbnQ6IlNpbmgga2V5d29yZC9JUEMvcXVlcnkuIn0sCiAge2lkOiJwcmlvciIsdGl0bGU6IlTDoGkgbGnhu4d1IMSR4buRaSBjaOG7qW5nIixoaW50OiJOaOG6rXAva2nhu4NtIHRyYSBwcmlvciBhcnQuIn0sCiAge2lkOiJjb21wYXJlIix0aXRsZToiQuG6o25nIHNvIHPDoW5oIixoaW50OiJNYXAgZmVhdHVyZSB24bubaSBldmlkZW5jZS4ifSwKICB7aWQ6ImFzc2VzcyIsdGl0bGU6IsSQw6FuaCBnacOhIHPGoSBi4buZIixoaW50OiJOb3ZlbHR5IHbDoCBpbnZlbnRpdmUgc3RlcC4ifSwKICB7aWQ6ImV4cGVydCIsdGl0bGU6IkNodXnDqm4gZ2lhIHLDoCBzb8OhdCIsaGludDoiRXhwZXJ0IHZhbGlkYXRpb24uIn0sCiAge2lkOiJyZXBvcnQiLHRpdGxlOiJCw6FvIGPDoW8iLGhpbnQ6IlThu5VuZyBo4bujcCBr4bq/dCBxdeG6oy4ifQpdOwpjb25zdCBzdGF0ZT17c3RlcDowLHBkZjpudWxsLHBhZ2VUZXh0OltdLHBhZ2VDb2x1bW5UZXh0OltdLHBhZ2VRdWFsaXR5OltdLGJhZFRleHRQYWdlczpbXSxvY3JQYWdlczp7fSxyYXdUZXh0OiIiLGNsYWltc1RleHQ6IiIsY2xhaW1zOltdLHNlbGVjdGVkOjAsZmVhdHVyZXM6W10sY29uZmlybWVkOmZhbHNlLHNlYXJjaDpbXSxxdWVyaWVzOltdLHByaW9yOnt9LG1hdHJpeDpbXSxhc3Nlc3NtZW50Ont9LHJldmlld3M6MCxjYW5kaWRhdGVzOltdLGJhY2tlbmRVcmw6IiIscHJvdmlkZXJzOnt9LGNsb3VkT2NyOm51bGwsdGVzc0RpYWc6e3ZpZTpmYWxzZSxlbmc6ZmFsc2UsZXJyb3I6IiJ9LGNsYWltU291cmNlQnlQYWdlOnt9LGRvY0xhbmc6InVua25vd24iLGRvY0xhbmdDb25maWRlbmNlOjAsbGFuZ3VhZ2VCeVBhZ2U6e30sdmlzaW9uTGFuZ3VhZ2VzQnlQYWdlOnt9fTsKY29uc3QgJD1pZD0+ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwpjb25zdCBlc2M9cz0+KHN8fCIiKS5yZXBsYWNlKC9bJjw+IiddL2csbT0+KHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsJyInOiImcXVvdDsiLCInIjoiJiMwMzk7In1bbV0pKTsKY29uc3QgY2xlYW49cz0+KHN8fCIiKS5yZXBsYWNlKC9cdTAwYWQvZywiIikucmVwbGFjZSgvWyBcdF0rL2csIiAiKS5yZXBsYWNlKC9cblsgXHRdKy9nLCJcbiIpLnRyaW0oKTsKZnVuY3Rpb24gZm9sZFZOKHMpewogIHJldHVybiAoc3x8IiIpCiAgICAubm9ybWFsaXplKCJORkQiKQogICAgLnJlcGxhY2UoL1tcdTAzMDAtXHUwMzZmXS9nLCIiKQogICAgLnJlcGxhY2UoL8SRL2csImQiKS5yZXBsYWNlKC/EkC9nLCJEIikKICAgIC50b1VwcGVyQ2FzZSgpOwp9Cgpjb25zdCBWSV9ISU5UX1dPUkRTPVsKICAic8OhbmcgY2jhur8iLCJ5w6p1IGPhuqd1IGLhuqNvIGjhu5kiLCJxdXkgdHLDrG5oIiwicGjGsMahbmcgcGjDoXAiLCJiYW8gZ+G7k20iLCJ0cm9uZyDEkcOzIiwidGluaCBk4bqndSIsImR1bmcgZOG7i2NoIiwKICAiaOG7l24gaOG7o3AiLCLEkeG7k25nIG5o4bqldCIsInRoaeG6v3QgYuG7iyIsImtodeG6pXkiLCJ0aOG7nWkgZ2lhbiIsInRodSDEkcaw4bujYyIsImNo4bq/IHBo4bqpbSIsImLGsOG7m2MiLCJwaOG7kWkgdHLhu5luIiwi4buVbiDEkeG7i25oIiwKICAic+G6o24geHXhuqV0IiwidGjDoG5oIHBo4bqnbiIsIm7hu5NuZyDEkeG7mSIsIm5oaeG7h3QgxJHhu5kiLCLEkeG7mSDhuqltIiwibmfGsOG7nWkgbuG7mXAgxJHGoW4iLCLEkeG6oWkgZGnhu4duIiwibmfDoHkgbuG7mXAgxJHGoW4iCl07CmNvbnN0IEVOX0hJTlRfV09SRFM9WwogICJwYXRlbnQiLCJjbGFpbXMiLCJjbGFpbSIsIm1ldGhvZCIsInByb2Nlc3MiLCJjb21wcmlzaW5nIiwid2hlcmVpbiIsIm1peHR1cmUiLCJzb2x1dGlvbiIsImRldmljZSIsInN5c3RlbSIsCiAgImNvbXBvc2l0aW9uIiwic3RlcCIsInRlbXBlcmF0dXJlIiwidGltZSIsIm9idGFpbmVkIiwiYXBwYXJhdHVzIiwiaW52ZW50aW9uIiwiYXBwbGljYW50IiwiYXNzaWduZWUiLCJmaWxlZCIKXTsKCmZ1bmN0aW9uIGRldGVjdFRleHRMYW5ndWFnZSh0ZXh0KXsKICBjb25zdCB0PW5vcm1hbGl6ZU9jclRleHQodGV4dHx8IiIpOwogIGlmKCF0LnRyaW0oKSkgcmV0dXJuIHtsYW5nOiJ1bmtub3duIixjb25maWRlbmNlOjAsdmk6MCxlbjowfTsKCiAgY29uc3QgbG93PXQudG9Mb3dlckNhc2UoKTsKICBjb25zdCBjaGFycz1NYXRoLm1heCgxLHQubGVuZ3RoKTsKICBjb25zdCB2aVNwZWNpZmljPSh0Lm1hdGNoKC9bxIPDosSRw6rDtMahxrDEgsOCxJDDisOUxqDGr8Ogw6HhuqPDo+G6oeG6seG6r+G6s+G6teG6t+G6p+G6peG6qeG6q+G6rcOow6nhurvhur3hurnhu4Hhur/hu4Phu4Xhu4fDrMOt4buJxKnhu4vDssOz4buPw7Xhu43hu5Phu5Hhu5Xhu5fhu5nhu53hu5vhu5/hu6Hhu6PDucO64bunxanhu6Xhu6vhu6nhu63hu6/hu7Hhu7PDveG7t+G7ueG7tV0vZyl8fFtdKS5sZW5ndGg7CgogIGxldCB2aT12aVNwZWNpZmljKjIuNDsKICBsZXQgZW49MDsKICBmb3IoY29uc3QgdyBvZiBWSV9ISU5UX1dPUkRTKSBpZihsb3cuaW5jbHVkZXModykpIHZpKz03OwogIGZvcihjb25zdCB3IG9mIEVOX0hJTlRfV09SRFMpIGlmKG5ldyBSZWdFeHAoYFxcYiR7dy5yZXBsYWNlKC9bLiorP14ke30oKXxbXF1cXF0vZywiXFwkJiIpfVxcYmAsImkiKS50ZXN0KHQpKSBlbis9NTsKCiAgLy8gVmlldG5hbWVzZSBMYXRpbiB0ZXh0IHR5cGljYWxseSBoYXMgYSBtZWFuaW5nZnVsIGRlbnNpdHkgb2YgZGlhY3JpdGljcy4KICB2aSs9TWF0aC5taW4oMzAsKHZpU3BlY2lmaWMvY2hhcnMpKjUwMCk7CgogIGNvbnN0IHdvcmRzPXQuc3BsaXQoL1xzKy8pLmZpbHRlcihCb29sZWFuKTsKICBjb25zdCBhc2NpaVdvcmRzPXdvcmRzLmZpbHRlcih3PT4vXltBLVphLXpdW0EtWmEtelwtXSokLy50ZXN0KHcpKS5sZW5ndGg7CiAgaWYod29yZHMubGVuZ3RoPjgpIGVuKz1NYXRoLm1pbigyMCwoYXNjaWlXb3Jkcy93b3Jkcy5sZW5ndGgpKjE4KTsKCiAgY29uc3QgdG90YWw9dmkrZW47CiAgaWYodG90YWw8OCkgcmV0dXJuIHtsYW5nOiJ1bmtub3duIixjb25maWRlbmNlOjAuMix2aSxlbn07CgogIGlmKHZpPj1lbioxLjM1KSByZXR1cm4ge2xhbmc6InZpIixjb25maWRlbmNlOk1hdGgubWluKC45OSx2aS9NYXRoLm1heCgxLHRvdGFsKSksdmksZW59OwogIGlmKGVuPj12aSoxLjM1KSByZXR1cm4ge2xhbmc6ImVuIixjb25maWRlbmNlOk1hdGgubWluKC45OSxlbi9NYXRoLm1heCgxLHRvdGFsKSksdmksZW59OwogIHJldHVybiB7bGFuZzoibWl4ZWQiLGNvbmZpZGVuY2U6LjU1LHZpLGVufTsKfQoKZnVuY3Rpb24gY2hvb3NlRG9jdW1lbnRMYW5ndWFnZSgpewogIGxldCB2aT0wLGVuPTAsbWl4ZWQ9MCx3ZWlnaHQ9MDsKICBmb3IobGV0IGk9MDtpPHN0YXRlLnBhZ2VUZXh0Lmxlbmd0aDtpKyspewogICAgY29uc3QgcT1zdGF0ZS5wYWdlUXVhbGl0eVtpXXx8MDsKICAgIGlmKHE8NDUpIGNvbnRpbnVlOwogICAgY29uc3QgZD1kZXRlY3RUZXh0TGFuZ3VhZ2Uoc3RhdGUucGFnZVRleHRbaV0pOwogICAgY29uc3Qgdz1NYXRoLm1heCguMyxxLzEwMCk7CiAgICBpZihkLmxhbmc9PT0idmkiKSB2aSs9ZC5jb25maWRlbmNlKnc7CiAgICBlbHNlIGlmKGQubGFuZz09PSJlbiIpIGVuKz1kLmNvbmZpZGVuY2UqdzsKICAgIGVsc2UgaWYoZC5sYW5nPT09Im1peGVkIikgbWl4ZWQrPWQuY29uZmlkZW5jZSp3OwogICAgd2VpZ2h0Kz13OwogICAgc3RhdGUubGFuZ3VhZ2VCeVBhZ2VbaSsxXT1kOwogIH0KICBpZih2aT5lbioxLjM1ICYmIHZpPm1peGVkKi44KXsKICAgIHN0YXRlLmRvY0xhbmc9InZpIjsgc3RhdGUuZG9jTGFuZ0NvbmZpZGVuY2U9TWF0aC5taW4oLjk5LHZpL01hdGgubWF4KDEsdmkrZW4rbWl4ZWQpKTsKICB9ZWxzZSBpZihlbj52aSoxLjM1ICYmIGVuPm1peGVkKi44KXsKICAgIHN0YXRlLmRvY0xhbmc9ImVuIjsgc3RhdGUuZG9jTGFuZ0NvbmZpZGVuY2U9TWF0aC5taW4oLjk5LGVuL01hdGgubWF4KDEsdmkrZW4rbWl4ZWQpKTsKICB9ZWxzZSBpZih2aStlbittaXhlZD4wKXsKICAgIHN0YXRlLmRvY0xhbmc9Im1peGVkIjsgc3RhdGUuZG9jTGFuZ0NvbmZpZGVuY2U9LjU1OwogIH1lbHNlewogICAgc3RhdGUuZG9jTGFuZz0idW5rbm93biI7IHN0YXRlLmRvY0xhbmdDb25maWRlbmNlPTA7CiAgfQogIHJldHVybiB7bGFuZzpzdGF0ZS5kb2NMYW5nLGNvbmZpZGVuY2U6c3RhdGUuZG9jTGFuZ0NvbmZpZGVuY2V9Owp9CgpmdW5jdGlvbiBsYW5ndWFnZUxhYmVsKGxhbmcpewogIHJldHVybiBsYW5nPT09InZpIj8iVGnhur9uZyBWaeG7h3QiOmxhbmc9PT0iZW4iPyJFbmdsaXNoIjpsYW5nPT09Im1peGVkIj8iVmnhu4d0ICsgQW5oIjoiQ2jGsGEgeMOhYyDEkeG7i25oIjsKfQoKZnVuY3Rpb24gbGFuZ3VhZ2VGaXRTY29yZSh0ZXh0LHRhcmdldCl7CiAgY29uc3QgZD1kZXRlY3RUZXh0TGFuZ3VhZ2UodGV4dCk7CiAgaWYodGFyZ2V0PT09InZpIil7CiAgICBpZihkLmxhbmc9PT0idmkiKSByZXR1cm4gMjgqZC5jb25maWRlbmNlOwogICAgaWYoZC5sYW5nPT09Im1peGVkIikgcmV0dXJuIDEwOwogICAgaWYoZC5sYW5nPT09ImVuIikgcmV0dXJuIC0yMDsKICB9CiAgaWYodGFyZ2V0PT09ImVuIil7CiAgICBpZihkLmxhbmc9PT0iZW4iKSByZXR1cm4gMjUqZC5jb25maWRlbmNlOwogICAgaWYoZC5sYW5nPT09Im1peGVkIikgcmV0dXJuIDg7CiAgICBpZihkLmxhbmc9PT0idmkiKSByZXR1cm4gLTE4OwogIH0KICBpZih0YXJnZXQ9PT0ibWl4ZWQiKSByZXR1cm4gZC5sYW5nPT09Im1peGVkIj8xNjo1OwogIHJldHVybiAwOwp9CgpmdW5jdGlvbiBjbGFpbU1hcmtlckluZm8odGV4dCl7CiAgY29uc3QgZj1mb2xkVk4odGV4dCk7CiAgY29uc3QgcGF0dGVybnM9WwogICAgL1lFVVxzKkNBVVxzKkJBT1xzKkhPLywKICAgIC9OSFVOR1xzKkRJRVVccypZRVVccypDQVVccypCQU9ccypITy8sCiAgICAvV0hBVFxzK0lTXHMrQ0xBSU1FRFxzK0lTXHMqOiovLAogICAgL0lccypcLz9ccypXRVxzK0NMQUlNXHMqOiovLAogICAgL1xiQ0xBSU1TP1xzKjoqLwogIF07CiAgZm9yKGNvbnN0IHJlIG9mIHBhdHRlcm5zKXsKICAgIGNvbnN0IG09Zi5tYXRjaChyZSk7CiAgICBpZihtKSByZXR1cm4ge2luZGV4Om0uaW5kZXgsZW5kOm0uaW5kZXgrbVswXS5sZW5ndGh9OwogIH0KICByZXR1cm4gbnVsbDsKfQpmdW5jdGlvbiBsb29rc0xpa2VDbGFpbVBhZ2UodGV4dCl7CiAgY29uc3QgZj1mb2xkVk4odGV4dCk7CiAgcmV0dXJuIC8oPzpefFxufFxzKTFccypbXC5cKV1ccyooUVVZIFRSSU5IfFBIVU9ORyBQSEFQfFNBTiBQSEFNfFRISUVUIEJJfEhFIFRIT05HfENIRSBQSEFNfEFcc3xBTlxzfFRIRVxzKS8udGVzdChmKQogICAgJiYgLyhCQU8gR09NfENPTVBSSVNJTkd8Q09NUFJJU0VTfEdPTSBDQUMgQlVPQ3xJTkNMVURJTkcpLy50ZXN0KGYpOwp9CmZ1bmN0aW9uIGV4dHJhY3RDbGFpbXNUYWlsKHRleHQpewogIGlmKCF0ZXh0KSByZXR1cm4gIiI7CiAgY29uc3QgbWFyaz1jbGFpbU1hcmtlckluZm8odGV4dCk7CiAgaWYobWFyaykgcmV0dXJuIHRydW5jYXRlQ2xhaW1BdEZpZ3VyZShjbGVhbih0ZXh0LnNsaWNlKG1hcmsuZW5kKSkpLnNsaWNlKDAsODAwMDApOwogIGNvbnN0IGY9Zm9sZFZOKHRleHQpOwogIGNvbnN0IHJlPS8oPzpefFxufFxzKTFccypbXC5cKV1ccyooUVVZIFRSSU5IfFBIVU9ORyBQSEFQfFNBTiBQSEFNfFRISUVUIEJJfEhFIFRIT05HfENIRSBQSEFNfEFcc3xBTlxzfFRIRVxzKS87CiAgY29uc3QgbW09Zi5tYXRjaChyZSk7CiAgcmV0dXJuIG1tID8gdHJ1bmNhdGVDbGFpbUF0RmlndXJlKGNsZWFuKHRleHQuc2xpY2UobW0uaW5kZXgpKSkuc2xpY2UoMCw4MDAwMCkgOiAiIjsKfQpmdW5jdGlvbiBub3JtYWxpemVPY3JUZXh0KHMpewogIC8vIHYxMDoga2jDtG5nIHThu7EgbuG7kWkgZMOybmcgdMO5eSB0aeG7h24gbuG7r2EuIENo4buJIGNodeG6qW4gaMOzYSBVbmljb2RlL2tob+G6o25nIHRy4bqvbmcuCiAgLy8gxJBp4buBdSBuw6B5IHRyw6FuaCBiaeG6v24gdsSDbiBi4bqjbiBWaeG7h3QgxJHDum5nIHRow6BuaCBjaHXhu5dpIGTDrW5oIG5oxrAgIk7huqJZTeG6pk0iIGhv4bq3YyBrw6lvIGZvb3RlciB2w6BvIHRpdGxlLgogIHJldHVybiBTdHJpbmcoc3x8IiIpCiAgICAucmVwbGFjZSgvXHVGRUZGL2csIiIpCiAgICAucmVwbGFjZSgvXHUwMGFkL2csIiIpCiAgICAucmVwbGFjZSgvW1x1MjAwQi1cdTIwMERcdTIwNjBdL2csIiIpCiAgICAubm9ybWFsaXplKCJORkMiKQogICAgLnJlcGxhY2UoL1vigJzigJ1dL2csJyInKS5yZXBsYWNlKC9b4oCY4oCZXS9nLCInIikKICAgIC5yZXBsYWNlKC9b4oCQ4oCR4oCS4oCT4oCUXS9nLCItIikKICAgIC5yZXBsYWNlKC9cdTAwYTAvZywiICIpCiAgICAucmVwbGFjZSgvWyBcdF0rL2csIiAiKQogICAgLnJlcGxhY2UoL1sgXHRdK1xuL2csIlxuIikKICAgIC5yZXBsYWNlKC9cblsgXHRdKy9nLCJcbiIpCiAgICAucmVwbGFjZSgvXHMrKFssLjs6JVwpXSkvZywiJDEiKQogICAgLnJlcGxhY2UoLyhcKClccysvZywiJDEiKQogICAgLnJlcGxhY2UoLyhcZClccyosXHMqKFxkKS9nLCIkMSwkMiIpCiAgICAucmVwbGFjZSgvXG57Myx9L2csIlxuXG4iKQogICAgLnRyaW0oKTsKfQoKZnVuY3Rpb24gc3RyaXBQZGZBcnRpZmFjdHMocyl7CiAgbGV0IHQ9bm9ybWFsaXplT2NyVGV4dChzKTsKCiAgLy8gUGFnZSBjb3VudGVycyAvIGZvb3RlciBhcnRpZmFjdHMgY29tbW9ubHkgZW1pdHRlZCBieSBWaWV0bmFtZXNlIHBhdGVudCBQREZzLgogIHQ9dC5yZXBsYWNlKC8oPzpcYlxkezMsMTB9XHMrXGR7MSwzfVxzKlwvXHMqXGR7MSwzfVxiW1xzLDs6XSopezIsfS9nLCIgIik7CiAgdD10LnJlcGxhY2UoL1xiXGR7MywxMH1ccytcZHsxLDN9XHMqXC9ccypcZHsxLDN9XGIvZywiICIpOwogIHQ9dC5yZXBsYWNlKC8oPzpcYlxkezEsM31ccypcL1xzKlxkezMsMTB9XGJbXHMsOzpdKil7Mix9L2csIiAiKTsKICB0PXQucmVwbGFjZSgvXlxzKlxkezEsM31ccypcL1xzKlxkezEsM31ccyokL2dtLCIiKTsKICB0PXQucmVwbGFjZSgvXlxzKig/OlBhZ2V8VHJhbmcpXHMrXGQrKD86XHMqXC9ccypcZCspP1xzKiQvZ21pLCIiKTsKCiAgLy8gQ29sbGFwc2Ugb25seSBob3Jpem9udGFsIG5vaXNlOyBrZWVwIHNlbWFudGljIGxpbmUgYnJlYWtzLgogIHJldHVybiB0LnJlcGxhY2UoL1sgXHRdezIsfS9nLCIgIikucmVwbGFjZSgvXG57Myx9L2csIlxuXG4iKS50cmltKCk7Cn0KCmZ1bmN0aW9uIHRleHRMYXllclF1YWxpdHlTY29yZSh0ZXh0KXsKICBjb25zdCB0PXN0cmlwUGRmQXJ0aWZhY3RzKHRleHQpOyBpZihsb29rc0xpa2VMZWdhY3lFbmNvZGluZyh0KSkgcmV0dXJuIDU7CiAgaWYoIXQpIHJldHVybiAwOwoKICBjb25zdCBjaGFycz10Lmxlbmd0aDsKICBjb25zdCBsZXR0ZXJzPSh0Lm1hdGNoKC9ccHtMfS9ndSl8fFtdKS5sZW5ndGg7CiAgY29uc3QgZGlnaXRzPSh0Lm1hdGNoKC9cZC9nKXx8W10pLmxlbmd0aDsKICBjb25zdCB3ZWlyZD0odC5tYXRjaCgvW++/veKWoeKWoHt9PD58fl5gXS9nKXx8W10pLmxlbmd0aDsKICBjb25zdCBzbGFzaFNlcT0odC5tYXRjaCgvXGQrXHMqXC9ccypcZCsvZyl8fFtdKS5sZW5ndGg7CiAgY29uc3Qgd29yZHM9dC5zcGxpdCgvXHMrLykuZmlsdGVyKEJvb2xlYW4pOwogIGNvbnN0IHNob3J0V29yZHM9d29yZHMuZmlsdGVyKHc9PncubGVuZ3RoPD0xKS5sZW5ndGg7CgogIGxldCBzY29yZT0wOwogIHNjb3JlKz1NYXRoLm1pbig0MCwgY2hhcnMvMzUpOwogIHNjb3JlKz1NYXRoLm1pbigyNSwgKGxldHRlcnMvTWF0aC5tYXgoMSxjaGFycykpKjQ1KTsKICBpZigvW8SDw6LEkcOqw7TGocawxILDgsSQw4rDlMagxq9dLy50ZXN0KHQpKSBzY29yZSs9ODsKICBpZigvW8Ogw6HhuqPDo+G6oeG6seG6r+G6s+G6teG6t+G6p+G6peG6qeG6q+G6rcOow6nhurvhur3hurnhu4Hhur/hu4Phu4Xhu4fDrMOt4buJxKnhu4vDssOz4buPw7Xhu43hu5Phu5Hhu5Xhu5fhu5nhu53hu5vhu5/hu6Hhu6PDucO64bunxanhu6Xhu6vhu6nhu63hu6/hu7Hhu7PDveG7t+G7ueG7tV0vaS50ZXN0KHQpKSBzY29yZSs9ODsKICBpZigvXGIoPzpzw6FuZyBjaOG6v3x5w6p1IGPhuqd1IGLhuqNvIGjhu5l8cXV5IHRyw6xuaHxwaMawxqFuZyBwaMOhcHxiYW8gZ+G7k218dHJvbmcgxJHDs3x0aGnhur90IGLhu4t8aOG7hyB0aOG7kW5nKVxiL2kudGVzdCh0KSkgc2NvcmUrPTEyOwoKICBzY29yZS09TWF0aC5taW4oMzUsd2VpcmQqNSk7CiAgc2NvcmUtPU1hdGgubWluKDMwLHNsYXNoU2VxKjUpOwogIGlmKGRpZ2l0cy9NYXRoLm1heCgxLGNoYXJzKT4uMjgpIHNjb3JlLT0xODsKICBpZihzaG9ydFdvcmRzL01hdGgubWF4KDEsd29yZHMubGVuZ3RoKT4uMjUpIHNjb3JlLT0xNTsKCiAgcmV0dXJuIE1hdGgubWF4KDAsTWF0aC5taW4oMTAwLE1hdGgucm91bmQoc2NvcmUpKSk7Cn0KCgpmdW5jdGlvbiByZXBhaXJDZXJ0YWluVm5PY3IodGV4dCl7CiAgLy8gQ2jhu4kgc+G7rWEgbOG7l2kgT0NSIHLhuqV0IMSRaeG7g24gaMOsbmggdGhlbyBuZ+G7ryBj4bqjbmgga+G7uSB0aHXhuq10LCBraMO0bmcgc8OhbmcgdMOhYyBjbGFpbS4KICByZXR1cm4gbm9ybWFsaXplT2NyVGV4dCh0ZXh0fHwiIikKICAgIC5yZXBsYWNlKC9cYig/OnThu4luaHx0w61uaHx0w6xuaClccytk4bqndVxiL2dpLCJ0aW5oIGThuqd1IikKICAgIC5yZXBsYWNlKC9cYmR1bmdccyvEkeG7i2NoXGIvZ2ksImR1bmcgZOG7i2NoIikKICAgIC5yZXBsYWNlKC9cYmgoPzrhu5NufMO0bilccyto4bujcFxiL2dpLCJo4buXbiBo4bujcCIpCiAgICAucmVwbGFjZSgvXGJu4bqjW3nDvV0/XHMqbeG6p21cYi9naSwibuG6o3kgbeG6p20iKQogICAgLnJlcGxhY2UoL1xia2h1ZFt5w71dXGIvZ2ksImtodeG6pXkiKQogICAgLnJlcGxhY2UoL1xia2h1W+G6qeG6o2FdeVxzK2IoPzrEg3xhfGkpbmdccyt04burXGIvZ2ksImtodeG6pXkgYuG6sW5nIHThu6siKQogICAgLnJlcGxhY2UoL1xia2h1W+G6qeG6o2FdeVxzK2Jpbmdccyt04burXGIvZ2ksImtodeG6pXkgYuG6sW5nIHThu6siKQogICAgLnJlcGxhY2UoL1xidGluaCBk4bqndVxzK3NhXHMramF2YVxiL2dpLCJ0aW5oIGThuqd1IHPhuqMgamF2YSIpCiAgICAucmVwbGFjZSgvXGJ0aW5oIGThuqd1XHMrb2FpXHMraMawxqFuZ1xiL2dpLCJ0aW5oIGThuqd1IG/huqNpIGjGsMahbmciKQogICAgLnJlcGxhY2UoL1xia+G6v3RccytxdWFcYi9naSwia+G6v3QgcXXhuqMiKQogICAgLnJlcGxhY2UoL1xiaG9uXHMraOG7o3BcYi9naSwiaOG7l24gaOG7o3AiKQogICAgLm5vcm1hbGl6ZSgiTkZDIik7Cn0KCmZ1bmN0aW9uIHRyaW1EaWFncmFtTm9pc2UodGV4dCl7CiAgY29uc3QgbGluZXM9bm9ybWFsaXplT2NyVGV4dCh0ZXh0fHwiIikuc3BsaXQoL1xuKy8pLm1hcCh4PT54LnRyaW0oKSkuZmlsdGVyKEJvb2xlYW4pOwogIGlmKGxpbmVzLmxlbmd0aDw4KSByZXR1cm4gbGluZXMuam9pbigiXG4iKTsKCiAgbGV0IGN1dD1saW5lcy5sZW5ndGg7CiAgbGV0IHNlZW5DbGFpbVNlbnRlbmNlPWZhbHNlOwoKICBmb3IobGV0IGk9MDtpPGxpbmVzLmxlbmd0aDtpKyspewogICAgY29uc3QgbGluZT1saW5lc1tpXTsKICAgIGlmKC9bLjtdJC8udGVzdChsaW5lKSAmJiAvKD86dGh1IMSRxrDhu6NjfG9idGFpbmVkfGNvbXByaXNpbmd8d2hlcmVpbnxiYW8gZ+G7k218dHJvbmcgxJHDsykvaS50ZXN0KGxpbmVzLnNsaWNlKE1hdGgubWF4KDAsaS00KSxpKzEpLmpvaW4oIiAiKSkpewogICAgICBzZWVuQ2xhaW1TZW50ZW5jZT10cnVlOwogICAgfQogICAgaWYoIXNlZW5DbGFpbVNlbnRlbmNlKSBjb250aW51ZTsKCiAgICBjb25zdCB3aW5kb3c9bGluZXMuc2xpY2UoaSxNYXRoLm1pbihsaW5lcy5sZW5ndGgsaSs3KSk7CiAgICBpZih3aW5kb3cubGVuZ3RoPDQpIGNvbnRpbnVlOwoKICAgIGxldCBub2lzeT0wOwogICAgZm9yKGNvbnN0IHcgb2Ygd2luZG93KXsKICAgICAgaWYody5sZW5ndGg8MjgpIG5vaXN5Kys7CiAgICAgIGlmKC9eXGR7Miw0fVtBLVphLXpdPyQvLnRlc3QodykpIG5vaXN5Kys7CiAgICAgIGlmKCh3Lm1hdGNoKC9bfFxcL18+PH5dL2cpfHxbXSkubGVuZ3RoPj0xKSBub2lzeSsrOwogICAgfQogICAgaWYobm9pc3k+PTYpewogICAgICBjdXQ9aTsKICAgICAgYnJlYWs7CiAgICB9CiAgfQogIHJldHVybiBsaW5lcy5zbGljZSgwLGN1dCkuam9pbigiXG4iKTsKfQoKZnVuY3Rpb24gdHJ1bmNhdGVDbGFpbUF0RmlndXJlKHRleHQpewogIGxldCB0PXN0cmlwUGRmQXJ0aWZhY3RzKHJlcGFpckNlcnRhaW5Wbk9jcih0ZXh0fHwiIikpOwoKICAvLyBGbGV4aWJsZSBmaWd1cmUgbWFya2VycywgaW5jbHVkaW5nIE9DUiBmb3JtcyBzdWNoIGFzICJIw4xOXG5IMSIgb3IgIkggSSBOIEggMSIuCiAgY29uc3Qgc3RvcHM9WwogICAgLyg/Ol58XG4pXHMqSFxzKlvDjEnDjeG7iMSo4buKXT9ccypOXHMqSFxzKltcczouXy1dKlxkK1xiL2ltLAogICAgLyg/Ol58XG4pXHMqSMOMTlxzKkhccypcZCtcYi9pbSwKICAgIC8oPzpefFxuKVxzKkhJTlxzKkhccypcZCtcYi9pbSwKICAgIC8oPzpefFxuKVxzKkjDjE5IXHMqXGQrXGIvaW0sCiAgICAvKD86XnxcbilccypISU5IXHMqXGQrXGIvaW0sCiAgICAvKD86XnxcbilccypGSUcoPzpVUkUpP1wuP1xzKlxkK1xiL2ltLAogICAgLyg/Ol58XG4pXHMqKD86TcOUIFThuqIgSMOMTkggVuG6vHxC4bqiTiBW4bq8fERSQVdJTkdTPylcYi9pbQogIF07CgogIGxldCBjdXQ9dC5sZW5ndGg7CiAgZm9yKGNvbnN0IHJlIG9mIHN0b3BzKXsKICAgIGNvbnN0IG1tPXQubWF0Y2gocmUpOwogICAgaWYobW0gJiYgbW0uaW5kZXg+ODApIGN1dD1NYXRoLm1pbihjdXQsbW0uaW5kZXgpOwogIH0KICB0PXQuc2xpY2UoMCxjdXQpOwoKICAvLyBTZWNvbmRhcnkgZGVmZW5zZSB3aGVuIE9DUiBtaXNzZXMgdGhlIGZpZ3VyZSBoZWFkaW5nIGVudGlyZWx5LgogIHQ9dHJpbURpYWdyYW1Ob2lzZSh0KTsKCiAgdD10LnJlcGxhY2UoL1xuXHMqXGR7Miw4fVxzK1xkezEsM31ccypcL1xzKlxkezEsM31ccyokL2csIiIpOwogIHQ9dC5yZXBsYWNlKC9cblxzKlxkezEsNH1ccyokL2csIiIpOwogIHJldHVybiB0LnRyaW0oKS5ub3JtYWxpemUoIk5GQyIpOwp9CgpmdW5jdGlvbiBsb29rc0xpa2VMZWdhY3lFbmNvZGluZyh0ZXh0KXsKICBjb25zdCB0PVN0cmluZyh0ZXh0fHwiIik7CiAgcmV0dXJuIC8oPzrDsWHDqm5nfGt5w7l8w7FpZcOgdXxwaMO2w7RuZ3x0csOsbmh8dmHDqm58aMO2w7TDuW5nfMOxw7bDtMOvY3xiYcOobmd8Y2HDuWNofHNhw7tufHh1YcOhdCkvaS50ZXN0KHQpCiAgICB8fCAodC5tYXRjaCgvW++/veKWoeKWoF0vZyl8fFtdKS5sZW5ndGg+PTI7Cn0KCmZ1bmN0aW9uIHZuT2NyUXVhbGl0eSh0ZXh0KXsKICBjb25zdCB0PXRydW5jYXRlQ2xhaW1BdEZpZ3VyZSh0ZXh0fHwiIik7CiAgaWYoIXQpIHJldHVybiAwOwogIGxldCBzY29yZT10ZXh0TGF5ZXJRdWFsaXR5U2NvcmUodCk7CgogIGNvbnN0IGY9Zm9sZFZOKHQpLnRvTG93ZXJDYXNlKCk7CiAgY29uc3QgcGF0ZW50V29yZHM9WwogICAgInF1eSB0cmluaCIsInBodW9uZyBwaGFwIiwieWV1IGNhdSBiYW8gaG8iLCJiYW8gZ29tIiwidHJvbmcgZG8iLAogICAgInRpbmggZGF1IiwiZHVuZyBkaWNoIiwiaG9uIGhvcCIsImRvbmcgbmhhdCIsInRoaWV0IGJpIiwia2h1YXkiCiAgXTsKICBmb3IoY29uc3QgdyBvZiBwYXRlbnRXb3JkcykgaWYoZi5pbmNsdWRlcyh3KSkgc2NvcmUrPTU7CgogIHNjb3JlLT1NYXRoLm1pbigzMCwodC5tYXRjaCgvXGIoPzp04buJbmggZOG6p3V8dMOtbmggZOG6p3V8ZHVuZyDEkeG7i2NofGjhu5NuIGjhu6NwKVxiL2dpKXx8W10pLmxlbmd0aCo2KTsKICBzY29yZS09TWF0aC5taW4oMzAsKHQubWF0Y2goL1xkK1xzKlwvXHMqXGQrL2cpfHxbXSkubGVuZ3RoKjUpOwogIGlmKC8oPzpefFxuKVxzKig/OkjDjE5IfEhJTkh8RklHVVJFfEZJR1wuKVxzKlxkKy9pbS50ZXN0KHQpKSBzY29yZS09NDU7CiAgaWYobG9va3NMaWtlTGVnYWN5RW5jb2RpbmcodCkpIHNjb3JlLT0zNTsKCiAgcmV0dXJuIE1hdGgubWF4KDAsTWF0aC5taW4oMTAwLE1hdGgucm91bmQoc2NvcmUpKSk7Cn0KCmZ1bmN0aW9uIHJlbmRlclRlc3NEaWFnKCl7CiAgY29uc3QgZWw9JCgidGVzc0RpYWciKTsKICBpZighZWwpIHJldHVybjsKICBjb25zdCBkPXN0YXRlLnRlc3NEaWFnfHx7fTsKICBjb25zdCBsYW5nPWBOZ8O0biBuZ+G7ryB0w6BpIGxp4buHdTogPHN0cm9uZz4ke2xhbmd1YWdlTGFiZWwoc3RhdGUuZG9jTGFuZyl9PC9zdHJvbmc+JHtzdGF0ZS5kb2NMYW5nQ29uZmlkZW5jZT9gICgke01hdGgucm91bmQoc3RhdGUuZG9jTGFuZ0NvbmZpZGVuY2UqMTAwKX0lKWA6IiJ9YDsKCiAgaWYoZC5lcnJvcil7CiAgICBlbC5pbm5lckhUTUw9YCR7bGFuZ308YnI+PHNwYW4gY2xhc3M9ImJhY2tlbmQtYmFkIj5PQ1IgbGFuZ3VhZ2UgcGFjayBs4buXaTo8L3NwYW4+ICR7ZXNjKGQuZXJyb3IpfWA7CiAgICByZXR1cm47CiAgfQogIGNvbnN0IHZpZT1kLnZpZT8i4pyTIHZpZS50cmFpbmVkZGF0YSI6IuKApiB2aWUudHJhaW5lZGRhdGEiOwogIGNvbnN0IGVuZz1kLmVuZz8i4pyTIGVuZy50cmFpbmVkZGF0YSI6IuKApiBlbmcudHJhaW5lZGRhdGEiOwogIGVsLmlubmVySFRNTD1gJHtsYW5nfTxicj5UZXNzZXJhY3QuanMgNS4xLjEgwrcgYWRhcHRpdmUgbGFuZ3VhZ2UgbW9kZSDCtyAke3ZpZX0gwrcgJHtlbmd9IMK3IFVuaWNvZGUgTkZDYDsKfQoKZnVuY3Rpb24gY2xlYW5NZXRhVmFsdWUocyl7CiAgbGV0IHQ9c3RyaXBQZGZBcnRpZmFjdHMocykKICAgIC5yZXBsYWNlKC9eXHMqW1woXFtdP1xkezJ9W1wpXF1dP1xzKi8sIiIpCiAgICAucmVwbGFjZSgvXHMrL2csIiAiKQogICAgLnRyaW0oKTsKICByZXR1cm4gdDsKfQoKZnVuY3Rpb24gc2FuaXRpemVQYXRlbnRUaXRsZShzKXsKICBsZXQgdD1jbGVhbk1ldGFWYWx1ZShzKQogICAgLnJlcGxhY2UoL1xiKD86UGFnZXxUcmFuZylccytcZCsoPzpcL1xkKyk/XGIvZ2ksIiIpCiAgICAucmVwbGFjZSgvKD86XGJcZHszLDEwfVxzK1xkezEsM31cL1xkezEsM31cYlxzKikrL2csIiIpCiAgICAucmVwbGFjZSgvXHMrL2csIiAiKQogICAgLnRyaW0oKTsKCiAgLy8gUmVqZWN0IG9idmlvdXNseSBwb2xsdXRlZCB0aXRsZXMgcmF0aGVyIHRoYW4gcG9pc29uaW5nIHNlYXJjaC4KICBjb25zdCBzbGFzaD0odC5tYXRjaCgvXGQrXHMqXC9ccypcZCsvZyl8fFtdKS5sZW5ndGg7CiAgY29uc3QgZGlnaXRSYXRpbz0odC5tYXRjaCgvXGQvZyl8fFtdKS5sZW5ndGgvTWF0aC5tYXgoMSx0Lmxlbmd0aCk7CiAgaWYoc2xhc2g+PTIgfHwgZGlnaXRSYXRpbz4uMzApIHJldHVybiAiIjsKICByZXR1cm4gdC5zbGljZSgwLDI2MCk7Cn0KCmZ1bmN0aW9uIGNhbnZhc1RvQmFzZTY0SnBlZyhjYW52YXMscXVhbGl0eT0uOSl7CiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLHJlamVjdCk9PnsKICAgIGNhbnZhcy50b0Jsb2IoYXN5bmMgYmxvYj0+ewogICAgICBpZighYmxvYikgcmV0dXJuIHJlamVjdChuZXcgRXJyb3IoIktow7RuZyB04bqhbyDEkcaw4bujYyDhuqNuaCBPQ1IuIikpOwogICAgICBjb25zdCBidWY9YXdhaXQgYmxvYi5hcnJheUJ1ZmZlcigpOwogICAgICBjb25zdCBieXRlcz1uZXcgVWludDhBcnJheShidWYpOwogICAgICBsZXQgYmluPSIiOwogICAgICBjb25zdCBjaHVuaz0weDgwMDA7CiAgICAgIGZvcihsZXQgaT0wO2k8Ynl0ZXMubGVuZ3RoO2krPWNodW5rKXsKICAgICAgICBiaW4rPVN0cmluZy5mcm9tQ2hhckNvZGUoLi4uYnl0ZXMuc3ViYXJyYXkoaSxNYXRoLm1pbihpK2NodW5rLGJ5dGVzLmxlbmd0aCkpKTsKICAgICAgfQogICAgICByZXNvbHZlKGJ0b2EoYmluKSk7CiAgICB9LCJpbWFnZS9qcGVnIixxdWFsaXR5KTsKICB9KTsKfQoKYXN5bmMgZnVuY3Rpb24gY2xvdWRWaXNpb25PY3IoY2FudmFzKXsKICBpZihzdGF0ZS5jbG91ZE9jcj09PWZhbHNlKSByZXR1cm4gbnVsbDsKICB0cnl7CiAgICBjb25zdCBpbWFnZV9iYXNlNjQ9YXdhaXQgY2FudmFzVG9CYXNlNjRKcGVnKGNhbnZhcywuOTIpOwogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCgiL2FwaS9vY3IiLHsKICAgICAgbWV0aG9kOiJQT1NUIiwKICAgICAgaGVhZGVyczp7ImNvbnRlbnQtdHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7aW1hZ2VfYmFzZTY0fSkKICAgIH0pOwogICAgY29uc3QgZD1hd2FpdCByLmpzb24oKS5jYXRjaCgoKT0+KHt9KSk7CiAgICBpZihyLnN0YXR1cz09PTUwMSB8fCBkLmNvZGU9PT0iVklTSU9OX05PVF9DT05GSUdVUkVEIil7CiAgICAgIHN0YXRlLmNsb3VkT2NyPWZhbHNlOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIGlmKCFyLm9rIHx8ICFkLm9rKSB0aHJvdyBuZXcgRXJyb3IoZC5lcnJvcnx8KCJPQ1IgSFRUUCAiK3Iuc3RhdHVzKSk7CiAgICBzdGF0ZS5jbG91ZE9jcj10cnVlOwogICAgcmV0dXJuIHsKICAgICAgdGV4dDpub3JtYWxpemVPY3JUZXh0KGQudGV4dHx8IiIpLAogICAgICBsYW5ndWFnZXM6QXJyYXkuaXNBcnJheShkLmxhbmd1YWdlcyk/ZC5sYW5ndWFnZXM6W10KICAgIH07CiAgfWNhdGNoKGUpewogICAgY29uc29sZS53YXJuKCJDbG91ZCBPQ1IgZmFsbGJhY2s6IixlKTsKICAgIHJldHVybiBudWxsOwogIH0KfQoKZnVuY3Rpb24gZm9ybWF0Q2xhaW1Gb3JEaXNwbGF5KHMpewogIGNvbnN0IHQ9dHJ1bmNhdGVDbGFpbUF0RmlndXJlKHJlcGFpckNlcnRhaW5Wbk9jcihzKSkKICAgIC5yZXBsYWNlKC9ccyooXChbaXZ4bGNkbV0rXCkpXHMqL2lnLCJcbiQxICIpCiAgICAucmVwbGFjZSgvXHMrKHbDoClccysoPz1cKFtpdnhsY2RtXStcKSkvaWcsIlxuJDEgIik7CiAgcmV0dXJuIHQudHJpbSgpOwp9CgoKZnVuY3Rpb24gcmVuZGVyUHJvY2VzcygpewogICQoInByb2Nlc3MiKS5pbm5lckhUTUw9U1RFUFMubWFwKChzLGkpPT5gPGRpdiBjbGFzcz0icHJvY2Vzcy1pdGVtICR7aT09PXN0YXRlLnN0ZXA/ImFjdGl2ZSI6aTxzdGF0ZS5zdGVwPyJkb25lIjoiIn0iPjxzcGFuIGNsYXNzPSJuIj4ke2k8c3RhdGUuc3RlcD8i4pyTIjppKzF9PC9zcGFuPjxzcGFuPiR7cy50aXRsZX08L3NwYW4+PC9kaXY+YCkuam9pbigiIik7Cn0KZnVuY3Rpb24gc2hvd1N0ZXAoaSl7CiAgc3RhdGUuc3RlcD1NYXRoLm1heCgwLE1hdGgubWluKFNURVBTLmxlbmd0aC0xLGkpKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIuc2VjdGlvbiIpLmZvckVhY2goeD0+eC5jbGFzc0xpc3QucmVtb3ZlKCJhY3RpdmUiKSk7CiAgJChTVEVQU1tzdGF0ZS5zdGVwXS5pZCkuY2xhc3NMaXN0LmFkZCgiYWN0aXZlIik7CiAgJCgicGFnZVRpdGxlIikudGV4dENvbnRlbnQ9U1RFUFNbc3RhdGUuc3RlcF0udGl0bGU7CiAgJCgicGFnZVN1YiIpLnRleHRDb250ZW50PVNURVBTW3N0YXRlLnN0ZXBdLmhpbnQ7CiAgJCgid2l6YXJkVGl0bGUiKS50ZXh0Q29udGVudD1gQsaw4bubYyAke3N0YXRlLnN0ZXArMX0vJHtTVEVQUy5sZW5ndGh9IMK3ICR7U1RFUFNbc3RhdGUuc3RlcF0udGl0bGV9YDsKICAkKCJ3aXphcmRIaW50IikudGV4dENvbnRlbnQ9U1RFUFNbc3RhdGUuc3RlcF0uaGludDsKICAkKCJiYWNrQnRuIikuc3R5bGUudmlzaWJpbGl0eT1zdGF0ZS5zdGVwPT09MD8iaGlkZGVuIjoidmlzaWJsZSI7CiAgJCgibmV4dEJ0biIpLnRleHRDb250ZW50PXN0YXRlLnN0ZXA9PT1TVEVQUy5sZW5ndGgtMT8iSG/DoG4gdOG6pXQiOiJUaeG6v3AgdOG7pWMg4oaSIjsKICByZW5kZXJQcm9jZXNzKCk7CiAgaWYoU1RFUFNbc3RhdGUuc3RlcF0uaWQ9PT0icHJpb3IiKXsKICAgIGlmKCEkKCJsaXZlU2VhcmNoUXVlcnkiKS52YWx1ZSkgdXNlR2VuZXJhdGVkUXVlcnkoKTsKICAgIHVwZGF0ZU9mZmljaWFsU2VhcmNoTGlua3MoJCgibGl2ZVNlYXJjaFF1ZXJ5IikudmFsdWUpOwogIH0KICBzY3JvbGxUbyh7dG9wOjAsYmVoYXZpb3I6InNtb290aCJ9KTsKfQpmdW5jdGlvbiB2YWxpZGF0ZUJlZm9yZU5leHQoKXsKICBpZihzdGF0ZS5zdGVwPT09MCAmJiAhc3RhdGUucmF3VGV4dCAmJiAhc3RhdGUuY2xhaW1zLmxlbmd0aCl7YWxlcnQoIkjDo3kgdOG6o2kgbeG7mXQgUERGIGhv4bq3YyBu4bqhcCBkZW1vIHRyxrDhu5tjLiIpO3JldHVybiBmYWxzZX0KICBpZihzdGF0ZS5zdGVwPT09MSAmJiAhc3RhdGUuY2xhaW1zLmxlbmd0aCl7YWxlcnQoIkNoxrBhIGPDsyBjbGFpbS4gSMOjeSBPQ1IgbOG6oWkgaG/hurdjIHBhc3RlIHBo4bqnbiBZw6p1IGPhuqd1IGLhuqNvIGjhu5kgcuG7k2kgYuG6pW0g4oCcVMOhY2ggbOG6oWkgY2xhaW1z4oCdLiIpO3JldHVybiBmYWxzZX0KICBpZihzdGF0ZS5zdGVwPT09MiAmJiAhc3RhdGUuZmVhdHVyZXMubGVuZ3RoKXthbGVydCgiSMOjeSB0w6FjaCBk4bqldSBoaeG7h3Uga+G7uSB0aHXhuq10IHRyxrDhu5tjLiIpO3JldHVybiBmYWxzZX0KICBpZihzdGF0ZS5zdGVwPT09MiAmJiAhc3RhdGUuY29uZmlybWVkKXtyZXR1cm4gY29uZmlybSgiQuG7mSBk4bqldSBoaeG7h3UgY2jGsGEgxJHGsOG7o2MgeMOhYyBuaOG6rW4uIELhuqFuIHbhuqtuIG114buRbiB0aeG6v3AgdOG7pWM/Iil9CiAgaWYoc3RhdGUuc3RlcD09PTQpe3JlYWRQcmlvcigpO2lmKCFPYmplY3QudmFsdWVzKHN0YXRlLnByaW9yKS5zb21lKHg9Pngubm8pKXtyZXR1cm4gY29uZmlybSgiQ2jGsGEgY8OzIHTDoGkgbGnhu4d1IMSR4buRaSBjaOG7qW5nLiBC4bqhbiB24bqrbiBtdeG7kW4gdGnhur9wIHThu6VjPyIpfX0KICByZXR1cm4gdHJ1ZQp9CiQoImJhY2tCdG4iKS5vbmNsaWNrPSgpPT5zaG93U3RlcChzdGF0ZS5zdGVwLTEpOwokKCJuZXh0QnRuIikub25jbGljaz0oKT0+e2lmKHN0YXRlLnN0ZXA9PT1TVEVQUy5sZW5ndGgtMSl7JCgiZ2VuUmVwb3J0IikuY2xpY2soKTtyZXR1cm59aWYodmFsaWRhdGVCZWZvcmVOZXh0KCkpc2hvd1N0ZXAoc3RhdGUuc3RlcCsxKX07CnNob3dTdGVwKDApO3NldFRpbWVvdXQodXBkYXRlRmVhdHVyZVJldmlld1VJLDApOwppZihsb2NhdGlvbi5wcm90b2NvbD09PSJmaWxlOiIpICQoImxvY2FsQmFubmVyIikuc3R5bGUuZGlzcGxheT0iYmxvY2siOwoKZnVuY3Rpb24gc2V0RGV0ZWN0KGlkLG9rLHRleHQpe2xldCBlbD0kKGlkKTtlbC5jbGFzc05hbWU9ImRldGVjdC1jYXJkICIrKG9rPyJvayI6Indhcm4iKTtlbC5xdWVyeVNlbGVjdG9yKCJzcGFuIikudGV4dENvbnRlbnQ9dGV4dH0KZnVuY3Rpb24gbm9ybURhdGUodil7aWYoIXYpcmV0dXJuIiI7bGV0IG09di5tYXRjaCgvKFxkezEsMn0pW1wvXC0uXShcZHsxLDJ9KVtcL1wtLl0oXGR7NH0pLyk7aWYobSlyZXR1cm4gYCR7bVszXX0tJHtTdHJpbmcobVsyXSkucGFkU3RhcnQoMiwiMCIpfS0ke1N0cmluZyhtWzFdKS5wYWRTdGFydCgyLCIwIil9YDtsZXQgZD1uZXcgRGF0ZSh2KTtyZXR1cm4gaXNOYU4oZCk/IiI6ZC50b0lTT1N0cmluZygpLnNsaWNlKDAsMTApfQpmdW5jdGlvbiBmaXJzdE1hdGNoKHRleHQscGF0dGVybnMpe2Zvcihjb25zdCBwIG9mIHBhdHRlcm5zKXtjb25zdCBtPXRleHQubWF0Y2gocCk7aWYobSYmbVsxXSlyZXR1cm4gY2xlYW4obVsxXSl9cmV0dXJuIiJ9Cgphc3luYyBmdW5jdGlvbiBnZXRQZGZMaWIoKXsKIGlmKCF3aW5kb3cucGRmanNMaWIpIHRocm93IG5ldyBFcnJvcigiUERGLmpzIGNoxrBhIHThuqNpIMSRxrDhu6NjIHThu6sgQ0ROLiIpOwogcGRmanNMaWIuR2xvYmFsV29ya2VyT3B0aW9ucy53b3JrZXJTcmM9Imh0dHBzOi8vY2RuanMuY2xvdWRmbGFyZS5jb20vYWpheC9saWJzL3BkZi5qcy8zLjExLjE3NC9wZGYud29ya2VyLm1pbi5qcyI7CiByZXR1cm4gd2luZG93LnBkZmpzTGliOwp9CmFzeW5jIGZ1bmN0aW9uIHJlYWRQZGYoZmlsZSl7CiAgY29uc3QgcGRmanM9YXdhaXQgZ2V0UGRmTGliKCk7CiAgY29uc3QgcGRmPWF3YWl0IHBkZmpzLmdldERvY3VtZW50KHtkYXRhOmF3YWl0IGZpbGUuYXJyYXlCdWZmZXIoKX0pLnByb21pc2U7CiAgc3RhdGUucGRmPXBkZjsKICBzdGF0ZS5wYWdlVGV4dD1bXTsKICBzdGF0ZS5wYWdlQ29sdW1uVGV4dD1bXTsKICBzdGF0ZS5wYWdlUXVhbGl0eT1bXTsKICBzdGF0ZS5iYWRUZXh0UGFnZXM9W107CgogIGZ1bmN0aW9uIGl0ZW1zVG9MaW5lcyhpdGVtcyl7CiAgICBpZighaXRlbXMubGVuZ3RoKSByZXR1cm4gIiI7CiAgICBjb25zdCBoZWlnaHRzPWl0ZW1zLm1hcCh4PT5NYXRoLmFicyh4Lmh8fDEwKSkuZmlsdGVyKEJvb2xlYW4pLnNvcnQoKGEsYik9PmEtYik7CiAgICBjb25zdCBtZWRpYW5IPWhlaWdodHNbTWF0aC5mbG9vcihoZWlnaHRzLmxlbmd0aC8yKV18fDEwOwogICAgY29uc3QgdG9sPU1hdGgubWF4KDIuMixNYXRoLm1pbig1LG1lZGlhbkgqLjM4KSk7CgogICAgY29uc3Qgcm93cz1bXTsKICAgIGNvbnN0IHNvcnRlZD1pdGVtcy5zbGljZSgpLnNvcnQoKGEsYik9PmIueS1hLnkgfHwgYS54LWIueCk7CiAgICBmb3IoY29uc3QgaXQgb2Ygc29ydGVkKXsKICAgICAgbGV0IHJvdz1yb3dzLmZpbmQocj0+TWF0aC5hYnMoci55LWl0LnkpPD10b2wpOwogICAgICBpZighcm93KXtyb3c9e3k6aXQueSxpdGVtczpbXX07cm93cy5wdXNoKHJvdyl9CiAgICAgIHJvdy5pdGVtcy5wdXNoKGl0KTsKICAgIH0KICAgIHJvd3Muc29ydCgoYSxiKT0+Yi55LWEueSk7CgogICAgcmV0dXJuIHJvd3MubWFwKHI9PnsKICAgICAgY29uc3QgeHM9ci5pdGVtcy5zb3J0KChhLGIpPT5hLngtYi54KTsKICAgICAgbGV0IG91dD0iIjsKICAgICAgbGV0IHByZXY9bnVsbDsKICAgICAgZm9yKGNvbnN0IGl0IG9mIHhzKXsKICAgICAgICBjb25zdCBzPVN0cmluZyhpdC5zfHwiIik7CiAgICAgICAgaWYoIXMpIGNvbnRpbnVlOwogICAgICAgIGlmKHByZXYpewogICAgICAgICAgY29uc3QgZ2FwPWl0LngtKHByZXYueCtwcmV2LncpOwogICAgICAgICAgLy8gQWRkIGEgc3BhY2Ugb25seSB3aGVuIHZpc3VhbCBnYXAgc3VnZ2VzdHMgb25lIGFuZCBwdW5jdHVhdGlvbiBkb2VzIG5vdC4KICAgICAgICAgIGlmKGdhcD5NYXRoLm1heCgxLjUsKHByZXYuaHx8MTApKi4xMikgJiYgIS9bXHNcLVwvXSQvLnRlc3Qob3V0KSAmJiAhL15bLC47OiVcKV0vLnRlc3QocykpIG91dCs9IiAiOwogICAgICAgIH0KICAgICAgICBvdXQrPXM7CiAgICAgICAgcHJldj1pdDsKICAgICAgfQogICAgICByZXR1cm4gb3V0LnRyaW0oKTsKICAgIH0pLmZpbHRlcihCb29sZWFuKS5qb2luKCJcbiIpOwogIH0KCiAgZm9yKGxldCBwPTE7cDw9cGRmLm51bVBhZ2VzO3ArKyl7CiAgICBjb25zdCBwYWdlPWF3YWl0IHBkZi5nZXRQYWdlKHApOwogICAgY29uc3Qgdmlld3BvcnQ9cGFnZS5nZXRWaWV3cG9ydCh7c2NhbGU6MX0pOwogICAgY29uc3QgY29udGVudD1hd2FpdCBwYWdlLmdldFRleHRDb250ZW50KHtkaXNhYmxlTm9ybWFsaXphdGlvbjpmYWxzZX0pOwoKICAgIGNvbnN0IGl0ZW1zPWNvbnRlbnQuaXRlbXMKICAgICAgLmZpbHRlcih4PT54ICYmIHR5cGVvZiB4LnN0cj09PSJzdHJpbmciICYmIHguc3RyLnRyaW0oKSkKICAgICAgLm1hcCh4PT4oewogICAgICAgIHM6eC5zdHIubm9ybWFsaXplKCJORkMiKSwKICAgICAgICB4OngudHJhbnNmb3JtWzRdLAogICAgICAgIHk6eC50cmFuc2Zvcm1bNV0sCiAgICAgICAgdzpOdW1iZXIoeC53aWR0aCl8fDAsCiAgICAgICAgaDpOdW1iZXIoeC5oZWlnaHQpfHxNYXRoLmFicyh4LnRyYW5zZm9ybVszXSl8fDEwCiAgICAgIH0pKTsKCiAgICBsZXQgc2ltcGxlPXN0cmlwUGRmQXJ0aWZhY3RzKGl0ZW1zVG9MaW5lcyhpdGVtcykpOwogICAgY29uc3QgbWlkPXZpZXdwb3J0LndpZHRoLzI7CiAgICBsZXQgbGVmdD1zdHJpcFBkZkFydGlmYWN0cyhpdGVtc1RvTGluZXMoaXRlbXMuZmlsdGVyKHg9PngueDxtaWQpKSk7CiAgICBsZXQgcmlnaHQ9c3RyaXBQZGZBcnRpZmFjdHMoaXRlbXNUb0xpbmVzKGl0ZW1zLmZpbHRlcih4PT54Lng+PW1pZCkpKTsKCiAgICBjb25zdCBxPXRleHRMYXllclF1YWxpdHlTY29yZShzaW1wbGUpOwogICAgc3RhdGUucGFnZVRleHQucHVzaChzaW1wbGUpOwogICAgc3RhdGUucGFnZUNvbHVtblRleHQucHVzaChsZWZ0KyJcbiIrcmlnaHQpOwogICAgc3RhdGUucGFnZVF1YWxpdHkucHVzaChxKTsKICAgIGlmKHE8NDgpIHN0YXRlLmJhZFRleHRQYWdlcy5wdXNoKHApOwoKICAgICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9TWF0aC5yb3VuZChwL3BkZi5udW1QYWdlcyozNSkrIiUiOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YMSQYW5nIMSR4buNYyB0ZXh0IGxheWVyOiAke3B9LyR7cGRmLm51bVBhZ2VzfSDCtyBjaOG6pXQgbMaw4bujbmcgJHtxfS8xMDBgOwogIH0KICBjaG9vc2VEb2N1bWVudExhbmd1YWdlKCk7CiAgcmV0dXJuIHBkZjsKfQoKZnVuY3Rpb24gdGV4dFF1YWxpdHkoKXsKICBjb25zdCBjaGFycz1zdGF0ZS5wYWdlVGV4dC5yZWR1Y2UoKG4scyk9Pm4rcy5sZW5ndGgsMCk7CiAgY29uc3QgZ29vZD1zdGF0ZS5wYWdlUXVhbGl0eS5maWx0ZXIoeD0+eD49NDgpLmxlbmd0aDsKICByZXR1cm4ge2NoYXJzLGF2ZzpjaGFycy9NYXRoLm1heCgxLHN0YXRlLnBhZ2VUZXh0Lmxlbmd0aCksZ29vZFBhZ2VzOmdvb2QsYmFkUGFnZXM6c3RhdGUuYmFkVGV4dFBhZ2VzLmxlbmd0aH07Cn0KCmFzeW5jIGZ1bmN0aW9uIHJlbmRlclBhZ2VDYW52YXMocGFnZU5vLHNjYWxlPTEuNzUpewogIGNvbnN0IHBhZ2U9YXdhaXQgc3RhdGUucGRmLmdldFBhZ2UocGFnZU5vKSx2aWV3cG9ydD1wYWdlLmdldFZpZXdwb3J0KHtzY2FsZX0pOwogIGNvbnN0IGNhbnZhcz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJjYW52YXMiKTtjYW52YXMud2lkdGg9TWF0aC5jZWlsKHZpZXdwb3J0LndpZHRoKTtjYW52YXMuaGVpZ2h0PU1hdGguY2VpbCh2aWV3cG9ydC5oZWlnaHQpOwogIGF3YWl0IHBhZ2UucmVuZGVyKHtjYW52YXNDb250ZXh0OmNhbnZhcy5nZXRDb250ZXh0KCIyZCIpLHZpZXdwb3J0fSkucHJvbWlzZTtyZXR1cm4gY2FudmFzOwp9CgpmdW5jdGlvbiBwcmVwcm9jZXNzT2NyQ2FudmFzKHNyYyl7CiAgY29uc3Qgb3V0PWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImNhbnZhcyIpOwogIG91dC53aWR0aD1zcmMud2lkdGg7IG91dC5oZWlnaHQ9c3JjLmhlaWdodDsKICBjb25zdCBjdHg9b3V0LmdldENvbnRleHQoIjJkIix7d2lsbFJlYWRGcmVxdWVudGx5OnRydWV9KTsKICBjdHguZHJhd0ltYWdlKHNyYywwLDApOwogIGNvbnN0IGltZz1jdHguZ2V0SW1hZ2VEYXRhKDAsMCxvdXQud2lkdGgsb3V0LmhlaWdodCk7CiAgY29uc3QgZD1pbWcuZGF0YTsKCiAgLy8gSGlzdG9ncmFtIGdyYXlzY2FsZSBmb3Igcm9idXN0IHRocmVzaG9sZC4KICBjb25zdCBoaXN0PW5ldyBBcnJheSgyNTYpLmZpbGwoMCk7CiAgZm9yKGxldCBpPTA7aTxkLmxlbmd0aDtpKz00KXsKICAgIGNvbnN0IGc9TWF0aC5tYXgoMCxNYXRoLm1pbigyNTUsTWF0aC5yb3VuZCgwLjI5OSpkW2ldKzAuNTg3KmRbaSsxXSswLjExNCpkW2krMl0pKSk7CiAgICBoaXN0W2ddKys7CiAgfQogIGxldCB0b3RhbD1vdXQud2lkdGgqb3V0LmhlaWdodCxzdW09MDsKICBmb3IobGV0IGk9MDtpPDI1NjtpKyspIHN1bSs9aSpoaXN0W2ldOwogIGxldCBzdW1CPTAsd0I9MCxtYXhWYXI9MCx0aHI9MTc4OwogIGZvcihsZXQgdD0wO3Q8MjU2O3QrKyl7CiAgICB3Qis9aGlzdFt0XTsgaWYoIXdCKSBjb250aW51ZTsKICAgIGNvbnN0IHdGPXRvdGFsLXdCOyBpZighd0YpIGJyZWFrOwogICAgc3VtQis9dCpoaXN0W3RdOwogICAgY29uc3QgbUI9c3VtQi93QixtRj0oc3VtLXN1bUIpL3dGOwogICAgY29uc3Qgdj13Qip3RioobUItbUYpKihtQi1tRik7CiAgICBpZih2Pm1heFZhcil7bWF4VmFyPXY7dGhyPXR9CiAgfQogIC8vIEF2b2lkIG92ZXJseSBhZ2dyZXNzaXZlIHRocmVzaG9sZCBmb3IgcGFsZSBzY2Fucy4KICB0aHI9TWF0aC5tYXgoMTQ1LE1hdGgubWluKDIwNSx0aHIrMTIpKTsKCiAgZm9yKGxldCBpPTA7aTxkLmxlbmd0aDtpKz00KXsKICAgIGxldCBnPTAuMjk5KmRbaV0rMC41ODcqZFtpKzFdKzAuMTE0KmRbaSsyXTsKICAgIC8vIGNvbnRyYXN0IHN0cmV0Y2ggYmVmb3JlIGJpbmFyaXphdGlvbgogICAgZz0oZy0xMjgpKjEuMjIrMTI4OwogICAgY29uc3Qgdj1nPHRocj8wOjI1NTsKICAgIGRbaV09ZFtpKzFdPWRbaSsyXT12OwogICAgZFtpKzNdPTI1NTsKICB9CiAgY3R4LnB1dEltYWdlRGF0YShpbWcsMCwwKTsKICByZXR1cm4gb3V0Owp9CgpmdW5jdGlvbiBjcm9wQ2FudmFzVG9wKHNyYyxyYXRpbyl7CiAgcmF0aW89TWF0aC5tYXgoLjQ1LE1hdGgubWluKDEsTnVtYmVyKHJhdGlvKXx8MSkpOwogIGNvbnN0IG91dD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJjYW52YXMiKTsKICBvdXQud2lkdGg9c3JjLndpZHRoOwogIG91dC5oZWlnaHQ9TWF0aC5tYXgoMSxNYXRoLnJvdW5kKHNyYy5oZWlnaHQqcmF0aW8pKTsKICBvdXQuZ2V0Q29udGV4dCgiMmQiKS5kcmF3SW1hZ2Uoc3JjLDAsMCxzcmMud2lkdGgsb3V0LmhlaWdodCwwLDAsc3JjLndpZHRoLG91dC5oZWlnaHQpOwogIHJldHVybiBvdXQ7Cn0KCmZ1bmN0aW9uIHByZWZlcnJlZE9jckxhbmd1YWdlcyhwYWdlTm8pewogIGNvbnN0IHBhZ2U9c3RhdGUubGFuZ3VhZ2VCeVBhZ2VbcGFnZU5vXTsKICBjb25zdCBsYW5nPShwYWdlJiZwYWdlLmxhbmcmJnBhZ2UubGFuZyE9PSJ1bmtub3duIik/cGFnZS5sYW5nOnN0YXRlLmRvY0xhbmc7CiAgaWYobGFuZz09PSJ2aSIpIHJldHVybiBbInZpZSIsWyJ2aWUiLCJlbmciXV07CiAgaWYobGFuZz09PSJlbiIpIHJldHVybiBbImVuZyIsWyJlbmciLCJ2aWUiXV07CiAgcmV0dXJuIFtbInZpZSIsImVuZyJdLCJ2aWUiLCJlbmciXTsKfQoKYXN5bmMgZnVuY3Rpb24gcmVjb2duaXplV2l0aExhbmcod29ya2VyLGNhbnZhcyxsYW5nLHBzbSl7CiAgY29uc3QgbGFuZ3M9QXJyYXkuaXNBcnJheShsYW5nKT9sYW5nOltsYW5nXTsKICB0cnl7CiAgICBhd2FpdCB3b3JrZXIucmVpbml0aWFsaXplKGxhbmdzLDEpOwogIH1jYXRjaChlKXsKICAgIC8vIFNvbWUgYnVpbGRzIGFjY2VwdCBzdHJpbmcgbW9yZSByZWxpYWJseSBmb3IgYSBzaW5nbGUgbGFuZ3VhZ2UuCiAgICBpZihsYW5ncy5sZW5ndGg9PT0xKSBhd2FpdCB3b3JrZXIucmVpbml0aWFsaXplKGxhbmdzWzBdLDEpOwogICAgZWxzZSB0aHJvdyBlOwogIH0KICBhd2FpdCB3b3JrZXIuc2V0UGFyYW1ldGVycyh7CiAgICBwcmVzZXJ2ZV9pbnRlcndvcmRfc3BhY2VzOiIxIiwKICAgIHVzZXJfZGVmaW5lZF9kcGk6IjMwMCIsCiAgICB0ZXNzZWRpdF9wYWdlc2VnX21vZGU6U3RyaW5nKHBzbSkKICB9KTsKICBjb25zdCByZXM9YXdhaXQgd2l0aFRpbWVvdXQoCiAgICB3b3JrZXIucmVjb2duaXplKGNhbnZhcyksCiAgICA2NTAwMCwKICAgIGBPQ1IgJHtsYW5ncy5qb2luKCIrIil9IFBTTSAke3BzbX1gCiAgKTsKICByZXR1cm4gewogICAgdGV4dDoocmVzJiZyZXMuZGF0YSYmcmVzLmRhdGEudGV4dCl8fCIiLAogICAgY29uZmlkZW5jZTpOdW1iZXIocmVzJiZyZXMuZGF0YSYmcmVzLmRhdGEuY29uZmlkZW5jZSl8fDAsCiAgICBsYW5nOmxhbmdzLmpvaW4oIisiKQogIH07Cn0KCmZ1bmN0aW9uIG9jclF1YWxpdHlTY29yZSh0ZXh0LGNvbmZpZGVuY2U9MCl7CiAgY29uc3QgZj1mb2xkVk4odGV4dHx8IiIpOwogIGxldCBzY29yZT1OdW1iZXIoY29uZmlkZW5jZSl8fDA7CiAgY29uc3QgcGF0ZW50V29yZHM9WyJZRVUgQ0FVIEJBTyBITyIsIlFVWSBUUklOSCIsIlBIVU9ORyBQSEFQIiwiQkFPIEdPTSIsIlRST05HIERPIiwiU0FORyBDSEUiLCJUSElFVCBCSSIsIkhFIFRIT05HIiwiVEhBTkggUEhBTiJdOwogIGZvcihjb25zdCB3IG9mIHBhdGVudFdvcmRzKSBpZihmLmluY2x1ZGVzKHcpKSBzY29yZSs9ODsKICBzY29yZSs9TWF0aC5taW4oMjAsKHRleHR8fCIiKS5sZW5ndGgvMjUwKTsKICAvLyBQZW5hbGl6ZSBvYnZpb3VzIE9DUiBnYXJiYWdlLgogIGNvbnN0IHdlaXJkPSgodGV4dHx8IiIpLm1hdGNoKC9bfHt9PD5+XmBdL2cpfHxbXSkubGVuZ3RoOwogIHNjb3JlLT1NYXRoLm1pbigyMCx3ZWlyZCoyKTsKICByZXR1cm4gc2NvcmU7Cn0KCgpjb25zdCBzbGVlcCA9IG1zID0+IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCBtcykpOwpmdW5jdGlvbiB3aXRoVGltZW91dChwcm9taXNlLCBtcywgbGFiZWwpewogIGxldCB0aW1lcjsKICBjb25zdCB0aW1lb3V0ID0gbmV3IFByb21pc2UoKF8sIHJlamVjdCkgPT4gewogICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlamVjdChuZXcgRXJyb3IobGFiZWwgKyAiIHF1w6EgdGjhu51pIGdpYW4iKSksIG1zKTsKICB9KTsKICByZXR1cm4gUHJvbWlzZS5yYWNlKFtwcm9taXNlLCB0aW1lb3V0XSkuZmluYWxseSgoKSA9PiBjbGVhclRpbWVvdXQodGltZXIpKTsKfQoKbGV0IG9jcldvcmtlclByb21pc2UgPSBudWxsOwpjb25zdCBURVNTX0NGRz17CiAgd29ya2VyUGF0aDoiaHR0cHM6Ly9jZG4uanNkZWxpdnIubmV0L25wbS90ZXNzZXJhY3QuanNANS4xLjEvZGlzdC93b3JrZXIubWluLmpzIiwKICBjb3JlUGF0aDoiaHR0cHM6Ly9jZG4uanNkZWxpdnIubmV0L25wbS90ZXNzZXJhY3QuanMtY29yZUA1LjEuMSIsCiAgbGFuZ1BhdGg6Imh0dHBzOi8vdGVzc2RhdGEucHJvamVjdG5hcHRoYS5jb20vNC4wLjAiCn07Cgphc3luYyBmdW5jdGlvbiBwcm9iZVRlc3NQYWNrKGxhbmcpewogIGNvbnN0IHVybD1gJHtURVNTX0NGRy5sYW5nUGF0aH0vJHtsYW5nfS50cmFpbmVkZGF0YS5nemA7CiAgdHJ5ewogICAgLy8gUmFuZ2Uga2VlcHMgdGhpcyBkaWFnbm9zdGljIGxpZ2h0d2VpZ2h0IHdoZW4gdGhlIENETiBzdXBwb3J0cyBpdC4KICAgIGNvbnN0IHI9YXdhaXQgZmV0Y2godXJsLHtoZWFkZXJzOntSYW5nZToiYnl0ZXM9MC0zMSJ9LGNhY2hlOiJmb3JjZS1jYWNoZSJ9KTsKICAgIGlmKCFyLm9rICYmIHIuc3RhdHVzIT09MjA2KSB0aHJvdyBuZXcgRXJyb3IoYCR7bGFuZ30udHJhaW5lZGRhdGEgSFRUUCAke3Iuc3RhdHVzfWApOwogICAgc3RhdGUudGVzc0RpYWdbbGFuZ109dHJ1ZTsKICAgIHJlbmRlclRlc3NEaWFnKCk7CiAgICByZXR1cm4gdHJ1ZTsKICB9Y2F0Y2goZSl7CiAgICBzdGF0ZS50ZXNzRGlhZy5lcnJvcj1gS2jDtG5nIHThuqNpIMSRxrDhu6NjICR7bGFuZ30udHJhaW5lZGRhdGE6ICR7U3RyaW5nKGUubWVzc2FnZXx8ZSl9YDsKICAgIHJlbmRlclRlc3NEaWFnKCk7CiAgICB0aHJvdyBlOwogIH0KfQoKYXN5bmMgZnVuY3Rpb24gZ2V0T2NyV29ya2VyKHJlYXNvbj0iT0NSIil7CiAgaWYob2NyV29ya2VyUHJvbWlzZSkgcmV0dXJuIG9jcldvcmtlclByb21pc2U7CiAgaWYoIXdpbmRvdy5UZXNzZXJhY3QpIHRocm93IG5ldyBFcnJvcigiS2jDtG5nIHThuqNpIMSRxrDhu6NjIFRlc3NlcmFjdC5qcy4iKTsKCiAgc3RhdGUudGVzc0RpYWc9e3ZpZTpmYWxzZSxlbmc6ZmFsc2UsZXJyb3I6IiJ9OwogIHJlbmRlclRlc3NEaWFnKCk7CiAgc2V0RGV0ZWN0KCJkZXRPQ1IiLGZhbHNlLCLEkGFuZyB04bqjaSBi4buZIE9DUiB2aWUgKyBlbmcuLi4iKTsKICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1yZWFzb24rIjogxJFhbmcga2nhu4NtIHRyYSBsYW5ndWFnZSBwYWNrcyB0aeG6v25nIFZp4buHdCArIHRp4bq/bmcgQW5oLi4uIjsKICBhd2FpdCBzbGVlcCg2MCk7CgogIC8vIERvIG5vdCBzaWxlbnRseSBjb250aW51ZSBpZiBWaWV0bmFtZXNlIHRyYWluZWRkYXRhIGlzIHVuYXZhaWxhYmxlLgogIGF3YWl0IFByb21pc2UuYWxsKFtwcm9iZVRlc3NQYWNrKCJ2aWUiKSxwcm9iZVRlc3NQYWNrKCJlbmciKV0pOwoKICBjb25zdCBsYW5ncz1bInZpZSIsImVuZyJdOyAvLyBwcmVsb2FkIGJvdGggcGFja3M7IHYxMiByZWluaXRpYWxpemUgdGhlbyBuZ8O0biBuZ+G7ryB04burbmcgdHJhbmcKICBjb25zdCBPRU09KFRlc3NlcmFjdC5PRU0gJiYgVGVzc2VyYWN0Lk9FTS5MU1RNX09OTFkpIHx8IDE7CgogIG9jcldvcmtlclByb21pc2U9d2l0aFRpbWVvdXQoCiAgICBUZXNzZXJhY3QuY3JlYXRlV29ya2VyKGxhbmdzLE9FTSx7CiAgICAgIHdvcmtlclBhdGg6VEVTU19DRkcud29ya2VyUGF0aCwKICAgICAgY29yZVBhdGg6VEVTU19DRkcuY29yZVBhdGgsCiAgICAgIGxhbmdQYXRoOlRFU1NfQ0ZHLmxhbmdQYXRoLAogICAgICBnemlwOnRydWUsCiAgICAgIGNhY2hlTWV0aG9kOiJ3cml0ZSIsCiAgICAgIGxvZ2dlcjptPT57CiAgICAgICAgaWYoIW0pIHJldHVybjsKICAgICAgICBjb25zdCBzdGF0dXM9U3RyaW5nKG0uc3RhdHVzfHwiIik7CiAgICAgICAgY29uc3QgcGN0PU1hdGgucm91bmQoKG0ucHJvZ3Jlc3N8fDApKjEwMCk7CgogICAgICAgIGlmKC9sb2FkaW5nIGxhbmd1YWdlIHRyYWluZWRkYXRhL2kudGVzdChzdGF0dXMpKXsKICAgICAgICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PWAke3JlYXNvbn06IMSRYW5nIHThuqNpIHZpZSArIGVuZyB0cmFpbmVkZGF0YSAke3BjdH0lYDsKICAgICAgICB9ZWxzZSBpZigvaW5pdGlhbGl6aW5nIGFwaS9pLnRlc3Qoc3RhdHVzKSl7CiAgICAgICAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1gJHtyZWFzb259OiBraOG7n2kgdOG6oW8gT0NSIHZpZSArIGVuZyAke3BjdH0lYDsKICAgICAgICB9ZWxzZSBpZihzdGF0dXM9PT0icmVjb2duaXppbmcgdGV4dCIpewogICAgICAgICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YCR7cmVhc29ufTogbmjhuq1uIGRp4buHbiB2aWUgKyBlbmcgJHtwY3R9JWA7CiAgICAgICAgfQogICAgICB9LAogICAgICBlcnJvckhhbmRsZXI6ZXJyPT57CiAgICAgICAgc3RhdGUudGVzc0RpYWcuZXJyb3I9U3RyaW5nKGVyciYmZXJyLm1lc3NhZ2U/ZXJyLm1lc3NhZ2U6ZXJyKTsKICAgICAgICByZW5kZXJUZXNzRGlhZygpOwogICAgICAgIGNvbnNvbGUuZXJyb3IoIlRlc3NlcmFjdCB3b3JrZXI6IixlcnIpOwogICAgICB9CiAgICB9KSwKICAgIDQ1MDAwLAogICAgIkto4bufaSB04bqhbyBPQ1IgdmllICsgZW5nIgogICk7CgogIHRyeXsKICAgIGNvbnN0IHdvcmtlcj1hd2FpdCBvY3JXb3JrZXJQcm9taXNlOwogICAgYXdhaXQgd29ya2VyLnNldFBhcmFtZXRlcnMoewogICAgICBwcmVzZXJ2ZV9pbnRlcndvcmRfc3BhY2VzOiIxIiwKICAgICAgdXNlcl9kZWZpbmVkX2RwaToiMzAwIgogICAgfSk7CiAgICBzdGF0ZS50ZXNzRGlhZy52aWU9dHJ1ZTsKICAgIHN0YXRlLnRlc3NEaWFnLmVuZz10cnVlOwogICAgcmVuZGVyVGVzc0RpYWcoKTsKICAgIHJldHVybiB3b3JrZXI7CiAgfWNhdGNoKGUpewogICAgb2NyV29ya2VyUHJvbWlzZT1udWxsOwogICAgc3RhdGUudGVzc0RpYWcuZXJyb3I9U3RyaW5nKGUubWVzc2FnZXx8ZSk7CiAgICByZW5kZXJUZXNzRGlhZygpOwogICAgdGhyb3cgZTsKICB9Cn0KCmFzeW5jIGZ1bmN0aW9uIG9jclNlbGVjdGVkUGFnZXMocGFnZU5vcyxyZWFzb249Ik9DUiIsZm9yY2U9ZmFsc2UpewogIGlmKCFzdGF0ZS5wZGYpIHJldHVybiBmYWxzZTsKICB0cnl7CiAgICBsZXQgbG9jYWxXb3JrZXI9bnVsbDsKICAgIGxldCBkb25lPTA7CgogICAgZm9yKGNvbnN0IHAgb2YgcGFnZU5vcyl7CiAgICAgIGlmKHN0YXRlLm9jclBhZ2VzW3BdJiYhZm9yY2Upe2RvbmUrKztjb250aW51ZTt9CiAgICAgIGlmKGZvcmNlKSBkZWxldGUgc3RhdGUub2NyUGFnZXNbcF07CgogICAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1gJHtyZWFzb259OiB0cmFuZyAke3B9Li4uYDsKICAgICAgYXdhaXQgc2xlZXAoMjApOwoKICAgICAgY29uc3QgY2FuZGlkYXRlcz1bXTsKICAgICAgY29uc3QgZGlyZWN0PXN0YXRlLnBhZ2VUZXh0W3AtMV18fCIiOwogICAgICBjb25zdCBkaXJlY3RRPXN0YXRlLnBhZ2VRdWFsaXR5W3AtMV18fDA7CiAgICAgIGNvbnN0IGRpcmVjdExhbmc9ZGV0ZWN0VGV4dExhbmd1YWdlKGRpcmVjdCk7CgogICAgICAvLyBGb3IgYSBjbGVhbiBkaWdpdGFsIFBERiwgc3Ryb25nbHkgcHJlZmVyIGl0cyBlbWJlZGRlZCBVbmljb2RlIHRleHQuCiAgICAgIGlmKGRpcmVjdC50cmltKCkpewogICAgICAgIGxldCBib251cz0oZGlyZWN0UT49NjIgJiYgIWxvb2tzTGlrZUxlZ2FjeUVuY29kaW5nKGRpcmVjdCkpPzM4OjA7CiAgICAgICAgYm9udXMrPWxhbmd1YWdlRml0U2NvcmUoZGlyZWN0LGRpcmVjdExhbmcubGFuZyk7CiAgICAgICAgY2FuZGlkYXRlcy5wdXNoKHsKICAgICAgICAgIHNvdXJjZTpgUERGIHRleHQgbGF5ZXIgwrcgJHtsYW5ndWFnZUxhYmVsKGRpcmVjdExhbmcubGFuZyl9YCwKICAgICAgICAgIHRleHQ6ZGlyZWN0LAogICAgICAgICAgc2NvcmVPdmVycmlkZTp2bk9jclF1YWxpdHkoZGlyZWN0KStib251cwogICAgICAgIH0pOwogICAgICB9CgogICAgICBjb25zdCByYXdDYW52YXM9YXdhaXQgcmVuZGVyUGFnZUNhbnZhcyhwLDIuNzUpOwoKICAgICAgLy8gR29vZ2xlIFZpc2lvbiBhdXRvLWRldGVjdHMgTGF0aW4gbGFuZ3VhZ2VzOyB1c2UgcmV0dXJuZWQgbGFuZ3VhZ2UgbWV0YWRhdGEgYXMgYSBzZWNvbmQgc2lnbmFsLgogICAgICB0cnl7CiAgICAgICAgY29uc3QgY2xvdWQ9YXdhaXQgY2xvdWRWaXNpb25PY3IocmF3Q2FudmFzKTsKICAgICAgICBpZihjbG91ZCYmY2xvdWQudGV4dCYmY2xvdWQudGV4dC5sZW5ndGg+MjApewogICAgICAgICAgY29uc3QgdG9wTGFuZz1jbG91ZC5sYW5ndWFnZXMmJmNsb3VkLmxhbmd1YWdlc1swXTsKICAgICAgICAgIGlmKHRvcExhbmcmJnRvcExhbmcubGFuZ3VhZ2VDb2RlKXsKICAgICAgICAgICAgc3RhdGUudmlzaW9uTGFuZ3VhZ2VzQnlQYWdlW3BdPWNsb3VkLmxhbmd1YWdlczsKICAgICAgICAgICAgY29uc3QgbGM9U3RyaW5nKHRvcExhbmcubGFuZ3VhZ2VDb2RlKS50b0xvd2VyQ2FzZSgpOwogICAgICAgICAgICBpZihsYy5zdGFydHNXaXRoKCJ2aSIpKSBzdGF0ZS5sYW5ndWFnZUJ5UGFnZVtwXT17bGFuZzoidmkiLGNvbmZpZGVuY2U6TnVtYmVyKHRvcExhbmcuY29uZmlkZW5jZSl8fC43fTsKICAgICAgICAgICAgZWxzZSBpZihsYy5zdGFydHNXaXRoKCJlbiIpKSBzdGF0ZS5sYW5ndWFnZUJ5UGFnZVtwXT17bGFuZzoiZW4iLGNvbmZpZGVuY2U6TnVtYmVyKHRvcExhbmcuY29uZmlkZW5jZSl8fC43fTsKICAgICAgICAgIH0KICAgICAgICAgIGNhbmRpZGF0ZXMucHVzaCh7CiAgICAgICAgICAgIHNvdXJjZTpgR29vZ2xlIFZpc2lvbiBhdXRvJHt0b3BMYW5nP2AgwrcgJHt0b3BMYW5nLmxhbmd1YWdlQ29kZX1gOiIifWAsCiAgICAgICAgICAgIHRleHQ6Y2xvdWQudGV4dAogICAgICAgICAgfSk7CiAgICAgICAgfQogICAgICB9Y2F0Y2goX2Upe30KCiAgICAgIC8vIFRlc3NlcmFjdDogcGljayBsYW5ndWFnZSBwZXIgcGFnZS9kb2N1bWVudC4gVmlldG5hbWVzZSBhbmQgRW5nbGlzaCBhcmUgbm90IGZvcmNlZCB0byBjb21wZXRlIG9uIGV2ZXJ5IHBhZ2UuCiAgICAgIGlmKCFsb2NhbFdvcmtlcikgbG9jYWxXb3JrZXI9YXdhaXQgZ2V0T2NyV29ya2VyKHJlYXNvbik7CiAgICAgIGNvbnN0IGxhbmdzVG9Ucnk9cHJlZmVycmVkT2NyTGFuZ3VhZ2VzKHApOwoKICAgICAgLy8gQ2xhaW1zIG9mdGVuIG9jY3VweSB1cHBlciBwYXJ0IG9mIGEgcGFnZSBmb2xsb3dlZCBieSBhIGZpZ3VyZS4gVHJ5IGNyb3BwZWQgdmFyaWFudHMuCiAgICAgIGNvbnN0IGNhbnZhc2VzPVsKICAgICAgICB7bmFtZToiZnVsbCIsY2FudmFzOnJhd0NhbnZhc30sCiAgICAgICAge25hbWU6InRvcDgyIixjYW52YXM6Y3JvcENhbnZhc1RvcChyYXdDYW52YXMsLjgyKX0sCiAgICAgICAge25hbWU6InRvcDcyIixjYW52YXM6Y3JvcENhbnZhc1RvcChyYXdDYW52YXMsLjcyKX0KICAgICAgXTsKCiAgICAgIGxldCBwYXNzQ291bnQ9MDsKICAgICAgZm9yKGNvbnN0IGxhbmcgb2YgbGFuZ3NUb1RyeSl7CiAgICAgICAgZm9yKGNvbnN0IGMgb2YgY2FudmFzZXMpewogICAgICAgICAgaWYocGFzc0NvdW50Pj02KSBicmVhazsKICAgICAgICAgIC8vIFZpZXRuYW1lc2UgdXNlcyBQU00gNiBmb3IgZGVuc2UgY2xhaW1zOyBFbmdsaXNoL21peGVkIHN0YXJ0cyB3aXRoIFBTTSAzLgogICAgICAgICAgY29uc3QgcHNtPShBcnJheS5pc0FycmF5KGxhbmcpPzM6KGxhbmc9PT0idmllIj82OjMpKTsKICAgICAgICAgIHRyeXsKICAgICAgICAgICAgY29uc3QgcnI9YXdhaXQgcmVjb2duaXplV2l0aExhbmcobG9jYWxXb3JrZXIsYy5jYW52YXMsbGFuZyxwc20pOwogICAgICAgICAgICBpZihyci50ZXh0LnRyaW0oKSl7CiAgICAgICAgICAgICAgY29uc3QgdGFyZ2V0PUFycmF5LmlzQXJyYXkobGFuZyk/Im1peGVkIjoobGFuZz09PSJ2aWUiPyJ2aSI6ImVuIik7CiAgICAgICAgICAgICAgY29uc3QgY2xlYW49cmVwYWlyQ2VydGFpblZuT2NyKHJyLnRleHQpOwogICAgICAgICAgICAgIGNvbnN0IHNjb3JlPXZuT2NyUXVhbGl0eShjbGVhbikKICAgICAgICAgICAgICAgICtsYW5ndWFnZUZpdFNjb3JlKGNsZWFuLHRhcmdldCkKICAgICAgICAgICAgICAgICtNYXRoLm1pbigxMixyci5jb25maWRlbmNlLzgpCiAgICAgICAgICAgICAgICArKGMubmFtZT09PSJmdWxsIj8wOjYpOwogICAgICAgICAgICAgIGNhbmRpZGF0ZXMucHVzaCh7CiAgICAgICAgICAgICAgICBzb3VyY2U6YFRlc3NlcmFjdCAke3JyLmxhbmd9IMK3ICR7Yy5uYW1lfSDCtyBQU00gJHtwc219YCwKICAgICAgICAgICAgICAgIHRleHQ6Y2xlYW4sCiAgICAgICAgICAgICAgICBzY29yZU92ZXJyaWRlOnNjb3JlCiAgICAgICAgICAgICAgfSk7CiAgICAgICAgICAgIH0KICAgICAgICAgIH1jYXRjaChlKXtjb25zb2xlLndhcm4oIk9DUiBwYXNzIixsYW5nLGMubmFtZSxlKX0KICAgICAgICAgIHBhc3NDb3VudCsrOwogICAgICAgIH0KICAgICAgICBpZihwYXNzQ291bnQ+PTYpIGJyZWFrOwogICAgICB9CgogICAgICBjb25zdCByYW5rZWQ9Y2FuZGlkYXRlcwogICAgICAgIC5tYXAoeD0+KHsKICAgICAgICAgIC4uLngsCiAgICAgICAgICB0ZXh0OnRydW5jYXRlQ2xhaW1BdEZpZ3VyZShyZXBhaXJDZXJ0YWluVm5PY3IoeC50ZXh0KSksCiAgICAgICAgICBzY29yZTpOdW1iZXIuaXNGaW5pdGUoeC5zY29yZU92ZXJyaWRlKT94LnNjb3JlT3ZlcnJpZGU6dm5PY3JRdWFsaXR5KHgudGV4dCkKICAgICAgICB9KSkKICAgICAgICAuZmlsdGVyKHg9PngudGV4dC5sZW5ndGg+MTUpCiAgICAgICAgLnNvcnQoKGEsYik9PmIuc2NvcmUtYS5zY29yZSk7CgogICAgICBjb25zdCBiZXN0PXJhbmtlZFswXTsKICAgICAgaWYoYmVzdCl7CiAgICAgICAgc3RhdGUub2NyUGFnZXNbcF09YmVzdC50ZXh0OwogICAgICAgIGNvbnN0IGRldD1kZXRlY3RUZXh0TGFuZ3VhZ2UoYmVzdC50ZXh0KTsKICAgICAgICBzdGF0ZS5sYW5ndWFnZUJ5UGFnZVtwXT1kZXQubGFuZz09PSJ1bmtub3duIj8oc3RhdGUubGFuZ3VhZ2VCeVBhZ2VbcF18fGRldCk6ZGV0OwogICAgICAgIHN0YXRlLmNsYWltU291cmNlQnlQYWdlW3BdPXtzb3VyY2U6YmVzdC5zb3VyY2Usc2NvcmU6TWF0aC5yb3VuZChiZXN0LnNjb3JlKSxsYW5nOmRldC5sYW5nfTsKICAgICAgICBzZXREZXRlY3QoImRldE9DUiIsdHJ1ZSxgJHtiZXN0LnNvdXJjZX0gwrcgJHtsYW5ndWFnZUxhYmVsKGRldC5sYW5nKX0gwrcgJHtNYXRoLnJvdW5kKGJlc3Quc2NvcmUpfS8xMDBgKTsKICAgICAgICByZW5kZXJUZXNzRGlhZygpOwogICAgICB9ZWxzZXsKICAgICAgICBzdGF0ZS5vY3JQYWdlc1twXT0iIjsKICAgICAgfQoKICAgICAgZG9uZSsrOwogICAgICAkKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPSg0NStNYXRoLnJvdW5kKGRvbmUvcGFnZU5vcy5sZW5ndGgqNTApKSsiJSI7CiAgICB9CgogICAgLy8gUmVjb21wdXRlIGRvY3VtZW50IGxhbmd1YWdlIGFmdGVyIE9DUiBzaWduYWxzIGFycml2ZS4KICAgIGNvbnN0IHZpUGFnZXM9T2JqZWN0LnZhbHVlcyhzdGF0ZS5sYW5ndWFnZUJ5UGFnZSkuZmlsdGVyKHg9PngmJngubGFuZz09PSJ2aSIpLmxlbmd0aDsKICAgIGNvbnN0IGVuUGFnZXM9T2JqZWN0LnZhbHVlcyhzdGF0ZS5sYW5ndWFnZUJ5UGFnZSkuZmlsdGVyKHg9PngmJngubGFuZz09PSJlbiIpLmxlbmd0aDsKICAgIGlmKHZpUGFnZXM+ZW5QYWdlcyoxLjQpe3N0YXRlLmRvY0xhbmc9InZpIjtzdGF0ZS5kb2NMYW5nQ29uZmlkZW5jZT0uODh9CiAgICBlbHNlIGlmKGVuUGFnZXM+dmlQYWdlcyoxLjQpe3N0YXRlLmRvY0xhbmc9ImVuIjtzdGF0ZS5kb2NMYW5nQ29uZmlkZW5jZT0uODh9CiAgICBlbHNlIGlmKHZpUGFnZXMrZW5QYWdlcyl7c3RhdGUuZG9jTGFuZz0ibWl4ZWQiO3N0YXRlLmRvY0xhbmdDb25maWRlbmNlPS42fQogICAgcmVuZGVyVGVzc0RpYWcoKTsKCiAgICByZXR1cm4gdHJ1ZTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLmVycm9yKCJPQ1IgZXJyb3IiLGUpOwogICAgc2V0RGV0ZWN0KCJkZXRPQ1IiLGZhbHNlLCJPQ1IgbOG7l2kiKTsKICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PSJPQ1Iga2jDtG5nIGNo4bqheSDEkcaw4bujYzogIitTdHJpbmcoZS5tZXNzYWdlfHxlKTsKICAgIHJldHVybiBmYWxzZTsKICB9Cn0KCmZ1bmN0aW9uIGhhc0NsYWltTWFya2VyKHQpewogIHJldHVybiAhIWNsYWltTWFya2VySW5mbyh0KTsKfQoKYXN5bmMgZnVuY3Rpb24gc21hcnRPY3JDbGFpbXMoYXV0bz1mYWxzZSl7CiAgaWYoIXN0YXRlLnBkZikgcmV0dXJuIGZhbHNlOwoKICBjb25zdCBuPXN0YXRlLnBkZi5udW1QYWdlczsKICAvLyBDbGFpbXMgY+G7p2EgYuG6sW5nIFZOIHRoxrDhu51uZyBu4bqxbSBuZ2F5IHRyxrDhu5tjIHBo4bqnbiBow6xuaCB24bq9LgogIC8vIFbhu5tpIFBERiAxNCB0cmFuZyBj4bunYSDEkGnhu4FuIFRyw7pjLCB0aOG7qSB04buxIG7DoHkgT0NSIHRyYW5nIDEyIMSQ4bqmVSBUScOKTi4KICBjb25zdCByYXdPcmRlcj1bbi0yLG4tMyxuLTEsbi00LG4sbi01LG4tNixuLTddOwogIGNvbnN0IGNhbmRpZGF0ZXM9Wy4uLm5ldyBTZXQocmF3T3JkZXIpXS5maWx0ZXIocD0+cD49MSAmJiBwPD1uKTsKCiAgc2V0RGV0ZWN0KCJkZXRPQ1IiLGZhbHNlLCLEkGFuZyBPQ1IgY2xhaW1zLi4uIik7CiAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YXV0bwogICAgPyAiUERGIGThuqFuZyBzY2FuIOKAlCDEkWFuZyB04buxIHF1w6l0IGPDoWMgdHJhbmcgY3Xhu5FpIMSR4buDIHTDrG0gWcOqdSBj4bqndSBi4bqjbyBo4buZLi4uIgogICAgOiAixJBhbmcgcXXDqXQgY8OhYyB0cmFuZyBjdeG7kWkgxJHhu4MgdMOsbSBZw6p1IGPhuqd1IGLhuqNvIGjhu5kuLi4iOwoKICBsZXQgZm91bmRQYWdlPW51bGw7CgogIGZvcihsZXQgaT0wO2k8Y2FuZGlkYXRlcy5sZW5ndGg7aSsrKXsKICAgIGNvbnN0IHA9Y2FuZGlkYXRlc1tpXTsKICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PWBPQ1IgecOqdSBj4bqndSBi4bqjbyBo4buZOiB0cmFuZyAke3B9LyR7bn0gKCR7aSsxfS8ke2NhbmRpZGF0ZXMubGVuZ3RofSkuLi5gOwoKICAgIGNvbnN0IG9rPWF3YWl0IG9jclNlbGVjdGVkUGFnZXMoW3BdLGBPQ1IgdHJhbmcgJHtwfWApOwogICAgaWYoIW9rKXsKICAgICAgLy8gT0NSIGZhaWwgdGjDrCB0aG/DoXQgc+G6oWNoLCBLSMOUTkcgdHJlbyBVSS4KICAgICAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMTAwJSI7CiAgICAgIHJldHVybiBmYWxzZTsKICAgIH0KCiAgICBjb25zdCB0PXN0YXRlLm9jclBhZ2VzW3BdfHwiIjsKICAgIGlmKGhhc0NsYWltTWFya2VyKHQpIHx8IGxvb2tzTGlrZUNsYWltUGFnZSh0KSl7CiAgICAgIGZvdW5kUGFnZT1wOwogICAgICBicmVhazsKICAgIH0KICB9CgogIGlmKCFmb3VuZFBhZ2UpewogICAgc3RhdGUucmF3VGV4dD1tZXJnZWRUZXh0KCk7CiAgICBjb25zdCBmYWxsYmFjaz1jYW5kaWRhdGVDbGFpbXNUZXh0KCk7CiAgICBzdGF0ZS5jbGFpbXNUZXh0PWZhbGxiYWNrfHwiIjsKICAgICQoImNsYWltc1JhdyIpLnZhbHVlPXN0YXRlLmNsYWltc1RleHQ7JCgiY2xhaW1zQ2xlYW4iKS52YWx1ZT1mb3JtYXRDbGFpbUZvckRpc3BsYXkoc3RhdGUuY2xhaW1zVGV4dCk7CiAgICBzdGF0ZS5jbGFpbXM9cGFyc2VDbGFpbXMoc3RhdGUuY2xhaW1zVGV4dCk7CiAgICBzdGF0ZS5zZWxlY3RlZD0wOwogICAgcmVuZGVyQ2xhaW1zKCk7CiAgICBzZXREZXRlY3QoImRldENsYWltcyIsc3RhdGUuY2xhaW1zLmxlbmd0aD4wLAogICAgICBzdGF0ZS5jbGFpbXMubGVuZ3RoP2DEkMOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW1gOiJPQ1IgeG9uZyBuaMawbmcgY2jGsGEgdMOsbSB0aOG6pXkgY2xhaW0iKTsKICAgICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjEwMCUiOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9c3RhdGUuY2xhaW1zLmxlbmd0aAogICAgICA/YE9DUiBob8OgbiB04bqldC4gxJDDoyBuaOG6rW4gZGnhu4duICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW0uYAogICAgICA6IsSQw6MgcXXDqXQgY8OhYyB0cmFuZyBjdeG7kWkgbmjGsG5nIGNoxrBhIG5o4bqtbiBkaeG7h24gxJHGsOG7o2MgY2xhaW0uIELhuqFuIHbhuqtuIGPDsyB0aOG7gyBwYXN0ZSBjbGFpbXMg4bufIGLGsOG7m2MgMi4iOwogICAgcmV0dXJuIHN0YXRlLmNsYWltcy5sZW5ndGg+MDsKICB9CgogIC8vIE9DUiB0aMOqbSAxIHRyYW5nIGvhur8gdGnhur9wIHbDrCBjbGFpbXMgY8OzIHRo4buDIGvDqW8gZMOgaSBzYW5nIHRyYW5nIHNhdS4KICBjb25zdCBmb2xsb3c9Zm91bmRQYWdlKzE7CiAgaWYoZm9sbG93PD1uICYmICFzdGF0ZS5vY3JQYWdlc1tmb2xsb3ddKXsKICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PWDEkMOjIHTDrG0gdGjhuqV5IHRyYW5nIGNsYWltcyAke2ZvdW5kUGFnZX07IMSRYW5nIGtp4buDbSB0cmEgdHJhbmcgJHtmb2xsb3d9Li4uYDsKICAgIGF3YWl0IG9jclNlbGVjdGVkUGFnZXMoW2ZvbGxvd10sYE9DUiB0cmFuZyAke2ZvbGxvd31gKTsKICB9CgogIGNvbnN0IGNsYWltUGFnZXM9W2ZvdW5kUGFnZV07CiAgaWYoZm9sbG93PD1uICYmIHN0YXRlLm9jclBhZ2VzW2ZvbGxvd10pIGNsYWltUGFnZXMucHVzaChmb2xsb3cpOwogIGNvbnN0IGpvaW5lZD1jbGFpbVBhZ2VzLm1hcChwPT5zdGF0ZS5vY3JQYWdlc1twXXx8IiIpLmpvaW4oIlxuXG4iKTsKCiAgc3RhdGUucmF3VGV4dD1tZXJnZWRUZXh0KCk7CiAgbGV0IGM9ZXh0cmFjdENsYWltc1RhaWwoam9pbmVkKTsKICBpZighYykgYz1jYW5kaWRhdGVDbGFpbXNUZXh0KCk7CiAgaWYoIWMgJiYgbG9va3NMaWtlQ2xhaW1QYWdlKGpvaW5lZCkpIGM9Y2xlYW4oam9pbmVkKTsKCiAgc3RhdGUuY2xhaW1zVGV4dD1jfHwiIjsKICAkKCJjbGFpbXNSYXciKS52YWx1ZT1zdGF0ZS5jbGFpbXNUZXh0OyQoImNsYWltc0NsZWFuIikudmFsdWU9Zm9ybWF0Q2xhaW1Gb3JEaXNwbGF5KHN0YXRlLmNsYWltc1RleHQpOwogIHN0YXRlLmNsYWltcz1wYXJzZUNsYWltcyhzdGF0ZS5jbGFpbXNUZXh0KTsKICBzdGF0ZS5zZWxlY3RlZD0wOwogIHJlbmRlckNsYWltcygpOwoKICBzZXREZXRlY3QoImRldENsYWltcyIsc3RhdGUuY2xhaW1zLmxlbmd0aD4wLAogICAgc3RhdGUuY2xhaW1zLmxlbmd0aD9gxJDDoyB0w6FjaCAke3N0YXRlLmNsYWltcy5sZW5ndGh9IGNsYWltYDoixJDDoyB0aOG6pXkgdHJhbmcgY2xhaW1zIG5oxrBuZyBwYXJzZXIgY2jGsGEgdMOhY2ggxJHGsOG7o2MiKTsKICAkKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPSIxMDAlIjsKICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1zdGF0ZS5jbGFpbXMubGVuZ3RoCiAgICA/YEhvw6BuIHThuqV0LiBUw6xtIHRo4bqleSBZw6p1IGPhuqd1IGLhuqNvIGjhu5kg4bufIHRyYW5nICR7Zm91bmRQYWdlfSB2w6AgxJHDoyB0w6FjaCAke3N0YXRlLmNsYWltcy5sZW5ndGh9IGNsYWltLmAKICAgIDpgxJDDoyB0w6xtIHRo4bqleSB0cmFuZyBZw6p1IGPhuqd1IGLhuqNvIGjhu5kgJHtmb3VuZFBhZ2V9LCBuaMawbmcgY+G6p24ga2nhu4NtIHRyYSBu4buZaSBkdW5nIOG7nyBixrDhu5tjIDIuYDsKCiAgcmV0dXJuIHN0YXRlLmNsYWltcy5sZW5ndGg+MDsKfQoKZnVuY3Rpb24gbWVyZ2VkVGV4dCgpewogIGNvbnN0IG91dD1bXTsKICBmb3IobGV0IGk9MDtpPHN0YXRlLnBhZ2VUZXh0Lmxlbmd0aDtpKyspewogICAgY29uc3QgZGlyZWN0PXN0YXRlLnBhZ2VUZXh0W2ldfHwiIjsKICAgIGNvbnN0IHE9c3RhdGUucGFnZVF1YWxpdHlbaV18fDA7CiAgICBjb25zdCBvY3I9c3RhdGUub2NyUGFnZXNbaSsxXXx8IiI7CiAgICBvdXQucHVzaChxPj00OCA/IGRpcmVjdCA6IChvY3J8fGRpcmVjdCkpOwogIH0KICByZXR1cm4gb3V0LmpvaW4oIlxuXG4iKTsKfQoKZnVuY3Rpb24gY2xhaW1DYW5kaWRhdGVTY29yZSh0ZXh0KXsKICBpZighdGV4dCkgcmV0dXJuIC05OTk7CiAgbGV0IHNjb3JlPXRleHRMYXllclF1YWxpdHlTY29yZSh0ZXh0KTsKICBpZihoYXNDbGFpbU1hcmtlcih0ZXh0KSkgc2NvcmUrPTQ1OwogIGlmKGxvb2tzTGlrZUNsYWltUGFnZSh0ZXh0KSkgc2NvcmUrPTMwOwogIGNvbnN0IHBhcnNlZD1wYXJzZUNsYWltcyhleHRyYWN0Q2xhaW1zVGFpbCh0ZXh0KXx8dGV4dCk7CiAgc2NvcmUrPU1hdGgubWluKDQwLHBhcnNlZC5sZW5ndGgqMTApOwogIGNvbnN0IGdhcmJhZ2U9KHRleHQubWF0Y2goL1xkK1xzKlwvXHMqXGQrL2cpfHxbXSkubGVuZ3RoOwogIHNjb3JlLT1nYXJiYWdlKjg7CiAgcmV0dXJuIHNjb3JlOwp9CgpmdW5jdGlvbiBjYW5kaWRhdGVDbGFpbXNUZXh0KCl7CiAgY29uc3QgY2FuZGlkYXRlcz1bXTsKCiAgLy8gMSkgxq91IHRpw6puIHRleHQgbGF5ZXIgc+G6oWNoLiBLSMOUTkcgZMO5bmcgYuG6o24gbGVmdC9yaWdodCBnaMOpcCDEkcO0aSBu4bq/dSBraMO0bmcgY+G6p24uCiAgZm9yKGxldCBpPTA7aTxzdGF0ZS5wYWdlVGV4dC5sZW5ndGg7aSsrKXsKICAgIGNvbnN0IHNyYz1zdGF0ZS5wYWdlVGV4dFtpXXx8IiI7CiAgICBjb25zdCBxPXN0YXRlLnBhZ2VRdWFsaXR5W2ldfHwwOwogICAgaWYocTw0OCkgY29udGludWU7CgogICAgaWYoaGFzQ2xhaW1NYXJrZXIoc3JjKXx8bG9va3NMaWtlQ2xhaW1QYWdlKHNyYykpewogICAgICBjb25zdCBqb2luZWQ9W3NyY107CiAgICAgIGZvcihsZXQgaj1pKzE7ajxNYXRoLm1pbihzdGF0ZS5wYWdlVGV4dC5sZW5ndGgsaSs1KTtqKyspewogICAgICAgIGlmKChzdGF0ZS5wYWdlUXVhbGl0eVtqXXx8MCk+PTQ4KSBqb2luZWQucHVzaChzdGF0ZS5wYWdlVGV4dFtqXSk7CiAgICAgIH0KICAgICAgY29uc3QgYmxvY2s9am9pbmVkLmpvaW4oIlxuXG4iKTsKICAgICAgY29uc3QgdGFpbD1leHRyYWN0Q2xhaW1zVGFpbChibG9jayl8fGJsb2NrOwogICAgICBjYW5kaWRhdGVzLnB1c2goe3RleHQ6dGFpbCxzY29yZTpjbGFpbUNhbmRpZGF0ZVNjb3JlKHRhaWwpKzI1fSk7CiAgICB9CiAgfQoKICAvLyAyKSBPQ1IgcGFnZXMuCiAgZm9yKGNvbnN0IHNyYyBvZiBPYmplY3QudmFsdWVzKHN0YXRlLm9jclBhZ2VzKSl7CiAgICBpZighc3JjKSBjb250aW51ZTsKICAgIGNvbnN0IHRhaWw9ZXh0cmFjdENsYWltc1RhaWwoc3JjKXx8c3JjOwogICAgY2FuZGlkYXRlcy5wdXNoKHt0ZXh0OnRhaWwsc2NvcmU6Y2xhaW1DYW5kaWRhdGVTY29yZSh0YWlsKX0pOwogIH0KCiAgLy8gMykgQ29sdW1uIHJlY29uc3RydWN0aW9uIG9ubHkgYXMgYSBsYXN0IHJlc29ydC4KICBpZighY2FuZGlkYXRlcy5sZW5ndGgpewogICAgZm9yKGNvbnN0IHNyYyBvZiBzdGF0ZS5wYWdlQ29sdW1uVGV4dCl7CiAgICAgIGlmKCFzcmMpIGNvbnRpbnVlOwogICAgICBjb25zdCB0YWlsPWV4dHJhY3RDbGFpbXNUYWlsKHNyYyk7CiAgICAgIGlmKHRhaWwpIGNhbmRpZGF0ZXMucHVzaCh7dGV4dDp0YWlsLHNjb3JlOmNsYWltQ2FuZGlkYXRlU2NvcmUodGFpbCktMjB9KTsKICAgIH0KICB9CgogIGNhbmRpZGF0ZXMuc29ydCgoYSxiKT0+Yi5zY29yZS1hLnNjb3JlKTsKICBjb25zdCBiZXN0PWNhbmRpZGF0ZXNbMF07CiAgcmV0dXJuIGJlc3QmJmJlc3Quc2NvcmU+PTQ1ID8gYmVzdC50ZXh0LnNsaWNlKDAsODAwMDApIDogIiI7Cn0KCmZ1bmN0aW9uIHBhcnNlQ2xhaW1zKHRleHQpewogIGxldCB0PXRydW5jYXRlQ2xhaW1BdEZpZ3VyZShyZXBhaXJDZXJ0YWluVm5PY3IodGV4dHx8IiIpKS5yZXBsYWNlKC9cci9nLCJcbiIpOwoKICAvLyBPQ1IgdGjGsOG7nW5nIGNobzogIjEgLiIsICIxKSIsICIxICkiLCBob+G6t2MgeHXhu5FuZyBkw7JuZyB0csaw4bubYyBz4buRLgogIHQ9dC5yZXBsYWNlKC8oPzpefFxuKVxzKihcZHsxLDJ9KVxzKltcLlwpXVxzKi9nLCJcbiQxLiAiKTsKCiAgbGV0IG1hdGNoZXM9Wy4uLnQubWF0Y2hBbGwoLyg/Ol58XG4pXHMqKFxkezEsMn0pXC5ccyooW1xzXFNdKj8pKD89KD86XG5ccypcZHsxLDJ9XC5ccyopfCQpL2cpXTsKICBsZXQgYXJyPW1hdGNoZXMKICAgIC5tYXAobT0+KHtpZDorbVsxXSx0ZXh0OmNsZWFuKG1bMl0pfSkpCiAgICAuZmlsdGVyKHg9PngudGV4dC5sZW5ndGg+MTUpOwoKICAvLyBGYWxsYmFjayBkw6BuaCBjaG8gT0NSIGzDoG0gbeG6pXQgZOG6pXUgIi4iIHNhdSBz4buRIGNsYWltLgogIGlmKCFhcnIubGVuZ3RoKXsKICAgIGNvbnN0IGY9Zm9sZFZOKHQpOwogICAgY29uc3QgZmlyc3Q9Zi5zZWFyY2goLyg/Ol58XG58XHMpMVxzKyhRVVkgVFJJTkh8UEhVT05HIFBIQVB8U0FOIFBIQU18VEhJRVQgQkl8SEUgVEhPTkd8Q0hFIFBIQU18QVxzfEFOXHN8VEhFXHMpLyk7CiAgICBpZihmaXJzdD49MCl7CiAgICAgIGNvbnN0IGJvZHk9Y2xlYW4odC5zbGljZShmaXJzdCkpOwogICAgICBhcnI9W3tpZDoxLHRleHQ6Ym9keS5yZXBsYWNlKC9eXHMqMVxzKi8sIiIpfV07CiAgICB9CiAgfQoKICBhcnI9YXJyCiAgICAuZmlsdGVyKCh4LGksYSk9PmEuZmluZEluZGV4KHk9PnkuaWQ9PT14LmlkKT09PWkpCiAgICAuc29ydCgoYSxiKT0+YS5pZC1iLmlkKQogICAgLnNsaWNlKDAsNjApOwoKICByZXR1cm4gYXJyLm1hcCgoYyxpKT0+KHsKICAgIC4uLmMsCiAgICB0eXBlOi9hY2NvcmRpbmcgdG8gY2xhaW1ccytcZCt8dGhlbyAoPzrEkWnhu4NtfHnDqnUgY+G6p3UgYuG6o28gaOG7mXxjbGFpbSlccypcZCsvaS50ZXN0KGMudGV4dCkKICAgICAgPyJQaOG7pSB0aHXhu5ljIgogICAgICA6KGk9PT0wPyLEkOG7mWMgbOG6rXAiOiJDaMawYSB4w6FjIMSR4buLbmgiKQogIH0pKTsKfQpmdW5jdGlvbiBndWVzc0p1cih0ZXh0LG5vKXsKIGlmKC9D4bukQyBT4bueIEjhu65VIFRSw40gVFXhu4Z8Q+G7mW5nIGjDsmEgeMOjIGjhu5lpIGNo4bunIG5naMSpYSBWaeG7h3QgTmFtL2kudGVzdCh0ZXh0KXx8L15bMTJdLVxkezUsfS8udGVzdChubykpcmV0dXJuIlZOIjsKIGlmKC9Vbml0ZWQgU3RhdGVzIFBhdGVudHxVXC5TXC4gUGF0ZW50L2kudGVzdCh0ZXh0KXx8L15VUy9pLnRlc3Qobm8pKXJldHVybiJVUyI7CiBpZigvXldPL2kudGVzdChubykpcmV0dXJuIldPL1BDVCI7aWYoL15FUC9pLnRlc3Qobm8pKXJldHVybiJFUCI7cmV0dXJuIktow6FjIjsKfQpmdW5jdGlvbiB0YWdnZWRGaWVsZCh0ZXh0LHRhZyxtYXhMZW49NTAwKXsKICBjb25zdCB0PXN0cmlwUGRmQXJ0aWZhY3RzKHRleHR8fCIiKTsKICBjb25zdCByZT1uZXcgUmVnRXhwKCJcXFxcKCIrdGFnKyJcXFxcKVxcXFxzKihbXFxcXHNcXFxcU117MSwiK21heExlbisifT8pKD89XFxcXChcXFxcZHsyfVxcXFwpfCQpIiwiaSIpOwogIGNvbnN0IG09dC5tYXRjaChyZSk7CiAgcmV0dXJuIG0/Y2xlYW5NZXRhVmFsdWUobVsxXSk6IiI7Cn0KCmZ1bmN0aW9uIGV4dHJhY3RNZXRhZGF0YSh0ZXh0KXsKICBjb25zdCB0PXN0cmlwUGRmQXJ0aWZhY3RzKHRleHR8fCIiKTsKICBjb25zdCBubz1maXJzdE1hdGNoKHQsWwogICAgL1woMTFcKVxzKihbMTJdLVxkezUsOH0pL2ksCiAgICAvXGIoWzEyXS1cZHs2LDh9KVxiL2ksCiAgICAvXGJQYXRlbnRccypOb1wuP1xzKjo/XHMqKFVTXHMqW1xkLF0rXHMqW0FCXVxkKVxiL2ksCiAgICAvXGIoVVNccz9cZHs3LDExfVxzP1tBQl1cZClcYi9pLAogICAgL1xiKFdPXHM/XGR7NH1cL1xkezUsN31ccz9bQS1aXVxkPylcYi9pCiAgXSkucmVwbGFjZSgvXHMrL2csIiAiKTsKCiAgbGV0IHRpdGxlPXRhZ2dlZEZpZWxkKHQsIjU0IiwzNTApIHx8IGZpcnN0TWF0Y2godCxbL1RpdGxlXHMqOj9ccyooW15cbl17NSwyNTB9KS9pXSk7CiAgdGl0bGU9c2FuaXRpemVQYXRlbnRUaXRsZSh0aXRsZSk7CgogIGxldCBmaWxpbmc9dGFnZ2VkRmllbGQodCwiMjIiLDgwKSB8fCBmaXJzdE1hdGNoKHQsWy9GaWxlZFxzKjo/XHMqKFtBLVphLXpdezMsOX1cLj9ccytcZHsxLDJ9LFxzK1xkezR9KS9pXSk7CiAgZmlsaW5nPW5vcm1EYXRlKGZpbGluZyk7CgogIGNvbnN0IGFwcGxpY2FudD1jbGVhbk1ldGFWYWx1ZSgKICAgIHRhZ2dlZEZpZWxkKHQsIjczIiw1MDApIHx8CiAgICB0YWdnZWRGaWVsZCh0LCI3MSIsNTAwKSB8fAogICAgZmlyc3RNYXRjaCh0LFsvQXNzaWduZWVccyo6P1xzKihbXlxuXXszLDI1MH0pL2ksL0FwcGxpY2FudFxzKjo/XHMqKFteXG5dezMsMjUwfSkvaV0pCiAgKTsKCiAgY29uc3QgcmVwPWNsZWFuTWV0YVZhbHVlKAogICAgdGFnZ2VkRmllbGQodCwiNzQiLDQwMCkgfHwKICAgIGZpcnN0TWF0Y2godCxbL1JlcHJlc2VudGF0aXZlXHMqOj9ccyooW15cbl17MywyNTB9KS9pXSkKICApOwoKICBjb25zdCBpcGM9Y2xlYW5NZXRhVmFsdWUoCiAgICB0YWdnZWRGaWVsZCh0LCI1MSIsMzUwKSB8fAogICAgZmlyc3RNYXRjaCh0LFsvSW50XC5ccypDbFwuP1xzKjo/XHMqKFteXG5dezUsMjIwfSkvaV0pCiAgKTsKCiAgbGV0IGFicz10YWdnZWRGaWVsZCh0LCI1NyIsMTgwMCkgfHwKICAgIGZpcnN0TWF0Y2godCxbL0FCU1RSQUNUXHMqKFtcc1xTXXs0MCwxNTAwfT8pKD89RklFTEQgT0Z8QkFDS0dST1VORHxDTEFJTVM/KS9pXSk7CiAgYWJzPWNsZWFuTWV0YVZhbHVlKGFicykuc2xpY2UoMCwxODAwKTsKCiAgcmV0dXJue25vLHRpdGxlLGZpbGluZyxhcHBsaWNhbnQscmVwLGlwYyxhYnMsanVyOmd1ZXNzSnVyKHQsbm8pfQp9CgpmdW5jdGlvbiBmaWxsTWV0YShtKXsKICQoInBhdGVudE5vIikudmFsdWU9bS5ubzskKCJ0aXRsZSIpLnZhbHVlPW0udGl0bGU7JCgiZmlsaW5nRGF0ZSIpLnZhbHVlPW0uZmlsaW5nOyQoImFwcGxpY2FudCIpLnZhbHVlPW0uYXBwbGljYW50OyQoInJlcHJlc2VudGF0aXZlIikudmFsdWU9bS5yZXA7JCgiaXBjIikudmFsdWU9bS5pcGM7JCgiYWJzdHJhY3QiKS52YWx1ZT1tLmFiczsKIFsuLi4kKCJqdXJpc2RpY3Rpb24iKS5vcHRpb25zXS5mb3JFYWNoKChvLGkpPT57aWYoby52YWx1ZT09PW0uanVyKSQoImp1cmlzZGljdGlvbiIpLnNlbGVjdGVkSW5kZXg9aX0pOwogY29uc3QgYmFzZT0obS5ub3x8IlBBVCIpLnJlcGxhY2UoL1xzL2csIiIpLnJlcGxhY2UoL1teQS1aYS16MC05LV0vZywiIik7JCgiY2FzZUlkIikudmFsdWU9KG0uanVyfHwiQ0FTRSIpKyItIitiYXNlOyQoImNhc2VCYWRnZSIpLnRleHRDb250ZW50PSQoImNhc2VJZCIpLnZhbHVlOwogc2V0RGV0ZWN0KCJkZXRNZXRhIiwhIShtLm5vfHxtLnRpdGxlKSxtLm5vfHxtLnRpdGxlPyLEkMOjIG5o4bqtbiBkaeG7h24iOiJD4bqnbiBraeG7g20gdHJhIik7CiBzZXREZXRlY3QoImRldEFic3RyYWN0IiwhIW0uYWJzLG0uYWJzPyLEkMOjIG5o4bqtbiBkaeG7h24iOiJDaMawYSB0w6xtIHRo4bqleSIpOwp9CmFzeW5jIGZ1bmN0aW9uIHByb2Nlc3NGaWxlKGZpbGUpewogIHN0YXRlLm9jclBhZ2VzPXt9OwogIHN0YXRlLmNsYWltcz1bXTsKICBzdGF0ZS5jbGFpbXNUZXh0PSIiOwogIHN0YXRlLmZlYXR1cmVzPVtdOwogIHN0YXRlLnNlYXJjaD1bXTsKICBzdGF0ZS5xdWVyaWVzPVtdOwogIHN0YXRlLnByaW9yPXt9OwogIHN0YXRlLm1hdHJpeD1bXTsKICAkKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPSIzJSI7CiAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9IsSQYW5nIG3hu58gUERGLi4uIjsKCiAgdHJ5ewogICAgYXdhaXQgcmVhZFBkZihmaWxlKTsKICAgIHJlbmRlclRlc3NEaWFnKCk7CiAgfWNhdGNoKGUpewogICAgY29uc29sZS5lcnJvcihlKTsKICAgICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjEwMCUiOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9Iktow7RuZyB0aOG7gyBt4bufIFBERjogIisoZSYmZS5tZXNzYWdlP2UubWVzc2FnZTplKTsKICAgIGFsZXJ0KCJLaMO0bmcgdGjhu4MgbeG7nyBmaWxlIFBERiBuw6B5LiIpOwogICAgcmV0dXJuOwogIH0KCiAgY29uc3QgcT10ZXh0UXVhbGl0eSgpOwogIGxldCBjb21iaW5lZD1tZXJnZWRUZXh0KCk7CiAgc3RhdGUucmF3VGV4dD1jb21iaW5lZDsKCiAgLy8gTWV0YWRhdGEgY2jhu4kgbOG6pXkgdOG7qyB0cmFuZyDEkeG6p3UgxJHhu4MgdHLDoW5oIGZvb3Rlci9wYWdlIGNvdW50ZXIgY+G7p2EgdG/DoG4gdMOgaSBsaeG7h3UgY2h1aSB2w6BvIHRpdGxlLgogIGxldCBmaXJzdD1zdGF0ZS5wYWdlVGV4dFswXXx8IiI7CiAgbGV0IGZpcnN0UXVhbGl0eT1zdGF0ZS5wYWdlUXVhbGl0eVswXXx8MDsKICBsZXQgbWV0YT17fTsKCiAgaWYoZmlyc3RRdWFsaXR5Pj00OCl7CiAgICB0cnl7CiAgICAgIG1ldGE9ZXh0cmFjdE1ldGFkYXRhKGZpcnN0KTsKICAgICAgZmlsbE1ldGEobWV0YSk7CiAgICAgIHNldERldGVjdCgiZGV0T0NSIix0cnVlLCJLaMO0bmcgY+G6p24gT0NSIMK3IHRleHQgbGF5ZXIgdOG7kXQiKTsKICAgIH1jYXRjaChlKXtjb25zb2xlLndhcm4oIk1ldGFkYXRhIHRleHQtbGF5ZXIgZXJyb3IiLGUpfQogIH0KCiAgLy8gTuG6v3UgdGV4dCBsYXllciB0cmFuZyDEkeG6p3Uga8OpbSBob+G6t2MgbWV0YWRhdGEgY8OybiB0aGnhur91LCBPQ1IgxJHDum5nIHRyYW5nIMSR4bqndS4KICBpZihmaXJzdFF1YWxpdHk8NDggfHwgIW1ldGEubm8gfHwgIW1ldGEudGl0bGUpewogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9IlRleHQgbGF5ZXIgY8OzIGThuqV1IGhp4buHdSBs4buXaSBtw6MvZm9udCDigJQgxJFhbmcgT0NSIHRyYW5nIMSR4bqndS4uLiI7CiAgICBjb25zdCBva01ldGE9YXdhaXQgb2NyU2VsZWN0ZWRQYWdlcyhbMV0sIk9DUiBtZXRhZGF0YSIpOwogICAgaWYob2tNZXRhICYmIHN0YXRlLm9jclBhZ2VzWzFdKXsKICAgICAgdHJ5ewogICAgICAgIGNvbnN0IG9jck1ldGE9ZXh0cmFjdE1ldGFkYXRhKHN0YXRlLm9jclBhZ2VzWzFdKTsKICAgICAgICAvLyBDaOG7iSB0aGF5IGLhurFuZyBPQ1IgbuG6v3UgT0NSIHTDrG0gxJHGsOG7o2MgdHLGsOG7nW5nIHThu5F0IGjGoW4uCiAgICAgICAgbWV0YT17CiAgICAgICAgICAuLi5tZXRhLAogICAgICAgICAgbm86b2NyTWV0YS5ub3x8bWV0YS5ub3x8IiIsCiAgICAgICAgICB0aXRsZTpvY3JNZXRhLnRpdGxlfHxtZXRhLnRpdGxlfHwiIiwKICAgICAgICAgIGZpbGluZzpvY3JNZXRhLmZpbGluZ3x8bWV0YS5maWxpbmd8fCIiLAogICAgICAgICAgYXBwbGljYW50Om9jck1ldGEuYXBwbGljYW50fHxtZXRhLmFwcGxpY2FudHx8IiIsCiAgICAgICAgICByZXA6b2NyTWV0YS5yZXB8fG1ldGEucmVwfHwiIiwKICAgICAgICAgIGlwYzpvY3JNZXRhLmlwY3x8bWV0YS5pcGN8fCIiLAogICAgICAgICAgYWJzOm9jck1ldGEuYWJzfHxtZXRhLmFic3x8IiIsCiAgICAgICAgICBqdXI6b2NyTWV0YS5qdXJ8fG1ldGEuanVyfHwiVk4iCiAgICAgICAgfTsKICAgICAgICBmaWxsTWV0YShtZXRhKTsKICAgICAgfWNhdGNoKGUpe2NvbnNvbGUud2FybigiT0NSIG1ldGFkYXRhIHBhcnNlIGVycm9yIixlKX0KICAgIH0KICB9CgogIC8vIENsYWltczogZGlyZWN0IHRleHQgbGF5ZXIgZmlyc3QgaWYgY2xlYW4uCiAgbGV0IGNsYWltcz0iIjsKICB0cnl7Y2xhaW1zPWNhbmRpZGF0ZUNsYWltc1RleHQoKX1jYXRjaChlKXtjb25zb2xlLndhcm4oZSl9CgogIGlmKGNsYWltcyAmJiBjbGFpbUNhbmRpZGF0ZVNjb3JlKGNsYWltcyk+PTQ1KXsKICAgIHN0YXRlLmNsYWltc1RleHQ9c3RyaXBQZGZBcnRpZmFjdHMoY2xhaW1zKTsKICAgICQoImNsYWltc1JhdyIpLnZhbHVlPXN0YXRlLmNsYWltc1RleHQ7CiAgICAkKCJjbGFpbXNDbGVhbiIpLnZhbHVlPWZvcm1hdENsYWltRm9yRGlzcGxheShzdGF0ZS5jbGFpbXNUZXh0KTsKICAgIHN0YXRlLmNsYWltcz1wYXJzZUNsYWltcyhzdGF0ZS5jbGFpbXNUZXh0KTsKICAgIHN0YXRlLnNlbGVjdGVkPTA7CiAgICByZW5kZXJDbGFpbXMoKTsKICB9CgogIC8vIE7hur91IGNsYWltIHbhuqtuIGtow7RuZyDEkeG7pyB0aW4gY+G6rXksIE9DUiBjaOG7iSBjw6FjIHRyYW5nIGN14buRaS4KICBpZighc3RhdGUuY2xhaW1zLmxlbmd0aCl7CiAgICBhd2FpdCBzbWFydE9jckNsYWltcyh0cnVlKTsKICB9CgogIHN0YXRlLnJhd1RleHQ9bWVyZ2VkVGV4dCgpOwogICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjEwMCUiOwoKICBpZihzdGF0ZS5jbGFpbXMubGVuZ3RoKXsKICAgIHNldERldGVjdCgiZGV0Q2xhaW1zIix0cnVlLGDEkMOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW1gKTsKICAgIGNvbnN0IG1vZGU9c3RhdGUuYmFkVGV4dFBhZ2VzLmxlbmd0aAogICAgICA/YEPDsyAke3N0YXRlLmJhZFRleHRQYWdlcy5sZW5ndGh9IHRyYW5nIHRleHQgbGF5ZXIga8OpbTsgxJHDoyB04buxIGTDuW5nIE9DUiBraGkgY+G6p24uYAogICAgICA6YMSQ4buNYyB0cuG7sWMgdGnhur9wIHRleHQgbGF5ZXIgwrcgJHtsYW5ndWFnZUxhYmVsKHN0YXRlLmRvY0xhbmcpfSDCtyBVbmljb2RlIE5GQy5gOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YEhvw6BuIHThuqV0LiAke21vZGV9YDsKICB9ZWxzZXsKICAgIHNldERldGVjdCgiZGV0Q2xhaW1zIixmYWxzZSwiQ2jGsGEgdOG7sSB0w6FjaCDEkcaw4bujYyBjbGFpbSIpOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9IsSQw6MgeOG7rSBsw70gUERGIG5oxrBuZyBjaMawYSB0w6FjaCDEkcaw4bujYyBjbGFpbS4gS2nhu4NtIHRyYSBixrDhu5tjIDIuIjsKICB9Cn0KJCgicGRmSW5wdXQiKS5vbmNoYW5nZT1lPT57aWYoZS50YXJnZXQuZmlsZXNbMF0pcHJvY2Vzc0ZpbGUoZS50YXJnZXQuZmlsZXNbMF0pfTsKY29uc3QgZHo9JCgiZHJvcFpvbmUiKTtbImRyYWdlbnRlciIsImRyYWdvdmVyIl0uZm9yRWFjaChldj0+ZHouYWRkRXZlbnRMaXN0ZW5lcihldixlPT57ZS5wcmV2ZW50RGVmYXVsdCgpO2R6LmNsYXNzTGlzdC5hZGQoImRyYWciKX0pKTtbImRyYWdsZWF2ZSIsImRyb3AiXS5mb3JFYWNoKGV2PT5kei5hZGRFdmVudExpc3RlbmVyKGV2LGU9PntlLnByZXZlbnREZWZhdWx0KCk7ZHouY2xhc3NMaXN0LnJlbW92ZSgiZHJhZyIpfSkpO2R6LmFkZEV2ZW50TGlzdGVuZXIoImRyb3AiLGU9PntsZXQgZj1lLmRhdGFUcmFuc2Zlci5maWxlc1swXTtpZihmKXByb2Nlc3NGaWxlKGYpfSk7CiQoInJldHJ5T0NSIikub25jbGljaz1hc3luYygpPT57aWYoIXN0YXRlLnBkZilyZXR1cm4gYWxlcnQoIkNoxrBhIGPDsyBQREYuIik7c3RhdGUub2NyUGFnZXM9e307c3RhdGUuY2xhaW1Tb3VyY2VCeVBhZ2U9e307b2NyV29ya2VyUHJvbWlzZT1udWxsO2F3YWl0IHNtYXJ0T2NyQ2xhaW1zKGZhbHNlKX07CiQoIm9jckNsYWltc0FnYWluIikub25jbGljaz1hc3luYygpPT57aWYoIXN0YXRlLnBkZilyZXR1cm4gYWxlcnQoIkNoxrBhIGPDsyBQREYuIik7c3RhdGUub2NyUGFnZXM9e307c3RhdGUuY2xhaW1Tb3VyY2VCeVBhZ2U9e307b2NyV29ya2VyUHJvbWlzZT1udWxsO2F3YWl0IHNtYXJ0T2NyQ2xhaW1zKGZhbHNlKX07CgpmdW5jdGlvbiByZW5kZXJDbGFpbXMoKXsKICQoImNsYWltU2VsZWN0IikuaW5uZXJIVE1MPXN0YXRlLmNsYWltcy5tYXAoKGMsaSk9PmA8b3B0aW9uIHZhbHVlPSIke2l9Ij5DbGFpbSAke2MuaWR9IMK3ICR7Yy50eXBlfTwvb3B0aW9uPmApLmpvaW4oIiIpOwogaWYoIXN0YXRlLmNsYWltcy5sZW5ndGgpewogICAkKCJjbGFpbUxpc3QiKS5jbGFzc05hbWU9ImVtcHR5IjsKICAgJCgiY2xhaW1MaXN0IikuaW5uZXJIVE1MPSJDaMawYSBjw7MgY2xhaW0uIjsKICAgcmV0dXJuOwogfQogJCgiY2xhaW1MaXN0IikuY2xhc3NOYW1lPSIiOwogJCgiY2xhaW1MaXN0IikuaW5uZXJIVE1MPXN0YXRlLmNsYWltcy5tYXAoKGMsaSk9PnsKICAgY29uc3QgcHJldHR5PWVzYyhmb3JtYXRDbGFpbUZvckRpc3BsYXkoYy50ZXh0KSkucmVwbGFjZSgvXG4vZywiPGJyPiIpOwogICByZXR1cm4gYDxkaXYgY2xhc3M9ImNsYWltIj4KICAgICAgPGg0PkNsYWltICR7Yy5pZH0gPHNwYW4gY2xhc3M9InBpbGwgJHtjLnR5cGU9PT0ixJDhu5ljIGzhuq1wIj8iYmx1ZSI6IiJ9Ij4ke2MudHlwZX08L3NwYW4+PC9oND4KICAgICAgPGRpdiBjbGFzcz0iY2xhaW0tY2xlYW4iPiR7cHJldHR5fTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIj48YnV0dG9uIGNsYXNzPSJidG4gJHtpPT09c3RhdGUuc2VsZWN0ZWQ/InN1Y2Nlc3MiOiIifSIgZGF0YS1jbGFpbT0iJHtpfSI+JHtpPT09c3RhdGUuc2VsZWN0ZWQ/IsSQYW5nIGNo4buNbiI6IkNo4buNbiBjbGFpbSBuw6B5In08L2J1dHRvbj48L2Rpdj4KICAgPC9kaXY+YDsKIH0pLmpvaW4oIiIpOwogZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtY2xhaW1dIikuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9PnsKICAgc3RhdGUuc2VsZWN0ZWQ9K2IuZGF0YXNldC5jbGFpbTsKICAgJCgiY2xhaW1TZWxlY3QiKS52YWx1ZT1zdGF0ZS5zZWxlY3RlZDsKICAgcmVuZGVyQ2xhaW1zKCk7CiB9KTsKfQokKCJwYXJzZUNsYWltcyIpLm9uY2xpY2s9KCk9PnsKICAgICAgY29uc3Qgc291cmNlPSQoImNsYWltc0NsZWFuIikudmFsdWV8fCQoImNsYWltc1JhdyIpLnZhbHVlOwogICAgICBzdGF0ZS5jbGFpbXNUZXh0PW5vcm1hbGl6ZU9jclRleHQoc291cmNlKTsKICAgICAgJCgiY2xhaW1zQ2xlYW4iKS52YWx1ZT1mb3JtYXRDbGFpbUZvckRpc3BsYXkoc3RhdGUuY2xhaW1zVGV4dCk7CiAgICAgICQoImNsYWltc1JhdyIpLnZhbHVlPXN0YXRlLmNsYWltc1RleHQ7CiAgICAgIHN0YXRlLmNsYWltcz1wYXJzZUNsYWltcyhzdGF0ZS5jbGFpbXNUZXh0KTsKICAgICAgc3RhdGUuc2VsZWN0ZWQ9MDsKICAgICAgcmVuZGVyQ2xhaW1zKCk7CiAgICAgIHNldERldGVjdCgiZGV0Q2xhaW1zIixzdGF0ZS5jbGFpbXMubGVuZ3RoPjAsc3RhdGUuY2xhaW1zLmxlbmd0aD9gxJDDoyB0w6FjaCAke3N0YXRlLmNsYWltcy5sZW5ndGh9IGNsYWltYDoiQ2jGsGEgdMOsbSB0aOG6pXkgY2xhaW0iKTsKICAgIH07CgpmdW5jdGlvbiBmZWF0dXJlU3BsaXQodGV4dCl7CiAgbGV0IHQ9bm9ybWFsaXplT2NyVGV4dCh0ZXh0fHwiIikKICAgIC5yZXBsYWNlKC9eXHMqKD86YXxhbnx0aGUpP1xzKig/OnF1eSB0csOsbmh8cGjGsMahbmcgcGjDoXB8bWV0aG9kfHByb2Nlc3N8Y29tcG9zaXRpb258ZGV2aWNlfHN5c3RlbSlbXjpdezAsMjIwfSg/OmJhbyBn4buTbXxjb21wcmlzaW5nfGNvbXByaXNlcylccyo6P1xzKi9pLCIiKTsKCiAgY29uc3QgY29ubmVjdG9ycz0vXGIoPzpzYXUgxJHDs3x0aeG6v3AgdGhlb3xr4bq/IHRp4bq/cHx0cm9uZyDEkcOzfMSR4buTbmcgdGjhu51pfHRo4buxYyBoaeG7h258xJHGsOG7o2MgdGjhu7FjIGhp4buHbnx3aGVyZWlufHRoZW58c3Vic2VxdWVudGx5KVxiL2lnOwogIGxldCBzZWc9W107CiAgY29uc3Qgcm9tYW49Wy4uLnQubWF0Y2hBbGwoL1woKGl7MSwzfXxpdnx2fHZpezAsM318aXh8eHx4aXswLDN9fHhpdnx4dnx4dml7MCwzfSlcKVxzKi9pZyldOwoKICBpZihyb21hbi5sZW5ndGg+PTIpewogICAgZm9yKGxldCBpPTA7aTxyb21hbi5sZW5ndGg7aSsrKXsKICAgICAgY29uc3QgYT1yb21hbltpXS5pbmRleCtyb21hbltpXVswXS5sZW5ndGg7CiAgICAgIGNvbnN0IGI9aSsxPHJvbWFuLmxlbmd0aD9yb21hbltpKzFdLmluZGV4OnQubGVuZ3RoOwogICAgICBjb25zdCBzPWNsZWFuKHQuc2xpY2UoYSxiKSkucmVwbGFjZSgvWzssXSskLywiIik7CiAgICAgIGlmKHMubGVuZ3RoPjE4KSBzZWcucHVzaChzKTsKICAgIH0KICB9ZWxzZXsKICAgIHNlZz10CiAgICAgIC5yZXBsYWNlKGNvbm5lY3RvcnMsIjsgIikKICAgICAgLnNwbGl0KC87XHMrfFxuKD89XHMqKD86XGQrW1wuXCldfFwtfFzigKIpKS8pCiAgICAgIC5tYXAoY2xlYW4pCiAgICAgIC5maWx0ZXIoeD0+eC5sZW5ndGg+MTgpOwogIH0KCiAgLy8gR+G7mXAgY8OhYyBt4bqjbmggcXXDoSBuZ+G6r24gxJHhu4MgdHLDoW5oIGZlYXR1cmUga2nhu4N1ICI1MywyJSB0aW5oIi4KICBjb25zdCBtZXJnZWQ9W107CiAgZm9yKGNvbnN0IHMgb2Ygc2VnKXsKICAgIGlmKG1lcmdlZC5sZW5ndGggJiYgKHMuc3BsaXQoL1xzKy8pLmxlbmd0aDw0IHx8IHMubGVuZ3RoPDI4KSl7CiAgICAgIG1lcmdlZFttZXJnZWQubGVuZ3RoLTFdKz0iOyAiK3M7CiAgICB9ZWxzZSBtZXJnZWQucHVzaChzKTsKICB9CgogIHJldHVybiBtZXJnZWQuc2xpY2UoMCwzMCkubWFwKCh4LGkpPT57CiAgICBjb25zdCBmPWZvbGRWTih4KTsKICAgIGxldCB0eXBlPSJRdXkgdHLDrG5oIjsKICAgIGlmKC9cYihFTlpZTUV8Qk9UfFRIQU5IIFBIQU58VFkgTEV8TkdVWUVOIExJRVV8RVhUUkFDVHxPSUx8Q09NUE9TSVRJT058QUNJRHxQT0xZTUVSfEhPUCBDSEFUKVxiLy50ZXN0KGYpKSB0eXBlPSJUaMOgbmggcGjhuqduL05ndXnDqm4gbGnhu4d1IjsKICAgIGVsc2UgaWYoL1xiKEtJRU0gVFJBfFhBQyBESU5IfERPIExVT05HfENIRUNLfERFVEVSTUlOfE1FQVNVUkV8UEh8RE8gQU18TkhJRVQgRE8pXGIvLnRlc3QoZikpIHR5cGU9Iktp4buDbSBzb8OhdCI7CiAgICBlbHNlIGlmKC9cYihDSEFNQkVSfFBVTVB8VFVCRXxBUFBBUkFUVVN8REVWSUNFfFNZU1RFTXxUSElFVCBCSXxCTyBQSEFOfENBVSBUUlVDKVxiLy50ZXN0KGYpKSB0eXBlPSJUaGnhur90IGLhu4svQ+G6pXUgdHLDumMiOwogICAgY29uc3Qgd29yZHM9eC5zcGxpdCgvXHMrLykubGVuZ3RoOwogICAgY29uc3QgY29uZj13b3Jkcz49NyYmd29yZHM8PTQwPyJDYW8iOndvcmRzPj00PyJUcnVuZyBiw6xuaCI6IlRo4bqlcCI7CiAgICByZXR1cm4ge2lkOmBGJHtTdHJpbmcoaSsxKS5wYWRTdGFydCgyLCIwIil9YCx0ZXh0OngsdHlwZSxjb25mfTsKICB9KTsKfQoKY29uc3QgU0VBUkNIX1NUT1A9bmV3IFNldChbCiAgInZhIiwiaG9hYyIsImN1YSIsImNobyIsInZvaSIsInRyb25nIiwibmdvYWkiLCJ0cmVuIiwiZHVvaSIsInR1IiwiZGVuIiwidGFpIiwidGhlbyIsInNhdSIsInRydW9jIiwiZG8iLCJuYXkiLCJtb3QiLCJjYWMiLCJuaHVuZyIsCiAgImR1b2MiLCJ0aHVjIiwiaGllbiIsInRhbyIsImhvbiIsImhvcCIsImR1bmciLCJkaWNoIiwicGhvaSIsInRyb24iLCJ0aHUiLCJ0dSIsIm9uIiwiZGluaCIsImRvbmciLCJ0aG9pIiwidGllcCIsImJhbyIsImdvbSIsImJ1b2MiLAogICJxdXkiLCJ0cmluaCIsInBodW9uZyIsInBoYXAiLCJzYW4iLCJwaGFtIiwiaGUiLCJ0aG9uZyIsInRoaWV0IiwiYmkiLCJuaGF0IiwiYmFuZyIsImNhY2giLCJzdSIsImR1bmciLCJuaGFtIiwiZGUiLCJraGkiLCJuZXUiLCJjbyIsCiAgInRoZSIsImxhIiwibGFtIiwicGhhbiIsInZhbyIsInJhIiwiZ2l1YSIsIm1vdCIsImhhaSIsImJhIiwiYm9uIiwibmFtIiwic2F1IiwiYmF5IiwidGFtIiwiY2hpbiIsInR1b25nIiwidW5nIiwibGFuIiwicXVhIiwiZG9pIiwidm9pIiwKICAidGhlIiwiYW5kIiwib3IiLCJ3aXRoIiwiZnJvbSIsIndoZXJlaW4iLCJtZXRob2QiLCJwcm9jZXNzIiwiY29tcHJpc2luZyIsImNvbXByaXNlcyIsImluY2x1ZGluZyIsInN0ZXAiLCJzdGVwcyIsInVzaW5nIiwidXNlZCIsInVzZSIsCiAgImZpcnN0Iiwic2Vjb25kIiwidGhpcmQiLCJ0aGVuIiwidGhlcmVvZiIsInRoZXJlaW4iLCJ0aGVyZWJ5Iiwic3VjaCIsInRoYXQiLCJ3aGljaCIsImludG8iLCJvbnRvIgpdKTsKCmZ1bmN0aW9uIGZlYXR1cmVDb3JlVGVybXModGV4dCl7CiAgY29uc3Qgb3JpZ2luYWw9bm9ybWFsaXplT2NyVGV4dCh0ZXh0fHwiIik7CiAgY29uc3QgdG9rZW5zPVsuLi5vcmlnaW5hbC5tYXRjaEFsbCgvW1xwe0x9XHB7Tn1cLVwvXC5dKy9ndSldLm1hcChtPT5tWzBdKTsKICBjb25zdCBvdXQ9W107CiAgZm9yKGNvbnN0IHRvayBvZiB0b2tlbnMpewogICAgY29uc3QgZj1mb2xkVk4odG9rKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1teYS16MC05XC1cL1wuXS9nLCIiKTsKICAgIGlmKCFmIHx8IFNFQVJDSF9TVE9QLmhhcyhmKSB8fCBmLmxlbmd0aDw0KSBjb250aW51ZTsKICAgIGlmKC9eXGQrKD86W1wuLF1cZCspPyU/JC8udGVzdChmKSkgY29udGludWU7CiAgICBpZighb3V0LnNvbWUoeD0+Zm9sZFZOKHgpLnRvTG93ZXJDYXNlKCk9PT1mKSkgb3V0LnB1c2godG9rKTsKICB9CiAgcmV0dXJuIG91dC5zbGljZSgwLDgpOwp9CgpmdW5jdGlvbiBtZWFuaW5nZnVsVG9rZW5zKHRleHQpewogIHJldHVybiBbLi4ubm9ybWFsaXplT2NyVGV4dCh0ZXh0fHwiIikubWF0Y2hBbGwoL1tccHtMfVxwe059XC1cL1wuXSsvZ3UpXQogICAgLm1hcChtPT5tWzBdKQogICAgLmZpbHRlcih0b2s9PnsKICAgICAgY29uc3QgZj1mb2xkVk4odG9rKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1teYS16MC05XC1cL1wuXS9nLCIiKTsKICAgICAgcmV0dXJuIGYubGVuZ3RoPj00ICYmICFTRUFSQ0hfU1RPUC5oYXMoZikgJiYgIS9eXGQrKD86W1wuLF1cZCspPyU/JC8udGVzdChmKTsKICAgIH0pOwp9CgpmdW5jdGlvbiB0aXRsZVRlY2huaWNhbFBocmFzZSgpewogIGxldCByYXc9c2FuaXRpemVQYXRlbnRUaXRsZSgkKCJ0aXRsZSIpLnZhbHVlfHwiIik7CiAgaWYoIXJhdykgcmV0dXJuICIiOwoKICBsZXQgdD1ub3JtYWxpemVPY3JUZXh0KHJhdykKICAgIC5yZXBsYWNlKC9eKD86cXV5IHRyw6xuaHxwaMawxqFuZyBwaMOhcHxo4buHIHRo4buRbmd8dGhp4bq/dCBi4buLfHPhuqNuIHBo4bqpbXxjaOG6vyBwaOG6qW0pXHMrKD86c+G6o24geHXhuqV0fGNo4bq/IHThuqFvfMSRaeG7gXUgY2jhur8pP1xzKi9pLCIiKTsKCiAgLy8gUmVqZWN0IHN0cmluZ3MgZG9taW5hdGVkIGJ5IHBhZ2UgbnVtYmVycyAvIGFydGlmYWN0cy4KICBpZigodC5tYXRjaCgvXGQrXHMqXC9ccypcZCsvZyl8fFtdKS5sZW5ndGg+PTEpIHJldHVybiAiIjsKCiAgY29uc3QgdG9rcz1tZWFuaW5nZnVsVG9rZW5zKHQpOwogIGlmKHRva3MubGVuZ3RoPj0yKSByZXR1cm4gdG9rcy5zbGljZSgwLDcpLmpvaW4oIiAiKTsKICByZXR1cm4gIiI7Cn0KCmZ1bmN0aW9uIHRlY2huaWNhbFBocmFzZXNGcm9tVGV4dCh0ZXh0KXsKICBjb25zdCByYXc9bm9ybWFsaXplT2NyVGV4dCh0ZXh0fHwiIik7CiAgY29uc3QgdG9rcz1tZWFuaW5nZnVsVG9rZW5zKHJhdyk7CiAgY29uc3Qgb3V0PVtdOwoKICAvLyBQcmVmZXIgcGhyYXNlcyBleHBsaWNpdGx5IHByZXNlbnQgaW4gdGhlIHRlY2huaWNhbCBkaWN0aW9uYXJ5LgogIGZvcihjb25zdCBba10gb2YgT2JqZWN0LmVudHJpZXMoZGljdCkpewogICAgaWYoZm9sZFZOKHJhdykudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhmb2xkVk4oaykudG9Mb3dlckNhc2UoKSkgJiYgay5zcGxpdCgvXHMrLykubGVuZ3RoPj0yKXsKICAgICAgb3V0LnB1c2goayk7CiAgICB9CiAgfQoKICAvLyBCdWlsZCBjb21wYWN0IDLigJMzIHdvcmQgcGhyYXNlcyBpbnN0ZWFkIG9mIGlzb2xhdGVkIE9DUiB3b3Jkcy4KICBmb3IobGV0IG49MztuPj0yO24tLSl7CiAgICBmb3IobGV0IGk9MDtpK248PXRva3MubGVuZ3RoO2krKyl7CiAgICAgIGNvbnN0IHBocmFzZT10b2tzLnNsaWNlKGksaStuKS5qb2luKCIgIik7CiAgICAgIGNvbnN0IGY9Zm9sZFZOKHBocmFzZSkudG9Mb3dlckNhc2UoKTsKICAgICAgaWYoIW91dC5zb21lKHg9PmZvbGRWTih4KS50b0xvd2VyQ2FzZSgpPT09ZikpIG91dC5wdXNoKHBocmFzZSk7CiAgICAgIGlmKG91dC5sZW5ndGg+PTgpIGJyZWFrOwogICAgfQogICAgaWYob3V0Lmxlbmd0aD49OCkgYnJlYWs7CiAgfQogIHJldHVybiBvdXQuc2xpY2UoMCw4KTsKfQoKZnVuY3Rpb24gcXVlcnlRdWFsaXR5KHEpewogIGNvbnN0IHdvcmRzPW1lYW5pbmdmdWxUb2tlbnMoU3RyaW5nKHEpLnJlcGxhY2UoL1xiQU5EXGJ8XGJPUlxiL2dpLCIgIikpOwogIGNvbnN0IHVuaXE9Wy4uLm5ldyBTZXQod29yZHMubWFwKHg9PmZvbGRWTih4KS50b0xvd2VyQ2FzZSgpKSldOwogIHJldHVybiB7CiAgICBvazogdW5pcS5sZW5ndGg+PTIsCiAgICB0ZXJtczogdW5pcSwKICAgIHNjb3JlOiBNYXRoLm1pbigxMDAsdW5pcS5sZW5ndGgqMjIpCiAgfTsKfQoKCmZ1bmN0aW9uIGJ1aWxkUHJvU2VhcmNoUm93cygpewogIHJldHVybiBzdGF0ZS5mZWF0dXJlcy5tYXAoZj0+ewogICAgY29uc3QgcGhyYXNlcz10ZWNobmljYWxQaHJhc2VzRnJvbVRleHQoZi50ZXh0KTsKICAgIGNvbnN0IHRlcm1zPWZlYXR1cmVDb3JlVGVybXMoZi50ZXh0KTsKICAgIGNvbnN0IGZvdW5kPVtdOwogICAgZm9yKGNvbnN0IFtrLHZdIG9mIE9iamVjdC5lbnRyaWVzKGRpY3QpKXsKICAgICAgaWYoZm9sZFZOKGYudGV4dCkudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhmb2xkVk4oaykudG9Mb3dlckNhc2UoKSkpIGZvdW5kLnB1c2goaywuLi52KTsKICAgIH0KICAgIGNvbnN0IGFsbD1bLi4ucGhyYXNlcywuLi5mb3VuZCwuLi50ZXJtc10uZmlsdGVyKCh4LGksYSk9PngmJmEuZmluZEluZGV4KHk9PmZvbGRWTih5KT09PWZvbGRWTih4KSk9PT1pKTsKICAgIGNvbnN0IHByaW1hcnk9YWxsWzBdfHwiIjsKICAgIGNvbnN0IHN5bm9ueW1zPWFsbC5zbGljZSgxLDUpOwogICAgcmV0dXJuIFtmLmlkLHByaW1hcnksc3lub255bXMuam9pbigiOyAiKXx8IuKAlCIsJCgiaXBjIikudmFsdWV8fCJD4bqnbiBjaHV5w6puIGdpYSB4w6FjIMSR4buLbmgiXTsKICB9KS5maWx0ZXIocj0+clsxXSk7Cn0KCmZ1bmN0aW9uIGJ1aWxkUHJvUXVlcmllcyhyb3dzKXsKICBjb25zdCBwaHJhc2VzPVtdOwogIGNvbnN0IHRpdGxlUGhyYXNlPXRpdGxlVGVjaG5pY2FsUGhyYXNlKCk7CiAgaWYodGl0bGVQaHJhc2UpIHBocmFzZXMucHVzaCh0aXRsZVBocmFzZSk7CgogIGZvcihjb25zdCByIG9mIHJvd3MpewogICAgY29uc3QgdmFscz1bclsxXSwuLi4oclsyXT09PSLigJQiP1tdOnJbMl0uc3BsaXQoIjsiKS5tYXAoeD0+eC50cmltKCkpKV07CiAgICBmb3IoY29uc3QgdiBvZiB2YWxzKXsKICAgICAgaWYoIXYpIGNvbnRpbnVlOwogICAgICBjb25zdCBxPXF1ZXJ5UXVhbGl0eSh2KTsKICAgICAgaWYocS5vayAmJiAhcGhyYXNlcy5zb21lKHg9PmZvbGRWTih4KT09PWZvbGRWTih2KSkpIHBocmFzZXMucHVzaCh2KTsKICAgIH0KICB9CgogIGNvbnN0IHF1ZXJpZXM9W107CiAgY29uc3QgYWRkPXE9PnsKICAgIHE9KHF8fCIiKS50cmltKCk7CiAgICBpZighcSB8fCAhcXVlcnlRdWFsaXR5KHEpLm9rKSByZXR1cm47CiAgICBpZighcXVlcmllcy5zb21lKHg9PmZvbGRWTih4KT09PWZvbGRWTihxKSkpIHF1ZXJpZXMucHVzaChxKTsKICB9OwoKICAvLyBIaWdoZXN0IHByZWNpc2lvbjogdGl0bGUgY29uY2VwdCArIG9uZSBmZWF0dXJlIGNvbmNlcHQuCiAgaWYodGl0bGVQaHJhc2UgJiYgcGhyYXNlc1sxXSkgYWRkKGAiJHt0aXRsZVBocmFzZX0iIEFORCAiJHtwaHJhc2VzWzFdfSJgKTsKICBpZih0aXRsZVBocmFzZSkgYWRkKGAiJHt0aXRsZVBocmFzZX0iYCk7CgogIC8vIEJyb2FkZXIgcmVjYWxsIHF1ZXJpZXMuCiAgaWYocGhyYXNlcy5sZW5ndGg+PTIpIGFkZChwaHJhc2VzLnNsaWNlKDAsMikubWFwKHg9PmAiJHt4fSJgKS5qb2luKCIgQU5EICIpKTsKICBpZihwaHJhc2VzLmxlbmd0aD49MykgYWRkKHBocmFzZXMuc2xpY2UoMSwzKS5tYXAoeD0+YCIke3h9ImApLmpvaW4oIiBBTkQgIikpOwoKICAvLyBMYXN0IGZhbGxiYWNrOiAzLTYgc2lnbmlmaWNhbnQgdGVjaG5pY2FsIHRva2VucyBmcm9tIHRpdGxlICsgc2VsZWN0ZWQgY2xhaW0uCiAgY29uc3QgYz1zdGF0ZS5jbGFpbXNbc3RhdGUuc2VsZWN0ZWRdfHxzdGF0ZS5jbGFpbXNbMF07CiAgY29uc3QgdG9rZW5Qb29sPVsuLi5tZWFuaW5nZnVsVG9rZW5zKCQoInRpdGxlIikudmFsdWV8fCIiKSwuLi5tZWFuaW5nZnVsVG9rZW5zKGM/Yy50ZXh0OiIiKV07CiAgY29uc3QgdW5pcT1bXTsKICBmb3IoY29uc3QgeCBvZiB0b2tlblBvb2wpewogICAgY29uc3QgZj1mb2xkVk4oeCkudG9Mb3dlckNhc2UoKTsKICAgIGlmKCF1bmlxLnNvbWUoeT0+Zm9sZFZOKHkpLnRvTG93ZXJDYXNlKCk9PT1mKSkgdW5pcS5wdXNoKHgpOwogIH0KICBpZih1bmlxLmxlbmd0aD49MikgYWRkKHVuaXEuc2xpY2UoMCw2KS5qb2luKCIgIikpOwoKICByZXR1cm4gcXVlcmllcy5zbGljZSgwLDYpOwp9CiQoImF1dG9GZWF0dXJlcyIpLm9uY2xpY2s9KCk9PntsZXQgYz1zdGF0ZS5jbGFpbXNbKyQoImNsYWltU2VsZWN0IikudmFsdWV8fDBdO2lmKCFjKXJldHVybiBhbGVydCgiQ2jGsGEgY8OzIGNsYWltLiIpO3N0YXRlLnNlbGVjdGVkPSskKCJjbGFpbVNlbGVjdCIpLnZhbHVlfHwwO3N0YXRlLmZlYXR1cmVzPWZlYXR1cmVTcGxpdChjLnRleHQpO3JlbmRlckZlYXR1cmVzKCk7JCgiZmVhdHVyZVN0YXR1cyIpLnZhbHVlPSJC4bqjbiBuaMOhcCB04buxIMSR4buZbmciO3N0YXRlLmNvbmZpcm1lZD1mYWxzZTt1cGRhdGVGZWF0dXJlUmV2aWV3VUkoKX07CiQoImNvbmZpcm1GZWF0dXJlcyIpLm9uY2xpY2s9KCk9PntpZighc3RhdGUuZmVhdHVyZXMubGVuZ3RoKXJldHVybiBhbGVydCgiQ2jGsGEgY8OzIGThuqV1IGhp4buHdS4iKTtzdGF0ZS5jb25maXJtZWQ9dHJ1ZTt1cGRhdGVGZWF0dXJlUmV2aWV3VUkoKTthbGVydCgixJDDoyB4w6FjIG5o4bqtbiBi4buZIGThuqV1IGhp4buHdS4gQuG6oW4gY8OzIHRo4buDIHRp4bq/cCB04bulYyBzYW5nIGLGsOG7m2MgdHJhIGPhu6l1LiIpfTsKCmZ1bmN0aW9uIHVwZGF0ZUZlYXR1cmVSZXZpZXdVSSgpewogIGNvbnN0IG49c3RhdGUuZmVhdHVyZXMubGVuZ3RoOwogIGNvbnN0IGJhcj0kKCJmZWF0dXJlUmV2aWV3QmFyIik7CiAgY29uc3QgYmFkZ2U9JCgiZmVhdHVyZVN0YXR1c0JhZGdlIik7CiAgY29uc3QgbGFiZWw9JCgiZmVhdHVyZUNvdW50TGFiZWwiKTsKICBpZighYmFyfHwhYmFkZ2V8fCFsYWJlbCkgcmV0dXJuOwogIGxhYmVsLnRleHRDb250ZW50PW4/YCR7bn0gZOG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdGA6IkNoxrBhIGPDsyBk4bqldSBoaeG7h3UiOwogIGlmKHN0YXRlLmNvbmZpcm1lZCl7CiAgICBiYXIuY2xhc3NMaXN0LmFkZCgiZmVhdHVyZS1jb25maXJtZWQiKTsKICAgIGJhZGdlLmNsYXNzTmFtZT0icGlsbCBncmVlbiI7CiAgICBiYWRnZS50ZXh0Q29udGVudD0ixJDDoyB4w6FjIG5o4bqtbiI7CiAgICAkKCJmZWF0dXJlU3RhdHVzIikudmFsdWU9IsSQw6MgeMOhYyBuaOG6rW4iOwogICAgJCgiY29uZmlybUZlYXR1cmVzIikudGV4dENvbnRlbnQ9IuKckyDEkMOjIHjDoWMgbmjhuq1uIGLhu5kgZOG6pXUgaGnhu4d1IjsKICB9ZWxzZXsKICAgIGJhci5jbGFzc0xpc3QucmVtb3ZlKCJmZWF0dXJlLWNvbmZpcm1lZCIpOwogICAgYmFkZ2UuY2xhc3NOYW1lPSJwaWxsIHllbGxvdyI7CiAgICBiYWRnZS50ZXh0Q29udGVudD0iQ2jGsGEgeMOhYyBuaOG6rW4iOwogICAgJCgiZmVhdHVyZVN0YXR1cyIpLnZhbHVlPW4/IkLhuqNuIG5ow6FwIHThu7EgxJHhu5luZyI6IkNoxrBhIHThuqFvIjsKICAgICQoImNvbmZpcm1GZWF0dXJlcyIpLnRleHRDb250ZW50PSLinJMgWMOhYyBuaOG6rW4gYuG7mSBk4bqldSBoaeG7h3UiOwogIH0KfQpmdW5jdGlvbiByZW5kZXJGZWF0dXJlcygpewogJCgiZmVhdHVyZUJvZHkiKS5pbm5lckhUTUw9c3RhdGUuZmVhdHVyZXMubWFwKChmLGkpPT5gPHRyPjx0ZD48c3Ryb25nPiR7Zi5pZH08L3N0cm9uZz48L3RkPjx0ZD48dGV4dGFyZWEgZGF0YS1mdD0iJHtpfSIgc3R5bGU9Im1pbi1oZWlnaHQ6NzJweCI+JHtlc2MoZi50ZXh0KX08L3RleHRhcmVhPjwvdGQ+PHRkPjxzZWxlY3QgZGF0YS10eT0iJHtpfSI+PG9wdGlvbiAke2YudHlwZT09PSJRdXkgdHLDrG5oIj8ic2VsZWN0ZWQiOiIifT5RdXkgdHLDrG5oPC9vcHRpb24+PG9wdGlvbiAke2YudHlwZT09PSJUaMOgbmggcGjhuqduL05ndXnDqm4gbGnhu4d1Ij8ic2VsZWN0ZWQiOiIifT5UaMOgbmggcGjhuqduL05ndXnDqm4gbGnhu4d1PC9vcHRpb24+PG9wdGlvbiAke2YudHlwZT09PSJLaeG7g20gc2/DoXQiPyJzZWxlY3RlZCI6IiJ9Pktp4buDbSBzb8OhdDwvb3B0aW9uPjxvcHRpb24gJHtmLnR5cGU9PT0iVGhp4bq/dCBi4buLL0PhuqV1IHRyw7pjIj8ic2VsZWN0ZWQiOiIifT5UaGnhur90IGLhu4svQ+G6pXUgdHLDumM8L29wdGlvbj48L3NlbGVjdD48L3RkPjx0ZD48c3BhbiBjbGFzcz0icGlsbCB5ZWxsb3ciPiR7Zi5jb25mfTwvc3Bhbj48L3RkPjx0ZD48YnV0dG9uIGNsYXNzPSJidG4gZGFuZ2VyIiBkYXRhLWRlbD0iJHtpfSI+w5c8L2J1dHRvbj48L3RkPjwvdHI+YCkuam9pbigiIik7CiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1mdF0iKS5mb3JFYWNoKHg9Pngub25jaGFuZ2U9KCk9PnN0YXRlLmZlYXR1cmVzWyt4LmRhdGFzZXQuZnRdLnRleHQ9eC52YWx1ZSk7ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtdHldIikuZm9yRWFjaCh4PT54Lm9uY2hhbmdlPSgpPT5zdGF0ZS5mZWF0dXJlc1sreC5kYXRhc2V0LnR5XS50eXBlPXgudmFsdWUpO2RvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWRlbF0iKS5mb3JFYWNoKHg9Pngub25jbGljaz0oKT0+e3N0YXRlLmZlYXR1cmVzLnNwbGljZSgreC5kYXRhc2V0LmRlbCwxKTtzdGF0ZS5jb25maXJtZWQ9ZmFsc2U7cmVuZGVyRmVhdHVyZXMoKX0pO3VwZGF0ZUZlYXR1cmVSZXZpZXdVSSgpCn0KCmNvbnN0IGRpY3Q9eyJo4bqhdCB0aGFuaCBsb25nIjpbImRyYWdvbiBmcnVpdCBzZWVkIiwicGl0YXlhIHNlZWQiLCJIeWxvY2VyZXVzIHNlZWQiXSwibuG6o3kgbeG6p20iOlsiZ2VybWluYXRpb24iLCJnZXJtaW5hdGVkIiwic3Byb3V0aW5nIl0sImNlbGx1bGFzZSI6WyJjZWxsdWxhc2UiLCJjZWxsdWxhc2UgdHJlYXRtZW50Il0sInBlY3RpbmFzZSI6WyJwZWN0aW5hc2UiLCJwZWN0aW5hc2UgdHJlYXRtZW50Il0sInPhuqV5IjpbImRyeWluZyIsImRlaHlkcmF0aW9uIl0sIm5naGnhu4FuIjpbImdyaW5kaW5nIiwibWlsbGluZyJdLCJi4buZdCBuaMOgdSI6WyJub25pIHBvd2RlciIsIk1vcmluZGEgY2l0cmlmb2xpYSBwb3dkZXIiXSwixJHhu5kg4bqpbSI6WyJtb2lzdHVyZSBjb250ZW50IiwibW9pc3R1cmUgYWRqdXN0bWVudCJdLCLEkcOzbmcgZ8OzaSI6WyJwYWNrYWdpbmciLCJwYWNraW5nIl0sImZyZWV6ZSBkcnlpbmciOlsibHlvcGhpbGl6YXRpb24iLCJmcmVlemUgZHJ5ZXIiXSwibW9zcXVpdG8iOlsibW9zcXVpdG8gcmVwZWxsZW50IiwiaW5zZWN0IHJlcGVsbGVudCJdLCJlc3NlbnRpYWwgb2lsIjpbImV4dHJhY3QiLCJhcm9tYXRpYyBvaWwiXX07CiQoImdlblNlYXJjaCIpLm9uY2xpY2s9KCk9PnsKICBzdGF0ZS5zZWFyY2g9YnVpbGRQcm9TZWFyY2hSb3dzKCk7CiAgc3RhdGUucXVlcmllcz1idWlsZFByb1F1ZXJpZXMoc3RhdGUuc2VhcmNoKTsKICByZW5kZXJTZWFyY2goKTsKfTsKZnVuY3Rpb24gcmVuZGVyU2VhcmNoKCl7JCgic2VhcmNoQm9keSIpLmlubmVySFRNTD1zdGF0ZS5zZWFyY2gubWFwKHI9PmA8dHI+PHRkPjxzdHJvbmc+JHtyWzBdfTwvc3Ryb25nPjwvdGQ+PHRkPiR7ZXNjKHJbMV0pfTwvdGQ+PHRkPiR7ZXNjKHJbMl0pfTwvdGQ+PHRkPiR7ZXNjKHJbM10pfTwvdGQ+PC90cj5gKS5qb2luKCIiKTskKCJxdWVyeUxpc3QiKS5pbm5lckhUTUw9c3RhdGUucXVlcmllcy5tYXAoKHEsaSk9PmA8ZGl2IGNsYXNzPSJjYWxsb3V0Ij48c3Ryb25nPlEke2krMX08L3N0cm9uZz48YnIvPjxjb2RlPiR7ZXNjKHEpfTwvY29kZT48L2Rpdj5gKS5qb2luKCIiKX0KCgpmdW5jdGlvbiBiYWNrZW5kQmFzZSgpewogIHJldHVybiBsb2NhdGlvbi5vcmlnaW47Cn0KZnVuY3Rpb24gc2F2ZUJhY2tlbmQoKXsKICBzdGF0ZS5iYWNrZW5kVXJsPWxvY2F0aW9uLm9yaWdpbjsKfQpmdW5jdGlvbiB1cGRhdGVPZmZpY2lhbFNlYXJjaExpbmtzKHEpewogIGNvbnN0IHF1ZXJ5PXF8fCQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlfHxzdGF0ZS5xdWVyaWVzWzBdfHwiIjsKICAkKCJncExpbmsiKS5ocmVmPSJodHRwczovL3BhdGVudHMuZ29vZ2xlLmNvbS8/cT0iK2VuY29kZVVSSUNvbXBvbmVudChxdWVyeSk7CiAgJCgid2lwb0xpbmsiKS5ocmVmPSJodHRwczovL3BhdGVudHNjb3BlLndpcG8uaW50L3NlYXJjaC9lbi9hZHZhbmNlZFNlYXJjaC5qc2Y/cXVlcnk9IitlbmNvZGVVUklDb21wb25lbnQoJ0VOX0FMTFRYVDooJytxdWVyeSsnKScpOwogICQoImVwb0xpbmsiKS5ocmVmPSJodHRwczovL3dvcmxkd2lkZS5lc3BhY2VuZXQuY29tL3BhdGVudC9zZWFyY2g/cT0iK2VuY29kZVVSSUNvbXBvbmVudChxdWVyeSk7Cn0KZnVuY3Rpb24gdXNlR2VuZXJhdGVkUXVlcnkoKXsKICBsZXQgcT0iIjsKICBpZihzdGF0ZS5xdWVyaWVzLmxlbmd0aCl7CiAgICBxPXN0YXRlLnF1ZXJpZXNbMF07CiAgfWVsc2UgaWYoc3RhdGUuZmVhdHVyZXMubGVuZ3RoKXsKICAgIGNvbnN0IHJvd3M9YnVpbGRQcm9TZWFyY2hSb3dzKCk7CiAgICBjb25zdCBxcz1idWlsZFByb1F1ZXJpZXMocm93cyk7CiAgICBxPXFzWzBdfHwiIjsKICB9ZWxzZXsKICAgIHE9JCgidGl0bGUiKS52YWx1ZXx8IiI7CiAgfQogICQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlPXE7CiAgdXBkYXRlT2ZmaWNpYWxTZWFyY2hMaW5rcyhxKTsKICByZXR1cm4gcTsKfQpmdW5jdGlvbiBjbGVhblBhdGVudEh0bWwocyl7CiAgY29uc3QgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJ0ZXh0YXJlYSIpOwogIGQuaW5uZXJIVE1MPShzfHwiIikucmVwbGFjZSgvPFtePl0qPi9nLCIgIik7CiAgcmV0dXJuIGQudmFsdWUucmVwbGFjZSgvXHMrL2csIiAiKS50cmltKCk7Cn0KZnVuY3Rpb24gdGFyZ2V0RGF0ZU9iaigpewogIGNvbnN0IHY9JCgiZmlsaW5nRGF0ZSIpLnZhbHVlOwogIHJldHVybiB2P25ldyBEYXRlKHYrIlQwMDowMDowMCIpOm51bGw7Cn0KZnVuY3Rpb24gY2FuZGlkYXRlRGF0ZVN0YXR1cyhjKXsKICBjb25zdCB0ZD10YXJnZXREYXRlT2JqKCk7CiAgY29uc3QgZD1jLnB1YmxpY2F0aW9uX2RhdGV8fGMucHJpb3JpdHlfZGF0ZXx8Yy5maWxpbmdfZGF0ZXx8IiI7CiAgaWYoIXRkfHwhZCkgcmV0dXJuIHtsYWJlbDoiQ+G6p24geMOhYyBtaW5oIixjbHM6InllbGxvdyIsZWxpZ2libGU6bnVsbH07CiAgY29uc3QgY2Q9bmV3IERhdGUoZCk7CiAgaWYoaXNOYU4oY2QpKSByZXR1cm4ge2xhYmVsOiJD4bqnbiB4w6FjIG1pbmgiLGNsczoieWVsbG93IixlbGlnaWJsZTpudWxsfTsKICBjb25zdCBvaz1jZDx0ZDsKICByZXR1cm4ge2xhYmVsOm9rPyJUcsaw4bubYyBt4buRYyB0YXJnZXQiOiJTYXUgbeG7kWMgdGFyZ2V0IixjbHM6b2s/ImdyZWVuIjoicmVkIixlbGlnaWJsZTpva307Cn0KZnVuY3Rpb24gZmVhdHVyZVRlcm1zKCl7CiAgY29uc3Qgc3RvcD1uZXcgU2V0KFsiYmFvIiwiZ+G7k20iLCJ0cm9uZyIsImPhu6dhIiwixJHGsOG7o2MiLCJ2w6AiLCJ0aGUiLCJ3aXRoIiwiZnJvbSIsIndoZXJlaW4iLCJtZXRob2QiLCJwcm9jZXNzIl0pOwogIGNvbnN0IHRlcm1zPVtdOwogIGZvcihjb25zdCBmIG9mIHN0YXRlLmZlYXR1cmVzKXsKICAgIGZvcihjb25zdCB3IG9mIGZvbGRWTihmLnRleHQpLnRvTG93ZXJDYXNlKCkuc3BsaXQoL1teYS16MC05XSsvKSl7CiAgICAgIGlmKHcubGVuZ3RoPj00JiYhc3RvcC5oYXModykpIHRlcm1zLnB1c2godyk7CiAgICB9CiAgfQogIHJldHVybiBbLi4ubmV3IFNldCh0ZXJtcyldLnNsaWNlKDAsODApOwp9CmZ1bmN0aW9uIHNjb3JlQ2FuZGlkYXRlKGMpewogIGNvbnN0IGJsb2I9Zm9sZFZOKFtjLnRpdGxlLGMuc25pcHBldCxjLmFzc2lnbmVlXS5maWx0ZXIoQm9vbGVhbikuam9pbigiICIpKS50b0xvd2VyQ2FzZSgpOwogIGNvbnN0IHRlcm1zPWZlYXR1cmVUZXJtcygpOwogIGlmKCF0ZXJtcy5sZW5ndGgpIHJldHVybiA1MDsKICBsZXQgaGl0PTA7CiAgZm9yKGNvbnN0IHQgb2YgdGVybXMpIGlmKGJsb2IuaW5jbHVkZXModCkpIGhpdCsrOwogIGxldCBzY29yZT1NYXRoLnJvdW5kKChoaXQvTWF0aC5taW4odGVybXMubGVuZ3RoLDIwKSkqMTAwKTsKICBjb25zdCBkcz1jYW5kaWRhdGVEYXRlU3RhdHVzKGMpOwogIGlmKGRzLmVsaWdpYmxlPT09ZmFsc2UpIHNjb3JlPU1hdGgubWF4KDAsc2NvcmUtMzUpOwogIHJldHVybiBNYXRoLm1pbig5OSxzY29yZSk7Cn0KZnVuY3Rpb24gcmVuZGVyQ2FuZGlkYXRlcygpewogIGlmKCFzdGF0ZS5jYW5kaWRhdGVzLmxlbmd0aCl7CiAgICAkKCJjYW5kaWRhdGVCb2R5IikuaW5uZXJIVE1MPSc8dHI+PHRkIGNvbHNwYW49IjYiIHN0eWxlPSJjb2xvcjojOThhMmIzO3RleHQtYWxpZ246Y2VudGVyIj5LaMO0bmcgY8OzIGvhur90IHF14bqjIMSR4buDIGhp4buDbiB0aOG7iy48L3RkPjwvdHI+JzsKICAgIHJldHVybjsKICB9CiAgJCgiY2FuZGlkYXRlQm9keSIpLmlubmVySFRNTD1zdGF0ZS5jYW5kaWRhdGVzLm1hcCgoYyxpKT0+ewogICAgYy5zY29yZT1zY29yZUNhbmRpZGF0ZShjKTsKICAgIGNvbnN0IGRzPWNhbmRpZGF0ZURhdGVTdGF0dXMoYyk7CiAgICBjb25zdCBzY29yZUNscz1jLnNjb3JlPj02NT8iaGlnaCI6Yy5zY29yZT49MzU/Im1pZCI6ImxvdyI7CiAgICBjb25zdCBkYXRlPWMucHVibGljYXRpb25fZGF0ZXx8Yy5wcmlvcml0eV9kYXRlfHxjLmZpbGluZ19kYXRlfHwi4oCUIjsKICAgIHJldHVybiBgPHRyPgogICAgICA8dGQ+JHtpKzF9PC90ZD4KICAgICAgPHRkIHN0eWxlPSJtaW4td2lkdGg6MzMwcHgiPgogICAgICAgIDxhIGNsYXNzPSJzZWFyY2gtcmVzdWx0LXRpdGxlIiBocmVmPSIke2VzYyhjLnVybCl9IiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciI+JHtlc2MoYy5wdWJsaWNhdGlvbl9udW1iZXJ8fCJQYXRlbnQiKX0gwrcgJHtlc2MoYy50aXRsZXx8Iktow7RuZyBjw7MgdGnDqnUgxJHhu4EiKX08L2E+CiAgICAgICAgPGRpdiBjbGFzcz0ic3RhdHVzIiBzdHlsZT0ibWFyZ2luLXRvcDo1cHgiPiR7ZXNjKGMuc25pcHBldHx8IiIpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InNvdXJjZS1yb3ciIHN0eWxlPSJtYXJnaW4tdG9wOjdweCI+CiAgICAgICAgICA8YSBjbGFzcz0ic291cmNlLWNoaXAiIGhyZWY9IiR7ZXNjKGMudXJsKX0iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj5Hb29nbGUgUGF0ZW50cyDihpc8L2E+CiAgICAgICAgICA8YSBjbGFzcz0ic291cmNlLWNoaXAiIGhyZWY9Imh0dHBzOi8vcGF0ZW50c2NvcGUud2lwby5pbnQvc2VhcmNoL2VuL2FkdmFuY2VkU2VhcmNoLmpzZj9xdWVyeT0ke2VuY29kZVVSSUNvbXBvbmVudCgnQUxMTlVNOignK2MucHVibGljYXRpb25fbnVtYmVyKycpJyl9IiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciI+V0lQTyDihpc8L2E+CiAgICAgICAgICA8YSBjbGFzcz0ic291cmNlLWNoaXAiIGhyZWY9Imh0dHBzOi8vd29ybGR3aWRlLmVzcGFjZW5ldC5jb20vcGF0ZW50L3NlYXJjaD9xPSR7ZW5jb2RlVVJJQ29tcG9uZW50KCdwbj0nK2MucHVibGljYXRpb25fbnVtYmVyKX0iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj5Fc3BhY2VuZXQg4oaXPC9hPgogICAgICAgIDwvZGl2PgogICAgICA8L3RkPgogICAgICA8dGQ+JHtlc2MoZGF0ZSl9PC90ZD4KICAgICAgPHRkPjxzcGFuIGNsYXNzPSJzY29yZSAke3Njb3JlQ2xzfSI+JHtjLnNjb3JlfSU8L3NwYW4+PC90ZD4KICAgICAgPHRkPjxzcGFuIGNsYXNzPSJwaWxsICR7ZHMuY2xzfSI+JHtkcy5sYWJlbH08L3NwYW4+PC90ZD4KICAgICAgPHRkPjxkaXYgY2xhc3M9ImNhbmRpZGF0ZS1hY3Rpb25zIj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJzbG90YnRuIiBkYXRhLXNsb3Q9IkQxIiBkYXRhLWNhbmRpZGF0ZT0iJHtpfSI+RDE8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJzbG90YnRuIiBkYXRhLXNsb3Q9IkQyIiBkYXRhLWNhbmRpZGF0ZT0iJHtpfSI+RDI8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJzbG90YnRuIiBkYXRhLXNsb3Q9IkQzIiBkYXRhLWNhbmRpZGF0ZT0iJHtpfSI+RDM8L2J1dHRvbj4KICAgICAgPC9kaXY+PC90ZD4KICAgIDwvdHI+YDsKICB9KS5qb2luKCIiKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1jYW5kaWRhdGVdIikuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9PnNlbGVjdENhbmRpZGF0ZVRvU2xvdCgrYi5kYXRhc2V0LmNhbmRpZGF0ZSxiLmRhdGFzZXQuc2xvdCkpOwp9CmFzeW5jIGZ1bmN0aW9uIHNlYXJjaFJlYWxQYXRlbnRzKCl7CiAgbGV0IHE9JCgibGl2ZVNlYXJjaFF1ZXJ5IikudmFsdWUudHJpbSgpfHx1c2VHZW5lcmF0ZWRRdWVyeSgpOwogIGlmKCFxdWVyeVF1YWxpdHkocSkub2spewogICAgY29uc3Qgcm93cz1idWlsZFByb1NlYXJjaFJvd3MoKTsKICAgIGNvbnN0IHFzPWJ1aWxkUHJvUXVlcmllcyhyb3dzKTsKICAgIHE9cXNbMF18fHRpdGxlVGVjaG5pY2FsUGhyYXNlKCk7CiAgICAkKCJsaXZlU2VhcmNoUXVlcnkiKS52YWx1ZT1xOwogIH0KICBpZighcXVlcnlRdWFsaXR5KHEpLm9rKXsKICAgICQoImxpdmVTZWFyY2hTdGF0ZSIpLmlubmVySFRNTD0nPHNwYW4gY2xhc3M9ImJhY2tlbmQtYmFkIj5UcnV5IHbhuqVuIGhp4buHbiB04bqhaSBxdcOhIGNodW5nIGhv4bq3YyBi4buLIGzhu5dpIE9DUi48L3NwYW4+IEjDo3kgcXVheSBs4bqhaSBraeG7g20gdHJhIENsYWltL0ThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQgaG/hurdjIG5o4bqtcCDDrXQgbmjhuqV0IDIgdGh14bqtdCBuZ+G7ryBr4bu5IHRodeG6rXQuJzsKICAgIHJldHVybjsKICB9CiAgdXBkYXRlT2ZmaWNpYWxTZWFyY2hMaW5rcyhxKTsKICBpZighcSkgcmV0dXJuIGFsZXJ0KCJDaMawYSBjw7MgdHJ1eSB24bqlbiB0cmEgY+G7qXUuIik7CiAgY29uc3QgYmFzZT1iYWNrZW5kQmFzZSgpOwogIHNhdmVCYWNrZW5kKCk7CiAgJCgibGl2ZVNlYXJjaFN0YXRlIikudGV4dENvbnRlbnQ9IsSQYW5nIHRyYSBj4bupdSBwYXRlbnQgdGjhuq10IHF1YSBi4buZIG3DoXkgdMOsbSBraeG6v20uLi4iOwogICQoImxpdmVTZWFyY2hCdG4iKS5kaXNhYmxlZD10cnVlOwogIHRyeXsKICAgIGNvbnN0IHVybD1iYXNlKyIvYXBpL3NlYXJjaD9xPSIrZW5jb2RlVVJJQ29tcG9uZW50KHEpKyImdGl0bGU9IitlbmNvZGVVUklDb21wb25lbnQoJCgidGl0bGUiKS52YWx1ZXx8IiIpKyImbnVtPTIwIjsKICAgIGNvbnN0IHI9YXdhaXQgZmV0Y2godXJsKTsKICAgIGNvbnN0IGRhdGE9YXdhaXQgci5qc29uKCk7CiAgICBpZighci5va3x8IWRhdGEub2spIHRocm93IG5ldyBFcnJvcihkYXRhLmVycm9yfHwoIkhUVFAgIityLnN0YXR1cykpOwogICAgaWYoZGF0YS5xdWVyeV91c2VkKXskKCJsaXZlU2VhcmNoUXVlcnkiKS52YWx1ZT1kYXRhLnF1ZXJ5X3VzZWQ7dXBkYXRlT2ZmaWNpYWxTZWFyY2hMaW5rcyhkYXRhLnF1ZXJ5X3VzZWQpfQogICAgc3RhdGUuY2FuZGlkYXRlcz0oZGF0YS5yZXN1bHRzfHxbXSkubWFwKHg9Pih7Li4ueCxzY29yZTowfSkpOwogICAgc3RhdGUuY2FuZGlkYXRlcy5zb3J0KChhLGIpPT5zY29yZUNhbmRpZGF0ZShiKS1zY29yZUNhbmRpZGF0ZShhKSk7CiAgICByZW5kZXJDYW5kaWRhdGVzKCk7CiAgICAkKCJsaXZlU2VhcmNoU3RhdGUiKS5pbm5lckhUTUw9YMSQw6Mgbmjhuq1uIDxzdHJvbmc+JHtzdGF0ZS5jYW5kaWRhdGVzLmxlbmd0aH08L3N0cm9uZz4ga+G6v3QgcXXhuqMgdOG7qyA8c3Ryb25nPiR7ZXNjKGRhdGEucHJvdmlkZXJ8fGRhdGEuc291cmNlfHwibmd14buTbiBwYXRlbnQiKX08L3N0cm9uZz4uIFRydXkgduG6pW4gdGjhu7FjIGTDuW5nOiA8c3Ryb25nPiR7ZXNjKGRhdGEucXVlcnlfdXNlZHx8cSl9PC9zdHJvbmc+JHtkYXRhLmF0dGVtcHRfY291bnQ/YCDCtyDEkcOjIHRo4butICR7ZGF0YS5hdHRlbXB0X2NvdW50fSBt4bupYyB0cnV5IHbhuqVuYDoiIn0uYDsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLmVycm9yKGUpOwogICAgY29uc3QgbXNnPVN0cmluZyhlLm1lc3NhZ2V8fGUpOwogICAgY29uc3QgaGludD0vNTAzfFJBVEVfTElNSVR8R09PR0xFX0JMT0NLRUQvaS50ZXN0KG1zZykKICAgICAgPyAiPGJyPjxzdHJvbmc+R29vZ2xlIFBhdGVudHMgxJFhbmcgY2jhurduIHRydXkgduG6pW4gdOG7sSDEkeG7mW5nIHThu6sgSVAgZGF0YWNlbnRlci48L3N0cm9uZz4gSOG7hyB0aOG7kW5nIHPhur0gxrB1IHRpw6puIEJyb3dzZXIgUnVuL1NlcnBBcGkgbuG6v3UgxJHGsOG7o2MgY+G6pXUgaMOsbmg7IEdvb2dsZSBkaXJlY3QgY2jhu4kgbMOgIGZhbGxiYWNrOyBjw6FjIGxpbmsgR29vZ2xlL1dJUE8vRVBPIHBow61hIHRyw6puIHbhuqtuIGzDoCBuZ3Xhu5NuIGtp4buDbSBjaOG7qW5nLiIKICAgICAgOiAiIjsKICAgICQoImxpdmVTZWFyY2hTdGF0ZSIpLmlubmVySFRNTD1gPHNwYW4gY2xhc3M9ImJhY2tlbmQtYmFkIj5UcmEgY+G7qXUgdOG7sSDEkeG7mW5nIGNoxrBhIHRow6BuaCBjw7RuZzogJHtlc2MobXNnKX08L3NwYW4+JHtoaW50fTxicj5C4bqhbiB24bqrbiBjw7MgdGjhu4MgbeG7nyB0cuG7sWMgdGnhur9wIGPDoWMgbmd14buTbiBjaMOtbmggdGjhu6ljIHBow61hIHRyw6puLmA7CiAgfWZpbmFsbHl7CiAgICAkKCJsaXZlU2VhcmNoQnRuIikuZGlzYWJsZWQ9ZmFsc2U7CiAgfQp9CmFzeW5jIGZ1bmN0aW9uIHNlbGVjdENhbmRpZGF0ZVRvU2xvdChpLHNsb3QpewogIGNvbnN0IGM9c3RhdGUuY2FuZGlkYXRlc1tpXTsKICBpZighYykgcmV0dXJuOwogIGNvbnN0IG49c2xvdC5zbGljZSgxKTsKICBjb25zdCBiYXNlPWJhY2tlbmRCYXNlKCk7CiAgJChgZCR7bn1Ob2ApLnZhbHVlPWMucHVibGljYXRpb25fbnVtYmVyfHwiIjsKICAkKGBkJHtufURhdGVgKS52YWx1ZT0oYy5wdWJsaWNhdGlvbl9kYXRlfHxjLnByaW9yaXR5X2RhdGV8fGMuZmlsaW5nX2RhdGV8fCIiKS5zbGljZSgwLDEwKTsKICAkKGBkJHtufVVybGApLnZhbHVlPWMudXJsfHwiIjsKICAkKGBkJHtufVRleHRgKS52YWx1ZT1bYy50aXRsZSxjLnNuaXBwZXRdLmZpbHRlcihCb29sZWFuKS5qb2luKCJcblxuIik7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiLnByaW9yLXNsb3QiKS5mb3JFYWNoKHg9PnguY2xhc3NMaXN0LnJlbW92ZSgic2VsZWN0ZWQiKSk7CiAgJCgic2xvdCIrc2xvdCkuY2xhc3NMaXN0LmFkZCgic2VsZWN0ZWQiKTsKCiAgaWYoYmFzZSYmYy5wdWJsaWNhdGlvbl9udW1iZXIpewogICAgdHJ5ewogICAgICAkKGBkJHtufVRleHRgKS52YWx1ZT0ixJBhbmcgbOG6pXkgbuG7mWkgZHVuZyBwYXRlbnQuLi4iOwogICAgICBjb25zdCByPWF3YWl0IGZldGNoKGJhc2UrIi9hcGkvZGV0YWlsP3B1Yj0iK2VuY29kZVVSSUNvbXBvbmVudChjLnB1YmxpY2F0aW9uX251bWJlcikpOwogICAgICBjb25zdCBkPWF3YWl0IHIuanNvbigpOwogICAgICBpZihyLm9rJiZkLm9rKXsKICAgICAgICBjb25zdCBwYXJ0cz1bXTsKICAgICAgICBpZihkLnRpdGxlKSBwYXJ0cy5wdXNoKCJUSVRMRVxuIitkLnRpdGxlKTsKICAgICAgICBpZihkLmFic3RyYWN0KSBwYXJ0cy5wdXNoKCJBQlNUUkFDVFxuIitkLmFic3RyYWN0KTsKICAgICAgICBpZihkLmNsYWltcykgcGFydHMucHVzaCgiQ0xBSU1TXG4iK2QuY2xhaW1zLnNsaWNlKDAsMTgwMDApKTsKICAgICAgICAkKGBkJHtufVRleHRgKS52YWx1ZT1wYXJ0cy5qb2luKCJcblxuIil8fFtjLnRpdGxlLGMuc25pcHBldF0uam9pbigiXG5cbiIpOwogICAgICB9ZWxzZXsKICAgICAgICAkKGBkJHtufVRleHRgKS52YWx1ZT1bYy50aXRsZSxjLnNuaXBwZXRdLmZpbHRlcihCb29sZWFuKS5qb2luKCJcblxuIik7CiAgICAgIH0KICAgIH1jYXRjaChfZSl7CiAgICAgICQoYGQke259VGV4dGApLnZhbHVlPVtjLnRpdGxlLGMuc25pcHBldF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oIlxuXG4iKTsKICAgIH0KICB9CiAgcmVhZFByaW9yKCk7Cn0KZnVuY3Rpb24gYXV0b1BpY2tEMTIzKCl7CiAgaWYoIXN0YXRlLmNhbmRpZGF0ZXMubGVuZ3RoKSByZXR1cm4gYWxlcnQoIkNoxrBhIGPDsyBr4bq/dCBxdeG6oyB0cmEgY+G7qXUuIik7CiAgY29uc3Qgc29ydGVkPVsuLi5zdGF0ZS5jYW5kaWRhdGVzXS5zb3J0KChhLGIpPT57CiAgICBjb25zdCBkYT1jYW5kaWRhdGVEYXRlU3RhdHVzKGEpLGRiPWNhbmRpZGF0ZURhdGVTdGF0dXMoYik7CiAgICBjb25zdCBwYT1kYS5lbGlnaWJsZT09PWZhbHNlPzE6MCxwYj1kYi5lbGlnaWJsZT09PWZhbHNlPzE6MDsKICAgIHJldHVybiBwYS1wYiB8fCBzY29yZUNhbmRpZGF0ZShiKS1zY29yZUNhbmRpZGF0ZShhKTsKICB9KTsKICBjb25zdCBwaWNrZWQ9c29ydGVkLnNsaWNlKDAsMyk7CiAgcGlja2VkLmZvckVhY2goKGMsaWR4KT0+ewogICAgY29uc3Qgb3JpZ2luYWw9c3RhdGUuY2FuZGlkYXRlcy5pbmRleE9mKGMpOwogICAgc2VsZWN0Q2FuZGlkYXRlVG9TbG90KG9yaWdpbmFsLCJEIisoaWR4KzEpKTsKICB9KTsKfQokKCJsaXZlU2VhcmNoQnRuIikub25jbGljaz1zZWFyY2hSZWFsUGF0ZW50czsKJCgidXNlQmVzdFF1ZXJ5Iikub25jbGljaz0oKT0+e3VzZUdlbmVyYXRlZFF1ZXJ5KCk7JCgibGl2ZVNlYXJjaFN0YXRlIikudGV4dENvbnRlbnQ9IsSQw6MgbuG6oXAgdHJ1eSB24bqlbiB04burIGLGsOG7m2MgQ2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdS4ifTsKJCgiYXV0b1BpY2tQcmlvciIpLm9uY2xpY2s9YXV0b1BpY2tEMTIzOwokKCJ0ZXN0QmFja2VuZCIpLm9uY2xpY2s9YXN5bmMoKT0+ewogICQoImJhY2tlbmRTdGF0dXMiKS50ZXh0Q29udGVudD0ixJBhbmcga2nhu4NtIHRyYS4uLiI7CiAgdHJ5ewogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCgiL2FwaS9oZWFsdGgiLHtjYWNoZToibm8tc3RvcmUifSk7CiAgICBjb25zdCBkPWF3YWl0IHIuanNvbigpOwogICAgaWYoIXIub2t8fCFkLm9rKSB0aHJvdyBuZXcgRXJyb3IoZC5lcnJvcnx8Iktow7RuZyBr4bq/dCBu4buRaSDEkcaw4bujYyIpOwogICAgY29uc3QgcD1kLnByb3ZpZGVyc3x8e307IGNvbnN0IHZlcj1kLnZlcnNpb24/YCDCtyB2JHtkLnZlcnNpb259YDoiIjsKICAgIHN0YXRlLnByb3ZpZGVycz1wOwogICAgc3RhdGUuY2xvdWRPY3I9cC5nb29nbGVfdmlzaW9uP3RydWU6bnVsbDsKICAgIGNvbnN0IHNlYXJjaE9rPXAuc2VycGFwaXx8cC5icm93c2VyX3J1bnx8cC5lcG9fb3BzOwogICAgY29uc3Qgb2NyVGV4dD1wLmdvb2dsZV92aXNpb24/IiDCtyBHb29nbGUgVmlzaW9uIE9DUiBz4bq1biBzw6BuZyI6IiDCtyBPQ1IgbG9jYWwgZmFsbGJhY2siOwogICAgJCgiYmFja2VuZFN0YXR1cyIpLmlubmVySFRNTD1zZWFyY2hPawogICAgICA/IGA8c3BhbiBjbGFzcz0iYmFja2VuZC1vayI+4pyTIEJhY2tlbmQgaG/huqF0IMSR4buZbmcuPC9zcGFuPiR7b2NyVGV4dH1gCiAgICAgIDogYDxzcGFuIGNsYXNzPSJiYWNrZW5kLW9rIj7inJMgQmFja2VuZCBob+G6oXQgxJHhu5luZy48L3NwYW4+IEdvb2dsZSBkaXJlY3QgY8OzIHRo4buDIGLhu4sgcmF0ZS1saW1pdCR7b2NyVGV4dH1gOwogIH1jYXRjaChlKXsKICAgICQoImJhY2tlbmRTdGF0dXMiKS5pbm5lckhUTUw9YDxzcGFuIGNsYXNzPSJiYWNrZW5kLWJhZCI+4pyVIEJhY2tlbmQ6ICR7ZXNjKGUubWVzc2FnZXx8ZSl9PC9zcGFuPmA7CiAgfQp9OwpmdW5jdGlvbiByZWFkUHJpb3IoKXtzdGF0ZS5wcmlvcj17RDE6e25vOiQoImQxTm8iKS52YWx1ZSxkYXRlOiQoImQxRGF0ZSIpLnZhbHVlLHRleHQ6JCgiZDFUZXh0IikudmFsdWV9LEQyOntubzokKCJkMk5vIikudmFsdWUsZGF0ZTokKCJkMkRhdGUiKS52YWx1ZSx0ZXh0OiQoImQyVGV4dCIpLnZhbHVlfSxEMzp7bm86JCgiZDNObyIpLnZhbHVlLGRhdGU6JCgiZDNEYXRlIikudmFsdWUsdGV4dDokKCJkM1RleHQiKS52YWx1ZX19fQokKCJ2YWxpZGF0ZVByaW9yIikub25jbGljaz0oKT0+e3JlYWRQcmlvcigpO2xldCBmaWxpbmc9JCgiZmlsaW5nRGF0ZSIpLnZhbHVlP25ldyBEYXRlKCQoImZpbGluZ0RhdGUiKS52YWx1ZSk6bnVsbCxodG1sPSI8c3Ryb25nPkvhur90IHF14bqjIGtp4buDbSB0cmEgdGjhu51pIGdpYW48L3N0cm9uZz48YnIvPiI7Zm9yKGNvbnN0W2ssdl1vZiBPYmplY3QuZW50cmllcyhzdGF0ZS5wcmlvcikpe2lmKCF2Lm5vKWNvbnRpbnVlO2xldCBvaz12LmRhdGUmJmZpbGluZyYmbmV3IERhdGUodi5kYXRlKTxmaWxpbmc7aHRtbCs9YCR7a30gwrcgJHtlc2Modi5ubyl9IMK3ICR7ZXNjKHYuZGF0ZXx8ImNoxrBhIGPDsyBuZ8OgeSIpfSDigJQgPHNwYW4gY2xhc3M9InBpbGwgJHtvaz8iZ3JlZW4iOiJ5ZWxsb3cifSI+JHtvaz8iQ8OzIHRo4buDIHBow7kgaOG7o3AgduG7gSB0aOG7nWkgZ2lhbiI6IkPhuqduIGtp4buDbSB0cmEifTwvc3Bhbj48YnIvPmB9JCgicHJpb3JDaGVjayIpLmlubmVySFRNTD1odG1sfTsKCmZ1bmN0aW9uIG1hdHJpeENvbmNlcHRzKGZlYXR1cmVUZXh0KXsKICBjb25zdCByYXc9U3RyaW5nKGZlYXR1cmVUZXh0fHwiIik7CiAgY29uc3QgY29uY2VwdHM9W107CiAgY29uc3QgcHVzaD14PT57CiAgICB4PVN0cmluZyh4fHwiIikudHJpbSgpLnRvTG93ZXJDYXNlKCk7CiAgICBpZih4Lmxlbmd0aDwzKSByZXR1cm47CiAgICBpZighY29uY2VwdHMuaW5jbHVkZXMoeCkpIGNvbmNlcHRzLnB1c2goeCk7CiAgfTsKCiAgLy8gT3JpZ2luYWwgc2lnbmlmaWNhbnQgVmlldG5hbWVzZS9FbmdsaXNoIHdvcmRzLgogIGZvcihjb25zdCB3IG9mIG1lYW5pbmdmdWxUb2tlbnMocmF3KSkgcHVzaCh3KTsKCiAgLy8gUGF0ZW50IGRpY3Rpb25hcnkgYmlsaW5ndWFsIGV4cGFuc2lvbi4KICBmb3IoY29uc3QgW2ssdmFsc10gb2YgT2JqZWN0LmVudHJpZXMoZGljdCkpewogICAgaWYoZm9sZFZOKHJhdykudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhmb2xkVk4oaykudG9Mb3dlckNhc2UoKSkpewogICAgICBwdXNoKGspOwogICAgICBmb3IoY29uc3QgdiBvZiB2YWxzKSBmb3IoY29uc3QgdyBvZiB2LnNwbGl0KC9ccysvKSkgcHVzaCh3KTsKICAgIH0KICB9CiAgcmV0dXJuIGNvbmNlcHRzLnNsaWNlKDAsMzApOwp9CgpmdW5jdGlvbiBzcGxpdEV2aWRlbmNlVW5pdHModGV4dCl7CiAgcmV0dXJuIG5vcm1hbGl6ZU9jclRleHQodGV4dHx8IiIpCiAgICAuc3BsaXQoL1xuK3woPzw9Wy4hPzs6XSlccysvKQogICAgLm1hcCh4PT54LnRyaW0oKSkKICAgIC5maWx0ZXIoeD0+eC5sZW5ndGg+PTIwKQogICAgLnNsaWNlKDAsODAwKTsKfQoKZnVuY3Rpb24gbG9jYWxFdmlkZW5jZUZvcihmZWF0dXJlLGRvY1RleHQpewogIGNvbnN0IHRleHQ9U3RyaW5nKGRvY1RleHR8fCIiKS50cmltKCk7CiAgaWYoIXRleHQgfHwgdGV4dD09PSLEkGFuZyBs4bqleSBu4buZaSBkdW5nIHBhdGVudC4uLiIpewogICAgcmV0dXJuIHtzdGF0dXM6IkNoxrBhIGPDsyBk4buvIGxp4buHdSIsZXZpZGVuY2U6IkNoxrBhIGPDsyBu4buZaSBkdW5nIEQxL0QyL0QzIMSR4buDIMSR4buRaSBjaGnhur91LiJ9OwogIH0KCiAgY29uc3QgY29uY2VwdHM9bWF0cml4Q29uY2VwdHMoZmVhdHVyZS50ZXh0KTsKICBpZighY29uY2VwdHMubGVuZ3RoKXsKICAgIHJldHVybiB7c3RhdHVzOiJDaMawYSBjaOG6r2MgY2jhuq9uIixldmlkZW5jZToiS2jDtG5nIHTDoWNoIMSRxrDhu6NjIMSR4bunIHRodeG6rXQgbmfhu68ga+G7uSB0aHXhuq10IMSR4buDIG1hcHBpbmcgdOG7sSDEkeG7mW5nLiJ9OwogIH0KCiAgY29uc3QgdW5pdHM9c3BsaXRFdmlkZW5jZVVuaXRzKHRleHQpOwogIGxldCBiZXN0PXtzY29yZTowLHVuaXQ6IiIsaGl0czpbXX07CgogIGZvcihjb25zdCB1IG9mIHVuaXRzKXsKICAgIGNvbnN0IGZ1PWZvbGRWTih1KS50b0xvd2VyQ2FzZSgpOwogICAgY29uc3QgaGl0cz1jb25jZXB0cy5maWx0ZXIoYz0+ZnUuaW5jbHVkZXMoZm9sZFZOKGMpLnRvTG93ZXJDYXNlKCkpKTsKICAgIGNvbnN0IHVuaXF1ZT1bLi4ubmV3IFNldChoaXRzKV07CiAgICBsZXQgc2NvcmU9dW5pcXVlLmxlbmd0aDsKICAgIGlmKHVuaXF1ZS5zb21lKHg9PnguaW5jbHVkZXMoImRyYWdvbiIpfHx4LmluY2x1ZGVzKCJnZXJtaW5hdGlvbiIpfHx4LmluY2x1ZGVzKCJjZWxsdWxhc2UiKXx8eC5pbmNsdWRlcygicGVjdGluYXNlIikpKSBzY29yZSs9MTsKICAgIGlmKHNjb3JlPmJlc3Quc2NvcmUpIGJlc3Q9e3Njb3JlLHVuaXQ6dSxoaXRzOnVuaXF1ZX07CiAgfQoKICBsZXQgc3RhdHVzPSJDaMawYSBjaOG6r2MgY2jhuq9uIjsKICBpZihiZXN0LnNjb3JlPj01KSBzdGF0dXM9IkPDsyI7CiAgZWxzZSBpZihiZXN0LnNjb3JlPj0zKSBzdGF0dXM9Ik3hu5l0IHBo4bqnbiI7CiAgZWxzZSBpZihiZXN0LnNjb3JlPj0xKSBzdGF0dXM9IkNoxrBhIGNo4bqvYyBjaOG6r24iOwogIGVsc2Ugc3RhdHVzPSJDaMawYSBjaOG6r2MgY2jhuq9uIjsgLy8gdjEwOiBraMO0bmcga+G6v3QgbHXhuq1uICJLaMO0bmcgdMOsbSB0aOG6pXkiIGNo4buJIHbDrCBoZXVyaXN0aWMga2jDtG5nIG1hdGNoLgoKICBjb25zdCBldmlkZW5jZT1iZXN0LnVuaXQKICAgID8gYCR7YmVzdC51bml0LnNsaWNlKDAsNDIwKX0ke2Jlc3QudW5pdC5sZW5ndGg+NDIwPyLigKYiOiIifWAKICAgIDoiQ2jGsGEgdMOsbSB0aOG6pXkgxJFv4bqhbiDEkeG7pyByw7UgYuG6sW5nIGhldXJpc3RpYzsgY+G6p24gQUkvY2h1ecOqbiBnaWEga2nhu4NtIHRyYSBu4buZaSBkdW5nIHBhdGVudC4iOwoKICByZXR1cm4ge3N0YXR1cyxldmlkZW5jZX07Cn0KCmZ1bmN0aW9uIGJ1aWxkTG9jYWxNYXRyaXgoKXsKICBjb25zdCByb3dzPVtdOwogIGZvcihjb25zdCBmIG9mIHN0YXRlLmZlYXR1cmVzKXsKICAgIGNvbnN0IHZhbHM9W107CiAgICBjb25zdCBub3Rlcz1bXTsKICAgIGZvcihjb25zdCBrIG9mIFsiRDEiLCJEMiIsIkQzIl0pewogICAgICBjb25zdCByPWxvY2FsRXZpZGVuY2VGb3IoZixzdGF0ZS5wcmlvcltrXT8udGV4dHx8IiIpOwogICAgICB2YWxzLnB1c2goci5zdGF0dXMpOwogICAgICBub3Rlcy5wdXNoKGAke2t9OiAke3IuZXZpZGVuY2V9YCk7CiAgICB9CiAgICByb3dzLnB1c2goW2YuaWQsLi4udmFscyxub3Rlcy5qb2luKCIgfCAiKV0pOwogIH0KICByZXR1cm4gcm93czsKfQoKYXN5bmMgZnVuY3Rpb24gYnVpbGRNYXRyaXhQcm8oKXsKICByZWFkUHJpb3IoKTsKICBpZighc3RhdGUuZmVhdHVyZXMubGVuZ3RoKSByZXR1cm4gYWxlcnQoIkNoxrBhIGPDsyBmZWF0dXJlLiIpOwoKICBjb25zdCBkb2NzPU9iamVjdC5lbnRyaWVzKHN0YXRlLnByaW9yKS5maWx0ZXIoKFtrLHZdKT0+diYmdi5ubyYmU3RyaW5nKHYudGV4dHx8IiIpLnRyaW0oKSk7CiAgaWYoIWRvY3MubGVuZ3RoKXsKICAgIHN0YXRlLm1hdHJpeD1zdGF0ZS5mZWF0dXJlcy5tYXAoZj0+WwogICAgICBmLmlkLCJDaMawYSBjw7MgZOG7ryBsaeG7h3UiLCJDaMawYSBjw7MgZOG7ryBsaeG7h3UiLCJDaMawYSBjw7MgZOG7ryBsaeG7h3UiLAogICAgICAiQ2jGsGEgY2jhu41uIGhv4bq3YyBjaMawYSB04bqjaSBu4buZaSBkdW5nIEQx4oCTRDMuIEjDo3kgcXVheSBs4bqhaSBixrDhu5tjIDUgdsOgIGNo4buNbiB0w6BpIGxp4buHdSDEkeG7kWkgY2jhu6luZy4iCiAgICBdKTsKICAgIHJlbmRlck1hdHJpeCgpOwogICAgcmV0dXJuOwogIH0KCiAgJCgibWF0cml4Qm9keSIpLmlubmVySFRNTD0nPHRyPjx0ZCBjb2xzcGFuPSI1IiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7Y29sb3I6IzY2NzA4NSI+xJBhbmcgdHLDrWNoIGV2aWRlbmNlIHRoZW8gdOG7q25nIGThuqV1IGhp4buHdeKApjwvdGQ+PC90cj4nOwoKICAvLyBO4bq/dSBjw7MgR0VNSU5JX0FQSV9LRVkgYmFja2VuZCBz4bq9IGTDuW5nIEdlbkFJOyBu4bq/dSBjaMawYSBjw7MgdGjDrCBmYWxsYmFjayBsb2NhbC4KICB0cnl7CiAgICBjb25zdCBwYXlsb2FkPXsKICAgICAgZmVhdHVyZXM6c3RhdGUuZmVhdHVyZXMubWFwKGY9Pih7aWQ6Zi5pZCx0ZXh0OmYudGV4dH0pKSwKICAgICAgZG9jdW1lbnRzOk9iamVjdC5mcm9tRW50cmllcyhbIkQxIiwiRDIiLCJEMyJdLm1hcChrPT5bCiAgICAgICAgayx7CiAgICAgICAgICBubzpzdGF0ZS5wcmlvcltrXT8ubm98fCIiLAogICAgICAgICAgdGV4dDpTdHJpbmcoc3RhdGUucHJpb3Jba10/LnRleHR8fCIiKS5zbGljZSgwLDIyMDAwKQogICAgICAgIH0KICAgICAgXSkpCiAgICB9OwogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCgiL2FwaS9tYXRyaXgiLHsKICAgICAgbWV0aG9kOiJQT1NUIiwKICAgICAgaGVhZGVyczp7ImNvbnRlbnQtdHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTpKU09OLnN0cmluZ2lmeShwYXlsb2FkKQogICAgfSk7CiAgICBjb25zdCBkPWF3YWl0IHIuanNvbigpLmNhdGNoKCgpPT4oe30pKTsKICAgIGlmKHIub2smJmQub2smJkFycmF5LmlzQXJyYXkoZC5yb3dzKSl7CiAgICAgIHN0YXRlLm1hdHJpeD1kLnJvd3MubWFwKHg9PlsKICAgICAgICB4LmZlYXR1cmVfaWQsCiAgICAgICAgeC5EMT8uc3RhdHVzfHwiQ2jGsGEgY2jhuq9jIGNo4bqvbiIsCiAgICAgICAgeC5EMj8uc3RhdHVzfHwiQ2jGsGEgY2jhuq9jIGNo4bqvbiIsCiAgICAgICAgeC5EMz8uc3RhdHVzfHwiQ2jGsGEgY2jhuq9jIGNo4bqvbiIsCiAgICAgICAgW3guRDEmJmBEMTogJHt4LkQxLmV2aWRlbmNlfHwiIn1gLHguRDImJmBEMjogJHt4LkQyLmV2aWRlbmNlfHwiIn1gLHguRDMmJmBEMzogJHt4LkQzLmV2aWRlbmNlfHwiIn1gXS5maWx0ZXIoQm9vbGVhbikuam9pbigiIHwgIikKICAgICAgXSk7CiAgICAgIHJlbmRlck1hdHJpeCgpOwogICAgICByZXR1cm47CiAgICB9CiAgfWNhdGNoKGUpe2NvbnNvbGUud2FybigiQUkgbWF0cml4IGZhbGxiYWNrOiIsZSl9CgogIHN0YXRlLm1hdHJpeD1idWlsZExvY2FsTWF0cml4KCk7CiAgcmVuZGVyTWF0cml4KCk7Cn0KCiQoImJ1aWxkTWF0cml4Iikub25jbGljaz1idWlsZE1hdHJpeFBybzsKCmZ1bmN0aW9uIHBpbGwodil7CiAgbGV0IGM9dj09PSJDw7MiPyJncmVlbiI6dj09PSJN4buZdCBwaOG6p24iPyJ5ZWxsb3ciOnY9PT0iS2jDtG5nIHTDrG0gdGjhuqV5Ij8icmVkIjp2PT09IkNoxrBhIGPDsyBk4buvIGxp4buHdSI/IiI6IiI7CiAgcmV0dXJuYDxzcGFuIGNsYXNzPSJwaWxsICR7Y30iPiR7dn08L3NwYW4+YAp9CmZ1bmN0aW9uIHJlbmRlck1hdHJpeCgpewogICQoIm1hdHJpeEJvZHkiKS5pbm5lckhUTUw9c3RhdGUubWF0cml4Lm1hcChyPT5gPHRyPgogICAgPHRkPjxzdHJvbmc+JHtyWzBdfTwvc3Ryb25nPjwvdGQ+CiAgICA8dGQ+JHtwaWxsKHJbMV0pfTwvdGQ+CiAgICA8dGQ+JHtwaWxsKHJbMl0pfTwvdGQ+CiAgICA8dGQ+JHtwaWxsKHJbM10pfTwvdGQ+CiAgICA8dGQgc3R5bGU9Im1pbi13aWR0aDo0MjBweCI+JHtlc2Mocls0XSl9PC90ZD4KICA8L3RyPmApLmpvaW4oIiIpCn0KCiQoInJ1bkFzc2Vzc21lbnQiKS5vbmNsaWNrPSgpPT57aWYoIXN0YXRlLm1hdHJpeC5sZW5ndGgpcmV0dXJuIGFsZXJ0KCJIw6N5IHThuqFvIG1hIHRy4bqtbiB0csaw4bubYy4iKTtsZXQgYWxsPVsxLDIsM10uZmlsdGVyKGM9PnN0YXRlLm1hdHJpeC5ldmVyeShyPT5yW2NdPT09IkPDsyIpKTtzdGF0ZS5hc3Nlc3NtZW50PXtub3ZlbHR5UmlzazphbGwubGVuZ3RoPyJS4bumSSBSTyBDQU8iOiJDSMavQSBQSMOBVCBISeG7hk4gTeG6pFQgVMONTkggTeG7mkkiLG5vdmVsdHlUZXh0OmFsbC5sZW5ndGg/YEPDsyAke2FsbC5tYXAoeD0+IkQiK3gpLmpvaW4oIiwgIil9IMSRxrDhu6NjIG1hcHBpbmcgYuG7mWMgbOG7mSB0b8OgbiBi4buZIGZlYXR1cmU7IGPhuqduIGtp4buDbSB0cmEgZXZpZGVuY2UuYDoiVHJvbmcgdOG6rXAgRDHigJNEMyBoaeG7h24gdOG6oWksIGNoxrBhIHjDoWMgxJHhu4tuaCBt4buZdCB0w6BpIGxp4buHdSDEkcahbiBs4bq7IGLhu5ljIGzhu5kgdG/DoG4gYuG7mSBk4bqldSBoaeG7h3UuIEvhur90IHF14bqjIGNo4buJIMOhcCBk4bulbmcgY2hvIHThuq1wIHTDoGkgbGnhu4d1IMSRYW5nIGto4bqjbyBzw6F0LiIsaW52ZW50aXZlUmlzazoiQ+G6pk4gQ0hVWcOKTiBHSUEiLGludmVudGl2ZVRleHQ6IkPhuqduIGNo4buNbiDEkeG7kWkgY2jhu6luZyBn4bqnbiBuaOG6pXQsIHjDoWMgxJHhu4tuaCBk4bqldSBoaeG7h3Uga2jDoWMgYmnhu4d0IHbDoCB24bqlbiDEkeG7gSBr4bu5IHRodeG6rXQga2jDoWNoIHF1YW4sIHNhdSDEkcOzIHhlbSB4w6l0IGxp4buHdSBwcmlvciBhcnQga2jDoWMgY8OzIGfhu6NpIMO9IGPDoWNoIGdp4bqjaSBxdXnhur90IGhheSBraMO0bmcuIn07cmVuZGVyQXNzZXNzbWVudCgpfTsKZnVuY3Rpb24gcmVuZGVyQXNzZXNzbWVudCgpeyQoIm5vdmVsdHlUZXh0IikudGV4dENvbnRlbnQ9c3RhdGUuYXNzZXNzbWVudC5ub3ZlbHR5VGV4dHx8IiI7JCgiaW52ZW50aXZlVGV4dCIpLnRleHRDb250ZW50PXN0YXRlLmFzc2Vzc21lbnQuaW52ZW50aXZlVGV4dHx8IiI7JCgibm92ZWx0eVJpc2siKS50ZXh0Q29udGVudD1zdGF0ZS5hc3Nlc3NtZW50Lm5vdmVsdHlSaXNrfHwiQ0jhu5wgROG7riBMSeG7hlUiOyQoImludmVudGl2ZVJpc2siKS50ZXh0Q29udGVudD1zdGF0ZS5hc3Nlc3NtZW50LmludmVudGl2ZVJpc2t8fCJDSOG7nCBE4buuIExJ4buGVSI7JCgibm92ZWx0eVJpc2siKS5jbGFzc05hbWU9InJpc2tib3ggIisoKHN0YXRlLmFzc2Vzc21lbnQubm92ZWx0eVJpc2t8fCIiKS5pbmNsdWRlcygiQ0FPIik/InJlZCI6ImdyZWVuIik7JCgiaW52ZW50aXZlUmlzayIpLmNsYXNzTmFtZT0icmlza2JveCB5ZWxsb3ciO3JlbmRlckV4cGVydCgpfQpmdW5jdGlvbiByZW5kZXJFeHBlcnQoKXtsZXQgcm93cz1bWyJE4bqldSBoaeG7h3Uga+G7uSB0aHXhuq10IixgJHtzdGF0ZS5mZWF0dXJlcy5sZW5ndGh9IGZlYXR1cmVgXSxbIkNoaeG6v24gbMaw4bujYyB0cmEgY+G7qXUiLGAke3N0YXRlLnF1ZXJpZXMubGVuZ3RofSBxdWVyeWBdLFsiUHJpb3IgYXJ0IixPYmplY3QudmFsdWVzKHN0YXRlLnByaW9yKS5maWx0ZXIoeD0+eCYmeC5ubykubWFwKHg9Pngubm8pLmpvaW4oIiwgIil8fCJDaMawYSBjw7MiXSxbIkLhuqNuZyDEkeG7kWkgY2hp4bq/dSIsYCR7c3RhdGUubWF0cml4Lmxlbmd0aH0gZmVhdHVyZWBdLFsiVMOtbmggbeG7m2kiLHN0YXRlLmFzc2Vzc21lbnQubm92ZWx0eVJpc2t8fCJDaMawYSDEkcOhbmggZ2nDoSJdLFsiVHLDrG5oIMSR4buZIHPDoW5nIHThuqFvIixzdGF0ZS5hc3Nlc3NtZW50LmludmVudGl2ZVJpc2t8fCJDaMawYSDEkcOhbmggZ2nDoSJdXTskKCJleHBlcnRCb2R5IikuaW5uZXJIVE1MPXJvd3MubWFwKChyLGkpPT5gPHRyPjx0ZD48c3Ryb25nPiR7clswXX08L3N0cm9uZz48L3RkPjx0ZD4ke2VzYyhyWzFdKX08L3RkPjx0ZD48c2VsZWN0IGRhdGEtcj0iJHtpfSI+PG9wdGlvbj5DaOG7nSByw6Agc2/DoXQ8L29wdGlvbj48b3B0aW9uPljDoWMgbmjhuq1uPC9vcHRpb24+PG9wdGlvbj5DaOG7iW5oIHPhu61hPC9vcHRpb24+PG9wdGlvbj5LaMO0bmcgxJHhu5NuZyDDvTwvb3B0aW9uPjwvc2VsZWN0PjwvdGQ+PHRkPjxpbnB1dCBwbGFjZWhvbGRlcj0iTmjhuq1uIHjDqXQgY2h1ecOqbiBnaWEiLz48L3RkPjwvdHI+YCkuam9pbigiIil9cmVuZGVyRXhwZXJ0KCk7CiQoInNhdmVSZXZpZXciKS5vbmNsaWNrPSgpPT57c3RhdGUucmV2aWV3cz1bLi4uZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtcl0iKV0uZmlsdGVyKHg9PngudmFsdWUhPT0iQ2jhu50gcsOgIHNvw6F0IikubGVuZ3RoO2FsZXJ0KCLEkMOjIGzGsHUgcsOgIHNvw6F0IHRyb25nIHBoacOqbiBoaeG7h24gdOG6oWkuIil9OwoKJCgiZ2VuUmVwb3J0Iikub25jbGljaz0oKT0+e3JlYWRQcmlvcigpO2xldCBjPXN0YXRlLmNsYWltc1tzdGF0ZS5zZWxlY3RlZF18fHN0YXRlLmNsYWltc1swXTskKCJyZXBvcnRDb250ZW50IikuaW5uZXJIVE1MPWAKPGgzPjEuIFRow7RuZyB0aW4gc8OhbmcgY2jhur88L2gzPjxkaXYgY2xhc3M9InN1bW1hcnkiPjxkaXY+TcOjIGNhc2U8L2Rpdj48ZGl2PiR7ZXNjKCQoImNhc2VJZCIpLnZhbHVlKX08L2Rpdj48ZGl2PlPhu5EgYuG6sW5nL2PDtG5nIGLhu5E8L2Rpdj48ZGl2PiR7ZXNjKCQoInBhdGVudE5vIikudmFsdWUpfTwvZGl2PjxkaXY+VMOqbiBzw6FuZyBjaOG6vzwvZGl2PjxkaXY+JHtlc2MoJCgidGl0bGUiKS52YWx1ZSl9PC9kaXY+PGRpdj5OZ8OgeSBu4buZcC/GsHUgdGnDqm48L2Rpdj48ZGl2PiR7ZXNjKCQoImZpbGluZ0RhdGUiKS52YWx1ZSl9PC9kaXY+PGRpdj5JUEMvQ1BDPC9kaXY+PGRpdj4ke2VzYygkKCJpcGMiKS52YWx1ZSl9PC9kaXY+PC9kaXY+CjxoMz4yLiBDbGFpbSDEkcaw4bujYyBwaMOibiB0w61jaDwvaDM+PHA+JHtlc2MoYz8udGV4dHx8IkNoxrBhIGNo4buNbiIpfTwvcD4KPGgzPjMuIEThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQ8L2gzPjxvbD4ke3N0YXRlLmZlYXR1cmVzLm1hcChmPT5gPGxpPjxzdHJvbmc+JHtmLmlkfTwvc3Ryb25nPiDigJQgJHtlc2MoZi50ZXh0KX08L2xpPmApLmpvaW4oIiIpfHwiPGxpPkNoxrBhIGPDszwvbGk+In08L29sPgo8aDM+NC4gQ2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdTwvaDM+PHVsPiR7c3RhdGUucXVlcmllcy5tYXAocT0+YDxsaT48Y29kZT4ke2VzYyhxKX08L2NvZGU+PC9saT5gKS5qb2luKCIiKXx8IjxsaT5DaMawYSB04bqhbzwvbGk+In08L3VsPgo8aDM+NS4gxJDDoW5oIGdpw6Egc8ahIGLhu5kgdMOtbmggbeG7m2k8L2gzPjxwPjxzdHJvbmc+JHtlc2Moc3RhdGUuYXNzZXNzbWVudC5ub3ZlbHR5Umlza3x8IkNoxrBhIMSRw6FuaCBnacOhIil9PC9zdHJvbmc+PC9wPjxwPiR7ZXNjKHN0YXRlLmFzc2Vzc21lbnQubm92ZWx0eVRleHR8fCIiKX08L3A+CjxoMz42LiBQaMOibiB0w61jaCBzxqEgYuG7mSB0csOsbmggxJHhu5kgc8OhbmcgdOG6oW88L2gzPjxwPjxzdHJvbmc+JHtlc2Moc3RhdGUuYXNzZXNzbWVudC5pbnZlbnRpdmVSaXNrfHwiQ2jGsGEgxJHDoW5oIGdpw6EiKX08L3N0cm9uZz48L3A+PHA+JHtlc2Moc3RhdGUuYXNzZXNzbWVudC5pbnZlbnRpdmVUZXh0fHwiIil9PC9wPjxwPjxzdHJvbmc+xJDhu5FpIGNo4bupbmcgZ+G6p24gbmjhuqV0Ojwvc3Ryb25nPiAke2VzYygkKCJjbG9zZXN0IikudmFsdWUpfTwvcD48cD48c3Ryb25nPkThuqV1IGhp4buHdSBraMOhYyBiaeG7h3Q6PC9zdHJvbmc+ICR7ZXNjKCQoImRpZmZlcmVuY2VzIikudmFsdWUpfTwvcD48cD48c3Ryb25nPlbhuqVuIMSR4buBIGvhu7kgdGh14bqtdCBraMOhY2ggcXVhbjo8L3N0cm9uZz4gJHtlc2MoJCgicHJvYmxlbSIpLnZhbHVlKX08L3A+PHA+PHN0cm9uZz5M4bqtcCBsdeG6rW46PC9zdHJvbmc+ICR7ZXNjKCQoInJlYXNvbmluZyIpLnZhbHVlKX08L3A+CjxoMz43LiBFeHBlcnQgcmV2aWV3PC9oMz48cD5T4buRIGjhuqFuZyBt4bulYyDEkcOjIMSRxrDhu6NjIHLDoCBzb8OhdDogPHN0cm9uZz4ke3N0YXRlLnJldmlld3N9PC9zdHJvbmc+LjwvcD4KPGRpdiBjbGFzcz0iY2FsbG91dCI+PHN0cm9uZz5MxrB1IMO9Ojwvc3Ryb25nPiDEkMOieSBsw6AgYsOhbyBjw6FvIHBow6JuIHTDrWNoIHPGoSBi4buZIHBo4bulYyB24bulIG5naGnDqm4gY+G7qXUsIGtow7RuZyBwaOG6o2kgw70ga2nhur9uIHBow6FwIGzDvSBjdeG7kWkgY8O5bmcuPC9kaXY+YH07Cgpjb25zdCBkZW1vPWAoMTIpIELhuqJOIE3DlCBU4bqiIFPDgU5HIENI4bq+IFRIVeG7mEMgQuG6sE5HIMSQ4buYQyBRVVnhu4BOIFPDgU5HIENI4bq+CigxMSkgMS0wMDQyMTgwCig1MSkgQTYxSyAzNi8zMzsgQTYxSyAzNi83NDY7IEEyM0wgMTkvMDA7IEEyM0wgMzMvMTAKKDIyKSAzMC8wNi8yMDIxCig3MykgQ8OUTkcgVFkgVE5ISCBOxq/hu5pDIMOJUCBQSMOaQyBIw4AgKFZOKQooNzQpIEPDtG5nIHR5IFROSEggVMawIHbhuqVuIGPDtG5nIG5naOG7hyB2w6AgU+G7nyBo4buvdSB0csOtIHR14buHIElQIEdST1VQCig1NCkgUVVZIFRSw4xOSCBT4bqiTiBYVeG6pFQgQuG7mFQgRElOSCBExq/hu6BORyBU4buqIEjhuqBUIFRIQU5IIExPTkcgTuG6olkgTeG6pk0KKDU3KSBTw6FuZyBjaOG6vyDEkeG7gSBj4bqtcCDEkeG6v24gYuG7mXQgZGluaCBkxrDhu6FuZyB04burIGjhuqF0IHRoYW5oIGxvbmcgbuG6o3kgbeG6p20gdGh1IMSRxrDhu6NjIHThu6sgbeG7mXQgcXV5IHRyw6xuaCBz4bqjbiB4deG6pXQuClnDilUgQ+G6plUgQuG6ok8gSOG7mAoxLiBRdXkgdHLDrG5oIHPhuqNuIHh14bqldCBi4buZdCBkaW5oIGTGsOG7oW5nIHThu6sgaOG6oXQgdGhhbmggbG9uZyBu4bqjeSBt4bqnbSBiYW8gZ+G7k206IChpKSBjaHXhuqluIGLhu4sgbmd1ecOqbiBsaeG7h3UgaOG6oXQgdGhhbmggbG9uZzsgKGlpKSB44butIGzDvSBi4bqxbmcgY2jhur8gcGjhuqltIGVuenltZSBjZWxsdWxhc2UgdsOgIHBlY3RpbmFzZTsgKGlpaSkgbmfDom0gdsOgIOG7pyDEkeG7gyBo4bqhdCBu4bqjeSBt4bqnbTsgKGl2KSBz4bqleTsgKHYpIG5naGnhu4FuOyAodmkpIGtp4buDbSB0cmEgxJHhu5NuZyBuaOG6pXQ7ICh2aWkpIHRow6ptIGLhu5l0IG5ow6B1OyAodmlpaSkgdGjDqm0gYuG7mXQgdGhhbmggbG9uZzsgKGl4KSB0aMOqbSB0aMOgbmggcGjhuqduIHBo4bulOyAoeCkga2nhu4NtIHRyYSDEkeG7k25nIG5o4bqldDsgKHhpKSBuZ2hp4buBbiB2w6AgxJFp4buBdSBjaOG7iW5oIMSR4buZIOG6qW07ICh4aWkpIMSRw7NuZyBnw7NpLgoyLiBRdXkgdHLDrG5oIHRoZW8gxJFp4buDbSAxLCB0cm9uZyDEkcOzIHRow6BuaCBwaOG6p24gcGjhu6UgYmFvIGfhu5NtIGNo4bqldCBi4bqjbyBxdeG6o24gdsOgIGNo4bqldCBjaOG7kW5nIHbDs24uCjMuIFF1eSB0csOsbmggdGhlbyDEkWnhu4NtIDEsIHRyb25nIMSRw7MgdGjDoG5oIHBo4bqnbiBjaOG6pXQgdOG6oW8gbmfhu410IHThu7Egbmhpw6puIGJhbyBn4buTbSBuaMOzbSBnbHVjaXQuYDsKJCgibG9hZERlbW8iKS5vbmNsaWNrPSgpPT57c3RhdGUucmF3VGV4dD1kZW1vO2xldCBtPWV4dHJhY3RNZXRhZGF0YShkZW1vKTtmaWxsTWV0YShtKTtsZXQgY3Q9Y2xlYW4oZGVtby5zbGljZShkZW1vLnNlYXJjaCgvWcOKVSBD4bqmVSBC4bqiTyBI4buYL2kpKyJZw4pVIEPhuqZVIELhuqJPIEjhu5giLmxlbmd0aCkpO3N0YXRlLmNsYWltc1RleHQ9Y3Q7JCgiY2xhaW1zUmF3IikudmFsdWU9Y3Q7JCgiY2xhaW1zQ2xlYW4iKS52YWx1ZT1mb3JtYXRDbGFpbUZvckRpc3BsYXkoY3QpO3N0YXRlLmNsYWltcz1wYXJzZUNsYWltcyhjdCk7cmVuZGVyQ2xhaW1zKCk7c2V0RGV0ZWN0KCJkZXRDbGFpbXMiLHRydWUsYMSQw6MgdMOhY2ggJHtzdGF0ZS5jbGFpbXMubGVuZ3RofSBjbGFpbWApOyQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjEwMCUiOyQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PSLEkMOjIG7huqFwIGRlbW8gUEgtVk4tMDEuIn07Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4=";
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
