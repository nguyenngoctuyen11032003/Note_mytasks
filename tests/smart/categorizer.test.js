import { describe, it, expect } from 'vitest';
import { normalizeVi, tokenize, suggestCategory, keywordScores, KEYWORDS } from '../../src/services/smart/categorizer.js';

const categories = [
  { id: 'food', name: 'Ăn uống', kind: 'expense' },
  { id: 'move', name: 'Đi lại', kind: 'expense' },
  { id: 'home', name: 'Nhà ở', kind: 'expense' },
  { id: 'shop', name: 'Mua sắm', kind: 'expense' },
  { id: 'fun', name: 'Giải trí', kind: 'expense' },
  { id: 'tech', name: 'Công nghệ', kind: 'expense' },
  { id: 'edu', name: 'Học tập', kind: 'expense' },
  { id: 'health', name: 'Sức khỏe', kind: 'expense' },
  { id: 'other', name: 'Khác', kind: 'expense' },
  { id: 'task-edu', name: 'Học tập', kind: 'task' },
];
const top = (desc, opts = {}) => suggestCategory(desc, { categories, ...opts })[0];

describe('normalizeVi / tokenize', () => {
  it.each([
    ['Đường Phố', 'duong pho'],
    ['  CÀ   PHÊ  ', 'ca phe'],
    ['Trà sữa trân châu', 'tra sua tran chau'],
    ['Sức khỏe', 'suc khoe'],
    ['Sức khoẻ', 'suc khoe'],
    ['ĐĂNG KÝ', 'dang ky'],
    ['Nước mía'.normalize('NFD'), 'nuoc mia'],
    ['ưu tiên', 'uu tien'],
    [null, ''],
  ])('normalizeVi(%j) = %j', (input, out) => {
    expect(normalizeVi(input)).toBe(out);
  });

  it('tokenize drops short tokens, numbers, amounts and stopwords', () => {
    expect(tokenize('Mua 2 ly trà sữa 35k cho Lan')).toEqual(['ly', 'tra', 'sua', 'lan']);
    expect(tokenize('Tiền điện tháng 10 1.250.000')).toEqual(['dien', 'thang']);
  });
});

describe('keyword dictionary', () => {
  it('has a rich list for every non-"Khác" category', () => {
    for (const [name, words] of Object.entries(KEYWORDS)) {
      if (name !== 'Khác') expect(words.length, name).toBeGreaterThanOrEqual(15);
    }
    expect(Object.keys(KEYWORDS)).toHaveLength(9);
  });

  it.each([
    ['cà phê sáng', 'food'],
    ['ca phe', 'food'],
    ['Trà sữa 35k', 'food'],
    ['phở bò', 'food'],
    ['bún chả', 'food'],
    ['nước mía', 'food'], // longest phrase beats "nước" (water bill)
    ['grab đi làm', 'move'],
    ['đổ xăng', 'move'],
    ['gửi xe tháng 10', 'move'],
    ['taxi sân bay', 'move'],
    ['tiền nhà tháng 10', 'home'],
    ['tiền điện', 'home'],
    ['tiền nước', 'home'],
    ['internet fpt', 'home'],
    ['shopee', 'shop'],
    ['quần áo lazada', 'shop'],
    ['netflix', 'fun'],
    ['xem phim cgv', 'fun'],
    ['spotify premium', 'fun'],
    ['tiền điện thoại', 'tech'], // "điện thoại" beats "điện"
    ['mua laptop', 'tech'],
    ['sách lập trình', 'edu'],
    ['khóa học udemy', 'edu'],
    ['thuốc cảm', 'health'],
    ['khám răng', 'health'],
    ['gym tháng 10', 'health'],
    ['mừng cưới bạn', 'other'],
    ['THUỐC', 'health'],
  ])('%s → %s', (desc, id) => {
    const r = top(desc);
    expect(r.category_id).toBe(id);
    expect(r.source).toBe('keywords');
    expect(r.confidence).toBeGreaterThan(0.3);
    expect(r.confidence).toBeLessThanOrEqual(0.85);
  });

  it('keywordScores weights multi-word phrases higher', () => {
    expect(keywordScores('trà sữa').get('an uong')).toBe(2);
  });

  it('unknown text, empty text → []', () => {
    expect(suggestCategory('xyz qwerty', { categories })).toEqual([]);
    expect(suggestCategory('', { categories })).toEqual([]);
    expect(suggestCategory('   ', { categories })).toEqual([]);
  });

  it('without categories keywords cannot be mapped', () => {
    expect(suggestCategory('cà phê', {})).toEqual([]);
  });

  it('task-kind categories are never suggested', () => {
    const r = suggestCategory('sách', { categories });
    expect(r.map((x) => x.category_id)).not.toContain('task-edu');
  });
});

