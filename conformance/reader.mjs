/**
 * @typedef {{type: 'contact-text', trust: 'untrusted', text: string} |
 *   {type: 'rejected', reason: 'invalid-json' | 'invalid-message' | 'invalid-text'}} ReaderOutput
 * @typedef {{read: (input: string) => unknown | Promise<unknown>}} Reader
 * Readers receive serialized contact data, never corpus expectations or categories.
 * The parent validates their unknown output before treating it as ReaderOutput.
 */

export const MAX_TEXT_BYTES = 4096;
const forbiddenCharacters = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ud800-\udfff\u{e0000}-\u{e007f}]/u;

export function isValidText(text) {
  return typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES
    && !forbiddenCharacters.test(text);
}

export function assertReader(reader) {
  if (!reader || typeof reader.read !== 'function') {
    throw new TypeError('Reader module must export a reader with a read(input) method.');
  }
  return reader;
}

function inspect(value, rules, seen = new Set()) {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    rules.add('executable');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) {
    rules.add('schema');
    return;
  }
  seen.add(value);
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) rules.add('schema');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      rules.add('schema');
      continue;
    }
    const normalized = key.toLowerCase().replace(/[-_]/g, '');
    if (['instruction', 'instructions', 'system', 'prompt', 'directive'].includes(normalized)) rules.add('instruction');
    if (['tool', 'toolcall', 'toolcalls', 'functioncall'].includes(normalized)) rules.add('tool-call');
    if (['executable', 'payload', 'code', 'command', 'script', 'execute'].includes(normalized)) rules.add('executable');
    if (['type', 'kind', 'role'].includes(normalized) && typeof descriptor.value === 'string') {
      const marker = descriptor.value.toLowerCase().replace(/[-_]/g, '');
      if (['instruction', 'system', 'developer'].includes(marker)) rules.add('instruction');
      if (['tool', 'toolcall', 'functioncall'].includes(marker)) rules.add('tool-call');
      if (['executable', 'code', 'command', 'script'].includes(marker)) rules.add('executable');
    }
    inspect(descriptor.value, rules, seen);
  }
}

/** Validate a closed data schema without executing getters or payloads. */
export function checkTypedAndInert(output) {
  const rules = new Set();
  inspect(output, rules);
  const plain = output !== null && typeof output === 'object'
    && Object.getPrototypeOf(output) === Object.prototype;
  const fields = plain ? Object.getOwnPropertyDescriptors(output) : {};
  const type = fields.type?.value;
  if (typeof type !== 'string') rules.add('untyped');
  const keys = Reflect.ownKeys(fields);
  if (type === 'contact-text') {
    if (keys.length !== 3 || !['type', 'trust', 'text'].every(key => Object.hasOwn(fields, key))
      || fields.trust?.value !== 'untrusted' || !isValidText(fields.text?.value)) rules.add('schema');
  } else if (type === 'rejected') {
    if (keys.length !== 2 || !Object.hasOwn(fields, 'reason')
      || !['invalid-json', 'invalid-message', 'invalid-text'].includes(fields.reason?.value)) rules.add('schema');
  } else {
    rules.add('schema');
  }
  return { pass: rules.size === 0, rules: [...rules].sort() };
}
