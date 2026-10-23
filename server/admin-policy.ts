import type { Config } from './config.js';
import { HttpError, type Identity } from './types.js';
export function enforceAdminSecondFactor(config: Pick<Config, 'secure'>, identity: Identity) {
  if (config.secure && !identity.secondFactor) {
    throw new HttpError(
      403,
      'ADMIN_MFA_REQUIRED',
      'A administração em produção exige autenticação em duas etapas.',
    );
  }
}
