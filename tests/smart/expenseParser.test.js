import { describe, it, expect } from 'vitest';
import { parseExpenseInput, parseShoppingInput } from '../../src/services/smart/expenseParser.js';

// 2026-10-09 is a Friday.
const today = '2026-10-09';
const parse = (text, opts = {}) => parseExpenseInput(text, { today, ...opts });

describe('parseExpenseInput — amounts', () => {
  it.each([
    ['cà phê 35k', 35000, 'cà phê'],
    ['cà phê 35K', 35000, 'cà phê'],
    ['cà phê 35 k', 35000, 'cà phê'],
    ['cà phê 35kđ', 35000, 'cà phê'],
    ['cà phê 35.000đ', 35000, 'cà phê'],
    ['cà phê 35.000 đ', 35000, 'cà phê'],
    ['cà phê 35000 đồng', 35000, 'cà phê'],
    ['cà phê 35.000 vnd', 35000, 'cà phê'],
    ['cà phê 35000₫', 35000, 'cà phê'],
    ['ăn trưa 1tr', 1_000_000, 'ăn trưa'],
    ['ăn trưa 1tr2', 1_200_000, 'ăn trưa'],
    ['ăn trưa 1tr25', 1_250_000, 'ăn trưa'],
    ['ăn trưa 1tr250', 1_250_000, 'ăn trưa'],
    ['ăn trưa 1tr05', 1_050_000, 'ăn trưa'],
    ['điện 1,5tr', 1_500_000, 'điện'],
    ['điện 1.5tr', 1_500_000, 'điện'],
    ['điện 1.5 triệu', 1_500_000, 'điện'],
    ['laptop 2 triệu', 2_000_000, 'laptop'],
    ['laptop 25m', 25_000_000, 'laptop'],
    ['grab 120.000', 120_000, 'grab'],
    ['grab 120,000', 120_000, 'grab'],
    ['grab 120000', 120_000, 'grab'],
    ['tiền nhà 1.250.000', 1_250_000, 'tiền nhà'],
    ['bún 50 nghìn', 50_000, 'bún'],
    ['bún 50 ngàn', 50_000, 'bún'],
    ['bun 50 ngan', 50_000, 'bun'],
    ['trà đá 1k5', 1_500, 'trà đá'],
    ['phở 200', 200_000, 'phở'], // bare < 1000 → thousands
    ['phở 45', 45_000, 'phở'],
    ['gửi xe 5', 5_000, 'gửi xe'],
    ['xu lẻ 500đ', 500, 'xu lẻ'], // explicit đ keeps literal value
    ['mua nhà 2 tỷ', 2_000_000_000, 'mua nhà'],
    ['35k cà phê', 35000, 'cà phê'],
  ])('%s → %i', (text, amount, description) => {
    const r = parse(text);
    expect(r.amount).toBe(amount);
    expect(r.description).toBe(description);
  });

  it.each([
    ['Mua 3 cái bánh 45k', 45000, 'Mua 3 cái bánh'],
    ['Phở 2 tô 100', 100000, 'Phở 2 tô'],
    ['iPhone 15 25tr', 25_000_000, 'iPhone 15'],
    ['giảm 20% áo 300k', 300_000, 'giảm 20% áo'],
    ['Cơm 2 suất 70.000', 70_000, 'Cơm 2 suất'],
    ['Mua 2 ly trà sữa', null, 'Mua 2 ly trà sữa'], // quantities are never amounts
    ['vé xem phim 2 người 180k', 180_000, 'vé xem phim 2 người'],
  ])('ignores quantities: %s', (text, amount, description) => {
    expect(parse(text)).toMatchObject({ amount, description });
  });

  it('prefers explicit unit over bare/grouped numbers, then the last one', () => {
    expect(parse('combo 2 50k 30k').amount).toBe(30000);
    expect(parse('100 120.000').amount).toBe(120000);
  });

  it('no amount → null', () => {
    expect(parse('trà sữa')).toMatchObject({ amount: null, description: 'trà sữa' });
    expect(parse('')).toMatchObject({ amount: null, description: '', spent_on: today, payment_method: null });
  });
});

