import type { CharacterVisual, ExpressionId } from "../alexios";

/** Backend's 3-12s speaking estimate is suppressed when real browser TTS is enabled. */
export function playbackAvatar(
  expression: ExpressionId,
  visual: CharacterVisual | undefined,
  cartesiaEnabled: boolean,
  audioIsPlaying: boolean,
): { expression: ExpressionId; visual: CharacterVisual | undefined } {
  if (!cartesiaEnabled) return { expression, visual };
  const shownExpression = audioIsPlaying ? "speaking"
    : expression === "speaking" ? "idle" : expression;
  if (!visual) return { expression: shownExpression, visual };
  const frame = audioIsPlaying ? "speaking"
    : visual.frame === "speaking" ? "waiting_1" : visual.frame;
  return {
    expression: shownExpression,
    visual: {
      ...visual,
      frame,
      src: `/characters/stand/${visual.stance}/${frame}.png`,
    },
  };
}
