/**
 * Matrix channel — PUBLIC-API BARREL.
 *
 * The Matrix mirror of channels/telegram.ts: re-exports the adapter trio +
 * server + setup helpers under stable names so callers (cli/run.ts,
 * cli/chat-matrix, routing) import from one place. Submodules:
 *
 *   - matrix/types.ts       — MatrixChannelMessage + MatrixClientLike seam
 *   - matrix/parse.ts       — pure timeline-event → MatrixChannelMessage
 *   - matrix/transport.ts   — MatrixTransport + ClientMatrixTransport +
 *                             createRealMatrixClient (matrix-bot-sdk + Rust crypto)
 *   - matrix/channel.ts     — the Matrix Channel adapter (real-Megolm seam +
 *                             listen() over /sync)
 *   - matrix/server.ts      — runMatrixServer (the listener loop)
 *   - matrix/login.ts       — password → token+deviceId, password discarded
 *   - matrix/nativeCrypto.ts — single-binary native-addon load seam
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
  realMatrixRegister,
  type MatrixLoginFn,
  type MatrixLoginResult,
} from "./matrix/login.ts";
export {
  loadNativeCrypto,
  nativeCryptoFilename,
  nativeCryptoVariant,
} from "./matrix/nativeCrypto.ts";
export type {
  MatrixChannelMessage,
  MatrixClientLike,
  MatrixTimelineEvent,
} from "./matrix/types.ts";
