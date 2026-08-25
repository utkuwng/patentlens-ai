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
        features:[{type:"DOCUMENT_TEXT_DETECTION"}]
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
      version: "11.1.0",
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
      const text=await googleVisionOcr(body.image_base64||"",env);
      return json({ok:true,provider:"Google Cloud Vision DOCUMENT_TEXT_DETECTION",text});
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

const APP_HTML_B64 = "PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InZpIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ii8+CjxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xIi8+Cjx0aXRsZT5QYXRlbnRMZW5zIEFJIOKAlCBRdXkgdHLDrG5oIHBow6JuIHTDrWNoIHPDoW5nIGNo4bq/PC90aXRsZT4KPG1ldGEgbmFtZT0iZGVzY3JpcHRpb24iIGNvbnRlbnQ9IlByb3RvdHlwZSBuZ2hpw6puIGPhu6l1IGjhu5cgdHLhu6MgdHJhIGPhu6l1IHbDoCDEkcOhbmggZ2nDoSBzxqEgYuG7mSBzw6FuZyBjaOG6vyB0aGVvIGNodeG7l2kgQ2xhaW0g4oaSIEZlYXR1cmUg4oaSIFNlYXJjaCDihpIgUHJpb3IgQXJ0IOKGkiBOb3ZlbHR5IOKGkiBJbnZlbnRpdmUgU3RlcCDihpIgRXhwZXJ0IFJldmlldy4iLz4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuanMuY2xvdWRmbGFyZS5jb20vYWpheC9saWJzL3BkZi5qcy8zLjExLjE3NC9wZGYubWluLmpzIj48L3NjcmlwdD4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9ucG0vdGVzc2VyYWN0LmpzQDUuMS4xL2Rpc3QvdGVzc2VyYWN0Lm1pbi5qcyI+PC9zY3JpcHQ+CjxzdHlsZT4KOnJvb3R7CiAgLS1iZzojZjZmN2Y5Oy0tc3VyZmFjZTojZmZmOy0tc3VyZmFjZTI6I2Y5ZmFmYjstLXRleHQ6IzEwMTgyODstLW11dGVkOiM2NjcwODU7CiAgLS1saW5lOiNlNGU3ZWM7LS1kYXJrOiMxMDE4Mjg7LS1zb2Z0OiNmMmY0Zjc7LS1ncmVlbjojMDY3NjQ3Oy0tZ3JlZW5iZzojZWNmZGYzOwogIC0teWVsbG93OiNiNTQ3MDg7LS15ZWxsb3diZzojZmZmYWViOy0tcmVkOiNiNDIzMTg7LS1yZWRiZzojZmVmM2YyOy0tYmx1ZTojMTc1Y2QzOwogIC0tYmx1ZWJnOiNlZmY4ZmY7LS1zaGFkb3c6MCAxMnB4IDM2cHggcmdiYSgxNiwyNCw0MCwuMDYpOy0tcmFkaXVzOjE4cHgKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH1odG1se3Njcm9sbC1iZWhhdmlvcjpzbW9vdGh9CmJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDp2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7Zm9udC1mYW1pbHk6SW50ZXIsdWktc2Fucy1zZXJpZiwtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwiU2Vnb2UgVUkiLFJvYm90byxBcmlhbCxzYW5zLXNlcmlmfQpidXR0b24saW5wdXQsdGV4dGFyZWEsc2VsZWN0e2ZvbnQ6aW5oZXJpdH1idXR0b257Y3Vyc29yOnBvaW50ZXJ9Ci5hcHB7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczoyNzVweCAxZnI7bWluLWhlaWdodDoxMDB2aH0KYXNpZGV7cG9zaXRpb246c3RpY2t5O3RvcDowO2hlaWdodDoxMDB2aDtiYWNrZ3JvdW5kOiMwZjExMTU7Y29sb3I6I2ZmZjtwYWRkaW5nOjI0cHggMThweDtib3JkZXItcmlnaHQ6MXB4IHNvbGlkICMyMjI4MzF9Ci5icmFuZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O3BhZGRpbmc6MCA4cHg7bWFyZ2luLWJvdHRvbToyNnB4fQoubG9nb3t3aWR0aDozOXB4O2hlaWdodDozOXB4O2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6IzExMTtkaXNwbGF5OmdyaWQ7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtd2VpZ2h0OjkwMH0KLmJyYW5kIHN0cm9uZ3tmb250LXNpemU6MTZweH0uYnJhbmQgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojOThhMmIzO21hcmdpbi10b3A6M3B4fQoucHJvY2Vzc3tkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo3cHh9Ci5wcm9jZXNzLWl0ZW17cGFkZGluZzoxMXB4IDEycHg7Ym9yZGVyLXJhZGl1czoxMnB4O2NvbG9yOiM4Zjk4YTY7ZGlzcGxheTpmbGV4O2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtmb250LXNpemU6MTNweH0KLnByb2Nlc3MtaXRlbSAubnt3aWR0aDoyNXB4O2hlaWdodDoyNXB4O2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7Ym9yZGVyLXJhZGl1czo4cHg7YmFja2dyb3VuZDojMjYyYjMzO2ZvbnQtc2l6ZToxMnB4fQoucHJvY2Vzcy1pdGVtLmFjdGl2ZXtiYWNrZ3JvdW5kOiMxZDIxMjg7Y29sb3I6I2ZmZn0KLnByb2Nlc3MtaXRlbS5kb25le2NvbG9yOiNkMGQ1ZGR9LnByb2Nlc3MtaXRlbS5kb25lIC5ue2JhY2tncm91bmQ6IzM0NDA1NDtjb2xvcjojZmZmfQouc2lkZS1ub3Rle3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MThweDtyaWdodDoxOHB4O2JvdHRvbToyMHB4O3BhZGRpbmc6MTRweDtib3JkZXItcmFkaXVzOjE0cHg7YmFja2dyb3VuZDojMTcxYTIwO2JvcmRlcjoxcHggc29saWQgIzI3MmMzNDtjb2xvcjojOThhMmIzO2ZvbnQtc2l6ZToxMnB4O2xpbmUtaGVpZ2h0OjEuNTV9Cm1haW57cGFkZGluZzozNHB4IDM4cHggMTIwcHg7bWluLXdpZHRoOjB9Ci50b3B7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTZweDttYXJnaW4tYm90dG9tOjIwcHh9Cmgxe2ZvbnQtc2l6ZToyOHB4O2xldHRlci1zcGFjaW5nOi0uMDRlbTttYXJnaW46MH0udG9wIHB7bWFyZ2luOjZweCAwIDA7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxNHB4fQouY2FzZS1iYWRnZXtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nOjlweCAxMnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7Y29sb3I6IzQ3NTQ2Nztmb250LXNpemU6MTJweDt3aGl0ZS1zcGFjZTpub3dyYXB9Ci5sb2NhbC1iYW5uZXJ7cGFkZGluZzoxM3B4IDE1cHg7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbi1ib3R0b206MTZweDtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU7Ym9yZGVyOjFweCBzb2xpZCAjZmVkZjg5O2JhY2tncm91bmQ6dmFyKC0teWVsbG93YmcpO2NvbG9yOiM3YTJlMGV9Ci5zZWN0aW9ue2Rpc3BsYXk6bm9uZX0uc2VjdGlvbi5hY3RpdmV7ZGlzcGxheTpibG9ja30KLnBhbmVse2JhY2tncm91bmQ6dmFyKC0tc3VyZmFjZSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3gtc2hhZG93OnZhcigtLXNoYWRvdyk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjRweDttYXJnaW4tYm90dG9tOjE4cHh9Ci5wYW5lbCBoMnttYXJnaW46MCAwIDZweDtmb250LXNpemU6MjBweDtsZXR0ZXItc3BhY2luZzotLjAyZW19LnN1Yntjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjE0cHg7bGluZS1oZWlnaHQ6MS41NTttYXJnaW4tYm90dG9tOjIwcHh9Ci5ncmlke2Rpc3BsYXk6Z3JpZDtnYXA6MTRweH0uZzJ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfS5nM3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9CmxhYmVse2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NzUwO2NvbG9yOiM0NzU0Njc7bWFyZ2luLWJvdHRvbTo3cHh9CmlucHV0LHRleHRhcmVhLHNlbGVjdHt3aWR0aDoxMDAlO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojZmZmO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEycHggMTNweDtvdXRsaW5lOm5vbmU7Y29sb3I6IzExMTgyN30KaW5wdXQ6Zm9jdXMsdGV4dGFyZWE6Zm9jdXMsc2VsZWN0OmZvY3Vze2JvcmRlci1jb2xvcjojOThhMmIzO2JveC1zaGFkb3c6MCAwIDAgM3B4IHJnYmEoMTcsMjQsMzksLjA1KX0KdGV4dGFyZWF7cmVzaXplOnZlcnRpY2FsO21pbi1oZWlnaHQ6MTEwcHh9Ci5kcm9we2JvcmRlcjoxLjVweCBkYXNoZWQgI2NmZDRkYztib3JkZXItcmFkaXVzOjE2cHg7YmFja2dyb3VuZDojZmFmYmZjO3BhZGRpbmc6MzBweDt0ZXh0LWFsaWduOmNlbnRlcjt0cmFuc2l0aW9uOi4yc30KLmRyb3AuZHJhZ3tib3JkZXItY29sb3I6IzY2NzA4NTtiYWNrZ3JvdW5kOiNmMmY0Zjd9LmRyb3Agc3Ryb25ne2Rpc3BsYXk6YmxvY2s7bWFyZ2luLWJvdHRvbTo2cHh9LmRyb3Agc21hbGx7Y29sb3I6dmFyKC0tbXV0ZWQpfQouYWN0aW9uc3tkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7ZmxleC13cmFwOndyYXA7bWFyZ2luLXRvcDoxNnB4fQouYnRue2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojZmZmO2NvbG9yOiMxMTE4Mjc7Ym9yZGVyLXJhZGl1czoxMXB4O3BhZGRpbmc6MTBweCAxNHB4O2ZvbnQtc2l6ZToxM3B4O2ZvbnQtd2VpZ2h0Ojc1MH0KLmJ0bjpob3ZlcntiYWNrZ3JvdW5kOiNmOGZhZmN9LmJ0bi5wcmltYXJ5e2JhY2tncm91bmQ6IzExMTgyNztjb2xvcjojZmZmO2JvcmRlci1jb2xvcjojMTExODI3fS5idG4uc3VjY2Vzc3tiYWNrZ3JvdW5kOnZhcigtLWdyZWVuYmcpO2NvbG9yOnZhcigtLWdyZWVuKTtib3JkZXItY29sb3I6I2FiZWZjNn0uYnRuLmRhbmdlcntjb2xvcjp2YXIoLS1yZWQpfQoucHJvZ3Jlc3N7aGVpZ2h0OjhweDtiYWNrZ3JvdW5kOiNlZWYwZjM7Ym9yZGVyLXJhZGl1czo5OXB4O292ZXJmbG93OmhpZGRlbjttYXJnaW4tdG9wOjE0cHh9LnByb2dyZXNzPmRpdntoZWlnaHQ6MTAwJTtiYWNrZ3JvdW5kOiMxMTE4Mjc7d2lkdGg6MCU7dHJhbnNpdGlvbjouMjVzfQouc3RhdHVze2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjhweDtsaW5lLWhlaWdodDoxLjV9Ci5kZXRlY3R7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNCwxZnIpO2dhcDoxMHB4fQouZGV0ZWN0LWNhcmR7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7cGFkZGluZzoxNHB4O2JhY2tncm91bmQ6I2ZmZn0KLmRldGVjdC1jYXJkIGJ7Zm9udC1zaXplOjEzcHh9LmRldGVjdC1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLXRvcDo0cHh9Ci5kZXRlY3QtY2FyZC5va3tiYWNrZ3JvdW5kOnZhcigtLWdyZWVuYmcpO2JvcmRlci1jb2xvcjojYWJlZmM2fS5kZXRlY3QtY2FyZC53YXJue2JhY2tncm91bmQ6dmFyKC0teWVsbG93YmcpO2JvcmRlci1jb2xvcjojZmVkZjg5fQouc3VtbWFyeXtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjE2MHB4IDFmcjtnYXA6OHB4IDE2cHg7Zm9udC1zaXplOjEzcHh9LnN1bW1hcnkgZGl2Om50aC1jaGlsZChvZGQpe2NvbG9yOiM2NjcwODV9Ci5jYWxsb3V0e3BhZGRpbmc6MTVweDtib3JkZXI6MXB4IHNvbGlkICNkMGQ1ZGQ7YmFja2dyb3VuZDojZjhmYWZjO2JvcmRlci1yYWRpdXM6MTRweDtjb2xvcjojNDc1NDY3O2ZvbnQtc2l6ZToxM3B4O2xpbmUtaGVpZ2h0OjEuNTV9LmNhbGxvdXQgc3Ryb25ne2NvbG9yOiMxMTE4Mjd9Ci50YWJsZS13cmFwe292ZXJmbG93OmF1dG87Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHh9dGFibGV7d2lkdGg6MTAwJTtib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7Zm9udC1zaXplOjEzcHh9dGh7YmFja2dyb3VuZDojZjhmYWZjO2NvbG9yOiM0NzU0Njc7dGV4dC1hbGlnbjpsZWZ0O2ZvbnQtc2l6ZToxMnB4fXRoLHRke3BhZGRpbmc6MTJweCAxMHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpO3ZlcnRpY2FsLWFsaWduOnRvcH10cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLnBpbGx7ZGlzcGxheTppbmxpbmUtZmxleDtwYWRkaW5nOjVweCA4cHg7Ym9yZGVyLXJhZGl1czo5OTlweDtiYWNrZ3JvdW5kOiNmMmY0Zjc7Y29sb3I6IzM0NDA1NDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo4MDB9LmdyZWVue2JhY2tncm91bmQ6dmFyKC0tZ3JlZW5iZyk7Y29sb3I6dmFyKC0tZ3JlZW4pfS55ZWxsb3d7YmFja2dyb3VuZDp2YXIoLS15ZWxsb3diZyk7Y29sb3I6dmFyKC0teWVsbG93KX0ucmVke2JhY2tncm91bmQ6dmFyKC0tcmVkYmcpO2NvbG9yOnZhcigtLXJlZCl9LmJsdWV7YmFja2dyb3VuZDp2YXIoLS1ibHVlYmcpO2NvbG9yOnZhcigtLWJsdWUpfQouY2xhaW0sLmRvY3tib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjE1cHg7YmFja2dyb3VuZDojZmZmfS5jbGFpbSsuY2xhaW0sLmRvYysuZG9je21hcmdpbi10b3A6MTBweH0uY2xhaW0gaDQsLmRvYyBoNHttYXJnaW46MCAwIDdweDtmb250LXNpemU6MTRweH0uY2xhaW0gcCwuZG9jIHB7bWFyZ2luOjA7Y29sb3I6IzVmNmI3YTtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU1fQouc3BsaXR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczptaW5tYXgoMCwxLjE1ZnIpIG1pbm1heCgzMjBweCwuODVmcik7Z2FwOjE4cHh9Ci5yaXNre2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTRweDthbGlnbi1pdGVtczpjZW50ZXI7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4fS5yaXNrIGgze21hcmdpbjowIDAgNXB4O2ZvbnQtc2l6ZToxNnB4fS5yaXNrIHB7bWFyZ2luOjA7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxM3B4fS5yaXNrYm94e21pbi13aWR0aDoxNDVweDt0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjEycHg7Ym9yZGVyLXJhZGl1czoxNHB4O2ZvbnQtd2VpZ2h0OjkwMH0KLmRpdmlkZXJ7aGVpZ2h0OjFweDtiYWNrZ3JvdW5kOnZhcigtLWxpbmUpO21hcmdpbjoxOHB4IDB9LmVtcHR5e3BhZGRpbmc6MjZweDtib3JkZXI6MXB4IGRhc2hlZCAjZDBkNWRkO2JvcmRlci1yYWRpdXM6MTRweDt0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjojOThhMmIzfQpjb2Rle2ZvbnQtZmFtaWx5OnVpLW1vbm9zcGFjZSxTRk1vbm8tUmVndWxhcixNZW5sbyxtb25vc3BhY2U7Zm9udC1zaXplOjEycHh9LnJlcG9ydHtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHg7cGFkZGluZzoyNHB4O2xpbmUtaGVpZ2h0OjEuNjV9LnJlcG9ydCBoM3ttYXJnaW4tdG9wOjI0cHh9LnJlcG9ydCBoMzpmaXJzdC1jaGlsZHttYXJnaW4tdG9wOjB9Ci53aXphcmRiYXJ7cG9zaXRpb246Zml4ZWQ7bGVmdDoyNzVweDtyaWdodDowO2JvdHRvbTowO2JhY2tncm91bmQ6cmdiYSgyNDYsMjQ3LDI0OSwuOTQpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWxpbmUpO3BhZGRpbmc6MTNweCAzOHB4O3otaW5kZXg6MjB9Ci53aXphcmRpbm5lcnttYXgtd2lkdGg6MTQwMHB4O21hcmdpbjphdXRvO2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEycHh9Ci53aXphcmRtZXRhe2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKX0ud2l6YXJkbWV0YSBzdHJvbmd7ZGlzcGxheTpibG9jaztjb2xvcjojMzQ0MDU0O2ZvbnQtc2l6ZToxM3B4O21hcmdpbi1ib3R0b206MnB4fQoubmV4dGJ0bnttaW4td2lkdGg6MTUwcHh9LmJhY2tidG57bWluLXdpZHRoOjEwNXB4fQouaGlkZGVue2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9CkBtZWRpYShtYXgtd2lkdGg6OTgwcHgpey5hcHB7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn1hc2lkZXtwb3NpdGlvbjpyZWxhdGl2ZTtoZWlnaHQ6YXV0b30uc2lkZS1ub3Rle3Bvc2l0aW9uOnN0YXRpYzttYXJnaW4tdG9wOjE4cHh9LnByb2Nlc3N7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpfW1haW57cGFkZGluZzoyMnB4IDE2cHggMTIwcHh9LmcyLC5nMywuc3BsaXQsLmRldGVjdHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS53aXphcmRiYXJ7bGVmdDowO3BhZGRpbmc6MTJweCAxNnB4fS50b3B7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59fQpAbWVkaWEgcHJpbnR7YXNpZGUsLnRvcCwud2l6YXJkYmFyLC5uby1wcmludCwuYWN0aW9uc3tkaXNwbGF5Om5vbmUhaW1wb3J0YW50fS5hcHB7ZGlzcGxheTpibG9ja31tYWlue3BhZGRpbmc6MH0uc2VjdGlvbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fSNyZXBvcnQuc2VjdGlvbntkaXNwbGF5OmJsb2NrIWltcG9ydGFudH0ucGFuZWx7Ym9yZGVyOjA7Ym94LXNoYWRvdzpub25lO3BhZGRpbmc6MH1ib2R5e2JhY2tncm91bmQ6I2ZmZn19CgovKiA9PT09PSB2NiBVWCByZWZpbmVtZW50cyA9PT09PSAqLwouY2xhaW0tY2xlYW57CiAgZm9udC1mYW1pbHk6QXJpYWwsIkhlbHZldGljYSBOZXVlIiwiU2Vnb2UgVUkiLHNhbnMtc2VyaWY7CiAgZm9udC1zaXplOjE0cHg7bGluZS1oZWlnaHQ6MS43ODtjb2xvcjojMzQ0MDU0O3doaXRlLXNwYWNlOnByZS13cmFwOwp9Ci5jbGFpbS1yYXd7CiAgZm9udC1mYW1pbHk6dWktbW9ub3NwYWNlLFNGTW9uby1SZWd1bGFyLE1lbmxvLENvbnNvbGFzLG1vbm9zcGFjZSFpbXBvcnRhbnQ7CiAgZm9udC1zaXplOjEycHghaW1wb3J0YW50O2xpbmUtaGVpZ2h0OjEuNiFpbXBvcnRhbnQ7YmFja2dyb3VuZDojZjhmYWZjIWltcG9ydGFudDsKfQouY2xhaW0tc3RlcHsKICBkaXNwbGF5OmJsb2NrO21hcmdpbjo4cHggMDtwYWRkaW5nLWxlZnQ6MTRweDtib3JkZXItbGVmdDoycHggc29saWQgI2U0ZTdlYzsKfQouZmVhdHVyZS1yZXZpZXctYmFyewogIHBvc2l0aW9uOnN0aWNreTt0b3A6MTJweDt6LWluZGV4Ojg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICBnYXA6MTZweDtwYWRkaW5nOjE0cHggMTZweDttYXJnaW46MTZweCAwO2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuOTYpOwogIGJhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JvcmRlcjoxcHggc29saWQgI2QwZDVkZDtib3JkZXItcmFkaXVzOjE0cHg7CiAgYm94LXNoYWRvdzowIDEwcHggMjhweCByZ2JhKDE2LDI0LDQwLC4wOSkKfQouZmVhdHVyZS1yZXZpZXctYmFyIC5tZXRhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEwcHg7ZmxleC13cmFwOndyYXB9Ci5mZWF0dXJlLXJldmlldy1iYXIgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5mZWF0dXJlLXJldmlldy1iYXIgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojNjY3MDg1O21hcmdpbi10b3A6M3B4fQouZmVhdHVyZS1jb25maXJtZWR7Ym9yZGVyLWNvbG9yOiNhYmVmYzY7YmFja2dyb3VuZDpyZ2JhKDIzNiwyNTMsMjQzLC45Nyl9Ci5zZWFyY2gtaGVyb3sKICBwYWRkaW5nOjE3cHg7Ym9yZGVyOjFweCBzb2xpZCAjZDBkNWRkO2JvcmRlci1yYWRpdXM6MTZweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxODBkZWcsI2ZmZiwjZjhmYWZjKTsKICBtYXJnaW4tYm90dG9tOjE2cHgKfQouc291cmNlLXJvd3tkaXNwbGF5OmZsZXg7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5zb3VyY2UtY2hpcHsKICBkaXNwbGF5OmlubGluZS1mbGV4O2dhcDo2cHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgI2QwZDVkZDtiYWNrZ3JvdW5kOiNmZmY7CiAgY29sb3I6IzM0NDA1NDtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6N3B4IDEwcHg7Zm9udC1zaXplOjEycHg7dGV4dC1kZWNvcmF0aW9uOm5vbmU7Zm9udC13ZWlnaHQ6NzAwCn0KLnNvdXJjZS1jaGlwOmhvdmVye2JhY2tncm91bmQ6I2YyZjRmN30KLnNlYXJjaC10b29sYmFye2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjEwcHg7bWFyZ2luLXRvcDoxNHB4fQouc2VhcmNoLXN0YXRle2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM2NjcwODU7bWFyZ2luLXRvcDoxMHB4O2xpbmUtaGVpZ2h0OjEuNX0KLnNlYXJjaC1yZXN1bHQtdGl0bGV7Zm9udC13ZWlnaHQ6NzUwO2NvbG9yOiMxMDE4Mjg7dGV4dC1kZWNvcmF0aW9uOm5vbmV9LnNlYXJjaC1yZXN1bHQtdGl0bGU6aG92ZXJ7dGV4dC1kZWNvcmF0aW9uOnVuZGVybGluZX0KLnNjb3Jle2ZvbnQtd2VpZ2h0Ojg1MDtmb250LXNpemU6MTNweH0KLnNjb3JlLmhpZ2h7Y29sb3I6IzA2NzY0N30uc2NvcmUubWlke2NvbG9yOiNiNTQ3MDh9LnNjb3JlLmxvd3tjb2xvcjojNjY3MDg1fQouY2FuZGlkYXRlLWFjdGlvbnN7ZGlzcGxheTpmbGV4O2dhcDo2cHg7ZmxleC13cmFwOndyYXB9Ci5zbG90YnRue3BhZGRpbmc6NnB4IDlweDtib3JkZXItcmFkaXVzOjlweDtib3JkZXI6MXB4IHNvbGlkICNkMGQ1ZGQ7YmFja2dyb3VuZDojZmZmO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MH0KLnNsb3RidG46aG92ZXJ7YmFja2dyb3VuZDojZjJmNGY3fQoucHJpb3Itc2xvdHsKICBib3JkZXI6MXB4IHNvbGlkICNlNGU3ZWM7Ym9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MTRweDtiYWNrZ3JvdW5kOiNmZmYKfQoucHJpb3Itc2xvdC5zZWxlY3RlZHtib3JkZXItY29sb3I6Izg0YWRmZjtib3gtc2hhZG93OjAgMCAwIDNweCAjZWZmOGZmfQouc2V0dGluZ3MtZ3JpZHtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmVuZH0KLmJhY2tlbmQtb2t7Y29sb3I6IzA2NzY0N30uYmFja2VuZC1iYWR7Y29sb3I6I2I0MjMxOH0KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgLmZlYXR1cmUtcmV2aWV3LWJhcntwb3NpdGlvbjpzdGF0aWM7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59CiAgLnNlYXJjaC10b29sYmFyLC5zZXR0aW5ncy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9Cn0KCjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+CjxkaXYgY2xhc3M9ImFwcCI+Cjxhc2lkZT4KICA8ZGl2IGNsYXNzPSJicmFuZCI+PGRpdiBjbGFzcz0ibG9nbyI+UDwvZGl2PjxkaXY+PHN0cm9uZz5QYXRlbnRMZW5zIEFJPC9zdHJvbmc+PHNtYWxsPlByb3RvdHlwZSBuZ2hpw6puIGPhu6l1IMK3IEZ1bGwtc3RhY2sgdjExLjEgVk4gT0NSPC9zbWFsbD48L2Rpdj48L2Rpdj4KICA8ZGl2IGNsYXNzPSJwcm9jZXNzIiBpZD0icHJvY2VzcyI+PC9kaXY+CiAgPGRpdiBjbGFzcz0ic2lkZS1ub3RlIj48c3Ryb25nIHN0eWxlPSJjb2xvcjojZmZmIj5QaOG6oW0gdmkgcHJvdG90eXBlPC9zdHJvbmc+PGJyLz5I4buXIHRy4bujIGNodeG7l2kgdHJhIGPhu6l1IHbDoCDEkcOhbmggZ2nDoSBzxqEgYuG7mSBzw6FuZyBjaOG6vy4gS2jDtG5nIHRoYXkgdGjhur8gY2h1ecOqbiBnaWEgdsOgIGtow7RuZyDEkeG6oWkgZGnhu4duIHRvw6BuIGLhu5kgcXV5IHRyw6xuaCB4w6FjIGzhuq1wIHF1eeG7gW4gY+G7p2EgSVAgR1JPVVAuPC9kaXY+CjwvYXNpZGU+Cgo8bWFpbj4KICA8ZGl2IGNsYXNzPSJ0b3AiPjxkaXY+PGgxIGlkPSJwYWdlVGl0bGUiPjwvaDE+PHAgaWQ9InBhZ2VTdWIiPjwvcD48L2Rpdj48ZGl2IGNsYXNzPSJjYXNlLWJhZGdlIiBpZD0iY2FzZUJhZGdlIj5DaMawYSBjw7MgY2FzZTwvZGl2PjwvZGl2PgogIDxkaXYgY2xhc3M9ImxvY2FsLWJhbm5lciIgaWQ9ImxvY2FsQmFubmVyIiBzdHlsZT0iZGlzcGxheTpub25lIj5C4bqhbiDEkWFuZyBt4bufIGLhurFuZyA8c3Ryb25nPmZpbGU6Ly88L3N0cm9uZz4uIENocm9tZSBjw7MgdGjhu4MgY2jhurduIFdlYiBXb3JrZXIgZMO5bmcgY2hvIE9DUi4gQuG6o24gbsOgeSB24bqrbiBj4buRIMSR4buNYyBQREYgYuG6sW5nIHRleHQgbGF5ZXI7IMSR4buDIE9DUiDhu5VuIMSR4buLbmgsIG7Dqm4gY2jhuqF5IGLhurFuZyA8c3Ryb25nPkdpdEh1YiBQYWdlczwvc3Ryb25nPiBob+G6t2MgbG9jYWwgc2VydmVyICh2w60gZOG7pSA8Y29kZT5weXRob24zIC1tIGh0dHAuc2VydmVyPC9jb2RlPikuPC9kaXY+CgogIDxzZWN0aW9uIGlkPSJpbnRha2UiIGNsYXNzPSJzZWN0aW9uIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPjEuIFThuqNpIHTDoGkgbGnhu4d1IHPDoW5nIGNo4bq/PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5I4buHIHRo4buRbmcgdOG7sSDEkeG7jWMgUERGLiBO4bq/dSBmaWxlIGPDsyB0ZXh0IGxheWVyIHPhur0gdHLDrWNoIHRy4buxYyB0aeG6v3A7IG7hur91IGzDoCBi4bqjbiBzY2FuLCBo4buHIHRo4buRbmcgdOG7sSBjaHV54buDbiBzYW5nIE9DUiDEkeG7gyBj4buRIGfhuq9uZyBuaOG6rW4gZGnhu4duIG1ldGFkYXRhIHbDoCB5w6p1IGPhuqd1IGLhuqNvIGjhu5kuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImRyb3AiIGlkPSJkcm9wWm9uZSI+CiAgICAgICAgPHN0cm9uZz5UaOG6oyBQREYgdsOgbyDEkcOieSBob+G6t2MgY2jhu41uIGZpbGU8L3N0cm9uZz4KICAgICAgICA8c21hbGw+SOG7lyB0cuG7oyBQREYgcGF0ZW50IHRp4bq/bmcgVmnhu4d0L0FuaC4gT0NSIGPDsyB0aOG7gyBt4bqldCB2w6BpIHBow7p0IHbhu5tpIGLhuqNuIHNjYW4uPC9zbWFsbD48YnIvPjxici8+CiAgICAgICAgPGlucHV0IGlkPSJwZGZJbnB1dCIgdHlwZT0iZmlsZSIgYWNjZXB0PSJhcHBsaWNhdGlvbi9wZGYiIHN0eWxlPSJtYXgtd2lkdGg6NDIwcHgiLz4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InByb2dyZXNzIj48ZGl2IGlkPSJwcm9ncmVzc0JhciI+PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXR1cyIgaWQ9InBkZlN0YXR1cyI+Q2jGsGEgY8OzIGZpbGUuPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj5L4bq/dCBxdeG6oyBuaOG6rW4gZGnhu4duIHThu7EgxJHhu5luZzwvaDI+CiAgICAgIDxkaXYgY2xhc3M9ImRldGVjdCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZGV0ZWN0LWNhcmQiIGlkPSJkZXRNZXRhIj48Yj5NZXRhZGF0YTwvYj48c3Bhbj5DaMawYSB44butIGzDvTwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkZXRlY3QtY2FyZCIgaWQ9ImRldEFic3RyYWN0Ij48Yj5Uw7NtIHThuq90PC9iPjxzcGFuPkNoxrBhIHjhu60gbMO9PC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRldGVjdC1jYXJkIiBpZD0iZGV0Q2xhaW1zIj48Yj5Zw6p1IGPhuqd1IGLhuqNvIGjhu5k8L2I+PHNwYW4+Q2jGsGEgeOG7rSBsw708L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZGV0ZWN0LWNhcmQiIGlkPSJkZXRPQ1IiPjxiPk9DUjwvYj48c3Bhbj5DaMawYSBj4bqnbjwvc3Bhbj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj5UaMO0bmcgdGluIHPDoW5nIGNo4bq/PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5Dw6FjIHRyxrDhu51uZyDEkcaw4bujYyB04buxIMSRaeG7gW4gdOG7qyBQREY7IG5nxrDhu51pIGTDuW5nIGPDsyB0aOG7gyBz4butYSBu4bq/dSBuaOG6rW4gZGnhu4duIHNhaS48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMyI+CiAgICAgICAgPGRpdj48bGFiZWw+TcOjIGNhc2U8L2xhYmVsPjxpbnB1dCBpZD0iY2FzZUlkIi8+PC9kaXY+CiAgICAgICAgPGRpdj48bGFiZWw+U+G7kSBi4bqxbmcgLyBz4buRIGPDtG5nIGLhu5E8L2xhYmVsPjxpbnB1dCBpZD0icGF0ZW50Tm8iLz48L2Rpdj4KICAgICAgICA8ZGl2PjxsYWJlbD5RdeG7kWMgZ2lhIC8gaOG7hyB0aOG7kW5nPC9sYWJlbD48c2VsZWN0IGlkPSJqdXJpc2RpY3Rpb24iPjxvcHRpb24+Vk48L29wdGlvbj48b3B0aW9uPlVTPC9vcHRpb24+PG9wdGlvbj5XTy9QQ1Q8L29wdGlvbj48b3B0aW9uPkVQPC9vcHRpb24+PG9wdGlvbj5LaMOhYzwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPGRpdj48bGFiZWw+VMOqbiBzw6FuZyBjaOG6vzwvbGFiZWw+PGlucHV0IGlkPSJ0aXRsZSIvPjwvZGl2PgogICAgICAgIDxkaXY+PGxhYmVsPk5nw6B5IG7hu5lwIMSRxqFuIC8gbmfDoHkgxrB1IHRpw6puPC9sYWJlbD48aW5wdXQgaWQ9ImZpbGluZ0RhdGUiIHR5cGU9ImRhdGUiLz48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIDxkaXY+PGxhYmVsPkNo4bunIMSRxqFuIC8gY2jhu6cgYuG6sW5nPC9sYWJlbD48aW5wdXQgaWQ9ImFwcGxpY2FudCIvPjwvZGl2PgogICAgICAgIDxkaXY+PGxhYmVsPsSQ4bqhaSBkaeG7h24gU0hUVDwvbGFiZWw+PGlucHV0IGlkPSJyZXByZXNlbnRhdGl2ZSIvPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij48bGFiZWw+SVBDIC8gQ1BDPC9sYWJlbD48aW5wdXQgaWQ9ImlwYyIvPjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxsYWJlbD5Uw7NtIHThuq90PC9sYWJlbD48dGV4dGFyZWEgaWQ9ImFic3RyYWN0Ij48L3RleHRhcmVhPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIG5vLXByaW50Ij48YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9InJldHJ5T0NSIj5U4buxIHF1w6l0IE9DUiB5w6p1IGPhuqd1IGLhuqNvIGjhu5k8L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJsb2FkRGVtbyI+TuG6oXAgZGVtbyBQSC1WTi0wMTwvYnV0dG9uPjwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgoKICA8c2VjdGlvbiBpZD0iY2xhaW1zIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj4yLiBYw6FjIMSR4buLbmggecOqdSBj4bqndSBi4bqjbyBo4buZPC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5I4buHIHRo4buRbmcgbMOgbSBz4bqhY2ggdsSDbiBi4bqjbiBPQ1IgdHLGsOG7m2Mga2hpIGhp4buDbiB0aOG7iy4gQuG6o24gT0NSIHRow7QgduG6q24gxJHGsOG7o2MgZ2nhu68gxJHhu4MgxJHhu5FpIGNoaeG6v3Uga2hpIGPhuqduLjwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic3BsaXQiPgogICAgICAgIDxkaXY+CiAgICAgICAgICA8bGFiZWw+QuG6o24gecOqdSBj4bqndSBi4bqjbyBo4buZIMSRw6MgY2h14bqpbiBow7NhPC9sYWJlbD4KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0iY2xhaW1zQ2xlYW4iIGNsYXNzPSJjbGFpbS1jbGVhbiIgc3R5bGU9Im1pbi1oZWlnaHQ6MzkwcHgiIHBsYWNlaG9sZGVyPSJO4buZaSBkdW5nIGNsYWltcyDEkcOjIGzDoG0gc+G6oWNoIHPhur0gaGnhu4NuIHRo4buLIHThuqFpIMSRw6J5LiI+PC90ZXh0YXJlYT4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9InBhcnNlQ2xhaW1zIj5DaHXhuqluIGjDs2EgJiB0w6FjaCBs4bqhaSBjbGFpbXM8L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ib2NyQ2xhaW1zQWdhaW4iPlThu7EgcXXDqXQgT0NSIGNsYWltczwvYnV0dG9uPgogICAgICAgICAgPC9kaXY+CgogICAgICAgICAgPGRldGFpbHMgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgICAgIDxzdW1tYXJ5IHN0eWxlPSJjdXJzb3I6cG9pbnRlcjtmb250LXNpemU6MTJweDtjb2xvcjojNjY3MDg1Ij5YZW0gYuG6o24gT0NSIHRow7QgLyBjaOG7iW5oIHRheTwvc3VtbWFyeT4KICAgICAgICAgICAgPHRleHRhcmVhIGlkPSJjbGFpbXNSYXciIGNsYXNzPSJjbGFpbS1yYXciIHN0eWxlPSJtaW4taGVpZ2h0OjIzMHB4O21hcmdpbi10b3A6MTBweCIgcGxhY2Vob2xkZXI9IkLhuqNuIE9DUiB0aMO0LiI+PC90ZXh0YXJlYT4KICAgICAgICAgIDwvZGV0YWlscz4KICAgICAgICA8L2Rpdj4KCiAgICAgICAgPGRpdj4KICAgICAgICAgIDxsYWJlbD5EYW5oIHPDoWNoIGNsYWltczwvbGFiZWw+CiAgICAgICAgICA8ZGl2IGlkPSJjbGFpbUxpc3QiIGNsYXNzPSJlbXB0eSI+Q2jGsGEgY8OzIGNsYWltLjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9ImZlYXR1cmVzIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj4zLiBQaMOibiB0w61jaCBk4bqldSBoaeG7h3Uga+G7uSB0aHXhuq10PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5Uw6FjaCBjbGFpbSDEkcOjIGNo4buNbiB0aMOgbmggdOG7q25nIGThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQgxJHhu4MgcGjhu6VjIHbhu6UgdHJhIGPhu6l1IHbDoCBs4bqtcCBi4bqjbmcgc28gc8OhbmguIELhu5kgZOG6pXUgaGnhu4d1IMSRxrDhu6NjIHBow6lwIGNo4buJbmggc+G7rWEgdHLGsOG7m2Mga2hpIHjDoWMgbmjhuq1uLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj48ZGl2PjxsYWJlbD5DbGFpbSBj4bqnbiBwaMOibiB0w61jaDwvbGFiZWw+PHNlbGVjdCBpZD0iY2xhaW1TZWxlY3QiPjwvc2VsZWN0PjwvZGl2PjxkaXY+PGxhYmVsPlRy4bqhbmcgdGjDoWk8L2xhYmVsPjxpbnB1dCBpZD0iZmVhdHVyZVN0YXR1cyIgdmFsdWU9IkNoxrBhIHThuqFvIiByZWFkb25seS8+PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZlYXR1cmUtcmV2aWV3LWJhciIgaWQ9ImZlYXR1cmVSZXZpZXdCYXIiPgogICAgICAgIDxkaXYgY2xhc3M9Im1ldGEiPgogICAgICAgICAgPHNwYW4gY2xhc3M9InBpbGwgeWVsbG93IiBpZD0iZmVhdHVyZVN0YXR1c0JhZGdlIj5DaMawYSB4w6FjIG5o4bqtbjwvc3Bhbj4KICAgICAgICAgIDxkaXY+PHN0cm9uZyBpZD0iZmVhdHVyZUNvdW50TGFiZWwiPkNoxrBhIGPDsyBk4bqldSBoaeG7h3U8L3N0cm9uZz48c21hbGw+S2nhu4NtIHRyYSBu4buZaSBkdW5nIHRyxrDhu5tjIGtoaSBraMOzYSBi4buZIGThuqV1IGhp4buHdSDEkeG7gyB0cmEgY+G7qXUuPC9zbWFsbD48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIiBzdHlsZT0ibWFyZ2luLXRvcDowIj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9ImF1dG9GZWF0dXJlcyI+VOG6oW8gLyB0w6FjaCBs4bqhaTwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJjb25maXJtRmVhdHVyZXMiPuKckyBYw6FjIG5o4bqtbiBi4buZIGThuqV1IGhp4buHdTwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCIgc3R5bGU9Im1hcmdpbi10b3A6MThweCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPk3DozwvdGg+PHRoPkThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQ8L3RoPjx0aD5OaMOzbTwvdGg+PHRoPsSQ4buZIHRpbiBj4bqteTwvdGg+PHRoPjwvdGg+PC90cj48L3RoZWFkPjx0Ym9keSBpZD0iZmVhdHVyZUJvZHkiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9InNlYXJjaCIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+NC4gWMOieSBk4buxbmcgY2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdTwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN1YiI+VOG7qyBi4buZIGThuqV1IGhp4buHdSDEkcOjIHjDoWMgbmjhuq1uLCBo4buHIHRo4buRbmcgc2luaCB04burIGtow7NhIHbDoCBjw6J1IGzhu4duaCBzxqEgYuG7mS4gxJDDonkgbMOgIGLGsOG7m2MgaOG7lyB0cuG7oyBjaHV5w6puIGdpYSB4w6J5IGThu7FuZyB2w6AgbOG6t3AgbOG6oWkgY2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdS48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+PGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJnZW5TZWFyY2giPlThuqFvIGNoaeG6v24gbMaw4bujYyB0cmEgY+G7qXU8L2J1dHRvbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCIgc3R5bGU9Im1hcmdpbi10b3A6MThweCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPkZlYXR1cmU8L3RoPjx0aD5U4burIGtow7NhIGNow61uaDwvdGg+PHRoPkJp4bq/biB0aOG7gyAvIHN5bm9ueW08L3RoPjx0aD5JUEMvQ1BDIGfhu6NpIMO9PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5IGlkPSJzZWFyY2hCb2R5Ij48L3Rib2R5PjwvdGFibGU+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImRpdmlkZXIiPjwvZGl2PjxsYWJlbD5Dw6J1IGzhu4duaCBn4bujaSDDvTwvbGFiZWw+PGRpdiBpZD0icXVlcnlMaXN0IiBjbGFzcz0iZ3JpZCI+PC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CgogIDxzZWN0aW9uIGlkPSJwcmlvciIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+NS4gVMOsbSAmIHPDoG5nIGzhu41jIHTDoGkgbGnhu4d1IMSR4buRaSBjaOG7qW5nPC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj4KICAgICAgICBI4buHIHRo4buRbmcgdOG6oW8gdHJ1eSB24bqlbiB04burIGLhu5kgZOG6pXUgaGnhu4d1LCB0w6xtIHBhdGVudCB0aOG6rXQgcXVhIGJhY2tlbmQgR29vZ2xlIFBhdGVudHMsIHjhur9wIGjhuqFuZyB0aGVvIMSR4buZIGxpw6puIHF1YW4gdsOgIMSRaeG7gXUga2nhu4duIHRo4budaSBnaWFuLAogICAgICAgIHNhdSDEkcOzIGNobyBwaMOpcCBjaOG7jW4gdHLhu7FjIHRp4bq/cCBEMeKAk0QzLiBXSVBPIFBBVEVOVFNDT1BFIHbDoCBFc3BhY2VuZXQgxJHGsOG7o2MgZMO5bmcgbMOgbSBuZ3Xhu5NuIGtp4buDbSBjaOG7qW5nIGLhu5Ugc3VuZy4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtaGVybyI+CiAgICAgICAgPGRpdiBjbGFzcz0ic291cmNlLXJvdyI+CiAgICAgICAgICA8c3Ryb25nIHN0eWxlPSJmb250LXNpemU6MTNweCI+Tmd14buTbiB0cmEgY+G7qXU6PC9zdHJvbmc+CiAgICAgICAgICA8YSBjbGFzcz0ic291cmNlLWNoaXAiIGlkPSJncExpbmsiIGhyZWY9Imh0dHBzOi8vcGF0ZW50cy5nb29nbGUuY29tLyIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkdvb2dsZSBQYXRlbnRzIOKGlzwvYT4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaWQ9IndpcG9MaW5rIiBocmVmPSJodHRwczovL3BhdGVudHNjb3BlLndpcG8uaW50LyIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPldJUE8gUEFURU5UU0NPUEUg4oaXPC9hPgogICAgICAgICAgPGEgY2xhc3M9InNvdXJjZS1jaGlwIiBpZD0iZXBvTGluayIgaHJlZj0iaHR0cHM6Ly93b3JsZHdpZGUuZXNwYWNlbmV0LmNvbS8iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj5FUE8gRXNwYWNlbmV0IOKGlzwvYT4KICAgICAgICA8L2Rpdj4KCiAgICAgICAgPGRpdiBjbGFzcz0ic2VhcmNoLXRvb2xiYXIiPgogICAgICAgICAgPGlucHV0IGlkPSJsaXZlU2VhcmNoUXVlcnkiIHBsYWNlaG9sZGVyPSdWw60gZOG7pTogImRyYWdvbiBmcnVpdCBzZWVkIiBjZWxsdWxhc2UgcGVjdGluYXNlJz4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0ibGl2ZVNlYXJjaEJ0biI+4oyVIFTDrG0gdMOgaSBsaeG7h3UgdGjhuq10PC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ic2VhcmNoLXN0YXRlIiBpZD0ibGl2ZVNlYXJjaFN0YXRlIj5DaMawYSBjaOG6oXkgdHJhIGPhu6l1LjwvZGl2PgoKICAgICAgICA8ZGl2IGNsYXNzPSJjYWxsb3V0IiBzdHlsZT0ibWFyZ2luLXRvcDoxM3B4Ij4KICAgICAgPHN0cm9uZz5CYWNrZW5kIHTDrWNoIGjhu6NwIGPDuW5nIHdlYnNpdGU8L3N0cm9uZz48YnI+CiAgICAgIELhuqNuIGZ1bGwtc3RhY2sgc+G7rSBk4bulbmcgQVBJIGPDuW5nIGRvbWFpbiAoPGNvZGU+L2FwaS8qPC9jb2RlPiksIG7Dqm4ga2jDtG5nIGPhuqduIG5o4bqtcCBXb3JrZXIgVVJMIHJpw6puZy4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0idGVzdEJhY2tlbmQiPktp4buDbSB0cmEgYmFja2VuZDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdHVzIiBpZD0iYmFja2VuZFN0YXR1cyI+Q2jGsGEga2nhu4NtIHRyYSBr4bq/dCBu4buRaS48L2Rpdj4KICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InVzZUJlc3RRdWVyeSI+RMO5bmcgdHJ1eSB24bqlbiB04burIGLGsOG7m2MgNDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzdWNjZXNzIiBpZD0iYXV0b1BpY2tQcmlvciI+VOG7sSBn4bujaSDDvSBEMeKAk0QzPC9idXR0b24+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCIgc3R5bGU9Im1hcmdpbi10b3A6MTZweCI+CiAgICAgICAgPHRhYmxlPgogICAgICAgICAgPHRoZWFkPgogICAgICAgICAgICA8dHI+CiAgICAgICAgICAgICAgPHRoPiM8L3RoPjx0aD5Uw6BpIGxp4buHdSB0aOG6rXQ8L3RoPjx0aD5OZ8OgeTwvdGg+PHRoPsSQ4buZIHBow7kgaOG7o3A8L3RoPjx0aD7EkGnhu4F1IGtp4buHbiB0aOG7nWkgZ2lhbjwvdGg+PHRoPkNo4buNbjwvdGg+CiAgICAgICAgICAgIDwvdHI+CiAgICAgICAgICA8L3RoZWFkPgogICAgICAgICAgPHRib2R5IGlkPSJjYW5kaWRhdGVCb2R5Ij4KICAgICAgICAgICAgPHRyPjx0ZCBjb2xzcGFuPSI2IiBzdHlsZT0iY29sb3I6Izk4YTJiMzt0ZXh0LWFsaWduOmNlbnRlciI+Q2jGsGEgY8OzIGvhur90IHF14bqjIHRyYSBj4bupdS48L3RkPjwvdHI+CiAgICAgICAgICA8L3Rib2R5PgogICAgICAgIDwvdGFibGU+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+RDHigJNEMyDEkcaw4bujYyBjaOG7jW48L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPktoaSBjaOG7jW4gbeG7mXQga+G6v3QgcXXhuqMsIGjhu4cgdGjhu5FuZyB04buxIGzhuqV5IG1ldGFkYXRhIHbDoCBu4buZaSBkdW5nIHBhdGVudCDEkeG7gyDEkWnhu4FuIHbDoG8gc2xvdCB0xrDGoW5nIOG7qW5nLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwcmlvci1zbG90IiBpZD0ic2xvdEQxIj4KICAgICAgICAgIDxoND5EMSDCtyDhu6huZyB2acOqbiDEkeG7kWkgY2jhu6luZyBn4bqnbiBuaOG6pXQ8L2g0PgogICAgICAgICAgPGlucHV0IGlkPSJkMU5vIiBwbGFjZWhvbGRlcj0iU+G7kSBjw7RuZyBi4buRIj4KICAgICAgICAgIDxpbnB1dCBpZD0iZDFEYXRlIiB0eXBlPSJkYXRlIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgICAgPGlucHV0IGlkPSJkMVVybCIgcGxhY2Vob2xkZXI9IlVSTCBuZ3Xhu5NuIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgICAgPHRleHRhcmVhIGlkPSJkMVRleHQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweDttaW4taGVpZ2h0OjE5MHB4IiBwbGFjZWhvbGRlcj0iQWJzdHJhY3QgLyBjbGFpbXMgLyBzbmlwcGV0IHPhur0gxJHGsOG7o2MgdOG7sSDEkWnhu4FuLi4uIj48L3RleHRhcmVhPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InByaW9yLXNsb3QiIGlkPSJzbG90RDIiPgogICAgICAgICAgPGg0PkQyIMK3IFTDoGkgbGnhu4d1IGLhu5Ugc3VuZzwvaDQ+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQyTm8iIHBsYWNlaG9sZGVyPSJT4buRIGPDtG5nIGLhu5EiPgogICAgICAgICAgPGlucHV0IGlkPSJkMkRhdGUiIHR5cGU9ImRhdGUiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQyVXJsIiBwbGFjZWhvbGRlcj0iVVJMIG5ndeG7k24iIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgICA8dGV4dGFyZWEgaWQ9ImQyVGV4dCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4O21pbi1oZWlnaHQ6MTkwcHgiIHBsYWNlaG9sZGVyPSJBYnN0cmFjdCAvIGNsYWltcyAvIHNuaXBwZXQgc+G6vSDEkcaw4bujYyB04buxIMSRaeG7gW4uLi4iPjwvdGV4dGFyZWE+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icHJpb3Itc2xvdCIgaWQ9InNsb3REMyI+CiAgICAgICAgICA8aDQ+RDMgwrcgVMOgaSBsaeG7h3UgYuG7lSBzdW5nPC9oND4KICAgICAgICAgIDxpbnB1dCBpZD0iZDNObyIgcGxhY2Vob2xkZXI9IlPhu5EgY8O0bmcgYuG7kSI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQzRGF0ZSIgdHlwZT0iZGF0ZSIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICAgIDxpbnB1dCBpZD0iZDNVcmwiIHBsYWNlaG9sZGVyPSJVUkwgbmd14buTbiIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0iZDNUZXh0IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHg7bWluLWhlaWdodDoxOTBweCIgcGxhY2Vob2xkZXI9IkFic3RyYWN0IC8gY2xhaW1zIC8gc25pcHBldCBz4bq9IMSRxrDhu6NjIHThu7EgxJFp4buBbi4uLiI+PC90ZXh0YXJlYT4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIj48YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9InZhbGlkYXRlUHJpb3IiPktp4buDbSB0cmEgxJFp4buBdSBraeG7h24gdGjhu51pIGdpYW48L2J1dHRvbj48L2Rpdj4KICAgICAgPGRpdiBpZD0icHJpb3JDaGVjayIgY2xhc3M9ImNhbGxvdXQiIHN0eWxlPSJtYXJnaW4tdG9wOjE2cHgiPjxzdHJvbmc+TMawdSDDvTo8L3N0cm9uZz4gbmfDoHkgdsOgIG7hu5lpIGR1bmcgduG6q24gY+G6p24gY2h1ecOqbiBnaWEga2nhu4NtIGNo4bupbmcgdHLDqm4gdMOgaSBsaeG7h3UgZ+G7kWMuPC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CgogIDxzZWN0aW9uIGlkPSJjb21wYXJlIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj42LiBM4bqtcCBi4bqjbmcgc28gc8OhbmggZOG6pXUgaGnhu4d1PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj7EkOG7kWkgY2hp4bq/dSB04burbmcgZOG6pXUgaGnhu4d1IHbhu5tpIHThu6tuZyB0w6BpIGxp4buHdS4gTuG6v3UgY2jGsGEgY8OzIGLhurFuZyBjaOG7qW5nIMSR4bunIHLDtSwgaOG7hyB0aOG7kW5nIHBo4bqjaSB0cuG6oyB24buBIOKAnENoxrBhIGNo4bqvYyBjaOG6r27igJ0uPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0iYnVpbGRNYXRyaXgiPlThuqFvIG1hIHRy4bqtbiDEkeG7kWkgY2hp4bq/dTwvYnV0dG9uPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIiBzdHlsZT0ibWFyZ2luLXRvcDoxOHB4Ij48dGFibGU+PHRoZWFkPjx0cj48dGg+RmVhdHVyZTwvdGg+PHRoPkQxPC90aD48dGg+RDI8L3RoPjx0aD5EMzwvdGg+PHRoPkLhurFuZyBjaOG7qW5nIC8gZ2hpIGNow7o8L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9Im1hdHJpeEJvZHkiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9ImFzc2VzcyIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+Ny4gxJDDoW5oIGdpw6Egc8ahIGLhu5k8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPsSQw6FuaCBnacOhIHRoZW8gdOG7q25nIGNsYWltIHbDoCB04bqtcCB0w6BpIGxp4buHdSDEkWFuZyBraOG6o28gc8OhdDsga2jDtG5nIHBo4bqjaSBr4bq/dCBsdeG6rW4gY+G6pXAgYuG6sW5nLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyaXNrIj48ZGl2PjxoMz5Uw61uaCBt4bubaTwvaDM+PHAgaWQ9Im5vdmVsdHlUZXh0Ij5DaMawYSDEkcOhbmggZ2nDoS48L3A+PC9kaXY+PGRpdiBjbGFzcz0icmlza2JveCB5ZWxsb3ciIGlkPSJub3ZlbHR5UmlzayI+Q0jhu5wgROG7riBMSeG7hlU8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0iaGVpZ2h0OjEycHgiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyaXNrIj48ZGl2PjxoMz5UcsOsbmggxJHhu5kgc8OhbmcgdOG6oW88L2gzPjxwIGlkPSJpbnZlbnRpdmVUZXh0Ij5DaMawYSDEkcOhbmggZ2nDoS48L3A+PC9kaXY+PGRpdiBjbGFzcz0icmlza2JveCB5ZWxsb3ciIGlkPSJpbnZlbnRpdmVSaXNrIj5DSOG7nCBE4buuIExJ4buGVTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJkaXZpZGVyIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+PGRpdj48bGFiZWw+xJDhu5FpIGNo4bupbmcgZ+G6p24gbmjhuqV0PC9sYWJlbD48c2VsZWN0IGlkPSJjbG9zZXN0Ij48b3B0aW9uPkQxPC9vcHRpb24+PG9wdGlvbj5EMjwvb3B0aW9uPjxvcHRpb24+RDM8L29wdGlvbj48L3NlbGVjdD48L2Rpdj48ZGl2PjxsYWJlbD5E4bqldSBoaeG7h3Uga2jDoWMgYmnhu4d0PC9sYWJlbD48dGV4dGFyZWEgaWQ9ImRpZmZlcmVuY2VzIj48L3RleHRhcmVhPjwvZGl2PjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxsYWJlbD5W4bqlbiDEkeG7gSBr4bu5IHRodeG6rXQga2jDoWNoIHF1YW48L2xhYmVsPjx0ZXh0YXJlYSBpZD0icHJvYmxlbSI+PC90ZXh0YXJlYT48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij48bGFiZWw+TOG6rXAgbHXhuq1uIHPGoSBi4buZIHbhu4EgdMOtbmggaGnhu4NuIG5oacOqbjwvbGFiZWw+PHRleHRhcmVhIGlkPSJyZWFzb25pbmciPjwvdGV4dGFyZWE+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0icnVuQXNzZXNzbWVudCI+Q2jhuqF5IMSRw6FuaCBnacOhIHPGoSBi4buZPC9idXR0b24+PC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CgogIDxzZWN0aW9uIGlkPSJleHBlcnQiIGNsYXNzPSJzZWN0aW9uIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPjguIENodXnDqm4gZ2lhIHLDoCBzb8OhdDwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN1YiI+Q2h1ecOqbiBnaWEgeMOhYyBuaOG6rW4vY2jhu4luaCBz4butYS9iw6FjIGLhu48gdOG7q25nIMSR4bqndSByYS4gxJDDonkgbMOgIGNoZWNrcG9pbnQgYuG6r3QgYnXhu5ljIGPhu6dhIG3DtCBow6xuaCBIdW1hbi1pbi10aGUtbG9vcC48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPkjhuqFuZyBt4bulYzwvdGg+PHRoPkvhur90IHF14bqjIGjhu4cgdGjhu5FuZzwvdGg+PHRoPlF1eeG6v3QgxJHhu4tuaCBjaHV5w6puIGdpYTwvdGg+PHRoPk5o4bqtbiB4w6l0PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5IGlkPSJleHBlcnRCb2R5Ij48L3Rib2R5PjwvdGFibGU+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0ic2F2ZVJldmlldyI+TMawdSByw6Agc2/DoXQ8L2J1dHRvbj48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9InJlcG9ydCIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+OS4gQsOhbyBjw6FvIHBow6JuIHTDrWNoIHPGoSBi4buZPC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIG5vLXByaW50Ij5U4buVbmcgaOG7o3AgZOG7ryBsaeG7h3UgdOG7qyB0b8OgbiBi4buZIHBpcGVsaW5lLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIG5vLXByaW50Ij48YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9ImdlblJlcG9ydCI+VOG6oW8gYsOhbyBjw6FvPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0iYnRuIiBvbmNsaWNrPSJ3aW5kb3cucHJpbnQoKSI+SW4gLyBMxrB1IFBERjwvYnV0dG9uPjwvZGl2PgogICAgICA8ZGl2IGlkPSJyZXBvcnRDb250ZW50IiBjbGFzcz0icmVwb3J0Ij48ZGl2IGNsYXNzPSJlbXB0eSI+Q2jGsGEgdOG6oW8gYsOhbyBjw6FvLjwvZGl2PjwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgo8L21haW4+CjwvZGl2PgoKPGRpdiBjbGFzcz0id2l6YXJkYmFyIG5vLXByaW50Ij4KICA8ZGl2IGNsYXNzPSJ3aXphcmRpbm5lciI+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYmFja2J0biIgaWQ9ImJhY2tCdG4iPuKGkCBRdWF5IGzhuqFpPC9idXR0b24+CiAgICA8ZGl2IGNsYXNzPSJ3aXphcmRtZXRhIj48c3Ryb25nIGlkPSJ3aXphcmRUaXRsZSI+PC9zdHJvbmc+PHNwYW4gaWQ9IndpemFyZEhpbnQiPjwvc3Bhbj48L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IG5leHRidG4iIGlkPSJuZXh0QnRuIj5UaeG6v3AgdOG7pWMg4oaSPC9idXR0b24+CiAgPC9kaXY+CjwvZGl2PgoKPHNjcmlwdD4KY29uc3QgU1RFUFM9WwogIHtpZDoiaW50YWtlIix0aXRsZToiVGnhur9wIG5o4bqtbiBo4buTIHPGoSIsaGludDoiVOG6o2kgUERGIHbDoCBraeG7g20gdHJhIGThu68gbGnhu4d1IHThu7EgxJHhu5luZyB0csOtY2ggeHXhuqV0LiJ9LAogIHtpZDoiY2xhaW1zIix0aXRsZToiWcOqdSBj4bqndSBi4bqjbyBo4buZIixoaW50OiJDaOG7jW4gY2xhaW0gY+G6p24gcGjDom4gdMOtY2guIn0sCiAge2lkOiJmZWF0dXJlcyIsdGl0bGU6IkThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQiLGhpbnQ6IlTDoWNoIHbDoCB4w6FjIG5o4bqtbiBmZWF0dXJlIHNldC4ifSwKICB7aWQ6InNlYXJjaCIsdGl0bGU6IkNoaeG6v24gbMaw4bujYyB0cmEgY+G7qXUiLGhpbnQ6IlNpbmgga2V5d29yZC9JUEMvcXVlcnkuIn0sCiAge2lkOiJwcmlvciIsdGl0bGU6IlTDoGkgbGnhu4d1IMSR4buRaSBjaOG7qW5nIixoaW50OiJOaOG6rXAva2nhu4NtIHRyYSBwcmlvciBhcnQuIn0sCiAge2lkOiJjb21wYXJlIix0aXRsZToiQuG6o25nIHNvIHPDoW5oIixoaW50OiJNYXAgZmVhdHVyZSB24bubaSBldmlkZW5jZS4ifSwKICB7aWQ6ImFzc2VzcyIsdGl0bGU6IsSQw6FuaCBnacOhIHPGoSBi4buZIixoaW50OiJOb3ZlbHR5IHbDoCBpbnZlbnRpdmUgc3RlcC4ifSwKICB7aWQ6ImV4cGVydCIsdGl0bGU6IkNodXnDqm4gZ2lhIHLDoCBzb8OhdCIsaGludDoiRXhwZXJ0IHZhbGlkYXRpb24uIn0sCiAge2lkOiJyZXBvcnQiLHRpdGxlOiJCw6FvIGPDoW8iLGhpbnQ6IlThu5VuZyBo4bujcCBr4bq/dCBxdeG6oy4ifQpdOwpjb25zdCBzdGF0ZT17c3RlcDowLHBkZjpudWxsLHBhZ2VUZXh0OltdLHBhZ2VDb2x1bW5UZXh0OltdLHBhZ2VRdWFsaXR5OltdLGJhZFRleHRQYWdlczpbXSxvY3JQYWdlczp7fSxyYXdUZXh0OiIiLGNsYWltc1RleHQ6IiIsY2xhaW1zOltdLHNlbGVjdGVkOjAsZmVhdHVyZXM6W10sY29uZmlybWVkOmZhbHNlLHNlYXJjaDpbXSxxdWVyaWVzOltdLHByaW9yOnt9LG1hdHJpeDpbXSxhc3Nlc3NtZW50Ont9LHJldmlld3M6MCxjYW5kaWRhdGVzOltdLGJhY2tlbmRVcmw6IiIscHJvdmlkZXJzOnt9LGNsb3VkT2NyOm51bGwsdGVzc0RpYWc6e3ZpZTpmYWxzZSxlbmc6ZmFsc2UsZXJyb3I6IiJ9LGNsYWltU291cmNlQnlQYWdlOnt9fTsKY29uc3QgJD1pZD0+ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwpjb25zdCBlc2M9cz0+KHN8fCIiKS5yZXBsYWNlKC9bJjw+IiddL2csbT0+KHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsJyInOiImcXVvdDsiLCInIjoiJiMwMzk7In1bbV0pKTsKY29uc3QgY2xlYW49cz0+KHN8fCIiKS5yZXBsYWNlKC9cdTAwYWQvZywiIikucmVwbGFjZSgvWyBcdF0rL2csIiAiKS5yZXBsYWNlKC9cblsgXHRdKy9nLCJcbiIpLnRyaW0oKTsKZnVuY3Rpb24gZm9sZFZOKHMpewogIHJldHVybiAoc3x8IiIpCiAgICAubm9ybWFsaXplKCJORkQiKQogICAgLnJlcGxhY2UoL1tcdTAzMDAtXHUwMzZmXS9nLCIiKQogICAgLnJlcGxhY2UoL8SRL2csImQiKS5yZXBsYWNlKC/EkC9nLCJEIikKICAgIC50b1VwcGVyQ2FzZSgpOwp9CmZ1bmN0aW9uIGNsYWltTWFya2VySW5mbyh0ZXh0KXsKICBjb25zdCBmPWZvbGRWTih0ZXh0KTsKICBjb25zdCBwYXR0ZXJucz1bCiAgICAvWUVVXHMqQ0FVXHMqQkFPXHMqSE8vLAogICAgL05IVU5HXHMqRElFVVxzKllFVVxzKkNBVVxzKkJBT1xzKkhPLywKICAgIC9XSEFUXHMrSVNccytDTEFJTUVEXHMrSVNccyo6Ki8sCiAgICAvSVxzKlwvP1xzKldFXHMrQ0xBSU1ccyo6Ki8sCiAgICAvXGJDTEFJTVM/XHMqOiovCiAgXTsKICBmb3IoY29uc3QgcmUgb2YgcGF0dGVybnMpewogICAgY29uc3QgbT1mLm1hdGNoKHJlKTsKICAgIGlmKG0pIHJldHVybiB7aW5kZXg6bS5pbmRleCxlbmQ6bS5pbmRleCttWzBdLmxlbmd0aH07CiAgfQogIHJldHVybiBudWxsOwp9CmZ1bmN0aW9uIGxvb2tzTGlrZUNsYWltUGFnZSh0ZXh0KXsKICBjb25zdCBmPWZvbGRWTih0ZXh0KTsKICByZXR1cm4gLyg/Ol58XG58XHMpMVxzKltcLlwpXVxzKihRVVkgVFJJTkh8UEhVT05HIFBIQVB8U0FOIFBIQU18VEhJRVQgQkl8SEUgVEhPTkd8Q0hFIFBIQU18QVxzfEFOXHN8VEhFXHMpLy50ZXN0KGYpCiAgICAmJiAvKEJBTyBHT018Q09NUFJJU0lOR3xDT01QUklTRVN8R09NIENBQyBCVU9DfElOQ0xVRElORykvLnRlc3QoZik7Cn0KZnVuY3Rpb24gZXh0cmFjdENsYWltc1RhaWwodGV4dCl7CiAgaWYoIXRleHQpIHJldHVybiAiIjsKICBjb25zdCBtYXJrPWNsYWltTWFya2VySW5mbyh0ZXh0KTsKICBpZihtYXJrKSByZXR1cm4gdHJ1bmNhdGVDbGFpbUF0RmlndXJlKGNsZWFuKHRleHQuc2xpY2UobWFyay5lbmQpKSkuc2xpY2UoMCw4MDAwMCk7CiAgY29uc3QgZj1mb2xkVk4odGV4dCk7CiAgY29uc3QgcmU9Lyg/Ol58XG58XHMpMVxzKltcLlwpXVxzKihRVVkgVFJJTkh8UEhVT05HIFBIQVB8U0FOIFBIQU18VEhJRVQgQkl8SEUgVEhPTkd8Q0hFIFBIQU18QVxzfEFOXHN8VEhFXHMpLzsKICBjb25zdCBtbT1mLm1hdGNoKHJlKTsKICByZXR1cm4gbW0gPyB0cnVuY2F0ZUNsYWltQXRGaWd1cmUoY2xlYW4odGV4dC5zbGljZShtbS5pbmRleCkpKS5zbGljZSgwLDgwMDAwKSA6ICIiOwp9CmZ1bmN0aW9uIG5vcm1hbGl6ZU9jclRleHQocyl7CiAgLy8gdjEwOiBraMO0bmcgdOG7sSBu4buRaSBkw7JuZyB0w7l5IHRp4buHbiBu4buvYS4gQ2jhu4kgY2h14bqpbiBow7NhIFVuaWNvZGUva2hv4bqjbmcgdHLhuq9uZy4KICAvLyDEkGnhu4F1IG7DoHkgdHLDoW5oIGJp4bq/biB2xINuIGLhuqNuIFZp4buHdCDEkcO6bmcgdGjDoG5oIGNodeG7l2kgZMOtbmggbmjGsCAiTuG6ollN4bqmTSIgaG/hurdjIGvDqW8gZm9vdGVyIHbDoG8gdGl0bGUuCiAgcmV0dXJuIFN0cmluZyhzfHwiIikKICAgIC5yZXBsYWNlKC9cdUZFRkYvZywiIikKICAgIC5yZXBsYWNlKC9cdTAwYWQvZywiIikKICAgIC5yZXBsYWNlKC9bXHUyMDBCLVx1MjAwRFx1MjA2MF0vZywiIikKICAgIC5ub3JtYWxpemUoIk5GQyIpCiAgICAucmVwbGFjZSgvW+KAnOKAnV0vZywnIicpLnJlcGxhY2UoL1vigJjigJldL2csIiciKQogICAgLnJlcGxhY2UoL1vigJDigJHigJLigJPigJRdL2csIi0iKQogICAgLnJlcGxhY2UoL1x1MDBhMC9nLCIgIikKICAgIC5yZXBsYWNlKC9bIFx0XSsvZywiICIpCiAgICAucmVwbGFjZSgvWyBcdF0rXG4vZywiXG4iKQogICAgLnJlcGxhY2UoL1xuWyBcdF0rL2csIlxuIikKICAgIC5yZXBsYWNlKC9ccysoWywuOzolXCldKS9nLCIkMSIpCiAgICAucmVwbGFjZSgvKFwoKVxzKy9nLCIkMSIpCiAgICAucmVwbGFjZSgvKFxkKVxzKixccyooXGQpL2csIiQxLCQyIikKICAgIC5yZXBsYWNlKC9cbnszLH0vZywiXG5cbiIpCiAgICAudHJpbSgpOwp9CgpmdW5jdGlvbiBzdHJpcFBkZkFydGlmYWN0cyhzKXsKICBsZXQgdD1ub3JtYWxpemVPY3JUZXh0KHMpOwoKICAvLyBQYWdlIGNvdW50ZXJzIC8gZm9vdGVyIGFydGlmYWN0cyBjb21tb25seSBlbWl0dGVkIGJ5IFZpZXRuYW1lc2UgcGF0ZW50IFBERnMuCiAgdD10LnJlcGxhY2UoLyg/OlxiXGR7MywxMH1ccytcZHsxLDN9XHMqXC9ccypcZHsxLDN9XGJbXHMsOzpdKil7Mix9L2csIiAiKTsKICB0PXQucmVwbGFjZSgvXGJcZHszLDEwfVxzK1xkezEsM31ccypcL1xzKlxkezEsM31cYi9nLCIgIik7CiAgdD10LnJlcGxhY2UoLyg/OlxiXGR7MSwzfVxzKlwvXHMqXGR7MywxMH1cYltccyw7Ol0qKXsyLH0vZywiICIpOwogIHQ9dC5yZXBsYWNlKC9eXHMqXGR7MSwzfVxzKlwvXHMqXGR7MSwzfVxzKiQvZ20sIiIpOwogIHQ9dC5yZXBsYWNlKC9eXHMqKD86UGFnZXxUcmFuZylccytcZCsoPzpccypcL1xzKlxkKyk/XHMqJC9nbWksIiIpOwoKICAvLyBDb2xsYXBzZSBvbmx5IGhvcml6b250YWwgbm9pc2U7IGtlZXAgc2VtYW50aWMgbGluZSBicmVha3MuCiAgcmV0dXJuIHQucmVwbGFjZSgvWyBcdF17Mix9L2csIiAiKS5yZXBsYWNlKC9cbnszLH0vZywiXG5cbiIpLnRyaW0oKTsKfQoKZnVuY3Rpb24gdGV4dExheWVyUXVhbGl0eVNjb3JlKHRleHQpewogIGNvbnN0IHQ9c3RyaXBQZGZBcnRpZmFjdHModGV4dCk7IGlmKGxvb2tzTGlrZUxlZ2FjeUVuY29kaW5nKHQpKSByZXR1cm4gNTsKICBpZighdCkgcmV0dXJuIDA7CgogIGNvbnN0IGNoYXJzPXQubGVuZ3RoOwogIGNvbnN0IGxldHRlcnM9KHQubWF0Y2goL1xwe0x9L2d1KXx8W10pLmxlbmd0aDsKICBjb25zdCBkaWdpdHM9KHQubWF0Y2goL1xkL2cpfHxbXSkubGVuZ3RoOwogIGNvbnN0IHdlaXJkPSh0Lm1hdGNoKC9b77+94pah4page308Pnx+XmBdL2cpfHxbXSkubGVuZ3RoOwogIGNvbnN0IHNsYXNoU2VxPSh0Lm1hdGNoKC9cZCtccypcL1xzKlxkKy9nKXx8W10pLmxlbmd0aDsKICBjb25zdCB3b3Jkcz10LnNwbGl0KC9ccysvKS5maWx0ZXIoQm9vbGVhbik7CiAgY29uc3Qgc2hvcnRXb3Jkcz13b3Jkcy5maWx0ZXIodz0+dy5sZW5ndGg8PTEpLmxlbmd0aDsKCiAgbGV0IHNjb3JlPTA7CiAgc2NvcmUrPU1hdGgubWluKDQwLCBjaGFycy8zNSk7CiAgc2NvcmUrPU1hdGgubWluKDI1LCAobGV0dGVycy9NYXRoLm1heCgxLGNoYXJzKSkqNDUpOwogIGlmKC9bxIPDosSRw6rDtMahxrDEgsOCxJDDisOUxqDGr10vLnRlc3QodCkpIHNjb3JlKz04OwogIGlmKC9bw6DDoeG6o8Oj4bqh4bqx4bqv4bqz4bq14bq34bqn4bql4bqp4bqr4bqtw6jDqeG6u+G6veG6ueG7geG6v+G7g+G7heG7h8Osw63hu4nEqeG7i8Oyw7Phu4/DteG7jeG7k+G7keG7leG7l+G7meG7neG7m+G7n+G7oeG7o8O5w7rhu6fFqeG7peG7q+G7qeG7reG7r+G7seG7s8O94bu34bu54bu1XS9pLnRlc3QodCkpIHNjb3JlKz04OwogIGlmKC9cYig/OnPDoW5nIGNo4bq/fHnDqnUgY+G6p3UgYuG6o28gaOG7mXxxdXkgdHLDrG5ofHBoxrDGoW5nIHBow6FwfGJhbyBn4buTbXx0cm9uZyDEkcOzfHRoaeG6v3QgYuG7i3xo4buHIHRo4buRbmcpXGIvaS50ZXN0KHQpKSBzY29yZSs9MTI7CgogIHNjb3JlLT1NYXRoLm1pbigzNSx3ZWlyZCo1KTsKICBzY29yZS09TWF0aC5taW4oMzAsc2xhc2hTZXEqNSk7CiAgaWYoZGlnaXRzL01hdGgubWF4KDEsY2hhcnMpPi4yOCkgc2NvcmUtPTE4OwogIGlmKHNob3J0V29yZHMvTWF0aC5tYXgoMSx3b3Jkcy5sZW5ndGgpPi4yNSkgc2NvcmUtPTE1OwoKICByZXR1cm4gTWF0aC5tYXgoMCxNYXRoLm1pbigxMDAsTWF0aC5yb3VuZChzY29yZSkpKTsKfQoKCmZ1bmN0aW9uIHJlcGFpckNlcnRhaW5Wbk9jcih0ZXh0KXsKICAvLyBDaOG7iSBz4butYSBjw6FjIGzhu5dpIE9DUiBy4bqldCDEkWnhu4NuIGjDrG5oOyBraMO0bmcgdOG7sSB2aeG6v3QgbOG6oWkgbuG7mWkgZHVuZyBwaMOhcCBsw70uCiAgcmV0dXJuIG5vcm1hbGl6ZU9jclRleHQodGV4dHx8IiIpCiAgICAucmVwbGFjZSgvXGIoPzp04buJbmh8dMOtbmgpXHMrZOG6p3VcYi9naSwidGluaCBk4bqndSIpCiAgICAucmVwbGFjZSgvXGJkdW5nXHMrxJHhu4tjaFxiL2dpLCJkdW5nIGThu4tjaCIpCiAgICAucmVwbGFjZSgvXGJo4buTblxzK2jhu6NwXGIvZ2ksImjhu5duIGjhu6NwIikKICAgIC5yZXBsYWNlKC9cYm7huqN5beG6p21cYi9naSwibuG6o3kgbeG6p20iKQogICAgLnJlcGxhY2UoL1xia2h1ZHlcYi9naSwia2h14bqleSIpCiAgICAubm9ybWFsaXplKCJORkMiKTsKfQoKZnVuY3Rpb24gdHJ1bmNhdGVDbGFpbUF0RmlndXJlKHRleHQpewogIGxldCB0PXN0cmlwUGRmQXJ0aWZhY3RzKHJlcGFpckNlcnRhaW5Wbk9jcih0ZXh0fHwiIikpOwogIGNvbnN0IHN0b3BzPVsKICAgIC8oPzpefFxuKVxzKkjDjE5IXHMqXGQrXGIvaW0sCiAgICAvKD86XnxcbilccypISU5IXHMqXGQrXGIvaW0sCiAgICAvKD86XnxcbilccypGSUcoPzpVUkUpP1wuP1xzKlxkK1xiL2ltLAogICAgLyg/Ol58XG4pXHMqKD86TcOUIFThuqIgSMOMTkggVuG6vHxC4bqiTiBW4bq8fERSQVdJTkdTPylcYi9pbQogIF07CiAgbGV0IGN1dD10Lmxlbmd0aDsKICBmb3IoY29uc3QgcmUgb2Ygc3RvcHMpewogICAgY29uc3QgbW09dC5tYXRjaChyZSk7CiAgICBpZihtbSAmJiBtbS5pbmRleD44MCkgY3V0PU1hdGgubWluKGN1dCxtbS5pbmRleCk7CiAgfQogIHQ9dC5zbGljZSgwLGN1dCk7CgogIC8vIEZvb3Rlci9wYWdlLW51bWJlciBhcnRpZmFjdHMuCiAgdD10LnJlcGxhY2UoL1xuXHMqXGR7Miw4fVxzK1xkezEsM31ccypcL1xzKlxkezEsM31ccyokL2csIiIpOwogIHQ9dC5yZXBsYWNlKC9cblxzKlxkezEsNH1ccyokL2csIiIpOwogIHJldHVybiB0LnRyaW0oKS5ub3JtYWxpemUoIk5GQyIpOwp9CgpmdW5jdGlvbiBsb29rc0xpa2VMZWdhY3lFbmNvZGluZyh0ZXh0KXsKICBjb25zdCB0PVN0cmluZyh0ZXh0fHwiIik7CiAgcmV0dXJuIC8oPzrDsWHDqm5nfGt5w7l8w7FpZcOgdXxwaMO2w7RuZ3x0csOsbmh8dmHDqm58aMO2w7TDuW5nfMOxw7bDtMOvY3xiYcOobmd8Y2HDuWNofHNhw7tufHh1YcOhdCkvaS50ZXN0KHQpCiAgICB8fCAodC5tYXRjaCgvW++/veKWoeKWoF0vZyl8fFtdKS5sZW5ndGg+PTI7Cn0KCmZ1bmN0aW9uIHZuT2NyUXVhbGl0eSh0ZXh0KXsKICBjb25zdCB0PXRydW5jYXRlQ2xhaW1BdEZpZ3VyZSh0ZXh0fHwiIik7CiAgaWYoIXQpIHJldHVybiAwOwogIGxldCBzY29yZT10ZXh0TGF5ZXJRdWFsaXR5U2NvcmUodCk7CgogIGNvbnN0IGY9Zm9sZFZOKHQpLnRvTG93ZXJDYXNlKCk7CiAgY29uc3QgcGF0ZW50V29yZHM9WwogICAgInF1eSB0cmluaCIsInBodW9uZyBwaGFwIiwieWV1IGNhdSBiYW8gaG8iLCJiYW8gZ29tIiwidHJvbmcgZG8iLAogICAgInRpbmggZGF1IiwiZHVuZyBkaWNoIiwiaG9uIGhvcCIsImRvbmcgbmhhdCIsInRoaWV0IGJpIiwia2h1YXkiCiAgXTsKICBmb3IoY29uc3QgdyBvZiBwYXRlbnRXb3JkcykgaWYoZi5pbmNsdWRlcyh3KSkgc2NvcmUrPTU7CgogIHNjb3JlLT1NYXRoLm1pbigzMCwodC5tYXRjaCgvXGIoPzp04buJbmggZOG6p3V8dMOtbmggZOG6p3V8ZHVuZyDEkeG7i2NofGjhu5NuIGjhu6NwKVxiL2dpKXx8W10pLmxlbmd0aCo2KTsKICBzY29yZS09TWF0aC5taW4oMzAsKHQubWF0Y2goL1xkK1xzKlwvXHMqXGQrL2cpfHxbXSkubGVuZ3RoKjUpOwogIGlmKC8oPzpefFxuKVxzKig/OkjDjE5IfEhJTkh8RklHVVJFfEZJR1wuKVxzKlxkKy9pbS50ZXN0KHQpKSBzY29yZS09NDU7CiAgaWYobG9va3NMaWtlTGVnYWN5RW5jb2RpbmcodCkpIHNjb3JlLT0zNTsKCiAgcmV0dXJuIE1hdGgubWF4KDAsTWF0aC5taW4oMTAwLE1hdGgucm91bmQoc2NvcmUpKSk7Cn0KCmZ1bmN0aW9uIHJlbmRlclRlc3NEaWFnKCl7CiAgY29uc3QgZWw9JCgidGVzc0RpYWciKTsKICBpZighZWwpIHJldHVybjsKICBjb25zdCBkPXN0YXRlLnRlc3NEaWFnfHx7fTsKICBpZihkLmVycm9yKXsKICAgIGVsLmlubmVySFRNTD1gPHNwYW4gY2xhc3M9ImJhY2tlbmQtYmFkIj5PQ1IgbGFuZ3VhZ2UgcGFjayBs4buXaTo8L3NwYW4+ICR7ZXNjKGQuZXJyb3IpfWA7CiAgICByZXR1cm47CiAgfQogIGNvbnN0IHZpZT1kLnZpZT8i4pyTIHZpZS50cmFpbmVkZGF0YSI6IuKApiB2aWUudHJhaW5lZGRhdGEiOwogIGNvbnN0IGVuZz1kLmVuZz8i4pyTIGVuZy50cmFpbmVkZGF0YSI6IuKApiBlbmcudHJhaW5lZGRhdGEiOwogIGVsLmlubmVySFRNTD1gVGVzc2VyYWN0LmpzIDUuMS4xIMK3IDxzdHJvbmc+dmllICsgZW5nPC9zdHJvbmc+IMK3ICR7dmllfSDCtyAke2VuZ30gwrcgVW5pY29kZSBORkNgOwp9CgpmdW5jdGlvbiBjbGVhbk1ldGFWYWx1ZShzKXsKICBsZXQgdD1zdHJpcFBkZkFydGlmYWN0cyhzKQogICAgLnJlcGxhY2UoL15ccypbXChcW10/XGR7Mn1bXClcXV0/XHMqLywiIikKICAgIC5yZXBsYWNlKC9ccysvZywiICIpCiAgICAudHJpbSgpOwogIHJldHVybiB0Owp9CgpmdW5jdGlvbiBzYW5pdGl6ZVBhdGVudFRpdGxlKHMpewogIGxldCB0PWNsZWFuTWV0YVZhbHVlKHMpCiAgICAucmVwbGFjZSgvXGIoPzpQYWdlfFRyYW5nKVxzK1xkKyg/OlwvXGQrKT9cYi9naSwiIikKICAgIC5yZXBsYWNlKC8oPzpcYlxkezMsMTB9XHMrXGR7MSwzfVwvXGR7MSwzfVxiXHMqKSsvZywiIikKICAgIC5yZXBsYWNlKC9ccysvZywiICIpCiAgICAudHJpbSgpOwoKICAvLyBSZWplY3Qgb2J2aW91c2x5IHBvbGx1dGVkIHRpdGxlcyByYXRoZXIgdGhhbiBwb2lzb25pbmcgc2VhcmNoLgogIGNvbnN0IHNsYXNoPSh0Lm1hdGNoKC9cZCtccypcL1xzKlxkKy9nKXx8W10pLmxlbmd0aDsKICBjb25zdCBkaWdpdFJhdGlvPSh0Lm1hdGNoKC9cZC9nKXx8W10pLmxlbmd0aC9NYXRoLm1heCgxLHQubGVuZ3RoKTsKICBpZihzbGFzaD49MiB8fCBkaWdpdFJhdGlvPi4zMCkgcmV0dXJuICIiOwogIHJldHVybiB0LnNsaWNlKDAsMjYwKTsKfQoKZnVuY3Rpb24gY2FudmFzVG9CYXNlNjRKcGVnKGNhbnZhcyxxdWFsaXR5PS45KXsKICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUscmVqZWN0KT0+ewogICAgY2FudmFzLnRvQmxvYihhc3luYyBibG9iPT57CiAgICAgIGlmKCFibG9iKSByZXR1cm4gcmVqZWN0KG5ldyBFcnJvcigiS2jDtG5nIHThuqFvIMSRxrDhu6NjIOG6o25oIE9DUi4iKSk7CiAgICAgIGNvbnN0IGJ1Zj1hd2FpdCBibG9iLmFycmF5QnVmZmVyKCk7CiAgICAgIGNvbnN0IGJ5dGVzPW5ldyBVaW50OEFycmF5KGJ1Zik7CiAgICAgIGxldCBiaW49IiI7CiAgICAgIGNvbnN0IGNodW5rPTB4ODAwMDsKICAgICAgZm9yKGxldCBpPTA7aTxieXRlcy5sZW5ndGg7aSs9Y2h1bmspewogICAgICAgIGJpbis9U3RyaW5nLmZyb21DaGFyQ29kZSguLi5ieXRlcy5zdWJhcnJheShpLE1hdGgubWluKGkrY2h1bmssYnl0ZXMubGVuZ3RoKSkpOwogICAgICB9CiAgICAgIHJlc29sdmUoYnRvYShiaW4pKTsKICAgIH0sImltYWdlL2pwZWciLHF1YWxpdHkpOwogIH0pOwp9Cgphc3luYyBmdW5jdGlvbiBjbG91ZFZpc2lvbk9jcihjYW52YXMpewogIGlmKHN0YXRlLmNsb3VkT2NyPT09ZmFsc2UpIHJldHVybiBudWxsOwogIHRyeXsKICAgIGNvbnN0IGltYWdlX2Jhc2U2ND1hd2FpdCBjYW52YXNUb0Jhc2U2NEpwZWcoY2FudmFzLC45Mik7CiAgICBjb25zdCByPWF3YWl0IGZldGNoKCIvYXBpL29jciIsewogICAgICBtZXRob2Q6IlBPU1QiLAogICAgICBoZWFkZXJzOnsiY29udGVudC10eXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LAogICAgICBib2R5OkpTT04uc3RyaW5naWZ5KHtpbWFnZV9iYXNlNjR9KQogICAgfSk7CiAgICBjb25zdCBkPWF3YWl0IHIuanNvbigpLmNhdGNoKCgpPT4oe30pKTsKICAgIGlmKHIuc3RhdHVzPT09NTAxIHx8IGQuY29kZT09PSJWSVNJT05fTk9UX0NPTkZJR1VSRUQiKXsKICAgICAgc3RhdGUuY2xvdWRPY3I9ZmFsc2U7CiAgICAgIHJldHVybiBudWxsOwogICAgfQogICAgaWYoIXIub2sgfHwgIWQub2spIHRocm93IG5ldyBFcnJvcihkLmVycm9yfHwoIk9DUiBIVFRQICIrci5zdGF0dXMpKTsKICAgIHN0YXRlLmNsb3VkT2NyPXRydWU7CiAgICByZXR1cm4gbm9ybWFsaXplT2NyVGV4dChkLnRleHR8fCIiKTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLndhcm4oIkNsb3VkIE9DUiBmYWxsYmFjazoiLGUpOwogICAgcmV0dXJuIG51bGw7CiAgfQp9CgpmdW5jdGlvbiBmb3JtYXRDbGFpbUZvckRpc3BsYXkocyl7CiAgY29uc3QgdD1ub3JtYWxpemVPY3JUZXh0KHMpCiAgICAucmVwbGFjZSgvXHMqKFwoW2l2eGxjZG1dK1wpKVxzKi9pZywiXG4kMSAiKQogICAgLnJlcGxhY2UoL1xzKyh2w6ApXHMrKD89XChbaXZ4bGNkbV0rXCkpL2lnLCJcbiQxICIpOwogIHJldHVybiB0LnRyaW0oKTsKfQoKCmZ1bmN0aW9uIHJlbmRlclByb2Nlc3MoKXsKICAkKCJwcm9jZXNzIikuaW5uZXJIVE1MPVNURVBTLm1hcCgocyxpKT0+YDxkaXYgY2xhc3M9InByb2Nlc3MtaXRlbSAke2k9PT1zdGF0ZS5zdGVwPyJhY3RpdmUiOmk8c3RhdGUuc3RlcD8iZG9uZSI6IiJ9Ij48c3BhbiBjbGFzcz0ibiI+JHtpPHN0YXRlLnN0ZXA/IuKckyI6aSsxfTwvc3Bhbj48c3Bhbj4ke3MudGl0bGV9PC9zcGFuPjwvZGl2PmApLmpvaW4oIiIpOwp9CmZ1bmN0aW9uIHNob3dTdGVwKGkpewogIHN0YXRlLnN0ZXA9TWF0aC5tYXgoMCxNYXRoLm1pbihTVEVQUy5sZW5ndGgtMSxpKSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiLnNlY3Rpb24iKS5mb3JFYWNoKHg9PnguY2xhc3NMaXN0LnJlbW92ZSgiYWN0aXZlIikpOwogICQoU1RFUFNbc3RhdGUuc3RlcF0uaWQpLmNsYXNzTGlzdC5hZGQoImFjdGl2ZSIpOwogICQoInBhZ2VUaXRsZSIpLnRleHRDb250ZW50PVNURVBTW3N0YXRlLnN0ZXBdLnRpdGxlOwogICQoInBhZ2VTdWIiKS50ZXh0Q29udGVudD1TVEVQU1tzdGF0ZS5zdGVwXS5oaW50OwogICQoIndpemFyZFRpdGxlIikudGV4dENvbnRlbnQ9YELGsOG7m2MgJHtzdGF0ZS5zdGVwKzF9LyR7U1RFUFMubGVuZ3RofSDCtyAke1NURVBTW3N0YXRlLnN0ZXBdLnRpdGxlfWA7CiAgJCgid2l6YXJkSGludCIpLnRleHRDb250ZW50PVNURVBTW3N0YXRlLnN0ZXBdLmhpbnQ7CiAgJCgiYmFja0J0biIpLnN0eWxlLnZpc2liaWxpdHk9c3RhdGUuc3RlcD09PTA/ImhpZGRlbiI6InZpc2libGUiOwogICQoIm5leHRCdG4iKS50ZXh0Q29udGVudD1zdGF0ZS5zdGVwPT09U1RFUFMubGVuZ3RoLTE/Ikhvw6BuIHThuqV0IjoiVGnhur9wIHThu6VjIOKGkiI7CiAgcmVuZGVyUHJvY2VzcygpOwogIGlmKFNURVBTW3N0YXRlLnN0ZXBdLmlkPT09InByaW9yIil7CiAgICBpZighJCgibGl2ZVNlYXJjaFF1ZXJ5IikudmFsdWUpIHVzZUdlbmVyYXRlZFF1ZXJ5KCk7CiAgICB1cGRhdGVPZmZpY2lhbFNlYXJjaExpbmtzKCQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlKTsKICB9CiAgc2Nyb2xsVG8oe3RvcDowLGJlaGF2aW9yOiJzbW9vdGgifSk7Cn0KZnVuY3Rpb24gdmFsaWRhdGVCZWZvcmVOZXh0KCl7CiAgaWYoc3RhdGUuc3RlcD09PTAgJiYgIXN0YXRlLnJhd1RleHQgJiYgIXN0YXRlLmNsYWltcy5sZW5ndGgpe2FsZXJ0KCJIw6N5IHThuqNpIG3hu5l0IFBERiBob+G6t2MgbuG6oXAgZGVtbyB0csaw4bubYy4iKTtyZXR1cm4gZmFsc2V9CiAgaWYoc3RhdGUuc3RlcD09PTEgJiYgIXN0YXRlLmNsYWltcy5sZW5ndGgpe2FsZXJ0KCJDaMawYSBjw7MgY2xhaW0uIEjDo3kgT0NSIGzhuqFpIGhv4bq3YyBwYXN0ZSBwaOG6p24gWcOqdSBj4bqndSBi4bqjbyBo4buZIHLhu5NpIGLhuqVtIOKAnFTDoWNoIGzhuqFpIGNsYWltc+KAnS4iKTtyZXR1cm4gZmFsc2V9CiAgaWYoc3RhdGUuc3RlcD09PTIgJiYgIXN0YXRlLmZlYXR1cmVzLmxlbmd0aCl7YWxlcnQoIkjDo3kgdMOhY2ggZOG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdCB0csaw4bubYy4iKTtyZXR1cm4gZmFsc2V9CiAgaWYoc3RhdGUuc3RlcD09PTIgJiYgIXN0YXRlLmNvbmZpcm1lZCl7cmV0dXJuIGNvbmZpcm0oIkLhu5kgZOG6pXUgaGnhu4d1IGNoxrBhIMSRxrDhu6NjIHjDoWMgbmjhuq1uLiBC4bqhbiB24bqrbiBtdeG7kW4gdGnhur9wIHThu6VjPyIpfQogIGlmKHN0YXRlLnN0ZXA9PT00KXtyZWFkUHJpb3IoKTtpZighT2JqZWN0LnZhbHVlcyhzdGF0ZS5wcmlvcikuc29tZSh4PT54Lm5vKSl7cmV0dXJuIGNvbmZpcm0oIkNoxrBhIGPDsyB0w6BpIGxp4buHdSDEkeG7kWkgY2jhu6luZy4gQuG6oW4gduG6q24gbXXhu5FuIHRp4bq/cCB04bulYz8iKX19CiAgcmV0dXJuIHRydWUKfQokKCJiYWNrQnRuIikub25jbGljaz0oKT0+c2hvd1N0ZXAoc3RhdGUuc3RlcC0xKTsKJCgibmV4dEJ0biIpLm9uY2xpY2s9KCk9PntpZihzdGF0ZS5zdGVwPT09U1RFUFMubGVuZ3RoLTEpeyQoImdlblJlcG9ydCIpLmNsaWNrKCk7cmV0dXJufWlmKHZhbGlkYXRlQmVmb3JlTmV4dCgpKXNob3dTdGVwKHN0YXRlLnN0ZXArMSl9OwpzaG93U3RlcCgwKTtzZXRUaW1lb3V0KHVwZGF0ZUZlYXR1cmVSZXZpZXdVSSwwKTsKaWYobG9jYXRpb24ucHJvdG9jb2w9PT0iZmlsZToiKSAkKCJsb2NhbEJhbm5lciIpLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjsKCmZ1bmN0aW9uIHNldERldGVjdChpZCxvayx0ZXh0KXtsZXQgZWw9JChpZCk7ZWwuY2xhc3NOYW1lPSJkZXRlY3QtY2FyZCAiKyhvaz8ib2siOiJ3YXJuIik7ZWwucXVlcnlTZWxlY3Rvcigic3BhbiIpLnRleHRDb250ZW50PXRleHR9CmZ1bmN0aW9uIG5vcm1EYXRlKHYpe2lmKCF2KXJldHVybiIiO2xldCBtPXYubWF0Y2goLyhcZHsxLDJ9KVtcL1wtLl0oXGR7MSwyfSlbXC9cLS5dKFxkezR9KS8pO2lmKG0pcmV0dXJuIGAke21bM119LSR7U3RyaW5nKG1bMl0pLnBhZFN0YXJ0KDIsIjAiKX0tJHtTdHJpbmcobVsxXSkucGFkU3RhcnQoMiwiMCIpfWA7bGV0IGQ9bmV3IERhdGUodik7cmV0dXJuIGlzTmFOKGQpPyIiOmQudG9JU09TdHJpbmcoKS5zbGljZSgwLDEwKX0KZnVuY3Rpb24gZmlyc3RNYXRjaCh0ZXh0LHBhdHRlcm5zKXtmb3IoY29uc3QgcCBvZiBwYXR0ZXJucyl7Y29uc3QgbT10ZXh0Lm1hdGNoKHApO2lmKG0mJm1bMV0pcmV0dXJuIGNsZWFuKG1bMV0pfXJldHVybiIifQoKYXN5bmMgZnVuY3Rpb24gZ2V0UGRmTGliKCl7CiBpZighd2luZG93LnBkZmpzTGliKSB0aHJvdyBuZXcgRXJyb3IoIlBERi5qcyBjaMawYSB04bqjaSDEkcaw4bujYyB04burIENETi4iKTsKIHBkZmpzTGliLkdsb2JhbFdvcmtlck9wdGlvbnMud29ya2VyU3JjPSJodHRwczovL2NkbmpzLmNsb3VkZmxhcmUuY29tL2FqYXgvbGlicy9wZGYuanMvMy4xMS4xNzQvcGRmLndvcmtlci5taW4uanMiOwogcmV0dXJuIHdpbmRvdy5wZGZqc0xpYjsKfQphc3luYyBmdW5jdGlvbiByZWFkUGRmKGZpbGUpewogIGNvbnN0IHBkZmpzPWF3YWl0IGdldFBkZkxpYigpOwogIGNvbnN0IHBkZj1hd2FpdCBwZGZqcy5nZXREb2N1bWVudCh7ZGF0YTphd2FpdCBmaWxlLmFycmF5QnVmZmVyKCl9KS5wcm9taXNlOwogIHN0YXRlLnBkZj1wZGY7CiAgc3RhdGUucGFnZVRleHQ9W107CiAgc3RhdGUucGFnZUNvbHVtblRleHQ9W107CiAgc3RhdGUucGFnZVF1YWxpdHk9W107CiAgc3RhdGUuYmFkVGV4dFBhZ2VzPVtdOwoKICBmdW5jdGlvbiBpdGVtc1RvTGluZXMoaXRlbXMpewogICAgaWYoIWl0ZW1zLmxlbmd0aCkgcmV0dXJuICIiOwogICAgY29uc3QgaGVpZ2h0cz1pdGVtcy5tYXAoeD0+TWF0aC5hYnMoeC5ofHwxMCkpLmZpbHRlcihCb29sZWFuKS5zb3J0KChhLGIpPT5hLWIpOwogICAgY29uc3QgbWVkaWFuSD1oZWlnaHRzW01hdGguZmxvb3IoaGVpZ2h0cy5sZW5ndGgvMildfHwxMDsKICAgIGNvbnN0IHRvbD1NYXRoLm1heCgyLjIsTWF0aC5taW4oNSxtZWRpYW5IKi4zOCkpOwoKICAgIGNvbnN0IHJvd3M9W107CiAgICBjb25zdCBzb3J0ZWQ9aXRlbXMuc2xpY2UoKS5zb3J0KChhLGIpPT5iLnktYS55IHx8IGEueC1iLngpOwogICAgZm9yKGNvbnN0IGl0IG9mIHNvcnRlZCl7CiAgICAgIGxldCByb3c9cm93cy5maW5kKHI9Pk1hdGguYWJzKHIueS1pdC55KTw9dG9sKTsKICAgICAgaWYoIXJvdyl7cm93PXt5Oml0LnksaXRlbXM6W119O3Jvd3MucHVzaChyb3cpfQogICAgICByb3cuaXRlbXMucHVzaChpdCk7CiAgICB9CiAgICByb3dzLnNvcnQoKGEsYik9PmIueS1hLnkpOwoKICAgIHJldHVybiByb3dzLm1hcChyPT57CiAgICAgIGNvbnN0IHhzPXIuaXRlbXMuc29ydCgoYSxiKT0+YS54LWIueCk7CiAgICAgIGxldCBvdXQ9IiI7CiAgICAgIGxldCBwcmV2PW51bGw7CiAgICAgIGZvcihjb25zdCBpdCBvZiB4cyl7CiAgICAgICAgY29uc3Qgcz1TdHJpbmcoaXQuc3x8IiIpOwogICAgICAgIGlmKCFzKSBjb250aW51ZTsKICAgICAgICBpZihwcmV2KXsKICAgICAgICAgIGNvbnN0IGdhcD1pdC54LShwcmV2LngrcHJldi53KTsKICAgICAgICAgIC8vIEFkZCBhIHNwYWNlIG9ubHkgd2hlbiB2aXN1YWwgZ2FwIHN1Z2dlc3RzIG9uZSBhbmQgcHVuY3R1YXRpb24gZG9lcyBub3QuCiAgICAgICAgICBpZihnYXA+TWF0aC5tYXgoMS41LChwcmV2Lmh8fDEwKSouMTIpICYmICEvW1xzXC1cL10kLy50ZXN0KG91dCkgJiYgIS9eWywuOzolXCldLy50ZXN0KHMpKSBvdXQrPSIgIjsKICAgICAgICB9CiAgICAgICAgb3V0Kz1zOwogICAgICAgIHByZXY9aXQ7CiAgICAgIH0KICAgICAgcmV0dXJuIG91dC50cmltKCk7CiAgICB9KS5maWx0ZXIoQm9vbGVhbikuam9pbigiXG4iKTsKICB9CgogIGZvcihsZXQgcD0xO3A8PXBkZi5udW1QYWdlcztwKyspewogICAgY29uc3QgcGFnZT1hd2FpdCBwZGYuZ2V0UGFnZShwKTsKICAgIGNvbnN0IHZpZXdwb3J0PXBhZ2UuZ2V0Vmlld3BvcnQoe3NjYWxlOjF9KTsKICAgIGNvbnN0IGNvbnRlbnQ9YXdhaXQgcGFnZS5nZXRUZXh0Q29udGVudCh7ZGlzYWJsZU5vcm1hbGl6YXRpb246ZmFsc2V9KTsKCiAgICBjb25zdCBpdGVtcz1jb250ZW50Lml0ZW1zCiAgICAgIC5maWx0ZXIoeD0+eCAmJiB0eXBlb2YgeC5zdHI9PT0ic3RyaW5nIiAmJiB4LnN0ci50cmltKCkpCiAgICAgIC5tYXAoeD0+KHsKICAgICAgICBzOnguc3RyLm5vcm1hbGl6ZSgiTkZDIiksCiAgICAgICAgeDp4LnRyYW5zZm9ybVs0XSwKICAgICAgICB5OngudHJhbnNmb3JtWzVdLAogICAgICAgIHc6TnVtYmVyKHgud2lkdGgpfHwwLAogICAgICAgIGg6TnVtYmVyKHguaGVpZ2h0KXx8TWF0aC5hYnMoeC50cmFuc2Zvcm1bM10pfHwxMAogICAgICB9KSk7CgogICAgbGV0IHNpbXBsZT1zdHJpcFBkZkFydGlmYWN0cyhpdGVtc1RvTGluZXMoaXRlbXMpKTsKICAgIGNvbnN0IG1pZD12aWV3cG9ydC53aWR0aC8yOwogICAgbGV0IGxlZnQ9c3RyaXBQZGZBcnRpZmFjdHMoaXRlbXNUb0xpbmVzKGl0ZW1zLmZpbHRlcih4PT54Lng8bWlkKSkpOwogICAgbGV0IHJpZ2h0PXN0cmlwUGRmQXJ0aWZhY3RzKGl0ZW1zVG9MaW5lcyhpdGVtcy5maWx0ZXIoeD0+eC54Pj1taWQpKSk7CgogICAgY29uc3QgcT10ZXh0TGF5ZXJRdWFsaXR5U2NvcmUoc2ltcGxlKTsKICAgIHN0YXRlLnBhZ2VUZXh0LnB1c2goc2ltcGxlKTsKICAgIHN0YXRlLnBhZ2VDb2x1bW5UZXh0LnB1c2gobGVmdCsiXG4iK3JpZ2h0KTsKICAgIHN0YXRlLnBhZ2VRdWFsaXR5LnB1c2gocSk7CiAgICBpZihxPDQ4KSBzdGF0ZS5iYWRUZXh0UGFnZXMucHVzaChwKTsKCiAgICAkKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPU1hdGgucm91bmQocC9wZGYubnVtUGFnZXMqMzUpKyIlIjsKICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PWDEkGFuZyDEkeG7jWMgdGV4dCBsYXllcjogJHtwfS8ke3BkZi5udW1QYWdlc30gwrcgY2jhuqV0IGzGsOG7o25nICR7cX0vMTAwYDsKICB9CiAgcmV0dXJuIHBkZjsKfQoKZnVuY3Rpb24gdGV4dFF1YWxpdHkoKXsKICBjb25zdCBjaGFycz1zdGF0ZS5wYWdlVGV4dC5yZWR1Y2UoKG4scyk9Pm4rcy5sZW5ndGgsMCk7CiAgY29uc3QgZ29vZD1zdGF0ZS5wYWdlUXVhbGl0eS5maWx0ZXIoeD0+eD49NDgpLmxlbmd0aDsKICByZXR1cm4ge2NoYXJzLGF2ZzpjaGFycy9NYXRoLm1heCgxLHN0YXRlLnBhZ2VUZXh0Lmxlbmd0aCksZ29vZFBhZ2VzOmdvb2QsYmFkUGFnZXM6c3RhdGUuYmFkVGV4dFBhZ2VzLmxlbmd0aH07Cn0KCmFzeW5jIGZ1bmN0aW9uIHJlbmRlclBhZ2VDYW52YXMocGFnZU5vLHNjYWxlPTEuNzUpewogIGNvbnN0IHBhZ2U9YXdhaXQgc3RhdGUucGRmLmdldFBhZ2UocGFnZU5vKSx2aWV3cG9ydD1wYWdlLmdldFZpZXdwb3J0KHtzY2FsZX0pOwogIGNvbnN0IGNhbnZhcz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJjYW52YXMiKTtjYW52YXMud2lkdGg9TWF0aC5jZWlsKHZpZXdwb3J0LndpZHRoKTtjYW52YXMuaGVpZ2h0PU1hdGguY2VpbCh2aWV3cG9ydC5oZWlnaHQpOwogIGF3YWl0IHBhZ2UucmVuZGVyKHtjYW52YXNDb250ZXh0OmNhbnZhcy5nZXRDb250ZXh0KCIyZCIpLHZpZXdwb3J0fSkucHJvbWlzZTtyZXR1cm4gY2FudmFzOwp9CgpmdW5jdGlvbiBwcmVwcm9jZXNzT2NyQ2FudmFzKHNyYyl7CiAgY29uc3Qgb3V0PWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImNhbnZhcyIpOwogIG91dC53aWR0aD1zcmMud2lkdGg7IG91dC5oZWlnaHQ9c3JjLmhlaWdodDsKICBjb25zdCBjdHg9b3V0LmdldENvbnRleHQoIjJkIix7d2lsbFJlYWRGcmVxdWVudGx5OnRydWV9KTsKICBjdHguZHJhd0ltYWdlKHNyYywwLDApOwogIGNvbnN0IGltZz1jdHguZ2V0SW1hZ2VEYXRhKDAsMCxvdXQud2lkdGgsb3V0LmhlaWdodCk7CiAgY29uc3QgZD1pbWcuZGF0YTsKCiAgLy8gSGlzdG9ncmFtIGdyYXlzY2FsZSBmb3Igcm9idXN0IHRocmVzaG9sZC4KICBjb25zdCBoaXN0PW5ldyBBcnJheSgyNTYpLmZpbGwoMCk7CiAgZm9yKGxldCBpPTA7aTxkLmxlbmd0aDtpKz00KXsKICAgIGNvbnN0IGc9TWF0aC5tYXgoMCxNYXRoLm1pbigyNTUsTWF0aC5yb3VuZCgwLjI5OSpkW2ldKzAuNTg3KmRbaSsxXSswLjExNCpkW2krMl0pKSk7CiAgICBoaXN0W2ddKys7CiAgfQogIGxldCB0b3RhbD1vdXQud2lkdGgqb3V0LmhlaWdodCxzdW09MDsKICBmb3IobGV0IGk9MDtpPDI1NjtpKyspIHN1bSs9aSpoaXN0W2ldOwogIGxldCBzdW1CPTAsd0I9MCxtYXhWYXI9MCx0aHI9MTc4OwogIGZvcihsZXQgdD0wO3Q8MjU2O3QrKyl7CiAgICB3Qis9aGlzdFt0XTsgaWYoIXdCKSBjb250aW51ZTsKICAgIGNvbnN0IHdGPXRvdGFsLXdCOyBpZighd0YpIGJyZWFrOwogICAgc3VtQis9dCpoaXN0W3RdOwogICAgY29uc3QgbUI9c3VtQi93QixtRj0oc3VtLXN1bUIpL3dGOwogICAgY29uc3Qgdj13Qip3RioobUItbUYpKihtQi1tRik7CiAgICBpZih2Pm1heFZhcil7bWF4VmFyPXY7dGhyPXR9CiAgfQogIC8vIEF2b2lkIG92ZXJseSBhZ2dyZXNzaXZlIHRocmVzaG9sZCBmb3IgcGFsZSBzY2Fucy4KICB0aHI9TWF0aC5tYXgoMTQ1LE1hdGgubWluKDIwNSx0aHIrMTIpKTsKCiAgZm9yKGxldCBpPTA7aTxkLmxlbmd0aDtpKz00KXsKICAgIGxldCBnPTAuMjk5KmRbaV0rMC41ODcqZFtpKzFdKzAuMTE0KmRbaSsyXTsKICAgIC8vIGNvbnRyYXN0IHN0cmV0Y2ggYmVmb3JlIGJpbmFyaXphdGlvbgogICAgZz0oZy0xMjgpKjEuMjIrMTI4OwogICAgY29uc3Qgdj1nPHRocj8wOjI1NTsKICAgIGRbaV09ZFtpKzFdPWRbaSsyXT12OwogICAgZFtpKzNdPTI1NTsKICB9CiAgY3R4LnB1dEltYWdlRGF0YShpbWcsMCwwKTsKICByZXR1cm4gb3V0Owp9CgpmdW5jdGlvbiBvY3JRdWFsaXR5U2NvcmUodGV4dCxjb25maWRlbmNlPTApewogIGNvbnN0IGY9Zm9sZFZOKHRleHR8fCIiKTsKICBsZXQgc2NvcmU9TnVtYmVyKGNvbmZpZGVuY2UpfHwwOwogIGNvbnN0IHBhdGVudFdvcmRzPVsiWUVVIENBVSBCQU8gSE8iLCJRVVkgVFJJTkgiLCJQSFVPTkcgUEhBUCIsIkJBTyBHT00iLCJUUk9ORyBETyIsIlNBTkcgQ0hFIiwiVEhJRVQgQkkiLCJIRSBUSE9ORyIsIlRIQU5IIFBIQU4iXTsKICBmb3IoY29uc3QgdyBvZiBwYXRlbnRXb3JkcykgaWYoZi5pbmNsdWRlcyh3KSkgc2NvcmUrPTg7CiAgc2NvcmUrPU1hdGgubWluKDIwLCh0ZXh0fHwiIikubGVuZ3RoLzI1MCk7CiAgLy8gUGVuYWxpemUgb2J2aW91cyBPQ1IgZ2FyYmFnZS4KICBjb25zdCB3ZWlyZD0oKHRleHR8fCIiKS5tYXRjaCgvW3x7fTw+fl5gXS9nKXx8W10pLmxlbmd0aDsKICBzY29yZS09TWF0aC5taW4oMjAsd2VpcmQqMik7CiAgcmV0dXJuIHNjb3JlOwp9CgoKY29uc3Qgc2xlZXAgPSBtcyA9PiBuZXcgUHJvbWlzZShyID0+IHNldFRpbWVvdXQociwgbXMpKTsKZnVuY3Rpb24gd2l0aFRpbWVvdXQocHJvbWlzZSwgbXMsIGxhYmVsKXsKICBsZXQgdGltZXI7CiAgY29uc3QgdGltZW91dCA9IG5ldyBQcm9taXNlKChfLCByZWplY3QpID0+IHsKICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiByZWplY3QobmV3IEVycm9yKGxhYmVsICsgIiBxdcOhIHRo4budaSBnaWFuIikpLCBtcyk7CiAgfSk7CiAgcmV0dXJuIFByb21pc2UucmFjZShbcHJvbWlzZSwgdGltZW91dF0pLmZpbmFsbHkoKCkgPT4gY2xlYXJUaW1lb3V0KHRpbWVyKSk7Cn0KCmxldCBvY3JXb3JrZXJQcm9taXNlID0gbnVsbDsKY29uc3QgVEVTU19DRkc9ewogIHdvcmtlclBhdGg6Imh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9ucG0vdGVzc2VyYWN0LmpzQDUuMS4xL2Rpc3Qvd29ya2VyLm1pbi5qcyIsCiAgY29yZVBhdGg6Imh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9ucG0vdGVzc2VyYWN0LmpzLWNvcmVANS4xLjEiLAogIGxhbmdQYXRoOiJodHRwczovL3Rlc3NkYXRhLnByb2plY3RuYXB0aGEuY29tLzQuMC4wIgp9OwoKYXN5bmMgZnVuY3Rpb24gcHJvYmVUZXNzUGFjayhsYW5nKXsKICBjb25zdCB1cmw9YCR7VEVTU19DRkcubGFuZ1BhdGh9LyR7bGFuZ30udHJhaW5lZGRhdGEuZ3pgOwogIHRyeXsKICAgIC8vIFJhbmdlIGtlZXBzIHRoaXMgZGlhZ25vc3RpYyBsaWdodHdlaWdodCB3aGVuIHRoZSBDRE4gc3VwcG9ydHMgaXQuCiAgICBjb25zdCByPWF3YWl0IGZldGNoKHVybCx7aGVhZGVyczp7UmFuZ2U6ImJ5dGVzPTAtMzEifSxjYWNoZToiZm9yY2UtY2FjaGUifSk7CiAgICBpZighci5vayAmJiByLnN0YXR1cyE9PTIwNikgdGhyb3cgbmV3IEVycm9yKGAke2xhbmd9LnRyYWluZWRkYXRhIEhUVFAgJHtyLnN0YXR1c31gKTsKICAgIHN0YXRlLnRlc3NEaWFnW2xhbmddPXRydWU7CiAgICByZW5kZXJUZXNzRGlhZygpOwogICAgcmV0dXJuIHRydWU7CiAgfWNhdGNoKGUpewogICAgc3RhdGUudGVzc0RpYWcuZXJyb3I9YEtow7RuZyB04bqjaSDEkcaw4bujYyAke2xhbmd9LnRyYWluZWRkYXRhOiAke1N0cmluZyhlLm1lc3NhZ2V8fGUpfWA7CiAgICByZW5kZXJUZXNzRGlhZygpOwogICAgdGhyb3cgZTsKICB9Cn0KCmFzeW5jIGZ1bmN0aW9uIGdldE9jcldvcmtlcihyZWFzb249Ik9DUiIpewogIGlmKG9jcldvcmtlclByb21pc2UpIHJldHVybiBvY3JXb3JrZXJQcm9taXNlOwogIGlmKCF3aW5kb3cuVGVzc2VyYWN0KSB0aHJvdyBuZXcgRXJyb3IoIktow7RuZyB04bqjaSDEkcaw4bujYyBUZXNzZXJhY3QuanMuIik7CgogIHN0YXRlLnRlc3NEaWFnPXt2aWU6ZmFsc2UsZW5nOmZhbHNlLGVycm9yOiIifTsKICByZW5kZXJUZXNzRGlhZygpOwogIHNldERldGVjdCgiZGV0T0NSIixmYWxzZSwixJBhbmcgdOG6o2kgdmllICsgZW5nLi4uIik7CiAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9cmVhc29uKyI6IMSRYW5nIGtp4buDbSB0cmEgbGFuZ3VhZ2UgcGFja3MgdGnhur9uZyBWaeG7h3QgKyB0aeG6v25nIEFuaC4uLiI7CiAgYXdhaXQgc2xlZXAoNjApOwoKICAvLyBEbyBub3Qgc2lsZW50bHkgY29udGludWUgaWYgVmlldG5hbWVzZSB0cmFpbmVkZGF0YSBpcyB1bmF2YWlsYWJsZS4KICBhd2FpdCBQcm9taXNlLmFsbChbcHJvYmVUZXNzUGFjaygidmllIikscHJvYmVUZXNzUGFjaygiZW5nIildKTsKCiAgY29uc3QgbGFuZ3M9WyJ2aWUiLCJlbmciXTsgLy8gZG9jdW1lbnRlZCBUZXNzZXJhY3QuanMgdjUgbXVsdGktbGFuZ3VhZ2Ugc3ludGF4CiAgY29uc3QgT0VNPShUZXNzZXJhY3QuT0VNICYmIFRlc3NlcmFjdC5PRU0uTFNUTV9PTkxZKSB8fCAxOwoKICBvY3JXb3JrZXJQcm9taXNlPXdpdGhUaW1lb3V0KAogICAgVGVzc2VyYWN0LmNyZWF0ZVdvcmtlcihsYW5ncyxPRU0sewogICAgICB3b3JrZXJQYXRoOlRFU1NfQ0ZHLndvcmtlclBhdGgsCiAgICAgIGNvcmVQYXRoOlRFU1NfQ0ZHLmNvcmVQYXRoLAogICAgICBsYW5nUGF0aDpURVNTX0NGRy5sYW5nUGF0aCwKICAgICAgZ3ppcDp0cnVlLAogICAgICBjYWNoZU1ldGhvZDoid3JpdGUiLAogICAgICBsb2dnZXI6bT0+ewogICAgICAgIGlmKCFtKSByZXR1cm47CiAgICAgICAgY29uc3Qgc3RhdHVzPVN0cmluZyhtLnN0YXR1c3x8IiIpOwogICAgICAgIGNvbnN0IHBjdD1NYXRoLnJvdW5kKChtLnByb2dyZXNzfHwwKSoxMDApOwoKICAgICAgICBpZigvbG9hZGluZyBsYW5ndWFnZSB0cmFpbmVkZGF0YS9pLnRlc3Qoc3RhdHVzKSl7CiAgICAgICAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1gJHtyZWFzb259OiDEkWFuZyB04bqjaSB2aWUgKyBlbmcgdHJhaW5lZGRhdGEgJHtwY3R9JWA7CiAgICAgICAgfWVsc2UgaWYoL2luaXRpYWxpemluZyBhcGkvaS50ZXN0KHN0YXR1cykpewogICAgICAgICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YCR7cmVhc29ufToga2jhu59pIHThuqFvIE9DUiB2aWUgKyBlbmcgJHtwY3R9JWA7CiAgICAgICAgfWVsc2UgaWYoc3RhdHVzPT09InJlY29nbml6aW5nIHRleHQiKXsKICAgICAgICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PWAke3JlYXNvbn06IG5o4bqtbiBkaeG7h24gdmllICsgZW5nICR7cGN0fSVgOwogICAgICAgIH0KICAgICAgfSwKICAgICAgZXJyb3JIYW5kbGVyOmVycj0+ewogICAgICAgIHN0YXRlLnRlc3NEaWFnLmVycm9yPVN0cmluZyhlcnImJmVyci5tZXNzYWdlP2Vyci5tZXNzYWdlOmVycik7CiAgICAgICAgcmVuZGVyVGVzc0RpYWcoKTsKICAgICAgICBjb25zb2xlLmVycm9yKCJUZXNzZXJhY3Qgd29ya2VyOiIsZXJyKTsKICAgICAgfQogICAgfSksCiAgICA0NTAwMCwKICAgICJLaOG7n2kgdOG6oW8gT0NSIHZpZSArIGVuZyIKICApOwoKICB0cnl7CiAgICBjb25zdCB3b3JrZXI9YXdhaXQgb2NyV29ya2VyUHJvbWlzZTsKICAgIGF3YWl0IHdvcmtlci5zZXRQYXJhbWV0ZXJzKHsKICAgICAgcHJlc2VydmVfaW50ZXJ3b3JkX3NwYWNlczoiMSIsCiAgICAgIHVzZXJfZGVmaW5lZF9kcGk6IjMwMCIKICAgIH0pOwogICAgc3RhdGUudGVzc0RpYWcudmllPXRydWU7CiAgICBzdGF0ZS50ZXNzRGlhZy5lbmc9dHJ1ZTsKICAgIHJlbmRlclRlc3NEaWFnKCk7CiAgICByZXR1cm4gd29ya2VyOwogIH1jYXRjaChlKXsKICAgIG9jcldvcmtlclByb21pc2U9bnVsbDsKICAgIHN0YXRlLnRlc3NEaWFnLmVycm9yPVN0cmluZyhlLm1lc3NhZ2V8fGUpOwogICAgcmVuZGVyVGVzc0RpYWcoKTsKICAgIHRocm93IGU7CiAgfQp9Cgphc3luYyBmdW5jdGlvbiBvY3JTZWxlY3RlZFBhZ2VzKHBhZ2VOb3MscmVhc29uPSJPQ1IiLGZvcmNlPWZhbHNlKXsKICBpZighc3RhdGUucGRmKSByZXR1cm4gZmFsc2U7CiAgdHJ5ewogICAgbGV0IGxvY2FsV29ya2VyPW51bGw7CiAgICBsZXQgZG9uZT0wOwoKICAgIGZvcihjb25zdCBwIG9mIHBhZ2VOb3MpewogICAgICBpZihzdGF0ZS5vY3JQYWdlc1twXSYmIWZvcmNlKXtkb25lKys7Y29udGludWU7fQogICAgICBpZihmb3JjZSkgZGVsZXRlIHN0YXRlLm9jclBhZ2VzW3BdOwoKICAgICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YCR7cmVhc29ufTogdHJhbmcgJHtwfS4uLmA7CiAgICAgIGF3YWl0IHNsZWVwKDIwKTsKCiAgICAgIGNvbnN0IGNhbmRpZGF0ZXM9W107CiAgICAgIGNvbnN0IGRpcmVjdD1zdGF0ZS5wYWdlVGV4dFtwLTFdfHwiIjsKICAgICAgaWYoZGlyZWN0LnRyaW0oKSkgY2FuZGlkYXRlcy5wdXNoKHtzb3VyY2U6IlBERiB0ZXh0IGxheWVyIix0ZXh0OmRpcmVjdH0pOwoKICAgICAgLy8gQ2xvdWQgVmlzaW9uIG1heSBiZSBhdmFpbGFibGU7IGtlZXAgYXMgY29tcGFyYXRvciwgbm90IGF1dG9tYXRpYyB3aW5uZXIuCiAgICAgIGNvbnN0IHJhd0NhbnZhcz1hd2FpdCByZW5kZXJQYWdlQ2FudmFzKHAsMi42NSk7CiAgICAgIHRyeXsKICAgICAgICBjb25zdCBjbG91ZFRleHQ9YXdhaXQgY2xvdWRWaXNpb25PY3IocmF3Q2FudmFzKTsKICAgICAgICBpZihjbG91ZFRleHQmJmNsb3VkVGV4dC5sZW5ndGg+MjApIGNhbmRpZGF0ZXMucHVzaCh7c291cmNlOiJHb29nbGUgVmlzaW9uIix0ZXh0OmNsb3VkVGV4dH0pOwogICAgICB9Y2F0Y2goX2Upe30KCiAgICAgIC8vIEV4cGxpY2l0IFRlc3NlcmFjdCB2aWUgKyBlbmcuCiAgICAgIGlmKCFsb2NhbFdvcmtlcikgbG9jYWxXb3JrZXI9YXdhaXQgZ2V0T2NyV29ya2VyKHJlYXNvbik7CiAgICAgIGNvbnN0IGNsZWFuQ2FudmFzPXByZXByb2Nlc3NPY3JDYW52YXMocmF3Q2FudmFzKTsKCiAgICAgIGZvcihjb25zdCBwc20gb2YgWyIzIiwiNiJdKXsKICAgICAgICB0cnl7CiAgICAgICAgICBhd2FpdCBsb2NhbFdvcmtlci5zZXRQYXJhbWV0ZXJzKHsKICAgICAgICAgICAgcHJlc2VydmVfaW50ZXJ3b3JkX3NwYWNlczoiMSIsCiAgICAgICAgICAgIHVzZXJfZGVmaW5lZF9kcGk6IjMwMCIsCiAgICAgICAgICAgIHRlc3NlZGl0X3BhZ2VzZWdfbW9kZTpwc20KICAgICAgICAgIH0pOwogICAgICAgICAgY29uc3QgcmVzdWx0PWF3YWl0IHdpdGhUaW1lb3V0KAogICAgICAgICAgICBsb2NhbFdvcmtlci5yZWNvZ25pemUocHNtPT09IjYiP2NsZWFuQ2FudmFzOnJhd0NhbnZhcyksCiAgICAgICAgICAgIDY1MDAwLAogICAgICAgICAgICBgT0NSIHZpZStlbmcgdHJhbmcgJHtwfSBQU00gJHtwc219YAogICAgICAgICAgKTsKICAgICAgICAgIGNvbnN0IHR4dD0ocmVzdWx0JiZyZXN1bHQuZGF0YSYmcmVzdWx0LmRhdGEudGV4dCl8fCIiOwogICAgICAgICAgaWYodHh0LnRyaW0oKSkgY2FuZGlkYXRlcy5wdXNoKHtzb3VyY2U6YFRlc3NlcmFjdCB2aWUrZW5nIFBTTSAke3BzbX1gLHRleHQ6dHh0fSk7CiAgICAgICAgfWNhdGNoKGUpe2NvbnNvbGUud2FybigiT0NSIHBhc3MiLHBzbSxlKX0KICAgICAgfQoKICAgICAgY29uc3QgcmFua2VkPWNhbmRpZGF0ZXMKICAgICAgICAubWFwKHg9Pih7Li4ueCx0ZXh0OnJlcGFpckNlcnRhaW5Wbk9jcih4LnRleHQpLHNjb3JlOnZuT2NyUXVhbGl0eSh4LnRleHQpfSkpCiAgICAgICAgLnNvcnQoKGEsYik9PmIuc2NvcmUtYS5zY29yZSk7CgogICAgICBjb25zdCBiZXN0PXJhbmtlZFswXTsKICAgICAgaWYoYmVzdCl7CiAgICAgICAgc3RhdGUub2NyUGFnZXNbcF09dHJ1bmNhdGVDbGFpbUF0RmlndXJlKGJlc3QudGV4dCk7CiAgICAgICAgc3RhdGUuY2xhaW1Tb3VyY2VCeVBhZ2VbcF09e3NvdXJjZTpiZXN0LnNvdXJjZSxzY29yZTpiZXN0LnNjb3JlfTsKICAgICAgICBzZXREZXRlY3QoImRldE9DUiIsdHJ1ZSxgJHtiZXN0LnNvdXJjZX0gwrcgdHJhbmcgJHtwfSDCtyAke2Jlc3Quc2NvcmV9LzEwMGApOwogICAgICB9ZWxzZXsKICAgICAgICBzdGF0ZS5vY3JQYWdlc1twXT0iIjsKICAgICAgfQoKICAgICAgZG9uZSsrOwogICAgICAkKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPSg0NStNYXRoLnJvdW5kKGRvbmUvcGFnZU5vcy5sZW5ndGgqNTApKSsiJSI7CiAgICB9CiAgICByZXR1cm4gdHJ1ZTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLmVycm9yKCJPQ1IgZXJyb3IiLGUpOwogICAgc2V0RGV0ZWN0KCJkZXRPQ1IiLGZhbHNlLCJPQ1IgbOG7l2kiKTsKICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PSJPQ1Iga2jDtG5nIGNo4bqheSDEkcaw4bujYzogIitTdHJpbmcoZS5tZXNzYWdlfHxlKTsKICAgIHJldHVybiBmYWxzZTsKICB9Cn0KCmZ1bmN0aW9uIGhhc0NsYWltTWFya2VyKHQpewogIHJldHVybiAhIWNsYWltTWFya2VySW5mbyh0KTsKfQoKYXN5bmMgZnVuY3Rpb24gc21hcnRPY3JDbGFpbXMoYXV0bz1mYWxzZSl7CiAgaWYoIXN0YXRlLnBkZikgcmV0dXJuIGZhbHNlOwoKICBjb25zdCBuPXN0YXRlLnBkZi5udW1QYWdlczsKICAvLyBDbGFpbXMgY+G7p2EgYuG6sW5nIFZOIHRoxrDhu51uZyBu4bqxbSBuZ2F5IHRyxrDhu5tjIHBo4bqnbiBow6xuaCB24bq9LgogIC8vIFbhu5tpIFBERiAxNCB0cmFuZyBj4bunYSDEkGnhu4FuIFRyw7pjLCB0aOG7qSB04buxIG7DoHkgT0NSIHRyYW5nIDEyIMSQ4bqmVSBUScOKTi4KICBjb25zdCByYXdPcmRlcj1bbi0yLG4tMyxuLTEsbi00LG4sbi01LG4tNixuLTddOwogIGNvbnN0IGNhbmRpZGF0ZXM9Wy4uLm5ldyBTZXQocmF3T3JkZXIpXS5maWx0ZXIocD0+cD49MSAmJiBwPD1uKTsKCiAgc2V0RGV0ZWN0KCJkZXRPQ1IiLGZhbHNlLCLEkGFuZyBPQ1IgY2xhaW1zLi4uIik7CiAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YXV0bwogICAgPyAiUERGIGThuqFuZyBzY2FuIOKAlCDEkWFuZyB04buxIHF1w6l0IGPDoWMgdHJhbmcgY3Xhu5FpIMSR4buDIHTDrG0gWcOqdSBj4bqndSBi4bqjbyBo4buZLi4uIgogICAgOiAixJBhbmcgcXXDqXQgY8OhYyB0cmFuZyBjdeG7kWkgxJHhu4MgdMOsbSBZw6p1IGPhuqd1IGLhuqNvIGjhu5kuLi4iOwoKICBsZXQgZm91bmRQYWdlPW51bGw7CgogIGZvcihsZXQgaT0wO2k8Y2FuZGlkYXRlcy5sZW5ndGg7aSsrKXsKICAgIGNvbnN0IHA9Y2FuZGlkYXRlc1tpXTsKICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PWBPQ1IgecOqdSBj4bqndSBi4bqjbyBo4buZOiB0cmFuZyAke3B9LyR7bn0gKCR7aSsxfS8ke2NhbmRpZGF0ZXMubGVuZ3RofSkuLi5gOwoKICAgIGNvbnN0IG9rPWF3YWl0IG9jclNlbGVjdGVkUGFnZXMoW3BdLGBPQ1IgdHJhbmcgJHtwfWApOwogICAgaWYoIW9rKXsKICAgICAgLy8gT0NSIGZhaWwgdGjDrCB0aG/DoXQgc+G6oWNoLCBLSMOUTkcgdHJlbyBVSS4KICAgICAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMTAwJSI7CiAgICAgIHJldHVybiBmYWxzZTsKICAgIH0KCiAgICBjb25zdCB0PXN0YXRlLm9jclBhZ2VzW3BdfHwiIjsKICAgIGlmKGhhc0NsYWltTWFya2VyKHQpIHx8IGxvb2tzTGlrZUNsYWltUGFnZSh0KSl7CiAgICAgIGZvdW5kUGFnZT1wOwogICAgICBicmVhazsKICAgIH0KICB9CgogIGlmKCFmb3VuZFBhZ2UpewogICAgc3RhdGUucmF3VGV4dD1tZXJnZWRUZXh0KCk7CiAgICBjb25zdCBmYWxsYmFjaz1jYW5kaWRhdGVDbGFpbXNUZXh0KCk7CiAgICBzdGF0ZS5jbGFpbXNUZXh0PWZhbGxiYWNrfHwiIjsKICAgICQoImNsYWltc1JhdyIpLnZhbHVlPXN0YXRlLmNsYWltc1RleHQ7JCgiY2xhaW1zQ2xlYW4iKS52YWx1ZT1mb3JtYXRDbGFpbUZvckRpc3BsYXkoc3RhdGUuY2xhaW1zVGV4dCk7CiAgICBzdGF0ZS5jbGFpbXM9cGFyc2VDbGFpbXMoc3RhdGUuY2xhaW1zVGV4dCk7CiAgICBzdGF0ZS5zZWxlY3RlZD0wOwogICAgcmVuZGVyQ2xhaW1zKCk7CiAgICBzZXREZXRlY3QoImRldENsYWltcyIsc3RhdGUuY2xhaW1zLmxlbmd0aD4wLAogICAgICBzdGF0ZS5jbGFpbXMubGVuZ3RoP2DEkMOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW1gOiJPQ1IgeG9uZyBuaMawbmcgY2jGsGEgdMOsbSB0aOG6pXkgY2xhaW0iKTsKICAgICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjEwMCUiOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9c3RhdGUuY2xhaW1zLmxlbmd0aAogICAgICA/YE9DUiBob8OgbiB04bqldC4gxJDDoyBuaOG6rW4gZGnhu4duICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW0uYAogICAgICA6IsSQw6MgcXXDqXQgY8OhYyB0cmFuZyBjdeG7kWkgbmjGsG5nIGNoxrBhIG5o4bqtbiBkaeG7h24gxJHGsOG7o2MgY2xhaW0uIELhuqFuIHbhuqtuIGPDsyB0aOG7gyBwYXN0ZSBjbGFpbXMg4bufIGLGsOG7m2MgMi4iOwogICAgcmV0dXJuIHN0YXRlLmNsYWltcy5sZW5ndGg+MDsKICB9CgogIC8vIE9DUiB0aMOqbSAxIHRyYW5nIGvhur8gdGnhur9wIHbDrCBjbGFpbXMgY8OzIHRo4buDIGvDqW8gZMOgaSBzYW5nIHRyYW5nIHNhdS4KICBjb25zdCBmb2xsb3c9Zm91bmRQYWdlKzE7CiAgaWYoZm9sbG93PD1uICYmICFzdGF0ZS5vY3JQYWdlc1tmb2xsb3ddKXsKICAgICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PWDEkMOjIHTDrG0gdGjhuqV5IHRyYW5nIGNsYWltcyAke2ZvdW5kUGFnZX07IMSRYW5nIGtp4buDbSB0cmEgdHJhbmcgJHtmb2xsb3d9Li4uYDsKICAgIGF3YWl0IG9jclNlbGVjdGVkUGFnZXMoW2ZvbGxvd10sYE9DUiB0cmFuZyAke2ZvbGxvd31gKTsKICB9CgogIGNvbnN0IGNsYWltUGFnZXM9W2ZvdW5kUGFnZV07CiAgaWYoZm9sbG93PD1uICYmIHN0YXRlLm9jclBhZ2VzW2ZvbGxvd10pIGNsYWltUGFnZXMucHVzaChmb2xsb3cpOwogIGNvbnN0IGpvaW5lZD1jbGFpbVBhZ2VzLm1hcChwPT5zdGF0ZS5vY3JQYWdlc1twXXx8IiIpLmpvaW4oIlxuXG4iKTsKCiAgc3RhdGUucmF3VGV4dD1tZXJnZWRUZXh0KCk7CiAgbGV0IGM9ZXh0cmFjdENsYWltc1RhaWwoam9pbmVkKTsKICBpZighYykgYz1jYW5kaWRhdGVDbGFpbXNUZXh0KCk7CiAgaWYoIWMgJiYgbG9va3NMaWtlQ2xhaW1QYWdlKGpvaW5lZCkpIGM9Y2xlYW4oam9pbmVkKTsKCiAgc3RhdGUuY2xhaW1zVGV4dD1jfHwiIjsKICAkKCJjbGFpbXNSYXciKS52YWx1ZT1zdGF0ZS5jbGFpbXNUZXh0OyQoImNsYWltc0NsZWFuIikudmFsdWU9Zm9ybWF0Q2xhaW1Gb3JEaXNwbGF5KHN0YXRlLmNsYWltc1RleHQpOwogIHN0YXRlLmNsYWltcz1wYXJzZUNsYWltcyhzdGF0ZS5jbGFpbXNUZXh0KTsKICBzdGF0ZS5zZWxlY3RlZD0wOwogIHJlbmRlckNsYWltcygpOwoKICBzZXREZXRlY3QoImRldENsYWltcyIsc3RhdGUuY2xhaW1zLmxlbmd0aD4wLAogICAgc3RhdGUuY2xhaW1zLmxlbmd0aD9gxJDDoyB0w6FjaCAke3N0YXRlLmNsYWltcy5sZW5ndGh9IGNsYWltYDoixJDDoyB0aOG6pXkgdHJhbmcgY2xhaW1zIG5oxrBuZyBwYXJzZXIgY2jGsGEgdMOhY2ggxJHGsOG7o2MiKTsKICAkKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPSIxMDAlIjsKICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1zdGF0ZS5jbGFpbXMubGVuZ3RoCiAgICA/YEhvw6BuIHThuqV0LiBUw6xtIHRo4bqleSBZw6p1IGPhuqd1IGLhuqNvIGjhu5kg4bufIHRyYW5nICR7Zm91bmRQYWdlfSB2w6AgxJHDoyB0w6FjaCAke3N0YXRlLmNsYWltcy5sZW5ndGh9IGNsYWltLmAKICAgIDpgxJDDoyB0w6xtIHRo4bqleSB0cmFuZyBZw6p1IGPhuqd1IGLhuqNvIGjhu5kgJHtmb3VuZFBhZ2V9LCBuaMawbmcgY+G6p24ga2nhu4NtIHRyYSBu4buZaSBkdW5nIOG7nyBixrDhu5tjIDIuYDsKCiAgcmV0dXJuIHN0YXRlLmNsYWltcy5sZW5ndGg+MDsKfQoKZnVuY3Rpb24gbWVyZ2VkVGV4dCgpewogIGNvbnN0IG91dD1bXTsKICBmb3IobGV0IGk9MDtpPHN0YXRlLnBhZ2VUZXh0Lmxlbmd0aDtpKyspewogICAgY29uc3QgZGlyZWN0PXN0YXRlLnBhZ2VUZXh0W2ldfHwiIjsKICAgIGNvbnN0IHE9c3RhdGUucGFnZVF1YWxpdHlbaV18fDA7CiAgICBjb25zdCBvY3I9c3RhdGUub2NyUGFnZXNbaSsxXXx8IiI7CiAgICBvdXQucHVzaChxPj00OCA/IGRpcmVjdCA6IChvY3J8fGRpcmVjdCkpOwogIH0KICByZXR1cm4gb3V0LmpvaW4oIlxuXG4iKTsKfQoKZnVuY3Rpb24gY2xhaW1DYW5kaWRhdGVTY29yZSh0ZXh0KXsKICBpZighdGV4dCkgcmV0dXJuIC05OTk7CiAgbGV0IHNjb3JlPXRleHRMYXllclF1YWxpdHlTY29yZSh0ZXh0KTsKICBpZihoYXNDbGFpbU1hcmtlcih0ZXh0KSkgc2NvcmUrPTQ1OwogIGlmKGxvb2tzTGlrZUNsYWltUGFnZSh0ZXh0KSkgc2NvcmUrPTMwOwogIGNvbnN0IHBhcnNlZD1wYXJzZUNsYWltcyhleHRyYWN0Q2xhaW1zVGFpbCh0ZXh0KXx8dGV4dCk7CiAgc2NvcmUrPU1hdGgubWluKDQwLHBhcnNlZC5sZW5ndGgqMTApOwogIGNvbnN0IGdhcmJhZ2U9KHRleHQubWF0Y2goL1xkK1xzKlwvXHMqXGQrL2cpfHxbXSkubGVuZ3RoOwogIHNjb3JlLT1nYXJiYWdlKjg7CiAgcmV0dXJuIHNjb3JlOwp9CgpmdW5jdGlvbiBjYW5kaWRhdGVDbGFpbXNUZXh0KCl7CiAgY29uc3QgY2FuZGlkYXRlcz1bXTsKCiAgLy8gMSkgxq91IHRpw6puIHRleHQgbGF5ZXIgc+G6oWNoLiBLSMOUTkcgZMO5bmcgYuG6o24gbGVmdC9yaWdodCBnaMOpcCDEkcO0aSBu4bq/dSBraMO0bmcgY+G6p24uCiAgZm9yKGxldCBpPTA7aTxzdGF0ZS5wYWdlVGV4dC5sZW5ndGg7aSsrKXsKICAgIGNvbnN0IHNyYz1zdGF0ZS5wYWdlVGV4dFtpXXx8IiI7CiAgICBjb25zdCBxPXN0YXRlLnBhZ2VRdWFsaXR5W2ldfHwwOwogICAgaWYocTw0OCkgY29udGludWU7CgogICAgaWYoaGFzQ2xhaW1NYXJrZXIoc3JjKXx8bG9va3NMaWtlQ2xhaW1QYWdlKHNyYykpewogICAgICBjb25zdCBqb2luZWQ9W3NyY107CiAgICAgIGZvcihsZXQgaj1pKzE7ajxNYXRoLm1pbihzdGF0ZS5wYWdlVGV4dC5sZW5ndGgsaSs1KTtqKyspewogICAgICAgIGlmKChzdGF0ZS5wYWdlUXVhbGl0eVtqXXx8MCk+PTQ4KSBqb2luZWQucHVzaChzdGF0ZS5wYWdlVGV4dFtqXSk7CiAgICAgIH0KICAgICAgY29uc3QgYmxvY2s9am9pbmVkLmpvaW4oIlxuXG4iKTsKICAgICAgY29uc3QgdGFpbD1leHRyYWN0Q2xhaW1zVGFpbChibG9jayl8fGJsb2NrOwogICAgICBjYW5kaWRhdGVzLnB1c2goe3RleHQ6dGFpbCxzY29yZTpjbGFpbUNhbmRpZGF0ZVNjb3JlKHRhaWwpKzI1fSk7CiAgICB9CiAgfQoKICAvLyAyKSBPQ1IgcGFnZXMuCiAgZm9yKGNvbnN0IHNyYyBvZiBPYmplY3QudmFsdWVzKHN0YXRlLm9jclBhZ2VzKSl7CiAgICBpZighc3JjKSBjb250aW51ZTsKICAgIGNvbnN0IHRhaWw9ZXh0cmFjdENsYWltc1RhaWwoc3JjKXx8c3JjOwogICAgY2FuZGlkYXRlcy5wdXNoKHt0ZXh0OnRhaWwsc2NvcmU6Y2xhaW1DYW5kaWRhdGVTY29yZSh0YWlsKX0pOwogIH0KCiAgLy8gMykgQ29sdW1uIHJlY29uc3RydWN0aW9uIG9ubHkgYXMgYSBsYXN0IHJlc29ydC4KICBpZighY2FuZGlkYXRlcy5sZW5ndGgpewogICAgZm9yKGNvbnN0IHNyYyBvZiBzdGF0ZS5wYWdlQ29sdW1uVGV4dCl7CiAgICAgIGlmKCFzcmMpIGNvbnRpbnVlOwogICAgICBjb25zdCB0YWlsPWV4dHJhY3RDbGFpbXNUYWlsKHNyYyk7CiAgICAgIGlmKHRhaWwpIGNhbmRpZGF0ZXMucHVzaCh7dGV4dDp0YWlsLHNjb3JlOmNsYWltQ2FuZGlkYXRlU2NvcmUodGFpbCktMjB9KTsKICAgIH0KICB9CgogIGNhbmRpZGF0ZXMuc29ydCgoYSxiKT0+Yi5zY29yZS1hLnNjb3JlKTsKICBjb25zdCBiZXN0PWNhbmRpZGF0ZXNbMF07CiAgcmV0dXJuIGJlc3QmJmJlc3Quc2NvcmU+PTQ1ID8gYmVzdC50ZXh0LnNsaWNlKDAsODAwMDApIDogIiI7Cn0KCmZ1bmN0aW9uIHBhcnNlQ2xhaW1zKHRleHQpewogIGxldCB0PXRydW5jYXRlQ2xhaW1BdEZpZ3VyZShyZXBhaXJDZXJ0YWluVm5PY3IodGV4dHx8IiIpKS5yZXBsYWNlKC9cci9nLCJcbiIpOwoKICAvLyBPQ1IgdGjGsOG7nW5nIGNobzogIjEgLiIsICIxKSIsICIxICkiLCBob+G6t2MgeHXhu5FuZyBkw7JuZyB0csaw4bubYyBz4buRLgogIHQ9dC5yZXBsYWNlKC8oPzpefFxuKVxzKihcZHsxLDJ9KVxzKltcLlwpXVxzKi9nLCJcbiQxLiAiKTsKCiAgbGV0IG1hdGNoZXM9Wy4uLnQubWF0Y2hBbGwoLyg/Ol58XG4pXHMqKFxkezEsMn0pXC5ccyooW1xzXFNdKj8pKD89KD86XG5ccypcZHsxLDJ9XC5ccyopfCQpL2cpXTsKICBsZXQgYXJyPW1hdGNoZXMKICAgIC5tYXAobT0+KHtpZDorbVsxXSx0ZXh0OmNsZWFuKG1bMl0pfSkpCiAgICAuZmlsdGVyKHg9PngudGV4dC5sZW5ndGg+MTUpOwoKICAvLyBGYWxsYmFjayBkw6BuaCBjaG8gT0NSIGzDoG0gbeG6pXQgZOG6pXUgIi4iIHNhdSBz4buRIGNsYWltLgogIGlmKCFhcnIubGVuZ3RoKXsKICAgIGNvbnN0IGY9Zm9sZFZOKHQpOwogICAgY29uc3QgZmlyc3Q9Zi5zZWFyY2goLyg/Ol58XG58XHMpMVxzKyhRVVkgVFJJTkh8UEhVT05HIFBIQVB8U0FOIFBIQU18VEhJRVQgQkl8SEUgVEhPTkd8Q0hFIFBIQU18QVxzfEFOXHN8VEhFXHMpLyk7CiAgICBpZihmaXJzdD49MCl7CiAgICAgIGNvbnN0IGJvZHk9Y2xlYW4odC5zbGljZShmaXJzdCkpOwogICAgICBhcnI9W3tpZDoxLHRleHQ6Ym9keS5yZXBsYWNlKC9eXHMqMVxzKi8sIiIpfV07CiAgICB9CiAgfQoKICBhcnI9YXJyCiAgICAuZmlsdGVyKCh4LGksYSk9PmEuZmluZEluZGV4KHk9PnkuaWQ9PT14LmlkKT09PWkpCiAgICAuc29ydCgoYSxiKT0+YS5pZC1iLmlkKQogICAgLnNsaWNlKDAsNjApOwoKICByZXR1cm4gYXJyLm1hcCgoYyxpKT0+KHsKICAgIC4uLmMsCiAgICB0eXBlOi9hY2NvcmRpbmcgdG8gY2xhaW1ccytcZCt8dGhlbyAoPzrEkWnhu4NtfHnDqnUgY+G6p3UgYuG6o28gaOG7mXxjbGFpbSlccypcZCsvaS50ZXN0KGMudGV4dCkKICAgICAgPyJQaOG7pSB0aHXhu5ljIgogICAgICA6KGk9PT0wPyLEkOG7mWMgbOG6rXAiOiJDaMawYSB4w6FjIMSR4buLbmgiKQogIH0pKTsKfQpmdW5jdGlvbiBndWVzc0p1cih0ZXh0LG5vKXsKIGlmKC9D4bukQyBT4bueIEjhu65VIFRSw40gVFXhu4Z8Q+G7mW5nIGjDsmEgeMOjIGjhu5lpIGNo4bunIG5naMSpYSBWaeG7h3QgTmFtL2kudGVzdCh0ZXh0KXx8L15bMTJdLVxkezUsfS8udGVzdChubykpcmV0dXJuIlZOIjsKIGlmKC9Vbml0ZWQgU3RhdGVzIFBhdGVudHxVXC5TXC4gUGF0ZW50L2kudGVzdCh0ZXh0KXx8L15VUy9pLnRlc3Qobm8pKXJldHVybiJVUyI7CiBpZigvXldPL2kudGVzdChubykpcmV0dXJuIldPL1BDVCI7aWYoL15FUC9pLnRlc3Qobm8pKXJldHVybiJFUCI7cmV0dXJuIktow6FjIjsKfQpmdW5jdGlvbiB0YWdnZWRGaWVsZCh0ZXh0LHRhZyxtYXhMZW49NTAwKXsKICBjb25zdCB0PXN0cmlwUGRmQXJ0aWZhY3RzKHRleHR8fCIiKTsKICBjb25zdCByZT1uZXcgUmVnRXhwKCJcXFxcKCIrdGFnKyJcXFxcKVxcXFxzKihbXFxcXHNcXFxcU117MSwiK21heExlbisifT8pKD89XFxcXChcXFxcZHsyfVxcXFwpfCQpIiwiaSIpOwogIGNvbnN0IG09dC5tYXRjaChyZSk7CiAgcmV0dXJuIG0/Y2xlYW5NZXRhVmFsdWUobVsxXSk6IiI7Cn0KCmZ1bmN0aW9uIGV4dHJhY3RNZXRhZGF0YSh0ZXh0KXsKICBjb25zdCB0PXN0cmlwUGRmQXJ0aWZhY3RzKHRleHR8fCIiKTsKICBjb25zdCBubz1maXJzdE1hdGNoKHQsWwogICAgL1woMTFcKVxzKihbMTJdLVxkezUsOH0pL2ksCiAgICAvXGIoWzEyXS1cZHs2LDh9KVxiL2ksCiAgICAvXGJQYXRlbnRccypOb1wuP1xzKjo/XHMqKFVTXHMqW1xkLF0rXHMqW0FCXVxkKVxiL2ksCiAgICAvXGIoVVNccz9cZHs3LDExfVxzP1tBQl1cZClcYi9pLAogICAgL1xiKFdPXHM/XGR7NH1cL1xkezUsN31ccz9bQS1aXVxkPylcYi9pCiAgXSkucmVwbGFjZSgvXHMrL2csIiAiKTsKCiAgbGV0IHRpdGxlPXRhZ2dlZEZpZWxkKHQsIjU0IiwzNTApIHx8IGZpcnN0TWF0Y2godCxbL1RpdGxlXHMqOj9ccyooW15cbl17NSwyNTB9KS9pXSk7CiAgdGl0bGU9c2FuaXRpemVQYXRlbnRUaXRsZSh0aXRsZSk7CgogIGxldCBmaWxpbmc9dGFnZ2VkRmllbGQodCwiMjIiLDgwKSB8fCBmaXJzdE1hdGNoKHQsWy9GaWxlZFxzKjo/XHMqKFtBLVphLXpdezMsOX1cLj9ccytcZHsxLDJ9LFxzK1xkezR9KS9pXSk7CiAgZmlsaW5nPW5vcm1EYXRlKGZpbGluZyk7CgogIGNvbnN0IGFwcGxpY2FudD1jbGVhbk1ldGFWYWx1ZSgKICAgIHRhZ2dlZEZpZWxkKHQsIjczIiw1MDApIHx8CiAgICB0YWdnZWRGaWVsZCh0LCI3MSIsNTAwKSB8fAogICAgZmlyc3RNYXRjaCh0LFsvQXNzaWduZWVccyo6P1xzKihbXlxuXXszLDI1MH0pL2ksL0FwcGxpY2FudFxzKjo/XHMqKFteXG5dezMsMjUwfSkvaV0pCiAgKTsKCiAgY29uc3QgcmVwPWNsZWFuTWV0YVZhbHVlKAogICAgdGFnZ2VkRmllbGQodCwiNzQiLDQwMCkgfHwKICAgIGZpcnN0TWF0Y2godCxbL1JlcHJlc2VudGF0aXZlXHMqOj9ccyooW15cbl17MywyNTB9KS9pXSkKICApOwoKICBjb25zdCBpcGM9Y2xlYW5NZXRhVmFsdWUoCiAgICB0YWdnZWRGaWVsZCh0LCI1MSIsMzUwKSB8fAogICAgZmlyc3RNYXRjaCh0LFsvSW50XC5ccypDbFwuP1xzKjo/XHMqKFteXG5dezUsMjIwfSkvaV0pCiAgKTsKCiAgbGV0IGFicz10YWdnZWRGaWVsZCh0LCI1NyIsMTgwMCkgfHwKICAgIGZpcnN0TWF0Y2godCxbL0FCU1RSQUNUXHMqKFtcc1xTXXs0MCwxNTAwfT8pKD89RklFTEQgT0Z8QkFDS0dST1VORHxDTEFJTVM/KS9pXSk7CiAgYWJzPWNsZWFuTWV0YVZhbHVlKGFicykuc2xpY2UoMCwxODAwKTsKCiAgcmV0dXJue25vLHRpdGxlLGZpbGluZyxhcHBsaWNhbnQscmVwLGlwYyxhYnMsanVyOmd1ZXNzSnVyKHQsbm8pfQp9CgpmdW5jdGlvbiBmaWxsTWV0YShtKXsKICQoInBhdGVudE5vIikudmFsdWU9bS5ubzskKCJ0aXRsZSIpLnZhbHVlPW0udGl0bGU7JCgiZmlsaW5nRGF0ZSIpLnZhbHVlPW0uZmlsaW5nOyQoImFwcGxpY2FudCIpLnZhbHVlPW0uYXBwbGljYW50OyQoInJlcHJlc2VudGF0aXZlIikudmFsdWU9bS5yZXA7JCgiaXBjIikudmFsdWU9bS5pcGM7JCgiYWJzdHJhY3QiKS52YWx1ZT1tLmFiczsKIFsuLi4kKCJqdXJpc2RpY3Rpb24iKS5vcHRpb25zXS5mb3JFYWNoKChvLGkpPT57aWYoby52YWx1ZT09PW0uanVyKSQoImp1cmlzZGljdGlvbiIpLnNlbGVjdGVkSW5kZXg9aX0pOwogY29uc3QgYmFzZT0obS5ub3x8IlBBVCIpLnJlcGxhY2UoL1xzL2csIiIpLnJlcGxhY2UoL1teQS1aYS16MC05LV0vZywiIik7JCgiY2FzZUlkIikudmFsdWU9KG0uanVyfHwiQ0FTRSIpKyItIitiYXNlOyQoImNhc2VCYWRnZSIpLnRleHRDb250ZW50PSQoImNhc2VJZCIpLnZhbHVlOwogc2V0RGV0ZWN0KCJkZXRNZXRhIiwhIShtLm5vfHxtLnRpdGxlKSxtLm5vfHxtLnRpdGxlPyLEkMOjIG5o4bqtbiBkaeG7h24iOiJD4bqnbiBraeG7g20gdHJhIik7CiBzZXREZXRlY3QoImRldEFic3RyYWN0IiwhIW0uYWJzLG0uYWJzPyLEkMOjIG5o4bqtbiBkaeG7h24iOiJDaMawYSB0w6xtIHRo4bqleSIpOwp9CmFzeW5jIGZ1bmN0aW9uIHByb2Nlc3NGaWxlKGZpbGUpewogIHN0YXRlLm9jclBhZ2VzPXt9OwogIHN0YXRlLmNsYWltcz1bXTsKICBzdGF0ZS5jbGFpbXNUZXh0PSIiOwogIHN0YXRlLmZlYXR1cmVzPVtdOwogIHN0YXRlLnNlYXJjaD1bXTsKICBzdGF0ZS5xdWVyaWVzPVtdOwogIHN0YXRlLnByaW9yPXt9OwogIHN0YXRlLm1hdHJpeD1bXTsKICAkKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPSIzJSI7CiAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9IsSQYW5nIG3hu58gUERGLi4uIjsKCiAgdHJ5ewogICAgYXdhaXQgcmVhZFBkZihmaWxlKTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLmVycm9yKGUpOwogICAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMTAwJSI7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD0iS2jDtG5nIHRo4buDIG3hu58gUERGOiAiKyhlJiZlLm1lc3NhZ2U/ZS5tZXNzYWdlOmUpOwogICAgYWxlcnQoIktow7RuZyB0aOG7gyBt4bufIGZpbGUgUERGIG7DoHkuIik7CiAgICByZXR1cm47CiAgfQoKICBjb25zdCBxPXRleHRRdWFsaXR5KCk7CiAgbGV0IGNvbWJpbmVkPW1lcmdlZFRleHQoKTsKICBzdGF0ZS5yYXdUZXh0PWNvbWJpbmVkOwoKICAvLyBNZXRhZGF0YSBjaOG7iSBs4bqleSB04burIHRyYW5nIMSR4bqndSDEkeG7gyB0csOhbmggZm9vdGVyL3BhZ2UgY291bnRlciBj4bunYSB0b8OgbiB0w6BpIGxp4buHdSBjaHVpIHbDoG8gdGl0bGUuCiAgbGV0IGZpcnN0PXN0YXRlLnBhZ2VUZXh0WzBdfHwiIjsKICBsZXQgZmlyc3RRdWFsaXR5PXN0YXRlLnBhZ2VRdWFsaXR5WzBdfHwwOwogIGxldCBtZXRhPXt9OwoKICBpZihmaXJzdFF1YWxpdHk+PTQ4KXsKICAgIHRyeXsKICAgICAgbWV0YT1leHRyYWN0TWV0YWRhdGEoZmlyc3QpOwogICAgICBmaWxsTWV0YShtZXRhKTsKICAgICAgc2V0RGV0ZWN0KCJkZXRPQ1IiLHRydWUsIktow7RuZyBj4bqnbiBPQ1IgwrcgdGV4dCBsYXllciB04buRdCIpOwogICAgfWNhdGNoKGUpe2NvbnNvbGUud2FybigiTWV0YWRhdGEgdGV4dC1sYXllciBlcnJvciIsZSl9CiAgfQoKICAvLyBO4bq/dSB0ZXh0IGxheWVyIHRyYW5nIMSR4bqndSBrw6ltIGhv4bq3YyBtZXRhZGF0YSBjw7JuIHRoaeG6v3UsIE9DUiDEkcO6bmcgdHJhbmcgxJHhuqd1LgogIGlmKGZpcnN0UXVhbGl0eTw0OCB8fCAhbWV0YS5ubyB8fCAhbWV0YS50aXRsZSl7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD0iVGV4dCBsYXllciBjw7MgZOG6pXUgaGnhu4d1IGzhu5dpIG3Doy9mb250IOKAlCDEkWFuZyBPQ1IgdHJhbmcgxJHhuqd1Li4uIjsKICAgIGNvbnN0IG9rTWV0YT1hd2FpdCBvY3JTZWxlY3RlZFBhZ2VzKFsxXSwiT0NSIG1ldGFkYXRhIik7CiAgICBpZihva01ldGEgJiYgc3RhdGUub2NyUGFnZXNbMV0pewogICAgICB0cnl7CiAgICAgICAgY29uc3Qgb2NyTWV0YT1leHRyYWN0TWV0YWRhdGEoc3RhdGUub2NyUGFnZXNbMV0pOwogICAgICAgIC8vIENo4buJIHRoYXkgYuG6sW5nIE9DUiBu4bq/dSBPQ1IgdMOsbSDEkcaw4bujYyB0csaw4budbmcgdOG7kXQgaMahbi4KICAgICAgICBtZXRhPXsKICAgICAgICAgIC4uLm1ldGEsCiAgICAgICAgICBubzpvY3JNZXRhLm5vfHxtZXRhLm5vfHwiIiwKICAgICAgICAgIHRpdGxlOm9jck1ldGEudGl0bGV8fG1ldGEudGl0bGV8fCIiLAogICAgICAgICAgZmlsaW5nOm9jck1ldGEuZmlsaW5nfHxtZXRhLmZpbGluZ3x8IiIsCiAgICAgICAgICBhcHBsaWNhbnQ6b2NyTWV0YS5hcHBsaWNhbnR8fG1ldGEuYXBwbGljYW50fHwiIiwKICAgICAgICAgIHJlcDpvY3JNZXRhLnJlcHx8bWV0YS5yZXB8fCIiLAogICAgICAgICAgaXBjOm9jck1ldGEuaXBjfHxtZXRhLmlwY3x8IiIsCiAgICAgICAgICBhYnM6b2NyTWV0YS5hYnN8fG1ldGEuYWJzfHwiIiwKICAgICAgICAgIGp1cjpvY3JNZXRhLmp1cnx8bWV0YS5qdXJ8fCJWTiIKICAgICAgICB9OwogICAgICAgIGZpbGxNZXRhKG1ldGEpOwogICAgICB9Y2F0Y2goZSl7Y29uc29sZS53YXJuKCJPQ1IgbWV0YWRhdGEgcGFyc2UgZXJyb3IiLGUpfQogICAgfQogIH0KCiAgLy8gQ2xhaW1zOiBkaXJlY3QgdGV4dCBsYXllciBmaXJzdCBpZiBjbGVhbi4KICBsZXQgY2xhaW1zPSIiOwogIHRyeXtjbGFpbXM9Y2FuZGlkYXRlQ2xhaW1zVGV4dCgpfWNhdGNoKGUpe2NvbnNvbGUud2FybihlKX0KCiAgaWYoY2xhaW1zICYmIGNsYWltQ2FuZGlkYXRlU2NvcmUoY2xhaW1zKT49NDUpewogICAgc3RhdGUuY2xhaW1zVGV4dD1zdHJpcFBkZkFydGlmYWN0cyhjbGFpbXMpOwogICAgJCgiY2xhaW1zUmF3IikudmFsdWU9c3RhdGUuY2xhaW1zVGV4dDsKICAgICQoImNsYWltc0NsZWFuIikudmFsdWU9Zm9ybWF0Q2xhaW1Gb3JEaXNwbGF5KHN0YXRlLmNsYWltc1RleHQpOwogICAgc3RhdGUuY2xhaW1zPXBhcnNlQ2xhaW1zKHN0YXRlLmNsYWltc1RleHQpOwogICAgc3RhdGUuc2VsZWN0ZWQ9MDsKICAgIHJlbmRlckNsYWltcygpOwogIH0KCiAgLy8gTuG6v3UgY2xhaW0gduG6q24ga2jDtG5nIMSR4bunIHRpbiBj4bqteSwgT0NSIGNo4buJIGPDoWMgdHJhbmcgY3Xhu5FpLgogIGlmKCFzdGF0ZS5jbGFpbXMubGVuZ3RoKXsKICAgIGF3YWl0IHNtYXJ0T2NyQ2xhaW1zKHRydWUpOwogIH0KCiAgc3RhdGUucmF3VGV4dD1tZXJnZWRUZXh0KCk7CiAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMTAwJSI7CgogIGlmKHN0YXRlLmNsYWltcy5sZW5ndGgpewogICAgc2V0RGV0ZWN0KCJkZXRDbGFpbXMiLHRydWUsYMSQw6MgdMOhY2ggJHtzdGF0ZS5jbGFpbXMubGVuZ3RofSBjbGFpbWApOwogICAgY29uc3QgbW9kZT1zdGF0ZS5iYWRUZXh0UGFnZXMubGVuZ3RoCiAgICAgID9gQ8OzICR7c3RhdGUuYmFkVGV4dFBhZ2VzLmxlbmd0aH0gdHJhbmcgdGV4dCBsYXllciBrw6ltOyDEkcOjIHThu7EgZMO5bmcgT0NSIGtoaSBj4bqnbi5gCiAgICAgIDoixJDhu41jIHRy4buxYyB0aeG6v3AgdGV4dCBsYXllciwgZ2nhu68gbmd1ecOqbiBVbmljb2RlIHRp4bq/bmcgVmnhu4d0LiI7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1gSG/DoG4gdOG6pXQuICR7bW9kZX1gOwogIH1lbHNlewogICAgc2V0RGV0ZWN0KCJkZXRDbGFpbXMiLGZhbHNlLCJDaMawYSB04buxIHTDoWNoIMSRxrDhu6NjIGNsYWltIik7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD0ixJDDoyB44butIGzDvSBQREYgbmjGsG5nIGNoxrBhIHTDoWNoIMSRxrDhu6NjIGNsYWltLiBLaeG7g20gdHJhIGLGsOG7m2MgMi4iOwogIH0KfQokKCJwZGZJbnB1dCIpLm9uY2hhbmdlPWU9PntpZihlLnRhcmdldC5maWxlc1swXSlwcm9jZXNzRmlsZShlLnRhcmdldC5maWxlc1swXSl9Owpjb25zdCBkej0kKCJkcm9wWm9uZSIpO1siZHJhZ2VudGVyIiwiZHJhZ292ZXIiXS5mb3JFYWNoKGV2PT5kei5hZGRFdmVudExpc3RlbmVyKGV2LGU9PntlLnByZXZlbnREZWZhdWx0KCk7ZHouY2xhc3NMaXN0LmFkZCgiZHJhZyIpfSkpO1siZHJhZ2xlYXZlIiwiZHJvcCJdLmZvckVhY2goZXY9PmR6LmFkZEV2ZW50TGlzdGVuZXIoZXYsZT0+e2UucHJldmVudERlZmF1bHQoKTtkei5jbGFzc0xpc3QucmVtb3ZlKCJkcmFnIil9KSk7ZHouYWRkRXZlbnRMaXN0ZW5lcigiZHJvcCIsZT0+e2xldCBmPWUuZGF0YVRyYW5zZmVyLmZpbGVzWzBdO2lmKGYpcHJvY2Vzc0ZpbGUoZil9KTsKJCgicmV0cnlPQ1IiKS5vbmNsaWNrPWFzeW5jKCk9PntpZighc3RhdGUucGRmKXJldHVybiBhbGVydCgiQ2jGsGEgY8OzIFBERi4iKTtzdGF0ZS5vY3JQYWdlcz17fTtzdGF0ZS5jbGFpbVNvdXJjZUJ5UGFnZT17fTtvY3JXb3JrZXJQcm9taXNlPW51bGw7YXdhaXQgc21hcnRPY3JDbGFpbXMoZmFsc2UpfTsKJCgib2NyQ2xhaW1zQWdhaW4iKS5vbmNsaWNrPWFzeW5jKCk9PntpZighc3RhdGUucGRmKXJldHVybiBhbGVydCgiQ2jGsGEgY8OzIFBERi4iKTtzdGF0ZS5vY3JQYWdlcz17fTtzdGF0ZS5jbGFpbVNvdXJjZUJ5UGFnZT17fTtvY3JXb3JrZXJQcm9taXNlPW51bGw7YXdhaXQgc21hcnRPY3JDbGFpbXMoZmFsc2UpfTsKCmZ1bmN0aW9uIHJlbmRlckNsYWltcygpewogJCgiY2xhaW1TZWxlY3QiKS5pbm5lckhUTUw9c3RhdGUuY2xhaW1zLm1hcCgoYyxpKT0+YDxvcHRpb24gdmFsdWU9IiR7aX0iPkNsYWltICR7Yy5pZH0gwrcgJHtjLnR5cGV9PC9vcHRpb24+YCkuam9pbigiIik7CiBpZighc3RhdGUuY2xhaW1zLmxlbmd0aCl7CiAgICQoImNsYWltTGlzdCIpLmNsYXNzTmFtZT0iZW1wdHkiOwogICAkKCJjbGFpbUxpc3QiKS5pbm5lckhUTUw9IkNoxrBhIGPDsyBjbGFpbS4iOwogICByZXR1cm47CiB9CiAkKCJjbGFpbUxpc3QiKS5jbGFzc05hbWU9IiI7CiAkKCJjbGFpbUxpc3QiKS5pbm5lckhUTUw9c3RhdGUuY2xhaW1zLm1hcCgoYyxpKT0+ewogICBjb25zdCBwcmV0dHk9ZXNjKGZvcm1hdENsYWltRm9yRGlzcGxheShjLnRleHQpKS5yZXBsYWNlKC9cbi9nLCI8YnI+Iik7CiAgIHJldHVybiBgPGRpdiBjbGFzcz0iY2xhaW0iPgogICAgICA8aDQ+Q2xhaW0gJHtjLmlkfSA8c3BhbiBjbGFzcz0icGlsbCAke2MudHlwZT09PSLEkOG7mWMgbOG6rXAiPyJibHVlIjoiIn0iPiR7Yy50eXBlfTwvc3Bhbj48L2g0PgogICAgICA8ZGl2IGNsYXNzPSJjbGFpbS1jbGVhbiI+JHtwcmV0dHl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biAke2k9PT1zdGF0ZS5zZWxlY3RlZD8ic3VjY2VzcyI6IiJ9IiBkYXRhLWNsYWltPSIke2l9Ij4ke2k9PT1zdGF0ZS5zZWxlY3RlZD8ixJBhbmcgY2jhu41uIjoiQ2jhu41uIGNsYWltIG7DoHkifTwvYnV0dG9uPjwvZGl2PgogICA8L2Rpdj5gOwogfSkuam9pbigiIik7CiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1jbGFpbV0iKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+ewogICBzdGF0ZS5zZWxlY3RlZD0rYi5kYXRhc2V0LmNsYWltOwogICAkKCJjbGFpbVNlbGVjdCIpLnZhbHVlPXN0YXRlLnNlbGVjdGVkOwogICByZW5kZXJDbGFpbXMoKTsKIH0pOwp9CiQoInBhcnNlQ2xhaW1zIikub25jbGljaz0oKT0+ewogICAgICBjb25zdCBzb3VyY2U9JCgiY2xhaW1zQ2xlYW4iKS52YWx1ZXx8JCgiY2xhaW1zUmF3IikudmFsdWU7CiAgICAgIHN0YXRlLmNsYWltc1RleHQ9bm9ybWFsaXplT2NyVGV4dChzb3VyY2UpOwogICAgICAkKCJjbGFpbXNDbGVhbiIpLnZhbHVlPWZvcm1hdENsYWltRm9yRGlzcGxheShzdGF0ZS5jbGFpbXNUZXh0KTsKICAgICAgJCgiY2xhaW1zUmF3IikudmFsdWU9c3RhdGUuY2xhaW1zVGV4dDsKICAgICAgc3RhdGUuY2xhaW1zPXBhcnNlQ2xhaW1zKHN0YXRlLmNsYWltc1RleHQpOwogICAgICBzdGF0ZS5zZWxlY3RlZD0wOwogICAgICByZW5kZXJDbGFpbXMoKTsKICAgICAgc2V0RGV0ZWN0KCJkZXRDbGFpbXMiLHN0YXRlLmNsYWltcy5sZW5ndGg+MCxzdGF0ZS5jbGFpbXMubGVuZ3RoP2DEkMOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW1gOiJDaMawYSB0w6xtIHRo4bqleSBjbGFpbSIpOwogICAgfTsKCmZ1bmN0aW9uIGZlYXR1cmVTcGxpdCh0ZXh0KXsKICBsZXQgdD1ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKQogICAgLnJlcGxhY2UoL15ccyooPzphfGFufHRoZSk/XHMqKD86cXV5IHRyw6xuaHxwaMawxqFuZyBwaMOhcHxtZXRob2R8cHJvY2Vzc3xjb21wb3NpdGlvbnxkZXZpY2V8c3lzdGVtKVteOl17MCwyMjB9KD86YmFvIGfhu5NtfGNvbXByaXNpbmd8Y29tcHJpc2VzKVxzKjo/XHMqL2ksIiIpOwoKICBjb25zdCBjb25uZWN0b3JzPS9cYig/OnNhdSDEkcOzfHRp4bq/cCB0aGVvfGvhur8gdGnhur9wfHRyb25nIMSRw7N8xJHhu5NuZyB0aOG7nWl8dGjhu7FjIGhp4buHbnzEkcaw4bujYyB0aOG7sWMgaGnhu4dufHdoZXJlaW58dGhlbnxzdWJzZXF1ZW50bHkpXGIvaWc7CiAgbGV0IHNlZz1bXTsKICBjb25zdCByb21hbj1bLi4udC5tYXRjaEFsbCgvXCgoaXsxLDN9fGl2fHZ8dml7MCwzfXxpeHx4fHhpezAsM318eGl2fHh2fHh2aXswLDN9KVwpXHMqL2lnKV07CgogIGlmKHJvbWFuLmxlbmd0aD49Mil7CiAgICBmb3IobGV0IGk9MDtpPHJvbWFuLmxlbmd0aDtpKyspewogICAgICBjb25zdCBhPXJvbWFuW2ldLmluZGV4K3JvbWFuW2ldWzBdLmxlbmd0aDsKICAgICAgY29uc3QgYj1pKzE8cm9tYW4ubGVuZ3RoP3JvbWFuW2krMV0uaW5kZXg6dC5sZW5ndGg7CiAgICAgIGNvbnN0IHM9Y2xlYW4odC5zbGljZShhLGIpKS5yZXBsYWNlKC9bOyxdKyQvLCIiKTsKICAgICAgaWYocy5sZW5ndGg+MTgpIHNlZy5wdXNoKHMpOwogICAgfQogIH1lbHNlewogICAgc2VnPXQKICAgICAgLnJlcGxhY2UoY29ubmVjdG9ycywiOyAiKQogICAgICAuc3BsaXQoLztccyt8XG4oPz1ccyooPzpcZCtbXC5cKV18XC18XOKAoikpLykKICAgICAgLm1hcChjbGVhbikKICAgICAgLmZpbHRlcih4PT54Lmxlbmd0aD4xOCk7CiAgfQoKICAvLyBH4buZcCBjw6FjIG3huqNuaCBxdcOhIG5n4bqvbiDEkeG7gyB0csOhbmggZmVhdHVyZSBraeG7g3UgIjUzLDIlIHRpbmgiLgogIGNvbnN0IG1lcmdlZD1bXTsKICBmb3IoY29uc3QgcyBvZiBzZWcpewogICAgaWYobWVyZ2VkLmxlbmd0aCAmJiAocy5zcGxpdCgvXHMrLykubGVuZ3RoPDQgfHwgcy5sZW5ndGg8MjgpKXsKICAgICAgbWVyZ2VkW21lcmdlZC5sZW5ndGgtMV0rPSI7ICIrczsKICAgIH1lbHNlIG1lcmdlZC5wdXNoKHMpOwogIH0KCiAgcmV0dXJuIG1lcmdlZC5zbGljZSgwLDMwKS5tYXAoKHgsaSk9PnsKICAgIGNvbnN0IGY9Zm9sZFZOKHgpOwogICAgbGV0IHR5cGU9IlF1eSB0csOsbmgiOwogICAgaWYoL1xiKEVOWllNRXxCT1R8VEhBTkggUEhBTnxUWSBMRXxOR1VZRU4gTElFVXxFWFRSQUNUfE9JTHxDT01QT1NJVElPTnxBQ0lEfFBPTFlNRVJ8SE9QIENIQVQpXGIvLnRlc3QoZikpIHR5cGU9IlRow6BuaCBwaOG6p24vTmd1ecOqbiBsaeG7h3UiOwogICAgZWxzZSBpZigvXGIoS0lFTSBUUkF8WEFDIERJTkh8RE8gTFVPTkd8Q0hFQ0t8REVURVJNSU58TUVBU1VSRXxQSHxETyBBTXxOSElFVCBETylcYi8udGVzdChmKSkgdHlwZT0iS2nhu4NtIHNvw6F0IjsKICAgIGVsc2UgaWYoL1xiKENIQU1CRVJ8UFVNUHxUVUJFfEFQUEFSQVRVU3xERVZJQ0V8U1lTVEVNfFRISUVUIEJJfEJPIFBIQU58Q0FVIFRSVUMpXGIvLnRlc3QoZikpIHR5cGU9IlRoaeG6v3QgYuG7iy9D4bqldSB0csO6YyI7CiAgICBjb25zdCB3b3Jkcz14LnNwbGl0KC9ccysvKS5sZW5ndGg7CiAgICBjb25zdCBjb25mPXdvcmRzPj03JiZ3b3Jkczw9NDA/IkNhbyI6d29yZHM+PTQ/IlRydW5nIGLDrG5oIjoiVGjhuqVwIjsKICAgIHJldHVybiB7aWQ6YEYke1N0cmluZyhpKzEpLnBhZFN0YXJ0KDIsIjAiKX1gLHRleHQ6eCx0eXBlLGNvbmZ9OwogIH0pOwp9Cgpjb25zdCBTRUFSQ0hfU1RPUD1uZXcgU2V0KFsKICAidmEiLCJob2FjIiwiY3VhIiwiY2hvIiwidm9pIiwidHJvbmciLCJuZ29haSIsInRyZW4iLCJkdW9pIiwidHUiLCJkZW4iLCJ0YWkiLCJ0aGVvIiwic2F1IiwidHJ1b2MiLCJkbyIsIm5heSIsIm1vdCIsImNhYyIsIm5odW5nIiwKICAiZHVvYyIsInRodWMiLCJoaWVuIiwidGFvIiwiaG9uIiwiaG9wIiwiZHVuZyIsImRpY2giLCJwaG9pIiwidHJvbiIsInRodSIsInR1Iiwib24iLCJkaW5oIiwiZG9uZyIsInRob2kiLCJ0aWVwIiwiYmFvIiwiZ29tIiwiYnVvYyIsCiAgInF1eSIsInRyaW5oIiwicGh1b25nIiwicGhhcCIsInNhbiIsInBoYW0iLCJoZSIsInRob25nIiwidGhpZXQiLCJiaSIsIm5oYXQiLCJiYW5nIiwiY2FjaCIsInN1IiwiZHVuZyIsIm5oYW0iLCJkZSIsImtoaSIsIm5ldSIsImNvIiwKICAidGhlIiwibGEiLCJsYW0iLCJwaGFuIiwidmFvIiwicmEiLCJnaXVhIiwibW90IiwiaGFpIiwiYmEiLCJib24iLCJuYW0iLCJzYXUiLCJiYXkiLCJ0YW0iLCJjaGluIiwidHVvbmciLCJ1bmciLCJsYW4iLCJxdWEiLCJkb2kiLCJ2b2kiLAogICJ0aGUiLCJhbmQiLCJvciIsIndpdGgiLCJmcm9tIiwid2hlcmVpbiIsIm1ldGhvZCIsInByb2Nlc3MiLCJjb21wcmlzaW5nIiwiY29tcHJpc2VzIiwiaW5jbHVkaW5nIiwic3RlcCIsInN0ZXBzIiwidXNpbmciLCJ1c2VkIiwidXNlIiwKICAiZmlyc3QiLCJzZWNvbmQiLCJ0aGlyZCIsInRoZW4iLCJ0aGVyZW9mIiwidGhlcmVpbiIsInRoZXJlYnkiLCJzdWNoIiwidGhhdCIsIndoaWNoIiwiaW50byIsIm9udG8iCl0pOwoKZnVuY3Rpb24gZmVhdHVyZUNvcmVUZXJtcyh0ZXh0KXsKICBjb25zdCBvcmlnaW5hbD1ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKTsKICBjb25zdCB0b2tlbnM9Wy4uLm9yaWdpbmFsLm1hdGNoQWxsKC9bXHB7TH1ccHtOfVwtXC9cLl0rL2d1KV0ubWFwKG09Pm1bMF0pOwogIGNvbnN0IG91dD1bXTsKICBmb3IoY29uc3QgdG9rIG9mIHRva2Vucyl7CiAgICBjb25zdCBmPWZvbGRWTih0b2spLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW15hLXowLTlcLVwvXC5dL2csIiIpOwogICAgaWYoIWYgfHwgU0VBUkNIX1NUT1AuaGFzKGYpIHx8IGYubGVuZ3RoPDQpIGNvbnRpbnVlOwogICAgaWYoL15cZCsoPzpbXC4sXVxkKyk/JT8kLy50ZXN0KGYpKSBjb250aW51ZTsKICAgIGlmKCFvdXQuc29tZSh4PT5mb2xkVk4oeCkudG9Mb3dlckNhc2UoKT09PWYpKSBvdXQucHVzaCh0b2spOwogIH0KICByZXR1cm4gb3V0LnNsaWNlKDAsOCk7Cn0KCmZ1bmN0aW9uIG1lYW5pbmdmdWxUb2tlbnModGV4dCl7CiAgcmV0dXJuIFsuLi5ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKS5tYXRjaEFsbCgvW1xwe0x9XHB7Tn1cLVwvXC5dKy9ndSldCiAgICAubWFwKG09Pm1bMF0pCiAgICAuZmlsdGVyKHRvaz0+ewogICAgICBjb25zdCBmPWZvbGRWTih0b2spLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW15hLXowLTlcLVwvXC5dL2csIiIpOwogICAgICByZXR1cm4gZi5sZW5ndGg+PTQgJiYgIVNFQVJDSF9TVE9QLmhhcyhmKSAmJiAhL15cZCsoPzpbXC4sXVxkKyk/JT8kLy50ZXN0KGYpOwogICAgfSk7Cn0KCmZ1bmN0aW9uIHRpdGxlVGVjaG5pY2FsUGhyYXNlKCl7CiAgbGV0IHJhdz1zYW5pdGl6ZVBhdGVudFRpdGxlKCQoInRpdGxlIikudmFsdWV8fCIiKTsKICBpZighcmF3KSByZXR1cm4gIiI7CgogIGxldCB0PW5vcm1hbGl6ZU9jclRleHQocmF3KQogICAgLnJlcGxhY2UoL14oPzpxdXkgdHLDrG5ofHBoxrDGoW5nIHBow6FwfGjhu4cgdGjhu5FuZ3x0aGnhur90IGLhu4t8c+G6o24gcGjhuqltfGNo4bq/IHBo4bqpbSlccysoPzpz4bqjbiB4deG6pXR8Y2jhur8gdOG6oW98xJFp4buBdSBjaOG6vyk/XHMqL2ksIiIpOwoKICAvLyBSZWplY3Qgc3RyaW5ncyBkb21pbmF0ZWQgYnkgcGFnZSBudW1iZXJzIC8gYXJ0aWZhY3RzLgogIGlmKCh0Lm1hdGNoKC9cZCtccypcL1xzKlxkKy9nKXx8W10pLmxlbmd0aD49MSkgcmV0dXJuICIiOwoKICBjb25zdCB0b2tzPW1lYW5pbmdmdWxUb2tlbnModCk7CiAgaWYodG9rcy5sZW5ndGg+PTIpIHJldHVybiB0b2tzLnNsaWNlKDAsNykuam9pbigiICIpOwogIHJldHVybiAiIjsKfQoKZnVuY3Rpb24gdGVjaG5pY2FsUGhyYXNlc0Zyb21UZXh0KHRleHQpewogIGNvbnN0IHJhdz1ub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKTsKICBjb25zdCB0b2tzPW1lYW5pbmdmdWxUb2tlbnMocmF3KTsKICBjb25zdCBvdXQ9W107CgogIC8vIFByZWZlciBwaHJhc2VzIGV4cGxpY2l0bHkgcHJlc2VudCBpbiB0aGUgdGVjaG5pY2FsIGRpY3Rpb25hcnkuCiAgZm9yKGNvbnN0IFtrXSBvZiBPYmplY3QuZW50cmllcyhkaWN0KSl7CiAgICBpZihmb2xkVk4ocmF3KS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGZvbGRWTihrKS50b0xvd2VyQ2FzZSgpKSAmJiBrLnNwbGl0KC9ccysvKS5sZW5ndGg+PTIpewogICAgICBvdXQucHVzaChrKTsKICAgIH0KICB9CgogIC8vIEJ1aWxkIGNvbXBhY3QgMuKAkzMgd29yZCBwaHJhc2VzIGluc3RlYWQgb2YgaXNvbGF0ZWQgT0NSIHdvcmRzLgogIGZvcihsZXQgbj0zO24+PTI7bi0tKXsKICAgIGZvcihsZXQgaT0wO2krbjw9dG9rcy5sZW5ndGg7aSsrKXsKICAgICAgY29uc3QgcGhyYXNlPXRva3Muc2xpY2UoaSxpK24pLmpvaW4oIiAiKTsKICAgICAgY29uc3QgZj1mb2xkVk4ocGhyYXNlKS50b0xvd2VyQ2FzZSgpOwogICAgICBpZighb3V0LnNvbWUoeD0+Zm9sZFZOKHgpLnRvTG93ZXJDYXNlKCk9PT1mKSkgb3V0LnB1c2gocGhyYXNlKTsKICAgICAgaWYob3V0Lmxlbmd0aD49OCkgYnJlYWs7CiAgICB9CiAgICBpZihvdXQubGVuZ3RoPj04KSBicmVhazsKICB9CiAgcmV0dXJuIG91dC5zbGljZSgwLDgpOwp9CgpmdW5jdGlvbiBxdWVyeVF1YWxpdHkocSl7CiAgY29uc3Qgd29yZHM9bWVhbmluZ2Z1bFRva2VucyhTdHJpbmcocSkucmVwbGFjZSgvXGJBTkRcYnxcYk9SXGIvZ2ksIiAiKSk7CiAgY29uc3QgdW5pcT1bLi4ubmV3IFNldCh3b3Jkcy5tYXAoeD0+Zm9sZFZOKHgpLnRvTG93ZXJDYXNlKCkpKV07CiAgcmV0dXJuIHsKICAgIG9rOiB1bmlxLmxlbmd0aD49MiwKICAgIHRlcm1zOiB1bmlxLAogICAgc2NvcmU6IE1hdGgubWluKDEwMCx1bmlxLmxlbmd0aCoyMikKICB9Owp9CgoKZnVuY3Rpb24gYnVpbGRQcm9TZWFyY2hSb3dzKCl7CiAgcmV0dXJuIHN0YXRlLmZlYXR1cmVzLm1hcChmPT57CiAgICBjb25zdCBwaHJhc2VzPXRlY2huaWNhbFBocmFzZXNGcm9tVGV4dChmLnRleHQpOwogICAgY29uc3QgdGVybXM9ZmVhdHVyZUNvcmVUZXJtcyhmLnRleHQpOwogICAgY29uc3QgZm91bmQ9W107CiAgICBmb3IoY29uc3QgW2ssdl0gb2YgT2JqZWN0LmVudHJpZXMoZGljdCkpewogICAgICBpZihmb2xkVk4oZi50ZXh0KS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGZvbGRWTihrKS50b0xvd2VyQ2FzZSgpKSkgZm91bmQucHVzaChrLC4uLnYpOwogICAgfQogICAgY29uc3QgYWxsPVsuLi5waHJhc2VzLC4uLmZvdW5kLC4uLnRlcm1zXS5maWx0ZXIoKHgsaSxhKT0+eCYmYS5maW5kSW5kZXgoeT0+Zm9sZFZOKHkpPT09Zm9sZFZOKHgpKT09PWkpOwogICAgY29uc3QgcHJpbWFyeT1hbGxbMF18fCIiOwogICAgY29uc3Qgc3lub255bXM9YWxsLnNsaWNlKDEsNSk7CiAgICByZXR1cm4gW2YuaWQscHJpbWFyeSxzeW5vbnltcy5qb2luKCI7ICIpfHwi4oCUIiwkKCJpcGMiKS52YWx1ZXx8IkPhuqduIGNodXnDqm4gZ2lhIHjDoWMgxJHhu4tuaCJdOwogIH0pLmZpbHRlcihyPT5yWzFdKTsKfQoKZnVuY3Rpb24gYnVpbGRQcm9RdWVyaWVzKHJvd3MpewogIGNvbnN0IHBocmFzZXM9W107CiAgY29uc3QgdGl0bGVQaHJhc2U9dGl0bGVUZWNobmljYWxQaHJhc2UoKTsKICBpZih0aXRsZVBocmFzZSkgcGhyYXNlcy5wdXNoKHRpdGxlUGhyYXNlKTsKCiAgZm9yKGNvbnN0IHIgb2Ygcm93cyl7CiAgICBjb25zdCB2YWxzPVtyWzFdLC4uLihyWzJdPT09IuKAlCI/W106clsyXS5zcGxpdCgiOyIpLm1hcCh4PT54LnRyaW0oKSkpXTsKICAgIGZvcihjb25zdCB2IG9mIHZhbHMpewogICAgICBpZighdikgY29udGludWU7CiAgICAgIGNvbnN0IHE9cXVlcnlRdWFsaXR5KHYpOwogICAgICBpZihxLm9rICYmICFwaHJhc2VzLnNvbWUoeD0+Zm9sZFZOKHgpPT09Zm9sZFZOKHYpKSkgcGhyYXNlcy5wdXNoKHYpOwogICAgfQogIH0KCiAgY29uc3QgcXVlcmllcz1bXTsKICBjb25zdCBhZGQ9cT0+ewogICAgcT0ocXx8IiIpLnRyaW0oKTsKICAgIGlmKCFxIHx8ICFxdWVyeVF1YWxpdHkocSkub2spIHJldHVybjsKICAgIGlmKCFxdWVyaWVzLnNvbWUoeD0+Zm9sZFZOKHgpPT09Zm9sZFZOKHEpKSkgcXVlcmllcy5wdXNoKHEpOwogIH07CgogIC8vIEhpZ2hlc3QgcHJlY2lzaW9uOiB0aXRsZSBjb25jZXB0ICsgb25lIGZlYXR1cmUgY29uY2VwdC4KICBpZih0aXRsZVBocmFzZSAmJiBwaHJhc2VzWzFdKSBhZGQoYCIke3RpdGxlUGhyYXNlfSIgQU5EICIke3BocmFzZXNbMV19ImApOwogIGlmKHRpdGxlUGhyYXNlKSBhZGQoYCIke3RpdGxlUGhyYXNlfSJgKTsKCiAgLy8gQnJvYWRlciByZWNhbGwgcXVlcmllcy4KICBpZihwaHJhc2VzLmxlbmd0aD49MikgYWRkKHBocmFzZXMuc2xpY2UoMCwyKS5tYXAoeD0+YCIke3h9ImApLmpvaW4oIiBBTkQgIikpOwogIGlmKHBocmFzZXMubGVuZ3RoPj0zKSBhZGQocGhyYXNlcy5zbGljZSgxLDMpLm1hcCh4PT5gIiR7eH0iYCkuam9pbigiIEFORCAiKSk7CgogIC8vIExhc3QgZmFsbGJhY2s6IDMtNiBzaWduaWZpY2FudCB0ZWNobmljYWwgdG9rZW5zIGZyb20gdGl0bGUgKyBzZWxlY3RlZCBjbGFpbS4KICBjb25zdCBjPXN0YXRlLmNsYWltc1tzdGF0ZS5zZWxlY3RlZF18fHN0YXRlLmNsYWltc1swXTsKICBjb25zdCB0b2tlblBvb2w9Wy4uLm1lYW5pbmdmdWxUb2tlbnMoJCgidGl0bGUiKS52YWx1ZXx8IiIpLC4uLm1lYW5pbmdmdWxUb2tlbnMoYz9jLnRleHQ6IiIpXTsKICBjb25zdCB1bmlxPVtdOwogIGZvcihjb25zdCB4IG9mIHRva2VuUG9vbCl7CiAgICBjb25zdCBmPWZvbGRWTih4KS50b0xvd2VyQ2FzZSgpOwogICAgaWYoIXVuaXEuc29tZSh5PT5mb2xkVk4oeSkudG9Mb3dlckNhc2UoKT09PWYpKSB1bmlxLnB1c2goeCk7CiAgfQogIGlmKHVuaXEubGVuZ3RoPj0yKSBhZGQodW5pcS5zbGljZSgwLDYpLmpvaW4oIiAiKSk7CgogIHJldHVybiBxdWVyaWVzLnNsaWNlKDAsNik7Cn0KJCgiYXV0b0ZlYXR1cmVzIikub25jbGljaz0oKT0+e2xldCBjPXN0YXRlLmNsYWltc1srJCgiY2xhaW1TZWxlY3QiKS52YWx1ZXx8MF07aWYoIWMpcmV0dXJuIGFsZXJ0KCJDaMawYSBjw7MgY2xhaW0uIik7c3RhdGUuc2VsZWN0ZWQ9KyQoImNsYWltU2VsZWN0IikudmFsdWV8fDA7c3RhdGUuZmVhdHVyZXM9ZmVhdHVyZVNwbGl0KGMudGV4dCk7cmVuZGVyRmVhdHVyZXMoKTskKCJmZWF0dXJlU3RhdHVzIikudmFsdWU9IkLhuqNuIG5ow6FwIHThu7EgxJHhu5luZyI7c3RhdGUuY29uZmlybWVkPWZhbHNlO3VwZGF0ZUZlYXR1cmVSZXZpZXdVSSgpfTsKJCgiY29uZmlybUZlYXR1cmVzIikub25jbGljaz0oKT0+e2lmKCFzdGF0ZS5mZWF0dXJlcy5sZW5ndGgpcmV0dXJuIGFsZXJ0KCJDaMawYSBjw7MgZOG6pXUgaGnhu4d1LiIpO3N0YXRlLmNvbmZpcm1lZD10cnVlO3VwZGF0ZUZlYXR1cmVSZXZpZXdVSSgpO2FsZXJ0KCLEkMOjIHjDoWMgbmjhuq1uIGLhu5kgZOG6pXUgaGnhu4d1LiBC4bqhbiBjw7MgdGjhu4MgdGnhur9wIHThu6VjIHNhbmcgYsaw4bubYyB0cmEgY+G7qXUuIil9OwoKZnVuY3Rpb24gdXBkYXRlRmVhdHVyZVJldmlld1VJKCl7CiAgY29uc3Qgbj1zdGF0ZS5mZWF0dXJlcy5sZW5ndGg7CiAgY29uc3QgYmFyPSQoImZlYXR1cmVSZXZpZXdCYXIiKTsKICBjb25zdCBiYWRnZT0kKCJmZWF0dXJlU3RhdHVzQmFkZ2UiKTsKICBjb25zdCBsYWJlbD0kKCJmZWF0dXJlQ291bnRMYWJlbCIpOwogIGlmKCFiYXJ8fCFiYWRnZXx8IWxhYmVsKSByZXR1cm47CiAgbGFiZWwudGV4dENvbnRlbnQ9bj9gJHtufSBk4bqldSBoaeG7h3Uga+G7uSB0aHXhuq10YDoiQ2jGsGEgY8OzIGThuqV1IGhp4buHdSI7CiAgaWYoc3RhdGUuY29uZmlybWVkKXsKICAgIGJhci5jbGFzc0xpc3QuYWRkKCJmZWF0dXJlLWNvbmZpcm1lZCIpOwogICAgYmFkZ2UuY2xhc3NOYW1lPSJwaWxsIGdyZWVuIjsKICAgIGJhZGdlLnRleHRDb250ZW50PSLEkMOjIHjDoWMgbmjhuq1uIjsKICAgICQoImZlYXR1cmVTdGF0dXMiKS52YWx1ZT0ixJDDoyB4w6FjIG5o4bqtbiI7CiAgICAkKCJjb25maXJtRmVhdHVyZXMiKS50ZXh0Q29udGVudD0i4pyTIMSQw6MgeMOhYyBuaOG6rW4gYuG7mSBk4bqldSBoaeG7h3UiOwogIH1lbHNlewogICAgYmFyLmNsYXNzTGlzdC5yZW1vdmUoImZlYXR1cmUtY29uZmlybWVkIik7CiAgICBiYWRnZS5jbGFzc05hbWU9InBpbGwgeWVsbG93IjsKICAgIGJhZGdlLnRleHRDb250ZW50PSJDaMawYSB4w6FjIG5o4bqtbiI7CiAgICAkKCJmZWF0dXJlU3RhdHVzIikudmFsdWU9bj8iQuG6o24gbmjDoXAgdOG7sSDEkeG7mW5nIjoiQ2jGsGEgdOG6oW8iOwogICAgJCgiY29uZmlybUZlYXR1cmVzIikudGV4dENvbnRlbnQ9IuKckyBYw6FjIG5o4bqtbiBi4buZIGThuqV1IGhp4buHdSI7CiAgfQp9CmZ1bmN0aW9uIHJlbmRlckZlYXR1cmVzKCl7CiAkKCJmZWF0dXJlQm9keSIpLmlubmVySFRNTD1zdGF0ZS5mZWF0dXJlcy5tYXAoKGYsaSk9PmA8dHI+PHRkPjxzdHJvbmc+JHtmLmlkfTwvc3Ryb25nPjwvdGQ+PHRkPjx0ZXh0YXJlYSBkYXRhLWZ0PSIke2l9IiBzdHlsZT0ibWluLWhlaWdodDo3MnB4Ij4ke2VzYyhmLnRleHQpfTwvdGV4dGFyZWE+PC90ZD48dGQ+PHNlbGVjdCBkYXRhLXR5PSIke2l9Ij48b3B0aW9uICR7Zi50eXBlPT09IlF1eSB0csOsbmgiPyJzZWxlY3RlZCI6IiJ9PlF1eSB0csOsbmg8L29wdGlvbj48b3B0aW9uICR7Zi50eXBlPT09IlRow6BuaCBwaOG6p24vTmd1ecOqbiBsaeG7h3UiPyJzZWxlY3RlZCI6IiJ9PlRow6BuaCBwaOG6p24vTmd1ecOqbiBsaeG7h3U8L29wdGlvbj48b3B0aW9uICR7Zi50eXBlPT09Iktp4buDbSBzb8OhdCI/InNlbGVjdGVkIjoiIn0+S2nhu4NtIHNvw6F0PC9vcHRpb24+PG9wdGlvbiAke2YudHlwZT09PSJUaGnhur90IGLhu4svQ+G6pXUgdHLDumMiPyJzZWxlY3RlZCI6IiJ9PlRoaeG6v3QgYuG7iy9D4bqldSB0csO6Yzwvb3B0aW9uPjwvc2VsZWN0PjwvdGQ+PHRkPjxzcGFuIGNsYXNzPSJwaWxsIHllbGxvdyI+JHtmLmNvbmZ9PC9zcGFuPjwvdGQ+PHRkPjxidXR0b24gY2xhc3M9ImJ0biBkYW5nZXIiIGRhdGEtZGVsPSIke2l9Ij7DlzwvYnV0dG9uPjwvdGQ+PC90cj5gKS5qb2luKCIiKTsKIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWZ0XSIpLmZvckVhY2goeD0+eC5vbmNoYW5nZT0oKT0+c3RhdGUuZmVhdHVyZXNbK3guZGF0YXNldC5mdF0udGV4dD14LnZhbHVlKTtkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS10eV0iKS5mb3JFYWNoKHg9Pngub25jaGFuZ2U9KCk9PnN0YXRlLmZlYXR1cmVzWyt4LmRhdGFzZXQudHldLnR5cGU9eC52YWx1ZSk7ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtZGVsXSIpLmZvckVhY2goeD0+eC5vbmNsaWNrPSgpPT57c3RhdGUuZmVhdHVyZXMuc3BsaWNlKCt4LmRhdGFzZXQuZGVsLDEpO3N0YXRlLmNvbmZpcm1lZD1mYWxzZTtyZW5kZXJGZWF0dXJlcygpfSk7dXBkYXRlRmVhdHVyZVJldmlld1VJKCkKfQoKY29uc3QgZGljdD17ImjhuqF0IHRoYW5oIGxvbmciOlsiZHJhZ29uIGZydWl0IHNlZWQiLCJwaXRheWEgc2VlZCIsIkh5bG9jZXJldXMgc2VlZCJdLCJu4bqjeSBt4bqnbSI6WyJnZXJtaW5hdGlvbiIsImdlcm1pbmF0ZWQiLCJzcHJvdXRpbmciXSwiY2VsbHVsYXNlIjpbImNlbGx1bGFzZSIsImNlbGx1bGFzZSB0cmVhdG1lbnQiXSwicGVjdGluYXNlIjpbInBlY3RpbmFzZSIsInBlY3RpbmFzZSB0cmVhdG1lbnQiXSwic+G6pXkiOlsiZHJ5aW5nIiwiZGVoeWRyYXRpb24iXSwibmdoaeG7gW4iOlsiZ3JpbmRpbmciLCJtaWxsaW5nIl0sImLhu5l0IG5ow6B1IjpbIm5vbmkgcG93ZGVyIiwiTW9yaW5kYSBjaXRyaWZvbGlhIHBvd2RlciJdLCLEkeG7mSDhuqltIjpbIm1vaXN0dXJlIGNvbnRlbnQiLCJtb2lzdHVyZSBhZGp1c3RtZW50Il0sIsSRw7NuZyBnw7NpIjpbInBhY2thZ2luZyIsInBhY2tpbmciXSwiZnJlZXplIGRyeWluZyI6WyJseW9waGlsaXphdGlvbiIsImZyZWV6ZSBkcnllciJdLCJtb3NxdWl0byI6WyJtb3NxdWl0byByZXBlbGxlbnQiLCJpbnNlY3QgcmVwZWxsZW50Il0sImVzc2VudGlhbCBvaWwiOlsiZXh0cmFjdCIsImFyb21hdGljIG9pbCJdfTsKJCgiZ2VuU2VhcmNoIikub25jbGljaz0oKT0+ewogIHN0YXRlLnNlYXJjaD1idWlsZFByb1NlYXJjaFJvd3MoKTsKICBzdGF0ZS5xdWVyaWVzPWJ1aWxkUHJvUXVlcmllcyhzdGF0ZS5zZWFyY2gpOwogIHJlbmRlclNlYXJjaCgpOwp9OwpmdW5jdGlvbiByZW5kZXJTZWFyY2goKXskKCJzZWFyY2hCb2R5IikuaW5uZXJIVE1MPXN0YXRlLnNlYXJjaC5tYXAocj0+YDx0cj48dGQ+PHN0cm9uZz4ke3JbMF19PC9zdHJvbmc+PC90ZD48dGQ+JHtlc2MoclsxXSl9PC90ZD48dGQ+JHtlc2MoclsyXSl9PC90ZD48dGQ+JHtlc2MoclszXSl9PC90ZD48L3RyPmApLmpvaW4oIiIpOyQoInF1ZXJ5TGlzdCIpLmlubmVySFRNTD1zdGF0ZS5xdWVyaWVzLm1hcCgocSxpKT0+YDxkaXYgY2xhc3M9ImNhbGxvdXQiPjxzdHJvbmc+USR7aSsxfTwvc3Ryb25nPjxici8+PGNvZGU+JHtlc2MocSl9PC9jb2RlPjwvZGl2PmApLmpvaW4oIiIpfQoKCmZ1bmN0aW9uIGJhY2tlbmRCYXNlKCl7CiAgcmV0dXJuIGxvY2F0aW9uLm9yaWdpbjsKfQpmdW5jdGlvbiBzYXZlQmFja2VuZCgpewogIHN0YXRlLmJhY2tlbmRVcmw9bG9jYXRpb24ub3JpZ2luOwp9CmZ1bmN0aW9uIHVwZGF0ZU9mZmljaWFsU2VhcmNoTGlua3MocSl7CiAgY29uc3QgcXVlcnk9cXx8JCgibGl2ZVNlYXJjaFF1ZXJ5IikudmFsdWV8fHN0YXRlLnF1ZXJpZXNbMF18fCIiOwogICQoImdwTGluayIpLmhyZWY9Imh0dHBzOi8vcGF0ZW50cy5nb29nbGUuY29tLz9xPSIrZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KTsKICAkKCJ3aXBvTGluayIpLmhyZWY9Imh0dHBzOi8vcGF0ZW50c2NvcGUud2lwby5pbnQvc2VhcmNoL2VuL2FkdmFuY2VkU2VhcmNoLmpzZj9xdWVyeT0iK2VuY29kZVVSSUNvbXBvbmVudCgnRU5fQUxMVFhUOignK3F1ZXJ5KycpJyk7CiAgJCgiZXBvTGluayIpLmhyZWY9Imh0dHBzOi8vd29ybGR3aWRlLmVzcGFjZW5ldC5jb20vcGF0ZW50L3NlYXJjaD9xPSIrZW5jb2RlVVJJQ29tcG9uZW50KHF1ZXJ5KTsKfQpmdW5jdGlvbiB1c2VHZW5lcmF0ZWRRdWVyeSgpewogIGxldCBxPSIiOwogIGlmKHN0YXRlLnF1ZXJpZXMubGVuZ3RoKXsKICAgIHE9c3RhdGUucXVlcmllc1swXTsKICB9ZWxzZSBpZihzdGF0ZS5mZWF0dXJlcy5sZW5ndGgpewogICAgY29uc3Qgcm93cz1idWlsZFByb1NlYXJjaFJvd3MoKTsKICAgIGNvbnN0IHFzPWJ1aWxkUHJvUXVlcmllcyhyb3dzKTsKICAgIHE9cXNbMF18fCIiOwogIH1lbHNlewogICAgcT0kKCJ0aXRsZSIpLnZhbHVlfHwiIjsKICB9CiAgJCgibGl2ZVNlYXJjaFF1ZXJ5IikudmFsdWU9cTsKICB1cGRhdGVPZmZpY2lhbFNlYXJjaExpbmtzKHEpOwogIHJldHVybiBxOwp9CmZ1bmN0aW9uIGNsZWFuUGF0ZW50SHRtbChzKXsKICBjb25zdCBkPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoInRleHRhcmVhIik7CiAgZC5pbm5lckhUTUw9KHN8fCIiKS5yZXBsYWNlKC88W14+XSo+L2csIiAiKTsKICByZXR1cm4gZC52YWx1ZS5yZXBsYWNlKC9ccysvZywiICIpLnRyaW0oKTsKfQpmdW5jdGlvbiB0YXJnZXREYXRlT2JqKCl7CiAgY29uc3Qgdj0kKCJmaWxpbmdEYXRlIikudmFsdWU7CiAgcmV0dXJuIHY/bmV3IERhdGUodisiVDAwOjAwOjAwIik6bnVsbDsKfQpmdW5jdGlvbiBjYW5kaWRhdGVEYXRlU3RhdHVzKGMpewogIGNvbnN0IHRkPXRhcmdldERhdGVPYmooKTsKICBjb25zdCBkPWMucHVibGljYXRpb25fZGF0ZXx8Yy5wcmlvcml0eV9kYXRlfHxjLmZpbGluZ19kYXRlfHwiIjsKICBpZighdGR8fCFkKSByZXR1cm4ge2xhYmVsOiJD4bqnbiB4w6FjIG1pbmgiLGNsczoieWVsbG93IixlbGlnaWJsZTpudWxsfTsKICBjb25zdCBjZD1uZXcgRGF0ZShkKTsKICBpZihpc05hTihjZCkpIHJldHVybiB7bGFiZWw6IkPhuqduIHjDoWMgbWluaCIsY2xzOiJ5ZWxsb3ciLGVsaWdpYmxlOm51bGx9OwogIGNvbnN0IG9rPWNkPHRkOwogIHJldHVybiB7bGFiZWw6b2s/IlRyxrDhu5tjIG3hu5FjIHRhcmdldCI6IlNhdSBt4buRYyB0YXJnZXQiLGNsczpvaz8iZ3JlZW4iOiJyZWQiLGVsaWdpYmxlOm9rfTsKfQpmdW5jdGlvbiBmZWF0dXJlVGVybXMoKXsKICBjb25zdCBzdG9wPW5ldyBTZXQoWyJiYW8iLCJn4buTbSIsInRyb25nIiwiY+G7p2EiLCLEkcaw4bujYyIsInbDoCIsInRoZSIsIndpdGgiLCJmcm9tIiwid2hlcmVpbiIsIm1ldGhvZCIsInByb2Nlc3MiXSk7CiAgY29uc3QgdGVybXM9W107CiAgZm9yKGNvbnN0IGYgb2Ygc3RhdGUuZmVhdHVyZXMpewogICAgZm9yKGNvbnN0IHcgb2YgZm9sZFZOKGYudGV4dCkudG9Mb3dlckNhc2UoKS5zcGxpdCgvW15hLXowLTldKy8pKXsKICAgICAgaWYody5sZW5ndGg+PTQmJiFzdG9wLmhhcyh3KSkgdGVybXMucHVzaCh3KTsKICAgIH0KICB9CiAgcmV0dXJuIFsuLi5uZXcgU2V0KHRlcm1zKV0uc2xpY2UoMCw4MCk7Cn0KZnVuY3Rpb24gc2NvcmVDYW5kaWRhdGUoYyl7CiAgY29uc3QgYmxvYj1mb2xkVk4oW2MudGl0bGUsYy5zbmlwcGV0LGMuYXNzaWduZWVdLmZpbHRlcihCb29sZWFuKS5qb2luKCIgIikpLnRvTG93ZXJDYXNlKCk7CiAgY29uc3QgdGVybXM9ZmVhdHVyZVRlcm1zKCk7CiAgaWYoIXRlcm1zLmxlbmd0aCkgcmV0dXJuIDUwOwogIGxldCBoaXQ9MDsKICBmb3IoY29uc3QgdCBvZiB0ZXJtcykgaWYoYmxvYi5pbmNsdWRlcyh0KSkgaGl0Kys7CiAgbGV0IHNjb3JlPU1hdGgucm91bmQoKGhpdC9NYXRoLm1pbih0ZXJtcy5sZW5ndGgsMjApKSoxMDApOwogIGNvbnN0IGRzPWNhbmRpZGF0ZURhdGVTdGF0dXMoYyk7CiAgaWYoZHMuZWxpZ2libGU9PT1mYWxzZSkgc2NvcmU9TWF0aC5tYXgoMCxzY29yZS0zNSk7CiAgcmV0dXJuIE1hdGgubWluKDk5LHNjb3JlKTsKfQpmdW5jdGlvbiByZW5kZXJDYW5kaWRhdGVzKCl7CiAgaWYoIXN0YXRlLmNhbmRpZGF0ZXMubGVuZ3RoKXsKICAgICQoImNhbmRpZGF0ZUJvZHkiKS5pbm5lckhUTUw9Jzx0cj48dGQgY29sc3Bhbj0iNiIgc3R5bGU9ImNvbG9yOiM5OGEyYjM7dGV4dC1hbGlnbjpjZW50ZXIiPktow7RuZyBjw7Mga+G6v3QgcXXhuqMgxJHhu4MgaGnhu4NuIHRo4buLLjwvdGQ+PC90cj4nOwogICAgcmV0dXJuOwogIH0KICAkKCJjYW5kaWRhdGVCb2R5IikuaW5uZXJIVE1MPXN0YXRlLmNhbmRpZGF0ZXMubWFwKChjLGkpPT57CiAgICBjLnNjb3JlPXNjb3JlQ2FuZGlkYXRlKGMpOwogICAgY29uc3QgZHM9Y2FuZGlkYXRlRGF0ZVN0YXR1cyhjKTsKICAgIGNvbnN0IHNjb3JlQ2xzPWMuc2NvcmU+PTY1PyJoaWdoIjpjLnNjb3JlPj0zNT8ibWlkIjoibG93IjsKICAgIGNvbnN0IGRhdGU9Yy5wdWJsaWNhdGlvbl9kYXRlfHxjLnByaW9yaXR5X2RhdGV8fGMuZmlsaW5nX2RhdGV8fCLigJQiOwogICAgcmV0dXJuIGA8dHI+CiAgICAgIDx0ZD4ke2krMX08L3RkPgogICAgICA8dGQgc3R5bGU9Im1pbi13aWR0aDozMzBweCI+CiAgICAgICAgPGEgY2xhc3M9InNlYXJjaC1yZXN1bHQtdGl0bGUiIGhyZWY9IiR7ZXNjKGMudXJsKX0iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj4ke2VzYyhjLnB1YmxpY2F0aW9uX251bWJlcnx8IlBhdGVudCIpfSDCtyAke2VzYyhjLnRpdGxlfHwiS2jDtG5nIGPDsyB0acOqdSDEkeG7gSIpfTwvYT4KICAgICAgICA8ZGl2IGNsYXNzPSJzdGF0dXMiIHN0eWxlPSJtYXJnaW4tdG9wOjVweCI+JHtlc2MoYy5zbmlwcGV0fHwiIil9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ic291cmNlLXJvdyIgc3R5bGU9Im1hcmdpbi10b3A6N3B4Ij4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaHJlZj0iJHtlc2MoYy51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkdvb2dsZSBQYXRlbnRzIOKGlzwvYT4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaHJlZj0iaHR0cHM6Ly9wYXRlbnRzY29wZS53aXBvLmludC9zZWFyY2gvZW4vYWR2YW5jZWRTZWFyY2guanNmP3F1ZXJ5PSR7ZW5jb2RlVVJJQ29tcG9uZW50KCdBTExOVU06KCcrYy5wdWJsaWNhdGlvbl9udW1iZXIrJyknKX0iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj5XSVBPIOKGlzwvYT4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaHJlZj0iaHR0cHM6Ly93b3JsZHdpZGUuZXNwYWNlbmV0LmNvbS9wYXRlbnQvc2VhcmNoP3E9JHtlbmNvZGVVUklDb21wb25lbnQoJ3BuPScrYy5wdWJsaWNhdGlvbl9udW1iZXIpfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkVzcGFjZW5ldCDihpc8L2E+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvdGQ+CiAgICAgIDx0ZD4ke2VzYyhkYXRlKX08L3RkPgogICAgICA8dGQ+PHNwYW4gY2xhc3M9InNjb3JlICR7c2NvcmVDbHN9Ij4ke2Muc2NvcmV9JTwvc3Bhbj48L3RkPgogICAgICA8dGQ+PHNwYW4gY2xhc3M9InBpbGwgJHtkcy5jbHN9Ij4ke2RzLmxhYmVsfTwvc3Bhbj48L3RkPgogICAgICA8dGQ+PGRpdiBjbGFzcz0iY2FuZGlkYXRlLWFjdGlvbnMiPgogICAgICAgIDxidXR0b24gY2xhc3M9InNsb3RidG4iIGRhdGEtc2xvdD0iRDEiIGRhdGEtY2FuZGlkYXRlPSIke2l9Ij5EMTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9InNsb3RidG4iIGRhdGEtc2xvdD0iRDIiIGRhdGEtY2FuZGlkYXRlPSIke2l9Ij5EMjwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9InNsb3RidG4iIGRhdGEtc2xvdD0iRDMiIGRhdGEtY2FuZGlkYXRlPSIke2l9Ij5EMzwvYnV0dG9uPgogICAgICA8L2Rpdj48L3RkPgogICAgPC90cj5gOwogIH0pLmpvaW4oIiIpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWNhbmRpZGF0ZV0iKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+c2VsZWN0Q2FuZGlkYXRlVG9TbG90KCtiLmRhdGFzZXQuY2FuZGlkYXRlLGIuZGF0YXNldC5zbG90KSk7Cn0KYXN5bmMgZnVuY3Rpb24gc2VhcmNoUmVhbFBhdGVudHMoKXsKICBsZXQgcT0kKCJsaXZlU2VhcmNoUXVlcnkiKS52YWx1ZS50cmltKCl8fHVzZUdlbmVyYXRlZFF1ZXJ5KCk7CiAgaWYoIXF1ZXJ5UXVhbGl0eShxKS5vayl7CiAgICBjb25zdCByb3dzPWJ1aWxkUHJvU2VhcmNoUm93cygpOwogICAgY29uc3QgcXM9YnVpbGRQcm9RdWVyaWVzKHJvd3MpOwogICAgcT1xc1swXXx8dGl0bGVUZWNobmljYWxQaHJhc2UoKTsKICAgICQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlPXE7CiAgfQogIGlmKCFxdWVyeVF1YWxpdHkocSkub2spewogICAgJCgibGl2ZVNlYXJjaFN0YXRlIikuaW5uZXJIVE1MPSc8c3BhbiBjbGFzcz0iYmFja2VuZC1iYWQiPlRydXkgduG6pW4gaGnhu4duIHThuqFpIHF1w6EgY2h1bmcgaG/hurdjIGLhu4sgbOG7l2kgT0NSLjwvc3Bhbj4gSMOjeSBxdWF5IGzhuqFpIGtp4buDbSB0cmEgQ2xhaW0vROG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdCBob+G6t2Mgbmjhuq1wIMOtdCBuaOG6pXQgMiB0aHXhuq10IG5n4buvIGvhu7kgdGh14bqtdC4nOwogICAgcmV0dXJuOwogIH0KICB1cGRhdGVPZmZpY2lhbFNlYXJjaExpbmtzKHEpOwogIGlmKCFxKSByZXR1cm4gYWxlcnQoIkNoxrBhIGPDsyB0cnV5IHbhuqVuIHRyYSBj4bupdS4iKTsKICBjb25zdCBiYXNlPWJhY2tlbmRCYXNlKCk7CiAgc2F2ZUJhY2tlbmQoKTsKICAkKCJsaXZlU2VhcmNoU3RhdGUiKS50ZXh0Q29udGVudD0ixJBhbmcgdHJhIGPhu6l1IHBhdGVudCB0aOG6rXQgcXVhIGLhu5kgbcOheSB0w6xtIGtp4bq/bS4uLiI7CiAgJCgibGl2ZVNlYXJjaEJ0biIpLmRpc2FibGVkPXRydWU7CiAgdHJ5ewogICAgY29uc3QgdXJsPWJhc2UrIi9hcGkvc2VhcmNoP3E9IitlbmNvZGVVUklDb21wb25lbnQocSkrIiZ0aXRsZT0iK2VuY29kZVVSSUNvbXBvbmVudCgkKCJ0aXRsZSIpLnZhbHVlfHwiIikrIiZudW09MjAiOwogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCh1cmwpOwogICAgY29uc3QgZGF0YT1hd2FpdCByLmpzb24oKTsKICAgIGlmKCFyLm9rfHwhZGF0YS5vaykgdGhyb3cgbmV3IEVycm9yKGRhdGEuZXJyb3J8fCgiSFRUUCAiK3Iuc3RhdHVzKSk7CiAgICBpZihkYXRhLnF1ZXJ5X3VzZWQpeyQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlPWRhdGEucXVlcnlfdXNlZDt1cGRhdGVPZmZpY2lhbFNlYXJjaExpbmtzKGRhdGEucXVlcnlfdXNlZCl9CiAgICBzdGF0ZS5jYW5kaWRhdGVzPShkYXRhLnJlc3VsdHN8fFtdKS5tYXAoeD0+KHsuLi54LHNjb3JlOjB9KSk7CiAgICBzdGF0ZS5jYW5kaWRhdGVzLnNvcnQoKGEsYik9PnNjb3JlQ2FuZGlkYXRlKGIpLXNjb3JlQ2FuZGlkYXRlKGEpKTsKICAgIHJlbmRlckNhbmRpZGF0ZXMoKTsKICAgICQoImxpdmVTZWFyY2hTdGF0ZSIpLmlubmVySFRNTD1gxJDDoyBuaOG6rW4gPHN0cm9uZz4ke3N0YXRlLmNhbmRpZGF0ZXMubGVuZ3RofTwvc3Ryb25nPiBr4bq/dCBxdeG6oyB04burIDxzdHJvbmc+JHtlc2MoZGF0YS5wcm92aWRlcnx8ZGF0YS5zb3VyY2V8fCJuZ3Xhu5NuIHBhdGVudCIpfTwvc3Ryb25nPi4gVHJ1eSB24bqlbiB0aOG7sWMgZMO5bmc6IDxzdHJvbmc+JHtlc2MoZGF0YS5xdWVyeV91c2VkfHxxKX08L3N0cm9uZz4ke2RhdGEuYXR0ZW1wdF9jb3VudD9gIMK3IMSRw6MgdGjhu60gJHtkYXRhLmF0dGVtcHRfY291bnR9IG3hu6ljIHRydXkgduG6pW5gOiIifS5gOwogIH1jYXRjaChlKXsKICAgIGNvbnNvbGUuZXJyb3IoZSk7CiAgICBjb25zdCBtc2c9U3RyaW5nKGUubWVzc2FnZXx8ZSk7CiAgICBjb25zdCBoaW50PS81MDN8UkFURV9MSU1JVHxHT09HTEVfQkxPQ0tFRC9pLnRlc3QobXNnKQogICAgICA/ICI8YnI+PHN0cm9uZz5Hb29nbGUgUGF0ZW50cyDEkWFuZyBjaOG6t24gdHJ1eSB24bqlbiB04buxIMSR4buZbmcgdOG7qyBJUCBkYXRhY2VudGVyLjwvc3Ryb25nPiBI4buHIHRo4buRbmcgc+G6vSDGsHUgdGnDqm4gQnJvd3NlciBSdW4vU2VycEFwaSBu4bq/dSDEkcaw4bujYyBj4bqldSBow6xuaDsgR29vZ2xlIGRpcmVjdCBjaOG7iSBsw6AgZmFsbGJhY2s7IGPDoWMgbGluayBHb29nbGUvV0lQTy9FUE8gcGjDrWEgdHLDqm4gduG6q24gbMOgIG5ndeG7k24ga2nhu4NtIGNo4bupbmcuIgogICAgICA6ICIiOwogICAgJCgibGl2ZVNlYXJjaFN0YXRlIikuaW5uZXJIVE1MPWA8c3BhbiBjbGFzcz0iYmFja2VuZC1iYWQiPlRyYSBj4bupdSB04buxIMSR4buZbmcgY2jGsGEgdGjDoG5oIGPDtG5nOiAke2VzYyhtc2cpfTwvc3Bhbj4ke2hpbnR9PGJyPkLhuqFuIHbhuqtuIGPDsyB0aOG7gyBt4bufIHRy4buxYyB0aeG6v3AgY8OhYyBuZ3Xhu5NuIGNow61uaCB0aOG7qWMgcGjDrWEgdHLDqm4uYDsKICB9ZmluYWxseXsKICAgICQoImxpdmVTZWFyY2hCdG4iKS5kaXNhYmxlZD1mYWxzZTsKICB9Cn0KYXN5bmMgZnVuY3Rpb24gc2VsZWN0Q2FuZGlkYXRlVG9TbG90KGksc2xvdCl7CiAgY29uc3QgYz1zdGF0ZS5jYW5kaWRhdGVzW2ldOwogIGlmKCFjKSByZXR1cm47CiAgY29uc3Qgbj1zbG90LnNsaWNlKDEpOwogIGNvbnN0IGJhc2U9YmFja2VuZEJhc2UoKTsKICAkKGBkJHtufU5vYCkudmFsdWU9Yy5wdWJsaWNhdGlvbl9udW1iZXJ8fCIiOwogICQoYGQke259RGF0ZWApLnZhbHVlPShjLnB1YmxpY2F0aW9uX2RhdGV8fGMucHJpb3JpdHlfZGF0ZXx8Yy5maWxpbmdfZGF0ZXx8IiIpLnNsaWNlKDAsMTApOwogICQoYGQke259VXJsYCkudmFsdWU9Yy51cmx8fCIiOwogICQoYGQke259VGV4dGApLnZhbHVlPVtjLnRpdGxlLGMuc25pcHBldF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oIlxuXG4iKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIucHJpb3Itc2xvdCIpLmZvckVhY2goeD0+eC5jbGFzc0xpc3QucmVtb3ZlKCJzZWxlY3RlZCIpKTsKICAkKCJzbG90IitzbG90KS5jbGFzc0xpc3QuYWRkKCJzZWxlY3RlZCIpOwoKICBpZihiYXNlJiZjLnB1YmxpY2F0aW9uX251bWJlcil7CiAgICB0cnl7CiAgICAgICQoYGQke259VGV4dGApLnZhbHVlPSLEkGFuZyBs4bqleSBu4buZaSBkdW5nIHBhdGVudC4uLiI7CiAgICAgIGNvbnN0IHI9YXdhaXQgZmV0Y2goYmFzZSsiL2FwaS9kZXRhaWw/cHViPSIrZW5jb2RlVVJJQ29tcG9uZW50KGMucHVibGljYXRpb25fbnVtYmVyKSk7CiAgICAgIGNvbnN0IGQ9YXdhaXQgci5qc29uKCk7CiAgICAgIGlmKHIub2smJmQub2spewogICAgICAgIGNvbnN0IHBhcnRzPVtdOwogICAgICAgIGlmKGQudGl0bGUpIHBhcnRzLnB1c2goIlRJVExFXG4iK2QudGl0bGUpOwogICAgICAgIGlmKGQuYWJzdHJhY3QpIHBhcnRzLnB1c2goIkFCU1RSQUNUXG4iK2QuYWJzdHJhY3QpOwogICAgICAgIGlmKGQuY2xhaW1zKSBwYXJ0cy5wdXNoKCJDTEFJTVNcbiIrZC5jbGFpbXMuc2xpY2UoMCwxODAwMCkpOwogICAgICAgICQoYGQke259VGV4dGApLnZhbHVlPXBhcnRzLmpvaW4oIlxuXG4iKXx8W2MudGl0bGUsYy5zbmlwcGV0XS5qb2luKCJcblxuIik7CiAgICAgIH1lbHNlewogICAgICAgICQoYGQke259VGV4dGApLnZhbHVlPVtjLnRpdGxlLGMuc25pcHBldF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oIlxuXG4iKTsKICAgICAgfQogICAgfWNhdGNoKF9lKXsKICAgICAgJChgZCR7bn1UZXh0YCkudmFsdWU9W2MudGl0bGUsYy5zbmlwcGV0XS5maWx0ZXIoQm9vbGVhbikuam9pbigiXG5cbiIpOwogICAgfQogIH0KICByZWFkUHJpb3IoKTsKfQpmdW5jdGlvbiBhdXRvUGlja0QxMjMoKXsKICBpZighc3RhdGUuY2FuZGlkYXRlcy5sZW5ndGgpIHJldHVybiBhbGVydCgiQ2jGsGEgY8OzIGvhur90IHF14bqjIHRyYSBj4bupdS4iKTsKICBjb25zdCBzb3J0ZWQ9Wy4uLnN0YXRlLmNhbmRpZGF0ZXNdLnNvcnQoKGEsYik9PnsKICAgIGNvbnN0IGRhPWNhbmRpZGF0ZURhdGVTdGF0dXMoYSksZGI9Y2FuZGlkYXRlRGF0ZVN0YXR1cyhiKTsKICAgIGNvbnN0IHBhPWRhLmVsaWdpYmxlPT09ZmFsc2U/MTowLHBiPWRiLmVsaWdpYmxlPT09ZmFsc2U/MTowOwogICAgcmV0dXJuIHBhLXBiIHx8IHNjb3JlQ2FuZGlkYXRlKGIpLXNjb3JlQ2FuZGlkYXRlKGEpOwogIH0pOwogIGNvbnN0IHBpY2tlZD1zb3J0ZWQuc2xpY2UoMCwzKTsKICBwaWNrZWQuZm9yRWFjaCgoYyxpZHgpPT57CiAgICBjb25zdCBvcmlnaW5hbD1zdGF0ZS5jYW5kaWRhdGVzLmluZGV4T2YoYyk7CiAgICBzZWxlY3RDYW5kaWRhdGVUb1Nsb3Qob3JpZ2luYWwsIkQiKyhpZHgrMSkpOwogIH0pOwp9CiQoImxpdmVTZWFyY2hCdG4iKS5vbmNsaWNrPXNlYXJjaFJlYWxQYXRlbnRzOwokKCJ1c2VCZXN0UXVlcnkiKS5vbmNsaWNrPSgpPT57dXNlR2VuZXJhdGVkUXVlcnkoKTskKCJsaXZlU2VhcmNoU3RhdGUiKS50ZXh0Q29udGVudD0ixJDDoyBu4bqhcCB0cnV5IHbhuqVuIHThu6sgYsaw4bubYyBDaGnhur9uIGzGsOG7o2MgdHJhIGPhu6l1LiJ9OwokKCJhdXRvUGlja1ByaW9yIikub25jbGljaz1hdXRvUGlja0QxMjM7CiQoInRlc3RCYWNrZW5kIikub25jbGljaz1hc3luYygpPT57CiAgJCgiYmFja2VuZFN0YXR1cyIpLnRleHRDb250ZW50PSLEkGFuZyBraeG7g20gdHJhLi4uIjsKICB0cnl7CiAgICBjb25zdCByPWF3YWl0IGZldGNoKCIvYXBpL2hlYWx0aCIse2NhY2hlOiJuby1zdG9yZSJ9KTsKICAgIGNvbnN0IGQ9YXdhaXQgci5qc29uKCk7CiAgICBpZighci5va3x8IWQub2spIHRocm93IG5ldyBFcnJvcihkLmVycm9yfHwiS2jDtG5nIGvhur90IG7hu5FpIMSRxrDhu6NjIik7CiAgICBjb25zdCBwPWQucHJvdmlkZXJzfHx7fTsgY29uc3QgdmVyPWQudmVyc2lvbj9gIMK3IHYke2QudmVyc2lvbn1gOiIiOwogICAgc3RhdGUucHJvdmlkZXJzPXA7CiAgICBzdGF0ZS5jbG91ZE9jcj1wLmdvb2dsZV92aXNpb24/dHJ1ZTpudWxsOwogICAgY29uc3Qgc2VhcmNoT2s9cC5zZXJwYXBpfHxwLmJyb3dzZXJfcnVufHxwLmVwb19vcHM7CiAgICBjb25zdCBvY3JUZXh0PXAuZ29vZ2xlX3Zpc2lvbj8iIMK3IEdvb2dsZSBWaXNpb24gT0NSIHPhurVuIHPDoG5nIjoiIMK3IE9DUiBsb2NhbCBmYWxsYmFjayI7CiAgICAkKCJiYWNrZW5kU3RhdHVzIikuaW5uZXJIVE1MPXNlYXJjaE9rCiAgICAgID8gYDxzcGFuIGNsYXNzPSJiYWNrZW5kLW9rIj7inJMgQmFja2VuZCBob+G6oXQgxJHhu5luZy48L3NwYW4+JHtvY3JUZXh0fWAKICAgICAgOiBgPHNwYW4gY2xhc3M9ImJhY2tlbmQtb2siPuKckyBCYWNrZW5kIGhv4bqhdCDEkeG7mW5nLjwvc3Bhbj4gR29vZ2xlIGRpcmVjdCBjw7MgdGjhu4MgYuG7iyByYXRlLWxpbWl0JHtvY3JUZXh0fWA7CiAgfWNhdGNoKGUpewogICAgJCgiYmFja2VuZFN0YXR1cyIpLmlubmVySFRNTD1gPHNwYW4gY2xhc3M9ImJhY2tlbmQtYmFkIj7inJUgQmFja2VuZDogJHtlc2MoZS5tZXNzYWdlfHxlKX08L3NwYW4+YDsKICB9Cn07CmZ1bmN0aW9uIHJlYWRQcmlvcigpe3N0YXRlLnByaW9yPXtEMTp7bm86JCgiZDFObyIpLnZhbHVlLGRhdGU6JCgiZDFEYXRlIikudmFsdWUsdGV4dDokKCJkMVRleHQiKS52YWx1ZX0sRDI6e25vOiQoImQyTm8iKS52YWx1ZSxkYXRlOiQoImQyRGF0ZSIpLnZhbHVlLHRleHQ6JCgiZDJUZXh0IikudmFsdWV9LEQzOntubzokKCJkM05vIikudmFsdWUsZGF0ZTokKCJkM0RhdGUiKS52YWx1ZSx0ZXh0OiQoImQzVGV4dCIpLnZhbHVlfX19CiQoInZhbGlkYXRlUHJpb3IiKS5vbmNsaWNrPSgpPT57cmVhZFByaW9yKCk7bGV0IGZpbGluZz0kKCJmaWxpbmdEYXRlIikudmFsdWU/bmV3IERhdGUoJCgiZmlsaW5nRGF0ZSIpLnZhbHVlKTpudWxsLGh0bWw9IjxzdHJvbmc+S+G6v3QgcXXhuqMga2nhu4NtIHRyYSB0aOG7nWkgZ2lhbjwvc3Ryb25nPjxici8+Ijtmb3IoY29uc3Rbayx2XW9mIE9iamVjdC5lbnRyaWVzKHN0YXRlLnByaW9yKSl7aWYoIXYubm8pY29udGludWU7bGV0IG9rPXYuZGF0ZSYmZmlsaW5nJiZuZXcgRGF0ZSh2LmRhdGUpPGZpbGluZztodG1sKz1gJHtrfSDCtyAke2VzYyh2Lm5vKX0gwrcgJHtlc2Modi5kYXRlfHwiY2jGsGEgY8OzIG5nw6B5Iil9IOKAlCA8c3BhbiBjbGFzcz0icGlsbCAke29rPyJncmVlbiI6InllbGxvdyJ9Ij4ke29rPyJDw7MgdGjhu4MgcGjDuSBo4bujcCB24buBIHRo4budaSBnaWFuIjoiQ+G6p24ga2nhu4NtIHRyYSJ9PC9zcGFuPjxici8+YH0kKCJwcmlvckNoZWNrIikuaW5uZXJIVE1MPWh0bWx9OwoKZnVuY3Rpb24gbWF0cml4Q29uY2VwdHMoZmVhdHVyZVRleHQpewogIGNvbnN0IHJhdz1TdHJpbmcoZmVhdHVyZVRleHR8fCIiKTsKICBjb25zdCBjb25jZXB0cz1bXTsKICBjb25zdCBwdXNoPXg9PnsKICAgIHg9U3RyaW5nKHh8fCIiKS50cmltKCkudG9Mb3dlckNhc2UoKTsKICAgIGlmKHgubGVuZ3RoPDMpIHJldHVybjsKICAgIGlmKCFjb25jZXB0cy5pbmNsdWRlcyh4KSkgY29uY2VwdHMucHVzaCh4KTsKICB9OwoKICAvLyBPcmlnaW5hbCBzaWduaWZpY2FudCBWaWV0bmFtZXNlL0VuZ2xpc2ggd29yZHMuCiAgZm9yKGNvbnN0IHcgb2YgbWVhbmluZ2Z1bFRva2VucyhyYXcpKSBwdXNoKHcpOwoKICAvLyBQYXRlbnQgZGljdGlvbmFyeSBiaWxpbmd1YWwgZXhwYW5zaW9uLgogIGZvcihjb25zdCBbayx2YWxzXSBvZiBPYmplY3QuZW50cmllcyhkaWN0KSl7CiAgICBpZihmb2xkVk4ocmF3KS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKGZvbGRWTihrKS50b0xvd2VyQ2FzZSgpKSl7CiAgICAgIHB1c2goayk7CiAgICAgIGZvcihjb25zdCB2IG9mIHZhbHMpIGZvcihjb25zdCB3IG9mIHYuc3BsaXQoL1xzKy8pKSBwdXNoKHcpOwogICAgfQogIH0KICByZXR1cm4gY29uY2VwdHMuc2xpY2UoMCwzMCk7Cn0KCmZ1bmN0aW9uIHNwbGl0RXZpZGVuY2VVbml0cyh0ZXh0KXsKICByZXR1cm4gbm9ybWFsaXplT2NyVGV4dCh0ZXh0fHwiIikKICAgIC5zcGxpdCgvXG4rfCg/PD1bLiE/OzpdKVxzKy8pCiAgICAubWFwKHg9PngudHJpbSgpKQogICAgLmZpbHRlcih4PT54Lmxlbmd0aD49MjApCiAgICAuc2xpY2UoMCw4MDApOwp9CgpmdW5jdGlvbiBsb2NhbEV2aWRlbmNlRm9yKGZlYXR1cmUsZG9jVGV4dCl7CiAgY29uc3QgdGV4dD1TdHJpbmcoZG9jVGV4dHx8IiIpLnRyaW0oKTsKICBpZighdGV4dCB8fCB0ZXh0PT09IsSQYW5nIGzhuqV5IG7hu5lpIGR1bmcgcGF0ZW50Li4uIil7CiAgICByZXR1cm4ge3N0YXR1czoiQ2jGsGEgY8OzIGThu68gbGnhu4d1IixldmlkZW5jZToiQ2jGsGEgY8OzIG7hu5lpIGR1bmcgRDEvRDIvRDMgxJHhu4MgxJHhu5FpIGNoaeG6v3UuIn07CiAgfQoKICBjb25zdCBjb25jZXB0cz1tYXRyaXhDb25jZXB0cyhmZWF0dXJlLnRleHQpOwogIGlmKCFjb25jZXB0cy5sZW5ndGgpewogICAgcmV0dXJuIHtzdGF0dXM6IkNoxrBhIGNo4bqvYyBjaOG6r24iLGV2aWRlbmNlOiJLaMO0bmcgdMOhY2ggxJHGsOG7o2MgxJHhu6cgdGh14bqtdCBuZ+G7ryBr4bu5IHRodeG6rXQgxJHhu4MgbWFwcGluZyB04buxIMSR4buZbmcuIn07CiAgfQoKICBjb25zdCB1bml0cz1zcGxpdEV2aWRlbmNlVW5pdHModGV4dCk7CiAgbGV0IGJlc3Q9e3Njb3JlOjAsdW5pdDoiIixoaXRzOltdfTsKCiAgZm9yKGNvbnN0IHUgb2YgdW5pdHMpewogICAgY29uc3QgZnU9Zm9sZFZOKHUpLnRvTG93ZXJDYXNlKCk7CiAgICBjb25zdCBoaXRzPWNvbmNlcHRzLmZpbHRlcihjPT5mdS5pbmNsdWRlcyhmb2xkVk4oYykudG9Mb3dlckNhc2UoKSkpOwogICAgY29uc3QgdW5pcXVlPVsuLi5uZXcgU2V0KGhpdHMpXTsKICAgIGxldCBzY29yZT11bmlxdWUubGVuZ3RoOwogICAgaWYodW5pcXVlLnNvbWUoeD0+eC5pbmNsdWRlcygiZHJhZ29uIil8fHguaW5jbHVkZXMoImdlcm1pbmF0aW9uIil8fHguaW5jbHVkZXMoImNlbGx1bGFzZSIpfHx4LmluY2x1ZGVzKCJwZWN0aW5hc2UiKSkpIHNjb3JlKz0xOwogICAgaWYoc2NvcmU+YmVzdC5zY29yZSkgYmVzdD17c2NvcmUsdW5pdDp1LGhpdHM6dW5pcXVlfTsKICB9CgogIGxldCBzdGF0dXM9IkNoxrBhIGNo4bqvYyBjaOG6r24iOwogIGlmKGJlc3Quc2NvcmU+PTUpIHN0YXR1cz0iQ8OzIjsKICBlbHNlIGlmKGJlc3Quc2NvcmU+PTMpIHN0YXR1cz0iTeG7mXQgcGjhuqduIjsKICBlbHNlIGlmKGJlc3Quc2NvcmU+PTEpIHN0YXR1cz0iQ2jGsGEgY2jhuq9jIGNo4bqvbiI7CiAgZWxzZSBzdGF0dXM9IkNoxrBhIGNo4bqvYyBjaOG6r24iOyAvLyB2MTA6IGtow7RuZyBr4bq/dCBsdeG6rW4gIktow7RuZyB0w6xtIHRo4bqleSIgY2jhu4kgdsOsIGhldXJpc3RpYyBraMO0bmcgbWF0Y2guCgogIGNvbnN0IGV2aWRlbmNlPWJlc3QudW5pdAogICAgPyBgJHtiZXN0LnVuaXQuc2xpY2UoMCw0MjApfSR7YmVzdC51bml0Lmxlbmd0aD40MjA/IuKApiI6IiJ9YAogICAgOiJDaMawYSB0w6xtIHRo4bqleSDEkW/huqFuIMSR4bunIHLDtSBi4bqxbmcgaGV1cmlzdGljOyBj4bqnbiBBSS9jaHV5w6puIGdpYSBraeG7g20gdHJhIG7hu5lpIGR1bmcgcGF0ZW50LiI7CgogIHJldHVybiB7c3RhdHVzLGV2aWRlbmNlfTsKfQoKZnVuY3Rpb24gYnVpbGRMb2NhbE1hdHJpeCgpewogIGNvbnN0IHJvd3M9W107CiAgZm9yKGNvbnN0IGYgb2Ygc3RhdGUuZmVhdHVyZXMpewogICAgY29uc3QgdmFscz1bXTsKICAgIGNvbnN0IG5vdGVzPVtdOwogICAgZm9yKGNvbnN0IGsgb2YgWyJEMSIsIkQyIiwiRDMiXSl7CiAgICAgIGNvbnN0IHI9bG9jYWxFdmlkZW5jZUZvcihmLHN0YXRlLnByaW9yW2tdPy50ZXh0fHwiIik7CiAgICAgIHZhbHMucHVzaChyLnN0YXR1cyk7CiAgICAgIG5vdGVzLnB1c2goYCR7a306ICR7ci5ldmlkZW5jZX1gKTsKICAgIH0KICAgIHJvd3MucHVzaChbZi5pZCwuLi52YWxzLG5vdGVzLmpvaW4oIiB8ICIpXSk7CiAgfQogIHJldHVybiByb3dzOwp9Cgphc3luYyBmdW5jdGlvbiBidWlsZE1hdHJpeFBybygpewogIHJlYWRQcmlvcigpOwogIGlmKCFzdGF0ZS5mZWF0dXJlcy5sZW5ndGgpIHJldHVybiBhbGVydCgiQ2jGsGEgY8OzIGZlYXR1cmUuIik7CgogIGNvbnN0IGRvY3M9T2JqZWN0LmVudHJpZXMoc3RhdGUucHJpb3IpLmZpbHRlcigoW2ssdl0pPT52JiZ2Lm5vJiZTdHJpbmcodi50ZXh0fHwiIikudHJpbSgpKTsKICBpZighZG9jcy5sZW5ndGgpewogICAgc3RhdGUubWF0cml4PXN0YXRlLmZlYXR1cmVzLm1hcChmPT5bCiAgICAgIGYuaWQsIkNoxrBhIGPDsyBk4buvIGxp4buHdSIsIkNoxrBhIGPDsyBk4buvIGxp4buHdSIsIkNoxrBhIGPDsyBk4buvIGxp4buHdSIsCiAgICAgICJDaMawYSBjaOG7jW4gaG/hurdjIGNoxrBhIHThuqNpIG7hu5lpIGR1bmcgRDHigJNEMy4gSMOjeSBxdWF5IGzhuqFpIGLGsOG7m2MgNSB2w6AgY2jhu41uIHTDoGkgbGnhu4d1IMSR4buRaSBjaOG7qW5nLiIKICAgIF0pOwogICAgcmVuZGVyTWF0cml4KCk7CiAgICByZXR1cm47CiAgfQoKICAkKCJtYXRyaXhCb2R5IikuaW5uZXJIVE1MPSc8dHI+PHRkIGNvbHNwYW49IjUiIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjojNjY3MDg1Ij7EkGFuZyB0csOtY2ggZXZpZGVuY2UgdGhlbyB04burbmcgZOG6pXUgaGnhu4d14oCmPC90ZD48L3RyPic7CgogIC8vIE7hur91IGPDsyBHRU1JTklfQVBJX0tFWSBiYWNrZW5kIHPhur0gZMO5bmcgR2VuQUk7IG7hur91IGNoxrBhIGPDsyB0aMOsIGZhbGxiYWNrIGxvY2FsLgogIHRyeXsKICAgIGNvbnN0IHBheWxvYWQ9ewogICAgICBmZWF0dXJlczpzdGF0ZS5mZWF0dXJlcy5tYXAoZj0+KHtpZDpmLmlkLHRleHQ6Zi50ZXh0fSkpLAogICAgICBkb2N1bWVudHM6T2JqZWN0LmZyb21FbnRyaWVzKFsiRDEiLCJEMiIsIkQzIl0ubWFwKGs9PlsKICAgICAgICBrLHsKICAgICAgICAgIG5vOnN0YXRlLnByaW9yW2tdPy5ub3x8IiIsCiAgICAgICAgICB0ZXh0OlN0cmluZyhzdGF0ZS5wcmlvcltrXT8udGV4dHx8IiIpLnNsaWNlKDAsMjIwMDApCiAgICAgICAgfQogICAgICBdKSkKICAgIH07CiAgICBjb25zdCByPWF3YWl0IGZldGNoKCIvYXBpL21hdHJpeCIsewogICAgICBtZXRob2Q6IlBPU1QiLAogICAgICBoZWFkZXJzOnsiY29udGVudC10eXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LAogICAgICBib2R5OkpTT04uc3RyaW5naWZ5KHBheWxvYWQpCiAgICB9KTsKICAgIGNvbnN0IGQ9YXdhaXQgci5qc29uKCkuY2F0Y2goKCk9Pih7fSkpOwogICAgaWYoci5vayYmZC5vayYmQXJyYXkuaXNBcnJheShkLnJvd3MpKXsKICAgICAgc3RhdGUubWF0cml4PWQucm93cy5tYXAoeD0+WwogICAgICAgIHguZmVhdHVyZV9pZCwKICAgICAgICB4LkQxPy5zdGF0dXN8fCJDaMawYSBjaOG6r2MgY2jhuq9uIiwKICAgICAgICB4LkQyPy5zdGF0dXN8fCJDaMawYSBjaOG6r2MgY2jhuq9uIiwKICAgICAgICB4LkQzPy5zdGF0dXN8fCJDaMawYSBjaOG6r2MgY2jhuq9uIiwKICAgICAgICBbeC5EMSYmYEQxOiAke3guRDEuZXZpZGVuY2V8fCIifWAseC5EMiYmYEQyOiAke3guRDIuZXZpZGVuY2V8fCIifWAseC5EMyYmYEQzOiAke3guRDMuZXZpZGVuY2V8fCIifWBdLmZpbHRlcihCb29sZWFuKS5qb2luKCIgfCAiKQogICAgICBdKTsKICAgICAgcmVuZGVyTWF0cml4KCk7CiAgICAgIHJldHVybjsKICAgIH0KICB9Y2F0Y2goZSl7Y29uc29sZS53YXJuKCJBSSBtYXRyaXggZmFsbGJhY2s6IixlKX0KCiAgc3RhdGUubWF0cml4PWJ1aWxkTG9jYWxNYXRyaXgoKTsKICByZW5kZXJNYXRyaXgoKTsKfQoKJCgiYnVpbGRNYXRyaXgiKS5vbmNsaWNrPWJ1aWxkTWF0cml4UHJvOwoKZnVuY3Rpb24gcGlsbCh2KXsKICBsZXQgYz12PT09IkPDsyI/ImdyZWVuIjp2PT09Ik3hu5l0IHBo4bqnbiI/InllbGxvdyI6dj09PSJLaMO0bmcgdMOsbSB0aOG6pXkiPyJyZWQiOnY9PT0iQ2jGsGEgY8OzIGThu68gbGnhu4d1Ij8iIjoiIjsKICByZXR1cm5gPHNwYW4gY2xhc3M9InBpbGwgJHtjfSI+JHt2fTwvc3Bhbj5gCn0KZnVuY3Rpb24gcmVuZGVyTWF0cml4KCl7CiAgJCgibWF0cml4Qm9keSIpLmlubmVySFRNTD1zdGF0ZS5tYXRyaXgubWFwKHI9PmA8dHI+CiAgICA8dGQ+PHN0cm9uZz4ke3JbMF19PC9zdHJvbmc+PC90ZD4KICAgIDx0ZD4ke3BpbGwoclsxXSl9PC90ZD4KICAgIDx0ZD4ke3BpbGwoclsyXSl9PC90ZD4KICAgIDx0ZD4ke3BpbGwoclszXSl9PC90ZD4KICAgIDx0ZCBzdHlsZT0ibWluLXdpZHRoOjQyMHB4Ij4ke2VzYyhyWzRdKX08L3RkPgogIDwvdHI+YCkuam9pbigiIikKfQoKJCgicnVuQXNzZXNzbWVudCIpLm9uY2xpY2s9KCk9PntpZighc3RhdGUubWF0cml4Lmxlbmd0aClyZXR1cm4gYWxlcnQoIkjDo3kgdOG6oW8gbWEgdHLhuq1uIHRyxrDhu5tjLiIpO2xldCBhbGw9WzEsMiwzXS5maWx0ZXIoYz0+c3RhdGUubWF0cml4LmV2ZXJ5KHI9PnJbY109PT0iQ8OzIikpO3N0YXRlLmFzc2Vzc21lbnQ9e25vdmVsdHlSaXNrOmFsbC5sZW5ndGg/IlLhu6ZJIFJPIENBTyI6IkNIxq9BIFBIw4FUIEhJ4buGTiBN4bqkVCBUw41OSCBN4buaSSIsbm92ZWx0eVRleHQ6YWxsLmxlbmd0aD9gQ8OzICR7YWxsLm1hcCh4PT4iRCIreCkuam9pbigiLCAiKX0gxJHGsOG7o2MgbWFwcGluZyBi4buZYyBs4buZIHRvw6BuIGLhu5kgZmVhdHVyZTsgY+G6p24ga2nhu4NtIHRyYSBldmlkZW5jZS5gOiJUcm9uZyB04bqtcCBEMeKAk0QzIGhp4buHbiB04bqhaSwgY2jGsGEgeMOhYyDEkeG7i25oIG3hu5l0IHTDoGkgbGnhu4d1IMSRxqFuIGzhursgYuG7mWMgbOG7mSB0b8OgbiBi4buZIGThuqV1IGhp4buHdS4gS+G6v3QgcXXhuqMgY2jhu4kgw6FwIGThu6VuZyBjaG8gdOG6rXAgdMOgaSBsaeG7h3UgxJFhbmcga2jhuqNvIHPDoXQuIixpbnZlbnRpdmVSaXNrOiJD4bqmTiBDSFVZw4pOIEdJQSIsaW52ZW50aXZlVGV4dDoiQ+G6p24gY2jhu41uIMSR4buRaSBjaOG7qW5nIGfhuqduIG5o4bqldCwgeMOhYyDEkeG7i25oIGThuqV1IGhp4buHdSBraMOhYyBiaeG7h3QgdsOgIHbhuqVuIMSR4buBIGvhu7kgdGh14bqtdCBraMOhY2ggcXVhbiwgc2F1IMSRw7MgeGVtIHjDqXQgbGnhu4d1IHByaW9yIGFydCBraMOhYyBjw7MgZ+G7o2kgw70gY8OhY2ggZ2nhuqNpIHF1eeG6v3QgaGF5IGtow7RuZy4ifTtyZW5kZXJBc3Nlc3NtZW50KCl9OwpmdW5jdGlvbiByZW5kZXJBc3Nlc3NtZW50KCl7JCgibm92ZWx0eVRleHQiKS50ZXh0Q29udGVudD1zdGF0ZS5hc3Nlc3NtZW50Lm5vdmVsdHlUZXh0fHwiIjskKCJpbnZlbnRpdmVUZXh0IikudGV4dENvbnRlbnQ9c3RhdGUuYXNzZXNzbWVudC5pbnZlbnRpdmVUZXh0fHwiIjskKCJub3ZlbHR5UmlzayIpLnRleHRDb250ZW50PXN0YXRlLmFzc2Vzc21lbnQubm92ZWx0eVJpc2t8fCJDSOG7nCBE4buuIExJ4buGVSI7JCgiaW52ZW50aXZlUmlzayIpLnRleHRDb250ZW50PXN0YXRlLmFzc2Vzc21lbnQuaW52ZW50aXZlUmlza3x8IkNI4bucIEThu64gTEnhu4ZVIjskKCJub3ZlbHR5UmlzayIpLmNsYXNzTmFtZT0icmlza2JveCAiKygoc3RhdGUuYXNzZXNzbWVudC5ub3ZlbHR5Umlza3x8IiIpLmluY2x1ZGVzKCJDQU8iKT8icmVkIjoiZ3JlZW4iKTskKCJpbnZlbnRpdmVSaXNrIikuY2xhc3NOYW1lPSJyaXNrYm94IHllbGxvdyI7cmVuZGVyRXhwZXJ0KCl9CmZ1bmN0aW9uIHJlbmRlckV4cGVydCgpe2xldCByb3dzPVtbIkThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQiLGAke3N0YXRlLmZlYXR1cmVzLmxlbmd0aH0gZmVhdHVyZWBdLFsiQ2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdSIsYCR7c3RhdGUucXVlcmllcy5sZW5ndGh9IHF1ZXJ5YF0sWyJQcmlvciBhcnQiLE9iamVjdC52YWx1ZXMoc3RhdGUucHJpb3IpLmZpbHRlcih4PT54JiZ4Lm5vKS5tYXAoeD0+eC5ubykuam9pbigiLCAiKXx8IkNoxrBhIGPDsyJdLFsiQuG6o25nIMSR4buRaSBjaGnhur91IixgJHtzdGF0ZS5tYXRyaXgubGVuZ3RofSBmZWF0dXJlYF0sWyJUw61uaCBt4bubaSIsc3RhdGUuYXNzZXNzbWVudC5ub3ZlbHR5Umlza3x8IkNoxrBhIMSRw6FuaCBnacOhIl0sWyJUcsOsbmggxJHhu5kgc8OhbmcgdOG6oW8iLHN0YXRlLmFzc2Vzc21lbnQuaW52ZW50aXZlUmlza3x8IkNoxrBhIMSRw6FuaCBnacOhIl1dOyQoImV4cGVydEJvZHkiKS5pbm5lckhUTUw9cm93cy5tYXAoKHIsaSk9PmA8dHI+PHRkPjxzdHJvbmc+JHtyWzBdfTwvc3Ryb25nPjwvdGQ+PHRkPiR7ZXNjKHJbMV0pfTwvdGQ+PHRkPjxzZWxlY3QgZGF0YS1yPSIke2l9Ij48b3B0aW9uPkNo4budIHLDoCBzb8OhdDwvb3B0aW9uPjxvcHRpb24+WMOhYyBuaOG6rW48L29wdGlvbj48b3B0aW9uPkNo4buJbmggc+G7rWE8L29wdGlvbj48b3B0aW9uPktow7RuZyDEkeG7k25nIMO9PC9vcHRpb24+PC9zZWxlY3Q+PC90ZD48dGQ+PGlucHV0IHBsYWNlaG9sZGVyPSJOaOG6rW4geMOpdCBjaHV5w6puIGdpYSIvPjwvdGQ+PC90cj5gKS5qb2luKCIiKX1yZW5kZXJFeHBlcnQoKTsKJCgic2F2ZVJldmlldyIpLm9uY2xpY2s9KCk9PntzdGF0ZS5yZXZpZXdzPVsuLi5kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1yXSIpXS5maWx0ZXIoeD0+eC52YWx1ZSE9PSJDaOG7nSByw6Agc2/DoXQiKS5sZW5ndGg7YWxlcnQoIsSQw6MgbMawdSByw6Agc2/DoXQgdHJvbmcgcGhpw6puIGhp4buHbiB04bqhaS4iKX07CgokKCJnZW5SZXBvcnQiKS5vbmNsaWNrPSgpPT57cmVhZFByaW9yKCk7bGV0IGM9c3RhdGUuY2xhaW1zW3N0YXRlLnNlbGVjdGVkXXx8c3RhdGUuY2xhaW1zWzBdOyQoInJlcG9ydENvbnRlbnQiKS5pbm5lckhUTUw9YAo8aDM+MS4gVGjDtG5nIHRpbiBzw6FuZyBjaOG6vzwvaDM+PGRpdiBjbGFzcz0ic3VtbWFyeSI+PGRpdj5Nw6MgY2FzZTwvZGl2PjxkaXY+JHtlc2MoJCgiY2FzZUlkIikudmFsdWUpfTwvZGl2PjxkaXY+U+G7kSBi4bqxbmcvY8O0bmcgYuG7kTwvZGl2PjxkaXY+JHtlc2MoJCgicGF0ZW50Tm8iKS52YWx1ZSl9PC9kaXY+PGRpdj5Uw6puIHPDoW5nIGNo4bq/PC9kaXY+PGRpdj4ke2VzYygkKCJ0aXRsZSIpLnZhbHVlKX08L2Rpdj48ZGl2Pk5nw6B5IG7hu5lwL8awdSB0acOqbjwvZGl2PjxkaXY+JHtlc2MoJCgiZmlsaW5nRGF0ZSIpLnZhbHVlKX08L2Rpdj48ZGl2PklQQy9DUEM8L2Rpdj48ZGl2PiR7ZXNjKCQoImlwYyIpLnZhbHVlKX08L2Rpdj48L2Rpdj4KPGgzPjIuIENsYWltIMSRxrDhu6NjIHBow6JuIHTDrWNoPC9oMz48cD4ke2VzYyhjPy50ZXh0fHwiQ2jGsGEgY2jhu41uIil9PC9wPgo8aDM+My4gROG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdDwvaDM+PG9sPiR7c3RhdGUuZmVhdHVyZXMubWFwKGY9PmA8bGk+PHN0cm9uZz4ke2YuaWR9PC9zdHJvbmc+IOKAlCAke2VzYyhmLnRleHQpfTwvbGk+YCkuam9pbigiIil8fCI8bGk+Q2jGsGEgY8OzPC9saT4ifTwvb2w+CjxoMz40LiBDaGnhur9uIGzGsOG7o2MgdHJhIGPhu6l1PC9oMz48dWw+JHtzdGF0ZS5xdWVyaWVzLm1hcChxPT5gPGxpPjxjb2RlPiR7ZXNjKHEpfTwvY29kZT48L2xpPmApLmpvaW4oIiIpfHwiPGxpPkNoxrBhIHThuqFvPC9saT4ifTwvdWw+CjxoMz41LiDEkMOhbmggZ2nDoSBzxqEgYuG7mSB0w61uaCBt4bubaTwvaDM+PHA+PHN0cm9uZz4ke2VzYyhzdGF0ZS5hc3Nlc3NtZW50Lm5vdmVsdHlSaXNrfHwiQ2jGsGEgxJHDoW5oIGdpw6EiKX08L3N0cm9uZz48L3A+PHA+JHtlc2Moc3RhdGUuYXNzZXNzbWVudC5ub3ZlbHR5VGV4dHx8IiIpfTwvcD4KPGgzPjYuIFBow6JuIHTDrWNoIHPGoSBi4buZIHRyw6xuaCDEkeG7mSBzw6FuZyB04bqhbzwvaDM+PHA+PHN0cm9uZz4ke2VzYyhzdGF0ZS5hc3Nlc3NtZW50LmludmVudGl2ZVJpc2t8fCJDaMawYSDEkcOhbmggZ2nDoSIpfTwvc3Ryb25nPjwvcD48cD4ke2VzYyhzdGF0ZS5hc3Nlc3NtZW50LmludmVudGl2ZVRleHR8fCIiKX08L3A+PHA+PHN0cm9uZz7EkOG7kWkgY2jhu6luZyBn4bqnbiBuaOG6pXQ6PC9zdHJvbmc+ICR7ZXNjKCQoImNsb3Nlc3QiKS52YWx1ZSl9PC9wPjxwPjxzdHJvbmc+ROG6pXUgaGnhu4d1IGtow6FjIGJp4buHdDo8L3N0cm9uZz4gJHtlc2MoJCgiZGlmZmVyZW5jZXMiKS52YWx1ZSl9PC9wPjxwPjxzdHJvbmc+VuG6pW4gxJHhu4Ega+G7uSB0aHXhuq10IGtow6FjaCBxdWFuOjwvc3Ryb25nPiAke2VzYygkKCJwcm9ibGVtIikudmFsdWUpfTwvcD48cD48c3Ryb25nPkzhuq1wIGx14bqtbjo8L3N0cm9uZz4gJHtlc2MoJCgicmVhc29uaW5nIikudmFsdWUpfTwvcD4KPGgzPjcuIEV4cGVydCByZXZpZXc8L2gzPjxwPlPhu5EgaOG6oW5nIG3hu6VjIMSRw6MgxJHGsOG7o2MgcsOgIHNvw6F0OiA8c3Ryb25nPiR7c3RhdGUucmV2aWV3c308L3N0cm9uZz4uPC9wPgo8ZGl2IGNsYXNzPSJjYWxsb3V0Ij48c3Ryb25nPkzGsHUgw706PC9zdHJvbmc+IMSQw6J5IGzDoCBiw6FvIGPDoW8gcGjDom4gdMOtY2ggc8ahIGLhu5kgcGjhu6VjIHbhu6UgbmdoacOqbiBj4bupdSwga2jDtG5nIHBo4bqjaSDDvSBraeG6v24gcGjDoXAgbMO9IGN14buRaSBjw7luZy48L2Rpdj5gfTsKCmNvbnN0IGRlbW89YCgxMikgQuG6ok4gTcOUIFThuqIgU8OBTkcgQ0jhur4gVEhV4buYQyBC4bqwTkcgxJDhu5hDIFFVWeG7gE4gU8OBTkcgQ0jhur4KKDExKSAxLTAwNDIxODAKKDUxKSBBNjFLIDM2LzMzOyBBNjFLIDM2Lzc0NjsgQTIzTCAxOS8wMDsgQTIzTCAzMy8xMAooMjIpIDMwLzA2LzIwMjEKKDczKSBDw5RORyBUWSBUTkhIIE7Gr+G7mkMgw4lQIFBIw5pDIEjDgCAoVk4pCig3NCkgQ8O0bmcgdHkgVE5ISCBUxrAgduG6pW4gY8O0bmcgbmdo4buHIHbDoCBT4bufIGjhu691IHRyw60gdHXhu4cgSVAgR1JPVVAKKDU0KSBRVVkgVFLDjE5IIFPhuqJOIFhV4bqkVCBC4buYVCBESU5IIETGr+G7oE5HIFThu6ogSOG6oFQgVEhBTkggTE9ORyBO4bqiWSBN4bqmTQooNTcpIFPDoW5nIGNo4bq/IMSR4buBIGPhuq1wIMSR4bq/biBi4buZdCBkaW5oIGTGsOG7oW5nIHThu6sgaOG6oXQgdGhhbmggbG9uZyBu4bqjeSBt4bqnbSB0aHUgxJHGsOG7o2MgdOG7qyBt4buZdCBxdXkgdHLDrG5oIHPhuqNuIHh14bqldC4KWcOKVSBD4bqmVSBC4bqiTyBI4buYCjEuIFF1eSB0csOsbmggc+G6o24geHXhuqV0IGLhu5l0IGRpbmggZMaw4buhbmcgdOG7qyBo4bqhdCB0aGFuaCBsb25nIG7huqN5IG3huqdtIGJhbyBn4buTbTogKGkpIGNodeG6qW4gYuG7iyBuZ3V5w6puIGxp4buHdSBo4bqhdCB0aGFuaCBsb25nOyAoaWkpIHjhu60gbMO9IGLhurFuZyBjaOG6vyBwaOG6qW0gZW56eW1lIGNlbGx1bGFzZSB2w6AgcGVjdGluYXNlOyAoaWlpKSBuZ8OibSB2w6Ag4bunIMSR4buDIGjhuqF0IG7huqN5IG3huqdtOyAoaXYpIHPhuqV5OyAodikgbmdoaeG7gW47ICh2aSkga2nhu4NtIHRyYSDEkeG7k25nIG5o4bqldDsgKHZpaSkgdGjDqm0gYuG7mXQgbmjDoHU7ICh2aWlpKSB0aMOqbSBi4buZdCB0aGFuaCBsb25nOyAoaXgpIHRow6ptIHRow6BuaCBwaOG6p24gcGjhu6U7ICh4KSBraeG7g20gdHJhIMSR4buTbmcgbmjhuqV0OyAoeGkpIG5naGnhu4FuIHbDoCDEkWnhu4F1IGNo4buJbmggxJHhu5kg4bqpbTsgKHhpaSkgxJHDs25nIGfDs2kuCjIuIFF1eSB0csOsbmggdGhlbyDEkWnhu4NtIDEsIHRyb25nIMSRw7MgdGjDoG5oIHBo4bqnbiBwaOG7pSBiYW8gZ+G7k20gY2jhuqV0IGLhuqNvIHF14bqjbiB2w6AgY2jhuqV0IGNo4buRbmcgdsOzbi4KMy4gUXV5IHRyw6xuaCB0aGVvIMSRaeG7g20gMSwgdHJvbmcgxJHDsyB0aMOgbmggcGjhuqduIGNo4bqldCB04bqhbyBuZ+G7jXQgdOG7sSBuaGnDqm4gYmFvIGfhu5NtIG5ow7NtIGdsdWNpdC5gOwokKCJsb2FkRGVtbyIpLm9uY2xpY2s9KCk9PntzdGF0ZS5yYXdUZXh0PWRlbW87bGV0IG09ZXh0cmFjdE1ldGFkYXRhKGRlbW8pO2ZpbGxNZXRhKG0pO2xldCBjdD1jbGVhbihkZW1vLnNsaWNlKGRlbW8uc2VhcmNoKC9Zw4pVIEPhuqZVIELhuqJPIEjhu5gvaSkrIlnDilUgQ+G6plUgQuG6ok8gSOG7mCIubGVuZ3RoKSk7c3RhdGUuY2xhaW1zVGV4dD1jdDskKCJjbGFpbXNSYXciKS52YWx1ZT1jdDskKCJjbGFpbXNDbGVhbiIpLnZhbHVlPWZvcm1hdENsYWltRm9yRGlzcGxheShjdCk7c3RhdGUuY2xhaW1zPXBhcnNlQ2xhaW1zKGN0KTtyZW5kZXJDbGFpbXMoKTtzZXREZXRlY3QoImRldENsYWltcyIsdHJ1ZSxgxJDDoyB0w6FjaCAke3N0YXRlLmNsYWltcy5sZW5ndGh9IGNsYWltYCk7JCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMTAwJSI7JCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9IsSQw6MgbuG6oXAgZGVtbyBQSC1WTi0wMS4ifTsKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPg==";
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
