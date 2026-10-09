import { describe, it, expect } from 'vitest';
import { parseTaskInput } from '../../src/services/smart/quickAdd.js';

// 2026-10-09 is a Friday.
const today = '2026-10-09';
const categories = [
  { id: 'work', name: 'Công việc', kind: 'task' },
  { id: 'me', name: 'Cá nhân', kind: 'task' },
  { id: 'study', name: 'Học tập', kind: 'task' },
  { id: 'study-exp', name: 'Học tập', kind: 'expense' },
  { id: 'health', name: 'Sức khỏe', kind: 'task' },
];
const parse = (text, opts = {}) => parseTaskInput(text, { today, categories, ...opts });

describe('parseTaskInput — relative dates', () => {
  it.each([
    ['Họp hôm nay', '2026-10-09', 'Họp'],
    ['Hop hom nay', '2026-10-09', 'Hop'],
    ['hnay nộp bài', '2026-10-09', 'nộp bài'],
    ['Gọi điện tối nay', '2026-10-09', 'Gọi điện'],
    ['Nộp báo cáo mai', '2026-10-10', 'Nộp báo cáo'],
    ['Nộp báo cáo ngày mai', '2026-10-10', 'Nộp báo cáo'],
    ['nop bao cao ngay mai', '2026-10-10', 'nop bao cao'],
    ['NỘP BÁO CÁO NGÀY MAI', '2026-10-10', 'NỘP BÁO CÁO'],
    ['Mai đi chợ', '2026-10-10', 'đi chợ'],
    ['Chạy bộ sáng mai', '2026-10-10', 'Chạy bộ'],
    ['Đi khám ngày kia', '2026-10-11', 'Đi khám'],
    ['Đi khám mốt', '2026-10-11', 'Đi khám'],
    ['di kham ngay mot', '2026-10-11', 'di kham'],
    ['Review tuần sau', '2026-10-12', 'Review'],
    ['Review tuan toi', '2026-10-12', 'Review'],
    ['Dọn nhà cuối tuần', '2026-10-10', 'Dọn nhà'],
    ['Dọn nhà cuối tuần sau', '2026-10-17', 'Dọn nhà'],
    ['Nộp thuế cuối tháng', '2026-10-31', 'Nộp thuế'],
    ['Nộp thuế cuối tháng sau', '2026-11-30', 'Nộp thuế'],
    ['Đóng học phí đầu tháng sau', '2026-11-01', 'Đóng học phí'],
    ['Gia hạn hộ chiếu 3 ngày nữa', '2026-10-12', 'Gia hạn hộ chiếu'],
    ['Họp ngày 20', '2026-10-20', 'Họp'],
    ['Họp ngày 5', '2026-11-05', 'Họp'],
  ])('%s', (text, due, title) => {
    const r = parse(text);
    expect(r.due_date).toBe(due);
    expect(r.title).toBe(title);
  });
});

describe('parseTaskInput — weekdays (next occurrence strictly after today)', () => {
  it.each([
    ['Họp thứ 2', '2026-10-12'],
    ['Họp thứ hai', '2026-10-12'],
    ['Họp thu 3', '2026-10-13'],
    ['Họp t4', '2026-10-14'],
    ['Họp T5', '2026-10-15'],
    ['Họp thứ 6', '2026-10-16'], // today is Friday → next Friday
    ['Họp thứ 6 này', '2026-10-09'], // "này" allows today
    ['Họp thứ bảy', '2026-10-10'],
    ['Họp t7', '2026-10-10'],
    ['Họp cn', '2026-10-11'],
    ['Họp chủ nhật', '2026-10-11'],
    ['Họp chu nhat', '2026-10-11'],
    ['Họp thứ 2 tuần sau', '2026-10-12'],
    ['Họp thứ 7 tuần sau', '2026-10-17'],
    ['Họp cn tuần tới', '2026-10-18'],
    ['Họp thứ sáu tuần sau', '2026-10-16'],
  ])('%s → %s', (text, due) => {
    const r = parse(text);
    expect(r.due_date).toBe(due);
    expect(r.title).toBe('Họp');
  });

  it('Saturday today: "thứ 7" is next Saturday, "cuối tuần" is today', () => {
    expect(parse('Đi bơi thứ 7', { today: '2026-10-10' }).due_date).toBe('2026-10-17');
    expect(parse('Đi bơi cuối tuần', { today: '2026-10-10' }).due_date).toBe('2026-10-10');
    expect(parse('Đi bơi cuối tuần', { today: '2026-10-11' }).due_date).toBe('2026-10-11');
  });
});

