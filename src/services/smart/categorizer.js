// Expense category suggestion — offline, deterministic.
//
//   suggestCategory('trà sữa 35k', { history, categories }) →
//     [{ category_id, confidence: 0..1, source: 'history'|'keywords' }]  (max 3, desc)
//
// Two signals are blended:
// 1. history — multinomial naive Bayes over the user's past {description, category_id}
//    (unigrams + bigrams, Laplace smoothing), restricted to categories that have at least
//    one sample sharing a token with the query. Its weight grows with evidence:
//    w = M / (M + 1.2) where M = number of matching samples (1 → .45, 3 → .71, 10 → .89).
// 2. keywords — a built-in Vietnamese dictionary mapped to the 9 default expense
//    category NAMES (Ăn uống, Đi lại, …), matched on the normalised text, longest
//    phrase first (so "nước mía" is a drink, "tiền nước" a utility bill, "điện thoại"
//    is tech not electricity). Capped at 0.85 confidence.
// final = w·history + (1−w)·0.85·keywords. With ≥ 3 matching history samples the
// history vote outweighs a conflicting keyword vote. `source` = the larger contributor.

import { normalizeVi } from './text.js';

export { normalizeVi };

const STOPWORDS = new Set([
  'va', 'cho', 'cua', 'voi', 'la', 'cai', 'mot', 'hai', 'nhung', 'cac', 'nhe', 'roi',
  'di', 'o', 'tai', 'luc', 'khi', 'thi', 'de', 'tien', 'mua', 'chi', 'phi', 'so',
]);

