// @vitest-environment happy-dom
// Markdown model of the rich editor (stream A1): md → editor DOM → md must be
// canonical and idempotent, browser-produced HTML must map onto the dialect,
// literal syntax must survive through escaping, and nothing active may ever be
// emitted. Also covers the preview renderer / plain-text helpers in noteEditor.js.
import { describe, test, expect } from 'vitest';
import { mdToHtml, htmlToMd, normalizeMd, parseMd, imageLine, audioLine, safeHref, safeMediaSrc } from '../../src/components/rich/markdown.js';
import {
  renderMarkdown, inlineMd, plainText, snippet, noteStats, checklistProgress, noteTemplates, displayTitle, openChecklistItems,
} from '../../src/components/noteEditor.js';

const dom = (h) => { const d = document.createElement('div'); d.innerHTML = String(h); return d; };
const rt = (md) => htmlToMd(dom(mdToHtml(md)));
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Visible text of an editor DOM: <br> → \n, blocks → \n\n, whitespace collapsed per line. */
function visibleText(root) {
  const c = root.cloneNode(true);
  c.querySelectorAll('.rt-check').forEach((x) => x.remove());
  c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  c.querySelectorAll('p,li,h1,h2,h3,blockquote,pre,td,th,figure').forEach((b) => b.append('\n'));
  return c.textContent.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** Per non-space character: char + the set of formatting marks around it. */
function charSig(root) {
  const out = [];
  const walk = (n, m) => {
    for (const ch of n.childNodes) {
      if (ch.nodeType === 3) {
        for (const c of ch.data) if (!/\s/.test(c)) out.push(c + '|' + [...m].sort().join(','));
      } else if (ch.nodeType === 1) {
        const t = ch.tagName;
        const m2 = new Set(m);
        if (t === 'STRONG' || t === 'B') m2.add('b');
        if (t === 'EM' || t === 'I') m2.add('i');
        if (t === 'U') m2.add('u');
        if (t === 'S' || t === 'DEL') m2.add('s');
        if (t === 'MARK') m2.add('h');
        if (t === 'CODE') m2.add('c');
        if (t === 'A') m2.add('a=' + ch.getAttribute('href'));
        walk(ch, m2);
      }
    }
  };
  walk(root, new Set());
  return out;
}

/* =====================================================================
   1. md → editor DOM (exact markup from the contract table)
   ===================================================================== */

describe('mdToHtml: editor DOM per construct', () => {
  const CK = (v) => `<span class="rt-check" contenteditable="false" role="checkbox" aria-checked="${v}"></span>`;
  test.each([
    ['paragraph', 'Xin chào', '<p>Xin chào</p>'],
    ['line break', 'a\nb', '<p>a<br>b</p>'],
    ['two paragraphs', 'a\n\nb', '<p>a</p><p>b</p>'],
    ['h1', '# Một', '<h1>Một</h1>'],
    ['h2', '## Hai', '<h2>Hai</h2>'],
    ['h3', '### Ba', '<h3>Ba</h3>'],
    ['h4 reads as h3', '#### Bốn', '<h3>Bốn</h3>'],
    ['h6 reads as h3', '###### Sáu', '<h3>Sáu</h3>'],
    ['bold', '**đậm**', '<p><strong>đậm</strong></p>'],
    ['italic _', '_nghiêng_', '<p><em>nghiêng</em></p>'],
    ['italic *', '*nghiêng*', '<p><em>nghiêng</em></p>'],
    ['underline', '++gạch++', '<p><u>gạch</u></p>'],
    ['strike', '~~bỏ~~', '<p><s>bỏ</s></p>'],
    ['highlight', '==sáng==', '<p><mark>sáng</mark></p>'],
    ['inline code', '`x < y`', '<p><code>x &lt; y</code></p>'],
    ['link', '[trang](https://vd.vn/a?b=1&c=2)', '<p><a href="https://vd.vn/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">trang</a></p>'],
    ['mailto link', '[thư](mailto:a@b.vn)', '<p><a href="mailto:a@b.vn" target="_blank" rel="noopener noreferrer">thư</a></p>'],
    ['nested marks', '**_a_**', '<p><strong><em>a</em></strong></p>'],
    ['bullet list', '- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
    ['ordered list', '1. a\n2. b', '<ol><li>a</li><li>b</li></ol>'],
    ['ordered list start', '3. a\n4. b', '<ol start="3"><li>a</li><li>b</li></ol>'],
    ['nested list', '- a\n  - b', '<ul><li>a<ul><li>b</li></ul></li></ul>'],
    ['3-level list', '- a\n  1. b\n    - c', '<ul><li>a<ol><li>b<ul><li>c</li></ul></li></ol></li></ul>'],
    ['task list', '- [ ] a\n- [x] b', `<ul data-type="task"><li data-checked="false">${CK(false)}a</li><li data-checked="true">${CK(true)}b</li></ul>`],
    ['empty task (editable)', '- [ ] ', `<ul data-type="task"><li data-checked="false">${CK(false)}<br></li></ul>`],
    ['empty bullet (editable)', '- ', '<ul><li><br></li></ul>'],
    ['quote', '> a', '<blockquote><p>a</p></blockquote>'],
    ['empty quote', '> ', '<blockquote><p><br></p></blockquote>'],
    ['code block', '```js\nlet a = "<b>";\n```', '<pre><code data-lang="js">let a = &quot;&lt;b&gt;&quot;;</code></pre>'],
    ['code block no lang', '```\nx\n```', '<pre><code>x</code></pre>'],
    ['divider', '---', '<hr>'],
    ['table', '| a | b |\n|---|---|\n| 1 | 2 |', '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>'],
    ['table empty cell', '| a |\n|---|\n|  |', '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td><br></td></tr></tbody></table>'],
    ['image nm-media', '![Ảnh](nm-media:u1/n1/a.webp)', '<figure class="rt-img" contenteditable="false" data-src="nm-media:u1/n1/a.webp"><img data-src="nm-media:u1/n1/a.webp" alt="Ảnh" loading="lazy"></figure>'],
    ['image width', '![a](nm-media:u/n/a.webp "w=60")', '<figure class="rt-img" contenteditable="false" data-src="nm-media:u/n/a.webp" data-w="60"><img data-src="nm-media:u/n/a.webp" alt="a" loading="lazy"></figure>'],
    ['image https', '![a](https://cdn.vd.vn/x.png)', '<figure class="rt-img" contenteditable="false" data-src="https://cdn.vd.vn/x.png"><img src="https://cdn.vd.vn/x.png" alt="a" loading="lazy"></figure>'],
    ['audio', '[Ghi âm 12:34](nm-media:u/n/r.webm)', '<figure class="rt-audio" contenteditable="false" data-src="nm-media:u/n/r.webm"><audio controls preload="none" data-src="nm-media:u/n/r.webm"></audio><figcaption>Ghi âm 12:34</figcaption></figure>'],
  ])('%s', (_, md, html) => {
    expect(mdToHtml(md)).toBe(html);
  });

  test('editable:false omits caret placeholders', () => {
    expect(mdToHtml('- ', { editable: false })).toBe('<ul><li></li></ul>');
    expect(mdToHtml('> ', { editable: false })).toBe('<blockquote><p></p></blockquote>');
  });

  test('image line inside a paragraph splits it into blocks', () => {
    expect(mdToHtml('trước\n![a](nm-media:u/n/a.png)\nsau')).toBe(
      '<p>trước</p><figure class="rt-img" contenteditable="false" data-src="nm-media:u/n/a.png"><img data-src="nm-media:u/n/a.png" alt="a" loading="lazy"></figure><p>sau</p>');
  });

  test('audio with other ext is not audio', () => {
    expect(mdToHtml('[x](nm-media:u/n/r.exe)')).toBe('<p>[x](nm-media:u/n/r.exe)</p>');
  });

  test('empty input → empty string', () => {
    expect(mdToHtml('')).toBe('');
    expect(mdToHtml(null)).toBe('');
    expect(htmlToMd(dom(''))).toBe('');
    expect(normalizeMd(undefined)).toBe('');
  });
});

/* =====================================================================
   2. Canonical round trips
   ===================================================================== */

const STABLE = [
  'Xin chào thế giới',
  'Dòng một\nDòng hai',
  '# Tiêu đề',
  '## Mục',
  '### Nhỏ',
  '**đậm** _nghiêng_ ++gạch dưới++ ~~gạch ngang~~ ==tô sáng== `mã`',
  'chữ **đậm** ở giữa',
  'a*b*c',
  '**_cả hai_**',
  '**đậm _lồng nghiêng_ tiếp**',
  '[liên kết](https://example.com/path?q=1#x)',
  '[**đậm trong link**](https://example.com)',
  '[thư](mailto:ai@vd.vn)',
  '- a\n- b',
  '1. a\n2. b\n3. c',
  '7. bảy\n8. tám',
  '- a\n  - b\n    - c',
  '1. a\n  1. b\n    1. c',
  '- [ ] việc\n- [x] xong',
  '- [ ] cha\n  - [x] con\n    - cháu',
  '- a\n  b tiếp',
  '> trích dẫn',
  '> a\n>\n> b',
  '> - a\n> - b',
  '```\nmã\n```',
  '```js\nconst a = 1;\n  thụt lề\n```',
  '````\n```\nlồng\n```\n````',
  '---',
  '| a | b |\n|---|---|\n| 1 | 2 |',
  '| Ý tưởng | Tác động | Công sức |\n|---|---|---|\n|  | Cao | Thấp |',
  '| a \\| b | c |\n|---|---|\n| `x \\| y` | d |',
  '![ảnh](nm-media:u/n/a.webp)',
  '![ảnh](nm-media:u/n/a.webp "w=50")',
  '![x](https://cdn.example.com/a.png)',
  '[Ghi âm 00:12](nm-media:u/n/r.webm)',
  '``a`b``',
  '`` `a ``',
  'C++ và C#',
  'a_b_c snake_case',
  '#hashtag ở đầu',
  'giữa #hashtag',
  'a == b',
  '5 * 3 = 15',
  'x ~ y',
  '2\\*3\\*4',
  'văn bản\n\n- danh sách\n\n1. số\n\n- [ ] việc',
  '# A\n\nđoạn\n\n---\n\n> q\n\n```\nc\n```',
  'Tiếng Việt có dấu: ắ ằ ẳ ẵ ặ ơ ư đ Đ',
  '🎙 ⭐ 😀 emoji',
];

describe('canonical Markdown is stable through md → DOM → md', () => {
  test.each(STABLE.map((s) => [s]))('%j', (md) => {
    expect(normalizeMd(md)).toBe(md);
    expect(rt(md)).toBe(md);
  });
});

const CANON = [
  ['*x*', '_x_'],
  ['_**ngược lại**_', '**_ngược lại_**'],
  ['`` a`b ``', '``a`b``'],
  ['__x__', '**x**'],
  ['* a\n+ b', '- a\n- b'],
  ['1) a\n5) b', '1. a\n2. b'],
  ['#### h4', '### h4'],
  ['# Tiêu đề #', '# Tiêu đề'],
  ['a\n\n\n\nb', 'a\n\nb'],
  ['# T\nvăn bản', '# T\n\nvăn bản'],
  ['**Thứ Hai**\n- [ ] ', '**Thứ Hai**\n\n- [ ] '],
  ['- [X] a', '- [x] a'],
  ['1. [ ] a', '- [ ] a'],
  ['***', '---'],
  ['_ _ _', '---'],
  ['   thụt lề', 'thụt lề'],
  ['a    b', 'a b'],
  ['dòng có khoảng trắng cuối   \ntiếp', 'dòng có khoảng trắng cuối\ntiếp'],
  ['- a\n\n- b', '- a\n- b'],
  ['- a\n\n\n- b', '- a\n- b'],
  ['~~~py\nx\n~~~', '```py\nx\n```'],
  ['```\nx\n\n\n```', '```\nx\n```'],
  ['```\nchưa đóng', '```\nchưa đóng\n```'],
  ['| a | b |\n| :-- | --: |\n| 1 |', '| a | b |\n|---|---|\n| 1 |  |'],
  ['a | b\n--|--\nc | d', '| a | b |\n|---|---|\n| c | d |'],
  ['![a](nm-media:x/y.png "w=100")', '![a](nm-media:x/y.png)'],
  ['![a](nm-media:x/y.png "w=5")', '![a](nm-media:x/y.png "w=10")'],
  ['![a](nm-media:x/y.png "chú thích")', '![a](nm-media:x/y.png)'],
  ['văn bản\n- mục', 'văn bản\n\n- mục'],
  ['> a\nb', '> a\n\nb'],
  ['- a\n    - b', '- a\n  - b'],
  ['\n\n  \nxin chào\n\n', 'xin chào'],
  ['a\r\nb\r\n\r\nc', 'a\nb\n\nc'],
  ['**a** **b**', '**a** **b**'],
  ['** không đậm**', '** không đậm**'],
  ['[](https://x.vn)', ''],
  ['- a\n1. b', '- a\n\n1. b'],
  ['> ', '> '],
  ['## ', ''],
];

describe('documented canonicalisation', () => {
  test.each(CANON)('%j → %j', (input, expected) => {
    expect(normalizeMd(input)).toBe(expected);
    expect(rt(input)).toBe(expected);
    expect(normalizeMd(expected)).toBe(expected);
  });
});

describe('DOM path equals AST path (normalizeMd contract)', () => {
  test.each([...STABLE, ...CANON.map((c) => c[0])].map((s) => [s]))('%j', (md) => {
    expect(rt(md)).toBe(normalizeMd(md));
    expect(rt(rt(md))).toBe(rt(md));
  });
});

/* =====================================================================
   3. Templates and recorder output
   ===================================================================== */

describe('note templates', () => {
  const tpls = noteTemplates();
  test.each(tpls.map((t) => [t.id, t]))('%s: idempotent, content-preserving', (_, t) => {
    const n = normalizeMd(t.content);
    expect(normalizeMd(n)).toBe(n);
    expect(rt(t.content)).toBe(n);
    expect(rt(n)).toBe(n);
    expect(checklistProgress(n)).toEqual(checklistProgress(t.content));
    expect(noteStats(n).words).toBe(noteStats(t.content).words);
    // only blank lines / trailing spaces differ
    const squash = (s) => s.split('\n').map((l) => (/^(\s*([-*+]|\d+\.)( \[[ x]\])?|>) *$/.test(l) ? l : l.trimEnd())).filter((l) => l !== '').join('\n');
    expect(squash(n)).toBe(squash(t.content));
  });

  test('meeting template exact canonical form', () => {
    const t = tpls.find((x) => x.id === 'meeting');
    const d = t.content.match(/^\*\*Thời gian:\*\* (.*)$/m)[1];
    expect(normalizeMd(t.content)).toBe(`**Thời gian:** ${d}\n**Thành phần:**\n**Chủ trì:**\n\n## Mục tiêu\n\n- \n\n## Nội dung thảo luận\n\n1. \n\n## Quyết định\n\n- \n\n## Việc cần làm\n\n- [ ] Ai — việc gì — hạn\n\n## Ghi chú thêm`);
  });

  test('brainstorm template exact canonical form (table kept byte-identical)', () => {
    const t = tpls.find((x) => x.id === 'brainstorm');
    expect(normalizeMd(t.content)).toBe('## Câu hỏi trọng tâm\n\n> Làm thế nào để …?\n\n## Ý tưởng\n\n- \n- \n- \n\n## Chấm điểm\n\n| Ý tưởng | Tác động | Công sức |\n|---|---|---|\n|  | Cao | Thấp |\n\n## Thử ngay\n\n- [ ] ');
  });

  test('checklist template stays "- [ ] "', () => {
    expect(normalizeMd('- [ ] ')).toBe('- [ ] ');
  });
});

describe('recorder output (A6)', () => {
  const REC = '## 🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (12:34)\n[Ghi âm 12:34](nm-media:u/n/x.webm)\n\n**Bản chép lời**\n- **[00:05]** text\n- **[01:20]** ⭐ Đánh dấu: note';
  const CANONICAL = '## 🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (12:34)\n\n[Ghi âm 12:34](nm-media:u/n/x.webm)\n\n**Bản chép lời**\n\n- **[00:05]** text\n- **[01:20]** ⭐ Đánh dấu: note';

  test('heading + audio line split into blocks', () => {
    const d = dom(mdToHtml(REC));
    expect(d.querySelector('h2').textContent).toBe('🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (12:34)');
    const fig = d.querySelector('figure.rt-audio');
    expect(fig.getAttribute('data-src')).toBe('nm-media:u/n/x.webm');
    expect(fig.querySelector('figcaption').textContent).toBe('Ghi âm 12:34');
    expect(d.querySelectorAll('ul > li').length).toBe(2);
    expect(d.querySelector('li strong').textContent).toBe('[00:05]');
  });

  test('canonical form and idempotence', () => {
    expect(normalizeMd(REC)).toBe(CANONICAL);
    expect(rt(REC)).toBe(CANONICAL);
    expect(normalizeMd(CANONICAL)).toBe(CANONICAL);
  });

  test('escaped transcript text round-trips literally', () => {
    const lines = [
      ['\\*sao\\* và a\\_b\\_', '*sao* và a_b_'],
      ['\\[không phải link\\](https://x.vn)', '[không phải link](https://x.vn)'],
      ['ống \\| dẫn', 'ống | dẫn'],
      ['\\~\\~không gạch\\~\\~', '~~không gạch~~'],
      ['\\=\\=không sáng\\=\\=', '==không sáng=='],
      ['\\+\\+không gạch dưới\\+\\+', '++không gạch dưới++'],
      ['\\# không tiêu đề', '# không tiêu đề'],
      ['\\> không trích', '> không trích'],
    ];
    const md = REC + '\n' + lines.map(([l], k) => `- **[0${k}:00]** ${l}`).join('\n');
    const n = normalizeMd(md);
    expect(normalizeMd(n)).toBe(n);
    expect(rt(md)).toBe(n);
    const items = [...dom(mdToHtml(n)).querySelectorAll('li')].slice(2);
    expect(items.map((li) => li.textContent)).toEqual(lines.map(([, t], k) => `[0${k}:00] ${t}`));
    for (const li of items) expect(li.querySelectorAll('em,u,s,mark,a,code').length).toBe(0);
  });

  test('preview renderer shows audio figure and transcript', () => {
    const h = String(renderMarkdown(REC));
    expect(h).toContain('<h2>🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (12:34)</h2>');
    expect(h).toContain('<figure class="md-audio"><audio controls preload="none" data-src="nm-media:u/n/x.webm"></audio><figcaption>Ghi âm 12:34</figcaption></figure>');
    expect(h).toContain('<li><strong>[00:05]</strong> text');
    expect(h).toContain('⭐ Đánh dấu: note');
    const s = String(renderMarkdown('- \\~\\~a\\~\\~ \\=\\=b\\=\\= \\+\\+c\\+\\+ \\*d\\* \\# e'));
    expect(s).toContain('<li>~~a~~ ==b== ++c++ *d* # e</li>');
  });
});

/* =====================================================================
   4. Browser-produced HTML → dialect
   ===================================================================== */

describe('htmlToMd: browser / paste HTML', () => {
  test.each([
    ['Chrome <b>/<i>', '<div>chữ <b>đậm</b> và <i>nghiêng</i></div>', 'chữ **đậm** và _nghiêng_'],
    ['<del>/<strike>', '<p><del>a</del> <strike>b</strike></p>', '~~a~~ ~~b~~'],
    ['span styles', '<p><span style="font-weight: bold;">B</span><span style="font-style: italic;">I</span><span style="text-decoration: underline;">U</span><span style="text-decoration-line: line-through;">S</span></p>', '**B**_I_++U++~~S~~'],
    ['div lines → paragraphs', '<div>một</div><div>hai</div><div><br></div><div>ba</div>', 'một\n\nhai\n\nba'],
    ['text directly in root', 'trần<p>đoạn</p>', 'trần\n\nđoạn'],
    ['stray trailing br', '<p>a<br></p>', 'a'],
    ['br between lines', '<p>a<br>b</p>', 'a\nb'],
    ['double br → new paragraph', '<p>a<br><br>b</p>', 'a\n\nb'],
    ['nbsp', '<p>a&nbsp;&nbsp;b&nbsp;</p>', 'a b'],
    ['empty paragraphs dropped', '<p></p><p><br></p><p>x</p><p>   </p>', 'x'],
    ['mark spanning spaces moved inside', '<p>a<strong> b </strong>c</p>', 'a **b** c'],
    ['adjacent identical marks merged', '<p><strong>a</strong><strong>b</strong></p>', '**ab**'],
    ['nested duplicate marks', '<p><strong><b>a</b></strong></p>', '**a**'],
    ['empty marks dropped', '<p>a<em></em><strong> </strong>b</p>', 'a b'],
    ['zero-width spaces stripped', '<p>a\u200b<strong>\u200b</strong>b</p>', 'ab'],
    ['ordered list renumbered', '<ol><li>x</li><li>y</li><li>z</li></ol>', '1. x\n2. y\n3. z'],
    ['ol start kept', '<ol start="4"><li>x</li><li>y</li></ol>', '4. x\n5. y'],
    ['nested ul in li', '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>', '- a\n  - b\n    - c'],
    ['invalid ul>ul nesting (Word/Docs)', '<ul><li>a</li><ul><li>b</li></ul></ul>', '- a\n  - b'],
    ['li with p (Docs)', '<ul><li><p>một</p></li><li><p>hai</p></li></ul>', '- một\n- hai'],
    ['task list editor DOM', '<ul data-type="task"><li data-checked="true"><span class="rt-check" contenteditable="false"></span>xong</li><li data-checked="false"><span class="rt-check" contenteditable="false"></span>chưa</li></ul>', '- [x] xong\n- [ ] chưa'],
    ['GitHub task list', '<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" disabled checked> a</li><li class="task-list-item"><input type="checkbox" disabled> b</li></ul>', '- [x] a\n- [ ] b'],
    ['quote without p', '<blockquote>trích</blockquote>', '> trích'],
    ['quote with two paragraphs', '<blockquote><p>a</p><p>b</p></blockquote>', '> a\n>\n> b'],
    ['pre with br and lang class', '<pre class="language-js"><code>a<br>b</code></pre>', '```js\na\nb\n```'],
    ['pre with div lines', '<pre><code data-lang="py">x = 1<div>y = 2</div></code></pre>', '```py\nx = 1\ny = 2\n```'],
    ['headings h4 → h3', '<h4>bốn</h4><h1>một</h1>', '### bốn\n\n# một'],
    ['heading with br', '<h2>a<br>b</h2>', '## a b'],
    ['table without thead', '<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td><p>2</p></td></tr></table>', '| a | b |\n|---|---|\n| 1 | 2 |'],
    ['table with pipe and br', '<table><thead><tr><th>a|b</th></tr></thead><tbody><tr><td>x<br>y</td></tr><tr><td><br></td></tr></tbody></table>', '| a\\|b |\n|---|\n| x y |\n|  |'],
    ['ragged table padded', '<table><tr><th>a</th></tr><tr><td>1</td><td>2</td></tr></table>', '| a |  |\n|---|---|\n| 1 | 2 |'],
    ['hr', '<p>a</p><hr><p>b</p>', 'a\n\n---\n\nb'],
    ['unsafe link keeps text', '<p><a href="javascript:alert(1)">bấm</a></p>', 'bấm'],
    ['relative link keeps text', '<p><a href="/x">rel</a></p>', 'rel'],
    ['link with parens encoded', '<p><a href="https://vi.wikipedia.org/wiki/A_(B)">wiki</a></p>', '[wiki](https://vi.wikipedia.org/wiki/A_%28B%29)'],
    ['link spanning bold', '<p><a href="https://x.vn">a <b>b</b></a></p>', '[a **b**](https://x.vn)'],
    ['code inside bold', '<p><b>x <code>y</code></b></p>', '**x `y`**'],
    ['kbd → code', '<p><kbd>Ctrl</kbd>+<kbd>B</kbd></p>', '`Ctrl`+`B`'],
    ['script/style ignored', '<p>a<script>alert(1)</script><style>p{}</style>b</p>', 'ab'],
    ['comments ignored', '<p>a<!-- x -->b</p>', 'ab'],
    ['contenteditable=false UI ignored', '<p>a<span contenteditable="false">UI</span><span data-rt-ui>x</span>b</p>', 'ab'],
    ['image figure (A5) with style/classes', '<figure class="rt-img is-selected" aria-selected="true" style="--rt-w:50%" contenteditable="false" data-src="nm-media:u/n/a.webp" data-w="50"><img src="blob:http://x/1" alt="  ảnh   đẹp "></figure>', '![ảnh đẹp](nm-media:u/n/a.webp "w=50")'],
    ['figure data-w 100 → no title', '<figure class="rt-img" data-src="nm-media:u/n/a.webp" data-w="100"><img alt="a"></figure>', '![a](nm-media:u/n/a.webp)'],
    ['uploading placeholder skipped', '<p>a</p><figure class="rt-img rt-img--uploading" data-uploading="1"><img src="blob:x"></figure><p>b</p>', 'a\n\nb'],
    ['failed upload without src skipped', '<figure class="rt-img" data-error="1"><img src="blob:x" alt="x"></figure>', ''],
    ['hydrated img uses data-src not signed src', '<figure class="rt-img" data-src="nm-media:u/n/a.png"><img src="https://signed.example/a.png?token=1" alt="a"></figure>', '![a](nm-media:u/n/a.png)'],
    ['pasted https img inside text splits paragraph', '<p>a<img src="https://x.vn/i.png" alt="i">b</p>', 'a\n\n![i](https://x.vn/i.png)\n\nb'],
    ['data: / http: images dropped', '<p><img src="data:image/png;base64,AAA"><img src="http://x.vn/a.png">x</p>', 'x'],
    ['audio figure', '<figure class="rt-audio" contenteditable="false" data-src="nm-media:u/n/r.webm"><audio controls src="https://signed/x"></audio><figcaption>Ghi âm 01:02</figcaption></figure>', '[Ghi âm 01:02](nm-media:u/n/r.webm)'],
    ['audio with non-media src dropped', '<figure class="rt-audio" data-src="https://x.vn/a.webm"><audio></audio></figure>', ''],
    ['generic figure with caption', '<figure><figcaption>chú thích</figcaption></figure>', 'chú thích'],
    ['inline wrapper containing blocks', '<span><p>a</p><p>b</p></span>', 'a\n\nb'],
  ])('%s', (_, html, md) => {
    expect(htmlToMd(dom(html))).toBe(md);
    expect(normalizeMd(md)).toBe(md);
  });

  test.each([
    ['space before inline content is kept', '<p>xin <b>chào</b></p>', 'xin **chào**'],
    ['typed trailing nbsp then text node', '<p>xin&nbsp;</p>', 'xin'],
    ['space between text nodes kept', '<p>xin </p>', 'xin'],
    ['space split across nodes', '<p>xin<span> </span>chào</p>', 'xin chào'],
    ['space before link', '<p>xem <a href="https://x.vn">đây</a> nhé</p>', 'xem [đây](https://x.vn) nhé'],
  ])('mid-edit whitespace: %s', (_, html, md) => {
    expect(htmlToMd(dom(html))).toBe(md);
  });

  test('accepts an HTML string', () => {
    expect(htmlToMd('<p><b>x</b></p>')).toBe('**x**');
  });

  test('Google Docs clipboard markup', () => {
    const html = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-abc"><p dir="ltr" style="line-height:1.38;margin-top:0pt;"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:700;font-style:normal;text-decoration:none;white-space:pre-wrap;">Tiêu đề đậm</span><span style="font-weight:400;font-style:italic;"> và nghiêng</span></p><br><ul style="margin-top:0;"><li dir="ltr" aria-level="1" style="list-style-type:disc;"><p dir="ltr" role="presentation"><span style="font-weight:400;">mục một</span></p></li><li dir="ltr" aria-level="2" style="list-style-type:circle;"><p dir="ltr" role="presentation"><span style="font-weight:400;background-color:#ffff00;">con tô vàng</span></p></li></ul><p dir="ltr"><span style="font-weight:400;text-decoration:underline;">gạch chân</span></p></b>';
    expect(htmlToMd(dom(html))).toBe('**Tiêu đề đậm** _và nghiêng_\n\n- mục một\n  - ==con tô vàng==\n\n++gạch chân++');
  });

  test('Microsoft Word clipboard markup (mso-list paragraphs)', () => {
    const html = `<html><head><style>p.MsoNormal{margin:0}</style></head><body>
<p class=MsoNormal><b><span lang=VI style='font-size:12.0pt'>Báo cáo<o:p></o:p></span></b></p>
<p class=MsoListParagraphCxSpFirst style='text-indent:-.25in;mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp; </span></span><![endif]><span lang=VI>Mục A<o:p></o:p></span></p>
<p class=MsoListParagraphCxSpLast style='margin-left:1.0in;mso-list:l0 level2 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>o<span>&nbsp; </span></span><![endif]><span lang=VI>Mục con <span style='background:yellow;mso-highlight:yellow'>vàng</span><o:p></o:p></span></p>
<p class=MsoListParagraph style='mso-list:l1 level1 lfo2'><![if !supportLists]><span style='mso-list:Ignore'>1.<span>&nbsp; </span></span><![endif]>Bước một</p>
<p class=MsoNormal><i>kết</i><o:p>&nbsp;</o:p></p></body></html>`;
    expect(htmlToMd(dom(html))).toBe('**Báo cáo**\n\n- Mục A\n  - Mục con ==vàng==\n\n1. Bước một\n\n_kết_');
  });

  test('Chrome contenteditable soup', () => {
    const html = '<p>Xin&nbsp;<b>chào&nbsp;</b><i><b>bạn</b></i></p><div><span style="font-size: 1rem;">dòng</span><br></div><ul><li>a</li><li><br></li></ul><h2><br></h2><blockquote><div>q</div></blockquote>';
    expect(htmlToMd(dom(html))).toBe('Xin **chào _bạn_**\n\ndòng\n\n- a\n- \n\n> q');
  });

  test('cells / blocks with only <br> are empty', () => {
    expect(htmlToMd(dom('<table><tr><th><br></th><th>b</th></tr></table>'))).toBe('|  | b |\n|---|---|');
  });

  test('hydrateMedia-like mutation does not change Markdown', () => {
    const d = dom(mdToHtml('![a](nm-media:u/n/a.png)\n\n[r](nm-media:u/n/r.ogg)'));
    d.querySelector('img').setAttribute('src', 'https://signed.example/1');
    d.querySelector('audio').setAttribute('src', 'https://signed.example/2');
    expect(htmlToMd(d)).toBe('![a](nm-media:u/n/a.png)\n\n[r](nm-media:u/n/r.ogg)');
  });

  test('checkbox toggle via data-checked serializes', () => {
    const d = dom(mdToHtml('- [ ] a'));
    d.querySelector('li').setAttribute('data-checked', 'true');
    expect(htmlToMd(d)).toBe('- [x] a');
  });
});

/* =====================================================================
   5. Escaping: literal text typed in the editor survives
   ===================================================================== */

const LITERALS = [
  ['2*3*4', '2\\*3\\*4'],
  ['a_b_c', 'a_b_c'],
  ['C++ và C#', 'C++ và C#'],
  ['a == b', 'a == b'],
  ['x==y==z', 'x\\=\\=y\\=\\=z'],
  ['#hashtag giữa #dòng', '#hashtag giữa #dòng'],
  ['# không phải tiêu đề', '\\# không phải tiêu đề'],
  ['- không phải danh sách', '\\- không phải danh sách'],
  ['+ cộng', '\\+ cộng'],
  ['* sao', '\\* sao'],
  ['1. không phải số', '1\\. không phải số'],
  ['2024) năm', '2024\\) năm'],
  ['> không trích', '\\> không trích'],
  ['---', '\\---'],
  ['```js', '\\`\\`\\`js'],
  ['~~~', '\\~\\~\\~'],
  ['**không đậm**', '\\*\\*không đậm\\*\\*'],
  ['_không nghiêng_', '\\_không nghiêng\\_'],
  ['~~không gạch~~', '\\~\\~không gạch\\~\\~'],
  ['++không++', '\\+\\+không\\+\\+'],
  ['`không mã`', '\\`không mã\\`'],
  ['[x](https://a.vn)', '\\[x\\](https://a.vn)'],
  ['[ghi chú]', '[ghi chú]'],
  ['![a](nm-media:u/n/a.png)', '\\![a](nm-media:u/n/a.png)'],
  ['[r](nm-media:u/n/r.webm)', '\\[r](nm-media:u/n/r.webm)'],
  ['C:\\Users\\Tuyền', 'C:\\Users\\Tuyền'],
  ['a\\*b', 'a\\\\\\*b'],
  ['kết thúc bằng \\', 'kết thúc bằng \\'],
  ['a | b', 'a | b'],
  ['<b>không phải html</b> &amp;', '<b>không phải html</b> &amp;'],
  ['snake_case_name và __init__', 'snake_case_name và \\_\\_init\\_\\_'],
  ['giá 5*', 'giá 5*'],
  ['email a_b@c.vn', 'email a_b@c.vn'],
  ['https://vd.vn/a_b_c', 'https://vd.vn/a_b_c'],
];

describe('escaping of literal syntax characters', () => {
  test.each(LITERALS)('%j', (text, md) => {
    const out = htmlToMd(dom(`<p>${escHtml(text)}</p>`));
    expect(out).toBe(md);
    const back = dom(mdToHtml(out));
    expect(back.children.length).toBe(1);
    expect(back.firstElementChild.tagName).toBe('P');
    expect(back.firstElementChild.innerHTML).toBe(escHtml(text));
    expect(normalizeMd(out)).toBe(out);
  });

  test.each([
    ['list item text', '<ul><li># a</li><li>[ ] b</li><li>- c</li></ul>', '- \\# a\n- \\[ ] b\n- \\- c'],
    ['heading trailing hashes', '<h2>Issue #</h2>', '## Issue \\#'],
    ['heading of hashes', '<h1>##</h1>', '# \\##'],
    ['line after br starting with list marker', '<p>a<br>- b<br>1. c</p>', 'a\n\\- b\n1\\. c'],
    ['table separator-like line', '<p>a | b<br>---|---</p>', 'a | b\n\\---|---'],
    ['code containing backticks', '<p><code>a ` b</code></p>', '``a ` b``'],
    ['code starting with backtick', '<p><code>`x</code></p>', '`` `x ``'],
    ['bold right after word', '<p>chữ<b>đậm</b>tiếp</p>', 'chữ**đậm**tiếp'],
    ['italic inside word uses *', '<p>chữ<i>nghiêng</i>tiếp</p>', 'chữ*nghiêng*tiếp'],
    ['italic then bold', '<p>x<i>a</i><b>b</b></p>', 'x*a***b**'],
    ['bold punctuation edge', '<p><b>Lưu ý:</b>tiếp</p>', '**Lưu ý:**tiếp'],
    ['literal * next to bold', '<p><b>a</b>*</p>', '**a***'],
    ['link text with brackets', '<p><a href="https://x.vn">[1]</a></p>', '[[1]](https://x.vn)'],
    ['link text with lone bracket', '<p><a href="https://x.vn">a]b</a></p>', '[a\\]b](https://x.vn)'],
  ])('%s', (_, html, md) => {
    const d = dom(html);
    const out = htmlToMd(d);
    expect(out).toBe(md);
    expect(charSig(dom(mdToHtml(out)))).toEqual(charSig(d));
    expect(rt(out)).toBe(out);
  });
});

/* =====================================================================
   6. Safety: nothing active is ever emitted
   ===================================================================== */

const ALLOWED_TAGS = new Set(['P', 'BR', 'H1', 'H2', 'H3', 'STRONG', 'EM', 'U', 'S', 'MARK', 'CODE', 'A', 'UL', 'OL', 'LI', 'SPAN',
  'BLOCKQUOTE', 'PRE', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'FIGURE', 'IMG', 'AUDIO', 'FIGCAPTION']);
const ALLOWED_ATTRS = new Set(['href', 'target', 'rel', 'data-type', 'data-checked', 'class', 'contenteditable', 'role', 'aria-checked',
  'data-lang', 'start', 'referrerpolicy', 'data-src', 'data-w', 'alt', 'src', 'loading', 'controls', 'preload']);

function assertInert(h) {
  const d = dom(h);
  for (const el of d.querySelectorAll('*')) {
    expect(ALLOWED_TAGS.has(el.tagName), el.tagName).toBe(true);
    for (const a of el.attributes) {
      expect(ALLOWED_ATTRS.has(a.name), a.name).toBe(true);
      if (a.name === 'href') expect(a.value).toMatch(/^(https?:\/\/|mailto:)/i);
      if (a.name === 'src') expect(a.value).toMatch(/^https:\/\//i);
      if (a.name === 'data-src') expect(a.value).toMatch(/^(nm-media:[\w./-]+|https:\/\/\S+)$/);
    }
  }
  return d;
}

describe('XSS: md → DOM is inert', () => {
  test.each([
    ['javascript link', '[bấm](javascript:alert(1))'],
    ['JaVaScRiPt with tab', '[x](java\tscript:alert(1))'],
    ['data link', '[x](data:text/html,<script>alert(1)</script>)'],
    ['vbscript', '[x](vbscript:msgbox)'],
    ['raw script tag', '<script>alert(1)</script>'],
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['quote breaking alt', '![a" onerror="alert(1)](https://x.vn/a.png)'],
    ['script in alt', '![\"><script>alert(1)</script>](nm-media:u/n/a.png)'],
    ['script in audio label', '[\"><script>alert(1)</script>](nm-media:u/n/a.webm)'],
    ['javascript image', '![x](javascript:alert(1))'],
    ['http image (not https)', '![x](http://x.vn/a.png)'],
    ['media path traversal', '![x](nm-media:../../etc/passwd)'],
    ['media path with quote', '![x](nm-media:a"onload=1.png)'],
    ['lang injection', '```js" onclick="x\nx\n```'],
    ['href with quote', '[x](https://x.vn/"onmouseover="alert(1))'],
    ['html in table', '| <b onclick=1>a</b> |\n|---|\n| <iframe> |'],
    ['html entity smuggling', '[x](&#106;avascript:alert(1))'],
    ['code with html', '`<img src=x onerror=alert(1)>`'],
    ['heading with html', '# <svg onload=alert(1)>'],
  ])('%s', (_, md) => {
    const d = assertInert(mdToHtml(md));
    expect(d.querySelector('script,iframe,svg')).toBeNull();
    assertInert(String(renderMarkdown(md)).replace(/<div class="md-table">|<\/div>/g, '').replace(/<label>|<\/label>|<input[^>]*>/g, ''));
  });

  test('alt / label text is escaped, not interpreted', () => {
    const d = dom(mdToHtml('![\"><b>x</b>](nm-media:u/n/a.png)'));
    expect(d.querySelector('img').getAttribute('alt')).toBe('"><b>x</b>');
    expect(d.querySelector('b')).toBeNull();
  });

  test.each([
    ['onclick attr', '<p onclick="alert(1)">a</p>', 'a'],
    ['style attr', '<p style="background:url(javascript:x)">a</p>', 'a'],
    ['javascript href', '<a href=" javascript:alert(1)">a</a>', 'a'],
    ['img onerror', '<img src="x" onerror="alert(1)">a', 'a'],
    ['iframe', '<iframe src="https://evil"></iframe>a', 'a'],
    ['svg', 'a<svg><script>alert(1)</script></svg>', 'a'],
    ['figure with javascript src', '<figure class="rt-img" data-src="javascript:alert(1)"><img alt="x"></figure>', ''],
  ])('DOM → md drops %s', (_, html, md) => {
    const out = htmlToMd(dom(html));
    expect(out).toBe(md);
    assertInert(mdToHtml(out));
  });

  test('safeHref / safeMediaSrc', () => {
    expect(safeHref('https://a.vn')).toBe('https://a.vn');
    expect(safeHref('mailto:a@b.vn')).toBe('mailto:a@b.vn');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://')).toBeNull();
    expect(safeHref('/relative')).toBeNull();
    expect(safeMediaSrc('nm-media:u/n/a.webp')).toBe('nm-media:u/n/a.webp');
    expect(safeMediaSrc('nm-media:u/../a')).toBeNull();
    expect(safeMediaSrc('http://x/a.png')).toBeNull();
    expect(safeMediaSrc('blob:http://x/1')).toBeNull();
    expect(imageLine('![a](nm-media:u/n/a.png "w=40")')).toEqual({ src: 'nm-media:u/n/a.png', alt: 'a', w: 40 });
    expect(audioLine('[r](nm-media:u/n/a.mp3)')).toEqual({ src: 'nm-media:u/n/a.mp3', label: 'r' });
    expect(audioLine('[r](https://x.vn/a.mp3)')).toBeNull();
  });
});

/* =====================================================================
   7. Property test: random formatted DOM → md → DOM keeps every character + mark
   ===================================================================== */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['a', 'Việt', 'x1', 'C++', '2*3', '_', '*', '**', '~~', '==', '++', '`', '[', ']', '(', ')', '\\', '#', '!', '|', '<b>', '&', ' ', ' ', ' ', 'đ', '- ', '1.', '>', 'https://x.vn', ':', 'ắ'];
const TAGS = ['strong', 'em', 'u', 's', 'mark'];

function randomParagraph(r) {
  let h = '';
  const n = 1 + Math.floor(r() * 9);
  for (let k = 0; k < n; k++) {
    if (r() < 0.07) { h += '<br>'; continue; }
    let text = escHtml(WORDS[Math.floor(r() * WORDS.length)] + (r() < 0.5 ? WORDS[Math.floor(r() * WORDS.length)] : ''));
    if (r() < 0.12) text = `<code>${text}</code>`;
    for (const t of TAGS) if (r() < 0.25) text = `<${t}>${text}</${t}>`;
    if (r() < 0.12) text = `<a href="https://${r() < 0.5 ? 'a' : 'b'}.vn/">${text}</a>`;
    h += text;
  }
  return `<p>${h}</p>`;
}

describe('property: random inline formatting round-trips', () => {
  const seeds = Array.from({ length: 40 }, (_, k) => k + 1);
  test.each(seeds)('seed %i', (seed) => {
    const r = rng(seed);
    for (let k = 0; k < 25; k++) {
      const d = dom(randomParagraph(r));
      const md = htmlToMd(d);
      const back = dom(mdToHtml(md));
      expect(charSig(back), md).toEqual(charSig(d));
      expect(htmlToMd(back), md).toBe(md);
      expect(normalizeMd(md)).toBe(md);
    }
  });

  test.each(Array.from({ length: 10 }, (_, k) => k + 100))('random Markdown text is idempotent (seed %i)', (seed) => {
    const r = rng(seed);
    const pieces = ['**', '*', '_', '__', '~~', '==', '++', '`', '``', '[', ']', '(https://a.vn)', '\\', '#', '- ', '1. ', '> ', '\n', '\n\n', ' ', 'chữ', 'a', '|', '---', '![x](nm-media:a/b.png)', '[r](nm-media:a/b.webm)', '- [ ] ', '  '];
    for (let k = 0; k < 25; k++) {
      let md = '';
      const n = 3 + Math.floor(r() * 20);
      for (let j = 0; j < n; j++) md += pieces[Math.floor(r() * pieces.length)];
      const once = normalizeMd(md);
      expect(normalizeMd(once), JSON.stringify(md)).toBe(once);
      expect(rt(once), JSON.stringify(md)).toBe(once);
      assertInert(mdToHtml(md));
    }
  });
});

describe('performance', () => {
  const bigNote = () => {
    const blocks = [];
    for (let i = 0; i < 1500; i++) {
      const k = i % 6;
      blocks.push(k === 0 ? `## Mục ${i}`
        : k === 1 ? `Đoạn **đậm** _nghiêng_ số ${i} với [liên kết](https://x.vn/${i}) và \`mã\`.`
          : k === 2 ? `- [ ] việc ${i}\n- [x] xong ${i}`
            : k === 3 ? `> trích dẫn ${i}`
              : k === 4 ? `1. a ${i}\n2. b` : `| a | b |\n|---|---|\n| ${i} | x |`);
    }
    return blocks.join('\n\n');
  };

  test('htmlToMd on a 1500-block note stays fast', () => {
    const md = bigNote();
    const d = dom(mdToHtml(md));
    let best = Infinity;
    let out = '';
    for (let r = 0; r < 5; r++) {
      const t = performance.now();
      out = htmlToMd(d);
      best = Math.min(best, performance.now() - t);
    }
    expect(out).toBe(md);
    // Guards against super-linear regressions (an O(n²) walk takes seconds here), not
    // micro-timing: typical is ~10–40 ms, but CI / a busy machine can be several × slower.
    expect(best).toBeLessThan(400);
  });

  test('editing one block of a big note re-serializes correctly (block cache)', () => {
    const md = bigNote();
    const d = dom(mdToHtml(md));
    htmlToMd(d);
    d.querySelector('h2').textContent = 'Đã sửa';
    d.querySelectorAll('li')[1].setAttribute('data-checked', 'false');
    const out = htmlToMd(d);
    expect(out.startsWith('## Đã sửa\n\n')).toBe(true);
    expect(out).toContain('- [ ] việc 2\n- [ ] xong 2');
    expect(normalizeMd(out)).toBe(out);
  });
});

/* =====================================================================
   8. Preview renderer and plain-text helpers (noteEditor.js)
   ===================================================================== */

describe('preview renderer', () => {
  test.each([
    ['underline', '++gạch++', '<p><u>gạch</u></p>'],
    ['C++ literal', 'C++ và C++', '<p>C++ và C++</p>'],
    ['escaped stars', '2\\*3\\*4', '<p>2*3*4</p>'],
    ['escaped brackets', '\\[a\\](https://x.vn)', '<p>[a](<a href="https://x.vn" target="_blank" rel="noopener noreferrer">https://x.vn</a>)</p>'],
    ['escaped backtick', '\\`không mã\\`', '<p>`không mã`</p>'],
    ['escaped hash', '\\# a', '<p># a</p>'],
    ['double backtick code', '`` a`b ``', '<p><code>a`b</code></p>'],
    ['image nm-media block', '![Ảnh](nm-media:u/n/a.webp)', '<figure class="md-img"><img data-src="nm-media:u/n/a.webp" alt="Ảnh" loading="lazy"></figure>'],
    ['image width', '![a](nm-media:u/n/a.webp "w=50")', '<figure class="md-img" data-w="50"><img data-src="nm-media:u/n/a.webp" alt="a" loading="lazy" data-w="50"></figure>'],
    ['image https block', '![a](https://x.vn/a.png)', '<figure class="md-img"><img src="https://x.vn/a.png" referrerpolicy="no-referrer" alt="a" loading="lazy"></figure>'],
    ['inline image', 'xem ![a](nm-media:u/n/a.png) đây', '<p>xem <img data-src="nm-media:u/n/a.png" alt="a" loading="lazy"> đây</p>'],
    ['unsafe image stays text', '![a](javascript:x)', '<p>![a](javascript:x)</p>'],
    ['audio block', '[Ghi âm](nm-media:u/n/r.m4a)', '<figure class="md-audio"><audio controls preload="none" data-src="nm-media:u/n/r.m4a"></audio><figcaption>Ghi âm</figcaption></figure>'],
    ['audio inside paragraph lines', 'trước\n[r](nm-media:u/n/r.ogg)\nsau', '<p>trước</p><figure class="md-audio"><audio controls preload="none" data-src="nm-media:u/n/r.ogg"></audio><figcaption>r</figcaption></figure><p>sau</p>'],
    ['table escaped pipe', '| a \\| b |\n|---|\n| c |', '<div class="md-table"><table><thead><tr><th>a | b</th></tr></thead><tbody><tr><td>c</td></tr></tbody></table></div>'],
    ['strike stays <del>', '~~x~~', '<p><del>x</del></p>'],
  ])('%s', (_, md, html) => {
    expect(String(renderMarkdown(md))).toBe(html);
  });

  test('inlineMd keeps link label emphasis and escapes', () => {
    expect(inlineMd('[**a** \\*](https://x.vn)')).toBe('<a href="https://x.vn" target="_blank" rel="noopener noreferrer"><strong>a</strong> *</a>');
  });

  test('checklist checkboxes still carry data-line', () => {
    expect(String(renderMarkdown('a\n\n- [ ] b'))).toContain('data-line="2"');
  });
});

describe('plain text helpers', () => {
  test.each([
    ['image → alt', '![Sơ đồ](nm-media:u/n/a.webp)', 'Sơ đồ'],
    ['image no alt → empty', '![](nm-media:u/n/a.webp "w=50")', ''],
    ['audio → 🎙 label', '[Ghi âm 12:34](nm-media:u/n/r.webm)', '🎙 Ghi âm 12:34'],
    ['underline stripped', '++gạch++ dưới', 'gạch dưới'],
    ['C++ kept', 'C++ hay', 'C++ hay'],
    ['a == b kept', 'a == b', 'a == b'],
    ['highlight stripped', '==sáng==', 'sáng'],
    ['escapes literal', '2\\*3\\*4 \\_a\\_ \\# b', '2*3*4 _a_ # b'],
    ['escaped pipe kept', 'a \\| b', 'a | b'],
    ['bold stripped', '**đậm**', 'đậm'],
    ['checklist', '- [ ] việc', '☐ việc'],
  ])('%s', (_, md, txt) => {
    expect(plainText(md)).toBe(txt);
  });

  test('snippet never leaks nm-media urls', () => {
    const md = '# Họp\n![Ảnh bảng](nm-media:u/n/a.webp)\n\n[Ghi âm 01:00](nm-media:u/n/r.webm)\n\nxem ![x](nm-media:u/n/b.png) và [y](nm-media:u/n/c.png)';
    const s = snippet(md, 'Họp');
    expect(s).not.toContain('nm-media');
    expect(s).toBe('Ảnh bảng · 🎙 Ghi âm 01:00 · xem x và y');
  });

  test('noteStats counts words, not urls', () => {
    const st = noteStats('![hai từ](nm-media:u/n/aaaa-bbbb-cccc.webp)\n\n[Ghi âm](nm-media:u/n/r.webm)\n\n- [x] xong');
    expect(st.words).toBe(5);
    expect(st.total).toBe(1);
    expect(st.done).toBe(1);
  });

  test('displayTitle falls back to first line', () => {
    expect(displayTitle({ title: '', content: '++Tiêu đề++ ở đây' })).toBe('Tiêu đề ở đây');
  });

  test('openChecklistItems strips new syntax', () => {
    expect(openChecklistItems('- [ ] ++gọi++ \\*khách\\*')).toEqual([{ line: 0, text: 'gọi *khách*' }]);
  });

  test('parseMd exposes the block AST', () => {
    expect(parseMd('# a\n\n- b').map((b) => b.type)).toEqual(['h', 'list']);
  });
});

describe('round-trip regressions (notes backend audit)', () => {
  test('inline code containing `` at the start of a line keeps its formatting', () => {
    for (const h of ['<p><code>a``b</code></p>', '<p><code>a``b</code> tail</p>', '<ul><li><code>x``y</code></li></ul>', '<p>x<br><code>a``b</code></p>']) {
      const md = htmlToMd(dom(h));
      expect(md).not.toMatch(/\\`/);
      expect(mdToHtml(md)).toMatch(/<code>(a``b|x``y)<\/code>/);
    }
    expect(normalizeMd('```a``b``` tail')).toBe('```a``b``` tail');
    expect(mdToHtml(normalizeMd('```a``b``` tail'))).toContain('<code>a``b</code>');
    // a real fence opener is still escaped
    expect(htmlToMd(dom('<p>```js</p>'))).toBe('\\`\\`\\`js');
  });

  test("a link with '|' in its URL survives inside a table cell", () => {
    const md = htmlToMd(dom('<table><tr><td><a href="https://a.com/p|q">x</a></td></tr></table>'));
    expect(md).toContain('](https://a.com/p%7Cq)');
    const out = mdToHtml(md);
    expect(out).toContain('href="https://a.com/p%7Cq"');
    expect(normalizeMd(md)).toBe(md);
    // already-saved cells with an escaped pipe in the destination are recovered
    expect(mdToHtml('| [x](https://a.com/p\\|q) |\n|---|')).toContain('href="https://a.com/p%7Cq"');
    expect(safeHref('https://a.com/p|q')).toBe('https://a.com/p%7Cq');
  });
});
