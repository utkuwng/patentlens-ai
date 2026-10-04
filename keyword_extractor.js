/* PatentLens keyword extractor + pillar classifier v42.
 * Keywords come FROM THE DOCUMENT (frequency of phrases), not from a built-in domain lexicon.
 * Pillar cues below only define what the 3 pillars mean (generic words, not domain vocabulary).
 * Runs locally in the browser. Output is a suggestion; the user can override the pillar.
 */
(function (root) {
  'use strict';
  const PILLARS = {
    process_product: { name: 'Quy trình sản phẩm', cues: ['quy trinh','san xuat','che tao','dieu che','che pham','thanh phan','hon hop','hop chat','dung dich','nguyen lieu','chiet xuat','len men','say','nghien','tron','nung','khoi luong','ty le','phan tram','nhiet do','tinh che','bao quan','san pham','process','producing','preparing','preparation','manufacturing','composition','mixture','compound','solution','extract','extraction','ferment','fermentation','drying','heating','temperature','weight','ratio','percent','reaction','synthesis','powder','formulation','ingredient','pharmaceutical','polymer','material','purification','coating'] },
    information_technology: { name: 'Công nghệ thông tin', cues: ['may tinh','phan mem','du lieu','thuat toan','mo hinh','mang may tinh','bo xu ly','bo nho','may chu','giao dien','nguoi dung','thong tin','hoc may','hoc sau','no ron','ma hoa','co so du lieu','truyen thong','dam may','chuong trinh','computer','software','data','algorithm','model','network','processor','memory','server','user','interface','database','neural','learning','program','instructions','storage medium','computing','encryption','cloud','application','terminal','information','training','classification','communication'] },
    system_device: { name: 'Hệ thống/thiết bị', cues: ['thiet bi','co cau','bo phan','cam bien','dong co','truc','banh','bom','mach','khung','lap rap','canh tay','lo xo','co khi','device','apparatus','assembly','mechanism','sensor','motor','shaft','valve','pump','circuit','housing','frame','member','portion','body','arm','wheel','spring','nozzle','tube','lens','chamber','plate','rod','gear','bearing','blade','cylinder','electrode','battery','vehicle'] }
  };
  const EN_STOP = new Set('a an and are as at be been being but by can could did do does for from had has have having he her his how if in into is it its may might more most not of on onto or other our over per she should so some such than that the their them then there these they this those through thus to under up upon use used using was we were what when where which while who will with within without would you your also each any all both between during about after before said claim claims comprising comprises comprise comprised wherein whereby thereof therein herein invention embodiment embodiments present according fig figure figures first second third one two three plurality least example examples preferably particular described provided configured adapted based includes including include thereby further another various several'.split(' '));
  const VI_STOP = new Set('và hoặc của cho với trong ngoài trên dưới từ đến tại theo sau trước do này đó kia một các những được bị là có không bởi để khi nếu thì mà như cũng đã sẽ đang rất hơn nhất cả mỗi mọi nhiều ít đều vẫn còn chỉ lại ra vào lên xuống qua giữa về bằng nên vì tuy song hay cùng nhau thế đây đấy ấy nào gì sao đâu ở gồm điểm trưng hai ba bốn năm sáu bảy tám chín mười thứ vẽ dụ tả kèm'.split(' '));
  const GEN_BI = new Set(['phuong phap','thiet bi','he thong','quy trinh','san pham','sang che','yeu cau','bao ho','dac trung','bao gom']);
  const GEN_UNI = new Set('method methods system systems device devices apparatus process processes product products unit module member part invention'.split(' '));
  const fold = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const isStop = t => EN_STOP.has(t) || VI_STOP.has(t) || t.length < 2 || /^\d+([.,]\d+)?$/.test(t);
  const TOKEN = /[\p{L}\p{N}]+(?:[-\/][\p{L}\p{N}]+)*/gu;
  const SEG = /[^\n\r.;:,!?()\[\]{}"“”‘’•|]+/g;

  function countPhrases(text, weight, counts, headChars) {
    for (const m of String(text || '').toLowerCase().matchAll(SEG)) {
      const w = (m.index < headChars ? 2 : 1) * weight;
      const toks = m[0].match(TOKEN) || [];
      let run = [];
      const flush = () => {
        for (let i = 0; i < run.length; i++) for (let n = 1; n <= 4 && i + n <= run.length; n++) {
          const g = run.slice(i, i + n);
          if (n === 1 && !((g[0].length >= 5 && !/^\d+$/.test(g[0])) || (/\d/.test(g[0]) && /\p{L}/u.test(g[0]) && g[0].length >= 3))) continue;
          const key = g.join(' ');
          counts.set(key, (counts.get(key) || 0) + w);
        }
        run = [];
      };
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (isStop(t) || GEN_UNI.has(t)) { flush(); continue; }
        if (i + 1 < toks.length && GEN_BI.has(fold(t + ' ' + toks[i + 1]))) { flush(); i++; continue; }
        run.push(t);
      }
      flush();
    }
  }

  function classify(text, opts) {
    const f = fold(text).match(/[a-z0-9]+/g) || [];
    const uni = new Map(), bi = new Map();
    for (let i = 0; i < f.length; i++) { uni.set(f[i], (uni.get(f[i]) || 0) + 1); if (i + 1 < f.length) { const b = f[i] + ' ' + f[i + 1]; bi.set(b, (bi.get(b) || 0) + 1); } }
    const raw = {}; let total = 0; const matched = {};
    for (const [id, p] of Object.entries(PILLARS)) {
      let s = 0; matched[id] = [];
      for (const cue of p.cues) {
        const c = (cue.includes(' ') ? bi.get(cue) : uni.get(cue)) || 0;
        if (c) { s += Math.log2(1 + c); matched[id].push([cue, c]); }
      }
      raw[id] = s; total += s;
    }
    const ids = Object.keys(PILLARS).sort((a, b) => raw[b] - raw[a]);
    const pct = {}; for (const id of ids) pct[id] = total ? Math.round(raw[id] / total * 100) : 0;
    const top = raw[ids[0]], second = raw[ids[1]];
    const confidence = total ? (top - second) / (top + second) : 0;
    return {
      id: total ? ids[0] : null, name: total ? PILLARS[ids[0]].name : '', scores: pct, total,
      confidence, ambiguous: total > 0 && confidence < 0.15,
      cues: total ? matched[ids[0]].sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0] + ' ×' + x[1]) : []
    };
  }

  function extract(text, opts) {
    opts = opts || {};
    const max = opts.max || 12;
    const t = String(text || '');
    const boost = String(opts.boost || '');
    const words = (t.match(TOKEN) || []).length;
    let list;
    if (t.length < 400 && !boost) {
      // very short input = user typed keywords: keep them as-is, no frequency to mine
      const items = [...new Set(t.split(/[\n,;]+/).map(x => x.replace(/\s+/g, ' ').trim()).filter(x => x.length >= 3 && x.length <= 110))];
      list = items.slice(0, max).map(term => ({ term, count: 1, score: 1 }));
    } else {
      const counts = new Map();
      countPhrases(t, 1, counts, 1500);
      if (boost) countPhrases(boost, 2, counts, 0);
      const minUni = words > 300 ? 2 : 1, minGram = words > 1500 ? 2 : 1;
      const cand = [];
      for (const [term, count] of counts) {
        const n = term.split(' ').length;
        if (count < (n === 1 ? minUni : minGram)) continue;
        cand.push({ term, count, n, score: count * (1 + 0.5 * (n - 1)) });
      }
      const superMax = new Map();
      for (const c of cand) if (c.n >= 2) {
        const tk = c.term.split(' ');
        for (const sub of [tk.slice(1).join(' '), tk.slice(0, -1).join(' ')]) superMax.set(sub, Math.max(superMax.get(sub) || 0, c.count));
      }
      for (let i = cand.length - 1; i >= 0; i--) if ((superMax.get(cand[i].term) || 0) >= 0.75 * cand[i].count) cand.splice(i, 1);
      cand.sort((a, b) => b.score - a.score || b.n - a.n);
      list = [];
      for (const c of cand) {
        if (list.length >= max) break;
        const pad = ' ' + c.term + ' ';
        // drop a phrase that mostly lives inside an already-picked longer phrase (or vice versa)
        if (list.some(p => (' ' + p.term + ' ').includes(pad) && c.count <= p.count * 1.5)) continue;
        if (list.some(p => pad.includes(' ' + p.term + ' ') && p.count <= c.count * 1.5)) continue;
        list.push({ term: c.term, count: c.count, score: Math.round(c.score * 10) / 10 });
      }
    }
    list.forEach(k => { k.id = fold(k.term).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'kw'; });
    return { keywords: list, pillar: classify(t + '\n' + boost), stats: { chars: t.length, words } };
  }

  const isVietnamese = s => /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(String(s || ''));
  const api = Object.freeze({ PILLARS, extract, classify, isVietnamese, fold });
  root.PATENTLENS_KEYWORDS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
