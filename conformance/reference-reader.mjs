import { isValidText } from './reader.mjs';

/** @type {import('./reader.mjs').Reader} */
export const reader = {
  read(input) {
    let message;
    try {
      message = JSON.parse(input);
    } catch {
      return { type: 'rejected', reason: 'invalid-json' };
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || Object.keys(message).length !== 2 || message.kind !== 'text'
      || !Object.hasOwn(message, 'text')) {
      return { type: 'rejected', reason: 'invalid-message' };
    }
    if (!isValidText(message.text)) return { type: 'rejected', reason: 'invalid-text' };
    return { type: 'contact-text', trust: 'untrusted', text: message.text };
  },
};
