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
      version: "10.0.0",
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

const APP_HTML_B64 = "PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9InZpIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ii8+CjxtZXRhIG5hbWU9InZpZXdwb3J0IiBjb250ZW50PSJ3aWR0aD1kZXZpY2Utd2lkdGgsaW5pdGlhbC1zY2FsZT0xIi8+Cjx0aXRsZT5QYXRlbnRMZW5zIEFJIOKAlCBRdXkgdHLDrG5oIHBow6JuIHTDrWNoIHPDoW5nIGNo4bq/PC90aXRsZT4KPG1ldGEgbmFtZT0iZGVzY3JpcHRpb24iIGNvbnRlbnQ9IlByb3RvdHlwZSBuZ2hpw6puIGPhu6l1IGjhu5cgdHLhu6MgdHJhIGPhu6l1IHbDoCDEkcOhbmggZ2nDoSBzxqEgYuG7mSBzw6FuZyBjaOG6vyB0aGVvIGNodeG7l2kgQ2xhaW0g4oaSIEZlYXR1cmUg4oaSIFNlYXJjaCDihpIgUHJpb3IgQXJ0IOKGkiBOb3ZlbHR5IOKGkiBJbnZlbnRpdmUgU3RlcCDihpIgRXhwZXJ0IFJldmlldy4iLz4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuanMuY2xvdWRmbGFyZS5jb20vYWpheC9saWJzL3BkZi5qcy8zLjExLjE3NC9wZGYubWluLmpzIj48L3NjcmlwdD4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuLmpzZGVsaXZyLm5ldC9ucG0vdGVzc2VyYWN0LmpzQDUuMS4xL2Rpc3QvdGVzc2VyYWN0Lm1pbi5qcyI+PC9zY3JpcHQ+CjxzdHlsZT4KOnJvb3R7CiAgLS1iZzojZjZmN2Y5Oy0tc3VyZmFjZTojZmZmOy0tc3VyZmFjZTI6I2Y5ZmFmYjstLXRleHQ6IzEwMTgyODstLW11dGVkOiM2NjcwODU7CiAgLS1saW5lOiNlNGU3ZWM7LS1kYXJrOiMxMDE4Mjg7LS1zb2Z0OiNmMmY0Zjc7LS1ncmVlbjojMDY3NjQ3Oy0tZ3JlZW5iZzojZWNmZGYzOwogIC0teWVsbG93OiNiNTQ3MDg7LS15ZWxsb3diZzojZmZmYWViOy0tcmVkOiNiNDIzMTg7LS1yZWRiZzojZmVmM2YyOy0tYmx1ZTojMTc1Y2QzOwogIC0tYmx1ZWJnOiNlZmY4ZmY7LS1zaGFkb3c6MCAxMnB4IDM2cHggcmdiYSgxNiwyNCw0MCwuMDYpOy0tcmFkaXVzOjE4cHgKfQoqe2JveC1zaXppbmc6Ym9yZGVyLWJveH1odG1se3Njcm9sbC1iZWhhdmlvcjpzbW9vdGh9CmJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDp2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7Zm9udC1mYW1pbHk6SW50ZXIsdWktc2Fucy1zZXJpZiwtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwiU2Vnb2UgVUkiLFJvYm90byxBcmlhbCxzYW5zLXNlcmlmfQpidXR0b24saW5wdXQsdGV4dGFyZWEsc2VsZWN0e2ZvbnQ6aW5oZXJpdH1idXR0b257Y3Vyc29yOnBvaW50ZXJ9Ci5hcHB7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczoyNzVweCAxZnI7bWluLWhlaWdodDoxMDB2aH0KYXNpZGV7cG9zaXRpb246c3RpY2t5O3RvcDowO2hlaWdodDoxMDB2aDtiYWNrZ3JvdW5kOiMwZjExMTU7Y29sb3I6I2ZmZjtwYWRkaW5nOjI0cHggMThweDtib3JkZXItcmlnaHQ6MXB4IHNvbGlkICMyMjI4MzF9Ci5icmFuZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O3BhZGRpbmc6MCA4cHg7bWFyZ2luLWJvdHRvbToyNnB4fQoubG9nb3t3aWR0aDozOXB4O2hlaWdodDozOXB4O2JvcmRlci1yYWRpdXM6MTJweDtiYWNrZ3JvdW5kOiNmZmY7Y29sb3I6IzExMTtkaXNwbGF5OmdyaWQ7cGxhY2UtaXRlbXM6Y2VudGVyO2ZvbnQtd2VpZ2h0OjkwMH0KLmJyYW5kIHN0cm9uZ3tmb250LXNpemU6MTZweH0uYnJhbmQgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojOThhMmIzO21hcmdpbi10b3A6M3B4fQoucHJvY2Vzc3tkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo3cHh9Ci5wcm9jZXNzLWl0ZW17cGFkZGluZzoxMXB4IDEycHg7Ym9yZGVyLXJhZGl1czoxMnB4O2NvbG9yOiM4Zjk4YTY7ZGlzcGxheTpmbGV4O2dhcDoxMHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtmb250LXNpemU6MTNweH0KLnByb2Nlc3MtaXRlbSAubnt3aWR0aDoyNXB4O2hlaWdodDoyNXB4O2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7Ym9yZGVyLXJhZGl1czo4cHg7YmFja2dyb3VuZDojMjYyYjMzO2ZvbnQtc2l6ZToxMnB4fQoucHJvY2Vzcy1pdGVtLmFjdGl2ZXtiYWNrZ3JvdW5kOiMxZDIxMjg7Y29sb3I6I2ZmZn0KLnByb2Nlc3MtaXRlbS5kb25le2NvbG9yOiNkMGQ1ZGR9LnByb2Nlc3MtaXRlbS5kb25lIC5ue2JhY2tncm91bmQ6IzM0NDA1NDtjb2xvcjojZmZmfQouc2lkZS1ub3Rle3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MThweDtyaWdodDoxOHB4O2JvdHRvbToyMHB4O3BhZGRpbmc6MTRweDtib3JkZXItcmFkaXVzOjE0cHg7YmFja2dyb3VuZDojMTcxYTIwO2JvcmRlcjoxcHggc29saWQgIzI3MmMzNDtjb2xvcjojOThhMmIzO2ZvbnQtc2l6ZToxMnB4O2xpbmUtaGVpZ2h0OjEuNTV9Cm1haW57cGFkZGluZzozNHB4IDM4cHggMTIwcHg7bWluLXdpZHRoOjB9Ci50b3B7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTZweDttYXJnaW4tYm90dG9tOjIwcHh9Cmgxe2ZvbnQtc2l6ZToyOHB4O2xldHRlci1zcGFjaW5nOi0uMDRlbTttYXJnaW46MH0udG9wIHB7bWFyZ2luOjZweCAwIDA7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxNHB4fQouY2FzZS1iYWRnZXtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtwYWRkaW5nOjlweCAxMnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7Y29sb3I6IzQ3NTQ2Nztmb250LXNpemU6MTJweDt3aGl0ZS1zcGFjZTpub3dyYXB9Ci5sb2NhbC1iYW5uZXJ7cGFkZGluZzoxM3B4IDE1cHg7Ym9yZGVyLXJhZGl1czoxM3B4O21hcmdpbi1ib3R0b206MTZweDtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU7Ym9yZGVyOjFweCBzb2xpZCAjZmVkZjg5O2JhY2tncm91bmQ6dmFyKC0teWVsbG93YmcpO2NvbG9yOiM3YTJlMGV9Ci5zZWN0aW9ue2Rpc3BsYXk6bm9uZX0uc2VjdGlvbi5hY3RpdmV7ZGlzcGxheTpibG9ja30KLnBhbmVse2JhY2tncm91bmQ6dmFyKC0tc3VyZmFjZSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3gtc2hhZG93OnZhcigtLXNoYWRvdyk7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMpO3BhZGRpbmc6MjRweDttYXJnaW4tYm90dG9tOjE4cHh9Ci5wYW5lbCBoMnttYXJnaW46MCAwIDZweDtmb250LXNpemU6MjBweDtsZXR0ZXItc3BhY2luZzotLjAyZW19LnN1Yntjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOjE0cHg7bGluZS1oZWlnaHQ6MS41NTttYXJnaW4tYm90dG9tOjIwcHh9Ci5ncmlke2Rpc3BsYXk6Z3JpZDtnYXA6MTRweH0uZzJ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgyLG1pbm1heCgwLDFmcikpfS5nM3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsbWlubWF4KDAsMWZyKSl9CmxhYmVse2Rpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NzUwO2NvbG9yOiM0NzU0Njc7bWFyZ2luLWJvdHRvbTo3cHh9CmlucHV0LHRleHRhcmVhLHNlbGVjdHt3aWR0aDoxMDAlO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojZmZmO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjEycHggMTNweDtvdXRsaW5lOm5vbmU7Y29sb3I6IzExMTgyN30KaW5wdXQ6Zm9jdXMsdGV4dGFyZWE6Zm9jdXMsc2VsZWN0OmZvY3Vze2JvcmRlci1jb2xvcjojOThhMmIzO2JveC1zaGFkb3c6MCAwIDAgM3B4IHJnYmEoMTcsMjQsMzksLjA1KX0KdGV4dGFyZWF7cmVzaXplOnZlcnRpY2FsO21pbi1oZWlnaHQ6MTEwcHh9Ci5kcm9we2JvcmRlcjoxLjVweCBkYXNoZWQgI2NmZDRkYztib3JkZXItcmFkaXVzOjE2cHg7YmFja2dyb3VuZDojZmFmYmZjO3BhZGRpbmc6MzBweDt0ZXh0LWFsaWduOmNlbnRlcjt0cmFuc2l0aW9uOi4yc30KLmRyb3AuZHJhZ3tib3JkZXItY29sb3I6IzY2NzA4NTtiYWNrZ3JvdW5kOiNmMmY0Zjd9LmRyb3Agc3Ryb25ne2Rpc3BsYXk6YmxvY2s7bWFyZ2luLWJvdHRvbTo2cHh9LmRyb3Agc21hbGx7Y29sb3I6dmFyKC0tbXV0ZWQpfQouYWN0aW9uc3tkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7ZmxleC13cmFwOndyYXA7bWFyZ2luLXRvcDoxNnB4fQouYnRue2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDojZmZmO2NvbG9yOiMxMTE4Mjc7Ym9yZGVyLXJhZGl1czoxMXB4O3BhZGRpbmc6MTBweCAxNHB4O2ZvbnQtc2l6ZToxM3B4O2ZvbnQtd2VpZ2h0Ojc1MH0KLmJ0bjpob3ZlcntiYWNrZ3JvdW5kOiNmOGZhZmN9LmJ0bi5wcmltYXJ5e2JhY2tncm91bmQ6IzExMTgyNztjb2xvcjojZmZmO2JvcmRlci1jb2xvcjojMTExODI3fS5idG4uc3VjY2Vzc3tiYWNrZ3JvdW5kOnZhcigtLWdyZWVuYmcpO2NvbG9yOnZhcigtLWdyZWVuKTtib3JkZXItY29sb3I6I2FiZWZjNn0uYnRuLmRhbmdlcntjb2xvcjp2YXIoLS1yZWQpfQoucHJvZ3Jlc3N7aGVpZ2h0OjhweDtiYWNrZ3JvdW5kOiNlZWYwZjM7Ym9yZGVyLXJhZGl1czo5OXB4O292ZXJmbG93OmhpZGRlbjttYXJnaW4tdG9wOjE0cHh9LnByb2dyZXNzPmRpdntoZWlnaHQ6MTAwJTtiYWNrZ3JvdW5kOiMxMTE4Mjc7d2lkdGg6MCU7dHJhbnNpdGlvbjouMjVzfQouc3RhdHVze2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW4tdG9wOjhweDtsaW5lLWhlaWdodDoxLjV9Ci5kZXRlY3R7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoNCwxZnIpO2dhcDoxMHB4fQouZGV0ZWN0LWNhcmR7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEzcHg7cGFkZGluZzoxNHB4O2JhY2tncm91bmQ6I2ZmZn0KLmRldGVjdC1jYXJkIGJ7Zm9udC1zaXplOjEzcHh9LmRldGVjdC1jYXJkIHNwYW57ZGlzcGxheTpibG9jaztmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXRlZCk7bWFyZ2luLXRvcDo0cHh9Ci5kZXRlY3QtY2FyZC5va3tiYWNrZ3JvdW5kOnZhcigtLWdyZWVuYmcpO2JvcmRlci1jb2xvcjojYWJlZmM2fS5kZXRlY3QtY2FyZC53YXJue2JhY2tncm91bmQ6dmFyKC0teWVsbG93YmcpO2JvcmRlci1jb2xvcjojZmVkZjg5fQouc3VtbWFyeXtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjE2MHB4IDFmcjtnYXA6OHB4IDE2cHg7Zm9udC1zaXplOjEzcHh9LnN1bW1hcnkgZGl2Om50aC1jaGlsZChvZGQpe2NvbG9yOiM2NjcwODV9Ci5jYWxsb3V0e3BhZGRpbmc6MTVweDtib3JkZXI6MXB4IHNvbGlkICNkMGQ1ZGQ7YmFja2dyb3VuZDojZjhmYWZjO2JvcmRlci1yYWRpdXM6MTRweDtjb2xvcjojNDc1NDY3O2ZvbnQtc2l6ZToxM3B4O2xpbmUtaGVpZ2h0OjEuNTV9LmNhbGxvdXQgc3Ryb25ne2NvbG9yOiMxMTE4Mjd9Ci50YWJsZS13cmFwe292ZXJmbG93OmF1dG87Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHh9dGFibGV7d2lkdGg6MTAwJTtib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7Zm9udC1zaXplOjEzcHh9dGh7YmFja2dyb3VuZDojZjhmYWZjO2NvbG9yOiM0NzU0Njc7dGV4dC1hbGlnbjpsZWZ0O2ZvbnQtc2l6ZToxMnB4fXRoLHRke3BhZGRpbmc6MTJweCAxMHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWxpbmUpO3ZlcnRpY2FsLWFsaWduOnRvcH10cjpsYXN0LWNoaWxkIHRke2JvcmRlci1ib3R0b206MH0KLnBpbGx7ZGlzcGxheTppbmxpbmUtZmxleDtwYWRkaW5nOjVweCA4cHg7Ym9yZGVyLXJhZGl1czo5OTlweDtiYWNrZ3JvdW5kOiNmMmY0Zjc7Y29sb3I6IzM0NDA1NDtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo4MDB9LmdyZWVue2JhY2tncm91bmQ6dmFyKC0tZ3JlZW5iZyk7Y29sb3I6dmFyKC0tZ3JlZW4pfS55ZWxsb3d7YmFja2dyb3VuZDp2YXIoLS15ZWxsb3diZyk7Y29sb3I6dmFyKC0teWVsbG93KX0ucmVke2JhY2tncm91bmQ6dmFyKC0tcmVkYmcpO2NvbG9yOnZhcigtLXJlZCl9LmJsdWV7YmFja2dyb3VuZDp2YXIoLS1ibHVlYmcpO2NvbG9yOnZhcigtLWJsdWUpfQouY2xhaW0sLmRvY3tib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjE1cHg7YmFja2dyb3VuZDojZmZmfS5jbGFpbSsuY2xhaW0sLmRvYysuZG9je21hcmdpbi10b3A6MTBweH0uY2xhaW0gaDQsLmRvYyBoNHttYXJnaW46MCAwIDdweDtmb250LXNpemU6MTRweH0uY2xhaW0gcCwuZG9jIHB7bWFyZ2luOjA7Y29sb3I6IzVmNmI3YTtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU1fQouc3BsaXR7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczptaW5tYXgoMCwxLjE1ZnIpIG1pbm1heCgzMjBweCwuODVmcik7Z2FwOjE4cHh9Ci5yaXNre2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTRweDthbGlnbi1pdGVtczpjZW50ZXI7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoxOHB4fS5yaXNrIGgze21hcmdpbjowIDAgNXB4O2ZvbnQtc2l6ZToxNnB4fS5yaXNrIHB7bWFyZ2luOjA7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxM3B4fS5yaXNrYm94e21pbi13aWR0aDoxNDVweDt0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjEycHg7Ym9yZGVyLXJhZGl1czoxNHB4O2ZvbnQtd2VpZ2h0OjkwMH0KLmRpdmlkZXJ7aGVpZ2h0OjFweDtiYWNrZ3JvdW5kOnZhcigtLWxpbmUpO21hcmdpbjoxOHB4IDB9LmVtcHR5e3BhZGRpbmc6MjZweDtib3JkZXI6MXB4IGRhc2hlZCAjZDBkNWRkO2JvcmRlci1yYWRpdXM6MTRweDt0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjojOThhMmIzfQpjb2Rle2ZvbnQtZmFtaWx5OnVpLW1vbm9zcGFjZSxTRk1vbm8tUmVndWxhcixNZW5sbyxtb25vc3BhY2U7Zm9udC1zaXplOjEycHh9LnJlcG9ydHtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHg7cGFkZGluZzoyNHB4O2xpbmUtaGVpZ2h0OjEuNjV9LnJlcG9ydCBoM3ttYXJnaW4tdG9wOjI0cHh9LnJlcG9ydCBoMzpmaXJzdC1jaGlsZHttYXJnaW4tdG9wOjB9Ci53aXphcmRiYXJ7cG9zaXRpb246Zml4ZWQ7bGVmdDoyNzVweDtyaWdodDowO2JvdHRvbTowO2JhY2tncm91bmQ6cmdiYSgyNDYsMjQ3LDI0OSwuOTQpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWxpbmUpO3BhZGRpbmc6MTNweCAzOHB4O3otaW5kZXg6MjB9Ci53aXphcmRpbm5lcnttYXgtd2lkdGg6MTQwMHB4O21hcmdpbjphdXRvO2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEycHh9Ci53aXphcmRtZXRhe2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dGVkKX0ud2l6YXJkbWV0YSBzdHJvbmd7ZGlzcGxheTpibG9jaztjb2xvcjojMzQ0MDU0O2ZvbnQtc2l6ZToxM3B4O21hcmdpbi1ib3R0b206MnB4fQoubmV4dGJ0bnttaW4td2lkdGg6MTUwcHh9LmJhY2tidG57bWluLXdpZHRoOjEwNXB4fQouaGlkZGVue2Rpc3BsYXk6bm9uZSFpbXBvcnRhbnR9CkBtZWRpYShtYXgtd2lkdGg6OTgwcHgpey5hcHB7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn1hc2lkZXtwb3NpdGlvbjpyZWxhdGl2ZTtoZWlnaHQ6YXV0b30uc2lkZS1ub3Rle3Bvc2l0aW9uOnN0YXRpYzttYXJnaW4tdG9wOjE4cHh9LnByb2Nlc3N7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpfW1haW57cGFkZGluZzoyMnB4IDE2cHggMTIwcHh9LmcyLC5nMywuc3BsaXQsLmRldGVjdHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyfS53aXphcmRiYXJ7bGVmdDowO3BhZGRpbmc6MTJweCAxNnB4fS50b3B7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59fQpAbWVkaWEgcHJpbnR7YXNpZGUsLnRvcCwud2l6YXJkYmFyLC5uby1wcmludCwuYWN0aW9uc3tkaXNwbGF5Om5vbmUhaW1wb3J0YW50fS5hcHB7ZGlzcGxheTpibG9ja31tYWlue3BhZGRpbmc6MH0uc2VjdGlvbntkaXNwbGF5Om5vbmUhaW1wb3J0YW50fSNyZXBvcnQuc2VjdGlvbntkaXNwbGF5OmJsb2NrIWltcG9ydGFudH0ucGFuZWx7Ym9yZGVyOjA7Ym94LXNoYWRvdzpub25lO3BhZGRpbmc6MH1ib2R5e2JhY2tncm91bmQ6I2ZmZn19CgovKiA9PT09PSB2NiBVWCByZWZpbmVtZW50cyA9PT09PSAqLwouY2xhaW0tY2xlYW57CiAgZm9udC1mYW1pbHk6QXJpYWwsIkhlbHZldGljYSBOZXVlIiwiU2Vnb2UgVUkiLHNhbnMtc2VyaWY7CiAgZm9udC1zaXplOjE0cHg7bGluZS1oZWlnaHQ6MS43ODtjb2xvcjojMzQ0MDU0O3doaXRlLXNwYWNlOnByZS13cmFwOwp9Ci5jbGFpbS1yYXd7CiAgZm9udC1mYW1pbHk6dWktbW9ub3NwYWNlLFNGTW9uby1SZWd1bGFyLE1lbmxvLENvbnNvbGFzLG1vbm9zcGFjZSFpbXBvcnRhbnQ7CiAgZm9udC1zaXplOjEycHghaW1wb3J0YW50O2xpbmUtaGVpZ2h0OjEuNiFpbXBvcnRhbnQ7YmFja2dyb3VuZDojZjhmYWZjIWltcG9ydGFudDsKfQouY2xhaW0tc3RlcHsKICBkaXNwbGF5OmJsb2NrO21hcmdpbjo4cHggMDtwYWRkaW5nLWxlZnQ6MTRweDtib3JkZXItbGVmdDoycHggc29saWQgI2U0ZTdlYzsKfQouZmVhdHVyZS1yZXZpZXctYmFyewogIHBvc2l0aW9uOnN0aWNreTt0b3A6MTJweDt6LWluZGV4Ojg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjsKICBnYXA6MTZweDtwYWRkaW5nOjE0cHggMTZweDttYXJnaW46MTZweCAwO2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuOTYpOwogIGJhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpO2JvcmRlcjoxcHggc29saWQgI2QwZDVkZDtib3JkZXItcmFkaXVzOjE0cHg7CiAgYm94LXNoYWRvdzowIDEwcHggMjhweCByZ2JhKDE2LDI0LDQwLC4wOSkKfQouZmVhdHVyZS1yZXZpZXctYmFyIC5tZXRhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEwcHg7ZmxleC13cmFwOndyYXB9Ci5mZWF0dXJlLXJldmlldy1iYXIgc3Ryb25ne2ZvbnQtc2l6ZToxNHB4fS5mZWF0dXJlLXJldmlldy1iYXIgc21hbGx7ZGlzcGxheTpibG9jaztjb2xvcjojNjY3MDg1O21hcmdpbi10b3A6M3B4fQouZmVhdHVyZS1jb25maXJtZWR7Ym9yZGVyLWNvbG9yOiNhYmVmYzY7YmFja2dyb3VuZDpyZ2JhKDIzNiwyNTMsMjQzLC45Nyl9Ci5zZWFyY2gtaGVyb3sKICBwYWRkaW5nOjE3cHg7Ym9yZGVyOjFweCBzb2xpZCAjZDBkNWRkO2JvcmRlci1yYWRpdXM6MTZweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxODBkZWcsI2ZmZiwjZjhmYWZjKTsKICBtYXJnaW4tYm90dG9tOjE2cHgKfQouc291cmNlLXJvd3tkaXNwbGF5OmZsZXg7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5zb3VyY2UtY2hpcHsKICBkaXNwbGF5OmlubGluZS1mbGV4O2dhcDo2cHg7YWxpZ24taXRlbXM6Y2VudGVyO2JvcmRlcjoxcHggc29saWQgI2QwZDVkZDtiYWNrZ3JvdW5kOiNmZmY7CiAgY29sb3I6IzM0NDA1NDtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6N3B4IDEwcHg7Zm9udC1zaXplOjEycHg7dGV4dC1kZWNvcmF0aW9uOm5vbmU7Zm9udC13ZWlnaHQ6NzAwCn0KLnNvdXJjZS1jaGlwOmhvdmVye2JhY2tncm91bmQ6I2YyZjRmN30KLnNlYXJjaC10b29sYmFye2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyIGF1dG87Z2FwOjEwcHg7bWFyZ2luLXRvcDoxNHB4fQouc2VhcmNoLXN0YXRle2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM2NjcwODU7bWFyZ2luLXRvcDoxMHB4O2xpbmUtaGVpZ2h0OjEuNX0KLnNlYXJjaC1yZXN1bHQtdGl0bGV7Zm9udC13ZWlnaHQ6NzUwO2NvbG9yOiMxMDE4Mjg7dGV4dC1kZWNvcmF0aW9uOm5vbmV9LnNlYXJjaC1yZXN1bHQtdGl0bGU6aG92ZXJ7dGV4dC1kZWNvcmF0aW9uOnVuZGVybGluZX0KLnNjb3Jle2ZvbnQtd2VpZ2h0Ojg1MDtmb250LXNpemU6MTNweH0KLnNjb3JlLmhpZ2h7Y29sb3I6IzA2NzY0N30uc2NvcmUubWlke2NvbG9yOiNiNTQ3MDh9LnNjb3JlLmxvd3tjb2xvcjojNjY3MDg1fQouY2FuZGlkYXRlLWFjdGlvbnN7ZGlzcGxheTpmbGV4O2dhcDo2cHg7ZmxleC13cmFwOndyYXB9Ci5zbG90YnRue3BhZGRpbmc6NnB4IDlweDtib3JkZXItcmFkaXVzOjlweDtib3JkZXI6MXB4IHNvbGlkICNkMGQ1ZGQ7YmFja2dyb3VuZDojZmZmO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojc1MH0KLnNsb3RidG46aG92ZXJ7YmFja2dyb3VuZDojZjJmNGY3fQoucHJpb3Itc2xvdHsKICBib3JkZXI6MXB4IHNvbGlkICNlNGU3ZWM7Ym9yZGVyLXJhZGl1czoxNHB4O3BhZGRpbmc6MTRweDtiYWNrZ3JvdW5kOiNmZmYKfQoucHJpb3Itc2xvdC5zZWxlY3RlZHtib3JkZXItY29sb3I6Izg0YWRmZjtib3gtc2hhZG93OjAgMCAwIDNweCAjZWZmOGZmfQouc2V0dGluZ3MtZ3JpZHtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciBhdXRvO2dhcDoxMHB4O2FsaWduLWl0ZW1zOmVuZH0KLmJhY2tlbmQtb2t7Y29sb3I6IzA2NzY0N30uYmFja2VuZC1iYWR7Y29sb3I6I2I0MjMxOH0KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7CiAgLmZlYXR1cmUtcmV2aWV3LWJhcntwb3NpdGlvbjpzdGF0aWM7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmbGV4LWRpcmVjdGlvbjpjb2x1bW59CiAgLnNlYXJjaC10b29sYmFyLC5zZXR0aW5ncy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnJ9Cn0KCjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+CjxkaXYgY2xhc3M9ImFwcCI+Cjxhc2lkZT4KICA8ZGl2IGNsYXNzPSJicmFuZCI+PGRpdiBjbGFzcz0ibG9nbyI+UDwvZGl2PjxkaXY+PHN0cm9uZz5QYXRlbnRMZW5zIEFJPC9zdHJvbmc+PHNtYWxsPlByb3RvdHlwZSBuZ2hpw6puIGPhu6l1IMK3IEZ1bGwtc3RhY2sgdjEwLjAgUHJvPC9zbWFsbD48L2Rpdj48L2Rpdj4KICA8ZGl2IGNsYXNzPSJwcm9jZXNzIiBpZD0icHJvY2VzcyI+PC9kaXY+CiAgPGRpdiBjbGFzcz0ic2lkZS1ub3RlIj48c3Ryb25nIHN0eWxlPSJjb2xvcjojZmZmIj5QaOG6oW0gdmkgcHJvdG90eXBlPC9zdHJvbmc+PGJyLz5I4buXIHRy4bujIGNodeG7l2kgdHJhIGPhu6l1IHbDoCDEkcOhbmggZ2nDoSBzxqEgYuG7mSBzw6FuZyBjaOG6vy4gS2jDtG5nIHRoYXkgdGjhur8gY2h1ecOqbiBnaWEgdsOgIGtow7RuZyDEkeG6oWkgZGnhu4duIHRvw6BuIGLhu5kgcXV5IHRyw6xuaCB4w6FjIGzhuq1wIHF1eeG7gW4gY+G7p2EgSVAgR1JPVVAuPC9kaXY+CjwvYXNpZGU+Cgo8bWFpbj4KICA8ZGl2IGNsYXNzPSJ0b3AiPjxkaXY+PGgxIGlkPSJwYWdlVGl0bGUiPjwvaDE+PHAgaWQ9InBhZ2VTdWIiPjwvcD48L2Rpdj48ZGl2IGNsYXNzPSJjYXNlLWJhZGdlIiBpZD0iY2FzZUJhZGdlIj5DaMawYSBjw7MgY2FzZTwvZGl2PjwvZGl2PgogIDxkaXYgY2xhc3M9ImxvY2FsLWJhbm5lciIgaWQ9ImxvY2FsQmFubmVyIiBzdHlsZT0iZGlzcGxheTpub25lIj5C4bqhbiDEkWFuZyBt4bufIGLhurFuZyA8c3Ryb25nPmZpbGU6Ly88L3N0cm9uZz4uIENocm9tZSBjw7MgdGjhu4MgY2jhurduIFdlYiBXb3JrZXIgZMO5bmcgY2hvIE9DUi4gQuG6o24gbsOgeSB24bqrbiBj4buRIMSR4buNYyBQREYgYuG6sW5nIHRleHQgbGF5ZXI7IMSR4buDIE9DUiDhu5VuIMSR4buLbmgsIG7Dqm4gY2jhuqF5IGLhurFuZyA8c3Ryb25nPkdpdEh1YiBQYWdlczwvc3Ryb25nPiBob+G6t2MgbG9jYWwgc2VydmVyICh2w60gZOG7pSA8Y29kZT5weXRob24zIC1tIGh0dHAuc2VydmVyPC9jb2RlPikuPC9kaXY+CgogIDxzZWN0aW9uIGlkPSJpbnRha2UiIGNsYXNzPSJzZWN0aW9uIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPjEuIFThuqNpIHTDoGkgbGnhu4d1IHPDoW5nIGNo4bq/PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5I4buHIHRo4buRbmcgdOG7sSDEkeG7jWMgUERGLiBO4bq/dSBmaWxlIGPDsyB0ZXh0IGxheWVyIHPhur0gdHLDrWNoIHRy4buxYyB0aeG6v3A7IG7hur91IGzDoCBi4bqjbiBzY2FuLCBo4buHIHRo4buRbmcgdOG7sSBjaHV54buDbiBzYW5nIE9DUiDEkeG7gyBj4buRIGfhuq9uZyBuaOG6rW4gZGnhu4duIG1ldGFkYXRhIHbDoCB5w6p1IGPhuqd1IGLhuqNvIGjhu5kuPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImRyb3AiIGlkPSJkcm9wWm9uZSI+CiAgICAgICAgPHN0cm9uZz5UaOG6oyBQREYgdsOgbyDEkcOieSBob+G6t2MgY2jhu41uIGZpbGU8L3N0cm9uZz4KICAgICAgICA8c21hbGw+SOG7lyB0cuG7oyBQREYgcGF0ZW50IHRp4bq/bmcgVmnhu4d0L0FuaC4gT0NSIGPDsyB0aOG7gyBt4bqldCB2w6BpIHBow7p0IHbhu5tpIGLhuqNuIHNjYW4uPC9zbWFsbD48YnIvPjxici8+CiAgICAgICAgPGlucHV0IGlkPSJwZGZJbnB1dCIgdHlwZT0iZmlsZSIgYWNjZXB0PSJhcHBsaWNhdGlvbi9wZGYiIHN0eWxlPSJtYXgtd2lkdGg6NDIwcHgiLz4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InByb2dyZXNzIj48ZGl2IGlkPSJwcm9ncmVzc0JhciI+PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0YXR1cyIgaWQ9InBkZlN0YXR1cyI+Q2jGsGEgY8OzIGZpbGUuPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj5L4bq/dCBxdeG6oyBuaOG6rW4gZGnhu4duIHThu7EgxJHhu5luZzwvaDI+CiAgICAgIDxkaXYgY2xhc3M9ImRldGVjdCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZGV0ZWN0LWNhcmQiIGlkPSJkZXRNZXRhIj48Yj5NZXRhZGF0YTwvYj48c3Bhbj5DaMawYSB44butIGzDvTwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJkZXRlY3QtY2FyZCIgaWQ9ImRldEFic3RyYWN0Ij48Yj5Uw7NtIHThuq90PC9iPjxzcGFuPkNoxrBhIHjhu60gbMO9PC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImRldGVjdC1jYXJkIiBpZD0iZGV0Q2xhaW1zIj48Yj5Zw6p1IGPhuqd1IGLhuqNvIGjhu5k8L2I+PHNwYW4+Q2jGsGEgeOG7rSBsw708L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZGV0ZWN0LWNhcmQiIGlkPSJkZXRPQ1IiPjxiPk9DUjwvYj48c3Bhbj5DaMawYSBj4bqnbjwvc3Bhbj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KCiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj5UaMO0bmcgdGluIHPDoW5nIGNo4bq/PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5Dw6FjIHRyxrDhu51uZyDEkcaw4bujYyB04buxIMSRaeG7gW4gdOG7qyBQREY7IG5nxrDhu51pIGTDuW5nIGPDsyB0aOG7gyBz4butYSBu4bq/dSBuaOG6rW4gZGnhu4duIHNhaS48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMyI+CiAgICAgICAgPGRpdj48bGFiZWw+TcOjIGNhc2U8L2xhYmVsPjxpbnB1dCBpZD0iY2FzZUlkIi8+PC9kaXY+CiAgICAgICAgPGRpdj48bGFiZWw+U+G7kSBi4bqxbmcgLyBz4buRIGPDtG5nIGLhu5E8L2xhYmVsPjxpbnB1dCBpZD0icGF0ZW50Tm8iLz48L2Rpdj4KICAgICAgICA8ZGl2PjxsYWJlbD5RdeG7kWMgZ2lhIC8gaOG7hyB0aOG7kW5nPC9sYWJlbD48c2VsZWN0IGlkPSJqdXJpc2RpY3Rpb24iPjxvcHRpb24+Vk48L29wdGlvbj48b3B0aW9uPlVTPC9vcHRpb24+PG9wdGlvbj5XTy9QQ1Q8L29wdGlvbj48b3B0aW9uPkVQPC9vcHRpb24+PG9wdGlvbj5LaMOhYzwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiIgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgPGRpdj48bGFiZWw+VMOqbiBzw6FuZyBjaOG6vzwvbGFiZWw+PGlucHV0IGlkPSJ0aXRsZSIvPjwvZGl2PgogICAgICAgIDxkaXY+PGxhYmVsPk5nw6B5IG7hu5lwIMSRxqFuIC8gbmfDoHkgxrB1IHRpw6puPC9sYWJlbD48aW5wdXQgaWQ9ImZpbGluZ0RhdGUiIHR5cGU9ImRhdGUiLz48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZzIiIHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPgogICAgICAgIDxkaXY+PGxhYmVsPkNo4bunIMSRxqFuIC8gY2jhu6cgYuG6sW5nPC9sYWJlbD48aW5wdXQgaWQ9ImFwcGxpY2FudCIvPjwvZGl2PgogICAgICAgIDxkaXY+PGxhYmVsPsSQ4bqhaSBkaeG7h24gU0hUVDwvbGFiZWw+PGlucHV0IGlkPSJyZXByZXNlbnRhdGl2ZSIvPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij48bGFiZWw+SVBDIC8gQ1BDPC9sYWJlbD48aW5wdXQgaWQ9ImlwYyIvPjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxsYWJlbD5Uw7NtIHThuq90PC9sYWJlbD48dGV4dGFyZWEgaWQ9ImFic3RyYWN0Ij48L3RleHRhcmVhPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIG5vLXByaW50Ij48YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9InJldHJ5T0NSIj5U4buxIHF1w6l0IE9DUiB5w6p1IGPhuqd1IGLhuqNvIGjhu5k8L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJsb2FkRGVtbyI+TuG6oXAgZGVtbyBQSC1WTi0wMTwvYnV0dG9uPjwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgoKICA8c2VjdGlvbiBpZD0iY2xhaW1zIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj4yLiBYw6FjIMSR4buLbmggecOqdSBj4bqndSBi4bqjbyBo4buZPC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5I4buHIHRo4buRbmcgbMOgbSBz4bqhY2ggdsSDbiBi4bqjbiBPQ1IgdHLGsOG7m2Mga2hpIGhp4buDbiB0aOG7iy4gQuG6o24gT0NSIHRow7QgduG6q24gxJHGsOG7o2MgZ2nhu68gxJHhu4MgxJHhu5FpIGNoaeG6v3Uga2hpIGPhuqduLjwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic3BsaXQiPgogICAgICAgIDxkaXY+CiAgICAgICAgICA8bGFiZWw+QuG6o24gecOqdSBj4bqndSBi4bqjbyBo4buZIMSRw6MgY2h14bqpbiBow7NhPC9sYWJlbD4KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0iY2xhaW1zQ2xlYW4iIGNsYXNzPSJjbGFpbS1jbGVhbiIgc3R5bGU9Im1pbi1oZWlnaHQ6MzkwcHgiIHBsYWNlaG9sZGVyPSJO4buZaSBkdW5nIGNsYWltcyDEkcOjIGzDoG0gc+G6oWNoIHPhur0gaGnhu4NuIHRo4buLIHThuqFpIMSRw6J5LiI+PC90ZXh0YXJlYT4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9InBhcnNlQ2xhaW1zIj5DaHXhuqluIGjDs2EgJiB0w6FjaCBs4bqhaSBjbGFpbXM8L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0ib2NyQ2xhaW1zQWdhaW4iPlThu7EgcXXDqXQgT0NSIGNsYWltczwvYnV0dG9uPgogICAgICAgICAgPC9kaXY+CgogICAgICAgICAgPGRldGFpbHMgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+CiAgICAgICAgICAgIDxzdW1tYXJ5IHN0eWxlPSJjdXJzb3I6cG9pbnRlcjtmb250LXNpemU6MTJweDtjb2xvcjojNjY3MDg1Ij5YZW0gYuG6o24gT0NSIHRow7QgLyBjaOG7iW5oIHRheTwvc3VtbWFyeT4KICAgICAgICAgICAgPHRleHRhcmVhIGlkPSJjbGFpbXNSYXciIGNsYXNzPSJjbGFpbS1yYXciIHN0eWxlPSJtaW4taGVpZ2h0OjIzMHB4O21hcmdpbi10b3A6MTBweCIgcGxhY2Vob2xkZXI9IkLhuqNuIE9DUiB0aMO0LiI+PC90ZXh0YXJlYT4KICAgICAgICAgIDwvZGV0YWlscz4KICAgICAgICA8L2Rpdj4KCiAgICAgICAgPGRpdj4KICAgICAgICAgIDxsYWJlbD5EYW5oIHPDoWNoIGNsYWltczwvbGFiZWw+CiAgICAgICAgICA8ZGl2IGlkPSJjbGFpbUxpc3QiIGNsYXNzPSJlbXB0eSI+Q2jGsGEgY8OzIGNsYWltLjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9ImZlYXR1cmVzIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj4zLiBQaMOibiB0w61jaCBk4bqldSBoaeG7h3Uga+G7uSB0aHXhuq10PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj5Uw6FjaCBjbGFpbSDEkcOjIGNo4buNbiB0aMOgbmggdOG7q25nIGThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQgxJHhu4MgcGjhu6VjIHbhu6UgdHJhIGPhu6l1IHbDoCBs4bqtcCBi4bqjbmcgc28gc8OhbmguIELhu5kgZOG6pXUgaGnhu4d1IMSRxrDhu6NjIHBow6lwIGNo4buJbmggc+G7rWEgdHLGsOG7m2Mga2hpIHjDoWMgbmjhuq1uLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGcyIj48ZGl2PjxsYWJlbD5DbGFpbSBj4bqnbiBwaMOibiB0w61jaDwvbGFiZWw+PHNlbGVjdCBpZD0iY2xhaW1TZWxlY3QiPjwvc2VsZWN0PjwvZGl2PjxkaXY+PGxhYmVsPlRy4bqhbmcgdGjDoWk8L2xhYmVsPjxpbnB1dCBpZD0iZmVhdHVyZVN0YXR1cyIgdmFsdWU9IkNoxrBhIHThuqFvIiByZWFkb25seS8+PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZlYXR1cmUtcmV2aWV3LWJhciIgaWQ9ImZlYXR1cmVSZXZpZXdCYXIiPgogICAgICAgIDxkaXYgY2xhc3M9Im1ldGEiPgogICAgICAgICAgPHNwYW4gY2xhc3M9InBpbGwgeWVsbG93IiBpZD0iZmVhdHVyZVN0YXR1c0JhZGdlIj5DaMawYSB4w6FjIG5o4bqtbjwvc3Bhbj4KICAgICAgICAgIDxkaXY+PHN0cm9uZyBpZD0iZmVhdHVyZUNvdW50TGFiZWwiPkNoxrBhIGPDsyBk4bqldSBoaeG7h3U8L3N0cm9uZz48c21hbGw+S2nhu4NtIHRyYSBu4buZaSBkdW5nIHRyxrDhu5tjIGtoaSBraMOzYSBi4buZIGThuqV1IGhp4buHdSDEkeG7gyB0cmEgY+G7qXUuPC9zbWFsbD48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIiBzdHlsZT0ibWFyZ2luLXRvcDowIj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9ImF1dG9GZWF0dXJlcyI+VOG6oW8gLyB0w6FjaCBs4bqhaTwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJjb25maXJtRmVhdHVyZXMiPuKckyBYw6FjIG5o4bqtbiBi4buZIGThuqV1IGhp4buHdTwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCIgc3R5bGU9Im1hcmdpbi10b3A6MThweCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPk3DozwvdGg+PHRoPkThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQ8L3RoPjx0aD5OaMOzbTwvdGg+PHRoPsSQ4buZIHRpbiBj4bqteTwvdGg+PHRoPjwvdGg+PC90cj48L3RoZWFkPjx0Ym9keSBpZD0iZmVhdHVyZUJvZHkiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9InNlYXJjaCIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+NC4gWMOieSBk4buxbmcgY2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdTwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN1YiI+VOG7qyBi4buZIGThuqV1IGhp4buHdSDEkcOjIHjDoWMgbmjhuq1uLCBo4buHIHRo4buRbmcgc2luaCB04burIGtow7NhIHbDoCBjw6J1IGzhu4duaCBzxqEgYuG7mS4gxJDDonkgbMOgIGLGsOG7m2MgaOG7lyB0cuG7oyBjaHV5w6puIGdpYSB4w6J5IGThu7FuZyB2w6AgbOG6t3AgbOG6oWkgY2hp4bq/biBsxrDhu6NjIHRyYSBj4bupdS48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+PGJ1dHRvbiBjbGFzcz0iYnRuIHByaW1hcnkiIGlkPSJnZW5TZWFyY2giPlThuqFvIGNoaeG6v24gbMaw4bujYyB0cmEgY+G7qXU8L2J1dHRvbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCIgc3R5bGU9Im1hcmdpbi10b3A6MThweCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPkZlYXR1cmU8L3RoPjx0aD5U4burIGtow7NhIGNow61uaDwvdGg+PHRoPkJp4bq/biB0aOG7gyAvIHN5bm9ueW08L3RoPjx0aD5JUEMvQ1BDIGfhu6NpIMO9PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5IGlkPSJzZWFyY2hCb2R5Ij48L3Rib2R5PjwvdGFibGU+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImRpdmlkZXIiPjwvZGl2PjxsYWJlbD5Dw6J1IGzhu4duaCBn4bujaSDDvTwvbGFiZWw+PGRpdiBpZD0icXVlcnlMaXN0IiBjbGFzcz0iZ3JpZCI+PC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CgogIDxzZWN0aW9uIGlkPSJwcmlvciIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+NS4gVMOsbSAmIHPDoG5nIGzhu41jIHTDoGkgbGnhu4d1IMSR4buRaSBjaOG7qW5nPC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj4KICAgICAgICBI4buHIHRo4buRbmcgdOG6oW8gdHJ1eSB24bqlbiB04burIGLhu5kgZOG6pXUgaGnhu4d1LCB0w6xtIHBhdGVudCB0aOG6rXQgcXVhIGJhY2tlbmQgR29vZ2xlIFBhdGVudHMsIHjhur9wIGjhuqFuZyB0aGVvIMSR4buZIGxpw6puIHF1YW4gdsOgIMSRaeG7gXUga2nhu4duIHRo4budaSBnaWFuLAogICAgICAgIHNhdSDEkcOzIGNobyBwaMOpcCBjaOG7jW4gdHLhu7FjIHRp4bq/cCBEMeKAk0QzLiBXSVBPIFBBVEVOVFNDT1BFIHbDoCBFc3BhY2VuZXQgxJHGsOG7o2MgZMO5bmcgbMOgbSBuZ3Xhu5NuIGtp4buDbSBjaOG7qW5nIGLhu5Ugc3VuZy4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtaGVybyI+CiAgICAgICAgPGRpdiBjbGFzcz0ic291cmNlLXJvdyI+CiAgICAgICAgICA8c3Ryb25nIHN0eWxlPSJmb250LXNpemU6MTNweCI+Tmd14buTbiB0cmEgY+G7qXU6PC9zdHJvbmc+CiAgICAgICAgICA8YSBjbGFzcz0ic291cmNlLWNoaXAiIGlkPSJncExpbmsiIGhyZWY9Imh0dHBzOi8vcGF0ZW50cy5nb29nbGUuY29tLyIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPkdvb2dsZSBQYXRlbnRzIOKGlzwvYT4KICAgICAgICAgIDxhIGNsYXNzPSJzb3VyY2UtY2hpcCIgaWQ9IndpcG9MaW5rIiBocmVmPSJodHRwczovL3BhdGVudHNjb3BlLndpcG8uaW50LyIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPldJUE8gUEFURU5UU0NPUEUg4oaXPC9hPgogICAgICAgICAgPGEgY2xhc3M9InNvdXJjZS1jaGlwIiBpZD0iZXBvTGluayIgaHJlZj0iaHR0cHM6Ly93b3JsZHdpZGUuZXNwYWNlbmV0LmNvbS8iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIj5FUE8gRXNwYWNlbmV0IOKGlzwvYT4KICAgICAgICA8L2Rpdj4KCiAgICAgICAgPGRpdiBjbGFzcz0ic2VhcmNoLXRvb2xiYXIiPgogICAgICAgICAgPGlucHV0IGlkPSJsaXZlU2VhcmNoUXVlcnkiIHBsYWNlaG9sZGVyPSdWw60gZOG7pTogImRyYWdvbiBmcnVpdCBzZWVkIiBjZWxsdWxhc2UgcGVjdGluYXNlJz4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0ibGl2ZVNlYXJjaEJ0biI+4oyVIFTDrG0gdMOgaSBsaeG7h3UgdGjhuq10PC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ic2VhcmNoLXN0YXRlIiBpZD0ibGl2ZVNlYXJjaFN0YXRlIj5DaMawYSBjaOG6oXkgdHJhIGPhu6l1LjwvZGl2PgoKICAgICAgICA8ZGl2IGNsYXNzPSJjYWxsb3V0IiBzdHlsZT0ibWFyZ2luLXRvcDoxM3B4Ij4KICAgICAgPHN0cm9uZz5CYWNrZW5kIHTDrWNoIGjhu6NwIGPDuW5nIHdlYnNpdGU8L3N0cm9uZz48YnI+CiAgICAgIELhuqNuIGZ1bGwtc3RhY2sgc+G7rSBk4bulbmcgQVBJIGPDuW5nIGRvbWFpbiAoPGNvZGU+L2FwaS8qPC9jb2RlPiksIG7Dqm4ga2jDtG5nIGPhuqduIG5o4bqtcCBXb3JrZXIgVVJMIHJpw6puZy4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyIgc3R5bGU9Im1hcmdpbi10b3A6MTBweCI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0idGVzdEJhY2tlbmQiPktp4buDbSB0cmEgYmFja2VuZDwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RhdHVzIiBpZD0iYmFja2VuZFN0YXR1cyI+Q2jGsGEga2nhu4NtIHRyYSBr4bq/dCBu4buRaS48L2Rpdj4KICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9InVzZUJlc3RRdWVyeSI+RMO5bmcgdHJ1eSB24bqlbiB04burIGLGsOG7m2MgNDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBzdWNjZXNzIiBpZD0iYXV0b1BpY2tQcmlvciI+VOG7sSBn4bujaSDDvSBEMeKAk0QzPC9idXR0b24+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCIgc3R5bGU9Im1hcmdpbi10b3A6MTZweCI+CiAgICAgICAgPHRhYmxlPgogICAgICAgICAgPHRoZWFkPgogICAgICAgICAgICA8dHI+CiAgICAgICAgICAgICAgPHRoPiM8L3RoPjx0aD5Uw6BpIGxp4buHdSB0aOG6rXQ8L3RoPjx0aD5OZ8OgeTwvdGg+PHRoPsSQ4buZIHBow7kgaOG7o3A8L3RoPjx0aD7EkGnhu4F1IGtp4buHbiB0aOG7nWkgZ2lhbjwvdGg+PHRoPkNo4buNbjwvdGg+CiAgICAgICAgICAgIDwvdHI+CiAgICAgICAgICA8L3RoZWFkPgogICAgICAgICAgPHRib2R5IGlkPSJjYW5kaWRhdGVCb2R5Ij4KICAgICAgICAgICAgPHRyPjx0ZCBjb2xzcGFuPSI2IiBzdHlsZT0iY29sb3I6Izk4YTJiMzt0ZXh0LWFsaWduOmNlbnRlciI+Q2jGsGEgY8OzIGvhur90IHF14bqjIHRyYSBj4bupdS48L3RkPjwvdHI+CiAgICAgICAgICA8L3Rib2R5PgogICAgICAgIDwvdGFibGU+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+RDHigJNEMyDEkcaw4bujYyBjaOG7jW48L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPktoaSBjaOG7jW4gbeG7mXQga+G6v3QgcXXhuqMsIGjhu4cgdGjhu5FuZyB04buxIGzhuqV5IG1ldGFkYXRhIHbDoCBu4buZaSBkdW5nIHBhdGVudCDEkeG7gyDEkWnhu4FuIHbDoG8gc2xvdCB0xrDGoW5nIOG7qW5nLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJncmlkIGczIj4KICAgICAgICA8ZGl2IGNsYXNzPSJwcmlvci1zbG90IiBpZD0ic2xvdEQxIj4KICAgICAgICAgIDxoND5EMSDCtyDhu6huZyB2acOqbiDEkeG7kWkgY2jhu6luZyBn4bqnbiBuaOG6pXQ8L2g0PgogICAgICAgICAgPGlucHV0IGlkPSJkMU5vIiBwbGFjZWhvbGRlcj0iU+G7kSBjw7RuZyBi4buRIj4KICAgICAgICAgIDxpbnB1dCBpZD0iZDFEYXRlIiB0eXBlPSJkYXRlIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgICAgPGlucHV0IGlkPSJkMVVybCIgcGxhY2Vob2xkZXI9IlVSTCBuZ3Xhu5NuIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHgiPgogICAgICAgICAgPHRleHRhcmVhIGlkPSJkMVRleHQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweDttaW4taGVpZ2h0OjE5MHB4IiBwbGFjZWhvbGRlcj0iQWJzdHJhY3QgLyBjbGFpbXMgLyBzbmlwcGV0IHPhur0gxJHGsOG7o2MgdOG7sSDEkWnhu4FuLi4uIj48L3RleHRhcmVhPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InByaW9yLXNsb3QiIGlkPSJzbG90RDIiPgogICAgICAgICAgPGg0PkQyIMK3IFTDoGkgbGnhu4d1IGLhu5Ugc3VuZzwvaDQ+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQyTm8iIHBsYWNlaG9sZGVyPSJT4buRIGPDtG5nIGLhu5EiPgogICAgICAgICAgPGlucHV0IGlkPSJkMkRhdGUiIHR5cGU9ImRhdGUiIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQyVXJsIiBwbGFjZWhvbGRlcj0iVVJMIG5ndeG7k24iIHN0eWxlPSJtYXJnaW4tdG9wOjhweCI+CiAgICAgICAgICA8dGV4dGFyZWEgaWQ9ImQyVGV4dCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4O21pbi1oZWlnaHQ6MTkwcHgiIHBsYWNlaG9sZGVyPSJBYnN0cmFjdCAvIGNsYWltcyAvIHNuaXBwZXQgc+G6vSDEkcaw4bujYyB04buxIMSRaeG7gW4uLi4iPjwvdGV4dGFyZWE+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icHJpb3Itc2xvdCIgaWQ9InNsb3REMyI+CiAgICAgICAgICA8aDQ+RDMgwrcgVMOgaSBsaeG7h3UgYuG7lSBzdW5nPC9oND4KICAgICAgICAgIDxpbnB1dCBpZD0iZDNObyIgcGxhY2Vob2xkZXI9IlPhu5EgY8O0bmcgYuG7kSI+CiAgICAgICAgICA8aW5wdXQgaWQ9ImQzRGF0ZSIgdHlwZT0iZGF0ZSIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICAgIDxpbnB1dCBpZD0iZDNVcmwiIHBsYWNlaG9sZGVyPSJVUkwgbmd14buTbiIgc3R5bGU9Im1hcmdpbi10b3A6OHB4Ij4KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0iZDNUZXh0IiBzdHlsZT0ibWFyZ2luLXRvcDo4cHg7bWluLWhlaWdodDoxOTBweCIgcGxhY2Vob2xkZXI9IkFic3RyYWN0IC8gY2xhaW1zIC8gc25pcHBldCBz4bq9IMSRxrDhu6NjIHThu7EgxJFp4buBbi4uLiI+PC90ZXh0YXJlYT4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIj48YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9InZhbGlkYXRlUHJpb3IiPktp4buDbSB0cmEgxJFp4buBdSBraeG7h24gdGjhu51pIGdpYW48L2J1dHRvbj48L2Rpdj4KICAgICAgPGRpdiBpZD0icHJpb3JDaGVjayIgY2xhc3M9ImNhbGxvdXQiIHN0eWxlPSJtYXJnaW4tdG9wOjE2cHgiPjxzdHJvbmc+TMawdSDDvTo8L3N0cm9uZz4gbmfDoHkgdsOgIG7hu5lpIGR1bmcgduG6q24gY+G6p24gY2h1ecOqbiBnaWEga2nhu4NtIGNo4bupbmcgdHLDqm4gdMOgaSBsaeG7h3UgZ+G7kWMuPC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CgogIDxzZWN0aW9uIGlkPSJjb21wYXJlIiBjbGFzcz0ic2VjdGlvbiI+CiAgICA8ZGl2IGNsYXNzPSJwYW5lbCI+CiAgICAgIDxoMj42LiBM4bqtcCBi4bqjbmcgc28gc8OhbmggZOG6pXUgaGnhu4d1PC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIj7EkOG7kWkgY2hp4bq/dSB04burbmcgZOG6pXUgaGnhu4d1IHbhu5tpIHThu6tuZyB0w6BpIGxp4buHdS4gTuG6v3UgY2jGsGEgY8OzIGLhurFuZyBjaOG7qW5nIMSR4bunIHLDtSwgaOG7hyB0aOG7kW5nIHBo4bqjaSB0cuG6oyB24buBIOKAnENoxrBhIGNo4bqvYyBjaOG6r27igJ0uPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0iYnVpbGRNYXRyaXgiPlThuqFvIG1hIHRy4bqtbiDEkeG7kWkgY2hp4bq/dTwvYnV0dG9uPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIiBzdHlsZT0ibWFyZ2luLXRvcDoxOHB4Ij48dGFibGU+PHRoZWFkPjx0cj48dGg+RmVhdHVyZTwvdGg+PHRoPkQxPC90aD48dGg+RDI8L3RoPjx0aD5EMzwvdGg+PHRoPkLhurFuZyBjaOG7qW5nIC8gZ2hpIGNow7o8L3RoPjwvdHI+PC90aGVhZD48dGJvZHkgaWQ9Im1hdHJpeEJvZHkiPjwvdGJvZHk+PC90YWJsZT48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9ImFzc2VzcyIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+Ny4gxJDDoW5oIGdpw6Egc8ahIGLhu5k8L2gyPgogICAgICA8ZGl2IGNsYXNzPSJzdWIiPsSQw6FuaCBnacOhIHRoZW8gdOG7q25nIGNsYWltIHbDoCB04bqtcCB0w6BpIGxp4buHdSDEkWFuZyBraOG6o28gc8OhdDsga2jDtG5nIHBo4bqjaSBr4bq/dCBsdeG6rW4gY+G6pXAgYuG6sW5nLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyaXNrIj48ZGl2PjxoMz5Uw61uaCBt4bubaTwvaDM+PHAgaWQ9Im5vdmVsdHlUZXh0Ij5DaMawYSDEkcOhbmggZ2nDoS48L3A+PC9kaXY+PGRpdiBjbGFzcz0icmlza2JveCB5ZWxsb3ciIGlkPSJub3ZlbHR5UmlzayI+Q0jhu5wgROG7riBMSeG7hlU8L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0iaGVpZ2h0OjEycHgiPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJyaXNrIj48ZGl2PjxoMz5UcsOsbmggxJHhu5kgc8OhbmcgdOG6oW88L2gzPjxwIGlkPSJpbnZlbnRpdmVUZXh0Ij5DaMawYSDEkcOhbmggZ2nDoS48L3A+PC9kaXY+PGRpdiBjbGFzcz0icmlza2JveCB5ZWxsb3ciIGlkPSJpbnZlbnRpdmVSaXNrIj5DSOG7nCBE4buuIExJ4buGVTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJkaXZpZGVyIj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBnMiI+PGRpdj48bGFiZWw+xJDhu5FpIGNo4bupbmcgZ+G6p24gbmjhuqV0PC9sYWJlbD48c2VsZWN0IGlkPSJjbG9zZXN0Ij48b3B0aW9uPkQxPC9vcHRpb24+PG9wdGlvbj5EMjwvb3B0aW9uPjxvcHRpb24+RDM8L29wdGlvbj48L3NlbGVjdD48L2Rpdj48ZGl2PjxsYWJlbD5E4bqldSBoaeG7h3Uga2jDoWMgYmnhu4d0PC9sYWJlbD48dGV4dGFyZWEgaWQ9ImRpZmZlcmVuY2VzIj48L3RleHRhcmVhPjwvZGl2PjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPjxsYWJlbD5W4bqlbiDEkeG7gSBr4bu5IHRodeG6rXQga2jDoWNoIHF1YW48L2xhYmVsPjx0ZXh0YXJlYSBpZD0icHJvYmxlbSI+PC90ZXh0YXJlYT48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij48bGFiZWw+TOG6rXAgbHXhuq1uIHPGoSBi4buZIHbhu4EgdMOtbmggaGnhu4NuIG5oacOqbjwvbGFiZWw+PHRleHRhcmVhIGlkPSJyZWFzb25pbmciPjwvdGV4dGFyZWE+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0icnVuQXNzZXNzbWVudCI+Q2jhuqF5IMSRw6FuaCBnacOhIHPGoSBi4buZPC9idXR0b24+PC9kaXY+CiAgICA8L2Rpdj4KICA8L3NlY3Rpb24+CgogIDxzZWN0aW9uIGlkPSJleHBlcnQiIGNsYXNzPSJzZWN0aW9uIj4KICAgIDxkaXYgY2xhc3M9InBhbmVsIj4KICAgICAgPGgyPjguIENodXnDqm4gZ2lhIHLDoCBzb8OhdDwvaDI+CiAgICAgIDxkaXYgY2xhc3M9InN1YiI+Q2h1ecOqbiBnaWEgeMOhYyBuaOG6rW4vY2jhu4luaCBz4butYS9iw6FjIGLhu48gdOG7q25nIMSR4bqndSByYS4gxJDDonkgbMOgIGNoZWNrcG9pbnQgYuG6r3QgYnXhu5ljIGPhu6dhIG3DtCBow6xuaCBIdW1hbi1pbi10aGUtbG9vcC48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCI+PHRhYmxlPjx0aGVhZD48dHI+PHRoPkjhuqFuZyBt4bulYzwvdGg+PHRoPkvhur90IHF14bqjIGjhu4cgdGjhu5FuZzwvdGg+PHRoPlF1eeG6v3QgxJHhu4tuaCBjaHV5w6puIGdpYTwvdGg+PHRoPk5o4bqtbiB4w6l0PC90aD48L3RyPjwvdGhlYWQ+PHRib2R5IGlkPSJleHBlcnRCb2R5Ij48L3Rib2R5PjwvdGFibGU+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImFjdGlvbnMiPjxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IiBpZD0ic2F2ZVJldmlldyI+TMawdSByw6Agc2/DoXQ8L2J1dHRvbj48L2Rpdj4KICAgIDwvZGl2PgogIDwvc2VjdGlvbj4KCiAgPHNlY3Rpb24gaWQ9InJlcG9ydCIgY2xhc3M9InNlY3Rpb24iPgogICAgPGRpdiBjbGFzcz0icGFuZWwiPgogICAgICA8aDI+OS4gQsOhbyBjw6FvIHBow6JuIHTDrWNoIHPGoSBi4buZPC9oMj4KICAgICAgPGRpdiBjbGFzcz0ic3ViIG5vLXByaW50Ij5U4buVbmcgaOG7o3AgZOG7ryBsaeG7h3UgdOG7qyB0b8OgbiBi4buZIHBpcGVsaW5lLjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJhY3Rpb25zIG5vLXByaW50Ij48YnV0dG9uIGNsYXNzPSJidG4gcHJpbWFyeSIgaWQ9ImdlblJlcG9ydCI+VOG6oW8gYsOhbyBjw6FvPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0iYnRuIiBvbmNsaWNrPSJ3aW5kb3cucHJpbnQoKSI+SW4gLyBMxrB1IFBERjwvYnV0dG9uPjwvZGl2PgogICAgICA8ZGl2IGlkPSJyZXBvcnRDb250ZW50IiBjbGFzcz0icmVwb3J0Ij48ZGl2IGNsYXNzPSJlbXB0eSI+Q2jGsGEgdOG6oW8gYsOhbyBjw6FvLjwvZGl2PjwvZGl2PgogICAgPC9kaXY+CiAgPC9zZWN0aW9uPgo8L21haW4+CjwvZGl2PgoKPGRpdiBjbGFzcz0id2l6YXJkYmFyIG5vLXByaW50Ij4KICA8ZGl2IGNsYXNzPSJ3aXphcmRpbm5lciI+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gYmFja2J0biIgaWQ9ImJhY2tCdG4iPuKGkCBRdWF5IGzhuqFpPC9idXR0b24+CiAgICA8ZGl2IGNsYXNzPSJ3aXphcmRtZXRhIj48c3Ryb25nIGlkPSJ3aXphcmRUaXRsZSI+PC9zdHJvbmc+PHNwYW4gaWQ9IndpemFyZEhpbnQiPjwvc3Bhbj48L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biBwcmltYXJ5IG5leHRidG4iIGlkPSJuZXh0QnRuIj5UaeG6v3AgdOG7pWMg4oaSPC9idXR0b24+CiAgPC9kaXY+CjwvZGl2PgoKPHNjcmlwdD4KY29uc3QgU1RFUFM9WwogIHtpZDoiaW50YWtlIix0aXRsZToiVGnhur9wIG5o4bqtbiBo4buTIHPGoSIsaGludDoiVOG6o2kgUERGIHbDoCBraeG7g20gdHJhIGThu68gbGnhu4d1IHThu7EgxJHhu5luZyB0csOtY2ggeHXhuqV0LiJ9LAogIHtpZDoiY2xhaW1zIix0aXRsZToiWcOqdSBj4bqndSBi4bqjbyBo4buZIixoaW50OiJDaOG7jW4gY2xhaW0gY+G6p24gcGjDom4gdMOtY2guIn0sCiAge2lkOiJmZWF0dXJlcyIsdGl0bGU6IkThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQiLGhpbnQ6IlTDoWNoIHbDoCB4w6FjIG5o4bqtbiBmZWF0dXJlIHNldC4ifSwKICB7aWQ6InNlYXJjaCIsdGl0bGU6IkNoaeG6v24gbMaw4bujYyB0cmEgY+G7qXUiLGhpbnQ6IlNpbmgga2V5d29yZC9JUEMvcXVlcnkuIn0sCiAge2lkOiJwcmlvciIsdGl0bGU6IlTDoGkgbGnhu4d1IMSR4buRaSBjaOG7qW5nIixoaW50OiJOaOG6rXAva2nhu4NtIHRyYSBwcmlvciBhcnQuIn0sCiAge2lkOiJjb21wYXJlIix0aXRsZToiQuG6o25nIHNvIHPDoW5oIixoaW50OiJNYXAgZmVhdHVyZSB24bubaSBldmlkZW5jZS4ifSwKICB7aWQ6ImFzc2VzcyIsdGl0bGU6IsSQw6FuaCBnacOhIHPGoSBi4buZIixoaW50OiJOb3ZlbHR5IHbDoCBpbnZlbnRpdmUgc3RlcC4ifSwKICB7aWQ6ImV4cGVydCIsdGl0bGU6IkNodXnDqm4gZ2lhIHLDoCBzb8OhdCIsaGludDoiRXhwZXJ0IHZhbGlkYXRpb24uIn0sCiAge2lkOiJyZXBvcnQiLHRpdGxlOiJCw6FvIGPDoW8iLGhpbnQ6IlThu5VuZyBo4bujcCBr4bq/dCBxdeG6oy4ifQpdOwpjb25zdCBzdGF0ZT17c3RlcDowLHBkZjpudWxsLHBhZ2VUZXh0OltdLHBhZ2VDb2x1bW5UZXh0OltdLHBhZ2VRdWFsaXR5OltdLGJhZFRleHRQYWdlczpbXSxvY3JQYWdlczp7fSxyYXdUZXh0OiIiLGNsYWltc1RleHQ6IiIsY2xhaW1zOltdLHNlbGVjdGVkOjAsZmVhdHVyZXM6W10sY29uZmlybWVkOmZhbHNlLHNlYXJjaDpbXSxxdWVyaWVzOltdLHByaW9yOnt9LG1hdHJpeDpbXSxhc3Nlc3NtZW50Ont9LHJldmlld3M6MCxjYW5kaWRhdGVzOltdLGJhY2tlbmRVcmw6IiIscHJvdmlkZXJzOnt9LGNsb3VkT2NyOm51bGx9Owpjb25zdCAkPWlkPT5kb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CmNvbnN0IGVzYz1zPT4oc3x8IiIpLnJlcGxhY2UoL1smPD4iJ10vZyxtPT4oeyImIjoiJmFtcDsiLCI8IjoiJmx0OyIsIj4iOiImZ3Q7IiwnIic6IiZxdW90OyIsIiciOiImIzAzOTsifVttXSkpOwpjb25zdCBjbGVhbj1zPT4oc3x8IiIpLnJlcGxhY2UoL1x1MDBhZC9nLCIiKS5yZXBsYWNlKC9bIFx0XSsvZywiICIpLnJlcGxhY2UoL1xuWyBcdF0rL2csIlxuIikudHJpbSgpOwpmdW5jdGlvbiBmb2xkVk4ocyl7CiAgcmV0dXJuIChzfHwiIikKICAgIC5ub3JtYWxpemUoIk5GRCIpCiAgICAucmVwbGFjZSgvW1x1MDMwMC1cdTAzNmZdL2csIiIpCiAgICAucmVwbGFjZSgvxJEvZywiZCIpLnJlcGxhY2UoL8SQL2csIkQiKQogICAgLnRvVXBwZXJDYXNlKCk7Cn0KZnVuY3Rpb24gY2xhaW1NYXJrZXJJbmZvKHRleHQpewogIGNvbnN0IGY9Zm9sZFZOKHRleHQpOwogIGNvbnN0IHBhdHRlcm5zPVsKICAgIC9ZRVVccypDQVVccypCQU9ccypITy8sCiAgICAvTkhVTkdccypESUVVXHMqWUVVXHMqQ0FVXHMqQkFPXHMqSE8vLAogICAgL1dIQVRccytJU1xzK0NMQUlNRURccytJU1xzKjoqLywKICAgIC9JXHMqXC8/XHMqV0VccytDTEFJTVxzKjoqLywKICAgIC9cYkNMQUlNUz9ccyo6Ki8KICBdOwogIGZvcihjb25zdCByZSBvZiBwYXR0ZXJucyl7CiAgICBjb25zdCBtPWYubWF0Y2gocmUpOwogICAgaWYobSkgcmV0dXJuIHtpbmRleDptLmluZGV4LGVuZDptLmluZGV4K21bMF0ubGVuZ3RofTsKICB9CiAgcmV0dXJuIG51bGw7Cn0KZnVuY3Rpb24gbG9va3NMaWtlQ2xhaW1QYWdlKHRleHQpewogIGNvbnN0IGY9Zm9sZFZOKHRleHQpOwogIHJldHVybiAvKD86XnxcbnxccykxXHMqW1wuXCldXHMqKFFVWSBUUklOSHxQSFVPTkcgUEhBUHxTQU4gUEhBTXxUSElFVCBCSXxIRSBUSE9OR3xDSEUgUEhBTXxBXHN8QU5cc3xUSEVccykvLnRlc3QoZikKICAgICYmIC8oQkFPIEdPTXxDT01QUklTSU5HfENPTVBSSVNFU3xHT00gQ0FDIEJVT0N8SU5DTFVESU5HKS8udGVzdChmKTsKfQpmdW5jdGlvbiBleHRyYWN0Q2xhaW1zVGFpbCh0ZXh0KXsKICBpZighdGV4dCkgcmV0dXJuICIiOwogIGNvbnN0IG1hcms9Y2xhaW1NYXJrZXJJbmZvKHRleHQpOwogIGlmKG1hcmspIHJldHVybiBjbGVhbih0ZXh0LnNsaWNlKG1hcmsuZW5kKSkuc2xpY2UoMCw4MDAwMCk7CgogIGNvbnN0IGY9Zm9sZFZOKHRleHQpOwogIGNvbnN0IHJlPS8oPzpefFxufFxzKTFccypbXC5cKV1ccyooUVVZIFRSSU5IfFBIVU9ORyBQSEFQfFNBTiBQSEFNfFRISUVUIEJJfEhFIFRIT05HfENIRSBQSEFNfEFcc3xBTlxzfFRIRVxzKS87CiAgY29uc3QgbT1mLm1hdGNoKHJlKTsKICByZXR1cm4gbSA/IGNsZWFuKHRleHQuc2xpY2UobS5pbmRleCkpLnNsaWNlKDAsODAwMDApIDogIiI7Cn0KZnVuY3Rpb24gbm9ybWFsaXplT2NyVGV4dChzKXsKICAvLyB2MTA6IGtow7RuZyB04buxIG7hu5FpIGTDsm5nIHTDuXkgdGnhu4duIG7hu69hLiBDaOG7iSBjaHXhuqluIGjDs2EgVW5pY29kZS9raG/huqNuZyB0cuG6r25nLgogIC8vIMSQaeG7gXUgbsOgeSB0csOhbmggYmnhur9uIHbEg24gYuG6o24gVmnhu4d0IMSRw7puZyB0aMOgbmggY2h14buXaSBkw61uaCBuaMawICJO4bqiWU3huqZNIiBob+G6t2Mga8OpbyBmb290ZXIgdsOgbyB0aXRsZS4KICByZXR1cm4gU3RyaW5nKHN8fCIiKQogICAgLnJlcGxhY2UoL1x1RkVGRi9nLCIiKQogICAgLnJlcGxhY2UoL1x1MDBhZC9nLCIiKQogICAgLnJlcGxhY2UoL1tcdTIwMEItXHUyMDBEXHUyMDYwXS9nLCIiKQogICAgLm5vcm1hbGl6ZSgiTkZDIikKICAgIC5yZXBsYWNlKC9b4oCc4oCdXS9nLCciJykucmVwbGFjZSgvW+KAmOKAmV0vZywiJyIpCiAgICAucmVwbGFjZSgvW+KAkOKAkeKAkuKAk+KAlF0vZywiLSIpCiAgICAucmVwbGFjZSgvXHUwMGEwL2csIiAiKQogICAgLnJlcGxhY2UoL1sgXHRdKy9nLCIgIikKICAgIC5yZXBsYWNlKC9bIFx0XStcbi9nLCJcbiIpCiAgICAucmVwbGFjZSgvXG5bIFx0XSsvZywiXG4iKQogICAgLnJlcGxhY2UoL1xzKyhbLC47OiVcKV0pL2csIiQxIikKICAgIC5yZXBsYWNlKC8oXCgpXHMrL2csIiQxIikKICAgIC5yZXBsYWNlKC8oXGQpXHMqLFxzKihcZCkvZywiJDEsJDIiKQogICAgLnJlcGxhY2UoL1xuezMsfS9nLCJcblxuIikKICAgIC50cmltKCk7Cn0KCmZ1bmN0aW9uIHN0cmlwUGRmQXJ0aWZhY3RzKHMpewogIGxldCB0PW5vcm1hbGl6ZU9jclRleHQocyk7CgogIC8vIFBhZ2UgY291bnRlcnMgLyBmb290ZXIgYXJ0aWZhY3RzIGNvbW1vbmx5IGVtaXR0ZWQgYnkgVmlldG5hbWVzZSBwYXRlbnQgUERGcy4KICB0PXQucmVwbGFjZSgvKD86XGJcZHszLDEwfVxzK1xkezEsM31ccypcL1xzKlxkezEsM31cYltccyw7Ol0qKXsyLH0vZywiICIpOwogIHQ9dC5yZXBsYWNlKC9cYlxkezMsMTB9XHMrXGR7MSwzfVxzKlwvXHMqXGR7MSwzfVxiL2csIiAiKTsKICB0PXQucmVwbGFjZSgvKD86XGJcZHsxLDN9XHMqXC9ccypcZHszLDEwfVxiW1xzLDs6XSopezIsfS9nLCIgIik7CiAgdD10LnJlcGxhY2UoL15ccypcZHsxLDN9XHMqXC9ccypcZHsxLDN9XHMqJC9nbSwiIik7CiAgdD10LnJlcGxhY2UoL15ccyooPzpQYWdlfFRyYW5nKVxzK1xkKyg/OlxzKlwvXHMqXGQrKT9ccyokL2dtaSwiIik7CgogIC8vIENvbGxhcHNlIG9ubHkgaG9yaXpvbnRhbCBub2lzZTsga2VlcCBzZW1hbnRpYyBsaW5lIGJyZWFrcy4KICByZXR1cm4gdC5yZXBsYWNlKC9bIFx0XXsyLH0vZywiICIpLnJlcGxhY2UoL1xuezMsfS9nLCJcblxuIikudHJpbSgpOwp9CgpmdW5jdGlvbiB0ZXh0TGF5ZXJRdWFsaXR5U2NvcmUodGV4dCl7CiAgY29uc3QgdD1zdHJpcFBkZkFydGlmYWN0cyh0ZXh0KTsKICBpZighdCkgcmV0dXJuIDA7CgogIGNvbnN0IGNoYXJzPXQubGVuZ3RoOwogIGNvbnN0IGxldHRlcnM9KHQubWF0Y2goL1xwe0x9L2d1KXx8W10pLmxlbmd0aDsKICBjb25zdCBkaWdpdHM9KHQubWF0Y2goL1xkL2cpfHxbXSkubGVuZ3RoOwogIGNvbnN0IHdlaXJkPSh0Lm1hdGNoKC9b77+94pah4page308Pnx+XmBdL2cpfHxbXSkubGVuZ3RoOwogIGNvbnN0IHNsYXNoU2VxPSh0Lm1hdGNoKC9cZCtccypcL1xzKlxkKy9nKXx8W10pLmxlbmd0aDsKICBjb25zdCB3b3Jkcz10LnNwbGl0KC9ccysvKS5maWx0ZXIoQm9vbGVhbik7CiAgY29uc3Qgc2hvcnRXb3Jkcz13b3Jkcy5maWx0ZXIodz0+dy5sZW5ndGg8PTEpLmxlbmd0aDsKCiAgbGV0IHNjb3JlPTA7CiAgc2NvcmUrPU1hdGgubWluKDQwLCBjaGFycy8zNSk7CiAgc2NvcmUrPU1hdGgubWluKDI1LCAobGV0dGVycy9NYXRoLm1heCgxLGNoYXJzKSkqNDUpOwogIGlmKC9bxIPDosSRw6rDtMahxrDEgsOCxJDDisOUxqDGr10vLnRlc3QodCkpIHNjb3JlKz04OwogIGlmKC9bw6DDoeG6o8Oj4bqh4bqx4bqv4bqz4bq14bq34bqn4bql4bqp4bqr4bqtw6jDqeG6u+G6veG6ueG7geG6v+G7g+G7heG7h8Osw63hu4nEqeG7i8Oyw7Phu4/DteG7jeG7k+G7keG7leG7l+G7meG7neG7m+G7n+G7oeG7o8O5w7rhu6fFqeG7peG7q+G7qeG7reG7r+G7seG7s8O94bu34bu54bu1XS9pLnRlc3QodCkpIHNjb3JlKz04OwogIGlmKC9cYig/OnPDoW5nIGNo4bq/fHnDqnUgY+G6p3UgYuG6o28gaOG7mXxxdXkgdHLDrG5ofHBoxrDGoW5nIHBow6FwfGJhbyBn4buTbXx0cm9uZyDEkcOzfHRoaeG6v3QgYuG7i3xo4buHIHRo4buRbmcpXGIvaS50ZXN0KHQpKSBzY29yZSs9MTI7CgogIHNjb3JlLT1NYXRoLm1pbigzNSx3ZWlyZCo1KTsKICBzY29yZS09TWF0aC5taW4oMzAsc2xhc2hTZXEqNSk7CiAgaWYoZGlnaXRzL01hdGgubWF4KDEsY2hhcnMpPi4yOCkgc2NvcmUtPTE4OwogIGlmKHNob3J0V29yZHMvTWF0aC5tYXgoMSx3b3Jkcy5sZW5ndGgpPi4yNSkgc2NvcmUtPTE1OwoKICByZXR1cm4gTWF0aC5tYXgoMCxNYXRoLm1pbigxMDAsTWF0aC5yb3VuZChzY29yZSkpKTsKfQoKZnVuY3Rpb24gY2xlYW5NZXRhVmFsdWUocyl7CiAgbGV0IHQ9c3RyaXBQZGZBcnRpZmFjdHMocykKICAgIC5yZXBsYWNlKC9eXHMqW1woXFtdP1xkezJ9W1wpXF1dP1xzKi8sIiIpCiAgICAucmVwbGFjZSgvXHMrL2csIiAiKQogICAgLnRyaW0oKTsKICByZXR1cm4gdDsKfQoKZnVuY3Rpb24gc2FuaXRpemVQYXRlbnRUaXRsZShzKXsKICBsZXQgdD1jbGVhbk1ldGFWYWx1ZShzKQogICAgLnJlcGxhY2UoL1xiKD86UGFnZXxUcmFuZylccytcZCsoPzpcL1xkKyk/XGIvZ2ksIiIpCiAgICAucmVwbGFjZSgvKD86XGJcZHszLDEwfVxzK1xkezEsM31cL1xkezEsM31cYlxzKikrL2csIiIpCiAgICAucmVwbGFjZSgvXHMrL2csIiAiKQogICAgLnRyaW0oKTsKCiAgLy8gUmVqZWN0IG9idmlvdXNseSBwb2xsdXRlZCB0aXRsZXMgcmF0aGVyIHRoYW4gcG9pc29uaW5nIHNlYXJjaC4KICBjb25zdCBzbGFzaD0odC5tYXRjaCgvXGQrXHMqXC9ccypcZCsvZyl8fFtdKS5sZW5ndGg7CiAgY29uc3QgZGlnaXRSYXRpbz0odC5tYXRjaCgvXGQvZyl8fFtdKS5sZW5ndGgvTWF0aC5tYXgoMSx0Lmxlbmd0aCk7CiAgaWYoc2xhc2g+PTIgfHwgZGlnaXRSYXRpbz4uMzApIHJldHVybiAiIjsKICByZXR1cm4gdC5zbGljZSgwLDI2MCk7Cn0KCmZ1bmN0aW9uIGNhbnZhc1RvQmFzZTY0SnBlZyhjYW52YXMscXVhbGl0eT0uOSl7CiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLHJlamVjdCk9PnsKICAgIGNhbnZhcy50b0Jsb2IoYXN5bmMgYmxvYj0+ewogICAgICBpZighYmxvYikgcmV0dXJuIHJlamVjdChuZXcgRXJyb3IoIktow7RuZyB04bqhbyDEkcaw4bujYyDhuqNuaCBPQ1IuIikpOwogICAgICBjb25zdCBidWY9YXdhaXQgYmxvYi5hcnJheUJ1ZmZlcigpOwogICAgICBjb25zdCBieXRlcz1uZXcgVWludDhBcnJheShidWYpOwogICAgICBsZXQgYmluPSIiOwogICAgICBjb25zdCBjaHVuaz0weDgwMDA7CiAgICAgIGZvcihsZXQgaT0wO2k8Ynl0ZXMubGVuZ3RoO2krPWNodW5rKXsKICAgICAgICBiaW4rPVN0cmluZy5mcm9tQ2hhckNvZGUoLi4uYnl0ZXMuc3ViYXJyYXkoaSxNYXRoLm1pbihpK2NodW5rLGJ5dGVzLmxlbmd0aCkpKTsKICAgICAgfQogICAgICByZXNvbHZlKGJ0b2EoYmluKSk7CiAgICB9LCJpbWFnZS9qcGVnIixxdWFsaXR5KTsKICB9KTsKfQoKYXN5bmMgZnVuY3Rpb24gY2xvdWRWaXNpb25PY3IoY2FudmFzKXsKICBpZihzdGF0ZS5jbG91ZE9jcj09PWZhbHNlKSByZXR1cm4gbnVsbDsKICB0cnl7CiAgICBjb25zdCBpbWFnZV9iYXNlNjQ9YXdhaXQgY2FudmFzVG9CYXNlNjRKcGVnKGNhbnZhcywuOTIpOwogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCgiL2FwaS9vY3IiLHsKICAgICAgbWV0aG9kOiJQT1NUIiwKICAgICAgaGVhZGVyczp7ImNvbnRlbnQtdHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7aW1hZ2VfYmFzZTY0fSkKICAgIH0pOwogICAgY29uc3QgZD1hd2FpdCByLmpzb24oKS5jYXRjaCgoKT0+KHt9KSk7CiAgICBpZihyLnN0YXR1cz09PTUwMSB8fCBkLmNvZGU9PT0iVklTSU9OX05PVF9DT05GSUdVUkVEIil7CiAgICAgIHN0YXRlLmNsb3VkT2NyPWZhbHNlOwogICAgICByZXR1cm4gbnVsbDsKICAgIH0KICAgIGlmKCFyLm9rIHx8ICFkLm9rKSB0aHJvdyBuZXcgRXJyb3IoZC5lcnJvcnx8KCJPQ1IgSFRUUCAiK3Iuc3RhdHVzKSk7CiAgICBzdGF0ZS5jbG91ZE9jcj10cnVlOwogICAgcmV0dXJuIG5vcm1hbGl6ZU9jclRleHQoZC50ZXh0fHwiIik7CiAgfWNhdGNoKGUpewogICAgY29uc29sZS53YXJuKCJDbG91ZCBPQ1IgZmFsbGJhY2s6IixlKTsKICAgIHJldHVybiBudWxsOwogIH0KfQoKZnVuY3Rpb24gZm9ybWF0Q2xhaW1Gb3JEaXNwbGF5KHMpewogIGNvbnN0IHQ9bm9ybWFsaXplT2NyVGV4dChzKQogICAgLnJlcGxhY2UoL1xzKihcKFtpdnhsY2RtXStcKSlccyovaWcsIlxuJDEgIikKICAgIC5yZXBsYWNlKC9ccysodsOgKVxzKyg/PVwoW2l2eGxjZG1dK1wpKS9pZywiXG4kMSAiKTsKICByZXR1cm4gdC50cmltKCk7Cn0KCgpmdW5jdGlvbiByZW5kZXJQcm9jZXNzKCl7CiAgJCgicHJvY2VzcyIpLmlubmVySFRNTD1TVEVQUy5tYXAoKHMsaSk9PmA8ZGl2IGNsYXNzPSJwcm9jZXNzLWl0ZW0gJHtpPT09c3RhdGUuc3RlcD8iYWN0aXZlIjppPHN0YXRlLnN0ZXA/ImRvbmUiOiIifSI+PHNwYW4gY2xhc3M9Im4iPiR7aTxzdGF0ZS5zdGVwPyLinJMiOmkrMX08L3NwYW4+PHNwYW4+JHtzLnRpdGxlfTwvc3Bhbj48L2Rpdj5gKS5qb2luKCIiKTsKfQpmdW5jdGlvbiBzaG93U3RlcChpKXsKICBzdGF0ZS5zdGVwPU1hdGgubWF4KDAsTWF0aC5taW4oU1RFUFMubGVuZ3RoLTEsaSkpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi5zZWN0aW9uIikuZm9yRWFjaCh4PT54LmNsYXNzTGlzdC5yZW1vdmUoImFjdGl2ZSIpKTsKICAkKFNURVBTW3N0YXRlLnN0ZXBdLmlkKS5jbGFzc0xpc3QuYWRkKCJhY3RpdmUiKTsKICAkKCJwYWdlVGl0bGUiKS50ZXh0Q29udGVudD1TVEVQU1tzdGF0ZS5zdGVwXS50aXRsZTsKICAkKCJwYWdlU3ViIikudGV4dENvbnRlbnQ9U1RFUFNbc3RhdGUuc3RlcF0uaGludDsKICAkKCJ3aXphcmRUaXRsZSIpLnRleHRDb250ZW50PWBCxrDhu5tjICR7c3RhdGUuc3RlcCsxfS8ke1NURVBTLmxlbmd0aH0gwrcgJHtTVEVQU1tzdGF0ZS5zdGVwXS50aXRsZX1gOwogICQoIndpemFyZEhpbnQiKS50ZXh0Q29udGVudD1TVEVQU1tzdGF0ZS5zdGVwXS5oaW50OwogICQoImJhY2tCdG4iKS5zdHlsZS52aXNpYmlsaXR5PXN0YXRlLnN0ZXA9PT0wPyJoaWRkZW4iOiJ2aXNpYmxlIjsKICAkKCJuZXh0QnRuIikudGV4dENvbnRlbnQ9c3RhdGUuc3RlcD09PVNURVBTLmxlbmd0aC0xPyJIb8OgbiB04bqldCI6IlRp4bq/cCB04bulYyDihpIiOwogIHJlbmRlclByb2Nlc3MoKTsKICBpZihTVEVQU1tzdGF0ZS5zdGVwXS5pZD09PSJwcmlvciIpewogICAgaWYoISQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlKSB1c2VHZW5lcmF0ZWRRdWVyeSgpOwogICAgdXBkYXRlT2ZmaWNpYWxTZWFyY2hMaW5rcygkKCJsaXZlU2VhcmNoUXVlcnkiKS52YWx1ZSk7CiAgfQogIHNjcm9sbFRvKHt0b3A6MCxiZWhhdmlvcjoic21vb3RoIn0pOwp9CmZ1bmN0aW9uIHZhbGlkYXRlQmVmb3JlTmV4dCgpewogIGlmKHN0YXRlLnN0ZXA9PT0wICYmICFzdGF0ZS5yYXdUZXh0ICYmICFzdGF0ZS5jbGFpbXMubGVuZ3RoKXthbGVydCgiSMOjeSB04bqjaSBt4buZdCBQREYgaG/hurdjIG7huqFwIGRlbW8gdHLGsOG7m2MuIik7cmV0dXJuIGZhbHNlfQogIGlmKHN0YXRlLnN0ZXA9PT0xICYmICFzdGF0ZS5jbGFpbXMubGVuZ3RoKXthbGVydCgiQ2jGsGEgY8OzIGNsYWltLiBIw6N5IE9DUiBs4bqhaSBob+G6t2MgcGFzdGUgcGjhuqduIFnDqnUgY+G6p3UgYuG6o28gaOG7mSBy4buTaSBi4bqlbSDigJxUw6FjaCBs4bqhaSBjbGFpbXPigJ0uIik7cmV0dXJuIGZhbHNlfQogIGlmKHN0YXRlLnN0ZXA9PT0yICYmICFzdGF0ZS5mZWF0dXJlcy5sZW5ndGgpe2FsZXJ0KCJIw6N5IHTDoWNoIGThuqV1IGhp4buHdSBr4bu5IHRodeG6rXQgdHLGsOG7m2MuIik7cmV0dXJuIGZhbHNlfQogIGlmKHN0YXRlLnN0ZXA9PT0yICYmICFzdGF0ZS5jb25maXJtZWQpe3JldHVybiBjb25maXJtKCJC4buZIGThuqV1IGhp4buHdSBjaMawYSDEkcaw4bujYyB4w6FjIG5o4bqtbi4gQuG6oW4gduG6q24gbXXhu5FuIHRp4bq/cCB04bulYz8iKX0KICBpZihzdGF0ZS5zdGVwPT09NCl7cmVhZFByaW9yKCk7aWYoIU9iamVjdC52YWx1ZXMoc3RhdGUucHJpb3IpLnNvbWUoeD0+eC5ubykpe3JldHVybiBjb25maXJtKCJDaMawYSBjw7MgdMOgaSBsaeG7h3UgxJHhu5FpIGNo4bupbmcuIELhuqFuIHbhuqtuIG114buRbiB0aeG6v3AgdOG7pWM/Iil9fQogIHJldHVybiB0cnVlCn0KJCgiYmFja0J0biIpLm9uY2xpY2s9KCk9PnNob3dTdGVwKHN0YXRlLnN0ZXAtMSk7CiQoIm5leHRCdG4iKS5vbmNsaWNrPSgpPT57aWYoc3RhdGUuc3RlcD09PVNURVBTLmxlbmd0aC0xKXskKCJnZW5SZXBvcnQiKS5jbGljaygpO3JldHVybn1pZih2YWxpZGF0ZUJlZm9yZU5leHQoKSlzaG93U3RlcChzdGF0ZS5zdGVwKzEpfTsKc2hvd1N0ZXAoMCk7c2V0VGltZW91dCh1cGRhdGVGZWF0dXJlUmV2aWV3VUksMCk7CmlmKGxvY2F0aW9uLnByb3RvY29sPT09ImZpbGU6IikgJCgibG9jYWxCYW5uZXIiKS5zdHlsZS5kaXNwbGF5PSJibG9jayI7CgpmdW5jdGlvbiBzZXREZXRlY3QoaWQsb2ssdGV4dCl7bGV0IGVsPSQoaWQpO2VsLmNsYXNzTmFtZT0iZGV0ZWN0LWNhcmQgIisob2s/Im9rIjoid2FybiIpO2VsLnF1ZXJ5U2VsZWN0b3IoInNwYW4iKS50ZXh0Q29udGVudD10ZXh0fQpmdW5jdGlvbiBub3JtRGF0ZSh2KXtpZighdilyZXR1cm4iIjtsZXQgbT12Lm1hdGNoKC8oXGR7MSwyfSlbXC9cLS5dKFxkezEsMn0pW1wvXC0uXShcZHs0fSkvKTtpZihtKXJldHVybiBgJHttWzNdfS0ke1N0cmluZyhtWzJdKS5wYWRTdGFydCgyLCIwIil9LSR7U3RyaW5nKG1bMV0pLnBhZFN0YXJ0KDIsIjAiKX1gO2xldCBkPW5ldyBEYXRlKHYpO3JldHVybiBpc05hTihkKT8iIjpkLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwxMCl9CmZ1bmN0aW9uIGZpcnN0TWF0Y2godGV4dCxwYXR0ZXJucyl7Zm9yKGNvbnN0IHAgb2YgcGF0dGVybnMpe2NvbnN0IG09dGV4dC5tYXRjaChwKTtpZihtJiZtWzFdKXJldHVybiBjbGVhbihtWzFdKX1yZXR1cm4iIn0KCmFzeW5jIGZ1bmN0aW9uIGdldFBkZkxpYigpewogaWYoIXdpbmRvdy5wZGZqc0xpYikgdGhyb3cgbmV3IEVycm9yKCJQREYuanMgY2jGsGEgdOG6o2kgxJHGsOG7o2MgdOG7qyBDRE4uIik7CiBwZGZqc0xpYi5HbG9iYWxXb3JrZXJPcHRpb25zLndvcmtlclNyYz0iaHR0cHM6Ly9jZG5qcy5jbG91ZGZsYXJlLmNvbS9hamF4L2xpYnMvcGRmLmpzLzMuMTEuMTc0L3BkZi53b3JrZXIubWluLmpzIjsKIHJldHVybiB3aW5kb3cucGRmanNMaWI7Cn0KYXN5bmMgZnVuY3Rpb24gcmVhZFBkZihmaWxlKXsKICBjb25zdCBwZGZqcz1hd2FpdCBnZXRQZGZMaWIoKTsKICBjb25zdCBwZGY9YXdhaXQgcGRmanMuZ2V0RG9jdW1lbnQoe2RhdGE6YXdhaXQgZmlsZS5hcnJheUJ1ZmZlcigpfSkucHJvbWlzZTsKICBzdGF0ZS5wZGY9cGRmOwogIHN0YXRlLnBhZ2VUZXh0PVtdOwogIHN0YXRlLnBhZ2VDb2x1bW5UZXh0PVtdOwogIHN0YXRlLnBhZ2VRdWFsaXR5PVtdOwogIHN0YXRlLmJhZFRleHRQYWdlcz1bXTsKCiAgZnVuY3Rpb24gaXRlbXNUb0xpbmVzKGl0ZW1zKXsKICAgIGlmKCFpdGVtcy5sZW5ndGgpIHJldHVybiAiIjsKICAgIGNvbnN0IGhlaWdodHM9aXRlbXMubWFwKHg9Pk1hdGguYWJzKHguaHx8MTApKS5maWx0ZXIoQm9vbGVhbikuc29ydCgoYSxiKT0+YS1iKTsKICAgIGNvbnN0IG1lZGlhbkg9aGVpZ2h0c1tNYXRoLmZsb29yKGhlaWdodHMubGVuZ3RoLzIpXXx8MTA7CiAgICBjb25zdCB0b2w9TWF0aC5tYXgoMi4yLE1hdGgubWluKDUsbWVkaWFuSCouMzgpKTsKCiAgICBjb25zdCByb3dzPVtdOwogICAgY29uc3Qgc29ydGVkPWl0ZW1zLnNsaWNlKCkuc29ydCgoYSxiKT0+Yi55LWEueSB8fCBhLngtYi54KTsKICAgIGZvcihjb25zdCBpdCBvZiBzb3J0ZWQpewogICAgICBsZXQgcm93PXJvd3MuZmluZChyPT5NYXRoLmFicyhyLnktaXQueSk8PXRvbCk7CiAgICAgIGlmKCFyb3cpe3Jvdz17eTppdC55LGl0ZW1zOltdfTtyb3dzLnB1c2gocm93KX0KICAgICAgcm93Lml0ZW1zLnB1c2goaXQpOwogICAgfQogICAgcm93cy5zb3J0KChhLGIpPT5iLnktYS55KTsKCiAgICByZXR1cm4gcm93cy5tYXAocj0+ewogICAgICBjb25zdCB4cz1yLml0ZW1zLnNvcnQoKGEsYik9PmEueC1iLngpOwogICAgICBsZXQgb3V0PSIiOwogICAgICBsZXQgcHJldj1udWxsOwogICAgICBmb3IoY29uc3QgaXQgb2YgeHMpewogICAgICAgIGNvbnN0IHM9U3RyaW5nKGl0LnN8fCIiKTsKICAgICAgICBpZighcykgY29udGludWU7CiAgICAgICAgaWYocHJldil7CiAgICAgICAgICBjb25zdCBnYXA9aXQueC0ocHJldi54K3ByZXYudyk7CiAgICAgICAgICAvLyBBZGQgYSBzcGFjZSBvbmx5IHdoZW4gdmlzdWFsIGdhcCBzdWdnZXN0cyBvbmUgYW5kIHB1bmN0dWF0aW9uIGRvZXMgbm90LgogICAgICAgICAgaWYoZ2FwPk1hdGgubWF4KDEuNSwocHJldi5ofHwxMCkqLjEyKSAmJiAhL1tcc1wtXC9dJC8udGVzdChvdXQpICYmICEvXlssLjs6JVwpXS8udGVzdChzKSkgb3V0Kz0iICI7CiAgICAgICAgfQogICAgICAgIG91dCs9czsKICAgICAgICBwcmV2PWl0OwogICAgICB9CiAgICAgIHJldHVybiBvdXQudHJpbSgpOwogICAgfSkuZmlsdGVyKEJvb2xlYW4pLmpvaW4oIlxuIik7CiAgfQoKICBmb3IobGV0IHA9MTtwPD1wZGYubnVtUGFnZXM7cCsrKXsKICAgIGNvbnN0IHBhZ2U9YXdhaXQgcGRmLmdldFBhZ2UocCk7CiAgICBjb25zdCB2aWV3cG9ydD1wYWdlLmdldFZpZXdwb3J0KHtzY2FsZToxfSk7CiAgICBjb25zdCBjb250ZW50PWF3YWl0IHBhZ2UuZ2V0VGV4dENvbnRlbnQoe2Rpc2FibGVOb3JtYWxpemF0aW9uOmZhbHNlfSk7CgogICAgY29uc3QgaXRlbXM9Y29udGVudC5pdGVtcwogICAgICAuZmlsdGVyKHg9PnggJiYgdHlwZW9mIHguc3RyPT09InN0cmluZyIgJiYgeC5zdHIudHJpbSgpKQogICAgICAubWFwKHg9Pih7CiAgICAgICAgczp4LnN0ci5ub3JtYWxpemUoIk5GQyIpLAogICAgICAgIHg6eC50cmFuc2Zvcm1bNF0sCiAgICAgICAgeTp4LnRyYW5zZm9ybVs1XSwKICAgICAgICB3Ok51bWJlcih4LndpZHRoKXx8MCwKICAgICAgICBoOk51bWJlcih4LmhlaWdodCl8fE1hdGguYWJzKHgudHJhbnNmb3JtWzNdKXx8MTAKICAgICAgfSkpOwoKICAgIGxldCBzaW1wbGU9c3RyaXBQZGZBcnRpZmFjdHMoaXRlbXNUb0xpbmVzKGl0ZW1zKSk7CiAgICBjb25zdCBtaWQ9dmlld3BvcnQud2lkdGgvMjsKICAgIGxldCBsZWZ0PXN0cmlwUGRmQXJ0aWZhY3RzKGl0ZW1zVG9MaW5lcyhpdGVtcy5maWx0ZXIoeD0+eC54PG1pZCkpKTsKICAgIGxldCByaWdodD1zdHJpcFBkZkFydGlmYWN0cyhpdGVtc1RvTGluZXMoaXRlbXMuZmlsdGVyKHg9PngueD49bWlkKSkpOwoKICAgIGNvbnN0IHE9dGV4dExheWVyUXVhbGl0eVNjb3JlKHNpbXBsZSk7CiAgICBzdGF0ZS5wYWdlVGV4dC5wdXNoKHNpbXBsZSk7CiAgICBzdGF0ZS5wYWdlQ29sdW1uVGV4dC5wdXNoKGxlZnQrIlxuIityaWdodCk7CiAgICBzdGF0ZS5wYWdlUXVhbGl0eS5wdXNoKHEpOwogICAgaWYocTw0OCkgc3RhdGUuYmFkVGV4dFBhZ2VzLnB1c2gocCk7CgogICAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD1NYXRoLnJvdW5kKHAvcGRmLm51bVBhZ2VzKjM1KSsiJSI7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1gxJBhbmcgxJHhu41jIHRleHQgbGF5ZXI6ICR7cH0vJHtwZGYubnVtUGFnZXN9IMK3IGNo4bqldCBsxrDhu6NuZyAke3F9LzEwMGA7CiAgfQogIHJldHVybiBwZGY7Cn0KCmZ1bmN0aW9uIHRleHRRdWFsaXR5KCl7CiAgY29uc3QgY2hhcnM9c3RhdGUucGFnZVRleHQucmVkdWNlKChuLHMpPT5uK3MubGVuZ3RoLDApOwogIGNvbnN0IGdvb2Q9c3RhdGUucGFnZVF1YWxpdHkuZmlsdGVyKHg9Png+PTQ4KS5sZW5ndGg7CiAgcmV0dXJuIHtjaGFycyxhdmc6Y2hhcnMvTWF0aC5tYXgoMSxzdGF0ZS5wYWdlVGV4dC5sZW5ndGgpLGdvb2RQYWdlczpnb29kLGJhZFBhZ2VzOnN0YXRlLmJhZFRleHRQYWdlcy5sZW5ndGh9Owp9Cgphc3luYyBmdW5jdGlvbiByZW5kZXJQYWdlQ2FudmFzKHBhZ2VObyxzY2FsZT0xLjc1KXsKICBjb25zdCBwYWdlPWF3YWl0IHN0YXRlLnBkZi5nZXRQYWdlKHBhZ2VObyksdmlld3BvcnQ9cGFnZS5nZXRWaWV3cG9ydCh7c2NhbGV9KTsKICBjb25zdCBjYW52YXM9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgiY2FudmFzIik7Y2FudmFzLndpZHRoPU1hdGguY2VpbCh2aWV3cG9ydC53aWR0aCk7Y2FudmFzLmhlaWdodD1NYXRoLmNlaWwodmlld3BvcnQuaGVpZ2h0KTsKICBhd2FpdCBwYWdlLnJlbmRlcih7Y2FudmFzQ29udGV4dDpjYW52YXMuZ2V0Q29udGV4dCgiMmQiKSx2aWV3cG9ydH0pLnByb21pc2U7cmV0dXJuIGNhbnZhczsKfQoKZnVuY3Rpb24gcHJlcHJvY2Vzc09jckNhbnZhcyhzcmMpewogIGNvbnN0IG91dD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJjYW52YXMiKTsKICBvdXQud2lkdGg9c3JjLndpZHRoOyBvdXQuaGVpZ2h0PXNyYy5oZWlnaHQ7CiAgY29uc3QgY3R4PW91dC5nZXRDb250ZXh0KCIyZCIse3dpbGxSZWFkRnJlcXVlbnRseTp0cnVlfSk7CiAgY3R4LmRyYXdJbWFnZShzcmMsMCwwKTsKICBjb25zdCBpbWc9Y3R4LmdldEltYWdlRGF0YSgwLDAsb3V0LndpZHRoLG91dC5oZWlnaHQpOwogIGNvbnN0IGQ9aW1nLmRhdGE7CgogIC8vIEhpc3RvZ3JhbSBncmF5c2NhbGUgZm9yIHJvYnVzdCB0aHJlc2hvbGQuCiAgY29uc3QgaGlzdD1uZXcgQXJyYXkoMjU2KS5maWxsKDApOwogIGZvcihsZXQgaT0wO2k8ZC5sZW5ndGg7aSs9NCl7CiAgICBjb25zdCBnPU1hdGgubWF4KDAsTWF0aC5taW4oMjU1LE1hdGgucm91bmQoMC4yOTkqZFtpXSswLjU4NypkW2krMV0rMC4xMTQqZFtpKzJdKSkpOwogICAgaGlzdFtnXSsrOwogIH0KICBsZXQgdG90YWw9b3V0LndpZHRoKm91dC5oZWlnaHQsc3VtPTA7CiAgZm9yKGxldCBpPTA7aTwyNTY7aSsrKSBzdW0rPWkqaGlzdFtpXTsKICBsZXQgc3VtQj0wLHdCPTAsbWF4VmFyPTAsdGhyPTE3ODsKICBmb3IobGV0IHQ9MDt0PDI1Njt0KyspewogICAgd0IrPWhpc3RbdF07IGlmKCF3QikgY29udGludWU7CiAgICBjb25zdCB3Rj10b3RhbC13QjsgaWYoIXdGKSBicmVhazsKICAgIHN1bUIrPXQqaGlzdFt0XTsKICAgIGNvbnN0IG1CPXN1bUIvd0IsbUY9KHN1bS1zdW1CKS93RjsKICAgIGNvbnN0IHY9d0Iqd0YqKG1CLW1GKSoobUItbUYpOwogICAgaWYodj5tYXhWYXIpe21heFZhcj12O3Rocj10fQogIH0KICAvLyBBdm9pZCBvdmVybHkgYWdncmVzc2l2ZSB0aHJlc2hvbGQgZm9yIHBhbGUgc2NhbnMuCiAgdGhyPU1hdGgubWF4KDE0NSxNYXRoLm1pbigyMDUsdGhyKzEyKSk7CgogIGZvcihsZXQgaT0wO2k8ZC5sZW5ndGg7aSs9NCl7CiAgICBsZXQgZz0wLjI5OSpkW2ldKzAuNTg3KmRbaSsxXSswLjExNCpkW2krMl07CiAgICAvLyBjb250cmFzdCBzdHJldGNoIGJlZm9yZSBiaW5hcml6YXRpb24KICAgIGc9KGctMTI4KSoxLjIyKzEyODsKICAgIGNvbnN0IHY9Zzx0aHI/MDoyNTU7CiAgICBkW2ldPWRbaSsxXT1kW2krMl09djsKICAgIGRbaSszXT0yNTU7CiAgfQogIGN0eC5wdXRJbWFnZURhdGEoaW1nLDAsMCk7CiAgcmV0dXJuIG91dDsKfQoKZnVuY3Rpb24gb2NyUXVhbGl0eVNjb3JlKHRleHQsY29uZmlkZW5jZT0wKXsKICBjb25zdCBmPWZvbGRWTih0ZXh0fHwiIik7CiAgbGV0IHNjb3JlPU51bWJlcihjb25maWRlbmNlKXx8MDsKICBjb25zdCBwYXRlbnRXb3Jkcz1bIllFVSBDQVUgQkFPIEhPIiwiUVVZIFRSSU5IIiwiUEhVT05HIFBIQVAiLCJCQU8gR09NIiwiVFJPTkcgRE8iLCJTQU5HIENIRSIsIlRISUVUIEJJIiwiSEUgVEhPTkciLCJUSEFOSCBQSEFOIl07CiAgZm9yKGNvbnN0IHcgb2YgcGF0ZW50V29yZHMpIGlmKGYuaW5jbHVkZXModykpIHNjb3JlKz04OwogIHNjb3JlKz1NYXRoLm1pbigyMCwodGV4dHx8IiIpLmxlbmd0aC8yNTApOwogIC8vIFBlbmFsaXplIG9idmlvdXMgT0NSIGdhcmJhZ2UuCiAgY29uc3Qgd2VpcmQ9KCh0ZXh0fHwiIikubWF0Y2goL1t8e308Pn5eYF0vZyl8fFtdKS5sZW5ndGg7CiAgc2NvcmUtPU1hdGgubWluKDIwLHdlaXJkKjIpOwogIHJldHVybiBzY29yZTsKfQoKCmNvbnN0IHNsZWVwID0gbXMgPT4gbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7CmZ1bmN0aW9uIHdpdGhUaW1lb3V0KHByb21pc2UsIG1zLCBsYWJlbCl7CiAgbGV0IHRpbWVyOwogIGNvbnN0IHRpbWVvdXQgPSBuZXcgUHJvbWlzZSgoXywgcmVqZWN0KSA9PiB7CiAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KG5ldyBFcnJvcihsYWJlbCArICIgcXXDoSB0aOG7nWkgZ2lhbiIpKSwgbXMpOwogIH0pOwogIHJldHVybiBQcm9taXNlLnJhY2UoW3Byb21pc2UsIHRpbWVvdXRdKS5maW5hbGx5KCgpID0+IGNsZWFyVGltZW91dCh0aW1lcikpOwp9CgpsZXQgb2NyV29ya2VyUHJvbWlzZSA9IG51bGw7CmFzeW5jIGZ1bmN0aW9uIGdldE9jcldvcmtlcihyZWFzb249Ik9DUiIpewogIGlmKG9jcldvcmtlclByb21pc2UpIHJldHVybiBvY3JXb3JrZXJQcm9taXNlOwogIGlmKCF3aW5kb3cuVGVzc2VyYWN0KSB0aHJvdyBuZXcgRXJyb3IoIktow7RuZyB04bqjaSDEkcaw4bujYyBUZXNzZXJhY3QuanMuIik7CgogIHNldERldGVjdCgiZGV0T0NSIixmYWxzZSwixJBhbmcga2jhu59pIHThuqFvIE9DUi4uLiIpOwogICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50ID0gcmVhc29uICsgIjogxJFhbmcgdOG6o2kgYuG7mSBuaOG6rW4gZGnhu4duLi4uIjsKICBhd2FpdCBzbGVlcCg4MCk7IC8vIG5oxrDhu51uZyBicm93c2VyIHJlcGFpbnQgdHLGsOG7m2Mga2hpIGto4bufaSB04bqhbyBXZWIgV29ya2VyCgogIGNvbnN0IGxhbmcgPSAkKCJqdXJpc2RpY3Rpb24iKS52YWx1ZSA9PT0gIlVTIiA/ICJlbmciIDogWyJ2aWUiLCJlbmciXTsKICBvY3JXb3JrZXJQcm9taXNlID0gd2l0aFRpbWVvdXQoCiAgICBUZXNzZXJhY3QuY3JlYXRlV29ya2VyKGxhbmcsIDEsIHsKICAgICAgbG9nZ2VyOiBtID0+IHsKICAgICAgICBpZihtICYmIG0uc3RhdHVzID09PSAicmVjb2duaXppbmcgdGV4dCIpewogICAgICAgICAgY29uc3QgcGN0ID0gTWF0aC5yb3VuZCgobS5wcm9ncmVzcyB8fCAwKSAqIDEwMCk7CiAgICAgICAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudCA9IGAke3JlYXNvbn06IG5o4bqtbiBkaeG7h24gJHtwY3R9JWA7CiAgICAgICAgfQogICAgICB9CiAgICB9KSwKICAgIDI1MDAwLAogICAgIkto4bufaSB04bqhbyBPQ1IiCiAgKTsKCiAgdHJ5ewogICAgcmV0dXJuIGF3YWl0IG9jcldvcmtlclByb21pc2U7CiAgfWNhdGNoKGUpewogICAgb2NyV29ya2VyUHJvbWlzZSA9IG51bGw7CiAgICB0aHJvdyBlOwogIH0KfQoKYXN5bmMgZnVuY3Rpb24gb2NyU2VsZWN0ZWRQYWdlcyhwYWdlTm9zLHJlYXNvbj0iT0NSIil7CiAgaWYoIXN0YXRlLnBkZikgcmV0dXJuIGZhbHNlOwogIHRyeXsKICAgIGxldCBsb2NhbFdvcmtlcj1udWxsOwogICAgbGV0IGRvbmU9MDsKCiAgICBmb3IoY29uc3QgcCBvZiBwYWdlTm9zKXsKICAgICAgaWYoc3RhdGUub2NyUGFnZXNbcF0pe2RvbmUrKztjb250aW51ZTt9CgogICAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1gJHtyZWFzb259OiDEkWFuZyDEkeG7jWMgdHJhbmcgJHtwfS4uLmA7CiAgICAgIGF3YWl0IHNsZWVwKDI1KTsKCiAgICAgIC8vIMavdSB0acOqbiBHb29nbGUgVmlzaW9uIE9DUiBu4bq/dSBiYWNrZW5kIMSRw6MgY+G6pXUgaMOsbmgga2V5LgogICAgICBjb25zdCBjbG91ZENhbnZhcz1hd2FpdCByZW5kZXJQYWdlQ2FudmFzKHAsMi4xNSk7CiAgICAgIGxldCBiZXN0VGV4dD1hd2FpdCBjbG91ZFZpc2lvbk9jcihjbG91ZENhbnZhcyk7CgogICAgICBpZihiZXN0VGV4dCAmJiBiZXN0VGV4dC5sZW5ndGg+MjApewogICAgICAgIHN0YXRlLm9jclBhZ2VzW3BdPW5vcm1hbGl6ZU9jclRleHQoYmVzdFRleHQpOwogICAgICAgIHNldERldGVjdCgiZGV0T0NSIix0cnVlLGBHb29nbGUgVmlzaW9uIE9DUiDCtyB0cmFuZyAke3B9YCk7CiAgICAgIH1lbHNlewogICAgICAgIC8vIFRlc3NlcmFjdCBjaOG7iSBsw6AgZmFsbGJhY2sgbG9jYWwuCiAgICAgICAgaWYoIWxvY2FsV29ya2VyKSBsb2NhbFdvcmtlcj1hd2FpdCBnZXRPY3JXb3JrZXIocmVhc29uKyIgKGxvY2FsKSIpOwogICAgICAgIHRyeXsKICAgICAgICAgIGF3YWl0IGxvY2FsV29ya2VyLnNldFBhcmFtZXRlcnMoewogICAgICAgICAgICBwcmVzZXJ2ZV9pbnRlcndvcmRfc3BhY2VzOiIxIiwKICAgICAgICAgICAgdXNlcl9kZWZpbmVkX2RwaToiMzAwIiwKICAgICAgICAgICAgdGVzc2VkaXRfcGFnZXNlZ19tb2RlOiI2IgogICAgICAgICAgfSk7CiAgICAgICAgfWNhdGNoKF9lKXt9CgogICAgICAgIGNvbnN0IHJhd0NhbnZhcz1hd2FpdCByZW5kZXJQYWdlQ2FudmFzKHAsMi41KTsKICAgICAgICBjb25zdCBjbGVhbkNhbnZhcz1wcmVwcm9jZXNzT2NyQ2FudmFzKHJhd0NhbnZhcyk7CgogICAgICAgIGxldCByZXN1bHQxPWF3YWl0IHdpdGhUaW1lb3V0KAogICAgICAgICAgbG9jYWxXb3JrZXIucmVjb2duaXplKGNsZWFuQ2FudmFzKSwKICAgICAgICAgIDYwMDAwLAogICAgICAgICAgIk9DUiB0cmFuZyAiK3AKICAgICAgICApOwogICAgICAgIGJlc3RUZXh0PShyZXN1bHQxJiZyZXN1bHQxLmRhdGEmJnJlc3VsdDEuZGF0YS50ZXh0KXx8IiI7CiAgICAgICAgbGV0IGJlc3RTY29yZT1vY3JRdWFsaXR5U2NvcmUoYmVzdFRleHQscmVzdWx0MSYmcmVzdWx0MS5kYXRhJiZyZXN1bHQxLmRhdGEuY29uZmlkZW5jZSk7CgogICAgICAgIGlmKGJlc3RTY29yZTw3Nil7CiAgICAgICAgICB0cnl7CiAgICAgICAgICAgIGNvbnN0IHJlc3VsdDI9YXdhaXQgd2l0aFRpbWVvdXQoCiAgICAgICAgICAgICAgbG9jYWxXb3JrZXIucmVjb2duaXplKHJhd0NhbnZhcyksCiAgICAgICAgICAgICAgNjAwMDAsCiAgICAgICAgICAgICAgIk9DUiBraeG7g20gdHJhIHRyYW5nICIrcAogICAgICAgICAgICApOwogICAgICAgICAgICBjb25zdCB0Mj0ocmVzdWx0MiYmcmVzdWx0Mi5kYXRhJiZyZXN1bHQyLmRhdGEudGV4dCl8fCIiOwogICAgICAgICAgICBjb25zdCBzMj1vY3JRdWFsaXR5U2NvcmUodDIscmVzdWx0MiYmcmVzdWx0Mi5kYXRhJiZyZXN1bHQyLmRhdGEuY29uZmlkZW5jZSk7CiAgICAgICAgICAgIGlmKHMyPmJlc3RTY29yZSl7YmVzdFRleHQ9dDI7YmVzdFNjb3JlPXMyfQogICAgICAgICAgfWNhdGNoKF9lKXt9CiAgICAgICAgfQogICAgICAgIHN0YXRlLm9jclBhZ2VzW3BdPW5vcm1hbGl6ZU9jclRleHQoYmVzdFRleHQpOwogICAgICAgIHNldERldGVjdCgiZGV0T0NSIix0cnVlLGBPQ1IgbG9jYWwgwrcgdHJhbmcgJHtwfWApOwogICAgICB9CgogICAgICBkb25lKys7CiAgICAgICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9KDQ1K01hdGgucm91bmQoZG9uZS9wYWdlTm9zLmxlbmd0aCo1MCkpKyIlIjsKICAgIH0KCiAgICBzZXREZXRlY3QoImRldE9DUiIsdHJ1ZSxzdGF0ZS5jbG91ZE9jcj09PXRydWU/YEdvb2dsZSBWaXNpb24gT0NSIMK3ICR7cGFnZU5vcy5sZW5ndGh9IHRyYW5nYDpgT0NSIGhvw6BuIHThuqV0IMK3ICR7cGFnZU5vcy5sZW5ndGh9IHRyYW5nYCk7CiAgICByZXR1cm4gdHJ1ZTsKICB9Y2F0Y2goZSl7CiAgICBjb25zb2xlLmVycm9yKCJPQ1IgZXJyb3IiLGUpOwogICAgc2V0RGV0ZWN0KCJkZXRPQ1IiLGZhbHNlLCJPQ1Iga2jDtG5nIGto4bqjIGThu6VuZyIpOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9Ik9DUiBraMO0bmcgY2jhuqF5IMSRxrDhu6NjOiAiK1N0cmluZyhlLm1lc3NhZ2V8fGUpOwogICAgcmV0dXJuIGZhbHNlOwogIH0KfQoKZnVuY3Rpb24gaGFzQ2xhaW1NYXJrZXIodCl7CiAgcmV0dXJuICEhY2xhaW1NYXJrZXJJbmZvKHQpOwp9Cgphc3luYyBmdW5jdGlvbiBzbWFydE9jckNsYWltcyhhdXRvPWZhbHNlKXsKICBpZighc3RhdGUucGRmKSByZXR1cm4gZmFsc2U7CgogIGNvbnN0IG49c3RhdGUucGRmLm51bVBhZ2VzOwogIC8vIENsYWltcyBj4bunYSBi4bqxbmcgVk4gdGjGsOG7nW5nIG7hurFtIG5nYXkgdHLGsOG7m2MgcGjhuqduIGjDrG5oIHbhur0uCiAgLy8gVuG7m2kgUERGIDE0IHRyYW5nIGPhu6dhIMSQaeG7gW4gVHLDumMsIHRo4bupIHThu7EgbsOgeSBPQ1IgdHJhbmcgMTIgxJDhuqZVIFRJw4pOLgogIGNvbnN0IHJhd09yZGVyPVtuLTIsbi0zLG4tMSxuLTQsbixuLTUsbi02LG4tN107CiAgY29uc3QgY2FuZGlkYXRlcz1bLi4ubmV3IFNldChyYXdPcmRlcildLmZpbHRlcihwPT5wPj0xICYmIHA8PW4pOwoKICBzZXREZXRlY3QoImRldE9DUiIsZmFsc2UsIsSQYW5nIE9DUiBjbGFpbXMuLi4iKTsKICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1hdXRvCiAgICA/ICJQREYgZOG6oW5nIHNjYW4g4oCUIMSRYW5nIHThu7EgcXXDqXQgY8OhYyB0cmFuZyBjdeG7kWkgxJHhu4MgdMOsbSBZw6p1IGPhuqd1IGLhuqNvIGjhu5kuLi4iCiAgICA6ICLEkGFuZyBxdcOpdCBjw6FjIHRyYW5nIGN14buRaSDEkeG7gyB0w6xtIFnDqnUgY+G6p3UgYuG6o28gaOG7mS4uLiI7CgogIGxldCBmb3VuZFBhZ2U9bnVsbDsKCiAgZm9yKGxldCBpPTA7aTxjYW5kaWRhdGVzLmxlbmd0aDtpKyspewogICAgY29uc3QgcD1jYW5kaWRhdGVzW2ldOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YE9DUiB5w6p1IGPhuqd1IGLhuqNvIGjhu5k6IHRyYW5nICR7cH0vJHtufSAoJHtpKzF9LyR7Y2FuZGlkYXRlcy5sZW5ndGh9KS4uLmA7CgogICAgY29uc3Qgb2s9YXdhaXQgb2NyU2VsZWN0ZWRQYWdlcyhbcF0sYE9DUiB0cmFuZyAke3B9YCk7CiAgICBpZighb2spewogICAgICAvLyBPQ1IgZmFpbCB0aMOsIHRob8OhdCBz4bqhY2gsIEtIw5RORyB0cmVvIFVJLgogICAgICAkKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPSIxMDAlIjsKICAgICAgcmV0dXJuIGZhbHNlOwogICAgfQoKICAgIGNvbnN0IHQ9c3RhdGUub2NyUGFnZXNbcF18fCIiOwogICAgaWYoaGFzQ2xhaW1NYXJrZXIodCkgfHwgbG9va3NMaWtlQ2xhaW1QYWdlKHQpKXsKICAgICAgZm91bmRQYWdlPXA7CiAgICAgIGJyZWFrOwogICAgfQogIH0KCiAgaWYoIWZvdW5kUGFnZSl7CiAgICBzdGF0ZS5yYXdUZXh0PW1lcmdlZFRleHQoKTsKICAgIGNvbnN0IGZhbGxiYWNrPWNhbmRpZGF0ZUNsYWltc1RleHQoKTsKICAgIHN0YXRlLmNsYWltc1RleHQ9ZmFsbGJhY2t8fCIiOwogICAgJCgiY2xhaW1zUmF3IikudmFsdWU9c3RhdGUuY2xhaW1zVGV4dDskKCJjbGFpbXNDbGVhbiIpLnZhbHVlPWZvcm1hdENsYWltRm9yRGlzcGxheShzdGF0ZS5jbGFpbXNUZXh0KTsKICAgIHN0YXRlLmNsYWltcz1wYXJzZUNsYWltcyhzdGF0ZS5jbGFpbXNUZXh0KTsKICAgIHN0YXRlLnNlbGVjdGVkPTA7CiAgICByZW5kZXJDbGFpbXMoKTsKICAgIHNldERldGVjdCgiZGV0Q2xhaW1zIixzdGF0ZS5jbGFpbXMubGVuZ3RoPjAsCiAgICAgIHN0YXRlLmNsYWltcy5sZW5ndGg/YMSQw6MgdMOhY2ggJHtzdGF0ZS5jbGFpbXMubGVuZ3RofSBjbGFpbWA6Ik9DUiB4b25nIG5oxrBuZyBjaMawYSB0w6xtIHRo4bqleSBjbGFpbSIpOwogICAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMTAwJSI7CiAgICAkKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD1zdGF0ZS5jbGFpbXMubGVuZ3RoCiAgICAgID9gT0NSIGhvw6BuIHThuqV0LiDEkMOjIG5o4bqtbiBkaeG7h24gJHtzdGF0ZS5jbGFpbXMubGVuZ3RofSBjbGFpbS5gCiAgICAgIDoixJDDoyBxdcOpdCBjw6FjIHRyYW5nIGN14buRaSBuaMawbmcgY2jGsGEgbmjhuq1uIGRp4buHbiDEkcaw4bujYyBjbGFpbS4gQuG6oW4gduG6q24gY8OzIHRo4buDIHBhc3RlIGNsYWltcyDhu58gYsaw4bubYyAyLiI7CiAgICByZXR1cm4gc3RhdGUuY2xhaW1zLmxlbmd0aD4wOwogIH0KCiAgLy8gT0NSIHRow6ptIDEgdHJhbmcga+G6vyB0aeG6v3AgdsOsIGNsYWltcyBjw7MgdGjhu4Mga8OpbyBkw6BpIHNhbmcgdHJhbmcgc2F1LgogIGNvbnN0IGZvbGxvdz1mb3VuZFBhZ2UrMTsKICBpZihmb2xsb3c8PW4gJiYgIXN0YXRlLm9jclBhZ2VzW2ZvbGxvd10pewogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YMSQw6MgdMOsbSB0aOG6pXkgdHJhbmcgY2xhaW1zICR7Zm91bmRQYWdlfTsgxJFhbmcga2nhu4NtIHRyYSB0cmFuZyAke2ZvbGxvd30uLi5gOwogICAgYXdhaXQgb2NyU2VsZWN0ZWRQYWdlcyhbZm9sbG93XSxgT0NSIHRyYW5nICR7Zm9sbG93fWApOwogIH0KCiAgY29uc3QgY2xhaW1QYWdlcz1bZm91bmRQYWdlXTsKICBpZihmb2xsb3c8PW4gJiYgc3RhdGUub2NyUGFnZXNbZm9sbG93XSkgY2xhaW1QYWdlcy5wdXNoKGZvbGxvdyk7CiAgY29uc3Qgam9pbmVkPWNsYWltUGFnZXMubWFwKHA9PnN0YXRlLm9jclBhZ2VzW3BdfHwiIikuam9pbigiXG5cbiIpOwoKICBzdGF0ZS5yYXdUZXh0PW1lcmdlZFRleHQoKTsKICBsZXQgYz1leHRyYWN0Q2xhaW1zVGFpbChqb2luZWQpOwogIGlmKCFjKSBjPWNhbmRpZGF0ZUNsYWltc1RleHQoKTsKICBpZighYyAmJiBsb29rc0xpa2VDbGFpbVBhZ2Uoam9pbmVkKSkgYz1jbGVhbihqb2luZWQpOwoKICBzdGF0ZS5jbGFpbXNUZXh0PWN8fCIiOwogICQoImNsYWltc1JhdyIpLnZhbHVlPXN0YXRlLmNsYWltc1RleHQ7JCgiY2xhaW1zQ2xlYW4iKS52YWx1ZT1mb3JtYXRDbGFpbUZvckRpc3BsYXkoc3RhdGUuY2xhaW1zVGV4dCk7CiAgc3RhdGUuY2xhaW1zPXBhcnNlQ2xhaW1zKHN0YXRlLmNsYWltc1RleHQpOwogIHN0YXRlLnNlbGVjdGVkPTA7CiAgcmVuZGVyQ2xhaW1zKCk7CgogIHNldERldGVjdCgiZGV0Q2xhaW1zIixzdGF0ZS5jbGFpbXMubGVuZ3RoPjAsCiAgICBzdGF0ZS5jbGFpbXMubGVuZ3RoP2DEkMOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW1gOiLEkMOjIHRo4bqleSB0cmFuZyBjbGFpbXMgbmjGsG5nIHBhcnNlciBjaMawYSB0w6FjaCDEkcaw4bujYyIpOwogICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjEwMCUiOwogICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PXN0YXRlLmNsYWltcy5sZW5ndGgKICAgID9gSG/DoG4gdOG6pXQuIFTDrG0gdGjhuqV5IFnDqnUgY+G6p3UgYuG6o28gaOG7mSDhu58gdHJhbmcgJHtmb3VuZFBhZ2V9IHbDoCDEkcOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW0uYAogICAgOmDEkMOjIHTDrG0gdGjhuqV5IHRyYW5nIFnDqnUgY+G6p3UgYuG6o28gaOG7mSAke2ZvdW5kUGFnZX0sIG5oxrBuZyBj4bqnbiBraeG7g20gdHJhIG7hu5lpIGR1bmcg4bufIGLGsOG7m2MgMi5gOwoKICByZXR1cm4gc3RhdGUuY2xhaW1zLmxlbmd0aD4wOwp9CgpmdW5jdGlvbiBtZXJnZWRUZXh0KCl7CiAgY29uc3Qgb3V0PVtdOwogIGZvcihsZXQgaT0wO2k8c3RhdGUucGFnZVRleHQubGVuZ3RoO2krKyl7CiAgICBjb25zdCBkaXJlY3Q9c3RhdGUucGFnZVRleHRbaV18fCIiOwogICAgY29uc3QgcT1zdGF0ZS5wYWdlUXVhbGl0eVtpXXx8MDsKICAgIGNvbnN0IG9jcj1zdGF0ZS5vY3JQYWdlc1tpKzFdfHwiIjsKICAgIG91dC5wdXNoKHE+PTQ4ID8gZGlyZWN0IDogKG9jcnx8ZGlyZWN0KSk7CiAgfQogIHJldHVybiBvdXQuam9pbigiXG5cbiIpOwp9CgpmdW5jdGlvbiBjbGFpbUNhbmRpZGF0ZVNjb3JlKHRleHQpewogIGlmKCF0ZXh0KSByZXR1cm4gLTk5OTsKICBsZXQgc2NvcmU9dGV4dExheWVyUXVhbGl0eVNjb3JlKHRleHQpOwogIGlmKGhhc0NsYWltTWFya2VyKHRleHQpKSBzY29yZSs9NDU7CiAgaWYobG9va3NMaWtlQ2xhaW1QYWdlKHRleHQpKSBzY29yZSs9MzA7CiAgY29uc3QgcGFyc2VkPXBhcnNlQ2xhaW1zKGV4dHJhY3RDbGFpbXNUYWlsKHRleHQpfHx0ZXh0KTsKICBzY29yZSs9TWF0aC5taW4oNDAscGFyc2VkLmxlbmd0aCoxMCk7CiAgY29uc3QgZ2FyYmFnZT0odGV4dC5tYXRjaCgvXGQrXHMqXC9ccypcZCsvZyl8fFtdKS5sZW5ndGg7CiAgc2NvcmUtPWdhcmJhZ2UqODsKICByZXR1cm4gc2NvcmU7Cn0KCmZ1bmN0aW9uIGNhbmRpZGF0ZUNsYWltc1RleHQoKXsKICBjb25zdCBjYW5kaWRhdGVzPVtdOwoKICAvLyAxKSDGr3UgdGnDqm4gdGV4dCBsYXllciBz4bqhY2guIEtIw5RORyBkw7luZyBi4bqjbiBsZWZ0L3JpZ2h0IGdow6lwIMSRw7RpIG7hur91IGtow7RuZyBj4bqnbi4KICBmb3IobGV0IGk9MDtpPHN0YXRlLnBhZ2VUZXh0Lmxlbmd0aDtpKyspewogICAgY29uc3Qgc3JjPXN0YXRlLnBhZ2VUZXh0W2ldfHwiIjsKICAgIGNvbnN0IHE9c3RhdGUucGFnZVF1YWxpdHlbaV18fDA7CiAgICBpZihxPDQ4KSBjb250aW51ZTsKCiAgICBpZihoYXNDbGFpbU1hcmtlcihzcmMpfHxsb29rc0xpa2VDbGFpbVBhZ2Uoc3JjKSl7CiAgICAgIGNvbnN0IGpvaW5lZD1bc3JjXTsKICAgICAgZm9yKGxldCBqPWkrMTtqPE1hdGgubWluKHN0YXRlLnBhZ2VUZXh0Lmxlbmd0aCxpKzUpO2orKyl7CiAgICAgICAgaWYoKHN0YXRlLnBhZ2VRdWFsaXR5W2pdfHwwKT49NDgpIGpvaW5lZC5wdXNoKHN0YXRlLnBhZ2VUZXh0W2pdKTsKICAgICAgfQogICAgICBjb25zdCBibG9jaz1qb2luZWQuam9pbigiXG5cbiIpOwogICAgICBjb25zdCB0YWlsPWV4dHJhY3RDbGFpbXNUYWlsKGJsb2NrKXx8YmxvY2s7CiAgICAgIGNhbmRpZGF0ZXMucHVzaCh7dGV4dDp0YWlsLHNjb3JlOmNsYWltQ2FuZGlkYXRlU2NvcmUodGFpbCkrMjV9KTsKICAgIH0KICB9CgogIC8vIDIpIE9DUiBwYWdlcy4KICBmb3IoY29uc3Qgc3JjIG9mIE9iamVjdC52YWx1ZXMoc3RhdGUub2NyUGFnZXMpKXsKICAgIGlmKCFzcmMpIGNvbnRpbnVlOwogICAgY29uc3QgdGFpbD1leHRyYWN0Q2xhaW1zVGFpbChzcmMpfHxzcmM7CiAgICBjYW5kaWRhdGVzLnB1c2goe3RleHQ6dGFpbCxzY29yZTpjbGFpbUNhbmRpZGF0ZVNjb3JlKHRhaWwpfSk7CiAgfQoKICAvLyAzKSBDb2x1bW4gcmVjb25zdHJ1Y3Rpb24gb25seSBhcyBhIGxhc3QgcmVzb3J0LgogIGlmKCFjYW5kaWRhdGVzLmxlbmd0aCl7CiAgICBmb3IoY29uc3Qgc3JjIG9mIHN0YXRlLnBhZ2VDb2x1bW5UZXh0KXsKICAgICAgaWYoIXNyYykgY29udGludWU7CiAgICAgIGNvbnN0IHRhaWw9ZXh0cmFjdENsYWltc1RhaWwoc3JjKTsKICAgICAgaWYodGFpbCkgY2FuZGlkYXRlcy5wdXNoKHt0ZXh0OnRhaWwsc2NvcmU6Y2xhaW1DYW5kaWRhdGVTY29yZSh0YWlsKS0yMH0pOwogICAgfQogIH0KCiAgY2FuZGlkYXRlcy5zb3J0KChhLGIpPT5iLnNjb3JlLWEuc2NvcmUpOwogIGNvbnN0IGJlc3Q9Y2FuZGlkYXRlc1swXTsKICByZXR1cm4gYmVzdCYmYmVzdC5zY29yZT49NDUgPyBiZXN0LnRleHQuc2xpY2UoMCw4MDAwMCkgOiAiIjsKfQoKZnVuY3Rpb24gcGFyc2VDbGFpbXModGV4dCl7CiAgbGV0IHQ9bm9ybWFsaXplT2NyVGV4dCh0ZXh0fHwiIikucmVwbGFjZSgvXHIvZywiXG4iKTsKCiAgLy8gT0NSIHRoxrDhu51uZyBjaG86ICIxIC4iLCAiMSkiLCAiMSApIiwgaG/hurdjIHh14buRbmcgZMOybmcgdHLGsOG7m2Mgc+G7kS4KICB0PXQucmVwbGFjZSgvKD86XnxcbilccyooXGR7MSwyfSlccypbXC5cKV1ccyovZywiXG4kMS4gIik7CgogIGxldCBtYXRjaGVzPVsuLi50Lm1hdGNoQWxsKC8oPzpefFxuKVxzKihcZHsxLDJ9KVwuXHMqKFtcc1xTXSo/KSg/PSg/OlxuXHMqXGR7MSwyfVwuXHMqKXwkKS9nKV07CiAgbGV0IGFycj1tYXRjaGVzCiAgICAubWFwKG09Pih7aWQ6K21bMV0sdGV4dDpjbGVhbihtWzJdKX0pKQogICAgLmZpbHRlcih4PT54LnRleHQubGVuZ3RoPjE1KTsKCiAgLy8gRmFsbGJhY2sgZMOgbmggY2hvIE9DUiBsw6BtIG3huqV0IGThuqV1ICIuIiBzYXUgc+G7kSBjbGFpbS4KICBpZighYXJyLmxlbmd0aCl7CiAgICBjb25zdCBmPWZvbGRWTih0KTsKICAgIGNvbnN0IGZpcnN0PWYuc2VhcmNoKC8oPzpefFxufFxzKTFccysoUVVZIFRSSU5IfFBIVU9ORyBQSEFQfFNBTiBQSEFNfFRISUVUIEJJfEhFIFRIT05HfENIRSBQSEFNfEFcc3xBTlxzfFRIRVxzKS8pOwogICAgaWYoZmlyc3Q+PTApewogICAgICBjb25zdCBib2R5PWNsZWFuKHQuc2xpY2UoZmlyc3QpKTsKICAgICAgYXJyPVt7aWQ6MSx0ZXh0OmJvZHkucmVwbGFjZSgvXlxzKjFccyovLCIiKX1dOwogICAgfQogIH0KCiAgYXJyPWFycgogICAgLmZpbHRlcigoeCxpLGEpPT5hLmZpbmRJbmRleCh5PT55LmlkPT09eC5pZCk9PT1pKQogICAgLnNvcnQoKGEsYik9PmEuaWQtYi5pZCkKICAgIC5zbGljZSgwLDYwKTsKCiAgcmV0dXJuIGFyci5tYXAoKGMsaSk9Pih7CiAgICAuLi5jLAogICAgdHlwZTovYWNjb3JkaW5nIHRvIGNsYWltXHMrXGQrfHRoZW8gKD86xJFp4buDbXx5w6p1IGPhuqd1IGLhuqNvIGjhu5l8Y2xhaW0pXHMqXGQrL2kudGVzdChjLnRleHQpCiAgICAgID8iUGjhu6UgdGh14buZYyIKICAgICAgOihpPT09MD8ixJDhu5ljIGzhuq1wIjoiQ2jGsGEgeMOhYyDEkeG7i25oIikKICB9KSk7Cn0KZnVuY3Rpb24gZ3Vlc3NKdXIodGV4dCxubyl7CiBpZigvQ+G7pEMgU+G7niBI4buuVSBUUsONIFRV4buGfEPhu5luZyBow7JhIHjDoyBo4buZaSBjaOG7pyBuZ2jEqWEgVmnhu4d0IE5hbS9pLnRlc3QodGV4dCl8fC9eWzEyXS1cZHs1LH0vLnRlc3Qobm8pKXJldHVybiJWTiI7CiBpZigvVW5pdGVkIFN0YXRlcyBQYXRlbnR8VVwuU1wuIFBhdGVudC9pLnRlc3QodGV4dCl8fC9eVVMvaS50ZXN0KG5vKSlyZXR1cm4iVVMiOwogaWYoL15XTy9pLnRlc3Qobm8pKXJldHVybiJXTy9QQ1QiO2lmKC9eRVAvaS50ZXN0KG5vKSlyZXR1cm4iRVAiO3JldHVybiJLaMOhYyI7Cn0KZnVuY3Rpb24gdGFnZ2VkRmllbGQodGV4dCx0YWcsbWF4TGVuPTUwMCl7CiAgY29uc3QgdD1zdHJpcFBkZkFydGlmYWN0cyh0ZXh0fHwiIik7CiAgY29uc3QgcmU9bmV3IFJlZ0V4cCgiXFxcXCgiK3RhZysiXFxcXClcXFxccyooW1xcXFxzXFxcXFNdezEsIittYXhMZW4rIn0/KSg/PVxcXFwoXFxcXGR7Mn1cXFxcKXwkKSIsImkiKTsKICBjb25zdCBtPXQubWF0Y2gocmUpOwogIHJldHVybiBtP2NsZWFuTWV0YVZhbHVlKG1bMV0pOiIiOwp9CgpmdW5jdGlvbiBleHRyYWN0TWV0YWRhdGEodGV4dCl7CiAgY29uc3QgdD1zdHJpcFBkZkFydGlmYWN0cyh0ZXh0fHwiIik7CiAgY29uc3Qgbm89Zmlyc3RNYXRjaCh0LFsKICAgIC9cKDExXClccyooWzEyXS1cZHs1LDh9KS9pLAogICAgL1xiKFsxMl0tXGR7Niw4fSlcYi9pLAogICAgL1xiUGF0ZW50XHMqTm9cLj9ccyo6P1xzKihVU1xzKltcZCxdK1xzKltBQl1cZClcYi9pLAogICAgL1xiKFVTXHM/XGR7NywxMX1ccz9bQUJdXGQpXGIvaSwKICAgIC9cYihXT1xzP1xkezR9XC9cZHs1LDd9XHM/W0EtWl1cZD8pXGIvaQogIF0pLnJlcGxhY2UoL1xzKy9nLCIgIik7CgogIGxldCB0aXRsZT10YWdnZWRGaWVsZCh0LCI1NCIsMzUwKSB8fCBmaXJzdE1hdGNoKHQsWy9UaXRsZVxzKjo/XHMqKFteXG5dezUsMjUwfSkvaV0pOwogIHRpdGxlPXNhbml0aXplUGF0ZW50VGl0bGUodGl0bGUpOwoKICBsZXQgZmlsaW5nPXRhZ2dlZEZpZWxkKHQsIjIyIiw4MCkgfHwgZmlyc3RNYXRjaCh0LFsvRmlsZWRccyo6P1xzKihbQS1aYS16XXszLDl9XC4/XHMrXGR7MSwyfSxccytcZHs0fSkvaV0pOwogIGZpbGluZz1ub3JtRGF0ZShmaWxpbmcpOwoKICBjb25zdCBhcHBsaWNhbnQ9Y2xlYW5NZXRhVmFsdWUoCiAgICB0YWdnZWRGaWVsZCh0LCI3MyIsNTAwKSB8fAogICAgdGFnZ2VkRmllbGQodCwiNzEiLDUwMCkgfHwKICAgIGZpcnN0TWF0Y2godCxbL0Fzc2lnbmVlXHMqOj9ccyooW15cbl17MywyNTB9KS9pLC9BcHBsaWNhbnRccyo6P1xzKihbXlxuXXszLDI1MH0pL2ldKQogICk7CgogIGNvbnN0IHJlcD1jbGVhbk1ldGFWYWx1ZSgKICAgIHRhZ2dlZEZpZWxkKHQsIjc0Iiw0MDApIHx8CiAgICBmaXJzdE1hdGNoKHQsWy9SZXByZXNlbnRhdGl2ZVxzKjo/XHMqKFteXG5dezMsMjUwfSkvaV0pCiAgKTsKCiAgY29uc3QgaXBjPWNsZWFuTWV0YVZhbHVlKAogICAgdGFnZ2VkRmllbGQodCwiNTEiLDM1MCkgfHwKICAgIGZpcnN0TWF0Y2godCxbL0ludFwuXHMqQ2xcLj9ccyo6P1xzKihbXlxuXXs1LDIyMH0pL2ldKQogICk7CgogIGxldCBhYnM9dGFnZ2VkRmllbGQodCwiNTciLDE4MDApIHx8CiAgICBmaXJzdE1hdGNoKHQsWy9BQlNUUkFDVFxzKihbXHNcU117NDAsMTUwMH0/KSg/PUZJRUxEIE9GfEJBQ0tHUk9VTkR8Q0xBSU1TPykvaV0pOwogIGFicz1jbGVhbk1ldGFWYWx1ZShhYnMpLnNsaWNlKDAsMTgwMCk7CgogIHJldHVybntubyx0aXRsZSxmaWxpbmcsYXBwbGljYW50LHJlcCxpcGMsYWJzLGp1cjpndWVzc0p1cih0LG5vKX0KfQoKZnVuY3Rpb24gZmlsbE1ldGEobSl7CiAkKCJwYXRlbnRObyIpLnZhbHVlPW0ubm87JCgidGl0bGUiKS52YWx1ZT1tLnRpdGxlOyQoImZpbGluZ0RhdGUiKS52YWx1ZT1tLmZpbGluZzskKCJhcHBsaWNhbnQiKS52YWx1ZT1tLmFwcGxpY2FudDskKCJyZXByZXNlbnRhdGl2ZSIpLnZhbHVlPW0ucmVwOyQoImlwYyIpLnZhbHVlPW0uaXBjOyQoImFic3RyYWN0IikudmFsdWU9bS5hYnM7CiBbLi4uJCgianVyaXNkaWN0aW9uIikub3B0aW9uc10uZm9yRWFjaCgobyxpKT0+e2lmKG8udmFsdWU9PT1tLmp1cikkKCJqdXJpc2RpY3Rpb24iKS5zZWxlY3RlZEluZGV4PWl9KTsKIGNvbnN0IGJhc2U9KG0ubm98fCJQQVQiKS5yZXBsYWNlKC9ccy9nLCIiKS5yZXBsYWNlKC9bXkEtWmEtejAtOS1dL2csIiIpOyQoImNhc2VJZCIpLnZhbHVlPShtLmp1cnx8IkNBU0UiKSsiLSIrYmFzZTskKCJjYXNlQmFkZ2UiKS50ZXh0Q29udGVudD0kKCJjYXNlSWQiKS52YWx1ZTsKIHNldERldGVjdCgiZGV0TWV0YSIsISEobS5ub3x8bS50aXRsZSksbS5ub3x8bS50aXRsZT8ixJDDoyBuaOG6rW4gZGnhu4duIjoiQ+G6p24ga2nhu4NtIHRyYSIpOwogc2V0RGV0ZWN0KCJkZXRBYnN0cmFjdCIsISFtLmFicyxtLmFicz8ixJDDoyBuaOG6rW4gZGnhu4duIjoiQ2jGsGEgdMOsbSB0aOG6pXkiKTsKfQphc3luYyBmdW5jdGlvbiBwcm9jZXNzRmlsZShmaWxlKXsKICBzdGF0ZS5vY3JQYWdlcz17fTsKICBzdGF0ZS5jbGFpbXM9W107CiAgc3RhdGUuY2xhaW1zVGV4dD0iIjsKICBzdGF0ZS5mZWF0dXJlcz1bXTsKICBzdGF0ZS5zZWFyY2g9W107CiAgc3RhdGUucXVlcmllcz1bXTsKICBzdGF0ZS5wcmlvcj17fTsKICBzdGF0ZS5tYXRyaXg9W107CiAgJCgicHJvZ3Jlc3NCYXIiKS5zdHlsZS53aWR0aD0iMyUiOwogICQoInBkZlN0YXR1cyIpLnRleHRDb250ZW50PSLEkGFuZyBt4bufIFBERi4uLiI7CgogIHRyeXsKICAgIGF3YWl0IHJlYWRQZGYoZmlsZSk7CiAgfWNhdGNoKGUpewogICAgY29uc29sZS5lcnJvcihlKTsKICAgICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjEwMCUiOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9Iktow7RuZyB0aOG7gyBt4bufIFBERjogIisoZSYmZS5tZXNzYWdlP2UubWVzc2FnZTplKTsKICAgIGFsZXJ0KCJLaMO0bmcgdGjhu4MgbeG7nyBmaWxlIFBERiBuw6B5LiIpOwogICAgcmV0dXJuOwogIH0KCiAgY29uc3QgcT10ZXh0UXVhbGl0eSgpOwogIGxldCBjb21iaW5lZD1tZXJnZWRUZXh0KCk7CiAgc3RhdGUucmF3VGV4dD1jb21iaW5lZDsKCiAgLy8gTWV0YWRhdGEgY2jhu4kgbOG6pXkgdOG7qyB0cmFuZyDEkeG6p3UgxJHhu4MgdHLDoW5oIGZvb3Rlci9wYWdlIGNvdW50ZXIgY+G7p2EgdG/DoG4gdMOgaSBsaeG7h3UgY2h1aSB2w6BvIHRpdGxlLgogIGxldCBmaXJzdD1zdGF0ZS5wYWdlVGV4dFswXXx8IiI7CiAgbGV0IGZpcnN0UXVhbGl0eT1zdGF0ZS5wYWdlUXVhbGl0eVswXXx8MDsKICBsZXQgbWV0YT17fTsKCiAgaWYoZmlyc3RRdWFsaXR5Pj00OCl7CiAgICB0cnl7CiAgICAgIG1ldGE9ZXh0cmFjdE1ldGFkYXRhKGZpcnN0KTsKICAgICAgZmlsbE1ldGEobWV0YSk7CiAgICAgIHNldERldGVjdCgiZGV0T0NSIix0cnVlLCJLaMO0bmcgY+G6p24gT0NSIMK3IHRleHQgbGF5ZXIgdOG7kXQiKTsKICAgIH1jYXRjaChlKXtjb25zb2xlLndhcm4oIk1ldGFkYXRhIHRleHQtbGF5ZXIgZXJyb3IiLGUpfQogIH0KCiAgLy8gTuG6v3UgdGV4dCBsYXllciB0cmFuZyDEkeG6p3Uga8OpbSBob+G6t2MgbWV0YWRhdGEgY8OybiB0aGnhur91LCBPQ1IgxJHDum5nIHRyYW5nIMSR4bqndS4KICBpZihmaXJzdFF1YWxpdHk8NDggfHwgIW1ldGEubm8gfHwgIW1ldGEudGl0bGUpewogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9IlRleHQgbGF5ZXIgY8OzIGThuqV1IGhp4buHdSBs4buXaSBtw6MvZm9udCDigJQgxJFhbmcgT0NSIHRyYW5nIMSR4bqndS4uLiI7CiAgICBjb25zdCBva01ldGE9YXdhaXQgb2NyU2VsZWN0ZWRQYWdlcyhbMV0sIk9DUiBtZXRhZGF0YSIpOwogICAgaWYob2tNZXRhICYmIHN0YXRlLm9jclBhZ2VzWzFdKXsKICAgICAgdHJ5ewogICAgICAgIGNvbnN0IG9jck1ldGE9ZXh0cmFjdE1ldGFkYXRhKHN0YXRlLm9jclBhZ2VzWzFdKTsKICAgICAgICAvLyBDaOG7iSB0aGF5IGLhurFuZyBPQ1IgbuG6v3UgT0NSIHTDrG0gxJHGsOG7o2MgdHLGsOG7nW5nIHThu5F0IGjGoW4uCiAgICAgICAgbWV0YT17CiAgICAgICAgICAuLi5tZXRhLAogICAgICAgICAgbm86b2NyTWV0YS5ub3x8bWV0YS5ub3x8IiIsCiAgICAgICAgICB0aXRsZTpvY3JNZXRhLnRpdGxlfHxtZXRhLnRpdGxlfHwiIiwKICAgICAgICAgIGZpbGluZzpvY3JNZXRhLmZpbGluZ3x8bWV0YS5maWxpbmd8fCIiLAogICAgICAgICAgYXBwbGljYW50Om9jck1ldGEuYXBwbGljYW50fHxtZXRhLmFwcGxpY2FudHx8IiIsCiAgICAgICAgICByZXA6b2NyTWV0YS5yZXB8fG1ldGEucmVwfHwiIiwKICAgICAgICAgIGlwYzpvY3JNZXRhLmlwY3x8bWV0YS5pcGN8fCIiLAogICAgICAgICAgYWJzOm9jck1ldGEuYWJzfHxtZXRhLmFic3x8IiIsCiAgICAgICAgICBqdXI6b2NyTWV0YS5qdXJ8fG1ldGEuanVyfHwiVk4iCiAgICAgICAgfTsKICAgICAgICBmaWxsTWV0YShtZXRhKTsKICAgICAgfWNhdGNoKGUpe2NvbnNvbGUud2FybigiT0NSIG1ldGFkYXRhIHBhcnNlIGVycm9yIixlKX0KICAgIH0KICB9CgogIC8vIENsYWltczogZGlyZWN0IHRleHQgbGF5ZXIgZmlyc3QgaWYgY2xlYW4uCiAgbGV0IGNsYWltcz0iIjsKICB0cnl7Y2xhaW1zPWNhbmRpZGF0ZUNsYWltc1RleHQoKX1jYXRjaChlKXtjb25zb2xlLndhcm4oZSl9CgogIGlmKGNsYWltcyAmJiBjbGFpbUNhbmRpZGF0ZVNjb3JlKGNsYWltcyk+PTQ1KXsKICAgIHN0YXRlLmNsYWltc1RleHQ9c3RyaXBQZGZBcnRpZmFjdHMoY2xhaW1zKTsKICAgICQoImNsYWltc1JhdyIpLnZhbHVlPXN0YXRlLmNsYWltc1RleHQ7CiAgICAkKCJjbGFpbXNDbGVhbiIpLnZhbHVlPWZvcm1hdENsYWltRm9yRGlzcGxheShzdGF0ZS5jbGFpbXNUZXh0KTsKICAgIHN0YXRlLmNsYWltcz1wYXJzZUNsYWltcyhzdGF0ZS5jbGFpbXNUZXh0KTsKICAgIHN0YXRlLnNlbGVjdGVkPTA7CiAgICByZW5kZXJDbGFpbXMoKTsKICB9CgogIC8vIE7hur91IGNsYWltIHbhuqtuIGtow7RuZyDEkeG7pyB0aW4gY+G6rXksIE9DUiBjaOG7iSBjw6FjIHRyYW5nIGN14buRaS4KICBpZighc3RhdGUuY2xhaW1zLmxlbmd0aCl7CiAgICBhd2FpdCBzbWFydE9jckNsYWltcyh0cnVlKTsKICB9CgogIHN0YXRlLnJhd1RleHQ9bWVyZ2VkVGV4dCgpOwogICQoInByb2dyZXNzQmFyIikuc3R5bGUud2lkdGg9IjEwMCUiOwoKICBpZihzdGF0ZS5jbGFpbXMubGVuZ3RoKXsKICAgIHNldERldGVjdCgiZGV0Q2xhaW1zIix0cnVlLGDEkMOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW1gKTsKICAgIGNvbnN0IG1vZGU9c3RhdGUuYmFkVGV4dFBhZ2VzLmxlbmd0aAogICAgICA/YEPDsyAke3N0YXRlLmJhZFRleHRQYWdlcy5sZW5ndGh9IHRyYW5nIHRleHQgbGF5ZXIga8OpbTsgxJHDoyB04buxIGTDuW5nIE9DUiBraGkgY+G6p24uYAogICAgICA6IsSQ4buNYyB0cuG7sWMgdGnhur9wIHRleHQgbGF5ZXIsIGdp4buvIG5ndXnDqm4gVW5pY29kZSB0aeG6v25nIFZp4buHdC4iOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9YEhvw6BuIHThuqV0LiAke21vZGV9YDsKICB9ZWxzZXsKICAgIHNldERldGVjdCgiZGV0Q2xhaW1zIixmYWxzZSwiQ2jGsGEgdOG7sSB0w6FjaCDEkcaw4bujYyBjbGFpbSIpOwogICAgJCgicGRmU3RhdHVzIikudGV4dENvbnRlbnQ9IsSQw6MgeOG7rSBsw70gUERGIG5oxrBuZyBjaMawYSB0w6FjaCDEkcaw4bujYyBjbGFpbS4gS2nhu4NtIHRyYSBixrDhu5tjIDIuIjsKICB9Cn0KJCgicGRmSW5wdXQiKS5vbmNoYW5nZT1lPT57aWYoZS50YXJnZXQuZmlsZXNbMF0pcHJvY2Vzc0ZpbGUoZS50YXJnZXQuZmlsZXNbMF0pfTsKY29uc3QgZHo9JCgiZHJvcFpvbmUiKTtbImRyYWdlbnRlciIsImRyYWdvdmVyIl0uZm9yRWFjaChldj0+ZHouYWRkRXZlbnRMaXN0ZW5lcihldixlPT57ZS5wcmV2ZW50RGVmYXVsdCgpO2R6LmNsYXNzTGlzdC5hZGQoImRyYWciKX0pKTtbImRyYWdsZWF2ZSIsImRyb3AiXS5mb3JFYWNoKGV2PT5kei5hZGRFdmVudExpc3RlbmVyKGV2LGU9PntlLnByZXZlbnREZWZhdWx0KCk7ZHouY2xhc3NMaXN0LnJlbW92ZSgiZHJhZyIpfSkpO2R6LmFkZEV2ZW50TGlzdGVuZXIoImRyb3AiLGU9PntsZXQgZj1lLmRhdGFUcmFuc2Zlci5maWxlc1swXTtpZihmKXByb2Nlc3NGaWxlKGYpfSk7CiQoInJldHJ5T0NSIikub25jbGljaz1hc3luYygpPT57aWYoIXN0YXRlLnBkZilyZXR1cm4gYWxlcnQoIkNoxrBhIGPDsyBQREYuIik7YXdhaXQgc21hcnRPY3JDbGFpbXMoZmFsc2UpfTsKJCgib2NyQ2xhaW1zQWdhaW4iKS5vbmNsaWNrPWFzeW5jKCk9PntpZighc3RhdGUucGRmKXJldHVybiBhbGVydCgiQ2jGsGEgY8OzIFBERi4iKTthd2FpdCBzbWFydE9jckNsYWltcyhmYWxzZSl9OwoKZnVuY3Rpb24gcmVuZGVyQ2xhaW1zKCl7CiAkKCJjbGFpbVNlbGVjdCIpLmlubmVySFRNTD1zdGF0ZS5jbGFpbXMubWFwKChjLGkpPT5gPG9wdGlvbiB2YWx1ZT0iJHtpfSI+Q2xhaW0gJHtjLmlkfSDCtyAke2MudHlwZX08L29wdGlvbj5gKS5qb2luKCIiKTsKIGlmKCFzdGF0ZS5jbGFpbXMubGVuZ3RoKXsKICAgJCgiY2xhaW1MaXN0IikuY2xhc3NOYW1lPSJlbXB0eSI7CiAgICQoImNsYWltTGlzdCIpLmlubmVySFRNTD0iQ2jGsGEgY8OzIGNsYWltLiI7CiAgIHJldHVybjsKIH0KICQoImNsYWltTGlzdCIpLmNsYXNzTmFtZT0iIjsKICQoImNsYWltTGlzdCIpLmlubmVySFRNTD1zdGF0ZS5jbGFpbXMubWFwKChjLGkpPT57CiAgIGNvbnN0IHByZXR0eT1lc2MoZm9ybWF0Q2xhaW1Gb3JEaXNwbGF5KGMudGV4dCkpLnJlcGxhY2UoL1xuL2csIjxicj4iKTsKICAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJjbGFpbSI+CiAgICAgIDxoND5DbGFpbSAke2MuaWR9IDxzcGFuIGNsYXNzPSJwaWxsICR7Yy50eXBlPT09IsSQ4buZYyBs4bqtcCI/ImJsdWUiOiIifSI+JHtjLnR5cGV9PC9zcGFuPjwvaDQ+CiAgICAgIDxkaXYgY2xhc3M9ImNsYWltLWNsZWFuIj4ke3ByZXR0eX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iYWN0aW9ucyI+PGJ1dHRvbiBjbGFzcz0iYnRuICR7aT09PXN0YXRlLnNlbGVjdGVkPyJzdWNjZXNzIjoiIn0iIGRhdGEtY2xhaW09IiR7aX0iPiR7aT09PXN0YXRlLnNlbGVjdGVkPyLEkGFuZyBjaOG7jW4iOiJDaOG7jW4gY2xhaW0gbsOgeSJ9PC9idXR0b24+PC9kaXY+CiAgIDwvZGl2PmA7CiB9KS5qb2luKCIiKTsKIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWNsYWltXSIpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT57CiAgIHN0YXRlLnNlbGVjdGVkPStiLmRhdGFzZXQuY2xhaW07CiAgICQoImNsYWltU2VsZWN0IikudmFsdWU9c3RhdGUuc2VsZWN0ZWQ7CiAgIHJlbmRlckNsYWltcygpOwogfSk7Cn0KJCgicGFyc2VDbGFpbXMiKS5vbmNsaWNrPSgpPT57CiAgICAgIGNvbnN0IHNvdXJjZT0kKCJjbGFpbXNDbGVhbiIpLnZhbHVlfHwkKCJjbGFpbXNSYXciKS52YWx1ZTsKICAgICAgc3RhdGUuY2xhaW1zVGV4dD1ub3JtYWxpemVPY3JUZXh0KHNvdXJjZSk7CiAgICAgICQoImNsYWltc0NsZWFuIikudmFsdWU9Zm9ybWF0Q2xhaW1Gb3JEaXNwbGF5KHN0YXRlLmNsYWltc1RleHQpOwogICAgICAkKCJjbGFpbXNSYXciKS52YWx1ZT1zdGF0ZS5jbGFpbXNUZXh0OwogICAgICBzdGF0ZS5jbGFpbXM9cGFyc2VDbGFpbXMoc3RhdGUuY2xhaW1zVGV4dCk7CiAgICAgIHN0YXRlLnNlbGVjdGVkPTA7CiAgICAgIHJlbmRlckNsYWltcygpOwogICAgICBzZXREZXRlY3QoImRldENsYWltcyIsc3RhdGUuY2xhaW1zLmxlbmd0aD4wLHN0YXRlLmNsYWltcy5sZW5ndGg/YMSQw6MgdMOhY2ggJHtzdGF0ZS5jbGFpbXMubGVuZ3RofSBjbGFpbWA6IkNoxrBhIHTDrG0gdGjhuqV5IGNsYWltIik7CiAgICB9OwoKZnVuY3Rpb24gZmVhdHVyZVNwbGl0KHRleHQpewogIGxldCB0PW5vcm1hbGl6ZU9jclRleHQodGV4dHx8IiIpCiAgICAucmVwbGFjZSgvXlxzKig/OmF8YW58dGhlKT9ccyooPzpxdXkgdHLDrG5ofHBoxrDGoW5nIHBow6FwfG1ldGhvZHxwcm9jZXNzfGNvbXBvc2l0aW9ufGRldmljZXxzeXN0ZW0pW146XXswLDIyMH0oPzpiYW8gZ+G7k218Y29tcHJpc2luZ3xjb21wcmlzZXMpXHMqOj9ccyovaSwiIik7CgogIGNvbnN0IGNvbm5lY3RvcnM9L1xiKD86c2F1IMSRw7N8dGnhur9wIHRoZW98a+G6vyB0aeG6v3B8dHJvbmcgxJHDs3zEkeG7k25nIHRo4budaXx0aOG7sWMgaGnhu4dufMSRxrDhu6NjIHRo4buxYyBoaeG7h258d2hlcmVpbnx0aGVufHN1YnNlcXVlbnRseSlcYi9pZzsKICBsZXQgc2VnPVtdOwogIGNvbnN0IHJvbWFuPVsuLi50Lm1hdGNoQWxsKC9cKChpezEsM318aXZ8dnx2aXswLDN9fGl4fHh8eGl7MCwzfXx4aXZ8eHZ8eHZpezAsM30pXClccyovaWcpXTsKCiAgaWYocm9tYW4ubGVuZ3RoPj0yKXsKICAgIGZvcihsZXQgaT0wO2k8cm9tYW4ubGVuZ3RoO2krKyl7CiAgICAgIGNvbnN0IGE9cm9tYW5baV0uaW5kZXgrcm9tYW5baV1bMF0ubGVuZ3RoOwogICAgICBjb25zdCBiPWkrMTxyb21hbi5sZW5ndGg/cm9tYW5baSsxXS5pbmRleDp0Lmxlbmd0aDsKICAgICAgY29uc3Qgcz1jbGVhbih0LnNsaWNlKGEsYikpLnJlcGxhY2UoL1s7LF0rJC8sIiIpOwogICAgICBpZihzLmxlbmd0aD4xOCkgc2VnLnB1c2gocyk7CiAgICB9CiAgfWVsc2V7CiAgICBzZWc9dAogICAgICAucmVwbGFjZShjb25uZWN0b3JzLCI7ICIpCiAgICAgIC5zcGxpdCgvO1xzK3xcbig/PVxzKig/OlxkK1tcLlwpXXxcLXxc4oCiKSkvKQogICAgICAubWFwKGNsZWFuKQogICAgICAuZmlsdGVyKHg9PngubGVuZ3RoPjE4KTsKICB9CgogIC8vIEfhu5lwIGPDoWMgbeG6o25oIHF1w6Egbmfhuq9uIMSR4buDIHRyw6FuaCBmZWF0dXJlIGtp4buDdSAiNTMsMiUgdGluaCIuCiAgY29uc3QgbWVyZ2VkPVtdOwogIGZvcihjb25zdCBzIG9mIHNlZyl7CiAgICBpZihtZXJnZWQubGVuZ3RoICYmIChzLnNwbGl0KC9ccysvKS5sZW5ndGg8NCB8fCBzLmxlbmd0aDwyOCkpewogICAgICBtZXJnZWRbbWVyZ2VkLmxlbmd0aC0xXSs9IjsgIitzOwogICAgfWVsc2UgbWVyZ2VkLnB1c2gocyk7CiAgfQoKICByZXR1cm4gbWVyZ2VkLnNsaWNlKDAsMzApLm1hcCgoeCxpKT0+ewogICAgY29uc3QgZj1mb2xkVk4oeCk7CiAgICBsZXQgdHlwZT0iUXV5IHRyw6xuaCI7CiAgICBpZigvXGIoRU5aWU1FfEJPVHxUSEFOSCBQSEFOfFRZIExFfE5HVVlFTiBMSUVVfEVYVFJBQ1R8T0lMfENPTVBPU0lUSU9OfEFDSUR8UE9MWU1FUnxIT1AgQ0hBVClcYi8udGVzdChmKSkgdHlwZT0iVGjDoG5oIHBo4bqnbi9OZ3V5w6puIGxp4buHdSI7CiAgICBlbHNlIGlmKC9cYihLSUVNIFRSQXxYQUMgRElOSHxETyBMVU9OR3xDSEVDS3xERVRFUk1JTnxNRUFTVVJFfFBIfERPIEFNfE5ISUVUIERPKVxiLy50ZXN0KGYpKSB0eXBlPSJLaeG7g20gc2/DoXQiOwogICAgZWxzZSBpZigvXGIoQ0hBTUJFUnxQVU1QfFRVQkV8QVBQQVJBVFVTfERFVklDRXxTWVNURU18VEhJRVQgQkl8Qk8gUEhBTnxDQVUgVFJVQylcYi8udGVzdChmKSkgdHlwZT0iVGhp4bq/dCBi4buLL0PhuqV1IHRyw7pjIjsKICAgIGNvbnN0IHdvcmRzPXguc3BsaXQoL1xzKy8pLmxlbmd0aDsKICAgIGNvbnN0IGNvbmY9d29yZHM+PTcmJndvcmRzPD00MD8iQ2FvIjp3b3Jkcz49ND8iVHJ1bmcgYsOsbmgiOiJUaOG6pXAiOwogICAgcmV0dXJuIHtpZDpgRiR7U3RyaW5nKGkrMSkucGFkU3RhcnQoMiwiMCIpfWAsdGV4dDp4LHR5cGUsY29uZn07CiAgfSk7Cn0KCmNvbnN0IFNFQVJDSF9TVE9QPW5ldyBTZXQoWwogICJ2YSIsImhvYWMiLCJjdWEiLCJjaG8iLCJ2b2kiLCJ0cm9uZyIsIm5nb2FpIiwidHJlbiIsImR1b2kiLCJ0dSIsImRlbiIsInRhaSIsInRoZW8iLCJzYXUiLCJ0cnVvYyIsImRvIiwibmF5IiwibW90IiwiY2FjIiwibmh1bmciLAogICJkdW9jIiwidGh1YyIsImhpZW4iLCJ0YW8iLCJob24iLCJob3AiLCJkdW5nIiwiZGljaCIsInBob2kiLCJ0cm9uIiwidGh1IiwidHUiLCJvbiIsImRpbmgiLCJkb25nIiwidGhvaSIsInRpZXAiLCJiYW8iLCJnb20iLCJidW9jIiwKICAicXV5IiwidHJpbmgiLCJwaHVvbmciLCJwaGFwIiwic2FuIiwicGhhbSIsImhlIiwidGhvbmciLCJ0aGlldCIsImJpIiwibmhhdCIsImJhbmciLCJjYWNoIiwic3UiLCJkdW5nIiwibmhhbSIsImRlIiwia2hpIiwibmV1IiwiY28iLAogICJ0aGUiLCJsYSIsImxhbSIsInBoYW4iLCJ2YW8iLCJyYSIsImdpdWEiLCJtb3QiLCJoYWkiLCJiYSIsImJvbiIsIm5hbSIsInNhdSIsImJheSIsInRhbSIsImNoaW4iLCJ0dW9uZyIsInVuZyIsImxhbiIsInF1YSIsImRvaSIsInZvaSIsCiAgInRoZSIsImFuZCIsIm9yIiwid2l0aCIsImZyb20iLCJ3aGVyZWluIiwibWV0aG9kIiwicHJvY2VzcyIsImNvbXByaXNpbmciLCJjb21wcmlzZXMiLCJpbmNsdWRpbmciLCJzdGVwIiwic3RlcHMiLCJ1c2luZyIsInVzZWQiLCJ1c2UiLAogICJmaXJzdCIsInNlY29uZCIsInRoaXJkIiwidGhlbiIsInRoZXJlb2YiLCJ0aGVyZWluIiwidGhlcmVieSIsInN1Y2giLCJ0aGF0Iiwid2hpY2giLCJpbnRvIiwib250byIKXSk7CgpmdW5jdGlvbiBmZWF0dXJlQ29yZVRlcm1zKHRleHQpewogIGNvbnN0IG9yaWdpbmFsPW5vcm1hbGl6ZU9jclRleHQodGV4dHx8IiIpOwogIGNvbnN0IHRva2Vucz1bLi4ub3JpZ2luYWwubWF0Y2hBbGwoL1tccHtMfVxwe059XC1cL1wuXSsvZ3UpXS5tYXAobT0+bVswXSk7CiAgY29uc3Qgb3V0PVtdOwogIGZvcihjb25zdCB0b2sgb2YgdG9rZW5zKXsKICAgIGNvbnN0IGY9Zm9sZFZOKHRvaykudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bXmEtejAtOVwtXC9cLl0vZywiIik7CiAgICBpZighZiB8fCBTRUFSQ0hfU1RPUC5oYXMoZikgfHwgZi5sZW5ndGg8NCkgY29udGludWU7CiAgICBpZigvXlxkKyg/OltcLixdXGQrKT8lPyQvLnRlc3QoZikpIGNvbnRpbnVlOwogICAgaWYoIW91dC5zb21lKHg9PmZvbGRWTih4KS50b0xvd2VyQ2FzZSgpPT09ZikpIG91dC5wdXNoKHRvayk7CiAgfQogIHJldHVybiBvdXQuc2xpY2UoMCw4KTsKfQoKZnVuY3Rpb24gbWVhbmluZ2Z1bFRva2Vucyh0ZXh0KXsKICByZXR1cm4gWy4uLm5vcm1hbGl6ZU9jclRleHQodGV4dHx8IiIpLm1hdGNoQWxsKC9bXHB7TH1ccHtOfVwtXC9cLl0rL2d1KV0KICAgIC5tYXAobT0+bVswXSkKICAgIC5maWx0ZXIodG9rPT57CiAgICAgIGNvbnN0IGY9Zm9sZFZOKHRvaykudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bXmEtejAtOVwtXC9cLl0vZywiIik7CiAgICAgIHJldHVybiBmLmxlbmd0aD49NCAmJiAhU0VBUkNIX1NUT1AuaGFzKGYpICYmICEvXlxkKyg/OltcLixdXGQrKT8lPyQvLnRlc3QoZik7CiAgICB9KTsKfQoKZnVuY3Rpb24gdGl0bGVUZWNobmljYWxQaHJhc2UoKXsKICBsZXQgcmF3PXNhbml0aXplUGF0ZW50VGl0bGUoJCgidGl0bGUiKS52YWx1ZXx8IiIpOwogIGlmKCFyYXcpIHJldHVybiAiIjsKCiAgbGV0IHQ9bm9ybWFsaXplT2NyVGV4dChyYXcpCiAgICAucmVwbGFjZSgvXig/OnF1eSB0csOsbmh8cGjGsMahbmcgcGjDoXB8aOG7hyB0aOG7kW5nfHRoaeG6v3QgYuG7i3xz4bqjbiBwaOG6qW18Y2jhur8gcGjhuqltKVxzKyg/OnPhuqNuIHh14bqldHxjaOG6vyB04bqhb3zEkWnhu4F1IGNo4bq/KT9ccyovaSwiIik7CgogIC8vIFJlamVjdCBzdHJpbmdzIGRvbWluYXRlZCBieSBwYWdlIG51bWJlcnMgLyBhcnRpZmFjdHMuCiAgaWYoKHQubWF0Y2goL1xkK1xzKlwvXHMqXGQrL2cpfHxbXSkubGVuZ3RoPj0xKSByZXR1cm4gIiI7CgogIGNvbnN0IHRva3M9bWVhbmluZ2Z1bFRva2Vucyh0KTsKICBpZih0b2tzLmxlbmd0aD49MikgcmV0dXJuIHRva3Muc2xpY2UoMCw3KS5qb2luKCIgIik7CiAgcmV0dXJuICIiOwp9CgpmdW5jdGlvbiB0ZWNobmljYWxQaHJhc2VzRnJvbVRleHQodGV4dCl7CiAgY29uc3QgcmF3PW5vcm1hbGl6ZU9jclRleHQodGV4dHx8IiIpOwogIGNvbnN0IHRva3M9bWVhbmluZ2Z1bFRva2VucyhyYXcpOwogIGNvbnN0IG91dD1bXTsKCiAgLy8gUHJlZmVyIHBocmFzZXMgZXhwbGljaXRseSBwcmVzZW50IGluIHRoZSB0ZWNobmljYWwgZGljdGlvbmFyeS4KICBmb3IoY29uc3QgW2tdIG9mIE9iamVjdC5lbnRyaWVzKGRpY3QpKXsKICAgIGlmKGZvbGRWTihyYXcpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoZm9sZFZOKGspLnRvTG93ZXJDYXNlKCkpICYmIGsuc3BsaXQoL1xzKy8pLmxlbmd0aD49Mil7CiAgICAgIG91dC5wdXNoKGspOwogICAgfQogIH0KCiAgLy8gQnVpbGQgY29tcGFjdCAy4oCTMyB3b3JkIHBocmFzZXMgaW5zdGVhZCBvZiBpc29sYXRlZCBPQ1Igd29yZHMuCiAgZm9yKGxldCBuPTM7bj49MjtuLS0pewogICAgZm9yKGxldCBpPTA7aStuPD10b2tzLmxlbmd0aDtpKyspewogICAgICBjb25zdCBwaHJhc2U9dG9rcy5zbGljZShpLGkrbikuam9pbigiICIpOwogICAgICBjb25zdCBmPWZvbGRWTihwaHJhc2UpLnRvTG93ZXJDYXNlKCk7CiAgICAgIGlmKCFvdXQuc29tZSh4PT5mb2xkVk4oeCkudG9Mb3dlckNhc2UoKT09PWYpKSBvdXQucHVzaChwaHJhc2UpOwogICAgICBpZihvdXQubGVuZ3RoPj04KSBicmVhazsKICAgIH0KICAgIGlmKG91dC5sZW5ndGg+PTgpIGJyZWFrOwogIH0KICByZXR1cm4gb3V0LnNsaWNlKDAsOCk7Cn0KCmZ1bmN0aW9uIHF1ZXJ5UXVhbGl0eShxKXsKICBjb25zdCB3b3Jkcz1tZWFuaW5nZnVsVG9rZW5zKFN0cmluZyhxKS5yZXBsYWNlKC9cYkFORFxifFxiT1JcYi9naSwiICIpKTsKICBjb25zdCB1bmlxPVsuLi5uZXcgU2V0KHdvcmRzLm1hcCh4PT5mb2xkVk4oeCkudG9Mb3dlckNhc2UoKSkpXTsKICByZXR1cm4gewogICAgb2s6IHVuaXEubGVuZ3RoPj0yLAogICAgdGVybXM6IHVuaXEsCiAgICBzY29yZTogTWF0aC5taW4oMTAwLHVuaXEubGVuZ3RoKjIyKQogIH07Cn0KCgpmdW5jdGlvbiBidWlsZFByb1NlYXJjaFJvd3MoKXsKICByZXR1cm4gc3RhdGUuZmVhdHVyZXMubWFwKGY9PnsKICAgIGNvbnN0IHBocmFzZXM9dGVjaG5pY2FsUGhyYXNlc0Zyb21UZXh0KGYudGV4dCk7CiAgICBjb25zdCB0ZXJtcz1mZWF0dXJlQ29yZVRlcm1zKGYudGV4dCk7CiAgICBjb25zdCBmb3VuZD1bXTsKICAgIGZvcihjb25zdCBbayx2XSBvZiBPYmplY3QuZW50cmllcyhkaWN0KSl7CiAgICAgIGlmKGZvbGRWTihmLnRleHQpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoZm9sZFZOKGspLnRvTG93ZXJDYXNlKCkpKSBmb3VuZC5wdXNoKGssLi4udik7CiAgICB9CiAgICBjb25zdCBhbGw9Wy4uLnBocmFzZXMsLi4uZm91bmQsLi4udGVybXNdLmZpbHRlcigoeCxpLGEpPT54JiZhLmZpbmRJbmRleCh5PT5mb2xkVk4oeSk9PT1mb2xkVk4oeCkpPT09aSk7CiAgICBjb25zdCBwcmltYXJ5PWFsbFswXXx8IiI7CiAgICBjb25zdCBzeW5vbnltcz1hbGwuc2xpY2UoMSw1KTsKICAgIHJldHVybiBbZi5pZCxwcmltYXJ5LHN5bm9ueW1zLmpvaW4oIjsgIil8fCLigJQiLCQoImlwYyIpLnZhbHVlfHwiQ+G6p24gY2h1ecOqbiBnaWEgeMOhYyDEkeG7i25oIl07CiAgfSkuZmlsdGVyKHI9PnJbMV0pOwp9CgpmdW5jdGlvbiBidWlsZFByb1F1ZXJpZXMocm93cyl7CiAgY29uc3QgcGhyYXNlcz1bXTsKICBjb25zdCB0aXRsZVBocmFzZT10aXRsZVRlY2huaWNhbFBocmFzZSgpOwogIGlmKHRpdGxlUGhyYXNlKSBwaHJhc2VzLnB1c2godGl0bGVQaHJhc2UpOwoKICBmb3IoY29uc3QgciBvZiByb3dzKXsKICAgIGNvbnN0IHZhbHM9W3JbMV0sLi4uKHJbMl09PT0i4oCUIj9bXTpyWzJdLnNwbGl0KCI7IikubWFwKHg9PngudHJpbSgpKSldOwogICAgZm9yKGNvbnN0IHYgb2YgdmFscyl7CiAgICAgIGlmKCF2KSBjb250aW51ZTsKICAgICAgY29uc3QgcT1xdWVyeVF1YWxpdHkodik7CiAgICAgIGlmKHEub2sgJiYgIXBocmFzZXMuc29tZSh4PT5mb2xkVk4oeCk9PT1mb2xkVk4odikpKSBwaHJhc2VzLnB1c2godik7CiAgICB9CiAgfQoKICBjb25zdCBxdWVyaWVzPVtdOwogIGNvbnN0IGFkZD1xPT57CiAgICBxPShxfHwiIikudHJpbSgpOwogICAgaWYoIXEgfHwgIXF1ZXJ5UXVhbGl0eShxKS5vaykgcmV0dXJuOwogICAgaWYoIXF1ZXJpZXMuc29tZSh4PT5mb2xkVk4oeCk9PT1mb2xkVk4ocSkpKSBxdWVyaWVzLnB1c2gocSk7CiAgfTsKCiAgLy8gSGlnaGVzdCBwcmVjaXNpb246IHRpdGxlIGNvbmNlcHQgKyBvbmUgZmVhdHVyZSBjb25jZXB0LgogIGlmKHRpdGxlUGhyYXNlICYmIHBocmFzZXNbMV0pIGFkZChgIiR7dGl0bGVQaHJhc2V9IiBBTkQgIiR7cGhyYXNlc1sxXX0iYCk7CiAgaWYodGl0bGVQaHJhc2UpIGFkZChgIiR7dGl0bGVQaHJhc2V9ImApOwoKICAvLyBCcm9hZGVyIHJlY2FsbCBxdWVyaWVzLgogIGlmKHBocmFzZXMubGVuZ3RoPj0yKSBhZGQocGhyYXNlcy5zbGljZSgwLDIpLm1hcCh4PT5gIiR7eH0iYCkuam9pbigiIEFORCAiKSk7CiAgaWYocGhyYXNlcy5sZW5ndGg+PTMpIGFkZChwaHJhc2VzLnNsaWNlKDEsMykubWFwKHg9PmAiJHt4fSJgKS5qb2luKCIgQU5EICIpKTsKCiAgLy8gTGFzdCBmYWxsYmFjazogMy02IHNpZ25pZmljYW50IHRlY2huaWNhbCB0b2tlbnMgZnJvbSB0aXRsZSArIHNlbGVjdGVkIGNsYWltLgogIGNvbnN0IGM9c3RhdGUuY2xhaW1zW3N0YXRlLnNlbGVjdGVkXXx8c3RhdGUuY2xhaW1zWzBdOwogIGNvbnN0IHRva2VuUG9vbD1bLi4ubWVhbmluZ2Z1bFRva2VucygkKCJ0aXRsZSIpLnZhbHVlfHwiIiksLi4ubWVhbmluZ2Z1bFRva2VucyhjP2MudGV4dDoiIildOwogIGNvbnN0IHVuaXE9W107CiAgZm9yKGNvbnN0IHggb2YgdG9rZW5Qb29sKXsKICAgIGNvbnN0IGY9Zm9sZFZOKHgpLnRvTG93ZXJDYXNlKCk7CiAgICBpZighdW5pcS5zb21lKHk9PmZvbGRWTih5KS50b0xvd2VyQ2FzZSgpPT09ZikpIHVuaXEucHVzaCh4KTsKICB9CiAgaWYodW5pcS5sZW5ndGg+PTIpIGFkZCh1bmlxLnNsaWNlKDAsNikuam9pbigiICIpKTsKCiAgcmV0dXJuIHF1ZXJpZXMuc2xpY2UoMCw2KTsKfQokKCJhdXRvRmVhdHVyZXMiKS5vbmNsaWNrPSgpPT57bGV0IGM9c3RhdGUuY2xhaW1zWyskKCJjbGFpbVNlbGVjdCIpLnZhbHVlfHwwXTtpZighYylyZXR1cm4gYWxlcnQoIkNoxrBhIGPDsyBjbGFpbS4iKTtzdGF0ZS5zZWxlY3RlZD0rJCgiY2xhaW1TZWxlY3QiKS52YWx1ZXx8MDtzdGF0ZS5mZWF0dXJlcz1mZWF0dXJlU3BsaXQoYy50ZXh0KTtyZW5kZXJGZWF0dXJlcygpOyQoImZlYXR1cmVTdGF0dXMiKS52YWx1ZT0iQuG6o24gbmjDoXAgdOG7sSDEkeG7mW5nIjtzdGF0ZS5jb25maXJtZWQ9ZmFsc2U7dXBkYXRlRmVhdHVyZVJldmlld1VJKCl9OwokKCJjb25maXJtRmVhdHVyZXMiKS5vbmNsaWNrPSgpPT57aWYoIXN0YXRlLmZlYXR1cmVzLmxlbmd0aClyZXR1cm4gYWxlcnQoIkNoxrBhIGPDsyBk4bqldSBoaeG7h3UuIik7c3RhdGUuY29uZmlybWVkPXRydWU7dXBkYXRlRmVhdHVyZVJldmlld1VJKCk7YWxlcnQoIsSQw6MgeMOhYyBuaOG6rW4gYuG7mSBk4bqldSBoaeG7h3UuIELhuqFuIGPDsyB0aOG7gyB0aeG6v3AgdOG7pWMgc2FuZyBixrDhu5tjIHRyYSBj4bupdS4iKX07CgpmdW5jdGlvbiB1cGRhdGVGZWF0dXJlUmV2aWV3VUkoKXsKICBjb25zdCBuPXN0YXRlLmZlYXR1cmVzLmxlbmd0aDsKICBjb25zdCBiYXI9JCgiZmVhdHVyZVJldmlld0JhciIpOwogIGNvbnN0IGJhZGdlPSQoImZlYXR1cmVTdGF0dXNCYWRnZSIpOwogIGNvbnN0IGxhYmVsPSQoImZlYXR1cmVDb3VudExhYmVsIik7CiAgaWYoIWJhcnx8IWJhZGdlfHwhbGFiZWwpIHJldHVybjsKICBsYWJlbC50ZXh0Q29udGVudD1uP2Ake259IGThuqV1IGhp4buHdSBr4bu5IHRodeG6rXRgOiJDaMawYSBjw7MgZOG6pXUgaGnhu4d1IjsKICBpZihzdGF0ZS5jb25maXJtZWQpewogICAgYmFyLmNsYXNzTGlzdC5hZGQoImZlYXR1cmUtY29uZmlybWVkIik7CiAgICBiYWRnZS5jbGFzc05hbWU9InBpbGwgZ3JlZW4iOwogICAgYmFkZ2UudGV4dENvbnRlbnQ9IsSQw6MgeMOhYyBuaOG6rW4iOwogICAgJCgiZmVhdHVyZVN0YXR1cyIpLnZhbHVlPSLEkMOjIHjDoWMgbmjhuq1uIjsKICAgICQoImNvbmZpcm1GZWF0dXJlcyIpLnRleHRDb250ZW50PSLinJMgxJDDoyB4w6FjIG5o4bqtbiBi4buZIGThuqV1IGhp4buHdSI7CiAgfWVsc2V7CiAgICBiYXIuY2xhc3NMaXN0LnJlbW92ZSgiZmVhdHVyZS1jb25maXJtZWQiKTsKICAgIGJhZGdlLmNsYXNzTmFtZT0icGlsbCB5ZWxsb3ciOwogICAgYmFkZ2UudGV4dENvbnRlbnQ9IkNoxrBhIHjDoWMgbmjhuq1uIjsKICAgICQoImZlYXR1cmVTdGF0dXMiKS52YWx1ZT1uPyJC4bqjbiBuaMOhcCB04buxIMSR4buZbmciOiJDaMawYSB04bqhbyI7CiAgICAkKCJjb25maXJtRmVhdHVyZXMiKS50ZXh0Q29udGVudD0i4pyTIFjDoWMgbmjhuq1uIGLhu5kgZOG6pXUgaGnhu4d1IjsKICB9Cn0KZnVuY3Rpb24gcmVuZGVyRmVhdHVyZXMoKXsKICQoImZlYXR1cmVCb2R5IikuaW5uZXJIVE1MPXN0YXRlLmZlYXR1cmVzLm1hcCgoZixpKT0+YDx0cj48dGQ+PHN0cm9uZz4ke2YuaWR9PC9zdHJvbmc+PC90ZD48dGQ+PHRleHRhcmVhIGRhdGEtZnQ9IiR7aX0iIHN0eWxlPSJtaW4taGVpZ2h0OjcycHgiPiR7ZXNjKGYudGV4dCl9PC90ZXh0YXJlYT48L3RkPjx0ZD48c2VsZWN0IGRhdGEtdHk9IiR7aX0iPjxvcHRpb24gJHtmLnR5cGU9PT0iUXV5IHRyw6xuaCI/InNlbGVjdGVkIjoiIn0+UXV5IHRyw6xuaDwvb3B0aW9uPjxvcHRpb24gJHtmLnR5cGU9PT0iVGjDoG5oIHBo4bqnbi9OZ3V5w6puIGxp4buHdSI/InNlbGVjdGVkIjoiIn0+VGjDoG5oIHBo4bqnbi9OZ3V5w6puIGxp4buHdTwvb3B0aW9uPjxvcHRpb24gJHtmLnR5cGU9PT0iS2nhu4NtIHNvw6F0Ij8ic2VsZWN0ZWQiOiIifT5LaeG7g20gc2/DoXQ8L29wdGlvbj48b3B0aW9uICR7Zi50eXBlPT09IlRoaeG6v3QgYuG7iy9D4bqldSB0csO6YyI/InNlbGVjdGVkIjoiIn0+VGhp4bq/dCBi4buLL0PhuqV1IHRyw7pjPC9vcHRpb24+PC9zZWxlY3Q+PC90ZD48dGQ+PHNwYW4gY2xhc3M9InBpbGwgeWVsbG93Ij4ke2YuY29uZn08L3NwYW4+PC90ZD48dGQ+PGJ1dHRvbiBjbGFzcz0iYnRuIGRhbmdlciIgZGF0YS1kZWw9IiR7aX0iPsOXPC9idXR0b24+PC90ZD48L3RyPmApLmpvaW4oIiIpOwogZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtZnRdIikuZm9yRWFjaCh4PT54Lm9uY2hhbmdlPSgpPT5zdGF0ZS5mZWF0dXJlc1sreC5kYXRhc2V0LmZ0XS50ZXh0PXgudmFsdWUpO2RvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLXR5XSIpLmZvckVhY2goeD0+eC5vbmNoYW5nZT0oKT0+c3RhdGUuZmVhdHVyZXNbK3guZGF0YXNldC50eV0udHlwZT14LnZhbHVlKTtkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1kZWxdIikuZm9yRWFjaCh4PT54Lm9uY2xpY2s9KCk9PntzdGF0ZS5mZWF0dXJlcy5zcGxpY2UoK3guZGF0YXNldC5kZWwsMSk7c3RhdGUuY29uZmlybWVkPWZhbHNlO3JlbmRlckZlYXR1cmVzKCl9KTt1cGRhdGVGZWF0dXJlUmV2aWV3VUkoKQp9Cgpjb25zdCBkaWN0PXsiaOG6oXQgdGhhbmggbG9uZyI6WyJkcmFnb24gZnJ1aXQgc2VlZCIsInBpdGF5YSBzZWVkIiwiSHlsb2NlcmV1cyBzZWVkIl0sIm7huqN5IG3huqdtIjpbImdlcm1pbmF0aW9uIiwiZ2VybWluYXRlZCIsInNwcm91dGluZyJdLCJjZWxsdWxhc2UiOlsiY2VsbHVsYXNlIiwiY2VsbHVsYXNlIHRyZWF0bWVudCJdLCJwZWN0aW5hc2UiOlsicGVjdGluYXNlIiwicGVjdGluYXNlIHRyZWF0bWVudCJdLCJz4bqleSI6WyJkcnlpbmciLCJkZWh5ZHJhdGlvbiJdLCJuZ2hp4buBbiI6WyJncmluZGluZyIsIm1pbGxpbmciXSwiYuG7mXQgbmjDoHUiOlsibm9uaSBwb3dkZXIiLCJNb3JpbmRhIGNpdHJpZm9saWEgcG93ZGVyIl0sIsSR4buZIOG6qW0iOlsibW9pc3R1cmUgY29udGVudCIsIm1vaXN0dXJlIGFkanVzdG1lbnQiXSwixJHDs25nIGfDs2kiOlsicGFja2FnaW5nIiwicGFja2luZyJdLCJmcmVlemUgZHJ5aW5nIjpbImx5b3BoaWxpemF0aW9uIiwiZnJlZXplIGRyeWVyIl0sIm1vc3F1aXRvIjpbIm1vc3F1aXRvIHJlcGVsbGVudCIsImluc2VjdCByZXBlbGxlbnQiXSwiZXNzZW50aWFsIG9pbCI6WyJleHRyYWN0IiwiYXJvbWF0aWMgb2lsIl19OwokKCJnZW5TZWFyY2giKS5vbmNsaWNrPSgpPT57CiAgc3RhdGUuc2VhcmNoPWJ1aWxkUHJvU2VhcmNoUm93cygpOwogIHN0YXRlLnF1ZXJpZXM9YnVpbGRQcm9RdWVyaWVzKHN0YXRlLnNlYXJjaCk7CiAgcmVuZGVyU2VhcmNoKCk7Cn07CmZ1bmN0aW9uIHJlbmRlclNlYXJjaCgpeyQoInNlYXJjaEJvZHkiKS5pbm5lckhUTUw9c3RhdGUuc2VhcmNoLm1hcChyPT5gPHRyPjx0ZD48c3Ryb25nPiR7clswXX08L3N0cm9uZz48L3RkPjx0ZD4ke2VzYyhyWzFdKX08L3RkPjx0ZD4ke2VzYyhyWzJdKX08L3RkPjx0ZD4ke2VzYyhyWzNdKX08L3RkPjwvdHI+YCkuam9pbigiIik7JCgicXVlcnlMaXN0IikuaW5uZXJIVE1MPXN0YXRlLnF1ZXJpZXMubWFwKChxLGkpPT5gPGRpdiBjbGFzcz0iY2FsbG91dCI+PHN0cm9uZz5RJHtpKzF9PC9zdHJvbmc+PGJyLz48Y29kZT4ke2VzYyhxKX08L2NvZGU+PC9kaXY+YCkuam9pbigiIil9CgoKZnVuY3Rpb24gYmFja2VuZEJhc2UoKXsKICByZXR1cm4gbG9jYXRpb24ub3JpZ2luOwp9CmZ1bmN0aW9uIHNhdmVCYWNrZW5kKCl7CiAgc3RhdGUuYmFja2VuZFVybD1sb2NhdGlvbi5vcmlnaW47Cn0KZnVuY3Rpb24gdXBkYXRlT2ZmaWNpYWxTZWFyY2hMaW5rcyhxKXsKICBjb25zdCBxdWVyeT1xfHwkKCJsaXZlU2VhcmNoUXVlcnkiKS52YWx1ZXx8c3RhdGUucXVlcmllc1swXXx8IiI7CiAgJCgiZ3BMaW5rIikuaHJlZj0iaHR0cHM6Ly9wYXRlbnRzLmdvb2dsZS5jb20vP3E9IitlbmNvZGVVUklDb21wb25lbnQocXVlcnkpOwogICQoIndpcG9MaW5rIikuaHJlZj0iaHR0cHM6Ly9wYXRlbnRzY29wZS53aXBvLmludC9zZWFyY2gvZW4vYWR2YW5jZWRTZWFyY2guanNmP3F1ZXJ5PSIrZW5jb2RlVVJJQ29tcG9uZW50KCdFTl9BTExUWFQ6KCcrcXVlcnkrJyknKTsKICAkKCJlcG9MaW5rIikuaHJlZj0iaHR0cHM6Ly93b3JsZHdpZGUuZXNwYWNlbmV0LmNvbS9wYXRlbnQvc2VhcmNoP3E9IitlbmNvZGVVUklDb21wb25lbnQocXVlcnkpOwp9CmZ1bmN0aW9uIHVzZUdlbmVyYXRlZFF1ZXJ5KCl7CiAgbGV0IHE9IiI7CiAgaWYoc3RhdGUucXVlcmllcy5sZW5ndGgpewogICAgcT1zdGF0ZS5xdWVyaWVzWzBdOwogIH1lbHNlIGlmKHN0YXRlLmZlYXR1cmVzLmxlbmd0aCl7CiAgICBjb25zdCByb3dzPWJ1aWxkUHJvU2VhcmNoUm93cygpOwogICAgY29uc3QgcXM9YnVpbGRQcm9RdWVyaWVzKHJvd3MpOwogICAgcT1xc1swXXx8IiI7CiAgfWVsc2V7CiAgICBxPSQoInRpdGxlIikudmFsdWV8fCIiOwogIH0KICAkKCJsaXZlU2VhcmNoUXVlcnkiKS52YWx1ZT1xOwogIHVwZGF0ZU9mZmljaWFsU2VhcmNoTGlua3MocSk7CiAgcmV0dXJuIHE7Cn0KZnVuY3Rpb24gY2xlYW5QYXRlbnRIdG1sKHMpewogIGNvbnN0IGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgidGV4dGFyZWEiKTsKICBkLmlubmVySFRNTD0oc3x8IiIpLnJlcGxhY2UoLzxbXj5dKj4vZywiICIpOwogIHJldHVybiBkLnZhbHVlLnJlcGxhY2UoL1xzKy9nLCIgIikudHJpbSgpOwp9CmZ1bmN0aW9uIHRhcmdldERhdGVPYmooKXsKICBjb25zdCB2PSQoImZpbGluZ0RhdGUiKS52YWx1ZTsKICByZXR1cm4gdj9uZXcgRGF0ZSh2KyJUMDA6MDA6MDAiKTpudWxsOwp9CmZ1bmN0aW9uIGNhbmRpZGF0ZURhdGVTdGF0dXMoYyl7CiAgY29uc3QgdGQ9dGFyZ2V0RGF0ZU9iaigpOwogIGNvbnN0IGQ9Yy5wdWJsaWNhdGlvbl9kYXRlfHxjLnByaW9yaXR5X2RhdGV8fGMuZmlsaW5nX2RhdGV8fCIiOwogIGlmKCF0ZHx8IWQpIHJldHVybiB7bGFiZWw6IkPhuqduIHjDoWMgbWluaCIsY2xzOiJ5ZWxsb3ciLGVsaWdpYmxlOm51bGx9OwogIGNvbnN0IGNkPW5ldyBEYXRlKGQpOwogIGlmKGlzTmFOKGNkKSkgcmV0dXJuIHtsYWJlbDoiQ+G6p24geMOhYyBtaW5oIixjbHM6InllbGxvdyIsZWxpZ2libGU6bnVsbH07CiAgY29uc3Qgb2s9Y2Q8dGQ7CiAgcmV0dXJuIHtsYWJlbDpvaz8iVHLGsOG7m2MgbeG7kWMgdGFyZ2V0IjoiU2F1IG3hu5FjIHRhcmdldCIsY2xzOm9rPyJncmVlbiI6InJlZCIsZWxpZ2libGU6b2t9Owp9CmZ1bmN0aW9uIGZlYXR1cmVUZXJtcygpewogIGNvbnN0IHN0b3A9bmV3IFNldChbImJhbyIsImfhu5NtIiwidHJvbmciLCJj4bunYSIsIsSRxrDhu6NjIiwidsOgIiwidGhlIiwid2l0aCIsImZyb20iLCJ3aGVyZWluIiwibWV0aG9kIiwicHJvY2VzcyJdKTsKICBjb25zdCB0ZXJtcz1bXTsKICBmb3IoY29uc3QgZiBvZiBzdGF0ZS5mZWF0dXJlcyl7CiAgICBmb3IoY29uc3QgdyBvZiBmb2xkVk4oZi50ZXh0KS50b0xvd2VyQ2FzZSgpLnNwbGl0KC9bXmEtejAtOV0rLykpewogICAgICBpZih3Lmxlbmd0aD49NCYmIXN0b3AuaGFzKHcpKSB0ZXJtcy5wdXNoKHcpOwogICAgfQogIH0KICByZXR1cm4gWy4uLm5ldyBTZXQodGVybXMpXS5zbGljZSgwLDgwKTsKfQpmdW5jdGlvbiBzY29yZUNhbmRpZGF0ZShjKXsKICBjb25zdCBibG9iPWZvbGRWTihbYy50aXRsZSxjLnNuaXBwZXQsYy5hc3NpZ25lZV0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oIiAiKSkudG9Mb3dlckNhc2UoKTsKICBjb25zdCB0ZXJtcz1mZWF0dXJlVGVybXMoKTsKICBpZighdGVybXMubGVuZ3RoKSByZXR1cm4gNTA7CiAgbGV0IGhpdD0wOwogIGZvcihjb25zdCB0IG9mIHRlcm1zKSBpZihibG9iLmluY2x1ZGVzKHQpKSBoaXQrKzsKICBsZXQgc2NvcmU9TWF0aC5yb3VuZCgoaGl0L01hdGgubWluKHRlcm1zLmxlbmd0aCwyMCkpKjEwMCk7CiAgY29uc3QgZHM9Y2FuZGlkYXRlRGF0ZVN0YXR1cyhjKTsKICBpZihkcy5lbGlnaWJsZT09PWZhbHNlKSBzY29yZT1NYXRoLm1heCgwLHNjb3JlLTM1KTsKICByZXR1cm4gTWF0aC5taW4oOTksc2NvcmUpOwp9CmZ1bmN0aW9uIHJlbmRlckNhbmRpZGF0ZXMoKXsKICBpZighc3RhdGUuY2FuZGlkYXRlcy5sZW5ndGgpewogICAgJCgiY2FuZGlkYXRlQm9keSIpLmlubmVySFRNTD0nPHRyPjx0ZCBjb2xzcGFuPSI2IiBzdHlsZT0iY29sb3I6Izk4YTJiMzt0ZXh0LWFsaWduOmNlbnRlciI+S2jDtG5nIGPDsyBr4bq/dCBxdeG6oyDEkeG7gyBoaeG7g24gdGjhu4suPC90ZD48L3RyPic7CiAgICByZXR1cm47CiAgfQogICQoImNhbmRpZGF0ZUJvZHkiKS5pbm5lckhUTUw9c3RhdGUuY2FuZGlkYXRlcy5tYXAoKGMsaSk9PnsKICAgIGMuc2NvcmU9c2NvcmVDYW5kaWRhdGUoYyk7CiAgICBjb25zdCBkcz1jYW5kaWRhdGVEYXRlU3RhdHVzKGMpOwogICAgY29uc3Qgc2NvcmVDbHM9Yy5zY29yZT49NjU/ImhpZ2giOmMuc2NvcmU+PTM1PyJtaWQiOiJsb3ciOwogICAgY29uc3QgZGF0ZT1jLnB1YmxpY2F0aW9uX2RhdGV8fGMucHJpb3JpdHlfZGF0ZXx8Yy5maWxpbmdfZGF0ZXx8IuKAlCI7CiAgICByZXR1cm4gYDx0cj4KICAgICAgPHRkPiR7aSsxfTwvdGQ+CiAgICAgIDx0ZCBzdHlsZT0ibWluLXdpZHRoOjMzMHB4Ij4KICAgICAgICA8YSBjbGFzcz0ic2VhcmNoLXJlc3VsdC10aXRsZSIgaHJlZj0iJHtlc2MoYy51cmwpfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPiR7ZXNjKGMucHVibGljYXRpb25fbnVtYmVyfHwiUGF0ZW50Iil9IMK3ICR7ZXNjKGMudGl0bGV8fCJLaMO0bmcgY8OzIHRpw6p1IMSR4buBIil9PC9hPgogICAgICAgIDxkaXYgY2xhc3M9InN0YXR1cyIgc3R5bGU9Im1hcmdpbi10b3A6NXB4Ij4ke2VzYyhjLnNuaXBwZXR8fCIiKX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJzb3VyY2Utcm93IiBzdHlsZT0ibWFyZ2luLXRvcDo3cHgiPgogICAgICAgICAgPGEgY2xhc3M9InNvdXJjZS1jaGlwIiBocmVmPSIke2VzYyhjLnVybCl9IiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciI+R29vZ2xlIFBhdGVudHMg4oaXPC9hPgogICAgICAgICAgPGEgY2xhc3M9InNvdXJjZS1jaGlwIiBocmVmPSJodHRwczovL3BhdGVudHNjb3BlLndpcG8uaW50L3NlYXJjaC9lbi9hZHZhbmNlZFNlYXJjaC5qc2Y/cXVlcnk9JHtlbmNvZGVVUklDb21wb25lbnQoJ0FMTE5VTTooJytjLnB1YmxpY2F0aW9uX251bWJlcisnKScpfSIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiPldJUE8g4oaXPC9hPgogICAgICAgICAgPGEgY2xhc3M9InNvdXJjZS1jaGlwIiBocmVmPSJodHRwczovL3dvcmxkd2lkZS5lc3BhY2VuZXQuY29tL3BhdGVudC9zZWFyY2g/cT0ke2VuY29kZVVSSUNvbXBvbmVudCgncG49JytjLnB1YmxpY2F0aW9uX251bWJlcil9IiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciI+RXNwYWNlbmV0IOKGlzwvYT4KICAgICAgICA8L2Rpdj4KICAgICAgPC90ZD4KICAgICAgPHRkPiR7ZXNjKGRhdGUpfTwvdGQ+CiAgICAgIDx0ZD48c3BhbiBjbGFzcz0ic2NvcmUgJHtzY29yZUNsc30iPiR7Yy5zY29yZX0lPC9zcGFuPjwvdGQ+CiAgICAgIDx0ZD48c3BhbiBjbGFzcz0icGlsbCAke2RzLmNsc30iPiR7ZHMubGFiZWx9PC9zcGFuPjwvdGQ+CiAgICAgIDx0ZD48ZGl2IGNsYXNzPSJjYW5kaWRhdGUtYWN0aW9ucyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0ic2xvdGJ0biIgZGF0YS1zbG90PSJEMSIgZGF0YS1jYW5kaWRhdGU9IiR7aX0iPkQxPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0ic2xvdGJ0biIgZGF0YS1zbG90PSJEMiIgZGF0YS1jYW5kaWRhdGU9IiR7aX0iPkQyPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0ic2xvdGJ0biIgZGF0YS1zbG90PSJEMyIgZGF0YS1jYW5kaWRhdGU9IiR7aX0iPkQzPC9idXR0b24+CiAgICAgIDwvZGl2PjwvdGQ+CiAgICA8L3RyPmA7CiAgfSkuam9pbigiIik7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtY2FuZGlkYXRlXSIpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT5zZWxlY3RDYW5kaWRhdGVUb1Nsb3QoK2IuZGF0YXNldC5jYW5kaWRhdGUsYi5kYXRhc2V0LnNsb3QpKTsKfQphc3luYyBmdW5jdGlvbiBzZWFyY2hSZWFsUGF0ZW50cygpewogIGxldCBxPSQoImxpdmVTZWFyY2hRdWVyeSIpLnZhbHVlLnRyaW0oKXx8dXNlR2VuZXJhdGVkUXVlcnkoKTsKICBpZighcXVlcnlRdWFsaXR5KHEpLm9rKXsKICAgIGNvbnN0IHJvd3M9YnVpbGRQcm9TZWFyY2hSb3dzKCk7CiAgICBjb25zdCBxcz1idWlsZFByb1F1ZXJpZXMocm93cyk7CiAgICBxPXFzWzBdfHx0aXRsZVRlY2huaWNhbFBocmFzZSgpOwogICAgJCgibGl2ZVNlYXJjaFF1ZXJ5IikudmFsdWU9cTsKICB9CiAgaWYoIXF1ZXJ5UXVhbGl0eShxKS5vayl7CiAgICAkKCJsaXZlU2VhcmNoU3RhdGUiKS5pbm5lckhUTUw9JzxzcGFuIGNsYXNzPSJiYWNrZW5kLWJhZCI+VHJ1eSB24bqlbiBoaeG7h24gdOG6oWkgcXXDoSBjaHVuZyBob+G6t2MgYuG7iyBs4buXaSBPQ1IuPC9zcGFuPiBIw6N5IHF1YXkgbOG6oWkga2nhu4NtIHRyYSBDbGFpbS9E4bqldSBoaeG7h3Uga+G7uSB0aHXhuq10IGhv4bq3YyBuaOG6rXAgw610IG5o4bqldCAyIHRodeG6rXQgbmfhu68ga+G7uSB0aHXhuq10Lic7CiAgICByZXR1cm47CiAgfQogIHVwZGF0ZU9mZmljaWFsU2VhcmNoTGlua3MocSk7CiAgaWYoIXEpIHJldHVybiBhbGVydCgiQ2jGsGEgY8OzIHRydXkgduG6pW4gdHJhIGPhu6l1LiIpOwogIGNvbnN0IGJhc2U9YmFja2VuZEJhc2UoKTsKICBzYXZlQmFja2VuZCgpOwogICQoImxpdmVTZWFyY2hTdGF0ZSIpLnRleHRDb250ZW50PSLEkGFuZyB0cmEgY+G7qXUgcGF0ZW50IHRo4bqtdCBxdWEgYuG7mSBtw6F5IHTDrG0ga2nhur9tLi4uIjsKICAkKCJsaXZlU2VhcmNoQnRuIikuZGlzYWJsZWQ9dHJ1ZTsKICB0cnl7CiAgICBjb25zdCB1cmw9YmFzZSsiL2FwaS9zZWFyY2g/cT0iK2VuY29kZVVSSUNvbXBvbmVudChxKSsiJnRpdGxlPSIrZW5jb2RlVVJJQ29tcG9uZW50KCQoInRpdGxlIikudmFsdWV8fCIiKSsiJm51bT0yMCI7CiAgICBjb25zdCByPWF3YWl0IGZldGNoKHVybCk7CiAgICBjb25zdCBkYXRhPWF3YWl0IHIuanNvbigpOwogICAgaWYoIXIub2t8fCFkYXRhLm9rKSB0aHJvdyBuZXcgRXJyb3IoZGF0YS5lcnJvcnx8KCJIVFRQICIrci5zdGF0dXMpKTsKICAgIGlmKGRhdGEucXVlcnlfdXNlZCl7JCgibGl2ZVNlYXJjaFF1ZXJ5IikudmFsdWU9ZGF0YS5xdWVyeV91c2VkO3VwZGF0ZU9mZmljaWFsU2VhcmNoTGlua3MoZGF0YS5xdWVyeV91c2VkKX0KICAgIHN0YXRlLmNhbmRpZGF0ZXM9KGRhdGEucmVzdWx0c3x8W10pLm1hcCh4PT4oey4uLngsc2NvcmU6MH0pKTsKICAgIHN0YXRlLmNhbmRpZGF0ZXMuc29ydCgoYSxiKT0+c2NvcmVDYW5kaWRhdGUoYiktc2NvcmVDYW5kaWRhdGUoYSkpOwogICAgcmVuZGVyQ2FuZGlkYXRlcygpOwogICAgJCgibGl2ZVNlYXJjaFN0YXRlIikuaW5uZXJIVE1MPWDEkMOjIG5o4bqtbiA8c3Ryb25nPiR7c3RhdGUuY2FuZGlkYXRlcy5sZW5ndGh9PC9zdHJvbmc+IGvhur90IHF14bqjIHThu6sgPHN0cm9uZz4ke2VzYyhkYXRhLnByb3ZpZGVyfHxkYXRhLnNvdXJjZXx8Im5ndeG7k24gcGF0ZW50Iil9PC9zdHJvbmc+LiBUcnV5IHbhuqVuIHRo4buxYyBkw7luZzogPHN0cm9uZz4ke2VzYyhkYXRhLnF1ZXJ5X3VzZWR8fHEpfTwvc3Ryb25nPiR7ZGF0YS5hdHRlbXB0X2NvdW50P2AgwrcgxJHDoyB0aOG7rSAke2RhdGEuYXR0ZW1wdF9jb3VudH0gbeG7qWMgdHJ1eSB24bqlbmA6IiJ9LmA7CiAgfWNhdGNoKGUpewogICAgY29uc29sZS5lcnJvcihlKTsKICAgIGNvbnN0IG1zZz1TdHJpbmcoZS5tZXNzYWdlfHxlKTsKICAgIGNvbnN0IGhpbnQ9LzUwM3xSQVRFX0xJTUlUfEdPT0dMRV9CTE9DS0VEL2kudGVzdChtc2cpCiAgICAgID8gIjxicj48c3Ryb25nPkdvb2dsZSBQYXRlbnRzIMSRYW5nIGNo4bq3biB0cnV5IHbhuqVuIHThu7EgxJHhu5luZyB04burIElQIGRhdGFjZW50ZXIuPC9zdHJvbmc+IEjhu4cgdGjhu5FuZyBz4bq9IMawdSB0acOqbiBCcm93c2VyIFJ1bi9TZXJwQXBpIG7hur91IMSRxrDhu6NjIGPhuqV1IGjDrG5oOyBHb29nbGUgZGlyZWN0IGNo4buJIGzDoCBmYWxsYmFjazsgY8OhYyBsaW5rIEdvb2dsZS9XSVBPL0VQTyBwaMOtYSB0csOqbiB24bqrbiBsw6Agbmd14buTbiBraeG7g20gY2jhu6luZy4iCiAgICAgIDogIiI7CiAgICAkKCJsaXZlU2VhcmNoU3RhdGUiKS5pbm5lckhUTUw9YDxzcGFuIGNsYXNzPSJiYWNrZW5kLWJhZCI+VHJhIGPhu6l1IHThu7EgxJHhu5luZyBjaMawYSB0aMOgbmggY8O0bmc6ICR7ZXNjKG1zZyl9PC9zcGFuPiR7aGludH08YnI+QuG6oW4gduG6q24gY8OzIHRo4buDIG3hu58gdHLhu7FjIHRp4bq/cCBjw6FjIG5ndeG7k24gY2jDrW5oIHRo4bupYyBwaMOtYSB0csOqbi5gOwogIH1maW5hbGx5ewogICAgJCgibGl2ZVNlYXJjaEJ0biIpLmRpc2FibGVkPWZhbHNlOwogIH0KfQphc3luYyBmdW5jdGlvbiBzZWxlY3RDYW5kaWRhdGVUb1Nsb3QoaSxzbG90KXsKICBjb25zdCBjPXN0YXRlLmNhbmRpZGF0ZXNbaV07CiAgaWYoIWMpIHJldHVybjsKICBjb25zdCBuPXNsb3Quc2xpY2UoMSk7CiAgY29uc3QgYmFzZT1iYWNrZW5kQmFzZSgpOwogICQoYGQke259Tm9gKS52YWx1ZT1jLnB1YmxpY2F0aW9uX251bWJlcnx8IiI7CiAgJChgZCR7bn1EYXRlYCkudmFsdWU9KGMucHVibGljYXRpb25fZGF0ZXx8Yy5wcmlvcml0eV9kYXRlfHxjLmZpbGluZ19kYXRlfHwiIikuc2xpY2UoMCwxMCk7CiAgJChgZCR7bn1VcmxgKS52YWx1ZT1jLnVybHx8IiI7CiAgJChgZCR7bn1UZXh0YCkudmFsdWU9W2MudGl0bGUsYy5zbmlwcGV0XS5maWx0ZXIoQm9vbGVhbikuam9pbigiXG5cbiIpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi5wcmlvci1zbG90IikuZm9yRWFjaCh4PT54LmNsYXNzTGlzdC5yZW1vdmUoInNlbGVjdGVkIikpOwogICQoInNsb3QiK3Nsb3QpLmNsYXNzTGlzdC5hZGQoInNlbGVjdGVkIik7CgogIGlmKGJhc2UmJmMucHVibGljYXRpb25fbnVtYmVyKXsKICAgIHRyeXsKICAgICAgJChgZCR7bn1UZXh0YCkudmFsdWU9IsSQYW5nIGzhuqV5IG7hu5lpIGR1bmcgcGF0ZW50Li4uIjsKICAgICAgY29uc3Qgcj1hd2FpdCBmZXRjaChiYXNlKyIvYXBpL2RldGFpbD9wdWI9IitlbmNvZGVVUklDb21wb25lbnQoYy5wdWJsaWNhdGlvbl9udW1iZXIpKTsKICAgICAgY29uc3QgZD1hd2FpdCByLmpzb24oKTsKICAgICAgaWYoci5vayYmZC5vayl7CiAgICAgICAgY29uc3QgcGFydHM9W107CiAgICAgICAgaWYoZC50aXRsZSkgcGFydHMucHVzaCgiVElUTEVcbiIrZC50aXRsZSk7CiAgICAgICAgaWYoZC5hYnN0cmFjdCkgcGFydHMucHVzaCgiQUJTVFJBQ1RcbiIrZC5hYnN0cmFjdCk7CiAgICAgICAgaWYoZC5jbGFpbXMpIHBhcnRzLnB1c2goIkNMQUlNU1xuIitkLmNsYWltcy5zbGljZSgwLDE4MDAwKSk7CiAgICAgICAgJChgZCR7bn1UZXh0YCkudmFsdWU9cGFydHMuam9pbigiXG5cbiIpfHxbYy50aXRsZSxjLnNuaXBwZXRdLmpvaW4oIlxuXG4iKTsKICAgICAgfWVsc2V7CiAgICAgICAgJChgZCR7bn1UZXh0YCkudmFsdWU9W2MudGl0bGUsYy5zbmlwcGV0XS5maWx0ZXIoQm9vbGVhbikuam9pbigiXG5cbiIpOwogICAgICB9CiAgICB9Y2F0Y2goX2UpewogICAgICAkKGBkJHtufVRleHRgKS52YWx1ZT1bYy50aXRsZSxjLnNuaXBwZXRdLmZpbHRlcihCb29sZWFuKS5qb2luKCJcblxuIik7CiAgICB9CiAgfQogIHJlYWRQcmlvcigpOwp9CmZ1bmN0aW9uIGF1dG9QaWNrRDEyMygpewogIGlmKCFzdGF0ZS5jYW5kaWRhdGVzLmxlbmd0aCkgcmV0dXJuIGFsZXJ0KCJDaMawYSBjw7Mga+G6v3QgcXXhuqMgdHJhIGPhu6l1LiIpOwogIGNvbnN0IHNvcnRlZD1bLi4uc3RhdGUuY2FuZGlkYXRlc10uc29ydCgoYSxiKT0+ewogICAgY29uc3QgZGE9Y2FuZGlkYXRlRGF0ZVN0YXR1cyhhKSxkYj1jYW5kaWRhdGVEYXRlU3RhdHVzKGIpOwogICAgY29uc3QgcGE9ZGEuZWxpZ2libGU9PT1mYWxzZT8xOjAscGI9ZGIuZWxpZ2libGU9PT1mYWxzZT8xOjA7CiAgICByZXR1cm4gcGEtcGIgfHwgc2NvcmVDYW5kaWRhdGUoYiktc2NvcmVDYW5kaWRhdGUoYSk7CiAgfSk7CiAgY29uc3QgcGlja2VkPXNvcnRlZC5zbGljZSgwLDMpOwogIHBpY2tlZC5mb3JFYWNoKChjLGlkeCk9PnsKICAgIGNvbnN0IG9yaWdpbmFsPXN0YXRlLmNhbmRpZGF0ZXMuaW5kZXhPZihjKTsKICAgIHNlbGVjdENhbmRpZGF0ZVRvU2xvdChvcmlnaW5hbCwiRCIrKGlkeCsxKSk7CiAgfSk7Cn0KJCgibGl2ZVNlYXJjaEJ0biIpLm9uY2xpY2s9c2VhcmNoUmVhbFBhdGVudHM7CiQoInVzZUJlc3RRdWVyeSIpLm9uY2xpY2s9KCk9Pnt1c2VHZW5lcmF0ZWRRdWVyeSgpOyQoImxpdmVTZWFyY2hTdGF0ZSIpLnRleHRDb250ZW50PSLEkMOjIG7huqFwIHRydXkgduG6pW4gdOG7qyBixrDhu5tjIENoaeG6v24gbMaw4bujYyB0cmEgY+G7qXUuIn07CiQoImF1dG9QaWNrUHJpb3IiKS5vbmNsaWNrPWF1dG9QaWNrRDEyMzsKJCgidGVzdEJhY2tlbmQiKS5vbmNsaWNrPWFzeW5jKCk9PnsKICAkKCJiYWNrZW5kU3RhdHVzIikudGV4dENvbnRlbnQ9IsSQYW5nIGtp4buDbSB0cmEuLi4iOwogIHRyeXsKICAgIGNvbnN0IHI9YXdhaXQgZmV0Y2goIi9hcGkvaGVhbHRoIix7Y2FjaGU6Im5vLXN0b3JlIn0pOwogICAgY29uc3QgZD1hd2FpdCByLmpzb24oKTsKICAgIGlmKCFyLm9rfHwhZC5vaykgdGhyb3cgbmV3IEVycm9yKGQuZXJyb3J8fCJLaMO0bmcga+G6v3QgbuG7kWkgxJHGsOG7o2MiKTsKICAgIGNvbnN0IHA9ZC5wcm92aWRlcnN8fHt9OyBjb25zdCB2ZXI9ZC52ZXJzaW9uP2AgwrcgdiR7ZC52ZXJzaW9ufWA6IiI7CiAgICBzdGF0ZS5wcm92aWRlcnM9cDsKICAgIHN0YXRlLmNsb3VkT2NyPXAuZ29vZ2xlX3Zpc2lvbj90cnVlOm51bGw7CiAgICBjb25zdCBzZWFyY2hPaz1wLnNlcnBhcGl8fHAuYnJvd3Nlcl9ydW58fHAuZXBvX29wczsKICAgIGNvbnN0IG9jclRleHQ9cC5nb29nbGVfdmlzaW9uPyIgwrcgR29vZ2xlIFZpc2lvbiBPQ1Igc+G6tW4gc8OgbmciOiIgwrcgT0NSIGxvY2FsIGZhbGxiYWNrIjsKICAgICQoImJhY2tlbmRTdGF0dXMiKS5pbm5lckhUTUw9c2VhcmNoT2sKICAgICAgPyBgPHNwYW4gY2xhc3M9ImJhY2tlbmQtb2siPuKckyBCYWNrZW5kIGhv4bqhdCDEkeG7mW5nLjwvc3Bhbj4ke29jclRleHR9YAogICAgICA6IGA8c3BhbiBjbGFzcz0iYmFja2VuZC1vayI+4pyTIEJhY2tlbmQgaG/huqF0IMSR4buZbmcuPC9zcGFuPiBHb29nbGUgZGlyZWN0IGPDsyB0aOG7gyBi4buLIHJhdGUtbGltaXQke29jclRleHR9YDsKICB9Y2F0Y2goZSl7CiAgICAkKCJiYWNrZW5kU3RhdHVzIikuaW5uZXJIVE1MPWA8c3BhbiBjbGFzcz0iYmFja2VuZC1iYWQiPuKclSBCYWNrZW5kOiAke2VzYyhlLm1lc3NhZ2V8fGUpfTwvc3Bhbj5gOwogIH0KfTsKZnVuY3Rpb24gcmVhZFByaW9yKCl7c3RhdGUucHJpb3I9e0QxOntubzokKCJkMU5vIikudmFsdWUsZGF0ZTokKCJkMURhdGUiKS52YWx1ZSx0ZXh0OiQoImQxVGV4dCIpLnZhbHVlfSxEMjp7bm86JCgiZDJObyIpLnZhbHVlLGRhdGU6JCgiZDJEYXRlIikudmFsdWUsdGV4dDokKCJkMlRleHQiKS52YWx1ZX0sRDM6e25vOiQoImQzTm8iKS52YWx1ZSxkYXRlOiQoImQzRGF0ZSIpLnZhbHVlLHRleHQ6JCgiZDNUZXh0IikudmFsdWV9fX0KJCgidmFsaWRhdGVQcmlvciIpLm9uY2xpY2s9KCk9PntyZWFkUHJpb3IoKTtsZXQgZmlsaW5nPSQoImZpbGluZ0RhdGUiKS52YWx1ZT9uZXcgRGF0ZSgkKCJmaWxpbmdEYXRlIikudmFsdWUpOm51bGwsaHRtbD0iPHN0cm9uZz5L4bq/dCBxdeG6oyBraeG7g20gdHJhIHRo4budaSBnaWFuPC9zdHJvbmc+PGJyLz4iO2Zvcihjb25zdFtrLHZdb2YgT2JqZWN0LmVudHJpZXMoc3RhdGUucHJpb3IpKXtpZighdi5ubyljb250aW51ZTtsZXQgb2s9di5kYXRlJiZmaWxpbmcmJm5ldyBEYXRlKHYuZGF0ZSk8ZmlsaW5nO2h0bWwrPWAke2t9IMK3ICR7ZXNjKHYubm8pfSDCtyAke2VzYyh2LmRhdGV8fCJjaMawYSBjw7MgbmfDoHkiKX0g4oCUIDxzcGFuIGNsYXNzPSJwaWxsICR7b2s/ImdyZWVuIjoieWVsbG93In0iPiR7b2s/IkPDsyB0aOG7gyBwaMO5IGjhu6NwIHbhu4EgdGjhu51pIGdpYW4iOiJD4bqnbiBraeG7g20gdHJhIn08L3NwYW4+PGJyLz5gfSQoInByaW9yQ2hlY2siKS5pbm5lckhUTUw9aHRtbH07CgpmdW5jdGlvbiBtYXRyaXhDb25jZXB0cyhmZWF0dXJlVGV4dCl7CiAgY29uc3QgcmF3PVN0cmluZyhmZWF0dXJlVGV4dHx8IiIpOwogIGNvbnN0IGNvbmNlcHRzPVtdOwogIGNvbnN0IHB1c2g9eD0+ewogICAgeD1TdHJpbmcoeHx8IiIpLnRyaW0oKS50b0xvd2VyQ2FzZSgpOwogICAgaWYoeC5sZW5ndGg8MykgcmV0dXJuOwogICAgaWYoIWNvbmNlcHRzLmluY2x1ZGVzKHgpKSBjb25jZXB0cy5wdXNoKHgpOwogIH07CgogIC8vIE9yaWdpbmFsIHNpZ25pZmljYW50IFZpZXRuYW1lc2UvRW5nbGlzaCB3b3Jkcy4KICBmb3IoY29uc3QgdyBvZiBtZWFuaW5nZnVsVG9rZW5zKHJhdykpIHB1c2godyk7CgogIC8vIFBhdGVudCBkaWN0aW9uYXJ5IGJpbGluZ3VhbCBleHBhbnNpb24uCiAgZm9yKGNvbnN0IFtrLHZhbHNdIG9mIE9iamVjdC5lbnRyaWVzKGRpY3QpKXsKICAgIGlmKGZvbGRWTihyYXcpLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoZm9sZFZOKGspLnRvTG93ZXJDYXNlKCkpKXsKICAgICAgcHVzaChrKTsKICAgICAgZm9yKGNvbnN0IHYgb2YgdmFscykgZm9yKGNvbnN0IHcgb2Ygdi5zcGxpdCgvXHMrLykpIHB1c2godyk7CiAgICB9CiAgfQogIHJldHVybiBjb25jZXB0cy5zbGljZSgwLDMwKTsKfQoKZnVuY3Rpb24gc3BsaXRFdmlkZW5jZVVuaXRzKHRleHQpewogIHJldHVybiBub3JtYWxpemVPY3JUZXh0KHRleHR8fCIiKQogICAgLnNwbGl0KC9cbit8KD88PVsuIT87Ol0pXHMrLykKICAgIC5tYXAoeD0+eC50cmltKCkpCiAgICAuZmlsdGVyKHg9PngubGVuZ3RoPj0yMCkKICAgIC5zbGljZSgwLDgwMCk7Cn0KCmZ1bmN0aW9uIGxvY2FsRXZpZGVuY2VGb3IoZmVhdHVyZSxkb2NUZXh0KXsKICBjb25zdCB0ZXh0PVN0cmluZyhkb2NUZXh0fHwiIikudHJpbSgpOwogIGlmKCF0ZXh0IHx8IHRleHQ9PT0ixJBhbmcgbOG6pXkgbuG7mWkgZHVuZyBwYXRlbnQuLi4iKXsKICAgIHJldHVybiB7c3RhdHVzOiJDaMawYSBjw7MgZOG7ryBsaeG7h3UiLGV2aWRlbmNlOiJDaMawYSBjw7MgbuG7mWkgZHVuZyBEMS9EMi9EMyDEkeG7gyDEkeG7kWkgY2hp4bq/dS4ifTsKICB9CgogIGNvbnN0IGNvbmNlcHRzPW1hdHJpeENvbmNlcHRzKGZlYXR1cmUudGV4dCk7CiAgaWYoIWNvbmNlcHRzLmxlbmd0aCl7CiAgICByZXR1cm4ge3N0YXR1czoiQ2jGsGEgY2jhuq9jIGNo4bqvbiIsZXZpZGVuY2U6Iktow7RuZyB0w6FjaCDEkcaw4bujYyDEkeG7pyB0aHXhuq10IG5n4buvIGvhu7kgdGh14bqtdCDEkeG7gyBtYXBwaW5nIHThu7EgxJHhu5luZy4ifTsKICB9CgogIGNvbnN0IHVuaXRzPXNwbGl0RXZpZGVuY2VVbml0cyh0ZXh0KTsKICBsZXQgYmVzdD17c2NvcmU6MCx1bml0OiIiLGhpdHM6W119OwoKICBmb3IoY29uc3QgdSBvZiB1bml0cyl7CiAgICBjb25zdCBmdT1mb2xkVk4odSkudG9Mb3dlckNhc2UoKTsKICAgIGNvbnN0IGhpdHM9Y29uY2VwdHMuZmlsdGVyKGM9PmZ1LmluY2x1ZGVzKGZvbGRWTihjKS50b0xvd2VyQ2FzZSgpKSk7CiAgICBjb25zdCB1bmlxdWU9Wy4uLm5ldyBTZXQoaGl0cyldOwogICAgbGV0IHNjb3JlPXVuaXF1ZS5sZW5ndGg7CiAgICBpZih1bmlxdWUuc29tZSh4PT54LmluY2x1ZGVzKCJkcmFnb24iKXx8eC5pbmNsdWRlcygiZ2VybWluYXRpb24iKXx8eC5pbmNsdWRlcygiY2VsbHVsYXNlIil8fHguaW5jbHVkZXMoInBlY3RpbmFzZSIpKSkgc2NvcmUrPTE7CiAgICBpZihzY29yZT5iZXN0LnNjb3JlKSBiZXN0PXtzY29yZSx1bml0OnUsaGl0czp1bmlxdWV9OwogIH0KCiAgbGV0IHN0YXR1cz0iQ2jGsGEgY2jhuq9jIGNo4bqvbiI7CiAgaWYoYmVzdC5zY29yZT49NSkgc3RhdHVzPSJDw7MiOwogIGVsc2UgaWYoYmVzdC5zY29yZT49Mykgc3RhdHVzPSJN4buZdCBwaOG6p24iOwogIGVsc2UgaWYoYmVzdC5zY29yZT49MSkgc3RhdHVzPSJDaMawYSBjaOG6r2MgY2jhuq9uIjsKICBlbHNlIHN0YXR1cz0iQ2jGsGEgY2jhuq9jIGNo4bqvbiI7IC8vIHYxMDoga2jDtG5nIGvhur90IGx14bqtbiAiS2jDtG5nIHTDrG0gdGjhuqV5IiBjaOG7iSB2w6wgaGV1cmlzdGljIGtow7RuZyBtYXRjaC4KCiAgY29uc3QgZXZpZGVuY2U9YmVzdC51bml0CiAgICA/IGAke2Jlc3QudW5pdC5zbGljZSgwLDQyMCl9JHtiZXN0LnVuaXQubGVuZ3RoPjQyMD8i4oCmIjoiIn1gCiAgICA6IkNoxrBhIHTDrG0gdGjhuqV5IMSRb+G6oW4gxJHhu6cgcsO1IGLhurFuZyBoZXVyaXN0aWM7IGPhuqduIEFJL2NodXnDqm4gZ2lhIGtp4buDbSB0cmEgbuG7mWkgZHVuZyBwYXRlbnQuIjsKCiAgcmV0dXJuIHtzdGF0dXMsZXZpZGVuY2V9Owp9CgpmdW5jdGlvbiBidWlsZExvY2FsTWF0cml4KCl7CiAgY29uc3Qgcm93cz1bXTsKICBmb3IoY29uc3QgZiBvZiBzdGF0ZS5mZWF0dXJlcyl7CiAgICBjb25zdCB2YWxzPVtdOwogICAgY29uc3Qgbm90ZXM9W107CiAgICBmb3IoY29uc3QgayBvZiBbIkQxIiwiRDIiLCJEMyJdKXsKICAgICAgY29uc3Qgcj1sb2NhbEV2aWRlbmNlRm9yKGYsc3RhdGUucHJpb3Jba10/LnRleHR8fCIiKTsKICAgICAgdmFscy5wdXNoKHIuc3RhdHVzKTsKICAgICAgbm90ZXMucHVzaChgJHtrfTogJHtyLmV2aWRlbmNlfWApOwogICAgfQogICAgcm93cy5wdXNoKFtmLmlkLC4uLnZhbHMsbm90ZXMuam9pbigiIHwgIildKTsKICB9CiAgcmV0dXJuIHJvd3M7Cn0KCmFzeW5jIGZ1bmN0aW9uIGJ1aWxkTWF0cml4UHJvKCl7CiAgcmVhZFByaW9yKCk7CiAgaWYoIXN0YXRlLmZlYXR1cmVzLmxlbmd0aCkgcmV0dXJuIGFsZXJ0KCJDaMawYSBjw7MgZmVhdHVyZS4iKTsKCiAgY29uc3QgZG9jcz1PYmplY3QuZW50cmllcyhzdGF0ZS5wcmlvcikuZmlsdGVyKChbayx2XSk9PnYmJnYubm8mJlN0cmluZyh2LnRleHR8fCIiKS50cmltKCkpOwogIGlmKCFkb2NzLmxlbmd0aCl7CiAgICBzdGF0ZS5tYXRyaXg9c3RhdGUuZmVhdHVyZXMubWFwKGY9PlsKICAgICAgZi5pZCwiQ2jGsGEgY8OzIGThu68gbGnhu4d1IiwiQ2jGsGEgY8OzIGThu68gbGnhu4d1IiwiQ2jGsGEgY8OzIGThu68gbGnhu4d1IiwKICAgICAgIkNoxrBhIGNo4buNbiBob+G6t2MgY2jGsGEgdOG6o2kgbuG7mWkgZHVuZyBEMeKAk0QzLiBIw6N5IHF1YXkgbOG6oWkgYsaw4bubYyA1IHbDoCBjaOG7jW4gdMOgaSBsaeG7h3UgxJHhu5FpIGNo4bupbmcuIgogICAgXSk7CiAgICByZW5kZXJNYXRyaXgoKTsKICAgIHJldHVybjsKICB9CgogICQoIm1hdHJpeEJvZHkiKS5pbm5lckhUTUw9Jzx0cj48dGQgY29sc3Bhbj0iNSIgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO2NvbG9yOiM2NjcwODUiPsSQYW5nIHRyw61jaCBldmlkZW5jZSB0aGVvIHThu6tuZyBk4bqldSBoaeG7h3XigKY8L3RkPjwvdHI+JzsKCiAgLy8gTuG6v3UgY8OzIEdFTUlOSV9BUElfS0VZIGJhY2tlbmQgc+G6vSBkw7luZyBHZW5BSTsgbuG6v3UgY2jGsGEgY8OzIHRow6wgZmFsbGJhY2sgbG9jYWwuCiAgdHJ5ewogICAgY29uc3QgcGF5bG9hZD17CiAgICAgIGZlYXR1cmVzOnN0YXRlLmZlYXR1cmVzLm1hcChmPT4oe2lkOmYuaWQsdGV4dDpmLnRleHR9KSksCiAgICAgIGRvY3VtZW50czpPYmplY3QuZnJvbUVudHJpZXMoWyJEMSIsIkQyIiwiRDMiXS5tYXAoaz0+WwogICAgICAgIGssewogICAgICAgICAgbm86c3RhdGUucHJpb3Jba10/Lm5vfHwiIiwKICAgICAgICAgIHRleHQ6U3RyaW5nKHN0YXRlLnByaW9yW2tdPy50ZXh0fHwiIikuc2xpY2UoMCwyMjAwMCkKICAgICAgICB9CiAgICAgIF0pKQogICAgfTsKICAgIGNvbnN0IHI9YXdhaXQgZmV0Y2goIi9hcGkvbWF0cml4Iix7CiAgICAgIG1ldGhvZDoiUE9TVCIsCiAgICAgIGhlYWRlcnM6eyJjb250ZW50LXR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sCiAgICAgIGJvZHk6SlNPTi5zdHJpbmdpZnkocGF5bG9hZCkKICAgIH0pOwogICAgY29uc3QgZD1hd2FpdCByLmpzb24oKS5jYXRjaCgoKT0+KHt9KSk7CiAgICBpZihyLm9rJiZkLm9rJiZBcnJheS5pc0FycmF5KGQucm93cykpewogICAgICBzdGF0ZS5tYXRyaXg9ZC5yb3dzLm1hcCh4PT5bCiAgICAgICAgeC5mZWF0dXJlX2lkLAogICAgICAgIHguRDE/LnN0YXR1c3x8IkNoxrBhIGNo4bqvYyBjaOG6r24iLAogICAgICAgIHguRDI/LnN0YXR1c3x8IkNoxrBhIGNo4bqvYyBjaOG6r24iLAogICAgICAgIHguRDM/LnN0YXR1c3x8IkNoxrBhIGNo4bqvYyBjaOG6r24iLAogICAgICAgIFt4LkQxJiZgRDE6ICR7eC5EMS5ldmlkZW5jZXx8IiJ9YCx4LkQyJiZgRDI6ICR7eC5EMi5ldmlkZW5jZXx8IiJ9YCx4LkQzJiZgRDM6ICR7eC5EMy5ldmlkZW5jZXx8IiJ9YF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oIiB8ICIpCiAgICAgIF0pOwogICAgICByZW5kZXJNYXRyaXgoKTsKICAgICAgcmV0dXJuOwogICAgfQogIH1jYXRjaChlKXtjb25zb2xlLndhcm4oIkFJIG1hdHJpeCBmYWxsYmFjazoiLGUpfQoKICBzdGF0ZS5tYXRyaXg9YnVpbGRMb2NhbE1hdHJpeCgpOwogIHJlbmRlck1hdHJpeCgpOwp9CgokKCJidWlsZE1hdHJpeCIpLm9uY2xpY2s9YnVpbGRNYXRyaXhQcm87CgpmdW5jdGlvbiBwaWxsKHYpewogIGxldCBjPXY9PT0iQ8OzIj8iZ3JlZW4iOnY9PT0iTeG7mXQgcGjhuqduIj8ieWVsbG93Ijp2PT09Iktow7RuZyB0w6xtIHRo4bqleSI/InJlZCI6dj09PSJDaMawYSBjw7MgZOG7ryBsaeG7h3UiPyIiOiIiOwogIHJldHVybmA8c3BhbiBjbGFzcz0icGlsbCAke2N9Ij4ke3Z9PC9zcGFuPmAKfQpmdW5jdGlvbiByZW5kZXJNYXRyaXgoKXsKICAkKCJtYXRyaXhCb2R5IikuaW5uZXJIVE1MPXN0YXRlLm1hdHJpeC5tYXAocj0+YDx0cj4KICAgIDx0ZD48c3Ryb25nPiR7clswXX08L3N0cm9uZz48L3RkPgogICAgPHRkPiR7cGlsbChyWzFdKX08L3RkPgogICAgPHRkPiR7cGlsbChyWzJdKX08L3RkPgogICAgPHRkPiR7cGlsbChyWzNdKX08L3RkPgogICAgPHRkIHN0eWxlPSJtaW4td2lkdGg6NDIwcHgiPiR7ZXNjKHJbNF0pfTwvdGQ+CiAgPC90cj5gKS5qb2luKCIiKQp9CgokKCJydW5Bc3Nlc3NtZW50Iikub25jbGljaz0oKT0+e2lmKCFzdGF0ZS5tYXRyaXgubGVuZ3RoKXJldHVybiBhbGVydCgiSMOjeSB04bqhbyBtYSB0cuG6rW4gdHLGsOG7m2MuIik7bGV0IGFsbD1bMSwyLDNdLmZpbHRlcihjPT5zdGF0ZS5tYXRyaXguZXZlcnkocj0+cltjXT09PSJDw7MiKSk7c3RhdGUuYXNzZXNzbWVudD17bm92ZWx0eVJpc2s6YWxsLmxlbmd0aD8iUuG7pkkgUk8gQ0FPIjoiQ0jGr0EgUEjDgVQgSEnhu4ZOIE3huqRUIFTDjU5IIE3hu5pJIixub3ZlbHR5VGV4dDphbGwubGVuZ3RoP2BDw7MgJHthbGwubWFwKHg9PiJEIit4KS5qb2luKCIsICIpfSDEkcaw4bujYyBtYXBwaW5nIGLhu5ljIGzhu5kgdG/DoG4gYuG7mSBmZWF0dXJlOyBj4bqnbiBraeG7g20gdHJhIGV2aWRlbmNlLmA6IlRyb25nIHThuq1wIEQx4oCTRDMgaGnhu4duIHThuqFpLCBjaMawYSB4w6FjIMSR4buLbmggbeG7mXQgdMOgaSBsaeG7h3UgxJHGoW4gbOG6uyBi4buZYyBs4buZIHRvw6BuIGLhu5kgZOG6pXUgaGnhu4d1LiBL4bq/dCBxdeG6oyBjaOG7iSDDoXAgZOG7pW5nIGNobyB04bqtcCB0w6BpIGxp4buHdSDEkWFuZyBraOG6o28gc8OhdC4iLGludmVudGl2ZVJpc2s6IkPhuqZOIENIVVnDik4gR0lBIixpbnZlbnRpdmVUZXh0OiJD4bqnbiBjaOG7jW4gxJHhu5FpIGNo4bupbmcgZ+G6p24gbmjhuqV0LCB4w6FjIMSR4buLbmggZOG6pXUgaGnhu4d1IGtow6FjIGJp4buHdCB2w6AgduG6pW4gxJHhu4Ega+G7uSB0aHXhuq10IGtow6FjaCBxdWFuLCBzYXUgxJHDsyB4ZW0geMOpdCBsaeG7h3UgcHJpb3IgYXJ0IGtow6FjIGPDsyBn4bujaSDDvSBjw6FjaCBnaeG6o2kgcXV54bq/dCBoYXkga2jDtG5nLiJ9O3JlbmRlckFzc2Vzc21lbnQoKX07CmZ1bmN0aW9uIHJlbmRlckFzc2Vzc21lbnQoKXskKCJub3ZlbHR5VGV4dCIpLnRleHRDb250ZW50PXN0YXRlLmFzc2Vzc21lbnQubm92ZWx0eVRleHR8fCIiOyQoImludmVudGl2ZVRleHQiKS50ZXh0Q29udGVudD1zdGF0ZS5hc3Nlc3NtZW50LmludmVudGl2ZVRleHR8fCIiOyQoIm5vdmVsdHlSaXNrIikudGV4dENvbnRlbnQ9c3RhdGUuYXNzZXNzbWVudC5ub3ZlbHR5Umlza3x8IkNI4bucIEThu64gTEnhu4ZVIjskKCJpbnZlbnRpdmVSaXNrIikudGV4dENvbnRlbnQ9c3RhdGUuYXNzZXNzbWVudC5pbnZlbnRpdmVSaXNrfHwiQ0jhu5wgROG7riBMSeG7hlUiOyQoIm5vdmVsdHlSaXNrIikuY2xhc3NOYW1lPSJyaXNrYm94ICIrKChzdGF0ZS5hc3Nlc3NtZW50Lm5vdmVsdHlSaXNrfHwiIikuaW5jbHVkZXMoIkNBTyIpPyJyZWQiOiJncmVlbiIpOyQoImludmVudGl2ZVJpc2siKS5jbGFzc05hbWU9InJpc2tib3ggeWVsbG93IjtyZW5kZXJFeHBlcnQoKX0KZnVuY3Rpb24gcmVuZGVyRXhwZXJ0KCl7bGV0IHJvd3M9W1siROG6pXUgaGnhu4d1IGvhu7kgdGh14bqtdCIsYCR7c3RhdGUuZmVhdHVyZXMubGVuZ3RofSBmZWF0dXJlYF0sWyJDaGnhur9uIGzGsOG7o2MgdHJhIGPhu6l1IixgJHtzdGF0ZS5xdWVyaWVzLmxlbmd0aH0gcXVlcnlgXSxbIlByaW9yIGFydCIsT2JqZWN0LnZhbHVlcyhzdGF0ZS5wcmlvcikuZmlsdGVyKHg9PngmJngubm8pLm1hcCh4PT54Lm5vKS5qb2luKCIsICIpfHwiQ2jGsGEgY8OzIl0sWyJC4bqjbmcgxJHhu5FpIGNoaeG6v3UiLGAke3N0YXRlLm1hdHJpeC5sZW5ndGh9IGZlYXR1cmVgXSxbIlTDrW5oIG3hu5tpIixzdGF0ZS5hc3Nlc3NtZW50Lm5vdmVsdHlSaXNrfHwiQ2jGsGEgxJHDoW5oIGdpw6EiXSxbIlRyw6xuaCDEkeG7mSBzw6FuZyB04bqhbyIsc3RhdGUuYXNzZXNzbWVudC5pbnZlbnRpdmVSaXNrfHwiQ2jGsGEgxJHDoW5oIGdpw6EiXV07JCgiZXhwZXJ0Qm9keSIpLmlubmVySFRNTD1yb3dzLm1hcCgocixpKT0+YDx0cj48dGQ+PHN0cm9uZz4ke3JbMF19PC9zdHJvbmc+PC90ZD48dGQ+JHtlc2MoclsxXSl9PC90ZD48dGQ+PHNlbGVjdCBkYXRhLXI9IiR7aX0iPjxvcHRpb24+Q2jhu50gcsOgIHNvw6F0PC9vcHRpb24+PG9wdGlvbj5Yw6FjIG5o4bqtbjwvb3B0aW9uPjxvcHRpb24+Q2jhu4luaCBz4butYTwvb3B0aW9uPjxvcHRpb24+S2jDtG5nIMSR4buTbmcgw708L29wdGlvbj48L3NlbGVjdD48L3RkPjx0ZD48aW5wdXQgcGxhY2Vob2xkZXI9Ik5o4bqtbiB4w6l0IGNodXnDqm4gZ2lhIi8+PC90ZD48L3RyPmApLmpvaW4oIiIpfXJlbmRlckV4cGVydCgpOwokKCJzYXZlUmV2aWV3Iikub25jbGljaz0oKT0+e3N0YXRlLnJldmlld3M9Wy4uLmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLXJdIildLmZpbHRlcih4PT54LnZhbHVlIT09IkNo4budIHLDoCBzb8OhdCIpLmxlbmd0aDthbGVydCgixJDDoyBsxrB1IHLDoCBzb8OhdCB0cm9uZyBwaGnDqm4gaGnhu4duIHThuqFpLiIpfTsKCiQoImdlblJlcG9ydCIpLm9uY2xpY2s9KCk9PntyZWFkUHJpb3IoKTtsZXQgYz1zdGF0ZS5jbGFpbXNbc3RhdGUuc2VsZWN0ZWRdfHxzdGF0ZS5jbGFpbXNbMF07JCgicmVwb3J0Q29udGVudCIpLmlubmVySFRNTD1gCjxoMz4xLiBUaMO0bmcgdGluIHPDoW5nIGNo4bq/PC9oMz48ZGl2IGNsYXNzPSJzdW1tYXJ5Ij48ZGl2Pk3DoyBjYXNlPC9kaXY+PGRpdj4ke2VzYygkKCJjYXNlSWQiKS52YWx1ZSl9PC9kaXY+PGRpdj5T4buRIGLhurFuZy9jw7RuZyBi4buRPC9kaXY+PGRpdj4ke2VzYygkKCJwYXRlbnRObyIpLnZhbHVlKX08L2Rpdj48ZGl2PlTDqm4gc8OhbmcgY2jhur88L2Rpdj48ZGl2PiR7ZXNjKCQoInRpdGxlIikudmFsdWUpfTwvZGl2PjxkaXY+TmfDoHkgbuG7mXAvxrB1IHRpw6puPC9kaXY+PGRpdj4ke2VzYygkKCJmaWxpbmdEYXRlIikudmFsdWUpfTwvZGl2PjxkaXY+SVBDL0NQQzwvZGl2PjxkaXY+JHtlc2MoJCgiaXBjIikudmFsdWUpfTwvZGl2PjwvZGl2Pgo8aDM+Mi4gQ2xhaW0gxJHGsOG7o2MgcGjDom4gdMOtY2g8L2gzPjxwPiR7ZXNjKGM/LnRleHR8fCJDaMawYSBjaOG7jW4iKX08L3A+CjxoMz4zLiBE4bqldSBoaeG7h3Uga+G7uSB0aHXhuq10PC9oMz48b2w+JHtzdGF0ZS5mZWF0dXJlcy5tYXAoZj0+YDxsaT48c3Ryb25nPiR7Zi5pZH08L3N0cm9uZz4g4oCUICR7ZXNjKGYudGV4dCl9PC9saT5gKS5qb2luKCIiKXx8IjxsaT5DaMawYSBjw7M8L2xpPiJ9PC9vbD4KPGgzPjQuIENoaeG6v24gbMaw4bujYyB0cmEgY+G7qXU8L2gzPjx1bD4ke3N0YXRlLnF1ZXJpZXMubWFwKHE9PmA8bGk+PGNvZGU+JHtlc2MocSl9PC9jb2RlPjwvbGk+YCkuam9pbigiIil8fCI8bGk+Q2jGsGEgdOG6oW88L2xpPiJ9PC91bD4KPGgzPjUuIMSQw6FuaCBnacOhIHPGoSBi4buZIHTDrW5oIG3hu5tpPC9oMz48cD48c3Ryb25nPiR7ZXNjKHN0YXRlLmFzc2Vzc21lbnQubm92ZWx0eVJpc2t8fCJDaMawYSDEkcOhbmggZ2nDoSIpfTwvc3Ryb25nPjwvcD48cD4ke2VzYyhzdGF0ZS5hc3Nlc3NtZW50Lm5vdmVsdHlUZXh0fHwiIil9PC9wPgo8aDM+Ni4gUGjDom4gdMOtY2ggc8ahIGLhu5kgdHLDrG5oIMSR4buZIHPDoW5nIHThuqFvPC9oMz48cD48c3Ryb25nPiR7ZXNjKHN0YXRlLmFzc2Vzc21lbnQuaW52ZW50aXZlUmlza3x8IkNoxrBhIMSRw6FuaCBnacOhIil9PC9zdHJvbmc+PC9wPjxwPiR7ZXNjKHN0YXRlLmFzc2Vzc21lbnQuaW52ZW50aXZlVGV4dHx8IiIpfTwvcD48cD48c3Ryb25nPsSQ4buRaSBjaOG7qW5nIGfhuqduIG5o4bqldDo8L3N0cm9uZz4gJHtlc2MoJCgiY2xvc2VzdCIpLnZhbHVlKX08L3A+PHA+PHN0cm9uZz5E4bqldSBoaeG7h3Uga2jDoWMgYmnhu4d0Ojwvc3Ryb25nPiAke2VzYygkKCJkaWZmZXJlbmNlcyIpLnZhbHVlKX08L3A+PHA+PHN0cm9uZz5W4bqlbiDEkeG7gSBr4bu5IHRodeG6rXQga2jDoWNoIHF1YW46PC9zdHJvbmc+ICR7ZXNjKCQoInByb2JsZW0iKS52YWx1ZSl9PC9wPjxwPjxzdHJvbmc+TOG6rXAgbHXhuq1uOjwvc3Ryb25nPiAke2VzYygkKCJyZWFzb25pbmciKS52YWx1ZSl9PC9wPgo8aDM+Ny4gRXhwZXJ0IHJldmlldzwvaDM+PHA+U+G7kSBo4bqhbmcgbeG7pWMgxJHDoyDEkcaw4bujYyByw6Agc2/DoXQ6IDxzdHJvbmc+JHtzdGF0ZS5yZXZpZXdzfTwvc3Ryb25nPi48L3A+CjxkaXYgY2xhc3M9ImNhbGxvdXQiPjxzdHJvbmc+TMawdSDDvTo8L3N0cm9uZz4gxJDDonkgbMOgIGLDoW8gY8OhbyBwaMOibiB0w61jaCBzxqEgYuG7mSBwaOG7pWMgduG7pSBuZ2hpw6puIGPhu6l1LCBraMO0bmcgcGjhuqNpIMO9IGtp4bq/biBwaMOhcCBsw70gY3Xhu5FpIGPDuW5nLjwvZGl2PmB9OwoKY29uc3QgZGVtbz1gKDEyKSBC4bqiTiBNw5QgVOG6oiBTw4FORyBDSOG6viBUSFXhu5hDIELhurBORyDEkOG7mEMgUVVZ4buATiBTw4FORyBDSOG6vgooMTEpIDEtMDA0MjE4MAooNTEpIEE2MUsgMzYvMzM7IEE2MUsgMzYvNzQ2OyBBMjNMIDE5LzAwOyBBMjNMIDMzLzEwCigyMikgMzAvMDYvMjAyMQooNzMpIEPDlE5HIFRZIFROSEggTsav4buaQyDDiVAgUEjDmkMgSMOAIChWTikKKDc0KSBDw7RuZyB0eSBUTkhIIFTGsCB24bqlbiBjw7RuZyBuZ2jhu4cgdsOgIFPhu58gaOG7r3UgdHLDrSB0deG7hyBJUCBHUk9VUAooNTQpIFFVWSBUUsOMTkggU+G6ok4gWFXhuqRUIELhu5hUIERJTkggRMav4bugTkcgVOG7qiBI4bqgVCBUSEFOSCBMT05HIE7huqJZIE3huqZNCig1NykgU8OhbmcgY2jhur8gxJHhu4EgY+G6rXAgxJHhur9uIGLhu5l0IGRpbmggZMaw4buhbmcgdOG7qyBo4bqhdCB0aGFuaCBsb25nIG7huqN5IG3huqdtIHRodSDEkcaw4bujYyB04burIG3hu5l0IHF1eSB0csOsbmggc+G6o24geHXhuqV0LgpZw4pVIEPhuqZVIELhuqJPIEjhu5gKMS4gUXV5IHRyw6xuaCBz4bqjbiB4deG6pXQgYuG7mXQgZGluaCBkxrDhu6FuZyB04burIGjhuqF0IHRoYW5oIGxvbmcgbuG6o3kgbeG6p20gYmFvIGfhu5NtOiAoaSkgY2h14bqpbiBi4buLIG5ndXnDqm4gbGnhu4d1IGjhuqF0IHRoYW5oIGxvbmc7IChpaSkgeOG7rSBsw70gYuG6sW5nIGNo4bq/IHBo4bqpbSBlbnp5bWUgY2VsbHVsYXNlIHbDoCBwZWN0aW5hc2U7IChpaWkpIG5nw6JtIHbDoCDhu6cgxJHhu4MgaOG6oXQgbuG6o3kgbeG6p207IChpdikgc+G6pXk7ICh2KSBuZ2hp4buBbjsgKHZpKSBraeG7g20gdHJhIMSR4buTbmcgbmjhuqV0OyAodmlpKSB0aMOqbSBi4buZdCBuaMOgdTsgKHZpaWkpIHRow6ptIGLhu5l0IHRoYW5oIGxvbmc7IChpeCkgdGjDqm0gdGjDoG5oIHBo4bqnbiBwaOG7pTsgKHgpIGtp4buDbSB0cmEgxJHhu5NuZyBuaOG6pXQ7ICh4aSkgbmdoaeG7gW4gdsOgIMSRaeG7gXUgY2jhu4luaCDEkeG7mSDhuqltOyAoeGlpKSDEkcOzbmcgZ8OzaS4KMi4gUXV5IHRyw6xuaCB0aGVvIMSRaeG7g20gMSwgdHJvbmcgxJHDsyB0aMOgbmggcGjhuqduIHBo4bulIGJhbyBn4buTbSBjaOG6pXQgYuG6o28gcXXhuqNuIHbDoCBjaOG6pXQgY2jhu5FuZyB2w7NuLgozLiBRdXkgdHLDrG5oIHRoZW8gxJFp4buDbSAxLCB0cm9uZyDEkcOzIHRow6BuaCBwaOG6p24gY2jhuqV0IHThuqFvIG5n4buNdCB04buxIG5oacOqbiBiYW8gZ+G7k20gbmjDs20gZ2x1Y2l0LmA7CiQoImxvYWREZW1vIikub25jbGljaz0oKT0+e3N0YXRlLnJhd1RleHQ9ZGVtbztsZXQgbT1leHRyYWN0TWV0YWRhdGEoZGVtbyk7ZmlsbE1ldGEobSk7bGV0IGN0PWNsZWFuKGRlbW8uc2xpY2UoZGVtby5zZWFyY2goL1nDilUgQ+G6plUgQuG6ok8gSOG7mC9pKSsiWcOKVSBD4bqmVSBC4bqiTyBI4buYIi5sZW5ndGgpKTtzdGF0ZS5jbGFpbXNUZXh0PWN0OyQoImNsYWltc1JhdyIpLnZhbHVlPWN0OyQoImNsYWltc0NsZWFuIikudmFsdWU9Zm9ybWF0Q2xhaW1Gb3JEaXNwbGF5KGN0KTtzdGF0ZS5jbGFpbXM9cGFyc2VDbGFpbXMoY3QpO3JlbmRlckNsYWltcygpO3NldERldGVjdCgiZGV0Q2xhaW1zIix0cnVlLGDEkMOjIHTDoWNoICR7c3RhdGUuY2xhaW1zLmxlbmd0aH0gY2xhaW1gKTskKCJwcm9ncmVzc0JhciIpLnN0eWxlLndpZHRoPSIxMDAlIjskKCJwZGZTdGF0dXMiKS50ZXh0Q29udGVudD0ixJDDoyBu4bqhcCBkZW1vIFBILVZOLTAxLiJ9Owo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+";
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
