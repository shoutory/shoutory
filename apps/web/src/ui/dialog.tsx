import type { ReactNode } from "react";
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from "react-aria-components";

export function Dialog({
  title,
  children,
  isOpen,
  onOpenChange,
}: {
  title: ReactNode;
  children: ReactNode;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-40 flex items-end justify-center bg-text/40 md:items-center"
    >
      <Modal className="w-full rounded-t-lg bg-surface p-6 shadow-lg outline-none md:max-w-lg md:rounded-lg">
        <AriaDialog className="flex flex-col gap-5 outline-none">
          <Heading slot="title" className="font-heading text-xl">
            {title}
          </Heading>
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
