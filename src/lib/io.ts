/**
 * Shared minimal IO interfaces for CLI commands.
 *
 * Subcommands take WriteSink instead of NodeJS.WriteStream so tests can
 * pass capture buffers without faking the full WriteStream API.
 */

export interface WriteSink {
  write(chunk: string | Uint8Array): boolean | void;
}
