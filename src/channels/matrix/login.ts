/**
 * Matrix password login → access token + device id.
 *
 * The setup wizard's only network step. It exchanges the user's password for a
 * long-lived access token + a freshly-minted device id, then DISCARDS the
 * password — phantombot never stores it (only the token + device id survive,
 * into config.toml via the wizard). This is the "password → token, discard
 * password" half of the invisible-E2EE setup.
 *
 * Expressed behind a `MatrixLoginFn` seam so the wizard is unit-testable with
 * a fake login (no homeserver, no HTTP).
 */

/** Result of a successful password login. */
export interface MatrixLoginResult {
  /** The resolved MXID (`@user:hs`). Matrix may canonicalize what the user
   *  typed (e.g. bare "robbie" → "@robbie:hs"), so we use what the server
   *  returns, not the raw input. */
  userId: string;
  /** Bearer access token for /sync + sends. */
  accessToken: string;
  /** The device id the server minted for this login session. Pinned into
   *  config so the same crypto device is reused across restarts. */
  deviceId: string;
}

/**
 * A password-login function. Production wraps matrix-js-sdk's
 * `loginRequest` / `loginWithPassword`; tests inject a fake.
 */
export type MatrixLoginFn = (args: {
  homeserver: string;
  username: string;
  password: string;
}) => Promise<MatrixLoginResult>;

/**
 * Real login against a homeserver. Dynamically imports matrix-js-sdk so the
 * heavy SDK only loads when the wizard actually runs. Uses a throwaway client
 * with no crypto (we just want the credentials); the crypto-enabled client is
 * built afterwards from the returned token + device id.
 *
 * A device_display_name is set so the session is recognizable in the user's
 * Matrix client device list as the phantombot agent.
 */
export const realMatrixLogin: MatrixLoginFn = async ({
  homeserver,
  username,
  password,
}) => {
  const sdk = await import("matrix-js-sdk");
  const client = sdk.createClient({ baseUrl: homeserver });
  const res = await client.loginRequest({
    type: "m.login.password",
    identifier: { type: "m.id.user", user: username },
    password,
    initial_device_display_name: "phantombot",
  });
  // The login response carries the canonical user id, the access token, and
  // the server-assigned device id. The password is now spent — nothing in this
  // function retains it past this call.
  return {
    userId: res.user_id,
    accessToken: res.access_token,
    deviceId: res.device_id,
  };
};