describe('parseTaskInput — explicit dates', () => {
  it.each([
    ['Sinh nhật mẹ 15/10', '2026-10-15'],
    ['Sinh nhật mẹ 5-11', '2026-11-05'],
    ['Sinh nhật mẹ 05/10', '2027-10-05'], // already past this year → next year
    ['Sinh nhật mẹ 9/10', '2026-10-09'], // today counts
    ['Sinh nhật mẹ 15/10/2027', '2027-10-15'],
    ['Sinh nhật mẹ 1/1/27', '2027-01-01'],
    ['Sinh nhật mẹ ngày 24/12', '2026-12-24'],
    ['Sinh nhật mẹ 29/02', '2028-02-29'], // next leap year
    ['Sinh nhật mẹ 31/12', '2026-12-31'],
  ])('%s → %s', (text, due) => {
    const r = parse(text);
    expect(r.due_date).toBe(due);
    expect(r.title).toBe('Sinh nhật mẹ');
  });

  it.each(['Họp 31/02', 'Họp 32/1', 'Họp 10/13', 'Họp 29/02/2027', 'Họp 0/5'])(
    'invalid date "%s" is ignored and kept in the title', (text) => {
      const r = parse(text);
      expect(r.due_date).toBeNull();
      expect(r.title).toBe(text);
    });

  it('month and year boundaries', () => {
    expect(parse('X mai', { today: '2026-01-31' }).due_date).toBe('2026-02-01');
    expect(parse('X mai', { today: '2028-02-28' }).due_date).toBe('2028-02-29');
    expect(parse('X mai', { today: '2026-12-31' }).due_date).toBe('2027-01-01');
    expect(parse('X tuần sau', { today: '2026-12-31' }).due_date).toBe('2027-01-04');
    expect(parse('X 01/01', { today: '2026-12-31' }).due_date).toBe('2027-01-01');
    expect(parse('X cuối tháng', { today: '2028-02-10' }).due_date).toBe('2028-02-29');
    expect(parse('X cuối tháng sau', { today: '2026-01-31' }).due_date).toBe('2026-02-28');
  });

  it('only the first date expression is used', () => {
    const r = parse('Gửi hồ sơ mai hoặc thứ 2');
    expect(r.due_date).toBe('2026-10-12');
    expect(r.title).toBe('Gửi hồ sơ mai hoặc');
  });

  it('"hôm qua" is ignored for tasks', () => {
    const r = parse('Viết lại phần hôm qua');
    expect(r.due_date).toBeNull();
    expect(r.title).toBe('Viết lại phần hôm qua');
  });
});

describe('parseTaskInput — false positives are avoided', () => {
  it.each([
    'Đọc 2 chương sách',
    'Gọi chị Mai',
    'Nhắn tin cho Mai',
    'Gặp Mai ở quán',
    'Yêu mãi',
    'Mua một cái áo',
    'Mua 200g thịt',
    'Fix bug #123',
    'Gửi mail cho sếp',
    'Cười cả tuần',
    'Học 3 bài',
    'Email a@b.com',
  ])('"%s" stays a plain title', (text) => {
    const r = parse(text);
    expect(r).toMatchObject({ title: text, due_date: null, estimated_minutes: null, priority: null, recurrence: null, category_id: null });
  });

  it('time of day is not a duration ("lúc 9h", "9h sáng")', () => {
    expect(parse('Họp lúc 9h').estimated_minutes).toBeNull();
    expect(parse('Họp 9h sáng').estimated_minutes).toBeNull();
    expect(parse('Họp lúc 9h30 mai')).toMatchObject({ estimated_minutes: null, due_date: '2026-10-10', title: 'Họp lúc 9h30' });
  });
});

