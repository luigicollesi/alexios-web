import {test} from "node:test";
import assert from "node:assert/strict";
import {
  FastProviderHttpError, fastCompletionBody, fastFailureCode,
  fastModelCandidates, fastShouldTryFallback,
} from "../src/lib/v3/fast-provider.ts";

test("one environment variable controls all AI modes by default", () => {
  const candidates = fastModelCandidates({
    shared: "nvidia/nemotron-3.5-lightning:free",
  });
  assert.deepEqual(candidates.map(x => x.model),
    ["nvidia/nemotron-3.5-lightning:free"]);
  assert.equal(candidates[0].disableReasoning, true);
  assert.deepEqual(fastModelCandidates({}).map(x => x.model),
    ["nvidia/nemotron-3.5-lightning:free"]);
});

test("do not add provider restrictions or response_format that can fail for free endpoints", () => {
  const candidate = fastModelCandidates({})[0];
  const body = fastCompletionBody(candidate, [
    {role:"user",content:"Diga uma frase curta."},
  ]);
  assert.equal(body.model, candidate.model);
  assert.deepEqual(body.reasoning, {enabled:false});
  assert.equal(Object.hasOwn(body, "provider"),false);
  assert.equal(Object.hasOwn(body, "response_format"),false);
  assert.ok(Number(body.max_tokens) <= 200);
});

test("explicit alternative fallback omits reasoning for provider compatibility", () => {
  const candidate = fastModelCandidates({
    shared: "nvidia/nemotron-3.5-lightning:free",
    fallback: "openrouter/free",
  })[1];
  const body = fastCompletionBody(candidate, [
    {role:"user",content:"Olá!"},
  ]);
  assert.equal(Object.hasOwn(body,"reasoning"),false);
  assert.equal(body.model,"openrouter/free");
});

test("explicit model fallback is opt-in and never inferred as a paid option", () => {
  const models = fastModelCandidates({
    primary:"google/gemma-4-26b-a4b-it:free",
    fallback:"nvidia/nemotron-3-ultra-550b-a55b:free",
    timeoutMs:"2700",
  });
  assert.equal(models[1].model,"nvidia/nemotron-3-ultra-550b-a55b:free");
  assert.equal(models[0].timeoutMs,2700);
  assert.equal(fastModelCandidates({primary:"openrouter/free",fallback:"openrouter/free"}).length,1);
});

test("fast-specific override remains possible without changing OBSERVE", () => {
  const models = fastModelCandidates({
    shared: "nvidia/nemotron-3.5-lightning:free",
    primary: "google/gemma-4-26b-a4b-it:free",
  });
  assert.deepEqual(models.map(x => x.model),
    ["google/gemma-4-26b-a4b-it:free"]);
});

test("HTTP 400, 404, 429 and 402 are visible as machine-readable reasons", () => {
  for(const status of [400,402,404,422,429,503]){
    assert.equal(fastFailureCode(new FastProviderHttpError(status)), "http_"+status);
  }
  assert.equal(fastFailureCode(new SyntaxError("Unterminated string")),"invalid_json");
  assert.equal(fastFailureCode(new Error("OPENROUTER_API_KEY ausente.")),"missing_api_key");
  assert.equal(fastFailureCode(new Error("Unexpected provider fault")),"provider_error");
});

test("fallback is attempted for unavailable models but not bad credentials", () => {
  for(const code of ["http_400","http_402","http_404","http_429","invalid_json","model_timeout"]){
    assert.equal(fastShouldTryFallback(code),true);
  }
  assert.equal(fastShouldTryFallback("http_401"),false);
  assert.equal(fastShouldTryFallback("http_403"),false);
});
