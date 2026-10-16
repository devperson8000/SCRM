import type { Socket } from "node:net";
export function watchAuthorizedSocket(
  socket: Socket,
  check: () => Promise<boolean>,
  interval = 30_000,
) {
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if (!(await check())) socket.destroy();
    } catch {
      socket.destroy();
    } finally {
      checking = false;
    }
  }, interval);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
  return () => clearInterval(timer);
}

export function startAuthMaintenance(service: {
  cleanup: () => Promise<void>;
}) {
  const timer = setInterval(() => {
    void service.cleanup().catch(() => undefined);
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
