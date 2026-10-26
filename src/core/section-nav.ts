// Section links under a page's sticky toolbar (.section-nav, e.g. #detailSectionNav).
//
// Each link is a <button data-target="<panel id>">, not an <a href="#...">, because the URL hash is
// the app's router — an in-page anchor would navigate away. A click scrolls the target to just
// below the pinned app header + page header; while scrolling, the link for the section in view is
// highlighted (.is-current). syncSectionNav() hides links whose section is hidden (a Temporary
// Repair panel with no record, say), so the strip never offers a jump to nothing.

function pinnedOffset(nav: HTMLElement): number {
  const header = document.querySelector('body > header');
  const bar = nav.closest('.sticky-page-header');
  return (header ? header.getBoundingClientRect().height : 0)
    + (bar ? bar.getBoundingClientRect().height : 0) + 12;
}

function targets(nav: HTMLElement): Array<[HTMLButtonElement, HTMLElement]> {
  const out: Array<[HTMLButtonElement, HTMLElement]> = [];
  nav.querySelectorAll<HTMLButtonElement>('button[data-target]').forEach(btn => {
    const el = document.getElementById(btn.dataset.target || '');
    if (el && !btn.hidden) out.push([btn, el]);
  });
  return out;
}

function markCurrent(nav: HTMLElement): void {
  if (!nav.offsetParent) return; // page not on screen
  const offset = pinnedOffset(nav);
  const list = targets(nav);
  if (!list.length) return;
  let current = list[0][0];
  const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
  if (atBottom) current = list[list.length - 1][0];
  else for (const [btn, el] of list) if (el.getBoundingClientRect().top <= offset + 8) current = btn;
  list.forEach(([btn]) => btn.classList.toggle('is-current', btn === current));
  // keep the highlighted link visible inside a horizontally scrolled strip (phones)
  const b = current.getBoundingClientRect(), n = nav.getBoundingClientRect();
  if (b.left < n.left || b.right > n.right) nav.scrollLeft += b.left - n.left - 16;
}

export function initSectionNav(navId: string): void {
  const nav = document.getElementById(navId);
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-target]');
    const el = btn && document.getElementById(btn.dataset.target || '');
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - pinnedOffset(nav);
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  });
  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; markCurrent(nav); });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
}

// Call after the page re-renders: hides links to hidden sections and refreshes the highlight.
export function syncSectionNav(navId: string): void {
  const nav = document.getElementById(navId);
  if (!nav) return;
  nav.querySelectorAll<HTMLButtonElement>('button[data-target]').forEach(btn => {
    const el = document.getElementById(btn.dataset.target || '');
    btn.hidden = !el || getComputedStyle(el).display === 'none';
  });
  document.documentElement.style.setProperty('--section-nav-offset', pinnedOffset(nav) + 'px');
  markCurrent(nav);
}