describe('parseExpenseInput — dates', () => {
  it.each([
    ['cơm 35k', today],
    ['cơm 35k hôm nay', today],
    ['cơm 35k hnay', today],
    ['cơm 35k hôm qua', '2026-10-08'],
    ['cơm 35k hqua', '2026-10-08'],
    ['cơm 35k hom qua', '2026-10-08'],
    ['cơm 35k tối qua', '2026-10-08'],
    ['cơm 35k hôm kia', '2026-10-07'],
    ['cơm 35k 3 ngày trước', '2026-10-06'],
    ['cơm 35k 05/10', '2026-10-05'],
    ['cơm 35k 9/10', '2026-10-09'],
    ['cơm 35k 15/10', '2025-10-15'], // future without year → last year's
    ['cơm 35k 29/02', '2024-02-29'], // most recent leap day
    ['cơm 35k 01/10/2026', '2026-10-01'],
    ['cơm 35k thứ 2', '2026-10-05'], // most recent Monday
    ['cơm 35k thứ 6', '2026-10-09'], // today is Friday
    ['cơm 35k cn tuần trước', '2026-10-04'],
  ])('%s → %s', (text, day) => {
    const r = parse(text);
    expect(r.spent_on).toBe(day);
    expect(r.amount).toBe(35000);
    expect(r.description).toBe('cơm');
  });

  it('invalid date is ignored (and not mistaken for an amount)', () => {
    const r = parse('cơm 35k 31/02');
    expect(r).toMatchObject({ spent_on: today, amount: 35000, description: 'cơm 31/02' });
  });

  it('year boundary: "hôm qua" on Jan 1st', () => {
    expect(parse('cơm 35k hôm qua', { today: '2027-01-01' }).spent_on).toBe('2026-12-31');
    expect(parse('cơm 35k 1/3', { today: '2028-03-01' }).spent_on).toBe('2028-03-01');
  });
});

describe('parseExpenseInput — payment method', () => {
  it.each([
    ['cơm 35k tiền mặt', 'cash'],
    ['cơm 35k tm', 'cash'],
    ['cơm 35k cash', 'cash'],
    ['cơm 35k ck', 'bank'],
    ['cơm 35k CK', 'bank'],
    ['cơm 35k chuyển khoản', 'bank'],
    ['cơm 35k chuyen khoan', 'bank'],
    ['cơm 35k ngân hàng', 'bank'],
    ['cơm 35k bank', 'bank'],
    ['cơm 35k thẻ', 'credit_card'],
    ['cơm 35k thẻ tín dụng', 'credit_card'],
    ['cơm 35k visa', 'credit_card'],
    ['cơm 35k credit', 'credit_card'],
    ['cơm 35k momo', 'e_wallet'],
    ['cơm 35k MoMo', 'e_wallet'],
    ['cơm 35k zalopay', 'e_wallet'],
    ['cơm 35k zalo pay', 'e_wallet'],
    ['cơm 35k vnpay', 'e_wallet'],
    ['cơm 35k shopeepay', 'e_wallet'],
    ['cơm 35k ví', 'e_wallet'],
    ['cơm 35k bằng momo', 'e_wallet'],
    ['cơm 35k trả bằng thẻ', 'credit_card'],
    ['cơm 35k qua ck', 'bank'],
  ])('%s → %s', (text, method) => {
    const r = parse(text);
    expect(r.payment_method).toBe(method);
    expect(r.description).toBe('cơm');
    expect(r.amount).toBe(35000);
  });

  it('ambiguous words are not payment methods', () => {
    expect(parse('The Coffee House 55k')).toMatchObject({ payment_method: null, description: 'The Coffee House' });
    expect(parse('vì đói ăn bánh 20k')).toMatchObject({ payment_method: null, description: 'vì đói ăn bánh' });
    expect(parse('shopee 200k')).toMatchObject({ payment_method: null, description: 'shopee' });
  });
});

describe('parseExpenseInput — contract examples & combos', () => {
  it.each([
    ['cà phê 35k', { amount: 35000, description: 'cà phê', spent_on: today, payment_method: null }],
    ['ăn trưa 1tr2', { amount: 1_200_000, description: 'ăn trưa', spent_on: today, payment_method: null }],
    ['grab 120.000 hôm qua momo', { amount: 120000, description: 'grab', spent_on: '2026-10-08', payment_method: 'e_wallet' }],
    ['điện 1,5tr ck', { amount: 1_500_000, description: 'điện', spent_on: today, payment_method: 'bank' }],
    ['TIỀN NHÀ 3TR500 CHUYỂN KHOẢN 01/10', { amount: 3_500_000, description: 'TIỀN NHÀ', spent_on: '2026-10-01', payment_method: 'bank' }],
    ['tien dien 850k hom kia ck', { amount: 850_000, description: 'tien dien', spent_on: '2026-10-07', payment_method: 'bank' }],
  ])('%s', (text, expected) => {
    expect(parse(text)).toEqual(expected);
  });

  it('NFD input', () => {
    expect(parse('cà phê 35k hôm qua'.normalize('NFD'))).toMatchObject({ amount: 35000, spent_on: '2026-10-08', description: 'cà phê' });
  });
});

