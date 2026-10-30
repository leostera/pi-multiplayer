import { defineConfig } from "@leostera/feynman/config";

// Two people in joining, two Pis in shared-session. The bridge's duplicate-record paths are
// 16 and 17 events long, so the default depth of 14 would not reach them; 18 does, and shared-session still finishes.
export default defineConfig({ specs: ["specs/*.ts"], check: { depth: 18, maxStates: 3_000_000, timeLimit: 300_000, instances: { Person: 2, Pi: 2 } } });