describe('parseTaskInput — priority', () => {
  it.each([
    ['Sửa lỗi !gấp', 'urgent'],
    ['Sửa lỗi !gap', 'urgent'],
    ['Sửa lỗi !khẩn', 'urgent'],
    ['Sửa lỗi !!!', 'urgent'],
    ['Sửa lỗi !!', 'high'],
    ['Sửa lỗi !cao', 'high'],
    ['Sửa lỗi !CAO', 'high'],
    ['Sửa lỗi !tb', 'medium'],
    ['Sửa lỗi !thấp', 'low'],
    ['Sửa lỗi !thap', 'low'],
    ['!gấp Sửa lỗi', 'urgent'],
    ['Sửa lỗi !thấp !!', 'high'], // highest wins
  ])('%s → %s', (text, p) => {
    const r = parse(text);
    expect(r.priority).toBe(p);
    expect(r.title).toBe('Sửa lỗi');
  });

  it('a single "!" or "!" glued to a word is not a priority', () => {
    expect(parse('Xong rồi!')).toMatchObject({ priority: null, title: 'Xong rồi!' });
    expect(parse('Chú ý ! nhé').priority).toBeNull();
  });
});

describe('parseTaskInput — duration', () => {
  it.each([
    ['Viết code 30p', 30],
    ['Viết code 30ph', 30],
    ['Viết code 30 phút', 30],
    ['Viết code 45m', 45],
    ['Viết code 90m', 90],
    ['Viết code 1h', 60],
    ['Viết code 1g', 60],
    ['Viết code 2 giờ', 120],
    ['Viết code 1 tiếng', 60],
    ['Viết code 1g30', 90],
    ['Viết code 1h30m', 90],
    ['Viết code 1h 15p', 75],
    ['Viết code 1.5h', 90],
    ['Viết code 1,5h', 90],
    ['Viết code 2 gio', 120],
  ])('%s → %i', (text, min) => {
    const r = parse(text);
    expect(r.estimated_minutes).toBe(min);
    expect(r.title).toBe('Viết code');
  });

  it('rejects absurd values', () => {
    expect(parse('Ngủ 30h').estimated_minutes).toBeNull();
    expect(parse('Ngủ 1g75').estimated_minutes).toBeNull();
  });
});

