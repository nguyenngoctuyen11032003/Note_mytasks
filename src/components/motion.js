// Entrance choreography guard. main.js adds `.is-entering` to #content on
// every navigation; theme.css staggers the children in while it is present.
// Pages re-render their own subtrees later (filters, autosave…), and new
// children would replay the entrance each time — so the class is dropped as
// soon as the choreography has had time to finish.
const SETTLE_MS = 1100;

export function initMotion() {
  let timer = null;
  const watch = (content) => {
    new MutationObserver(() => {
      if (!content.classList.contains('is-entering')) return;
      clearTimeout(timer);
      timer = setTimeout(() => content.classList.remove('is-entering'), SETTLE_MS);
    }).observe(content, { attributes: true, attributeFilter: ['class'] });
  };
  // #content is (re)created by the shell; watch whichever instance exists.
  new MutationObserver(() => {
    const c = document.getElementById('content');
    if (c && !c.__motion) { c.__motion = true; watch(c); }
  }).observe(document.body, { childList: true, subtree: true });
}
