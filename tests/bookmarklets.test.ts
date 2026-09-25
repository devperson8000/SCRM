import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeBookmarkletCode,
  parseStoredBookmarklets,
  runBookmarklet,
} from "../bookmarklets.ts";

test("normalizeBookmarkletCode accepts plain JavaScript and strips a javascript: prefix", () => {
  assert.equal(
    normalizeBookmarkletCode(" document.body.dataset.ran = 'yes'; "),
    "document.body.dataset.ran = 'yes';",
  );
  assert.equal(
    normalizeBookmarkletCode("javascript:alert('hello')"),
    "alert('hello')",
  );
});

test("normalizeBookmarkletCode rejects an empty bookmarklet", () => {
  assert.throws(
    () => normalizeBookmarkletCode(" javascript:  "),
    /JavaScript code/i,
  );
});

test("parseStoredBookmarklets keeps only valid named bookmarklets", () => {
  assert.deepEqual(
    parseStoredBookmarklets(
      JSON.stringify([
        {
          id: "one",
          name: "Dark mode",
          code: "document.body.classList.add('dark')",
        },
        { id: "", name: "Invalid", code: "alert(1)" },
        { id: "two", name: "", code: "alert(2)" },
      ]),
    ),
    [
      {
        id: "one",
        name: "Dark mode",
        code: "document.body.classList.add('dark')",
      },
    ],
  );
  assert.deepEqual(parseStoredBookmarklets("not json"), []);
});

test("runBookmarklet evaluates code in the supplied tab window", () => {
  const calls: string[] = [];
  const target = {
    eval: (code: string) => calls.push(code),
  } as unknown as Window;

  runBookmarklet(target, "javascript:document.title = 'Changed';");

  assert.deepEqual(calls, ["document.title = 'Changed';"]);
});
