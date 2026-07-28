export { LineSplitter } from './lineSplitter.ts';
export { BoundedQueue } from './queue.ts';
export { ExponentialBackoff, systemTime } from './time.ts';
export type { TimeSource } from './time.ts';
export { SerialIngest } from './ingest.ts';
export type {
  DisconnectReason,
  IngestStats,
  IngestStream,
  PortOpener,
  SerialIngestOptions,
  StateChange,
} from './ingest.ts';
export {
  DEFAULT_BAUD,
  DEFAULT_DEVICE,
  buildSttyArgs,
  sttyPortOpener,
} from './sttyPort.ts';
