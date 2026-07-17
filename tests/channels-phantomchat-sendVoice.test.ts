/*
 * transport.sendVoice end-to-end: it must AES-256-GCM encrypt the audio, upload
 * the ciphertext to Blossom (NIP-24242-authed PUT, multi-mirror ≥2), and gift-
 * wrap a `type:"voice"` DM envelope whose `content` is the JSON file-metadata
 * blob the PWA's extractFileMetadata reads — including a `servers` mirror list.
 */
import { describe, expect, test } from "bun:test";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  SimplePoolPhantomchatTransport,
  type RelayPool,
} from "../src/channels/phantomchat/transport.ts";
import { unwrapV2, type NTNostrEvent } from "../src/lib/nostrCrypto.ts";
import { fetchAndDecryptBlossom } from "../src/channels/phantomchat/blossomFetch.ts";

describe("phantomchat transport — sendVoice", () => {
  test("encrypts, multi-mirror uploads to Blossom, and wraps a voice envelope with servers", async () => {
    const published: NTNostrEvent[] = [];
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish(_relays, event) {
        published.push(event);
        return [Promise.resolve("ok")];
      },
      close() {},
    };

    // Capture the Blossom uploads: assert the auth event and stash the bytes so
    // we can prove the round-trip via the metadata key/iv the envelope carries.
    let uploadedBody: Buffer | undefined;
    let authEvent: { kind?: number; tags?: string[][] } | undefined;
    const uploadHosts: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      // disaster-net /blossom.json probe must not break the upload mock
      if (u.includes("blossom.json") || u.endsWith("/relays.json")) {
        return new Response("nope", { status: 404 });
      }
      expect(u).toMatch(/\/upload$/);
      expect(init?.method).toBe("PUT");
      const auth = (init?.headers as Record<string, string>).Authorization ?? "";
      expect(auth.startsWith("Nostr ")).toBe(true);
      authEvent = JSON.parse(
        Buffer.from(auth.slice("Nostr ".length), "base64").toString("utf8"),
      );
      uploadedBody = Buffer.from(init?.body as Uint8Array);
      // Echo a distinct host-specific url so multi-mirror produces ≥2 URLs.
      const host = u.replace(/\/upload$/, "");
      uploadHosts.push(host);
      return new Response(
        JSON.stringify({ url: `${host}/abc`, sha256: "abc" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    try {
      const botSk = generateSecretKey();
      const transport = new SimplePoolPhantomchatTransport(
        botSk,
        ["wss://relay.example"],
        fakePool,
      );
      const recipientSk = generateSecretKey();
      const recipientHex = getPublicKey(recipientSk);

      const audio = Buffer.from("fake opus voice reply bytes 🎧");
      await transport.sendVoice(recipientHex, audio, "audio/ogg");

      // Blossom auth was a kind-24242 upload event.
      expect(authEvent?.kind).toBe(24242);
      expect(authEvent?.tags?.some((t) => t[0] === "t" && t[1] === "upload")).toBe(true);

      // Multi-mirror: ≥2 successful PUTs (default BLOSSOM_MIRROR_MIN).
      expect(uploadHosts.length).toBeGreaterThanOrEqual(2);

      // A single v2 wrap published (DM voice, no self-wrap — same as text).
      expect(published.length).toBe(1);
      expect(published[0]!.kind).toBe(1059);

      // Recipient unwraps → the envelope, type "voice".
      const unwrapped = await unwrapV2(published[0] as NTNostrEvent, recipientSk);
      const envelope = JSON.parse(unwrapped.content) as {
        type: string;
        from: string;
        to: string;
        content: string;
      };
      expect(envelope.type).toBe("voice");
      expect(envelope.from).toBe(getPublicKey(botSk));
      expect(envelope.to).toBe(recipientHex);

      // The envelope content is the file-metadata JSON the PWA reads.
      const meta = JSON.parse(envelope.content) as {
        url: string;
        sha256: string;
        key: string;
        iv: string;
        mimeType: string;
        size: number;
        mediaType: string;
        servers?: string[];
      };
      expect(meta.url).toBe(`${uploadHosts[0]}/abc`);
      expect(meta.mediaType).toBe("voice");
      expect(meta.mimeType).toBe("audio/ogg");
      expect(meta.size).toBe(audio.length);
      expect(meta.key.length).toBe(64);
      expect(meta.iv.length).toBe(24);
      // Multi-mirror list on the wire.
      expect(Array.isArray(meta.servers)).toBe(true);
      expect(meta.servers!.length).toBeGreaterThanOrEqual(2);
      expect(meta.servers![0]).toBe(meta.url);

      // Full round-trip: the uploaded ciphertext + the envelope's key/iv must
      // decrypt back to the original audio (this is exactly what the recipient
      // does via fetchAndDecryptBlossom).
      globalThis.fetch = (async () =>
        new Response(uploadedBody!, { status: 200 })) as unknown as typeof fetch;
      const recovered = await fetchAndDecryptBlossom(
        meta.url,
        meta.key,
        meta.iv,
        { expectedSha256Hex: meta.sha256, knownServers: [] },
      );
      expect(new Uint8Array(recovered)).toEqual(new Uint8Array(audio));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("throws when every Blossom server rejects the upload", async () => {
    const fakePool: RelayPool = {
      subscribeMany() {
        return { close() {} };
      },
      publish() {
        return [Promise.resolve("ok")];
      },
      close() {},
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    try {
      const transport = new SimplePoolPhantomchatTransport(
        generateSecretKey(),
        ["wss://relay.example"],
        fakePool,
      );
      await expect(
        transport.sendVoice(getPublicKey(generateSecretKey()), Buffer.from("x"), "audio/ogg"),
      ).rejects.toThrow(/all blossom servers failed/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
