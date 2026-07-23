import assert from "node:assert/strict";
import test from "node:test";
import { escapeAttribute, escapeHtml } from "../src/ui/html.ts";

test("friend-authored profile text cannot become portal markup", () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="alert('nope')">&`),
    "&lt;img src=x onerror=&quot;alert(&#39;nope&#39;)&quot;&gt;&amp;",
  );
  assert.equal(escapeAttribute("friend`name"), "friend&#96;name");
});
