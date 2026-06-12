import assert from "node:assert/strict";
import test from "node:test";
import type { WebContents } from "electron";
import { parseHTML } from "linkedom";

import { setElementValue } from "../src/main/ai/page-actions/interaction";

function installDom(html: string) {
  const { window } = parseHTML(html);
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    HTMLSelectElement: globalThis.HTMLSelectElement,
    Element: globalThis.Element,
    Event: globalThis.Event,
    InputEvent: globalThis.InputEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    getComputedStyle: globalThis.getComputedStyle,
  };

  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Element: window.Element,
    Event: window.Event,
    InputEvent: window.InputEvent || window.Event,
    KeyboardEvent: window.KeyboardEvent || window.Event,
    getComputedStyle: () =>
      ({
        display: "block",
        visibility: "visible",
        opacity: "1",
      }) as CSSStyleDeclaration,
  });

  window.getComputedStyle = globalThis.getComputedStyle;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      width: 120,
      height: 32,
      top: 0,
      right: 120,
      bottom: 32,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  return {
    window,
    restore: () => {
      Object.assign(globalThis, previous);
    },
  };
}

function createWebContents(): WebContents {
  return {
    isDestroyed: () => false,
    executeJavaScript: async (script: string) => (0, eval)(script),
  } as unknown as WebContents;
}

test("setElementValue fills ARIA/contenteditable text controls", async () => {
  const { window, restore } = installDom(`
    <!doctype html>
    <html>
      <body>
        <div id="airport" role="searchbox" aria-label="Airport" contenteditable="true"></div>
      </body>
    </html>
  `);
  const airport = window.document.querySelector("#airport");
  assert.ok(airport);

  let inputEvents = 0;
  airport.addEventListener("input", () => {
    inputEvents += 1;
  });

  try {
    const result = await setElementValue(createWebContents(), "#airport", "PDX");

    assert.match(result, /Typed into: Airport = PDX/);
    assert.equal(airport.textContent, "PDX");
    assert.equal(inputEvents, 1);
  } finally {
    restore();
  }
});

test("setElementValue opens combobox activators and fills the revealed input", async () => {
  const { window, restore } = installDom(`
    <!doctype html>
    <html>
      <body>
        <button id="from" role="combobox" aria-label="Where from?" aria-controls="from-dialog">Where from?</button>
        <div id="from-dialog" role="dialog" hidden></div>
      </body>
    </html>
  `);
  const from = window.document.querySelector("#from");
  const dialog = window.document.querySelector("#from-dialog");
  assert.ok(from);
  assert.ok(dialog);

  from.addEventListener("click", () => {
    dialog.removeAttribute("hidden");
    dialog.innerHTML = '<input id="airport-search" aria-label="Airport search" />';
    const input = window.document.querySelector("#airport-search");
    if (input instanceof window.HTMLElement) input.focus();
  });

  try {
    const result = await setElementValue(createWebContents(), "#from", "SFO");
    const input = window.document.querySelector("#airport-search");

    assert.match(result, /Typed into: Airport search = SFO \(opened field\)/);
    assert.ok(input instanceof window.HTMLInputElement);
    assert.equal(input.value, "SFO");
  } finally {
    restore();
  }
});
