import { authRequest, el, button } from "./client";
export async function showAdmin(
  root: HTMLElement,
  recoveryCodes?: string[],
): Promise<void> {
  await new Promise<void>((resolve) => {
    const panel = el("main", undefined, "face-admin");
    const heading = el("h1", "Admin Panel");
    const intro = el(
      "p",
      "Only you can approve face enrollment. Confirm the requester’s identity before approving; names are self-reported.",
    );
    const status = el("p");
    status.setAttribute("role", "status");
    const list = el("div", undefined, "face-user-list");
    const logout = button("Lock Admin Panel", () => {
      logout.disabled = true;
      void authRequest("logout")
        .then(() => {
          sessionStorage.removeItem("scramjet-access-session");
          resolve();
        })
        .catch((error) => {
          status.textContent = error.message;
          logout.disabled = false;
        });
    });
    panel.append(heading, intro, logout, status, list);
    root.replaceChildren(panel);
    if (recoveryCodes?.length) {
      const savedCodes = recoveryCodes;
      const recovery = el("section", undefined, "face-recovery");
      recovery.append(
        el("h2", "Save your recovery codes"),
        el(
          "p",
          "These codes are shown once. Each code can replace your admin face enrollment together with your admin password. Keep them offline.",
        ),
      );
      const codes = el("textarea");
      codes.readOnly = true;
      codes.value = recoveryCodes.join("\n");
      codes.rows = 8;
      codes.setAttribute("aria-label", "Recovery codes");
      const download = button("Download recovery codes", () => {
        const url = URL.createObjectURL(
          new Blob([savedCodes.join("\n") + "\n"], { type: "text/plain" }),
        );
        const link = el("a");
        link.href = url;
        link.download = "scramjet-admin-recovery.txt";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
      recovery.append(
        codes,
        download,
        button("I have saved these codes", () => {
          codes.value = "";
          recoveryCodes = [];
          recovery.remove();
        }),
      );
      panel.insertBefore(recovery, list);
    }
    const refresh = async () => {
      try {
        const { users } = await fetch("/api/admin", {
          cache: "no-store",
          credentials: "same-origin",
        }).then(async (response) => {
          const body = await response.json();
          if (!response.ok) throw new Error(body.error);
          return body;
        });
        list.replaceChildren();
        if (!users.length) list.append(el("p", "No enrollment requests yet."));
        for (const user of users) {
          const row = el("section", undefined, "face-user");
          row.append(
            el("h2", user.name),
            el(
              "p",
              `${user.status} · Requested ${new Date(user.created).toLocaleString()} · ${user.id}`,
            ),
          );
          if (user.status === "pending" && user.preview) {
            const photo = el("img");
            photo.src = user.preview;
            photo.alt = "Enrollment photo submitted for administrator identity review";
            photo.width = 160;
            photo.height = 120;
            photo.style.objectFit = "contain";
            photo.style.borderRadius = "8px";
            photo.style.display = "block";
            photo.style.margin = "12px 0";
            row.append(photo);
          }
          const controls = el("div", undefined, "face-actions");
          const act = (action: string) => async () => {
            if (
              ["revoke", "delete"].includes(action) &&
              !window.confirm(
                `${action === "delete" ? "Permanently delete" : "Revoke access for"} ${user.name}?`,
              )
            )
              return;
            controls
              .querySelectorAll("button")
              .forEach((b) => (b.disabled = true));
            status.textContent = "Updating…";
            try {
              await authRequest(action, { id: user.id }, true);
              status.textContent = "Saved.";
              await refresh();
            } catch (error) {
              status.textContent = (error as Error).message;
              controls
                .querySelectorAll("button")
                .forEach((b) => (b.disabled = false));
            }
          };
          if (user.status === "pending")
            controls.append(
              button("Approve", () => void act("approve")()),
              button("Reject", () => void act("reject")()),
            );
          if (user.status === "approved")
            controls.append(
              button("Revoke access", () => void act("revoke")()),
            );
          controls.append(
            button("Delete enrollment", () => void act("delete")()),
          );
          row.append(controls);
          list.append(row);
        }
      } catch (error) {
        status.textContent = (error as Error).message;
      }
    };
    panel.insertBefore(
      button("Refresh requests", () => void refresh()),
      status,
    );
    void refresh();
  });
}
