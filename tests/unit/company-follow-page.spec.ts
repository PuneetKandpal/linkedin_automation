import { test, expect } from '@playwright/test';
import { StaticConfigLoader } from '../../src/config/static-loader';
import { CompanyFollowPage } from '../../src/pages/CompanyFollowPage';

const sel = new StaticConfigLoader('./config').loadAll().selectors.follow;
const quiet: any = { info() {}, warn() {}, error() {}, debug() {} };

test.describe('state read from the URL alone', () => {
  const cases: Array<[string, string | null]> = [
    ['https://www.linkedin.com/login?session_redirect=%2Fcompany%2Fx', 'loggedout'],
    ['https://www.linkedin.com/uas/login?fromSignIn=true', 'loggedout'],
    ['https://www.linkedin.com/authwall?trk=bf', 'loggedout'],
    ['https://www.linkedin.com/signup/cold-join', 'loggedout'],
    ['https://www.linkedin.com/hp', 'loggedout'],
    ['https://www.linkedin.com/hp/', 'loggedout'],
    ['https://www.linkedin.com/checkpoint/challenge/AgEA', 'challenge'],
    ['https://www.linkedin.com/company/unavailable/', 'notfound'],
    ['https://www.linkedin.com/company/107356846/admin/dashboard/', 'admin'],
    // company names that merely look like those routes must not be misread
    ['https://www.linkedin.com/company/login-labs/?viewAsMember=true', null],
    ['https://www.linkedin.com/company/loginradius/', null],
    ['https://www.linkedin.com/company/signup-genius/', null],
    ['https://www.linkedin.com/company/hp/posts/?feedView=all', null],
    ['https://www.linkedin.com/company/unavailable-labs/', null],
    ['https://www.linkedin.com/company/checkpoint-software-technologies/', null],
    ['https://www.linkedin.com/company/admin-ninja/?viewAsMember=true', null],
    ['about:blank', null],
  ];
  for (const [url, want] of cases) {
    test(`${want ?? 'not decided by URL'}: ${url}`, () => {
      const fp: any = new CompanyFollowPage({ url: () => url } as any, sel, {} as any, {} as any, quiet);
      expect(fp.stateFromUrl()).toBe(want);
    });
  }
});

/** persist: 'click' = server keeps the follow at once; 'reload2' = visible from the 2nd reload; 'never' = request lost. */
function makeFake(opts: { startFollowing?: boolean; persist?: 'click' | 'reload2' | 'never'; clickDoesNothing?: boolean; signedOutOnReload?: boolean } = {}) {
  const { startFollowing = false, persist = 'click', clickDoesNothing = false, signedOutOnReload = false } = opts;
  const st = { ui: startFollowing, server: startFollowing, reloads: 0, clicks: 0, url: 'https://www.linkedin.com/company/acme/?viewAsMember=true' };
  const isFollowSel = (s: string) => s === sel.followButton || s === sel.followButtonAlt;
  const isFollowingSel = (s: string) => s === sel.followingButton || s === sel.followingButtonAlt;
  const button = (kind: 'follow' | 'following') => ({
    isVisible: async () => true,
    getAttribute: async (n: string) => (n === 'aria-label' ? (kind === 'follow' ? 'Follow' : 'Following') : n === 'aria-pressed' ? String(kind === 'following') : null),
    textContent: async () => (kind === 'follow' ? 'Follow' : 'Following'),
    scrollIntoViewIfNeeded: async () => {},
    hover: async () => {},
    click: async () => {
      st.clicks++;
      if (!clickDoesNothing) {
        st.ui = true; // LinkedIn flips the button at once...
        if (persist === 'click') st.server = true; // ...but the server only keeps it if the request survives
      }
    },
  });
  const collection = (s: string) => ({
    count: async () => ((isFollowSel(s) && !st.ui) || (isFollowingSel(s) && st.ui) ? 1 : 0),
    nth: () => button(isFollowSel(s) ? 'follow' : 'following'),
  });
  const topCard = { isVisible: async () => true, locator: (s: string) => collection(s) };
  const page: any = {
    url: () => st.url,
    evaluate: async () => 'complete',
    waitForTimeout: async () => {},
    reload: async () => {
      st.reloads++;
      if (signedOutOnReload) st.url = 'https://www.linkedin.com/login?session_redirect=x';
      if (persist === 'reload2' && st.reloads >= 2) st.server = true;
      st.ui = st.server; // a reload shows what the server really has
    },
    locator: (s: string) => ({
      first: () => (s === sel.topCard || s === sel.topCardAlt ? topCard : { isVisible: async () => false }),
      ...collection(s),
    }),
  };
  const fp = new CompanyFollowPage(page, sel, { naturalScroll: async () => {} } as any, { wait: async () => {}, beforeFollowClick: async () => {} } as any, quiet);
  return { fp, st };
}

test.describe('follow() only counts a follow that survives a reload', () => {
  test('detects the Follow button in the top card', async () => {
    expect(await makeFake().fp.detectState()).toBe('follow');
  });

  test('a follow that reaches the server is confirmed by a reload', async () => {
    const { fp, st } = makeFake({ persist: 'click' });
    expect(await fp.follow()).toBe(true);
    expect([st.clicks, st.reloads]).toEqual([1, 1]);
  });

  test('the button flips but the request is lost: not reported as followed', async () => {
    const { fp, st } = makeFake({ persist: 'never' });
    expect(await fp.follow()).toBe(false);
    expect([st.clicks, st.reloads]).toEqual([1, 2]);
    expect(await fp.detectState()).toBe('follow'); // so a retry on the next run is correct
  });

  test('LinkedIn slow to show the new state: the second look confirms', async () => {
    const { fp, st } = makeFake({ persist: 'reload2' });
    expect(await fp.follow()).toBe(true);
    expect([st.clicks, st.reloads]).toEqual([1, 2]);
  });

  test('already following: no click (a click would unfollow) and no reload', async () => {
    const { fp, st } = makeFake({ startFollowing: true });
    expect(await fp.follow()).toBe(true);
    expect([st.clicks, st.reloads]).toEqual([0, 0]);
  });

  test('the button never flips: false, no reload attempted', async () => {
    const { fp, st } = makeFake({ clickDoesNothing: true });
    const realNow = Date.now;
    let t = 0;
    Date.now = () => (t += 4000); // let the 10 s wait run out instantly
    try {
      expect(await fp.follow()).toBe(false);
    } finally {
      Date.now = realNow;
    }
    expect([st.clicks, st.reloads]).toEqual([1, 0]);
  });

  test('signed out when the page reloads: false after one look', async () => {
    const { fp, st } = makeFake({ persist: 'click', signedOutOnReload: true });
    expect(await fp.follow()).toBe(false);
    expect(st.reloads).toBe(1);
    expect(await fp.detectState()).toBe('loggedout');
  });
});
