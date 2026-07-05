/**
 * Tiny GitHub Releases client. Used by `phantombot update` to discover
 * the latest released version + the right binary asset for the host arch.
 *
 * No GitHub auth needed because the repo is public; if the API ever rate-
 * limits us (60/h unauth), GITHUB_TOKEN in env is honored for higher caps.
 * If the token is rejected (401) or rate-limited (403) — e.g. a GitHub
 * App installation token scoped to a different org — we transparently
 * retry once without the auth header before failing.
 *
 * Repo coordinates are env-overridable (PHANTOMBOT_UPDATE_REPO=owner/name)
 * so a future repo move can be staged through env without a rebuild.
 */

const DEFAULT_REPO = "phantomyard/phantombot";

/** What kind of host arch the running phantombot needs an asset for. */
export type SupportedArch = "x64" | "arm64";

/**
 * The full release-target tuple — phantombot ships one binary per
 * (platform, arch) pair, named `phantombot-${tag}-${target}` (Windows adds a
 * `.exe` suffix — see releaseAssetName). Currently built: linux-x64,
 * linux-arm64, darwin-arm64, windows-x64, windows-arm64. No darwin-x64
 * because no deploy target uses Intel Mac.
 */
export type SupportedTarget =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-arm64"
  | "windows-x64"
  | "windows-arm64";

/**
 * The release asset filename for a (tag, target). Windows binaries carry a
 * `.exe` suffix (that's how the release workflow uploads them); every other
 * platform is extensionless. Kept as a single helper so the updater's
 * "what asset am I looking for" logic and any future callers agree.
 */
export function releaseAssetName(tag: string, target: SupportedTarget): string {
  const base = `phantombot-${tag}-${target}`;
  return target.startsWith("windows-") ? `${base}.exe` : base;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface LatestRelease {
  /** Without the leading `v`, e.g. "1.0.43". */
  version: string;
  /** The full tag, e.g. "v1.0.43". */
  tag: string;
  /** ISO timestamp GitHub published the release. */
  publishedAt?: string;
  /** GitHub release body text (release notes). May be empty. */
  body: string;
  /** The binary asset for the requested arch. */
  binary: ReleaseAsset;
  /** The SHA256SUMS file alongside it. */
  checksums: ReleaseAsset;
}

export type FindLatestResult =
  | { ok: true; release: LatestRelease }
  | { ok: false; error: string };

/**
 * Hit GitHub's `/releases/latest` endpoint, find the binary asset that
 * matches the requested target + the SHA256SUMS file beside it, and
 * return everything `phantombot update` needs to download and verify.
 */
export async function findLatestRelease(opts: {
  target: SupportedTarget;
  /** Override the upstream repo. Default: env var or DEFAULT_REPO. */
  repo?: string;
  fetchImpl?: typeof fetch;
}): Promise<FindLatestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const repo =
    opts.repo ?? process.env.PHANTOMBOT_UPDATE_REPO ?? DEFAULT_REPO;
  const url = `https://api.github.com/repos/${repo}/releases/latest`;

  const hadToken = !!process.env.GITHUB_TOKEN;

  let res: Response;
  try {
    res = await fetchImpl(url, { headers: buildHeaders(hadToken) });
  } catch (e) {
    return {
      ok: false,
      error: `network error reaching ${url}: ${(e as Error).message}`,
    };
  }

  // GitHub App installation tokens are scoped to a single org's repos.
  // Using one against a public repo outside that org returns 401 — the
  // token is "valid" but not authorized for this resource. The release
  // endpoint is public, so an unauthenticated retry usually succeeds.
  // We also retry on 403 in case the token itself is rate-limited or
  // suspended while the unauth pool still has budget. See issue #115.
  let retriedUnauth = false;
  if (hadToken && (res.status === 401 || res.status === 403)) {
    try {
      res = await fetchImpl(url, { headers: buildHeaders(false) });
      retriedUnauth = true;
    } catch {
      // Network error on the retry — fall through and report the
      // original status below.
    }
  }

  if (res.status === 403) {
    return {
      ok: false,
      error: retriedUnauth
        ? "GitHub API rate-limited (60/h) even after retrying without GITHUB_TOKEN. Try again later."
        : "GitHub API rate-limited (60/h unauth). Set GITHUB_TOKEN in env to lift the cap.",
    };
  }
  if (res.status === 401) {
    return {
      ok: false,
      error: retriedUnauth
        ? `GitHub API HTTP 401 from ${url} (unauth retry also rejected — unexpected for a public repo)`
        : `GitHub API HTTP 401 from ${url} (token rejected; is GITHUB_TOKEN scoped to a different org?)`,
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      error: `no releases found at ${repo}. Has the workflow ever produced one?`,
    };
  }
  if (!res.ok) {
    return { ok: false, error: `GitHub API HTTP ${res.status} from ${url}` };
  }

  let body: GithubReleaseResponse;
  try {
    body = (await res.json()) as GithubReleaseResponse;
  } catch (e) {
    return {
      ok: false,
      error: `GitHub API returned non-JSON: ${(e as Error).message}`,
    };
  }

  if (typeof body.tag_name !== "string" || !Array.isArray(body.assets)) {
    return {
      ok: false,
      error: "GitHub API response missing tag_name or assets",
    };
  }

  const tag = body.tag_name;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  const wantedBinaryName = releaseAssetName(tag, opts.target);
  const binary = body.assets.find((a) => a.name === wantedBinaryName);
  const checksums = body.assets.find((a) => a.name === "SHA256SUMS");

  if (!binary) {
    const have = body.assets.map((a) => a.name).join(", ");
    return {
      ok: false,
      error: `release ${tag} has no asset named ${wantedBinaryName} (have: ${have || "(none)"})`,
    };
  }
  if (!checksums) {
    return {
      ok: false,
      error: `release ${tag} has no SHA256SUMS asset; refusing to install without checksum verification`,
    };
  }

  return {
    ok: true,
    release: {
      version,
      tag,
      publishedAt:
        typeof body.published_at === "string" ? body.published_at : undefined,
      body: typeof body.body === "string" ? body.body : "",
      binary: {
        name: binary.name,
        url: binary.browser_download_url,
        size: binary.size,
      },
      checksums: {
        name: checksums.name,
        url: checksums.browser_download_url,
        size: checksums.size,
      },
    },
  };
}

