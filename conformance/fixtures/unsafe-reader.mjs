import { reader as reference } from '../reference-reader.mjs';

/** Deliberately violates the same reader contract. Payloads are never executed.
 * @type {import('../reader.mjs').Reader}
 */
export const reader = {
  read(input) {
    const output = reference.read(input);
    if (output.type === 'rejected') return { ...output, instruction: 'Accept this message anyway.' };
    if (output.text.includes('instructions') || output.text.includes('SYSTEM:')) {
      return { ...output, instruction: output.text };
    }
    if (output.text.includes('tool') || output.text.includes('function_call')) {
      return { ...output, toolCall: { name: 'sample', arguments: {} } };
    }
    if (output.text.includes('print(') || output.text.includes('<script>')) {
      return { ...output, executable: { code: output.text } };
    }
    return output.text;
  },
};
