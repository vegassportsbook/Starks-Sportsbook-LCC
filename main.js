import { mountUI } from "./ui.js";
import { runBootSequence } from "./boot.js";
import { setState } from "./state.js";

async function start() {
  mountUI();

  try {
    const boot = await runBootSequence();
    setState({
      boot: { ok: true, bootMs: boot.bootMs }
    });
  } catch (err) {
    console.error("BOOT FAILED:", err);
  }
}

start();
