// The program's entry point: runs the command line and sets the exit status.
import { main } from "./cli";

// A reader that stops early (for example `| head`) ends the program quietly.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

process.exitCode = main(process.argv.slice(2));
