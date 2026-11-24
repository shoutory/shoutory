// React Aria's toast is exported only as `UNSTABLE_*` in react-aria-components 1.22.1. The exact pin guards it;
// any upgrade of the package re-checks these imports and the toast tests (docs/dependencies.md).
import {
  UNSTABLE_ToastRegion as AriaToastRegion,
  Button,
  Text,
  UNSTABLE_Toast as Toast,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_ToastQueue as ToastQueue,
} from "react-aria-components";

export interface ToastMessage {
  kind: "success" | "info" | "error";
  title: string;
  description?: string;
}

const SECONDS = 1000;
const LIFETIME = 6 * SECONDS;
const queue = new ToastQueue<ToastMessage>({ maxVisibleToasts: 3 });

export const toasts = {
  show: (message: ToastMessage): string =>
    queue.add(message, message.kind === "error" ? {} : { timeout: LIFETIME }),
  close: (key: string): void => queue.close(key),
};

const TONES: Record<ToastMessage["kind"], string> = {
  success: "border-success",
  info: "border-info",
  error: "border-danger",
};

export function ToastRegion() {
  return (
    <AriaToastRegion
      queue={queue}
      className="fixed inset-be-5 inset-ie-5 z-50 flex flex-col gap-3 outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
    >
      {({ toast }) => (
        <Toast
          toast={toast}
          className={`flex items-start gap-3 rounded-md border-s-4 bg-surface px-5 py-4 text-text shadow-lg ${TONES[toast.content.kind]}`}
        >
          {/* A success is announced politely (status), an error assertively (alert, the library's default). */}
          <ToastContent
            role={toast.content.kind === "error" ? "alert" : "status"}
            className="flex flex-col gap-1"
          >
            <Text slot="title" className="text-md font-medium">
              {toast.content.title}
            </Text>
            {toast.content.description ? (
              <Text slot="description" className="text-sm text-text-muted">
                {toast.content.description}
              </Text>
            ) : null}
          </ToastContent>
          <Button
            slot="close"
            className="min-h-6 min-w-6 pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded-md outline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
          >
            ×
          </Button>
        </Toast>
      )}
    </AriaToastRegion>
  );
}
