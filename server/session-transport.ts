import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Config } from './config.js';
import { HttpError } from './types.js';

const readCookie = (request: Request, name: string) => {
  const item = (request.headers.cookie || '')
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(name + '='));
  try {
    return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
  } catch {
    return '';
  }
};

// Firebase Hosting only forwards __session. Sign its envelope so both the
// Firebase session and the CSRF binding survive that proxy without trusting a client role.
export class SessionTransport {
  private key: Buffer;
  private options;
  private sessionName: string;
  private csrfName: string;
  constructor(private config: Config) {
    this.key = config.SESSION_COOKIE_SIGNING_KEY
      ? Buffer.from(config.SESSION_COOKIE_SIGNING_KEY, 'base64url')
      : randomBytes(32);
    this.options = {
      httpOnly: true,
      secure: config.secure,
      sameSite: 'strict' as const,
      path: '/',
    };
    this.sessionName = config.secure ? '__Host-blackout_session' : 'blackout_session';
    this.csrfName = config.secure ? '__Host-blackout_csrf' : 'blackout_csrf';
  }
  private state(request: Request): { session: string; csrf: string } {
    const value = readCookie(request, '__session');
    if (value.length > 3800) return { session: '', csrf: '' };
    const parts = value.split('~');
    if (
      parts.length !== 5 ||
      parts[0] !== 'v1' ||
      !/^[a-z0-9]+$/.test(parts[1]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[2]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[4])
    )
      return { session: '', csrf: '' };
    const expires = parseInt(parts[1], 36),
      expected = createHmac('sha256', this.key)
        .update(parts.slice(0, 4).join('~'))
        .digest('base64url');
    if (
      !Number.isSafeInteger(expires) ||
      expires <= Date.now() ||
      !timingSafeEqual(Buffer.from(parts[4]), Buffer.from(expected))
    )
      return { session: '', csrf: '' };
    return { session: parts[3], csrf: parts[2] };
  }
  private write(response: Response, session: string, csrf: string) {
    const value = ['v1', (Date.now() + this.config.sessionMs).toString(36), csrf, session].join(
      '~',
    );
    const signed = value + '~' + createHmac('sha256', this.key).update(value).digest('base64url');
    if (encodeURIComponent(signed).length > 3800)
      throw new HttpError(
        500,
        'SESSION_TOO_LARGE',
        'Não foi possível iniciar a sessão. Entre novamente.',
      );
    response.cookie('__session', signed, { ...this.options, maxAge: this.config.sessionMs });
  }
  session(request: Request) {
    return this.config.FIREBASE_HOSTING
      ? this.state(request).session
      : readCookie(request, this.sessionName);
  }
  csrf(request: Request) {
    return this.config.FIREBASE_HOSTING
      ? this.state(request).csrf
      : readCookie(request, this.csrfName);
  }
  setCsrf(request: Request, response: Response, token: string) {
    if (this.config.FIREBASE_HOSTING) this.write(response, this.state(request).session, token);
    else response.cookie(this.csrfName, token, { ...this.options, maxAge: this.config.sessionMs });
  }
  setSession(request: Request, response: Response, session: string) {
    if (this.config.FIREBASE_HOSTING) this.write(response, session, this.state(request).csrf);
    else
      response.cookie(this.sessionName, session, {
        ...this.options,
        maxAge: this.config.sessionMs,
      });
  }
  clear(response: Response) {
    if (this.config.FIREBASE_HOSTING) response.clearCookie('__session', this.options);
    else {
      response.clearCookie(this.sessionName, this.options);
      response.clearCookie(this.csrfName, this.options);
    }
  }
}