describe('parseExpenseInput — slang units (M4) and grouped k (M5)', () => {
  it.each([
    ['tiền nhà 5 củ', 5_000_000, 'tiền nhà'],
    ['tiền nhà 5 cu', 5_000_000, 'tiền nhà'],
    ['tiền nhà 5 củ rưỡi', 5_500_000, 'tiền nhà'],
    ['mua điện thoại 2 xị', 200_000, 'mua điện thoại'],
    ['taxi 2 trăm', 200_000, 'taxi'],
    ['ăn tối 1 trăm rưỡi', 150_000, 'ăn tối'],
    ['mua điện thoại 5 triệu rưỡi', 5_500_000, 'mua điện thoại'],
    ['mua điện thoại 5tr rưỡi', 5_500_000, 'mua điện thoại'],
    ['mua nhà 1 tỷ 2', 1_200_000_000, 'mua nhà'],
    ['ăn trưa 1 triệu 2', 1_200_000, 'ăn trưa'],
    ['laptop 1.250k', 1_250_000, 'laptop'],
    ['laptop 1,250k', 1_250_000, 'laptop'],
    ['xe 1.500tr', 1_500_000_000, 'xe'],
  ])('%s → %i', (text, amount, description) => {
    expect(parse(text)).toMatchObject({ amount, description });
  });

  it('"lít" is a volume, never money', () => {
    expect(parse('xăng 1 lít')).toMatchObject({ amount: null, description: 'xăng 1 lít' });
    expect(parse('xăng 2 lít 50k')).toMatchObject({ amount: 50_000, description: 'xăng 2 lít' });
  });

  it('a spaced tail digit followed by a quantity word stays out of the amount', () => {
    expect(parse('vé 2 triệu 2 người')).toMatchObject({ amount: 2_000_000, description: 'vé 2 người' });
  });
});

describe('parseExpenseInput — numbers that are part of a name (M6)', () => {
  it.each([
    'mua iPhone 15',
    'Họp phòng 302',
    'tiền điện tháng 9',
    'Sách lớp 5',
    'tivi 55 inch',
    'ổ cứng 512 gb',
    'Sinh nhật 20 tuổi',
  ])('"%s" → amount null, number kept', (text) => {
    expect(parse(text)).toMatchObject({ amount: null, description: text });
  });

  it('real amounts still work', () => {
    expect(parse('phở 45')).toMatchObject({ amount: 45_000, description: 'phở' });
    expect(parse('iPhone 15 25tr')).toMatchObject({ amount: 25_000_000, description: 'iPhone 15' });
    expect(parse('tiền điện tháng 9 1tr2')).toMatchObject({ amount: 1_200_000, description: 'tiền điện tháng 9' });
    expect(parse('khách sạn phòng 302 800k')).toMatchObject({ amount: 800_000, description: 'khách sạn phòng 302' });
  });
});

describe('parseExpenseInput — low-severity edge cases', () => {
  it('amount cap fits numeric(14,2)', () => {
    expect(parse('x 1000 tỷ').amount).toBeNull();
    expect(parse('x 999 tỷ').amount).toBe(999_000_000_000);
  });

  it('fractions are not dates', () => {
    expect(parse('1/2 kg thịt 80k')).toMatchObject({ spent_on: today, amount: 80_000 });
    expect(parse('cafe 30k 1/2')).toMatchObject({ spent_on: today, amount: 30_000 });
  });

  it('"1-1" is not a date; "01-10" still is', () => {
    expect(parse('họp 1-1 50k').spent_on).toBe(today);
    expect(parse('cơm 35k 01-10').spent_on).toBe('2026-10-01');
  });

  it('zero-width characters are stripped', () => {
    expect(parse('​﻿')).toMatchObject({ description: '', amount: null });
    expect(parse('cà​ phê 35k')).toMatchObject({ description: 'cà phê', amount: 35_000 });
  });

  it('today near 9999-12-31 never throws', () => {
    expect(() => parse('cơm 35k thứ 2 tuần trước', { today: '9999-12-31' })).not.toThrow();
    expect(() => parse('cơm 35k hôm qua', { today: '1900-01-01' })).not.toThrow();
  });
});

describe('parseShoppingInput', () => {
  it.each([
    'Xiaomi 14',
    'Giày size 42',
    'tivi 55 inch',
    'Bàn phím 87 phím',
    'Sách tập 3',
    'Win 11 key',
    'Bút bi 0.5',
    'Rau 15',
  ])('"%s" → price null, number kept in the name', (text) => {
    expect(parseShoppingInput(text)).toMatchObject({ name: text, unit_price: null, quantity: 1 });
  });

  it.each([
    ['sữa tắm 120k x2', 'sữa tắm', 120_000, 2],
    ['iPhone 15 25tr', 'iPhone 15', 25_000_000, 1],
    ['nước mắm 35.000', 'nước mắm', 35_000, 1],
    ['nước mắm 35000', 'nước mắm', 35_000, 1],
    ['màn hình 27 inch 5tr', 'màn hình 27 inch', 5_000_000, 1],
    ['Bút bi 5k x10', 'Bút bi', 5_000, 10],
  ])('%s', (text, name, unit_price, quantity) => {
    expect(parseShoppingInput(text)).toMatchObject({ name, unit_price, quantity });
  });
});