describe('history (naive Bayes)', () => {
  const coffeeAsFun = [
    { description: 'cà phê với bạn', category_id: 'fun' },
    { description: 'cà phê cuối tuần', category_id: 'fun' },
    { description: 'cà phê sáng', category_id: 'fun' },
  ];

  it('≥ 3 matching samples outweigh conflicting keywords', () => {
    const r = suggestCategory('cà phê', { categories, history: coffeeAsFun });
    expect(r[0]).toMatchObject({ category_id: 'fun', source: 'history' });
    expect(r[1]).toMatchObject({ category_id: 'food', source: 'keywords' });
    expect(r[0].confidence).toBeGreaterThan(r[1].confidence);
  });

  it('a single matching sample does not override keywords', () => {
    const r = suggestCategory('cà phê', { categories, history: coffeeAsFun.slice(0, 1) });
    expect(r[0].category_id).toBe('food');
    expect(r[1].category_id).toBe('fun');
  });

  it('learns user-specific vocabulary unknown to the dictionary', () => {
    const history = [
      { description: 'Cửa hàng Ông Tư', category_id: 'shop' },
      { description: 'ông tư tạp hóa', category_id: 'shop' },
      { description: 'Ong Tu', category_id: 'shop' },
      { description: 'bánh mì', category_id: 'food' },
    ];
    const r = suggestCategory('ÔNG TƯ', { categories, history });
    expect(r[0]).toMatchObject({ category_id: 'shop', source: 'history' });
    expect(r).toHaveLength(1);
  });

  it('confidence grows with evidence and stays within 0..1', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ description: `bida quán ${i}`, category_id: 'fun' }));
    const c3 = suggestCategory('bida', { categories, history: many.slice(0, 3) })[0].confidence;
    const c20 = suggestCategory('bida', { categories, history: many })[0].confidence;
    expect(c20).toBeGreaterThan(c3);
    expect(c20).toBeLessThanOrEqual(1);
  });

  it('splits votes between categories by token likelihood (Laplace smoothed)', () => {
    const history = [
      { description: 'grab đi làm', category_id: 'move' },
      { description: 'grab về nhà', category_id: 'move' },
      { description: 'grab food cơm', category_id: 'food' },
      { description: 'grab food phở', category_id: 'food' },
      { description: 'grab food bún', category_id: 'food' },
    ];
    const r = suggestCategory('grab food', { categories, history });
    expect(r[0].category_id).toBe('food');
    expect(r.map((x) => x.category_id)).toContain('move');
  });

  it('ignores history of deleted/unknown categories and malformed rows', () => {
    const history = [
      { description: 'cà phê', category_id: 'deleted' },
      { description: 'cà phê', category_id: 'deleted' },
      { description: 'cà phê', category_id: 'deleted' },
      null,
      { description: '', category_id: 'fun' },
      { description: 'cà phê' },
    ];
    const r = suggestCategory('cà phê', { categories, history });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ category_id: 'food', source: 'keywords' });
  });

  it('returns at most 3, sorted by confidence desc', () => {
    const history = [
      { description: 'quà sinh nhật', category_id: 'other' },
      { description: 'quà sinh nhật mẹ', category_id: 'shop' },
      { description: 'quà sinh nhật bạn', category_id: 'fun' },
      { description: 'quà sinh nhật sếp', category_id: 'food' },
    ];
    const r = suggestCategory('quà sinh nhật', { categories, history });
    expect(r.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < r.length; i++) expect(r[i - 1].confidence).toBeGreaterThanOrEqual(r[i].confidence);
  });

  it('works with history only (no categories given)', () => {
    const history = [{ description: 'cà phê', category_id: 'x' }, { description: 'cà phê sữa', category_id: 'x' }];
    expect(suggestCategory('cà phê', { history })[0]).toMatchObject({ category_id: 'x', source: 'history' });
  });

  it('is deterministic', () => {
    const a = suggestCategory('cà phê', { categories, history: coffeeAsFun });
    const b = suggestCategory('cà phê', { categories, history: coffeeAsFun });
    expect(a).toEqual(b);
  });
});
