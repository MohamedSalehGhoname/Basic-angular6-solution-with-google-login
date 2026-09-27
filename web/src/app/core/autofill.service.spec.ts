import { matchScore } from './autofill.service';

const secret = (title: string, url = '') => ({ title, url });

describe('matchScore', () => {
  it('matches a stored URL against the domain a browser reports', () => {
    expect(matchScore(secret('Bank', 'https://northbank.example.com/login'), 'northbank.example.com'))
      .toBeGreaterThan(0);
  });

  it('accepts a subdomain on either side', () => {
    // Stored the bare domain, asked about the login subdomain.
    expect(matchScore(secret('Bank', 'example.com'), 'login.example.com')).toBeGreaterThan(0);
    // Stored a subdomain, asked about the bare domain.
    expect(matchScore(secret('Bank', 'https://login.example.com'), 'example.com')).toBeGreaterThan(0);
  });

  it('ignores the scheme and path the user happened to save', () => {
    const withPath = matchScore(secret('X', 'https://example.com/a/b?c=d'), 'example.com');
    const bare = matchScore(secret('X', 'example.com'), 'example.com');
    expect(withPath).toBe(bare);
  });

  it('matches an app by the distinctive word in its package name', () => {
    // Nobody stores "com.instagram.android" as a URL, so the title carries it.
    expect(matchScore(secret('Instagram'), 'com.instagram.android')).toBeGreaterThan(0);
  });

  it('does not match on the generic parts of a package name', () => {
    expect(matchScore(secret('Android tips'), 'com.instagram.android')).toBe(0);
    expect(matchScore(secret('My com account'), 'com.instagram.android')).toBe(0);
  });

  it('ranks an exact domain above a looser match', () => {
    const exact = matchScore(secret('Bank', 'https://example.com'), 'example.com');
    const sub = matchScore(secret('Bank', 'https://example.com'), 'login.example.com');
    expect(exact).toBeGreaterThan(sub);
  });

  it('says nothing when there is nothing to go on', () => {
    expect(matchScore(secret('Bank', 'https://example.com'), 'unrelated.test')).toBe(0);
    expect(matchScore(secret('Bank', ''), '')).toBe(0);
  });

  it('survives a URL the user typed badly', () => {
    expect(() => matchScore(secret('Bank', 'not a url at all'), 'example.com')).not.toThrow();
    expect(matchScore(secret('Bank', 'not a url at all'), 'example.com')).toBe(0);
  });
});
