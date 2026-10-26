import { z } from 'zod';
import type { Shop } from './bot-types.js';
export const pixTypes = {
  cpf: 'CPF',
  cnpj: 'CNPJ',
  email: 'E-mail',
  phone: 'Celular',
  random: 'Chave aleatória',
};
export function validDocument(value: string, type: 'cpf' | 'cnpj') {
  const digits = value.replace(/\D/g, '');
  if (
    !/^\d+$/.test(digits) ||
    /^(\d)\1+$/.test(digits) ||
    digits.length !== (type === 'cpf' ? 11 : 14)
  )
    return false;
  const base = type === 'cpf' ? 9 : 12;
  for (let step = 0; step < 2; step++) {
    const length = base + step;
    const weights =
      type === 'cpf'
        ? Array.from({ length }, (_, i) => length + 1 - i)
        : Array.from({ length }, (_, i) => ((length - 1 - i) % 8) + 2);
    const sum = weights.reduce((sum, weight, i) => sum + Number(digits[i]) * weight, 0);
    const check = sum % 11 < 2 ? 0 : 11 - (sum % 11);
    if (check !== Number(digits[length])) return false;
  }
  return true;
}
export const pixKey = z
  .object({
    type: z.enum(['cpf', 'cnpj', 'email', 'phone', 'random']),
    value: z.string().trim().min(1).max(254),
    holder: z.string().trim().max(80),
  })
  .strict()
  .superRefine((key, ctx) => {
    const valid =
      key.type === 'cpf' || key.type === 'cnpj'
        ? validDocument(key.value, key.type)
        : key.type === 'email'
          ? z.email().safeParse(key.value).success
          : key.type === 'phone'
            ? /^\+55\d{10,11}$/.test(key.value.replace(/[ ()-]/g, ''))
            : z.uuid().safeParse(key.value).success;
    if (!valid)
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `Chave Pix inválida para o tipo ${pixTypes[key.type]}. Celular deve incluir +55 e DDD.`,
      });
  })
  .transform((key) => ({
    ...key,
    value:
      key.type === 'cpf' || key.type === 'cnpj'
        ? key.value.replace(/\D/g, '')
        : key.type === 'phone'
          ? key.value.replace(/[ ()-]/g, '')
          : key.value.toLowerCase(),
  }));
export function manualPixText(shop: Shop) {
  return [
    ...(shop.pix_keys ?? []).map(
      (key) =>
        `${pixTypes[key.type]}: ${key.value}${key.holder ? '\nRecebedor: ' + key.holder : ''}`,
    ),
    shop.payment_instructions ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
