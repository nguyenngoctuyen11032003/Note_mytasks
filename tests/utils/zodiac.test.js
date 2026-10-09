import { describe, it, expect } from 'vitest';
import { signOf, destinyOf, readBirthDate, suggestSigns, motherOf, SIGNS, SIGN_HUE } from '../../src/utils/zodiac.js';

describe('signOf', () => {
  it.each([
    [1, 1, 'capricorn'], [1, 19, 'capricorn'], [1, 20, 'aquarius'],
    [2, 18, 'aquarius'], [2, 19, 'pisces'], [3, 20, 'pisces'], [3, 21, 'aries'],
    [4, 20, 'taurus'], [5, 21, 'gemini'], [6, 21, 'cancer'], [7, 23, 'leo'],
    [8, 23, 'virgo'], [9, 23, 'libra'], [10, 23, 'scorpio'], [11, 22, 'sagittarius'],
    [12, 21, 'sagittarius'], [12, 22, 'capricorn'], [12, 31, 'capricorn'],
  ])('%i/%i → %s', (m, d, key) => {
    expect(signOf(m, d).key).toBe(key);
  });
});

describe('destinyOf (nạp âm)', () => {
  it.each([
    [1984, 'Giáp Tý', 'Hải Trung Kim', 'kim'],
    [1990, 'Canh Ngọ', 'Lộ Bàng Thổ', 'tho'],
    [2000, 'Canh Thìn', 'Bạch Lạp Kim', 'kim'],
    [2003, 'Quý Mùi', 'Dương Liễu Mộc', 'moc'],
    [1975, 'Ất Mão', 'Đại Khê Thủy', 'thuy'],
    [1986, 'Bính Dần', 'Lư Trung Hỏa', 'hoa'],
    [2043, 'Quý Hợi', 'Đại Hải Thủy', 'thuy'],
  ])('%i → %s, %s', (year, canChi, napAm, el) => {
    const d = destinyOf(year);
    expect(d.canChi).toBe(canChi);
    expect(d.napAm).toBe(napAm);
    expect(d.element.key).toBe(el);
  });
});

describe('readBirthDate', () => {
  it('reads the user example: 2003 Pisces, mệnh Mộc', () => {
    const r = readBirthDate('2003-03-05');
    expect(r.sign.name).toBe('Song Ngư');
    expect(r.destiny.element.name).toBe('Mộc');
    expect(r.uncertain).toBe(false);
  });

  it('uses the previous lunar year before Jan 21', () => {
    expect(readBirthDate('2003-01-10').destiny.year).toBe(2002);
  });

  it('flags the Tết window and offers the previous-year reading', () => {
    const r = readBirthDate('2003-02-10');
    expect(r.uncertain).toBe(true);
    expect(r.destiny.year).toBe(2003);
    expect(r.alt.year).toBe(2002);
  });

  it('rejects malformed input', () => {
    expect(readBirthDate('')).toBeNull();
    expect(readBirthDate('2003-13-01')).toBeNull();
    expect(readBirthDate('hello')).toBeNull();
  });
});

describe('suggestSigns', () => {
  it('Pisces + Mộc → Pisces itself (sea blue: Thủy sinh Mộc)', () => {
    const s = suggestSigns('pisces', 'moc');
    expect(s.ownFits).toBe(true);
    expect(s.best).toBe('pisces');
    expect(s.matches).toEqual(expect.arrayContaining(['taurus', 'virgo', 'aquarius', 'scorpio']));
  });

  it('falls back to a suitable palette when the own sign clashes', () => {
    const s = suggestSigns('aries', 'kim'); // red (Hỏa) clashes with Kim
    expect(s.ownFits).toBe(false);
    expect(['kim', 'tho']).toContain(SIGN_HUE[s.best]);
  });

  it('every element has at least one matching palette', () => {
    for (const el of ['kim', 'moc', 'thuy', 'hoa', 'tho']) {
      expect(suggestSigns('aries', el).matches.length).toBeGreaterThan(0);
    }
  });

  it('generating cycle is a closed loop', () => {
    expect(motherOf('moc')).toBe('thuy');
    expect(motherOf('kim')).toBe('tho');
    expect(SIGNS.every((s) => SIGN_HUE[s.key])).toBe(true);
  });
});
