/**
 * Tiny wrapper around the Telegram Bot API for token validation. Used by
 * the `phantombot telegram` TUI to confirm the token works before saving.
 */

export type GetMeResult =
  | { ok: true; username: string; firstName?: string; id: number }
  | { ok: false; error: string };

export async function telegramGetMe(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GetMeResult> {
  let res: Response;
  try {
    res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`);
  } catch (e) {
    return { ok: false, error: `network: ${(e as Error).message}` };
  }
  let body: {
    ok?: boolean;
    description?: string;
    result?: { id?: number; username?: string; first_name?: string };
  };
  try {
    body = (await res.json()) as typeof body;
  } catch (e) {
    return { ok: false, error: `non-JSON response (${res.status})` };
  }
  if (
    !body.ok ||
    !body.result ||
    typeof body.result.username !== "string" ||
    typeof body.result.id !== "number"
  ) {
    return {
      ok: false,
      error: body.description ?? `HTTP ${res.status}`,
    };
  }
  return {
    ok: true,
    username: body.result.username,
    firstName: body.result.first_name,
    id: body.result.id,
  };
}
