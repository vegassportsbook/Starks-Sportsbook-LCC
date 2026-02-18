export const state = {
  boot: { ok: false, bootMs: null }
};

export function setState(patch) {
  Object.assign(state, patch);
}
