// Local human approval console. It reads decisions from the human's terminal, a channel the
// model cannot reach, and applies them: approve or refuse held drafts, release inbox messages.

import readline from 'node:readline';

// Drafts and contact names are untrusted text. Replace terminal control characters so they
// cannot rewrite the screen or fake a prompt.
const sanitize = (text) => String(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '·');

/**
 * Walk the human through held drafts and unreleased messages.
 *
 * @param {{ drafts: ReturnType<import('./drafts.mjs').createDraftStore>, core: import('./core-client.mjs').CoreClient, input: NodeJS.ReadableStream, output: NodeJS.WritableStream }} deps
 * @returns {Promise<{ approved: number, refused: number, released: number }>}
 */
export async function runApprovalConsole({ drafts, core, input, output }) {
  const lines = readline.createInterface({ input, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const summary = { approved: 0, refused: 0, released: 0 };

  /** Prompt until the human gives one of `choices`. Null when the input ends. */
  async function ask(prompt, choices) {
    for (;;) {
      output.write(prompt);
      const { value, done } = await lines.next();
      if (done) return null;
      const answer = value.trim().toLowerCase();
      if (choices.includes(answer)) return answer;
      output.write(`Please answer one of: ${choices.join(', ')}\n`);
    }
  }

  const petnames = new Map((await core.listContacts()).map((c) => [c.id, c.petname]));
  const nameOf = (id) => sanitize(petnames.get(id) ?? 'unknown contact');

  const held = drafts.list('held_for_approval');
  output.write(held.length === 0 ? 'No drafts are waiting for approval.\n' : `${held.length} draft(s) waiting for approval.\n`);
  for (const draft of held) {
    output.write(`\nDraft ${sanitize(draft.id)} to ${nameOf(draft.contactId)}:\n---\n${sanitize(draft.text)}\n---\n`);
    const answer = await ask('Approve, refuse or skip? [a/r/s] ', ['a', 'r', 's']);
    if (answer === null) return summary;
    if (answer === 'a' && drafts.decide(draft.id, 'approved')) summary.approved += 1;
    if (answer === 'r' && drafts.decide(draft.id, 'refused')) summary.refused += 1;
  }

  const unreleased = (await core.listInbox()).filter((m) => !m.released);
  output.write(unreleased.length === 0 ? '\nNo messages are waiting for release.\n' : `\n${unreleased.length} message(s) not released to the agent.\n`);
  for (const meta of unreleased) {
    output.write(`\nMessage ${sanitize(meta.id)} from ${nameOf(meta.contactId)}: ${sanitize(meta.kind)}, ${Number(meta.size)} bytes, received ${sanitize(meta.receivedAt)}\n`);
    const answer = await ask('Release to the agent or skip? [r/s] ', ['r', 's']);
    if (answer === null) return summary;
    if (answer === 'r' && (await core.releaseMessage(meta.id))) summary.released += 1;
  }
  return summary;
}
