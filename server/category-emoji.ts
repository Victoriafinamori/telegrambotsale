import { z } from 'zod';
const graphemes = new Intl.Segmenter('pt-BR', { granularity: 'grapheme' });
export const categoryEmoji = z
  .string()
  .trim()
  .max(32)
  .refine(
    (value) =>
      !value ||
      ([...graphemes.segment(value)].length === 1 &&
        /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value)),
    'Escolha um único emoji ou deixe vazio.',
  );
