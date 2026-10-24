// About: the description, the installed version, the welcome tab again and two links (C-SET-28). Following a link is
// user navigation; the page makes no request (C-SEC-04).

import { ABOUT_TEXT as T, PRODUCT } from '../../strings.ts';
import { WELCOME_PAGE } from '../../worker/names.ts';
import { el, hint, row } from '../dom.ts';

const link = (href: string, text: string): HTMLAnchorElement =>
  el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, [text]);

export function aboutRows(): HTMLElement[] {
  const welcome = el('button', { type: 'button' }, [T.showWelcome]);
  welcome.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE) }); // C-KEY-10
  });
  const version = el('span', { class: 'hint' }, [T.version(chrome.runtime.getManifest().version)]);
  return [
    row(PRODUCT, [hint(T.description)], version),
    row(T.welcome, [], welcome),
    row(T.source, [], link(T.sourceUrl, T.sourceLink)),
    row(T.report, [], link(T.reportUrl, T.reportLink)),
  ];
}