describe('parseTaskInput — tags, category, recurrence', () => {
  it('tags: unicode, lowercased, deduped, max 20', () => {
    const r = parse('Ôn thi #HọcTập #học-tập #họctập #ielts #ielts');
    expect(r.tags).toEqual(['họctập', 'học-tập', 'ielts']);
    expect(r.title).toBe('Ôn thi');
    const many = Array.from({ length: 25 }, (_, i) => `#t${i}`).join(' ');
    expect(parse(`X ${many}`).tags).toHaveLength(20);
  });

  it.each([
    ['Báo cáo @công', 'work'],
    ['Báo cáo @cong', 'work'],
    ['Báo cáo @CôngViệc', 'work'],
    ['Báo cáo @cong viec', 'work'],
    ['Báo cáo @công việc', 'work'],
    ['Báo cáo @canhan', 'me'],
    ['Báo cáo @hoc', 'study'], // task-kind preferred over the expense "Học tập"
    ['Báo cáo @suc khoe', 'health'],
  ])('%s → %s', (text, id) => {
    const r = parse(text);
    expect(r.category_id).toBe(id);
    expect(r.title).toBe('Báo cáo');
  });

  it('unknown @category stays in the title; no categories → no match', () => {
    expect(parse('Báo cáo @xyz')).toMatchObject({ category_id: null, title: 'Báo cáo @xyz' });
    expect(parse('Báo cáo @cong', { categories: undefined })).toMatchObject({ category_id: null, title: 'Báo cáo @cong' });
  });

  it.each([
    ['Tập gym mỗi ngày', 'daily'],
    ['Tập gym hằng ngày', 'daily'],
    ['Tập gym hàng ngày', 'daily'],
    ['Tập gym ngày thường', 'weekdays'],
    ['Tập gym các ngày trong tuần', 'weekdays'],
    ['Tập gym mỗi tuần', 'weekly'],
    ['Tập gym hàng tuần', 'weekly'],
    ['Tập gym hằng tháng', 'monthly'],
    ['Tập gym mỗi tháng', 'monthly'],
  ])('%s → %s', (text, rec) => {
    const r = parse(text);
    expect(r.recurrence).toBe(rec);
    expect(r.title).toBe('Tập gym');
    expect(r.due_date).toBeNull();
  });

  it('"mỗi thứ 3" → weekly starting next Tuesday', () => {
    expect(parse('Họp team mỗi thứ 3')).toMatchObject({ recurrence: 'weekly', due_date: '2026-10-13', title: 'Họp team' });
  });
});

describe('parseTaskInput — combined & edge cases', () => {
  it('everything at once', () => {
    expect(parse('Nộp báo cáo quý thứ 6 !gấp #work #Q4 1h30 @công việc')).toEqual({
      title: 'Nộp báo cáo quý', due_date: '2026-10-16', priority: 'urgent', tags: ['work', 'q4'],
      estimated_minutes: 90, category_id: 'work', recurrence: null,
    });
  });

  it('no-diacritic, uppercase combination', () => {
    expect(parse('GOI KHACH HANG NGAY MAI !CAO 15P')).toMatchObject({
      title: 'GOI KHACH HANG', due_date: '2026-10-10', priority: 'high', estimated_minutes: 15,
    });
  });

  it('"khách hàng ngày mai" is a date, not a "hàng ngày" recurrence', () => {
    expect(parse('Gọi khách hàng ngày mai')).toMatchObject({ title: 'Gọi khách hàng', due_date: '2026-10-10', recurrence: null });
    expect(parse('Kiểm tra đơn hàng ngày 20')).toMatchObject({ title: 'Kiểm tra đơn hàng', due_date: '2026-10-20', recurrence: null });
  });

  it('decomposed (NFD) input is handled like NFC', () => {
    const r = parse('Nộp bài ngày mai'.normalize('NFD'));
    expect(r.due_date).toBe('2026-10-10');
    expect(r.title).toBe('Nộp bài');
  });

  it('only metadata → empty title (the UI then asks for a title); metadata is still parsed', () => {
    expect(parse('ngày mai')).toMatchObject({ title: '', due_date: '2026-10-10' });
    expect(parse('  #a   !!  ')).toMatchObject({ title: '', tags: ['a'], priority: 'high' });
    expect(parse('#chỉ-thẻ !cao')).toMatchObject({ title: '', tags: ['chỉ-thẻ'], priority: 'high' });
    expect(parse('Gọi khách #sales')).toMatchObject({ title: 'Gọi khách', tags: ['sales'] });
  });

  it('tidies whitespace and stray separators', () => {
    expect(parse('  Gửi   hợp đồng  -  mai ,  ').title).toBe('Gửi hợp đồng');
    expect(parse('Mua sữa (mai)').title).toBe('Mua sữa');
  });

  it('empty / null input', () => {
    expect(parse('')).toMatchObject({ title: '', due_date: null, tags: [] });
    expect(parse(null).title).toBe('');
  });

  it('accepts a Date for today and rejects garbage', () => {
    expect(parse('X mai', { today: new Date('2026-10-09T05:00:00Z') }).due_date).toBe('2026-10-10');
    expect(() => parse('X', { today: '09/10/2026' })).toThrow();
  });
});

