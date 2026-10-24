// Privacy and data: two statements, Clear now and Restore defaults (C-SET-24, C-SET-10, C-SET-11).

import { CLEAR_ANSWER_MS, PROTOCOL, parseOptionsReply, type OptionsRequest } from '../../core/index.ts';
import { OPTIONS_TEXT as T } from '../../strings.ts';
import { el, hint, row } from '../dom.ts';

// "Clear now": one request, answered when the cleared history saves; silence past 5 s reads as not cleared (06 5.3).
function historyRow(): HTMLElement {
  const button = el('button', { type: 'button' }, [T.clear]);
  const status = el('p', { class: 'status', role: 'status' });
  button.addEventListener('click', () => {
    button.disabled = true;
    status.textContent = T.clearing;
    const request: OptionsRequest = { v: PROTOCOL, t: 'clear' };
    const silence = new Promise<null>((resolve) => setTimeout(resolve, CLEAR_ANSWER_MS, null));
    void Promise.race([chrome.runtime.sendMessage(request), silence])
      .then(parseOptionsReply, () => null)
      .then((reply) => {
        status.textContent = reply?.ok === true ? T.cleared : T.notCleared; // C-DATA-09
        button.disabled = false;
      });
  });
  return row(T.history, [hint(T.historyKept), status], button);
}

// The page owns the Restore defaults button, since its edit and enabled state follow the settings edit value.
export const privacyRows = (restore: HTMLButtonElement): HTMLElement[] => [
  row(T.device, [hint(T.deviceKept)]),
  row(T.private, [hint(T.privateNever)]),
  historyRow(),
  row(T.defaults, [hint(T.restoreScope)], restore),
];
