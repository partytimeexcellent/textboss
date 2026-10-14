// Click a screenshot to see it full size; highlight the section you're reading in the contents.

const zoom = document.createElement('div');
zoom.className = 'zoom';
zoom.hidden = true;
zoom.append(document.createElement('img'));
document.body.append(zoom);
zoom.addEventListener('click', () => (zoom.hidden = true));
document.addEventListener('keydown', (e) => e.key === 'Escape' && (zoom.hidden = true));
for (const img of document.querySelectorAll('figure img')) {
  img.addEventListener('click', () => {
    zoom.firstChild.src = img.src;
    zoom.firstChild.alt = img.alt;
    zoom.hidden = false;
  });
}

const links = new Map([...document.querySelectorAll('nav.toc a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]));
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    for (const a of links.values()) a.classList.remove('on');
    links.get(e.target.id)?.classList.add('on');
  }
}, { rootMargin: '0px 0px -75% 0px' });
for (const id of links.keys()) {
  const el = document.getElementById(id);
  if (el) seen.observe(el);
}

// Opened with a #section link: land there once the page has laid out
if (location.hash) {
  const target = document.getElementById(location.hash.slice(1));
  if (target) requestAnimationFrame(() => target.scrollIntoView());
}
