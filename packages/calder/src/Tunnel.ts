import type { Socket } from "bun"

/** One side of a forwarded connection: its peer, and what the peer couldn't take yet. */
export interface End {
  peer: Socket<End> | null
  pending: Array<Uint8Array>
  /** Bytes that arrived before the peer was connected. */
  early: Array<Uint8Array>
  closed: boolean
}

export const end = (): End => ({ peer: null, pending: [], early: [], closed: false })

/** Writes to `to`, keeping what it can't take for its `drain`. */
export const send = (to: Socket<End>, chunk: Uint8Array) => {
  if (to.data.pending.length > 0) {
    to.data.pending.push(chunk)
    return
  }
  const written = to.write(chunk)
  if (written < chunk.length) to.data.pending.push(chunk.subarray(Math.max(0, written)))
}

/** Socket handlers that forward between two ends set up with `link`. */
export const handlers = {
  data(socket: Socket<End>, chunk: Uint8Array) {
    const peer = socket.data.peer
    if (peer === null) socket.data.early.push(chunk)
    else send(peer, chunk)
  },
  drain(socket: Socket<End>) {
    const pending = socket.data.pending
    socket.data.pending = []
    for (const chunk of pending) send(socket, chunk)
    if (socket.data.pending.length === 0 && socket.data.closed) socket.end()
  },
  close(socket: Socket<End>) {
    const peer = socket.data.peer
    if (peer === null || peer.data.closed) return
    peer.data.closed = true
    if (peer.data.pending.length === 0) peer.end()
  },
  error(socket: Socket<End>) {
    socket.end()
  },
}

/** Connects two ends and flushes what each received before the other existed. */
export const link = (a: Socket<End>, b: Socket<End>) => {
  a.data.peer = b
  b.data.peer = a
  for (const chunk of a.data.early.splice(0)) send(b, chunk)
  for (const chunk of b.data.early.splice(0)) send(a, chunk)
}
