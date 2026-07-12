// Uses the shared base (pins a deterministic install salt so tests hash reproducibly and
// never create the real install-salt file in the dev data dir — see ../../vitest.base.ts).
// Tests that prove salt PERSISTENCE clear the override inside a temp HOME (src/salt.test.ts).
export { default } from "../../vitest.base";
