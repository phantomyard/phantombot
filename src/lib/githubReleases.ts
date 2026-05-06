/**
 * Tiny GitHub Releases client. Used by `phantombot update` to discover
 * the latest released version + the right binary asset for the host arch.
 *
 * No GitHub auth needed because the repo is public; if the API ever rate-
 * limits us (60/h unauth), GITHUB_TOKEN in env is honored for higher caps.
 *
 * Repo coordinates are env-overridable (PHANTOMBOT_UPDATE_REPO=owner/name)
 * so a future repo move can be staged through env without a rebuild.
 */

const DEFAULT_REPO = "phantomyard/phantombot";

/** What kind of host arch the running phantombot needs an asset for. */
export type SupportedArch = "x64" | "arm64";

/**
 * The full release-target tuple — phantombot ships one binary per
 * (platform, arch) pair, named `phantombot-${tag}-${target}`. Currently
 * built: linux-x64, linux-arm64, darwin-arm64. No darwin-x64 because no
 * deploy target uses Intel Mac.
 */
export type SupportedTarget = "linux-x64" | "linux-arm64" | "darwin-arm64";

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

  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  let res: Response;
  try {
    res = await fetchImpl(url, { headers });
  } catch (e) {
    return {
      ok: false,
      error: `network error reaching ${url}: ${(e as Error).message}`,
    };
  }
  if (res.status === 403) {
    return {
      ok: false,
      error:
        "GitHub API rate-limited (60/h unauth). Set GITHUB_TOKEN in env to lift the cap.",
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
  const wantedBinaryName = `phantombot-${tag}-${opts.target}`;
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
 * release workflow doesn't build (e.g. darwin-x64, linux-ia32, win32-*),
 * so `phantombot update` can refuse with a clear message instead of
 * 404-ing on a missing asset.
 *
 * Built targets: linux-x64, linux-arm64, darwin-arm64.
 */
export function detectSupportedTarget(
  procPlatform: string = process.platform,
  procArch: string = process.arch,
): SupportedTarget | undefined {
  const arch = detectSupportedArch(procArch);
  if (!arch) return undefined;
  if (procPlatform === "linux") return `linux-${arch}` as SupportedTarget;
  if (procPlatform === "darwin" && arch === "arm64") return "darwin-arm64";
  return undefined;
}

interface GithubReleaseResponse {
  tag_name?: string;
  body?: string;
  assets?: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}
