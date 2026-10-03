import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface AuthUser {
  uid: string;
}

/** Resolves a bearer token to a user, or throws. */
export type TokenVerifier = (token: string) => Promise<AuthUser>;

/**
 * Verifies Firebase ID tokens against Google's published JWKS. Auth only
 * identifies the account — it can never derive encryption keys, so the
 * server stays zero-knowledge even with valid tokens.
 */
export function firebaseTokenVerifier(projectId: string): TokenVerifier {
  const jwks = createRemoteJWKSet(
    new URL(
      'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
    ),
  );
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new Error('Token has no subject');
    }
    return { uid: payload.sub };
  };
}

/**
 * Development-only verifier: treats the bearer token itself as the uid.
 * Never enable outside local development.
 *
 * `alias` maps that fixed dev identity onto a real account, which is what
 * lets a client still on the dev login (the phone app, until native Google
 * sign-in lands) read and write the owner's real data instead of a separate,
 * empty vault.
 */
export function insecureDevVerifier(alias?: string): TokenVerifier {
  return async (token) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) {
      throw new Error('Invalid dev token');
    }
    return { uid: alias || token };
  };
}

/**
 * Tries each verifier in turn, so real sign-in and a legacy one can run side
 * by side while clients are migrated. The first to accept the token wins.
 */
export function firstMatching(...verifiers: TokenVerifier[]): TokenVerifier {
  return async (token) => {
    let lastError: unknown = new Error('No verifier accepted the token');
    for (const verify of verifiers) {
      try {
        return await verify(token);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  };
}
