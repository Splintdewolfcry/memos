/**
 * Shared live-update (SSE) connection status store. Kept standalone, away from
 * useLiveMemoRefresh, because AuthContext subscribes to it — to clear a boot-time
 * offline restore once the server is provably reachable again — and the hook
 * module itself imports AuthContext, so the store beside it would close a
 * module cycle.
 */
export type SSEConnectionStatus = "connected" | "disconnected" | "connecting";

type Listener = () => void;

let _status: SSEConnectionStatus = "disconnected";
const _listeners = new Set<Listener>();

export function getSSEStatus(): SSEConnectionStatus {
  return _status;
}

export function setSSEStatus(s: SSEConnectionStatus) {
  if (_status !== s) {
    _status = s;
    _listeners.forEach((l) => l());
  }
}

export function subscribeSSEStatus(listener: Listener): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}
