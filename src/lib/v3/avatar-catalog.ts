/** Single source of truth for all 52 tracked avatar PNGs. */
export const AVATAR_FORMS = ["men", "woman"] as const;
export type AvatarForm = (typeof AVATAR_FORMS)[number];

export const AVATAR_POSES = {
  men: ["anger", "crossed-arm", "double-biceps", "fury", "hand-in-pocket", "thumbs-down", "thumbs-up"],
  woman: ["anger", "double-biceps", "elegant", "fury", "thumbs-down", "thumbs-up"],
} as const;

export type AvatarStance = (typeof AVATAR_POSES)[AvatarForm][number];
export const AVATAR_FRAMES = ["listening", "speaking", "waiting_1", "waiting_2"] as const;
export type AvatarFrame = (typeof AVATAR_FRAMES)[number];

export const DEFAULT_STANCE: Readonly<Record<AvatarForm, AvatarStance>> = {
  men: "hand-in-pocket",
  woman: "elegant",
};

export const VOICE_EMOTIONS = [
  "neutral", "calm", "happy", "excited", "angry", "sad", "curious",
  "confident", "sarcastic", "frustrated", "surprised", "content", "disappointed",
] as const;
export type VoiceEmotion = (typeof VOICE_EMOTIONS)[number];

export function avatarForm(value: unknown, fallback: AvatarForm = "men"): AvatarForm {
  return value === "men" || value === "woman" ? value : fallback;
}

export function avatarStance(form: AvatarForm, value: unknown): AvatarStance {
  const available: readonly string[] = AVATAR_POSES[form];
  return typeof value === "string" && available.includes(value)
    ? value as AvatarStance : DEFAULT_STANCE[form];
}

export function avatarEmotion(value: unknown): VoiceEmotion {
  return typeof value === "string" && (VOICE_EMOTIONS as readonly string[]).includes(value)
    ? value as VoiceEmotion : "neutral";
}

export function avatarPath(
  form: AvatarForm, stance: AvatarStance, frame: AvatarFrame,
): string {
  return "/characters/" + form + "/" + avatarStance(form, stance) + "/" + frame + ".png";
}

export const AVATAR_ASSETS = AVATAR_FORMS.flatMap(form =>
  AVATAR_POSES[form].flatMap(stance =>
    AVATAR_FRAMES.map(frame => ({form, stance, frame, path: avatarPath(form, stance, frame)})),
  ),
);
