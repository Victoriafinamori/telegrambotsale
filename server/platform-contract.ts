import type { Accounts } from './accounts.js';
import type { BotOnboarding } from './bot-onboarding.js';
export type AccountService = Pick<
  Accounts,
  | 'isAdmin'
  | 'own'
  | 'list'
  | 'history'
  | 'register'
  | 'confirm'
  | 'changeEmail'
  | 'invite'
  | 'inspect'
  | 'accept'
  | 'approve'
  | 'suspend'
  | 'restore'
  | 'consumeRate'
>;
export type OnboardingService = Pick<
  BotOnboarding,
  'read' | 'own' | 'save' | 'submit' | 'review' | 'activate' | 'reveal'
>;
