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
 */
export function insecureDevVerifier(): TokenVerifier {
  return async (token) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) {
      throw new Error('Invalid dev token');
    }
    return { uid: token };
  };
}
