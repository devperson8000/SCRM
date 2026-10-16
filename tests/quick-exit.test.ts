import assert from "node:assert/strict";
import test from "node:test";
import { createQuickExitHandler } from "../quick-exit.ts";

function setup() {
  let time = 0;
  let exits = 0;
  const handler = createQuickExitHandler(
    () => exits++,
    () => time,
  );
  const press = (patch = {}) =>
    handler({
      key: "`",
      code: "Backquote",
      repeat: false,
      isComposing: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      preventDefault() {},
      ...patch,
    });
  return { press, advance: (ms: number) => (time += ms), exits: () => exits };
}

test("two quick tilde/backtick presses exit, a single press does not", () => {
  const s = setup();
  s.press();
  assert.equal(s.exits(), 0);
  s.advance(300);
  s.press({ key: "~" });
  assert.equal(s.exits(), 1);
});

test("slow presses and intervening keys do not exit", () => {
  const s = setup();
  s.press();
  s.advance(601);
  s.press();
  assert.equal(s.exits(), 0);
  s.press({ key: "a", code: "KeyA" });
  s.press();
  assert.equal(s.exits(), 0);
});

test("holding the key, composition and modified shortcuts do not exit", () => {
  for (const patch of [
    { repeat: true },
    { isComposing: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
  ]) {
    const s = setup();
    s.press();
    s.press(patch);
    assert.equal(s.exits(), 0);
  }
});

test("a completed shortcut resets the double-press state", () => {
  const s = setup();
  s.press();
  s.press();
  s.press();
  assert.equal(s.exits(), 1);
});
