// Settings → "Phong cách": swatch grid of every skin plus a birth-date helper
// that reads the zodiac sign and five-element destiny and suggests a skin.
// The birth date stays on this device (localStorage), like the skin itself.
import { html, mount, on, raw } from '../utils/dom.js';
import { applySkin, currentSkin, SKIN_LIST } from './skin.js';
import { readBirthDate, suggestSigns, motherOf, ELEMENTS } from '../utils/zodiac.js';

const BIRTH_KEY = 'nm.birth';

function storedBirth() {
  try { return localStorage.getItem(BIRTH_KEY) || ''; } catch { return ''; }
}

const bySign = (key) => SKIN_LIST.find((s) => s.sign === key);

function advice(iso) {
  const r = readBirthDate(iso);
  if (!r) return html`<p class="muted">Nhập ngày sinh để xem cung hoàng đạo, mệnh và phong cách hợp với bạn.</p>`;
  const { sign, destiny, uncertain, alt } = r;
  const el = destiny.element;
  const mother = ELEMENTS[motherOf(el.key)];
  const sug = suggestSigns(sign.key, el.key);
  const best = bySign(sug.best);
  const others = sug.matches.filter((k) => k !== sug.best).map((k) => bySign(k).label);
  return html`
    <p><strong>${sign.name}</strong> (${sign.latin}) · năm ${destiny.canChi} · mệnh <strong>${el.name}</strong> (${destiny.napAm})</p>
    <p class="muted">Màu bản mệnh ${el.name}: ${el.colors}. Màu tương sinh (${mother.name} sinh ${el.name}): ${mother.colors}.</p>
    ${uncertain && html`<p class="muted">Nếu bạn sinh trước Tết âm lịch năm ${destiny.year}, bạn thuộc năm ${alt.canChi}, mệnh ${alt.element.name} (${alt.napAm}).</p>`}
    <div class="skin-advice__pick">
      <span>${sug.ownFits ? `Màu cung ${sign.name} hợp mệnh của bạn.` : `Màu cung ${sign.name} không hợp mệnh ${el.name}, gợi ý:`}</span>
      <button type="button" class="btn btn--sm btn--accent" data-skin-apply="${best.id}" ${currentSkin() === best.id ? raw('disabled') : ''}>
        ${currentSkin() === best.id ? `Đang dùng ${best.label}` : `Dùng ${best.label}`}
      </button>
    </div>
    ${others.length > 0 && html`<p class="muted">Cũng hợp mệnh: ${others.join(', ')}.</p>`}
  `;
}

/** Markup for the field; drop it where the old segmented control was. */
export function skinPickerField() {
  const cur = currentSkin();
  const birth = storedBirth();
  return html`
    <div class="field">
      <span class="field__label">Phong cách <span class="opt">chỉ trên thiết bị này</span></span>
      <div class="skin-grid" role="radiogroup" aria-label="Phong cách">
        ${SKIN_LIST.map((s) => html`
          <label class="skin-chip" style="--sw-bg: ${s.swatch[0]}; --sw-ac: ${s.swatch[1]}">
            <input class="sr-only" type="radio" name="skin" data-skin-pick value="${s.id}" ${cur === s.id ? raw('checked') : ''} />
            <span class="skin-chip__sw" aria-hidden="true"></span>
            <span class="skin-chip__label">${s.label}</span>
          </label>`)}
      </div>
    </div>
    <div class="field">
      <label class="field__label" for="f-birth">Gợi ý theo ngày sinh <span class="opt">chỉ lưu trên thiết bị này</span></label>
      <input class="input skin-birth" id="f-birth" type="date" data-skin-birth value="${birth}" max="9999-12-31" />
      <div class="skin-advice" data-skin-advice aria-live="polite">${advice(birth)}</div>
    </div>
  `;
}

/** Wire the field inside `root`; returns disposers. */
export function bindSkinPicker(root) {
  return [
    on(root, 'change', '[data-skin-pick]', (e, el) => applySkin(el.value, { persist: true })),
    on(root, 'click', '[data-skin-apply]', (e, el) => applySkin(el.dataset.skinApply, { persist: true })),
    on(root, 'change', '[data-skin-birth]', (e, el) => {
      try { localStorage.setItem(BIRTH_KEY, el.value); } catch {}
      const box = root.querySelector('[data-skin-advice]');
      if (box) mount(box, advice(el.value));
    }),
  ];
}
