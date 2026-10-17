import { captureFace } from "./camera";
import { showAdmin } from "./admin";
import { authRequest, el, button } from "./client";
import "./auth.css";

const ACCESS_SESSION_KEY = "scramjet-access-session";
export async function showLogin(root: HTMLElement): Promise<void> {
  while (true) {
    if (sessionStorage.getItem(ACCESS_SESSION_KEY) === "granted") {
      const response = await fetch("/api/access", {
        cache: "no-store",
        credentials: "same-origin",
      }).catch(() => null);
      const session = await response?.json().catch(() => null);
      if (session?.unlocked) {
        root.replaceChildren();
        return;
      }
      if (session?.role === "admin") {
        await showAdmin(root);
        continue;
      }
      sessionStorage.removeItem(ACCESS_SESSION_KEY);
    }
    const result = await loginForm(root);
    sessionStorage.setItem(ACCESS_SESSION_KEY, "granted");
    if (result.role === "admin") {
      await showAdmin(root, result.recoveryCodes);
      continue;
    }
    root.replaceChildren();
    return;
  }
}

function loginForm(
  root: HTMLElement,
): Promise<{ role: string; recoveryCodes?: string[] }> {
  return new Promise((resolve) => {
    const gate = el("main", undefined, "face-gate access-gate");
    const card = el("section", undefined, "face-card access-card");
    const brand = el("div", undefined, "access-brand");
    const mark = el("span", undefined, "access-brand-mark");
    mark.setAttribute("aria-hidden", "true");
    brand.append(mark, document.createTextNode("Secure workspace"));
    const title = el("h1", "Private access");
    const description = el(
      "p",
      "Enter your workspace password, then verify your approved face.",
    );
    const content = el("div");
    const message = el("p", undefined, "face-status");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    const note = el(
      "p",
      "Face scans are checked by this app. Webcam checks are not hardware-backed Face ID and cannot guarantee protection against photo/video spoofing.",
      "face-note",
    );
    card.append(brand, title, description, content, message, note);
    gate.append(card);
    root.replaceChildren(gate);
    let controller: AbortController | undefined;
    const cancelCapture = () => {
      controller?.abort();
      controller = undefined;
    };
    const error = (e: unknown) => {
      message.textContent =
        (e as Error).name === "AbortError"
          ? "Scan cancelled."
          : (e as Error).message;
    };
    const passwordStep = () => {
      cancelCapture();
      title.textContent = "Private access";
      description.textContent =
        "Enter your workspace password, then verify your approved face.";
      const form = el("form", undefined, "access-form");
      const label = el("label", "Workspace passcode");
      label.htmlFor = "access-password";
      const password = el("input");
      password.id = "access-password";
      password.className = "access-input";
      password.placeholder = "Enter passcode";
      password.type = "password";
      password.autocomplete = "current-password";
      password.required = true;
      password.maxLength = 512;
      const submit = el("button", "Unlock workspace", "face-button access-submit");
      submit.type = "submit";
      form.append(label, password, submit);
      content.replaceChildren(form);
      form.onsubmit = async (event) => {
        event.preventDefault();
        submit.disabled = true;
        message.textContent = "Checking access…";
        try {
          const result = await authRequest("password", {
            password: password.value,
          });
          password.value = "";
          message.textContent = "";
          faceStep(result.role, result.setupRequired);
        } catch (e) {
          error(e);
          submit.disabled = false;
          password.select();
        }
      };
      const receipt = sessionStorage.getItem("scramjet-enrollment-receipt");
      if (receipt)
        content.append(
          button("Check enrollment status", () => {
            void authRequest("status", { receipt })
              .then((r) => {
                message.textContent = `Enrollment for ${r.name}: ${r.status}. Approved users can enter their password and scan again.`;
              })
              .catch(error);
          }),
        );
      password.focus();
    };
    const faceStep = (role: string, setupRequired = false) => {
      cancelCapture();
      content.replaceChildren();
      message.textContent = "";
      title.textContent =
        role === "admin" ? "Admin verification" : "Verify your face";
      description.textContent = setupRequired
        ? "Enter your one-time setup secret to enroll the administrator face."
        : role === "admin"
          ? "Scan your administrator face to open the Admin Panel."
          : "Scan your approved face, or request enrollment if this is your first visit.";
      const start = async (
        purpose: string,
        extra: Record<string, unknown> = {},
      ) => {
        const aborter = new AbortController();
        controller = aborter;
        content.replaceChildren();
        const captureHost = el("div");
        const cancel = button("Cancel scan", () => {
          aborter.abort();
          faceStep(role, setupRequired);
        });
        content.append(captureHost, cancel);
        message.textContent = "";
        try {
          const challenge = await authRequest(
            "challenge",
            { purpose, ...extra },
            false,
            aborter.signal,
          );
          const images = await captureFace(
            captureHost,
            challenge.instruction,
            aborter.signal,
            purpose === "login",
          );
          message.textContent = "Verifying scan…";
          const result = await authRequest(
            purpose,
            { challengeId: challenge.challengeId, images, ...extra },
            false,
            aborter.signal,
          );
          if (aborter.signal.aborted) return;
          controller = undefined;
          if (result.status === "pending") {
            sessionStorage.setItem(
              "scramjet-enrollment-receipt",
              result.receipt,
            );
            title.textContent = "Awaiting approval";
            description.textContent =
              "Your face enrollment was submitted. Scramjet stays locked until the administrator approves it.";
            content.replaceChildren(
              button("Check approval", () => {
                void authRequest("status", { receipt: result.receipt })
                  .then((r) => {
                    message.textContent = `Enrollment status: ${r.status}`;
                    if (r.status === "approved")
                      content.replaceChildren(
                        button("Return to login", passwordStep),
                      );
                  })
                  .catch(error);
              }),
              button("Return to login", passwordStep),
            );
            message.textContent = "";
          } else if (result.role === "admin" || result.unlocked) {
            cancelCapture();
            resolve(result);
          } else throw new Error("No access was granted.");
        } catch (e) {
          if (aborter.signal.aborted) return;
          faceStep(role, setupRequired);
          error(e);
        }
      };
      const enrollment = (purpose: string) => {
        title.textContent =
          purpose === "enroll"
            ? "Enrol your face"
            : purpose === "setup"
              ? "Set up Admin Panel"
              : "Recover admin access";
        description.textContent =
          purpose === "enroll"
            ? "Your request must be approved in the Admin Panel before you can log in."
            : "Only use this on a private device. You will receive replacement recovery codes after enrollment.";
        const form = el("form");
        const field = el("input");
        field.required = true;
        const fieldLabel = el("label");
        fieldLabel.htmlFor = "face-enroll-field";
        field.id = "face-enroll-field";
        if (purpose === "enroll") {
          fieldLabel.textContent = "Your name";
          field.maxLength = 80;
          field.autocomplete = "name";
        } else {
          fieldLabel.textContent =
            purpose === "setup"
              ? "One-time setup secret"
              : "Unused recovery code";
          field.type = "password";
          field.maxLength = 256;
          field.autocomplete = "off";
        }
        const consentLabel = el("label", undefined, "face-consent");
        const consent = el("input");
        consent.type = "checkbox";
        consent.required = true;
        consentLabel.append(
          consent,
          document.createTextNode(
            purpose === "enroll"
              ? "I consent to encrypted storage of my face template and one review photo, shown only to the administrator while approval is pending. The review photo is deleted when approved, rejected or expired; other camera images are not stored."
              : "I consent to encrypted storage of my face template for login. Camera images are not stored.",
          ),
        );
        const submit = el("button", "Start face enrollment", "face-button");
        submit.type = "submit";
        form.append(fieldLabel, field, consentLabel, submit);
        form.onsubmit = (event) => {
          event.preventDefault();
          if (!consent.checked) return;
          const value = field.value;
          field.value = "";
          void start(
            purpose,
            purpose === "enroll"
              ? { name: value, consent: true }
              : purpose === "setup"
                ? { setupToken: value, consent: true }
                : { recoveryCode: value, consent: true },
          );
        };
        content.replaceChildren(
          form,
          button("Back", () => faceStep(role, setupRequired)),
        );
        field.focus();
      };
      if (setupRequired)
        content.append(
          button("Enroll administrator face", () => enrollment("setup")),
        );
      else content.append(button("Scan my face", () => void start("login")));
      if (role === "user")
        content.append(button("Enrol your face", () => enrollment("enroll")));
      else if (!setupRequired)
        content.append(
          button("Use a recovery code", () => enrollment("recover")),
        );
      content.append(button("Use a different password", passwordStep));
    };
    passwordStep();
  });
}
