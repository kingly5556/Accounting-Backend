// Mirrors the payload shape ERPHUB signs in the root app's src/lib/auth/jwt.ts.
// This module never constructs or signs a SessionPayload itself.
export type SessionPayload = {
  sub: string;
  username: string;
  roles: string[];
  allowedModules: string[];
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionPayload;
    }
  }
}