describe('parseTaskInput — clock time vs duration (H1)', () => {
  it.each([
    ['Họp 15h', '15:00', null, 'Họp 15h'],
    ['Đi ngủ 23h', '23:00', null, 'Đi ngủ 23h'],
    ['Gặp khách 10h30', '10:30', null, 'Gặp khách 10h30'],
    ['Họp 10h mai !gấp #work', '10:00', '2026-10-10', 'Họp 10h'],
    ['Họp 14h ngày 20/10', '14:00', '2026-10-20', 'Họp 14h'],
    ['Họp 9 giờ thứ 4', '09:00', '2026-10-14', 'Họp 9 giờ'],
    ['Họp 9 giờ 30 thứ 4', '09:30', '2026-10-14', 'Họp 9 giờ 30'],
    ['Họp 9 giờ rưỡi', '09:30', null, 'Họp 9 giờ rưỡi'],
    ['Họp 15h hôm nay', '15:00', '2026-10-09', 'Họp 15h'],
  ])('%s → due_time %s', (text, time, due, title) => {
    const r = parse(text);
    expect(r.estimated_minutes).toBeNull();
    expect(r.due_time).toBe(time);
    expect(r.due_date).toBe(due);
    expect(r.title).toBe(title);
  });

  it('"mỗi ngày 8h" is a daily reminder at 08:00, not an 8-hour task', () => {
    expect(parse('Uống thuốc mỗi ngày 8h')).toMatchObject({ recurrence: 'daily', estimated_minutes: null, due_time: '08:00' });
  });

  it.each([
    ['làm 2h', 120],
    ['code 3h', 180],
    ['Viết code 1h30m', 90],
    ['Viết code 1g30p', 90],
    ['Ngủ 8 tiếng', 480],
    ['Họp 2 tiếng rưỡi', 150],
    ['Chạy ~5h', 300],
    ['Làm slide 1.5h', 90],
    ['Trực 24h', 1440],
    ['Chạy bộ 1h mỗi ngày', 60],
  ])('%s stays a duration (%i min)', (text, min) => {
    const r = parse(text);
    expect(r.estimated_minutes).toBe(min);
    expect(r.due_time).toBeUndefined();
  });

  it('am/pm', () => {
    expect(parse('Gọi điện 9pm').due_time).toBe('21:00');
    expect(parse('Gọi điện 9am').due_time).toBe('09:00');
    expect(parse('Gọi điện 9:15 pm').due_time).toBe('21:15');
    expect(parse('Gọi điện 12am').due_time).toBe('00:00');
  });
});

describe('parseTaskInput — part of day inside the date phrase (M1)', () => {
  it.each([
    ['Họp team 9h sáng mai', '09:00', '2026-10-10', 'Họp team 9h'],
    ['hop team 9h sang mai', '09:00', '2026-10-10', 'hop team 9h'],
    ['Viết code 3h chiều mai', '15:00', '2026-10-10', 'Viết code 3h'],
    ['Đi ngủ 11h đêm mai', '23:00', '2026-10-10', 'Đi ngủ 11h'],
    ['Đón con lúc 4g30 chiều nay', '16:30', '2026-10-09', 'Đón con lúc 4g30'],
    ['Xem phim 7h tối thứ 7', '19:00', '2026-10-10', 'Xem phim 7h'],
    ['Đi ngủ 12h đêm mai', '00:00', '2026-10-10', 'Đi ngủ 12h'],
    ['Ăn 12h trưa mai', '12:00', '2026-10-10', 'Ăn 12h'],
    ['Ăn 1h trưa', '13:00', null, 'Ăn 1h trưa'],
  ])('%s → %s', (text, time, due, title) => {
    const r = parse(text);
    expect(r).toMatchObject({ due_time: time, due_date: due, title, estimated_minutes: null });
  });
});

