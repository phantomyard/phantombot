/**
 * Matrix password login → access token + device id.
 *
 * The setup wizard's only network step. It exchanges the user's password for a
 * long-lived access token + a freshly-minted device id, then DISCARDS the
 * password — phantombot never stores it (only the token + device id survive,
 * into config.toml via the wizard).
 *
 * Built on matrix-bot-sdk's `MatrixAuth`. `MatrixAuth.passwordLogin` itself
 * throws away the `user_id`/`device_id` (it only keeps the access token), so we
 * drive the raw `/login` request through its template client and read all three
 * fields off the response directly. The matching `passwordRegister` path is
 * exposed too so the wizard can CREATE a bot account programmatically on a
 * homeserver that allows open/dummy registration — no manual pre-creation.
 *
 * Expressed behind a `MatrixLoginFn` seam so the wizard is unit-testable with a
 * fake login (no homeserver, no HTTP).
 */

/** Result of a successful password login (or registration). */
export interface MatrixLoginResult {
  /** The resolved MXID (`@user:hs`). Matrix may canonicalize what the user
   *  typed (e.g. bare "robbie" → "@robbie:hs"), so we use what the server
   *  returns, not the raw input. */
  userId: string;
  /** Bearer access token for /sync + sends. */
  accessToken: string;
  /** The device id the server minted for this session. Vestigial under
   *  matrix-bot-sdk (the crypto store owns the device identity), but recorded
   *  in config for diagnostics / forward-compat. */
  deviceId: string;
}

/**
 * A password-login function. Production drives matrix-bot-sdk's `MatrixAuth`
 * template client; tests inject a fake.
 */
export type MatrixLoginFn = (args: {
  homeserver: string;
  username: string;
  password: string;
}) => Promise<MatrixLoginResult>;

const DEVICE_DISPLAY_NAME = "phantombot";

/**
 * Real password login against a homeserver. Dynamically imports matrix-bot-sdk
 * so it only loads when the wizard actually runs. Uses `MatrixAuth`'s template
 * client (no access token, no crypto) to POST `/login` and reads the canonical
 * user id, access token, and device id straight off the response.
 *
 * `initial_device_display_name` makes the session recognizable as the phantombot
 * agent in the user's Matrix client device list.
 */
export const realMatrixLogin: MatrixLoginFn = async ({
  homeserver,
  username,
  password,
}) => {
  const { MatrixClient } = await import("matrix-bot-sdk");
  // A token-less client just to drive the /login request (mirrors how
  // MatrixAuth builds its internal template client).
  const tmpl = new MatrixClient(homeserver, "");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await tmpl.doRequest(
    "POST",
    "/_matrix/client/v3/login",
    null,
    {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: username },
      password,
      initial_device_display_name: DEVICE_DISPLAY_NAME,
    },
  );
  // The password is now spent — nothing in this function retains it.
  return {
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: res.device_id,
  };
};

/**
 * Real password REGISTRATION against a homeserver — creates a brand-new bot
 * account programmatically (the "no manual account pre-creation" win of
 * matrix-bot-sdk). Assumes the homeserver permits `m.login.password` /
 * `m.login.dummy` registration; the caller decides whether to register or log
 * in. Same return shape as login, so the wizard treats both uniformly.
 */
export const realMatrixRegister: MatrixLoginFn = async ({
  homeserver,
  username,
  password,
}) => {
  const { MatrixAuth } = await import("matrix-bot-sdk");
  const auth = new MatrixAuth(homeserver);
  const client = await auth.passwordRegister(username, password, DEVICE_DISPLAY_NAME);
  // passwordRegister returns a logged-in client but drops user_id/device_id;
  // recover them from /whoami (returns user_id + device_id on a v1.1+ server).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const who: any = await client.getWhoAmI();
  return {
    userId: who.user_id,
    accessToken: client.accessToken,
    deviceId: who.device_id ?? "",
  };
};
