/* PatentLens topic router v35. Curated starter lexicon, NOT a trained model or verified IPC taxonomy.
 * Runs locally in the browser. Add terms only after recording a public source + domain review.
 * `aliases` are retrieval alternatives, NOT automatically equivalent legal claim limitations.
 */
(function (root) {
  'use strict';
  const topics = [
    { id: 'process_product', name: 'Quy trình sản phẩm', concepts: [
      {id:'manufacture',name:'Chế tạo và sản xuất',aliases:['quy trình sản xuất','phương pháp sản xuất','quy trình chế tạo','phương pháp chế tạo','manufacturing process','production process','method of manufacturing','fabrication process']},
      {id:'mix',name:'Phối trộn và điều chế',aliases:['phối trộn','quá trình phối trộn','trộn hỗn hợp','điều chế','pha chế','mixing','blending','formulation','preparation process']},
      {id:'dry',name:'Sấy và làm khô',aliases:['sấy khô','sấy','sấy thăng hoa','làm khô','drying','dehydration','freeze drying','lyophilization']},
      {id:'heat',name:'Gia nhiệt và xử lý nhiệt',aliases:['gia nhiệt','xử lý nhiệt','nung','ủ nhiệt','heat treatment','heating','annealing','thermal processing']},
      {id:'extract',name:'Chiết xuất và tinh chế',aliases:['chiết xuất','chiết tách','tinh chế','extraction','extracting','purification','isolation process']},
      {id:'coat',name:'Phủ và xử lý bề mặt',aliases:['phủ bề mặt','màng phủ','mạ điện','surface coating','coating process','electroplating','surface treatment']},
      {id:'pack',name:'Đóng gói và bảo quản',aliases:['đóng gói','bao gói','bảo quản sản phẩm','packaging process','packing method','preservation process']},
      {id:'composition',name:'Chế phẩm và thành phần',aliases:['chế phẩm','thành phần dược phẩm','hỗn hợp vật liệu','pharmaceutical composition','chemical composition','formulation composition','material composition']},
      {id:'ferment',name:'Lên men và xử lý sinh học',aliases:['lên men','quy trình lên men','nuôi cấy vi sinh','fermentation','microbial cultivation','bioprocess']}
    ]},
    { id: 'information_technology', name: 'Công nghệ thông tin', concepts: [
      {id:'ai',name:'Trí tuệ nhân tạo',aliases:['trí tuệ nhân tạo','artificial intelligence','ai model','ai-based processing']},
      {id:'algorithm',name:'Thuật toán và xử lý dữ liệu',aliases:['thuật toán','xử lý dữ liệu','algorithm','data processing','computational method']},
      {id:'machine_learning',name:'Học máy',aliases:['học máy','mô hình học máy','machine learning','machine-learning model','supervised learning','unsupervised learning']},
      {id:'deep_learning',name:'Học sâu',aliases:['học sâu','mạng nơ-ron sâu','deep learning','deep neural network','neural network']},
      {id:'computer_vision',name:'Thị giác máy tính',aliases:['thị giác máy tính','nhận dạng hình ảnh','phát hiện vật thể','xử lý ảnh','computer vision','image recognition','object detection','image processing']},
      {id:'nlp',name:'Xử lý ngôn ngữ tự nhiên',aliases:['xử lý ngôn ngữ tự nhiên','mô hình ngôn ngữ','nhận dạng văn bản','natural language processing','language model','text classification','named entity recognition']},
      {id:'cryptography',name:'Mật mã và an toàn dữ liệu',aliases:['mã hóa dữ liệu','mật mã học','chữ ký số','cryptography','data encryption','digital signature','secure computation']},
      {id:'database',name:'Cơ sở dữ liệu và truy vấn',aliases:['cơ sở dữ liệu','truy vấn dữ liệu','lập chỉ mục dữ liệu','database','database query','data indexing','information retrieval']},
      {id:'network',name:'Mạng và truyền thông dữ liệu',aliases:['mạng máy tính','truyền gói tin','giao thức truyền thông','computer network','packet transmission','network protocol']},
      {id:'edge',name:'Điện toán biên và đám mây',aliases:['điện toán đám mây','điện toán biên','xử lý phân tán','cloud computing','edge computing','distributed computing']}
    ]},
    { id: 'system_device', name: 'Hệ thống/thiết bị', concepts: [
      {id:'sensor',name:'Cảm biến và đo lường',aliases:['cảm biến','bộ cảm biến','cảm biến áp suất','cảm biến nhiệt độ','sensor','pressure sensor','temperature sensor','sensing apparatus']},
      {id:'actuator',name:'Bộ truyền động và điều khiển',aliases:['bộ truyền động','cơ cấu chấp hành','cơ cấu điều khiển','actuator','drive mechanism','control actuator']},
      {id:'mechanism',name:'Cơ cấu cơ khí',aliases:['cơ cấu cơ khí','bánh răng','trục truyền động','khớp nối','mechanical mechanism','gear assembly','drive shaft','mechanical linkage']},
      {id:'pump',name:'Bơm và dẫn lưu',aliases:['máy bơm','bơm chất lỏng','van điều tiết','pump apparatus','fluid pump','flow control valve']},
      {id:'circuit',name:'Mạch và linh kiện điện tử',aliases:['mạch điện tử','bảng mạch','mạch tích hợp','electronic circuit','printed circuit board','integrated circuit']},
      {id:'robot',name:'Robot và tự động hóa',aliases:['cánh tay robot','robot công nghiệp','thiết bị tự động hóa','robotic arm','industrial robot','automation device']},
      {id:'optical',name:'Thiết bị quang học',aliases:['ống kính quang học','bộ thu quang','cảm biến quang học','optical lens','optical receiver','optical sensor']},
      {id:'water',name:'Thiết bị lọc và xử lý nước',aliases:['thiết bị lọc nước','màng lọc nước','bộ lọc chất lỏng','water filtration device','water filter membrane','liquid filtration apparatus']}
    ]}
  ];
  function normalize(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d')
      .toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
  }
  function hasTerm(haystack, needle) {
    const n = normalize(needle);
    return n.length >= 3 && (' ' + haystack + ' ').includes(' ' + n + ' ');
  }
  function scan(text, opts) {
    const original = String(text || '');
    const limit = Math.max(1000, Math.min(Number(opts?.maxChars) || 200000, 1000000));
    // Do not claim full document classification when capped; keep an explicit audit.
    const input = original.slice(0, limit);
    const norm = normalize(input);
    const result = topics.map(topic => {
      const matches = topic.concepts.map(concept => {
        const found = [...new Set(concept.aliases.filter(alias => hasTerm(norm, alias)))];
        return found.length ? {id:concept.id,name:concept.name,matched:found,
          // Related search-language terms are SUGGESTIONS, not verified equivalents.
          alternatives:concept.aliases.filter(alias=>!found.some(f=>normalize(f)===normalize(alias))).slice(0,5)} : null;
      }).filter(Boolean);
      return {id:topic.id,name:topic.name,matchedConcepts:matches,conceptCount:matches.length,
        matchedTerms:matches.flatMap(m=>m.matched)};
    }).filter(item => item.conceptCount > 0)
      .sort((a,b)=>b.conceptCount-a.conceptCount || b.matchedTerms.length-a.matchedTerms.length);
    return {topics:result, primary:result.length?result[0].id:null,
      ambiguous:result.length>1 && result[0].conceptCount===result[1].conceptCount,
      scannedChars:input.length,totalChars:original.length,complete:input.length===original.length,
      lexiconVersion:'starter-v1',lexiconTerms:topics.reduce((n,t)=>n+t.concepts.length,0)};
  }
  const api = Object.freeze({topics, normalize, scan});
  root.PATENTLENS_TOPIC_ROUTER = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
