import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidInstanceId, isValidRunId, isValidCommandCursor,
} from "../src/lib/v2/protocol.ts";

test("identificador aleatorio valida; identificadores previsiveis ou malformados nao", () => {
  assert.equal(isValidInstanceId("alx_0123456789abcdef0123456789abcdef"), true);
  assert.equal(isValidInstanceId("alexios-v1"), false);
  assert.equal(isValidInstanceId("abc ".repeat(8)), false);
  assert.equal(isValidInstanceId("x".repeat(81)), false);
  assert.equal(isValidInstanceId("x".repeat(20)), true); // Sintaxe; entropia depende do gerador.
  assert.equal(isValidInstanceId(null), false);
});

test("runId exige UUID versionado valido", () => {
  assert.equal(isValidRunId("85b50a25-32da-4c2a-ae34-129bb2acb454"), true);
  assert.equal(isValidRunId("85b50a25-32da-1c2a-2e34-129bb2acb454"), false);
  assert.equal(isValidRunId("run-1"), false);
});

test("cursor aceita apenas inteiros seguros e -1 de bootstrap", () => {
  assert.equal(isValidCommandCursor(-1), true);
  assert.equal(isValidCommandCursor(0), true);
  assert.equal(isValidCommandCursor(300), true);
  assert.equal(isValidCommandCursor(-2), false);
  assert.equal(isValidCommandCursor(1.5), false);
  assert.equal(isValidCommandCursor(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(isValidCommandCursor("0"), false);
});
