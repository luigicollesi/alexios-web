-- Dual form and expressive poses. Existing sessions keep the male default.
ALTER TABLE public.alexios_sessions
  ADD COLUMN IF NOT EXISTS character_form text NOT NULL DEFAULT 'men'
    CHECK (character_form IN ('men', 'woman')),
  ADD COLUMN IF NOT EXISTS speech_form text NOT NULL DEFAULT 'men'
    CHECK (speech_form IN ('men', 'woman')),
  ADD COLUMN IF NOT EXISTS speech_emotion text NOT NULL DEFAULT 'neutral'
    CHECK (speech_emotion IN (
      'neutral', 'calm', 'happy', 'excited', 'angry', 'sad', 'curious',
      'confident', 'sarcastic', 'frustrated', 'surprised', 'content', 'disappointed'
    ));

ALTER TABLE public.alexios_sessions
  DROP CONSTRAINT IF EXISTS alexios_sessions_character_stance_check;

ALTER TABLE public.alexios_sessions
  ADD CONSTRAINT alexios_sessions_avatar_pair_check CHECK (
    (character_form = 'men' AND character_stance IN (
      'anger', 'crossed-arm', 'double-biceps', 'fury',
      'hand-in-pocket', 'thumbs-down', 'thumbs-up'
    ))
    OR
    (character_form = 'woman' AND character_stance IN (
      'anger', 'double-biceps', 'elegant', 'fury',
      'thumbs-down', 'thumbs-up'
    ))
  );
