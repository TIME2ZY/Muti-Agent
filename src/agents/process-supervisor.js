const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { createRunLifecycle } = require("./event-protocol");

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KILL_GRACE_MS = 5000;
const STDERR_BUFFER_LIMIT = 8192;

/**
 * Supervise a provider CLI child process: timeout, signals, retries, NDJSON
 * line parsing, and terminal finish events.
 *
 * Invocation lifecycle is owned here and shared across retries. Callers must
 * recreate decoder/runtime state per attempt while reusing the same lifecycle:
 *
 *   const lifecycle = createRunLifecycle(); // or omit — supervisor creates one
 *   createRuntime: (lifecycle) => createProviderRuntime(config, { lifecycle })
 */
function superviseProviderProcess({
  command,
  args,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  retries = 0,
  createRuntime,
  eventContext,
  onEvent,
  onRawEvent,
  onSessionId,
  spawnFn = spawn,
  stderrLimit = STDERR_BUFFER_LIMIT,
  lifecycle: externalLifecycle,
} = {}) {
  if (typeof createRuntime !== "function") {
    throw new Error("createRuntime is required.");
  }
  if (typeof onEvent !== "function") {
    throw new Error("onEvent is required.");
  }

  // One lifecycle per invocation — survives retries.
  const lifecycle = externalLifecycle || createRunLifecycle();
  let firstChild;
  let attempt = 0;

  const startAttempt = () => {
    attempt += 1;
    // Decoder/runtime state is per-attempt; lifecycle is shared.
    const providerRuntime = createRuntime(lifecycle);

    const child = spawnFn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (!firstChild) firstChild = child;

    let failedToStart = false;
    let timedOut = false;
    let closed = false;
    let lastActivity = Date.now();
    let stderrTail = "";
    let killTimer;

    const markActivity = () => {
      lastActivity = Date.now();
    };

    const appendStderr = (chunk) => {
      stderrTail += chunk.toString();
      if (stderrTail.length > stderrLimit) {
        stderrTail = stderrTail.slice(-stderrLimit);
      }
    };

    const cleanupHandlers = [];
    const clearTimers = () => {
      clearInterval(activityTimer);
      clearTimeout(killTimer);
    };

    const terminate = (signal, reason) => {
      if (closed) return;
      if (reason) console.error(reason);

      killTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, killGraceMs);

      child.kill(signal);
    };

    const activityTimer = setInterval(
      () => {
        if (Date.now() - lastActivity <= timeoutMs) return;

        timedOut = true;
        process.exitCode = 1;
        terminate(
          "SIGTERM",
          `${command} timed out after ${timeoutMs}ms of no stdout/stderr activity.`
        );
      },
      Math.max(10, Math.min(1000, Math.floor(timeoutMs / 2)))
    );

    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        process.exitCode = 1;
        terminate(signal, `${command} received ${signal}; forwarding to child process.`);
      };
      process.once(signal, handler);
      cleanupHandlers.push(() => process.removeListener(signal, handler));
    }

    child.stdout.on("data", markActivity);

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      if (!line.trim()) return;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        console.error("Failed to parse JSON line:", line);
        if (onRawEvent) onRawEvent({ parseError: true, line });
        return;
      }

      if (onRawEvent) onRawEvent(event);

      const sessionId = providerRuntime.extractSessionId(event);
      if (sessionId && onSessionId) onSessionId(sessionId);

      const events = providerRuntime.transform(event, eventContext);
      for (const outEvent of events) onEvent(outEvent);
    });

    child.stderr.on("data", (chunk) => {
      markActivity();
      appendStderr(chunk);
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      failedToStart = true;
      console.error(`Failed to start ${command}:`, error.message);
      process.exitCode = 1;
    });

    child.on("close", (code, signal) => {
      closed = true;
      clearTimers();
      cleanupHandlers.forEach((cleanup) => cleanup());
      rl.close();

      const finishProvider = (outcome) => {
        for (const outEvent of providerRuntime.finish(eventContext, outcome)) {
          onEvent(outEvent);
        }
      };

      if (failedToStart) {
        finishProvider({
          terminal: true,
          ok: false,
          exitCode: code,
          signal,
          error: `Failed to start ${command}.`,
        });
        return;
      }

      if (signal) {
        finishProvider({
          terminal: true,
          ok: false,
          exitCode: code,
          signal,
          error: `${command} was killed by signal ${signal}.`,
        });
        console.error(`\n${command} process was killed by signal ${signal}`);
        process.exitCode = 1;
        return;
      }

      if (code !== 0) {
        // Retry only while the invocation lifecycle is still open. If the
        // decoder already emitted run.failed/finished, do not start a second life.
        const canRetry = !timedOut && attempt <= retries && !lifecycle.terminal;
        if (canRetry) {
          finishProvider({ terminal: false });
          if (!lifecycle.terminal) {
            console.error(
              `${command} ${args.join(" ")} exited with code ${code}; retrying ${attempt}/${retries}.`
            );
            startAttempt();
            return;
          }
        }

        console.error(`\n${command} ${args.join(" ")} exited with code ${code}`);
        if (stderrTail.trim()) {
          console.error(`Recent stderr:\n${stderrTail.trim()}`);
        }
        finishProvider({
          terminal: true,
          ok: false,
          exitCode: code,
          signal: null,
          error: stderrTail.trim() || `${command} exited with code ${code}.`,
        });
        process.exitCode = code;
        return;
      }

      if (timedOut) {
        finishProvider({
          terminal: true,
          ok: false,
          exitCode: code,
          signal: null,
          error: `${command} timed out.`,
        });
        return;
      }

      finishProvider({ terminal: true, ok: true, exitCode: 0, signal: null });
    });

    return child;
  };

  startAttempt();
  return firstChild;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  STDERR_BUFFER_LIMIT,
  superviseProviderProcess,
};
