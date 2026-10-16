type ExitKeyEvent = Pick<
  KeyboardEvent,
  | "key"
  | "code"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "metaKey"
  | "altKey"
  | "preventDefault"
>;

export function createQuickExitHandler(
  exit: () => void,
  now = () => performance.now(),
) {
  let lastPress: number | null = null;
  return (event: ExitKeyEvent) => {
    if (event.repeat || event.isComposing) return;
    const isExitKey =
      event.code === "Backquote" || event.key === "`" || event.key === "~";
    if (!isExitKey || event.ctrlKey || event.metaKey || event.altKey) {
      lastPress = null;
      return;
    }
    const time = now();
    if (lastPress !== null && time - lastPress <= 600) {
      lastPress = null;
      event.preventDefault();
      exit();
    } else {
      lastPress = time;
    }
  };
}

const attachedDocuments = new WeakSet<Document>();
const onExitKey = createQuickExitHandler(() =>
  window.location.replace("https://www.google.com/"),
);

export function attachQuickExit(target: Window) {
  const document = target.document;
  if (attachedDocuments.has(document)) return;
  attachedDocuments.add(document);
  target.addEventListener("keydown", onExitKey, { capture: true });
}
