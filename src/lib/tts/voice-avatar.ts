import type { CharacterVisual, ExpressionId } from "../alexios";
import {avatarPath, avatarForm} from "../v3/avatar-catalog.ts";

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
      src: avatarPath(avatarForm(visual.form), visual.stance, frame),
    },
  };
}
