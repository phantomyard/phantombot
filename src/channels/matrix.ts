/**
 * Matrix channel — PUBLIC-API BARREL.
 *
 * The Matrix mirror of channels/telegram.ts: re-exports the adapter trio +
 * server + setup helpers under stable names so callers (cli/run.ts,
 * cli/chat-matrix, routing) import from one place. Submodules:
 *
 *   - matrix/types.ts      — MatrixChannelMessage + MatrixClientLike seam
 *   - matrix/parse.ts      — pure timeline-event → MatrixChannelMessage
 *   - matrix/transport.ts  — MatrixTransport + ClientMatrixTransport +
 *                            createRealMatrixClient (the SDK + crypto wiring)
 *   - matrix/channel.ts    — the Matrix Channel adapter (real-Megolm seam +
 *                            listen() over /sync)
 *   - matrix/server.ts     — runMatrixServer (the listener loop)
 *   - matrix/login.ts      — password → token+deviceId, password discarded
 *   - matrix/crypto.ts     — invisible-E2EE bootstrap (recovery key auto-gen)
 *   - matrix/cryptoWasm.ts — the single-binary WASM embedding seam
 */

export { parseTimelineEvent, MATRIX_MESSAGE_TYPE } from "./matrix/parse.ts";
export {
  ClientMatrixTransport,
  createRealMatrixClient,
  type MatrixTransport,
  type RealMatrixClientOptions,
} from "./matrix/transport.ts";
export {
  createMatrixChannel,
  MATRIX_CAPABILITIES,
} from "./matrix/channel.ts";
export {
  runMatrixServer,
  type RunMatrixServerInput,
} from "./matrix/server.ts";
export {
  realMatrixLogin,
  type MatrixLoginFn,
  type MatrixLoginResult,
} from "./matrix/login.ts";
export {
  bootstrapInvisibleE2ee,
  type BootstrapResult,
  type MatrixCryptoLike,
} from "./matrix/crypto.ts";
export { ensureCryptoWasm } from "./matrix/cryptoWasm.ts";
export type {
  MatrixChannelMessage,
  MatrixClientLike,
  MatrixTimelineEvent,
} from "./matrix/types.ts";
