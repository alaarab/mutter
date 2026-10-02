// A paused reader may leave one complete protocol message in flight. Allow two
// maximum-sized messages, but never keep accepting writes from a stalled peer.
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024 + 64;

export class BoundedWriter {
  constructor(socket, { pause, resume, overflow, limit = MAX_BUFFERED_BYTES }) {
    this.socket = socket;
    this.pause = pause;
    this.resume = resume;
    this.overflow = overflow;
    this.limit = limit;
    this.blocked = false;
    this.disposed = false;
    this.onDrain = () => {
      if (this.disposed || !this.blocked) return;
      this.blocked = false;
      this.resume();
    };
    socket.on('drain', this.onDrain);
  }

  write(data) {
    if (this.disposed || this.socket.destroyed || this.socket.writableEnded) return false;
    if (this.socket.writableLength + data.byteLength > this.limit) {
      this.dispose();
      this.overflow();
      return false;
    }
    const ready = this.socket.write(data);
    if (!ready && !this.blocked) {
      this.blocked = true;
      this.pause();
    }
    return ready;
  }

  dispose() {
    this.disposed = true;
    this.socket.off('drain', this.onDrain);
  }
}
