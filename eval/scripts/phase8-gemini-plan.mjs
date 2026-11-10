export const GEMINI_MODEL = "gemini-flash-3.8";
export const GEMINI_PREFERRED_EFFORT = "low";
export const GEMINI_TIMEOUT_MS = 240_000;
export const GEMINI_MAX_ATTEMPTS = 12;

export const GEMINI_ASSIGNMENTS = [
  ["picomatch-h07", "B"],
  ["picomatch-h07", "A"],
  ["picomatch-h08", "A"],
  ["picomatch-h08", "B"],
  ["json-server-h07", "B"],
  ["json-server-h07", "A"],
  ["json-server-h09", "A"],
  ["json-server-h09", "B"],
  ["fastify-h01", "B"],
  ["fastify-h01", "A"],
  ["fastify-h03", "A"],
  ["fastify-h03", "B"],
].map(([id, condition]) => ({
  id,
  condition,
  repetition: 1,
  slot: `${id}-gemini-r1-${condition}`,
}));

export function chooseGeminiEffort(model) {
  const efforts = (model?.supportedReasoningEfforts ?? []).map((entry) =>
    typeof entry === "string" ? entry : entry.reasoningEffort,
  );
  if (efforts.includes(GEMINI_PREFERRED_EFFORT)) return GEMINI_PREFERRED_EFFORT;
  if (
    model?.defaultReasoningEffort &&
    efforts.includes(model.defaultReasoningEffort)
  )
    return model.defaultReasoningEffort;
  return null;
}
