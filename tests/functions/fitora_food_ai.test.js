// Pure helpers of the fitora-food-ai Edge Function (supabase/functions/fitora-food-ai/lib.ts).
import { describe, it, expect } from 'vitest';
import {
  MAX_DISHES,
  MAX_IMAGE_BYTES,
  base64DecodedBytes,
  buildAnthropicRequest,
  buildUserText,
  clampNumber,
  cleanText,
  extractJson,
  parseImageDataUrl,
  parseRequestBody,
  responseText,
  sanitizeDish,
  sanitizeResult,
  supportsDefaultFallback,
  supportsEffort,
} from '../../supabase/functions/fitora-food-ai/lib.ts';

const b64 = (bytes) => Buffer.alloc(bytes, 7).toString('base64');
const dataUrl = (mime, bytes = 1000) => `data:${mime};base64,${b64(bytes)}`;

describe('parseImageDataUrl', () => {
  it('accepts jpeg/png/webp and reports decoded size', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp']) {
      const r = parseImageDataUrl(dataUrl(mime, 1234));
      expect(r.ok).toBe(true);
      expect(r.mediaType).toBe(mime);
      expect(r.bytes).toBe(1234);
    }
  });

  it('normalises image/jpg and upper-case mime, strips whitespace', () => {
    const data = b64(300);
    const r = parseImageDataUrl(`data:IMAGE/JPG;base64,${data.slice(0, 40)}\n${data.slice(40)}`);
    expect(r.ok).toBe(true);
    expect(r.mediaType).toBe('image/jpeg');
    expect(r.data).toBe(data);
  });

  it('rejects other mimes, missing input and malformed URLs', () => {
    expect(parseImageDataUrl(dataUrl('image/gif')).ok).toBe(false);
    expect(parseImageDataUrl(dataUrl('image/svg+xml')).ok).toBe(false);
    expect(parseImageDataUrl(undefined).ok).toBe(false);
    expect(parseImageDataUrl('').ok).toBe(false);
    expect(parseImageDataUrl(`image/jpeg;base64,${b64(200)}`).ok).toBe(false);
    expect(parseImageDataUrl(`data:image/jpeg,${b64(200)}`).ok).toBe(false);
    expect(parseImageDataUrl('data:image/jpeg;base64,@@@@').ok).toBe(false);
    expect(parseImageDataUrl('data:image/jpeg;base64,abc').ok).toBe(false); // bad length
  });

  it('rejects images that are too small or larger than ~1.5 MB', () => {
    expect(parseImageDataUrl(dataUrl('image/png', 10)).ok).toBe(false);
    expect(parseImageDataUrl(dataUrl('image/png', MAX_IMAGE_BYTES)).ok).toBe(true);
    const big = parseImageDataUrl(dataUrl('image/png', MAX_IMAGE_BYTES + 1));
    expect(big.ok).toBe(false);
    expect(big.message).toMatch(/quá lớn/);
  });

  it('base64DecodedBytes accounts for padding', () => {
    expect(base64DecodedBytes(b64(1))).toBe(1);
    expect(base64DecodedBytes(b64(2))).toBe(2);
    expect(base64DecodedBytes(b64(3))).toBe(3);
  });
});

describe('parseRequestBody', () => {
  it('defaults mode to photo and trims the hint', () => {
    const r = parseRequestBody({ image: dataUrl('image/webp'), hint: '  phở   bò  ' });
    expect(r).toMatchObject({ ok: true, mode: 'photo', hint: 'phở bò', mediaType: 'image/webp' });
  });

  it('accepts live mode and null hint', () => {
    expect(parseRequestBody({ image: dataUrl('image/jpeg'), mode: 'live', hint: null })).toMatchObject({ ok: true, mode: 'live', hint: '' });
  });

  it('rejects bad bodies, modes and hints', () => {
    expect(parseRequestBody(null).ok).toBe(false);
    expect(parseRequestBody([]).ok).toBe(false);
    expect(parseRequestBody({}).ok).toBe(false);
    expect(parseRequestBody({ image: dataUrl('image/jpeg'), mode: 'video' }).ok).toBe(false);
    expect(parseRequestBody({ image: dataUrl('image/jpeg'), hint: 42 }).ok).toBe(false);
    expect(parseRequestBody({ image: dataUrl('image/jpeg'), hint: 'x'.repeat(201) }).ok).toBe(false);
    expect(parseRequestBody({ image: dataUrl('image/jpeg'), hint: 'x'.repeat(200) }).ok).toBe(true);
  });
});

