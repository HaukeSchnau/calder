// Checkpoints the controller's database from a thread of its own (Db.ts). A checkpoint syncs
// the database file, which on srv-2's busy disk took up to a second; on the controller's connection it
// stopped the event loop for that long. A passive checkpoint waits for no reader or writer. The next commit
// after one restarts the WAL and syncs its header on the controller's thread, so checkpoints stay about as
// rare as SQLite's own every 1,000 frames were: srv-2's controller writes those in two to three minutes.
import { Database } from "bun:sqlite"

declare const self: Worker

self.onmessage = ({ data: filename }: MessageEvent<string>) => {
  const db = new Database(filename)
  setInterval(() => db.run("pragma wal_checkpoint(passive)"), 60_000)
}
