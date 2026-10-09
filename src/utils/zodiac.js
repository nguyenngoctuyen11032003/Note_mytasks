// Birth-date helpers for the colour skins: Western zodiac sign (cung hoàng
// đạo) and the Vietnamese five-element destiny (mệnh ngũ hành, nạp âm of the
// lunar year). Pure functions, no DOM — the Settings page turns the result
// into a skin suggestion.

/** [key, Vietnamese name, Latin name, start month, start day]; a sign runs until the next one starts. */
export const SIGNS = [
  ['capricorn', 'Ma Kết', 'Capricorn', 12, 22],
  ['aquarius', 'Bảo Bình', 'Aquarius', 1, 20],
  ['pisces', 'Song Ngư', 'Pisces', 2, 19],
  ['aries', 'Bạch Dương', 'Aries', 3, 21],
  ['taurus', 'Kim Ngưu', 'Taurus', 4, 20],
  ['gemini', 'Song Tử', 'Gemini', 5, 21],
  ['cancer', 'Cự Giải', 'Cancer', 6, 21],
  ['leo', 'Sư Tử', 'Leo', 7, 23],
  ['virgo', 'Xử Nữ', 'Virgo', 8, 23],
  ['libra', 'Thiên Bình', 'Libra', 9, 23],
  ['scorpio', 'Bọ Cạp', 'Scorpio', 10, 23],
  ['sagittarius', 'Nhân Mã', 'Sagittarius', 11, 22],
].map(([key, name, latin, m, d]) => ({ key, name, latin, m, d }));

/**
 * Five-element tag of each zodiac skin's main hue (theme-zodiac.css). Used to
 * match skins to a destiny; it describes the palette, not the sign itself.
 */
export const SIGN_HUE = {
  aries: 'hoa', taurus: 'moc', gemini: 'tho', cancer: 'kim', leo: 'kim', virgo: 'moc',
  libra: 'hoa', scorpio: 'thuy', sagittarius: 'hoa', capricorn: 'tho', aquarius: 'thuy', pisces: 'thuy',
};

/** The five elements, with the colours folk tradition pairs with each. */
export const ELEMENTS = {
  kim: { key: 'kim', name: 'Kim', colors: 'trắng, bạc, xám, vàng ánh kim' },
  moc: { key: 'moc', name: 'Mộc', colors: 'xanh lá' },
  thuy: { key: 'thuy', name: 'Thủy', colors: 'xanh biển, đen' },
  hoa: { key: 'hoa', name: 'Hỏa', colors: 'đỏ, cam, hồng, tím' },
  tho: { key: 'tho', name: 'Thổ', colors: 'vàng đất, nâu' },
};

/** Generating cycle (tương sinh): the key element nourishes the value. */
const GENERATES = { kim: 'thuy', thuy: 'moc', moc: 'hoa', hoa: 'tho', tho: 'kim' };
/** Element that nourishes `el` (its "mother"). */
export const motherOf = (el) => Object.keys(GENERATES).find((k) => GENERATES[k] === el);

/** Nạp âm names for the 30 pairs of the 60-year cycle, starting at Giáp Tý (1984). */
const NAP_AM = [
  ['Hải Trung Kim', 'kim'], ['Lư Trung Hỏa', 'hoa'], ['Đại Lâm Mộc', 'moc'], ['Lộ Bàng Thổ', 'tho'],
  ['Kiếm Phong Kim', 'kim'], ['Sơn Đầu Hỏa', 'hoa'], ['Giản Hạ Thủy', 'thuy'], ['Thành Đầu Thổ', 'tho'],
  ['Bạch Lạp Kim', 'kim'], ['Dương Liễu Mộc', 'moc'], ['Tuyền Trung Thủy', 'thuy'], ['Ốc Thượng Thổ', 'tho'],
  ['Tích Lịch Hỏa', 'hoa'], ['Tùng Bách Mộc', 'moc'], ['Trường Lưu Thủy', 'thuy'], ['Sa Trung Kim', 'kim'],
  ['Sơn Hạ Hỏa', 'hoa'], ['Bình Địa Mộc', 'moc'], ['Bích Thượng Thổ', 'tho'], ['Kim Bạch Kim', 'kim'],
  ['Phú Đăng Hỏa', 'hoa'], ['Thiên Hà Thủy', 'thuy'], ['Đại Trạch Thổ', 'tho'], ['Thoa Xuyến Kim', 'kim'],
  ['Tang Đố Mộc', 'moc'], ['Đại Khê Thủy', 'thuy'], ['Sa Trung Thổ', 'tho'], ['Thiên Thượng Hỏa', 'hoa'],
  ['Thạch Lựu Mộc', 'moc'], ['Đại Hải Thủy', 'thuy'],
];
const STEMS = ['Giáp', 'Ất', 'Bính', 'Đinh', 'Mậu', 'Kỷ', 'Canh', 'Tân', 'Nhâm', 'Quý'];
const BRANCHES = ['Tý', 'Sửu', 'Dần', 'Mão', 'Thìn', 'Tỵ', 'Ngọ', 'Mùi', 'Thân', 'Dậu', 'Tuất', 'Hợi'];

/** Zodiac sign for a month (1–12) and day. */
export function signOf(month, day) {
  const md = month * 100 + day;
  // SIGNS[1..] are in calendar order; Capricorn (SIGNS[0]) wraps the new year.
  let hit = SIGNS[0];
  for (const s of SIGNS.slice(1)) if (s.m * 100 + s.d <= md) hit = s;
  return md >= SIGNS[0].m * 100 + SIGNS[0].d ? SIGNS[0] : hit;
}

/**
 * Skins that suit a destiny element: palettes of the same element (bản mệnh)
 * or of the element that generates it (tương sinh — "mother feeds child").
 * `best` is the user's own sign when its palette suits them, otherwise the
 * first suitable palette.
 */
export function suggestSigns(signKey, elementKey) {
  const ok = new Set([elementKey, motherOf(elementKey)]);
  const matches = SIGNS.filter((s) => ok.has(SIGN_HUE[s.key])).map((s) => s.key);
  const ownFits = matches.includes(signKey);
  return { best: ownFits ? signKey : matches[0], ownFits, matches };
}

/** Can Chi name and nạp âm element of a lunar year (by its Gregorian number). */
export function destinyOf(lunarYear) {
  const i = (((lunarYear - 1984) % 60) + 60) % 60;
  const [napAm, el] = NAP_AM[Math.floor(i / 2)];
  return {
    year: lunarYear,
    canChi: `${STEMS[i % 10]} ${BRANCHES[i % 12]}`,
    napAm,
    element: ELEMENTS[el],
  };
}

/**
 * Full reading for an ISO date 'YYYY-MM-DD'. The lunar new year falls between
 * Jan 21 and Feb 20, so a birthday in that window may belong to the previous
 * lunar year — `alt` then carries that reading and `uncertain` is true.
 */
export function readBirthDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const md = mo * 100 + d;
  const uncertain = md >= 121 && md <= 220;
  const beforeTet = md < 121;
  const destiny = destinyOf(beforeTet ? y - 1 : y);
  return {
    sign: signOf(mo, d),
    destiny,
    uncertain,
    alt: uncertain ? destinyOf(y - 1) : null,
  };
}