describe('extractJson', () => {
  const obj = { is_food: true, notes: 'ok', dishes: [] };

  it('parses plain JSON', () => {
    expect(extractJson(JSON.stringify(obj))).toEqual(obj);
  });

  it('strips ``` fences', () => {
    expect(extractJson('```json\n' + JSON.stringify(obj) + '\n```')).toEqual(obj);
    expect(extractJson('Kết quả:\n```\n' + JSON.stringify(obj) + '\n```\nHết.')).toEqual(obj);
  });

  it('takes the first {...} out of surrounding prose, braces inside strings included', () => {
    const inner = { is_food: true, notes: 'dấu } và { trong chuỗi', dishes: [{ name: 'Phở' }] };
    expect(extractJson(`Đây là JSON: ${JSON.stringify(inner)} cảm ơn {không phải json}`)).toEqual(inner);
  });

  it('skips an invalid leading brace group', () => {
    expect(extractJson(`{oops} ${JSON.stringify(obj)}`)).toEqual(obj);
  });

  it('returns null for garbage, arrays and non-strings', () => {
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('[1,2]')).toBeNull();
    expect(extractJson('{"a": ')).toBeNull();
    expect(extractJson(undefined)).toBeNull();
  });
});

describe('sanitizing', () => {
  it('clampNumber handles strings, NaN and bounds', () => {
    expect(clampNumber('12,5', 0, 100)).toBe(12.5);
    expect(clampNumber('abc', 0, 100, 7)).toBe(7);
    expect(clampNumber(-5, 0, 100)).toBe(0);
    expect(clampNumber(1e9, 0, 100)).toBe(100);
    expect(clampNumber(Infinity, 0, 100, 3)).toBe(3);
  });

  it('cleanText collapses whitespace/control chars and truncates', () => {
    expect(cleanText('  a\n\tb\u0000c  ', 10)).toBe('a b c');
    expect(cleanText('x'.repeat(130), 120)).toHaveLength(120);
    expect(cleanText(5, 10)).toBe('');
  });

  it('sanitizeDish clamps to fit_meal_entries limits', () => {
    const d = sanitizeDish({
      name: '  Phở bò  ', ingredients: ['bánh phở', '', 3, 'thịt bò'], quantity: 1, unit: 'bát',
      grams: 1e9, kcal: 1e9, protein_g: -3, carbs_g: 1e9, fat_g: '12', fiber_g: null, confidence: 7,
    });
    expect(d).toEqual({
      name: 'Phở bò', ingredients: ['bánh phở', 'thịt bò'], quantity: 1, unit: 'bát',
      grams: 100000, kcal: 50000, protein_g: 0, carbs_g: 10000, fat_g: 12, fiber_g: 0, confidence: 1,
    });
  });

  it('sanitizeDish applies defaults', () => {
    const d = sanitizeDish({ name: 'Cơm trắng', quantity: 0, unit: '   ', protein_g: 4, carbs_g: 40, fat_g: 0 });
    expect(d.quantity).toBe(1);
    expect(d.unit).toBe('phần');
    expect(d.confidence).toBe(0.5);
    expect(d.kcal).toBe(176); // estimated from macros when kcal missing
    expect(d.ingredients).toEqual([]);
    expect(sanitizeDish({ name: 'x', quantity: -2 }).quantity).toBe(1);
    expect(sanitizeDish({ name: 'x', quantity: 'abc' }).quantity).toBe(1);
    expect(sanitizeDish({ name: 'x', unit: 'u'.repeat(30) }).unit).toHaveLength(20);
    expect(sanitizeDish({ name: 'x', confidence: -1 }).confidence).toBe(0);
  });

  it('sanitizeDish drops nameless or non-object dishes', () => {
    expect(sanitizeDish({ name: '   ' })).toBeNull();
    expect(sanitizeDish({ kcal: 100 })).toBeNull();
    expect(sanitizeDish(null)).toBeNull();
    expect(sanitizeDish('Phở')).toBeNull();
  });

  it('sanitizeResult keeps at most 10 named dishes', () => {
    const dishes = Array.from({ length: 15 }, (_, i) => ({ name: i % 5 === 0 ? '' : `Món ${i}`, kcal: 100 }));
    const r = sanitizeResult({ is_food: true, notes: ' ghi chú ', dishes });
    expect(r.dishes).toHaveLength(MAX_DISHES);
    expect(r.dishes.every((d) => d.name.startsWith('Món'))).toBe(true);
    expect(r.is_food).toBe(true);
    expect(r.notes).toBe('ghi chú');
  });

  it('sanitizeResult: not food when model says so or no dish survives', () => {
    expect(sanitizeResult({ is_food: false, notes: 'Ảnh phong cảnh', dishes: [] })).toEqual({ is_food: false, notes: 'Ảnh phong cảnh', dishes: [] });
    expect(sanitizeResult({ is_food: true, dishes: [{ name: '' }] }).is_food).toBe(false);
    expect(sanitizeResult({ is_food: false, dishes: [{ name: 'Phở' }] }).is_food).toBe(false);
    expect(sanitizeResult(null)).toEqual({ is_food: false, notes: '', dishes: [] });
  });
});

