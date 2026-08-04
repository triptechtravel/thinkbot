// @phosphor-icons/react@2.1.10 publishes a broken `types` entry
// (package.json points at dist/index.d.ts, which is absent from the tarball).
// Runtime is fine; this shim keeps typecheck clean until upstream fixes it.
declare module "@phosphor-icons/react";
