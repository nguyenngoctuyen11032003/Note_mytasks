// Entrance choreography. main.js calls enterContent() on every navigation;
// theme.css staggers the children in while `.is-entering` is present. Pages
// re-render their own subtrees later (filters, autosave…), and new children
// would replay the entrance each time — so the class is dropped as soon as the
// choreography has had time to finish. Called directly (no MutationObserver
// on the whole document, which used to wake on every keystroke).
const SETTLE_MS = 1100;

const timers = new WeakMap();

export function enterContent(content) {
  clearTimeout(timers.get(content));
  // Still entering (quick double navigation) → restart the animation. Only then
  // is the forced reflow needed; the usual case skips it.
  if (content.classList.contains('is-entering')) {
    content.classList.remove('is-entering');
    void content.offsetWidth;
  }
  content.classList.add('is-entering');
  timers.set(content, setTimeout(() => content.classList.remove('is-entering'), SETTLE_MS));
}
