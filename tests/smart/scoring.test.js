import { describe, it, expect } from 'vitest';
import { focusScore, REASON_ORDER } from '../../src/services/smart/scoring.js';

const today = '2026-10-09';
const base = { status: 'todo', priority: 'medium', due_date: null, estimated_minutes: null, created_at: '2026-10-08T03:00:00Z' };
const score = (patch, t = today) => focusScore({ ...base, ...patch }, t);

describe('focusScore — priority points', () => {
  it.each([
    ['urgent', 40, ['priority_urgent']],
    ['high', 28, ['priority_high']],
    ['medium', 16, []],
    ['low', 6, []],
    ['weird', 6, []], // SQL "else 6"
  ])('%s → %i', (priority, pts, reasons) => {
    expect(score({ priority })).toEqual({ score: pts, reasons });
  });
});

describe('focusScore — due date points (medium = 16 base)', () => {
  it.each([
    ['2026-09-01', 16 + 50, ['overdue']], // capped at +20
    ['2026-09-29', 16 + 50, ['overdue']], // 10 days → 30 + 20
    ['2026-09-30', 16 + 48, ['overdue']], // 9 days → 30 + 18
    ['2026-10-08', 16 + 32, ['overdue']],
    ['2026-10-09', 16 + 30, ['due_today']],
    ['2026-10-10', 16 + 22, ['due_tomorrow']],
    ['2026-10-11', 16 + 15, ['due_soon']],
    ['2026-10-12', 16 + 15, ['due_soon']],
    ['2026-10-13', 16 + 8, ['due_soon']],
    ['2026-10-16', 16 + 8, ['due_soon']],
    ['2026-10-17', 16, []],
    [null, 16, []],
  ])('due %s → %i', (due_date, pts, reasons) => {
    expect(score({ due_date })).toEqual({ score: pts, reasons });
  });
});

describe('focusScore — bonuses', () => {
  it.each([
    [{ status: 'in_progress' }, 26, ['in_progress']],
    [{ estimated_minutes: 30 }, 21, ['quick_win']],
    [{ estimated_minutes: 1 }, 21, ['quick_win']],
    [{ estimated_minutes: 31 }, 16, []],
    [{ estimated_minutes: 0 }, 16, []], // SQL: estimated_minutes > 0
    [{ estimated_minutes: null }, 16, []],
    [{ created_at: '2026-09-24T10:00:00Z' }, 21, ['stale']], // 15 days
    [{ created_at: '2026-09-25T10:00:00Z' }, 16, []], // exactly 14 days → not stale
    [{ created_at: '2026-09-24' }, 21, ['stale']],
  ])('%j → %i', (patch, pts, reasons) => {
    expect(score(patch)).toEqual({ score: pts, reasons });
  });

  it('stale uses the user-timezone day of created_at (Asia/Ho_Chi_Minh default)', () => {
    // 2026-09-24T18:00Z = 2026-09-25 01:00 in Vietnam → 14 days → not stale
    expect(score({ created_at: '2026-09-24T18:00:00Z' }).reasons).toEqual([]);
  });
});

describe('focusScore — reasons order & totals', () => {
  it('uses the canonical SQL order, not contribution', () => {
    const r = score({ priority: 'urgent', due_date: '2026-10-08', status: 'in_progress', estimated_minutes: 20, created_at: '2026-09-01T00:00:00Z' });
    expect(r.score).toBe(40 + 32 + 10 + 5 + 5);
    expect(r.reasons).toEqual(['overdue', 'priority_urgent', 'in_progress', 'quick_win', 'stale']);
  });

  it('overdue precedes urgent regardless of points', () => {
    const r = score({ priority: 'urgent', due_date: '2026-10-01' }); // 30 + 16 = 46 > 40
    expect(r.reasons).toEqual(['overdue', 'priority_urgent']);
  });

  it('mixed reasons follow the canonical order', () => {
    const r = score({ priority: 'high', due_date: today, estimated_minutes: 10, created_at: '2026-01-01' });
    expect(r.reasons).toEqual(['due_today', 'priority_high', 'quick_win', 'stale']);
    expect(score({ priority: 'urgent', due_date: '2026-10-04' }).reasons).toEqual(['overdue', 'priority_urgent']);
  });

  it('REASON_ORDER matches the contract', () => {
    expect(REASON_ORDER).toEqual(['overdue', 'due_today', 'due_tomorrow', 'due_soon', 'priority_urgent', 'priority_high', 'in_progress', 'quick_win', 'stale']);
  });

  it.each(['completed', 'cancelled'])('closed task (%s) scores 0', (status) => {
    expect(score({ status, priority: 'urgent', due_date: '2026-10-01' })).toEqual({ score: 0, reasons: [] });
  });

  it('handles month/year boundaries', () => {
    expect(score({ due_date: '2027-01-01', created_at: '2026-12-30' }, '2026-12-31').reasons).toEqual(['due_tomorrow']);
    expect(score({ due_date: '2028-02-29', created_at: '2028-02-20' }, '2028-03-01').score).toBe(16 + 32);
  });

  it('null task → 0', () => {
    expect(focusScore(null, today)).toEqual({ score: 0, reasons: [] });
  });
});