/**
 * Map node/bun's process.arch to the suffix the release workflow uses.
 * Returns undefined on architectures we don't ship binaries for, so the
 * CLI can refuse with a clear message instead of trying a missing asset.
 *
 * Kept for tests + back-compat. New code should prefer
 * detectSupportedTarget which also includes the platform.
 */
export function detectSupportedArch(
  procArch: string = process.arch,
): SupportedArch | undefined {
  if (procArch === "x64") return "x64";
  if (procArch === "arm64") return "arm64";
  return undefined;
}

/**
 * Map (process.platform, process.arch) to one of the release-target
 * tuples we actually ship. Returns undefined for combinations the
 * release workflow doesn't build (e.g. darwin-x64, linux-ia32), so
 * `phantombot update` can refuse with a clear message instead of
 * 404-ing on a missing asset.
 *
 * Built targets: linux-x64, linux-arm64, darwin-arm64, windows-x64,
 * windows-arm64.
 */
export function detectSupportedTarget(
  procPlatform: string = process.platform,
  procArch: string = process.arch,
): SupportedTarget | undefined {
  const arch = detectSupportedArch(procArch);
  if (!arch) return undefined;
  if (procPlatform === "linux") return `linux-${arch}` as SupportedTarget;
  if (procPlatform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (procPlatform === "win32") return `windows-${arch}` as SupportedTarget;
  return undefined;
}

/**
 * Build the request headers for a GitHub API call. If `withAuth` is
 * true and GITHUB_TOKEN is in env, the `authorization` header is added;
 * otherwise the call is unauthenticated (subject to the 60/h IP cap).
 */
function buildHeaders(withAuth: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (withAuth && process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

interface GithubReleaseResponse {
  tag_name?: string;
  published_at?: string;
  body?: string;
  assets?: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}
