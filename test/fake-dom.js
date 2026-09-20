// Enough of a DOM to run the parts of the app that touch one.
//
// There is no jsdom here on purpose: this project's whole dependency argument
// is that it takes what it needs and nothing else, and what these tests need is
// classList, a child list and querySelector over class names. That is about
// sixty lines, it runs in a millisecond, and it fails loudly on anything it
// does not implement rather than quietly doing something plausible.
//
// test/setup-problem.test.js grew its own smaller version of this first. When a
// third suite wants one, it comes from here.

/** One element. `className` may carry several classes, space separated. */
export function element(className = '', tag = 'div') {
  const classes = new Set(className.split(' ').filter(Boolean));
  const node = {
    tag,
    textContent: '',
    innerHTML: '',
    // Written as `el.style.left = '3px'`, read back the same way. No parsing,
    // no units, no cascade — what the app sets is what a test sees.
    style: {},
    children: [],
    parent: null,
    listeners: new Map(),
    get className() { return [...classes].join(' '); },
    set className(next) {
      classes.clear();
      for (const c of next.split(' ').filter(Boolean)) classes.add(c);
    },
  };

  node.classList = {
    add: (...c) => c.forEach((x) => classes.add(x)),
    remove: (...c) => c.forEach((x) => classes.delete(x)),
    toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    contains: (c) => classes.has(c),
  };

  node.appendChild = (child) => {
    child.parent = node;
    node.children.push(child);
    return child;
  };
  /** What Mapbox's own container gets called with. Same thing as appendChild. */
  node.append = (...kids) => kids.forEach((k) => node.appendChild(k));
  node.replaceChildren = (...kids) => {
    node.children.forEach((k) => { k.parent = null; });
    node.children = kids;
    kids.forEach((k) => { k.parent = node; });
  };
  node.remove = () => {
    if (node.parent) node.parent.children = node.parent.children.filter((k) => k !== node);
    node.parent = null;
  };

  node.addEventListener = (type, fn) => {
    if (!node.listeners.has(type)) node.listeners.set(type, []);
    node.listeners.get(type).push(fn);
  };
  /** Not a real event — just call whatever was registered. */
  node.fire = (type) => (node.listeners.get(type) ?? []).forEach((fn) => fn());

  node.descendants = function* descend() {
    for (const child of node.children) {
      yield child;
      yield* child.descendants();
    }
  };
  const matches = (el, selector) => {
    if (!selector.startsWith('.')) throw new Error(`fake-dom: only class selectors (${selector})`);
    return el.classList.contains(selector.slice(1));
  };
  node.querySelector = (selector) =>
    [...node.descendants()].find((el) => matches(el, selector)) ?? null;
  node.querySelectorAll = (selector) =>
    [...node.descendants()].filter((el) => matches(el, selector));

  node.cloneNode = () => {
    const copy = element(node.className, node.tag);
    node.children.forEach((child) => copy.appendChild(child.cloneNode()));
    return copy;
  };

  return node;
}

/**
 * Install a fake `document` for the length of `body`, then put back whatever
 * was there. Returns the body element so a test can read what was toggled on it.
 *
 * AN ASYNC BODY IS AWAITED. The obvious version of this is a try/finally, and
 * it is wrong for exactly the reason a try/finally around any async call is
 * wrong: the `finally` runs when the function RETURNS, which for an async body
 * is as soon as it hits its first await — so the document was torn down while
 * the test was still using it, and the simulator's first tick found no
 * `document` at all. Caught by the two tests that walk a simulated route.
 */
export function withDocument(body) {
  const had = globalThis.document;
  const documentBody = element('', 'body');
  globalThis.document = {
    body: documentBody,
    createElement: (tag) => element('', tag),
    getElementById: () => null,
  };
  const restore = () => {
    if (had === undefined) delete globalThis.document;
    else globalThis.document = had;
  };

  let result;
  try {
    result = body(documentBody);
  } catch (error) {
    restore();
    throw error;
  }
  if (typeof result?.then !== 'function') {
    restore();
    return result;
  }
  return result.then(
    (value) => { restore(); return value; },
    (error) => { restore(); throw error; },
  );
}