/** Normalised word tokens (≥ 2 chars, no pure numbers / amounts, no stopwords). */
export function tokenize(text) {
  return normalizeVi(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !/^\d+([.,]\d+)*(k|tr|d|m)?\d*$/.test(t) && !STOPWORDS.has(t));
}
const features = (tokens) => {
  const out = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]}_${tokens[i + 1]}`);
  return out;
};

// ---- keyword dictionary (keys = default category names) ---------------------------

export const KEYWORDS = {
  'Ăn uống': [
    'cà phê', 'cafe', 'coffee', 'cf', 'trà sữa', 'trà đá', 'trà chanh', 'trà', 'sinh tố', 'nước mía',
    'nước ngọt', 'nước cam', 'nước suối', 'nước ép', 'cơm', 'cơm tấm', 'phở', 'bún', 'bún chả', 'bún bò',
    'miến', 'bánh mì', 'bánh cuốn', 'bánh', 'cháo', 'xôi', 'lẩu', 'nướng', 'ăn sáng', 'ăn trưa',
    'ăn tối', 'ăn vặt', 'ăn', 'quán ăn', 'nhà hàng', 'highlands', 'starbucks', 'phúc long',
    'the coffee house', 'katinat', 'kfc', 'lotteria', 'mcdonald', 'jollibee', 'pizza', 'gà rán',
    'bia', 'rượu', 'kem', 'chè', 'hủ tiếu', 'mì', 'mì cay', 'sushi', 'buffet', 'bánh tráng',
    'đồ ăn', 'thức ăn', 'grabfood', 'shopeefood', 'baemin', 'đi chợ', 'rau', 'thịt', 'cá',
    'trứng', 'gạo', 'sữa', 'hoa quả', 'trái cây', 'snack', 'tráng miệng', 'nước uống', 'đồ uống',
  ],
  'Đi lại': [
    'grab', 'grabbike', 'grabcar', 'be', 'gojek', 'xanh sm', 'taxi', 'xăng', 'đổ xăng', 'gửi xe',
    'vé xe', 'xe buýt', 'xe bus', 'bus', 'metro', 'vé máy bay', 'máy bay', 'vietjet',
    'vietnam airlines', 'bamboo airways', 'tàu', 'tàu hỏa', 'vé tàu', 'rửa xe', 'sửa xe',
    'thay nhớt', 'bảo dưỡng xe', 'phí cầu đường', 'cầu đường', 'vetc', 'epass', 'đỗ xe',
    'xe ôm', 'uber', 'đi lại', 'cước xe', 'vá xe', 'thay lốp', 'đăng kiểm', 'bảo hiểm xe',
  ],
  'Nhà ở': [
    'tiền nhà', 'thuê nhà', 'tiền phòng', 'tiền trọ', 'nhà trọ', 'điện', 'tiền điện', 'nước',
    'tiền nước', 'nước sạch', 'internet', 'wifi', 'cáp quang', 'vnpt', 'gas', 'bình gas',
    'phí quản lý', 'chung cư', 'tiền rác', 'sửa nhà', 'nội thất', 'dọn nhà', 'giúp việc',
    'điện nước', 'hóa đơn điện', 'hóa đơn nước', 'truyền hình cáp', 'chuyển nhà', 'sửa ống nước',
    'thợ điện', 'đồ gia dụng', 'nồi cơm', 'máy giặt', 'tủ lạnh', 'điều hòa',
  ],
  'Mua sắm': [
    'shopee', 'lazada', 'tiki', 'sendo', 'tiktok shop', 'quần áo', 'áo', 'quần', 'váy', 'giày',
    'dép', 'túi xách', 'mỹ phẩm', 'son', 'nước hoa', 'trang sức', 'đồng hồ', 'kính', 'siêu thị',
    'winmart', 'coopmart', 'bách hóa xanh', 'aeon', 'lotte mart', 'big c', 'go', 'vinmart',
    'đồ dùng', 'uniqlo', 'zara', 'h&m', 'circle k', 'gs25', 'ministop', '7 eleven', 'tạp hóa',
    'dầu gội', 'sữa tắm', 'kem đánh răng', 'giấy vệ sinh', 'bột giặt', 'quà', 'quà tặng',
  ],
  'Giải trí': [
    'netflix', 'spotify', 'youtube premium', 'phim', 'xem phim', 'rạp', 'cgv', 'lotte cinema',
    'bhd', 'galaxy cinema', 'karaoke', 'game', 'steam', 'playstation', 'nintendo', 'du lịch',
    'khách sạn', 'homestay', 'resort', 'concert', 'vé concert', 'nhạc', 'bida', 'bowling',
    'công viên', 'vui chơi', 'đi chơi', 'nhậu', 'pub', 'bar', 'club', 'apple music', 'fpt play',
    'vieon', 'disney', 'sở thú', 'bảo tàng', 'picnic', 'cắm trại', 'đá bóng', 'thuê sân',
  ],
  'Công nghệ': [
    'điện thoại', 'iphone', 'samsung', 'xiaomi', 'oppo', 'laptop', 'macbook', 'máy tính', 'pc',
    'tai nghe', 'airpods', 'bàn phím', 'chuột', 'màn hình', 'ssd', 'ram', 'usb', 'sạc', 'cáp sạc',
    'ốp lưng', 'icloud', 'google one', 'chatgpt', 'claude', 'github', 'domain', 'tên miền',
    'hosting', 'vps', 'aws', 'phần mềm', 'app store', 'google play', 'nạp thẻ', 'nạp điện thoại',
    'tiền điện thoại', 'cước điện thoại', 'sim', '4g', 'data', 'thế giới di động', 'fpt shop',
    'cellphones', 'ipad', 'máy in', 'loa', 'webcam', 'router', 'linh kiện', 'microsoft 365',
  ],
  'Học tập': [
    'sách', 'khóa học', 'học phí', 'udemy', 'coursera', 'edx', 'học', 'lớp học', 'gia sư',
    'ielts', 'toeic', 'tiếng anh', 'bút', 'vở', 'giấy in', 'photo', 'in ấn', 'tài liệu',
    'dụng cụ học tập', 'thi', 'lệ phí thi', 'duolingo', 'skillshare', 'học thêm', 'trung tâm',
    'fahasa', 'giáo trình', 'luyện thi', 'chứng chỉ', 'hội thảo', 'workshop', 'văn phòng phẩm',
  ],
  'Sức khỏe': [
    'thuốc', 'nhà thuốc', 'khám', 'khám bệnh', 'bệnh viện', 'phòng khám', 'bác sĩ', 'nha khoa',
    'nhổ răng', 'xét nghiệm', 'vitamin', 'thực phẩm chức năng', 'gym', 'yoga', 'thể dục',
    'thể thao', 'bơi', 'hồ bơi', 'chạy bộ', 'massage', 'spa', 'bảo hiểm y tế', 'bhyt',
    'khẩu trang', 'pharmacity', 'long châu', 'an khang', 'vaccine', 'tiêm', 'tiêm phòng',
    'kính cận', 'cắt tóc', 'whey', 'pilates', 'vật lý trị liệu',
  ],
  'Khác': [
    'đám cưới', 'mừng cưới', 'đám giỗ', 'đám ma', 'phúng viếng', 'lì xì', 'từ thiện', 'quyên góp',
    'phí chuyển khoản', 'phí ngân hàng', 'phạt', 'tiền phạt', 'cho vay', 'trả nợ', 'thuế',
  ],
};

const DICT = Object.entries(KEYWORDS)
  .flatMap(([name, words]) => words.map((w) => {
    const toks = normalizeVi(w).split(/[^\p{L}\p{N}&]+/u).filter(Boolean);
    return { name: normalizeVi(name), toks, len: toks.join(' ').length };
  }))
  .sort((a, b) => b.toks.length - a.toks.length || b.len - a.len);

/** Keyword votes per normalised default-category name. */
export function keywordScores(description) {
  const toks = normalizeVi(description).split(/[^\p{L}\p{N}&]+/u).filter(Boolean);
  const used = new Array(toks.length).fill(false);
  const scores = new Map();
  for (const k of DICT) {
    const n = k.toks.length;
    for (let i = 0; i + n <= toks.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) if (used[i + j] || toks[i + j] !== k.toks[j]) { ok = false; break; }
      if (!ok) continue;
      for (let j = 0; j < n; j++) used[i + j] = true;
      scores.set(k.name, (scores.get(k.name) || 0) + n);
    }
  }
  return scores;
}

// ---- history (naive Bayes) -----------------------------------------------------------

function historyScores(queryFeatures, history, allowed) {
  const qUni = new Set(queryFeatures.filter((f) => !f.includes('_')));
  if (!qUni.size) return { post: new Map(), matching: 0 };
  const docs = [];
  for (const h of history || []) {
    if (!h || h.category_id == null || !h.description) continue;
    if (allowed && !allowed.has(h.category_id)) continue;
    const toks = tokenize(h.description);
    if (!toks.length) continue;
    docs.push({ cat: h.category_id, toks, feats: features(toks) });
  }
  const vocab = new Set();
  const stats = new Map(); // cat → {n, total, counts, matching}
  for (const d of docs) {
    let s = stats.get(d.cat);
    if (!s) stats.set(d.cat, (s = { n: 0, total: 0, counts: new Map(), matching: 0 }));
    s.n++;
    for (const f of d.feats) {
      vocab.add(f);
      s.total++;
      s.counts.set(f, (s.counts.get(f) || 0) + 1);
    }
    if (d.toks.some((t) => qUni.has(t))) s.matching++;
  }
  const cands = [...stats.entries()].filter(([, s]) => s.matching > 0);
  if (!cands.length) return { post: new Map(), matching: 0 };
  const V = vocab.size;
  const N = docs.length;
  const qf = queryFeatures.filter((f) => vocab.has(f));
  const logs = cands.map(([cat, s]) => {
    let lp = Math.log((s.n + 1) / (N + stats.size));
    for (const f of qf) lp += Math.log(((s.counts.get(f) || 0) + 1) / (s.total + V));
    return [cat, lp];
  });
  const max = Math.max(...logs.map(([, l]) => l));
  const exps = logs.map(([c, l]) => [c, Math.exp(l - max)]);
  const sum = exps.reduce((a, [, e]) => a + e, 0);
  const matching = cands.reduce((a, [, s]) => a + s.matching, 0);
  return { post: new Map(exps.map(([c, e]) => [c, e / sum])), matching };
}

// ---- public API ------------------------------------------------------------------

const KW_CAP = 0.85;

/**
 * @param {string} description
 * @param {{history?: Array<{description, category_id}>, categories?: Array<{id, name, kind?}>, limit?: number}} [opts]
 */
export function suggestCategory(description, { history = [], categories = [], limit = 3 } = {}) {
  if (!description || !String(description).trim()) return [];
  const cats = (categories || []).filter((c) => c && c.id != null && (!c.kind || c.kind === 'expense'));
  const allowed = cats.length ? new Set(cats.map((c) => c.id)) : null;
  const order = new Map(cats.map((c, i) => [c.id, i]));

  const { post, matching } = historyScores(features(tokenize(description)), history, allowed);
  const w = matching ? matching / (matching + 1.2) : 0;

  const kwByName = keywordScores(description);
  const kw = new Map();
  let kwSum = 0;
  for (const c of cats) {
    const s = kwByName.get(normalizeVi(c.name));
    if (s && !kw.has(c.id)) { kw.set(c.id, s); kwSum += s; }
  }

  const ids = new Set([...post.keys(), ...kw.keys()]);
  const out = [];
  for (const id of ids) {
    const h = w * (post.get(id) || 0);
    const k = kwSum ? (1 - w) * KW_CAP * ((kw.get(id) || 0) / kwSum) : 0;
    const confidence = Math.round(Math.min(1, h + k) * 1000) / 1000;
    if (confidence <= 0) continue;
    out.push({ category_id: id, confidence, source: h >= k ? 'history' : 'keywords' });
  }
  out.sort((a, b) => b.confidence - a.confidence ||
    (order.get(a.category_id) ?? 1e9) - (order.get(b.category_id) ?? 1e9));
  return out.slice(0, limit);
}

/**
 * Order category ids by how often AND how recently they were used — for the
 * "recent category" chips. Each use weighs 0.5^(age / halfLife) (age in rows,
 * newest first), so yesterday's coffee beats last quarter's rent.
 * @param {Array<{category_id}>} history newest first
 * @returns {string[]} category ids, most relevant first (only used ones)
 */
export function rankCategories(history = [], { halfLife = 25 } = {}) {
  const score = new Map();
  (history || []).forEach((h, i) => {
    if (!h || h.category_id == null) return;
    score.set(h.category_id, (score.get(h.category_id) || 0) + 0.5 ** (i / halfLife));
  });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Most used payment method in a recent history (newest first), or null. */
export function topPaymentMethod(history = [], { take = 40 } = {}) {
  const c = new Map();
  for (const h of (history || []).slice(0, take)) if (h?.payment_method) c.set(h.payment_method, (c.get(h.payment_method) || 0) + 1);
  let best = null, n = 0;
  for (const [k, v] of c) if (v > n) { best = k; n = v; }
  return best;
}
