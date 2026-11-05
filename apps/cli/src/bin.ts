import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    // Ink can leave stdin referenced after unmounting; never let that keep the process alive.
    setTimeout(() => process.exit(code), 200).unref();
  },
  (err: unknown) => {
    process.stderr.write(`agentduo crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