describe('parseTaskInput — "tiếng" durations next to dates (M2)', () => {
  it.each([
    ['Họp 2 tiếng chiều mai', 120, '2026-10-10'],
    ['Họp mai 2 tiếng', 120, '2026-10-10'],
    ['Họp thứ 7 1 tiếng', 60, '2026-10-10'],
  ])('%s → %i', (text, min, due) => {
    const r = parse(text);
    expect(r).toMatchObject({ estimated_minutes: min, due_date: due, title: 'Họp' });
    expect(r.due_time).toBeUndefined();
  });
});

describe('parseTaskInput — "ngày D tháng M [năm Y]" (M3)', () => {
  it.each([
    ['Họp ngày 15 tháng 11', '2026-11-15', 'Họp'],
    ['Sinh nhật ngày 2 tháng 1', '2027-01-02', 'Sinh nhật'],
    ['Sinh nhật ngày 2 tháng 1 năm 2028', '2028-01-02', 'Sinh nhật'],
    ['Sinh nhật ngày 2 tháng 1 2028', '2028-01-02', 'Sinh nhật'],
    ['Hop ngay 15 thang 11', '2026-11-15', 'Hop'],
  ])('%s → %s', (text, due, title) => {
    expect(parse(text)).toMatchObject({ due_date: due, title });
  });

  it('invalid "ngày 31 tháng 2" is ignored', () => {
    expect(parse('Họp ngày 31 tháng 2').due_date).toBeNull();
  });
});

describe('parseTaskInput — low-severity edge cases', () => {
  it('"1-1" is a meeting type, not 1 January; "1/1" still is a date', () => {
    expect(parse('Họp 1-1 với sếp')).toMatchObject({ due_date: null, title: 'Họp 1-1 với sếp' });
    expect(parse('Họp 1/1 với sếp').due_date).toBe('2027-01-01');
    expect(parse('Sinh nhật mẹ 5-11').due_date).toBe('2026-11-05');
    expect(parse('Họp ngày 1-1').due_date).toBe('2027-01-01');
  });

  it('fractions are not dates', () => {
    expect(parse('Đọc 3/4 cuốn sách')).toMatchObject({ due_date: null, title: 'Đọc 3/4 cuốn sách' });
    expect(parse('Ăn 1/2 cái bánh')).toMatchObject({ due_date: null });
    expect(parse('Đọc 1/2 chương')).toMatchObject({ due_date: null });
    expect(parse('Mua quà 8/3').due_date).toBe('2027-03-08');
  });

  it('zero-width characters are stripped', () => {
    expect(parse('​‌‍﻿').title).toBe('');
    expect(parse('Nộp​ bài mai')).toMatchObject({ title: 'Nộp bài', due_date: '2026-10-10' });
  });

  it('weekday absorbs a preceding part of day', () => {
    expect(parse('Đi siêu thị tối thứ 7')).toMatchObject({ title: 'Đi siêu thị', due_date: '2026-10-10' });
    expect(parse('Học lớp 7 chiều t3')).toMatchObject({ title: 'Học lớp 7', due_date: '2026-10-13' });
  });

  it('today near 9999-12-31 never throws and never returns an invalid date', () => {
    for (const s of ['Họp thứ hai tuần sau', 'X tuần sau', 'X mai', 'X cuối tháng sau', 'X 5/1', 'X ngày 3', 'X mỗi thứ 2', 'X 999 ngày nữa']) {
      const r = parse(s, { today: '9999-12-31' });
      expect(r.due_date === null || /^\d{4}-\d{2}-\d{2}$/.test(r.due_date)).toBe(true);
    }
    expect(parse('X tuần sau', { today: '9999-12-30' }).due_date).toBeNull();
  });
});