describe('request building', () => {
  const base = { mediaType: 'image/jpeg', data: b64(300), hint: '', mode: 'photo' };

  it('builds an image + text message with JSON output format', () => {
    const r = buildAnthropicRequest({ ...base, model: 'claude-sonnet-5-5' });
    expect(r.model).toBe('claude-sonnet-5-5');
    const [img, txt] = r.messages[0].content;
    expect(img).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base.data } });
    expect(txt.type).toBe('text');
    expect(r.output_config.format.type).toBe('json_schema');
    expect(r.output_config.effort).toBe('medium');
    expect(r.fallbacks).toBe('default');
  });

  it('live mode is cheaper/faster', () => {
    const photo = buildAnthropicRequest({ ...base, model: 'claude-sonnet-5-5' });
    const live = buildAnthropicRequest({ ...base, model: 'claude-sonnet-5-5', mode: 'live' });
    expect(live.max_tokens).toBeLessThan(photo.max_tokens);
    expect(live.output_config.effort).toBe('low');
  });

  it('omits effort/fallbacks on models that do not take them', () => {
    const r = buildAnthropicRequest({ ...base, model: 'claude-haiku-4-5' });
    expect(r.output_config.effort).toBeUndefined();
    expect(r.fallbacks).toBeUndefined();
    expect(supportsEffort('claude-opus-5-5')).toBe(true);
    expect(supportsEffort('claude-haiku-4-5')).toBe(false);
    expect(supportsDefaultFallback('claude-haiku-5-5')).toBe(false);
  });

  it('includes the hint in the user text', () => {
    expect(buildUserText('2 bát cơm', 'photo')).toContain('2 bát cơm');
    expect(buildUserText('', 'live')).toMatch(/nhanh/);
    expect(buildUserText('', 'photo')).not.toMatch(/Ghi chú/);
  });

  it('responseText joins text blocks only', () => {
    expect(responseText({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a"' }, { type: 'text', text: ':1}' }] })).toBe('{"a":1}');
    expect(responseText(null)).toBe('');
  });
});

describe('sanitizeDish: nutrition consistency', () => {
  const base = { name: 'Cơm tấm sườn', quantity: 1, unit: 'đĩa', grams: 400, protein_g: 30, carbs_g: 80, fat_g: 25, fiber_g: 3, confidence: 0.8 };

  it('keeps kcal that agrees with 4P+4C+9F', () => {
    expect(sanitizeDish({ ...base, kcal: 680 }).kcal).toBe(680); // atwater = 665
  });

  it('replaces kcal far below the macros (e.g. per-100 g slip) with the Atwater estimate', () => {
    expect(sanitizeDish({ ...base, kcal: 170 }).kcal).toBe(665);
  });

  it('keeps kcal above the macros (alcohol is not in the macros)', () => {
    const beer = sanitizeDish({ name: 'Bia', quantity: 1, unit: 'lon', grams: 330, kcal: 140, protein_g: 1.5, carbs_g: 11, fat_g: 0 });
    expect(beer.kcal).toBe(140);
  });

  it('weight is never lighter than its macros', () => {
    expect(sanitizeDish({ ...base, kcal: 665, grams: 50 }).grams).toBe(138);
    expect(sanitizeDish({ ...base, kcal: 665, grams: 0 }).grams).toBe(0); // unknown stays unknown
  });

  it('quarter portions survive and gram-like units are normalised', () => {
    expect(sanitizeDish({ ...base, kcal: 665, quantity: 0.25 }).quantity).toBe(0.25);
    const g = sanitizeDish({ name: 'Ức gà', quantity: 1, unit: 'gram', grams: 150, kcal: 248, protein_g: 46, fat_g: 5.4 });
    expect(g).toMatchObject({ unit: 'g', quantity: 150, grams: 150 });
    const g2 = sanitizeDish({ name: 'Ức gà', quantity: 120, unit: 'g', grams: 0, kcal: 198 });
    expect(g2).toMatchObject({ unit: 'g', quantity: 120, grams: 120 });
    const ml = sanitizeDish({ name: 'Sữa tươi', quantity: 180, unit: 'ml', grams: 0, kcal: 117 });
    expect(ml).toMatchObject({ unit: 'ml', quantity: 180, grams: 180 });
  });

  it('prompt anchors realistic Vietnamese portions and the energy formula', async () => {
    const { SYSTEM_PROMPT } = await import('../../supabase/functions/fitora-food-ai/lib.ts');
    expect(SYSTEM_PROMPT).toMatch(/4×protein \+ 4×carbs \+ 9×fat/);
    expect(SYSTEM_PROMPT).toMatch(/bát cơm trắng ~150–200 g/);
    expect(SYSTEM_PROMPT).toMatch(/"grams" luôn > 0/);
  });
});
