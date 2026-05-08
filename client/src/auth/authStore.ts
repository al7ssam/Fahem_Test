export type AuthUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  roles: string[];
};

export type AuthStatus = "idle" | "loading" | "authenticated" | "unauthenticated" | "error";

export type AuthState = {
  status: AuthStatus;
  user: AuthUser | null;
  lastError: string | null;
  operationId: number;
  updatedAt: number;
};

type Listener = (state: AuthState) => void;

let state: AuthState = {
  status: "idle",
  user: null,
  lastError: null,
  operationId: 0,
  updatedAt: Date.now(),
};

const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) fn(state);
}

export function getAuthState(): AuthState {
  return state;
}

export function setAuthState(next: Partial<AuthState>): void {
  state = {
    ...state,
    ...next,
    updatedAt: Date.now(),
  };
  notify();
}

export function beginAuthOperation(): number {
  const operationId = state.operationId + 1;
  setAuthState({ operationId, status: "loading", lastError: null });
  return operationId;
}

export function commitAuthOperation(operationId: number, next: Partial<AuthState>): void {
  if (state.operationId !== operationId) return;
  setAuthState(next);
}

export function subscribeAuthState(listener: Listener): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}
