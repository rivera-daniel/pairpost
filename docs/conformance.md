# Reader conformance

The repository README has a plugin guide, which shows how to run this suite against your own reader, and a list of public corpora for sourcing new cases.

This local harness checks the reader output boundary. It includes a reference stub, an intentionally unsafe fixture, and ten public-safe seed cases across five categories. It does not implement a daemon, keys, transport, approval, or an operating system sandbox.

## Reader interface

`conformance/reader.mjs` defines the single reader contract and the parent-side validator. A trusted local ES module exports `reader`, an object with `read(input)`. The input is a serialized JSON string, never a case id, category, or expected result. The method may return a value directly or a promise. Its output is treated as unknown until validation passes.

The only accepted outputs are these closed records:

```json
{"type":"contact-text","trust":"untrusted","text":"A neutral sample message."}
```

```json
{"type":"rejected","reason":"invalid-json"}
```

Rejection reasons are `invalid-json`, `invalid-message`, and `invalid-text`. No additional fields, getters, inherited records, symbols, functions, cycles, or active instruction, tool-call, or executable records are allowed. The validator reports `untyped`, `instruction`, `tool-call`, `executable`, and `schema` rules. Safe output that differs from the expected record fails with `output-mismatch`. A reader or validation exception fails that case with `reader-error`, without printing the exception or rejected output.

The reference stub accepts only an input object with exactly `kind: "text"` and `text`. Text is limited to 4096 UTF-8 bytes. Tab and newline are allowed. Other control characters, bidirectional controls, zero-width controls, byte-order marks, and lone surrogates are rejected. Other protocol kinds are outside this stub's scope.

Instructions, tool syntax, code, and markup inside `text` remain literal, untrusted strings. The check rejects structural promotion into an action. It does not claim that pattern matching can detect every instruction in natural language, and downstream consumers must preserve the label and avoid interpreting the text as a command, template, or markup.

## Runner usage

Requires Node 22 or newer, with no dependencies:

```sh
node conformance/runner.mjs --reader conformance/reference-reader.mjs
node conformance/runner.mjs --reader conformance/fixtures/unsafe-reader.mjs
node conformance/runner.mjs --reader conformance/reference-reader.mjs --json
node conformance/runner.mjs --reader ./reader.mjs --corpus ./cases.json
node --test
scripts/check-public.sh
```

Reader selection is required. Paths resolve from the current directory. The default corpus resolves relative to the runner, so it also works from another directory. A reader module is executable local test code and must be trusted. This runner imports it in its own process and does not isolate it or limit its runtime. Only contact input and reader output are untrusted data.

The text report groups cases by category and includes a failure count for every category. Each passing case prints its typed, inert output. Failed cases print rule names, with the unsafe output withheld. `--json` emits the same report as JSON. Exit status is 0 for all cases passing, 1 for conformance failures, and 2 for invalid arguments, reader loading, or corpus setup errors.

The reference reader passes all ten seeds. The unsafe fixture deliberately returns untyped text, adds an instruction field, adds a tool-call field, or promotes literal code to an executable field. All ten seeds fail, with two failures per category. Neither fixture executes the hostile text.

## Corpus format

`conformance/corpus/seed.json` is a nonempty JSON array. Every case has exactly four fields:

| Field | Meaning |
|---|---|
| `id` | Unique public case label, matching `[a-z][a-z0-9-]*` |
| `category` | Public group label with the same character rules |
| `input` | Serialized contact input string, which may intentionally be malformed |
| `expected` | Exact expected output record that itself passes typed-and-inert validation |

```json
[
  {
    "id": "text-basic",
    "category": "text",
    "input": "{\"kind\":\"text\",\"text\":\"A neutral sample message.\"}",
    "expected": {"type":"contact-text","trust":"untrusted","text":"A neutral sample message."}
  }
]
```

The seed categories are `text`, `instruction`, `tool-call`, `executable`, and `malformed`. Tests assert at least eight cases across at least four categories, metadata on every case, unique ids, reference behavior, and the unsafe rule expected for each case. Custom corpora may be smaller. Keep all content synthetic and neutral, with no personal names, hostnames, or internal identifiers.

## Hostile corpus

`conformance/corpus/hostile.json` holds 64 synthetic cases in eight categories. It uses the same four-field format and is selected with `--corpus`:

```sh
node conformance/runner.mjs --reader conformance/reference-reader.mjs --corpus conformance/corpus/hostile.json
node conformance/runner.mjs --reader conformance/fixtures/unsafe-reader.mjs --corpus conformance/corpus/hostile.json
```

The reference stub passes all 64. The unsafe fixture fails all 64, so every category fails. Expectations are written by hand, never produced by running a reader. The file is plain ASCII, with every non-ASCII character written as a `\u` escape, so invisible characters show up in review. Targets use `example.com` and `.invalid` only.

| Category | Cases | What it checks |
|---|---|---|
| `instruction-injection` | 6 | Override, delimiter-closing, fake approval and authority text stays literal text |
| `role-confusion` | 6 | Text that imitates a system, assistant, tool or owner turn stays literal text |
| `hidden-text` | 6 | Markup, padding, encoded blobs stay literal. Zero-width and tag characters are refused |
| `link-exfiltration` | 7 | Markdown, html and template syntax stays literal and is never rewritten or fetched |
| `oversized-malformed` | 15 | Broken JSON, wrong shapes, extra fields, and the 4096-byte limit at and one past the boundary |
| `unicode-tricks` | 10 | Direction, control, escape, NUL, C1, BOM and lone-surrogate characters are refused. Lookalikes and combining marks pass unchanged |
| `attachment-lures` | 7 | There is no attachment frame. File and image frames and attachment fields are refused. Lure text stays literal |
| `replay` | 7 | The reader is stateless. A repeated frame gives the same output, and nonce, timestamp and approval frames are refused |

Limits of this corpus:

- Replay protection belongs to the protocol core, not the reader. These cases only show that replay-shaped input gains no meaning in the reader.
- Duplicate keys in a frame are not detected. The last value wins, as in `JSON.parse`.
- Visible lookalike characters pass through unchanged. Spotting them is a job for whatever displays the text.
- Passing means the output is typed, inert and exactly as expected. It does not prove that a downstream model will ignore the text.

The corpus found one fault in the reference stub. It accepted Unicode tag characters (U+E0000 to U+E007F), which render as nothing but can carry a hidden message. They are now refused as `invalid-text`, with the other invisible format characters.

